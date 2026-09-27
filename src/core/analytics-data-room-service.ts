import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { analyticsSha256, stableAnalyticsJson } from './analytics-data-room-policy.js';
import {
  AnalyticsDataRoomError,
  isAnalyticsIsoTimestamp,
  type AnalyticsDataRoomStore,
  type AnalyticsParsedSourceIngest,
} from './analytics-data-room-store.js';
import type {
  AnalyticsDataRoomCatalogDatasetEnvelope,
  AnalyticsDataRoomCatalogDatasetList,
  AnalyticsDataRoomCatalogVersionEnvelope,
  AnalyticsDataRoomCatalogVersionList,
  AnalyticsDataRoomDatasetSearchHit,
  AnalyticsDataCell,
  AnalyticsDatasetBackupReceipt,
  AnalyticsDatasetDefinitionInput,
  AnalyticsDatasetDependencyRecord,
  AnalyticsDatasetDetail,
  AnalyticsDatasetRevisionInput,
  AnalyticsDatasetRestoreReceipt,
  AnalyticsDatasetSummary,
  AnalyticsDatasetVersionDetail,
  AnalyticsDatasetVersionSummary,
  AnalyticsFieldContract,
  AnalyticsImportRowsIngestRequest,
  AnalyticsQualityAssertionEvaluation,
  AnalyticsSqlRowsIngestRequest,
  AnalyticsVersionIngestContext,
  AnalyticsVersionPromotionReceipt,
} from './analytics-data-room-types.js';
import type { AnalyticsDataRoomBackupService } from './analytics-data-room-backup.js';

const SHA256_RE = /^[a-f0-9]{64}$/;
export const ANALYTICS_LOCAL_FILE_PARSER_VERSION = 'botboy-local-file-table-v1';
const MAX_LOCAL_FILE_CANONICAL_BYTES = 32 * 1024 * 1024;

export interface AnalyticsEtlTsvIngestRequest extends AnalyticsVersionIngestContext {
  savedTo: string;
  resultBytes: number;
  resultSha256: string;
  nullToken?: string;
}

/** Complete receipt for one exact local file typed into a declared schema. */
export interface AnalyticsLocalFileCompleteReceipt {
  parserVersion: typeof ANALYTICS_LOCAL_FILE_PARSER_VERSION;
  completeToEof: true;
  format: 'csv' | 'tsv' | 'xlsx';
  fileName: string;
  inputSha256: string;
  inputBytes: number;
  sheet?: string;
  headerRow?: number;
  nullToken: string;
  fileRowCount: number;
  rowCount: number;
  rowsetSha256: string;
  schemaSha256: string;
  mode: 'new_dataset' | 'replace' | 'merge_partitions';
  /** Disclosed read facts: omitted trailing fields, skipped blank/title rows, cached formula results. */
  table: { shortRows: number; blankRowsSkipped: number; rowsAboveHeader: number; formulaCells: number };
  base?: {
    versionId: string;
    contentSha256: string;
    keptRows: number;
    replacedPartitions: string[];
  };
}

export interface AnalyticsLocalFileRowsIngestRequest extends AnalyticsVersionIngestContext {
  columns: string[];
  rows: AnalyticsDataCell[][];
  complete: AnalyticsLocalFileCompleteReceipt;
  coverageRevision?: AnalyticsParsedSourceIngest['coverageRevision'];
}

export interface AnalyticsDataRoomCatalogReader {
  /** Internal readers retained for deterministic chat/answer knowledge. Never serialize directly from the catalog router. */
  listDatasets(input?: { limit?: number }): AnalyticsDatasetSummary[];
  searchDatasets(query: string, limit?: number): AnalyticsDataRoomDatasetSearchHit[];
  getDataset(datasetId: string): AnalyticsDatasetDetail | null;
  listDatasetVersions(datasetId: string): AnalyticsDatasetVersionSummary[] | null;
  getDatasetVersion(versionId: string): AnalyticsDatasetVersionDetail | null;
  listCatalogDatasets(input?: { limit?: number }): AnalyticsDataRoomCatalogDatasetList;
  getCatalogDataset(datasetId: string): AnalyticsDataRoomCatalogDatasetEnvelope | null;
  listCatalogDatasetVersions(datasetId: string, input?: { limit?: number }): AnalyticsDataRoomCatalogVersionList | null;
  getCatalogDatasetVersion(versionId: string): AnalyticsDataRoomCatalogVersionEnvelope | null;
}

export interface AnalyticsDataRoomService extends AnalyticsDataRoomCatalogReader {
  listDatasets(input?: { limit?: number }): AnalyticsDatasetSummary[];
  getDataset(datasetId: string): AnalyticsDatasetDetail | null;
  listDatasetVersions(datasetId: string): AnalyticsDatasetVersionSummary[] | null;
  getDatasetVersion(versionId: string): AnalyticsDatasetVersionDetail | null;
  registerDataset(input: AnalyticsDatasetDefinitionInput): AnalyticsDatasetDetail;
  reviseDataset(input: AnalyticsDatasetRevisionInput): AnalyticsDatasetDetail;
  listDependencies(datasetId: string, definitionRevision?: number): AnalyticsDatasetDependencyRecord[];
  ingestEtlTsv(input: AnalyticsEtlTsvIngestRequest): AnalyticsVersionPromotionReceipt;
  ingestLocalFileRows(input: AnalyticsLocalFileRowsIngestRequest): AnalyticsVersionPromotionReceipt;
  ingestSqlRows(input: AnalyticsSqlRowsIngestRequest): AnalyticsVersionPromotionReceipt;
  ingestImportRows(input: AnalyticsImportRowsIngestRequest): AnalyticsVersionPromotionReceipt;
  backupDataset(datasetId: string, targetRoot: string): AnalyticsDatasetBackupReceipt;
  restoreDatasetBackup(backupDirectory: string): AnalyticsDatasetRestoreReceipt;
}

function incomplete(message: string): never {
  throw new AnalyticsDataRoomError('incomplete_source', message);
}

function parseDelimitedRows(text: string, delimiter: '\t' | ',', label: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  let closedQuote = false;

  const pushCell = (): void => {
    row.push(cell);
    cell = '';
    closedQuote = false;
  };
  const pushRow = (): void => {
    pushCell();
    rows.push(row);
    row = [];
  };

  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (quoted) {
      if (character === '"') {
        if (text[index + 1] === '"') {
          cell += '"';
          index++;
        } else {
          quoted = false;
          closedQuote = true;
        }
      } else if (character === '\r' && text[index + 1] === '\n') {
        cell += '\n';
        index++;
      } else {
        cell += character;
      }
      continue;
    }

    if (closedQuote) {
      if (character === delimiter) {
        pushCell();
        continue;
      }
      if (character === '\n') {
        pushRow();
        continue;
      }
      if (character === '\r' && text[index + 1] === '\n') {
        pushRow();
        index++;
        continue;
      }
      incomplete(`Unexpected character after a quoted ${label} field at offset ${index}.`);
    }

    if (character === '"') {
      if (cell.length !== 0) incomplete(`Unexpected quote in an unquoted ${label} field at offset ${index}.`);
      quoted = true;
      continue;
    }
    if (character === delimiter) {
      pushCell();
      continue;
    }
    if (character === '\n') {
      if (row.length === 0 && cell.length === 0) incomplete(`Blank ${label} record at offset ${index}.`);
      pushRow();
      continue;
    }
    if (character === '\r') {
      if (text[index + 1] !== '\n') incomplete(`Lone carriage return in ${label} input at offset ${index}.`);
      if (row.length === 0 && cell.length === 0) incomplete(`Blank ${label} record at offset ${index}.`);
      pushRow();
      index++;
      continue;
    }
    cell += character;
  }

  if (quoted) incomplete(`${label} input ends inside a quoted field.`);
  if (closedQuote || cell.length > 0 || row.length > 0) pushRow();
  return rows;
}

/**
 * Strict complete UTF-8 delimited-table parser shared by ETL TSV and local-file
 * import. `raggedRight` accepts exporters that omit trailing empty fields
 * (such rows come back shorter than the header; absent cells carry no value),
 * except for an unterminated final record, which may be a truncated file.
 */
export function parseAnalyticsDelimited(
  bytes: Uint8Array,
  delimiter: '\t' | ',',
  label: string,
  options: { raggedRight?: boolean } = {},
): { columns: string[]; rawRows: string[][] } {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return incomplete(`${label} is not valid UTF-8.`);
  }
  if (text.includes('\0')) incomplete(`${label} contains a NUL byte.`);
  if (text.startsWith('\uFEFF')) text = text.slice(1);
  const rows = parseDelimitedRows(text, delimiter, label);
  if (rows.length === 0) incomplete(`${label} is empty.`);
  const columns = rows[0];
  if (columns.length === 0 || columns.length > 200 || columns.some(column => !column || column.trim() !== column)) {
    incomplete(`${label} headers must contain 1 to 200 non-empty names without surrounding whitespace.`);
  }
  if (new Set(columns).size !== columns.length) incomplete(`${label} contains duplicate headers.`);
  const rawRows = rows.slice(1);
  if (rawRows.length > 50_000 || rawRows.length * columns.length > 500_000) {
    incomplete(`${label} exceeds the 50000-row or 500000-cell complete-source limit.`);
  }
  const terminated = text.endsWith('\n');
  for (const [index, row] of rawRows.entries()) {
    const shortAllowed = options.raggedRight === true && row.length < columns.length
      && (terminated || index < rawRows.length - 1);
    if (row.length !== columns.length && !shortAllowed) {
      incomplete(`${label} row ${index + 1} has ${row.length} cells; expected ${columns.length}.`);
    }
    if (row.some(cell => cell.length > 1_000_000)) incomplete(`${label} row ${index + 1} contains a cell above 1000000 characters.`);
  }
  return { columns, rawRows };
}

export function parseAnalyticsTsv(bytes: Uint8Array): { columns: string[]; rawRows: string[][] } {
  return parseAnalyticsDelimited(bytes, '\t', 'ETL TSV');
}


/** One strict text-cell grammar for every delimited or text-typed source cell. */
export function parseDelimitedCell(
  raw: string,
  field: AnalyticsFieldContract,
  rowIndex: number,
  nullToken: string,
  label: string,
): AnalyticsDataCell {
  if (raw === nullToken) {
    if (!field.nullable) incomplete(`${label} row ${rowIndex} field ${field.name} may not be null.`);
    return null;
  }
  if (field.logicalType === 'string') return raw;
  if (field.logicalType === 'integer') {
    if (!/^-?(?:0|[1-9]\d*)$/.test(raw)) incomplete(`${label} row ${rowIndex} field ${field.name} is not an integer.`);
    const value = Number(raw);
    if (!Number.isSafeInteger(value)) incomplete(`${label} row ${rowIndex} field ${field.name} exceeds safe integer precision.`);
    return value;
  }
  if (field.logicalType === 'number') {
    if (!raw || !/^-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(raw)) {
      incomplete(`${label} row ${rowIndex} field ${field.name} is not a finite number.`);
    }
    const value = Number(raw);
    if (!Number.isFinite(value)) incomplete(`${label} row ${rowIndex} field ${field.name} is not a finite number.`);
    return value;
  }
  if (field.logicalType === 'boolean') {
    if (raw === 'true' || raw === '1') return true;
    if (raw === 'false' || raw === '0') return false;
    return incomplete(`${label} row ${rowIndex} field ${field.name} is not a boolean.`);
  }
  if (field.logicalType === 'date') {
    const parsed = new Date(`${raw}T00:00:00.000Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)
      || !Number.isFinite(parsed.getTime())
      || parsed.toISOString().slice(0, 10) !== raw) {
      incomplete(`${label} row ${rowIndex} field ${field.name} is not an ISO calendar date.`);
    }
    return raw;
  }
  if (!isAnalyticsIsoTimestamp(raw)) {
    incomplete(`${label} row ${rowIndex} field ${field.name} is not an ISO timestamp.`);
  }
  return raw;
}

function typedDelimitedRows(
  rawRows: string[][],
  schema: AnalyticsFieldContract[],
  nullToken: string,
  delimiter: '\t' | ',',
  label: string,
): AnalyticsDataCell[][] {
  if (!nullToken || nullToken.includes(delimiter) || nullToken.includes('"')
    || nullToken.includes('\n') || nullToken.includes('\r') || nullToken.includes('\0')) {
    throw new AnalyticsDataRoomError('invalid_input', `${label} null token is invalid.`);
  }
  return rawRows.map((row, rowIndex) => row.map((cell, columnIndex) => (
    parseDelimitedCell(cell, schema[columnIndex], rowIndex + 1, nullToken, label)
  )));
}

export function createAnalyticsDataRoomService(input: {
  store: AnalyticsDataRoomStore;
  backups: AnalyticsDataRoomBackupService;
}): AnalyticsDataRoomService {
  const { store, backups } = input;
  store.recoverStaleRuns();

  function ingestEtlTsv(request: AnalyticsEtlTsvIngestRequest): AnalyticsVersionPromotionReceipt {
    if (request.sourceReceipt.sourceKind !== 'datanet_etl') {
      throw new AnalyticsDataRoomError('invalid_input', 'ETL ingestion requires a datanet_etl source receipt.');
    }
    if (!Number.isInteger(request.resultBytes) || request.resultBytes < 0
      || !SHA256_RE.test(request.resultSha256)) {
      throw new AnalyticsDataRoomError('invalid_input', 'ETL result byte/SHA receipt is malformed.');
    }
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(request.savedTo);
    } catch {
      return incomplete('ETL result file does not exist.');
    }
    if (!stat.isFile() || stat.isSymbolicLink()) incomplete('ETL result path is not a regular file.');
    const bytes = fs.readFileSync(request.savedTo);
    const directSha256 = createHash('sha256').update(bytes).digest('hex');
    if (bytes.length !== request.resultBytes || directSha256 !== request.resultSha256) {
      incomplete('ETL result file does not match its complete byte/SHA receipt.');
    }
    const dataset = store.getDataset(request.datasetId);
    if (!dataset) throw new AnalyticsDataRoomError('not_found', `Dataset ${request.datasetId} was not found.`);
    const parsed = parseAnalyticsTsv(bytes);
    const expectedColumns = dataset.contract.schema.map(field => field.name);
    if (stableAnalyticsJson(parsed.columns) !== stableAnalyticsJson(expectedColumns)) {
      incomplete('ETL TSV headers do not exactly match the dataset contract.');
    }
    const rows = typedDelimitedRows(parsed.rawRows, dataset.contract.schema, request.nullToken ?? '\\N', '\t', 'ETL TSV');
    return store.publishParsedSource({
      ...request,
      sourceFormat: 'tsv',
      sourceBytes: bytes,
      columns: parsed.columns,
      rows,
    });
  }

  /**
   * Publish rows typed from one exact local file. The store remains the
   * authority for schema/type/coverage validation and the immutable writer;
   * this boundary only re-proves the complete rowset receipt.
   */
  function ingestLocalFileRows(request: AnalyticsLocalFileRowsIngestRequest): AnalyticsVersionPromotionReceipt {
    const complete = request.complete;
    if (request.sourceReceipt.sourceKind !== 'import'
      || request.sourceReceipt.producerVersion !== ANALYTICS_LOCAL_FILE_PARSER_VERSION
      || request.sourceReceipt.sourceId !== complete?.inputSha256) {
      throw new AnalyticsDataRoomError('invalid_input', 'Local-file ingestion requires an exact import source receipt bound to the file SHA.');
    }
    if (!complete || complete.completeToEof !== true
      || complete.parserVersion !== ANALYTICS_LOCAL_FILE_PARSER_VERSION
      || !['csv', 'tsv', 'xlsx'].includes(complete.format)
      || !['new_dataset', 'replace', 'merge_partitions'].includes(complete.mode)
      || !SHA256_RE.test(complete.inputSha256)
      || !SHA256_RE.test(complete.rowsetSha256)
      || !SHA256_RE.test(complete.schemaSha256)
      || !Number.isSafeInteger(complete.inputBytes) || complete.inputBytes < 1
      || !Number.isSafeInteger(complete.rowCount) || complete.rowCount !== request.rows.length) {
      return incomplete('Local-file rows lack a complete parser/rowset/schema receipt.');
    }
    const dataset = store.getDataset(request.datasetId);
    if (!dataset) throw new AnalyticsDataRoomError('not_found', `Dataset ${request.datasetId} was not found.`);
    if (dataset.kind !== 'source' || dataset.sourceKind !== 'import' || dataset.sourceFormat !== 'canonical_json') {
      throw new AnalyticsDataRoomError('invalid_input', 'Local-file rows require a file-born import/canonical_json source dataset.');
    }
    if (complete.schemaSha256 !== dataset.contract.schemaSha256) {
      throw new AnalyticsDataRoomError('invalid_input', 'Local-file schema receipt differs from the dataset contract.');
    }
    const rowsetSha256 = analyticsSha256({ columns: request.columns, rows: request.rows, rowCount: request.rows.length });
    if (rowsetSha256 !== complete.rowsetSha256) {
      throw new AnalyticsDataRoomError('integrity_failed', 'Local-file rowset differs from its complete parser receipt.');
    }
    const sourceBytes = Buffer.from(`${stableAnalyticsJson({
      format: 'botboy-canonical-local-file-rows-v1',
      complete,
      columns: request.columns,
      rows: request.rows,
      rowCount: request.rows.length,
    })}\n`, 'utf8');
    if (sourceBytes.length > MAX_LOCAL_FILE_CANONICAL_BYTES) {
      incomplete('Canonical local-file rows exceed the 32 MiB immutable-source limit. Split the file into smaller datasets.');
    }
    const { complete: _complete, ...ingest } = request;
    return store.publishParsedSource({
      ...ingest,
      sourceFormat: 'canonical_json',
      sourceBytes,
      columns: request.columns,
      rows: request.rows,
    });
  }

  function ingestSqlRows(request: AnalyticsSqlRowsIngestRequest): AnalyticsVersionPromotionReceipt {
    if (request.sourceReceipt.sourceKind !== 'sql_context') {
      throw new AnalyticsDataRoomError('invalid_input', 'SQL ingestion requires a sql_context source receipt.');
    }
    if (request.truncated
      || request.rowCount !== request.displayedRowCount
      || request.rowCount !== request.rows.length) {
      return incomplete('SQL result is truncated or does not contain every reported row. Use a complete structured export or ETL.');
    }
    const sourceBytes = Buffer.from(`${stableAnalyticsJson({
      format: 'botboy-canonical-sql-rows-v1',
      columns: request.columns,
      rows: request.rows,
      rowCount: request.rowCount,
    })}\n`, 'utf8');
    return store.publishParsedSource({
      ...request,
      sourceFormat: 'canonical_json',
      sourceBytes,
      columns: request.columns,
      rows: request.rows,
    });
  }

  function ingestImportRows(request: AnalyticsImportRowsIngestRequest): AnalyticsVersionPromotionReceipt {
    if (request.sourceReceipt.sourceKind !== 'import' || !request.sourceReceipt.sourceId?.trim()) {
      throw new AnalyticsDataRoomError('invalid_input', 'Import ingestion requires an exact import source receipt.');
    }
    const complete = request.complete;
    if (!complete || complete.completeToEof !== true || !complete.parserVersion?.trim()
      || !complete.transformVersion?.trim()
      || complete.transformVersion !== request.sourceReceipt.producerVersion
      || !SHA256_RE.test(complete.inputSha256)
      || !SHA256_RE.test(complete.profileSha256)
      || !SHA256_RE.test(complete.rowsetSha256)
      || !SHA256_RE.test(complete.schemaSha256)
      || !Number.isSafeInteger(request.rowCount)
      || request.rowCount !== request.rows.length) {
      return incomplete('Import rows lack a complete parser/transform/profile/rowset/schema receipt.');
    }
    const dataset = store.getDataset(request.datasetId);
    if (!dataset) throw new AnalyticsDataRoomError('not_found', `Dataset ${request.datasetId} was not found.`);
    if (dataset.sourceKind !== 'import' || dataset.sourceFormat !== 'canonical_json') {
      throw new AnalyticsDataRoomError('invalid_input', 'Import rows require an import/canonical_json dataset definition.');
    }
    if (dataset.definition.adapter !== 'xlsx_import'
      || dataset.definition.adapterVersion !== complete.transformVersion) {
      throw new AnalyticsDataRoomError('invalid_input', 'Import transform receipt differs from the approved dataset definition.');
    }
    if (complete.schemaSha256 !== dataset.contract.schemaSha256) {
      throw new AnalyticsDataRoomError('invalid_input', 'Import schema receipt differs from the approved dataset contract.');
    }
    const rowsetSha256 = analyticsSha256({
      columns: request.columns,
      rows: request.rows,
      rowCount: request.rowCount,
    });
    if (rowsetSha256 !== complete.rowsetSha256) {
      throw new AnalyticsDataRoomError('integrity_failed', 'Import rowset differs from its complete parser receipt.');
    }
    const sourceBytes = Buffer.from(`${stableAnalyticsJson({
      format: 'botboy-canonical-import-rows-v1',
      complete,
      columns: request.columns,
      rows: request.rows,
      rowCount: request.rowCount,
    })}\n`, 'utf8');
    const { complete: _complete, rowCount: _rowCount, ...ingest } = request;
    return store.publishParsedSource({
      ...ingest,
      sourceFormat: 'canonical_json',
      sourceBytes,
      columns: request.columns,
      rows: request.rows,
    });
  }

  return {
    registerDataset: value => store.registerDataset(value),
    reviseDataset: value => store.reviseDataset(value),
    listDependencies: (datasetId, definitionRevision) => store.listDependencies(datasetId, definitionRevision),
    listDatasets: value => store.listDatasets(value?.limit),
    searchDatasets: (query, limit) => store.searchDatasets(query, limit),
    getDataset: datasetId => store.getDataset(datasetId),
    listDatasetVersions: datasetId => store.listDatasetVersions(datasetId),
    getDatasetVersion: versionId => store.getDatasetVersion(versionId),
    listCatalogDatasets: value => store.listCatalogDatasets(value?.limit),
    getCatalogDataset: datasetId => store.getCatalogDataset(datasetId),
    listCatalogDatasetVersions: (datasetId, value) => store.listCatalogDatasetVersions(datasetId, value?.limit),
    getCatalogDatasetVersion: versionId => store.getCatalogDatasetVersion(versionId),
    ingestEtlTsv,
    ingestLocalFileRows,
    ingestSqlRows,
    ingestImportRows,
    backupDataset: (datasetId, targetRoot) => backups.backupDataset(datasetId, targetRoot),
    restoreDatasetBackup: backupDirectory => backups.restoreDatasetBackup(backupDirectory),
  };
}
