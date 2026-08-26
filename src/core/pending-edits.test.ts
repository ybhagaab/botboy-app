import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createStorage, StorageLayer } from './storage.js';
import {
  createPendingEdit,
  listPendingEdits,
  decidePendingEdit,
  markEditSynced,
  markEditConflicted,
} from './pending-edits.js';

/**
 * Pending-edits ledger (document-workbench R3.1/R3.2/R3.4): validation at
 * creation, owner-only decisions, terminal states preserved for audit.
 */
describe('pending edits ledger', () => {
  let storage: StorageLayer;
  beforeEach(() => { storage = createStorage(':memory:'); storage.initialize(); });
  afterEach(() => storage.close());

  const base = {
    docKey: 'amazon.sharepoint.com/x/HLD.docx',
    serverRelativeUrl: '/personal/u_amazon_com/Documents/HLD.docx',
    kind: 'manual' as const,
  };

  it('validates creation: short/multiline findText, empty replacement, empty paragraphs, non-docx', () => {
    expect(() => createPendingEdit(storage.getDb(), { ...base, operation: 'replaceText', findText: 'too short', replaceWith: 'x' }))
      .toThrow(/at least 20 characters/);
    expect(() => createPendingEdit(storage.getDb(), { ...base, operation: 'replaceText', findText: 'a passage long enough\nbut multiline here', replaceWith: 'x' }))
      .toThrow(/one paragraph/);
    expect(() => createPendingEdit(storage.getDb(), { ...base, operation: 'replaceText', findText: 'a passage that is long enough to match', replaceWith: '  ' }))
      .toThrow(/replaceWith is required/);
    expect(() => createPendingEdit(storage.getDb(), { ...base, operation: 'appendParagraphs', paragraphs: ['  '] }))
      .toThrow(/at least one non-empty paragraph/);
    expect(() => createPendingEdit(storage.getDb(), { ...base, serverRelativeUrl: '/x/notes.md', operation: 'replaceText', findText: 'a passage that is long enough to match', replaceWith: 'y' }))
      .toThrow(/\.docx/);
  });

  it('lifecycle: pending → approved → synced; pending → rejected; approved → conflicted with reason', () => {
    const db = storage.getDb();
    const a = createPendingEdit(db, { ...base, operation: 'replaceText', findText: 'the rollout starts in EU next quarter', replaceWith: 'the rollout starts in NA in Q1' });
    const b = createPendingEdit(db, { ...base, operation: 'appendParagraphs', paragraphs: ['Appendix: decisions.'] });
    const c = createPendingEdit(db, { ...base, kind: 'botboy', operation: 'replaceText', findText: 'another passage long enough to be unique', replaceWith: 'rewritten', originNote: 'proposed from chat' });

    expect(decidePendingEdit(db, a.id, 'approved').status).toBe('approved');
    expect(decidePendingEdit(db, b.id, 'rejected').status).toBe('rejected');
    expect(() => decidePendingEdit(db, b.id, 'approved')).toThrow(/already rejected/);
    expect(decidePendingEdit(db, c.id, 'approved').status).toBe('approved');

    markEditSynced(db, a.id);
    markEditConflicted(db, c.id, 'passage not found in the current document');

    const edits = listPendingEdits(db, base.docKey);
    expect(edits.map(e => e.status)).toEqual(['synced', 'rejected', 'conflicted']);
    expect(edits[2].conflictReason).toMatch(/not found/);
    expect(edits[2].originNote).toBe('proposed from chat');
    // Terminal rows persist — nothing is deleted.
    expect(edits).toHaveLength(3);
    // Synced/rejected rows never move again.
    markEditConflicted(db, a.id, 'nope'); // no-op: only approved rows conflict
    expect(listPendingEdits(db, base.docKey)[0].status).toBe('synced');
  });
});

/**
 * createDocument staging (authoring-bridge A1): the ledger hosts CREATIONS
 * with the same lifecycle; validation guards duplicates and unsupported
 * content; live tables predating the operation are rebuilt in place.
 */
describe('createDocument staging', () => {
  let storage: StorageLayer;
  beforeEach(() => { storage = createStorage(':memory:'); storage.initialize(); });
  afterEach(() => storage.close());

  const creation = {
    docKey: 'amazon-my.sharepoint.com/personal/u_amazon_com/Documents/BotBoyTests/plan.md',
    serverRelativeUrl: '/personal/u_amazon_com/Documents/BotBoyTests/plan.md',
    kind: 'botboy' as const,
    operation: 'createDocument' as const,
    projectId: 'p1',
    createContent: '# Rollout plan\n\nPhase one covers the EU storefront migration in detail.',
  };

  it('validates: extension, content floor, image references, corpus collision, duplicate staging', () => {
    const db = storage.getDb();
    expect(() => createPendingEdit(db, { ...creation, serverRelativeUrl: '/x/plan.pptx' }))
      .toThrow(/\.md or \.docx/);
    expect(() => createPendingEdit(db, { ...creation, createContent: 'tiny' }))
      .toThrow(/at least 30 characters/);
    expect(() => createPendingEdit(db, { ...creation, createContent: 'A plan with an embedded image reference ![diagram](local.png) inside.' }))
      .toThrow(/images are not supported/);

    // Corpus collision: the docKey already exists as a captured document.
    db.prepare(`
      INSERT INTO work_items (id, type, source, title, url, captured_at, process_state, metadata)
      VALUES ('c1', 'document_capture', 'sharepoint', 'plan.md', 'https://x/plan', '2026-08-25T10:00:00Z', 'routed', ?)
    `).run(JSON.stringify({ docKey: creation.docKey }));
    expect(() => createPendingEdit(db, creation)).toThrow(/already exists in the corpus/);
    db.prepare('DELETE FROM work_items').run();

    const staged = createPendingEdit(db, creation);
    expect(staged.status).toBe('pending');
    expect(staged.createContent).toContain('Rollout plan');
    expect(staged.projectId).toBe('p1');
    expect(() => createPendingEdit(db, creation)).toThrow(/already staged/);
  });

  it('lifecycle mirrors edits: approve → synced; reject; conflict', () => {
    const db = storage.getDb();
    const a = createPendingEdit(db, creation);
    expect(decidePendingEdit(db, a.id, 'approved').status).toBe('approved');
    markEditSynced(db, a.id);
    expect(listPendingEdits(db, creation.docKey)[0].status).toBe('synced');

    const b = createPendingEdit(db, { ...creation, docKey: `${creation.docKey}2`, serverRelativeUrl: `${creation.serverRelativeUrl.replace('.md', '2.md')}` });
    expect(decidePendingEdit(db, b.id, 'rejected').status).toBe('rejected');
  });

  it('MIGRATION: a live table predating createDocument is rebuilt with rows preserved', () => {
    const db = storage.getDb();
    // Simulate the pre-bridge production table.
    db.exec(`
      DROP TABLE IF EXISTS document_pending_edits;
      CREATE TABLE document_pending_edits (
        id TEXT PRIMARY KEY,
        doc_key TEXT NOT NULL,
        server_relative_url TEXT NOT NULL,
        site_url TEXT,
        kind TEXT NOT NULL CHECK(kind IN ('manual','botboy')),
        operation TEXT NOT NULL CHECK(operation IN ('replaceText','appendParagraphs')),
        find_text TEXT,
        replace_with TEXT,
        paragraphs_json TEXT,
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected','synced','conflicted')),
        conflict_reason TEXT,
        origin_note TEXT,
        created_at TEXT NOT NULL,
        approved_at TEXT,
        synced_at TEXT
      );
    `);
    db.prepare(`
      INSERT INTO document_pending_edits (id, doc_key, server_relative_url, kind, operation, find_text, replace_with, status, created_at, synced_at)
      VALUES ('old-1', 'k/hld', '/x/HLD.docx', 'manual', 'replaceText', 'the original passage text here', 'the new text', 'synced', '2026-08-25T09:00:00Z', '2026-08-25T10:00:00Z')
    `).run();

    // Any ledger call triggers the rebuild; the old row survives verbatim
    // and the new operation inserts cleanly.
    const rows = listPendingEdits(db, 'k/hld');
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe('old-1');
    expect(rows[0].status).toBe('synced');
    const created = createPendingEdit(db, creation);
    expect(created.operation).toBe('createDocument');
  });
});
