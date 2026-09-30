import type Database from 'better-sqlite3';
import SqliteDatabase from 'better-sqlite3';
import {
  analyticsCoveragePartition,
  analyticsDatasetContractSha256,
  analyticsDatasetSchemaSha256,
  AnalyticsDataRoomError,
  isAnalyticsIsoTimestamp,
  type AnalyticsDataRoomStore,
} from './analytics-data-room-store.js';
import {
  ANALYTICS_LOCAL_FILE_FORMATS,
  ANALYTICS_LOCAL_FILE_PARSER_VERSION,
  AnalyticsLocalFileError,
  defaultAnalyticsLocalFilePolicy,
  profileAnalyticsLocalTable,
  readAnalyticsLocalFile,
  readAnalyticsLocalTable,
  resolveAnalyticsLocalFile,
  typeAnalyticsLocalTable,
  type AnalyticsLocalFileColumnProfile,
  type AnalyticsLocalFileFormat,
  type AnalyticsLocalFileLocator,
  type AnalyticsLocalFilePolicy,
} from './analytics-local-file-source.js';
import type { DocumentParser } from './document-parser.js';
import type { AnalyticsDerivationService } from './analytics-data-room-derivation.js';
import {
  parseAnalyticsDerivedDefinition,
  validateAnalyticsRelationalContract,
} from './analytics-data-room-derived-contract.js';
import type { AnalyticsLocalQueryEngine } from './analytics-data-room-query.js';
import type { AnalyticsDataRoomService, AnalyticsLocalFileCompleteReceipt } from './analytics-data-room-service.js';
import type { QueryRunner, QueryRunResult } from './etl-adhoc.js';
import {
  AnalyticsSqlExportError,
  SQL_EXPORT_PRODUCER_VERSION,
  type AnalyticsPreparationSqlRunner,
  type AnalyticsSqlExport,
  type AnalyticsSqlExportErrorCode,
} from './analytics-sql-export.js';
import {
  analyticsHandlingAllowsModelContext,
  analyticsRequestSha256,
  analyticsSha256,
  AnalyticsDataRoomContractError,
  compactAnalyticsPartitionRanges,
  enumerateAnalyticsPartitions,
  normalizeAnalyticsRequest,
  stableAnalyticsJson,
  type AnalyticsModelContextRuntime,
} from './analytics-data-room-policy.js';
import {
  dataRoomIssue,
  prefixDataRoomIssues,
  type DataRoomFailureIssueV1,
} from './data-room-tool-failure.js';
import type {
  AnalyticsDataCell,
  AnalyticsDataRoomUse,
  AnalyticsDatasetContract,
  AnalyticsDatasetDefinitionInput,
  AnalyticsDatasetDetail,
  AnalyticsDatasetRetentionPolicy,
  AnalyticsDatasetVersionDetail,
  AnalyticsDerivedDefinitionV1,
  AnalyticsHandlingContract,
  AnalyticsRequest,
} from './analytics-data-room-types.js';
import type { AnalyticsJobPlanner } from './analytics-job-planner.js';
import { AnalyticsJobError } from './analytics-job-store.js';
import type {
  AnalyticsLocalFileAdmissionV1,
  AnalyticsDatasetPreparationIntentV1,
  AnalyticsDatasetPreparationPlanV1,
  AnalyticsDatasetPreparationSourceV1,
  AnalyticsDatasetPreparationTargetV1,
  AnalyticsJobCompletionReceipt,
  AnalyticsJobConsumer,
  AnalyticsJobExistingInputV1,
  AnalyticsJobFragmentContractV1,
  AnalyticsJobFragmentV1,
  AnalyticsJobIntent,
  AnalyticsJobIntentV1,
  AnalyticsJobNodeRecord,
  AnalyticsJobObservation,
  AnalyticsJobOwnerRequest,
  AnalyticsJobPlanV1,
  AnalyticsJobRecord,
  AnalyticsJobResultManifestV1,
  AnalyticsJobResultRecord,
  AnalyticsJobStore,
  AnalyticsJobToolReceipt,
} from './analytics-job-types.js';

const JOB_ID_RE = /^aj_[a-f0-9]{32}$/;
const DATASET_ID_RE = /^ds_[a-zA-Z0-9_-]{1,96}$/;
const VERSION_ID_RE = /^dsv_[a-f0-9]{24}$/;
const IMPORT_ID_RE = /^dri_[a-f0-9]{24}$/;
const SHA256_RE = /^[a-f0-9]{64}$/;
const PREPARATION_SOURCE_KINDS = ['existing_version', 'import_inbox', 'local_file', 'sql_query', 'etl_query'];
const SOURCE_ALIAS_RE = /^[A-Za-z][A-Za-z0-9_]{0,31}$/;
const DEFAULT_WAIT_MS = 24_000;
/** Upper bound of one foreground wait for a job outcome; tool budgets must exceed it. */
export const ANALYTICS_JOB_MAX_FOREGROUND_WAIT_MS = 30_000;
const JOB_RESULT_LIMIT = 200;
const RETENTION: AnalyticsDatasetRetentionPolicy = {
  minimumVersions: 1,
  automaticExpiry: false,
  reacquirable: true,
  backupRequired: false,
};

const CLASSIFICATION_RANK = new Map([
  ['public', 0],
  ['internal', 1],
  ['confidential', 2],
  ['highly_confidential', 3],
  ['restricted', 4],
  ['critical', 5],
]);

export type { AnalyticsPreparationSqlRunner } from './analytics-sql-export.js';

/** Export failures map onto job codes; each carries its own next action. */
const SQL_EXPORT_JOB_CODES: Record<AnalyticsSqlExportErrorCode, ConstructorParameters<typeof AnalyticsJobError>[0]> = {
  connector_outdated: 'unsupported',
  unavailable: 'conflict',
  query_failed: 'invalid_input',
  too_large: 'invalid_input',
  integrity_failed: 'integrity_failed',
};

/** Zero-effect profile of one local file table, from the exact create-time reader and cell converter. */
export interface AnalyticsLocalFileInspection {
  file: { name: string; format: AnalyticsLocalFileFormat; bytes: number; sha256: string };
  sheets?: string[];
  sheet?: string;
  headerRow?: number;
  nullToken: string;
  rowCount: number;
  blankRowsSkipped: number;
  rowsAboveHeader: number;
  formulaCells: number;
  /** Delimited records that omitted trailing fields; those cells read as null. */
  shortRows: number;
  samplesWithheld: boolean;
  columns: AnalyticsLocalFileColumnProfile[];
}

export interface AnalyticsJobService {
  startOrJoinAndWait(owner: AnalyticsJobOwnerRequest, options?: { waitSignal?: AbortSignal }): Promise<AnalyticsJobToolReceipt>;
  prepareOrJoinAndWait(owner: AnalyticsJobOwnerRequest, plan: AnalyticsDatasetPreparationPlanV1, options?: { waitSignal?: AbortSignal }): Promise<AnalyticsJobToolReceipt>;
  inspectLocalFile(locator: AnalyticsLocalFileLocator, options?: { signal?: AbortSignal }): Promise<AnalyticsLocalFileInspection>;
  observe(jobId: string, actionRequestId?: string, options?: { includeAnswer?: boolean }): AnalyticsJobToolReceipt;
  resume(jobId: string, owner: AnalyticsJobOwnerRequest, options?: { waitSignal?: AbortSignal }): Promise<AnalyticsJobToolReceipt>;
  respond(jobId: string, response: string, owner: AnalyticsJobOwnerRequest, options?: { waitSignal?: AbortSignal }): Promise<AnalyticsJobToolReceipt>;
  cancel(jobId: string, owner: AnalyticsJobOwnerRequest): AnalyticsJobToolReceipt;
  processNext(): Promise<number>;
  start(): void;
  stop(): void;
  drain(): Promise<void>;
  wake(): void;
  activeWork(): ReturnType<AnalyticsJobStore['activeWork']>;
}

function fail(
  code: ConstructorParameters<typeof AnalyticsJobError>[0],
  message: string,
  issues: DataRoomFailureIssueV1 | DataRoomFailureIssueV1[] = [],
): never {
  const list = Array.isArray(issues) ? issues : [issues];
  throw Object.assign(new AnalyticsJobError(code, message), { issues: list.slice(0, 8) });
}

/** Fail with recovery guidance specific to this failure; errorProjection keeps it verbatim. */
function failWithNextAction(
  code: ConstructorParameters<typeof AnalyticsJobError>[0],
  message: string,
  nextAction: string,
): never {
  throw Object.assign(new AnalyticsJobError(code, message), { issues: [], nextAction: nextAction.slice(0, 1000) });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function cleanText(value: unknown, field: string, maximum = 20_000): string {
  if (typeof value !== 'string') {
    fail('invalid_input', `${field} must be a non-empty string.`, dataRoomIssue({
      code: 'invalid_type', path: field, message: `${field} must be a non-empty string.`,
      expected: { kind: 'range', type: 'string', minimum: 1, maximum }, received: value,
    }));
  }
  if (!value.trim() || value.includes('\0')) {
    fail('invalid_input', `${field} must be a non-empty string without NUL.`, dataRoomIssue({
      code: value.includes('\0') ? 'nul_not_allowed' : 'required', path: field,
      message: value.includes('\0') ? `${field} cannot contain NUL.` : `${field} is required.`,
      expected: { kind: 'range', type: 'string', minimum: 1, maximum }, received: value,
    }));
  }
  const output = value.trim();
  if (output.length > maximum) {
    fail('invalid_input', `${field} exceeds ${maximum} characters.`, dataRoomIssue({
      code: 'too_long', path: field, message: `${field} exceeds ${maximum} characters.`,
      expected: { kind: 'range', type: 'string', minimum: 1, maximum }, received: value,
    }));
  }
  return output;
}

function ownerMessageContainsChoice(message: string, choice: string): boolean {
  const normalizedMessage = message.toLowerCase().replace(/\s+/g, ' ').trim();
  const normalizedChoice = choice.toLowerCase().replace(/\s+/g, ' ').trim();
  if (!normalizedChoice) return false;
  const escaped = normalizedChoice.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[^a-z0-9_])${escaped}(?:$|[^a-z0-9_])`, 'i').test(normalizedMessage);
}

function currentPlanNodes(observation: AnalyticsJobObservation): AnalyticsJobNodeRecord[] {
  return observation.nodes.filter(node => node.planRevision === observation.job.planRevision);
}

function sourceNodeKey(alias: string): string {
  return `source:${alias}`;
}

function fragmentNodeKey(fragmentId: string): string {
  return `fragment:${fragmentId}`;
}

function nodeKey(node: AnalyticsJobNodeRecord): string {
  const key = node.spec.nodeKey;
  if (typeof key !== 'string' || !key) fail('integrity_failed', `Analytics node ${node.id} lost its canonical key.`);
  return key;
}

function normalizedIntent(owner: AnalyticsJobOwnerRequest): AnalyticsJobIntentV1 {
  const message = cleanText(owner.message, 'owner message');
  return {
    version: 1,
    goal: message,
    ownerMessageSha256: analyticsSha256(message),
    consumers: [],
  };
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const extras = Object.keys(value).filter(key => !allowed.includes(key)).sort();
  if (!extras.length) return;
  fail(
    'invalid_input',
    `${label} contains unsupported field(s): ${extras.join(', ')}.`,
    extras.map(key => dataRoomIssue({
      code: 'unsupported_field',
      path: `${label}.${key}`,
      message: `${key} is not allowed at ${label}. Use only the advertised fully specified schema.`,
      expected: { kind: 'absent' },
      received: value[key],
    })),
  );
}

export interface AnalyticsPreparationSemanticIdentityReceiptV1 {
  canonicalization: 'stable-key-sorted-json-sha256-v1';
  metric: AnalyticsRequest['metric'];
  regime: AnalyticsRequest['regime'];
  definitionsSha256: string;
  receiptSha256: string;
}

/**
 * Computes the exact request identities for model-authored fresh-source
 * semantics. This is deliberately narrower than a generic hash capability:
 * callers provide both complete definitions, and the receipt never authors or
 * inserts any preparation-plan field.
 */
export function derivePreparationSemanticIdentities(
  metricValue: unknown,
  regimeValue: unknown,
): AnalyticsPreparationSemanticIdentityReceiptV1 {
  if (!isRecord(metricValue)) {
    fail('invalid_input', 'metric must be one semantic-definition object.', dataRoomIssue({
      code: 'invalid_type', path: 'metric', message: 'metric must define id, version, unit, and definition.',
      expected: { kind: 'shape', requiredKeys: ['id', 'version', 'unit', 'definition'], allowedKeys: ['id', 'version', 'unit', 'definition'] },
      received: metricValue,
    }));
  }
  exactKeys(metricValue, ['id', 'version', 'unit', 'definition'], 'metric');
  if (!isRecord(regimeValue)) {
    fail('invalid_input', 'regime must be one semantic-definition object.', dataRoomIssue({
      code: 'invalid_type', path: 'regime', message: 'regime must define id, version, and definition.',
      expected: { kind: 'shape', requiredKeys: ['id', 'version', 'definition'], allowedKeys: ['id', 'version', 'definition'] },
      received: regimeValue,
    }));
  }
  exactKeys(regimeValue, ['id', 'version', 'definition'], 'regime');
  const metricDefinition = {
    id: cleanText(metricValue.id, 'metric.id', 160),
    version: cleanText(metricValue.version, 'metric.version', 80),
    unit: cleanText(metricValue.unit, 'metric.unit', 160),
    definition: cleanText(metricValue.definition, 'metric.definition', 4000),
  };
  const regimeDefinition = {
    id: cleanText(regimeValue.id, 'regime.id', 160),
    version: cleanText(regimeValue.version, 'regime.version', 80),
    definition: cleanText(regimeValue.definition, 'regime.definition', 4000),
  };
  const metric: AnalyticsRequest['metric'] = {
    id: metricDefinition.id,
    version: metricDefinition.version,
    unit: metricDefinition.unit,
    definitionSha256: analyticsSha256(metricDefinition),
  };
  const regime: AnalyticsRequest['regime'] = {
    id: regimeDefinition.id,
    version: regimeDefinition.version,
    definitionSha256: analyticsSha256(regimeDefinition),
  };
  const definitionsSha256 = analyticsSha256({ metric: metricDefinition, regime: regimeDefinition });
  const receipt = {
    canonicalization: 'stable-key-sorted-json-sha256-v1' as const,
    metric,
    regime,
    definitionsSha256,
  };
  return { ...receipt, receiptSha256: analyticsSha256(receipt) };
}

function uniqueTextArray(value: unknown, label: string, maximum = 100): string[] {
  if (!Array.isArray(value)) {
    fail('invalid_input', `${label} must be an array.`, dataRoomIssue({
      code: 'invalid_type', path: label, message: `${label} must be an array of non-empty strings.`,
      expected: { kind: 'range', type: 'array', minimum: 0, maximum }, received: value,
    }));
  }
  if (value.length > maximum) {
    fail('invalid_input', `${label} must contain at most ${maximum} values.`, dataRoomIssue({
      code: 'too_many_items', path: label, message: `${label} must contain at most ${maximum} values.`,
      expected: { kind: 'range', type: 'array', minimum: 0, maximum }, received: value,
    }));
  }
  const values = value.map((item, index) => cleanText(item, `${label}[${index}]`, 160));
  if (new Set(values).size !== values.length) {
    fail('invalid_input', `${label} contains duplicates.`, dataRoomIssue({
      code: 'duplicate_values', path: label, message: `${label} values must be unique.`,
      expected: { kind: 'relation', description: 'Every array value is unique.' }, received: value,
    }));
  }
  return values;
}

type LocalFileSource = Extract<AnalyticsDatasetPreparationSourceV1, { kind: 'local_file' }>;

function normalizeLocalFileSource(raw: Record<string, unknown>, alias: string, sourcePath: string): LocalFileSource {
  exactKeys(raw, ['kind', 'alias', 'path', 'format', 'sheet', 'headerRow', 'nullToken', 'target', 'into'], sourcePath);
  const filePath = cleanText(raw.path, `${sourcePath}.path`, 4096);
  const issues: DataRoomFailureIssueV1[] = [];
  if (raw.format !== undefined && !(ANALYTICS_LOCAL_FILE_FORMATS as readonly unknown[]).includes(raw.format)) issues.push(dataRoomIssue({
    code: 'invalid_enum', path: `${sourcePath}.format`, message: 'format is optional (inferred from .csv/.tsv/.xlsx) and otherwise csv, tsv, or xlsx.',
    expected: { kind: 'enum', values: [...ANALYTICS_LOCAL_FILE_FORMATS] }, received: raw.format, includeReceivedValue: true,
  }));
  if (raw.sheet !== undefined && (typeof raw.sheet !== 'string' || !raw.sheet || raw.sheet.length > 255)) issues.push(dataRoomIssue({
    code: 'invalid_type', path: `${sourcePath}.sheet`, message: 'sheet is the exact worksheet name (xlsx only; optional when the workbook has one sheet).',
    expected: { kind: 'range', type: 'string', minimum: 1, maximum: 255 }, received: raw.sheet, includeReceivedValue: true,
  }));
  if (raw.headerRow !== undefined && (!Number.isSafeInteger(raw.headerRow) || Number(raw.headerRow) < 1 || Number(raw.headerRow) > 50_000)) issues.push(dataRoomIssue({
    code: 'out_of_range', path: `${sourcePath}.headerRow`, message: 'headerRow is the 1-based worksheet row with column names (xlsx only; default 1).',
    expected: { kind: 'range', type: 'integer', minimum: 1, maximum: 50_000 }, received: raw.headerRow, includeReceivedValue: true,
  }));
  if (raw.nullToken !== undefined && (typeof raw.nullToken !== 'string' || raw.nullToken.length > 32 || /["\r\n\0]/.test(raw.nullToken))) issues.push(dataRoomIssue({
    code: 'invalid_null_token', path: `${sourcePath}.nullToken`,
    message: 'nullToken is optional; omit it (empty cells are null) or give the exact ≤32-character text that marks null, such as NULL or \\N.',
    expected: { kind: 'range', type: 'string', minimum: 0, maximum: 32 }, received: raw.nullToken, includeReceivedValue: true,
  }));
  if ((raw.target === undefined) === (raw.into === undefined)) issues.push(dataRoomIssue({
    code: 'exactly_one_required', path: raw.target === undefined ? `${sourcePath}.target` : `${sourcePath}.into`,
    message: 'A local_file source needs exactly one of target (create a new dataset) or into (add a new version to one existing catalog dataset).',
    expected: { kind: 'relation', description: 'Exactly one of target or into is present.' }, received: raw.target ?? raw.into,
  }));
  if (issues.length) fail('invalid_input', `${sourcePath} local file locator is malformed.`, issues);
  const locator = {
    kind: 'local_file' as const,
    alias,
    path: filePath,
    ...(raw.format !== undefined ? { format: raw.format as AnalyticsLocalFileFormat } : {}),
    ...(raw.sheet !== undefined ? { sheet: raw.sheet as string } : {}),
    ...(raw.headerRow !== undefined ? { headerRow: Number(raw.headerRow) } : {}),
    ...(raw.nullToken !== undefined ? { nullToken: raw.nullToken as string } : {}),
  };
  if (raw.target !== undefined) return { ...locator, target: normalizePreparationTarget(raw.target, `${sourcePath}.target`) };
  const intoPath = `${sourcePath}.into`;
  if (!isRecord(raw.into)) {
    fail('invalid_input', `${intoPath} must be an object.`, dataRoomIssue({
      code: 'invalid_type', path: intoPath, message: 'into is {datasetId, mode, coverage[, expectedHeadRevision]}.',
      expected: { kind: 'shape', requiredKeys: ['datasetId', 'mode', 'coverage'], allowedKeys: ['datasetId', 'mode', 'coverage', 'expectedHeadRevision'] }, received: raw.into,
    }));
  }
  const into = raw.into as Record<string, unknown>;
  exactKeys(into, ['datasetId', 'mode', 'coverage', 'expectedHeadRevision'], intoPath);
  const datasetId = cleanText(into.datasetId, `${intoPath}.datasetId`, 100);
  const intoIssues: DataRoomFailureIssueV1[] = [];
  if (!DATASET_ID_RE.test(datasetId)) intoIssues.push(dataRoomIssue({
    code: 'invalid_pattern', path: `${intoPath}.datasetId`, message: 'datasetId is the exact ds_* ID from list_data_room_datasets.',
    expected: { kind: 'pattern', type: 'string', pattern: '^ds_[a-zA-Z0-9_-]{1,96}$' }, received: into.datasetId, includeReceivedValue: true,
  }));
  if (into.mode !== 'replace' && into.mode !== 'merge_partitions') intoIssues.push(dataRoomIssue({
    code: 'invalid_enum', path: `${intoPath}.mode`,
    message: 'mode is replace (the file becomes the complete new version) or merge_partitions (the file replaces only its own time partitions; all other rows stay).',
    expected: { kind: 'enum', values: ['replace', 'merge_partitions'] }, received: into.mode, includeReceivedValue: true,
  }));
  if (into.expectedHeadRevision !== undefined
    && (!Number.isSafeInteger(into.expectedHeadRevision) || Number(into.expectedHeadRevision) < 1)) intoIssues.push(dataRoomIssue({
    code: 'out_of_range', path: `${intoPath}.expectedHeadRevision`, message: 'expectedHeadRevision is optional; when present it is the exact current positive head revision.',
    expected: { kind: 'range', type: 'integer', minimum: 1 }, received: into.expectedHeadRevision, includeReceivedValue: true,
  }));
  if (intoIssues.length) fail('invalid_input', `${intoPath} is malformed.`, intoIssues);
  return {
    ...locator,
    into: {
      datasetId,
      mode: into.mode as 'replace' | 'merge_partitions',
      coverage: normalizePreparationCoverage(into.coverage, `${intoPath}.coverage`),
      ...(into.expectedHeadRevision !== undefined ? { expectedHeadRevision: Number(into.expectedHeadRevision) } : {}),
    },
  };
}

function localFileFailure(error: unknown): never {
  if (error instanceof AnalyticsLocalFileError) fail(error.code, error.message, error.issues);
  throw error;
}

function addPreparationIssue(issues: DataRoomFailureIssueV1[], issue: DataRoomFailureIssueV1): void {
  if (issues.length < 8) issues.push(issue);
}

function collectShapeIssues(
  value: unknown,
  path: string,
  requiredKeys: readonly string[],
  allowedKeys: readonly string[],
  issues: DataRoomFailureIssueV1[],
): value is Record<string, unknown> {
  if (!isRecord(value)) {
    addPreparationIssue(issues, dataRoomIssue({
      code: 'invalid_type', path, message: `${path} must be one object.`,
      expected: { kind: 'shape', requiredKeys: [...requiredKeys], allowedKeys: [...allowedKeys] }, received: value,
    }));
    return false;
  }
  const missing = requiredKeys.filter(key => value[key] === undefined);
  if (missing.length) {
    addPreparationIssue(issues, dataRoomIssue({
      code: 'missing_required_fields', path,
      message: `${path} is missing required field(s): ${missing.join(', ')}.`,
      expected: { kind: 'shape', requiredKeys: [...requiredKeys], allowedKeys: [...allowedKeys] }, received: value,
    }));
  }
  const extras = Object.keys(value).filter(key => !allowedKeys.includes(key)).sort();
  if (extras.length) {
    addPreparationIssue(issues, dataRoomIssue({
      code: 'unsupported_fields', path,
      message: `${path} contains unsupported field(s): ${extras.join(', ')}.`,
      expected: { kind: 'shape', requiredKeys: [...requiredKeys], allowedKeys: [...allowedKeys] }, received: value,
    }));
  }
  return true;
}

const COUNTING_KEY_HINT = 'countingKey is the one field each row counts (in a long table with one row per date and metric, the metric-name field); describe composite row identity in grain/requiredGrain instead.';
const ISO_DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/*
 * The grouped pre-flight below reports the same scalar rules the normalizers
 * enforce (strings, field references, ISO forms) in one wave, so a plan with
 * several independent mistakes is corrected in one call instead of one
 * fail-fast issue per create attempt.
 */
function collectTextIssue(value: unknown, path: string, issues: DataRoomFailureIssueV1[], maximum: number): void {
  if (value === undefined) return;
  if (typeof value !== 'string' || !value.trim() || value.includes('\0') || value.length > maximum) {
    addPreparationIssue(issues, dataRoomIssue({
      code: 'invalid_type', path, message: `${path} must be a non-empty string of at most ${maximum} characters.`,
      expected: { kind: 'range', type: 'string', minimum: 1, maximum }, received: value,
    }));
  }
}

function collectFieldReferenceIssue(
  value: unknown,
  path: string,
  issues: DataRoomFailureIssueV1[],
  fields: Map<string, Record<string, unknown>> | undefined,
  hint: string,
): void {
  if (value === undefined) return;
  if (typeof value !== 'string' || !value.trim()) {
    addPreparationIssue(issues, dataRoomIssue({
      code: 'invalid_field_reference', path,
      message: `${path} must be ONE exact schema field name, not ${Array.isArray(value) ? 'an array' : typeof value}. ${hint}`,
      expected: { kind: 'range', type: 'string', minimum: 1, maximum: 160 }, received: value,
    }));
    return;
  }
  if (fields && !fields.has(value)) {
    addPreparationIssue(issues, dataRoomIssue({
      code: 'unknown_field_reference', path,
      message: `${path} names ${JSON.stringify(value)}, which is not a schema field. Use one of: ${[...fields.keys()].slice(0, 40).join(', ')}. ${hint}`,
      expected: { kind: 'enum', values: [...fields.keys()].slice(0, 40) }, received: value, includeReceivedValue: true,
    }));
  }
}

function collectPreparationRequestIssues(value: unknown, issues: DataRoomFailureIssueV1[]): void {
  const path = 'plan.request';
  const required = [
    'domainKey', 'metric', 'dimensions', 'filters', 'dateRange', 'timeZone', 'countingKey',
    'regime', 'requiredGrain', 'freshness', 'use',
  ];
  const allowed = [
    ...required, 'datasetId', 'versionId', 'resultLimit', 'requiredContractSha256', 'unresolvedSemantics',
  ];
  if (!collectShapeIssues(value, path, required, allowed, issues)) return;
  if (value.metric !== undefined) collectShapeIssues(value.metric, `${path}.metric`, ['id', 'version', 'unit', 'definitionSha256'], ['id', 'version', 'unit', 'definitionSha256'], issues);
  if (value.regime !== undefined) collectShapeIssues(value.regime, `${path}.regime`, ['id', 'version', 'definitionSha256'], ['id', 'version', 'definitionSha256'], issues);
  if (value.dateRange !== undefined) collectShapeIssues(value.dateRange, `${path}.dateRange`, ['start', 'end'], ['start', 'end'], issues);
  if (value.freshness !== undefined) collectShapeIssues(value.freshness, `${path}.freshness`, ['mode'], ['mode', 'maxAgeMs'], issues);
  if (value.dimensions !== undefined && !Array.isArray(value.dimensions)) {
    addPreparationIssue(issues, dataRoomIssue({
      code: 'invalid_type', path: `${path}.dimensions`, message: 'dimensions must be an array; use [] when no dimensions apply.',
      expected: { kind: 'type', type: 'array' }, received: value.dimensions,
    }));
  }
  if (value.filters !== undefined && !Array.isArray(value.filters)) {
    addPreparationIssue(issues, dataRoomIssue({
      code: 'invalid_type', path: `${path}.filters`, message: 'filters must be an array; use [] when no filters apply.',
      expected: { kind: 'type', type: 'array' }, received: value.filters,
    }));
  }
  if (value.use !== undefined && value.use !== 'local_answer') {
    addPreparationIssue(issues, dataRoomIssue({
      code: 'invalid_literal', path: `${path}.use`,
      message: 'Dataset preparation request.use must be local_answer; dashboards consume the ready version later through their separate capability.',
      expected: { kind: 'literal', value: 'local_answer' }, received: value.use, includeReceivedValue: true,
    }));
  }
  collectTextIssue(value.domainKey, `${path}.domainKey`, issues, 160);
  collectTextIssue(value.timeZone, `${path}.timeZone`, issues, 160);
  collectTextIssue(value.requiredGrain, `${path}.requiredGrain`, issues, 160);
  collectFieldReferenceIssue(value.countingKey, `${path}.countingKey`, issues, undefined, COUNTING_KEY_HINT);
  if (Array.isArray(value.dimensions) && value.dimensions.some(dimension => typeof dimension !== 'string' || !dimension.trim())) {
    addPreparationIssue(issues, dataRoomIssue({
      code: 'invalid_type', path: `${path}.dimensions`, message: 'Every request dimension must be one exact field-name string.',
      expected: { kind: 'type', type: 'array' }, received: value.dimensions,
    }));
  }
  if (isRecord(value.dateRange)) {
    for (const edge of ['start', 'end'] as const) {
      const day = value.dateRange[edge];
      if (day !== undefined && (typeof day !== 'string' || !ISO_DAY_RE.test(day))) addPreparationIssue(issues, dataRoomIssue({
        code: 'invalid_date_format', path: `${path}.dateRange.${edge}`, message: `dateRange.${edge} must use the exact YYYY-MM-DD form.`,
        expected: { kind: 'pattern', type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', example: '2026-09-25' }, received: day, includeReceivedValue: true,
      }));
    }
  }
}

function collectCoverageIssues(value: unknown, path: string, issues: DataRoomFailureIssueV1[]): void {
  if (!isRecord(value)) {
    addPreparationIssue(issues, dataRoomIssue({
      code: 'invalid_type', path, message: `${path} must use one explicit-partition or compact-range coverage object.`,
      expected: { kind: 'type', type: 'object' }, received: value,
    }));
    return;
  }
  const explicit = value.completePartitions !== undefined || value.observedPartitions !== undefined;
  const compact = value.completeRanges !== undefined || value.observedRanges !== undefined;
  if (explicit === compact) {
    addPreparationIssue(issues, dataRoomIssue({
      code: explicit ? 'mixed_coverage_forms' : 'coverage_form_required', path,
      message: explicit
        ? 'Coverage must not mix explicit partitions with compact ranges.'
        : 'Coverage must provide completePartitions/observedPartitions or completeRanges/observedRanges.',
      expected: { kind: 'relation', description: 'Use exactly one advertised coverage form.' }, received: value,
    }));
    return;
  }
  const required = explicit
    ? ['partitionKind', 'completePartitions', 'watermark']
    : ['partitionKind', 'observedRanges', 'completeRanges', 'watermark'];
  const allowed = explicit
    ? ['partitionKind', 'observedPartitions', 'completePartitions', 'watermark']
    : ['partitionKind', 'observedRanges', 'completeRanges', 'watermark'];
  collectShapeIssues(value, path, required, allowed, issues);
  if (value.watermark !== undefined && (typeof value.watermark !== 'string' || !isAnalyticsIsoTimestamp(value.watermark))) {
    addPreparationIssue(issues, dataRoomIssue({
      code: 'invalid_timestamp', path: `${path}.watermark`,
      message: 'watermark must be an exact ISO timestamp with timezone (a date alone is not enough): the instant through which the source evidence is current.',
      expected: { kind: 'pattern', type: 'string', pattern: '^YYYY-MM-DDTHH:mm:ss(.fraction)?(Z|±HH:mm)$', example: '2026-09-25T23:59:59+05:30' },
      received: value.watermark, includeReceivedValue: true,
    }));
  }
  if (value.partitionKind !== undefined && value.partitionKind !== 'day' && value.partitionKind !== 'month') {
    addPreparationIssue(issues, dataRoomIssue({
      code: 'invalid_enum', path: `${path}.partitionKind`, message: 'partitionKind must be day or month.',
      expected: { kind: 'enum', values: ['day', 'month'] }, received: value.partitionKind, includeReceivedValue: true,
    }));
  }
  for (const field of explicit ? ['completePartitions', 'observedPartitions'] : ['completeRanges', 'observedRanges']) {
    if (value[field] !== undefined && !Array.isArray(value[field])) {
      addPreparationIssue(issues, dataRoomIssue({
        code: 'invalid_type', path: `${path}.${field}`, message: `${field} must be an array.`,
        expected: { kind: 'type', type: 'array' }, received: value[field],
      }));
    }
  }
  if (compact) {
    for (const field of ['completeRanges', 'observedRanges']) {
      if (!Array.isArray(value[field])) continue;
      const malformed = value[field].map((range, index) => ({ range, index })).filter(({ range }) => (
        !isRecord(range) || range.start === undefined || range.end === undefined
        || Object.keys(range).some(key => key !== 'start' && key !== 'end')
      )).map(({ index }) => index);
      if (malformed.length) {
        addPreparationIssue(issues, dataRoomIssue({
          code: 'invalid_range_shape', path: `${path}.${field}`,
          message: `${field} entries at indices ${malformed.join(', ')} must contain exactly start and end.`,
          expected: { kind: 'shape', requiredKeys: ['start', 'end'], allowedKeys: ['start', 'end'] }, received: value[field],
        }));
      }
      const badDays = (value[field] as unknown[]).map((range, index) => ({ range, index }))
        .filter(({ range }) => isRecord(range) && [range.start, range.end].some(day => day !== undefined && (typeof day !== 'string' || !ISO_DAY_RE.test(day))))
        .map(({ index }) => index);
      if (badDays.length) {
        addPreparationIssue(issues, dataRoomIssue({
          code: 'invalid_date_format', path: `${path}.${field}`,
          message: `${field} entries at indices ${badDays.join(', ')} must use YYYY-MM-DD start/end days (month coverage uses YYYY-MM-01).`,
          expected: { kind: 'pattern', type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', example: '2026-09-25' }, received: value[field],
        }));
      }
    }
  }
}

function collectAnswerIssues(value: unknown, path: string, issues: DataRoomFailureIssueV1[]): void {
  const required = ['version', 'metricId', 'metricValueColumn', 'rowDimensions', 'filterableFields', 'stableOrder'];
  if (!collectShapeIssues(value, path, required, required, issues)) return;
  if (value.version !== undefined && value.version !== 1) {
    addPreparationIssue(issues, dataRoomIssue({
      code: 'invalid_literal', path: `${path}.version`, message: 'answer.version must be the JSON number 1.',
      expected: { kind: 'literal', value: 1 }, received: value.version, includeReceivedValue: true,
    }));
  }
  for (const field of ['rowDimensions', 'filterableFields', 'stableOrder']) {
    if (value[field] !== undefined && !Array.isArray(value[field])) {
      addPreparationIssue(issues, dataRoomIssue({
        code: 'invalid_type', path: `${path}.${field}`, message: `${field} must be an array.`,
        expected: { kind: 'type', type: 'array' }, received: value[field],
      }));
    }
  }
  collectTextIssue(value.metricId, `${path}.metricId`, issues, 160);
  collectTextIssue(value.metricValueColumn, `${path}.metricValueColumn`, issues, 160);
  for (const field of ['rowDimensions', 'filterableFields']) {
    if (Array.isArray(value[field]) && (value[field] as unknown[]).some(item => typeof item !== 'string' || !item.trim())) {
      addPreparationIssue(issues, dataRoomIssue({
        code: 'invalid_type', path: `${path}.${field}`, message: `Every ${field} entry must be one exact field-name string.`,
        expected: { kind: 'type', type: 'array' }, received: value[field],
      }));
    }
  }
  if (Array.isArray(value.stableOrder)) {
    const malformed = value.stableOrder.map((entry, index) => ({ entry, index })).filter(({ entry }) => (
      !isRecord(entry) || typeof entry.field !== 'string' || (entry.direction !== 'asc' && entry.direction !== 'desc')
      || Object.keys(entry).some(key => key !== 'field' && key !== 'direction')
    )).map(({ index }) => index);
    if (malformed.length) addPreparationIssue(issues, dataRoomIssue({
      code: 'invalid_stable_order', path: `${path}.stableOrder`,
      message: `stableOrder entries at indices ${malformed.join(', ')} must each be {field:"schema field", direction:"asc"|"desc"}, not a bare field name.`,
      expected: { kind: 'shape', requiredKeys: ['field', 'direction'], allowedKeys: ['field', 'direction'] }, received: value.stableOrder,
    }));
  }
}

function collectTargetIssues(value: unknown, path: string, issues: DataRoomFailureIssueV1[]): void {
  const required = [
    'name', 'description', 'domainKey', 'schema', 'metric', 'regime', 'countingKey', 'grain',
    'availableDimensions', 'timeField', 'timeZone', 'coverage', 'answer',
  ];
  const allowed = [
    'datasetId', 'expectedHeadRevision', ...required, 'relational', 'classification',
    'allowPublication', 'retention', 'quality',
  ];
  if (!collectShapeIssues(value, path, required, allowed, issues)) return;
  if (value.metric !== undefined) collectShapeIssues(value.metric, `${path}.metric`, ['id', 'version', 'unit', 'definition'], ['id', 'version', 'unit', 'definition'], issues);
  if (value.regime !== undefined) collectShapeIssues(value.regime, `${path}.regime`, ['id', 'version', 'definition'], ['id', 'version', 'definition'], issues);
  if (value.coverage !== undefined) collectCoverageIssues(value.coverage, `${path}.coverage`, issues);
  if (value.answer !== undefined) collectAnswerIssues(value.answer, `${path}.answer`, issues);
  if (value.availableDimensions !== undefined && !Array.isArray(value.availableDimensions)) {
    addPreparationIssue(issues, dataRoomIssue({
      code: 'invalid_type', path: `${path}.availableDimensions`, message: 'availableDimensions must be an array.',
      expected: { kind: 'type', type: 'array' }, received: value.availableDimensions,
    }));
  }
  for (const [field, maximum] of [['name', 300], ['description', 4000], ['domainKey', 160], ['grain', 160], ['timeZone', 160]] as const) {
    collectTextIssue(value[field], `${path}.${field}`, issues, maximum);
  }
  const fields = Array.isArray(value.schema)
    ? new Map(value.schema.filter(isRecord).filter(field => typeof field.name === 'string').map(field => [field.name as string, field]))
    : undefined;
  collectFieldReferenceIssue(value.countingKey, `${path}.countingKey`, issues, fields, COUNTING_KEY_HINT);
  collectFieldReferenceIssue(value.timeField, `${path}.timeField`, issues, fields, 'timeField is the one non-nullable date or timestamp column.');
  const timeField = typeof value.timeField === 'string' ? fields?.get(value.timeField) : undefined;
  if (timeField && ((timeField.logicalType !== 'date' && timeField.logicalType !== 'timestamp') || timeField.nullable !== false)) {
    addPreparationIssue(issues, dataRoomIssue({
      code: 'invalid_field_type_reference', path: `${path}.timeField`,
      message: `timeField ${JSON.stringify(value.timeField)} must reference a schema field with logicalType date or timestamp and nullable:false.`,
      expected: { kind: 'relation', description: 'Referenced schema field logicalType is date or timestamp and nullable=false.' }, received: value.timeField, includeReceivedValue: true,
    }));
  }
  if (Array.isArray(value.availableDimensions) && fields) {
    const unknown = value.availableDimensions.filter(dimension => typeof dimension !== 'string' || !fields.has(dimension));
    if (unknown.length) addPreparationIssue(issues, dataRoomIssue({
      code: 'unknown_field_reference', path: `${path}.availableDimensions`,
      message: `availableDimensions entries must be schema field names; not fields: ${unknown.slice(0, 10).map(item => JSON.stringify(item)).join(', ')}.`,
      expected: { kind: 'relation', description: 'Every value equals one schema[].name.' }, received: value.availableDimensions,
    }));
  }
  if (value.schema === undefined) return;
  if (!Array.isArray(value.schema)) {
    addPreparationIssue(issues, dataRoomIssue({
      code: 'invalid_type', path: `${path}.schema`, message: 'schema must be the complete ordered field array.',
      expected: { kind: 'range', type: 'array', minimum: 1, maximum: 200 }, received: value.schema,
    }));
    return;
  }
  const typeAliasIndices: number[] = [];
  const malformedIndices: number[] = [];
  const invalidLogicalTypeIndices: number[] = [];
  const invalidNullableIndices: number[] = [];
  const allowedFieldKeys = ['name', 'logicalType', 'physicalType', 'nullable'];
  value.schema.forEach((field, index) => {
    if (!isRecord(field)) {
      malformedIndices.push(index);
      return;
    }
    if (field.type !== undefined && field.logicalType === undefined) typeAliasIndices.push(index);
    const extras = Object.keys(field).filter(key => !allowedFieldKeys.includes(key));
    const missing = ['name', 'logicalType', 'nullable'].filter(key => field[key] === undefined);
    if ((extras.length || missing.length) && !(extras.length === 1 && extras[0] === 'type' && missing.length === 1 && missing[0] === 'logicalType')) {
      malformedIndices.push(index);
    }
    if (field.logicalType !== undefined && !['string', 'integer', 'number', 'boolean', 'date', 'timestamp'].includes(String(field.logicalType))) {
      invalidLogicalTypeIndices.push(index);
    }
    if (field.nullable !== undefined && typeof field.nullable !== 'boolean') invalidNullableIndices.push(index);
  });
  if (typeAliasIndices.length) {
    addPreparationIssue(issues, dataRoomIssue({
      code: 'schema_field_key_alias', path: `${path}.schema`,
      message: `Schema entries at indices ${typeAliasIndices.join(', ')} use type; replace type with logicalType on every listed entry in the next materially corrected call.`,
      expected: { kind: 'relation', description: 'Every field uses keys name, logicalType, optional physicalType, nullable.' }, received: value.schema,
    }));
  }
  if (malformedIndices.length) {
    addPreparationIssue(issues, dataRoomIssue({
      code: 'invalid_schema_field_shape', path: `${path}.schema`,
      message: `Schema entries at indices ${malformedIndices.join(', ')} do not match the field shape.`,
      expected: { kind: 'shape', requiredKeys: ['name', 'logicalType', 'nullable'], allowedKeys: allowedFieldKeys }, received: value.schema,
    }));
  }
  if (invalidLogicalTypeIndices.length) {
    addPreparationIssue(issues, dataRoomIssue({
      code: 'invalid_schema_logical_type', path: `${path}.schema`,
      message: `Schema entries at indices ${invalidLogicalTypeIndices.join(', ')} use unsupported logicalType values.`,
      expected: { kind: 'enum', values: ['string', 'integer', 'number', 'boolean', 'date', 'timestamp'] }, received: value.schema,
    }));
  }
  if (invalidNullableIndices.length) {
    addPreparationIssue(issues, dataRoomIssue({
      code: 'invalid_schema_nullable', path: `${path}.schema`,
      message: `Schema entries at indices ${invalidNullableIndices.join(', ')} must set nullable to true or false.`,
      expected: { kind: 'type', type: 'boolean' }, received: value.schema,
    }));
  }
}

function collectPreparationPlanIssues(value: unknown): DataRoomFailureIssueV1[] {
  const issues: DataRoomFailureIssueV1[] = [];
  const required = ['version', 'mode', 'request', 'sources', 'fragments', 'terminal'];
  if (!collectShapeIssues(value, 'plan', required, required, issues)) return issues;
  if (value.version !== undefined && value.version !== 1) addPreparationIssue(issues, dataRoomIssue({
    code: 'invalid_literal', path: 'plan.version', message: 'plan.version must be the JSON number 1.',
    expected: { kind: 'literal', value: 1 }, received: value.version, includeReceivedValue: true,
  }));
  if (value.mode !== undefined && value.mode !== 'dataset_preparation') addPreparationIssue(issues, dataRoomIssue({
    code: 'invalid_literal', path: 'plan.mode', message: 'plan.mode must be the exact string dataset_preparation.',
    expected: { kind: 'literal', value: 'dataset_preparation' }, received: value.mode, includeReceivedValue: true,
  }));
  collectPreparationRequestIssues(value.request, issues);
  if (!Array.isArray(value.sources) || value.sources.length < 1 || value.sources.length > 8) {
    addPreparationIssue(issues, dataRoomIssue({
      code: 'wrong_item_count', path: 'plan.sources', message: 'plan.sources must contain 1 to 8 source objects.',
      expected: { kind: 'range', type: 'array', minimum: 1, maximum: 8 }, received: value.sources,
    }));
  } else {
    value.sources.forEach((source, index) => {
      if (issues.length >= 8) return;
      const path = `plan.sources[${index}]`;
      if (!isRecord(source)) {
        addPreparationIssue(issues, dataRoomIssue({
          code: 'invalid_type', path, message: `${path} must be one source object.`,
          expected: { kind: 'type', type: 'object' }, received: source,
        }));
        return;
      }
      const kind = source.kind;
      if (!PREPARATION_SOURCE_KINDS.includes(String(kind))) {
        addPreparationIssue(issues, dataRoomIssue({
          code: 'invalid_enum', path: `${path}.kind`, message: 'Source kind must be one advertised adapter literal.',
          expected: { kind: 'enum', values: [...PREPARATION_SOURCE_KINDS] }, received: kind, includeReceivedValue: true,
        }));
        return;
      }
      if (kind === 'local_file') {
        const hasTarget = source.target !== undefined;
        const hasInto = source.into !== undefined;
        if (hasTarget === hasInto) {
          addPreparationIssue(issues, dataRoomIssue({
            code: 'exactly_one_required', path: hasTarget ? `${path}.into` : `${path}.target`,
            message: 'A local_file source needs exactly one of target (create a new dataset) or into (add a new version to one existing catalog dataset).',
            expected: { kind: 'relation', description: 'Exactly one of target or into is present.' }, received: hasTarget ? source.into : source.target,
          }));
        } else if (hasTarget) {
          collectTargetIssues(source.target, `${path}.target`, issues);
        } else if (collectShapeIssues(source.into, `${path}.into`, ['datasetId', 'mode', 'coverage'], ['datasetId', 'mode', 'coverage', 'expectedHeadRevision'], issues)) {
          const into = source.into as Record<string, unknown>;
          if (into.mode !== 'replace' && into.mode !== 'merge_partitions') addPreparationIssue(issues, dataRoomIssue({
            code: 'invalid_enum', path: `${path}.into.mode`,
            message: 'into.mode is replace (the file becomes the complete new version) or merge_partitions (the file replaces only its own time partitions; all other rows stay).',
            expected: { kind: 'enum', values: ['replace', 'merge_partitions'] }, received: into.mode, includeReceivedValue: true,
          }));
          collectCoverageIssues(into.coverage, `${path}.into.coverage`, issues);
        }
      }
      if (kind === 'sql_query' || kind === 'etl_query') {
        collectTargetIssues(source.target, `${path}.target`, issues);
      }
    });
  }
  if (value.fragments !== undefined && (!Array.isArray(value.fragments) || value.fragments.length > 32)) {
    addPreparationIssue(issues, dataRoomIssue({
      code: 'wrong_item_count', path: 'plan.fragments', message: 'plan.fragments must be an array with at most 32 entries; use [] for one direct source.',
      expected: { kind: 'range', type: 'array', minimum: 0, maximum: 32 }, received: value.fragments,
    }));
  }
  collectShapeIssues(value.terminal, 'plan.terminal', ['kind'], ['kind', 'alias', 'fragmentId'], issues);
  // Cheap request↔direct-target agreement in the same wave (full semantic
  // identity/coverage consistency still runs after normalization).
  const terminalAlias = isRecord(value.terminal) && value.terminal.kind === 'source' ? value.terminal.alias : undefined;
  const terminalSource = Array.isArray(value.sources)
    ? value.sources.find(source => isRecord(source) && source.alias === terminalAlias) as Record<string, unknown> | undefined
    : undefined;
  if (isRecord(value.request) && isRecord(terminalSource?.target)) {
    const target = terminalSource.target;
    for (const [requestField, targetField] of [['domainKey', 'domainKey'], ['countingKey', 'countingKey'], ['requiredGrain', 'grain'], ['timeZone', 'timeZone']] as const) {
      const requested = value.request[requestField];
      const declared = target[targetField];
      if (typeof requested === 'string' && typeof declared === 'string' && requested !== declared) addPreparationIssue(issues, dataRoomIssue({
        code: `terminal_${requestField === 'requiredGrain' ? 'grain' : requestField === 'countingKey' ? 'counting_key' : requestField === 'timeZone' ? 'timezone' : 'domain'}_mismatch`,
        path: `plan.request.${requestField}`,
        message: `request.${requestField} must equal the terminal target ${targetField} ${JSON.stringify(declared)}.`,
        expected: { kind: 'literal', value: declared }, received: requested, includeReceivedValue: true,
      }));
    }
  }
  return issues;
}

function normalizeCoverageRange(
  value: unknown,
  label: string,
  partitionKind: 'day' | 'month',
): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 128) {
    fail('invalid_input', `${label} must contain 1 to 128 ranges.`, dataRoomIssue({
      code: 'wrong_item_count', path: label, message: `${label} must contain 1 to 128 inclusive ranges.`,
      expected: { kind: 'range', type: 'array', minimum: 1, maximum: 128 }, received: value,
    }));
  }
  const output = new Set<string>();
  value.forEach((range, index) => {
    const path = `${label}[${index}]`;
    if (!isRecord(range)) fail('invalid_input', `${path} must be an object.`, dataRoomIssue({
      code: 'invalid_type', path, message: `${path} must contain exactly start and end.`,
      expected: { kind: 'shape', requiredKeys: ['start', 'end'], allowedKeys: ['start', 'end'] }, received: range,
    }));
    exactKeys(range, ['start', 'end'], path);
    const start = cleanText(range.start, `${path}.start`, 10);
    const end = cleanText(range.end, `${path}.end`, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)
      || (partitionKind === 'month' && (!start.endsWith('-01') || !end.endsWith('-01')))) {
      fail('invalid_input', `${path} has invalid partition keys.`, dataRoomIssue({
        code: 'invalid_partition_range', path,
        message: partitionKind === 'month'
          ? 'Month coverage ranges must use canonical YYYY-MM-01 start/end keys.'
          : 'Day coverage ranges must use YYYY-MM-DD start/end keys.',
        expected: { kind: 'pattern', type: 'string', pattern: partitionKind === 'month' ? '^\\d{4}-\\d{2}-01$' : '^\\d{4}-\\d{2}-\\d{2}$', example: partitionKind === 'month' ? '2026-09-01' : '2026-09-26' },
        received: range,
      }));
    }
    let partitions: string[];
    try {
      partitions = enumerateAnalyticsPartitions(start, end, partitionKind);
    } catch {
      fail('invalid_input', `${path} has an invalid or reversed range.`, dataRoomIssue({
        code: 'invalid_partition_range', path, message: 'Coverage range start must be on or before end and both must be real calendar partitions.',
        expected: { kind: 'relation', description: 'start <= end using valid canonical partition keys.' }, received: range,
      }));
    }
    partitions.forEach(partition => output.add(partition));
    if (output.size > 10_000) fail('invalid_input', `${label} expands beyond 10000 partitions.`, dataRoomIssue({
      code: 'too_many_partitions', path: label, message: `${label} must expand to at most 10000 unique partitions.`,
      expected: { kind: 'range', type: 'array', maximum: 10_000 }, received: value,
    }));
  });
  return [...output].sort();
}

function normalizePreparationCoverage(value: unknown, label: string): AnalyticsDatasetContract['coverage'] {
  if (!isRecord(value)) fail('invalid_input', `${label} must be an object.`, dataRoomIssue({
    code: 'invalid_type', path: label, message: `${label} must use one advertised coverage form.`,
    expected: { kind: 'type', type: 'object' }, received: value,
  }));
  const partitionKind = value.partitionKind;
  if (partitionKind !== 'day' && partitionKind !== 'month') fail('invalid_input', `${label}.partitionKind is unsupported.`, dataRoomIssue({
    code: 'invalid_enum', path: `${label}.partitionKind`, message: 'partitionKind must be day or month.',
    expected: { kind: 'enum', values: ['day', 'month'] }, received: partitionKind, includeReceivedValue: true,
  }));
  const compact = value.completeRanges !== undefined || value.observedRanges !== undefined;
  const explicit = value.completePartitions !== undefined || value.observedPartitions !== undefined;
  if (compact === explicit) fail('invalid_input', `${label} must use exactly one coverage form.`, dataRoomIssue({
    code: compact ? 'mixed_coverage_forms' : 'coverage_form_required', path: label,
    message: 'Use exactly one explicit-partition or compact-range coverage form.',
    expected: { kind: 'relation', description: 'Exactly one advertised coverage form is present.' }, received: value,
  }));
  let completePartitions: string[];
  let observedPartitions: string[] | undefined;
  if (compact) {
    exactKeys(value, ['partitionKind', 'observedRanges', 'completeRanges', 'watermark'], label);
    observedPartitions = normalizeCoverageRange(value.observedRanges, `${label}.observedRanges`, partitionKind);
    completePartitions = normalizeCoverageRange(value.completeRanges, `${label}.completeRanges`, partitionKind);
  } else {
    exactKeys(value, ['partitionKind', 'observedPartitions', 'completePartitions', 'watermark'], label);
    completePartitions = uniqueTextArray(value.completePartitions, `${label}.completePartitions`, 10_000).sort();
    observedPartitions = value.observedPartitions === undefined
      ? undefined
      : uniqueTextArray(value.observedPartitions, `${label}.observedPartitions`, 10_000).sort();
    const pattern = partitionKind === 'month' ? /^\d{4}-\d{2}-01$/ : /^\d{4}-\d{2}-\d{2}$/;
    const invalid = [...completePartitions, ...(observedPartitions ?? [])].find(partition => !pattern.test(partition));
    if (invalid) fail('invalid_input', `${label} contains an invalid partition key.`, dataRoomIssue({
      code: 'invalid_partition_key', path: label,
      message: partitionKind === 'month' ? 'Month partitions must use canonical YYYY-MM-01 keys.' : 'Day partitions must use YYYY-MM-DD keys.',
      expected: { kind: 'pattern', type: 'string', pattern: partitionKind === 'month' ? '^\\d{4}-\\d{2}-01$' : '^\\d{4}-\\d{2}-\\d{2}$' }, received: invalid, includeReceivedValue: true,
    }));
  }
  const observed = new Set(observedPartitions ?? completePartitions);
  const missingComplete = completePartitions.find(partition => !observed.has(partition));
  if (missingComplete) fail('invalid_input', `${label}.completePartitions must be observed.`, dataRoomIssue({
    code: 'complete_not_observed', path: label, message: 'Every complete partition must also be observed.',
    expected: { kind: 'relation', description: 'complete partitions are a subset of observed partitions.' }, received: missingComplete, includeReceivedValue: true,
  }));
  const watermark = cleanText(value.watermark, `${label}.watermark`, 80);
  if (!isAnalyticsIsoTimestamp(watermark)) fail('invalid_input', `${label}.watermark must be an ISO timestamp.`, dataRoomIssue({
    code: 'invalid_timestamp', path: `${label}.watermark`, message: 'watermark must be an exact ISO timestamp with timezone.',
    expected: { kind: 'pattern', type: 'string', pattern: '^YYYY-MM-DDTHH:mm:ss(.fraction)?(Z|±HH:mm)$', example: '2026-09-24T23:59:59.000Z' }, received: value.watermark,
  }));
  return {
    partitionKind,
    ...(observedPartitions ? { observedPartitions } : {}),
    completePartitions,
    watermark,
  };
}

function normalizePreparationAnswer(
  value: unknown,
  label: string,
  schema: AnalyticsDatasetPreparationTargetV1['schema'],
  metricId: string,
  timeField: string,
): AnalyticsDatasetPreparationTargetV1['answer'] {
  if (!isRecord(value)) fail('invalid_input', `${label} must be an object.`, dataRoomIssue({
    code: 'invalid_type', path: label, message: `${label} must be the complete answer recipe.`,
    expected: { kind: 'type', type: 'object' }, received: value,
  }));
  exactKeys(value, ['version', 'metricId', 'metricValueColumn', 'rowDimensions', 'filterableFields', 'stableOrder'], label);
  if (value.version !== 1) fail('invalid_input', `${label}.version must be 1.`, dataRoomIssue({
    code: 'invalid_literal', path: `${label}.version`, message: 'answer.version must be the JSON number 1.',
    expected: { kind: 'literal', value: 1 }, received: value.version, includeReceivedValue: true,
  }));
  const answerMetricId = cleanText(value.metricId, `${label}.metricId`, 160);
  const metricValueColumn = cleanText(value.metricValueColumn, `${label}.metricValueColumn`, 160);
  const rowDimensions = uniqueTextArray(value.rowDimensions, `${label}.rowDimensions`, 128);
  const filterableFields = uniqueTextArray(value.filterableFields, `${label}.filterableFields`, 128);
  if (!Array.isArray(value.stableOrder) || value.stableOrder.length > 128) fail('invalid_input', `${label}.stableOrder must be an array.`, dataRoomIssue({
    code: 'invalid_type', path: `${label}.stableOrder`, message: 'stableOrder must be an array with at most 128 entries.',
    expected: { kind: 'range', type: 'array', minimum: 0, maximum: 128 }, received: value.stableOrder,
  }));
  const stableOrder = value.stableOrder.map((raw, index) => {
    const path = `${label}.stableOrder[${index}]`;
    if (!isRecord(raw)) fail('invalid_input', `${path} must be an object.`, dataRoomIssue({
      code: 'invalid_type', path, message: 'Each stableOrder entry must contain field and direction.',
      expected: { kind: 'shape', requiredKeys: ['field', 'direction'], allowedKeys: ['field', 'direction'] }, received: raw,
    }));
    exactKeys(raw, ['field', 'direction'], path);
    const field = cleanText(raw.field, `${path}.field`, 160);
    if (raw.direction !== 'asc' && raw.direction !== 'desc') fail('invalid_input', `${path}.direction is unsupported.`, dataRoomIssue({
      code: 'invalid_enum', path: `${path}.direction`, message: 'direction must be asc or desc.',
      expected: { kind: 'enum', values: ['asc', 'desc'] }, received: raw.direction, includeReceivedValue: true,
    }));
    return { field, direction: raw.direction as 'asc' | 'desc' };
  });
  const fields = new Map(schema.map(field => [field.name, field]));
  const referenced = [...rowDimensions, ...filterableFields, ...stableOrder.map(order => order.field)];
  const unknown = referenced.find(field => !fields.has(field));
  if (unknown) fail('invalid_input', `${label} references an undeclared field.`, dataRoomIssue({
    code: 'unknown_field_reference', path: label, message: `Answer recipe references undeclared field ${unknown}.`,
    expected: { kind: 'relation', description: 'Every answer field reference equals one schema[].name.' }, received: unknown, includeReceivedValue: true,
  }));
  const metricField = fields.get(metricValueColumn);
  if (answerMetricId !== metricId || !metricField || !['integer', 'number'].includes(metricField.logicalType)) {
    fail('invalid_input', `${label} metric does not match the target contract.`, dataRoomIssue({
      code: 'answer_metric_mismatch', path: label,
      message: 'answer.metricId must equal target.metric.id and metricValueColumn must name one numeric schema field.',
      expected: { kind: 'relation', description: 'metricId equals target.metric.id; metricValueColumn logicalType is integer or number.' }, received: value,
    }));
  }
  if (!filterableFields.includes(timeField)) fail('invalid_input', `${label}.filterableFields must include the time field.`, dataRoomIssue({
    code: 'time_field_not_filterable', path: `${label}.filterableFields`, message: `filterableFields must include target timeField ${timeField}.`,
    expected: { kind: 'relation', description: 'Array contains target.timeField.' }, received: value.filterableFields,
  }));
  return { version: 1, metricId: answerMetricId, metricValueColumn, rowDimensions, filterableFields, stableOrder };
}

function normalizePreparationRetention(
  value: unknown,
  label: string,
): AnalyticsDatasetRetentionPolicy | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) fail('invalid_input', `${label} must be an object.`, dataRoomIssue({
    code: 'invalid_type', path: label, message: 'retention must be one complete policy object.',
    expected: { kind: 'shape', requiredKeys: ['minimumVersions', 'automaticExpiry', 'reacquirable', 'backupRequired'], allowedKeys: ['minimumVersions', 'automaticExpiry', 'reacquirable', 'backupRequired'] }, received: value,
  }));
  exactKeys(value, ['minimumVersions', 'automaticExpiry', 'reacquirable', 'backupRequired'], label);
  if (!Number.isInteger(value.minimumVersions) || Number(value.minimumVersions) < 1
    || typeof value.automaticExpiry !== 'boolean'
    || typeof value.reacquirable !== 'boolean'
    || typeof value.backupRequired !== 'boolean') {
    fail('invalid_input', `${label} is malformed.`, dataRoomIssue({
      code: 'invalid_retention_policy', path: label,
      message: 'retention requires minimumVersions>=1 and boolean automaticExpiry/reacquirable/backupRequired.',
      expected: { kind: 'shape', requiredKeys: ['minimumVersions', 'automaticExpiry', 'reacquirable', 'backupRequired'], allowedKeys: ['minimumVersions', 'automaticExpiry', 'reacquirable', 'backupRequired'] }, received: value,
    }));
  }
  return {
    minimumVersions: Number(value.minimumVersions),
    automaticExpiry: value.automaticExpiry,
    reacquirable: value.reacquirable,
    backupRequired: value.backupRequired,
  };
}

function normalizePreparationQuality(
  value: unknown,
  label: string,
): AnalyticsDatasetPreparationTargetV1['quality'] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 200) fail('invalid_input', `${label} must be an array.`, dataRoomIssue({
    code: 'invalid_type', path: label, message: 'quality must be an array with at most 200 assertion receipts.',
    expected: { kind: 'range', type: 'array', minimum: 0, maximum: 200 }, received: value,
  }));
  return value.map((raw, index) => {
    const path = `${label}[${index}]`;
    if (!isRecord(raw)) fail('invalid_input', `${path} must be an object.`, dataRoomIssue({
      code: 'invalid_type', path, message: 'Each quality entry must be one assertion receipt.',
      expected: { kind: 'type', type: 'object' }, received: raw,
    }));
    exactKeys(raw, ['assertionId', 'assertionVersion', 'severity', 'success', 'observed', 'expected'], path);
    const assertionId = cleanText(raw.assertionId, `${path}.assertionId`, 160);
    const assertionVersion = cleanText(raw.assertionVersion, `${path}.assertionVersion`, 80);
    if (raw.severity !== 'warning' && raw.severity !== 'error') fail('invalid_input', `${path}.severity is unsupported.`, dataRoomIssue({
      code: 'invalid_enum', path: `${path}.severity`, message: 'severity must be warning or error.',
      expected: { kind: 'enum', values: ['warning', 'error'] }, received: raw.severity, includeReceivedValue: true,
    }));
    if (typeof raw.success !== 'boolean') fail('invalid_input', `${path}.success must be boolean.`, dataRoomIssue({
      code: 'invalid_type', path: `${path}.success`, message: 'success must be true or false.',
      expected: { kind: 'type', type: 'boolean' }, received: raw.success, includeReceivedValue: true,
    }));
    return {
      assertionId,
      assertionVersion,
      severity: raw.severity,
      success: raw.success,
      ...(raw.observed === undefined ? {} : { observed: raw.observed as any }),
      ...(raw.expected === undefined ? {} : { expected: raw.expected as any }),
    };
  });
}

function normalizePreparationTarget(value: unknown, label: string): AnalyticsDatasetPreparationTargetV1 {
  if (!isRecord(value)) {
    fail('invalid_input', `${label} must be an object.`, dataRoomIssue({
      code: 'invalid_type', path: label, message: `${label} must be one complete target object.`,
      expected: { kind: 'type', type: 'object' }, received: value,
    }));
  }
  exactKeys(value, [
    'datasetId', 'expectedHeadRevision', 'name', 'description', 'domainKey', 'schema',
    'metric', 'regime', 'countingKey', 'grain', 'availableDimensions', 'timeField',
    'timeZone', 'coverage', 'answer', 'relational', 'classification', 'allowPublication',
    'retention', 'quality',
  ], label);
  if (!Array.isArray(value.schema)) {
    fail('invalid_input', `${label}.schema must be an array.`, dataRoomIssue({
      code: 'invalid_type', path: `${label}.schema`, message: `${label}.schema must be the complete ordered field array.`,
      expected: { kind: 'range', type: 'array', minimum: 1, maximum: 200 }, received: value.schema,
    }));
  }
  const schema = value.schema;
  if (schema.length < 1 || schema.length > 200) {
    fail('invalid_input', `${label}.schema must contain 1 to 200 fields.`, dataRoomIssue({
      code: 'wrong_item_count', path: `${label}.schema`, message: `${label}.schema must contain 1 to 200 fields.`,
      expected: { kind: 'range', type: 'array', minimum: 1, maximum: 200 }, received: schema,
    }));
  }
  const normalizedSchema = schema.map((raw, index) => {
    const fieldPath = `${label}.schema[${index}]`;
    if (!isRecord(raw)) {
      fail('invalid_input', `${fieldPath} must be an object.`, dataRoomIssue({
        code: 'invalid_type', path: fieldPath, message: `${fieldPath} must be one field descriptor.`,
        expected: { kind: 'shape', requiredKeys: ['name', 'logicalType', 'nullable'], allowedKeys: ['name', 'logicalType', 'physicalType', 'nullable'] }, received: raw,
      }));
    }
    exactKeys(raw, ['name', 'logicalType', 'physicalType', 'nullable'], fieldPath);
    const name = cleanText(raw.name, `${fieldPath}.name`, 160);
    const logicalType = String(raw.logicalType ?? '');
    if (!['string', 'integer', 'number', 'boolean', 'date', 'timestamp'].includes(logicalType)) {
      fail('invalid_input', `${fieldPath}.logicalType is unsupported.`, dataRoomIssue({
        code: 'invalid_enum', path: `${fieldPath}.logicalType`, message: `${fieldPath}.logicalType must be one supported literal.`,
        expected: { kind: 'enum', values: ['string', 'integer', 'number', 'boolean', 'date', 'timestamp'] },
        received: raw.logicalType, includeReceivedValue: true,
      }));
    }
    if (typeof raw.nullable !== 'boolean') {
      fail('invalid_input', `${fieldPath}.nullable must be boolean.`, dataRoomIssue({
        code: 'invalid_type', path: `${fieldPath}.nullable`, message: `${fieldPath}.nullable must be true or false.`,
        expected: { kind: 'type', type: 'boolean' }, received: raw.nullable, includeReceivedValue: true,
      }));
    }
    return {
      name,
      logicalType: logicalType as AnalyticsDatasetPreparationTargetV1['schema'][number]['logicalType'],
      ...(raw.physicalType === undefined ? {} : { physicalType: cleanText(raw.physicalType, `${fieldPath}.physicalType`, 160) }),
      nullable: raw.nullable,
    };
  });
  const fieldNames = normalizedSchema.map(field => field.name);
  if (new Set(fieldNames).size !== fieldNames.length) {
    fail('invalid_input', `${label}.schema contains duplicate names.`, dataRoomIssue({
      code: 'duplicate_values', path: `${label}.schema`, message: 'Every target schema field name must be unique.',
      expected: { kind: 'relation', description: 'Every schema[].name value is unique.' }, received: schema,
    }));
  }
  if (!isRecord(value.metric)) {
    fail('invalid_input', `${label}.metric must be an object.`, dataRoomIssue({
      code: 'invalid_type', path: `${label}.metric`, message: `${label}.metric must define id, version, unit, and definition.`,
      expected: { kind: 'shape', requiredKeys: ['id', 'version', 'unit', 'definition'], allowedKeys: ['id', 'version', 'unit', 'definition'] }, received: value.metric,
    }));
  }
  const metric = value.metric;
  exactKeys(metric, ['id', 'version', 'unit', 'definition'], `${label}.metric`);
  if (!isRecord(value.regime)) {
    fail('invalid_input', `${label}.regime must be an object.`, dataRoomIssue({
      code: 'invalid_type', path: `${label}.regime`, message: `${label}.regime must define id, version, and definition.`,
      expected: { kind: 'shape', requiredKeys: ['id', 'version', 'definition'], allowedKeys: ['id', 'version', 'definition'] }, received: value.regime,
    }));
  }
  const regime = value.regime;
  exactKeys(regime, ['id', 'version', 'definition'], `${label}.regime`);
  if (!isRecord(value.answer)) {
    fail('invalid_input', `${label}.answer must be an object.`, dataRoomIssue({
      code: 'invalid_type', path: `${label}.answer`, message: `${label}.answer must be the complete answer-recipe object from the schema.`,
      expected: { kind: 'type', type: 'object' }, received: value.answer,
    }));
  }
  const targetMetric = {
    id: cleanText(metric.id, `${label}.metric.id`, 160),
    version: cleanText(metric.version, `${label}.metric.version`, 80),
    unit: cleanText(metric.unit, `${label}.metric.unit`, 160),
    definition: cleanText(metric.definition, `${label}.metric.definition`, 4000),
  };
  const targetRegime = {
    id: cleanText(regime.id, `${label}.regime.id`, 160),
    version: cleanText(regime.version, `${label}.regime.version`, 80),
    definition: cleanText(regime.definition, `${label}.regime.definition`, 4000),
  };
  const targetCountingKey = cleanText(value.countingKey, `${label}.countingKey`, 160);
  const targetTimeField = cleanText(value.timeField, `${label}.timeField`, 160);
  const coverage = normalizePreparationCoverage(value.coverage, `${label}.coverage`);
  const answer = normalizePreparationAnswer(value.answer, `${label}.answer`, normalizedSchema, targetMetric.id, targetTimeField);
  const classification = value.classification === undefined ? 'internal' : cleanText(value.classification, `${label}.classification`, 80);
  if (!CLASSIFICATION_RANK.has(classification)) fail('invalid_input', `${label}.classification is unsupported.`, dataRoomIssue({
    code: 'invalid_enum', path: `${label}.classification`, message: 'classification must be one supported handling literal.',
    expected: { kind: 'enum', values: ['public', 'internal', 'confidential', 'highly_confidential', 'restricted', 'critical'] }, received: value.classification, includeReceivedValue: true,
  }));
  if (value.allowPublication !== undefined && typeof value.allowPublication !== 'boolean') fail('invalid_input', `${label}.allowPublication must be boolean.`, dataRoomIssue({
    code: 'invalid_type', path: `${label}.allowPublication`, message: 'allowPublication must be true or false.',
    expected: { kind: 'type', type: 'boolean' }, received: value.allowPublication, includeReceivedValue: true,
  }));
  const retention = normalizePreparationRetention(value.retention, `${label}.retention`);
  const quality = normalizePreparationQuality(value.quality, `${label}.quality`);
  const target = JSON.parse(stableAnalyticsJson({
    ...(value.datasetId === undefined ? {} : { datasetId: cleanText(value.datasetId, `${label}.datasetId`, 100) }),
    ...(value.expectedHeadRevision === undefined ? {} : { expectedHeadRevision: Number(value.expectedHeadRevision) }),
    name: cleanText(value.name, `${label}.name`, 300),
    description: cleanText(value.description, `${label}.description`, 4000),
    domainKey: cleanText(value.domainKey, `${label}.domainKey`, 160),
    schema: normalizedSchema,
    metric: targetMetric,
    regime: targetRegime,
    countingKey: targetCountingKey,
    grain: cleanText(value.grain, `${label}.grain`, 160),
    availableDimensions: uniqueTextArray(value.availableDimensions, `${label}.availableDimensions`),
    timeField: targetTimeField,
    timeZone: cleanText(value.timeZone, `${label}.timeZone`, 160),
    coverage,
    answer,
    ...(value.relational === undefined ? {} : { relational: value.relational }),
    classification,
    allowPublication: value.allowPublication === true,
    ...(retention ? { retention } : {}),
    quality,
  })) as AnalyticsDatasetPreparationTargetV1;
  if (target.datasetId && !DATASET_ID_RE.test(target.datasetId)) {
    fail('invalid_input', `${label}.datasetId is malformed.`, dataRoomIssue({
      code: 'invalid_pattern', path: `${label}.datasetId`, message: `${label}.datasetId must be an exact Data Room dataset ID.`,
      expected: { kind: 'pattern', type: 'string', pattern: '^ds_[a-zA-Z0-9_-]{1,96}$' }, received: value.datasetId, includeReceivedValue: true,
    }));
  }
  if (target.expectedHeadRevision !== undefined
    && (!Number.isInteger(target.expectedHeadRevision) || target.expectedHeadRevision < 0)) {
    fail('invalid_input', `${label}.expectedHeadRevision must be a non-negative integer.`, dataRoomIssue({
      code: 'out_of_range', path: `${label}.expectedHeadRevision`, message: `${label}.expectedHeadRevision must be a non-negative integer.`,
      expected: { kind: 'range', type: 'integer', minimum: 0 }, received: value.expectedHeadRevision, includeReceivedValue: true,
    }));
  }
  const fields = new Set(fieldNames);
  const relationIssues: DataRoomFailureIssueV1[] = [];
  if (!fields.has(target.countingKey)) relationIssues.push(dataRoomIssue({
    code: 'unknown_field_reference', path: `${label}.countingKey`, message: 'countingKey must name one target schema field.',
    expected: { kind: 'relation', description: 'Value equals one schema[].name.' }, received: target.countingKey, includeReceivedValue: true,
  }));
  if (!fields.has(target.timeField)) relationIssues.push(dataRoomIssue({
    code: 'unknown_field_reference', path: `${label}.timeField`, message: 'timeField must name one target schema field.',
    expected: { kind: 'relation', description: 'Value equals one schema[].name whose logicalType is date or timestamp.' }, received: target.timeField, includeReceivedValue: true,
  }));
  const undeclaredDimension = target.availableDimensions.find(field => !fields.has(field));
  if (undeclaredDimension) relationIssues.push(dataRoomIssue({
    code: 'unknown_field_reference', path: `${label}.availableDimensions`, message: `availableDimensions references undeclared field ${undeclaredDimension}.`,
    expected: { kind: 'relation', description: 'Every value equals one schema[].name.' }, received: target.availableDimensions,
  }));
  if (relationIssues.length) fail('invalid_input', `${label} contains undeclared field references.`, relationIssues);
  const time = normalizedSchema.find(field => field.name === target.timeField);
  if (!time || (time.logicalType !== 'date' && time.logicalType !== 'timestamp') || time.nullable) {
    fail('invalid_input', `${label}.timeField must be a non-nullable date or timestamp field.`, dataRoomIssue({
      code: 'invalid_field_type_reference', path: `${label}.timeField`, message: 'timeField must reference a non-nullable schema field with logicalType date or timestamp.',
      expected: { kind: 'relation', description: 'Referenced schema field logicalType is date or timestamp and nullable=false.' }, received: target.timeField, includeReceivedValue: true,
    }));
  }
  return target;
}

interface TerminalSemantics {
  domainKey: string;
  metric: AnalyticsDatasetContract['metric'];
  regime: AnalyticsDatasetContract['regime'];
  countingKey: string;
  grain: string;
  timeZone: string;
  availableDimensions: string[];
  coverage: AnalyticsDatasetContract['coverage'];
  /** Where the exact metric/regime identity objects come from. */
  identitySource: string;
}

function directPreparationRequestIssues(
  request: AnalyticsRequest,
  target: AnalyticsDatasetPreparationTargetV1,
): DataRoomFailureIssueV1[] {
  const semanticIdentities = derivePreparationSemanticIdentities(target.metric, target.regime);
  return terminalRequestIssues(request, {
    ...target,
    metric: semanticIdentities.metric,
    regime: semanticIdentities.regime,
    identitySource: `action=derive_semantic_hashes (receipt ${semanticIdentities.receiptSha256})`,
  });
}

function terminalRequestIssues(request: AnalyticsRequest, target: TerminalSemantics): DataRoomFailureIssueV1[] {
  const issues: DataRoomFailureIssueV1[] = [];
  const add = (issue: DataRoomFailureIssueV1): void => { if (issues.length < 8) issues.push(issue); };
  if (request.domainKey !== target.domainKey) add(dataRoomIssue({
    code: 'terminal_domain_mismatch', path: 'plan.request.domainKey',
    message: `request.domainKey must equal the direct terminal target domainKey ${target.domainKey}.`,
    expected: { kind: 'literal', value: target.domainKey }, received: request.domainKey, includeReceivedValue: true,
  }));
  const expectedMetric = target.metric;
  if (stableAnalyticsJson(request.metric) !== stableAnalyticsJson(expectedMetric)) add(dataRoomIssue({
    code: 'terminal_metric_mismatch', path: 'plan.request.metric',
    message: 'request.metric must exactly match the direct terminal target metric identity and hash.',
    expected: {
      kind: 'relation',
      description: `Copy this exact object from ${target.identitySource}: ${stableAnalyticsJson(expectedMetric)}.`,
    },
    received: request.metric,
  }));
  const expectedRegime = target.regime;
  if (stableAnalyticsJson(request.regime) !== stableAnalyticsJson(expectedRegime)) add(dataRoomIssue({
    code: 'terminal_regime_mismatch', path: 'plan.request.regime',
    message: 'request.regime must exactly match the direct terminal target regime identity and hash.',
    expected: {
      kind: 'relation',
      description: `Copy this exact object from ${target.identitySource}: ${stableAnalyticsJson(expectedRegime)}.`,
    },
    received: request.regime,
  }));
  if (request.countingKey !== target.countingKey) add(dataRoomIssue({
    code: 'terminal_counting_key_mismatch', path: 'plan.request.countingKey',
    message: `request.countingKey must equal direct terminal target countingKey ${target.countingKey}.`,
    expected: { kind: 'literal', value: target.countingKey }, received: request.countingKey, includeReceivedValue: true,
  }));
  if (request.requiredGrain !== target.grain) add(dataRoomIssue({
    code: 'terminal_grain_mismatch', path: 'plan.request.requiredGrain',
    message: `request.requiredGrain must equal direct terminal target grain ${target.grain}.`,
    expected: { kind: 'literal', value: target.grain }, received: request.requiredGrain, includeReceivedValue: true,
  }));
  if (request.timeZone !== target.timeZone) add(dataRoomIssue({
    code: 'terminal_timezone_mismatch', path: 'plan.request.timeZone',
    message: `request.timeZone must equal direct terminal target timeZone ${target.timeZone}.`,
    expected: { kind: 'literal', value: target.timeZone }, received: request.timeZone, includeReceivedValue: true,
  }));
  const unavailable = request.dimensions.filter(dimension => !target.availableDimensions.includes(dimension));
  if (unavailable.length) add(dataRoomIssue({
    code: 'terminal_dimensions_mismatch', path: 'plan.request.dimensions',
    message: `Request dimensions are absent from target.availableDimensions: ${unavailable.join(', ')}.`,
    expected: { kind: 'relation', description: 'Every request dimension is present in target.availableDimensions.' }, received: request.dimensions,
  }));
  const observed = new Set(target.coverage.observedPartitions ?? target.coverage.completePartitions);
  const requestedPartitions = enumerateAnalyticsPartitions(
    request.dateRange.start,
    request.dateRange.end,
    target.coverage.partitionKind,
  );
  const missing = requestedPartitions.filter(partition => !observed.has(partition));
  if (missing.length) add(dataRoomIssue({
    code: 'terminal_observed_coverage_gap', path: 'plan.request.dateRange',
    message: `Direct terminal target lacks ${missing.length} requested observed ${target.coverage.partitionKind} partition(s): ${missing.slice(0, 5).join(', ')}.`,
    expected: { kind: 'relation', description: 'Every partition in request.dateRange is present in target.coverage observed partitions/ranges.' }, received: request.dateRange,
  }));
  return issues;
}

function normalizePreparationPlan(value: AnalyticsDatasetPreparationPlanV1): AnalyticsDatasetPreparationPlanV1 {
  const preflightIssues = collectPreparationPlanIssues(value);
  if (preflightIssues.length) {
    fail(
      'invalid_input',
      `Dataset preparation plan has ${preflightIssues.length === 8 ? 'at least ' : ''}${preflightIssues.length} actionable pre-admission issue(s); prerequisite repairs may expose another bounded issue wave.`,
      preflightIssues,
    );
  }
  if (!isRecord(value)) {
    fail('invalid_input', 'plan must be an object.', dataRoomIssue({
      code: 'invalid_type', path: 'plan', message: 'plan must be one fully specified dataset-preparation object, not prose or a string.',
      expected: { kind: 'shape', requiredKeys: ['version', 'mode', 'request', 'sources', 'fragments', 'terminal'], allowedKeys: ['version', 'mode', 'request', 'sources', 'fragments', 'terminal'] }, received: value,
    }));
  }
  exactKeys(value, ['version', 'mode', 'request', 'sources', 'fragments', 'terminal'], 'plan');
  const discriminatorIssues: DataRoomFailureIssueV1[] = [];
  if (value.version !== 1) discriminatorIssues.push(dataRoomIssue({
    code: 'invalid_literal', path: 'plan.version', message: 'plan.version must be the JSON number 1.',
    expected: { kind: 'literal', value: 1 }, received: value.version, includeReceivedValue: true,
  }));
  if (value.mode !== 'dataset_preparation') discriminatorIssues.push(dataRoomIssue({
    code: 'invalid_literal', path: 'plan.mode', message: 'plan.mode must be the exact string dataset_preparation.',
    expected: { kind: 'literal', value: 'dataset_preparation' }, received: value.mode, includeReceivedValue: true,
  }));
  if (discriminatorIssues.length) {
    fail('invalid_input', 'The plan protocol discriminators are invalid; version and mode are separate fields.', discriminatorIssues);
  }
  let request: AnalyticsRequest;
  try {
    request = normalizeAnalyticsRequest(value.request);
  } catch (error) {
    if (error instanceof AnalyticsDataRoomContractError) {
      const issues = Array.isArray((error as AnalyticsDataRoomContractError & { issues?: DataRoomFailureIssueV1[] }).issues)
        ? (error as AnalyticsDataRoomContractError & { issues: DataRoomFailureIssueV1[] }).issues
        : [dataRoomIssue({
            code: 'invalid_request', path: '$', message: error.message,
            expected: { kind: 'type', type: 'object' }, received: value.request,
          })];
      fail('invalid_input', error.message, prefixDataRoomIssues('plan.request', issues));
    }
    throw error;
  }
  if (!Array.isArray(value.sources) || value.sources.length < 1 || value.sources.length > 8) {
    fail('invalid_input', 'plan.sources must contain 1 to 8 sources.', dataRoomIssue({
      code: 'wrong_item_count', path: 'plan.sources', message: 'plan.sources must contain 1 to 8 exact source objects.',
      expected: { kind: 'range', type: 'array', minimum: 1, maximum: 8 }, received: value.sources,
    }));
  }
  const aliases = new Set<string>();
  const sources = (value.sources as unknown[]).map((raw, index): AnalyticsDatasetPreparationSourceV1 => {
    const sourcePath = `plan.sources[${index}]`;
    if (!isRecord(raw)) {
      fail('invalid_input', `${sourcePath} must be an object.`, dataRoomIssue({
        code: 'invalid_type', path: sourcePath, message: `${sourcePath} must be one source object.`,
        expected: { kind: 'type', type: 'object' }, received: raw,
      }));
    }
    const kind = raw.kind;
    const alias = cleanText(raw.alias, `${sourcePath}.alias`, 32);
    if (!SOURCE_ALIAS_RE.test(alias)) {
      fail('invalid_input', `${sourcePath}.alias is malformed.`, dataRoomIssue({
        code: 'invalid_pattern', path: `${sourcePath}.alias`, message: 'Source alias must start with a letter and contain only letters, digits, or underscore (max 32).',
        expected: { kind: 'pattern', type: 'string', pattern: '^[A-Za-z][A-Za-z0-9_]{0,31}$', example: 'monthly_source' }, received: raw.alias, includeReceivedValue: true,
      }));
    }
    if (aliases.has(alias.toLowerCase())) {
      fail('invalid_input', `${sourcePath}.alias is duplicated.`, dataRoomIssue({
        code: 'duplicate_value', path: `${sourcePath}.alias`, message: 'Every source alias must be unique ignoring case.',
        expected: { kind: 'relation', description: 'Unique across plan.sources[].alias ignoring case.' }, received: raw.alias, includeReceivedValue: true,
      }));
    }
    aliases.add(alias.toLowerCase());
    if (kind === 'existing_version') {
      exactKeys(raw, ['kind', 'alias', 'datasetId', 'versionId', 'requiredColumns', 'expectedSchemaSha256', 'expectedContractSha256'], sourcePath);
      const datasetId = cleanText(raw.datasetId, `${sourcePath}.datasetId`, 100);
      const versionId = cleanText(raw.versionId, `${sourcePath}.versionId`, 100);
      const expectedSchemaSha256 = cleanText(raw.expectedSchemaSha256, `${sourcePath}.expectedSchemaSha256`, 64);
      const expectedContractSha256 = cleanText(raw.expectedContractSha256, `${sourcePath}.expectedContractSha256`, 64);
      const identityIssues: DataRoomFailureIssueV1[] = [];
      if (!DATASET_ID_RE.test(datasetId)) identityIssues.push(dataRoomIssue({ code: 'invalid_pattern', path: `${sourcePath}.datasetId`, message: 'datasetId is malformed.', expected: { kind: 'pattern', type: 'string', pattern: '^ds_[a-zA-Z0-9_-]{1,96}$' }, received: raw.datasetId, includeReceivedValue: true }));
      if (!VERSION_ID_RE.test(versionId)) identityIssues.push(dataRoomIssue({ code: 'invalid_pattern', path: `${sourcePath}.versionId`, message: 'versionId is malformed.', expected: { kind: 'pattern', type: 'string', pattern: '^dsv_[a-f0-9]{24}$' }, received: raw.versionId, includeReceivedValue: true }));
      if (!SHA256_RE.test(expectedSchemaSha256)) identityIssues.push(dataRoomIssue({ code: 'invalid_sha256', path: `${sourcePath}.expectedSchemaSha256`, message: 'expectedSchemaSha256 must be 64 lowercase hex characters.', expected: { kind: 'pattern', type: 'string', pattern: '^[a-f0-9]{64}$' }, received: raw.expectedSchemaSha256 }));
      if (!SHA256_RE.test(expectedContractSha256)) identityIssues.push(dataRoomIssue({ code: 'invalid_sha256', path: `${sourcePath}.expectedContractSha256`, message: 'expectedContractSha256 must be 64 lowercase hex characters.', expected: { kind: 'pattern', type: 'string', pattern: '^[a-f0-9]{64}$' }, received: raw.expectedContractSha256 }));
      if (identityIssues.length) fail('invalid_input', `${sourcePath} exact version identity is malformed.`, identityIssues);
      return { kind, alias, datasetId, versionId, requiredColumns: uniqueTextArray(raw.requiredColumns, `${sourcePath}.requiredColumns`), expectedSchemaSha256, expectedContractSha256 };
    }
    if (kind === 'import_inbox') {
      exactKeys(raw, ['kind', 'alias', 'importId', 'requiredColumns'], sourcePath);
      const importId = cleanText(raw.importId, `${sourcePath}.importId`, 100);
      if (!IMPORT_ID_RE.test(importId)) {
        fail('invalid_input', `${sourcePath}.importId is malformed.`, dataRoomIssue({
          code: 'invalid_pattern', path: `${sourcePath}.importId`, message: 'importId must be an exact Import Inbox candidate ID.',
          expected: { kind: 'pattern', type: 'string', pattern: '^dri_[a-f0-9]{24}$' }, received: raw.importId, includeReceivedValue: true,
        }));
      }
      return { kind, alias, importId, requiredColumns: uniqueTextArray(raw.requiredColumns, `${sourcePath}.requiredColumns`) };
    }
    if (kind === 'local_file') return normalizeLocalFileSource(raw, alias, sourcePath);
    if (kind !== 'sql_query' && kind !== 'etl_query') {
      fail('invalid_input', `${sourcePath}.kind is unsupported.`, dataRoomIssue({
        code: 'invalid_enum', path: `${sourcePath}.kind`, message: 'Source kind must be one advertised adapter literal.',
        expected: { kind: 'enum', values: [...PREPARATION_SOURCE_KINDS] }, received: kind, includeReceivedValue: true,
      }));
    }
    exactKeys(raw, kind === 'sql_query'
      ? ['kind', 'alias', 'sql', 'target']
      : ['kind', 'alias', 'sql', 'datasetDate', 'nullToken', 'target'], sourcePath);
    const sql = cleanText(raw.sql, `${sourcePath}.sql`, 100_000);
    if (kind === 'sql_query' && (!/^(?:SELECT|WITH)\b/i.test(sql)
      || /\b(?:INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|TRUNCATE|COPY|UNLOAD)\b/i.test(sql))) {
      fail('policy_denied', `${sourcePath}.sql must be one read-only SELECT or WITH query.`, dataRoomIssue({
        code: 'read_only_sql_required', path: `${sourcePath}.sql`, message: 'SQL must be one read-only SELECT or WITH query.',
        expected: { kind: 'pattern', type: 'string', pattern: '^(SELECT|WITH)\\b' }, received: raw.sql,
      }));
    }
    const target = normalizePreparationTarget(raw.target, `${sourcePath}.target`);
    if (kind === 'etl_query') {
      const datasetDate = raw.datasetDate === undefined ? undefined : cleanText(raw.datasetDate, `${sourcePath}.datasetDate`, 10);
      if (datasetDate && !/^\d{4}-\d{2}-\d{2}$/.test(datasetDate)) {
        fail('invalid_input', `${sourcePath}.datasetDate must be YYYY-MM-DD.`, dataRoomIssue({
          code: 'invalid_date_format', path: `${sourcePath}.datasetDate`, message: 'datasetDate must use the exact YYYY-MM-DD form.',
          expected: { kind: 'pattern', type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', example: '2026-09-26' }, received: raw.datasetDate, includeReceivedValue: true,
        }));
      }
      if (raw.nullToken !== undefined && (typeof raw.nullToken !== 'string' || raw.nullToken.length > 32 || /["\t\r\n\0]/.test(raw.nullToken))) {
        fail('invalid_input', `${sourcePath}.nullToken is invalid.`, dataRoomIssue({
          code: 'invalid_null_token', path: `${sourcePath}.nullToken`,
          message: 'nullToken is optional; omit it (Datanet writes null as an empty cell) or give the exact ≤32-character marker the query emits for null, such as \\N, without tab, quote, CR, LF, or NUL.',
          expected: { kind: 'range', type: 'string', minimum: 0, maximum: 32 }, received: raw.nullToken, includeReceivedValue: true,
        }));
      }
      return {
        kind, alias, sql,
        ...(datasetDate ? { datasetDate } : {}),
        ...(raw.nullToken !== undefined ? { nullToken: raw.nullToken as string } : {}),
        target,
      };
    }
    return { kind, alias, sql, target };
  });
  if (!Array.isArray(value.fragments) || value.fragments.length > 32) {
    fail('invalid_input', 'plan.fragments must contain 0 to 32 fully specified relational fragments.', dataRoomIssue({
      code: 'wrong_item_count', path: 'plan.fragments', message: 'plan.fragments must be an array with at most 32 entries; use [] for direct source publication.',
      expected: { kind: 'range', type: 'array', minimum: 0, maximum: 32 }, received: value.fragments,
    }));
  }
  const fragments = JSON.parse(stableAnalyticsJson(value.fragments)) as AnalyticsJobFragmentV1[];
  const fragmentIds = fragments.map((fragment, index) => cleanText(fragment?.id, `plan.fragments[${index}].id`, 100));
  if (new Set(fragmentIds).size !== fragmentIds.length) {
    fail('invalid_input', 'plan.fragments IDs must be unique.', dataRoomIssue({
      code: 'duplicate_values', path: 'plan.fragments', message: 'Every fragment id must be unique.',
      expected: { kind: 'relation', description: 'Every plan.fragments[].id is unique.' }, received: value.fragments,
    }));
  }
  if (!isRecord(value.terminal)) {
    fail('invalid_input', 'plan.terminal must be an object.', dataRoomIssue({
      code: 'invalid_type', path: 'plan.terminal', message: 'plan.terminal must select one declared source or fragment.',
      expected: { kind: 'type', type: 'object' }, received: value.terminal,
    }));
  }
  const terminal = value.terminal.kind === 'source'
    ? (() => {
        exactKeys(value.terminal, ['kind', 'alias'], 'plan.terminal');
        return { kind: 'source' as const, alias: cleanText(value.terminal.alias, 'plan.terminal.alias', 32) };
      })()
    : value.terminal.kind === 'fragment'
      ? (() => {
          exactKeys(value.terminal, ['kind', 'fragmentId'], 'plan.terminal');
          return { kind: 'fragment' as const, fragmentId: cleanText(value.terminal.fragmentId, 'plan.terminal.fragmentId', 100) };
        })()
      : fail('invalid_input', 'plan.terminal.kind must be source or fragment.', dataRoomIssue({
          code: 'invalid_enum', path: 'plan.terminal.kind', message: 'plan.terminal.kind must be source or fragment.',
          expected: { kind: 'enum', values: ['source', 'fragment'] }, received: (value.terminal as Record<string, unknown>).kind, includeReceivedValue: true,
        }));
  if (terminal.kind === 'source' && !sources.some(source => source.alias === terminal.alias)) {
    fail('invalid_input', 'Terminal source alias does not exist.', dataRoomIssue({
      code: 'unknown_source_alias', path: 'plan.terminal.alias', message: 'Terminal source alias must exactly equal one plan.sources[].alias.',
      expected: { kind: 'relation', description: 'Value equals one plan.sources[].alias.' }, received: terminal.alias, includeReceivedValue: true,
    }));
  }
  if (terminal.kind === 'fragment' && !fragmentIds.includes(terminal.fragmentId)) {
    fail('invalid_input', 'Terminal fragment does not exist.', dataRoomIssue({
      code: 'unknown_fragment_id', path: 'plan.terminal.fragmentId', message: 'Terminal fragmentId must exactly equal one plan.fragments[].id.',
      expected: { kind: 'relation', description: 'Value equals one plan.fragments[].id.' }, received: terminal.fragmentId, includeReceivedValue: true,
    }));
  }
  sources.forEach((source, index) => {
    // A new version of an existing dataset is itself the outcome; it cannot
    // be an intermediate input that silently moves a catalog head.
    if (source.kind === 'local_file' && source.into
      && (terminal.kind !== 'source' || terminal.alias !== source.alias)) {
      fail('invalid_input', 'An into local_file source must be the plan terminal.', dataRoomIssue({
        code: 'into_source_must_be_terminal', path: `plan.sources[${index}].into`,
        message: 'A local_file source with into publishes a new version of an existing dataset, so plan.terminal must be {kind:"source", alias:<this alias>} with fragments [].',
        expected: { kind: 'relation', description: 'plan.terminal selects this into source.' }, received: terminal,
      }));
    }
  });
  if (terminal.kind === 'source') {
    const terminalSource = sources.find(source => source.alias === terminal.alias)!;
    const directTarget = terminalSource.kind === 'sql_query' || terminalSource.kind === 'etl_query'
      ? terminalSource.target
      : terminalSource.kind === 'local_file' ? terminalSource.target : undefined;
    if (directTarget) {
      const consistencyIssues = directPreparationRequestIssues(request, directTarget);
      if (consistencyIssues.length) {
        fail('invalid_input', `Direct terminal request has ${consistencyIssues.length} semantic/coverage mismatch(es).`, consistencyIssues);
      }
    }
  }
  return { version: 1, mode: 'dataset_preparation', request, sources, fragments, terminal };
}

/** `plan` is already normalized and, for local files, admitted with exact byte pins. */
function preparationIntent(owner: AnalyticsJobOwnerRequest, plan: AnalyticsDatasetPreparationPlanV1): AnalyticsDatasetPreparationIntentV1 {
  const message = cleanText(owner.message, 'owner message');
  return {
    version: 2,
    mode: 'dataset_preparation',
    goal: message,
    ownerMessageSha256: analyticsSha256(message),
    plan,
  };
}

function nodesForPlan(plan: AnalyticsJobPlanV1) {
  const nodes = [
    ...plan.inputs.map(input => ({
      key: sourceNodeKey(input.alias),
      kind: 'source_resolution' as const,
      adapterVersion: 'existing-data-room-version-v1',
      spec: { type: 'existing_version', input },
      inputIdentity: {
        datasetId: input.datasetId,
        versionId: input.versionId,
        expectedSchemaSha256: input.expectedSchemaSha256,
        expectedContractSha256: input.expectedContractSha256,
      },
      inputContractSha256: input.expectedContractSha256,
    })),
    ...plan.fragments.map(fragment => ({
      key: fragmentNodeKey(fragment.id),
      kind: 'transform_fragment' as const,
      adapterVersion: 'analytics-job-fragment-v1',
      spec: {
        type: 'transform_fragment',
        fragment,
        request: plan.request,
        terminal: plan.terminal.kind === 'fragment' && plan.terminal.fragmentId === fragment.id,
      },
    })),
    {
      key: 'result',
      kind: 'result_publication' as const,
      adapterVersion: 'analytics-job-result-v1',
      spec: { type: 'result_publication', plan },
    },
    ...plan.consumers.map(consumer => ({
      key: consumer.kind === 'answer' ? 'consumer:answer' : 'consumer:retain',
      kind: consumer.kind === 'answer' ? 'answer_delivery' as const : 'retain_delivery' as const,
      adapterVersion: consumer.kind === 'answer' ? 'analytics-job-answer-v1' : 'analytics-job-retain-v1',
      spec: { type: consumer.kind, consumer, request: plan.request },
    })),
  ];
  const edges: Array<{ fromKey: string; toKey: string; inputPosition: number; inputName: string }> = [];
  plan.fragments.forEach(fragment => fragment.dependencies.forEach((dependency, inputPosition) => {
    edges.push({
      fromKey: plan.inputs.some(input => input.alias === dependency.sourceRef)
        ? sourceNodeKey(dependency.sourceRef)
        : fragmentNodeKey(dependency.sourceRef),
      toKey: fragmentNodeKey(fragment.id),
      inputPosition,
      inputName: dependency.alias,
    });
  }));
  const terminalKey = plan.terminal.kind === 'input'
    ? sourceNodeKey(plan.terminal.alias)
    : fragmentNodeKey(plan.terminal.fragmentId);
  edges.push({ fromKey: terminalKey, toKey: 'result', inputPosition: 0, inputName: 'primary' });
  plan.consumers.forEach((consumer, inputPosition) => edges.push({
    fromKey: 'result',
    toKey: consumer.kind === 'answer' ? 'consumer:answer' : 'consumer:retain',
    inputPosition,
    inputName: 'result',
  }));

  const predecessors = new Map<string, string[]>();
  for (const edge of edges) predecessors.set(edge.toKey, [...(predecessors.get(edge.toKey) ?? []), edge.fromKey]);
  const reachable = new Set<string>();
  const visit = (key: string): void => {
    if (reachable.has(key)) return;
    reachable.add(key);
    for (const prior of predecessors.get(key) ?? []) visit(prior);
  };
  visit('result');
  const unused = nodes
    .filter(node => node.kind === 'source_resolution' || node.kind === 'transform_fragment')
    .map(node => node.key)
    .filter(key => !reachable.has(key));
  if (unused.length) fail('invalid_input', `Analytics plan contains unused source/fragment nodes: ${unused.join(', ')}.`);
  return { nodes, edges };
}

function nodesForPreparation(plan: AnalyticsDatasetPreparationPlanV1) {
  const nodes = [
    ...plan.sources.map(source => ({
      key: sourceNodeKey(source.alias),
      kind: 'source_resolution' as const,
      adapterVersion: source.kind === 'existing_version'
        ? 'existing-data-room-version-v1'
        : source.kind === 'sql_query'
          ? 'sql-context-to-data-room-v1'
          : source.kind === 'etl_query'
            ? 'datanet-etl-to-data-room-v1'
            : source.kind === 'local_file'
              ? 'local-file-to-data-room-v1'
              : 'import-inbox-to-data-room-v1',
      spec: source.kind === 'existing_version'
        ? { type: 'existing_version', input: source }
        : { type: 'preparation_source', source },
      inputIdentity: source.kind === 'existing_version'
        ? {
            datasetId: source.datasetId,
            versionId: source.versionId,
            expectedSchemaSha256: source.expectedSchemaSha256,
            expectedContractSha256: source.expectedContractSha256,
          }
        : source.kind === 'import_inbox'
          ? { importId: source.importId, requiredColumns: source.requiredColumns }
          : source.kind === 'local_file'
            ? {
                sourceKind: source.kind,
                fileSha256: source.admitted?.sha256 ?? null,
                fileBytes: source.admitted?.bytes ?? null,
                format: source.admitted?.format ?? source.format ?? null,
                sheet: source.admitted?.sheet ?? null,
                headerRow: source.admitted?.headerRow ?? null,
                nullTokenSha256: analyticsSha256(source.nullToken ?? ''),
                ...(source.target ? { targetSha256: analyticsSha256(source.target) } : {}),
                ...(source.into ? { intoSha256: analyticsSha256({ into: source.into, base: source.admitted?.base ?? null }) } : {}),
              }
            : {
                sourceKind: source.kind,
                querySha256: analyticsSha256(source.sql),
                targetSha256: analyticsSha256(source.target),
                ...(source.kind === 'etl_query' && source.datasetDate ? { datasetDate: source.datasetDate } : {}),
                ...(source.kind === 'etl_query' && source.nullToken !== undefined ? { nullTokenSha256: analyticsSha256(source.nullToken) } : {}),
              },
      ...(source.kind === 'existing_version' ? { inputContractSha256: source.expectedContractSha256 } : {}),
    })),
    ...plan.fragments.map(fragment => ({
      key: fragmentNodeKey(fragment.id),
      kind: 'transform_fragment' as const,
      adapterVersion: 'analytics-job-fragment-v1',
      spec: {
        type: 'transform_fragment',
        fragment,
        request: plan.request,
        terminal: plan.terminal.kind === 'fragment' && plan.terminal.fragmentId === fragment.id,
      },
    })),
    {
      key: 'result',
      kind: 'result_publication' as const,
      adapterVersion: 'analytics-dataset-preparation-result-v1',
      spec: { type: 'result_publication', plan },
    },
  ];
  const edges: Array<{ fromKey: string; toKey: string; inputPosition: number; inputName: string }> = [];
  plan.fragments.forEach(fragment => fragment.dependencies.forEach((dependency, inputPosition) => {
    edges.push({
      fromKey: plan.sources.some(source => source.alias === dependency.sourceRef)
        ? sourceNodeKey(dependency.sourceRef)
        : fragmentNodeKey(dependency.sourceRef),
      toKey: fragmentNodeKey(fragment.id),
      inputPosition,
      inputName: dependency.alias,
    });
  }));
  const terminalKey = plan.terminal.kind === 'source'
    ? sourceNodeKey(plan.terminal.alias)
    : fragmentNodeKey(plan.terminal.fragmentId);
  edges.push({ fromKey: terminalKey, toKey: 'result', inputPosition: 0, inputName: 'primary' });
  const predecessors = new Map<string, string[]>();
  for (const edge of edges) predecessors.set(edge.toKey, [...(predecessors.get(edge.toKey) ?? []), edge.fromKey]);
  const reachable = new Set<string>();
  const visit = (key: string): void => {
    if (reachable.has(key)) return;
    reachable.add(key);
    for (const prior of predecessors.get(key) ?? []) visit(prior);
  };
  visit('result');
  const unused = nodes
    .filter(node => node.kind === 'source_resolution' || node.kind === 'transform_fragment')
    .map(node => node.key)
    .filter(key => !reachable.has(key));
  if (unused.length) fail('invalid_input', `Dataset preparation contains unused source/fragment nodes: ${unused.join(', ')}.`);
  return { nodes, edges };
}

function intersectHandling(versions: AnalyticsDatasetVersionDetail[]): AnalyticsHandlingContract {
  if (!versions.length) fail('invalid_input', 'Analytics fragment has no input versions.');
  let highest = versions[0].handling.classification;
  let highestRank = CLASSIFICATION_RANK.get(highest.toLowerCase());
  if (highestRank === undefined) fail('policy_denied', `Unknown classification ${highest}.`);
  for (const version of versions.slice(1)) {
    const rank = CLASSIFICATION_RANK.get(version.handling.classification.toLowerCase());
    if (rank === undefined) fail('policy_denied', `Unknown classification ${version.handling.classification}.`);
    if (rank > highestRank) {
      highest = version.handling.classification;
      highestRank = rank;
    }
  }
  const useOrder: AnalyticsDataRoomUse[] = ['local_answer', 'dashboard', 'publication'];
  const allowedUses = useOrder.filter(use => versions.every(version => version.handling.allowedUses.includes(use)));
  const allowPublication = versions.every(version => version.handling.allowPublication);
  let allowModelContext = versions.every(version => version.handling.allowModelContext);
  const policies = versions.map(version => version.handling.modelContextPolicy).filter((value): value is NonNullable<typeof value> => !!value);
  let modelContextPolicy: AnalyticsHandlingContract['modelContextPolicy'];
  if (allowModelContext && policies.length) {
    const allowedProviderLocalities = (
      ['device_local', 'amazon_managed_remote'] as const
    ).filter(locality => policies.every(policy => policy.allowedProviderLocalities.includes(locality)));
    const disclosures = new Set(policies.map(policy => policy.disclosurePolicyVersion));
    const endpoints = new Set(policies.map(policy => policy.endpointSha256).filter((value): value is string => !!value));
    if (!allowedProviderLocalities.length || disclosures.size !== 1 || endpoints.size > 1) {
      allowModelContext = false;
    } else {
      modelContextPolicy = {
        allowedProviderLocalities,
        disclosurePolicyVersion: [...disclosures][0],
        ...(endpoints.size ? { endpointSha256: [...endpoints][0] } : {}),
      };
    }
  }
  return {
    classification: highest,
    allowedUses,
    allowModelContext,
    allowPublication,
    ...(allowModelContext && modelContextPolicy ? { modelContextPolicy } : {}),
  };
}

function commonCoverage(versions: AnalyticsDatasetVersionDetail[]): AnalyticsDatasetContract['coverage'] {
  if (!versions.length) fail('invalid_input', 'Analytics fragment has no coverage inputs.');
  const partitionKinds = new Set(versions.map(version => version.coverage.partitionKind));
  if (partitionKinds.size !== 1) fail('integrity_failed', 'Analytics fragment inputs use incompatible coverage partition kinds.');
  let common = new Set(versions[0].coverage.completePartitions);
  for (const version of versions.slice(1)) {
    common = new Set([...common].filter(partition => version.coverage.completePartitions.includes(partition)));
  }
  const completePartitions = [...common].sort();
  if (!completePartitions.length) fail('integrity_failed', 'Analytics fragment inputs have no common complete partition.');
  const watermark = versions.map(version => version.coverage.watermark).sort()[0];
  return { partitionKind: versions[0].coverage.partitionKind, completePartitions, watermark };
}

function buildContract(
  datasetId: string,
  template: AnalyticsJobFragmentContractV1,
  versions: AnalyticsDatasetVersionDetail[],
): AnalyticsDatasetContract {
  if (versions.some(version => version.contract.domainKey !== template.domainKey)) {
    fail('policy_denied', 'R6.2b cannot invent cross-domain composition semantics; use inputs with the declared output domain.');
  }
  const metricKnown = versions.some(version => stableAnalyticsJson(version.contract.metric) === stableAnalyticsJson(template.metric));
  const regimeKnown = versions.some(version => stableAnalyticsJson(version.contract.regime) === stableAnalyticsJson(template.regime));
  if (!metricKnown || !regimeKnown) fail('policy_denied', 'Fragment metric or regime is not inherited from an exact input contract.');
  if (!versions.some(version => version.contract.countingKey === template.countingKey)
    || !versions.some(version => version.contract.unit === template.unit)) {
    fail('policy_denied', 'Fragment counting key or unit is not inherited from an exact input contract.');
  }
  const schemaSha256 = analyticsDatasetSchemaSha256(template.schema);
  const contract = {
    ...template,
    contractSha256: '',
    schemaSha256,
    status: 'active' as const,
    datasetId,
    datasetKind: 'derived' as const,
    scope: 'workspace' as const,
    coverage: commonCoverage(versions),
    handling: intersectHandling(versions),
  } as AnalyticsDatasetContract;
  contract.contractSha256 = analyticsDatasetContractSha256(contract);
  validateAnalyticsRelationalContract(contract);
  return contract;
}

function preparationSourceDefinition(input: {
  job: AnalyticsJobRecord;
  alias: string;
  sourceKind: 'sql_context' | 'datanet_etl' | 'import';
  target: AnalyticsDatasetPreparationTargetV1;
  modelContextRuntime?: AnalyticsModelContextRuntime;
}): { definition: AnalyticsDatasetDefinitionInput; expectedHeadRevision: number; quality: AnalyticsDatasetPreparationTargetV1['quality'] } {
  const { target } = input;
  const datasetId = target.datasetId
    ?? `ds_prep_${analyticsSha256({ jobId: input.job.id, alias: input.alias, sourceKind: input.sourceKind }).slice(0, 24)}`;
  const schemaSha256 = analyticsDatasetSchemaSha256(target.schema);
  const semanticIdentities = derivePreparationSemanticIdentities(target.metric, target.regime);
  const metric = semanticIdentities.metric;
  const regime = semanticIdentities.regime;
  const runtime = input.modelContextRuntime;
  const allowModelContext = Boolean(runtime && runtime.providerLocality !== 'external_remote');
  const handling: AnalyticsHandlingContract = {
    classification: target.classification ?? 'internal',
    allowedUses: ['local_answer', 'dashboard', ...(target.allowPublication ? ['publication' as const] : [])],
    allowModelContext,
    allowPublication: target.allowPublication === true,
    ...(allowModelContext && runtime ? {
      modelContextPolicy: {
        allowedProviderLocalities: [runtime.providerLocality as 'device_local' | 'amazon_managed_remote'],
        endpointSha256: runtime.endpointSha256,
        disclosurePolicyVersion: 'botboy-data-room-v1',
      },
    } : {}),
  };
  const contract = {
    contractVersion: 'analytics-dataset-contract-v1',
    contractSha256: '',
    status: 'active' as const,
    datasetId,
    datasetKind: 'source' as const,
    scope: 'workspace' as const,
    domainKey: target.domainKey,
    schemaSha256,
    schema: target.schema,
    metric,
    regime,
    countingKey: target.countingKey,
    unit: target.metric.unit,
    grain: target.grain,
    availableDimensions: target.availableDimensions,
    timeField: target.timeField,
    timeZone: target.timeZone,
    coverage: target.coverage,
    handling,
    ...(target.relational ? { relational: target.relational } : {}),
  } as AnalyticsDatasetContract;
  contract.contractSha256 = analyticsDatasetContractSha256(contract);
  if (contract.relational) validateAnalyticsRelationalContract(contract);
  return {
    definition: {
      id: datasetId,
      name: target.name,
      description: target.description,
      kind: 'source',
      scope: 'workspace',
      domainKey: target.domainKey,
      ownerId: input.job.ownerId,
      lifecycle: 'active',
      catalogVisibility: 'job_scoped',
      sourceKind: input.sourceKind,
      sourceFormat: input.sourceKind === 'datanet_etl' ? 'tsv' : 'canonical_json',
      definition: {
        adapter: input.sourceKind === 'datanet_etl'
          ? 'datanet_etl_query'
          : input.sourceKind === 'sql_context'
            ? 'sql_context_query'
            : 'local_file',
        adapterVersion: input.sourceKind === 'import' ? ANALYTICS_LOCAL_FILE_PARSER_VERSION : 'analytics-dataset-preparation-v1',
        sourceQueryOwner: 'analytics-job',
        answer: target.answer,
      },
      contract,
      retention: target.retention ?? RETENTION,
    },
    expectedHeadRevision: target.expectedHeadRevision ?? 0,
    quality: target.quality ?? [],
  };
}

function validateFragmentAnswer(
  fragment: AnalyticsJobFragmentV1,
  contract: AnalyticsDatasetContract,
  request: AnalyticsRequest,
  terminal: boolean,
): void {
  const fields = new Set(contract.schema.map(field => field.name));
  const metricField = contract.schema.find(field => field.name === fragment.answer.metricValueColumn);
  if (fragment.answer.metricId !== contract.metric.id || !metricField
    || (metricField.logicalType !== 'integer' && metricField.logicalType !== 'number')) {
    fail('integrity_failed', `Fragment ${fragment.id} answer recipe differs from its metric contract.`);
  }
  if (!fragment.answer.filterableFields.includes(contract.timeField)
    || request.filters.some(filter => !fragment.answer.filterableFields.includes(filter.field))
    || fragment.answer.filterableFields.some(field => !fields.has(field))
    || fragment.answer.rowDimensions.some(field => !fields.has(field))
    || fragment.answer.stableOrder.some(order => !fields.has(order.field))) {
    fail('integrity_failed', `Fragment ${fragment.id} answer recipe omits or invents a query field.`);
  }
  if (terminal && stableAnalyticsJson(fragment.answer.rowDimensions) !== stableAnalyticsJson(request.dimensions)) {
    fail('integrity_failed', `Terminal fragment ${fragment.id} answer dimensions differ from the owner request.`);
  }
}

function validateTerminalRequest(
  requestInput: AnalyticsRequest,
  dataset: AnalyticsDatasetDetail,
  version: AnalyticsDatasetVersionDetail,
  coverageRequirement: 'complete' | 'observed' = 'complete',
): AnalyticsRequest {
  const request = normalizeAnalyticsRequest({
    ...requestInput,
    datasetId: dataset.id,
    versionId: version.id,
    requiredContractSha256: version.contractSha256,
    use: 'local_answer',
    resultLimit: Math.min(requestInput.resultLimit ?? JOB_RESULT_LIMIT, JOB_RESULT_LIMIT),
  });
  const contract = version.contract;
  if (request.domainKey !== contract.domainKey
    || stableAnalyticsJson(request.metric) !== stableAnalyticsJson(contract.metric)
    || stableAnalyticsJson(request.regime) !== stableAnalyticsJson(contract.regime)
    || request.countingKey !== contract.countingKey
    || request.requiredGrain !== contract.grain
    || request.timeZone !== contract.timeZone
    || request.dimensions.some(dimension => !contract.availableDimensions.includes(dimension))) {
    fail('integrity_failed', 'Terminal request semantics differ from the exact result contract.');
  }
  const covered = new Set(coverageRequirement === 'observed'
    ? contract.coverage.observedPartitions ?? contract.coverage.completePartitions
    : contract.coverage.completePartitions);
  if (enumerateAnalyticsPartitions(
    request.dateRange.start,
    request.dateRange.end,
    contract.coverage.partitionKind,
  ).some(partition => !covered.has(partition))) {
    fail(
      'integrity_failed',
      coverageRequirement === 'observed'
        ? 'Terminal result lacks observed requested coverage.'
        : 'Terminal result lacks complete requested coverage.',
    );
  }
  return request;
}

function predecessors(observation: AnalyticsJobObservation, node: AnalyticsJobNodeRecord): AnalyticsJobNodeRecord[] {
  const current = new Map(currentPlanNodes(observation).map(item => [item.id, item]));
  return observation.edges
    .filter(edge => edge.planRevision === node.planRevision && edge.toNodeId === node.id)
    .sort((left, right) => left.inputPosition - right.inputPosition)
    .map(edge => {
      const prior = current.get(edge.fromNodeId);
      if (!prior || prior.state !== 'succeeded') fail('integrity_failed', `Node ${node.id} predecessor is not complete.`);
      return prior;
    });
}

function errorProjection(error: unknown): { code: string; message: string; retryClass: 'transient' | 'definition_change'; nextAction: string } {
  // A failure that names its own recovery keeps it: its message may quote
  // result columns (e.g. "network") that the transient regex would misread.
  const specific = error instanceof AnalyticsJobError ? (error as AnalyticsJobError & { nextAction?: unknown }).nextAction : undefined;
  if (error instanceof AnalyticsJobError && typeof specific === 'string' && specific.trim()) {
    return {
      code: error.code,
      message: error.message,
      retryClass: error.code === 'conflict' ? 'transient' : 'definition_change',
      nextAction: specific,
    };
  }
  const rawMessage = error instanceof Error ? error.message : String(error);
  if (/timeout|timed out|ECONN|EAI_AGAIN|fetch failed|network|HTTP 5|service unavailable|overloaded/i.test(rawMessage)) {
    return {
      code: 'conflict',
      message: rawMessage,
      retryClass: 'transient',
      nextAction: 'Resume this exact job after the transient planner or local service failure clears.',
    };
  }
  if (error instanceof AnalyticsDataRoomError) {
    const transient = error.code === 'conflict' || error.code === 'query_timeout';
    return {
      code: error.code,
      message: error.message,
      retryClass: transient ? 'transient' : 'definition_change',
      nextAction: transient
        ? 'Resume this exact job after the transient Data Room conflict clears.'
        : 'Revise the requested existing-version composition; do not bypass it with remote or generic tools.',
    };
  }
  if (error instanceof AnalyticsJobError) {
    return {
      code: error.code,
      message: error.message,
      retryClass: error.code === 'conflict' ? 'transient' : 'definition_change',
      nextAction: error.code === 'conflict'
        ? 'Resume this exact job after the transient conflict clears.'
        : 'Revise the supported existing-version request or wait for the next capability phase.',
    };
  }
  return {
    code: 'integrity_failed',
    message: error instanceof Error ? error.message : String(error),
    retryClass: 'definition_change',
    nextAction: 'Inspect the exact job node and immutable input receipts before retrying.',
  };
}

export function createAnalyticsJobService(input: {
  db: Database.Database;
  store: AnalyticsDataRoomStore;
  jobStore: AnalyticsJobStore;
  planner: AnalyticsJobPlanner;
  derivation: AnalyticsDerivationService;
  localQuery: AnalyticsLocalQueryEngine;
  dataRoom?: AnalyticsDataRoomService;
  sqlRunner?: AnalyticsPreparationSqlRunner;
  etlRunner?: QueryRunner;
  modelContextRuntime?: AnalyticsModelContextRuntime;
  /** Strict XLSX workbook reader for local-file sources. */
  documentParser?: DocumentParser;
  localFilePolicy?: AnalyticsLocalFilePolicy;
  now?: () => Date;
  waitMs?: number;
}): AnalyticsJobService {
  const now = input.now ?? (() => new Date());
  const waitMs = Math.max(100, Math.min(ANALYTICS_JOB_MAX_FOREGROUND_WAIT_MS, input.waitMs ?? DEFAULT_WAIT_MS));
  const localFilePolicy = input.localFilePolicy ?? defaultAnalyticsLocalFilePolicy();
  // Same model-context rule as newly prepared datasets: without a local or
  // managed provider, file facts reach the model as structure only. Read per
  // use: the active provider can change at runtime (Settings → AI model).
  const withholdFileValues = (): boolean =>
    !input.modelContextRuntime || input.modelContextRuntime.providerLocality === 'external_remote';
  let active: Promise<number> | null = null;
  let activeController: AbortController | null = null;
  let activeJobId: string | null = null;
  let wakeTimer: ReturnType<typeof setTimeout> | null = null;
  let stopping = false;

  function scheduleWake(delayMs: number): void {
    if (stopping) return;
    if (wakeTimer) clearTimeout(wakeTimer);
    wakeTimer = setTimeout(() => {
      wakeTimer = null;
      wake();
    }, Math.max(50, delayMs));
  }

  const timestamp = (): string => now().toISOString();

  function observationReceipt(
    observation: AnalyticsJobObservation,
    action: AnalyticsJobToolReceipt['action'],
    actionRequestId?: string,
    includeAnswer = true,
  ): AnalyticsJobToolReceipt {
    const nodes = currentPlanNodes(observation);
    const succeededNodes = nodes.filter(node => node.state === 'succeeded').length;
    const activeNodes = nodes.filter(node => node.state === 'ready' || node.state === 'running' || node.state === 'planned').length;
    const blockedNodes = nodes.filter(node => node.state === 'blocked' || node.state === 'failed').length;
    const completedConsumers = nodes
      .filter(node => (node.kind === 'answer_delivery' || node.kind === 'retain_delivery') && node.state === 'succeeded')
      .map(node => node.kind === 'answer_delivery' ? 'answer' : 'retain_dataset');
    const answerNode = nodes.find(node => node.kind === 'answer_delivery' && node.state === 'succeeded');
    const answerAttempt = answerNode ? [...observation.attempts].reverse()
      .find(attempt => attempt.nodeId === answerNode.id && attempt.status === 'succeeded') : undefined;
    const answer = includeAnswer && isRecord(answerAttempt?.receipt?.answer)
      ? answerAttempt!.receipt!.answer as AnalyticsJobToolReceipt['answer']
      : undefined;
    const status: AnalyticsJobToolReceipt['status'] = observation.job.status === 'complete'
      ? 'completed'
      : observation.job.status === 'planning' || observation.job.status === 'running' || observation.job.status === 'delivering'
        ? 'in_progress'
        : observation.job.status;
    const claim: AnalyticsJobToolReceipt['responseGuidance']['claim'] = status === 'completed'
      ? 'completed'
      : status === 'needs_input'
        ? 'needs_input'
        : status === 'needs_approval'
          ? 'needs_approval'
          : status === 'cancelled'
            ? 'cancelled'
            : status === 'failed'
              ? 'failed'
              : 'not_complete';
    const requiredAnchors = [observation.job.id];
    if (observation.result) {
      requiredAnchors.push(observation.result.id, observation.result.primaryVersionId);
    }
    const nextAction = observation.job.nextAction
      ?? (status === 'in_progress'
        ? `Observe ${observation.job.id}; do not repeat source or composition calls.`
        : status === 'completed'
          ? 'Use the exact result receipt; no additional source call is required.'
          : 'Follow the structured job state.');
    const payload = {
      trust: 'verified_analytics_job_receipt' as const,
      status,
      action,
      jobId: observation.job.id,
      ownerRequestId: observation.job.ownerRequestId,
      ...(actionRequestId ? { actionRequestId } : {}),
      jobRevision: observation.job.stateRevision,
      intentSha256: observation.job.intentSha256,
      ...(observation.result ? { resultId: observation.result.id, result: observation.result.manifest } : {}),
      ...(answer ? { answer } : {}),
      progress: { totalNodes: nodes.length, succeededNodes, activeNodes, blockedNodes, completedConsumers },
      ...(observation.job.questionReceipt ? { question: observation.job.questionReceipt } : {}),
      ...(observation.job.errorCode && observation.job.errorMessage ? {
        error: {
          code: observation.job.errorCode,
          message: observation.job.errorMessage,
          nextAction,
        },
      } : {}),
      responseGuidance: { claim, requiredAnchors, nextAction },
    };
    return { ...payload, receiptSha256: analyticsSha256(payload) };
  }

  function observe(jobId: string, actionRequestId?: string, options: { includeAnswer?: boolean } = {}): AnalyticsJobToolReceipt {
    return observationReceipt(input.jobStore.observe(jobId), 'observe', actionRequestId, options.includeAnswer !== false);
  }

  async function waitForOutcome(
    jobId: string,
    action: AnalyticsJobToolReceipt['action'],
    actionRequestId: string,
    signal?: AbortSignal,
  ): Promise<AnalyticsJobToolReceipt> {
    const startedAt = Date.now();
    while (Date.now() - startedAt < waitMs && !signal?.aborted) {
      const receipt = observationReceipt(input.jobStore.observe(jobId), action, actionRequestId);
      if (receipt.status !== 'in_progress' && receipt.status !== 'cancel_requested') {
        return receipt;
      }
      wake();
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    return observationReceipt(input.jobStore.observe(jobId), action, actionRequestId);
  }

  async function planJob(job: AnalyticsJobRecord, signal: AbortSignal): Promise<void> {
    if (job.intent.version === 2 && job.intent.mode === 'dataset_preparation') {
      const plan = nodesForPreparation(job.intent.plan);
      input.jobStore.commitPlan({
        jobId: job.id,
        expectedStateRevision: job.stateRevision,
        nodes: plan.nodes,
        edges: plan.edges,
      });
      return;
    }
    const outcome = await input.planner.plan({
      jobId: job.id,
      ownerMessage: job.intent.goal,
      ...(job.questionReceipt ? { priorQuestion: job.questionReceipt } : {}),
      signal,
    });
    const current = input.jobStore.getJob(job.id);
    if (!current || current.status !== 'planning') return;
    if (outcome.state === 'needs_input') {
      input.jobStore.setNeedsInput({
        jobId: current.id,
        question: {
          version: 1,
          question: outcome.question.prompt,
          answerMode: 'choice',
          choices: outcome.question.choices,
        },
        nextAction: outcome.nextAction,
      });
      return;
    }
    if (outcome.state === 'blocked') {
      input.jobStore.blockPlanning({
        jobId: current.id,
        code: outcome.code,
        message: outcome.error,
        nextAction: outcome.nextAction,
      });
      return;
    }
    const plan = nodesForPlan(outcome.plan);
    input.jobStore.commitPlan({
      jobId: current.id,
      expectedStateRevision: current.stateRevision,
      nodes: plan.nodes,
      edges: plan.edges,
    });
  }

  interface PreparedLocalFile {
    admission: AnalyticsLocalFileAdmissionV1;
    columns: string[];
    rows: AnalyticsDataCell[][];
    fileRowCount: number;
    /** Coverage of the version that will be published. */
    coverage: AnalyticsDatasetContract['coverage'];
    nullToken: string;
    table: AnalyticsLocalFileCompleteReceipt['table'];
    base?: { versionId?: string; contentSha256?: string; keptRows: number; replacedPartitions: string[] };
  }

  function laterTimestamp(left: string, right: string): string {
    return Date.parse(right) > Date.parse(left) ? right : left;
  }

  function readVersionRows(versionId: string, schema: AnalyticsDatasetContract['schema']): AnalyticsDataCell[][] {
    const database = new SqliteDatabase(input.store.getVerifiedMaterializedPath(versionId, 'local_answer'), { readonly: true, fileMustExist: true });
    try {
      database.pragma('query_only = ON');
      const raw = database.prepare('SELECT * FROM data').all() as Array<Record<string, AnalyticsDataCell>>;
      return raw.map(row => schema.map(field => {
        const value = row[field.name] ?? null;
        return field.logicalType === 'boolean' && value !== null ? value === 1 : value;
      }));
    } finally {
      database.close();
    }
  }

  /**
   * Read, type, and coverage-check one local file against its contract. Used
   * identically at admission (no pins; zero effects) and at execution (pins
   * must still match). Failures before a job exist are invalid_input or
   * policy_denied with exact issues; nothing here authors plan semantics.
   */
  async function prepareLocalFile(
    request: AnalyticsRequest,
    source: LocalFileSource,
    label: string,
    signal: AbortSignal | undefined,
    pinned: AnalyticsLocalFileAdmissionV1 | undefined,
    options: { readBaseRows: boolean },
  ): Promise<PreparedLocalFile> {
    let snapshot: ReturnType<typeof readAnalyticsLocalFile>;
    let table: Awaited<ReturnType<typeof readAnalyticsLocalTable>>;
    try {
      snapshot = readAnalyticsLocalFile(resolveAnalyticsLocalFile(source, localFilePolicy, label), label);
      if (pinned && (snapshot.sha256 !== pinned.sha256 || snapshot.size !== pinned.bytes)) {
        fail('integrity_failed', `${source.alias}: the file changed after this import was admitted. Call create again so BotBoy imports its current exact bytes.`);
      }
      table = await readAnalyticsLocalTable(snapshot, source, { documentParser: input.documentParser, signal, tempRoot: localFilePolicy.tempRoot }, label);
    } catch (error) {
      return localFileFailure(error);
    }
    const into = source.into;
    let dataset: AnalyticsDatasetDetail | null = null;
    let schema: AnalyticsDatasetContract['schema'];
    let timeFieldName: string;
    let timeZone: string;
    let fileCoverage: AnalyticsDatasetContract['coverage'];
    if (source.target) {
      schema = source.target.schema;
      timeFieldName = source.target.timeField;
      timeZone = source.target.timeZone;
      fileCoverage = source.target.coverage;
    } else {
      dataset = input.store.getDataset(into!.datasetId);
      const intoPath = `${label}.into`;
      if (!dataset || dataset.catalogVisibility !== 'catalog' || dataset.lifecycle !== 'active') {
        fail('invalid_input', `${intoPath}.datasetId is not one active catalog dataset.`, dataRoomIssue({
          code: 'unknown_dataset', path: `${intoPath}.datasetId`,
          message: 'into.datasetId must be the exact ds_* ID of one active ready dataset from list_data_room_datasets; use target to create a new dataset instead.',
          expected: { kind: 'relation', description: 'An active catalog dataset ID.' }, received: into!.datasetId, includeReceivedValue: true,
        }));
      }
      if (dataset.kind !== 'source' || dataset.sourceKind !== 'import' || dataset.sourceFormat !== 'canonical_json') {
        fail('invalid_input', `${intoPath}.datasetId is not a file-born dataset.`, dataRoomIssue({
          code: 'dataset_adapter_mismatch', path: `${intoPath}.datasetId`,
          message: `Dataset ${dataset.id} is acquired by its own ${dataset.kind === 'derived' ? 'derivation' : `${dataset.sourceKind} query`} adapter, so a file cannot become its next version. Refresh it through that adapter, or create a new dataset from this file with target.`,
          expected: { kind: 'relation', description: 'A source dataset whose versions come from files (sourceKind import, canonical rows).' }, received: dataset.sourceKind, includeReceivedValue: true,
        }));
      }
      const headRevision = dataset.head?.headRevision ?? 0;
      if (pinned?.base && (dataset.definitionRevision !== pinned.base.definitionRevision
        || dataset.contractSha256 !== pinned.base.contractSha256
        || headRevision !== pinned.base.headRevision)) {
        fail('conflict', `Dataset ${dataset.id} changed after this import was admitted. Call create again against its current head.`);
      }
      if (into!.expectedHeadRevision !== undefined && into!.expectedHeadRevision !== headRevision) {
        fail('invalid_input', `${intoPath}.expectedHeadRevision is stale.`, dataRoomIssue({
          code: 'head_revision_mismatch', path: `${intoPath}.expectedHeadRevision`,
          message: `Dataset ${dataset.id} is at head revision ${headRevision}. Use that value or omit expectedHeadRevision.`,
          expected: { kind: 'literal', value: headRevision }, received: into!.expectedHeadRevision, includeReceivedValue: true,
        }));
      }
      if (into!.coverage.partitionKind !== dataset.contract.coverage.partitionKind) {
        fail('invalid_input', `${intoPath}.coverage.partitionKind differs from the dataset.`, dataRoomIssue({
          code: 'partition_kind_mismatch', path: `${intoPath}.coverage.partitionKind`,
          message: `Dataset ${dataset.id} uses ${dataset.contract.coverage.partitionKind} coverage partitions.`,
          expected: { kind: 'literal', value: dataset.contract.coverage.partitionKind }, received: into!.coverage.partitionKind, includeReceivedValue: true,
        }));
      }
      schema = dataset.contract.schema;
      timeFieldName = dataset.contract.timeField;
      timeZone = dataset.contract.timeZone;
      fileCoverage = into!.coverage;
    }
    let typed: ReturnType<typeof typeAnalyticsLocalTable>;
    try {
      typed = typeAnalyticsLocalTable(table, schema, source.nullToken, {
        source: label,
        schema: source.target ? `${label}.target.schema` : `${label}.into.datasetId`,
        ...(dataset ? { fixedDatasetId: dataset.id } : {}),
      }, { withholdValues: withholdFileValues() });
    } catch (error) {
      return localFileFailure(error);
    }
    const coveragePath = source.target ? `${label}.target.coverage` : `${label}.into.coverage`;
    if (!typed.rows.length) {
      fail('invalid_input', `${label}.path has no data rows.`, dataRoomIssue({
        code: 'empty_table', path: `${label}.path`,
        message: `${table.sheet ? `Sheet ${JSON.stringify(table.sheet)}` : 'The file'} has a header but no data rows${table.blankRowsSkipped ? ` (${table.blankRowsSkipped} blank rows skipped)` : ''}; there is nothing to import.`,
        expected: { kind: 'range', type: 'integer', minimum: 1 }, received: 0, includeReceivedValue: true,
      }));
    }
    const timeIndex = schema.findIndex(field => field.name === timeFieldName);
    const timeField = schema[timeIndex];
    const partitionOf = (row: AnalyticsDataCell[]): string => analyticsCoveragePartition(row[timeIndex], timeField, timeZone, fileCoverage.partitionKind)!;
    const filePartitions = new Set(typed.rows.map(partitionOf));
    const declaredObserved = new Set(fileCoverage.observedPartitions ?? fileCoverage.completePartitions);
    const undeclared = [...filePartitions].filter(value => !declaredObserved.has(value)).sort();
    const absent = [...declaredObserved].filter(value => !filePartitions.has(value)).sort();
    const coverageIssues: DataRoomFailureIssueV1[] = [];
    if (undeclared.length || absent.length) {
      const actual = compactAnalyticsPartitionRanges(filePartitions, fileCoverage.partitionKind);
      coverageIssues.push(dataRoomIssue({
        code: 'observed_coverage_mismatch', path: coveragePath,
        message: `The file's ${timeFieldName} values cover exactly ${filePartitions.size} ${fileCoverage.partitionKind} partition(s) in ${actual.length} range(s): ${actual.slice(0, 40).map(range => range.start === range.end ? range.start : `${range.start}..${range.end}`).join(', ')}${actual.length > 40 ? ', …' : ''}. Declare observed coverage exactly (completeRanges may be stricter).${undeclared.length ? ` Present but undeclared: ${undeclared.slice(0, 5).join(', ')}.` : ''}${absent.length ? ` Declared but absent: ${absent.slice(0, 5).join(', ')}.` : ''}`,
        expected: { kind: 'relation', description: 'Declared observed partitions equal the file rows\u2019 actual partitions.' }, received: fileCoverage.observedPartitions?.length ?? fileCoverage.completePartitions.length, includeReceivedValue: true,
      }));
    }
    const latest = [...filePartitions].sort().at(-1)!;
    const watermarkPartition = analyticsCoveragePartition(fileCoverage.watermark, { name: 'watermark', logicalType: 'timestamp', nullable: false }, timeZone, fileCoverage.partitionKind);
    if (watermarkPartition !== null && watermarkPartition < latest) coverageIssues.push(dataRoomIssue({
      code: 'watermark_before_data', path: `${coveragePath}.watermark`,
      message: `The latest ${timeFieldName} partition is ${latest}; the watermark must be at or after it.`,
      expected: { kind: 'relation', description: `An ISO timestamp on or after ${latest} in ${timeZone}.` }, received: fileCoverage.watermark, includeReceivedValue: true,
    }));
    if (coverageIssues.length) fail('invalid_input', `${coveragePath} does not match the file rows.`, coverageIssues);

    let rows = typed.rows;
    let coverage = fileCoverage;
    let base: PreparedLocalFile['base'];
    let baseVersion: AnalyticsDatasetVersionDetail | null = null;
    if (dataset && into!.mode === 'merge_partitions' && dataset.head) {
      baseVersion = input.store.getDatasetVersion(dataset.head.versionId);
      if (!baseVersion) fail('integrity_failed', `Dataset ${dataset.id} head version disappeared.`);
      if (pinned?.base && pinned.base.versionId !== baseVersion.id) {
        fail('conflict', `Dataset ${dataset.id} changed after this import was admitted. Call create again against its current head.`);
      }
      const baseObserved = baseVersion.coverage.observedPartitions ?? baseVersion.coverage.completePartitions;
      const replacedPartitions = baseObserved.filter(value => filePartitions.has(value)).sort();
      coverage = {
        partitionKind: fileCoverage.partitionKind,
        observedPartitions: [...new Set([...baseObserved, ...filePartitions])].sort(),
        completePartitions: [...new Set([
          ...baseVersion.coverage.completePartitions.filter(value => !filePartitions.has(value)),
          ...fileCoverage.completePartitions,
        ])].sort(),
        watermark: laterTimestamp(baseVersion.coverage.watermark, fileCoverage.watermark),
      };
      let keptRows = 0;
      if (options.readBaseRows) {
        const kept = readVersionRows(baseVersion.id, schema).filter(row => !filePartitions.has(partitionOf(row)));
        keptRows = kept.length;
        const ordered = [...kept, ...typed.rows].map((row, index) => ({ row, index, partition: partitionOf(row) }));
        ordered.sort((left, right) => (left.partition < right.partition ? -1 : left.partition > right.partition ? 1 : left.index - right.index));
        rows = ordered.map(value => value.row);
      }
      base = { versionId: baseVersion.id, contentSha256: baseVersion.materializedSha256, keptRows, replacedPartitions };
    }
    if (dataset) {
      const issues = terminalRequestIssues(request, {
        domainKey: dataset.contract.domainKey,
        metric: dataset.contract.metric,
        regime: dataset.contract.regime,
        countingKey: dataset.contract.countingKey,
        grain: dataset.contract.grain,
        timeZone: dataset.contract.timeZone,
        availableDimensions: dataset.contract.availableDimensions,
        coverage,
        identitySource: `dataset ${dataset.id} (its list_data_room_datasets card metric/regime objects)`,
      });
      if (issues.length) fail('invalid_input', `plan.request does not match dataset ${dataset.id} after this import.`, issues);
    }
    return {
      admission: {
        resolvedPath: snapshot.resolvedPath,
        fileName: snapshot.fileName,
        format: snapshot.format,
        sha256: snapshot.sha256,
        bytes: snapshot.size,
        ...(table.sheet !== undefined ? { sheet: table.sheet } : {}),
        ...(table.headerRow !== undefined ? { headerRow: table.headerRow } : {}),
        fileRowCount: typed.rows.length,
        ...(dataset ? {
          base: {
            definitionRevision: dataset.definitionRevision,
            contractSha256: dataset.contractSha256,
            headRevision: dataset.head?.headRevision ?? 0,
            ...(dataset.head ? { versionId: dataset.head.versionId } : {}),
            ...(baseVersion ? { contentSha256: baseVersion.materializedSha256 } : {}),
          },
        } : {}),
      },
      columns: typed.columns,
      rows,
      fileRowCount: typed.rows.length,
      coverage,
      nullToken: source.nullToken ?? '',
      table: {
        shortRows: table.shortRows,
        blankRowsSkipped: table.blankRowsSkipped,
        rowsAboveHeader: table.rowsAboveHeader,
        formulaCells: table.formulaCells,
      },
      ...(base ? { base } : {}),
    };
  }

  /** Pin every local file's exact bytes and base head before any durable job exists. */
  async function admitLocalFileSources(
    plan: AnalyticsDatasetPreparationPlanV1,
    signal: AbortSignal | undefined,
  ): Promise<AnalyticsDatasetPreparationPlanV1> {
    if (!plan.sources.some(source => source.kind === 'local_file')) return plan;
    const sources: AnalyticsDatasetPreparationSourceV1[] = [];
    for (const [index, source] of plan.sources.entries()) {
      if (source.kind !== 'local_file') {
        sources.push(source);
        continue;
      }
      const label = `plan.sources[${index}]`;
      let prepared: PreparedLocalFile;
      try {
        prepared = await prepareLocalFile(plan.request, source, label, signal, undefined, { readBaseRows: false });
      } catch (error) {
        const carrier = error as { issues?: unknown[] } | null;
        if (Array.isArray(carrier?.issues) && carrier!.issues.length) throw error;
        // No job exists yet, so even an infrastructure read failure has zero
        // effects; say so structurally instead of implying unknown work.
        fail('invalid_input', `${label} could not be read for admission.`, dataRoomIssue({
          code: 'local_file_unreadable', path: `${label}.path`,
          message: `BotBoy could not read or stage this file for import: ${error instanceof Error ? error.message : String(error)} Nothing was created; retry, or name another copy of the file.`,
          expected: { kind: 'relation', description: 'A readable local file BotBoy can snapshot.' }, received: source.path,
        }));
      }
      sources.push({ ...source, admitted: prepared.admission });
    }
    return { ...plan, sources };
  }

  async function inspectLocalFile(locator: AnalyticsLocalFileLocator, options: { signal?: AbortSignal } = {}): Promise<AnalyticsLocalFileInspection> {
    try {
      const snapshot = readAnalyticsLocalFile(resolveAnalyticsLocalFile(locator, localFilePolicy, 'file'), 'file');
      const table = await readAnalyticsLocalTable(snapshot, locator, {
        documentParser: input.documentParser,
        signal: options.signal,
        tempRoot: localFilePolicy.tempRoot,
      }, 'file');
      const profile = profileAnalyticsLocalTable(table, locator.nullToken);
      const samplesWithheld = withholdFileValues();
      return {
        file: { name: table.fileName, format: table.format, bytes: table.size, sha256: table.sha256 },
        ...(table.sheets ? { sheets: table.sheets } : {}),
        ...(table.sheet !== undefined ? { sheet: table.sheet } : {}),
        ...(table.headerRow !== undefined ? { headerRow: table.headerRow } : {}),
        nullToken: locator.nullToken ?? '',
        rowCount: profile.rowCount,
        blankRowsSkipped: table.blankRowsSkipped,
        rowsAboveHeader: table.rowsAboveHeader,
        formulaCells: table.formulaCells,
        shortRows: table.shortRows,
        samplesWithheld,
        columns: samplesWithheld
          ? profile.columns.map(({ samples: _samples, minimum: _minimum, maximum: _maximum, ...column }) => ({ ...column, samples: [] }))
          : profile.columns,
      };
    } catch (error) {
      return localFileFailure(error);
    }
  }

  async function executeLocalFileSource(
    observation: AnalyticsJobObservation,
    node: AnalyticsJobNodeRecord,
    attemptId: string,
    source: LocalFileSource,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    if (!input.dataRoom) fail('unsupported', 'The Data Room writer is unavailable to the existing analytics job service.');
    const intent = observation.job.intent;
    if (!('mode' in intent) || intent.mode !== 'dataset_preparation') fail('integrity_failed', 'Local-file source belongs to a non-preparation job.');
    if (!source.admitted) fail('integrity_failed', 'Local-file source lacks its admission byte pins; call create again.');
    if (source.into && source.admitted.base) {
      // A crash after the store commit but before succeedNode must converge on
      // this job's own version instead of reporting the moved head as a conflict.
      const base = source.admitted.base;
      const head = input.store.getDataset(source.into.datasetId)?.head;
      const receipt = head?.promotionReceipt as { previousHeadRevision?: number; previousVersionId?: string | null } | undefined;
      const ownCommit = head && head.headRevision === base.headRevision + 1
        && receipt?.previousHeadRevision === base.headRevision
        && (receipt.previousVersionId ?? undefined) === base.versionId
        && input.db.prepare(`
          SELECT 1 FROM analytics_dataset_runs
          WHERE dataset_id = ? AND output_version_id = ? AND request_sha256 = ? AND status = 'completed'
        `).get(source.into.datasetId, head.versionId, observation.job.intentSha256);
      const version = ownCommit ? input.store.getDatasetVersion(head!.versionId) : null;
      if (version) {
        input.store.verifyVersion(version.id, 'local_answer');
        input.jobStore.succeedNode({
          nodeId: node.id,
          attemptId,
          outputDatasetId: version.datasetId,
          outputVersionId: version.id,
          receipt: {
            kind: 'local_file', fileName: source.admitted.fileName, format: source.admitted.format,
            inputSha256: source.admitted.sha256, inputBytes: source.admitted.bytes,
            parserVersion: ANALYTICS_LOCAL_FILE_PARSER_VERSION, mode: source.into.mode,
            fileRows: source.admitted.fileRowCount, rowCount: version.rowCount,
            datasetId: version.datasetId, versionId: version.id,
            contentSha256: version.materializedSha256, idempotent: true, replayedCommittedVersion: true,
          },
        });
        return;
      }
    }
    const index = intent.plan.sources.findIndex(value => value.alias === source.alias);
    const prepared = await prepareLocalFile(intent.plan.request, source, `plan.sources[${index}]`, signal, source.admitted, { readBaseRows: true });
    const admitted = prepared.admission;
    const mode = source.target ? 'new_dataset' as const : source.into!.mode;
    const complete: AnalyticsLocalFileCompleteReceipt = {
      parserVersion: ANALYTICS_LOCAL_FILE_PARSER_VERSION,
      completeToEof: true as const,
      format: admitted.format,
      fileName: admitted.fileName,
      inputSha256: admitted.sha256,
      inputBytes: admitted.bytes,
      ...(admitted.sheet !== undefined ? { sheet: admitted.sheet } : {}),
      ...(admitted.headerRow !== undefined ? { headerRow: admitted.headerRow } : {}),
      nullToken: prepared.nullToken,
      fileRowCount: prepared.fileRowCount,
      rowCount: prepared.rows.length,
      rowsetSha256: analyticsSha256({ columns: prepared.columns, rows: prepared.rows, rowCount: prepared.rows.length }),
      schemaSha256: '',
      mode,
      table: prepared.table,
      ...(prepared.base?.versionId ? {
        base: {
          versionId: prepared.base.versionId,
          contentSha256: prepared.base.contentSha256!,
          keptRows: prepared.base.keptRows,
          replacedPartitions: prepared.base.replacedPartitions,
        },
      } : {}),
    };
    const sourceReceipt = {
      sourceKind: 'import' as const,
      sourceId: admitted.sha256,
      producerVersion: ANALYTICS_LOCAL_FILE_PARSER_VERSION,
      acquiredAt: timestamp(),
    };
    let promoted: ReturnType<AnalyticsDataRoomService['ingestLocalFileRows']>;
    if (source.target) {
      const definition = preparationSourceDefinition({
        job: observation.job,
        alias: source.alias,
        sourceKind: 'import',
        target: source.target,
        modelContextRuntime: input.modelContextRuntime,
      });
      const existing = input.store.getDataset(definition.definition.id);
      const expectedHeadRevision = source.target.expectedHeadRevision ?? existing?.head?.headRevision ?? definition.expectedHeadRevision;
      input.dataRoom.registerDataset(definition.definition);
      promoted = input.dataRoom.ingestLocalFileRows({
        datasetId: definition.definition.id,
        expectedHeadRevision,
        materializedAt: timestamp(),
        sourceReceipt,
        quality: definition.quality ?? [],
        trigger: 'agent',
        requestSha256: observation.job.intentSha256,
        columns: prepared.columns,
        rows: prepared.rows,
        complete: { ...complete, schemaSha256: definition.definition.contract.schemaSha256 },
      });
    } else {
      const dataset = input.store.getDataset(source.into!.datasetId)!;
      promoted = input.dataRoom.ingestLocalFileRows({
        datasetId: dataset.id,
        expectedHeadRevision: admitted.base!.headRevision,
        materializedAt: timestamp(),
        sourceReceipt,
        quality: [],
        trigger: 'agent',
        requestSha256: observation.job.intentSha256,
        columns: prepared.columns,
        rows: prepared.rows,
        complete: { ...complete, schemaSha256: dataset.contract.schemaSha256 },
        coverageRevision: {
          expectedDefinitionRevision: admitted.base!.definitionRevision,
          coverage: prepared.coverage,
        },
      });
    }
    input.store.verifyVersion(promoted.version.id, 'local_answer');
    input.jobStore.succeedNode({
      nodeId: node.id,
      attemptId,
      outputDatasetId: promoted.datasetId,
      outputVersionId: promoted.version.id,
      receipt: {
        kind: 'local_file', fileName: admitted.fileName, format: admitted.format,
        ...(admitted.sheet !== undefined ? { sheet: admitted.sheet } : {}),
        inputSha256: admitted.sha256, inputBytes: admitted.bytes,
        parserVersion: ANALYTICS_LOCAL_FILE_PARSER_VERSION, mode,
        fileRows: prepared.fileRowCount, rowCount: promoted.version.rowCount,
        ...(prepared.base?.versionId ? {
          baseVersionId: prepared.base.versionId,
          keptRows: prepared.base.keptRows,
          replacedPartitions: prepared.base.replacedPartitions.length,
        } : {}),
        datasetId: promoted.datasetId, versionId: promoted.version.id,
        contentSha256: promoted.version.materializedSha256,
        sourceRunId: promoted.run.id, idempotent: promoted.idempotent,
      },
    });
  }

  async function executeSource(
    observation: AnalyticsJobObservation,
    node: AnalyticsJobNodeRecord,
    attemptId: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const spec = node.spec;
    if (spec.type === 'existing_version' && isRecord(spec.input)) {
      const source = spec.input as unknown as AnalyticsJobExistingInputV1;
      if (!DATASET_ID_RE.test(source.datasetId) || !VERSION_ID_RE.test(source.versionId)) fail('integrity_failed', 'Source node identity is malformed.');
      const dataset = input.store.getDataset(source.datasetId);
      const version = input.store.getDatasetVersion(source.versionId);
      if (!dataset || !version || version.datasetId !== dataset.id || dataset.lifecycle !== 'active'
        || dataset.catalogVisibility !== 'catalog' || dataset.scope !== 'workspace'
        || version.observedSchemaSha256 !== source.expectedSchemaSha256
        || version.contractSha256 !== source.expectedContractSha256) {
        fail('integrity_failed', `Exact source ${source.datasetId}/${source.versionId} differs from its admitted plan.`);
      }
      const columns = new Set(version.contract.schema.map(field => field.name));
      if (source.requiredColumns.some(column => !columns.has(column))) fail('integrity_failed', 'Exact source lost a required column.');
      input.store.verifyVersion(version.id, 'local_answer');
      input.jobStore.succeedNode({
        nodeId: node.id,
        attemptId,
        outputDatasetId: dataset.id,
        outputVersionId: version.id,
        receipt: {
          kind: 'existing_version',
          datasetId: dataset.id,
          versionId: version.id,
          contentSha256: version.materializedSha256,
          schemaSha256: version.observedSchemaSha256,
          contractSha256: version.contractSha256,
          definitionSha256: version.definitionSha256,
          rowCount: version.rowCount,
        },
      });
      return;
    }
    if (spec.type !== 'preparation_source' || !isRecord(spec.source)) fail('integrity_failed', 'Preparation source node spec is malformed.');
    const source = spec.source as unknown as AnalyticsDatasetPreparationSourceV1;
    if (source.kind === 'import_inbox') {
      const row = input.db.prepare(`
        SELECT proposal.id AS proposal_id, proposal.status AS proposal_status,
          proposal.next_action AS proposal_next_action, promotion.id AS promotion_id,
          promotion.status AS promotion_status, promotion.dataset_id, promotion.version_id,
          promotion.next_action AS promotion_next_action
        FROM analytics_import_semantic_proposals proposal
        LEFT JOIN analytics_import_proposal_approvals approval ON approval.proposal_id=proposal.id
        LEFT JOIN analytics_import_promotions promotion ON promotion.approval_id=approval.id
        WHERE proposal.candidate_id=?
        ORDER BY proposal.proposal_revision DESC LIMIT 1
      `).get(source.importId) as {
        proposal_id: string;
        proposal_status: string;
        proposal_next_action: string | null;
        promotion_id: string | null;
        promotion_status: string | null;
        dataset_id: string | null;
        version_id: string | null;
        promotion_next_action: string | null;
      } | undefined;
      if (row?.promotion_status === 'complete' && row.dataset_id && row.version_id) {
        const version = input.store.getDatasetVersion(row.version_id);
        const dataset = input.store.getDataset(row.dataset_id);
        if (!version || !dataset || version.datasetId !== dataset.id || dataset.catalogVisibility !== 'catalog') {
          fail('integrity_failed', 'Completed import promotion no longer resolves to its exact catalog version.');
        }
        const columns = new Set(version.contract.schema.map(field => field.name));
        if (source.requiredColumns.some(column => !columns.has(column))) fail('integrity_failed', 'Imported source lacks a required column.');
        input.store.verifyVersion(version.id, 'local_answer');
        input.jobStore.succeedNode({
          nodeId: node.id,
          attemptId,
          outputDatasetId: dataset.id,
          outputVersionId: version.id,
          receipt: {
            kind: 'import_inbox', importId: source.importId, proposalId: row.proposal_id,
            promotionId: row.promotion_id, datasetId: dataset.id, versionId: version.id,
            contentSha256: version.materializedSha256, rowCount: version.rowCount,
          },
        });
        return;
      }
      const terminalFailure = row && ['failed', 'conflict', 'dismissed'].includes(row.proposal_status);
      if (terminalFailure || row?.promotion_status === 'conflict') {
        fail('conflict', row?.promotion_next_action || row?.proposal_next_action || 'The Import Inbox source did not reach a verified promotion.');
      }
      const needsApproval = !row || row.proposal_status === 'review_ready' || row.proposal_status === 'needs_input';
      const nextAction = row?.proposal_next_action
        || (needsApproval
          ? `Review import ${source.importId} in the Data Room Import Inbox and use the protected owner controls.`
          : `Wait for import ${source.importId} promotion ${row?.promotion_id ?? ''} to complete.`);
      input.jobStore.waitNode({
        nodeId: node.id,
        attemptId,
        state: needsApproval ? 'needs_approval' : 'waiting_external',
        checkpoint: {
          sourceKind: 'import_inbox', importId: source.importId,
          ...(row?.proposal_id ? { proposalId: row.proposal_id } : {}),
          ...(row?.promotion_id ? { promotionId: row.promotion_id } : {}),
          observedStatus: row?.promotion_status ?? row?.proposal_status ?? 'not_started',
          nextCheckAt: new Date(Date.now() + 5_000).toISOString(),
        },
        nextAction,
      });
      scheduleWake(5_000);
      return;
    }
    if (source.kind === 'local_file') {
      await executeLocalFileSource(observation, node, attemptId, source, signal);
      return;
    }
    if (source.kind !== 'sql_query' && source.kind !== 'etl_query') {
      fail('integrity_failed', 'Preparation source adapter is unsupported.');
    }
    if (!input.dataRoom) fail('unsupported', 'The Data Room writer is unavailable to the existing analytics job service.');
    const prepared = preparationSourceDefinition({
      job: observation.job,
      alias: source.alias,
      sourceKind: source.kind === 'sql_query' ? 'sql_context' : 'datanet_etl',
      target: source.target,
      modelContextRuntime: input.modelContextRuntime,
    });
    const existing = input.store.getDataset(prepared.definition.id);
    const expectedHeadRevision = source.target.expectedHeadRevision
      ?? existing?.head?.headRevision
      ?? prepared.expectedHeadRevision;
    input.dataRoom.registerDataset(prepared.definition);
    const querySha256 = analyticsSha256(source.sql);
    if (source.kind === 'sql_query') {
      if (!input.sqlRunner) fail('unsupported', 'The SQL preparation adapter is unavailable.');
      // One complete exported result, never a context-sized page.
      let exported: AnalyticsSqlExport;
      try {
        exported = await input.sqlRunner.exportComplete(source.sql, { signal });
      } catch (error) {
        if (error instanceof AnalyticsSqlExportError) {
          failWithNextAction(SQL_EXPORT_JOB_CODES[error.code], error.message, error.nextAction);
        }
        throw error;
      }
      let promoted: ReturnType<AnalyticsDataRoomService['ingestSqlExport']>;
      try {
        promoted = input.dataRoom.ingestSqlExport({
          datasetId: prepared.definition.id,
          expectedHeadRevision,
          materializedAt: timestamp(),
          sourceReceipt: {
            sourceKind: 'sql_context',
            sourceId: `analytics-job:${observation.job.id}:${source.alias}`,
            querySha256,
            producerVersion: SQL_EXPORT_PRODUCER_VERSION,
            acquiredAt: timestamp(),
          },
          quality: prepared.quality ?? [],
          trigger: 'agent',
          requestSha256: observation.job.intentSha256,
          export: exported,
        });
      } catch (error) {
        // The query ran; a result that does not fit the declared target is a
        // definition problem. Unlike Datanet, re-running read-only SQL is cheap.
        if (!(error instanceof AnalyticsDataRoomError) || error.code === 'conflict') throw error;
        failWithNextAction(
          'invalid_input',
          `The SQL query returned ${exported.rowCount} row(s), but they could not become a version of this target: ${error.message}`,
          'Nothing was published. Tell the owner the reason above. On the owner\'s request, correct target.schema (names, logicalType, nullable) or target.coverage to match those results, or convert the columns in the SQL, and create again; re-running this read-only query is safe.',
        );
      }
      input.store.verifyVersion(promoted.version.id, 'local_answer');
      input.jobStore.succeedNode({
        nodeId: node.id,
        attemptId,
        outputDatasetId: promoted.datasetId,
        outputVersionId: promoted.version.id,
        receipt: {
          kind: 'sql_query', datasetId: promoted.datasetId, versionId: promoted.version.id,
          querySha256, exportSha256: exported.sha256, exportRowCount: exported.rowCount,
          contentSha256: promoted.version.materializedSha256,
          rowCount: promoted.version.rowCount, sourceRunId: promoted.run.id,
          idempotent: promoted.idempotent,
        },
      });
      return;
    }
    if (!input.etlRunner) fail('unsupported', 'The Datanet ETL preparation adapter is unavailable.');
    const priorCheckpoint = [...observation.attempts].reverse()
      .find(attempt => attempt.nodeId === node.id && attempt.checkpoint && typeof attempt.checkpoint.runId === 'string')?.checkpoint;
    let outcome: QueryRunResult;
    if (priorCheckpoint?.runId && input.etlRunner.readRun) {
      outcome = await input.etlRunner.readRun({ runId: String(priorCheckpoint.runId) });
    } else {
      outcome = await input.etlRunner.runQuery({
        sql: source.sql,
        ...(source.datasetDate ? { datasetDate: source.datasetDate } : {}),
        onSubmitted: runId => {
          input.jobStore.checkpoint({
            attemptId,
            checkpoint: { sourceKind: 'etl_query', runId, querySha256, submittedAt: timestamp() },
          });
        },
      });
    }
    if (!outcome.ok) {
      if ((outcome.code === 'alive_handoff' || outcome.code === 'status_unavailable') && outcome.runId) {
        input.jobStore.waitNode({
          nodeId: node.id,
          attemptId,
          state: 'waiting_external',
          checkpoint: {
            sourceKind: 'etl_query', runId: outcome.runId, querySha256,
            remoteStatus: outcome.remoteStatus ?? 'UNKNOWN',
            nextCheckAt: new Date(Date.now() + 30_000).toISOString(),
          },
          nextAction: outcome.nextAction || `Wait for exact Datanet run ${outcome.runId}; never resubmit it.`,
        });
        scheduleWake(30_000);
        return;
      }
      fail(outcome.code === 'submission_unknown' ? 'integrity_failed' : 'conflict', [outcome.error, outcome.nextAction].filter(Boolean).join(' — ') || 'Datanet ETL preparation failed.');
    }
    if (!outcome.runId || !outcome.savedTo || outcome.resultBytes === undefined || !outcome.resultSha256) {
      fail('integrity_failed', 'Datanet ETL success lacks an exact result file receipt.');
    }
    let promoted: ReturnType<AnalyticsDataRoomService['ingestEtlTsv']>;
    try {
      promoted = input.dataRoom.ingestEtlTsv({
        datasetId: prepared.definition.id,
        expectedHeadRevision,
        materializedAt: timestamp(),
        sourceReceipt: {
          sourceKind: 'datanet_etl',
          sourceId: outcome.runId,
          querySha256,
          producerVersion: input.etlRunner.id,
          acquiredAt: timestamp(),
        },
        quality: prepared.quality ?? [],
        trigger: 'agent',
        requestSha256: observation.job.intentSha256,
        savedTo: outcome.savedTo,
        resultBytes: outcome.resultBytes,
        resultSha256: outcome.resultSha256,
        ...(source.nullToken !== undefined ? { nullToken: source.nullToken } : {}),
      });
    } catch (error) {
      // The run is complete and its exact result is saved: a result that does
      // not fit the declared target must never lead to resubmitting the SQL.
      // A head conflict stays transient (resume re-reads the same run).
      if (!(error instanceof AnalyticsDataRoomError) || error.code === 'conflict') throw error;
      const home = localFilePolicy.homeDir;
      const saved = outcome.savedTo.startsWith(`${home}/`) ? `~/${outcome.savedTo.slice(home.length + 1)}` : outcome.savedTo;
      failWithNextAction(
        'invalid_input',
        `Datanet run ${outcome.runId} succeeded, but its result could not become a version of this target: ${error.message}`,
        `Run ${outcome.runId} is complete and its exact result is saved at ${saved}; never resubmit this SQL to get it again. Tell the owner the reason above. On the owner's request, call inspect_local_file on that path, then create with one local_file source whose target matches the reported columns, types, and coverage. Resubmit SQL only if the query itself must change.`,
      );
    }
    input.store.verifyVersion(promoted.version.id, 'local_answer');
    input.jobStore.succeedNode({
      nodeId: node.id,
      attemptId,
      outputDatasetId: promoted.datasetId,
      outputVersionId: promoted.version.id,
      receipt: {
        kind: 'etl_query', runId: outcome.runId, datasetId: promoted.datasetId,
        versionId: promoted.version.id, querySha256,
        contentSha256: promoted.version.materializedSha256,
        rowCount: promoted.version.rowCount, sourceRunId: promoted.run.id,
        idempotent: promoted.idempotent,
      },
    });
  }

  async function executeFragment(
    observation: AnalyticsJobObservation,
    node: AnalyticsJobNodeRecord,
    attemptId: string,
    signal: AbortSignal,
  ): Promise<void> {
    const spec = node.spec;
    if (spec.type !== 'transform_fragment' || !isRecord(spec.fragment) || !isRecord(spec.request)) {
      fail('integrity_failed', 'Transform fragment node spec is malformed.');
    }
    const fragment = spec.fragment as unknown as AnalyticsJobFragmentV1;
    const prior = predecessors(observation, node);
    const edgeByAlias = new Map(observation.edges
      .filter(edge => edge.planRevision === node.planRevision && edge.toNodeId === node.id)
      .map(edge => [edge.inputName, edge]));
    const versions: AnalyticsDatasetVersionDetail[] = [];
    const dependencies = fragment.dependencies.map(dependency => {
      const edge = edgeByAlias.get(dependency.alias);
      const predecessor = edge ? prior.find(item => item.id === edge.fromNodeId) : undefined;
      if (!predecessor?.outputDatasetId || !predecessor.outputVersionId) {
        fail('integrity_failed', `Fragment dependency ${dependency.alias} has no exact output version.`);
      }
      const version = input.store.getDatasetVersion(predecessor.outputVersionId);
      if (!version || version.datasetId !== predecessor.outputDatasetId) fail('integrity_failed', 'Fragment predecessor version disappeared.');
      input.store.verifyVersion(version.id, 'local_answer');
      const fields = new Set(version.contract.schema.map(field => field.name));
      if (dependency.requiredColumns.some(column => !fields.has(column))) fail('integrity_failed', `Fragment dependency ${dependency.alias} lost a required column.`);
      versions.push(version);
      return {
        alias: dependency.alias,
        datasetId: version.datasetId,
        versionPolicy: 'pinned' as const,
        pinnedVersionId: version.id,
        requiredColumns: [...dependency.requiredColumns].sort(),
        expectedSchemaSha256: version.observedSchemaSha256,
        expectedContractSha256: version.contractSha256,
      };
    });
    const definition: AnalyticsDerivedDefinitionV1 = parseAnalyticsDerivedDefinition({
      version: 1,
      engine: 'botboy_relational_v1',
      dependencies,
      steps: fragment.steps,
      output: fragment.output,
    });
    const job = observation.job;
    const datasetId = `ds_job_${analyticsSha256({ jobId: job.id, planSha256: job.planSha256, fragmentId: fragment.id }).slice(0, 24)}`;
    const contract = buildContract(datasetId, fragment.contract, versions);
    const terminal = spec.terminal === true;
    const request = normalizeAnalyticsRequest(spec.request as unknown as AnalyticsRequest);
    validateFragmentAnswer(fragment, contract, request, terminal);
    const definitionInput: AnalyticsDatasetDefinitionInput = {
      id: datasetId,
      name: fragment.name,
      description: fragment.description,
      kind: 'derived',
      scope: 'workspace',
      domainKey: contract.domainKey,
      ownerId: job.ownerId,
      lifecycle: 'active',
      catalogVisibility: terminal ? 'job_scoped' : 'internal',
      sourceKind: 'import',
      sourceFormat: 'canonical_json',
      definition: { answer: fragment.answer, derived: definition },
      contract,
      retention: RETENTION,
    };
    input.store.registerDataset(definitionInput);
    const materialized = await input.derivation.materialize({
      datasetId,
      request,
      consumer: { kind: 'answer', id: `${job.id}:${node.id}` },
    }, { signal });
    if (materialized.state === 'pending') {
      input.jobStore.requeueNode({
        nodeId: node.id,
        attemptId,
        checkpoint: { derivedRunId: materialized.run.id, state: materialized.run.status },
        nextAction: materialized.nextAction,
      });
      return;
    }
    if (materialized.state === 'blocked') {
      input.jobStore.blockNode({
        nodeId: node.id,
        attemptId,
        code: materialized.code,
        message: materialized.error,
        retryClass: 'definition_change',
        nextAction: materialized.nextAction,
      });
      return;
    }
    const version = materialized.version;
    if (version.datasetId !== datasetId || !version.derivation) fail('integrity_failed', 'Fragment materialization returned unrelated lineage.');
    input.jobStore.succeedNode({
      nodeId: node.id,
      attemptId,
      outputDatasetId: datasetId,
      outputVersionId: version.id,
      receipt: {
        kind: 'transform_fragment',
        fragmentId: fragment.id,
        derivedRunId: materialized.run.id,
        datasetId,
        versionId: version.id,
        materializationKeySha256: version.derivation.materializationKeySha256,
        transformSha256: version.derivation.transformSha256,
        inputVersionIds: version.derivation.inputs.map(item => item.versionId),
        contentSha256: version.materializedSha256,
        rowCount: version.rowCount,
        joinedExisting: materialized.joinedExisting,
      },
    });
  }

  function resultPredecessor(observation: AnalyticsJobObservation, node: AnalyticsJobNodeRecord): AnalyticsJobNodeRecord {
    const [prior] = predecessors(observation, node);
    if (!prior?.outputDatasetId || !prior.outputVersionId) fail('integrity_failed', 'Result node has no terminal version.');
    return prior;
  }

  async function executeResult(observation: AnalyticsJobObservation, node: AnalyticsJobNodeRecord, attemptId: string): Promise<void> {
    if (node.spec.type !== 'result_publication' || !isRecord(node.spec.plan)) fail('integrity_failed', 'Result node spec is malformed.');
    const plan = node.spec.plan as unknown as AnalyticsJobPlanV1 | AnalyticsDatasetPreparationPlanV1;
    const preparationPlan = 'mode' in plan && plan.mode === 'dataset_preparation' ? plan : undefined;
    const preparation = Boolean(preparationPlan);
    const terminal = resultPredecessor(observation, node);
    const version = input.store.getDatasetVersion(terminal.outputVersionId!);
    const dataset = input.store.getDataset(terminal.outputDatasetId!);
    if (!version || !dataset || version.datasetId !== dataset.id) fail('integrity_failed', 'Terminal Data Room version disappeared.');
    input.store.verifyVersion(version.id, 'local_answer');
    const request = validateTerminalRequest(plan.request, dataset, version, preparation ? 'observed' : 'complete');
    if (preparation) {
      if (dataset.catalogVisibility === 'job_scoped') {
        input.store.setCatalogVisibility(dataset.id, 'job_scoped', 'catalog');
      } else if (dataset.catalogVisibility !== 'catalog') {
        fail('policy_denied', 'Preparation terminal dataset is internal and cannot be reported ready.');
      }
    }
    const nodes = currentPlanNodes(observation);
    const byKey = new Map(nodes.map(item => [nodeKey(item), item]));
    const planSources: Array<{ alias: string }> = preparationPlan
      ? preparationPlan.sources
      : (plan as AnalyticsJobPlanV1).inputs;
    const leafVersions = planSources.map(source => {
      const sourceNode = byKey.get(sourceNodeKey(source.alias));
      const detail = sourceNode?.outputVersionId ? input.store.getDatasetVersion(sourceNode.outputVersionId) : null;
      if (!sourceNode?.outputDatasetId || !detail) fail('integrity_failed', `Source ${source.alias} has no verified job output.`);
      return {
        alias: source.alias,
        datasetId: sourceNode.outputDatasetId,
        versionId: detail.id,
        materializedSha256: detail.materializedSha256,
        observedSchemaSha256: detail.observedSchemaSha256,
        contractSha256: detail.contractSha256,
        definitionSha256: detail.definitionSha256,
      };
    }).sort((left, right) => left.alias.localeCompare(right.alias));
    const fragmentVersions = plan.fragments.map(fragment => {
      const fragmentNode = byKey.get(fragmentNodeKey(fragment.id));
      const detail = fragmentNode?.outputVersionId ? input.store.getDatasetVersion(fragmentNode.outputVersionId) : null;
      if (!fragmentNode?.outputDatasetId || !detail?.derivation) fail('integrity_failed', `Fragment ${fragment.id} has no verified job output.`);
      return {
        fragmentId: fragment.id,
        datasetId: fragmentNode.outputDatasetId,
        versionId: detail.id,
        materializationKeySha256: detail.derivation.materializationKeySha256,
        transformSha256: detail.derivation.transformSha256,
        inputVersionIds: detail.derivation.inputs.map(item => item.versionId),
      };
    });
    const manifest: AnalyticsJobResultManifestV1 = {
      version: 1,
      jobId: observation.job.id,
      finalPlanSha256: observation.job.planSha256!,
      primary: {
        datasetId: dataset.id,
        versionId: version.id,
        materializedSha256: version.materializedSha256,
        observedSchemaSha256: version.observedSchemaSha256,
        contractSha256: version.contractSha256,
        definitionSha256: version.definitionSha256,
        rowCount: version.rowCount,
      },
      leafVersions,
      fragmentVersions,
      request,
      contract: version.contract,
      coverage: version.coverage,
      handling: version.handling,
    };
    const manifestSha256 = analyticsSha256(manifest);
    let preparationRetention = RETENTION;
    if (preparationPlan?.terminal.kind === 'source') {
      const terminalAlias = preparationPlan.terminal.alias;
      preparationRetention = ((preparationPlan.sources.find(source => source.alias === terminalAlias) as any)?.target?.retention) ?? RETENTION;
    }
    const result = input.jobStore.insertResult({
      jobId: observation.job.id,
      finalPlanSha256: observation.job.planSha256!,
      primaryVersion: version,
      manifest,
      visibility: preparation ? 'catalog' : 'job_scoped',
      retention: preparationRetention,
      receipt: {
        resultVersion: preparation ? 'analytics-dataset-preparation-result-v1' : 'analytics-job-result-v1',
        jobId: observation.job.id,
        finalPlanSha256: observation.job.planSha256,
        manifestSha256,
        primaryDatasetId: dataset.id,
        primaryVersionId: version.id,
      },
    });
    input.jobStore.succeedNode({
      nodeId: node.id,
      attemptId,
      outputDatasetId: dataset.id,
      outputVersionId: version.id,
      outputResultId: result.id,
      receipt: { kind: 'result_publication', resultId: result.id, manifestSha256, primaryVersionId: version.id },
    });
  }

  function resultForConsumer(observation: AnalyticsJobObservation, node: AnalyticsJobNodeRecord): AnalyticsJobResultRecord {
    const [prior] = predecessors(observation, node);
    if (!prior?.outputResultId) fail('integrity_failed', 'Consumer has no canonical result predecessor.');
    const result = input.jobStore.getResult(prior.outputResultId);
    if (!result) fail('integrity_failed', 'Consumer result disappeared.');
    return result;
  }

  async function executeAnswer(observation: AnalyticsJobObservation, node: AnalyticsJobNodeRecord, attemptId: string, signal: AbortSignal): Promise<void> {
    const result = resultForConsumer(observation, node);
    const dataset = input.store.getDataset(result.manifest.primary.datasetId);
    const version = input.store.getDatasetVersion(result.primaryVersionId);
    if (!dataset || !version || version.datasetId !== dataset.id) fail('integrity_failed', 'Answer result version disappeared.');
    if (!analyticsHandlingAllowsModelContext(version.handling, input.modelContextRuntime)) {
      fail('policy_denied', 'The exact result handling policy does not permit rows in the active model context.');
    }
    const request = validateTerminalRequest(result.manifest.request, dataset, version);
    const support = input.localQuery.supports({ dataset, version, request });
    if (!support.supported) fail('unsupported', support.reason);
    const query = await input.localQuery.execute({ dataset, version, request, signal });
    const warnings = version.quality.filter(item => !item.success && item.severity === 'warning')
      .map(item => item.assertionId).sort();
    const limitations = query.result.truncated
      ? [`Result displays ${query.result.displayedRowCount} of ${query.result.rowCount} rows within fixed row/byte limits.`]
      : [];
    const receipt = {
      requestSha256: analyticsRequestSha256(request),
      sourceKind: version.derivation ? 'data_room_derived' : 'data_room_materialized',
      executionKind: 'analytics_job',
      resultId: result.id,
      metric: request.metric,
      regime: request.regime,
      countingKey: request.countingKey,
      grain: request.requiredGrain,
      dimensions: request.dimensions,
      unit: request.metric.unit,
      timeZone: request.timeZone,
      requestedRange: request.dateRange,
      coveredPartitions: version.coverage.completePartitions,
      watermark: version.coverage.watermark,
      datasetIds: [dataset.id],
      versionIds: [version.id],
      sourceVersionIds: result.manifest.leafVersions.map(item => item.versionId),
      fragmentVersionIds: result.manifest.fragmentVersions.map(item => item.versionId),
      contractSha256: version.contractSha256,
      definitionSha256: version.definitionSha256,
      contentSha256: version.materializedSha256,
      schemaSha256: version.observedSchemaSha256,
      querySha256: query.receipt.querySha256,
      queryCompilerVersion: query.receipt.compilerVersion,
      integrityVerifiedAt: query.receipt.integrityVerifiedAt,
      resultLimit: query.receipt.rowLimit,
      resultByteLimit: query.receipt.byteLimit,
      qualityWarnings: warnings,
      limitations,
    };
    input.jobStore.succeedNode({
      nodeId: node.id,
      attemptId,
      outputDatasetId: dataset.id,
      outputVersionId: version.id,
      outputResultId: result.id,
      receipt: { kind: 'answer_delivery', resultId: result.id, answer: { result: query.result, receipt } },
    });
  }

  async function executeRetain(observation: AnalyticsJobObservation, node: AnalyticsJobNodeRecord, attemptId: string): Promise<void> {
    let result = resultForConsumer(observation, node);
    const dataset = input.store.getDataset(result.manifest.primary.datasetId);
    if (!dataset) fail('integrity_failed', 'Retained result dataset disappeared.');
    if (dataset.catalogVisibility === 'job_scoped') {
      input.store.setCatalogVisibility(dataset.id, 'job_scoped', 'catalog');
    } else if (dataset.catalogVisibility !== 'catalog') {
      fail('policy_denied', 'Internal intermediate datasets cannot be promoted directly.');
    }
    if (result.visibility === 'job_scoped') {
      result = input.jobStore.setResultVisibility(result.id, 'job_scoped', 'catalog');
    }
    input.jobStore.succeedNode({
      nodeId: node.id,
      attemptId,
      outputDatasetId: dataset.id,
      outputVersionId: result.primaryVersionId,
      outputResultId: result.id,
      receipt: { kind: 'retain_delivery', resultId: result.id, datasetId: dataset.id, versionId: result.primaryVersionId, visibility: 'catalog' },
    });
  }

  function maybeComplete(jobId: string): void {
    const observation = input.jobStore.observe(jobId);
    const nodes = currentPlanNodes(observation);
    if (!nodes.length || nodes.some(node => node.state !== 'succeeded')) return;
    const resultNode = nodes.find(node => node.kind === 'result_publication');
    if (!resultNode) fail('integrity_failed', 'Complete analytics job lost its result node.');
    const resultId = resultNode.outputResultId;
    const result = resultId ? input.jobStore.getResult(resultId) : null;
    if (!result) fail('integrity_failed', 'Complete analytics job has no canonical result.');
    const attempts = observation.attempts.filter(attempt => nodes.some(node => node.id === attempt.nodeId));
    const joinedExisting = attempts.some(attempt => attempt.receipt?.joinedExisting === true);
    const recoveredAfterRestart = attempts.some(attempt => attempt.status === 'interrupted');
    const plan = isRecord(resultNode.spec.plan)
      ? resultNode.spec.plan as unknown as AnalyticsJobPlanV1 | AnalyticsDatasetPreparationPlanV1
      : fail('integrity_failed', 'Complete analytics job lost its canonical plan.');
    const preparationPlan = 'mode' in plan && plan.mode === 'dataset_preparation' ? plan : undefined;
    const planConsumers: AnalyticsJobConsumer[] = preparationPlan
      ? []
      : (plan as AnalyticsJobPlanV1).consumers;
    const completedConsumers = nodes
      .filter(node => node.kind === 'answer_delivery' || node.kind === 'retain_delivery')
      .map(node => node.kind === 'answer_delivery' ? { kind: 'answer' as const } : planConsumers.find(consumer => consumer.kind === 'retain_dataset')!)
      .filter((consumer): consumer is AnalyticsJobConsumer => !!consumer);
    const receipt: AnalyticsJobCompletionReceipt = {
      receiptVersion: 'analytics-job-receipt-v1',
      jobId: observation.job.id,
      ownerRequestId: observation.job.ownerRequestId,
      intentSha256: observation.job.intentSha256,
      planSha256: observation.job.planSha256!,
      resultId: result.id,
      resultManifestSha256: result.manifestSha256,
      resultReceiptSha256: result.receiptSha256,
      primaryDatasetId: result.manifest.primary.datasetId,
      primaryVersionId: result.primaryVersionId,
      sourceVersionIds: result.manifest.leafVersions.map(item => item.versionId),
      fragmentVersionIds: result.manifest.fragmentVersions.map(item => item.versionId),
      consumers: planConsumers,
      completedConsumers,
      joinedExisting,
      recoveredAfterRestart,
      completedAt: timestamp(),
    };
    input.jobStore.completeJob({
      jobId: observation.job.id,
      expectedStateRevision: observation.job.stateRevision,
      resultId: result.id,
      receipt,
    });
  }

  function finalizeReadyJobs(): number {
    const rows = input.db.prepare(`
      SELECT job.id
      FROM analytics_jobs job
      WHERE job.status IN ('running','delivering') AND job.plan_revision >= 1
        AND EXISTS (
          SELECT 1 FROM analytics_job_nodes result_node
          WHERE result_node.job_id=job.id AND result_node.plan_revision=job.plan_revision
            AND result_node.kind='result_publication' AND result_node.state='succeeded'
            AND result_node.output_result_id IS NOT NULL
        )
        AND NOT EXISTS (
          SELECT 1 FROM analytics_job_nodes node
          WHERE node.job_id=job.id AND node.plan_revision=job.plan_revision
            AND node.state<>'succeeded'
        )
      ORDER BY job.updated_at, job.id
    `).all() as Array<{ id: string }>;
    let completed = 0;
    for (const row of rows) {
      try {
        maybeComplete(row.id);
        if (input.jobStore.getJob(row.id)?.status === 'complete') completed++;
      } catch (error) {
        if (!(error instanceof AnalyticsJobError) || error.code !== 'conflict') throw error;
      }
    }
    return completed;
  }

  async function executeClaim(observation: AnalyticsJobObservation, node: AnalyticsJobNodeRecord, attemptId: string, signal: AbortSignal): Promise<void> {
    if (node.kind === 'source_resolution') await executeSource(observation, node, attemptId, signal);
    else if (node.kind === 'transform_fragment') await executeFragment(observation, node, attemptId, signal);
    else if (node.kind === 'result_publication') await executeResult(observation, node, attemptId);
    else if (node.kind === 'answer_delivery') await executeAnswer(observation, node, attemptId, signal);
    else await executeRetain(observation, node, attemptId);
  }

  function reconcileWaitingNode(): boolean {
    const row = input.db.prepare(`
      SELECT node.id, node.state, node.spec_json, attempt.checkpoint_json
      FROM analytics_job_nodes node
      JOIN analytics_jobs job ON job.id=node.job_id AND job.plan_revision=node.plan_revision
      LEFT JOIN analytics_job_node_attempts attempt ON attempt.id=node.current_attempt_id
      WHERE node.state IN ('waiting_external','needs_approval')
        AND job.status IN ('waiting_external','needs_approval')
      ORDER BY node.updated_at, node.id LIMIT 1
    `).get() as { id: string; state: 'waiting_external' | 'needs_approval'; spec_json: string; checkpoint_json: string | null } | undefined;
    if (!row) return false;
    let spec: Record<string, unknown>;
    let checkpoint: Record<string, unknown> = {};
    try {
      spec = JSON.parse(row.spec_json) as Record<string, unknown>;
      checkpoint = row.checkpoint_json ? JSON.parse(row.checkpoint_json) as Record<string, unknown> : {};
    } catch {
      fail('integrity_failed', 'Waiting preparation node contains malformed durable state.');
    }
    const source = isRecord(spec.source) ? spec.source as unknown as AnalyticsDatasetPreparationSourceV1 : undefined;
    if (source?.kind === 'import_inbox') {
      const external = input.db.prepare(`
        SELECT proposal.status AS proposal_status, promotion.status AS promotion_status
        FROM analytics_import_semantic_proposals proposal
        LEFT JOIN analytics_import_proposal_approvals approval ON approval.proposal_id=proposal.id
        LEFT JOIN analytics_import_promotions promotion ON promotion.approval_id=approval.id
        WHERE proposal.candidate_id=?
        ORDER BY proposal.proposal_revision DESC LIMIT 1
      `).get(source.importId) as { proposal_status: string; promotion_status: string | null } | undefined;
      const approvalAdvanced = row.state === 'needs_approval'
        && Boolean(external && ['approved', 'promoting', 'complete', 'failed', 'conflict', 'dismissed'].includes(external.promotion_status ?? external.proposal_status));
      const externalDue = row.state === 'waiting_external'
        && Date.parse(String(checkpoint.nextCheckAt ?? '')) <= Date.now();
      if (!approvalAdvanced && !externalDue) {
        scheduleWake(row.state === 'needs_approval' ? 5_000 : 1_000);
        return false;
      }
    } else {
      const nextCheckAt = Date.parse(String(checkpoint.nextCheckAt ?? ''));
      if (Number.isFinite(nextCheckAt) && nextCheckAt > Date.now()) {
        scheduleWake(Math.min(30_000, nextCheckAt - Date.now()));
        return false;
      }
    }
    input.jobStore.resumeWaitingNode({ nodeId: row.id, nextAction: 'Resume the exact preparation source from its durable checkpoint.' });
    return true;
  }

  async function processOne(signal: AbortSignal): Promise<number> {
    if (reconcileWaitingNode()) return 1;
    if (finalizeReadyJobs() > 0) return 1;
    const planning = input.db.prepare(`
      SELECT id FROM analytics_jobs WHERE status='planning' ORDER BY updated_at, id LIMIT 1
    `).get() as { id: string } | undefined;
    if (planning) {
      const job = input.jobStore.getJob(planning.id);
      if (job) {
        activeJobId = job.id;
        try {
          await planJob(job, signal);
        } catch (error) {
          if (signal.aborted) return 0;
          const projected = errorProjection(error);
          input.jobStore.blockPlanning({
            jobId: job.id,
            code: projected.code,
            message: projected.message,
            nextAction: projected.nextAction,
          });
        }
        return 1;
      }
    }
    const claim = input.jobStore.claimNextReady();
    if (!claim) return 0;
    activeJobId = claim.job.id;
    try {
      await executeClaim(input.jobStore.observe(claim.job.id), claim.node, claim.attempt.id, signal);
      maybeComplete(claim.job.id);
    } catch (error) {
      if (signal.aborted) {
        const latest = input.jobStore.getNode(claim.node.id);
        if (latest?.state === 'running' && latest.currentAttemptId === claim.attempt.id) {
          input.jobStore.requeueNode({
            nodeId: claim.node.id,
            attemptId: claim.attempt.id,
            checkpoint: { reason: stopping ? 'process_shutdown' : 'local_abort' },
            nextAction: 'The durable job will resume from its exact inputs.',
          });
        }
        return 0;
      }
      const projected = errorProjection(error);
      const latest = input.jobStore.getNode(claim.node.id);
      if (latest?.state === 'running' && latest.currentAttemptId === claim.attempt.id) {
        input.jobStore.blockNode({
          nodeId: claim.node.id,
          attemptId: claim.attempt.id,
          code: projected.code,
          message: projected.message,
          retryClass: projected.retryClass,
          nextAction: projected.nextAction,
        });
      }
    }
    return 1;
  }

  async function processNext(): Promise<number> {
    if (active || stopping) return 0;
    activeController = new AbortController();
    active = processOne(activeController.signal);
    let processed = 0;
    try {
      processed = await active;
      return processed;
    } finally {
      active = null;
      activeController = null;
      activeJobId = null;
      if (!stopping && processed > 0) wake();
    }
  }

  function wake(): void {
    if (stopping || active) return;
    queueMicrotask(() => { void processNext(); });
  }

  async function startOrJoinAndWait(owner: AnalyticsJobOwnerRequest, options: { waitSignal?: AbortSignal } = {}): Promise<AnalyticsJobToolReceipt> {
    const ownerId = cleanText(owner.ownerId, 'ownerId', 240);
    const requestId = cleanText(owner.requestId, 'ownerRequestId', 128);
    const intent = normalizedIntent({ ...owner, ownerId, requestId });
    const created = input.jobStore.createOrJoin({
      ownerId,
      ownerRequestId: requestId,
      ownerMessageSha256: intent.ownerMessageSha256,
      intent,
    });
    wake();
    return waitForOutcome(created.job.id, 'run', requestId, options.waitSignal);
  }

  async function prepareOrJoinAndWait(
    owner: AnalyticsJobOwnerRequest,
    plan: AnalyticsDatasetPreparationPlanV1,
    options: { waitSignal?: AbortSignal } = {},
  ): Promise<AnalyticsJobToolReceipt> {
    const ownerId = cleanText(owner.ownerId, 'ownerId', 240);
    const requestId = cleanText(owner.requestId, 'ownerRequestId', 128);
    // Local files are read, typed, and coverage-checked against their contract
    // before any durable job exists, so a mismatch has zero effects.
    const admitted = await admitLocalFileSources(normalizePreparationPlan(plan), options.waitSignal);
    const intent = preparationIntent({ ...owner, ownerId, requestId }, admitted);
    const created = input.jobStore.createOrJoin({
      ownerId,
      ownerRequestId: requestId,
      ownerMessageSha256: intent.ownerMessageSha256,
      intent,
    });
    wake();
    return waitForOutcome(created.job.id, 'prepare', requestId, options.waitSignal);
  }

  async function resume(jobId: string, owner: AnalyticsJobOwnerRequest, options: { waitSignal?: AbortSignal } = {}): Promise<AnalyticsJobToolReceipt> {
    input.jobStore.resumeBlocked(jobId);
    wake();
    return waitForOutcome(jobId, 'resume', owner.requestId, options.waitSignal);
  }

  async function respond(jobId: string, response: string, owner: AnalyticsJobOwnerRequest, options: { waitSignal?: AbortSignal } = {}): Promise<AnalyticsJobToolReceipt> {
    const answer = cleanText(response, 'response', 4000);
    const job = input.jobStore.getJob(jobId);
    const question = job?.questionReceipt;
    const choices = Array.isArray(question?.choices)
      ? question!.choices.filter((choice): choice is { id: string; label: string } => isRecord(choice)
        && typeof choice.id === 'string' && typeof choice.label === 'string')
      : [];
    if (!job || job.status !== 'needs_input' || question?.answerMode !== 'choice' || choices.length < 2) {
      fail('conflict', 'Analytics job has no valid open choice question.');
    }
    const normalized = answer.toLowerCase();
    const choice = choices.find(item => item.id.toLowerCase() === normalized || item.label.toLowerCase() === normalized);
    if (!choice || !ownerMessageContainsChoice(owner.message, answer)) {
      fail('policy_denied', 'Analytics response must exactly match one server-issued choice present in the current owner message.');
    }
    input.jobStore.recordResponse({ jobId, response: choice.id });
    wake();
    return waitForOutcome(jobId, 'respond', owner.requestId, options.waitSignal);
  }

  function cancel(jobId: string, owner: AnalyticsJobOwnerRequest): AnalyticsJobToolReceipt {
    const message = owner.message.toLowerCase();
    const namesExactJob = message.includes(jobId.toLowerCase());
    const namesAnalyticsJob = /\b(cancel|stop|abort)\b[\s\S]{0,50}\b(?:this|that|the|current)?\s*(?:analytics\s+)?job\b/i.test(owner.message)
      || /\b(?:cancel|stop|abort)\b[\s\S]{0,50}\bjob\b/i.test(owner.message);
    if (!namesExactJob && !namesAnalyticsJob) {
      fail('policy_denied', 'Current owner message does not explicitly request cancellation of an analytics job.');
    }
    if (!namesExactJob) {
      const activeJobIds = [...new Set(input.jobStore.activeWork()
        .filter(item => item.kind === 'analytics_job')
        .map(item => item.id))];
      if (activeJobIds.length !== 1 || activeJobIds[0] !== jobId) {
        fail('policy_denied', 'Analytics job cancellation without an exact job ID requires exactly one active job.');
      }
    }
    input.jobStore.requestCancel(jobId);
    if (activeJobId === jobId) {
      activeController?.abort(new Error('Analytics job cancelled by owner.'));
      const pending = active;
      if (pending) {
        void pending.finally(() => {
          const current = input.jobStore.getJob(jobId);
          if (current?.status === 'cancel_requested') input.jobStore.finishCancelled(jobId);
        }).catch(() => {});
      }
    }
    const latest = input.jobStore.getJob(jobId);
    if (latest?.status === 'cancel_requested' && !activeJobId) input.jobStore.finishCancelled(jobId);
    return observationReceipt(input.jobStore.observe(jobId), 'cancel', owner.requestId);
  }

  function start(): void {
    stopping = false;
    input.jobStore.recoverInterrupted();
    finalizeReadyJobs();
    wake();
  }

  function stop(): void {
    stopping = true;
    if (wakeTimer) {
      clearTimeout(wakeTimer);
      wakeTimer = null;
    }
    activeController?.abort(new Error('BotBoy is shutting down.'));
  }

  async function drain(): Promise<void> {
    if (active) await active.catch(() => {});
  }

  return {
    startOrJoinAndWait,
    prepareOrJoinAndWait,
    inspectLocalFile,
    observe,
    resume,
    respond,
    cancel,
    processNext,
    start,
    stop,
    drain,
    wake,
    activeWork: () => input.jobStore.activeWork(),
  };
}
