import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStorage, type StorageLayer } from './storage.js';
import { createMcpManager } from './mcp-manager.js';
import type { McpManager } from './mcp-types.js';
import type { SqlContextPackageResolver } from './sql-context-package.js';
import { QueryStoppedReason, createQueryLedger, stoppedWords, type QueryLedger } from './query-ledger.js';

/**
 * Every SQL query BotBoy sends through the managed SQL connection carries its call id as its first comment and is recorded
 * with who started it (docs/maps/query-control.md); query control's own lookups are marked as control and recorded as no
 * query; a stop through the call's own controller ends it as stopped, in words that keep it from being resubmitted. A real
 * stdio child speaks MCP through the real SDK client.
 */
const fakeServer = (cancelLog: string, exportStateFile = '') => `
const fs = require('node:fs');
const readline = require('node:readline');
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
const tool = (name) => ({ name, description: name, inputSchema: { type: 'object', properties: { sql: { type: 'string' } } } });
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  if (message.method === 'notifications/cancelled') { fs.appendFileSync(${JSON.stringify(cancelLog)}, String(message.params.requestId) + '\\n'); return; }
  if (message.id === undefined) return;
  if (message.method === 'initialize') {
    send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'sql-fake', version: '1.0.0' } } });
  } else if (message.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: message.id, result: { tools: ['connection_status', 'run_query', 'export_query', 'export_status', 'list_presets'].map(tool) } });
  } else if (message.method === 'tools/call') {
    const sql = String((message.params.arguments || {}).sql || '');
    if (message.params.name === 'connection_status') return send({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: 'Connected' }] } });
    // Background exports: export_query with wait:false answers at once; export_status reads the state the test wrote.
    if (message.params.name === 'export_query' && sql.includes('BACKGROUND')) {
      return send({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: JSON.stringify({ exportId: sql.includes('SECOND') ? 'e_bbbbbbbbbbbbbbbb' : 'e_aaaaaaaaaaaaaaaa', state: 'running' }) }] } });
    }
    if (message.params.name === 'export_status') {
      const exportId = String(message.params.arguments.exportId);
      if (exportId !== 'e_aaaaaaaaaaaaaaaa') return send({ jsonrpc: '2.0', id: message.id, result: { isError: true, content: [{ type: 'text', text: 'Error: export ' + exportId + ' is unknown. Exports are tracked only until the server restarts; finished files stay in /x.' }] } });
      const state = fs.readFileSync(${JSON.stringify(exportStateFile)}, 'utf8').trim();
      return send({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: JSON.stringify({ exportId, state, rowsWritten: 3, ...(state === 'failed' ? { error: 'boom' } : {}) }) }] } });
    }
    if (sql.includes('SLOW')) return; // answers only by being cancelled
    if (sql.includes('LOSE')) return send({ jsonrpc: '2.0', id: message.id, result: { isError: true, content: [{ type: 'text', text: 'Error: Could not reach the database server at vpce-1.example' }] } });
    send({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: 'ran: ' + sql }] } });
  } else {
    send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } });
  }
});
`;

describe('BotBoy\'s SQL calls are marked, recorded and stoppable', () => {
  let storage: StorageLayer | null = null;
  let manager: McpManager | null = null;
  let dir: string | null = null;
  afterEach(async () => {
    await manager?.stop();
    manager = null;
    storage?.close();
    storage = null;
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  async function start(): Promise<{ manager: McpManager; ledger: QueryLedger; db: ReturnType<StorageLayer['getDb']>; cancelLog: string; exportState: (state: string) => void }> {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'botboy-query-ledger-'));
    const entry = path.join(dir, 'fake-server.cjs');
    const cancelLog = path.join(dir, 'cancelled.log');
    const exportStateFile = path.join(dir, 'export-state.txt');
    fs.writeFileSync(exportStateFile, 'running');
    fs.writeFileSync(entry, fakeServer(cancelLog, exportStateFile));
    storage = createStorage(':memory:');
    storage.initialize();
    const db = storage.getDb();
    const ledger = createQueryLedger(db);
    const secrets = new Map<string, string>();
    const secretStore = {
      async get(id: string, key: string) { return secrets.get(`${id}:${key}`) ?? null; },
      async set(id: string, key: string, value: string) { secrets.set(`${id}:${key}`, value); },
      async delete(id: string, key: string) { secrets.delete(`${id}:${key}`); },
      async has(id: string, key: string) { return secrets.has(`${id}:${key}`); },
    };
    const sqlContextPackages: SqlContextPackageResolver = { resolveLaunch: async () => ({ version: '1.5.0', entry, source: 'bundled' as const }) };
    manager = createMcpManager({ db, secretStore, healthIntervalMs: 3_600_000, sqlContextPackages });
    await manager.start();
    await manager.updateSqlContextConfig({ enabled: true, authMethod: 'direct', host: '127.0.0.1', port: 5439, database: 'db', username: 'user', sslMode: 'disable', password: 'secret' });
    return { manager, ledger, db, cancelLog, exportState: (state) => fs.writeFileSync(exportStateFile, state) };
  }
  const rows = (db: any) => db.prepare('SELECT * FROM query_ledger ORDER BY started_at').all() as any[];

  it('sends the call id first in the SQL and records the call with who started it', { timeout: 60_000 }, async () => {
    const t = await start();
    const result = await t.manager.callTool('sql-context', 'run_query', { sql: 'SELECT 1' }, { source: 'agent', queryOrigin: { kind: 'job', jobId: 'cj_5', label: 'Overlap' } });
    const [row] = rows(t.db);
    expect(result.text).toBe(`ran: /* botboy:q=${row.id} */ SELECT 1`);
    expect(row).toMatchObject({ kind: 'sql', origin: 'job', job_id: 'cj_5', label: 'Overlap', tool_name: 'run_query', end_state: 'completed', preview: 'SELECT 1' });
    expect(t.db.prepare('SELECT status FROM mcp_tool_calls WHERE id = ?').get(row.id)).toEqual({ status: 'completed' });
    expect(t.ledger.inFlight()).toEqual([]);
    // A dashboard call that names no origin is a dashboard's; other tools are not queries.
    await t.manager.callTool('sql-context', 'export_query', { sql: 'SELECT 2' }, { source: 'dashboard' });
    await t.manager.callTool('sql-context', 'list_presets', {}, {});
    expect(rows(t.db).map(entry => [entry.tool_name, entry.origin])).toEqual([['run_query', 'job'], ['export_query', 'dashboard']]);
  });

  it('marks query control\'s own lookups as control and records them as no query', { timeout: 60_000 }, async () => {
    const t = await start();
    const result = await t.manager.callTool('sql-context', 'run_query', { sql: 'SELECT pg_terminate_backend(42)' }, { source: 'query-control', queryControl: true });
    expect(result.text).toBe('ran: /* botboy:control */ SELECT pg_terminate_backend(42)');
    expect(rows(t.db)).toEqual([]);
    // Without queryControl the read-only wall refuses the same statement before it is sent.
    await expect(t.manager.callTool('sql-context', 'run_query', { sql: 'SELECT pg_terminate_backend(42)' }, { source: 'agent', ownerApproved: true })).rejects.toThrow(/blocked/);
    expect(rows(t.db)).toEqual([]);
  });

  it('a call whose connection broke is recorded as lost (the warehouse may still run it)', { timeout: 60_000 }, async () => {
    const t = await start();
    const result = await t.manager.callTool('sql-context', 'run_query', { sql: 'SELECT LOSE' }, { source: 'agent' });
    expect(result.isError).toBe(true);
    expect(rows(t.db)[0]).toMatchObject({ end_state: 'lost', origin: 'botboy' });
  });

  it('a stop through the call\'s own controller cancels it on the connector and ends it as stopped, never resubmittable', { timeout: 60_000 }, async () => {
    const t = await start();
    const pending = t.manager.callTool('sql-context', 'run_query', { sql: 'SELECT SLOW' }, { source: 'agent', queryOrigin: { kind: 'main' } });
    const outcome = pending.then(() => null, (error: Error) => error);
    for (let i = 0; i < 200 && !t.ledger.inFlight().length; i++) await new Promise(resolve => setTimeout(resolve, 10));
    const [flight] = t.ledger.inFlight();
    expect(flight).toMatchObject({ origin: 'main', toolName: 'run_query' });
    flight.controller.abort(new QueryStoppedReason('owner', stoppedWords('owner')));
    const error = await outcome;
    expect(error?.message).toBe(stoppedWords('owner'));
    expect(error?.message).toMatch(/Do not resubmit/);
    const [row] = rows(t.db);
    expect(row).toMatchObject({ id: flight.id, end_state: 'stopped' });
    expect(t.db.prepare('SELECT status, error FROM mcp_tool_calls WHERE id = ?').get(flight.id)).toEqual({ status: 'failed', error: stoppedWords('owner') });
    for (let i = 0; i < 200 && !fs.existsSync(t.cancelLog); i++) await new Promise(resolve => setTimeout(resolve, 10));
    expect(fs.readFileSync(t.cancelLog, 'utf8').trim()).not.toBe('');
    expect(t.ledger.inFlight()).toEqual([]);
  });

  it('a background export stays open until an export_status answer says it ended, and a lost one becomes a suspect', { timeout: 60_000 }, async () => {
    const t = await start();
    const started = await t.manager.callTool('sql-context', 'export_query', { sql: 'SELECT BACKGROUND', wait: false }, { source: 'agent', queryOrigin: { kind: 'job', jobId: 'cj_5' } });
    expect(JSON.parse(started.text)).toEqual({ exportId: 'e_aaaaaaaaaaaaaaaa', state: 'running' });
    const [row] = rows(t.db);
    expect(row).toMatchObject({ tool_name: 'export_query', export_id: 'e_aaaaaaaaaaaaaaaa', end_state: 'background', ended_at: null, job_id: 'cj_5' });
    // Not a call BotBoy waits on, and not a warehouse suspect while the connection still has its export.
    expect(t.ledger.inFlight()).toEqual([]);
    const since = new Date(Date.now() - 3_600_000).toISOString();
    expect(t.ledger.openExports(since).map(entry => entry.exportId)).toEqual(['e_aaaaaaaaaaaaaaaa']);
    expect(t.ledger.sqlSuspects(since, since)).toEqual([]);
    // Whoever reads its status, a running export stays open and an ended one ends its row.
    await t.manager.callTool('sql-context', 'export_status', { exportId: 'e_aaaaaaaaaaaaaaaa' }, { source: 'job-wait', queryControl: true });
    expect(t.ledger.forExport('e_aaaaaaaaaaaaaaaa')).toMatchObject({ endState: 'background' });
    t.exportState('done');
    await t.manager.callTool('sql-context', 'export_status', { exportId: 'e_aaaaaaaaaaaaaaaa' }, { source: 'agent' });
    expect(t.ledger.forExport('e_aaaaaaaaaaaaaaaa')).toMatchObject({ endState: 'completed', endedAt: expect.any(String) });
    expect(t.ledger.openExports(since)).toEqual([]);
    // An export the connection no longer knows (it restarted) is lost: the warehouse may still run its query.
    await t.manager.callTool('sql-context', 'export_query', { sql: 'SELECT BACKGROUND SECOND', wait: false }, { source: 'agent', queryOrigin: { kind: 'main' } });
    const status = await t.manager.callTool('sql-context', 'export_status', { exportId: 'e_bbbbbbbbbbbbbbbb' }, { source: 'agent' });
    expect(status.isError).toBe(true);
    expect(t.ledger.forExport('e_bbbbbbbbbbbbbbbb')).toMatchObject({ endState: 'lost' });
    expect(t.ledger.sqlSuspects(since, since).map(entry => entry.exportId)).toEqual(['e_bbbbbbbbbbbbbbbb']);
    // export_status itself is never recorded as a query.
    expect(rows(t.db).map(entry => entry.tool_name)).toEqual(['export_query', 'export_query']);
  });

  it('a caller that gives up (its own signal) is recorded as cancelled, not as stopped', { timeout: 60_000 }, async () => {
    const t = await start();
    const caller = new AbortController();
    const pending = t.manager.callTool('sql-context', 'run_query', { sql: 'SELECT SLOW' }, { source: 'agent', signal: caller.signal }).then(() => null, (error: Error) => error);
    for (let i = 0; i < 200 && !t.ledger.inFlight().length; i++) await new Promise(resolve => setTimeout(resolve, 10));
    caller.abort();
    expect(await pending).toBeInstanceOf(Error);
    expect(rows(t.db)[0]).toMatchObject({ end_state: 'cancelled' });
  });
});
