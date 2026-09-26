import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStorage, type StorageLayer } from './storage.js';

const temporaryDirectories: string[] = [];
const storages: StorageLayer[] = [];

afterEach(() => {
  while (storages.length) storages.pop()?.close();
  while (temporaryDirectories.length) fs.rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
});

function createPreR1Database(databasePath: string): void {
  const db = new Database(databasePath);
  db.pragma('foreign_keys = OFF');
  db.exec(`
    CREATE TABLE analytics_dashboards (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      theme TEXT NOT NULL DEFAULT 'executive',
      status TEXT NOT NULL DEFAULT 'draft',
      last_error TEXT,
      last_refreshed_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE analytics_widgets (
      id TEXT PRIMARY KEY,
      dashboard_id TEXT NOT NULL REFERENCES analytics_dashboards(id) ON DELETE CASCADE,
      position INTEGER NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('metric','table','bar','line','text')),
      title TEXT NOT NULL,
      subtitle TEXT NOT NULL DEFAULT '',
      sql_query TEXT,
      preset TEXT,
      config_json TEXT NOT NULL DEFAULT '{}',
      result_json TEXT,
      last_error TEXT,
      last_refreshed_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(dashboard_id, position)
    );
    CREATE TABLE analytics_runs (
      id TEXT PRIMARY KEY,
      dashboard_id TEXT NOT NULL REFERENCES analytics_dashboards(id) ON DELETE CASCADE,
      schedule_id TEXT,
      trigger TEXT NOT NULL CHECK(trigger IN ('manual','scheduled','agent')),
      status TEXT NOT NULL CHECK(status IN ('queued','running','completed','failed','cancelled')),
      widget_count INTEGER NOT NULL DEFAULT 0,
      widgets_completed INTEGER NOT NULL DEFAULT 0,
      widgets_succeeded INTEGER NOT NULL DEFAULT 0,
      current_widget_id TEXT,
      cancel_requested INTEGER NOT NULL DEFAULT 0,
      queued_at TEXT NOT NULL,
      started_at TEXT,
      heartbeat_at TEXT,
      lease_expires_at TEXT,
      worker_id TEXT,
      worker_pid INTEGER,
      error TEXT,
      completed_at TEXT
    );
    CREATE TABLE analytics_run_widgets (
      run_id TEXT NOT NULL REFERENCES analytics_runs(id) ON DELETE CASCADE,
      widget_id TEXT NOT NULL,
      position INTEGER NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('metric','table','bar','line','text')),
      title TEXT NOT NULL,
      sql_query TEXT,
      config_json TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL CHECK(status IN ('queued','running','completed','failed','cancelled')),
      error TEXT,
      started_at TEXT,
      completed_at TEXT,
      PRIMARY KEY (run_id, widget_id),
      UNIQUE (run_id, position)
    );
    CREATE TABLE analytics_late_etl_results (
      run_id TEXT NOT NULL,
      widget_id TEXT NOT NULL,
      external_run_id TEXT NOT NULL UNIQUE,
      definition_sha256 TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'pending',
      remote_status TEXT,
      next_check_at TEXT NOT NULL,
      lease_owner TEXT,
      lease_expires_at TEXT,
      result_path TEXT,
      result_bytes INTEGER,
      result_sha256 TEXT,
      row_count INTEGER,
      receipt_json TEXT,
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT,
      PRIMARY KEY (run_id, widget_id)
    );

    CREATE TABLE dashboard_publishers (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      display_name TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 0,
      config_json TEXT NOT NULL DEFAULT '{}',
      last_error TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE dashboard_publications (
      id TEXT PRIMARY KEY,
      dashboard_id TEXT NOT NULL,
      publisher_id TEXT NOT NULL,
      object_key TEXT NOT NULL,
      url TEXT,
      status TEXT NOT NULL,
      content_sha256 TEXT NOT NULL,
      error TEXT,
      created_at TEXT NOT NULL,
      published_at TEXT
    );
    CREATE TABLE dashboard_share_requests (
      id TEXT PRIMARY KEY,
      dashboard_id TEXT NOT NULL,
      token_sha256 TEXT NOT NULL UNIQUE,
      expires_at TEXT NOT NULL,
      used_at TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE static_artifact_publications (
      id TEXT PRIMARY KEY,
      source_path TEXT NOT NULL,
      slug TEXT NOT NULL,
      manifest_sha256 TEXT NOT NULL,
      manifest_json TEXT NOT NULL,
      total_bytes INTEGER NOT NULL,
      transformations_json TEXT NOT NULL,
      app_name TEXT NOT NULL,
      stage TEXT NOT NULL,
      visibility TEXT NOT NULL,
      url TEXT NOT NULL,
      phase TEXT NOT NULL,
      resource_id TEXT,
      deployed INTEGER NOT NULL DEFAULT 0,
      content_verified INTEGER NOT NULL DEFAULT 0,
      visibility_converged INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deployed_at TEXT,
      published_at TEXT
    );

    INSERT INTO analytics_dashboards
      (id, title, description, theme, status, last_error, last_refreshed_at, created_at, updated_at)
    VALUES ('dash_legacy', 'Legacy dashboard', 'preserve me', 'executive', 'degraded',
      'owner-visible error', '2026-09-18T10:00:00.000Z', '2026-09-01T00:00:00.000Z', '2026-09-18T10:00:00.000Z');
    INSERT INTO dashboard_publishers
      (id, kind, display_name, enabled, config_json, last_error, updated_at)
    VALUES ('legacy-provider', 's3', 'Legacy provider', 0, '{}', NULL, '2026-09-18T10:00:00.000Z');
    INSERT INTO dashboard_publications
      (id, dashboard_id, publisher_id, object_key, url, status, content_sha256, error, created_at, published_at)
    VALUES ('publication_legacy', 'dash_legacy', 'legacy-provider', 'legacy/key.html', NULL,
      'failed', '${'d'.repeat(64)}', 'legacy failure', '2026-09-18T10:00:00.000Z', NULL);
    INSERT INTO dashboard_share_requests
      (id, dashboard_id, token_sha256, expires_at, used_at, created_at)
    VALUES ('share_legacy', 'dash_legacy', '${'e'.repeat(64)}', '2099-01-01T00:00:00.000Z', NULL,
      '2026-09-18T10:00:00.000Z');
    INSERT INTO static_artifact_publications
      (id, source_path, slug, manifest_sha256, manifest_json, total_bytes,
       transformations_json, app_name, stage, visibility, url, phase,
       deployed, content_verified, visibility_converged, created_at, updated_at, published_at)
    VALUES ('static_legacy', '/contained/legacy.html', 'legacy', '${'f'.repeat(64)}', '[]', 10,
      '{}', 'legacy-app', 'beta', 'private', 'https://example.invalid/a/legacy/', 'published',
      1, 1, 1, '2026-09-18T10:00:00.000Z', '2026-09-18T10:00:01.000Z', '2026-09-18T10:00:01.000Z');
    INSERT INTO analytics_widgets
      (id, dashboard_id, position, kind, title, subtitle, sql_query, preset, config_json,
       result_json, last_error, last_refreshed_at, created_at, updated_at)
    VALUES ('widget_legacy', 'dash_legacy', 0, 'table', 'Legacy widget', 'subtitle',
      'SELECT 1', 'preset', '{"x":1}', '{"rows":[[1]]}', 'widget error',
      '2026-09-18T10:00:00.000Z', '2026-09-01T00:00:00.000Z', '2026-09-18T10:00:00.000Z');
    INSERT INTO analytics_runs
      (id, dashboard_id, schedule_id, trigger, status, widget_count, widgets_completed,
       widgets_succeeded, current_widget_id, cancel_requested, queued_at, started_at,
       heartbeat_at, lease_expires_at, worker_id, worker_pid, error, completed_at)
    VALUES ('run_legacy', 'dash_legacy', NULL, 'manual', 'cancelled', 1, 1, 0,
      'widget_legacy', 1, '2026-09-18T09:00:00.000Z', '2026-09-18T09:01:00.000Z',
      '2026-09-18T09:02:00.000Z', NULL, 'worker-old', 42, 'owner cancelled',
      '2026-09-18T09:03:00.000Z');
    INSERT INTO analytics_run_widgets
      (run_id, widget_id, position, kind, title, sql_query, config_json, status,
       error, started_at, completed_at)
    VALUES ('run_legacy', 'widget_legacy', 0, 'table', 'Legacy widget', 'SELECT 1',
      '{"x":1}', 'cancelled', 'owner cancelled', '2026-09-18T09:01:00.000Z',
      '2026-09-18T09:03:00.000Z');
    INSERT INTO analytics_late_etl_results
      (run_id, widget_id, external_run_id, definition_sha256, state, next_check_at,
       receipt_json, created_at, updated_at)
    VALUES ('run_legacy', 'widget_legacy', '12345',
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      'cancelled', '2026-09-18T09:04:00.000Z', '{"submittedAgain":false}',
      '2026-09-18T09:00:00.000Z', '2026-09-18T09:04:00.000Z');
  `);
  db.close();
}

function addLegacyR2AnswerAttempts(databasePath: string): void {
  const db = new Database(databasePath);
  db.pragma('foreign_keys = OFF');
  db.exec(`
    CREATE TABLE analytics_answer_attempts (
      id TEXT PRIMARY KEY,
      request_sha256 TEXT NOT NULL CHECK(length(request_sha256) = 64),
      query_sha256 TEXT NOT NULL CHECK(length(query_sha256) = 64),
      dataset_id TEXT,
      source_decision TEXT NOT NULL CHECK(source_decision IN ('refresh_sql','refresh_etl')),
      source_kind TEXT NOT NULL CHECK(source_kind IN ('sql_context','datanet_etl')),
      status TEXT NOT NULL CHECK(status IN ('running','waiting_remote','completed','failed')),
      remote_run_id TEXT UNIQUE,
      remote_status TEXT,
      result_json TEXT,
      receipt_json TEXT,
      error TEXT,
      next_action TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT
    );
    CREATE UNIQUE INDEX idx_analytics_answer_attempts_active
      ON analytics_answer_attempts(request_sha256, query_sha256)
      WHERE status IN ('running','waiting_remote');

    INSERT INTO analytics_answer_attempts
      (id, request_sha256, query_sha256, source_decision, source_kind, status,
       remote_run_id, remote_status, created_at, updated_at)
    VALUES
      ('answer_checkpointed', '${'a'.repeat(64)}', '${'b'.repeat(64)}',
       'refresh_etl', 'datanet_etl', 'waiting_remote', '7001', 'EXECUTING',
       '2026-09-18T09:00:00.000Z', '2026-09-18T09:01:00.000Z'),
      ('answer_unknown', '${'a'.repeat(64)}', '${'c'.repeat(64)}',
       'refresh_etl', 'datanet_etl', 'running', NULL, NULL,
       '2026-09-18T09:02:00.000Z', '2026-09-18T09:02:00.000Z'),
      ('answer_sql', '${'a'.repeat(64)}', '${'d'.repeat(64)}',
       'refresh_sql', 'sql_context', 'running', NULL, NULL,
       '2026-09-18T09:03:00.000Z', '2026-09-18T09:03:00.000Z');
  `);
  db.close();
}

describe('analytics data-room startup migration', () => {
  it('preserves legacy analytics history while adding empty R5 controls and nullable snapshot identity', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'analytics-r1-migration-'));
    temporaryDirectories.push(directory);
    const databasePath = path.join(directory, 'tracker.db');
    createPreR1Database(databasePath);

    const first = createStorage(databasePath);
    storages.push(first);
    first.initialize();
    const db = first.getDb();

    expect(db.prepare(`
      SELECT id, title, description, status, last_error, last_refreshed_at
      FROM analytics_dashboards WHERE id = 'dash_legacy'
    `).get()).toEqual({
      id: 'dash_legacy',
      title: 'Legacy dashboard',
      description: 'preserve me',
      status: 'degraded',
      last_error: 'owner-visible error',
      last_refreshed_at: '2026-09-18T10:00:00.000Z',
    });
    expect(db.prepare(`
      SELECT id, kind, sql_query, config_json, result_json, last_error, revision
      FROM analytics_widgets WHERE id = 'widget_legacy'
    `).get()).toEqual({
      id: 'widget_legacy',
      kind: 'table',
      sql_query: 'SELECT 1',
      config_json: '{"x":1}',
      result_json: '{"rows":[[1]]}',
      last_error: 'widget error',
      revision: 1,
    });
    expect(db.prepare(`
      SELECT status, cancel_requested, worker_id, worker_pid, error, refresh_scope
      FROM analytics_runs WHERE id = 'run_legacy'
    `).get()).toEqual({
      status: 'cancelled',
      cancel_requested: 1,
      worker_id: 'worker-old',
      worker_pid: 42,
      error: 'owner cancelled',
      refresh_scope: 'full',
    });
    expect(db.prepare(`
      SELECT status, error, started_at, completed_at, widget_revision
      FROM analytics_run_widgets WHERE run_id = 'run_legacy' AND widget_id = 'widget_legacy'
    `).get()).toEqual({
      status: 'cancelled',
      error: 'owner cancelled',
      started_at: '2026-09-18T09:01:00.000Z',
      completed_at: '2026-09-18T09:03:00.000Z',
      widget_revision: 1,
    });
    expect(db.prepare(`
      SELECT external_run_id, state, receipt_json, widget_revision,
        binding_revision, control_revision, dataset_id, dataset_version_id,
        effective_query_sha256
      FROM analytics_late_etl_results
      WHERE run_id = 'run_legacy' AND widget_id = 'widget_legacy'
    `).get()).toEqual({
      external_run_id: '12345',
      state: 'cancelled',
      receipt_json: '{"submittedAgain":false}',
      widget_revision: null,
      binding_revision: null,
      control_revision: null,
      dataset_id: null,
      dataset_version_id: null,
      effective_query_sha256: null,
    });

    const dataRoomTables = [
      'analytics_datasets',
      'analytics_dataset_definition_revisions',
      'analytics_dataset_versions',
      'analytics_dataset_heads',
      'analytics_dataset_assertion_evaluations',
      'analytics_dataset_runs',
      'analytics_answer_attempts',
      'analytics_dataset_dependencies',
      'analytics_derived_runs',
      'analytics_derived_run_inputs',
      'analytics_dataset_version_inputs',
      'analytics_derived_run_assertions',
      'analytics_derived_dirty',
      'analytics_dataset_backups',
      'analytics_dataset_backup_versions',
      'analytics_dataset_restore_receipts',
      'analytics_dataset_dashboard_owners',
      'analytics_widget_binding_revisions',
      'analytics_widget_dataset_bindings',
      'analytics_run_widget_data_room_snapshots',
      'analytics_dashboard_edit_receipts',
      'analytics_dataset_controls',
      'analytics_import_inbox_items',
      'analytics_data_room_state',
    ];
    const tables = new Set((db.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'table'
    `).all() as Array<{ name: string }>).map(row => row.name));
    for (const table of dataRoomTables) expect(tables.has(table), table).toBe(true);
    expect(db.prepare('SELECT COUNT(*) AS count FROM analytics_dataset_controls').get())
      .toEqual({ count: 0 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM analytics_import_inbox_items').get())
      .toEqual({ count: 0 });
    expect(db.prepare('SELECT singleton, revision FROM analytics_data_room_state').get())
      .toEqual({ singleton: 1, revision: 0 });
    const snapshotColumns = new Set((db.prepare(`
      PRAGMA table_info(analytics_run_widget_data_room_snapshots)
    `).all() as Array<{ name: string }>).map(row => row.name));
    for (const column of [
      'control_revision', 'control_definition_sha256', 'control_values_sha256',
      'effective_view_request_json', 'effective_view_request_sha256',
    ]) expect(snapshotColumns.has(column), column).toBe(true);
    expect(db.prepare('SELECT COUNT(*) AS count FROM analytics_widget_dataset_bindings').get())
      .toEqual({ count: 0 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM analytics_widget_binding_revisions').get())
      .toEqual({ count: 0 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM analytics_dataset_dashboard_owners').get())
      .toEqual({ count: 0 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM analytics_run_widget_data_room_snapshots').get())
      .toEqual({ count: 0 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM analytics_dashboard_edit_receipts').get())
      .toEqual({ count: 0 });
    const shareColumns = new Set((db.prepare('PRAGMA table_info(dashboard_share_requests)').all() as Array<{ name: string }>).map(row => row.name));
    const publicationColumns = new Set((db.prepare('PRAGMA table_info(dashboard_publications)').all() as Array<{ name: string }>).map(row => row.name));
    for (const column of ['content_sha256', 'config_sha256', 'manifest_sha256', 'manifest_json']) {
      expect(shareColumns.has(column), `share request ${column}`).toBe(true);
    }
    for (const column of [
      'config_sha256', 'manifest_sha256', 'manifest_json', 'share_request_id',
      'deployed', 'content_verified', 'visibility_converged', 'updated_at',
    ]) {
      expect(publicationColumns.has(column), `publication ${column}`).toBe(true);
    }
    expect(db.prepare(`
      SELECT id, content_sha256, config_sha256, manifest_sha256, manifest_json, used_at
      FROM dashboard_share_requests WHERE id = 'share_legacy'
    `).get()).toEqual({
      id: 'share_legacy', content_sha256: null, config_sha256: null,
      manifest_sha256: null, manifest_json: null, used_at: null,
    });
    expect(db.prepare(`
      SELECT id, content_sha256, config_sha256, manifest_sha256, manifest_json,
        share_request_id, deployed, content_verified, visibility_converged, updated_at, status, error
      FROM dashboard_publications WHERE id = 'publication_legacy'
    `).get()).toEqual({
      id: 'publication_legacy', content_sha256: 'd'.repeat(64), config_sha256: null,
      manifest_sha256: null, manifest_json: null, share_request_id: null,
      deployed: 0, content_verified: 0, visibility_converged: 0,
      updated_at: '2026-09-18T10:00:00.000Z', status: 'failed', error: 'legacy failure',
    });
    const staticColumns = new Set((db.prepare('PRAGMA table_info(static_artifact_publications)').all() as Array<{ name: string }>).map(row => row.name));
    expect(staticColumns.has('mirror_synchronized')).toBe(true);
    expect(db.prepare(`
      SELECT phase, deployed, content_verified, visibility_converged, mirror_synchronized
      FROM static_artifact_publications WHERE id = 'static_legacy'
    `).get()).toEqual({
      phase: 'published', deployed: 1, content_verified: 1,
      visibility_converged: 1, mirror_synchronized: 1,
    });
    expect(db.pragma('quick_check', { simple: true })).toBe('ok');

    first.close();
    storages.pop();
    const second = createStorage(databasePath);
    storages.push(second);
    expect(() => second.initialize()).not.toThrow();
    expect(second.getDb().prepare(`
      SELECT status FROM analytics_run_widgets WHERE run_id = 'run_legacy'
    `).get()).toEqual({ status: 'cancelled' });
    expect(second.getDb().prepare(`
      SELECT COUNT(*) AS count FROM analytics_late_etl_results
    `).get()).toEqual({ count: 1 });
    expect(second.getDb().prepare(`
      SELECT revision FROM analytics_widgets WHERE id = 'widget_legacy'
    `).get()).toEqual({ revision: 1 });
    expect(second.getDb().prepare(`
      SELECT refresh_scope FROM analytics_runs WHERE id = 'run_legacy'
    `).get()).toEqual({ refresh_scope: 'full' });
    expect(second.getDb().prepare(`
      SELECT COUNT(*) AS count FROM analytics_widget_dataset_bindings
    `).get()).toEqual({ count: 0 });
    expect(second.getDb().prepare('SELECT COUNT(*) AS count FROM analytics_dataset_controls').get())
      .toEqual({ count: 0 });
    expect(second.getDb().prepare('SELECT COUNT(*) AS count FROM analytics_import_inbox_items').get())
      .toEqual({ count: 0 });
    expect(second.getDb().prepare('SELECT singleton, revision FROM analytics_data_room_state').get())
      .toEqual({ singleton: 1, revision: 0 });
    expect(second.getDb().prepare(`
      SELECT content_sha256, config_sha256, manifest_sha256, manifest_json
      FROM dashboard_share_requests WHERE id = 'share_legacy'
    `).get()).toEqual({ content_sha256: null, config_sha256: null, manifest_sha256: null, manifest_json: null });
    expect(second.getDb().prepare(`
      SELECT content_sha256, config_sha256, manifest_sha256, manifest_json,
        share_request_id, deployed, content_verified, visibility_converged, updated_at
      FROM dashboard_publications WHERE id = 'publication_legacy'
    `).get()).toEqual({
      content_sha256: 'd'.repeat(64), config_sha256: null, manifest_sha256: null, manifest_json: null,
      share_request_id: null, deployed: 0, content_verified: 0, visibility_converged: 0,
      updated_at: '2026-09-18T10:00:00.000Z',
    });
    expect(second.getDb().prepare(`
      SELECT phase, mirror_synchronized FROM static_artifact_publications WHERE id = 'static_legacy'
    `).get()).toEqual({ phase: 'published', mirror_synchronized: 1 });
    expect(second.getDb().pragma('quick_check', { simple: true })).toBe('ok');
  });

  it('migrates pair-keyed active attempts to one request-owned fail-closed continuation', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'analytics-r2-attempt-migration-'));
    temporaryDirectories.push(directory);
    const databasePath = path.join(directory, 'tracker.db');
    createPreR1Database(databasePath);
    addLegacyR2AnswerAttempts(databasePath);

    const first = createStorage(databasePath);
    storages.push(first);
    first.initialize();
    const db = first.getDb();
    const columns = (db.prepare('PRAGMA table_info(analytics_answer_attempts)').all() as Array<{ name: string }>)
      .map(column => column.name);
    expect(columns).toContain('metric_value_column');

    const attempts = db.prepare(`
      SELECT id, status, remote_run_id, remote_status, query_sha256, metric_value_column, completed_at
      FROM analytics_answer_attempts ORDER BY id
    `).all();
    expect(attempts).toEqual([
      {
        id: 'answer_checkpointed', status: 'waiting_remote', remote_run_id: '7001',
        remote_status: 'SUBMISSION_CONTEXT_UNKNOWN', query_sha256: 'b'.repeat(64),
        metric_value_column: null, completed_at: null,
      },
      {
        id: 'answer_sql', status: 'failed', remote_run_id: null, remote_status: null,
        query_sha256: 'd'.repeat(64), metric_value_column: null,
        completed_at: expect.any(String),
      },
      {
        id: 'answer_unknown', status: 'failed', remote_run_id: null, remote_status: null,
        query_sha256: 'c'.repeat(64), metric_value_column: null,
        completed_at: expect.any(String),
      },
    ]);
    const activeIndex = db.prepare(`
      SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_analytics_answer_attempts_active'
    `).get() as { sql: string };
    expect(activeIndex.sql.replace(/\s+/g, ' ')).toContain('ON analytics_answer_attempts(request_sha256)');
    expect(activeIndex.sql).not.toContain('request_sha256, query_sha256');

    const insertActive = db.prepare(`
      INSERT INTO analytics_answer_attempts
        (id, request_sha256, query_sha256, metric_value_column, source_decision, source_kind,
         status, created_at, updated_at)
      VALUES ('answer_duplicate', ?, ?, 'metric_value', 'refresh_etl', 'datanet_etl',
        'running', '2026-09-18T10:00:00.000Z', '2026-09-18T10:00:00.000Z')
    `);
    expect(() => insertActive.run('a'.repeat(64), 'e'.repeat(64))).toThrow(/UNIQUE constraint failed/);
    expect(() => db.prepare(`
      INSERT INTO analytics_answer_attempts
        (id, request_sha256, query_sha256, metric_value_column, source_decision, source_kind,
         status, created_at, updated_at, completed_at)
      VALUES ('answer_terminal', ?, ?, 'metric_value', 'refresh_sql', 'sql_context',
        'completed', '2026-09-18T10:00:00.000Z', '2026-09-18T10:00:00.000Z', '2026-09-18T10:00:00.000Z')
    `).run('a'.repeat(64), 'f'.repeat(64))).not.toThrow();

    const beforeRestart = db.prepare(`
      SELECT id, status, remote_status, updated_at, completed_at
      FROM analytics_answer_attempts ORDER BY id
    `).all();
    first.close();
    storages.pop();
    const second = createStorage(databasePath);
    storages.push(second);
    second.initialize();
    expect(second.getDb().prepare(`
      SELECT id, status, remote_status, updated_at, completed_at
      FROM analytics_answer_attempts ORDER BY id
    `).all()).toEqual(beforeRestart);
  });
});


describe('analytics dashboard edit receipt migration', () => {
  it('enforces request uniqueness while allowing semantic aliases and explicit-new canonical effects', () => {
    const storage = createStorage(':memory:');
    storages.push(storage);
    storage.initialize();
    const db = storage.getDb();
    const columns = (db.prepare('PRAGMA table_info(analytics_dashboard_edit_receipts)').all() as Array<{ name: string }>).map(row => row.name);
    expect(columns).toEqual([
      'id', 'owner_request_id', 'owner_message_json', 'owner_message_sha256',
      'owner_scope_json', 'owner_scope_sha256', 'request_intent_json',
      'request_intent_sha256', 'intent_version', 'intent_json',
      'intent_sha256', 'action', 'dashboard_id', 'source_widget_ids_json',
      'explicit_new', 'replay_of_receipt_id', 'created_widget_id', 'run_id',
      'effect_version', 'effect_sha256', 'mutation_receipt_json', 'created_at',
      'last_replayed_at',
    ]);
    const insert = db.prepare(`
      INSERT INTO analytics_dashboard_edit_receipts
        (id, owner_request_id, owner_message_json, owner_message_sha256,
         owner_scope_json, owner_scope_sha256, request_intent_json,
         request_intent_sha256, intent_version, intent_json,
         intent_sha256, action, dashboard_id, source_widget_ids_json, explicit_new,
         replay_of_receipt_id, created_widget_id, run_id, effect_version,
         effect_sha256, mutation_receipt_json, created_at)
      VALUES (?, ?, '{}', ?, '{}', ?, '{}', ?, 1, '{}', ?, 'add_from_widget',
        'dash_x', '["widget_x"]', ?, ?, 'widget_created', 'run_created', 1, ?, '{}', ?)
    `);
    const sha = 'a'.repeat(64);
    const now = '2026-09-21T00:00:00.000Z';
    insert.run('aedit_one', 'request-one', sha, sha, sha, sha, 0, null, sha, now);
    expect(() => insert.run('aedit_same_intent', 'request-two', sha, sha, sha, sha, 0, null, sha, now))
      .toThrow(/UNIQUE constraint failed/);
    expect(() => insert.run('aedit_alias', 'request-two', sha, sha, sha, sha, 0, 'aedit_one', sha, now)).not.toThrow();
    expect(() => insert.run('aedit_duplicate_request', 'request-two', sha, sha, sha, 'b'.repeat(64), 1, null, sha, now))
      .toThrow(/UNIQUE constraint failed/);
    expect(() => insert.run('aedit_explicit_one', 'request-three', sha, sha, sha, sha, 1, null, sha, now)).not.toThrow();
    expect(() => insert.run('aedit_explicit_two', 'request-four', sha, sha, sha, sha, 1, null, sha, now)).not.toThrow();
    const ordinaryIndex = db.prepare(`
      SELECT sql FROM sqlite_master
      WHERE type = 'index' AND name = 'idx_analytics_dashboard_edit_receipts_ordinary_intent'
    `).get() as { sql: string };
    expect(ordinaryIndex.sql.replace(/\s+/g, ' ')).toContain('WHERE explicit_new = 0 AND replay_of_receipt_id IS NULL');
    expect(db.prepare('SELECT COUNT(*) AS count FROM analytics_dashboard_edit_receipts').get()).toEqual({ count: 4 });
  });
});