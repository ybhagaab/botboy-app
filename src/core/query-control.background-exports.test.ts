import { describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { createQueryControl } from './query-control.js';
import { createQueryLedger, markSql } from './query-ledger.js';
import { validateMcpToolCall } from './mcp-policy.js';

/**
 * Background exports in query control (docs/maps/job-waits.md, docs/maps/query-control.md): an export started with wait:false
 * returns at once while its query runs on in the SQL connection. Query control lists it from the connection's export_status
 * and stops it through the connection's cancel, then checks the warehouse like any other stop.
 */
const T0 = Date.parse('2026-11-12T08:00:00.000Z');
const A = 'aaaaaaaa-0000-4000-8000-000000000001';
const B = 'bbbbbbbb-0000-4000-8000-000000000002';

function setup() {
  let clock = T0;
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE mcp_tool_calls (id TEXT PRIMARY KEY, server_id TEXT, tool_name TEXT, source TEXT, status TEXT, error TEXT, created_at TEXT)`);
  const ledger = createQueryLedger(db, { now: () => clock });
  const exports = new Map<string, { state: string; rowsWritten: number }>();
  /** Warehouse sessions: what each runs now (null: idle). */
  const sessions = new Map<number, { running: string | null; startedMs: number }>();
  const sent: Array<{ tool: string; args: Record<string, unknown> }> = [];
  let cancelKills = true;
  /** Exports that end on their own just as BotBoy's cancel reaches the connection. */
  const endsBeforeCancel = new Set<string>();
  /** Runs while the connection answers one export's status (another reader may act meanwhile). */
  let onStatus: ((exportId: string) => void) | null = null;
  const json = (rows: unknown[][]) => ({ isError: false, text: JSON.stringify({ columns: [], rows }) });
  const callTool = vi.fn(async (server: string, tool: string, args: Record<string, unknown>, options: any) => {
    expect(server).toBe('sql-context');
    expect(options).toMatchObject({ source: 'query-control', queryControl: true });
    sent.push({ tool, args });
    if (tool === 'export_status') {
      const id = String(args.exportId);
      const entry = exports.get(id);
      if (!entry) {
        const unknown = { isError: true, text: `Error: export ${id} is unknown. Exports are tracked only until the server restarts; finished files stay in /x.` };
        ledger.noteExportStatus(id, unknown);
        return unknown;
      }
      onStatus?.(id);
      if (args.cancel === true && endsBeforeCancel.has(id)) entry.state = 'done';
      if (args.cancel === true && (entry.state === 'queued' || entry.state === 'running')) {
        entry.state = 'cancelled';
        // The connection cancels the warehouse query under it (unless the test says the cancel misses).
        if (cancelKills) for (const session of sessions.values()) if (session.running?.includes(`botboy:q=`)) session.running = null;
      }
      // What the manager does with every export_status answer (query-ledger.ts › noteExportStatus).
      const answer = { isError: false, text: JSON.stringify({ exportId: id, ...entry }) };
      ledger.noteExportStatus(id, answer);
      return answer;
    }
    expect(tool).toBe('run_query');
    validateMcpToolCall('sql-context', 'run_query', args, { queryControl: true });
    const sql = String(args.sql);
    if (/FROM stv_recents/.test(sql)) {
      const only = /AND pid = (\d+)/.exec(sql);
      return json([...sessions].filter(([id, session]) => session.running && (!only || Number(only[1]) === id))
        .map(([id, session]) => [id, session.startedMs / 1000, session.running!.slice(0, 200)]));
    }
    if (/ROW_NUMBER\(\) OVER/.test(sql)) {
      const ids = /session_id IN \(([^)]*)\)/.exec(sql)![1].split(',').map(id => Number(id.trim()));
      return json(ids.filter(id => sessions.get(id)?.running).map(id => [id, id * 10, sessions.get(id)!.startedMs / 1000, 'running', sessions.get(id)!.running]));
    }
    if (/^SELECT session_id FROM sys_query_history/.test(sql)) {
      const marker = /botboy:q=([0-9a-f-]{36})/.exec(sql)![1];
      return json([...sessions].filter(([, session]) => session.running?.includes(marker)).map(([id]) => [id]));
    }
    const terminate = /^SELECT pg_terminate_backend\((\d+)\)$/.exec(sql);
    if (terminate) {
      sessions.get(Number(terminate[1]))!.running = null;
      return json([[1]]);
    }
    throw new Error(`unexpected control SQL: ${sql}`);
  });
  const control = createQueryControl({
    db, ledger, mcpManager: { callTool } as any,
    describeJob: (jobId) => (jobId === 'cj_5' ? { number: 5, title: 'OTT CX behaviour study' } : null),
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
  });
  /** A background export as BotBoy starts it: the export_query call, held open with its export id. */
  const background = (callId: string, exportId: string, origin: any = { kind: 'job', jobId: 'cj_5', label: 'Overlap export' }) => {
    ledger.beginSql({ callId, serverId: 'sql-context', toolName: 'export_query', origin, sql: 'SELECT * FROM events', controller: new AbortController() });
    ledger.holdForExport(callId, exportId);
    exports.set(exportId, { state: 'running', rowsWritten: 1200 });
  };
  return {
    db, ledger, control, exports, sessions, sent, callTool, background,
    advance: (ms: number) => { clock += ms; },
    missCancel: () => { cancelKills = false; },
    endBeforeCancel: (exportId: string) => { endsBeforeCancel.add(exportId); },
    whenStatus: (fn: (exportId: string) => void) => { onStatus = fn; },
  };
}

describe('background exports in query control', () => {
  it('lists a running background export from the connection, with its job; an ended one leaves the list and ends its row', async () => {
    const t = setup();
    t.background(A, 'e_aaaaaaaaaaaaaaaa');
    t.background(B, 'e_bbbbbbbbbbbbbbbb', { kind: 'main' });
    t.exports.get('e_bbbbbbbbbbbbbbbb')!.state = 'done';
    const listing = await t.control.list({ fresh: true });
    expect(listing.warnings).toEqual([]);
    expect(listing.queries).toEqual([expect.objectContaining({
      id: A, kind: 'sql', origin: 'job', jobId: 'cj_5', job: { number: 5, title: 'OTT CX behaviour study' }, label: 'Overlap export',
      where: 'background', exportId: 'e_aaaaaaaaaaaaaaaa', remoteStatus: 'running, 1,200 rows written',
    })]);
    expect(t.ledger.forExport('e_bbbbbbbbbbbbbbbb')).toMatchObject({ endState: 'completed' });
    // Nothing was a warehouse suspect, so the warehouse was not read.
    expect(t.sent.map(entry => entry.tool)).toEqual(['export_status', 'export_status']);
    expect(t.control.mayStop(listing.queries[0], { kind: 'job', jobId: 'cj_5' })).toBe(true);
    expect(t.control.mayStop(listing.queries[0], { kind: 'job', jobId: 'cj_other' })).toBe(false);
  });

  it('an export the connection lost is checked on the warehouse, where its marked query may still run', async () => {
    const t = setup();
    t.background(A, 'e_aaaaaaaaaaaaaaaa');
    t.exports.delete('e_aaaaaaaaaaaaaaaa'); // the connection restarted
    t.sessions.set(707, { running: `DECLARE mcp_c CURSOR FOR ${markSql(A, 'SELECT * FROM events')}`, startedMs: T0 - 60_000 });
    const listing = await t.control.list({ fresh: true });
    expect(t.ledger.forExport('e_aaaaaaaaaaaaaaaa')).toMatchObject({ endState: 'lost' });
    expect(listing.queries).toEqual([expect.objectContaining({ id: A, where: 'warehouse', warehouse: expect.objectContaining({ sessionId: 707 }) })]);
  });

  it('a stop cancels the export in the connection, checks the warehouse, and records who stopped it', async () => {
    const t = setup();
    t.background(A, 'e_aaaaaaaaaaaaaaaa');
    t.sessions.set(707, { running: markSql(A, 'SELECT * FROM events'), startedMs: T0 - 60_000 });
    // The export's own id names it too.
    const receipt = await t.control.stop('e_aaaaaaaaaaaaaaaa', { kind: 'job', jobId: 'cj_5' }, 'wrong month');
    expect(receipt).toMatchObject({ ok: true, id: A, state: 'stopped', verified: true });
    expect(receipt.steps?.[0]).toBe('Cancelled background export e_aaaaaaaaaaaaaaaa in the SQL connection; it cancels the warehouse query.');
    expect(t.sent).toContainEqual({ tool: 'export_status', args: { exportId: 'e_aaaaaaaaaaaaaaaa', cancel: true } });
    expect(t.ledger.get(A)).toMatchObject({ endState: 'stopped', stoppedBy: `job:cj_5` });
    // A job waiting for the export reads it as stopped on purpose, not as a failure to fix and rerun.
    expect(t.ledger.exportStoppedMessage('e_aaaaaaaaaaaaaaaa')).toContain('Stopped on purpose by the job that started it. Reason: wrong month. Do not resubmit it');
    expect((await t.control.list({ fresh: true })).queries).toEqual([]);
  });

  it('when the cancel does not stop the warehouse query, BotBoy ends its session', async () => {
    const t = setup();
    t.background(A, 'e_aaaaaaaaaaaaaaaa');
    t.missCancel();
    t.sessions.set(707, { running: markSql(A, 'SELECT * FROM events'), startedMs: T0 - 60_000 });
    const receipt = await t.control.stop(A, { kind: 'owner' });
    expect(receipt).toMatchObject({ ok: true, state: 'stopped', verified: true });
    expect(receipt.steps).toContain('Ended warehouse session 707.');
    expect(t.sessions.get(707)!.running).toBeNull();
  });

  it('an export another reader saw end leaves the list at once, though its own status read is still cached', async () => {
    const t = setup();
    t.background(A, 'e_aaaaaaaaaaaaaaaa');
    expect((await t.control.list()).queries).toHaveLength(1);
    // A job's wait (or the model) reads the export done: the manager ends its row.
    t.ledger.noteExportStatus('e_aaaaaaaaaaaaaaaa', { isError: false, text: JSON.stringify({ exportId: 'e_aaaaaaaaaaaaaaaa', state: 'done' }) });
    t.advance(10_000); // within the poll cache
    expect((await t.control.list()).queries).toEqual([]);
  });

  it('an export that ends while the list reads another one leaves the list, though its own read is still cached as running', async () => {
    const t = setup();
    t.background(A, 'e_aaaaaaaaaaaaaaaa');
    expect((await t.control.list()).queries).toHaveLength(1);
    t.background(B, 'e_bbbbbbbbbbbbbbbb', { kind: 'main' });
    t.advance(5_000); // A's read stays cached; B's goes to the connection
    // While the connection answers for B, a job's wait reads A done: the manager ends A's row.
    t.whenStatus((exportId) => {
      if (exportId !== 'e_bbbbbbbbbbbbbbbb') return;
      t.ledger.noteExportStatus('e_aaaaaaaaaaaaaaaa', { isError: false, text: JSON.stringify({ exportId: 'e_aaaaaaaaaaaaaaaa', state: 'done' }) });
    });
    const listing = await t.control.list();
    expect(listing.queries.map(query => query.id)).toEqual([B]);
    expect(t.sent.filter(entry => entry.args.exportId === 'e_aaaaaaaaaaaaaaaa')).toHaveLength(1);
  });

  it('an export that ends just as the stop\'s cancel reaches it is already finished, and keeps no stop on its record', async () => {
    const t = setup();
    t.background(A, 'e_aaaaaaaaaaaaaaaa');
    t.endBeforeCancel('e_aaaaaaaaaaaaaaaa');
    const receipt = await t.control.stop(A, { kind: 'owner' }, 'not needed');
    expect(receipt).toMatchObject({
      ok: true, id: A, state: 'already_finished', verified: true,
      steps: ['Export e_aaaaaaaaaaaaaaaa had already ended (done) before the stop.'],
    });
    expect(t.sent).toContainEqual({ tool: 'export_status', args: { exportId: 'e_aaaaaaaaaaaaaaaa', cancel: true } });
    expect(t.ledger.get(A)).toMatchObject({ endState: 'completed', stoppedBy: null });
    // Nothing was sent to the warehouse: the export had ended.
    expect(t.sent.every(entry => entry.tool === 'export_status')).toBe(true);
  });

  it('an export that ended before the stop is already finished, and keeps no stop on its record', async () => {
    const t = setup();
    t.background(A, 'e_aaaaaaaaaaaaaaaa');
    await t.control.list({ fresh: true });
    t.exports.get('e_aaaaaaaaaaaaaaaa')!.state = 'done';
    t.advance(10_000);
    const receipt = await t.control.stop(A, { kind: 'owner' });
    expect(receipt).toMatchObject({ ok: true, state: 'already_finished' });
    expect(t.ledger.get(A)).toMatchObject({ endState: 'completed', stoppedBy: null });
  });
});
