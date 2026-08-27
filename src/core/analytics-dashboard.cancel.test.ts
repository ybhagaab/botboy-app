import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createStorage, type StorageLayer } from './storage.js';
import { createAnalyticsDashboardService } from './analytics-dashboard.js';
import type { AnalyticsDashboardService } from './analytics-types.js';
import type { McpManager } from './mcp-manager.js';

/**
 * Stop-refresh (owner request 2026-08-27): a dashboard refresh can run for
 * a long time (10-15 minute warehouse queries are legitimate), so the owner
 * gets a Stop button. Semantics under test:
 *   - queued runs cancel IMMEDIATELY (terminal 'cancelled', widgets
 *     cancelled, dashboard leaves 'refreshing', the one-active-run slot
 *     frees up);
 *   - running runs are only FLAGGED — the owning worker stops at the next
 *     between-widgets point; the in-flight query's result still persists;
 *   - a cancel is not a failure: schedules keep their failure counters.
 */
describe('analytics stop-refresh', () => {
  let storage: StorageLayer;
  let service: AnalyticsDashboardService;
  let sqlCalls: string[];
  let gate: { resolve: () => void; promise: Promise<void> } | null;
  let onCall: ((sql: string) => void) | null;

  const SQL_RESULT = [
    'value',
    '-----',
    '42',
    '1 rows returned. (3ms)',
  ].join('\n');

  function fakeMcp(): McpManager {
    return {
      callTool: async (_server: string, _tool: string, args: any) => {
        const sql = String(args?.sql || '');
        sqlCalls.push(sql);
        onCall?.(sql);
        if (gate) await gate.promise;
        return { isError: false, text: SQL_RESULT };
      },
    } as unknown as McpManager;
  }

  beforeEach(() => {
    storage = createStorage(':memory:');
    storage.initialize();
    sqlCalls = [];
    gate = null;
    onCall = null;
    service = createAnalyticsDashboardService({ db: storage.getDb(), mcpManager: fakeMcp() });
  });
  afterEach(() => storage.close());

  function createTwoWidgetDashboard() {
    return service.createDashboard({
      title: 'Funnel health',
      widgets: [
        { kind: 'metric', title: 'Visitors', sql: 'SELECT 1' },
        { kind: 'metric', title: 'Streamers', sql: 'SELECT 2' },
      ],
    } as any);
  }

  it('cancels a QUEUED run immediately and frees the active-run slot', () => {
    const dashboard = createTwoWidgetDashboard();
    const run = service.enqueueRefresh(dashboard.id, 'manual');
    expect(run.status).toBe('queued');

    const outcome = service.cancelActiveRun(dashboard.id);
    expect(outcome.result).toBe('cancelled');
    expect(outcome.run?.status).toBe('cancelled');
    expect(outcome.run?.completedAt).toBeTruthy();

    const widgetStates = storage.getDb().prepare(
      'SELECT DISTINCT status FROM analytics_run_widgets WHERE run_id = ?',
    ).all(run.id) as Array<{ status: string }>;
    expect(widgetStates).toEqual([{ status: 'cancelled' }]);

    const dash = service.getDashboard(dashboard.id)!;
    expect(dash.status).toBe('ready');
    expect(sqlCalls).toHaveLength(0);

    // The partial unique index slot is free — a new refresh queues cleanly.
    const again = service.enqueueRefresh(dashboard.id, 'manual');
    expect(again.status).toBe('queued');
    expect(again.id).not.toBe(run.id);
  });

  it('flags a RUNNING run and the worker stops between widgets, keeping the finished result', async () => {
    const dashboard = createTwoWidgetDashboard();
    const run = service.enqueueRefresh(dashboard.id, 'manual');

    // Hold the first widget query open; request the stop while it is in flight.
    let release!: () => void;
    gate = { resolve: () => {}, promise: new Promise<void>(r => { release = r; }) };
    let midFlight: { result: string; cancelRequested?: boolean } | null = null;
    onCall = () => {
      const outcome = service.cancelActiveRun(dashboard.id);
      midFlight = { result: outcome.result, cancelRequested: outcome.run?.cancelRequested };
      onCall = null; // only on the first call
      release();
    };

    const processed = await service.processQueuedRuns(1);
    expect(processed).toBe(1);
    expect(midFlight).toEqual({ result: 'stopping', cancelRequested: true });

    // Only the first widget's SQL ever ran.
    expect(sqlCalls).toEqual(['SELECT 1']);

    const finalRun = service.getRun(run.id)!;
    expect(finalRun.status).toBe('cancelled');
    expect(finalRun.widgetsSucceeded).toBe(1);
    expect(finalRun.error).toBeUndefined();

    const rw = storage.getDb().prepare(
      'SELECT widget_id, status FROM analytics_run_widgets WHERE run_id = ? ORDER BY position',
    ).all(run.id) as Array<{ status: string }>;
    expect(rw.map(r => r.status)).toEqual(['completed', 'cancelled']);

    const dash = service.getDashboard(dashboard.id)!;
    expect(dash.status).toBe('ready');
    // The whole-dashboard refresh timestamp is NOT claimed by a partial run;
    // the completed widget carries its own.
    expect(dash.lastRefreshedAt).toBeFalsy();
    const finished = dash.widgets.find(w => w.title === 'Visitors')!;
    expect(finished.lastRefreshedAt).toBeTruthy();
  });

  it('reports none when nothing is active', () => {
    const dashboard = createTwoWidgetDashboard();
    expect(service.cancelActiveRun(dashboard.id)).toEqual({ result: 'none', run: null });
  });
});
