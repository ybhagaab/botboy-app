import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createStorage, type StorageLayer } from './storage.js';
import { createNodeManager } from './node-manager.js';
import { AnalyticsWidgetEditError } from './analytics-dashboard.js';
import {
  createToolExecutor,
  DASHBOARD_LOCAL_RUN_WAIT_MS,
  DASHBOARD_WRITE_TIMEOUT_MS,
} from './tool-executor.js';

/**
 * Owner directive 2026-09-28: dashboards read Data Room datasets directly in
 * one create/update call, and no dashboard tool gates on owner wording or
 * owner-typed IDs. Authority = live owner turn + ownerRequested; the service
 * validates exact targets.
 */

const ROOM_SOURCE = {
  version: 1, kind: 'data_room_query', datasetId: 'ds_fatafat', versionId: `dsv_${'a'.repeat(24)}`,
  sql: 'SELECT day, SUM(orders) AS orders FROM source.data GROUP BY day', params: [], limit: 100,
};

function dashboardFixture(runStatus: string) {
  const loaded = runStatus === 'completed';
  return {
    id: 'dash_new', title: 'Canary', description: '', status: 'draft',
    recentRuns: [{ id: 'run_local', status: runStatus, refreshScope: 'selective' }],
    widgets: [
      {
        id: 'widget_room_ok', revision: 1, title: 'Daily orders', kind: 'line', config: { dataSource: ROOM_SOURCE },
        ...(loaded ? { result: { rowCount: 3, rows: [], columns: [] } } : {}),
      },
      {
        id: 'widget_room_bad', revision: 1, title: 'Broken', kind: 'table', config: { dataSource: ROOM_SOURCE },
        ...(loaded ? { lastError: 'no such column: ordres' } : {}),
      },
      { id: 'widget_wh', revision: 1, title: 'Warehouse', kind: 'metric', sql: 'SELECT 1', config: {} },
      { id: 'widget_text', revision: 1, title: 'Notes', kind: 'text', config: { text: 'Read me' } },
    ],
  };
}

const createCall = (args: Record<string, unknown>) => ({
  id: 'create-dash', type: 'function' as const,
  function: { name: 'create_analytics_dashboard', arguments: JSON.stringify(args) },
});

const OWNER_TURN = {
  currentUserMessage: 'Build me a small Fatafat dashboard from the Data Room.',
  callerKind: 'interactive' as const,
  ownerRequestId: 'request-dash-writes-1',
};

describe('create/update analytics dashboard with Data Room sources', () => {
  let storage: StorageLayer;

  beforeEach(() => {
    storage = createStorage(':memory:');
    storage.initialize();
  });

  afterEach(() => {
    vi.useRealTimers();
    storage.close();
  });

  it('waits for the local run and reports each widget state in one receipt', async () => {
    let runStatus = 'queued';
    const createDashboard = vi.fn(() => dashboardFixture(runStatus));
    const runDueNow = vi.fn(async () => { runStatus = 'completed'; return 1; });
    const executor = createToolExecutor(storage.getDb(), createNodeManager(storage.getDb()), {
      analyticsService: {
        createDashboard,
        getDashboard: () => dashboardFixture(runStatus),
        getRun: () => ({ id: 'run_local', status: runStatus, refreshScope: 'selective' }),
      } as any,
      analyticsScheduler: { runDueNow } as any,
    });
    const widgets = [{ kind: 'line', title: 'Daily orders', source: { kind: 'data_room_query', datasetId: 'ds_fatafat', sql: ROOM_SOURCE.sql } }];

    const result = await executor.executeTool(createCall({ title: 'Canary', widgets, ownerRequested: true }), OWNER_TURN);

    expect(createDashboard).toHaveBeenCalledWith(expect.objectContaining({ title: 'Canary', widgets }), undefined);
    expect(runDueNow).toHaveBeenCalled();
    expect(result.isError).toBe(false);
    const receipt = JSON.parse(result.content);
    expect(receipt).toMatchObject({
      ok: true,
      message: 'Dashboard created. 1 of 2 Data Room widgets loaded; 1 failed (see widgets[].error). 1 warehouse widget(s) wait for a refresh.',
      localRun: { id: 'run_local', status: 'completed' },
      localUrl: '#/dashboards/dash_new',
      dashboard: { id: 'dash_new', widgetCount: 4 },
    });
    expect(receipt.widgets).toEqual([
      expect.objectContaining({ widgetId: 'widget_room_ok', source: 'data_room', datasetId: 'ds_fatafat', state: 'loaded', rowCount: 3 }),
      expect.objectContaining({ widgetId: 'widget_room_bad', revision: 1, source: 'data_room', state: 'failed', error: 'no such column: ordres' }),
      expect.objectContaining({ widgetId: 'widget_wh', source: 'warehouse', state: 'awaiting_refresh' }),
      expect.objectContaining({ widgetId: 'widget_text', source: 'text', state: 'static' }),
    ]);
    expect(receipt.responseGuidance.nextAction).toMatch(/configure_analytics_widget_source/);
  });

  it('returns the committed loading run instead of timing out when the local run outlasts its wait', async () => {
    vi.useFakeTimers();
    const executor = createToolExecutor(storage.getDb(), createNodeManager(storage.getDb()), {
      analyticsService: {
        createDashboard: () => dashboardFixture('queued'),
        getDashboard: () => dashboardFixture('running'),
        getRun: () => ({ id: 'run_local', status: 'running', refreshScope: 'selective' }),
      } as any,
      analyticsScheduler: { runDueNow: vi.fn(async () => 0) } as any,
    });

    const pending = executor.executeTool(createCall({ title: 'Canary', widgets: [], ownerRequested: true }), OWNER_TURN);
    await vi.advanceTimersByTimeAsync(DASHBOARD_LOCAL_RUN_WAIT_MS + 1_000);
    const result = await pending;

    expect(DASHBOARD_WRITE_TIMEOUT_MS).toBeGreaterThan(DASHBOARD_LOCAL_RUN_WAIT_MS);
    expect(result.isError).toBe(false);
    const receipt = JSON.parse(result.content);
    expect(receipt.message).toContain('2 still loading in run run_local');
    expect(receipt.widgets[0]).toMatchObject({ widgetId: 'widget_room_ok', state: 'loading' });
    expect(receipt.responseGuidance.nextAction).toMatch(/^Do not recreate or resubmit; run run_local continues/);
  });

  it('reports a validated create failure as zero-effect with its issue path and next action', async () => {
    const getDashboard = vi.fn();
    const createDashboard = vi.fn(() => {
      throw Object.assign(new AnalyticsWidgetEditError(
        'not_found',
        'Widget 2 "Daily": Dataset ds_missing has no exact ready catalog version',
        'Refresh list_data_room_datasets and choose one exact ready dataset.',
      ), {
        issues: [{ code: 'dataset_not_ready', path: 'widgets[1].source.datasetId', message: 'Not ready.' }],
        mutationApplied: false,
      });
    });
    const executor = createToolExecutor(storage.getDb(), createNodeManager(storage.getDb()), {
      analyticsService: { createDashboard, getDashboard } as any,
    });

    const result = await executor.executeTool(createCall({ title: 'Canary', widgets: [], ownerRequested: true }), OWNER_TURN);

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content)).toEqual({
      ok: false,
      code: 'not_found',
      error: 'Widget 2 "Daily": Dataset ds_missing has no exact ready catalog version',
      mutationApplied: false,
      nextAction: 'No dashboard was created. Refresh list_data_room_datasets and choose one exact ready dataset.',
      issues: [{ code: 'dataset_not_ready', path: 'widgets[1].source.datasetId', message: 'Not ready.' }],
    });
    expect(getDashboard).not.toHaveBeenCalled();
  });

  it('reports a plain update rejection as no change with a correction next action', async () => {
    const updateDashboard = vi.fn(() => {
      throw new Error('Widget 1 config.dataSource is server-owned; give the widget\'s data source as widget.source instead');
    });
    const executor = createToolExecutor(storage.getDb(), createNodeManager(storage.getDb()), {
      analyticsService: { updateDashboard } as any,
    });

    const result = await executor.executeTool({
      id: 'update-dash', type: 'function',
      function: { name: 'update_analytics_dashboard', arguments: JSON.stringify({ dashboardId: 'dash_new', widgets: [], ownerRequested: true }) },
    }, OWNER_TURN);

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content)).toMatchObject({
      ok: false,
      mutationApplied: false,
      error: expect.stringContaining('widget.source'),
      nextAction: 'The dashboard was not changed. Correct the reported widget and call again once.',
    });
  });

  it('requires the ownerRequested attestation before any service call', async () => {
    const createDashboard = vi.fn();
    const executor = createToolExecutor(storage.getDb(), createNodeManager(storage.getDb()), {
      analyticsService: { createDashboard } as any,
    });

    const result = await executor.executeTool(createCall({ title: 'Canary', widgets: [] }), OWNER_TURN);

    expect(result.content).toMatch(/ownerRequested must be true/);
    expect(createDashboard).not.toHaveBeenCalled();
  });
});

describe('configure_analytics_widget_source authority', () => {
  let storage: StorageLayer;

  beforeEach(() => {
    storage = createStorage(':memory:');
    storage.initialize();
  });

  afterEach(() => storage.close());

  const configureArgs = (overrides: Record<string, unknown> = {}) => ({
    id: 'configure-source', type: 'function' as const,
    function: {
      name: 'configure_analytics_widget_source',
      arguments: JSON.stringify({
        dashboardId: 'dash_new', widgetId: 'widget_room_bad', expectedWidgetRevision: 1,
        source: { kind: 'data_room_query', datasetId: 'ds_fatafat', sql: ROOM_SOURCE.sql },
        ownerRequested: true,
        ...overrides,
      }),
    },
  });

  function harness() {
    const widget = { id: 'widget_room_bad', revision: 2, config: { dataSource: ROOM_SOURCE }, result: { rowCount: 3 } };
    const configureWidgetSource = vi.fn(() => ({
      run: { id: 'run_cfg', status: 'completed' }, widget, sourceConfigSha256: '6'.repeat(64),
    }));
    const executor = createToolExecutor(storage.getDb(), createNodeManager(storage.getDb()), {
      analyticsService: {
        configureWidgetSource,
        getRun: () => ({ id: 'run_cfg', status: 'completed' }),
        getDashboard: () => ({ id: 'dash_new', title: 'Canary', widgets: [widget] }),
      } as any,
    });
    return { executor, configureWidgetSource };
  }

  it.each([
    ['no IDs or special wording', 'Fix the broken table so it shows daily orders.'],
    ['a loose confirmation', 'yes go ahead'],
  ])('delegates a live owner turn with %s to the service', async (_label, message) => {
    const { executor, configureWidgetSource } = harness();

    const result = await executor.executeTool(configureArgs(), { ...OWNER_TURN, currentUserMessage: message });

    expect(result.isError).toBe(false);
    expect(JSON.parse(result.content)).toMatchObject({ status: 'completed', mutationApplied: true, widgetRevision: 2 });
    expect(configureWidgetSource).toHaveBeenCalledWith('dash_new', 'widget_room_bad', {
      expectedWidgetRevision: 1,
      source: { kind: 'data_room_query', datasetId: 'ds_fatafat', sql: ROOM_SOURCE.sql },
    });
  });

  it.each([
    ['a background caller', {}, { currentUserMessage: 'Fix it.', callerKind: 'background' as const }, 'owner_context_required'],
    ['no owner turn', {}, { callerKind: 'interactive' as const }, 'owner_context_required'],
    ['a missing attestation', { ownerRequested: false }, OWNER_TURN, 'owner_request_required'],
  ])('blocks %s with zero effect', async (_label, overrides, context, code) => {
    const { executor, configureWidgetSource } = harness();

    const result = await executor.executeTool(configureArgs(overrides), context);

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content)).toMatchObject({
      ok: false, code, effect: { mutationApplied: false }, nextAction: expect.any(String),
    });
    expect(configureWidgetSource).not.toHaveBeenCalled();
  });
});
