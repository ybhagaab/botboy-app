import { analyticsSha256, stableAnalyticsJson } from './analytics-data-room-policy.js';
import type {
  AnalyticsDataCell,
  AnalyticsDatasetContract,
  AnalyticsDerivedAggregateMeasureV1,
  AnalyticsDerivedDefinitionV1,
  AnalyticsDerivedDependencyV1,
  AnalyticsDerivedStepV1,
  AnalyticsFilterValue,
  AnalyticsRelationalContractV1,
} from './analytics-data-room-types.js';

export const ANALYTICS_DERIVATION_COMPILER_VERSION = 'botboy-relational-v1';
const SHA256_RE = /^[a-f0-9]{64}$/;
const DATASET_ID_RE = /^ds_[a-zA-Z0-9_-]{1,96}$/;
const VERSION_ID_RE = /^dsv_[a-f0-9]{24}$/;
const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,159}$/;
const MAX_DEPENDENCIES = 16;
const MAX_STEPS = 64;
const MAX_FIELDS = 128;
const MAX_FILTER_VALUES = 100;

export class AnalyticsDerivedContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AnalyticsDerivedContractError';
  }
}

function fail(message: string): never {
  throw new AnalyticsDerivedContractError(message);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const extras = Object.keys(value).filter(key => !allowed.includes(key)).sort();
  if (extras.length) fail(`${label} contains unsupported field(s): ${extras.join(', ')}.`);
}

function text(value: unknown, label: string, pattern: RegExp = NAME_RE): string {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) fail(`${label} is required.`);
  const output = value.trim();
  if (!pattern.test(output)) fail(`${label} is malformed.`);
  return output;
}

function boundedInteger(value: unknown, label: string, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    fail(`${label} must be an integer from ${minimum} to ${maximum}.`);
  }
  return Number(value);
}

function enumValue<T extends string | number>(value: unknown, values: readonly T[], label: string): T {
  if (!values.includes(value as T)) fail(`${label} is unsupported.`);
  return value as T;
}

function fieldNames(value: unknown, label: string, options: { allowEmpty?: boolean; sort?: boolean } = {}): string[] {
  if (!Array.isArray(value) || (!options.allowEmpty && value.length === 0) || value.length > MAX_FIELDS) {
    fail(`${label} must contain ${options.allowEmpty ? 'zero to ' : ''}${MAX_FIELDS} field names.`);
  }
  const output = value.map((item, index) => text(item, `${label}[${index}]`));
  if (new Set(output).size !== output.length) fail(`${label} contains duplicate fields.`);
  return options.sort ? [...output].sort() : output;
}

function cell(value: unknown, label: string): AnalyticsDataCell {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return fail(`${label} must be a finite scalar or null.`);
}

function filter(value: unknown, label: string): AnalyticsFilterValue {
  const input = record(value, label);
  exactKeys(input, ['field', 'operator', 'value'], label);
  const operator = enumValue(input.operator, ['eq', 'in', 'gte', 'lte', 'between'] as const, `${label}.operator`);
  const rawValues = Array.isArray(input.value) ? input.value : [input.value];
  if (operator === 'in' && (rawValues.length === 0 || rawValues.length > MAX_FILTER_VALUES)) {
    fail(`${label}.value must contain 1 to ${MAX_FILTER_VALUES} values.`);
  }
  if (operator === 'between' && rawValues.length !== 2) fail(`${label}.value must contain exactly two values.`);
  if (operator !== 'in' && operator !== 'between' && Array.isArray(input.value)) {
    fail(`${label}.value must be scalar for ${operator}.`);
  }
  const values = rawValues.map((item, index) => cell(item, `${label}.value[${index}]`));
  if (operator !== 'eq' && values.some(item => item === null)) fail(`${label} cannot compare null with ${operator}.`);
  return {
    field: text(input.field, `${label}.field`),
    operator,
    value: Array.isArray(input.value)
      ? operator === 'in'
        ? [...values].sort((left, right) => stableAnalyticsJson(left).localeCompare(stableAnalyticsJson(right)))
        : values
      : values[0],
  };
}

function aggregateMeasure(value: unknown, label: string): AnalyticsDerivedAggregateMeasureV1 {
  const input = record(value, label);
  exactKeys(input, ['operation', 'field', 'as', 'outputType', 'unit'], label);
  const operation = enumValue(
    input.operation,
    ['sum', 'count_rows', 'count_non_null', 'count_distinct', 'min', 'max'] as const,
    `${label}.operation`,
  );
  const field = input.field === undefined ? undefined : text(input.field, `${label}.field`);
  if (operation === 'count_rows' ? field !== undefined : field === undefined) {
    fail(`${label}.field ${operation === 'count_rows' ? 'must be omitted' : 'is required'} for ${operation}.`);
  }
  return {
    operation,
    ...(field ? { field } : {}),
    as: text(input.as, `${label}.as`),
    outputType: enumValue(input.outputType, ['integer', 'number'] as const, `${label}.outputType`),
    unit: text(input.unit, `${label}.unit`, /^[A-Za-z][A-Za-z0-9_/% -]{0,159}$/),
  };
}

function parseStep(value: unknown, index: number, available: Set<string>): AnalyticsDerivedStepV1 {
  const label = `derived.steps[${index}]`;
  const input = record(value, label);
  const id = text(input.id, `${label}.id`);
  if (available.has(id)) fail(`${label}.id duplicates a dependency or earlier step.`);
  const type = enumValue(
    input.type,
    ['filter', 'join', 'aggregate', 'ratio', 'pivot', 'cohort', 'project'] as const,
    `${label}.type`,
  );
  const relation = (raw: unknown, field: string): string => {
    const ref = text(raw, `${label}.${field}`);
    if (!available.has(ref)) fail(`${label}.${field} must reference a dependency or earlier step.`);
    return ref;
  };
  let output: AnalyticsDerivedStepV1;
  if (type === 'filter') {
    exactKeys(input, ['id', 'type', 'input', 'predicates'], label);
    if (!Array.isArray(input.predicates) || input.predicates.length === 0 || input.predicates.length > 20) {
      fail(`${label}.predicates must contain 1 to 20 filters.`);
    }
    output = { id, type, input: relation(input.input, 'input'), predicates: input.predicates.map((item, child) => filter(item, `${label}.predicates[${child}]`)) };
  } else if (type === 'join') {
    exactKeys(input, ['id', 'type', 'left', 'right', 'joinType', 'leftKeys', 'rightKeys', 'cardinality', 'rightFields', 'nullKeys', 'unmatched', 'maxFanout'], label);
    const leftKeys = fieldNames(input.leftKeys, `${label}.leftKeys`);
    const rightKeys = fieldNames(input.rightKeys, `${label}.rightKeys`);
    if (leftKeys.length !== rightKeys.length) fail(`${label} join key widths differ.`);
    if (!Array.isArray(input.rightFields) || input.rightFields.length === 0 || input.rightFields.length > MAX_FIELDS) {
      fail(`${label}.rightFields must contain 1 to ${MAX_FIELDS} mappings.`);
    }
    const rightFields = input.rightFields.map((item, child) => {
      const mapping = record(item, `${label}.rightFields[${child}]`);
      exactKeys(mapping, ['field', 'as'], `${label}.rightFields[${child}]`);
      return { field: text(mapping.field, `${label}.rightFields[${child}].field`), as: text(mapping.as, `${label}.rightFields[${child}].as`) };
    });
    if (new Set(rightFields.map(item => item.as)).size !== rightFields.length) fail(`${label}.rightFields repeats an output field.`);
    output = {
      id,
      type,
      left: relation(input.left, 'left'),
      right: relation(input.right, 'right'),
      joinType: enumValue(input.joinType, ['inner', 'left'] as const, `${label}.joinType`),
      leftKeys,
      rightKeys,
      cardinality: enumValue(input.cardinality, ['one_to_one', 'many_to_one', 'one_to_many'] as const, `${label}.cardinality`),
      rightFields,
      nullKeys: enumValue(input.nullKeys, ['error', 'drop'] as const, `${label}.nullKeys`),
      unmatched: enumValue(input.unmatched, ['allow', 'error'] as const, `${label}.unmatched`),
      maxFanout: boundedInteger(input.maxFanout, `${label}.maxFanout`, 1, 1000),
    };
  } else if (type === 'aggregate') {
    exactKeys(input, ['id', 'type', 'input', 'groupBy', 'measures'], label);
    if (!Array.isArray(input.measures) || input.measures.length === 0 || input.measures.length > 32) {
      fail(`${label}.measures must contain 1 to 32 measures.`);
    }
    const measures = input.measures.map((item, child) => aggregateMeasure(item, `${label}.measures[${child}]`));
    if (new Set(measures.map(item => item.as)).size !== measures.length) fail(`${label}.measures repeats an output field.`);
    output = { id, type, input: relation(input.input, 'input'), groupBy: fieldNames(input.groupBy, `${label}.groupBy`, { allowEmpty: true }), measures };
  } else if (type === 'ratio') {
    exactKeys(input, ['id', 'type', 'input', 'numerator', 'denominator', 'as', 'scale', 'zeroDenominator', 'unit'], label);
    const scale = enumValue(input.scale, [1, 100] as const, `${label}.scale`);
    const unit = enumValue(input.unit, ['ratio', 'percent'] as const, `${label}.unit`);
    if ((scale === 100) !== (unit === 'percent')) fail(`${label}.scale and unit disagree.`);
    output = {
      id,
      type,
      input: relation(input.input, 'input'),
      numerator: text(input.numerator, `${label}.numerator`),
      denominator: text(input.denominator, `${label}.denominator`),
      as: text(input.as, `${label}.as`),
      scale,
      zeroDenominator: enumValue(input.zeroDenominator, ['error', 'null'] as const, `${label}.zeroDenominator`),
      unit,
    };
  } else if (type === 'pivot') {
    exactKeys(input, ['id', 'type', 'input', 'groupBy', 'pivotField', 'values', 'measure', 'missing', 'unexpected'], label);
    if (!Array.isArray(input.values) || input.values.length === 0 || input.values.length > 32) fail(`${label}.values must contain 1 to 32 mappings.`);
    const values = input.values.map((item, child) => {
      const mapping = record(item, `${label}.values[${child}]`);
      exactKeys(mapping, ['value', 'as'], `${label}.values[${child}]`);
      return { value: cell(mapping.value, `${label}.values[${child}].value`), as: text(mapping.as, `${label}.values[${child}].as`) };
    });
    if (new Set(values.map(item => stableAnalyticsJson(item.value))).size !== values.length
      || new Set(values.map(item => item.as)).size !== values.length) fail(`${label}.values repeats a category or output field.`);
    const measure = record(input.measure, `${label}.measure`);
    exactKeys(measure, ['operation', 'field', 'outputType', 'unit'], `${label}.measure`);
    const operation = enumValue(measure.operation, ['sum', 'count_rows'] as const, `${label}.measure.operation`);
    const measureField = measure.field === undefined ? undefined : text(measure.field, `${label}.measure.field`);
    if (operation === 'sum' ? !measureField : measureField !== undefined) fail(`${label}.measure.field is inconsistent with ${operation}.`);
    output = {
      id,
      type,
      input: relation(input.input, 'input'),
      groupBy: fieldNames(input.groupBy, `${label}.groupBy`, { allowEmpty: true }),
      pivotField: text(input.pivotField, `${label}.pivotField`),
      values,
      measure: {
        operation,
        ...(measureField ? { field: measureField } : {}),
        outputType: enumValue(measure.outputType, ['integer', 'number'] as const, `${label}.measure.outputType`),
        unit: text(measure.unit, `${label}.measure.unit`, /^[A-Za-z][A-Za-z0-9_/% -]{0,159}$/),
      },
      missing: enumValue(input.missing, ['zero', 'null'] as const, `${label}.missing`),
      unexpected: enumValue(input.unexpected, ['error'] as const, `${label}.unexpected`),
    };
  } else if (type === 'cohort') {
    exactKeys(input, ['id', 'type', 'input', 'entityKey', 'eventTimeField', 'timeZone', 'bucket', 'cohortField', 'periodField', 'nulls'], label);
    output = {
      id,
      type,
      input: relation(input.input, 'input'),
      entityKey: text(input.entityKey, `${label}.entityKey`),
      eventTimeField: text(input.eventTimeField, `${label}.eventTimeField`),
      timeZone: text(input.timeZone, `${label}.timeZone`, /^[A-Za-z_][A-Za-z0-9_+\/-]{0,159}$/),
      bucket: enumValue(input.bucket, ['day', 'week', 'month'] as const, `${label}.bucket`),
      cohortField: text(input.cohortField, `${label}.cohortField`),
      periodField: text(input.periodField, `${label}.periodField`),
      nulls: enumValue(input.nulls, ['error', 'drop'] as const, `${label}.nulls`),
    };
    if (output.cohortField === output.periodField) fail(`${label} output fields must differ.`);
  } else {
    exactKeys(input, ['id', 'type', 'input', 'fields'], label);
    if (!Array.isArray(input.fields) || input.fields.length === 0 || input.fields.length > MAX_FIELDS) fail(`${label}.fields must contain 1 to ${MAX_FIELDS} mappings.`);
    const fields = input.fields.map((item, child) => {
      const mapping = record(item, `${label}.fields[${child}]`);
      exactKeys(mapping, ['field', 'as'], `${label}.fields[${child}]`);
      return {
        field: text(mapping.field, `${label}.fields[${child}].field`),
        ...(mapping.as === undefined ? {} : { as: text(mapping.as, `${label}.fields[${child}].as`) }),
      };
    });
    const outputs = fields.map(item => item.as ?? item.field);
    if (new Set(outputs).size !== outputs.length) fail(`${label}.fields repeats an output field.`);
    output = { id, type, input: relation(input.input, 'input'), fields };
  }
  available.add(id);
  return output;
}

export function parseAnalyticsDerivedDefinition(value: unknown): AnalyticsDerivedDefinitionV1 {
  const input = record(value, 'definition.derived');
  exactKeys(input, ['version', 'engine', 'dependencies', 'steps', 'output'], 'definition.derived');
  if (input.version !== 1 || input.engine !== 'botboy_relational_v1') fail('definition.derived version or engine is unsupported.');
  if (!Array.isArray(input.dependencies) || input.dependencies.length === 0 || input.dependencies.length > MAX_DEPENDENCIES) {
    fail(`definition.derived.dependencies must contain 1 to ${MAX_DEPENDENCIES} entries.`);
  }
  const dependencies: AnalyticsDerivedDependencyV1[] = input.dependencies.map((item, index) => {
    const label = `definition.derived.dependencies[${index}]`;
    const dependency = record(item, label);
    exactKeys(dependency, ['alias', 'datasetId', 'versionPolicy', 'pinnedVersionId', 'requiredColumns', 'expectedSchemaSha256', 'expectedContractSha256'], label);
    const versionPolicy = enumValue(dependency.versionPolicy, ['pinned', 'latest_compatible', 'latest_fresh'] as const, `${label}.versionPolicy`);
    const pinnedVersionId = dependency.pinnedVersionId === undefined
      ? undefined
      : text(dependency.pinnedVersionId, `${label}.pinnedVersionId`, VERSION_ID_RE);
    if ((versionPolicy === 'pinned') !== !!pinnedVersionId) fail(`${label}.pinnedVersionId is required only for pinned policy.`);
    const expectedSchemaSha256 = dependency.expectedSchemaSha256 === undefined
      ? undefined
      : text(dependency.expectedSchemaSha256, `${label}.expectedSchemaSha256`, SHA256_RE);
    const expectedContractSha256 = dependency.expectedContractSha256 === undefined
      ? undefined
      : text(dependency.expectedContractSha256, `${label}.expectedContractSha256`, SHA256_RE);
    return {
      alias: text(dependency.alias, `${label}.alias`),
      datasetId: text(dependency.datasetId, `${label}.datasetId`, DATASET_ID_RE),
      versionPolicy,
      ...(pinnedVersionId ? { pinnedVersionId } : {}),
      requiredColumns: fieldNames(dependency.requiredColumns, `${label}.requiredColumns`, { sort: true }),
      ...(expectedSchemaSha256 ? { expectedSchemaSha256 } : {}),
      ...(expectedContractSha256 ? { expectedContractSha256 } : {}),
    };
  }).sort((left, right) => left.alias.localeCompare(right.alias));
  if (new Set(dependencies.map(item => item.alias)).size !== dependencies.length) fail('definition.derived.dependencies repeats an alias.');
  if (new Set(dependencies.map(item => item.datasetId)).size !== dependencies.length) fail('definition.derived.dependencies repeats an input dataset.');
  if (!Array.isArray(input.steps) || input.steps.length === 0 || input.steps.length > MAX_STEPS) {
    fail(`definition.derived.steps must contain 1 to ${MAX_STEPS} steps.`);
  }
  const available = new Set(dependencies.map(item => item.alias));
  const steps = input.steps.map((item, index) => parseStep(item, index, available));
  const output = text(input.output, 'definition.derived.output');
  if (!available.has(output)) fail('definition.derived.output must reference a dependency or step.');
  return { version: 1, engine: 'botboy_relational_v1', dependencies, steps, output };
}

export function validateAnalyticsRelationalContract(contract: AnalyticsDatasetContract): AnalyticsRelationalContractV1 {
  const input = record(contract.relational, 'contract.relational');
  exactKeys(input, ['version', 'grainFields', 'uniqueKeys', 'measures'], 'contract.relational');
  if (input.version !== 1) fail('contract.relational.version is unsupported.');
  const schema = new Map(contract.schema.map(field => [field.name, field]));
  const grainFields = fieldNames(input.grainFields, 'contract.relational.grainFields');
  if (grainFields.some(field => !schema.has(field))) fail('contract.relational.grainFields names an absent schema field.');
  if (!Array.isArray(input.uniqueKeys) || input.uniqueKeys.length === 0 || input.uniqueKeys.length > 32) {
    fail('contract.relational.uniqueKeys must contain 1 to 32 keys.');
  }
  const uniqueKeys = input.uniqueKeys.map((key, index) => fieldNames(key, `contract.relational.uniqueKeys[${index}]`));
  if (uniqueKeys.some(key => key.some(field => !schema.has(field)))) fail('contract.relational.uniqueKeys names an absent schema field.');
  const keyIdentities = uniqueKeys.map(key => stableAnalyticsJson([...key].sort()));
  if (new Set(keyIdentities).size !== keyIdentities.length) fail('contract.relational.uniqueKeys repeats a key.');
  if (!Array.isArray(input.measures) || input.measures.length === 0 || input.measures.length > 32) {
    fail('contract.relational.measures must contain 1 to 32 measures.');
  }
  const measures = input.measures.map((item, index) => {
    const label = `contract.relational.measures[${index}]`;
    const measure = record(item, label);
    exactKeys(measure, ['field', 'unit', 'aggregation', 'protected'], label);
    const field = text(measure.field, `${label}.field`);
    const schemaField = schema.get(field);
    if (!schemaField || (schemaField.logicalType !== 'integer' && schemaField.logicalType !== 'number')) {
      fail(`${label}.field must name a numeric schema field.`);
    }
    return {
      field,
      unit: text(measure.unit, `${label}.unit`, /^[A-Za-z][A-Za-z0-9_/% -]{0,159}$/),
      aggregation: enumValue(measure.aggregation, ['none', 'sum', 'min', 'max'] as const, `${label}.aggregation`),
      protected: typeof measure.protected === 'boolean' ? measure.protected : fail(`${label}.protected must be boolean.`),
    };
  });
  if (new Set(measures.map(item => item.field)).size !== measures.length) fail('contract.relational.measures repeats a field.');
  return { version: 1, grainFields, uniqueKeys, measures };
}

/**
 * Existing approved source definitions already carry enough meaning for safe
 * composition through their exact answer recipe. Prefer an explicit R3
 * relational contract when present; otherwise derive the smallest execution
 * view without changing the source dataset or version.
 */
export function analyticsRelationalContractForExecution(
  contract: AnalyticsDatasetContract,
  answerValue?: unknown,
): AnalyticsRelationalContractV1 {
  if (contract.relational) return validateAnalyticsRelationalContract(contract);
  const answer = record(answerValue, 'dataset.definition.answer');
  exactKeys(answer, [
    'version', 'metricId', 'metricValueColumn', 'rowDimensions',
    'filterableFields', 'stableOrder',
  ], 'dataset.definition.answer');
  if (answer.version !== 1 || answer.metricId !== contract.metric.id) {
    fail('dataset.definition.answer metric identity differs from the source contract.');
  }
  const metricValueColumn = text(answer.metricValueColumn, 'dataset.definition.answer.metricValueColumn');
  const rowDimensions = fieldNames(answer.rowDimensions, 'dataset.definition.answer.rowDimensions');
  const schema = new Map(contract.schema.map(field => [field.name, field]));
  if (rowDimensions.some(field => !schema.has(field) || field === metricValueColumn)) {
    fail('dataset.definition.answer row dimensions are absent from the source schema.');
  }
  const metricField = schema.get(metricValueColumn);
  if (!metricField || (metricField.logicalType !== 'integer' && metricField.logicalType !== 'number')) {
    fail('dataset.definition.answer metric value column must be numeric.');
  }
  return {
    version: 1,
    grainFields: rowDimensions,
    uniqueKeys: [[...rowDimensions]],
    measures: [{
      field: metricValueColumn,
      unit: contract.unit,
      aggregation: 'none',
      protected: true,
    }],
  };
}

export function analyticsDerivedTransformSha256(definition: AnalyticsDerivedDefinitionV1): string {
  return analyticsSha256({ compilerVersion: ANALYTICS_DERIVATION_COMPILER_VERSION, definition });
}
