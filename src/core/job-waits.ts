/**
 * General waits for jobs (docs/maps/job-waits.md). Owner request 2026-11-12: "the ability to wait for things, sql or anything
 * else, should be something which botboy should have and be able to use as general purpose capability".
 *
 * The incident behind it: job #5 started a background SQL export, then spent 25 automatic turns asking for its status (196 tool
 * calls, about 25M prompt tokens) until BotBoy's turn limit paused it; the export later failed on a DNS error and nothing told the
 * job.
 *
 * A wait is something that ends on its own: a background SQL export, a Data Room job, the chat terminal's session, a file landing
 * in the files workspace, a connection answering again, or a time. The job registers it (wait_for; BotBoy registers an export a
 * job starts in the background, and a Data Room job still running, by itself) and ends its turn. BotBoy checks every wait every
 * 30 seconds without a model turn (etl-run-watcher.ts), and the job continues when the wait ends or reaches its deadline, with
 * what it produced (chat-continuations.ts). ETL runs and dashboard refreshes keep their own watches (chat-jobs.ts); wait_for
 * reaches ETL runs too.
 *
 * Checks only read: an export's status, the terminal session, a file's size, a connection's health, a Data Room job's row, the
 * clock. Nothing here starts, stops or changes what it waits for.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { EtlRunOutcome, EtlRunWatch } from './chat-jobs.js';
import type { McpServerSnapshot } from './mcp-types.js';
import type { McpTerminalSessionSnapshot } from './mcp-terminal.js';
import { isUnknownExport, parseSqlExportStatus, type SqlExportStatus } from './query-ledger.js';

export type JobWaitKind = 'sql_export' | 'data_room_job' | 'terminal' | 'file' | 'connection' | 'time';
export const JOB_WAIT_KINDS: readonly JobWaitKind[] = ['sql_export', 'data_room_job', 'terminal', 'file', 'connection', 'time'];
export function isJobWaitKind(value: unknown): value is JobWaitKind {
  return typeof value === 'string' && (JOB_WAIT_KINDS as readonly string[]).includes(value);
}

/** A job idle for 24 hours expires (chat-jobs.ts › CHAT_JOB_IDLE_MS): every wait ends before that. */
export const JOB_WAIT_MAX_HOURS = 23;
/** How long BotBoy waits by default before it gives up and continues the job with what it last saw. */
export const JOB_WAIT_DEFAULT_HOURS: Readonly<Record<Exclude<JobWaitKind, 'time'>, number>> = {
  sql_export: 8,
  data_room_job: 8,
  terminal: 8,
  file: 2,
  connection: 6,
};
/** How often a kind is checked, when slower than the watcher's 30 s tick: a connection check asks the network. */
export const JOB_WAIT_CHECK_EVERY_MS: Readonly<Partial<Record<JobWaitKind, number>>> = { connection: 120_000 };
/** A file has landed when it holds bytes and has not changed for this long. */
export const FILE_SETTLED_MS = 20_000;
/** How much of a terminal session's output the job sees when the wait ends (it is data, never instructions). */
const TERMINAL_TAIL_CHARS = 800;

const EXPORT_ID = /^e_[a-z2-7]{16}$/;
const DATA_ROOM_JOB_ID = /^aj_[a-f0-9]{32}$/;
const CONNECTION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const TERMINAL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const clip = (value: unknown, max: number): string => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max).trim();
const count = (value: unknown): string => (Number.isFinite(Number(value)) ? Number(value).toLocaleString('en-US') : '?');

function size(bytes: unknown): string {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value < 0) return 'unknown size';
  if (value < 1024) return `${value} bytes`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let scaled = value / 1024;
  let unit = 0;
  while (scaled >= 1024 && unit < units.length - 1) { scaled /= 1024; unit += 1; }
  return `${scaled >= 100 ? Math.round(scaled) : scaled.toFixed(1)} ${units[unit]}`;
}

function minutesText(ms: number): string {
  const total = Math.max(1, Math.round(ms / 60_000));
  if (total < 60) return `${total} min`;
  const hours = Math.floor(total / 60);
  const rest = total % 60;
  return rest ? `${hours} h ${rest} min` : `${hours} h`;
}

/** An MCP snapshot's SQLite time ("YYYY-MM-DD HH:MM:SS", UTC) or ISO time, in ms. */
function timestampMs(value: string | undefined): number {
  if (!value) return Number.NaN;
  return Date.parse(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value) ? `${value.replace(' ', 'T')}Z` : value);
}

/** The thing a wait waits for, in a few words: "SQL export e_…", "the file downloads/a.csv", "the sql-context connection". */
export function jobWaitTargetName(kind: JobWaitKind, target: string): string {
  switch (kind) {
    case 'sql_export': return `SQL export ${target}`;
    case 'data_room_job': return `Data Room job ${target}`;
    case 'terminal': return `terminal session ${target}`;
    case 'file': return `the file ${target}`;
    case 'connection': return `the ${target} connection`;
    case 'time': return `the time ${target}`;
  }
}

// ── The request (wait_for) ──

export interface JobWaitInput {
  kind?: unknown;
  id?: unknown;
  until?: unknown;
  minutes?: unknown;
  untilOutput?: unknown;
  label?: unknown;
  timeoutHours?: unknown;
}

export interface JobWaitRequest {
  kind: JobWaitKind;
  /** An export id, a Data Room job id, a terminal session id, a path in the files workspace, a connection id, or an ISO time. */
  target: string;
  label?: string;
  /** terminal: the wait also ends when the session's output shows this text. */
  untilOutput?: string;
  deadlineAt: string;
}

export interface JobWaitRefusal {
  ok: false;
  code: string;
  error: string;
  nextAction: string;
}

const refuse = (code: string, error: string, nextAction: string): JobWaitRefusal => ({ ok: false, code, error, nextAction });

/**
 * A path in the files workspace, as the wait stores it (relative, forward slashes), or null when it points outside it. The file
 * may not exist yet.
 */
export function filesWorkspacePath(input: string, filesDir: string): string | null {
  const raw = String(input ?? '').trim();
  if (!raw || raw.includes('\0')) return null;
  const root = path.resolve(filesDir);
  const resolved = path.resolve(root, raw.startsWith('~/') ? path.join(process.env.HOME ?? '', raw.slice(2)) : raw);
  const relative = path.relative(root, resolved);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return null;
  return relative.split(path.sep).join('/');
}

/** Checks and normalizes one wait_for request. Pure apart from the clock and paths passed in. */
export function parseJobWaitRequest(
  input: JobWaitInput,
  env: { nowMs: number; filesDir: string; latestTerminalId?: string | null },
): { ok: true; request: JobWaitRequest } | JobWaitRefusal {
  const kind = String(input.kind ?? '').trim();
  if (!isJobWaitKind(kind)) {
    return refuse('bad_kind', `kind must be one of ${[...JOB_WAIT_KINDS, 'etl_run'].join(', ')}.`, 'Call wait_for again with one of them.');
  }
  const id = String(input.id ?? '').trim();
  const label = clip(input.label, 160) || undefined;
  const hoursIn = input.timeoutHours === undefined || input.timeoutHours === null || input.timeoutHours === '' ? NaN : Number(input.timeoutHours);
  let target = '';
  let untilOutput: string | undefined;
  switch (kind) {
    case 'sql_export':
      if (!EXPORT_ID.test(id)) return refuse('bad_id', 'id must be the exportId export_query returned (e_ and 16 letters or digits).', 'Call wait_for again with the exportId.');
      target = id;
      break;
    case 'data_room_job':
      if (!DATA_ROOM_JOB_ID.test(id)) return refuse('bad_id', 'id must be the Data Room job id (aj_ and 32 hex characters).', 'Call wait_for again with the jobId create_data_room_dataset returned.');
      target = id;
      break;
    case 'terminal': {
      const session = id || env.latestTerminalId || '';
      if (!session) return refuse('no_terminal', 'There is no chat terminal session to wait for.', 'Open the terminal first (open_terminal, in an owner turn), or wait for something else.');
      if (!TERMINAL_ID.test(session)) return refuse('bad_id', 'id must be a terminal session id; leave it out for the latest session.', 'Call wait_for again without id.');
      target = session.toLowerCase();
      const text = String(input.untilOutput ?? '').trim();
      if (text) untilOutput = text.slice(0, 200);
      break;
    }
    case 'file': {
      const relative = filesWorkspacePath(id, env.filesDir);
      if (!relative) {
        return refuse('outside_files', 'id must be a file path inside the files workspace (where run_command starts), for example downloads/report.csv.', 'Call wait_for again with a path in the files workspace.');
      }
      target = relative;
      break;
    }
    case 'connection':
      if (!CONNECTION_ID.test(id)) return refuse('bad_id', 'id must be a connection id, as mcp_status lists it (for example sql-context).', 'Call wait_for again with the connection id.');
      target = id;
      break;
    case 'time': {
      const latest = env.nowMs + JOB_WAIT_MAX_HOURS * 3_600_000;
      let at = Number.NaN;
      if (input.minutes !== undefined && input.minutes !== null && input.minutes !== '') {
        const minutes = Number(input.minutes);
        if (!Number.isFinite(minutes) || minutes < 1) return refuse('bad_time', 'minutes must be at least 1.', 'Call wait_for again with minutes (1 or more) or until.');
        at = env.nowMs + Math.round(minutes * 60_000);
      } else {
        const until = String(input.until ?? '').trim();
        if (!until) return refuse('bad_time', 'A time wait needs minutes (from now) or until (an ISO time).', 'Call wait_for again with minutes or until.');
        // A time without its zone is ambiguous (the owner's clock, or UTC?): BotBoy asks for one rather than guess.
        if (!/(?:Z|[+-]\d{2}:?\d{2})$/i.test(until)) {
          return refuse('bad_time', 'until needs its timezone, for example 2026-11-13T09:00:00+08:00 or 2026-11-13T01:00:00Z.', 'Call wait_for again with the timezone in until, or with minutes.');
        }
        at = Date.parse(until);
        if (!Number.isFinite(at)) return refuse('bad_time', `until is not a time: ${clip(until, 60)}.`, 'Call wait_for again with an ISO time, for example 2026-11-13T09:00:00+08:00.');
      }
      if (at <= env.nowMs) return refuse('bad_time', 'That time has already passed.', 'Carry on now, or wait for a later time.');
      if (at > latest + 60_000) {
        return refuse('too_far', `BotBoy waits at most ${JOB_WAIT_MAX_HOURS} hours (a job idle for a day ends).`, `Wait for a time within ${JOB_WAIT_MAX_HOURS} hours; for later, ask the owner to pick it up then.`);
      }
      target = new Date(Math.min(at, latest)).toISOString();
      return { ok: true, request: { kind, target, ...(label ? { label } : {}), deadlineAt: target } };
    }
  }
  if (Number.isFinite(hoursIn) && hoursIn <= 0) return refuse('bad_timeout', 'timeoutHours must be more than 0.', 'Call wait_for again without timeoutHours, or with a positive number.');
  const hours = Math.min(JOB_WAIT_MAX_HOURS, Number.isFinite(hoursIn) ? hoursIn : JOB_WAIT_DEFAULT_HOURS[kind]);
  return {
    ok: true,
    request: {
      kind,
      target,
      ...(label ? { label } : {}),
      ...(untilOutput ? { untilOutput } : {}),
      deadlineAt: new Date(env.nowMs + Math.round(hours * 3_600_000)).toISOString(),
    },
  };
}

// ── Outcomes ──

/** What one ended wait produced, in a line: its status, what it made, and what failed. */
export function describeJobWaitOutcome(outcome: EtlRunOutcome | undefined, filesDir?: string): string {
  if (!outcome) return 'ended';
  const where = outcome.savedTo ? (filesDir ? (filesWorkspacePath(outcome.savedTo, filesDir) ?? outcome.savedTo) : outcome.savedTo) : '';
  return [
    outcome.remoteStatus,
    outcome.summary ? ` — ${outcome.summary}` : '',
    where ? `, saved to ${where}` : '',
    outcome.error ? ` — ${outcome.error}` : '',
  ].join('');
}

/** What the next turn should do about a wait that did not end well, by kind. */
function nextAboutWait(kind: JobWaitKind | undefined): string {
  switch (kind) {
    case 'sql_export': return 'It may still be running: check it once with export_status, wait again with wait_for, or stop it with cancel_query.';
    case 'data_room_job': return 'Check it with create_data_room_dataset action=status.';
    case 'terminal': return 'The terminal shows in the chat panel; tell the owner if it needs them.';
    case 'file': return 'Check where the file should come from.';
    case 'connection': return 'Tell the owner what still fails (Connections shows it), or take another route.';
    default: return 'Decide what to do next.';
  }
}

/** The outcome of a wait that reached its deadline: BotBoy stopped waiting; the thing itself may go on. */
export function timedOutOutcome(wait: Pick<EtlRunWatch, 'kind' | 'deadlineAt' | 'remoteStatus' | 'submittedAt'>, lastSeen?: string): EtlRunOutcome {
  const waited = wait.deadlineAt && wait.submittedAt ? minutesText(Date.parse(wait.deadlineAt) - Date.parse(wait.submittedAt)) : 'its whole time';
  const seen = clip(lastSeen ?? wait.remoteStatus, 200);
  return {
    remoteStatus: 'TIMED_OUT',
    error: `BotBoy stopped waiting after ${waited}${seen ? ` (last seen: ${seen})` : ''}. ${nextAboutWait(wait.kind)}`,
  };
}

// ── Checks ──

export type JobWaitCheck =
  | {
    state: 'pending';
    /** Where it stands, in a few words ("running, 120,000 rows written"), shown while the job waits. */
    note?: string;
    /** Kept for the next check (a file's size and time). */
    lastState?: string;
    /** The check itself failed (the connection did not answer): counted, and the wait goes on. */
    failed?: boolean;
  }
  | { state: 'ended'; outcome: EtlRunOutcome };

/**
 * Where an export stands, from its export_status answer (query-ledger.ts › parseSqlExportStatus), as a wait check: queued or
 * running is pending; done, failed and cancelled end it (a cancel query control made reads as stopped on purpose).
 */
export function exportStatusCheck(status: SqlExportStatus, stoppedMessage?: string | null): JobWaitCheck {
  switch (status.state) {
    case 'queued': return { state: 'pending', note: `queued${status.queuePosition ? ` (position ${status.queuePosition})` : ''}` };
    case 'running': return { state: 'pending', note: `running, ${count(status.rowsWritten ?? 0)} rows written so far` };
    case 'done': {
      const rows = status.rowCount ?? status.rowsWritten;
      return {
        state: 'ended',
        outcome: {
          remoteStatus: 'DONE',
          summary: `${count(rows)} rows, ${size(status.bytes ?? status.bytesWritten)}${status.truncated ? ', cut off at its row or byte limit' : ''}`,
          ...(typeof status.path === 'string' ? { savedTo: status.path } : {}),
          ...(rows !== undefined ? { rowCount: Number(rows) } : {}),
          ...(status.bytes !== undefined ? { resultBytes: Number(status.bytes) } : {}),
          ...(status.truncated !== undefined ? { truncated: Boolean(status.truncated) } : {}),
          ...(Array.isArray(status.columns) ? { columns: status.columns.map(column => clip(column?.name, 80)).filter(Boolean) } : {}),
        },
      };
    }
    case 'failed':
      return { state: 'ended', outcome: { remoteStatus: 'FAILED', error: `${clip(status.error, 600) || 'The export failed.'}${status.errorType ? ` (${clip(status.errorType, 40)})` : ''}` } };
    case 'cancelled':
      return stoppedMessage
        ? { state: 'ended', outcome: { remoteStatus: 'STOPPED', error: stoppedMessage } }
        : { state: 'ended', outcome: { remoteStatus: 'CANCELLED', error: clip(status.error, 400) || 'The export was cancelled.' } };
    default:
      return { state: 'pending', note: clip(status.state, 40) };
  }
}

/** The words for an export the SQL connection no longer knows (it restarted). */
export const EXPORT_LOST_ERROR = 'The SQL connection no longer knows this export: it restarted (with BotBoy, or on its own), and an export does not survive that. Its result can no longer arrive; run the export again if the job still needs it.';

/** A Data Room job's row, as the wait reads it (analytics_jobs). */
export interface DataRoomJobRow {
  status: string;
  errorMessage?: string | null;
  nextAction?: string | null;
}

export interface JobWaitCheckerDeps {
  /** The files workspace (files/), where file waits and exports live. */
  filesDir: string;
  now?: () => number;
  /** sql-context's export_status for one export: a read, on the connection's short-call lane. */
  exportStatus?: (exportId: string, signal: AbortSignal) => Promise<{ isError: boolean; text: string }>;
  /** A stop query control recorded for this export: the words its reader reports (query-ledger.ts › stoppedWords). */
  exportStoppedMessage?: (exportId: string) => string | null;
  dataRoomJob?: (jobId: string) => DataRoomJobRow | null;
  terminal?: {
    get(sessionId: string): McpTerminalSessionSnapshot | null;
    /** The session's output tail, ANSI stripped; null when BotBoy no longer has it. */
    output(sessionId: string, lastChars: number): string | null;
  };
  /** One connection's snapshot (no call). */
  connection?: (serverId: string) => Promise<McpServerSnapshot | null>;
  /** An active check of the SQL connection (connection_status): connected or not, or null when it could not be checked. */
  probeSqlConnection?: (signal: AbortSignal) => Promise<{ connected: boolean; detail?: string } | null>;
}

export interface JobWaitChecker {
  /** Never throws: a check that cannot run is pending (failed); a pending wait past its deadline ends TIMED_OUT. */
  check(wait: EtlRunWatch): Promise<JobWaitCheck>;
}

const PENDING_DATA_ROOM = new Set(['planning', 'running', 'waiting_external', 'delivering', 'cancel_requested']);

export function createJobWaitChecker(deps: JobWaitCheckerDeps): JobWaitChecker {
  const now = deps.now ?? Date.now;
  const unavailable = (what: string): JobWaitCheck => ({ state: 'pending', failed: true, note: `${what} cannot be checked in this BotBoy` });

  async function checkExport(exportId: string): Promise<JobWaitCheck> {
    if (!deps.exportStatus) return unavailable('An export');
    const answer = await deps.exportStatus(exportId, AbortSignal.timeout(25_000));
    if (answer.isError) {
      if (isUnknownExport(answer.text)) return { state: 'ended', outcome: { remoteStatus: 'LOST', error: EXPORT_LOST_ERROR } };
      return { state: 'pending', failed: true, note: `could not check: ${clip(answer.text, 160)}` };
    }
    const status = parseSqlExportStatus(answer.text);
    if (!status) return { state: 'pending', failed: true, note: `could not read its status: ${clip(answer.text, 120)}` };
    return exportStatusCheck(status, status.state === 'cancelled' ? deps.exportStoppedMessage?.(exportId) : null);
  }

  function checkDataRoomJob(jobId: string): JobWaitCheck {
    if (!deps.dataRoomJob) return unavailable('A Data Room job');
    const row = deps.dataRoomJob(jobId);
    if (!row) return { state: 'ended', outcome: { remoteStatus: 'LOST', error: `There is no Data Room job ${jobId}.` } };
    if (PENDING_DATA_ROOM.has(row.status)) return { state: 'pending', note: row.status.replace(/_/g, ' ') };
    const why = [clip(row.errorMessage, 400), clip(row.nextAction, 300)].filter(Boolean).join(' ');
    switch (row.status) {
      case 'complete': return { state: 'ended', outcome: { remoteStatus: 'DONE', summary: 'complete; read its receipt with create_data_room_dataset action=status' } };
      case 'failed': return { state: 'ended', outcome: { remoteStatus: 'FAILED', error: why || 'The Data Room job failed.' } };
      case 'cancelled': return { state: 'ended', outcome: { remoteStatus: 'CANCELLED', error: why || 'The Data Room job was cancelled.' } };
      case 'blocked': return { state: 'ended', outcome: { remoteStatus: 'BLOCKED', error: why || 'The Data Room job is blocked.' } };
      case 'needs_input': return { state: 'ended', outcome: { remoteStatus: 'NEEDS_INPUT', error: why || 'The Data Room job asks a question: read it with create_data_room_dataset action=status.' } };
      case 'needs_approval': return { state: 'ended', outcome: { remoteStatus: 'NEEDS_APPROVAL', error: why || 'The Data Room job waits for the owner to approve an import.' } };
      default: return { state: 'ended', outcome: { remoteStatus: row.status.toUpperCase(), ...(why ? { error: why } : {}) } };
    }
  }

  function checkTerminal(wait: EtlRunWatch, sessionId: string, nowMs: number): JobWaitCheck {
    if (!deps.terminal) return unavailable('A terminal session');
    const session = deps.terminal.get(sessionId);
    if (!session) {
      return { state: 'ended', outcome: { remoteStatus: 'LOST', error: 'BotBoy no longer has this terminal session: it ended more than 10 minutes ago, or BotBoy restarted (which ends it).' } };
    }
    const tail = () => {
      const output = deps.terminal?.output(sessionId, 20_000) ?? '';
      return output.trim() ? output.slice(-TERMINAL_TAIL_CHARS) : undefined;
    };
    if (wait.untilOutput) {
      const output = deps.terminal.output(sessionId, 20_000) ?? '';
      if (output.includes(wait.untilOutput)) {
        const detail = output.slice(-TERMINAL_TAIL_CHARS);
        return { state: 'ended', outcome: { remoteStatus: 'DONE', summary: `the output shows "${clip(wait.untilOutput, 120)}"${session.status === 'running' ? ' (the session still runs)' : ''}`, detail } };
      }
    }
    const detail = tail();
    switch (session.status) {
      case 'running':
        return { state: 'pending', note: `running for ${minutesText(nowMs - Date.parse(session.startedAt))}` };
      case 'completed':
        return session.exitCode === 0 || session.exitCode === null
          ? { state: 'ended', outcome: { remoteStatus: 'DONE', summary: `ended, exit ${session.exitCode ?? 0}`, ...(detail ? { detail } : {}) } }
          : { state: 'ended', outcome: { remoteStatus: 'FAILED', error: `ended with exit ${session.exitCode}`, ...(detail ? { detail } : {}) } };
      case 'timed_out':
        return { state: 'ended', outcome: { remoteStatus: 'FAILED', error: 'the session reached its own time limit and was stopped', ...(detail ? { detail } : {}) } };
      case 'stopped':
        return { state: 'ended', outcome: { remoteStatus: 'STOPPED', error: 'the session was stopped (by the owner, or by BotBoy at the owner\'s ask)', ...(detail ? { detail } : {}) } };
      default:
        return { state: 'ended', outcome: { remoteStatus: 'FAILED', error: `the session failed${session.exitCode !== null ? ` (exit ${session.exitCode})` : ''}`, ...(detail ? { detail } : {}) } };
    }
  }

  function checkFile(wait: EtlRunWatch, relative: string, nowMs: number): JobWaitCheck {
    const full = path.resolve(deps.filesDir, relative);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(full);
    } catch (error: any) {
      if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return { state: 'pending', note: 'not there yet' };
      return { state: 'pending', failed: true, note: `could not check: ${clip(error?.message ?? error, 120)}` };
    }
    if (stat.isDirectory()) return { state: 'ended', outcome: { remoteStatus: 'FAILED', error: `${relative} is a folder, not a file.` } };
    if (!stat.isFile()) return { state: 'ended', outcome: { remoteStatus: 'FAILED', error: `${relative} is not a regular file.` } };
    if (stat.size === 0) return { state: 'pending', note: 'there, but still empty' };
    // Landed: it holds bytes and has not changed for FILE_SETTLED_MS, by its own time or between BotBoy's checks.
    const key = `${stat.size}:${Math.round(stat.mtimeMs)}`;
    const [seenKey, seenAt] = String(wait.lastState ?? '').split('@');
    const sameSince = seenKey === key && Number.isFinite(Number(seenAt)) ? Number(seenAt) : nowMs;
    const quietFor = Math.max(nowMs - stat.mtimeMs, nowMs - sameSince);
    if (quietFor >= FILE_SETTLED_MS) {
      return { state: 'ended', outcome: { remoteStatus: 'DONE', summary: `landed, ${size(stat.size)}`, savedTo: full, resultBytes: stat.size } };
    }
    return { state: 'pending', note: `there, ${size(stat.size)} so far (still changing)`, lastState: `${key}@${Math.round(sameSince)}` };
  }

  async function checkConnection(wait: EtlRunWatch, serverId: string): Promise<JobWaitCheck> {
    if (!deps.connection) return unavailable('A connection');
    const server = await deps.connection(serverId);
    if (!server) return { state: 'ended', outcome: { remoteStatus: 'FAILED', error: `BotBoy has no connection "${serverId}" any more.` } };
    const name = server.displayName || serverId;
    if (!server.enabled) {
      return { state: 'ended', outcome: { remoteStatus: 'FAILED', error: `The ${name} connection is turned off in Connections; only the owner can turn it on.` } };
    }
    if (serverId === 'sql-context' && deps.probeSqlConnection) {
      const probe = await deps.probeSqlConnection(AbortSignal.timeout(40_000));
      if (probe?.connected) return { state: 'ended', outcome: { remoteStatus: 'DONE', summary: `the ${name} connection answers again` } };
      return probe
        ? { state: 'pending', note: `not connected yet${probe.detail ? `: ${clip(probe.detail, 160)}` : ''}` }
        : { state: 'pending', failed: true, note: 'could not check it this time' };
    }
    // Other connections: BotBoy's own health check passed since the wait began.
    const healthyAt = timestampMs(server.lastHealthyAt);
    if (server.state === 'running' && Number.isFinite(healthyAt) && healthyAt >= Date.parse(wait.submittedAt) - 1_000) {
      return { state: 'ended', outcome: { remoteStatus: 'DONE', summary: `the ${name} connection answers again` } };
    }
    return { state: 'pending', note: `${server.state}${server.lastError ? `: ${clip(server.lastError, 160)}` : ''}` };
  }

  async function checkKind(wait: EtlRunWatch, nowMs: number): Promise<JobWaitCheck> {
    const target = String(wait.target ?? '');
    switch (wait.kind) {
      case 'sql_export': return checkExport(target);
      case 'data_room_job': return checkDataRoomJob(target);
      case 'terminal': return checkTerminal(wait, target, nowMs);
      case 'file': return checkFile(wait, target, nowMs);
      case 'connection': return checkConnection(wait, target);
      case 'time':
        return nowMs >= Date.parse(target)
          ? { state: 'ended', outcome: { remoteStatus: 'DONE', summary: `it is ${target} now` } }
          : { state: 'pending', note: `until ${target}` };
      default:
        return { state: 'ended', outcome: { remoteStatus: 'FAILED', error: `BotBoy does not know how to wait for "${clip(wait.kind, 40)}".` } };
    }
  }

  return {
    async check(wait) {
      const nowMs = now();
      let result: JobWaitCheck;
      try {
        result = await checkKind(wait, nowMs);
      } catch (error: any) {
        result = { state: 'pending', failed: true, note: `could not check: ${clip(error?.message ?? error, 160)}` };
      }
      if (result.state === 'pending' && wait.deadlineAt && nowMs >= Date.parse(wait.deadlineAt)) {
        return { state: 'ended', outcome: timedOutOutcome(wait, result.note) };
      }
      return result;
    },
  };
}
