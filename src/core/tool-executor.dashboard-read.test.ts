import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createStorage, type StorageLayer } from './storage.js';
import { createNodeManager } from './node-manager.js';
import { createToolExecutor } from './tool-executor.js';

/**
 * get_analytics_dashboard through the executor (owner report 2026-10-20): a
 * nine-widget dashboard came back cut at 40,000 characters, without its html
 * page. Both reads now fit, and one widget can be read whole.
 */
const AT = '2026-10-20T10:00:00.000Z';
const PAGE = `<main>${'<section><h2>Successful terminal reports</h2></section>'.repeat(220)}</main>`;

function bigDashboard() {
  const tables = Array.from({ length: 8 }, (_, index) => ({
    id: `widget_${index}`, dashboardId: 'dash_big', revision: 1, bindingRevision: 0, position: index,
    kind: 'table', title: `Table ${index}`, subtitle: '', sql: `SELECT ${'column, '.repeat(300)}1`,
    config: { key: `table_${index}`, hidden: true }, createdAt: AT, updatedAt: AT,
    result: {
      trust: 'governed_remote_data', lane: 'sql-mcp', columns: Array.from({ length: 14 }, (_, column) => `column_${column}`),
      rows: Array.from({ length: 60 }, (_, row) => Array.from({ length: 14 }, (_, column) => row * 100 + column)),
      rowCount: 60, displayedRowCount: 60, refreshedAt: AT,
    },
  }));
  const page = {
    id: 'widget_page', dashboardId: 'dash_big', revision: 3, bindingRevision: 0, position: 8, kind: 'html', title: 'Overview',
    subtitle: '', config: { html: PAGE, inputs: tables.map(table => table.config.key), span: 12 }, createdAt: AT, updatedAt: AT,
  };
  return {
    id: 'dash_big', title: 'OTT Downloads', description: '', theme: 'executive', status: 'ready',
    widgetCount: 9, projectCount: 0, createdAt: AT, updatedAt: AT, projectIds: [], widgets: [...tables, page], recentRuns: [],
  };
}

describe('get_analytics_dashboard reads that fit', () => {
  let storage: StorageLayer;
  beforeEach(() => {
    storage = createStorage(':memory:');
    storage.initialize();
  });
  afterEach(() => {
    storage.close();
    vi.restoreAllMocks();
  });

  const executorFor = (board: any) => createToolExecutor(storage.getDb(), createNodeManager(storage.getDb()), {
    analyticsService: { getDashboard: (id: string) => (id === board.id ? board : null) } as any,
  });
  const read = (executor: ReturnType<typeof executorFor>, args: Record<string, unknown>) => executor.executeTool({
    id: 'read-1', type: 'function', function: { name: 'get_analytics_dashboard', arguments: JSON.stringify(args) },
  }, { callerKind: 'interactive', currentUserMessage: 'use simpler wording on the dashboard' });

  it('returns every widget of a large dashboard without the tool-result cut, and names the one-widget read', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const board = bigDashboard();
    const result = await read(executorFor(board), { dashboardId: 'dash_big' });
    expect(result.isError).toBe(false);
    expect(result.content.length).toBeLessThanOrEqual(40_000);
    expect(result.content).not.toContain('Tool result TRUNCATED');
    expect(warn.mock.calls.some(([line]) => String(line).includes('result capped'))).toBe(false);
    const parsed = JSON.parse(result.content);
    expect(parsed.widgets.map((widget: any) => widget.id)).toEqual(board.widgets.map(widget => widget.id));
    expect(parsed.widgets.at(-1).config).toMatchObject({ htmlChars: PAGE.length, span: 12 });
    expect(parsed.readNote).toMatch(/widgetId/);
  });

  it('reads one widget whole: the html page the dashboard read left out', async () => {
    const board = bigDashboard();
    const result = await read(executorFor(board), { dashboardId: 'dash_big', widgetId: 'widget_page' });
    expect(result.isError).toBe(false);
    const parsed = JSON.parse(result.content);
    expect(parsed.widget).toMatchObject({ id: 'widget_page', revision: 3, kind: 'html', config: { html: PAGE } });
    expect(parsed.dashboard).toMatchObject({ id: 'dash_big', widgetCount: 9 });
  });

  it('names the dashboard\'s widgets for an unknown widgetId and refuses a malformed htmlOffset', async () => {
    const board = bigDashboard();
    const executor = executorFor(board);
    const unknown = await read(executor, { dashboardId: 'dash_big', widgetId: 'widget_nope' });
    expect(unknown.content).toMatch(/^Error: widget widget_nope is not on dashboard dash_big\. Its widgets: widget_0 "Table 0", .*widget_page "Overview"$/);
    for (const htmlOffset of [-1, 1.5, 'x']) {
      const bad = await read(executor, { dashboardId: 'dash_big', widgetId: 'widget_page', htmlOffset });
      expect(bad.content).toBe('Error: htmlOffset must be a whole number of characters, 0 or more');
    }
  });

  it('passes every presentation field through to the edit service unchanged', async () => {
    const widget = { id: 'widget_page', title: 'Overview', revision: 4, bindingRevision: 0 };
    const editDataRoomWidget = vi.fn(() => ({
      action: 'presentation', dashboardId: 'dash_big', sourceWidgetIds: ['widget_page'], widget, resultDisposition: 'preserved',
    }));
    const executor = createToolExecutor(storage.getDb(), createNodeManager(storage.getDb()), {
      analyticsService: { editDataRoomWidget, getDashboard: () => ({ id: 'dash_big', title: 'OTT Downloads', widgets: [widget] }) } as any,
    });
    const presentation = {
      note: 'Counts reports, not unique downloads.',
      columnLabels: { successful_terminal_reports: 'Successful download reports' },
      htmlEdits: [{ find: 'Successful terminal reports', replace: 'Successful download reports' }],
      span: 12,
      hidden: false,
    };
    const result = await executor.executeTool({
      id: 'edit-1', type: 'function', function: {
        name: 'edit_analytics_dashboard',
        arguments: JSON.stringify({ action: 'presentation', dashboardId: 'dash_big', widgetIds: ['widget_page'], presentation, ownerRequested: true }),
      },
    }, { callerKind: 'interactive', currentUserMessage: 'use simpler wording and explain each metric', ownerRequestId: 'request-wording-1' });
    expect(result.isError).toBe(false);
    expect(editDataRoomWidget).toHaveBeenCalledWith({ action: 'presentation', dashboardId: 'dash_big', widgetIds: ['widget_page'], presentation });
    expect(JSON.parse(result.content)).toMatchObject({ status: 'completed', mutationApplied: true, resultDisposition: 'preserved', widget: { id: 'widget_page', revision: 4 } });
  });
});
