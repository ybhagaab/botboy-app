/**
 * The main chat decides on job updates (PARALLEL_JOBS_PLAN.md §12, owner decision 2026-11-09: "for pauses, and any states which
 * happen in job the main chat model should be sent an update with a decision choice whether to keep the job going way it is or
 * whether to take any action. main chat should use its own intelligence & be able to use all tools to pull context details").
 *
 * The states are derived from the job row, like the WhatsApp notifier's events: BotBoy's turn limit, stuck, a question for the
 * owner (after QUESTION_GRACE_MS, so his own quick answer goes first), and a wait of WAIT_FIRST_MS or more (then every
 * WAIT_EVERY_MS). Never a pause the owner made, a provider wait, or an ended job. Each state has a key and is handled once:
 * claimed on the job row before its turn, finished when the chat route ends that turn, released (due again) when the turn did
 * not happen; a restart releases every claim.
 *
 * Handling a state is ONE main-chat turn of BotBoy's own (`callerKind` 'review', admitted by the chat route with the
 * continuation secret): the main chat model reads whatever it needs and keeps the job going, messages it, answers it, asks the
 * owner, or leaves it for him (job-mandate.ts › REVIEW_TOOLS, tool-executor.ts › jobs). One at a time, never during an owner
 * turn in the main chat. After MAX_REVIEW_ROUNDS rounds without the owner, or when no turn can run, the job's card goes to the
 * main chat instead, so the owner always hears.
 */
import {
  CHAT_JOB_MAX_CONTINUATIONS,
  MAX_REVIEW_ROUNDS,
  waitName,
  type ChatJob,
  type ChatJobStore,
  type ChatJobThinking,
  type EtlRunWatch,
} from './chat-jobs.js';
import { CONTINUATION_HEADER, JOB_UPDATE_TRIGGER_HEADER } from './chat-continuations.js';
import type { JobDesk } from './job-desk.js';

/** A question waits this long for the owner's own answer before the main chat looks at it. */
export const QUESTION_GRACE_MS = 60_000;
/**
 * A pause BotBoy made reads as being looked at, not as the owner's, until the main chat has decided on it (owner report
 * 2026-11-09: the job's question kept showing as a card). Past this, the owner sees it whatever happened: a stalled update never
 * hides a question from him.
 */
export const DECISION_HIDE_MAX_MS = 15 * 60_000;
/** A job that has waited this long on its runs or refreshes is looked at, and again every WAIT_EVERY_MS while it waits. */
export const WAIT_FIRST_MS = 60 * 60_000;
export const WAIT_EVERY_MS = 2 * 60 * 60_000;
const TICK_MS = 30_000;

export type JobReviewKind = 'limit' | 'stuck' | 'question' | 'wait';

export interface JobReviewEvent {
  jobId: string;
  /** Unique per state: a new pause, or another stretch of waiting, is a new key. */
  key: string;
  kind: JobReviewKind;
  /** When the state began (the pause, or the end of the job's last turn for a wait). */
  since: string;
}

/** The state of `job` the main chat should look at now, or null (§12 R2). Pure: derived from the job row and its waits. */
export function dueReview(job: ChatJob, input: { nowMs: number; pendingWatches: EtlRunWatch[]; running: boolean }): JobReviewEvent | null {
  if (job.status !== 'active' || !job.seq) return null;
  let event: JobReviewEvent | null = null;
  if (job.pausedAt && (job.pauseKind === 'limit' || job.pauseKind === 'stuck' || job.pauseKind === 'question')) {
    if (job.pauseKind === 'question' && input.nowMs - Date.parse(job.pausedAt) < QUESTION_GRACE_MS) return null;
    event = { jobId: job.id, key: `${job.pauseKind}:${job.pausedAt}`, kind: job.pauseKind, since: job.pausedAt };
  } else if (!job.pausedAt && !job.continueRequestedAt && !input.running && input.pendingWatches.some(watch => watch.kind !== 'time')) {
    // A time the job set ends on its own at a known moment: waiting for it alone is never news (docs/maps/job-waits.md).
    const waited = input.nowMs - Date.parse(job.lastActivityAt);
    if (!(waited >= WAIT_FIRST_MS)) return null;
    const stretch = Math.floor((waited - WAIT_FIRST_MS) / WAIT_EVERY_MS);
    event = { jobId: job.id, key: `wait:${job.lastActivityAt}:${stretch}`, kind: 'wait', since: job.lastActivityAt };
  }
  if (!event || job.reviewedKey === event.key || job.reviewKey === event.key) return null;
  return event;
}

const clip = (value: unknown, max: number): string => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max).trim();
/** A tool result that failed keeps more of its words (that is usually where the job got stuck). */
const failedResult = (text: string): boolean => /\berror\b|"ok"\s*:\s*false|"status"\s*:\s*"blocked"|failed|refused|not found|denied/i.test(text);

function minutes(ms: number): string {
  const total = Math.max(1, Math.round(ms / 60_000));
  if (total < 60) return `${total} min`;
  const hours = Math.floor(total / 60);
  const rest = total % 60;
  return rest ? `${hours} h ${rest} min` : `${hours} h`;
}

function describeWait(watch: EtlRunWatch, nowMs: number): string {
  const since = minutes(nowMs - Date.parse(watch.submittedAt));
  if (watch.source === 'dashboard') return `- the ${watch.purpose ?? `dashboard refresh ${watch.runId}`} (${watch.runId}): still running after ${since}`;
  if (watch.source === 'job_wait') {
    const until = watch.kind !== 'time' && watch.deadlineAt ? `; BotBoy gives up at ${watch.deadlineAt}` : '';
    return `- ${waitName(watch)} (${watch.runId}): ${clip(watch.remoteStatus, 120) || 'waiting'} after ${since}${until}`;
  }
  return `- Datanet ETL run ${watch.runId}${watch.purpose ? ` (${clip(watch.purpose, 100)})` : ''}: ${watch.remoteStatus ?? 'submitted'} after ${since}${watch.prioritizedAt ? ', BotBoy already asked Datanet to prioritize it' : ''}`;
}

/** What happened, in one line for the main chat's transcript (the note above the main chat's reply). */
export function reviewNote(job: ChatJob, event: JobReviewEvent, nowMs: number): string {
  const name = `#${job.seq} ${clip(job.title, 80)}`;
  switch (event.kind) {
    case 'limit': return `↻ Job update: ${name} paused after ${CHAT_JOB_MAX_CONTINUATIONS} automatic turns in a row.`;
    case 'stuck': return `↻ Job update: ${name} is stuck.`;
    case 'question': return `↻ Job update: ${name} has a question.`;
    case 'wait': return `↻ Job update: ${name} has been waiting ${minutes(nowMs - Date.parse(event.since))}.`;
  }
}

/**
 * The update the main chat model reads (the turn's message, BotBoy's words): the job's request, what happened, what it waits on,
 * its last replies and tool calls, the rounds left, and the choices. Bounded; the model reads more with its tools.
 */
export function buildReviewTrigger(job: ChatJob, event: JobReviewEvent, input: {
  nowMs: number;
  watches: EtlRunWatch[];
  /** The job's latest replies in its thread, oldest first. */
  replies: string[];
}): string {
  const pending = input.watches.filter(watch => watch.status === 'pending');
  const what = event.kind === 'limit'
    ? `It paused after ${CHAT_JOB_MAX_CONTINUATIONS} automatic turns in a row (BotBoy's limit per round, not the owner's pause).`
    : event.kind === 'stuck'
      ? `It could not get past a problem and stopped: "${clip(job.pauseNote, 500)}"`
      : event.kind === 'question'
        // The question is the main chat's to answer first (owner report 2026-11-09): framed as the owner's, two updates left it to him.
        ? `It stopped to ask: "${clip(job.pauseNote, 600)}"${job.options?.length ? ` (its one-tap answers: ${job.options.join(' / ')})` : ''}, ${minutes(input.nowMs - Date.parse(event.since))} ago. The question comes to you before the owner: answer it yourself unless only he can decide.`
        : `It has done nothing for ${minutes(input.nowMs - Date.parse(event.since))} because it waits for what is below.`;
  const decide = event.kind === 'wait'
    ? 'Check what it waits on, then decide as the JOB UPDATES section of your instructions says (a job whose runs are still moving can simply wait), and tell the owner in one or two short sentences what you decided.'
    : `Check what it is blocked on, then decide as the JOB UPDATES section of your instructions says: end with ${event.kind === 'question' ? 'jobs message or jobs ask_owner' : 'jobs message, jobs continue or jobs ask_owner'}, and tell the owner in one or two short sentences what you did.`;
  const tools = job.lastTools.slice(-8).map(step => `- ${step.name}(${clip(step.args, 160)}) → ${clip(step.result, failedResult(step.result) ? 500 : 160)}`);
  const lines = [
    JOB_UPDATE_TRIGGER_HEADER,
    `Job #${job.seq} "${clip(job.title, 80)}" needs a decision. ${what}`,
    `The owner's request: "${clip(job.goal, 1_200)}"`,
    ...(job.workingSet.nextStep ? [`Next step it recorded: ${clip(job.workingSet.nextStep, 500)}`] : []),
    ...(pending.length ? ['It waits for:', ...pending.slice(-6).map(watch => describeWait(watch, input.nowMs))] : []),
    ...(input.replies.length ? ['Its last replies, oldest first:', ...input.replies.slice(-3).map(reply => `- ${clip(reply, 450)}`)] : []),
    ...(tools.length ? ['Its last turn\'s tool calls:', ...tools] : []),
    `Rounds you have kept this job going without the owner: ${job.supervisions} of ${MAX_REVIEW_ROUNDS}.`,
    decide,
  ];
  return lines.join('\n');
}

/** A pause BotBoy made, which the main chat decides on (never the owner's own pause). */
const botboyPause = (job: ChatJob): boolean => Boolean(job.pausedAt) && (job.pauseKind === 'limit' || job.pauseKind === 'stuck' || job.pauseKind === 'question');

/** The paused state an update is about is still the job's state: it did not move on, end, or get answered meanwhile. */
export function reviewStateOpen(job: ChatJob | null | undefined, key: string): boolean {
  return Boolean(job) && job!.status === 'active' && botboyPause(job!) && key === `${job!.pauseKind}:${job!.pausedAt}`;
}

const REVIEW_DECISIONS = new Set(['message', 'continue', 'ask_owner']);
/** A `jobs` call that decided an update: message, continue or ask_owner, and the tool answered ok. */
export function isReviewDecision(argsJson: string, resultJson: string): boolean {
  return reviewDecisionOf(argsJson, resultJson) !== null;
}
/** Which decision that call made, or null when it made none. */
export function reviewDecisionOf(argsJson: string, resultJson: string): 'message' | 'continue' | 'ask_owner' | null {
  let action = '';
  try { action = String(JSON.parse(argsJson || '{}')?.action ?? '').trim(); } catch { return null; }
  if (!REVIEW_DECISIONS.has(action)) return null;
  try { return JSON.parse(resultJson)?.ok === true ? action as 'message' | 'continue' | 'ask_owner' : null; } catch { return null; }
}
/**
 * The main chat handled the update itself (it sent the job a message or kept it going): the owner has nothing to do, the job's pill
 * shows it moving again, and its thread keeps the main chat's words ("↪ The main chat looked at this job: …", job-desk.ts), so the
 * main chat gets no row for it (owner decision 2026-11-13). A question for the owner (ask_owner) stays in the main chat.
 */
export function isSelfHandledReview(decision: string | null | undefined): boolean {
  return decision === 'message' || decision === 'continue';
}

/**
 * The one internal check an update turn gets when it replies without deciding on a job that is still paused (chat.ts; owner
 * report 2026-11-09: two updates read job #12, left it paused, and its card went to the owner instead of guidance).
 */
export function reviewDecisionCheck(job: ChatJob): string {
  const choices = [
    'jobs message with the answer to its question or the next step to take (a route it has not tried, never a repeat of what failed)',
    ...(job.pauseKind === 'question' ? [] : [job.pauseKind === 'stuck' ? 'jobs continue once the cause has passed' : 'jobs continue when it was making progress']),
    'jobs ask_owner only when the choice is the owner\'s (sending, posting or sharing outside BotBoy, an approval, money, a business trade-off), with 2-4 one-tap options worded as what BotBoy will do',
  ];
  return `JOB UPDATE CHECK (internal: the owner cannot see this; do not mention it): job #${job.seq} is still paused and you have not decided. Decide now with one call: ${choices.join('; or ')}. Then reply to the owner in one or two short sentences.`;
}

/** What a stuck job's pause note says went wrong, without its "Reply …" hint (written for the job's own thread). */
function problemOf(job: ChatJob): string {
  const note = clip(job.pauseNote, 300).replace(/\s*\bReply\b[^.]*\.?$/i, '').replace(/[.]+$/, '').trim();
  return note || 'it stopped without finishing';
}

/** The line the main chat gets when the owner has to act: no update turn could run, or the rounds are used up. */
export function fallbackLine(job: ChatJob, event: JobReviewEvent, why: 'rounds' | 'no_turn', nowMs: number): string {
  const name = `#${job.seq} ${clip(job.title, 80)}`;
  const reason = why === 'rounds' ? ` I have kept it going ${MAX_REVIEW_ROUNDS} times without you, so this one is yours.` : '';
  switch (event.kind) {
    case 'limit': return `${name} paused after ${CHAT_JOB_MAX_CONTINUATIONS} automatic turns in a row.${reason} Reply in #${job.seq} to keep it going.`;
    case 'stuck': return `${name} is stuck: ${problemOf(job)}.${reason} Reply in #${job.seq} with how to go on.`;
    case 'question': return `${name} asks you: ${clip(job.pauseNote, 400)}`;
    case 'wait': return `${name} has been waiting ${minutes(nowMs - Date.parse(event.since))} for its runs to finish.${reason}`;
  }
}

export interface JobReviewRunnerOptions {
  jobs: ChatJobStore;
  /** http://127.0.0.1:<port>/api/chat/messages */
  url: string;
  /** The continuation secret (chat-continuations.ts › createContinuationBridge). */
  secret: string;
  /** An owner turn is running in the main chat: an update waits for it. */
  mainOwnerTurnActive: () => boolean;
  /** A turn of this job is running now (a wait is not a wait then). */
  jobRunning: (jobId: string) => boolean;
  /** The model and thinking of the owner's latest main-chat turn (undefined key: the chat default). */
  mainModel: () => { key?: string; thinking: ChatJobThinking };
  /** The job's latest replies in its own thread, oldest first. */
  threadReplies: (jobId: string, limit: number) => string[];
  /** Posts the job's card in the main chat when the owner has to act. */
  desk: () => JobDesk | null | undefined;
  fetchImpl?: typeof fetch;
  intervalMs?: number;
  scheduleTick?: (tick: () => void) => void;
  log?: (line: string) => void;
  now?: () => number;
}

export interface JobReviewRunner {
  start(): void;
  stop(): void;
  /** A job's state changed (it paused, a turn ended): look for due updates soon. */
  nudge(): void;
  /** Looks for the oldest due update and runs it (resolves when its turn has started or it went to the owner). */
  tick(): Promise<void>;
  /** An update about this job is due or its turn is running: its pause is not the owner's yet (the WhatsApp notifier waits). */
  isPending(jobId: string): boolean;
  /**
   * The job reads as being looked at (the chat panel shows no "needs you" for it): the main chat is deciding on it, or a pause
   * BotBoy made has not been decided yet, for at most DECISION_HIDE_MAX_MS after the pause.
   */
  awaitsDecision(jobId: string): boolean;
  /** The main chat is deciding on this job right now. */
  isReviewing(jobId: string): boolean;
  /** Resolves when the running update turn has ended (tests, shutdown). */
  idle(): Promise<void>;
}

export function createJobReviewRunner(options: JobReviewRunnerOptions): JobReviewRunner {
  const fetchImpl = options.fetchImpl ?? fetch;
  const log = options.log ?? ((line: string) => console.log(line));
  const now = options.now ?? Date.now;
  const schedule = () => { if (!stopped) (options.scheduleTick ?? setImmediate)(() => { void tick(); }); };
  let timer: ReturnType<typeof setInterval> | null = null;
  let stopped = false;
  let ticking = false;
  let again = false;
  /** The one update turn running in the main chat. */
  let running: { jobId: string; key: string; controller: AbortController; done: Promise<void> } | null = null;

  const pendingOf = (jobId: string) => options.jobs.pendingWatches().filter(watch => watch.jobId === jobId);
  function dueNow(): Array<{ job: ChatJob; event: JobReviewEvent }> {
    const t = now();
    const pending = options.jobs.pendingWatches();
    const due: Array<{ job: ChatJob; event: JobReviewEvent }> = [];
    for (const job of options.jobs.activeJobs()) {
      const event = dueReview(job, { nowMs: t, pendingWatches: pending.filter(watch => watch.jobId === job.id), running: options.jobRunning(job.id) });
      if (event) due.push({ job, event });
    }
    return due.sort((left, right) => left.event.since.localeCompare(right.event.since));
  }

  /** The owner has to act: the job's line and card in the main chat, and the state counts as handled. */
  function toOwner(job: ChatJob, event: JobReviewEvent, why: 'rounds' | 'no_turn', detail = ''): void {
    options.jobs.finishReview(job.id, event.key);
    options.desk()?.postUpdateLine(job.id, fallbackLine(job, event, why, now()));
    log(`[JobReview] #${job.seq} ${job.id} ${event.kind}: ${why === 'rounds' ? `${MAX_REVIEW_ROUNDS} rounds used` : `no update turn${detail ? ` (${clip(detail, 160)})` : ''}`}; the owner gets its card`);
  }

  async function runTurn(job: ChatJob, event: JobReviewEvent, controller: AbortController): Promise<void> {
    const model = options.mainModel();
    const nowMs = now();
    const message = buildReviewTrigger(job, event, { nowMs, watches: options.jobs.watchesForJob(job.id), replies: options.threadReplies(job.id, 3) });
    let response: Response;
    try {
      response = await fetchImpl(options.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', [CONTINUATION_HEADER]: options.secret },
        body: JSON.stringify({
          message,
          stream: true,
          ...(model.key ? { model: model.key } : {}),
          thinking: model.thinking,
          review: { jobId: job.id, key: event.key, note: reviewNote(job, event, nowMs) },
        }),
        signal: controller.signal,
      });
    } catch (error: any) {
      // Nothing started: the state is due again on the next tick.
      options.jobs.releaseReview(job.id, event.key);
      if (!controller.signal.aborted) log(`[JobReview] #${job.seq} ${job.id}: could not reach the chat route (${clip(error?.message ?? error, 160)})`);
      return;
    }
    if (!response.ok || !response.body) {
      let code = '';
      let detail = `HTTP ${response.status}`;
      try {
        const parsed = JSON.parse(await response.text());
        code = String(parsed?.code ?? '');
        detail = String(parsed?.error || detail);
      } catch { /* keep the status */ }
      // The owner is talking in the main chat, or another update runs: try again after it.
      if (code === 'owner_turn_active' || code === 'review_turn_active' || code === 'turn_in_progress') { options.jobs.releaseReview(job.id, event.key); return; }
      // The job ended or moved on meanwhile: nothing to decide.
      if (code === 'job_not_active' || code === 'review_not_claimed') { options.jobs.finishReview(job.id, event.key); return; }
      // No AI model, or any other refusal: the owner hears instead.
      toOwner(job, event, 'no_turn', detail);
      return;
    }
    log(`[JobReview] #${job.seq} ${job.id} ${event.kind}: the main chat looks at it`);
    // The chat route settles the claim when the turn ends (finished, released, or the card); this only waits for the end.
    try {
      const reader = response.body.getReader();
      for (;;) {
        const { done } = await reader.read();
        if (done) break;
      }
    } catch { /* the route settles the claim either way */ }
  }

  function launch(job: ChatJob, event: JobReviewEvent): void {
    const controller = new AbortController();
    const entry: { jobId: string; key: string; controller: AbortController; done: Promise<void> } = { jobId: job.id, key: event.key, controller, done: Promise.resolve() };
    running = entry;
    entry.done = (async () => {
      try {
        await runTurn(job, event, controller);
      } catch (error: any) {
        options.jobs.releaseReview(job.id, event.key);
        log(`[JobReview] #${job.seq} ${job.id}: the update turn could not run (${clip(error?.message ?? error, 160)})`);
      } finally {
        if (running === entry) running = null;
        schedule();
      }
    })();
  }

  async function tick(): Promise<void> {
    if (stopped) return;
    if (ticking) { again = true; return; }
    ticking = true;
    try {
      do {
        again = false;
        // One update turn at a time in the main chat, and never in the middle of the owner's own turn there.
        if (running || options.mainOwnerTurnActive()) return;
        for (const { job, event } of dueNow()) {
          if (!options.jobs.claimReview(job.id, event.key)) continue;
          if (job.supervisions >= MAX_REVIEW_ROUNDS) { toOwner(job, event, 'rounds'); continue; }
          const fresh = options.jobs.get(job.id);
          if (!fresh || fresh.status !== 'active') { options.jobs.finishReview(job.id, event.key); continue; }
          launch(fresh, event);
          return;
        }
      } while (again && !stopped);
    } finally {
      ticking = false;
    }
  }

  return {
    start() {
      if (timer || stopped) return;
      // No update turn survives a restart: every claimed state is due again.
      const released = options.jobs.releaseAllReviews();
      if (released) log(`[JobReview] ${released} job update(s) interrupted by the restart are due again`);
      timer = setInterval(() => { void tick(); }, options.intervalMs ?? TICK_MS);
      timer.unref?.();
      schedule();
    },
    stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = null;
      running?.controller.abort();
    },
    nudge: schedule,
    tick,
    isPending(jobId) {
      if (running?.jobId === jobId) return true;
      const job = options.jobs.get(jobId);
      if (!job || job.status !== 'active' || !job.seq) return false;
      // A pause BotBoy made (or a question) is not the owner's yet until the main chat has looked at it, its grace included.
      if (botboyPause(job)) return job.reviewedKey !== `${job.pauseKind}:${job.pausedAt}`;
      return Boolean(dueReview(job, { nowMs: now(), pendingWatches: pendingOf(jobId), running: options.jobRunning(jobId) }));
    },
    awaitsDecision(jobId) {
      if (running?.jobId === jobId) return true;
      const job = options.jobs.get(jobId);
      if (!job || job.status !== 'active' || !job.seq || !botboyPause(job)) return false;
      if (job.reviewedKey === `${job.pauseKind}:${job.pausedAt}`) return false;
      return now() - Date.parse(job.pausedAt!) < DECISION_HIDE_MAX_MS;
    },
    isReviewing: (jobId) => running?.jobId === jobId,
    async idle() {
      await running?.done;
    },
  };
}
