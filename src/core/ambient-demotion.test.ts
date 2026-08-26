import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import { createStorage, StorageLayer } from './storage.js';
import { createBrainStore, newBrain } from './brain-store.js';
import { demoteAmbientProjects } from './ambient-demotion.js';

/**
 * Focused suite for the SharePoint comments exception (sharepoint-comments
 * R4.2): engaged document comments are adoption; foreign comments stay
 * passive like synced document content. The broader demotion feature
 * predates this suite (feature-maps backfill rule: tested where touched).
 */
describe('demoteAmbientProjects — document_comment engagement exception', () => {
  let storage: StorageLayer;
  let dir: string;

  beforeEach(() => {
    storage = createStorage(':memory:');
    storage.initialize();
    dir = mkdtempSync(path.join(os.tmpdir(), 'ppt-demote-'));
  });
  afterEach(() => {
    storage.close();
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  function project(id: string, title: string) {
    const brains = createBrainStore(storage.getDb(), { brainsDir: path.join(dir, 'brains') });
    brains.write(newBrain(id, title), title);
    return brains;
  }

  function insertComment(id: string, projectId: string, metadata: Record<string, string>) {
    storage.getDb().prepare(
      `INSERT INTO work_items (id, type, source, title, captured_at, process_state, project_id, metadata)
       VALUES (?, 'document_comment', 'sharepoint', 'Comment on HLD.docx', '2026-08-20T10:00:00Z', 'routed', ?, ?)`,
    ).run(id, projectId, JSON.stringify(metadata));
  }

  function insertCapture(id: string, projectId: string) {
    storage.getDb().prepare(
      `INSERT INTO work_items (id, type, source, title, captured_at, process_state, project_id, metadata)
       VALUES (?, 'document_capture', 'sharepoint', 'HLD.docx', '2026-08-19T10:00:00Z', 'routed', ?, '{}')`,
    ).run(id, projectId);
  }

  it('an owner-authored comment adopts the project (not demotable)', () => {
    const brains = project('p1', 'Catalog HLD review');
    insertCapture('d1', 'p1');
    insertComment('c1', 'p1', { direction: 'sent', mentionedMe: 'false' });
    const result = demoteAmbientProjects(storage.getDb(), brains);
    expect(result.candidates).toHaveLength(0);
    expect(result.skipped).toHaveLength(0);
  });

  it('a comment naming the owner adopts the project', () => {
    const brains = project('p2', 'Backend unification');
    insertComment('c2', 'p2', { direction: 'received', mentionedMe: 'true' });
    expect(demoteAmbientProjects(storage.getDb(), brains).candidates).toHaveLength(0);
  });

  it('foreign comments alone stay passive — reported as a candidate, never auto-archived', () => {
    const brains = project('p3', 'Someone elses doc');
    insertCapture('d3', 'p3');
    insertComment('c3', 'p3', { direction: 'received', mentionedMe: 'false' });
    const result = demoteAmbientProjects(storage.getDb(), brains, { apply: true }); // passive class needs includePassive
    expect(result.candidates.map(c => c.projectId)).toContain('p3');
    expect(result.archived).toBe(0);
    const status = storage.getDb().prepare("SELECT status FROM projects WHERE id = 'p3'").get() as { status: string };
    expect(status.status).toBe('active');
  });
});
