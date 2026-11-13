import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createStorage, type StorageLayer } from './storage.js';
import {
  CHAT_JOB_FOLDED_REASON,
  CHAT_JOB_IDLE_MS,
  chatJobPhase,
  createChatJobStore,
  decideTurnSettlement,
  formatChatJobBlock,
  formatJobsList,
  jobCardMarker,
  recordToolOutcome,
  withJobCards,
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

  it('runs many jobs at once (PJ1): start never ends another, each gets the next number, and both keep their watches', () => {
    const first = jobs.start({ goal: 'Build the PV player transition dashboard' });
    expect(first.id).toMatch(/^cj_[a-f0-9]{24}$/);
    expect(first).toMatchObject({ seq: 1, title: 'Build the PV player transition dashboard' });
    jobs.addWatch({ runId: '1001', jobId: first.id, source: 'run_query', purpose: 'weekly players' });

    const second = jobs.start({ goal: 'A new request', title: 'New request', modelKey: 'team.sol', thinking: 'high' });
    expect(second).toMatchObject({ seq: 2, title: 'New request', modelKey: 'team.sol', thinking: 'high', continuationCount: 0 });
    expect(jobs.get(first.id)).toMatchObject({ status: 'active' });
    expect(jobs.activeJobs().map(job => job.seq)).toEqual([1, 2]);
    expect(jobs.watch('1001')).toMatchObject({ status: 'pending', jobId: first.id });
    expect(jobs.pendingWatches().map(watch => watch.runId)).toEqual(['1001']);
    expect(jobs.bySeq(2)?.id).toBe(second.id);
    expect(jobs.bySeq(0)).toBeNull();
    expect(jobs.bySeq(9)).toBeNull();
    // Numbers keep counting after a job ends; they are never reused.
    jobs.end(first.id, 'done', 'built');
    expect(jobs.start({ goal: 'third' }).seq).toBe(3);
    expect(jobs.recentlyEnded(new Date(Date.now() - 60_000).toISOString()).map(job => job.id)).toEqual([first.id]);
  });

  it('a provisional job (an ETL run inside a main chat turn) has no number until it surfaces, and a folded one is never listed', () => {
    const held = jobs.start({ goal: 'how many downloads last week', provisional: true });
    expect(held.seq).toBe(0);
    const numbered = jobs.start({ goal: 'a real job' });
    expect(numbered.seq).toBe(1);
    expect(jobs.surface(held.id)?.seq).toBe(2);
    expect(jobs.surface(held.id)?.seq).toBe(2); // idempotent
    const folded = jobs.start({ goal: 'answered in the turn', provisional: true });
    jobs.end(folded.id, 'done', 'answered in the main chat');
    expect(jobs.recentlyEnded(new Date(Date.now() - 60_000).toISOString()).map(job => job.id)).not.toContain(folded.id);
  });

  it('numbers the jobs still active when a store from before numbers opens, in the order they started', () => {
    const db = storage.getDb();
    const a = jobs.start({ goal: 'older' });
    const b = jobs.start({ goal: 'newer' });
    db.prepare('UPDATE chat_jobs SET seq = NULL').run();
    db.prepare("UPDATE chat_jobs SET created_at = '2026-10-01T00:00:00Z' WHERE id = ?").run(b.id);
    const reopened = createChatJobStore(db);
    expect(reopened.get(b.id)?.seq).toBe(1);
    expect(reopened.get(a.id)?.seq).toBe(2);
  });

  it('a follow-up reopens an ended job with a fresh count; the owner can pause one; a hand-off makes its first turn due', () => {
    const job = jobs.start({ goal: 'g' });
    jobs.incrementContinuations(job.id);
    jobs.end(job.id, 'done', 'ok');
    expect(jobs.reopen(job.id)).toMatchObject({ status: 'active', continuationCount: 0, seq: job.seq });
    expect(jobs.get(job.id)?.endedAt).toBeUndefined();
    expect(jobs.requestTurn(job.id, 'handed off')).toMatchObject({ continueReason: 'handed off', continueRequestedAt: expect.any(String) });
    const paused = jobs.pauseByOwner(job.id);
    expect(paused).toMatchObject({ pauseKind: 'paused', pausedAt: expect.any(String) });
    expect(paused?.continueRequestedAt).toBeUndefined();
    jobs.end(job.id, 'stopped', 'stopped by the owner');
    expect(jobs.requestTurn(job.id, 'x')).toBeNull();
    expect(jobs.pauseByOwner(job.id)).toBeNull();
  });

  it('a job keeps one thread session, and its title can be renamed', () => {
    const job = jobs.start({ goal: 'Can you please study how Local offline usage changes as the customer base shrinks?' });
    expect(job.title).toBe('Study how Local offline usage changes');
    jobs.setSession(job.id, 'sess-1');
    jobs.setSession(job.id, 'sess-2'); // never rebinds
    expect(jobs.get(job.id)?.sessionId).toBe('sess-1');
    jobs.update(job.id, { title: 'Local offline study' });
    expect(jobs.get(job.id)?.title).toBe('Local offline study');
  });

  it('the first boot with numbers numbers active jobs and jobs that ended in the last 12 hours (so #N reopens them), never older ones', () => {
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE chat_jobs (
      id TEXT PRIMARY KEY CHECK(id GLOB 'cj_[a-f0-9]*' AND length(id) = 27), goal TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('active','done','stopped','expired','blocked')), model_key TEXT, thinking TEXT NOT NULL DEFAULT 'off',
      working_set_json TEXT NOT NULL DEFAULT '{}', continuation_count INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL,
      last_activity_at TEXT NOT NULL, ended_at TEXT, end_reason TEXT)`);
    const ago = (hours: number) => new Date(Date.now() - hours * 3600_000).toISOString();
    const insert = db.prepare('INSERT INTO chat_jobs (id, goal, status, created_at, last_activity_at, ended_at, end_reason) VALUES (?, ?, ?, ?, ?, ?, ?)');
    const [running, stopped, old] = ['a', 'b', 'c'].map(ch => `cj_${ch.repeat(24)}`);
    insert.run(old, 'an old finished job', 'done', ago(80), ago(72), ago(72), 'done');
    insert.run(running, 'a running job', 'active', ago(20), ago(1), null, null);
    insert.run(stopped, 'Continue the offline study', 'stopped', ago(18), ago(0.5), ago(0.5), 'stopped by the owner');
    const store = createChatJobStore(db);
    expect([running, stopped, old].map(id => store.get(id)!.seq)).toEqual([1, 2, 0]);
    expect(store.recentlyEnded(ago(12)).map(job => job.id)).toEqual([stopped]);
    expect(store.bySeq(2)?.id).toBe(stopped);
    expect(store.reopen(stopped)).toMatchObject({ status: 'active', seq: 2 });
    // Later boots number active jobs only: a provisional job folded away before a restart stays unseen.
    const folded = store.start({ goal: 'how many downloads', provisional: true });
    store.end(folded.id, 'done', CHAT_JOB_FOLDED_REASON);
    const again = createChatJobStore(db);
    expect(again.get(folded.id)!.seq).toBe(0);
    expect(again.get(old)!.seq).toBe(0);
    expect(again.activeJobs().map(job => job.seq)).toEqual([1, 2]);
    db.close();
  });

  it('a title cut at six words never ends on a joining word (the owner\'s live job read "… analysis using")', () => {
    const title = (goal: string) => jobs.start({ goal }).title;
    expect(title('Continue Local offline longitudinal analysis using restored SQL connection without sampling')).toBe('Continue Local offline longitudinal analysis');
    expect(title('Compare the weekly plays of the top shows')).toBe('Compare the weekly plays');
    expect(title('Draft and send the release note')).toBe('Draft and send the release note');
    expect(title('the')).toBe('The');
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
    // Owner requests 2026-10-22: a job reads, edits and saves BotBoy documents and clicks in the browser in its automatic turns.
    expect(continuation).toContain('BotBoy dashboards, BotBoy documents: read, edit and save, browser clicks and typing on the tabs you open, Google files and the owner\'s own calendar events: create, edit, upload, download and organize, files, checks');
    // Owner request 2026-10-23 (google-workspace.md): sharing and invites stay the owner's.
    expect(continuation).toContain('Tools that send, post, publish, share, invite, sync, schedule, or change production return outside_job_mandate here');
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

describe('the main chat\'s JOBS list (formatJobsList) and job cards', () => {
  let storage: StorageLayer;
  let jobs: ChatJobStore;
  beforeEach(() => {
    storage = createStorage(':memory:');
    storage.initialize();
    jobs = createChatJobStore(storage.getDb());
  });
  afterEach(() => storage.close());

  it('lists running jobs by number with what they do, recent finishes with their summary, and never a provisional job', () => {
    const study = jobs.start({ goal: 'g1', title: 'Local offline study', modelKey: 'anthropic.sonnet' });
    const note = jobs.start({ goal: 'g2', title: 'Release note' });
    jobs.declare(note.id, 'needs_owner', 'Short or long?', ['Short', 'Long']);
    jobs.settle(note.id, { action: 'pause', note: 'Short or long?', kind: 'question' }, 'answered');
    const held = jobs.start({ goal: 'g3', provisional: true });
    const finished = jobs.start({ goal: 'g4', title: 'Downloads refresh' });
    jobs.end(finished.id, 'done', 'All six widgets refreshed');
    const block = formatJobsList(
      [study, jobs.get(note.id)!, held].map(job => ({ job: jobs.get(job.id)!, phase: chatJobPhase(jobs.get(job.id)!, { running: job.id === study.id, pendingRuns: 0 }) })),
      { modelTitle: key => (key === 'anthropic.sonnet' ? 'Claude Sonnet' : 'GPT-6.1 Sol'), recent: [jobs.get(finished.id)!] },
    )!;
    expect(block).toContain(`- #${study.seq} Local offline study — working now (Claude Sonnet)`);
    expect(block).toContain(`- #${note.seq} Release note — waiting for the owner's answer: "Short or long?" (GPT-6.1 Sol)`);
    expect(block).toContain(`- #${finished.seq} Downloads refresh — done: All six widgets refreshed`);
    expect(block).not.toContain('g3');
    expect(block.split('\n').length).toBeLessThan(10);
    expect(formatJobsList([], { recent: [] })).toBeUndefined();
  });

  it('a job phase reads what runs: a provider wait, a question, a stuck job, waiting runs', () => {
    const job = jobs.start({ goal: 'g' });
    const nowMs = Date.parse('2026-10-28T10:00:00.000Z');
    jobs.settle(job.id, { action: 'continue', reason: 'r', notBefore: '2026-10-28T10:01:00.000Z' }, 'rate_limited');
    expect(chatJobPhase(jobs.get(job.id)!, { running: false, pendingRuns: 0, nowMs })).toBe('provider_wait');
    expect(chatJobPhase(jobs.get(job.id)!, { running: false, pendingRuns: 0, nowMs: nowMs + 120_000 })).toBe('continuing');
    expect(chatJobPhase(jobs.get(job.id)!, { running: true, pendingRuns: 0, nowMs })).toBe('working');
    jobs.settle(job.id, { action: 'pause', note: 'n', kind: 'stuck' }, 'repeat_breaker');
    expect(chatJobPhase(jobs.get(job.id)!, { running: false, pendingRuns: 0 })).toBe('stuck');
    jobs.settle(job.id, { action: 'wait' }, 'answered');
    expect(chatJobPhase(jobs.get(job.id)!, { running: false, pendingRuns: 2 })).toBe('waiting');
  });

  it('a card is a marker the panel draws from live state, added once', () => {
    expect(jobCardMarker('cj_x', 'started')).toBe('[[job:cj_x:started]]');
    expect(withJobCards('On it.', ['cj_x', 'cj_x'], 'started')).toBe('On it.\n\n[[job:cj_x:started]]');
    expect(withJobCards('On it.\n\n[[job:cj_x:started]]', ['cj_x'], 'started')).toBe('On it.\n\n[[job:cj_x:started]]');
    expect(withJobCards('x', [], 'done')).toBe('x');
  });
});

describe('end-of-turn settlement (decideTurnSettlement)', () => {
  const base = { pendingRuns: 0, undeclaredEnds: 0, failedTurns: 0 } as const;
  it('a declaration decides an answered turn', () => {
    expect(decideTurnSettlement({ ...base, end: 'answered', declaration: 'continue', declarationNote: 'Build widgets' })).toEqual({ action: 'continue', reason: 'Build widgets' });
    expect(decideTurnSettlement({ ...base, end: 'answered', declaration: 'needs_owner', declarationNote: 'Which cohort?' })).toEqual({ action: 'pause', note: 'Which cohort?', kind: 'question' });
    // Something the job waits for is still pending: "continue" waits for it instead of spending turns checking on it (job #5
    // asked for an export's status in 25 turns, 2026-11-12). Work that does not need it belongs in the same turn.
    expect(decideTurnSettlement({ ...base, end: 'answered', declaration: 'continue', pendingRuns: 2 })).toEqual({ action: 'wait' });
  });
  it('no declaration: wait on runs, else continue once, then pause with the reply', () => {
    expect(decideTurnSettlement({ ...base, end: 'answered', pendingRuns: 1 })).toEqual({ action: 'wait' });
    expect(decideTurnSettlement({ ...base, end: 'answered' })).toMatchObject({ action: 'continue', undeclared: true });
    expect(decideTurnSettlement({ ...base, end: 'answered', undeclaredEnds: 1, replyExcerpt: 'Next I build it.' })).toEqual({ action: 'pause', note: 'Next I build it.', kind: 'stuck' });
    // A reply that ends on a question is the owner's to answer, not a stuck job.
    expect(decideTurnSettlement({ ...base, end: 'answered', undeclaredEnds: 1, replyExcerpt: 'Short or long?' })).toMatchObject({ kind: 'question' });
  });
  it('a provider limit is a wait in line, never a failure (PJ2)', () => {
    expect(decideTurnSettlement({ ...base, end: 'rate_limited', rateWaitUntil: '2026-10-28T10:00:00.000Z' }))
      .toMatchObject({ action: 'continue', notBefore: '2026-10-28T10:00:00.000Z' });
    // Even after failures, and even with a pending run: the job carries on when the provider is ready.
    expect(decideTurnSettlement({ ...base, end: 'rate_limited', failedTurns: 3, pendingRuns: 1 }).action).toBe('continue');
  });
  it('repeated failures and the repeat breaker pause as stuck; Stop and a model change pause plainly', () => {
    expect(decideTurnSettlement({ ...base, end: 'failed', failedTurns: 1 })).toMatchObject({ kind: 'stuck' });
    expect(decideTurnSettlement({ ...base, end: 'repeat_breaker' })).toMatchObject({ kind: 'stuck' });
    expect(decideTurnSettlement({ ...base, end: 'owner_stopped' })).toMatchObject({ kind: 'paused' });
    expect(decideTurnSettlement({ ...base, end: 'provider_changed' })).toMatchObject({ kind: 'paused' });
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
    expect(jobs.recentlyEnded(new Date(Date.now() - 60_000).toISOString())[0]?.id).toBe(job.id);
  });

  it('a question keeps its one-tap answers until the job moves on; any other pause offers none', () => {
    const job = jobs.start({ goal: 'g' });
    jobs.declare(job.id, 'needs_owner', 'Short or long?', ['Short', ' Long ', 'short', 'x'.repeat(60), 'A', 'B']);
    jobs.settle(job.id, { action: 'pause', note: 'Short or long?', kind: 'question' }, 'answered');
    expect(jobs.get(job.id)).toMatchObject({ pauseKind: 'question', options: ['Short', 'Long', 'x'.repeat(40), 'A'] });
    jobs.ownerResumed(job.id);
    expect(jobs.get(job.id)?.options).toBeUndefined();
    jobs.declare(job.id, 'needs_owner', 'Which?', ['One', 'Two']);
    jobs.settle(job.id, { action: 'pause', note: 'Two failures', kind: 'stuck' }, 'failed');
    expect(jobs.get(job.id)).toMatchObject({ pauseKind: 'stuck' });
    expect(jobs.get(job.id)?.options).toBeUndefined();
  });

  it('a provider wait is kept on the job until its next settle', () => {
    const job = jobs.start({ goal: 'g' });
    jobs.settle(job.id, { action: 'continue', reason: 'slow down', notBefore: '2026-10-28T10:00:00.000Z' }, 'rate_limited');
    expect(jobs.get(job.id)).toMatchObject({ rateWaitUntil: '2026-10-28T10:00:00.000Z', continueRequestedAt: expect.any(String) });
    jobs.settle(job.id, { action: 'wait' }, 'answered');
    expect(jobs.get(job.id)?.rateWaitUntil).toBeUndefined();
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
    // The job active before threads gets #1 and a title from its goal.
    expect(upgraded.activeJobs()[0]).toMatchObject({ id: 'cj_aaaaaaaaaaaaaaaaaaaaaaaa', seq: 1, title: 'Old', undeclaredEnds: 0, failedTurns: 0 });
    upgraded.settle('cj_aaaaaaaaaaaaaaaaaaaaaaaa', { action: 'pause', note: 'n' }, 'answered');
    expect(upgraded.get('cj_aaaaaaaaaaaaaaaaaaaaaaaa')).toMatchObject({ pauseNote: 'n', pauseKind: 'paused' });
  });
});
