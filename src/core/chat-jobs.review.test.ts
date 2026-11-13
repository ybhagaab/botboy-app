import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { createStorage, type StorageLayer } from './storage.js';
import {
  createChatJobStore,
  decideTurnSettlement,
  describeDashboardRefresh,
  formatChatJobBlock,
  JOB_CONTINUE_REASON,
  JOB_TOOL_TRAIL_MAX,
  type ChatJobStore,
} from './chat-jobs.js';

/**
 * The job row's side of the main chat's job updates (PARALLEL_JOBS_PLAN.md §12, owner decision 2026-11-09): each state is looked
 * at once, the main chat keeps a job going or asks the owner, and a job waits for its dashboard refreshes without spending turns.
 */
describe('job updates on the job row', () => {
  let storage: StorageLayer;
  let jobs: ChatJobStore;
  beforeEach(() => {
    storage = createStorage(':memory:');
    storage.initialize();
    jobs = createChatJobStore(storage.getDb());
  });
  afterEach(() => storage.close());

  it('each job state is looked at once: claimed, then decided or released; a restart releases every claim', () => {
    const job = jobs.start({ goal: 'g' });
    expect(jobs.claimReview(job.id, 'stuck:T1')).toBe(true);
    expect(jobs.claimReview(job.id, 'stuck:T1')).toBe(false);
    expect(jobs.get(job.id)).toMatchObject({ reviewKey: 'stuck:T1' });
    jobs.releaseReview(job.id, 'limit:T0'); // only its own claim
    expect(jobs.get(job.id)!.reviewKey).toBe('stuck:T1');
    jobs.releaseReview(job.id, 'stuck:T1');
    expect(jobs.get(job.id)!.reviewKey).toBeUndefined();
    expect(jobs.claimReview(job.id, 'stuck:T1')).toBe(true);
    jobs.finishReview(job.id, 'stuck:T1');
    expect(jobs.get(job.id)).toMatchObject({ reviewedKey: 'stuck:T1' });
    expect(jobs.get(job.id)!.reviewKey).toBeUndefined();
    expect(jobs.claimReview(job.id, 'stuck:T1')).toBe(false); // decided: never again
    expect(jobs.claimReview(job.id, 'limit:T2')).toBe(true); // a new state
    const other = jobs.start({ goal: 'h' });
    expect(jobs.claimReview(other.id, 'wait:T3:0')).toBe(true);
    expect(jobs.releaseAllReviews()).toBe(2);
    expect(jobs.get(job.id)!.reviewKey).toBeUndefined();
    expect(jobs.releaseAllReviews()).toBe(0);
    jobs.end(other.id, 'stopped', 'stopped by the owner');
    expect(jobs.claimReview(other.id, 'wait:T3:1')).toBe(false); // an ended job is never looked at
  });

  it('the main chat keeps a job going: its own look only over BotBoy\'s pauses, one round each; the owner\'s word over any', () => {
    const job = jobs.start({ goal: 'g' });
    expect(jobs.continueJob(job.id, { from: 'review' })).toBeNull(); // not paused: nothing to keep going
    for (let i = 0; i < 25; i++) jobs.incrementContinuations(job.id);
    jobs.settle(job.id, { action: 'pause', note: 'Paused after 25 automatic turns in a row.', kind: 'limit' }, 'answered');
    const kept = jobs.continueJob(job.id, { from: 'review' })!;
    expect(kept).toMatchObject({ continuationCount: 0, supervisions: 1, continueReason: JOB_CONTINUE_REASON, continueRequestedAt: expect.any(String) });
    expect(kept.pausedAt).toBeUndefined();
    // Stuck: a fresh retry, and the turn count stands.
    jobs.incrementContinuations(job.id);
    jobs.incrementContinuations(job.id);
    jobs.settle(job.id, { action: 'pause', note: 'repeating', kind: 'stuck' }, 'repeat_breaker');
    expect(jobs.continueJob(job.id, { from: 'review' })).toMatchObject({ continuationCount: 2, supervisions: 2, failedTurns: 0, undeclaredEnds: 0 });
    // A question waits for its answer, and a pause the owner made stays his.
    jobs.settle(job.id, { action: 'pause', note: 'Which month?', kind: 'question' }, 'answered');
    expect(jobs.continueJob(job.id, { from: 'review' })).toBeNull();
    jobs.pauseByOwner(job.id);
    expect(jobs.continueJob(job.id, { from: 'review' })).toBeNull();
    expect(jobs.get(job.id)!.supervisions).toBe(2);
    // The owner's word from the main chat: any pause clears and every count starts over.
    const owned = jobs.continueJob(job.id, { from: 'main_chat' })!;
    expect(owned).toMatchObject({ status: 'active', supervisions: 0, continuationCount: 0, failedTurns: 0, continueRequestedAt: expect.any(String) });
    expect(owned.pausedAt).toBeUndefined();
    // A turn already due: nothing to continue.
    expect(jobs.continueJob(job.id, { from: 'main_chat' })).toBeNull();
    // An ended job: the main chat's own look never reopens it; the owner's word does.
    jobs.end(job.id, 'done', 'finished');
    expect(jobs.continueJob(job.id, { from: 'review' })).toBeNull();
    expect(jobs.continueJob(job.id, { from: 'main_chat' })).toMatchObject({ status: 'active', continueRequestedAt: expect.any(String) });
    expect(jobs.continueJob('cj_000000000000000000000000', { from: 'main_chat' })).toBeNull();
  });

  it('the main chat\'s question pauses the job with one-tap answers, and that question is never an update about itself', () => {
    // Over a job that is not paused (a long wait): it pauses now.
    const waiting = jobs.start({ goal: 'g' });
    const asked = jobs.askOwner(waiting.id, '  Use the 2023 or the 2024 cohort?  ', ['Use 2023', 'Use 2024', 'use 2024'])!;
    expect(asked).toMatchObject({
      pauseKind: 'question', pauseNote: 'Use the 2023 or the 2024 cohort?', options: ['Use 2023', 'Use 2024'],
      pausedAt: expect.any(String), reviewedKey: `question:${asked.pausedAt}`,
    });
    expect(asked.continueRequestedAt).toBeUndefined();
    // Never over a question already asked, nor over a pause the owner made; an empty question asks nothing.
    expect(jobs.askOwner(waiting.id, 'Again?', [])).toBeNull();
    const owners = jobs.start({ goal: 'h' });
    jobs.pauseByOwner(owners.id);
    expect(jobs.askOwner(owners.id, 'Which disk?', ['A'])).toBeNull();
    const fresh = jobs.start({ goal: 'k' });
    expect(jobs.askOwner(fresh.id, '   ', ['A'])).toBeNull();
    jobs.end(fresh.id, 'done', 'finished');
    expect(jobs.askOwner(fresh.id, 'Which?', [])).toBeNull();
    // Over BotBoy's own pause it keeps the pause's time; when the turn that asked ends its look at the limit, the question stays
    // handled (finishReview never marks the old state over it).
    const limited = jobs.start({ goal: 'i' });
    jobs.settle(limited.id, { action: 'pause', note: 'Paused after 25 automatic turns in a row.', kind: 'limit' }, 'answered');
    const pausedAt = jobs.get(limited.id)!.pausedAt!;
    expect(jobs.claimReview(limited.id, `limit:${pausedAt}`)).toBe(true);
    expect(jobs.askOwner(limited.id, 'Keep going with March?', ['Yes', 'No'])).toMatchObject({ pausedAt, pauseKind: 'question' });
    jobs.finishReview(limited.id, `limit:${pausedAt}`);
    expect(jobs.get(limited.id)).toMatchObject({ reviewedKey: `question:${pausedAt}` });
    expect(jobs.get(limited.id)!.reviewKey).toBeUndefined();
    // A later state is marked as usual.
    jobs.ownerResumed(limited.id);
    jobs.finishReview(limited.id, 'wait:T:0');
    expect(jobs.get(limited.id)).toMatchObject({ reviewedKey: 'wait:T:0' });
  });

  it('a job waits for its dashboard refreshes like its ETL runs, and each job sees a refresh for itself', () => {
    const job = jobs.start({ goal: 'g' });
    const other = jobs.start({ goal: 'h' });
    expect(jobs.addDashboardWait({ runId: '12345', jobId: job.id, dashboardId: 'dash_1' })).toBeNull(); // not a refresh id
    expect(jobs.addDashboardWait({ runId: 'run_abd1cfcd40e545fe', jobId: job.id, dashboardId: ' ' })).toBeNull();
    const wait = jobs.addDashboardWait({ runId: 'run_abd1cfcd40e545fe', jobId: job.id, dashboardId: 'dash_38326feaa58f4933', title: 'Downloads' })!;
    expect(wait).toMatchObject({ source: 'dashboard', status: 'pending', dashboardId: 'dash_38326feaa58f4933', purpose: 'refresh of dashboard "Downloads"' });
    // Idempotent for one job; another job can wait for the same refresh.
    expect(jobs.addDashboardWait({ runId: 'run_abd1cfcd40e545fe', jobId: job.id, dashboardId: 'dash_38326feaa58f4933' })).toMatchObject({ submittedAt: wait.submittedAt });
    jobs.addDashboardWait({ runId: 'run_abd1cfcd40e545fe', jobId: other.id, dashboardId: 'dash_38326feaa58f4933' });
    jobs.addWatch({ runId: '987654', jobId: job.id, source: 'run_query' });
    expect(jobs.watchesForJob(job.id).map(entry => `${entry.runId}:${entry.source}`).sort()).toEqual(['987654:run_query', 'run_abd1cfcd40e545fe:dashboard']);
    expect(jobs.pendingWatches().filter(entry => entry.source === 'dashboard').map(entry => entry.jobId).sort()).toEqual([job.id, other.id].sort());
    // A refresh is never one of the job's ETL runs (mcp_etl_alter_run acts on those only).
    expect(jobs.isJobRun(job.id, 'run_abd1cfcd40e545fe')).toBe(false);
    expect(jobs.isJobRun(job.id, '987654')).toBe(true);
    // It ends for each job, and each job's turn consumes it for that job only.
    jobs.finishDashboardWait('run_abd1cfcd40e545fe', job.id, { remoteStatus: 'completed', widgetCount: 4, widgetsSucceeded: 3 });
    expect(jobs.unconsumedFinished(job.id)).toMatchObject([{ runId: 'run_abd1cfcd40e545fe', status: 'finished', outcome: { remoteStatus: 'completed', widgetCount: 4 } }]);
    expect(jobs.unconsumedFinished(other.id)).toEqual([]);
    jobs.finishDashboardWait('run_abd1cfcd40e545fe', other.id, { remoteStatus: 'failed', error: 'x'.repeat(2_000) });
    expect(jobs.unconsumedFinished(other.id)[0].outcome!.error).toHaveLength(800);
    jobs.consumeWatch('run_abd1cfcd40e545fe', job.id);
    expect(jobs.unconsumedFinished(job.id)).toEqual([]);
    expect(jobs.unconsumedFinished(other.id)).toHaveLength(1);
    // A finished wait is not reopened.
    jobs.addDashboardWait({ runId: 'run_abd1cfcd40e545fe', jobId: job.id, dashboardId: 'dash_38326feaa58f4933' });
    expect(jobs.watchesForJob(job.id).find(entry => entry.source === 'dashboard')).toMatchObject({ status: 'finished' });
    // A job that ends gives up its pending waits, and an ended job takes no new one.
    jobs.addDashboardWait({ runId: 'run_0000ffff', jobId: other.id, dashboardId: 'dash_2' });
    jobs.end(other.id, 'stopped', 'stopped by the owner');
    expect(jobs.watchesForJob(other.id).find(entry => entry.runId === 'run_0000ffff')).toMatchObject({ status: 'abandoned' });
    expect(jobs.pendingWatches().some(entry => entry.jobId === other.id)).toBe(false);
    expect(jobs.addDashboardWait({ runId: 'run_1111ffff', jobId: other.id, dashboardId: 'dash_2' })).toBeNull();
  });

  it('a finished refresh reads as its status and widgets, in the job block too', () => {
    expect(describeDashboardRefresh({ remoteStatus: 'completed', widgetCount: 4, widgetsSucceeded: 3 })).toBe('completed, 3 of 4 widgets loaded');
    expect(describeDashboardRefresh({ remoteStatus: 'failed', widgetCount: 1, widgetsSucceeded: 0, error: 'lane down' })).toBe('failed, 0 of 1 widget loaded — lane down');
    expect(describeDashboardRefresh(undefined)).toBe('finished');
    const job = jobs.start({ goal: 'g' });
    jobs.addDashboardWait({ runId: 'run_abd1cfcd40e545fe', jobId: job.id, dashboardId: 'dash_1', title: 'Downloads' });
    const block = formatChatJobBlock(jobs.get(job.id)!, jobs.watchesForJob(job.id));
    expect(block).toContain('What this job waits or waited for (ETL runs, refreshes of its dashboards, exports and other waits; BotBoy continues the job when a pending one ends):');
    expect(block).toContain('- run_abd1cfcd40e545fe (refresh of dashboard "Downloads"): running');
  });

  it('a turn that would continue while its dashboard refresh runs waits instead (no turn spent checking on it)', () => {
    const base = { end: 'answered' as const, pendingRuns: 1, pendingDashboardRuns: 1, undeclaredEnds: 0, failedTurns: 0 };
    expect(decideTurnSettlement({ ...base, declaration: 'continue', declarationNote: 'check the refresh' })).toEqual({ action: 'wait' });
    expect(decideTurnSettlement({ ...base, end: 'ceiling' })).toEqual({ action: 'wait' });
    expect(decideTurnSettlement({ ...base })).toEqual({ action: 'wait' });
    // A question or a finish still wins. "continue" waits for anything pending (a run too, docs/maps/job-waits.md), and with
    // nothing pending it continues as before; a turn cut off at the tool limit waits only for a dashboard refresh.
    expect(decideTurnSettlement({ ...base, declaration: 'needs_owner', declarationNote: 'Which?' })).toMatchObject({ action: 'pause', kind: 'question' });
    expect(decideTurnSettlement({ ...base, pendingDashboardRuns: 0, declaration: 'continue' })).toEqual({ action: 'wait' });
    expect(decideTurnSettlement({ ...base, pendingRuns: 0, pendingDashboardRuns: 0, declaration: 'continue' })).toMatchObject({ action: 'continue' });
    expect(decideTurnSettlement({ ...base, pendingDashboardRuns: 0, end: 'ceiling' })).toMatchObject({ action: 'continue' });
  });

  it('keeps the latest turn\'s tool calls, newest last and clipped', () => {
    const job = jobs.start({ goal: 'g' });
    const steps = Array.from({ length: JOB_TOOL_TRAIL_MAX + 3 }, (_, i) => ({ name: `tool_${i}`, args: 'a'.repeat(500), result: 'r'.repeat(2_000) }));
    jobs.recordTurnTools(job.id, [...steps, { name: '', args: '', result: '' }]);
    const kept = jobs.get(job.id)!.lastTools;
    expect(kept).toHaveLength(JOB_TOOL_TRAIL_MAX - 1); // the nameless step took a slot and was dropped
    expect(kept.at(-1)).toMatchObject({ name: `tool_${JOB_TOOL_TRAIL_MAX + 2}` });
    expect(kept[0].args).toHaveLength(400);
    expect(kept[0].result).toHaveLength(1_200);
    jobs.recordTurnTools(job.id, []);
    expect(jobs.get(job.id)!.lastTools).toEqual([]);
  });

  it('the first boot of §12 marks a job still paused at the turn limit as the limit\'s, not the owner\'s', () => {
    const db = new Database(':memory:');
    try {
      db.exec(`CREATE TABLE chat_jobs (id TEXT PRIMARY KEY, goal TEXT NOT NULL, status TEXT NOT NULL, model_key TEXT, thinking TEXT NOT NULL DEFAULT 'off',
        working_set_json TEXT NOT NULL DEFAULT '{}', continuation_count INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, last_activity_at TEXT NOT NULL,
        ended_at TEXT, end_reason TEXT, paused_at TEXT, pause_note TEXT, pause_kind TEXT)`);
      const insert = db.prepare(`INSERT INTO chat_jobs (id, goal, status, created_at, last_activity_at, paused_at, pause_note, pause_kind)
        VALUES (?, 'g', ?, '2026-11-09T02:00:00.000Z', '2026-11-09T03:00:00.000Z', '2026-11-09T03:00:00.000Z', ?, 'paused')`);
      insert.run('cj_aaaaaaaaaaaaaaaaaaaaaaaa', 'active', 'Paused after 25 automatic continuations in a row. Reply to continue.');
      insert.run('cj_bbbbbbbbbbbbbbbbbbbbbbbb', 'active', 'You paused this job. Resume it from its menu, or ask it here to carry on.');
      insert.run('cj_cccccccccccccccccccccccc', 'done', 'Paused after 25 automatic continuations in a row. Reply to continue.');
      const upgraded = createChatJobStore(db);
      expect(upgraded.get('cj_aaaaaaaaaaaaaaaaaaaaaaaa')).toMatchObject({ pauseKind: 'limit' });
      expect(upgraded.get('cj_bbbbbbbbbbbbbbbbbbbbbbbb')).toMatchObject({ pauseKind: 'paused' });
      expect((db.prepare("SELECT pause_kind FROM chat_jobs WHERE id = 'cj_cccccccccccccccccccccccc'").get() as any).pause_kind).toBe('paused');
      // Once only: a later boot leaves the owner's own kind alone, whatever the note says.
      db.prepare("UPDATE chat_jobs SET pause_kind = 'paused' WHERE id = 'cj_aaaaaaaaaaaaaaaaaaaaaaaa'").run();
      expect(createChatJobStore(db).get('cj_aaaaaaaaaaaaaaaaaaaaaaaa')).toMatchObject({ pauseKind: 'paused' });
    } finally {
      db.close();
    }
  });
});
