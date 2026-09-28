import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createStorage, type StorageLayer } from './storage.js';
import { createNodeManager } from './node-manager.js';
import { createToolExecutor } from './tool-executor.js';

const args = {
  request: {
    domainKey: 'r2-test',
    metric: { id: 'daily_events', version: '1', definitionSha256: '1'.repeat(64), unit: 'events' },
    dimensions: ['event_date'],
    filters: [],
    dateRange: { start: '2026-09-01', end: '2026-09-02' },
    timeZone: 'UTC',
    countingKey: 'region',
    regime: { id: 'valid_events', version: '1', definitionSha256: '2'.repeat(64) },
    requiredGrain: 'day',
    freshness: { mode: 'allow_stale' },
  },
  metricValueColumn: 'metric_value',
  warehouseSql: 'SELECT event_date, 10 AS metric_value FROM events',
};

describe('tool executor answer_analytics boundary', () => {
  let storage: StorageLayer;

  beforeEach(() => {
    storage = createStorage(':memory:');
    storage.initialize();
  });

  afterEach(() => storage.close());

  it('delegates exactly once with authoritative owner context and carries the abort signal', async () => {
    const answer = vi.fn(async () => ({
      status: 'answered',
      decision: { kind: 'ready_materialized', reason: 'exact_materialized_candidate', candidates: [] },
      answer: {
        result: { columns: ['event_date', 'metric_value'], rows: [['2026-09-01', 10]], rowCount: 1, displayedRowCount: 1, truncated: false },
        receipt: { requestSha256: '3'.repeat(64), limitations: [] },
      },
      execution: { catalogCandidates: 1, integrityChecks: 2, laneProbes: 0, remoteExecutions: 0, localQueries: 1 },
    }));
    const executor = createToolExecutor(storage.getDb(), createNodeManager(storage.getDb()), {
      analyticsAnswerService: { answer } as any,
    });
    const controller = new AbortController();
    const result = await executor.executeTool({
      id: 'answer-1', type: 'function', function: { name: 'answer_analytics', arguments: JSON.stringify(args) },
    }, {
      currentUserMessage: 'How many daily events?',
      callerKind: 'interactive',
      abortSignal: controller.signal,
    });
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.content)).toMatchObject({
      trust: 'verified_local_or_governed_remote_data',
      status: 'answered',
      execution: { laneProbes: 0, remoteExecutions: 0, localQueries: 1 },
    });
    expect(answer).toHaveBeenCalledTimes(1);
    expect(answer.mock.calls[0][0]).toEqual(args);
    expect(answer.mock.calls[0][1].signal).toBe(controller.signal);
  });

  it('refuses background or owner-context-free calls before invoking the service', async () => {
    const answer = vi.fn();
    const executor = createToolExecutor(storage.getDb(), createNodeManager(storage.getDb()), {
      analyticsAnswerService: { answer } as any,
    });
    const result = await executor.executeTool({
      id: 'answer-2', type: 'function', function: { name: 'answer_analytics', arguments: JSON.stringify(args) },
    }, { callerKind: 'background' });
    expect(result.isError).toBe(true);
    expect(result.content).toContain('exact current interactive owner question');
    expect(answer).not.toHaveBeenCalled();
  });
});


describe('tool executor edit_analytics_dashboard boundary', () => {
  let storage: StorageLayer;

  beforeEach(() => {
    storage = createStorage(':memory:');
    storage.initialize();
  });

  afterEach(() => storage.close());

  const widget = {
    id: 'widget_exact', dashboardId: 'dash_exact', revision: 2, bindingRevision: 1,
    position: 0, kind: 'visualization', title: 'Area trend', subtitle: '', sql: 'SELECT 1',
    config: {}, createdAt: '2026-09-21T00:00:00.000Z', updatedAt: '2026-09-21T00:00:01.000Z',
    result: {
      trust: 'local_verified_data', columns: ['value'], rows: [[1]], rowCount: 1,
      displayedRowCount: 1, refreshedAt: '2026-09-21T00:00:00.000Z',
      source: {
        provider: 'data-room', datasetId: 'ds_exact', versionId: 'dsv_aaaaaaaaaaaaaaaaaaaaaaaa',
        bindingRevision: 1, widgetRevision: 2, querySha256: '1'.repeat(64),
        compilerVersion: 'v1', contentSha256: '2'.repeat(64), schemaSha256: '3'.repeat(64),
        contractSha256: '4'.repeat(64), definitionSha256: '5'.repeat(64), semanticReceipt: {},
      },
    },
  } as any;

  it('delegates once and returns an immediate preserved-result receipt', async () => {
    const editDataRoomWidget = vi.fn(() => ({
      action: 'presentation', dashboardId: 'dash_exact', sourceWidgetIds: ['widget_exact'],
      widget, resultDisposition: 'preserved',
    }));
    const runDueNow = vi.fn();
    const executor = createToolExecutor(storage.getDb(), createNodeManager(storage.getDb()), {
      analyticsService: {
        editDataRoomWidget,
        getDashboard: () => ({ id: 'dash_exact', title: 'Exact dashboard', widgets: [widget] }),
      } as any,
      analyticsScheduler: { runDueNow } as any,
    });
    const result = await executor.executeTool({
      id: 'edit-1', type: 'function', function: {
        name: 'edit_analytics_dashboard',
        arguments: JSON.stringify({
          action: 'presentation', dashboardId: 'dash_exact', widgetIds: ['widget_exact'],
          presentation: { renderer: 'area' }, ownerRequested: true,
        }),
      },
    }, {
      currentUserMessage: 'Change widget_exact on dash_exact to an area view.',
      callerKind: 'interactive',
      ownerRequestId: 'request-edit-1',
    });
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.content)).toMatchObject({
      requestId: 'request-edit-1',
      status: 'completed', mutationApplied: true, dataReady: true,
      resultDisposition: 'preserved', widget: { id: 'widget_exact', revision: 2 },
      responseGuidance: { claim: 'completed' },
    });
    expect(editDataRoomWidget).toHaveBeenCalledTimes(1);
    expect(editDataRoomWidget).toHaveBeenCalledWith({
      action: 'presentation', dashboardId: 'dash_exact', widgetIds: ['widget_exact'],
      presentation: { renderer: 'area' },
    });
    expect(runDueNow).not.toHaveBeenCalled();
  });

  it('wakes the existing scheduler and observes the exact queued run', async () => {
    const queued = {
      id: 'run_exact', dashboardId: 'dash_exact', trigger: 'agent', status: 'queued',
      refreshScope: 'selective', widgetCount: 1, widgetsCompleted: 0, widgetsSucceeded: 0,
      cancelRequested: false, queuedAt: '2026-09-21T00:00:00.000Z',
    };
    const completed = { ...queued, status: 'completed', widgetsCompleted: 1, widgetsSucceeded: 1 };
    const editDataRoomWidget = vi.fn(() => ({
      action: 'date_range', dashboardId: 'dash_exact', sourceWidgetIds: ['widget_exact'],
      widget, resultDisposition: 'refresh_queued', run: queued,
    }));
    const getRun = vi.fn(() => completed);
    const runDueNow = vi.fn(async () => 1);
    const executor = createToolExecutor(storage.getDb(), createNodeManager(storage.getDb()), {
      analyticsService: {
        editDataRoomWidget, getRun,
        getDashboard: () => ({ id: 'dash_exact', title: 'Exact dashboard', widgets: [widget] }),
      } as any,
      analyticsScheduler: { runDueNow } as any,
    });
    const result = await executor.executeTool({
      id: 'edit-2', type: 'function', function: {
        name: 'edit_analytics_dashboard',
        arguments: JSON.stringify({
          action: 'date_range', dashboardId: 'dash_exact', widgetIds: ['widget_exact'],
          dateRange: { start: '2026-09-02', end: '2026-09-02' }, ownerRequested: true,
        }),
      },
    }, {
      currentUserMessage: 'Change widget_exact on dash_exact to 2026-09-02.',
      callerKind: 'interactive',
      ownerRequestId: 'request-edit-2',
    });
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.content)).toMatchObject({
      requestId: 'request-edit-2',
      status: 'completed', mutationApplied: true, resultDisposition: 'refresh_queued',
      run: { id: 'run_exact', status: 'completed' },
    });
    expect(runDueNow).toHaveBeenCalled();
    expect(getRun).toHaveBeenCalledWith('run_exact');
  });

  it.each([
    ['missing owner attestation', false, 'Change widget_exact on dash_exact.', 'interactive'],
    ['background caller', true, 'Change widget_exact on dash_exact.', 'background'],
  ])('refuses %s before service invocation', async (_label, ownerRequested, message, callerKind) => {
    const editDataRoomWidget = vi.fn();
    const executor = createToolExecutor(storage.getDb(), createNodeManager(storage.getDb()), {
      analyticsService: { editDataRoomWidget } as any,
    });
    const result = await executor.executeTool({
      id: 'edit-denied', type: 'function', function: {
        name: 'edit_analytics_dashboard',
        arguments: JSON.stringify({
          action: 'presentation', dashboardId: 'dash_exact', widgetIds: ['widget_exact'],
          presentation: { title: 'No' }, ownerRequested,
        }),
      },
    }, { currentUserMessage: message, callerKind: callerKind as any });
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content).mutationApplied).toBe(false);
    expect(editDataRoomWidget).not.toHaveBeenCalled();
  });
});


describe('tool executor route-derived analytics edit scope', () => {
  let storage: StorageLayer;

  beforeEach(() => {
    storage = createStorage(':memory:');
    storage.initialize();
  });

  afterEach(() => storage.close());

  const scopedWidget = {
    id: 'widget_selected', dashboardId: 'dash_selected', revision: 4, bindingRevision: 2,
    position: 0, kind: 'visualization', title: 'Selected trend', subtitle: '', sql: 'SELECT 1',
    config: {}, createdAt: '2026-09-21T00:00:00.000Z', updatedAt: '2026-09-21T00:00:01.000Z',
    result: { trust: 'local_verified_data', columns: ['value'], rows: [[1]], rowCount: 1, displayedRowCount: 1, refreshedAt: '2026-09-21T00:00:00.000Z' },
  } as any;

  function createScopedExecutor(editDataRoomWidget: ReturnType<typeof vi.fn>) {
    return createToolExecutor(storage.getDb(), createNodeManager(storage.getDb()), {
      analyticsService: {
        editDataRoomWidget,
        getDashboard: () => ({ id: 'dash_selected', title: 'Selected dashboard', widgets: [scopedWidget] }),
      } as any,
    });
  }

  it('accepts an edit of the selected widget', async () => {
    const editDataRoomWidget = vi.fn(() => ({
      action: 'presentation', dashboardId: 'dash_selected', sourceWidgetIds: ['widget_selected'],
      widget: scopedWidget, resultDisposition: 'preserved',
    }));
    const executor = createScopedExecutor(editDataRoomWidget);
    const result = await executor.executeTool({
      id: 'edit-route-1', type: 'function', function: {
        name: 'edit_analytics_dashboard',
        arguments: JSON.stringify({
          action: 'presentation', dashboardId: 'dash_selected', widgetIds: ['widget_selected'],
          presentation: { renderer: 'area' }, ownerRequested: true,
        }),
      },
    }, {
      currentUserMessage: 'Can you please change this selected widget to an area visualization?',
      callerKind: 'interactive',
      ownerRequestId: 'request-route-1',
      authoritativeAnalyticsScope: {
        dashboardId: 'dash_selected', orderedWidgetIds: ['widget_selected'], source: 'dashboard_widget_selection',
      },
    });
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.content)).toMatchObject({
      requestId: 'request-route-1',
      status: 'completed',
      action: 'presentation',
      dashboard: { id: 'dash_selected' },
      sourceWidgetIds: ['widget_selected'],
    });
    expect(editDataRoomWidget).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['one widget for combine', 'combine_compatible_widgets', ['widget_selected'], 'interactive', 'invalid_widget_count'],
    ['two widgets for a presentation edit', 'presentation', ['widget_selected', 'widget_other'], 'interactive', 'invalid_widget_count'],
    ['background caller', 'presentation', ['widget_selected'], 'background', 'owner_context_required'],
  ])('blocks %s before the service', async (_label, action, widgetIds, callerKind, expectedCode) => {
    const editDataRoomWidget = vi.fn();
    const executor = createScopedExecutor(editDataRoomWidget);
    const result = await executor.executeTool({
      id: 'edit-route-denied', type: 'function', function: {
        name: 'edit_analytics_dashboard',
        arguments: JSON.stringify({
          action, dashboardId: 'dash_selected', widgetIds,
          presentation: action === 'combine_compatible_widgets' ? { layout: 'vconcat' } : { renderer: 'area' },
          ownerRequested: true,
        }),
      },
    }, {
      currentUserMessage: 'Please make that change.',
      callerKind: callerKind as any,
      ownerRequestId: 'request-route-denied',
    });
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content)).toMatchObject({
      requestId: 'request-route-denied', mutationApplied: false, code: expectedCode,
    });
    expect(editDataRoomWidget).not.toHaveBeenCalled();
  });
});


// Owner-directed 2026-09-28: no exact ID or keyword matching on owner input.
// Authority is the live owner turn + ownerRequested; the model resolves the
// target and the service validates it.
describe('tool executor analytics edit natural-language targets', () => {
  let storage: StorageLayer;

  beforeEach(() => {
    storage = createStorage(':memory:');
    storage.initialize();
  });

  afterEach(() => storage.close());

  it.each([
    ['a title, no IDs or selection', 'Make the core funnel trend an area chart.', undefined],
    ['a loose confirmation', 'yes please do that for all of them', undefined],
    ['an ID-bearing sentence the old wording rule rejected', 'Connect widget_selected on dash_selected to the Fatafat MXP Ingress Daily Flash Data Room dataset view as an area chart.', undefined],
    ['a selection that differs from the target', 'Change the other chart to an area view.', ['widget_other']],
  ])('delegates %s to the service', async (_label, message, selected) => {
    const editDataRoomWidget = vi.fn(() => ({
      action: 'presentation', dashboardId: 'dash_selected', sourceWidgetIds: ['widget_selected'],
      widget: { id: 'widget_selected', title: 'Trend', revision: 5, bindingRevision: 2 }, resultDisposition: 'preserved',
    }));
    const executor = createToolExecutor(storage.getDb(), createNodeManager(storage.getDb()), {
      analyticsService: {
        editDataRoomWidget,
        getDashboard: () => ({ id: 'dash_selected', title: 'Selected dashboard', widgets: [] }),
      } as any,
    });
    const result = await executor.executeTool({
      id: 'edit-natural', type: 'function', function: {
        name: 'edit_analytics_dashboard',
        arguments: JSON.stringify({
          action: 'presentation', dashboardId: 'dash_selected', widgetIds: ['widget_selected'],
          presentation: { renderer: 'area' }, ownerRequested: true,
        }),
      },
    }, {
      currentUserMessage: message,
      callerKind: 'interactive',
      ownerRequestId: 'request-natural-1',
      ...(selected ? {
        authoritativeAnalyticsScope: { dashboardId: 'dash_selected', orderedWidgetIds: selected, source: 'dashboard_widget_selection' as const },
      } : {}),
    });
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.content)).toMatchObject({ status: 'completed', mutationApplied: true });
    expect(editDataRoomWidget).toHaveBeenCalledTimes(1);
  });
});


describe('tool executor durable analytics edit identity', () => {
  let storage: StorageLayer;

  beforeEach(() => {
    storage = createStorage(':memory:');
    storage.initialize();
  });

  afterEach(() => storage.close());

  const createdWidget = {
    id: 'widget_created_f2', dashboardId: 'dash_selected', revision: 1, bindingRevision: 1,
    position: 2, kind: 'visualization', title: 'Another point view', subtitle: '', sql: 'SELECT 1', config: {},
    createdAt: '2026-09-21T00:00:00.000Z', updatedAt: '2026-09-21T00:00:00.000Z',
  } as any;
  const completedRun = {
    id: 'run_created_f2', dashboardId: 'dash_selected', trigger: 'agent', status: 'completed',
    refreshScope: 'selective', widgetCount: 1, widgetsCompleted: 1, widgetsSucceeded: 1,
    cancelRequested: false, queuedAt: '2026-09-21T00:00:00.000Z', completedAt: '2026-09-21T00:00:01.000Z',
  } as any;
  const durableEditHarness = (explicitNew: boolean) => {
    const editDataRoomWidget = vi.fn(() => ({
      action: 'add_from_widget', dashboardId: 'dash_selected', sourceWidgetIds: ['widget_selected'],
      widget: createdWidget, createdWidgetId: createdWidget.id, resultDisposition: 'refresh_queued', run: completedRun,
      receiptId: 'aedit_aaaaaaaaaaaaaaaa', intentVersion: 1, intentSha256: '1'.repeat(64),
      effectSha256: '2'.repeat(64), explicitNew, idempotentReplay: false, effectAppliedThisCall: true,
    }));
    const runDueNow = vi.fn();
    const executor = createToolExecutor(storage.getDb(), createNodeManager(storage.getDb()), {
      analyticsService: {
        editDataRoomWidget,
        getDashboard: () => ({ id: 'dash_selected', title: 'Selected dashboard', widgets: [createdWidget] }),
      } as any,
      analyticsScheduler: { runDueNow } as any,
    });
    const call = (args: Record<string, unknown>) => ({
      id: 'edit-durable-f2', type: 'function' as const, function: {
        name: 'edit_analytics_dashboard',
        arguments: JSON.stringify({
          action: 'add_from_widget', dashboardId: 'dash_selected', widgetIds: ['widget_selected'],
          presentation: { renderer: 'point', title: 'Another point view' }, ownerRequested: true,
          ...args,
        }),
      },
    });
    return { editDataRoomWidget, runDueNow, executor, call };
  };

  it('takes explicit-new from the createNew argument and records selection provenance', async () => {
    const { editDataRoomWidget, runDueNow, executor, call } = durableEditHarness(true);
    const result = await executor.executeTool(call({ createNew: true }), {
      currentUserMessage: 'Create another new point chart from this selected widget.',
      callerKind: 'interactive', ownerRequestId: 'request-executor-f2-0001',
      authoritativeAnalyticsScope: {
        dashboardId: 'dash_selected', orderedWidgetIds: ['widget_selected'], source: 'dashboard_widget_selection',
      },
    });
    expect(editDataRoomWidget).toHaveBeenCalledWith({
      action: 'add_from_widget', dashboardId: 'dash_selected', widgetIds: ['widget_selected'],
      presentation: { renderer: 'point', title: 'Another point view' },
    }, {
      ownerRequestId: 'request-executor-f2-0001',
      ownerMessage: 'Create another new point chart from this selected widget.',
      ownerScope: {
        source: 'dashboard_widget_selection', dashboardId: 'dash_selected', orderedWidgetIds: ['widget_selected'],
      },
      explicitNew: true,
    });
    expect(JSON.parse(result.content)).toMatchObject({
      requestId: 'request-executor-f2-0001', receiptId: 'aedit_aaaaaaaaaaaaaaaa',
      explicitNew: true, idempotentReplay: false, effectAppliedThisCall: true,
      responseGuidance: { requiredAnchors: expect.arrayContaining(['aedit_aaaaaaaaaaaaaaaa']) },
    });
    expect(runDueNow).not.toHaveBeenCalled();
  });

  it('ignores owner wording for explicit-new and records model-resolved targets', async () => {
    const { editDataRoomWidget, executor, call } = durableEditHarness(false);
    const result = await executor.executeTool(call({}), {
      // "another new" in the wording no longer implies a duplicate; only createNew does.
      currentUserMessage: 'Create another new point chart from the funnel trend.',
      callerKind: 'interactive', ownerRequestId: 'request-executor-f2-0002',
    });
    expect(result.isError).toBe(false);
    expect(editDataRoomWidget).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      ownerScope: { source: 'model_resolved', dashboardId: 'dash_selected', orderedWidgetIds: ['widget_selected'] },
      explicitNew: false,
    }));
  });

  it('labels literal owner-typed IDs as owner_exact_ids provenance only', async () => {
    const { editDataRoomWidget, executor, call } = durableEditHarness(false);
    await executor.executeTool(call({}), {
      currentUserMessage: 'Copy widget_selected on dash_selected as a point chart.',
      callerKind: 'interactive', ownerRequestId: 'request-executor-f2-0003',
      // The ambient selection points elsewhere; typed IDs are the better provenance.
      authoritativeAnalyticsScope: {
        dashboardId: 'dash_selected', orderedWidgetIds: ['widget_other'], source: 'dashboard_widget_selection',
      },
    });
    expect(editDataRoomWidget).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      ownerScope: { source: 'owner_exact_ids', dashboardId: 'dash_selected', orderedWidgetIds: ['widget_selected'] },
    }));
  });

  it('requires a server request ID for add/combine before service invocation', async () => {
    const editDataRoomWidget = vi.fn();
    const executor = createToolExecutor(storage.getDb(), createNodeManager(storage.getDb()), {
      analyticsService: { editDataRoomWidget } as any,
    });
    const result = await executor.executeTool({
      id: 'edit-durable-no-id', type: 'function', function: {
        name: 'edit_analytics_dashboard',
        arguments: JSON.stringify({
          action: 'add_from_widget', dashboardId: 'dash_selected', widgetIds: ['widget_selected'],
          presentation: { title: 'Copy' }, ownerRequested: true,
        }),
      },
    }, {
      currentUserMessage: 'Create a new chart from this selected widget.', callerKind: 'interactive',
      authoritativeAnalyticsScope: {
        dashboardId: 'dash_selected', orderedWidgetIds: ['widget_selected'], source: 'dashboard_widget_selection',
      },
    });
    expect(JSON.parse(result.content)).toMatchObject({ code: 'owner_request_id_required', mutationApplied: false });
    expect(editDataRoomWidget).not.toHaveBeenCalled();
  });
});