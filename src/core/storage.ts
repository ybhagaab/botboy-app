import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { listBuiltInMcpProfiles } from './mcp-profiles.js';

const DEFAULT_DB_DIR = path.join(os.homedir(), '.personal-productivity-tracker');
const DEFAULT_DB_PATH = path.join(DEFAULT_DB_DIR, 'tracker.db');

export interface StorageLayer {
  initialize(): void;
  getDb(): Database.Database;
  queueWrite(operation: () => void): void;
  flushQueue(): void;
  close(): void;
}

export function createStorage(dbPath?: string): StorageLayer {
  const resolvedPath = dbPath ?? DEFAULT_DB_PATH;
  let db: Database.Database | null = null;
  const writeQueue: (() => void)[] = [];

  function initialize(): void {
    // Ensure directory exists (skip for :memory:)
    if (resolvedPath !== ':memory:') {
      const dir = path.dirname(resolvedPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    }

    db = new Database(resolvedPath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');

    createSchema(db);
    flushQueue();
  }

  function getDb(): Database.Database {
    if (!db) throw new Error('Storage not initialized. Call initialize() first.');
    return db;
  }

  function queueWrite(operation: () => void): void {
    if (db) {
      try {
        operation();
        return;
      } catch {
        // DB inaccessible — queue for later
      }
    }
    writeQueue.push(operation);
  }

  function flushQueue(): void {
    if (!db || writeQueue.length === 0) return;
    const ops = writeQueue.splice(0);
    for (const op of ops) {
      try {
        op();
      } catch (err) {
        console.error('Failed to flush queued write:', err);
      }
    }
  }

  function close(): void {
    if (db) {
      db.close();
      db = null;
    }
  }

  return { initialize, getDb, queueWrite, flushQueue, close };
}

// ── Schema ──

function createSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS nodes (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'archived')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS work_items (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      source TEXT NOT NULL,
      source_app TEXT,
      title TEXT,
      summary TEXT,
      url TEXT,
      file_path TEXT,
      content_hash TEXT,
      screenshot_path TEXT,
      visual_context TEXT,
      metadata TEXT,
      parsed_text TEXT,
      captured_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS node_work_items (
      node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
      work_item_id TEXT NOT NULL REFERENCES work_items(id),
      assigned_by TEXT NOT NULL DEFAULT 'classifier' CHECK(assigned_by IN ('classifier', 'manual')),
      assigned_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (node_id, work_item_id)
    );

    CREATE TABLE IF NOT EXISTS chat_messages (
      id TEXT PRIMARY KEY,
      role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
      content TEXT NOT NULL,
      actions_performed TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS classification_rules (
      id TEXT PRIMARY KEY,
      rule_text TEXT NOT NULL,
      created_by TEXT NOT NULL DEFAULT 'chat',
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS embedding_config (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS slack_api_config (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS activity_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      level TEXT NOT NULL CHECK(level IN ('info', 'warn', 'error')),
      component TEXT NOT NULL,
      message TEXT NOT NULL,
      metadata TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS dedup_cache (
      content_hash TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      captured_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS local_folders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      path TEXT NOT NULL UNIQUE,
      recursive INTEGER NOT NULL DEFAULT 1,
      include_globs TEXT NOT NULL DEFAULT '[]',
      exclude_globs TEXT NOT NULL DEFAULT '[]',
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    -- Indexes
    CREATE INDEX IF NOT EXISTS idx_work_items_type ON work_items(type);
    CREATE INDEX IF NOT EXISTS idx_work_items_captured_at ON work_items(captured_at);
    CREATE INDEX IF NOT EXISTS idx_work_items_content_hash ON work_items(content_hash);
    -- Capture-time URL dedup and the SharePoint sync's existence checks look
    -- items up by exact url; without this index every URL-carrying capture
    -- walked the table (validated 2026-08-24, sharepoint plan §17 #10).
    CREATE INDEX IF NOT EXISTS idx_work_items_url ON work_items(url);
    CREATE INDEX IF NOT EXISTS idx_node_work_items_node ON node_work_items(node_id);
    CREATE INDEX IF NOT EXISTS idx_node_work_items_item ON node_work_items(work_item_id);
    CREATE INDEX IF NOT EXISTS idx_nodes_status ON nodes(status);
    CREATE INDEX IF NOT EXISTS idx_dedup_cache_expires ON dedup_cache(expires_at);
    CREATE INDEX IF NOT EXISTS idx_chat_messages_created ON chat_messages(created_at);
    CREATE INDEX IF NOT EXISTS idx_local_folders_enabled ON local_folders(enabled);

    -- Phase 2: Processing runs and agent todos
    CREATE TABLE IF NOT EXISTS processing_runs (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'running' CHECK(status IN ('running', 'completed', 'failed')),
      total_items INTEGER NOT NULL DEFAULT 0,
      processed_items INTEGER NOT NULL DEFAULT 0,
      assigned_items INTEGER NOT NULL DEFAULT 0,
      errors TEXT,
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS agent_todos (
      id TEXT PRIMARY KEY,
      work_item_id TEXT REFERENCES work_items(id),
      action TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'in_progress', 'completed', 'failed')),
      result TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_agent_todos_status ON agent_todos(status);
    CREATE INDEX IF NOT EXISTS idx_processing_runs_status ON processing_runs(status);
  `);

  // ── Phase 3: Hierarchy migration (ALTER TABLE safe for SQLite) ──
  migrateHierarchy(db);

  // ── lossless-capture-brain-pipeline migration ──
  migrateLosslessCapture(db);

  // ── personal-relevance migration (engagement, digests, cross-links) ──
  migratePersonalRelevance(db);
  // ── related-projects migration (sibling links between distinct projects) ──
  migrateProjectRelations(db);

  // ── managed MCP + analytical dashboards migration ──
  migrateManagedMcpAndAnalytics(db);

  // ── analytics data room: durable catalog + immutable version metadata ──
  migrateAnalyticsDataRoom(db);

  // ── analytics jobs: durable owner outcomes over immutable Data Room versions ──
  migrateAnalyticsJobs(db);

  // ── guarded workspace catalog + native page layouts migration ──
  migrateWorkspaceControl(db);

  // ── local visual assets + question-directed inspection ledger ──
  migrateVisualInspection(db);

  // ── project HTML artifact discovery/ownership projection ──
  migrateProjectArtifacts(db);

  // ── local provider-reported LLM generation usage (indefinite raw history) ──
  migrateLlmUsage(db);

  // ── local-folder import ledger (resumable imports + big-file review) ──
  migrateLocalFolderImports(db);
}

/**
 * Local-folder import ledger (LOCAL_FOLDER_IMPORT_SAFETY_PLAN.md C2/C8): one
 * row per (watched folder, file path) that a folder import handed to capture,
 * or that waits for the owner (big-file review), was skipped as too large, or
 * was deferred for low disk. Path/size/mtime/outcome only; never content.
 * `origin` keeps capture provenance truthful when a held file is imported
 * later (`import` = found by a folder walk, `live` = a watched change).
 * Owned by `core/local-folder-imports.ts`.
 */
export function migrateLocalFolderImports(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS local_folder_imports (
      folder_id INTEGER NOT NULL,
      path TEXT NOT NULL,
      size INTEGER NOT NULL,
      mtime_ms REAL NOT NULL,
      outcome TEXT NOT NULL CHECK(outcome IN ('imported','needs_review','approved','excluded','too_large','deferred_low_disk')),
      origin TEXT NOT NULL DEFAULT 'import' CHECK(origin IN ('import','live')),
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (folder_id, path)
    );
    CREATE INDEX IF NOT EXISTS idx_local_folder_imports_outcome ON local_folder_imports(folder_id, outcome);
  `);
}

/**
 * Provider-reported generation usage, one row per actual model network send.
 * Rows are intentionally retained indefinitely in v1; the read API selects a
 * bounded window without throwing away history needed by future views.
 */
export function migrateLlmUsage(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS llm_usage_attempts (
      id TEXT PRIMARY KEY,
      operation_id TEXT NOT NULL,
      attempt_ordinal INTEGER NOT NULL CHECK(attempt_ordinal >= 1),
      workload TEXT NOT NULL
        CHECK(workload IN ('interactive','background','system','unattributed')),
      attempt_reason TEXT NOT NULL
        CHECK(attempt_reason IN ('initial','auth_retry','stream_retry','fallback','health_probe')),
      provider TEXT NOT NULL,
      endpoint_key TEXT NOT NULL CHECK(endpoint_key IN ('ecs','ollama')),
      api_mode TEXT NOT NULL,
      model TEXT NOT NULL,
      stream INTEGER NOT NULL CHECK(stream IN (0,1)),
      started_at TEXT NOT NULL,
      completed_at TEXT,
      status TEXT NOT NULL
        CHECK(status IN ('running','completed','partial','failed','interrupted')),
      http_status INTEGER,
      usage_reported INTEGER NOT NULL DEFAULT 0 CHECK(usage_reported IN (0,1)),
      input_tokens INTEGER CHECK(input_tokens IS NULL OR input_tokens >= 0),
      output_tokens INTEGER CHECK(output_tokens IS NULL OR output_tokens >= 0),
      total_tokens INTEGER CHECK(total_tokens IS NULL OR total_tokens >= 0),
      cache_read_tokens INTEGER CHECK(cache_read_tokens IS NULL OR cache_read_tokens >= 0),
      cache_write_tokens INTEGER CHECK(cache_write_tokens IS NULL OR cache_write_tokens >= 0),
      reasoning_tokens INTEGER CHECK(reasoning_tokens IS NULL OR reasoning_tokens >= 0),
      request_bytes INTEGER NOT NULL CHECK(request_bytes >= 0),
      image_count INTEGER NOT NULL DEFAULT 0 CHECK(image_count >= 0),
      error_class TEXT,
      UNIQUE(operation_id, attempt_ordinal)
    );
    CREATE INDEX IF NOT EXISTS idx_llm_usage_started_model
      ON llm_usage_attempts(started_at, model);
    CREATE INDEX IF NOT EXISTS idx_llm_usage_workload_started
      ON llm_usage_attempts(workload, started_at);
  `);
}

/**
 * Local visual evidence registry and restart-safe inspection ledger.
 *
 * This is deliberately separate from work_items: registering or inspecting a
 * visual never creates captured evidence, project events, Today changes, or
 * external writes. Originals are immutable files under the app home; SQLite
 * stores only version pins, producer references, and coverage receipts.
 */
export function migrateVisualInspection(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS visual_assets (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS visual_asset_versions (
      id TEXT PRIMARY KEY,
      asset_id TEXT NOT NULL REFERENCES visual_assets(id) ON DELETE RESTRICT,
      ordinal INTEGER NOT NULL CHECK(ordinal >= 1),
      source_sha256 TEXT NOT NULL,
      source_bytes INTEGER NOT NULL CHECK(source_bytes > 0),
      mime TEXT NOT NULL CHECK(mime IN ('image/png','image/jpeg')),
      width INTEGER NOT NULL CHECK(width > 0),
      height INTEGER NOT NULL CHECK(height > 0),
      original_rel_path TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(asset_id, ordinal),
      UNIQUE(asset_id, source_sha256)
    );

    CREATE TABLE IF NOT EXISTS visual_asset_references (
      id TEXT PRIMARY KEY,
      asset_version_id TEXT NOT NULL REFERENCES visual_asset_versions(id) ON DELETE RESTRICT,
      owner_kind TEXT NOT NULL CHECK(owner_kind IN ('chat_attachment','browser_screenshot')),
      owner_id TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      released_at TEXT,
      UNIQUE(owner_kind, owner_id)
    );

    CREATE TABLE IF NOT EXISTS visual_inspection_runs (
      id TEXT PRIMARY KEY,
      request_key TEXT NOT NULL,
      question TEXT NOT NULL,
      owner_request TEXT NOT NULL,
      asset_versions_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','completed','failed')),
      comparison_mode TEXT CHECK(comparison_mode IN ('co_batch','observation_merge')),
      coverage_total INTEGER NOT NULL DEFAULT 0 CHECK(coverage_total >= 0),
      coverage_completed INTEGER NOT NULL DEFAULT 0 CHECK(coverage_completed >= 0),
      provider TEXT,
      model TEXT,
      receipt_json TEXT,
      receipt_sha256 TEXT,
      error TEXT,
      queued_at TEXT NOT NULL DEFAULT (datetime('now')),
      started_at TEXT,
      completed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS visual_inspection_units (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES visual_inspection_runs(id) ON DELETE CASCADE,
      asset_version_id TEXT NOT NULL REFERENCES visual_asset_versions(id) ON DELETE RESTRICT,
      unit_key TEXT NOT NULL,
      unit_kind TEXT NOT NULL CHECK(unit_kind IN ('original','overview','tile')),
      source_x INTEGER NOT NULL DEFAULT 0 CHECK(source_x >= 0),
      source_y INTEGER NOT NULL DEFAULT 0 CHECK(source_y >= 0),
      source_width INTEGER NOT NULL CHECK(source_width > 0),
      source_height INTEGER NOT NULL CHECK(source_height > 0),
      status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','observed','uncertain','unreadable','unsupported','failed','changed','excluded')),
      rendition_rel_path TEXT,
      rendition_sha256 TEXT,
      request_body_bytes INTEGER,
      request_image_chars INTEGER,
      observation_json TEXT,
      observation_sha256 TEXT,
      error TEXT,
      started_at TEXT,
      completed_at TEXT,
      UNIQUE(run_id, unit_key)
    );

    CREATE INDEX IF NOT EXISTS idx_visual_asset_versions_asset
      ON visual_asset_versions(asset_id, ordinal DESC);
    CREATE INDEX IF NOT EXISTS idx_visual_asset_versions_sha
      ON visual_asset_versions(source_sha256);
    CREATE INDEX IF NOT EXISTS idx_visual_asset_references_owner
      ON visual_asset_references(owner_kind, owner_id);
    CREATE INDEX IF NOT EXISTS idx_visual_inspection_runs_request
      ON visual_inspection_runs(request_key, queued_at DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_visual_inspection_runs_active_request
      ON visual_inspection_runs(request_key)
      WHERE status IN ('queued','running');
    CREATE INDEX IF NOT EXISTS idx_visual_inspection_units_run_status
      ON visual_inspection_units(run_id, status);
  `);

  // A process died mid-call: preserve completed unit receipts and make the run
  // resumable. The next identical composite call owns continuation.
  db.exec(`
    UPDATE visual_inspection_runs
    SET status = 'failed', error = 'Stale queued inspection expired before execution', completed_at = datetime('now')
    WHERE status = 'queued' AND queued_at < datetime('now', '-24 hours');
    UPDATE visual_inspection_units
    SET status = 'queued', error = 'Interrupted before a terminal receipt', started_at = NULL
    WHERE status = 'running';
    UPDATE visual_inspection_runs
    SET status = 'queued', error = 'Interrupted; resume required', started_at = NULL
    WHERE status = 'running';
  `);
}

/**
 * Guarded control-plane state for canonical areas/projects and declarative
 * BotBoy-native page layouts. Existing organizer-created rows remain unlocked;
 * owner/agent writes claim the corresponding lock through workspace-catalog.
 */
export function migrateWorkspaceControl(db: Database.Database): void {
  const areaCols = new Set(
    (db.prepare('PRAGMA table_info(areas)').all() as { name: string }[]).map((column) => column.name),
  );
  const addAreaColumn = (name: string, ddl: string): void => {
    if (!areaCols.has(name)) {
      db.exec(`ALTER TABLE areas ADD COLUMN ${ddl}`);
      areaCols.add(name);
    }
  };
  addAreaColumn('status', "status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','archived'))");
  addAreaColumn('owner_managed', 'owner_managed INTEGER NOT NULL DEFAULT 0 CHECK(owner_managed IN (0,1))');
  addAreaColumn('version', 'version INTEGER NOT NULL DEFAULT 1 CHECK(version >= 1)');
  addAreaColumn('archived_at', 'archived_at TEXT');

  const projectCols = new Set(
    (db.prepare('PRAGMA table_info(projects)').all() as { name: string }[]).map((column) => column.name),
  );
  const addProjectColumn = (name: string, ddl: string): void => {
    if (!projectCols.has(name)) {
      db.exec(`ALTER TABLE projects ADD COLUMN ${ddl}`);
      projectCols.add(name);
    }
  };
  addProjectColumn('placement_locked', 'placement_locked INTEGER NOT NULL DEFAULT 0 CHECK(placement_locked IN (0,1))');
  addProjectColumn('version', 'version INTEGER NOT NULL DEFAULT 1 CHECK(version >= 1)');
  addProjectColumn('archived_at', 'archived_at TEXT');
  // Founding scope: the title the project was created with. Routing validates
  // evidence against this immutable anchor so later title/summary drift (or a
  // contaminated brain) can never widen what the project attracts. Backfilled
  // from the current title for pre-existing rows.
  addProjectColumn('founding_scope', 'founding_scope TEXT');
  db.exec("UPDATE projects SET founding_scope = title WHERE founding_scope IS NULL OR trim(founding_scope) = ''");

  db.exec(`
    CREATE TABLE IF NOT EXISTS workspace_entity_events (
      id TEXT PRIMARY KEY,
      entity_type TEXT NOT NULL CHECK(entity_type IN ('area','project')),
      entity_id TEXT NOT NULL,
      action TEXT NOT NULL,
      actor TEXT NOT NULL CHECK(actor IN ('agent','ui','system')),
      command_id TEXT,
      before_json TEXT,
      after_json TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_workspace_entity_events_entity
      ON workspace_entity_events(entity_type, entity_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_workspace_entity_events_command
      ON workspace_entity_events(command_id) WHERE command_id IS NOT NULL;

    CREATE TABLE IF NOT EXISTS page_layouts (
      scope_type TEXT NOT NULL CHECK(scope_type IN ('area','project')),
      scope_id TEXT NOT NULL,
      template TEXT NOT NULL CHECK(template IN ('roadmap','portfolio_board')),
      schema_version INTEGER NOT NULL DEFAULT 1 CHECK(schema_version = 1),
      config_json TEXT NOT NULL DEFAULT '{}',
      version INTEGER NOT NULL DEFAULT 1 CHECK(version >= 1),
      updated_by TEXT NOT NULL DEFAULT 'ui',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (scope_type, scope_id)
    );
    CREATE INDEX IF NOT EXISTS idx_page_layouts_updated
      ON page_layouts(updated_at);

    CREATE INDEX IF NOT EXISTS idx_areas_status
      ON areas(status, updated_at);
    CREATE INDEX IF NOT EXISTS idx_areas_owner_managed
      ON areas(owner_managed);
    CREATE INDEX IF NOT EXISTS idx_projects_placement_locked
      ON projects(placement_locked);
  `);

  db.prepare("UPDATE areas SET status = 'active' WHERE status IS NULL OR status NOT IN ('active','archived')").run();
  db.prepare("UPDATE projects SET archived_at = COALESCE(archived_at, updated_at) WHERE status = 'archived' AND archived_at IS NULL").run();
}

/**
 * Durable state for native MCP processes and analytical dashboards. Secrets
 * never enter SQLite; mcp_servers.config_json contains only non-sensitive
 * connection settings and direct-auth passwords live in macOS Keychain.
 */
export function migrateManagedMcpAndAnalytics(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS mcp_servers (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      display_name TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 0,
      config_json TEXT NOT NULL DEFAULT '{}',
      state TEXT NOT NULL DEFAULT 'stopped'
        CHECK(state IN ('needs_configuration','stopped','starting','running','degraded','failed')),
      server_version TEXT,
      tools_json TEXT NOT NULL DEFAULT '[]',
      pid INTEGER,
      restart_count INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      last_started_at TEXT,
      last_healthy_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS mcp_tool_calls (
      id TEXT PRIMARY KEY,
      server_id TEXT NOT NULL REFERENCES mcp_servers(id) ON DELETE CASCADE,
      tool_name TEXT NOT NULL,
      risk TEXT NOT NULL CHECK(risk IN ('read','write','publish','unknown')),
      source TEXT NOT NULL DEFAULT 'api',
      arguments_sha256 TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('running','completed','failed','blocked')),
      result_chars INTEGER NOT NULL DEFAULT 0,
      duration_ms INTEGER,
      error TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_mcp_tool_calls_server
      ON mcp_tool_calls(server_id, created_at);

    CREATE TABLE IF NOT EXISTS analytics_dashboards (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      theme TEXT NOT NULL DEFAULT 'executive',
      status TEXT NOT NULL DEFAULT 'draft'
        CHECK(status IN ('draft','ready','refreshing','degraded','archived')),
      last_error TEXT,
      last_refreshed_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS analytics_widgets (
      id TEXT PRIMARY KEY,
      dashboard_id TEXT NOT NULL REFERENCES analytics_dashboards(id) ON DELETE CASCADE,
      position INTEGER NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('metric','table','bar','line','text','visualization')),
      title TEXT NOT NULL,
      subtitle TEXT NOT NULL DEFAULT '',
      sql_query TEXT,
      preset TEXT,
      config_json TEXT NOT NULL DEFAULT '{}',
      result_json TEXT,
      last_error TEXT,
      last_refreshed_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(dashboard_id, position)
    );
    CREATE INDEX IF NOT EXISTS idx_analytics_widgets_dashboard
      ON analytics_widgets(dashboard_id, position);

    CREATE TABLE IF NOT EXISTS analytics_dashboard_projects (
      dashboard_id TEXT NOT NULL REFERENCES analytics_dashboards(id) ON DELETE CASCADE,
      project_id TEXT NOT NULL,
      linked_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (dashboard_id, project_id)
    );

    CREATE TABLE IF NOT EXISTS analytics_schedules (
      id TEXT PRIMARY KEY,
      dashboard_id TEXT NOT NULL UNIQUE REFERENCES analytics_dashboards(id) ON DELETE CASCADE,
      enabled INTEGER NOT NULL DEFAULT 1,
      schedule_kind TEXT NOT NULL DEFAULT 'daily' CHECK(schedule_kind IN ('daily')),
      local_time TEXT NOT NULL,
      timezone TEXT NOT NULL,
      next_run_at TEXT NOT NULL,
      last_run_at TEXT,
      consecutive_failures INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_analytics_schedules_due
      ON analytics_schedules(enabled, next_run_at);

    CREATE TABLE IF NOT EXISTS analytics_runs (
      id TEXT PRIMARY KEY,
      dashboard_id TEXT NOT NULL REFERENCES analytics_dashboards(id) ON DELETE CASCADE,
      schedule_id TEXT REFERENCES analytics_schedules(id) ON DELETE SET NULL,
      trigger TEXT NOT NULL CHECK(trigger IN ('manual','scheduled','agent')),
      status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','completed','failed','cancelled')),
      widget_count INTEGER NOT NULL DEFAULT 0,
      widgets_completed INTEGER NOT NULL DEFAULT 0,
      widgets_succeeded INTEGER NOT NULL DEFAULT 0,
      current_widget_id TEXT,
      cancel_requested INTEGER NOT NULL DEFAULT 0,
      queued_at TEXT NOT NULL DEFAULT (datetime('now')),
      started_at TEXT,
      heartbeat_at TEXT,
      lease_expires_at TEXT,
      worker_id TEXT,
      worker_pid INTEGER,
      error TEXT,
      completed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS dashboard_publishers (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      display_name TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 0,
      config_json TEXT NOT NULL DEFAULT '{}',
      last_error TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS dashboard_publications (
      id TEXT PRIMARY KEY,
      dashboard_id TEXT NOT NULL REFERENCES analytics_dashboards(id) ON DELETE CASCADE,
      publisher_id TEXT NOT NULL REFERENCES dashboard_publishers(id),
      object_key TEXT NOT NULL,
      url TEXT,
      status TEXT NOT NULL CHECK(status IN ('publishing','published','failed')),
      content_sha256 TEXT NOT NULL,
      config_sha256 TEXT CHECK(config_sha256 IS NULL OR length(config_sha256) = 64),
      manifest_sha256 TEXT CHECK(manifest_sha256 IS NULL OR length(manifest_sha256) = 64),
      manifest_json TEXT,
      share_request_id TEXT,
      deployed INTEGER NOT NULL DEFAULT 0 CHECK(deployed IN (0,1)),
      content_verified INTEGER NOT NULL DEFAULT 0 CHECK(content_verified IN (0,1)),
      visibility_converged INTEGER NOT NULL DEFAULT 0 CHECK(visibility_converged IN (0,1)),
      error TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      published_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_dashboard_publications_dashboard
      ON dashboard_publications(dashboard_id, created_at);

    CREATE TABLE IF NOT EXISTS static_artifact_publications (
      id TEXT PRIMARY KEY,
      source_path TEXT NOT NULL,
      slug TEXT NOT NULL,
      manifest_sha256 TEXT NOT NULL,
      manifest_json TEXT NOT NULL,
      total_bytes INTEGER NOT NULL,
      transformations_json TEXT NOT NULL,
      app_name TEXT NOT NULL,
      stage TEXT NOT NULL CHECK(stage IN ('beta','gamma','prod')),
      visibility TEXT NOT NULL CHECK(visibility IN ('everyone','private')),
      url TEXT NOT NULL,
      phase TEXT NOT NULL CHECK(phase IN ('prepared','deploying','deployed','converging','verifying_content','published','failed_pre_deploy','failed_after_deploy')),
      resource_id TEXT,
      deployed INTEGER NOT NULL DEFAULT 0,
      content_verified INTEGER NOT NULL DEFAULT 0,
      visibility_converged INTEGER NOT NULL DEFAULT 0,
      mirror_synchronized INTEGER NOT NULL DEFAULT 1 CHECK(mirror_synchronized IN (0,1)),
      error TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      deployed_at TEXT,
      published_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_static_artifact_publications_lookup
      ON static_artifact_publications(slug, manifest_sha256, stage, visibility, created_at);

    -- Lessons ledger (LESSONS_LEDGER_PLAN.md): BotBoy's experiential
    -- operating rules — proposed by agents, adopted by the owner, rendered
    -- into the analytics knowledge dir as retrieved knowledge. The table is
    -- the ledger of record; lessons/<scope>.md files are projections.
    CREATE TABLE IF NOT EXISTS lessons (
      id TEXT PRIMARY KEY,
      scope TEXT NOT NULL,
      rule TEXT NOT NULL,
      evidence TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'proposed' CHECK(status IN ('proposed','adopted','retired')),
      recurrence_count INTEGER NOT NULL DEFAULT 1,
      provenance TEXT NOT NULL DEFAULT '',
      first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
      adopted_at TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_lessons_scope_status ON lessons(scope, status);

    CREATE TABLE IF NOT EXISTS dashboard_share_requests (
      id TEXT PRIMARY KEY,
      dashboard_id TEXT NOT NULL REFERENCES analytics_dashboards(id) ON DELETE CASCADE,
      token_sha256 TEXT NOT NULL UNIQUE,
      content_sha256 TEXT CHECK(content_sha256 IS NULL OR length(content_sha256) = 64),
      config_sha256 TEXT CHECK(config_sha256 IS NULL OR length(config_sha256) = 64),
      manifest_sha256 TEXT CHECK(manifest_sha256 IS NULL OR length(manifest_sha256) = 64),
      manifest_json TEXT,
      expires_at TEXT NOT NULL,
      used_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  const publicationProvenanceAdditions: Record<string, Array<[string, string]>> = {
    dashboard_share_requests: [
      ['content_sha256', "TEXT CHECK(content_sha256 IS NULL OR length(content_sha256) = 64)"],
      ['config_sha256', "TEXT CHECK(config_sha256 IS NULL OR length(config_sha256) = 64)"],
      ['manifest_sha256', "TEXT CHECK(manifest_sha256 IS NULL OR length(manifest_sha256) = 64)"],
      ['manifest_json', 'TEXT'],
    ],
    dashboard_publications: [
      ['config_sha256', "TEXT CHECK(config_sha256 IS NULL OR length(config_sha256) = 64)"],
      ['manifest_sha256', "TEXT CHECK(manifest_sha256 IS NULL OR length(manifest_sha256) = 64)"],
      ['manifest_json', 'TEXT'],
      ['share_request_id', 'TEXT'],
      ['deployed', 'INTEGER NOT NULL DEFAULT 0 CHECK(deployed IN (0,1))'],
      ['content_verified', 'INTEGER NOT NULL DEFAULT 0 CHECK(content_verified IN (0,1))'],
      ['visibility_converged', 'INTEGER NOT NULL DEFAULT 0 CHECK(visibility_converged IN (0,1))'],
      ['updated_at', "TEXT NOT NULL DEFAULT ''"],
    ],
    static_artifact_publications: [
      ['mirror_synchronized', 'INTEGER NOT NULL DEFAULT 1 CHECK(mirror_synchronized IN (0,1))'],
    ],
  };
  for (const [table, additions] of Object.entries(publicationProvenanceAdditions)) {
    const columns = new Set(
      (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(column => column.name),
    );
    for (const [name, declaration] of additions) {
      if (!columns.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${declaration};`);
    }
  }
  db.prepare("UPDATE dashboard_publications SET updated_at = created_at WHERE updated_at = ''").run();

  // analytics_runs originally allowed only running/completed/failed and made
  // started_at mandatory. Rebuild it transactionally because SQLite cannot
  // alter CHECK constraints in place. Legacy running rows came from the old
  // request-bound executor, so they cannot be resumed safely; preserve their
  // history but mark them failed before the active-run uniqueness constraint
  // is installed. Fresh databases already have the durable shape above.
  const runColumns = new Set(
    (db.prepare('PRAGMA table_info(analytics_runs)').all() as Array<{ name: string }>).map(column => column.name),
  );
  const runTableSql = String((db.prepare(`
    SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'analytics_runs'
  `).get() as { sql?: string } | undefined)?.sql || '');
  const durableRunColumns = [
    'schedule_id', 'widgets_completed', 'current_widget_id', 'queued_at',
    'heartbeat_at', 'lease_expires_at',
  ];
  const needsRunRebuild = durableRunColumns.some(column => !runColumns.has(column))
    || !runTableSql.includes("'queued'");

  if (needsRunRebuild) {
    const interruptedMessage = 'Legacy refresh was interrupted while upgrading to the durable analytics queue';
    db.transaction(() => {
      db.exec(`
        DROP INDEX IF EXISTS idx_analytics_runs_dashboard;
        DROP INDEX IF EXISTS idx_analytics_runs_queue;
        DROP INDEX IF EXISTS idx_analytics_runs_active_dashboard;
        ALTER TABLE analytics_runs RENAME TO analytics_runs_legacy_queue;
        CREATE TABLE analytics_runs (
          id TEXT PRIMARY KEY,
          dashboard_id TEXT NOT NULL REFERENCES analytics_dashboards(id) ON DELETE CASCADE,
          schedule_id TEXT REFERENCES analytics_schedules(id) ON DELETE SET NULL,
          trigger TEXT NOT NULL CHECK(trigger IN ('manual','scheduled','agent')),
          status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','completed','failed')),
          widget_count INTEGER NOT NULL DEFAULT 0,
          widgets_completed INTEGER NOT NULL DEFAULT 0,
          widgets_succeeded INTEGER NOT NULL DEFAULT 0,
          current_widget_id TEXT,
          queued_at TEXT NOT NULL DEFAULT (datetime('now')),
          started_at TEXT,
          heartbeat_at TEXT,
          lease_expires_at TEXT,
          worker_id TEXT,
          worker_pid INTEGER,
          error TEXT,
          completed_at TEXT
        );
      `);
      db.prepare(`
        INSERT INTO analytics_runs
          (id, dashboard_id, schedule_id, trigger, status, widget_count,
           widgets_completed, widgets_succeeded, current_widget_id, queued_at,
           started_at, heartbeat_at, lease_expires_at, error, completed_at)
        SELECT id, dashboard_id, NULL, trigger,
          CASE WHEN status = 'running' THEN 'failed' ELSE status END,
          widget_count,
          CASE WHEN status = 'running'
            THEN MAX(0, MIN(widgets_succeeded, widget_count))
            ELSE widget_count
          END,
          MAX(0, MIN(widgets_succeeded, widget_count)),
          NULL,
          COALESCE(started_at, datetime('now')),
          started_at,
          COALESCE(completed_at, started_at),
          NULL,
          CASE WHEN status = 'running' THEN ? ELSE error END,
          CASE WHEN status = 'running' THEN COALESCE(completed_at, datetime('now')) ELSE completed_at END
        FROM analytics_runs_legacy_queue
      `).run(interruptedMessage);
      db.prepare(`
        UPDATE analytics_dashboards
        SET status = 'degraded', last_error = ?, updated_at = datetime('now')
        WHERE status = 'refreshing' AND id IN (
          SELECT dashboard_id FROM analytics_runs_legacy_queue WHERE status = 'running'
        )
      `).run(interruptedMessage);
      db.exec('DROP TABLE analytics_runs_legacy_queue;');
    })();
  }

  // Chat image attachments (2026-09-05): refs to files in the chat
  // attachments store, JSON array of {id, mime}. NULL = text-only message.
  const chatMessageColumns = new Set(
    (db.prepare('PRAGMA table_info(chat_messages)').all() as Array<{ name: string }>).map(column => column.name),
  );
  if (!chatMessageColumns.has('attachments_json')) db.exec('ALTER TABLE chat_messages ADD COLUMN attachments_json TEXT;');

  const migratedRunColumns = new Set(
    (db.prepare('PRAGMA table_info(analytics_runs)').all() as Array<{ name: string }>).map(column => column.name),
  );
  if (!migratedRunColumns.has('worker_id')) db.exec('ALTER TABLE analytics_runs ADD COLUMN worker_id TEXT;');
  if (!migratedRunColumns.has('worker_pid')) db.exec('ALTER TABLE analytics_runs ADD COLUMN worker_pid INTEGER;');
  if (!migratedRunColumns.has('cancel_requested')) db.exec('ALTER TABLE analytics_runs ADD COLUMN cancel_requested INTEGER NOT NULL DEFAULT 0;');

  // Stop-refresh support (2026-08-27) added a terminal 'cancelled' status to
  // runs and their widget rows. SQLite cannot widen a CHECK in place, so
  // tables whose CHECK predates 'cancelled' are rebuilt with a faithful
  // column-for-column copy — no data munging: running rows stay running (the
  // lease/pid recovery machinery owns them), schedule links are preserved.
  // Pattern: create-new → copy → drop-old → rename, with foreign keys OFF so
  // the child/parent swap never rewrites or enforces mid-transaction.
  const cancelledRunSql = String((db.prepare(`
    SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'analytics_runs'
  `).get() as { sql?: string } | undefined)?.sql || '');
  const cancelledWidgetSql = String((db.prepare(`
    SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'analytics_run_widgets'
  `).get() as { sql?: string } | undefined)?.sql || '');
  const runNeedsCancelRebuild = Boolean(cancelledRunSql) && !cancelledRunSql.includes("'cancelled'");
  // On a fresh database analytics_run_widgets does not exist yet at this
  // point (its CREATE lives in the index block below) — empty sqlite_master
  // text means "nothing to rebuild", not "rebuild".
  const widgetsNeedCancelRebuild = Boolean(cancelledWidgetSql) && !cancelledWidgetSql.includes("'cancelled'");
  if (runNeedsCancelRebuild || widgetsNeedCancelRebuild) {
    db.pragma('foreign_keys = OFF');
    try {
      db.transaction(() => {
        if (runNeedsCancelRebuild) {
          db.exec(`
            DROP INDEX IF EXISTS idx_analytics_runs_dashboard;
            DROP INDEX IF EXISTS idx_analytics_runs_queue;
            DROP INDEX IF EXISTS idx_analytics_runs_active_dashboard;
            CREATE TABLE analytics_runs_cancelable (
              id TEXT PRIMARY KEY,
              dashboard_id TEXT NOT NULL REFERENCES analytics_dashboards(id) ON DELETE CASCADE,
              schedule_id TEXT REFERENCES analytics_schedules(id) ON DELETE SET NULL,
              trigger TEXT NOT NULL CHECK(trigger IN ('manual','scheduled','agent')),
              status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','completed','failed','cancelled')),
              widget_count INTEGER NOT NULL DEFAULT 0,
              widgets_completed INTEGER NOT NULL DEFAULT 0,
              widgets_succeeded INTEGER NOT NULL DEFAULT 0,
              current_widget_id TEXT,
              cancel_requested INTEGER NOT NULL DEFAULT 0,
              queued_at TEXT NOT NULL DEFAULT (datetime('now')),
              started_at TEXT,
              heartbeat_at TEXT,
              lease_expires_at TEXT,
              worker_id TEXT,
              worker_pid INTEGER,
              error TEXT,
              completed_at TEXT
            );
            INSERT INTO analytics_runs_cancelable
              (id, dashboard_id, schedule_id, trigger, status, widget_count,
               widgets_completed, widgets_succeeded, current_widget_id,
               cancel_requested, queued_at, started_at, heartbeat_at,
               lease_expires_at, worker_id, worker_pid, error, completed_at)
            SELECT id, dashboard_id, schedule_id, trigger, status, widget_count,
               widgets_completed, widgets_succeeded, current_widget_id,
               COALESCE(cancel_requested, 0), queued_at, started_at, heartbeat_at,
               lease_expires_at, worker_id, worker_pid, error, completed_at
            FROM analytics_runs;
            DROP TABLE analytics_runs;
            ALTER TABLE analytics_runs_cancelable RENAME TO analytics_runs;
          `);
        }
        if (widgetsNeedCancelRebuild) {
          db.exec(`
            DROP INDEX IF EXISTS idx_analytics_run_widgets_progress;
            CREATE TABLE analytics_run_widgets_cancelable (
              run_id TEXT NOT NULL REFERENCES analytics_runs(id) ON DELETE CASCADE,
              widget_id TEXT NOT NULL,
              position INTEGER NOT NULL,
              kind TEXT NOT NULL CHECK(kind IN ('metric','table','bar','line','text','visualization')),
              title TEXT NOT NULL,
              sql_query TEXT,
              config_json TEXT NOT NULL DEFAULT '{}',
              status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','completed','failed','cancelled')),
              error TEXT,
              started_at TEXT,
              completed_at TEXT,
              PRIMARY KEY (run_id, widget_id),
              UNIQUE (run_id, position)
            );
            INSERT INTO analytics_run_widgets_cancelable
            SELECT run_id, widget_id, position, kind, title, sql_query,
                   config_json, status, error, started_at, completed_at
            FROM analytics_run_widgets;
            DROP TABLE analytics_run_widgets;
            ALTER TABLE analytics_run_widgets_cancelable RENAME TO analytics_run_widgets;
          `);
        }
      })();
    } finally {
      db.pragma('foreign_keys = ON');
    }
  }

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_analytics_runs_dashboard
      ON analytics_runs(dashboard_id, queued_at DESC);
    CREATE INDEX IF NOT EXISTS idx_analytics_runs_queue
      ON analytics_runs(status, queued_at);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_analytics_runs_active_dashboard
      ON analytics_runs(dashboard_id) WHERE status IN ('queued','running');

    CREATE TABLE IF NOT EXISTS analytics_run_widgets (
      run_id TEXT NOT NULL REFERENCES analytics_runs(id) ON DELETE CASCADE,
      widget_id TEXT NOT NULL,
      position INTEGER NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('metric','table','bar','line','text','visualization')),
      title TEXT NOT NULL,
      sql_query TEXT,
      config_json TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','completed','failed','cancelled')),
      error TEXT,
      started_at TEXT,
      completed_at TEXT,
      PRIMARY KEY (run_id, widget_id),
      UNIQUE (run_id, position)
    );
    CREATE INDEX IF NOT EXISTS idx_analytics_run_widgets_progress
      ON analytics_run_widgets(run_id, status, position);
  `);

  // Add the declarative visualization kind without dropping dashboard or run
  // history. SQLite cannot alter CHECK constraints, so rebuild only legacy
  // tables and copy every row inside one transaction.
  const analyticsWidgetsSql = String((db.prepare(`
    SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'analytics_widgets'
  `).get() as { sql?: string } | undefined)?.sql || '');
  const analyticsRunWidgetsSql = String((db.prepare(`
    SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'analytics_run_widgets'
  `).get() as { sql?: string } | undefined)?.sql || '');
  const needsAnalyticsWidgetKindRebuild = !analyticsWidgetsSql.includes("'visualization'");
  const needsAnalyticsRunWidgetKindRebuild = !analyticsRunWidgetsSql.includes("'visualization'");

  if (needsAnalyticsWidgetKindRebuild || needsAnalyticsRunWidgetKindRebuild) {
    db.transaction(() => {
      if (needsAnalyticsWidgetKindRebuild) {
        db.exec(`
          DROP INDEX IF EXISTS idx_analytics_widgets_dashboard;
          ALTER TABLE analytics_widgets RENAME TO analytics_widgets_legacy_kinds;
          CREATE TABLE analytics_widgets (
            id TEXT PRIMARY KEY,
            dashboard_id TEXT NOT NULL REFERENCES analytics_dashboards(id) ON DELETE CASCADE,
            position INTEGER NOT NULL,
            kind TEXT NOT NULL CHECK(kind IN ('metric','table','bar','line','text','visualization')),
            title TEXT NOT NULL,
            subtitle TEXT NOT NULL DEFAULT '',
            sql_query TEXT,
            preset TEXT,
            config_json TEXT NOT NULL DEFAULT '{}',
            result_json TEXT,
            last_error TEXT,
            last_refreshed_at TEXT,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now')),
            UNIQUE(dashboard_id, position)
          );
          INSERT INTO analytics_widgets
            (id, dashboard_id, position, kind, title, subtitle, sql_query, preset,
             config_json, result_json, last_error, last_refreshed_at, created_at, updated_at)
          SELECT id, dashboard_id, position, kind, title, subtitle, sql_query, preset,
             config_json, result_json, last_error, last_refreshed_at, created_at, updated_at
          FROM analytics_widgets_legacy_kinds;
          DROP TABLE analytics_widgets_legacy_kinds;
          CREATE INDEX idx_analytics_widgets_dashboard
            ON analytics_widgets(dashboard_id, position);
        `);
      }
      if (needsAnalyticsRunWidgetKindRebuild) {
        db.exec(`
          DROP INDEX IF EXISTS idx_analytics_run_widgets_progress;
          ALTER TABLE analytics_run_widgets RENAME TO analytics_run_widgets_legacy_kinds;
          CREATE TABLE analytics_run_widgets (
            run_id TEXT NOT NULL REFERENCES analytics_runs(id) ON DELETE CASCADE,
            widget_id TEXT NOT NULL,
            position INTEGER NOT NULL,
            kind TEXT NOT NULL CHECK(kind IN ('metric','table','bar','line','text','visualization')),
            title TEXT NOT NULL,
            sql_query TEXT,
            config_json TEXT NOT NULL DEFAULT '{}',
            status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','completed','failed','cancelled')),
            error TEXT,
            started_at TEXT,
            completed_at TEXT,
            PRIMARY KEY (run_id, widget_id),
            UNIQUE (run_id, position)
          );
          INSERT INTO analytics_run_widgets
            (run_id, widget_id, position, kind, title, sql_query, config_json,
             status, error, started_at, completed_at)
          SELECT run_id, widget_id, position, kind, title, sql_query, config_json,
             status, error, started_at, completed_at
          FROM analytics_run_widgets_legacy_kinds;
          DROP TABLE analytics_run_widgets_legacy_kinds;
          CREATE INDEX idx_analytics_run_widgets_progress
            ON analytics_run_widgets(run_id, status, position);
        `);
      }
    })();
  }

  // Durable analytics lane receipts (2026-09-19 incident): recovery must
  // know which lane already executed a child so it never resubmits the same
  // SQL/ETL attempt after a crash. Add after every legacy table rebuild so
  // old migrations cannot drop the new columns.
  const analyticsRunLaneColumns = new Set(
    (db.prepare('PRAGMA table_info(analytics_runs)').all() as Array<{ name: string }>).map(column => column.name),
  );
  if (!analyticsRunLaneColumns.has('primary_lane')) {
    db.exec("ALTER TABLE analytics_runs ADD COLUMN primary_lane TEXT CHECK(primary_lane IS NULL OR primary_lane IN ('sql-mcp','etl')); ");
  }
  const analyticsRunWidgetLaneColumns = new Set(
    (db.prepare('PRAGMA table_info(analytics_run_widgets)').all() as Array<{ name: string }>).map(column => column.name),
  );
  if (!analyticsRunWidgetLaneColumns.has('last_lane')) {
    db.exec("ALTER TABLE analytics_run_widgets ADD COLUMN last_lane TEXT CHECK(last_lane IS NULL OR last_lane IN ('sql-mcp','etl')); ");
  }

  // Late ETL result journal (2026-09-19): a dashboard widget may outlive the
  // bounded 55-minute foreground poll while its already-submitted Datanet run
  // remains healthy. This separate table survives run finalization and records
  // exactly one remote run → source child binding. It intentionally has no
  // cascading FK: legacy analytics table rebuilds happen above, and stale
  // records must fail closed through explicit source/current checks rather than
  // being silently rebound by a migration.
  db.exec(`
    CREATE TABLE IF NOT EXISTS analytics_late_etl_results (
      run_id TEXT NOT NULL,
      widget_id TEXT NOT NULL,
      external_run_id TEXT NOT NULL UNIQUE,
      definition_sha256 TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'pending'
        CHECK(state IN ('pending','checking','applied','superseded','cancelled','definition_changed','remote_failed')),
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
    CREATE INDEX IF NOT EXISTS idx_analytics_late_etl_due
      ON analytics_late_etl_results(state, next_check_at);
    CREATE INDEX IF NOT EXISTS idx_analytics_late_etl_source
      ON analytics_late_etl_results(run_id, widget_id);
  `);

  // Every registry profile gets one durable state row. Adding a new MCP to
  // the registry seeds it here automatically; commands never enter SQLite.
  const seedMcpServer = db.prepare(`
    INSERT OR IGNORE INTO mcp_servers
      (id, kind, display_name, enabled, config_json, state)
    VALUES (?, ?, ?, 0, ?, 'needs_configuration')
  `);
  for (const profile of listBuiltInMcpProfiles()) {
    seedMcpServer.run(profile.id, profile.kind, profile.displayName, profile.seedConfigJson);
  }
  // Provider portfolio (DASHBOARD_SHARING_PLAN §3): harmony is the phase-1
  // build, sftp is announced but disabled until phase 3.
  db.prepare(`
    INSERT OR IGNORE INTO dashboard_publishers
      (id, kind, display_name, enabled, config_json)
    VALUES ('harmony', 'harmony', 'Amazon Harmony', 0, '{}')
  `).run();
  db.prepare(`
    INSERT OR IGNORE INTO dashboard_publishers
      (id, kind, display_name, enabled, config_json)
    VALUES ('sftp', 'sftp', 'SFTP / static host', 0, '{}')
  `).run();
  db.prepare(`
    INSERT OR IGNORE INTO dashboard_publishers
      (id, kind, display_name, enabled, config_json)
    VALUES ('s3-cloudfront', 's3-cloudfront', 'Amazon S3 + CloudFront', 0, '{}')
  `).run();

  // A process cannot survive an application restart. Clear stale runtime-only
  // state before McpManager starts configured servers again.
  db.prepare(`
    UPDATE mcp_servers
    SET state = CASE WHEN enabled = 1 THEN 'stopped' ELSE state END,
        pid = NULL,
        updated_at = datetime('now')
    WHERE state IN ('starting','running','degraded') OR pid IS NOT NULL
  `).run();
}

/**
 * Migration for the personal-relevance layer.
 *
 * `slack_engagement` is an append-only record of the owner's own engagement
 * events (sent message, @-mention of the owner, owner reaction, thread the
 * owner participates in). Channel tiers, routing gates, and digests derive
 * from it deterministically. Idempotent and non-destructive.
 */
export function migratePersonalRelevance(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS slack_engagement (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      channel_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('sent','mention','reaction','thread')),
      message_ts TEXT NOT NULL DEFAULT '',
      thread_ts TEXT NOT NULL DEFAULT '',
      occurred_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(channel_id, kind, message_ts, thread_ts)
    );
    CREATE INDEX IF NOT EXISTS idx_slack_engagement_channel
      ON slack_engagement(channel_id, occurred_at);
    CREATE INDEX IF NOT EXISTS idx_slack_engagement_thread
      ON slack_engagement(channel_id, thread_ts);

    CREATE TABLE IF NOT EXISTS channel_digests (
      channel_id TEXT PRIMARY KEY,
      channel_name TEXT NOT NULL,
      digest TEXT NOT NULL,
      topics TEXT NOT NULL DEFAULT '[]',
      message_count INTEGER NOT NULL DEFAULT 0,
      window_start TEXT,
      window_end TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS project_cross_links (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      channel_name TEXT NOT NULL,
      topic TEXT NOT NULL,
      evidence_item_id TEXT,
      reason TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(project_id, channel_id, topic)
    );
    CREATE INDEX IF NOT EXISTS idx_project_cross_links_project
      ON project_cross_links(project_id, created_at);

    -- Owner evidence curation: a rejection detaches an item from a project
    -- and permanently forbids routing it back there. The item itself is never
    -- deleted (lossless doctrine) and may still be placed elsewhere.
    CREATE TABLE IF NOT EXISTS work_item_rejections (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
      project_id TEXT NOT NULL,
      rejected_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(work_item_id, project_id)
    );
    CREATE INDEX IF NOT EXISTS idx_work_item_rejections_project
      ON work_item_rejections(project_id, rejected_at);

    -- Owner global discard: "never show this anywhere". The item becomes
    -- terminal noise across every surface; the previous lifecycle is recorded
    -- verbatim so a restore puts it back exactly where it was.
    CREATE TABLE IF NOT EXISTS work_item_discards (
      work_item_id TEXT PRIMARY KEY REFERENCES work_items(id) ON DELETE CASCADE,
      previous_state TEXT NOT NULL,
      previous_project_id TEXT,
      discarded_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // One-time seed from historical captures so engagement tiers do not start
  // cold: the owner's sent messages (direction=sent) and @-mentions of the
  // owner's own user id(s) become engagement rows. Without this, channels the
  // owner actively posts in would be misclassified ambient until the next
  // live engagement event. Guarded by a flag; INSERT OR IGNORE keeps it
  // idempotent regardless.
  const seeded = db.prepare("SELECT 1 FROM app_settings WHERE key = 'relevance.engagement_seeded'").get();
  if (!seeded) {
    db.prepare(`
      INSERT OR IGNORE INTO slack_engagement (channel_id, kind, message_ts, thread_ts, occurred_at)
      SELECT json_extract(metadata, '$.channelId'), 'sent',
             COALESCE(json_extract(metadata, '$.timestamp'), ''),
             COALESCE(json_extract(metadata, '$.threadTs'), ''),
             captured_at
      FROM work_items
      WHERE source = 'slack' AND type = 'slack_message'
        AND json_extract(metadata, '$.direction') = 'sent'
        AND json_extract(metadata, '$.channelId') IS NOT NULL
    `).run();
    const myIds = db.prepare(`
      SELECT DISTINCT json_extract(metadata, '$.userId') AS uid
      FROM work_items
      WHERE source = 'slack' AND type = 'slack_message'
        AND json_extract(metadata, '$.direction') = 'sent'
        AND json_extract(metadata, '$.userId') IS NOT NULL
    `).all() as { uid: string | null }[];
    const seedMentions = db.prepare(`
      INSERT OR IGNORE INTO slack_engagement (channel_id, kind, message_ts, thread_ts, occurred_at)
      SELECT json_extract(metadata, '$.channelId'), 'mention',
             COALESCE(json_extract(metadata, '$.timestamp'), ''),
             COALESCE(json_extract(metadata, '$.threadTs'), ''),
             captured_at
      FROM work_items
      WHERE source = 'slack' AND type = 'slack_message'
        AND json_extract(metadata, '$.channelId') IS NOT NULL
        AND raw_text LIKE ?
    `);
    for (const { uid } of myIds) {
      if (uid) seedMentions.run(`%<@${uid}%`);
    }
    db.prepare("INSERT OR REPLACE INTO app_settings (key, value, updated_at) VALUES ('relevance.engagement_seeded', 'true', ?)")
      .run(Date.now());
  }
}

/**
 * Migration for the lossless-capture-brain-pipeline spec.
 *
 * Adds the columns/tables the lossless evidence plane and the project-brain
 * interpretation plane need. Written to be idempotent and non-destructive
 * (Requirements 2.5, 11.1, 11.4): every `ALTER TABLE` is guarded by a
 * `PRAGMA table_info` check, and every table/index uses `IF NOT EXISTS`.
 */
/**
 * Related projects: deterministic sibling links between DISTINCT projects
 * whose scopes touch (shared distinctive title vocabulary, evidence that
 * anchors both scopes, shared ambient channels). Never membership — purely an
 * annotation so each project page/brain can point at the other. Pairs are
 * stored once with project_a < project_b; `dismissed` is an owner veto that
 * survives recomputes for as long as the pair keeps being detected.
 */
export function migrateProjectRelations(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS project_relations (
      project_a TEXT NOT NULL,
      project_b TEXT NOT NULL,
      score INTEGER NOT NULL,
      reasons TEXT NOT NULL DEFAULT '[]',
      dismissed INTEGER NOT NULL DEFAULT 0,
      detected_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (project_a, project_b)
    );
    CREATE INDEX IF NOT EXISTS idx_project_relations_b
      ON project_relations(project_b);
  `);
}

export function migrateLosslessCapture(db: Database.Database): void {
  // ── work_items: lossless content + processing-state columns ──
  const wiCols = new Set(
    (db.prepare('PRAGMA table_info(work_items)').all() as { name: string }[]).map(c => c.name),
  );
  const addWorkItemColumn = (name: string, ddl: string): void => {
    if (!wiCols.has(name)) {
      db.exec(`ALTER TABLE work_items ADD COLUMN ${ddl}`);
      wiCols.add(name);
    }
  };

  addWorkItemColumn('raw_text', 'raw_text TEXT');
  addWorkItemColumn('content_storage', "content_storage TEXT NOT NULL DEFAULT 'inline'");
  addWorkItemColumn('content_path', 'content_path TEXT');
  addWorkItemColumn('content_sha256', 'content_sha256 TEXT');
  addWorkItemColumn('content_bytes', 'content_bytes INTEGER');
  addWorkItemColumn('original_path', 'original_path TEXT');
  addWorkItemColumn('process_state', "process_state TEXT NOT NULL DEFAULT 'captured'");
  addWorkItemColumn('project_id', 'project_id TEXT');
  addWorkItemColumn('batch_id', 'batch_id TEXT');
  addWorkItemColumn('extraction_kind', 'extraction_kind TEXT');
  addWorkItemColumn('ocr_confidence', 'ocr_confidence REAL');
  addWorkItemColumn('incomplete', 'incomplete INTEGER NOT NULL DEFAULT 0');
  // Scope-integrity flag: JSON {titles, detectedAt} written by the brain pass
  // when an assigned item's evidence anchors multiple independent project
  // scopes. Advisory only — the owner decides placement; synthesis skips it.
  addWorkItemColumn('scope_alert', 'scope_alert TEXT');
  // Evidence gist (2026-09-08, TODAY_CHANGES_PLAN.md): one readable sentence
  // per routed item for the Today changes cards. `gist_kind` ∈
  // derived|verbatim|model|excerpt; a written gist is terminal (the sweeper
  // only visits `gist IS NULL`). Never shown as project truth.
  addWorkItemColumn('gist', 'gist TEXT');
  addWorkItemColumn('gist_kind', 'gist_kind TEXT');
  addWorkItemColumn('gist_at', 'gist_at TEXT');
  // MAX(gist_at) joins the dashboard version composite (one indexed read per poll).
  db.exec('CREATE INDEX IF NOT EXISTS idx_work_items_gist_at ON work_items(gist_at)');

  // ── New tables ──
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','paused','done','archived')),
      one_liner TEXT,
      brain_path TEXT NOT NULL,
      brain_sha256 TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS work_item_project_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
      project_id TEXT,
      recorded_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS item_ocr_lines (
      item_id TEXT NOT NULL REFERENCES work_items(id),
      line_index INTEGER NOT NULL,
      text TEXT NOT NULL,
      confidence REAL,
      PRIMARY KEY (item_id, line_index)
    );

    CREATE TABLE IF NOT EXISTS failures (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      item_id TEXT,
      step TEXT NOT NULL CHECK(step IN ('capture','parse','ocr','route','brain','content','migration')),
      message TEXT NOT NULL,
      retryable INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS pipeline_runs (
      id TEXT PRIMARY KEY,
      pass TEXT NOT NULL CHECK(pass IN ('extract','librarian','brain','reconcile','organize')),
      batch_id TEXT,
      items_in INTEGER NOT NULL DEFAULT 0,
      items_out INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'running' CHECK(status IN ('running','completed','failed')),
      errors TEXT,
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at TEXT
    );

    -- Hashes plus provider/model/prompt version establish which model call
    -- produced a decision without creating a second plaintext secret archive.
    -- Per-item routing reasons are retained separately below.
    -- Durable before-write snapshots make every canonical brain replacement
    -- recoverable. The Markdown is the exact prior on-disk representation;
    -- reason identifies the write path without retaining model plaintext.
    CREATE TABLE IF NOT EXISTS brain_revisions (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      brain_sha256 TEXT NOT NULL,
      markdown TEXT NOT NULL,
      reason TEXT NOT NULL DEFAULT 'brain_write',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS pipeline_llm_audit (
      id TEXT PRIMARY KEY,
      run_id TEXT,
      pass TEXT NOT NULL,
      batch_id TEXT,
      project_id TEXT,
      prompt_version TEXT NOT NULL,
      provider TEXT,
      model TEXT,
      active_endpoint TEXT,
      temperature REAL,
      prompt_sha256 TEXT NOT NULL,
      response_sha256 TEXT,
      status TEXT NOT NULL DEFAULT 'running',
      error TEXT,
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at TEXT
    );

    -- One row per routing outcome records what the model requested, what the
    -- deterministic scope gate actually applied, and when assignment occurred.
    CREATE TABLE IF NOT EXISTS routing_decisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      invocation_id TEXT,
      batch_id TEXT NOT NULL,
      item_id TEXT NOT NULL,
      model_decision TEXT,
      requested_project_id TEXT,
      requested_title TEXT,
      model_reason TEXT,
      applied_decision TEXT NOT NULL,
      applied_project_id TEXT,
      validation_reason TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Indexes for the pipeline hot queries
    CREATE INDEX IF NOT EXISTS idx_work_items_process_state ON work_items(process_state);
    -- Composite for the batcher's extracted+unrouted selection and the
    -- SharePoint drain's pipeline-backlog gate (state + project_id).
    CREATE INDEX IF NOT EXISTS idx_work_items_state_project ON work_items(process_state, project_id);
    -- (pipeline_runs CHECK migration for pre-'organize' databases runs below,
    --  after this exec block — CREATE IF NOT EXISTS never upgrades a live table)
    CREATE INDEX IF NOT EXISTS idx_work_items_project_id ON work_items(project_id);
    CREATE INDEX IF NOT EXISTS idx_work_items_batch_id ON work_items(batch_id);
    CREATE INDEX IF NOT EXISTS idx_work_items_incomplete ON work_items(incomplete);
    CREATE INDEX IF NOT EXISTS idx_projects_status ON projects(status);
    CREATE INDEX IF NOT EXISTS idx_failures_step ON failures(step);
    CREATE INDEX IF NOT EXISTS idx_failures_item ON failures(item_id);
    CREATE INDEX IF NOT EXISTS idx_item_ocr_lines_item ON item_ocr_lines(item_id);
    CREATE INDEX IF NOT EXISTS idx_pipeline_runs_pass ON pipeline_runs(pass);
    CREATE INDEX IF NOT EXISTS idx_pipeline_runs_started ON pipeline_runs(started_at);
    CREATE INDEX IF NOT EXISTS idx_brain_revisions_project ON brain_revisions(project_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_pipeline_llm_audit_run ON pipeline_llm_audit(run_id);
    CREATE INDEX IF NOT EXISTS idx_pipeline_llm_audit_batch ON pipeline_llm_audit(batch_id);
    CREATE INDEX IF NOT EXISTS idx_pipeline_llm_audit_project ON pipeline_llm_audit(project_id);
    CREATE INDEX IF NOT EXISTS idx_routing_decisions_item ON routing_decisions(item_id);
    CREATE INDEX IF NOT EXISTS idx_routing_decisions_batch ON routing_decisions(batch_id);
    CREATE INDEX IF NOT EXISTS idx_work_item_project_events_item ON work_item_project_events(work_item_id, id);
    CREATE INDEX IF NOT EXISTS idx_work_item_project_events_project ON work_item_project_events(project_id, id);

    CREATE TRIGGER IF NOT EXISTS trg_work_item_project_event_insert
    AFTER INSERT ON work_items
    WHEN NEW.project_id IS NOT NULL
    BEGIN
      INSERT INTO work_item_project_events (work_item_id, project_id)
      VALUES (NEW.id, NEW.project_id);
    END;

    CREATE TRIGGER IF NOT EXISTS trg_work_item_project_event_update
    AFTER UPDATE OF project_id ON work_items
    WHEN NEW.project_id IS NOT OLD.project_id
    BEGIN
      INSERT INTO work_item_project_events (work_item_id, project_id)
      VALUES (NEW.id, NEW.project_id);
    END;
  `);

  // Existing assigned rows predate the triggers. Seed one immutable event for
  // each such item; future assignment and unassignment changes are appended by
  // the triggers above, so Today can advance without crossing unresolved rows.
  db.prepare(`
    INSERT INTO work_item_project_events (work_item_id, project_id, recorded_at)
    SELECT work_items.id, work_items.project_id, COALESCE(work_items.created_at, work_items.captured_at)
    FROM work_items
    WHERE work_items.project_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM work_item_project_events
        WHERE work_item_project_events.work_item_id = work_items.id
      )
    ORDER BY work_items.rowid
  `).run();

  // ── Migration: widen pipeline_runs.pass CHECK to include 'organize' ──
  // Databases created before the organizer pass have CHECK(pass IN
  // ('extract','librarian','brain','reconcile')); inserts of 'organize' rows
  // violated it and were silently swallowed, so organizer runs were invisible
  // (post-mortem 2026-08-04: area churn with zero recorded runs). SQLite
  // cannot ALTER a CHECK constraint — rebuild the table once.
  {
    const prSql = (db.prepare(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='pipeline_runs'",
    ).get() as { sql?: string } | undefined)?.sql;
    if (prSql && !prSql.includes("'organize'")) {
      db.exec(`
        BEGIN;
        CREATE TABLE pipeline_runs_new (
          id TEXT PRIMARY KEY,
          pass TEXT NOT NULL CHECK(pass IN ('extract','librarian','brain','reconcile','organize')),
          batch_id TEXT,
          items_in INTEGER NOT NULL DEFAULT 0,
          items_out INTEGER NOT NULL DEFAULT 0,
          status TEXT NOT NULL DEFAULT 'running' CHECK(status IN ('running','completed','failed')),
          errors TEXT,
          started_at TEXT NOT NULL DEFAULT (datetime('now')),
          completed_at TEXT
        );
        INSERT INTO pipeline_runs_new SELECT * FROM pipeline_runs;
        DROP TABLE pipeline_runs;
        ALTER TABLE pipeline_runs_new RENAME TO pipeline_runs;
        CREATE INDEX IF NOT EXISTS idx_pipeline_runs_pass ON pipeline_runs(pass);
        CREATE INDEX IF NOT EXISTS idx_pipeline_runs_started ON pipeline_runs(started_at);
        COMMIT;
      `);
      console.log('✅ Migrated pipeline_runs CHECK to accept organize runs');
    }
  }

  // ── Areas: parent groupings above projects (hierarchy layer) ──
  db.exec(`
    CREATE TABLE IF NOT EXISTS areas (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_areas_updated ON areas(updated_at);
  `);
  // projects.area_id → which area a project rolls up into (nullable).
  {
    const projCols = new Set(
      (db.prepare('PRAGMA table_info(projects)').all() as { name: string }[]).map((c) => c.name),
    );
    if (!projCols.has('area_id')) {
      db.exec('ALTER TABLE projects ADD COLUMN area_id TEXT');
      db.exec('CREATE INDEX IF NOT EXISTS idx_projects_area ON projects(area_id)');
    }
  }

  // ── Full-text search over titles + full content (Requirement 6.4) ──
  // External-content-less FTS5 table: we own the rows explicitly (populated on
  // ingest with the full content, not a prefix). `content=''` keeps it a plain
  // contentless index keyed by rowid = the work item's rowid mapping table.
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS work_items_fts USING fts5(
      item_id UNINDEXED,
      title,
      body,
      tokenize='unicode61'
    );
  `);
}

function migrateHierarchy(db: Database.Database): void {
  // Add parent_id column if not exists
  const nodeColumns = db.prepare("PRAGMA table_info(nodes)").all() as { name: string }[];
  const colNames = nodeColumns.map(c => c.name);

  if (!colNames.includes('parent_id')) {
    db.exec(`ALTER TABLE nodes ADD COLUMN parent_id TEXT REFERENCES nodes(id) ON DELETE SET NULL`);
  }
  if (!colNames.includes('depth')) {
    db.exec(`ALTER TABLE nodes ADD COLUMN depth INTEGER NOT NULL DEFAULT 0`);
  }

  // Indexes for hierarchy queries
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_nodes_parent_id ON nodes(parent_id);
    CREATE INDEX IF NOT EXISTS idx_nodes_depth ON nodes(depth);
  `);

  // Background processing tracking
  db.exec(`
    CREATE TABLE IF NOT EXISTS background_runs (
      id TEXT PRIMARY KEY,
      trigger TEXT NOT NULL DEFAULT 'timer' CHECK(trigger IN ('timer', 'manual', 'event')),
      status TEXT NOT NULL DEFAULT 'running' CHECK(status IN ('running', 'completed', 'failed')),
      items_found INTEGER NOT NULL DEFAULT 0,
      items_processed INTEGER NOT NULL DEFAULT 0,
      nodes_created INTEGER NOT NULL DEFAULT 0,
      hierarchy_changes INTEGER NOT NULL DEFAULT 0,
      dedup_actions INTEGER NOT NULL DEFAULT 0,
      errors TEXT,
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_background_runs_status ON background_runs(status);
    CREATE INDEX IF NOT EXISTS idx_background_runs_started ON background_runs(started_at);
  `);

  // Subagent execution log
  db.exec(`
    CREATE TABLE IF NOT EXISTS subagent_runs (
      id TEXT PRIMARY KEY,
      background_run_id TEXT REFERENCES background_runs(id),
      subagent_type TEXT NOT NULL CHECK(subagent_type IN ('classification', 'enrichment', 'organization', 'ui_adaptation', 'deduplication', 'description')),
      status TEXT NOT NULL DEFAULT 'running' CHECK(status IN ('running', 'completed', 'failed')),
      input_summary TEXT,
      output_summary TEXT,
      duration_ms INTEGER,
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_subagent_runs_type ON subagent_runs(subagent_type);
    CREATE INDEX IF NOT EXISTS idx_subagent_runs_bg ON subagent_runs(background_run_id);
  `);
}

// ── Settings helpers ──

export function getSetting<T>(db: Database.Database, key: string): T | null {
  const row = db
    .prepare('SELECT value FROM app_settings WHERE key = ?')
    .get(key) as { value: string } | undefined;

  if (!row) return null;

  try {
    return JSON.parse(row.value) as T;
  } catch (err) {
    console.warn(`Failed to parse app_settings value for key "${key}":`, err);
    return null;
  }
}

export function setSetting(db: Database.Database, key: string, value: unknown): void {
  db.prepare(
    `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).run(key, JSON.stringify(value), Date.now());
}

/** Durable ownership projection for local HTML artifacts. Harmony attempts remain in their existing ledger. */
export function migrateProjectArtifacts(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS project_artifacts (
      id TEXT PRIMARY KEY,
      canonical_path TEXT NOT NULL UNIQUE,
      relative_path TEXT NOT NULL,
      project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
      assignment_source TEXT CHECK(assignment_source IS NULL OR assignment_source IN ('explicit_context','owner')),
      assigned_at TEXT,
      current_sha256 TEXT,
      current_bytes INTEGER CHECK(current_bytes IS NULL OR current_bytes >= 0),
      current_modified_at TEXT,
      latest_visual_asset_version_id TEXT REFERENCES visual_asset_versions(id) ON DELETE SET NULL,
      version INTEGER NOT NULL DEFAULT 1 CHECK(version >= 1),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_project_artifacts_project
      ON project_artifacts(project_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_project_artifacts_unassigned
      ON project_artifacts(updated_at DESC) WHERE project_id IS NULL;
  `);
}

/**
 * R1 analytics data-room catalog. Artifact bytes remain in the contained
 * private store; these rows retain exact identities, receipts, immutable
 * history, and the separately mutable verified head.
 */
export function migrateAnalyticsDataRoom(db: Database.Database): void {
  db.transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS analytics_datasets (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        kind TEXT NOT NULL CHECK(kind IN ('source','derived')),
        scope TEXT NOT NULL CHECK(scope IN ('dashboard_local','project','workspace')),
        domain_key TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        lifecycle TEXT NOT NULL DEFAULT 'draft'
          CHECK(lifecycle IN ('draft','active','deprecated','retired')),
        source_kind TEXT NOT NULL CHECK(source_kind IN ('datanet_etl','sql_context','import')),
        source_format TEXT NOT NULL CHECK(source_format IN ('tsv','canonical_json')),
        definition_json TEXT NOT NULL,
        definition_revision INTEGER NOT NULL DEFAULT 1 CHECK(definition_revision >= 1),
        definition_sha256 TEXT NOT NULL CHECK(length(definition_sha256) = 64),
        contract_json TEXT NOT NULL,
        contract_sha256 TEXT NOT NULL CHECK(length(contract_sha256) = 64),
        schema_sha256 TEXT NOT NULL CHECK(length(schema_sha256) = 64),
        retention_json TEXT NOT NULL,
        minimum_versions INTEGER NOT NULL DEFAULT 1 CHECK(minimum_versions >= 1),
        automatic_expiry INTEGER NOT NULL DEFAULT 0 CHECK(automatic_expiry IN (0,1)),
        reacquirable INTEGER NOT NULL DEFAULT 1 CHECK(reacquirable IN (0,1)),
        backup_required INTEGER NOT NULL DEFAULT 0 CHECK(backup_required IN (0,1)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_analytics_datasets_domain_lifecycle
        ON analytics_datasets(domain_key, lifecycle, updated_at DESC);

      CREATE TABLE IF NOT EXISTS analytics_dataset_definition_revisions (
        dataset_id TEXT NOT NULL REFERENCES analytics_datasets(id) ON DELETE RESTRICT,
        revision INTEGER NOT NULL CHECK(revision >= 1),
        definition_json TEXT NOT NULL,
        definition_sha256 TEXT NOT NULL CHECK(length(definition_sha256) = 64),
        contract_json TEXT NOT NULL,
        contract_sha256 TEXT NOT NULL CHECK(length(contract_sha256) = 64),
        schema_sha256 TEXT NOT NULL CHECK(length(schema_sha256) = 64),
        retention_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (dataset_id, revision)
      );

      CREATE TABLE IF NOT EXISTS analytics_dataset_versions (
        id TEXT PRIMARY KEY,
        dataset_id TEXT NOT NULL REFERENCES analytics_datasets(id) ON DELETE RESTRICT,
        ordinal INTEGER NOT NULL CHECK(ordinal >= 1),
        version_key_sha256 TEXT NOT NULL CHECK(length(version_key_sha256) = 64),
        source_format TEXT NOT NULL CHECK(source_format IN ('tsv','canonical_json')),
        source_rel_path TEXT NOT NULL,
        source_sha256 TEXT NOT NULL CHECK(length(source_sha256) = 64),
        source_bytes INTEGER NOT NULL CHECK(source_bytes >= 0),
        materialized_rel_path TEXT NOT NULL,
        materialized_sha256 TEXT NOT NULL CHECK(length(materialized_sha256) = 64),
        materialized_bytes INTEGER NOT NULL CHECK(materialized_bytes >= 0),
        manifest_rel_path TEXT NOT NULL,
        manifest_sha256 TEXT NOT NULL CHECK(length(manifest_sha256) = 64),
        row_count INTEGER NOT NULL CHECK(row_count >= 0),
        observed_schema_json TEXT NOT NULL,
        observed_schema_sha256 TEXT NOT NULL CHECK(length(observed_schema_sha256) = 64),
        contract_json TEXT NOT NULL,
        contract_sha256 TEXT NOT NULL CHECK(length(contract_sha256) = 64),
        coverage_json TEXT NOT NULL,
        watermark TEXT NOT NULL,
        source_receipt_json TEXT NOT NULL,
        definition_sha256 TEXT NOT NULL CHECK(length(definition_sha256) = 64),
        handling_json TEXT NOT NULL,
        integrity_status TEXT NOT NULL DEFAULT 'verified'
          CHECK(integrity_status IN ('verified','quarantined')),
        integrity_verified_at TEXT,
        quarantine_reason TEXT,
        reacquirable INTEGER NOT NULL CHECK(reacquirable IN (0,1)),
        materialized_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(dataset_id, ordinal),
        UNIQUE(dataset_id, version_key_sha256),
        UNIQUE(dataset_id, id)
      );
      CREATE INDEX IF NOT EXISTS idx_analytics_dataset_versions_dataset
        ON analytics_dataset_versions(dataset_id, ordinal DESC);
      CREATE INDEX IF NOT EXISTS idx_analytics_dataset_versions_integrity
        ON analytics_dataset_versions(integrity_status, created_at);

      CREATE TABLE IF NOT EXISTS analytics_dataset_heads (
        dataset_id TEXT PRIMARY KEY REFERENCES analytics_datasets(id) ON DELETE RESTRICT,
        version_id TEXT NOT NULL,
        definition_revision INTEGER NOT NULL CHECK(definition_revision >= 1),
        head_revision INTEGER NOT NULL CHECK(head_revision >= 1),
        promoted_at TEXT NOT NULL,
        promotion_receipt_json TEXT NOT NULL,
        FOREIGN KEY (dataset_id, version_id)
          REFERENCES analytics_dataset_versions(dataset_id, id) ON DELETE RESTRICT
      );

      CREATE TABLE IF NOT EXISTS analytics_dataset_assertion_evaluations (
        id TEXT PRIMARY KEY,
        version_id TEXT NOT NULL REFERENCES analytics_dataset_versions(id) ON DELETE RESTRICT,
        assertion_id TEXT NOT NULL,
        assertion_version TEXT NOT NULL,
        severity TEXT NOT NULL CHECK(severity IN ('warning','error')),
        success INTEGER NOT NULL CHECK(success IN (0,1)),
        observed_json TEXT,
        expected_json TEXT,
        created_at TEXT NOT NULL,
        UNIQUE(version_id, assertion_id, assertion_version)
      );
      CREATE INDEX IF NOT EXISTS idx_analytics_dataset_assertions_version
        ON analytics_dataset_assertion_evaluations(version_id, severity, success);

      CREATE TABLE IF NOT EXISTS analytics_dataset_runs (
        id TEXT PRIMARY KEY,
        dataset_id TEXT NOT NULL REFERENCES analytics_datasets(id) ON DELETE RESTRICT,
        trigger TEXT NOT NULL CHECK(trigger IN ('manual','api','agent','scheduled')),
        request_sha256 TEXT NOT NULL CHECK(length(request_sha256) = 64),
        definition_revision INTEGER NOT NULL CHECK(definition_revision >= 1),
        definition_sha256 TEXT NOT NULL CHECK(length(definition_sha256) = 64),
        status TEXT NOT NULL CHECK(status IN ('staging','verifying','completed','failed')),
        source_kind TEXT NOT NULL CHECK(source_kind IN ('datanet_etl','sql_context','import')),
        remote_identity_json TEXT,
        staging_rel_path TEXT,
        lease_owner TEXT,
        lease_expires_at TEXT,
        heartbeat_at TEXT,
        output_version_id TEXT REFERENCES analytics_dataset_versions(id) ON DELETE SET NULL,
        receipt_json TEXT,
        error TEXT,
        queued_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_analytics_dataset_runs_dataset
        ON analytics_dataset_runs(dataset_id, queued_at DESC);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_analytics_dataset_runs_active
        ON analytics_dataset_runs(dataset_id, definition_sha256, request_sha256)
        WHERE status IN ('staging','verifying');

      CREATE TABLE IF NOT EXISTS analytics_dataset_dependencies (
        derived_dataset_id TEXT NOT NULL REFERENCES analytics_datasets(id) ON DELETE CASCADE,
        definition_revision INTEGER NOT NULL CHECK(definition_revision >= 1),
        alias TEXT NOT NULL,
        position INTEGER NOT NULL CHECK(position >= 0),
        input_dataset_id TEXT NOT NULL REFERENCES analytics_datasets(id) ON DELETE RESTRICT,
        version_policy TEXT NOT NULL CHECK(version_policy IN ('pinned','latest_compatible','latest_fresh')),
        pinned_version_id TEXT REFERENCES analytics_dataset_versions(id) ON DELETE RESTRICT,
        required_columns_json TEXT NOT NULL,
        expected_schema_sha256 TEXT,
        expected_contract_sha256 TEXT,
        created_at TEXT NOT NULL,
        PRIMARY KEY (derived_dataset_id, definition_revision, alias),
        UNIQUE (derived_dataset_id, definition_revision, position),
        CHECK (derived_dataset_id <> input_dataset_id),
        CHECK (expected_schema_sha256 IS NULL OR length(expected_schema_sha256) = 64),
        CHECK (expected_contract_sha256 IS NULL OR length(expected_contract_sha256) = 64)
      );
      CREATE INDEX IF NOT EXISTS idx_analytics_dataset_dependencies_input
        ON analytics_dataset_dependencies(input_dataset_id, derived_dataset_id, definition_revision);

      CREATE TABLE IF NOT EXISTS analytics_derived_runs (
        id TEXT PRIMARY KEY,
        dataset_id TEXT NOT NULL REFERENCES analytics_datasets(id) ON DELETE RESTRICT,
        definition_revision INTEGER NOT NULL CHECK(definition_revision >= 1),
        definition_sha256 TEXT NOT NULL CHECK(length(definition_sha256) = 64),
        expected_head_revision INTEGER NOT NULL CHECK(expected_head_revision >= 0),
        request_sha256 TEXT NOT NULL CHECK(length(request_sha256) = 64),
        transform_sha256 TEXT NOT NULL CHECK(length(transform_sha256) = 64),
        input_set_sha256 TEXT NOT NULL CHECK(length(input_set_sha256) = 64),
        materialization_key_sha256 TEXT NOT NULL UNIQUE CHECK(length(materialization_key_sha256) = 64),
        status TEXT NOT NULL CHECK(status IN ('queued','running','completed','failed')),
        lease_owner TEXT,
        lease_expires_at TEXT,
        heartbeat_at TEXT,
        output_version_id TEXT REFERENCES analytics_dataset_versions(id) ON DELETE SET NULL,
        receipt_json TEXT,
        error TEXT,
        next_action TEXT,
        queued_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_analytics_derived_runs_queue
        ON analytics_derived_runs(status, queued_at, id);
      CREATE INDEX IF NOT EXISTS idx_analytics_derived_runs_dataset_time
        ON analytics_derived_runs(dataset_id, queued_at DESC, id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_analytics_derived_runs_active_dataset
        ON analytics_derived_runs(dataset_id)
        WHERE status IN ('queued','running');

      CREATE TABLE IF NOT EXISTS analytics_derived_run_inputs (
        run_id TEXT NOT NULL REFERENCES analytics_derived_runs(id) ON DELETE CASCADE,
        alias TEXT NOT NULL,
        position INTEGER NOT NULL CHECK(position >= 0),
        input_dataset_id TEXT NOT NULL REFERENCES analytics_datasets(id) ON DELETE RESTRICT,
        input_version_id TEXT NOT NULL REFERENCES analytics_dataset_versions(id) ON DELETE RESTRICT,
        content_sha256 TEXT NOT NULL CHECK(length(content_sha256) = 64),
        schema_sha256 TEXT NOT NULL CHECK(length(schema_sha256) = 64),
        contract_sha256 TEXT NOT NULL CHECK(length(contract_sha256) = 64),
        definition_sha256 TEXT NOT NULL CHECK(length(definition_sha256) = 64),
        PRIMARY KEY (run_id, alias),
        UNIQUE (run_id, position)
      );
      CREATE INDEX IF NOT EXISTS idx_analytics_derived_run_inputs_version
        ON analytics_derived_run_inputs(input_version_id, run_id);

      CREATE TABLE IF NOT EXISTS analytics_dataset_version_inputs (
        output_version_id TEXT NOT NULL REFERENCES analytics_dataset_versions(id) ON DELETE CASCADE,
        alias TEXT NOT NULL,
        position INTEGER NOT NULL CHECK(position >= 0),
        input_dataset_id TEXT NOT NULL REFERENCES analytics_datasets(id) ON DELETE RESTRICT,
        input_version_id TEXT NOT NULL REFERENCES analytics_dataset_versions(id) ON DELETE RESTRICT,
        content_sha256 TEXT NOT NULL CHECK(length(content_sha256) = 64),
        schema_sha256 TEXT NOT NULL CHECK(length(schema_sha256) = 64),
        contract_sha256 TEXT NOT NULL CHECK(length(contract_sha256) = 64),
        definition_sha256 TEXT NOT NULL CHECK(length(definition_sha256) = 64),
        PRIMARY KEY (output_version_id, alias),
        UNIQUE (output_version_id, position)
      );
      CREATE INDEX IF NOT EXISTS idx_analytics_dataset_version_inputs_input
        ON analytics_dataset_version_inputs(input_version_id, output_version_id);

      CREATE TABLE IF NOT EXISTS analytics_derived_run_assertions (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES analytics_derived_runs(id) ON DELETE CASCADE,
        assertion_id TEXT NOT NULL,
        assertion_version TEXT NOT NULL,
        severity TEXT NOT NULL CHECK(severity IN ('warning','error')),
        success INTEGER NOT NULL CHECK(success IN (0,1)),
        observed_json TEXT,
        expected_json TEXT,
        created_at TEXT NOT NULL,
        UNIQUE (run_id, assertion_id, assertion_version)
      );

      CREATE TABLE IF NOT EXISTS analytics_derived_dirty (
        dataset_id TEXT PRIMARY KEY REFERENCES analytics_datasets(id) ON DELETE CASCADE,
        cause_dataset_id TEXT NOT NULL REFERENCES analytics_datasets(id) ON DELETE RESTRICT,
        cause_version_id TEXT NOT NULL REFERENCES analytics_dataset_versions(id) ON DELETE RESTRICT,
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','blocked')),
        error TEXT,
        invalidated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_analytics_derived_dirty_time
        ON analytics_derived_dirty(invalidated_at, dataset_id);

      CREATE TABLE IF NOT EXISTS analytics_answer_attempts (
        id TEXT PRIMARY KEY,
        request_sha256 TEXT NOT NULL CHECK(length(request_sha256) = 64),
        query_sha256 TEXT NOT NULL CHECK(length(query_sha256) = 64),
        metric_value_column TEXT,
        dataset_id TEXT REFERENCES analytics_datasets(id) ON DELETE SET NULL,
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

      CREATE TABLE IF NOT EXISTS analytics_dataset_project_links (
        dataset_id TEXT NOT NULL REFERENCES analytics_datasets(id) ON DELETE CASCADE,
        project_id TEXT NOT NULL,
        linked_at TEXT NOT NULL,
        PRIMARY KEY (dataset_id, project_id)
      );

      CREATE TABLE IF NOT EXISTS analytics_dataset_backups (
        id TEXT PRIMARY KEY,
        dataset_id TEXT NOT NULL REFERENCES analytics_datasets(id) ON DELETE RESTRICT,
        target_path TEXT NOT NULL,
        manifest_sha256 TEXT NOT NULL CHECK(length(manifest_sha256) = 64),
        version_ids_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('verified','failed')),
        error TEXT,
        created_at TEXT NOT NULL,
        verified_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_analytics_dataset_backups_dataset
        ON analytics_dataset_backups(dataset_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS analytics_dataset_backup_versions (
        backup_id TEXT NOT NULL REFERENCES analytics_dataset_backups(id) ON DELETE CASCADE,
        version_id TEXT NOT NULL REFERENCES analytics_dataset_versions(id) ON DELETE RESTRICT,
        PRIMARY KEY (backup_id, version_id)
      );
      CREATE INDEX IF NOT EXISTS idx_analytics_dataset_backup_versions_version
        ON analytics_dataset_backup_versions(version_id);

      CREATE TABLE IF NOT EXISTS analytics_dataset_restore_receipts (
        id TEXT PRIMARY KEY,
        backup_id TEXT NOT NULL,
        dataset_id TEXT NOT NULL REFERENCES analytics_datasets(id) ON DELETE RESTRICT,
        version_ids_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('verified','failed')),
        idempotent INTEGER NOT NULL DEFAULT 0 CHECK(idempotent IN (0,1)),
        detail_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_analytics_dataset_restores_dataset
        ON analytics_dataset_restore_receipts(dataset_id, created_at DESC);
    `);

    const dirtyColumns = new Set(
      (db.prepare('PRAGMA table_info(analytics_derived_dirty)').all() as Array<{ name: string }>)
        .map(column => column.name),
    );
    if (!dirtyColumns.has('status')) {
      db.exec("ALTER TABLE analytics_derived_dirty ADD COLUMN status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','blocked')); ");
    }
    if (!dirtyColumns.has('error')) {
      db.exec('ALTER TABLE analytics_derived_dirty ADD COLUMN error TEXT;');
    }

    const attemptColumns = new Set(
      (db.prepare('PRAGMA table_info(analytics_answer_attempts)').all() as Array<{ name: string }>)
        .map(column => column.name),
    );
    if (!attemptColumns.has('metric_value_column')) {
      db.exec('ALTER TABLE analytics_answer_attempts ADD COLUMN metric_value_column TEXT;');
    }

    const migratedAt = new Date().toISOString();
    db.prepare(`
      WITH ranked AS (
        SELECT id, ROW_NUMBER() OVER (
          PARTITION BY request_sha256
          ORDER BY
            CASE
              WHEN source_kind = 'datanet_etl' AND status = 'waiting_remote' AND remote_run_id IS NOT NULL THEN 0
              WHEN source_kind = 'datanet_etl' THEN 1
              ELSE 2
            END,
            created_at ASC,
            id ASC
        ) AS active_rank
        FROM analytics_answer_attempts
        WHERE status IN ('running','waiting_remote')
      )
      UPDATE analytics_answer_attempts
      SET status = 'failed',
          error = 'A duplicate active analytics answer attempt was superseded during request-identity migration.',
          next_action = CASE
            WHEN remote_run_id IS NOT NULL
              THEN 'Do not resubmit the recorded remote run; inspect that exact run before any new attempt.'
            WHEN source_kind = 'datanet_etl'
              THEN 'ETL submission may be unknown; inspect Datanet before any new attempt.'
            ELSE 'Wait for the surviving request attempt before retrying read-only SQL.'
          END,
          updated_at = ?,
          completed_at = ?
      WHERE id IN (SELECT id FROM ranked WHERE active_rank > 1)
    `).run(migratedAt, migratedAt);

    db.prepare(`
      UPDATE analytics_answer_attempts
      SET status = 'waiting_remote', remote_status = 'SUBMISSION_CONTEXT_UNKNOWN',
          error = 'This ETL attempt predates the frozen metric-alias checkpoint.',
          next_action = 'Do not resubmit; reconcile or retire the exact attempt after inspecting Datanet.',
          updated_at = ?, completed_at = NULL
      WHERE status IN ('running','waiting_remote')
        AND source_kind = 'datanet_etl'
        AND metric_value_column IS NULL
        AND COALESCE(remote_status, '') <> 'SUBMISSION_CONTEXT_UNKNOWN'
    `).run(migratedAt);

    db.exec(`
      DROP INDEX IF EXISTS idx_analytics_answer_attempts_request;
      DROP INDEX IF EXISTS idx_analytics_answer_attempts_active;
      CREATE INDEX idx_analytics_answer_attempts_request
        ON analytics_answer_attempts(request_sha256, status, created_at DESC, id DESC);
      CREATE UNIQUE INDEX idx_analytics_answer_attempts_active
        ON analytics_answer_attempts(request_sha256)
        WHERE status IN ('running','waiting_remote');
    `);

    // R4 widget bindings are additive and intentionally land after every
    // legacy analytics table rebuild. Existing widgets/runs remain unbound,
    // full-scope, and byte-for-byte compatible with the remote run machine.
    const widgetColumns = new Set(
      (db.prepare('PRAGMA table_info(analytics_widgets)').all() as Array<{ name: string }>)
        .map(column => column.name),
    );
    if (!widgetColumns.has('revision')) {
      db.exec('ALTER TABLE analytics_widgets ADD COLUMN revision INTEGER NOT NULL DEFAULT 1 CHECK(revision >= 1);');
    }
    const runWidgetColumns = new Set(
      (db.prepare('PRAGMA table_info(analytics_run_widgets)').all() as Array<{ name: string }>)
        .map(column => column.name),
    );
    if (!runWidgetColumns.has('widget_revision')) {
      db.exec('ALTER TABLE analytics_run_widgets ADD COLUMN widget_revision INTEGER NOT NULL DEFAULT 1 CHECK(widget_revision >= 1);');
    }
    const dashboardColumns = new Set(
      (db.prepare('PRAGMA table_info(analytics_dashboards)').all() as Array<{ name: string }>)
        .map(column => column.name),
    );
    if (!dashboardColumns.has('data_state')) {
      db.exec("ALTER TABLE analytics_dashboards ADD COLUMN data_state TEXT CHECK(data_state IS NULL OR data_state = 'waiting_for_data');");
    }
    const runColumns = new Set(
      (db.prepare('PRAGMA table_info(analytics_runs)').all() as Array<{ name: string }>)
        .map(column => column.name),
    );
    if (!runColumns.has('refresh_scope')) {
      db.exec("ALTER TABLE analytics_runs ADD COLUMN refresh_scope TEXT NOT NULL DEFAULT 'full' CHECK(refresh_scope IN ('full','selective')); ");
    }
    const lateColumns = new Set(
      (db.prepare('PRAGMA table_info(analytics_late_etl_results)').all() as Array<{ name: string }>)
        .map(column => column.name),
    );
    const lateAdditions: Array<[string, string]> = [
      ['widget_revision', 'INTEGER CHECK(widget_revision IS NULL OR widget_revision >= 1)'],
      ['binding_revision', 'INTEGER CHECK(binding_revision IS NULL OR binding_revision >= 1)'],
      ['control_revision', 'INTEGER CHECK(control_revision IS NULL OR control_revision >= 1)'],
      ['dataset_id', 'TEXT'],
      ['dataset_version_id', 'TEXT'],
      ['effective_query_sha256', "TEXT CHECK(effective_query_sha256 IS NULL OR length(effective_query_sha256) = 64)"],
    ];
    for (const [name, declaration] of lateAdditions) {
      if (!lateColumns.has(name)) db.exec(`ALTER TABLE analytics_late_etl_results ADD COLUMN ${name} ${declaration};`);
    }

    db.exec(`
      CREATE TABLE IF NOT EXISTS analytics_dataset_dashboard_owners (
        dataset_id TEXT PRIMARY KEY REFERENCES analytics_datasets(id) ON DELETE CASCADE,
        dashboard_id TEXT NOT NULL REFERENCES analytics_dashboards(id) ON DELETE RESTRICT,
        claimed_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_analytics_dataset_dashboard_owners_dashboard
        ON analytics_dataset_dashboard_owners(dashboard_id, dataset_id);

      CREATE TABLE IF NOT EXISTS analytics_widget_binding_revisions (
        widget_id TEXT PRIMARY KEY REFERENCES analytics_widgets(id) ON DELETE CASCADE,
        revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0),
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS analytics_widget_dataset_bindings (
        widget_id TEXT PRIMARY KEY REFERENCES analytics_widgets(id) ON DELETE CASCADE,
        dataset_id TEXT NOT NULL REFERENCES analytics_datasets(id) ON DELETE RESTRICT,
        revision INTEGER NOT NULL CHECK(revision >= 1),
        version_policy TEXT NOT NULL
          CHECK(version_policy IN ('pinned','latest_compatible','latest_fresh')),
        pinned_version_id TEXT,
        expected_schema_sha256 TEXT NOT NULL CHECK(length(expected_schema_sha256) = 64),
        expected_contract_sha256 TEXT
          CHECK(expected_contract_sha256 IS NULL OR length(expected_contract_sha256) = 64),
        required_columns_json TEXT NOT NULL,
        request_json TEXT NOT NULL,
        request_sha256 TEXT NOT NULL CHECK(length(request_sha256) = 64),
        presentation_limit INTEGER NOT NULL CHECK(presentation_limit BETWEEN 1 AND 200),
        compatibility_state TEXT NOT NULL DEFAULT 'waiting'
          CHECK(compatibility_state IN ('compatible','waiting','incompatible')),
        compatibility_error TEXT,
        observed_head_revision INTEGER NOT NULL DEFAULT 0 CHECK(observed_head_revision >= 0),
        last_queued_version_id TEXT,
        last_applied_version_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK(
          (version_policy = 'pinned' AND pinned_version_id IS NOT NULL)
          OR (version_policy IN ('latest_compatible','latest_fresh') AND pinned_version_id IS NULL)
        ),
        FOREIGN KEY (dataset_id, pinned_version_id)
          REFERENCES analytics_dataset_versions(dataset_id, id) ON DELETE RESTRICT,
        FOREIGN KEY (dataset_id, last_queued_version_id)
          REFERENCES analytics_dataset_versions(dataset_id, id) ON DELETE RESTRICT,
        FOREIGN KEY (dataset_id, last_applied_version_id)
          REFERENCES analytics_dataset_versions(dataset_id, id) ON DELETE RESTRICT
      );
      CREATE INDEX IF NOT EXISTS idx_analytics_widget_bindings_dataset
        ON analytics_widget_dataset_bindings(dataset_id, widget_id);
      CREATE INDEX IF NOT EXISTS idx_analytics_widget_bindings_pending
        ON analytics_widget_dataset_bindings(version_policy, last_queued_version_id, observed_head_revision);

      CREATE TABLE IF NOT EXISTS analytics_run_widget_data_room_snapshots (
        run_id TEXT NOT NULL,
        widget_id TEXT NOT NULL,
        widget_revision INTEGER NOT NULL CHECK(widget_revision >= 1),
        binding_revision INTEGER NOT NULL CHECK(binding_revision >= 1),
        control_revision INTEGER CHECK(control_revision IS NULL OR control_revision >= 1),
        dataset_id TEXT NOT NULL REFERENCES analytics_datasets(id) ON DELETE RESTRICT,
        dataset_definition_revision INTEGER NOT NULL CHECK(dataset_definition_revision >= 1),
        dataset_definition_sha256 TEXT NOT NULL CHECK(length(dataset_definition_sha256) = 64),
        resolved_head_revision INTEGER NOT NULL CHECK(resolved_head_revision >= 0),
        candidate_version_id TEXT,
        version_id TEXT,
        content_sha256 TEXT CHECK(content_sha256 IS NULL OR length(content_sha256) = 64),
        schema_sha256 TEXT CHECK(schema_sha256 IS NULL OR length(schema_sha256) = 64),
        contract_sha256 TEXT CHECK(contract_sha256 IS NULL OR length(contract_sha256) = 64),
        request_json TEXT NOT NULL,
        request_sha256 TEXT NOT NULL CHECK(length(request_sha256) = 64),
        compiled_query_json TEXT,
        query_sha256 TEXT CHECK(query_sha256 IS NULL OR length(query_sha256) = 64),
        compiler_version TEXT,
        semantic_context_json TEXT,
        resolution_state TEXT NOT NULL
          CHECK(resolution_state IN ('compatible','waiting','incompatible')),
        resolution_error TEXT,
        execution_receipt_json TEXT,
        applied_at TEXT,
        created_at TEXT NOT NULL,
        PRIMARY KEY (run_id, widget_id),
        FOREIGN KEY (run_id, widget_id)
          REFERENCES analytics_run_widgets(run_id, widget_id) ON DELETE CASCADE,
        FOREIGN KEY (dataset_id, candidate_version_id)
          REFERENCES analytics_dataset_versions(dataset_id, id) ON DELETE RESTRICT,
        FOREIGN KEY (dataset_id, version_id)
          REFERENCES analytics_dataset_versions(dataset_id, id) ON DELETE RESTRICT,
        CHECK(
          (resolution_error IS NOT NULL AND version_id IS NULL AND compiled_query_json IS NULL
            AND query_sha256 IS NULL AND compiler_version IS NULL)
          OR (resolution_error IS NULL AND version_id IS NOT NULL AND content_sha256 IS NOT NULL
            AND schema_sha256 IS NOT NULL AND contract_sha256 IS NOT NULL
            AND compiled_query_json IS NOT NULL AND query_sha256 IS NOT NULL
            AND compiler_version IS NOT NULL AND semantic_context_json IS NOT NULL)
        )
      );
      CREATE INDEX IF NOT EXISTS idx_analytics_run_widget_room_version
        ON analytics_run_widget_data_room_snapshots(version_id, run_id, widget_id);
      CREATE INDEX IF NOT EXISTS idx_analytics_run_widget_room_binding
        ON analytics_run_widget_data_room_snapshots(widget_id, binding_revision, run_id);

      CREATE TABLE IF NOT EXISTS analytics_dashboard_edit_receipts (
        id TEXT PRIMARY KEY,
        owner_request_id TEXT NOT NULL UNIQUE
          CHECK(length(owner_request_id) BETWEEN 8 AND 128),
        owner_message_json TEXT NOT NULL,
        owner_message_sha256 TEXT NOT NULL CHECK(length(owner_message_sha256) = 64),
        owner_scope_json TEXT NOT NULL,
        owner_scope_sha256 TEXT NOT NULL CHECK(length(owner_scope_sha256) = 64),
        request_intent_json TEXT NOT NULL,
        request_intent_sha256 TEXT NOT NULL CHECK(length(request_intent_sha256) = 64),
        intent_version INTEGER NOT NULL CHECK(intent_version = 1),
        intent_json TEXT NOT NULL,
        intent_sha256 TEXT NOT NULL CHECK(length(intent_sha256) = 64),
        action TEXT NOT NULL CHECK(action IN ('add_from_widget','combine_compatible_widgets')),
        dashboard_id TEXT NOT NULL,
        source_widget_ids_json TEXT NOT NULL,
        explicit_new INTEGER NOT NULL DEFAULT 0 CHECK(explicit_new IN (0,1)),
        replay_of_receipt_id TEXT
          REFERENCES analytics_dashboard_edit_receipts(id) ON DELETE RESTRICT,
        created_widget_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        effect_version INTEGER NOT NULL CHECK(effect_version = 1),
        effect_sha256 TEXT NOT NULL CHECK(length(effect_sha256) = 64),
        mutation_receipt_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_replayed_at TEXT,
        CHECK(replay_of_receipt_id IS NULL OR replay_of_receipt_id != id)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_analytics_dashboard_edit_receipts_ordinary_intent
        ON analytics_dashboard_edit_receipts(intent_version, intent_sha256)
        WHERE explicit_new = 0 AND replay_of_receipt_id IS NULL;
      CREATE INDEX IF NOT EXISTS idx_analytics_dashboard_edit_receipts_replay_of
        ON analytics_dashboard_edit_receipts(replay_of_receipt_id);
      CREATE INDEX IF NOT EXISTS idx_analytics_dashboard_edit_receipts_effect_target
        ON analytics_dashboard_edit_receipts(created_widget_id, run_id);
    `);

    // R5.0 typed controls remain additive. Existing bindings project revision
    // zero on read; only an explicit bind/apply creates a control row. Legacy
    // snapshots keep nullable control/view identity and execute through v1.
    const snapshotColumns = new Set(
      (db.prepare('PRAGMA table_info(analytics_run_widget_data_room_snapshots)').all() as Array<{ name: string }>)
        .map(column => column.name),
    );
    const snapshotAdditions: Array<[string, string]> = [
      ['control_definition_sha256', "TEXT CHECK(control_definition_sha256 IS NULL OR length(control_definition_sha256) = 64)"],
      ['control_values_sha256', "TEXT CHECK(control_values_sha256 IS NULL OR length(control_values_sha256) = 64)"],
      ['effective_view_request_json', 'TEXT'],
      ['effective_view_request_sha256', "TEXT CHECK(effective_view_request_sha256 IS NULL OR length(effective_view_request_sha256) = 64)"],
    ];
    for (const [name, declaration] of snapshotAdditions) {
      if (!snapshotColumns.has(name)) {
        db.exec(`ALTER TABLE analytics_run_widget_data_room_snapshots ADD COLUMN ${name} ${declaration};`);
      }
    }

    db.exec(`
      CREATE TABLE IF NOT EXISTS analytics_dataset_controls (
        widget_id TEXT PRIMARY KEY REFERENCES analytics_widgets(id) ON DELETE CASCADE,
        dataset_id TEXT NOT NULL REFERENCES analytics_datasets(id) ON DELETE RESTRICT,
        binding_revision INTEGER NOT NULL CHECK(binding_revision >= 1),
        control_revision INTEGER NOT NULL CHECK(control_revision >= 1),
        dataset_definition_revision INTEGER NOT NULL CHECK(dataset_definition_revision >= 1),
        dataset_definition_sha256 TEXT NOT NULL CHECK(length(dataset_definition_sha256) = 64),
        contract_sha256 TEXT NOT NULL CHECK(length(contract_sha256) = 64),
        schema_sha256 TEXT NOT NULL CHECK(length(schema_sha256) = 64),
        control_definition_json TEXT NOT NULL,
        control_definition_sha256 TEXT NOT NULL CHECK(length(control_definition_sha256) = 64),
        default_values_json TEXT NOT NULL,
        default_values_sha256 TEXT NOT NULL CHECK(length(default_values_sha256) = 64),
        current_values_json TEXT NOT NULL,
        current_values_sha256 TEXT NOT NULL CHECK(length(current_values_sha256) = 64),
        effective_view_request_json TEXT NOT NULL,
        effective_view_request_sha256 TEXT NOT NULL CHECK(length(effective_view_request_sha256) = 64),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_analytics_dataset_controls_dataset
        ON analytics_dataset_controls(dataset_id, widget_id);

      CREATE TABLE IF NOT EXISTS analytics_import_inbox_items (
        id TEXT PRIMARY KEY CHECK(id GLOB 'dri_[a-f0-9]*' AND length(id) = 28),
        owner_request_id TEXT NOT NULL UNIQUE
          CHECK(length(owner_request_id) BETWEEN 8 AND 128),
        request_identity_sha256 TEXT NOT NULL CHECK(length(request_identity_sha256) = 64),
        revision INTEGER NOT NULL DEFAULT 1 CHECK(revision >= 1),
        status TEXT NOT NULL
          CHECK(status IN ('receiving','uploaded','inspecting','ready','failed')),
        source_kind TEXT NOT NULL DEFAULT 'upload' CHECK(source_kind = 'upload'),
        original_name TEXT NOT NULL CHECK(length(original_name) BETWEEN 1 AND 180),
        media_type TEXT NOT NULL
          CHECK(media_type = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'),
        source_rel_path TEXT NOT NULL,
        source_sha256 TEXT CHECK(source_sha256 IS NULL OR length(source_sha256) = 64),
        source_bytes INTEGER CHECK(source_bytes IS NULL OR source_bytes > 0),
        sheet_inventory_json TEXT,
        sheet_inventory_sha256 TEXT
          CHECK(sheet_inventory_sha256 IS NULL OR length(sheet_inventory_sha256) = 64),
        selected_sheet TEXT,
        preview_json TEXT,
        preview_sha256 TEXT CHECK(preview_sha256 IS NULL OR length(preview_sha256) = 64),
        error_code TEXT,
        error_message TEXT,
        next_action TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        uploaded_at TEXT,
        inspected_at TEXT,
        CHECK((source_sha256 IS NULL) = (source_bytes IS NULL)),
        CHECK((sheet_inventory_json IS NULL) = (sheet_inventory_sha256 IS NULL)),
        CHECK((preview_json IS NULL) = (preview_sha256 IS NULL))
      );
      CREATE INDEX IF NOT EXISTS idx_analytics_import_inbox_status_time
        ON analytics_import_inbox_items(status, updated_at DESC, id DESC);

      CREATE TABLE IF NOT EXISTS analytics_import_semantic_proposals (
        id TEXT PRIMARY KEY CHECK(id GLOB 'drip_[a-f0-9]*' AND length(id) = 29),
        candidate_id TEXT NOT NULL REFERENCES analytics_import_inbox_items(id) ON DELETE RESTRICT,
        proposal_revision INTEGER NOT NULL CHECK(proposal_revision >= 1),
        prior_proposal_id TEXT REFERENCES analytics_import_semantic_proposals(id) ON DELETE RESTRICT,
        state_revision INTEGER NOT NULL DEFAULT 1 CHECK(state_revision >= 1),
        status TEXT NOT NULL CHECK(status IN (
          'processing','review_ready','needs_input','approved','promoting','complete','failed','conflict','dismissed'
        )),
        request_sha256 TEXT NOT NULL UNIQUE CHECK(length(request_sha256) = 64),
        candidate_revision INTEGER NOT NULL CHECK(candidate_revision >= 1),
        source_sha256 TEXT NOT NULL CHECK(length(source_sha256) = 64),
        source_bytes INTEGER NOT NULL CHECK(source_bytes > 0),
        selected_sheet TEXT NOT NULL,
        sheet_inventory_sha256 TEXT NOT NULL CHECK(length(sheet_inventory_sha256) = 64),
        parser_version TEXT,
        transform_version TEXT CHECK(transform_version IS NULL OR length(transform_version) BETWEEN 1 AND 128),
        header_policy_version TEXT,
        date_policy_version TEXT,
        formula_policy_version TEXT,
        error_policy_version TEXT,
        complete_to_eof INTEGER NOT NULL DEFAULT 0 CHECK(complete_to_eof IN (0,1)),
        row_count INTEGER CHECK(row_count IS NULL OR row_count >= 0),
        non_empty_row_count INTEGER CHECK(non_empty_row_count IS NULL OR non_empty_row_count >= 0),
        column_count INTEGER CHECK(column_count IS NULL OR column_count >= 0),
        cell_count INTEGER CHECK(cell_count IS NULL OR cell_count >= 0),
        date_system TEXT CHECK(date_system IS NULL OR date_system IN ('1900','1904')),
        formula_cell_count INTEGER CHECK(formula_cell_count IS NULL OR formula_cell_count >= 0),
        formula_without_cached_value_count INTEGER CHECK(formula_without_cached_value_count IS NULL OR formula_without_cached_value_count >= 0),
        error_cell_count INTEGER CHECK(error_cell_count IS NULL OR error_cell_count >= 0),
        merged_range_count INTEGER CHECK(merged_range_count IS NULL OR merged_range_count >= 0),
        parse_sha256 TEXT CHECK(parse_sha256 IS NULL OR length(parse_sha256) = 64),
        profile_sha256 TEXT CHECK(profile_sha256 IS NULL OR length(profile_sha256) = 64),
        raw_rowset_sha256 TEXT CHECK(raw_rowset_sha256 IS NULL OR length(raw_rowset_sha256) = 64),
        raw_schema_sha256 TEXT CHECK(raw_schema_sha256 IS NULL OR length(raw_schema_sha256) = 64),
        parsed_rel_path TEXT,
        parsed_sha256 TEXT CHECK(parsed_sha256 IS NULL OR length(parsed_sha256) = 64),
        parsed_bytes INTEGER CHECK(parsed_bytes IS NULL OR parsed_bytes >= 0),
        context_family TEXT,
        context_selection_sha256 TEXT CHECK(context_selection_sha256 IS NULL OR length(context_selection_sha256) = 64),
        context_receipts_json TEXT,
        context_bundle_sha256 TEXT CHECK(context_bundle_sha256 IS NULL OR length(context_bundle_sha256) = 64),
        llm_operation_id TEXT,
        prompt_version TEXT,
        prompt_sha256 TEXT CHECK(prompt_sha256 IS NULL OR length(prompt_sha256) = 64),
        provider TEXT,
        model TEXT,
        api_mode TEXT,
        provider_endpoint_sha256 TEXT CHECK(provider_endpoint_sha256 IS NULL OR length(provider_endpoint_sha256) = 64),
        provider_locality TEXT CHECK(provider_locality IS NULL OR provider_locality IN ('device_local','amazon_managed_remote','external_remote')),
        model_temperature REAL,
        disclosure_policy_version TEXT,
        response_sha256 TEXT CHECK(response_sha256 IS NULL OR length(response_sha256) = 64),
        finish_reason TEXT,
        validator_version TEXT,
        proposal_json TEXT,
        proposal_sha256 TEXT CHECK(proposal_sha256 IS NULL OR length(proposal_sha256) = 64),
        definition_json TEXT,
        contract_json TEXT,
        contract_sha256 TEXT CHECK(contract_sha256 IS NULL OR length(contract_sha256) = 64),
        evidence_json TEXT,
        unresolved_json TEXT,
        owner_answers_json TEXT,
        error_code TEXT,
        error_message TEXT,
        next_action TEXT,
        attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count >= 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT,
        UNIQUE(candidate_id, proposal_revision),
        CHECK((parsed_rel_path IS NULL) = (parsed_sha256 IS NULL)),
        CHECK((parsed_sha256 IS NULL) = (parsed_bytes IS NULL)),
        CHECK((proposal_json IS NULL) = (proposal_sha256 IS NULL)),
        CHECK((contract_json IS NULL) = (contract_sha256 IS NULL))
      );
      CREATE INDEX IF NOT EXISTS idx_analytics_import_proposals_candidate
        ON analytics_import_semantic_proposals(candidate_id, proposal_revision DESC);
      CREATE INDEX IF NOT EXISTS idx_analytics_import_proposals_queue
        ON analytics_import_semantic_proposals(status, updated_at, id);

      CREATE TABLE IF NOT EXISTS analytics_import_proposal_approvals (
        id TEXT PRIMARY KEY CHECK(id GLOB 'dria_[a-f0-9]*' AND length(id) = 29),
        proposal_id TEXT NOT NULL UNIQUE REFERENCES analytics_import_semantic_proposals(id) ON DELETE RESTRICT,
        owner_request_id TEXT NOT NULL UNIQUE CHECK(length(owner_request_id) BETWEEN 8 AND 128),
        request_identity_sha256 TEXT NOT NULL CHECK(length(request_identity_sha256) = 64),
        approval_sha256 TEXT NOT NULL UNIQUE CHECK(length(approval_sha256) = 64),
        proposal_revision INTEGER NOT NULL CHECK(proposal_revision >= 1),
        proposal_sha256 TEXT NOT NULL CHECK(length(proposal_sha256) = 64),
        transform_version TEXT CHECK(transform_version IS NULL OR length(transform_version) BETWEEN 1 AND 128),
        candidate_revision INTEGER NOT NULL CHECK(candidate_revision >= 1),
        source_sha256 TEXT NOT NULL CHECK(length(source_sha256) = 64),
        parse_sha256 TEXT NOT NULL CHECK(length(parse_sha256) = 64),
        profile_sha256 TEXT NOT NULL CHECK(length(profile_sha256) = 64),
        rowset_sha256 TEXT NOT NULL CHECK(length(rowset_sha256) = 64),
        schema_sha256 TEXT NOT NULL CHECK(length(schema_sha256) = 64),
        context_bundle_sha256 TEXT NOT NULL CHECK(length(context_bundle_sha256) = 64),
        response_sha256 TEXT NOT NULL CHECK(length(response_sha256) = 64),
        contract_sha256 TEXT NOT NULL CHECK(length(contract_sha256) = 64),
        expected_definition_revision INTEGER NOT NULL CHECK(expected_definition_revision >= 0),
        expected_head_revision INTEGER NOT NULL CHECK(expected_head_revision >= 0),
        approved_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS analytics_import_promotions (
        id TEXT PRIMARY KEY CHECK(id GLOB 'drim_[a-f0-9]*' AND length(id) = 29),
        approval_id TEXT NOT NULL UNIQUE REFERENCES analytics_import_proposal_approvals(id) ON DELETE RESTRICT,
        state_revision INTEGER NOT NULL DEFAULT 1 CHECK(state_revision >= 1),
        status TEXT NOT NULL CHECK(status IN ('approved','promoting','complete','conflict')),
        intent_sha256 TEXT NOT NULL UNIQUE CHECK(length(intent_sha256) = 64),
        dataset_id TEXT NOT NULL,
        definition_revision INTEGER,
        version_id TEXT REFERENCES analytics_dataset_versions(id) ON DELETE RESTRICT,
        head_revision_before INTEGER NOT NULL CHECK(head_revision_before >= 0),
        head_revision_after INTEGER CHECK(head_revision_after IS NULL OR head_revision_after >= 1),
        source_run_id TEXT REFERENCES analytics_dataset_runs(id) ON DELETE SET NULL,
        receipt_json TEXT,
        error_code TEXT,
        error_message TEXT,
        next_action TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_analytics_import_promotions_status
        ON analytics_import_promotions(status, updated_at, id);

      CREATE TABLE IF NOT EXISTS analytics_data_room_state (
        singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
        revision INTEGER NOT NULL CHECK(revision >= 0),
        updated_at TEXT NOT NULL
      );
      INSERT OR IGNORE INTO analytics_data_room_state (singleton, revision, updated_at)
      VALUES (1, 0, datetime('now'));
    `);

    const proposalColumns = new Set(
      (db.prepare('PRAGMA table_info(analytics_import_semantic_proposals)').all() as Array<{ name: string }>)
        .map(column => column.name),
    );
    if (!proposalColumns.has('transform_version')) {
      db.exec(`ALTER TABLE analytics_import_semantic_proposals ADD COLUMN transform_version TEXT
        CHECK(transform_version IS NULL OR length(transform_version) BETWEEN 1 AND 128);`);
    }
    const approvalColumns = new Set(
      (db.prepare('PRAGMA table_info(analytics_import_proposal_approvals)').all() as Array<{ name: string }>)
        .map(column => column.name),
    );
    if (!approvalColumns.has('transform_version')) {
      db.exec(`ALTER TABLE analytics_import_proposal_approvals ADD COLUMN transform_version TEXT
        CHECK(transform_version IS NULL OR length(transform_version) BETWEEN 1 AND 128);`);
    }

    const proposalTransformRows = db.prepare(`
      SELECT id, proposal_json, proposal_sha256, definition_json
      FROM analytics_import_semantic_proposals
      WHERE transform_version IS NULL AND proposal_json IS NOT NULL AND definition_json IS NOT NULL
    `).all() as Array<{ id: string; proposal_json: string; proposal_sha256: string | null; definition_json: string }>;
    const pinProposalTransform = db.prepare(`
      UPDATE analytics_import_semantic_proposals SET transform_version=?
      WHERE id=? AND transform_version IS NULL
    `);
    for (const row of proposalTransformRows) {
      try {
        if (!row.proposal_sha256
          || createHash('sha256').update(row.proposal_json).digest('hex') !== row.proposal_sha256) continue;
        const proposal = JSON.parse(row.proposal_json) as { transformVersion?: unknown };
        const definition = JSON.parse(row.definition_json) as { definition?: { adapterVersion?: unknown } };
        const transformVersion = proposal.transformVersion;
        if (typeof transformVersion === 'string'
          && transformVersion === transformVersion.trim()
          && transformVersion.length >= 1
          && transformVersion.length <= 128
          && definition.definition?.adapterVersion === transformVersion) {
          pinProposalTransform.run(transformVersion, row.id);
        }
      } catch {
        // Malformed historical JSON stays unpinned and therefore cannot be approved as current work.
      }
    }
    db.prepare(`
      UPDATE analytics_import_proposal_approvals
      SET transform_version=(
        SELECT proposal.transform_version
        FROM analytics_import_semantic_proposals proposal
        WHERE proposal.id=analytics_import_proposal_approvals.proposal_id
          AND proposal.proposal_sha256=analytics_import_proposal_approvals.proposal_sha256
      )
      WHERE transform_version IS NULL AND EXISTS (
        SELECT 1 FROM analytics_import_semantic_proposals proposal
        WHERE proposal.id=analytics_import_proposal_approvals.proposal_id
          AND proposal.proposal_sha256=analytics_import_proposal_approvals.proposal_sha256
          AND proposal.transform_version IS NOT NULL
      )
    `).run();
  })();
}
/**
 * R6.2b analytics jobs. This ledger coordinates existing immutable Data Room
 * versions; it owns no connector, source bytes, or model-generated execution.
 */
export function migrateAnalyticsJobs(db: Database.Database): void {
  db.transaction(() => {
    const datasetColumns = new Set(
      (db.prepare('PRAGMA table_info(analytics_datasets)').all() as Array<{ name: string }>)
        .map(column => column.name),
    );
    if (!datasetColumns.has('catalog_visibility')) {
      db.exec(`ALTER TABLE analytics_datasets ADD COLUMN catalog_visibility TEXT NOT NULL DEFAULT 'catalog'
        CHECK(catalog_visibility IN ('internal','job_scoped','catalog'));`);
    }

    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_analytics_datasets_visibility_lifecycle
        ON analytics_datasets(catalog_visibility, lifecycle, updated_at DESC);

      CREATE TABLE IF NOT EXISTS analytics_jobs (
        id TEXT PRIMARY KEY CHECK(id GLOB 'aj_[a-f0-9]*' AND length(id) = 35),
        owner_id TEXT NOT NULL CHECK(length(owner_id) BETWEEN 1 AND 240),
        owner_request_id TEXT NOT NULL CHECK(length(owner_request_id) BETWEEN 8 AND 128),
        owner_message_sha256 TEXT NOT NULL CHECK(length(owner_message_sha256) = 64),
        intent_json TEXT NOT NULL,
        intent_sha256 TEXT NOT NULL CHECK(length(intent_sha256) = 64),
        status TEXT NOT NULL CHECK(status IN (
          'planning','running','needs_input','needs_approval','waiting_external',
          'blocked','delivering','complete','cancel_requested','cancelled','failed'
        )),
        state_revision INTEGER NOT NULL DEFAULT 1 CHECK(state_revision >= 1),
        plan_revision INTEGER NOT NULL DEFAULT 0 CHECK(plan_revision >= 0),
        plan_sha256 TEXT CHECK(plan_sha256 IS NULL OR length(plan_sha256) = 64),
        question_count INTEGER NOT NULL DEFAULT 0 CHECK(question_count BETWEEN 0 AND 1),
        question_receipt_json TEXT,
        question_receipt_sha256 TEXT CHECK(question_receipt_sha256 IS NULL OR length(question_receipt_sha256) = 64),
        result_id TEXT CHECK(result_id IS NULL OR (result_id GLOB 'ar_[a-f0-9]*' AND length(result_id) = 27)),
        completion_receipt_json TEXT,
        completion_receipt_sha256 TEXT CHECK(completion_receipt_sha256 IS NULL OR length(completion_receipt_sha256) = 64),
        error_code TEXT,
        error_message TEXT,
        next_action TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT,
        cancel_requested_at TEXT,
        UNIQUE(owner_id, owner_request_id),
        CHECK((plan_revision = 0 AND plan_sha256 IS NULL) OR (plan_revision >= 1 AND plan_sha256 IS NOT NULL)),
        CHECK((question_receipt_json IS NULL) = (question_receipt_sha256 IS NULL)),
        CHECK((completion_receipt_json IS NULL) = (completion_receipt_sha256 IS NULL))
      );
      CREATE INDEX IF NOT EXISTS idx_analytics_jobs_status_time
        ON analytics_jobs(status, updated_at, id);

      CREATE TABLE IF NOT EXISTS analytics_job_results (
        id TEXT PRIMARY KEY CHECK(id GLOB 'ar_[a-f0-9]*' AND length(id) = 27),
        job_id TEXT NOT NULL REFERENCES analytics_jobs(id) ON DELETE RESTRICT,
        final_plan_sha256 TEXT NOT NULL CHECK(length(final_plan_sha256) = 64),
        primary_version_id TEXT NOT NULL REFERENCES analytics_dataset_versions(id) ON DELETE RESTRICT,
        manifest_json TEXT NOT NULL,
        manifest_sha256 TEXT NOT NULL CHECK(length(manifest_sha256) = 64),
        visibility TEXT NOT NULL CHECK(visibility IN ('job_scoped','catalog')),
        retention_json TEXT NOT NULL,
        retention_sha256 TEXT NOT NULL CHECK(length(retention_sha256) = 64),
        receipt_json TEXT NOT NULL,
        receipt_sha256 TEXT NOT NULL CHECK(length(receipt_sha256) = 64),
        created_at TEXT NOT NULL,
        UNIQUE(job_id, final_plan_sha256)
      );
      CREATE INDEX IF NOT EXISTS idx_analytics_job_results_version
        ON analytics_job_results(primary_version_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS analytics_job_nodes (
        id TEXT PRIMARY KEY CHECK(id GLOB 'ajn_[a-f0-9]*' AND length(id) = 36),
        job_id TEXT NOT NULL REFERENCES analytics_jobs(id) ON DELETE RESTRICT,
        plan_revision INTEGER NOT NULL CHECK(plan_revision >= 1),
        kind TEXT NOT NULL CHECK(kind IN (
          'source_resolution','transform_fragment','result_publication','answer_delivery','retain_delivery'
        )),
        adapter_version TEXT NOT NULL CHECK(length(adapter_version) BETWEEN 1 AND 128),
        state TEXT NOT NULL CHECK(state IN (
          'planned','ready','running','needs_input','needs_approval','waiting_external',
          'succeeded','blocked','failed','cancelled'
        )),
        state_revision INTEGER NOT NULL DEFAULT 1 CHECK(state_revision >= 1),
        logical_request_sha256 TEXT NOT NULL CHECK(length(logical_request_sha256) = 64),
        spec_json TEXT NOT NULL,
        spec_sha256 TEXT NOT NULL CHECK(length(spec_sha256) = 64),
        input_identity_json TEXT,
        input_identity_sha256 TEXT CHECK(input_identity_sha256 IS NULL OR length(input_identity_sha256) = 64),
        input_contract_sha256 TEXT CHECK(input_contract_sha256 IS NULL OR length(input_contract_sha256) = 64),
        current_attempt_id TEXT CHECK(current_attempt_id IS NULL OR (current_attempt_id GLOB 'aja_[a-f0-9]*' AND length(current_attempt_id) = 36)),
        lease_owner TEXT,
        lease_expires_at TEXT,
        heartbeat_at TEXT,
        output_dataset_id TEXT REFERENCES analytics_datasets(id) ON DELETE RESTRICT,
        output_version_id TEXT REFERENCES analytics_dataset_versions(id) ON DELETE RESTRICT,
        output_result_id TEXT REFERENCES analytics_job_results(id) ON DELETE RESTRICT,
        error_code TEXT,
        error_message TEXT,
        retry_class TEXT CHECK(retry_class IS NULL OR retry_class IN ('none','transient','owner_action','definition_change')),
        next_action TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        terminal_at TEXT,
        UNIQUE(job_id, plan_revision, logical_request_sha256),
        UNIQUE(job_id, plan_revision, id),
        UNIQUE(job_id, id),
        CHECK((input_identity_json IS NULL) = (input_identity_sha256 IS NULL))
      );
      CREATE INDEX IF NOT EXISTS idx_analytics_job_nodes_ready
        ON analytics_job_nodes(state, updated_at, id);
      CREATE INDEX IF NOT EXISTS idx_analytics_job_nodes_job
        ON analytics_job_nodes(job_id, plan_revision, kind, id);
      CREATE INDEX IF NOT EXISTS idx_analytics_job_nodes_version
        ON analytics_job_nodes(output_version_id, job_id);

      CREATE TABLE IF NOT EXISTS analytics_job_edges (
        job_id TEXT NOT NULL,
        plan_revision INTEGER NOT NULL CHECK(plan_revision >= 1),
        from_node_id TEXT NOT NULL,
        to_node_id TEXT NOT NULL,
        input_position INTEGER NOT NULL CHECK(input_position >= 0),
        input_name TEXT NOT NULL CHECK(length(input_name) BETWEEN 1 AND 160),
        created_at TEXT NOT NULL,
        PRIMARY KEY(job_id, plan_revision, from_node_id, to_node_id),
        UNIQUE(job_id, plan_revision, to_node_id, input_position),
        CHECK(from_node_id <> to_node_id),
        FOREIGN KEY(job_id, plan_revision, from_node_id)
          REFERENCES analytics_job_nodes(job_id, plan_revision, id) ON DELETE RESTRICT,
        FOREIGN KEY(job_id, plan_revision, to_node_id)
          REFERENCES analytics_job_nodes(job_id, plan_revision, id) ON DELETE RESTRICT
      );
      CREATE INDEX IF NOT EXISTS idx_analytics_job_edges_to
        ON analytics_job_edges(job_id, plan_revision, to_node_id, input_position);

      CREATE TABLE IF NOT EXISTS analytics_job_node_attempts (
        id TEXT PRIMARY KEY CHECK(id GLOB 'aja_[a-f0-9]*' AND length(id) = 36),
        job_id TEXT NOT NULL,
        node_id TEXT NOT NULL,
        attempt_ordinal INTEGER NOT NULL CHECK(attempt_ordinal >= 1),
        status TEXT NOT NULL CHECK(status IN (
          'running','waiting_external','succeeded','failed','cancelled','interrupted'
        )),
        invocation_ref_json TEXT,
        invocation_ref_sha256 TEXT CHECK(invocation_ref_sha256 IS NULL OR length(invocation_ref_sha256) = 64),
        checkpoint_json TEXT,
        checkpoint_sha256 TEXT CHECK(checkpoint_sha256 IS NULL OR length(checkpoint_sha256) = 64),
        checkpointed_at TEXT,
        receipt_json TEXT,
        receipt_sha256 TEXT CHECK(receipt_sha256 IS NULL OR length(receipt_sha256) = 64),
        retry_class TEXT CHECK(retry_class IS NULL OR retry_class IN ('none','transient','owner_action','definition_change')),
        error_code TEXT,
        error_message TEXT,
        next_action TEXT,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        UNIQUE(node_id, attempt_ordinal),
        CHECK((invocation_ref_json IS NULL) = (invocation_ref_sha256 IS NULL)),
        CHECK((checkpoint_json IS NULL) = (checkpoint_sha256 IS NULL)),
        CHECK((receipt_json IS NULL) = (receipt_sha256 IS NULL)),
        FOREIGN KEY(job_id, node_id)
          REFERENCES analytics_job_nodes(job_id, id) ON DELETE RESTRICT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_analytics_job_attempts_active
        ON analytics_job_node_attempts(node_id)
        WHERE status IN ('running','waiting_external');
      CREATE INDEX IF NOT EXISTS idx_analytics_job_attempts_job
        ON analytics_job_node_attempts(job_id, started_at, id);
    `);
  })();
}
