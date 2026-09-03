import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createStorage, type StorageLayer } from './storage.js';
import { createAnalyticsDashboardService } from './analytics-dashboard.js';
import { selectDashboardLane } from './analytics-runners.js';
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
