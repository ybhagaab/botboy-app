/**
 * Free-space probe for the local-folder disk floors (LOCAL_FOLDER_IMPORT_SAFETY_PLAN.md C7).
 *
 * `statfs` runs on libuv's thread pool, so a measurement never blocks the
 * main thread. Folder imports ask for a fresh value before each file
 * (`freeBytes(maxAgeMs)`); the live capture path is synchronous and reads the
 * cached value (`cachedFreeBytes`), which also schedules a background
 * refresh when it is stale. An unmeasurable volume reports `null`, and
 * callers treat `null` as "no floor applies" (fail-open with one warning):
 * a broken probe must not silently stop capture forever.
 */

import { promises as fsPromises } from 'fs';

export interface DiskSpaceSnapshot {
  freeBytes: number | null;
  totalBytes: number | null;
  measuredAt: number | null;
}

export interface DiskSpaceMonitor {
  /** Last measured free bytes; `null` before the first measurement or when unmeasurable. */
  cachedFreeBytes(): number | null;
  /** Free bytes no older than `maxAgeMs` (measures when stale). */
  freeBytes(maxAgeMs?: number): Promise<number | null>;
  snapshot(): DiskSpaceSnapshot;
}

type StatfsLike = (target: string) => Promise<{ bavail: number | bigint; bsize: number | bigint; blocks: number | bigint }>;

export function createDiskSpaceMonitor(opts: {
  /** Any path on the volume that holds BotBoy's data (the home directory). */
  path: string;
  statfs?: StatfsLike;
  now?: () => number;
  /** Age after which `cachedFreeBytes` schedules a background refresh. */
  staleMs?: number;
}): DiskSpaceMonitor {
  const statfs: StatfsLike = opts.statfs ?? ((target) => fsPromises.statfs(target));
  const now = opts.now ?? Date.now;
  const staleMs = opts.staleMs ?? 30_000;
  let snapshot: DiskSpaceSnapshot = { freeBytes: null, totalBytes: null, measuredAt: null };
  let inflight: Promise<number | null> | null = null;
  let warned = false;

  function measure(): Promise<number | null> {
    if (inflight) return inflight;
    inflight = (async () => {
      try {
        const stats = await statfs(opts.path);
        const bsize = Number(stats.bsize);
        snapshot = {
          freeBytes: Number(stats.bavail) * bsize,
          totalBytes: Number(stats.blocks) * bsize,
          measuredAt: now(),
        };
        warned = false;
      } catch (err) {
        if (!warned) {
          warned = true;
          console.warn(`[disk-space] statfs failed for ${opts.path}; disk floors are not enforced until it succeeds:`, (err as Error)?.message ?? err);
        }
        snapshot = { freeBytes: null, totalBytes: null, measuredAt: now() };
      } finally {
        inflight = null;
      }
      return snapshot.freeBytes;
    })();
    return inflight;
  }

  function isStale(maxAgeMs: number): boolean {
    return snapshot.measuredAt == null || now() - snapshot.measuredAt >= maxAgeMs;
  }

  return {
    cachedFreeBytes() {
      if (isStale(staleMs)) void measure();
      return snapshot.freeBytes;
    },
    async freeBytes(maxAgeMs = 5_000) {
      if (!isStale(maxAgeMs)) return snapshot.freeBytes;
      return measure();
    },
    snapshot() {
      return { ...snapshot };
    },
  };
}
