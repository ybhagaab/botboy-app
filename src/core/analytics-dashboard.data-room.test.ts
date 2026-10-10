import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createStorage, type StorageLayer } from './storage.js';
import { createAnalyticsDataRoomStore, analyticsDatasetContractSha256, analyticsDatasetSchemaSha256 } from './analytics-data-room-store.js';
import { createAnalyticsDataRoomBackupService } from './analytics-data-room-backup.js';
import { createAnalyticsDataRoomService } from './analytics-data-room-service.js';
import { createAnalyticsLocalQueryEngine } from './analytics-data-room-query.js';
import { createAnalyticsAnswerService } from './analytics-data-room-answer.js';
import { createAnalyticsDataRoomReadService } from './analytics-data-room-read.js';
import {
  AnalyticsDashboardDataRoomError,
  createAnalyticsDashboardDataRoomBridge,
} from './analytics-dashboard-data-room.js';
import { AnalyticsWidgetEditError, createAnalyticsDashboardService } from './analytics-dashboard.js';
import { analyticsRequestSha256 } from './analytics-data-room-policy.js';
import { createWorkspaceCatalogService } from './workspace-catalog.js';
import type {
  AnalyticsDataCell,
  AnalyticsDatasetContract,
  AnalyticsDatasetDefinitionInput,
} from './analytics-data-room-types.js';
import type { AnalyticsWidgetDataRoomBindingInput } from './analytics-types.js';
import type { McpManager, McpServerSnapshot } from './mcp-types.js';
import type { QueryRunner, QueryRunResult } from './etl-adhoc.js';

const NOW = new Date('2026-09-21T12:00:00.000Z');
const directories: string[] = [];
const storages: StorageLayer[] = [];

afterEach(() => {
  while (storages.length) storages.pop()?.close();
  while (directories.length) fs.rmSync(directories.pop()!, { recursive: true, force: true });
});

function tempDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'analytics-r4-'));
  directories.push(directory);
  return directory;
}

function withSha(contract: Omit<AnalyticsDatasetContract, 'contractSha256' | 'schemaSha256'>): AnalyticsDatasetContract {
  const value = { ...contract, schemaSha256: analyticsDatasetSchemaSha256(contract.schema), contractSha256: '' } as AnalyticsDatasetContract;
  return { ...value, contractSha256: analyticsDatasetContractSha256(value) };
}

function sourceDefinition(
  id = 'ds_r4_events',
  scope: 'dashboard_local' | 'project' | 'workspace' = 'workspace',
  allowPublication = false,
): AnalyticsDatasetDefinitionInput {
  const schema = [
    { name: 'event_date', logicalType: 'date' as const, nullable: false },
    { name: 'region', logicalType: 'string' as const, nullable: false },
    { name: 'events', logicalType: 'integer' as const, nullable: false },
  ];
  const contract = withSha({
    contractVersion: '1',
    status: 'active',
    datasetId: id,
    datasetKind: 'source',
    scope,
    domainKey: 'r4-test',
    schema,
    metric: { id: 'events', version: '1', definitionSha256: '1'.repeat(64), unit: 'events' },
    regime: { id: 'valid_events', version: '1', definitionSha256: '2'.repeat(64) },
    countingKey: 'region',
    unit: 'events',
    grain: 'day_region',
    availableDimensions: ['event_date', 'region'],
    timeField: 'event_date',
    timeZone: 'UTC',
    coverage: {
      partitionKind: 'day',
      completePartitions: ['2026-09-01', '2026-09-02'],
      watermark: '2026-09-02T23:59:59.000Z',
    },
    handling: {
      classification: 'internal',
      allowedUses: allowPublication ? ['local_answer', 'dashboard', 'publication'] : ['local_answer', 'dashboard'],
      allowModelContext: true,
      allowPublication,
    },
    relational: {
      version: 1,
      grainFields: ['event_date', 'region'],
      uniqueKeys: [['event_date', 'region']],
      measures: [{ field: 'events', unit: 'events', aggregation: 'sum', protected: true }],
    },
  });
  return {
    id,
    name: 'R4 events',
    kind: 'source',
    scope,
    domainKey: 'r4-test',
    ownerId: 'owner-r4',
    lifecycle: 'active',
    sourceKind: 'sql_context',
    sourceFormat: 'canonical_json',
    definition: {
      source: 'r4-fixture',
      answer: {
        version: 1,
        metricId: 'events',
        metricValueColumn: 'events',
        rowDimensions: ['event_date', 'region'],
        filterableFields: ['event_date', 'region'],
        stableOrder: [
          { field: 'event_date', direction: 'asc' },
          { field: 'region', direction: 'asc' },
        ],
      },
    },
    contract,
    retention: { minimumVersions: 1, automaticExpiry: false, reacquirable: true, backupRequired: false },
  };
}

function server(id: string, state: McpServerSnapshot['state'] = 'running'): McpServerSnapshot {
  const names = id === 'sql-context'
    ? ['connection_status', 'run_query']
    : [
        'datanet_search', 'datanet_create_profile', 'datanet_create_job',
        'datanet_get_latest_run', 'datanet_update_profile_sql', 'datanet_submit_run',
        'datanet_get_job_run_status', 'datanet_alter_run', 'datanet_get_job_run_error',
        'datanet_download_results',
      ];
  return {
    id,
    kind: 'managed',
    displayName: id,
    enabled: true,
    configured: true,
    state,
    packageVersion: '1.0.0',
    tools: names.map(name => ({ name, inputSchema: {}, risk: 'read' as const })),
    restartCount: 0,
    lastHealthyAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as McpServerSnapshot;
}

function fakeMcp(mode: 'none' | 'sql' | 'etl' = 'none') {
  const sqlCalls: string[] = [];
  let connectionProbes = 0;
  const servers = mode === 'sql'
    ? [server('sql-context')]
    : mode === 'etl'
      ? [server('sql-context', 'stopped'), server('a2-analytics')]
      : [];
  const manager = {
    listServers: async () => servers,
    testConnection: async () => {
      connectionProbes += 1;
      return { isError: false, text: 'Connected\n' };
    },
    callTool: async (_serverId: string, _toolName: string, args: any) => {
      sqlCalls.push(String(args?.sql ?? ''));
      return { isError: false, text: ['value', '-----', '7', '1 rows returned. (2ms)'].join('\n') };
    },
  } as unknown as McpManager;
  return { manager, stats: () => ({ sqlCalls, connectionProbes }) };
}

function openEnvironment(options: {
  directory?: string;
  mcp?: ReturnType<typeof fakeMcp>;
  etlRunner?: QueryRunner;
  dataRoomEnabled?: boolean;
  now?: () => Date;
} = {}) {
  const directory = options.directory ?? tempDirectory();
  const databasePath = path.join(directory, 'tracker.db');
  const roomRoot = path.join(directory, 'data-room');
  const storage = createStorage(databasePath);
  storage.initialize();
  storages.push(storage);
  const db = storage.getDb();
  const clock = options.now ?? (() => NOW);
  const store = createAnalyticsDataRoomStore({ db, rootDir: roomRoot, now: clock });
  const room = createAnalyticsDataRoomService({
    store,
    backups: createAnalyticsDataRoomBackupService({ db, store, now: clock }),
  });
  const localQuery = createAnalyticsLocalQueryEngine({ store });
  const bridge = createAnalyticsDashboardDataRoomBridge({ db, store, localQuery, now: clock });
  const mcp = options.mcp ?? fakeMcp('none');
  const dashboards = createAnalyticsDashboardService({
    db,
    mcpManager: mcp.manager,
    etlRunner: options.etlRunner,
    dataRoom: bridge,
    dataRoomRead: createAnalyticsDataRoomReadService({ store }),
    dataRoomEnabled: options.dataRoomEnabled,
  });
  return { directory, databasePath, roomRoot, storage, db, store, room, localQuery, bridge, mcp, dashboards };
}

const V1_ROWS: AnalyticsDataCell[][] = [
  ['2026-09-01', 'IN', 10],
  ['2026-09-01', 'US', 20],
  ['2026-09-02', 'IN', 30],
  ['2026-09-02', 'US', 40],
];

function ingest(
  environment: ReturnType<typeof openEnvironment>,
  rows: AnalyticsDataCell[][],
  expectedHeadRevision = 0,
  datasetId = 'ds_r4_events',
) {
  const dataset = environment.store.getDataset(datasetId)!;
  return environment.room.ingestSqlRows({
    datasetId: dataset.id,
    expectedHeadRevision,
    materializedAt: new Date(NOW.getTime() + expectedHeadRevision * 1_000).toISOString(),
    sourceReceipt: {
      sourceKind: 'sql_context',
      sourceId: `r4-source-${expectedHeadRevision + 1}`,
      querySha256: String(expectedHeadRevision + 3).repeat(64),
      producerVersion: 'r4-fixture',
      acquiredAt: NOW.toISOString(),
    },
    quality: [{ assertionId: 'fixture_ok', assertionVersion: '1', severity: 'error', success: true }],
    columns: dataset.contract.schema.map(field => field.name),
    rows,
    rowCount: rows.length,
    displayedRowCount: rows.length,
    truncated: false,
  });
}

function binding(
  environment: ReturnType<typeof openEnvironment>,
  policy: 'pinned' | 'latest_compatible' | 'latest_fresh' = 'latest_compatible',
  pinnedVersionId?: string,
  maxAgeMs = 30 * 24 * 60 * 60_000,
  datasetId = 'ds_r4_events',
): AnalyticsWidgetDataRoomBindingInput {
  const dataset = environment.store.getDataset(datasetId)!;
  return {
    datasetId: dataset.id,
    versionPolicy: policy,
    ...(pinnedVersionId ? { pinnedVersionId } : {}),
    expectedSchemaSha256: dataset.schemaSha256,
    expectedContractSha256: dataset.contractSha256,
    requiredColumns: ['event_date', 'region', 'events'],
    presentationLimit: 200,
    request: {
      domainKey: dataset.domainKey,
      metric: dataset.contract.metric,
      dimensions: ['event_date', 'region'],
      filters: [],
      dateRange: { start: '2026-09-01', end: '2026-09-02' },
      timeZone: 'UTC',
      countingKey: dataset.contract.countingKey,
      regime: dataset.contract.regime,
      requiredGrain: dataset.contract.grain,
      freshness: policy === 'latest_fresh' ? { mode: 'fresh_by', maxAgeMs } : { mode: 'allow_stale' },
      use: 'dashboard',
    },
  };
}

function createTwoWidgetDashboard(environment: ReturnType<typeof openEnvironment>, title = 'R4 dashboard') {
  return environment.dashboards.createDashboard({
    title,
    widgets: [
      { kind: 'table', title: 'Bound view', sql: 'SELECT 999' },
      { kind: 'metric', title: 'Legacy view', sql: 'SELECT 7' },
    ],
  });
}

describe('analytics dashboard data-room R4 bindings', () => {
  it('updates one binding and widget optimistically without changing sibling identity or result', async () => {
    const environment = openEnvironment();
    environment.room.registerDataset(sourceDefinition());
    ingest(environment, V1_ROWS);
    const dashboard = createTwoWidgetDashboard(environment);
    const [target, sibling] = dashboard.widgets;
    environment.db.prepare(`
      UPDATE analytics_widgets SET result_json = ?, last_refreshed_at = ? WHERE id = ?
    `).run('{"sentinel":"preserve"}', '2026-09-20T00:00:00.000Z', sibling.id);

    const mutation = environment.dashboards.updateWidgetBinding(dashboard.id, target.id, {
      expectedRevision: 0,
      binding: binding(environment),
    });
    expect(mutation.run?.refreshScope).toBe('selective');
    expect(mutation.run?.widgetCount).toBe(1);
    expect(await environment.dashboards.processQueuedRuns(1)).toBe(1);
    expect(() => environment.dashboards.updateWidgetBinding(dashboard.id, target.id, {
      expectedRevision: 0,
      binding: binding(environment),
    })).toThrow(/revision changed/i);

    const afterBinding = environment.dashboards.getDashboard(dashboard.id)!;
    expect(afterBinding.widgets.map(widget => widget.id)).toEqual([target.id, sibling.id]);
    expect(afterBinding.widgets[0].binding?.revision).toBe(1);
    expect(afterBinding.widgets[0].result).toMatchObject({
      trust: 'local_verified_data',
      rows: V1_ROWS,
      source: { provider: 'data-room', versionId: environment.store.getHead('ds_r4_events')!.versionId },
    });
    expect(afterBinding.widgets[1].result).toEqual({ sentinel: 'preserve' });
    expect(afterBinding.widgets[1].lastRefreshedAt).toBe('2026-09-20T00:00:00.000Z');
    expect(environment.mcp.stats()).toEqual({ sqlCalls: [], connectionProbes: 0 });

    const updated = environment.dashboards.updateWidget(dashboard.id, target.id, {
      expectedRevision: 1,
      widget: { kind: 'table', title: 'Renamed bound view', sql: 'SELECT 999' },
    });
    expect(updated.id).toBe(target.id);
    expect(updated.revision).toBe(2);
    const afterWidget = environment.dashboards.getDashboard(dashboard.id)!;
    expect(afterWidget.widgets[1]).toMatchObject({ id: sibling.id, result: { sentinel: 'preserve' } });
    expect(() => environment.dashboards.updateDashboard(dashboard.id, {
      widgets: [{ kind: 'metric', title: 'Replacement', sql: 'SELECT 1' }],
    })).toThrow(/stable identities/i);
  });

  it('freezes queued versions, then fans one new source version to two dashboards with selective local runs', async () => {
    const environment = openEnvironment();
    environment.room.registerDataset(sourceDefinition());
    const first = ingest(environment, V1_ROWS);
    const dashboards = [createTwoWidgetDashboard(environment, 'One'), createTwoWidgetDashboard(environment, 'Two')];
    for (const dashboard of dashboards) {
      environment.dashboards.updateWidgetBinding(dashboard.id, dashboard.widgets[0].id, {
        expectedRevision: 0,
        binding: binding(environment),
      });
    }
    const queuedSnapshots = environment.db.prepare(`
      SELECT version_id FROM analytics_run_widget_data_room_snapshots ORDER BY run_id
    `).all() as Array<{ version_id: string }>;
    expect(queuedSnapshots.map(row => row.version_id)).toEqual([first.version.id, first.version.id]);
    const remoteCalls = { availability: 0, execute: 0, read: 0 };
    const answer = createAnalyticsAnswerService({
      db: environment.db,
      store: environment.store,
      localQuery: environment.localQuery,
      remote: {
        availability: async () => { remoteCalls.availability += 1; throw new Error('room hit must not probe'); },
        execute: async () => { remoteCalls.execute += 1; throw new Error('room hit must not execute remotely'); },
        readEtlRun: async () => { remoteCalls.read += 1; throw new Error('room hit must not continue ETL'); },
      },
      now: () => NOW,
    });
    const ask = binding(environment).request;
    const qAndA = await answer.answer({
      request: { ...ask, use: 'local_answer', datasetId: 'ds_r4_events' },
      metricValueColumn: 'events',
      warehouseSql: 'DROP TABLE ignored_on_room_hit',
    });
    expect(qAndA).toMatchObject({
      status: 'answered',
      answer: { receipt: { versionIds: [first.version.id] } },
      execution: { laneProbes: 0, remoteExecutions: 0 },
    });
    expect(remoteCalls).toEqual({ availability: 0, execute: 0, read: 0 });

    const changedRows = V1_ROWS.map(row => [...row]);
    changedRows[0][2] = 100;
    const second = ingest(environment, changedRows, 1);
    expect(second.version.id).not.toBe(first.version.id);
    expect(await environment.dashboards.processQueuedRuns(2)).toBe(2);
    for (const dashboard of dashboards) {
      expect(environment.dashboards.getDashboard(dashboard.id)!.widgets[0].result?.source).toMatchObject({
        provider: 'data-room', versionId: first.version.id,
      });
    }

    expect(environment.dashboards.enqueueChangedBindings(20)).toBe(2);
    const selectiveRuns = environment.db.prepare(`
      SELECT dashboard_id, refresh_scope, widget_count FROM analytics_runs
      WHERE status = 'queued' ORDER BY dashboard_id
    `).all();
    expect(selectiveRuns).toEqual(dashboards
      .map(dashboard => ({ dashboard_id: dashboard.id, refresh_scope: 'selective', widget_count: 1 }))
      .sort((left, right) => left.dashboard_id.localeCompare(right.dashboard_id)));
    expect(await environment.dashboards.processQueuedRuns(2)).toBe(2);
    for (const dashboard of dashboards) {
      const current = environment.dashboards.getDashboard(dashboard.id)!;
      expect(current.widgets[0].result?.source).toMatchObject({ provider: 'data-room', versionId: second.version.id });
      expect(current.widgets[0].result?.rows[0]).toEqual(['2026-09-01', 'IN', 100]);
      expect(current.widgets[1].result).toBeUndefined();
      expect(current.lastRefreshedAt).toBeUndefined();
    }
    expect(environment.db.prepare('SELECT COUNT(*) AS count FROM analytics_dataset_versions').get()).toEqual({ count: 2 });
    expect(environment.mcp.stats()).toEqual({ sqlCalls: [], connectionProbes: 0 });
    expect(environment.store.versionDeletionEligibility(first.version.id).reasons)
      .toContain('pinned_by_dashboard_run');
    expect(() => environment.room.backupDataset('ds_r4_events', tempDirectory())).toThrow(/consumer closure|outside backup format/i);
  });

  it('runs only the unbound child remotely in a mixed full refresh', async () => {
    const mcp = fakeMcp('sql');
    const environment = openEnvironment({ mcp });
    environment.room.registerDataset(sourceDefinition());
    ingest(environment, V1_ROWS);
    const dashboard = createTwoWidgetDashboard(environment);
    environment.dashboards.updateWidgetBinding(dashboard.id, dashboard.widgets[0].id, {
      expectedRevision: 0,
      binding: binding(environment),
    });
    await environment.dashboards.processQueuedRuns(1);
    environment.dashboards.enqueueRefresh(dashboard.id, 'manual');
    expect(await environment.dashboards.processQueuedRuns(1)).toBe(1);

    const current = environment.dashboards.getDashboard(dashboard.id)!;
    expect(current.widgets[0].result?.source).toMatchObject({ provider: 'data-room' });
    expect(current.widgets[1].result).toMatchObject({ lane: 'sql-mcp', rows: [[7]] });
    expect(mcp.stats().sqlCalls).toEqual(['SELECT 7']);
    expect(mcp.stats().connectionProbes).toBe(1);
    const run = environment.db.prepare(`
      SELECT refresh_scope, widget_count, widgets_succeeded FROM analytics_runs
      ORDER BY queued_at DESC, id DESC LIMIT 1
    `).get();
    expect(run).toEqual({ refresh_scope: 'full', widget_count: 2, widgets_succeeded: 2 });
  });

  it('waits without a remote fallback, then runs selectively when the first head appears', async () => {
    const environment = openEnvironment();
    environment.room.registerDataset(sourceDefinition());
    const dashboard = createTwoWidgetDashboard(environment);
    const target = dashboard.widgets[0];
    environment.dashboards.updateWidgetBinding(dashboard.id, target.id, {
      expectedRevision: 0,
      binding: binding(environment),
    });
    expect(await environment.dashboards.processQueuedRuns(1)).toBe(1);
    const waiting = environment.dashboards.getDashboard(dashboard.id)!;
    expect(waiting.status).toBe('waiting_for_data');
    expect(waiting.widgets[0]).toMatchObject({
      id: target.id,
      lastError: expect.stringContaining('WAITING_FOR_DATA'),
    });
    expect(environment.mcp.stats()).toEqual({ sqlCalls: [], connectionProbes: 0 });

    const first = ingest(environment, V1_ROWS);
    expect(environment.dashboards.enqueueChangedBindings()).toBe(1);
    expect(await environment.dashboards.processQueuedRuns(1)).toBe(1);
    const ready = environment.dashboards.getDashboard(dashboard.id)!;
    expect(ready.status).toBe('ready');
    expect(ready.widgets[0]).toMatchObject({
      id: target.id,
      result: { source: { provider: 'data-room', versionId: first.version.id } },
    });
  });

  it('fails closed when a pinned version belongs to an older dataset definition', async () => {
    const environment = openEnvironment();
    environment.room.registerDataset(sourceDefinition());
    const oldVersion = ingest(environment, V1_ROWS).version;
    const revised = sourceDefinition() as AnalyticsDatasetDefinitionInput & { expectedDefinitionRevision: number };
    revised.expectedDefinitionRevision = 1;
    revised.definition = { ...revised.definition, source: 'r4-fixture-revised' };
    environment.store.reviseDataset(revised);
    const dashboard = createTwoWidgetDashboard(environment);
    const run = environment.dashboards.updateWidgetBinding(dashboard.id, dashboard.widgets[0].id, {
      expectedRevision: 0,
      binding: binding(environment, 'pinned', oldVersion.id),
    }).run!;

    expect(environment.db.prepare(`
      SELECT candidate_version_id, version_id, control_revision, resolution_error
      FROM analytics_run_widget_data_room_snapshots WHERE run_id = ?
    `).get(run.id)).toMatchObject({
      candidate_version_id: oldVersion.id,
      version_id: null,
      control_revision: null,
      resolution_error: expect.stringContaining('older dataset definition'),
    });
    expect(await environment.dashboards.processQueuedRuns(1)).toBe(1);
    expect(environment.dashboards.getDashboard(dashboard.id)!.status).toBe('waiting_for_data');
    expect(environment.mcp.stats()).toEqual({ sqlCalls: [], connectionProbes: 0 });
    expect(environment.bridge.removeBinding(dashboard.widgets[0].id, 1)).toBe(2);
    expect(environment.store.versionDeletionEligibility(oldVersion.id).reasons)
      .toContain('pinned_by_dashboard_run');
    expect(() => environment.room.backupDataset('ds_r4_events', tempDirectory()))
      .toThrow(/historical run snapshots|consumer closure/i);
  });

  it('reopens an interrupted local child with the same immutable snapshot and no lane receipt', async () => {
    const directory = tempDirectory();
    const first = openEnvironment({ directory });
    first.room.registerDataset(sourceDefinition());
    const version = ingest(first, V1_ROWS).version;
    const dashboard = createTwoWidgetDashboard(first);
    const queued = first.dashboards.updateWidgetBinding(dashboard.id, dashboard.widgets[0].id, {
      expectedRevision: 0,
      binding: binding(first, 'pinned', version.id),
    }).run!;
    expect(first.store.versionDeletionEligibility(version.id).reasons)
      .toContain('referenced_by_widget_binding');
    const snapshotBefore = first.db.prepare(`
      SELECT widget_revision, binding_revision, version_id, request_sha256, query_sha256
      FROM analytics_run_widget_data_room_snapshots WHERE run_id = ?
    `).get(queued.id);
    first.db.prepare(`
      UPDATE analytics_runs SET status = 'running', worker_id = 'dead-worker', worker_pid = 999999,
        lease_expires_at = '2020-01-01T00:00:00.000Z', started_at = '2020-01-01T00:00:00.000Z'
      WHERE id = ?
    `).run(queued.id);
    first.db.prepare(`
      UPDATE analytics_run_widgets SET status = 'running', started_at = '2020-01-01T00:00:00.000Z'
      WHERE run_id = ?
    `).run(queued.id);
    first.storage.close();
    storages.splice(storages.indexOf(first.storage), 1);

    const reopened = openEnvironment({ directory });
    expect(reopened.dashboards.recoverInterruptedRuns()).toBe(1);
    expect(reopened.db.prepare(`
      SELECT status, last_lane FROM analytics_run_widgets WHERE run_id = ?
    `).get(queued.id)).toEqual({ status: 'queued', last_lane: null });
    expect(reopened.db.prepare(`
      SELECT widget_revision, binding_revision, version_id, request_sha256, query_sha256
      FROM analytics_run_widget_data_room_snapshots WHERE run_id = ?
    `).get(queued.id)).toEqual(snapshotBefore);
    expect(await reopened.dashboards.processQueuedRuns(1)).toBe(1);
    expect(reopened.dashboards.getDashboard(dashboard.id)!.widgets[0].result?.source).toMatchObject({
      provider: 'data-room', versionId: version.id,
    });
    expect(reopened.mcp.stats()).toEqual({ sqlCalls: [], connectionProbes: 0 });
  });

  it('keeps the binding but uses retained legacy SQL when the R4 kill switch is off', async () => {
    const directory = tempDirectory();
    const setup = openEnvironment({ directory });
    setup.room.registerDataset(sourceDefinition());
    ingest(setup, V1_ROWS);
    const dashboard = createTwoWidgetDashboard(setup);
    setup.bridge.putBinding(dashboard.widgets[0].id, 0, binding(setup));
    setup.storage.close();
    storages.splice(storages.indexOf(setup.storage), 1);

    const mcp = fakeMcp('sql');
    const disabled = openEnvironment({ directory, mcp, dataRoomEnabled: false });
    const run = disabled.dashboards.enqueueSelectiveRefresh(dashboard.id, [dashboard.widgets[0].id]);
    expect(await disabled.dashboards.processQueuedRuns(1)).toBe(1);
    expect(disabled.db.prepare(`
      SELECT COUNT(*) AS count FROM analytics_run_widget_data_room_snapshots WHERE run_id = ?
    `).get(run.id)).toEqual({ count: 0 });
    expect(disabled.dashboards.getDashboard(dashboard.id)!.widgets[0]).toMatchObject({
      binding: { datasetId: 'ds_r4_events' },
      result: { lane: 'sql-mcp', rows: [[7]] },
    });
    expect(mcp.stats().sqlCalls).toEqual(['SELECT 999']);
  });

  it('rejects an old legacy ETL handoff before remote read once the widget is bound', async () => {
    let readCalls = 0;
    const etlRunner: QueryRunner = {
      id: 'r4-late-etl',
      runQuery: async (): Promise<QueryRunResult> => ({
        ok: false,
        code: 'alive_handoff',
        runId: '88001',
        remoteStatus: 'EXECUTING',
        error: 'Run 88001 still EXECUTING after 55 minutes. Do NOT resubmit.',
        nextAction: 'Continue this exact run by status/download only.',
      }),
      readRun: async () => {
        readCalls += 1;
        throw new Error('stale handoff must be rejected before read');
      },
    };
    const environment = openEnvironment({ mcp: fakeMcp('etl'), etlRunner });
    environment.room.registerDataset(sourceDefinition());
    ingest(environment, V1_ROWS);
    const dashboard = environment.dashboards.createDashboard({
      title: 'Late result guard',
      widgets: [{ kind: 'metric', title: 'Legacy pending', sql: 'SELECT 7' }],
    });
    environment.dashboards.enqueueRefresh(dashboard.id);
    expect(await environment.dashboards.processQueuedRuns(1)).toBe(1);
    expect(environment.db.prepare(`SELECT state FROM analytics_late_etl_results`).get()).toEqual({ state: 'pending' });

    environment.bridge.putBinding(dashboard.widgets[0].id, 0, binding(environment));
    environment.db.prepare(`UPDATE analytics_late_etl_results SET next_check_at = '2020-01-01T00:00:00.000Z'`).run();
    expect(await environment.dashboards.processLateEtlResults(1)).toBe(1);
    expect(readCalls).toBe(0);
    expect(environment.db.prepare(`SELECT state, error FROM analytics_late_etl_results`).get()).toMatchObject({
      state: 'definition_changed',
      error: expect.stringContaining('data-room binding'),
    });
  });
});

describe('analytics dashboard data-room R4 adversarial lifecycle', () => {
  it('expires latest_fresh on time passage without waiting for a new head', async () => {
    let clock = new Date(NOW);
    const environment = openEnvironment({ now: () => clock });
    environment.room.registerDataset(sourceDefinition());
    ingest(environment, V1_ROWS);
    const dashboard = createTwoWidgetDashboard(environment);
    environment.dashboards.updateWidgetBinding(dashboard.id, dashboard.widgets[0].id, {
      expectedRevision: 0,
      binding: binding(environment, 'latest_fresh'),
    });
    expect(await environment.dashboards.processQueuedRuns(1)).toBe(1);
    expect(environment.dashboards.getDashboard(dashboard.id)!.status).toBe('ready');

    clock = new Date('2026-10-10T12:00:00.000Z');
    expect(environment.dashboards.enqueueChangedBindings()).toBe(1);
    expect(await environment.dashboards.processQueuedRuns(1)).toBe(1);
    const stale = environment.dashboards.getDashboard(dashboard.id)!;
    expect(stale.status).toBe('waiting_for_data');
    expect(stale.widgets[0].binding).toMatchObject({
      compatibility: 'waiting',
      compatibilityError: expect.stringMatching(/age exceeds/i),
    });
    expect(environment.mcp.stats()).toEqual({ sqlCalls: [], connectionProbes: 0 });
    expect(environment.dashboards.enqueueChangedBindings()).toBe(0);
  });

  it('runs already-queued snapshot children through legacy SQL after a disabled restart', async () => {
    const directory = tempDirectory();
    const enabled = openEnvironment({ directory });
    enabled.room.registerDataset(sourceDefinition());
    ingest(enabled, V1_ROWS);
    const dashboard = createTwoWidgetDashboard(enabled);
    enabled.bridge.putBinding(dashboard.widgets[0].id, 0, binding(enabled));
    const queued = enabled.dashboards.enqueueRefresh(dashboard.id);
    expect(enabled.db.prepare(`
      SELECT COUNT(*) AS count FROM analytics_run_widget_data_room_snapshots WHERE run_id = ?
    `).get(queued.id)).toEqual({ count: 1 });
    enabled.storage.close();
    storages.splice(storages.indexOf(enabled.storage), 1);

    const mcp = fakeMcp('sql');
    const disabled = openEnvironment({ directory, mcp, dataRoomEnabled: false });
    expect(await disabled.dashboards.processQueuedRuns(1)).toBe(1);
    expect(mcp.stats().sqlCalls.sort()).toEqual(['SELECT 7', 'SELECT 999']);
    const current = disabled.dashboards.getDashboard(dashboard.id)!;
    expect(current.status).toBe('ready');
    expect(current.widgets[0]).toMatchObject({
      binding: { datasetId: 'ds_r4_events' },
      result: { lane: 'sql-mcp', rows: [[7]] },
    });
    expect(disabled.db.prepare(`SELECT status FROM analytics_runs WHERE id = ?`).get(queued.id))
      .toEqual({ status: 'completed' });
  });

  it('preserves alternate-lane recovery for an interrupted legacy child', async () => {
    const directory = tempDirectory();
    const first = openEnvironment({ directory });
    const dashboard = first.dashboards.createDashboard({
      title: 'Interrupted legacy',
      widgets: [{ kind: 'metric', title: 'Legacy', sql: 'SELECT 7' }],
    });
    const run = first.dashboards.enqueueRefresh(dashboard.id);
    first.db.prepare(`
      UPDATE analytics_runs SET status = 'running', primary_lane = 'sql-mcp',
        worker_id = 'dead-worker', worker_pid = 999999,
        lease_expires_at = '2020-01-01T00:00:00.000Z', started_at = '2020-01-01T00:00:00.000Z'
      WHERE id = ?
    `).run(run.id);
    first.db.prepare(`
      UPDATE analytics_run_widgets SET status = 'running', last_lane = 'sql-mcp',
        started_at = '2020-01-01T00:00:00.000Z' WHERE run_id = ?
    `).run(run.id);
    first.storage.close();
    storages.splice(storages.indexOf(first.storage), 1);

    let etlCalls = 0;
    const etlRunner: QueryRunner = {
      id: 'recovery-etl',
      runQuery: async () => {
        etlCalls += 1;
        return { ok: true, runId: '9001', columns: ['value'], rows: [['42']], rowCount: 1 };
      },
    };
    const reopened = openEnvironment({ directory, mcp: fakeMcp('etl'), etlRunner });
    expect(reopened.dashboards.recoverInterruptedRuns()).toBe(1);
    expect(await reopened.dashboards.processQueuedRuns(1)).toBe(1);
    expect(etlCalls).toBe(1);
    expect(reopened.dashboards.getDashboard(dashboard.id)!.widgets[0].result).toMatchObject({
      lane: 'etl', rows: [[42]],
    });
    expect(reopened.db.prepare(`SELECT status FROM analytics_runs WHERE id = ?`).get(run.id))
      .toEqual({ status: 'completed' });
  });

  it('keeps archived dashboards terminal even when a binding was waiting', () => {
    const environment = openEnvironment();
    environment.room.registerDataset(sourceDefinition());
    const dashboard = createTwoWidgetDashboard(environment);
    const target = dashboard.widgets[0];
    environment.bridge.putBinding(target.id, 0, binding(environment));
    environment.dashboards.updateDashboard(dashboard.id, { status: 'archived' });

    expect(environment.dashboards.getDashboard(dashboard.id)!.status).toBe('archived');
    expect(() => environment.dashboards.enqueueRefresh(dashboard.id)).toThrow(/archived/i);
    expect(() => environment.dashboards.enqueueSelectiveRefresh(dashboard.id, [target.id])).toThrow(/archived/i);
    expect(() => environment.dashboards.updateWidget(dashboard.id, target.id, {
      expectedRevision: 1,
      widget: { kind: 'table', title: 'No', sql: 'SELECT 1' },
    })).toThrow(/archived/i);
    expect(() => environment.dashboards.updateWidgetBinding(dashboard.id, target.id, {
      expectedRevision: 1,
      binding: binding(environment),
    })).toThrow(/archived/i);
    expect(() => environment.dashboards.setSchedule(dashboard.id, {
      enabled: true, localTime: '09:00', timezone: 'UTC',
    })).toThrow(/archived/i);
    environment.dashboards.updateDashboard(dashboard.id, { status: 'ready' });
    expect(environment.dashboards.getDashboard(dashboard.id)!.status).toBe('waiting_for_data');
  });

  it('keeps a monotonic binding generation across remove and recreate', () => {
    const environment = openEnvironment();
    environment.room.registerDataset(sourceDefinition());
    const dashboard = createTwoWidgetDashboard(environment);
    const widgetId = dashboard.widgets[0].id;
    expect(environment.bridge.putBinding(widgetId, 0, binding(environment)).revision).toBe(1);
    expect(environment.bridge.removeBinding(widgetId, 1)).toBe(2);
    expect(environment.bridge.putBinding(widgetId, 2, binding(environment)).revision).toBe(3);
    expect(environment.bridge.getBindingRevision(widgetId)).toBe(3);
    expect(() => environment.bridge.putBinding(widgetId, 1, binding(environment))).toThrow(/expected 1 to 3/i);
    expect(() => environment.bridge.removeBinding(widgetId, 1)).toThrow(/expected 1 to 3/i);
    expect(environment.dashboards.getDashboard(dashboard.id)!.widgets[0].bindingRevision).toBe(3);
  });

  it('enforces dashboard-local and project dataset scope at bind time', () => {
    const environment = openEnvironment();
    environment.room.registerDataset(sourceDefinition('ds_r4_local', 'dashboard_local'));
    environment.room.registerDataset(sourceDefinition('ds_r4_project', 'project'));
    const first = createTwoWidgetDashboard(environment, 'Scope one');
    const second = createTwoWidgetDashboard(environment, 'Scope two');
    environment.bridge.putBinding(first.widgets[0].id, 0, binding(environment, 'latest_compatible', undefined, undefined, 'ds_r4_local'));
    expect(() => environment.bridge.putBinding(
      second.widgets[0].id,
      0,
      binding(environment, 'latest_compatible', undefined, undefined, 'ds_r4_local'),
    )).toThrow(/belongs to/i);

    expect(() => environment.bridge.putBinding(
      second.widgets[0].id,
      0,
      binding(environment, 'latest_compatible', undefined, undefined, 'ds_r4_project'),
    )).toThrow(/not linked/i);
    environment.db.prepare(`
      INSERT INTO analytics_dataset_project_links (dataset_id, project_id, linked_at)
      VALUES ('ds_r4_project', 'project_scope', ?)
    `).run(NOW.toISOString());
    environment.db.prepare(`
      INSERT INTO analytics_dashboard_projects (dashboard_id, project_id, linked_at)
      VALUES (?, 'project_scope', ?)
    `).run(second.id, NOW.toISOString());
    expect(environment.bridge.putBinding(
      second.widgets[0].id,
      0,
      binding(environment, 'latest_compatible', undefined, undefined, 'ds_r4_project'),
    ).datasetId).toBe('ds_r4_project');
  });

  it('revalidates dataset definition after an asynchronous local read before apply', async () => {
    const base = openEnvironment();
    base.room.registerDataset(sourceDefinition());
    ingest(base, V1_ROWS);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let started!: () => void;
    const executionStarted = new Promise<void>(resolve => { started = resolve; });
    const delayedQuery = {
      ...base.localQuery,
      execute: async (input: Parameters<typeof base.localQuery.execute>[0]) => {
        started();
        await gate;
        return base.localQuery.execute(input);
      },
    };
    const bridge = createAnalyticsDashboardDataRoomBridge({
      db: base.db, store: base.store, localQuery: delayedQuery, now: () => NOW,
    });
    const dashboards = createAnalyticsDashboardService({
      db: base.db, mcpManager: base.mcp.manager, dataRoom: bridge,
    });
    const dashboard = createTwoWidgetDashboard({ ...base, dashboards } as ReturnType<typeof openEnvironment>);
    dashboards.updateWidgetBinding(dashboard.id, dashboard.widgets[0].id, {
      expectedRevision: 0,
      binding: binding(base),
    });
    const processing = dashboards.processQueuedRuns(1);
    await executionStarted;
    const revised = sourceDefinition() as AnalyticsDatasetDefinitionInput & { expectedDefinitionRevision: number };
    revised.expectedDefinitionRevision = 1;
    revised.definition = { ...revised.definition, source: 'changed-during-read' };
    base.store.reviseDataset(revised);
    release();
    expect(await processing).toBe(1);
    const current = dashboards.getDashboard(dashboard.id)!;
    expect(current.widgets[0].result).toBeUndefined();
    expect(current.widgets[0].lastError).toMatch(/definition.*changed/i);
    expect(base.db.prepare(`SELECT applied_at FROM analytics_run_widget_data_room_snapshots`).get())
      .toEqual({ applied_at: null });
  });

  it('preserves unrelated selective state when a queued local run is cancelled', () => {
    const environment = openEnvironment();
    environment.room.registerDataset(sourceDefinition());
    ingest(environment, V1_ROWS);
    const dashboard = createTwoWidgetDashboard(environment);
    environment.db.prepare(`
      UPDATE analytics_widgets SET result_json = '{"sentinel":"sibling"}',
        last_error = 'existing sibling failure', last_refreshed_at = '2026-09-20T00:00:00.000Z'
      WHERE id = ?
    `).run(dashboard.widgets[1].id);
    environment.db.prepare(`
      UPDATE analytics_dashboards SET last_refreshed_at = '2026-09-19T00:00:00.000Z'
      WHERE id = ?
    `).run(dashboard.id);
    environment.dashboards.updateWidgetBinding(dashboard.id, dashboard.widgets[0].id, {
      expectedRevision: 0,
      binding: binding(environment),
    });
    expect(environment.dashboards.cancelActiveRun(dashboard.id).result).toBe('cancelled');
    const current = environment.dashboards.getDashboard(dashboard.id)!;
    expect(current.status).toBe('degraded');
    expect(current.lastError).toContain('existing sibling failure');
    expect(current.lastRefreshedAt).toBe('2026-09-19T00:00:00.000Z');
    expect(current.widgets[1]).toMatchObject({
      result: { sentinel: 'sibling' },
      lastError: 'existing sibling failure',
      lastRefreshedAt: '2026-09-20T00:00:00.000Z',
    });
  });

  it('allows an exact disabled-mode ETL handoff to finish without dropping the retained binding', async () => {
    const directory = tempDirectory();
    const enabled = openEnvironment({ directory });
    enabled.room.registerDataset(sourceDefinition());
    ingest(enabled, V1_ROWS);
    const dashboard = createTwoWidgetDashboard(enabled);
    enabled.dashboards.updateWidgetBinding(dashboard.id, dashboard.widgets[0].id, {
      expectedRevision: 0,
      binding: binding(enabled),
    });
    await enabled.dashboards.processQueuedRuns(1);
    enabled.storage.close();
    storages.splice(storages.indexOf(enabled.storage), 1);

    let readCalls = 0;
    const runner: QueryRunner = {
      id: 'disabled-late',
      runQuery: async () => ({
        ok: false,
        code: 'alive_handoff',
        runId: '99001',
        remoteStatus: 'EXECUTING',
        error: 'Run 99001 still EXECUTING after 55 minutes. Do NOT resubmit.',
        nextAction: 'Continue this exact run.',
      }),
      readRun: async () => {
        readCalls += 1;
        return { ok: true, runId: '99001', columns: ['value'], rows: [['42']], rowCount: 1 };
      },
    };
    const disabled = openEnvironment({ directory, mcp: fakeMcp('etl'), etlRunner: runner, dataRoomEnabled: false });
    disabled.dashboards.enqueueSelectiveRefresh(dashboard.id, [dashboard.widgets[0].id]);
    expect(await disabled.dashboards.processQueuedRuns(1)).toBe(1);
    disabled.db.prepare(`UPDATE analytics_late_etl_results SET next_check_at = '2020-01-01T00:00:00.000Z'`).run();
    expect(await disabled.dashboards.processLateEtlResults(1)).toBe(1);
    expect(readCalls).toBe(1);
    expect(disabled.db.prepare(`SELECT state, binding_revision, dataset_id FROM analytics_late_etl_results`).get())
      .toMatchObject({ state: 'applied', binding_revision: 1, dataset_id: 'ds_r4_events' });
    expect(disabled.dashboards.getDashboard(dashboard.id)!.widgets[0]).toMatchObject({
      binding: { revision: 1 },
      result: { lane: 'etl', rows: [[42]] },
    });
  });
});

describe('analytics dashboard data-room R4 lifecycle closure', () => {
  it('requeues a failed local snapshot as legacy work after a disabled restart', async () => {
    const directory = tempDirectory();
    const enabled = openEnvironment({ directory });
    enabled.room.registerDataset(sourceDefinition());
    ingest(enabled, V1_ROWS);
    const dashboard = createTwoWidgetDashboard(enabled);
    enabled.bridge.putBinding(dashboard.widgets[0].id, 0, binding(enabled));
    const run = enabled.dashboards.enqueueSelectiveRefresh(dashboard.id, [dashboard.widgets[0].id]);
    enabled.db.prepare(`
      UPDATE analytics_runs SET status = 'running', worker_id = 'dead-local', worker_pid = 999999,
        lease_expires_at = '2020-01-01T00:00:00.000Z', started_at = '2020-01-01T00:00:00.000Z'
      WHERE id = ?
    `).run(run.id);
    enabled.db.prepare(`
      UPDATE analytics_run_widgets SET status = 'failed', error = '[WAITING_FOR_DATA] prior local failure',
        completed_at = '2020-01-01T00:00:01.000Z', last_lane = NULL WHERE run_id = ?
    `).run(run.id);
    enabled.storage.close();
    storages.splice(storages.indexOf(enabled.storage), 1);

    const mcp = fakeMcp('sql');
    const disabled = openEnvironment({ directory, mcp, dataRoomEnabled: false });
    expect(disabled.dashboards.recoverInterruptedRuns()).toBe(1);
    expect(disabled.db.prepare(`SELECT status, last_lane FROM analytics_run_widgets WHERE run_id = ?`).get(run.id))
      .toEqual({ status: 'queued', last_lane: null });
    expect(await disabled.dashboards.processQueuedRuns(1)).toBe(1);
    expect(mcp.stats().sqlCalls).toEqual(['SELECT 999']);
    expect(disabled.dashboards.getDashboard(dashboard.id)!.widgets[0].result).toMatchObject({
      lane: 'sql-mcp', rows: [[7]],
    });
  });

  it('revalidates project scope before execution and retains dashboard-local ownership on delete', async () => {
    const environment = openEnvironment();
    environment.room.registerDataset(sourceDefinition('ds_r4_project_live', 'project'));
    ingest(environment, V1_ROWS, 0, 'ds_r4_project_live');
    const dashboard = createTwoWidgetDashboard(environment);
    environment.db.prepare(`
      INSERT INTO analytics_dataset_project_links (dataset_id, project_id, linked_at)
      VALUES ('ds_r4_project_live', 'project_live', ?)
    `).run(NOW.toISOString());
    environment.db.prepare(`
      INSERT INTO analytics_dashboard_projects (dashboard_id, project_id, linked_at)
      VALUES (?, 'project_live', ?)
    `).run(dashboard.id, NOW.toISOString());
    environment.dashboards.updateWidgetBinding(dashboard.id, dashboard.widgets[0].id, {
      expectedRevision: 0,
      binding: binding(environment, 'latest_compatible', undefined, undefined, 'ds_r4_project_live'),
    });
    expect(() => environment.dashboards.updateDashboard(dashboard.id, { projectIds: [] }))
      .toThrow(/project links cannot change while refresh/i);
    environment.db.prepare(`DELETE FROM analytics_dashboard_projects WHERE dashboard_id = ?`).run(dashboard.id);
    expect(await environment.dashboards.processQueuedRuns(1)).toBe(1);
    expect(environment.dashboards.getDashboard(dashboard.id)!.widgets[0].result).toBeUndefined();
    expect(environment.dashboards.getDashboard(dashboard.id)!.widgets[0].lastError).toMatch(/not linked/i);

    environment.room.registerDataset(sourceDefinition('ds_r4_local_owned', 'dashboard_local'));
    const localDashboard = createTwoWidgetDashboard(environment, 'Local owner');
    environment.bridge.putBinding(
      localDashboard.widgets[0].id,
      0,
      binding(environment, 'latest_compatible', undefined, undefined, 'ds_r4_local_owned'),
    );
    expect(() => environment.dashboards.deleteDashboard(localDashboard.id)).toThrow(/owns local dataset/i);
    expect(environment.db.prepare(`
      SELECT dashboard_id FROM analytics_dataset_dashboard_owners WHERE dataset_id = 'ds_r4_local_owned'
    `).get()).toEqual({ dashboard_id: localDashboard.id });
  });

  it('keeps a no-head binding visibly waiting when its queued run is cancelled', () => {
    const environment = openEnvironment();
    environment.room.registerDataset(sourceDefinition());
    const dashboard = createTwoWidgetDashboard(environment);
    environment.dashboards.updateWidgetBinding(dashboard.id, dashboard.widgets[0].id, {
      expectedRevision: 0,
      binding: binding(environment),
    });
    expect(environment.dashboards.cancelActiveRun(dashboard.id).result).toBe('cancelled');
    const current = environment.dashboards.getDashboard(dashboard.id)!;
    expect(current.status).toBe('waiting_for_data');
    expect(current.widgets[0].binding).toMatchObject({ compatibility: 'waiting' });
    expect(current.lastRefreshedAt).toBeUndefined();
  });

  it('does not allow bulk widget or project replacement while archived', () => {
    const environment = openEnvironment();
    const dashboard = createTwoWidgetDashboard(environment);
    environment.dashboards.updateDashboard(dashboard.id, { status: 'archived' });
    expect(() => environment.dashboards.updateDashboard(dashboard.id, {
      widgets: [{ kind: 'metric', title: 'Replacement', sql: 'SELECT 1' }],
    })).toThrow(/archived dashboard widgets/i);
    expect(() => environment.dashboards.updateDashboard(dashboard.id, { projectIds: [] }))
      .toThrow(/archived dashboard widgets and project links/i);
    expect(environment.dashboards.getDashboard(dashboard.id)!.widgets.map(widget => widget.id))
      .toEqual(dashboard.widgets.map(widget => widget.id));
  });
});

describe('workspace project deletion analytics scope guard', () => {
  it('does not remove dashboard project scope while a linked analytics run is active', () => {
    const environment = openEnvironment();
    environment.db.prepare(`
      INSERT INTO projects (id, title, brain_path) VALUES ('proj_r4_scope', 'R4 scope project', '/tmp/r4-scope.md')
    `).run();
    const dashboard = createTwoWidgetDashboard(environment);
    environment.db.prepare(`
      INSERT INTO analytics_dashboard_projects (dashboard_id, project_id, linked_at)
      VALUES (?, 'proj_r4_scope', ?)
    `).run(dashboard.id, NOW.toISOString());
    const run = environment.dashboards.enqueueRefresh(dashboard.id);
    const catalog = createWorkspaceCatalogService({
      db: environment.db,
      brainStore: {
        hasManualEdit: () => false,
        read: () => null,
        write: () => undefined,
      } as any,
    });

    expect(() => catalog.deleteProject(
      'proj_r4_scope',
      { confirmTitle: 'R4 scope project' },
      { actor: 'owner', commandId: 'r4-scope-delete' },
    )).toThrow(new RegExp(`analytics refresh ${run.id} is active`));
    expect(environment.db.prepare(`SELECT id FROM projects WHERE id = 'proj_r4_scope'`).get())
      .toEqual({ id: 'proj_r4_scope' });
    expect(environment.db.prepare(`
      SELECT dashboard_id FROM analytics_dashboard_projects WHERE project_id = 'proj_r4_scope'
    `).get()).toEqual({ dashboard_id: dashboard.id });
  });
});


describe('analytics dashboard R4.1 deterministic widget editing', () => {
  let editRequest = 0;
  const editIdentity = (
    dashboardId: string,
    widgetIds: string[],
    ownerMessage: string,
    explicitNew = false,
  ) => ({
    ownerRequestId: `request-r41-${++editRequest}`,
    ownerMessage,
    ownerScope: { source: 'owner_exact_ids' as const, dashboardId, orderedWidgetIds: [...widgetIds] },
    explicitNew,
  });

  const lineSpec = {
    width: 'container',
    height: 220,
    mark: { type: 'line', point: true },
    encoding: {
      x: { field: 'event_date', type: 'temporal' },
      y: { field: 'events', type: 'quantitative' },
      color: { field: 'region', type: 'nominal' },
    },
  };
  const barSpec = {
    width: 'container',
    height: 180,
    mark: 'bar',
    encoding: {
      x: { field: 'region', type: 'nominal' },
      y: { aggregate: 'sum', field: 'events', type: 'quantitative' },
    },
  };

  function createVisualDashboard(environment: ReturnType<typeof openEnvironment>) {
    return environment.dashboards.createDashboard({
      title: 'R4.1 visual editing',
      widgets: [
        { kind: 'visualization', title: 'Trend', sql: 'SELECT 999', config: { spec: lineSpec } },
        { kind: 'visualization', title: 'Totals', sql: 'SELECT 999', config: { spec: barSpec } },
      ],
    });
  }

  async function bindAndProcess(
    environment: ReturnType<typeof openEnvironment>,
    dashboardId: string,
    widgetId: string,
    input = binding(environment),
  ) {
    const mutation = environment.dashboards.updateWidgetBinding(dashboardId, widgetId, {
      expectedRevision: 0,
      binding: input,
    });
    expect(mutation.run?.refreshScope).toBe('selective');
    expect(await environment.dashboards.processQueuedRuns(1)).toBe(1);
    return environment.dashboards.getDashboard(dashboardId)!.widgets.find(widget => widget.id === widgetId)!;
  }

  it('preserves verified data for presentation and clones only the requested date range', async () => {
    const environment = openEnvironment();
    environment.room.registerDataset(sourceDefinition());
    ingest(environment, V1_ROWS);
    const dashboard = createVisualDashboard(environment);
    const [target, sibling] = dashboard.widgets;
    const boundTarget = await bindAndProcess(environment, dashboard.id, target.id);
    await bindAndProcess(environment, dashboard.id, sibling.id);

    const targetResultBefore = JSON.parse(JSON.stringify(boundTarget.result!));
    const bindingBefore = environment.db.prepare('SELECT * FROM analytics_widget_dataset_bindings WHERE widget_id = ?').get(target.id);
    const siblingBefore = environment.db.prepare('SELECT * FROM analytics_widgets WHERE id = ?').get(sibling.id);
    const runCount = Number((environment.db.prepare('SELECT COUNT(*) AS count FROM analytics_runs').get() as any).count);
    const snapshotCount = Number((environment.db.prepare('SELECT COUNT(*) AS count FROM analytics_run_widget_data_room_snapshots').get() as any).count);

    const presentation = environment.dashboards.editDataRoomWidget({
      action: 'presentation',
      dashboardId: dashboard.id,
      widgetIds: [target.id],
      presentation: { renderer: 'area', title: 'Area trend' },
    });
    expect(presentation).toMatchObject({ resultDisposition: 'preserved' });
    expect(presentation.run).toBeUndefined();
    expect(presentation.widget).toMatchObject({ id: target.id, revision: 2, title: 'Area trend' });
    expect((presentation.widget.config.spec as any).mark).toMatchObject({ type: 'area', point: true });
    expect(presentation.widget.result).toEqual({
      ...targetResultBefore,
      source: { ...(targetResultBefore.source as any), widgetRevision: 2 },
    });
    expect(presentation.widget.lastRefreshedAt).toBe(boundTarget.lastRefreshedAt);
    expect(environment.db.prepare('SELECT * FROM analytics_widget_dataset_bindings WHERE widget_id = ?').get(target.id)).toEqual(bindingBefore);
    expect(environment.db.prepare('SELECT * FROM analytics_widgets WHERE id = ?').get(sibling.id)).toEqual(siblingBefore);
    expect(Number((environment.db.prepare('SELECT COUNT(*) AS count FROM analytics_runs').get() as any).count)).toBe(runCount);
    expect(Number((environment.db.prepare('SELECT COUNT(*) AS count FROM analytics_run_widget_data_room_snapshots').get() as any).count)).toBe(snapshotCount);

    const dateEdit = environment.dashboards.editDataRoomWidget({
      action: 'date_range',
      dashboardId: dashboard.id,
      widgetIds: [target.id],
      dateRange: { start: '2026-09-02', end: '2026-09-02' },
    });
    expect(dateEdit).toMatchObject({ resultDisposition: 'refresh_queued', run: { refreshScope: 'selective', widgetCount: 1 } });
    const reboundWidget = environment.dashboards.getDashboard(dashboard.id)!.widgets[0];
    const rebound = reboundWidget.binding!;
    expect(rebound.revision).toBe(1);
    expect(rebound.request).toEqual(boundTarget.binding!.request);
    expect(reboundWidget.controls).toMatchObject({
      controlRevision: 2,
      currentValues: { dateRange: { start: '2026-09-02', end: '2026-09-02' } },
    });
    expect(await environment.dashboards.processQueuedRuns(1)).toBe(1);
    const narrowed = environment.dashboards.getDashboard(dashboard.id)!.widgets[0];
    expect(narrowed.result).toMatchObject({
      rows: V1_ROWS.slice(2),
      source: {
        provider: 'data-room',
        versionId: targetResultBefore.source && (targetResultBefore.source as any).versionId,
        bindingRevision: 1,
        widgetRevision: 2,
        controlRevision: 2,
      },
    });
    expect((narrowed.result!.source as any).querySha256).not.toBe((targetResultBefore.source as any).querySha256);
    expect(environment.db.prepare('SELECT * FROM analytics_widgets WHERE id = ?').get(sibling.id)).toEqual(siblingBefore);
    expect(environment.mcp.stats()).toEqual({ sqlCalls: [], connectionProbes: 0 });
  });

  it('appends one stable bound widget without replacing siblings', async () => {
    const environment = openEnvironment();
    environment.room.registerDataset(sourceDefinition());
    ingest(environment, V1_ROWS);
    const dashboard = createVisualDashboard(environment);
    const source = await bindAndProcess(environment, dashboard.id, dashboard.widgets[0].id);
    const existingBefore = environment.db.prepare('SELECT * FROM analytics_widgets WHERE dashboard_id = ? ORDER BY position').all(dashboard.id);

    const mutation = environment.dashboards.editDataRoomWidget({
      action: 'add_from_widget',
      dashboardId: dashboard.id,
      widgetIds: [source.id],
      presentation: { renderer: 'point', title: 'Point copy' },
    }, editIdentity(
      dashboard.id,
      [source.id],
      `Create a new point widget from ${source.id} on ${dashboard.id}.`,
    ));
    expect(mutation).toMatchObject({
      resultDisposition: 'refresh_queued',
      createdWidgetId: mutation.widget.id,
      widget: { revision: 1, bindingRevision: 1, position: 2, title: 'Point copy' },
      run: { refreshScope: 'selective', widgetCount: 1 },
    });
    expect(environment.db.prepare('SELECT * FROM analytics_widgets WHERE dashboard_id = ? AND id != ? ORDER BY position').all(dashboard.id, mutation.widget.id)).toEqual(existingBefore);
    expect(await environment.dashboards.processQueuedRuns(1)).toBe(1);
    const created = environment.dashboards.getDashboard(dashboard.id)!.widgets.find(widget => widget.id === mutation.widget.id)!;
    expect(created).toMatchObject({ id: mutation.widget.id, position: 2, result: { rows: V1_ROWS } });
    expect(created.binding).toMatchObject({ datasetId: source.binding!.datasetId, requestSha256: source.binding!.requestSha256 });
    expect(created.result?.source).toMatchObject({ provider: 'data-room', versionId: (source.result!.source as any).versionId });
    expect(environment.mcp.stats()).toEqual({ sqlCalls: [], connectionProbes: 0 });
  });

  it('creates one common-rowset composition and rejects mismatched sources without effects', async () => {
    const environment = openEnvironment();
    environment.room.registerDataset(sourceDefinition());
    ingest(environment, V1_ROWS);
    const dashboard = createVisualDashboard(environment);
    const left = await bindAndProcess(environment, dashboard.id, dashboard.widgets[0].id);
    const right = await bindAndProcess(environment, dashboard.id, dashboard.widgets[1].id);

    const combined = environment.dashboards.editDataRoomWidget({
      action: 'combine_compatible_widgets',
      dashboardId: dashboard.id,
      widgetIds: [left.id, right.id],
      presentation: { title: 'Combined view', layout: 'vconcat' },
    }, editIdentity(
      dashboard.id,
      [left.id, right.id],
      `Combine ${left.id} and ${right.id} on ${dashboard.id}.`,
    ));
    expect(combined).toMatchObject({ createdWidgetId: combined.widget.id, resultDisposition: 'refresh_queued' });
    expect((combined.widget.config.spec as any).vconcat).toHaveLength(2);
    expect((combined.widget.config.spec as any)).not.toHaveProperty('data');
    expect(await environment.dashboards.processQueuedRuns(1)).toBe(1);
    expect(environment.dashboards.getDashboard(dashboard.id)!.widgets.find(widget => widget.id === combined.widget.id)?.result?.rows).toEqual(V1_ROWS);

    const rebind = environment.dashboards.editDataRoomWidget({
      action: 'date_range',
      dashboardId: dashboard.id,
      widgetIds: [right.id],
      dateRange: { start: '2026-09-02', end: '2026-09-02' },
    });
    expect(rebind.run).toBeDefined();
    expect(await environment.dashboards.processQueuedRuns(1)).toBe(1);
    const stateBefore = {
      widgets: environment.db.prepare('SELECT * FROM analytics_widgets WHERE dashboard_id = ? ORDER BY position').all(dashboard.id),
      bindings: environment.db.prepare(`SELECT binding.* FROM analytics_widget_dataset_bindings binding JOIN analytics_widgets widget ON widget.id = binding.widget_id WHERE widget.dashboard_id = ? ORDER BY binding.widget_id`).all(dashboard.id),
      runs: environment.db.prepare('SELECT * FROM analytics_runs WHERE dashboard_id = ? ORDER BY queued_at').all(dashboard.id),
      snapshots: environment.db.prepare(`SELECT snapshot.* FROM analytics_run_widget_data_room_snapshots snapshot JOIN analytics_runs run ON run.id = snapshot.run_id WHERE run.dashboard_id = ? ORDER BY snapshot.run_id, snapshot.widget_id`).all(dashboard.id),
    };
    expect(() => environment.dashboards.editDataRoomWidget({
      action: 'combine_compatible_widgets',
      dashboardId: dashboard.id,
      widgetIds: [left.id, right.id],
      presentation: { title: 'Must not exist' },
    }, editIdentity(
      dashboard.id,
      [left.id, right.id],
      `Combine ${left.id} and ${right.id} on ${dashboard.id} as Must not exist.`,
    ))).toThrow(/do not share one exact/i);
    expect({
      widgets: environment.db.prepare('SELECT * FROM analytics_widgets WHERE dashboard_id = ? ORDER BY position').all(dashboard.id),
      bindings: environment.db.prepare(`SELECT binding.* FROM analytics_widget_dataset_bindings binding JOIN analytics_widgets widget ON widget.id = binding.widget_id WHERE widget.dashboard_id = ? ORDER BY binding.widget_id`).all(dashboard.id),
      runs: environment.db.prepare('SELECT * FROM analytics_runs WHERE dashboard_id = ? ORDER BY queued_at').all(dashboard.id),
      snapshots: environment.db.prepare(`SELECT snapshot.* FROM analytics_run_widget_data_room_snapshots snapshot JOIN analytics_runs run ON run.id = snapshot.run_id WHERE run.dashboard_id = ? ORDER BY snapshot.run_id, snapshot.widget_id`).all(dashboard.id),
    }).toEqual(stateBefore);
    expect(environment.mcp.stats()).toEqual({ sqlCalls: [], connectionProbes: 0 });
  });

  it('replays the same request and aliases the same ordinary semantic intent before the active-run gate', async () => {
    const environment = openEnvironment();
    environment.room.registerDataset(sourceDefinition());
    ingest(environment, V1_ROWS);
    const dashboard = createVisualDashboard(environment);
    const source = await bindAndProcess(environment, dashboard.id, dashboard.widgets[0].id);
    const input = {
      action: 'add_from_widget' as const,
      dashboardId: dashboard.id,
      widgetIds: [source.id],
      presentation: { renderer: 'point' as const, title: 'Durable point copy' },
    };
    const firstIdentity = {
      ownerRequestId: 'request-f2-same-0001',
      ownerMessage: `Create a new point widget from ${source.id} on ${dashboard.id}.`,
      ownerScope: { source: 'owner_exact_ids' as const, dashboardId: dashboard.id, orderedWidgetIds: [source.id] },
      explicitNew: false,
    };
    const first = environment.dashboards.editDataRoomWidget(input, firstIdentity);
    expect(first).toMatchObject({
      idempotentReplay: false, effectAppliedThisCall: true, explicitNew: false,
      intentVersion: 1, receiptId: expect.stringMatching(/^aedit_/),
      intentSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      effectSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    const effectCounts = () => ({
      widgets: (environment.db.prepare('SELECT COUNT(*) AS count FROM analytics_widgets WHERE dashboard_id = ?').get(dashboard.id) as any).count,
      bindings: (environment.db.prepare(`SELECT COUNT(*) AS count FROM analytics_widget_dataset_bindings binding JOIN analytics_widgets widget ON widget.id = binding.widget_id WHERE widget.dashboard_id = ?`).get(dashboard.id) as any).count,
      runs: (environment.db.prepare('SELECT COUNT(*) AS count FROM analytics_runs WHERE dashboard_id = ?').get(dashboard.id) as any).count,
      snapshots: (environment.db.prepare(`SELECT COUNT(*) AS count FROM analytics_run_widget_data_room_snapshots snapshot JOIN analytics_runs run ON run.id = snapshot.run_id WHERE run.dashboard_id = ?`).get(dashboard.id) as any).count,
    });
    const afterFirst = effectCounts();
    const sameRequest = environment.dashboards.editDataRoomWidget(input, firstIdentity);
    expect(sameRequest).toMatchObject({
      createdWidgetId: first.createdWidgetId, receiptId: first.receiptId,
      intentSha256: first.intentSha256, effectSha256: first.effectSha256,
      idempotentReplay: true, replayReason: 'same_request', effectAppliedThisCall: false,
      run: { id: first.run!.id, status: 'queued' },
    });
    expect(effectCounts()).toEqual(afterFirst);

    const aliasIdentity = {
      ownerRequestId: 'request-f2-alias-0002',
      ownerMessage: 'Create a new point chart from this selected widget.',
      ownerScope: { source: 'dashboard_widget_selection' as const, dashboardId: dashboard.id, orderedWidgetIds: [source.id] },
      explicitNew: false,
    };
    const semanticReplay = environment.dashboards.editDataRoomWidget(input, aliasIdentity);
    expect(semanticReplay).toMatchObject({
      createdWidgetId: first.createdWidgetId, receiptId: first.receiptId,
      idempotentReplay: true, replayReason: 'semantic_intent', effectAppliedThisCall: false,
      run: { id: first.run!.id },
    });
    expect(effectCounts()).toEqual(afterFirst);
    expect(environment.db.prepare(`
      SELECT owner_request_id, replay_of_receipt_id, created_widget_id, run_id
      FROM analytics_dashboard_edit_receipts ORDER BY created_at, id
    `).all()).toEqual(expect.arrayContaining([
      expect.objectContaining({ owner_request_id: firstIdentity.ownerRequestId, replay_of_receipt_id: null, created_widget_id: first.createdWidgetId, run_id: first.run!.id }),
      expect.objectContaining({ owner_request_id: aliasIdentity.ownerRequestId, replay_of_receipt_id: first.receiptId, created_widget_id: first.createdWidgetId, run_id: first.run!.id }),
    ]));
    expect(await environment.dashboards.processQueuedRuns(1)).toBe(1);
  });

  it('replays the exact queued effect after a storage reopen instead of creating another widget or run', async () => {
    const directory = tempDirectory();
    const first = openEnvironment({ directory });
    first.room.registerDataset(sourceDefinition());
    ingest(first, V1_ROWS);
    const dashboard = createVisualDashboard(first);
    const source = await bindAndProcess(first, dashboard.id, dashboard.widgets[0].id);
    const input = {
      action: 'add_from_widget' as const, dashboardId: dashboard.id, widgetIds: [source.id],
      presentation: { renderer: 'bar' as const, title: 'Restart-safe copy' },
    };
    const identity = {
      ownerRequestId: 'request-f2-restart-0001',
      ownerMessage: `Create a new bar widget from ${source.id} on ${dashboard.id}.`,
      ownerScope: { source: 'owner_exact_ids' as const, dashboardId: dashboard.id, orderedWidgetIds: [source.id] },
      explicitNew: false,
    };
    const created = first.dashboards.editDataRoomWidget(input, identity);
    const countsBefore = first.db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM analytics_widgets WHERE dashboard_id = ?) AS widgets,
        (SELECT COUNT(*) FROM analytics_runs WHERE dashboard_id = ?) AS runs,
        (SELECT COUNT(*) FROM analytics_dashboard_edit_receipts) AS receipts
    `).get(dashboard.id, dashboard.id);
    first.storage.close();
    storages.splice(storages.indexOf(first.storage), 1);

    const reopened = openEnvironment({ directory });
    const replayed = reopened.dashboards.editDataRoomWidget(input, identity);
    expect(replayed).toMatchObject({
      receiptId: created.receiptId, createdWidgetId: created.createdWidgetId,
      idempotentReplay: true, replayReason: 'same_request', effectAppliedThisCall: false,
      run: { id: created.run!.id, status: 'queued' },
    });
    expect(reopened.db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM analytics_widgets WHERE dashboard_id = ?) AS widgets,
        (SELECT COUNT(*) FROM analytics_runs WHERE dashboard_id = ?) AS runs,
        (SELECT COUNT(*) FROM analytics_dashboard_edit_receipts) AS receipts
    `).get(dashboard.id, dashboard.id)).toEqual(countsBefore);
    expect(await reopened.dashboards.processQueuedRuns(1)).toBe(1);
    expect(reopened.dashboards.getDashboard(dashboard.id)!.widgets.find(widget => widget.id === created.createdWidgetId)?.result?.rows).toEqual(V1_ROWS);
  });

  it('replays compatible combine intent and keeps source order presentation-significant', async () => {
    const environment = openEnvironment();
    environment.room.registerDataset(sourceDefinition());
    ingest(environment, V1_ROWS);
    const dashboard = createVisualDashboard(environment);
    const left = await bindAndProcess(environment, dashboard.id, dashboard.widgets[0].id);
    const right = await bindAndProcess(environment, dashboard.id, dashboard.widgets[1].id);
    const input = {
      action: 'combine_compatible_widgets' as const,
      dashboardId: dashboard.id,
      widgetIds: [left.id, right.id],
      presentation: { title: 'Durable combined view', layout: 'hconcat' as const },
    };
    const identity = {
      ownerRequestId: 'request-f2-combine-0001',
      ownerMessage: `Combine ${left.id} and ${right.id} on ${dashboard.id}.`,
      ownerScope: { source: 'owner_exact_ids' as const, dashboardId: dashboard.id, orderedWidgetIds: [left.id, right.id] },
      explicitNew: false,
    };
    const first = environment.dashboards.editDataRoomWidget(input, identity);
    const same = environment.dashboards.editDataRoomWidget(input, identity);
    const alias = environment.dashboards.editDataRoomWidget(input, {
      ...identity,
      ownerRequestId: 'request-f2-combine-0002',
      ownerMessage: 'Combine these two selected widgets in a horizontal view.',
      ownerScope: { source: 'dashboard_widget_selection', dashboardId: dashboard.id, orderedWidgetIds: [left.id, right.id] },
    });
    expect(same).toMatchObject({ receiptId: first.receiptId, createdWidgetId: first.createdWidgetId, replayReason: 'same_request' });
    expect(alias).toMatchObject({ receiptId: first.receiptId, createdWidgetId: first.createdWidgetId, replayReason: 'semantic_intent' });
    expect(await environment.dashboards.processQueuedRuns(1)).toBe(1);

    environment.dashboards.editDataRoomWidget({
      action: 'presentation', dashboardId: dashboard.id, widgetIds: [left.id],
      presentation: { renderer: 'area' },
    });
    const afterSourceDrift = environment.dashboards.editDataRoomWidget(input, {
      ...identity,
      ownerRequestId: 'request-f2-combine-source-drift',
      ownerMessage: 'Combine these two selected widgets in a horizontal view after the source changed.',
      ownerScope: { source: 'dashboard_widget_selection', dashboardId: dashboard.id, orderedWidgetIds: [left.id, right.id] },
    });
    expect(afterSourceDrift).toMatchObject({ idempotentReplay: false, effectAppliedThisCall: true });
    expect(afterSourceDrift.createdWidgetId).not.toBe(first.createdWidgetId);
    expect(afterSourceDrift.intentSha256).not.toBe(first.intentSha256);
    expect(await environment.dashboards.processQueuedRuns(1)).toBe(1);

    const reversedInput = { ...input, widgetIds: [right.id, left.id] };
    const reversed = environment.dashboards.editDataRoomWidget(reversedInput, {
      ownerRequestId: 'request-f2-combine-0003',
      ownerMessage: `Combine ${right.id} and ${left.id} on ${dashboard.id}.`,
      ownerScope: { source: 'owner_exact_ids', dashboardId: dashboard.id, orderedWidgetIds: [right.id, left.id] },
      explicitNew: false,
    });
    expect(reversed).toMatchObject({ idempotentReplay: false, effectAppliedThisCall: true });
    expect(reversed.createdWidgetId).not.toBe(first.createdWidgetId);
    expect(reversed.intentSha256).not.toBe(first.intentSha256);
    expect(await environment.dashboards.processQueuedRuns(1)).toBe(1);
  });

  it('rejects completed replay when only the nested semantic execution receipt drifts', async () => {
    const environment = openEnvironment();
    environment.room.registerDataset(sourceDefinition());
    ingest(environment, V1_ROWS);
    const dashboard = createVisualDashboard(environment);
    const source = await bindAndProcess(environment, dashboard.id, dashboard.widgets[0].id);
    const input = {
      action: 'add_from_widget' as const, dashboardId: dashboard.id, widgetIds: [source.id],
      presentation: { title: 'Semantic receipt guard' },
    };
    const identity = {
      ownerRequestId: 'request-f2-semantic-guard', ownerMessage: 'Create a new chart from this selected widget.',
      ownerScope: { source: 'dashboard_widget_selection' as const, dashboardId: dashboard.id, orderedWidgetIds: [source.id] }, explicitNew: false,
    };
    const created = environment.dashboards.editDataRoomWidget(input, identity);
    expect(await environment.dashboards.processQueuedRuns(1)).toBe(1);
    const persisted = environment.db.prepare('SELECT result_json FROM analytics_widgets WHERE id = ?')
      .get(created.createdWidgetId) as { result_json: string };
    const tampered = JSON.parse(persisted.result_json);
    tampered.source.semanticReceipt = {
      ...tampered.source.semanticReceipt,
      limitations: ['tampered semantic receipt'],
    };
    environment.db.prepare('UPDATE analytics_widgets SET result_json = ? WHERE id = ?')
      .run(JSON.stringify(tampered), created.createdWidgetId);
    const before = environment.db.prepare(`
      SELECT (SELECT COUNT(*) FROM analytics_widgets WHERE dashboard_id = ?) AS widgets,
        (SELECT COUNT(*) FROM analytics_runs WHERE dashboard_id = ?) AS runs,
        (SELECT COUNT(*) FROM analytics_dashboard_edit_receipts) AS receipts
    `).get(dashboard.id, dashboard.id);
    expect(() => environment.dashboards.editDataRoomWidget(input, identity)).toThrow(/target widget drifted/i);
    expect(environment.db.prepare(`
      SELECT (SELECT COUNT(*) FROM analytics_widgets WHERE dashboard_id = ?) AS widgets,
        (SELECT COUNT(*) FROM analytics_runs WHERE dashboard_id = ?) AS runs,
        (SELECT COUNT(*) FROM analytics_dashboard_edit_receipts) AS receipts
    `).get(dashboard.id, dashboard.id)).toEqual(before);
  });

  it('keeps same-request history but prevents fresh semantic reuse after source or target drift', async () => {
    const environment = openEnvironment();
    environment.room.registerDataset(sourceDefinition());
    ingest(environment, V1_ROWS);
    const dashboard = createVisualDashboard(environment);
    const source = await bindAndProcess(environment, dashboard.id, dashboard.widgets[0].id);
    const input = {
      action: 'add_from_widget' as const, dashboardId: dashboard.id, widgetIds: [source.id],
      presentation: { title: 'Source-aware copy' },
    };
    const identity = {
      ownerRequestId: 'request-f2-source-seed-0001', ownerMessage: 'Create a new chart from this selected widget.',
      ownerScope: { source: 'dashboard_widget_selection' as const, dashboardId: dashboard.id, orderedWidgetIds: [source.id] }, explicitNew: false,
    };
    const first = environment.dashboards.editDataRoomWidget(input, identity);
    expect(await environment.dashboards.processQueuedRuns(1)).toBe(1);
    environment.dashboards.editDataRoomWidget({
      action: 'presentation', dashboardId: dashboard.id, widgetIds: [source.id],
      presentation: { renderer: 'area' },
    });

    const sameRequest = environment.dashboards.editDataRoomWidget(input, identity);
    expect(sameRequest).toMatchObject({ receiptId: first.receiptId, replayReason: 'same_request' });
    const freshAfterSourceDrift = environment.dashboards.editDataRoomWidget(input, {
      ...identity, ownerRequestId: 'request-f2-source-seed-0002',
      ownerMessage: 'Create a new visualization from this selected widget.',
    });
    expect(freshAfterSourceDrift).toMatchObject({ idempotentReplay: false, effectAppliedThisCall: true });
    expect(freshAfterSourceDrift.createdWidgetId).not.toBe(first.createdWidgetId);
    expect(freshAfterSourceDrift.intentSha256).not.toBe(first.intentSha256);
    expect(await environment.dashboards.processQueuedRuns(1)).toBe(1);

    environment.dashboards.editDataRoomWidget({
      action: 'presentation', dashboardId: dashboard.id, widgetIds: [first.createdWidgetId!],
      presentation: { title: 'Owner changed this created view' },
    });
    const effectCounts = environment.db.prepare(`
      SELECT (SELECT COUNT(*) FROM analytics_widgets WHERE dashboard_id = ?) AS widgets,
        (SELECT COUNT(*) FROM analytics_runs WHERE dashboard_id = ?) AS runs,
        (SELECT COUNT(*) FROM analytics_dashboard_edit_receipts) AS receipts
    `).get(dashboard.id, dashboard.id);
    expect(() => environment.dashboards.editDataRoomWidget(input, identity)).toThrow(/target widget drifted/i);
    expect(environment.db.prepare(`
      SELECT (SELECT COUNT(*) FROM analytics_widgets WHERE dashboard_id = ?) AS widgets,
        (SELECT COUNT(*) FROM analytics_runs WHERE dashboard_id = ?) AS runs,
        (SELECT COUNT(*) FROM analytics_dashboard_edit_receipts) AS receipts
    `).get(dashboard.id, dashboard.id)).toEqual(effectCounts);
  });

  it('creates distinct explicit-new effects while ordinary intent keeps replaying its canonical effect', async () => {
    const environment = openEnvironment();
    environment.room.registerDataset(sourceDefinition());
    ingest(environment, V1_ROWS);
    const dashboard = createVisualDashboard(environment);
    const source = await bindAndProcess(environment, dashboard.id, dashboard.widgets[0].id);
    const input = {
      action: 'add_from_widget' as const, dashboardId: dashboard.id, widgetIds: [source.id],
      presentation: { renderer: 'point' as const, title: 'Repeatable point copy' },
    };
    const ordinaryIdentity = {
      ownerRequestId: 'request-f2-ordinary-0001', ownerMessage: 'Create a new point chart from this selected widget.',
      ownerScope: { source: 'dashboard_widget_selection' as const, dashboardId: dashboard.id, orderedWidgetIds: [source.id] }, explicitNew: false,
    };
    const ordinary = environment.dashboards.editDataRoomWidget(input, ordinaryIdentity);
    expect(await environment.dashboards.processQueuedRuns(1)).toBe(1);

    const explicitOneIdentity = { ...ordinaryIdentity, ownerRequestId: 'request-f2-explicit-0002', ownerMessage: 'Create another new point chart from this selected widget.', explicitNew: true };
    const explicitOne = environment.dashboards.editDataRoomWidget(input, explicitOneIdentity);
    expect(explicitOne).toMatchObject({ explicitNew: true, idempotentReplay: false, effectAppliedThisCall: true });
    expect(explicitOne.createdWidgetId).not.toBe(ordinary.createdWidgetId);
    const explicitReplay = environment.dashboards.editDataRoomWidget(input, explicitOneIdentity);
    expect(explicitReplay).toMatchObject({ createdWidgetId: explicitOne.createdWidgetId, receiptId: explicitOne.receiptId, replayReason: 'same_request' });
    expect(await environment.dashboards.processQueuedRuns(1)).toBe(1);

    const explicitTwo = environment.dashboards.editDataRoomWidget(input, {
      ...explicitOneIdentity, ownerRequestId: 'request-f2-explicit-0003', ownerMessage: 'Duplicate this selected widget as a new point chart.',
    });
    expect(explicitTwo.createdWidgetId).not.toBe(explicitOne.createdWidgetId);
    expect(await environment.dashboards.processQueuedRuns(1)).toBe(1);

    const ordinaryReplay = environment.dashboards.editDataRoomWidget(input, {
      ...ordinaryIdentity, ownerRequestId: 'request-f2-ordinary-0004', ownerMessage: 'Create a new point visualization from this selected widget.',
    });
    expect(ordinaryReplay).toMatchObject({
      createdWidgetId: ordinary.createdWidgetId, receiptId: ordinary.receiptId,
      idempotentReplay: true, replayReason: 'semantic_intent', effectAppliedThisCall: false,
    });
    expect(environment.db.prepare(`
      SELECT SUM(CASE WHEN replay_of_receipt_id IS NULL THEN 1 ELSE 0 END) AS canonical,
        SUM(CASE WHEN replay_of_receipt_id IS NOT NULL THEN 1 ELSE 0 END) AS aliases
      FROM analytics_dashboard_edit_receipts
    `).get()).toEqual({ canonical: 3, aliases: 1 });
  });

  it('binds a request ID permanently and refuses corrupt replay targets without replacement effects', async () => {
    const environment = openEnvironment();
    environment.room.registerDataset(sourceDefinition());
    ingest(environment, V1_ROWS);
    const dashboard = createVisualDashboard(environment);
    const source = await bindAndProcess(environment, dashboard.id, dashboard.widgets[0].id);
    const input = {
      action: 'add_from_widget' as const, dashboardId: dashboard.id, widgetIds: [source.id],
      presentation: { renderer: 'point' as const, title: 'Conflict copy' },
    };
    const identity = {
      ownerRequestId: 'request-f2-conflict-0001', ownerMessage: 'Create a new point chart from this selected widget.',
      ownerScope: { source: 'dashboard_widget_selection' as const, dashboardId: dashboard.id, orderedWidgetIds: [source.id] }, explicitNew: false,
    };
    const created = environment.dashboards.editDataRoomWidget(input, identity);
    const counts = () => environment.db.prepare(`
      SELECT (SELECT COUNT(*) FROM analytics_widgets WHERE dashboard_id = ?) AS widgets,
        (SELECT COUNT(*) FROM analytics_runs WHERE dashboard_id = ?) AS runs,
        (SELECT COUNT(*) FROM analytics_dashboard_edit_receipts) AS receipts
    `).get(dashboard.id, dashboard.id);
    const beforeConflict = counts();
    expect(() => environment.dashboards.editDataRoomWidget(input, {
      ...identity, ownerMessage: 'Create a renamed point chart from this selected widget.',
    })).toThrow(/already bound to a different edit identity/i);
    expect(counts()).toEqual(beforeConflict);

    environment.db.prepare(`
      DELETE FROM analytics_run_widget_data_room_snapshots WHERE run_id = ? AND widget_id = ?
    `).run(created.run!.id, created.createdWidgetId!);
    const beforeCorruptReplay = counts();
    expect(() => environment.dashboards.editDataRoomWidget(input, identity)).toThrow(/exact widget\/run\/snapshot target/i);
    expect(counts()).toEqual(beforeCorruptReplay);
  });

  it('rolls back widget, binding, run, snapshot, and dashboard state when receipt persistence aborts', async () => {
    const environment = openEnvironment();
    environment.room.registerDataset(sourceDefinition());
    ingest(environment, V1_ROWS);
    const dashboard = createVisualDashboard(environment);
    const source = await bindAndProcess(environment, dashboard.id, dashboard.widgets[0].id);
    const before = {
      dashboard: environment.db.prepare('SELECT * FROM analytics_dashboards WHERE id = ?').get(dashboard.id),
      widgets: environment.db.prepare('SELECT * FROM analytics_widgets WHERE dashboard_id = ? ORDER BY position').all(dashboard.id),
      bindings: environment.db.prepare(`SELECT binding.* FROM analytics_widget_dataset_bindings binding JOIN analytics_widgets widget ON widget.id = binding.widget_id WHERE widget.dashboard_id = ? ORDER BY binding.widget_id`).all(dashboard.id),
      runs: environment.db.prepare('SELECT * FROM analytics_runs WHERE dashboard_id = ? ORDER BY queued_at').all(dashboard.id),
      snapshots: environment.db.prepare(`SELECT snapshot.* FROM analytics_run_widget_data_room_snapshots snapshot JOIN analytics_runs run ON run.id = snapshot.run_id WHERE run.dashboard_id = ? ORDER BY snapshot.run_id`).all(dashboard.id),
    };
    environment.db.exec(`
      CREATE TRIGGER abort_f2_receipt BEFORE INSERT ON analytics_dashboard_edit_receipts
      BEGIN SELECT RAISE(ABORT, 'synthetic receipt abort'); END;
    `);
    expect(() => environment.dashboards.editDataRoomWidget({
      action: 'add_from_widget', dashboardId: dashboard.id, widgetIds: [source.id],
      presentation: { renderer: 'point', title: 'Must roll back' },
    }, {
      ownerRequestId: 'request-f2-abort-0001', ownerMessage: 'Create a new point chart from this selected widget.',
      ownerScope: { source: 'dashboard_widget_selection', dashboardId: dashboard.id, orderedWidgetIds: [source.id] }, explicitNew: false,
    })).toThrow(/synthetic receipt abort/i);
    environment.db.exec('DROP TRIGGER abort_f2_receipt');
    expect({
      dashboard: environment.db.prepare('SELECT * FROM analytics_dashboards WHERE id = ?').get(dashboard.id),
      widgets: environment.db.prepare('SELECT * FROM analytics_widgets WHERE dashboard_id = ? ORDER BY position').all(dashboard.id),
      bindings: environment.db.prepare(`SELECT binding.* FROM analytics_widget_dataset_bindings binding JOIN analytics_widgets widget ON widget.id = binding.widget_id WHERE widget.dashboard_id = ? ORDER BY binding.widget_id`).all(dashboard.id),
      runs: environment.db.prepare('SELECT * FROM analytics_runs WHERE dashboard_id = ? ORDER BY queued_at').all(dashboard.id),
      snapshots: environment.db.prepare(`SELECT snapshot.* FROM analytics_run_widget_data_room_snapshots snapshot JOIN analytics_runs run ON run.id = snapshot.run_id WHERE run.dashboard_id = ? ORDER BY snapshot.run_id`).all(dashboard.id),
    }).toEqual(before);
    expect(environment.db.prepare('SELECT COUNT(*) AS count FROM analytics_dashboard_edit_receipts').get()).toEqual({ count: 0 });
  });

  it('rejects unknown fields and active-run edits before effects', async () => {
    const environment = openEnvironment();
    environment.room.registerDataset(sourceDefinition());
    ingest(environment, V1_ROWS);
    const dashboard = createVisualDashboard(environment);
    const source = await bindAndProcess(environment, dashboard.id, dashboard.widgets[0].id);
    expect(() => environment.dashboards.editDataRoomWidget({
      action: 'presentation', dashboardId: dashboard.id, widgetIds: [source.id],
      presentation: { title: 'Nope' }, sql: 'SELECT 1',
    } as any)).toThrow(/unsupported fields/i);
    const active = environment.dashboards.enqueueSelectiveRefresh(dashboard.id, [source.id]);
    const widgetBefore = environment.db.prepare('SELECT * FROM analytics_widgets WHERE id = ?').get(source.id);
    expect(() => environment.dashboards.editDataRoomWidget({
      action: 'presentation', dashboardId: dashboard.id, widgetIds: [source.id], presentation: { title: 'Still nope' },
    })).toThrow(new RegExp(active.id));
    expect(environment.db.prepare('SELECT * FROM analytics_widgets WHERE id = ?').get(source.id)).toEqual(widgetBefore);
    expect(environment.mcp.stats()).toEqual({ sqlCalls: [], connectionProbes: 0 });
  });
});

describe('analytics dashboard R5 typed controls', () => {
  function expectedControls(widget: any) {
    const controls = widget.controls!;
    return {
      widgetRevision: widget.revision,
      bindingRevision: widget.binding!.revision,
      controlRevision: controls.controlRevision,
      controlValuesSha256: controls.currentValuesSha256,
      controlDefinitionSha256: controls.definitionSha256,
      datasetDefinitionRevision: controls.definition.datasetDefinitionRevision,
      datasetDefinitionSha256: controls.definition.datasetDefinitionSha256,
      contractSha256: controls.definition.contractSha256,
    };
  }

  async function boundControlFixture() {
    const environment = openEnvironment();
    environment.room.registerDataset(sourceDefinition());
    ingest(environment, V1_ROWS);
    const dashboard = createTwoWidgetDashboard(environment, 'R5 controls');
    const target = dashboard.widgets[0];
    const sibling = dashboard.widgets[1];
    const mutation = environment.dashboards.updateWidgetBinding(dashboard.id, target.id, {
      expectedRevision: 0,
      binding: { ...binding(environment), presentationLimit: 2 },
    });
    expect(mutation).toMatchObject({ outcome: 'queued', run: { refreshScope: 'selective', widgetCount: 1 } });
    expect(await environment.dashboards.processQueuedRuns(1)).toBe(1);
    return { environment, dashboardId: dashboard.id, targetId: target.id, siblingId: sibling.id };
  }

  it('preserves non-editable binding filters as fixed semantics outside controls', async () => {
    const environment = openEnvironment();
    environment.room.registerDataset(sourceDefinition());
    ingest(environment, V1_ROWS);
    const dashboard = createTwoWidgetDashboard(environment, 'R5 fixed binding filters');
    const targetId = dashboard.widgets[0].id;
    const baseBinding = binding(environment);
    const timeFilter = { field: 'event_date', operator: 'gte' as const, value: '2026-09-02' };
    const stringRangeFilter = { field: 'region', operator: 'gte' as const, value: 'US' };
    const mutation = environment.dashboards.updateWidgetBinding(dashboard.id, targetId, {
      expectedRevision: 0,
      binding: {
        ...baseBinding,
        request: { ...baseBinding.request, filters: [timeFilter, stringRangeFilter] },
      },
    });
    expect(mutation.widget.controls).toMatchObject({
      controlRevision: 1,
      currentValues: { filters: [] },
    });
    expect(mutation.widget.controls!.effectiveViewRequest.request.filters).toHaveLength(2);
    expect(mutation.widget.controls!.effectiveViewRequest.request.filters)
      .toEqual(expect.arrayContaining([timeFilter, stringRangeFilter]));
    expect(await environment.dashboards.processQueuedRuns(1)).toBe(1);
    const bound = environment.dashboards.getDashboard(dashboard.id)!.widgets.find(widget => widget.id === targetId)!;
    expect(bound.result?.rows).toEqual([['2026-09-02', 'US', 40]]);

    const regionFilter = { field: 'region', operator: 'eq' as const, value: 'US' };
    const applied = environment.dashboards.applyWidgetControls(dashboard.id, targetId, {
      expected: expectedControls(bound),
      controls: { ...bound.controls!.currentValues, filters: [regionFilter] },
    });
    expect(applied.controls.currentValues.filters).toEqual([regionFilter]);
    expect(applied.controls.effectiveViewRequest.request.filters).toHaveLength(3);
    expect(applied.controls.effectiveViewRequest.request.filters)
      .toEqual(expect.arrayContaining([timeFilter, stringRangeFilter, regionFilter]));
    expect(await environment.dashboards.processQueuedRuns(1)).toBe(1);
    expect(environment.dashboards.getDashboard(dashboard.id)!.widgets.find(widget => widget.id === targetId)?.result?.rows)
      .toEqual([['2026-09-02', 'US', 40]]);
    expect(environment.mcp.stats()).toEqual({ sqlCalls: [], connectionProbes: 0 });
  });

  it('applies typed date/filter/sort through one local selected snapshot, then no-ops exact repeats and rejects stale CAS', async () => {
    const { environment, dashboardId, targetId, siblingId } = await boundControlFixture();
    const before = environment.dashboards.getDashboard(dashboardId)!;
    const targetBefore = before.widgets.find(widget => widget.id === targetId)!;
    const siblingBefore = environment.db.prepare('SELECT * FROM analytics_widgets WHERE id = ?').get(siblingId);
    const bindingBefore = environment.db.prepare('SELECT * FROM analytics_widget_dataset_bindings WHERE widget_id = ?').get(targetId);
    const resultBefore = structuredClone(targetBefore.result);
    expect(targetBefore.controls).toMatchObject({ controlRevision: 1, projected: false });
    const runsBefore = Number((environment.db.prepare('SELECT COUNT(*) AS count FROM analytics_runs').get() as any).count);
    const snapshotsBefore = Number((environment.db.prepare('SELECT COUNT(*) AS count FROM analytics_run_widget_data_room_snapshots').get() as any).count);
    const roomRevisionBefore = Number((environment.db.prepare('SELECT revision FROM analytics_data_room_state WHERE singleton = 1').get() as any).revision);
    const values = {
      version: 1 as const,
      dateRange: { start: '2026-09-02', end: '2026-09-02' },
      filters: [{ field: 'region', operator: 'in' as const, value: ['IN', 'US'] }],
      sort: { field: 'events', direction: 'desc' as const },
    };

    const applied = environment.dashboards.applyWidgetControls(dashboardId, targetId, {
      expected: expectedControls(targetBefore),
      controls: values,
    });
    expect(applied).toMatchObject({
      outcome: 'queued',
      controls: { controlRevision: 2, currentValues: values },
      run: { refreshScope: 'selective', widgetCount: 1 },
      widget: { id: targetId, revision: 1, bindingRevision: 1 },
    });
    expect(applied.widget.result).toEqual(resultBefore);
    expect(environment.db.prepare('SELECT * FROM analytics_widget_dataset_bindings WHERE widget_id = ?').get(targetId)).toEqual(bindingBefore);
    expect(environment.db.prepare('SELECT * FROM analytics_widgets WHERE id = ?').get(siblingId)).toEqual(siblingBefore);
    const snapshot = environment.db.prepare(`
      SELECT control_revision, control_definition_sha256, control_values_sha256,
        effective_view_request_sha256, compiler_version, request_sha256
      FROM analytics_run_widget_data_room_snapshots WHERE run_id = ? AND widget_id = ?
    `).get(applied.run!.id, targetId) as any;
    expect(snapshot).toMatchObject({
      control_revision: 2,
      control_definition_sha256: applied.controls.definitionSha256,
      control_values_sha256: applied.controls.currentValuesSha256,
      effective_view_request_sha256: applied.controls.effectiveViewRequestSha256,
      compiler_version: 'sqlite-dashboard-view-v1',
    });
    expect(snapshot.request_sha256).toBe((applied.run && applied.controls.effectiveViewRequest.request) ? analyticsRequestSha256(applied.controls.effectiveViewRequest.request) : '');
    expect(await environment.dashboards.processQueuedRuns(1)).toBe(1);
    const completed = environment.dashboards.getDashboard(dashboardId)!.widgets.find(widget => widget.id === targetId)!;
    expect(completed.result).toMatchObject({
      rows: [['2026-09-02', 'US', 40], ['2026-09-02', 'IN', 30]],
      rowCount: 2,
      displayedRowCount: 2,
      source: {
        provider: 'data-room', bindingRevision: 1, widgetRevision: 1, controlRevision: 2,
        controlDefinitionSha256: completed.controls!.definitionSha256,
        controlValuesSha256: completed.controls!.currentValuesSha256,
        effectiveViewRequestSha256: completed.controls!.effectiveViewRequestSha256,
      },
    });
    expect(environment.db.prepare('SELECT * FROM analytics_widgets WHERE id = ?').get(siblingId)).toEqual(siblingBefore);
    expect(environment.mcp.stats()).toEqual({ sqlCalls: [], connectionProbes: 0 });

    const noOpRuns = Number((environment.db.prepare('SELECT COUNT(*) AS count FROM analytics_runs').get() as any).count);
    const noOp = environment.dashboards.applyWidgetControls(dashboardId, targetId, {
      expected: expectedControls(completed), controls: values,
    });
    expect(noOp).toMatchObject({ outcome: 'no_op', controls: { controlRevision: 2 } });
    expect(noOp.run).toBeUndefined();
    expect(Number((environment.db.prepare('SELECT COUNT(*) AS count FROM analytics_runs').get() as any).count)).toBe(noOpRuns);

    const beforeStale = {
      controls: environment.db.prepare('SELECT * FROM analytics_dataset_controls WHERE widget_id = ?').get(targetId),
      runs: Number((environment.db.prepare('SELECT COUNT(*) AS count FROM analytics_runs').get() as any).count),
      snapshots: Number((environment.db.prepare('SELECT COUNT(*) AS count FROM analytics_run_widget_data_room_snapshots').get() as any).count),
    };
    expect(() => environment.dashboards.applyWidgetControls(dashboardId, targetId, {
      expected: { ...expectedControls(completed), controlRevision: 1 },
      controls: { ...values, sort: { field: 'events', direction: 'asc' } },
    })).toThrow(/changed before Apply/i);
    expect({
      controls: environment.db.prepare('SELECT * FROM analytics_dataset_controls WHERE widget_id = ?').get(targetId),
      runs: Number((environment.db.prepare('SELECT COUNT(*) AS count FROM analytics_runs').get() as any).count),
      snapshots: Number((environment.db.prepare('SELECT COUNT(*) AS count FROM analytics_run_widget_data_room_snapshots').get() as any).count),
    }).toEqual(beforeStale);
    expect(Number((environment.db.prepare('SELECT revision FROM analytics_data_room_state WHERE singleton = 1').get() as any).revision)).toBe(roomRevisionBefore + 1);
    expect(runsBefore + 1).toBe(noOpRuns);
    expect(snapshotsBefore + 1).toBe(Number((environment.db.prepare('SELECT COUNT(*) AS count FROM analytics_run_widget_data_room_snapshots').get() as any).count));
  });

  it('unbinds without a run, deletes controls, clears the local result, and never falls into legacy SQL', async () => {
    const { environment, dashboardId, targetId } = await boundControlFixture();
    const before = environment.dashboards.getDashboard(dashboardId)!.widgets.find(widget => widget.id === targetId)!;
    const counts = {
      runs: Number((environment.db.prepare('SELECT COUNT(*) AS count FROM analytics_runs').get() as any).count),
      snapshots: Number((environment.db.prepare('SELECT COUNT(*) AS count FROM analytics_run_widget_data_room_snapshots').get() as any).count),
    };
    const removed = environment.dashboards.updateWidgetBinding(dashboardId, targetId, {
      expectedRevision: before.binding!.revision,
      binding: null,
    });
    expect(removed).toMatchObject({ outcome: 'cleared', bindingRevision: 2, widget: { id: targetId, bindingRevision: 2 } });
    expect(removed.run).toBeUndefined();
    expect(removed.widget.binding).toBeUndefined();
    expect(removed.widget.controls).toBeUndefined();
    expect(removed.widget.result).toBeUndefined();
    expect(removed.widget.lastRefreshedAt).toBeUndefined();
    expect(environment.db.prepare('SELECT COUNT(*) AS count FROM analytics_dataset_controls WHERE widget_id = ?').get(targetId)).toEqual({ count: 0 });
    expect({
      runs: Number((environment.db.prepare('SELECT COUNT(*) AS count FROM analytics_runs').get() as any).count),
      snapshots: Number((environment.db.prepare('SELECT COUNT(*) AS count FROM analytics_run_widget_data_room_snapshots').get() as any).count),
    }).toEqual(counts);
    expect(environment.mcp.stats()).toEqual({ sqlCalls: [], connectionProbes: 0 });
  });

  it('projects legacy bindings at revision zero and rolls back controls, room revision, run, and snapshot on an injected failure', async () => {
    const { environment, dashboardId, targetId } = await boundControlFixture();
    environment.db.prepare('DELETE FROM analytics_dataset_controls WHERE widget_id = ?').run(targetId);
    const legacy = environment.dashboards.getWidgetControls(dashboardId, targetId);
    expect(legacy).toMatchObject({ controlRevision: 0, projected: true });
    const widget = environment.dashboards.getDashboard(dashboardId)!.widgets.find(item => item.id === targetId)!;
    const before = {
      controls: environment.db.prepare('SELECT COUNT(*) AS count FROM analytics_dataset_controls').get(),
      room: environment.db.prepare('SELECT * FROM analytics_data_room_state').get(),
      runs: environment.db.prepare('SELECT COUNT(*) AS count FROM analytics_runs').get(),
      snapshots: environment.db.prepare('SELECT COUNT(*) AS count FROM analytics_run_widget_data_room_snapshots').get(),
      dashboard: environment.db.prepare('SELECT * FROM analytics_dashboards WHERE id = ?').get(dashboardId),
    };
    environment.db.exec(`
      CREATE TRIGGER abort_r5_control_snapshot
      BEFORE INSERT ON analytics_run_widget_data_room_snapshots
      WHEN NEW.control_revision IS NOT NULL
      BEGIN SELECT RAISE(ABORT, 'synthetic control snapshot abort'); END;
    `);
    expect(() => environment.dashboards.applyWidgetControls(dashboardId, targetId, {
      expected: expectedControls({ ...widget, controls: legacy }),
      controls: { ...legacy.currentValues, sort: { field: 'events', direction: 'desc' } },
    })).toThrow(/synthetic control snapshot abort/i);
    environment.db.exec('DROP TRIGGER abort_r5_control_snapshot');
    expect({
      controls: environment.db.prepare('SELECT COUNT(*) AS count FROM analytics_dataset_controls').get(),
      room: environment.db.prepare('SELECT * FROM analytics_data_room_state').get(),
      runs: environment.db.prepare('SELECT COUNT(*) AS count FROM analytics_runs').get(),
      snapshots: environment.db.prepare('SELECT COUNT(*) AS count FROM analytics_run_widget_data_room_snapshots').get(),
      dashboard: environment.db.prepare('SELECT * FROM analytics_dashboards WHERE id = ?').get(dashboardId),
    }).toEqual(before);
  });

  it('replaces controls at revision one on rebind and invalidates the prior binding/control CAS', async () => {
    const { environment, dashboardId, targetId } = await boundControlFixture();
    const before = environment.dashboards.getDashboard(dashboardId)!.widgets.find(widget => widget.id === targetId)!;
    const staleExpected = expectedControls(before);
    const rebound = environment.dashboards.updateWidgetBinding(dashboardId, targetId, {
      expectedRevision: before.binding!.revision,
      binding: { ...binding(environment), presentationLimit: 3 },
    });
    expect(rebound).toMatchObject({
      outcome: 'queued', bindingRevision: 2,
      widget: { bindingRevision: 2, controls: { controlRevision: 1, projected: false, definition: { limits: { maxResultRows: 3 } } } },
    });
    expect(await environment.dashboards.processQueuedRuns(1)).toBe(1);
    expect(() => environment.dashboards.applyWidgetControls(dashboardId, targetId, {
      expected: staleExpected,
      controls: before.controls!.currentValues,
    })).toThrow(/changed before Apply/i);
    expect(environment.mcp.stats()).toEqual({ sqlCalls: [], connectionProbes: 0 });
  });

  it('rejects tampered controlled snapshot identity before local apply and preserves the last good result', async () => {
    const { environment, dashboardId, targetId } = await boundControlFixture();
    const before = environment.dashboards.getDashboard(dashboardId)!.widgets.find(widget => widget.id === targetId)!;
    const mutation = environment.dashboards.applyWidgetControls(dashboardId, targetId, {
      expected: expectedControls(before),
      controls: { ...before.controls!.currentValues, sort: { field: 'events', direction: 'desc' } },
    });
    environment.db.prepare(`
      UPDATE analytics_run_widget_data_room_snapshots
      SET control_values_sha256 = ? WHERE run_id = ? AND widget_id = ?
    `).run('f'.repeat(64), mutation.run!.id, targetId);
    expect(await environment.dashboards.processQueuedRuns(1)).toBe(1);
    const after = environment.dashboards.getDashboard(dashboardId)!.widgets.find(widget => widget.id === targetId)!;
    expect(after.result).toEqual(before.result);
    expect(environment.dashboards.getRun(mutation.run!.id)).toMatchObject({ status: 'failed', widgetsSucceeded: 0 });
    expect(environment.db.prepare(`
      SELECT applied_at FROM analytics_run_widget_data_room_snapshots WHERE run_id = ? AND widget_id = ?
    `).get(mutation.run!.id, targetId)).toEqual({ applied_at: null });
    expect(environment.mcp.stats()).toEqual({ sqlCalls: [], connectionProbes: 0 });
  });
});


describe('analytics dashboard publication verifier', () => {
  async function publicationBridgeFixture(allowPublication = true) {
    const environment = openEnvironment();
    environment.room.registerDataset(sourceDefinition('ds_r4_events', 'workspace', allowPublication));
    ingest(environment, V1_ROWS);
    const dashboard = createTwoWidgetDashboard(environment, 'Publication verifier');
    const targetId = dashboard.widgets[0].id;
    environment.dashboards.updateWidgetBinding(dashboard.id, targetId, {
      expectedRevision: 0,
      binding: binding(environment),
    });
    expect(await environment.dashboards.processQueuedRuns(1)).toBe(1);
    const widget = environment.dashboards.getDashboard(dashboard.id)!.widgets.find(value => value.id === targetId)!;
    expect(widget.result?.trust).toBe('local_verified_data');
    return { environment, dashboardId: dashboard.id, targetId, widget };
  }

  function capturedError(work: () => unknown): AnalyticsDashboardDataRoomError {
    let failure: unknown;
    try { work(); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(AnalyticsDashboardDataRoomError);
    return failure as AnalyticsDashboardDataRoomError;
  }

  it('returns the exact current binding/control/head/version/query and semantic identities', async () => {
    const { environment, targetId, widget } = await publicationBridgeFixture(true);
    const identity = environment.bridge.validatePublicationResult(targetId, widget.result!);
    const head = environment.store.getHead('ds_r4_events')!;
    expect(identity).toMatchObject({
      datasetId: 'ds_r4_events',
      datasetDefinitionRevision: 1,
      bindingRevision: 1,
      versionPolicy: 'latest_compatible',
      lastAppliedVersionId: head.versionId,
      versionId: head.versionId,
      head: { versionId: head.versionId, headRevision: head.headRevision, definitionRevision: 1 },
      control: { revision: 1, projected: false },
      compilerVersion: 'sqlite-dashboard-view-v1',
      contentSha256: widget.result!.source!.contentSha256,
      schemaSha256: widget.result!.source!.schemaSha256,
      contractSha256: widget.result!.source!.contractSha256,
      definitionSha256: widget.result!.source!.definitionSha256,
    });
    for (const value of [
      identity.bindingSha256,
      identity.control.definitionSha256,
      identity.control.valuesSha256,
      identity.control.effectiveViewRequestSha256,
      identity.requestSha256,
      identity.querySha256,
      identity.semanticReceiptSha256,
    ]) expect(value).toMatch(/^[a-f0-9]{64}$/);
  });

  it('publishes a version whose dataset handling says allowPublication=false (owner directive 2026-10-10)', async () => {
    const { environment, targetId, widget } = await publicationBridgeFixture(false);
    expect(environment.bridge.validatePublicationResult(targetId, widget.result!)).toMatchObject({ versionId: expect.any(String) });
  });

  it.each([
    {
      name: 'binding revision',
      mutate: (result: any) => { result.source.bindingRevision += 1; },
      message: /result identity differs/i,
    },
    {
      name: 'query identity',
      mutate: (result: any) => { result.source.querySha256 = 'f'.repeat(64); },
      message: /result identity differs/i,
    },
    {
      name: 'control identity',
      mutate: (result: any) => { result.source.controlValuesSha256 = 'f'.repeat(64); },
      message: /control identity differs/i,
    },
    {
      name: 'semantic receipt',
      mutate: (result: any) => { result.source.semanticReceipt = { ...result.source.semanticReceipt, limitations: ['tampered'] }; },
      message: /semantic receipt/i,
    },
  ])('rejects $name drift against the applied snapshot', async ({ mutate, message }) => {
    const { environment, targetId, widget } = await publicationBridgeFixture(true);
    const changed = structuredClone(widget.result!);
    mutate(changed);
    const failure = capturedError(() => environment.bridge.validatePublicationResult(targetId, changed));
    expect(failure.code).toBe('conflict');
    expect(failure.message).toMatch(message);
  });

  it('rejects a result after the current compatible head advances', async () => {
    const { environment, targetId, widget } = await publicationBridgeFixture(true);
    ingest(environment, [...V1_ROWS.slice(0, 3), ['2026-09-02', 'US', 41]], 1);
    const failure = capturedError(() => environment.bridge.validatePublicationResult(targetId, widget.result!));
    expect(failure.code).toBe('conflict');
    expect(failure.message).toMatch(/result identity differs|publication-ready/i);
  });
});

// Owner directive 2026-09-28: dashboard create/update read Data Room datasets
// directly. One call pins each widget to the dataset's ready head and loads it
// locally; no placeholder SQL, binding, lane, or per-widget configure step.
describe('analytics dashboard direct Data Room widget sources', () => {
  const DAILY_SQL = 'SELECT event_date, SUM(events) AS events FROM source.data GROUP BY event_date ORDER BY event_date';
  const DAILY_ROWS = [['2026-09-01', 30], ['2026-09-02', 70]];
  const roomSource = (overrides: Record<string, unknown> = {}) => ({
    kind: 'data_room_query', datasetId: 'ds_r4_events', sql: DAILY_SQL, ...overrides,
  });

  function readyEnvironment(handling: Partial<AnalyticsDatasetContract['handling']> = {}) {
    const environment = openEnvironment();
    const definition = sourceDefinition();
    environment.room.registerDataset({
      ...definition,
      contract: withSha({ ...definition.contract, handling: { ...definition.contract.handling, ...handling } }),
    });
    ingest(environment, V1_ROWS);
    return environment;
  }

  function counts(environment: ReturnType<typeof openEnvironment>) {
    return environment.db.prepare(`
      SELECT (SELECT COUNT(*) FROM analytics_dashboards) AS dashboards,
        (SELECT COUNT(*) FROM analytics_widgets) AS widgets,
        (SELECT COUNT(*) FROM analytics_runs) AS runs
    `).get();
  }

  function captured(work: () => unknown): any {
    try { work(); } catch (error) { return error; }
    throw new Error('Expected the call to throw');
  }

  it('creates Data Room and text widgets that load in one local run with no lane or binding', async () => {
    const environment = readyEnvironment();
    const head = environment.store.getHead('ds_r4_events')!;
    const dashboard = environment.dashboards.createDashboard({
      title: 'Direct Data Room',
      widgets: [
        { kind: 'text', title: 'About', config: { text: 'Daily events from the Data Room.' } },
        { kind: 'line', title: 'Daily events', source: roomSource() },
        { kind: 'metric', title: 'Warehouse total', sql: 'SELECT 7' },
      ] as any,
    });
    const [about, daily, warehouse] = dashboard.widgets;
    expect(daily.sql).toBeUndefined();
    expect(daily.preset).toBeUndefined();
    expect(daily.config.dataSource).toEqual({
      version: 1, kind: 'data_room_query', datasetId: 'ds_r4_events', versionId: head.versionId,
      sql: DAILY_SQL, params: [], limit: 100,
    });
    const run = dashboard.recentRuns[0];
    expect(run).toMatchObject({ status: 'queued', refreshScope: 'selective', trigger: 'agent', widgetCount: 2 });

    expect(await environment.dashboards.processQueuedRuns(1)).toBe(1);
    const current = environment.dashboards.getDashboard(dashboard.id)!;
    expect(current.recentRuns[0]).toMatchObject({ id: run.id, status: 'completed', widgetsSucceeded: 2 });
    const byId = new Map(current.widgets.map(widget => [widget.id, widget]));
    expect(byId.get(daily.id)!.result).toMatchObject({
      trust: 'local_verified_data',
      columns: ['event_date', 'events'],
      rows: DAILY_ROWS,
      source: { provider: 'data-room-query', datasetId: 'ds_r4_events', versionId: head.versionId, widgetRevision: daily.revision },
    });
    expect(byId.get(about.id)!.result).toMatchObject({ trust: 'local_static_content', rows: [['Daily events from the Data Room.']] });
    expect(byId.get(warehouse.id)!.result).toBeUndefined();
    expect(byId.get(daily.id)!.binding).toBeUndefined();
    expect(environment.db.prepare('SELECT COUNT(*) AS count FROM analytics_widget_dataset_bindings').get()).toEqual({ count: 0 });
    expect(environment.mcp.stats()).toEqual({ sqlCalls: [], connectionProbes: 0 });
  });

  // REGRESSION (live canary 2026-09-28): imported datasets pin model context
  // to one provider/endpoint. The resolver used the model catalog, which hides
  // them without that runtime, so create rejected a ready dataset.
  it('pins and loads a dataset whose model context is pinned to one provider', async () => {
    const environment = readyEnvironment({
      modelContextPolicy: {
        allowedProviderLocalities: ['amazon_managed_remote'],
        disclosurePolicyVersion: 'botboy-data-room-v1',
        endpointSha256: '4'.repeat(64),
      },
    });
    const head = environment.store.getHead('ds_r4_events')!;
    const dashboard = environment.dashboards.createDashboard({
      title: 'Provider pinned', widgets: [{ kind: 'line', title: 'Daily events', source: roomSource() }] as any,
    });
    expect(dashboard.widgets[0].config.dataSource).toMatchObject({ datasetId: 'ds_r4_events', versionId: head.versionId });
    expect(await environment.dashboards.processQueuedRuns(1)).toBe(1);
    expect(environment.dashboards.getDashboard(dashboard.id)!.widgets[0].result).toMatchObject({
      rows: DAILY_ROWS, source: { provider: 'data-room-query', versionId: head.versionId },
    });
  });

  it('rejects a dataset that does not allow dashboard use, with zero effect', () => {
    const environment = readyEnvironment({ allowedUses: ['local_answer'] });
    const failure = captured(() => environment.dashboards.createDashboard({
      title: 'Denied', widgets: [{ kind: 'line', title: 'Daily events', source: roomSource() }] as any,
    }));
    expect(failure).toMatchObject({ code: 'invalid_input', mutationApplied: false });
    expect(failure.message).toBe('Widget 1 "Daily events": Dataset ds_r4_events is not approved for dashboard use.');
    expect(failure.issues[0]).toMatchObject({ code: 'dashboard_use_denied', path: 'widgets[0].source.datasetId' });
    expect(counts(environment)).toEqual({ dashboards: 0, widgets: 0, runs: 0 });
  });

  // REGRESSION (found 2026-09-28): runs requested the configure-time version,
  // so once the dataset gained a version every refresh failed with "not the
  // current ready head". Runs now read the current head and record it.
  it('refreshes onto the dataset head after a new version lands', async () => {
    const environment = readyEnvironment();
    const first = environment.store.getHead('ds_r4_events')!;
    const dashboard = environment.dashboards.createDashboard({
      title: 'Follows head', widgets: [{ kind: 'line', title: 'Daily events', source: roomSource() }] as any,
    });
    expect(await environment.dashboards.processQueuedRuns(1)).toBe(1);

    const second = ingest(environment, [...V1_ROWS.slice(0, 3), ['2026-09-02', 'US', 41]], 1);
    expect(second.version.id).not.toBe(first.versionId);
    const refresh = environment.dashboards.enqueueRefresh(dashboard.id, 'manual');
    expect(await environment.dashboards.processQueuedRuns(1)).toBe(1);

    expect(environment.dashboards.getRun(refresh.id)).toMatchObject({ status: 'completed', widgetsSucceeded: 1 });
    const widget = environment.dashboards.getDashboard(dashboard.id)!.widgets[0];
    expect(widget.lastError).toBeFalsy();
    expect(widget.result).toMatchObject({
      rows: [['2026-09-01', 30], ['2026-09-02', 71]],
      source: { provider: 'data-room-query', versionId: second.version.id },
    });
    expect((widget.config.dataSource as any).versionId).toBe(first.versionId);
    expect(environment.mcp.stats()).toEqual({ sqlCalls: [], connectionProbes: 0 });
  });

  it('queues nothing for a warehouse-only dashboard and keeps refresh=true a full run', () => {
    const environment = readyEnvironment();
    const warehouseOnly = environment.dashboards.createDashboard({
      title: 'Warehouse only',
      widgets: [
        { kind: 'text', title: 'About', config: { text: 'Notes' } },
        { kind: 'metric', title: 'Total', sql: 'SELECT 7' },
      ],
    });
    expect(warehouseOnly.recentRuns).toEqual([]);

    const refreshed = environment.dashboards.createDashboard({
      title: 'Full refresh',
      widgets: [
        { kind: 'line', title: 'Daily events', source: roomSource() },
        { kind: 'metric', title: 'Total', sql: 'SELECT 7' },
      ] as any,
    }, 'agent');
    expect(refreshed.recentRuns).toHaveLength(1);
    expect(refreshed.recentRuns[0]).toMatchObject({ status: 'queued', refreshScope: 'full', widgetCount: 2 });
  });

  it('refreshes a Data Room + text dashboard fully with no warehouse lane available', async () => {
    const environment = readyEnvironment();
    const dashboard = environment.dashboards.createDashboard({
      title: 'Local only',
      widgets: [
        { kind: 'text', title: 'About', config: { text: 'Local.' } },
        { kind: 'line', title: 'Daily events', source: roomSource() },
      ] as any,
    });
    expect(await environment.dashboards.processQueuedRuns(1)).toBe(1);

    const full = environment.dashboards.enqueueRefresh(dashboard.id, 'manual');
    expect(full).toMatchObject({ refreshScope: 'full', widgetCount: 2 });
    expect(await environment.dashboards.processQueuedRuns(1)).toBe(1);
    expect(environment.dashboards.getRun(full.id)).toMatchObject({ status: 'completed', widgetsSucceeded: 2 });
    expect(environment.mcp.stats()).toEqual({ sqlCalls: [], connectionProbes: 0 });
  });

  it('an html view page reads hidden Data Room widgets: it loads locally with no warehouse, and keys are checked', async () => {
    const environment = readyEnvironment();
    const dashboard = environment.dashboards.createDashboard({
      title: 'Page',
      widgets: [
        { kind: 'html', title: 'Events page', config: { html: '<div id="app"></div><script>botboy.onData(d => { app.textContent = d.daily.rowCount; })</script>', inputs: ['daily'], span: 12 } },
        { kind: 'table', title: 'Daily events', source: roomSource({ limit: 5000 }), config: { key: 'daily', hidden: true } },
      ] as any,
    });
    expect(dashboard.widgets.map(widget => widget.kind)).toEqual(['html', 'table']);
    expect(await environment.dashboards.processQueuedRuns(1)).toBe(1);
    const loaded = environment.dashboards.getDashboard(dashboard.id)!;
    expect(loaded.widgets[0].result).toMatchObject({ trust: 'local_static_content' });
    expect(loaded.widgets[1].result?.rows.length).toBeGreaterThan(0);
    expect(loaded.widgets[1].config).toMatchObject({ key: 'daily', hidden: true });
    expect(environment.mcp.stats()).toEqual({ sqlCalls: [], connectionProbes: 0 });
    for (const [widgets, message] of [
      [[{ kind: 'html', title: 'P', config: { html: '<p>x</p>', inputs: ['nope'] } }], /config\.inputs names nope/],
      [[{ kind: 'html', title: 'P', config: { html: '' } }], /needs config\.html/],
      [[{ kind: 'html', title: 'P', config: { html: '<p>x</p>' }, source: roomSource() }], /no source of its own/],
      [[{ kind: 'table', title: 'A', source: roomSource(), config: { key: 'k' } }, { kind: 'table', title: 'B', source: roomSource(), config: { key: 'k' } }], /keys must be unique/],
      [[{ kind: 'metric', title: 'S', sql: 'SELECT 1', config: { span: 13 } }], /config\.span/],
    ] as const) {
      expect(() => environment.dashboards.createDashboard({ title: 'Bad', widgets: widgets as any })).toThrow(message);
    }
  });
  it.each([
    ['an unknown dataset', { kind: 'line', title: 'Missing', source: roomSource({ datasetId: 'ds_missing' }) }, 'not_found', 'widgets[1].source.datasetId'],
    ['SQL that does not read source.data', { kind: 'line', title: 'Wrong table', source: roomSource({ sql: 'SELECT 1' }) }, 'invalid_input', 'widgets[1].source.sql'],
    ['an unsupported source field', { kind: 'line', title: 'Pinned', source: roomSource({ versionId: 'dsv_x' }) }, 'invalid_input', 'widgets[1].source.versionId'],
    ['an out-of-range limit', { kind: 'table', title: 'Big', source: roomSource({ limit: 5001 }) }, 'invalid_input', 'widgets[1].source.limit'],
  ])('rejects %s with its issue path and zero effect', (_label, widget, code, path) => {
    const environment = readyEnvironment();
    const failure = captured(() => environment.dashboards.createDashboard({
      title: 'Rejected',
      widgets: [{ kind: 'metric', title: 'Total', sql: 'SELECT 7' }, widget] as any,
    }));
    expect(failure).toBeInstanceOf(AnalyticsWidgetEditError);
    expect(failure).toMatchObject({ code, mutationApplied: false, nextAction: expect.any(String) });
    expect(failure.message).toMatch(/^Widget 2 "/);
    expect(failure.issues[0].path).toBe(path);
    expect(counts(environment)).toEqual({ dashboards: 0, widgets: 0, runs: 0 });
  });

  it.each([
    ['widget.sql beside a Data Room source', { kind: 'line', title: 'Both', sql: 'SELECT 1', source: roomSource() }, /omit widget\.sql/],
    ['a caller-supplied config.dataSource', { kind: 'line', title: 'Raw', sql: 'SELECT 1', config: { dataSource: { kind: 'data_room_query' } } }, /config\.dataSource is server-owned; give the widget's data source as widget\.source/],
    ['a source on a text widget', { kind: 'text', title: 'Notes', config: { text: 'x' }, source: roomSource() }, /text widget; remove source/],
  ])('rejects %s before any write', (_label, widget, message) => {
    const environment = readyEnvironment();
    expect(() => environment.dashboards.createDashboard({ title: 'Rejected', widgets: [widget] as any })).toThrow(message);
    expect(counts(environment)).toEqual({ dashboards: 0, widgets: 0, runs: 0 });
  });

  it('replaces widgets on update and loads the new Data Room widgets locally', async () => {
    const environment = readyEnvironment();
    const dashboard = environment.dashboards.createDashboard({
      title: 'Update me', widgets: [{ kind: 'metric', title: 'Total', sql: 'SELECT 7' }],
    });
    expect(dashboard.recentRuns).toEqual([]);

    const updated = environment.dashboards.updateDashboard(dashboard.id, {
      widgets: [{ kind: 'bar', title: 'Events by day', source: roomSource() }] as any,
    });
    expect(updated.recentRuns[0]).toMatchObject({ status: 'queued', refreshScope: 'selective', widgetCount: 1 });
    expect(await environment.dashboards.processQueuedRuns(1)).toBe(1);
    expect(environment.dashboards.getDashboard(dashboard.id)!.widgets[0].result).toMatchObject({
      rows: DAILY_ROWS, source: { provider: 'data-room-query', datasetId: 'ds_r4_events' },
    });
    expect(environment.mcp.stats()).toEqual({ sqlCalls: [], connectionProbes: 0 });
  });

  it('rejects a widget update while the local run is active and names the wait', () => {
    const environment = readyEnvironment();
    const dashboard = environment.dashboards.createDashboard({
      title: 'Busy', widgets: [{ kind: 'line', title: 'Daily events', source: roomSource() }] as any,
    });
    const run = dashboard.recentRuns[0];
    const failure = captured(() => environment.dashboards.updateDashboard(dashboard.id, {
      widgets: [{ kind: 'bar', title: 'Events by day', source: roomSource() }] as any,
    }));
    expect(failure).toBeInstanceOf(AnalyticsWidgetEditError);
    expect(failure).toMatchObject({ code: 'active_run', mutationApplied: false });
    expect(failure.nextAction).toBe(`Wait for run ${run.id} to finish (get_analytics_dashboard shows it), then send the same update once.`);
    expect(environment.dashboards.getDashboard(dashboard.id)!.widgets.map(widget => widget.id)).toEqual(dashboard.widgets.map(widget => widget.id));
  });

  it('leaves the dashboard unchanged when an update source is rejected', () => {
    const environment = readyEnvironment();
    const dashboard = environment.dashboards.createDashboard({
      title: 'Keep me', widgets: [{ kind: 'metric', title: 'Total', sql: 'SELECT 7' }],
    });
    expect(() => environment.dashboards.updateDashboard(dashboard.id, {
      widgets: [{ kind: 'bar', title: 'Missing', source: roomSource({ datasetId: 'ds_missing' }) }] as any,
    })).toThrow(/^Widget 1 "Missing": Dataset ds_missing is not an active ready workspace dataset/);
    const current = environment.dashboards.getDashboard(dashboard.id)!;
    expect(current.widgets.map(widget => widget.id)).toEqual(dashboard.widgets.map(widget => widget.id));
    expect(current.recentRuns).toEqual([]);
  });

  it('configures one widget through the same resolver and loads it locally', async () => {
    const environment = readyEnvironment();
    const dashboard = environment.dashboards.createDashboard({
      title: 'Configure', widgets: [{ kind: 'line', title: 'Daily', sql: 'SELECT 1' }],
    });
    const [widget] = dashboard.widgets;
    const failure = captured(() => environment.dashboards.configureWidgetSource(dashboard.id, widget.id, {
      expectedWidgetRevision: widget.revision, source: roomSource({ datasetId: 'ds_missing' }) as any,
    }));
    expect(failure).toMatchObject({ code: 'not_found', mutationApplied: false });
    expect(failure.issues[0].path).toBe('source.datasetId');

    const mutation = environment.dashboards.configureWidgetSource(dashboard.id, widget.id, {
      expectedWidgetRevision: widget.revision, source: roomSource() as any,
    });
    expect(mutation.run).toMatchObject({ refreshScope: 'selective', widgetCount: 1 });
    expect(await environment.dashboards.processQueuedRuns(1)).toBe(1);
    expect(environment.dashboards.getDashboard(dashboard.id)!.widgets[0]).toMatchObject({
      revision: widget.revision + 1,
      sql: undefined,
      result: { rows: DAILY_ROWS, source: { provider: 'data-room-query' } },
    });
  });
});
