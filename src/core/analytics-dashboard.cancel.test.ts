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

  it('runs widgets through the 3-wide pool; cancel stops CLAIMS while in-flight queries finish', async () => {
    // Five widgets: the pool claims 3 immediately (the dashboard lane cap,
    // sized by warehouse measurement); cancel lands while those are in
    // flight; widgets 4-5 must never start and end 'cancelled'.
    const dashboard = service.createDashboard({
      title: 'Funnel health',
      widgets: [1, 2, 3, 4, 5].map(n => ({ kind: 'metric', title: `W${n}`, sql: `SELECT ${n}` })),
    } as any);
    const run = service.enqueueRefresh(dashboard.id, 'manual');

    let inFlight = 0;
    let maxInFlight = 0;
    let release!: () => void;
    gate = { resolve: () => {}, promise: new Promise<void>(r => { release = r; }) };
    let midFlight: { result: string; cancelRequested?: boolean } | null = null;
    let callsSeen = 0;
    onCall = () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      callsSeen += 1;
      gate!.promise.then(() => { inFlight -= 1; });
      if (callsSeen === 3) {
        // All three pool workers are mid-query — the run payload must name
        // all three running widgets (UI shows "N queries in parallel").
        expect(service.getRun(run.id)?.runningWidgetIds).toHaveLength(3);
        // Request the stop now.
        const outcome = service.cancelActiveRun(dashboard.id);
        midFlight = { result: outcome.result, cancelRequested: outcome.run?.cancelRequested };
        release();
      }
    };

    const processed = await service.processQueuedRuns(1);
    expect(processed).toBe(1);
    expect(midFlight).toEqual({ result: 'stopping', cancelRequested: true });

    // The pool genuinely parallelized (3 concurrent) and never started 4-5.
    expect(maxInFlight).toBe(3);
    expect(sqlCalls.sort()).toEqual(['SELECT 1', 'SELECT 2', 'SELECT 3']);

    const finalRun = service.getRun(run.id)!;
    expect(finalRun.status).toBe('cancelled');
    expect(finalRun.widgetsSucceeded).toBe(3);
    expect(finalRun.error).toBeUndefined();

    const rw = storage.getDb().prepare(
      'SELECT widget_id, status FROM analytics_run_widgets WHERE run_id = ? ORDER BY position',
    ).all(run.id) as Array<{ status: string }>;
    expect(rw.map(r => r.status)).toEqual(['completed', 'completed', 'completed', 'cancelled', 'cancelled']);

    const dash = service.getDashboard(dashboard.id)!;
    expect(dash.status).toBe('ready');
    // The whole-dashboard refresh timestamp is NOT claimed by a partial run;
    // completed widgets carry their own.
    expect(dash.lastRefreshedAt).toBeFalsy();
    const finished = dash.widgets.find(w => w.title === 'W1')!;
    expect(finished.lastRefreshedAt).toBeTruthy();
  });

  it('reports none when nothing is active', () => {
    const dashboard = createTwoWidgetDashboard();
    expect(service.cancelActiveRun(dashboard.id)).toEqual({ result: 'none', run: null });
  });
});
