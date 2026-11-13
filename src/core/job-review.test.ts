import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createStorage, type StorageLayer } from './storage.js';
import { CHAT_JOB_MAX_CONTINUATIONS, createChatJobStore, MAX_REVIEW_ROUNDS, type ChatJob, type ChatJobStore, type EtlRunWatch } from './chat-jobs.js';
import { CONTINUATION_HEADER, isContinuationTrigger, JOB_UPDATE_TRIGGER_HEADER } from './chat-continuations.js';
import {
  buildReviewTrigger,
  createJobReviewRunner,
  DECISION_HIDE_MAX_MS,
  dueReview,
  fallbackLine,
  isReviewDecision,
  QUESTION_GRACE_MS,
  reviewDecisionCheck,
  reviewNote,
  reviewStateOpen,
  WAIT_EVERY_MS,
  WAIT_FIRST_MS,
  type JobReviewRunnerOptions,
} from './job-review.js';

/**
 * The main chat decides on job updates (PARALLEL_JOBS_PLAN.md §12, owner decision 2026-11-09): which job states it looks at, what
 * it reads, and how the runner starts one main-chat turn at a time and makes sure the owner always hears.
 */
const T0 = Date.parse('2026-11-09T03:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();

describe('which job states the main chat looks at', () => {
  let storage: StorageLayer;
  let jobs: ChatJobStore;
  let base: ChatJob;
  beforeEach(() => {
    storage = createStorage(':memory:');
    storage.initialize();
    jobs = createChatJobStore(storage.getDb());
    base = { ...jobs.start({ goal: 'Weekly PV players for Local', title: 'Weekly players' }), lastActivityAt: iso(T0) };
  });
  afterEach(() => storage.close());
  const pending = (over: Partial<EtlRunWatch> = {}): EtlRunWatch => ({
    runId: '901', jobId: base.id, source: 'run_query', status: 'pending', submittedAt: iso(T0), pollFailures: 0, ...over,
  });
  const at = (ms: number, job: ChatJob, watches: EtlRunWatch[] = [], running = false) => dueReview(job, { nowMs: ms, pendingWatches: watches, running });

  it('BotBoy\'s own pauses at once, a question after its grace, never the owner\'s pause', () => {
    const limit = { ...base, pausedAt: iso(T0), pauseKind: 'limit' as const };
    expect(at(T0, limit)).toEqual({ jobId: base.id, key: `limit:${iso(T0)}`, kind: 'limit', since: iso(T0) });
    expect(at(T0, { ...limit, pauseKind: 'stuck' })).toMatchObject({ key: `stuck:${iso(T0)}`, kind: 'stuck' });
    const question = { ...limit, pauseKind: 'question' as const };
    expect(at(T0 + QUESTION_GRACE_MS - 1, question)).toBeNull();
    expect(at(T0 + QUESTION_GRACE_MS, question)).toMatchObject({ key: `question:${iso(T0)}`, kind: 'question' });
    expect(at(T0 + 10 * WAIT_EVERY_MS, { ...limit, pauseKind: 'paused' }, [pending()])).toBeNull();
  });

  it('a long wait after an hour, then every two hours, each stretch its own state', () => {
    expect(at(T0 + WAIT_FIRST_MS - 1, base, [pending()])).toBeNull();
    expect(at(T0 + WAIT_FIRST_MS, base, [pending()])).toEqual({ jobId: base.id, key: `wait:${iso(T0)}:0`, kind: 'wait', since: iso(T0) });
    expect(at(T0 + WAIT_FIRST_MS + WAIT_EVERY_MS - 1, base, [pending()])).toMatchObject({ key: `wait:${iso(T0)}:0` });
    expect(at(T0 + WAIT_FIRST_MS + WAIT_EVERY_MS, base, [pending({ source: 'dashboard', runId: 'run_abd1cfcd40e545fe' })])).toMatchObject({ key: `wait:${iso(T0)}:1` });
    // Not a wait: nothing pending, a turn running, a turn due (a provider or network wait included), an ended or provisional job.
    expect(at(T0 + 5 * WAIT_FIRST_MS, base)).toBeNull();
    expect(at(T0 + 5 * WAIT_FIRST_MS, base, [pending()], true)).toBeNull();
    expect(at(T0 + 5 * WAIT_FIRST_MS, { ...base, continueRequestedAt: iso(T0) }, [pending()])).toBeNull();
    expect(at(T0 + 5 * WAIT_FIRST_MS, { ...base, status: 'done' }, [pending()])).toBeNull();
    expect(at(T0 + 5 * WAIT_FIRST_MS, { ...base, seq: undefined as any }, [pending()])).toBeNull();
  });

  it('a state claimed or decided is not due again; a new one is', () => {
    const limit = { ...base, pausedAt: iso(T0), pauseKind: 'limit' as const };
    expect(at(T0, { ...limit, reviewKey: `limit:${iso(T0)}` })).toBeNull();
    expect(at(T0, { ...limit, reviewedKey: `limit:${iso(T0)}` })).toBeNull();
    expect(at(T0, { ...limit, reviewedKey: `limit:${iso(T0 - 1)}` })).toMatchObject({ key: `limit:${iso(T0)}` });
    expect(at(T0 + WAIT_FIRST_MS + WAIT_EVERY_MS, { ...base, reviewedKey: `wait:${iso(T0)}:0` }, [pending()])).toMatchObject({ key: `wait:${iso(T0)}:1` });
  });

  it('says what happened in one line, and gives the owner the line and card when he has to act', () => {
    const limit = { ...base, pausedAt: iso(T0), pauseKind: 'limit' as const };
    const event = (kind: 'limit' | 'stuck' | 'question' | 'wait') => ({ jobId: base.id, key: `${kind}:x`, kind, since: iso(T0) });
    const named = `#${base.seq} Weekly players`;
    expect(reviewNote(limit, event('limit'), T0)).toBe(`↻ Job update: ${named} paused after ${CHAT_JOB_MAX_CONTINUATIONS} automatic turns in a row.`);
    expect(reviewNote(limit, event('stuck'), T0)).toBe(`↻ Job update: ${named} is stuck.`);
    expect(reviewNote(limit, event('question'), T0)).toBe(`↻ Job update: ${named} has a question.`);
    expect(reviewNote(limit, event('wait'), T0 + 3 * 60 * 60_000 + 5 * 60_000)).toBe(`↻ Job update: ${named} has been waiting 3 h 5 min.`);
    const stuck = { ...limit, pauseKind: 'stuck' as const, pauseNote: 'Two turns in a row failed. Reply to try again.' };
    expect(fallbackLine(stuck, event('stuck'), 'rounds', T0))
      .toBe(`${named} is stuck: Two turns in a row failed. I have kept it going ${MAX_REVIEW_ROUNDS} times without you, so this one is yours. Reply in #${base.seq} with how to go on.`);
    expect(fallbackLine({ ...stuck, pauseNote: 'Reply to continue.' }, event('stuck'), 'no_turn', T0))
      .toBe(`${named} is stuck: it stopped without finishing. Reply in #${base.seq} with how to go on.`);
    expect(fallbackLine(limit, event('limit'), 'no_turn', T0)).toBe(`${named} paused after ${CHAT_JOB_MAX_CONTINUATIONS} automatic turns in a row. Reply in #${base.seq} to keep it going.`);
    expect(fallbackLine({ ...limit, pauseNote: 'Which cohort?' }, event('question'), 'no_turn', T0)).toBe(`${named} asks you: Which cohort?`);
    expect(fallbackLine(limit, event('wait'), 'rounds', T0 + 90 * 60_000)).toContain(`${named} has been waiting 1 h 30 min for its runs to finish.`);
  });

  it('the update the main chat reads: BotBoy\'s words with the request, what happened, what it waits on, its last words and tool calls', () => {
    jobs.update(base.id, { nextStep: 'Rebuild the weekly widget' });
    const job: ChatJob = {
      ...jobs.get(base.id)!, pausedAt: iso(T0), pauseKind: 'stuck', pauseNote: 'I was repeating the same step, so I stopped.', supervisions: 1,
      lastTools: Array.from({ length: 10 }, (_, i) => ({ name: `tool_${i}`, args: `{"i":${i}}`, result: i === 9 ? `{"error":"column dt does not exist ${'e'.repeat(600)}"}` : `ok ${'r'.repeat(300)}` })),
    };
    const watches: EtlRunWatch[] = [
      { runId: '901', jobId: job.id, purpose: 'weekly players', source: 'run_query', status: 'pending', remoteStatus: 'WAITING_FOR_RESOURCES', submittedAt: iso(T0 - 40 * 60_000), pollFailures: 0, prioritizedAt: iso(T0) },
      { runId: 'run_abd1cfcd40e545fe', jobId: job.id, purpose: 'refresh of dashboard "Downloads"', source: 'dashboard', status: 'pending', submittedAt: iso(T0 - 26 * 60_000), pollFailures: 0 },
      { runId: '800', jobId: job.id, source: 'run_query', status: 'finished', submittedAt: iso(T0 - 90 * 60_000), pollFailures: 0 },
    ];
    const trigger = buildReviewTrigger(job, { jobId: job.id, key: `stuck:${iso(T0)}`, kind: 'stuck', since: iso(T0) }, {
      nowMs: T0, watches, replies: ['one', 'two', 'three', `four ${'w'.repeat(600)}`],
    });
    expect(trigger.startsWith(`${JOB_UPDATE_TRIGGER_HEADER}\n`)).toBe(true);
    // BotBoy's words, never the owner's: the history window does not count it as one of the owner's messages.
    expect(isContinuationTrigger(trigger)).toBe(true);
    expect(trigger).toContain(`Job #${job.seq} "Weekly players" needs a decision. It could not get past a problem and stopped: "I was repeating the same step, so I stopped."`);
    expect(trigger).toContain('The owner\'s request: "Weekly PV players for Local"');
    expect(trigger).toContain('Next step it recorded: Rebuild the weekly widget');
    expect(trigger).toContain('- Datanet ETL run 901 (weekly players): WAITING_FOR_RESOURCES after 40 min, BotBoy already asked Datanet to prioritize it');
    expect(trigger).toContain('- the refresh of dashboard "Downloads" (run_abd1cfcd40e545fe): still running after 26 min');
    expect(trigger).not.toContain('run 800');
    expect(trigger).toContain('Its last replies, oldest first:\n- two\n- three\n- four');
    expect(trigger).not.toContain('- one');
    // The last eight tool calls; a failed result keeps more of its words.
    expect(trigger).not.toContain('tool_1(');
    expect(trigger).toContain('- tool_2({"i":2}) → ok');
    expect(trigger).toMatch(/- tool_9\(\{"i":9\}\) → \{"error":"column dt does not exist e{400,}/);
    expect(trigger).toContain(`Rounds you have kept this job going without the owner: 1 of ${MAX_REVIEW_ROUNDS}.`);
    expect(trigger).toContain('decide as the JOB UPDATES section of your instructions says');
    expect(trigger.length).toBeLessThan(6_000);
    const question = buildReviewTrigger({ ...job, pauseKind: 'question', pauseNote: 'Use 2023 or 2024?', options: ['Use 2023', 'Use 2024'] },
      { jobId: job.id, key: `question:${iso(T0)}`, kind: 'question', since: iso(T0) }, { nowMs: T0 + 5 * 60_000, watches: [], replies: [] });
    // The question is the main chat's to answer first (owner report 2026-11-09), and each kind names the calls that decide it.
    expect(question).toContain('It stopped to ask: "Use 2023 or 2024?" (its one-tap answers: Use 2023 / Use 2024), 5 min ago. The question comes to you before the owner: answer it yourself unless only he can decide.');
    expect(question).not.toContain('It asks the owner');
    expect(question).not.toContain('It waits for:');
    expect(question).toContain('end with jobs message or jobs ask_owner, and tell the owner in one or two short sentences what you did.');
    expect(trigger).toContain('Check what it is blocked on, then decide as the JOB UPDATES section of your instructions says: end with jobs message, jobs continue or jobs ask_owner');
    const wait = buildReviewTrigger(base, { jobId: base.id, key: `wait:${iso(T0)}:0`, kind: 'wait', since: iso(T0) }, { nowMs: T0 + WAIT_FIRST_MS, watches, replies: [] });
    expect(wait).toContain('(a job whose runs are still moving can simply wait)');
    expect(wait).not.toContain('end with jobs');
  });

  it('what counts as the main chat\'s decision, and the one check it gets when it replies without one', () => {
    expect(isReviewDecision('{"action":"message","job":"#1","text":"Split the query by week"}', '{\n "ok": true,\n "messaged": true\n}')).toBe(true);
    expect(isReviewDecision('{"action":"continue","job":"#1"}', '{"ok":true}')).toBe(true);
    expect(isReviewDecision('{"action":"ask_owner","job":"#1","text":"Send it?"}', '{"ok":true,"asked":true}')).toBe(true);
    // Reading is not deciding; nor is a call the tool refused, or arguments it could not read.
    expect(isReviewDecision('{"action":"read","job":"#1"}', '{"ok":true}')).toBe(false);
    expect(isReviewDecision('{"action":"list"}', '{"ok":true}')).toBe(false);
    expect(isReviewDecision('{"action":"message","job":"#1","text":"x"}', '{"ok":false,"code":"job_not_found"}')).toBe(false);
    expect(isReviewDecision('{"action":"continue"', '{"ok":true}')).toBe(false);
    expect(isReviewDecision('{"action":"message"}', '{"status":"blocked","code":"outside_job_update"}')).toBe(false);
    expect(isReviewDecision('{"action":"message"}', 'not json')).toBe(false);

    const question = { ...base, pausedAt: iso(T0), pauseKind: 'question' as const, pauseNote: 'Close with the gaps?' };
    expect(reviewStateOpen(question, `question:${iso(T0)}`)).toBe(true);
    // Moved on: answered (no pause), a new pause, ended, the owner's own pause, or an update about a wait.
    expect(reviewStateOpen({ ...question, pausedAt: undefined }, `question:${iso(T0)}`)).toBe(false);
    expect(reviewStateOpen({ ...question, pausedAt: iso(T0 + 1) }, `question:${iso(T0)}`)).toBe(false);
    expect(reviewStateOpen({ ...question, status: 'done' }, `question:${iso(T0)}`)).toBe(false);
    expect(reviewStateOpen({ ...question, pauseKind: 'paused' }, `paused:${iso(T0)}`)).toBe(false);
    expect(reviewStateOpen(base, `wait:${iso(T0)}:0`)).toBe(false);
    expect(reviewStateOpen(null, `question:${iso(T0)}`)).toBe(false);

    const check = reviewDecisionCheck(question);
    expect(check.startsWith('JOB UPDATE CHECK (internal: the owner cannot see this; do not mention it)')).toBe(true);
    expect(check).toContain(`job #${base.seq} is still paused and you have not decided`);
    expect(check).toContain('jobs message with the answer to its question or the next step to take');
    expect(check).toContain('jobs ask_owner only when the choice is the owner\'s');
    // A question needs an answer: continue is offered only after the turn limit or when stuck.
    expect(check).not.toContain('jobs continue');
    expect(reviewDecisionCheck({ ...question, pauseKind: 'limit' })).toContain('jobs continue when it was making progress');
    expect(reviewDecisionCheck({ ...question, pauseKind: 'stuck' })).toContain('jobs continue once the cause has passed');
  });
});

describe('the runner: one main-chat turn at a time, and the owner always hears', () => {
  let storage: StorageLayer;
  let jobs: ChatJobStore;
  let ownerTalking: boolean;
  let running: Set<string>;
  let lines: Array<{ jobId: string; line: string }>;
  let logs: string[];
  beforeEach(() => {
    storage = createStorage(':memory:');
    storage.initialize();
    jobs = createChatJobStore(storage.getDb());
    ownerTalking = false;
    running = new Set();
    lines = [];
    logs = [];
  });
  afterEach(() => storage.close());

  const desk = { postUpdateLine: (jobId: string, line: string) => { lines.push({ jobId, line }); } };
  function makeRunner(fetchImpl: (url: string, init: any) => Promise<Response>, over: Partial<JobReviewRunnerOptions> = {}) {
    return createJobReviewRunner({
      jobs,
      url: 'http://127.0.0.1:7778/api/chat/messages',
      secret: 'secret-1',
      mainOwnerTurnActive: () => ownerTalking,
      jobRunning: (jobId) => running.has(jobId),
      mainModel: () => ({ key: 'team.sol', thinking: 'high' }),
      threadReplies: () => ['Built two of the three widgets.'],
      desk: () => desk as any,
      fetchImpl: fetchImpl as any,
      scheduleTick: () => {},
      log: (line) => { logs.push(line); },
      ...over,
    });
  }
  function limited(title: string): { job: ChatJob; key: string } {
    const job = jobs.start({ goal: `Build ${title}`, title });
    jobs.settle(job.id, { action: 'pause', note: 'Paused after 25 automatic turns in a row. Reply to continue.', kind: 'limit' }, 'answered');
    const paused = jobs.get(job.id)!;
    return { job: paused, key: `limit:${paused.pausedAt}` };
  }
  /** A fetch whose streams stay open until released (a main-chat turn that is still running). */
  function heldFetch() {
    const calls: Array<{ url: string; init: any }> = [];
    const releases: Array<() => void> = [];
    const fetchImpl = vi.fn(async (url: string, init: any) => {
      calls.push({ url, init });
      let close: () => void = () => {};
      const body = new ReadableStream({ start(controller) { close = () => controller.close(); } });
      releases.push(() => close());
      return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    });
    return { fetchImpl, calls, release: (index = 0) => releases[index]() };
  }
  const refusal = (status: number, code: string, error = 'refused') => async () => new Response(JSON.stringify({ code, error }), { status });

  it('claims the oldest due state and starts one turn on the owner\'s main-chat model; the next waits for it to end', async () => {
    const first = limited('Weekly players');
    const second = limited('Monthly report');
    const held = heldFetch();
    const runner = makeRunner(held.fetchImpl);
    await runner.tick();
    expect(held.calls).toHaveLength(1);
    const { url, init } = held.calls[0];
    expect(url).toBe('http://127.0.0.1:7778/api/chat/messages');
    expect(init.headers).toMatchObject({ [CONTINUATION_HEADER]: 'secret-1' });
    const body = JSON.parse(init.body);
    expect(body).toMatchObject({
      stream: true, model: 'team.sol', thinking: 'high',
      review: { jobId: first.job.id, key: first.key, note: `↻ Job update: #${first.job.seq} Weekly players paused after ${CHAT_JOB_MAX_CONTINUATIONS} automatic turns in a row.` },
    });
    expect(body.message.startsWith(JOB_UPDATE_TRIGGER_HEADER)).toBe(true);
    expect(body.message).toContain('- Built two of the three widgets.');
    expect(jobs.get(first.job.id)).toMatchObject({ reviewKey: first.key });
    expect(runner.isReviewing(first.job.id)).toBe(true);
    expect(runner.isPending(first.job.id)).toBe(true);
    // One at a time: the other job's update waits.
    await runner.tick();
    expect(held.calls).toHaveLength(1);
    // The chat route settles the claim when its turn ends; then the next one starts.
    jobs.finishReview(first.job.id, first.key);
    held.release(0);
    await runner.idle();
    expect(runner.isReviewing(first.job.id)).toBe(false);
    await runner.tick();
    expect(held.calls).toHaveLength(2);
    expect(JSON.parse(held.calls[1].init.body).review).toMatchObject({ jobId: second.job.id, key: second.key });
    held.release(1);
    await runner.idle();
  });

  it('never starts while the owner talks in the main chat, and runs on the chat default when his model is not known', async () => {
    const { job } = limited('Weekly players');
    const held = heldFetch();
    ownerTalking = true;
    const runner = makeRunner(held.fetchImpl, { mainModel: () => ({ thinking: 'off' }) });
    await runner.tick();
    expect(held.calls).toHaveLength(0);
    expect(jobs.get(job.id)!.reviewKey).toBeUndefined();
    ownerTalking = false;
    await runner.tick();
    const body = JSON.parse(held.calls[0].init.body);
    expect(body.model).toBeUndefined(); // the chat default serves
    expect(body.thinking).toBe('off');
    held.release();
    await runner.idle();
  });

  it('a refused turn: due again when the main chat is busy, settled when the job moved on, the owner\'s line when no turn can run', async () => {
    for (const code of ['owner_turn_active', 'review_turn_active', 'turn_in_progress']) {
      const { job } = limited(`Busy ${code}`);
      const busy = makeRunner(refusal(409, code));
      await busy.tick();
      await busy.idle();
      expect(jobs.get(job.id)!.reviewKey, code).toBeUndefined();
      expect(jobs.get(job.id)!.reviewedKey, code).toBeUndefined();
      jobs.end(job.id, 'stopped', 'test');
    }
    for (const code of ['job_not_active', 'review_not_claimed']) {
      const { job, key } = limited(`Moved ${code}`);
      const runner = makeRunner(refusal(409, code));
      await runner.tick();
      await runner.idle();
      expect(jobs.get(job.id)).toMatchObject({ reviewedKey: key });
      jobs.end(job.id, 'stopped', 'test');
    }
    expect(lines).toEqual([]);
    const { job, key } = limited('No model');
    const runner = makeRunner(refusal(409, 'ai_model_not_configured', 'Chat needs an AI model first.'));
    await runner.tick();
    await runner.idle();
    expect(lines).toEqual([{ jobId: job.id, line: `#${job.seq} No model paused after ${CHAT_JOB_MAX_CONTINUATIONS} automatic turns in a row. Reply in #${job.seq} to keep it going.` }]);
    expect(jobs.get(job.id)).toMatchObject({ reviewedKey: key });
    expect(logs.join('\n')).toContain('no update turn (Chat needs an AI model first.); the owner gets its card');
  });

  it('a route it cannot reach leaves the state due again', async () => {
    const { job } = limited('Weekly players');
    const runner = makeRunner(async () => { throw new TypeError('fetch failed'); });
    await runner.tick();
    await runner.idle();
    expect(jobs.get(job.id)!.reviewKey).toBeUndefined();
    expect(jobs.get(job.id)!.reviewedKey).toBeUndefined();
    expect(logs.join('\n')).toContain('could not reach the chat route (fetch failed)');
    expect(lines).toEqual([]);
  });

  it(`after ${MAX_REVIEW_ROUNDS} rounds without the owner, the owner gets the job's line and card instead of another turn`, async () => {
    const job = jobs.start({ goal: 'g', title: 'Weekly players' });
    for (let i = 0; i < MAX_REVIEW_ROUNDS; i++) {
      jobs.settle(job.id, { action: 'pause', note: 'repeating', kind: 'stuck' }, 'repeat_breaker');
      jobs.continueJob(job.id, { from: 'review' });
    }
    jobs.settle(job.id, { action: 'pause', note: 'I was repeating the same step, so I stopped. Reply with how to proceed.', kind: 'stuck' }, 'repeat_breaker');
    const fetchImpl = vi.fn();
    const runner = makeRunner(fetchImpl as any);
    await runner.tick();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(lines).toEqual([{ jobId: job.id, line: `#${job.seq} Weekly players is stuck: I was repeating the same step, so I stopped. I have kept it going ${MAX_REVIEW_ROUNDS} times without you, so this one is yours. Reply in #${job.seq} with how to go on.` }]);
    expect(jobs.get(job.id)).toMatchObject({ reviewedKey: `stuck:${jobs.get(job.id)!.pausedAt}` });
    // Handled once: the next tick posts nothing more. The owner's own word starts the count over.
    await runner.tick();
    expect(lines).toHaveLength(1);
    jobs.ownerResumed(job.id);
    expect(jobs.get(job.id)!.supervisions).toBe(0);
  });

  it('a restart releases every claimed state, so none waits forever for a turn that died with the old process', () => {
    const { job, key } = limited('Weekly players');
    expect(jobs.claimReview(job.id, key)).toBe(true);
    const runner = makeRunner(heldFetch().fetchImpl);
    runner.start();
    try {
      expect(jobs.get(job.id)!.reviewKey).toBeUndefined();
      expect(logs).toContain('[JobReview] 1 job update(s) interrupted by the restart are due again');
    } finally {
      runner.stop();
    }
  });

  it('holds BotBoy\'s pause from the WhatsApp notifier until the main chat has looked at it', async () => {
    const { job, key } = limited('Weekly players');
    const runner = makeRunner(heldFetch().fetchImpl, { now: () => Date.now() });
    expect(runner.isPending(job.id)).toBe(true);
    jobs.finishReview(job.id, key);
    expect(runner.isPending(job.id)).toBe(false);
    // A question is held through its grace and its look; the main chat's own question is not held at all.
    const asking = jobs.start({ goal: 'q', title: 'Asks' });
    jobs.settle(asking.id, { action: 'pause', note: 'Which cohort?', kind: 'question' }, 'answered');
    expect(runner.isPending(asking.id)).toBe(true);
    const asked = jobs.start({ goal: 'a', title: 'Asked by the main chat' });
    jobs.askOwner(asked.id, 'Use 2023 or 2024?', ['Use 2023', 'Use 2024']);
    expect(runner.isPending(asked.id)).toBe(false);
    // The owner's own pause and an ended job are his already.
    const owners = jobs.start({ goal: 'o', title: 'Owner paused' });
    jobs.pauseByOwner(owners.id);
    expect(runner.isPending(owners.id)).toBe(false);
    jobs.end(asking.id, 'stopped', 'test');
    expect(runner.isPending(asking.id)).toBe(false);
    // A long wait is held while its look is due, not before.
    const waiting = jobs.start({ goal: 'w', title: 'Waits' });
    jobs.addWatch({ runId: '901', jobId: waiting.id, source: 'run_query' });
    expect(runner.isPending(waiting.id)).toBe(false);
    const later = makeRunner(heldFetch().fetchImpl, { now: () => Date.now() + WAIT_FIRST_MS + 1_000 });
    expect(later.isPending(waiting.id)).toBe(true);
    running.add(waiting.id);
    expect(later.isPending(waiting.id)).toBe(false);
  });

  it('BotBoy\'s pause reads as being looked at until the main chat decides, never the owner\'s pause, and never past its limit', async () => {
    // Owner report 2026-11-09: the job's question kept showing as a card while the main chat was to guide it.
    const asking = jobs.start({ goal: 'q', title: 'Asks' });
    jobs.settle(asking.id, { action: 'pause', note: 'Close with the gaps?', kind: 'question' }, 'answered');
    const pausedAt = Date.parse(jobs.get(asking.id)!.pausedAt!);
    let clock = pausedAt;
    const held = heldFetch();
    const runner = makeRunner(held.fetchImpl, { now: () => clock });
    // Its grace, then the main chat's turn: looked at, not the owner's.
    expect(runner.awaitsDecision(asking.id)).toBe(true);
    clock = pausedAt + QUESTION_GRACE_MS;
    await runner.tick();
    expect(held.calls).toHaveLength(1);
    expect(runner.awaitsDecision(asking.id)).toBe(true);
    // Decided without guidance: the question is the owner's now.
    jobs.finishReview(asking.id, `question:${iso(pausedAt)}`);
    held.release();
    await runner.idle();
    expect(runner.awaitsDecision(asking.id)).toBe(false);
    // An update that stalls never hides a question for long.
    const stalled = limited('Stalled');
    const stalledAt = Date.parse(stalled.job.pausedAt!);
    clock = stalledAt + DECISION_HIDE_MAX_MS - 1;
    expect(runner.awaitsDecision(stalled.job.id)).toBe(true);
    clock = stalledAt + DECISION_HIDE_MAX_MS;
    expect(runner.awaitsDecision(stalled.job.id)).toBe(false);
    // The main chat's own question, the owner's pause, a running or waiting job, and an ended one are not looked at.
    clock = Date.now();
    const asked = jobs.start({ goal: 'a', title: 'Asked by the main chat' });
    jobs.askOwner(asked.id, 'Send the draft?', ['Send it', 'Keep it']);
    expect(runner.awaitsDecision(asked.id)).toBe(false);
    const owners = jobs.start({ goal: 'o', title: 'Owner paused' });
    jobs.pauseByOwner(owners.id);
    expect(runner.awaitsDecision(owners.id)).toBe(false);
    const waiting = jobs.start({ goal: 'w', title: 'Waits' });
    jobs.addWatch({ runId: '902', jobId: waiting.id, source: 'run_query' });
    expect(runner.awaitsDecision(waiting.id)).toBe(false);
    jobs.end(asking.id, 'stopped', 'test');
    expect(runner.awaitsDecision(asking.id)).toBe(false);
    expect(runner.awaitsDecision('cj_000000000000000000000000')).toBe(false);
  });

  it('stop aborts the running turn', async () => {
    limited('Weekly players');
    const held = heldFetch();
    const runner = makeRunner(held.fetchImpl);
    await runner.tick();
    const signal: AbortSignal = held.calls[0].init.signal;
    expect(signal.aborted).toBe(false);
    runner.stop();
    expect(signal.aborted).toBe(true);
    held.release();
    await runner.idle();
    await runner.tick();
    expect(held.calls).toHaveLength(1);
  });
});

describe('which job updates the main chat shows (owner decision 2026-11-13)', () => {
  it('a message or continue is BotBoy handling it; a question for the owner, or no decision, still shows', async () => {
    const { isSelfHandledReview, reviewDecisionOf } = await import('./job-review.js');
    expect(reviewDecisionOf('{"action":"message","text":"x"}', '{"ok":true}')).toBe('message');
    expect(reviewDecisionOf('{"action":"continue"}', '{"ok":true}')).toBe('continue');
    expect(reviewDecisionOf('{"action":"ask_owner"}', '{"ok":true}')).toBe('ask_owner');
    expect(reviewDecisionOf('{"action":"read"}', '{"ok":true}')).toBeNull();
    expect(reviewDecisionOf('{"action":"continue"}', '{"ok":false}')).toBeNull();
    expect(reviewDecisionOf('not json', '{"ok":true}')).toBeNull();
    expect([undefined, null, 'ask_owner', 'message', 'continue'].map(isSelfHandledReview)).toEqual([false, false, false, true, true]);
  });
});
