import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createNodeManager } from '../../core/node-manager.js';
import { createStorage, type StorageLayer } from '../../core/storage.js';
import type { AnalyticsDataRoomCatalogReader } from '../../core/analytics-data-room-service.js';
import type {
  AnalyticsDatasetDetail,
  AnalyticsDatasetSummary,
  AnalyticsDatasetVersionDetail,
  AnalyticsDatasetVersionSummary,
} from '../../core/analytics-data-room-types.js';
import { createRouter } from '../routes.js';
import { createAnalyticsDataRoomRouter } from './analytics-data-room.js';

const datasetId = 'ds_api_fixture';
const versionId = `dsv_${'a'.repeat(24)}`;
const head = {
  datasetId,
  versionId,
  definitionRevision: 1,
  headRevision: 1,
  promotedAt: '2026-09-19T00:00:00.000Z',
  promotionReceipt: { verified: true },
};
const version = {
  id: versionId,
  datasetId,
  ordinal: 1,
  versionKeySha256: 'a'.repeat(64),
  sourceFormat: 'tsv',
  sourceSha256: 'b'.repeat(64),
  sourceBytes: 100,
  materializedSha256: 'c'.repeat(64),
  materializedBytes: 200,
  manifestSha256: 'd'.repeat(64),
  rowCount: 250,
  observedSchemaSha256: 'e'.repeat(64),
  contractSha256: 'f'.repeat(64),
  coverage: {
    partitionKind: 'day',
    completePartitions: ['2026-09-01'],
    watermark: '2026-09-01T23:59:59.000Z',
  },
  definitionSha256: '1'.repeat(64),
  materializedAt: '2026-09-02T00:00:00.000Z',
  integrity: { status: 'verified', verifiedAt: '2026-09-19T00:00:00.000Z' },
  reacquirable: true,
  createdAt: '2026-09-19T00:00:00.000Z',
} as AnalyticsDatasetVersionSummary;
const dataset = {
  id: datasetId,
  name: 'API fixture',
  description: 'R1 catalog response',
  kind: 'source',
  scope: 'workspace',
  domainKey: 'test',
  lifecycle: 'active',
  sourceKind: 'datanet_etl',
  sourceFormat: 'tsv',
  definitionRevision: 1,
  definitionSha256: '1'.repeat(64),
  contractSha256: 'f'.repeat(64),
  schemaSha256: 'e'.repeat(64),
  retention: { minimumVersions: 1, automaticExpiry: false, reacquirable: true, backupRequired: false },
  head,
  currentVersion: version,
  createdAt: '2026-09-19T00:00:00.000Z',
  updatedAt: '2026-09-19T00:00:00.000Z',
} as AnalyticsDatasetSummary;

const catalogVersion = {
  id: versionId,
  datasetId,
  ordinal: 1,
  rowCount: 250,
  coverage: version.coverage,
  integrityStatus: 'verified',
  contractSha256: version.contractSha256,
  definitionSha256: version.definitionSha256,
  observedSchemaSha256: version.observedSchemaSha256,
  materializedSha256: version.materializedSha256,
  materializedAt: version.materializedAt,
} as any;
const catalogDataset = {
  id: datasetId,
  name: 'API fixture',
  description: 'Safe catalog response',
  kind: 'source',
  scope: 'workspace',
  domainKey: 'test',
  lifecycle: 'active',
  sourceKind: 'datanet_etl',
  sourceFormat: 'tsv',
  definitionRevision: 1,
  definitionSha256: '1'.repeat(64),
  contractSha256: 'f'.repeat(64),
  schemaSha256: 'e'.repeat(64),
  schema: [],
  head: { datasetId, versionId, definitionRevision: 1, headRevision: 1, promotedAt: '2026-09-19T00:00:00.000Z' },
  currentVersion: catalogVersion,
  bindingTemplate: null,
} as any;
const emptyPage = { items: [], count: 0, limit: 50, truncated: false };
const catalogDetail = {
  ...catalogDataset,
  projects: emptyPage,
  dependencies: emptyPage,
  dependents: emptyPage,
  consumers: { ...emptyPage, limit: 100 },
  dashboardOwners: emptyPage,
  activity: { ...emptyPage, limit: 20 },
} as any;
const catalogVersionDetail = {
  ...catalogVersion,
  observedSchema: [],
  quality: emptyPage,
  inputs: emptyPage,
  outputs: emptyPage,
} as any;

function reader(): AnalyticsDataRoomCatalogReader & {
  listDatasets: ReturnType<typeof vi.fn>;
  getDataset: ReturnType<typeof vi.fn>;
  listDatasetVersions: ReturnType<typeof vi.fn>;
  getDatasetVersion: ReturnType<typeof vi.fn>;
  listCatalogDatasets: ReturnType<typeof vi.fn>;
  getCatalogDataset: ReturnType<typeof vi.fn>;
  listCatalogDatasetVersions: ReturnType<typeof vi.fn>;
  getCatalogDatasetVersion: ReturnType<typeof vi.fn>;
} {
  return {
    listDatasets: vi.fn(() => [dataset]),
    getDataset: vi.fn((id: string) => id === datasetId ? ({
      ...dataset,
      ownerId: 'owner',
      definition: { profile: 1 },
      contract: { contractVersion: '1' },
    } as unknown as AnalyticsDatasetDetail) : null),
    listDatasetVersions: vi.fn((id: string) => id === datasetId ? [version] : null),
    getDatasetVersion: vi.fn((id: string) => id === versionId ? ({
      ...version,
      files: {
        source: { fileName: 'source.tsv', sha256: version.sourceSha256, bytes: version.sourceBytes },
        materialized: { fileName: 'materialized.db', sha256: version.materializedSha256, bytes: version.materializedBytes },
      },
      observedSchema: [],
      contract: { contractVersion: '1' },
      sourceReceipt: { sourceKind: 'datanet_etl', producerVersion: '1', acquiredAt: '2026-09-19T00:00:00.000Z' },
      handling: { classification: 'internal', allowedUses: ['dashboard'], allowModelContext: false, allowPublication: false },
      quality: [],
    } as unknown as AnalyticsDatasetVersionDetail) : null),
    listCatalogDatasets: vi.fn((input?: { limit?: number }) => ({
      dataRoomVersion: 'catalog-v1', datasets: [catalogDataset], count: 1,
      limit: input?.limit ?? 25, truncated: false,
    })),
    getCatalogDataset: vi.fn((id: string) => id === datasetId
      ? { dataRoomVersion: 'catalog-v1', dataset: catalogDetail }
      : null),
    listCatalogDatasetVersions: vi.fn((id: string, input?: { limit?: number }) => id === datasetId ? ({
      dataRoomVersion: 'catalog-v1', datasetId, versions: [catalogVersion], count: 1,
      limit: input?.limit ?? 25, truncated: false,
    }) : null),
    getCatalogDatasetVersion: vi.fn((id: string) => id === versionId
      ? { dataRoomVersion: 'catalog-v1', version: catalogVersionDetail }
      : null),
  } as AnalyticsDataRoomCatalogReader & {
    listDatasets: ReturnType<typeof vi.fn>;
    getDataset: ReturnType<typeof vi.fn>;
    listDatasetVersions: ReturnType<typeof vi.fn>;
    getDatasetVersion: ReturnType<typeof vi.fn>;
    listCatalogDatasets: ReturnType<typeof vi.fn>;
    getCatalogDataset: ReturnType<typeof vi.fn>;
    listCatalogDatasetVersions: ReturnType<typeof vi.fn>;
    getCatalogDatasetVersion: ReturnType<typeof vi.fn>;
  };
}

describe('analytics data-room R1 catalog router', () => {
  let app: express.Express;
  let catalog: ReturnType<typeof reader>;
  let storage: StorageLayer | null;

  beforeEach(() => {
    catalog = reader();
    storage = null;
    app = express();
    app.use(express.json());
    app.use('/api', createAnalyticsDataRoomRouter({ analyticsDataRoom: catalog } as any));
  });

  afterEach(() => storage?.close());

  it('returns bounded no-store list/detail/version projections', async () => {
    const list = await request(app).get('/api/analytics/data-room/datasets?limit=10');
    expect(list.status).toBe(200);
    expect(list.headers['cache-control']).toBe('no-store');
    expect(list.body).toMatchObject({
      dataRoomVersion: 'catalog-v1', datasets: [catalogDataset], count: 1, limit: 10, truncated: false,
    });
    expect(catalog.listCatalogDatasets).toHaveBeenCalledWith({ limit: 10 });

    const detail = await request(app).get(`/api/analytics/data-room/datasets/${datasetId}`);
    expect(detail.status).toBe(200);
    expect(detail.body.dataRoomVersion).toBe('catalog-v1');
    expect(detail.body.dataset.id).toBe(datasetId);
    expect(detail.body.dataset).not.toHaveProperty('definition');
    expect(detail.body.dataset).not.toHaveProperty('ownerId');

    const versions = await request(app).get(`/api/analytics/data-room/datasets/${datasetId}/versions?limit=10`);
    expect(versions.body).toMatchObject({
      dataRoomVersion: 'catalog-v1', datasetId, versions: [catalogVersion], count: 1, limit: 10, truncated: false,
    });
    expect(catalog.listCatalogDatasetVersions).toHaveBeenCalledWith(datasetId, { limit: 10 });

    const oneVersion = await request(app).get(`/api/analytics/data-room/versions/${versionId}`);
    expect(oneVersion.status).toBe(200);
    expect(oneVersion.body.dataRoomVersion).toBe('catalog-v1');
    expect(oneVersion.body.version).toMatchObject({ id: versionId, rowCount: 250 });
    expect(oneVersion.body.version).not.toHaveProperty('sourceReceipt');
    expect(oneVersion.body.version).not.toHaveProperty('files');
  });

  it('distinguishes missing resources and unavailable service', async () => {
    expect((await request(app).get('/api/analytics/data-room/datasets/ds_missing')).status).toBe(404);
    expect((await request(app).get('/api/analytics/data-room/datasets/ds_missing/versions')).status).toBe(404);
    expect((await request(app).get(`/api/analytics/data-room/versions/dsv_${'b'.repeat(24)}`)).status).toBe(404);

    const unavailable = express();
    unavailable.use('/api', createAnalyticsDataRoomRouter({} as any));
    const response = await request(unavailable).get('/api/analytics/data-room/datasets');
    expect(response.status).toBe(503);
    expect(response.body).toEqual({ error: 'Analytics data room is unavailable.' });
  });

  it('rejects malformed IDs, invalid limits, and cross-origin reads before calling the service', async () => {
    for (const target of [
      '/api/analytics/data-room/datasets/not-a-dataset',
      '/api/analytics/data-room/datasets/ds_bad%20id',
      '/api/analytics/data-room/versions/not-a-version',
      '/api/analytics/data-room/datasets?limit=0',
      '/api/analytics/data-room/datasets?limit=101',
      '/api/analytics/data-room/datasets?limit=1.5',
    ]) {
      expect((await request(app).get(target)).status, target).toBe(400);
    }
    catalog.listCatalogDatasets.mockClear();
    catalog.getCatalogDataset.mockClear();
    const crossOrigin = await request(app)
      .get('/api/analytics/data-room/datasets')
      .set('Host', 'localhost:7778')
      .set('Origin', 'https://evil.example');
    expect(crossOrigin.status).toBe(403);
    expect(catalog.listCatalogDatasets).not.toHaveBeenCalled();
    expect(catalog.getCatalogDataset).not.toHaveBeenCalled();

    const sameOrigin = await request(app)
      .get('/api/analytics/data-room/datasets')
      .set('Host', 'localhost:7778')
      .set('Origin', 'http://localhost:7778');
    expect(sameOrigin.status).toBe(200);
  });

  it('sanitizes unexpected failures and leaves later-phase routes absent', async () => {
    catalog.listCatalogDatasets.mockImplementation(() => { throw new Error('/private/data-room/secret'); });
    const failed = await request(app).get('/api/analytics/data-room/datasets');
    expect(failed.status).toBe(500);
    expect(JSON.stringify(failed.body)).not.toContain('/private/data-room/secret');

    const unavailableQuery = await request(app).post('/api/analytics/data-room/query').send({});
    expect(unavailableQuery.status).toBe(503);
    expect(unavailableQuery.body).toEqual({ error: 'Analytics answer service is unavailable.' });

    for (const target of [
      `/api/analytics/data-room/datasets/${datasetId}/materialize`,
      '/api/analytics/data-room/runs/dsrun_fake/cancel',
    ]) {
      expect((await request(app).post(target).send({})).status, target).toBe(404);
    }
  });

  it('maps bounded query outcomes and enforces the same-origin boundary', async () => {
    const answer = vi.fn(async () => ({
      status: 'answered',
      decision: { kind: 'ready_materialized', reason: 'exact_materialized_candidate', candidates: [] },
      answer: { result: { columns: ['value'], rows: [[1]], rowCount: 1, displayedRowCount: 1, truncated: false }, receipt: { limitations: [] } },
      execution: { catalogCandidates: 1, integrityChecks: 2, laneProbes: 0, remoteExecutions: 0, localQueries: 1 },
    }));
    const queryApp = express();
    queryApp.use(express.json());
    queryApp.use('/api', createAnalyticsDataRoomRouter({
      analyticsDataRoom: catalog,
      analyticsAnswerService: { answer } as any,
    } as any));
    const response = await request(queryApp)
      .post('/api/analytics/data-room/query')
      .set('Host', 'localhost:7778')
      .set('Origin', 'http://localhost:7778')
      .send({ request: {}, metricValueColumn: 'value', warehouseSql: 'SELECT 1 AS value' });
    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body).toMatchObject({ status: 'answered', execution: { remoteExecutions: 0 } });
    expect(answer).toHaveBeenCalledTimes(1);

    const rejected = await request(queryApp)
      .post('/api/analytics/data-room/query')
      .set('Host', 'localhost:7778')
      .set('Origin', 'https://evil.example')
      .send({});
    expect(rejected.status).toBe(403);
    expect(answer).toHaveBeenCalledTimes(1);
  });

  it('is mounted in the full API composition root', async () => {
    storage = createStorage(':memory:');
    storage.initialize();
    const composed = express();
    composed.use(express.json());
    composed.use('/api', createRouter({
      nodeManager: createNodeManager(storage.getDb()),
      analyticsDataRoom: catalog,
    }));
    const response = await request(composed).get('/api/analytics/data-room/datasets');
    expect(response.status).toBe(200);
    expect(response.body.count).toBe(1);
  });
});
