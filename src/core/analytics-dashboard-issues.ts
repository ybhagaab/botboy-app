/**
 * Warnings and issues for one dashboard (docs/maps/analytics.md, "Issues").
 *
 * Owner job: a figure that looks wrong is noticed, explained, and shown in
 * two places: the dashboard's Warnings & issues panel and on the figure
 * itself. Two sources:
 *   - data checks here, over each widget's persisted rows (deterministic);
 *   - checks inside a model-designed html view (window.botboy.warn plus
 *     BotBoy's scan of the rendered page), reported by the owner's page.
 * Issues are evidence for the owner and the model, never a block.
 */

import type { AnalyticsDashboard, AnalyticsWidget } from './analytics-types.js';

export interface DashboardIssue {
  id: string;
  widgetId: string;
  widgetTitle: string;
  /** The metric or column the issue is about ('' for the whole widget). */
  metric: string;
  severity: 'warn' | 'error';
  message: string;
  source: 'data' | 'view' | 'auto';
}

const MAX_ISSUES = 80;

function numeric(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return null;
}

/** The column that names a series in long data (metrics_name, metric, name …), if any. */
function seriesColumn(columns: string[], rows: unknown[][]): number {
  const preferred = columns.findIndex(name => /^(metrics?_?name|metric|series|kpi|measure)$/i.test(name));
  if (preferred >= 0) return preferred;
  return -1;
}

function timeColumn(columns: string[], rows: unknown[][]): number {
  return columns.findIndex((name, index) => /date|day|week|month|period|time/i.test(name)
    && rows.slice(0, 20).every(row => row[index] == null || /^\d{4}-\d{2}/.test(String(row[index]))));
}

/** Data checks over one widget's rows. */
export function widgetDataIssues(widget: AnalyticsWidget): DashboardIssue[] {
  const issues: DashboardIssue[] = [];
  const add = (metric: string, severity: DashboardIssue['severity'], message: string) => {
    issues.push({ id: `${widget.id}:${metric}:${issues.length}`, widgetId: widget.id, widgetTitle: widget.title, metric, severity, message, source: 'data' });
  };
  if (widget.kind === 'text' || widget.kind === 'html') return issues;
  const result = widget.result;
  if (widget.lastError) {
    add('', result ? 'warn' : 'error', result
      ? `The last refresh failed; this widget shows its previous result (${String(widget.lastError).slice(0, 160)}).`
      : `This widget has no data: ${String(widget.lastError).slice(0, 200)}.`);
  }
  if (!result) return issues;
  const columns = (result.columns ?? []).map(String);
  const rows = (result.rows ?? []) as unknown[][];
  if (!rows.length) {
    add('', 'warn', 'The query returned no rows.');
    return issues;
  }
  if (Number(result.rowCount) > rows.length) {
    add('', 'warn', `Shows ${rows.length.toLocaleString()} of ${Number(result.rowCount).toLocaleString()} rows; totals over this widget are incomplete.`);
  }
  const numericColumns = columns.map((_, index) => rows.some(row => numeric(row[index]) !== null));
  // A whole numeric column of zeros or blanks.
  columns.forEach((name, index) => {
    if (!numericColumns[index]) return;
    const values = rows.map(row => numeric(row[index]));
    if (values.every(value => value === 0 || value === null)) {
      add(name, 'warn', `Every value of ${name} is ${values.every(value => value === null) ? 'blank' : 'zero'}.`);
    }
  });
  // Long data (one row per metric and date): a metric that stopped.
  const series = seriesColumn(columns, rows);
  const time = timeColumn(columns, rows);
  const value = columns.findIndex((name, index) => numericColumns[index] && index !== time && /^(total|value|count|amount|sum)$/i.test(name));
  if (series >= 0 && time >= 0) {
    const latestPeriod = (row: unknown[]) => String(row[time] ?? '').slice(0, 7);
    const periods = [...new Set(rows.map(latestPeriod).filter(Boolean))].sort();
    const latest = periods[periods.length - 1];
    const previous = periods[periods.length - 2];
    if (latest && previous) {
      const bySeries = new Map<string, { latest: number; previous: number; seen: Set<string> }>();
      for (const row of rows) {
        const name = String(row[series] ?? '');
        const period = latestPeriod(row);
        const entry = bySeries.get(name) ?? { latest: 0, previous: 0, seen: new Set<string>() };
        entry.seen.add(period);
        const amount = value >= 0 ? numeric(row[value]) ?? 0 : 1;
        if (period === latest) entry.latest += amount;
        if (period === previous) entry.previous += amount;
        bySeries.set(name, entry);
      }
      for (const [name, entry] of bySeries) {
        if (entry.seen.has(previous) && !entry.seen.has(latest)) {
          add(name, 'warn', `${name} has rows for ${previous} but none for ${latest}: it may have stopped or been renamed.`);
        } else if (entry.previous > 0 && entry.latest === 0) {
          add(name, 'warn', `${name} is 0 in ${latest} after ${entry.previous.toLocaleString()} in ${previous}.`);
        }
      }
    }
  }
  return issues;
}

/** Every data issue on a dashboard, plus the html views' last reports. */
export function dashboardIssues(
  dashboard: AnalyticsDashboard,
  viewReports: Map<string, Array<Pick<DashboardIssue, 'metric' | 'severity' | 'message' | 'source'>>> = new Map(),
): DashboardIssue[] {
  const issues: DashboardIssue[] = [];
  for (const widget of dashboard.widgets) {
    issues.push(...widgetDataIssues(widget));
    const reported = viewReports.get(widget.id) ?? [];
    reported.forEach((issue, index) => issues.push({
      id: `${widget.id}:view:${index}`,
      widgetId: widget.id,
      widgetTitle: widget.title,
      metric: issue.metric,
      severity: issue.severity,
      message: issue.message,
      source: issue.source,
    }));
  }
  return issues.slice(0, MAX_ISSUES);
}

/**
 * html views' latest reports, kept in memory per dashboard (the owner's page
 * posts them; nothing is persisted, they are recomputed on every render).
 */
export function createViewIssueReports() {
  const reports = new Map<string, Map<string, Array<Pick<DashboardIssue, 'metric' | 'severity' | 'message' | 'source'>>>>();
  return {
    set(dashboardId: string, widgetId: string, issues: unknown): void {
      const list = Array.isArray(issues) ? issues.slice(0, 60).map(raw => {
        const item = (raw ?? {}) as Record<string, unknown>;
        return {
          metric: String(item.metric ?? '').slice(0, 80),
          severity: item.severity === 'error' ? 'error' as const : 'warn' as const,
          message: String(item.message ?? '').slice(0, 400),
          source: item.source === 'auto' ? 'auto' as const : 'view' as const,
        };
      }).filter(item => item.message) : [];
      const byWidget = reports.get(dashboardId) ?? new Map();
      byWidget.set(widgetId, list);
      reports.set(dashboardId, byWidget);
      if (reports.size > 100) reports.delete(reports.keys().next().value as string);
    },
    get(dashboardId: string) {
      return reports.get(dashboardId) ?? new Map();
    },
  };
}
export type ViewIssueReports = ReturnType<typeof createViewIssueReports>;

/** The one process-wide store (the UI posts, the API and chat tools read). */
export const viewIssueReports = createViewIssueReports();
