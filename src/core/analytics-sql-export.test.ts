import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AnalyticsSqlExportError,
  createSqlContextExportRunner,
  SQL_EXPORT_MAX_BYTES,
  SQL_EXPORT_MAX_ROWS,
} from './analytics-sql-export.js';
import { parseSqlMcpResult } from './analytics-dashboard.js';
import { sqlEnvironment } from './mcp-manager.js';
import { DEFAULT_SQL_CONTEXT_CONFIG, sqlContextExportDir } from './mcp-profiles.js';

const directories: string[] = [];
afterEach(() => {
  while (directories.length) fs.rmSync(directories.pop()!, { recursive: true, force: true });
});

function tempDir(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sql-export-'));
  directories.push(directory);
  return directory;
}

const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

// Exactly what sql-context-presets-mcp 1.5.0 writes for export_query format "csv"
// (probed from its published FileRowWriter): database text, NULL as an empty field.
const CSV = 'event_date,label,total,hours\n2026-09-05,"a | b, ""quoted""",5,\n2026-09-06,NULL,6,3.5\n';
const COLUMNS = [
  { name: 'event_date', type: 'date' },
  { name: 'label', type: 'text' },
  { name: 'total', type: 'int4' },
  { name: 'hours', type: 'float8' },
];

/** A connector that writes one export into its per-process folder, as 1.5 does. */
function fakeConnector(exportDir: string, overrides: {
  csv?: string;
  truncated?: boolean;
  sidecar?: Record<string, unknown>;
  receipt?: Record<string, unknown>;
  resourceLink?: boolean;
} = {}) {
  const calls: Array<{ tool: string; args: Record<string, unknown>; options?: Record<string, unknown> }> = [];
  const written: string[] = [];
  const callTool = vi.fn(async (_server: string, tool: string, args: Record<string, unknown>, options?: Record<string, unknown>) => {
    calls.push({ tool, args, options });
    const folder = path.join(exportDir, `${process.pid}-1700000000000`, 'exports');
    fs.mkdirSync(folder, { recursive: true });
    const file = path.join(folder, 'botboy-data-room-20260928T101500.csv');
    const csv = overrides.csv ?? CSV;
    fs.writeFileSync(file, csv);
    const rowCount = csv.split('\n').filter(Boolean).length - 1;
    const schemaPath = `${file}.schema.json`;
    fs.writeFileSync(schemaPath, JSON.stringify({
      columns: COLUMNS.map((column, oid) => ({ ...column, oid })),
      rowCount,
      bytes: Buffer.byteLength(csv),
      format: 'csv',
      truncated: overrides.truncated ?? false,
      createdAt: '2026-09-28T10:15:00.000Z',
      sqlSha256: sha256(String(args.sql)),
      ...overrides.sidecar,
    }, null, 2));
    written.push(file, schemaPath);
    const receipt = {
      exportId: 'e_abcdefghijklmnop', state: 'done', path: file, schemaPath, format: 'csv',
      rowCount, bytes: Buffer.byteLength(csv), truncated: overrides.truncated ?? false, durationMs: 42,
      columns: COLUMNS, preview: [], ...overrides.receipt,
    };
    const text = JSON.stringify(receipt, null, 2);
    return {
      serverId: 'sql-context', toolName: tool, isError: false, durationMs: 42,
      text: overrides.resourceLink === false ? text : `${text}\n\n[Resource: ${path.basename(file)}] file://${file}`,
    };
  });
  return { mcpManager: { callTool }, calls, written, callTool };
}

describe('sql-context export runner (Data Room SQL source)', () => {
  it('exports the complete result, verifies it against the exact SQL, and removes the connector copies', async () => {
    const exportDir = tempDir();
    const connector = fakeConnector(exportDir);
    const runner = createSqlContextExportRunner({ mcpManager: connector.mcpManager, exportDir });

    const exported = await runner.exportComplete('  SELECT event_date, label, total, hours FROM events  ');

    expect(connector.calls).toEqual([{
      tool: 'export_query',
      args: {
        sql: 'SELECT event_date, label, total, hours FROM events', format: 'csv', fileName: 'botboy-data-room',
        maxRows: SQL_EXPORT_MAX_ROWS, maxBytes: SQL_EXPORT_MAX_BYTES,
      },
      // An idle window (progress restarts it), never a cap on the export.
      options: { source: 'agent', timeoutMs: 35 * 60_000 },
    }]);
    expect(exported).toMatchObject({
      format: 'csv', size: Buffer.byteLength(CSV), sha256: sha256(CSV), rowCount: 2, columns: COLUMNS,
      sqlSha256: sha256('SELECT event_date, label, total, hours FROM events'), durationMs: 42,
    });
    expect(exported.bytes.toString('utf8')).toBe(CSV);
    for (const file of connector.written) expect(fs.existsSync(file)).toBe(false);
  });

  it('accepts a receipt without a resource link (older MCP protocol)', async () => {
    const exportDir = tempDir();
    const connector = fakeConnector(exportDir, { resourceLink: false });
    const runner = createSqlContextExportRunner({ mcpManager: connector.mcpManager, exportDir });
    await expect(runner.exportComplete('SELECT 1 AS x')).resolves.toMatchObject({ rowCount: 2 });
  });

  it('rejects write SQL before calling the connector', async () => {
    const connector = fakeConnector(tempDir());
    const runner = createSqlContextExportRunner({ mcpManager: connector.mcpManager, exportDir: tempDir() });
    await expect(runner.exportComplete('DELETE FROM events')).rejects.toThrow(/read-only/);
    await expect(runner.exportComplete('SELECT 1; SELECT 2')).rejects.toThrow(/Multiple SQL statements/);
    expect(connector.callTool).not.toHaveBeenCalled();
  });

  it('fails over-limit results as too_large and still removes the partial export', async () => {
    const exportDir = tempDir();
    const connector = fakeConnector(exportDir, { truncated: true });
    const runner = createSqlContextExportRunner({ mcpManager: connector.mcpManager, exportDir });
    const failure = await runner.exportComplete('SELECT * FROM events').catch(error => error);
    expect(failure).toBeInstanceOf(AnalyticsSqlExportError);
    expect(failure).toMatchObject({ code: 'too_large' });
    expect(failure.message).toContain('more than 50,000 rows or 32 MiB');
    expect(failure.nextAction).toContain('etl_query');
    for (const file of connector.written) expect(fs.existsSync(file)).toBe(false);
  });

  it.each([
    ['a different query hash', { sidecar: { sqlSha256: 'f'.repeat(64) } }, /different query/],
    ['a byte count that differs', { receipt: { bytes: 5 } }, /does not match its receipt/],
    ['a sidecar row count that differs', { sidecar: { rowCount: 99 } }, /differs from the export receipt/],
    ['a receipt that is not finished', { receipt: { state: 'running' } }, /incomplete or malformed/],
  ])('fails closed on %s', async (_label, overrides, message) => {
    const exportDir = tempDir();
    const connector = fakeConnector(exportDir, overrides);
    const runner = createSqlContextExportRunner({ mcpManager: connector.mcpManager, exportDir });
    const failure = await runner.exportComplete('SELECT 1 AS x').catch(error => error);
    expect(failure).toMatchObject({ code: 'integrity_failed' });
    expect(failure.message).toMatch(message);
  });

  it('never reads or deletes a reported path outside the export folder', async () => {
    const exportDir = tempDir();
    const elsewhere = path.join(tempDir(), 'owner-file.csv');
    fs.writeFileSync(elsewhere, CSV);
    const connector = fakeConnector(exportDir, { receipt: { path: elsewhere } });
    const runner = createSqlContextExportRunner({ mcpManager: connector.mcpManager, exportDir });
    const failure = await runner.exportComplete('SELECT 1 AS x').catch(error => error);
    expect(failure).toMatchObject({ code: 'integrity_failed' });
    expect(failure.message).toContain('outside its export folder');
    expect(fs.readFileSync(elsewhere, 'utf8')).toBe(CSV);
  });

  it.each([
    ['a 1.4 connector without export_query', () => { throw new Error("MCP server 'sql-context' does not expose tool 'export_query'"); }, 'connector_outdated', /npm install/],
    ['an unreachable warehouse', () => ({ isError: true, text: 'Not connected: connect ETIMEDOUT 10.253.33.116:5439' }), 'unavailable', /VPN/],
    ['a warehouse SQL error', () => ({ isError: true, text: 'column "totl" does not exist' }), 'query_failed', /Correct the SQL/],
    // Progress restarts the idle window, so this means the connector went silent.
    ['a connector silent for a whole idle window', () => { throw new Error('MCP error -32001: Request timed out'); }, 'unavailable', /Connections → SQL/],
  ])('names the next action for %s', async (_label, behavior, code, nextAction) => {
    const callTool = vi.fn(async () => ({ serverId: 'sql-context', toolName: 'export_query', durationMs: 1, ...behavior() }));
    const runner = createSqlContextExportRunner({ mcpManager: { callTool } as never, exportDir: tempDir() });
    const failure = await runner.exportComplete('SELECT 1 AS x').catch(error => error);
    expect(failure).toBeInstanceOf(AnalyticsSqlExportError);
    expect(failure.code).toBe(code);
    expect(failure.nextAction).toMatch(nextAction);
    expect(failure.nextAction).toContain('Nothing was published');
  });
});

describe('sql-context child settings', () => {
  // Exports land where the shell, local_file, and /api/files can use them;
  // paging and export limits are the connector's own defaults.
  it('points exports into the files workspace and leaves paging to the connector', () => {
    const env = sqlEnvironment({ ...DEFAULT_SQL_CONTEXT_CONFIG, host: 'warehouse.example', database: 'db', username: 'u' }, 'secret');
    expect(sqlContextExportDir('/home/owner')).toBe('/home/owner/.personal-productivity-tracker/files/sql-exports');
    expect(env).toMatchObject({ SQL_EXPORT_DIR: sqlContextExportDir(), SQL_HOST: 'warehouse.example' });
    for (const key of ['SQL_MAX_OPEN_CURSORS', 'SQL_SPOOL_MAX_TOTAL_BYTES', 'SQL_SPOOL_THRESHOLD_BYTES', 'SQL_EXPORT_MAX_ROWS', 'SQL_EXPORT_MAX_BYTES']) {
      expect(env[key], key).toBeUndefined();
    }
  });
});

// The dashboard SQL lane still reads the table format. These are 1.5.0's exact
// renderings (probed from its published PageBuilder).
describe('run_query table output from sql-context 1.5', () => {
  const header = 'label | total\n------+------';
  it('reads the exact total now that the footer counts Redshift rows', () => {
    const parsed = parseSqlMcpResult([
      header, 'a     | 1', 'b     | 2', '... (198 more rows)', '',
      'More rows exist, but this result is too large to page. Use export_query or narrow the query.',
      '200 rows returned. (42ms)',
    ].join('\n'));
    expect(parsed).toMatchObject({ columns: ['label', 'total'], rows: [['a', 1], ['b', 2]], rowCount: 200, displayedRowCount: 2, executionTimeMs: 42 });
  });

  it('reads the exact total when paging is available', () => {
    const parsed = parseSqlMcpResult([
      header, 'a     | 1', 'b     | 2', '... (198 more rows)', '',
      'More rows: fetch_rows {"resultId":"r_abcdefghijklmnop"}; full result: export_query',
      '200 rows returned. (42ms)',
    ].join('\n'));
    expect(parsed).toMatchObject({ rows: [['a', 1], ['b', 2]], rowCount: 200, displayedRowCount: 2 });
  });

  it('keeps a complete small result complete', () => {
    const parsed = parseSqlMcpResult([header, 'a     | 1', '', '1 rows returned. (7ms)'].join('\n'));
    expect(parsed).toMatchObject({ rowCount: 1, displayedRowCount: 1 });
  });
});
