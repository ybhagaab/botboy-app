import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';

interface VersionPart {
  count: number;
  rowId: number;
  stamp: string;
  state: number;
}

function part(
  db: Database.Database,
  table: string,
  stampExpression = "''",
  stateExpression = '0',
  whereClause = '',
): VersionPart {
  try {
    return db.prepare(`
      SELECT COUNT(*) AS count,
        COALESCE(MAX(rowid), 0) AS rowId,
        COALESCE(MAX(${stampExpression}), '') AS stamp,
        COALESCE(SUM(${stateExpression}), 0) AS state
      FROM ${table} ${whereClause}
    `).get() as VersionPart;
  } catch {
    return { count: 0, rowId: 0, stamp: '', state: 0 };
  }
}

/**
 * Opaque cache receipt for the bounded owner catalog. It intentionally tracks
 * only state rendered by the Data Room UI. Heartbeats, leases, private paths,
 * and integrity-check timestamps do not invalidate an otherwise unchanged
 * owner projection.
 */
export function readAnalyticsDataRoomVersion(db?: Database.Database): string {
  if (!db) return '0';
  try {
    const singleton = db.prepare(`
      SELECT revision FROM analytics_data_room_state WHERE singleton = 1
    `).get() as { revision: number } | undefined;
    const value = [
      2,
      Number(singleton?.revision ?? 0),
      part(db, 'analytics_datasets', 'updated_at'),
      part(db, 'analytics_dataset_heads', 'promoted_at', 'head_revision'),
      part(db, 'analytics_dataset_versions', 'created_at', "CASE integrity_status WHEN 'verified' THEN 1 WHEN 'quarantined' THEN 2 ELSE 0 END"),
      part(db, 'analytics_dataset_assertion_evaluations', 'created_at', 'success'),
      part(db, 'analytics_dataset_dependencies'),
      part(db, 'analytics_dataset_project_links', 'linked_at'),
      part(db, 'analytics_dataset_dashboard_owners', 'claimed_at'),
      part(db, 'analytics_dataset_runs', "COALESCE(completed_at, started_at, queued_at)", "CASE status WHEN 'staging' THEN 1 WHEN 'verifying' THEN 2 WHEN 'completed' THEN 3 WHEN 'failed' THEN 4 ELSE 0 END"),
      part(db, 'analytics_derived_runs', "COALESCE(completed_at, started_at, queued_at)", "CASE status WHEN 'queued' THEN 1 WHEN 'running' THEN 2 WHEN 'completed' THEN 3 WHEN 'failed' THEN 4 ELSE 0 END"),
      part(db, 'analytics_derived_dirty', 'invalidated_at', "CASE status WHEN 'pending' THEN 1 WHEN 'blocked' THEN 2 ELSE 0 END"),
      part(db, 'analytics_dataset_version_inputs'),
      part(db, 'analytics_derived_run_assertions', 'created_at', 'success'),
      part(db, 'analytics_widget_dataset_bindings', 'updated_at', 'revision'),
      part(db, 'analytics_dataset_controls', 'updated_at', 'control_revision'),
      // R6 source-availability cards derive only coarse counts from these
      // immutable captures. Keep them on the existing room receipt so a new
      // workbook/mail capture refreshes the visible cards without a timer.
      part(
        db,
        'work_items',
        'created_at',
        "CASE WHEN source IN ('grasp','gmail') THEN 2 ELSE 1 END",
        `WHERE (
          source IN ('filesystem','sharepoint')
          AND (
            LOWER(COALESCE(json_extract(metadata, '$.fileType'), '')) IN ('xlsx','.xlsx')
            OR LOWER(COALESCE(url, '')) LIKE '%.xlsx'
          )
        ) OR (
          source IN ('grasp','gmail')
          AND LOWER(COALESCE(json_extract(metadata, '$.hasAttachments'), '')) = 'true'
        )`,
      ),
    ];
    return createHash('sha256').update(JSON.stringify(value)).digest('hex');
  } catch {
    return '0';
  }
}
