/**
 * Pending document edits — the approval lane (document-workbench R3).
 *
 * Every body edit, whether the owner typed it in the reader or BotBoy
 * proposed it from chat, becomes a LEDGERED row here: old vs new, visible in
 * the reader, applied to SharePoint only after an explicit owner Approve and
 * an explicit Sync. Rows are never deleted by the machinery — terminal
 * states (`rejected`, `synced`, `conflicted`) stay for audit, consistent
 * with the curation invariants (everything reversible, everything ledgered).
 *
 * Shared by the documents router (reader UI) and tool-executor (chat
 * propose mode) — the table is created here so both sides agree on shape.
 */

import type Database from 'better-sqlite3';
import { randomUUID } from 'crypto';

export type PendingEditKind = 'manual' | 'botboy';
export type PendingEditOperation = 'replaceText' | 'appendParagraphs' | 'createDocument';
export type PendingEditStatus = 'pending' | 'approved' | 'rejected' | 'synced' | 'conflicted';

export interface PendingEdit {
  id: string;
  docKey: string;
  serverRelativeUrl: string;
  siteUrl: string | null;
  kind: PendingEditKind;
  operation: PendingEditOperation;
  findText: string | null;
  replaceWith: string | null;
  paragraphs: string[] | null;
  /** createDocument: the full authored markdown content. */
  createContent: string | null;
  /** createDocument: project whose Documents tab hosts the approval. */
  projectId: string | null;
  status: PendingEditStatus;
  conflictReason: string | null;
  originNote: string | null;
  createdAt: string;
  approvedAt: string | null;
  syncedAt: string | null;
}

export interface CreatePendingEditInput {
  docKey: string;
  serverRelativeUrl: string;
  siteUrl?: string;
  kind: PendingEditKind;
  operation: PendingEditOperation;
  findText?: string;
  replaceWith?: string;
  paragraphs?: string[];
  createContent?: string;
  projectId?: string;
  originNote?: string;
}

const TABLE_SCHEMA = `(
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
    )`;

export function ensurePendingEditsTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS document_pending_edits ${TABLE_SCHEMA};
    CREATE INDEX IF NOT EXISTS idx_pending_edits_dockey ON document_pending_edits(doc_key, status);
  `);
  // Migration (authoring-bridge A1): live tables predating `createDocument`
  // carry a CHECK that would reject the new operation — SQLite cannot ALTER
  // a CHECK, so rebuild once (create-copy-drop-rename). CREATE IF NOT EXISTS
  // never alters live tables; this introspection is the upgrade path.
  const schema = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='document_pending_edits'",
  ).get() as { sql: string } | undefined;
  if (schema && !schema.sql.includes('createDocument')) {
    db.exec(`
      BEGIN;
      CREATE TABLE document_pending_edits_new ${TABLE_SCHEMA};
      INSERT INTO document_pending_edits_new
        (id, doc_key, server_relative_url, site_url, kind, operation, find_text, replace_with,
         paragraphs_json, status, conflict_reason, origin_note, created_at, approved_at, synced_at)
      SELECT id, doc_key, server_relative_url, site_url, kind, operation, find_text, replace_with,
             paragraphs_json, status, conflict_reason, origin_note, created_at, approved_at, synced_at
      FROM document_pending_edits;
      DROP TABLE document_pending_edits;
      ALTER TABLE document_pending_edits_new RENAME TO document_pending_edits;
      CREATE INDEX IF NOT EXISTS idx_pending_edits_dockey ON document_pending_edits(doc_key, status);
      COMMIT;
    `);
    console.log('[PendingEdits] table rebuilt for createDocument support (rows preserved)');
  }
}

function rowToEdit(row: Record<string, unknown>): PendingEdit {
  let paragraphs: string[] | null = null;
  if (typeof row.paragraphs_json === 'string' && row.paragraphs_json) {
    try { paragraphs = JSON.parse(row.paragraphs_json) as string[]; } catch { paragraphs = null; }
  }
  return {
    id: String(row.id),
    docKey: String(row.doc_key),
    serverRelativeUrl: String(row.server_relative_url),
    siteUrl: (row.site_url as string | null) ?? null,
    kind: row.kind as PendingEditKind,
    operation: row.operation as PendingEditOperation,
    findText: (row.find_text as string | null) ?? null,
    replaceWith: (row.replace_with as string | null) ?? null,
    paragraphs,
    createContent: (row.create_content as string | null) ?? null,
    projectId: (row.project_id as string | null) ?? null,
    status: row.status as PendingEditStatus,
    conflictReason: (row.conflict_reason as string | null) ?? null,
    originNote: (row.origin_note as string | null) ?? null,
    createdAt: String(row.created_at),
    approvedAt: (row.approved_at as string | null) ?? null,
    syncedAt: (row.synced_at as string | null) ?? null,
  };
}

/** Validates and inserts a pending edit; throws Error with a user-facing message. */
export function createPendingEdit(db: Database.Database, input: CreatePendingEditInput, nowIso = new Date().toISOString()): PendingEdit {
  ensurePendingEditsTable(db);
  if (!input.docKey.trim()) throw new Error('docKey is required');
  if (!input.serverRelativeUrl.trim()) throw new Error('serverRelativeUrl is required');
  const lowerTarget = input.serverRelativeUrl.toLowerCase();
  if (input.operation !== 'createDocument' && !lowerTarget.endsWith('.docx')) {
    throw new Error('pending edits cover .docx documents');
  }
  if (input.operation === 'createDocument') {
    if (!lowerTarget.endsWith('.md') && !lowerTarget.endsWith('.docx')) {
      throw new Error('created documents must be .md or .docx');
    }
    const content = String(input.createContent ?? '');
    if (content.trim().length < 30) throw new Error('createContent must be at least 30 characters of real content');
    if (/!\[[^\]]*\]\(/.test(content)) {
      throw new Error('images are not supported in created documents (v1) — remove image references or link to them as URLs');
    }
    // The corpus must not already know this document — creation would
    // shadow an existing doc; the model should EDIT instead.
    const existing = db.prepare(`
      SELECT 1 FROM work_items
      WHERE source = 'sharepoint' AND type = 'document_capture'
        AND json_extract(metadata, '$.docKey') = ? LIMIT 1
    `).get(input.docKey);
    if (existing) throw new Error('a document with this target already exists in the corpus — edit it instead of creating a duplicate');
    const openCreation = db.prepare(`
      SELECT 1 FROM document_pending_edits
      WHERE doc_key = ? AND operation = 'createDocument' AND status IN ('pending','approved') LIMIT 1
    `).get(input.docKey);
    if (openCreation) throw new Error('a creation for this target is already staged — approve or reject it first');
  } else if (input.operation === 'replaceText') {
    const findText = String(input.findText ?? '');
    if (findText.trim().length < 20) {
      throw new Error('findText must be at least 20 characters — shorter passages cannot be matched uniquely in the document');
    }
    if (findText.includes('\n')) throw new Error('findText must stay within one paragraph (no newlines)');
    if (!String(input.replaceWith ?? '').trim()) throw new Error('replaceWith is required for replaceText');
  } else if (input.operation === 'appendParagraphs') {
    const paragraphs = (input.paragraphs ?? []).filter(p => p.trim());
    if (paragraphs.length === 0) throw new Error('appendParagraphs needs at least one non-empty paragraph');
  } else {
    throw new Error('operation must be replaceText, appendParagraphs, or createDocument');
  }

  const edit: PendingEdit = {
    id: randomUUID(),
    docKey: input.docKey,
    serverRelativeUrl: input.serverRelativeUrl,
    siteUrl: input.siteUrl?.trim() || null,
    kind: input.kind,
    operation: input.operation,
    findText: input.operation === 'replaceText' ? String(input.findText) : null,
    replaceWith: input.operation === 'replaceText' ? String(input.replaceWith) : null,
    paragraphs: input.operation === 'appendParagraphs' ? (input.paragraphs ?? []).filter(p => p.trim()) : null,
    createContent: input.operation === 'createDocument' ? String(input.createContent) : null,
    projectId: input.projectId?.trim() || null,
    status: 'pending',
    conflictReason: null,
    originNote: input.originNote?.slice(0, 300) || null,
    createdAt: nowIso,
    approvedAt: null,
    syncedAt: null,
  };
  db.prepare(`
    INSERT INTO document_pending_edits
      (id, doc_key, server_relative_url, site_url, kind, operation, find_text, replace_with, paragraphs_json, create_content, project_id, status, origin_note, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
  `).run(
    edit.id, edit.docKey, edit.serverRelativeUrl, edit.siteUrl, edit.kind, edit.operation,
    edit.findText, edit.replaceWith, edit.paragraphs ? JSON.stringify(edit.paragraphs) : null,
    edit.createContent, edit.projectId,
    edit.originNote, edit.createdAt,
  );
  return edit;
}

/** Staged creations for a project's Documents tab (authoring bridge A3). */
export function listStagedCreations(db: Database.Database, projectId: string): PendingEdit[] {
  ensurePendingEditsTable(db);
  const rows = db.prepare(`
    SELECT * FROM document_pending_edits
    WHERE operation = 'createDocument' AND project_id = ? AND status IN ('pending','approved','conflicted')
    ORDER BY created_at ASC, rowid ASC
  `).all(projectId) as Array<Record<string, unknown>>;
  return rows.map(rowToEdit);
}

export function listPendingEdits(db: Database.Database, docKey: string): PendingEdit[] {
  ensurePendingEditsTable(db);
  const rows = db.prepare(
    'SELECT * FROM document_pending_edits WHERE doc_key = ? ORDER BY created_at ASC, rowid ASC',
  ).all(docKey) as Array<Record<string, unknown>>;
  return rows.map(rowToEdit);
}

export function getPendingEdit(db: Database.Database, id: string): PendingEdit | null {
  ensurePendingEditsTable(db);
  const row = db.prepare('SELECT * FROM document_pending_edits WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  return row ? rowToEdit(row) : null;
}

/** Owner decision transitions. Only pending rows move; anything else throws. */
export function decidePendingEdit(db: Database.Database, id: string, decision: 'approved' | 'rejected', nowIso = new Date().toISOString()): PendingEdit {
  const edit = getPendingEdit(db, id);
  if (!edit) throw new Error(`unknown pending edit '${id}'`);
  if (edit.status !== 'pending') throw new Error(`edit is already ${edit.status}`);
  db.prepare('UPDATE document_pending_edits SET status = ?, approved_at = ? WHERE id = ?')
    .run(decision, decision === 'approved' ? nowIso : null, id);
  return getPendingEdit(db, id)!;
}

/** Sync outcomes. Approved rows only. */
export function markEditSynced(db: Database.Database, id: string, nowIso = new Date().toISOString()): void {
  db.prepare("UPDATE document_pending_edits SET status = 'synced', synced_at = ?, conflict_reason = NULL WHERE id = ? AND status = 'approved'").run(nowIso, id);
}

export function markEditConflicted(db: Database.Database, id: string, reason: string): void {
  db.prepare("UPDATE document_pending_edits SET status = 'conflicted', conflict_reason = ? WHERE id = ? AND status = 'approved'").run(reason.slice(0, 300), id);
}
