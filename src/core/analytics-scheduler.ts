import Database from 'better-sqlite3';
import type { AnalyticsDashboardService } from './analytics-types.js';
import { nextDailyRun } from './analytics-dashboard.js';

export interface AnalyticsScheduler {
  start(): void;
  stop(): void;
  runDueNow(): Promise<number>;
}

export function createAnalyticsScheduler(options: {
  db: Database.Database;
  analyticsService: AnalyticsDashboardService;
  pollIntervalMs?: number;
}): AnalyticsScheduler {
  const db = options.db;
  const analyticsService = options.analyticsService;
  const pollIntervalMs = Math.max(1_000, options.pollIntervalMs ?? 5_000);
  let timer: NodeJS.Timeout | null = null;
  let currentRun: Promise<number> | null = null;

  function nextOccurrence(row: any): { nextRunAt: string; error: string | null } {
    try {
      return {
        nextRunAt: nextDailyRun(row.local_time, row.timezone, new Date()).toISOString(),
        error: null,
      };
    } catch (error: any) {
      return {
        nextRunAt: new Date(Date.now() + 24 * 60 * 60_000).toISOString(),
        error: String(error?.message ?? error).slice(0, 4000),
      };
    }
  }

  function advanceSchedule(row: any, error: string | null): boolean {
    const next = nextOccurrence(row);
    const scheduleError = error || next.error;
    const result = db.prepare(`
      UPDATE analytics_schedules SET next_run_at = ?,
        last_run_at = CASE WHEN ? IS NULL THEN last_run_at ELSE datetime('now') END,
        consecutive_failures = CASE
          WHEN ? IS NULL THEN consecutive_failures
          ELSE consecutive_failures + 1
        END,
        last_error = CASE WHEN ? IS NULL THEN last_error ELSE ? END,
        updated_at = datetime('now')
      WHERE id = ? AND enabled = 1 AND next_run_at = ?
    `).run(
      next.nextRunAt,
      scheduleError,
      scheduleError,
      scheduleError,
      scheduleError,
      row.id,
      row.next_run_at,
    );
    return result.changes === 1;
  }

  function enqueueDueSchedules(): number {
    const rows = db.prepare(`
      SELECT * FROM analytics_schedules
      WHERE enabled = 1 AND datetime(next_run_at) <= datetime('now')
      ORDER BY datetime(next_run_at), id LIMIT 20
    `).all() as any[];
    let advanced = 0;
    for (const row of rows) {
      let error: string | null = null;
      try {
        analyticsService.enqueueRefresh(row.dashboard_id, 'scheduled');
      } catch (enqueueError: any) {
        error = String(enqueueError?.message ?? enqueueError).slice(0, 4000);
        console.error(`[Analytics scheduler] could not enqueue ${row.dashboard_id}: ${error}`);
      }
      if (advanceSchedule(row, error)) advanced++;
    }
    return advanced;
  }

  function runDueNow(): Promise<number> {
    if (currentRun) return Promise.resolve(0);
    const operation = (async () => {
      const runsRecovered = analyticsService.recoverInterruptedRuns();
      const schedulesAdvanced = enqueueDueSchedules();
      // One whole run at a time protects the analytical source. The service
      // also has an in-process lock and atomically claims the durable row.
      const runsProcessed = await analyticsService.processQueuedRuns(1);
      return runsRecovered + schedulesAdvanced + runsProcessed;
    })();
    currentRun = operation.finally(() => {
      currentRun = null;
    });
    return currentRun;
  }

  function start(): void {
    if (timer) return;
    try {
      const recovered = analyticsService.recoverInterruptedRuns();
      if (recovered) console.warn(`[Analytics scheduler] requeued ${recovered} interrupted refresh(es)`);
    } catch (error) {
      console.error('[Analytics scheduler] recovery failed:', error);
    }
    void runDueNow().catch(error => console.error('[Analytics scheduler] initial poll failed:', error));
    timer = setInterval(() => {
      void runDueNow().catch(error => console.error('[Analytics scheduler] poll failed:', error));
    }, pollIntervalMs);
    timer.unref();
  }

  function stop(): void {
    if (timer) clearInterval(timer);
    timer = null;
    // Do not wait for a 10–25 minute connector call during process shutdown.
    // The claimed run remains durable and is requeued on the next startup.
  }

  return { start, stop, runDueNow };
}
