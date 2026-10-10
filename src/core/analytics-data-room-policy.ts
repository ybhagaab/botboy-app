import { createHash } from 'node:crypto';
import type {
  AnalyticsCanonicalAnswer,
  AnalyticsCandidateEligibility,
  AnalyticsCandidateRejection,
  AnalyticsCandidateRejectionCode,
  AnalyticsDataCell,
  AnalyticsDataRoomCandidate,
  AnalyticsFilterValue,
  AnalyticsHandlingContract,
  AnalyticsParityMismatch,
  AnalyticsParityMismatchCode,
  AnalyticsParityResult,
  AnalyticsRemoteLaneAvailability,
  AnalyticsRequest,
  AnalyticsResearchFeatureDecision,
  AnalyticsResearchFeatureEvidence,
  AnalyticsSourceDecision,
} from './analytics-data-room-types.js';
import { dataRoomIssue } from './data-room-tool-failure.js';

const ISO_DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const SHA256_RE = /^[a-f0-9]{64}$/i;
const DATASET_ID_RE = /^ds_[a-zA-Z0-9_-]{1,96}$/;
const VERSION_ID_RE = /^dsv_[a-f0-9]{24}$/;
const MAX_PARTITIONS_PER_REQUEST = 10_000;

export class AnalyticsDataRoomContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AnalyticsDataRoomContractError';
  }
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, stableValue(child)]),
    );
  }
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new AnalyticsDataRoomContractError('Analytics contracts cannot contain non-finite numbers');
  }
  return value;
}

export function stableAnalyticsJson(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

export function analyticsSha256(value: unknown): string {
  return createHash('sha256').update(stableAnalyticsJson(value)).digest('hex');
}

export interface AnalyticsModelContextRuntime {
  providerLocality: 'device_local' | 'amazon_managed_remote' | 'external_remote';
  endpointSha256: string;
}

export function analyticsHandlingAllowsModelContext(
  handling: AnalyticsHandlingContract,
  runtime?: AnalyticsModelContextRuntime,
): boolean {
  if (!handling.allowModelContext) return false;
  // Rows never reach a model outside the device or Amazon (for example the
  // owner's own OpenAI account), including legacy versions without a pinned
  // policy.
  if (runtime?.providerLocality === 'external_remote') return false;
  const policy = handling.modelContextPolicy;
  if (!policy) return true;
  return Boolean(runtime
    && policy.allowedProviderLocalities.includes(runtime.providerLocality)
    && (!policy.endpointSha256 || policy.endpointSha256 === runtime.endpointSha256));
}

function contractFail(
  message: string,
  issue: ReturnType<typeof dataRoomIssue>,
): never {
  throw Object.assign(new AnalyticsDataRoomContractError(message), { issues: [issue] });
}

function contractExactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const extra = Object.keys(value).filter(key => !allowed.includes(key)).sort()[0];
  if (extra === undefined) return;
  contractFail(
    `${label} contains unsupported field ${extra}`,
    dataRoomIssue({
      code: 'unsupported_field',
      path: label === 'analytics request' ? extra : `${label}.${extra}`,
      message: `${extra} is not part of the fully specified Data Room request contract.`,
      expected: { kind: 'absent' },
      received: value[extra],
    }),
  );
}

function cleanText(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    contractFail(
      `${field} must be a non-empty string`,
      dataRoomIssue({
        code: 'invalid_type',
        path: field,
        message: `${field} must be a non-empty string.`,
        expected: { kind: 'range', type: 'string', minimum: 1 },
        received: value,
      }),
    );
  }
  const text = value.trim();
  if (!text || value.includes('\0')) {
    contractFail(
      `${field} is required`,
      dataRoomIssue({
        code: value.includes('\0') ? 'nul_not_allowed' : 'required',
        path: field,
        message: value.includes('\0') ? `${field} cannot contain NUL.` : `${field} is required.`,
        expected: { kind: 'range', type: 'string', minimum: 1 },
        received: value,
      }),
    );
  }
  return text;
}

function uniqueSorted(values: unknown, field: string): string[] {
  if (!Array.isArray(values)) {
    contractFail(
      `${field} must be an array`,
      dataRoomIssue({
        code: 'invalid_type',
        path: field,
        message: `${field} must be an array of non-empty strings.`,
        expected: { kind: 'type', type: 'array' },
        received: values,
      }),
    );
  }
  return [...new Set(values.map((value, index) => cleanText(value, `${field}[${index}]`)))].sort();
}

function parseIsoDay(value: unknown, field: string): Date {
  const day = cleanText(value, field);
  if (!ISO_DAY_RE.test(day)) {
    contractFail(
      `${field} must be YYYY-MM-DD`,
      dataRoomIssue({
        code: 'invalid_date_format',
        path: field,
        message: `${field} must use the exact YYYY-MM-DD form.`,
        expected: { kind: 'pattern', type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', example: '2026-09-26' },
        received: value,
        includeReceivedValue: true,
      }),
    );
  }
  const parsed = new Date(`${day}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== day) {
    contractFail(
      `${field} is not a valid calendar date`,
      dataRoomIssue({
        code: 'invalid_calendar_date',
        path: field,
        message: `${field} must be a real calendar day.`,
        expected: { kind: 'pattern', type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', example: '2026-09-26' },
        received: value,
        includeReceivedValue: true,
      }),
    );
  }
  return parsed;
}

export function enumerateAnalyticsPartitions(
  start: string,
  end: string,
  partitionKind: 'day' | 'month' = 'day',
): string[] {
  const first = parseIsoDay(start, 'dateRange.start');
  const last = parseIsoDay(end, 'dateRange.end');
  if (first.getTime() > last.getTime()) {
    contractFail(
      'dateRange.start must be on or before dateRange.end',
      dataRoomIssue({
        code: 'invalid_range_order',
        path: 'dateRange',
        message: 'dateRange.start must be on or before dateRange.end.',
        expected: { kind: 'relation', description: 'start <= end' },
        received: { start, end },
      }),
    );
  }
  const partitions: string[] = [];
  if (partitionKind === 'month') {
    const finalMonth = Date.UTC(last.getUTCFullYear(), last.getUTCMonth(), 1);
    for (let cursor = Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), 1); cursor <= finalMonth;) {
      const date = new Date(cursor);
      partitions.push(date.toISOString().slice(0, 7) + '-01');
      if (partitions.length > MAX_PARTITIONS_PER_REQUEST) {
        contractFail(
          `date range exceeds ${MAX_PARTITIONS_PER_REQUEST} monthly partitions`,
          dataRoomIssue({
            code: 'range_too_large', path: 'dateRange',
            message: `dateRange may span at most ${MAX_PARTITIONS_PER_REQUEST} monthly partitions.`,
            expected: { kind: 'range', type: 'array', maximum: MAX_PARTITIONS_PER_REQUEST },
            received: { start, end },
          }),
        );
      }
      cursor = Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
    }
    return partitions;
  }
  for (let cursor = first.getTime(); cursor <= last.getTime(); cursor += 24 * 60 * 60_000) {
    partitions.push(new Date(cursor).toISOString().slice(0, 10));
    if (partitions.length > MAX_PARTITIONS_PER_REQUEST) {
      contractFail(
        `date range exceeds ${MAX_PARTITIONS_PER_REQUEST} daily partitions`,
        dataRoomIssue({
          code: 'range_too_large',
          path: 'dateRange',
          message: `dateRange may span at most ${MAX_PARTITIONS_PER_REQUEST} daily partitions.`,
          expected: { kind: 'range', type: 'array', maximum: MAX_PARTITIONS_PER_REQUEST },
          received: { start, end },
        }),
      );
    }
  }
  return partitions;
}

/**
 * Inverse of enumerateAnalyticsPartitions for reporting: compress canonical
 * day (YYYY-MM-DD) or month (YYYY-MM-01) keys into sorted inclusive
 * contiguous ranges. Pure formatting; never used to widen coverage.
 */
export function compactAnalyticsPartitionRanges(
  partitions: Iterable<string>,
  partitionKind: 'day' | 'month' = 'day',
): Array<{ start: string; end: string }> {
  const sorted = [...new Set(partitions)].sort();
  const ranges: Array<{ start: string; end: string }> = [];
  const next = (key: string): string => {
    const date = new Date(`${key}T00:00:00.000Z`);
    return partitionKind === 'month'
      ? new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1)).toISOString().slice(0, 10)
      : new Date(date.getTime() + 24 * 60 * 60_000).toISOString().slice(0, 10);
  };
  for (const key of sorted) {
    const last = ranges.at(-1);
    if (last && next(last.end) === key) last.end = key;
    else ranges.push({ start: key, end: key });
  }
  return ranges;
}

function validateSha(value: unknown, field: string): string {
  const sha = cleanText(value, field).toLowerCase();
  if (!SHA256_RE.test(sha)) {
    contractFail(
      `${field} must be a SHA-256 hex digest`,
      dataRoomIssue({
        code: 'invalid_sha256',
        path: field,
        message: `${field} must be exactly 64 hexadecimal characters.`,
        expected: { kind: 'pattern', type: 'string', pattern: '^[a-fA-F0-9]{64}$' },
        received: value,
      }),
    );
  }
  return sha;
}

function normalizeFilter(filter: AnalyticsFilterValue, index: number): AnalyticsFilterValue {
  const label = `filters[${index}]`;
  if (!filter || typeof filter !== 'object' || Array.isArray(filter)) {
    contractFail(
      `${label} must be an object`,
      dataRoomIssue({
        code: 'invalid_type',
        path: label,
        message: `${label} must be a filter object.`,
        expected: { kind: 'shape', requiredKeys: ['field', 'operator', 'value'], allowedKeys: ['field', 'operator', 'value'] },
        received: filter,
      }),
    );
  }
  contractExactKeys(filter as unknown as Record<string, unknown>, ['field', 'operator', 'value'], label);
  const field = cleanText(filter.field, `${label}.field`);
  const operator = filter.operator;
  if (!['eq', 'in', 'gte', 'lte', 'between'].includes(operator)) {
    contractFail(
      `${label}.operator is unsupported`,
      dataRoomIssue({
        code: 'invalid_enum',
        path: `${label}.operator`,
        message: `${label}.operator must be one supported literal.`,
        expected: { kind: 'enum', values: ['eq', 'in', 'gte', 'lte', 'between'] },
        received: operator,
        includeReceivedValue: true,
      }),
    );
  }
  const values = Array.isArray(filter.value) ? filter.value : [filter.value];
  if (operator === 'in' && values.length === 0) {
    contractFail(
      `${label}.value must not be empty`,
      dataRoomIssue({
        code: 'too_few_items',
        path: `${label}.value`,
        message: `${label}.value must contain at least one scalar for operator=in.`,
        expected: { kind: 'range', type: 'array', minimum: 1 },
        received: filter.value,
      }),
    );
  }
  if (operator === 'between' && values.length !== 2) {
    contractFail(
      `${label}.value must contain exactly two values`,
      dataRoomIssue({
        code: 'wrong_item_count',
        path: `${label}.value`,
        message: `${label}.value must contain exactly two scalars for operator=between.`,
        expected: { kind: 'range', type: 'array', minimum: 2, maximum: 2 },
        received: filter.value,
      }),
    );
  }
  if (operator !== 'in' && operator !== 'between' && Array.isArray(filter.value)) {
    contractFail(
      `${label}.value must be scalar for ${operator}`,
      dataRoomIssue({
        code: 'invalid_type',
        path: `${label}.value`,
        message: `${label}.value must be one scalar for operator=${operator}.`,
        expected: { kind: 'type', type: 'scalar' },
        received: filter.value,
      }),
    );
  }
  for (const [valueIndex, child] of values.entries()) {
    if (child !== null && !['string', 'number', 'boolean'].includes(typeof child)) {
      contractFail(
        `${label}.value contains an unsupported type`,
        dataRoomIssue({
          code: 'invalid_type',
          path: Array.isArray(filter.value) ? `${label}.value[${valueIndex}]` : `${label}.value`,
          message: 'Filter values must be strings, finite numbers, booleans, or null.',
          expected: { kind: 'type', type: 'scalar' },
          received: child,
        }),
      );
    }
    if (typeof child === 'number' && !Number.isFinite(child)) {
      contractFail(
        `${label}.value contains a non-finite number`,
        dataRoomIssue({
          code: 'non_finite_number',
          path: Array.isArray(filter.value) ? `${label}.value[${valueIndex}]` : `${label}.value`,
          message: 'Filter numbers must be finite.',
          expected: { kind: 'type', type: 'number' },
          received: child,
        }),
      );
    }
  }
  const normalizedValue = Array.isArray(filter.value)
    ? operator === 'in'
      ? [...filter.value].sort((left, right) => stableAnalyticsJson(left).localeCompare(stableAnalyticsJson(right)))
      : [...filter.value]
    : filter.value;
  return { field, operator, value: normalizedValue };
}

export function normalizeAnalyticsRequest(input: AnalyticsRequest): AnalyticsRequest {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    contractFail(
      'analytics request must be an object',
      dataRoomIssue({
        code: 'invalid_type',
        path: '$',
        message: 'request must be one fully specified object, not prose or a string.',
        expected: { kind: 'type', type: 'object' },
        received: input,
      }),
    );
  }
  const record = input as unknown as Record<string, unknown>;
  contractExactKeys(record, [
    'domainKey', 'metric', 'dimensions', 'filters', 'dateRange', 'timeZone', 'countingKey',
    'regime', 'requiredGrain', 'freshness', 'use', 'datasetId', 'versionId', 'resultLimit',
    'requiredContractSha256', 'unresolvedSemantics',
  ], 'analytics request');
  if (!input.metric || typeof input.metric !== 'object' || Array.isArray(input.metric)) {
    contractFail('metric must be an object', dataRoomIssue({
      code: 'invalid_type', path: 'metric', message: 'metric must be one exact semantic identity object.',
      expected: { kind: 'shape', requiredKeys: ['id', 'version', 'definitionSha256', 'unit'], allowedKeys: ['id', 'version', 'definitionSha256', 'unit'] }, received: input.metric,
    }));
  }
  contractExactKeys(input.metric as unknown as Record<string, unknown>, ['id', 'version', 'definitionSha256', 'unit'], 'metric');
  if (!input.dateRange || typeof input.dateRange !== 'object' || Array.isArray(input.dateRange)) {
    contractFail('dateRange must be an object', dataRoomIssue({
      code: 'invalid_type', path: 'dateRange', message: 'dateRange must contain exact start and end days.',
      expected: { kind: 'shape', requiredKeys: ['start', 'end'], allowedKeys: ['start', 'end'] }, received: input.dateRange,
    }));
  }
  contractExactKeys(input.dateRange as unknown as Record<string, unknown>, ['start', 'end'], 'dateRange');
  if (!input.regime || typeof input.regime !== 'object' || Array.isArray(input.regime)) {
    contractFail('regime must be an object', dataRoomIssue({
      code: 'invalid_type', path: 'regime', message: 'regime must be one exact semantic identity object.',
      expected: { kind: 'shape', requiredKeys: ['id', 'version', 'definitionSha256'], allowedKeys: ['id', 'version', 'definitionSha256'] }, received: input.regime,
    }));
  }
  contractExactKeys(input.regime as unknown as Record<string, unknown>, ['id', 'version', 'definitionSha256'], 'regime');
  const freshness = input.freshness;
  if (!freshness || typeof freshness !== 'object' || Array.isArray(freshness)) {
    contractFail('freshness must be an object', dataRoomIssue({
      code: 'invalid_type', path: 'freshness', message: 'freshness must be one supported mode object.',
      expected: { kind: 'shape', requiredKeys: ['mode'], allowedKeys: ['mode', 'maxAgeMs'] }, received: freshness,
    }));
  }
  contractExactKeys(freshness as unknown as Record<string, unknown>, ['mode', 'maxAgeMs'], 'freshness');
  const dateStart = parseIsoDay(input.dateRange.start, 'dateRange.start').toISOString().slice(0, 10);
  const dateEnd = parseIsoDay(input.dateRange.end, 'dateRange.end').toISOString().slice(0, 10);
  enumerateAnalyticsPartitions(dateStart, dateEnd);
  if (!['historical_as_of', 'allow_stale', 'fresh_by'].includes(freshness.mode)) {
    contractFail('freshness.mode is unsupported', dataRoomIssue({
      code: 'invalid_enum', path: 'freshness.mode', message: 'freshness.mode must be one supported literal.',
      expected: { kind: 'enum', values: ['historical_as_of', 'allow_stale', 'fresh_by'] }, received: freshness.mode, includeReceivedValue: true,
    }));
  }
  if (freshness.mode === 'fresh_by'
    && (!Number.isFinite(freshness.maxAgeMs) || freshness.maxAgeMs! < 0)) {
    contractFail('freshness.maxAgeMs must be a non-negative finite number', dataRoomIssue({
      code: 'out_of_range', path: 'freshness.maxAgeMs', message: 'freshness.maxAgeMs must be a non-negative finite number when mode=fresh_by.',
      expected: { kind: 'range', type: 'number', minimum: 0 }, received: freshness.maxAgeMs,
    }));
  }
  if (!Array.isArray(input.filters)) {
    contractFail('filters must be an array', dataRoomIssue({
      code: 'invalid_type', path: 'filters', message: 'filters must be an array; use [] when no filters apply.',
      expected: { kind: 'type', type: 'array' }, received: input.filters,
    }));
  }
  const filters = input.filters
    .map(normalizeFilter)
    .sort((left, right) => stableAnalyticsJson(left).localeCompare(stableAnalyticsJson(right)));
  const normalized: AnalyticsRequest = {
    domainKey: cleanText(input.domainKey, 'domainKey'),
    metric: {
      id: cleanText(input.metric.id, 'metric.id'),
      version: cleanText(input.metric.version, 'metric.version'),
      definitionSha256: validateSha(input.metric.definitionSha256, 'metric.definitionSha256'),
      unit: cleanText(input.metric.unit, 'metric.unit'),
    },
    dimensions: uniqueSorted(input.dimensions, 'dimensions'),
    filters,
    dateRange: { start: dateStart, end: dateEnd },
    timeZone: cleanText(input.timeZone, 'timeZone'),
    countingKey: cleanText(input.countingKey, 'countingKey'),
    regime: {
      id: cleanText(input.regime.id, 'regime.id'),
      version: cleanText(input.regime.version, 'regime.version'),
      definitionSha256: validateSha(input.regime.definitionSha256, 'regime.definitionSha256'),
    },
    requiredGrain: cleanText(input.requiredGrain, 'requiredGrain'),
    freshness: freshness.mode === 'fresh_by'
      ? { mode: 'fresh_by', maxAgeMs: freshness.maxAgeMs! }
      : { mode: freshness.mode },
    use: input.use,
    ...(input.datasetId !== undefined
      ? { datasetId: cleanText(input.datasetId, 'datasetId') }
      : {}),
    ...(input.versionId !== undefined
      ? { versionId: cleanText(input.versionId, 'versionId') }
      : {}),
    ...(input.resultLimit !== undefined
      ? { resultLimit: input.resultLimit }
      : {}),
    ...(input.requiredContractSha256
      ? { requiredContractSha256: validateSha(input.requiredContractSha256, 'requiredContractSha256') }
      : {}),
    ...(input.unresolvedSemantics !== undefined
      ? { unresolvedSemantics: uniqueSorted(input.unresolvedSemantics, 'unresolvedSemantics') }
      : {}),
  };
  if (!['local_answer', 'dashboard', 'publication'].includes(normalized.use)) {
    contractFail('use is unsupported', dataRoomIssue({
      code: 'invalid_enum', path: 'use', message: 'use must be one supported Data Room consumer literal.',
      expected: { kind: 'enum', values: ['local_answer', 'dashboard', 'publication'] }, received: input.use, includeReceivedValue: true,
    }));
  }
  if (normalized.datasetId && !DATASET_ID_RE.test(normalized.datasetId)) {
    contractFail('datasetId is malformed', dataRoomIssue({
      code: 'invalid_pattern', path: 'datasetId', message: 'datasetId must be an exact Data Room dataset ID.',
      expected: { kind: 'pattern', type: 'string', pattern: '^ds_[a-zA-Z0-9_-]{1,96}$' }, received: input.datasetId, includeReceivedValue: true,
    }));
  }
  if (normalized.versionId && !VERSION_ID_RE.test(normalized.versionId)) {
    contractFail('versionId is malformed', dataRoomIssue({
      code: 'invalid_pattern', path: 'versionId', message: 'versionId must be an exact immutable Data Room version ID.',
      expected: { kind: 'pattern', type: 'string', pattern: '^dsv_[a-f0-9]{24}$' }, received: input.versionId, includeReceivedValue: true,
    }));
  }
  if (normalized.resultLimit !== undefined
    && (!Number.isInteger(normalized.resultLimit) || normalized.resultLimit < 1 || normalized.resultLimit > 200)) {
    contractFail('resultLimit must be an integer from 1 to 200', dataRoomIssue({
      code: 'out_of_range', path: 'resultLimit', message: 'resultLimit must be an integer from 1 to 200.',
      expected: { kind: 'range', type: 'integer', minimum: 1, maximum: 200 }, received: input.resultLimit, includeReceivedValue: true,
    }));
  }
  return normalized;
}

export function analyticsRequestSha256(input: AnalyticsRequest): string {
  return analyticsSha256(normalizeAnalyticsRequest(input));
}

function sameIdentity(left: unknown, right: unknown): boolean {
  return stableAnalyticsJson(left) === stableAnalyticsJson(right);
}

function rejection(
  rejections: AnalyticsCandidateRejection[],
  code: AnalyticsCandidateRejectionCode,
  detail: string,
): void {
  if (!rejections.some(item => item.code === code && item.detail === detail)) {
    rejections.push({ code, detail });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function hasText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function validIsoDay(value: unknown): boolean {
  if (!hasText(value) || !ISO_DAY_RE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function candidateContractIsWellFormed(candidate: unknown): boolean {
  if (!isRecord(candidate)
    || !hasText(candidate.datasetId)
    || (candidate.capability !== 'materialized_answer' && candidate.capability !== 'local_derivation')
    || (candidate.capability === 'materialized_answer' && !hasText(candidate.versionId))
    || (candidate.capability === 'local_derivation'
      && (!hasText(candidate.derivationKey) || !SHA256_RE.test(candidate.derivationKey)))
    || !hasText(candidate.contentSha256) || !SHA256_RE.test(candidate.contentSha256)
    || typeof candidate.contentExists !== 'boolean'
    || typeof candidate.integrityVerified !== 'boolean'
    || !isRecord(candidate.contract)
    || !Array.isArray(candidate.quality)
    || !hasText(candidate.materializedAt)) return false;
  const contract = candidate.contract;
  if (!hasText(contract.contractVersion)
    || !hasText(contract.contractSha256) || !SHA256_RE.test(contract.contractSha256)
    || !['active', 'deprecated', 'retired'].includes(String(contract.status ?? ''))
    || !hasText(contract.datasetId)
    || !['source', 'derived'].includes(String(contract.datasetKind ?? ''))
    || !['dashboard_local', 'project', 'workspace'].includes(String(contract.scope ?? ''))
    || !hasText(contract.domainKey)
    || !hasText(contract.schemaSha256) || !SHA256_RE.test(contract.schemaSha256)
    || !Array.isArray(contract.schema)
    || !isRecord(contract.metric)
    || !isRecord(contract.regime)
    || !hasText(contract.countingKey)
    || !hasText(contract.unit)
    || !hasText(contract.grain)
    || !Array.isArray(contract.availableDimensions)
    || !hasText(contract.timeField)
    || !hasText(contract.timeZone)
    || !isRecord(contract.coverage)
    || !isRecord(contract.handling)) return false;
  const coverage = contract.coverage as Record<string, unknown>;
  if (!hasText(contract.metric.id)
    || !hasText(contract.metric.version)
    || !hasText(contract.metric.definitionSha256) || !SHA256_RE.test(contract.metric.definitionSha256)
    || !hasText(contract.metric.unit)
    || !hasText(contract.regime.id)
    || !hasText(contract.regime.version)
    || !hasText(contract.regime.definitionSha256) || !SHA256_RE.test(contract.regime.definitionSha256)) return false;
  if (contract.schema.some(field => !isRecord(field)
      || !hasText(field.name)
      || !['string', 'integer', 'number', 'boolean', 'date', 'timestamp'].includes(String(field.logicalType ?? ''))
      || (field.physicalType !== undefined && !hasText(field.physicalType))
      || typeof field.nullable !== 'boolean')
    || contract.availableDimensions.some(value => !hasText(value))) return false;
  if (!['day', 'month'].includes(String(coverage.partitionKind ?? ''))
    || !Array.isArray(coverage.completePartitions)
    || coverage.completePartitions.some(value => !validIsoDay(value)
      || (coverage.partitionKind === 'month' && !value.endsWith('-01')))
    || !hasText(coverage.watermark)) return false;
  if (!Array.isArray(contract.handling.allowedUses)
    || contract.handling.allowedUses.some(value => !['local_answer', 'dashboard', 'publication'].includes(String(value)))
    || !hasText(contract.handling.classification)
    || typeof contract.handling.allowModelContext !== 'boolean'
    || typeof contract.handling.allowPublication !== 'boolean') return false;
  if (candidate.quality.some(item => !isRecord(item)
    || !hasText(item.assertionId)
    || !hasText(item.assertionVersion)
    || !['warning', 'error'].includes(String(item.severity ?? ''))
    || typeof item.success !== 'boolean')) return false;
  if (candidate.querySupported !== undefined && typeof candidate.querySupported !== 'boolean') return false;
  if (candidate.selectionRank !== undefined
    && (!Number.isInteger(candidate.selectionRank) || Number(candidate.selectionRank) < 0)) return false;
  if (candidate.derivableGrains !== undefined
    && (!Array.isArray(candidate.derivableGrains) || candidate.derivableGrains.some(value => !hasText(value)))) return false;
  if (candidate.derivationSupported !== undefined && typeof candidate.derivationSupported !== 'boolean') return false;
  return true;
}

export function evaluateAnalyticsCandidate(
  input: AnalyticsRequest,
  candidate: AnalyticsDataRoomCandidate,
  nowMs = Date.now(),
): AnalyticsCandidateEligibility {
  const request = normalizeAnalyticsRequest(input);
  const rejections: AnalyticsCandidateRejection[] = [];
  const contractWellFormed = candidateContractIsWellFormed(candidate);
  const requestedPartitions = enumerateAnalyticsPartitions(
    request.dateRange.start,
    request.dateRange.end,
    contractWellFormed ? candidate.contract.coverage.partitionKind : 'day',
  );
  const candidateCapability = candidate?.capability === 'local_derivation'
    ? 'local_derivation'
    : 'materialized_answer';
  if (!contractWellFormed) {
    return {
      eligible: false,
      datasetId: String(candidate?.datasetId ?? ''),
      ...(candidate?.versionId ? { versionId: String(candidate.versionId) } : {}),
      ...(candidate?.derivationKey ? { derivationKey: String(candidate.derivationKey) } : {}),
      capability: candidateCapability,
      rejections: [{ code: 'contract_mismatch', detail: 'Candidate contract is malformed or incomplete.' }],
      warnings: [],
      requestedPartitions,
      missingPartitions: requestedPartitions,
    };
  }
  const contract = candidate.contract;

  if (!candidate.contentExists) rejection(rejections, 'content_missing', 'Materialized bytes do not exist.');
  if (!candidate.integrityVerified) rejection(rejections, 'integrity_unverified', 'Materialized bytes have not passed integrity verification.');
  if (contract.status !== 'active') rejection(rejections, 'contract_inactive', `Contract is ${contract.status}.`);
  if (contract.datasetId !== candidate.datasetId) rejection(rejections, 'contract_mismatch', 'Contract dataset identity differs from the candidate.');
  if (request.requiredContractSha256 && request.requiredContractSha256 !== contract.contractSha256.toLowerCase()) {
    rejection(rejections, 'contract_mismatch', 'Required contract SHA does not match the candidate contract.');
  }
  if (contract.domainKey !== request.domainKey) rejection(rejections, 'domain_mismatch', 'Dataset domain does not match the request.');
  if (!sameIdentity(contract.metric, request.metric)) rejection(rejections, 'metric_mismatch', 'Metric identity/version/definition differs.');
  if (!sameIdentity(contract.regime, request.regime)) rejection(rejections, 'regime_mismatch', 'Filter regime identity/version/definition differs.');
  if (contract.countingKey !== request.countingKey) rejection(rejections, 'counting_key_mismatch', 'Counting key differs.');
  if (contract.unit !== request.metric.unit || contract.metric.unit !== request.metric.unit) {
    rejection(rejections, 'unit_mismatch', 'Metric unit differs.');
  }

  const schemaFields = new Set(contract.schema.map(field => field.name));
  const availableDimensions = new Set(contract.availableDimensions);
  for (const dimension of request.dimensions) {
    if (!availableDimensions.has(dimension) || !schemaFields.has(dimension)) {
      rejection(rejections, 'dimension_missing', `Dimension ${dimension} is unavailable.`);
    }
  }
  for (const filter of request.filters) {
    if (!schemaFields.has(filter.field)) {
      rejection(rejections, 'filter_field_missing', `Filter field ${filter.field} is unavailable.`);
    }
  }
  if (!schemaFields.has(contract.countingKey)) {
    rejection(rejections, 'counting_key_mismatch', `Counting key field ${contract.countingKey} is absent from the schema.`);
  }
  if (!schemaFields.has(contract.timeField)) {
    rejection(rejections, 'coverage_gap', `Time field ${contract.timeField} is absent from the schema.`);
  }

  const grainMatches = contract.grain === request.requiredGrain;
  if (candidate.capability === 'materialized_answer' && candidate.querySupported === false) {
    rejection(rejections, 'query_unsupported', 'No definition-owned exact projection recipe supports this materialized version.');
  }
  if (candidate.capability === 'materialized_answer' && !grainMatches) {
    rejection(rejections, 'grain_incompatible', `Materialized grain ${contract.grain} cannot satisfy ${request.requiredGrain}.`);
  }
  if (candidate.capability === 'local_derivation') {
    if (!candidate.derivationSupported) {
      rejection(rejections, 'derivation_unsupported', 'No deterministic local derivation supports this request.');
    }
    if (!grainMatches && !(candidate.derivableGrains ?? []).includes(request.requiredGrain)) {
      rejection(rejections, 'grain_incompatible', `Local source cannot derive grain ${request.requiredGrain}.`);
    }
  }

  if (contract.timeZone !== request.timeZone) {
    rejection(rejections, 'timezone_mismatch', `Dataset timezone ${contract.timeZone} differs from ${request.timeZone}.`);
  }
  const complete = new Set(contract.coverage.completePartitions);
  const missingPartitions = requestedPartitions.filter(partition => !complete.has(partition));
  if (missingPartitions.length) {
    rejection(rejections, 'coverage_gap', `Missing ${missingPartitions.length} requested partition(s): ${missingPartitions.slice(0, 5).join(', ')}.`);
  }

  const materializedAt = Date.parse(candidate.materializedAt);
  if (!Number.isFinite(materializedAt) || materializedAt > nowMs + 5 * 60_000) {
    rejection(rejections, 'freshness_miss', 'Materialized timestamp is invalid or implausibly in the future.');
  } else if (request.freshness.mode === 'fresh_by' && nowMs - materializedAt > request.freshness.maxAgeMs) {
    rejection(rejections, 'freshness_miss', `Materialization age exceeds ${request.freshness.maxAgeMs} ms.`);
  }
  const watermarkAt = Date.parse(contract.coverage.watermark);
  if (!Number.isFinite(watermarkAt) || watermarkAt > nowMs + 5 * 60_000) {
    rejection(rejections, 'freshness_miss', 'Coverage watermark is invalid or implausibly in the future.');
  } else if (request.freshness.mode === 'fresh_by' && nowMs - watermarkAt > request.freshness.maxAgeMs) {
    rejection(rejections, 'freshness_miss', `Coverage watermark age exceeds ${request.freshness.maxAgeMs} ms.`);
  }

  const qualityFailures = candidate.quality.filter(item => !item.success && item.severity === 'error');
  const warnings = candidate.quality.filter(item => !item.success && item.severity === 'warning');
  if (qualityFailures.length) {
    rejection(rejections, 'quality_error', `${qualityFailures.length} blocking quality assertion(s) failed.`);
  }

  // Publication is never gated by dataset handling (owner directive 2026-10-10).
  if (request.use !== 'publication' && (!contract.handling.allowedUses.includes(request.use)
    || (request.use === 'local_answer' && !contract.handling.allowModelContext))) {
    rejection(rejections, 'handling_disallowed', `Handling policy does not permit ${request.use}.`);
  }

  return {
    eligible: rejections.length === 0,
    datasetId: candidate.datasetId,
    ...(candidate.versionId ? { versionId: candidate.versionId } : {}),
    ...(candidate.derivationKey ? { derivationKey: candidate.derivationKey } : {}),
    capability: candidate.capability,
    rejections,
    warnings,
    requestedPartitions,
    missingPartitions,
  };
}

export function chooseAnalyticsSource(
  input: AnalyticsRequest,
  candidates: AnalyticsDataRoomCandidate[],
  lanes: AnalyticsRemoteLaneAvailability,
  nowMs = Date.now(),
): AnalyticsSourceDecision {
  const request = normalizeAnalyticsRequest(input);
  if (request.unresolvedSemantics?.length) {
    return {
      kind: 'clarification_required',
      reason: 'request_semantics_unresolved',
      clarificationFields: request.unresolvedSemantics,
      candidates: [],
    };
  }

  const sortedCandidates = [...candidates].sort((left, right) => {
    const leftRecord: Record<string, unknown> = isRecord(left) ? left : {};
    const rightRecord: Record<string, unknown> = isRecord(right) ? right : {};
    const leftCapabilityRank = leftRecord.capability === 'materialized_answer'
      ? 0
      : leftRecord.capability === 'local_derivation' ? 1 : 2;
    const rightCapabilityRank = rightRecord.capability === 'materialized_answer'
      ? 0
      : rightRecord.capability === 'local_derivation' ? 1 : 2;
    const leftSelectionRank = Number.isInteger(leftRecord.selectionRank)
      ? Number(leftRecord.selectionRank)
      : Number.MAX_SAFE_INTEGER;
    const rightSelectionRank = Number.isInteger(rightRecord.selectionRank)
      ? Number(rightRecord.selectionRank)
      : Number.MAX_SAFE_INTEGER;
    return leftCapabilityRank - rightCapabilityRank
      || leftSelectionRank - rightSelectionRank
      || String(leftRecord.datasetId ?? '').localeCompare(String(rightRecord.datasetId ?? ''))
      || String(leftRecord.versionId ?? '').localeCompare(String(rightRecord.versionId ?? ''));
  });
  const evaluated = sortedCandidates.map(candidate => evaluateAnalyticsCandidate(request, candidate, nowMs));
  const materialized = evaluated.find(candidate => candidate.eligible && candidate.capability === 'materialized_answer');
  if (materialized) {
    return {
      kind: 'ready_materialized',
      reason: 'exact_materialized_candidate',
      selectedDatasetId: materialized.datasetId,
      selectedVersionId: materialized.versionId,
      candidates: evaluated,
    };
  }
  const derived = evaluated.find(candidate => candidate.eligible && candidate.capability === 'local_derivation');
  if (derived) {
    return {
      kind: 'ready_derived',
      reason: 'eligible_local_derivation',
      selectedDatasetId: derived.datasetId,
      selectedDerivationKey: derived.derivationKey,
      candidates: evaluated,
    };
  }

  // Block only when handling is the candidate's sole rejection so an unrelated
  // or otherwise ineligible catalog entry cannot veto a valid remote lane.
  // Remote selection is not authorization: R1/R2 must independently evaluate
  // the exact acquired version's handling contract before any use.
  if (evaluated.some(candidate => candidate.rejections.length > 0
    && candidate.rejections.every(item => item.code === 'handling_disallowed'))) {
    return { kind: 'blocked_policy', reason: 'handling_policy_denied', candidates: evaluated };
  }
  if (lanes.sqlUsable) {
    return { kind: 'refresh_sql', reason: 'local_candidates_ineligible_sql_ready', candidates: evaluated };
  }
  if (lanes.etlUsable) {
    return { kind: 'refresh_etl', reason: 'local_candidates_ineligible_etl_ready', candidates: evaluated };
  }
  return { kind: 'blocked_no_lane', reason: 'no_eligible_source', candidates: evaluated };
}

function canonicalRows(answer: AnalyticsCanonicalAnswer): AnalyticsDataCell[][] {
  return answer.result.rows
    .map(row => [...row])
    .sort((left, right) => stableAnalyticsJson(left).localeCompare(stableAnalyticsJson(right)));
}

export function analyticsRowSetSha256(answer: AnalyticsCanonicalAnswer): string {
  return analyticsSha256({ columns: answer.result.columns, rows: canonicalRows(answer) });
}

function addMismatch(
  mismatches: AnalyticsParityMismatch[],
  code: AnalyticsParityMismatchCode,
  left: unknown,
  right: unknown,
): void {
  if (!sameIdentity(left, right)) mismatches.push({ code, left, right });
}

/**
 * Compare source-independent operational meaning. Source kind, local paths,
 * dataset/version IDs, content SHA, and materialization timestamps may differ
 * across SQL, ETL, materialized, and derived adapters; semantic identity and
 * canonical answers may not.
 */
export function compareAnalyticsAnswers(
  left: AnalyticsCanonicalAnswer,
  right: AnalyticsCanonicalAnswer,
): AnalyticsParityResult {
  const mismatches: AnalyticsParityMismatch[] = [];
  const leftRowsSha = analyticsRowSetSha256(left);
  const rightRowsSha = analyticsRowSetSha256(right);
  addMismatch(mismatches, 'request', left.receipt.requestSha256, right.receipt.requestSha256);
  addMismatch(mismatches, 'columns', left.result.columns, right.result.columns);
  if (leftRowsSha !== rightRowsSha) mismatches.push({ code: 'rows', left: leftRowsSha, right: rightRowsSha });
  addMismatch(mismatches, 'row_count', left.result.rowCount, right.result.rowCount);
  addMismatch(mismatches, 'displayed_row_count', left.result.displayedRowCount, right.result.displayedRowCount);
  addMismatch(mismatches, 'truncation', left.result.truncated, right.result.truncated);
  addMismatch(mismatches, 'metric', left.receipt.metric, right.receipt.metric);
  addMismatch(mismatches, 'regime', left.receipt.regime, right.receipt.regime);
  addMismatch(mismatches, 'counting_key', left.receipt.countingKey, right.receipt.countingKey);
  addMismatch(mismatches, 'grain', left.receipt.grain, right.receipt.grain);
  addMismatch(mismatches, 'dimensions', [...left.receipt.dimensions].sort(), [...right.receipt.dimensions].sort());
  addMismatch(mismatches, 'unit', left.receipt.unit, right.receipt.unit);
  addMismatch(mismatches, 'timezone', left.receipt.timeZone, right.receipt.timeZone);
  addMismatch(mismatches, 'requested_range', left.receipt.requestedRange, right.receipt.requestedRange);
  addMismatch(mismatches, 'coverage', [...left.receipt.coveredPartitions].sort(), [...right.receipt.coveredPartitions].sort());
  addMismatch(mismatches, 'watermark', left.receipt.watermark, right.receipt.watermark);
  addMismatch(mismatches, 'contract', left.receipt.contractSha256, right.receipt.contractSha256);
  addMismatch(mismatches, 'definition', left.receipt.definitionSha256, right.receipt.definitionSha256);
  addMismatch(mismatches, 'quality_warnings', [...left.receipt.qualityWarnings].sort(), [...right.receipt.qualityWarnings].sort());
  addMismatch(mismatches, 'limitations', [...left.receipt.limitations].sort(), [...right.receipt.limitations].sort());
  return {
    equal: mismatches.length === 0,
    leftRowSetSha256: leftRowsSha,
    rightRowSetSha256: rightRowsSha,
    mismatches,
  };
}

const RESEARCH_EVIDENCE_KEYS: Array<Exclude<keyof AnalyticsResearchFeatureEvidence, 'feature'>> = [
  'namedUserOutcome',
  'reproducedFailureOrReuse',
  'simplerContractInsufficient',
  'deterministicEnforcement',
  'adversarialBeforeAfterTest',
  'proportionalRuntimeCost',
  'reversibleOrMigratable',
  'rolloutThresholdMet',
];

export function evaluateResearchFeatureGraduation(
  evidence: AnalyticsResearchFeatureEvidence,
): AnalyticsResearchFeatureDecision {
  const missingEvidence = RESEARCH_EVIDENCE_KEYS.filter(key => evidence[key] !== true);
  return {
    feature: evidence.feature,
    graduated: missingEvidence.length === 0,
    missingEvidence,
  };
}
