/**
 * The staging store (knowledge-library.md K17): one lifecycle for proposals and direct applies, lazy expiry, the
 * `revising` sweep, the cap of 50 waiting changes, applied rows that drop their payloads, and the cap on finished rows.
 * In-memory SQLite, a controllable clock, synthetic content.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CHANGE_EXPIRY_MS, CHANGE_ID_RE, CHANGE_MARKER_RE, KEEP_FINISHED_ROWS, MAX_WAITING_CHANGES, REVISING_SWEEP_MS, createKnowledgeChangeStore,
  type KnowledgeChangeStore, type NewChange,
} from './knowledge-changes.js';
import { createStorage, type StorageLayer } from './storage.js';

let storage: StorageLayer;
let clock: number;
let store: KnowledgeChangeStore;

const plan = { mode: 'edit' as const, set: 'shop-data', file: 'orders.md', files: [{ path: 'shop-data/orders.md', before: 'a'.repeat(64), after: '# Orders\n' }], summary: 'edit orders' };
const base = (over: Partial<NewChange> = {}): NewChange => ({
  setName: 'shop-data', kind: 'write', mode: 'edit', file: 'orders.md', plan, baseSha256: 'a'.repeat(64), rulesSha256: 'b'.repeat(64),
  diffText: '+x', why: 'a verified fact', trigger: 'verified_fact', origin: 'botboy_proposal', sources: ['email'], candidateSha256: 'c'.repeat(64), status: 'staged', ...over,
});

beforeEach(() => {
  storage = createStorage(':memory:');
  storage.initialize();
  clock = 1_800_000_000_000;
  store = createKnowledgeChangeStore(storage.getDb(), { now: () => clock });
});
afterEach(() => storage.close());

describe('insert and get', () => {
  it('round-trips a change with its plan, items and sources, under an id of the card-marker shape', () => {
    const item = { tier: 'should_fix' as const, rule: 'r', where: { file: 'orders.md', line: 3 }, problem: 'p', evidence: 'e', fix: 'f', source: 'model' as const };
    const made = store.insert(base({ items: [item], unresolved: [item], notes: [item], check: { coverage: 'checked against: guide' } }));
    expect(made.id).toMatch(/^kc_[a-f0-9]{12}$/);
    expect(CHANGE_ID_RE.test(made.id)).toBe(true);
    const read = store.get(made.id);
    expect(read).toMatchObject({ setName: 'shop-data', kind: 'write', mode: 'edit', file: 'orders.md', status: 'staged', origin: 'botboy_proposal', sources: ['email'], trigger: 'verified_fact', round: 1, attempt: 1, suspicious: false });
    expect(read?.plan?.files[0].after).toBe('# Orders\n');
    expect(read?.items).toEqual([item]);
    expect(read?.check.coverage).toBe('checked against: guide');
    expect(read?.expiresAt).toBe(new Date(clock + CHANGE_EXPIRY_MS).toISOString());
  });

  it('R13: an id must be the whole string; the marker regex only scans text', () => {
    expect(CHANGE_ID_RE.test('kc_aaaaaaaaaaaa')).toBe(true);
    for (const bad of ['xxkc_aaaaaaaaaaaayy', ' kc_aaaaaaaaaaaa', 'kc_aaaaaaaaaaaa\n', 'kc_aaaaaaaaaaaaa', 'kc_aaaaaaaaaaa', 'KC_AAAAAAAAAAAA']) expect(CHANGE_ID_RE.test(bad), JSON.stringify(bad)).toBe(false);
    expect(store.get('xxkc_aaaaaaaaaaaayy')).toBeNull();
    const found = [...'see [[knowledge:kc_aaaaaaaaaaaa]] and [[knowledge:kc_bbbbbbbbbbbb]] but not [[knowledge:xkc_cccccccccccc]]'.matchAll(CHANGE_MARKER_RE)].map((match) => match[1]);
    expect(found).toEqual(['kc_aaaaaaaaaaaa', 'kc_bbbbbbbbbbbb']);
  });

  it('refuses a malformed id without touching the table', () => {
    expect(store.get('kc_nope')).toBeNull();
    expect(store.get("kc_'; DROP TABLE knowledge_changes; --")).toBeNull();
    expect(store.get('')).toBeNull();
    expect(store.list()).toEqual([]);
  });

  it('a direct apply is born applied with no plan or check payload kept', () => {
    const made = store.insert(base({ origin: 'owner_request', status: 'applied', historyId: 'h_abc', check: { coverage: 'checked against: guide', summary: 'big' } }));
    expect(made).toMatchObject({ status: 'applied', historyId: 'h_abc', plan: null });
    expect(made.decidedAt).not.toBeNull();
    expect(made.check).toEqual({ coverage: 'checked against: guide' });
  });
});

describe('update', () => {
  it('moves a change through the coach loop and drops its payloads when it is applied', () => {
    const made = store.insert(base({ status: 'revising', origin: 'owner_request', sources: [] }));
    const staged = store.update(made.id, { status: 'staged', attempt: 3, unresolved: [{ tier: 'must_fix', rule: 'r', where: { file: 'orders.md' }, problem: 'p', evidence: 'e', fix: 'f', source: 'model' }] });
    expect(staged).toMatchObject({ status: 'staged', attempt: 3 });
    expect(staged?.unresolved).toHaveLength(1);
    clock += 1_000;
    const applied = store.update(made.id, { status: 'applied', historyId: 'h_1', overrode: ['must_fix: r'] });
    expect(applied).toMatchObject({ status: 'applied', historyId: 'h_1', overrode: ['must_fix: r'], plan: null, unresolved: [], items: [] });
    expect(applied?.decidedAt).toBe(new Date(clock).toISOString());
  });

  it('returns null for an unknown id and dismissing drops the plan', () => {
    expect(store.update('kc_000000000000', { status: 'dismissed' })).toBeNull();
    const made = store.insert(base());
    expect(store.update(made.id, { status: 'dismissed', statusReason: 'not needed' })).toMatchObject({ status: 'dismissed', plan: null, statusReason: 'not needed' });
  });
});

describe('lifecycle sweeps', () => {
  it('a revising change older than ten minutes is staged on the next read, a younger one is not', () => {
    const old = store.insert(base({ status: 'revising' }));
    clock += REVISING_SWEEP_MS - 1;
    const fresh = store.insert(base({ status: 'revising' }));
    clock += 2;
    expect(store.get(old.id)).toMatchObject({ status: 'staged', statusReason: expect.stringContaining('turn ended') });
    expect(store.get(fresh.id)?.status).toBe('revising');
  });

  it('R3: the sweep keys on the last activity, so an old card that is reopened stays revising for ten quiet minutes and then goes back to staged', () => {
    const made = store.insert(base({ status: 'staged' }));
    clock += 3 * 60 * 60 * 1000;
    store.update(made.id, { status: 'revising', round: 2, attempt: 1 });
    expect(store.get(made.id)?.status).toBe('revising');
    clock += REVISING_SWEEP_MS - 60_000;
    expect(store.get(made.id)?.status).toBe('revising');
    // Every write is activity: a revision at minute 9 restarts the clock.
    store.update(made.id, { attempt: 2 });
    clock += REVISING_SWEEP_MS - 60_000;
    expect(store.get(made.id)?.status).toBe('revising');
    clock += 2 * 60_000;
    expect(store.get(made.id)).toMatchObject({ status: 'staged', statusReason: expect.stringContaining('turn ended') });
  });

  it('R3: a table from before updated_at gains the column and its rows sweep by created_at', () => {
    const db = storage.getDb();
    const old = store.insert(base({ status: 'revising' }));
    db.exec('ALTER TABLE knowledge_changes DROP COLUMN updated_at');
    const again = createKnowledgeChangeStore(db, { now: () => clock });
    expect((db.prepare('PRAGMA table_info(knowledge_changes)').all() as Array<{ name: string }>).some((column) => column.name === 'updated_at')).toBe(true);
    clock += REVISING_SWEEP_MS + 1;
    expect(again.get(old.id)?.status).toBe('staged');
  });

  it('stageRevising stages exactly the named revising changes', () => {
    const a = store.insert(base({ status: 'revising' }));
    const b = store.insert(base({ status: 'revising' }));
    const c = store.insert(base({ status: 'staged' }));
    expect(store.stageRevising([a.id, c.id], 'the turn ended')).toBe(1);
    expect(store.get(a.id)?.status).toBe('staged');
    expect(store.get(b.id)?.status).toBe('revising');
    expect(store.get(c.id)?.statusReason).toBeNull();
  });

  it('a waiting change expires after 14 days, lazily, and its plan is dropped', () => {
    const made = store.insert(base());
    clock += CHANGE_EXPIRY_MS - 1;
    expect(store.get(made.id)?.status).toBe('staged');
    clock += 2;
    expect(store.get(made.id)).toMatchObject({ status: 'expired', plan: null, statusReason: expect.stringContaining('14 days') });
  });

  it('at most 50 changes wait: the oldest expire', () => {
    const ids: string[] = [];
    for (let index = 0; index < MAX_WAITING_CHANGES + 3; index += 1) { clock += 10; ids.push(store.insert(base()).id); }
    const waiting = store.list({ limit: 200 });
    expect(waiting).toHaveLength(MAX_WAITING_CHANGES);
    expect(store.get(ids[0])?.status).toBe('expired');
    expect(store.get(ids[2])?.status).toBe('expired');
    expect(store.get(ids[3])?.status).toBe('staged');
    expect(store.get(ids[ids.length - 1])?.status).toBe('staged');
  });

  it('keeps only the newest 500 finished rows', () => {
    for (let index = 0; index < KEEP_FINISHED_ROWS + 5; index += 1) { clock += 10; store.insert(base({ status: 'applied', origin: 'owner_request', sources: [] })); }
    expect(store.list({ statuses: ['applied'], limit: 200 })).toHaveLength(200);
    const count = (storage.getDb().prepare("SELECT COUNT(*) AS n FROM knowledge_changes WHERE status = 'applied'").get() as { n: number }).n;
    expect(count).toBe(KEEP_FINISHED_ROWS);
  });
});

describe('list and counts', () => {
  it('lists waiting changes newest first by default and filters by status', () => {
    const a = store.insert(base()); clock += 10;
    const b = store.insert(base({ status: 'held' })); clock += 10;
    const c = store.insert(base({ status: 'stale' })); clock += 10;
    store.insert(base({ status: 'applied', origin: 'owner_request', sources: [] }));
    expect(store.list().map((change) => change.id)).toEqual([c.id, b.id, a.id]);
    expect(store.list({ statuses: ['held'] }).map((change) => change.id)).toEqual([b.id]);
    expect(store.counts()).toEqual({ waiting: 3, staged: 1, held: 1, stale: 1 });
  });
});
