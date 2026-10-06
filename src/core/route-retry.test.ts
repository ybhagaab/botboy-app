import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createStorage, getSetting, type StorageLayer } from './storage.js';
import { createBatcher, type ProcessState } from './batcher.js';
import { createRouteRetry, ROUTE_RETRY_RECEIPT_KEY, type RouteRetryConfig, type RouteRetryReceipt } from './route-retry.js';

const MINUTE = 60_000;
const NOW = Date.parse('2026-10-06T12:00:00Z');

/** SQLite's `datetime('now')` format, as the failures table stores it. */
const sqliteUtc = (ms: number) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);

describe('route-retry', () => {
  let storage: StorageLayer;
  let clock: number;
  let available: boolean;
  let log: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    storage = createStorage(':memory:');
    storage.initialize();
    clock = NOW;
    available = true;
    log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => {
    log.mockRestore();
    storage.close();
  });

  const db = () => storage.getDb();

  function item(id: string, state: ProcessState, opts: { capturedAt?: number; url?: string; projectId?: string; type?: string } = {}) {
    db().prepare(
      `INSERT INTO work_items (id, type, source, title, url, captured_at, process_state, project_id, batch_id)
       VALUES (?, ?, 'gmail', ?, ?, ?, ?, ?, 'failed-wave')`,
    ).run(id, opts.type ?? 'email_read', `title-${id}`, opts.url ?? null, new Date(opts.capturedAt ?? NOW - 60 * MINUTE).toISOString(), state, opts.projectId ?? null);
  }

  function failed(id: string, ...minutesAgo: number[]) {
    for (const ago of minutesAgo) {
      db().prepare("INSERT INTO failures (item_id, step, message, created_at) VALUES (?, 'route', 'timeout', ?)").run(id, sqliteUtc(clock - ago * MINUTE));
    }
  }

  function retry(config: RouteRetryConfig = {}) {
    const batcher = createBatcher(db());
    return createRouteRetry({ db: db(), batcher, isAvailable: () => available, now: () => clock, config });
  }

  const stateOf = (id: string) => (db().prepare('SELECT process_state AS s, batch_id AS b FROM work_items WHERE id = ?').get(id) as { s: string; b: string | null });
  const receipt = () => getSetting<RouteRetryReceipt>(db(), ROUTE_RETRY_RECEIPT_KEY);

  it('requeues retryable failures after their backoff and leaves exhausted, waiting, and superseded rows', () => {
    item('ready', 'route_failed'); failed('ready', 120);                 // 1 failure, 2 h ago: past 30 min
    item('recent', 'route_failed'); failed('recent', 10);                // 1 failure, 10 min ago: waiting
    item('second', 'route_failed'); failed('second', 60, 30);            // 2 failures, last 30 min ago: 2 h backoff
    item('spent', 'route_failed'); failed('spent', 300, 200, 100);      // 3 failures: exhausted
    item('old-copy', 'route_failed', { url: 'gmail://mail/x', capturedAt: NOW - 90 * MINUTE }); failed('old-copy', 100);
    item('new-copy', 'routed', { url: 'gmail://mail/x', capturedAt: NOW - 30 * MINUTE, projectId: 'p1' });
    item('placed', 'route_failed', { projectId: 'p2' }); failed('placed', 100);
    item('ref', 'route_failed', { type: 'file_reference' }); failed('ref', 100);
    item('routed', 'routed', { projectId: 'p3' });

    const result = retry().sweep();
    expect(result).toEqual({ requeued: 1, exhausted: 1, waiting: 2, superseded: 1 });
    expect(stateOf('ready')).toEqual({ s: 'extracted', b: null });
    for (const id of ['recent', 'second', 'spent', 'old-copy', 'placed', 'ref']) expect(stateOf(id).s).toBe('route_failed');
    expect(receipt()).toMatchObject({ at: new Date(NOW).toISOString(), requeued: 1, exhausted: 1, waiting: 2, superseded: 1, totalRequeued: 1 });
    expect(log).toHaveBeenCalledWith(expect.stringContaining('Retrying routing for 1 item(s)'));
  });

  it('counts a row without a failure record as one attempt, timed from its capture', () => {
    item('unrecorded', 'route_failed', { capturedAt: NOW - 5 * MINUTE });
    const sweeper = retry({ minIntervalMs: 0 });
    expect(sweeper.sweep()).toMatchObject({ requeued: 0, waiting: 1 });
    clock = NOW + 30 * MINUTE;
    expect(sweeper.sweep()).toMatchObject({ requeued: 1 });
    expect(stateOf('unrecorded').s).toBe('extracted');
  });

  it('takes a wave of first retries, oldest failure first, and gives a final attempt its own wave', () => {
    for (let index = 0; index < 4; index++) { item(`f${index}`, 'route_failed'); failed(`f${index}`, 100 - index); }
    item('last-a', 'route_failed'); failed('last-a', 600, 300);
    item('last-b', 'route_failed'); failed('last-b', 600, 400);
    const sweeper = retry({ maxPerSweep: 3, minIntervalMs: 0 });

    expect(sweeper.sweep()?.requeued).toBe(3);
    expect(['f0', 'f1', 'f2', 'f3'].map(id => stateOf(id).s)).toEqual(['extracted', 'extracted', 'extracted', 'route_failed']);
    db().prepare("UPDATE work_items SET process_state = 'routed', project_id = 'p' WHERE process_state = 'extracted'").run();

    expect(sweeper.sweep()?.requeued).toBe(1);
    expect(stateOf('f3').s).toBe('extracted');
    db().prepare("UPDATE work_items SET process_state = 'routed', project_id = 'p' WHERE process_state = 'extracted'").run();

    // Only final attempts remain: one per sweep, the longest-waiting first.
    expect(sweeper.sweep()?.requeued).toBe(1);
    expect([stateOf('last-a').s, stateOf('last-b').s]).toEqual(['route_failed', 'extracted']);
    expect(receipt()?.totalRequeued).toBe(5);
  });

  it('waits for fresh work, an available model, and its interval', () => {
    item('ready', 'route_failed'); failed('ready', 120);
    item('fresh', 'extracted', { capturedAt: NOW });
    const sweeper = retry();
    expect(sweeper.sweep()).toBeNull();
    expect(stateOf('ready').s).toBe('route_failed');

    db().prepare("UPDATE work_items SET process_state = 'routed', project_id = 'p' WHERE id = 'fresh'").run();
    available = false;
    expect(sweeper.sweep()).toBeNull();
    expect(receipt()).toBeNull();

    available = true;
    expect(sweeper.sweep()?.requeued).toBe(1);
    item('later', 'route_failed'); failed('later', 120);
    db().prepare("UPDATE work_items SET process_state = 'routed', project_id = 'p' WHERE id = 'ready'").run();
    clock = NOW + 5 * MINUTE;
    expect(sweeper.sweep()).toBeNull(); // within 10 minutes of the last sweep
    clock = NOW + 10 * MINUTE;
    expect(sweeper.sweep()?.requeued).toBe(1);
  });
});
