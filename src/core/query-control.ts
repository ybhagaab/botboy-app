/**
 * Stopping BotBoy's own warehouse queries (docs/maps/query-control.md). Owner request 2026-11-12: "build the tool to let main
 * chat & job cancel query, that it started. and also for me to cancel any query going on via botboy. etl or sql."
 *
 * What runs is derived each time, never guessed:
 *   - SQL BotBoy is waiting on: the in-flight calls of query-ledger.ts (memory; free to read);
 *   - background exports (export_query with wait:false, docs/maps/job-waits.md): the SQL connection's own export_status for each
 *     open one; stopping one asks the connection to cancel it, then checks the warehouse like any other stop;
 *   - SQL only the warehouse still runs (BotBoy lost the connection, restarted, or timed out and the cancel may have missed):
 *     Redshift's running queries (`stv_recents`), each attributed through BotBoy's SQL marker, read from the statement itself or
 *     from the DECLARE that opened the cursor a FETCH reads (`sys_query_history`). The warehouse is read only while BotBoy has
 *     such a suspect, so an ordinary day sends it nothing. A query sent before BotBoy marked its SQL is matched by start time to
 *     a BotBoy call that lost its connection, only when exactly one call matches;
 *   - ETL: the Datanet runs BotBoy submitted (query_ledger) that Datanet does not report finished.
 * Nothing that BotBoy did not start is ever listed or stopped: the SQL connection's database user is shared with other tools on
 * this Mac (and other BotBoys), so the marker, not the user, decides.
 *
 * Stopping a SQL query cancels BotBoy's call when it is still waiting (the connector then cancels the warehouse query), and
 * ends the warehouse session when the query is still running after that, or when BotBoy has no call for it anymore. A session
 * is ended only while the statement it runs is still the query being stopped: pooled sessions are reused, so the session's own
 * statement is attributed again before every end. Stopping an ETL run asks Datanet to kill it. Every stop is checked afterwards;
 * the receipt says stopped, already finished, or still running, with the next step.
 */
import type Database from 'better-sqlite3';
import { isDatanetCancelled, isDatanetStopping } from './datanet-run-states.js';
import type { McpManager } from './mcp-types.js';
import type { EtlToolCall } from './etl-adhoc.js';
import { DATANET_SIGN_IN_FIX, DATANET_SIGN_IN_REFUSED, isDatanetSignInRefusal } from './sentry-session.js';
import {
  ETL_TERMINAL_STATES,
  QueryStoppedReason,
  isConnectionLost,
  isControlSql,
  isUnknownExport,
  markerOf,
  parseSqlExportStatus,
  stoppedWords,
  type QueryLedger,
  type QueryOriginKind,
  type QueryRecord,
} from './query-ledger.js';

/**
 * botboy: BotBoy is waiting on it now; background: a background export the SQL connection runs on its own (export_query with
 * wait:false); warehouse: only the warehouse still runs it; datanet: a Datanet ETL run.
 */
export type QueryWhere = 'botboy' | 'background' | 'warehouse' | 'datanet';

export interface RunningQuery {
  /** sql: BotBoy's call id; etl: `etl:<runId>`; a query from before BotBoy marked its SQL: `earlier:<sessionId>`. */
  id: string;
  kind: 'sql' | 'etl';
  /** `earlier`: sent before BotBoy marked its SQL; who started it is not known. */
  origin: QueryOriginKind | 'earlier';
  jobId?: string;
  /** The job's number and title, when a job started it. */
  job?: { number: number | null; title: string };
  /** What it is, in a few words. */
  label: string;
  /** The first characters of its SQL. */
  preview: string;
  startedAt: string;
  runningForMs: number;
  where: QueryWhere;
  /** The warehouse session running it, its running statement's id, and when that statement started. */
  warehouse?: { sessionId: number; queryId?: number; statementStartedAt?: string };
  runId?: string;
  /** A background export's id (where `background`). */
  exportId?: string;
  remoteStatus?: string;
  /** How BotBoy knows the warehouse query is its own: its SQL marker, or (a query from before markers) its start time. */
  matchedBy?: 'marker' | 'start_time';
}

/** Who asks to stop a query: the owner (his panel), a job, or a main-chat owner turn. */
export type QueryActor =
  | { kind: 'owner' }
  | { kind: 'job'; jobId: string; ownerRequested?: boolean }
  | { kind: 'main'; jobIds?: string[]; ownerRequested?: boolean };

export interface StopReceipt {
  ok: boolean;
  id: string;
  kind?: 'sql' | 'etl';
  state?: 'stopped' | 'already_finished' | 'still_running';
  what?: string;
  /** What BotBoy did, in order. */
  steps?: string[];
  /** The warehouse or Datanet confirmed it no longer runs. */
  verified?: boolean;
  checkedAt?: string;
  code?: 'not_running' | 'not_yours' | 'unavailable' | 'stop_failed';
  error?: string;
  nextAction?: string;
}

export interface QueryListing {
  queries: RunningQuery[];
  checkedAt: string;
  /** What BotBoy could not check this time, in a sentence each. */
  warnings: string[];
}

export interface QueryControl {
  list(options?: { fresh?: boolean }): Promise<QueryListing>;
  stop(id: string, actor: QueryActor, reason?: string): Promise<StopReceipt>;
  mayStop(query: RunningQuery, actor: QueryActor): boolean;
  /** Who started it, in words: "job #5 OTT CX behaviour study", "the main chat", "a dashboard refresh". */
  starterOf(query: RunningQuery): string;
}

export interface QueryControlDeps {
  db: Database.Database;
  ledger: QueryLedger;
  mcpManager: Pick<McpManager, 'callTool'>;
  /** Datanet ETL calls (etl-adhoc.ts › createEtlToolCall); absent: ETL runs are not read or stopped. */
  etlCall?: EtlToolCall | null;
  /** False while Datanet is not available (Amazon Employee off): ETL runs are not read. */
  etlAvailable?: () => boolean;
  /** A job owns this run (chat-jobs.ts › isJobRun). */
  isJobRun?: (jobId: string, runId: string) => boolean;
  /** A job's number and title, for the list. */
  describeJob?: (jobId: string) => { number: number | null; title: string } | null;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** How long an ordinary listing (the panel's poll) reuses a warehouse or Datanet read (default 60 s). */
  pollCacheMs?: number;
  /** How long a fresh listing (the owner opened the list, a model asked, a stop) reuses one (default 3 s). */
  freshCacheMs?: number;
}

/** How far back BotBoy looks for its own queries. */
const LOOKBACK_HOURS = 48;
/** A SQL call that timed out or was cancelled this recently is checked on the warehouse too: the cancel may have missed. */
const RECENT_FAILURE_MINUTES = 30;
const TIMEOUT_OR_ABORT = /timed? ?out|timeout|cancel|abort/i;
/** At most this many open ETL runs are read from Datanet per listing (newest first), this many at a time. */
const MAX_ETL_READS = 15;
const ETL_READ_CONCURRENCY = 4;
/** A query from before markers matches a BotBoy call started this long before its transaction (a lane wait), or 2 s after. */
const EARLIER_MATCH_BEFORE_S = 120;
const EARLIER_MATCH_AFTER_S = 2;
/** The newest history statements read per running session: the running one, its DECLARE, its BEGIN, and a few before. */
const HISTORY_PER_SESSION = 8;
/** The SQL connection: BotBoy's managed sql-context profile. */
const SQL_SERVER = 'sql-context';
const DECLARE_PREFIX = /^\s*DECLARE\s+mcp_c\s+CURSOR\s+FOR\s+/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const firstLine = (text: unknown, max = 240): string => String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const sqliteUtcMs = (value: string): number => Date.parse(`${String(value).replace(' ', 'T')}Z`);
const sqliteUtc = (ms: number): string => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
/** The SQL a statement runs, without the connector's cursor wrapper or BotBoy's marker. */
const sqlOf = (text: string): string => firstLine(text.replace(DECLARE_PREFIX, '').replace(/^\s*\/\*\s*botboy:[^*]*\*\/\s*/i, ''), 200);

/** A Datanet run's status as query control reads it: its state, or null (`signIn`: Datanet refused BotBoy's sign-in). */
interface EtlStatusRead {
  status: string | null;
  error?: string;
  signIn?: boolean;
}

/** A background export's status as query control reads it: its state (`unknown`: the connection no longer tracks it), or null. */
interface ExportRead {
  state: string | null;
  rowsWritten?: number;
  error?: string;
}

interface WarehouseRun {
  sessionId: number;
  queryId?: number;
  /** When the running statement started. */
  startedMs: number;
  /** The SQL it runs: the cursor's for a FETCH, else its own. */
  sql: string;
  /** A BotBoy call's id, `control` (query control's own lookup), or null (no BotBoy mark: another tool's, or from before markers). */
  owner: string | null;
  /** When the session's transaction began (the BEGIN before the running statement), for a query from before markers. */
  beganMs: number | null;
}

interface WarehouseRead {
  at: number;
  /** The running queries could be read. */
  ok: boolean;
  /** Their history could be read too (needed to attribute a FETCH and to match a query from before markers). */
  historyOk: boolean;
  runs: WarehouseRun[];
  error?: string;
}

/** Parses the SQL connection's `format: "json"` answer into rows of arrays. */
function parseJsonRows(text: string): unknown[][] | null {
  const start = text.indexOf('{');
  if (start < 0) return null;
  try {
    const value = JSON.parse(text.slice(start));
    return Array.isArray(value?.rows) ? value.rows.filter((row: unknown): row is unknown[] => Array.isArray(row)) : null;
  } catch {
    return null;
  }
}

async function mapLimit<T, R>(items: T[], limit: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await run(items[index]);
    }
  }));
  return results;
}

export function createQueryControl(deps: QueryControlDeps): QueryControl {
  const { db, ledger } = deps;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const pollCacheMs = deps.pollCacheMs ?? 60_000;
  const freshCacheMs = deps.freshCacheMs ?? 3_000;
  let warehouseCache: WarehouseRead | null = null;
  let warehouseReading: Promise<WarehouseRead> | null = null;
  const etlStatusCache = new Map<string, { at: number } & EtlStatusRead>();
  const exportStatusCache = new Map<string, { at: number; read: ExportRead }>();
  /** The database is not Redshift: only the calls BotBoy is waiting on can be listed and stopped. */
  let warehouseUnsupported = false;
  /** Suspects this process saw the warehouse no longer run: not read for again (a restart checks them once more). */
  const settled = new Set<string>();

  importRecentEtlRuns();

  /** ETL runs recorded before the ledger existed (data-origins.ts › etl_run_queries), so a run started just before is listed too. */
  function importRecentEtlRuns(): void {
    try {
      const rows = db.prepare(`SELECT run_id, sql, job_id, purpose, submitted_at FROM etl_run_queries WHERE submitted_at >= ?`)
        .all(new Date(now() - LOOKBACK_HOURS * 3_600_000).toISOString()) as Array<{ run_id: string; sql: string; job_id: string | null; purpose: string | null; submitted_at: string }>;
      for (const row of rows) {
        if (ledger.forRun(row.run_id)) continue;
        const purpose = String(row.purpose ?? '');
        ledger.beginEtl({
          runId: row.run_id,
          origin: row.job_id ? { kind: 'job', jobId: row.job_id } : { kind: /^Dashboard refresh/.test(purpose) ? 'dashboard' : 'botboy' },
          sql: row.sql,
          ...(purpose ? { label: purpose } : {}),
          startedAt: row.submitted_at,
        });
      }
    } catch {
      // No etl_run_queries table yet (a fresh store): nothing to import.
    }
  }

  /** One lookup or stop of query control's own on the SQL connection (marked as control, never queued behind other calls). */
  async function controlSql(sql: string): Promise<{ ok: true; rows: unknown[][] } | { ok: false; error: string }> {
    try {
      const result = await deps.mcpManager.callTool(SQL_SERVER, 'run_query', { sql, format: 'json', maxRows: 500, timeoutMs: 20_000 }, {
        source: 'query-control', timeoutMs: 45_000, queryControl: true,
      });
      if (result.isError) return { ok: false, error: firstLine(result.text) || 'the SQL connection returned an error' };
      const rows = parseJsonRows(result.text);
      return rows ? { ok: true, rows } : { ok: false, error: `unreadable answer: ${firstLine(result.text, 120)}` };
    } catch (error: any) {
      return { ok: false, error: firstLine(error?.message ?? error) };
    }
  }

  /**
   * The warehouse's running queries of the connection's user (or of one session), each with its owner: the BotBoy call whose
   * marker its own text carries, or (a FETCH) the marker of the DECLARE that opened its cursor.
   */
  async function fetchWarehouse(sessionId?: number): Promise<WarehouseRead> {
    const at = now();
    const only = sessionId !== undefined ? ` AND pid = ${Math.trunc(sessionId)}` : '';
    const running = await controlSql(`SELECT pid, DATE_PART(epoch, starttime) AS started, LEFT(TRIM(query), 200) AS text FROM stv_recents
      WHERE status = 'Running' AND pid <> pg_backend_pid()${only} ORDER BY starttime`);
    if (!running.ok) {
      if (/stv_recents/i.test(running.error) && /does not exist|not supported|permission denied/i.test(running.error)) warehouseUnsupported = true;
      return { at, ok: false, historyOk: false, runs: [], error: running.error };
    }
    const current = running.rows
      .map(row => ({ sessionId: Number(row[0]), startedMs: Math.round(Number(row[1]) * 1000), text: String(row[2] ?? '') }))
      .filter(row => Number.isInteger(row.sessionId) && row.sessionId > 0 && Number.isFinite(row.startedMs) && !isControlSql(row.text));
    if (!current.length) return { at, ok: true, historyOk: true, runs: [] };
    const sessions = [...new Set(current.map(row => row.sessionId))].slice(0, 100);
    const history = await controlSql(`SELECT session_id, query_id, started, status, text FROM (
        SELECT session_id, query_id, DATE_PART(epoch, start_time) AS started, TRIM(status) AS status, LEFT(query_text, 400) AS text,
          ROW_NUMBER() OVER (PARTITION BY session_id ORDER BY start_time DESC) AS n
        FROM sys_query_history
        WHERE session_id IN (${sessions.join(', ')}) AND start_time > DATEADD(hour, -${LOOKBACK_HOURS}, GETDATE())
          AND (query_text LIKE '/* botboy:%' OR query_text LIKE 'DECLARE mcp_c CURSOR FOR %' OR UPPER(TRIM(query_text)) = 'BEGIN'
            OR TRIM(status) IN ('running', 'queued', 'returning', 'planning'))
      ) AS recent WHERE n <= ${HISTORY_PER_SESSION} ORDER BY session_id, started`);
    const statements = history.ok
      ? history.rows.map(row => ({
        sessionId: Number(row[0]), queryId: Number(row[1]), startedMs: Math.round(Number(row[2]) * 1000),
        status: String(row[3] ?? '').toLowerCase(), text: String(row[4] ?? ''),
      }))
      : [];
    const runs = current.map((run): WarehouseRun => {
      // The session's statements up to the running one (a session runs one statement at a time).
      const before = statements.filter(statement => statement.sessionId === run.sessionId && statement.startedMs <= run.startedMs + 1000);
      const fetch = /^\s*FETCH\b/i.test(run.text);
      const declared = fetch ? before.filter(statement => DECLARE_PREFIX.test(statement.text)).at(-1) : undefined;
      const ownerText = markerOf(run.text) || isControlSql(run.text) ? run.text : declared?.text ?? (fetch ? '' : run.text);
      const owner = markerOf(ownerText) ?? (isControlSql(ownerText) ? 'control' : null);
      const began = before.filter(statement => /^begin$/i.test(statement.text.trim())).at(-1);
      const active = before.filter(statement => statement.status === 'running').at(-1);
      return {
        sessionId: run.sessionId,
        ...(active && Number.isInteger(active.queryId) ? { queryId: active.queryId } : {}),
        startedMs: run.startedMs,
        sql: sqlOf(declared?.text ?? run.text),
        owner,
        beganMs: began ? began.startedMs : null,
      };
    });
    return {
      at, ok: true, historyOk: history.ok, runs,
      ...(history.ok ? {} : { error: history.error }),
    };
  }

  /** The whole warehouse read, reused for a while (one read at a time). */
  async function readWarehouse(fresh: boolean): Promise<WarehouseRead> {
    const maxAge = fresh ? freshCacheMs : pollCacheMs;
    if (warehouseCache && now() - warehouseCache.at < maxAge) return warehouseCache;
    if (!warehouseReading) {
      warehouseReading = fetchWarehouse().then((read) => {
        warehouseCache = read;
        return read;
      }).finally(() => { warehouseReading = null; });
    }
    return warehouseReading;
  }

  /**
   * BotBoy calls from before markers (the ledger does not know them) that may have left a query running: one that lost its
   * connection, or one an earlier BotBoy process left waiting.
   */
  function earlierCandidates(at: number): Array<{ id: string; createdMs: number }> {
    try {
      const rows = db.prepare(`SELECT id, created_at, status, error FROM mcp_tool_calls
        WHERE server_id = ? AND tool_name IN ('run_query', 'export_query') AND source NOT IN ('health', 'query-control')
          AND created_at >= ? AND status IN ('failed', 'running')`)
        .all(SQL_SERVER, sqliteUtc(at - LOOKBACK_HOURS * 3_600_000)) as Array<{ id: string; created_at: string; status: string; error: string | null }>;
      return rows
        .filter((row) => {
          if (settled.has(row.id) || ledger.get(row.id)) return false;
          const createdMs = sqliteUtcMs(row.created_at);
          return row.status === 'running' ? createdMs < ledger.startedAtMs : isConnectionLost(row.error);
        })
        .map(row => ({ id: row.id, createdMs: sqliteUtcMs(row.created_at) }));
    } catch {
      return [];
    }
  }

  /** BotBoy SQL the warehouse may still run though BotBoy no longer waits on it. None: the warehouse is not read at all. */
  function suspects(at: number): { calls: QueryRecord[]; earlier: Array<{ id: string; createdMs: number }> } {
    const calls = ledger.sqlSuspects(
      new Date(at - LOOKBACK_HOURS * 3_600_000).toISOString(),
      new Date(at - RECENT_FAILURE_MINUTES * 60_000).toISOString(),
    ).filter(row => !settled.has(row.id) && !ledger.inFlightById(row.id)
      && (row.endState !== 'failed' || TIMEOUT_OR_ABORT.test(row.endNote ?? '')));
    return { calls, earlier: earlierCandidates(at) };
  }

  /** The one candidate call a query from before markers belongs to: started just before its transaction began. Several: none. */
  function earlierCallFor(beganMs: number, candidates: Array<{ id: string; createdMs: number }>, used: Set<string>) {
    const matches = candidates.filter(candidate => !used.has(candidate.id)
      && candidate.createdMs >= beganMs - EARLIER_MATCH_BEFORE_S * 1000 && candidate.createdMs <= beganMs + EARLIER_MATCH_AFTER_S * 1000);
    return matches.length === 1 ? matches[0] : null;
  }

  /**
   * `force`: ask Datanet now, whatever was read a moment ago (right after a stop, the state may have just changed). `signIn`:
   * Datanet answered with its sign-in page, so the state is not known and the owner's sign-in is the fix (sentry-session.ts).
   */
  async function etlStatus(runId: string, fresh: boolean, force = false): Promise<EtlStatusRead> {
    const cached = etlStatusCache.get(runId);
    if (!force && cached && now() - cached.at < (fresh ? freshCacheMs : pollCacheMs)) return cached;
    if (!deps.etlCall) return { status: null, error: 'the Datanet ETL connection is not available' };
    let result: EtlStatusRead;
    try {
      const poll = await deps.etlCall('datanet_get_job_run_status', { run_id: runId });
      let status = '';
      if (!poll.isError) {
        try { status = String(JSON.parse(poll.text.slice(Math.max(0, poll.text.indexOf('{'))))?.status ?? '').toUpperCase(); } catch { /* below */ }
      }
      if (status) result = { status };
      else if (isDatanetSignInRefusal(poll.text)) result = { status: null, signIn: true, error: DATANET_SIGN_IN_REFUSED };
      else if (poll.isError) result = { status: null, error: firstLine(poll.text) };
      else result = { status: null, error: `no status in ${firstLine(poll.text, 80)}` };
    } catch (error: any) {
      result = { status: null, error: firstLine(error?.message ?? error) };
    }
    etlStatusCache.set(runId, { at: now(), ...result });
    return result;
  }

  /**
   * One background export's status, or its cancel, through the SQL connection: a short call off its query lane. The manager
   * ends the ledger row of an export that ended (query-ledger.ts › noteExportStatus). `unknown`: the connection restarted since.
   */
  async function exportStatusRead(exportId: string, fresh: boolean, cancel = false): Promise<ExportRead> {
    const cached = cancel ? undefined : exportStatusCache.get(exportId);
    if (cached && now() - cached.at < (fresh ? freshCacheMs : pollCacheMs)) return cached.read;
    let read: ExportRead;
    try {
      const answer = await deps.mcpManager.callTool(SQL_SERVER, 'export_status', { exportId, ...(cancel ? { cancel: true } : {}) }, {
        source: 'query-control', timeoutMs: 30_000, queryControl: true,
      });
      if (answer.isError) read = isUnknownExport(answer.text) ? { state: 'unknown' } : { state: null, error: firstLine(answer.text) };
      else {
        const status = parseSqlExportStatus(answer.text);
        read = status
          ? { state: status.state, ...(status.rowsWritten !== undefined ? { rowsWritten: Number(status.rowsWritten) } : {}) }
          : { state: null, error: `unreadable answer: ${firstLine(answer.text, 120)}` };
      }
    } catch (error: any) {
      read = { state: null, error: firstLine(error?.message ?? error) };
    }
    exportStatusCache.set(exportId, { at: now(), read });
    return read;
  }

  const sqlFallbackLabel = (origin: QueryOriginKind | 'earlier'): string => ({
    main: 'A SQL query from the main chat',
    job: 'A SQL query from a job',
    dashboard: 'A dashboard refresh query',
    data_room: 'A Data Room query',
    dictionary: 'A data dictionary query',
    botboy: 'A SQL query BotBoy sent',
    earlier: 'A SQL query BotBoy sent before it labelled its queries',
  } as Record<string, string>)[origin] ?? 'A SQL query BotBoy sent';
  const jobOf = (jobId: string | null | undefined) => (jobId ? deps.describeJob?.(jobId) ?? null : null);
  const sessionOf = (run: WarehouseRun) => ({
    sessionId: run.sessionId,
    ...(run.queryId !== undefined ? { queryId: run.queryId } : {}),
    statementStartedAt: new Date(run.startedMs).toISOString(),
  });

  async function list(options: { fresh?: boolean } = {}): Promise<QueryListing> {
    const at = now();
    const fresh = options.fresh === true;
    const warnings: string[] = [];
    const queries: RunningQuery[] = [];
    const listed = new Set<string>();
    // Background exports first (export_query with wait:false): the SQL connection runs them on its own, so their status is read
    // from it. One that ended has its row ended by the manager; one the connection no longer knows is lost, and the suspects
    // below check the warehouse for its query.
    const background = ledger.openExports(new Date(at - LOOKBACK_HOURS * 3_600_000).toISOString()).reverse().slice(0, MAX_ETL_READS);
    if (background.length) {
      const reads = await mapLimit(background, ETL_READ_CONCURRENCY, row => exportStatusRead(row.exportId!, fresh));
      let unreadable = 0;
      background.forEach((row, index) => {
        const read = reads[index];
        if (read.state && read.state !== 'queued' && read.state !== 'running') return;
        if (ledger.get(row.id)?.endState !== 'background') return;
        if (!read.state) unreadable += 1;
        listed.add(row.id);
        const job = jobOf(row.jobId);
        queries.push({
          id: row.id,
          kind: 'sql',
          origin: row.origin,
          ...(row.jobId ? { jobId: row.jobId } : {}),
          ...(job ? { job } : {}),
          label: row.label || sqlFallbackLabel(row.origin),
          preview: row.preview ?? '',
          startedAt: row.startedAt,
          runningForMs: Math.max(0, at - Date.parse(row.startedAt)),
          where: 'background',
          exportId: row.exportId!,
          ...(read.state === 'running' ? { remoteStatus: `running, ${(read.rowsWritten ?? 0).toLocaleString('en-US')} rows written` }
            : read.state === 'queued' ? { remoteStatus: 'queued' } : {}),
        });
      });
      if (unreadable) warnings.push(`The SQL connection did not answer for ${unreadable} background export${unreadable === 1 ? '' : 's'}; ${unreadable === 1 ? 'it is' : 'they are'} listed as still running.`);
    }
    const lost = suspects(at);
    if (warehouseUnsupported && lost.calls.length) {
      warnings.push('This database does not show its running queries, so BotBoy lists only the SQL calls it is waiting on.');
    }
    if ((lost.calls.length || lost.earlier.length) && !warehouseUnsupported) {
      const warehouse = await readWarehouse(fresh);
      if (!warehouse.ok) {
        warnings.push(`BotBoy could not read the warehouse's running queries (${warehouse.error}), so a query whose connection BotBoy lost may be missing below.`);
      } else if (!warehouse.historyOk) {
        warnings.push(`BotBoy could not read the warehouse's query history (${warehouse.error}), so a query whose connection BotBoy lost may be missing below.`);
      }
      const matchedEarlier = new Set<string>();
      for (const run of warehouse.runs) {
        if (run.owner === 'control') continue;
        if (run.owner) {
          const row = ledger.get(run.owner);
          // A marker this BotBoy has no record of is another BotBoy's (the database user can be shared): never listed.
          if (!row || row.kind !== 'sql' || listed.has(row.id)) continue;
          listed.add(row.id);
          const job = jobOf(row.jobId);
          queries.push({
            id: row.id,
            kind: 'sql',
            origin: row.origin,
            ...(row.jobId ? { jobId: row.jobId } : {}),
            ...(job ? { job } : {}),
            label: row.label || sqlFallbackLabel(row.origin),
            preview: row.preview || run.sql,
            startedAt: row.startedAt,
            runningForMs: Math.max(0, at - Date.parse(row.startedAt)),
            where: ledger.inFlightById(row.id) ? 'botboy' : 'warehouse',
            warehouse: sessionOf(run),
            matchedBy: 'marker',
          });
          continue;
        }
        if (!warehouse.historyOk) continue;
        const call = earlierCallFor(run.beganMs ?? run.startedMs, lost.earlier, matchedEarlier);
        if (!call) continue;
        matchedEarlier.add(call.id);
        queries.push({
          id: `earlier:${run.sessionId}`,
          kind: 'sql',
          origin: 'earlier',
          label: sqlFallbackLabel('earlier'),
          preview: run.sql,
          startedAt: new Date(call.createdMs).toISOString(),
          runningForMs: Math.max(0, at - call.createdMs),
          where: 'warehouse',
          warehouse: sessionOf(run),
          matchedBy: 'start_time',
        });
      }
      // What BotBoy suspected and the warehouse no longer runs is settled: not read for again in this process. Only what had
      // ended (or started) before the read: a call that failed after it may have a query the read could not see yet.
      if (warehouse.ok && warehouse.historyOk) {
        const runningOwners = new Set(warehouse.runs.map(run => run.owner).filter(Boolean));
        for (const row of lost.calls) {
          const knownAt = Date.parse(row.endedAt ?? row.startedAt);
          if (!runningOwners.has(row.id) && Number.isFinite(knownAt) && knownAt < warehouse.at) settled.add(row.id);
        }
        for (const candidate of lost.earlier) if (!matchedEarlier.has(candidate.id)) settled.add(candidate.id);
      }
    }
    // Calls BotBoy is waiting on that the warehouse read did not show: most of them (the warehouse is read only for suspects),
    // and ones waiting for a slot, connecting, or on a database that is not Redshift.
    for (const flight of ledger.inFlight()) {
      if (listed.has(flight.id)) continue;
      const job = jobOf(flight.jobId);
      queries.push({
        id: flight.id,
        kind: 'sql',
        origin: flight.origin,
        ...(flight.jobId ? { jobId: flight.jobId } : {}),
        ...(job ? { job } : {}),
        label: flight.label || sqlFallbackLabel(flight.origin),
        preview: flight.preview,
        startedAt: flight.startedAt,
        runningForMs: Math.max(0, at - Date.parse(flight.startedAt)),
        where: 'botboy',
      });
    }
    // Datanet ETL runs BotBoy submitted that Datanet does not report finished.
    const etlOn = Boolean(deps.etlCall) && deps.etlAvailable?.() !== false;
    const openEtl = ledger.openSince(new Date(at - LOOKBACK_HOURS * 3_600_000).toISOString())
      .filter(row => row.kind === 'etl' && row.runId)
      .reverse();
    if (openEtl.length && !etlOn) warnings.push('Datanet ETL is not available right now, so BotBoy cannot check its ETL runs.');
    if (etlOn && openEtl.length) {
      const checked = openEtl.slice(0, MAX_ETL_READS);
      const statuses = await mapLimit(checked, ETL_READ_CONCURRENCY, row => etlStatus(row.runId!, fresh));
      let unreadable = 0;
      let refused = 0;
      checked.forEach((row, index) => {
        const status = statuses[index];
        if (status.status && ETL_TERMINAL_STATES.has(status.status)) {
          ledger.endEtl(row.runId!, status.status);
          return;
        }
        if (!status.status && status.signIn) refused += 1;
        else if (!status.status) unreadable += 1;
        const job = jobOf(row.jobId);
        queries.push({
          id: row.id,
          kind: 'etl',
          origin: row.origin,
          ...(row.jobId ? { jobId: row.jobId } : {}),
          ...(job ? { job } : {}),
          label: row.label || 'A Datanet ETL run',
          preview: row.preview ?? '',
          startedAt: row.startedAt,
          runningForMs: Math.max(0, at - Date.parse(row.startedAt)),
          where: 'datanet',
          runId: row.runId!,
          ...(status.status ? { remoteStatus: status.status } : {}),
        });
      });
      // A refused sign-in is named as such, with its fix: "did not answer" sent the owner looking at the network (2026-11-14).
      if (refused) warnings.push(`${DATANET_SIGN_IN_REFUSED} for ${refused} ETL run${refused === 1 ? '' : 's'}; ${refused === 1 ? 'it is' : 'they are'} listed as still running until Datanet answers. To fix it, ${DATANET_SIGN_IN_FIX}, then check again.`);
      if (unreadable) warnings.push(`Datanet did not answer for ${unreadable} ETL run${unreadable === 1 ? '' : 's'}; ${unreadable === 1 ? 'it is' : 'they are'} listed as still running.`);
      if (openEtl.length > MAX_ETL_READS) warnings.push(`Only the newest ${MAX_ETL_READS} unfinished ETL runs were checked.`);
    }
    queries.sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
    return { queries, checkedAt: new Date(at).toISOString(), warnings };
  }

  function mayStop(query: RunningQuery, actor: QueryActor): boolean {
    if (actor.kind === 'owner') return true;
    // A live owner turn may stop any of BotBoy's queries when the owner asked it to (ownerRequested); a job's own turns never.
    if (actor.ownerRequested === true) return true;
    if (actor.kind === 'job') {
      if (query.jobId === actor.jobId) return true;
      return query.kind === 'etl' && Boolean(query.runId && deps.isJobRun?.(actor.jobId, query.runId));
    }
    if (query.origin === 'main') return true;
    return Boolean(query.jobId && actor.jobIds?.includes(query.jobId));
  }

  function starterOf(query: RunningQuery): string {
    switch (query.origin) {
      case 'job': return query.job ? `job #${query.job.number ?? '?'} ${query.job.title}` : 'a job';
      case 'main': return 'the main chat';
      case 'dashboard': return 'a dashboard refresh';
      case 'data_room': return 'the Data Room';
      case 'dictionary': return 'the data dictionary build';
      case 'earlier': return 'BotBoy, before it labelled its queries (so who started it is not known)';
      default: return 'BotBoy';
    }
  }

  /** Who stops it, for the record and the words its reader gets: the owner (his panel, or his ask in chat), a job, the main chat. */
  const byOf = (actor: QueryActor): string => (actor.kind === 'owner' ? 'owner'
    : actor.ownerRequested === true ? 'owner-chat'
      : actor.kind === 'job' ? `job:${actor.jobId}` : 'main');

  /**
   * Whether the session's running statement is still the query being stopped: true, false, or null (could not be read). A
   * pooled session may run another call's statement by now: then this query has ended.
   */
  async function stillRuns(query: RunningQuery, sessionId: number): Promise<boolean | null> {
    const read = await fetchWarehouse(sessionId);
    if (!read.ok) return null;
    const run = read.runs.find(candidate => candidate.sessionId === sessionId);
    if (!run) return false;
    if (query.matchedBy === 'start_time') {
      // A query from before markers: the very statement listed (same start), and nothing BotBoy marked since.
      const listedAt = Date.parse(query.warehouse?.statementStartedAt ?? '');
      return run.owner === null && Number.isFinite(listedAt) && Math.abs(run.startedMs - listedAt) <= 1500;
    }
    if (run.owner === query.id) return true;
    if (run.owner === null && !read.historyOk) return null; // a FETCH whose cursor could not be attributed
    return false;
  }

  /** Polls after each wait; the last definite answer (false at once). */
  async function stillRunsAfter(query: RunningQuery, sessionId: number, waits: number[]): Promise<boolean | null> {
    let last: boolean | null = null;
    for (const wait of waits) {
      if (wait > 0) await sleep(wait);
      const runs = await stillRuns(query, sessionId);
      if (runs === false) return false;
      if (runs === true) last = true;
    }
    return last;
  }

  /** The warehouse session of a BotBoy call that BotBoy listed before the warehouse showed it. */
  async function sessionOfMarker(callId: string): Promise<{ ok: boolean; sessionId: number | null }> {
    if (!UUID.test(callId)) return { ok: true, sessionId: null };
    const found = await controlSql(`SELECT session_id FROM sys_query_history
      WHERE start_time > DATEADD(hour, -${LOOKBACK_HOURS}, GETDATE())
        AND (query_text LIKE '/* botboy:q=${callId.toLowerCase()}%' OR query_text LIKE 'DECLARE mcp_c CURSOR FOR /* botboy:q=${callId.toLowerCase()}%')
      ORDER BY start_time DESC LIMIT 1`);
    if (!found.ok) return { ok: false, sessionId: null };
    const id = found.rows.length ? Number(found.rows[0][0]) : NaN;
    return { ok: true, sessionId: Number.isInteger(id) && id > 0 ? id : null };
  }

  async function stopSql(query: RunningQuery, actor: QueryActor, reason: string | undefined): Promise<StopReceipt> {
    const by = byOf(actor);
    const steps: string[] = [];
    const earlier = query.matchedBy === 'start_time';
    const flight = earlier ? undefined : ledger.inFlightById(query.id);
    const exportId = query.where === 'background' ? query.exportId : undefined;
    // The stop's intent is recorded before anything is sent: whoever reads the ending next reports it as stopped on purpose.
    if (!earlier) ledger.markStopRequested(query.id, by, reason);
    if (flight) {
      flight.controller.abort(new QueryStoppedReason(by, stoppedWords(by, reason)));
      steps.push('Cancelled the call BotBoy was waiting on; the SQL connection then cancels the warehouse query.');
      for (let waited = 0; ledger.inFlightById(query.id) && waited < 8000; waited += 250) await sleep(250);
    } else if (exportId) {
      // A background export: the SQL connection cancels it (and the warehouse query under it); the warehouse is checked below.
      const cancel = await exportStatusRead(exportId, true, true);
      if (cancel.state === 'done' || cancel.state === 'failed') {
        ledger.clearStopRequest(query.id);
        return {
          ok: true, id: query.id, kind: 'sql', state: 'already_finished', what: query.label, verified: true,
          checkedAt: new Date(now()).toISOString(), steps: [`Export ${exportId} had already ended (${cancel.state}) before the stop.`],
        };
      }
      steps.push(cancel.state === 'cancelled'
        ? `Cancelled background export ${exportId} in the SQL connection; it cancels the warehouse query.`
        : cancel.state === 'unknown'
          ? `The SQL connection no longer tracks export ${exportId} (it restarted); BotBoy checks the warehouse for its query.`
          : `The SQL connection did not take the cancel of export ${exportId}${cancel.error ? `: ${cancel.error}` : ''}; BotBoy checks the warehouse for its query.`);
    }
    const stopped = (verified: boolean, nextAction?: string): StopReceipt => {
      if (!earlier) ledger.markStopped(query.id);
      return {
        ok: true, id: query.id, kind: 'sql', state: 'stopped', what: query.label, steps, verified,
        checkedAt: new Date(now()).toISOString(), ...(nextAction ? { nextAction } : {}),
      };
    };
    const unconfirmed = 'BotBoy could not read the warehouse to confirm it stopped; check Running queries again in a minute.';
    if (warehouseUnsupported) {
      return stopped(false, exportId
        ? 'This database does not show its running queries, so BotBoy could only cancel the export in the SQL connection.'
        : 'This database does not show its running queries, so BotBoy could only cancel its call; the call has ended.');
    }
    let sessionId = query.warehouse?.sessionId ?? null;
    if (sessionId === null) {
      const found = await sessionOfMarker(query.id);
      if (!found.ok) return stopped(false, unconfirmed);
      // The warehouse has no statement of this call: it never got there (it was waiting for a slot or connecting).
      if (found.sessionId === null) return stopped(true);
      sessionId = found.sessionId;
    }
    let runs = await stillRunsAfter(query, sessionId, flight || exportId ? [1000, 2000, 3000] : [0]);
    if (runs === true) {
      const ended = await controlSql(`SELECT pg_terminate_backend(${sessionId})`);
      steps.push(ended.ok ? `Ended warehouse session ${sessionId}.` : `Could not end warehouse session ${sessionId}: ${ended.error}`);
      runs = await stillRunsAfter(query, sessionId, [1000, 2000, 3000, 4000]);
    }
    if (runs === true) {
      // Not stopped: a call still waiting keeps its stop request (it ends as stopped); anything else forgets it.
      if (!earlier && !ledger.inFlightById(query.id)) ledger.clearStopRequest(query.id);
      return {
        ok: false, id: query.id, kind: 'sql', state: 'still_running', what: query.label, steps, verified: true,
        checkedAt: new Date(now()).toISOString(), code: 'stop_failed',
        error: `The warehouse still runs this query in session ${sessionId} after BotBoy asked it to stop.`,
        nextAction: 'Try once more in a minute. If it still runs, it may be stuck in the warehouse; the owner can ask the warehouse admins to end that session.',
      };
    }
    return stopped(runs === false, runs === null ? unconfirmed : undefined);
  }

  async function stopEtl(query: RunningQuery, actor: QueryActor, reason: string | undefined): Promise<StopReceipt> {
    const runId = query.runId!;
    if (!deps.etlCall) {
      return { ok: false, id: query.id, kind: 'etl', code: 'unavailable', error: 'The Datanet ETL connection is not available, so BotBoy cannot stop this run now.', nextAction: 'Check Connections → Datanet ETL, then try again.' };
    }
    const by = byOf(actor);
    ledger.markStopRequested(query.id, by, reason);
    const who = by === 'owner' ? 'the owner' : by === 'owner-chat' ? 'the owner, asked in chat' : by === 'main' ? 'the main chat' : 'the job that started it';
    const steps: string[] = [];
    // Datanet already ends this run (CANCELLING): a second kill is not sent; BotBoy only checks that it ends.
    if (isDatanetStopping(query.remoteStatus)) {
      steps.push(`Datanet was already cancelling run ${runId}; no second stop was sent.`);
    } else {
      let kill: { isError: boolean; text: string };
      try {
        kill = await deps.etlCall('datanet_alter_run', {
          run_id: runId,
          action: 'KILL_SESSION', // Datanet validates action names case-sensitively (tool-executor.ts › mcp_etl_alter_run)
          reason: `BotBoy: stopped by ${who}${reason ? `: ${reason}` : ''}`.slice(0, 256),
        }, { ownerApproved: true });
      } catch (error: any) {
        kill = { isError: true, text: firstLine(error?.message ?? error) };
      }
      if (kill.isError) {
        // Refused: perhaps it ended a moment ago. Its state says which; an ended run is reported as such, never as a failed stop.
        const after = (await etlStatus(runId, true, true)).status;
        if (after && ETL_TERMINAL_STATES.has(after)) return endedEtl(query, runId, after, [`Datanet did not take the stop (${firstLine(kill.text, 160)}): the run had already ended.`]);
        ledger.clearStopRequest(query.id);
        if (isDatanetSignInRefusal(kill.text)) {
          return {
            ok: false, id: query.id, kind: 'etl', code: 'stop_failed', what: query.label,
            error: `${DATANET_SIGN_IN_REFUSED}, so Datanet did not get the stop; run ${runId} keeps running.`,
            nextAction: `Ask the owner to ${DATANET_SIGN_IN_FIX}, then stop it once more.`,
          };
        }
        return {
          ok: false, id: query.id, kind: 'etl', code: 'stop_failed', what: query.label,
          error: `Datanet did not take the stop: ${firstLine(kill.text)}`,
          nextAction: `Check run ${runId} (mcp_etl_job_run), then try once more.`,
        };
      }
      steps.push(`Asked Datanet to kill run ${runId}.`);
    }
    // A killed run reads CANCELLING, then CANCELLED (datanet-run-states.ts).
    let status: string | null = null;
    let signIn = false;
    for (const wait of [2000, 3000, 5000, 5000]) {
      await sleep(wait);
      const read = await etlStatus(runId, true, true);
      status = read.status;
      signIn = read.signIn === true;
      if (status && ETL_TERMINAL_STATES.has(status)) break;
    }
    if (status && ETL_TERMINAL_STATES.has(status)) return endedEtl(query, runId, status, steps);
    const checkedAt = new Date(now()).toISOString();
    if (isDatanetStopping(status)) {
      // Taken and under way: the row stays open until Datanet says CANCELLED, which the list's next check records.
      return {
        ok: true, id: query.id, kind: 'etl', state: 'stopped', what: query.label, steps, verified: false, checkedAt,
        nextAction: `Datanet is cancelling run ${runId}; it leaves Running queries once Datanet finishes (usually within a few minutes).`,
      };
    }
    return {
      ok: true, id: query.id, kind: 'etl', state: 'still_running', what: query.label, steps, verified: false, checkedAt,
      nextAction: signIn
        ? `Datanet took the stop, then refused BotBoy's sign-in when it checked run ${runId} (Amazon device check or Midway expired), so whether it ended is not known. To fix it, ${DATANET_SIGN_IN_FIX}, then check Running queries again.`
        : `Datanet took the stop but still shows run ${runId} as ${status ?? 'unknown'}; check Running queries again in a minute.`,
    };
  }

  /** The receipt for a run Datanet reports ended: CANCELLED or DELETED is stopped, SUCCESS or ERROR had finished first. */
  function endedEtl(query: RunningQuery, runId: string, status: string, steps: string[]): StopReceipt {
    const checkedAt = new Date(now()).toISOString();
    ledger.endEtl(runId, status);
    if (isDatanetCancelled(status) || status === 'DELETED') {
      ledger.markStopped(query.id);
      return { ok: true, id: query.id, kind: 'etl', state: 'stopped', what: query.label, steps, verified: true, checkedAt };
    }
    ledger.clearStopRequest(query.id);
    return { ok: true, id: query.id, kind: 'etl', state: 'already_finished', what: query.label, steps: [...steps, `It had already ended ${status} before the stop took effect.`], verified: true, checkedAt };
  }

  /** The running query an id names: BotBoy's id, an ETL run id, or a warehouse session or statement id. */
  function resolve(queries: RunningQuery[], id: string): RunningQuery | null {
    const wanted = id.trim().toLowerCase();
    const direct = queries.find(query => query.id.toLowerCase() === wanted || query.exportId?.toLowerCase() === wanted);
    if (direct) return direct;
    if (/^\d+$/.test(wanted)) {
      return queries.find(query => query.runId === wanted)
        ?? queries.find(query => String(query.warehouse?.sessionId ?? '') === wanted || String(query.warehouse?.queryId ?? '') === wanted)
        ?? null;
    }
    return null;
  }

  async function stop(id: string, actor: QueryActor, reason?: string): Promise<StopReceipt> {
    const wanted = String(id ?? '').trim();
    const cleanReason = reason ? firstLine(reason, 200) : undefined;
    if (!wanted) return { ok: false, id: '', code: 'not_running', error: 'Say which query to stop (its id).', nextAction: 'Call cancel_query with action list to see the running queries and their ids.' };
    const { queries } = await list({ fresh: true });
    const query = resolve(queries, wanted);
    if (!query) {
      const row = ledger.get(wanted) ?? (/^\d+$/.test(wanted) ? ledger.forRun(wanted) : null);
      if (row && ((row.endedAt && row.endState !== 'lost') || settled.has(row.id))) {
        return { ok: true, id: row.id, kind: row.kind, state: 'already_finished', what: row.label ?? undefined, verified: true, checkedAt: new Date(now()).toISOString(), steps: [`It had already ended (${row.endState === 'lost' ? 'the warehouse no longer runs it' : row.endState ?? 'finished'}).`] };
      }
      return { ok: false, id: wanted, code: 'not_running', error: `No running BotBoy query has the id ${wanted}.`, nextAction: 'Call cancel_query with action list to see the running queries and their ids; a query that is not listed has already ended.' };
    }
    if (!mayStop(query, actor)) {
      const owner = query.origin === 'earlier'
        ? 'BotBoy sent it before it labelled its queries, so it cannot tell which conversation started it.'
        : `It was started by ${starterOf(query)}, not by this ${actor.kind === 'job' ? 'job' : 'conversation'}.`;
      return {
        ok: false, id: query.id, kind: query.kind, what: query.label, code: 'not_yours', error: owner,
        nextAction: actor.kind === 'job'
          ? 'Leave it. If it has to stop, say so in your reply: the owner can press Stop on it under Running queries in the chat panel.'
          : 'If the owner asked you to stop it, call cancel_query again with ownerRequested true; otherwise tell the owner they can press Stop on it under Running queries in the chat panel.',
      };
    }
    return query.kind === 'etl' ? stopEtl(query, actor, cleanReason) : stopSql(query, actor, cleanReason);
  }

  return { list, stop, mayStop, starterOf };
}
