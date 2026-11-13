import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createStorage, type StorageLayer } from './storage.js';
import {
  backfillWidgetSourceHistory,
  datasetReaders,
  datasetVersionOrigin,
  describeDatasetOrigin,
  ensureDataOriginTables,
  etlRunIdOfFile,
  fileQueryKey,
  originalWarehouseQuery,
  originSummary,
  recordEtlRunQuery,
  recordFileQuery,
  recordWidgetSourceChange,
  widgetSourceHistory,
} from './data-origins.js';

/**
 * Owner decision 2026-11-10: where dashboard and Data Room data came from is apparent to models, readable complete, and a widget
 * keeps its original query when it moves to the Data Room. These run against the real schema (storage.initialize), so a wrong
 * column name fails here instead of being swallowed by the readers' fallbacks.
 */
const HASH = 'a'.repeat(64);
const SQL = 'WITH daily AS (SELECT report_date, COUNT(DISTINCT uuid) AS viewers FROM events GROUP BY 1) SELECT * FROM daily';
let nodeCounter = 0;
const hexId = (prefix: string, length: number) => `${prefix}${String(++nodeCounter).padStart(length - prefix.length, '0')}`;

describe('data origins', () => {
  let storage: StorageLayer;
  let db: ReturnType<StorageLayer['getDb']>;
  beforeEach(() => {
    storage = createStorage(':memory:');
    storage.initialize();
    db = storage.getDb();
    db.pragma('foreign_keys = OFF');
    ensureDataOriginTables(db);
  });
  afterEach(() => storage.close());

  function dataset(id: string, input: { kind?: string; sourceKind?: string; sourceFormat?: string } = {}): void {
    db.prepare(`INSERT INTO analytics_datasets (id, name, kind, scope, domain_key, owner_id, lifecycle, source_kind, source_format,
        definition_json, definition_sha256, contract_json, contract_sha256, schema_sha256, retention_json, created_at, updated_at)
      VALUES (?, ?, ?, 'workspace', 'ott', 'local-owner', 'active', ?, ?, '{}', ?, '{}', ?, ?, '{}', datetime('now'), datetime('now'))`)
      .run(id, `Dataset ${id}`, input.kind ?? 'source', input.sourceKind ?? 'import', input.sourceFormat ?? 'canonical_json', HASH, HASH, HASH);
  }

  function sourceNode(versionId: string, source: Record<string, unknown>, checkpoint?: Record<string, unknown>): void {
    const id = hexId('ajn_', 36);
    db.prepare(`INSERT INTO analytics_job_nodes (id, job_id, plan_revision, kind, adapter_version, state, logical_request_sha256, spec_json,
        spec_sha256, output_version_id, created_at, updated_at)
      VALUES (?, 'aj_test', 1, 'source_resolution', 'v1', 'succeeded', ?, ?, ?, ?, datetime('now'), datetime('now'))`)
      .run(id, HASH.replace(/a$/, String(nodeCounter % 10)), JSON.stringify({ nodeKey: 'source', source }), HASH, versionId);
    if (checkpoint) {
      db.prepare(`INSERT INTO analytics_job_node_attempts (id, job_id, node_id, attempt_ordinal, status, checkpoint_json, checkpoint_sha256, started_at)
        VALUES (?, 'aj_test', ?, 1, 'succeeded', ?, ?, datetime('now'))`).run(hexId('aja_', 36), id, JSON.stringify(checkpoint), HASH);
    }
  }

  function widget(id: string, dashboardId: string, input: { sql?: string; dataSource?: Record<string, unknown> } = {}): void {
    db.prepare("INSERT OR IGNORE INTO analytics_dashboards (id, title) VALUES (?, ?)").run(dashboardId, `Board ${dashboardId}`);
    const position = Number((db.prepare('SELECT COUNT(*) AS n FROM analytics_widgets WHERE dashboard_id = ?').get(dashboardId) as any).n);
    db.prepare(`INSERT INTO analytics_widgets (id, dashboard_id, position, kind, title, sql_query, config_json) VALUES (?, ?, ?, 'table', ?, ?, ?)`)
      .run(id, dashboardId, position, `Widget ${id}`, input.sql ?? null, JSON.stringify(input.dataSource ? { dataSource: input.dataSource } : {}));
  }

  it('keeps a scratch run\'s SQL by run id and finds the run behind its result file', () => {
    recordEtlRunQuery(db, { runId: '13231157883', sql: SQL, jobId: 'cj_x', purpose: 'contribution' });
    recordEtlRunQuery(db, { runId: '13231157883', sql: 'SELECT 2' });
    expect(etlRunIdOfFile(db, 'etl-results/adhoc_13231157883.tsv')).toBe('13231157883');
    expect(etlRunIdOfFile(db, 'etl-results/run_13226843259.tsv')).toBe('13226843259');
    // Another name counts only for a run BotBoy submitted, and only when the name holds exactly one run id.
    expect(etlRunIdOfFile(db, 'etl-results/completion_13231157883_snapshot.tsv')).toBe('13231157883');
    expect(etlRunIdOfFile(db, 'etl-results/completion_99999999999_snapshot.tsv')).toBeUndefined();
    expect(etlRunIdOfFile(db, 'exports/13231157883_vs_13231157884.tsv')).toBeUndefined();
    const sources = (() => { dataset('ds_a'); sourceNode('dsv_a', { kind: 'local_file', alias: 'contribution', path: 'etl-results/adhoc_13231157883.tsv' }); return datasetVersionOrigin(db, 'dsv_a'); })();
    expect(sources).toEqual([expect.objectContaining({
      alias: 'contribution', kind: 'local_file', file: 'etl-results/adhoc_13231157883.tsv', etlRunId: '13231157883',
      query: expect.objectContaining({ sql: SQL, chars: SQL.length, recordedFrom: 'etl_run' }),
    })]);
    expect(originSummary(sources)).toBe(`ETL run 13231157883 (local_file; query kept, ${SQL.length} chars)`);
  });

  it('says why a file has no query, and reads SQL and ETL sources from the job itself', () => {
    sourceNode('dsv_b', { kind: 'local_file', alias: 'detail', path: 'etl-results/run_13226843259.tsv' });
    const [missing] = datasetVersionOrigin(db, 'dsv_b');
    expect(missing).toMatchObject({ etlRunId: '13226843259' });
    expect(missing.query).toBeUndefined();
    expect(missing.queryMissing).toContain('BotBoy has no record of ETL run 13226843259');
    sourceNode('dsv_c', { kind: 'local_file', alias: 'owner', path: 'Downloads/sales.xlsx' });
    expect(datasetVersionOrigin(db, 'dsv_c')[0].queryMissing).toContain('did not come from a query BotBoy recorded');
    sourceNode('dsv_d', { kind: 'etl_query', alias: 'monthly', sql: SQL }, { runId: '12981608348', sourceKind: 'etl_query' });
    expect(datasetVersionOrigin(db, 'dsv_d')[0]).toMatchObject({ kind: 'etl_query', etlRunId: '12981608348', query: { sql: SQL, recordedFrom: 'dataset_source' } });
    recordFileQuery(db, { path: 'sql-exports/weekly.csv', sql: SQL, serverId: 'sql-context', toolName: 'export_query' });
    sourceNode('dsv_e', { kind: 'local_file', alias: 'weekly', path: 'sql-exports/weekly.csv' });
    expect(datasetVersionOrigin(db, 'dsv_e')[0].query).toMatchObject({ sql: SQL, recordedFrom: 'export' });
    expect(datasetVersionOrigin(db, 'dsv_none')).toEqual([]);
  });

  it('finds an export\'s query whichever path form the import used', () => {
    // The note on an export names the workspace-relative path; a local_file source also accepts absolute and ~/ paths.
    recordFileQuery(db, { path: 'sql-exports/9-1/exports/daily.csv', sql: SQL, serverId: 'sql-context', toolName: 'export_query' });
    const filesDir = path.join(os.homedir(), '.personal-productivity-tracker', 'files');
    expect(fileQueryKey(path.join(filesDir, 'sql-exports/9-1/exports/daily.csv'))).toBe('sql-exports/9-1/exports/daily.csv');
    expect(fileQueryKey('~/.personal-productivity-tracker/files/sql-exports/9-1/exports/daily.csv')).toBe('sql-exports/9-1/exports/daily.csv');
    expect(fileQueryKey('./sql-exports/9-1/exports/daily.csv')).toBe('sql-exports/9-1/exports/daily.csv');
    expect(fileQueryKey('/tmp/elsewhere/daily.csv')).toBe(path.resolve('/tmp/elsewhere/daily.csv'));
    for (const [versionId, form] of [
      ['dsv_abs', path.join(filesDir, 'sql-exports/9-1/exports/daily.csv')],
      ['dsv_home', '~/.personal-productivity-tracker/files/sql-exports/9-1/exports/daily.csv'],
      ['dsv_dot', './sql-exports/9-1/exports/daily.csv'],
    ] as const) {
      sourceNode(versionId, { kind: 'local_file', alias: 'daily', path: form });
      expect(datasetVersionOrigin(db, versionId)[0].query).toMatchObject({ sql: SQL, recordedFrom: 'export' });
    }
    // A same-named file elsewhere is a different file.
    sourceNode('dsv_other', { kind: 'local_file', alias: 'daily', path: '/tmp/elsewhere/sql-exports/9-1/exports/daily.csv' });
    expect(datasetVersionOrigin(db, 'dsv_other')[0].query).toBeUndefined();
  });

  it('keeps a widget\'s earlier source on a real change only', () => {
    recordWidgetSourceChange(db, {
      widgetId: 'w1', dashboardId: 'd1', widgetRevision: 3,
      previous: { kind: 'warehouse_sql', sql: SQL, preset: 'ott' },
      next: { kind: 'data_room_query', sql: 'SELECT * FROM source.data', datasetId: 'ds_a' },
    });
    recordWidgetSourceChange(db, {
      widgetId: 'w1', dashboardId: 'd1', widgetRevision: 4,
      previous: { kind: 'data_room_query', sql: 'SELECT * FROM source.data', datasetId: 'ds_a' },
      next: { kind: 'data_room_query', sql: 'SELECT * FROM source.data', datasetId: 'ds_a' },
    });
    const history = widgetSourceHistory(db, 'w1');
    expect(history).toEqual([expect.objectContaining({ kind: 'warehouse_sql', sql: SQL, preset: 'ott', widgetRevision: 3, replacedByKind: 'data_room_query' })]);
    expect(originalWarehouseQuery(db, 'w1')?.sql).toBe(SQL);
    expect(originalWarehouseQuery(db, 'w_unknown')).toBeUndefined();
  });

  it('keeps a preset-only earlier source, and nothing for a source with no query at all', () => {
    const next = { kind: 'data_room_query' as const, sql: 'SELECT * FROM source.data', datasetId: 'ds_a' };
    recordWidgetSourceChange(db, { widgetId: 'w_preset', dashboardId: 'd1', widgetRevision: 2, previous: { kind: 'warehouse_sql', sql: null, preset: 'weekly_players' }, next });
    recordWidgetSourceChange(db, { widgetId: 'w_empty', dashboardId: 'd1', widgetRevision: 2, previous: { kind: 'warehouse_sql', sql: '  ', preset: null }, next });
    expect(originalWarehouseQuery(db, 'w_preset')).toMatchObject({ kind: 'warehouse_sql', preset: 'weekly_players', widgetRevision: 2 });
    expect(widgetSourceHistory(db, 'w_empty')).toEqual([]);
  });

  it('recovers the original query of a widget that moved to the Data Room before BotBoy kept it, once', () => {
    widget('w_room', 'd2', { dataSource: { version: 1, kind: 'data_room_query', datasetId: 'ds_a', sql: 'SELECT * FROM source.data' } });
    widget('w_plain', 'd2', { sql: 'SELECT 1' });
    db.prepare("INSERT INTO analytics_runs (id, dashboard_id, trigger, status, queued_at) VALUES ('run_old', 'd2', 'scheduled', 'completed', '2026-11-08T10:00:00Z')").run();
    db.prepare("INSERT INTO analytics_runs (id, dashboard_id, trigger, status, queued_at) VALUES ('run_new', 'd2', 'agent', 'completed', '2026-11-09T07:34:00Z')").run();
    db.prepare("INSERT INTO analytics_run_widgets (run_id, widget_id, position, kind, title, sql_query, status) VALUES ('run_old', 'w_room', 0, 'table', 't', 'SELECT old', 'completed')").run();
    db.prepare("INSERT INTO analytics_run_widgets (run_id, widget_id, position, kind, title, sql_query, status) VALUES ('run_new', 'w_room', 0, 'table', 't', ?, 'failed')").run(SQL);
    expect(backfillWidgetSourceHistory(db)).toBe(1);
    expect(backfillWidgetSourceHistory(db)).toBe(0);
    expect(widgetSourceHistory(db, 'w_room')).toEqual([expect.objectContaining({ kind: 'warehouse_sql', sql: SQL, recoveredFromRunId: 'run_new' })]);
    expect(widgetSourceHistory(db, 'w_plain')).toEqual([]);
  });

  it('puts origin, readers with their original queries, and the add-version steps on a dataset card', () => {
    dataset('ds_room');
    recordEtlRunQuery(db, { runId: '13231188878', sql: SQL });
    sourceNode('dsv_room', { kind: 'local_file', alias: 'weekly', path: 'etl-results/adhoc_13231188878.tsv' });
    widget('w_weekly', 'd3', { dataSource: { version: 1, kind: 'data_room_query', datasetId: 'ds_room', sql: 'SELECT * FROM source.data' } });
    recordWidgetSourceChange(db, {
      widgetId: 'w_weekly', dashboardId: 'd3', widgetRevision: 5,
      previous: { kind: 'warehouse_sql', sql: 'SELECT weekly FROM warehouse' },
      next: { kind: 'data_room_query', sql: 'SELECT * FROM source.data', datasetId: 'ds_room' },
    });
    expect(datasetReaders(db, 'ds_room')).toEqual([expect.objectContaining({ widgetId: 'w_weekly', dashboardId: 'd3', dashboardTitle: 'Board d3' })]);
    const full = describeDatasetOrigin(db, 'ds_room', 'dsv_room', { full: true }) as any;
    expect(full.origin.sources[0]).toMatchObject({ etlRunId: '13231188878', query: { sql: SQL, recordedFrom: 'etl_run' } });
    expect(full.usedBy[0].originalQuery).toMatchObject({ kind: 'warehouse_sql', sql: 'SELECT weekly FROM warehouse' });
    expect(full.addVersion).toContain('into:{datasetId:"ds_room", mode:"merge_partitions"');
    const brief = describeDatasetOrigin(db, 'ds_room', 'dsv_room', { full: false }) as any;
    expect(brief.origin.sources[0].query.sql).toBeUndefined();
    expect(brief.origin.sources[0].query).toMatchObject({ chars: SQL.length, readWith: 'list_data_room_datasets {"query":"ds_room"} returns every query complete.' });
    expect(brief.usedBy[0].originalQuery.sql).toBeUndefined();
    dataset('ds_derived', { kind: 'derived' });
    expect((describeDatasetOrigin(db, 'ds_derived', 'dsv_x', { full: true }) as any).addVersion).toContain('derived dataset');
    dataset('ds_sql', { sourceKind: 'sql_context', sourceFormat: 'tsv' });
    expect((describeDatasetOrigin(db, 'ds_sql', 'dsv_y', { full: true }) as any).addVersion).toContain('own sql_context adapter');
  });
});
