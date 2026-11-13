/**
 * BotBoy's own warehouse queries (docs/maps/query-control.md; owner request 2026-11-12): every SQL call it sends through the
 * managed SQL connection (run_query, export_query) and every Datanet ETL run it submits, with who started it. A job or the main
 * chat stops what it started (cancel_query); the owner stops anything BotBoy has running (the chat panel's Running queries).
 *
 * The incident behind it: job #5's overlap query lost its client when the network dropped (BotBoy's call failed with "Could not
 * reach the database server" after 2 h 50 min), yet kept running on the warehouse for 9 more hours. Nothing in BotBoy could stop
 * it, and the job asked the owner to stop it "through approved warehouse controls" he does not have.
 *
 * Two parts, one record:
 *   - the `query_ledger` table: one row per query, kept across restarts, so a query whose client is gone (a lost connection, a
 *     restart) can still be attributed and stopped;
 *   - the in-flight map: the AbortController of every SQL call this process is waiting on, so stopping one cancels the call itself
 *     (sql-context then cancels the warehouse query).
 * Every SQL BotBoy sends starts with SQL_MARKER (`/* botboy:q=<call id> *\/`), so the warehouse's own query history names the call.
 *
 * A background export (export_query with wait:false, docs/maps/job-waits.md) returns at once while its query runs on in the SQL
 * connection: its row stays open as `background`, with the export's id, until an export_status answer says it ended (the
 * manager notes every one), so query control lists and stops it like any other query.
 */
import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { NETWORK_FAILURE_WORDS } from './capture-health.js';

export type QueryKind = 'sql' | 'etl';
/** Who started a query: the main chat, a job, or a BotBoy subsystem. */
export type QueryOriginKind = 'main' | 'job' | 'dashboard' | 'data_room' | 'dictionary' | 'botboy';
export interface QueryOrigin {
  kind: QueryOriginKind;
  /** The job that owns it (origin `job`). */
  jobId?: string;
  /** A few owner-facing words: `Dashboard widget "Weekly streams"`, `Data Room dataset`. */
  label?: string;
}

/**
 * How a SQL call ended in BotBoy. `lost`: its connection broke, so the warehouse may still be running it. A background export's
 * row reads `background` (not ended) until its export ends (docs/maps/job-waits.md).
 */
export type SqlEndState = 'completed' | 'failed' | 'lost' | 'cancelled' | 'stopped';

export interface QueryRecord {
  /** sql: the MCP call id (the marker's id); etl: `etl:<runId>`. */
  id: string;
  kind: QueryKind;
  origin: QueryOriginKind;
  jobId: string | null;
  label: string | null;
  /** The first 300 characters of the SQL, whitespace folded. */
  preview: string | null;
  serverId: string | null;
  toolName: string | null;
  runId: string | null;
  /** A background export (export_query with wait:false): its export id. Its row stays open (end state `background`) until it ends. */
  exportId: string | null;
  startedAt: string;
  endedAt: string | null;
  endState: string | null;
  endNote: string | null;
  /** The BotBoy process that started it (QueryLedger.bootId). */
  bootId: string;
  /** Who stopped it through query control: `owner` (his panel), `owner-chat` (his ask in chat), `job:<id>`, `main`. */
  stoppedBy: string | null;
}

export interface InFlightQuery {
  id: string;
  toolName: string;
  origin: QueryOriginKind;
  jobId: string | null;
  label: string | null;
  preview: string;
  startedAt: string;
  controller: AbortController;
}

/** The abort reason of a call query control stopped; its message is what the caller (a dashboard, a chat turn) reports. */
export class QueryStoppedReason extends Error {
  constructor(readonly by: string, message: string) {
    super(message);
    this.name = 'QueryStoppedReason';
  }
}

/** The comment every SQL BotBoy sends starts with. The warehouse keeps it in its query history (Redshift `sys_query_history`). */
export const SQL_MARKER_PREFIX = '/* botboy:q=';
const MARKER_ID = /botboy:q=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

/** The SQL as BotBoy sends it: the marker first, so it is inside the first 4,000 characters the history keeps. */
export function markSql(callId: string, sql: string): string {
  return `${SQL_MARKER_PREFIX}${callId} */ ${sql}`;
}
/** The call id a statement's text carries, or null. */
export function markerOf(text: unknown): string | null {
  const match = MARKER_ID.exec(String(text ?? ''));
  return match ? match[1].toLowerCase() : null;
}

/**
 * The comment query control's own lookups and stops start with (query-control.ts): they run on the same pooled sessions as
 * BotBoy's queries, so a lookup that is running while the warehouse is read is told apart from the query a session ran before it.
 */
export const SQL_CONTROL_MARKER = '/* botboy:control */';
export function markControlSql(sql: string): string {
  return `${SQL_CONTROL_MARKER} ${sql}`;
}
export function isControlSql(text: unknown): boolean {
  return /\/\*\s*botboy:control\s*\*\//i.test(String(text ?? ''));
}

/**
 * A failure that broke the connection rather than the query: the warehouse may still be running it (the incident above). The
 * connection words are capture health's network words plus the SQL connector's own.
 */
export function isConnectionLost(message: unknown): boolean {
  const text = String(message ?? '');
  return NETWORK_FAILURE_WORDS.test(text)
    || /could not reach the database server|connection terminated|connection (?:ended|closed|reset)|server closed the connection|terminating connection|lost the (?:database )?connection/i.test(text);
}

/** Datanet run states that end a run. */
export const ETL_TERMINAL_STATES = new Set(['SUCCESS', 'ERROR', 'KILLED', 'DELETED']);

/** An export's status as sql-context's export_status (or a background export_query) answers it. */
export interface SqlExportStatus {
  exportId: string;
  state: string;
  rowsWritten?: number;
  bytesWritten?: number;
  queuePosition?: number;
  path?: string;
  rowCount?: number;
  bytes?: number;
  truncated?: boolean;
  columns?: Array<{ name: string }>;
  error?: string;
  errorType?: string;
}

/** Parses an export_status (or export_query) answer: the JSON object, with any resource links after it. Null when unreadable. */
export function parseSqlExportStatus(text: unknown): SqlExportStatus | null {
  const raw = String(text ?? '');
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const value = JSON.parse(raw.slice(start, end + 1));
    if (!value || typeof value.exportId !== 'string' || typeof value.state !== 'string') return null;
    return value as SqlExportStatus;
  } catch {
    return null;
  }
}

/** export_status's error for an export the SQL connection no longer tracks (it restarted since the export began). */
export function isUnknownExport(text: unknown): boolean {
  return /export \S+ is unknown/i.test(String(text ?? ''));
}

/** An export_query answer that started a background export (wait:false): its id while it is queued or running. */
export function backgroundExportOf(text: unknown): string | null {
  const status = parseSqlExportStatus(text);
  return status && (status.state === 'queued' || status.state === 'running') ? status.exportId : null;
}

const TRACKED_SQL_TOOLS = new Set(['run_query', 'export_query']);
/** The SQL connection's tools whose SQL BotBoy marks and tracks. */
export function isTrackedSqlTool(toolName: string): boolean {
  return TRACKED_SQL_TOOLS.has(toolName);
}

/** How long rows are kept: long enough to attribute any warehouse query still running. */
const RETENTION_DAYS = 14;

export interface QueryLedger {
  /** This BotBoy process. */
  readonly bootId: string;
  /** When this process's ledger started (ms). */
  readonly startedAtMs: number;
  beginSql(input: { callId: string; serverId: string; toolName: string; origin: QueryOrigin; sql: string; controller: AbortController }): void;
  endSql(callId: string, state: SqlEndState, note?: string): void;
  /**
   * The call was an export_query with wait:false: it returned at once, but its export (and the warehouse query under it) runs on
   * in the SQL connection. The row stays open as `background` with the export's id until the export ends (noteExportStatus).
   */
  holdForExport(callId: string, exportId: string): void;
  /** What an export_status answer says about a background export: a terminal state (or an unknown export) ends its row. */
  noteExportStatus(exportId: string, answer: { isError: boolean; text: string }): void;
  /** The row of a background export, by its export id. */
  forExport(exportId: string): QueryRecord | null;
  /** Background exports started since `sinceIso` that have not ended. */
  openExports(sinceIso: string): QueryRecord[];
  /** `startedAt`: a run recorded after the fact (an ETL run from before the ledger), at its own submission time. */
  beginEtl(input: { runId: string; origin?: QueryOrigin; sql?: string; label?: string; startedAt?: string }): void;
  /** A Datanet run reached a terminal state (any reader that saw it says so). */
  endEtl(runId: string, remoteStatus: string, note?: string): void;
  inFlight(): InFlightQuery[];
  inFlightById(id: string): InFlightQuery | undefined;
  get(id: string): QueryRecord | null;
  forRun(runId: string): QueryRecord | null;
  /** Rows started since `sinceIso` that may still run: not ended, or ended `lost`. */
  openSince(sinceIso: string): QueryRecord[];
  /**
   * SQL calls the warehouse may still run although BotBoy no longer waits on them: started since `sinceIso` and lost or never
   * ended (an earlier BotBoy process), or ended `failed`/`cancelled` since `recentSinceIso` (a timeout or an abort whose cancel
   * the connector may not have managed). In-flight calls are the caller's to leave out.
   */
  sqlSuspects(sinceIso: string, recentSinceIso: string): QueryRecord[];
  /**
   * Query control is about to stop it: who and why, recorded BEFORE the stop is sent, so a reader that sees the run KILLED a
   * moment later already reports it as stopped on purpose.
   */
  markStopRequested(id: string, by: string, reason?: string): void;
  /** The stop could not be sent: the query is not marked stopped. */
  clearStopRequest(id: string): void;
  /** The stop was confirmed: the query no longer runs. */
  markStopped(id: string): void;
  /** For a run query control stopped: the words its reader reports instead of the bare KILLED status. */
  stoppedMessage(runId: string): string | null;
  /** For a background export query control stopped: the words its reader reports instead of a bare "cancelled". */
  exportStoppedMessage(exportId: string): string | null;
}

const ledgers = new WeakMap<Database.Database, QueryLedger>();
/** The ledger of this database, when BotBoy made one (index.ts). Tests and tools without one record nothing. */
export function getQueryLedger(db: Database.Database | null | undefined): QueryLedger | null {
  return db ? ledgers.get(db) ?? null : null;
}

const fold = (text: unknown, max: number): string => String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

export function createQueryLedger(db: Database.Database, options: { now?: () => number } = {}): QueryLedger {
  const now = options.now ?? Date.now;
  const iso = () => new Date(now()).toISOString();
  db.exec(`
    CREATE TABLE IF NOT EXISTS query_ledger (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK(kind IN ('sql','etl')),
      origin TEXT NOT NULL,
      job_id TEXT,
      label TEXT,
      preview TEXT,
      server_id TEXT,
      tool_name TEXT,
      run_id TEXT,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      end_state TEXT,
      end_note TEXT,
      boot_id TEXT NOT NULL,
      stopped_by TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_query_ledger_started ON query_ledger(started_at);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_query_ledger_run ON query_ledger(run_id) WHERE run_id IS NOT NULL;
  `);
  // Background exports (2026-11-12, docs/maps/job-waits.md) join ledgers made before them.
  const ledgerColumns = new Set((db.prepare('PRAGMA table_info(query_ledger)').all() as Array<{ name: string }>).map(column => column.name));
  if (!ledgerColumns.has('export_id')) db.exec('ALTER TABLE query_ledger ADD COLUMN export_id TEXT');
  db.exec('CREATE INDEX IF NOT EXISTS idx_query_ledger_export ON query_ledger(export_id) WHERE export_id IS NOT NULL');
  try {
    db.prepare("DELETE FROM query_ledger WHERE started_at < ?").run(new Date(now() - RETENTION_DAYS * 86_400_000).toISOString());
  } catch (error: any) {
    console.warn(`[QueryLedger] could not prune old rows: ${error?.message ?? error}`);
  }
  const bootId = randomUUID();
  const startedAtMs = now();
  const flights = new Map<string, InFlightQuery>();

  const rowOf = (row: any): QueryRecord => ({
    id: row.id,
    kind: row.kind,
    origin: row.origin,
    jobId: row.job_id ?? null,
    label: row.label ?? null,
    preview: row.preview ?? null,
    serverId: row.server_id ?? null,
    toolName: row.tool_name ?? null,
    runId: row.run_id ?? null,
    exportId: row.export_id ?? null,
    startedAt: row.started_at,
    endedAt: row.ended_at ?? null,
    endState: row.end_state ?? null,
    endNote: row.end_note ?? null,
    bootId: row.boot_id,
    stoppedBy: row.stopped_by ?? null,
  });
  /** Recording never breaks the call it records: a failed write is a log line. */
  const safely = (what: string, run: () => void): void => {
    try {
      run();
    } catch (error: any) {
      console.warn(`[QueryLedger] could not record ${what}: ${error?.message ?? error}`);
    }
  };
  const originOf = (origin: QueryOrigin | undefined) => ({
    kind: origin?.kind ?? 'botboy',
    jobId: origin?.jobId ? String(origin.jobId) : null,
    label: origin?.label ? fold(origin.label, 160) : null,
  });

  const ledger: QueryLedger = {
    bootId,
    startedAtMs,
    beginSql(input) {
      const origin = originOf(input.origin);
      const startedAt = iso();
      const preview = fold(input.sql, 300);
      flights.set(input.callId, {
        id: input.callId, toolName: input.toolName, origin: origin.kind, jobId: origin.jobId, label: origin.label, preview, startedAt,
        controller: input.controller,
      });
      safely('a SQL call', () => db.prepare(`INSERT OR IGNORE INTO query_ledger
          (id, kind, origin, job_id, label, preview, server_id, tool_name, started_at, boot_id)
        VALUES (?, 'sql', ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(input.callId, origin.kind, origin.jobId, origin.label, preview, input.serverId, input.toolName, startedAt, bootId));
    },
    endSql(callId, state, note) {
      flights.delete(callId);
      safely('the end of a SQL call', () => db.prepare(`UPDATE query_ledger SET ended_at = COALESCE(ended_at, ?),
          end_state = CASE WHEN end_state = 'stopped' THEN end_state ELSE ? END, end_note = COALESCE(end_note, ?)
        WHERE id = ? AND kind = 'sql'`)
        .run(iso(), state, note ? fold(note, 300) : null, callId));
    },
    holdForExport(callId, exportId) {
      flights.delete(callId);
      safely('a background export', () => db.prepare(`UPDATE query_ledger SET export_id = ?, ended_at = NULL, end_state = 'background'
        WHERE id = ? AND kind = 'sql'`).run(String(exportId), callId));
    },
    noteExportStatus(exportId, answer) {
      const id = String(exportId ?? '').trim();
      if (!id) return;
      let state: SqlEndState | null = null;
      let note: string | undefined;
      if (answer.isError) {
        if (isUnknownExport(answer.text)) {
          // The connection restarted, so its export (not its warehouse query, perhaps) is gone: the warehouse may still run it.
          state = 'lost';
          note = 'The SQL connection restarted and no longer tracks this export.';
        }
      } else {
        const status = parseSqlExportStatus(answer.text);
        if (status?.state === 'done') state = 'completed';
        else if (status?.state === 'failed') { state = 'failed'; note = status.error; }
        else if (status?.state === 'cancelled') { state = 'cancelled'; note = status.error; }
      }
      if (!state) return;
      safely('the end of a background export', () => db.prepare(`UPDATE query_ledger SET ended_at = ?, end_state = ?,
          end_note = COALESCE(end_note, ?) WHERE export_id = ? AND kind = 'sql' AND end_state = 'background'`)
        .run(iso(), state, note ? fold(note, 300) : null, id));
    },
    forExport(exportId) {
      const row = db.prepare("SELECT * FROM query_ledger WHERE export_id = ? AND kind = 'sql' ORDER BY started_at DESC LIMIT 1").get(String(exportId));
      return row ? rowOf(row) : null;
    },
    openExports(sinceIso) {
      return (db.prepare(`SELECT * FROM query_ledger WHERE kind = 'sql' AND end_state = 'background' AND export_id IS NOT NULL
        AND started_at >= ? ORDER BY started_at`).all(sinceIso) as any[]).map(rowOf);
    },
    beginEtl(input) {
      const runId = String(input.runId ?? '').trim();
      if (!/^\d+$/.test(runId)) return;
      const origin = originOf(input.origin);
      safely('an ETL run', () => db.prepare(`INSERT OR IGNORE INTO query_ledger
          (id, kind, origin, job_id, label, preview, server_id, tool_name, run_id, started_at, boot_id)
        VALUES (?, 'etl', ?, ?, ?, ?, 'a2-analytics', 'datanet_submit_run', ?, ?, ?)`)
        .run(`etl:${runId}`, origin.kind, origin.jobId, input.label ? fold(input.label, 160) : origin.label,
          input.sql ? fold(input.sql.replace(/^\s*\/\*\s*NO DEPENDENCIES\s*\*\/\s*/i, ''), 300) : null, runId,
          input.startedAt && Number.isFinite(Date.parse(input.startedAt)) ? new Date(Date.parse(input.startedAt)).toISOString() : iso(), bootId));
    },
    endEtl(runId, remoteStatus, note) {
      const status = String(remoteStatus ?? '').toUpperCase();
      if (!ETL_TERMINAL_STATES.has(status)) return;
      safely('the end of an ETL run', () => db.prepare(`UPDATE query_ledger SET ended_at = COALESCE(ended_at, ?),
          end_state = CASE WHEN end_state = 'stopped' THEN end_state ELSE ? END, end_note = COALESCE(end_note, ?)
        WHERE run_id = ? AND kind = 'etl'`)
        .run(iso(), status.toLowerCase(), note ? fold(note, 300) : null, String(runId)));
    },
    inFlight: () => [...flights.values()],
    inFlightById: (id) => flights.get(id),
    get(id) {
      const row = db.prepare('SELECT * FROM query_ledger WHERE id = ?').get(String(id));
      return row ? rowOf(row) : null;
    },
    forRun(runId) {
      const row = db.prepare("SELECT * FROM query_ledger WHERE run_id = ? AND kind = 'etl'").get(String(runId));
      return row ? rowOf(row) : null;
    },
    openSince(sinceIso) {
      return (db.prepare(`SELECT * FROM query_ledger WHERE started_at >= ? AND (ended_at IS NULL OR end_state = 'lost')
        ORDER BY started_at`).all(sinceIso) as any[]).map(rowOf);
    },
    sqlSuspects(sinceIso, recentSinceIso) {
      // A background export is not a suspect while its export runs: the SQL connection still has it (query control reads its
      // status instead). Once the connection loses it (`lost`), the warehouse may still run its query, and it is one again.
      return (db.prepare(`SELECT * FROM query_ledger WHERE kind = 'sql' AND COALESCE(end_state, '') <> 'background' AND (
          (started_at >= ? AND (ended_at IS NULL OR end_state = 'lost'))
          OR (ended_at >= ? AND end_state IN ('failed', 'cancelled')))
        ORDER BY started_at`).all(sinceIso, recentSinceIso) as any[]).map(rowOf);
    },
    markStopRequested(id, by, reason) {
      safely('a stop request', () => db.prepare('UPDATE query_ledger SET stopped_by = ?, end_note = ? WHERE id = ?')
        .run(by, reason ? fold(reason, 300) : null, id));
    },
    clearStopRequest(id) {
      safely('a failed stop', () => db.prepare("UPDATE query_ledger SET stopped_by = NULL, end_note = NULL WHERE id = ? AND COALESCE(end_state, '') <> 'stopped'")
        .run(id));
    },
    markStopped(id) {
      safely('a stop', () => db.prepare("UPDATE query_ledger SET end_state = 'stopped', ended_at = ? WHERE id = ?").run(iso(), id));
    },
    stoppedMessage(runId) {
      const row = ledger.forRun(runId);
      return row?.stoppedBy ? stoppedWords(row.stoppedBy, row.endNote) : null;
    },
    exportStoppedMessage(exportId) {
      const row = ledger.forExport(exportId);
      return row?.stoppedBy ? stoppedWords(row.stoppedBy, row.endNote) : null;
    },
  };
  ledgers.set(db, ledger);
  return ledger;
}

/**
 * What the reader of a stopped query is told. "Do not resubmit" is load-bearing: a dashboard never retries a failure that says
 * it (analytics-runners.ts › isCrossLaneRetryableFailure), and a model reads it as the instruction it is.
 */
export function stoppedWords(by: string, note?: string | null): string {
  const who = by === 'owner' ? 'the owner (Running queries in the chat panel)'
    : by === 'owner-chat' ? 'the owner, who asked for it in chat'
      : by.startsWith('job:') ? 'the job that started it'
      : by === 'main' ? 'the main chat that started it'
        : 'BotBoy';
  // The reason is the stopper's own words: it ends with a full stop, so the next sentence reads as one.
  const reason = note ? ` Reason: ${fold(note, 200).replace(/([^.!?])$/, '$1.')}` : '';
  return `Stopped on purpose by ${who}.${reason} Do not resubmit it; ask the owner before running it again.`;
}
