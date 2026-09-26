import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStorage, type StorageLayer } from './storage.js';
import {
  AnalyticsDataRoomError,
  analyticsDatasetContractSha256,
  analyticsDatasetSchemaSha256,
  createAnalyticsDataRoomStore,
  type AnalyticsDataRoomStore,
} from './analytics-data-room-store.js';
import { createAnalyticsDataRoomBackupService } from './analytics-data-room-backup.js';
import { createAnalyticsDataRoomService, type AnalyticsDataRoomService } from './analytics-data-room-service.js';
import { createAnalyticsDerivationService, type AnalyticsDerivationService } from './analytics-data-room-derivation.js';
import { createAnalyticsLocalQueryEngine } from './analytics-data-room-query.js';
import { createAnalyticsAnswerService, type AnalyticsAnswerRemoteRuntime } from './analytics-data-room-answer.js';
import { createAnalyticsDataRoomScheduler } from './analytics-data-room-scheduler.js';
import type {
  AnalyticsDataCell,
  AnalyticsDatasetContract,
  AnalyticsDatasetDefinitionInput,
  AnalyticsDerivedDefinitionV1,
  AnalyticsDerivedStepV1,
  AnalyticsFieldContract,
  AnalyticsRelationalContractV1,
  AnalyticsRequest,
} from './analytics-data-room-types.js';

const NOW = new Date('2026-09-19T12:00:00.000Z');
const storages: StorageLayer[] = [];
const directories: string[] = [];

function tempDir(): string {
  const value = fs.mkdtempSync(path.join(os.tmpdir(), 'analytics-r3-'));
  directories.push(value);
  return value;
}

afterEach(() => {
  while (storages.length) storages.pop()?.close();
  while (directories.length) fs.rmSync(directories.pop()!, { recursive: true, force: true });
});

function withSha(contract: Omit<AnalyticsDatasetContract, 'contractSha256' | 'schemaSha256'>): AnalyticsDatasetContract {
  const schemaSha256 = analyticsDatasetSchemaSha256(contract.schema);
  const value = { ...contract, schemaSha256, contractSha256: '' } as AnalyticsDatasetContract;
  return { ...value, contractSha256: analyticsDatasetContractSha256(value) };
}

function relational(
  grainFields: string[],
  measures: AnalyticsRelationalContractV1['measures'],
  uniqueKeys: string[][] = [grainFields],
): AnalyticsRelationalContractV1 {
  return { version: 1, grainFields, uniqueKeys, measures };
}

function contract(input: {
  datasetId: string;
  kind: 'source' | 'derived';
  schema: AnalyticsFieldContract[];
  metricField: string;
  metricId?: string;
  unit?: string;
  grain: string;
  grainFields: string[];
  availableDimensions: string[];
  countingKey: string;
  relationalMeasures: AnalyticsRelationalContractV1['measures'];
  uniqueKeys?: string[][];
  scope?: 'dashboard_local' | 'project' | 'workspace';
}): AnalyticsDatasetContract {
  const unit = input.unit ?? 'events';
  return withSha({
    contractVersion: '1',
    status: 'active',
    datasetId: input.datasetId,
    datasetKind: input.kind,
    scope: input.scope ?? 'workspace',
    domainKey: 'r3-test',
    schema: input.schema,
    metric: { id: input.metricId ?? 'events', version: '1', definitionSha256: '1'.repeat(64), unit },
    regime: { id: 'valid_events', version: '1', definitionSha256: '2'.repeat(64) },
    countingKey: input.countingKey,
    unit,
    grain: input.grain,
    availableDimensions: input.availableDimensions,
    timeField: 'event_date',
    timeZone: 'UTC',
    coverage: {
      partitionKind: 'day',
      completePartitions: ['2026-09-01', '2026-09-02'],
      watermark: '2026-09-02T23:59:59.000Z',
    },
    handling: {
      classification: 'internal',
      allowedUses: ['local_answer', 'dashboard'],
      allowModelContext: true,
      allowPublication: false,
    },
    relational: relational(input.grainFields, input.relationalMeasures, input.uniqueKeys),
  });
}

const EVENT_SCHEMA: AnalyticsFieldContract[] = [
  { name: 'event_date', logicalType: 'date', nullable: false },
  { name: 'user_id', logicalType: 'string', nullable: false },
  { name: 'region', logicalType: 'string', nullable: false },
  { name: 'category', logicalType: 'string', nullable: false },
  { name: 'events', logicalType: 'integer', nullable: false },
  { name: 'sessions', logicalType: 'integer', nullable: false },
];

function sourceDefinition(id: string, schema = EVENT_SCHEMA): AnalyticsDatasetDefinitionInput {
  const metricField = schema.some(field => field.name === 'events') ? 'events' : schema.at(-1)!.name;
  const grainFields = schema.filter(field => field.name !== metricField).map(field => field.name);
  return {
    id,
    name: id,
    kind: 'source',
    scope: 'workspace',
    domainKey: 'r3-test',
    ownerId: 'owner',
    lifecycle: 'active',
    sourceKind: 'sql_context',
    sourceFormat: 'canonical_json',
    definition: { adapter: 'fixture', version: 1 },
    contract: contract({
      datasetId: id,
      kind: 'source',
      schema,
      metricField,
      grain: `grain_${id}`,
      grainFields,
      availableDimensions: grainFields,
      countingKey: schema.some(field => field.name === 'user_id') ? 'user_id' : grainFields[0],
      relationalMeasures: [{ field: metricField, unit: 'events', aggregation: 'sum', protected: true }],
    }),
    retention: { minimumVersions: 1, automaticExpiry: false, reacquirable: true, backupRequired: false },
  };
}

function derivedDefinition(input: {
  id: string;
  outputContract: AnalyticsDatasetContract;
  dependencies: AnalyticsDerivedDefinitionV1['dependencies'];
  steps: AnalyticsDerivedStepV1[];
  output: string;
  metricValueColumn: string;
  rowDimensions: string[];
}): AnalyticsDatasetDefinitionInput {
  return {
    id: input.id,
    name: input.id,
    kind: 'derived',
    scope: input.outputContract.scope,
    domainKey: input.outputContract.domainKey,
    ownerId: 'owner',
    lifecycle: 'active',
    sourceKind: 'import',
    sourceFormat: 'canonical_json',
    definition: {
      answer: {
        version: 1,
        metricId: input.outputContract.metric.id,
        metricValueColumn: input.metricValueColumn,
        rowDimensions: input.rowDimensions,
        filterableFields: [...new Set([input.outputContract.timeField, ...input.rowDimensions])],
        stableOrder: input.rowDimensions.map(field => ({ field, direction: 'asc' as const })),
      },
      derived: {
        version: 1,
        engine: 'botboy_relational_v1',
        dependencies: input.dependencies,
        steps: input.steps,
        output: input.output,
      },
    },
    contract: input.outputContract,
    retention: { minimumVersions: 1, automaticExpiry: false, reacquirable: true, backupRequired: false },
  };
}

function setup(options: { databasePath?: string; rootDir?: string } = {}): {
  storage: StorageLayer;
  store: AnalyticsDataRoomStore;
  room: AnalyticsDataRoomService;
  derivation: AnalyticsDerivationService;
} {
  const storage = createStorage(options.databasePath ?? ':memory:');
  storage.initialize();
  storages.push(storage);
  const store = createAnalyticsDataRoomStore({ db: storage.getDb(), rootDir: options.rootDir ?? tempDir(), now: () => NOW });
  const room = createAnalyticsDataRoomService({
    store,
    backups: createAnalyticsDataRoomBackupService({ db: storage.getDb(), store, now: () => NOW }),
  });
  const derivation = createAnalyticsDerivationService({ db: storage.getDb(), store, now: () => NOW });
  return { storage, store, room, derivation };
}

function ingest(
  environment: ReturnType<typeof setup>,
  datasetId: string,
  rows: AnalyticsDataCell[][],
  expectedHeadRevision = 0,
) {
  const dataset = environment.store.getDataset(datasetId)!;
  return environment.room.ingestSqlRows({
    datasetId,
    expectedHeadRevision,
    materializedAt: NOW.toISOString(),
    sourceReceipt: {
      sourceKind: 'sql_context',
      sourceId: `query-${expectedHeadRevision + 1}`,
      querySha256: String(expectedHeadRevision + 3).repeat(64),
      producerVersion: 'r3-fixture',
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

function request(dataset: AnalyticsDatasetContract): AnalyticsRequest {
  const answerDimensions = dataset.relational!.grainFields.filter(field => field !== dataset.metric.id);
  return {
    domainKey: dataset.domainKey,
    metric: dataset.metric,
    dimensions: answerDimensions,
    filters: [],
    dateRange: { start: '2026-09-01', end: '2026-09-02' },
    timeZone: dataset.timeZone,
    countingKey: dataset.countingKey,
    regime: dataset.regime,
    requiredGrain: dataset.grain,
    freshness: { mode: 'allow_stale' },
    use: 'local_answer',
    datasetId: dataset.datasetId,
    resultLimit: 200,
  };
}

function aggregateTarget(id: string, sourceDatasetId = 'ds_r3_events'): AnalyticsDatasetDefinitionInput {
  const output = contract({
    datasetId: id,
    kind: 'derived',
    schema: [
      { name: 'event_date', logicalType: 'date', nullable: false },
      { name: 'region', logicalType: 'string', nullable: false },
      { name: 'total_events', logicalType: 'integer', nullable: false },
    ],
    metricField: 'total_events',
    metricId: 'events',
    grain: 'day_region',
    grainFields: ['event_date', 'region'],
    availableDimensions: ['event_date', 'region'],
    countingKey: 'region',
    relationalMeasures: [{ field: 'total_events', unit: 'events', aggregation: 'sum', protected: true }],
  });
  return derivedDefinition({
    id,
    outputContract: output,
    dependencies: [{
      alias: 'events_input', datasetId: sourceDatasetId, versionPolicy: 'latest_compatible',
      requiredColumns: ['event_date', 'events', 'region'],
    }],
    steps: [
      {
        id: 'daily', type: 'aggregate', input: 'events_input', groupBy: ['event_date', 'region'],
        measures: [{ operation: 'sum', field: 'events', as: 'total_events', outputType: 'integer', unit: 'events' }],
      },
      {
        id: 'final', type: 'project', input: 'daily',
        fields: [{ field: 'event_date' }, { field: 'region' }, { field: 'total_events' }],
      },
    ],
    output: 'final',
    metricValueColumn: 'total_events',
    rowDimensions: ['event_date', 'region'],
  });
}

const BASE_ROWS: AnalyticsDataCell[][] = [
  ['2026-09-01', 'u1', 'IN', 'sports', 2, 1],
  ['2026-09-01', 'u2', 'IN', 'news', 3, 1],
  ['2026-09-02', 'u1', 'US', 'sports', 4, 2],
];

describe('analytics data-room R3 contracts, DAG, and exact-input materialization', () => {
  it('rejects arbitrary code fields, self edges, and indirect cycles while preserving revision history', () => {
    const environment = setup();
    environment.room.registerDataset(sourceDefinition('ds_r3_events'));
    ingest(environment, 'ds_r3_events', BASE_ROWS);
    const target = aggregateTarget('ds_r3_a');
    expect(() => environment.room.registerDataset({
      ...target,
      definition: { ...target.definition, sql: 'SELECT * FROM secret' },
    })).toThrow(/unsupported field.*sql/i);

    const self = aggregateTarget('ds_r3_self');
    (self.definition.derived as AnalyticsDerivedDefinitionV1).dependencies[0].datasetId = 'ds_r3_self';
    expect(() => environment.room.registerDataset(self)).toThrow(/cannot depend on itself/i);

    environment.room.registerDataset(target);
    const bContract = { ...target.contract, datasetId: 'ds_r3_b', contractSha256: '' };
    bContract.contractSha256 = analyticsDatasetContractSha256(bContract);
    const b = derivedDefinition({
      id: 'ds_r3_b', outputContract: bContract,
      dependencies: [{ alias: 'a', datasetId: 'ds_r3_a', versionPolicy: 'latest_compatible', requiredColumns: ['event_date', 'region', 'total_events'] }],
      steps: [{ id: 'final', type: 'project', input: 'a', fields: [{ field: 'event_date' }, { field: 'region' }, { field: 'total_events' }] }],
      output: 'final', metricValueColumn: 'total_events', rowDimensions: ['event_date', 'region'],
    });
    environment.room.registerDataset(b);
    const aCycle = structuredClone(target) as typeof target & { expectedDefinitionRevision: number };
    aCycle.expectedDefinitionRevision = 1;
    (aCycle.definition.derived as AnalyticsDerivedDefinitionV1).dependencies = [{
      alias: 'b', datasetId: 'ds_r3_b', versionPolicy: 'latest_compatible', requiredColumns: ['event_date', 'region', 'total_events'],
    }];
    (aCycle.definition.derived as AnalyticsDerivedDefinitionV1).steps = [{
      id: 'final', type: 'project', input: 'b', fields: [{ field: 'event_date' }, { field: 'region' }, { field: 'total_events' }],
    }];
    expect(() => environment.store.reviseDataset(aCycle)).toThrow(/cycle/i);
    expect(environment.store.getDataset('ds_r3_a')?.definitionRevision).toBe(1);
    expect(environment.store.listDependencies('ds_r3_a')).toHaveLength(1);
  });

  it('materializes one immutable aggregate for Q&A and two dashboard-scoped consumers', async () => {
    const environment = setup();
    environment.room.registerDataset(sourceDefinition('ds_r3_events'));
    const source = ingest(environment, 'ds_r3_events', BASE_ROWS);
    const target = environment.room.registerDataset(aggregateTarget('ds_r3_daily'));
    const ask = request(target.contract);

    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let started!: () => void;
    const executionStarted = new Promise<void>(resolve => { started = resolve; });
    let executions = 0;
    const overlapping = createAnalyticsDerivationService({
      db: environment.storage.getDb(),
      store: environment.store,
      now: () => NOW,
      beforeExecute: async () => {
        executions += 1;
        started();
        await gate;
      },
    });
    const answerPromise = overlapping.materialize({
      datasetId: target.id, request: ask, consumer: { kind: 'answer', id: 'question-1' },
    });
    await executionStarted;
    const dashboardOnePromise = overlapping.materialize({
      datasetId: target.id, request: { ...ask, use: 'dashboard' }, consumer: { kind: 'dashboard_widget', id: 'dash-a/widget-1' },
    });
    const dashboardTwoPromise = overlapping.materialize({
      datasetId: target.id, request: { ...ask, use: 'dashboard' }, consumer: { kind: 'dashboard_widget', id: 'dash-b/widget-9' },
    });
    release();
    const [answer, dashboardOne, dashboardTwo] = await Promise.all([
      answerPromise, dashboardOnePromise, dashboardTwoPromise,
    ]);
    expect(executions).toBe(1);
    expect(answer.state, JSON.stringify(answer)).toBe('ready');
    expect(dashboardOne.state, JSON.stringify(dashboardOne)).toBe('ready');
    expect(dashboardTwo.state, JSON.stringify(dashboardTwo)).toBe('ready');
    if (answer.state !== 'ready' || dashboardOne.state !== 'ready' || dashboardTwo.state !== 'ready') return;
    expect(new Set([answer.run.id, dashboardOne.run.id, dashboardTwo.run.id]).size).toBe(1);
    expect(new Set([answer.version.id, dashboardOne.version.id, dashboardTwo.version.id]).size).toBe(1);
    expect(answer.version.derivation?.inputs).toMatchObject([{
      alias: 'events_input', datasetId: 'ds_r3_events', versionId: source.version.id,
    }]);
    expect(answer.version.derivation?.materializationKeySha256).toBe(answer.run.materializationKeySha256);
    expect(environment.storage.getDb().prepare('SELECT COUNT(*) AS count FROM analytics_derived_runs').get())
      .toEqual({ count: 1 });
    expect(environment.storage.getDb().prepare('SELECT COUNT(*) AS count FROM analytics_dataset_version_inputs').get())
      .toEqual({ count: 1 });
    const sourceEligibility = environment.store.versionDeletionEligibility(source.version.id);
    expect(sourceEligibility.reasons).toContain('referenced_by_derived_version');
    expect(() => environment.room.backupDataset(target.id, tempDir())).toThrow(/lineage-closure backup/i);
  });

  it('executes filter, cohort, aggregate, ratio, and project with deterministic typed output', async () => {
    const environment = setup();
    environment.room.registerDataset(sourceDefinition('ds_r3_events'));
    ingest(environment, 'ds_r3_events', BASE_ROWS);
    const output = contract({
      datasetId: 'ds_r3_cohort_ratio', kind: 'derived',
      schema: [
        { name: 'event_date', logicalType: 'date', nullable: false },
        { name: 'cohort_day', logicalType: 'date', nullable: false },
        { name: 'period_index', logicalType: 'integer', nullable: false },
        { name: 'event_rate', logicalType: 'number', nullable: false },
      ],
      metricField: 'event_rate', metricId: 'event_rate', unit: 'ratio', grain: 'day_cohort_period',
      grainFields: ['event_date', 'cohort_day', 'period_index'],
      availableDimensions: ['event_date', 'cohort_day', 'period_index'], countingKey: 'cohort_day',
      relationalMeasures: [{ field: 'event_rate', unit: 'ratio', aggregation: 'none', protected: true }],
    });
    const target = environment.room.registerDataset(derivedDefinition({
      id: output.datasetId, outputContract: output,
      dependencies: [{ alias: 'events_input', datasetId: 'ds_r3_events', versionPolicy: 'latest_compatible', requiredColumns: EVENT_SCHEMA.map(field => field.name) }],
      steps: [
        { id: 'filtered', type: 'filter', input: 'events_input', predicates: [{ field: 'region', operator: 'in', value: ['IN', 'US'] }] },
        { id: 'cohorted', type: 'cohort', input: 'filtered', entityKey: 'user_id', eventTimeField: 'event_date', timeZone: 'UTC', bucket: 'day', cohortField: 'cohort_day', periodField: 'period_index', nulls: 'error' },
        {
          id: 'summed', type: 'aggregate', input: 'cohorted', groupBy: ['event_date', 'cohort_day', 'period_index'],
          measures: [
            { operation: 'sum', field: 'events', as: 'total_events', outputType: 'integer', unit: 'events' },
            { operation: 'sum', field: 'sessions', as: 'total_sessions', outputType: 'integer', unit: 'events' },
          ],
        },
        { id: 'rated', type: 'ratio', input: 'summed', numerator: 'total_events', denominator: 'total_sessions', as: 'event_rate', scale: 1, zeroDenominator: 'error', unit: 'ratio' },
        { id: 'final', type: 'project', input: 'rated', fields: [{ field: 'event_date' }, { field: 'cohort_day' }, { field: 'period_index' }, { field: 'event_rate' }] },
      ],
      output: 'final', metricValueColumn: 'event_rate', rowDimensions: ['event_date', 'cohort_day', 'period_index'],
    }));
    const result = await environment.derivation.materialize({
      datasetId: target.id, request: request(target.contract), consumer: { kind: 'answer', id: 'cohort-ratio' },
    });
    expect(result.state).toBe('ready');
    if (result.state !== 'ready') return;
    const sidecar = new Database(environment.store.getVerifiedMaterializedPath(result.version.id, 'local_answer'), { readonly: true });
    expect(sidecar.prepare('SELECT event_date, cohort_day, period_index, event_rate FROM data ORDER BY event_date').all()).toEqual([
      { event_date: '2026-09-01', cohort_day: '2026-09-01', period_index: 0, event_rate: 2.5 },
      { event_date: '2026-09-02', cohort_day: '2026-09-01', period_index: 1, event_rate: 2 },
    ]);
    sidecar.close();
  });

  it('executes a finite pivot with explicit zero fill and rejects dynamic categories', async () => {
    const environment = setup();
    environment.room.registerDataset(sourceDefinition('ds_r3_events'));
    ingest(environment, 'ds_r3_events', BASE_ROWS);
    const output = contract({
      datasetId: 'ds_r3_pivot', kind: 'derived',
      schema: [
        { name: 'event_date', logicalType: 'date', nullable: false },
        { name: 'region', logicalType: 'string', nullable: false },
        { name: 'sports_events', logicalType: 'integer', nullable: false },
        { name: 'news_events', logicalType: 'integer', nullable: false },
      ],
      metricField: 'sports_events', metricId: 'sports_events', grain: 'day_region_pivot',
      grainFields: ['event_date', 'region'], availableDimensions: ['event_date', 'region'], countingKey: 'region',
      relationalMeasures: [
        { field: 'sports_events', unit: 'events', aggregation: 'sum', protected: true },
        { field: 'news_events', unit: 'events', aggregation: 'sum', protected: true },
      ],
    });
    const target = environment.room.registerDataset(derivedDefinition({
      id: output.datasetId, outputContract: output,
      dependencies: [{ alias: 'events_input', datasetId: 'ds_r3_events', versionPolicy: 'latest_compatible', requiredColumns: ['event_date', 'region', 'category', 'events'] }],
      steps: [{
        id: 'pivoted', type: 'pivot', input: 'events_input', groupBy: ['event_date', 'region'], pivotField: 'category',
        values: [{ value: 'sports', as: 'sports_events' }, { value: 'news', as: 'news_events' }],
        measure: { operation: 'sum', field: 'events', outputType: 'integer', unit: 'events' },
        missing: 'zero', unexpected: 'error',
      }],
      output: 'pivoted', metricValueColumn: 'sports_events', rowDimensions: ['event_date', 'region'],
    }));
    const result = await environment.derivation.materialize({
      datasetId: target.id, request: request(target.contract), consumer: { kind: 'answer', id: 'pivot' },
    });
    expect(result.state).toBe('ready');
    if (result.state !== 'ready') return;
    const sidecar = new Database(environment.store.getVerifiedMaterializedPath(result.version.id, 'dashboard'), { readonly: true });
    expect(sidecar.prepare('SELECT * FROM data ORDER BY event_date').all()).toEqual([
      { event_date: '2026-09-01', region: 'IN', sports_events: 2, news_events: 3 },
      { event_date: '2026-09-02', region: 'US', sports_events: 4, news_events: 0 },
    ]);
    sidecar.close();
  });

  it('executes a cardinality-checked many-to-one join before aggregation', async () => {
    const environment = setup();
    environment.room.registerDataset(sourceDefinition('ds_r3_events'));
    ingest(environment, 'ds_r3_events', BASE_ROWS);
    const lookupSchema: AnalyticsFieldContract[] = [
      { name: 'event_date', logicalType: 'date', nullable: false },
      { name: 'region', logicalType: 'string', nullable: false },
      { name: 'segment', logicalType: 'string', nullable: false },
      { name: 'weight', logicalType: 'integer', nullable: false },
    ];
    const lookup = sourceDefinition('ds_r3_lookup_ok', lookupSchema);
    lookup.contract = contract({
      datasetId: lookup.id, kind: 'source', schema: lookupSchema, metricField: 'weight',
      grain: 'day_region', grainFields: ['event_date', 'region'], availableDimensions: ['event_date', 'region', 'segment'], countingKey: 'region',
      relationalMeasures: [{ field: 'weight', unit: 'events', aggregation: 'sum', protected: false }],
    });
    environment.room.registerDataset(lookup);
    ingest(environment, lookup.id, [['2026-09-01', 'IN', 'core', 1], ['2026-09-02', 'US', 'other', 1]]);
    const output = contract({
      datasetId: 'ds_r3_join_ok', kind: 'derived',
      schema: [
        { name: 'event_date', logicalType: 'date', nullable: false },
        { name: 'segment', logicalType: 'string', nullable: false },
        { name: 'total_events', logicalType: 'integer', nullable: false },
      ],
      metricField: 'total_events', grain: 'day_segment', grainFields: ['event_date', 'segment'],
      availableDimensions: ['event_date', 'segment'], countingKey: 'segment',
      relationalMeasures: [{ field: 'total_events', unit: 'events', aggregation: 'sum', protected: true }],
    });
    const target = environment.room.registerDataset(derivedDefinition({
      id: output.datasetId, outputContract: output,
      dependencies: [
        { alias: 'events_input', datasetId: 'ds_r3_events', versionPolicy: 'latest_compatible', requiredColumns: ['event_date', 'region', 'events'] },
        { alias: 'lookup', datasetId: lookup.id, versionPolicy: 'latest_compatible', requiredColumns: ['event_date', 'region', 'segment'] },
      ],
      steps: [
        {
          id: 'joined', type: 'join', left: 'events_input', right: 'lookup', joinType: 'inner',
          leftKeys: ['event_date', 'region'], rightKeys: ['event_date', 'region'], cardinality: 'many_to_one',
          rightFields: [{ field: 'segment', as: 'segment' }], nullKeys: 'error', unmatched: 'error', maxFanout: 1,
        },
        {
          id: 'summed', type: 'aggregate', input: 'joined', groupBy: ['event_date', 'segment'],
          measures: [{ operation: 'sum', field: 'events', as: 'total_events', outputType: 'integer', unit: 'events' }],
        },
      ],
      output: 'summed', metricValueColumn: 'total_events', rowDimensions: ['event_date', 'segment'],
    }));
    const result = await environment.derivation.materialize({
      datasetId: target.id, request: request(target.contract), consumer: { kind: 'answer', id: 'join-ok' },
    });
    expect(result.state).toBe('ready');
    if (result.state !== 'ready') return;
    expect(result.version.derivation?.checks.some(check => check.assertionId === 'join_joined_cardinality')).toBe(true);
  });

  it('bounds local derivation and persists a failed assertion without advancing a head', async () => {
    const environment = setup();
    environment.room.registerDataset(sourceDefinition('ds_r3_events'));
    ingest(environment, 'ds_r3_events', BASE_ROWS);
    const target = environment.room.registerDataset(aggregateTarget('ds_r3_bounded'));
    const bounded = createAnalyticsDerivationService({
      db: environment.storage.getDb(), store: environment.store, now: () => NOW, maxOutputRows: 1,
    });
    const result = await bounded.materialize({
      datasetId: target.id, request: request(target.contract), consumer: { kind: 'answer', id: 'bounded' },
    });
    expect(result).toMatchObject({ state: 'blocked', code: 'query_unsupported' });
    expect(environment.store.getHead(target.id)).toBeNull();
    expect(environment.storage.getDb().prepare(`
      SELECT assertion_id, severity, success FROM analytics_derived_run_assertions
    `).all()).toEqual([{ assertion_id: 'derived_run_failure', severity: 'error', success: 0 }]);
  });

  it('uses frozen input bytes after source head movement and schedules only the dirty successor', async () => {
    const environment = setup();
    environment.room.registerDataset(sourceDefinition('ds_r3_events'));
    const firstSource = ingest(environment, 'ds_r3_events', BASE_ROWS);
    const target = environment.room.registerDataset(aggregateTarget('ds_r3_daily'));
    const childContract = {
      ...structuredClone(target.contract),
      datasetId: 'ds_r3_daily_child',
      contractSha256: '',
    };
    childContract.contractSha256 = analyticsDatasetContractSha256(childContract);
    const child = environment.room.registerDataset(derivedDefinition({
      id: childContract.datasetId,
      outputContract: childContract,
      dependencies: [{
        alias: 'parent', datasetId: target.id, versionPolicy: 'latest_compatible',
        requiredColumns: ['event_date', 'region', 'total_events'],
      }],
      steps: [{
        id: 'final', type: 'project', input: 'parent',
        fields: [{ field: 'event_date' }, { field: 'region' }, { field: 'total_events' }],
      }],
      output: 'final', metricValueColumn: 'total_events', rowDimensions: ['event_date', 'region'],
    }));
    const ask = request(target.contract);
    const queued = environment.derivation.beginOrJoin({
      datasetId: target.id, request: ask, consumer: { kind: 'answer', id: 'pin-before-head-move' },
    });
    expect(queued.state).toBe('pending');

    const changedRows = BASE_ROWS.map(row => [...row]);
    changedRows[0][4] = 20;
    const secondSource = ingest(environment, 'ds_r3_events', changedRows, 1);
    expect(secondSource.version.id).not.toBe(firstSource.version.id);
    expect(environment.storage.getDb().prepare(`
      SELECT dataset_id FROM analytics_derived_dirty ORDER BY dataset_id
    `).all()).toEqual([{ dataset_id: target.id }, { dataset_id: child.id }].sort((left, right) => left.dataset_id.localeCompare(right.dataset_id)));
    expect(await environment.derivation.processNext()).toBe(1);
    const firstDerived = environment.store.getDataset(target.id)!;
    const runDiagnostics = environment.storage.getDb().prepare(`
      SELECT status, error, next_action FROM analytics_derived_runs WHERE dataset_id = ? ORDER BY queued_at
    `).all(target.id);
    expect(firstDerived.head, JSON.stringify(runDiagnostics)).not.toBeNull();
    const firstVersion = environment.store.getDatasetVersion(firstDerived.head!.versionId)!;
    expect(firstVersion.derivation?.inputs[0].versionId).toBe(firstSource.version.id);

    const firstSidecar = new Database(environment.store.getVerifiedMaterializedPath(firstVersion.id, 'dashboard'), { readonly: true });
    const firstValue = firstSidecar.prepare(`SELECT total_events FROM data WHERE event_date = '2026-09-01' AND region = 'IN'`).get() as { total_events: number };
    firstSidecar.close();
    expect(firstValue.total_events).toBe(5);
    expect(environment.storage.getDb().prepare(`SELECT dataset_id FROM analytics_derived_dirty WHERE dataset_id = ?`).get(target.id))
      .toEqual({ dataset_id: target.id });

    expect(await environment.derivation.processNext()).toBe(1);
    const nextHead = environment.store.getDataset(target.id)!.head!;
    expect(nextHead.versionId).not.toBe(firstVersion.id);
    const nextVersion = environment.store.getDatasetVersion(nextHead.versionId)!;
    expect(nextVersion.derivation?.inputs[0].versionId).toBe(secondSource.version.id);
    expect(environment.storage.getDb().prepare(`SELECT 1 FROM analytics_derived_dirty WHERE dataset_id = ?`).get(target.id))
      .toBeUndefined();
    expect(environment.storage.getDb().prepare(`SELECT 1 FROM analytics_derived_dirty WHERE dataset_id = ?`).get(child.id))
      .toEqual({ 1: 1 });
    expect(await environment.derivation.processNext()).toBe(1);
    const childVersion = environment.store.getDatasetVersion(environment.store.getHead(child.id)!.versionId)!;
    expect(childVersion.derivation?.inputs[0].versionId).toBe(nextVersion.id);
    expect(environment.storage.getDb().prepare('SELECT COUNT(*) AS count FROM analytics_derived_dirty').get())
      .toEqual({ count: 0 });
  });

  it('blocks on-demand descendants until a dirty derived ancestor is current', async () => {
    const environment = setup();
    environment.room.registerDataset(sourceDefinition('ds_r3_events'));
    ingest(environment, 'ds_r3_events', BASE_ROWS);
    const parent = environment.room.registerDataset(aggregateTarget('ds_r3_parent'));
    const parentReady = await environment.derivation.materialize({
      datasetId: parent.id, request: request(parent.contract), consumer: { kind: 'answer', id: 'parent-initial' },
    });
    expect(parentReady.state).toBe('ready');
    const childContract = { ...structuredClone(parent.contract), datasetId: 'ds_r3_child', contractSha256: '' };
    childContract.contractSha256 = analyticsDatasetContractSha256(childContract);
    const child = environment.room.registerDataset(derivedDefinition({
      id: childContract.datasetId, outputContract: childContract,
      dependencies: [{ alias: 'parent', datasetId: parent.id, versionPolicy: 'latest_compatible', requiredColumns: ['event_date', 'region', 'total_events'] }],
      steps: [{ id: 'final', type: 'project', input: 'parent', fields: [{ field: 'event_date' }, { field: 'region' }, { field: 'total_events' }] }],
      output: 'final', metricValueColumn: 'total_events', rowDimensions: ['event_date', 'region'],
    }));
    const childInitial = await environment.derivation.materialize({
      datasetId: child.id, request: request(child.contract), consumer: { kind: 'answer', id: 'child-initial' },
    });
    expect(childInitial.state).toBe('ready');
    const firstChildHead = environment.store.getHead(child.id)!.versionId;

    const changedRows = BASE_ROWS.map(row => [...row]);
    changedRows[0][4] = 44;
    ingest(environment, 'ds_r3_events', changedRows, 1);
    const premature = await environment.derivation.materialize({
      datasetId: child.id, request: request(child.contract), consumer: { kind: 'answer', id: 'child-premature' },
    });
    expect(premature).toMatchObject({ state: 'blocked', code: 'conflict' });
    expect(premature.state === 'blocked' && premature.error).toMatch(/dirty.*ancestor/i);
    expect(environment.store.getHead(child.id)!.versionId).toBe(firstChildHead);
    expect(environment.storage.getDb().prepare(`
      SELECT COUNT(*) AS count FROM analytics_derived_runs WHERE dataset_id = ?
    `).get(child.id)).toEqual({ count: 1 });

    expect(await environment.derivation.processNext()).toBe(1);
    expect(await environment.derivation.processNext()).toBe(1);
    expect(environment.store.getHead(child.id)!.versionId).not.toBe(firstChildHead);
  });

  it('blocks a definition-bound coverage mismatch without starving unrelated dirty work', async () => {
    const environment = setup();
    const firstSourceDefinition = sourceDefinition('ds_r3_events');
    const secondSourceDefinition = sourceDefinition('ds_r3_other_events');
    environment.room.registerDataset(firstSourceDefinition);
    environment.room.registerDataset(secondSourceDefinition);
    ingest(environment, firstSourceDefinition.id, BASE_ROWS);
    ingest(environment, secondSourceDefinition.id, BASE_ROWS);
    const blockedTarget = environment.room.registerDataset(aggregateTarget('ds_r3_coverage_bound'));
    const healthyTarget = environment.room.registerDataset(aggregateTarget('ds_r3_unrelated', secondSourceDefinition.id));
    const blockedInitial = await environment.derivation.materialize({
      datasetId: blockedTarget.id, request: request(blockedTarget.contract), consumer: { kind: 'answer', id: 'coverage-initial' },
    });
    const healthyInitial = await environment.derivation.materialize({
      datasetId: healthyTarget.id, request: request(healthyTarget.contract), consumer: { kind: 'answer', id: 'healthy-initial' },
    });
    expect(blockedInitial.state).toBe('ready');
    expect(healthyInitial.state).toBe('ready');
    const healthyFirstHead = environment.store.getHead(healthyTarget.id)!.versionId;

    const revisedSource = structuredClone(firstSourceDefinition) as typeof firstSourceDefinition & { expectedDefinitionRevision: number };
    revisedSource.expectedDefinitionRevision = 1;
    revisedSource.contract.coverage.watermark = '2026-09-03T00:00:00.000Z';
    revisedSource.contract.contractSha256 = analyticsDatasetContractSha256(revisedSource.contract);
    environment.room.reviseDataset(revisedSource);
    ingest(environment, firstSourceDefinition.id, BASE_ROWS, 1);
    expect(await environment.derivation.processNext()).toBe(1);
    expect(environment.storage.getDb().prepare(`
      SELECT status, error FROM analytics_derived_dirty WHERE dataset_id = ?
    `).get(blockedTarget.id)).toMatchObject({
      status: 'blocked', error: expect.stringContaining('coverage/watermark'),
    });

    const changedOther = BASE_ROWS.map(row => [...row]);
    changedOther[0][4] = 99;
    ingest(environment, secondSourceDefinition.id, changedOther, 1);
    expect(await environment.derivation.processNext()).toBe(1);
    expect(environment.store.getHead(healthyTarget.id)!.versionId).not.toBe(healthyFirstHead);
    expect(environment.storage.getDb().prepare(`
      SELECT status FROM analytics_derived_dirty WHERE dataset_id = ?
    `).get(blockedTarget.id)).toEqual({ status: 'blocked' });
  });

  it('fails a many-to-one join with duplicate right keys before publishing any head', async () => {
    const environment = setup();
    environment.room.registerDataset(sourceDefinition('ds_r3_events'));
    ingest(environment, 'ds_r3_events', BASE_ROWS);
    const lookupSchema: AnalyticsFieldContract[] = [
      { name: 'event_date', logicalType: 'date', nullable: false },
      { name: 'region', logicalType: 'string', nullable: false },
      { name: 'segment', logicalType: 'string', nullable: false },
      { name: 'weight', logicalType: 'integer', nullable: false },
    ];
    const lookup = sourceDefinition('ds_r3_lookup', lookupSchema);
    lookup.contract = contract({
      datasetId: 'ds_r3_lookup', kind: 'source', schema: lookupSchema, metricField: 'weight',
      grain: 'day_region_segment', grainFields: ['event_date', 'region', 'segment'],
      availableDimensions: ['event_date', 'region', 'segment'], countingKey: 'region',
      relationalMeasures: [{ field: 'weight', unit: 'events', aggregation: 'sum', protected: false }],
    });
    environment.room.registerDataset(lookup);
    ingest(environment, lookup.id, [
      ['2026-09-01', 'IN', 'core', 1],
      ['2026-09-01', 'IN', 'duplicate', 1],
      ['2026-09-02', 'US', 'other', 1],
    ]);
    const output = contract({
      datasetId: 'ds_r3_joined', kind: 'derived',
      schema: [...EVENT_SCHEMA, { name: 'segment', logicalType: 'string', nullable: false }],
      metricField: 'events', grain: 'event_with_segment',
      grainFields: ['event_date', 'user_id', 'category'],
      availableDimensions: ['event_date', 'region', 'category', 'segment'], countingKey: 'user_id',
      relationalMeasures: [{ field: 'events', unit: 'events', aggregation: 'sum', protected: true }],
    });
    const target = environment.room.registerDataset(derivedDefinition({
      id: 'ds_r3_joined', outputContract: output,
      dependencies: [
        { alias: 'events_input', datasetId: 'ds_r3_events', versionPolicy: 'latest_compatible', requiredColumns: EVENT_SCHEMA.map(field => field.name) },
        { alias: 'lookup', datasetId: 'ds_r3_lookup', versionPolicy: 'latest_compatible', requiredColumns: ['event_date', 'region', 'segment'] },
      ],
      steps: [{
        id: 'joined', type: 'join', left: 'events_input', right: 'lookup', joinType: 'inner',
        leftKeys: ['event_date', 'region'], rightKeys: ['event_date', 'region'], cardinality: 'many_to_one',
        rightFields: [{ field: 'segment', as: 'segment' }], nullKeys: 'error', unmatched: 'error', maxFanout: 1,
      }],
      output: 'joined', metricValueColumn: 'events', rowDimensions: ['event_date', 'region', 'category', 'segment'],
    }));
    const outcome = await environment.derivation.materialize({
      datasetId: target.id,
      request: request(target.contract),
      consumer: { kind: 'answer', id: 'join-trap' },
    });
    expect(outcome).toMatchObject({ state: 'blocked', code: 'integrity_failed' });
    expect(outcome.state === 'blocked' && outcome.error).toMatch(/uniqueness/i);
    expect(environment.store.getHead(target.id)).toBeNull();
    expect(environment.store.listDatasetVersions(target.id)).toHaveLength(0);
  });

  it('terminalizes a queued obsolete definition and lets the current revision run next', async () => {
    const environment = setup();
    environment.room.registerDataset(sourceDefinition('ds_r3_events'));
    ingest(environment, 'ds_r3_events', BASE_ROWS);
    const definition = aggregateTarget('ds_r3_revision');
    const target = environment.room.registerDataset(definition);
    const queued = environment.derivation.beginOrJoin({
      datasetId: target.id, request: request(target.contract), consumer: { kind: 'answer', id: 'revision-old' },
    });
    expect(queued.state).toBe('pending');
    if (queued.state !== 'pending') return;
    environment.room.reviseDataset({
      ...structuredClone(definition),
      name: 'revised target',
      expectedDefinitionRevision: 1,
    });
    expect(await environment.derivation.processNext()).toBe(1);
    expect(environment.derivation.getRun(queued.run.id)).toMatchObject({
      status: 'failed', error: expect.stringContaining('definition changed'),
    });
    expect(environment.storage.getDb().prepare(`
      SELECT status FROM analytics_derived_dirty WHERE dataset_id = ?
    `).get(target.id)).toEqual({ status: 'pending' });
    expect(await environment.derivation.processNext()).toBe(1);
    expect(environment.store.getDataset(target.id)).toMatchObject({
      definitionRevision: 2,
      head: { definitionRevision: 2 },
    });
    expect(environment.storage.getDb().prepare(`
      SELECT status, COUNT(*) AS count FROM analytics_derived_runs
      WHERE dataset_id = ? GROUP BY status ORDER BY status
    `).all(target.id)).toEqual([
      { status: 'completed', count: 1 },
      { status: 'failed', count: 1 },
    ]);
  });

  it('requeues a transient conflict without poisoning the materialization key', async () => {
    const environment = setup();
    environment.room.registerDataset(sourceDefinition('ds_r3_events'));
    ingest(environment, 'ds_r3_events', BASE_ROWS);
    const target = environment.room.registerDataset(aggregateTarget('ds_r3_transient'));
    let failOnce = true;
    const transient = createAnalyticsDerivationService({
      db: environment.storage.getDb(),
      store: environment.store,
      now: () => NOW,
      beforeExecute: () => {
        if (!failOnce) return;
        failOnce = false;
        throw new AnalyticsDataRoomError('conflict', 'temporary local I/O');
      },
    });
    const first = await transient.materialize({
      datasetId: target.id, request: request(target.contract), consumer: { kind: 'answer', id: 'transient-1' },
    });
    expect(first).toMatchObject({ state: 'blocked', code: 'conflict' });
    expect(environment.storage.getDb().prepare('SELECT status FROM analytics_derived_runs').get())
      .toEqual({ status: 'queued' });
    const second = await transient.materialize({
      datasetId: target.id, request: request(target.contract), consumer: { kind: 'answer', id: 'transient-2' },
    });
    expect(second.state).toBe('ready');
    expect(second.state === 'ready' && second.run).toMatchObject({ status: 'completed' });
    if (second.state === 'ready') {
      expect(second.run.error).toBeUndefined();
      expect(second.run.nextAction).toBeUndefined();
    }
    expect(environment.storage.getDb().prepare(`
      SELECT COUNT(*) AS count FROM analytics_derived_run_assertions
      WHERE assertion_id = 'derived_run_failure'
    `).get()).toEqual({ count: 0 });
  });

  it('finalizes an expired post-publication run without re-executing or wedging the target', async () => {
    const environment = setup();
    environment.room.registerDataset(sourceDefinition('ds_r3_events'));
    ingest(environment, 'ds_r3_events', BASE_ROWS);
    const target = environment.room.registerDataset(aggregateTarget('ds_r3_post_publish'));
    const first = await environment.derivation.materialize({
      datasetId: target.id, request: request(target.contract), consumer: { kind: 'answer', id: 'publish-first' },
    });
    expect(first.state).toBe('ready');
    if (first.state !== 'ready') return;
    environment.storage.getDb().prepare(`
      UPDATE analytics_derived_runs
      SET status = 'running', lease_owner = 'dead', lease_expires_at = ?, completed_at = NULL, receipt_json = NULL
      WHERE id = ?
    `).run('2020-01-01T00:00:00.000Z', first.run.id);

    let executed = 0;
    const recovered = createAnalyticsDerivationService({
      db: environment.storage.getDb(), store: environment.store, now: () => NOW,
      beforeExecute: () => { executed += 1; },
    });
    expect(recovered.getRun(first.run.id)).toMatchObject({
      status: 'completed', outputVersionId: first.version.id,
      receipt: { recoveredAfterPublish: true },
    });
    const repeated = await recovered.materialize({
      datasetId: target.id, request: request(target.contract), consumer: { kind: 'answer', id: 'publish-repeat' },
    });
    expect(repeated).toMatchObject({ state: 'ready', joinedExisting: true });
    expect(executed).toBe(0);
    expect(environment.storage.getDb().prepare('SELECT COUNT(*) AS count FROM analytics_derived_runs').get())
      .toEqual({ count: 1 });
  });

  it('reopens a queued run from file-backed SQLite and executes the original persisted pins', async () => {
    const directory = tempDir();
    const databasePath = path.join(directory, 'tracker.db');
    const rootDir = path.join(directory, 'room');
    const first = setup({ databasePath, rootDir });
    first.room.registerDataset(sourceDefinition('ds_r3_events'));
    const source = ingest(first, 'ds_r3_events', BASE_ROWS);
    const target = first.room.registerDataset(aggregateTarget('ds_r3_restart'));
    const queued = first.derivation.beginOrJoin({
      datasetId: target.id,
      request: request(target.contract),
      consumer: { kind: 'dashboard_widget', id: 'dash-restart/widget-1' },
    });
    expect(queued.state).toBe('pending');
    if (queued.state !== 'pending') return;
    const runId = queued.run.id;
    const beforePins = first.storage.getDb().prepare(`
      SELECT alias, input_version_id, content_sha256 FROM analytics_derived_run_inputs WHERE run_id = ?
    `).all(runId);
    first.storage.close();
    storages.splice(storages.indexOf(first.storage), 1);

    const reopened = setup({ databasePath, rootDir });
    expect(await reopened.derivation.processNext()).toBe(1);
    expect(reopened.derivation.getRun(runId)).toMatchObject({
      status: 'completed', outputVersionId: expect.any(String),
    });
    expect(reopened.storage.getDb().prepare(`
      SELECT alias, input_version_id, content_sha256 FROM analytics_derived_run_inputs WHERE run_id = ?
    `).all(runId)).toEqual(beforePins);
    const outputVersionId = reopened.derivation.getRun(runId)!.outputVersionId!;
    expect(reopened.store.getDatasetVersion(outputVersionId)?.derivation?.inputs[0].versionId).toBe(source.version.id);
  });

  it('answers ready_derived locally with lineage receipts and zero connector calls', async () => {
    const environment = setup();
    environment.room.registerDataset(sourceDefinition('ds_r3_events'));
    const source = ingest(environment, 'ds_r3_events', BASE_ROWS);
    const target = environment.room.registerDataset(aggregateTarget('ds_r3_answer'));
    const remote = {
      availability: vi.fn(async () => ({ sqlUsable: true, etlUsable: true })),
      execute: vi.fn(async () => { throw new Error('remote execution must not run'); }),
      readEtlRun: vi.fn(async () => { throw new Error('remote continuation must not run'); }),
    } satisfies AnalyticsAnswerRemoteRuntime;
    const answer = createAnalyticsAnswerService({
      db: environment.storage.getDb(),
      store: environment.store,
      localQuery: createAnalyticsLocalQueryEngine({ store: environment.store }),
      derivation: environment.derivation,
      remote,
      now: () => NOW,
    });
    const first = await answer.answer({
      request: request(target.contract),
      metricValueColumn: 'total_events',
      warehouseSql: 'DROP TABLE should_be_ignored',
    });
    expect(first).toMatchObject({
      status: 'answered',
      decision: { kind: 'ready_derived' },
      answer: {
        receipt: {
          sourceKind: 'data_room_derived',
          executionKind: 'local_derivation',
          inputVersionIds: [source.version.id],
        },
      },
      execution: { laneProbes: 0, remoteExecutions: 0, localQueries: 1 },
    });
    expect(remote.availability).not.toHaveBeenCalled();
    expect(remote.execute).not.toHaveBeenCalled();
    expect(remote.readEtlRun).not.toHaveBeenCalled();

    const second = await answer.answer({
      request: request(target.contract),
      metricValueColumn: 'total_events',
      warehouseSql: 'DROP TABLE still_ignored',
    });
    expect(second).toMatchObject({
      status: 'answered',
      decision: { kind: 'ready_materialized' },
      answer: { receipt: { sourceKind: 'data_room_derived', executionKind: 'materialized_answer' } },
      execution: { laneProbes: 0, remoteExecutions: 0, localQueries: 1 },
    });
    expect(environment.storage.getDb().prepare('SELECT COUNT(*) AS count FROM analytics_derived_runs').get())
      .toEqual({ count: 1 });
  });
});

describe('analytics data-room R3 independent scheduler slot', () => {
  it('never overlaps two derivation ticks', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const derivation = {
      recoverExpired: vi.fn(() => 0),
      processNext: vi.fn(async () => {
        entered();
        await gate;
        return 1;
      }),
    } as unknown as AnalyticsDerivationService;
    const scheduler = createAnalyticsDataRoomScheduler({ derivation, intervalMs: 60_000 });
    const first = scheduler.tick();
    await started;
    expect(await scheduler.tick()).toBe(0);
    release();
    expect(await first).toBe(1);
    expect(derivation.processNext).toHaveBeenCalledTimes(1);
    scheduler.start();
    expect(scheduler.running).toBe(true);
    scheduler.stop();
    expect(scheduler.running).toBe(false);
  });
});