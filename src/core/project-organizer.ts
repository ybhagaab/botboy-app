/**
 * Project Organizer — the hierarchy layer. Periodically reads all projects and
 * uses the LLM to cluster them into higher-level "areas" by relevance, so the
 * flat project list rolls up into a two-level tree (Areas → Projects).
 *
 * Areas are lightweight groupings (title + description) stored in the `areas`
 * table; each project carries an `area_id`. The organizer can create new areas,
 * reuse existing ones, and re-assign projects as the picture evolves.
 *
 * Like the other interpretation passes it prefers the remote LLM and defers if
 * it's unavailable (no project is lost — area_id simply stays as-is).
 */

import { randomUUID } from 'crypto';
import type Database from 'better-sqlite3';
import type { BrainStore } from './brain-store.js';
import type { FailureRecorder } from './failures.js';
import type { PipelineLlm } from './pipeline-llm.js';
import { extractJson } from './pipeline-llm.js';

export interface Area {
  id: string;
  title: string;
  description: string | null;
  status: 'active' | 'archived';
  owner_managed: number;
  version: number;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface OrganizeResult {
  status: 'deferred' | 'completed' | 'skipped';
  areasCreated: number;
  areasUpdated: number;
  projectsAssigned: number;
}

export interface OrganizeOptions {
  /**
   * full=false (default, used by the scheduled tick): assign ONLY projects
   * that have no valid area yet — zero LLM calls when nothing is unassigned,
   * and existing assignments can never move. full=true (manual/deliberate):
   * rebalance everything, anchored to current assignments.
   *
   * Post-mortem 2026-08-04: the tick used to re-cluster ALL projects from
   * scratch every 30 minutes without telling the LLM their current areas —
   * non-deterministic output made projects hop areas on every pass ("random
   * confused sub nodes" under Analytics).
   */
  full?: boolean;
}

export interface ProjectOrganizer {
  organize(opts?: OrganizeOptions): Promise<OrganizeResult>;
}

// ── Area helpers ───────────────────────────────────────────────────────────

export function listAreas(db: Database.Database): Area[] {
  return db.prepare("SELECT * FROM areas WHERE COALESCE(status, 'active') != 'archived' ORDER BY updated_at DESC").all() as Area[];
}

export interface AreaWithProjects extends Area {
  projects: { id: string; title: string; status: string; one_liner: string | null; itemCount: number }[];
}

/** Areas with their projects nested, plus an "Unsorted" bucket for projects
 *  not yet assigned to any area. */
export function listAreasWithProjects(db: Database.Database): AreaWithProjects[] {
  const areas = listAreas(db);
  const projRows = db
    .prepare(
      `SELECT p.id, p.title, p.status, p.one_liner, p.area_id,
              (SELECT COUNT(*) FROM work_items w WHERE w.project_id = p.id) AS itemCount
       FROM projects p
       WHERE p.status != 'archived'
       ORDER BY p.updated_at DESC`,
    )
    .all() as { id: string; title: string; status: string; one_liner: string | null; area_id: string | null; itemCount: number }[];

  const byArea = new Map<string, AreaWithProjects>();
  for (const a of areas) byArea.set(a.id, { ...a, projects: [] });
  const unsorted: AreaWithProjects = {
    id: '__unsorted__', title: 'Unsorted', description: 'Projects not yet grouped into an area',
    status: 'active', owner_managed: 0, version: 1, archived_at: null,
    created_at: '', updated_at: '', projects: [],
  };
  for (const p of projRows) {
    const target = (p.area_id && byArea.get(p.area_id)) || unsorted;
    target.projects.push({ id: p.id, title: p.title, status: p.status, one_liner: p.one_liner, itemCount: p.itemCount });
  }
  const result = [...byArea.values()].filter((area) => area.projects.length > 0 || area.owner_managed === 1);
  if (unsorted.projects.length > 0) result.push(unsorted);
  return result;
}

// ── Organizer ────────────────────────────────────────────────────────────

interface AreaGroup {
  areaId?: string; // existing area to reuse
  title?: string; // title for a new (or existing) area
  description?: string;
  projectIds: string[];
}

export function createProjectOrganizer(deps: {
  db: Database.Database;
  brainStore: BrainStore;
  llm: PipelineLlm;
  failures: FailureRecorder;
  /** Don't run unless there are at least this many projects (default 3). */
  minProjects?: number;
}): ProjectOrganizer {
  const { db, brainStore, llm, failures } = deps;
  const minProjects = deps.minProjects ?? 3;

  function upsertArea(area: { id: string; title: string; description?: string }): void {
    db.prepare(
      `INSERT INTO areas (id, title, description, created_at, updated_at)
       VALUES (?, ?, ?, datetime('now'), datetime('now'))
       ON CONFLICT(id) DO UPDATE SET
         title = CASE WHEN areas.owner_managed = 1 THEN areas.title ELSE excluded.title END,
         description = CASE WHEN areas.owner_managed = 1 THEN areas.description ELSE excluded.description END,
         version = CASE WHEN areas.owner_managed = 1 THEN areas.version ELSE areas.version + 1 END,
         updated_at = CASE WHEN areas.owner_managed = 1 THEN areas.updated_at ELSE datetime('now') END`,
    ).run(area.id, area.title, area.description ?? null);
  }

  return {
    async organize(opts?: OrganizeOptions): Promise<OrganizeResult> {
      const full = opts?.full === true;
      const base: OrganizeResult = { status: 'completed', areasCreated: 0, areasUpdated: 0, projectsAssigned: 0 };
      if (!llm.isAvailable()) return { ...base, status: 'deferred' };

      const projects = brainStore.listProjects().filter((p) => p.status === 'active' || p.status === 'paused');
      if (projects.length < minProjects) return { ...base, status: 'skipped' };

      const existingAreas = listAreas(db);
      const areaTitleById = new Map(existingAreas.map((a) => [a.id, a.title]));
      const validAreaIds = new Set(existingAreas.map((a) => a.id));
      // Current placement straight from the DB (listProjects may not carry area_id).
      const currentArea = new Map<string, string | null>(
        (db.prepare('SELECT id, area_id FROM projects').all() as { id: string; area_id: string | null }[])
          .map((r) => [r.id, r.area_id && validAreaIds.has(r.area_id) ? r.area_id : null]),
      );

      const placementLocked = new Set(
        (db.prepare('SELECT id FROM projects WHERE placement_locked = 1').all() as { id: string }[])
          .map((row) => row.id),
      );

      // Scheduled mode: only unlocked projects with no valid area are
      // candidates. Full mode may rebalance unlocked projects, but an explicit
      // owner placement remains mechanically out of scope in both modes.
      const candidates = full
        ? projects.filter((project) => !placementLocked.has(project.id))
        : projects.filter((project) => !placementLocked.has(project.id) && !currentArea.get(project.id));
      if (candidates.length === 0) return { ...base, status: 'skipped' };

      // Per-project signals so the LLM can judge growth/promotion, not just
      // titles: item volume and recency.
      const stats = new Map<string, { items: number; lastAt: string | null }>(
        (db.prepare('SELECT project_id, COUNT(*) AS c, MAX(captured_at) AS last FROM work_items WHERE project_id IS NOT NULL GROUP BY project_id').all() as any[])
          .map((r) => [r.project_id, { items: r.c, lastAt: r.last }]),
      );
      const daysAgo = (iso: string | null): string => {
        if (!iso) return 'no items yet';
        const d = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
        return d <= 0 ? 'active today' : `active ${d}d ago`;
      };
      const projLine = (p: { id: string; title: string; one_liner?: string | null }) => {
        const s = stats.get(p.id);
        return `  - ${p.id}  "${p.title}"${p.one_liner ? ` — ${p.one_liner}` : ''}  [${s ? `${s.items} items, ${daysAgo(s.lastAt)}` : 'no items yet'}]`;
      };

      // CURRENT HIERARCHY — the clean, complete picture of the existing state.
      // This is the baseline the LLM evolves from (post-mortem 2026-08-04: the
      // old prompt hid current membership entirely, so every pass re-decided
      // from scratch and projects hopped areas randomly).
      const byAreaMembers = new Map<string, typeof projects>();
      const unsortedMembers: typeof projects = [];
      for (const p of projects) {
        const cur = currentArea.get(p.id);
        if (cur) {
          const list = byAreaMembers.get(cur) ?? [];
          list.push(p);
          byAreaMembers.set(cur, list);
        } else {
          unsortedMembers.push(p);
        }
      }
      const hierarchyLines: string[] = [];
      for (const a of existingAreas) {
        hierarchyLines.push(`## ${a.id}  "${a.title}"${a.description ? ` — ${a.description}` : ''}`);
        const members = byAreaMembers.get(a.id) ?? [];
        if (members.length === 0) hierarchyLines.push('  (no projects)');
        else if (full) for (const m of members) hierarchyLines.push(projLine(m));
        else {
          // assign-only: a compact sample is enough context for placement
          for (const m of members.slice(0, 5)) hierarchyLines.push(`  • "${m.title}"`);
          if (members.length > 5) hierarchyLines.push(`  • …and ${members.length - 5} more`);
        }
      }
      if (unsortedMembers.length > 0) {
        hierarchyLines.push('## (unsorted — not yet in any area)');
        for (const m of unsortedMembers) hierarchyLines.push(projLine(m));
      }
      const hierarchy = hierarchyLines.length ? hierarchyLines.join('\n') : '(no areas yet)';

      const prompt = full
        ? `You maintain the EVOLVING two-level hierarchy of a person's work tracker:
AREAS (primary themes / workstreams) contain PROJECTS (focused efforts).

CURRENT HIERARCHY (the baseline you evolve — result of all previous passes):
${hierarchy}

HOW THE HIERARCHY EVOLVES — apply these rules in order:
1. STABILITY FIRST. A project's logical relation rarely changes; keep it in
   its current area unless one of the rules below clearly applies. Gratuitous
   reshuffling destroys the user's mental map.
2. GROWTH & PROMOTION. Projects expand in scope as items accumulate. When a
   project has grown large and complex relative to its siblings (high item
   count, sustained activity, pulls in cross-functional themes, or clearly
   contains sub-themes of its own), PROMOTE it: create a NEW area named after
   its broader theme (omit areaId), put the project in it, and move any
   closely-related projects in with it. The logical path must stay traceable —
   the new area's title/description should make obvious where it came from.
3. MERGE near-duplicate or heavily-overlapping areas (e.g. "X Research" vs
   "X (Extended)"): pick ONE canonical area (reuse its areaId, refine its
   title/description if needed) and assign the other's projects to it. An
   area left with no projects is deleted automatically.
4. RENAME an area (reuse its areaId with a new title) when its actual theme
   has drifted from its name.
5. NEVER invent a near-duplicate of an existing area title. Every project
   ends in exactly one area. Aim for 3–10 meaningful areas; a one-project
   area is only justified by rule 2 (a fresh promotion).

Return ONLY JSON:
{"areas":[{"areaId":"<existing id when reusing/renaming, omit for NEW areas incl. promotions>","title":"<area title>","description":"<one line>","projectIds":["<project id>", ...]}]}`
        : `You place NEW projects into a person's existing work hierarchy:
AREAS (primary themes / workstreams) contain PROJECTS (focused efforts).

CURRENT HIERARCHY (do not reorganize it — it is context, not input):
${hierarchy}

Place each project listed under "(unsorted)" into the best EXISTING area by
its areaId. Only propose a new area when no existing one fits at all, and
never invent a near-duplicate of an existing area title. (Broader evolution —
promotions, merges, renames — happens in a separate periodic full pass.)

Return ONLY JSON:
{"areas":[{"areaId":"<existing id if reusing, else omit>","title":"<area title>","description":"<one line>","projectIds":["<project id>", ...]}]}`;

      const runId = randomUUID();
      try {
        db.prepare("INSERT INTO pipeline_runs (id, pass, batch_id, items_in, status) VALUES (?, 'organize', ?, ?, 'running')")
          .run(runId, full ? 'full' : 'assign-only', candidates.length);
      } catch (err: any) {
        console.warn(`[Organizer] could not record run: ${err?.message ?? err}`);
      }

      let parsed: { areas?: AreaGroup[] } | null = null;
      try {
        parsed = extractJson<{ areas?: AreaGroup[] }>(await llm.complete(prompt));
      } catch (err) {
        failures.record({ step: 'brain', message: `organize failed: ${(err as Error).message}`, retryable: true });
        try { db.prepare("UPDATE pipeline_runs SET status='failed', completed_at=datetime('now') WHERE id=?").run(runId); } catch {}
        return base;
      }
      if (!parsed?.areas) return base;

      // Only candidates may be (re)assigned — in assign-only mode this makes
      // it mechanically impossible for the LLM to move an already-placed
      // project, even if it returns extra ids.
      const validProjectIds = new Set(candidates.map((p) => p.id));
      const assign = db.prepare(`
        UPDATE projects SET area_id = ?, version = version + 1, updated_at = datetime('now')
        WHERE id = ? AND placement_locked = 0
      `);
      // Resolve an area group to a STABLE area id, deduping by title. The LLM
      // usually proposes a title without echoing back the existing `areaId`, so
      // matching purely on areaId would spawn a new area with the same title on
      // every run (leaving the old one empty). We therefore reuse by: explicit
      // areaId → normalized title match (against existing + areas created this
      // run) → only then create a new area.
      const norm = (t: string) => t.trim().toLowerCase();
      const byTitle = new Map<string, string>(); // normalized title → area id
      for (const a of existingAreas) byTitle.set(norm(a.title), a.id);

      const tx = db.transaction(() => {
        for (const g of parsed!.areas!) {
          const members = (g.projectIds || []).filter((id) => validProjectIds.has(id));
          if (members.length === 0 || (!g.title && !g.areaId)) continue;

          const byId: Area | undefined = g.areaId ? existingAreas.find((a) => a.id === g.areaId) : undefined;
          const title = g.title || byId?.title || 'Area';
          const titleMatchId = byTitle.get(norm(title));

          let areaId: string;
          let isExisting: boolean;
          if (byId) {
            areaId = byId.id; isExisting = true;
          } else if (titleMatchId) {
            areaId = titleMatchId; isExisting = true;
          } else {
            areaId = `area_${randomUUID().slice(0, 8)}`; isExisting = false;
          }

          upsertArea({ id: areaId, title, description: g.description });
          byTitle.set(norm(title), areaId);
          if (isExisting) base.areasUpdated++; else base.areasCreated++;
          for (const pid of members) {
            base.projectsAssigned += assign.run(areaId, pid).changes;
          }
        }
      });
      tx();

      // Remove empty organizer-owned areas only. Owner-managed and archived
      // areas are durable workspace objects even when they currently have no projects.
      db.prepare(`
        DELETE FROM areas
        WHERE owner_managed = 0
          AND COALESCE(status, 'active') != 'archived'
          AND id NOT IN (SELECT DISTINCT area_id FROM projects WHERE area_id IS NOT NULL)
      `).run();

      try { db.prepare("UPDATE pipeline_runs SET items_out=?, status='completed', completed_at=datetime('now') WHERE id=?").run(base.projectsAssigned, runId); } catch {}
      return base;
    },
  };
}
