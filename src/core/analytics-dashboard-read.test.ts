import { describe, expect, it } from 'vitest';
import { dashboardReadForModel, MODEL_READ_BUDGET_CHARS, widgetReadForModel } from './analytics-dashboard-read.js';
import type { AnalyticsDashboard, AnalyticsWidget } from './analytics-types.js';
import type { DashboardIssue } from './analytics-dashboard-issues.js';

/**
 * get_analytics_dashboard's reads always fit under the 40,000-character tool
 * result cap (owner report 2026-10-20: a head cut lost the html page and the
 * last widgets of a nine-widget dashboard, so BotBoy could not edit it).
 */
const AT = '2026-10-20T10:00:00.000Z';

function widget(id: string, overrides: Partial<AnalyticsWidget> = {}): AnalyticsWidget {
  return {
    id, dashboardId: 'dash_read', revision: 1, bindingRevision: 0, position: 0,
    kind: 'table', title: `Widget ${id}`, subtitle: '', sql: 'SELECT 1', config: {},
    createdAt: AT, updatedAt: AT, ...overrides,
  } as AnalyticsWidget;
}

function rows(count: number, width: number): Array<Array<string | number>> {
  return Array.from({ length: count }, (_, row) => Array.from({ length: width }, (_, column) => (column === 0 ? `2026-10-${String(row % 28 + 1).padStart(2, '0')}` : row * 1_000 + column)));
}

function result(count: number, width: number) {
  return {
    trust: 'governed_remote_data', lane: 'sql-mcp',
    columns: Array.from({ length: width }, (_, column) => `column_${column}`),
    rows: rows(count, width), rowCount: count, displayedRowCount: count, refreshedAt: AT,
  } as any;
}

function dashboard(widgets: AnalyticsWidget[], runs = 0): AnalyticsDashboard {
  return {
    id: 'dash_read', title: 'OTT Downloads', description: 'Downloads only.', theme: 'executive', status: 'ready',
    widgetCount: widgets.length, projectCount: 0, createdAt: AT, updatedAt: AT, lastRefreshedAt: AT,
    projectIds: [], widgets: widgets.map((item, position) => ({ ...item, position })),
    recentRuns: Array.from({ length: runs }, (_, index) => ({
      id: `run_${index}`, dashboardId: 'dash_read', trigger: 'manual', status: 'completed', refreshScope: 'full',
      widgetCount: widgets.length, widgetsCompleted: widgets.length, widgetsSucceeded: widgets.length,
      cancelRequested: false, queuedAt: AT, completedAt: AT, lateEtlResults: [{ receipt: 'x'.repeat(500) }],
    })),
  } as any;
}

const ISSUES: DashboardIssue[] = [
  { id: 'i1', widgetId: 'widget_0', widgetTitle: 'Widget 0', metric: 'column_1', severity: 'warn', message: 'Looks low.', source: 'data' },
  { id: 'i2', widgetId: 'widget_page', widgetTitle: 'Overview', metric: '', severity: 'error', message: 'View error.', source: 'view' },
];

/** The OTT Downloads shape: eight hidden warehouse tables, then the html page last. */
function downloadsDashboard(): AnalyticsDashboard {
  const tables = Array.from({ length: 8 }, (_, index) => widget(`widget_${index}`, {
    sql: `WITH base AS (SELECT * FROM events WHERE country = 'IN')\nSELECT ${'column, '.repeat(300)}1 FROM base`,
    config: { key: `table_${index}`, hidden: true },
    result: result(index === 2 ? 100 : 30, 14),
  }));
  const page = widget('widget_page', { kind: 'html', title: 'Overview', sql: undefined, config: { html: `<main>${'<section><h2>Successful terminal reports</h2></section>'.repeat(220)}</main>`, inputs: tables.map((_, index) => `table_${index}`), span: 12 } });
  return dashboard([...tables, page], 12);
}

describe('dashboardReadForModel', () => {
  it('returns a dashboard that fits exactly as before', () => {
    const small = dashboard([widget('widget_0', { result: result(3, 2) })], 1);
    expect(dashboardReadForModel(small, ISSUES)).toBe(JSON.stringify({ ...small, issues: ISSUES }, null, 1));
  });

  it('drops only the indentation when that is enough', () => {
    const medium = dashboard([widget('widget_0', { result: result(120, 6) })]);
    const pretty = JSON.stringify({ ...medium, issues: ISSUES }, null, 1);
    const compact = JSON.stringify({ ...medium, issues: ISSUES });
    const budget = Math.floor((pretty.length + compact.length) / 2);
    const out = dashboardReadForModel(medium, ISSUES, budget);
    expect(out).toBe(compact);
    expect(JSON.parse(out)).toEqual({ ...medium, issues: ISSUES });
  });

  it('fits a large dashboard: every widget\'s settings, the issues first, no html page, and the call that reads one widget', () => {
    const large = downloadsDashboard();
    expect(JSON.stringify({ ...large, issues: ISSUES }).length).toBeGreaterThan(MODEL_READ_BUDGET_CHARS);
    const out = dashboardReadForModel(large, ISSUES);
    expect(out.length).toBeLessThanOrEqual(MODEL_READ_BUDGET_CHARS);
    const read = JSON.parse(out);
    expect(read.readNote).toMatch(/call get_analytics_dashboard with dashboardId and widgetId/);
    expect(out.indexOf('"issues"')).toBeLessThan(out.indexOf('"widgets"'));
    expect(read.issues).toEqual(ISSUES);
    expect(read.widgets.map((item: any) => item.id)).toEqual(large.widgets.map(item => item.id));
    const page = read.widgets.at(-1);
    expect(page.config).toEqual({ inputs: large.widgets.at(-1)!.config.inputs, span: 12, htmlChars: String(large.widgets.at(-1)!.config.html).length });
    const first = read.widgets[0];
    expect(first).toMatchObject({ id: 'widget_0', revision: 1, kind: 'table', config: { key: 'table_0', hidden: true }, sqlChars: large.widgets[0].sql!.length });
    expect(first.sql.length).toBeLessThanOrEqual(1_501);
    expect(first.result).toMatchObject({ columns: large.widgets[0].result!.columns, rowCount: 30, refreshedAt: AT });
    expect(first.result.sampleRows).toEqual(large.widgets[0].result!.rows.slice(0, 5));
    expect(read.recentRuns.length).toBeLessThanOrEqual(3);
    expect(read.recentRuns[0]).not.toHaveProperty('lateEtlResults');
  });

  it('keeps a short chart spec in the summary and gives the length of a long one', () => {
    const large = downloadsDashboard();
    const small = { mark: 'line', encoding: { x: { field: 'column_0' }, y: { field: 'column_1' } } };
    const long = { mark: 'bar', transform: Array.from({ length: 80 }, (_, index) => ({ calculate: `datum.column_${index % 14} * 100`, as: `scaled_${index}` })) };
    const board = dashboard([
      ...large.widgets,
      widget('widget_small', { kind: 'visualization', config: { spec: small } }),
      widget('widget_long', { kind: 'visualization', config: { spec: long } }),
    ]);
    expect(JSON.stringify(long).length).toBeGreaterThan(2_000);
    const read = JSON.parse(dashboardReadForModel(board, ISSUES));
    expect(read.widgets.at(-2).config).toEqual({ spec: small });
    expect(read.widgets.at(-1).config).toEqual({ specChars: JSON.stringify(long).length });
  });

  it('gives up sample rows and SQL before it would ever be cut', () => {
    const large = downloadsDashboard();
    const out = dashboardReadForModel(large, ISSUES, 9_000);
    expect(out.length).toBeLessThanOrEqual(9_000);
    const read = JSON.parse(out);
    expect(read.widgets).toHaveLength(9);
    expect(read.widgets[0].result).not.toHaveProperty('sampleRows');
    expect(read.readNote).toMatch(/widgetId/);
  });
});

describe('widgetReadForModel', () => {
  it('returns one widget whole, with its own issues only', () => {
    const board = downloadsDashboard();
    const out = widgetReadForModel(board, board.widgets.at(-1)!, ISSUES);
    const read = JSON.parse(out);
    expect(read.widget).toEqual(board.widgets.at(-1));
    expect(read.widget.config.html).toBe(board.widgets.at(-1)!.config.html);
    expect(read.issues).toEqual([ISSUES[1]]);
    expect(read.dashboard).toMatchObject({ id: 'dash_read', title: 'OTT Downloads', widgetCount: 9 });
  });

  it('keeps the first rows that fit and says how many were left out', () => {
    const big = widget('widget_0', { result: result(4_000, 10) });
    const board = dashboard([big]);
    const out = widgetReadForModel(board, board.widgets[0], ISSUES);
    expect(out.length).toBeLessThanOrEqual(MODEL_READ_BUDGET_CHARS);
    const read = JSON.parse(out);
    const shown = read.widget.result.rows.length;
    expect(shown).toBeGreaterThan(100);
    expect(read.widget.result).toMatchObject({ rowsShown: shown, rowsOmitted: 4_000 - shown, rowCount: 4_000, columns: big.result!.columns });
    expect(read.widget.result.rows).toEqual(big.result!.rows.slice(0, shown));
    expect(read.readNote).toBe(`Only the first ${shown} of 4000 rows fit in one read.`);
    expect(read.widget.sql).toBe(big.sql);
  });

  it('returns a very long page in parts that join back exactly, never splitting a character', () => {
    const html = `<main data-x="a\\"b">\n${'Café — “quoted” ✓ 😀 <b>bold</b>\n'.repeat(4_000)}</main>`;
    const page = widget('widget_page', { kind: 'html', title: 'Overview', sql: undefined, config: { html, inputs: [], span: 12 } });
    const board = dashboard([page]);
    let offset = 0;
    let joined = '';
    let parts = 0;
    for (;;) {
      const out = widgetReadForModel(board, board.widgets[0], ISSUES, { htmlOffset: offset });
      expect(out.length).toBeLessThanOrEqual(MODEL_READ_BUDGET_CHARS);
      const read = JSON.parse(out);
      expect(read.htmlPart).toMatchObject({ offset, total: html.length });
      expect(read.htmlPart.length).toBe(read.widget.config.html.length);
      joined += read.widget.config.html;
      parts += 1;
      if (read.htmlPart.nextOffset < 0) {
        expect(read.readNote).toMatch(/the last part/);
        break;
      }
      expect(read.readNote).toMatch(new RegExp(`htmlOffset ${read.htmlPart.nextOffset} for the next part`));
      offset = read.htmlPart.nextOffset;
      expect(parts).toBeLessThan(40);
    }
    expect(parts).toBeGreaterThan(2);
    expect(joined).toBe(html);
  });

  it('never ends a part inside a two-unit character, whichever way the characters line up', () => {
    // An emoji is two UTF-16 units; the leading "a" shifts every pair by one, so one of these pages
    // would split a pair at the first cut if the cut were not moved back.
    for (const html of ['😀'.repeat(60_000), `a${'😀'.repeat(60_000)}`]) {
      const page = widget('widget_page', { kind: 'html', title: 'Emoji', sql: undefined, config: { html } });
      const board = dashboard([page]);
      let offset = 0;
      let joined = '';
      for (let part = 0; part < 40; part += 1) {
        const read = JSON.parse(widgetReadForModel(board, board.widgets[0], [], { htmlOffset: offset }));
        const text: string = read.widget.config.html;
        expect(/[\ud800-\udbff]$/.test(text), `part ${part} ends inside a character`).toBe(false);
        expect(/^[\udc00-\udfff]/.test(text), `part ${part} starts inside a character`).toBe(false);
        joined += text;
        if (read.htmlPart.nextOffset < 0) break;
        offset = read.htmlPart.nextOffset;
      }
      expect(joined).toBe(html);
    }
  });

  it('refuses an htmlOffset past the page or on a widget without one', () => {
    const page = widget('widget_page', { kind: 'html', sql: undefined, config: { html: '<p>short</p>' } });
    const board = dashboard([page, widget('widget_0')]);
    expect(JSON.parse(widgetReadForModel(board, board.widgets[0], [], { htmlOffset: 12 }))).toMatchObject({ ok: false, error: expect.stringMatching(/past the end/) });
    expect(JSON.parse(widgetReadForModel(board, board.widgets[1], [], { htmlOffset: 1 }))).toMatchObject({ ok: false, error: expect.stringMatching(/not an html view/) });
    // Offset 0 on a short page is an ordinary whole read.
    expect(JSON.parse(widgetReadForModel(board, board.widgets[0], [], { htmlOffset: 0 })).widget.config.html).toBe('<p>short</p>');
  });
});
