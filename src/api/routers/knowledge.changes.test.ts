/**
 * The write path's routes (knowledge-library.md K19): who may call them, what a click can and cannot do, and that the page
 * and the chat card see the same change. A real loopback server and a real writer, journal and changes store on a temp
 * library with a space in its name; the guide check is a scripted model; synthetic content.
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createChatJobStore, type ChatJobStore } from '../../core/chat-jobs.js';
import { createKnowledgeJobWaker } from '../../core/knowledge-job-wake.js';
import { fakePrivateKeyBlock } from '../../core/knowledge-fixtures.testutil.js';
import { noteToolCall } from '../../core/knowledge-taint.js';
import { dateBreach, makeHarness, type Harness } from '../../core/knowledge-write.testutil.js';
import { createKnowledgeRouter } from './knowledge.js';

let h: Harness;
let server: http.Server;
let base: string;
/** The router's dependencies, kept so a test can take the job waker away or swap it. */
let deps: any;
let jobs: ChatJobStore;
/** The job ids the waker asked the continuation runner to run. */
let wakeRequests: string[];
/** Errors that reached Express after a route had already answered (a client cannot see these). */
let lateErrors: Error[];
const ui = (test: request.Test) => test.set('Origin', base).set('Sec-Fetch-Site', 'same-origin');
const ADD = { set: 'shop-data', file: 'orders.md', mode: 'edit', edits: [{ find: '- Always filter by channel.', replace: '- Always filter by channel.\n- Use placeholders for dates.' }] };
const PROPOSE = { why: 'verified in a real query', trigger: 'verified_fact' };
const propose = async (args: Record<string, unknown> = ADD, context = h.turn('what is up')) => h.write(context, { ...args, ...PROPOSE }, 'knowledge_propose');

beforeEach(async () => {
  h = await makeHarness();
  const app = express();
  app.use(express.json());
  jobs = createChatJobStore(h.storage.getDb());
  wakeRequests = [];
  const knowledgeJobWaker = createKnowledgeJobWaker({ jobs, changes: h.changes, request: (jobId) => { wakeRequests.push(jobId); }, log: () => undefined });
  deps = { nodeManager: {} as any, db: h.storage.getDb(), knowledgeLibrary: h.library, knowledgeWriter: h.writer, knowledgeHistory: h.history, knowledgeChanges: h.changes, knowledgeJobWaker };
  app.use('/api', createKnowledgeRouter(deps));
  lateErrors = [];
  app.use((error: Error, _req: express.Request, res: express.Response, next: express.NextFunction) => {
    lateErrors.push(error);
    if (res.headersSent) return;
    res.status(500).json({ error: String(error?.message ?? error) });
    void next;
  });
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  h.close();
  fs.rmSync(h.base, { recursive: true, force: true });
});

describe('who may call', () => {
  it('refuses a foreign page on every read and every change, and a native client without the rendered page on every change', async () => {
    const staged = await propose();
    const id = String(staged.changeId);
    for (const [method, url] of [['get', '/api/knowledge/changes'], ['get', `/api/knowledge/changes/${id}`], ['get', '/api/knowledge/history']] as const) {
      expect((await request(server)[method](url).set('Origin', 'https://evil.example')).status, url).toBe(403);
    }
    for (const url of [`/api/knowledge/changes/${id}/apply`, `/api/knowledge/changes/${id}/dismiss`, `/api/knowledge/changes/${id}/recheck`, `/api/knowledge/changes/${id}/undo`, '/api/knowledge/undo']) {
      expect((await request(server).post(url).send({})).status, `native ${url}`).toBe(403);
      expect((await request(server).post(url).set('Origin', 'https://evil.example').set('Sec-Fetch-Site', 'cross-site').send({})).status, `foreign ${url}`).toBe(403);
    }
    expect(h.read('shop-data/orders.md')).not.toContain('placeholders');
    expect(h.changes.get(id)?.status).toBe('staged');
    expect(h.llmCalls).toHaveLength(1);
  });

  it('is 503 with a next action when the write path is not wired, and has no PUT, PATCH or DELETE', async () => {
    const bare = express();
    bare.use(express.json());
    bare.use('/api', createKnowledgeRouter({ nodeManager: {} as any, db: h.storage.getDb() } as any));
    const response = await request(bare).get('/api/knowledge/changes');
    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({ code: 'library_unavailable', nextAction: expect.any(String) });
    const source = fs.readFileSync(path.join(process.cwd(), 'src/api/routers/knowledge.ts'), 'utf8');
    expect(source).not.toMatch(/router\.(put|patch|delete)\(/);
    const declared = [...source.matchAll(/router\.(get|post)\('(\/knowledge\/[^']*)'/g)].map((match) => `${match[1].toUpperCase()} ${match[2]}`);
    expect(declared.filter((route) => /changes|history|undo/.test(route))).toEqual([
      'GET /knowledge/changes', 'GET /knowledge/changes/:id', 'POST /knowledge/changes/:id/apply', 'POST /knowledge/changes/:id/dismiss', 'POST /knowledge/changes/:id/recheck',
      'POST /knowledge/changes/:id/undo', 'POST /knowledge/undo', 'GET /knowledge/history', 'GET /knowledge/history/:id',
    ]);
  });
});

describe('the list and one change', () => {
  it('lists waiting changes with counts and a card view, never the stored texts, and validates ids and the status filter', async () => {
    const staged = await propose();
    const listed = await request(server).get('/api/knowledge/changes').set('Origin', base);
    expect(listed.status).toBe(200);
    expect(listed.headers['cache-control']).toBe('no-store');
    expect(listed.body.counts).toEqual({ waiting: 1, staged: 1, held: 0, stale: 0 });
    expect(listed.body.changes[0]).toMatchObject({ id: staged.changeId, set: 'shop-data', file: 'orders.md', mode: 'edit', status: 'staged', origin: 'botboy_proposal', needsAnyway: false, needsConfirm: false, actions: ['apply', 'dismiss', 'recheck'] });
    expect(listed.body.changes[0].files).toEqual([{ path: 'shop-data/orders.md', effect: 'changed' }]);
    expect(listed.body.changes[0].diff).toContain('+- Use placeholders for dates.');
    expect(JSON.stringify(listed.body)).not.toContain('"after"');
    const one = await request(server).get(`/api/knowledge/changes/${staged.changeId}`).set('Origin', base);
    expect(one.body.id).toBe(staged.changeId);
    expect((await request(server).get('/api/knowledge/changes/nope').set('Origin', base)).status).toBe(400);
    expect((await request(server).get('/api/knowledge/changes/xkc_aaaaaaaaaaaay').set('Origin', base)).status).toBe(400);
    expect((await request(server).get('/api/knowledge/changes/kc_000000000000').set('Origin', base)).status).toBe(404);
    expect((await request(server).get('/api/knowledge/changes?status=bogus').set('Origin', base)).status).toBe(400);
    expect((await request(server).get('/api/knowledge/changes?status=applied').set('Origin', base)).body.changes).toEqual([]);
  });
});

describe('Apply: the stored candidate, and only when the owner has seen what is open', () => {
  it('applies exactly what was staged; a body with content or edits changes nothing; no model call; the second click is change_closed', async () => {
    const staged = await propose();
    const id = String(staged.changeId);
    const calls = h.llmCalls.length;
    const applied = await ui(request(server).post(`/api/knowledge/changes/${id}/apply`)).send({ content: 'INJECTED', edits: [{ find: 'a', replace: 'b' }], anyway: false });
    expect(applied.status).toBe(200);
    expect(applied.body).toMatchObject({ ok: true, change: { id, status: 'applied' } });
    expect(h.read('shop-data/orders.md')).toContain('Use placeholders for dates.');
    expect(h.read('shop-data/orders.md')).not.toContain('INJECTED');
    expect(h.llmCalls).toHaveLength(calls);
    const second = await ui(request(server).post(`/api/knowledge/changes/${id}/apply`)).send({});
    expect(second.status).toBe(409);
    expect(second.body).toMatchObject({ code: 'change_closed', nextAction: expect.any(String), change: { status: 'applied' } });
    expect(h.history.list().filter((entry) => entry.kind === 'write')).toHaveLength(1);
  });

  it('a guide breach needs Apply anyway, which is recorded as an override; a credential cannot be applied at all', async () => {
    h.queue({ items: [dateBreach('The 2026-03-14 note')] });
    const staged = await h.write(h.turn('please add a note to shop-data orders.md'), { ...ADD, edits: [{ find: '- Always filter by channel.', replace: '- Always filter by channel.\n- The 2026-03-14 note' }], stageAsIs: true });
    const id = String(staged.changeId);
    const view = (await request(server).get(`/api/knowledge/changes/${id}`).set('Origin', base)).body;
    expect(view).toMatchObject({ needsAnyway: true, unresolved: [{ tier: 'must_fix' }] });
    const plain = await ui(request(server).post(`/api/knowledge/changes/${id}/apply`)).send({});
    expect(plain.status).toBe(409);
    expect(plain.body.code).toBe('needs_anyway');
    expect(h.read('shop-data/orders.md')).not.toContain('2026-03-14');
    const anyway = await ui(request(server).post(`/api/knowledge/changes/${id}/apply`)).send({ anyway: true });
    expect(anyway.status).toBe(200);
    expect(h.history.list()[0].overrode?.[0]).toContain('must_fix');
    // A change whose stored text holds a credential is refused even with every flag.
    const row = h.changes.insert({
      setName: 'shop-data', kind: 'write', mode: 'create', file: 'keys.md',
      plan: { mode: 'create', set: 'shop-data', file: 'keys.md', files: [{ path: 'shop-data/keys.md', before: null, after: `# Keys\n${fakePrivateKeyBlock()}\n` }], summary: 'create keys.md' },
      baseSha256: null, rulesSha256: '', diffText: '', why: '', trigger: null, origin: 'botboy_proposal', sources: [], candidateSha256: 'x'.repeat(64), status: 'staged',
    });
    const secret = await ui(request(server).post(`/api/knowledge/changes/${row.id}/apply`)).send({ anyway: true, confirmFlagged: true });
    expect(secret.status).toBe(409);
    expect(secret.body.code).toBe('secret_in_content');
    expect(h.exists('shop-data/keys.md')).toBe(false);
  });

  it('text derived from an untrusted source needs a second, deliberate click, and the card says where it came from', async () => {
    const context = h.turn('summarize my inbox');
    noteToolCall(context, 'gmail_read');
    const staged = await propose(ADD, context);
    const id = String(staged.changeId);
    const view = (await request(server).get(`/api/knowledge/changes/${id}`).set('Origin', base)).body;
    expect(view).toMatchObject({ sources: ['email'], needsConfirm: true });
    const first = await ui(request(server).post(`/api/knowledge/changes/${id}/apply`)).send({ anyway: true });
    expect(first.status).toBe(409);
    expect(first.body).toMatchObject({ code: 'confirm_required', error: expect.stringContaining('email') });
    expect(h.read('shop-data/orders.md')).not.toContain('placeholders');
    expect((await ui(request(server).post(`/api/knowledge/changes/${id}/apply`)).send({ confirmFlagged: true })).status).toBe(200);
    expect(h.history.list()[0].sources).toEqual(['email']);
  });
});

describe('Dismiss, Retry check, Undo', () => {
  it('dismisses a waiting change without writing, and a closed one stays closed', async () => {
    const staged = await propose();
    const id = String(staged.changeId);
    const dismissed = await ui(request(server).post(`/api/knowledge/changes/${id}/dismiss`)).send({});
    expect(dismissed.body).toMatchObject({ ok: true, change: { status: 'dismissed', actions: [] } });
    expect(h.read('shop-data/orders.md')).not.toContain('placeholders');
    expect((await ui(request(server).post(`/api/knowledge/changes/${id}/apply`)).send({})).body.code).toBe('change_closed');
    expect((await ui(request(server).post('/api/knowledge/changes/kc_000000000000/dismiss')).send({})).status).toBe(404);
    expect((await ui(request(server).post('/api/knowledge/changes/nope/dismiss')).send({})).status).toBe(400);
  });

  it('Retry check runs the guide check again (the one route that calls a model); a held change cannot be applied until it passes', async () => {
    h.setClient(null);
    const held = await h.write(h.turn('please add a note to shop-data orders.md'), ADD);
    const id = String(held.changeId);
    expect((await request(server).get(`/api/knowledge/changes/${id}`).set('Origin', base)).body).toMatchObject({ status: 'held', actions: ['recheck', 'dismiss'], check: { nextAction: expect.stringContaining('Settings') } });
    expect((await ui(request(server).post(`/api/knowledge/changes/${id}/apply`)).send({ anyway: true })).body.code).toBe('held_check_unavailable');
    const still = await ui(request(server).post(`/api/knowledge/changes/${id}/recheck`)).send({});
    expect(still.status).toBe(409);
    expect(still.body).toMatchObject({ code: 'held_check_unavailable', change: { status: 'held' } });
    h.useFakeModel();
    const calls = h.llmCalls.length;
    const passed = await ui(request(server).post(`/api/knowledge/changes/${id}/recheck`)).send({});
    expect(passed.body).toMatchObject({ ok: true, change: { status: 'staged', actions: ['apply', 'dismiss', 'recheck'] } });
    expect(h.llmCalls.length - calls).toBe(1);
    expect(h.read('shop-data/orders.md')).not.toContain('placeholders');
  });

  it('Undo restores the latest change from its card or from History, refuses an older one, and says when there is nothing', async () => {
    // History's Undo names the entry it shows (P2 review R26): none, or a malformed one, is refused; with nothing to undo the answer is 404.
    expect((await ui(request(server).post('/api/knowledge/undo')).send({})).body).toMatchObject({ code: 'invalid_id' });
    expect((await ui(request(server).post('/api/knowledge/undo')).send({ entryId: 'nope' })).status).toBe(400);
    expect((await ui(request(server).post('/api/knowledge/undo')).send({ entryId: 'h_000000000000' })).status).toBe(404);
    h.queue({});
    const first = await h.write(h.turn('please add a note to shop-data orders.md'), ADD);
    h.queue({});
    const second = await h.write(h.turn('please update shop-data orders_analysis.md'), { set: 'shop-data', file: 'orders_analysis.md', mode: 'edit', edits: [{ find: 'Methodology only.', replace: 'Methodology only, extended.' }] });
    const olderUndo = await ui(request(server).post(`/api/knowledge/changes/${first.changeId}/undo`)).send({});
    expect(olderUndo.status).toBe(409);
    expect(olderUndo.body.code).toBe('not_latest');
    expect(h.read('shop-data/orders.md')).toContain('placeholders');
    // The History button of an entry that is no longer the latest: not_latest, nothing changes (R26).
    const olderEntry = await ui(request(server).post('/api/knowledge/undo')).send({ entryId: first.historyId });
    expect(olderEntry.status).toBe(409);
    expect(olderEntry.body).toMatchObject({ code: 'not_latest', nextAction: expect.stringContaining('latest') });
    expect(h.read('shop-data/orders.md')).toContain('placeholders');
    expect(h.read('shop-data/orders_analysis.md')).toContain('extended');
    expect(h.history.latestUndoable()?.id).toBe(second.historyId);
    const latest = await ui(request(server).post(`/api/knowledge/changes/${second.changeId}/undo`)).send({});
    expect(latest.status).toBe(200);
    expect(h.read('shop-data/orders_analysis.md')).not.toContain('extended');
    // From History the latest undoable entry is now the Undo itself (a redo); the older change comes back with a second Undo of the first.
    const redo = await ui(request(server).post('/api/knowledge/undo')).send({ entryId: h.history.latestUndoable()?.id });
    expect(redo.status).toBe(200);
    expect(h.read('shop-data/orders_analysis.md')).toContain('extended');
    // An edit made by hand after the last change blocks Undo: it would erase that edit.
    h.put('shop-data/orders_analysis.md', `${h.read('shop-data/orders_analysis.md')}\nHand edit.\n`);
    const blocked = await ui(request(server).post('/api/knowledge/undo')).send({ entryId: h.history.latestUndoable()?.id });
    expect(blocked.status).toBe(409);
    expect(blocked.body.code).toBe('changed_since');
  });
});

describe('closing the page during Retry check', () => {
  it('cancels the model call that the page started (the request signal reaches the client) and leaves the change held', async () => {
    h.setClient(null);
    const held = await h.write(h.turn('please add a note to shop-data orders.md'), ADD);
    let seenSignal: AbortSignal | undefined;
    let started!: () => void;
    const reachedModel = new Promise<void>((resolve) => { started = resolve; });
    h.setClient({
      isAvailable: () => true, getContextBudgetTokens: () => 100_000, getMaxCompletionTokens: () => 16_384,
      chatCompletion: (req: { signal?: AbortSignal }) => new Promise((_resolve, reject) => {
        seenSignal = req.signal;
        started();
        req.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      }),
    } as never);
    const pending = ui(request(server).post(`/api/knowledge/changes/${held.changeId}/recheck`)).send({}).then(() => undefined, () => undefined);
    await reachedModel;
    expect(seenSignal?.aborted).toBe(false);
    // The owner closes the page: the connection goes away, and the call that was waiting on the model is cancelled.
    server.closeAllConnections();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(seenSignal?.aborted).toBe(true);
    await pending;
    expect(h.changes.get(String(held.changeId))?.status).toBe('held');
  });
});

describe('History', () => {
  it('lists entries newest first with the latest undoable one and the git status, shows a per-file diff, and records an outside edit on the next read', async () => {
    h.queue({});
    const applied = await h.write(h.turn('please add a note to shop-data orders.md'), ADD);
    h.put('shop-data/orders_analysis.md', '# Analysis\n\nEdited in an editor.\n');
    // History looks again at most every 3 seconds; the harness clock only moves when told to.
    h.advance(5_000);
    const listed = await request(server).get('/api/knowledge/history').set('Origin', base);
    expect(listed.status).toBe(200);
    expect(listed.headers['cache-control']).toBe('no-store');
    expect(listed.body.entries.map((entry: { kind: string }) => entry.kind)).toEqual(['outside', 'write', 'baseline']);
    expect(listed.body.entries[0]).toMatchObject({ actor: 'outside', summary: expect.stringContaining('Edited outside BotBoy') });
    expect(listed.body.latestUndoableId).toBe(applied.historyId);
    // The harness has no git mirror: the status is null here, and the mirror's own states are covered in knowledge-git.test.ts.
    expect(listed.body).toHaveProperty('git', null);
    expect(listed.body.note).toContain('stays on this Mac');
    const detail = await request(server).get(`/api/knowledge/history/${applied.historyId}`).set('Origin', base);
    expect(detail.body).toMatchObject({ entry: { id: applied.historyId, changeId: applied.changeId }, undoable: true });
    expect(JSON.stringify(detail.body.files)).toContain('Use placeholders for dates.');
    expect((await request(server).get('/api/knowledge/history/nope').set('Origin', base)).status).toBe(400);
    expect((await request(server).get('/api/knowledge/history/h_000000000000').set('Origin', base)).status).toBe(404);
  });

  it('never shows the content of a credential an outside edit added', async () => {
    await request(server).get('/api/knowledge/history').set('Origin', base);
    h.put('shop-data/secrets.md', `# Keys\n${fakePrivateKeyBlock()}\n`);
    h.advance(5_000);
    const listed = await request(server).get('/api/knowledge/history').set('Origin', base);
    const entry = listed.body.entries[0];
    const detail = await request(server).get(`/api/knowledge/history/${entry.id}`).set('Origin', base);
    expect(JSON.stringify(detail.body)).not.toContain('PRIVATE KEY');
    expect(detail.body.files[0]).toMatchObject({ path: 'shop-data/secrets.md', diff: null, note: expect.stringContaining('not shown') });
  });
});

describe('a job that paused for the owner\'s decision goes on once the owner decides (K21)', () => {
  // The job store stamps with the real clock and the harness with its own: put both on one timeline, one minute per step.
  const tick = (ms: number) => { h.advance(ms); vi.setSystemTime(Date.now() + ms); };
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(1_800_000_000_000);
  });
  afterEach(() => { vi.useRealTimers(); });

  /** The owner's story: the job starts, BotBoy stages a card while it works, and the turn ends asking the owner to review it. */
  async function pausedJobWithCard() {
    const job = jobs.start({ goal: 'Rework the notes' });
    tick(60_000);
    const id = String((await propose()).changeId);
    tick(60_000);
    jobs.settle(job.id, { action: 'pause', note: 'Please review the proposal in Settings → Knowledge.' }, 'answered');
    expect(jobs.get(job.id)!.pausedAt).toBeTruthy();
    tick(60_000);
    return { job, id };
  }
  const OTHER_FILE = { set: 'shop-data', file: 'orders_analysis.md', mode: 'edit', edits: [{ find: 'Methodology only.', replace: 'Methodology only, extended.' }] };

  it('applying the card wakes the job: the pause is gone, one continuation is requested, and the reason says what was saved', async () => {
    const { job, id } = await pausedJobWithCard();
    expect(wakeRequests).toEqual([]);
    const applied = await ui(request(server).post(`/api/knowledge/changes/${id}/apply`)).send({});
    expect(applied.status).toBe(200);
    const woken = jobs.get(job.id)!;
    expect(woken.pausedAt).toBeUndefined();
    expect(woken.continueRequestedAt).toBeTruthy();
    expect(woken.continueReason).toContain('The owner applied "Edit orders.md in shop-data", which this job was waiting on.');
    expect(wakeRequests).toEqual([job.id]);
    // The same state seen again (a second request, the boot check) wakes nothing more.
    expect(deps.knowledgeJobWaker.wakeIfDecided()).toBeNull();
    expect(wakeRequests).toHaveLength(1);
  });

  it('dismissing the card wakes it too, and the reason says nothing was written', async () => {
    const { job, id } = await pausedJobWithCard();
    expect((await ui(request(server).post(`/api/knowledge/changes/${id}/dismiss`)).send({})).status).toBe(200);
    const woken = jobs.get(job.id)!;
    expect(woken.continueReason).toContain('The owner dismissed "Edit orders.md in shop-data"');
    expect(woken.continueReason).toContain('Dismissed changes wrote nothing.');
    expect(wakeRequests).toEqual([job.id]);
    expect(h.read('shop-data/orders.md')).not.toContain('placeholders');
  });

  it('a click that is refused wakes nothing; the deliberate one that applies it does', async () => {
    const job = jobs.start({ goal: 'Rework the notes' });
    tick(60_000);
    h.queue({ items: [dateBreach('The 2026-03-14 note')] });
    const staged = await h.write(h.turn('please add a note to shop-data orders.md'), { ...ADD, edits: [{ find: '- Always filter by channel.', replace: '- Always filter by channel.\n- The 2026-03-14 note' }], stageAsIs: true });
    const id = String(staged.changeId);
    tick(60_000);
    jobs.settle(job.id, { action: 'pause', note: 'Please review it.' }, 'answered');
    tick(60_000);
    expect((await ui(request(server).post(`/api/knowledge/changes/${id}/apply`)).send({})).body.code).toBe('needs_anyway');
    expect((await ui(request(server).post('/api/knowledge/changes/kc_000000000000/dismiss')).send({})).status).toBe(404);
    expect((await ui(request(server).post('/api/knowledge/changes/nope/apply')).send({})).status).toBe(400);
    expect(jobs.get(job.id)!.pausedAt).toBeTruthy();
    expect(wakeRequests).toEqual([]);
    expect((await ui(request(server).post(`/api/knowledge/changes/${id}/apply`)).send({ anyway: true })).status).toBe(200);
    expect(wakeRequests).toEqual([job.id]);
  });

  it('two cards: the first decision waits, the last one wakes the job once and names both', async () => {
    const job = jobs.start({ goal: 'Rework the notes' });
    tick(60_000);
    const first = String((await propose()).changeId);
    tick(60_000);
    const second = String((await propose(OTHER_FILE)).changeId);
    tick(60_000);
    jobs.settle(job.id, { action: 'pause', note: 'Please review both cards.' }, 'answered');
    tick(60_000);
    expect((await ui(request(server).post(`/api/knowledge/changes/${first}/apply`)).send({})).status).toBe(200);
    expect(wakeRequests).toEqual([]);
    expect(jobs.get(job.id)!.pausedAt).toBeTruthy();
    tick(60_000);
    expect((await ui(request(server).post(`/api/knowledge/changes/${second}/dismiss`)).send({})).status).toBe(200);
    expect(wakeRequests).toEqual([job.id]);
    expect(jobs.get(job.id)!.continueReason).toContain('applied "Edit orders.md in shop-data", dismissed "Edit orders_analysis.md in shop-data"');
  });

  it('a card the job did not stage does not wake it: the job paused on a question, not on that card', async () => {
    const earlier = String((await propose()).changeId); // staged before the job began
    tick(60_000);
    const job = jobs.start({ goal: 'Find the cause of the dip' });
    tick(60_000);
    jobs.settle(job.id, { action: 'pause', note: 'Which quarter should I look at?' }, 'answered');
    tick(60_000);
    expect((await ui(request(server).post(`/api/knowledge/changes/${earlier}/apply`)).send({})).status).toBe(200);
    expect(jobs.get(job.id)!.pausedAt).toBeTruthy();
    expect(wakeRequests).toEqual([]);
  });

  it('without a waker the click still works and the job is left alone; a waker that throws cannot fail the click', async () => {
    const { job, id } = await pausedJobWithCard();
    delete deps.knowledgeJobWaker;
    expect((await ui(request(server).post(`/api/knowledge/changes/${id}/apply`)).send({})).status).toBe(200);
    expect(jobs.get(job.id)!.pausedAt).toBeTruthy();
    expect(wakeRequests).toEqual([]);
    // A waker that fails after the answer was sent: the owner still sees the click succeed, and nothing is left unhandled
    // (the dismiss route is synchronous, so a late error would reach Express; the apply route is async, so it would be an
    // unhandled rejection, which fails the whole test run).
    deps.knowledgeJobWaker = { wakeIfDecided: () => { throw new Error('waker broke'); } };
    const other = String((await propose(OTHER_FILE)).changeId);
    const dismissed = await ui(request(server).post(`/api/knowledge/changes/${other}/dismiss`)).send({});
    expect(dismissed.status).toBe(200);
    expect(dismissed.body).toMatchObject({ ok: true, change: { status: 'dismissed' } });
    const third = String((await propose({ set: 'shop-data', file: 'SHOP_PRODUCT_GUIDE.md', mode: 'edit', edits: [{ find: 'Flows.', replace: 'Flows, extended.' }] })).changeId);
    const applied = await ui(request(server).post(`/api/knowledge/changes/${third}/apply`)).send({});
    expect(applied.status).toBe(200);
    await new Promise((resolve) => setImmediate(resolve)); // let a late rejection or error surface
    expect(lateErrors).toEqual([]);
    expect(jobs.get(job.id)!.pausedAt).toBeTruthy();
  });
});
