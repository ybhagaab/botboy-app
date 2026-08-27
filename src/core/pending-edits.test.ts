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

/**
 * replaceParagraphRange staging (doc editor E1): anchors are docx-text
 * paragraphs, empty replacement = deletion, no 20-char floor (apply-time
 * exactly-once matching is the uniqueness guard), and live tables predating
 * the operation are rebuilt WITHOUT losing createDocument columns
 * (second-pass find: the older migration's copy list predates them).
 */
describe('replaceParagraphRange staging', () => {
  let storage: StorageLayer;
  beforeEach(() => { storage = createStorage(':memory:'); storage.initialize(); });
  afterEach(() => storage.close());

  const base = {
    docKey: 'amazon.sharepoint.com/x/HLD.docx',
    serverRelativeUrl: '/personal/u_amazon_com/Documents/HLD.docx',
    kind: 'manual' as const,
  };

  it('stages a range replace, a deletion (empty replaceWith), and a short-heading anchor', () => {
    const db = storage.getDb();
    const range = createPendingEdit(db, {
      ...base, operation: 'replaceParagraphRange',
      paragraphs: ['Old alpha paragraph.', 'Old beta paragraph.'],
      replaceWith: '## New Section\n\nUnified text.',
    });
    expect(range.operation).toBe('replaceParagraphRange');
    expect(range.paragraphs).toEqual(['Old alpha paragraph.', 'Old beta paragraph.']);
    expect(range.replaceWith).toBe('## New Section\n\nUnified text.');
    expect(range.findText).toBeNull();

    const deletion = createPendingEdit(db, {
      ...base, operation: 'replaceParagraphRange', paragraphs: ['Drop this paragraph.'], replaceWith: '',
    });
    expect(deletion.replaceWith).toBe('');

    const heading = createPendingEdit(db, {
      ...base, operation: 'replaceParagraphRange', paragraphs: ['Goals'], replaceWith: 'Objectives',
    });
    expect(heading.paragraphs).toEqual(['Goals']);

    expect(listPendingEdits(db, base.docKey)).toHaveLength(3);
  });

  it('validates anchors: none, empty entries, too short, multiline', () => {
    const db = storage.getDb();
    expect(() => createPendingEdit(db, { ...base, operation: 'replaceParagraphRange', paragraphs: [], replaceWith: 'x' }))
      .toThrow(/at least one anchor/);
    expect(() => createPendingEdit(db, { ...base, operation: 'replaceParagraphRange', paragraphs: ['ok anchor here', '   '], replaceWith: 'x' }))
      .toThrow(/cannot be empty/);
    expect(() => createPendingEdit(db, { ...base, operation: 'replaceParagraphRange', paragraphs: ['ab'], replaceWith: 'x' }))
      .toThrow(/at least 3 characters/);
    expect(() => createPendingEdit(db, { ...base, operation: 'replaceParagraphRange', paragraphs: ['line one\nline two'], replaceWith: 'x' }))
      .toThrow(/no newlines/);
    expect(() => createPendingEdit(db, { ...base, serverRelativeUrl: '/x/notes.md', operation: 'replaceParagraphRange', paragraphs: ['long enough anchor'], replaceWith: 'x' }))
      .toThrow(/\.docx/);
  });

  it('rebuilds a live table that predates the operation WITHOUT losing createDocument columns', async () => {
    const { default: Database } = await import('better-sqlite3');
    const db = new Database(':memory:');
    // Simulate the pre-E1 table: CHECK admits createDocument but NOT
    // replaceParagraphRange; create_content/project_id columns present.
    db.exec(`
      CREATE TABLE document_pending_edits (
        id TEXT PRIMARY KEY,
        doc_key TEXT NOT NULL,
        server_relative_url TEXT NOT NULL,
        site_url TEXT,
        kind TEXT NOT NULL CHECK(kind IN ('manual','botboy')),
        operation TEXT NOT NULL CHECK(operation IN ('replaceText','appendParagraphs','createDocument')),
        find_text TEXT,
        replace_with TEXT,
        paragraphs_json TEXT,
        create_content TEXT,
        project_id TEXT,
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected','synced','conflicted')),
        conflict_reason TEXT,
        origin_note TEXT,
        created_at TEXT NOT NULL,
        approved_at TEXT,
        synced_at TEXT
      );
    `);
    db.prepare(`
      INSERT INTO document_pending_edits
        (id, doc_key, server_relative_url, kind, operation, create_content, project_id, status, created_at)
      VALUES ('c1', 'k/new-doc.md', '/x/new-doc.md', 'botboy', 'createDocument', '# Authored content body here', 'proj-1', 'pending', '2026-08-25T00:00:00Z')
    `).run();
    db.prepare(`
      INSERT INTO document_pending_edits
        (id, doc_key, server_relative_url, kind, operation, find_text, replace_with, status, created_at, approved_at)
      VALUES ('t1', 'k/doc.docx', '/x/doc.docx', 'manual', 'replaceText', 'the exact passage to be replaced', 'new text', 'approved', '2026-08-25T00:00:00Z', '2026-08-25T01:00:00Z')
    `).run();

    const { ensurePendingEditsTable } = await import('./pending-edits.js');
    ensurePendingEditsTable(db);

    // New op now insertable…
    db.prepare(`
      INSERT INTO document_pending_edits (id, doc_key, server_relative_url, kind, operation, paragraphs_json, replace_with, status, created_at)
      VALUES ('r1', 'k/doc.docx', '/x/doc.docx', 'manual', 'replaceParagraphRange', '["anchor paragraph"]', '', 'pending', '2026-08-26T00:00:00Z')
    `).run();
    // …and EVERY pre-existing column survived, including the creation payload.
    const c1 = db.prepare('SELECT * FROM document_pending_edits WHERE id = ?').get('c1') as any;
    expect(c1.create_content).toBe('# Authored content body here');
    expect(c1.project_id).toBe('proj-1');
    const t1 = db.prepare('SELECT * FROM document_pending_edits WHERE id = ?').get('t1') as any;
    expect(t1.status).toBe('approved');
    expect(t1.approved_at).toBe('2026-08-25T01:00:00Z');
    db.close();
  });
});

/**
 * Conflicted-row dismissal (owner ask 2026-08-27): conflicted rows were
 * stuck in the open lane with no action. Rejection now accepts them —
 * the row settles as rejected WITH its conflict reason kept for audit.
 * Approval still moves only pending rows; synced/rejected stay immutable.
 */
describe('dismissing conflicted edits', () => {
  let storage: StorageLayer;
  beforeEach(() => { storage = createStorage(':memory:'); storage.initialize(); });
  afterEach(() => storage.close());

  it('conflicted → rejected keeps the reason; approved/synced stay guarded', () => {
    const db = storage.getDb();
    const base = {
      docKey: 'k/HLD.docx',
      serverRelativeUrl: '/x/HLD.docx',
      kind: 'manual' as const,
      operation: 'replaceParagraphRange' as const,
      paragraphs: ['a stale anchor paragraph'],
      replaceWith: 'new text',
    };
    const conflicted = createPendingEdit(db, base);
    decidePendingEdit(db, conflicted.id, 'approved');
    markEditConflicted(db, conflicted.id, 'the paragraph run was not found in the current document');

    // Conflicted rows cannot be re-approved…
    expect(() => decidePendingEdit(db, conflicted.id, 'approved')).toThrow(/already conflicted/);
    // …but CAN be dismissed.
    const dismissed = decidePendingEdit(db, conflicted.id, 'rejected');
    expect(dismissed.status).toBe('rejected');
    expect(dismissed.conflictReason).toMatch(/not found/);
    // Terminal after dismissal.
    expect(() => decidePendingEdit(db, conflicted.id, 'rejected')).toThrow(/already rejected/);

    const synced = createPendingEdit(db, { ...base, paragraphs: ['another anchor paragraph'] });
    decidePendingEdit(db, synced.id, 'approved');
    markEditSynced(db, synced.id);
    expect(() => decidePendingEdit(db, synced.id, 'rejected')).toThrow(/already synced/);
  });
});
