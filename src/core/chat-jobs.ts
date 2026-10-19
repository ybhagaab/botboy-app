/**
 * Chat jobs: the owner's request that BotBoy is working on, and the ETL runs
 * it is waiting for (ANALYTICS_AUTONOMY_PLAN.md, owner decisions D1/D2,
 * 2026-10-08).
 *
 * A job is the authority for continuation turns: the owner asked once, and
 * BotBoy keeps taking the job's steps (including after an ETL run finishes
 * when no turn is open) until the job is done, blocked, stopped, or idle for
 * 24 hours. One job is active at a time; the chat has one conversation.
 *
 * The store is plain SQL over the tracker database, so every instance on one
 * database sees the same state. It never decides what a step may do; the
 * mandate gate (job-mandate.ts) does.
 */
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import type Database from 'better-sqlite3';

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
/** Automatic continuations in a row (since the owner's last message) before BotBoy pauses and asks. */
export const CHAT_JOB_MAX_CONTINUATIONS = 25;

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
}

/** What a turn said should happen next (job_update continue | needs_owner). */
export type ChatJobDeclaration = 'continue' | 'needs_owner';

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
  goal: string;
  status: ChatJobStatus;
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
  | 'disconnected';

export type ChatTurnSettlement =
  | { action: 'none' }
  | { action: 'continue'; reason: string; undeclared?: true }
  | { action: 'pause'; note: string }
  | { action: 'wait' };

/**
 * The end-of-turn decision (owner directive 2026-10-08): a job never sits
 * "working" with nothing running. It ends done (job_update done), waits on
 * watched runs, continues on its own, or pauses for the owner.
 */
export function decideTurnSettlement(input: {
  end: ChatTurnEnd;
  /** This turn's own declaration (made after the turn started). */
  declaration?: ChatJobDeclaration;
  declarationNote?: string;
  pendingRuns: number;
  undeclaredEnds: number;
  failedTurns: number;
  /** The reply's last words, used as the pause note when nothing was declared. */
  replyExcerpt?: string;
}): ChatTurnSettlement {
  switch (input.end) {
    case 'preempted':
    case 'job_stopped':
      return { action: 'none' };
    case 'owner_stopped':
      return { action: 'pause', note: 'You stopped the turn. Reply to continue.' };
    case 'provider_changed':
      return { action: 'pause', note: 'The AI model changed in Settings. Reply to continue.' };
    case 'disconnected':
      return input.pendingRuns ? { action: 'wait' } : { action: 'pause', note: 'The chat closed mid-turn. Reply to continue.' };
    case 'shutdown':
      return { action: 'continue', reason: 'BotBoy restarted in the middle of the previous turn.' };
    case 'ceiling':
      return { action: 'continue', reason: 'The previous turn reached the per-turn tool limit before the job was finished.' };
    case 'repeat_breaker':
      return { action: 'pause', note: 'I was repeating the same step, so I stopped. Reply with how to proceed.' };
    case 'failed':
      return input.failedTurns < 1
        ? { action: 'continue', reason: 'The previous turn failed before it could finish.' }
        : { action: 'pause', note: 'Two turns in a row failed. Reply to try again.' };
    case 'answered':
    default:
      if (input.declaration === 'needs_owner') return { action: 'pause', note: input.declarationNote || 'BotBoy needs your input.' };
      if (input.declaration === 'continue') return { action: 'continue', reason: input.declarationNote || 'The previous turn said the job continues.' };
      if (input.pendingRuns) return { action: 'wait' };
      if (input.undeclaredEnds < 1) {
        return { action: 'continue', reason: 'The previous turn ended without saying whether the job is done, needs the owner, or continues.', undeclared: true };
      }
      return { action: 'pause', note: input.replyExcerpt || 'BotBoy stopped without finishing. Reply to continue.' };
  }
}

/** What a finished run produced, as the continuation turn reports it. */
export interface EtlRunOutcome {
  remoteStatus: string;
  savedTo?: string;
  rowCount?: number;
  columns?: string[];
  truncated?: boolean;
  resultBytes?: number;
  error?: string;
}

export interface EtlRunWatch {
  runId: string;
  jobId: string;
  purpose?: string;
  source: 'run_query' | 'wait';
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

export interface ChatJobStore {
  activeJob(): ChatJob | null;
  /** The most recently ended job (for the strip's Done / Ended line). */
  lastEnded(): ChatJob | null;
  get(jobId: string): ChatJob | null;
  /** Starts a job; an active one ends as done (replaced). */
  start(input: { goal: string; modelKey?: string; thinking?: ChatJobThinking }): ChatJob;
  /** The active job, or a new one for this goal. */
  ensureActive(input: { goal: string; modelKey?: string; thinking?: ChatJobThinking }): ChatJob;
  /** Records activity; an owner turn also records its model and thinking (D4). */
  touch(jobId: string, input?: { modelKey?: string; thinking?: ChatJobThinking }): void;
  update(jobId: string, input: { goal?: string; nextStep?: string; notes?: string[] }): ChatJob | null;
  end(jobId: string, status: Exclude<ChatJobStatus, 'active'>, reason: string): ChatJob | null;
  incrementContinuations(jobId: string): number;
  /** A turn's job_update continue / needs_owner. */
  declare(jobId: string, declaration: ChatJobDeclaration, note?: string): ChatJob | null;
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
  recordFile(jobId: string, filePath: string, label?: string): void;
  recordDataset(jobId: string, entry: { datasetId?: string; versionId?: string; jobId?: string; title?: string }): void;
  recordDashboard(jobId: string, entry: { dashboardId: string; title?: string }): void;
  recordKnowledge(jobId: string, entry: { set: string; file: string; sha256: string }): void;
  addWatch(input: { runId: string; jobId: string; purpose?: string; source: EtlRunWatch['source'] }): EtlRunWatch;
  watch(runId: string): EtlRunWatch | null;
  watchesForJob(jobId: string): EtlRunWatch[];
  pendingWatches(): EtlRunWatch[];
  markPolled(runId: string, input: { remoteStatus?: string; failed?: boolean }): void;
  finishWatch(runId: string, outcome: EtlRunOutcome): void;
  /** Records the run's one queue rescue; false when it already ran. */
  markPrioritized(runId: string): boolean;
  /** A turn (owner or continuation) has seen this run's outcome. */
  consumeWatch(runId: string): void;
  unconsumedFinished(jobId: string): EtlRunWatch[];
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
  return { notes: [], files: [], datasets: [], dashboards: [], knowledge: [] };
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
  `);
  // Stores created by the first build of this table (2026-10-08) lack the column.
  const watchColumns = (db.prepare('PRAGMA table_info(etl_run_watches)').all() as Array<{ name: string }>).map(column => column.name);
  if (!watchColumns.includes('prioritized_at')) db.exec('ALTER TABLE etl_run_watches ADD COLUMN prioritized_at TEXT');
  // Turn settlement columns (2026-10-08, second build) join existing tables.
  const jobColumns = new Set((db.prepare('PRAGMA table_info(chat_jobs)').all() as Array<{ name: string }>).map(column => column.name));
  for (const [name, type] of [
    ['declaration', 'TEXT'], ['declared_at', 'TEXT'], ['paused_at', 'TEXT'], ['pause_note', 'TEXT'],
    ['continue_requested_at', 'TEXT'], ['continue_reason', 'TEXT'],
    ['undeclared_ends', 'INTEGER NOT NULL DEFAULT 0'], ['failed_turns', 'INTEGER NOT NULL DEFAULT 0'],
    // WhatsApp updates for a job (2026-10-19, job-notify.md): the owner's request and what BotBoy has already sent.
    ['notify_json', 'TEXT'], ['last_reply', 'TEXT'], ['last_reply_at', 'TEXT'],
  ] as const) {
    if (!jobColumns.has(name)) db.exec(`ALTER TABLE chat_jobs ADD COLUMN ${name} ${type}`);
  }

  let changeVersion = 0;
  const changed = () => { changeVersion += 1; };

  const selectActive = db.prepare("SELECT * FROM chat_jobs WHERE status = 'active' ORDER BY last_activity_at DESC LIMIT 1");
  const selectJob = db.prepare('SELECT * FROM chat_jobs WHERE id = ?');
  const insertJob = db.prepare(`INSERT INTO chat_jobs (id, goal, status, model_key, thinking, working_set_json, created_at, last_activity_at)
    VALUES (?, ?, 'active', ?, ?, '{}', ?, ?)`);
  const selectWatch = db.prepare('SELECT * FROM etl_run_watches WHERE run_id = ?');

  function rowToJob(row: any): ChatJob | null {
    if (!row) return null;
    const notify = parseNotify(row.notify_json);
    return {
      id: row.id,
      goal: row.goal,
      status: row.status,
      ...(row.model_key ? { modelKey: row.model_key } : {}),
      thinking: thinkingOf(row.thinking),
      workingSet: parseWorkingSet(row.working_set_json),
      continuationCount: Number(row.continuation_count) || 0,
      createdAt: row.created_at,
      lastActivityAt: row.last_activity_at,
      ...(row.ended_at ? { endedAt: row.ended_at } : {}),
      ...(row.end_reason ? { endReason: row.end_reason } : {}),
      ...(row.declaration === 'continue' || row.declaration === 'needs_owner' ? { declaration: row.declaration } : {}),
      ...(row.declared_at ? { declaredAt: row.declared_at } : {}),
      ...(row.paused_at ? { pausedAt: row.paused_at } : {}),
      ...(row.pause_note ? { pauseNote: row.pause_note } : {}),
      ...(row.continue_requested_at ? { continueRequestedAt: row.continue_requested_at } : {}),
      ...(row.continue_reason ? { continueReason: row.continue_reason } : {}),
      undeclaredEnds: Number(row.undeclared_ends) || 0,
      failedTurns: Number(row.failed_turns) || 0,
      ...(notify ? { notify } : {}),
      ...(row.last_reply ? { lastReply: String(row.last_reply) } : {}),
      ...(row.last_reply_at ? { lastReplyAt: String(row.last_reply_at) } : {}),
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

  function abandonWatches(jobId: string): void {
    db.prepare("UPDATE etl_run_watches SET status = 'abandoned' WHERE job_id = ? AND status = 'pending'").run(jobId);
  }

  function endJob(jobId: string, status: Exclude<ChatJobStatus, 'active'>, reason: string): ChatJob | null {
    const ended = db.transaction(() => {
      // The report kept before the end is dropped with it: a "finished" message carries only words written AFTER the job ended (the
      // closing report follows `job_update done` in the same turn), never an older progress note (job-notify.md).
      const result = db.prepare(`UPDATE chat_jobs SET status = ?, ended_at = ?, end_reason = ?, last_reply = NULL, last_reply_at = NULL
        WHERE id = ? AND status = 'active'`).run(status, nowIso(), clip(reason, 200), jobId);
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

  function start(input: { goal: string; modelKey?: string; thinking?: ChatJobThinking }): ChatJob {
    const goal = String(input.goal ?? '').trim().slice(0, MAX_GOAL_CHARS) || 'Owner request';
    const id = `cj_${randomBytes(12).toString('hex')}`;
    const at = nowIso();
    db.transaction(() => {
      const current = selectActive.get() as any;
      if (current) {
        db.prepare(`UPDATE chat_jobs SET status = 'done', ended_at = ?, end_reason = ?
          WHERE id = ?`).run(at, CHAT_JOB_REPLACED_REASON, current.id);
        abandonWatches(current.id);
      }
      insertJob.run(id, goal, input.modelKey ?? null, thinkingOf(input.thinking), at, at);
    })();
    changed();
    return rowToJob(selectJob.get(id))!;
  }

  return {
    activeJob: () => rowToJob(selectActive.get()),
    lastEnded: () => rowToJob(db.prepare("SELECT * FROM chat_jobs WHERE status != 'active' AND ended_at IS NOT NULL ORDER BY ended_at DESC LIMIT 1").get()),
    get: (jobId) => rowToJob(selectJob.get(jobId)),
    start,
    ensureActive(input) {
      return rowToJob(selectActive.get()) ?? start(input);
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
    incrementContinuations(jobId) {
      db.prepare('UPDATE chat_jobs SET continuation_count = continuation_count + 1, last_activity_at = ? WHERE id = ?')
        .run(nowIso(), jobId);
      changed();
      return Number((selectJob.get(jobId) as any)?.continuation_count) || 0;
    },
    declare(jobId, declaration, note) {
      const result = db.prepare(`UPDATE chat_jobs SET declaration = ?, declared_at = ?, last_activity_at = ?
        WHERE id = ? AND status = 'active'`).run(declaration, nowIso(), nowIso(), jobId);
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
        db.prepare(`UPDATE chat_jobs SET failed_turns = ${failed}, undeclared_ends = ${undeclared},
            declaration = NULL, declared_at = NULL, last_activity_at = ? WHERE id = ? AND status = 'active'`).run(at, jobId);
        if (settlement.action === 'continue') {
          db.prepare(`UPDATE chat_jobs SET continue_requested_at = ?, continue_reason = ?, paused_at = NULL, pause_note = NULL
            WHERE id = ? AND status = 'active'`).run(at, clip(settlement.reason, 600), jobId);
        } else if (settlement.action === 'pause') {
          db.prepare(`UPDATE chat_jobs SET paused_at = ?, pause_note = ?, continue_requested_at = NULL, continue_reason = NULL
            WHERE id = ? AND status = 'active'`).run(at, clip(settlement.note, 600), jobId);
        } else if (settlement.action === 'wait') {
          db.prepare(`UPDATE chat_jobs SET paused_at = NULL, pause_note = NULL, continue_requested_at = NULL, continue_reason = NULL
            WHERE id = ? AND status = 'active'`).run(jobId);
        }
      })();
      changed();
      return rowToJob(selectJob.get(jobId));
    },
    ownerResumed(jobId) {
      const result = db.prepare(`UPDATE chat_jobs SET paused_at = NULL, pause_note = NULL, continue_requested_at = NULL,
          continue_reason = NULL, declaration = NULL, declared_at = NULL, undeclared_ends = 0, failed_turns = 0,
          continuation_count = 0
        WHERE id = ? AND status = 'active'`).run(jobId);
      if (result.changes) changed();
    },
    wake(jobId, reason) {
      const at = nowIso();
      const result = db.prepare(`UPDATE chat_jobs SET continue_requested_at = ?, continue_reason = ?, paused_at = NULL, pause_note = NULL,
          declaration = NULL, declared_at = NULL, last_activity_at = ?
        WHERE id = ? AND status = 'active' AND paused_at IS NOT NULL AND continue_requested_at IS NULL`).run(at, clip(reason, 600), at, jobId);
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
    recordFile(jobId, filePath, label) {
      const clean = clip(filePath, 1_000);
      if (!clean) return;
      mutateWorkingSet(jobId, (set) => {
        set.files = set.files.filter(file => file.path !== clean);
        set.files.push({ path: clean, ...(label ? { label: clip(label, 160) } : {}), at: nowIso() });
        if (set.files.length > MAX_LIST) set.files = set.files.slice(-MAX_LIST);
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
      changed();
      return rowToWatch(selectWatch.get(runId))!;
    },
    watch: (runId) => rowToWatch(selectWatch.get(String(runId ?? '').trim())),
    watchesForJob: (jobId) => (db.prepare('SELECT * FROM etl_run_watches WHERE job_id = ? ORDER BY submitted_at, run_id').all(jobId) as any[])
      .map(row => rowToWatch(row)!),
    pendingWatches: () => (db.prepare(`SELECT w.* FROM etl_run_watches w JOIN chat_jobs j ON j.id = w.job_id
      WHERE w.status = 'pending' AND j.status = 'active' ORDER BY w.submitted_at, w.run_id`).all() as any[])
      .map(row => rowToWatch(row)!),
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
    consumeWatch(runId) {
      const result = db.prepare('UPDATE etl_run_watches SET consumed_at = ? WHERE run_id = ? AND consumed_at IS NULL').run(nowIso(), runId);
      if (result.changes) changed();
    },
    unconsumedFinished: (jobId) => (db.prepare(`SELECT * FROM etl_run_watches
      WHERE job_id = ? AND status = 'finished' AND consumed_at IS NULL ORDER BY finished_at, run_id`).all(jobId) as any[])
      .map(row => rowToWatch(row)!),
    isJobRun: (jobId, runId) => Boolean(db.prepare('SELECT 1 FROM etl_run_watches WHERE job_id = ? AND run_id = ?')
      .get(jobId, String(runId ?? '').trim())),
    version: () => changeVersion,
  };
}

function describeOutcome(watch: EtlRunWatch): string {
  const outcome = watch.outcome;
  if (watch.status === 'pending') return `running (${watch.remoteStatus ?? 'submitted'})`;
  if (watch.status === 'abandoned') return 'no longer watched';
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
    '## ACTIVE JOB',
    `The owner asked for this, and BotBoy is working on it: "${clip(job.goal, 1_200)}"`,
    `Started ${job.createdAt}; ${job.continuationCount} automatic continuation(s) since the owner's last message.`,
    options.continuation
      ? 'This turn is an AUTOMATIC CONTINUATION: no owner message started it. The owner\'s request above is your authority, so set ownerRequested=true for the job\'s steps. Take them (data reads, SQL, scratch ETL queries and their fixes, Data Room imports, BotBoy dashboards, files, checks). Tools that send, post, publish, sync, schedule, or change production return outside_job_mandate here: finish what you can, then call job_update needs_owner with what needs the owner\'s go-ahead.'
      : 'The owner\'s request above authorizes every step of this job, in this turn and later ones: a short "check", "continue", or "go ahead" means resume the job, not ask again. Set ownerRequested=true for job steps. If the owner\'s new message asks for something different, it is a new job: call job_update with action "start".',
  ];
  const set = job.workingSet;
  if (set.nextStep) lines.push(`Next step (your note): ${set.nextStep}`);
  if (set.notes.length) lines.push('Decisions and notes:', ...set.notes.map(note => `- ${note}`));
  if (watches.length) {
    lines.push('ETL runs in this job:');
    for (const watch of watches.slice(-12)) {
      lines.push(`- ${watch.runId}${watch.purpose ? ` (${clip(watch.purpose, 120)})` : ''}: ${describeOutcome(watch)}`);
    }
  }
  if (set.files.length) lines.push('Files:', ...set.files.slice(-10).map(file => `- ${file.path}${file.label ? ` — ${file.label}` : ''}`));
  if (set.datasets.length) {
    lines.push('Data Room:', ...set.datasets.slice(-8).map(dataset => `- ${[dataset.title, dataset.datasetId, dataset.versionId, dataset.jobId].filter(Boolean).join(' · ')}`));
  }
  if (set.dashboards.length) {
    lines.push('Dashboards:', ...set.dashboards.slice(-8).map(dashboard => `- ${dashboard.dashboardId}${dashboard.title ? ` — ${dashboard.title}` : ''}`));
  }
  if (set.knowledge.length) {
    lines.push('Knowledge used (load again with knowledge_load if the task needs it):', ...set.knowledge.slice(-8).map(entry => `- ${entry.set}/${entry.file}`));
  }
  if (job.pausedAt && job.pauseNote) lines.push(`Paused for the owner: ${clip(job.pauseNote, 400)}`);
  if (job.notify) {
    lines.push('WhatsApp updates are ON for this job (the owner asked): BotBoy itself sends a WhatsApp message to the owner when the job needs them, finishes or is stopped, using your closing words as the report. You have no WhatsApp tool here and need none; never say you could not send it. Make the last words of a turn that pauses or finishes the job the short, plain report to read on a phone, answer first.');
  }
  lines.push('Keep the working set current with job_update (next step, decisions). END EVERY TURN of this job with exactly one job_update: "done" when the deliverable is verified; "needs_owner" with the question when only the owner can decide or approve the next step; "continue" with the next step when there is more work you can do yourself (BotBoy starts the next turn at once). Waiting on watched ETL runs needs no call. A turn that ends without one is continued once and then paused.');
  return lines.join('\n').slice(0, 4_500);
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
 * downloaded files, Data Room datasets/jobs, and dashboards. Defensive: an
 * unrecognized result shape records nothing.
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
  if (toolName === 'create_analytics_dashboard' || toolName === 'update_analytics_dashboard' || toolName === 'edit_analytics_dashboard') {
    const dashboard = result.dashboard && typeof result.dashboard === 'object' ? result.dashboard : result;
    const dashboardId = typeof dashboard.id === 'string' && dashboard.id.startsWith('dash_') ? dashboard.id
      : typeof args.dashboardId === 'string' && args.dashboardId.startsWith('dash_') && result.ok !== false ? args.dashboardId : undefined;
    if (dashboardId) store.recordDashboard(jobId, { dashboardId, title: typeof dashboard.title === 'string' ? dashboard.title : undefined });
  }
}
