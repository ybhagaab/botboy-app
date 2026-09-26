import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
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
import {
  createAnalyticsDataRoomService,
  parseAnalyticsTsv,
  type AnalyticsDataRoomService,
} from './analytics-data-room-service.js';
import type {
  AnalyticsDatasetContract,
  AnalyticsDatasetDefinitionInput,
  AnalyticsDataRoomSourceKind,
  AnalyticsDataRoomSourceFormat,
  AnalyticsQualityAssertionEvaluation,
} from './analytics-data-room-types.js';

const temporaryDirectories: string[] = [];
const storages: StorageLayer[] = [];
const sidecars: Database.Database[] = [];

function temporaryDirectory(prefix: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function contract(
  datasetId: string,
  handling: AnalyticsDatasetContract['handling'] = {
    classification: 'internal',
    allowedUses: ['local_answer', 'dashboard'],
    allowModelContext: true,
    allowPublication: false,
  },
): AnalyticsDatasetContract {
  const schema: AnalyticsDatasetContract['schema'] = [
    { name: 'event_date', logicalType: 'date', physicalType: 'DATE', nullable: false },
    { name: 'user_id', logicalType: 'string', physicalType: 'VARCHAR', nullable: false },
    { name: 'event_count', logicalType: 'integer', physicalType: 'BIGINT', nullable: false },
    { name: 'note', logicalType: 'string', physicalType: 'VARCHAR', nullable: true },
  ];
  const base: AnalyticsDatasetContract = {
    contractVersion: '1',
    contractSha256: '',
    status: 'active',
    datasetId,
    datasetKind: 'source',
    scope: 'workspace',
    domainKey: 'r1-test',
    schemaSha256: analyticsDatasetSchemaSha256(schema),
    schema,
    metric: {
      id: 'daily_events',
      version: '1',
      definitionSha256: '1'.repeat(64),
      unit: 'events',
    },
    regime: {
      id: 'all_valid_events',
      version: '1',
      definitionSha256: '2'.repeat(64),
    },
    countingKey: 'user_id',
    unit: 'events',
    grain: 'day_user',
    availableDimensions: ['event_date'],
    timeField: 'event_date',
    timeZone: 'UTC',
    coverage: {
      partitionKind: 'day',
      completePartitions: ['2026-09-01'],
      watermark: '2026-09-01T23:59:59.000Z',
    },
    handling,
  };
  return { ...base, contractSha256: analyticsDatasetContractSha256(base) };
}

function definition(
  datasetId: string,
  sourceKind: AnalyticsDataRoomSourceKind = 'datanet_etl',
  sourceFormat: AnalyticsDataRoomSourceFormat = 'tsv',
  options: { reacquirable?: boolean; handling?: AnalyticsDatasetContract['handling'] } = {},
): AnalyticsDatasetDefinitionInput {
  const reacquirable = options.reacquirable ?? true;
  return {
    id: datasetId,
    name: `Dataset ${datasetId}`,
    description: 'Synthetic R1 integration fixture',
    kind: 'source',
    scope: 'workspace',
    domainKey: 'r1-test',
    ownerId: 'owner-test',
    lifecycle: 'active',
    sourceKind,
    sourceFormat,
    definition: { adapter: sourceKind, version: 1 },
    contract: contract(datasetId, options.handling),
    retention: {
      minimumVersions: 1,
      automaticExpiry: false,
      reacquirable,
      backupRequired: !reacquirable,
    },
  };
}

function tsv(rowCount: number): Buffer {
  const lines = ['event_date\tuser_id\tevent_count\tnote'];
  for (let index = 0; index < rowCount; index++) {
    lines.push(`2026-09-01\tuser_${index}\t${index + 1}\t${index % 2 ? '' : 'ok'}`);
  }
  return Buffer.from(`${lines.join('\r\n')}\r\n`, 'utf8');
}

function quality(): AnalyticsQualityAssertionEvaluation[] {
  return [{
    assertionId: 'row_count_positive',
    assertionVersion: '1',
    severity: 'error',
    success: true,
    observed: 250,
    expected: 1,
  }];
}

function setup(root = temporaryDirectory('analytics-data-room-')): {
  storage: StorageLayer;
  store: AnalyticsDataRoomStore;
  service: AnalyticsDataRoomService;
  root: string;
} {
  const storage = createStorage(':memory:');
  storage.initialize();
  storages.push(storage);
  const store = createAnalyticsDataRoomStore({ db: storage.getDb(), rootDir: root });
  const backups = createAnalyticsDataRoomBackupService({ db: storage.getDb(), store });
  const service = createAnalyticsDataRoomService({ store, backups });
  return { storage, store, service, root };
}

function etlInput(datasetId: string, filePath: string, bytes: Buffer, expectedHeadRevision: number) {
  return {
    datasetId,
    expectedHeadRevision,
    materializedAt: '2026-09-02T00:00:00.000Z',
    sourceReceipt: {
      sourceKind: 'datanet_etl' as const,
      sourceId: 'run-9001',
      querySha256: '3'.repeat(64),
      producerVersion: 'etl-test-1',
      acquiredAt: '2026-09-02T00:00:00.000Z',
      submittedAgain: false,
    },
    quality: quality(),
    savedTo: filePath,
    resultBytes: bytes.length,
    resultSha256: sha256(bytes),
  };
}

function writeResult(directory: string, name: string, bytes: Buffer): string {
  const filePath = path.join(directory, name);
  fs.writeFileSync(filePath, bytes, { mode: 0o600 });
  return filePath;
}

afterEach(() => {
  while (sidecars.length) sidecars.pop()?.close();
  while (storages.length) storages.pop()?.close();
  while (temporaryDirectories.length) fs.rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
});

describe('analytics data-room R1 immutable catalog and ingestion', () => {
  let environment: ReturnType<typeof setup>;
  let sourceDirectory: string;

  beforeEach(() => {
    environment = setup();
    sourceDirectory = temporaryDirectory('analytics-source-');
  });

  it('materializes every ETL row beyond the 200-row presentation cap with private exact-byte receipts', () => {
    const datasetId = 'ds_r1_full_etl';
    environment.service.registerDataset(definition(datasetId));
    const bytes = tsv(250);
    const sourcePath = writeResult(sourceDirectory, 'run.tsv', bytes);

    const receipt = environment.service.ingestEtlTsv(etlInput(datasetId, sourcePath, bytes, 0));

    expect(receipt.version.rowCount).toBe(250);
    expect(receipt.version.sourceBytes).toBe(bytes.length);
    expect(receipt.version.sourceSha256).toBe(sha256(bytes));
    expect(receipt.head).toMatchObject({ versionId: receipt.version.id, headRevision: 1 });
    expect(receipt.run.status).toBe('completed');
    expect(environment.service.listDatasetVersions(datasetId)).toHaveLength(1);

    const versionDirectory = path.join(environment.root, datasetId, 'versions', receipt.version.id);
    expect(fs.readFileSync(path.join(versionDirectory, 'source.tsv'))).toEqual(bytes);
    for (const target of [
      environment.root,
      path.join(environment.root, datasetId),
      versionDirectory,
    ]) {
      expect(fs.statSync(target).mode & 0o077, target).toBe(0);
    }
    for (const name of ['source.tsv', 'materialized.db', 'manifest.json']) {
      expect(fs.statSync(path.join(versionDirectory, name)).mode & 0o077, name).toBe(0);
    }

    const materializedPath = environment.store.getVerifiedMaterializedPath(receipt.version.id, 'dashboard');
    const sidecar = new Database(materializedPath, { readonly: true, fileMustExist: true });
    sidecars.push(sidecar);
    expect((sidecar.prepare('SELECT COUNT(*) AS count FROM data').get() as { count: number }).count).toBe(250);
    expect(sidecar.prepare('SELECT event_count, note FROM data WHERE user_id = ?').get('user_249'))
      .toEqual({ event_count: 250, note: '' });
    const assertions = environment.storage.getDb().prepare(`
      SELECT assertion_id, severity, success FROM analytics_dataset_assertion_evaluations
      WHERE version_id = ?
    `).all(receipt.version.id);
    expect(assertions).toEqual([{ assertion_id: 'row_count_positive', severity: 'error', success: 1 }]);
  });

  it('deduplicates an exact acquisition and attaches a verified orphan after a stale-head conflict', () => {
    const datasetId = 'ds_r1_idempotent';
    environment.service.registerDataset(definition(datasetId));
    const firstBytes = tsv(250);
    const firstPath = writeResult(sourceDirectory, 'first.tsv', firstBytes);
    const first = environment.service.ingestEtlTsv(etlInput(datasetId, firstPath, firstBytes, 0));

    const repeated = environment.service.ingestEtlTsv(etlInput(datasetId, firstPath, firstBytes, 1));
    expect(repeated.idempotent).toBe(true);
    expect(repeated.version.id).toBe(first.version.id);
    expect(repeated.head.headRevision).toBe(1);
    expect(environment.service.listDatasetVersions(datasetId)).toHaveLength(1);

    const changedBytes = tsv(251);
    const changedPath = writeResult(sourceDirectory, 'changed.tsv', changedBytes);
    expect(() => environment.service.ingestEtlTsv(etlInput(datasetId, changedPath, changedBytes, 0)))
      .toThrow(/head revision changed/i);
    expect(environment.store.getHead(datasetId)).toMatchObject({ versionId: first.version.id, headRevision: 1 });
    expect(environment.service.listDatasetVersions(datasetId)).toHaveLength(1);

    const recovered = environment.service.ingestEtlTsv(etlInput(datasetId, changedPath, changedBytes, 1));
    expect(recovered.idempotent).toBe(true);
    expect(recovered.version.rowCount).toBe(251);
    expect(recovered.head.headRevision).toBe(2);
    expect(environment.service.listDatasetVersions(datasetId)).toHaveLength(2);
  });

  it('blocks failed quality, enforces use-specific handling, and quarantines altered bytes without fallback', () => {
    const datasetId = 'ds_r1_handling';
    environment.service.registerDataset(definition(datasetId, 'datanet_etl', 'tsv', {
      handling: {
        classification: 'restricted',
        allowedUses: ['dashboard'],
        allowModelContext: false,
        allowPublication: false,
      },
    }));
    const bytes = tsv(250);
    const sourcePath = writeResult(sourceDirectory, 'restricted.tsv', bytes);
    const input = etlInput(datasetId, sourcePath, bytes, 0);
    expect(() => environment.service.ingestEtlTsv({
      ...input,
      sourceReceipt: { ...input.sourceReceipt, acquiredAt: 'March 5 2021' },
    })).toThrow(/source receipt is malformed/i);
    expect(() => environment.service.ingestEtlTsv({
      ...input,
      quality: [{ assertionId: 'schema_ok', assertionVersion: '1', severity: 'error', success: false }],
    })).toThrow(/blocking quality/i);
    expect(environment.service.listDatasetVersions(datasetId)).toHaveLength(0);
    expect(environment.store.getHead(datasetId)).toBeNull();

    const published = environment.service.ingestEtlTsv(input);
    expect(() => environment.store.getVerifiedMaterializedPath(published.version.id, 'local_answer'))
      .toThrow(/does not permit local_answer/i);
    expect(environment.store.getDatasetVersion(published.version.id)?.integrity.status).toBe('verified');
    expect(() => environment.store.getVerifiedMaterializedPath(published.version.id, 'dashboard')).not.toThrow();

    const sourceInRoom = path.join(environment.root, datasetId, 'versions', published.version.id, 'source.tsv');
    fs.appendFileSync(sourceInRoom, 'tamper');
    expect(() => environment.store.getVerifiedMaterializedPath(published.version.id, 'dashboard'))
      .toThrow(/immutable receipt/i);
    expect(environment.store.getDatasetVersion(published.version.id)?.integrity.status).toBe('quarantined');
    expect(environment.service.getDataset(datasetId)?.head).toBeNull();
    expect(environment.service.getDataset(datasetId)?.currentVersion).toBeNull();
  });

  it('does not quarantine intact bytes when verification hits transient local I/O failure', () => {
    const datasetId = 'ds_r1_transient_io';
    environment.service.registerDataset(definition(datasetId));
    const bytes = tsv(3);
    const published = environment.service.ingestEtlTsv(etlInput(
      datasetId,
      writeResult(sourceDirectory, 'transient.tsv', bytes),
      bytes,
      0,
    ));
    const transient = Object.assign(new Error('too many open files'), { code: 'EMFILE' });
    const readSpy = vi.spyOn(fs, 'readSync').mockImplementationOnce(() => { throw transient; });
    try {
      expect(() => environment.store.verifyVersion(published.version.id))
        .toThrow(/temporarily unavailable/i);
    } finally {
      readSpy.mockRestore();
    }
    expect(environment.store.getDatasetVersion(published.version.id)?.integrity.status).toBe('verified');
    expect(environment.store.verifyVersion(published.version.id).status).toBe('verified');
  });

  it('recovers expired acquisition staging without a resident scheduler', () => {
    const datasetId = 'ds_r1_stale_run';
    environment.service.registerDataset(definition(datasetId));
    const runId = `dsrun_${'a'.repeat(32)}`;
    const stagingRelative = path.join(datasetId, 'staging', runId);
    const stagingDirectory = path.join(environment.root, stagingRelative);
    fs.mkdirSync(stagingDirectory, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(stagingDirectory, 'partial.tsv'), 'partial', { mode: 0o600 });
    environment.storage.getDb().prepare(`
      INSERT INTO analytics_dataset_runs
        (id, dataset_id, trigger, request_sha256, definition_revision,
         definition_sha256, status, source_kind, staging_rel_path,
         lease_owner, lease_expires_at, heartbeat_at, queued_at, started_at)
      SELECT ?, id, 'manual', ?, definition_revision, definition_sha256,
        'staging', source_kind, ?, 'dead-worker', ?, ?, ?, ?
      FROM analytics_datasets WHERE id = ?
    `).run(
      runId,
      '9'.repeat(64),
      stagingRelative,
      '2020-01-01T00:00:00.000Z',
      '2020-01-01T00:00:00.000Z',
      '2020-01-01T00:00:00.000Z',
      '2020-01-01T00:00:00.000Z',
      datasetId,
    );

    const freshBytes = tsv(1);
    const next = environment.service.ingestEtlTsv(etlInput(
      datasetId,
      writeResult(sourceDirectory, 'after-stale.tsv', freshBytes),
      freshBytes,
      0,
    ));
    expect(next.run.status).toBe('completed');
    expect(environment.store.getRun(runId)).toMatchObject({
      status: 'failed',
      error: expect.stringContaining('recovered at startup'),
    });
    expect(fs.existsSync(stagingDirectory)).toBe(false);
  });

  it('rejects truncated SQL presentation data but accepts a complete typed SQL result', () => {
    const datasetId = 'ds_r1_sql';
    environment.service.registerDataset(definition(datasetId, 'sql_context', 'canonical_json'));
    const columns = ['event_date', 'user_id', 'event_count', 'note'];
    const rows = Array.from({ length: 201 }, (_, index) => [
      '2026-09-01', `sql_user_${index}`, index + 1, index % 2 ? null : 'ok',
    ]);
    const common = {
      datasetId,
      expectedHeadRevision: 0,
      materializedAt: '2026-09-02T00:00:00.000Z',
      sourceReceipt: {
        sourceKind: 'sql_context' as const,
        sourceId: 'query-1',
        querySha256: '4'.repeat(64),
        producerVersion: 'sql-context-test-1',
        acquiredAt: '2026-09-02T00:00:00.000Z',
      },
      quality: quality(),
      columns,
      rows,
      rowCount: rows.length,
    };
    expect(() => environment.service.ingestSqlRows({
      ...common,
      displayedRowCount: 200,
      truncated: true,
    })).toThrow(/complete structured export or ETL/i);
    expect(environment.service.listDatasetVersions(datasetId)).toHaveLength(0);

    const receipt = environment.service.ingestSqlRows({
      ...common,
      displayedRowCount: rows.length,
      truncated: false,
    });
    expect(receipt.version).toMatchObject({ rowCount: 201, sourceFormat: 'canonical_json' });
    const sourcePath = path.join(environment.root, datasetId, 'versions', receipt.version.id, 'source.json');
    const source = JSON.parse(fs.readFileSync(sourcePath, 'utf8'));
    expect(source.rows).toHaveLength(201);
    expect(source.rows[1][3]).toBeNull();
  });

  it('backs up irreplaceable versions coherently and restores exact identities into a fresh room', () => {
    const datasetId = 'ds_r1_backup';
    environment.service.registerDataset(definition(datasetId, 'datanet_etl', 'tsv', { reacquirable: false }));
    const firstBytes = tsv(250);
    const secondBytes = tsv(251);
    const first = environment.service.ingestEtlTsv(etlInput(
      datasetId,
      writeResult(sourceDirectory, 'backup-first.tsv', firstBytes),
      firstBytes,
      0,
    ));
    const second = environment.service.ingestEtlTsv(etlInput(
      datasetId,
      writeResult(sourceDirectory, 'backup-second.tsv', secondBytes),
      secondBytes,
      1,
    ));
    expect(environment.store.versionDeletionEligibility(first.version.id).reasons)
      .toContain('verified_backup_required');

    const backupRoot = temporaryDirectory('analytics-backups-');
    const backup = environment.service.backupDataset(datasetId, backupRoot);
    expect(backup.versionIds).toEqual([first.version.id, second.version.id]);
    expect(fs.statSync(backup.targetDirectory).mode & 0o077).toBe(0);
    expect(environment.store.versionDeletionEligibility(first.version.id)).toEqual({ allowed: true, reasons: [] });

    const originalSource = path.join(environment.root, datasetId, 'versions', first.version.id, 'source.tsv');
    fs.appendFileSync(originalSource, 'tamper');
    expect(() => environment.store.verifyVersion(first.version.id)).toThrow(/immutable receipt/i);
    expect(environment.store.getDatasetVersion(first.version.id)?.integrity.status).toBe('quarantined');
    const repaired = environment.service.restoreDatasetBackup(backup.targetDirectory);
    expect(repaired.idempotent).toBe(true);
    expect(environment.store.getDatasetVersion(first.version.id)?.integrity.status).toBe('verified');
    expect(environment.store.verifyVersion(first.version.id).status).toBe('verified');

    const restoredEnvironment = setup(temporaryDirectory('analytics-restored-room-'));
    const restored = restoredEnvironment.service.restoreDatasetBackup(backup.targetDirectory);
    expect(restored).toMatchObject({
      backupId: backup.backupId,
      datasetId,
      versionIds: backup.versionIds,
      idempotent: false,
    });
    expect(restoredEnvironment.store.getHead(datasetId)).toEqual(second.head);
    expect(restoredEnvironment.service.listDatasetVersions(datasetId)?.map(version => version.id))
      .toEqual([second.version.id, first.version.id]);
    expect(() => restoredEnvironment.store.getVerifiedMaterializedPath(first.version.id, 'dashboard')).not.toThrow();

    const repeated = restoredEnvironment.service.restoreDatasetBackup(backup.targetDirectory);
    expect(repeated.idempotent).toBe(true);
    expect(restoredEnvironment.service.listDatasetVersions(datasetId)).toHaveLength(2);

    const tamperedBackupRoot = temporaryDirectory('analytics-canonical-tamper-');
    const tamperedBackup = path.join(tamperedBackupRoot, backup.backupId);
    fs.cpSync(backup.targetDirectory, tamperedBackup, { recursive: true });
    const tamperedCatalogPath = path.join(tamperedBackup, 'catalog.json');
    const tamperedCatalog = JSON.parse(fs.readFileSync(tamperedCatalogPath, 'utf8'));
    tamperedCatalog.dataset.definition_json = '{"adapter":"tampered"}';
    const tamperedCatalogBytes = Buffer.from(`${JSON.stringify(tamperedCatalog)}\n`, 'utf8');
    fs.writeFileSync(tamperedCatalogPath, tamperedCatalogBytes, { mode: 0o600 });
    const tamperedManifestPath = path.join(tamperedBackup, 'backup-manifest.json');
    const tamperedManifest = JSON.parse(fs.readFileSync(tamperedManifestPath, 'utf8'));
    const catalogReceipt = tamperedManifest.files.find((file: { relativePath: string }) => file.relativePath === 'catalog.json');
    catalogReceipt.sha256 = sha256(tamperedCatalogBytes);
    catalogReceipt.bytes = tamperedCatalogBytes.length;
    fs.writeFileSync(tamperedManifestPath, `${JSON.stringify(tamperedManifest)}\n`, { mode: 0o600 });
    const rejectedCatalogEnvironment = setup(temporaryDirectory('analytics-rejected-catalog-'));
    expect(() => rejectedCatalogEnvironment.service.restoreDatasetBackup(tamperedBackup))
      .toThrow(/definition SHA is invalid/i);
    expect(rejectedCatalogEnvironment.service.getDataset(datasetId)).toBeNull();

    const backedUpSource = path.join(
      backup.targetDirectory,
      'versions',
      first.version.id,
      'source.tsv',
    );
    fs.appendFileSync(backedUpSource, 'tamper');
    const rejectedEnvironment = setup(temporaryDirectory('analytics-rejected-restore-'));
    expect(() => rejectedEnvironment.service.restoreDatasetBackup(backup.targetDirectory))
      .toThrow(/differs from its manifest receipt/i);
    expect(rejectedEnvironment.service.getDataset(datasetId)).toBeNull();
  });

  it('projects a bounded versioned owner catalog without rows, SQL, paths, or raw receipts', () => {
    const sourceId = 'ds_r5_catalog_source';
    const dependentId = 'ds_r5_catalog_dependent';
    const sourceDefinition = definition(sourceId);
    sourceDefinition.definition = {
      answer: {
        version: 1,
        metricId: 'daily_events',
        metricValueColumn: 'event_count',
        rowDimensions: ['event_date', 'user_id'],
        filterableFields: ['event_date', 'user_id'],
        stableOrder: [{ field: 'event_date', direction: 'asc' }, { field: 'user_id', direction: 'asc' }],
      },
      sql: 'SELECT private_catalog_value',
      privatePath: '/private/data-room/never-project',
    };
    environment.service.registerDataset(sourceDefinition);
    environment.service.registerDataset(definition(dependentId));
    const sourceBytes = tsv(1);
    const dependentBytes = tsv(1);
    const sourceVersion = environment.service.ingestEtlTsv(etlInput(
      sourceId,
      writeResult(sourceDirectory, 'catalog-source.tsv', sourceBytes),
      sourceBytes,
      0,
    )).version;
    const dependentVersion = environment.service.ingestEtlTsv(etlInput(
      dependentId,
      writeResult(sourceDirectory, 'catalog-dependent.tsv', dependentBytes),
      dependentBytes,
      0,
    )).version;
    const db = environment.storage.getDb();
    const beforeRelations = environment.service.listCatalogDatasets({ limit: 1 }).dataRoomVersion;
    db.prepare(`
      INSERT INTO projects (id, title, status, brain_path)
      VALUES ('project_catalog', 'Catalog project', 'active', '/private/brain/path')
    `).run();
    db.prepare(`
      INSERT INTO analytics_dataset_project_links (dataset_id, project_id, linked_at)
      VALUES (?, 'project_catalog', '2026-09-21T00:00:00.000Z')
    `).run(sourceId);
    db.prepare(`
      INSERT INTO analytics_dataset_dependencies
        (derived_dataset_id, definition_revision, alias, position, input_dataset_id,
         version_policy, pinned_version_id, required_columns_json,
         expected_schema_sha256, expected_contract_sha256, created_at)
      VALUES (?, 1, 'source', 0, ?, 'latest_compatible', NULL, ?, ?, ?, '2026-09-21T00:00:00.000Z')
    `).run(
      dependentId,
      sourceId,
      JSON.stringify(['event_date', 'user_id', 'event_count']),
      sourceDefinition.contract.schemaSha256,
      sourceDefinition.contract.contractSha256,
    );
    db.prepare(`
      INSERT INTO analytics_dataset_version_inputs
        (output_version_id, alias, position, input_dataset_id, input_version_id,
         content_sha256, schema_sha256, contract_sha256, definition_sha256)
      VALUES (?, 'source', 0, ?, ?, ?, ?, ?, ?)
    `).run(
      dependentVersion.id,
      sourceId,
      sourceVersion.id,
      sourceVersion.materializedSha256,
      sourceVersion.observedSchemaSha256,
      sourceVersion.contractSha256,
      sourceVersion.definitionSha256,
    );
    db.prepare(`
      INSERT INTO analytics_dashboards
        (id, title, description, theme, status, created_at, updated_at, data_state)
      VALUES ('dash_catalog', 'Catalog dashboard', '', 'executive', 'ready',
        '2026-09-21T00:00:00.000Z', '2026-09-21T00:00:00.000Z', NULL)
    `).run();
    db.prepare(`
      INSERT INTO analytics_widgets
        (id, dashboard_id, position, kind, title, subtitle, sql_query, preset,
         config_json, result_json, last_error, last_refreshed_at, created_at, updated_at, revision)
      VALUES ('widget_catalog', 'dash_catalog', 0, 'table', 'Catalog widget', '',
        'SELECT should_never_escape', NULL, '{}', '{"rows":[["private-row"]]}', NULL,
        '2026-09-21T00:00:00.000Z', '2026-09-21T00:00:00.000Z',
        '2026-09-21T00:00:00.000Z', 1)
    `).run();
    db.prepare(`
      INSERT INTO analytics_widget_binding_revisions (widget_id, revision, updated_at)
      VALUES ('widget_catalog', 1, '2026-09-21T00:00:00.000Z')
    `).run();
    db.prepare(`
      INSERT INTO analytics_widget_dataset_bindings
        (widget_id, dataset_id, revision, version_policy, pinned_version_id,
         expected_schema_sha256, expected_contract_sha256, required_columns_json,
         request_json, request_sha256, presentation_limit, compatibility_state,
         compatibility_error, observed_head_revision, last_queued_version_id,
         last_applied_version_id, created_at, updated_at)
      VALUES ('widget_catalog', ?, 1, 'latest_compatible', NULL, ?, ?, '[]',
        '{"private":"request"}', ?, 200, 'compatible', '/private/error', 1, ?, ?,
        '2026-09-21T00:00:00.000Z', '2026-09-21T00:00:00.000Z')
    `).run(
      sourceId,
      sourceDefinition.contract.schemaSha256,
      sourceDefinition.contract.contractSha256,
      '9'.repeat(64),
      sourceVersion.id,
      sourceVersion.id,
    );
    db.prepare(`
      INSERT INTO analytics_dataset_dashboard_owners (dataset_id, dashboard_id, claimed_at)
      VALUES (?, 'dash_catalog', '2026-09-21T00:00:00.000Z')
    `).run(sourceId);
    db.prepare(`
      INSERT INTO analytics_derived_runs
        (id, dataset_id, definition_revision, definition_sha256, expected_head_revision,
         request_sha256, transform_sha256, input_set_sha256, materialization_key_sha256,
         status, output_version_id, receipt_json, error, next_action,
         queued_at, started_at, completed_at)
      VALUES ('dsdr_catalog_activity', ?, 1, ?, 1, ?, ?, ?, ?, 'completed', ?,
        '{"private":"receipt"}', '/private/run/error', 'never expose',
        '2026-09-21T01:00:00.000Z', '2026-09-21T01:00:00.000Z', '2026-09-21T01:00:01.000Z')
    `).run(
      sourceId,
      sourceDefinition.contract.contractSha256,
      '3'.repeat(64),
      '4'.repeat(64),
      '5'.repeat(64),
      '6'.repeat(64),
      sourceVersion.id,
    );
    db.prepare(`
      UPDATE analytics_dataset_assertion_evaluations
      SET observed_json = '"/private/check"', expected_json = '"SELECT expected"'
      WHERE version_id = ?
    `).run(sourceVersion.id);
    db.prepare(`
      UPDATE analytics_dataset_runs SET error = '/private/source/error', receipt_json = '{"sql":"SELECT raw"}'
      WHERE output_version_id = ?
    `).run(sourceVersion.id);

    const list = environment.service.listCatalogDatasets({ limit: 1 });
    expect(list).toMatchObject({ count: 2, limit: 1, truncated: true });
    expect(list.dataRoomVersion).not.toBe(beforeRelations);
    const detail = environment.service.getCatalogDataset(sourceId)!;
    expect(detail.dataset.bindingTemplate).toMatchObject({
      datasetId: sourceId,
      versionPolicy: 'latest_compatible',
      request: { dimensions: ['event_date', 'user_id'], datasetId: sourceId },
    });
    expect(detail.dataset.projects.items).toEqual([expect.objectContaining({ projectId: 'project_catalog', title: 'Catalog project' })]);
    expect(detail.dataset.dependents.items).toEqual([expect.objectContaining({ datasetId: dependentId, alias: 'source' })]);
    expect(detail.dataset.consumers.items).toEqual([expect.objectContaining({
      dashboardId: 'dash_catalog', widgetId: 'widget_catalog', lastAppliedVersionId: sourceVersion.id,
    })]);
    expect(detail.dataset.dashboardOwners.items).toEqual([expect.objectContaining({ dashboardId: 'dash_catalog' })]);
    expect(detail.dataset.activity.items).toHaveLength(2);
    expect(detail.dataset.activity.items.map(item => item.kind)).toEqual(expect.arrayContaining(['source', 'derived']));
    expect(detail.dataset.activity.items.map(item => `${item.queuedAt}:${item.id}`))
      .toEqual([...detail.dataset.activity.items]
        .sort((left, right) => right.queuedAt.localeCompare(left.queuedAt) || left.id.localeCompare(right.id))
        .map(item => `${item.queuedAt}:${item.id}`));

    const versionDetail = environment.service.getCatalogDatasetVersion(sourceVersion.id)!;
    expect(versionDetail.version.quality.items).toEqual([{
      assertionId: 'row_count_positive', assertionVersion: '1', severity: 'error', success: true,
    }]);
    expect(versionDetail.version.outputs.items).toEqual([expect.objectContaining({
      datasetId: dependentId,
      versionId: dependentVersion.id,
      alias: 'source',
    })]);
    const versions = environment.service.listCatalogDatasetVersions(sourceId, { limit: 1 })!;
    expect(versions).toMatchObject({ count: 1, limit: 1, truncated: false });
    expect(versions.dataRoomVersion).toBe(detail.dataRoomVersion);

    const payload = { list, detail, versionDetail, versions };
    const forbiddenKeys = new Set(['definition', 'ownerId', 'sourceReceipt', 'files', 'observed', 'expected', 'error', 'receipt', 'remoteIdentity']);
    const walk = (value: unknown): void => {
      if (!value || typeof value !== 'object') return;
      for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        expect(forbiddenKeys.has(key), key).toBe(false);
        walk(child);
      }
    };
    walk(payload);
    const serialized = JSON.stringify(payload);
    for (const forbidden of [
      'SELECT private_catalog_value', '/private/data-room/never-project', '/private/brain/path',
      'SELECT should_never_escape', 'private-row', '/private/error', '/private/check',
      'SELECT expected', 'run-9001', 'SELECT raw', 'never expose',
    ]) expect(serialized).not.toContain(forbidden);
  });

  it('searches one logical row per dataset with exact identity first and zero writes', () => {
    const exact = definition('ds_search_exact');
    exact.name = 'Shared search title';
    exact.description = 'Exact identity dataset';
    const sameA = definition('ds_search_same_a');
    sameA.name = 'Shared search title';
    sameA.description = 'First same-title dataset';
    const sameB = definition('ds_search_same_b');
    sameB.name = 'Shared search title';
    sameB.description = 'Second same-title dataset';
    const literal = definition('ds_search_percent');
    literal.name = '100% literal dataset';
    for (const item of [exact, sameA, sameB, literal]) environment.service.registerDataset(item);
    const bytes = tsv(1);
    const promoted = environment.service.ingestEtlTsv(etlInput(
      exact.id,
      writeResult(sourceDirectory, 'search-exact.tsv', bytes),
      bytes,
      0,
    )).version;
    const beforeChanges = environment.storage.getDb().totalChanges;

    const exactHits = environment.service.searchDatasets(exact.id, 10);
    expect(exactHits[0]).toMatchObject({
      datasetId: exact.id,
      matchField: 'id',
      currentVersion: { id: promoted.id, ordinal: 1, integrityStatus: 'verified' },
    });
    const sameTitle = environment.service.searchDatasets('shared search title', 10);
    expect(sameTitle.map(hit => hit.datasetId)).toEqual(expect.arrayContaining([
      'ds_search_exact', 'ds_search_same_a', 'ds_search_same_b',
    ]));
    expect(environment.service.searchDatasets('shared search title', 10)).toEqual(sameTitle);
    expect(new Set(sameTitle.map(hit => hit.datasetId)).size).toBe(3);
    expect(sameTitle.every(hit => hit.matchField === 'name')).toBe(true);
    expect(environment.service.searchDatasets('%', 10).map(hit => hit.datasetId))
      .toEqual(['ds_search_percent']);
    expect(environment.service.searchDatasets('first same-title', 10))
      .toEqual([expect.objectContaining({ datasetId: 'ds_search_same_a', matchField: 'description' })]);
    expect(environment.service.searchDatasets('r1-test', 10)).toHaveLength(4);
    expect(environment.service.searchDatasets('r1-test', 10).every(hit => hit.matchField === 'domainKey')).toBe(true);
    expect(environment.service.searchDatasets(promoted.id, 10)).toEqual([]);
    expect(environment.service.searchDatasets('dataset', 1)).toHaveLength(1);
    expect(environment.service.searchDatasets('', 10)).toEqual([]);
    expect(() => environment.service.searchDatasets('x'.repeat(241), 10)).toThrow(/too long/i);
    expect(() => environment.service.searchDatasets('dataset', 0)).toThrow(/limit/i);
    expect(() => environment.service.searchDatasets('dataset', 101)).toThrow(/limit/i);
    expect(environment.storage.getDb().totalChanges).toBe(beforeChanges);
  });
});

describe('analytics data-room R1 TSV parser', () => {
  it('preserves quoted tabs/newlines, CRLF rows, and trailing empty cells', () => {
    const parsed = parseAnalyticsTsv(Buffer.from(
      'a\tb\tc\r\n"x\ty"\t"line 1\r\nline 2"\t\r\n',
      'utf8',
    ));
    expect(parsed).toEqual({
      columns: ['a', 'b', 'c'],
      rawRows: [['x\ty', 'line 1\nline 2', '']],
    });
  });

  it('fails closed on invalid UTF-8, NUL, duplicate headers, ragged rows, and malformed quoting', () => {
    const cases: Array<[string, Uint8Array]> = [
      ['invalid UTF-8', Buffer.from([0xff])],
      ['NUL', Buffer.from('a\tb\n1\u0000\t2\n')],
      ['duplicate header', Buffer.from('a\ta\n1\t2\n')],
      ['ragged row', Buffer.from('a\tb\n1\n')],
      ['single-column blank record', Buffer.from('a\n\n')],
      ['unclosed quote', Buffer.from('a\tb\n"1\t2\n')],
      ['lone carriage return', Buffer.from('a\tb\r1\t2')],
    ];
    for (const [name, bytes] of cases) {
      expect(() => parseAnalyticsTsv(bytes), name).toThrow();
    }
  });
});
