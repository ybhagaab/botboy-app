import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createStorage, type StorageLayer } from './storage.js';
import { createNodeManager } from './node-manager.js';
import { createToolExecutor, type ToolExecutionContext } from './tool-executor.js';
import { createQueryLedger, type QueryLedger } from './query-ledger.js';
import { createQueryControl, type QueryControl } from './query-control.js';

/**
 * cancel_query (docs/maps/query-control.md; owner request 2026-11-12): a job and the main chat stop the queries they started;
 * in a live owner turn, ownerRequested (the owner asked) reaches any of BotBoy's queries; nothing else runs it. Every SQL call a
 * turn starts is recorded as that turn's: the main chat's, a job's (its own turns and the owner's turns in its thread), or
 * BotBoy's.
 */
describe('cancel_query', () => {
  let storage: StorageLayer;
  let ledger: QueryLedger;
  let control: QueryControl;
  let callTool: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    storage = createStorage(':memory:');
    storage.initialize();
    ledger = createQueryLedger(storage.getDb());
    callTool = vi.fn(async (serverId: string, toolName: string) => {
      if (serverId === 'a2-analytics' && toolName === 'datanet_submit_run') return { serverId, toolName, isError: false, text: JSON.stringify({ jobRuns: [{ id: 4242 }] }), durationMs: 1 };
      // The warehouse lookups of a stop: the call never reached it.
      return { serverId, toolName, isError: false, text: JSON.stringify({ columns: [], rows: [] }), durationMs: 1 };
    });
    control = createQueryControl({ db: storage.getDb(), ledger, mcpManager: { callTool } as any, sleep: async () => {} });
  });
  afterEach(() => storage.close());

  const executor = (withControl = true) => createToolExecutor(storage.getDb(), createNodeManager(storage.getDb()), {
    mcpManager: { callTool } as any,
    ...(withControl ? { queryControl: control } : {}),
  });
  const run = async (args: Record<string, unknown>, context?: ToolExecutionContext, withControl = true) => {
    const result = await executor(withControl).executeTool({ id: 'cq-1', type: 'function', function: { name: 'cancel_query', arguments: JSON.stringify(args) } }, context);
    return { ...JSON.parse(result.content), isError: result.isError === true };
  };
  const flight = (id: string, origin: any) => {
    const controller = new AbortController();
    ledger.beginSql({ callId: id, serverId: 'sql-context', toolName: 'run_query', origin, sql: `SELECT '${id}'`, controller });
    controller.signal.addEventListener('abort', () => ledger.endSql(id, 'stopped'));
    return controller;
  };
  const MAIN = 'aaaaaaaa-0000-4000-8000-000000000001';
  const JOB5 = 'bbbbbbbb-0000-4000-8000-000000000002';
  const JOB6 = 'cccccccc-0000-4000-8000-000000000003';
  const DASH = 'dddddddd-0000-4000-8000-000000000004';
  const owner = (over: Partial<ToolExecutionContext> = {}): ToolExecutionContext => ({ callerKind: 'interactive', currentUserMessage: 'stop it', ownerRequestId: 'req-1', ...over });
  const continuation = (jobId: string): ToolExecutionContext => ({ callerKind: 'continuation', jobMandate: { jobId, goal: 'g' } } as ToolExecutionContext);
  const seed = () => {
    flight(MAIN, { kind: 'main' });
    flight(JOB5, { kind: 'job', jobId: 'cj_5' });
    flight(JOB6, { kind: 'job', jobId: 'cj_6' });
    flight(DASH, { kind: 'dashboard', label: 'Dashboard "Weekly", widget "Streams"' });
  };

  it('a job\'s own turn lists and stops only its own queries; ownerRequested never widens it there', async () => {
    seed();
    const listed = await run({ action: 'list' }, continuation('cj_5'));
    expect(listed.queries.map((query: any) => [query.id, query.yours])).toEqual([[JOB5, true]]);
    expect(listed.otherQueries).toMatch(/^3 more of BotBoy's queries are running for other conversations; only the owner can stop them/);
    const refused = await run({ action: 'cancel', id: MAIN, ownerRequested: true }, continuation('cj_5'));
    expect(refused).toMatchObject({ ok: false, code: 'not_yours', isError: true });
    expect(ledger.inFlightById(MAIN)).toBeDefined();
    const stopped = await run({ action: 'cancel', id: JOB5, reason: 'superseded' }, continuation('cj_5'));
    expect(stopped).toMatchObject({ ok: true, state: 'stopped', isError: false });
    expect(ledger.get(JOB5)).toMatchObject({ stoppedBy: 'job:cj_5', endNote: 'superseded' });
  });

  it('the main chat sees every query, marked yours or not, and stops another\'s only when the owner asked', async () => {
    seed();
    const listed = await run({ action: 'list' }, owner({ startedJobIds: ['cj_6'] }));
    expect(Object.fromEntries(listed.queries.map((query: any) => [query.id, query.yours]))).toEqual({ [MAIN]: true, [JOB5]: false, [JOB6]: true, [DASH]: false });
    expect(listed.queries.find((query: any) => query.id === DASH)).toMatchObject({ what: 'Dashboard "Weekly", widget "Streams"', startedBy: 'a dashboard refresh', where: 'BotBoy is waiting on it' });
    const refused = await run({ action: 'cancel', id: DASH }, owner());
    expect(refused).toMatchObject({ ok: false, code: 'not_yours' });
    expect(refused.nextAction).toMatch(/ownerRequested true/);
    expect(await run({ action: 'cancel', id: DASH, ownerRequested: true }, owner())).toMatchObject({ ok: true, state: 'stopped' });
    expect(ledger.get(DASH)).toMatchObject({ stoppedBy: 'owner-chat', endState: 'stopped' });
  });

  it('an owner turn in a job\'s thread works for that job, sees every query, and stops another\'s only when the owner asked', async () => {
    seed();
    const listed = await run({ action: 'list' }, owner({ threadJobId: 'cj_6' }));
    expect(Object.fromEntries(listed.queries.map((query: any) => [query.id, query.yours]))).toEqual({ [MAIN]: false, [JOB5]: false, [JOB6]: true, [DASH]: false });
    expect(listed.otherQueries).toBeUndefined();
    expect(await run({ action: 'cancel', id: JOB6 }, owner({ threadJobId: 'cj_6' }))).toMatchObject({ ok: true });
    expect(ledger.get(JOB6)).toMatchObject({ stoppedBy: 'job:cj_6' });
    expect(await run({ action: 'cancel', id: MAIN }, owner({ threadJobId: 'cj_6' }))).toMatchObject({ ok: false, code: 'not_yours' });
    expect(await run({ action: 'cancel', id: MAIN, ownerRequested: true }, owner({ threadJobId: 'cj_6' }))).toMatchObject({ ok: true, state: 'stopped' });
    expect(ledger.get(MAIN)).toMatchObject({ stoppedBy: 'owner-chat' });
  });

  it('runs only in the owner\'s chat and in jobs, and says so when stopping queries is not wired', async () => {
    seed();
    for (const context of [{ callerKind: 'background' }, { callerKind: 'review' }, undefined] as Array<ToolExecutionContext | undefined>) {
      expect(await run({ action: 'list' }, context)).toMatchObject({ ok: false, code: 'not_available', isError: true });
    }
    expect(await run({ action: 'list' }, owner(), false)).toMatchObject({ ok: false, code: 'unavailable', isError: true });
    expect(await run({ action: 'stop' }, owner())).toMatchObject({ ok: false, isError: true });
    expect(ledger.inFlight()).toHaveLength(4);
  });

  it('records each SQL call as the turn\'s own: the main chat, a job, or BotBoy', async () => {
    const origins: unknown[] = [];
    callTool.mockImplementation(async (serverId: string, toolName: string, _args: unknown, options: any) => {
      origins.push(options.queryOrigin);
      return { serverId, toolName, isError: false, text: 'ok', durationMs: 1 };
    });
    const sql = async (context: ToolExecutionContext) => executor().executeTool({ id: 'q', type: 'function', function: { name: 'mcp_sql_query', arguments: JSON.stringify({ sql: 'SELECT 1' }) } }, context);
    await sql(owner());
    await sql(owner({ threadJobId: 'cj_6' }));
    await sql(continuation('cj_5'));
    await sql({ callerKind: 'background' });
    expect(origins).toEqual([{ kind: 'main' }, { kind: 'job', jobId: 'cj_6' }, { kind: 'job', jobId: 'cj_5' }, { kind: 'botboy' }]);
  });

  it('a kill through mcp_etl_alter_run is a stop on purpose too; a kill Datanet refused is not', async () => {
    ledger.beginEtl({ runId: '77', origin: { kind: 'job', jobId: 'cj_5' } });
    ledger.beginEtl({ runId: '78', origin: { kind: 'job', jobId: 'cj_5' } });
    callTool.mockImplementation(async (serverId: string, toolName: string, args: any) => ({
      serverId, toolName, durationMs: 1,
      ...(args.run_id === '78' ? { isError: true, text: 'Datanet: run 78 cannot be killed now' } : { isError: false, text: '{"ok":true}' }),
    }));
    const kill = (runId: string) => executor().executeTool({ id: 'k', type: 'function', function: { name: 'mcp_etl_alter_run', arguments: JSON.stringify({ runId, action: 'kill', reason: 'superseded', ownerRequested: true }) } }, continuation('cj_5'));
    await kill('77');
    expect(callTool).toHaveBeenCalledWith('a2-analytics', 'datanet_alter_run', { run_id: '77', action: 'KILL_SESSION', reason: 'superseded' }, expect.objectContaining({ ownerApproved: true }));
    expect(ledger.stoppedMessage('77')).toMatch(/^Stopped on purpose by the job that started it\. Reason: superseded\. Do not resubmit/);
    await kill('78');
    expect(ledger.stoppedMessage('78')).toBeNull();
  });

  it('an ETL run the owner had BotBoy submit is listed as the turn\'s own', async () => {
    const result = await executor().executeTool({ id: 's', type: 'function', function: { name: 'mcp_etl_submit_run', arguments: JSON.stringify({ jobId: '123', datasetDate: '2026-11-01', ownerRequested: true }) } }, owner());
    expect(result.isError).not.toBe(true);
    expect(ledger.forRun('4242')).toMatchObject({ id: 'etl:4242', origin: 'main', label: 'ETL job 123 for 2026-11-01' });
  });
});
