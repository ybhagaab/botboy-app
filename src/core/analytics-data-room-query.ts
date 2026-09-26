import { createRequire } from 'node:module';
import { Worker } from 'node:worker_threads';
import {
  analyticsRequestSha256,
  analyticsSha256,
  normalizeAnalyticsRequest,
  stableAnalyticsJson,
} from './analytics-data-room-policy.js';
import {
  AnalyticsDataRoomError,
  isAnalyticsIsoTimestamp,
  type AnalyticsDataRoomStore,
} from './analytics-data-room-store.js';
import type {
  AnalyticsCompiledLocalQuery,
  AnalyticsDashboardViewRequestV1,
  AnalyticsDataCell,
  AnalyticsDatasetDetail,
  AnalyticsDatasetVersionDetail,
  AnalyticsFieldContract,
  AnalyticsLocalQueryResult,
  AnalyticsMaterializedAnswerRecipeV1,
  AnalyticsRequest,
} from './analytics-data-room-types.js';

export const ANALYTICS_LOCAL_QUERY_COMPILER_VERSION = 'sqlite-projection-v1';
export const ANALYTICS_DASHBOARD_VIEW_QUERY_COMPILER_VERSION = 'sqlite-dashboard-view-v1';
export const ANALYTICS_LOCAL_QUERY_MAX_ROWS = 200;
export const ANALYTICS_LOCAL_QUERY_MAX_BYTES = 40_000;
export const ANALYTICS_LOCAL_QUERY_TIMEOUT_MS = 5_000;
const MAX_FILTERS = 20;
const MAX_IN_VALUES = 100;
const SHA256_RE = /^[a-f0-9]{64}$/;

export interface AnalyticsLocalQueryViewContext {
  viewRequest: AnalyticsDashboardViewRequestV1;
  controlDefinitionSha256: string;
  controlValuesSha256: string;
  effectiveViewRequestSha256: string;
}

const require = createRequire(import.meta.url);
const betterSqlite3Path = require.resolve('better-sqlite3');

export interface AnalyticsLocalQueryEngine {
  supports(input: {
    dataset: AnalyticsDatasetDetail;
    version: AnalyticsDatasetVersionDetail;
    request: AnalyticsRequest;
  }): { supported: true; recipe: AnalyticsMaterializedAnswerRecipeV1 } | { supported: false; reason: string };
  compile(input: {
    dataset: AnalyticsDatasetDetail;
    version: AnalyticsDatasetVersionDetail;
    request: AnalyticsRequest;
    view?: AnalyticsLocalQueryViewContext;
  }): AnalyticsCompiledLocalQuery;
  execute(input: {
    dataset: AnalyticsDatasetDetail;
    version: AnalyticsDatasetVersionDetail;
    request: AnalyticsRequest;
    view?: AnalyticsLocalQueryViewContext;
    signal?: AbortSignal;
  }): Promise<AnalyticsLocalQueryResult>;
}

interface WorkerResult {
  ok: boolean;
  rows?: AnalyticsDataCell[][];
  rowCount?: number;
  error?: string;
}

function fail(code: 'invalid_input' | 'query_unsupported' | 'query_timeout' | 'query_cancelled' | 'integrity_failed', message: string): never {
  throw new AnalyticsDataRoomError(code, message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function uniqueStrings(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || !item)) {
    return fail('query_unsupported', `${label} must contain non-empty field names.`);
  }
  if (new Set(value).size !== value.length) fail('query_unsupported', `${label} contains duplicate fields.`);
  return [...value];
}

function recipeFromDefinition(dataset: AnalyticsDatasetDetail): AnalyticsMaterializedAnswerRecipeV1 {
  const value = dataset.definition.answer;
  if (!isRecord(value)
    || value.version !== 1
    || typeof value.metricId !== 'string'
    || typeof value.metricValueColumn !== 'string'
    || !Array.isArray(value.stableOrder)) {
    return fail('query_unsupported', `Dataset ${dataset.id} has no valid materialized-answer recipe.`);
  }
  const rowDimensions = uniqueStrings(value.rowDimensions, 'answer.rowDimensions');
  const filterableFields = uniqueStrings(value.filterableFields, 'answer.filterableFields');
  const stableOrder = value.stableOrder.map((item, index) => {
    if (!isRecord(item)
      || typeof item.field !== 'string' || !item.field
      || (item.direction !== 'asc' && item.direction !== 'desc')) {
      return fail('query_unsupported', `answer.stableOrder[${index}] is malformed.`);
    }
    return { field: item.field, direction: item.direction };
  });
  if (new Set(stableOrder.map(item => item.field)).size !== stableOrder.length) {
    fail('query_unsupported', 'answer.stableOrder contains duplicate fields.');
  }
  return {
    version: 1,
    metricId: value.metricId,
    metricValueColumn: value.metricValueColumn,
    rowDimensions,
    filterableFields,
    stableOrder,
  };
}

function fieldMap(contract: AnalyticsDatasetVersionDetail['contract']): Map<string, AnalyticsFieldContract> {
  return new Map(contract.schema.map(field => [field.name, field]));
}

function validateRecipe(
  dataset: AnalyticsDatasetDetail,
  version: AnalyticsDatasetVersionDetail,
  requestInput: AnalyticsRequest,
): AnalyticsMaterializedAnswerRecipeV1 {
  const request = normalizeAnalyticsRequest(requestInput);
  if (dataset.definitionSha256 !== version.definitionSha256) {
    fail('query_unsupported', 'The selected version belongs to an older dataset definition without an exact current recipe.');
  }
  const recipe = recipeFromDefinition(dataset);
  const fields = fieldMap(version.contract);
  const metricField = fields.get(recipe.metricValueColumn);
  if (recipe.metricId !== request.metric.id || recipe.metricId !== version.contract.metric.id) {
    fail('query_unsupported', 'The materialized-answer recipe metric differs from the request.');
  }
  if (!metricField || (metricField.logicalType !== 'integer' && metricField.logicalType !== 'number')) {
    fail('query_unsupported', 'The materialized metric value column is absent or non-numeric.');
  }
  if (recipe.rowDimensions.includes(recipe.metricValueColumn)) {
    fail('query_unsupported', 'The materialized metric value column cannot also be a row dimension.');
  }
  for (const name of [...recipe.rowDimensions, ...recipe.filterableFields, ...recipe.stableOrder.map(item => item.field)]) {
    if (!fields.has(name)) fail('query_unsupported', `Recipe field ${name} is absent from the immutable schema.`);
  }
  if (!recipe.filterableFields.includes(version.contract.timeField)) {
    fail('query_unsupported', 'The immutable time field is not filterable by the materialized-answer recipe.');
  }
  const requestedDimensions = [...request.dimensions].sort();
  if (stableAnalyticsJson([...recipe.rowDimensions].sort()) !== stableAnalyticsJson(requestedDimensions)) {
    fail('query_unsupported', 'Requested dimensions require regrouping; local aggregation belongs to a derived dataset.');
  }
  for (const filter of request.filters) {
    if (!recipe.filterableFields.includes(filter.field)) {
      fail('query_unsupported', `Filter field ${filter.field} is not approved by the materialized-answer recipe.`);
    }
  }
  return recipe;
}

function validIsoDay(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function validateFilterValue(value: AnalyticsDataCell, field: AnalyticsFieldContract, label: string): AnalyticsDataCell {
  if (value === null) return value;
  if (field.logicalType === 'string' && typeof value !== 'string') fail('invalid_input', `${label} must be a string.`);
  if (field.logicalType === 'integer' && (typeof value !== 'number' || !Number.isSafeInteger(value))) {
    fail('invalid_input', `${label} must be a safe integer.`);
  }
  if (field.logicalType === 'number' && (typeof value !== 'number' || !Number.isFinite(value))) {
    fail('invalid_input', `${label} must be a finite number.`);
  }
  if (field.logicalType === 'boolean' && typeof value !== 'boolean') fail('invalid_input', `${label} must be a boolean.`);
  if (field.logicalType === 'date' && !validIsoDay(value)) fail('invalid_input', `${label} must be an ISO calendar date.`);
  if (field.logicalType === 'timestamp' && !isAnalyticsIsoTimestamp(value)) {
    fail('invalid_input', `${label} must be an ISO timestamp.`);
  }
  return typeof value === 'boolean' ? (value ? 1 : 0) : value;
}

function nextIsoDay(day: string): string {
  const date = new Date(`${day}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

function localMidnightUtc(day: string, timeZone: string): string {
  const [year, month, date] = day.split('-').map(Number);
  const targetAsUtc = Date.UTC(year, month - 1, date, 0, 0, 0);
  let guess = targetAsUtc;
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    });
  } catch {
    return fail('invalid_input', `Timezone ${timeZone} is invalid.`);
  }
  for (let attempt = 0; attempt < 4; attempt++) {
    const parts = formatter.formatToParts(new Date(guess));
    const value = (type: Intl.DateTimeFormatPartTypes): number => Number(parts.find(part => part.type === type)?.value);
    const observedAsUtc = Date.UTC(value('year'), value('month') - 1, value('day'), value('hour'), value('minute'), value('second'));
    const adjustment = targetAsUtc - observedAsUtc;
    guess += adjustment;
    if (adjustment === 0) break;
  }
  return new Date(guess).toISOString();
}

export function compileAnalyticsLocalQuery(input: {
  dataset: AnalyticsDatasetDetail;
  version: AnalyticsDatasetVersionDetail;
  request: AnalyticsRequest;
  byteLimit?: number;
  view?: AnalyticsLocalQueryViewContext;
}): AnalyticsCompiledLocalQuery {
  const request = normalizeAnalyticsRequest(input.request);
  const recipe = validateRecipe(input.dataset, input.version, request);
  const view = input.view;
  if (view) {
    if (view.viewRequest?.version !== 1
      || stableAnalyticsJson(normalizeAnalyticsRequest(view.viewRequest.request)) !== stableAnalyticsJson(request)
      || analyticsSha256(view.viewRequest) !== view.effectiveViewRequestSha256
      || !SHA256_RE.test(view.controlDefinitionSha256)
      || !SHA256_RE.test(view.controlValuesSha256)
      || !SHA256_RE.test(view.effectiveViewRequestSha256)) {
      fail('invalid_input', 'Dashboard view/control identity is invalid or differs from its effective request.');
    }
  }
  if (request.filters.length > MAX_FILTERS) fail('invalid_input', `At most ${MAX_FILTERS} filters are allowed.`);
  const fields = fieldMap(input.version.contract);
  const conditions: string[] = [];
  const params: AnalyticsDataCell[] = [];
  const timeField = fields.get(input.version.contract.timeField)!;
  if (timeField.logicalType === 'date') {
    conditions.push(`${quoteIdentifier(timeField.name)} BETWEEN ? AND ?`);
    params.push(request.dateRange.start, request.dateRange.end);
  } else if (timeField.logicalType === 'timestamp') {
    conditions.push(`julianday(${quoteIdentifier(timeField.name)}) >= julianday(?)`);
    conditions.push(`julianday(${quoteIdentifier(timeField.name)}) < julianday(?)`);
    params.push(
      localMidnightUtc(request.dateRange.start, request.timeZone),
      localMidnightUtc(nextIsoDay(request.dateRange.end), request.timeZone),
    );
  } else {
    fail('query_unsupported', 'The immutable time field is not date-compatible.');
  }

  let inValueCount = 0;
  for (const [filterIndex, filter] of request.filters.entries()) {
    const field = fields.get(filter.field);
    if (!field) fail('invalid_input', `Filter field ${filter.field} is absent from the immutable schema.`);
    const identifier = quoteIdentifier(field.name);
    const values = Array.isArray(filter.value) ? filter.value : [filter.value];
    if (filter.operator === 'eq') {
      const value = validateFilterValue(values[0], field, `filters[${filterIndex}].value`);
      if (value === null) conditions.push(`${identifier} IS NULL`);
      else { conditions.push(`${identifier} = ?`); params.push(value); }
      continue;
    }
    if (filter.operator === 'in') {
      inValueCount += values.length;
      if (inValueCount > MAX_IN_VALUES) fail('invalid_input', `At most ${MAX_IN_VALUES} IN values are allowed.`);
      const normalized = values.map((value, valueIndex) => validateFilterValue(
        value,
        field,
        `filters[${filterIndex}].value[${valueIndex}]`,
      ));
      const nonNull = normalized.filter((value): value is Exclude<AnalyticsDataCell, null> => value !== null);
      const clauses: string[] = [];
      if (nonNull.length) {
        clauses.push(`${identifier} IN (${nonNull.map(() => '?').join(', ')})`);
        params.push(...nonNull);
      }
      if (normalized.some(value => value === null)) clauses.push(`${identifier} IS NULL`);
      conditions.push(clauses.length > 1 ? `(${clauses.join(' OR ')})` : clauses[0]);
      continue;
    }
    if (values.some(value => value === null)) {
      fail('invalid_input', `filters[${filterIndex}] cannot compare null with ${filter.operator}.`);
    }
    const normalized = values.map((value, valueIndex) => validateFilterValue(
      value,
      field,
      `filters[${filterIndex}].value[${valueIndex}]`,
    ));
    if (filter.operator === 'between') {
      conditions.push(`${identifier} BETWEEN ? AND ?`);
      params.push(normalized[0], normalized[1]);
    } else {
      conditions.push(`${identifier} ${filter.operator === 'gte' ? '>=' : '<='} ?`);
      params.push(normalized[0]);
    }
  }

  const columns = [...request.dimensions, recipe.metricValueColumn];
  const select = columns.map(quoteIdentifier).join(', ');
  const where = conditions.join(' AND ');
  const selectedSort = view?.viewRequest.sort ?? null;
  if (selectedSort && (!columns.includes(selectedSort.field)
    || (selectedSort.direction !== 'asc' && selectedSort.direction !== 'desc'))) {
    fail('invalid_input', 'Dashboard global sort is not an allowed output field/direction.');
  }
  const order = [
    ...(selectedSort
      ? [`${quoteIdentifier(selectedSort.field)} ${selectedSort.direction.toUpperCase()}`]
      : []),
    ...recipe.stableOrder
      .filter(item => item.field !== selectedSort?.field)
      .map(item => `${quoteIdentifier(item.field)} ${item.direction.toUpperCase()}`),
    'rowid ASC',
  ].join(', ');
  const compilerVersion = view
    ? ANALYTICS_DASHBOARD_VIEW_QUERY_COMPILER_VERSION
    : ANALYTICS_LOCAL_QUERY_COMPILER_VERSION;
  const rowLimit = request.resultLimit ?? ANALYTICS_LOCAL_QUERY_MAX_ROWS;
  const byteLimit = input.byteLimit ?? ANALYTICS_LOCAL_QUERY_MAX_BYTES;
  if (!Number.isInteger(byteLimit) || byteLimit < 1 || byteLimit > 1_000_000) {
    fail('invalid_input', 'Local query byte limit is invalid.');
  }
  const countSql = `SELECT COUNT(*) AS "__botboy_count" FROM "data" WHERE ${where}`;
  const sql = `SELECT ${select} FROM "data" WHERE ${where} ORDER BY ${order} LIMIT ?`;
  const querySha256 = analyticsSha256({
    compilerVersion,
    requestSha256: analyticsRequestSha256(request),
    versionId: input.version.id,
    definitionSha256: input.version.definitionSha256,
    recipe,
    sql,
    params,
    rowLimit,
    byteLimit,
    ...(view ? {
      effectiveViewRequestSha256: view.effectiveViewRequestSha256,
      controlDefinitionSha256: view.controlDefinitionSha256,
      controlValuesSha256: view.controlValuesSha256,
    } : {}),
  });
  return {
    compilerVersion,
    versionId: input.version.id,
    columns,
    sql,
    countSql,
    params,
    querySha256,
    rowLimit,
    byteLimit,
    ...(view ? {
      effectiveViewRequestSha256: view.effectiveViewRequestSha256,
      controlDefinitionSha256: view.controlDefinitionSha256,
      controlValuesSha256: view.controlValuesSha256,
    } : {}),
  };
}

const QUERY_WORKER_SOURCE = String.raw`
const { parentPort, workerData } = require('node:worker_threads');
const Database = require(workerData.sqliteModulePath);
let database;
try {
  database = new Database(workerData.databasePath, { readonly: true, fileMustExist: true });
  database.pragma('query_only = ON');
  const countRow = database.prepare(workerData.countSql).get(...workerData.params);
  const rowCount = Number(countRow.__botboy_count || 0);
  const statement = database.prepare(workerData.sql);
  const rows = [];
  let bytes = 2;
  for (const row of statement.iterate(...workerData.params, workerData.rowLimit)) {
    const values = workerData.columns.map(column => row[column] === undefined ? null : row[column]);
    const nextBytes = Buffer.byteLength(JSON.stringify(values), 'utf8') + (rows.length ? 1 : 0);
    if (bytes + nextBytes > workerData.byteLimit) break;
    rows.push(values);
    bytes += nextBytes;
  }
  parentPort.postMessage({ ok: true, rows, rowCount });
} catch (error) {
  parentPort.postMessage({ ok: false, error: String(error && error.message || error).slice(0, 500) });
} finally {
  if (database) database.close();
}
`;

function runQueryWorker(input: {
  databasePath: string;
  compiled: AnalyticsCompiledLocalQuery;
  timeoutMs: number;
  signal?: AbortSignal;
  workerSource?: string;
}): Promise<{ rows: AnalyticsDataCell[][]; rowCount: number }> {
  if (input.signal?.aborted) return Promise.reject(new AnalyticsDataRoomError('query_cancelled', 'Local analytics query was cancelled.'));
  return new Promise((resolve, reject) => {
    const worker = new Worker(input.workerSource ?? QUERY_WORKER_SOURCE, {
      eval: true,
      workerData: {
        sqliteModulePath: betterSqlite3Path,
        databasePath: input.databasePath,
        sql: input.compiled.sql,
        countSql: input.compiled.countSql,
        params: input.compiled.params,
        rowLimit: input.compiled.rowLimit,
        byteLimit: input.compiled.byteLimit,
        columns: input.compiled.columns,
      },
    });
    let settled = false;
    const finish = (action: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      input.signal?.removeEventListener('abort', abort);
      action();
    };
    const abort = (): void => {
      void worker.terminate();
      finish(() => reject(new AnalyticsDataRoomError('query_cancelled', 'Local analytics query was cancelled.')));
    };
    const timer = setTimeout(() => {
      void worker.terminate();
      finish(() => reject(new AnalyticsDataRoomError('query_timeout', `Local analytics query exceeded ${input.timeoutMs} ms.`)));
    }, input.timeoutMs);
    input.signal?.addEventListener('abort', abort, { once: true });
    if (input.signal?.aborted) abort();
    worker.once('message', (message: WorkerResult) => {
      finish(() => {
        void worker.terminate();
        if (!message.ok || !Array.isArray(message.rows) || !Number.isInteger(message.rowCount)) {
          reject(new AnalyticsDataRoomError('integrity_failed', 'Local query worker rejected the verified sidecar.'));
          return;
        }
        resolve({ rows: message.rows, rowCount: message.rowCount! });
      });
    });
    worker.once('error', () => {
      finish(() => reject(new AnalyticsDataRoomError('conflict', 'Local query worker became unavailable; retry.')));
    });
    worker.once('exit', code => {
      if (code !== 0) finish(() => reject(new AnalyticsDataRoomError('conflict', 'Local query worker exited before returning a result.')));
    });
  });
}

function validateMaterializedMultiplicity(rows: AnalyticsDataCell[][], dimensionCount: number): void {
  const identities = new Set<string>();
  for (const row of rows) {
    const identity = stableAnalyticsJson(row.slice(0, dimensionCount));
    if (identities.has(identity)) {
      fail('integrity_failed', 'Materialized answer contains duplicate rows at its declared dimension grain.');
    }
    identities.add(identity);
  }
}

function rehydrateRows(
  rows: AnalyticsDataCell[][],
  columns: string[],
  version: AnalyticsDatasetVersionDetail,
): AnalyticsDataCell[][] {
  const fields = fieldMap(version.contract);
  return rows.map((row, rowIndex) => row.map((value, columnIndex) => {
    const field = fields.get(columns[columnIndex])!;
    if (value === null) return null;
    if (field.logicalType === 'boolean') {
      if (value !== 0 && value !== 1) fail('integrity_failed', `Row ${rowIndex} has an invalid stored boolean.`);
      return value === 1;
    }
    if (field.logicalType === 'integer' && (typeof value !== 'number' || !Number.isSafeInteger(value))) {
      fail('integrity_failed', `Row ${rowIndex} has an invalid stored integer.`);
    }
    if (field.logicalType === 'number' && (typeof value !== 'number' || !Number.isFinite(value))) {
      fail('integrity_failed', `Row ${rowIndex} has an invalid stored number.`);
    }
    if ((field.logicalType === 'string' || field.logicalType === 'date' || field.logicalType === 'timestamp')
      && typeof value !== 'string') {
      fail('integrity_failed', `Row ${rowIndex} has an invalid stored text value.`);
    }
    return value;
  }));
}

export function createAnalyticsLocalQueryEngine(input: {
  store: AnalyticsDataRoomStore;
  timeoutMs?: number;
  byteLimit?: number;
  /** Isolated test hook; production always uses the fixed query-only worker. */
  workerSource?: string;
}): AnalyticsLocalQueryEngine {
  const timeoutMs = input.timeoutMs ?? ANALYTICS_LOCAL_QUERY_TIMEOUT_MS;
  const byteLimit = input.byteLimit ?? ANALYTICS_LOCAL_QUERY_MAX_BYTES;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 50 || timeoutMs > 30_000) {
    fail('invalid_input', 'Local query timeout must be from 50 to 30000 ms.');
  }

  function supports(value: {
    dataset: AnalyticsDatasetDetail;
    version: AnalyticsDatasetVersionDetail;
    request: AnalyticsRequest;
  }): { supported: true; recipe: AnalyticsMaterializedAnswerRecipeV1 } | { supported: false; reason: string } {
    try {
      return { supported: true, recipe: validateRecipe(value.dataset, value.version, value.request) };
    } catch (error) {
      if (error instanceof AnalyticsDataRoomError && error.code === 'query_unsupported') {
        return { supported: false, reason: error.message };
      }
      throw error;
    }
  }

  async function execute(value: {
    dataset: AnalyticsDatasetDetail;
    version: AnalyticsDatasetVersionDetail;
    request: AnalyticsRequest;
    view?: AnalyticsLocalQueryViewContext;
    signal?: AbortSignal;
  }): Promise<AnalyticsLocalQueryResult> {
    const request = normalizeAnalyticsRequest(value.request);
    const compiled = compileAnalyticsLocalQuery({
      dataset: value.dataset,
      version: value.version,
      request,
      byteLimit,
      ...(value.view ? { view: value.view } : {}),
    });
    const databasePath = input.store.getVerifiedMaterializedPath(value.version.id, request.use);
    const verified = input.store.getDatasetVersion(value.version.id);
    const integrityVerifiedAt = verified?.integrity.verifiedAt;
    if (!integrityVerifiedAt) fail('integrity_failed', 'The exact version has no current integrity verification receipt.');
    const startedAt = Date.now();
    const output = await runQueryWorker({
      databasePath,
      compiled,
      timeoutMs,
      signal: value.signal,
      workerSource: input.workerSource,
    });
    const rows = rehydrateRows(output.rows, compiled.columns, value.version);
    validateMaterializedMultiplicity(rows, request.dimensions.length);
    return {
      result: {
        columns: compiled.columns,
        rows,
        rowCount: output.rowCount,
        displayedRowCount: rows.length,
        truncated: rows.length < output.rowCount,
      },
      receipt: {
        querySha256: compiled.querySha256,
        compilerVersion: compiled.compilerVersion,
        versionId: value.version.id,
        integrityVerifiedAt,
        elapsedMs: Date.now() - startedAt,
        rowLimit: compiled.rowLimit,
        byteLimit: compiled.byteLimit,
      },
    };
  }

  return { supports, compile: value => compileAnalyticsLocalQuery({ ...value, byteLimit }), execute };
}
