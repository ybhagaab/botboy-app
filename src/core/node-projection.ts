/**
 * Node projection — mirrors the Areas → Projects hierarchy into the legacy
 * `nodes` / `node_work_items` tables so the existing dashboard (which renders
 * nodes) shows the new organization natively:
 *
 *   Area   → root node   (parent_id = NULL, depth 0)
 *   Project→ child node   (parent_id = its area's node, depth 1)
 *   work_items(project_id) → node_work_items link on the project node
 *
 * Projects with no area go under a synthetic "Unsorted" root. The projection is
 * a pure SQL sync (no LLM) and is idempotent: it rebuilds all mirror nodes
 * (ids prefixed `area_`/`proj_`, plus `node_unsorted`) each run. Legacy nodes
 * (uuid ids, now archived) are never touched.
 */

import type Database from 'better-sqlite3';

const UNSORTED_ID = 'node_unsorted';

export interface ProjectionResult {
  areaNodes: number;
  projectNodes: number;
  itemLinks: number;
}

export function syncNodesFromProjects(db: Database.Database): ProjectionResult {
  const areas = db.prepare("SELECT id, title, description FROM areas WHERE COALESCE(status, 'active') != 'archived'").all() as { id: string; title: string; description: string | null }[];
  const projects = db.prepare('SELECT id, title, one_liner, area_id, status FROM projects').all() as {
    id: string; title: string; one_liner: string | null; area_id: string | null; status: string;
  }[];

  const result: ProjectionResult = { areaNodes: 0, projectNodes: 0, itemLinks: 0 };

  const tx = db.transaction(() => {
    // 1) Drop existing mirror nodes (cascades node_work_items via FK).
    db.prepare("DELETE FROM nodes WHERE id LIKE 'area_%' OR id LIKE 'proj_%' OR id = ?").run(UNSORTED_ID);

    const insNode = db.prepare(
      `INSERT INTO nodes (id, title, description, status, parent_id, depth, created_at, updated_at)
       VALUES (?, ?, ?, 'active', ?, ?, datetime('now'), datetime('now'))`,
    );

    // 2) Area root nodes.
    const areaIds = new Set<string>();
    for (const a of areas) {
      insNode.run(a.id, a.title, a.description ?? null, null, 0);
      areaIds.add(a.id);
      result.areaNodes++;
    }

    // 3) Unsorted root, only if some project has no (valid) area.
    const needUnsorted = projects.some((p) => !p.area_id || !areaIds.has(p.area_id));
    if (needUnsorted) {
      insNode.run(UNSORTED_ID, 'Unsorted', 'Projects not yet grouped into an area', null, 0);
      result.areaNodes++;
    }

    // 4) Project child nodes + item links.
    const linkStmt = db.prepare(
      "INSERT OR IGNORE INTO node_work_items (node_id, work_item_id, assigned_by) VALUES (?, ?, 'classifier')",
    );
    for (const p of projects) {
      if (p.status === 'archived') continue;
      const parent = p.area_id && areaIds.has(p.area_id) ? p.area_id : UNSORTED_ID;
      insNode.run(p.id, p.title, p.one_liner ?? null, parent, 1);
      result.projectNodes++;
      const items = db.prepare('SELECT id FROM work_items WHERE project_id = ?').all(p.id) as { id: string }[];
      for (const it of items) {
        const r = linkStmt.run(p.id, it.id);
        result.itemLinks += r.changes;
      }
    }
  });
  tx();
  return result;
}
