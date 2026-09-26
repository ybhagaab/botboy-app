import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import {
  ANALYTICS_DERIVATION_COMPILER_VERSION,
  analyticsDerivedTransformSha256,
  analyticsRelationalContractForExecution,
  parseAnalyticsDerivedDefinition,
  validateAnalyticsRelationalContract,
} from './analytics-data-room-derived-contract.js';
import {
  analyticsRequestSha256,
  analyticsSha256,
  enumerateAnalyticsPartitions,
  normalizeAnalyticsRequest,
  stableAnalyticsJson,
} from './analytics-data-room-policy.js';
import {
  AnalyticsDataRoomError,
  type AnalyticsDataRoomStore,
} from './analytics-data-room-store.js';
import type {
  AnalyticsDataCell,
  AnalyticsDatasetDetail,
  AnalyticsDatasetVersionDetail,
  AnalyticsDerivationPlan,
  AnalyticsDerivedAggregateMeasureV1,
  AnalyticsDerivedDefinitionV1,
  AnalyticsDerivedInputPin,
  AnalyticsDerivedMaterializationOutcome,
  AnalyticsDerivedMaterializationRequest,
  AnalyticsDerivedRunRecord,
  AnalyticsDerivedStepV1,
  AnalyticsFieldContract,
  AnalyticsFilterValue,
  AnalyticsQualityAssertionEvaluation,
  AnalyticsRelationalContractV1,
  AnalyticsRequest,
} from './analytics-data-room-types.js';

const DERIVED_RUN_ID_RE = /^dsdr_[a-f0-9]{32}$/;
const DERIVED_RUN_LEASE_MS = 10 * 60_000;
const DEFAULT_MAX_INPUT_ROWS = 100_000;
const DEFAULT_MAX_OUTPUT_ROWS = 100_000;
const DEFAULT_MAX_CELLS = 2_000_000;

type DataRow = Record<string, AnalyticsDataCell>;

interface Relation {
  fields: AnalyticsFieldContract[];
  rows: DataRow[];
  relational: AnalyticsRelationalContractV1;
}

interface DerivedRunRow {
  id: string;
  dataset_id: string;
  definition_revision: number;
  definition_sha256: string;
  expected_head_revision: number;
  request_sha256: string;
  transform_sha256: string;
  input_set_sha256: string;
  materialization_key_sha256: string;
  status: AnalyticsDerivedRunRecord['status'];
  lease_owner: string | null;
  lease_expires_at: string | null;
  heartbeat_at: string | null;
  output_version_id: string | null;
  receipt_json: string | null;
  error: string | null;
  next_action: string | null;
  queued_at: string;
  started_at: string | null;
  completed_at: string | null;
}

export interface AnalyticsDerivationService {
  resolvePlan(request: AnalyticsDerivedMaterializationRequest): AnalyticsDerivationPlan;
  beginOrJoin(request: AnalyticsDerivedMaterializationRequest): AnalyticsDerivedMaterializationOutcome;
  materialize(request: AnalyticsDerivedMaterializationRequest, options?: { signal?: AbortSignal }): Promise<AnalyticsDerivedMaterializationOutcome>;
  processNext(): Promise<number>;
  recoverExpired(): number;
  getRun(runId: string): AnalyticsDerivedRunRecord | null;
}

function fail(code: ConstructorParameters<typeof AnalyticsDataRoomError>[0], message: string): never {
  throw new AnalyticsDataRoomError(code, message);
}

function parseJson<T>(value: string, label: string): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fail('integrity_failed', `${label} contains malformed JSON.`);
  }
}

function fieldMap(relation: Relation): Map<string, AnalyticsFieldContract> {
  return new Map(relation.fields.map(field => [field.name, field]));
}

function requireField(relation: Relation, name: string, label: string): AnalyticsFieldContract {
  const field = fieldMap(relation).get(name);
  if (!field) fail('invalid_input', `${label} field ${name} is absent.`);
  return field;
}

function requireNumeric(relation: Relation, name: string, label: string): AnalyticsFieldContract {
  const field = requireField(relation, name, label);
  if (field.logicalType !== 'integer' && field.logicalType !== 'number') {
    fail('invalid_input', `${label} field ${name} must be numeric.`);
  }
  return field;
}

function compareCell(left: AnalyticsDataCell, right: AnalyticsDataCell): number {
  if (left === right) return 0;
  if (left === null) return -1;
  if (right === null) return 1;
  if (typeof left === 'number' && typeof right === 'number') return left - right;
  return String(left).localeCompare(String(right));
}

function valuesEqual(left: AnalyticsDataCell, right: AnalyticsDataCell): boolean {
  return stableAnalyticsJson(left) === stableAnalyticsJson(right);
}

function filterMatches(row: DataRow, predicate: AnalyticsFilterValue): boolean {
  const value = row[predicate.field] ?? null;
  const values = Array.isArray(predicate.value) ? predicate.value : [predicate.value];
  if (predicate.operator === 'eq') return valuesEqual(value, values[0]);
  if (predicate.operator === 'in') return values.some(candidate => valuesEqual(value, candidate));
  if (value === null || values.some(candidate => candidate === null)) return false;
  const lower = compareCell(value, values[0]);
  if (predicate.operator === 'gte') return lower >= 0;
  if (predicate.operator === 'lte') return lower <= 0;
  return lower >= 0 && compareCell(value, values[1]) <= 0;
}

function cloneRelation(relation: Relation, rows: DataRow[]): Relation {
  return {
    fields: relation.fields.map(field => ({ ...field })),
    rows,
    relational: {
      version: 1,
      grainFields: [...relation.relational.grainFields],
      uniqueKeys: relation.relational.uniqueKeys.map(key => [...key]),
      measures: relation.relational.measures.map(measure => ({ ...measure })),
    },
  };
}

function keyFor(row: DataRow, fields: string[]): string | null {
  const values = fields.map(field => row[field] ?? null);
  return values.some(value => value === null) ? null : stableAnalyticsJson(values);
}

function assertUnique(rows: DataRow[], fields: string[], label: string): void {
  const seen = new Set<string>();
  for (const row of rows) {
    const key = keyFor(row, fields);
    if (key === null) fail('integrity_failed', `${label} contains a null key.`);
    if (seen.has(key)) fail('integrity_failed', `${label} violates declared uniqueness.`);
    seen.add(key);
  }
}

function logicalBucket(day: string, bucket: 'day' | 'week' | 'month'): string {
  if (bucket === 'day') return day;
  if (bucket === 'month') return `${day.slice(0, 7)}-01`;
  const value = new Date(`${day}T00:00:00.000Z`);
  const weekday = (value.getUTCDay() + 6) % 7;
  value.setUTCDate(value.getUTCDate() - weekday);
  return value.toISOString().slice(0, 10);
}

function dayInZone(value: string, timeZone: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
  } catch {
    return fail('invalid_input', `Timezone ${timeZone} is invalid.`);
  }
  const parts = formatter.formatToParts(new Date(value));
  const read = (type: Intl.DateTimeFormatPartTypes): string => parts.find(part => part.type === type)?.value ?? '';
  const day = `${read('year')}-${read('month')}-${read('day')}`;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) fail('integrity_failed', 'Could not derive a cohort business day.');
  return day;
}

function periodOffset(cohort: string, current: string, bucket: 'day' | 'week' | 'month'): number {
  if (bucket === 'month') {
    const [cy, cm] = cohort.split('-').map(Number);
    const [vy, vm] = current.split('-').map(Number);
    return (vy - cy) * 12 + vm - cm;
  }
  const days = Math.round((Date.parse(`${current}T00:00:00.000Z`) - Date.parse(`${cohort}T00:00:00.000Z`)) / 86_400_000);
  return bucket === 'week' ? Math.floor(days / 7) : days;
}

function filterStep(input: Relation, step: Extract<AnalyticsDerivedStepV1, { type: 'filter' }>): Relation {
  for (const predicate of step.predicates) requireField(input, predicate.field, `Step ${step.id}`);
  return cloneRelation(input, input.rows.filter(row => step.predicates.every(predicate => filterMatches(row, predicate))));
}

function joinStep(
  left: Relation,
  right: Relation,
  step: Extract<AnalyticsDerivedStepV1, { type: 'join' }>,
  checks: AnalyticsQualityAssertionEvaluation[],
): Relation {
  step.leftKeys.forEach(field => requireField(left, field, `Step ${step.id} left key`));
  step.rightKeys.forEach((field, index) => {
    const rightField = requireField(right, field, `Step ${step.id} right key`);
    const leftField = requireField(left, step.leftKeys[index], `Step ${step.id} left key`);
    if (rightField.logicalType !== leftField.logicalType) fail('integrity_failed', `Step ${step.id} join key types differ.`);
  });
  if (step.cardinality === 'one_to_one' || step.cardinality === 'one_to_many') {
    assertUnique(left.rows, step.leftKeys, `Step ${step.id} left side`);
  }
  if (step.cardinality === 'one_to_one' || step.cardinality === 'many_to_one') {
    assertUnique(right.rows, step.rightKeys, `Step ${step.id} right side`);
  }
  const leftFields = new Set(left.fields.map(field => field.name));
  const rightMappings = step.rightFields.map(mapping => {
    if (leftFields.has(mapping.as)) fail('invalid_input', `Step ${step.id} output field ${mapping.as} collides with the left relation.`);
    return { ...mapping, contract: requireField(right, mapping.field, `Step ${step.id} right projection`) };
  });
  if (step.cardinality === 'one_to_many') {
    const mapped = new Set(step.rightFields.map(mapping => mapping.field));
    if (step.rightKeys.some(key => !mapped.has(key))) fail('invalid_input', `Step ${step.id} one-to-many output must retain every right key.`);
  }
  const rightIndex = new Map<string, DataRow[]>();
  for (const row of right.rows) {
    const key = keyFor(row, step.rightKeys);
    if (key === null) {
      if (step.nullKeys === 'error') fail('integrity_failed', `Step ${step.id} right relation contains null join keys.`);
      continue;
    }
    rightIndex.set(key, [...(rightIndex.get(key) ?? []), row]);
  }
  const output: DataRow[] = [];
  let unmatched = 0;
  let maximumFanout = 0;
  for (const row of left.rows) {
    const key = keyFor(row, step.leftKeys);
    if (key === null) {
      if (step.nullKeys === 'error') fail('integrity_failed', `Step ${step.id} left relation contains null join keys.`);
      continue;
    }
    const matches = rightIndex.get(key) ?? [];
    maximumFanout = Math.max(maximumFanout, matches.length);
    if (matches.length > step.maxFanout) fail('integrity_failed', `Step ${step.id} exceeds maxFanout ${step.maxFanout}.`);
    if (!matches.length) {
      unmatched += 1;
      if (step.unmatched === 'error') fail('integrity_failed', `Step ${step.id} contains unmatched left rows.`);
      if (step.joinType === 'left') {
        output.push(Object.fromEntries([
          ...Object.entries(row),
          ...rightMappings.map(mapping => [mapping.as, null]),
        ]));
      }
      continue;
    }
    for (const match of matches) {
      output.push(Object.fromEntries([
        ...Object.entries(row),
        ...rightMappings.map(mapping => [mapping.as, match[mapping.field] ?? null]),
      ]));
    }
  }
  if (step.cardinality === 'one_to_many' && maximumFanout > 1
    && left.relational.measures.some(measure => measure.protected)) {
    fail('integrity_failed', `Step ${step.id} would fan out a protected left measure.`);
  }
  checks.push({
    assertionId: `join_${step.id}_cardinality`, assertionVersion: '1', severity: 'error', success: true,
    observed: maximumFanout, expected: step.maxFanout,
  });
  if (unmatched) checks.push({
    assertionId: `join_${step.id}_unmatched`, assertionVersion: '1', severity: 'warning', success: false,
    observed: unmatched, expected: 0,
  });
  const mappedRightKey = new Map(step.rightFields.map(mapping => [mapping.field, mapping.as]));
  const grainFields = step.cardinality === 'one_to_many'
    ? [...left.relational.grainFields, ...step.rightKeys.map(key => mappedRightKey.get(key)!)].filter((value, index, values) => values.indexOf(value) === index)
    : [...left.relational.grainFields];
  return {
    fields: [
      ...left.fields.map(field => ({ ...field })),
      ...rightMappings.map(mapping => ({ ...mapping.contract, name: mapping.as, nullable: step.joinType === 'left' || mapping.contract.nullable })),
    ],
    rows: output,
    relational: {
      version: 1,
      grainFields,
      uniqueKeys: grainFields.length ? [grainFields] : [],
      measures: [
        ...left.relational.measures.map(measure => ({ ...measure })),
        ...right.relational.measures
          .filter(measure => rightMappings.some(mapping => mapping.field === measure.field))
          .map(measure => ({ ...measure, field: rightMappings.find(mapping => mapping.field === measure.field)!.as })),
      ],
    },
  };
}

function aggregateValue(rows: DataRow[], measure: AnalyticsDerivedAggregateMeasureV1): number | null {
  if (measure.operation === 'count_rows') return rows.length;
  const values = rows.map(row => row[measure.field!] ?? null).filter((value): value is number => value !== null) as number[];
  if (measure.operation === 'count_non_null') return values.length;
  if (measure.operation === 'count_distinct') return new Set(rows.map(row => stableAnalyticsJson(row[measure.field!] ?? null)).filter(value => value !== 'null')).size;
  if (!values.length) return null;
  if (values.some(value => typeof value !== 'number' || !Number.isFinite(value))) fail('integrity_failed', `Aggregate ${measure.as} received a non-numeric value.`);
  if (measure.operation === 'sum') return values.reduce((sum, value) => sum + value, 0);
  if (measure.operation === 'min') return Math.min(...values);
  return Math.max(...values);
}

function aggregateStep(input: Relation, step: Extract<AnalyticsDerivedStepV1, { type: 'aggregate' }>): Relation {
  const inputFields = fieldMap(input);
  step.groupBy.forEach(field => requireField(input, field, `Step ${step.id} group`));
  for (const measure of step.measures) {
    if (measure.field) {
      const field = requireField(input, measure.field, `Step ${step.id} measure`);
      if (measure.operation === 'sum' || measure.operation === 'min' || measure.operation === 'max') {
        requireNumeric(input, measure.field, `Step ${step.id} measure`);
      }
      const sourceMeasure = input.relational.measures.find(value => value.field === measure.field);
      if (sourceMeasure && sourceMeasure.unit !== measure.unit && !measure.operation.startsWith('count_')) {
        fail('integrity_failed', `Step ${step.id} changes measure unit without a ratio.`);
      }
      void field;
    }
    if ((measure.operation === 'count_rows' || measure.operation === 'count_non_null' || measure.operation === 'count_distinct')
      && measure.outputType !== 'integer') fail('invalid_input', `Step ${step.id} count measure must output integer.`);
  }
  const groups = new Map<string, { values: AnalyticsDataCell[]; rows: DataRow[] }>();
  for (const row of input.rows) {
    const values = step.groupBy.map(field => row[field] ?? null);
    const key = stableAnalyticsJson(values);
    const group = groups.get(key) ?? { values, rows: [] };
    group.rows.push(row);
    groups.set(key, group);
  }
  if (!input.rows.length && step.groupBy.length === 0) groups.set('[]', { values: [], rows: [] });
  const rows = [...groups.values()].map(group => Object.fromEntries([
    ...step.groupBy.map((field, index) => [field, group.values[index]]),
    ...step.measures.map(measure => [measure.as, aggregateValue(group.rows, measure)]),
  ]));
  const fields: AnalyticsFieldContract[] = [
    ...step.groupBy.map(field => ({ ...inputFields.get(field)! })),
    ...step.measures.map(measure => ({
      name: measure.as,
      logicalType: measure.outputType,
      physicalType: measure.outputType === 'integer' ? 'INTEGER' : 'REAL',
      nullable: measure.operation.startsWith('count_')
        ? false
        : inputFields.get(measure.field!)!.nullable,
    } as AnalyticsFieldContract)),
  ];
  return {
    fields,
    rows,
    relational: {
      version: 1,
      grainFields: [...step.groupBy],
      uniqueKeys: step.groupBy.length ? [[...step.groupBy]] : [],
      measures: step.measures.map(measure => ({
        field: measure.as,
        unit: measure.unit,
        aggregation: measure.operation === 'sum' ? 'sum' : measure.operation === 'min' ? 'min' : measure.operation === 'max' ? 'max' : 'none',
        protected: true,
      })),
    },
  };
}

function ratioStep(input: Relation, step: Extract<AnalyticsDerivedStepV1, { type: 'ratio' }>): Relation {
  requireNumeric(input, step.numerator, `Step ${step.id} numerator`);
  requireNumeric(input, step.denominator, `Step ${step.id} denominator`);
  if (fieldMap(input).has(step.as)) fail('invalid_input', `Step ${step.id} output field already exists.`);
  const rows = input.rows.map(row => {
    const numerator = row[step.numerator];
    const denominator = row[step.denominator];
    if (typeof numerator !== 'number' || typeof denominator !== 'number') fail('integrity_failed', `Step ${step.id} ratio inputs must be non-null numbers.`);
    if (denominator === 0) {
      if (step.zeroDenominator === 'error') fail('integrity_failed', `Step ${step.id} denominator is zero.`);
      return { ...row, [step.as]: null };
    }
    return { ...row, [step.as]: (numerator / denominator) * step.scale };
  });
  return {
    fields: [...input.fields.map(field => ({ ...field })), { name: step.as, logicalType: 'number', physicalType: 'REAL', nullable: step.zeroDenominator === 'null' }],
    rows,
    relational: {
      ...input.relational,
      grainFields: [...input.relational.grainFields],
      uniqueKeys: input.relational.uniqueKeys.map(key => [...key]),
      measures: [...input.relational.measures.map(measure => ({ ...measure })), { field: step.as, unit: step.unit, aggregation: 'none', protected: true }],
    },
  };
}

function pivotStep(input: Relation, step: Extract<AnalyticsDerivedStepV1, { type: 'pivot' }>): Relation {
  step.groupBy.forEach(field => requireField(input, field, `Step ${step.id} group`));
  requireField(input, step.pivotField, `Step ${step.id} pivot`);
  if (step.measure.operation === 'sum') requireNumeric(input, step.measure.field!, `Step ${step.id} measure`);
  const categoryMap = new Map(step.values.map(value => [stableAnalyticsJson(value.value), value.as]));
  const groups = new Map<string, { values: AnalyticsDataCell[]; accumulators: Map<string, number> }>();
  for (const row of input.rows) {
    const category = categoryMap.get(stableAnalyticsJson(row[step.pivotField] ?? null));
    if (!category) fail('integrity_failed', `Step ${step.id} encountered an unexpected pivot category.`);
    const values = step.groupBy.map(field => row[field] ?? null);
    const key = stableAnalyticsJson(values);
    const group = groups.get(key) ?? { values, accumulators: new Map() };
    const increment = step.measure.operation === 'count_rows' ? 1 : row[step.measure.field!] ?? null;
    if (typeof increment !== 'number' || !Number.isFinite(increment)) fail('integrity_failed', `Step ${step.id} pivot measure is not numeric.`);
    group.accumulators.set(category, (group.accumulators.get(category) ?? 0) + increment);
    groups.set(key, group);
  }
  const rows = [...groups.values()].map(group => Object.fromEntries([
    ...step.groupBy.map((field, index) => [field, group.values[index]]),
    ...step.values.map(value => [value.as, group.accumulators.has(value.as) ? group.accumulators.get(value.as)! : step.missing === 'zero' ? 0 : null]),
  ]));
  const baseFields = fieldMap(input);
  return {
    fields: [
      ...step.groupBy.map(field => ({ ...baseFields.get(field)! })),
      ...step.values.map(value => ({
        name: value.as,
        logicalType: step.measure.outputType,
        physicalType: step.measure.outputType === 'integer' ? 'INTEGER' : 'REAL',
        nullable: step.missing === 'null',
      } as AnalyticsFieldContract)),
    ],
    rows,
    relational: {
      version: 1,
      grainFields: [...step.groupBy],
      uniqueKeys: step.groupBy.length ? [[...step.groupBy]] : [],
      measures: step.values.map(value => ({ field: value.as, unit: step.measure.unit, aggregation: 'sum', protected: true })),
    },
  };
}

function cohortStep(input: Relation, step: Extract<AnalyticsDerivedStepV1, { type: 'cohort' }>): Relation {
  requireField(input, step.entityKey, `Step ${step.id} entity`);
  const timeField = requireField(input, step.eventTimeField, `Step ${step.id} time`);
  if (timeField.logicalType !== 'date' && timeField.logicalType !== 'timestamp') fail('invalid_input', `Step ${step.id} time field must be date or timestamp.`);
  const first = new Map<string, string>();
  const prepared: Array<{ row: DataRow; entity: string; bucket: string }> = [];
  for (const row of input.rows) {
    const entityValue = row[step.entityKey];
    const timeValue = row[step.eventTimeField];
    if (entityValue === null || typeof timeValue !== 'string') {
      if (step.nulls === 'error') fail('integrity_failed', `Step ${step.id} contains a null cohort key/time.`);
      continue;
    }
    const entity = stableAnalyticsJson(entityValue);
    const bucket = logicalBucket(dayInZone(timeValue, step.timeZone), step.bucket);
    const prior = first.get(entity);
    if (!prior || bucket < prior) first.set(entity, bucket);
    prepared.push({ row, entity, bucket });
  }
  const rows = prepared.map(value => ({
    ...value.row,
    [step.cohortField]: first.get(value.entity)!,
    [step.periodField]: periodOffset(first.get(value.entity)!, value.bucket, step.bucket),
  }));
  return {
    fields: [
      ...input.fields.map(field => ({ ...field })),
      { name: step.cohortField, logicalType: 'date', physicalType: 'DATE', nullable: false },
      { name: step.periodField, logicalType: 'integer', physicalType: 'INTEGER', nullable: false },
    ],
    rows,
    relational: {
      ...input.relational,
      grainFields: [...input.relational.grainFields, step.cohortField, step.periodField]
        .filter((value, index, values) => values.indexOf(value) === index),
      uniqueKeys: input.relational.uniqueKeys.map(key => [...key]),
      measures: input.relational.measures.map(measure => ({ ...measure })),
    },
  };
}

function projectStep(input: Relation, step: Extract<AnalyticsDerivedStepV1, { type: 'project' }>): Relation {
  const inputs = fieldMap(input);
  const mapping = new Map(step.fields.map(value => [value.field, value.as ?? value.field]));
  const fields = step.fields.map(value => ({ ...requireField(input, value.field, `Step ${step.id} project`), name: value.as ?? value.field }));
  const rows = input.rows.map(row => Object.fromEntries(step.fields.map(value => [value.as ?? value.field, row[value.field] ?? null])));
  const remap = (name: string): string | null => mapping.get(name) ?? null;
  return {
    fields,
    rows,
    relational: {
      version: 1,
      grainFields: input.relational.grainFields.map(remap).filter((value): value is string => !!value),
      uniqueKeys: input.relational.uniqueKeys
        .map(key => key.map(remap))
        .filter(key => key.every((value): value is string => !!value)) as string[][],
      measures: input.relational.measures
        .filter(measure => mapping.has(measure.field))
        .map(measure => ({ ...measure, field: mapping.get(measure.field)! })),
    },
  };
}

function executeSteps(
  definition: AnalyticsDerivedDefinitionV1,
  inputs: Map<string, Relation>,
  target: AnalyticsDatasetDetail,
  limits: { maxInputRows: number; maxOutputRows: number; maxCells: number },
): { columns: string[]; rows: AnalyticsDataCell[][]; checks: AnalyticsQualityAssertionEvaluation[] } {
  const relations = new Map(inputs);
  const checks: AnalyticsQualityAssertionEvaluation[] = [];
  let totalCells = [...inputs.values()].reduce((sum, relation) => sum + relation.rows.length * relation.fields.length, 0);
  if ([...inputs.values()].some(relation => relation.rows.length > limits.maxInputRows) || totalCells > limits.maxCells) {
    fail('query_unsupported', 'Derived input exceeds the bounded local materialization budget.');
  }
  for (const step of definition.steps) {
    let output: Relation;
    if (step.type === 'filter') output = filterStep(relations.get(step.input)!, step);
    else if (step.type === 'join') output = joinStep(relations.get(step.left)!, relations.get(step.right)!, step, checks);
    else if (step.type === 'aggregate') output = aggregateStep(relations.get(step.input)!, step);
    else if (step.type === 'ratio') output = ratioStep(relations.get(step.input)!, step);
    else if (step.type === 'pivot') output = pivotStep(relations.get(step.input)!, step);
    else if (step.type === 'cohort') output = cohortStep(relations.get(step.input)!, step);
    else output = projectStep(relations.get(step.input)!, step);
    if (output.rows.length > limits.maxOutputRows) fail('query_unsupported', `Step ${step.id} exceeds the output row budget.`);
    totalCells += output.rows.length * output.fields.length;
    if (totalCells > limits.maxCells) fail('query_unsupported', `Step ${step.id} exceeds the materialization cell budget.`);
    relations.set(step.id, output);
  }
  const output = relations.get(definition.output);
  if (!output) fail('integrity_failed', 'Derived output relation disappeared.');
  const expectedFields = target.contract.schema.map(field => ({ ...field, physicalType: undefined }));
  const actualFields = output.fields.map(field => ({ ...field, physicalType: undefined }));
  if (stableAnalyticsJson(actualFields) !== stableAnalyticsJson(expectedFields)) {
    fail('integrity_failed', 'Derived output schema differs from the declared target schema.');
  }
  const targetRelational = validateAnalyticsRelationalContract(target.contract);
  if (stableAnalyticsJson(output.relational.grainFields) !== stableAnalyticsJson(targetRelational.grainFields)) {
    fail('integrity_failed', 'Derived output grain differs from the declared target grain fields.');
  }
  assertUnique(output.rows, targetRelational.grainFields, 'Derived output grain');
  const columns = target.contract.schema.map(field => field.name);
  const rows = output.rows
    .map(row => columns.map(column => row[column] ?? null))
    .sort((left, right) => stableAnalyticsJson(left).localeCompare(stableAnalyticsJson(right)));
  checks.push({
    assertionId: 'derived_output_schema', assertionVersion: '1', severity: 'error', success: true,
    observed: rows.length, expected: rows.length,
  });
  checks.push({
    assertionId: 'derived_unique_grain', assertionVersion: '1', severity: 'error', success: true,
    observed: rows.length, expected: rows.length,
  });
  return { columns, rows, checks };
}

function readRelation(
  store: AnalyticsDataRoomStore,
  pin: AnalyticsDerivedInputPin,
  maxInputRows: number,
): Relation {
  const version = store.getDatasetVersion(pin.versionId);
  if (!version || version.datasetId !== pin.datasetId) fail('not_found', `Pinned input version ${pin.versionId} was not found.`);
  const currentDataset = store.getDataset(pin.datasetId);
  const approvedAnswer = !version.contract.relational
    && currentDataset?.definitionSha256 === version.definitionSha256
    && currentDataset.contractSha256 === version.contractSha256
    ? currentDataset.definition.answer
    : undefined;
  const relational = analyticsRelationalContractForExecution(version.contract, approvedAnswer);
  const inferredFromAnswer = !version.contract.relational;
  const filePath = store.getVerifiedMaterializedPath(pin.versionId, 'dashboard');
  const db = new Database(filePath, { readonly: true, fileMustExist: true });
  try {
    db.pragma('query_only = ON');
    const count = Number((db.prepare('SELECT COUNT(*) AS count FROM data').get() as { count: number }).count);
    if (count > maxInputRows) fail('query_unsupported', `Input ${pin.alias} exceeds ${maxInputRows} rows.`);
    const raw = db.prepare('SELECT * FROM data').all() as Array<Record<string, AnalyticsDataCell>>;
    const rows = raw.map(row => Object.fromEntries(version.contract.schema.map(field => {
      const value = row[field.name] ?? null;
      return [field.name, field.logicalType === 'boolean' && value !== null ? value === 1 : value];
    })));
    if (inferredFromAnswer) {
      for (const key of relational.uniqueKeys) {
        const identities = new Set<string>();
        for (const [rowIndex, row] of rows.entries()) {
          const values = key.map(field => row[field] ?? null);
          if (values.some(value => value === null)) {
            fail('integrity_failed', `Input ${pin.alias} row ${rowIndex} has a null approved answer key.`);
          }
          const identity = stableAnalyticsJson(values);
          if (identities.has(identity)) {
            fail('integrity_failed', `Input ${pin.alias} approved answer key is not unique.`);
          }
          identities.add(identity);
        }
      }
    }
    return { fields: version.contract.schema.map(field => ({ ...field })), rows, relational };
  } finally {
    db.close();
  }
}

function runRecord(row: DerivedRunRow): AnalyticsDerivedRunRecord {
  return {
    id: row.id,
    datasetId: row.dataset_id,
    definitionRevision: Number(row.definition_revision),
    definitionSha256: row.definition_sha256,
    expectedHeadRevision: Number(row.expected_head_revision),
    requestSha256: row.request_sha256,
    transformSha256: row.transform_sha256,
    inputSetSha256: row.input_set_sha256,
    materializationKeySha256: row.materialization_key_sha256,
    status: row.status,
    ...(row.output_version_id ? { outputVersionId: row.output_version_id } : {}),
    ...(row.receipt_json ? { receipt: parseJson<Record<string, unknown>>(row.receipt_json, 'derived run receipt') } : {}),
    ...(row.error ? { error: row.error } : {}),
    ...(row.next_action ? { nextAction: row.next_action } : {}),
    queuedAt: row.queued_at,
    ...(row.started_at ? { startedAt: row.started_at } : {}),
    ...(row.completed_at ? { completedAt: row.completed_at } : {}),
  };
}

export function createAnalyticsDerivationService(input: {
  db: Database.Database;
  store: AnalyticsDataRoomStore;
  now?: () => Date;
  createId?: () => string;
  maxInputRows?: number;
  maxOutputRows?: number;
  maxCells?: number;
  /** Isolated test hook for proving overlap; production leaves this unset. */
  beforeExecute?: (runId: string, pins: AnalyticsDerivedInputPin[]) => Promise<void> | void;
}): AnalyticsDerivationService {
  const db = input.db;
  const store = input.store;
  const now = input.now ?? (() => new Date());
  const createId = input.createId ?? (() => randomUUID().replace(/-/g, ''));
  const maxInputRows = input.maxInputRows ?? DEFAULT_MAX_INPUT_ROWS;
  const maxOutputRows = input.maxOutputRows ?? DEFAULT_MAX_OUTPUT_ROWS;
  const maxCells = input.maxCells ?? DEFAULT_MAX_CELLS;
  const workerId = `derived:${process.pid}:${createId().slice(0, 12)}`;
  const inFlight = new Map<string, Promise<AnalyticsDerivedMaterializationOutcome>>();

  if (![maxInputRows, maxOutputRows, maxCells].every(value => Number.isInteger(value) && value > 0)) {
    fail('invalid_input', 'Derived materialization limits must be positive integers.');
  }

  function timestamp(): string {
    return now().toISOString();
  }

  function getRunRow(runId: string): DerivedRunRow | null {
    if (!DERIVED_RUN_ID_RE.test(runId)) fail('invalid_input', 'Derived run ID is malformed.');
    return (db.prepare('SELECT * FROM analytics_derived_runs WHERE id = ?').get(runId) as DerivedRunRow | undefined) ?? null;
  }

  function getRun(runId: string): AnalyticsDerivedRunRecord | null {
    const row = getRunRow(runId);
    return row ? runRecord(row) : null;
  }

  function pinsForRun(runId: string): AnalyticsDerivedInputPin[] {
    return (db.prepare(`
      SELECT alias, input_dataset_id, input_version_id, content_sha256,
        schema_sha256, contract_sha256, definition_sha256
      FROM analytics_derived_run_inputs WHERE run_id = ? ORDER BY position, alias
    `).all(runId) as Array<{
      alias: string;
      input_dataset_id: string;
      input_version_id: string;
      content_sha256: string;
      schema_sha256: string;
      contract_sha256: string;
      definition_sha256: string;
    }>).map(value => ({
      alias: value.alias,
      datasetId: value.input_dataset_id,
      versionId: value.input_version_id,
      contentSha256: value.content_sha256,
      schemaSha256: value.schema_sha256,
      contractSha256: value.contract_sha256,
      definitionSha256: value.definition_sha256,
    }));
  }

  function resolvePins(dataset: AnalyticsDatasetDetail, definition: AnalyticsDerivedDefinitionV1, request: AnalyticsRequest): AnalyticsDerivedInputPin[] {
    const requestedPartitions = new Set(enumerateAnalyticsPartitions(request.dateRange.start, request.dateRange.end));
    const pins = definition.dependencies.map(dependency => {
      const inputDataset = store.getDataset(dependency.datasetId);
      if (!inputDataset || inputDataset.lifecycle !== 'active') fail('not_found', `Input dataset ${dependency.datasetId} is missing or inactive.`);
      if (dependency.versionPolicy !== 'pinned'
        && inputDataset.kind === 'derived'
        && store.isDerivedDatasetDirty(inputDataset.id)) {
        fail('conflict', `Input derived dataset ${dependency.datasetId} is dirty; materialize that ancestor before this descendant.`);
      }
      const versionId = dependency.versionPolicy === 'pinned'
        ? dependency.pinnedVersionId!
        : inputDataset.head?.versionId;
      if (!versionId) fail('not_found', `Input dataset ${dependency.datasetId} has no verified head.`);
      const version = store.getDatasetVersion(versionId);
      if (!version || version.datasetId !== dependency.datasetId) fail('not_found', `Input version ${versionId} is unavailable.`);
      store.verifyVersion(version.id, request.use);
      if (dependency.expectedSchemaSha256 && dependency.expectedSchemaSha256 !== version.observedSchemaSha256) {
        fail('integrity_failed', `Input ${dependency.alias} schema changed.`);
      }
      if (dependency.expectedContractSha256 && dependency.expectedContractSha256 !== version.contractSha256) {
        fail('integrity_failed', `Input ${dependency.alias} contract changed.`);
      }
      const fields = new Set(version.contract.schema.map(field => field.name));
      if (dependency.requiredColumns.some(field => !fields.has(field))) fail('integrity_failed', `Input ${dependency.alias} lost a required column.`);
      if ([...requestedPartitions].some(partition => !version.coverage.completePartitions.includes(partition))) {
        fail('integrity_failed', `Input ${dependency.alias} lacks requested complete coverage.`);
      }
      if (dependency.versionPolicy === 'latest_fresh' && request.freshness.mode === 'fresh_by') {
        const materializedAt = Date.parse(version.materializedAt);
        const watermark = Date.parse(version.coverage.watermark);
        if (!Number.isFinite(materializedAt) || !Number.isFinite(watermark)
          || now().getTime() - materializedAt > request.freshness.maxAgeMs
          || now().getTime() - watermark > request.freshness.maxAgeMs) {
          fail('integrity_failed', `Input ${dependency.alias} is not fresh enough.`);
        }
      }
      return {
        alias: dependency.alias,
        datasetId: dependency.datasetId,
        versionId: version.id,
        contentSha256: version.materializedSha256,
        schemaSha256: version.observedSchemaSha256,
        contractSha256: version.contractSha256,
        definitionSha256: version.definitionSha256,
      };
    });
    return pins.sort((left, right) => left.alias.localeCompare(right.alias));
  }

  function resolvePlan(value: AnalyticsDerivedMaterializationRequest): AnalyticsDerivationPlan {
    const request = normalizeAnalyticsRequest(value.request);
    if (!value.consumer || !['answer', 'dashboard_widget'].includes(value.consumer.kind)
      || typeof value.consumer.id !== 'string' || !value.consumer.id.trim() || value.consumer.id.includes('\0')) {
      fail('invalid_input', 'Derived consumer context is malformed.');
    }
    const dataset = store.getDataset(value.datasetId);
    if (!dataset || dataset.kind !== 'derived' || dataset.lifecycle !== 'active' || dataset.contract.status !== 'active') {
      fail('not_found', `Derived dataset ${value.datasetId} is missing or inactive.`);
    }
    if (dataset.scope !== 'workspace' && value.consumer.kind === 'answer') {
      fail('policy_denied', 'Direct answers may not widen a non-workspace derived dataset scope.');
    }
    const definition = parseAnalyticsDerivedDefinition(dataset.definition.derived);
    const transformSha256 = analyticsDerivedTransformSha256(definition);
    const pins = resolvePins(dataset, definition, request);
    const inputSetSha256 = analyticsSha256(pins);
    const materializationKeySha256 = analyticsSha256({
      datasetId: dataset.id,
      definitionRevision: dataset.definitionRevision,
      definitionSha256: dataset.definitionSha256,
      contractSha256: dataset.contractSha256,
      compilerVersion: ANALYTICS_DERIVATION_COMPILER_VERSION,
      transformSha256,
      inputSetSha256,
    });
    if (value.expectedMaterializationKeySha256
      && value.expectedMaterializationKeySha256 !== materializationKeySha256) {
      fail('conflict', 'Derived input heads changed after source resolution; retry the same request against the new exact vector.');
    }
    return {
      dataset,
      definition,
      inputs: pins,
      transformSha256,
      inputSetSha256,
      materializationKeySha256,
      expectedHeadRevision: dataset.head?.headRevision ?? 0,
      requestSha256: analyticsRequestSha256(request),
    };
  }

  function existingOutcome(plan: AnalyticsDerivationPlan): AnalyticsDerivedMaterializationOutcome | null {
    const row = db.prepare(`
      SELECT * FROM analytics_derived_runs WHERE materialization_key_sha256 = ?
    `).get(plan.materializationKeySha256) as DerivedRunRow | undefined;
    if (!row) return null;
    const run = runRecord(row);
    if (row.status === 'completed' && row.output_version_id) {
      const version = store.getDatasetVersion(row.output_version_id);
      if (!version) return fail('integrity_failed', 'Completed derived run lost its output version.');
      store.verifyVersion(version.id);
      return { state: 'ready', run, version, joinedExisting: true };
    }
    if (row.status === 'failed') {
      return {
        state: 'blocked',
        code: 'integrity_failed',
        error: row.error || 'Derived materialization failed.',
        nextAction: row.next_action || 'Revise the definition or inputs before retrying.',
      };
    }
    return { state: 'pending', run, joinedExisting: true, nextAction: 'Wait for the canonical derived run; do not start another transform.' };
  }

  function beginOrJoin(value: AnalyticsDerivedMaterializationRequest): AnalyticsDerivedMaterializationOutcome {
    let plan: AnalyticsDerivationPlan;
    try {
      plan = resolvePlan(value);
    } catch (error) {
      return {
        state: 'blocked',
        code: error instanceof AnalyticsDataRoomError ? error.code : 'invalid_input',
        error: error instanceof Error ? error.message : String(error),
        nextAction: 'Fix the exact derived definition or input eligibility before retrying.',
      };
    }
    const prior = existingOutcome(plan);
    if (prior) return prior;
    const at = timestamp();
    const id = `dsdr_${createId().slice(0, 32)}`;
    if (!DERIVED_RUN_ID_RE.test(id)) fail('invalid_input', 'Generated derived run ID is malformed.');
    try {
      db.transaction(() => {
        for (const pin of plan.inputs) {
          const dependency = plan.definition.dependencies.find(item => item.alias === pin.alias)!;
          if (dependency.versionPolicy !== 'pinned') {
            const current = store.getHead(pin.datasetId);
            if (!current || current.versionId !== pin.versionId) fail('conflict', `Input ${pin.alias} head changed before pin commit.`);
          }
        }
        db.prepare(`
          INSERT INTO analytics_derived_runs
            (id, dataset_id, definition_revision, definition_sha256, expected_head_revision,
             request_sha256, transform_sha256, input_set_sha256, materialization_key_sha256,
             status, queued_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?)
        `).run(
          id, plan.dataset.id, plan.dataset.definitionRevision, plan.dataset.definitionSha256,
          plan.expectedHeadRevision, plan.requestSha256, plan.transformSha256,
          plan.inputSetSha256, plan.materializationKeySha256, at,
        );
        const insert = db.prepare(`
          INSERT INTO analytics_derived_run_inputs
            (run_id, alias, position, input_dataset_id, input_version_id,
             content_sha256, schema_sha256, contract_sha256, definition_sha256)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        plan.inputs.forEach((pin, position) => insert.run(
          id, pin.alias, position, pin.datasetId, pin.versionId, pin.contentSha256,
          pin.schemaSha256, pin.contractSha256, pin.definitionSha256,
        ));
      })();
    } catch (error) {
      const winner = existingOutcome(plan);
      if (winner) return winner;
      const active = db.prepare(`
        SELECT * FROM analytics_derived_runs
        WHERE dataset_id = ? AND status IN ('queued','running') ORDER BY queued_at, id LIMIT 1
      `).get(plan.dataset.id) as DerivedRunRow | undefined;
      if (active) return {
        state: 'pending', run: runRecord(active), joinedExisting: true,
        nextAction: 'A prior input vector for this derived dataset is still active; wait, then materialize the current dirty vector.',
      };
      throw error;
    }
    return {
      state: 'pending',
      run: getRun(id)!,
      joinedExisting: false,
      nextAction: 'The canonical derived run is queued in the independent data-room slot.',
    };
  }

  function failRun(runId: string, error: unknown): AnalyticsDerivedMaterializationOutcome {
    const message = error instanceof Error ? error.message : String(error);
    const transient = error instanceof AnalyticsDataRoomError && error.code === 'conflict';
    const nextAction = transient
      ? 'Retry after the current catalog/head operation completes; exact pins remain unchanged.'
      : 'Revise the deterministic definition or input contracts before retrying.';
    const at = timestamp();
    db.transaction(() => {
      if (transient) {
        db.prepare(`
          UPDATE analytics_derived_runs
          SET status = 'queued', error = ?, next_action = ?, lease_owner = NULL,
              lease_expires_at = NULL, heartbeat_at = ?, completed_at = NULL
          WHERE id = ? AND status = 'running'
        `).run(message.slice(0, 2000), nextAction, at, runId);
        return;
      }
      const changed = db.prepare(`
        UPDATE analytics_derived_runs
        SET status = 'failed', error = ?, next_action = ?, lease_owner = NULL,
            lease_expires_at = NULL, heartbeat_at = ?, completed_at = ?
        WHERE id = ? AND status = 'running'
      `).run(message.slice(0, 2000), nextAction, at, at, runId);
      if (changed.changes === 1) {
        db.prepare(`
          INSERT OR IGNORE INTO analytics_derived_run_assertions
            (id, run_id, assertion_id, assertion_version, severity, success,
             observed_json, expected_json, created_at)
          VALUES (?, ?, 'derived_run_failure', '1', 'error', 0, ?, ?, ?)
        `).run(
          `dsra_${analyticsSha256({ runId, assertionId: 'derived_run_failure' }).slice(0, 24)}`,
          runId,
          stableAnalyticsJson(message.slice(0, 1000)),
          stableAnalyticsJson('successful deterministic materialization'),
          at,
        );
        db.prepare(`
          UPDATE analytics_derived_dirty
          SET status = 'blocked', error = ?
          WHERE dataset_id = (SELECT dataset_id FROM analytics_derived_runs WHERE id = ?)
            AND (SELECT definition_revision FROM analytics_datasets WHERE id = analytics_derived_dirty.dataset_id)
              = (SELECT definition_revision FROM analytics_derived_runs WHERE id = ?)
        `).run(message.slice(0, 2000), runId, runId);
      }
    })();
    return {
      state: 'blocked',
      code: error instanceof AnalyticsDataRoomError ? error.code : 'integrity_failed',
      error: message,
      nextAction,
    };
  }

  function currentInputSetMatches(runId: string, dataset: AnalyticsDatasetDetail, definition: AnalyticsDerivedDefinitionV1): boolean {
    try {
      const request: AnalyticsRequest = {
        domainKey: dataset.domainKey,
        metric: dataset.contract.metric,
        dimensions: dataset.definition.answer?.rowDimensions ?? dataset.contract.availableDimensions,
        filters: [],
        dateRange: {
          start: dataset.contract.coverage.completePartitions[0],
          end: dataset.contract.coverage.completePartitions.at(-1)!,
        },
        timeZone: dataset.contract.timeZone,
        countingKey: dataset.contract.countingKey,
        regime: dataset.contract.regime,
        requiredGrain: dataset.contract.grain,
        freshness: { mode: 'allow_stale' },
        use: 'dashboard',
      };
      const current = resolvePins(dataset, definition, request);
      return analyticsSha256(current) === getRun(runId)!.inputSetSha256;
    } catch {
      return false;
    }
  }

  async function executeRun(runId: string, signal?: AbortSignal): Promise<AnalyticsDerivedMaterializationOutcome> {
    const throwIfAborted = (): void => {
      if (signal?.aborted) fail('query_cancelled', 'Derived materialization was locally interrupted before completion.');
    };
    throwIfAborted();
    const leaseExpiresAt = new Date(now().getTime() + DERIVED_RUN_LEASE_MS).toISOString();
    const startedAt = timestamp();
    const claimed = db.prepare(`
      UPDATE analytics_derived_runs
      SET status = 'running', lease_owner = ?, lease_expires_at = ?, heartbeat_at = ?,
          error = NULL, next_action = NULL, started_at = COALESCE(started_at, ?)
      WHERE id = ? AND status = 'queued'
    `).run(workerId, leaseExpiresAt, startedAt, startedAt, runId);
    if (claimed.changes !== 1) {
      const row = getRunRow(runId);
      if (!row) return { state: 'blocked', code: 'not_found', error: 'Derived run disappeared.', nextAction: 'Resolve the target dataset again.' };
      return existingOutcome({ materializationKeySha256: row.materialization_key_sha256 } as AnalyticsDerivationPlan)!;
    }
    try {
      const row = getRunRow(runId)!;
      const dataset = store.getDataset(row.dataset_id);
      if (!dataset || dataset.definitionRevision !== row.definition_revision || dataset.definitionSha256 !== row.definition_sha256) {
        fail('definition_changed', 'Derived definition changed before execution; frozen work was not published.');
      }
      const definition = parseAnalyticsDerivedDefinition(dataset.definition.derived);
      const pins = pinsForRun(runId);
      if (analyticsSha256(pins) !== row.input_set_sha256) fail('integrity_failed', 'Persisted derived input set differs from its SHA.');
      const currentHead = store.getHead(dataset.id);
      const currentHeadRevision = currentHead?.headRevision ?? 0;
      if (currentHeadRevision !== row.expected_head_revision) {
        const currentVersion = currentHead ? store.getDatasetVersion(currentHead.versionId) : null;
        if (!currentVersion?.derivation
          || currentVersion.derivation.inputSetSha256 !== row.input_set_sha256
          || currentVersion.derivation.transformSha256 !== row.transform_sha256) {
          fail('integrity_failed', 'Derived run was superseded by a newer output input vector before promotion.');
        }
        db.prepare(`
          UPDATE analytics_derived_runs SET expected_head_revision = ?, heartbeat_at = ?
          WHERE id = ? AND status = 'running'
        `).run(currentHeadRevision, timestamp(), runId);
        row.expected_head_revision = currentHeadRevision;
      }
      await input.beforeExecute?.(runId, pins);
      throwIfAborted();
      const relations = new Map<string, Relation>();
      for (const pin of pins) {
        throwIfAborted();
        relations.set(pin.alias, readRelation(store, pin, maxInputRows));
      }
      throwIfAborted();
      const output = executeSteps(definition, relations, dataset, { maxInputRows, maxOutputRows, maxCells });
      throwIfAborted();
      const sourceBytes = Buffer.from(`${stableAnalyticsJson({ columns: output.columns, rows: output.rows })}\n`, 'utf8');
      const materializedAt = timestamp();
      throwIfAborted();
      const promotion = store.publishParsedSource({
        datasetId: dataset.id,
        expectedHeadRevision: row.expected_head_revision,
        materializedAt,
        sourceReceipt: {
          sourceKind: 'import',
          sourceId: runId,
          querySha256: row.transform_sha256,
          producerVersion: ANALYTICS_DERIVATION_COMPILER_VERSION,
          acquiredAt: materializedAt,
          submittedAgain: false,
        },
        quality: output.checks,
        trigger: 'agent',
        requestSha256: row.request_sha256,
        sourceFormat: 'canonical_json',
        sourceBytes,
        columns: output.columns,
        rows: output.rows,
        derivation: {
          runId,
          compilerVersion: ANALYTICS_DERIVATION_COMPILER_VERSION,
          transformSha256: row.transform_sha256,
          inputSetSha256: row.input_set_sha256,
          materializationKeySha256: row.materialization_key_sha256,
          inputs: pins,
          checks: output.checks,
        },
      });
      const completedAt = timestamp();
      const changed = db.prepare(`
        UPDATE analytics_derived_runs
        SET status = 'completed', output_version_id = ?, receipt_json = ?, error = NULL,
            next_action = NULL, lease_owner = NULL, lease_expires_at = NULL, heartbeat_at = ?, completed_at = ?
        WHERE id = ? AND status = 'running' AND output_version_id = ?
      `).run(
        promotion.version.id,
        stableAnalyticsJson({
          datasetId: dataset.id,
          versionId: promotion.version.id,
          materializationKeySha256: row.materialization_key_sha256,
          inputVersionIds: pins.map(pin => pin.versionId),
          transformSha256: row.transform_sha256,
          headRevision: promotion.head.headRevision,
          idempotent: promotion.idempotent,
        }),
        completedAt,
        completedAt,
        runId,
        promotion.version.id,
      );
      if (changed.changes !== 1) fail('conflict', 'Derived run changed before completion receipt.');
      if (currentInputSetMatches(runId, dataset, definition)) {
        db.prepare('DELETE FROM analytics_derived_dirty WHERE dataset_id = ?').run(dataset.id);
      }
      const version = store.getDatasetVersion(promotion.version.id)!;
      return { state: 'ready', run: getRun(runId)!, version, joinedExisting: false };
    } catch (error) {
      if (signal?.aborted) {
        const at = timestamp();
        db.prepare(`
          UPDATE analytics_derived_runs
          SET status='queued', lease_owner=NULL, lease_expires_at=NULL,
              heartbeat_at=?, error=NULL, next_action=NULL
          WHERE id=? AND status='running' AND output_version_id IS NULL
        `).run(at, runId);
        const run = getRun(runId);
        if (run?.status === 'queued') {
          return { state: 'pending', run, joinedExisting: false, nextAction: 'Derived materialization was locally interrupted and will resume from its exact pins.' };
        }
      }
      return failRun(runId, error);
    }
  }

  async function materialize(
    value: AnalyticsDerivedMaterializationRequest,
    options: { signal?: AbortSignal } = {},
  ): Promise<AnalyticsDerivedMaterializationOutcome> {
    if (options.signal?.aborted) fail('query_cancelled', 'Derived materialization was cancelled before it started.');
    const begun = beginOrJoin(value);
    if (begun.state !== 'pending') return begun;
    const existingPromise = inFlight.get(begun.run.id);
    if (existingPromise) return existingPromise;
    const row = getRunRow(begun.run.id);
    if (!row || row.status !== 'queued') return begun;
    const promise = executeRun(begun.run.id, options.signal).finally(() => inFlight.delete(begun.run.id));
    inFlight.set(begun.run.id, promise);
    return promise;
  }

  function syntheticRequest(dataset: AnalyticsDatasetDetail): AnalyticsRequest {
    const partitions = [...dataset.contract.coverage.completePartitions].sort();
    if (!partitions.length) fail('integrity_failed', `Derived dataset ${dataset.id} has no complete coverage.`);
    return {
      domainKey: dataset.domainKey,
      metric: dataset.contract.metric,
      dimensions: dataset.definition.answer?.rowDimensions ?? dataset.contract.availableDimensions,
      filters: [],
      dateRange: { start: partitions[0], end: partitions.at(-1)! },
      timeZone: dataset.contract.timeZone,
      countingKey: dataset.contract.countingKey,
      regime: dataset.contract.regime,
      requiredGrain: dataset.contract.grain,
      freshness: { mode: 'allow_stale' },
      use: 'dashboard',
    };
  }

  function enqueueNextDirty(): void {
    const row = db.prepare(`
      SELECT dirty.dataset_id
      FROM analytics_derived_dirty dirty
      JOIN analytics_datasets target ON target.id = dirty.dataset_id
      WHERE target.lifecycle = 'active' AND dirty.status = 'pending'
        AND NOT EXISTS (
          SELECT 1
          FROM analytics_dataset_dependencies dependency
          JOIN analytics_derived_dirty upstream ON upstream.dataset_id = dependency.input_dataset_id
          WHERE dependency.derived_dataset_id = dirty.dataset_id
            AND dependency.definition_revision = target.definition_revision
        )
        AND NOT EXISTS (
          SELECT 1 FROM analytics_derived_runs run
          WHERE run.dataset_id = dirty.dataset_id AND run.status IN ('queued','running')
        )
      ORDER BY dirty.invalidated_at, dirty.dataset_id LIMIT 1
    `).get() as { dataset_id: string } | undefined;
    if (!row) return;
    const dataset = store.getDataset(row.dataset_id);
    if (!dataset) return;
    beginOrJoin({
      datasetId: dataset.id,
      request: syntheticRequest(dataset),
      consumer: { kind: 'dashboard_widget', id: `scheduler:${dataset.id}` },
    });
  }

  async function processNext(): Promise<number> {
    enqueueNextDirty();
    const row = db.prepare(`
      SELECT id FROM analytics_derived_runs WHERE status = 'queued' ORDER BY queued_at, id LIMIT 1
    `).get() as { id: string } | undefined;
    if (!row) return 0;
    await executeRun(row.id);
    return 1;
  }

  function recoverExpired(): number {
    const at = timestamp();
    const rows = db.prepare(`
      SELECT * FROM analytics_derived_runs
      WHERE status = 'running' AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
      ORDER BY queued_at, id
    `).all(at) as DerivedRunRow[];
    let recovered = 0;
    for (const row of rows) {
      if (!row.output_version_id) {
        recovered += db.prepare(`
          UPDATE analytics_derived_runs
          SET status = 'queued', lease_owner = NULL, lease_expires_at = NULL,
              heartbeat_at = ?, error = NULL, next_action = NULL, completed_at = NULL
          WHERE id = ? AND status = 'running' AND output_version_id IS NULL
        `).run(at, row.id).changes;
        continue;
      }
      try {
        const version = store.getDatasetVersion(row.output_version_id);
        if (!version?.derivation
          || version.derivation.runId !== row.id
          || version.derivation.materializationKeySha256 !== row.materialization_key_sha256
          || version.derivation.inputSetSha256 !== row.input_set_sha256
          || version.derivation.transformSha256 !== row.transform_sha256) {
          fail('integrity_failed', 'Published derived output does not match its interrupted run.');
        }
        store.verifyVersion(version.id);
        const receipt = stableAnalyticsJson({
          datasetId: row.dataset_id,
          versionId: version.id,
          materializationKeySha256: row.materialization_key_sha256,
          inputVersionIds: pinsForRun(row.id).map(pin => pin.versionId),
          transformSha256: row.transform_sha256,
          recoveredAfterPublish: true,
        });
        const changed = db.prepare(`
          UPDATE analytics_derived_runs
          SET status = 'completed', receipt_json = COALESCE(receipt_json, ?),
              error = NULL, next_action = NULL, lease_owner = NULL, lease_expires_at = NULL,
              heartbeat_at = ?, completed_at = COALESCE(completed_at, ?)
          WHERE id = ? AND status = 'running' AND output_version_id = ?
        `).run(receipt, at, at, row.id, version.id);
        if (changed.changes === 1) {
          recovered += 1;
          const dataset = store.getDataset(row.dataset_id);
          if (dataset && dataset.definitionRevision === row.definition_revision) {
            const definition = parseAnalyticsDerivedDefinition(dataset.definition.derived);
            if (currentInputSetMatches(row.id, dataset, definition)) {
              db.prepare('DELETE FROM analytics_derived_dirty WHERE dataset_id = ?').run(dataset.id);
            }
          }
        }
      } catch (error) {
        if (error instanceof AnalyticsDataRoomError && error.code === 'conflict') continue;
        const message = error instanceof Error ? error.message : String(error);
        recovered += db.prepare(`
          UPDATE analytics_derived_runs
          SET status = 'failed', error = ?, next_action = ?, lease_owner = NULL,
              lease_expires_at = NULL, heartbeat_at = ?, completed_at = ?
          WHERE id = ? AND status = 'running'
        `).run(
          message.slice(0, 2000),
          'Inspect the published output lineage and integrity before creating a successor.',
          at,
          at,
          row.id,
        ).changes;
      }
    }
    return recovered;
  }

  recoverExpired();
  return { resolvePlan, beginOrJoin, materialize, processNext, recoverExpired, getRun };
}
