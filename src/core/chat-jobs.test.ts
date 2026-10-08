import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createStorage, type StorageLayer } from './storage.js';
import {
  CHAT_JOB_IDLE_MS,
  createChatJobStore,
  decideTurnSettlement,
  formatChatJobBlock,
  recordToolOutcome,
  workspaceRelativePath,
  type ChatJobStore,
} from './chat-jobs.js';

/**
 * Owner jobs and their watched ETL runs (ANALYTICS_AUTONOMY_PLAN.md D1/D2).
 * The store is the authority continuation turns act under, so its lifecycle
 * rules are pinned here: one active job, ended jobs stop watching, a watch
 * is consumed once, idle jobs expire.
 */
describe('chat job store', () => {
  let storage: StorageLayer;
  let jobs: ChatJobStore;
  beforeEach(() => {
    storage = createStorage(':memory:');
    storage.initialize();
    jobs = createChatJobStore(storage.getDb());
  });
  afterEach(() => storage.close());

  it('keeps one active job: ensureActive reuses it, start replaces it and abandons its watches', () => {
    const first = jobs.ensureActive({ goal: 'Build the PV player transition dashboard' });
    expect(first.id).toMatch(/^cj_[a-f0-9]{24}$/);
    expect(jobs.ensureActive({ goal: 'something else' }).id).toBe(first.id);
    jobs.addWatch({ runId: '1001', jobId: first.id, source: 'run_query', purpose: 'weekly players' });

    const second = jobs.start({ goal: 'A new request', modelKey: 'team.sol', thinking: 'high' });
    expect(second.id).not.toBe(first.id);
    expect(jobs.activeJob()?.id).toBe(second.id);
    expect(jobs.get(first.id)).toMatchObject({ status: 'done', endReason: 'replaced by a new job' });
    expect(jobs.watch('1001')).toMatchObject({ status: 'abandoned', jobId: first.id });
    expect(jobs.pendingWatches()).toEqual([]);
    expect(second).toMatchObject({ modelKey: 'team.sol', thinking: 'high', continuationCount: 0 });
  });

  it('records the owner turn model and thinking (D4) and ignores an ended job', () => {
    const job = jobs.start({ goal: 'goal' });
    jobs.touch(job.id, { modelKey: 'openai.gpt-5', thinking: 'max' });
    expect(jobs.get(job.id)).toMatchObject({ modelKey: 'openai.gpt-5', thinking: 'max' });
    jobs.touch(job.id, { modelKey: '' });
    expect(jobs.get(job.id)?.modelKey).toBeUndefined();
    jobs.end(job.id, 'stopped', 'stopped by the owner');
    jobs.touch(job.id, { thinking: 'low' });
    expect(jobs.get(job.id)).toMatchObject({ status: 'stopped', thinking: 'max', endReason: 'stopped by the owner' });
  });

  it('a watch is finished and consumed once; only unconsumed finished runs ask for a continuation', () => {
    const job = jobs.start({ goal: 'goal' });
    jobs.addWatch({ runId: '2001', jobId: job.id, source: 'run_query' });
    jobs.addWatch({ runId: '2002', jobId: job.id, source: 'wait' });
    expect(() => jobs.addWatch({ runId: 'r-1', jobId: job.id, source: 'wait' })).toThrow(/numeric/);
    expect(jobs.pendingWatches().map(watch => watch.runId)).toEqual(['2001', '2002']);

    jobs.markPolled('2001', { remoteStatus: 'EXECUTING' });
    expect(jobs.watch('2001')).toMatchObject({ status: 'pending', remoteStatus: 'EXECUTING', pollFailures: 0 });
    jobs.finishWatch('2001', { remoteStatus: 'SUCCESS', savedTo: '/x/adhoc_2001.tsv', rowCount: 12, columns: ['week', 'players'] });
    // A second finish (the watcher racing an in-turn wait) changes nothing.
    jobs.finishWatch('2001', { remoteStatus: 'ERROR', error: 'late' });
    expect(jobs.watch('2001')).toMatchObject({ status: 'finished', outcome: { remoteStatus: 'SUCCESS', rowCount: 12 } });
    expect(jobs.unconsumedFinished(job.id).map(watch => watch.runId)).toEqual(['2001']);
    jobs.consumeWatch('2001');
    expect(jobs.unconsumedFinished(job.id)).toEqual([]);
    expect(jobs.isJobRun(job.id, '2002')).toBe(true);
    expect(jobs.isJobRun(job.id, '9999')).toBe(false);
  });

  it('a run abandoned with an ended job is adopted by the job that watches it again', () => {
    const old = jobs.start({ goal: 'old' });
    jobs.addWatch({ runId: '3001', jobId: old.id, source: 'run_query' });
    jobs.markPolled('3001', { failed: true });
    jobs.end(old.id, 'stopped', 'owner');
    const current = jobs.start({ goal: 'current' });
    jobs.addWatch({ runId: '3001', jobId: current.id, source: 'wait' });
    expect(jobs.watch('3001')).toMatchObject({ jobId: current.id, status: 'pending', pollFailures: 0 });
    // A live watch keeps the job that first watched it.
    jobs.addWatch({ runId: '3001', jobId: old.id, source: 'wait', purpose: 'late purpose' });
    expect(jobs.watch('3001')).toMatchObject({ jobId: current.id, status: 'pending', purpose: 'late purpose' });
  });

  it('expires a job idle for 24 hours and stops watching its runs', () => {
    const job = jobs.start({ goal: 'goal' });
    jobs.addWatch({ runId: '4001', jobId: job.id, source: 'run_query' });
    expect(jobs.expireIdle(Date.now() + CHAT_JOB_IDLE_MS - 60_000)).toEqual([]);
    expect(jobs.expireIdle(Date.now() + CHAT_JOB_IDLE_MS + 60_000)).toEqual([job.id]);
    expect(jobs.get(job.id)).toMatchObject({ status: 'expired' });
    expect(jobs.watch('4001')?.status).toBe('abandoned');
  });

  it('adds the rescue column to a watch table from the first build', () => {
    const db = storage.getDb();
    db.exec('DROP TABLE etl_run_watches');
    db.exec(`CREATE TABLE etl_run_watches (
      run_id TEXT PRIMARY KEY, job_id TEXT NOT NULL, purpose TEXT, source TEXT NOT NULL, status TEXT NOT NULL,
      remote_status TEXT, submitted_at TEXT NOT NULL, last_polled_at TEXT, finished_at TEXT, outcome_json TEXT,
      consumed_at TEXT, poll_failures INTEGER NOT NULL DEFAULT 0)`);
    const upgraded = createChatJobStore(db);
    const job = upgraded.start({ goal: 'g' });
    upgraded.addWatch({ runId: '701', jobId: job.id, source: 'run_query' });
    expect(upgraded.markPrioritized('701')).toBe(true);
    expect(upgraded.watch('701')?.prioritizedAt).toEqual(expect.any(String));
  });

  it('bumps its version on every change the chat panel shows', () => {
    const before = jobs.version();
    const job = jobs.start({ goal: 'goal' });
    jobs.addWatch({ runId: '5001', jobId: job.id, source: 'run_query' });
    jobs.finishWatch('5001', { remoteStatus: 'SUCCESS' });
    expect(jobs.version()).toBeGreaterThanOrEqual(before + 3);
  });

  it('keeps the working set bounded and current', () => {
    const job = jobs.start({ goal: 'goal' });
    jobs.update(job.id, { nextStep: 'Import the weekly file', notes: ['Default: IST weeks', 'Default: IST weeks'] });
    for (let index = 0; index < 30; index++) jobs.recordFile(job.id, `/f/${index}.tsv`);
    const set = jobs.get(job.id)!.workingSet;
    expect(set.nextStep).toBe('Import the weekly file');
    expect(set.notes).toEqual(['Default: IST weeks']);
    expect(set.files).toHaveLength(20);
    expect(set.files.at(-1)?.path).toBe('/f/29.tsv');
  });
});

describe('job block and tool outcomes', () => {
  let storage: StorageLayer;
  let jobs: ChatJobStore;
  beforeEach(() => {
    storage = createStorage(':memory:');
    storage.initialize();
    jobs = createChatJobStore(storage.getDb());
  });
  afterEach(() => storage.close());

  it('the job block names the goal, the mandate, the runs, and the working set', () => {
    const job = jobs.start({ goal: 'Weekly PV player transitions for Local & OTT' });
    jobs.addWatch({ runId: '6001', jobId: job.id, source: 'run_query', purpose: 'Local weekly players' });
    jobs.addWatch({ runId: '6002', jobId: job.id, source: 'run_query' });
    jobs.finishWatch('6001', { remoteStatus: 'SUCCESS', savedTo: '/files/etl-results/adhoc_6001.tsv', rowCount: 52, columns: ['week', 'players'] });
    jobs.update(job.id, { nextStep: 'Join both lanes', notes: ['Counting key: customer_id'] });
    jobs.recordDashboard(job.id, { dashboardId: 'dash_abc', title: 'PV transitions' });

    const owner = formatChatJobBlock(jobs.get(job.id)!, jobs.watchesForJob(job.id));
    expect(owner).toContain('## ACTIVE JOB');
    expect(owner).toContain('"Weekly PV player transitions for Local & OTT"');
    expect(owner).toContain('a short "check", "continue", or "go ahead" means resume the job');
    expect(owner).toContain('6001 (Local weekly players): SUCCESS — 52 rows, 2 columns');
    expect(owner).toContain('6002: running');
    expect(owner).toContain('Next step (your note): Join both lanes');
    expect(owner).toContain('dash_abc — PV transitions');

    const continuation = formatChatJobBlock(jobs.get(job.id)!, jobs.watchesForJob(job.id), { continuation: true });
    expect(continuation).toContain('AUTOMATIC CONTINUATION');
    expect(continuation).toContain('outside_job_mandate');
    expect(continuation.length).toBeLessThanOrEqual(4_500);
  });

  it('records downloaded files, Data Room jobs/datasets, and dashboards from tool results', () => {
    const job = jobs.start({ goal: 'goal' });
    const envelope = (value: unknown) => JSON.stringify({ trust: 'external_untrusted_data', result: JSON.stringify(value) });
    recordToolOutcome(jobs, job.id, 'mcp_etl_download_results', '{"runId":"7001"}', envelope({ runId: '7001', savedTo: '/files/etl-results/run_7001.tsv' }));
    recordToolOutcome(jobs, job.id, 'mcp_etl_run_query', '{}', JSON.stringify({ ok: true, runId: '7002', savedTo: '/files/etl-results/adhoc_7002.tsv' }));
    recordToolOutcome(jobs, job.id, 'create_data_room_dataset', '{"action":"create"}', JSON.stringify({ jobId: `aj_${'a'.repeat(32)}`, status: 'in_progress' }));
    recordToolOutcome(jobs, job.id, 'create_data_room_dataset', '{"action":"inspect_local_file"}', JSON.stringify({ datasetId: 'ds_ignored' }));
    recordToolOutcome(jobs, job.id, 'create_analytics_dashboard', '{}', JSON.stringify({ ok: true, dashboard: { id: 'dash_x', title: 'X' } }));
    recordToolOutcome(jobs, job.id, 'edit_analytics_dashboard', '{"dashboardId":"dash_x"}', JSON.stringify({ status: 'completed' }));
    recordToolOutcome(jobs, job.id, 'query_db', '{}', 'not json');
    const set = jobs.get(job.id)!.workingSet;
    expect(set.files.map(file => file.path)).toEqual(['/files/etl-results/run_7001.tsv', '/files/etl-results/adhoc_7002.tsv']);
    expect(set.datasets).toEqual([expect.objectContaining({ jobId: `aj_${'a'.repeat(32)}` })]);
    expect(set.dashboards).toEqual([expect.objectContaining({ dashboardId: 'dash_x', title: 'X' })]);
  });

  it('shows files-workspace paths relative to the workspace', () => {
    expect(workspaceRelativePath('/h/.ppt/files/etl-results/a.tsv', '/h/.ppt/files')).toBe('etl-results/a.tsv');
    expect(workspaceRelativePath('/elsewhere/a.tsv', '/h/.ppt/files')).toBe('/elsewhere/a.tsv');
  });
});

describe('end-of-turn settlement (decideTurnSettlement)', () => {
  const base = { pendingRuns: 0, undeclaredEnds: 0, failedTurns: 0 } as const;
  it('a declaration decides an answered turn', () => {
    expect(decideTurnSettlement({ ...base, end: 'answered', declaration: 'continue', declarationNote: 'Build widgets' })).toEqual({ action: 'continue', reason: 'Build widgets' });
    expect(decideTurnSettlement({ ...base, end: 'answered', declaration: 'needs_owner', declarationNote: 'Which cohort?' })).toEqual({ action: 'pause', note: 'Which cohort?' });
    // continue wins over waiting on runs: there is work to do now.
    expect(decideTurnSettlement({ ...base, end: 'answered', declaration: 'continue', pendingRuns: 2 }).action).toBe('continue');
  });
  it('no declaration: wait on runs, else continue once, then pause with the reply', () => {
    expect(decideTurnSettlement({ ...base, end: 'answered', pendingRuns: 1 })).toEqual({ action: 'wait' });
    expect(decideTurnSettlement({ ...base, end: 'answered' })).toMatchObject({ action: 'continue', undeclared: true });
    expect(decideTurnSettlement({ ...base, end: 'answered', undeclaredEnds: 1, replyExcerpt: 'Next I build it.' })).toEqual({ action: 'pause', note: 'Next I build it.' });
  });
  it('cut-off turns continue; loops, Stop, and model changes pause; owner steering does nothing', () => {
    expect(decideTurnSettlement({ ...base, end: 'ceiling' }).action).toBe('continue');
    expect(decideTurnSettlement({ ...base, end: 'shutdown' }).action).toBe('continue');
    expect(decideTurnSettlement({ ...base, end: 'failed' }).action).toBe('continue');
    expect(decideTurnSettlement({ ...base, end: 'failed', failedTurns: 1 }).action).toBe('pause');
    expect(decideTurnSettlement({ ...base, end: 'repeat_breaker', declaration: 'continue' }).action).toBe('pause');
    expect(decideTurnSettlement({ ...base, end: 'owner_stopped' }).action).toBe('pause');
    expect(decideTurnSettlement({ ...base, end: 'provider_changed' }).action).toBe('pause');
    expect(decideTurnSettlement({ ...base, end: 'disconnected', pendingRuns: 1 })).toEqual({ action: 'wait' });
    expect(decideTurnSettlement({ ...base, end: 'preempted' })).toEqual({ action: 'none' });
    expect(decideTurnSettlement({ ...base, end: 'job_stopped' })).toEqual({ action: 'none' });
  });
});

describe('chat job settle state', () => {
  let storage: StorageLayer;
  let jobs: ChatJobStore;
  beforeEach(() => {
    storage = createStorage(':memory:');
    storage.initialize();
    jobs = createChatJobStore(storage.getDb());
  });
  afterEach(() => storage.close());

  it('declare → settle → owner reply moves between continue, paused, and clear', () => {
    const job = jobs.start({ goal: 'g' });
    expect(jobs.declare(job.id, 'needs_owner', 'Which cohort?')).toMatchObject({ declaration: 'needs_owner', pauseNote: 'Which cohort?' });
    jobs.settle(job.id, { action: 'pause', note: 'Which cohort?' }, 'answered');
    expect(jobs.get(job.id)).toMatchObject({ pauseNote: 'Which cohort?', pausedAt: expect.any(String) });
    expect(jobs.get(job.id)?.declaration).toBeUndefined();
    jobs.settle(job.id, { action: 'continue', reason: 'r', undeclared: true }, 'answered');
    expect(jobs.get(job.id)).toMatchObject({ continueReason: 'r', undeclaredEnds: 1 });
    expect(jobs.get(job.id)?.pausedAt).toBeUndefined();
    jobs.incrementContinuations(job.id);
    jobs.settle(job.id, { action: 'continue', reason: 'failed' }, 'failed');
    expect(jobs.get(job.id)).toMatchObject({ failedTurns: 1, undeclaredEnds: 1 });
    jobs.ownerResumed(job.id);
    expect(jobs.get(job.id)).toMatchObject({ failedTurns: 0, undeclaredEnds: 0, continuationCount: 0 });
    expect(jobs.get(job.id)?.continueRequestedAt).toBeUndefined();
    // An ended job ignores settles.
    jobs.end(job.id, 'done', 'ok');
    jobs.settle(job.id, { action: 'continue', reason: 'x' }, 'answered');
    expect(jobs.get(job.id)?.continueRequestedAt).toBeUndefined();
    expect(jobs.lastEnded()?.id).toBe(job.id);
  });

  it('adds the settle columns to a table from the first build', () => {
    const db = storage.getDb();
    db.exec('DROP TABLE etl_run_watches; DROP TABLE chat_jobs;');
    db.exec(`CREATE TABLE chat_jobs (
      id TEXT PRIMARY KEY CHECK(id GLOB 'cj_[a-f0-9]*' AND length(id) = 27), goal TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('active','done','stopped','expired','blocked')), model_key TEXT,
      thinking TEXT NOT NULL DEFAULT 'off', working_set_json TEXT NOT NULL DEFAULT '{}',
      continuation_count INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, last_activity_at TEXT NOT NULL,
      ended_at TEXT, end_reason TEXT)`);
    db.prepare("INSERT INTO chat_jobs (id, goal, status, created_at, last_activity_at) VALUES ('cj_aaaaaaaaaaaaaaaaaaaaaaaa', 'old', 'active', '2026-10-08T00:00:00Z', '2026-10-08T00:00:00Z')").run();
    const upgraded = createChatJobStore(db);
    expect(upgraded.activeJob()).toMatchObject({ id: 'cj_aaaaaaaaaaaaaaaaaaaaaaaa', undeclaredEnds: 0, failedTurns: 0 });
    upgraded.settle('cj_aaaaaaaaaaaaaaaaaaaaaaaa', { action: 'pause', note: 'n' }, 'answered');
    expect(upgraded.activeJob()?.pauseNote).toBe('n');
  });
});
