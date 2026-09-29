import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { validateReadOnlySql } from './mcp-policy.js';
import type { McpManager } from './mcp-types.js';

/**
 * The Data Room SQL source: one complete, exact result from the managed
 * sql-context connector.
 *
 * `run_query` returns a page sized for model context, so a dataset cannot be
 * built from it. sql-context-presets-mcp 1.5 `export_query` streams the whole
 * result to a CSV file (RFC 4180; each value is the database's text, booleans
 * true/false, NULL an empty field) with a schema sidecar, in the connector's
 * export folder (SQL_EXPORT_DIR, inside the files workspace). BotBoy verifies
 * the file against the receipt and the exact SQL it sent, reads the bytes, and
 * deletes both files; the Data Room then types the CSV with the same reader
 * and cell grammar as local files and Datanet results. The model's own direct
 * exports stay where the connector wrote them.
 */

/** Same complete-source bounds as a local file or Datanet result. */
export const SQL_EXPORT_MAX_ROWS = 50_000;
export const SQL_EXPORT_MAX_BYTES = 32 * 1024 * 1024;
export const SQL_EXPORT_PRODUCER_VERSION = 'sql-context-export-csv-v1';

/** Idle window: every progress report from the connector restarts it, so it bounds silence, not work. */
const DEFAULT_IDLE_TIMEOUT_MS = 35 * 60_000;
const SHA256_RE = /^[a-f0-9]{64}$/;
const TRANSIENT_RE = /not connected|timeout|timed out|ECONN|EHOSTUNREACH|ENETUNREACH|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|connection (?:terminated|refused|reset|closed)|socket hang up/i;
/** The MCP client's own request deadline: after a full idle window the connector went silent. */
const REQUEST_TIMEOUT_RE = /request timed out/i;

export interface AnalyticsSqlExport {
  format: 'csv';
  bytes: Buffer;
  sha256: string;
  size: number;
  rowCount: number;
  columns: Array<{ name: string; type: string }>;
  /** SHA-256 of the exact SQL text the connector executed (from its sidecar). */
  sqlSha256: string;
  durationMs?: number;
}

export interface AnalyticsPreparationSqlRunner {
  exportComplete(sql: string, options?: { signal?: AbortSignal }): Promise<AnalyticsSqlExport>;
}

export type AnalyticsSqlExportErrorCode =
  | 'connector_outdated'
  | 'unavailable'
  | 'query_failed'
  | 'too_large'
  | 'integrity_failed';

/** An export failure that names its own recovery. Nothing was published. */
export class AnalyticsSqlExportError extends Error {
  constructor(
    readonly code: AnalyticsSqlExportErrorCode,
    message: string,
    readonly nextAction: string,
  ) {
    super(message);
    this.name = 'AnalyticsSqlExportError';
  }
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function integrity(message: string): never {
  throw new AnalyticsSqlExportError(
    'integrity_failed',
    message,
    'Nothing was published. Retry the create once; if it fails the same way, report the SQL connector receipt problem to the owner.',
  );
}

function unavailable(detail: string): AnalyticsSqlExportError {
  return new AnalyticsSqlExportError(
    'unavailable',
    `The SQL connection is unavailable: ${detail.slice(0, 500)}`,
    'Nothing was published. The warehouse is not reachable (check the VPN and Connections → SQL). Resume this exact job once the SQL connection tests healthy.',
  );
}

/** Real path when it exists, else the resolved path (a missing file is checked later). */
function realOrResolved(value: string): string {
  try {
    return fs.realpathSync(value);
  } catch {
    return path.resolve(value);
  }
}

function inside(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return !!relative && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

interface ExportReceipt {
  path: string;
  schemaPath: string;
  rowCount: number;
  bytes: number;
  truncated: boolean;
  columns: Array<{ name: string; type: string }>;
  durationMs?: number;
}

function isColumnList(value: unknown): value is Array<{ name: string; type: string }> {
  return Array.isArray(value) && value.every(column => column && typeof column === 'object'
    && typeof (column as { name?: unknown }).name === 'string'
    && typeof (column as { type?: unknown }).type === 'string');
}

/** The connector returns one JSON text block, plus a resource link on newer MCP protocols. */
function parseReceipt(text: string): ExportReceipt {
  const json = text.replace(/\n\n\[Resource: [^\n]*\][^\n]*$/, '').trim();
  let value: Record<string, unknown>;
  try {
    value = JSON.parse(json) as Record<string, unknown>;
  } catch {
    return integrity('The SQL connector returned an export receipt that is not JSON.');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.state !== 'done' || value.format !== 'csv'
    || typeof value.path !== 'string' || !path.isAbsolute(value.path)
    || typeof value.schemaPath !== 'string' || !path.isAbsolute(value.schemaPath)
    || !Number.isSafeInteger(value.rowCount) || (value.rowCount as number) < 0
    || !Number.isSafeInteger(value.bytes) || (value.bytes as number) < 0
    || typeof value.truncated !== 'boolean'
    || !isColumnList(value.columns)) {
    return integrity('The SQL connector export receipt is incomplete or malformed.');
  }
  return {
    path: value.path,
    schemaPath: value.schemaPath,
    rowCount: value.rowCount as number,
    bytes: value.bytes as number,
    truncated: value.truncated,
    columns: value.columns.map(column => ({ name: column.name, type: column.type })),
    ...(Number.isFinite(value.durationMs) ? { durationMs: Number(value.durationMs) } : {}),
  };
}

export function createSqlContextExportRunner(input: {
  mcpManager: Pick<McpManager, 'callTool'>;
  /** The connector's SQL_EXPORT_DIR; every export path must be inside it. */
  exportDir: string;
  /** Idle window for the export call (progress restarts it); no total cap. */
  timeoutMs?: number;
}): AnalyticsPreparationSqlRunner {
  const idleTimeoutMs = input.timeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;

  async function exportComplete(sqlValue: string, options: { signal?: AbortSignal } = {}): Promise<AnalyticsSqlExport> {
    // The policy re-validates; validating here first fixes the exact text
    // whose SHA-256 the connector's sidecar must report.
    const sql = validateReadOnlySql(sqlValue);
    let call: Awaited<ReturnType<McpManager['callTool']>>;
    try {
      call = await input.mcpManager.callTool('sql-context', 'export_query', {
        sql,
        format: 'csv',
        fileName: 'botboy-data-room',
        maxRows: SQL_EXPORT_MAX_ROWS,
        maxBytes: SQL_EXPORT_MAX_BYTES,
      }, {
        source: 'agent',
        timeoutMs: idleTimeoutMs,
        ...(options.signal ? { signal: options.signal } : {}),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/does not expose tool 'export_query'/.test(message)) {
        throw new AnalyticsSqlExportError(
          'connector_outdated',
          'The SQL connector cannot export a complete result: BotBoy needs sql-context-presets-mcp 1.5.0 or later.',
          'Nothing was published. Restart BotBoy with ./start.sh so the SQL connector updates itself from npm (or run npm install in the BotBoy folder). Until then, create this dataset with etl_query or from a local file.',
        );
      }
      if (REQUEST_TIMEOUT_RE.test(message)) {
        const minutes = Math.max(1, Math.round(idleTimeoutMs / 60_000));
        throw new AnalyticsSqlExportError(
          'unavailable',
          `The SQL connector reported no progress for ${minutes} minutes, so the export was cancelled.`,
          'Nothing was published. Check Connections → SQL; resume this exact job once the connector tests healthy. If it recurs for this query, aggregate or split it, or use etl_query.',
        );
      }
      if (TRANSIENT_RE.test(message)) throw unavailable(message);
      throw error;
    }
    if (call.isError) {
      const detail = call.text.trim().slice(0, 1500) || 'The connector returned no detail.';
      if (TRANSIENT_RE.test(detail)) throw unavailable(detail);
      throw new AnalyticsSqlExportError(
        'query_failed',
        `The SQL query failed in the warehouse: ${detail}`,
        'Nothing was published. Correct the SQL using the warehouse error above, then create again; the query is read-only, so re-running it is safe.',
      );
    }

    const receipt = parseReceipt(call.text);
    const root = realOrResolved(input.exportDir);
    const files = [receipt.path, receipt.schemaPath].map(realOrResolved);
    // Never read or delete a path outside this connector's export folder.
    if (!files.every(file => inside(file, root))) {
      return integrity('The SQL connector reported an export outside its export folder; the file was not read.');
    }
    try {
      if (receipt.truncated) {
        throw new AnalyticsSqlExportError(
          'too_large',
          `The query returns more than ${SQL_EXPORT_MAX_ROWS.toLocaleString('en-US')} rows or ${SQL_EXPORT_MAX_BYTES / (1024 * 1024)} MiB, the limit for one Data Room source.`,
          'Nothing was published. Aggregate or filter in SQL (for example GROUP BY day and the needed dimensions) or split it into several datasets, then create again; for larger raw data use etl_query.',
        );
      }
      const [dataPath, schemaPath] = files;
      const stat = fs.lstatSync(dataPath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== receipt.bytes) {
        return integrity('The SQL export file does not match its receipt.');
      }
      const bytes = fs.readFileSync(dataPath);
      let sidecar: Record<string, unknown>;
      try {
        sidecar = JSON.parse(fs.readFileSync(schemaPath, 'utf8')) as Record<string, unknown>;
      } catch {
        return integrity('The SQL export schema file is missing or not JSON.');
      }
      const receiptNames = receipt.columns.map(column => column.name);
      if (bytes.length !== receipt.bytes
        || sidecar.format !== 'csv'
        || sidecar.truncated !== false
        || sidecar.rowCount !== receipt.rowCount
        || sidecar.bytes !== bytes.length
        || typeof sidecar.sqlSha256 !== 'string' || !SHA256_RE.test(sidecar.sqlSha256)
        || !isColumnList(sidecar.columns)
        || sidecar.columns.map(column => column.name).join('\0') !== receiptNames.join('\0')) {
        return integrity('The SQL export schema file differs from the export receipt.');
      }
      if (sidecar.sqlSha256 !== sha256(sql)) {
        return integrity('The SQL export was produced by a different query than the one BotBoy sent.');
      }
      return {
        format: 'csv',
        bytes,
        sha256: sha256(bytes),
        size: bytes.length,
        rowCount: receipt.rowCount,
        columns: sidecar.columns.map(column => ({ name: column.name, type: column.type })),
        sqlSha256: sidecar.sqlSha256,
        ...(receipt.durationMs !== undefined ? { durationMs: receipt.durationMs } : {}),
      };
    } finally {
      // The version keeps the verified bytes; this export's files are temporary.
      for (const file of files) {
        try {
          const stat = fs.lstatSync(file);
          if (stat.isFile() && !stat.isSymbolicLink()) fs.rmSync(file, { force: true });
        } catch {
          // already gone
        }
      }
    }
  }

  return { exportComplete };
}
