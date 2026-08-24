/**
 * Backfill — migrate pre-existing `work_items` into the lossless content model
 * and seed `projects` from existing active `nodes`
 * (lossless-capture-brain-pipeline R11).
 *
 * Idempotent (keyed by whether a row already has content_sha256) and
 * non-destructive: existing rows are preserved; their captured text is moved
 * into the ContentStore container; rows whose stored text sits at an old
 * truncation boundary are flagged `incomplete` + a `legacy_partial` failure
 * note (their original full content is unrecoverable — R11.3).
 */

import type Database from 'better-sqlite3';
import { existsSync } from 'fs';
import type { ContentStore } from './content-store.js';
import { refToColumns } from './content-store.js';
import type { BrainStore } from './brain-store.js';
import { newBrain } from './brain-store.js';
import type { FailureRecorder } from './failures.js';

export interface BackfillResult {
  itemsMigrated: number;
  itemsFlaggedPartial: number;
  projectsSeeded: number;
  itemsRoutedToProjects: number;
}

// Old capture caps — text landing exactly at these strongly implies truncation.
const OLD_CAP_BOUNDARY = 14900; // parsed_text was sliced at 15000

interface WorkItemRow {
  id: string;
  source: string;
  url: string | null;
  parsed_text: string | null;
  summary: string | null;
  metadata: string | null;
  content_sha256: string | null;
}

export interface Backfiller {
  run(): BackfillResult;
  backfillContent(): { migrated: number; flaggedPartial: number };
  seedProjectsFromNodes(): { seeded: number; routed: number };
}

export function createBackfiller(deps: {
  db: Database.Database;
  contentStore: ContentStore;
  brainStore: BrainStore;
  failures: FailureRecorder;
}): Backfiller {
  const { db, contentStore, brainStore, failures } = deps;

  function sourceAvailable(row: WorkItemRow): boolean {
    let meta: Record<string, unknown> = {};
    try { meta = row.metadata ? JSON.parse(row.metadata) : {}; } catch { /* ignore */ }
    const fp = typeof meta.filePath === 'string' ? meta.filePath : undefined;
    if (fp && existsSync(fp)) return true;
    if (row.url && row.url.startsWith('file://')) {
      const p = decodeURIComponent(row.url.slice('file://'.length));
      if (existsSync(p)) return true;
    }
    return false;
  }

  function backfillContent(): { migrated: number; flaggedPartial: number } {
    const rows = db
      .prepare('SELECT id, source, url, parsed_text, summary, metadata, content_sha256 FROM work_items WHERE content_sha256 IS NULL')
      .all() as WorkItemRow[];

    let migrated = 0;
    let flaggedPartial = 0;
    const update = db.prepare(
      `UPDATE work_items SET
         raw_text = ?, content_storage = ?, content_path = ?, content_sha256 = ?, content_bytes = ?,
         process_state = CASE WHEN process_state = 'captured' THEN 'extracted' ELSE process_state END
       WHERE id = ?`,
    );

    const tx = db.transaction(() => {
      for (const row of rows) {
        const text = row.parsed_text ?? row.summary ?? '';
        const ref = contentStore.put(row.id, text);
        const cols = refToColumns(ref);
        update.run(cols.raw_text, cols.content_storage, cols.content_path, cols.content_sha256, cols.content_bytes, row.id);
        migrated++;

        // Flag likely-truncated legacy content whose source is gone (R11.3).
        const likelyTruncated = text.length >= OLD_CAP_BOUNDARY && !sourceAvailable(row);
        if (likelyTruncated) {
          failures.record({
            itemId: row.id,
            step: 'migration',
            message: 'legacy_partial: content captured under the old truncating pipeline may be incomplete and the source is no longer available',
            retryable: false,
            markIncomplete: true,
          });
          flaggedPartial++;
        }
      }
    });
    tx();
    return { migrated, flaggedPartial };
  }

  function seedProjectsFromNodes(): { seeded: number; routed: number } {
    // Seed projects ONLY from genuine legacy nodes. The node-projection sync
    // (`syncNodesFromProjects`) mirrors every project/area back into the `nodes`
    // table with ids `area_*`, `proj_*`, and `node_unsorted`. If we seeded from
    // those we'd clone every project into a `proj_node_*` duplicate on every
    // boot — a feedback loop that geometrically multiplies projects. Exclude
    // the projection-owned mirror ids so only real legacy nodes are migrated.
    const nodes = db
      .prepare(
        `SELECT id, title, description FROM nodes
         WHERE status = 'active'
           AND id NOT LIKE 'area\\_%' ESCAPE '\\'
           AND id NOT LIKE 'proj\\_%' ESCAPE '\\'
           AND id NOT LIKE 'proj_node_%'
           AND id <> 'node_unsorted'`,
      )
      .all() as {
      id: string; title: string; description: string | null;
    }[];

    let seeded = 0;
    let routed = 0;
    for (const node of nodes) {
      const projectId = `proj_node_${node.id}`;
      if (!brainStore.getProject(projectId)) {
        const brain = newBrain(projectId, node.title);
        brain.summary = node.description ?? '';
        brainStore.write(brain, node.title);
        seeded++;
      }
      // Route items assigned to this node into the seeded project (continuity).
      const items = db
        .prepare('SELECT work_item_id AS id FROM node_work_items WHERE node_id = ?')
        .all(node.id) as { id: string }[];
      const routeStmt = db.prepare(
        `UPDATE work_items SET project_id = ?, process_state = 'routed'
         WHERE id = ? AND project_id IS NULL AND process_state IN ('captured','extracted')`,
      );
      const tx = db.transaction(() => {
        for (const it of items) {
          const r = routeStmt.run(projectId, it.id);
          if (r.changes > 0) routed++;
        }
      });
      tx();
    }
    return { seeded, routed };
  }

  return {
    backfillContent,
    seedProjectsFromNodes,
    run(): BackfillResult {
      const c = backfillContent();
      const p = seedProjectsFromNodes();
      return {
        itemsMigrated: c.migrated,
        itemsFlaggedPartial: c.flaggedPartial,
        projectsSeeded: p.seeded,
        itemsRoutedToProjects: p.routed,
      };
    },
  };
}
