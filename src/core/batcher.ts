/**
 * Batcher — selects waves of extracted-but-unrouted items for the librarian
 * pass, and owns the process-state lifecycle transitions
 * (lossless-capture-brain-pipeline R5).
 *
 * Lifecycle: captured → extracted → routed | orphaned | noise
 *            (failure branches: extract_failed, route_failed)
 *
 * Correctness Property P5: an item never regresses to an earlier non-failure
 * state, and once terminal (routed/noise) it is never re-selected by a wave.
 */

import { randomUUID } from 'crypto';
import type Database from 'better-sqlite3';

export type ProcessState =
  | 'captured'
  | 'extracted'
  | 'routed'
  | 'orphaned'
  | 'noise'
  | 'extract_failed'
  | 'route_failed';

/** Terminal states are never re-selected into a wave. */
export const TERMINAL_STATES: ReadonlySet<ProcessState> = new Set(['routed', 'noise']);

/** Allowed forward transitions (P5: monotonic, no regression to earlier state). */
const ALLOWED: Record<ProcessState, ReadonlySet<ProcessState>> = {
  captured: new Set(['extracted', 'extract_failed']),
  extract_failed: new Set(['extracted', 'captured']), // retry sweep may re-queue
  extracted: new Set(['routed', 'orphaned', 'noise', 'route_failed']),
  route_failed: new Set(['routed', 'orphaned', 'noise', 'extracted']), // retry
  orphaned: new Set(['routed', 'noise']), // reconciliation may adopt an orphan
  routed: new Set([]), // terminal
  noise: new Set([]), // terminal
};

export interface WaveItem {
  id: string;
  type: string;
  source: string;
  title: string | null;
}

export interface Batcher {
  /** Number of items waiting to be routed. */
  pendingCount(): number;
  /** Select up to `waveSize` extracted+unrouted items, stamping a batch id. */
  nextWave(): { batchId: string; items: WaveItem[] } | null;
  /** Whether a wave should fire now (size or age trigger). */
  shouldFire(): boolean;
  /** Apply a state transition, enforcing P5; returns false if disallowed. */
  transition(itemId: string, to: ProcessState, opts?: { projectId?: string | null }): boolean;
}

export interface BatcherConfig {
  waveSize?: number; // default 30
  /** Minimum items waiting before a size-triggered wave (default = waveSize). */
  sizeTrigger?: number;
  /** Age of the oldest pending item (ms) that triggers a wave (default 10 min). */
  ageTriggerMs?: number;
}

export function createBatcher(db: Database.Database, config?: BatcherConfig): Batcher {
  const waveSize = config?.waveSize ?? 30;
  const sizeTrigger = config?.sizeTrigger ?? waveSize;
  const ageTriggerMs = config?.ageTriggerMs ?? 10 * 60 * 1000;

  function pendingCount(): number {
    return (
      db.prepare(
        "SELECT COUNT(*) AS c FROM work_items WHERE process_state = 'extracted' AND project_id IS NULL",
      ).get() as { c: number }
    ).c;
  }

  return {
    pendingCount,

    shouldFire(): boolean {
      const count = pendingCount();
      if (count === 0) return false;
      if (count >= sizeTrigger) return true;
      // Age trigger: oldest pending item older than ageTriggerMs.
      const oldest = db
        .prepare(
          "SELECT MIN(captured_at) AS m FROM work_items WHERE process_state = 'extracted' AND project_id IS NULL",
        )
        .get() as { m: string | null };
      if (!oldest.m) return false;
      const ageMs = Date.now() - new Date(oldest.m).getTime();
      return ageMs >= ageTriggerMs;
    },

    nextWave(): { batchId: string; items: WaveItem[] } | null {
      const rows = db
        .prepare(
          `SELECT id, type, source, title FROM work_items
           WHERE process_state = 'extracted' AND project_id IS NULL
           ORDER BY captured_at ASC LIMIT ?`,
        )
        .all(waveSize) as WaveItem[];
      if (rows.length === 0) return null;

      const batchId = randomUUID();
      const stamp = db.prepare('UPDATE work_items SET batch_id = ? WHERE id = ?');
      const tx = db.transaction(() => {
        for (const r of rows) stamp.run(batchId, r.id);
      });
      tx();
      return { batchId, items: rows };
    },

    transition(itemId: string, to: ProcessState, opts?: { projectId?: string | null }): boolean {
      const row = db.prepare('SELECT process_state FROM work_items WHERE id = ?').get(itemId) as
        | { process_state: ProcessState }
        | undefined;
      if (!row) return false;
      const from = row.process_state;
      if (from === to) {
        // idempotent no-op except for project assignment
        if (opts && 'projectId' in opts) {
          db.prepare('UPDATE work_items SET project_id = ? WHERE id = ?').run(opts.projectId ?? null, itemId);
        }
        return true;
      }
      const allowed = ALLOWED[from];
      if (!allowed || !allowed.has(to)) return false;

      if (opts && 'projectId' in opts) {
        db.prepare('UPDATE work_items SET process_state = ?, project_id = ? WHERE id = ?').run(
          to, opts.projectId ?? null, itemId,
        );
      } else {
        db.prepare('UPDATE work_items SET process_state = ? WHERE id = ?').run(to, itemId);
      }
      return true;
    },
  };
}
