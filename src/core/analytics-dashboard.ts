import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type { McpManager } from './mcp-types.js';
import { validateReadOnlySql } from './mcp-policy.js';
import type {
  AnalyticsDashboard,
  AnalyticsDashboardService,
  AnalyticsDashboardStatus,
  AnalyticsDashboardSummary,
  AnalyticsRefreshTrigger,
  AnalyticsRun,
  AnalyticsSchedule,
  AnalyticsPublication,
  AnalyticsWidget,
  AnalyticsWidgetInput,
  AnalyticsWidgetKind,
  AnalyticsWidgetResult,
  CreateAnalyticsDashboardInput,
  UpdateAnalyticsDashboardInput,
  UpdateAnalyticsScheduleInput,
} from './analytics-types.js';

const WIDGET_KINDS = new Set<AnalyticsWidgetKind>(['metric', 'table', 'bar', 'line', 'text', 'visualization']);
const DASHBOARD_STATUSES = new Set<AnalyticsDashboardStatus>(['draft', 'ready', 'refreshing', 'degraded', 'archived']);
const MAX_WIDGETS = 24;
const MAX_VISUALIZATION_SPEC_BYTES = 64 * 1024;
const MAX_VISUALIZATION_SPEC_DEPTH = 24;
const MAX_VISUALIZATION_SPEC_NODES = 4_000;
const VEGA_LITE_MARKS = new Set([
  'arc', 'area', 'bar', 'circle', 'geoshape', 'line', 'point',
  'rect', 'rule', 'square', 'text', 'tick', 'trail',
]);
const FORBIDDEN_VEGA_KEYS = new Set([
  '$schema', '__proto__', 'constructor', 'data', 'datasets', 'expr', 'href',
  'prototype', 'signal', 'signals', 'url',
]);
const EXTERNAL_VEGA_STRING_RE = /(?:\b(?:https?|data|javascript|file):|url\s*\(|^\/\/)/i;

function cleanText(value: unknown, label: string, max: number, required = false): string {
  if (value == null) {
    if (required) throw new Error(`${label} is required`);
    return '';
  }
  if (typeof value !== 'string') throw new Error(`${label} must be a string`);
  const text = value.trim();
  if (required && !text) throw new Error(`${label} is required`);
  if (text.length > max) throw new Error(`${label} exceeds ${max} characters`);
  return text;
}

function jsonObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Validate the declarative Vega-Lite subset accepted for persisted widgets.
 * Query results are injected by the trusted UI at render time, so authored
 * specs cannot provide data, network locations, links, or expression code.
 */
export function validateVisualizationSpec(value: unknown): Record<string, unknown> {
  if (!isPlainObject(value)) throw new Error('Visualization config.spec must be a plain object');
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new Error('Visualization config.spec must be JSON serializable');
  }
  if (Buffer.byteLength(serialized, 'utf8') > MAX_VISUALIZATION_SPEC_BYTES) {
    throw new Error(`Visualization config.spec exceeds ${MAX_VISUALIZATION_SPEC_BYTES} bytes`);
  }

  let nodes = 0;
  const visit = (node: unknown, path: string, depth: number): void => {
    nodes++;
    if (nodes > MAX_VISUALIZATION_SPEC_NODES) {
      throw new Error(`Visualization config.spec exceeds ${MAX_VISUALIZATION_SPEC_NODES} values`);
    }
    if (depth > MAX_VISUALIZATION_SPEC_DEPTH) {
      throw new Error(`Visualization config.spec exceeds depth ${MAX_VISUALIZATION_SPEC_DEPTH}`);
    }
    if (node == null || typeof node === 'boolean') return;
    if (typeof node === 'number') {
      if (!Number.isFinite(node)) throw new Error(`Visualization ${path} must be a finite number`);
      return;
    }
    if (typeof node === 'string') {
      if (EXTERNAL_VEGA_STRING_RE.test(node)) {
        throw new Error(`Visualization ${path} cannot contain an external URL or executable URI`);
      }
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((item, index) => visit(item, `${path}[${index}]`, depth + 1));
      return;
    }
    if (!isPlainObject(node)) throw new Error(`Visualization ${path} must contain only JSON values`);

    for (const [key, child] of Object.entries(node)) {
      const normalizedKey = key.toLowerCase();
      const childPath = `${path}.${key}`;
      if (FORBIDDEN_VEGA_KEYS.has(normalizedKey) || normalizedKey.endsWith('expr') || normalizedKey === 'calculate') {
        throw new Error(`Visualization ${childPath} is not allowed`);
      }
      if ((normalizedKey === 'filter' || normalizedKey === 'test') && typeof child === 'string') {
        throw new Error(`Visualization ${childPath} must use a declarative predicate, not an expression string`);
      }
      if (normalizedKey === 'mark') {
        const mark = typeof child === 'string'
          ? child
          : isPlainObject(child) && typeof child.type === 'string'
            ? child.type
            : undefined;
        if (mark && !VEGA_LITE_MARKS.has(mark)) {
          throw new Error(`Visualization ${childPath} uses unsupported mark ${mark}`);
        }
      }
      visit(child, childPath, depth + 1);
    }
  };
  visit(value, 'config.spec', 0);

  if (!['mark', 'layer', 'facet', 'concat', 'hconcat', 'vconcat', 'repeat'].some(key => key in value)) {
    throw new Error('Visualization config.spec must define a mark or a Vega-Lite composition');
  }
  return JSON.parse(serialized) as Record<string, unknown>;
}

function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try { return JSON.parse(raw) as T; } catch { return fallback; }
}

function shortId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
}

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

const zonedFormatters = new Map<string, Intl.DateTimeFormat>();

function zonedParts(date: Date, timezone: string): ZonedParts {
  let formatter = zonedFormatters.get(timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
    // Force eager timezone validation instead of failing later in the scheduler.
    formatter.format(date);
    zonedFormatters.set(timezone, formatter);
  }
  const values: Record<string, number> = {};
  for (const part of formatter.formatToParts(date)) {
    if (['year', 'month', 'day', 'hour', 'minute'].includes(part.type)) values[part.type] = Number(part.value);
  }
  return values as unknown as ZonedParts;
}

function localDayPlus(parts: ZonedParts, days: number): ZonedParts {
  const shifted = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days));
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: parts.hour,
    minute: parts.minute,
  };
}

function sameLocalDay(left: ZonedParts, right: ZonedParts): boolean {
  return left.year === right.year && left.month === right.month && left.day === right.day;
}

function utcForLocalTime(
  localDay: ZonedParts,
  hour: number,
  minute: number,
  timezone: string,
  afterMs: number,
): Date | null {
  const targetPseudo = Date.UTC(localDay.year, localDay.month - 1, localDay.day, hour, minute);
  let guess = targetPseudo;
  for (let attempt = 0; attempt < 5; attempt++) {
    const actual = zonedParts(new Date(guess), timezone);
    const actualPseudo = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute);
    const delta = targetPseudo - actualPseudo;
    if (delta === 0) break;
    guess += delta;
  }

  // Scan around the resolved offset to cover DST overlaps and nonexistent
  // wall-clock minutes. On a spring-forward gap, use the first valid minute
  // after the requested local time; on an overlap, use the first future match.
  let exactFuture: number | null = null;
  let firstLater: number | null = null;
  let sawExact = false;
  for (let value = guess - 4 * 60 * 60_000; value <= guess + 4 * 60 * 60_000; value += 60_000) {
    const actual = zonedParts(new Date(value), timezone);
    if (!sameLocalDay(actual, localDay)) continue;
    const actualMinutes = actual.hour * 60 + actual.minute;
    const targetMinutes = hour * 60 + minute;
    if (actualMinutes === targetMinutes) {
      sawExact = true;
      if (value > afterMs && (exactFuture == null || value < exactFuture)) exactFuture = value;
    } else if (actualMinutes > targetMinutes && value > afterMs && (firstLater == null || value < firstLater)) {
      firstLater = value;
    }
  }
  const selected = exactFuture ?? (!sawExact ? firstLater : null);
  return selected == null ? null : new Date(selected);
}

export function nextDailyRun(localTime: string, timezone: string, after = new Date()): Date {
  const match = /^(\d{2}):(\d{2})$/.exec(String(localTime || ''));
  if (!match) throw new Error('Daily refresh time must use HH:MM in 24-hour format');
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) throw new Error('Daily refresh time is invalid');
  const zone = cleanText(timezone, 'timezone', 100, true);
  const today = zonedParts(after, zone);
  for (let dayOffset = 0; dayOffset < 8; dayOffset++) {
    const candidate = utcForLocalTime(localDayPlus(today, dayOffset), hour, minute, zone, after.getTime());
    if (candidate) return candidate;
  }
  throw new Error('Could not calculate the next daily refresh time');
}

function coerceCell(value: string): string | number | boolean | null {
  const text = value.trim();
  if (/^null$/i.test(text)) return null;
  if (/^(true|false)$/i.test(text)) return text.toLowerCase() === 'true';
  if (/^-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(text)) {
    const number = Number(text);
    if (Number.isFinite(number)) return number;
  }
  return text;
}

/** Parse the stable formatted-table response emitted by sql-context-mcp. */
export function parseSqlMcpResult(text: string, refreshedAt = new Date().toISOString()): AnalyticsWidgetResult {
  const lines = String(text || '').replace(/\r/g, '').split('\n');
  const separatorIndex = lines.findIndex(line => /^-+(?:-\+-+)*$/.test(line.trim()));
  const countMatch = text.match(/(?:^|\n)(\d+) rows returned\. \((\d+)ms\)\s*$/);
  const emptyMatch = text.match(/Query executed successfully\.\s*(\d+) rows affected\.\s*\((\d+)ms\)/);
  let columns: string[] = [];
  let rows: Array<Array<string | number | boolean | null>> = [];

  if (separatorIndex > 0) {
    columns = lines[separatorIndex - 1].split(' | ').map(value => value.trim());
    for (const line of lines.slice(separatorIndex + 1)) {
      if (!line.trim() || /^\.\.\. \(\d+ more rows\)$/.test(line.trim()) || /^\d+ rows returned\./.test(line.trim())) break;
      const values = line.split(' | ').map(coerceCell);
      while (values.length < columns.length) values.push(null);
      rows.push(values.slice(0, columns.length));
    }
  }

  const rowCount = countMatch ? Number(countMatch[1]) : emptyMatch ? Number(emptyMatch[1]) : rows.length;
  const executionTimeMs = countMatch ? Number(countMatch[2]) : emptyMatch ? Number(emptyMatch[2]) : undefined;
  return {
    trust: 'external_untrusted_data',
    columns,
    rows,
    rowCount,
    displayedRowCount: rows.length,
    executionTimeMs,
    rawPreview: columns.length ? undefined : text.slice(0, 2000),
    refreshedAt,
  };
}

function normalizeWidget(input: AnalyticsWidgetInput, position: number): AnalyticsWidgetInput {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error(`Widget ${position + 1} must be an object`);
  if (!WIDGET_KINDS.has(input.kind)) throw new Error(`Widget ${position + 1} has invalid kind`);
  const title = cleanText(input.title, `Widget ${position + 1} title`, 200, true);
  const subtitle = cleanText(input.subtitle, `Widget ${position + 1} subtitle`, 500);
  const preset = cleanText(input.preset, `Widget ${position + 1} preset`, 256);
  const config = jsonObject(input.config);
  if (input.kind === 'text') {
    const text = cleanText(config.text, `Widget ${position + 1} text`, 20_000, true);
    return { kind: input.kind, title, subtitle, preset, config: { ...config, text } };
  }
  const sql = validateReadOnlySql(input.sql);
  if (input.kind === 'visualization') {
    const spec = validateVisualizationSpec(config.spec);
    return { kind: input.kind, title, subtitle, sql, preset, config: { ...config, spec } };
  }
  return { kind: input.kind, title, subtitle, sql, preset, config };
}

function normalizeWidgets(value: unknown): AnalyticsWidgetInput[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error('At least one dashboard widget is required');
  if (value.length > MAX_WIDGETS) throw new Error(`A dashboard can contain at most ${MAX_WIDGETS} widgets`);
  return value.map((widget, position) => normalizeWidget(widget as AnalyticsWidgetInput, position));
}

export function createAnalyticsDashboardService(options: {
  db: Database.Database;
  mcpManager: McpManager;
  queryTimeoutMs?: number;
}): AnalyticsDashboardService {
  const db = options.db;
  const mcpManager = options.mcpManager;
  const defaultQueryTimeoutMs = 25 * 60_000;
  const configuredQueryTimeoutMs = Number(
    options.queryTimeoutMs ?? process.env.PPT_ANALYTICS_QUERY_TIMEOUT_MS ?? defaultQueryTimeoutMs,
  );
  const queryTimeoutMs = Number.isFinite(configuredQueryTimeoutMs)
    ? Math.max(30_000, Math.min(60 * 60_000, Math.floor(configuredQueryTimeoutMs)))
    : defaultQueryTimeoutMs;
  let processingQueue = false;
  const workerId = `worker_${randomUUID().replace(/-/g, '').slice(0, 16)}`;

  function processIsAlive(pid: unknown): boolean {
    const value = Number(pid);
    if (!Number.isSafeInteger(value) || value <= 0) return false;
    if (value === process.pid) return true;
    try {
      process.kill(value, 0);
      return true;
    } catch (error: any) {
      return error?.code !== 'ESRCH';
    }
  }

  function validateProjects(projectIds: unknown): string[] {
    if (projectIds == null) return [];
    if (!Array.isArray(projectIds)) throw new Error('projectIds must be an array');
    const ids = [...new Set(projectIds.map(value => cleanText(value, 'projectId', 128, true)))].slice(0, 50);
    const exists = db.prepare('SELECT 1 FROM projects WHERE id = ?');
    for (const id of ids) {
      if (!exists.get(id)) throw new Error(`Project ${id} does not exist`);
    }
    return ids;
  }

  function mapSummary(row: any): AnalyticsDashboardSummary {
    return {
      id: row.id,
      title: row.title,
      description: row.description || '',
      theme: row.theme || 'executive',
      status: row.status,
      widgetCount: Number(row.widget_count || 0),
      projectCount: Number(row.project_count || 0),
      lastError: row.last_error || undefined,
      lastRefreshedAt: row.last_refreshed_at || undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  function mapWidget(row: any): AnalyticsWidget {
    return {
      id: row.id,
      dashboardId: row.dashboard_id,
      position: Number(row.position),
      kind: row.kind,
      title: row.title,
      subtitle: row.subtitle || '',
      sql: row.sql_query || undefined,
      preset: row.preset || undefined,
      config: parseJson(row.config_json, {}),
      result: parseJson<AnalyticsWidgetResult | undefined>(row.result_json, undefined),
      lastError: row.last_error || undefined,
      lastRefreshedAt: row.last_refreshed_at || undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  function mapSchedule(row: any): AnalyticsSchedule {
    return {
      id: row.id,
      dashboardId: row.dashboard_id,
      enabled: row.enabled === 1,
      scheduleKind: row.schedule_kind,
      localTime: row.local_time,
      timezone: row.timezone,
      nextRunAt: row.next_run_at,
      lastRunAt: row.last_run_at || undefined,
      consecutiveFailures: Number(row.consecutive_failures || 0),
      lastError: row.last_error || undefined,
    };
  }

  function mapPublication(row: any): AnalyticsPublication {
    return {
      id: row.id,
      dashboardId: row.dashboard_id,
      publisherId: row.publisher_id,
      objectKey: row.object_key,
      url: row.url || undefined,
      status: row.status,
      contentSha256: row.content_sha256,
      error: row.error || undefined,
      createdAt: row.created_at,
      publishedAt: row.published_at || undefined,
    };
  }

  function mapRun(row: any): AnalyticsRun {
    return {
      id: row.id,
      dashboardId: row.dashboard_id,
      trigger: row.trigger,
      status: row.status,
      widgetCount: Number(row.widget_count || 0),
      widgetsCompleted: Number(row.widgets_completed || 0),
      widgetsSucceeded: Number(row.widgets_succeeded || 0),
      currentWidgetId: row.current_widget_id || undefined,
      queuedAt: row.queued_at,
      startedAt: row.started_at || undefined,
      heartbeatAt: row.heartbeat_at || undefined,
      leaseExpiresAt: row.lease_expires_at || undefined,
      error: row.error || undefined,
      completedAt: row.completed_at || undefined,
    };
  }

  function getRun(id: string): AnalyticsRun | null {
    const row = db.prepare('SELECT * FROM analytics_runs WHERE id = ?').get(id) as any;
    return row ? mapRun(row) : null;
  }

  function activeRun(dashboardId: string): AnalyticsRun | null {
    const row = db.prepare(`
      SELECT * FROM analytics_runs
      WHERE dashboard_id = ? AND status IN ('queued','running')
      ORDER BY queued_at LIMIT 1
    `).get(dashboardId) as any;
    return row ? mapRun(row) : null;
  }

  function listDashboards(): AnalyticsDashboardSummary[] {
    const rows = db.prepare(`
      SELECT d.*,
        (SELECT COUNT(*) FROM analytics_widgets w WHERE w.dashboard_id = d.id) AS widget_count,
        (SELECT COUNT(*) FROM analytics_dashboard_projects p WHERE p.dashboard_id = d.id) AS project_count
      FROM analytics_dashboards d
      WHERE d.status != 'archived'
      ORDER BY COALESCE(d.last_refreshed_at, d.updated_at) DESC, d.title
    `).all() as any[];
    return rows.map(mapSummary);
  }

  function getDashboard(id: string): AnalyticsDashboard | null {
    const row = db.prepare(`
      SELECT d.*,
        (SELECT COUNT(*) FROM analytics_widgets w WHERE w.dashboard_id = d.id) AS widget_count,
        (SELECT COUNT(*) FROM analytics_dashboard_projects p WHERE p.dashboard_id = d.id) AS project_count
      FROM analytics_dashboards d WHERE d.id = ?
    `).get(id) as any;
    if (!row) return null;
    const projectIds = (db.prepare('SELECT project_id FROM analytics_dashboard_projects WHERE dashboard_id = ? ORDER BY linked_at').all(id) as any[]).map(item => item.project_id);
    const widgets = (db.prepare('SELECT * FROM analytics_widgets WHERE dashboard_id = ? ORDER BY position').all(id) as any[]).map(mapWidget);
    const scheduleRow = db.prepare('SELECT * FROM analytics_schedules WHERE dashboard_id = ?').get(id) as any;
    const publicationRow = db.prepare(`
      SELECT * FROM dashboard_publications
      WHERE dashboard_id = ? ORDER BY created_at DESC LIMIT 1
    `).get(id) as any;
    const recentRuns = (db.prepare(`
      SELECT * FROM analytics_runs WHERE dashboard_id = ?
      ORDER BY datetime(queued_at) DESC, id DESC LIMIT 12
    `).all(id) as any[]).map(mapRun);
    return {
      ...mapSummary(row),
      projectIds,
      widgets,
      schedule: scheduleRow ? mapSchedule(scheduleRow) : undefined,
      latestPublication: publicationRow ? mapPublication(publicationRow) : undefined,
      recentRuns,
    };
  }

  function insertWidgets(dashboardId: string, widgets: AnalyticsWidgetInput[]): void {
    const insert = db.prepare(`
      INSERT INTO analytics_widgets
        (id, dashboard_id, position, kind, title, subtitle, sql_query, preset, config_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    widgets.forEach((widget, position) => {
      insert.run(
        shortId('widget'), dashboardId, position, widget.kind, widget.title,
        widget.subtitle || '', widget.sql || null, widget.preset || null,
        JSON.stringify(widget.config || {}),
      );
    });
  }

  function replaceProjectLinks(dashboardId: string, projectIds: string[]): void {
    db.prepare('DELETE FROM analytics_dashboard_projects WHERE dashboard_id = ?').run(dashboardId);
    const insert = db.prepare('INSERT INTO analytics_dashboard_projects (dashboard_id, project_id) VALUES (?, ?)');
    projectIds.forEach(projectId => insert.run(dashboardId, projectId));
  }

  function createDashboard(
    input: CreateAnalyticsDashboardInput,
    refreshTrigger?: AnalyticsRefreshTrigger,
  ): AnalyticsDashboard {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Dashboard input must be an object');
    if (refreshTrigger && !['manual', 'scheduled', 'agent'].includes(refreshTrigger)) {
      throw new Error('Invalid refresh trigger');
    }
    const title = cleanText(input.title, 'title', 200, true);
    const description = cleanText(input.description, 'description', 2000);
    const theme = cleanText(input.theme || 'executive', 'theme', 80, true);
    const widgets = normalizeWidgets(input.widgets);
    const projectIds = validateProjects(input.projectIds);
    const id = shortId('dash');
    db.transaction(() => {
      db.prepare(`
        INSERT INTO analytics_dashboards (id, title, description, theme, status)
        VALUES (?, ?, ?, ?, 'draft')
      `).run(id, title, description, theme);
      insertWidgets(id, widgets);
      replaceProjectLinks(id, projectIds);
      if (refreshTrigger) enqueueDashboard(getDashboard(id)!, refreshTrigger);
    })();
    return getDashboard(id)!;
  }

  function updateDashboard(id: string, input: UpdateAnalyticsDashboardInput): AnalyticsDashboard {
    const current = getDashboard(id);
    if (!current) throw new Error(`Dashboard ${id} not found`);
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Dashboard update must be an object');
    const running = activeRun(id);
    if (running && (input.widgets !== undefined || input.status !== undefined)) {
      throw new Error(`Dashboard widgets or status cannot change while refresh ${running.id} is ${running.status}`);
    }
    const title = input.title === undefined ? current.title : cleanText(input.title, 'title', 200, true);
    const description = input.description === undefined ? current.description : cleanText(input.description, 'description', 2000);
    const theme = input.theme === undefined ? current.theme : cleanText(input.theme, 'theme', 80, true);
    const status = input.status === undefined ? current.status : input.status;
    if (!DASHBOARD_STATUSES.has(status)) throw new Error('Invalid dashboard status');
    const widgets = input.widgets === undefined ? null : normalizeWidgets(input.widgets);
    const projectIds = input.projectIds === undefined ? null : validateProjects(input.projectIds);

    db.transaction(() => {
      db.prepare(`
        UPDATE analytics_dashboards SET title = ?, description = ?, theme = ?, status = ?,
          updated_at = datetime('now') WHERE id = ?
      `).run(title, description, theme, status, id);
      if (widgets) {
        db.prepare('DELETE FROM analytics_widgets WHERE dashboard_id = ?').run(id);
        insertWidgets(id, widgets);
      }
      if (projectIds) replaceProjectLinks(id, projectIds);
      if (status === 'archived') {
        db.prepare(`
          UPDATE analytics_schedules SET enabled = 0, updated_at = datetime('now')
          WHERE dashboard_id = ?
        `).run(id);
      }
    })();
    return getDashboard(id)!;
  }

  function setSchedule(id: string, input: UpdateAnalyticsScheduleInput): AnalyticsSchedule {
    const dashboard = getDashboard(id);
    if (!dashboard) throw new Error(`Dashboard ${id} not found`);
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Schedule input must be an object');
    if (typeof input.enabled !== 'boolean') throw new Error('enabled must be a boolean');
    if (dashboard.status === 'archived' && input.enabled) throw new Error('Archived dashboards cannot enable a refresh schedule');
    const localTime = cleanText(input.localTime, 'localTime', 5, true);
    const timezone = cleanText(input.timezone, 'timezone', 100, true);
    const nextRunAt = nextDailyRun(localTime, timezone).toISOString();
    const existing = db.prepare('SELECT id FROM analytics_schedules WHERE dashboard_id = ?').get(id) as { id: string } | undefined;
    const scheduleId = existing?.id || shortId('schedule');
    db.prepare(`
      INSERT INTO analytics_schedules
        (id, dashboard_id, enabled, schedule_kind, local_time, timezone, next_run_at)
      VALUES (?, ?, ?, 'daily', ?, ?, ?)
      ON CONFLICT(dashboard_id) DO UPDATE SET
        enabled = excluded.enabled,
        local_time = excluded.local_time,
        timezone = excluded.timezone,
        next_run_at = excluded.next_run_at,
        consecutive_failures = CASE
          WHEN analytics_schedules.enabled = 0 AND excluded.enabled = 1 THEN 0
          ELSE analytics_schedules.consecutive_failures
        END,
        last_error = CASE
          WHEN analytics_schedules.enabled = 0 AND excluded.enabled = 1 THEN NULL
          ELSE analytics_schedules.last_error
        END,
        updated_at = datetime('now')
    `).run(scheduleId, id, input.enabled ? 1 : 0, localTime, timezone, nextRunAt);
    const row = db.prepare('SELECT * FROM analytics_schedules WHERE dashboard_id = ?').get(id) as any;
    return mapSchedule(row);
  }

  function enqueueDashboard(dashboard: AnalyticsDashboard, trigger: AnalyticsRefreshTrigger): AnalyticsRun {
    const schedule = trigger === 'scheduled'
      ? db.prepare('SELECT id FROM analytics_schedules WHERE dashboard_id = ?').get(dashboard.id) as { id: string } | undefined
      : undefined;
    const existing = activeRun(dashboard.id);
    if (existing) {
      if (schedule?.id) {
        db.prepare('UPDATE analytics_runs SET schedule_id = COALESCE(schedule_id, ?) WHERE id = ?')
          .run(schedule.id, existing.id);
      }
      db.prepare(`
        UPDATE analytics_dashboards SET status = 'refreshing', updated_at = datetime('now')
        WHERE id = ?
      `).run(dashboard.id);
      return getRun(existing.id)!;
    }

    const runId = shortId('run');
    const queuedAt = new Date().toISOString();
    db.prepare(`
      INSERT INTO analytics_runs
        (id, dashboard_id, schedule_id, trigger, status, widget_count, queued_at)
      VALUES (?, ?, ?, ?, 'queued', ?, ?)
    `).run(runId, dashboard.id, schedule?.id || null, trigger, dashboard.widgets.length, queuedAt);
    const insertRunWidget = db.prepare(`
      INSERT INTO analytics_run_widgets
        (run_id, widget_id, position, kind, title, sql_query, config_json, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'queued')
    `);
    for (const widget of dashboard.widgets) {
      insertRunWidget.run(
        runId,
        widget.id,
        widget.position,
        widget.kind,
        widget.title,
        widget.sql || null,
        JSON.stringify(widget.config || {}),
      );
    }
    db.prepare(`
      UPDATE analytics_dashboards SET status = 'refreshing', last_error = NULL,
        updated_at = datetime('now') WHERE id = ?
    `).run(dashboard.id);
    return getRun(runId)!;
  }

  function enqueueRefresh(id: string, trigger: AnalyticsRefreshTrigger = 'manual'): AnalyticsRun {
    if (!['manual', 'scheduled', 'agent'].includes(trigger)) throw new Error('Invalid refresh trigger');
    const dashboard = getDashboard(id);
    if (!dashboard) throw new Error(`Dashboard ${id} not found`);
    if (dashboard.status === 'archived') throw new Error('Archived dashboards cannot be refreshed');
    const enqueue = db.transaction(() => enqueueDashboard(dashboard, trigger));
    try {
      return enqueue();
    } catch (error: any) {
      // The partial unique index is the final deduplication guard if another
      // producer inserted between lookup and insert.
      if (/unique constraint/i.test(String(error?.message || error))) {
        const existing = activeRun(id);
        if (existing) return existing;
      }
      throw error;
    }
  }

  function recoverInterruptedRuns(): number {
    const candidates = db.prepare(`
      SELECT id, dashboard_id, worker_id, worker_pid, lease_expires_at
      FROM analytics_runs WHERE status = 'running'
      ORDER BY queued_at
    `).all() as Array<{
      id: string;
      dashboard_id: string;
      worker_id: string | null;
      worker_pid: number | null;
      lease_expires_at: string | null;
    }>;
    const interrupted = candidates.filter(run => {
      const leaseExpiry = Date.parse(run.lease_expires_at || '');
      const leaseActive = Number.isFinite(leaseExpiry) && leaseExpiry > Date.now();
      return !leaseActive || !processIsAlive(run.worker_pid);
    });
    if (!interrupted.length) return 0;

    let recovered = 0;
    db.transaction(() => {
      for (const run of interrupted) {
        const progress = db.prepare(`
          SELECT COUNT(*) AS widget_count,
            SUM(CASE WHEN status IN ('completed','failed') THEN 1 ELSE 0 END) AS widgets_completed,
            SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS widgets_succeeded
          FROM analytics_run_widgets WHERE run_id = ?
        `).get(run.id) as any;
        const claimed = db.prepare(`
          UPDATE analytics_runs SET status = 'queued',
            widget_count = ?, widgets_completed = ?, widgets_succeeded = ?,
            current_widget_id = NULL, started_at = NULL, heartbeat_at = NULL,
            lease_expires_at = NULL, worker_id = NULL, worker_pid = NULL,
            error = NULL, completed_at = NULL
          WHERE id = ? AND status = 'running'
            AND worker_id IS ? AND worker_pid IS ? AND lease_expires_at IS ?
        `).run(
          Number(progress.widget_count || 0),
          Number(progress.widgets_completed || 0),
          Number(progress.widgets_succeeded || 0),
          run.id,
          run.worker_id,
          run.worker_pid,
          run.lease_expires_at,
        );
        if (claimed.changes !== 1) continue;
        db.prepare(`
          UPDATE analytics_run_widgets SET status = 'queued', started_at = NULL
          WHERE run_id = ? AND status = 'running'
        `).run(run.id);
        db.prepare(`
          UPDATE analytics_dashboards SET status = 'refreshing', updated_at = datetime('now')
          WHERE id = ?
        `).run(run.dashboard_id);
        recovered++;
      }
    })();
    return recovered;
  }

  function leaseExpiresAt(): string {
    return new Date(Date.now() + queryTimeoutMs + 60_000).toISOString();
  }

  function ownsRun(runId: string): boolean {
    return Boolean(db.prepare(`
      SELECT 1 FROM analytics_runs
      WHERE id = ? AND status = 'running' AND worker_id = ? AND worker_pid = ?
    `).get(runId, workerId, process.pid));
  }

  async function executeRunWidget(row: any): Promise<AnalyticsWidgetResult> {
    const storedWidget = db.prepare(`
      SELECT 1 FROM analytics_widgets WHERE id = ? AND dashboard_id = ?
    `).get(row.widget_id, row.dashboard_id);
    if (!storedWidget) throw new Error('Widget definition is no longer available');

    if (row.kind === 'text') {
      const config = parseJson<Record<string, unknown>>(row.config_json, {});
      const text = cleanText(config.text, `${row.title} text`, 20_000, true);
      const refreshedAt = new Date().toISOString();
      return {
        trust: 'local_static_content',
        columns: ['text'],
        rows: [[text]],
        rowCount: 1,
        displayedRowCount: 1,
        refreshedAt,
      };
    }

    const sql = validateReadOnlySql(row.sql_query);
    const call = await mcpManager.callTool(
      'sql-context',
      'run_query',
      { sql },
      { source: 'dashboard', timeoutMs: queryTimeoutMs },
    );
    if (call.isError) throw new Error(call.text || 'SQL MCP returned an error');
    return parseSqlMcpResult(call.text);
  }

  function finalizeRun(runId: string): void {
    const run = db.prepare('SELECT * FROM analytics_runs WHERE id = ?').get(runId) as any;
    if (!run || run.status !== 'running' || run.worker_id !== workerId || run.worker_pid !== process.pid) return;
    const progress = db.prepare(`
      SELECT COUNT(*) AS widget_count,
        SUM(CASE WHEN status IN ('completed','failed') THEN 1 ELSE 0 END) AS widgets_completed,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS widgets_succeeded,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS widgets_failed
      FROM analytics_run_widgets WHERE run_id = ?
    `).get(runId) as any;
    if (Number(progress.widgets_completed || 0) !== Number(progress.widget_count || 0)) {
      throw new Error(`Run ${runId} still has unfinished widgets`);
    }
    const failures = db.prepare(`
      SELECT title, error FROM analytics_run_widgets
      WHERE run_id = ? AND status = 'failed' ORDER BY position
    `).all(runId) as Array<{ title: string; error: string | null }>;
    const errorSummary = failures.length
      ? failures.map(item => `${item.title}: ${item.error || 'Unknown widget failure'}`).join('\n').slice(0, 4000)
      : null;
    const status = failures.length ? 'failed' : 'completed';
    const dashboardStatus: AnalyticsDashboardStatus = failures.length ? 'degraded' : 'ready';
    const completedAt = new Date().toISOString();

    db.transaction(() => {
      const finalized = db.prepare(`
        UPDATE analytics_runs SET status = ?, widget_count = ?, widgets_completed = ?,
          widgets_succeeded = ?, current_widget_id = NULL, heartbeat_at = ?,
          lease_expires_at = NULL, worker_id = NULL, worker_pid = NULL,
          error = ?, completed_at = ?
        WHERE id = ? AND status = 'running' AND worker_id = ? AND worker_pid = ?
      `).run(
        status,
        Number(progress.widget_count || 0),
        Number(progress.widgets_completed || 0),
        Number(progress.widgets_succeeded || 0),
        completedAt,
        errorSummary,
        completedAt,
        runId,
        workerId,
        process.pid,
      );
      if (finalized.changes !== 1) throw new Error(`Run ${runId} ownership changed before finalization`);
      db.prepare(`
        UPDATE analytics_dashboards SET status = ?, last_error = ?,
          last_refreshed_at = ?, updated_at = datetime('now') WHERE id = ?
      `).run(dashboardStatus, errorSummary, completedAt, run.dashboard_id);
      if (run.schedule_id) {
        db.prepare(`
          UPDATE analytics_schedules SET last_run_at = ?,
            consecutive_failures = CASE WHEN ? IS NULL THEN 0 ELSE consecutive_failures + 1 END,
            last_error = ?, updated_at = datetime('now') WHERE id = ?
        `).run(completedAt, errorSummary, errorSummary, run.schedule_id);
      }
    })();
  }

  function failClaimedRun(runId: string, failure: unknown): void {
    const run = db.prepare('SELECT * FROM analytics_runs WHERE id = ?').get(runId) as any;
    if (!run || run.status !== 'running' || run.worker_id !== workerId || run.worker_pid !== process.pid) return;
    const message = String((failure as any)?.message ?? failure).slice(0, 4000)
      || 'Analytics queue worker failed unexpectedly';
    const completedAt = new Date().toISOString();
    db.transaction(() => {
      db.prepare(`
        UPDATE analytics_widgets SET last_error = ?, updated_at = datetime('now')
        WHERE dashboard_id = ? AND id IN (
          SELECT widget_id FROM analytics_run_widgets
          WHERE run_id = ? AND status IN ('queued','running')
        )
      `).run(message, run.dashboard_id, runId);
      db.prepare(`
        UPDATE analytics_run_widgets SET status = 'failed', error = ?,
          completed_at = ?, started_at = COALESCE(started_at, ?)
        WHERE run_id = ? AND status IN ('queued','running')
      `).run(message, completedAt, completedAt, runId);
      const progress = db.prepare(`
        SELECT COUNT(*) AS widget_count,
          SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS widgets_succeeded
        FROM analytics_run_widgets WHERE run_id = ?
      `).get(runId) as any;
      const failed = db.prepare(`
        UPDATE analytics_runs SET status = 'failed', widget_count = ?, widgets_completed = ?,
          widgets_succeeded = ?, current_widget_id = NULL, heartbeat_at = ?,
          lease_expires_at = NULL, worker_id = NULL, worker_pid = NULL,
          error = ?, completed_at = ?
        WHERE id = ? AND status = 'running' AND worker_id = ? AND worker_pid = ?
      `).run(
        Number(progress.widget_count || 0),
        Number(progress.widget_count || 0),
        Number(progress.widgets_succeeded || 0),
        completedAt,
        message,
        completedAt,
        runId,
        workerId,
        process.pid,
      );
      if (failed.changes !== 1) throw new Error(`Run ${runId} ownership changed while recording failure`);
      db.prepare(`
        UPDATE analytics_dashboards SET status = 'degraded', last_error = ?,
          last_refreshed_at = ?, updated_at = datetime('now') WHERE id = ?
      `).run(message, completedAt, run.dashboard_id);
      if (run.schedule_id) {
        db.prepare(`
          UPDATE analytics_schedules SET last_run_at = ?,
            consecutive_failures = consecutive_failures + 1,
            last_error = ?, updated_at = datetime('now') WHERE id = ?
        `).run(completedAt, message, run.schedule_id);
      }
    })();
  }

  async function processClaimedRun(runId: string): Promise<void> {
    while (true) {
      const widget = db.prepare(`
        SELECT rw.*, r.dashboard_id
        FROM analytics_run_widgets rw
        JOIN analytics_runs r ON r.id = rw.run_id
        WHERE rw.run_id = ? AND rw.status = 'queued'
          AND r.status = 'running' AND r.worker_id = ? AND r.worker_pid = ?
        ORDER BY rw.position LIMIT 1
      `).get(runId, workerId, process.pid) as any;
      if (!widget) break;

      const startedAt = new Date().toISOString();
      const claimed = db.transaction(() => {
        const result = db.prepare(`
          UPDATE analytics_run_widgets SET status = 'running', started_at = ?, error = NULL
          WHERE run_id = ? AND widget_id = ? AND status = 'queued'
        `).run(startedAt, runId, widget.widget_id);
        if (result.changes !== 1) return false;
        const parent = db.prepare(`
          UPDATE analytics_runs SET current_widget_id = ?, heartbeat_at = ?, lease_expires_at = ?
          WHERE id = ? AND status = 'running' AND worker_id = ? AND worker_pid = ?
        `).run(widget.widget_id, startedAt, leaseExpiresAt(), runId, workerId, process.pid);
        if (parent.changes !== 1) throw new Error(`Run ${runId} ownership changed before widget claim`);
        return true;
      })();
      if (!claimed) continue;

      try {
        const result = await executeRunWidget(widget);
        const completedAt = new Date().toISOString();
        db.transaction(() => {
          const progressed = db.prepare(`
            UPDATE analytics_runs SET widgets_completed = MIN(widget_count, widgets_completed + 1),
              widgets_succeeded = MIN(widget_count, widgets_succeeded + 1),
              current_widget_id = NULL, heartbeat_at = ?, lease_expires_at = ?
            WHERE id = ? AND status = 'running' AND worker_id = ? AND worker_pid = ?
          `).run(completedAt, leaseExpiresAt(), runId, workerId, process.pid);
          if (progressed.changes !== 1) throw new Error(`Run ${runId} ownership changed after widget execution`);
          const runWidget = db.prepare(`
            UPDATE analytics_run_widgets SET status = 'completed', error = NULL, completed_at = ?
            WHERE run_id = ? AND widget_id = ? AND status = 'running'
          `).run(completedAt, runId, widget.widget_id);
          if (runWidget.changes !== 1) throw new Error('Widget progress changed while its refresh was running');
          const updated = db.prepare(`
            UPDATE analytics_widgets SET result_json = ?, last_error = NULL,
              last_refreshed_at = ?, updated_at = datetime('now')
            WHERE id = ? AND dashboard_id = ?
          `).run(JSON.stringify(result), result.refreshedAt, widget.widget_id, widget.dashboard_id);
          if (updated.changes !== 1) throw new Error('Widget definition disappeared while its refresh was running');
        })();
      } catch (error: any) {
        if (!ownsRun(runId)) return;
        const message = String(error?.message ?? error).slice(0, 2000);
        const completedAt = new Date().toISOString();
        db.transaction(() => {
          const progressed = db.prepare(`
            UPDATE analytics_runs SET widgets_completed = MIN(widget_count, widgets_completed + 1),
              current_widget_id = NULL, heartbeat_at = ?, lease_expires_at = ?
            WHERE id = ? AND status = 'running' AND worker_id = ? AND worker_pid = ?
          `).run(completedAt, leaseExpiresAt(), runId, workerId, process.pid);
          if (progressed.changes !== 1) throw new Error(`Run ${runId} ownership changed while recording widget failure`);
          const runWidget = db.prepare(`
            UPDATE analytics_run_widgets SET status = 'failed', error = ?, completed_at = ?
            WHERE run_id = ? AND widget_id = ? AND status = 'running'
          `).run(message, completedAt, runId, widget.widget_id);
          if (runWidget.changes !== 1) throw new Error('Widget progress changed while recording its failure');
          db.prepare(`
            UPDATE analytics_widgets SET last_error = ?, updated_at = datetime('now')
            WHERE id = ? AND dashboard_id = ?
          `).run(message, widget.widget_id, widget.dashboard_id);
        })();
      }
    }
    finalizeRun(runId);
  }

  async function processQueuedRuns(limit = 1): Promise<number> {
    if (processingQueue) return 0;
    processingQueue = true;
    const boundedLimit = Math.max(1, Math.min(20, Math.floor(Number(limit) || 1)));
    let processed = 0;
    try {
      while (processed < boundedLimit) {
        const claimedRunId = db.transaction(() => {
          const queued = db.prepare(`
            SELECT id FROM analytics_runs WHERE status = 'queued'
            ORDER BY datetime(queued_at), id LIMIT 1
          `).get() as { id: string } | undefined;
          if (!queued) return null;
          const startedAt = new Date().toISOString();
          const claimed = db.prepare(`
            UPDATE analytics_runs SET status = 'running', started_at = COALESCE(started_at, ?),
              heartbeat_at = ?, lease_expires_at = ?, worker_id = ?, worker_pid = ?, error = NULL
            WHERE id = ? AND status = 'queued'
          `).run(startedAt, startedAt, leaseExpiresAt(), workerId, process.pid, queued.id);
          return claimed.changes === 1 ? queued.id : null;
        })();
        if (!claimedRunId) break;
        try {
          await processClaimedRun(claimedRunId);
        } catch (error) {
          console.error(`[Analytics queue] run ${claimedRunId} failed unexpectedly:`, error);
          failClaimedRun(claimedRunId, error);
        }
        processed++;
      }
      return processed;
    } finally {
      processingQueue = false;
    }
  }

  function deleteDashboard(id: string): void {
    const dashboard = getDashboard(id);
    if (!dashboard) throw new Error(`Dashboard ${id} not found`);
    const running = activeRun(id);
    if (running) {
      throw new Error(`Dashboard cannot be deleted while refresh ${running.id} is ${running.status}`);
    }
    const publishing = db.prepare(`
      SELECT 1 FROM dashboard_publications
      WHERE dashboard_id = ? AND status = 'publishing' LIMIT 1
    `).get(id);
    if (publishing) throw new Error('Dashboard cannot be deleted while a snapshot is publishing');
    const deleted = db.prepare('DELETE FROM analytics_dashboards WHERE id = ?').run(id);
    if (deleted.changes !== 1) throw new Error(`Dashboard ${id} not found`);
  }

  return {
    listDashboards,
    getDashboard,
    createDashboard,
    updateDashboard,
    deleteDashboard,
    setSchedule,
    enqueueRefresh,
    getRun,
    recoverInterruptedRuns,
    processQueuedRuns,
  };
}
