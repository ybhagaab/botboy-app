import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createStorage, type StorageLayer } from './storage.js';
import { createChatJobStore, type ChatJobStore } from './chat-jobs.js';
import { createEtlRunWatcher, outcomeFromReadRun } from './etl-run-watcher.js';
import type { QueryRunResult } from './etl-adhoc.js';

/**
 * The built-in "reusable script" for async ETL (ANALYTICS_AUTONOMY_PLAN.md
 * D2): it reads each watched run, stores the outcome once, and hands the job
 * to the continuation runner. It never submits or alters a run.
 */
describe('ETL run watcher', () => {
  let storage: StorageLayer;
  let jobs: ChatJobStore;
  let jobId: string;
  beforeEach(() => {
    storage = createStorage(':memory:');
    storage.initialize();
    jobs = createChatJobStore(storage.getDb());
    jobId = jobs.start({ goal: 'Weekly players' }).id;
  });
  afterEach(() => storage.close());

  const watcher = (readRun: (runId: string) => Promise<QueryRunResult>, extra: { available?: boolean } = {}) => {
    const finished: string[] = [];
    const instance = createEtlRunWatcher({
      jobs,
      readRun,
      etlAvailable: async () => extra.available ?? true,
      onRunsFinished: id => finished.push(id),
      log: () => {},
    });
    return { instance, finished };
  };

  it('stores a SUCCESS outcome once and announces the job until a turn consumes it', async () => {
    jobs.addWatch({ runId: '101', jobId, source: 'run_query', purpose: 'Local weekly' });
    const readRun = vi.fn(async (runId: string): Promise<QueryRunResult> => ({
      ok: true, runId, remoteStatus: 'SUCCESS', columns: ['week', 'players'], rows: [['1', '2']], rowCount: 52,
      truncated: false, savedTo: `/files/etl-results/adhoc_${runId}.tsv`, resultBytes: 900,
    }));
    const { instance, finished } = watcher(readRun);
    await instance.tick();
    expect(jobs.watch('101')).toMatchObject({ status: 'finished', outcome: { remoteStatus: 'SUCCESS', rowCount: 52, savedTo: '/files/etl-results/adhoc_101.tsv' } });
    expect(finished).toEqual([jobId]);
    // Not read again; still announced until consumed (an owner turn may run first).
    await instance.tick();
    expect(readRun).toHaveBeenCalledTimes(1);
    expect(finished).toEqual([jobId, jobId]);
    jobs.consumeWatch('101');
    await instance.tick();
    expect(finished).toEqual([jobId, jobId]);
  });

  it('keeps polling a running or unreadable run, and stores a failure with its diagnosis', async () => {
    jobs.addWatch({ runId: '201', jobId, source: 'run_query' });
    let state: QueryRunResult = { ok: false, code: 'alive_handoff', runId: '201', remoteStatus: 'EXECUTING' };
    const { instance, finished } = watcher(async () => state);
    await instance.tick();
    expect(jobs.watch('201')).toMatchObject({ status: 'pending', remoteStatus: 'EXECUTING', pollFailures: 0 });
    state = { ok: false, code: 'status_unavailable', runId: '201', error: 'network' };
    await instance.tick();
    expect(jobs.watch('201')).toMatchObject({ status: 'pending', pollFailures: 1 });
    state = { ok: false, code: 'remote_failed', runId: '201', remoteStatus: 'ERROR', error: 'Run 201 ERROR. column "x" does not exist' };
    await instance.tick();
    expect(jobs.watch('201')).toMatchObject({ status: 'finished', outcome: { remoteStatus: 'ERROR', error: 'Run 201 ERROR. column "x" does not exist' } });
    expect(finished).toEqual([jobId]);
  });

  it('retries a failed download of a SUCCESS run, then reports it without losing the run', async () => {
    jobs.addWatch({ runId: '301', jobId, source: 'run_query' });
    const { instance } = watcher(async () => ({ ok: false, code: 'download_failed', runId: '301', remoteStatus: 'SUCCESS', error: 'disk full' }));
    await instance.tick();
    await instance.tick();
    expect(jobs.watch('301')?.status).toBe('pending');
    await instance.tick();
    expect(jobs.watch('301')).toMatchObject({ status: 'finished', outcome: { remoteStatus: 'SUCCESS', error: expect.stringContaining('mcp_etl_download_results') } });
  });

  it('reads nothing while the ETL connection is unavailable, and survives a throwing read', async () => {
    jobs.addWatch({ runId: '401', jobId, source: 'run_query' });
    const readRun = vi.fn(async (): Promise<QueryRunResult> => { throw new Error('boom'); });
    const off = watcher(readRun, { available: false });
    await off.instance.tick();
    expect(readRun).not.toHaveBeenCalled();
    const on = watcher(readRun);
    await on.instance.tick();
    expect(jobs.watch('401')).toMatchObject({ status: 'pending', pollFailures: 1 });
  });

  // REGRESSION (live canary 2026-10-08): a run handed off at waitSeconds 0
  // sat WAITING_FOR_RESOURCES for over ten minutes because runQuery's own
  // one-minute PRIORITIZE never ran and the watcher only read it.
  it('prioritizes its own scratch run once when it is still queued a minute after submission', async () => {
    let clock = Date.now();
    jobs.addWatch({ runId: '501', jobId, source: 'run_query' });
    jobs.addWatch({ runId: '502', jobId, source: 'wait' }); // possibly a production run: never altered
    const prioritizeRun = vi.fn(async () => ({ ok: true }));
    const instance = createEtlRunWatcher({
      jobs,
      readRun: async (runId: string) => ({ ok: false, code: 'alive_handoff', runId, remoteStatus: 'WAITING_FOR_RESOURCES' }),
      prioritizeRun,
      now: () => clock,
      etlAvailable: async () => true,
      onRunsFinished: () => {},
      log: () => {},
    });
    await instance.tick();
    expect(prioritizeRun).not.toHaveBeenCalled(); // queued under a minute
    clock += 61_000;
    await instance.tick();
    await instance.tick();
    expect(prioritizeRun.mock.calls).toEqual([['501']]);
    expect(jobs.watch('501')?.prioritizedAt).toEqual(expect.any(String));
    expect(jobs.watch('502')?.prioritizedAt).toBeUndefined();
  });

  it('does not repeat a rescue the run query already applied, and survives a failed one', async () => {
    const clock = Date.now() + 120_000;
    jobs.addWatch({ runId: '601', jobId, source: 'run_query' });
    jobs.addWatch({ runId: '602', jobId, source: 'run_query' });
    expect(jobs.markPrioritized('601')).toBe(true);
    expect(jobs.markPrioritized('601')).toBe(false);
    const prioritizeRun = vi.fn(async () => { throw new Error('policy'); });
    const instance = createEtlRunWatcher({
      jobs,
      readRun: async (runId: string) => ({ ok: false, code: 'alive_handoff', runId, remoteStatus: 'WAITING_FOR_RESOURCES' }),
      prioritizeRun,
      now: () => clock,
      etlAvailable: async () => true,
      onRunsFinished: () => {},
      log: () => {},
    });
    await instance.tick();
    await instance.tick();
    expect(prioritizeRun.mock.calls).toEqual([['602']]);
    expect(jobs.watch('602')).toMatchObject({ status: 'pending', prioritizedAt: expect.any(String) });
  });

  it('does not check the connection when no run is waiting', async () => {
    const etlAvailable = vi.fn(async () => true);
    const instance = createEtlRunWatcher({ jobs, readRun: vi.fn(), etlAvailable, onRunsFinished: () => {}, log: () => {} });
    await instance.tick();
    expect(etlAvailable).not.toHaveBeenCalled();
  });

  it('maps run results to outcomes', () => {
    expect(outcomeFromReadRun({ ok: false, code: 'alive_handoff', remoteStatus: 'WAITING_FOR_RESOURCES' })).toBe('pending');
    expect(outcomeFromReadRun({ ok: false, code: 'remote_failed', remoteStatus: 'DELETED', error: 'gone' })).toEqual({ remoteStatus: 'DELETED', error: 'gone' });
    expect(outcomeFromReadRun({ ok: false, code: 'download_failed', remoteStatus: 'SUCCESS' })).toBe('download_failed');
  });
});
