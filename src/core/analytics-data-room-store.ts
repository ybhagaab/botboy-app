import Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  analyticsSha256,
  normalizeAnalyticsRequest,
  stableAnalyticsJson,
} from './analytics-data-room-policy.js';
import { readAnalyticsDataRoomVersion } from './analytics-data-room-version.js';
import {
  analyticsDerivedTransformSha256,
  parseAnalyticsDerivedDefinition,
  validateAnalyticsRelationalContract,
} from './analytics-data-room-derived-contract.js';
import type {
  AnalyticsDataCell,
  AnalyticsDataRoomCatalogActivity,
  AnalyticsDataRoomCatalogConsumer,
  AnalyticsDataRoomCatalogDashboardOwner,
  AnalyticsDataRoomCatalogDatasetDetail,
  AnalyticsDataRoomCatalogDatasetEnvelope,
  AnalyticsDataRoomCatalogDatasetList,
  AnalyticsDataRoomCatalogDatasetSummary,
  AnalyticsDataRoomDatasetSearchHit,
  AnalyticsDataRoomCatalogDependency,
  AnalyticsDataRoomCatalogDependent,
  AnalyticsDataRoomCatalogHead,
  AnalyticsDataRoomCatalogProject,
  AnalyticsDataRoomCatalogQuality,
  AnalyticsDataRoomCatalogVersionDetail,
  AnalyticsDataRoomCatalogVersionEnvelope,
  AnalyticsDataRoomCatalogVersionInput,
  AnalyticsDataRoomCatalogVersionList,
  AnalyticsDataRoomCatalogVersionOutput,
  AnalyticsDataRoomCatalogVersionSummary,
  AnalyticsDataRoomErrorCode,
  AnalyticsDataRoomSourceFormat,
  AnalyticsDatasetCatalogVisibility,
  AnalyticsDatasetContract,
  AnalyticsDatasetDefinitionInput,
  AnalyticsDatasetDefinitionRecord,
  AnalyticsDatasetDefinitionDocument,
  AnalyticsDatasetDependencyRecord,
  AnalyticsDatasetDetail,
  AnalyticsDatasetHeadRecord,
  AnalyticsDatasetRetentionPolicy,
  AnalyticsDatasetRevisionInput,
  AnalyticsDatasetRunRecord,
  AnalyticsDatasetSummary,
  AnalyticsDatasetVersionDetail,
  AnalyticsDatasetVersionManifest,
  AnalyticsDatasetVersionSummary,
  AnalyticsDataRoomUse,
  AnalyticsDerivationLineageReceipt,
  AnalyticsDerivedDefinitionV1,
  AnalyticsFieldContract,
  AnalyticsHandlingContract,
  AnalyticsQualityAssertionEvaluation,
  AnalyticsRequest,
  AnalyticsStoredFileReceipt,
  AnalyticsVersionIngestContext,
  AnalyticsVersionIntegrityReceipt,
  AnalyticsVersionPromotionReceipt,
} from './analytics-data-room-types.js';

const DEFAULT_DATA_ROOM_ROOT = path.join(os.homedir(), '.personal-productivity-tracker', 'data-room');
const SHA256_RE = /^[a-f0-9]{64}$/;
const DATASET_ID_RE = /^ds_[a-zA-Z0-9_-]{1,96}$/;
const VERSION_ID_RE = /^dsv_[a-f0-9]{24}$/;
const RUN_ID_RE = /^dsrun_[a-f0-9]{32}$/;
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const RUN_LEASE_MS = 10 * 60_000;
const CATALOG_LIST_LIMIT = 100;
const CATALOG_RELATION_LIMIT = 50;
const CATALOG_CONSUMER_LIMIT = 100;
const CATALOG_ACTIVITY_LIMIT = 20;

export class AnalyticsDataRoomError extends Error {
  readonly code: AnalyticsDataRoomErrorCode;

  constructor(code: AnalyticsDataRoomErrorCode, message: string) {
    super(message);
    this.name = 'AnalyticsDataRoomError';
    this.code = code;
  }
}

export interface AnalyticsParsedSourceIngest extends AnalyticsVersionIngestContext {
  sourceFormat: AnalyticsDataRoomSourceFormat;
  sourceBytes: Uint8Array;
  columns: string[];
  rows: AnalyticsDataCell[][];
  /** R3 immutable exact-input lineage. Required for derived datasets and forbidden for sources. */
  derivation?: AnalyticsDerivationLineageReceipt;
}

export interface AnalyticsVersionDeletionEligibility {
  allowed: boolean;
  reasons: string[];
}

export interface AnalyticsDataRoomStore {
  readonly rootDir: string;
  registerDataset(input: AnalyticsDatasetDefinitionInput): AnalyticsDatasetDetail;
  setCatalogVisibility(datasetId: string, expected: AnalyticsDatasetCatalogVisibility, next: AnalyticsDatasetCatalogVisibility): AnalyticsDatasetDetail;
  reviseDataset(input: AnalyticsDatasetRevisionInput): AnalyticsDatasetDetail;
  listDependencies(datasetId: string, definitionRevision?: number): AnalyticsDatasetDependencyRecord[];
  isDerivedDatasetDirty(datasetId: string): boolean;
  listDatasets(limit?: number): AnalyticsDatasetSummary[];
  /** Complete internal catalog enumeration for trusted in-process consumers. */
  listAllDatasets(): AnalyticsDatasetSummary[];
  searchDatasets(query: string, limit?: number): AnalyticsDataRoomDatasetSearchHit[];
  /** Internal R2 retrieval by exact ID or domain; never exposed as title search. */
  findDatasetsForRequest(request: AnalyticsRequest): AnalyticsDatasetDetail[];
  getDataset(datasetId: string): AnalyticsDatasetDetail | null;
  listDatasetVersions(datasetId: string): AnalyticsDatasetVersionSummary[] | null;
  getDatasetVersion(versionId: string): AnalyticsDatasetVersionDetail | null;
  listCatalogDatasets(limit?: number): AnalyticsDataRoomCatalogDatasetList;
  getCatalogDataset(datasetId: string): AnalyticsDataRoomCatalogDatasetEnvelope | null;
  listCatalogDatasetVersions(datasetId: string, limit?: number): AnalyticsDataRoomCatalogVersionList | null;
  getCatalogDatasetVersion(versionId: string): AnalyticsDataRoomCatalogVersionEnvelope | null;
  publishParsedSource(input: AnalyticsParsedSourceIngest): AnalyticsVersionPromotionReceipt;
  verifyVersion(versionId: string, use?: AnalyticsDataRoomUse): AnalyticsVersionIntegrityReceipt;
  getVerifiedMaterializedPath(versionId: string, use: AnalyticsDataRoomUse): string;
  getHead(datasetId: string): AnalyticsDatasetHeadRecord | null;
  getRun(runId: string): AnalyticsDatasetRunRecord | null;
  recoverStaleRuns(): number;
  versionDeletionEligibility(versionId: string, explicitApproval?: boolean): AnalyticsVersionDeletionEligibility;
}

interface DatasetRow {
  id: string;
  name: string;
  description: string;
  kind: AnalyticsDatasetDefinitionRecord['kind'];
  scope: AnalyticsDatasetDefinitionRecord['scope'];
  domain_key: string;
  owner_id: string;
  lifecycle: AnalyticsDatasetDefinitionRecord['lifecycle'];
  catalog_visibility: AnalyticsDatasetCatalogVisibility;
  source_kind: AnalyticsDatasetDefinitionRecord['sourceKind'];
  source_format: AnalyticsDatasetDefinitionRecord['sourceFormat'];
  definition_json: string;
  definition_revision: number;
  definition_sha256: string;
  contract_json: string;
  contract_sha256: string;
  schema_sha256: string;
  retention_json: string;
  minimum_versions: number;
  automatic_expiry: number;
  reacquirable: number;
  backup_required: number;
  created_at: string;
  updated_at: string;
}

interface VersionRow {
  id: string;
  dataset_id: string;
  ordinal: number;
  version_key_sha256: string;
  source_format: AnalyticsDataRoomSourceFormat;
  source_rel_path: string;
  source_sha256: string;
  source_bytes: number;
  materialized_rel_path: string;
  materialized_sha256: string;
  materialized_bytes: number;
  manifest_rel_path: string;
  manifest_sha256: string;
  row_count: number;
  observed_schema_json: string;
  observed_schema_sha256: string;
  contract_json: string;
  contract_sha256: string;
  coverage_json: string;
  watermark: string;
  source_receipt_json: string;
  definition_sha256: string;
  handling_json: string;
  integrity_status: 'verified' | 'quarantined';
  integrity_verified_at: string | null;
  quarantine_reason: string | null;
  reacquirable: number;
  materialized_at: string;
  created_at: string;
}

interface HeadRow {
  dataset_id: string;
  version_id: string;
  definition_revision: number;
  head_revision: number;
  promoted_at: string;
  promotion_receipt_json: string;
}

interface AssertionRow {
  assertion_id: string;
  assertion_version: string;
  severity: 'warning' | 'error';
  success: number;
  observed_json: string | null;
  expected_json: string | null;
}

interface RunRow {
  id: string;
  dataset_id: string;
  trigger: AnalyticsDatasetRunRecord['trigger'];
  request_sha256: string;
  definition_revision: number;
  definition_sha256: string;
  status: AnalyticsDatasetRunRecord['status'];
  source_kind: AnalyticsDatasetDefinitionRecord['sourceKind'];
  remote_identity_json: string | null;
  output_version_id: string | null;
  receipt_json: string | null;
  error: string | null;
  queued_at: string;
  started_at: string | null;
  completed_at: string | null;
  staging_rel_path?: string | null;
}

function fail(code: AnalyticsDataRoomErrorCode, message: string): never {
  throw new AnalyticsDataRoomError(code, message);
}

function deterministicIntegrityFailure(error: unknown): boolean {
  if (error instanceof AnalyticsDataRoomError) return error.code === 'integrity_failed';
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === 'ENOENT'
    || code === 'ENOTDIR'
    || code === 'ELOOP'
    || code === 'SQLITE_CORRUPT'
    || code === 'SQLITE_NOTADB'
    || code === 'SQLITE_ERROR';
}

function deterministicIntegrityReason(error: unknown): string {
  if (error instanceof AnalyticsDataRoomError) return error.message;
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'ELOOP') {
    return 'A required immutable version artifact is missing or not a regular path.';
  }
  return 'The materialized version is not a valid readable data-room SQLite artifact.';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function cleanText(value: unknown, field: string, maximum = 4000): string {
  if (typeof value !== 'string' || !value.trim()) fail('invalid_input', `${field} is required.`);
  const text = value.trim();
  if (text.length > maximum || text.includes('\0')) fail('invalid_input', `${field} is invalid.`);
  return text;
}

export function isAnalyticsIsoTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-](\d{2}):(\d{2}))$/.exec(value);
  if (!match || !validDay(match[1])) return false;
  if (Number(match[2]) > 23 || Number(match[3]) > 59 || Number(match[4]) > 59) return false;
  if (match[5] !== 'Z' && (Number(match[6]) > 23 || Number(match[7]) > 59)) return false;
  return Number.isFinite(Date.parse(value));
}

function validDay(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function timestampDayInZone(value: string, timeZone: string): string {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(new Date(value));
    const year = parts.find(part => part.type === 'year')?.value;
    const month = parts.find(part => part.type === 'month')?.value;
    const day = parts.find(part => part.type === 'day')?.value;
    if (!year || !month || !day) fail('invalid_input', 'Could not resolve the business-day partition.');
    return `${year}-${month}-${day}`;
  } catch {
    return fail('invalid_input', `Timezone ${timeZone} is invalid.`);
  }
}

function strictJson<T>(raw: string, field: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fail('integrity_failed', `${field} contains malformed canonical JSON.`);
  }
}

function sha256Bytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function hashFile(filePath: string): { sha256: string; bytes: number } {
  const descriptor = fs.openSync(filePath, 'r');
  const digest = createHash('sha256');
  const chunk = Buffer.allocUnsafe(1024 * 1024);
  let total = 0;
  try {
    while (true) {
      const read = fs.readSync(descriptor, chunk, 0, chunk.length, null);
      if (read === 0) break;
      digest.update(chunk.subarray(0, read));
      total += read;
    }
  } finally {
    fs.closeSync(descriptor);
  }
  return { sha256: digest.digest('hex'), bytes: total };
}

function assertPrivateDirectory(directory: string): void {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    fail('integrity_failed', 'Data-room storage contains a non-directory or symbolic link.');
  }
  if ((stat.mode & 0o077) !== 0) {
    fail('integrity_failed', 'Data-room directory permissions are not owner-only.');
  }
}

function verifyPrivateFile(filePath: string, expectedSha256: string, expectedBytes: number): void {
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) fail('integrity_failed', 'Version contains a non-file or symbolic link.');
  if ((stat.mode & 0o077) !== 0) fail('integrity_failed', 'Version file permissions are not owner-only.');
  const actual = hashFile(filePath);
  if (actual.bytes !== expectedBytes || actual.sha256 !== expectedSha256) {
    fail('integrity_failed', 'Version file bytes do not match the immutable receipt.');
  }
}

function ensurePrivateDirectory(directory: string): void {
  fs.mkdirSync(directory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    fail('integrity_failed', 'Data-room storage contains a non-directory or symbolic link.');
  }
  fs.chmodSync(directory, PRIVATE_DIRECTORY_MODE);
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

function removeDirectoryBestEffort(directory: string): void {
  try {
    fs.rmSync(directory, { recursive: true, force: true });
  } catch {
    // A stale run remains auditable in SQLite and is retried by recovery.
  }
}

function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function sqliteType(field: AnalyticsFieldContract): 'TEXT' | 'INTEGER' | 'REAL' {
  if (field.logicalType === 'integer' || field.logicalType === 'boolean') return 'INTEGER';
  if (field.logicalType === 'number') return 'REAL';
  return 'TEXT';
}

function sqliteCell(value: AnalyticsDataCell): AnalyticsDataCell {
  return typeof value === 'boolean' ? (value ? 1 : 0) : value;
}

function validateTypedCell(value: AnalyticsDataCell, field: AnalyticsFieldContract, rowIndex: number): void {
  if (value === null) {
    if (!field.nullable) fail('invalid_input', `Row ${rowIndex} field ${field.name} may not be null.`);
    return;
  }
  if (field.logicalType === 'string' && typeof value !== 'string') {
    fail('invalid_input', `Row ${rowIndex} field ${field.name} must be a string.`);
  }
  if (field.logicalType === 'integer' && (typeof value !== 'number' || !Number.isSafeInteger(value))) {
    fail('invalid_input', `Row ${rowIndex} field ${field.name} must be a safe integer.`);
  }
  if (field.logicalType === 'number' && (typeof value !== 'number' || !Number.isFinite(value))) {
    fail('invalid_input', `Row ${rowIndex} field ${field.name} must be a finite number.`);
  }
  if (field.logicalType === 'boolean' && typeof value !== 'boolean') {
    fail('invalid_input', `Row ${rowIndex} field ${field.name} must be a boolean.`);
  }
  if (field.logicalType === 'date' && (typeof value !== 'string' || !validDay(value))) {
    fail('invalid_input', `Row ${rowIndex} field ${field.name} must be an ISO calendar date.`);
  }
  if (field.logicalType === 'timestamp' && !isAnalyticsIsoTimestamp(value)) {
    fail('invalid_input', `Row ${rowIndex} field ${field.name} must be an ISO timestamp.`);
  }
}

function validateQuality(values: AnalyticsQualityAssertionEvaluation[]): void {
  if (!Array.isArray(values)) fail('invalid_input', 'quality must be an array.');
  const identities = new Set<string>();
  for (const [index, value] of values.entries()) {
    if (!value || typeof value !== 'object'
      || !value.assertionId || !value.assertionVersion
      || !['warning', 'error'].includes(value.severity)
      || typeof value.success !== 'boolean') {
      fail('invalid_input', `quality[${index}] is malformed.`);
    }
    const identity = `${value.assertionId}\0${value.assertionVersion}`;
    if (identities.has(identity)) fail('invalid_input', `quality[${index}] duplicates an assertion identity.`);
    identities.add(identity);
  }
  if (values.some(value => value.severity === 'error' && !value.success)) {
    fail('integrity_failed', 'A blocking quality assertion failed; no version was published.');
  }
}

export function analyticsDatasetSchemaSha256(schema: AnalyticsFieldContract[]): string {
  return analyticsSha256(schema);
}

export function analyticsDatasetContractSha256(contract: AnalyticsDatasetContract): string {
  const { contractSha256: _storedDigest, ...payload } = contract;
  return analyticsSha256(payload);
}

function validateContract(contract: AnalyticsDatasetContract, datasetId: string): AnalyticsDatasetContract {
  if (!contract || typeof contract !== 'object') fail('invalid_input', 'contract is required.');
  if (contract.datasetId !== datasetId) fail('invalid_input', 'Contract dataset identity does not match the dataset.');
  if (!['active', 'deprecated', 'retired'].includes(contract.status)) fail('invalid_input', 'Contract status is invalid.');
  if (!['source', 'derived'].includes(contract.datasetKind)) fail('invalid_input', 'Contract dataset kind is invalid.');
  if (!['dashboard_local', 'project', 'workspace'].includes(contract.scope)) fail('invalid_input', 'Contract scope is invalid.');
  cleanText(contract.contractVersion, 'contract.contractVersion', 80);
  cleanText(contract.domainKey, 'contract.domainKey', 160);
  cleanText(contract.countingKey, 'contract.countingKey', 160);
  cleanText(contract.unit, 'contract.unit', 160);
  cleanText(contract.grain, 'contract.grain', 160);
  cleanText(contract.timeField, 'contract.timeField', 160);
  cleanText(contract.timeZone, 'contract.timeZone', 160);
  if (!Array.isArray(contract.schema) || contract.schema.length === 0) fail('invalid_input', 'Contract schema is empty.');
  const fieldNames = new Set<string>();
  for (const [index, field] of contract.schema.entries()) {
    if (!field || typeof field !== 'object') fail('invalid_input', `contract.schema[${index}] is malformed.`);
    cleanText(field.name, `contract.schema[${index}].name`, 160);
    if (fieldNames.has(field.name)) fail('invalid_input', `Contract schema repeats field ${field.name}.`);
    fieldNames.add(field.name);
    if (!['string', 'integer', 'number', 'boolean', 'date', 'timestamp'].includes(field.logicalType)) {
      fail('invalid_input', `contract.schema[${index}].logicalType is invalid.`);
    }
    if (field.physicalType !== undefined) cleanText(field.physicalType, `contract.schema[${index}].physicalType`, 160);
    if (typeof field.nullable !== 'boolean') fail('invalid_input', `contract.schema[${index}].nullable is invalid.`);
  }
  if (!fieldNames.has(contract.countingKey) || !fieldNames.has(contract.timeField)) {
    fail('invalid_input', 'Contract schema must contain its counting key and time field.');
  }
  const timeFieldContract = contract.schema.find(field => field.name === contract.timeField)!;
  if ((timeFieldContract.logicalType !== 'date' && timeFieldContract.logicalType !== 'timestamp')
    || timeFieldContract.nullable) {
    fail('invalid_input', 'Contract time field must be a non-nullable date or timestamp.');
  }
  if (!Array.isArray(contract.availableDimensions)
    || new Set(contract.availableDimensions).size !== contract.availableDimensions.length
    || contract.availableDimensions.some(value => typeof value !== 'string' || !fieldNames.has(value))) {
    fail('invalid_input', 'Contract available dimensions must name schema fields.');
  }
  if (!contract.metric || !contract.regime
    || !contract.metric.id || !contract.metric.version || !contract.metric.unit
    || !contract.regime.id || !contract.regime.version
    || !SHA256_RE.test(String(contract.metric.definitionSha256 || ''))
    || !SHA256_RE.test(String(contract.regime.definitionSha256 || ''))) {
    fail('invalid_input', 'Contract metric or regime identity is malformed.');
  }
  if (contract.metric.unit !== contract.unit) fail('invalid_input', 'Contract metric and dataset units differ.');
  if (!contract.coverage || !['day', 'month'].includes(contract.coverage.partitionKind)
    || !Array.isArray(contract.coverage.completePartitions)
    || new Set(contract.coverage.completePartitions).size !== contract.coverage.completePartitions.length
    || contract.coverage.completePartitions.some(value => !validDay(value)
      || (contract.coverage.partitionKind === 'month' && !value.endsWith('-01')))
    || (contract.coverage.observedPartitions !== undefined
      && (!Array.isArray(contract.coverage.observedPartitions)
        || new Set(contract.coverage.observedPartitions).size !== contract.coverage.observedPartitions.length
        || contract.coverage.observedPartitions.some(value => !validDay(value)
          || (contract.coverage.partitionKind === 'month' && !value.endsWith('-01')))))
    || (contract.coverage.observedPartitions !== undefined
      && contract.coverage.completePartitions.some(value => !contract.coverage.observedPartitions!.includes(value)))
    || !isAnalyticsIsoTimestamp(contract.coverage.watermark)) {
    fail('invalid_input', 'Contract coverage is malformed.');
  }
  timestampDayInZone(contract.coverage.watermark, contract.timeZone);
  if (!contract.handling || !contract.handling.classification
    || !Array.isArray(contract.handling.allowedUses)
    || new Set(contract.handling.allowedUses).size !== contract.handling.allowedUses.length
    || contract.handling.allowedUses.some(value => !['local_answer', 'dashboard', 'publication'].includes(value))
    || typeof contract.handling.allowModelContext !== 'boolean'
    || typeof contract.handling.allowPublication !== 'boolean'
    || (contract.handling.modelContextPolicy !== undefined
      && (!Array.isArray(contract.handling.modelContextPolicy.allowedProviderLocalities)
        || contract.handling.modelContextPolicy.allowedProviderLocalities.length === 0
        || new Set(contract.handling.modelContextPolicy.allowedProviderLocalities).size !== contract.handling.modelContextPolicy.allowedProviderLocalities.length
        || contract.handling.modelContextPolicy.allowedProviderLocalities.some(value => !['device_local', 'amazon_managed_remote'].includes(value))
        || !String(contract.handling.modelContextPolicy.disclosurePolicyVersion ?? '').trim()
        || (contract.handling.modelContextPolicy.endpointSha256 !== undefined
          && !SHA256_RE.test(contract.handling.modelContextPolicy.endpointSha256))))) {
    fail('invalid_input', 'Contract handling policy is malformed.');
  }
  if (contract.datasetKind === 'derived' && !contract.relational) {
    fail('invalid_input', 'Derived datasets require contract.relational.');
  }
  if (contract.relational) {
    let normalizedRelational;
    try {
      normalizedRelational = validateAnalyticsRelationalContract(contract);
    } catch (error) {
      fail('invalid_input', error instanceof Error ? error.message : String(error));
    }
    if (stableAnalyticsJson(normalizedRelational) !== stableAnalyticsJson(contract.relational)) {
      fail('invalid_input', 'contract.relational must use canonical field ordering.');
    }
  }
  const schemaSha256 = analyticsDatasetSchemaSha256(contract.schema);
  if (!SHA256_RE.test(contract.schemaSha256) || contract.schemaSha256 !== schemaSha256) {
    fail('invalid_input', 'Contract schema SHA does not match its canonical schema.');
  }
  const contractSha256 = analyticsDatasetContractSha256(contract);
  if (!SHA256_RE.test(contract.contractSha256) || contract.contractSha256 !== contractSha256) {
    fail('invalid_input', 'Contract SHA does not match its canonical content.');
  }
  return { ...contract, schemaSha256, contractSha256 };
}

function validateRetention(retention: AnalyticsDatasetRetentionPolicy): AnalyticsDatasetRetentionPolicy {
  if (!retention || !Number.isInteger(retention.minimumVersions) || retention.minimumVersions < 1
    || typeof retention.automaticExpiry !== 'boolean'
    || typeof retention.reacquirable !== 'boolean'
    || typeof retention.backupRequired !== 'boolean') {
    fail('invalid_input', 'Dataset retention policy is malformed.');
  }
  if (retention.automaticExpiry && !retention.reacquirable && !retention.backupRequired) {
    fail('invalid_input', 'Irreplaceable automatic expiry requires verified backup enforcement.');
  }
  return { ...retention };
}

function observedSchema(contract: AnalyticsDatasetContract): AnalyticsFieldContract[] {
  return contract.schema.map(field => ({
    name: field.name,
    logicalType: field.logicalType,
    physicalType: sqliteType(field),
    nullable: field.nullable,
  }));
}

function assertHandling(handling: AnalyticsDatasetContract['handling'], use: AnalyticsDataRoomUse): void {
  const allowed = handling.allowedUses.includes(use)
    && (use !== 'local_answer' || handling.allowModelContext)
    && (use !== 'publication' || handling.allowPublication);
  if (!allowed) fail('policy_denied', `Version handling policy does not permit ${use}.`);
}

function buildMaterializedDatabase(
  databasePath: string,
  schema: AnalyticsFieldContract[],
  rows: AnalyticsDataCell[][],
): AnalyticsStoredFileReceipt {
  const db = new Database(databasePath);
  try {
    db.pragma('journal_mode = DELETE');
    db.pragma('synchronous = FULL');
    const columns = schema.map(field => {
      const nullable = field.nullable ? '' : ' NOT NULL';
      return `${quoteIdentifier(field.name)} ${sqliteType(field)}${nullable}`;
    });
    db.exec(`CREATE TABLE data (${columns.join(', ')})`);
    const names = schema.map(field => quoteIdentifier(field.name)).join(', ');
    const placeholders = schema.map(() => '?').join(', ');
    const insert = db.prepare(`INSERT INTO data (${names}) VALUES (${placeholders})`);
    db.transaction(() => {
      for (const row of rows) insert.run(...row.map(sqliteCell));
    })();
    const count = db.prepare('SELECT COUNT(*) AS count FROM data').get() as { count: number };
    if (Number(count.count) !== rows.length) fail('integrity_failed', 'Materialized row count differs from the source.');
    const integrity = db.pragma('integrity_check') as Array<{ integrity_check: string }>;
    if (integrity.length !== 1 || integrity[0].integrity_check !== 'ok') {
      fail('integrity_failed', 'Materialized SQLite integrity check failed.');
    }
  } finally {
    db.close();
  }
  fs.chmodSync(databasePath, PRIVATE_FILE_MODE);
  const descriptor = fs.openSync(databasePath, 'r');
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  const receipt = hashFile(databasePath);
  return { fileName: 'materialized.db', ...receipt };
}

function verifyMaterializedDatabase(databasePath: string, expectedRows: number): void {
  const sidecar = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    sidecar.pragma('query_only = ON');
    const integrity = sidecar.pragma('integrity_check') as Array<{ integrity_check: string }>;
    if (integrity.length !== 1 || integrity[0].integrity_check !== 'ok') {
      fail('integrity_failed', 'Materialized SQLite integrity check failed.');
    }
    const count = sidecar.prepare('SELECT COUNT(*) AS count FROM data').get() as { count: number };
    if (Number(count.count) !== expectedRows) fail('integrity_failed', 'Materialized row count differs from its receipt.');
  } finally {
    sidecar.close();
  }
}

function rowToHead(row: HeadRow): AnalyticsDatasetHeadRecord {
  return {
    datasetId: row.dataset_id,
    versionId: row.version_id,
    definitionRevision: Number(row.definition_revision),
    headRevision: Number(row.head_revision),
    promotedAt: row.promoted_at,
    promotionReceipt: strictJson(row.promotion_receipt_json, 'promotion receipt'),
  };
}

function rowToRun(row: RunRow): AnalyticsDatasetRunRecord {
  return {
    id: row.id,
    datasetId: row.dataset_id,
    trigger: row.trigger,
    requestSha256: row.request_sha256,
    definitionRevision: Number(row.definition_revision),
    definitionSha256: row.definition_sha256,
    status: row.status,
    sourceKind: row.source_kind,
    ...(row.remote_identity_json ? { remoteIdentity: strictJson(row.remote_identity_json, 'run remote identity') } : {}),
    ...(row.output_version_id ? { outputVersionId: row.output_version_id } : {}),
    ...(row.receipt_json ? { receipt: strictJson(row.receipt_json, 'run receipt') } : {}),
    ...(row.error ? { error: row.error } : {}),
    queuedAt: row.queued_at,
    ...(row.started_at ? { startedAt: row.started_at } : {}),
    ...(row.completed_at ? { completedAt: row.completed_at } : {}),
  };
}

export function createAnalyticsDataRoomStore(input: {
  db: Database.Database;
  rootDir?: string;
  now?: () => Date;
  createId?: () => string;
}): AnalyticsDataRoomStore {
  const db = input.db;
  const rootDir = path.resolve(input.rootDir ?? DEFAULT_DATA_ROOM_ROOT);
  const now = input.now ?? (() => new Date());
  const createId = input.createId ?? (() => randomUUID().replace(/-/g, ''));
  ensurePrivateDirectory(rootDir);

  function timestamp(): string {
    return now().toISOString();
  }

  function assertDatasetId(datasetId: string): string {
    if (!DATASET_ID_RE.test(datasetId)) fail('invalid_input', 'Dataset ID is malformed.');
    return datasetId;
  }

  function assertVersionId(versionId: string): string {
    if (!VERSION_ID_RE.test(versionId)) fail('invalid_input', 'Version ID is malformed.');
    return versionId;
  }

  function resolveRelative(relativePath: string): string {
    if (!relativePath || path.isAbsolute(relativePath)) fail('integrity_failed', 'Stored data-room path is not relative.');
    const resolved = path.resolve(rootDir, relativePath);
    const relative = path.relative(rootDir, resolved);
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      fail('integrity_failed', 'Stored data-room path escapes the private root.');
    }
    return resolved;
  }

  function relative(absolutePath: string): string {
    const value = path.relative(rootDir, absolutePath);
    if (!value || value.startsWith(`..${path.sep}`) || path.isAbsolute(value)) {
      fail('integrity_failed', 'Data-room path escapes the private root.');
    }
    return value;
  }

  function datasetDirectory(datasetId: string): string {
    return path.join(rootDir, assertDatasetId(datasetId));
  }

  function ensureDatasetDirectories(datasetId: string): { root: string; versions: string; staging: string } {
    const root = datasetDirectory(datasetId);
    const versions = path.join(root, 'versions');
    const staging = path.join(root, 'staging');
    ensurePrivateDirectory(root);
    ensurePrivateDirectory(versions);
    ensurePrivateDirectory(staging);
    return { root, versions, staging };
  }

  function datasetRecord(row: DatasetRow): AnalyticsDatasetDefinitionRecord {
    const definition = strictJson<Record<string, unknown>>(row.definition_json, `dataset ${row.id} definition`);
    const contract = strictJson<AnalyticsDatasetContract>(row.contract_json, `dataset ${row.id} contract`);
    const retention = strictJson<AnalyticsDatasetRetentionPolicy>(row.retention_json, `dataset ${row.id} retention`);
    if (analyticsSha256(definition) !== row.definition_sha256
      || analyticsDatasetContractSha256(contract) !== row.contract_sha256
      || analyticsDatasetSchemaSha256(contract.schema) !== row.schema_sha256
      || stableAnalyticsJson(validateRetention(retention)) !== stableAnalyticsJson(retention)) {
      fail('integrity_failed', `Dataset ${row.id} canonical metadata failed verification.`);
    }
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      kind: row.kind,
      scope: row.scope,
      domainKey: row.domain_key,
      ownerId: row.owner_id,
      lifecycle: row.lifecycle,
      catalogVisibility: row.catalog_visibility,
      sourceKind: row.source_kind,
      sourceFormat: row.source_format,
      definition,
      definitionRevision: Number(row.definition_revision),
      definitionSha256: row.definition_sha256,
      contract,
      contractSha256: row.contract_sha256,
      schemaSha256: row.schema_sha256,
      retention,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  function versionDetailFromRow(row: VersionRow): AnalyticsDatasetVersionDetail {
    const observed = strictJson<AnalyticsFieldContract[]>(row.observed_schema_json, `version ${row.id} observed schema`);
    const contract = strictJson<AnalyticsDatasetContract>(row.contract_json, `version ${row.id} contract`);
    const coverage = strictJson<AnalyticsDatasetContract['coverage']>(row.coverage_json, `version ${row.id} coverage`);
    const sourceReceipt = strictJson<AnalyticsDatasetVersionManifest['sourceReceipt']>(row.source_receipt_json, `version ${row.id} source receipt`);
    const handling = strictJson<AnalyticsDatasetContract['handling']>(row.handling_json, `version ${row.id} handling`);
    if (analyticsDatasetSchemaSha256(observed) !== row.observed_schema_sha256
      || analyticsDatasetContractSha256(contract) !== row.contract_sha256
      || stableAnalyticsJson(contract.coverage) !== stableAnalyticsJson(coverage)
      || stableAnalyticsJson(contract.handling) !== stableAnalyticsJson(handling)) {
      fail('integrity_failed', `Version ${row.id} canonical metadata failed verification.`);
    }
    const qualityRows = db.prepare(`
      SELECT assertion_id, assertion_version, severity, success, observed_json, expected_json
      FROM analytics_dataset_assertion_evaluations
      WHERE version_id = ? AND assertion_id <> 'runtime_integrity'
      ORDER BY assertion_id, assertion_version
    `).all(row.id) as AssertionRow[];
    const quality = qualityRows.map(value => ({
      assertionId: value.assertion_id,
      assertionVersion: value.assertion_version,
      severity: value.severity,
      success: value.success === 1,
      ...(value.observed_json !== null ? { observed: strictJson(value.observed_json, 'quality observed value') } : {}),
      ...(value.expected_json !== null ? { expected: strictJson(value.expected_json, 'quality expected value') } : {}),
    })) as AnalyticsQualityAssertionEvaluation[];
    const derivedRun = db.prepare(`
      SELECT id, transform_sha256, input_set_sha256, materialization_key_sha256
      FROM analytics_derived_runs WHERE output_version_id = ?
      ORDER BY completed_at DESC, id LIMIT 1
    `).get(row.id) as {
      id: string;
      transform_sha256: string;
      input_set_sha256: string;
      materialization_key_sha256: string;
    } | undefined;
    let derivation: AnalyticsDerivationLineageReceipt | undefined;
    if (derivedRun) {
      const inputs = (db.prepare(`
        SELECT alias, input_dataset_id, input_version_id, content_sha256,
          schema_sha256, contract_sha256, definition_sha256
        FROM analytics_dataset_version_inputs
        WHERE output_version_id = ? ORDER BY position, alias
      `).all(row.id) as Array<{
        alias: string;
        input_dataset_id: string;
        input_version_id: string;
        content_sha256: string;
        schema_sha256: string;
        contract_sha256: string;
        definition_sha256: string;
      }>).map(input => ({
        alias: input.alias,
        datasetId: input.input_dataset_id,
        versionId: input.input_version_id,
        contentSha256: input.content_sha256,
        schemaSha256: input.schema_sha256,
        contractSha256: input.contract_sha256,
        definitionSha256: input.definition_sha256,
      }));
      const checks = (db.prepare(`
        SELECT assertion_id, assertion_version, severity, success, observed_json, expected_json
        FROM analytics_derived_run_assertions WHERE run_id = ?
        ORDER BY assertion_id, assertion_version
      `).all(derivedRun.id) as AssertionRow[]).map(value => ({
        assertionId: value.assertion_id,
        assertionVersion: value.assertion_version,
        severity: value.severity,
        success: value.success === 1,
        ...(value.observed_json !== null ? { observed: strictJson(value.observed_json, 'derived check observed value') } : {}),
        ...(value.expected_json !== null ? { expected: strictJson(value.expected_json, 'derived check expected value') } : {}),
      })) as AnalyticsQualityAssertionEvaluation[];
      derivation = {
        runId: derivedRun.id,
        compilerVersion: 'botboy-relational-v1',
        transformSha256: derivedRun.transform_sha256,
        inputSetSha256: derivedRun.input_set_sha256,
        materializationKeySha256: derivedRun.materialization_key_sha256,
        inputs,
        checks,
      };
    }
    const sourceFileName = path.basename(row.source_rel_path);
    if (sourceFileName !== 'source.tsv' && sourceFileName !== 'source.json') {
      fail('integrity_failed', `Version ${row.id} source path is malformed.`);
    }
    return {
      id: row.id,
      datasetId: row.dataset_id,
      ordinal: Number(row.ordinal),
      versionKeySha256: row.version_key_sha256,
      sourceFormat: row.source_format,
      sourceSha256: row.source_sha256,
      sourceBytes: Number(row.source_bytes),
      materializedSha256: row.materialized_sha256,
      materializedBytes: Number(row.materialized_bytes),
      manifestSha256: row.manifest_sha256,
      rowCount: Number(row.row_count),
      observedSchemaSha256: row.observed_schema_sha256,
      contractSha256: row.contract_sha256,
      coverage,
      definitionSha256: row.definition_sha256,
      materializedAt: row.materialized_at,
      integrity: {
        status: row.integrity_status,
        ...(row.integrity_verified_at ? { verifiedAt: row.integrity_verified_at } : {}),
        ...(row.quarantine_reason ? { reason: row.quarantine_reason } : {}),
      },
      reacquirable: row.reacquirable === 1,
      createdAt: row.created_at,
      files: {
        source: { fileName: sourceFileName, sha256: row.source_sha256, bytes: Number(row.source_bytes) },
        materialized: { fileName: 'materialized.db', sha256: row.materialized_sha256, bytes: Number(row.materialized_bytes) },
      },
      observedSchema: observed,
      contract,
      sourceReceipt,
      handling,
      quality,
      ...(derivation ? { derivation } : {}),
    };
  }

  function versionSummary(detail: AnalyticsDatasetVersionDetail): AnalyticsDatasetVersionSummary {
    const {
      files: _files,
      observedSchema: _schema,
      contract: _contract,
      sourceReceipt: _source,
      handling: _handling,
      quality: _quality,
      derivation: _derivation,
      ...summary
    } = detail;
    return summary;
  }

  function getVersionRow(versionId: string): VersionRow | null {
    assertVersionId(versionId);
    return (db.prepare('SELECT * FROM analytics_dataset_versions WHERE id = ?').get(versionId) as VersionRow | undefined) ?? null;
  }

  function getDatasetRow(datasetId: string): DatasetRow | null {
    assertDatasetId(datasetId);
    return (db.prepare('SELECT * FROM analytics_datasets WHERE id = ?').get(datasetId) as DatasetRow | undefined) ?? null;
  }

  function getHead(datasetId: string): AnalyticsDatasetHeadRecord | null {
    assertDatasetId(datasetId);
    const row = db.prepare('SELECT * FROM analytics_dataset_heads WHERE dataset_id = ?').get(datasetId) as HeadRow | undefined;
    return row ? rowToHead(row) : null;
  }

  function getDatasetVersion(versionId: string): AnalyticsDatasetVersionDetail | null {
    const row = getVersionRow(versionId);
    return row ? versionDetailFromRow(row) : null;
  }

  function summaryFromDataset(record: AnalyticsDatasetDefinitionRecord): AnalyticsDatasetSummary {
    const storedHead = getHead(record.id);
    const current = storedHead ? getDatasetVersion(storedHead.versionId) : null;
    const verifiedHead = current?.integrity.status === 'verified' ? storedHead : null;
    return {
      id: record.id,
      name: record.name,
      description: record.description,
      kind: record.kind,
      scope: record.scope,
      domainKey: record.domainKey,
      lifecycle: record.lifecycle,
      catalogVisibility: record.catalogVisibility,
      sourceKind: record.sourceKind,
      sourceFormat: record.sourceFormat,
      definitionRevision: record.definitionRevision,
      definitionSha256: record.definitionSha256,
      contractSha256: record.contractSha256,
      schemaSha256: record.schemaSha256,
      retention: record.retention,
      head: verifiedHead,
      currentVersion: verifiedHead && current ? versionSummary(current) : null,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
  }

  function getDataset(datasetId: string): AnalyticsDatasetDetail | null {
    const row = getDatasetRow(datasetId);
    if (!row) return null;
    const record = datasetRecord(row);
    return { ...summaryFromDataset(record), ownerId: record.ownerId, definition: record.definition, contract: record.contract };
  }

  function listDatasets(limit = 100): AnalyticsDatasetSummary[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) fail('invalid_input', 'Dataset list limit must be from 1 to 100.');
    const rows = db.prepare(`
      SELECT * FROM analytics_datasets
      WHERE catalog_visibility = 'catalog'
      ORDER BY updated_at DESC, id ASC
      LIMIT ?
    `).all(limit) as DatasetRow[];
    return rows.map(row => summaryFromDataset(datasetRecord(row)));
  }

  function listAllDatasets(): AnalyticsDatasetSummary[] {
    const rows = db.prepare(`
      SELECT * FROM analytics_datasets
      WHERE catalog_visibility = 'catalog'
      ORDER BY updated_at DESC, id ASC
    `).all() as DatasetRow[];
    return rows.map(row => summaryFromDataset(datasetRecord(row)));
  }

  function searchDatasets(query: string, limit = 25): AnalyticsDataRoomDatasetSearchHit[] {
    const normalized = typeof query === 'string' ? query.trim() : '';
    if (!normalized) return [];
    if (normalized.length > 240) fail('invalid_input', 'Dataset search query is too long.');
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      fail('invalid_input', 'Dataset search limit must be from 1 to 100.');
    }
    type SearchRow = Pick<DatasetRow,
      'id' | 'name' | 'description' | 'kind' | 'scope' | 'domain_key' | 'lifecycle' | 'updated_at'> & {
        current_version_id: string | null;
        current_version_ordinal: number | null;
        current_version_materialized_at: string | null;
        current_version_integrity_status: 'verified' | null;
      };
    const select = `
      SELECT dataset.id, dataset.name, dataset.description, dataset.kind, dataset.scope,
        dataset.domain_key, dataset.lifecycle, dataset.updated_at,
        version.id AS current_version_id,
        version.ordinal AS current_version_ordinal,
        version.materialized_at AS current_version_materialized_at,
        version.integrity_status AS current_version_integrity_status
      FROM analytics_datasets dataset
      LEFT JOIN analytics_dataset_heads head ON head.dataset_id = dataset.id
      LEFT JOIN analytics_dataset_versions version
        ON version.id = head.version_id AND version.integrity_status = 'verified'
    `;
    const mapHit = (row: SearchRow): AnalyticsDataRoomDatasetSearchHit => {
      const lower = normalized.toLowerCase();
      const matchField = row.id === normalized || row.id.toLowerCase().includes(lower)
        ? 'id'
        : row.name.toLowerCase().includes(lower)
          ? 'name'
          : row.description.toLowerCase().includes(lower)
            ? 'description'
            : 'domainKey';
      return {
        datasetId: row.id,
        name: row.name,
        description: row.description,
        kind: row.kind,
        scope: row.scope,
        domainKey: row.domain_key,
        lifecycle: row.lifecycle,
        updatedAt: row.updated_at,
        matchField,
        ...(row.current_version_id ? {
          currentVersion: {
            id: row.current_version_id,
            ordinal: Number(row.current_version_ordinal),
            materializedAt: row.current_version_materialized_at!,
            integrityStatus: 'verified',
          },
        } : {}),
      };
    };
    return db.transaction(() => {
      const exact = db.prepare(`${select} WHERE dataset.catalog_visibility = 'catalog' AND dataset.id = ?`).get(normalized) as SearchRow | undefined;
      const remaining = limit - (exact ? 1 : 0);
      const fuzzy = remaining > 0 ? db.prepare(`${select}
        WHERE dataset.catalog_visibility = 'catalog' AND dataset.id <> ? AND (
          instr(lower(dataset.id), lower(?)) > 0
          OR instr(lower(dataset.name), lower(?)) > 0
          OR instr(lower(dataset.description), lower(?)) > 0
          OR instr(lower(dataset.domain_key), lower(?)) > 0
        )
        ORDER BY CASE
          WHEN instr(lower(dataset.id), lower(?)) > 0 THEN 0
          WHEN instr(lower(dataset.name), lower(?)) > 0 THEN 1
          WHEN instr(lower(dataset.description), lower(?)) > 0 THEN 2
          ELSE 3
        END, dataset.updated_at DESC, dataset.id ASC
        LIMIT ?
      `).all(
        normalized,
        normalized, normalized, normalized, normalized,
        normalized, normalized, normalized,
        remaining,
      ) as SearchRow[] : [];
      return [...(exact ? [mapHit(exact)] : []), ...fuzzy.map(mapHit)];
    })();
  }

  function findDatasetsForRequest(requestInput: AnalyticsRequest): AnalyticsDatasetDetail[] {
    const request = normalizeAnalyticsRequest(requestInput);
    const rows = request.datasetId
      ? db.prepare(`
          SELECT * FROM analytics_datasets
          WHERE id = ? AND lifecycle = 'active' AND catalog_visibility = 'catalog'
        `).all(request.datasetId) as DatasetRow[]
      : db.prepare(`
          SELECT * FROM analytics_datasets
          WHERE domain_key = ? AND lifecycle = 'active' AND catalog_visibility = 'catalog'
          ORDER BY id
        `).all(request.domainKey) as DatasetRow[];
    return rows.map(row => {
      const record = datasetRecord(row);
      return {
        ...summaryFromDataset(record),
        ownerId: record.ownerId,
        definition: record.definition,
        contract: record.contract,
      };
    });
  }

  function listDatasetVersions(datasetId: string): AnalyticsDatasetVersionSummary[] | null {
    if (!getDatasetRow(datasetId)) return null;
    const rows = db.prepare(`
      SELECT * FROM analytics_dataset_versions
      WHERE dataset_id = ?
      ORDER BY ordinal DESC, id ASC
    `).all(datasetId) as VersionRow[];
    return rows.map(row => versionSummary(versionDetailFromRow(row)));
  }

  function listDependencies(datasetId: string, definitionRevision?: number): AnalyticsDatasetDependencyRecord[] {
    const row = getDatasetRow(datasetId);
    if (!row) return [];
    const revision = definitionRevision ?? Number(row.definition_revision);
    if (!Number.isInteger(revision) || revision < 1) fail('invalid_input', 'definitionRevision must be positive.');
    return (db.prepare(`
      SELECT * FROM analytics_dataset_dependencies
      WHERE derived_dataset_id = ? AND definition_revision = ?
      ORDER BY position, alias
    `).all(datasetId, revision) as Array<{
      derived_dataset_id: string;
      definition_revision: number;
      alias: string;
      position: number;
      input_dataset_id: string;
      version_policy: AnalyticsDatasetDependencyRecord['versionPolicy'];
      pinned_version_id: string | null;
      required_columns_json: string;
      expected_schema_sha256: string | null;
      expected_contract_sha256: string | null;
      created_at: string;
    }>).map(value => ({
      derivedDatasetId: value.derived_dataset_id,
      definitionRevision: Number(value.definition_revision),
      alias: value.alias,
      position: Number(value.position),
      datasetId: value.input_dataset_id,
      versionPolicy: value.version_policy,
      ...(value.pinned_version_id ? { pinnedVersionId: value.pinned_version_id } : {}),
      requiredColumns: strictJson<string[]>(value.required_columns_json, 'dependency required columns'),
      ...(value.expected_schema_sha256 ? { expectedSchemaSha256: value.expected_schema_sha256 } : {}),
      ...(value.expected_contract_sha256 ? { expectedContractSha256: value.expected_contract_sha256 } : {}),
      createdAt: value.created_at,
    }));
  }

  function catalogLimit(value = 25): number {
    if (!Number.isInteger(value) || value < 1 || value > CATALOG_LIST_LIMIT) {
      fail('invalid_input', `Catalog limit must be from 1 to ${CATALOG_LIST_LIMIT}.`);
    }
    return value;
  }

  function catalogHead(row: HeadRow | undefined): AnalyticsDataRoomCatalogHead | null {
    return row ? {
      datasetId: row.dataset_id,
      versionId: row.version_id,
      definitionRevision: Number(row.definition_revision),
      headRevision: Number(row.head_revision),
      promotedAt: row.promoted_at,
    } : null;
  }

  function catalogVersionSummary(row: VersionRow): AnalyticsDataRoomCatalogVersionSummary {
    return {
      id: row.id,
      datasetId: row.dataset_id,
      ordinal: Number(row.ordinal),
      versionKeySha256: row.version_key_sha256,
      sourceFormat: row.source_format,
      sourceSha256: row.source_sha256,
      sourceBytes: Number(row.source_bytes),
      materializedSha256: row.materialized_sha256,
      materializedBytes: Number(row.materialized_bytes),
      manifestSha256: row.manifest_sha256,
      rowCount: Number(row.row_count),
      observedSchemaSha256: row.observed_schema_sha256,
      contractSha256: row.contract_sha256,
      definitionSha256: row.definition_sha256,
      coverage: strictJson(row.coverage_json, `version ${row.id} coverage`),
      materializedAt: row.materialized_at,
      integrityStatus: row.integrity_status,
      reacquirable: row.reacquirable === 1,
      createdAt: row.created_at,
    };
  }

  function catalogDatasetSummary(row: DatasetRow): AnalyticsDataRoomCatalogDatasetSummary {
    const record = datasetRecord(row);
    const headRow = db.prepare(`
      SELECT * FROM analytics_dataset_heads WHERE dataset_id = ?
    `).get(record.id) as HeadRow | undefined;
    const currentRow = headRow
      ? db.prepare('SELECT * FROM analytics_dataset_versions WHERE id = ?').get(headRow.version_id) as VersionRow | undefined
      : undefined;
    const verifiedCurrent = currentRow?.integrity_status === 'verified' ? currentRow : undefined;
    const head = verifiedCurrent ? catalogHead(headRow) : null;
    const answer = record.definition.answer;
    const partitions = [...record.contract.coverage.completePartitions].sort();
    const schemaNames = new Set(record.contract.schema.map(field => field.name));
    const requiredColumns = answer ? [...new Set([
      record.contract.timeField,
      answer.metricValueColumn,
      ...(Array.isArray(answer.rowDimensions) ? answer.rowDimensions : []),
      ...(Array.isArray(answer.filterableFields) ? answer.filterableFields : []),
      ...(Array.isArray(answer.stableOrder) ? answer.stableOrder.map(item => item.field) : []),
    ])] : [];
    const validAnswer = answer?.version === 1
      && answer.metricId === record.contract.metric.id
      && typeof answer.metricValueColumn === 'string'
      && schemaNames.has(answer.metricValueColumn)
      && Array.isArray(answer.rowDimensions)
      && answer.rowDimensions.every(field => typeof field === 'string' && schemaNames.has(field))
      && Array.isArray(answer.filterableFields)
      && answer.filterableFields.every(field => typeof field === 'string' && schemaNames.has(field))
      && Array.isArray(answer.stableOrder)
      && answer.stableOrder.every(item => item && typeof item.field === 'string' && schemaNames.has(item.field))
      && requiredColumns.length <= 128;
    const bindingTemplate = head && validAnswer && partitions.length ? {
      datasetId: record.id,
      versionPolicy: 'latest_compatible' as const,
      expectedSchemaSha256: record.schemaSha256,
      expectedContractSha256: record.contractSha256,
      requiredColumns,
      presentationLimit: 200,
      request: normalizeAnalyticsRequest({
        domainKey: record.domainKey,
        metric: record.contract.metric,
        dimensions: [...answer.rowDimensions],
        filters: [],
        dateRange: { start: partitions[0], end: partitions[partitions.length - 1] },
        timeZone: record.contract.timeZone,
        countingKey: record.contract.countingKey,
        regime: record.contract.regime,
        requiredGrain: record.contract.grain,
        freshness: { mode: 'allow_stale' },
        use: 'dashboard',
        datasetId: record.id,
        requiredContractSha256: record.contractSha256,
        resultLimit: 200,
      }),
    } : null;
    return {
      id: record.id,
      name: record.name,
      description: record.description,
      kind: record.kind,
      scope: record.scope,
      domainKey: record.domainKey,
      lifecycle: record.lifecycle,
      catalogVisibility: record.catalogVisibility,
      sourceKind: record.sourceKind,
      sourceFormat: record.sourceFormat,
      definitionRevision: record.definitionRevision,
      definitionSha256: record.definitionSha256,
      contractSha256: record.contractSha256,
      schemaSha256: record.schemaSha256,
      schema: record.contract.schema,
      metric: record.contract.metric,
      regime: record.contract.regime,
      countingKey: record.contract.countingKey,
      unit: record.contract.unit,
      grain: record.contract.grain,
      availableDimensions: record.contract.availableDimensions,
      timeField: record.contract.timeField,
      timeZone: record.contract.timeZone,
      coverage: record.contract.coverage,
      handling: record.contract.handling,
      retention: record.retention,
      head,
      currentVersion: verifiedCurrent ? catalogVersionSummary(verifiedCurrent) : null,
      bindingTemplate,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
  }

  function boundedPage<T>(items: T[], count: number, limit: number): { items: T[]; count: number; limit: number; truncated: boolean } {
    return { items: items.slice(0, limit), count, limit, truncated: count > limit };
  }

  function listCatalogDatasets(limitInput = 25): AnalyticsDataRoomCatalogDatasetList {
    const limit = catalogLimit(limitInput);
    return db.transaction(() => {
      const count = Number((db.prepare(`
        SELECT COUNT(*) AS count FROM analytics_datasets WHERE catalog_visibility = 'catalog'
      `).get() as { count: number }).count);
      const rows = db.prepare(`
        SELECT * FROM analytics_datasets
        WHERE catalog_visibility = 'catalog'
        ORDER BY updated_at DESC, id ASC LIMIT ?
      `).all(limit + 1) as DatasetRow[];
      return {
        dataRoomVersion: readAnalyticsDataRoomVersion(db),
        datasets: rows.slice(0, limit).map(catalogDatasetSummary),
        count,
        limit,
        truncated: count > limit,
      };
    })();
  }

  function getCatalogDataset(datasetId: string): AnalyticsDataRoomCatalogDatasetEnvelope | null {
    assertDatasetId(datasetId);
    return db.transaction(() => {
      const row = getDatasetRow(datasetId);
      if (!row || row.catalog_visibility !== 'catalog') return null;
      const summary = catalogDatasetSummary(row);
      const projectCount = Number((db.prepare(`
        SELECT COUNT(*) AS count FROM analytics_dataset_project_links WHERE dataset_id = ?
      `).get(datasetId) as { count: number }).count);
      const projects = (db.prepare(`
        SELECT link.project_id, link.linked_at, project.title, project.status
        FROM analytics_dataset_project_links link
        LEFT JOIN projects project ON project.id = link.project_id
        WHERE link.dataset_id = ? ORDER BY COALESCE(project.title, link.project_id), link.project_id
        LIMIT ?
      `).all(datasetId, CATALOG_RELATION_LIMIT + 1) as Array<{
        project_id: string; linked_at: string; title: string | null; status: string | null;
      }>).map<AnalyticsDataRoomCatalogProject>(item => ({
        projectId: item.project_id,
        title: item.title ?? item.project_id,
        status: item.status ?? 'unknown',
        linkedAt: item.linked_at,
      }));
      const dependencyCount = Number((db.prepare(`
        SELECT COUNT(*) AS count FROM analytics_dataset_dependencies
        WHERE derived_dataset_id = ? AND definition_revision = ?
      `).get(datasetId, row.definition_revision) as { count: number }).count);
      const dependencies = (db.prepare(`
        SELECT dependency.*, source.name, source.kind
        FROM analytics_dataset_dependencies dependency
        JOIN analytics_datasets source ON source.id = dependency.input_dataset_id
        WHERE dependency.derived_dataset_id = ? AND dependency.definition_revision = ?
        ORDER BY dependency.position, dependency.alias LIMIT ?
      `).all(datasetId, row.definition_revision, CATALOG_RELATION_LIMIT + 1) as Array<any>)
        .map<AnalyticsDataRoomCatalogDependency>(item => ({
          datasetId: item.input_dataset_id,
          name: item.name,
          kind: item.kind,
          alias: item.alias,
          position: Number(item.position),
          versionPolicy: item.version_policy,
          ...(item.pinned_version_id ? { pinnedVersionId: item.pinned_version_id } : {}),
          requiredColumns: strictJson(item.required_columns_json, 'catalog dependency required columns'),
          ...(item.expected_schema_sha256 ? { expectedSchemaSha256: item.expected_schema_sha256 } : {}),
          ...(item.expected_contract_sha256 ? { expectedContractSha256: item.expected_contract_sha256 } : {}),
        }));
      const dependentCount = Number((db.prepare(`
        SELECT COUNT(*) AS count
        FROM analytics_dataset_dependencies dependency
        JOIN analytics_datasets target ON target.id = dependency.derived_dataset_id
          AND target.definition_revision = dependency.definition_revision
        WHERE dependency.input_dataset_id = ?
      `).get(datasetId) as { count: number }).count);
      const dependents = (db.prepare(`
        SELECT target.id, target.name, target.kind, target.definition_revision,
          dependency.alias, dependency.position
        FROM analytics_dataset_dependencies dependency
        JOIN analytics_datasets target ON target.id = dependency.derived_dataset_id
          AND target.definition_revision = dependency.definition_revision
        WHERE dependency.input_dataset_id = ?
        ORDER BY target.name, target.id, dependency.position LIMIT ?
      `).all(datasetId, CATALOG_RELATION_LIMIT + 1) as Array<any>)
        .map<AnalyticsDataRoomCatalogDependent>(item => ({
          datasetId: item.id,
          name: item.name,
          kind: item.kind,
          definitionRevision: Number(item.definition_revision),
          alias: item.alias,
          position: Number(item.position),
        }));
      const consumerCount = Number((db.prepare(`
        SELECT COUNT(*) AS count FROM analytics_widget_dataset_bindings WHERE dataset_id = ?
      `).get(datasetId) as { count: number }).count);
      const consumers = (db.prepare(`
        SELECT dashboard.id AS dashboard_id, dashboard.title AS dashboard_title,
          widget.id AS widget_id, widget.title AS widget_title,
          binding.revision, binding.version_policy, binding.pinned_version_id,
          binding.compatibility_state, binding.observed_head_revision,
          binding.last_applied_version_id
        FROM analytics_widget_dataset_bindings binding
        JOIN analytics_widgets widget ON widget.id = binding.widget_id
        JOIN analytics_dashboards dashboard ON dashboard.id = widget.dashboard_id
        WHERE binding.dataset_id = ?
        ORDER BY dashboard.title, dashboard.id, widget.position, widget.id LIMIT ?
      `).all(datasetId, CATALOG_CONSUMER_LIMIT + 1) as Array<any>)
        .map<AnalyticsDataRoomCatalogConsumer>(item => ({
          dashboardId: item.dashboard_id,
          dashboardTitle: item.dashboard_title,
          widgetId: item.widget_id,
          widgetTitle: item.widget_title,
          bindingRevision: Number(item.revision),
          versionPolicy: item.version_policy,
          ...(item.pinned_version_id ? { pinnedVersionId: item.pinned_version_id } : {}),
          compatibilityState: item.compatibility_state,
          observedHeadRevision: Number(item.observed_head_revision),
          ...(item.last_applied_version_id ? { lastAppliedVersionId: item.last_applied_version_id } : {}),
        }));
      const ownerCount = Number((db.prepare(`
        SELECT COUNT(*) AS count FROM analytics_dataset_dashboard_owners WHERE dataset_id = ?
      `).get(datasetId) as { count: number }).count);
      const owners = (db.prepare(`
        SELECT owner.dashboard_id, owner.claimed_at, dashboard.title
        FROM analytics_dataset_dashboard_owners owner
        JOIN analytics_dashboards dashboard ON dashboard.id = owner.dashboard_id
        WHERE owner.dataset_id = ? ORDER BY dashboard.title, dashboard.id LIMIT ?
      `).all(datasetId, CATALOG_RELATION_LIMIT + 1) as Array<any>)
        .map<AnalyticsDataRoomCatalogDashboardOwner>(item => ({
          dashboardId: item.dashboard_id,
          dashboardTitle: item.title,
          claimedAt: item.claimed_at,
        }));
      const activityCount = Number((db.prepare(`
        SELECT
          (SELECT COUNT(*) FROM analytics_dataset_runs WHERE dataset_id = ?) +
          (SELECT COUNT(*) FROM analytics_derived_runs WHERE dataset_id = ?) AS count
      `).get(datasetId, datasetId) as { count: number }).count);
      const activity = (db.prepare(`
        SELECT * FROM (
          SELECT 'source' AS kind, id, status, definition_revision, output_version_id,
            trigger, source_kind, queued_at, started_at, completed_at
          FROM analytics_dataset_runs WHERE dataset_id = ?
          UNION ALL
          SELECT 'derived' AS kind, id, status, definition_revision, output_version_id,
            NULL AS trigger, NULL AS source_kind, queued_at, started_at, completed_at
          FROM analytics_derived_runs WHERE dataset_id = ?
        ) ORDER BY queued_at DESC, id ASC LIMIT ?
      `).all(datasetId, datasetId, CATALOG_ACTIVITY_LIMIT + 1) as Array<any>)
        .map<AnalyticsDataRoomCatalogActivity>(item => ({
          kind: item.kind,
          id: item.id,
          status: item.status,
          definitionRevision: Number(item.definition_revision),
          ...(item.output_version_id ? { outputVersionId: item.output_version_id } : {}),
          ...(item.trigger ? { trigger: item.trigger } : {}),
          ...(item.source_kind ? { sourceKind: item.source_kind } : {}),
          queuedAt: item.queued_at,
          ...(item.started_at ? { startedAt: item.started_at } : {}),
          ...(item.completed_at ? { completedAt: item.completed_at } : {}),
        }));
      const dataset: AnalyticsDataRoomCatalogDatasetDetail = {
        ...summary,
        projects: boundedPage(projects, projectCount, CATALOG_RELATION_LIMIT),
        dependencies: boundedPage(dependencies, dependencyCount, CATALOG_RELATION_LIMIT),
        dependents: boundedPage(dependents, dependentCount, CATALOG_RELATION_LIMIT),
        consumers: boundedPage(consumers, consumerCount, CATALOG_CONSUMER_LIMIT),
        dashboardOwners: boundedPage(owners, ownerCount, CATALOG_RELATION_LIMIT),
        activity: boundedPage(activity, activityCount, CATALOG_ACTIVITY_LIMIT),
      };
      return { dataRoomVersion: readAnalyticsDataRoomVersion(db), dataset };
    })();
  }

  function listCatalogDatasetVersions(datasetId: string, limitInput = 25): AnalyticsDataRoomCatalogVersionList | null {
    assertDatasetId(datasetId);
    const limit = catalogLimit(limitInput);
    return db.transaction(() => {
      const dataset = getDatasetRow(datasetId);
      if (!dataset || dataset.catalog_visibility !== 'catalog') return null;
      const count = Number((db.prepare(`
        SELECT COUNT(*) AS count FROM analytics_dataset_versions WHERE dataset_id = ?
      `).get(datasetId) as { count: number }).count);
      const rows = db.prepare(`
        SELECT * FROM analytics_dataset_versions WHERE dataset_id = ?
        ORDER BY ordinal DESC, id ASC LIMIT ?
      `).all(datasetId, limit + 1) as VersionRow[];
      return {
        dataRoomVersion: readAnalyticsDataRoomVersion(db),
        datasetId,
        versions: rows.slice(0, limit).map(catalogVersionSummary),
        count,
        limit,
        truncated: count > limit,
      };
    })();
  }

  function getCatalogDatasetVersion(versionId: string): AnalyticsDataRoomCatalogVersionEnvelope | null {
    assertVersionId(versionId);
    return db.transaction(() => {
      const row = getVersionRow(versionId);
      if (!row) return null;
      const datasetRow = getDatasetRow(row.dataset_id);
      if (!datasetRow || datasetRow.catalog_visibility !== 'catalog') return null;
      const qualityCount = Number((db.prepare(`
        SELECT COUNT(*) AS count FROM analytics_dataset_assertion_evaluations
        WHERE version_id = ? AND assertion_id <> 'runtime_integrity'
      `).get(versionId) as { count: number }).count);
      const quality = (db.prepare(`
        SELECT assertion_id, assertion_version, severity, success
        FROM analytics_dataset_assertion_evaluations
        WHERE version_id = ? AND assertion_id <> 'runtime_integrity'
        ORDER BY severity DESC, success ASC, assertion_id, assertion_version LIMIT ?
      `).all(versionId, CATALOG_RELATION_LIMIT + 1) as Array<any>)
        .map<AnalyticsDataRoomCatalogQuality>(item => ({
          assertionId: item.assertion_id,
          assertionVersion: item.assertion_version,
          severity: item.severity,
          success: item.success === 1,
        }));
      const inputCount = Number((db.prepare(`
        SELECT COUNT(*) AS count FROM analytics_dataset_version_inputs WHERE output_version_id = ?
      `).get(versionId) as { count: number }).count);
      const inputs = (db.prepare(`
        SELECT alias, position, input_dataset_id, input_version_id,
          content_sha256, schema_sha256, contract_sha256, definition_sha256
        FROM analytics_dataset_version_inputs WHERE output_version_id = ?
        ORDER BY position, alias LIMIT ?
      `).all(versionId, CATALOG_RELATION_LIMIT + 1) as Array<any>)
        .map<AnalyticsDataRoomCatalogVersionInput>(item => ({
          alias: item.alias,
          position: Number(item.position),
          datasetId: item.input_dataset_id,
          versionId: item.input_version_id,
          contentSha256: item.content_sha256,
          schemaSha256: item.schema_sha256,
          contractSha256: item.contract_sha256,
          definitionSha256: item.definition_sha256,
        }));
      const outputCount = Number((db.prepare(`
        SELECT COUNT(*) AS count
        FROM analytics_dataset_version_inputs input
        JOIN analytics_dataset_versions output ON output.id = input.output_version_id
        JOIN analytics_datasets dataset ON dataset.id = output.dataset_id
        WHERE input.input_version_id = ? AND dataset.catalog_visibility = 'catalog'
      `).get(versionId) as { count: number }).count);
      const outputs = (db.prepare(`
        SELECT input.alias, input.position, output.dataset_id, dataset.name,
          output.id, output.ordinal, output.materialized_at,
          output.materialized_sha256, output.observed_schema_sha256,
          output.contract_sha256, output.definition_sha256
        FROM analytics_dataset_version_inputs input
        JOIN analytics_dataset_versions output ON output.id = input.output_version_id
        JOIN analytics_datasets dataset ON dataset.id = output.dataset_id
        WHERE input.input_version_id = ? AND dataset.catalog_visibility = 'catalog'
        ORDER BY output.materialized_at DESC, output.id, input.position LIMIT ?
      `).all(versionId, CATALOG_RELATION_LIMIT + 1) as Array<any>)
        .map<AnalyticsDataRoomCatalogVersionOutput>(item => ({
          alias: item.alias,
          position: Number(item.position),
          datasetId: item.dataset_id,
          datasetName: item.name,
          versionId: item.id,
          ordinal: Number(item.ordinal),
          materializedAt: item.materialized_at,
          contentSha256: item.materialized_sha256,
          schemaSha256: item.observed_schema_sha256,
          contractSha256: item.contract_sha256,
          definitionSha256: item.definition_sha256,
        }));
      const version: AnalyticsDataRoomCatalogVersionDetail = {
        ...catalogVersionSummary(row),
        observedSchema: strictJson(row.observed_schema_json, `version ${row.id} observed schema`),
        quality: boundedPage(quality, qualityCount, CATALOG_RELATION_LIMIT),
        inputs: boundedPage(inputs, inputCount, CATALOG_RELATION_LIMIT),
        outputs: boundedPage(outputs, outputCount, CATALOG_RELATION_LIMIT),
      };
      return { dataRoomVersion: readAnalyticsDataRoomVersion(db), version };
    })();
  }

  function isDerivedDatasetDirty(datasetId: string): boolean {
    assertDatasetId(datasetId);
    return !!db.prepare('SELECT 1 FROM analytics_derived_dirty WHERE dataset_id = ?').get(datasetId);
  }

  function assertDerivedGraphAcyclic(
    datasetId: string,
    dependencies: AnalyticsDerivedDefinitionV1['dependencies'],
  ): void {
    const graph = new Map<string, string[]>();
    const rows = db.prepare(`
      SELECT d.derived_dataset_id, d.input_dataset_id
      FROM analytics_dataset_dependencies d
      JOIN analytics_datasets target
        ON target.id = d.derived_dataset_id
       AND target.definition_revision = d.definition_revision
      ORDER BY d.derived_dataset_id, d.position, d.alias
    `).all() as Array<{ derived_dataset_id: string; input_dataset_id: string }>;
    for (const row of rows) graph.set(row.derived_dataset_id, [...(graph.get(row.derived_dataset_id) ?? []), row.input_dataset_id]);
    graph.set(datasetId, dependencies.map(item => item.datasetId));
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const visit = (current: string): void => {
      if (visiting.has(current)) fail('invalid_input', `Derived dependency cycle includes ${current}.`);
      if (visited.has(current)) return;
      visiting.add(current);
      for (const next of graph.get(current) ?? []) visit(next);
      visiting.delete(current);
      visited.add(current);
    };
    visit(datasetId);
  }

  function normalizeDefinition(
    raw: AnalyticsDatasetDefinitionInput,
    contract: AnalyticsDatasetContract,
  ): { document: AnalyticsDatasetDefinitionDocument; derived: AnalyticsDerivedDefinitionV1 | null } {
    if (!isRecord(raw.definition)) fail('invalid_input', 'definition must be an object.');
    if (raw.kind !== 'derived') {
      if (raw.definition.derived !== undefined) fail('invalid_input', 'Source datasets cannot declare definition.derived.');
      return { document: raw.definition, derived: null };
    }
    if (raw.sourceKind !== 'import' || raw.sourceFormat !== 'canonical_json') {
      fail('invalid_input', 'Derived datasets use the local canonical_json publication adapter.');
    }
    const topLevelExtras = Object.keys(raw.definition).filter(key => key !== 'answer' && key !== 'derived').sort();
    if (topLevelExtras.length) fail('invalid_input', `Derived definition contains unsupported field(s): ${topLevelExtras.join(', ')}.`);
    let derived: AnalyticsDerivedDefinitionV1;
    try {
      derived = parseAnalyticsDerivedDefinition(raw.definition.derived);
    } catch (error) {
      fail('invalid_input', error instanceof Error ? error.message : String(error));
    }
    const scopeRank = { dashboard_local: 0, project: 1, workspace: 2 } as const;
    for (const dependency of derived.dependencies) {
      if (dependency.datasetId === raw.id) fail('invalid_input', 'A derived dataset cannot depend on itself.');
      const inputDataset = getDataset(dependency.datasetId);
      if (!inputDataset || inputDataset.lifecycle !== 'active' || inputDataset.contract.status !== 'active') {
        fail('not_found', `Derived input dataset ${dependency.datasetId} is missing or inactive.`);
      }
      if (scopeRank[inputDataset.scope] < scopeRank[raw.scope]) {
        fail('policy_denied', `Derived scope ${raw.scope} cannot widen input ${dependency.datasetId} scope ${inputDataset.scope}.`);
      }
      const inputFields = new Set(inputDataset.contract.schema.map(field => field.name));
      if (dependency.requiredColumns.some(field => !inputFields.has(field))) {
        fail('invalid_input', `Dependency ${dependency.alias} requires a column absent from ${dependency.datasetId}.`);
      }
      if (dependency.expectedSchemaSha256 && dependency.expectedSchemaSha256 !== inputDataset.schemaSha256) {
        fail('invalid_input', `Dependency ${dependency.alias} expected schema SHA differs from ${dependency.datasetId}.`);
      }
      if (dependency.expectedContractSha256 && dependency.expectedContractSha256 !== inputDataset.contractSha256) {
        fail('invalid_input', `Dependency ${dependency.alias} expected contract SHA differs from ${dependency.datasetId}.`);
      }
      if (dependency.pinnedVersionId) {
        const pinned = getDatasetVersion(dependency.pinnedVersionId);
        if (!pinned || pinned.datasetId !== dependency.datasetId) {
          fail('invalid_input', `Dependency ${dependency.alias} pinned version does not belong to ${dependency.datasetId}.`);
        }
      }
    }
    assertDerivedGraphAcyclic(raw.id, derived.dependencies);
    if (!contract.relational) fail('invalid_input', 'Derived dataset contract requires relational metadata.');
    void analyticsDerivedTransformSha256(derived);
    return { document: { ...raw.definition, derived }, derived };
  }

  function insertDependencies(
    datasetId: string,
    revision: number,
    derived: AnalyticsDerivedDefinitionV1 | null,
    createdAt: string,
  ): void {
    if (!derived) return;
    const insert = db.prepare(`
      INSERT INTO analytics_dataset_dependencies
        (derived_dataset_id, definition_revision, alias, position, input_dataset_id,
         version_policy, pinned_version_id, required_columns_json,
         expected_schema_sha256, expected_contract_sha256, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    derived.dependencies.forEach((dependency, position) => insert.run(
      datasetId,
      revision,
      dependency.alias,
      position,
      dependency.datasetId,
      dependency.versionPolicy,
      dependency.pinnedVersionId ?? null,
      stableAnalyticsJson(dependency.requiredColumns),
      dependency.expectedSchemaSha256 ?? null,
      dependency.expectedContractSha256 ?? null,
      createdAt,
    ));
  }

  function markDerivedDefinitionDirty(
    datasetId: string,
    derived: AnalyticsDerivedDefinitionV1 | null,
    at: string,
  ): void {
    if (!derived) return;
    const cause = derived.dependencies
      .map(dependency => ({ datasetId: dependency.datasetId, head: getHead(dependency.datasetId) }))
      .find(value => value.head);
    if (!cause?.head) return;
    db.prepare(`
      INSERT INTO analytics_derived_dirty
        (dataset_id, cause_dataset_id, cause_version_id, status, error, invalidated_at)
      VALUES (?, ?, ?, 'pending', NULL, ?)
      ON CONFLICT(dataset_id) DO UPDATE SET
        cause_dataset_id = excluded.cause_dataset_id,
        cause_version_id = excluded.cause_version_id,
        status = 'pending', error = NULL, invalidated_at = excluded.invalidated_at
    `).run(datasetId, cause.datasetId, cause.head.versionId, at);
  }

  function registerDataset(raw: AnalyticsDatasetDefinitionInput): AnalyticsDatasetDetail {
    if (!raw || typeof raw !== 'object') fail('invalid_input', 'Dataset definition is required.');
    const id = assertDatasetId(raw.id);
    const contract = validateContract(raw.contract, id);
    const retention = validateRetention(raw.retention);
    const name = cleanText(raw.name, 'name', 240);
    const description = typeof raw.description === 'string' ? raw.description.trim().slice(0, 4000) : '';
    const domainKey = cleanText(raw.domainKey, 'domainKey', 160);
    const ownerId = cleanText(raw.ownerId, 'ownerId', 240);
    const catalogVisibility = raw.catalogVisibility ?? 'catalog';
    if (raw.kind !== contract.datasetKind || raw.scope !== contract.scope || raw.domainKey !== contract.domainKey) {
      fail('invalid_input', 'Dataset definition and contract identity differ.');
    }
    if (!['source', 'derived'].includes(raw.kind)
      || !['dashboard_local', 'project', 'workspace'].includes(raw.scope)
      || !['datanet_etl', 'sql_context', 'import'].includes(raw.sourceKind)
      || !['tsv', 'canonical_json'].includes(raw.sourceFormat)
      || !['internal', 'job_scoped', 'catalog'].includes(catalogVisibility)
      || (raw.lifecycle !== undefined && !['draft', 'active', 'deprecated', 'retired'].includes(raw.lifecycle))) {
      fail('invalid_input', 'Dataset definition contains an unsupported enum value.');
    }
    const normalizedDefinition = normalizeDefinition(raw, contract);
    const definitionJson = stableAnalyticsJson(normalizedDefinition.document);
    const definitionSha256 = analyticsSha256(normalizedDefinition.document);
    const contractJson = stableAnalyticsJson(contract);
    const retentionJson = stableAnalyticsJson(retention);
    const at = timestamp();
    const existing = getDatasetRow(id);
    if (existing) {
      const visibilityCompatible = existing.catalog_visibility === catalogVisibility
        || (existing.catalog_visibility === 'catalog' && catalogVisibility === 'job_scoped');
      const same = existing.name === name
        && existing.description === description
        && existing.kind === raw.kind
        && existing.scope === raw.scope
        && existing.domain_key === domainKey
        && existing.owner_id === ownerId
        && existing.lifecycle === (raw.lifecycle ?? 'draft')
        && visibilityCompatible
        && existing.source_kind === raw.sourceKind
        && existing.source_format === raw.sourceFormat
        && existing.definition_json === definitionJson
        && existing.definition_sha256 === definitionSha256
        && existing.contract_json === contractJson
        && existing.contract_sha256 === contract.contractSha256
        && existing.retention_json === retentionJson;
      if (!same) fail('conflict', `Dataset ${id} already exists with a different definition.`);
      return getDataset(id)!;
    }
    db.transaction(() => {
      db.prepare(`
        INSERT INTO analytics_datasets
          (id, name, description, kind, scope, domain_key, owner_id, lifecycle,
           catalog_visibility, source_kind, source_format, definition_json, definition_revision,
           definition_sha256, contract_json, contract_sha256, schema_sha256,
           retention_json, minimum_versions, automatic_expiry, reacquirable,
           backup_required, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id, name, description, raw.kind, raw.scope, domainKey, ownerId,
        raw.lifecycle ?? 'draft', catalogVisibility, raw.sourceKind, raw.sourceFormat, definitionJson,
        definitionSha256, contractJson, contract.contractSha256, contract.schemaSha256,
        retentionJson, retention.minimumVersions, retention.automaticExpiry ? 1 : 0,
        retention.reacquirable ? 1 : 0, retention.backupRequired ? 1 : 0, at, at,
      );
      db.prepare(`
        INSERT INTO analytics_dataset_definition_revisions
          (dataset_id, revision, definition_json, definition_sha256, contract_json,
           contract_sha256, schema_sha256, retention_json, created_at)
        VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, definitionJson, definitionSha256, contractJson, contract.contractSha256, contract.schemaSha256, retentionJson, at);
      insertDependencies(id, 1, normalizedDefinition.derived, at);
      markDerivedDefinitionDirty(id, normalizedDefinition.derived, at);
    })();
    ensureDatasetDirectories(id);
    return getDataset(id)!;
  }

  function setCatalogVisibility(
    datasetId: string,
    expected: AnalyticsDatasetCatalogVisibility,
    next: AnalyticsDatasetCatalogVisibility,
  ): AnalyticsDatasetDetail {
    const id = assertDatasetId(datasetId);
    if (!['internal', 'job_scoped', 'catalog'].includes(expected)
      || !['internal', 'job_scoped', 'catalog'].includes(next)) {
      fail('invalid_input', 'Dataset catalog visibility is unsupported.');
    }
    const allowed = (expected === next)
      || (expected === 'internal' && next === 'job_scoped')
      || (expected === 'job_scoped' && next === 'catalog');
    if (!allowed) fail('policy_denied', `Dataset visibility cannot move from ${expected} to ${next}.`);
    const current = getDatasetRow(id);
    if (!current) fail('not_found', `Dataset ${id} was not found.`);
    if (current.catalog_visibility === next) return getDataset(id)!;
    if (current.catalog_visibility !== expected) {
      fail('conflict', `Dataset visibility changed from expected ${expected} to ${current.catalog_visibility}.`);
    }
    const at = timestamp();
    db.transaction(() => {
      const changed = db.prepare(`
        UPDATE analytics_datasets SET catalog_visibility=?, updated_at=?
        WHERE id=? AND catalog_visibility=?
      `).run(next, at, id, expected);
      if (changed.changes !== 1) fail('conflict', 'Dataset visibility changed during promotion.');
      db.prepare(`
        UPDATE analytics_data_room_state SET revision=revision+1, updated_at=? WHERE singleton=1
      `).run(at);
    })();
    return getDataset(id)!;
  }

  function reviseDataset(raw: AnalyticsDatasetRevisionInput): AnalyticsDatasetDetail {
    if (!raw || typeof raw !== 'object') fail('invalid_input', 'Dataset revision is required.');
    const id = assertDatasetId(raw.id);
    const existing = getDatasetRow(id);
    if (!existing) fail('not_found', `Dataset ${id} was not found.`);
    if (!Number.isInteger(raw.expectedDefinitionRevision) || raw.expectedDefinitionRevision < 1
      || raw.expectedDefinitionRevision !== existing.definition_revision) {
      fail('conflict', `Dataset definition revision changed from expected ${raw.expectedDefinitionRevision} to ${existing.definition_revision}.`);
    }
    const contract = validateContract(raw.contract, id);
    const retention = validateRetention(raw.retention);
    const name = cleanText(raw.name, 'name', 240);
    const description = typeof raw.description === 'string' ? raw.description.trim().slice(0, 4000) : '';
    const domainKey = cleanText(raw.domainKey, 'domainKey', 160);
    const ownerId = cleanText(raw.ownerId, 'ownerId', 240);
    if (raw.kind !== existing.kind || ownerId !== existing.owner_id
      || raw.sourceKind !== existing.source_kind || raw.sourceFormat !== existing.source_format
      || (raw.catalogVisibility !== undefined && raw.catalogVisibility !== existing.catalog_visibility)) {
      fail('invalid_input', 'Dataset kind, owner, source adapter, source format, and catalog visibility are immutable across definition revisions.');
    }
    if (raw.kind !== contract.datasetKind || raw.scope !== contract.scope || domainKey !== contract.domainKey) {
      fail('invalid_input', 'Dataset revision and contract identity differ.');
    }
    if (!['dashboard_local', 'project', 'workspace'].includes(raw.scope)
      || (raw.lifecycle !== undefined && !['draft', 'active', 'deprecated', 'retired'].includes(raw.lifecycle))) {
      fail('invalid_input', 'Dataset revision contains an unsupported enum value.');
    }
    const normalizedDefinition = normalizeDefinition(raw, contract);
    const definitionJson = stableAnalyticsJson(normalizedDefinition.document);
    const definitionSha256 = analyticsSha256(normalizedDefinition.document);
    const contractJson = stableAnalyticsJson(contract);
    const retentionJson = stableAnalyticsJson(retention);
    const nextRevision = existing.definition_revision + 1;
    const at = timestamp();
    db.transaction(() => {
      const changed = db.prepare(`
        UPDATE analytics_datasets
        SET name = ?, description = ?, scope = ?, domain_key = ?, lifecycle = ?,
            definition_json = ?, definition_revision = ?, definition_sha256 = ?,
            contract_json = ?, contract_sha256 = ?, schema_sha256 = ?, retention_json = ?,
            minimum_versions = ?, automatic_expiry = ?, reacquirable = ?, backup_required = ?, updated_at = ?
        WHERE id = ? AND definition_revision = ?
      `).run(
        name, description, raw.scope, domainKey, raw.lifecycle ?? existing.lifecycle,
        definitionJson, nextRevision, definitionSha256, contractJson, contract.contractSha256,
        contract.schemaSha256, retentionJson, retention.minimumVersions,
        retention.automaticExpiry ? 1 : 0, retention.reacquirable ? 1 : 0,
        retention.backupRequired ? 1 : 0, at, id, raw.expectedDefinitionRevision,
      );
      if (changed.changes !== 1) fail('conflict', 'Dataset definition changed during revision.');
      db.prepare(`
        INSERT INTO analytics_dataset_definition_revisions
          (dataset_id, revision, definition_json, definition_sha256, contract_json,
           contract_sha256, schema_sha256, retention_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, nextRevision, definitionJson, definitionSha256, contractJson, contract.contractSha256, contract.schemaSha256, retentionJson, at);
      insertDependencies(id, nextRevision, normalizedDefinition.derived, at);
      markDerivedDefinitionDirty(id, normalizedDefinition.derived, at);
    })();
    return getDataset(id)!;
  }

  function validateRows(
    columns: string[],
    rows: AnalyticsDataCell[][],
    contract: AnalyticsDatasetContract,
  ): void {
    if (!Array.isArray(columns) || stableAnalyticsJson(columns) !== stableAnalyticsJson(contract.schema.map(field => field.name))) {
      fail('invalid_input', 'Source columns do not exactly match the declared schema order.');
    }
    if (!Array.isArray(rows)) fail('invalid_input', 'Source rows must be an array.');
    for (const [rowIndex, row] of rows.entries()) {
      if (!Array.isArray(row) || row.length !== contract.schema.length) {
        fail('invalid_input', `Row ${rowIndex} does not match the declared schema width.`);
      }
      row.forEach((value, columnIndex) => validateTypedCell(value, contract.schema[columnIndex], rowIndex));
    }
  }

  function validateObservedCoverage(rows: AnalyticsDataCell[][], contract: AnalyticsDatasetContract): void {
    const timeIndex = contract.schema.findIndex(field => field.name === contract.timeField);
    const timeField = contract.schema[timeIndex];
    const complete = new Set(contract.coverage.completePartitions);
    const declaredObserved = contract.coverage.observedPartitions ? new Set(contract.coverage.observedPartitions) : complete;
    const actualObserved = new Set<string>();
    let latestObservedDay = '';
    for (const [rowIndex, row] of rows.entries()) {
      const value = row[timeIndex];
      if (typeof value !== 'string') fail('integrity_failed', `Row ${rowIndex} has no usable time partition.`);
      const observedDay = timeField.logicalType === 'date'
        ? value
        : timestampDayInZone(value, contract.timeZone);
      const partition = contract.coverage.partitionKind === 'month'
        ? `${observedDay.slice(0, 7)}-01`
        : observedDay;
      if (!declaredObserved.has(partition)) {
        fail('integrity_failed', `Observed row partition ${partition} is absent from declared observed coverage.`);
      }
      actualObserved.add(partition);
      if (partition > latestObservedDay) latestObservedDay = partition;
    }
    if (contract.coverage.observedPartitions
      && stableAnalyticsJson([...actualObserved].sort()) !== stableAnalyticsJson([...declaredObserved].sort())) {
      fail('integrity_failed', 'Declared observed coverage differs from actual row partitions.');
    }
    const watermarkDay = timestampDayInZone(contract.coverage.watermark, contract.timeZone);
    const watermarkPartition = contract.coverage.partitionKind === 'month'
      ? `${watermarkDay.slice(0, 7)}-01`
      : watermarkDay;
    if (latestObservedDay && watermarkPartition < latestObservedDay) {
      fail('integrity_failed', 'Coverage watermark precedes an observed row partition.');
    }
  }

  function createRun(
    dataset: AnalyticsDatasetDefinitionRecord,
    ingest: AnalyticsParsedSourceIngest,
    requestSha256: string,
  ): { id: string; queuedAt: string } {
    recoverStaleRuns();
    const id = `dsrun_${createId().slice(0, 32)}`;
    if (!RUN_ID_RE.test(id)) fail('invalid_input', 'Generated run ID is malformed.');
    const queuedAt = timestamp();
    const leaseExpiresAt = new Date(now().getTime() + RUN_LEASE_MS).toISOString();
    try {
      db.prepare(`
        INSERT INTO analytics_dataset_runs
          (id, dataset_id, trigger, request_sha256, definition_revision,
           definition_sha256, status, source_kind, remote_identity_json,
           lease_owner, lease_expires_at, heartbeat_at, queued_at, started_at)
        VALUES (?, ?, ?, ?, ?, ?, 'staging', ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id, dataset.id, ingest.trigger ?? 'manual', requestSha256,
        dataset.definitionRevision, dataset.definitionSha256,
        ingest.sourceReceipt.sourceKind, stableAnalyticsJson(ingest.sourceReceipt),
        `pid:${process.pid}`, leaseExpiresAt, queuedAt, queuedAt, queuedAt,
      );
    } catch (error) {
      if (String((error as Error).message).includes('idx_analytics_dataset_runs_active')) {
        fail('conflict', 'An equivalent dataset acquisition is already active.');
      }
      throw error;
    }
    return { id, queuedAt };
  }

  function failRun(runId: string, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    try {
      db.prepare(`
        UPDATE analytics_dataset_runs
        SET status = 'failed', error = ?, lease_owner = NULL,
            lease_expires_at = NULL, heartbeat_at = ?, completed_at = ?
        WHERE id = ? AND status IN ('staging','verifying')
      `).run(message.slice(0, 1000), timestamp(), timestamp(), runId);
    } catch {
      // Preserve the original error; startup recovery can terminalize this run.
    }
  }

  function promoteHead(
    dataset: AnalyticsDatasetDefinitionRecord,
    versionId: string,
    expectedHeadRevision: number,
    at: string,
  ): AnalyticsDatasetHeadRecord {
    const currentRow = db.prepare('SELECT * FROM analytics_dataset_heads WHERE dataset_id = ?').get(dataset.id) as HeadRow | undefined;
    if (currentRow?.version_id === versionId) return rowToHead(currentRow);
    const currentRevision = currentRow?.head_revision ?? 0;
    if (currentRevision !== expectedHeadRevision) {
      fail('conflict', `Dataset head revision changed from expected ${expectedHeadRevision} to ${currentRevision}.`);
    }
    const nextRevision = currentRevision + 1;
    const receipt = {
      datasetId: dataset.id,
      versionId,
      definitionRevision: dataset.definitionRevision,
      previousVersionId: currentRow?.version_id ?? null,
      previousHeadRevision: currentRevision,
      headRevision: nextRevision,
      promotedAt: at,
    };
    if (!currentRow) {
      db.prepare(`
        INSERT INTO analytics_dataset_heads
          (dataset_id, version_id, definition_revision, head_revision, promoted_at, promotion_receipt_json)
        VALUES (?, ?, ?, 1, ?, ?)
      `).run(dataset.id, versionId, dataset.definitionRevision, at, stableAnalyticsJson(receipt));
    } else {
      const changed = db.prepare(`
        UPDATE analytics_dataset_heads
        SET version_id = ?, definition_revision = ?, head_revision = ?,
            promoted_at = ?, promotion_receipt_json = ?
        WHERE dataset_id = ? AND head_revision = ?
      `).run(
        versionId, dataset.definitionRevision, nextRevision, at,
        stableAnalyticsJson(receipt), dataset.id, currentRevision,
      );
      if (changed.changes !== 1) fail('conflict', 'Dataset head changed during promotion.');
    }
    db.prepare(`
      WITH RECURSIVE descendants(dataset_id) AS (
        SELECT d.derived_dataset_id
        FROM analytics_dataset_dependencies d
        JOIN analytics_datasets target
          ON target.id = d.derived_dataset_id
         AND target.definition_revision = d.definition_revision
        WHERE d.input_dataset_id = ? AND target.lifecycle = 'active'
        UNION
        SELECT d.derived_dataset_id
        FROM analytics_dataset_dependencies d
        JOIN analytics_datasets target
          ON target.id = d.derived_dataset_id
         AND target.definition_revision = d.definition_revision
        JOIN descendants parent ON parent.dataset_id = d.input_dataset_id
        WHERE target.lifecycle = 'active'
      )
      INSERT INTO analytics_derived_dirty
        (dataset_id, cause_dataset_id, cause_version_id, status, error, invalidated_at)
      SELECT dataset_id, ?, ?, 'pending', NULL, ? FROM descendants WHERE 1
      ON CONFLICT(dataset_id) DO UPDATE SET
        cause_dataset_id = excluded.cause_dataset_id,
        cause_version_id = excluded.cause_version_id,
        status = 'pending',
        error = NULL,
        invalidated_at = excluded.invalidated_at
    `).run(dataset.id, dataset.id, versionId, at);
    return getHead(dataset.id)!;
  }

  function verifyStoredFile(relativePath: string, expectedSha256: string, expectedBytes: number): string {
    const absolutePath = resolveRelative(relativePath);
    verifyPrivateFile(absolutePath, expectedSha256, expectedBytes);
    return absolutePath;
  }

  function readAndVerifyManifest(row: VersionRow): AnalyticsDatasetVersionManifest {
    const manifestPath = resolveRelative(row.manifest_rel_path);
    const stat = fs.lstatSync(manifestPath);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) {
      fail('integrity_failed', `Version ${row.id} manifest is not a private regular file.`);
    }
    if (hashFile(manifestPath).sha256 !== row.manifest_sha256) {
      fail('integrity_failed', `Version ${row.id} manifest bytes differ from the catalog receipt.`);
    }
    const manifest = strictJson<AnalyticsDatasetVersionManifest>(fs.readFileSync(manifestPath, 'utf8'), `version ${row.id} manifest`);
    if ((manifest.manifestVersion !== 1 && manifest.manifestVersion !== 2)
      || (manifest.manifestVersion === 1 && manifest.derivation !== undefined)
      || (manifest.manifestVersion === 2 && !manifest.derivation)
      || manifest.datasetId !== row.dataset_id
      || manifest.versionId !== row.id
      || manifest.ordinal !== row.ordinal
      || manifest.versionKeySha256 !== row.version_key_sha256
      || manifest.sourceFile.sha256 !== row.source_sha256
      || manifest.sourceFile.bytes !== row.source_bytes
      || manifest.materializedFile.sha256 !== row.materialized_sha256
      || manifest.materializedFile.bytes !== row.materialized_bytes
      || manifest.rowCount !== row.row_count
      || manifest.observedSchemaSha256 !== row.observed_schema_sha256
      || manifest.contractSha256 !== row.contract_sha256
      || manifest.definitionSha256 !== row.definition_sha256) {
      fail('integrity_failed', `Version ${row.id} manifest differs from catalog metadata.`);
    }
    if (manifest.derivation) {
      const run = db.prepare(`
        SELECT id, transform_sha256, input_set_sha256, materialization_key_sha256
        FROM analytics_derived_runs WHERE id = ? AND output_version_id = ?
      `).get(manifest.derivation.runId, row.id) as {
        id: string;
        transform_sha256: string;
        input_set_sha256: string;
        materialization_key_sha256: string;
      } | undefined;
      const inputRows = db.prepare(`
        SELECT alias, input_dataset_id, input_version_id, content_sha256,
          schema_sha256, contract_sha256, definition_sha256
        FROM analytics_dataset_version_inputs
        WHERE output_version_id = ? ORDER BY position, alias
      `).all(row.id) as Array<{
        alias: string;
        input_dataset_id: string;
        input_version_id: string;
        content_sha256: string;
        schema_sha256: string;
        contract_sha256: string;
        definition_sha256: string;
      }>;
      const storedInputs = inputRows.map(value => ({
        alias: value.alias,
        datasetId: value.input_dataset_id,
        versionId: value.input_version_id,
        contentSha256: value.content_sha256,
        schemaSha256: value.schema_sha256,
        contractSha256: value.contract_sha256,
        definitionSha256: value.definition_sha256,
      }));
      if (!run
        || run.transform_sha256 !== manifest.derivation.transformSha256
        || run.input_set_sha256 !== manifest.derivation.inputSetSha256
        || run.materialization_key_sha256 !== manifest.derivation.materializationKeySha256
        || stableAnalyticsJson(storedInputs) !== stableAnalyticsJson(manifest.derivation.inputs)) {
        fail('integrity_failed', `Version ${row.id} derivation lineage differs from catalog metadata.`);
      }
    }
    return manifest;
  }

  function readVerifiedOrphanManifest(
    versionDirectory: string,
    expected: {
      datasetId: string;
      versionId: string;
      versionKeySha256: string;
      sourceFormat: AnalyticsDataRoomSourceFormat;
      sourceSha256: string;
      rowCount: number;
      contractSha256: string;
      definitionSha256: string;
      quality: AnalyticsQualityAssertionEvaluation[];
      derivation?: AnalyticsDerivationLineageReceipt;
    },
  ): { manifest: AnalyticsDatasetVersionManifest; manifestSha256: string } {
    assertPrivateDirectory(versionDirectory);
    const expectedSourceName = expected.sourceFormat === 'tsv' ? 'source.tsv' : 'source.json';
    const entries = fs.readdirSync(versionDirectory).sort();
    if (stableAnalyticsJson(entries) !== stableAnalyticsJson([expectedSourceName, 'manifest.json', 'materialized.db'].sort())) {
      fail('integrity_failed', `Orphan version ${expected.versionId} contains an unexpected file set.`);
    }
    const manifestPath = path.join(versionDirectory, 'manifest.json');
    const manifestStat = fs.lstatSync(manifestPath);
    if (!manifestStat.isFile() || manifestStat.isSymbolicLink() || (manifestStat.mode & 0o077) !== 0) {
      fail('integrity_failed', `Orphan version ${expected.versionId} manifest is not a private regular file.`);
    }
    const manifestReceipt = hashFile(manifestPath);
    const manifest = strictJson<AnalyticsDatasetVersionManifest>(
      fs.readFileSync(manifestPath, 'utf8'),
      `orphan version ${expected.versionId} manifest`,
    );
    if (manifest.manifestVersion !== (expected.derivation ? 2 : 1)
      || stableAnalyticsJson(manifest.derivation ?? null) !== stableAnalyticsJson(expected.derivation ?? null)
      || manifest.datasetId !== expected.datasetId
      || manifest.versionId !== expected.versionId
      || manifest.versionKeySha256 !== expected.versionKeySha256
      || manifest.sourceFormat !== expected.sourceFormat
      || manifest.sourceFile.fileName !== expectedSourceName
      || manifest.sourceFile.sha256 !== expected.sourceSha256
      || manifest.materializedFile.fileName !== 'materialized.db'
      || manifest.rowCount !== expected.rowCount
      || manifest.contractSha256 !== expected.contractSha256
      || manifest.definitionSha256 !== expected.definitionSha256
      || stableAnalyticsJson(manifest.quality) !== stableAnalyticsJson(expected.quality)) {
      fail('integrity_failed', `Orphan version ${expected.versionId} does not match this acquisition.`);
    }
    verifyPrivateFile(
      path.join(versionDirectory, manifest.sourceFile.fileName),
      manifest.sourceFile.sha256,
      manifest.sourceFile.bytes,
    );
    const materializedPath = path.join(versionDirectory, manifest.materializedFile.fileName);
    verifyPrivateFile(materializedPath, manifest.materializedFile.sha256, manifest.materializedFile.bytes);
    verifyMaterializedDatabase(materializedPath, manifest.rowCount);
    return { manifest, manifestSha256: manifestReceipt.sha256 };
  }

  function quarantine(row: VersionRow, reason: string): void {
    const at = timestamp();
    db.transaction(() => {
      db.prepare(`
        UPDATE analytics_dataset_versions
        SET integrity_status = 'quarantined', quarantine_reason = ?
        WHERE id = ?
      `).run(reason.slice(0, 1000), row.id);
      db.prepare(`
        INSERT OR IGNORE INTO analytics_dataset_assertion_evaluations
          (id, version_id, assertion_id, assertion_version, severity, success,
           observed_json, expected_json, created_at)
        VALUES (?, ?, 'runtime_integrity', ?, 'error', 0, ?, ?, ?)
      `).run(
        `dsae_${createId().slice(0, 24)}`, row.id, at,
        stableAnalyticsJson({ reason: reason.slice(0, 1000) }),
        stableAnalyticsJson({ status: 'verified' }), at,
      );
    })();
  }

  function verifyVersion(versionId: string, use?: AnalyticsDataRoomUse): AnalyticsVersionIntegrityReceipt {
    const row = getVersionRow(versionId);
    if (!row) fail('not_found', `Version ${versionId} was not found.`);
    if (row.integrity_status === 'quarantined') {
      fail('integrity_failed', row.quarantine_reason || `Version ${versionId} is quarantined.`);
    }
    try {
      const sourcePath = verifyStoredFile(row.source_rel_path, row.source_sha256, row.source_bytes);
      void sourcePath;
      const materializedPath = verifyStoredFile(row.materialized_rel_path, row.materialized_sha256, row.materialized_bytes);
      readAndVerifyManifest(row);
      verifyMaterializedDatabase(materializedPath, row.row_count);
      const detail = versionDetailFromRow(row);
      if (use) assertHandling(detail.handling, use);
      const verifiedAt = timestamp();
      db.prepare(`
        UPDATE analytics_dataset_versions
        SET integrity_verified_at = ?
        WHERE id = ? AND integrity_status = 'verified'
      `).run(verifiedAt, versionId);
      return { status: 'verified', verifiedAt };
    } catch (error) {
      if (error instanceof AnalyticsDataRoomError && error.code === 'policy_denied') throw error;
      if (deterministicIntegrityFailure(error)) {
        const reason = deterministicIntegrityReason(error);
        quarantine(row, reason);
        if (error instanceof AnalyticsDataRoomError) throw error;
        return fail('integrity_failed', reason);
      }
      throw new AnalyticsDataRoomError(
        'conflict',
        'Version verification could not complete because local I/O is temporarily unavailable; retry without changing the version.',
      );
    }
  }

  function getVerifiedMaterializedPath(versionId: string, use: AnalyticsDataRoomUse): string {
    verifyVersion(versionId, use);
    const row = getVersionRow(versionId)!;
    return resolveRelative(row.materialized_rel_path);
  }

  function insertVersionAndPromote(
    dataset: AnalyticsDatasetDefinitionRecord,
    manifest: AnalyticsDatasetVersionManifest,
    manifestSha256: string,
    runId: string,
    expectedHeadRevision: number,
    idempotent: boolean,
  ): AnalyticsVersionPromotionReceipt {
    const versionDirectory = path.join(datasetDirectory(dataset.id), 'versions', manifest.versionId);
    const sourceRelPath = relative(path.join(versionDirectory, manifest.sourceFile.fileName));
    const materializedRelPath = relative(path.join(versionDirectory, manifest.materializedFile.fileName));
    const manifestRelPath = relative(path.join(versionDirectory, 'manifest.json'));
    const at = timestamp();
    db.transaction(() => {
      const currentDataset = getDatasetRow(dataset.id);
      if (!currentDataset
        || currentDataset.definition_revision !== dataset.definitionRevision
        || currentDataset.definition_sha256 !== dataset.definitionSha256) {
        fail('definition_changed', 'Dataset definition changed before version promotion.');
      }
      const existing = db.prepare(`
        SELECT id FROM analytics_dataset_versions
        WHERE dataset_id = ? AND version_key_sha256 = ?
      `).get(dataset.id, manifest.versionKeySha256) as { id: string } | undefined;
      if (existing && existing.id !== manifest.versionId) {
        fail('conflict', 'Semantic version identity already belongs to another version.');
      }
      if (!existing) {
        db.prepare(`
          INSERT INTO analytics_dataset_versions
            (id, dataset_id, ordinal, version_key_sha256, source_format,
             source_rel_path, source_sha256, source_bytes, materialized_rel_path,
             materialized_sha256, materialized_bytes, manifest_rel_path,
             manifest_sha256, row_count, observed_schema_json,
             observed_schema_sha256, contract_json, contract_sha256,
             coverage_json, watermark, source_receipt_json, definition_sha256,
             handling_json, integrity_status, integrity_verified_at, reacquirable,
             materialized_at, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'verified', ?, ?, ?, ?)
        `).run(
          manifest.versionId, dataset.id, manifest.ordinal, manifest.versionKeySha256,
          manifest.sourceFormat, sourceRelPath, manifest.sourceFile.sha256,
          manifest.sourceFile.bytes, materializedRelPath,
          manifest.materializedFile.sha256, manifest.materializedFile.bytes,
          manifestRelPath, manifestSha256, manifest.rowCount,
          stableAnalyticsJson(manifest.observedSchema), manifest.observedSchemaSha256,
          stableAnalyticsJson(manifest.contract), manifest.contractSha256,
          stableAnalyticsJson(manifest.coverage), manifest.coverage.watermark,
          stableAnalyticsJson(manifest.sourceReceipt), manifest.definitionSha256,
          stableAnalyticsJson(manifest.handling), at, manifest.reacquirable ? 1 : 0,
          manifest.materializedAt, manifest.createdAt,
        );
        const assertionInsert = db.prepare(`
          INSERT INTO analytics_dataset_assertion_evaluations
            (id, version_id, assertion_id, assertion_version, severity, success,
             observed_json, expected_json, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        for (const quality of manifest.quality) {
          const assertionId = `dsae_${analyticsSha256({
            versionId: manifest.versionId,
            assertionId: quality.assertionId,
            assertionVersion: quality.assertionVersion,
          }).slice(0, 24)}`;
          assertionInsert.run(
            assertionId, manifest.versionId, quality.assertionId,
            quality.assertionVersion, quality.severity, quality.success ? 1 : 0,
            quality.observed === undefined ? null : stableAnalyticsJson(quality.observed),
            quality.expected === undefined ? null : stableAnalyticsJson(quality.expected),
            manifest.createdAt,
          );
        }
        if (manifest.derivation) {
          const inputInsert = db.prepare(`
            INSERT INTO analytics_dataset_version_inputs
              (output_version_id, alias, position, input_dataset_id, input_version_id,
               content_sha256, schema_sha256, contract_sha256, definition_sha256)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          `);
          manifest.derivation.inputs.forEach((input, position) => inputInsert.run(
            manifest.versionId,
            input.alias,
            position,
            input.datasetId,
            input.versionId,
            input.contentSha256,
            input.schemaSha256,
            input.contractSha256,
            input.definitionSha256,
          ));
          const runAssertionInsert = db.prepare(`
            INSERT INTO analytics_derived_run_assertions
              (id, run_id, assertion_id, assertion_version, severity, success,
               observed_json, expected_json, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          `);
          for (const check of manifest.derivation.checks) {
            runAssertionInsert.run(
              `dsra_${analyticsSha256({
                runId: manifest.derivation.runId,
                assertionId: check.assertionId,
                assertionVersion: check.assertionVersion,
              }).slice(0, 24)}`,
              manifest.derivation.runId,
              check.assertionId,
              check.assertionVersion,
              check.severity,
              check.success ? 1 : 0,
              check.observed === undefined ? null : stableAnalyticsJson(check.observed),
              check.expected === undefined ? null : stableAnalyticsJson(check.expected),
              manifest.createdAt,
            );
          }
          const linked = db.prepare(`
            UPDATE analytics_derived_runs SET output_version_id = ?, heartbeat_at = ?
            WHERE id = ? AND dataset_id = ? AND definition_sha256 = ?
              AND materialization_key_sha256 = ? AND status = 'running'
          `).run(
            manifest.versionId,
            at,
            manifest.derivation.runId,
            dataset.id,
            dataset.definitionSha256,
            manifest.derivation.materializationKeySha256,
          );
          if (linked.changes !== 1) fail('conflict', 'Derived run changed before version lineage publication.');
        }
      }
      const head = promoteHead(dataset, manifest.versionId, expectedHeadRevision, at);
      db.prepare(`
        UPDATE analytics_dataset_runs
        SET status = 'completed', output_version_id = ?, receipt_json = ?,
            lease_owner = NULL, lease_expires_at = NULL, heartbeat_at = ?, completed_at = ?
        WHERE id = ? AND status IN ('staging','verifying')
      `).run(
        manifest.versionId,
        stableAnalyticsJson({
          datasetId: dataset.id,
          versionId: manifest.versionId,
          versionKeySha256: manifest.versionKeySha256,
          manifestSha256,
          headRevision: head.headRevision,
          idempotent,
        }),
        at, at, runId,
      );
    })();
    const version = getDatasetVersion(manifest.versionId)!;
    return {
      datasetId: dataset.id,
      version,
      head: getHead(dataset.id)!,
      run: getRun(runId)!,
      idempotent,
    };
  }

  function validateDerivationLineage(
    dataset: AnalyticsDatasetDetail,
    ingest: AnalyticsParsedSourceIngest,
  ): AnalyticsDerivationLineageReceipt | undefined {
    if (dataset.kind !== 'derived') {
      if (ingest.derivation) fail('invalid_input', 'Source datasets cannot publish derived lineage.');
      return undefined;
    }
    const lineage = ingest.derivation;
    if (!lineage
      || !/^dsdr_[a-f0-9]{32}$/.test(lineage.runId)
      || lineage.compilerVersion !== 'botboy-relational-v1'
      || !SHA256_RE.test(lineage.transformSha256)
      || !SHA256_RE.test(lineage.inputSetSha256)
      || !SHA256_RE.test(lineage.materializationKeySha256)
      || !Array.isArray(lineage.inputs) || lineage.inputs.length === 0
      || !Array.isArray(lineage.checks)) {
      fail('invalid_input', 'Derived lineage receipt is malformed.');
    }
    let definition: AnalyticsDerivedDefinitionV1;
    try {
      definition = parseAnalyticsDerivedDefinition(dataset.definition.derived);
    } catch (error) {
      fail('integrity_failed', error instanceof Error ? error.message : String(error));
    }
    if (analyticsDerivedTransformSha256(definition) !== lineage.transformSha256) {
      fail('integrity_failed', 'Derived transform SHA differs from the current definition.');
    }
    const sortedInputs = [...lineage.inputs].sort((left, right) => left.alias.localeCompare(right.alias));
    if (stableAnalyticsJson(sortedInputs) !== stableAnalyticsJson(lineage.inputs)
      || new Set(lineage.inputs.map(value => value.alias)).size !== lineage.inputs.length) {
      fail('invalid_input', 'Derived input pins must be uniquely alias-sorted.');
    }
    const dependencies = new Map(definition.dependencies.map(value => [value.alias, value]));
    const classificationRank = new Map([
      ['public', 0], ['internal', 1], ['confidential', 2], ['highly_confidential', 3],
      ['restricted', 4], ['critical', 5],
    ]);
    let requiredClassificationRank = 0;
    let allowedUses = new Set<AnalyticsDataRoomUse>(['local_answer', 'dashboard', 'publication']);
    let allowModelContext = true;
    const inputModelContextPolicies: NonNullable<AnalyticsHandlingContract['modelContextPolicy']>[] = [];
    let allowPublication = true;
    let commonPartitions: Set<string> | null = null;
    let minimumWatermark: string | null = null;
    for (const pin of lineage.inputs) {
      const dependency = dependencies.get(pin.alias);
      if (!dependency || dependency.datasetId !== pin.datasetId
        || !VERSION_ID_RE.test(pin.versionId)
        || !SHA256_RE.test(pin.contentSha256)
        || !SHA256_RE.test(pin.schemaSha256)
        || !SHA256_RE.test(pin.contractSha256)
        || !SHA256_RE.test(pin.definitionSha256)) {
        fail('integrity_failed', `Derived input pin ${pin.alias} differs from its definition.`);
      }
      const version = getDatasetVersion(pin.versionId);
      if (!version || version.datasetId !== pin.datasetId
        || version.materializedSha256 !== pin.contentSha256
        || version.observedSchemaSha256 !== pin.schemaSha256
        || version.contractSha256 !== pin.contractSha256
        || version.definitionSha256 !== pin.definitionSha256) {
        fail('integrity_failed', `Derived input pin ${pin.alias} differs from immutable catalog receipts.`);
      }
      verifyVersion(pin.versionId);
      const rank = classificationRank.get(version.handling.classification.toLowerCase());
      if (rank === undefined) fail('policy_denied', `Input ${pin.alias} has an unknown handling classification.`);
      requiredClassificationRank = Math.max(requiredClassificationRank, rank);
      allowedUses = new Set([...allowedUses].filter(use => version.handling.allowedUses.includes(use)));
      allowModelContext &&= version.handling.allowModelContext;
      if (version.handling.modelContextPolicy) inputModelContextPolicies.push(version.handling.modelContextPolicy);
      allowPublication &&= version.handling.allowPublication;
      const partitions = new Set<string>(version.coverage.completePartitions);
      const priorPartitions = commonPartitions as Set<string> | null;
      commonPartitions = priorPartitions === null
        ? partitions
        : new Set<string>([...priorPartitions].filter(partition => partitions.has(partition)));
      const priorWatermark = minimumWatermark as string | null;
      minimumWatermark = priorWatermark === null || version.coverage.watermark < priorWatermark
        ? version.coverage.watermark
        : priorWatermark;
    }
    if (lineage.inputs.length !== dependencies.size) fail('integrity_failed', 'Derived lineage does not pin every dependency exactly once.');
    const outputRank = classificationRank.get(dataset.contract.handling.classification.toLowerCase());
    const outputModelPolicy = dataset.contract.handling.modelContextPolicy;
    const widensModelPolicy = dataset.contract.handling.allowModelContext && inputModelContextPolicies.some(policy =>
      !outputModelPolicy
      || outputModelPolicy.allowedProviderLocalities.some(locality => !policy.allowedProviderLocalities.includes(locality))
      || (policy.endpointSha256 !== undefined && outputModelPolicy.endpointSha256 !== policy.endpointSha256)
      || outputModelPolicy.disclosurePolicyVersion !== policy.disclosurePolicyVersion);
    if (outputRank === undefined || outputRank < requiredClassificationRank
      || dataset.contract.handling.allowedUses.some(use => !allowedUses.has(use))
      || (dataset.contract.handling.allowModelContext && !allowModelContext)
      || widensModelPolicy
      || (dataset.contract.handling.allowPublication && !allowPublication)) {
      fail('policy_denied', 'Derived handling contract widens an input policy.');
    }
    if (stableAnalyticsJson([...(commonPartitions ?? new Set())].sort())
        !== stableAnalyticsJson([...dataset.contract.coverage.completePartitions].sort())
      || minimumWatermark !== dataset.contract.coverage.watermark) {
      fail('integrity_failed', 'Derived coverage/watermark must equal the proven input intersection/minimum.');
    }
    validateQuality(lineage.checks);
    if (stableAnalyticsJson(lineage.checks) !== stableAnalyticsJson(ingest.quality)) {
      fail('integrity_failed', 'Derived run checks differ from immutable version quality evidence.');
    }
    return { ...lineage, inputs: sortedInputs };
  }

  function publishParsedSource(ingest: AnalyticsParsedSourceIngest): AnalyticsVersionPromotionReceipt {
    const dataset = getDataset(ingest.datasetId);
    if (!dataset) fail('not_found', `Dataset ${ingest.datasetId} was not found.`);
    if (dataset.lifecycle !== 'active' || dataset.contract.status !== 'active') {
      fail('conflict', `Dataset ${dataset.id} is not active.`);
    }
    const derivation = validateDerivationLineage(dataset, ingest);
    if (ingest.sourceFormat !== dataset.sourceFormat
      || ingest.sourceReceipt.sourceKind !== dataset.sourceKind) {
      fail('invalid_input', 'Acquired source kind or format differs from the dataset definition.');
    }
    if (!isAnalyticsIsoTimestamp(ingest.materializedAt)
      || !isAnalyticsIsoTimestamp(ingest.sourceReceipt.acquiredAt)
      || !ingest.sourceReceipt.producerVersion
      || (ingest.sourceReceipt.sourceId !== undefined && !String(ingest.sourceReceipt.sourceId).trim())
      || (ingest.sourceReceipt.querySha256 !== undefined && !SHA256_RE.test(ingest.sourceReceipt.querySha256))
      || (ingest.sourceReceipt.submittedAgain !== undefined && typeof ingest.sourceReceipt.submittedAgain !== 'boolean')) {
      fail('invalid_input', 'Acquisition source receipt is malformed.');
    }
    if (!Number.isInteger(ingest.expectedHeadRevision) || ingest.expectedHeadRevision < 0) {
      fail('invalid_input', 'expectedHeadRevision must be a non-negative integer.');
    }
    validateQuality(ingest.quality);
    validateRows(ingest.columns, ingest.rows, dataset.contract);
    validateObservedCoverage(ingest.rows, dataset.contract);
    const sourceBytes = Buffer.from(ingest.sourceBytes);
    const sourceSha256 = sha256Bytes(sourceBytes);
    const observed = observedSchema(dataset.contract);
    const observedSchemaSha256 = analyticsDatasetSchemaSha256(observed);
    const versionKeySha256 = analyticsSha256({
      datasetId: dataset.id,
      sourceSha256,
      contractSha256: dataset.contractSha256,
      definitionSha256: dataset.definitionSha256,
      observedSchemaSha256,
      coverage: dataset.contract.coverage,
      quality: ingest.quality,
      sourceFormat: ingest.sourceFormat,
      ...(derivation ? {
        transformSha256: derivation.transformSha256,
        inputSetSha256: derivation.inputSetSha256,
        materializationKeySha256: derivation.materializationKeySha256,
        inputs: derivation.inputs,
      } : {}),
    });
    const versionId = `dsv_${versionKeySha256.slice(0, 24)}`;
    const requestSha256 = ingest.requestSha256?.toLowerCase() ?? analyticsSha256({
      datasetId: dataset.id,
      versionKeySha256,
    });
    if (!SHA256_RE.test(requestSha256)) fail('invalid_input', 'requestSha256 is malformed.');
    const run = createRun(dataset, ingest, requestSha256);
    const existing = db.prepare(`
      SELECT * FROM analytics_dataset_versions
      WHERE dataset_id = ? AND version_key_sha256 = ?
    `).get(dataset.id, versionKeySha256) as VersionRow | undefined;
    if (existing) {
      try {
        verifyVersion(existing.id);
        const existingManifest = readAndVerifyManifest(existing);
        return insertVersionAndPromote(
          dataset,
          existingManifest,
          existing.manifest_sha256,
          run.id,
          ingest.expectedHeadRevision,
          true,
        );
      } catch (error) {
        failRun(run.id, error);
        throw error;
      }
    }

    const directories = ensureDatasetDirectories(dataset.id);
    const stagingDirectory = path.join(directories.staging, run.id);
    const versionDirectory = path.join(directories.versions, versionId);
    if (fs.existsSync(versionDirectory)) {
      try {
        const orphan = readVerifiedOrphanManifest(versionDirectory, {
          datasetId: dataset.id,
          versionId,
          versionKeySha256,
          sourceFormat: ingest.sourceFormat,
          sourceSha256,
          rowCount: ingest.rows.length,
          contractSha256: dataset.contractSha256,
          definitionSha256: dataset.definitionSha256,
          quality: ingest.quality,
          ...(derivation ? { derivation } : {}),
        });
        return insertVersionAndPromote(
          dataset,
          orphan.manifest,
          orphan.manifestSha256,
          run.id,
          ingest.expectedHeadRevision,
          true,
        );
      } catch (error) {
        failRun(run.id, error);
        throw error;
      }
    }
    try {
      ensurePrivateDirectory(stagingDirectory);
      db.prepare(`
        UPDATE analytics_dataset_runs
        SET staging_rel_path = ?, heartbeat_at = ?
        WHERE id = ? AND status = 'staging'
      `).run(relative(stagingDirectory), timestamp(), run.id);
      const sourceFileName = ingest.sourceFormat === 'tsv' ? 'source.tsv' : 'source.json';
      const sourcePath = path.join(stagingDirectory, sourceFileName);
      writePrivateFile(sourcePath, sourceBytes);
      const sourceFile: AnalyticsStoredFileReceipt = {
        fileName: sourceFileName,
        sha256: sourceSha256,
        bytes: sourceBytes.length,
      };
      const materializedFile = buildMaterializedDatabase(
        path.join(stagingDirectory, 'materialized.db'),
        observed,
        ingest.rows,
      );
      const ordinal = Number((db.prepare(`
        SELECT COALESCE(MAX(ordinal), 0) + 1 AS ordinal
        FROM analytics_dataset_versions WHERE dataset_id = ?
      `).get(dataset.id) as { ordinal: number }).ordinal);
      const createdAt = timestamp();
      const manifest: AnalyticsDatasetVersionManifest = {
        manifestVersion: derivation ? 2 : 1,
        datasetId: dataset.id,
        versionId,
        ordinal,
        versionKeySha256,
        sourceFormat: ingest.sourceFormat,
        sourceFile,
        materializedFile,
        rowCount: ingest.rows.length,
        observedSchema: observed,
        observedSchemaSha256,
        contract: dataset.contract,
        contractSha256: dataset.contractSha256,
        coverage: dataset.contract.coverage,
        definitionSha256: dataset.definitionSha256,
        sourceReceipt: ingest.sourceReceipt,
        handling: dataset.contract.handling,
        quality: ingest.quality,
        materializedAt: ingest.materializedAt,
        reacquirable: dataset.retention.reacquirable,
        createdAt,
        ...(derivation ? { derivation } : {}),
      };
      const manifestBytes = Buffer.from(`${stableAnalyticsJson(manifest)}\n`, 'utf8');
      const manifestSha256 = sha256Bytes(manifestBytes);
      writePrivateFile(path.join(stagingDirectory, 'manifest.json'), manifestBytes);
      syncDirectory(stagingDirectory);
      db.prepare(`
        UPDATE analytics_dataset_runs
        SET status = 'verifying', heartbeat_at = ?
        WHERE id = ? AND status = 'staging'
      `).run(timestamp(), run.id);
      if (fs.existsSync(versionDirectory)) {
        removeDirectoryBestEffort(stagingDirectory);
        fail('conflict', `Immutable version directory ${versionId} already exists without catalog metadata.`);
      }
      fs.renameSync(stagingDirectory, versionDirectory);
      fs.chmodSync(versionDirectory, PRIVATE_DIRECTORY_MODE);
      syncDirectory(directories.versions);
      const promoted = readVerifiedOrphanManifest(versionDirectory, {
        datasetId: dataset.id,
        versionId,
        versionKeySha256,
        sourceFormat: ingest.sourceFormat,
        sourceSha256,
        rowCount: ingest.rows.length,
        contractSha256: dataset.contractSha256,
        definitionSha256: dataset.definitionSha256,
        quality: ingest.quality,
        ...(derivation ? { derivation } : {}),
      });
      if (promoted.manifestSha256 !== manifestSha256) {
        fail('integrity_failed', 'Promoted manifest SHA changed after the atomic rename.');
      }
      return insertVersionAndPromote(
        dataset,
        promoted.manifest,
        promoted.manifestSha256,
        run.id,
        ingest.expectedHeadRevision,
        false,
      );
    } catch (error) {
      failRun(run.id, error);
      if (fs.existsSync(stagingDirectory)) removeDirectoryBestEffort(stagingDirectory);
      throw error;
    }
  }

  function getRun(runId: string): AnalyticsDatasetRunRecord | null {
    if (!RUN_ID_RE.test(runId)) fail('invalid_input', 'Run ID is malformed.');
    const row = db.prepare('SELECT * FROM analytics_dataset_runs WHERE id = ?').get(runId) as RunRow | undefined;
    return row ? rowToRun(row) : null;
  }

  function recoverStaleRuns(): number {
    const cutoff = timestamp();
    const rows = db.prepare(`
      SELECT * FROM analytics_dataset_runs
      WHERE status IN ('staging','verifying')
        AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
      ORDER BY queued_at, id
    `).all(cutoff) as RunRow[];
    for (const row of rows) {
      db.prepare(`
        UPDATE analytics_dataset_runs
        SET status = 'failed', error = ?, lease_owner = NULL,
            lease_expires_at = NULL, heartbeat_at = ?, completed_at = ?
        WHERE id = ? AND status IN ('staging','verifying')
      `).run('Interrupted acquisition recovered at startup; submit a new owner-requested acquisition.', cutoff, cutoff, row.id);
      if (row.staging_rel_path) {
        try {
          removeDirectoryBestEffort(resolveRelative(row.staging_rel_path));
        } catch {
          // Invalid persisted paths are never followed outside the private root.
        }
      }
    }
    return rows.length;
  }

  function versionDeletionEligibility(versionId: string, explicitApproval = false): AnalyticsVersionDeletionEligibility {
    const row = getVersionRow(versionId);
    if (!row) fail('not_found', `Version ${versionId} was not found.`);
    const reasons: string[] = [];
    const head = db.prepare('SELECT 1 FROM analytics_dataset_heads WHERE version_id = ?').get(versionId);
    if (head) reasons.push('current_head');
    const derivedVersionReference = db.prepare(`
      SELECT 1 FROM analytics_dataset_version_inputs WHERE input_version_id = ? LIMIT 1
    `).get(versionId);
    if (derivedVersionReference) reasons.push('referenced_by_derived_version');
    const derivedRunReference = db.prepare(`
      SELECT 1
      FROM analytics_derived_run_inputs input
      JOIN analytics_derived_runs run ON run.id = input.run_id
      WHERE input.input_version_id = ? AND run.status IN ('queued','running')
      LIMIT 1
    `).get(versionId);
    if (derivedRunReference) reasons.push('pinned_by_derived_run');
    const jobReference = db.prepare(`
      SELECT 1 FROM analytics_job_nodes WHERE output_version_id = ? LIMIT 1
    `).get(versionId);
    if (jobReference) reasons.push('referenced_by_analytics_job');
    const resultReference = db.prepare(`
      SELECT 1 FROM analytics_job_results WHERE primary_version_id = ? LIMIT 1
    `).get(versionId);
    if (resultReference) reasons.push('referenced_by_analytics_result');
    const widgetBindingReference = db.prepare(`
      SELECT 1 FROM analytics_widget_dataset_bindings
      WHERE pinned_version_id = ? OR last_queued_version_id = ? OR last_applied_version_id = ?
      LIMIT 1
    `).get(versionId, versionId, versionId);
    if (widgetBindingReference) reasons.push('referenced_by_widget_binding');
    const dashboardRunReference = db.prepare(`
      SELECT 1 FROM analytics_run_widget_data_room_snapshots
      WHERE version_id = ? OR candidate_version_id = ? LIMIT 1
    `).get(versionId, versionId);
    if (dashboardRunReference) reasons.push('pinned_by_dashboard_run');
    const dataset = getDataset(row.dataset_id)!;
    const count = Number((db.prepare('SELECT COUNT(*) AS count FROM analytics_dataset_versions WHERE dataset_id = ?').get(row.dataset_id) as { count: number }).count);
    if (count <= dataset.retention.minimumVersions) reasons.push('minimum_versions');
    if (!row.reacquirable && !explicitApproval) {
      const backup = db.prepare(`
        SELECT 1 FROM analytics_dataset_backup_versions bv
        JOIN analytics_dataset_backups b ON b.id = bv.backup_id
        WHERE bv.version_id = ? AND b.status = 'verified'
        LIMIT 1
      `).get(versionId);
      if (!backup) reasons.push('verified_backup_required');
    }
    return { allowed: reasons.length === 0, reasons };
  }

  return {
    rootDir,
    registerDataset,
    setCatalogVisibility,
    reviseDataset,
    listDependencies,
    isDerivedDatasetDirty,
    listDatasets,
    listAllDatasets,
    searchDatasets,
    findDatasetsForRequest,
    getDataset,
    listDatasetVersions,
    getDatasetVersion,
    listCatalogDatasets,
    getCatalogDataset,
    listCatalogDatasetVersions,
    getCatalogDatasetVersion,
    publishParsedSource,
    verifyVersion,
    getVerifiedMaterializedPath,
    getHead,
    getRun,
    recoverStaleRuns,
    versionDeletionEligibility,
  };
}
