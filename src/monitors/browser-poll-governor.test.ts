import { describe, expect, it } from 'vitest';
import {
  createPollGovernor,
  initialPlanState,
  medianOf,
  planTabReads,
  type PlannedTab,
  type PollObservation,
} from './browser-poll-governor.js';

const calm: PollObservation = { wallMs: 500, medianProbeMs: 200, pressure: 'normal', loadPerCpu: 0.3 };

function governor(overrides: Record<string, number> = {}) {
  const lines: string[] = [];
  const g = createPollGovernor({ baseMs: 30_000, log: line => lines.push(line), ...overrides });
  return { g, lines };
}

describe('createPollGovernor', () => {
  it('stays at the base interval under calm signals and logs nothing', () => {
    const { g, lines } = governor();
    for (let i = 0; i < 10; i++) expect(g.observe(calm)).toEqual({ intervalMs: 30_000, changed: false, reason: null });
    expect(g.slowed()).toBe(false);
    expect(lines).toEqual([]);
  });

  it('doubles under memory pressure up to the 5 minute cap, one line per change', () => {
    const { g, lines } = governor();
    const warn: PollObservation = { ...calm, pressure: 'warn' };
    const seen = [1, 2, 3, 4, 5, 6].map(() => g.observe(warn).intervalMs);
    expect(seen).toEqual([60_000, 120_000, 240_000, 300_000, 300_000, 300_000]);
    expect(lines).toEqual([
      '[BrowserMonitor] poll every 60s (memory pressure: warn)',
      '[BrowserMonitor] poll every 120s (memory pressure: warn)',
      '[BrowserMonitor] poll every 240s (memory pressure: warn)',
      '[BrowserMonitor] poll every 300s (memory pressure: warn)',
    ]);
    expect(g.slowed()).toBe(true);
  });

  it('slows on each signal: critical pressure, load per CPU, a slow poll, a slow median probe', () => {
    const cases: Array<[Partial<PollObservation>, string]> = [
      [{ pressure: 'critical' }, 'memory pressure: critical'],
      [{ loadPerCpu: 1.5 }, 'high CPU load'],
      [{ wallMs: 8_000 }, 'slow polls'],
      [{ medianProbeMs: 4_000 }, 'slow pages'],
    ];
    for (const [signal, reason] of cases) {
      const { g } = governor();
      const result = g.observe({ ...calm, ...signal });
      expect(result).toEqual({ intervalMs: 60_000, changed: true, reason });
    }
    // Just under every threshold is calm.
    const { g } = governor();
    expect(g.observe({ wallMs: 7_999, medianProbeMs: 3_999, pressure: 'normal', loadPerCpu: 1.49 }).changed).toBe(false);
  });

  it('returns straight to base after three calm polls, resetting the count on a slow one', () => {
    const { g, lines } = governor();
    g.observe({ ...calm, pressure: 'warn' });
    g.observe({ ...calm, pressure: 'warn' });
    expect(g.intervalMs()).toBe(120_000);
    expect(g.observe(calm).intervalMs).toBe(120_000);
    expect(g.observe(calm).intervalMs).toBe(120_000);
    g.observe({ ...calm, pressure: 'warn' }); // interrupts the streak
    expect(g.observe(calm).changed).toBe(false);
    expect(g.observe(calm).changed).toBe(false);
    const reset = g.observe(calm);
    expect(reset).toEqual({ intervalMs: 30_000, changed: true, reason: null });
    expect(g.slowed()).toBe(false);
    expect(lines[lines.length - 1]).toBe('[BrowserMonitor] back to 30s');
    expect(lines.filter(line => line.includes('back to'))).toHaveLength(1);
  });

  it('reset() (a wake) returns to base at once and says so only when it was slowed', () => {
    const { g, lines } = governor();
    expect(g.reset().changed).toBe(false);
    g.observe({ ...calm, loadPerCpu: 3 });
    expect(g.reset()).toEqual({ intervalMs: 30_000, changed: true, reason: null });
    expect(lines.filter(line => line.includes('back to'))).toHaveLength(1);
  });

  it('never goes below base and honours a base above the cap', () => {
    const { g } = governor({ baseMs: 400_000 });
    expect(g.observe({ ...calm, pressure: 'warn' }).intervalMs).toBe(400_000);
  });
});

describe('medianOf', () => {
  it('is 0 for nothing and the middle otherwise', () => {
    expect(medianOf([])).toBe(0);
    expect(medianOf([9, 1, 5])).toBe(5);
    expect(medianOf([1, 3])).toBe(2);
  });
});

function tab(id: string, extra: Partial<PlannedTab> = {}): PlannedTab {
  return { id, firstSight: false, pendingFields: false, alwaysServe: false, capped: false, ...extra };
}
function many(count: number, extra: (i: number) => Partial<PlannedTab> = () => ({})): PlannedTab[] {
  return Array.from({ length: count }, (_, i) => tab(`t${String(i).padStart(3, '0')}`, extra(i)));
}

describe('planTabReads', () => {
  it('calm: identity order, nothing deferred, state untouched', () => {
    const tabs = many(40, i => ({ firstSight: i % 3 === 0, capped: i % 7 === 0 }));
    const state = { cursor: 't010', lastVisibleId: 't005' };
    const plan = planTabReads(tabs, state, { slowed: false, maxTabsPerPoll: 12 });
    expect(plan.order).toEqual(tabs);
    expect(plan.deferred).toEqual([]);
    expect(plan.state).toBe(state);
  });

  it('slowed with 40 plain tabs reaches every tab within ceil(40/12) polls', () => {
    const tabs = many(40);
    let state = initialPlanState();
    const visited = new Set<string>();
    let polls = 0;
    while (visited.size < tabs.length && polls < 20) {
      const plan = planTabReads(tabs, state, { slowed: true, maxTabsPerPoll: 12 });
      expect(plan.order.length).toBeLessThanOrEqual(12);
      expect(plan.order.length + plan.deferred.length).toBe(40);
      for (const t of plan.order) visited.add(t.id);
      state = plan.state;
      polls++;
    }
    expect(visited.size).toBe(40);
    expect(polls).toBe(Math.ceil(40 / 12));
  });

  it('with k priority tabs every other tab is visited within ceil((40-k)/(12-k)) polls', () => {
    const k = 4;
    const tabs = many(40, i => (i < k ? { firstSight: true } : {}));
    let state = initialPlanState();
    const visited = new Set<string>();
    let polls = 0;
    while (visited.size < 40 - k && polls < 20) {
      const plan = planTabReads(tabs, state, { slowed: true, maxTabsPerPoll: 12 });
      // Priority tabs are served every poll.
      for (let i = 0; i < k; i++) expect(plan.order).toContain(tabs[i]);
      for (const t of plan.order.slice(k)) visited.add(t.id);
      state = plan.state;
      polls++;
    }
    expect(polls).toBe(Math.ceil((40 - k) / (12 - k)));
  });

  it('serves first-sight, pending-field, last-visible, and always-serve tabs first and never defers them', () => {
    const tabs = many(30, i => ({
      firstSight: i === 25,
      pendingFields: i === 26,
      alwaysServe: i === 27,
    }));
    const plan = planTabReads(tabs, { cursor: null, lastVisibleId: 't028' }, { slowed: true, maxTabsPerPoll: 12 });
    expect(plan.order.slice(0, 4).map(t => t.id)).toEqual(['t025', 't026', 't027', 't028']);
    expect(plan.deferred.map(t => t.id)).not.toContain('t025');
    expect(plan.order).toHaveLength(12);
  });

  it('keeps at least two round-robin slots even when priority tabs fill the budget', () => {
    const tabs = many(30, i => (i < 20 ? { firstSight: true } : {}));
    const plan = planTabReads(tabs, initialPlanState(), { slowed: true, maxTabsPerPoll: 12 });
    expect(plan.order.slice(0, 20).every(t => t.firstSight)).toBe(true);
    expect(plan.order.slice(20)).toHaveLength(2);
    expect(plan.deferred).toHaveLength(8);
  });

  it('advances the cursor over stable ids, wraps, and survives the cursor tab closing', () => {
    const tabs = many(6);
    let plan = planTabReads(tabs, initialPlanState(), { slowed: true, maxTabsPerPoll: 3, minRoundRobin: 2 });
    expect(plan.order.map(t => t.id)).toEqual(['t000', 't001', 't002']);
    expect(plan.state.cursor).toBe('t002');
    // The cursor's own tab closes: the next batch still starts after its place.
    const survivors = tabs.filter(t => t.id !== 't002');
    plan = planTabReads(survivors, plan.state, { slowed: true, maxTabsPerPoll: 3, minRoundRobin: 2 });
    expect(plan.order.map(t => t.id)).toEqual(['t003', 't004', 't005']);
    plan = planTabReads(survivors, plan.state, { slowed: true, maxTabsPerPoll: 3, minRoundRobin: 2 });
    expect(plan.order.map(t => t.id)).toEqual(['t000', 't001', 't003']);
  });

  it('capped pages cost nothing: they ride along last and do not use the budget', () => {
    const tabs = [...many(5, () => ({ capped: true })).map(t => ({ ...t, id: `c${t.id}` })), ...many(20)];
    const plan = planTabReads(tabs, initialPlanState(), { slowed: true, maxTabsPerPoll: 12 });
    const uncapped = plan.order.filter(t => !t.capped);
    expect(uncapped).toHaveLength(12);
    expect(plan.order.slice(-5).every(t => t.capped)).toBe(true);
    expect(plan.deferred.every(t => !t.capped)).toBe(true);
  });
});
