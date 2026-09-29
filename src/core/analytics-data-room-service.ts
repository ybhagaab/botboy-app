import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { analyticsSha256, stableAnalyticsJson } from './analytics-data-room-policy.js';
import {
  AnalyticsDataRoomError,
  type AnalyticsDataRoomStore,
  type AnalyticsParsedSourceIngest,
} from './analytics-data-room-store.js';
import {
  ANALYTICS_LOCAL_FILE_PARSER_VERSION,
  AnalyticsLocalFileError,
  readAnalyticsDelimitedTable,
  typeAnalyticsLocalTable,
  validateAnalyticsNullToken,
} from './analytics-local-file-source.js';
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
  AnalyticsImportRowsIngestRequest,
  AnalyticsQualityAssertionEvaluation,
  AnalyticsSqlRowsIngestRequest,
  AnalyticsVersionIngestContext,
  AnalyticsVersionPromotionReceipt,
} from './analytics-data-room-types.js';
import type { AnalyticsDataRoomBackupService } from './analytics-data-room-backup.js';
import { SQL_EXPORT_MAX_BYTES, type AnalyticsSqlExport } from './analytics-sql-export.js';

const SHA256_RE = /^[a-f0-9]{64}$/;
const MAX_LOCAL_FILE_CANONICAL_BYTES = 32 * 1024 * 1024;

/** One complete sql-context export CSV, verified by the export runner, typed here. */
export interface AnalyticsSqlExportIngestRequest extends AnalyticsVersionIngestContext {
  export: AnalyticsSqlExport;
}

export interface AnalyticsEtlTsvIngestRequest extends AnalyticsVersionIngestContext {
  savedTo: string;
  resultBytes: number;
  resultSha256: string;
  /** Exact cell text meaning null; default '' (Datanet writes null as an empty cell). */
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
  ingestSqlExport(input: AnalyticsSqlExportIngestRequest): AnalyticsVersionPromotionReceipt;
  ingestImportRows(input: AnalyticsImportRowsIngestRequest): AnalyticsVersionPromotionReceipt;
  backupDataset(datasetId: string, targetRoot: string): AnalyticsDatasetBackupReceipt;
  restoreDatasetBackup(backupDirectory: string): AnalyticsDatasetRestoreReceipt;
}

function incomplete(message: string): never {
  throw new AnalyticsDataRoomError('incomplete_source', message);
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
    // Same reader and cell typing as a local-file TSV: columns match the
    // schema by name, omitted trailing fields and empty cells are null unless
    // nullToken names another marker. The raw result stays the source bytes.
    const nullToken = request.nullToken ?? '';
    let typed: { columns: string[]; rows: AnalyticsDataCell[][] };
    try {
      validateAnalyticsNullToken(nullToken, 'tsv', 'etl_query');
      const table = readAnalyticsDelimitedTable({
        format: 'tsv',
        fileName: path.basename(request.savedTo),
        sha256: directSha256,
        size: bytes.length,
        bytes,
      }, 'etl_query');
      typed = typeAnalyticsLocalTable(table, dataset.contract.schema, nullToken, {
        source: 'etl_query',
        schema: 'target.schema',
      }, { withholdValues: !dataset.contract.handling.allowModelContext });
    } catch (error) {
      if (!(error instanceof AnalyticsLocalFileError)) throw error;
      return incomplete(error.issues.map(issue => issue.message).join(' ') || error.message);
    }
    return store.publishParsedSource({
      ...request,
      sourceFormat: 'tsv',
      sourceBytes: bytes,
      columns: typed.columns,
      rows: typed.rows,
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

  /**
   * Publish one complete SQL result exported as CSV. Same reader and cell
   * grammar as a local CSV or Datanet TSV: columns match the schema by name,
   * NULL (an empty field) is null. An empty string exports as "" and reads
   * as null too, the same rule as every delimited source.
   */
  function ingestSqlExport(request: AnalyticsSqlExportIngestRequest): AnalyticsVersionPromotionReceipt {
    if (request.sourceReceipt.sourceKind !== 'sql_context') {
      throw new AnalyticsDataRoomError('invalid_input', 'SQL export ingestion requires a sql_context source receipt.');
    }
    const exported = request.export;
    const bytes = Buffer.from(exported.bytes);
    const directSha256 = createHash('sha256').update(bytes).digest('hex');
    if (exported.format !== 'csv' || bytes.length !== exported.size || directSha256 !== exported.sha256
      || !SHA256_RE.test(exported.sqlSha256) || !Number.isSafeInteger(exported.rowCount) || exported.rowCount < 0) {
      incomplete('SQL export bytes do not match their export receipt.');
    }
    if (bytes.length > SQL_EXPORT_MAX_BYTES) incomplete('SQL export exceeds the 32 MiB complete-source limit.');
    const dataset = store.getDataset(request.datasetId);
    if (!dataset) throw new AnalyticsDataRoomError('not_found', `Dataset ${request.datasetId} was not found.`);
    let typed: { columns: string[]; rows: AnalyticsDataCell[][] };
    try {
      const table = readAnalyticsDelimitedTable({
        format: 'csv',
        fileName: 'sql-export.csv',
        sha256: directSha256,
        size: bytes.length,
        bytes,
      }, 'sql_query');
      if (table.rows.length !== exported.rowCount) {
        incomplete(`SQL export holds ${table.rows.length} rows but its receipt reports ${exported.rowCount}.`);
      }
      if (table.header.join('\0') !== exported.columns.map(column => column.name).join('\0')) {
        incomplete('SQL export header differs from its column receipt.');
      }
      typed = typeAnalyticsLocalTable(table, dataset.contract.schema, '', {
        source: 'sql_query',
        schema: 'target.schema',
      }, { withholdValues: !dataset.contract.handling.allowModelContext, origin: 'query' });
    } catch (error) {
      if (!(error instanceof AnalyticsLocalFileError)) throw error;
      return incomplete(error.issues.map(issue => issue.message).join(' ') || error.message);
    }
    const sourceBytes = Buffer.from(`${stableAnalyticsJson({
      format: 'botboy-canonical-sql-export-rows-v1',
      export: {
        format: exported.format,
        sha256: exported.sha256,
        bytes: exported.size,
        rowCount: exported.rowCount,
        columns: exported.columns,
        sqlSha256: exported.sqlSha256,
      },
      columns: typed.columns,
      rows: typed.rows,
      rowCount: typed.rows.length,
    })}\n`, 'utf8');
    if (sourceBytes.length > MAX_LOCAL_FILE_CANONICAL_BYTES) {
      incomplete('Canonical SQL export rows exceed the 32 MiB immutable-source limit. Aggregate or split the query.');
    }
    const { export: _export, ...ingest } = request;
    return store.publishParsedSource({
      ...ingest,
      sourceFormat: 'canonical_json',
      sourceBytes,
      columns: typed.columns,
      rows: typed.rows,
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
    ingestSqlExport,
    ingestImportRows,
    backupDataset: (datasetId, targetRoot) => backups.backupDataset(datasetId, targetRoot),
    restoreDatasetBackup: backupDirectory => backups.restoreDatasetBackup(backupDirectory),
  };
}
