import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fc from 'fast-check';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { createStorage, StorageLayer } from './storage.js';
import { createBrainStore, BrainStore, Brain, newBrain, TaskState } from './brain-store.js';

describe('BrainStore', () => {
  let storage: StorageLayer;
  let brains: BrainStore;
  let brainsDir: string;

  beforeEach(() => {
    storage = createStorage(':memory:');
    storage.initialize();
    brainsDir = mkdtempSync(path.join(os.tmpdir(), 'ppt-brains-'));
    brains = createBrainStore(storage.getDb(), { brainsDir });
  });

  afterEach(() => {
    storage.close();
    try { rmSync(brainsDir, { recursive: true, force: true }); } catch {}
  });

  const sampleBrain = (): Brain => ({
    id: 'proj_fatafat',
    title: 'Fatafat livestream — prod stability',
    status: 'active',
    people: ['anmol', 'you'],
    updated: '2026-07-08T09:20:00Z',
    summary: 'Stabilizing the livestream service ahead of launch.',
    statusLine: '🔴 blocked — prod 500, deadline 3pm',
    tasks: [
      { state: 'doing', text: 'Hotfix null tenantId — branch hotfix/stream-start' },
      { state: 'done', text: "Repro'd via GitHub #412" },
      { state: 'todo', text: 'Verify fix in ap-south' },
    ],
    blockers: ['prod 500 in ap-south (anmol, 09:14)'],
    activityLog: [
      '2026-07-08T09:14 anmol flagged prod 500',
      '2026-07-08T09:16 opened GitHub #412',
    ],
  });

  // ── P10: deterministic (de)serialization round-trip ──
  it('P10: parse(serialize(b)) is structurally equal to b', () => {
    const b = sampleBrain();
    const round = brains.parse(brains.serialize(b));
    expect(round).toEqual(b);
  });

  it('P10: round-trips arbitrary brains (property)', () => {
    const arbTask = fc.record({
      state: fc.constantFrom<TaskState>('todo', 'doing', 'blocked', 'done'),
      // avoid newlines and leading markdown that would break the line-based format
      text: fc.string({ minLength: 1, maxLength: 60 }).map((s) => s.replace(/[\n\r]/g, ' ').trim() || 'task'),
    });
    const cleanLine = (s: string) => s.replace(/[\n\r]/g, ' ').trim();
    const arbBrain = fc.record({
      id: fc.constant('proj_x'),
      title: fc.string({ minLength: 1, maxLength: 40 }).map((s) => cleanLine(s) || 'Title'),
      status: fc.constantFrom('active', 'paused', 'done', 'archived') as fc.Arbitrary<Brain['status']>,
      people: fc.array(fc.string({ minLength: 1, maxLength: 12 }).map((s) => s.replace(/[\n\r,\]\[]/g, '').trim() || 'p'), { maxLength: 4 }),
      updated: fc.constant('2026-07-08T09:20:00Z'),
      summary: fc.string({ maxLength: 120 }).map((s) => cleanLine(s)),
      statusLine: fc.string({ maxLength: 60 }).map((s) => cleanLine(s)),
      tasks: fc.array(arbTask, { maxLength: 5 }),
      blockers: fc.array(fc.string({ minLength: 1, maxLength: 40 }).map((s) => cleanLine(s) || 'b'), { maxLength: 4 }),
      activityLog: fc.array(fc.string({ minLength: 1, maxLength: 40 }).map((s) => cleanLine(s) || 'l'), { maxLength: 5 }),
    });

    fc.assert(
      fc.property(arbBrain, (b) => {
        const round = brains.parse(brains.serialize(b as Brain));
        expect(round).toEqual(b);
      }),
      { numRuns: 150 },
    );
  });

  it('write() persists the file and upserts the projects index', () => {
    const b = sampleBrain();
    brains.write(b, 'Fatafat livestream launch');
    const row = brains.getProject('proj_fatafat')!;
    expect(row.title).toBe(b.title);
    expect(row.one_liner).toBe('Fatafat livestream launch');
    expect(row.brain_sha256).toBeTruthy();

    const reread = brains.read('proj_fatafat')!;
    expect(reread.tasks).toHaveLength(3);
    expect(reread.summary).toBe(b.summary);
  });

  it('hasManualEdit detects on-disk changes vs the recorded checksum (R7.5)', () => {
    const b = sampleBrain();
    brains.write(b);
    expect(brains.hasManualEdit('proj_fatafat')).toBe(false);

    // Simulate a user editing the file directly.
    writeFileSync(brains.brainPathFor('proj_fatafat'), '---\nid: proj_fatafat\n---\n## Summary\nedited by hand\n', 'utf8');
    expect(brains.hasManualEdit('proj_fatafat')).toBe(true);
  });

  it('newBrain scaffolds an empty active project', () => {
    const b = newBrain('proj_new', 'New Thing');
    expect(b.status).toBe('active');
    expect(b.tasks).toEqual([]);
    // scaffold survives a round-trip
    expect(brains.parse(brains.serialize(b))).toEqual(b);
  });
});
