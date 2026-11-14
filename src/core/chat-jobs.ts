/**
 * Chat jobs: the owner's request that BotBoy is working on, and the ETL runs
 * it is waiting for (ANALYTICS_AUTONOMY_PLAN.md, owner decisions D1/D2,
 * 2026-10-08).
 *
 * A job is the authority for continuation turns: the owner asked once, and
 * BotBoy keeps taking the job's steps (including after an ETL run finishes
 * when no turn is open) until the job is done, blocked, stopped, or idle for
 * 24 hours. Many jobs can be active at once, each with its own number (#N)
 * and its own thread (PARALLEL_JOBS_PLAN.md, owner decisions PJ1/PJ2,
 * 2026-10-28): starting a job never ends another, and every caller names the
 * job it means; there is no "the active job".
 *
 * The store is plain SQL over the tracker database, so every instance on one
 * database sees the same state. It never decides what a step may do; the
 * mandate gate (job-mandate.ts) does.
 */
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { describeJobWaitOutcome, jobWaitTargetName, type JobWaitKind } from './job-waits.js';

export type ChatJobStatus = 'active' | 'done' | 'stopped' | 'expired' | 'blocked';
export type ChatJobThinking = 'off' | 'low' | 'high' | 'max';
export type EtlWatchStatus = 'pending' | 'finished' | 'abandoned';

/** A job with no owner or continuation turn for this long expires. */
export const CHAT_JOB_IDLE_MS = 24 * 60 * 60_000;
/**
 * The end reason `start()` writes when a new job replaces the active one. The WhatsApp notifier (job-notifier.ts) reads it: a job the
 * owner replaced by asking for something else is not news, so it stays silent.
 */
export const CHAT_JOB_REPLACED_REASON = 'replaced by a new job';
/**
 * The end reason of a provisional job (an ETL run inside a main chat turn) whose turn used the results itself, so it never became
 * a job of its own (PARALLEL_JOBS_PLAN.md §6). Not listed, never announced.
 */
export const CHAT_JOB_FOLDED_REASON = 'answered in the main chat';
/** Automatic continuations in a row (since the owner's last message) before BotBoy pauses and asks. */
export const CHAT_JOB_MAX_CONTINUATIONS = 25;
/** The due reason of a job's first turn after the main chat handed it off (tool-executor.ts › job_update start). */
export const JOB_START_REASON = 'The owner just handed this job off from the main chat.';
/** The due reason of a turn that answers a message from the main chat (`jobs message`, PARALLEL_JOBS_PLAN.md §11 R3). */
export const JOB_MESSAGE_REASON = 'A message for this job arrived from the main chat.';
/** The due reason of a turn that follows the main chat's look at this job (job-review.ts, PARALLEL_JOBS_PLAN.md §12). */
export const JOB_REVIEW_REASON = 'BotBoy\'s main chat looked at this job and sent it a message.';
/** The due reason of a turn the main chat let carry on as it is (`jobs continue`, §12 R3). */
export const JOB_CONTINUE_REASON = 'BotBoy\'s main chat looked at this job and decided it carries on as it is.';
/** A finished job's report as the main chat shows it: the closing reply of the turn that ended it (§11 R1). */
export const JOB_REPORT_CHARS = 8_000;
/** Next steps a finished job offers as one-tap buttons in the main chat. */
export const MAX_NEXT_STEPS = 3;
const MAX_NEXT_STEP_CHARS = 60;
/** Messages from the main chat waiting for a job's next turn (newest kept), and how long one may be. */
export const JOB_INBOX_MAX = 5;
export const JOB_INBOX_TEXT_CHARS = 2_000;
/**
 * Rounds the main chat may keep a job going on its own (a `jobs continue`, `message` or answer from an update turn) before the
 * next update goes to the owner instead (§12 Identity). The owner's own word to the job starts the count over.
 */
export const MAX_REVIEW_ROUNDS = 3;
/** The last turn's tool calls kept on the job for `jobs read` and the main chat's update (the thread keeps only prose). */
export const JOB_TOOL_TRAIL_MAX = 16;
export interface ChatJobToolStep {
  name: string;
  args: string;
  result: string;
}

/** The report body kept on the job: the latest turn's closing words (a phone message, so bounded). */
export const NOTIFY_REPLY_CHARS = 3_000;
/** Events remembered per job, newest last; a job has a handful of pause/finish events, so this never bites. */
const NOTIFY_SENT_KEEP = 40;

const MAX_GOAL_CHARS = 4_000;
const MAX_NOTES = 12;
const MAX_NOTE_CHARS = 300;
const MAX_LIST = 20;

export interface ChatJobWorkingSet {
  nextStep?: string;
  notes: string[];
  files: Array<{ path: string; label?: string; at: string }>;
  datasets: Array<{ datasetId?: string; versionId?: string; jobId?: string; title?: string; at: string }>;
  dashboards: Array<{ dashboardId: string; title?: string; at: string }>;
  /** Library files this job loaded, so a continuation knows what to load again (knowledge-library.md K9). */
  knowledge: Array<{ set: string; file: string; sha256: string; at: string }>;
  /** BotBoy documents this job saved or edited: the newest version of each (an edit replaces its parent; job-history.md). */
  documents: Array<{ artifactId: string; title?: string; at: string }>;
  /** Google Drive files this job created, uploaded or copied (gdrive_files receipts; job-history.md). */
  drive: Array<{ fileId: string; name?: string; kind?: string; url?: string; at: string }>;
}

/**
 * What a turn said should happen next (job_update continue | needs_owner | wait). `wait`: the job waits for what is pending
 * (its runs, exports, refreshes and other waits, docs/maps/job-waits.md) and continues when one ends.
 */
export type ChatJobDeclaration = 'continue' | 'needs_owner' | 'wait';

/**
 * "Tell me on WhatsApp" for ONE job (docs/maps/job-notify.md). Set from a live owner turn; BotBoy's own notifier then sends
 * a message when the job needs the owner, finishes, or ends, with no model turn. `sent` records each event once, so a
 * restart or a retry never repeats a message. Mirrors the owner's request: it is the owner's word, kept on the job.
 */
export interface ChatJobNotify {
  channel: 'whatsapp';
  /** When the owner asked, and the words they used (shown in the confirmation, never executed). */
  armedAt: string;
  /** Each event BotBoy has already told the owner about (or given up on), keyed by `eventKey`. */
  sent: Array<{ key: string; at: string; outcome: 'sent' | 'unknown' | 'gave_up' }>;
  /** A message that failed to send and will be retried: how many attempts, and when the next one may run. */
  retry?: { key: string; attempts: number; notBefore: string };
}

export interface ChatJob {
  id: string;
  /** The job's number, shown as #N and typed as `#N` to talk to it (PJ3). 0 only for old ended jobs from before numbers. */
  seq: number;
  /** A short name for lists and cards (2-6 words); the goal keeps the owner's full words. */
  title: string;
  goal: string;
  status: ChatJobStatus;
  /** The job's own model session (its thread). Absent until the job's first turn creates it. */
  sessionId?: string;
  /** A provider limit hit this job's last turn: its next automatic turn waits until then (PJ2). */
  rateWaitUntil?: string;
  /** One-tap answers offered with the job's needs_owner question (the "needs you" banner). */
  options?: string[];
  modelKey?: string;
  thinking: ChatJobThinking;
  workingSet: ChatJobWorkingSet;
  continuationCount: number;
  createdAt: string;
  lastActivityAt: string;
  endedAt?: string;
  endReason?: string;
  /** The latest turn's own declaration and when it was made. */
  declaration?: ChatJobDeclaration;
  declaredAt?: string;
  /** Paused: nothing runs until the owner replies (or a watched run finishes). */
  pausedAt?: string;
  pauseNote?: string;
  /** Why it paused (absent for pauses written before this column, which read as a plain pause). */
  pauseKind?: ChatJobPauseKind;
  /** A continuation turn is due (the job's own next step, not an ETL run). */
  continueRequestedAt?: string;
  continueReason?: string;
  /** Consecutive turn ends with no declaration / consecutive failed turns. */
  undeclaredEnds: number;
  failedTurns: number;
  /** The owner asked to be told on WhatsApp when this job needs them or ends (job-notify.md). Absent: not asked. */
  notify?: ChatJobNotify;
  /** The final words of the job's latest turn: the body of the report the owner receives. Set when a turn settles. */
  lastReply?: string;
  lastReplyAt?: string;
  /** A finished job's report for the main chat: the closing reply of the turn that ended it (§11 R1). */
  report?: string;
  /** When the main chat got the report (or, for an expired job, its one quiet line). Absent: not yet posted. */
  reportedAt?: string;
  /** Up to three things BotBoy can do next, offered as one-tap buttons with the report (`job_update done nextSteps`). */
  nextSteps?: string[];
  /** Messages from the main chat (an owner turn there, or its own look at this job) waiting for the job's next turn. */
  inbox: ChatJobInboxMessage[];
  /** A main-chat message asked for this job's reply: its next automatic turn's reply goes back to the main chat. */
  mainReplyAt?: string;
  /** The update the main chat is deciding on right now (job-review.ts), claimed before its turn starts. */
  reviewKey?: string;
  /** The latest update the main chat finished deciding on, so each state is handled once (§12 Execution). */
  reviewedKey?: string;
  /** Rounds the main chat kept this job going without the owner (MAX_REVIEW_ROUNDS); the owner's word resets it. */
  supervisions: number;
  /** The tool calls of the job's latest turn (names, arguments and results, clipped), newest last. */
  lastTools: ChatJobToolStep[];
  /**
   * BotBoy found data work in the job when it started (its request or first steps name dashboards, datasets, warehouse queries or
   * ETL), or the job has since recorded a dataset, dashboard, ETL result or run. Its turns then carry the detailed dashboard and Data
   * Room rules (prompt-manager.ts › dataJobGuidance; owner decision 2026-11-10).
   */
  dataWork: boolean;
}

/**
 * Words that show a request needs analytics or data work: dashboards and their widgets, datasets and the Data Room, warehouse SQL
 * and ETL, metrics and data files. A false positive only costs the detailed rules' prompt text; a miss is caught as soon as the job
 * records a dataset, dashboard, ETL result or run.
 */
const DATA_WORK_RE = /\b(?:dashboards?|widgets?|datasets?|data|data ?room|etl|datanet|sql|redshift|warehouse|quer(?:y|ies)|metrics?|kpis?|analytics?|analys[ie]s|analy[sz]e|cohorts?|funnels?|retention|charts?|csv|tsv|xlsx|spreadsheets?)\b/i;

/** True when any of these texts (a job's goal, title, next step, notes, or the owner's message that started it) names data work. */
export function detectJobDataWork(parts: ReadonlyArray<string | undefined | null>): boolean {
  return parts.some(part => typeof part === 'string' && DATA_WORK_RE.test(part));
}

const DATA_WORK_TOOLS: ReadonlySet<string> = new Set([
  'list_data_room_datasets', 'query_data_room', 'create_data_room_dataset', 'configure_analytics_widget_source',
  'list_analytics_dashboards', 'get_analytics_dashboard', 'create_analytics_dashboard', 'update_analytics_dashboard',
  'edit_analytics_dashboard', 'refresh_analytics_dashboard', 'configure_analytics_schedule', 'answer_analytics',
  'run_analytics_job', 'manage_analytics_job', 'wait_for_etl_run',
]);

/** A tool whose use in a turn means the turn did data work, so a job it hands off, or becomes, is data work. */
export function isDataWorkTool(name: string): boolean {
  return DATA_WORK_TOOLS.has(name) || /^mcp_(?:etl|sql|analytics)_/.test(name);
}

/** One message for a job's next turn: from the main chat in an owner turn there, or from the main chat's own look at the job. */
export interface ChatJobInboxMessage {
  from: 'main_chat' | 'review';
  text: string;
  /** The owner's own message in the main chat that led to it, quoted for the job (main_chat only). */
  ownerWords?: string;
  at: string;
}

/** How a chat turn ended, for the job's end-of-turn settle. */
export type ChatTurnEnd =
  | 'answered'        // the model replied without tool calls
  | 'ceiling'         // the runaway tool-iteration ceiling tripped
  | 'repeat_breaker'  // tools were withheld because the model repeated a call
  | 'failed'          // provider or stream error
  | 'owner_stopped'   // the owner pressed Stop on the turn
  | 'preempted'       // a continuation gave way to an owner message
  | 'job_stopped'     // the owner ended the job
  | 'provider_changed'
  | 'shutdown'
  | 'disconnected'
  | 'rate_limited';   // the provider asked BotBoy to slow down (after the client's own bounded resends)

export type ChatTurnSettlement =
  | { action: 'none' }
  | { action: 'continue'; reason: string; undeclared?: true; notBefore?: string }
  /** `kind` says why: a question for the owner (its one-tap answers stay), a problem the job could not get past, or a plain pause. */
  | { action: 'pause'; note: string; kind?: ChatJobPauseKind }
  | { action: 'wait' };

/**
 * Why a job paused: `question` (needs_owner: the "needs you" banner), `stuck` (failures, the repeat breaker, an end that said
 * nothing), `limit` (BotBoy's own limit of CHAT_JOB_MAX_CONTINUATIONS automatic turns in a row), or `paused` (the owner's own
 * doing: Pause, Stop on a turn, a model change in Settings). The main chat looks at every kind but `paused` (§12 R2).
 */
export type ChatJobPauseKind = 'question' | 'stuck' | 'limit' | 'paused';

/** How long a job waits after a provider limit when the provider named no time (PJ2): 30 s, doubling, at most 8 minutes. */
export function providerWaitMs(strikes: number, requestedMs?: number): number {
  const backoff = Math.min(8 * 60_000, 30_000 * 2 ** Math.max(0, Math.min(strikes, 4)));
  return Math.max(requestedMs ?? 0, backoff);
}

/**
 * The end-of-turn decision (owner directive 2026-10-08): a job never sits
 * "working" with nothing running. It ends done (job_update done), waits on
 * what is pending, continues on its own, or pauses for the owner.
 *
 * Waiting spends no turn (§12 R1; general waits, docs/maps/job-waits.md): while anything the job waits for is pending (an ETL
 * run, a refresh of its dashboards, a background export, a wait_for), a turn that says "continue" or "wait" waits, and the job
 * continues when one ends. Job #5 had checked an export's status in 25 turns in a row (2026-11-12).
 */
export function decideTurnSettlement(input: {
  end: ChatTurnEnd;
  /** This turn's own declaration (made after the turn started). */
  declaration?: ChatJobDeclaration;
  declarationNote?: string;
  /** Everything the job waits for that is still pending: ETL runs, dashboard refreshes, and its other waits. */
  pendingRuns: number;
  /**
   * Refreshes of the job's dashboards still running (part of `pendingRuns`). A turn cut off at the tool limit waits for them
   * instead of continuing: a refresh needs nothing from the job.
   */
  pendingDashboardRuns?: number;
  undeclaredEnds: number;
  failedTurns: number;
  /** The reply's last words, used as the pause note when nothing was declared. */
  replyExcerpt?: string;
  /** For a rate_limited end: when the job may try again (ISO). */
  rateWaitUntil?: string;
  /** For a rate_limited end: BotBoy could not reach the AI model (the network), rather than the provider asking it to wait. */
  waitReason?: 'network';
}): ChatTurnSettlement {
  switch (input.end) {
    case 'preempted':
    case 'job_stopped':
      return { action: 'none' };
    case 'rate_limited':
      // PJ2: a provider limit (or, since 2026-10-29, a network outage) is a wait, never a failure; the turn's own work and
      // declaration are not lost, the next turn re-reads the thread.
      return {
        action: 'continue',
        reason: input.waitReason === 'network'
          ? 'BotBoy could not reach the AI model in the middle of the previous turn (the network was down). Carry on from where the job stands.'
          : 'The AI provider asked BotBoy to slow down in the middle of the previous turn. Carry on from where the job stands.',
        ...(input.rateWaitUntil ? { notBefore: input.rateWaitUntil } : {}),
      };
    case 'owner_stopped':
      return { action: 'pause', note: 'You stopped the turn. Reply to continue.', kind: 'paused' };
    case 'provider_changed':
      return { action: 'pause', note: 'The AI model changed in Settings. Reply to continue.', kind: 'paused' };
    case 'disconnected':
      return input.pendingRuns ? { action: 'wait' } : { action: 'pause', note: 'The chat closed mid-turn. Reply to continue.', kind: 'paused' };
    case 'shutdown':
      return { action: 'continue', reason: 'BotBoy restarted in the middle of the previous turn.' };
    case 'ceiling':
      if (input.pendingDashboardRuns) return { action: 'wait' };
      return { action: 'continue', reason: 'The previous turn reached the per-turn tool limit before the job was finished.' };
    case 'repeat_breaker':
      return { action: 'pause', note: 'I was repeating the same step, so I stopped. Reply with how to proceed.', kind: 'stuck' };
    case 'failed':
      return input.failedTurns < 1
        ? { action: 'continue', reason: 'The previous turn failed before it could finish.' }
        : { action: 'pause', note: 'Two turns in a row failed. Reply to try again.', kind: 'stuck' };
    case 'answered':
    default:
      if (input.declaration === 'needs_owner') return { action: 'pause', note: input.declarationNote || 'BotBoy needs your input.', kind: 'question' };
      // Something the job waits for is still pending: it waits instead of spending turns checking on it.
      if ((input.declaration === 'continue' || input.declaration === 'wait') && input.pendingRuns) return { action: 'wait' };
      // What the turn declared it waits for ended during the turn: nothing is left to wait for, so the job carries on.
      if (input.declaration === 'wait') {
        return { action: 'continue', reason: 'What the previous turn waited for has already ended. Carry on from where the job stands.' };
      }
      if (input.declaration === 'continue') return { action: 'continue', reason: input.declarationNote || 'The previous turn said the job continues.' };
      if (input.pendingRuns) return { action: 'wait' };
      if (input.undeclaredEnds < 1) {
        return { action: 'continue', reason: 'The previous turn ended without saying whether the job is done, needs the owner, or continues.', undeclared: true };
      }
      // A reply that ends asking something is a question the model did not declare; anything else stopped short.
      return {
        action: 'pause',
        note: input.replyExcerpt || 'BotBoy stopped without finishing. Reply to continue.',
        kind: input.replyExcerpt?.includes('?') ? 'question' : 'stuck',
      };
  }
}

/**
 * What a finished run (or another wait) produced, as the continuation turn reports it. `remoteStatus` is the run's status, or a
 * job wait's: DONE, FAILED, CANCELLED, STOPPED, LOST, TIMED_OUT, BLOCKED, NEEDS_INPUT, NEEDS_APPROVAL.
 */
export interface EtlRunOutcome {
  remoteStatus: string;
  savedTo?: string;
  rowCount?: number;
  columns?: string[];
  truncated?: boolean;
  resultBytes?: number;
  error?: string;
  /** A dashboard refresh: how many of its widgets loaded. */
  widgetsSucceeded?: number;
  widgetCount?: number;
  /** A job wait: what it produced, in a few words ("1,234 rows, 2.1 MB"). */
  summary?: string;
  /** A terminal wait: the session's last output (data, never instructions). */
  detail?: string;
}

/**
 * Something a job waits for, in one shape for the runner, the triggers and the job view: a Datanet ETL run (`run_query`,
 * `wait`), a refresh of one of the job's BotBoy dashboards (`dashboard`, §12 R1: table `job_dashboard_waits`, ids `run_<hex>`),
 * or a general wait (`job_wait`, docs/maps/job-waits.md: table `job_waits`, ids `w_<hex>`). All wake the job the same way when
 * they end.
 */
export interface EtlRunWatch {
  /** The run id, or the wait's own id (`w_…` for a job wait). */
  runId: string;
  jobId: string;
  purpose?: string;
  source: 'run_query' | 'wait' | 'dashboard' | 'job_wait';
  /** The dashboard a `dashboard` wait refreshes. */
  dashboardId?: string;
  /** A job wait: what kind of thing it waits for, which one, when BotBoy gives up, and (terminal) the text that ends it early. */
  kind?: JobWaitKind;
  target?: string;
  deadlineAt?: string;
  untilOutput?: string;
  /** A job wait: what its checker keeps between checks (a file's size and time). */
  lastState?: string;
  status: EtlWatchStatus;
  remoteStatus?: string;
  submittedAt: string;
  lastPolledAt?: string;
  finishedAt?: string;
  outcome?: EtlRunOutcome;
  consumedAt?: string;
  pollFailures: number;
  /** When the one queue rescue (PRIORITIZE) ran, by runQuery or the watcher. */
  prioritizedAt?: string;
}

/** What a wait is, in the owner's words, for the job list ("Waiting for …"). A time reads from its `at` in the panel. */
export function waitLabel(watch: EtlRunWatch): string {
  const what = watch.purpose ? `: ${clip(watch.purpose, 120)}` : '';
  if (watch.source === 'dashboard') return `the ${watch.purpose ?? 'dashboard refresh'}`;
  if (watch.source !== 'job_wait') return `the Datanet run${what}`;
  switch (watch.kind) {
    case 'sql_export': return `a SQL export${what}`;
    case 'data_room_job': return `a Data Room job${what}`;
    case 'terminal': return `the terminal${what}`;
    case 'file': return `the file ${clip(watch.target, 160)}`;
    case 'connection': return `the ${clip(watch.target, 64)} connection to answer again`;
    case 'time': return `a time it set${what}`;
    default: return `something it started${what}`;
  }
}

/** What a wait is, in a few words, for the job's block, its triggers and the main chat. */
export function waitName(watch: EtlRunWatch): string {
  if (watch.source === 'dashboard') return `the ${watch.purpose ?? 'dashboard refresh'} (${watch.runId})`;
  if (watch.source === 'job_wait' && watch.kind && watch.target) {
    return `${jobWaitTargetName(watch.kind, watch.target)}${watch.purpose ? ` (${clip(watch.purpose, 120)})` : ''}`;
  }
  return `ETL run ${watch.runId}${watch.purpose ? ` (${clip(watch.purpose, 120)})` : ''}`;
}

/** The job history filter: every job, the finished ones, or the ones that ended without finishing (stopped or expired). */
export type ChatJobHistoryStatus = 'all' | 'done' | 'stopped';
export interface ChatJobHistoryPage {
  jobs: ChatJob[];
  /** The cursor for the next, older page; absent on the last one. */
  next?: string;
  /** How many jobs match the words, per filter (the page's filter counts). */
  counts: { all: number; done: number; stopped: number };
}
const HISTORY_PAGE = 30;
const HISTORY_CURSOR_RE = /^(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\|(cj_[a-f0-9]{24})$/;
/** `%`, `_` and the escape itself are literal in the owner's words. */
const likePattern = (words: string) => `%${words.replace(/[\\%_]/g, char => `\\${char}`)}%`;

export interface ChatJobStore {
  /** Every active job, by number (PJ1: many at once). */
  activeJobs(): ChatJob[];
  /** Jobs that ended since `sinceIso`, newest first (the job list's "Finished today"). */
  recentlyEnded(sinceIso: string, limit?: number): ChatJob[];
  get(jobId: string): ChatJob | null;
  /** The job with this number (#N), active or not. */
  bySeq(seq: number): ChatJob | null;
  /**
   * Starts a job with the next number. It never ends another job (PJ1). `provisional`: started for an ETL run inside a main chat
   * turn; it has no number and is not listed until `surface` (the run outlived the turn), or it folds away (`CHAT_JOB_FOLDED_REASON`).
   */
  start(input: { goal: string; title?: string; modelKey?: string; thinking?: ChatJobThinking; provisional?: boolean; dataWork?: boolean }): ChatJob;
  /**
   * The job is data work (owner decision 2026-11-10): its turns carry the detailed dashboard and Data Room rules. Set at start from
   * `detectJobDataWork`, and by the store itself the first time the job records a dataset, dashboard, ETL result or run. Never
   * cleared.
   */
  markDataWork(jobId: string): void;
  /** Gives a provisional job its number: it is a real job now. No-op for a numbered job. */
  surface(jobId: string): ChatJob | null;
  /** Binds the job's thread: the model session its turns read and write. */
  setSession(jobId: string, sessionId: string): void;
  /** Records activity; an owner turn also records its model and thinking (D4). */
  touch(jobId: string, input?: { modelKey?: string; thinking?: ChatJobThinking }): void;
  update(jobId: string, input: { goal?: string; title?: string; nextStep?: string; notes?: string[] }): ChatJob | null;
  /** Ends the job. A `done` job may name up to three next steps (one-tap buttons with its report in the main chat). */
  end(jobId: string, status: Exclude<ChatJobStatus, 'active'>, reason: string, extra?: { nextSteps?: unknown }): ChatJob | null;
  /** The closing reply of the turn that ended a `done` job: its report for the main chat (bounded, line breaks kept). */
  recordReport(jobId: string, text: string): void;
  /** Numbered jobs that ended done or expired since `sinceIso` and whose main-chat line is not posted yet, oldest first. */
  unreportedEnded(sinceIso: string): ChatJob[];
  /** Claims the job's main-chat report: true once, for the caller that posts it. */
  markReported(jobId: string): boolean;
  /**
   * A message for the job's next turn (§11 R3, §12 R3). From the main chat (an owner turn there): an ended job reopens, a pause
   * clears, the streaks and the 25-turn count start over (the owner is involved), and the job's next reply goes back to the
   * main chat. From the main chat's own look at a job update (`review`): only an active job, its streaks stand, it counts one
   * of MAX_REVIEW_ROUNDS, and a job stopped at the turn limit gets a fresh round. Either way a turn is due now. Returns the
   * job, or null when it does not exist (or, for a review, is no longer active).
   */
  deliverMessage(jobId: string, message: { from: ChatJobInboxMessage['from']; text: string; ownerWords?: string }): ChatJob | null;
  /** The turn that read the inbox has started: drops the messages written at or before `uptoIso`. */
  consumeInbox(jobId: string, uptoIso: string): void;
  /** The main chat asked for this job's reply and a turn that started at or after the ask ended: true once (the caller posts it). */
  takeMainReply(jobId: string, turnStartedIso: string): boolean;
  /**
   * The main chat keeps the job going as it is (`jobs continue`, §12 R3): a pause BotBoy made (its limit, stuck) clears, a turn is
   * due, and the limit's count starts over. From the main chat's own look (`review`) it counts one of MAX_REVIEW_ROUNDS; from the
   * owner's turn there (`main_chat`) it is the owner's word, so every count starts over and an ended job reopens. Null when
   * there is nothing to continue.
   */
  continueJob(jobId: string, input: { from: 'main_chat' | 'review' }): ChatJob | null;
  /**
   * The main chat found a choice only the owner can make: the job pauses with the owner's question and its one-tap answers (the
   * "needs you" banner). Not over a pause the owner made, nor over a question already asked.
   */
  askOwner(jobId: string, question: string, options: string[]): ChatJob | null;
  /** Claims the main chat's look at one job state (`key`): true for the caller that should run it (§12 Execution). */
  claimReview(jobId: string, key: string): boolean;
  /** The look at `key` is decided (or its card went to the owner): the state is never looked at again. */
  finishReview(jobId: string, key: string): void;
  /** The look at `key` did not happen (the owner was talking, a restart, a provider wait): it is due again. */
  releaseReview(jobId: string, key: string): void;
  /** At boot: no update turn survives a restart, so every claimed look is due again. */
  releaseAllReviews(): number;
  /** The tool calls of the job's latest turn (clipped; JOB_TOOL_TRAIL_MAX newest). */
  recordTurnTools(jobId: string, steps: ChatJobToolStep[]): void;
  incrementContinuations(jobId: string): number;
  /** A turn's job_update continue / needs_owner (with the question's one-tap answers, when it offered some). */
  declare(jobId: string, declaration: ChatJobDeclaration, note?: string, options?: string[]): ChatJob | null;
  /** Applies a turn's settlement: continue request, pause, or nothing; updates the streak counters. */
  settle(jobId: string, settlement: ChatTurnSettlement, end: ChatTurnEnd): ChatJob | null;
  /** The owner replied: clears a pause, a due continuation, and the streaks. */
  ownerResumed(jobId: string): void;
  /**
   * Something outside a turn answered what a PAUSED job was waiting for (the owner decided on a Knowledge card on the
   * Settings page): clears the pause and makes a continuation due, with `reason` as the turn's stated cause. Returns the job,
   * or null when it is not active and paused (a running job is never disturbed, and a continuation already due stays as it is).
   */
  wake(jobId: string, reason: string): ChatJob | null;
  /** A continuation turn was admitted for this request. */
  clearContinueRequest(jobId: string): void;
  /** Makes the job's next automatic turn due now, with `reason` as its stated cause (a hand-off, a resume). Active jobs only. */
  requestTurn(jobId: string, reason: string): ChatJob | null;
  /** A job that ended gets a follow-up from the owner in its thread: it is active again, with a fresh count (PJ1). */
  reopen(jobId: string): ChatJob | null;
  /** The owner paused the job from the chat panel: nothing runs until they resume it or reply in its thread. */
  pauseByOwner(jobId: string): ChatJob | null;
  /** Expires idle jobs; returns their ids. */
  expireIdle(nowMs?: number): string[];
  /**
   * The owner asked to be told on WhatsApp (job_notify on) or changed their mind (off). Works on an active job only; arming
   * an already-armed job keeps what it has sent. Returns the job, or null when it is not active.
   */
  setNotify(jobId: string, on: boolean): ChatJob | null;
  /**
   * The words of the latest turn's final reply, kept (bounded, line breaks kept) as the report body, with the time it was
   * written. Only a job that asked to be told keeps one; an ended job still takes it (its closing report follows `done`).
   */
  recordLastReply(jobId: string, text: string): void;
  /**
   * Records what the notifier did with one event. `sent` and `unknown` close the event for good (an unknown effect is never
   * resent); `gave_up` closes it after the retry budget; `retry` keeps it open with a backoff. Works on ended jobs too: an
   * ended job's "finished" message is sent after it ended.
   */
  recordNotifyOutcome(jobId: string, key: string, outcome: 'sent' | 'unknown' | 'gave_up' | { retryAt: string; attempts: number }): void;
  /** Jobs that asked to be told and may still owe a message: every active armed job, and armed jobs that ended recently. */
  notifyCandidates(sinceIso: string): ChatJob[];
  /** A file the job produced. `dataWork: false` for a file that says nothing about data work (write_file, edit_file). */
  recordFile(jobId: string, filePath: string, label?: string, options?: { dataWork?: boolean }): void;
  /** A BotBoy document version the job saved; an edit (`parentArtifactId`) replaces its parent's entry. */
  recordDocument(jobId: string, entry: { artifactId: string; parentArtifactId?: string; title?: string }): void;
  /** A Google Drive file the job created, uploaded or copied. */
  recordDriveFile(jobId: string, entry: { fileId: string; name?: string; kind?: string; url?: string }): void;
  /**
   * The job history page (job-history.md): every job the owner saw, newest first, kept for good. Leaves out only a provisional
   * job, which belongs to its main-chat turn until it surfaces and folds away into that reply when it does not. `query` matches
   * the title, the owner's words, the report and the end reason; `before` is the previous page's `next` cursor.
   */
  history(input?: { query?: string; status?: ChatJobHistoryStatus; before?: string; limit?: number }): ChatJobHistoryPage;
  recordDataset(jobId: string, entry: { datasetId?: string; versionId?: string; jobId?: string; title?: string }): void;
  recordDashboard(jobId: string, entry: { dashboardId: string; title?: string }): void;
  recordKnowledge(jobId: string, entry: { set: string; file: string; sha256: string }): void;
  addWatch(input: { runId: string; jobId: string; purpose?: string; source: Exclude<EtlRunWatch['source'], 'dashboard'> }): EtlRunWatch;
  /** The job waits for this refresh of one of its dashboards (§12 R1). Idempotent; a finished wait is not reopened. */
  addDashboardWait(input: { runId: string; jobId: string; dashboardId: string; title?: string }): EtlRunWatch | null;
  /** A dashboard refresh the job waited for ended: its outcome, for the job's next trigger. */
  finishDashboardWait(runId: string, jobId: string, outcome: EtlRunOutcome): void;
  /**
   * The job waits for something that ends on its own (docs/maps/job-waits.md): an export, a Data Room job, a terminal session,
   * a file, a connection, a time. Idempotent per job and thing while pending (a second call returns the same wait, its label
   * filled in if it had none). Null when the job is not active.
   */
  addJobWait(input: { jobId: string; kind: JobWaitKind; target: string; label?: string; untilOutput?: string; deadlineAt: string }): EtlRunWatch | null;
  /** One job wait by its id (`w_…`). */
  jobWait(waitId: string): EtlRunWatch | null;
  /** Pending job waits for one thing (any job): an export the model checks itself, a Data Room job it observes. */
  pendingJobWaitsFor(kind: JobWaitKind, target: string): EtlRunWatch[];
  /** A check of a pending job wait: where it stands (`note`), what the checker keeps (`lastState`), whether the check failed. */
  markJobWaitChecked(waitId: string, input: { note?: string; lastState?: string; failed?: boolean }): void;
  /** A job wait ended (or reached its deadline): its outcome, for the job's next trigger. False when it was not pending. */
  finishJobWait(waitId: string, outcome: EtlRunOutcome): boolean;
  /** The job stops waiting for this (wait_for stop). Only its own job's, and only while pending. */
  abandonJobWait(waitId: string, jobId: string): boolean;
  /** One Datanet ETL run's watch. */
  watch(runId: string): EtlRunWatch | null;
  /** Everything the job waits or waited for: its ETL runs, its dashboard refreshes and its other waits, oldest first. */
  watchesForJob(jobId: string): EtlRunWatch[];
  /** Every pending wait of an active job: ETL runs, dashboard refreshes and job waits (the watcher reads each by its `source`). */
  pendingWatches(): EtlRunWatch[];
  markPolled(runId: string, input: { remoteStatus?: string; failed?: boolean }): void;
  finishWatch(runId: string, outcome: EtlRunOutcome): void;
  /** Records the run's one queue rescue; false when it already ran. */
  markPrioritized(runId: string): boolean;
  /** A turn (owner or continuation) has seen this run's (or wait's) outcome. A dashboard refresh is consumed for `jobId` only. */
  consumeWatch(runId: string, jobId?: string): void;
  unconsumedFinished(jobId: string): EtlRunWatch[];
  /** One of the job's own ETL runs (never a dashboard refresh: mcp_etl_alter_run acts only on ETL runs). */
  isJobRun(jobId: string, runId: string): boolean;
  /** Bumped on every change; the chat panel polls it. */
  version(): number;
}

function nowIso(nowMs = Date.now()): string {
  return new Date(nowMs).toISOString();
}

function clip(value: unknown, max: number): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function emptyWorkingSet(): ChatJobWorkingSet {
  return { notes: [], files: [], datasets: [], dashboards: [], knowledge: [], documents: [], drive: [] };
}

function parseWorkingSet(raw: unknown): ChatJobWorkingSet {
  try {
    const value = JSON.parse(String(raw ?? '{}'));
    return {
      ...(typeof value.nextStep === 'string' && value.nextStep ? { nextStep: value.nextStep } : {}),
      notes: Array.isArray(value.notes) ? value.notes.filter((note: unknown) => typeof note === 'string') : [],
      files: Array.isArray(value.files) ? value.files : [],
      datasets: Array.isArray(value.datasets) ? value.datasets : [],
      dashboards: Array.isArray(value.dashboards) ? value.dashboards : [],
      knowledge: Array.isArray(value.knowledge) ? value.knowledge : [],
      documents: Array.isArray(value.documents) ? value.documents.filter((entry: any) => typeof entry?.artifactId === 'string') : [],
      drive: Array.isArray(value.drive) ? value.drive.filter((entry: any) => typeof entry?.fileId === 'string') : [],
    };
  } catch {
    return emptyWorkingSet();
  }
}

/** The stored notify record, or undefined when it is missing or malformed (never throws). */
function parseNotify(raw: unknown): ChatJobNotify | undefined {
  if (typeof raw !== 'string' || !raw) return undefined;
  try {
    const value = JSON.parse(raw);
    if (!value || value.channel !== 'whatsapp' || typeof value.armedAt !== 'string') return undefined;
    const sent = Array.isArray(value.sent)
      ? value.sent.filter((entry: any) => entry && typeof entry.key === 'string' && typeof entry.at === 'string'
        && (entry.outcome === 'sent' || entry.outcome === 'unknown' || entry.outcome === 'gave_up'))
      : [];
    const retry = value.retry && typeof value.retry.key === 'string' && typeof value.retry.notBefore === 'string'
      ? { key: value.retry.key, attempts: Math.max(0, Number(value.retry.attempts) || 0), notBefore: value.retry.notBefore }
      : undefined;
    return { channel: 'whatsapp', armedAt: value.armedAt, sent, ...(retry ? { retry } : {}) };
  } catch {
    return undefined;
  }
}

function thinkingOf(value: unknown): ChatJobThinking {
  return value === 'low' || value === 'high' || value === 'max' ? value : 'off';
}

const MAX_TITLE_CHARS = 60;
/** On the first boot with job numbers, jobs that ended this recently are numbered too (the job list's "Finished today", chat.ts › RECENT_JOBS_MS). */
const FIRST_BOOT_NUMBERED_ENDED_MS = 12 * 60 * 60_000;
/** A last word that only joins to what was cut off (the title keeps at least its first word). */
const TRAILING_JOINER = /\s+(?:a|an|the|and|or|but|of|to|for|from|with|without|using|via|in|on|at|by|into|over|about|as|that|which|so)$/i;
const MAX_OPTIONS = 4;
const MAX_OPTION_CHARS = 40;

/**
 * A short name from the owner's words when the model gave none: the first clause, polite openers dropped, at most six words.
 * "Can you please study how Local offline usage changes…" → "Study how Local offline usage changes".
 */
export function deriveJobTitle(goal: string): string {
  const text = String(goal ?? '').replace(/\s+/g, ' ').trim()
    .replace(/^(?:(?:hey|hi)\s+botboy[,:]?\s+)?(?:(?:can|could|would|will)\s+you\s+)?(?:please\s+|pls\s+|kindly\s+)?/i, '');
  const clause = text.split(/(?<=[.?!;:])\s|\n|\s[-–—]\s/)[0].replace(/[.?!;:,]+$/, '');
  let words = clause.split(' ').filter(Boolean).slice(0, 6).join(' ');
  // Six words can stop mid-phrase ("… analysis using"): a title never ends on a joining word.
  while (TRAILING_JOINER.test(words)) words = words.replace(TRAILING_JOINER, '');
  const title = words.charAt(0).toUpperCase() + words.slice(1);
  return (title.length > MAX_TITLE_CHARS ? `${title.slice(0, MAX_TITLE_CHARS - 1).trimEnd()}…` : title) || 'Owner request';
}

function parseOptions(raw: unknown): string[] | undefined {
  if (typeof raw !== 'string' || !raw) return undefined;
  try {
    const value = JSON.parse(raw);
    const options = Array.isArray(value) ? value.filter((option): option is string => typeof option === 'string' && Boolean(option.trim())) : [];
    return options.length ? options : undefined;
  } catch {
    return undefined;
  }
}

/** Cleans a finished job's next steps: short, distinct, at most three (each is a message the owner sends with one tap). */
export function cleanNextSteps(steps: unknown): string[] {
  if (!Array.isArray(steps)) return [];
  const seen = new Set<string>();
  const clean: string[] = [];
  for (const step of steps) {
    const text = clip(step, MAX_NEXT_STEP_CHARS).replace(/[.;,]+$/, '');
    if (!text || seen.has(text.toLowerCase())) continue;
    seen.add(text.toLowerCase());
    clean.push(text);
    if (clean.length >= MAX_NEXT_STEPS) break;
  }
  return clean;
}

/** The stored inbox, newest last; malformed entries are dropped (never throws). */
function parseInbox(raw: unknown): ChatJobInboxMessage[] {
  if (typeof raw !== 'string' || !raw) return [];
  try {
    const value = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    return value
      .filter((entry: any) => entry && (entry.from === 'main_chat' || entry.from === 'review' || entry.from === 'supervisor') && typeof entry.text === 'string' && entry.text && typeof entry.at === 'string')
      // `supervisor` was the §11 one-shot review's name for the main chat's own look at a job.
      .map((entry: any) => ({ from: entry.from === 'main_chat' ? 'main_chat' as const : 'review' as const, text: entry.text, ...(typeof entry.ownerWords === 'string' && entry.ownerWords ? { ownerWords: entry.ownerWords } : {}), at: entry.at }));
  } catch {
    return [];
  }
}
/** The stored tool trail of a job's latest turn; malformed entries are dropped (never throws). */
function parseToolTrail(raw: unknown): ChatJobToolStep[] {
  if (typeof raw !== 'string' || !raw) return [];
  try {
    const value = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    return value
      .filter((step: any) => step && typeof step.name === 'string' && step.name)
      .map((step: any) => ({ name: String(step.name), args: String(step.args ?? ''), result: String(step.result ?? '') }))
      .slice(-JOB_TOOL_TRAIL_MAX);
  } catch {
    return [];
  }
}

/** A message's text as it is kept: line breaks kept, runs of blank lines folded, bounded. */
function keepText(text: unknown, max: number): string {
  return String(text ?? '').replace(/\r\n?/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, max).trim();
}

/** Cleans one-tap answers: short, distinct, at most four. */
export function cleanJobOptions(options: unknown): string[] {
  if (!Array.isArray(options)) return [];
  const seen = new Set<string>();
  const clean: string[] = [];
  for (const option of options) {
    const text = clip(option, MAX_OPTION_CHARS);
    if (!text || seen.has(text.toLowerCase())) continue;
    seen.add(text.toLowerCase());
    clean.push(text);
    if (clean.length >= MAX_OPTIONS) break;
  }
  return clean;
}

export function createChatJobStore(db: Database.Database): ChatJobStore {
  db.exec(`
    CREATE TABLE IF NOT EXISTS chat_jobs (
      id TEXT PRIMARY KEY CHECK(id GLOB 'cj_[a-f0-9]*' AND length(id) = 27),
      goal TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('active','done','stopped','expired','blocked')),
      model_key TEXT,
      thinking TEXT NOT NULL DEFAULT 'off',
      working_set_json TEXT NOT NULL DEFAULT '{}',
      continuation_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      last_activity_at TEXT NOT NULL,
      ended_at TEXT,
      end_reason TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_chat_jobs_status ON chat_jobs(status, last_activity_at);
    CREATE TABLE IF NOT EXISTS etl_run_watches (
      run_id TEXT PRIMARY KEY CHECK(run_id GLOB '[0-9]*' AND length(run_id) BETWEEN 1 AND 32),
      job_id TEXT NOT NULL REFERENCES chat_jobs(id) ON DELETE CASCADE,
      purpose TEXT,
      source TEXT NOT NULL CHECK(source IN ('run_query','wait')),
      status TEXT NOT NULL CHECK(status IN ('pending','finished','abandoned')),
      remote_status TEXT,
      submitted_at TEXT NOT NULL,
      last_polled_at TEXT,
      finished_at TEXT,
      outcome_json TEXT,
      consumed_at TEXT,
      poll_failures INTEGER NOT NULL DEFAULT 0,
      prioritized_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_etl_run_watches_job ON etl_run_watches(job_id, status);
    -- A job waits for a refresh of one of its dashboards without spending turns (PARALLEL_JOBS_PLAN.md §12 R1). Its own table:
    -- etl_run_watches only takes numeric Datanet run ids.
    CREATE TABLE IF NOT EXISTS job_dashboard_waits (
      run_id TEXT NOT NULL CHECK(run_id GLOB 'run_[0-9a-f]*' AND length(run_id) BETWEEN 8 AND 64),
      job_id TEXT NOT NULL REFERENCES chat_jobs(id) ON DELETE CASCADE,
      dashboard_id TEXT NOT NULL,
      title TEXT,
      status TEXT NOT NULL CHECK(status IN ('pending','finished','abandoned')),
      since TEXT NOT NULL,
      finished_at TEXT,
      outcome_json TEXT,
      consumed_at TEXT,
      PRIMARY KEY (run_id, job_id)
    );
    CREATE INDEX IF NOT EXISTS idx_job_dashboard_waits_job ON job_dashboard_waits(job_id, status);
    -- General waits (docs/maps/job-waits.md, 2026-11-12): an export, a Data Room job, a terminal session, a file, a connection or
    -- a time a job waits for without spending turns. BotBoy checks each one (etl-run-watcher.ts) and wakes the job when it ends.
    CREATE TABLE IF NOT EXISTS job_waits (
      id TEXT PRIMARY KEY CHECK(id GLOB 'w_[a-f0-9]*' AND length(id) = 26),
      job_id TEXT NOT NULL REFERENCES chat_jobs(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK(kind IN ('sql_export','data_room_job','terminal','file','connection','time')),
      target TEXT NOT NULL CHECK(length(target) BETWEEN 1 AND 1000),
      label TEXT,
      until_output TEXT,
      status TEXT NOT NULL CHECK(status IN ('pending','finished','abandoned')),
      since TEXT NOT NULL,
      deadline_at TEXT NOT NULL,
      last_checked_at TEXT,
      state_note TEXT,
      last_state TEXT,
      check_failures INTEGER NOT NULL DEFAULT 0,
      finished_at TEXT,
      outcome_json TEXT,
      consumed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_job_waits_job ON job_waits(job_id, status);
    CREATE INDEX IF NOT EXISTS idx_job_waits_target ON job_waits(kind, target, status);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_job_waits_pending ON job_waits(job_id, kind, target) WHERE status = 'pending';
  `);
  // Stores created by the first build of this table (2026-10-08) lack the column.
  const watchColumns = (db.prepare('PRAGMA table_info(etl_run_watches)').all() as Array<{ name: string }>).map(column => column.name);
  if (!watchColumns.includes('prioritized_at')) db.exec('ALTER TABLE etl_run_watches ADD COLUMN prioritized_at TEXT');
  // Turn settlement columns (2026-10-08, second build) join existing tables.
  const jobColumns = new Set((db.prepare('PRAGMA table_info(chat_jobs)').all() as Array<{ name: string }>).map(column => column.name));
  // The first boot with job numbers (the parallel-jobs build): the store had no `seq` column yet.
  const firstNumbering = !jobColumns.has('seq');
  for (const [name, type] of [
    ['declaration', 'TEXT'], ['declared_at', 'TEXT'], ['paused_at', 'TEXT'], ['pause_note', 'TEXT'],
    ['continue_requested_at', 'TEXT'], ['continue_reason', 'TEXT'],
    ['undeclared_ends', 'INTEGER NOT NULL DEFAULT 0'], ['failed_turns', 'INTEGER NOT NULL DEFAULT 0'],
    // WhatsApp updates for a job (2026-10-19, job-notify.md): the owner's request and what BotBoy has already sent.
    ['notify_json', 'TEXT'], ['last_reply', 'TEXT'], ['last_reply_at', 'TEXT'],
    // Parallel jobs (2026-10-28, PARALLEL_JOBS_PLAN.md): the job's number and name, its thread, its provider wait, and the
    // one-tap answers of its question.
    ['seq', 'INTEGER'], ['title', 'TEXT'], ['session_id', 'TEXT'], ['rate_wait_until', 'TEXT'], ['options_json', 'TEXT'],
    ['pause_kind', 'TEXT'],
    // Reports, messages and reviews (2026-11-08, PARALLEL_JOBS_PLAN.md §11): the finished job's report and when the main chat got
    // it, its next steps, the main chat's messages waiting for its next turn, and the rounds it was kept going without the owner.
    ['report_text', 'TEXT'], ['reported_at', 'TEXT'], ['next_steps_json', 'TEXT'], ['inbox_json', 'TEXT'], ['main_reply_at', 'TEXT'],
    ['supervised_pause_at', 'TEXT'], ['supervisions', 'INTEGER NOT NULL DEFAULT 0'],
    // The main chat's look at each job state (2026-11-09, §12): the state being decided on, the last one decided, and the latest
    // turn's tool calls (the thread keeps only prose). `supervised_pause_at` (§11's one-shot review) is no longer read.
    ['review_key', 'TEXT'], ['reviewed_key', 'TEXT'], ['last_tools_json', 'TEXT'],
    // Data work (2026-11-10): the job's turns carry the detailed dashboard and Data Room rules.
    ['data_work', 'INTEGER NOT NULL DEFAULT 0'],
  ] as const) {
    if (!jobColumns.has(name)) db.exec(`ALTER TABLE chat_jobs ADD COLUMN ${name} ${type}`);
  }
  // The first boot with data work: a job whose words name data work, or that already recorded a dataset, dashboard, file or run, is
  // data work, so an active job keeps the detailed rules across the upgrade (job #12 recorded both dashboards and four datasets).
  if (!jobColumns.has('data_work')) {
    const rows = db.prepare('SELECT id, goal, title, working_set_json FROM chat_jobs').all() as Array<{ id: string; goal: string; title: string | null; working_set_json: string }>;
    const ran = new Set((db.prepare(`SELECT job_id FROM etl_run_watches UNION SELECT job_id FROM job_dashboard_waits`).all() as Array<{ job_id: string }>).map(row => row.job_id));
    const mark = db.prepare('UPDATE chat_jobs SET data_work = 1 WHERE id = ?');
    db.transaction(() => {
      for (const row of rows) {
        const set = parseWorkingSet(row.working_set_json);
        const recorded = set.datasets.length > 0 || set.dashboards.length > 0 || set.files.length > 0;
        if (recorded || ran.has(row.id) || detectJobDataWork([row.goal, row.title, set.nextStep, ...set.notes])) mark.run(row.id);
      }
    })();
  }
  // The first boot of §12: earlier builds wrote BotBoy's turn-limit pause with the owner's kind ('paused'). It is the limit's, so
  // the main chat looks at a job still paused that way like any new one (job #12 paused so on 2026-11-09).
  if (!jobColumns.has('review_key')) {
    db.prepare(`UPDATE chat_jobs SET pause_kind = 'limit' WHERE status = 'active' AND paused_at IS NOT NULL AND pause_kind = 'paused'
      AND pause_note LIKE 'Paused after % automatic continuations in a row%'`).run();
  }
  // Jobs that ended before reports existed already showed their done card: they count as reported, so the upgrade posts nothing old.
  if (!jobColumns.has('reported_at')) db.exec("UPDATE chat_jobs SET reported_at = COALESCE(ended_at, created_at) WHERE status != 'active'");
  // Numbers start with this build: jobs still active get #1, #2, … in the order they started (on every boot, so a provisional
  // job a crash cut off surfaces). On the first boot only, a job that ended in the last 12 hours gets one too, so the owner can
  // reopen it with #N (owner request 2026-10-29: a job stopped just before the upgrade stays resumable); older ones keep none.
  db.transaction(() => {
    const recentlyEndedSince = new Date(Date.now() - FIRST_BOOT_NUMBERED_ENDED_MS).toISOString();
    const unnumbered = db.prepare(`SELECT id FROM chat_jobs WHERE seq IS NULL AND (status = 'active' OR (? = 1 AND ended_at >= ?))
      ORDER BY created_at, id`).all(firstNumbering ? 1 : 0, recentlyEndedSince) as Array<{ id: string }>;
    if (!unnumbered.length) return;
    let next = Number((db.prepare('SELECT COALESCE(MAX(seq), 0) AS top FROM chat_jobs').get() as any)?.top) || 0;
    const assign = db.prepare('UPDATE chat_jobs SET seq = ? WHERE id = ?');
    for (const { id } of unnumbered) assign.run(++next, id);
  })();
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_jobs_seq ON chat_jobs(seq) WHERE seq IS NOT NULL');

  let changeVersion = 0;
  const changed = () => { changeVersion += 1; };

  // Provisional jobs (no number yet) come last; numbered jobs by number.
  const selectActiveJobs = db.prepare("SELECT * FROM chat_jobs WHERE status = 'active' ORDER BY seq IS NULL, seq, created_at");
  const selectJob = db.prepare('SELECT * FROM chat_jobs WHERE id = ?');
  const selectBySeq = db.prepare('SELECT * FROM chat_jobs WHERE seq = ?');
  const insertJob = db.prepare(`INSERT INTO chat_jobs (id, seq, title, goal, status, model_key, thinking, working_set_json, created_at, last_activity_at, data_work)
    VALUES (?, ?, ?, ?, 'active', ?, ?, '{}', ?, ?, ?)`);
  const markDataWorkStatement = db.prepare('UPDATE chat_jobs SET data_work = 1 WHERE id = ? AND data_work = 0');
  /** Sticky: a job that records data work is data work from then on (its next turn carries the detailed rules). */
  function markDataWork(jobId: string): void {
    if (markDataWorkStatement.run(jobId).changes) changed();
  }
  const selectWatch = db.prepare('SELECT * FROM etl_run_watches WHERE run_id = ?');

  function rowToJob(row: any): ChatJob | null {
    if (!row) return null;
    const notify = parseNotify(row.notify_json);
    const options = parseOptions(row.options_json);
    const nextSteps = parseOptions(row.next_steps_json);
    return {
      id: row.id,
      seq: Number(row.seq) || 0,
      title: row.title ? String(row.title) : deriveJobTitle(row.goal),
      goal: row.goal,
      status: row.status,
      ...(row.session_id ? { sessionId: String(row.session_id) } : {}),
      ...(row.rate_wait_until ? { rateWaitUntil: String(row.rate_wait_until) } : {}),
      ...(options ? { options } : {}),
      ...(row.model_key ? { modelKey: row.model_key } : {}),
      thinking: thinkingOf(row.thinking),
      workingSet: parseWorkingSet(row.working_set_json),
      continuationCount: Number(row.continuation_count) || 0,
      createdAt: row.created_at,
      lastActivityAt: row.last_activity_at,
      ...(row.ended_at ? { endedAt: row.ended_at } : {}),
      ...(row.end_reason ? { endReason: row.end_reason } : {}),
      ...(row.declaration === 'continue' || row.declaration === 'needs_owner' || row.declaration === 'wait' ? { declaration: row.declaration } : {}),
      ...(row.declared_at ? { declaredAt: row.declared_at } : {}),
      ...(row.paused_at ? { pausedAt: row.paused_at } : {}),
      ...(row.pause_note ? { pauseNote: row.pause_note } : {}),
      ...(row.paused_at && (row.pause_kind === 'question' || row.pause_kind === 'stuck' || row.pause_kind === 'limit' || row.pause_kind === 'paused') ? { pauseKind: row.pause_kind } : {}),
      ...(row.continue_requested_at ? { continueRequestedAt: row.continue_requested_at } : {}),
      ...(row.continue_reason ? { continueReason: row.continue_reason } : {}),
      undeclaredEnds: Number(row.undeclared_ends) || 0,
      failedTurns: Number(row.failed_turns) || 0,
      ...(notify ? { notify } : {}),
      ...(row.last_reply ? { lastReply: String(row.last_reply) } : {}),
      ...(row.last_reply_at ? { lastReplyAt: String(row.last_reply_at) } : {}),
      ...(row.report_text ? { report: String(row.report_text) } : {}),
      ...(row.reported_at ? { reportedAt: String(row.reported_at) } : {}),
      ...(nextSteps ? { nextSteps } : {}),
      inbox: parseInbox(row.inbox_json),
      ...(row.main_reply_at ? { mainReplyAt: String(row.main_reply_at) } : {}),
      ...(row.review_key ? { reviewKey: String(row.review_key) } : {}),
      ...(row.reviewed_key ? { reviewedKey: String(row.reviewed_key) } : {}),
      supervisions: Number(row.supervisions) || 0,
      lastTools: parseToolTrail(row.last_tools_json),
      dataWork: Number(row.data_work) === 1,
    };
  }

  function rowToWatch(row: any): EtlRunWatch | null {
    if (!row) return null;
    let outcome: EtlRunOutcome | undefined;
    try { outcome = row.outcome_json ? JSON.parse(row.outcome_json) : undefined; } catch { outcome = undefined; }
    return {
      runId: row.run_id,
      jobId: row.job_id,
      ...(row.purpose ? { purpose: row.purpose } : {}),
      source: row.source,
      status: row.status,
      ...(row.remote_status ? { remoteStatus: row.remote_status } : {}),
      submittedAt: row.submitted_at,
      ...(row.last_polled_at ? { lastPolledAt: row.last_polled_at } : {}),
      ...(row.finished_at ? { finishedAt: row.finished_at } : {}),
      ...(outcome ? { outcome } : {}),
      ...(row.consumed_at ? { consumedAt: row.consumed_at } : {}),
      pollFailures: Number(row.poll_failures) || 0,
      ...(row.prioritized_at ? { prioritizedAt: row.prioritized_at } : {}),
    };
  }

  /** A dashboard refresh the job waits for, in the shape every wait shares (the runner, the triggers, the job view). */
  function rowToDashboardWait(row: any): EtlRunWatch | null {
    if (!row) return null;
    let outcome: EtlRunOutcome | undefined;
    try { outcome = row.outcome_json ? JSON.parse(row.outcome_json) : undefined; } catch { outcome = undefined; }
    return {
      runId: row.run_id,
      jobId: row.job_id,
      purpose: `refresh of dashboard "${clip(row.title || row.dashboard_id, 120)}"`,
      source: 'dashboard',
      dashboardId: row.dashboard_id,
      status: row.status,
      ...(outcome?.remoteStatus ? { remoteStatus: outcome.remoteStatus } : {}),
      submittedAt: row.since,
      ...(row.finished_at ? { finishedAt: row.finished_at } : {}),
      ...(outcome ? { outcome } : {}),
      ...(row.consumed_at ? { consumedAt: row.consumed_at } : {}),
      pollFailures: 0,
    };
  }
  /** A general wait (job_waits), in the shape every wait shares. `purpose` is the label the wait was given. */
  function rowToJobWait(row: any): EtlRunWatch | null {
    if (!row) return null;
    let outcome: EtlRunOutcome | undefined;
    try { outcome = row.outcome_json ? JSON.parse(row.outcome_json) : undefined; } catch { outcome = undefined; }
    const remoteStatus = row.status === 'pending' ? row.state_note : outcome?.remoteStatus;
    return {
      runId: row.id,
      jobId: row.job_id,
      ...(row.label ? { purpose: String(row.label) } : {}),
      source: 'job_wait',
      kind: row.kind,
      target: row.target,
      deadlineAt: row.deadline_at,
      ...(row.until_output ? { untilOutput: String(row.until_output) } : {}),
      ...(row.last_state ? { lastState: String(row.last_state) } : {}),
      status: row.status,
      ...(remoteStatus ? { remoteStatus: String(remoteStatus) } : {}),
      submittedAt: row.since,
      ...(row.last_checked_at ? { lastPolledAt: row.last_checked_at } : {}),
      ...(row.finished_at ? { finishedAt: row.finished_at } : {}),
      ...(outcome ? { outcome } : {}),
      ...(row.consumed_at ? { consumedAt: row.consumed_at } : {}),
      pollFailures: Number(row.check_failures) || 0,
    };
  }
  const selectJobWait = db.prepare('SELECT * FROM job_waits WHERE id = ?');
  const byTime = (left: EtlRunWatch, right: EtlRunWatch) => left.submittedAt.localeCompare(right.submittedAt) || left.runId.localeCompare(right.runId);

  function abandonWatches(jobId: string): void {
    db.prepare("UPDATE etl_run_watches SET status = 'abandoned' WHERE job_id = ? AND status = 'pending'").run(jobId);
    db.prepare("UPDATE job_dashboard_waits SET status = 'abandoned' WHERE job_id = ? AND status = 'pending'").run(jobId);
    db.prepare("UPDATE job_waits SET status = 'abandoned' WHERE job_id = ? AND status = 'pending'").run(jobId);
  }

  function endJob(jobId: string, status: Exclude<ChatJobStatus, 'active'>, reason: string, extra: { nextSteps?: unknown } = {}): ChatJob | null {
    const steps = status === 'done' ? cleanNextSteps(extra.nextSteps) : [];
    const ended = db.transaction(() => {
      // The report kept before the end is dropped with it: a "finished" message carries only words written AFTER the job ended (the
      // closing report follows `job_update done` in the same turn), never an older progress note (job-notify.md). Messages still
      // waiting for a next turn go with it; the main chat's report is posted from the closing reply (§11 R1).
      const result = db.prepare(`UPDATE chat_jobs SET status = ?, ended_at = ?, end_reason = ?, last_reply = NULL, last_reply_at = NULL,
          report_text = NULL, reported_at = NULL, next_steps_json = ?, inbox_json = NULL, main_reply_at = NULL
        WHERE id = ? AND status = 'active'`).run(status, nowIso(), clip(reason, 200), steps.length ? JSON.stringify(steps) : null, jobId);
      if (result.changes) abandonWatches(jobId);
      return result.changes > 0;
    })();
    if (ended) changed();
    return rowToJob(selectJob.get(jobId));
  }

  function mutateWorkingSet(jobId: string, mutate: (set: ChatJobWorkingSet) => void): void {
    const job = rowToJob(selectJob.get(jobId));
    if (!job) return;
    const set = job.workingSet;
    mutate(set);
    db.prepare('UPDATE chat_jobs SET working_set_json = ? WHERE id = ?').run(JSON.stringify(set), jobId);
    changed();
  }

  const nextSeq = () => (Number((db.prepare('SELECT COALESCE(MAX(seq), 0) AS top FROM chat_jobs').get() as any)?.top) || 0) + 1;

  /** An ended job is active again, with fresh counts; true when it was ended (PJ1: a follow-up picks the work up again). */
  function reopenJob(jobId: string): boolean {
    const at = nowIso();
    // Its old report and next steps belong to the finished state: the job reports again when it is done again.
    const result = db.prepare(`UPDATE chat_jobs SET status = 'active', ended_at = NULL, end_reason = NULL, last_activity_at = ?,
        continuation_count = 0, paused_at = NULL, pause_note = NULL, continue_requested_at = NULL, continue_reason = NULL,
        declaration = NULL, declared_at = NULL, undeclared_ends = 0, failed_turns = 0, options_json = NULL, rate_wait_until = NULL,
        report_text = NULL, reported_at = NULL, next_steps_json = NULL, review_key = NULL, supervisions = 0
      WHERE id = ? AND status != 'active'`).run(at, jobId);
    if (!result.changes) return false;
    // A job that never had a number (ended before numbers existed) gets the next one now.
    db.transaction(() => {
      const row = selectJob.get(jobId) as any;
      if (row && (row.seq === null || row.seq === undefined)) db.prepare('UPDATE chat_jobs SET seq = ? WHERE id = ?').run(nextSeq(), jobId);
    })();
    changed();
    return true;
  }

  function start(input: { goal: string; title?: string; modelKey?: string; thinking?: ChatJobThinking; provisional?: boolean; dataWork?: boolean }): ChatJob {
    const goal = String(input.goal ?? '').trim().slice(0, MAX_GOAL_CHARS) || 'Owner request';
    const named = clip(input.title, MAX_TITLE_CHARS);
    const title = named || deriveJobTitle(goal);
    const id = `cj_${randomBytes(12).toString('hex')}`;
    const at = nowIso();
    // A caller that knows the turn did data work says so; the job's own words decide otherwise (owner decision 2026-11-10).
    const dataWork = input.dataWork === true || detectJobDataWork([goal, named]);
    // The number and the row are one transaction, so two jobs started at once never share a number.
    db.transaction(() => {
      insertJob.run(id, input.provisional ? null : nextSeq(), title, goal, input.modelKey ?? null, thinkingOf(input.thinking), at, at, dataWork ? 1 : 0);
    })();
    changed();
    return rowToJob(selectJob.get(id))!;
  }

  function surface(jobId: string): ChatJob | null {
    const surfaced = db.transaction(() => {
      const row = selectJob.get(jobId) as any;
      if (!row || row.seq !== null) return false;
      db.prepare('UPDATE chat_jobs SET seq = ? WHERE id = ? AND seq IS NULL').run(nextSeq(), jobId);
      return true;
    })();
    if (surfaced) changed();
    return rowToJob(selectJob.get(jobId));
  }

  return {
    activeJobs: () => (selectActiveJobs.all() as any[]).map(row => rowToJob(row)!),
    // Only numbered jobs: a provisional job that folded away was never a job the owner saw.
    recentlyEnded: (sinceIso, limit = 20) => (db.prepare(`SELECT * FROM chat_jobs WHERE status != 'active' AND ended_at >= ? AND seq IS NOT NULL
      ORDER BY ended_at DESC LIMIT ?`).all(sinceIso, Math.max(1, Math.min(100, limit))) as any[]).map(row => rowToJob(row)!),
    get: (jobId) => rowToJob(selectJob.get(jobId)),
    history(input = {}) {
      // Every job the owner saw. A provisional job (no number) is its main-chat turn's until it surfaces; one that folded away
      // into that turn's reply was never a job. Jobs from before numbers (no number, ended) are real jobs and stay.
      const visible = `NOT (seq IS NULL AND (status = 'active' OR end_reason = ?))`;
      const words = String(input.query ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
      const match = words ? ` AND (title LIKE ? ESCAPE '\\' OR goal LIKE ? ESCAPE '\\' OR report_text LIKE ? ESCAPE '\\' OR end_reason LIKE ? ESCAPE '\\')` : '';
      const matchArgs = words ? Array(4).fill(likePattern(words)) : [];
      const counted = db.prepare(`SELECT COUNT(*) AS total, COALESCE(SUM(status = 'done'), 0) AS done,
          COALESCE(SUM(status IN ('stopped', 'expired')), 0) AS stopped
        FROM chat_jobs WHERE ${visible}${match}`).get(CHAT_JOB_FOLDED_REASON, ...matchArgs) as any;
      const status = input.status === 'done' || input.status === 'stopped' ? input.status : 'all';
      const statusSql = status === 'done' ? ` AND status = 'done'` : status === 'stopped' ? ` AND status IN ('stopped', 'expired')` : '';
      const cursor = HISTORY_CURSOR_RE.exec(String(input.before ?? ''));
      const cursorSql = cursor ? ' AND (created_at < ? OR (created_at = ? AND id < ?))' : '';
      const cursorArgs = cursor ? [cursor[1], cursor[1], cursor[2]] : [];
      const limit = Math.max(1, Math.min(100, Math.floor(Number(input.limit) || HISTORY_PAGE)));
      const rows = db.prepare(`SELECT * FROM chat_jobs WHERE ${visible}${match}${statusSql}${cursorSql}
        ORDER BY created_at DESC, id DESC LIMIT ?`).all(CHAT_JOB_FOLDED_REASON, ...matchArgs, ...cursorArgs, limit + 1) as any[];
      const jobs = rows.slice(0, limit).map(row => rowToJob(row)!);
      const last = jobs[jobs.length - 1];
      return {
        jobs,
        ...(rows.length > limit && last ? { next: `${last.createdAt}|${last.id}` } : {}),
        counts: { all: Number(counted?.total) || 0, done: Number(counted?.done) || 0, stopped: Number(counted?.stopped) || 0 },
      };
    },
    bySeq: (seq) => (Number.isInteger(seq) && seq > 0 ? rowToJob(selectBySeq.get(seq)) : null),
    start,
    markDataWork,
    surface,
    setSession(jobId, sessionId) {
      const result = db.prepare('UPDATE chat_jobs SET session_id = ? WHERE id = ? AND (session_id IS NULL OR session_id = ?)').run(sessionId, jobId, sessionId);
      if (result.changes) changed();
    },
    touch(jobId, input = {}) {
      const sets = ['last_activity_at = ?'];
      const values: unknown[] = [nowIso()];
      if (input.modelKey !== undefined) { sets.push('model_key = ?'); values.push(input.modelKey || null); }
      if (input.thinking !== undefined) { sets.push('thinking = ?'); values.push(thinkingOf(input.thinking)); }
      const result = db.prepare(`UPDATE chat_jobs SET ${sets.join(', ')} WHERE id = ? AND status = 'active'`).run(...values, jobId);
      if (result.changes) changed();
    },
    update(jobId, input) {
      const job = rowToJob(selectJob.get(jobId));
      if (!job || job.status !== 'active') return job;
      const goal = input.goal !== undefined ? String(input.goal).trim().slice(0, MAX_GOAL_CHARS) : undefined;
      if (goal) db.prepare('UPDATE chat_jobs SET goal = ? WHERE id = ?').run(goal, jobId);
      const title = input.title !== undefined ? clip(input.title, MAX_TITLE_CHARS) : undefined;
      if (title) db.prepare('UPDATE chat_jobs SET title = ? WHERE id = ?').run(title, jobId);
      mutateWorkingSet(jobId, (set) => {
        if (input.nextStep !== undefined) {
          const next = clip(input.nextStep, 600);
          if (next) set.nextStep = next; else delete set.nextStep;
        }
        for (const note of input.notes ?? []) {
          const text = clip(note, MAX_NOTE_CHARS);
          if (text && !set.notes.includes(text)) set.notes.push(text);
        }
        if (set.notes.length > MAX_NOTES) set.notes = set.notes.slice(-MAX_NOTES);
      });
      db.prepare('UPDATE chat_jobs SET last_activity_at = ? WHERE id = ?').run(nowIso(), jobId);
      return rowToJob(selectJob.get(jobId));
    },
    end: endJob,
    recordReport(jobId, text) {
      const report = keepText(text, JOB_REPORT_CHARS);
      if (!report) return;
      const result = db.prepare("UPDATE chat_jobs SET report_text = ? WHERE id = ? AND status = 'done'").run(report, jobId);
      if (result.changes) changed();
    },
    unreportedEnded(sinceIso) {
      return (db.prepare(`SELECT * FROM chat_jobs WHERE status IN ('done','expired') AND seq IS NOT NULL AND reported_at IS NULL
        AND ended_at >= ? ORDER BY ended_at, seq`).all(sinceIso) as any[]).map(row => rowToJob(row)!);
    },
    markReported(jobId) {
      const result = db.prepare("UPDATE chat_jobs SET reported_at = ? WHERE id = ? AND reported_at IS NULL AND status IN ('done','expired')")
        .run(nowIso(), jobId);
      if (result.changes) changed();
      return result.changes > 0;
    },
    deliverMessage(jobId, message) {
      const text = keepText(message.text, JOB_INBOX_TEXT_CHARS);
      if (!text) return null;
      const fromMain = message.from === 'main_chat';
      const delivered = db.transaction(() => {
        let row = selectJob.get(jobId) as any;
        if (!row) return false;
        if (row.status !== 'active') {
          // Only the main chat (the owner's turn there) picks an ended job up again, as the owner's own message in it would.
          if (!fromMain) return false;
          if (!reopenJob(jobId)) return false;
          row = selectJob.get(jobId) as any;
        }
        const at = nowIso();
        const ownerWords = fromMain ? keepText(message.ownerWords, 1_200) : '';
        const inbox = [...parseInbox(row.inbox_json), { from: message.from, text, ...(ownerWords ? { ownerWords } : {}), at }].slice(-JOB_INBOX_MAX);
        const reason = fromMain ? JOB_MESSAGE_REASON : JOB_REVIEW_REASON;
        // A message from the main chat comes from the owner's turn there: like the owner's own reply, it clears every streak and
        // count and any provider wait. The main chat's own look keeps the streaks, counts one round it kept the job going without
        // the owner, and gives a job stopped at the turn limit a fresh round of turns (§12 R3).
        const reset = fromMain
          ? `, undeclared_ends = 0, failed_turns = 0, continuation_count = 0, supervisions = 0, rate_wait_until = NULL,
             declaration = NULL, declared_at = NULL, main_reply_at = ?`
          : `, supervisions = supervisions + 1, continuation_count = CASE WHEN pause_kind = 'limit' AND paused_at IS NOT NULL THEN 0 ELSE continuation_count END`;
        db.prepare(`UPDATE chat_jobs SET inbox_json = ?, continue_requested_at = ?, continue_reason = ?, paused_at = NULL, pause_note = NULL,
            options_json = NULL, last_activity_at = ?${reset} WHERE id = ? AND status = 'active'`)
          .run(JSON.stringify(inbox), at, reason, at, ...(fromMain ? [at] : []), jobId);
        return true;
      })();
      if (!delivered) return null;
      changed();
      return rowToJob(selectJob.get(jobId));
    },
    consumeInbox(jobId, uptoIso) {
      const row = selectJob.get(jobId) as any;
      if (!row) return;
      const before = parseInbox(row.inbox_json);
      const rest = before.filter(message => message.at > uptoIso);
      if (rest.length === before.length) return;
      db.prepare('UPDATE chat_jobs SET inbox_json = ? WHERE id = ?').run(rest.length ? JSON.stringify(rest) : null, jobId);
      changed();
    },
    takeMainReply(jobId, turnStartedIso) {
      const result = db.prepare('UPDATE chat_jobs SET main_reply_at = NULL WHERE id = ? AND main_reply_at IS NOT NULL AND main_reply_at <= ?')
        .run(jobId, turnStartedIso);
      if (result.changes) changed();
      return result.changes > 0;
    },
    continueJob(jobId, input) {
      const at = nowIso();
      if (input.from === 'review') {
        // Only a pause BotBoy made: its turn limit (a fresh round of turns) or stuck (a fresh retry). A question waits for an answer,
        // and a pause the owner made stays his. One round of MAX_REVIEW_ROUNDS.
        const result = db.prepare(`UPDATE chat_jobs SET paused_at = NULL, pause_note = NULL, options_json = NULL,
            continue_requested_at = ?, continue_reason = ?, declaration = NULL, declared_at = NULL, undeclared_ends = 0, failed_turns = 0,
            continuation_count = CASE WHEN pause_kind = 'limit' THEN 0 ELSE continuation_count END,
            supervisions = supervisions + 1, last_activity_at = ?
          WHERE id = ? AND status = 'active' AND paused_at IS NOT NULL AND pause_kind IN ('limit','stuck')`).run(at, JOB_CONTINUE_REASON, at, jobId);
        if (!result.changes) return null;
        changed();
        return rowToJob(selectJob.get(jobId));
      }
      // The owner's own word from the main chat: an ended job reopens, any pause clears, and every count starts over.
      const continued = db.transaction(() => {
        const row = selectJob.get(jobId) as any;
        if (!row) return false;
        if (row.status !== 'active' && !reopenJob(jobId)) return false;
        const current = selectJob.get(jobId) as any;
        if (current.status !== 'active' || (!current.paused_at && current.continue_requested_at)) return false;
        db.prepare(`UPDATE chat_jobs SET paused_at = NULL, pause_note = NULL, options_json = NULL, continue_requested_at = ?, continue_reason = ?,
            declaration = NULL, declared_at = NULL, undeclared_ends = 0, failed_turns = 0, continuation_count = 0, supervisions = 0,
            rate_wait_until = NULL, last_activity_at = ? WHERE id = ? AND status = 'active'`)
          .run(at, 'The owner asked from the main chat for this job to carry on.', at, jobId);
        return true;
      })();
      if (!continued) return null;
      changed();
      return rowToJob(selectJob.get(jobId));
    },
    askOwner(jobId, question, options) {
      const note = clip(question, 600);
      if (!note) return null;
      const answers = cleanJobOptions(options);
      const at = nowIso();
      // The question the main chat sets counts as looked at, so it never starts another update about itself.
      const result = db.prepare(`UPDATE chat_jobs SET paused_at = COALESCE(paused_at, ?), pause_kind = 'question', pause_note = ?, options_json = ?,
          continue_requested_at = NULL, continue_reason = NULL, reviewed_key = 'question:' || COALESCE(paused_at, ?), last_activity_at = ?
        WHERE id = ? AND status = 'active' AND NOT (paused_at IS NOT NULL AND pause_kind IN ('paused','question'))`)
        .run(at, note, answers.length ? JSON.stringify(answers) : null, at, at, jobId);
      if (!result.changes) return null;
      changed();
      return rowToJob(selectJob.get(jobId));
    },
    claimReview(jobId, key) {
      const result = db.prepare(`UPDATE chat_jobs SET review_key = ? WHERE id = ? AND status = 'active'
          AND COALESCE(review_key, '') != ? AND COALESCE(reviewed_key, '') != ?`).run(key, jobId, key, key);
      if (result.changes) changed();
      return result.changes > 0;
    },
    finishReview(jobId, key) {
      // The job's current pause, when it is already marked handled, stays so: the question the main chat asked during this very
      // turn (askOwner) must not become an update about itself once the turn that asked it ends.
      const result = db.prepare(`UPDATE chat_jobs SET
          reviewed_key = CASE WHEN paused_at IS NOT NULL AND reviewed_key = pause_kind || ':' || paused_at THEN reviewed_key ELSE ? END,
          review_key = CASE WHEN review_key = ? THEN NULL ELSE review_key END
        WHERE id = ?`).run(key, key, jobId);
      if (result.changes) changed();
    },
    releaseReview(jobId, key) {
      const result = db.prepare('UPDATE chat_jobs SET review_key = NULL WHERE id = ? AND review_key = ?').run(jobId, key);
      if (result.changes) changed();
    },
    releaseAllReviews() {
      const result = db.prepare('UPDATE chat_jobs SET review_key = NULL WHERE review_key IS NOT NULL').run();
      if (result.changes) changed();
      return result.changes;
    },
    recordTurnTools(jobId, steps) {
      const kept = (Array.isArray(steps) ? steps : []).slice(-JOB_TOOL_TRAIL_MAX).map(step => ({
        name: clip(step.name, 80),
        args: String(step.args ?? '').slice(0, 400),
        result: String(step.result ?? '').slice(0, 1_200),
      })).filter(step => step.name);
      db.prepare('UPDATE chat_jobs SET last_tools_json = ? WHERE id = ?').run(kept.length ? JSON.stringify(kept) : null, jobId);
    },
    incrementContinuations(jobId) {
      db.prepare('UPDATE chat_jobs SET continuation_count = continuation_count + 1, last_activity_at = ? WHERE id = ?')
        .run(nowIso(), jobId);
      changed();
      return Number((selectJob.get(jobId) as any)?.continuation_count) || 0;
    },
    declare(jobId, declaration, note, options) {
      const answers = declaration === 'needs_owner' ? cleanJobOptions(options) : [];
      const result = db.prepare(`UPDATE chat_jobs SET declaration = ?, declared_at = ?, last_activity_at = ?, options_json = ?
        WHERE id = ? AND status = 'active'`).run(declaration, nowIso(), nowIso(), answers.length ? JSON.stringify(answers) : null, jobId);
      if (note !== undefined && result.changes) {
        db.prepare('UPDATE chat_jobs SET pause_note = CASE WHEN ? = \'needs_owner\' THEN ? ELSE pause_note END, continue_reason = CASE WHEN ? = \'continue\' THEN ? ELSE continue_reason END WHERE id = ?')
          .run(declaration, clip(note, 600) || null, declaration, clip(note, 600) || null, jobId);
      }
      if (result.changes) changed();
      return rowToJob(selectJob.get(jobId));
    },
    settle(jobId, settlement, end) {
      const at = nowIso();
      const undeclaredDelta = settlement.action === 'continue' && settlement.undeclared ? 1 : 0;
      db.transaction(() => {
        const failed = end === 'failed' ? 'failed_turns + 1' : end === 'answered' ? '0' : 'failed_turns';
        const undeclared = undeclaredDelta ? 'undeclared_ends + 1' : end === 'answered' ? '0' : 'undeclared_ends';
        // A provider wait lasts until the next settle: any other end clears it (the job is no longer held back).
        const rateWait = settlement.action === 'continue' && settlement.notBefore ? settlement.notBefore : null;
        db.prepare(`UPDATE chat_jobs SET failed_turns = ${failed}, undeclared_ends = ${undeclared},
            declaration = NULL, declared_at = NULL, last_activity_at = ?, rate_wait_until = ? WHERE id = ? AND status = 'active'`).run(at, rateWait, jobId);
        if (settlement.action === 'continue') {
          db.prepare(`UPDATE chat_jobs SET continue_requested_at = ?, continue_reason = ?, paused_at = NULL, pause_note = NULL, options_json = NULL
            WHERE id = ? AND status = 'active'`).run(at, clip(settlement.reason, 600), jobId);
        } else if (settlement.action === 'pause') {
          // The one-tap answers belong to a needs_owner question; any other pause offers none.
          const kind: ChatJobPauseKind = settlement.kind ?? 'paused';
          db.prepare(`UPDATE chat_jobs SET paused_at = ?, pause_note = ?, pause_kind = ?, continue_requested_at = NULL, continue_reason = NULL,
              options_json = CASE WHEN ? = 'question' THEN options_json ELSE NULL END
            WHERE id = ? AND status = 'active'`).run(at, clip(settlement.note, 600), kind, kind, jobId);
        } else if (settlement.action === 'wait') {
          db.prepare(`UPDATE chat_jobs SET paused_at = NULL, pause_note = NULL, continue_requested_at = NULL, continue_reason = NULL, options_json = NULL
            WHERE id = ? AND status = 'active'`).run(jobId);
        }
      })();
      changed();
      return rowToJob(selectJob.get(jobId));
    },
    ownerResumed(jobId) {
      // The owner is talking to the job: the main chat's rounds start over too (MAX_REVIEW_ROUNDS counts since the owner's last word).
      const result = db.prepare(`UPDATE chat_jobs SET paused_at = NULL, pause_note = NULL, continue_requested_at = NULL,
          continue_reason = NULL, declaration = NULL, declared_at = NULL, undeclared_ends = 0, failed_turns = 0,
          options_json = NULL, rate_wait_until = NULL,
          continuation_count = 0, supervisions = 0
        WHERE id = ? AND status = 'active'`).run(jobId);
      if (result.changes) changed();
    },
    wake(jobId, reason) {
      const at = nowIso();
      const result = db.prepare(`UPDATE chat_jobs SET continue_requested_at = ?, continue_reason = ?, paused_at = NULL, pause_note = NULL,
          declaration = NULL, declared_at = NULL, options_json = NULL, last_activity_at = ?
        WHERE id = ? AND status = 'active' AND paused_at IS NOT NULL AND continue_requested_at IS NULL`).run(at, clip(reason, 600), at, jobId);
      if (!result.changes) return null;
      changed();
      return rowToJob(selectJob.get(jobId));
    },
    requestTurn(jobId, reason) {
      const at = nowIso();
      const result = db.prepare(`UPDATE chat_jobs SET continue_requested_at = ?, continue_reason = ?, paused_at = NULL, pause_note = NULL,
          options_json = NULL, last_activity_at = ? WHERE id = ? AND status = 'active'`).run(at, clip(reason, 600), at, jobId);
      if (!result.changes) return null;
      changed();
      return rowToJob(selectJob.get(jobId));
    },
    reopen(jobId) {
      reopenJob(jobId);
      return rowToJob(selectJob.get(jobId));
    },
    pauseByOwner(jobId) {
      const at = nowIso();
      const result = db.prepare(`UPDATE chat_jobs SET paused_at = ?, pause_note = ?, pause_kind = 'paused', continue_requested_at = NULL,
          continue_reason = NULL, options_json = NULL, last_activity_at = ? WHERE id = ? AND status = 'active'`)
        .run(at, 'You paused this job. Resume it from its menu, or ask it here to carry on.', at, jobId);
      if (!result.changes) return null;
      changed();
      return rowToJob(selectJob.get(jobId));
    },
    clearContinueRequest(jobId) {
      const result = db.prepare(`UPDATE chat_jobs SET continue_requested_at = NULL, paused_at = NULL, pause_note = NULL
        WHERE id = ?`).run(jobId);
      if (result.changes) changed();
    },
    expireIdle(nowMs = Date.now()) {
      const cutoff = nowIso(nowMs - CHAT_JOB_IDLE_MS);
      const idle = db.prepare("SELECT id FROM chat_jobs WHERE status = 'active' AND last_activity_at < ?").all(cutoff) as Array<{ id: string }>;
      for (const { id } of idle) endJob(id, 'expired', 'idle for 24 hours');
      return idle.map(row => row.id);
    },
    setNotify(jobId, on) {
      const job = rowToJob(selectJob.get(jobId));
      if (!job || job.status !== 'active') return null;
      if (!on) {
        db.prepare('UPDATE chat_jobs SET notify_json = NULL, last_reply = NULL, last_reply_at = NULL WHERE id = ?').run(jobId);
      } else if (!job.notify) {
        const armed: ChatJobNotify = { channel: 'whatsapp', armedAt: nowIso(), sent: [] };
        db.prepare('UPDATE chat_jobs SET notify_json = ? WHERE id = ?').run(JSON.stringify(armed), jobId);
      }
      changed();
      return rowToJob(selectJob.get(jobId));
    },
    recordLastReply(jobId, text) {
      // Line breaks stay (the report is read on a phone); only a job that asked to be told keeps its reply at all.
      const reply = String(text ?? '').replace(/\r\n?/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, NOTIFY_REPLY_CHARS);
      if (!reply) return;
      // Also a job that has just ended: `job_update done` ends it in the middle of a turn and the closing report is written
      // after that. The timestamp lets the notifier wait for the reply that belongs to the end.
      const result = db.prepare('UPDATE chat_jobs SET last_reply = ?, last_reply_at = ? WHERE id = ? AND notify_json IS NOT NULL').run(reply, nowIso(), jobId);
      if (result.changes) changed();
    },
    recordNotifyOutcome(jobId, key, outcome) {
      const job = rowToJob(selectJob.get(jobId));
      if (!job?.notify) return;
      // Any earlier entry for this event is replaced: the in-flight 'unknown' by its result, or removed when a retry reopens it.
      const notify: ChatJobNotify = { ...job.notify, sent: job.notify.sent.filter(entry => entry.key !== key) };
      if (typeof outcome === 'string') {
        // An attempt in flight is written as 'unknown' BEFORE the send, then replaced by its result: a crash in between
        // leaves 'unknown', and an unknown event is never sent again.
        notify.sent.push({ key, at: nowIso(), outcome });
        if (notify.retry?.key === key) delete notify.retry;
      } else {
        // The attempt provably sent nothing: the event is open again, to be retried after the backoff.
        notify.retry = { key, attempts: outcome.attempts, notBefore: outcome.retryAt };
      }
      if (notify.sent.length > NOTIFY_SENT_KEEP) notify.sent = notify.sent.slice(-NOTIFY_SENT_KEEP);
      db.prepare('UPDATE chat_jobs SET notify_json = ? WHERE id = ?').run(JSON.stringify(notify), jobId);
      changed();
    },
    notifyCandidates(sinceIso) {
      const rows = db.prepare(`SELECT * FROM chat_jobs
        WHERE notify_json IS NOT NULL AND (status = 'active' OR ended_at >= ?)
        ORDER BY last_activity_at DESC LIMIT 20`).all(sinceIso) as any[];
      return rows.map(row => rowToJob(row)).filter((job): job is ChatJob => Boolean(job?.notify));
    },
    recordFile(jobId, filePath, label, options = {}) {
      const clean = clip(filePath, 1_000);
      if (!clean) return;
      mutateWorkingSet(jobId, (set) => {
        set.files = set.files.filter(file => file.path !== clean);
        set.files.push({ path: clean, ...(label ? { label: clip(label, 160) } : {}), at: nowIso() });
        if (set.files.length > MAX_LIST) set.files = set.files.slice(-MAX_LIST);
      });
      // ETL results and exports mean data work; a file the job wrote itself (write_file, edit_file) says nothing about it.
      if (options.dataWork !== false) markDataWork(jobId);
    },
    recordDocument(jobId, entry) {
      const artifactId = clip(entry.artifactId, 200);
      if (!artifactId) return;
      mutateWorkingSet(jobId, (set) => {
        const replaced = set.documents.find(doc => doc.artifactId === artifactId || (entry.parentArtifactId && doc.artifactId === entry.parentArtifactId));
        set.documents = set.documents.filter(doc => doc !== replaced);
        const title = entry.title ? clip(entry.title, 160) : replaced?.title;
        set.documents.push({ artifactId, ...(title ? { title } : {}), at: nowIso() });
        if (set.documents.length > MAX_LIST) set.documents = set.documents.slice(-MAX_LIST);
      });
    },
    recordDriveFile(jobId, entry) {
      const fileId = clip(entry.fileId, 200);
      if (!fileId) return;
      // Only Google's own https file links are kept: a link is opened by the owner's click.
      const url = typeof entry.url === 'string' && /^https:\/\/(?:docs|drive)\.google\.com\//.test(entry.url) ? clip(entry.url, 500) : undefined;
      mutateWorkingSet(jobId, (set) => {
        set.drive = set.drive.filter(file => file.fileId !== fileId);
        set.drive.push({
          fileId,
          ...(entry.name ? { name: clip(entry.name, 160) } : {}),
          ...(entry.kind ? { kind: clip(entry.kind, 40) } : {}),
          ...(url ? { url } : {}),
          at: nowIso(),
        });
        if (set.drive.length > MAX_LIST) set.drive = set.drive.slice(-MAX_LIST);
      });
    },
    recordDataset(jobId, entry) {
      if (!entry.datasetId && !entry.jobId) return;
      mutateWorkingSet(jobId, (set) => {
        set.datasets = set.datasets.filter(dataset => !(
          (entry.datasetId && dataset.datasetId === entry.datasetId)
          || (!entry.datasetId && entry.jobId && dataset.jobId === entry.jobId && !dataset.datasetId)
        ));
        set.datasets.push({
          ...(entry.datasetId ? { datasetId: entry.datasetId } : {}),
          ...(entry.versionId ? { versionId: entry.versionId } : {}),
          ...(entry.jobId ? { jobId: entry.jobId } : {}),
          ...(entry.title ? { title: clip(entry.title, 160) } : {}),
          at: nowIso(),
        });
        if (set.datasets.length > MAX_LIST) set.datasets = set.datasets.slice(-MAX_LIST);
      });
      markDataWork(jobId);
    },
    recordDashboard(jobId, entry) {
      if (!entry.dashboardId) return;
      mutateWorkingSet(jobId, (set) => {
        const previous = set.dashboards.find(dashboard => dashboard.dashboardId === entry.dashboardId);
        set.dashboards = set.dashboards.filter(dashboard => dashboard.dashboardId !== entry.dashboardId);
        const title = entry.title ? clip(entry.title, 160) : previous?.title;
        set.dashboards.push({ dashboardId: entry.dashboardId, ...(title ? { title } : {}), at: nowIso() });
        if (set.dashboards.length > MAX_LIST) set.dashboards = set.dashboards.slice(-MAX_LIST);
      });
      markDataWork(jobId);
    },
    recordKnowledge(jobId, entry) {
      if (!entry.set || !entry.file) return;
      mutateWorkingSet(jobId, (set) => {
        set.knowledge = set.knowledge.filter(known => !(known.set === entry.set && known.file === entry.file));
        set.knowledge.push({ set: clip(entry.set, 120), file: clip(entry.file, 200), sha256: entry.sha256, at: nowIso() });
        if (set.knowledge.length > MAX_LIST) set.knowledge = set.knowledge.slice(-MAX_LIST);
      });
    },
    addWatch(input) {
      const runId = String(input.runId ?? '').trim();
      if (!/^\d{1,32}$/.test(runId)) throw new Error('ETL run id must be numeric');
      // A run belongs to the job that first watched it; a later watch only
      // fills a missing purpose. A watch abandoned with an ended job moves to
      // the job that watches it again.
      db.prepare(`INSERT INTO etl_run_watches (run_id, job_id, purpose, source, status, submitted_at)
        VALUES (?, ?, ?, ?, 'pending', ?)
        ON CONFLICT(run_id) DO UPDATE SET
          purpose = COALESCE(etl_run_watches.purpose, excluded.purpose),
          job_id = CASE WHEN etl_run_watches.status = 'abandoned' THEN excluded.job_id ELSE etl_run_watches.job_id END,
          status = CASE WHEN etl_run_watches.status = 'abandoned' THEN 'pending' ELSE etl_run_watches.status END,
          poll_failures = CASE WHEN etl_run_watches.status = 'abandoned' THEN 0 ELSE etl_run_watches.poll_failures END`)
        .run(runId, input.jobId, input.purpose ? clip(input.purpose, 300) : null, input.source, nowIso());
      db.prepare('UPDATE chat_jobs SET last_activity_at = ? WHERE id = ?').run(nowIso(), input.jobId);
      markDataWork(input.jobId);
      changed();
      return rowToWatch(selectWatch.get(runId))!;
    },
    addDashboardWait(input) {
      const runId = String(input.runId ?? '').trim();
      const dashboardId = String(input.dashboardId ?? '').trim();
      if (!/^run_[0-9a-f]{4,60}$/.test(runId) || !dashboardId) return null;
      const job = selectJob.get(input.jobId) as any;
      if (!job || job.status !== 'active') return null;
      const at = nowIso();
      const inserted = db.prepare(`INSERT INTO job_dashboard_waits (run_id, job_id, dashboard_id, title, status, since) VALUES (?, ?, ?, ?, 'pending', ?)
        ON CONFLICT(run_id, job_id) DO NOTHING`).run(runId, input.jobId, dashboardId, input.title ? clip(input.title, 160) : null, at);
      if (inserted.changes) {
        db.prepare('UPDATE chat_jobs SET last_activity_at = ? WHERE id = ?').run(at, input.jobId);
        markDataWork(input.jobId);
        changed();
      }
      return rowToDashboardWait(db.prepare('SELECT * FROM job_dashboard_waits WHERE run_id = ? AND job_id = ?').get(runId, input.jobId));
    },
    finishDashboardWait(runId, jobId, outcome) {
      const at = nowIso();
      const result = db.prepare(`UPDATE job_dashboard_waits SET status = 'finished', finished_at = ?, outcome_json = ?
        WHERE run_id = ? AND job_id = ? AND status = 'pending'`)
        .run(at, JSON.stringify({ ...outcome, remoteStatus: clip(outcome.remoteStatus, 40), ...(outcome.error ? { error: clip(outcome.error, 800) } : {}) }), runId, jobId);
      if (result.changes) changed();
    },
    addJobWait(input) {
      const job = selectJob.get(input.jobId) as any;
      if (!job || job.status !== 'active') return null;
      const target = String(input.target ?? '').trim().slice(0, 1_000);
      if (!target) return null;
      const at = nowIso();
      const label = input.label ? clip(input.label, 160) : null;
      const id = `w_${randomBytes(12).toString('hex')}`;
      // One pending wait per job and thing: a second wait_for (or BotBoy's own registration) returns the same wait.
      const inserted = db.prepare(`INSERT INTO job_waits (id, job_id, kind, target, label, until_output, status, since, deadline_at)
        VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?) ON CONFLICT DO NOTHING`)
        .run(id, input.jobId, input.kind, target, label, input.untilOutput ? String(input.untilOutput).slice(0, 200) : null, at, input.deadlineAt);
      if (!inserted.changes && label) {
        db.prepare(`UPDATE job_waits SET label = COALESCE(label, ?) WHERE job_id = ? AND kind = ? AND target = ? AND status = 'pending'`)
          .run(label, input.jobId, input.kind, target);
      }
      db.prepare('UPDATE chat_jobs SET last_activity_at = ? WHERE id = ?').run(at, input.jobId);
      // An export or a Data Room job is data work: the job's turns carry the detailed rules.
      if (input.kind === 'sql_export' || input.kind === 'data_room_job') markDataWork(input.jobId);
      changed();
      return rowToJobWait(db.prepare(`SELECT * FROM job_waits WHERE job_id = ? AND kind = ? AND target = ? AND status = 'pending'`)
        .get(input.jobId, input.kind, target));
    },
    jobWait: (waitId) => rowToJobWait(selectJobWait.get(String(waitId ?? '').trim())),
    pendingJobWaitsFor: (kind, target) => (db.prepare(`SELECT * FROM job_waits WHERE kind = ? AND target = ? AND status = 'pending' ORDER BY since`)
      .all(kind, String(target ?? '').trim()) as any[]).map(row => rowToJobWait(row)!),
    markJobWaitChecked(waitId, input) {
      const result = db.prepare(`UPDATE job_waits SET last_checked_at = ?, state_note = COALESCE(?, state_note),
          last_state = COALESCE(?, last_state), check_failures = check_failures + ?
        WHERE id = ? AND status = 'pending'`)
        .run(nowIso(), input.note ? clip(input.note, 200) : null, input.lastState ? String(input.lastState).slice(0, 200) : null, input.failed ? 1 : 0, waitId);
      // The note is shown while the job waits; a bare check (nothing new to show) changes nothing the panel draws.
      if (result.changes && input.note) changed();
    },
    finishJobWait(waitId, outcome) {
      const at = nowIso();
      const result = db.prepare(`UPDATE job_waits SET status = 'finished', finished_at = ?, last_checked_at = ?, outcome_json = ?
        WHERE id = ? AND status = 'pending'`)
        .run(at, at, JSON.stringify({
          ...outcome,
          remoteStatus: clip(outcome.remoteStatus, 40),
          ...(outcome.error ? { error: clip(outcome.error, 800) } : {}),
          ...(outcome.summary ? { summary: clip(outcome.summary, 300) } : {}),
          ...(outcome.detail ? { detail: String(outcome.detail).slice(-1_000) } : {}),
          ...(outcome.columns ? { columns: outcome.columns.slice(0, 60).map(column => clip(column, 80)) } : {}),
        }), waitId);
      if (result.changes) changed();
      return result.changes > 0;
    },
    abandonJobWait(waitId, jobId) {
      const result = db.prepare("UPDATE job_waits SET status = 'abandoned', finished_at = ? WHERE id = ? AND job_id = ? AND status = 'pending'")
        .run(nowIso(), String(waitId ?? '').trim(), jobId);
      if (result.changes) changed();
      return result.changes > 0;
    },
    watch: (runId) => rowToWatch(selectWatch.get(String(runId ?? '').trim())),
    watchesForJob: (jobId) => [
      ...(db.prepare('SELECT * FROM etl_run_watches WHERE job_id = ?').all(jobId) as any[]).map(row => rowToWatch(row)!),
      ...(db.prepare('SELECT * FROM job_dashboard_waits WHERE job_id = ?').all(jobId) as any[]).map(row => rowToDashboardWait(row)!),
      ...(db.prepare('SELECT * FROM job_waits WHERE job_id = ?').all(jobId) as any[]).map(row => rowToJobWait(row)!),
    ].sort(byTime),
    pendingWatches: () => [
      ...(db.prepare(`SELECT w.* FROM etl_run_watches w JOIN chat_jobs j ON j.id = w.job_id
        WHERE w.status = 'pending' AND j.status = 'active'`).all() as any[]).map(row => rowToWatch(row)!),
      ...(db.prepare(`SELECT w.* FROM job_dashboard_waits w JOIN chat_jobs j ON j.id = w.job_id
        WHERE w.status = 'pending' AND j.status = 'active'`).all() as any[]).map(row => rowToDashboardWait(row)!),
      ...(db.prepare(`SELECT w.* FROM job_waits w JOIN chat_jobs j ON j.id = w.job_id
        WHERE w.status = 'pending' AND j.status = 'active'`).all() as any[]).map(row => rowToJobWait(row)!),
    ].sort(byTime),
    markPolled(runId, input) {
      db.prepare(`UPDATE etl_run_watches SET last_polled_at = ?,
          remote_status = COALESCE(?, remote_status),
          poll_failures = poll_failures + ?
        WHERE run_id = ? AND status = 'pending'`)
        .run(nowIso(), input.remoteStatus ? clip(input.remoteStatus, 40) : null, input.failed ? 1 : 0, runId);
    },
    finishWatch(runId, outcome) {
      const result = db.prepare(`UPDATE etl_run_watches SET status = 'finished', remote_status = ?, finished_at = ?,
          last_polled_at = ?, outcome_json = ?
        WHERE run_id = ? AND status = 'pending'`)
        .run(clip(outcome.remoteStatus, 40), nowIso(), nowIso(), JSON.stringify({
          ...outcome,
          ...(outcome.error ? { error: clip(outcome.error, 800) } : {}),
          ...(outcome.columns ? { columns: outcome.columns.slice(0, 60).map(column => clip(column, 80)) } : {}),
        }), runId);
      if (result.changes) changed();
    },
    markPrioritized(runId) {
      const result = db.prepare('UPDATE etl_run_watches SET prioritized_at = ? WHERE run_id = ? AND prioritized_at IS NULL').run(nowIso(), runId);
      return result.changes > 0;
    },
    consumeWatch(runId, jobId) {
      const id = String(runId ?? '').trim();
      const result = id.startsWith('run_')
        ? jobId
          ? db.prepare('UPDATE job_dashboard_waits SET consumed_at = ? WHERE run_id = ? AND job_id = ? AND consumed_at IS NULL').run(nowIso(), id, jobId)
          : db.prepare('UPDATE job_dashboard_waits SET consumed_at = ? WHERE run_id = ? AND consumed_at IS NULL').run(nowIso(), id)
        : id.startsWith('w_')
          ? db.prepare('UPDATE job_waits SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL').run(nowIso(), id)
          : db.prepare('UPDATE etl_run_watches SET consumed_at = ? WHERE run_id = ? AND consumed_at IS NULL').run(nowIso(), id);
      if (result.changes) changed();
    },
    unconsumedFinished: (jobId) => [
      ...(db.prepare(`SELECT * FROM etl_run_watches WHERE job_id = ? AND status = 'finished' AND consumed_at IS NULL`).all(jobId) as any[])
        .map(row => rowToWatch(row)!),
      ...(db.prepare(`SELECT * FROM job_dashboard_waits WHERE job_id = ? AND status = 'finished' AND consumed_at IS NULL`).all(jobId) as any[])
        .map(row => rowToDashboardWait(row)!),
      ...(db.prepare(`SELECT * FROM job_waits WHERE job_id = ? AND status = 'finished' AND consumed_at IS NULL`).all(jobId) as any[])
        .map(row => rowToJobWait(row)!),
    ].sort((left, right) => String(left.finishedAt ?? '').localeCompare(String(right.finishedAt ?? '')) || left.runId.localeCompare(right.runId)),
    isJobRun: (jobId, runId) => Boolean(db.prepare('SELECT 1 FROM etl_run_watches WHERE job_id = ? AND run_id = ?')
      .get(jobId, String(runId ?? '').trim())),
    version: () => changeVersion,
  };
}

/** A finished dashboard refresh in words: its status and how many widgets loaded. */
export function describeDashboardRefresh(outcome: EtlRunOutcome | undefined): string {
  if (!outcome) return 'finished';
  const widgets = outcome.widgetCount !== undefined ? `, ${outcome.widgetsSucceeded ?? 0} of ${outcome.widgetCount} widget${outcome.widgetCount === 1 ? '' : 's'} loaded` : '';
  return `${outcome.remoteStatus}${widgets}${outcome.error ? ` — ${outcome.error}` : ''}`;
}

/** Where a wait stands, in a few words: running, its outcome, or no longer watched. */
export function describeOutcome(watch: EtlRunWatch): string {
  const outcome = watch.outcome;
  if (watch.status === 'pending') {
    if (watch.source === 'job_wait') {
      return `waiting${watch.remoteStatus ? ` (${clip(watch.remoteStatus, 120)})` : ''}${watch.kind !== 'time' && watch.deadlineAt ? `; BotBoy gives up at ${watch.deadlineAt}` : ''}`;
    }
    return watch.source === 'dashboard' ? 'running' : `running (${watch.remoteStatus ?? 'submitted'})`;
  }
  if (watch.status === 'abandoned') return 'no longer watched';
  if (watch.source === 'dashboard') return describeDashboardRefresh(outcome);
  if (watch.source === 'job_wait') return describeJobWaitOutcome(outcome);
  if (!outcome) return 'finished';
  if (outcome.remoteStatus === 'SUCCESS' && outcome.savedTo) {
    const rows = outcome.rowCount !== undefined ? `${outcome.rowCount} rows` : 'rows';
    return `SUCCESS — ${rows}${outcome.columns?.length ? `, ${outcome.columns.length} columns` : ''}, saved to ${outcome.savedTo}`;
  }
  return `${outcome.remoteStatus}${outcome.error ? ` — ${outcome.error}` : ''}`;
}

/** Path relative to the files workspace when it is inside it (what run_command sees). */
export function workspaceRelativePath(filePath: string, filesDir: string): string {
  const relative = path.relative(filesDir, filePath);
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? relative : filePath;
}

/**
 * The job block every owner and continuation turn carries: the owner's goal,
 * what the mandate covers, and the working set. Bounded to about 4K chars.
 */
export function formatChatJobBlock(job: ChatJob, watches: EtlRunWatch[], options: { continuation?: boolean } = {}): string {
  const lines: string[] = [
    `## ACTIVE JOB #${job.seq} — ${clip(job.title, MAX_TITLE_CHARS)}`,
    'This conversation is this job\'s own thread: everything in it, and every tool result, belongs to this job only. Other jobs run in their own threads.',
    `The owner asked for this, and BotBoy is working on it: "${clip(job.goal, 1_200)}"`,
    `Started ${job.createdAt}; ${job.continuationCount} automatic continuation(s) since the owner's last message.`,
    ...(job.dataWork ? ['Data work: BotBoy marked this job as data work (dashboards, datasets, warehouse queries or ETL), so the detailed dashboard and Data Room rules in this prompt apply to it.'] : []),
    options.continuation
      ? 'This turn is an AUTOMATIC CONTINUATION: no owner message started it. The owner\'s request above is your authority, so set ownerRequested=true for the job\'s steps. Take them (data reads, SQL, scratch ETL queries and their fixes, Data Room imports, BotBoy dashboards, BotBoy documents: read, edit and save, browser clicks and typing on the tabs you open, Google files and the owner\'s own calendar events: create, edit, upload, download and organize, files, checks). Tools that send, post, publish, share, invite, sync, schedule, or change production return outside_job_mandate here: finish what you can, then call job_update needs_owner with what needs the owner\'s go-ahead.'
      : 'The owner\'s request above authorizes every step of this job, in this turn and later ones: a short "check", "continue", or "go ahead" means resume the job, not ask again. Set ownerRequested=true for job steps. If the owner\'s new message asks for something different, it is a new job: call job_update with action "start".',
  ];
  const set = job.workingSet;
  if (set.nextStep) lines.push(`Next step (your note): ${set.nextStep}`);
  if (set.notes.length) lines.push('Decisions and notes:', ...set.notes.map(note => `- ${note}`));
  if (watches.length) {
    lines.push('What this job waits or waited for (ETL runs, refreshes of its dashboards, exports and other waits; BotBoy continues the job when a pending one ends):');
    for (const watch of watches.slice(-12)) {
      // A job wait shows its own id first: wait_for stop takes it.
      const name = watch.source === 'job_wait' ? `${watch.runId}: ${waitName(watch)}` : `${watch.runId}${watch.purpose ? ` (${clip(watch.purpose, 120)})` : ''}`;
      lines.push(`- ${name}: ${describeOutcome(watch)}`);
    }
  }
  if (set.files.length) lines.push('Files:', ...set.files.slice(-10).map(file => `- ${file.path}${file.label ? ` — ${file.label}` : ''}`));
  if (set.datasets.length) {
    lines.push('Data Room:', ...set.datasets.slice(-8).map(dataset => `- ${[dataset.title, dataset.datasetId, dataset.versionId, dataset.jobId].filter(Boolean).join(' · ')}`));
  }
  if (set.dashboards.length) {
    lines.push('Dashboards:', ...set.dashboards.slice(-8).map(dashboard => `- ${dashboard.dashboardId}${dashboard.title ? ` — ${dashboard.title}` : ''}`));
  }
  if (set.documents.length) {
    lines.push('Documents (newest version of each; edit with edit_product_document):', ...set.documents.slice(-6).map(doc => `- ${doc.artifactId}${doc.title ? ` — ${clip(doc.title, 120)}` : ''}`));
  }
  if (set.drive.length) {
    lines.push('Google Drive files:', ...set.drive.slice(-6).map(file => `- ${file.fileId}${file.name ? ` — ${clip(file.name, 120)}` : ''}`));
  }
  if (set.knowledge.length) {
    lines.push('Knowledge used (load again with knowledge_load if the task needs it):', ...set.knowledge.slice(-8).map(entry => `- ${entry.set}/${entry.file}`));
  }
  if (job.pausedAt && job.pauseNote) lines.push(`Paused for the owner: ${clip(job.pauseNote, 400)}`);
  if (job.inbox.length) {
    // §11 R3/R4: they come from BotBoy's main chat (or its review of the stuck job), never from the owner, unless quoted as theirs.
    lines.push('Messages for this job from BotBoy\'s main chat (act on them now, within this job\'s own permissions):');
    for (const message of job.inbox.slice(-3)) {
      const from = message.from === 'review' ? 'The main chat, after looking at this job' : 'The main chat';
      lines.push(`- ${from}: ${clip(message.text, 700)}${message.ownerWords ? ` (the owner's own words there: "${clip(message.ownerWords, 300)}")` : ''}`);
    }
  }
  if (job.notify) {
    lines.push('WhatsApp updates are ON for this job (the owner asked): BotBoy itself sends a WhatsApp message to the owner when the job needs them, finishes or is stopped, using your closing words as the report. You have no WhatsApp tool here and need none; never say you could not send it. Make the last words of a turn that pauses or finishes the job the short, plain report to read on a phone, answer first.');
  }
  // The closing instruction always survives the bound: whatever the working set holds, the turn still learns how to end.
  const closing = 'Keep the working set current with job_update (next step, decisions). END EVERY TURN of this job with exactly one job_update: "done" when the deliverable is verified (your closing reply then becomes the job\'s report in the owner\'s main chat); "needs_owner" with the question when only the owner can decide or approve the next step; "continue" with the next step when there is more work you can do yourself (BotBoy starts the next turn at once); "wait" when the next step needs something still running. Waiting spends no turn: runs you submit, exports you start with wait:false and refreshes of this job\'s dashboards are watched by themselves, and wait_for waits for anything else that ends on its own (a Data Room job, a file, the terminal, a connection, a time). Never sleep, and never check a status again and again in turns: end the turn and BotBoy continues the job when what it waits for ends, even after "continue". A turn that ends without one is continued once and then paused.';
  return `${lines.join('\n').slice(0, 4_500 - closing.length - 1)}\n${closing}`;
}

/**
 * The job cards the main chat shows (PARALLEL_JOBS_PLAN.md PJ1): a chip when a job starts, a card when one is stuck or done. A
 * card is a marker in a transcript row; the chat panel draws it from the job's live state, so it never goes stale.
 */
/**
 * `update` is the footer of a main-chat row about a job that is not its report: the main chat's decision on a job update, or the
 * job's card when the owner has to act (§12). `stuck` and `done` are the older standalone cards, still drawn for old rows.
 */
export type ChatJobCardKind = 'started' | 'stuck' | 'done' | 'report' | 'update' | 'ended';

export function jobCardMarker(jobId: string, kind: ChatJobCardKind): string {
  return `[[job:${jobId}:${kind}]]`;
}

/** Appends a card for each job not already in the text. */
export function withJobCards(content: string, jobIds: Iterable<string>, kind: ChatJobCardKind): string {
  const missing = [...new Set(jobIds)].map(id => jobCardMarker(id, kind)).filter(marker => !content.includes(marker));
  return missing.length ? `${content.trimEnd()}\n\n${missing.join('\n')}` : content;
}

/** What a job is doing, in the owner's words (lists, the main chat's JOBS block). */
export type ChatJobPhase = 'working' | 'continuing' | 'waiting' | 'provider_wait' | 'needs_owner' | 'stuck' | 'paused';

export function chatJobPhase(job: ChatJob, input: { running: boolean; pendingRuns: number; nowMs?: number }): ChatJobPhase {
  if (input.running) return 'working';
  if (job.continueRequestedAt) {
    return job.rateWaitUntil && Date.parse(job.rateWaitUntil) > (input.nowMs ?? Date.now()) ? 'provider_wait' : 'continuing';
  }
  if (input.pendingRuns) return 'waiting';
  if (job.pausedAt && job.pauseKind === 'question') return 'needs_owner';
  if (job.pausedAt && job.pauseKind === 'stuck') return 'stuck';
  return 'paused';
}

const PHASE_WORDS: Record<ChatJobPhase, string> = {
  working: 'working now',
  continuing: 'about to take its next step',
  waiting: 'waiting for something it started or set (a run, an export, a refresh, a time); BotBoy wakes it when that ends',
  provider_wait: 'waiting for the AI provider (it asked BotBoy to slow down)',
  needs_owner: 'waiting for the owner\'s answer',
  stuck: 'stuck',
  paused: 'paused',
};

/**
 * The main chat's view of the jobs (PARALLEL_JOBS_PLAN.md §4): one line per active job, at most 12, so the front desk knows
 * what is running without reading any job's thread. Undefined when no job is active.
 */
export function formatJobsList(
  jobs: Array<{ job: ChatJob; phase: ChatJobPhase }>,
  options: { modelTitle?: (modelKey?: string) => string | undefined; recent?: ChatJob[] } = {},
): string | undefined {
  // Provisional jobs (no number) belong to the turn that holds them; the owner never sees them.
  const active = jobs.filter(({ job }) => job.seq > 0);
  const recent = (options.recent ?? []).filter(job => job.seq > 0).slice(0, 5);
  if (!active.length && !recent.length) return undefined;
  const shown = active.slice(0, 12);
  const lines = [
    '## JOBS (each runs in its own thread)',
    'Each job below runs on its own, in its own thread. To see what a job did or found, call jobs read; to give it direction or a correction, call jobs message (it acts on it in its own thread, and its reply comes back here). The owner can also start a message with #N to talk to job N. Do not redo a job\'s work in this chat, and never start a new job to answer a question about a job.',
    ...(shown.length ? ['Running:'] : []),
    ...shown.map(({ job, phase }) => {
      const model = options.modelTitle?.(job.modelKey);
      const question = phase === 'needs_owner' || phase === 'stuck' || phase === 'paused' ? (job.pauseNote ? `: "${clip(job.pauseNote, 140)}"` : '') : '';
      return `- #${job.seq} ${clip(job.title, MAX_TITLE_CHARS)} — ${PHASE_WORDS[phase]}${question}${model ? ` (${model})` : ''}`;
    }),
  ];
  if (active.length > shown.length) lines.push(`- … and ${active.length - shown.length} more`);
  if (recent.length) {
    lines.push('Finished recently:', ...recent.map(job => {
      const how = job.status === 'done' ? 'done' : job.status === 'expired' ? 'expired after a day idle' : 'stopped by the owner';
      const summary = job.status === 'done' && job.endReason && job.endReason !== 'done' ? `: ${clip(job.endReason, 160)}` : '';
      return `- #${job.seq} ${clip(job.title, MAX_TITLE_CHARS)} — ${how}${summary}`;
    }));
  }
  return lines.join('\n');
}

function parseJsonObject(text: string): any {
  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' ? value : undefined;
  } catch {
    return undefined;
  }
}

/** The inner payload of an MCP/ETL envelope ({trust, result: "<json>"}), or the value itself. */
function unwrapEnvelope(value: any): any {
  if (value && typeof value.result === 'string') return parseJsonObject(value.result) ?? value;
  return value;
}

/**
 * Records what a finished tool call produced into the job's working set:
 * downloaded and written files, Data Room datasets/jobs, dashboards, BotBoy
 * documents and Google Drive files (the job history's outputs, job-history.md).
 * Defensive: an unrecognized result shape records nothing.
 */
export function recordToolOutcome(store: ChatJobStore, jobId: string, toolName: string, argsJson: string, resultContent: string): void {
  // knowledge_load answers with the fenced file as plain text, so its outcome is read from the fence's opening tag.
  if (toolName === 'knowledge_load') {
    const fence = /^<external_untrusted_knowledge set="([^"]*)" file="([^"]*)" sha256="([a-f0-9]{64})" /.exec(resultContent);
    if (fence) {
      const plain = (value: string) => value.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
      store.recordKnowledge(jobId, { set: plain(fence[1]), file: plain(fence[2]), sha256: fence[3] });
    }
    return;
  }
  const result = unwrapEnvelope(parseJsonObject(resultContent));
  if (!result) return;
  const args = parseJsonObject(argsJson) ?? {};
  if ((toolName === 'mcp_etl_download_results' || toolName === 'mcp_etl_run_query' || toolName === 'wait_for_etl_run')
    && typeof result.savedTo === 'string') {
    store.recordFile(jobId, result.savedTo, result.runId ? `ETL run ${result.runId}` : undefined);
    return;
  }
  // A data wait that ended in this turn with its result file (an export, an ETL run's download) keeps that file. A file wait's
  // path is the model's own already.
  if (toolName === 'wait_for' && typeof result.savedTo === 'string' && (result.kind === 'sql_export' || result.kind === 'etl_run')) {
    store.recordFile(jobId, result.savedTo, typeof result.what === 'string' ? result.what : undefined);
    return;
  }
  if (toolName === 'create_data_room_dataset' && args.action !== 'inspect_local_file' && args.action !== 'derive_semantic_hashes') {
    const datasetId = typeof result.datasetId === 'string' ? result.datasetId
      : typeof result.dataset?.id === 'string' ? result.dataset.id
        : typeof result.result?.datasetId === 'string' ? result.result.datasetId : undefined;
    const versionId = typeof result.versionId === 'string' ? result.versionId
      : typeof result.version?.id === 'string' ? result.version.id
        : typeof result.result?.versionId === 'string' ? result.result.versionId : undefined;
    const analyticsJobId = typeof result.jobId === 'string' && /^aj_[a-f0-9]{32}$/.test(result.jobId) ? result.jobId : undefined;
    const title = typeof result.dataset?.title === 'string' ? result.dataset.title : undefined;
    if (datasetId || analyticsJobId) store.recordDataset(jobId, { datasetId, versionId, jobId: analyticsJobId, title });
    return;
  }
  // A file the job wrote or edited in the files workspace is its output (write_file is called once per chunk: one entry).
  if ((toolName === 'write_file' || toolName === 'edit_file') && typeof result.path === 'string') {
    store.recordFile(jobId, result.path, undefined, { dataWork: false });
    return;
  }
  // A saved document version; an edit's new version replaces its parent in the list.
  if ((toolName === 'save_product_document' || toolName === 'edit_product_document')
    && result.persisted === true && typeof result.artifactId === 'string') {
    store.recordDocument(jobId, {
      artifactId: result.artifactId,
      ...(typeof result.parentArtifactId === 'string' ? { parentArtifactId: result.parentArtifactId } : {}),
      ...(typeof result.title === 'string' ? { title: result.title } : {}),
    });
    return;
  }
  // A Drive file the job made (created, uploaded or copied); renames, moves and trash change no output list.
  if (toolName === 'gdrive_files' && result.ok === true && ['created', 'uploaded', 'copied'].includes(result.status)
    && typeof result.fileId === 'string') {
    store.recordDriveFile(jobId, {
      fileId: result.fileId,
      ...(typeof result.name === 'string' ? { name: result.name } : {}),
      ...(typeof result.kind === 'string' ? { kind: result.kind } : {}),
      ...(typeof result.webViewLink === 'string' ? { url: result.webViewLink } : {}),
    });
    return;
  }
  // Every dashboard the job changes or refreshes is the job's: the job waits for its refreshes (§12 R1).
  if (toolName === 'create_analytics_dashboard' || toolName === 'update_analytics_dashboard' || toolName === 'edit_analytics_dashboard'
    || toolName === 'configure_analytics_widget_source' || toolName === 'refresh_analytics_dashboard') {
    const dashboard = result.dashboard && typeof result.dashboard === 'object' ? result.dashboard : result;
    const dashboardId = typeof dashboard.id === 'string' && dashboard.id.startsWith('dash_') ? dashboard.id
      : typeof args.dashboardId === 'string' && args.dashboardId.startsWith('dash_') && result.ok !== false ? args.dashboardId : undefined;
    if (dashboardId) store.recordDashboard(jobId, { dashboardId, title: typeof dashboard.title === 'string' ? dashboard.title : undefined });
  }
}
