import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { createStorage, type StorageLayer } from './storage.js';
import {
  cleanNextSteps,
  createChatJobStore,
  formatChatJobBlock,
  formatJobsList,
  JOB_INBOX_MAX,
  JOB_MESSAGE_REASON,
  JOB_REPORT_CHARS,
  JOB_REVIEW_REASON,
  type ChatJobStore,
} from './chat-jobs.js';

/**
 * Reports and messages on the job row (PARALLEL_JOBS_PLAN.md §11, owner decisions 2026-11-08): a finished job's report is posted
 * once, and a message from the main chat waits for the job's next turn. The main chat's look at job updates (§12) has its own
 * file: chat-jobs.review.test.ts.
 */
describe('job reports and messages', () => {
  let storage: StorageLayer;
  let jobs: ChatJobStore;
  beforeEach(() => {
    storage = createStorage(':memory:');
    storage.initialize();
    jobs = createChatJobStore(storage.getDb());
  });
  afterEach(() => storage.close());

  it('a done job keeps its report and next steps, and is claimed for the main chat exactly once', () => {
    const job = jobs.start({ goal: 'Health check' });
    jobs.end(job.id, 'done', 'All connections checked', { nextSteps: ['Restore Outlook sync.', 'restore outlook sync', 'Clear the capture backlog', 'Retry SQL', 'A fourth'] });
    jobs.recordReport(job.id, '**Done.**\r\n\r\n\r\n- Outlook: not syncing   \n- SQL: degraded');
    expect(jobs.get(job.id)).toMatchObject({
      report: '**Done.**\n\n- Outlook: not syncing\n- SQL: degraded',
      nextSteps: ['Restore Outlook sync', 'Clear the capture backlog', 'Retry SQL'],
    });
    expect(jobs.unreportedEnded('2000-01-01T00:00:00.000Z').map(entry => entry.id)).toEqual([job.id]);
    expect(jobs.markReported(job.id)).toBe(true);
    expect(jobs.markReported(job.id)).toBe(false);
    expect(jobs.unreportedEnded('2000-01-01T00:00:00.000Z')).toEqual([]);
    jobs.recordReport(job.id, 'x'.repeat(JOB_REPORT_CHARS + 100));
    expect(jobs.get(job.id)!.report).toHaveLength(JOB_REPORT_CHARS);
  });

  it('only done and expired numbered jobs are reported; a stopped job, an active one and a provisional one are not', () => {
    const stopped = jobs.start({ goal: 'a' });
    jobs.end(stopped.id, 'stopped', 'stopped by the owner');
    const expired = jobs.start({ goal: 'b' });
    jobs.end(expired.id, 'expired', 'idle for 24 hours');
    const folded = jobs.start({ goal: 'c', provisional: true });
    jobs.end(folded.id, 'done', 'answered in the main chat');
    jobs.start({ goal: 'd' });
    expect(jobs.unreportedEnded('2000-01-01T00:00:00.000Z').map(job => job.id)).toEqual([expired.id]);
    // A report is only ever kept for a done job.
    jobs.recordReport(stopped.id, 'never');
    expect(jobs.get(stopped.id)!.report).toBeUndefined();
  });

  it('jobs that ended before reports existed count as reported on the upgrade', () => {
    const db = new Database(':memory:');
    try {
      db.exec(`CREATE TABLE chat_jobs (id TEXT PRIMARY KEY, goal TEXT NOT NULL, status TEXT NOT NULL, model_key TEXT, thinking TEXT NOT NULL DEFAULT 'off',
        working_set_json TEXT NOT NULL DEFAULT '{}', continuation_count INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, last_activity_at TEXT NOT NULL,
        ended_at TEXT, end_reason TEXT)`);
      db.prepare("INSERT INTO chat_jobs (id, goal, status, created_at, last_activity_at, ended_at) VALUES (?, 'g', 'done', ?, ?, ?)")
        .run('cj_aaaaaaaaaaaaaaaaaaaaaaaa', '2026-11-08T11:00:00.000Z', '2026-11-08T11:10:00.000Z', '2026-11-08T11:10:00.000Z');
      const upgraded = createChatJobStore(db);
      expect(upgraded.get('cj_aaaaaaaaaaaaaaaaaaaaaaaa')?.reportedAt).toBe('2026-11-08T11:10:00.000Z');
      expect(upgraded.unreportedEnded('2000-01-01T00:00:00.000Z')).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('a message from the main chat waits for the next turn, clears a pause and every count, and asks for the reply', () => {
    const job = jobs.start({ goal: 'Weekly players' });
    jobs.settle(job.id, { action: 'pause', note: 'Two turns in a row failed.', kind: 'stuck' }, 'failed');
    // The main chat's own look kept it going once; then it got stuck again.
    expect(jobs.continueJob(job.id, { from: 'review' })).toMatchObject({ supervisions: 1 });
    jobs.settle(job.id, { action: 'pause', note: 'Two turns in a row failed.', kind: 'stuck' }, 'failed');
    for (let i = 0; i < 3; i++) jobs.incrementContinuations(job.id);
    const delivered = jobs.deliverMessage(job.id, { from: 'main_chat', text: '  Use dataset_date.  ', ownerWords: 'tell it to use dataset_date' })!;
    expect(delivered).toMatchObject({
      status: 'active', continueReason: JOB_MESSAGE_REASON, continuationCount: 0, supervisions: 0, failedTurns: 0,
      inbox: [{ from: 'main_chat', text: 'Use dataset_date.', ownerWords: 'tell it to use dataset_date', at: expect.any(String) }],
      mainReplyAt: expect.any(String),
    });
    expect(delivered.pausedAt).toBeUndefined();
    expect(delivered.continueRequestedAt).toEqual(expect.any(String));
    // The block every turn of the job reads names it, as the main chat's words.
    expect(formatChatJobBlock(delivered, [])).toContain('- The main chat: Use dataset_date. (the owner\'s own words there: "tell it to use dataset_date")');
    // A turn that started before the ask answers nothing; one that started at or after it takes the reply, once.
    expect(jobs.takeMainReply(job.id, '2000-01-01T00:00:00.000Z')).toBe(false);
    expect(jobs.takeMainReply(job.id, new Date(Date.now() + 1_000).toISOString())).toBe(true);
    expect(jobs.takeMainReply(job.id, new Date(Date.now() + 1_000).toISOString())).toBe(false);
    jobs.consumeInbox(job.id, delivered.inbox[0].at);
    expect(jobs.get(job.id)!.inbox).toEqual([]);
  });

  it('a message from the main chat reopens an ended job; the main chat\'s own look never does, and counts one round', () => {
    const ended = jobs.start({ goal: 'Done already' });
    jobs.end(ended.id, 'done', 'finished', { nextSteps: ['Rerun it'] });
    expect(jobs.deliverMessage(ended.id, { from: 'review', text: 'Try again.' })).toBeNull();
    const reopened = jobs.deliverMessage(ended.id, { from: 'main_chat', text: 'Also add February.' })!;
    expect(reopened).toMatchObject({ status: 'active', inbox: [{ text: 'Also add February.' }] });
    expect(reopened.nextSteps).toBeUndefined();
    expect(reopened.reportedAt).toBeUndefined();
    const stuck = jobs.start({ goal: 'Stuck one' });
    for (let i = 0; i < 4; i++) jobs.incrementContinuations(stuck.id);
    jobs.settle(stuck.id, { action: 'pause', note: 'repeating', kind: 'stuck' }, 'repeat_breaker');
    const guided = jobs.deliverMessage(stuck.id, { from: 'review', text: 'Read the error first.' })!;
    expect(guided).toMatchObject({ continueReason: JOB_REVIEW_REASON, continuationCount: 4, supervisions: 1, inbox: [{ from: 'review' }] });
    expect(guided.pausedAt).toBeUndefined();
    expect(guided.mainReplyAt).toBeUndefined();
    // A job stopped at BotBoy's turn limit gets a fresh round of turns with the main chat's message.
    const limited = jobs.start({ goal: 'Long one' });
    for (let i = 0; i < 25; i++) jobs.incrementContinuations(limited.id);
    jobs.settle(limited.id, { action: 'pause', note: 'Paused after 25 automatic turns in a row.', kind: 'limit' }, 'answered');
    expect(jobs.deliverMessage(limited.id, { from: 'review', text: 'Skip February.' })).toMatchObject({ continuationCount: 0, supervisions: 1 });
    expect(jobs.deliverMessage(stuck.id, { from: 'main_chat', text: '   ' })).toBeNull();
  });

  it('a message stored by the §11 review (from "supervisor") reads as the main chat\'s own look', () => {
    const job = jobs.start({ goal: 'g' });
    storage.getDb().prepare('UPDATE chat_jobs SET inbox_json = ? WHERE id = ?')
      .run(JSON.stringify([{ from: 'supervisor', text: 'Read the error.', at: '2026-11-08T10:00:00.000Z' }, { from: 'stranger', text: 'x', at: '2026-11-08T10:01:00.000Z' }]), job.id);
    expect(jobs.get(job.id)!.inbox).toEqual([{ from: 'review', text: 'Read the error.', at: '2026-11-08T10:00:00.000Z' }]);
  });

  it('the inbox keeps the newest messages only', () => {
    const job = jobs.start({ goal: 'g' });
    for (let i = 0; i < JOB_INBOX_MAX + 2; i++) jobs.deliverMessage(job.id, { from: 'main_chat', text: `message ${i}` });
    expect(jobs.get(job.id)!.inbox.map(message => message.text)).toEqual(Array.from({ length: JOB_INBOX_MAX }, (_, i) => `message ${i + 2}`));
  });

  it('next steps are short and distinct', () => {
    expect(cleanNextSteps(['  Rerun February.  ', 'rerun february', '', 7, 'x'.repeat(80)])).toEqual(['Rerun February', '7', 'x'.repeat(60)]);
    expect(cleanNextSteps('not a list')).toEqual([]);
  });

  it('the job block keeps its closing instruction however much the working set holds', () => {
    const job = jobs.start({ goal: 'g'.repeat(4_000) });
    for (let i = 0; i < 5; i++) jobs.deliverMessage(job.id, { from: 'main_chat', text: 'm'.repeat(2_000) });
    jobs.update(job.id, { notes: Array.from({ length: 12 }, (_, i) => `${i} ${'n'.repeat(290)}`) });
    const block = formatChatJobBlock(jobs.get(job.id)!, []);
    expect(block.length).toBeLessThanOrEqual(4_500);
    expect(block).toContain('END EVERY TURN of this job with exactly one job_update');
    expect(block).toContain('your closing reply then becomes the job\'s report in the owner\'s main chat');
  });

  it('the main chat\'s JOBS block points at the jobs tool, never at "start a new job" for several steps', () => {
    const job = jobs.start({ goal: 'g', title: 'PV players' });
    const block = formatJobsList([{ job: jobs.get(job.id)!, phase: 'working' }])!;
    expect(block).toContain('call jobs read');
    expect(block).toContain('call jobs message');
    expect(block).toContain('never start a new job to answer a question about a job');
    expect(block).not.toContain('takes several steps');
  });
});
