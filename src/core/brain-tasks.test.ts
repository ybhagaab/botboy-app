import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import { createStorage, StorageLayer } from './storage.js';
import { createBrainStore, BrainStore, newBrain } from './brain-store.js';
import { setBrainTaskState, removeBrainTask } from './brain-tasks.js';

/**
 * Shared task mutations behind both the chat tools and the project-page
 * task buttons (owner feature 2026-08-27: click a task → Done / Discard /
 * Ask BotBoy to help). One matching rule — exact normalized text or unique
 * substring; ambiguity and misses fail with actionable messages.
 */
describe('brain task mutations', () => {
  let storage: StorageLayer;
  let store: BrainStore;
  let dir: string;

  beforeEach(() => {
    storage = createStorage(':memory:');
    storage.initialize();
    dir = mkdtempSync(path.join(os.tmpdir(), 'ppt-tasks-'));
    store = createBrainStore(storage.getDb(), { brainsDir: dir });
    const brain = newBrain('proj_t1', 'Fatafat Recovery');
    brain.tasks = [
      { state: 'todo', text: 'Obtain August MTD numbers from Swinal' },
      { state: 'doing', text: 'Draft the launch review doc' },
      { state: 'todo', text: 'Draft the launch checklist' },
    ];
    store.write(brain);
  });
  afterEach(() => {
    storage.close();
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  });

  it('sets state by unique substring and persists', () => {
    const outcome = setBrainTaskState(store, 'proj_t1', 'Swinal', 'done');
    expect(outcome.ok).toBe(true);
    expect(store.read('proj_t1')!.tasks.find(t => t.text.includes('Swinal'))!.state).toBe('done');
  });

  it('reopen is the same operation with state todo', () => {
    setBrainTaskState(store, 'proj_t1', 'Swinal', 'done');
    const outcome = setBrainTaskState(store, 'proj_t1', 'Swinal', 'todo');
    expect(outcome.ok).toBe(true);
    expect(store.read('proj_t1')!.tasks.find(t => t.text.includes('Swinal'))!.state).toBe('todo');
  });

  it('ambiguous fragments and unknown tasks fail with actionable messages, unchanged brain', () => {
    const ambiguous = setBrainTaskState(store, 'proj_t1', 'Draft the launch', 'done');
    expect(ambiguous.ok).toBe(false);
    expect(ambiguous.message).toContain('2 tasks match');
    const missing = removeBrainTask(store, 'proj_t1', 'no such task');
    expect(missing.ok).toBe(false);
    expect(missing.message).toContain('no task matching');
    expect(store.read('proj_t1')!.tasks).toHaveLength(3);
  });

  it('removes exactly the matched task line', () => {
    const outcome = removeBrainTask(store, 'proj_t1', 'launch review doc');
    expect(outcome.ok).toBe(true);
    const texts = store.read('proj_t1')!.tasks.map(t => t.text);
    expect(texts).toHaveLength(2);
    expect(texts.join('|')).not.toContain('review doc');
    expect(texts.join('|')).toContain('checklist');
  });

  it('unknown project and invalid state are rejected', () => {
    expect(setBrainTaskState(store, 'proj_missing', 'x', 'done').ok).toBe(false);
    expect(setBrainTaskState(store, 'proj_t1', 'Swinal', 'later').message).toContain('state must be');
  });
});
