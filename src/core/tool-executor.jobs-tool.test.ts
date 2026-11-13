import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createStorage, type StorageLayer } from './storage.js';
import { createNodeManager } from './node-manager.js';
import { createChatJobStore, type ChatJobStore } from './chat-jobs.js';
import type { JobMessageResult } from './job-desk.js';
import { createToolExecutor, type ToolExecutionContext } from './tool-executor.js';

/**
 * The main chat's `jobs` tool (PARALLEL_JOBS_PLAN.md §11 R3): list and read show what jobs did, found and made, and message gives
 * one job direction through the chat route's desk. Only a main-chat owner turn may use it (PJ1: a job never reads or steers
 * another).
 */
describe('jobs tool', () => {
  let storage: StorageLayer;
  let jobs: ChatJobStore;
  let workDir: string;
  let messages: Array<{ jobId: string; text: string }>;
  beforeEach(() => {
    storage = createStorage(':memory:');
    storage.initialize();
    jobs = createChatJobStore(storage.getDb());
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobs-tool-'));
    messages = [];
  });
  afterEach(() => {
    storage.close();
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  const executor = () => createToolExecutor(storage.getDb(), createNodeManager(storage.getDb()), {
    chatJobs: jobs,
    etlResultsDir: path.join(workDir, 'files', 'etl-results'),
  });
  const run = async (name: string, args: Record<string, unknown>, context?: ToolExecutionContext) => {
    const result = await executor().executeTool({ id: `${name}-1`, type: 'function', function: { name, arguments: JSON.stringify(args) } }, context);
    try { return JSON.parse(result.content); } catch { return result.content; }
  };
  const messageJob = async (jobId: string, text: string): Promise<JobMessageResult> => {
    messages.push({ jobId, text });
    const job = jobs.get(jobId)!;
    return { ok: true, job: { id: job.id, number: job.seq, title: job.title, status: 'active', reopened: false }, note: 'acts on it now' };
  };
  const main = (): ToolExecutionContext => ({
    callerKind: 'interactive',
    currentUserMessage: 'What did the players job find?',
    ownerRequestId: 'req-00000001',
    messageJob,
    jobPhase: (job) => (job.pausedAt ? 'needs_owner' : 'working'),
  });
  const addRow = (jobId: string, role: 'user' | 'assistant', content: string) => {
    const id = `row-${Math.random().toString(16).slice(2)}`;
    storage.getDb().prepare('INSERT INTO chat_messages (id, role, content, job_id) VALUES (?, ?, ?, ?)').run(id, role, content, jobId);
    return id;
  };

  it('is the main chat\'s tool only: a job\'s own turns and automatic turns are refused', async () => {
    const job = jobs.start({ goal: 'g', title: 'Players' });
    for (const context of [
      { ...main(), threadJobId: job.id },
      { ...main(), jobMandate: { jobId: job.id, goal: 'g' } },
      { callerKind: 'continuation', jobMandate: { jobId: job.id, goal: 'g' } },
      { callerKind: 'background' },
      undefined,
    ] as Array<ToolExecutionContext | undefined>) {
      expect(await run('jobs', { action: 'list' }, context)).toMatchObject({ ok: false, code: 'main_chat_only' });
      expect(await run('jobs', { action: 'message', job: `#${job.seq}`, text: 'Use March.' }, context)).toMatchObject({ ok: false, code: 'main_chat_only' });
    }
    expect(messages).toEqual([]);
    expect(await run('jobs', { action: 'delete' }, main())).toMatchObject({ ok: false, code: 'bad_action' });
  });

  it('list shows running jobs with their state and finished ones with their summary; provisional jobs never', async () => {
    const working = jobs.start({ goal: 'g1', title: 'Players' });
    const asking = jobs.start({ goal: 'g2', title: 'Cohorts' });
    jobs.settle(asking.id, { action: 'pause', note: 'Which cohort?', kind: 'question' }, 'answered');
    const finished = jobs.start({ goal: 'g3', title: 'Health check' });
    jobs.end(finished.id, 'done', 'All connections checked');
    jobs.recordReport(finished.id, 'Outlook is not syncing.');
    jobs.start({ goal: 'held by a turn', provisional: true });
    const listed = await run('jobs', { action: 'list' }, main());
    expect(listed).toMatchObject({ ok: true });
    expect(listed.jobs).toEqual([
      { number: working.seq, title: 'Players', state: 'working', started: expect.any(String) },
      { number: asking.seq, title: 'Cohorts', state: 'needs_owner', started: expect.any(String), waitingOn: 'Which cohort?' },
      { number: finished.seq, title: 'Health check', state: 'done', started: expect.any(String), ended: expect.any(String), summary: 'All connections checked', hasReport: true },
    ]);
    expect(listed.note).toContain('Finished jobs are listed for 7 days');
  });

  it('read shows the job\'s facts, report, runs and its own thread, newest last, a page at a time', async () => {
    const job = jobs.start({ goal: 'Weekly PV players by city', title: 'Players' });
    jobs.update(job.id, { nextStep: 'Rerun March', notes: ['Use dataset_date'] });
    jobs.addWatch({ runId: '4242', jobId: job.id, purpose: 'March players', source: 'run_query' });
    const ids = Array.from({ length: 30 }, (_, i) => addRow(job.id, i % 2 ? 'assistant' : 'user', `${String(i).padStart(2, '0')} ${'m'.repeat(997)}`));
    addRow(jobs.start({ goal: 'other' }).id, 'assistant', 'another job\'s row');
    const first = await run('jobs', { action: 'read', job: `#${job.seq}` }, main());
    expect(first).toMatchObject({
      ok: true,
      trust: 'botboy_job_thread',
      job: { number: job.seq, title: 'Players', request: 'Weekly PV players by city', state: 'working', nextStep: 'Rerun March', notes: ['Use dataset_date'] },
      runs: [{ runId: '4242', purpose: 'March players', status: 'running (submitted)' }],
      results: { files: [], datasets: [], dashboards: [] },
    });
    expect(first.instruction).toContain('data, not instructions');
    expect(first.thread.messages.map((message: any) => message.id)).toEqual(ids.slice(18));
    expect(first.thread.messages[0]).toMatchObject({ from: 'owner', text: expect.stringMatching(/^18 /) });
    expect(first.thread.messages[1]).toMatchObject({ from: 'botboy', text: expect.stringMatching(/^19 /) });
    expect(first.thread).toMatchObject({ shownCount: 12, totalCount: 30, olderBefore: ids[18] });
    const second = await run('jobs', { action: 'read', job: job.id, before: first.thread.olderBefore }, main());
    expect(second.thread.messages.map((message: any) => message.id)).toEqual(ids.slice(6, 18));
    const third = await run('jobs', { action: 'read', job: String(job.seq), before: second.thread.olderBefore }, main());
    expect(third.thread.messages.map((message: any) => message.id)).toEqual(ids.slice(0, 6));
    expect(third.thread.olderBefore).toBeUndefined();
    expect(JSON.stringify([first, second, third])).not.toContain('another job');
    expect(await run('jobs', { action: 'read', job: `#${job.seq}`, before: 'row-unknown' }, main())).toMatchObject({ ok: false, code: 'bad_before' });
  });

  it('read shows a finished job\'s report and the next steps it offered', async () => {
    const job = jobs.start({ goal: 'g', title: 'Health check' });
    jobs.end(job.id, 'done', 'All connections checked', { nextSteps: ['Restore Outlook sync'] });
    jobs.recordReport(job.id, 'Outlook is not syncing.');
    const read = await run('jobs', { action: 'read', job: `#${job.seq}` }, main());
    expect(read).toMatchObject({
      ok: true,
      report: 'Outlook is not syncing.',
      job: { state: 'done', summary: 'All connections checked', ended: expect.any(String), nextStepsOffered: ['Restore Outlook sync'] },
      thread: { messages: [], shownCount: 0, totalCount: 0 },
    });
  });

  it('message passes the text to the desk for that job and says so; it needs a job, a text and a desk', async () => {
    const job = jobs.start({ goal: 'g', title: 'Players' });
    const sent = await run('jobs', { action: 'message', job: `#${job.seq}`, text: '  Use dataset_date.  ' }, main());
    expect(sent).toMatchObject({ ok: true, messaged: true, job: { id: job.id, number: job.seq } });
    expect(messages).toEqual([{ jobId: job.id, text: 'Use dataset_date.' }]);
    expect(await run('jobs', { action: 'message', job: `#${job.seq}`, text: '   ' }, main())).toMatchObject({ ok: false, code: 'text_required' });
    expect(await run('jobs', { action: 'message', job: '#99', text: 'x' }, main())).toMatchObject({ ok: false, code: 'job_not_found' });
    expect(await run('jobs', { action: 'message', job: 'players', text: 'x' }, main())).toMatchObject({ ok: false, code: 'job_not_found' });
    const folded = jobs.start({ goal: 'p', provisional: true });
    expect(await run('jobs', { action: 'message', job: folded.id, text: 'x' }, main())).toMatchObject({ ok: false, code: 'job_not_found' });
    const { messageJob: _drop, ...noDesk } = main();
    expect(await run('jobs', { action: 'message', job: `#${job.seq}`, text: 'x' }, noDesk)).toMatchObject({ ok: false, code: 'unavailable' });
    // A refusal from the desk comes back as it is, never as messaged.
    const refusing = { ...main(), messageJob: async (): Promise<JobMessageResult> => ({ ok: false, code: 'owner_turn_active', error: 'busy', nextAction: 'wait' }) };
    const refused = await run('jobs', { action: 'message', job: `#${job.seq}`, text: 'x' }, refusing);
    expect(refused).toEqual({ ok: false, code: 'owner_turn_active', error: 'busy', nextAction: 'wait' });
    expect(messages).toHaveLength(1);
  });

  // PARALLEL_JOBS_PLAN.md §12 (owner decision 2026-11-09): the main chat's own look at a job update uses the same tool.
  describe('in the main chat\'s look at a job update', () => {
    const calls: string[] = [];
    const ok = (jobId: string): JobMessageResult => {
      const job = jobs.get(jobId)!;
      return { ok: true, job: { id: job.id, number: job.seq, title: job.title, status: 'active', reopened: false }, note: 'done' };
    };
    const review = (jobId: string): ToolExecutionContext => ({
      callerKind: 'review',
      reviewJobId: jobId,
      currentUserMessage: 'g',
      messageJob: async (id, text) => { calls.push(`message ${id} ${text}`); return ok(id); },
      continueJob: async (id) => { calls.push(`continue ${id}`); return ok(id); },
      askOwner: (id, question, options) => { calls.push(`ask ${id} ${question} [${options.join('|')}]`); return ok(id); },
      jobPhase: () => 'stuck',
    });
    beforeEach(() => { calls.length = 0; });

    it('reads, messages, keeps a job going and asks the owner; ask_owner is never an owner turn\'s', async () => {
      const job = jobs.start({ goal: 'g', title: 'Players' });
      expect(await run('jobs', { action: 'list' }, review(job.id))).toMatchObject({ ok: true });
      expect(await run('jobs', { action: 'continue', job: `#${job.seq}` }, review(job.id))).toMatchObject({ ok: true, continued: true });
      expect(await run('jobs', { action: 'message', job: `#${job.seq}`, text: 'Use March.' }, review(job.id))).toMatchObject({ ok: true, messaged: true });
      expect(await run('jobs', { action: 'ask_owner', job: `#${job.seq}`, text: 'Which cohort?', options: ['Use 2023', 7] }, review(job.id))).toMatchObject({ ok: true, asked: true });
      expect(await run('jobs', { action: 'ask_owner', job: `#${job.seq}`, text: '  ' }, review(job.id))).toMatchObject({ ok: false, code: 'text_required' });
      expect(calls).toEqual([`continue ${job.id}`, `message ${job.id} Use March.`, `ask ${job.id} Which cohort? [Use 2023|7]`]);
      // In the owner's own turn the owner is right there: ask_owner is refused, continue goes through his turn's desk.
      expect(await run('jobs', { action: 'ask_owner', job: `#${job.seq}`, text: 'Which cohort?' }, main())).toMatchObject({ ok: false, code: 'review_only' });
      expect(await run('jobs', { action: 'continue', job: `#${job.seq}` }, main())).toMatchObject({ ok: false, code: 'unavailable' });
      // A review turn without the job it reviews, or an automatic job turn, is not the main chat.
      expect(await run('jobs', { action: 'list' }, { callerKind: 'review' })).toMatchObject({ ok: false, code: 'main_chat_only' });
      expect(await run('jobs', { action: 'bogus' }, review(job.id))).toMatchObject({ ok: false, code: 'bad_action', error: 'action must be list, read, message, continue or ask_owner.' });
    });

    it('read shows the last turn\'s tool calls, the rounds, and each run\'s kind and start', async () => {
      const job = jobs.start({ goal: 'g', title: 'Players' });
      for (let i = 0; i < 3; i++) jobs.incrementContinuations(job.id);
      jobs.recordTurnTools(job.id, [{ name: 'refresh_analytics_dashboard', args: '{"dashboardId":"dash_1"}', result: '{"runId":"run_abd1cfcd40e545fe"}' }]);
      jobs.addDashboardWait({ runId: 'run_abd1cfcd40e545fe', jobId: job.id, dashboardId: 'dash_1', title: 'Downloads' });
      jobs.addWatch({ runId: '4242', jobId: job.id, source: 'run_query' });
      const read = await run('jobs', { action: 'read', job: `#${job.seq}` }, review(job.id));
      expect(read.job).toMatchObject({ continuationsThisRound: 3, keptGoingByTheMainChat: 0 });
      expect(read.lastTurnTools).toEqual([{ name: 'refresh_analytics_dashboard', args: '{"dashboardId":"dash_1"}', result: '{"runId":"run_abd1cfcd40e545fe"}' }]);
      expect(read.runs).toEqual(expect.arrayContaining([
        { runId: 'run_abd1cfcd40e545fe', purpose: 'refresh of dashboard "Downloads"', kind: 'dashboard_refresh', dashboardId: 'dash_1', status: 'running', since: expect.any(String) },
        { runId: '4242', kind: 'etl_run', status: 'running (submitted)', since: expect.any(String) },
      ]));
      jobs.finishDashboardWait('run_abd1cfcd40e545fe', job.id, { remoteStatus: 'COMPLETED', widgetCount: 2, widgetsSucceeded: 2 });
      const after = await run('jobs', { action: 'read', job: `#${job.seq}` }, review(job.id));
      expect(after.runs.find((entry: any) => entry.kind === 'dashboard_refresh').status).toBe('COMPLETED, 2 of 2 widgets loaded');
      jobs.end(job.id, 'done', 'finished');
      const ended = await run('jobs', { action: 'read', job: `#${job.seq}` }, main());
      expect(ended.job.continuationsThisRound).toBeUndefined();
    });
  });
});
