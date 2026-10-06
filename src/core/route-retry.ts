/**
 * Automatic retry for items whose routing call failed
 * (GMAIL_API_INTEGRATION_PLAN.md §12, outcome O4).
 *
 * The librarian marks every model-bound item of a wave `route_failed` when its
 * model call throws (timeout, provider error, prompt budget), and nothing
 * else ever selected those rows again: 159 items sat there for months. One
 * bounded sweep per interpretation tick returns them to `extracted`, and the
 * same tick's wave routes them like any other evidence.
 *
 * Limits:
 *   - Attempts come from the append-only `failures` table (one `step='route'`
 *     row per item per failed call). Three failures end the retries, and the
 *     item stays `route_failed`, visible on Pipeline health.
 *   - Backoff: 30 minutes after the first failure, 2 hours after the second.
 *   - A first retry takes up to one wave (30 items, oldest failure first, so a
 *     failed wave returns together). A final attempt goes alone, so one item
 *     that always breaks its wave cannot spend everyone else's attempts.
 *   - It runs only while the model is available and no fresh capture waits
 *     to be routed, at most every 10 minutes.
 *   - An item superseded by a newer row with the same URL is left alone; the
 *     newer row carries that evidence.
 * Only `batcher.ts › requeueRouteFailed` changes state (compare-and-set); the
 * librarian decides the placement as in any wave.
 */

import type Database from 'better-sqlite3';
import type { Batcher } from './batcher.js';
import { getSetting, setSetting } from './storage.js';

export const ROUTE_RETRY_RECEIPT_KEY = 'routing.route_retry.v1';

export interface RouteRetryConfig {
  /** Failed routing calls an item may have before retries stop (default 3). */
  maxAttempts?: number;
  /** Wait after the Nth failure (default 30 min, then 2 h; the last value repeats). */
  backoffMs?: number[];
  /** Items requeued by one sweep for a first retry (default 30, one wave). */
  maxPerSweep?: number;
  /** Minimum time between sweeps (default 10 min). */
  minIntervalMs?: number;
}

export interface RouteRetrySweep {
  requeued: number;
  /** Rows that used every attempt and stay `route_failed`. */
  exhausted: number;
  /** Rows still inside their backoff. */
  waiting: number;
  /** Rows a newer capture of the same URL replaced. */
  superseded: number;
}

export interface RouteRetryReceipt extends RouteRetrySweep {
  at: string;
  totalRequeued: number;
}

export interface RouteRetry {
  /** One bounded sweep; null when skipped (too soon, model unavailable, or fresh work waiting). */
  sweep(): RouteRetrySweep | null;
}

/** `failures.created_at` is SQLite UTC ('YYYY-MM-DD HH:MM:SS'); captured_at is ISO. */
function parseUtc(value: string | null | undefined): number | null {
  if (!value) return null;
  const ms = Date.parse(value.includes('T') ? value : `${value.replace(' ', 'T')}Z`);
  return Number.isFinite(ms) ? ms : null;
}

export function createRouteRetry(deps: {
  db: Database.Database;
  batcher: Pick<Batcher, 'pendingCount' | 'requeueRouteFailed'>;
  isAvailable: () => boolean;
  config?: RouteRetryConfig;
  now?: () => number;
}): RouteRetry {
  const { db, batcher } = deps;
  const now = deps.now ?? Date.now;
  const maxAttempts = deps.config?.maxAttempts ?? 3;
  const backoffMs = deps.config?.backoffMs ?? [30 * 60_000, 2 * 60 * 60_000];
  const maxPerSweep = deps.config?.maxPerSweep ?? 30;
  const minIntervalMs = deps.config?.minIntervalMs ?? 10 * 60_000;
  let lastSweepAt: number | null = null;

  const candidates = db.prepare(`
    SELECT w.id, w.url, w.captured_at AS capturedAt,
           COUNT(f.id) AS attempts, MAX(f.created_at) AS lastFailedAt
      FROM work_items w
      LEFT JOIN failures f ON f.item_id = w.id AND f.step = 'route'
     WHERE w.process_state = 'route_failed' AND w.project_id IS NULL AND w.type <> 'file_reference'
     GROUP BY w.id
  `);
  const newerSameUrl = db.prepare(
    'SELECT 1 FROM work_items WHERE url = ? AND id <> ? AND captured_at > ? LIMIT 1',
  );

  return {
    sweep(): RouteRetrySweep | null {
      const at = now();
      if (lastSweepAt !== null && at - lastSweepAt < minIntervalMs) return null;
      if (!deps.isAvailable()) return null;
      // Fresh captures route first; a retry never shares their wave.
      if (batcher.pendingCount() > 0) return null;
      lastSweepAt = at;

      const rows = candidates.all() as Array<{
        id: string; url: string | null; capturedAt: string; attempts: number; lastFailedAt: string | null;
      }>;
      const result: RouteRetrySweep = { requeued: 0, exhausted: 0, waiting: 0, superseded: 0 };
      const first: Array<{ id: string; order: number; capturedAt: string }> = [];
      const final: Array<{ id: string; order: number; capturedAt: string }> = [];
      for (const row of rows) {
        // A row with no failure row (the recorder swallowed its own error)
        // still failed once: its state says so.
        const attempts = Math.max(1, Number(row.attempts) || 0);
        if (attempts >= maxAttempts) { result.exhausted++; continue; }
        const failedAt = parseUtc(row.lastFailedAt) ?? parseUtc(row.capturedAt) ?? 0;
        const wait = backoffMs[Math.min(attempts, backoffMs.length) - 1] ?? 0;
        if (at - failedAt < wait) { result.waiting++; continue; }
        if (row.url && newerSameUrl.get(row.url, row.id, row.capturedAt)) { result.superseded++; continue; }
        (attempts === maxAttempts - 1 ? final : first).push({ id: row.id, order: failedAt, capturedAt: row.capturedAt });
      }
      const oldestFirst = (left: { order: number; capturedAt: string }, right: { order: number; capturedAt: string }) =>
        left.order - right.order || left.capturedAt.localeCompare(right.capturedAt);
      // First retries go a wave at a time; a final attempt goes alone.
      const chosen = first.length ? first.sort(oldestFirst).slice(0, maxPerSweep) : final.sort(oldestFirst).slice(0, 1);
      db.transaction(() => {
        for (const item of chosen) if (batcher.requeueRouteFailed(item.id)) result.requeued++;
      })();

      const previous = getSetting<RouteRetryReceipt>(db, ROUTE_RETRY_RECEIPT_KEY);
      const receipt: RouteRetryReceipt = {
        at: new Date(at).toISOString(),
        ...result,
        totalRequeued: (Number(previous?.totalRequeued) || 0) + result.requeued,
      };
      setSetting(db, ROUTE_RETRY_RECEIPT_KEY, receipt);
      if (result.requeued > 0) {
        console.log(`[Pipeline] Retrying routing for ${result.requeued} item(s) whose routing call failed earlier`
          + `${result.exhausted ? `; ${result.exhausted} used every attempt` : ''}`);
      }
      return result;
    },
  };
}
