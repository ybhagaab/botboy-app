import Database from 'better-sqlite3';
import {
  createLockWaitRunner,
  createLockWaitStore,
  lockWaitNotice,
  lockWaitSchedule,
  nextLockTryAt,
  type DocumentSyncOutcome,
  type LockWait,
  type LockWaitEnd,
} from './sharepoint-lock-waits.js';

/**
 * Waiting for a SharePoint file to be closed (owner report 2026-11-16: a publication refused 11 times because reviewers had the
 * PRD open read "Publication phase recorded"; its 2-hour in-memory retry would have ended with no button left). A refused write
 * waits durably: every 4 minutes for an hour, then every 15, up to 24 hours; one write per document at a time.
 */
const MIN = 60_000;
const T0 = Date.parse('2026-11-16T10:17:00.000Z');
const KEY = 'amazon-my.sharepoint.com/personal/u/Documents/Notification Permission WebLab PRD.docx';
const LOCKED: DocumentSyncOutcome = { status: 'locked' };
const LANDED: DocumentSyncOutcome = { status: 'done', uploaded: true, verifiedOnReadBack: true, results: [{ id: 'pe1', applied: true }] };

describe('the wait schedule', () => {
  it('tries every 4 minutes for the first hour, then every 15, and stops 24 hours after the first refusal', () => {
    expect(nextLockTryAt(T0, T0)).toBe(T0 + 4 * MIN);
    expect(nextLockTryAt(T0, T0 + 59 * MIN)).toBe(T0 + 63 * MIN);
    expect(nextLockTryAt(T0, T0 + 60 * MIN)).toBe(T0 + 75 * MIN);
    expect(nextLockTryAt(T0, T0 + 1435 * MIN)).toBe(T0 + 1440 * MIN); // never past the end
    expect(nextLockTryAt(T0, T0 + 1440 * MIN)).toBeNull();
  });
  it('reads the test overrides per call', () => {
    expect(lockWaitSchedule({ PPT_LOCK_RETRY_INTERVAL_MS: '25', PPT_LOCK_WAIT_LIMIT_MS: '100' } as any)).toMatchObject({ fastMs: 25, slowMs: 25, limitMs: 100 });
    expect(lockWaitSchedule({} as any)).toMatchObject({ fastMs: 4 * MIN, slowMs: 15 * MIN, limitMs: 24 * 60 * MIN });
  });
});

describe('the wait store', () => {
  it('starts on the first refusal, counts the next, survives a new store on the same database, and ends', () => {
    const db = new Database(':memory:');
    const store = createLockWaitStore(db);
    expect(store.noteRefused(KEY, T0)).toEqual({
      docKey: KEY, startedAt: new Date(T0).toISOString(), tries: 1, lastTryAt: new Date(T0).toISOString(),
      nextTryAt: new Date(T0 + 4 * MIN).toISOString(), endsAt: new Date(T0 + 24 * 60 * MIN).toISOString(),
    });
    expect(store.noteRefused(KEY, T0 + 4 * MIN)).toMatchObject({ tries: 2, nextTryAt: new Date(T0 + 8 * MIN).toISOString() });
    // A restart: the next process reads the same wait.
    expect(createLockWaitStore(db).open()).toEqual([expect.objectContaining({ docKey: KEY, tries: 2 })]);
    expect(store.noteRefused(KEY, T0 + 24 * 60 * MIN)).toBeNull(); // run its course: the caller ends it
    expect(store.end(KEY)).toMatchObject({ tries: 2 });
    expect(store.get(KEY)).toBeNull();
    expect(store.end(KEY)).toBeNull();
  });
});

describe('the wait runner', () => {
  function setup(answers: Array<DocumentSyncOutcome | Error | (() => Promise<DocumentSyncOutcome>)>, options: { shuttingDown?: () => boolean } = {}) {
    vi.useFakeTimers({ now: T0 });
    const db = new Database(':memory:');
    const store = createLockWaitStore(db);
    const ends: Array<{ wait: LockWait; end: LockWaitEnd }> = [];
    let calls = 0;
    const runner = createLockWaitRunner({
      store,
      sync: async () => {
        calls += 1;
        const next = answers.shift() ?? LOCKED;
        if (next instanceof Error) throw next;
        return typeof next === 'function' ? next() : next;
      },
      onEnd: (_docKey, wait, end) => { ends.push({ wait, end }); },
      isShuttingDown: options.shuttingDown,
      resumeDelayMs: 90_000,
      log: () => {},
    });
    return { db, store, runner, ends, calls: () => calls };
  }
  afterEach(() => vi.useRealTimers());

  it('the owner\'s refused Sync starts the wait; background tries count it; the write that lands ends it by itself', async () => {
    const t = setup([LOCKED, LOCKED, LANDED]);
    const first = await t.runner.syncNow(KEY);
    expect(first.outcome).toEqual(LOCKED);
    expect(first.wait).toMatchObject({ tries: 1 });
    await vi.advanceTimersByTimeAsync(4 * MIN);
    expect(t.store.get(KEY)).toMatchObject({ tries: 2 });
    expect(t.ends).toEqual([]);
    await vi.advanceTimersByTimeAsync(4 * MIN);
    expect(t.calls()).toBe(3);
    expect(t.store.get(KEY)).toBeNull();
    expect(t.ends).toEqual([{ wait: expect.objectContaining({ tries: 2 }), end: { kind: 'landed', byOwner: false } }]);
  });

  it('runs its course after 24 hours and ends as gave_up, counting the last refusal', async () => {
    const t = setup([]);
    await t.runner.syncNow(KEY);
    await vi.advanceTimersByTimeAsync(24 * 60 * MIN + MIN);
    expect(t.store.get(KEY)).toBeNull();
    expect(t.ends).toHaveLength(1);
    expect(t.ends[0].end).toEqual({ kind: 'gave_up', byOwner: false });
    // 15 tries in the first hour (at 0, 4, … 56 and the one at 60), then one every 15 minutes up to the end.
    expect(t.ends[0].wait.tries).toBe(t.calls());
    expect(t.calls()).toBe(16 + 92);
  });

  it('the owner stops it: nothing more is tried; a try running right now still finishes and ends as stopped', async () => {
    const t = setup([]);
    await t.runner.syncNow(KEY);
    expect(t.runner.stop(KEY)).toMatchObject({ tries: 1 });
    expect(t.ends).toEqual([{ wait: expect.objectContaining({ tries: 1 }), end: { kind: 'stopped', byOwner: true } }]);
    await vi.advanceTimersByTimeAsync(60 * MIN);
    expect(t.calls()).toBe(1);
    expect(t.runner.stop(KEY)).toBeNull();

    let release!: (outcome: DocumentSyncOutcome) => void;
    const u = setup([LOCKED, () => new Promise<DocumentSyncOutcome>(resolve => { release = resolve; })]);
    await u.runner.syncNow(KEY);
    await vi.advanceTimersByTimeAsync(4 * MIN); // the background try is now waiting on SharePoint
    expect(u.runner.isBusy(KEY)).toBe(true);
    u.runner.stop(KEY);
    expect(u.ends).toEqual([]);
    release(LOCKED);
    await vi.advanceTimersByTimeAsync(0);
    expect(u.ends).toEqual([{ wait: expect.objectContaining({ tries: 1 }), end: { kind: 'stopped', byOwner: true } }]);
    expect(u.store.get(KEY)).toBeNull();
  });

  it('never runs two writes of one document at once: the owner\'s Sync during a background try answers busy', async () => {
    let release!: (outcome: DocumentSyncOutcome) => void;
    const t = setup([LOCKED, () => new Promise<DocumentSyncOutcome>(resolve => { release = resolve; })]);
    await t.runner.syncNow(KEY);
    await vi.advanceTimersByTimeAsync(4 * MIN);
    expect(await t.runner.syncNow(KEY)).toMatchObject({ outcome: { status: 'busy' }, wait: expect.objectContaining({ tries: 1 }) });
    expect(t.calls()).toBe(2);
    release(LANDED);
    await vi.advanceTimersByTimeAsync(0);
    expect(t.ends[0].end).toEqual({ kind: 'landed', byOwner: false });
  });

  it('the owner\'s own Sync that lands ends the wait without a notice; a failure before the write ends it as not written', async () => {
    const t = setup([LOCKED, LANDED]);
    await t.runner.syncNow(KEY);
    await t.runner.syncNow(KEY);
    expect(t.ends).toEqual([{ wait: expect.anything(), end: { kind: 'landed', byOwner: true } }]);
    const u = setup([LOCKED, { status: 'failed', error: 'could not verify the target is free' }]);
    await u.runner.syncNow(KEY);
    await vi.advanceTimersByTimeAsync(4 * MIN);
    expect(u.ends[0].end).toEqual({ kind: 'failed', error: 'could not verify the target is free', effectUnknown: false, byOwner: false });
  });

  it('a try that throws ends the wait with its effect unknown (it may have written)', async () => {
    const t = setup([LOCKED, new Error('MCP error -32001: Request timed out')]);
    await t.runner.syncNow(KEY);
    await vi.advanceTimersByTimeAsync(4 * MIN);
    expect(t.ends[0].end).toEqual({ kind: 'failed', error: 'MCP error -32001: Request timed out', effectUnknown: true, byOwner: false });
  });

  it('a change that no longer applies ends as not_applied; edits the owner rejected end quietly', async () => {
    const t = setup([LOCKED, { status: 'done', uploaded: false, verifiedOnReadBack: false, results: [{ id: 'pe1', applied: false, reason: 'The SharePoint file changed after approval' }] }]);
    await t.runner.syncNow(KEY);
    await vi.advanceTimersByTimeAsync(4 * MIN);
    expect(t.ends[0].end).toEqual({ kind: 'not_applied', reason: 'The SharePoint file changed after approval', byOwner: false });
    const u = setup([LOCKED, { status: 'nothing-approved' }]);
    await u.runner.syncNow(KEY);
    await vi.advanceTimersByTimeAsync(4 * MIN);
    expect(u.ends[0].end).toEqual({ kind: 'cleared', byOwner: false });
  });

  it('a restart resumes every open wait, not before the connections had time to start; shutting down tries nothing', async () => {
    const t = setup([LANDED], { shuttingDown: () => false });
    t.store.noteRefused(KEY, T0 - 10 * MIN); // its next try was due 6 minutes ago
    t.runner.resume();
    await vi.advanceTimersByTimeAsync(89_000);
    expect(t.calls()).toBe(0);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(t.calls()).toBe(1);
    expect(t.ends[0].end.kind).toBe('landed');

    let down = false;
    const u = setup([LOCKED], { shuttingDown: () => down });
    await u.runner.syncNow(KEY);
    down = true;
    await vi.advanceTimersByTimeAsync(4 * MIN);
    expect(u.calls()).toBe(1);
    expect(u.store.get(KEY)).toMatchObject({ tries: 1 }); // kept for the next start
  });
});

describe('the chat notice when a wait ends by itself', () => {
  const wait: LockWait = { docKey: KEY, startedAt: '2026-11-16T10:17:00.000Z', tries: 11, lastTryAt: '2026-11-16T10:59:00.000Z', nextTryAt: '', endsAt: '' };
  const base = { docKey: KEY, fileName: 'Notification Permission WebLab PRD.docx', wait, publication: true, route: '#/documents/art_1', clock: (iso: string) => iso.slice(11, 16), nowIso: '2026-11-16T11:40:00.000Z' };
  it('says it published, or that the file stayed open and nothing was written, with the way to the document', () => {
    expect(lockWaitNotice({ ...base, end: { kind: 'landed', byOwner: false } })).toEqual({
      key: expect.stringMatching(/^sharepoint-write:[0-9a-f]{8}$/), topic: 'sharepoint-write', state: 'resolved', severity: 'success',
      title: 'Published to SharePoint', labels: ['Notification Permission…'],
      next: 'The file was closed, so BotBoy wrote the approved version.',
      detail: 'Notification Permission WebLab PRD.docx: SharePoint refused 11 tries from 10:17 while the file was open; the write landed at 11:40.',
      action: { kind: 'open_route', label: 'Open document', route: '#/documents/art_1' },
    });
    expect(lockWaitNotice({ ...base, end: { kind: 'gave_up', byOwner: false } })).toMatchObject({
      state: 'open', severity: 'warning', title: 'SharePoint file stayed open',
      next: 'Nothing was written. Open the document and press Update when the file is closed.',
      detail: 'Notification Permission WebLab PRD.docx: SharePoint refused all 11 tries from 10:17 to 10:59: someone had the file open in Word or a browser.',
    });
    expect(lockWaitNotice({ ...base, publication: false, route: null, end: { kind: 'gave_up', byOwner: false } })).toMatchObject({
      next: 'Nothing was written; your approved edits are kept. Press Sync when the file is closed.',
    });
    expect(lockWaitNotice({ ...base, end: { kind: 'failed', error: 'x', effectUnknown: true, byOwner: false } })).toMatchObject({
      title: 'SharePoint write stopped', next: 'BotBoy lost track of the last try, so check the file before trying again.', detail: 'Notification Permission WebLab PRD.docx: x',
    });
  });
  it('a short name is its own chip; a long one is cut at a word', () => {
    expect(lockWaitNotice({ ...base, fileName: 'Rollout plan.docx', end: { kind: 'landed', byOwner: false } })?.labels).toEqual(['Rollout plan']);
    expect(lockWaitNotice({ ...base, fileName: 'Walk the Store a new user’s first open of MX Player.docx', end: { kind: 'landed', byOwner: false } })?.labels).toEqual(['Walk the Store a new user’s…']);
  });
  it('says nothing when the owner ended it himself, or when nothing was left to write', () => {
    expect(lockWaitNotice({ ...base, end: { kind: 'landed', byOwner: true } })).toBeNull();
    expect(lockWaitNotice({ ...base, end: { kind: 'stopped', byOwner: true } })).toBeNull();
    expect(lockWaitNotice({ ...base, end: { kind: 'cleared', byOwner: false } })).toBeNull();
  });
});
