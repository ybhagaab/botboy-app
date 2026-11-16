import { describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { createQueryControl, type QueryActor, type RunningQuery } from './query-control.js';
import { QueryStoppedReason, createQueryLedger, markControlSql, markSql } from './query-ledger.js';
import { validateMcpToolCall } from './mcp-policy.js';
import { DATANET_SIGN_IN_REFUSED } from './sentry-session.js';

/**
 * Stopping BotBoy's own queries (docs/maps/query-control.md). The warehouse is a fake that answers the exact lookups query
 * control sends, and every one of them must pass BotBoy's read-only wall through the queryControl option.
 */
const T0 = Date.parse('2026-11-12T08:00:00.000Z');
const A = 'aaaaaaaa-0000-4000-8000-000000000001';
const B = 'bbbbbbbb-0000-4000-8000-000000000002';
const C = 'cccccccc-0000-4000-8000-000000000003';
const D = 'dddddddd-0000-4000-8000-000000000004';
const OTHER_BOTBOY = 'eeeeeeee-0000-4000-8000-000000000005';
const sqliteTime = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');

interface Statement { queryId: number; startedMs: number; status: string; text: string }
interface Session { running: { startedMs: number; text: string } | null; history: Statement[] }

function setup(options: { etl?: boolean } = {}) {
  let clock = T0;
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE mcp_tool_calls (id TEXT PRIMARY KEY, server_id TEXT, tool_name TEXT, source TEXT, status TEXT, error TEXT, created_at TEXT)`);
  const ledger = createQueryLedger(db, { now: () => clock });
  const sessions = new Map<number, Session>();
  const sent: string[] = [];
  const terminated: number[] = [];
  let failNext: string | null = null;
  let beforeAnswer: ((sql: string) => void) | null = null;
  let onTerminate: (session: number) => void = (session) => { sessions.get(session)!.running = null; };
  const json = (rows: unknown[][]) => ({ isError: false, text: JSON.stringify({ columns: [], rows }) });
  const callTool = vi.fn(async (server: string, tool: string, args: Record<string, unknown>, callOptions: any) => {
    expect(server).toBe('sql-context');
    expect(tool).toBe('run_query');
    expect(callOptions).toMatchObject({ source: 'query-control', queryControl: true });
    // The read-only wall admits every statement query control sends, through queryControl only.
    validateMcpToolCall('sql-context', 'run_query', args, { queryControl: true });
    const sql = String(args.sql);
    sent.push(sql);
    beforeAnswer?.(sql);
    if (failNext) {
      const text = failNext;
      failNext = null;
      return { isError: true, text };
    }
    if (/FROM stv_recents/.test(sql)) {
      const only = /AND pid = (\d+)/.exec(sql);
      return json([...sessions].filter(([id, session]) => session.running && (!only || Number(only[1]) === id))
        .map(([id, session]) => [id, session.running!.startedMs / 1000, session.running!.text.slice(0, 200)]));
    }
    if (/ROW_NUMBER\(\) OVER/.test(sql)) {
      const ids = /session_id IN \(([^)]*)\)/.exec(sql)![1].split(',').map(id => Number(id.trim()));
      return json(ids.flatMap(id => (sessions.get(id)?.history ?? []).slice(-8)
        .map(statement => [id, statement.queryId, statement.startedMs / 1000, statement.status, statement.text.slice(0, 400)])));
    }
    if (/^SELECT session_id FROM sys_query_history/.test(sql)) {
      const marker = /botboy:q=([0-9a-f-]{36})/.exec(sql)![1];
      const found = [...sessions].filter(([, session]) => session.history.some(statement => statement.text.includes(marker))).map(([id]) => id);
      return json(found.slice(-1).map(id => [id]));
    }
    const terminate = /^SELECT pg_terminate_backend\((\d+)\)$/.exec(sql);
    if (terminate) {
      terminated.push(Number(terminate[1]));
      onTerminate(Number(terminate[1]));
      return json([[1]]);
    }
    throw new Error(`unexpected control SQL: ${sql}`);
  });
  const etl = { status: new Map<string, string>(), killed: [] as Array<{ args: any; options: any }>, onKill: (_run: string) => {} };
  const etlCall = vi.fn(async (tool: string, args: Record<string, unknown>, callOptions?: any) => {
    if (tool === 'datanet_get_job_run_status') {
      const status = etl.status.get(String(args.run_id));
      return status ? { isError: false, text: JSON.stringify({ status }) } : { isError: true, text: 'Datanet timed out' };
    }
    if (tool === 'datanet_alter_run') {
      etl.killed.push({ args, options: callOptions });
      etl.onKill(String(args.run_id));
      return { isError: false, text: '{"ok":true}' };
    }
    throw new Error(`unexpected ETL tool ${tool}`);
  });
  const control = createQueryControl({
    db,
    ledger,
    mcpManager: { callTool } as any,
    ...(options.etl === false ? {} : { etlCall: etlCall as any }),
    isJobRun: (jobId, runId) => jobId === 'cj_owner_of_77' && runId === '77',
    describeJob: (jobId) => (jobId === 'cj_5' ? { number: 5, title: 'OTT CX behaviour study' } : null),
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
  });
  const flight = (id: string, origin: any, label?: string) => {
    const controller = new AbortController();
    ledger.beginSql({ callId: id, serverId: 'sql-context', toolName: 'run_query', origin: { ...origin, ...(label ? { label } : {}) }, sql: 'SELECT week, SUM(streams) FROM plays GROUP BY 1', controller });
    // What the MCP manager does when a stop aborts a call: it ends the call as stopped.
    controller.signal.addEventListener('abort', () => ledger.endSql(id, 'stopped', String((controller.signal.reason as Error)?.message)));
    return controller;
  };
  /** A cursor query in a session: BEGIN, its DECLARE (with the SQL as sent), and the FETCH that still runs. */
  const cursor = (session: number, sentSql: string, beganMs: number, queryId = session * 10) => {
    sessions.set(session, {
      running: { startedMs: beganMs + 40_000, text: 'FETCH FORWARD 101 FROM mcp_c' },
      history: [
        { queryId: queryId - 2, startedMs: beganMs, status: 'success', text: 'BEGIN' },
        { queryId: queryId - 1, startedMs: beganMs + 100, status: 'success', text: `DECLARE mcp_c CURSOR FOR ${sentSql}` },
        { queryId, startedMs: beganMs + 40_000, status: 'running', text: 'FETCH FORWARD 101 FROM mcp_c' },
      ],
    });
  };
  const lostCall = (id: string, createdMs: number, error = 'Error: Could not reach the database server at vpce-1.example') => {
    db.prepare(`INSERT INTO mcp_tool_calls (id, server_id, tool_name, source, status, error, created_at) VALUES (?, 'sql-context', 'run_query', 'agent', 'failed', ?, ?)`)
      .run(id, error, sqliteTime(createdMs));
  };
  return {
    db, ledger, control, sessions, sent, terminated, etl, etlCall, callTool, flight, cursor, lostCall,
    advance: (ms: number) => { clock += ms; },
    now: () => clock,
    failNextWith: (text: string) => { failNext = text; },
    setOnTerminate: (fn: (session: number) => void) => { onTerminate = fn; },
    setBeforeAnswer: (fn: ((sql: string) => void) | null) => { beforeAnswer = fn; },
  };
}

describe('listing BotBoy\'s running queries', () => {
  it('sends the warehouse nothing while BotBoy has no lost query, and lists the calls it is waiting on', async () => {
    const t = setup();
    t.flight(A, { kind: 'main' }, 'Revenue by week');
    const listing = await t.control.list({ fresh: true });
    expect(listing.queries).toEqual([expect.objectContaining({ id: A, kind: 'sql', origin: 'main', label: 'Revenue by week', where: 'botboy', preview: 'SELECT week, SUM(streams) FROM plays GROUP BY 1' })]);
    expect(t.callTool).not.toHaveBeenCalled();
  });

  it('finds a query only the warehouse still runs by the marker on the DECLARE behind its FETCH, and nothing that is not BotBoy\'s', async () => {
    const t = setup();
    t.flight(B, { kind: 'job', jobId: 'cj_5' });
    t.ledger.endSql(B, 'lost', 'Could not reach the database server');
    t.cursor(101, markSql(B, 'SELECT 1'), T0 - 3_600_000, 354627800);
    t.cursor(202, 'SELECT * FROM kiro_scratch', T0 - 600_000); // another tool's query on the same database user
    t.cursor(303, markSql(OTHER_BOTBOY, 'SELECT 2'), T0 - 500_000); // another BotBoy's marker
    t.cursor(404, markControlSql('SELECT pid FROM stv_recents'), T0 - 1_000); // query control's own lookup, mid-FETCH
    const listing = await t.control.list({ fresh: true });
    expect(listing.warnings).toEqual([]);
    expect(listing.queries).toHaveLength(1);
    expect(listing.queries[0]).toMatchObject({
      id: B, origin: 'job', jobId: 'cj_5', job: { number: 5, title: 'OTT CX behaviour study' }, where: 'warehouse', matchedBy: 'marker',
      warehouse: { sessionId: 101, queryId: 354627800, statementStartedAt: new Date(T0 - 3_600_000 + 40_000).toISOString() },
    });
    expect(t.control.starterOf(listing.queries[0])).toBe('job #5 OTT CX behaviour study');
    // The lookup excludes its own session.
    expect(t.sent[0]).toContain('pid <> pg_backend_pid()');
  });

  it('reuses a poll\'s warehouse read for a minute, and stops reading once the warehouse no longer runs what BotBoy lost', async () => {
    const t = setup();
    t.flight(B, { kind: 'main' });
    t.ledger.endSql(B, 'lost', 'Connection closed');
    t.cursor(101, markSql(B, 'SELECT 1'), T0 - 60_000);
    expect((await t.control.list()).queries).toHaveLength(1);
    const reads = t.sent.length;
    t.advance(30_000);
    expect((await t.control.list()).queries).toHaveLength(1);
    expect(t.sent.length).toBe(reads);
    t.sessions.get(101)!.running = null;
    t.advance(31_000);
    expect((await t.control.list()).queries).toEqual([]);
    const settled = t.sent.length;
    t.advance(120_000);
    expect((await t.control.list({ fresh: true })).queries).toEqual([]);
    expect(t.sent.length).toBe(settled);
  });

  it('a call lost after a poll\'s read is not settled by that read: the next read lists it', async () => {
    const t = setup();
    t.flight(A, { kind: 'main' });
    t.ledger.endSql(A, 'lost', 'Connection closed');
    t.advance(1_000);
    expect((await t.control.list()).queries).toEqual([]);
    t.advance(1_000);
    t.flight(B, { kind: 'main' });
    t.ledger.endSql(B, 'lost', 'Connection closed');
    t.cursor(7, markSql(B, 'SELECT 1'), t.now() - 60_000);
    expect((await t.control.list()).queries).toEqual([]); // the cached read is older than B's loss
    t.advance(61_000);
    expect((await t.control.list()).queries.map(query => query.id)).toEqual([B]);
  });

  it('a timed-out call is checked on the warehouse for 30 minutes; a plain SQL error never is', async () => {
    const t = setup();
    t.flight(A, { kind: 'main' });
    t.ledger.endSql(A, 'failed', 'MCP error -32001: Request timed out');
    t.flight(C, { kind: 'main' });
    t.ledger.endSql(C, 'failed', 'Error: syntax error at or near "FORM"');
    await t.control.list({ fresh: true });
    expect(t.sent.some(sql => sql.includes('stv_recents'))).toBe(true);
    const t2 = setup();
    t2.flight(C, { kind: 'main' });
    t2.ledger.endSql(C, 'failed', 'Error: syntax error at or near "FORM"');
    await t2.control.list({ fresh: true });
    expect(t2.callTool).not.toHaveBeenCalled();
  });

  it('matches a query from before markers by start time, only to exactly one BotBoy call that lost its connection', async () => {
    const t = setup();
    const created = T0 - 9 * 3_600_000;
    t.lostCall('194ffb41-6e62-4459-9342-e8611a4691ac', created);
    t.cursor(1073826734, "WITH tmp_win AS (SELECT CAST('2026-09-01' AS TIMESTAMP) AS d_from) SELECT * FROM tmp_win", created + 1_000, 354627800);
    const listing = await t.control.list({ fresh: true });
    expect(listing.queries).toEqual([expect.objectContaining({
      id: 'earlier:1073826734', origin: 'earlier', matchedBy: 'start_time', where: 'warehouse',
      startedAt: new Date(created).toISOString(), preview: expect.stringMatching(/^WITH tmp_win AS/),
      warehouse: expect.objectContaining({ sessionId: 1073826734, queryId: 354627800 }),
    })]);
    expect(t.control.starterOf(listing.queries[0])).toMatch(/before it labelled its queries/);

    const ambiguous = setup();
    ambiguous.lostCall('11111111-0000-4000-8000-000000000001', created);
    ambiguous.lostCall('11111111-0000-4000-8000-000000000002', created + 30_000);
    ambiguous.cursor(9, 'SELECT 1', created + 31_000);
    expect((await ambiguous.control.list({ fresh: true })).queries).toEqual([]);

    const outside = setup();
    outside.lostCall('11111111-0000-4000-8000-000000000003', created);
    outside.cursor(9, 'SELECT 1', created + 10 * 60_000);
    expect((await outside.control.list({ fresh: true })).queries).toEqual([]);

    const notLost = setup();
    notLost.lostCall('11111111-0000-4000-8000-000000000004', created, 'Error: syntax error');
    notLost.cursor(9, 'SELECT 1', created + 1_000);
    expect((await notLost.control.list({ fresh: true })).queries).toEqual([]);
    expect(notLost.callTool).not.toHaveBeenCalled();
  });

  it('says what it could not read, and settles nothing on a failed read', async () => {
    const t = setup();
    t.flight(B, { kind: 'main' });
    t.ledger.endSql(B, 'lost', 'Connection closed');
    t.advance(1_000);
    t.failNextWith('Error: Could not reach the database server');
    const failed = await t.control.list({ fresh: true });
    expect(failed.queries).toEqual([]);
    expect(failed.warnings[0]).toMatch(/could not read the warehouse's running queries/);
    t.cursor(101, markSql(B, 'SELECT 1'), T0 - 60_000);
    t.advance(5_000);
    expect((await t.control.list({ fresh: true })).queries.map(query => query.id)).toEqual([B]);
  });

  it('lists the ETL runs Datanet does not report finished, and ends the rest', async () => {
    const t = setup();
    t.ledger.beginEtl({ runId: '77', origin: { kind: 'job', jobId: 'cj_5' }, label: 'Weekly streams', startedAt: new Date(T0 - 3_000).toISOString() });
    t.ledger.beginEtl({ runId: '78', origin: { kind: 'main' }, startedAt: new Date(T0 - 2_000).toISOString() });
    t.ledger.beginEtl({ runId: '79', origin: { kind: 'dashboard' }, startedAt: new Date(T0 - 1_000).toISOString() });
    t.etl.status.set('77', 'EXECUTING');
    t.etl.status.set('78', 'SUCCESS');
    const listing = await t.control.list({ fresh: true });
    expect(listing.queries.map(query => [query.id, query.where, query.remoteStatus ?? null])).toEqual([
      ['etl:77', 'datanet', 'EXECUTING'], ['etl:79', 'datanet', null],
    ]);
    expect(listing.warnings).toEqual(['Datanet did not answer for 1 ETL run; it is listed as still running.']);
    expect(t.ledger.forRun('78')).toMatchObject({ endState: 'success' });
  });

  it('reads no ETL run while Datanet is unavailable, and says so', async () => {
    const t = setup({ etl: false });
    t.ledger.beginEtl({ runId: '77' });
    const listing = await t.control.list({ fresh: true });
    expect(listing.queries).toEqual([]);
    expect(listing.warnings).toEqual(['Datanet ETL is not available right now, so BotBoy cannot check its ETL runs.']);
  });
});

describe('who may stop what', () => {
  const query = (over: Partial<RunningQuery>): RunningQuery => ({ id: A, kind: 'sql', origin: 'main', label: 'q', preview: '', startedAt: new Date(T0).toISOString(), runningForMs: 0, where: 'botboy', ...over });
  const cases: Array<[string, Partial<RunningQuery>, QueryActor, boolean]> = [
    ['the owner, anything', { origin: 'earlier' }, { kind: 'owner' }, true],
    ['a job, its own query', { origin: 'job', jobId: 'cj_1' }, { kind: 'job', jobId: 'cj_1' }, true],
    ['a job, another job\'s', { origin: 'job', jobId: 'cj_2' }, { kind: 'job', jobId: 'cj_1' }, false],
    ['a job, the main chat\'s', { origin: 'main' }, { kind: 'job', jobId: 'cj_1' }, false],
    ['a job, an ETL run it watches', { kind: 'etl', origin: 'botboy', runId: '77' }, { kind: 'job', jobId: 'cj_owner_of_77' }, true],
    ['a job, a query from before markers', { origin: 'earlier' }, { kind: 'job', jobId: 'cj_1' }, false],
    ['the main chat, its own', { origin: 'main' }, { kind: 'main' }, true],
    ['the main chat, a job it started', { origin: 'job', jobId: 'cj_1' }, { kind: 'main', jobIds: ['cj_1'] }, true],
    ['the main chat, another job\'s', { origin: 'job', jobId: 'cj_2' }, { kind: 'main', jobIds: ['cj_1'] }, false],
    ['the main chat, a dashboard refresh', { origin: 'dashboard' }, { kind: 'main' }, false],
    ['the main chat, a query from before markers', { origin: 'earlier' }, { kind: 'main' }, false],
    ['an owner turn the owner asked to stop it', { origin: 'earlier' }, { kind: 'main', ownerRequested: true }, true],
    ['an owner turn in a job\'s thread the owner asked', { origin: 'dashboard' }, { kind: 'job', jobId: 'cj_1', ownerRequested: true }, true],
  ];
  it.each(cases)('%s', (_label, over, actor, expected) => {
    expect(setup().control.mayStop(query(over), actor)).toBe(expected);
  });
});

describe('stopping a SQL query', () => {
  it('cancels the call BotBoy waits on; the connector\'s cancel ends it, so no session is ended', async () => {
    const t = setup();
    const controller = t.flight(C, { kind: 'main' });
    t.cursor(601, markSql(C, 'SELECT 1'), T0 - 10_000);
    controller.signal.addEventListener('abort', () => { t.sessions.get(601)!.running = null; });
    const receipt = await t.control.stop(C, { kind: 'main' }, 'wrong date window');
    expect(receipt).toMatchObject({ ok: true, state: 'stopped', verified: true, kind: 'sql' });
    expect(controller.signal.reason).toBeInstanceOf(QueryStoppedReason);
    expect((controller.signal.reason as Error).message).toMatch(/^Stopped on purpose by the main chat that started it\. Reason: wrong date window\. Do not resubmit/);
    expect(t.terminated).toEqual([]);
    expect(t.ledger.get(C)).toMatchObject({ endState: 'stopped', stoppedBy: 'main', endNote: 'wrong date window' });
  });

  it('ends the session when the query still runs after the cancel, and checks that it stopped', async () => {
    const t = setup();
    t.flight(C, { kind: 'main' });
    t.cursor(601, markSql(C, 'SELECT 1'), T0 - 10_000);
    const receipt = await t.control.stop(C, { kind: 'owner' });
    expect(t.terminated).toEqual([601]);
    expect(receipt).toMatchObject({ ok: true, state: 'stopped', verified: true });
    expect(receipt.steps).toContain('Ended warehouse session 601.');
  });

  it('never ends a pooled session that has moved on to another call\'s query', async () => {
    const t = setup();
    const controller = t.flight(C, { kind: 'main' });
    t.cursor(601, markSql(C, 'SELECT 1'), T0 - 10_000);
    controller.signal.addEventListener('abort', () => {
      const session = t.sessions.get(601)!;
      session.history.push(
        { queryId: 7001, startedMs: T0 + 500, status: 'success', text: 'BEGIN' },
        { queryId: 7002, startedMs: T0 + 600, status: 'success', text: `DECLARE mcp_c CURSOR FOR ${markSql(D, 'SELECT 2')}` },
        { queryId: 7003, startedMs: T0 + 700, status: 'running', text: 'FETCH FORWARD 101 FROM mcp_c' },
      );
      session.running = { startedMs: T0 + 700, text: 'FETCH FORWARD 101 FROM mcp_c' };
    });
    const receipt = await t.control.stop(C, { kind: 'owner' });
    expect(t.terminated).toEqual([]);
    expect(receipt).toMatchObject({ ok: true, state: 'stopped', verified: true });
  });

  it('a call that never reached the warehouse is stopped by its cancel alone', async () => {
    const t = setup();
    t.flight(C, { kind: 'main' });
    const receipt = await t.control.stop(C, { kind: 'main' });
    expect(receipt).toMatchObject({ ok: true, state: 'stopped', verified: true });
    expect(t.sent.some(sql => sql.startsWith('SELECT session_id FROM sys_query_history'))).toBe(true);
  });

  it('stops a query from before markers for the owner, only while the very statement listed still runs', async () => {
    const t = setup();
    const created = T0 - 9 * 3_600_000;
    t.lostCall('194ffb41-6e62-4459-9342-e8611a4691ac', created);
    t.cursor(1073826734, 'SELECT 1', created + 1_000, 354627800);
    const refused = await t.control.stop('354627800', { kind: 'job', jobId: 'cj_5' });
    expect(refused).toMatchObject({ ok: false, code: 'not_yours', id: 'earlier:1073826734' });
    expect(refused.nextAction).toMatch(/owner can press Stop/);
    expect(t.terminated).toEqual([]);
    const receipt = await t.control.stop('1073826734', { kind: 'owner' });
    expect(t.terminated).toEqual([1073826734]);
    expect(receipt).toMatchObject({ ok: true, state: 'stopped', verified: true, id: 'earlier:1073826734' });
  });

  it('never ends the session of a query from before markers once it runs another statement', async () => {
    const t = setup();
    const created = T0 - 9 * 3_600_000;
    t.lostCall('194ffb41-6e62-4459-9342-e8611a4691ac', created);
    t.cursor(55, 'SELECT 1', created + 1_000);
    t.setBeforeAnswer((sql) => {
      // Between the list and the stop's own check, the listed statement ends and the session runs another unmarked one.
      if (/AND pid = 55/.test(sql)) t.sessions.get(55)!.running = { startedMs: T0 - 5_000, text: 'SELECT * FROM kiro_scratch' };
    });
    const receipt = await t.control.stop('earlier:55', { kind: 'owner' });
    expect(t.terminated).toEqual([]);
    expect(receipt).toMatchObject({ ok: true, state: 'stopped', verified: true });
  });

  it('says still running, with the next step, when the warehouse keeps running it after the session was ended', async () => {
    const t = setup();
    const created = T0 - 9 * 3_600_000;
    t.lostCall('194ffb41-6e62-4459-9342-e8611a4691ac', created);
    t.cursor(55, 'SELECT 1', created + 1_000);
    t.setOnTerminate(() => {});
    const receipt = await t.control.stop('earlier:55', { kind: 'owner' });
    expect(receipt).toMatchObject({ ok: false, state: 'still_running', code: 'stop_failed', verified: true });
    expect(receipt.nextAction).toMatch(/Try once more in a minute/);
  });

  it('refuses another conversation\'s query without touching it, and names an id that is not running', async () => {
    const t = setup();
    const controller = t.flight(C, { kind: 'job', jobId: 'cj_2' });
    const refused = await t.control.stop(C, { kind: 'main', jobIds: ['cj_1'] });
    expect(refused).toMatchObject({ ok: false, code: 'not_yours' });
    expect(refused.nextAction).toMatch(/ownerRequested true/);
    expect(controller.signal.aborted).toBe(false);
    expect(await t.control.stop('ffffffff-0000-4000-8000-000000000009', { kind: 'owner' })).toMatchObject({ ok: false, code: 'not_running' });
    t.ledger.endSql(C, 'completed');
    expect(await t.control.stop(C, { kind: 'owner' })).toMatchObject({ ok: true, state: 'already_finished' });
  });
});

describe('stopping an ETL run', () => {
  it('asks Datanet to kill it, checks it ended CANCELLED, and leaves words that keep it from being resubmitted', async () => {
    const t = setup();
    t.ledger.beginEtl({ runId: '77', origin: { kind: 'job', jobId: 'cj_5' }, label: 'Weekly streams' });
    t.etl.status.set('77', 'EXECUTING');
    // Datanet's real answer to KILL_SESSION (live 2026-11-14): CANCELLING, then CANCELLED.
    t.etl.onKill = (run) => t.etl.status.set(run, 'CANCELLED');
    const began = t.now();
    const receipt = await t.control.stop('77', { kind: 'job', jobId: 'cj_5' }, 'superseded');
    expect(receipt).toMatchObject({ ok: true, kind: 'etl', state: 'stopped', verified: true, id: 'etl:77' });
    // The first check after the kill asks Datanet, never the list's answer from a moment before: confirmed after one 2 s wait.
    expect(t.now() - began).toBe(2_000);
    expect(t.etl.killed).toEqual([{ args: { run_id: '77', action: 'KILL_SESSION', reason: 'BotBoy: stopped by the job that started it: superseded' }, options: { ownerApproved: true } }]);
    expect(t.ledger.stoppedMessage('77')).toMatch(/Stopped on purpose by the job that started it\. Reason: superseded\. Do not resubmit/);
    expect(t.ledger.forRun('77')).toMatchObject({ endState: 'stopped' });
  });

  it('the owner\'s case (2026-11-14): runs Datanet already cancelled leave Running queries at the next look, as stopped', async () => {
    const t = setup();
    for (const run of ['13254562333', '13254867361', '13257595845']) {
      t.ledger.beginEtl({ runId: run, origin: { kind: 'job', jobId: 'cj_5' }, label: `Split ${run}` });
      t.etl.status.set(run, 'CANCELLED');
    }
    // Two of them had a stop request whose check never saw them end; one was cancelled from the main chat's own kill.
    t.ledger.markStopRequested('etl:13257595845', 'owner');
    t.ledger.markStopRequested('etl:13254867361', 'owner');
    const listing = await t.control.list({ fresh: true });
    expect(listing.queries).toEqual([]);
    expect(t.ledger.forRun('13257595845')).toMatchObject({ endState: 'stopped' });
    expect(t.ledger.forRun('13254562333')).toMatchObject({ endState: 'cancelled' });
    // Asked to stop one now, BotBoy says it had already ended instead of failing.
    expect(await t.control.stop('13257595845', { kind: 'owner' })).toMatchObject({ ok: true, state: 'already_finished' });
    expect(t.etl.killed).toEqual([]);
  });
  it('a run Datanet is already cancelling gets no second kill; the stop is confirmed when Datanet says CANCELLED', async () => {
    const t = setup();
    t.ledger.beginEtl({ runId: '78', origin: { kind: 'main' } });
    t.etl.status.set('78', 'CANCELLING');
    let reads = 0;
    t.etlCall.mockImplementation(async (tool: string, args: Record<string, unknown>) => {
      if (tool !== 'datanet_get_job_run_status') throw new Error(`no ${tool} expected`);
      reads += 1;
      return { isError: false, text: JSON.stringify({ status: reads >= 3 ? 'CANCELLED' : 'CANCELLING', run: args.run_id }) };
    });
    const receipt = await t.control.stop('78', { kind: 'owner' });
    expect(receipt).toMatchObject({ ok: true, state: 'stopped', verified: true });
    expect(receipt.steps?.[0]).toMatch(/already cancelling run 78; no second stop was sent/);
    expect(t.ledger.forRun('78')).toMatchObject({ endState: 'stopped' });
  });
  it('a kill Datanet is still carrying out reads as stop sent; the run stays listed (cancelling) until Datanet ends it', async () => {
    const t = setup();
    t.ledger.beginEtl({ runId: '79', origin: { kind: 'main' } });
    t.etl.status.set('79', 'EXECUTING');
    t.etl.onKill = (run) => t.etl.status.set(run, 'CANCELLING');
    const receipt = await t.control.stop('79', { kind: 'owner' });
    expect(receipt).toMatchObject({ ok: true, state: 'stopped', verified: false });
    expect(receipt.nextAction).toMatch(/Datanet is cancelling run 79; it leaves Running queries once Datanet finishes/);
    const listed = await t.control.list({ fresh: true });
    expect(listed.queries.map(query => [query.id, query.remoteStatus])).toEqual([['etl:79', 'CANCELLING']]);
    t.etl.status.set('79', 'CANCELLED');
    t.advance(4_000); // past the fresh read cache (3 s)
    expect((await t.control.list({ fresh: true })).queries).toEqual([]);
    expect(t.ledger.forRun('79')).toMatchObject({ endState: 'stopped' });
  });
  it('a refused kill on a run that ended meanwhile is reported as ended, never as a failed stop', async () => {
    const t = setup();
    t.ledger.beginEtl({ runId: '80', origin: { kind: 'main' } });
    t.etl.status.set('80', 'EXECUTING');
    t.etlCall.mockImplementation(async (tool: string) => {
      if (tool === 'datanet_alter_run') {
        t.etl.status.set('80', 'CANCELLED');
        return { isError: true, text: 'KILL_SESSION is not a possible action for run 80' };
      }
      return { isError: false, text: JSON.stringify({ status: t.etl.status.get('80') }) };
    });
    const receipt = await t.control.stop('80', { kind: 'owner' });
    expect(receipt).toMatchObject({ ok: true, state: 'stopped', verified: true });
    expect(receipt.steps?.[0]).toMatch(/Datanet did not take the stop .*the run had already ended/);
  });
  it('a run that finished first is reported as finished, and is not marked stopped', async () => {
    const t = setup();
    t.ledger.beginEtl({ runId: '77', origin: { kind: 'main' } });
    t.etl.status.set('77', 'EXECUTING');
    t.etl.onKill = (run) => t.etl.status.set(run, 'SUCCESS');
    const receipt = await t.control.stop('etl:77', { kind: 'main' });
    expect(receipt).toMatchObject({ ok: true, state: 'already_finished' });
    expect(t.ledger.stoppedMessage('77')).toBeNull();
  });

  it('Datanet refusing the stop is a failed stop with the next step, and nothing is marked stopped', async () => {
    const t = setup();
    t.ledger.beginEtl({ runId: '77', origin: { kind: 'main' } });
    t.etl.status.set('77', 'EXECUTING');
    t.etlCall.mockImplementationOnce(async () => ({ isError: false, text: JSON.stringify({ status: 'EXECUTING' }) }))
      .mockImplementationOnce(async () => ({ isError: true, text: 'Datanet: not authorized to alter run 77' }));
    const receipt = await t.control.stop('etl:77', { kind: 'owner' });
    expect(receipt).toMatchObject({ ok: false, code: 'stop_failed' });
    expect(receipt.error).toContain('not authorized');
    expect(t.ledger.stoppedMessage('77')).toBeNull();
  });
});

/**
 * A refused Datanet sign-in (live 2026-11-14): Amazon's device check lapsed, and every status read came back as Datanet's
 * sign-in page for three hours while Running queries said "Datanet did not answer". The cause and its fix are named instead.
 */
describe('a refused Datanet sign-in', () => {
  // The page as the a2 connector wraps it (isError false), and BotBoy's own words for it (etl-adhoc.ts › createEtlToolCall).
  const PAGE = '{\n  "_raw": "<html>\\n<head><title>307 Temporary Redirect</title></head>\\n<body>\\n<center><h1>307 Temporary Redirect</h1></center>\\n</body>\\n</html>\\n"\n}';
  const REFUSED = `Error: ${DATANET_SIGN_IN_REFUSED}: Datanet answered with its sign-in page, so the Datanet ETL connection needs re-authentication; Datanet did not act on this call.`;
  const answers = (byRun: Record<string, { isError: boolean; text: string }>) => async (tool: string, args: Record<string, unknown>) => {
    if (tool !== 'datanet_get_job_run_status') return { isError: true, text: REFUSED };
    return byRun[String(args.run_id)] ?? { isError: true, text: 'Datanet timed out' };
  };
  it('names the cause and its fix in Running queries, apart from runs Datanet did not answer for, and ends nothing', async () => {
    const t = setup();
    for (const run of ['77', '78', '79']) t.ledger.beginEtl({ runId: run, origin: { kind: 'job', jobId: 'cj_5' } });
    t.etlCall.mockImplementation(answers({ 77: { isError: false, text: PAGE }, 78: { isError: true, text: REFUSED } }));
    const listing = await t.control.list({ fresh: true });
    expect(listing.queries.map(query => [query.id, query.remoteStatus ?? null]).sort()).toEqual([['etl:77', null], ['etl:78', null], ['etl:79', null]]);
    expect(listing.warnings).toEqual([
      'Datanet sign-in refused (Amazon device check or Midway expired) for 2 ETL runs; they are listed as still running until Datanet answers. To fix it, run mwinit -o -s in Terminal (or Connections → Datanet ETL → Refresh Midway + Sentry), then check again.',
      'Datanet did not answer for 1 ETL run; it is listed as still running.',
    ]);
    for (const run of ['77', '78', '79']) expect(t.ledger.forRun(run)?.endState ?? null).toBeNull();
  });
  it('one run refused reads in the singular', async () => {
    const t = setup();
    t.ledger.beginEtl({ runId: '77', origin: { kind: 'main' } });
    t.etlCall.mockImplementation(answers({ 77: { isError: false, text: PAGE } }));
    expect((await t.control.list({ fresh: true })).warnings).toEqual([
      'Datanet sign-in refused (Amazon device check or Midway expired) for 1 ETL run; it is listed as still running until Datanet answers. To fix it, run mwinit -o -s in Terminal (or Connections → Datanet ETL → Refresh Midway + Sentry), then check again.',
    ]);
  });
  it('a stop Datanet never got because of its sign-in says so, names the fix, and marks nothing stopped', async () => {
    const t = setup();
    t.ledger.beginEtl({ runId: '77', origin: { kind: 'main' } });
    t.etlCall.mockImplementation(answers({}));
    const receipt = await t.control.stop('etl:77', { kind: 'owner' });
    expect(receipt).toMatchObject({ ok: false, code: 'stop_failed' });
    expect(receipt.error).toBe(`${DATANET_SIGN_IN_REFUSED}, so Datanet did not get the stop; run 77 keeps running.`);
    expect(receipt.nextAction).toBe('Ask the owner to run mwinit -o -s in Terminal (or Connections → Datanet ETL → Refresh Midway + Sentry), then stop it once more.');
    expect(t.ledger.stoppedMessage('77')).toBeNull();
  });
  it('a stop Datanet took, whose check is then refused at sign-in, says the end is not known and names the fix', async () => {
    const t = setup();
    t.ledger.beginEtl({ runId: '77', origin: { kind: 'main' } });
    t.etlCall.mockImplementation(async (tool: string) => (tool === 'datanet_alter_run'
      ? { isError: false, text: '{"ok":true}' }
      : { isError: false, text: PAGE }));
    const receipt = await t.control.stop('etl:77', { kind: 'owner' });
    expect(receipt).toMatchObject({ ok: true, state: 'still_running', verified: false });
    expect(receipt.nextAction).toBe("Datanet took the stop, then refused BotBoy's sign-in when it checked run 77 (Amazon device check or Midway expired), so whether it ended is not known. To fix it, run mwinit -o -s in Terminal (or Connections → Datanet ETL → Refresh Midway + Sentry), then check Running queries again.");
  });
});
