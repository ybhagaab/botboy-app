/**
 * Browser poll pacing: how often to poll, and (only while slowed) which tabs
 * to read first.
 *
 * Both parts are pure of I/O. The monitor measures a poll (wall time, median
 * probe time of the tabs that answered, memory pressure, load per core) and
 * feeds `observe`; the governor doubles the interval up to a cap while the
 * Mac is struggling and returns straight to the base interval after a few
 * calm polls. `planTabReads` orders a poll's tabs. In the calm state it is the
 * identity (same order, nothing deferred), so a healthy Mac behaves exactly
 * as it did without a governor; the per-poll tab budget applies only while
 * slowed.
 */
import type { MemoryPressure } from '../core/system-pressure.js';

export interface PollGovernorOptions {
  /** The configured poll interval; the governor never goes below it. */
  baseMs: number;
  /** Interval cap (default 5 minutes). */
  maxMs?: number;
  /** A poll that took this long is slow (default 8 s). */
  slowPollMs?: number;
  /** A median probe that took this long is slow (default 4 s). */
  slowProbeMs?: number;
  /** Load average per core at or above this is slow (default 1.5). */
  loadPerCpuHigh?: number;
  /** Calm polls in a row that return the interval to base (default 3). */
  calmPollsToReset?: number;
  /** One line per interval change (default console.log). */
  log?: (line: string) => void;
}

export interface PollObservation {
  wallMs: number;
  /** Median probe time of tabs that answered (timed-out tabs excluded); 0 when none was read. */
  medianProbeMs: number;
  pressure: MemoryPressure;
  loadPerCpu: number;
}

export interface PollGovernorResult {
  intervalMs: number;
  /** True when the interval or the slowed reason changed with this observation. */
  changed: boolean;
  /** Why the poll is slowed; null when calm. */
  reason: string | null;
}

export interface PollGovernor {
  observe(observation: PollObservation): PollGovernorResult;
  /** Back to the base interval now (a wake). */
  reset(): PollGovernorResult;
  intervalMs(): number;
  baseMs(): number;
  /** True from the first slow observation until the interval returns to base. */
  slowed(): boolean;
  reason(): string | null;
}

export function medianOf(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function seconds(ms: number): string {
  return ms % 1000 === 0 ? `${ms / 1000}s` : `${(ms / 1000).toFixed(1)}s`;
}

export function createPollGovernor(options: PollGovernorOptions): PollGovernor {
  const baseMs = options.baseMs;
  const maxMs = Math.max(options.maxMs ?? 300_000, baseMs);
  const slowPollMs = options.slowPollMs ?? 8_000;
  const slowProbeMs = options.slowProbeMs ?? 4_000;
  const loadPerCpuHigh = options.loadPerCpuHigh ?? 1.5;
  const calmPollsToReset = options.calmPollsToReset ?? 3;
  const log = options.log ?? ((line: string) => console.log(line));
  let interval = baseMs;
  let slowed = false;
  let reason: string | null = null;
  let calm = 0;

  function slowReason(o: PollObservation): string | null {
    if (o.pressure !== 'normal') return `memory pressure: ${o.pressure}`;
    if (o.loadPerCpu >= loadPerCpuHigh) return 'high CPU load';
    if (o.wallMs >= slowPollMs) return 'slow polls';
    if (o.medianProbeMs >= slowProbeMs) return 'slow pages';
    return null;
  }

  function toBase(): PollGovernorResult {
    const changed = slowed || interval !== baseMs;
    interval = baseMs;
    slowed = false;
    reason = null;
    calm = 0;
    return { intervalMs: interval, changed, reason };
  }

  return {
    observe(observation) {
      const why = slowReason(observation);
      if (why) {
        calm = 0;
        const next = Math.min(interval * 2, maxMs);
        const changed = next !== interval || !slowed || why !== reason;
        const intervalChanged = next !== interval;
        interval = next;
        slowed = true;
        reason = why;
        if (intervalChanged) log(`[BrowserMonitor] poll every ${seconds(interval)} (${why})`);
        return { intervalMs: interval, changed, reason };
      }
      if (!slowed) return { intervalMs: interval, changed: false, reason: null };
      calm++;
      if (calm < calmPollsToReset) return { intervalMs: interval, changed: false, reason };
      const result = toBase();
      log(`[BrowserMonitor] back to ${seconds(baseMs)}`);
      return result;
    },
    reset() {
      const wasSlowed = slowed;
      const result = toBase();
      if (wasSlowed) log(`[BrowserMonitor] back to ${seconds(baseMs)}`);
      return result;
    },
    intervalMs: () => interval,
    baseMs: () => baseMs,
    slowed: () => slowed,
    reason: () => reason,
  };
}

// ── Tab planning ──

/** What the planner needs to know about one open tab. */
export interface PlannedTab {
  /** Chrome's stable target id. */
  id: string;
  /** Never read before in this process (or since a restart). */
  firstSight: boolean;
  /** A changed field fingerprint is waiting for its second equal poll. */
  pendingFields: boolean;
  /** WhatsApp, PDF, or a mail/chat page re-read for changes. */
  alwaysServe: boolean;
  /** A static page captured as often as it is allowed: reading it costs nothing. */
  capped: boolean;
}

export interface PlanState {
  /** Stable id of the last round-robin tab served; the next batch starts after it. */
  cursor: string | null;
  /** The tab that most recently reported itself visible. */
  lastVisibleId: string | null;
}

export interface PlanOptions {
  /** True only while the governor is slowed. */
  slowed: boolean;
  /** Soft budget of tabs read per poll while slowed (default 12). */
  maxTabsPerPoll?: number;
  /** Round-robin slots that always exist while slowed (default 2). */
  minRoundRobin?: number;
}

export interface TabPlan<T extends PlannedTab> {
  /** Tabs to read this poll, in order. */
  order: T[];
  /** Tabs left for a later poll; their remembered state is untouched. */
  deferred: T[];
  state: PlanState;
}

export function initialPlanState(): PlanState {
  return { cursor: null, lastVisibleId: null };
}

/**
 * Orders a poll's tabs. Calm: the identity (Chrome's order, nothing
 * deferred). Slowed: first-sight tabs, tabs with a pending field check, the
 * last-visible tab, and WhatsApp/PDF/dynamic tabs are always served (the
 * budget is soft for them); the remaining budget, at least `minRoundRobin`
 * slots, rotates over the other tabs by a cursor on their stable ids, so
 * every tab is reached. Capped pages cost nothing and ride along last. A tab
 * that closes simply drops out; the cursor needs no tab to still exist.
 */
export function planTabReads<T extends PlannedTab>(tabs: T[], state: PlanState, options: PlanOptions): TabPlan<T> {
  if (!options.slowed) return { order: tabs.slice(), deferred: [], state };
  const maxTabs = Math.max(1, options.maxTabsPerPoll ?? 12);
  const minRoundRobin = Math.max(0, options.minRoundRobin ?? 2);

  const priority: T[] = [];
  const capped: T[] = [];
  const rest: T[] = [];
  for (const tab of tabs) {
    if (tab.capped) capped.push(tab);
    else if (tab.firstSight || tab.pendingFields || tab.alwaysServe || tab.id === state.lastVisibleId) priority.push(tab);
    else rest.push(tab);
  }
  const slots = Math.max(minRoundRobin, maxTabs - priority.length);
  const byId = rest.slice().sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  // Start after the cursor in id order, wrapping around.
  let start = 0;
  if (state.cursor !== null) {
    const after = byId.findIndex(tab => tab.id > state.cursor!);
    start = after === -1 ? 0 : after;
  }
  const picked: T[] = [];
  for (let i = 0; i < byId.length && picked.length < slots; i++) picked.push(byId[(start + i) % byId.length]);
  const served = new Set<T>(picked);
  return {
    order: [...priority, ...picked, ...capped],
    deferred: rest.filter(tab => !served.has(tab)),
    state: { cursor: picked.length ? picked[picked.length - 1].id : state.cursor, lastVisibleId: state.lastVisibleId },
  };
}
