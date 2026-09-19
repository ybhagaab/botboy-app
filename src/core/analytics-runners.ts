/**
 * Dashboard query lanes (etl-analytics A4).
 *
 * The analytics engine runs every widget query through ONE of two lanes,
 * chosen by connection availability at the start of each run:
 *
 *   sql-mcp — the direct warehouse connector (sql-context). Primacy lane:
 *             whenever it is running, dashboards use it exactly as before.
 *   etl     — the Datanet ETL composite (etl-adhoc QueryRunner) over the
 *             per-user scratch-pair POOL. Fallback lane for machines with
 *             no SQL connector: minutes-scale budgets, ALL widgets in
 *             parallel (each claims its own pair — per-JOB serialization
 *             is Datanet's only real constraint), lane recorded on every
 *             result.
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

const SQL_REQUIRED_TOOLS = ['connection_status', 'run_query'] as const;
const ETL_REQUIRED_TOOLS = [
  'datanet_search',
  'datanet_create_profile',
  'datanet_create_job',
  'datanet_get_latest_run',
  'datanet_update_profile_sql',
  'datanet_submit_run',
  'datanet_get_job_run_status',
  'datanet_alter_run',
  'datanet_get_job_run_error',
  'datanet_download_results',
] as const;
/** Health runs every 60s and may spend 30s checking the warehouse. Anything
 * older than 150s is not a current data-readiness receipt. */
const SQL_HEALTH_FRESH_MS = 150_000;

function requiredToolsAvailable(server: McpServerSnapshot | null | undefined, names: readonly string[]): boolean {
  if (!server) return false;
  const available = new Set((server.tools ?? []).map(tool => tool.name));
  return names.every(name => available.has(name));
}

function timestampMs(value: string | undefined): number {
  if (!value) return Number.NaN;
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)
    ? `${value.replace(' ', 'T')}Z`
    : value;
  return Date.parse(normalized);
}

/** Process/capability precondition for a fresh SQL connection probe. */
export function sqlDashboardLaneCandidate(server: McpServerSnapshot | null | undefined): boolean {
  return !!server
    && server.enabled
    && server.configured
    && server.state === 'running'
    && requiredToolsAvailable(server, SQL_REQUIRED_TOOLS);
}

/** Snapshot-only SQL readiness for prompt routing and retry eligibility. */
export function sqlDashboardLaneUsable(
  server: McpServerSnapshot | null | undefined,
  nowMs = Date.now(),
): boolean {
  if (!sqlDashboardLaneCandidate(server)) return false;
  const healthyAt = timestampMs(server?.lastHealthyAt);
  return Number.isFinite(healthyAt) && nowMs - healthyAt <= SQL_HEALTH_FRESH_MS;
}

/** A2 runtime/capability readiness for the deterministic ETL composite. */
export function etlDashboardLaneUsable(
  server: McpServerSnapshot | null | undefined,
  etlRunnerPresent = true,
): boolean {
  return etlRunnerPresent
    && !!server
    && server.enabled
    && server.configured
    && server.state === 'running'
    && requiredToolsAvailable(server, ETL_REQUIRED_TOOLS);
}

export function dashboardLaneAvailability(
  servers: McpServerSnapshot[] = [],
  etlRunnerPresent = true,
  nowMs = Date.now(),
): { sqlUsable: boolean; etlUsable: boolean } {
  return {
    sqlUsable: sqlDashboardLaneUsable(servers.find(server => server.id === 'sql-context'), nowMs),
    etlUsable: etlDashboardLaneUsable(servers.find(server => server.id === 'a2-analytics'), etlRunnerPresent),
  };
}

/**
 * A runtime-generation mismatch discovered before the MCP tool call starts is
 * safe to retry once on the SAME lane: no remote side effect or query has run.
 * Keep this deliberately narrower than generic transport failures — retrying a
 * connection close after submission could duplicate an ETL job.
 */
export function isSafeRuntimeQueueChurn(error: unknown): boolean {
  const lower = String((error as any)?.message ?? error ?? '').toLowerCase();
  return lower.includes('runtime changed before the queued call could start')
    || lower.includes('runtime changed before the call could be queued');
}

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

export function isCrossLaneRetryableFailure(error: string | null | undefined): boolean {
  return classifyWidgetFailure(error) === 'infra'
    && !/\bretry also failed:/i.test(String(error ?? ''));
}

/** Strong lane-outage shapes that justify stopping new widget claims. Generic
 * query timeouts are excluded because one expensive query does not prove the
 * connector is unavailable. */
export function isDashboardLaneUnavailable(error: unknown, lane: DashboardLaneId): boolean {
  const lower = String((error as any)?.message ?? error ?? '').toLowerCase();
  const common = [
    'connection closed',
    'connection refused',
    'does not expose tool',
    'managed mcp runtime unavailable',
    'not running',
    'is unavailable',
    'profile is disabled',
  ];
  if (common.some(pattern => lower.includes(pattern))) return true;
  if (lane === 'sql-mcp') {
    return lower.includes('not connected')
      || lower.includes('warehouse connection is down');
  }
  return lower.includes('needs re-authentication')
    || lower.includes('datanet etl through a2 analytics is unavailable');
}

/** The other lane, for the post-run retry pass. */
export function otherDashboardLane(lane: DashboardLaneId): DashboardLaneId {
  return lane === 'etl' ? 'sql-mcp' : 'etl';
}

/** Whether a SPECIFIC lane is usable from the current persisted runtime
 * receipt. SQL execution still performs one fresh connection probe at run
 * selection; this snapshot predicate prevents stale/missing capabilities from
 * being attempted at all. */
export function laneUsable(
  lane: DashboardLaneId,
  servers: McpServerSnapshot[],
  etlRunnerPresent: boolean,
  nowMs = Date.now(),
): boolean {
  const availability = dashboardLaneAvailability(servers, etlRunnerPresent, nowMs);
  return lane === 'sql-mcp' ? availability.sqlUsable : availability.etlUsable;
}

/** Availability switch shared with chat prompt routing. Null means neither
 * lane has a current, capability-complete readiness receipt; callers must fail
 * closed instead of attempting SQL by default. */
export function selectDashboardLane(
  servers: McpServerSnapshot[],
  etlRunnerPresent = true,
  nowMs = Date.now(),
): DashboardLaneId | null {
  const availability = dashboardLaneAvailability(servers, etlRunnerPresent, nowMs);
  if (availability.sqlUsable) return 'sql-mcp';
  if (availability.etlUsable) return 'etl';
  return null;
}

/**
 * The dashboard's own composite instance: same scratch pair and Sentry
 * self-heal as chat (shared EtlToolCall path), but a widget-scale poll
 * budget instead of chat's 6-minute alive-handoff — a dashboard widget has
 * no model to hand a runId to, so it waits like the sql lane does (60-min
 * class), minus lease headroom.
 */
export function createDashboardEtlRunner(options: {
  db: Database.Database;
  mcpManager: McpManager;
  /** Widget budget; defaults to the analytics engine's own resolution
   * (60 min, PPT_ANALYTICS_QUERY_TIMEOUT_MS override, 30s–60min clamp). */
  queryTimeoutMs?: number;
}): QueryRunner {
  const fallback = 60 * 60_000; // parity with analytics-dashboard defaultQueryTimeoutMs
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
