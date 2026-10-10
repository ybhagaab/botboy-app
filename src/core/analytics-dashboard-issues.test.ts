import { describe, it, expect } from 'vitest';
import { dashboardIssues, widgetDataIssues, createViewIssueReports } from './analytics-dashboard-issues.js';

const widget = (overrides: Record<string, unknown>) => ({ id: 'w1', dashboardId: 'd', title: 'Daily', kind: 'table', config: {}, ...overrides }) as any;

describe('dashboard warnings & issues (2026-10-10)', () => {
  it('flags a metric that stopped or went to zero in the latest period (long data)', () => {
    const rows = [
      ['2026-08-03', 'clicks', 120], ['2026-08-04', 'visitors', 900], ['2026-08-05', 'streams', 40],
      ['2026-09-03', 'visitors', 950], ['2026-09-04', 'streams', 0],
    ];
    const issues = widgetDataIssues(widget({ result: { columns: ['date', 'metrics_name', 'total'], rows, rowCount: rows.length } }));
    expect(issues.map(issue => [issue.metric, issue.message])).toEqual([
      ['clicks', 'clicks has rows for 2026-08 but none for 2026-09: it may have stopped or been renamed.'],
      ['streams', 'streams is 0 in 2026-09 after 40 in 2026-08.'],
    ]);
  });

  it('flags failed refreshes, empty and truncated results, and all-zero columns; text and html have none', () => {
    expect(widgetDataIssues(widget({ lastError: 'timeout', result: undefined }))).toMatchObject([{ severity: 'error' }]);
    expect(widgetDataIssues(widget({ result: { columns: ['n'], rows: [], rowCount: 0 } }))[0].message).toMatch(/no rows/);
    expect(widgetDataIssues(widget({ result: { columns: ['n'], rows: [[1]], rowCount: 9 } }))[0].message).toMatch(/1 of 9 rows/);
    expect(widgetDataIssues(widget({ result: { columns: ['day', 'clicks'], rows: [['a', 0], ['b', 0]], rowCount: 2 } }))).toMatchObject([{ metric: 'clicks' }]);
    expect(widgetDataIssues(widget({ kind: 'html', result: { columns: ['html'], rows: [['x']], rowCount: 1 } }))).toEqual([]);
  });

  it('adds what each html view reported, by widget', () => {
    const reports = createViewIssueReports();
    reports.set('d', 'w2', [{ metric: 'Clicks', message: 'No rows for 2026-09', severity: 'warn', source: 'view' }, { message: '' }]);
    const dashboard = { id: 'd', widgets: [widget({ id: 'w2', kind: 'html', title: 'Page' })] } as any;
    expect(dashboardIssues(dashboard, reports.get('d'))).toEqual([
      { id: 'w2:view:0', widgetId: 'w2', widgetTitle: 'Page', metric: 'Clicks', severity: 'warn', message: 'No rows for 2026-09', source: 'view' },
    ]);
  });
});
