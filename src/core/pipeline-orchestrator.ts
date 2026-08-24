/**
 * Pipeline Orchestrator — coordinates the interpretation plane
 * (lossless-capture-brain-pipeline R10). Replaces the old
 * `background-processor` timer loop.
 *
 * Responsibilities:
 *   - Extraction: drain `captured` items through the extractor with BOUNDED
 *     concurrency (default 2) so parse/OCR never saturate the laptop (R10.2a).
 *   - Interpretation: when the batcher says a wave should fire, run the
 *     librarian then the brain-updater for that batch. Passes prefer the remote
 *     LLM and defer when it is down (R10.2/R10.3) — no item is lost.
 *   - Reconciliation: run periodically.
 *   - No local embedding model is invoked anywhere (R10.1).
 *
 * The tick methods are exposed for deterministic testing; `start()` schedules
 * them on timers.
 */

import type Database from 'better-sqlite3';
import type { Extractor } from './extractor.js';
import type { Batcher } from './batcher.js';
import type { Librarian } from './librarian.js';
import type { BrainUpdater } from './brain-updater.js';
import type { Reconciler } from './reconciler.js';
import type { ProjectOrganizer } from './project-organizer.js';
import type { ChannelDigester } from './channel-digest.js';
import type { BrainStore } from './brain-store.js';
import { newBrain } from './brain-store.js';
import { syncNodesFromProjects } from './node-projection.js';

export interface OrchestratorConfig {
  extractionConcurrency?: number; // default 2
  extractionIntervalMs?: number; // default 15s
  interpretationIntervalMs?: number; // default 60s
  reconcileIntervalMs?: number; // default 6h
  organizeIntervalMs?: number; // default 30m (assign-only — places new projects)
  /**
   * Cadence of the FULL evolution pass (anchored recluster: growth-based
   * promotions to primary areas, merges, renames). Default 24h. The 30-min
   * tick stays assign-only so the hierarchy is stable within a working day.
   */
  fullOrganizeIntervalMs?: number; // default 24h
  /** Cadence of the ambient channel-digest pass (default 6h). */
  digestIntervalMs?: number;
}

export interface DrainResult {
  extracted: number;
  waves: number;
  routed: number;
  created: number;
  orphaned: number;
  noise: number;
  projectsUpdated: number;
}

export interface PipelineOrchestrator {
  /** Extract up to `concurrency` captured items; returns how many processed. */
  tickExtraction(): Promise<number>;
  /** Run a librarian wave + brain update if a wave should fire. */
  tickInterpretation(): Promise<{ ran: boolean; batchId?: string }>;
  /** Run a reconciliation pass. */
  tickReconcile(): Promise<void>;
  /**
   * Run the project→area organization (hierarchy) pass. The scheduled timer
   * calls it without options (assign-only — new/unsorted projects, no churn);
   * pass { full: true } for a deliberate anchored rebalance of everything.
   */
  tickOrganize(opts?: { full?: boolean }): Promise<void>;
  /** Run the ambient channel-digest pass (no-op when no digester is wired). */
  tickDigest(): Promise<void>;
  /**
   * Force a full sweep NOW (ignores the shouldFire gate): drain all `captured`
   * items through extraction, then route every `extracted` item and update the
   * touched brains, until nothing is pending or the safety caps are hit.
   */
  processAll(opts?: { maxWaves?: number; maxExtractBatches?: number }): Promise<DrainResult>;
  /**
   * Regenerate a project's brain from scratch, folding in ALL of its items in
   * chronological chunks. Used to refresh briefings after prompt changes or to
   * clean up a noisy/low-quality brain. The original brain is restored when no
   * chunk updates or inference fails, so a skipped rebuild is non-destructive.
   * Returns items successfully rebuilt. Skips if the LLM is down.
   */
  rebuildBrain(projectId: string, opts?: { chunkSize?: number }): Promise<{ status: 'rebuilt' | 'skipped'; items: number }>;
  /** Rebuild every project that has at least one item. */
  rebuildAllBrains(opts?: { chunkSize?: number; minItems?: number }): Promise<{ projects: number; items: number }>;
  start(): void;
  stop(): void;
  isRunning(): boolean;
}

export function createPipelineOrchestrator(deps: {
  db: Database.Database;
  extractor: Extractor;
  batcher: Batcher;
  librarian: Librarian;
  brainUpdater: BrainUpdater;
  reconciler: Reconciler;
  organizer: ProjectOrganizer;
  digester?: ChannelDigester;
  brainStore: BrainStore;
  /** Deterministic sibling-link refresh; runs after passes that change its input signals. */
  projectRelations?: { recompute(): unknown };
  config?: OrchestratorConfig;
}): PipelineOrchestrator {
  const { db, extractor, batcher, librarian, brainUpdater, reconciler, organizer, digester, brainStore } = deps;

  // Relations derive from scope alerts (brain pass), titles (organize), and
  // channel cross-links (digest) — refresh after any of those, best-effort.
  function refreshProjectRelations(): void {
    try { deps.projectRelations?.recompute(); } catch { /* annotation layer must never break the pipeline */ }
  }
  const concurrency = deps.config?.extractionConcurrency ?? 2;
  const extractionIntervalMs = deps.config?.extractionIntervalMs ?? 15000;
  const interpretationIntervalMs = deps.config?.interpretationIntervalMs ?? 60000;
  const reconcileIntervalMs = deps.config?.reconcileIntervalMs ?? 6 * 60 * 60 * 1000;
  const organizeIntervalMs = deps.config?.organizeIntervalMs ?? 30 * 60 * 1000;
  const fullOrganizeIntervalMs = deps.config?.fullOrganizeIntervalMs ?? 24 * 60 * 60 * 1000;
  const digestIntervalMs = deps.config?.digestIntervalMs ?? 6 * 60 * 60 * 1000;

  const timers: ReturnType<typeof setInterval>[] = [];
  let extracting = false;
  let interpreting = false;

  async function tickExtraction(): Promise<number> {
    if (extracting) return 0;
    extracting = true;
    try {
      const rows = db
        .prepare("SELECT id FROM work_items WHERE process_state = 'captured' ORDER BY captured_at ASC LIMIT ?")
        .all(concurrency) as { id: string }[];
      if (rows.length === 0) return 0;
      // Bounded concurrency: process this slice in parallel, then return. The
      // timer calls us again for the next slice — keeps peak load at `concurrency`.
      await Promise.all(rows.map((r) => extractor.extract(r.id).catch(() => undefined)));
      return rows.length;
    } finally {
      extracting = false;
    }
  }

  async function tickInterpretation(): Promise<{ ran: boolean; batchId?: string }> {
    if (interpreting) return { ran: false };
    interpreting = true;
    try {
      if (!batcher.shouldFire()) return { ran: false };
      const wave = await librarian.runWave();
      if (wave.status === 'deferred' || !wave.batchId) return { ran: false };
      await brainUpdater.runForBatch(wave.batchId);
      try { syncNodesFromProjects(db); } catch { /* projection best-effort */ }
      refreshProjectRelations();
      return { ran: true, batchId: wave.batchId };
    } finally {
      interpreting = false;
    }
  }

  async function tickReconcile(): Promise<void> {
    await reconciler.run();
    try { syncNodesFromProjects(db); } catch { /* projection best-effort */ }
  }

  async function tickOrganize(opts?: { full?: boolean }): Promise<void> {
    await organizer.organize(opts);
    try { syncNodesFromProjects(db); } catch { /* projection best-effort */ }
    refreshProjectRelations();
  }

  async function tickDigest(): Promise<void> {
    if (!digester) return;
    await digester.run();
    refreshProjectRelations();
  }

  async function processAll(opts?: { maxWaves?: number; maxExtractBatches?: number }): Promise<DrainResult> {
    const maxWaves = opts?.maxWaves ?? 1000;
    const maxExtractBatches = opts?.maxExtractBatches ?? 5000;
    const result: DrainResult = { extracted: 0, waves: 0, routed: 0, created: 0, orphaned: 0, noise: 0, projectsUpdated: 0 };

    // Share the interpretation lock with the background timer so a manual sweep
    // and a timer tick can never route the same batch concurrently.
    if (interpreting) return result;
    interpreting = true;
    try {
      // NOTE: extraction is intentionally NOT drained here. Parse/OCR run via
      // synchronous subprocess calls that would block the event loop (and the
      // HTTP request) for a large backlog. Extraction is handled incrementally
      // by the background timer (tickExtraction, bounded concurrency). This
      // sweep only does routing + brain updates, which are async (non-blocking)
      // LLM calls, so it stays responsive.
      void tickExtraction; void maxExtractBatches;

      // Route every pending wave and update brains. runWave() pulls the next
      // batch regardless of the shouldFire timer gate.
      for (let w = 0; w < maxWaves; w++) {
        const wave = await librarian.runWave();
        if (wave.status === 'deferred') break; // LLM down — stop, nothing lost
        if (!wave.batchId) break; // no more pending items
        result.waves++;
        result.routed += wave.assigned;
        result.created += wave.created;
        result.orphaned += wave.orphaned;
        result.noise += wave.noise;
        const updates = await brainUpdater.runForBatch(wave.batchId);
        result.projectsUpdated += updates.filter((u) => u.status === 'updated').length;
      }
      try { syncNodesFromProjects(db); } catch { /* projection best-effort */ }
    } finally {
      interpreting = false;
    }
    return result;
  }

  async function rebuildBrain(projectId: string, opts?: { chunkSize?: number }): Promise<{ status: 'rebuilt' | 'skipped'; items: number }> {
    const proj = brainStore.getProject(projectId);
    if (!proj) return { status: 'skipped', items: 0 };

    const ids = (
      db.prepare("SELECT id FROM work_items WHERE project_id = ? ORDER BY captured_at ASC").all(projectId) as { id: string }[]
    ).map((r) => r.id);
    if (ids.length === 0) return { status: 'skipped', items: 0 };

    // Never use a rebuild to overwrite a hand-edited brain. Capture the
    // canonical pre-rebuild state so every unsuccessful attempt can restore it.
    if (brainStore.hasManualEdit(projectId)) return { status: 'skipped', items: 0 };
    const original = brainStore.read(projectId) ?? newBrain(projectId, proj.title);
    const originalOneLiner = proj.one_liner ?? original.summary.slice(0, 200);

    let updatedChunks = 0;
    try {
      // A fresh scaffold prevents duplicated activity while chunks fold in
      // chronological evidence. It is temporary until at least one update
      // succeeds; failures and all-out-of-scope runs roll back below.
      brainStore.write(newBrain(projectId, proj.title), originalOneLiner);

      const chunk = Math.max(1, opts?.chunkSize ?? 12);
      for (let i = 0; i < ids.length; i += chunk) {
        const slice = ids.slice(i, i + chunk);
        const r = await brainUpdater.updateProject(projectId, slice);
        if (r.status === 'updated') {
          updatedChunks++;
          continue;
        }
        if (r.status === 'conflict' || r.skipReason === 'model_failure') {
          if (!brainStore.hasManualEdit(projectId)) brainStore.write(original, originalOneLiner);
          try { syncNodesFromProjects(db); } catch { /* projection best-effort */ }
          return { status: 'skipped', items: 0 };
        }
        // An out-of-scope chunk is recoverable; a later chunk may still update.
      }

      if (updatedChunks === 0) {
        if (!brainStore.hasManualEdit(projectId)) brainStore.write(original, originalOneLiner);
        try { syncNodesFromProjects(db); } catch { /* projection best-effort */ }
        return { status: 'skipped', items: 0 };
      }
    } catch (err) {
      if (!brainStore.hasManualEdit(projectId)) brainStore.write(original, originalOneLiner);
      try { syncNodesFromProjects(db); } catch { /* projection best-effort */ }
      throw err;
    }

    try { syncNodesFromProjects(db); } catch { /* projection best-effort */ }
    refreshProjectRelations();
    return { status: 'rebuilt', items: ids.length };
  }

  async function rebuildAllBrains(opts?: { chunkSize?: number; minItems?: number }): Promise<{ projects: number; items: number }> {
    const minItems = opts?.minItems ?? 1;
    const rows = db
      .prepare(
        `SELECT p.id AS id, (SELECT COUNT(*) FROM work_items w WHERE w.project_id = p.id) AS n
         FROM projects p
         WHERE p.status IN ('active','paused')
           AND (SELECT COUNT(*) FROM work_items w WHERE w.project_id = p.id) >= ?
         ORDER BY n DESC`,
      )
      .all(minItems) as { id: string; n: number }[];
    let projects = 0;
    let items = 0;
    for (const r of rows) {
      const res = await rebuildBrain(r.id, { chunkSize: opts?.chunkSize });
      if (res.status === 'rebuilt') { projects++; items += res.items; }
    }
    return { projects, items };
  }

  return {
    tickExtraction,
    tickInterpretation,
    tickReconcile,
    tickOrganize,
    tickDigest,
    processAll,
    rebuildBrain,
    rebuildAllBrains,

    start(): void {
      if (timers.length) return;
      timers.push(setInterval(() => { tickExtraction().catch(() => {}); }, extractionIntervalMs));
      timers.push(setInterval(() => { tickInterpretation().catch(() => {}); }, interpretationIntervalMs));
      timers.push(setInterval(() => { tickReconcile().catch(() => {}); }, reconcileIntervalMs));
      timers.push(setInterval(() => { tickOrganize().catch(() => {}); }, organizeIntervalMs));
      timers.push(setInterval(() => { tickOrganize({ full: true }).catch(() => {}); }, fullOrganizeIntervalMs));
      if (digester) timers.push(setInterval(() => { tickDigest().catch(() => {}); }, digestIntervalMs));
    },
    stop(): void {
      for (const t of timers) clearInterval(t);
      timers.length = 0;
    },
    isRunning(): boolean {
      return timers.length > 0;
    },
  };
}
