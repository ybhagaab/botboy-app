import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createStorage, type StorageLayer } from './storage.js';
import { createChatJobStore, JOB_CONTINUE_REASON, JOB_MESSAGE_REASON, JOB_REVIEW_REASON, MAX_REVIEW_ROUNDS, type ChatJobStore } from './chat-jobs.js';
import { createJobDesk, REPORT_CATCH_UP_MS, type JobDeskDeps } from './job-desk.js';

/**
 * The main chat's desk for jobs (PARALLEL_JOBS_PLAN.md §11, owner decisions 2026-11-08): a finished job's own report reaches the
 * main chat once, nothing lands in the middle of an owner reply there, and a message for a job waits in its inbox while the job's
 * running step gives way.
 */
describe('job desk', () => {
  let storage: StorageLayer;
  let jobs: ChatJobStore;
  let history: Array<{ sessionId: string; text: string }>;
  let busy: boolean;
  let ownerInJob: Set<string>;
  let events: string[];
  let session: string | null;
  type Row = { role: string; content: string; jobId: string | null; refJobId: string | null };
  const rows = (): Row[] => storage.getDb()
    .prepare('SELECT role, content, job_id AS jobId, ref_job_id AS refJobId FROM chat_messages ORDER BY rowid').all() as Row[];
  const makeDesk = (over: Partial<JobDeskDeps> = {}) => createJobDesk({
    db: storage.getDb(),
    jobs,
    mainSessionId: () => session,
    appendMainHistory: (sessionId, text) => { history.push({ sessionId, text }); },
    mainOwnerTurnActive: () => busy,
    ownerTurnInJob: (jobId) => ownerInJob.has(jobId),
    preempt: async (jobId) => { events.push(`preempt:${jobId}`); },
    request: (jobId) => { events.push(`request:${jobId}`); },
    bump: () => { events.push('bump'); },
    log: () => {},
    ...over,
  });
  const doneJob = (goal: string, report?: string, nextSteps?: string[]) => {
    const job = jobs.start({ goal, title: goal });
    jobs.end(job.id, 'done', 'All checked', nextSteps ? { nextSteps } : undefined);
    if (report) jobs.recordReport(job.id, report);
    return jobs.get(job.id)!;
  };

  beforeEach(() => {
    storage = createStorage(':memory:');
    storage.initialize();
    jobs = createChatJobStore(storage.getDb());
    history = [];
    busy = false;
    ownerInJob = new Set();
    events = [];
    session = 'main-session';
  });
  afterEach(() => storage.close());

  it('posts a done job\'s own report once, as a main-chat row with its card, and adds it to the main chat\'s history', () => {
    const job = doneJob('Health check', '**Done.**\n\n- Outlook: not syncing', ['Restore Outlook sync', 'Retry SQL']);
    const desk = makeDesk();
    expect(desk.deliverReports()).toBe(1);
    expect(rows()).toEqual([{ role: 'assistant', content: `**Done.**\n\n- Outlook: not syncing\n\n[[job:${job.id}:report]]`, jobId: null, refJobId: job.id }]);
    expect(history).toEqual([{
      sessionId: 'main-session',
      text: `Job #${job.seq} "Health check" is done. Its report, as posted in this chat:\n\n**Done.**\n\n- Outlook: not syncing\n\nNext steps offered as one-tap buttons: Restore Outlook sync; Retry SQL.`,
    }]);
    expect(events).toEqual(['bump']);
    // Whoever asks next (a turn's end, an expiry, the boot) finds it posted.
    expect(desk.deliverReports()).toBe(0);
    expect(makeDesk().deliverReports()).toBe(0);
    expect(rows()).toHaveLength(1);
    expect(jobs.get(job.id)!.reportedAt).toEqual(expect.any(String));
  });

  it('a report is claimed as it is written: a delivery that starts inside another posts nothing twice', () => {
    const first = doneJob('First', 'one');
    const second = doneJob('Second', 'two');
    let nested = 0;
    let desk!: ReturnType<typeof makeDesk>;
    desk = makeDesk({
      appendMainHistory: () => { if (nested++ === 0) desk.deliverReports(); },
    });
    desk.deliverReports();
    expect(rows().map(row => row.refJobId).sort()).toEqual([first.id, second.id].sort());
  });

  it('a done job without a closing reply reports its end reason; an expired job gets one quiet line; stopped and provisional jobs post nothing', () => {
    const plain = jobs.start({ goal: 'Plain', title: 'Plain' });
    jobs.end(plain.id, 'done', 'Saved the dashboard');
    const bare = jobs.start({ goal: 'Bare', title: 'Bare' });
    jobs.end(bare.id, 'done', 'done');
    const expired = jobs.start({ goal: 'Idle', title: 'Idle one' });
    jobs.end(expired.id, 'expired', 'idle for 24 hours');
    const stopped = jobs.start({ goal: 'Stopped', title: 'Stopped' });
    jobs.end(stopped.id, 'stopped', 'stopped by the owner');
    const folded = jobs.start({ goal: 'Folded', provisional: true });
    jobs.end(folded.id, 'done', 'answered in the main chat');
    expect(makeDesk().deliverReports()).toBe(3);
    const contents = rows().map(row => row.content);
    expect(contents).toEqual([
      `Saved the dashboard\n\n[[job:${plain.id}:report]]`,
      `Finished.\n\n[[job:${bare.id}:report]]`,
      `#${expired.seq} Idle one stopped after a day with no activity. Start a message with #${expired.seq} to pick it up again.\n\n[[job:${expired.id}:ended]]`,
    ]);
    expect(rows().map(row => row.refJobId)).toEqual([plain.id, bare.id, expired.id]);
    expect(history.at(-1)!.text).toBe(`Job #${expired.seq} "Idle one" ended after a day with no activity; the owner can pick it up again with #${expired.seq}.`);
    expect(contents.join('\n')).not.toContain(stopped.id);
    expect(contents.join('\n')).not.toContain(folded.id);
  });

  it('a report waits while the owner talks in the main chat, and flush posts it when that reply ends', () => {
    const job = doneJob('Weekly players', 'Players rose 4%.');
    busy = true;
    const desk = makeDesk();
    expect(desk.deliverReports()).toBe(0);
    desk.flush();
    expect(rows()).toEqual([]);
    expect(jobs.get(job.id)!.reportedAt).toBeUndefined();
    busy = false;
    desk.flush();
    expect(rows().map(row => row.content)).toEqual([`Players rose 4%.\n\n[[job:${job.id}:report]]`]);
  });

  it('a report older than the catch-up window is never posted, and no main session means no history (the row still posts)', () => {
    doneJob('Old one', 'old');
    expect(makeDesk({ now: () => Date.now() + REPORT_CATCH_UP_MS + 60_000 }).deliverReports()).toBe(0);
    session = null;
    expect(makeDesk().deliverReports()).toBe(1);
    expect(history).toEqual([]);
    expect(rows()).toHaveLength(1);
  });

  it('a message from the main chat lands in the inbox and the thread before the running step gives way, then the turn is asked for', async () => {
    const job = jobs.start({ goal: 'Weekly players', title: 'Weekly players' });
    const seen: unknown[] = [];
    const desk = makeDesk({
      preempt: async (jobId) => {
        // When the step gives way, the message is already waiting and shown in the job's thread.
        seen.push(jobs.get(jobId)!.inbox.map(message => message.text), rows().map(row => row.content));
        events.push(`preempt:${jobId}`);
      },
    });
    const result = await desk.messageJob(job.id, '  Use dataset_date, not event_date.  ', { from: 'main_chat', ownerWords: 'tell #1 to use dataset_date' });
    expect(result).toMatchObject({ ok: true, job: { id: job.id, number: job.seq, title: 'Weekly players', status: 'active', reopened: false } });
    expect(result.ok && result.note).toContain(`its reply comes back to this chat as "#${job.seq} replied"`);
    expect(seen).toEqual([['Use dataset_date, not event_date.'], ['↪ From the main chat: Use dataset_date, not event_date.']]);
    expect(events).toEqual([`preempt:${job.id}`, `request:${job.id}`, 'bump']);
    expect(rows()).toEqual([{ role: 'assistant', content: '↪ From the main chat: Use dataset_date, not event_date.', jobId: job.id, refJobId: null }]);
    expect(jobs.get(job.id)).toMatchObject({
      continueReason: JOB_MESSAGE_REASON,
      inbox: [{ from: 'main_chat', text: 'Use dataset_date, not event_date.', ownerWords: 'tell #1 to use dataset_date' }],
      mainReplyAt: expect.any(String),
    });
  });

  it('refuses what it cannot deliver, and delivers nothing then', async () => {
    const desk = makeDesk();
    const active = jobs.start({ goal: 'g', title: 'Active' });
    const folded = jobs.start({ goal: 'p', provisional: true });
    expect(await desk.messageJob('cj_missing', 'hi', { from: 'main_chat' })).toMatchObject({ ok: false, code: 'job_not_found' });
    expect(await desk.messageJob(folded.id, 'hi', { from: 'main_chat' })).toMatchObject({ ok: false, code: 'job_not_found' });
    expect(await desk.messageJob(active.id, '   ', { from: 'main_chat' })).toMatchObject({ ok: false, code: 'empty_message' });
    // The main chat's own look never reopens a job, never talks over a pause the owner made, and stops after its rounds.
    const ended = doneJob('Ended', 'Done.');
    expect(await desk.messageJob(ended.id, 'Try again.', { from: 'review' })).toMatchObject({ ok: false, code: 'job_not_active' });
    const ownerPaused = jobs.start({ goal: 'o', title: 'Owner paused' });
    jobs.pauseByOwner(ownerPaused.id);
    expect(await desk.messageJob(ownerPaused.id, 'Carry on.', { from: 'review' })).toMatchObject({ ok: false, code: 'owner_paused' });
    const tired = jobs.start({ goal: 't', title: 'Kept going' });
    for (let i = 0; i < MAX_REVIEW_ROUNDS; i++) {
      jobs.settle(tired.id, { action: 'pause', note: 'stuck', kind: 'stuck' }, 'repeat_breaker');
      jobs.continueJob(tired.id, { from: 'review' });
    }
    jobs.settle(tired.id, { action: 'pause', note: 'stuck', kind: 'stuck' }, 'repeat_breaker');
    const tiredResult = await desk.messageJob(tired.id, 'Try the other table.', { from: 'review' });
    expect(tiredResult).toMatchObject({ ok: false, code: 'rounds_used' });
    expect(tiredResult.ok === false && tiredResult.nextAction).toContain('Leave this one for the owner');
    expect(jobs.get(ownerPaused.id)!.inbox).toEqual([]);
    expect(jobs.get(tired.id)!.inbox).toEqual([]);
    // While the owner talks to the job in its own thread, the main chat's own look does not talk over him.
    ownerInJob.add(active.id);
    const busyResult = await desk.messageJob(active.id, 'Use March.', { from: 'review' });
    expect(busyResult).toMatchObject({ ok: false, code: 'owner_turn_active' });
    expect(busyResult.ok === false && busyResult.nextAction).toBeTruthy();
    expect(jobs.get(active.id)!.inbox).toEqual([]);
    expect(rows()).toEqual([]);
    expect(events).toEqual([]);
  });

  it('a message from the owner\'s main-chat turn waits while he talks to the job in its thread, then goes in once', async () => {
    const desk = makeDesk();
    const job = jobs.start({ goal: 'g', title: 'Study' });
    jobs.declare(job.id, 'continue', 'the owner turn\'s own next step');
    ownerInJob.add(job.id);
    const waiting = await desk.messageJob(job.id, 'Use March.', { from: 'main_chat', ownerWords: 'tell #1 to use March' });
    expect(waiting).toMatchObject({ ok: true, queued: true, job: { id: job.id, number: job.seq } });
    expect(waiting.ok && waiting.note).toContain('it reaches #');
    // Nothing reaches the job during his turn: its inbox, its declaration and its thread stay as that turn left them.
    expect(jobs.get(job.id)).toMatchObject({ inbox: [], declaration: 'continue' });
    expect(rows()).toEqual([]);
    expect(events).toEqual([]);
    // Another owner turn still runs there: it keeps waiting.
    await desk.ownerTurnEnded(job.id);
    expect(jobs.get(job.id)!.inbox).toEqual([]);
    ownerInJob.delete(job.id);
    await desk.ownerTurnEnded(job.id);
    expect(jobs.get(job.id)!.inbox).toEqual([expect.objectContaining({ from: 'main_chat', text: 'Use March.', ownerWords: 'tell #1 to use March' })]);
    expect(jobs.get(job.id)).toMatchObject({ continueReason: JOB_MESSAGE_REASON, mainReplyAt: expect.any(String) });
    expect(rows()).toEqual([{ role: 'assistant', content: '↪ From the main chat: Use March.', jobId: job.id, refJobId: null }]);
    expect(events).toEqual([`preempt:${job.id}`, `request:${job.id}`, 'bump']);
    // Delivered once: a second end delivers nothing more.
    await desk.ownerTurnEnded(job.id);
    expect(jobs.get(job.id)!.inbox).toHaveLength(1);
    expect(rows()).toHaveLength(1);
  });

  it('waiting messages keep their order when one more arrives while a later owner turn still runs there', async () => {
    const desk = makeDesk();
    const job = jobs.start({ goal: 'g', title: 'Study' });
    ownerInJob.add(job.id);
    await desk.messageJob(job.id, 'First.', { from: 'main_chat' });
    await desk.messageJob(job.id, 'Second.', { from: 'main_chat' });
    // His reply ended, but another of his turns there already began, and the main chat sends one more message at once.
    const ended = desk.ownerTurnEnded(job.id);
    await desk.messageJob(job.id, 'Third.', { from: 'main_chat' });
    await ended;
    expect(jobs.get(job.id)!.inbox).toEqual([]);
    ownerInJob.delete(job.id);
    await desk.ownerTurnEnded(job.id);
    expect(jobs.get(job.id)!.inbox.map(message => message.text)).toEqual(['First.', 'Second.', 'Third.']);
  });

  it('a waiting message to a job the owner then stopped does not reopen it', async () => {
    const desk = makeDesk();
    const job = jobs.start({ goal: 'g', title: 'Study' });
    ownerInJob.add(job.id);
    expect(await desk.messageJob(job.id, 'Use March.', { from: 'main_chat' })).toMatchObject({ ok: true, queued: true });
    jobs.end(job.id, 'stopped', 'the owner stopped it');
    ownerInJob.delete(job.id);
    await desk.ownerTurnEnded(job.id);
    expect(jobs.get(job.id)).toMatchObject({ status: 'stopped', inbox: [] });
    expect(rows()).toEqual([]);
  });

  it('a message from the main chat reopens an ended job, and says so', async () => {
    const job = doneJob('Monthly report', 'Done.');
    const result = await makeDesk().messageJob(job.id, 'Add February too.', { from: 'main_chat' });
    expect(result).toMatchObject({ ok: true, job: { reopened: true, status: 'active' } });
    expect(result.ok && result.note).toContain('it had ended, so it is open again');
    expect(jobs.get(job.id)).toMatchObject({ status: 'active', inbox: [{ text: 'Add February too.' }] });
  });

  it('a job the owner stopped is not picked up again from the main chat', async () => {
    const job = jobs.start({ goal: 'g', title: 'Stopped one' });
    jobs.end(job.id, 'stopped', 'stopped by the owner');
    const result = await makeDesk().messageJob(job.id, 'Carry on.', { from: 'main_chat' });
    expect(result).toMatchObject({ ok: false, code: 'job_stopped' });
    expect(result.ok === false && result.nextAction).toContain(`#${job.seq}`);
    expect(jobs.get(job.id)).toMatchObject({ status: 'stopped', inbox: [] });
    expect(rows()).toEqual([]);
  });

  it('when the step that gave way had paused the job by itself, the message\'s turn is made due again', async () => {
    const job = jobs.start({ goal: 'g', title: 'Asks a lot' });
    const desk = makeDesk({
      preempt: async (jobId) => { jobs.settle(jobId, { action: 'pause', note: 'Which month?', kind: 'question' }, 'answered'); },
    });
    expect(await desk.messageJob(job.id, 'Use March.', { from: 'main_chat' })).toMatchObject({ ok: true });
    expect(jobs.get(job.id)).toMatchObject({ continueReason: JOB_MESSAGE_REASON, inbox: [{ text: 'Use March.' }] });
    expect(jobs.get(job.id)!.pausedAt).toBeUndefined();
    expect(jobs.get(job.id)!.continueRequestedAt).toEqual(expect.any(String));
  });

  it('a pause the owner made meanwhile stands: the message waits for their resume', async () => {
    const job = jobs.start({ goal: 'g', title: 'Paused by owner' });
    const desk = makeDesk({ preempt: async (jobId) => { jobs.pauseByOwner(jobId); } });
    expect(await desk.messageJob(job.id, 'Use March.', { from: 'main_chat' })).toMatchObject({ ok: true });
    expect(jobs.get(job.id)).toMatchObject({ pauseKind: 'paused', inbox: [{ text: 'Use March.' }] });
    expect(jobs.get(job.id)!.continueRequestedAt).toBeUndefined();
  });

  it('a job the step finished meanwhile takes the main chat\'s message as a follow-up; the main chat\'s own look then goes nowhere', async () => {
    const job = jobs.start({ goal: 'g', title: 'Almost done' });
    const finishing = makeDesk({ preempt: async (jobId) => { jobs.end(jobId, 'done', 'finished'); } });
    expect(await finishing.messageJob(job.id, 'Add February.', { from: 'main_chat' })).toMatchObject({ ok: true });
    expect(jobs.get(job.id)).toMatchObject({ status: 'active', continueReason: JOB_MESSAGE_REASON, inbox: [{ text: 'Add February.' }] });
    const stuck = jobs.start({ goal: 'g2', title: 'Stuck' });
    jobs.settle(stuck.id, { action: 'pause', note: 'repeating', kind: 'stuck' }, 'repeat_breaker');
    expect(await finishing.messageJob(stuck.id, 'Read the error first.', { from: 'review' })).toMatchObject({ ok: true });
    expect(jobs.get(stuck.id)!.status).toBe('done');
    // A job the owner stopped meanwhile stays stopped, whoever sent the message.
    const third = jobs.start({ goal: 'g3', title: 'Third' });
    const stopping = makeDesk({ preempt: async (jobId) => { jobs.end(jobId, 'stopped', 'stopped by the owner'); } });
    await stopping.messageJob(third.id, 'Add March.', { from: 'main_chat' });
    expect(jobs.get(third.id)!.status).toBe('stopped');
  });

  it('the main chat\'s own message shows in the job\'s thread as its own row, keeps the job\'s counts and uses one round', async () => {
    const job = jobs.start({ goal: 'g', title: 'Stuck' });
    for (let i = 0; i < 4; i++) jobs.incrementContinuations(job.id);
    jobs.settle(job.id, { action: 'pause', note: 'repeating', kind: 'stuck' }, 'repeat_breaker');
    const result = await makeDesk().messageJob(job.id, 'Read the error first.', { from: 'review' });
    expect(result).toMatchObject({ ok: true, note: `#${job.seq} acts on it now in its own thread.` });
    expect(rows()).toEqual([{ role: 'assistant', content: '↪ The main chat looked at this job: Read the error first.', jobId: job.id, refJobId: null }]);
    expect(jobs.get(job.id)).toMatchObject({ continueReason: JOB_REVIEW_REASON, continuationCount: 4, supervisions: 1 });
    expect(jobs.get(job.id)!.mainReplyAt).toBeUndefined();
  });

  it('keeps a job going as it is: the main chat\'s own look over BotBoy\'s pauses only, the owner\'s turn over any', async () => {
    const desk = makeDesk();
    const limited = jobs.start({ goal: 'g', title: 'Long one' });
    for (let i = 0; i < 25; i++) jobs.incrementContinuations(limited.id);
    jobs.settle(limited.id, { action: 'pause', note: 'Paused after 25 automatic turns in a row.', kind: 'limit' }, 'answered');
    const kept = await desk.continueJob(limited.id, { from: 'review' });
    expect(kept).toMatchObject({ ok: true, job: { id: limited.id, reopened: false }, note: `#${limited.seq} carries on now in its own thread, with a fresh round of automatic turns.` });
    expect(jobs.get(limited.id)).toMatchObject({ continueReason: JOB_CONTINUE_REASON, continuationCount: 0, supervisions: 1 });
    expect(rows()).toEqual([{ role: 'assistant', content: '↪ The main chat looked at this job and kept it going as it is.', jobId: limited.id, refJobId: null }]);
    expect(events).toEqual([`request:${limited.id}`, 'bump']);
    // Nothing paused: it already carries on by itself.
    expect(await desk.continueJob(limited.id, { from: 'review' })).toMatchObject({ ok: false, code: 'nothing_to_continue' });
    // A question waits for its answer; the owner's own pause stays his.
    const asking = jobs.start({ goal: 'q', title: 'Asks' });
    jobs.settle(asking.id, { action: 'pause', note: 'Which month?', kind: 'question' }, 'answered');
    expect(await desk.continueJob(asking.id, { from: 'review' })).toMatchObject({ ok: false, code: 'needs_answer' });
    const owners = jobs.start({ goal: 'o', title: 'Owner paused' });
    jobs.pauseByOwner(owners.id);
    expect(await desk.continueJob(owners.id, { from: 'review' })).toMatchObject({ ok: false, code: 'owner_paused' });
    // The owner's turn in the main chat: his own word, over his pause and over an ended job.
    expect(await desk.continueJob(owners.id, { from: 'main_chat' })).toMatchObject({ ok: true, job: { reopened: false } });
    expect(jobs.get(owners.id)!.pausedAt).toBeUndefined();
    expect(rows().at(-1)).toMatchObject({ content: '↪ From the main chat: carry on.', jobId: owners.id });
    const ended = doneJob('Ended', 'Done.');
    expect(await desk.continueJob(ended.id, { from: 'review' })).toMatchObject({ ok: false, code: 'job_not_active' });
    expect(await desk.continueJob(ended.id, { from: 'main_chat' })).toMatchObject({ ok: true, job: { status: 'active', reopened: true } });
    const stopped = jobs.start({ goal: 's', title: 'Stopped' });
    jobs.end(stopped.id, 'stopped', 'stopped by the owner');
    expect(await desk.continueJob(stopped.id, { from: 'main_chat' })).toMatchObject({ ok: false, code: 'job_stopped' });
    ownerInJob.add(asking.id);
    expect(await desk.continueJob(asking.id, { from: 'main_chat' })).toMatchObject({ ok: false, code: 'owner_turn_active' });
  });

  it('asks the owner for the main chat, its rounds used up included, and never over his own pause or another question', () => {
    const desk = makeDesk();
    const job = jobs.start({ goal: 'g', title: 'Cohorts' });
    for (let i = 0; i < MAX_REVIEW_ROUNDS; i++) {
      jobs.settle(job.id, { action: 'pause', note: 'stuck', kind: 'stuck' }, 'repeat_breaker');
      jobs.continueJob(job.id, { from: 'review' });
    }
    jobs.settle(job.id, { action: 'pause', note: 'stuck', kind: 'stuck' }, 'repeat_breaker');
    const asked = desk.askOwner(job.id, 'Use the 2023 or the 2024 cohort?', ['Use 2023', 'Use 2024']);
    expect(asked).toMatchObject({ ok: true, note: `The owner sees the question on #${job.seq}'s card with its one-tap answers; the job carries on when they answer.` });
    expect(jobs.get(job.id)).toMatchObject({ pauseKind: 'question', options: ['Use 2023', 'Use 2024'] });
    expect(rows()).toEqual([{ role: 'assistant', content: '↪ The main chat looked at this job and asks you: Use the 2023 or the 2024 cohort?', jobId: job.id, refJobId: null }]);
    expect(desk.askOwner(job.id, 'Again?', [])).toMatchObject({ ok: false, code: 'not_delivered' });
    const plain = jobs.start({ goal: 'p', title: 'Plain' });
    expect(desk.askOwner(plain.id, 'Which disk?', [])).toMatchObject({ ok: true, note: expect.stringContaining('an Answer button') });
    const fresh = jobs.start({ goal: 'f', title: 'Fresh' });
    expect(desk.askOwner(fresh.id, '  ', [])).toMatchObject({ ok: false, code: 'empty_message' });
    jobs.pauseByOwner(fresh.id);
    expect(desk.askOwner(fresh.id, 'Which disk?', [])).toMatchObject({ ok: false, code: 'owner_paused' });
    expect(desk.askOwner('cj_missing', 'Which disk?', [])).toMatchObject({ ok: false, code: 'job_not_found' });
  });

  it('the job\'s reply and a job\'s update line come back to the main chat, after the owner\'s reply there ends', () => {
    const job = jobs.start({ goal: 'g', title: 'Weekly players' });
    busy = true;
    const desk = makeDesk();
    desk.postReply(job.id, '  Switched to dataset_date; rerunning March.  ');
    desk.postUpdateLine(job.id, `  #${job.seq} Weekly players is stuck: the query kept timing out. Reply in #${job.seq} with how to go on.  `);
    desk.postReply(job.id, '   ');
    desk.postUpdateLine(job.id, '   ');
    desk.postReply('cj_missing', 'nothing');
    desk.postUpdateLine('cj_missing', 'nothing');
    expect(rows()).toEqual([]);
    busy = false;
    desk.flush();
    const posted = rows();
    expect(posted.map(row => row.refJobId)).toEqual([job.id, job.id]);
    expect(posted.every(row => row.jobId === null && row.role === 'assistant')).toBe(true);
    expect(posted[0].content).toBe('Switched to dataset_date; rerunning March.');
    const line = `#${job.seq} Weekly players is stuck: the query kept timing out. Reply in #${job.seq} with how to go on.`;
    expect(posted[1].content).toBe(`${line}\n\n[[job:${job.id}:update]]`);
    expect(history.map(entry => entry.text)).toEqual([
      `Job #${job.seq} "Weekly players" replied to the main chat's message:\n\nSwitched to dataset_date; rerunning March.`,
      line,
    ]);
    // Nothing is posted twice.
    desk.flush();
    expect(rows()).toHaveLength(2);
  });

  it('posts at once when the main chat is free, and a failing post never breaks the others', () => {
    const job = jobs.start({ goal: 'g', title: 'Quick' });
    const lines: string[] = [];
    let calls = 0;
    const desk = makeDesk({
      log: (line) => { lines.push(line); },
      appendMainHistory: () => { calls += 1; throw new Error('history is gone'); },
    });
    desk.postReply(job.id, 'Done with March.');
    desk.postUpdateLine(job.id, 'Quick asks you: which month?');
    expect(rows().map(row => row.content)).toEqual(['Done with March.', `Quick asks you: which month?\n\n[[job:${job.id}:update]]`]);
    expect(calls).toBe(2);
    expect(lines.join('\n')).toContain('could not add a job note to the main chat\'s history');
  });
});

describe('job desk: a report the main chat already shows', () => {
  it('posts the job\'s card alone under the owner\'s #N reply, and its history keeps the words', () => {
    const storage = createStorage(':memory:');
    storage.initialize();
    try {
      const jobs = createChatJobStore(storage.getDb());
      const history: string[] = [];
      const desk = createJobDesk({
        db: storage.getDb(), jobs, mainSessionId: () => 'main', appendMainHistory: (_, text) => { history.push(text); },
        mainOwnerTurnActive: () => false, ownerTurnInJob: () => false, preempt: async () => {}, request: () => {}, bump: () => {}, log: () => {},
      });
      const routed = jobs.start({ goal: 'a', title: 'Routed' });
      jobs.end(routed.id, 'done', 'done');
      jobs.recordReport(routed.id, 'Added February: 4,120 players.');
      desk.noteReportShown(routed.id);
      const plain = jobs.start({ goal: 'b', title: 'Plain' });
      jobs.end(plain.id, 'done', 'done');
      jobs.recordReport(plain.id, 'Built the dashboard.');
      expect(desk.deliverReports()).toBe(2);
      const contents = (storage.getDb().prepare('SELECT content FROM chat_messages ORDER BY rowid').all() as Array<{ content: string }>).map(row => row.content);
      expect(contents).toEqual([`[[job:${routed.id}:report]]`, `Built the dashboard.\n\n[[job:${plain.id}:report]]`]);
      expect(history[0]).toContain('Added February: 4,120 players.');
      // Once posted, the job reports with its words again the next time it is done.
      jobs.deliverMessage(routed.id, { from: 'main_chat', text: 'Add March too.' });
      jobs.end(routed.id, 'done', 'done');
      jobs.recordReport(routed.id, 'Added March.');
      expect(desk.deliverReports()).toBe(1);
      expect((storage.getDb().prepare('SELECT content FROM chat_messages ORDER BY rowid DESC LIMIT 1').get() as { content: string }).content)
        .toBe(`Added March.\n\n[[job:${routed.id}:report]]`);
    } finally {
      storage.close();
    }
  });
});
