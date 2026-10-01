/**
 * Main-thread watchdog (LOCAL_FOLDER_IMPORT_SAFETY_PLAN.md C9).
 *
 * Two complementary signals, both log-only (the watchdog never changes
 * behavior):
 *
 *   - `measure(label, fn)` times one synchronous section and logs it when it
 *     holds the main thread for `stallMs` or longer, naming the subsystem.
 *   - a 50 ms drift timer logs any unattributed stall of `stallMs` or longer,
 *     naming the heaviest labeled section that ran in that window (or none).
 *
 * `stats()` reports the worst per-second p99 (`perf_hooks.monitorEventLoopDelay`)
 * and max delay over the last minute plus the most recent stalls, so an
 * import can be checked against O2 (p99 under 250 ms) from the Local folders
 * status endpoint without attaching a profiler.
 */

import { monitorEventLoopDelay, performance } from 'perf_hooks';

export interface MainThreadStall {
  at: number;
  durationMs: number;
  label: string | null;
  attributed: boolean;
}

export interface MainThreadStats {
  enabled: boolean;
  /** Worst per-second p99 event-loop delay over the last minute. */
  p99Ms: number | null;
  /** Worst single event-loop delay over the last minute. */
  maxMs: number | null;
  stallCount: number;
  recentStalls: MainThreadStall[];
}

export interface MainThreadWatchdog {
  start(): void;
  stop(): void;
  measure<T>(label: string, fn: () => T): T;
  stats(): MainThreadStats;
}

const WINDOW_COUNT = 60;
const RECENT_STALLS = 10;

export function createMainThreadWatchdog(opts: {
  stallMs?: number;
  /** Drift sampling cadence. */
  tickMs?: number;
  /** Statistics window; the last 60 windows are kept. */
  windowMs?: number;
  log?: (line: string) => void;
  now?: () => number;
  clock?: () => number;
} = {}): MainThreadWatchdog {
  const stallMs = opts.stallMs ?? 1_000;
  const tickMs = opts.tickMs ?? 50;
  const windowMs = opts.windowMs ?? 1_000;
  const log = opts.log ?? ((line: string) => console.warn(line));
  const now = opts.now ?? Date.now;
  const clock = opts.clock ?? (() => performance.now());
  let histogram: ReturnType<typeof monitorEventLoopDelay> | null = null;
  let timer: NodeJS.Timeout | null = null;
  const windows: Array<{ p99Ms: number; maxMs: number }> = [];
  const recentStalls: MainThreadStall[] = [];
  let stallCount = 0;
  let lastTick = 0;
  let windowStart = 0;
  let windowMax = 0;
  // Labeled work observed in the current window.
  let windowHeaviest: { label: string; durationMs: number } | null = null;
  // The drift tick right after a measured stall sees the same delay; suppress
  // that echo for a short grace period.
  let lastAttributedEndedAt = Number.NEGATIVE_INFINITY;
  const ATTRIBUTION_GRACE_MS = 2_500;

  function recordStall(stall: MainThreadStall): void {
    stallCount++;
    recentStalls.push(stall);
    if (recentStalls.length > RECENT_STALLS) recentStalls.shift();
  }

  // Stall detection uses timer drift, which is deterministic: the first tick
  // after a block always observes it. (Resetting the delay histogram can drop
  // the one sample spanning a block, so the histogram feeds p99 only.)
  function tick(): void {
    const t = clock();
    const delay = Math.max(0, t - lastTick - tickMs);
    lastTick = t;
    if (delay > windowMax) windowMax = delay;
    if (delay >= stallMs && t - lastAttributedEndedAt > ATTRIBUTION_GRACE_MS) {
      const culprit = windowHeaviest
        ? `heaviest labeled work: ${windowHeaviest.label} (${(windowHeaviest.durationMs / 1000).toFixed(2)} s)`
        : 'no labeled work ran';
      log(`[main-thread] event loop stalled ${(delay / 1000).toFixed(1)} s; ${culprit}`);
      recordStall({ at: now(), durationMs: Math.round(delay), label: windowHeaviest?.label ?? null, attributed: false });
    }
    if (t - windowStart >= windowMs) {
      const p99Ms = histogram && histogram.count > 0 ? histogram.percentile(99) / 1e6 : 0;
      const histogramMax = histogram ? histogram.max / 1e6 : 0;
      windows.push({ p99Ms, maxMs: Math.max(windowMax, Number.isFinite(histogramMax) ? histogramMax : 0) });
      if (windows.length > WINDOW_COUNT) windows.shift();
      histogram?.reset();
      windowStart = t;
      windowMax = 0;
      windowHeaviest = null;
    }
  }

  return {
    start() {
      if (timer) return;
      histogram = monitorEventLoopDelay({ resolution: 20 });
      histogram.enable();
      lastTick = clock();
      windowStart = lastTick;
      timer = setInterval(tick, tickMs);
      timer.unref?.();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
      histogram?.disable();
      histogram = null;
    },
    measure(label, fn) {
      const started = clock();
      try {
        return fn();
      } finally {
        const durationMs = clock() - started;
        if (!windowHeaviest || durationMs > windowHeaviest.durationMs) windowHeaviest = { label, durationMs };
        if (durationMs >= stallMs) {
          lastAttributedEndedAt = clock();
          log(`[main-thread] ${label} held the main thread for ${(durationMs / 1000).toFixed(1)} s`);
          recordStall({ at: now(), durationMs: Math.round(durationMs), label, attributed: true });
        }
      }
    },
    stats() {
      const round = (value: number) => Math.round(value * 10) / 10;
      return {
        enabled: timer != null,
        p99Ms: windows.length ? round(Math.max(...windows.map(w => w.p99Ms))) : null,
        maxMs: windows.length ? round(Math.max(...windows.map(w => w.maxMs))) : null,
        stallCount,
        recentStalls: [...recentStalls],
      };
    },
  };
}

/** Watchdog stand-in for tests and callers without one. */
export const NOOP_MAIN_THREAD_WATCHDOG: MainThreadWatchdog = {
  start() {},
  stop() {},
  measure: (_label, fn) => fn(),
  stats: () => ({ enabled: false, p99Ms: null, maxMs: null, stallCount: 0, recentStalls: [] }),
};
