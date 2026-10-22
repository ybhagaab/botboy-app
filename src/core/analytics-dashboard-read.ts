/**
 * What get_analytics_dashboard shows the model (docs/maps/analytics.md, "Model reads").
 *
 * Every tool result is cut at 40,000 characters (tool-executor.ts ›
 * MAX_MODEL_VISIBLE_TOOL_RESULT_CHARS). A head cut of a large dashboard lost
 * its last widgets, html page included, and BotBoy could not edit it (owner
 * report 2026-10-20). These reads always fit instead:
 *   - a dashboard that fits is returned whole, as before;
 *   - one that does not fit returns every widget's settings, columns, row
 *     count and a few sample rows, and names the call that reads one widget;
 *   - one widget is returned whole; when its rows do not fit only the first
 *     ones are kept, and a very long html page comes in parts (htmlOffset).
 */
import type { AnalyticsDashboard, AnalyticsWidget } from './analytics-types.js';
import type { DashboardIssue } from './analytics-dashboard-issues.js';

/** Room below the 40,000-character tool-result cap for its truncation note. */
export const MODEL_READ_BUDGET_CHARS = 38_000;

const SUMMARY_LEVELS: ReadonlyArray<{ sampleRows: number; sqlChars: number; runs: number }> = [
  { sampleRows: 5, sqlChars: 1_500, runs: 3 },
  { sampleRows: 2, sqlChars: 600, runs: 2 },
  { sampleRows: 0, sqlChars: 300, runs: 1 },
  { sampleRows: 0, sqlChars: 0, runs: 0 },
];
const SPEC_INLINE_CHARS = 2_000;

function shortText(value: string, max: number): string | undefined {
  if (!max) return undefined;
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function widgetSummary(widget: AnalyticsWidget, level: { sampleRows: number; sqlChars: number }): Record<string, unknown> {
  const { html, spec, ...settings } = widget.config ?? {};
  const config: Record<string, unknown> = { ...settings };
  if (typeof html === 'string') config.htmlChars = html.length;
  if (spec !== undefined) {
    const text = JSON.stringify(spec);
    if (text.length <= SPEC_INLINE_CHARS) config.spec = spec;
    else config.specChars = text.length;
  }
  const result = widget.result;
  const source = result?.source as Record<string, unknown> | undefined;
  return {
    id: widget.id,
    revision: widget.revision,
    position: widget.position,
    kind: widget.kind,
    title: widget.title,
    ...(widget.subtitle ? { subtitle: widget.subtitle } : {}),
    ...(widget.preset ? { preset: widget.preset } : {}),
    ...(widget.sql ? { sqlChars: widget.sql.length, ...(level.sqlChars ? { sql: shortText(widget.sql, level.sqlChars) } : {}) } : {}),
    config,
    ...(widget.binding ? { binding: { datasetId: widget.binding.datasetId, versionPolicy: widget.binding.versionPolicy, compatibility: widget.binding.compatibility } } : {}),
    ...(result ? {
      result: {
        trust: result.trust,
        ...(result.lane ? { lane: result.lane } : {}),
        columns: result.columns,
        rowCount: result.rowCount,
        displayedRowCount: result.displayedRowCount,
        refreshedAt: result.refreshedAt,
        ...(level.sampleRows ? { sampleRows: (result.rows ?? []).slice(0, level.sampleRows) } : {}),
        ...(source ? { source: { provider: source.provider, ...(source.datasetId ? { datasetId: source.datasetId } : {}), ...(source.versionId ? { versionId: source.versionId } : {}) } } : {}),
      },
    } : {}),
    ...(widget.lastError ? { lastError: widget.lastError } : {}),
    ...(widget.lastRefreshedAt ? { lastRefreshedAt: widget.lastRefreshedAt } : {}),
  };
}

function dashboardSummary(
  dashboard: AnalyticsDashboard,
  issues: DashboardIssue[],
  level: { sampleRows: number; sqlChars: number; runs: number },
): Record<string, unknown> {
  const { widgets, recentRuns, latestPublication, latestSuccessfulPublication, schedule, ...head } = dashboard;
  const publication = latestSuccessfulPublication ?? latestPublication;
  return {
    ...head,
    readNote: `This dashboard is larger than one tool result, so each widget shows its settings, columns and row count${level.sampleRows ? ` with its first ${level.sampleRows} rows` : ''}; html pages${level.sqlChars ? ' and long SQL' : ' and SQL'} are left out. To read one widget complete (its html page, full SQL, settings and rows) call get_analytics_dashboard with dashboardId and widgetId.`,
    issues,
    widgets: widgets.map(widget => widgetSummary(widget, level)),
    ...(schedule ? { schedule } : {}),
    ...(publication ? { latestPublication: { id: publication.id, status: publication.status, ...(publication.url ? { url: publication.url } : {}), ...(publication.publishedAt ? { publishedAt: publication.publishedAt } : {}) } } : {}),
    recentRuns: recentRuns.slice(0, level.runs).map(run => ({
      id: run.id,
      status: run.status,
      trigger: run.trigger,
      refreshScope: run.refreshScope,
      widgetCount: run.widgetCount,
      widgetsSucceeded: run.widgetsSucceeded,
      queuedAt: run.queuedAt,
      ...(run.completedAt ? { completedAt: run.completedAt } : {}),
      ...(run.error ? { error: run.error } : {}),
    })),
  };
}

/** The whole dashboard when it fits, else every widget's settings with a few sample rows. */
export function dashboardReadForModel(
  dashboard: AnalyticsDashboard,
  issues: DashboardIssue[],
  budget = MODEL_READ_BUDGET_CHARS,
): string {
  const full = { ...dashboard, issues };
  const pretty = JSON.stringify(full, null, 1);
  if (pretty.length <= budget) return pretty;
  const compact = JSON.stringify(full);
  if (compact.length <= budget) return compact;
  let text = '';
  for (const level of SUMMARY_LEVELS) {
    text = JSON.stringify(dashboardSummary(dashboard, issues, level));
    if (text.length <= budget) return text;
  }
  return text;
}

/**
 * The longest prefix of value whose JSON string form fits in max characters. It never ends inside
 * a surrogate pair: JSON escapes a lone half as \uXXXX (6 characters), so a prefix that cuts a pair
 * costs more than the one that completes it, and the search always stops at a whole character.
 */
function fittingPrefix(value: string, max: number): string {
  if (JSON.stringify(value).length <= max) return value;
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (JSON.stringify(value.slice(0, middle)).length <= max) low = middle;
    else high = middle - 1;
  }
  return value.slice(0, low);
}

/**
 * One widget complete: its settings, html page, SQL and rows. Rows that do not
 * fit are cut to the first ones; a page that does not fit comes in parts.
 */
export function widgetReadForModel(
  dashboard: AnalyticsDashboard,
  widget: AnalyticsWidget,
  issues: DashboardIssue[],
  options: { htmlOffset?: number } = {},
  budget = MODEL_READ_BUDGET_CHARS,
): string {
  const head = {
    id: dashboard.id,
    title: dashboard.title,
    status: dashboard.status,
    widgetCount: dashboard.widgets.length,
    ...(dashboard.lastRefreshedAt ? { lastRefreshedAt: dashboard.lastRefreshedAt } : {}),
  };
  const own = issues.filter(issue => issue.widgetId === widget.id);
  const htmlOffset = options.htmlOffset ?? 0;
  const html = typeof widget.config?.html === 'string' ? widget.config.html : '';
  if (htmlOffset > 0 && !html) {
    return JSON.stringify({ ok: false, error: `Widget ${widget.id} is not an html view; htmlOffset applies only to an html page.`, nextAction: 'Read the widget without htmlOffset.' });
  }
  if (htmlOffset > 0 && htmlOffset >= html.length) {
    return JSON.stringify({ ok: false, error: `htmlOffset ${htmlOffset} is past the end of the page (${html.length} characters).`, nextAction: 'Use an htmlOffset smaller than the page length, or 0 for the start.' });
  }
  if (!htmlOffset) {
    const whole = { dashboard: head, widget, issues: own };
    const pretty = JSON.stringify(whole, null, 1);
    if (pretty.length <= budget) return pretty;
    const compact = JSON.stringify(whole);
    if (compact.length <= budget) return compact;
  }

  // Rows first: keep as many leading rows as fit beside the whole page.
  const rows = widget.result?.rows ?? [];
  const withRows = (count: number, page: string, part?: Record<string, number>) => {
    const config = html ? { ...widget.config, html: page } : widget.config;
    const result = widget.result
      ? { ...widget.result, rows: rows.slice(0, count), ...(count < rows.length ? { rowsShown: count, rowsOmitted: rows.length - count } : {}) }
      : undefined;
    const note = part
      ? `This page is ${part.total} characters, longer than one tool result: config.html holds characters ${part.offset} to ${part.offset + part.length}${part.nextOffset >= 0
        ? `. Call get_analytics_dashboard with the same dashboardId, widgetId and htmlOffset ${part.nextOffset} for the next part.`
        : ', the last part.'} Rows are left out here; read them with htmlOffset 0. To change this page, use edit_analytics_dashboard presentation.htmlEdits with exact text from these parts.`
      : count < rows.length
        ? `Only the first ${count} of ${rows.length} rows fit in one read.`
        : undefined;
    return JSON.stringify({
      dashboard: head,
      ...(note ? { readNote: note } : {}),
      ...(part ? { htmlPart: part } : {}),
      widget: { ...widget, config, ...(result ? { result } : {}) },
      issues: own,
    });
  };
  if (!htmlOffset && withRows(0, html).length <= budget) {
    let low = 0;
    let high = rows.length;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (withRows(middle, html).length <= budget) low = middle;
      else high = middle - 1;
    }
    return withRows(low, html);
  }

  // The page itself is too long: return it in parts, without rows.
  const rest = withRows(0, '', { offset: htmlOffset, length: 0, total: html.length, nextOffset: html.length }).length;
  const room = Math.max(1_000, budget - rest - 64);
  const slice = fittingPrefix(html.slice(htmlOffset), room);
  const end = htmlOffset + slice.length;
  return withRows(0, slice, {
    offset: htmlOffset,
    length: slice.length,
    total: html.length,
    nextOffset: end < html.length ? end : -1,
  });
}
