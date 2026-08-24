import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import { createStorage, StorageLayer } from './storage.js';
import { createContentStore, refToColumns } from './content-store.js';
import { createBrainStore } from './brain-store.js';
import { createBatcher } from './batcher.js';
import { createFailureRecorder } from './failures.js';
import { createReconciler } from './reconciler.js';
import type { PipelineLlm } from './pipeline-llm.js';

describe('Reconciler', () => {
  let storage: StorageLayer;
  let dir: string;

  beforeEach(() => {
    storage = createStorage(':memory:');
    storage.initialize();
    dir = mkdtempSync(path.join(os.tmpdir(), 'ppt-rec-'));
  });
  afterEach(() => {
    storage.close();
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  });

  function insertOrphan(id: string, title: string, content: string, source = 'browser') {
    const db = storage.getDb();
    const cs = createContentStore(db, { contentDir: dir, inlineThresholdBytes: 1024 });
    const ref = cs.put(id, content);
    const cols = refToColumns(ref);
    db.prepare(
      `INSERT INTO work_items (id, type, source, title, captured_at, process_state, raw_text, content_storage, content_path, content_sha256, content_bytes)
       VALUES (?, 'website_visit', ?, ?, '2026-07-08T10:00:00Z', 'orphaned', ?, ?, ?, ?, ?)`,
    ).run(id, source, title, cols.raw_text, cols.content_storage, cols.content_path, cols.content_sha256, cols.content_bytes);
  }

  function build(llm: PipelineLlm) {
    const db = storage.getDb();
    const brains = createBrainStore(db, { brainsDir: path.join(dir, 'brains') });
    const reconciler = createReconciler({
      db,
      batcher: createBatcher(db, {}),
      contentStore: createContentStore(db, { contentDir: dir, inlineThresholdBytes: 1024 }),
      brainStore: brains,
      failures: createFailureRecorder(db),
      llm,
    });
    return { brains, reconciler };
  }

  const mockLlm = (obj: unknown): PipelineLlm => ({ isAvailable: () => true, complete: async () => JSON.stringify(obj) });

  it('creates a new project from related orphans and routes them (R8.2)', async () => {
    // Passive evidence founds a project only via a distinctive anchor; here
    // each item carries the exact proposed title phrase.
    insertOrphan('a', 'invoice March', 'Client Invoicing — client invoice #1');
    insertOrphan('b', 'invoice April', 'Client Invoicing — client invoice #2');
    insertOrphan('c', 'unrelated', 'random note');

    const { brains, reconciler } = build(
      mockLlm({ newProjects: [{ title: 'Client Invoicing', itemIds: ['a', 'b'] }] }),
    );
    const res = await reconciler.run();
    expect(res.projectsCreated).toBe(1);
    expect(res.itemsAdopted).toBe(2);

    const projects = brains.listProjects();
    expect(projects[0].title).toBe('Client Invoicing');

    const db = storage.getDb();
    expect((db.prepare('SELECT process_state FROM work_items WHERE id = ?').get('a') as any).process_state).toBe('routed');
    expect((db.prepare('SELECT process_state FROM work_items WHERE id = ?').get('b') as any).process_state).toBe('routed');
    // Unrelated orphan stays orphaned (R8.5).
    expect((db.prepare('SELECT process_state FROM work_items WHERE id = ?').get('c') as any).process_state).toBe('orphaned');
  });

  it('keeps passive orphans orphaned when they share only ordinary words with a proposed umbrella title (folder-dump regression, 2026-07-08)', async () => {
    // Two unrelated files from one Downloads ingest: each matches two ordinary
    // tokens of the vague umbrella title, but neither carries a distinctive
    // identifier, the exact title phrase, or a filename-stem anchor. Arrival
    // together must not found a project.
    insertOrphan('a', 'product review notes', 'content ingestion platform review for the product plan');
    insertOrphan('b', 'genre screenshots', 'micro drama platform research screenshots');
    const { reconciler } = build(
      mockLlm({ newProjects: [{ title: 'Content Platform Research', itemIds: ['a', 'b'] }] }),
    );
    const res = await reconciler.run();
    expect(res.projectsCreated).toBe(0);
    expect(res.itemsAdopted).toBe(0);
    const db = storage.getDb();
    expect((db.prepare('SELECT process_state FROM work_items WHERE id = ?').get('a') as any).process_state).toBe('orphaned');
    expect((db.prepare('SELECT process_state FROM work_items WHERE id = ?').get('b') as any).process_state).toBe('orphaned');
    const reasons = db.prepare('SELECT validation_reason AS r FROM routing_decisions').all() as { r: string }[];
    expect(reasons.some((row) => row.r.includes('distinctive anchor'))).toBe(true);
  });

  it('P9: defers when the LLM is unavailable, changing nothing', async () => {
    insertOrphan('a', 'x', 'y');
    const { reconciler } = build({ isAvailable: () => false, complete: async () => '' });
    const res = await reconciler.run();
    expect(res.status).toBe('deferred');
    expect((storage.getDb().prepare('SELECT process_state FROM work_items WHERE id = ?').get('a') as any).process_state).toBe('orphaned');
  });

  it('ignores proposed itemIds that are not actually orphans', async () => {
    insertOrphan('a', 'content migration plan', 'content migration plan', 'manual');
    const { reconciler } = build(
      mockLlm({ newProjects: [{ title: 'Content Migration', itemIds: ['a', 'does-not-exist'] }] }),
    );
    const res = await reconciler.run();
    expect(res.itemsAdopted).toBe(1); // only the real orphan
  });

  it('counts advisory merges/splits without applying them', async () => {
    insertOrphan('a', 'x', 'y');
    const { brains, reconciler } = build(
      mockLlm({ newProjects: [], merges: [{ projectIds: ['p1', 'p2'] }], splits: [{ projectId: 'p3' }] }),
    );
    const res = await reconciler.run();
    expect(res.advisoryMerges).toBe(1);
    expect(res.advisorySplits).toBe(1);
    expect(res.projectsCreated).toBe(0);
    // orphan remains
    expect((storage.getDb().prepare('SELECT process_state FROM work_items WHERE id = ?').get('a') as any).process_state).toBe('orphaned');
  });
});
