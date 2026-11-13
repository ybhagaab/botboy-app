/**
 * Where dashboard and Data Room data came from, kept so no model has to dig for it (docs/maps/analytics.md › "Origins"; owner
 * decision 2026-11-10: "ensure this is not a hidden information & is apparent to models in chat & jobs ... ensure there is ability
 * for a model to read the source completely in its entirety. and keep the original queries please when moving to data room").
 *
 * Three local records, none of them part of an immutable Data Room version:
 *   - etl_run_queries: the SQL of the scratch ETL runs that chat and jobs (mcp_etl_run_query) and dashboard refreshes
 *     (analytics-dashboard.ts › executeRunWidget) submit, by run id; a Data Room dataset's own ETL source keeps its SQL in
 *     its job (analytics_job_nodes). Scratch profiles are
 *     reused, so a run's SQL cannot be read back from the ETL service later.
 *   - data_file_queries: the SQL behind a file a connector wrote into the files workspace (a SQL export).
 *   - analytics_widget_source_history: a widget's earlier sources, written when configure_analytics_widget_source replaces one.
 * A dataset version's origin is derived at read time from the Data Room job that produced it (analytics_job_nodes) plus these
 * records, so nothing is copied into the version.
 */
import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type WidgetSourceKind = 'warehouse_sql' | 'data_room_query';

/** One earlier source of a widget, newest first when listed. */
export interface WidgetSourceRecord {
  kind: WidgetSourceKind;
  sql?: string;
  preset?: string;
  datasetId?: string;
  versionId?: string;
  /** The widget's revision while it had this source. */
  widgetRevision?: number;
  /** When the source was replaced (ISO), or the refresh it was recovered from ran. */
  replacedAt: string;
  replacedByKind?: string;
  /** Recovered from this refresh's record (widgets moved to the Data Room before BotBoy kept sources). */
  recoveredFromRunId?: string;
}

/** The query behind one source of a dataset version. */
export interface DataOriginQuery {
  sql: string;
  sha256: string;
  chars: number;
  /** dataset_source: the source carried its own SQL; etl_run: recorded when BotBoy submitted the run; export: a connector export. */
  recordedFrom: 'dataset_source' | 'etl_run' | 'export';
}

/** One source of a dataset version. */
export interface DataOriginSource {
  alias?: string;
  /** local_file | sql_query | etl_query | existing_version | import_inbox | botboy_csv | unknown */
  kind: string;
  /** Files-workspace path of an imported file. */
  file?: string;
  etlRunId?: string;
  query?: DataOriginQuery;
  /** Why no query is known for this source. */
  queryMissing?: string;
  inputDatasetId?: string;
  inputVersionId?: string;
}

/** A widget that reads a dataset, with the query it had before (when it moved to the Data Room). */
export interface DatasetReader {
  dashboardId: string;
  dashboardTitle: string;
  dashboardStatus?: string;
  widgetId: string;
  widgetTitle: string;
  /** Read through a managed dataset binding rather than its own data_room_query source. */
  binding?: true;
  originalQuery?: WidgetSourceRecord;
}

export function ensureDataOriginTables(db: Database.Database): void {
  // Never in the way of what sets it up (the tool executor, the dashboard service): without the tables, every record is skipped
  // with a log line and every reader reports nothing.
  try {
    ensureTables(db);
  } catch (error: any) {
    console.warn(`[DataOrigins] could not create the origin tables: ${error?.message ?? error}`);
  }
}

function ensureTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS etl_run_queries (
      run_id TEXT PRIMARY KEY CHECK(run_id GLOB '[0-9]*' AND length(run_id) BETWEEN 1 AND 32),
      sql TEXT NOT NULL,
      sql_sha256 TEXT NOT NULL,
      dataset_date TEXT,
      purpose TEXT,
      job_id TEXT,
      submitted_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS data_file_queries (
      path TEXT PRIMARY KEY,
      server_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      sql TEXT NOT NULL,
      sql_sha256 TEXT NOT NULL,
      recorded_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS analytics_widget_source_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      widget_id TEXT NOT NULL,
      dashboard_id TEXT NOT NULL,
      widget_revision INTEGER,
      kind TEXT NOT NULL CHECK(kind IN ('warehouse_sql','data_room_query')),
      sql TEXT,
      preset TEXT,
      dataset_id TEXT,
      version_id TEXT,
      replaced_at TEXT NOT NULL,
      replaced_by_kind TEXT,
      recovered_from_run_id TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_widget_source_history_widget ON analytics_widget_source_history(widget_id, id);
  `);
}

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const nowIso = () => new Date().toISOString();

/** The SQL of a scratch ETL run BotBoy submitted, recorded at submission (the first record wins: a run id is submitted once). */
export function recordEtlRunQuery(db: Database.Database, input: {
  runId: string; sql: string; jobId?: string; purpose?: string; datasetDate?: string;
}): void {
  const runId = String(input.runId ?? '').trim();
  const sql = String(input.sql ?? '');
  if (!/^\d{1,32}$/.test(runId) || !sql.trim()) return;
  // Never in the run's way: a record that cannot be written is logged, and the run goes on.
  try {
    db.prepare(`INSERT INTO etl_run_queries (run_id, sql, sql_sha256, dataset_date, purpose, job_id, submitted_at)
      VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(run_id) DO NOTHING`)
      .run(runId, sql, sha256(sql), input.datasetDate || null, input.purpose ? input.purpose.slice(0, 300) : null, input.jobId || null, nowIso());
  } catch (error: any) {
    console.warn(`[DataOrigins] could not keep ETL run ${runId}'s SQL: ${error?.message ?? error}`);
  }
}

/**
 * One key per file for data_file_queries: a file inside BotBoy's files workspace is keyed by its path relative to it, so the
 * absolute, `~/` and relative forms a local_file source accepts (analytics-local-file-source.ts) all find the same record. The
 * folder is read per call, like tool-executor.ts › filesWorkspaceNote.
 */
export function fileQueryKey(file: string, filesDir = path.join(os.homedir(), '.personal-productivity-tracker', 'files')): string {
  let raw = String(file ?? '').trim();
  if (raw === '~' || raw.startsWith('~/')) raw = path.join(os.homedir(), raw.slice(1));
  if (!path.isAbsolute(raw)) return path.posix.normalize(raw.split(path.sep).join('/')).replace(/^(?:\.\/)+/, '');
  const inside = (root: string, candidate: string) => {
    const relative = path.relative(root, candidate);
    return relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? relative.split(path.sep).join('/') : undefined;
  };
  const plain = inside(path.resolve(filesDir), path.resolve(raw));
  if (plain) return plain;
  try {
    return inside(fs.realpathSync.native(filesDir), fs.realpathSync.native(raw)) ?? path.resolve(raw);
  } catch {
    return path.resolve(raw);
  }
}

/** The SQL behind a file a connector wrote into the files workspace. A later export to the same path replaces the record. */
export function recordFileQuery(db: Database.Database, input: { path: string; sql: string; serverId: string; toolName: string }): void {
  const given = String(input.path ?? '').trim();
  const sql = String(input.sql ?? '');
  if (!given || !sql.trim()) return;
  const file = fileQueryKey(given);
  try {
    db.prepare(`INSERT INTO data_file_queries (path, server_id, tool_name, sql, sql_sha256, recorded_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(path) DO UPDATE SET server_id = excluded.server_id, tool_name = excluded.tool_name, sql = excluded.sql,
        sql_sha256 = excluded.sql_sha256, recorded_at = excluded.recorded_at`)
      .run(file, input.serverId, input.toolName, sql, sha256(sql), nowIso());
  } catch (error: any) {
    console.warn(`[DataOrigins] could not keep the query behind ${file}: ${error?.message ?? error}`);
  }
}

function etlRunQueryRow(db: Database.Database, runId: string): { sql: string; sql_sha256: string } | undefined {
  try {
    return db.prepare('SELECT sql, sql_sha256 FROM etl_run_queries WHERE run_id = ?').get(runId) as { sql: string; sql_sha256: string } | undefined;
  } catch {
    return undefined;
  }
}

function fileQueryRow(db: Database.Database, file: string): { sql: string; sql_sha256: string } | undefined {
  try {
    return db.prepare('SELECT sql, sql_sha256 FROM data_file_queries WHERE path = ?').get(fileQueryKey(file)) as { sql: string; sql_sha256: string } | undefined;
  } catch {
    return undefined;
  }
}

/**
 * The ETL run a result file came from: `run_<id>` and `adhoc_<id>` are BotBoy's own download names; any other name counts only
 * when it holds exactly one run id that BotBoy itself submitted (a file BotBoy reshaped from that run's result).
 */
export function etlRunIdOfFile(db: Database.Database, file: string): string | undefined {
  const base = path.basename(String(file ?? ''));
  const own = /^(?:run|adhoc)_(\d{6,32})\.[a-z]+(?:\.gz)?$/i.exec(base);
  if (own) return own[1];
  const ids = [...new Set(base.match(/\d{8,32}/g) ?? [])];
  return ids.length === 1 && etlRunQueryRow(db, ids[0]) ? ids[0] : undefined;
}

const queryOf = (sql: string, recordedFrom: DataOriginQuery['recordedFrom'], digest?: string): DataOriginQuery => ({
  sql, sha256: digest || sha256(sql), chars: sql.length, recordedFrom,
});

/**
 * Keeps a widget's source as it was before configure_analytics_widget_source replaced it (call inside the replacing
 * transaction). An unchanged source keeps nothing.
 */
export function recordWidgetSourceChange(db: Database.Database, input: {
  widgetId: string;
  dashboardId: string;
  widgetRevision: number;
  previous: { kind: WidgetSourceKind; sql?: string | null; preset?: string | null; datasetId?: string | null; versionId?: string | null } | null;
  next: { kind: WidgetSourceKind; sql?: string | null; datasetId?: string | null };
}): void {
  const previous = input.previous;
  // A source with no SQL, preset or dataset is nothing to keep; a named preset is the query it ran.
  if (!previous || (!previous.sql?.trim() && !previous.preset?.trim() && !previous.datasetId)) return;
  if (previous.kind === input.next.kind && (previous.sql ?? '') === (input.next.sql ?? '')
    && (previous.datasetId ?? '') === (input.next.datasetId ?? '')) return;
  try {
    db.prepare(`INSERT INTO analytics_widget_source_history
        (widget_id, dashboard_id, widget_revision, kind, sql, preset, dataset_id, version_id, replaced_at, replaced_by_kind)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(input.widgetId, input.dashboardId, input.widgetRevision, previous.kind, previous.sql || null, previous.preset || null,
        previous.datasetId || null, previous.versionId || null, nowIso(), input.next.kind);
  } catch (error: any) {
    // The source change itself goes on; a lost record is logged.
    console.warn(`[DataOrigins] could not keep widget ${input.widgetId}'s earlier source: ${error?.message ?? error}`);
  }
}

function historyRecord(row: any): WidgetSourceRecord {
  return {
    kind: row.kind === 'data_room_query' ? 'data_room_query' : 'warehouse_sql',
    ...(row.sql ? { sql: String(row.sql) } : {}),
    ...(row.preset ? { preset: String(row.preset) } : {}),
    ...(row.dataset_id ? { datasetId: String(row.dataset_id) } : {}),
    ...(row.version_id ? { versionId: String(row.version_id) } : {}),
    ...(row.widget_revision !== null && row.widget_revision !== undefined ? { widgetRevision: Number(row.widget_revision) } : {}),
    replacedAt: String(row.replaced_at),
    ...(row.replaced_by_kind ? { replacedByKind: String(row.replaced_by_kind) } : {}),
    ...(row.recovered_from_run_id ? { recoveredFromRunId: String(row.recovered_from_run_id) } : {}),
  };
}

/** A widget's earlier sources, newest first. */
export function widgetSourceHistory(db: Database.Database, widgetId: string, limit = 5): WidgetSourceRecord[] {
  try {
    return (db.prepare('SELECT * FROM analytics_widget_source_history WHERE widget_id = ? ORDER BY id DESC LIMIT ?')
      .all(widgetId, Math.max(1, Math.min(50, limit))) as any[]).map(historyRecord);
  } catch {
    return [];
  }
}

/** The warehouse query a widget had before it moved to the Data Room: its newest earlier warehouse source. */
export function originalWarehouseQuery(db: Database.Database, widgetId: string): WidgetSourceRecord | undefined {
  return widgetSourceHistory(db, widgetId, 20).find(record => record.kind === 'warehouse_sql' && Boolean(record.sql || record.preset));
}

/**
 * Widgets that moved to the Data Room before BotBoy kept their sources get their last warehouse query back from their refresh
 * history (analytics_run_widgets keeps each run's SQL). Idempotent: a widget with any kept source is left alone. Returns how many
 * widgets got one.
 */
export function backfillWidgetSourceHistory(db: Database.Database): number {
  try {
    const widgets = db.prepare(`SELECT w.id, w.dashboard_id FROM analytics_widgets w
      WHERE json_extract(CASE WHEN json_valid(w.config_json) THEN w.config_json ELSE '{}' END, '$.dataSource.kind') = 'data_room_query'
        AND NOT EXISTS (SELECT 1 FROM analytics_widget_source_history h WHERE h.widget_id = w.id)`).all() as Array<{ id: string; dashboard_id: string }>;
    const lastQuery = db.prepare(`SELECT rw.run_id, rw.sql_query, rw.widget_revision, COALESCE(rw.completed_at, rw.started_at, r.queued_at) AS at
      FROM analytics_run_widgets rw JOIN analytics_runs r ON r.id = rw.run_id
      WHERE rw.widget_id = ? AND rw.sql_query IS NOT NULL AND TRIM(rw.sql_query) != ''
      ORDER BY r.queued_at DESC LIMIT 1`);
    const insert = db.prepare(`INSERT INTO analytics_widget_source_history
        (widget_id, dashboard_id, widget_revision, kind, sql, replaced_at, replaced_by_kind, recovered_from_run_id)
      VALUES (?, ?, ?, 'warehouse_sql', ?, ?, 'data_room_query', ?)`);
    let recovered = 0;
    db.transaction(() => {
      for (const widget of widgets) {
        const row = lastQuery.get(widget.id) as { run_id: string; sql_query: string; widget_revision: number | null; at: string } | undefined;
        if (!row) continue;
        insert.run(widget.id, widget.dashboard_id, row.widget_revision ?? null, row.sql_query, row.at || nowIso(), row.run_id);
        recovered += 1;
      }
    })();
    return recovered;
  } catch {
    // A store without dashboard tables (tests, a fresh install) has nothing to recover.
    return 0;
  }
}

const NO_RUN_QUERY = (runId: string) => `BotBoy has no record of ETL run ${runId}'s SQL: it keeps the SQL of the ETL runs that chat, jobs and dashboard refreshes start, from 2026-11-10 on, and this run is older or was started another way. mcp_etl_job_run with the run id shows the run; its scratch profile may have been reused since, so the profile's current SQL may differ.`;

/** One Data Room job source, with the query behind it when BotBoy knows it. */
function describeSource(db: Database.Database, source: any, checkpointRunId?: string): DataOriginSource {
  const kind = typeof source?.kind === 'string' ? source.kind : 'unknown';
  const alias = typeof source?.alias === 'string' ? source.alias : undefined;
  const base = { ...(alias ? { alias } : {}), kind };
  if (kind === 'sql_query' || kind === 'etl_query') {
    const sql = typeof source.sql === 'string' ? source.sql : '';
    return {
      ...base,
      ...(checkpointRunId ? { etlRunId: checkpointRunId } : {}),
      ...(sql ? { query: queryOf(sql, 'dataset_source') } : { queryMissing: 'The source carried no SQL.' }),
    };
  }
  if (kind === 'local_file' || kind === 'botboy_csv') {
    const file = typeof source.path === 'string' ? source.path
      : typeof source.admitted?.fileName === 'string' ? source.admitted.fileName : undefined;
    const runId = file ? etlRunIdOfFile(db, file) : undefined;
    const ran = runId ? etlRunQueryRow(db, runId) : undefined;
    const exported = !ran && file ? fileQueryRow(db, file) : undefined;
    return {
      ...base,
      ...(file ? { file } : {}),
      ...(runId ? { etlRunId: runId } : {}),
      ...(ran ? { query: queryOf(ran.sql, 'etl_run', ran.sql_sha256) }
        : exported ? { query: queryOf(exported.sql, 'export', exported.sql_sha256) }
          : { queryMissing: runId ? NO_RUN_QUERY(runId) : 'This file did not come from a query BotBoy recorded (an owner file, a download, or a file written in a chat).' }),
    };
  }
  if (kind === 'existing_version') {
    return {
      ...base,
      ...(typeof source.datasetId === 'string' ? { inputDatasetId: source.datasetId } : {}),
      ...(typeof source.versionId === 'string' ? { inputVersionId: source.versionId } : {}),
    };
  }
  return base;
}

/** The sources a dataset version was made from: the Data Room job that published it (empty when BotBoy has no such job). */
export function datasetVersionOrigin(db: Database.Database, versionId: string): DataOriginSource[] {
  try {
    const nodes = db.prepare(`SELECT id, kind, spec_json FROM analytics_job_nodes WHERE output_version_id = ? ORDER BY created_at, id`)
      .all(versionId) as Array<{ id: string; kind: string; spec_json: string }>;
    const checkpoint = db.prepare(`SELECT checkpoint_json FROM analytics_job_node_attempts WHERE node_id = ? AND checkpoint_json IS NOT NULL
      ORDER BY attempt_ordinal DESC LIMIT 1`);
    const parse = (text: string | null | undefined) => { try { return text ? JSON.parse(text) : null; } catch { return null; } };
    const fromSourceNodes = nodes.filter(node => node.kind === 'source_resolution').map(node => {
      const spec = parse(node.spec_json);
      const runId = parse((checkpoint.get(node.id) as { checkpoint_json?: string } | undefined)?.checkpoint_json)?.runId;
      return describeSource(db, spec?.source, typeof runId === 'string' && /^\d{1,32}$/.test(runId) ? runId : undefined);
    });
    if (fromSourceNodes.length) return fromSourceNodes;
    const published = nodes.find(node => node.kind === 'result_publication');
    const sources = parse(published?.spec_json)?.plan?.sources;
    return Array.isArray(sources) ? sources.map(source => describeSource(db, source)) : [];
  } catch {
    return [];
  }
}

/** Widgets that read a dataset (their own data_room_query source, or a managed binding), with the query each had before. */
export function datasetReaders(db: Database.Database, datasetId: string): DatasetReader[] {
  try {
    const rows = db.prepare(`SELECT w.id AS widget_id, w.title AS widget_title, w.position, d.id AS dashboard_id, d.title AS dashboard_title,
        d.status AS dashboard_status,
        EXISTS (SELECT 1 FROM analytics_widget_dataset_bindings b WHERE b.widget_id = w.id AND b.dataset_id = ?) AS bound
      FROM analytics_widgets w JOIN analytics_dashboards d ON d.id = w.dashboard_id
      WHERE (json_extract(CASE WHEN json_valid(w.config_json) THEN w.config_json ELSE '{}' END, '$.dataSource.kind') = 'data_room_query'
          AND json_extract(CASE WHEN json_valid(w.config_json) THEN w.config_json ELSE '{}' END, '$.dataSource.datasetId') = ?)
        OR EXISTS (SELECT 1 FROM analytics_widget_dataset_bindings b WHERE b.widget_id = w.id AND b.dataset_id = ?)
      ORDER BY d.title, w.position`).all(datasetId, datasetId, datasetId) as any[];
    return rows.map(row => {
      const originalQuery = originalWarehouseQuery(db, String(row.widget_id));
      return {
        dashboardId: String(row.dashboard_id),
        dashboardTitle: String(row.dashboard_title ?? ''),
        ...(row.dashboard_status ? { dashboardStatus: String(row.dashboard_status) } : {}),
        widgetId: String(row.widget_id),
        widgetTitle: String(row.widget_title ?? ''),
        ...(Number(row.bound) === 1 ? { binding: true as const } : {}),
        ...(originalQuery ? { originalQuery } : {}),
      };
    });
  } catch {
    return [];
  }
}

/** A query for a model read: complete, or (to keep a many-dataset answer small) its size and digest with how to read it whole. */
function queryForRead(query: DataOriginQuery | undefined, full: boolean, readWith: string): Record<string, unknown> | undefined {
  if (!query) return undefined;
  return full
    ? { sql: query.sql, chars: query.chars, sha256: query.sha256, recordedFrom: query.recordedFrom }
    : { chars: query.chars, sha256: query.sha256, recordedFrom: query.recordedFrom, readWith };
}

/** A widget's earlier SQL for a model read: complete, or its size and digest with how to read it whole. */
function sqlForRead(sql: string, full: boolean, readWith: string): Record<string, unknown> {
  return full ? { sql, chars: sql.length, sha256: sha256(sql) } : { chars: sql.length, sha256: sha256(sql), readWith };
}

/** One line for summaries: where a version's rows came from. */
export function originSummary(sources: DataOriginSource[]): string | undefined {
  if (!sources.length) return undefined;
  return sources.map(source => {
    const where = source.etlRunId ? `ETL run ${source.etlRunId}` : source.file ? `file ${source.file}` : source.kind;
    const query = source.query ? `query kept, ${source.query.chars.toLocaleString('en-US')} chars` : source.inputDatasetId ? `from ${source.inputDatasetId}` : 'no query recorded';
    return `${where} (${source.kind}; ${query})`;
  }).join('; ');
}

/**
 * How to give a dataset newer data, by how it is acquired (analytics-job-service.ts accepts a file as the next version only of a
 * file-born source dataset).
 */
export function addVersionGuidance(dataset: { id: string; kind?: string | null; sourceKind?: string | null; sourceFormat?: string | null }): string {
  if (dataset.kind === 'derived') {
    return 'A derived dataset gets new versions from its own derivation: add versions to its inputs.';
  }
  if (dataset.kind === 'source' && dataset.sourceKind === 'import' && dataset.sourceFormat === 'canonical_json') {
    return `Add a version: get a file with exactly this dataset's columns (re-run the origin query above on the ready lane), call create_data_room_dataset {action:"inspect_local_file", file:{path}}, then {action:"create", ownerRequested:true, plan:{version:1, mode:"dataset_preparation", request:{this card's metric, regime, countingKey, grain and timeZone, with the file's dateRange}, sources:[{kind:"local_file", alias, path, into:{datasetId:"${dataset.id}", mode:"merge_partitions", coverage:{the file's days or months}}}], fragments:[], terminal:{kind:"source", alias}}}. merge_partitions adds or replaces only the file's days or months; mode "replace" makes the file the whole new version. Widgets that read this dataset show the new version at their next refresh (refresh_analytics_dashboard).`;
  }
  return `This dataset is acquired by its own ${dataset.sourceKind || 'source'} adapter, so a file cannot become its next version. Create a new dataset from a file with target, then point the widgets at it with configure_analytics_widget_source.`;
}

/**
 * What a dataset card adds about origin (list_data_room_datasets, analytics-data-room-read.ts): the version's sources with their
 * queries, the widgets that read it with the queries they had before, and how to add a version. `full` returns every query
 * complete; otherwise sizes and digests, with the exact call that reads them whole.
 */
export function describeDatasetOrigin(db: Database.Database, datasetId: string, versionId: string, options: { full: boolean }): Record<string, unknown> {
  const readWith = `list_data_room_datasets {"query":"${datasetId}"} returns every query complete.`;
  let dataset: { kind?: string; source_kind?: string; source_format?: string } | undefined;
  try {
    dataset = db.prepare('SELECT kind, source_kind, source_format FROM analytics_datasets WHERE id = ?').get(datasetId) as typeof dataset;
  } catch {
    dataset = undefined;
  }
  const sources = datasetVersionOrigin(db, versionId);
  const readers = datasetReaders(db, datasetId);
  return {
    origin: {
      versionId,
      sources: sources.map(source => ({
        ...source,
        ...(source.query ? { query: queryForRead(source.query, options.full, readWith) } : {}),
      })),
      ...(sources.length ? {} : { note: 'BotBoy has no record of the job that made this version (it predates Data Room jobs or came from the Import Inbox).' }),
    },
    usedBy: readers.map(reader => ({
      ...reader,
      ...(reader.originalQuery ? {
        originalQuery: {
          kind: reader.originalQuery.kind,
          ...(reader.originalQuery.preset ? { preset: reader.originalQuery.preset } : {}),
          replacedAt: reader.originalQuery.replacedAt,
          ...(reader.originalQuery.recoveredFromRunId ? { recoveredFromRefresh: reader.originalQuery.recoveredFromRunId } : {}),
          ...(reader.originalQuery.sql ? sqlForRead(reader.originalQuery.sql, options.full, readWith) : {}),
        },
      } : {}),
    })),
    addVersion: addVersionGuidance({ id: datasetId, kind: dataset?.kind, sourceKind: dataset?.source_kind, sourceFormat: dataset?.source_format }),
  };
}
