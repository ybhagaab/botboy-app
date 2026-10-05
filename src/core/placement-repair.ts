/**
 * Placement repair, once per store (owner decision 2026-10-05).
 *
 * Until 2026-10-05 two lexical gates overrode correct placements. The
 * librarian vetoed a model's placement into an existing project whenever
 * another project's title shared more product words with the item
 * ("evidence is more strongly anchored to independent scope: …"), and the
 * brain pass quarantined placed items for the same reason. On the owner's
 * store the veto overrode 260 placements, nearly all of them correct, and
 * 139 of those items were still orphaned. Both gates are retired
 * (librarian.ts, brain-updater.ts). This repair applies the same standard on
 * every store:
 *
 * - An orphan whose LATEST routing decision is that veto returns to the
 *   project the model chose, when that project is still active or paused,
 *   is not a source container, the owner never rejected the item from it,
 *   and the item still anchors the project's founding scope (the
 *   librarian's current rule). Each placement writes a routing audit row.
 * - A placed item the brain pass quarantined keeps its advisory alert with
 *   `quarantined: false`.
 * - The placement an owner request restored earlier that day
 *   (`OWNER_RESTORED_BATCH_ID`) was never synthesized either.
 *
 * All of these are then synthesized into their projects' brains, one project
 * per idle interpretation tick (pipeline-orchestrator.ts), so routing never
 * waits for the repair. The receipt in `app_settings` is written in the same
 * transaction as the placements and carries the brain work still owed, so a
 * restart resumes that work instead of repeating or losing it.
 */

import type Database from 'better-sqlite3';
import { getSetting, setSetting } from './storage.js';
import type { ContentRowColumns, ContentStore } from './content-store.js';
import type { BrainStore, ProjectRow } from './brain-store.js';
import { projectScopeAnchor } from './brain-store.js';
import type { BrainUpdater } from './brain-updater.js';
import type { PipelineLlm } from './pipeline-llm.js';
import { recordRoutingDecision } from './pipeline-audit.js';
import { evaluateProjectEvidenceScope, isSourceContainerProjectTitle } from './project-scope.js';

export const PLACEMENT_REPAIR_KEY = 'routing.placement_repair.v1';
/** Validation reason of the retired librarian veto (librarian.ts before 2026-10-05). */
export const EXCLUSIVITY_VETO_REASON_PREFIX = 'evidence is more strongly anchored to independent scope:';
/** Routing audit batch of every placement this repair makes. */
export const PLACEMENT_REPAIR_BATCH_ID = 'placement-repair:v1';
/**
 * Routing audit batch of the owner-requested placement that restored the
 * owner's event contract on 2026-10-05, before this repair existed. Its
 * brain update is owed too; on other stores this batch matches nothing.
 */
export const OWNER_RESTORED_BATCH_ID = 'owner-request:exclusivity-veto-removal';
/** Items per brain update: the brain rebuild's chunk size. */
export const PLACEMENT_REPAIR_SYNTHESIS_CHUNK = 12;

export type PlacementRepairSkipReason =
  | 'already_placed'
  | 'file_reference'
  | 'project_missing'
  | 'project_inactive'
  | 'source_container'
  | 'owner_rejected'
  | 'no_scope_anchor'
  | 'content_unreadable';

export interface PlacementRepairReceipt {
  placedAt: string;
  /** Orphans returned to the project the model chose. */
  placed: number;
  /** Placed items released from the brain-pass quarantine. */
  released: number;
  /** Placements an owner request restored earlier; only their brain update is owed. */
  ownerRestored: number;
  /** Vetoed orphans left as they are, by reason. */
  skipped: Partial<Record<PlacementRepairSkipReason, number>>;
  /**
   * Brain synthesis still owed: one entry per project, oldest evidence first.
   * `retry` marks a chunk's single second try after a model failure.
   */
  pending: Array<{ projectId: string; itemIds: string[]; retry?: true }>;
  /** Brain update outcomes so far, one count per update call. */
  synthesis: Record<string, number>;
  synthesizedAt?: string;
}

export type PlacementRepairTick =
  | { ran: false }
  | { ran: true; step: 'placed'; placed: number; released: number; ownerRestored: number; projects: number }
  | { ran: true; step: 'synthesized'; projectId: string; itemIds: string[]; remainingProjects: number };

export interface PlacementRepair {
  /** True once the placements are made and every owed brain update has run. */
  isDone(): boolean;
  receipt(): PlacementRepairReceipt | null;
  /**
   * One step: the placements (once), else one project's brain synthesis.
   * The caller holds the interpretation lock (pipeline-orchestrator.ts).
   */
  tick(reader: Pick<BrainUpdater, 'updateProject'>): Promise<PlacementRepairTick>;
}

interface VetoedRow {
  id: string;
  title: string | null;
  type: string;
  state: string;
  projectId: string | null;
  requestedProjectId: string | null;
}

interface Placement {
  itemId: string;
  projectId: string;
  reason: string;
}

function isActive(project: ProjectRow | null): project is ProjectRow {
  return Boolean(project && (project.status === 'active' || project.status === 'paused'));
}

function countSkip(skipped: PlacementRepairReceipt['skipped'], reason: PlacementRepairSkipReason): void {
  skipped[reason] = (skipped[reason] ?? 0) + 1;
}

export function createPlacementRepair(deps: {
  db: Database.Database;
  contentStore: Pick<ContentStore, 'refFromRow' | 'get'>;
  brainStore: Pick<BrainStore, 'getProject'>;
  /** Brain synthesis waits while the model is unreachable; placements do not. */
  llm: Pick<PipelineLlm, 'isAvailable'>;
  yieldToLoop?: () => Promise<void>;
  now?: () => Date;
}): PlacementRepair {
  const { db, contentStore, brainStore, llm } = deps;
  const yieldToLoop = deps.yieldToLoop ?? (() => new Promise<void>((resolve) => setImmediate(resolve)));
  const now = deps.now ?? (() => new Date());

  // The latest decision per item decides: a later decision (a reconciler
  // adoption, an owner request) supersedes the veto.
  const vetoedStmt = db.prepare(`
    SELECT w.id AS id, w.title AS title, w.type AS type, w.process_state AS state,
           w.project_id AS projectId, d.requested_project_id AS requestedProjectId
    FROM routing_decisions d
    JOIN work_items w ON w.id = d.item_id
    WHERE d.model_decision = 'assign'
      AND d.applied_decision = 'orphan'
      AND substr(d.validation_reason, 1, ${EXCLUSIVITY_VETO_REASON_PREFIX.length}) = @prefix
      AND d.id = (SELECT MAX(latest.id) FROM routing_decisions latest WHERE latest.item_id = d.item_id)
    ORDER BY w.captured_at ASC, w.rowid ASC
  `);
  const contentStmt = db.prepare(
    'SELECT raw_text, content_storage, content_path, content_sha256, content_bytes FROM work_items WHERE id = ?',
  );
  const rejectedStmt = db.prepare('SELECT 1 FROM work_item_rejections WHERE work_item_id = ? AND project_id = ?');
  // The batcher's orphaned → routed transition as a compare-and-set: an item
  // the owner moved or placed meanwhile is left alone.
  const placeStmt = db.prepare(`
    UPDATE work_items SET process_state = 'routed', project_id = ?
    WHERE id = ? AND process_state = 'orphaned' AND project_id IS NULL AND type <> 'file_reference'
  `);
  const quarantinedStmt = db.prepare(`
    SELECT id, project_id AS projectId, scope_alert AS scopeAlert
    FROM work_items
    WHERE scope_alert IS NOT NULL AND json_valid(scope_alert)
      AND json_extract(scope_alert, '$.quarantined') = 1
      AND process_state = 'routed' AND project_id IS NOT NULL AND type <> 'file_reference'
    ORDER BY captured_at ASC, rowid ASC
  `);
  const setAlertStmt = db.prepare('UPDATE work_items SET scope_alert = ? WHERE id = ?');
  const ownerRestoredStmt = db.prepare(`
    SELECT w.id AS id, w.project_id AS projectId
    FROM routing_decisions d
    JOIN work_items w ON w.id = d.item_id
    WHERE d.batch_id = ? AND d.applied_decision = 'assign'
      AND d.id = (SELECT MAX(latest.id) FROM routing_decisions latest WHERE latest.item_id = d.item_id)
      AND w.process_state = 'routed' AND w.project_id = d.applied_project_id AND w.type <> 'file_reference'
    ORDER BY w.captured_at ASC, w.rowid ASC
  `);
  const stillPlacedStmt = db.prepare(`
    SELECT id FROM work_items
    WHERE id = ? AND project_id = ? AND process_state = 'routed' AND type <> 'file_reference'
  `);
  const runStmt = db.prepare(`
    INSERT INTO pipeline_runs (id, pass, batch_id, items_in, items_out, status, completed_at)
    VALUES (?, 'reconcile', ?, ?, ?, 'completed', datetime('now'))
  `);

  function receipt(): PlacementRepairReceipt | null {
    return getSetting<PlacementRepairReceipt>(db, PLACEMENT_REPAIR_KEY);
  }

  function readEvidence(row: VetoedRow): string | null {
    const columns = contentStmt.get(row.id) as ContentRowColumns | undefined;
    const ref = columns ? contentStore.refFromRow(columns) : null;
    try {
      return `${row.title ?? ''}\n${ref ? contentStore.get(ref) : ''}`;
    } catch {
      return null;
    }
  }

  /** Read-only: which vetoed orphans the librarian's current rule accepts. */
  async function evaluate(): Promise<{ placements: Placement[]; skipped: PlacementRepairReceipt['skipped'] }> {
    const skipped: PlacementRepairReceipt['skipped'] = {};
    const skip = (reason: PlacementRepairSkipReason): void => countSkip(skipped, reason);
    const placements: Placement[] = [];
    const rows = vetoedStmt.all({ prefix: EXCLUSIVITY_VETO_REASON_PREFIX }) as VetoedRow[];
    for (const row of rows) {
      if (row.type === 'file_reference') { skip('file_reference'); continue; }
      if (row.state !== 'orphaned' || row.projectId !== null) { skip('already_placed'); continue; }
      const project = row.requestedProjectId ? brainStore.getProject(row.requestedProjectId) : null;
      if (!project) { skip('project_missing'); continue; }
      if (!isActive(project)) { skip('project_inactive'); continue; }
      if (isSourceContainerProjectTitle(project.title)) { skip('source_container'); continue; }
      if (rejectedStmt.get(row.id, project.id)) { skip('owner_rejected'); continue; }
      const evidence = readEvidence(row);
      if (evidence === null) { skip('content_unreadable'); continue; }
      const scope = evaluateProjectEvidenceScope(projectScopeAnchor(project), evidence);
      if (!scope.matches) { skip('no_scope_anchor'); continue; }
      placements.push({ itemId: row.id, projectId: project.id, reason: scope.reason });
      // Long documents index their whole text; let the event loop breathe.
      await yieldToLoop();
    }
    return { placements, skipped };
  }

  async function place(): Promise<PlacementRepairTick> {
    const { placements, skipped } = await evaluate();
    const at = now().toISOString();
    const runId = `placement-repair:${at}`;
    const pending = new Map<string, string[]>();
    const owe = (projectId: string, itemId: string): void => {
      if (!pending.has(projectId)) pending.set(projectId, []);
      pending.get(projectId)!.push(itemId);
    };

    const result = db.transaction(() => {
      let placed = 0;
      for (const placement of placements) {
        // State may have moved while evaluation yielded; re-check, then set.
        const project = brainStore.getProject(placement.projectId);
        if (!project) { countSkip(skipped, 'project_missing'); continue; }
        if (!isActive(project)) { countSkip(skipped, 'project_inactive'); continue; }
        if (rejectedStmt.get(placement.itemId, placement.projectId)) { countSkip(skipped, 'owner_rejected'); continue; }
        if (placeStmt.run(placement.projectId, placement.itemId).changes !== 1) {
          countSkip(skipped, 'already_placed');
          continue;
        }
        recordRoutingDecision(db, {
          runId,
          batchId: PLACEMENT_REPAIR_BATCH_ID,
          itemId: placement.itemId,
          modelDecision: 'assign',
          requestedProjectId: placement.projectId,
          appliedDecision: 'assign',
          appliedProjectId: placement.projectId,
          validationReason: `restored model placement (exclusivity veto retired 2026-10-05): ${placement.reason}`,
        });
        owe(placement.projectId, placement.itemId);
        placed++;
      }

      let released = 0;
      for (const row of quarantinedStmt.all() as Array<{ id: string; projectId: string; scopeAlert: string }>) {
        let alert: Record<string, unknown>;
        try { alert = JSON.parse(row.scopeAlert) as Record<string, unknown>; } catch { continue; }
        setAlertStmt.run(JSON.stringify({ ...alert, quarantined: false, releasedAt: at }), row.id);
        owe(row.projectId, row.id);
        released++;
      }

      let ownerRestored = 0;
      for (const row of ownerRestoredStmt.all(OWNER_RESTORED_BATCH_ID) as Array<{ id: string; projectId: string }>) {
        owe(row.projectId, row.id);
        ownerRestored++;
      }

      const value: PlacementRepairReceipt = {
        placedAt: at,
        placed,
        released,
        ownerRestored,
        skipped,
        pending: [...pending].map(([projectId, itemIds]) => ({ projectId, itemIds })),
        synthesis: {},
      };
      if (value.pending.length === 0) value.synthesizedAt = at;
      runStmt.run(runId, PLACEMENT_REPAIR_BATCH_ID, placements.length + released, placed + released);
      setSetting(db, PLACEMENT_REPAIR_KEY, value);
      return value;
    })();

    console.log(
      `[Pipeline] Placement repair: returned ${result.placed} orphan(s) to the projects the model chose, `
      + `released ${result.released} quarantined item(s), ${result.ownerRestored} owner-restored placement(s) to update; `
      + `brain updates owed for ${result.pending.length} project(s); left as they are: ${JSON.stringify(result.skipped)}`,
    );
    if (result.pending.length === 0) return { ran: false };
    return {
      ran: true, step: 'placed', placed: result.placed, released: result.released,
      ownerRestored: result.ownerRestored, projects: result.pending.length,
    };
  }

  async function synthesizeNext(
    state: PlacementRepairReceipt,
    reader: Pick<BrainUpdater, 'updateProject'>,
  ): Promise<PlacementRepairTick> {
    if (!llm.isAvailable()) return { ran: false };
    const entry = state.pending[0];
    const project = brainStore.getProject(entry.projectId);
    // Items the owner moved, rejected, or deleted meanwhile are not owed here.
    const itemIds = isActive(project)
      ? entry.itemIds.filter((itemId) => stillPlacedStmt.get(itemId, entry.projectId))
      : [];
    const outcomes: Record<string, number> = {};
    let remaining = itemIds;
    while (remaining.length > 0) {
      const chunk = remaining.slice(0, PLACEMENT_REPAIR_SYNTHESIS_CHUNK);
      remaining = remaining.slice(PLACEMENT_REPAIR_SYNTHESIS_CHUNK);
      // Progress is saved before the update runs, so a crash or a throwing
      // update never repeats the chunk or loops on it.
      state.pending[0] = { ...entry, itemIds: remaining };
      setSetting(db, PLACEMENT_REPAIR_KEY, state);
      const result = await reader.updateProject(entry.projectId, chunk);
      const outcome = result.status === 'skipped' ? `skipped:${result.skipReason ?? 'unknown'}` : result.status;
      state.synthesis[outcome] = (state.synthesis[outcome] ?? 0) + 1;
      outcomes[outcome] = (outcomes[outcome] ?? 0) + 1;
      // A model failure (a provider 500, a timeout) gets one more try, after
      // the rest of the queue.
      if (result.skipReason === 'model_failure' && !entry.retry) {
        state.pending.push({ projectId: entry.projectId, itemIds: chunk, retry: true });
      }
    }
    state.pending.shift();
    if (state.pending.length === 0) state.synthesizedAt = now().toISOString();
    setSetting(db, PLACEMENT_REPAIR_KEY, state);
    console.log(
      `[Brain] Placement repair: ${itemIds.length} item(s) for ${entry.projectId}${entry.retry ? ' (retry)' : ''}: `
      + `${JSON.stringify(outcomes)} (${state.pending.length} left)`,
    );
    return { ran: true, step: 'synthesized', projectId: entry.projectId, itemIds, remainingProjects: state.pending.length };
  }

  return {
    isDone(): boolean {
      const state = receipt();
      return Boolean(state && state.pending.length === 0);
    },
    receipt,
    async tick(reader): Promise<PlacementRepairTick> {
      const state = receipt();
      if (!state) return place();
      if (state.pending.length === 0) return { ran: false };
      return synthesizeNext(state, reader);
    },
  };
}
