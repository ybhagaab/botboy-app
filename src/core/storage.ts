import Database from 'better-sqlite3';
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

  // ── guarded workspace catalog + native page layouts migration ──
  migrateWorkspaceControl(db);
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
      error TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      published_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_dashboard_publications_dashboard
      ON dashboard_publications(dashboard_id, created_at);

    CREATE TABLE IF NOT EXISTS dashboard_share_requests (
      id TEXT PRIMARY KEY,
      dashboard_id TEXT NOT NULL REFERENCES analytics_dashboards(id) ON DELETE CASCADE,
      token_sha256 TEXT NOT NULL UNIQUE,
      expires_at TEXT NOT NULL,
      used_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

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

  const migratedRunColumns = new Set(
    (db.prepare('PRAGMA table_info(analytics_runs)').all() as Array<{ name: string }>).map(column => column.name),
  );
  if (!migratedRunColumns.has('worker_id')) db.exec('ALTER TABLE analytics_runs ADD COLUMN worker_id TEXT;');
  if (!migratedRunColumns.has('worker_pid')) db.exec('ALTER TABLE analytics_runs ADD COLUMN worker_pid INTEGER;');

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
      status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','completed','failed')),
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
            status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','completed','failed')),
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
