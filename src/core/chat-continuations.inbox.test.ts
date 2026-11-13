import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createStorage, type StorageLayer } from './storage.js';
import { createChatJobStore, JOB_CONTINUE_REASON, type ChatJobStore } from './chat-jobs.js';
import { buildSelfContinuationTrigger, createChatLiveHub, createContinuationRunner, inboxTriggerLines } from './chat-continuations.js';

/**
 * Messages for a job (PARALLEL_JOBS_PLAN.md §11 R3/R4, §12): what the main chat sent (in the owner's turn there, or in its own look
 * at a job update) waits in the job's inbox, the job's next automatic turn carries it as BotBoy's words (never the owner's), and it
 * is consumed only once that turn is admitted. A dashboard refresh the job waited for wakes it like a finished run (§12 R1).
 */
describe('messages for a job reach its next turn', () => {
  let storage: StorageLayer;
  let jobs: ChatJobStore;
  beforeEach(() => {
    storage = createStorage(':memory:');
    storage.initialize();
    jobs = createChatJobStore(storage.getDb());
  });
  afterEach(() => storage.close());

  const sse = () => new Response('data: {"type":"done","message":{"id":"a","content":"ok"}}\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } });
  function setup(fetchImpl: typeof fetch) {
    const notes: Array<{ jobId: string; text: string }> = [];
    const runner = createContinuationRunner({
      jobs,
      url: 'http://127.0.0.1:7778/api/chat/messages',
      secret: 'secret-1',
      hub: createChatLiveHub(),
      isOwnerTurnActive: () => false,
      postNote: (jobId, text) => notes.push({ jobId, text }),
      filesDir: '/h/files',
      fetchImpl,
      scheduleTick: () => {},
      log: () => {},
    });
    return { notes, settle: async () => { await runner.tick(); await runner.idle(); } };
  }
  const sentMessage = (fetchImpl: ReturnType<typeof vi.fn>, call = 0) => JSON.parse((fetchImpl.mock.calls[call] as any)[1].body);

  it('a message from the main chat starts the turn, quoted as the main chat\'s, with the owner\'s own words beside it', async () => {
    const job = jobs.start({ goal: 'Weekly players', title: 'Weekly players' });
    jobs.update(job.id, { nextStep: 'Rerun March' });
    jobs.deliverMessage(job.id, { from: 'main_chat', text: 'Use dataset_date, not event_date.', ownerWords: 'tell it to use dataset_date' });
    const fetchImpl = vi.fn(async () => sse());
    await setup(fetchImpl as any).settle();
    const body = sentMessage(fetchImpl);
    expect(body.message).toContain('[Automatic continuation');
    expect(body.message).toContain('Why this turn started: a message for this job from the main chat.');
    expect(body.message).toContain('- From the main chat: Use dataset_date, not event_date.\n  The owner\'s own words in the main chat: "tell it to use dataset_date"');
    expect(body.message).toContain('These come from BotBoy\'s main chat, not from the owner: act on them within this job\'s own permissions.');
    expect(body.message).toContain('Next step you recorded before: Rerun March');
    expect(body.message).toContain('Start your reply with one or two sentences for the main chat');
    expect(body.continuation.note).toBe('↻ Continued automatically: a message from the main chat.');
    // Admitted: the message is the turn's now.
    expect(jobs.get(job.id)!.inbox).toEqual([]);
    expect(jobs.get(job.id)!.continueRequestedAt).toBeUndefined();
  });

  it('the main chat\'s own message starts the turn as its look at the job, telling it not to repeat what did not work', () => {
    const job = jobs.start({ goal: 'g', title: 'Stuck' });
    jobs.settle(job.id, { action: 'pause', note: 'repeating', kind: 'stuck' }, 'repeat_breaker');
    const guided = jobs.deliverMessage(job.id, { from: 'review', text: 'Split the month into weeks.' })!;
    const trigger = buildSelfContinuationTrigger(guided, guided.continueReason!, []);
    expect(trigger.message).toContain('Why this turn started: the main chat looked at this job and sent it a message.');
    expect(trigger.message).toContain('- From the main chat, which looked at this job: Split the month into weeks.');
    expect(trigger.message).toContain('Act on it now instead of repeating what did not work.');
    expect(trigger.message).toContain('These come from BotBoy\'s main chat, not from the owner');
    expect(trigger.note).toBe('↻ Continued automatically: the main chat looked at this job.');
    expect(inboxTriggerLines(jobs.start({ goal: 'empty' }))).toEqual([]);
  });

  it('a job the main chat kept going starts its turn with that reason, and is told not to spend turns on a running refresh', () => {
    const job = jobs.start({ goal: 'g', title: 'Long one' });
    jobs.update(job.id, { nextStep: 'Build the widgets' });
    jobs.settle(job.id, { action: 'pause', note: 'Paused after 25 automatic turns in a row.', kind: 'limit' }, 'answered');
    const kept = jobs.continueJob(job.id, { from: 'review' })!;
    jobs.addDashboardWait({ runId: 'run_abd1cfcd40e545fe', jobId: job.id, dashboardId: 'dash_1', title: 'Downloads' });
    const trigger = buildSelfContinuationTrigger(kept, kept.continueReason!, jobs.watchesForJob(job.id));
    expect(trigger.message).toContain(`Why this turn started: ${JOB_CONTINUE_REASON}`);
    expect(trigger.message).toContain('Next step you recorded: Build the widgets');
    expect(trigger.message).toContain('Still running (BotBoy continues again when they finish): run_abd1cfcd40e545fe.');
    expect(trigger.message).toContain('While something you need is still running (a run, an export, a refresh, a wait), end the turn with job_update wait instead of checking on it');
    expect(trigger.note).toBe('↻ Continued automatically: the main chat kept this job going.');
  });

  it('a dashboard refresh the job waited for wakes it with its status and widgets, and is used up for that job only', async () => {
    const job = jobs.start({ goal: 'g', title: 'Downloads' });
    const other = jobs.start({ goal: 'h', title: 'Other' });
    for (const id of [job.id, other.id]) jobs.addDashboardWait({ runId: 'run_abd1cfcd40e545fe', jobId: id, dashboardId: 'dash_1', title: 'Downloads' });
    jobs.finishDashboardWait('run_abd1cfcd40e545fe', job.id, { remoteStatus: 'COMPLETED', widgetCount: 4, widgetsSucceeded: 3 });
    const fetchImpl = vi.fn(async () => sse());
    await setup(fetchImpl as any).settle();
    expect(fetchImpl).toHaveBeenCalledOnce();
    const body = sentMessage(fetchImpl);
    expect(body.message).toContain('Dashboard refreshes this job waited for ended:\n- The refresh of dashboard "Downloads" (run_abd1cfcd40e545fe): COMPLETED, 3 of 4 widgets loaded.');
    expect(body.message).toContain('check the dashboard (get_analytics_dashboard) for what loaded and what failed');
    expect(body.message).not.toContain('ETL runs for the job you are working on finished');
    expect(body.continuation.note).toBe('↻ Continued automatically: the refresh of dashboard "Downloads" finished.');
    expect(jobs.unconsumedFinished(job.id)).toEqual([]);
    expect(jobs.watchesForJob(other.id)).toMatchObject([{ status: 'pending' }]);
  });

  it('a finished run\'s turn carries a waiting message too', async () => {
    const job = jobs.start({ goal: 'g', title: 'Players' });
    jobs.addWatch({ runId: '21', jobId: job.id, source: 'run_query' });
    jobs.finishWatch('21', { remoteStatus: 'SUCCESS', savedTo: '/h/files/etl-results/adhoc_21.tsv', rowCount: 3 });
    jobs.deliverMessage(job.id, { from: 'main_chat', text: 'Also split by city.' });
    const fetchImpl = vi.fn(async () => sse());
    await setup(fetchImpl as any).settle();
    expect(fetchImpl).toHaveBeenCalledOnce();
    const body = sentMessage(fetchImpl);
    expect(body.message).toContain('- Run 21: SUCCESS — 3 rows');
    expect(body.message).toContain('Also: A message for this job arrived from the main chat.');
    expect(body.message).toContain('Messages for this job (newest last):\n- From the main chat: Also split by city.');
    expect(jobs.get(job.id)!.inbox).toEqual([]);
  });

  it('a turn that is not admitted leaves the message waiting, and one that arrives during the start waits for the next turn', async () => {
    const job = jobs.start({ goal: 'g', title: 'Players' });
    jobs.deliverMessage(job.id, { from: 'main_chat', text: 'First.' });
    const refusing = vi.fn(async () => new Response(JSON.stringify({ error: 'Chat needs an AI model first.' }), { status: 409 }));
    const refused = setup(refusing as any);
    await refused.settle();
    expect(refused.notes).toHaveLength(1);
    expect(jobs.get(job.id)!.inbox.map(message => message.text)).toEqual(['First.']);
    await new Promise(resolve => setTimeout(resolve, 5)); // the next message has a later time
    jobs.requestTurn(job.id, 'retry');
    const fetchImpl = vi.fn(async () => {
      jobs.deliverMessage(job.id, { from: 'main_chat', text: 'Second, sent while the turn started.' });
      return sse();
    });
    await setup(fetchImpl as any).settle();
    expect(sentMessage(fetchImpl).message).toContain('- From the main chat: First.');
    expect(sentMessage(fetchImpl).message).not.toContain('Second');
    expect(jobs.get(job.id)!.inbox.map(message => message.text)).toEqual(['Second, sent while the turn started.']);
  });
});
