/**
 * Dashboard query lanes (etl-analytics A4).
 *
 * The analytics engine runs every widget query through ONE of two lanes,
 * chosen by connection availability at the start of each run:
 *
 *   sql-mcp — the direct warehouse connector (sql-context). Primacy lane:
 *             whenever it is running, dashboards use it exactly as before.
 *   etl     — the Datanet ETL composite (etl-adhoc QueryRunner) over the
 *             per-user scratch pair. Fallback lane for machines with no
 *             SQL connector: minutes-scale budgets, widgets execute
 *             serially (ONE scratch pair — concurrent SQL revisions would
 *             clobber each other), lane recorded on every result.
 *
 * Both lanes read the SAME warehouse (proven byte-exact 2026-09-03, run
 * 12862243234) and both enforce the same read-only SQL wall — widgets are
 * single-statement SELECT/WITH by authoring-time validation, so no
 * temp-chain variant is needed here.
 *
 * The availability predicate deliberately mirrors the chat prompt's DATA
 * LANE NOTICE (prompt-manager › formatDataLaneNotice): what the model is
 * told about lanes and what dashboards actually do must never diverge.
 */
import type Database from 'better-sqlite3';
import type { McpManager, McpServerSnapshot } from './mcp-types.js';
import { createEtlQueryRunner, createEtlToolCall, type QueryRunner } from './etl-adhoc.js';

export type DashboardLaneId = 'sql-mcp' | 'etl';

export type WidgetFailureClass = 'content' | 'infra';

/**
 * Failure classification for the post-run cross-lane retry (incident
 * 2026-09-04: 5 Prime-dashboard widgets failed — 2 were SQL dialect bugs,
 * 3 were mid-run network loss; only the latter class can possibly succeed
 * on the other lane). Both lanes read the SAME warehouse, so SQL content
 * errors fail identically everywhere — retrying them wastes minutes and
 * muddies the error trail. Default is 'infra': a wasted retry is cheap and
 * self-corrects (the retry fails with the same message and escalates with
 * two data points); a skipped recoverable retry is a failed widget.
 */
export function classifyWidgetFailure(error: string | null | undefined): WidgetFailureClass {
  const lower = String(error ?? '').toLowerCase();
  const contentPatterns = [
    'sql error', 'syntax error', 'does not exist', 'no function matches',
    'invalid input syntax', 'permission denied', 'read-only', 'must be a single statement',
    'ambiguous', 'out of range', 'division by zero', 'numeric value', 'overflow',
    'column', 'relation', 'invalid operation',
  ];
  if (contentPatterns.some(pattern => lower.includes(pattern))) return 'content';
  return 'infra';
}

/** The other lane, for the post-run retry pass. */
export function otherDashboardLane(lane: DashboardLaneId): DashboardLaneId {
  return lane === 'etl' ? 'sql-mcp' : 'etl';
}

/** Whether a SPECIFIC lane is usable right now (the retry pass asks about
 * the non-primary lane; `selectDashboardLane` answers a different question —
 * which lane to PREFER). `etlRunnerPresent` mirrors the service's own check. */
export function laneUsable(lane: DashboardLaneId, servers: McpServerSnapshot[], etlRunnerPresent: boolean): boolean {
  if (lane === 'sql-mcp') {
    const sql = servers.find(server => server.id === 'sql-context');
    return !!sql && sql.enabled && sql.state === 'running';
  }
  const etl = servers.find(server => server.id === 'a2-analytics');
  return etlRunnerPresent && !!etl && etl.enabled && etl.configured;
}

/** Availability switch — sql-context primacy, ETL only when SQL is down AND the ETL connection is usable. */
export function selectDashboardLane(servers: McpServerSnapshot[]): DashboardLaneId {
  const sql = servers.find(server => server.id === 'sql-context');
  const etl = servers.find(server => server.id === 'a2-analytics');
  const sqlUp = !!sql && sql.enabled && sql.state === 'running';
  const etlUsable = !!etl && etl.enabled && etl.configured;
  if (sqlUp || !etlUsable) return 'sql-mcp';
  return 'etl';
}

/**
 * The dashboard's own composite instance: same scratch pair and Sentry
 * self-heal as chat (shared EtlToolCall path), but a widget-scale poll
 * budget instead of chat's 6-minute alive-handoff — a dashboard widget has
 * no model to hand a runId to, so it waits like the sql lane does (35-min
 * class), minus lease headroom.
 */
export function createDashboardEtlRunner(options: {
  db: Database.Database;
  mcpManager: McpManager;
  /** Widget budget; defaults to the analytics engine's own resolution
   * (35 min, PPT_ANALYTICS_QUERY_TIMEOUT_MS override, 30s–60min clamp). */
  queryTimeoutMs?: number;
}): QueryRunner {
  const fallback = 35 * 60_000; // parity with analytics-dashboard defaultQueryTimeoutMs
  const configured = Number(options.queryTimeoutMs ?? process.env.PPT_ANALYTICS_QUERY_TIMEOUT_MS ?? fallback);
  const queryTimeoutMs = Number.isFinite(configured)
    ? Math.max(30_000, Math.min(60 * 60_000, Math.floor(configured)))
    : fallback;
  // Stay inside the run machine's lease horizon (claim + queryTimeoutMs + 60s).
  const pollBudgetMs = Math.max(10 * 60_000, queryTimeoutMs - 5 * 60_000);
  return createEtlQueryRunner({
    db: options.db,
    call: createEtlToolCall(options.mcpManager),
    pollBudgetMs,
  });
}
