import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStorage, type StorageLayer } from './storage.js';
import {
  analyticsDatasetContractSha256,
  analyticsDatasetSchemaSha256,
  createAnalyticsDataRoomStore,
  type AnalyticsDataRoomStore,
} from './analytics-data-room-store.js';
import {
  analyticsRequestSha256,
  analyticsSha256,
} from './analytics-data-room-policy.js';
import { createAnalyticsDataRoomBackupService } from './analytics-data-room-backup.js';
import { createAnalyticsDataRoomService, type AnalyticsDataRoomService } from './analytics-data-room-service.js';
import {
  compileAnalyticsLocalQuery,
  createAnalyticsLocalQueryEngine,
  type AnalyticsLocalQueryEngine,
} from './analytics-data-room-query.js';
import {
  createAnalyticsAnswerService,
  createManagedAnalyticsAnswerRuntime,
  type AnalyticsAnswerRemoteRuntime,
  type AnalyticsAnswerService,
  type AnalyticsRemoteOutcome,
} from './analytics-data-room-answer.js';
import type {
  AnalyticsAnswerRequest,
  AnalyticsDataCell,
  AnalyticsDatasetContract,
  AnalyticsDatasetDefinitionInput,
  AnalyticsRequest,
} from './analytics-data-room-types.js';

const NOW = new Date('2026-09-03T00:00:00.000Z');
const temporaryDirectories: string[] = [];
const storages: StorageLayer[] = [];

function temporaryDirectory(): string {
  const value = fs.mkdtempSync(path.join(os.tmpdir(), 'analytics-r2-'));
  temporaryDirectories.push(value);
  return value;
}

function contract(datasetId: string): AnalyticsDatasetContract {
  const schema: AnalyticsDatasetContract['schema'] = [
    { name: 'event_date', logicalType: 'date', physicalType: 'DATE', nullable: false },
    { name: 'region', logicalType: 'string', physicalType: 'VARCHAR', nullable: false },
    { name: 'metric_value', logicalType: 'integer', physicalType: 'BIGINT', nullable: false },
    { name: 'flag', logicalType: 'boolean', physicalType: 'BOOLEAN', nullable: false },
    { name: 'note', logicalType: 'string', physicalType: 'VARCHAR', nullable: true },
  ];
  const base: AnalyticsDatasetContract = {
    contractVersion: '1',
    contractSha256: '',
    status: 'active',
    datasetId,
    datasetKind: 'source',
    scope: 'workspace',
    domainKey: 'r2-test',
    schemaSha256: analyticsDatasetSchemaSha256(schema),
    schema,
    metric: { id: 'daily_events', version: '1', definitionSha256: '1'.repeat(64), unit: 'events' },
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
      allowedUses: ['local_answer', 'dashboard'],
      allowModelContext: true,
      allowPublication: false,
    },
  };
  return { ...base, contractSha256: analyticsDatasetContractSha256(base) };
}

function definition(datasetId: string): AnalyticsDatasetDefinitionInput {
  return {
    id: datasetId,
    name: 'R2 exact daily events',
    description: 'Synthetic exact-grain answer fixture',
    kind: 'source',
    scope: 'workspace',
    domainKey: 'r2-test',
    ownerId: 'owner-test',
    lifecycle: 'active',
    sourceKind: 'sql_context',
    sourceFormat: 'canonical_json',
    definition: {
      source: 'fixture',
      answer: {
        version: 1,
        metricId: 'daily_events',
        metricValueColumn: 'metric_value',
        rowDimensions: ['event_date', 'region'],
        filterableFields: ['event_date', 'region', 'flag', 'note'],
        stableOrder: [
          { field: 'event_date', direction: 'asc' },
          { field: 'region', direction: 'asc' },
        ],
      },
    },
    contract: contract(datasetId),
    retention: { minimumVersions: 1, automaticExpiry: false, reacquirable: true, backupRequired: false },
  };
}

function analyticsRequest(patch: Partial<AnalyticsRequest> = {}): AnalyticsRequest {
  return {
    domainKey: 'r2-test',
    metric: { id: 'daily_events', version: '1', definitionSha256: '1'.repeat(64), unit: 'events' },
    dimensions: ['event_date', 'region'],
    filters: [],
    dateRange: { start: '2026-09-01', end: '2026-09-02' },
    timeZone: 'UTC',
    countingKey: 'region',
    regime: { id: 'valid_events', version: '1', definitionSha256: '2'.repeat(64) },
    requiredGrain: 'day_region',
    freshness: { mode: 'fresh_by', maxAgeMs: 24 * 60 * 60_000 },
    use: 'local_answer',
    resultLimit: 200,
    ...patch,
  };
}

function answerRequest(request = analyticsRequest()): AnalyticsAnswerRequest {
  return {
    request,
    metricValueColumn: 'metric_value',
    warehouseSql: 'SELECT event_date, region, SUM(event_count) AS metric_value FROM events GROUP BY event_date, region',
  };
}

function completeRemote(
  sourceKind: 'sql_context' | 'datanet_etl' = 'sql_context',
  querySha256?: string,
): AnalyticsRemoteOutcome {
  return {
    state: 'complete',
    sourceKind,
    result: {
      columns: ['event_date', 'region', 'metric_value'],
      rows: [['2026-09-01', 'IN', 10]],
      rowCount: 1,
      displayedRowCount: 1,
      truncated: false,
    },
    sourceReceipt: {
      sourceKind,
      ...(sourceKind === 'datanet_etl' ? { sourceId: '7001', submittedAgain: false } : {}),
      ...(querySha256 ? { querySha256 } : {}),
      producerVersion: 'test-1',
      acquiredAt: NOW.toISOString(),
    },
  };
}

function remoteRuntime(options: {
  lanes?: { sqlUsable: boolean; etlUsable: boolean };
  execute?: (input: Parameters<AnalyticsAnswerRemoteRuntime['execute']>[0]) => Promise<AnalyticsRemoteOutcome>;
  read?: (runId: string) => Promise<AnalyticsRemoteOutcome>;
} = {}) {
  return {
    availability: vi.fn(async () => options.lanes ?? { sqlUsable: true, etlUsable: true }),
    execute: vi.fn(options.execute ?? (async () => completeRemote('sql_context'))),
    readEtlRun: vi.fn(options.read ?? (async () => completeRemote('datanet_etl'))),
  } satisfies AnalyticsAnswerRemoteRuntime;
}

function setup(remote = remoteRuntime()): {
  storage: StorageLayer;
  store: AnalyticsDataRoomStore;
  dataRoom: AnalyticsDataRoomService;
  query: AnalyticsLocalQueryEngine;
  answer: AnalyticsAnswerService;
  remote: ReturnType<typeof remoteRuntime>;
  root: string;
} {
  const storage = createStorage(':memory:');
  storage.initialize();
  storages.push(storage);
  const root = temporaryDirectory();
  const store = createAnalyticsDataRoomStore({ db: storage.getDb(), rootDir: root, now: () => NOW });
  const backups = createAnalyticsDataRoomBackupService({ db: storage.getDb(), store, now: () => NOW });
  const dataRoom = createAnalyticsDataRoomService({ store, backups });
  const query = createAnalyticsLocalQueryEngine({ store });
  const answer = createAnalyticsAnswerService({
    db: storage.getDb(), store, localQuery: query, remote, now: () => NOW,
  });
  return { storage, store, dataRoom, query, answer, remote, root };
}

function publishFixture(environment: ReturnType<typeof setup>, datasetId = 'ds_r2_exact') {
  environment.dataRoom.registerDataset(definition(datasetId));
  const columns = ['event_date', 'region', 'metric_value', 'flag', 'note'];
  const rows = [
    ['2026-09-01', 'IN', 10, true, null],
    ['2026-09-01', 'US', 20, false, 'other'],
    ['2026-09-02', 'IN', 30, true, 'latest'],
    ['2026-09-02', 'US', 40, false, null],
  ] as AnalyticsDataCell[][];
  return environment.dataRoom.ingestSqlRows({
    datasetId,
    expectedHeadRevision: 0,
    materializedAt: '2026-09-03T00:00:00.000Z',
    sourceReceipt: {
      sourceKind: 'sql_context', querySha256: '4'.repeat(64),
      producerVersion: 'fixture-1', acquiredAt: NOW.toISOString(),
    },
    quality: [{ assertionId: 'unique_grain', assertionVersion: '1', severity: 'error', success: true }],
    columns,
    rows,
    rowCount: rows.length,
    displayedRowCount: rows.length,
    truncated: false,
  });
}

afterEach(() => {
  while (storages.length) storages.pop()?.close();
  while (temporaryDirectories.length) fs.rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
});

describe('analytics data-room R2 local query compiler and worker', () => {
  let environment: ReturnType<typeof setup>;

  beforeEach(() => {
    environment = setup();
    publishFixture(environment);
  });

  it('keeps hostile filter values in parameters and returns exact bounded typed rows without changing the sidecar', async () => {
    const dataset = environment.store.getDataset('ds_r2_exact')!;
    const version = environment.store.getDatasetVersion(dataset.head!.versionId)!;
    const hostile = `IN') OR 1=1 --`;
    const compiledHostile = compileAnalyticsLocalQuery({
      dataset,
      version,
      request: analyticsRequest({ filters: [{ field: 'region', operator: 'eq', value: hostile }] }),
    });
    expect(compiledHostile.sql).not.toContain(hostile);
    expect(compiledHostile.params).toContain(hostile);
    expect(compiledHostile.sql).not.toMatch(/\b(?:JOIN|GROUP|WITH|INSERT|UPDATE|DELETE)\b/i);
    expect(compiledHostile.sql.endsWith(';')).toBe(false);

    const sidecarPath = environment.store.getVerifiedMaterializedPath(version.id, 'local_answer');
    const before = createHash('sha256').update(fs.readFileSync(sidecarPath)).digest('hex');
    const result = await environment.query.execute({
      dataset,
      version,
      request: analyticsRequest({
        resultLimit: 1,
        filters: [
          { field: 'region', operator: 'in', value: ['IN', null] },
          { field: 'flag', operator: 'eq', value: true },
        ],
      }),
    });
    const after = createHash('sha256').update(fs.readFileSync(sidecarPath)).digest('hex');
    expect(after).toBe(before);
    expect(result.result).toEqual({
      columns: ['event_date', 'region', 'metric_value'],
      rows: [['2026-09-01', 'IN', 10]],
      rowCount: 2,
      displayedRowCount: 1,
      truncated: true,
    });
    expect(result.receipt).toMatchObject({ versionId: version.id, rowLimit: 1, byteLimit: 40_000 });

    const tinyByteEngine = createAnalyticsLocalQueryEngine({ store: environment.store, byteLimit: 8 });
    const byteBounded = await tinyByteEngine.execute({ dataset, version, request: analyticsRequest() });
    expect(byteBounded.result.rowCount).toBe(4);
    expect(byteBounded.result.displayedRowCount).toBe(0);
    expect(byteBounded.result.truncated).toBe(true);
  });

  it('applies one allowlisted global sort before stable ties and LIMIT while legacy compilation stays v1', async () => {
    const dataset = environment.store.getDataset('ds_r2_exact')!;
    const version = environment.store.getDatasetVersion(dataset.head!.versionId)!;
    const request = analyticsRequest({
      use: 'dashboard', datasetId: dataset.id, versionId: version.id, resultLimit: 2,
    });
    const viewRequest = { version: 1 as const, request, sort: { field: 'region', direction: 'desc' as const } };
    const view = {
      viewRequest,
      controlDefinitionSha256: 'a'.repeat(64),
      controlValuesSha256: 'b'.repeat(64),
      effectiveViewRequestSha256: analyticsSha256(viewRequest),
    };
    const legacy = environment.query.compile({ dataset, version, request });
    const compiled = environment.query.compile({ dataset, version, request, view });
    expect(legacy.compilerVersion).toBe('sqlite-projection-v1');
    expect(legacy).not.toHaveProperty('effectiveViewRequestSha256');
    expect(compiled.compilerVersion).toBe('sqlite-dashboard-view-v1');
    expect(compiled.sql).toContain('ORDER BY "region" DESC, "event_date" ASC, rowid ASC LIMIT ?');
    expect(compiled).toMatchObject({
      effectiveViewRequestSha256: view.effectiveViewRequestSha256,
      controlDefinitionSha256: view.controlDefinitionSha256,
      controlValuesSha256: view.controlValuesSha256,
    });
    const result = await environment.query.execute({ dataset, version, request, view });
    expect(result.result).toEqual({
      columns: ['event_date', 'region', 'metric_value'],
      rows: [['2026-09-01', 'US', 20], ['2026-09-02', 'US', 40]],
      rowCount: 4,
      displayedRowCount: 2,
      truncated: true,
    });
  });

  it('rejects regrouping, unknown filters, oversized IN lists, and an already-aborted query', async () => {
    const dataset = environment.store.getDataset('ds_r2_exact')!;
    const version = environment.store.getDatasetVersion(dataset.head!.versionId)!;
    expect(() => environment.query.compile({
      dataset, version, request: analyticsRequest({ dimensions: ['event_date'] }),
    })).toThrow(/regrouping/i);
    expect(() => environment.query.compile({
      dataset, version, request: analyticsRequest({ filters: [{ field: 'metric_value', operator: 'gte', value: 1 }] }),
    })).toThrow(/not approved/i);
    expect(() => environment.query.compile({
      dataset,
      version,
      request: analyticsRequest({
        filters: [{ field: 'region', operator: 'in', value: Array.from({ length: 101 }, (_, index) => `R${index}`) }],
      }),
    })).toThrow(/100 IN values/i);

    const timestampDataset = structuredClone(dataset);
    const timestampVersion = structuredClone(version);
    timestampDataset.contract.schema[0].logicalType = 'timestamp';
    timestampDataset.contract.timeZone = 'America/Los_Angeles';
    timestampVersion.contract.schema[0].logicalType = 'timestamp';
    timestampVersion.contract.timeZone = 'America/Los_Angeles';
    const dstQuery = environment.query.compile({
      dataset: timestampDataset,
      version: timestampVersion,
      request: analyticsRequest({
        dateRange: { start: '2026-03-08', end: '2026-03-08' },
        timeZone: 'America/Los_Angeles',
        freshness: { mode: 'allow_stale' },
      }),
    });
    expect(dstQuery.params.slice(0, 2)).toEqual([
      '2026-03-08T08:00:00.000Z',
      '2026-03-09T07:00:00.000Z',
    ]);

    const controller = new AbortController();
    controller.abort();
    await expect(environment.query.execute({ dataset, version, request: analyticsRequest(), signal: controller.signal }))
      .rejects.toMatchObject({ code: 'query_cancelled' });

    const activeController = new AbortController();
    const activeQuery = environment.query.execute({ dataset, version, request: analyticsRequest(), signal: activeController.signal });
    activeController.abort();
    await expect(activeQuery).rejects.toMatchObject({ code: 'query_cancelled' });

    const timeoutEngine = createAnalyticsLocalQueryEngine({
      store: environment.store,
      timeoutMs: 50,
      workerSource: `setInterval(() => {}, 1000);`,
    });
    await expect(timeoutEngine.execute({ dataset, version, request: analyticsRequest() }))
      .rejects.toMatchObject({ code: 'query_timeout' });
  });
});

describe('analytics data-room R2 deterministic answer composite', () => {
  it('answers an exact room hit with zero lane probes or remote executions even when fallback SQL is invalid', async () => {
    const environment = setup();
    const published = publishFixture(environment);
    const outcome = await environment.answer.answer({
      ...answerRequest(analyticsRequest({ filters: [{ field: 'region', operator: 'eq', value: 'IN' }] })),
      warehouseSql: 'DROP TABLE data',
    });
    expect(outcome.status).toBe('answered');
    if (outcome.status !== 'answered') return;
    expect(outcome.decision.kind).toBe('ready_materialized');
    expect(outcome.answer.result.rows).toEqual([
      ['2026-09-01', 'IN', 10],
      ['2026-09-02', 'IN', 30],
    ]);
    expect(outcome.answer.receipt).toMatchObject({
      sourceKind: 'data_room_materialized',
      versionIds: [published.version.id],
      sourceDecision: { kind: 'ready_materialized' },
    });
    expect(outcome.execution).toMatchObject({ laneProbes: 0, remoteExecutions: 0, localQueries: 1 });
    expect(environment.remote.availability).not.toHaveBeenCalled();
    expect(environment.remote.execute).not.toHaveBeenCalled();
    expect(environment.remote.readEtlRun).not.toHaveBeenCalled();
  });

  it('chooses SQL once on a miss and never falls through to ETL after an attempted SQL failure', async () => {
    const runtime = remoteRuntime({
      lanes: { sqlUsable: true, etlUsable: true },
      execute: async input => ({
        state: 'failed', sourceKind: input.decision === 'refresh_sql' ? 'sql_context' : 'datanet_etl',
        code: 'remote_failed', error: 'warehouse query failed', nextAction: 'Fix SQL.',
      }),
    });
    const environment = setup(runtime);
    const outcome = await environment.answer.answer(answerRequest());
    expect(outcome).toMatchObject({ status: 'failed', decision: { kind: 'refresh_sql' }, code: 'remote_failed' });
    expect(runtime.availability).toHaveBeenCalledTimes(1);
    expect(runtime.execute).toHaveBeenCalledTimes(1);
    expect(runtime.execute.mock.calls[0][0].decision).toBe('refresh_sql');
    expect(runtime.readEtlRun).not.toHaveBeenCalled();
  });

  it('does not misreport a non-unique attempt-journal failure as an active request', async () => {
    const runtime = remoteRuntime({ lanes: { sqlUsable: true, etlUsable: false } });
    const environment = setup(runtime);
    environment.storage.getDb().exec(`
      CREATE TRIGGER fail_answer_attempt_insert
      BEFORE INSERT ON analytics_answer_attempts
      BEGIN
        SELECT RAISE(ABORT, 'attempt journal unavailable');
      END;
    `);
    await expect(environment.answer.answer(answerRequest())).rejects.toThrow(/attempt journal unavailable/);
    expect(runtime.availability).toHaveBeenCalledTimes(1);
    expect(runtime.execute).not.toHaveBeenCalled();
  });

  it('never lets a stale pending completion resurrect an attempt completed by a concurrent reader', async () => {
    let checkpointed!: () => void;
    const checkpointReady = new Promise<void>(resolve => { checkpointed = resolve; });
    let releaseFirst!: () => void;
    const firstMayReturn = new Promise<void>(resolve => { releaseFirst = resolve; });
    const runtime = remoteRuntime({
      lanes: { sqlUsable: false, etlUsable: true },
      execute: async input => {
        await input.onEtlSubmitted('7001');
        checkpointed();
        await firstMayReturn;
        return {
          state: 'pending', sourceKind: 'datanet_etl', runId: '7001', remoteStatus: 'EXECUTING',
          sourceReceipt: {
            sourceKind: 'datanet_etl', sourceId: '7001', producerVersion: 'test',
            acquiredAt: NOW.toISOString(), submittedAgain: false,
          },
          nextAction: 'Wait and read this exact run only.',
        };
      },
      read: async () => completeRemote('datanet_etl'),
    });
    const environment = setup(runtime);
    const first = environment.answer.answer(answerRequest());
    await checkpointReady;
    const concurrent = await environment.answer.answer(answerRequest());
    expect(concurrent).toMatchObject({ status: 'answered' });
    releaseFirst();
    await expect(first).rejects.toMatchObject({ code: 'conflict' });
    expect(environment.storage.getDb().prepare(`
      SELECT status, remote_run_id FROM analytics_answer_attempts
    `).get()).toEqual({ status: 'completed', remote_run_id: '7001' });
    expect(runtime.execute).toHaveBeenCalledTimes(1);
    expect(runtime.readEtlRun).toHaveBeenCalledTimes(1);
  });

  it('resumes one checkpointed ETL run by request identity even when fallback text and alias change', async () => {
    let first = true;
    const runtime = remoteRuntime({
      lanes: { sqlUsable: false, etlUsable: true },
      execute: async input => {
        await input.onEtlSubmitted('7001');
        first = false;
        return {
          state: 'pending', sourceKind: 'datanet_etl', runId: '7001', remoteStatus: 'EXECUTING',
          sourceReceipt: {
            sourceKind: 'datanet_etl', sourceId: '7001', producerVersion: 'test',
            acquiredAt: NOW.toISOString(), submittedAgain: false,
          },
          nextAction: 'Wait and read this exact run only.',
        };
      },
      read: async runId => {
        expect(first).toBe(false);
        expect(runId).toBe('7001');
        return completeRemote('datanet_etl');
      },
    });
    const environment = setup(runtime);
    const initial = answerRequest();
    const initialQuerySha256 = analyticsSha256(initial.warehouseSql);
    const pending = await environment.answer.answer(initial);
    expect(pending).toMatchObject({ status: 'pending', runId: '7001', decision: { kind: 'refresh_etl' } });

    const answered = await environment.answer.answer({
      ...answerRequest(),
      metricValueColumn: 'ignored_replacement_alias',
      warehouseSql: '  SELECT event_date, region, SUM(event_count) AS metric_value\nFROM events\nGROUP BY event_date, region  ',
    });
    expect(answered).toMatchObject({
      status: 'answered',
      decision: { kind: 'refresh_etl' },
      answer: { receipt: { remoteSourceReceipt: { querySha256: initialQuerySha256 } } },
      execution: { laneProbes: 0, remoteExecutions: 1 },
    });
    expect(runtime.availability).toHaveBeenCalledTimes(1);
    expect(runtime.execute).toHaveBeenCalledTimes(1);
    expect(runtime.readEtlRun).toHaveBeenCalledTimes(1);
    const attempts = environment.storage.getDb().prepare(`
      SELECT status, remote_run_id, query_sha256, metric_value_column
      FROM analytics_answer_attempts ORDER BY created_at, id
    `).all();
    expect(attempts).toEqual([{
      status: 'completed',
      remote_run_id: '7001',
      query_sha256: initialQuerySha256,
      metric_value_column: 'metric_value',
    }]);
  });

  it('fails closed on stale unknown ETL submission but permits a stale read-only SQL retry', async () => {
    const request = analyticsRequest();
    const requestSha256 = analyticsRequestSha256(request);
    const staleAt = '2026-09-02T00:00:00.000Z';
    const etlRuntime = remoteRuntime({ lanes: { sqlUsable: false, etlUsable: true } });
    const etlEnvironment = setup(etlRuntime);
    etlEnvironment.storage.getDb().prepare(`
      INSERT INTO analytics_answer_attempts
        (id, request_sha256, query_sha256, metric_value_column, source_decision, source_kind,
         status, created_at, updated_at)
      VALUES ('answer_stale_etl', ?, ?, 'metric_value', 'refresh_etl', 'datanet_etl',
        'running', ?, ?)
    `).run(requestSha256, analyticsSha256('SELECT stale_etl'), staleAt, staleAt);

    const blocked = await etlEnvironment.answer.answer({
      ...answerRequest(request),
      warehouseSql: 'SELECT replacement_query',
    });
    expect(blocked).toMatchObject({
      status: 'blocked', code: 'conflict', decision: { kind: 'refresh_etl' },
      execution: { laneProbes: 0, remoteExecutions: 0 },
    });
    expect(blocked.status === 'blocked' && blocked.error).toMatch(/cannot prove whether Datanet accepted/i);
    expect(etlRuntime.availability).not.toHaveBeenCalled();
    expect(etlRuntime.execute).not.toHaveBeenCalled();
    expect(etlEnvironment.storage.getDb().prepare(`
      SELECT status, remote_status, completed_at FROM analytics_answer_attempts WHERE id = 'answer_stale_etl'
    `).get()).toEqual({ status: 'waiting_remote', remote_status: 'SUBMISSION_UNKNOWN', completed_at: null });

    const sqlRuntime = remoteRuntime({ lanes: { sqlUsable: true, etlUsable: false } });
    const sqlEnvironment = setup(sqlRuntime);
    sqlEnvironment.storage.getDb().prepare(`
      INSERT INTO analytics_answer_attempts
        (id, request_sha256, query_sha256, metric_value_column, source_decision, source_kind,
         status, created_at, updated_at)
      VALUES ('answer_stale_sql', ?, ?, 'metric_value', 'refresh_sql', 'sql_context',
        'running', ?, ?)
    `).run(requestSha256, analyticsSha256('SELECT stale_sql'), staleAt, staleAt);
    const retried = await sqlEnvironment.answer.answer(answerRequest(request));
    expect(retried).toMatchObject({ status: 'answered', decision: { kind: 'refresh_sql' } });
    expect(sqlRuntime.availability).toHaveBeenCalledTimes(1);
    expect(sqlRuntime.execute).toHaveBeenCalledTimes(1);
    expect(sqlEnvironment.storage.getDb().prepare(`
      SELECT status FROM analytics_answer_attempts WHERE id = 'answer_stale_sql'
    `).get()).toEqual({ status: 'failed' });
  });

  it('holds an ambiguous ETL submit outcome under the request lock without a second probe', async () => {
    const runtime = remoteRuntime({
      lanes: { sqlUsable: false, etlUsable: true },
      execute: async () => ({
        state: 'failed',
        sourceKind: 'datanet_etl',
        code: 'remote_failed',
        error: 'Submit transport timed out.',
        nextAction: 'Do not resubmit.',
        submissionUnknown: true,
      }),
    });
    const environment = setup(runtime);
    const first = await environment.answer.answer(answerRequest());
    expect(first).toMatchObject({
      status: 'blocked', code: 'conflict', decision: { kind: 'refresh_etl' },
    });
    expect(environment.storage.getDb().prepare(`
      SELECT status, remote_run_id, remote_status, completed_at FROM analytics_answer_attempts
    `).get()).toEqual({
      status: 'waiting_remote', remote_run_id: null, remote_status: 'SUBMISSION_UNKNOWN', completed_at: null,
    });

    const repeated = await environment.answer.answer({
      ...answerRequest(),
      warehouseSql: 'SELECT changed_after_unknown_submit',
    });
    expect(repeated).toMatchObject({
      status: 'blocked', code: 'conflict', execution: { laneProbes: 0, remoteExecutions: 0 },
    });
    expect(runtime.availability).toHaveBeenCalledTimes(1);
    expect(runtime.execute).toHaveBeenCalledTimes(1);
    expect(runtime.readEtlRun).not.toHaveBeenCalled();
  });

  it('keeps a checkpointed ETL attempt active when its remote query receipt conflicts', async () => {
    const runtime = remoteRuntime({
      lanes: { sqlUsable: false, etlUsable: true },
      execute: async input => {
        await input.onEtlSubmitted('7001');
        return completeRemote('datanet_etl', 'f'.repeat(64));
      },
    });
    const environment = setup(runtime);
    const outcome = await environment.answer.answer(answerRequest());
    expect(outcome).toMatchObject({
      status: 'blocked', code: 'conflict', decision: { kind: 'refresh_etl' },
    });
    expect(environment.storage.getDb().prepare(`
      SELECT status, remote_run_id, remote_status, completed_at
      FROM analytics_answer_attempts
    `).get()).toEqual({
      status: 'waiting_remote', remote_run_id: '7001', remote_status: 'RECEIPT_CONFLICT', completed_at: null,
    });
    const repeated = await environment.answer.answer({
      ...answerRequest(),
      warehouseSql: 'SELECT textually_different_query',
    });
    expect(repeated).toMatchObject({ execution: { laneProbes: 0 } });
    expect(runtime.availability).toHaveBeenCalledTimes(1);
    expect(runtime.execute).toHaveBeenCalledTimes(1);
    expect(runtime.readEtlRun).toHaveBeenCalledTimes(1);
  });

  it('clarifies before catalog access and blocks no-lane or exact-version misses with zero execution', async () => {
    const runtime = remoteRuntime({ lanes: { sqlUsable: false, etlUsable: false } });
    const environment = setup(runtime);
    const catalogSpy = vi.spyOn(environment.store, 'findDatasetsForRequest');
    const clarification = await environment.answer.answer(answerRequest(analyticsRequest({
      unresolvedSemantics: ['countingKey'],
    })));
    expect(clarification).toMatchObject({ status: 'clarification_required', clarificationFields: ['countingKey'] });
    expect(catalogSpy).not.toHaveBeenCalled();
    expect(runtime.availability).not.toHaveBeenCalled();

    const noLane = await environment.answer.answer(answerRequest());
    expect(noLane).toMatchObject({ status: 'blocked', decision: { kind: 'blocked_no_lane' } });
    expect(runtime.execute).not.toHaveBeenCalled();

    environment.dataRoom.registerDataset(definition('ds_r2_pin'));
    const exact = await environment.answer.answer(answerRequest(analyticsRequest({
      datasetId: 'ds_r2_pin', versionId: `dsv_${'f'.repeat(24)}`,
    })));
    expect(exact).toMatchObject({ status: 'blocked', code: 'not_found' });
    expect(runtime.execute).not.toHaveBeenCalled();
  });

  it('never falls back to an older historical version when the current head is corrupt', async () => {
    const runtime = remoteRuntime({ lanes: { sqlUsable: false, etlUsable: false } });
    const environment = setup(runtime);
    publishFixture(environment, 'ds_r2_corrupt_head');
    const columns = ['event_date', 'region', 'metric_value', 'flag', 'note'];
    const rows = [
      ['2026-09-01', 'IN', 11, true, null],
      ['2026-09-01', 'US', 21, false, 'other'],
      ['2026-09-02', 'IN', 31, true, 'latest'],
      ['2026-09-02', 'US', 41, false, null],
    ] as AnalyticsDataCell[][];
    const current = environment.dataRoom.ingestSqlRows({
      datasetId: 'ds_r2_corrupt_head', expectedHeadRevision: 1,
      materializedAt: NOW.toISOString(),
      sourceReceipt: {
        sourceKind: 'sql_context', querySha256: '5'.repeat(64),
        producerVersion: 'fixture-2', acquiredAt: NOW.toISOString(),
      },
      quality: [{ assertionId: 'unique_grain', assertionVersion: '1', severity: 'error', success: true }],
      columns, rows, rowCount: rows.length, displayedRowCount: rows.length, truncated: false,
    });
    fs.appendFileSync(path.join(
      environment.root,
      'ds_r2_corrupt_head',
      'versions',
      current.version.id,
      'source.json',
    ), 'tamper');
    const querySpy = vi.spyOn(environment.query, 'execute');
    const outcome = await environment.answer.answer(answerRequest(analyticsRequest({
      domainKey: 'r2-test',
      freshness: { mode: 'historical_as_of' },
    })));
    expect(outcome).toMatchObject({ status: 'blocked', decision: { kind: 'blocked_no_lane' } });
    expect(outcome.decision.candidates).toHaveLength(1);
    expect(outcome.decision.candidates[0].versionId).toBe(current.version.id);
    expect(querySpy).not.toHaveBeenCalled();
  });

  it('returns a bounded remote answer with honest unverified-coverage limitations', async () => {
    const runtime = remoteRuntime({ lanes: { sqlUsable: true, etlUsable: false } });
    const environment = setup(runtime);
    const outcome = await environment.answer.answer(answerRequest(analyticsRequest({ resultLimit: 1 })));
    expect(outcome.status).toBe('answered');
    if (outcome.status !== 'answered') return;
    expect(outcome.answer.receipt).toMatchObject({
      sourceKind: 'sql_context',
      coveredPartitions: [],
      watermark: 'unknown',
      sourceDecision: { kind: 'refresh_sql' },
    });
    expect(outcome.answer.receipt.limitations.join(' ')).toContain('not independently materialized');
    expect(outcome.execution).toMatchObject({ laneProbes: 1, remoteExecutions: 1, localQueries: 0 });
  });
});

describe('analytics data-room R2 managed lane runtime', () => {
  it('does not use a fresh-looking SQL snapshot after its live probe fails and dispatches only ETL', async () => {
    const descriptor = (name: string) => ({ name, inputSchema: {}, risk: 'read' as const });
    const profiles = [
      {
        id: 'sql-context', kind: 'sql', displayName: 'SQL', enabled: true, configured: true,
        state: 'running', packageVersion: '1', tools: ['connection_status', 'run_query'].map(descriptor),
        restartCount: 0, lastHealthyAt: NOW.toISOString(), updatedAt: NOW.toISOString(),
        installationState: 'installed', compatibilityState: 'compatible', requiredTools: [], missingTools: [],
      },
      {
        id: 'a2-analytics', kind: 'etl', displayName: 'ETL', enabled: true, configured: true,
        state: 'running', packageVersion: '1', tools: [
          'datanet_search', 'datanet_create_profile', 'datanet_create_job', 'datanet_get_latest_run',
          'datanet_update_profile_sql', 'datanet_submit_run', 'datanet_get_job_run_status',
          'datanet_alter_run', 'datanet_get_job_run_error', 'datanet_download_results',
        ].map(descriptor),
        restartCount: 0, updatedAt: NOW.toISOString(), installationState: 'installed',
        compatibilityState: 'compatible', requiredTools: [], missingTools: [],
      },
    ];
    const mcpManager = {
      listProfiles: vi.fn(async () => profiles),
      testConnection: vi.fn(async () => ({
        serverId: 'sql-context', toolName: 'connection_status', text: 'Not connected',
        isError: true, durationMs: 1,
      })),
      callTool: vi.fn(async () => { throw new Error('SQL data call must not run'); }),
    } as any;
    const etlRunner = {
      id: 'etl',
      runQuery: vi.fn(async () => ({
        ok: true, runId: '7001', remoteStatus: 'SUCCESS',
        columns: ['event_date', 'region', 'metric_value'],
        rows: [['2026-09-01', 'IN', '10']], rowCount: 1, truncated: false,
      })),
      readRun: vi.fn(),
    };
    const runtime = createManagedAnalyticsAnswerRuntime({ mcpManager, etlRunner, now: () => NOW });
    expect(await runtime.availability()).toEqual({ sqlUsable: false, etlUsable: true });
    const outcome = await runtime.execute({
      decision: 'refresh_etl',
      sql: 'SELECT event_date, region, 10 AS metric_value FROM events',
      request: analyticsRequest(),
      onEtlSubmitted: vi.fn(),
    });
    expect(outcome).toMatchObject({ state: 'complete', sourceKind: 'datanet_etl' });
    expect(mcpManager.testConnection).toHaveBeenCalledTimes(1);
    expect(mcpManager.callTool).not.toHaveBeenCalled();
    expect(etlRunner.runQuery).toHaveBeenCalledTimes(1);
  });
});