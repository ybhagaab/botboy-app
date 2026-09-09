import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import { createStorage, type StorageLayer } from './storage.js';
import { createBrainStore, newBrain, type BrainStore, type Brain } from './brain-store.js';
import { applyTodayDeferredProjectRestore, applyTodayItemAction, applyTodayProjectAction, buildTodayView, findTodayActionTarget } from './today.js';

/**
 * Needs attention / Waiting are ranked PROJECT rows (owner ruling
 * 2026-09-09): every eligible project occupies one rail row and every current
 * commitment appears in its detail pane. The flat `attention` / `waiting`
 * arrays remain the concatenation of those lines for item actions, plan-day,
 * and the briefing lead.
 */
describe('buildTodayView › project-grouped attention', () => {
  let storage: StorageLayer;
  let brainsDir: string;
  let brains: BrainStore;

  beforeEach(() => {
    storage = createStorage(':memory:');
    storage.initialize();
    brainsDir = mkdtempSync(path.join(os.tmpdir(), 'ppt-attn-'));
    brains = createBrainStore(storage.getDb(), { brainsDir });
  });
  afterEach(() => { storage.close(); rmSync(brainsDir, { recursive: true, force: true }); });

  function project(id: string, title: string, tasks: Array<{ state: Brain['tasks'][number]['state']; text: string }>, blockers: string[] = []): void {
    const brain = newBrain(id, title);
    brain.tasks = tasks;
    brain.blockers = blockers;
    brain.statusLine = `${title} in flight`;
    brains.write(brain);
  }

  it('one row per project: all five current tasks appear in the selected detail', () => {
    project('p_busy', 'Busy Project', [
      { state: 'doing', text: 'Finish the ARD sample for Ravi' },
      { state: 'todo', text: 'Decide the Year-1 manual configuration approach' },
      { state: 'todo', text: 'Estimate the reduced-scope implementation' },
      { state: 'todo', text: 'Confirm a firm launch date by end of August' },
      { state: 'todo', text: 'Write the onboarding assessment' },
    ]);
    project('p_quiet', 'Quiet Project', [{ state: 'todo', text: 'Send the weekly note' }]);

    const view = buildTodayView(storage.getDb(), brains, { now: new Date('2026-09-09T05:00:00.000Z') });
    expect(view.attentionGroups.map(group => [group.projectTitle, group.rank, group.items.length, group.hiddenCount])).toEqual([
      ['Busy Project', 1, 5, 0],
      ['Quiet Project', 2, 1, 0],
    ]);
    const busy = view.attentionGroups[0];
    // Score order inside the detail: open + decision/response wording (82+12) beats in-progress (90).
    expect(busy.items.slice(0, 2).map(item => item.title).sort()).toEqual(['Confirm a firm launch date by end of August', 'Decide the Year-1 manual configuration approach']);
    expect(busy.items[2].title).toBe('Finish the ARD sample for Ravi');
    expect(busy.items).toHaveLength(5);
    expect(busy.counts).toEqual({ open: 4, doing: 1, blocked: 0, blockers: 0, decisions: 2, total: 5 });
    // Flat list = every line in group order; summary counts both units.
    expect(view.attention.map(item => item.title)).toEqual([...busy.items, ...view.attentionGroups[1].items].map(item => item.title));
    expect(view.summary.attentionCount).toBe(6);
    expect(view.summary.attentionShown).toBe(6);
    expect(view.summary.attentionProjects).toBe(2);
    expect(view.summary.attentionProjectsShown).toBe(2);
  });

  it('returns every eligible project beyond the former eight-project cap', () => {
    for (let index = 1; index <= 11; index += 1) {
      project(`p_${index}`, `Project ${String(index).padStart(2, '0')}`, [{ state: 'todo', text: `Current task ${index}` }]);
    }
    const view = buildTodayView(storage.getDb(), brains, { now: new Date('2026-09-09T05:00:00.000Z') });
    expect(view.attentionGroups).toHaveLength(11);
    expect(view.attentionGroups.map(group => group.rank)).toEqual(Array.from({ length: 11 }, (_, index) => index + 1));
    expect(view.attentionGroups.every(group => group.items.length === 1 && group.hiddenCount === 0)).toBe(true);
    expect(view.summary.attentionProjectsShown).toBe(11);
    expect(view.summary.attentionShown).toBe(11);
  });

  it('waiting groups blocked tasks and blockers per project with kind-aware counts', () => {
    project('p_blocked', 'Blocked Project', [
      { state: 'blocked', text: 'Implement reranking (blocked: needs track decision)' },
    ], ['Engineering decision required on retiring the legacy player']);
    const view = buildTodayView(storage.getDb(), brains, { now: new Date('2026-09-09T05:00:00.000Z') });
    expect(view.attentionGroups).toHaveLength(0);
    expect(view.waitingGroups).toHaveLength(1);
    const group = view.waitingGroups[0];
    expect(group.items.map(item => item.kind)).toEqual(['task', 'blocker']);
    expect(group.counts).toMatchObject({ blocked: 1, blockers: 1, total: 2 });
    expect(view.summary.waitingProjects).toBe(1);
  });

  it('a pinned project leads the section even with a lower task score, and its header pin resolves as an action target', () => {
    project('p_a', 'Alpha', [{ state: 'doing', text: 'Alpha work in progress' }]);
    project('p_b', 'Beta', [{ state: 'todo', text: 'Beta open task' }]);
    const db = storage.getDb();
    const now = new Date('2026-09-09T05:00:00.000Z');
    const first = buildTodayView(db, brains, { now });
    expect(first.attentionGroups[0].projectTitle).toBe('Alpha');
    const betaControl = first.attentionGroups[1].projectControlId;
    const target = findTodayActionTarget(first, betaControl);
    expect(target?.kind).toBe('project');
    applyTodayItemAction(db, betaControl, 'pin', { target: target ?? undefined }, now);
    const pinned = buildTodayView(db, brains, { now });
    expect(pinned.attentionGroups[0].projectTitle).toBe('Beta');
    expect(pinned.attentionGroups[0].projectPinned).toBe(true);
    expect(pinned.attentionGroups[0].pinned).toBe(true);
    expect(pinned.attentionGroups[0].items.map(item => item.title)).toEqual(['Beta open task']);
  });

  it('a pinned project with no commitments still gets a card, carrying its focus line', () => {
    project('p_empty', 'Empty Pinned', []);
    const db = storage.getDb();
    const now = new Date('2026-09-09T05:00:00.000Z');
    const view0 = buildTodayView(db, brains, { now });
    expect(view0.attentionGroups).toHaveLength(0);
    const controlId = view0.recent[0].controlId;
    applyTodayItemAction(db, controlId, 'pin', { target: findTodayActionTarget(view0, controlId) ?? undefined }, now);
    const view = buildTodayView(db, brains, { now });
    expect(view.attentionGroups).toHaveLength(1);
    expect(view.attentionGroups[0].items).toHaveLength(0);
    expect(view.attentionGroups[0].focus).toBe('Empty Pinned in flight');
    expect(view.attention).toHaveLength(0);
  });

  it('dismissing one line keeps the project row with the remaining lines', () => {
    project('p_two', 'Two Tasks', [
      { state: 'todo', text: 'First task' },
      { state: 'todo', text: 'Second task' },
    ]);
    const db = storage.getDb();
    const now = new Date('2026-09-09T05:00:00.000Z');
    const view = buildTodayView(db, brains, { now });
    const first = view.attentionGroups[0].items[0];
    applyTodayItemAction(db, first.id, 'dismiss', { target: findTodayActionTarget(view, first.id) ?? undefined }, now);
    const after = buildTodayView(db, brains, { now });
    expect(after.attentionGroups).toHaveLength(1);
    expect(after.attentionGroups[0].items.map(item => item.title)).toEqual([view.attentionGroups[0].items[1].title]);
    expect(after.attentionGroups[0].counts.total).toBe(1);
    expect(after.deferred.map(item => item.title)).toEqual([first.title]);
  });

  it('project actions are section-scoped, preserve the project pin, and new stable ids reappear', () => {
    const currentAttention = 'Send the current decision note';
    const currentBlocked = 'Implement the current migration (blocked)';
    const currentBlocker = 'Current legal approval is outstanding';
    project('p_mixed', 'Mixed Project', [
      { state: 'todo', text: currentAttention },
      { state: 'blocked', text: currentBlocked },
    ], [currentBlocker]);
    const db = storage.getDb();
    const now = new Date('2026-09-09T05:00:00.000Z');
    const initial = buildTodayView(db, brains, { now });
    const projectControlId = initial.attentionGroups[0].projectControlId;
    applyTodayItemAction(db, projectControlId, 'pin', {
      target: findTodayActionTarget(initial, projectControlId) ?? undefined,
    }, now);

    const pinned = buildTodayView(db, brains, { now });
    const attentionIds = pinned.attentionGroups[0].items.map(item => item.id);
    const waitingIds = pinned.waitingGroups[0].items.map(item => item.id);
    const dismissed = applyTodayProjectAction(db, pinned.attentionGroups[0], 'dismiss', {}, now);
    expect(dismissed.itemIds).toEqual(attentionIds);

    const afterAttention = buildTodayView(db, brains, { now });
    expect(afterAttention.attention).toHaveLength(0);
    expect(afterAttention.attentionGroups[0]).toMatchObject({ projectId: 'p_mixed', projectPinned: true, items: [] });
    expect(afterAttention.waitingGroups[0].items.map(item => item.id)).toEqual(waitingIds);

    const snoozed = applyTodayProjectAction(db, afterAttention.waitingGroups[0], 'snooze', {
      snoozedUntil: '2026-09-10T09:00:00.000Z',
    }, now);
    expect(snoozed.itemIds).toEqual(waitingIds);
    const afterBoth = buildTodayView(db, brains, { now });
    expect(afterBoth.waitingGroups).toHaveLength(0);
    expect(afterBoth.deferred.map(item => item.title).sort()).toEqual([currentAttention, currentBlocked, currentBlocker].sort());

    const newAttention = 'Send the new launch decision';
    const newBlocked = 'Implement the new cutover (blocked)';
    const newBlocker = 'New finance approval is outstanding';
    project('p_mixed', 'Mixed Project', [
      { state: 'todo', text: currentAttention },
      { state: 'todo', text: newAttention },
      { state: 'blocked', text: currentBlocked },
      { state: 'blocked', text: newBlocked },
    ], [currentBlocker, newBlocker]);
    const withNewIds = buildTodayView(db, brains, { now });
    expect(withNewIds.attentionGroups[0].items.map(item => item.title)).toEqual([newAttention]);
    expect(withNewIds.waitingGroups[0].items.map(item => item.title).sort()).toEqual([newBlocked, newBlocker].sort());
    expect(withNewIds.attentionGroups[0].projectPinned).toBe(true);
  });

  it('restores one project’s current deferred items atomically and preserves project and item pins', () => {
    project('p_restore', 'Recovery Project', [
      { state: 'todo', text: 'Send the recovery decision' },
      { state: 'blocked', text: 'Wait for the recovery approval' },
    ], ['Recovery dependency is outstanding']);
    const db = storage.getDb();
    const now = new Date('2026-09-09T05:00:00.000Z');
    const initial = buildTodayView(db, brains, { now });
    const projectControlId = initial.attentionGroups[0].projectControlId;
    const pinnedItemId = initial.attentionGroups[0].items[0].id;
    applyTodayItemAction(db, projectControlId, 'pin', {
      target: findTodayActionTarget(initial, projectControlId) ?? undefined,
    }, now);
    applyTodayItemAction(db, pinnedItemId, 'pin', {
      target: findTodayActionTarget(initial, pinnedItemId) ?? undefined,
    }, now);

    const pinned = buildTodayView(db, brains, { now });
    applyTodayProjectAction(db, pinned.attentionGroups[0], 'dismiss', {}, now);
    applyTodayProjectAction(db, pinned.waitingGroups[0], 'snooze', {
      snoozedUntil: '2026-09-10T09:00:00.000Z',
    }, now);
    const deferred = buildTodayView(db, brains, { now });
    const targets = deferred.deferred
      .map(item => findTodayActionTarget(deferred, item.id))
      .filter((target): target is NonNullable<typeof target> => target !== null);
    expect(targets).toHaveLength(3);

    const result = applyTodayDeferredProjectRestore(db, [...targets, targets[0]], deferred.since, now);
    expect(result.itemIds).toEqual(targets.map(target => target.id));
    const restored = buildTodayView(db, brains, { now });
    expect(restored.deferred).toHaveLength(0);
    expect(restored.attentionGroups[0]).toMatchObject({ projectId: 'p_restore', projectPinned: true });
    expect(restored.attentionGroups[0].items.find(item => item.id === pinnedItemId)?.pinned).toBe(true);
    expect(restored.waitingGroups[0].items).toHaveLength(2);
  });
});
