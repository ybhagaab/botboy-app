import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import {
  SQL_CONTROL_MARKER,
  createQueryLedger,
  getQueryLedger,
  isConnectionLost,
  isControlSql,
  isTrackedSqlTool,
  markControlSql,
  markSql,
  markerOf,
  stoppedWords,
  type QueryLedger,
} from './query-ledger.js';

/**
 * BotBoy's own warehouse queries (docs/maps/query-control.md): the marker every SQL call carries, the record of who started
 * what, and the words a stopped query is reported with.
 */
const CALL = '194ffb41-6e62-4459-9342-e8611a4691ac';

describe('the SQL marker', () => {
  it('leads the SQL, so the warehouse history (first 4,000 characters) keeps it, and reads back as the call id', () => {
    const sent = markSql(CALL, 'SELECT 1');
    expect(sent).toBe(`/* botboy:q=${CALL} */ SELECT 1`);
    expect(markerOf(sent)).toBe(CALL);
    expect(markerOf(`DECLARE mcp_c CURSOR FOR ${sent}`)).toBe(CALL);
    expect(markerOf(sent.toUpperCase())).toBe(CALL);
    expect(markerOf('SELECT 1')).toBeNull();
    expect(markerOf(markControlSql('SELECT 1'))).toBeNull();
  });

  it('marks query control\'s own lookups apart from any call', () => {
    expect(markControlSql('SELECT 1')).toBe(`${SQL_CONTROL_MARKER} SELECT 1`);
    expect(isControlSql(markControlSql('SELECT 1'))).toBe(true);
    expect(isControlSql(`DECLARE mcp_c CURSOR FOR ${markControlSql('SELECT 1')}`)).toBe(true);
    expect(isControlSql(markSql(CALL, 'SELECT 1'))).toBe(false);
    expect(isTrackedSqlTool('run_query')).toBe(true);
    expect(isTrackedSqlTool('export_query')).toBe(true);
    expect(isTrackedSqlTool('fetch_rows')).toBe(false);
  });
});

describe('isConnectionLost', () => {
  it('reads a broken connection as lost (the warehouse may still run the query), and a query failure as not', () => {
    for (const text of [
      'Error: Could not reach the database server at vpce-0cfaee168d10434e7.vpce.amazonaws.com',
      'MCP error -32000: Connection closed',
      'read ECONNRESET',
      'connect ETIMEDOUT 10.0.0.1:5439',
      'server closed the connection unexpectedly',
      'terminating connection due to administrator command',
    ]) expect(isConnectionLost(text), text).toBe(true);
    for (const text of ['Error: syntax error at or near "FORM"', 'MCP error -32001: Request timed out', 'permission denied for relation x', '', null]) {
      expect(isConnectionLost(text), String(text)).toBe(false);
    }
  });
});

describe('the query ledger', () => {
  let db: Database.Database;
  let ledger: QueryLedger;
  let clock: number;
  beforeEach(() => {
    db = new Database(':memory:');
    clock = Date.parse('2026-11-12T08:00:00.000Z');
    ledger = createQueryLedger(db, { now: () => clock });
  });
  afterEach(() => db.close());

  it('is found through its database, and only there', () => {
    expect(getQueryLedger(db)).toBe(ledger);
    expect(getQueryLedger(new Database(':memory:'))).toBeNull();
    expect(getQueryLedger(null)).toBeNull();
  });

  it('records a SQL call with who started it, keeps it in flight until it ends, and folds its preview', () => {
    const controller = new AbortController();
    ledger.beginSql({ callId: CALL, serverId: 'sql-context', toolName: 'run_query', origin: { kind: 'job', jobId: 'cj_1', label: 'Overlap   query' }, sql: 'SELECT\n  a,\n  b FROM t', controller });
    expect(ledger.inFlightById(CALL)?.controller).toBe(controller);
    expect(ledger.get(CALL)).toMatchObject({ kind: 'sql', origin: 'job', jobId: 'cj_1', label: 'Overlap query', preview: 'SELECT a, b FROM t', endedAt: null, bootId: ledger.bootId });
    ledger.endSql(CALL, 'lost', 'Could not reach the database server');
    expect(ledger.inFlight()).toEqual([]);
    expect(ledger.get(CALL)).toMatchObject({ endState: 'lost', endNote: 'Could not reach the database server' });
  });

  it('a stop recorded before the call ends is not overwritten by the ending its reader reports', () => {
    ledger.beginSql({ callId: CALL, serverId: 'sql-context', toolName: 'run_query', origin: { kind: 'main' }, sql: 'SELECT 1', controller: new AbortController() });
    ledger.markStopRequested(CALL, 'owner', 'wrong window');
    ledger.markStopped(CALL);
    ledger.endSql(CALL, 'failed', 'cancelled');
    expect(ledger.get(CALL)).toMatchObject({ endState: 'stopped', stoppedBy: 'owner', endNote: 'wrong window' });
  });

  it('a stop that could not be sent is forgotten, a confirmed one is kept', () => {
    ledger.beginSql({ callId: CALL, serverId: 'sql-context', toolName: 'run_query', origin: { kind: 'main' }, sql: 'SELECT 1', controller: new AbortController() });
    ledger.markStopRequested(CALL, 'main', 'stuck');
    ledger.clearStopRequest(CALL);
    expect(ledger.get(CALL)).toMatchObject({ stoppedBy: null, endNote: null });
    ledger.markStopRequested(CALL, 'main');
    ledger.markStopped(CALL);
    ledger.clearStopRequest(CALL);
    expect(ledger.get(CALL)).toMatchObject({ stoppedBy: 'main', endState: 'stopped' });
  });

  it('records a Datanet run once by its numeric id, and ends it only on a terminal status', () => {
    ledger.beginEtl({ runId: 'not-a-run' });
    ledger.beginEtl({ runId: '13236042515', origin: { kind: 'job', jobId: 'cj_2' }, sql: '/* NO DEPENDENCIES */ SELECT 2', label: 'Weekly streams' });
    ledger.beginEtl({ runId: '13236042515', origin: { kind: 'main' } });
    expect(ledger.forRun('13236042515')).toMatchObject({ id: 'etl:13236042515', kind: 'etl', origin: 'job', jobId: 'cj_2', label: 'Weekly streams', preview: 'SELECT 2' });
    expect(ledger.get('etl:not-a-run')).toBeNull();
    // Datanet's own states (datanet-run-states.ts): CANCELLING is a stop under way, CANCELLED an end; there is no KILLED.
    for (const going of ['EXECUTING', 'WAITING_FOR_RESOURCES', 'CANCELLING', 'PUBLISHING', 'KILLED']) {
      ledger.endEtl('13236042515', going);
      expect(ledger.forRun('13236042515')?.endedAt, going).toBeNull();
    }
    ledger.endEtl('13236042515', 'cancelled');
    expect(ledger.forRun('13236042515')).toMatchObject({ endState: 'cancelled' });
  });

  it('a cancelled run BotBoy was asked to stop ends as stopped, even when the stop\'s own check never saw it end', () => {
    ledger.beginEtl({ runId: '13257595845', origin: { kind: 'job', jobId: 'cj_5' } });
    ledger.markStopRequested('etl:13257595845', 'owner');
    ledger.endEtl('13257595845', 'CANCELLED');
    expect(ledger.forRun('13257595845')).toMatchObject({ endState: 'stopped', stoppedBy: 'owner' });
    expect(ledger.openSince('2000-01-01T00:00:00.000Z').map(row => row.id)).not.toContain('etl:13257595845');
    ledger.beginEtl({ runId: '13257595846', origin: { kind: 'main' } });
    ledger.endEtl('13257595846', 'ERROR');
    expect(ledger.forRun('13257595846')).toMatchObject({ endState: 'error' });
  });

  it('a run stopped on purpose is reported in words that keep it from being resubmitted', () => {
    ledger.beginEtl({ runId: '77' });
    expect(ledger.stoppedMessage('77')).toBeNull();
    ledger.markStopRequested('etl:77', 'job:cj_2', 'superseded by a narrower query');
    const words = ledger.stoppedMessage('77')!;
    expect(words).toContain('Stopped on purpose by the job that started it.');
    expect(words).toContain('Reason: superseded by a narrower query');
    expect(words).toMatch(/Do not resubmit/);
    expect(stoppedWords('owner')).toMatch(/^Stopped on purpose by the owner \(Running queries in the chat panel\)\. Do not resubmit/);
    expect(stoppedWords('main')).toContain('the main chat that started it');
    expect(stoppedWords('owner-chat')).toMatch(/^Stopped on purpose by the owner, who asked for it in chat\. Do not resubmit/);
  });

  it('suspects lost and never-ended SQL for 48 hours, and timed-out or cancelled SQL for 30 minutes', () => {
    const begin = (id: string, minutesAgo: number) => {
      clock = Date.parse('2026-11-12T08:00:00.000Z') - minutesAgo * 60_000;
      ledger.beginSql({ callId: id, serverId: 'sql-context', toolName: 'run_query', origin: { kind: 'main' }, sql: 'SELECT 1', controller: new AbortController() });
    };
    begin('a', 60 * 40); ledger.endSql('a', 'lost', 'Connection closed');
    begin('b', 60 * 50); ledger.endSql('b', 'lost', 'Connection closed'); // older than 48 h
    begin('c', 60 * 2); // never ended
    begin('d', 20); ledger.endSql('d', 'failed', 'Request timed out');
    begin('e', 90); ledger.endSql('e', 'cancelled', 'aborted');
    begin('f', 10); ledger.endSql('f', 'completed');
    clock = Date.parse('2026-11-12T08:00:00.000Z');
    const since = new Date(clock - 48 * 3_600_000).toISOString();
    const recent = new Date(clock - 30 * 60_000).toISOString();
    expect(ledger.sqlSuspects(since, recent).map(row => row.id).sort()).toEqual(['a', 'c', 'd']);
  });

  it('keeps 14 days of rows', () => {
    ledger.beginEtl({ runId: '1', startedAt: '2026-10-20T00:00:00.000Z' });
    ledger.beginEtl({ runId: '2', startedAt: '2026-11-10T00:00:00.000Z' });
    createQueryLedger(db, { now: () => clock });
    expect(getQueryLedger(db)!.forRun('1')).toBeNull();
    expect(getQueryLedger(db)!.forRun('2')).not.toBeNull();
  });
});
