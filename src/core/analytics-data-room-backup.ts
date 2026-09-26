import type Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { analyticsSha256, stableAnalyticsJson } from './analytics-data-room-policy.js';
import {
  AnalyticsDataRoomError,
  analyticsDatasetContractSha256,
  analyticsDatasetSchemaSha256,
  type AnalyticsDataRoomStore,
} from './analytics-data-room-store.js';
import type {
  AnalyticsDatasetBackupReceipt,
  AnalyticsDatasetContract,
  AnalyticsDatasetRestoreReceipt,
  AnalyticsDatasetRetentionPolicy,
} from './analytics-data-room-types.js';

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const BACKUP_FORMAT = 'botboy-analytics-dataset-backup-v1';

interface BackupFileReceipt {
  relativePath: string;
  sha256: string;
  bytes: number;
}

interface BackupCatalog {
  format: typeof BACKUP_FORMAT;
  dataset: Record<string, unknown>;
  definitionRevisions: Array<Record<string, unknown>>;
  versions: Array<Record<string, unknown>>;
  assertions: Array<Record<string, unknown>>;
  head: Record<string, unknown> | null;
  runs: Array<Record<string, unknown>>;
  projectLinks: Array<Record<string, unknown>>;
}

interface BackupManifest {
  format: typeof BACKUP_FORMAT;
  backupId: string;
  datasetId: string;
  createdAt: string;
  versionIds: string[];
  files: BackupFileReceipt[];
}

interface VerifiedBackup {
  directory: string;
  manifest: BackupManifest;
  manifestSha256: string;
  catalog: BackupCatalog;
}

export interface AnalyticsDataRoomBackupService {
  backupDataset(datasetId: string, targetRoot: string): AnalyticsDatasetBackupReceipt;
  restoreDatasetBackup(backupDirectory: string): AnalyticsDatasetRestoreReceipt;
}

function fail(code: 'invalid_input' | 'not_found' | 'conflict' | 'integrity_failed', message: string): never {
  throw new AnalyticsDataRoomError(code, message);
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function ensurePrivateDirectory(directory: string): void {
  fs.mkdirSync(directory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail('integrity_failed', 'Backup path is not a regular directory.');
  fs.chmodSync(directory, PRIVATE_DIRECTORY_MODE);
}

function assertPrivateDirectory(directory: string): void {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) {
    fail('integrity_failed', 'Backup directory is not private and regular.');
  }
}

function contained(root: string, candidate: string): string {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(candidate);
  const relative = path.relative(resolvedRoot, resolved);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    fail('integrity_failed', 'Backup path escapes its allowed root.');
  }
  return resolved;
}

function hashFile(filePath: string): { sha256: string; bytes: number } {
  const descriptor = fs.openSync(filePath, 'r');
  const digest = createHash('sha256');
  const chunk = Buffer.allocUnsafe(1024 * 1024);
  let bytes = 0;
  try {
    while (true) {
      const read = fs.readSync(descriptor, chunk, 0, chunk.length, null);
      if (read === 0) break;
      digest.update(chunk.subarray(0, read));
      bytes += read;
    }
  } finally {
    fs.closeSync(descriptor);
  }
  return { sha256: digest.digest('hex'), bytes };
}

function verifyPrivateFile(filePath: string, expected: { sha256: string; bytes: number }): void {
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) {
    fail('integrity_failed', 'Backup contains a non-private file or symbolic link.');
  }
  const actual = hashFile(filePath);
  if (actual.sha256 !== expected.sha256 || actual.bytes !== expected.bytes) {
    fail('integrity_failed', 'Backup file differs from its manifest receipt.');
  }
}

function writePrivateFile(filePath: string, bytes: Uint8Array): void {
  const descriptor = fs.openSync(filePath, 'wx', PRIVATE_FILE_MODE);
  try {
    fs.writeFileSync(descriptor, bytes);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  fs.chmodSync(filePath, PRIVATE_FILE_MODE);
}

function copyPrivateFile(source: string, destination: string): BackupFileReceipt {
  const sourceStat = fs.lstatSync(source);
  if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) fail('integrity_failed', 'Version backup source is not a regular file.');
  ensurePrivateDirectory(path.dirname(destination));
  fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
  fs.chmodSync(destination, PRIVATE_FILE_MODE);
  const descriptor = fs.openSync(destination, 'r');
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  const receipt = hashFile(destination);
  return { relativePath: '', ...receipt };
}

function removeBestEffort(directory: string): void {
  try {
    fs.rmSync(directory, { recursive: true, force: true });
  } catch {
    // A complete final backup is immutable; abandoned staging is safe to retry.
  }
}

function parseJson<T>(raw: string, label: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fail('integrity_failed', `${label} is malformed JSON.`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function syncDirectory(directory: string): void {
  let descriptor: number | null = null;
  try {
    descriptor = fs.openSync(directory, 'r');
    fs.fsyncSync(descriptor);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'EINVAL' && code !== 'ENOTSUP') throw error;
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
  }
}

function listFiles(root: string, relative = ''): string[] {
  const directory = relative ? contained(root, path.join(root, relative)) : root;
  const files: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const childRelative = relative ? path.join(relative, entry.name) : entry.name;
    const child = contained(root, path.join(root, childRelative));
    if (entry.isSymbolicLink()) fail('integrity_failed', 'Backup contains a symbolic link.');
    if (entry.isDirectory()) files.push(...listFiles(root, childRelative));
    else if (entry.isFile()) files.push(childRelative);
    else fail('integrity_failed', 'Backup contains an unsupported filesystem entry.');
  }
  return files.sort();
}

function insertRaw(
  db: Database.Database,
  table: string,
  columns: string[],
  row: Record<string, unknown>,
): void {
  const names = columns.map(column => `"${column}"`).join(', ');
  const placeholders = columns.map(() => '?').join(', ');
  db.prepare(`INSERT OR IGNORE INTO "${table}" (${names}) VALUES (${placeholders})`)
    .run(...columns.map(column => row[column] ?? null));
}

function assertExactRow(
  db: Database.Database,
  table: string,
  keyColumn: string,
  key: unknown,
  columns: string[],
  expected: Record<string, unknown>,
): void {
  const actual = db.prepare(`SELECT ${columns.map(column => `"${column}"`).join(', ')} FROM "${table}" WHERE "${keyColumn}" = ?`)
    .get(key) as Record<string, unknown> | undefined;
  const expectedValues = Object.fromEntries(columns.map(column => [column, expected[column] ?? null]));
  if (!actual || stableAnalyticsJson(actual) !== stableAnalyticsJson(expectedValues)) {
    fail('conflict', `Backup conflicts with existing ${table} identity.`);
  }
}

const DATASET_COLUMNS = [
  'id', 'name', 'description', 'kind', 'scope', 'domain_key', 'owner_id', 'lifecycle',
  'source_kind', 'source_format', 'definition_json', 'definition_revision',
  'definition_sha256', 'contract_json', 'contract_sha256', 'schema_sha256',
  'retention_json', 'minimum_versions', 'automatic_expiry', 'reacquirable',
  'backup_required', 'created_at', 'updated_at',
];
const DEFINITION_COLUMNS = [
  'dataset_id', 'revision', 'definition_json', 'definition_sha256', 'contract_json',
  'contract_sha256', 'schema_sha256', 'retention_json', 'created_at',
];
const VERSION_COLUMNS = [
  'id', 'dataset_id', 'ordinal', 'version_key_sha256', 'source_format',
  'source_rel_path', 'source_sha256', 'source_bytes', 'materialized_rel_path',
  'materialized_sha256', 'materialized_bytes', 'manifest_rel_path',
  'manifest_sha256', 'row_count', 'observed_schema_json', 'observed_schema_sha256',
  'contract_json', 'contract_sha256', 'coverage_json', 'watermark',
  'source_receipt_json', 'definition_sha256', 'handling_json', 'integrity_status',
  'integrity_verified_at', 'quarantine_reason', 'reacquirable', 'materialized_at', 'created_at',
];
const ASSERTION_COLUMNS = [
  'id', 'version_id', 'assertion_id', 'assertion_version', 'severity', 'success',
  'observed_json', 'expected_json', 'created_at',
];
const HEAD_COLUMNS = [
  'dataset_id', 'version_id', 'definition_revision', 'head_revision',
  'promoted_at', 'promotion_receipt_json',
];
const RUN_COLUMNS = [
  'id', 'dataset_id', 'trigger', 'request_sha256', 'definition_revision',
  'definition_sha256', 'status', 'source_kind', 'remote_identity_json',
  'staging_rel_path', 'lease_owner', 'lease_expires_at', 'heartbeat_at',
  'output_version_id', 'receipt_json', 'error', 'queued_at', 'started_at', 'completed_at',
];
const PROJECT_LINK_COLUMNS = ['dataset_id', 'project_id', 'linked_at'];

function canonicalRecord(raw: unknown, label: string): Record<string, unknown> {
  if (typeof raw !== 'string') fail('integrity_failed', `${label} is missing canonical JSON.`);
  const parsed = parseJson<unknown>(raw, label);
  if (!isRecord(parsed) || stableAnalyticsJson(parsed) !== raw) {
    fail('integrity_failed', `${label} is not a canonical JSON object.`);
  }
  return parsed;
}

function validateRetentionSnapshot(raw: unknown, label: string): AnalyticsDatasetRetentionPolicy {
  const parsed = canonicalRecord(raw, label) as unknown as AnalyticsDatasetRetentionPolicy;
  if (!Number.isInteger(parsed.minimumVersions) || parsed.minimumVersions < 1
    || typeof parsed.automaticExpiry !== 'boolean'
    || typeof parsed.reacquirable !== 'boolean'
    || typeof parsed.backupRequired !== 'boolean'
    || (parsed.automaticExpiry && !parsed.reacquirable && !parsed.backupRequired)) {
    fail('integrity_failed', `${label} is malformed.`);
  }
  return parsed;
}

function validateDefinitionSnapshot(row: Record<string, unknown>, datasetId: string, label: string): void {
  if (row.dataset_id !== undefined && row.dataset_id !== datasetId) {
    fail('integrity_failed', `${label} has the wrong dataset identity.`);
  }
  const definition = canonicalRecord(row.definition_json, `${label} definition`);
  if (analyticsSha256(definition) !== row.definition_sha256) {
    fail('integrity_failed', `${label} definition SHA is invalid.`);
  }
  const contract = canonicalRecord(row.contract_json, `${label} contract`) as unknown as AnalyticsDatasetContract;
  if (!Array.isArray(contract.schema)
    || contract.datasetId !== datasetId
    || analyticsDatasetContractSha256(contract) !== row.contract_sha256
    || contract.contractSha256 !== row.contract_sha256
    || analyticsDatasetSchemaSha256(contract.schema) !== row.schema_sha256
    || contract.schemaSha256 !== row.schema_sha256) {
    fail('integrity_failed', `${label} contract/schema SHA is invalid.`);
  }
  validateRetentionSnapshot(row.retention_json, `${label} retention`);
}

function validateBackupCatalog(catalog: BackupCatalog, manifest: BackupManifest): void {
  const datasetId = manifest.datasetId;
  if (catalog.dataset.id !== datasetId) fail('integrity_failed', 'Backup dataset identity is invalid.');
  validateDefinitionSnapshot(catalog.dataset, datasetId, 'Backup dataset');
  if (!Number.isInteger(catalog.dataset.definition_revision)
    || Number(catalog.dataset.definition_revision) < 1) {
    fail('integrity_failed', 'Backup dataset revision is invalid.');
  }
  for (const revision of catalog.definitionRevisions) {
    if (!Number.isInteger(revision.revision) || Number(revision.revision) < 1) {
      fail('integrity_failed', 'Backup definition revision is invalid.');
    }
    validateDefinitionSnapshot(revision, datasetId, 'Backup definition revision');
  }
  const versionIds = new Set(manifest.versionIds);
  for (const version of catalog.versions) {
    if (version.dataset_id !== datasetId || !versionIds.has(String(version.id))) {
      fail('integrity_failed', 'Backup version has the wrong dataset identity.');
    }
    const contract = canonicalRecord(version.contract_json, 'Backup version contract') as unknown as AnalyticsDatasetContract;
    if (!Array.isArray(contract.schema)
      || analyticsDatasetContractSha256(contract) !== version.contract_sha256
      || contract.contractSha256 !== version.contract_sha256
      || analyticsDatasetSchemaSha256(contract.schema) !== contract.schemaSha256) {
      fail('integrity_failed', 'Backup version contract is invalid.');
    }
    canonicalRecord(version.coverage_json, 'Backup version coverage');
    canonicalRecord(version.source_receipt_json, 'Backup version source receipt');
    canonicalRecord(version.handling_json, 'Backup version handling');
    if (version.integrity_status !== 'verified' || version.quarantine_reason != null) {
      fail('integrity_failed', 'Backup contains a version that was not verified.');
    }
  }
  if (catalog.head
    && (catalog.head.dataset_id !== datasetId || !versionIds.has(String(catalog.head.version_id)))) {
    fail('integrity_failed', 'Backup head does not reference a contained version.');
  }
  for (const assertion of catalog.assertions) {
    if (!versionIds.has(String(assertion.version_id))) fail('integrity_failed', 'Backup assertion references another dataset.');
  }
  for (const run of catalog.runs) {
    if (run.dataset_id !== datasetId
      || (run.output_version_id != null && !versionIds.has(String(run.output_version_id)))) {
      fail('integrity_failed', 'Backup run references another dataset or version.');
    }
  }
  for (const link of catalog.projectLinks) {
    if (link.dataset_id !== datasetId) fail('integrity_failed', 'Backup project link references another dataset.');
  }
}

function stableBackupIdentity(catalog: BackupCatalog, files: BackupFileReceipt[]): string {
  const stableCatalog = {
    ...catalog,
    versions: catalog.versions.map(version => {
      const { integrity_verified_at: _lastVerification, ...stableVersion } = version;
      return stableVersion;
    }),
  };
  return `dsbk_${sha256(Buffer.from(stableAnalyticsJson({
    datasetId: catalog.dataset.id,
    catalog: stableCatalog,
    files,
  }))).slice(0, 24)}`;
}

export function createAnalyticsDataRoomBackupService(input: {
  db: Database.Database;
  store: AnalyticsDataRoomStore;
  now?: () => Date;
  createId?: () => string;
}): AnalyticsDataRoomBackupService {
  const { db, store } = input;
  const now = input.now ?? (() => new Date());
  const createId = input.createId ?? (() => randomUUID().replace(/-/g, ''));

  function timestamp(): string {
    return now().toISOString();
  }

  function catalogForDataset(datasetId: string): BackupCatalog {
    const dataset = db.prepare('SELECT * FROM analytics_datasets WHERE id = ?').get(datasetId) as Record<string, unknown> | undefined;
    if (!dataset) fail('not_found', `Dataset ${datasetId} was not found.`);
    if (dataset.kind === 'derived') {
      fail(
        'conflict',
        'R3 does not create a misleading single-dataset backup for derived output. Preserve its deletion-protected exact inputs and definition, then recompute; coherent lineage-closure backup remains a separate evidence-gated capability.',
      );
    }
    const boundConsumer = db.prepare(`
      SELECT 1 FROM analytics_widget_dataset_bindings WHERE dataset_id = ?
      UNION ALL
      SELECT 1 FROM analytics_run_widget_data_room_snapshots WHERE dataset_id = ?
      UNION ALL
      SELECT 1 FROM analytics_dataset_dashboard_owners WHERE dataset_id = ?
      LIMIT 1
    `).get(datasetId, datasetId, datasetId);
    if (boundConsumer) {
      fail(
        'conflict',
        'R4 cannot label a dataset-only copy coherent while dashboard ownership, bindings, or historical run snapshots are outside backup format v1. Preserve the stopped private-state snapshot before changing this consumer closure.',
      );
    }
    const activeRun = db.prepare(`
      SELECT 1 FROM analytics_dataset_runs
      WHERE dataset_id = ? AND status IN ('staging','verifying') LIMIT 1
    `).get(datasetId);
    if (activeRun) fail('conflict', 'A dataset backup cannot start while acquisition is active.');
    const versions = db.prepare(`
      SELECT * FROM analytics_dataset_versions WHERE dataset_id = ? ORDER BY ordinal, id
    `).all(datasetId) as Array<Record<string, unknown>>;
    for (const version of versions) store.verifyVersion(String(version.id));
    return {
      format: BACKUP_FORMAT,
      dataset: db.prepare('SELECT * FROM analytics_datasets WHERE id = ?').get(datasetId) as Record<string, unknown>,
      definitionRevisions: db.prepare(`
        SELECT * FROM analytics_dataset_definition_revisions WHERE dataset_id = ? ORDER BY revision
      `).all(datasetId) as Array<Record<string, unknown>>,
      versions: db.prepare(`
        SELECT * FROM analytics_dataset_versions WHERE dataset_id = ? ORDER BY ordinal, id
      `).all(datasetId) as Array<Record<string, unknown>>,
      assertions: db.prepare(`
        SELECT a.* FROM analytics_dataset_assertion_evaluations a
        JOIN analytics_dataset_versions v ON v.id = a.version_id
        WHERE v.dataset_id = ? ORDER BY a.version_id, a.assertion_id, a.assertion_version
      `).all(datasetId) as Array<Record<string, unknown>>,
      head: (db.prepare('SELECT * FROM analytics_dataset_heads WHERE dataset_id = ?').get(datasetId) as Record<string, unknown> | undefined) ?? null,
      runs: db.prepare(`
        SELECT * FROM analytics_dataset_runs WHERE dataset_id = ? ORDER BY queued_at, id
      `).all(datasetId) as Array<Record<string, unknown>>,
      projectLinks: db.prepare(`
        SELECT * FROM analytics_dataset_project_links WHERE dataset_id = ? ORDER BY project_id
      `).all(datasetId) as Array<Record<string, unknown>>,
    };
  }

  function verifyBackup(backupDirectory: string): VerifiedBackup {
    const directory = path.resolve(backupDirectory);
    assertPrivateDirectory(directory);
    const manifestPath = contained(directory, path.join(directory, 'backup-manifest.json'));
    const manifestStat = fs.lstatSync(manifestPath);
    if (!manifestStat.isFile() || manifestStat.isSymbolicLink() || (manifestStat.mode & 0o077) !== 0) {
      fail('integrity_failed', 'Backup manifest is not a private regular file.');
    }
    const manifestBytes = fs.readFileSync(manifestPath);
    const manifest = parseJson<BackupManifest>(manifestBytes.toString('utf8'), 'Backup manifest');
    if (manifest.format !== BACKUP_FORMAT
      || !/^dsbk_[a-f0-9]{24}$/.test(manifest.backupId)
      || !/^ds_[a-zA-Z0-9_-]{1,96}$/.test(manifest.datasetId)
      || !Array.isArray(manifest.versionIds)
      || !Array.isArray(manifest.files)) {
      fail('integrity_failed', 'Backup manifest contract is invalid.');
    }
    const expectedPaths = new Set<string>();
    for (const receipt of manifest.files) {
      if (!receipt || typeof receipt.relativePath !== 'string'
        || !/^[a-f0-9]{64}$/.test(receipt.sha256)
        || !Number.isInteger(receipt.bytes) || receipt.bytes < 0
        || expectedPaths.has(receipt.relativePath)) {
        fail('integrity_failed', 'Backup file receipt is invalid or duplicated.');
      }
      expectedPaths.add(receipt.relativePath);
      const filePath = contained(directory, path.join(directory, receipt.relativePath));
      verifyPrivateFile(filePath, receipt);
    }
    const actualPaths = listFiles(directory);
    const expectedAll = [...expectedPaths, 'backup-manifest.json'].sort();
    if (stableAnalyticsJson(actualPaths) !== stableAnalyticsJson(expectedAll)) {
      fail('integrity_failed', 'Backup file set differs from its manifest.');
    }
    const catalogReceipt = manifest.files.find(file => file.relativePath === 'catalog.json');
    if (!catalogReceipt) fail('integrity_failed', 'Backup catalog receipt is missing.');
    const catalog = parseJson<BackupCatalog>(
      fs.readFileSync(contained(directory, path.join(directory, 'catalog.json')), 'utf8'),
      'Backup catalog',
    );
    if (!isRecord(catalog)
      || catalog.format !== BACKUP_FORMAT
      || !isRecord(catalog.dataset)
      || !Array.isArray(catalog.definitionRevisions)
      || !Array.isArray(catalog.versions)
      || !Array.isArray(catalog.assertions)
      || !Array.isArray(catalog.runs)
      || !Array.isArray(catalog.projectLinks)
      || [...catalog.definitionRevisions, ...catalog.versions, ...catalog.assertions, ...catalog.runs, ...catalog.projectLinks]
        .some(value => !isRecord(value))
      || String(catalog.dataset.id) !== manifest.datasetId
      || stableAnalyticsJson(catalog.versions.map(version => String(version.id)).sort())
        !== stableAnalyticsJson([...manifest.versionIds].sort())) {
      fail('integrity_failed', 'Backup catalog identity differs from its manifest.');
    }
    validateBackupCatalog(catalog, manifest);
    const identityFiles = manifest.files.filter(file => file.relativePath !== 'catalog.json');
    if (stableBackupIdentity(catalog, identityFiles) !== manifest.backupId
      || path.basename(directory) !== manifest.backupId) {
      fail('integrity_failed', 'Backup content identity does not match its directory and manifest.');
    }
    return {
      directory,
      manifest,
      manifestSha256: sha256(manifestBytes),
      catalog,
    };
  }

  function recordBackup(verified: VerifiedBackup): AnalyticsDatasetBackupReceipt {
    const at = verified.manifest.createdAt;
    db.transaction(() => {
      db.prepare(`
        INSERT OR IGNORE INTO analytics_dataset_backups
          (id, dataset_id, target_path, manifest_sha256, version_ids_json,
           status, created_at, verified_at)
        VALUES (?, ?, ?, ?, ?, 'verified', ?, ?)
      `).run(
        verified.manifest.backupId,
        verified.manifest.datasetId,
        verified.directory,
        verified.manifestSha256,
        stableAnalyticsJson(verified.manifest.versionIds),
        at,
        timestamp(),
      );
      const row = db.prepare('SELECT * FROM analytics_dataset_backups WHERE id = ?').get(verified.manifest.backupId) as Record<string, unknown>;
      if (!row
        || row.dataset_id !== verified.manifest.datasetId
        || row.target_path !== verified.directory
        || row.manifest_sha256 !== verified.manifestSha256) {
        fail('conflict', 'Backup identity already exists with different content or location.');
      }
      const link = db.prepare(`
        INSERT OR IGNORE INTO analytics_dataset_backup_versions (backup_id, version_id)
        VALUES (?, ?)
      `);
      for (const versionId of verified.manifest.versionIds) link.run(verified.manifest.backupId, versionId);
    })();
    return {
      backupId: verified.manifest.backupId,
      datasetId: verified.manifest.datasetId,
      targetDirectory: verified.directory,
      manifestSha256: verified.manifestSha256,
      versionIds: verified.manifest.versionIds,
      createdAt: verified.manifest.createdAt,
      verifiedAt: timestamp(),
    };
  }

  function backupDataset(datasetId: string, targetRoot: string): AnalyticsDatasetBackupReceipt {
    const catalog = catalogForDataset(datasetId);
    const versionIds = catalog.versions.map(version => String(version.id));
    const catalogBytes = Buffer.from(`${stableAnalyticsJson(catalog)}\n`, 'utf8');
    const sourceFiles: Array<{ source: string; backupRelative: string }> = [];
    for (const version of catalog.versions) {
      const versionId = String(version.id);
      for (const column of ['source_rel_path', 'materialized_rel_path', 'manifest_rel_path']) {
        const source = contained(store.rootDir, path.join(store.rootDir, String(version[column])));
        sourceFiles.push({
          source,
          backupRelative: path.join('versions', versionId, path.basename(source)),
        });
      }
    }
    const sourceReceipts = sourceFiles.map(file => ({
      relativePath: file.backupRelative,
      ...hashFile(file.source),
    })).sort((left, right) => left.relativePath.localeCompare(right.relativePath));
    const backupId = stableBackupIdentity(catalog, sourceReceipts);
    const root = path.resolve(targetRoot);
    ensurePrivateDirectory(root);
    const finalDirectory = path.join(root, backupId);
    if (fs.existsSync(finalDirectory)) return recordBackup(verifyBackup(finalDirectory));
    const stagingDirectory = path.join(root, `.${backupId}.${createId().slice(0, 12)}.staging`);
    ensurePrivateDirectory(stagingDirectory);
    try {
      const fileReceipts: BackupFileReceipt[] = [];
      const catalogPath = path.join(stagingDirectory, 'catalog.json');
      writePrivateFile(catalogPath, catalogBytes);
      fileReceipts.push({ relativePath: 'catalog.json', sha256: sha256(catalogBytes), bytes: catalogBytes.length });
      for (const file of sourceFiles) {
        const destination = contained(stagingDirectory, path.join(stagingDirectory, file.backupRelative));
        const copied = copyPrivateFile(file.source, destination);
        fileReceipts.push({ ...copied, relativePath: file.backupRelative });
      }
      fileReceipts.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
      const createdAt = timestamp();
      const manifest: BackupManifest = {
        format: BACKUP_FORMAT,
        backupId,
        datasetId,
        createdAt,
        versionIds,
        files: fileReceipts,
      };
      writePrivateFile(
        path.join(stagingDirectory, 'backup-manifest.json'),
        Buffer.from(`${stableAnalyticsJson(manifest)}\n`, 'utf8'),
      );
      syncDirectory(stagingDirectory);
      fs.renameSync(stagingDirectory, finalDirectory);
      fs.chmodSync(finalDirectory, PRIVATE_DIRECTORY_MODE);
      syncDirectory(root);
      return recordBackup(verifyBackup(finalDirectory));
    } catch (error) {
      removeBestEffort(stagingDirectory);
      throw error;
    }
  }

  function restoreDatasetBackup(backupDirectory: string): AnalyticsDatasetRestoreReceipt {
    const verified = verifyBackup(backupDirectory);
    const { catalog, manifest } = verified;
    const datasetId = manifest.datasetId;
    const alreadyExists = Boolean(db.prepare('SELECT 1 FROM analytics_datasets WHERE id = ?').get(datasetId));
    const datasetRoot = path.join(store.rootDir, datasetId);
    const versionsRoot = path.join(datasetRoot, 'versions');
    ensurePrivateDirectory(store.rootDir);
    ensurePrivateDirectory(datasetRoot);
    ensurePrivateDirectory(versionsRoot);
    ensurePrivateDirectory(path.join(datasetRoot, 'staging'));

    for (const receipt of manifest.files.filter(file => file.relativePath.startsWith(`versions${path.sep}`))) {
      const segments = receipt.relativePath.split(path.sep);
      if (segments.length !== 3 || !manifest.versionIds.includes(segments[1])) {
        fail('integrity_failed', 'Backup version path is malformed.');
      }
      const source = contained(verified.directory, path.join(verified.directory, receipt.relativePath));
      const destinationDirectory = path.join(versionsRoot, segments[1]);
      ensurePrivateDirectory(destinationDirectory);
      const destination = contained(store.rootDir, path.join(destinationDirectory, segments[2]));
      if (fs.existsSync(destination)) {
        try {
          verifyPrivateFile(destination, receipt);
        } catch (error) {
          const existing = db.prepare(`
            SELECT integrity_status FROM analytics_dataset_versions WHERE id = ?
          `).get(segments[1]) as { integrity_status: string } | undefined;
          if (existing?.integrity_status !== 'quarantined') throw error;
          const replacement = path.join(destinationDirectory, `.${segments[2]}.${createId().slice(0, 12)}.restore`);
          try {
            const copied = copyPrivateFile(source, replacement);
            if (copied.sha256 !== receipt.sha256 || copied.bytes !== receipt.bytes) {
              fail('integrity_failed', 'Backup repair bytes differ from the immutable receipt.');
            }
            fs.renameSync(replacement, destination);
            fs.chmodSync(destination, PRIVATE_FILE_MODE);
          } finally {
            try { fs.rmSync(replacement, { force: true }); } catch {}
          }
        }
      } else {
        const copied = copyPrivateFile(source, destination);
        if (copied.sha256 !== receipt.sha256 || copied.bytes !== receipt.bytes) {
          fail('integrity_failed', 'Restored version file differs from the backup receipt.');
        }
      }
    }
    for (const versionId of manifest.versionIds) {
      syncDirectory(path.join(versionsRoot, versionId));
    }
    syncDirectory(versionsRoot);

    db.transaction(() => {
      insertRaw(db, 'analytics_datasets', DATASET_COLUMNS, catalog.dataset);
      assertExactRow(db, 'analytics_datasets', 'id', datasetId, DATASET_COLUMNS, catalog.dataset);
      for (const row of catalog.definitionRevisions) {
        insertRaw(db, 'analytics_dataset_definition_revisions', DEFINITION_COLUMNS, row);
        const actual = db.prepare(`
          SELECT * FROM analytics_dataset_definition_revisions WHERE dataset_id = ? AND revision = ?
        `).get(row.dataset_id, row.revision) as Record<string, unknown> | undefined;
        if (!actual || stableAnalyticsJson(Object.fromEntries(DEFINITION_COLUMNS.map(column => [column, actual[column] ?? null])))
          !== stableAnalyticsJson(Object.fromEntries(DEFINITION_COLUMNS.map(column => [column, row[column] ?? null])))) {
          fail('conflict', 'Backup conflicts with an existing definition revision.');
        }
      }
      for (const row of catalog.versions) {
        insertRaw(db, 'analytics_dataset_versions', VERSION_COLUMNS, row);
        const immutableColumns = VERSION_COLUMNS.filter(column => (
          column !== 'integrity_verified_at'
          && column !== 'integrity_status'
          && column !== 'quarantine_reason'
        ));
        assertExactRow(db, 'analytics_dataset_versions', 'id', row.id, immutableColumns, row);
        db.prepare(`
          UPDATE analytics_dataset_versions
          SET integrity_status = 'verified', quarantine_reason = NULL,
              integrity_verified_at = NULL
          WHERE id = ?
        `).run(row.id);
      }
      for (const row of catalog.assertions) {
        insertRaw(db, 'analytics_dataset_assertion_evaluations', ASSERTION_COLUMNS, row);
        assertExactRow(db, 'analytics_dataset_assertion_evaluations', 'id', row.id, ASSERTION_COLUMNS, row);
      }
      if (catalog.head) {
        insertRaw(db, 'analytics_dataset_heads', HEAD_COLUMNS, catalog.head);
        assertExactRow(db, 'analytics_dataset_heads', 'dataset_id', datasetId, HEAD_COLUMNS, catalog.head);
      }
      for (const row of catalog.runs) {
        insertRaw(db, 'analytics_dataset_runs', RUN_COLUMNS, row);
        assertExactRow(db, 'analytics_dataset_runs', 'id', row.id, RUN_COLUMNS, row);
      }
      for (const row of catalog.projectLinks) {
        insertRaw(db, 'analytics_dataset_project_links', PROJECT_LINK_COLUMNS, row);
        const actual = db.prepare(`
          SELECT * FROM analytics_dataset_project_links WHERE dataset_id = ? AND project_id = ?
        `).get(row.dataset_id, row.project_id) as Record<string, unknown> | undefined;
        if (!actual || stableAnalyticsJson(actual) !== stableAnalyticsJson(row)) {
          fail('conflict', 'Backup conflicts with an existing project link.');
        }
      }
      db.prepare(`
        INSERT OR IGNORE INTO analytics_dataset_backups
          (id, dataset_id, target_path, manifest_sha256, version_ids_json,
           status, created_at, verified_at)
        VALUES (?, ?, ?, ?, ?, 'verified', ?, ?)
      `).run(
        manifest.backupId,
        datasetId,
        verified.directory,
        verified.manifestSha256,
        stableAnalyticsJson(manifest.versionIds),
        manifest.createdAt,
        timestamp(),
      );
      const link = db.prepare(`
        INSERT OR IGNORE INTO analytics_dataset_backup_versions (backup_id, version_id)
        VALUES (?, ?)
      `);
      for (const versionId of manifest.versionIds) link.run(manifest.backupId, versionId);
    })();

    for (const versionId of manifest.versionIds) store.verifyVersion(versionId);
    const restoredAt = timestamp();
    const restoreId = `dsrestore_${createId().slice(0, 24)}`;
    db.prepare(`
      INSERT INTO analytics_dataset_restore_receipts
        (id, backup_id, dataset_id, version_ids_json, status, idempotent, detail_json, created_at)
      VALUES (?, ?, ?, ?, 'verified', ?, ?, ?)
    `).run(
      restoreId,
      manifest.backupId,
      datasetId,
      stableAnalyticsJson(manifest.versionIds),
      alreadyExists ? 1 : 0,
      stableAnalyticsJson({ manifestSha256: verified.manifestSha256, sourceDirectory: verified.directory }),
      restoredAt,
    );
    return {
      restoreId,
      backupId: manifest.backupId,
      datasetId,
      versionIds: manifest.versionIds,
      restoredAt,
      idempotent: alreadyExists,
    };
  }

  return { backupDataset, restoreDatasetBackup };
}
