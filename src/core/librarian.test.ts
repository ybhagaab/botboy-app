import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import { createStorage, StorageLayer } from './storage.js';
import { createContentStore, refToColumns } from './content-store.js';
import { createBrainStore, newBrain } from './brain-store.js';
import { createBatcher } from './batcher.js';
import { createFailureRecorder } from './failures.js';
import { createLibrarian, Librarian } from './librarian.js';
import type { PipelineLlm } from './pipeline-llm.js';

describe('Librarian', () => {
  let storage: StorageLayer;
  let dir: string;

  beforeEach(() => {
    storage = createStorage(':memory:');
    storage.initialize();
    dir = mkdtempSync(path.join(os.tmpdir(), 'ppt-lib-'));
  });
  afterEach(() => {
    storage.close();
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  });

  function insertExtracted(id: string, title: string, content: string, source = 'browser') {
    const db = storage.getDb();
    const cs = createContentStore(db, { contentDir: dir, inlineThresholdBytes: 1024 });
    const ref = cs.put(id, content);
    const cols = refToColumns(ref);
    db.prepare(
      `INSERT INTO work_items (id, type, source, title, captured_at, process_state, raw_text, content_storage, content_path, content_sha256, content_bytes)
       VALUES (?, 'website_visit', ?, ?, ?, 'extracted', ?, ?, ?, ?, ?)`,
    ).run(id, source, title, '2026-07-08T10:00:00Z', cols.raw_text, cols.content_storage, cols.content_path, cols.content_sha256, cols.content_bytes);
  }

  function build(llm: PipelineLlm): { lib: Librarian; brains: ReturnType<typeof createBrainStore> } {
    const db = storage.getDb();
    const brains = createBrainStore(db, { brainsDir: path.join(dir, 'brains') });
    const lib = createLibrarian({
      db,
      batcher: createBatcher(db, { waveSize: 50 }),
      contentStore: createContentStore(db, { contentDir: dir, inlineThresholdBytes: 1024 }),
      brainStore: brains,
      failures: createFailureRecorder(db),
      llm,
    });
    return { lib, brains };
  }

  const mockLlm = (respFor: (prompt: string) => string): PipelineLlm => ({
    isAvailable: () => true,
    complete: async (p) => respFor(p),
  });

  it('P9: when LLM unavailable, defers and changes no item state', async () => {
    insertExtracted('a', 'Livestream bug', 'prod 500');
    const down: PipelineLlm = { isAvailable: () => false, complete: async () => '' };
    const { lib } = build(down);
    const res = await lib.runWave();
    expect(res.status).toBe('deferred');
    const row = storage.getDb().prepare('SELECT process_state FROM work_items WHERE id = ?').get('a') as any;
    expect(row.process_state).toBe('extracted'); // unchanged
  });

  it('assigns items to an existing project', async () => {
    const db = storage.getDb();
    const brains = createBrainStore(db, { brainsDir: path.join(dir, 'brains') });
    brains.write(newBrain('proj_fatafat', 'Fatafat livestream'), 'Fatafat livestream');
    insertExtracted('a', 'Livestream bug', 'Fatafat livestream prod 500 on stream/start');

    const { lib } = build(
      mockLlm(() => JSON.stringify([{ itemId: 'a', decision: 'assign', projectId: 'proj_fatafat' }])),
    );
    const res = await lib.runWave();
    expect(res.assigned).toBe(1);
    const row = db.prepare('SELECT process_state, project_id FROM work_items WHERE id = ?').get('a') as any;
    expect(row.process_state).toBe('routed');
    expect(row.project_id).toBe('proj_fatafat');
  });

  it('validates assignment against the founding scope, not a drifted title (contamination regression, 2026-08-21)', async () => {
    const db = storage.getDb();
    const brains = createBrainStore(db, { brainsDir: path.join(dir, 'brains') });
    brains.write(newBrain('proj_md', 'Micro Drama Research'), 'Micro Drama Research');
    // Simulate scope drift: a contaminated brain rewrote the title/brief to
    // cover a second workstream. founding_scope keeps the original anchor.
    db.prepare("UPDATE projects SET title = 'Micro Drama and Audience Simulation Engine Research', one_liner = 'Audience Simulation Engine Layer 3 documentation' WHERE id = 'proj_md'").run();

    // Evidence about the drifted topic only — anchors the widened title but
    // not the founding scope. Must be orphaned, not assigned.
    insertExtracted('a', 'Audience Simulation Engine docs', 'Layer 3 documentation for the audience simulation engine');
    const { lib } = build(
      mockLlm(() => JSON.stringify([{ itemId: 'a', decision: 'assign', projectId: 'proj_md' }])),
    );
    const res = await lib.runWave();
    expect(res.assigned).toBe(0);
    expect(res.orphaned).toBe(1);
    const row = db.prepare('SELECT process_state, project_id FROM work_items WHERE id = ?').get('a') as any;
    expect(row.process_state).toBe('orphaned');
    expect(row.project_id).toBeNull();

    // Evidence genuinely about the founding scope still assigns.
    insertExtracted('b', 'Micro drama platform notes', 'micro drama research field notes');
    const { lib: lib2 } = build(
      mockLlm(() => JSON.stringify([{ itemId: 'b', decision: 'assign', projectId: 'proj_md' }])),
    );
    const res2 = await lib2.runWave();
    expect(res2.assigned).toBe(1);
  });

  it('creates a new project (with brain) when decision is "new"', async () => {
    insertExtracted('a', 'Hiring loop kickoff', 'Q3 eng hiring', 'manual');
    const { lib, brains } = build(
      mockLlm(() => JSON.stringify([{ itemId: 'a', decision: 'new', newTitle: 'Q3 Hiring' }])),
    );
    const res = await lib.runWave();
    expect(res.created).toBe(1);
    const projects = brains.listProjects();
    expect(projects).toHaveLength(1);
    expect(projects[0].title).toBe('Q3 Hiring');
    const row = storage.getDb().prepare('SELECT process_state, project_id FROM work_items WHERE id = ?').get('a') as any;
    expect(row.process_state).toBe('routed');
    expect(row.project_id).toBe(projects[0].id);
  });

  it('marks noise and orphans omitted/unplaceable items', async () => {
    insertExtracted('a', 'noise item', 'blah');
    insertExtracted('b', 'omitted item', 'blah');
    const { lib } = build(
      // decision only for 'a'; 'b' omitted → should become orphan
      mockLlm(() => JSON.stringify([{ itemId: 'a', decision: 'noise' }])),
    );
    const res = await lib.runWave();
    expect(res.noise).toBe(1);
    expect(res.orphaned).toBe(1);
    const rows = storage.getDb().prepare('SELECT id, process_state FROM work_items ORDER BY id').all() as any[];
    expect(rows.find((r) => r.id === 'a').process_state).toBe('noise');
    expect(rows.find((r) => r.id === 'b').process_state).toBe('orphaned');
  });
});
