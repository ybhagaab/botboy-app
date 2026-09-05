import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createStorage, type StorageLayer } from './storage.js';
import { createAnalyticsDashboardService, type AnalyticsRunFailureEvent } from './analytics-dashboard.js';
import { selectDashboardLane, classifyWidgetFailure } from './analytics-runners.js';
import type { AnalyticsDashboardService } from './analytics-types.js';
import type { McpManager, McpServerSnapshot } from './mcp-types.js';
import type { QueryRunner, QueryRunResult } from './etl-adhoc.js';

/**
 * Dashboard data lanes (etl-analytics A4): sql-context primacy with an
 * availability-switched Datanet ETL fallback. Invariants under test:
 *   - the lane is chosen once per RUN from live server state;
 *   - sql-context running ⇒ the ETL runner is never consulted;
 *   - ETL lane serializes widgets (one scratch pair) and stamps lane
 *     provenance on every result with sql-lane-identical cell coercion;
 *   - a non-ok composite outcome fails ONLY that widget, with the runner's
 *     actionable message (error + nextAction) preserved.
 */

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

function server(id: string, overrides: Partial<McpServerSnapshot> = {}): McpServerSnapshot {
  return {
    id,
    kind: 'managed',
    displayName: id,
    enabled: true,
    configured: true,
    state: 'running',
    packageVersion: '1.0.0',
    tools: [],
    restartCount: 0,
    updatedAt: new Date().toISOString(),
    ...overrides,
  } as McpServerSnapshot;
}

const SQL_RESULT = [
  'value',
  '-----',
  '7',
  '1 rows returned. (3ms)',
].join('\n');

describe('analytics dashboard lanes (A4)', () => {
  let storage: StorageLayer;
  let sqlLaneCalls: string[];

  beforeEach(() => {
    storage = createStorage(':memory:');
    storage.initialize();
    sqlLaneCalls = [];
  });
  afterEach(() => storage.close());

  const db = () => storage.getDb();

  function fakeMcp(servers: McpServerSnapshot[]): McpManager {
    return {
      listServers: async () => servers,
      callTool: async (_server: string, _tool: string, args: any) => {
        sqlLaneCalls.push(String(args?.sql ?? ''));
        return { isError: false, text: SQL_RESULT };
      },
    } as unknown as McpManager;
  }

  function fakeEtlRunner(config: {
    outcome?: (sql: string) => QueryRunResult;
    delayMs?: number;
  } = {}) {
    let inFlight = 0;
    let maxInFlight = 0;
    const sqls: string[] = [];
    const runner: QueryRunner = {
      id: 'etl-adhoc',
      runQuery: async ({ sql }) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        sqls.push(sql);
        if (config.delayMs) await sleep(config.delayMs);
        inFlight -= 1;
        return config.outcome
          ? config.outcome(sql)
          : { ok: true, runId: '9001', columns: ['value'], rows: [['42']], rowCount: 1 };
      },
    };
    return { runner, stats: () => ({ maxInFlight, sqls }) };
  }

  function makeService(servers: McpServerSnapshot[], etlRunner?: QueryRunner): AnalyticsDashboardService {
    return createAnalyticsDashboardService({ db: db(), mcpManager: fakeMcp(servers), etlRunner });
  }

  function widgetResults(dashboardId: string): Array<{ title: string; result: any; lastError: string | null }> {
    return (db().prepare(
      'SELECT title, result_json, last_error FROM analytics_widgets WHERE dashboard_id = ? ORDER BY position',
    ).all(dashboardId) as any[]).map(row => ({
      title: row.title,
      result: row.result_json ? JSON.parse(row.result_json) : null,
      lastError: row.last_error,
    }));
  }

  it('selectDashboardLane: sql-context primacy, ETL only when SQL is down and ETL usable', () => {
    const sqlUp = server('sql-context');
    const sqlDown = server('sql-context', { state: 'stopped' });
    const etlOk = server('a2-analytics', { state: 'stopped' }); // state irrelevant: enabled+configured is the bar
    const etlUnconfigured = server('a2-analytics', { configured: false });
    expect(selectDashboardLane([sqlUp, etlOk])).toBe('sql-mcp');
    expect(selectDashboardLane([sqlDown, etlOk])).toBe('etl');
    expect(selectDashboardLane([sqlDown, etlUnconfigured])).toBe('sql-mcp'); // no lane to switch to
    expect(selectDashboardLane([etlOk])).toBe('etl');                        // no sql server at all
    expect(selectDashboardLane([])).toBe('sql-mcp');
  });

  it('sql-context running: the ETL runner is never consulted and results carry the sql-mcp lane', async () => {
    const etl = fakeEtlRunner();
    const service = makeService([server('sql-context'), server('a2-analytics')], etl.runner);
    const dashboard = service.createDashboard({
      title: 'SQL lane',
      widgets: [{ kind: 'metric', title: 'M', sql: 'SELECT 7' }],
    } as any);
    service.enqueueRefresh(dashboard.id, 'manual');
    expect(await service.processQueuedRuns(1)).toBe(1);

    expect(etl.stats().sqls).toEqual([]);
    expect(sqlLaneCalls).toEqual(['SELECT 7']);
    const [widget] = widgetResults(dashboard.id);
    expect(widget.result.lane).toBe('sql-mcp');
    expect(widget.result.rows).toEqual([[7]]);
  });

  it('sql-context down + ETL usable: widgets run through the composite, serialized, with lane provenance and coerced cells', async () => {
    const etl = fakeEtlRunner({ delayMs: 15 });
    const service = makeService(
      [server('sql-context', { state: 'stopped' }), server('a2-analytics', { state: 'stopped' })],
      etl.runner,
    );
    const dashboard = service.createDashboard({
      title: 'ETL lane',
      widgets: [
        { kind: 'metric', title: 'W1', sql: 'SELECT 1' },
        { kind: 'metric', title: 'W2', sql: 'SELECT 2' },
        { kind: 'metric', title: 'W3', sql: 'SELECT 3' },
      ],
    } as any);
    service.enqueueRefresh(dashboard.id, 'manual');
    expect(await service.processQueuedRuns(1)).toBe(1);

    expect(sqlLaneCalls).toEqual([]); // sql lane untouched
    expect(etl.stats().sqls.sort()).toEqual(['SELECT 1', 'SELECT 2', 'SELECT 3']);
    expect(etl.stats().maxInFlight).toBe(1); // ONE scratch pair — never concurrent

    for (const widget of widgetResults(dashboard.id)) {
      expect(widget.result.lane).toBe('etl');
      expect(widget.result.rows).toEqual([[42]]); // '42' string coerced like the sql lane
      expect(widget.result.rowCount).toBe(1);
      expect(widget.result.trust).toBe('external_untrusted_data');
    }
    const run = db().prepare('SELECT status FROM analytics_runs LIMIT 1').get() as any;
    expect(run.status).toBe('completed');
  });

  it('a non-ok composite outcome fails only that widget and preserves error + nextAction', async () => {
    const etl = fakeEtlRunner({
      outcome: (sql) => sql.includes('2')
        ? { ok: false, runId: '777', error: 'Run 777 still WAITING_FOR_RESOURCES after 30 minutes.', nextAction: 'Check later with mcp_etl_job_run.' }
        : { ok: true, columns: ['value'], rows: [['1']], rowCount: 1 },
    });
    const service = makeService(
      [server('sql-context', { state: 'stopped' }), server('a2-analytics')],
      etl.runner,
    );
    const dashboard = service.createDashboard({
      title: 'Partial failure',
      widgets: [
        { kind: 'metric', title: 'Good', sql: 'SELECT 1' },
        { kind: 'metric', title: 'Queued', sql: 'SELECT 2' },
      ],
    } as any);
    service.enqueueRefresh(dashboard.id, 'manual');
    expect(await service.processQueuedRuns(1)).toBe(1);

    const [good, queued] = widgetResults(dashboard.id);
    expect(good.result.lane).toBe('etl');
    expect(good.lastError).toBeNull();
    expect(queued.result).toBeNull();
    expect(queued.lastError).toContain('WAITING_FOR_RESOURCES');
    expect(queued.lastError).toContain('Check later');
    const dash = db().prepare('SELECT status FROM analytics_dashboards WHERE id = ?').get(dashboard.id) as any;
    expect(dash.status).toBe('degraded');
  });

  it('without an ETL runner, behavior is exactly pre-A4 even when sql-context is down', async () => {
    const service = makeService([server('sql-context', { state: 'stopped' })]);
    const dashboard = service.createDashboard({
      title: 'Legacy',
      widgets: [{ kind: 'metric', title: 'M', sql: 'SELECT 7' }],
    } as any);
    service.enqueueRefresh(dashboard.id, 'manual');
    expect(await service.processQueuedRuns(1)).toBe(1);
    // The sql lane was attempted (and, with this fake, succeeded) — no rerouting.
    expect(sqlLaneCalls).toEqual(['SELECT 7']);
    const [widget] = widgetResults(dashboard.id);
    expect(widget.result.lane).toBe('sql-mcp');
  });
});

/**
 * Cross-lane retry + failure escalation (incident 2026-09-04: a Prime
 * dashboard lost 3 widgets to mid-run network loss and 2 to a SQL dialect
 * bug; the network class was recoverable on the other lane, the SQL class
 * never is — and nobody was told). Invariants under test:
 *   - failure classification: SQL/content vs infrastructure;
 *   - infra failures get ONE retry on the OTHER lane when usable;
 *   - content failures are never retried cross-lane;
 *   - a run that still has failures after the retry pass escalates exactly
 *     once through onRunFailure with the full failure list.
 */
describe('cross-lane retry + escalation', () => {
  let storage: StorageLayer;

  beforeEach(() => {
    storage = createStorage(':memory:');
    storage.initialize();
  });
  afterEach(() => storage.close());

  const db = () => storage.getDb();

  it('classifyWidgetFailure: the live incident errors classify correctly', () => {
    // The two real Prime-widget errors from run_48c9ba7b04014d76:
    expect(classifyWidgetFailure(
      'Run 12866393723 ERROR. Summary: Your query failed due to a non-retryable error. (SQL Error: ERROR: function pg_catalog.date_add("unknown", integer, character varying) does not exist Hint: No function matches the given name and argument types.)',
    )).toBe('content');
    expect(classifyWidgetFailure('MCP error -32001: Request timed out')).toBe('infra');
    // Adjacent real-world shapes:
    expect(classifyWidgetFailure('Not connected: ')).toBe('infra');
    expect(classifyWidgetFailure('SQL must be a single statement')).toBe('content');
    expect(classifyWidgetFailure('ERROR: syntax error at or near "SELCT"')).toBe('content');
    expect(classifyWidgetFailure('Numeric value out of range: int4 overflow')).toBe('content');
    expect(classifyWidgetFailure('Run 777 still WAITING_FOR_RESOURCES after 30 minutes.')).toBe('infra');
    expect(classifyWidgetFailure('Error: the Datanet ETL call datanet_submit_run timed out after 5 min — the transport, not the query.')).toBe('infra');
    expect(classifyWidgetFailure(null)).toBe('infra'); // unknown defaults to the cheap retry
  });

  function servers(overrides: { sqlState?: string; etlConfigured?: boolean } = {}) {
    return [
      {
        id: 'sql-context', kind: 'managed', displayName: 'sql', enabled: true, configured: true,
        state: overrides.sqlState ?? 'running', packageVersion: '1', tools: [], restartCount: 0, updatedAt: 'x',
      },
      {
        id: 'a2-analytics', kind: 'managed', displayName: 'a2', enabled: true,
        configured: overrides.etlConfigured ?? true,
        state: 'stopped', packageVersion: '1', tools: [], restartCount: 0, updatedAt: 'x',
      },
    ] as unknown as McpServerSnapshot[];
  }

  it('infra failure on the sql lane retries once on the ETL lane and recovers', async () => {
    const events: AnalyticsRunFailureEvent[] = [];
    const etlSqls: string[] = [];
    const mcp = {
      listServers: async () => servers(),
      callTool: async () => { throw new Error('MCP error -32001: Request timed out'); },
    } as unknown as McpManager;
    const etlRunner: QueryRunner = {
      id: 'etl-adhoc',
      runQuery: async ({ sql }) => {
        etlSqls.push(sql);
        return { ok: true, runId: '9001', columns: ['value'], rows: [['42']], rowCount: 1 };
      },
    };
    const service = createAnalyticsDashboardService({
      db: db(), mcpManager: mcp, etlRunner,
      onRunFailure: async event => { events.push(event); },
    });
    const dashboard = service.createDashboard({
      title: 'Retry recovers',
      widgets: [{ kind: 'metric', title: 'M', sql: 'SELECT 7' }],
    } as any);
    service.enqueueRefresh(dashboard.id, 'manual');
    expect(await service.processQueuedRuns(1)).toBe(1);

    expect(etlSqls).toEqual(['SELECT 7']); // retried through the composite
    const widget = (db().prepare('SELECT result_json, last_error FROM analytics_widgets WHERE dashboard_id = ?').get(dashboard.id)) as any;
    expect(widget.last_error).toBeNull();
    expect(JSON.parse(widget.result_json).lane).toBe('etl'); // provenance = the lane that actually produced the data
    const run = db().prepare('SELECT status, widgets_succeeded FROM analytics_runs LIMIT 1').get() as any;
    expect(run.status).toBe('completed');
    expect(run.widgets_succeeded).toBe(1);
    expect(events).toEqual([]); // recovered — nothing to escalate
  });

  it('content failure is NOT retried cross-lane and escalates exactly once with the failure list', async () => {
    const events: AnalyticsRunFailureEvent[] = [];
    const etlSqls: string[] = [];
    const contentError = 'SQL Error: ERROR: function pg_catalog.date_add("unknown", integer, character varying) does not exist';
    const mcp = {
      listServers: async () => servers(),
      callTool: async () => { throw new Error(contentError); },
    } as unknown as McpManager;
    const etlRunner: QueryRunner = {
      id: 'etl-adhoc',
      runQuery: async ({ sql }) => {
        etlSqls.push(sql);
        return { ok: true, columns: ['value'], rows: [['1']], rowCount: 1 };
      },
    };
    const service = createAnalyticsDashboardService({
      db: db(), mcpManager: mcp, etlRunner,
      onRunFailure: async event => { events.push(event); },
    });
    const dashboard = service.createDashboard({
      title: 'Content failure',
      widgets: [{ kind: 'metric', title: 'Broken cast', sql: 'SELECT 7' }],
    } as any);
    service.enqueueRefresh(dashboard.id, 'manual');
    expect(await service.processQueuedRuns(1)).toBe(1);

    expect(etlSqls).toEqual([]); // same warehouse — a content error would fail identically
    const run = db().prepare('SELECT status FROM analytics_runs LIMIT 1').get() as any;
    expect(run.status).toBe('failed');
    expect(events).toHaveLength(1);
    expect(events[0].dashboardTitle).toBe('Content failure');
    expect(events[0].lane).toBe('sql-mcp');
    expect(events[0].failures).toHaveLength(1);
    expect(events[0].failures[0].title).toBe('Broken cast');
    expect(events[0].failures[0].error).toContain('date_add');
  });

  it('infra failure on the ETL lane retries on sql-mcp when the connector came back mid-run', async () => {
    const events: AnalyticsRunFailureEvent[] = [];
    let listCalls = 0;
    const sqlLaneSqls: string[] = [];
    const mcp = {
      // First listServers = pickRunLane (sql down → etl primary); later
      // calls = the retry pass (sql back up → retry lane usable). Models
      // last night in reverse: connectivity returning mid-run.
      listServers: async () => {
        listCalls += 1;
        return servers({ sqlState: listCalls === 1 ? 'stopped' : 'running' });
      },
      callTool: async (_s: string, _t: string, args: any) => {
        sqlLaneSqls.push(String(args?.sql ?? ''));
        return { isError: false, text: SQL_RESULT };
      },
    } as unknown as McpManager;
    const etlRunner: QueryRunner = {
      id: 'etl-adhoc',
      runQuery: async () => ({
        ok: false,
        error: 'Error: the Datanet ETL call datanet_submit_run timed out after 5 min — the transport, not the query.',
        nextAction: 'Check connectivity, then retry ONCE.',
      }),
    };
    const service = createAnalyticsDashboardService({
      db: db(), mcpManager: mcp, etlRunner,
      onRunFailure: async event => { events.push(event); },
    });
    const dashboard = service.createDashboard({
      title: 'ETL to SQL retry',
      widgets: [{ kind: 'metric', title: 'M', sql: 'SELECT 7' }],
    } as any);
    service.enqueueRefresh(dashboard.id, 'manual');
    expect(await service.processQueuedRuns(1)).toBe(1);

    expect(sqlLaneSqls).toEqual(['SELECT 7']); // recovered through the connector
    const widget = (db().prepare('SELECT result_json, last_error FROM analytics_widgets WHERE dashboard_id = ?').get(dashboard.id)) as any;
    expect(widget.last_error).toBeNull();
    expect(JSON.parse(widget.result_json).lane).toBe('sql-mcp');
    const run = db().prepare('SELECT status FROM analytics_runs LIMIT 1').get() as any;
    expect(run.status).toBe('completed');
    expect(events).toEqual([]);
  });

  it('infra failure with the other lane unusable: no retry, escalation carries the original error', async () => {
    const events: AnalyticsRunFailureEvent[] = [];
    const mcp = {
      listServers: async () => servers({ etlConfigured: false }), // sql up, etl unusable
      callTool: async () => { throw new Error('MCP error -32001: Request timed out'); },
    } as unknown as McpManager;
    const service = createAnalyticsDashboardService({
      db: db(), mcpManager: mcp,
      onRunFailure: async event => { events.push(event); },
    });
    const dashboard = service.createDashboard({
      title: 'No lane left',
      widgets: [{ kind: 'metric', title: 'M', sql: 'SELECT 7' }],
    } as any);
    service.enqueueRefresh(dashboard.id, 'manual');
    expect(await service.processQueuedRuns(1)).toBe(1);

    expect(events).toHaveLength(1);
    expect(events[0].failures[0].error).toContain('Request timed out');
    expect(events[0].failures[0].error).not.toContain('retry also failed'); // no retry was attempted
  });
});

/**
 * Blank-error connectors (live 2026-09-04, second wave): a sql-context whose
 * process is up but whose warehouse connection is dead answers isError with
 * literally "Error: " — 12 widgets showed NO reason on the dashboard.
 */
describe('sql-lane empty error detail', () => {
  let storage: StorageLayer;
  beforeEach(() => {
    storage = createStorage(':memory:');
    storage.initialize();
  });
  afterEach(() => storage.close());

  it('substitutes an actionable message when the connector returns no detail', async () => {
    const mcp = {
      listServers: async () => [] as McpServerSnapshot[], // no other lane
      callTool: async () => ({ isError: true, text: 'Error: ' }),
    } as unknown as McpManager;
    const service = createAnalyticsDashboardService({ db: storage.getDb(), mcpManager: mcp });
    const dashboard = service.createDashboard({
      title: 'Blank error',
      widgets: [{ kind: 'metric', title: 'M', sql: 'SELECT 7' }],
    } as any);
    service.enqueueRefresh(dashboard.id, 'manual');
    expect(await service.processQueuedRuns(1)).toBe(1);

    const widget = storage.getDb().prepare('SELECT last_error FROM analytics_widgets WHERE dashboard_id = ?').get(dashboard.id) as any;
    expect(widget.last_error).toContain('no error detail');
    expect(widget.last_error).toContain('warehouse connection is down');
    expect(classifyWidgetFailure(widget.last_error)).toBe('infra'); // retry pass picks these up
  });
});
