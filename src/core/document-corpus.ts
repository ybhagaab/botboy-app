/**
 * Document corpus reads (document-workbench): the SINGLE implementation of
 * "what synced SharePoint documents exist" and "the full view of one
 * document" — shared by the documents router (HTTP for the UI) and the chat
 * tools (list_documents / read_document). Lifted verbatim from the router
 * 2026-08-25 so the UI and the model can never disagree about the corpus.
 *
 * Soak find behind the extraction: chat had NO read path into this corpus,
 * so the model browsed SharePoint raw, found the wrong document, and
 * declared the (fully synced) HLD missing.
 */

import { createHash } from 'crypto';
import type Database from 'better-sqlite3';
import type { ContentStore } from './content-store.js';
import { listPendingEdits, type PendingEdit } from './pending-edits.js';
import { getSetting } from './storage.js';
import type { TrackedChange } from './docx-body-editor.js';

/**
 * Unaccepted Word suggestions (tracked changes) are CURRENT document state,
 * not per-revision evidence — they live in a docKey-scoped setting written
 * by the sync engine's comments pass and read here by router + chat tools.
 */
export function suggestionSettingKey(docKey: string): string {
  return `sharepoint_suggestions.${createHash('sha1').update(docKey).digest('hex').slice(0, 16)}`;
}

export interface SuggestionState { docKey: string; changes: TrackedChange[]; updatedAt: string }

// ── Cross-document link graph (doc-link-graph L1) ───────────────────────────

export type DocumentLinkKind = 'hyperlink' | 'reference';

export interface RelatedDocument {
  docKey: string;
  title: string;
  kind: DocumentLinkKind;
  direction: 'outgoing' | 'incoming';
  evidence: string;
}

export function ensureDocumentLinksTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS document_links (
      from_doc_key TEXT NOT NULL,
      to_doc_key TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('hyperlink','reference')),
      evidence TEXT NOT NULL,
      first_seen TEXT NOT NULL,
      last_seen TEXT NOT NULL,
      PRIMARY KEY (from_doc_key, to_doc_key, kind)
    );
    CREATE INDEX IF NOT EXISTS idx_document_links_to ON document_links(to_doc_key);
  `);
}

export interface CorpusLinkIndex {
  /** lowercased serverRelativeUrl → docKey */
  byPathTail: Map<string, string>;
  /** lowercased sourcedoc GUID (no braces) → docKey */
  byGuid: Map<string, string>;
  /** titles ≥ 12 chars after extension strip, lowercased, with docKey */
  titles: Array<{ needle: string; title: string; docKey: string }>;
}

/** One pass over the corpus builds every lookup the resolver needs. */
export function buildCorpusLinkIndex(db: Database.Database): CorpusLinkIndex {
  const rows = db.prepare(`
    SELECT DISTINCT json_extract(metadata, '$.docKey') AS docKey,
           json_extract(metadata, '$.serverRelativeUrl') AS serverRelativeUrl,
           json_extract(metadata, '$.webUrl') AS webUrl,
           title
    FROM work_items
    WHERE source = 'sharepoint' AND type = 'document_capture'
      AND json_extract(metadata, '$.docKey') IS NOT NULL
  `).all() as Array<{ docKey: string; serverRelativeUrl: string | null; webUrl: string | null; title: string | null }>;
  const index: CorpusLinkIndex = { byPathTail: new Map(), byGuid: new Map(), titles: [] };
  const seenTitles = new Set<string>();
  for (const row of rows) {
    if (row.serverRelativeUrl) index.byPathTail.set(row.serverRelativeUrl.toLowerCase(), row.docKey);
    const guid = row.webUrl ? /sourcedoc=(?:%7b|\{)?([0-9a-f-]{36})/i.exec(row.webUrl)?.[1] : undefined;
    if (guid) index.byGuid.set(guid.toLowerCase(), row.docKey);
    const stripped = String(row.title ?? '').replace(/\.[a-z0-9]{2,5}$/i, '').trim();
    if (stripped.length >= 12 && !seenTitles.has(`${stripped.toLowerCase()}\u0000${row.docKey}`)) {
      seenTitles.add(`${stripped.toLowerCase()}\u0000${row.docKey}`);
      index.titles.push({ needle: stripped.toLowerCase(), title: stripped, docKey: row.docKey });
    }
  }
  return index;
}

/**
 * Deterministic edge extraction from one document's stored content:
 *   hyperlink — sharepoint/onedrive URLs resolved by serverRelativeUrl tail
 *   or Doc.aspx sourcedoc GUID; unresolved (external) links are skipped;
 *   reference — exact case-insensitive mention of another corpus title
 *   (≥12 chars). Self-links never emit; one edge per target (hyperlink
 *   outranks reference — titles appear inside their own URLs).
 */
export function extractDocumentLinks(content: string, fromDocKey: string, index: CorpusLinkIndex): Array<{ toDocKey: string; kind: DocumentLinkKind; evidence: string }> {
  const out = new Map<string, { toDocKey: string; kind: DocumentLinkKind; evidence: string }>();
  const snippet = (at: number, length: number) =>
    content.slice(Math.max(0, at - 60), Math.min(content.length, at + length + 60)).replace(/\s+/g, ' ').trim().slice(0, 200);
  const add = (toDocKey: string, kind: DocumentLinkKind, evidence: string) => {
    if (toDocKey === fromDocKey) return;
    const key = `${toDocKey}\u0000${kind}`;
    if (!out.has(key)) out.set(key, { toDocKey, kind, evidence });
  };

  // Hyperlinks: any sharepoint.com URL in the text.
  for (const match of content.matchAll(/https?:\/\/[a-z0-9-]+(?:-my)?\.sharepoint\.com[^\s)>\]"']*/gi)) {
    const url = match[0];
    let decoded = url;
    try { decoded = decodeURIComponent(url); } catch { /* keep raw */ }
    const guid = /sourcedoc=(?:%7b|\{)?([0-9a-f-]{36})/i.exec(url)?.[1];
    if (guid && index.byGuid.has(guid.toLowerCase())) {
      add(index.byGuid.get(guid.toLowerCase())!, 'hyperlink', snippet(match.index!, url.length));
      continue;
    }
    // Path-form: match a known serverRelativeUrl as a suffix of the URL path.
    const pathPart = decoded.replace(/^https?:\/\/[^/]+/i, '').split(/[?#]/)[0].toLowerCase();
    for (const [tail, docKey] of index.byPathTail) {
      if (pathPart.endsWith(tail)) {
        add(docKey, 'hyperlink', snippet(match.index!, url.length));
        break;
      }
    }
  }

  // Title references: exact mention of another document's title. A target
  // already reached by HYPERLINK never doubles as a reference (titles appear
  // inside their own URLs — one edge per target, strongest kind wins).
  const haystack = content.toLowerCase();
  const hyperlinked = new Set([...out.values()].map(link => link.toDocKey));
  for (const { needle, docKey } of index.titles) {
    if (hyperlinked.has(docKey)) continue;
    const at = haystack.indexOf(needle);
    if (at !== -1) add(docKey, 'reference', snippet(at, needle.length));
  }
  return [...out.values()];
}

/** Re-scan REPLACES the doc's outgoing edges atomically; first_seen survives. */
export function replaceOutgoingLinks(db: Database.Database, fromDocKey: string, links: Array<{ toDocKey: string; kind: DocumentLinkKind; evidence: string }>, nowIso = new Date().toISOString()): void {
  ensureDocumentLinksTable(db);
  const tx = db.transaction(() => {
    const keep = links.map(link => `${link.toDocKey}\u0000${link.kind}`);
    const existing = db.prepare('SELECT to_doc_key AS toDocKey, kind FROM document_links WHERE from_doc_key = ?').all(fromDocKey) as Array<{ toDocKey: string; kind: string }>;
    for (const row of existing) {
      if (!keep.includes(`${row.toDocKey}\u0000${row.kind}`)) {
        db.prepare('DELETE FROM document_links WHERE from_doc_key = ? AND to_doc_key = ? AND kind = ?').run(fromDocKey, row.toDocKey, row.kind);
      }
    }
    const upsert = db.prepare(`
      INSERT INTO document_links (from_doc_key, to_doc_key, kind, evidence, first_seen, last_seen)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(from_doc_key, to_doc_key, kind) DO UPDATE SET evidence = excluded.evidence, last_seen = excluded.last_seen
    `);
    for (const link of links) upsert.run(fromDocKey, link.toDocKey, link.kind, link.evidence, nowIso, nowIso);
  });
  tx();
}

/** Union of both directions, joined to the LIVE corpus (rows persist when a
 * target leaves the corpus; the join filters them at read). Cap 20/direction. */
export function getRelatedDocuments(db: Database.Database, docKey: string): RelatedDocument[] {
  ensureDocumentLinksTable(db);
  const rows = db.prepare(`
    WITH corpus AS (
      SELECT json_extract(metadata, '$.docKey') AS docKey, MAX(title) AS title
      FROM work_items
      WHERE source = 'sharepoint' AND type = 'document_capture'
      GROUP BY 1
    )
    SELECT l.to_doc_key AS docKey, c.title, l.kind, 'outgoing' AS direction, l.evidence
    FROM document_links l JOIN corpus c ON c.docKey = l.to_doc_key
    WHERE l.from_doc_key = ?
    UNION ALL
    SELECT l.from_doc_key AS docKey, c.title, l.kind, 'incoming' AS direction, l.evidence
    FROM document_links l JOIN corpus c ON c.docKey = l.from_doc_key
    WHERE l.to_doc_key = ?
  `).all(docKey, docKey) as Array<{ docKey: string; title: string | null; kind: DocumentLinkKind; direction: 'outgoing' | 'incoming'; evidence: string }>;
  const outgoing = rows.filter(r => r.direction === 'outgoing').slice(0, 20);
  const incoming = rows.filter(r => r.direction === 'incoming').slice(0, 20);
  return [...outgoing, ...incoming].map(row => ({ ...row, title: String(row.title ?? row.docKey) }));
}

/** Aggregate link counts per docKey (Documents-tab chip). */
export function linkCountsByDocKey(db: Database.Database): Map<string, number> {
  ensureDocumentLinksTable(db);
  const rows = db.prepare(`
    SELECT docKey, SUM(n) AS n FROM (
      SELECT from_doc_key AS docKey, COUNT(*) AS n FROM document_links GROUP BY 1
      UNION ALL
      SELECT to_doc_key AS docKey, COUNT(*) AS n FROM document_links GROUP BY 1
    ) GROUP BY docKey
  `).all() as Array<{ docKey: string; n: number }>;
  return new Map(rows.map(row => [row.docKey, row.n]));
}

/**
 * Derive the docKey a document AT this path will have once captured
 * (authoring bridge: the key exists before the document does — approval
 * lane, sync pass, and reader link all use it). Must match discovery's
 * `${webUrl hostname}${serverRelativeUrl}` derivation:
 *   - team-site paths take the host from the caller's siteUrl;
 *   - personal paths take the tenant's -my host from any existing personal
 *     capture (fallback: amazon-my.sharepoint.com).
 */
export function docKeyForPath(db: Database.Database, serverRelativeUrl: string, siteUrl?: string): string {
  if (siteUrl) {
    try { return `${new URL(siteUrl).hostname}${serverRelativeUrl}`; } catch { /* fall through */ }
  }
  const personal = db.prepare(`
    SELECT json_extract(metadata, '$.docKey') AS docKey FROM work_items
    WHERE source = 'sharepoint' AND type = 'document_capture'
      AND json_extract(metadata, '$.docKey') LIKE '%-my.sharepoint.com/personal/%'
    LIMIT 1
  `).get() as { docKey: string } | undefined;
  const host = personal ? String(personal.docKey).split('/')[0] : 'amazon-my.sharepoint.com';
  return `${host}${serverRelativeUrl}`;
}

export function getSuggestedChanges(db: Database.Database, docKey: string): SuggestionState | null {
  const state = getSetting<SuggestionState>(db, suggestionSettingKey(docKey));
  return state && Array.isArray(state.changes) ? state : null;
}

export interface CorpusDocument {
  docKey: string;
  title: unknown;
  webUrl: unknown;
  serverRelativeUrl: unknown;
  siteUrl: unknown;
  fileType: unknown;
  extractionTier: unknown;
  sizeBytes: number | null;
  lastModified: unknown;
  lastCapturedAt: unknown;
  revisionCount: number;
  latestChangeSummary: unknown;
  commentCount: number;
  resolvedCommentCount: number;
  suggestedChangeCount: number;
  relatedCount: number;
  projectId: string | null;
}

/**
 * One row per document (latest capture per docKey wins), newest first.
 * `projectId` narrows to one project (the project page); `query` is a
 * case-insensitive substring match on title, docKey, and path (chat
 * discovery). Comment counts aggregate across ALL rows of the docKey.
 */
export function listDocumentCorpus(
  db: Database.Database,
  opts: { projectId?: string; query?: string; limit?: number } = {},
): CorpusDocument[] {
  const filters: string[] = [];
  const params: unknown[] = [];
  if (opts.projectId) { filters.push('project_id = ?'); params.push(opts.projectId); }
  const rows = db.prepare(`
    WITH captures AS (
      SELECT json_extract(metadata, '$.docKey') AS docKey,
             id, title, url, captured_at, project_id AS projectId,
             json_extract(metadata, '$.webUrl') AS webUrl,
             json_extract(metadata, '$.serverRelativeUrl') AS serverRelativeUrl,
             json_extract(metadata, '$.siteUrl') AS siteUrl,
             json_extract(metadata, '$.fileType') AS fileType,
             json_extract(metadata, '$.extractionTier') AS tier,
             json_extract(metadata, '$.sizeBytes') AS sizeBytes,
             json_extract(metadata, '$.lastModified') AS lastModified,
             json_extract(metadata, '$.changeSummary') AS changeSummary,
             ROW_NUMBER() OVER (PARTITION BY json_extract(metadata, '$.docKey') ORDER BY captured_at DESC) AS rn,
             COUNT(*) OVER (PARTITION BY json_extract(metadata, '$.docKey')) AS captureCount
      FROM work_items
      WHERE source = 'sharepoint' AND type = 'document_capture'
        AND json_extract(metadata, '$.docKey') IS NOT NULL
        ${filters.length ? `AND ${filters.join(' AND ')}` : ''}
    )
    SELECT * FROM captures WHERE rn = 1
    ORDER BY captured_at DESC
  `).all(...params) as Array<Record<string, unknown> & { docKey: string; captureCount: number; projectId: string | null }>;

  // Comments deleted from the document (deletedFromDoc) are kept as history
  // but never counted — they are not open review load.
  const commentCounts = db.prepare(`
    SELECT json_extract(metadata, '$.docKey') AS docKey,
           COUNT(*) AS total,
           SUM(CASE WHEN json_extract(metadata, '$.resolved') = 'true' THEN 1 ELSE 0 END) AS resolved
    FROM work_items
    WHERE source = 'sharepoint' AND type = 'document_comment'
      AND COALESCE(json_extract(metadata, '$.deletedFromDoc'), '') != 'true'
    GROUP BY 1
  `).all() as Array<{ docKey: string; total: number; resolved: number }>;
  const commentsByKey = new Map(commentCounts.map(c => [c.docKey, c]));

  // LIKE-shaped filtering in JS keeps the SQL window queries simple and lets
  // the query match title OR key OR path in one pass.
  const needle = (opts.query ?? '').trim().toLowerCase();
  const filtered = rows.filter(row => {
    if (!needle) return true;
    return [row.title, row.docKey, row.serverRelativeUrl]
      .some(field => String(field ?? '').toLowerCase().includes(needle));
  });

  const linkCounts = linkCountsByDocKey(db);
  const limited = opts.limit && opts.limit > 0 ? filtered.slice(0, opts.limit) : filtered;
  return limited.map(row => ({
    docKey: row.docKey,
    title: row.title,
    webUrl: row.webUrl,
    serverRelativeUrl: row.serverRelativeUrl,
    siteUrl: row.siteUrl ?? null,
    fileType: row.fileType,
    extractionTier: row.tier,
    sizeBytes: Number(row.sizeBytes ?? 0) || null,
    lastModified: row.lastModified,
    lastCapturedAt: row.captured_at,
    revisionCount: Number(row.captureCount ?? 1),
    latestChangeSummary: row.changeSummary ?? null,
    commentCount: commentsByKey.get(row.docKey)?.total ?? 0,
    resolvedCommentCount: commentsByKey.get(row.docKey)?.resolved ?? 0,
    suggestedChangeCount: getSuggestedChanges(db, row.docKey)?.changes.length ?? 0,
    relatedCount: linkCounts.get(row.docKey) ?? 0,
    projectId: row.projectId ?? null,
  }));
}

export interface DocumentComment {
  itemId: string;
  commentId: string;
  parentCommentId: string | null;
  threadRoot: string;
  author: string;
  direction: string;
  mentionedMe: boolean;
  resolved: boolean;
  /** Comment no longer exists in the live document (kept as history). */
  deletedFromDoc: boolean;
  commentedAt: string;
  text: string;
  url: string | null;
  anchorText: string | null;
}

export interface DocumentView {
  doc: {
    docKey: string;
    title: unknown;
    webUrl: unknown;
    serverRelativeUrl: unknown;
    siteUrl: unknown;
    fileType: unknown;
    extractionTier: unknown;
    sizeBytes: number | null;
    lastModified: unknown;
    truncation: unknown;
    project: { id: string; title: string } | null;
  };
  content: string;
  contentTier: string;
  contentCapturedAt: string;
  /**
   * Unaccepted Word suggestions currently in the document. IMPORTANT
   * honesty note: converters render suggested insertions as if they were
   * final body text, so `content` shows suggestions as already applied —
   * this list is the record of what is actually only proposed, by whom.
   */
  suggestedChanges: TrackedChange[];
  /** Corpus-internal relationships (doc-link-graph): both directions. */
  related: RelatedDocument[];
  comments: DocumentComment[];
  revisions: Array<{
    itemId: string;
    capturedAt: string;
    url: unknown;
    extractionTier: unknown;
    changeSummary: unknown;
    changedSections: unknown[];
  }>;
  pendingEdits: PendingEdit[];
}

/** Full view of one document, or null when the docKey is unknown. */
export function buildDocumentView(
  db: Database.Database,
  contentStore: ContentStore | undefined,
  docKey: string,
): DocumentView | null {
  const captures = db.prepare(`
    SELECT id, title, url, summary, captured_at AS capturedAt, project_id AS projectId, metadata,
           raw_text, content_storage, content_path, content_sha256, content_bytes
    FROM work_items
    WHERE source = 'sharepoint' AND type = 'document_capture'
      AND json_extract(metadata, '$.docKey') = ?
    ORDER BY captured_at DESC
  `).all(docKey) as Array<Record<string, unknown> & { id: string; metadata: string | null; capturedAt: string }>;
  if (captures.length === 0) return null;

  const latest = captures[0];
  let latestMeta: Record<string, unknown> = {};
  try { latestMeta = JSON.parse(String(latest.metadata ?? '{}')); } catch { /* tolerated */ }

  // Content: newest capture whose stored content is non-empty (metadata_only
  // revisions store placeholder text — prefer them only when nothing better
  // exists; the tier field tells the client what it is looking at).
  let content = '';
  let contentTier = String(latestMeta.extractionTier ?? '');
  let contentCapturedAt = String(latest.capturedAt ?? '');
  if (contentStore) {
    for (const capture of captures) {
      let meta: Record<string, unknown> = {};
      try { meta = JSON.parse(String(capture.metadata ?? '{}')); } catch { continue; }
      try {
        const ref = contentStore.refFromRow(capture as never);
        const text = ref ? contentStore.get(ref) : '';
        if (text.trim() !== '') {
          content = text;
          contentTier = String(meta.extractionTier ?? '');
          contentCapturedAt = String(capture.capturedAt ?? '');
          break;
        }
      } catch { /* integrity failure on one revision — try the next */ }
    }
  }

  const commentRows = db.prepare(`
    SELECT id, url, captured_at AS capturedAt, metadata,
           COALESCE(raw_text, summary, '') AS text
    FROM work_items
    WHERE source = 'sharepoint' AND type = 'document_comment'
      AND json_extract(metadata, '$.docKey') = ?
    ORDER BY captured_at ASC
  `).all(docKey) as Array<{ id: string; url: string | null; capturedAt: string; metadata: string | null; text: string }>;
  const comments = commentRows.flatMap(row => {
    let meta: Record<string, unknown> = {};
    try { meta = JSON.parse(row.metadata ?? '{}'); } catch { return []; }
    return [{
      itemId: row.id,
      commentId: String(meta.commentId ?? row.id),
      parentCommentId: meta.parentCommentId !== undefined ? String(meta.parentCommentId) : null,
      threadRoot: String(meta.threadRoot ?? meta.commentId ?? row.id),
      author: String(meta.author ?? 'unknown'),
      direction: String(meta.direction ?? 'received'),
      mentionedMe: meta.mentionedMe === 'true',
      resolved: meta.resolved === 'true',
      deletedFromDoc: meta.deletedFromDoc === 'true',
      commentedAt: String(meta.commentedAt ?? row.capturedAt),
      text: row.text,
      url: row.url,
      anchorText: typeof meta.anchorText === 'string' && meta.anchorText ? meta.anchorText : null,
    }];
  });

  const revisions = captures.map(capture => {
    let meta: Record<string, unknown> = {};
    try { meta = JSON.parse(String(capture.metadata ?? '{}')); } catch { /* tolerated */ }
    return {
      itemId: capture.id,
      capturedAt: capture.capturedAt,
      url: capture.url,
      extractionTier: meta.extractionTier ?? null,
      changeSummary: meta.changeSummary ?? capture.summary ?? null,
      changedSections: (() => { try { return JSON.parse(String(meta.changedSections ?? '[]')) as unknown[]; } catch { return []; } })(),
    };
  });

  const projectId = String(latest.projectId ?? '') || null;
  const project = projectId
    ? (db.prepare('SELECT id, title FROM projects WHERE id = ?').get(projectId) as { id: string; title: string } | undefined) ?? null
    : null;

  const suggestions = getSuggestedChanges(db, docKey);

  return {
    doc: {
      docKey,
      title: latest.title,
      webUrl: latestMeta.webUrl ?? null,
      serverRelativeUrl: latestMeta.serverRelativeUrl ?? null,
      siteUrl: latestMeta.siteUrl ?? null,
      fileType: latestMeta.fileType ?? null,
      extractionTier: latestMeta.extractionTier ?? null,
      sizeBytes: Number(latestMeta.sizeBytes ?? 0) || null,
      lastModified: latestMeta.lastModified ?? null,
      truncation: (() => { try { return JSON.parse(String(latestMeta.truncation ?? 'null')); } catch { return null; } })(),
      project,
    },
    content,
    contentTier,
    contentCapturedAt,
    suggestedChanges: suggestions?.changes ?? [],
    related: getRelatedDocuments(db, docKey),
    comments,
    revisions,
    pendingEdits: listPendingEdits(db, docKey),
  };
}
