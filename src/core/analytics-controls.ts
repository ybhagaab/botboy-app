import {
  analyticsRequestSha256,
  analyticsSha256,
  normalizeAnalyticsRequest,
  stableAnalyticsJson,
} from './analytics-data-room-policy.js';
import { isAnalyticsIsoTimestamp } from './analytics-data-room-store.js';
import type {
  AnalyticsControlOperator,
  AnalyticsDashboardViewRequestV1,
  AnalyticsDataCell,
  AnalyticsDatasetControlDefinitionV1,
  AnalyticsDatasetControlState,
  AnalyticsDatasetControlValuesV1,
  AnalyticsDatasetDetail,
  AnalyticsDatasetVersionDetail,
  AnalyticsFieldContract,
  AnalyticsFilterValue,
  AnalyticsLogicalType,
  AnalyticsMaterializedAnswerRecipeV1,
} from './analytics-data-room-types.js';
import type { AnalyticsWidgetDataRoomBinding } from './analytics-types.js';

const ISO_DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_FILTERS = 20;
const MAX_TOTAL_IN_VALUES = 100;
const MAX_STRING_CHARS = 512;

export type AnalyticsControlErrorCode = 'invalid_input' | 'incompatible';

export class AnalyticsControlError extends Error {
  constructor(readonly code: AnalyticsControlErrorCode, message: string) {
    super(message);
    this.name = 'AnalyticsControlError';
  }
}

function fail(code: AnalyticsControlErrorCode, message: string): never {
  throw new AnalyticsControlError(code, message);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('invalid_input', `${label} must be an object.`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const extras = Object.keys(value).filter(key => !allowed.includes(key)).sort();
  if (extras.length) fail('invalid_input', `${label} contains unsupported fields: ${extras.join(', ')}.`);
}

function validDay(value: unknown, label: string): string {
  if (typeof value !== 'string' || !ISO_DAY_RE.test(value)) fail('invalid_input', `${label} must be an ISO day.`);
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    fail('invalid_input', `${label} must be a real ISO day.`);
  }
  return value;
}

function validTimeZone(value: string): void {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format(new Date(0));
  } catch {
    fail('incompatible', `Dataset timezone ${value} is invalid.`);
  }
}

function recipe(dataset: AnalyticsDatasetDetail): AnalyticsMaterializedAnswerRecipeV1 {
  const value = record(dataset.definition.answer, 'Dataset answer recipe');
  exactKeys(value, ['version', 'metricId', 'metricValueColumn', 'rowDimensions', 'filterableFields', 'stableOrder'], 'Dataset answer recipe');
  if (value.version !== 1 || typeof value.metricId !== 'string' || typeof value.metricValueColumn !== 'string') {
    fail('incompatible', 'Dataset answer recipe is not materialized-answer v1.');
  }
  const strings = (input: unknown, label: string): string[] => {
    if (!Array.isArray(input) || input.some(item => typeof item !== 'string' || !item || item.includes('\0'))) {
      fail('incompatible', `${label} must contain bounded field names.`);
    }
    if (new Set(input).size !== input.length) fail('incompatible', `${label} contains duplicate fields.`);
    return [...input] as string[];
  };
  const stableOrder = Array.isArray(value.stableOrder)
    ? value.stableOrder.map((raw, index) => {
        const item = record(raw, `answer.stableOrder[${index}]`);
        exactKeys(item, ['field', 'direction'], `answer.stableOrder[${index}]`);
        if (typeof item.field !== 'string' || !item.field || (item.direction !== 'asc' && item.direction !== 'desc')) {
          fail('incompatible', `answer.stableOrder[${index}] is malformed.`);
        }
        return { field: item.field, direction: item.direction } as const;
      })
    : fail('incompatible', 'answer.stableOrder must be an array.');
  if (new Set(stableOrder.map(item => item.field)).size !== stableOrder.length) {
    fail('incompatible', 'answer.stableOrder contains duplicate fields.');
  }
  return {
    version: 1,
    metricId: value.metricId,
    metricValueColumn: value.metricValueColumn,
    rowDimensions: strings(value.rowDimensions, 'answer.rowDimensions'),
    filterableFields: strings(value.filterableFields, 'answer.filterableFields'),
    stableOrder,
  };
}

function operators(type: AnalyticsLogicalType): AnalyticsControlOperator[] {
  return type === 'string' || type === 'boolean'
    ? ['eq', 'in']
    : ['eq', 'in', 'gte', 'lte', 'between'];
}

export function deriveAnalyticsControlDefinition(input: {
  dataset: AnalyticsDatasetDetail;
  version: AnalyticsDatasetVersionDetail;
  binding: AnalyticsWidgetDataRoomBinding;
}): AnalyticsDatasetControlDefinitionV1 {
  const { dataset, version, binding } = input;
  if (dataset.id !== binding.datasetId || version.datasetId !== dataset.id) {
    fail('incompatible', 'Control dataset, version, and binding identities differ.');
  }
  if (dataset.definitionRevision < 1 || dataset.definitionSha256 !== version.definitionSha256) {
    fail('incompatible', 'Selected version does not match the current dataset definition.');
  }
  if (version.contractSha256 !== dataset.contractSha256
    || version.contract.schemaSha256 !== dataset.schemaSha256) {
    fail('incompatible', 'Selected version contract or declared schema differs from the current dataset definition.');
  }
  const answer = recipe(dataset);
  const fields = new Map(version.contract.schema.map(field => [field.name, field]));
  const timeField = fields.get(version.contract.timeField);
  if (!timeField || (timeField.logicalType !== 'date' && timeField.logicalType !== 'timestamp')) {
    fail('incompatible', 'Dataset time field is absent or not date-compatible.');
  }
  if (!answer.filterableFields.includes(timeField.name)) {
    fail('incompatible', 'Dataset time field is not approved by the answer recipe.');
  }
  validTimeZone(version.contract.timeZone);
  const requireField = (name: string): AnalyticsFieldContract => {
    const field = fields.get(name);
    if (!field) fail('incompatible', `Control field ${name} is absent from the immutable schema.`);
    return field;
  };
  for (const name of [
    ...answer.rowDimensions,
    ...answer.filterableFields,
    ...answer.stableOrder.map(item => item.field),
    answer.metricValueColumn,
  ]) requireField(name);

  const filterFields = [...answer.filterableFields]
    .filter(name => name !== timeField.name)
    .sort()
    .map(name => {
      const field = requireField(name);
      return {
        field: field.name,
        logicalType: field.logicalType,
        nullable: field.nullable,
        operators: operators(field.logicalType),
      };
    });
  const sortNames = [...new Set([...answer.rowDimensions, answer.metricValueColumn])].sort();
  return {
    version: 1,
    datasetId: dataset.id,
    bindingRevision: binding.revision,
    datasetDefinitionRevision: dataset.definitionRevision,
    datasetDefinitionSha256: dataset.definitionSha256,
    contractSha256: version.contractSha256,
    schemaSha256: version.contract.schemaSha256,
    answerRecipeSha256: analyticsSha256(answer),
    date: {
      field: timeField.name,
      logicalType: timeField.logicalType,
      timeZone: version.contract.timeZone,
      inclusiveCalendarDays: true,
    },
    filters: filterFields,
    sort: {
      fields: sortNames.map(name => ({ field: name, logicalType: requireField(name).logicalType })),
      directions: ['asc', 'desc'],
      defaultStableOrder: answer.stableOrder,
    },
    limits: {
      maxFilters: MAX_FILTERS,
      maxTotalInValues: MAX_TOTAL_IN_VALUES,
      maxStringChars: MAX_STRING_CHARS,
      maxResultRows: binding.presentationLimit,
    },
  };
}

function normalizeScalar(value: unknown, field: AnalyticsDatasetControlDefinitionV1['filters'][number], label: string): AnalyticsDataCell {
  if (value === null) {
    if (!field.nullable) fail('invalid_input', `${label} cannot be null.`);
    return null;
  }
  if (field.logicalType === 'boolean') {
    if (typeof value !== 'boolean') fail('invalid_input', `${label} must be boolean.`);
    return value;
  }
  if (field.logicalType === 'integer') {
    if (typeof value !== 'number' || !Number.isSafeInteger(value)) fail('invalid_input', `${label} must be a safe integer.`);
    return value;
  }
  if (field.logicalType === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) fail('invalid_input', `${label} must be finite.`);
    return value;
  }
  if (typeof value !== 'string' || value.length > MAX_STRING_CHARS || value.includes('\0')) {
    fail('invalid_input', `${label} must be a bounded string without null bytes.`);
  }
  if (field.logicalType === 'date') return validDay(value, label);
  if (field.logicalType === 'timestamp' && !isAnalyticsIsoTimestamp(value)) {
    fail('invalid_input', `${label} must be an ISO timestamp.`);
  }
  return value;
}

function ordered(left: AnalyticsDataCell, right: AnalyticsDataCell): boolean {
  if (typeof left === 'number' && typeof right === 'number') return left <= right;
  if (typeof left === 'string' && typeof right === 'string') return left <= right;
  return false;
}

export function normalizeAnalyticsControlValues(
  raw: unknown,
  definition: AnalyticsDatasetControlDefinitionV1,
): AnalyticsDatasetControlValuesV1 {
  const value = record(raw, 'controls');
  exactKeys(value, ['version', 'dateRange', 'filters', 'sort'], 'controls');
  if (value.version !== 1) fail('invalid_input', 'controls.version must be 1.');
  const dateRange = record(value.dateRange, 'controls.dateRange');
  exactKeys(dateRange, ['start', 'end'], 'controls.dateRange');
  const start = validDay(dateRange.start, 'controls.dateRange.start');
  const end = validDay(dateRange.end, 'controls.dateRange.end');
  if (start > end) fail('invalid_input', 'controls.dateRange start must not be after end.');

  if (!Array.isArray(value.filters) || value.filters.length > definition.limits.maxFilters) {
    fail('invalid_input', `controls.filters must contain at most ${definition.limits.maxFilters} filters.`);
  }
  const allowed = new Map(definition.filters.map(field => [field.field, field]));
  let totalInValues = 0;
  const filters: AnalyticsFilterValue[] = value.filters.map((rawFilter, filterIndex) => {
    const filter = record(rawFilter, `controls.filters[${filterIndex}]`);
    exactKeys(filter, ['field', 'operator', 'value'], `controls.filters[${filterIndex}]`);
    if (typeof filter.field !== 'string' || typeof filter.operator !== 'string') {
      fail('invalid_input', `controls.filters[${filterIndex}] field/operator is invalid.`);
    }
    const field = allowed.get(filter.field);
    if (!field || !field.operators.includes(filter.operator as AnalyticsControlOperator)) {
      fail('invalid_input', `Control filter ${filter.field}/${filter.operator} is not allowed.`);
    }
    const operator = filter.operator as AnalyticsControlOperator;
    if (operator === 'in') {
      if (!Array.isArray(filter.value) || filter.value.length < 1) {
        fail('invalid_input', `controls.filters[${filterIndex}].value must be a non-empty array.`);
      }
      totalInValues += filter.value.length;
      if (totalInValues > definition.limits.maxTotalInValues) {
        fail('invalid_input', `Controls allow at most ${definition.limits.maxTotalInValues} total IN values.`);
      }
      const normalized = filter.value.map((item, index) => normalizeScalar(item, field, `controls.filters[${filterIndex}].value[${index}]`));
      const deduplicated = [...new Map(normalized.map(item => [stableAnalyticsJson(item), item])).values()]
        .sort((left, right) => stableAnalyticsJson(left).localeCompare(stableAnalyticsJson(right)));
      return { field: field.field, operator, value: deduplicated };
    }
    if (operator === 'between') {
      if (!Array.isArray(filter.value) || filter.value.length !== 2) {
        fail('invalid_input', `controls.filters[${filterIndex}].value must contain exactly two ordered values.`);
      }
      const normalized = filter.value.map((item, index) => normalizeScalar(item, field, `controls.filters[${filterIndex}].value[${index}]`));
      if (normalized.some(item => item === null) || !ordered(normalized[0], normalized[1])) {
        fail('invalid_input', `controls.filters[${filterIndex}] BETWEEN values are not ordered.`);
      }
      return { field: field.field, operator, value: normalized };
    }
    if (Array.isArray(filter.value)) fail('invalid_input', `controls.filters[${filterIndex}].value must be scalar for ${operator}.`);
    const normalized = normalizeScalar(filter.value, field, `controls.filters[${filterIndex}].value`);
    if (normalized === null && operator !== 'eq') fail('invalid_input', `Control ${operator} cannot compare null.`);
    return { field: field.field, operator, value: normalized };
  });
  filters.sort((left, right) => stableAnalyticsJson(left).localeCompare(stableAnalyticsJson(right)));

  let sort: AnalyticsDatasetControlValuesV1['sort'] = null;
  if (value.sort !== null) {
    const rawSort = record(value.sort, 'controls.sort');
    exactKeys(rawSort, ['field', 'direction'], 'controls.sort');
    if (typeof rawSort.field !== 'string'
      || !definition.sort.fields.some(field => field.field === rawSort.field)
      || (rawSort.direction !== 'asc' && rawSort.direction !== 'desc')) {
      fail('invalid_input', 'controls.sort must use one allowed field and asc/desc direction.');
    }
    sort = { field: rawSort.field, direction: rawSort.direction };
  }
  return { version: 1, dateRange: { start, end }, filters, sort };
}

export function buildAnalyticsControlState(input: {
  widgetId: string;
  binding: AnalyticsWidgetDataRoomBinding;
  dataset: AnalyticsDatasetDetail;
  version: AnalyticsDatasetVersionDetail;
  controlRevision: number;
  values?: unknown;
  projected: boolean;
  createdAt?: string;
  updatedAt?: string;
}): AnalyticsDatasetControlState {
  const definition = deriveAnalyticsControlDefinition(input);
  // Controls expose only filters representable by their stricter bounded UI
  // contract. Any query-valid binding filter outside that representation stays
  // fixed in the effective request, preserving pre-control query semantics.
  let editableBindingFilters: AnalyticsFilterValue[] = [];
  const fixedBindingFilters: AnalyticsFilterValue[] = [];
  for (const filter of input.binding.request.filters) {
    try {
      editableBindingFilters = normalizeAnalyticsControlValues({
        version: 1,
        dateRange: input.binding.request.dateRange,
        filters: [...editableBindingFilters, filter],
        sort: null,
      }, definition).filters;
    } catch (error) {
      if (!(error instanceof AnalyticsControlError) || error.code !== 'invalid_input') throw error;
      fixedBindingFilters.push(filter);
    }
  }
  const defaults = normalizeAnalyticsControlValues({
    version: 1,
    dateRange: input.binding.request.dateRange,
    filters: editableBindingFilters,
    sort: null,
  }, definition);
  const currentValues = input.values === undefined
    ? defaults
    : normalizeAnalyticsControlValues(input.values, definition);
  const request = normalizeAnalyticsRequest({
    ...input.binding.request,
    dateRange: currentValues.dateRange,
    // The date control owns the time range. Preserve any additional binding
    // filter on the time field as fixed request semantics rather than exposing
    // a second editable time control or silently dropping the original filter.
    filters: [...fixedBindingFilters, ...currentValues.filters],
    use: 'dashboard',
    datasetId: input.dataset.id,
    ...(input.binding.versionPolicy === 'pinned'
      ? { versionId: input.version.id }
      : { versionId: undefined }),
    resultLimit: input.binding.presentationLimit,
    unresolvedSemantics: undefined,
    ...(input.binding.expectedContractSha256
      ? { requiredContractSha256: input.binding.expectedContractSha256 }
      : {}),
  });
  const effectiveViewRequest: AnalyticsDashboardViewRequestV1 = {
    version: 1,
    request,
    sort: currentValues.sort,
  };
  return {
    widgetId: input.widgetId,
    datasetId: input.dataset.id,
    bindingRevision: input.binding.revision,
    controlRevision: input.controlRevision,
    definition,
    definitionSha256: analyticsSha256(definition),
    defaultValues: defaults,
    defaultValuesSha256: analyticsSha256(defaults),
    currentValues,
    currentValuesSha256: analyticsSha256(currentValues),
    effectiveViewRequest,
    effectiveViewRequestSha256: analyticsSha256(effectiveViewRequest),
    projected: input.projected,
    ...(input.createdAt ? { createdAt: input.createdAt } : {}),
    ...(input.updatedAt ? { updatedAt: input.updatedAt } : {}),
  };
}

export function analyticsControlRequestSha256(state: AnalyticsDatasetControlState): string {
  return analyticsRequestSha256(state.effectiveViewRequest.request);
}
