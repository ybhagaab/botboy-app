import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createStorage, type StorageLayer } from './storage.js';
import { createNodeManager } from './node-manager.js';
import {
  createToolExecutor,
  DATA_ROOM_CREATE_TIMEOUT_MS,
  WIDGET_SOURCE_FOREGROUND_WAIT_MS,
  WIDGET_SOURCE_TIMEOUT_MS,
} from './tool-executor.js';
import { ANALYTICS_JOB_MAX_FOREGROUND_WAIT_MS } from './analytics-job-service.js';

/**
 * Invariant: a Data Room composite's executor budget exceeds its own bounded
 * foreground wait, so long-running durable work returns its exact receipt
 * instead of an unknown-effect timeout.
 */
describe('Data Room composite foreground budgets', () => {
  let storage: StorageLayer;

  beforeEach(() => {
    vi.useFakeTimers();
    storage = createStorage(':memory:');
    storage.initialize();
  });

  afterEach(() => {
    vi.useRealTimers();
    storage.close();
  });

  // REGRESSION (live ETL canary 2026-09-27): a checkpointed Datanet run was
  // queued for minutes. The job service answers with an in-progress receipt
  // after its bounded wait, but the 10s default tool budget fired first and
  // reported an unknown effect with no job ID.
  it('create_data_room_dataset outlasts the job wait and returns the exact waiting receipt', async () => {
    const receipt = {
      status: 'waiting_external',
      jobId: `aj_${'a'.repeat(32)}`,
      responseGuidance: { claim: 'not_complete', requiredAnchors: [], nextAction: 'Observe the job.' },
    };
    const prepareOrJoinAndWait = vi.fn(() => new Promise(resolve => {
      setTimeout(() => resolve(receipt), ANALYTICS_JOB_MAX_FOREGROUND_WAIT_MS);
    }));
    const executor = createToolExecutor(storage.getDb(), createNodeManager(storage.getDb()), {
      analyticsJobService: { prepareOrJoinAndWait } as any,
    });
    const plan = {
      version: 1, mode: 'dataset_preparation', request: {}, sources: [{ kind: 'etl_query', alias: 'canary' }],
      fragments: [], terminal: { kind: 'source', alias: 'canary' },
    };

    const pending = executor.executeTool({
      id: 'create-1',
      type: 'function',
      function: { name: 'create_data_room_dataset', arguments: JSON.stringify({ action: 'create', ownerRequested: true, plan }) },
    }, { currentUserMessage: 'Create the ETL canary dataset.', callerKind: 'interactive', ownerRequestId: 'request-canary-1' });
    await vi.advanceTimersByTimeAsync(ANALYTICS_JOB_MAX_FOREGROUND_WAIT_MS + 1);
    const result = await pending;

    expect(DATA_ROOM_CREATE_TIMEOUT_MS).toBeGreaterThan(ANALYTICS_JOB_MAX_FOREGROUND_WAIT_MS);
    expect(prepareOrJoinAndWait).toHaveBeenCalledTimes(1);
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.content)).toMatchObject({ status: 'waiting_external', jobId: receipt.jobId });
  });

  // Same defect class: the committed source change waits up to 30s for its
  // selective run, which the 10s default budget cut off as an unknown effect.
  it('configure_analytics_widget_source outlasts its run wait and reports the committed pending run', async () => {
    const widget = { id: 'widget_exact', revision: 4, config: { dataSource: { kind: 'warehouse_sql' } } };
    const configureWidgetSource = vi.fn(() => ({
      run: { id: 'run_slow', status: 'queued' },
      widget,
      sourceConfigSha256: '5'.repeat(64),
    }));
    const getRun = vi.fn(() => ({ id: 'run_slow', status: 'running' }));
    const runDueNow = vi.fn(async () => 1);
    const executor = createToolExecutor(storage.getDb(), createNodeManager(storage.getDb()), {
      analyticsService: {
        configureWidgetSource,
        getRun,
        getDashboard: () => ({ id: 'dash_exact', title: 'Exact dashboard', widgets: [widget] }),
      } as any,
      analyticsScheduler: { runDueNow } as any,
    });

    const pending = executor.executeTool({
      id: 'source-1',
      type: 'function',
      function: {
        name: 'configure_analytics_widget_source',
        arguments: JSON.stringify({
          dashboardId: 'dash_exact', widgetId: 'widget_exact', expectedWidgetRevision: 3,
          source: { kind: 'warehouse_sql', sql: 'SELECT 1' }, ownerRequested: true,
        }),
      },
    }, { currentUserMessage: 'Change the source of widget_exact on dash_exact to this warehouse SQL.', callerKind: 'interactive', ownerRequestId: 'request-source-1' });
    await vi.advanceTimersByTimeAsync(WIDGET_SOURCE_FOREGROUND_WAIT_MS + 1_000);
    const result = await pending;

    expect(WIDGET_SOURCE_TIMEOUT_MS).toBeGreaterThan(WIDGET_SOURCE_FOREGROUND_WAIT_MS);
    expect(configureWidgetSource).toHaveBeenCalledTimes(1);
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.content)).toMatchObject({
      status: 'pending',
      mutationApplied: true,
      run: { id: 'run_slow', status: 'running' },
      responseGuidance: { claim: 'still_running' },
    });
  });
});
