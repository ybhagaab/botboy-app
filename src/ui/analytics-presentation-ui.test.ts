// @vitest-environment jsdom
//
// Dashboard widgets show config.columnLabels in table headers and config.note in italics under the widget
// (owner report 2026-10-20: plain-language labels and a note under each table). Rendered from the shipped
// dashboard.js against a small state object, like ai-model-show-thinking-ui.test.ts.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const dashboard = readFileSync(path.join(process.cwd(), 'src/ui/dashboard.js'), 'utf8');
const css = readFileSync(path.join(process.cwd(), 'src/ui/dashboard.css'), 'utf8');

function topLevel(name: string): string {
  const start = dashboard.search(new RegExp(`\\n(?:async )?function ${name}\\(`));
  expect(start, `missing function ${name}`).toBeGreaterThanOrEqual(0);
  const end = dashboard.indexOf('\n}\n', start);
  return dashboard.slice(start, end + 2);
}
function constLine(name: string): string {
  const match = dashboard.match(new RegExp(`\\nconst ${name} = .*\\n`));
  expect(match, `missing const ${name}`).not.toBeNull();
  return match![0];
}

function load(issues: unknown[] = []) {
  const source = [
    constLine('esc'), constLine('attr'), constLine('number'),
    topLevel('analyticsCell'), topLevel('analyticsColumnLabel'), topLevel('analyticsWidgetNote'),
    topLevel('renderAnalyticsTable'), topLevel('renderAnalyticsWidget'),
    'return { table: renderAnalyticsTable, widget: renderAnalyticsWidget, label: analyticsColumnLabel, note: analyticsWidgetNote };',
  ].join('\n');
  const stub = () => '';
  const state = { analytics: { shownRowSort: new Map(), controlOpen: new Set() } };
  // eslint-disable-next-line no-new-func
  return new Function(
    'state', 'icon', 'relativeTime', 'independentSourceVersion', 'sortAnalyticsShownRows',
    'renderAnalyticsMetric', 'renderAnalyticsBars', 'renderAnalyticsLine', 'renderAnalyticsText',
    'renderAnalyticsDataRoomProvenance', 'renderAnalyticsManageData', 'analyticsIssuesFor', source,
  )(state, stub, () => 'just now', stub, (rows: unknown[]) => rows, stub, stub, stub, stub, stub, stub, () => issues) as {
    table(widget: unknown, result: unknown): string;
    widget(widget: unknown): string;
    label(widget: unknown, column: unknown): string;
    note(widget: unknown): string;
  };
}

const RESULT = {
  trust: 'governed_remote_data', columns: ['successful_terminal_reports', 'p50_elapsed_minutes', 'day'],
  rows: [[1200, 4.5, '2026-10-19']], rowCount: 1, displayedRowCount: 1, refreshedAt: '2026-10-20T10:00:00.000Z',
};
const widget = (config: Record<string, unknown>, kind = 'table') => ({
  id: 'widget_lifecycle', dashboardId: 'dash_downloads', revision: 2, kind, title: 'Download lifecycle', subtitle: '',
  sql: 'SELECT 1', config, result: RESULT,
});

describe('table column labels', () => {
  it('shows each label in its header and keeps the query column name for sorting, tooltips and issues', () => {
    const { table } = load();
    document.body.innerHTML = table(widget({ columnLabels: { successful_terminal_reports: 'Successful download reports', p50_elapsed_minutes: 'Median time <min>' } }), RESULT);
    const buttons = [...document.querySelectorAll('th button')] as HTMLButtonElement[];
    expect(buttons.map(button => button.textContent)).toEqual(['Successful download reports', 'Median time <min>', 'day']);
    expect(buttons.map(button => button.dataset.columnName)).toEqual(RESULT.columns);
    expect(buttons[0].title).toBe('Column successful_terminal_reports. Sort only the rows currently shown');
    expect(buttons[2].title).toBe('Sort only the rows currently shown');
    expect(document.querySelector('th b, th min')).toBeNull();
  });

  it('ignores a label map or label the server never sends', () => {
    const { label } = load();
    for (const config of [{}, { columnLabels: null }, { columnLabels: ['x'] }, { columnLabels: { day: 5 } }, { columnLabels: { day: '   ' } }, { columnLabels: 'day' }]) {
      expect(label(widget(config), 'day'), JSON.stringify(config)).toBe('day');
    }
    expect(label(widget({ columnLabels: { day: '  Day  ' } }), 'day')).toBe('Day');
    expect(label(widget({ columnLabels: { constructor: 'x' } }), 'toString')).toBe('toString');
  });
});

describe('the note under a widget', () => {
  it('renders the note escaped and in italics under the widget body, for tables and html views', () => {
    const { widget: render } = load();
    document.body.innerHTML = render(widget({ note: 'Successful download reports: <b>finished</b> events.\nNot unique downloads.' }));
    const note = document.querySelector('.analytics-note') as HTMLElement;
    expect(note.tagName).toBe('P');
    expect(note.textContent).toBe('Successful download reports: <b>finished</b> events.\nNot unique downloads.');
    expect(note.querySelector('b')).toBeNull();
    expect(note.previousElementSibling?.className).toBe('analytics-widget-body');
    document.body.innerHTML = render({ ...widget({ html: '<p>x</p>', inputs: [], note: 'About this page.' }, 'html'), sql: undefined });
    expect(document.querySelector('.analytics-html-widget .analytics-note')?.textContent).toBe('About this page.');
    expect(css).toMatch(/\.analytics-note \{[^}]*font-style:italic/);
  });

  it('renders nothing without a note', () => {
    const { note } = load();
    for (const config of [{}, { note: '' }, { note: '   ' }, { note: 5 }, { note: ['x'] }]) {
      expect(note(widget(config)), JSON.stringify(config)).toBe('');
    }
  });

  it('still flags an issue on a relabelled column by its query name', () => {
    const { widget: render } = load([{ widgetId: 'widget_lifecycle', metric: 'p50_elapsed_minutes', severity: 'warn', message: 'Looks high.' }]);
    document.body.innerHTML = render(widget({ columnLabels: { p50_elapsed_minutes: 'Median time' } }));
    const flagged = [...document.querySelectorAll('th button')].filter(button => button.textContent!.startsWith('⚠'));
    expect(flagged.map(button => button.textContent)).toEqual(['⚠ Median time']);
  });
});
