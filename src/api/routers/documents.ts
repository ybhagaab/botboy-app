/**
 * Document workbench API (spec `.kiro/specs/document-workbench/`):
 *
 *   GET  /projects/:id/documents  — one row per SharePoint document routed to
 *                                   the project (grouped by docKey), with
 *                                   revision/comment/awaiting counts.
 *   GET  /documents/view          — reader payload for one docKey: header
 *                                   facts, extracted content (content store),
 *                                   threaded comments, revisions timeline,
 *                                   pending edits (empty until W3 lands).
 *   POST /documents/refresh       — on-demand live re-fetch (engine enqueue at
 *                                   live priority + immediate drain).
 *
 * Hard boundary (verified 2026-08-25): none of this touches the
 * product-manager writing workspace (/product-documents, its table, or the
 * #/documents route) — different store, different lifecycle.
 */

import { Router, type Request, type Response } from 'express';
import type { RouterDeps } from './deps.js';
import {
  createPendingEdit,
  listPendingEdits,
  listStagedCreations,
  decidePendingEdit,
  markEditSynced,
  markEditConflicted,
} from '../../core/pending-edits.js';
import {
  applyDocxBodyEdits,
  buildDocxFromMarkdown,
  mapSharePointWriteTarget,
  readZipEntry,
  DOCUMENT_XML_ENTRY,
} from '../../core/docx-body-editor.js';
import { listDocumentCorpus, buildDocumentView } from '../../core/document-corpus.js';
import { decomposeEditedMarkdown } from '../../core/edit-decompose.js';
import { markdownBlocksOf, markdownLineToDocxText, blockToAnchorParagraphs } from '../../core/markdown-anchor.js';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createHash } from 'crypto';

export function createDocumentsRouter(deps: RouterDeps): Router {
  const router = Router();

  router.get('/projects/:id/documents', (req: Request, res: Response) => {
    const db = deps.db;
    if (!db) return res.status(503).json({ error: 'database unavailable' });
    const projectId = String(req.params.id ?? '').trim();
    if (!projectId) return res.status(400).json({ error: 'project id required' });
    // Latest capture per docKey (newest captured_at wins), counts aggregated
    // across ALL rows of the docKey — shared implementation with the chat
    // tools (document-corpus.ts) so UI and model agree about the corpus.
    // Staged creations (authoring bridge): documents that will exist once
    // approved+synced — they have no corpus row yet, so they ride alongside.
    const stagedCreations = listStagedCreations(db, projectId).map(creation => ({
      id: creation.id,
      docKey: creation.docKey,
      serverRelativeUrl: creation.serverRelativeUrl,
      fileName: creation.serverRelativeUrl.split('/').pop() ?? '',
      status: creation.status,
      conflictReason: creation.conflictReason,
      originNote: creation.originNote,
      createContent: creation.createContent ?? '',
      createdAt: creation.createdAt,
    }));
    res.json({ documents: listDocumentCorpus(db, { projectId }), stagedCreations });
  });

  // Corpus-wide listing (chat tools + future cross-project views).
  router.get('/documents', (req: Request, res: Response) => {
    const db = deps.db;
    if (!db) return res.status(503).json({ error: 'database unavailable' });
    const query = String(req.query.q ?? '').trim() || undefined;
    const limit = Number(req.query.limit) > 0 ? Number(req.query.limit) : undefined;
    res.json({ documents: listDocumentCorpus(db, { query, limit }) });
  });

  router.get('/documents/view', (req: Request, res: Response) => {
    const db = deps.db;
    if (!db) return res.status(503).json({ error: 'database unavailable' });
    const docKey = String(req.query.docKey ?? '').trim();
    if (!docKey) return res.status(400).json({ error: 'docKey required' });

    // Shared with the chat read_document tool (document-corpus.ts).
    const view = buildDocumentView(db, deps.contentStore, docKey);
    if (!view) return res.status(404).json({ error: 'unknown document' });

    res.json({
      ...view,
      // Edit-mode optimistic-concurrency token (E2): sha of the content the
      // reader shows; edit-save echoes it and 409s when the base moved.
      contentSha256: createHash('sha256').update(String(view.content ?? ''), 'utf8').digest('hex'),
      // Lock-retry state (declared below; closures evaluate at request time).
      syncRetry: (() => {
        const entry = lockRetries.get(docKey);
        return entry ? { retrying: true, attempts: entry.attempts, startedAt: entry.startedAt } : null;
      })(),
    });
  });

  // ── Sheet-scoped xlsx deep reads (xlsx-deep-reads X1) ──────────────────
  // On-demand reads of the CURRENT file; capture tiers untouched. Cache is
  // a plain JSON file keyed (docKey, sheet, lastModified) — the key
  // self-invalidates on new versions; corruption falls through to a fresh
  // download. (Spec imagined content-store aux refs; plain files carry the
  // same integrity story with less plumbing — recorded deviation.)
  const SHEET_DOWNLOAD_MAX_BYTES = 160 * 1024 * 1024;
  const sheetCacheDir = path.join(os.homedir(), '.personal-productivity-tracker', 'cache', 'sheets');
  // maxRows is part of the key — a budget-limited read must never serve a
  // later full-budget request (live find 2026-08-26).
  const sheetCachePath = (docKey: string, sheet: string, lastModified: string, maxRows: number | undefined): string => {
    const key = createHash('sha1').update(`${docKey}\u0000${sheet}\u0000${lastModified}\u0000${maxRows ?? 'default'}`).digest('hex').slice(0, 24);
    return path.join(sheetCacheDir, `${key}.json`);
  };

  router.get('/documents/sheet', async (req: Request, res: Response) => {
    const db = deps.db;
    if (!db) return res.status(503).json({ error: 'database unavailable' });
    if (!deps.mcpManager) return res.status(503).json({ error: 'managed MCP runtime unavailable' });
    if (!deps.documentParser?.parseXlsxSheet) return res.status(503).json({ error: 'sheet parser unavailable' });
    const docKey = String(req.query.docKey ?? '').trim();
    if (!docKey) return res.status(400).json({ error: 'docKey required' });
    const sheet = String(req.query.sheet ?? '').trim();
    const maxRows = Number(req.query.maxRows) > 0 ? Number(req.query.maxRows) : undefined;
    const refresh = String(req.query.refresh ?? '') === 'true';

    const capture = db.prepare(`
      SELECT metadata FROM work_items
      WHERE source = 'sharepoint' AND type = 'document_capture'
        AND json_extract(metadata, '$.docKey') = ?
      ORDER BY captured_at DESC LIMIT 1
    `).get(docKey) as { metadata: string | null } | undefined;
    if (!capture) return res.status(404).json({ error: 'unknown document — it must be in the corpus (list_documents)' });
    let meta: Record<string, unknown> = {};
    try { meta = JSON.parse(capture.metadata ?? '{}'); } catch { return res.status(500).json({ error: 'unreadable document metadata' }); }
    if (String(meta.fileType ?? '').toLowerCase() !== '.xlsx') {
      return res.status(400).json({ error: `sheet reads cover .xlsx documents (this is ${meta.fileType ?? 'unknown'})` });
    }
    const serverRelativeUrl = String(meta.serverRelativeUrl ?? '');
    if (!serverRelativeUrl) return res.status(500).json({ error: 'document metadata lacks a fetch path' });
    const sizeBytes = Number(meta.sizeBytes ?? 0) || 0;
    if (sizeBytes > SHEET_DOWNLOAD_MAX_BYTES) {
      return res.status(413).json({ error: `workbook is ${Math.round(sizeBytes / 1024 / 1024)} MB — beyond the deep-read gate (${Math.round(SHEET_DOWNLOAD_MAX_BYTES / 1024 / 1024)} MB); open it in SharePoint` });
    }
    const lastModified = String(meta.lastModified ?? 'unknown');

    // Cache probe.
    const cacheFile = sheetCachePath(docKey, sheet || '__inventory', lastModified, maxRows);
    if (!refresh) {
      try {
        const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
        return res.json({ ...cached, fromCache: true });
      } catch { /* miss or corrupt — fresh read */ }
    }

    const scratch = path.join(os.homedir(), '.personal-productivity-tracker', 'tmp', `sheet-read-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.xlsx`);
    try {
      fs.mkdirSync(path.dirname(scratch), { recursive: true });
      const download = await deps.mcpManager.callTool('sharepoint', 'sharepoint_read_file', {
        serverRelativeUrl,
        ...(typeof meta.siteUrl === 'string' && meta.siteUrl ? { siteUrl: meta.siteUrl } : {}),
        savePath: scratch,
      }, { timeoutMs: 10 * 60_000 });
      if (download.isError) return res.status(502).json({ error: `download failed: ${String(download.text).slice(0, 300)}` });
      const parsed = await deps.documentParser.parseXlsxSheet(scratch, { ...(sheet ? { sheet } : {}), ...(maxRows ? { maxRows } : {}) });
      const payload = {
        docKey,
        sheets: parsed.sheets.map(s => s.name),
        ...(parsed.sheet ? { sheet: parsed.sheet } : {}),
        asOf: new Date().toISOString(),
        lastModified,
      };
      try {
        fs.mkdirSync(sheetCacheDir, { recursive: true });
        fs.writeFileSync(cacheFile, JSON.stringify(payload));
      } catch { /* cache is best-effort */ }
      res.json({ ...payload, fromCache: false });
    } catch (error) {
      const message = (error as Error).message;
      // Unknown-sheet errors carry the inventory — a 400, not a 502.
      res.status(/no sheet named/.test(message) ? 400 : 502).json({ error: message });
    } finally {
      try { fs.unlinkSync(scratch); } catch { /* best effort */ }
    }
  });

  // ── Pending-edits approval lane (workbench R3) ─────────────────────────

  router.get('/documents/pending-edits', (req: Request, res: Response) => {
    if (!deps.db) return res.status(503).json({ error: 'database unavailable' });
    const docKey = String(req.query.docKey ?? '').trim();
    if (!docKey) return res.status(400).json({ error: 'docKey required' });
    res.json({ edits: listPendingEdits(deps.db, docKey) });
  });

  router.post('/documents/pending-edits', (req: Request, res: Response) => {
    if (!deps.db) return res.status(503).json({ error: 'database unavailable' });
    const body = req.body && typeof req.body === 'object' ? req.body as Record<string, unknown> : {};
    try {
      const db = deps.db;
      // Reader-originated staging. kind 'botboy' is allowed ONLY for the
      // selection-assist approve (E3) — the owner reviewed the proposal
      // inline, so preApproved rides the existing status machine
      // (create + decide in one transaction; approvedAt stamped normally).
      const kind = body.kind === 'botboy' ? 'botboy' as const : 'manual' as const;
      const preApproved = body.preApproved === true;
      const stage = () => {
        const edit = createPendingEdit(db, {
          docKey: String(body.docKey ?? ''),
          serverRelativeUrl: String(body.serverRelativeUrl ?? ''),
          siteUrl: typeof body.siteUrl === 'string' ? body.siteUrl : undefined,
          kind,
          operation: String(body.operation ?? '') as 'replaceText' | 'appendParagraphs' | 'createDocument' | 'replaceParagraphRange',
          findText: typeof body.findText === 'string' ? body.findText : undefined,
          replaceWith: typeof body.replaceWith === 'string' ? body.replaceWith : undefined,
          paragraphs: Array.isArray(body.paragraphs) ? body.paragraphs.map(p => String(p)) : undefined,
          createContent: typeof body.createContent === 'string' ? body.createContent : undefined,
          projectId: typeof body.projectId === 'string' ? body.projectId : undefined,
          originNote: typeof body.originNote === 'string' ? body.originNote : 'edited in the reader',
        });
        return preApproved ? decidePendingEdit(db, edit.id, 'approved') : edit;
      };
      const edit = preApproved ? db.transaction(stage)() : stage();
      res.json({ edit });
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
    }
  });

  /**
   * Edit-mode save (doc editor E2): decompose the owner's full-document
   * draft against the current synced extraction and stage every change run
   * PRE-APPROVED in one transaction (D1/option B — the owner typed these;
   * the lane shows the decomposition, each row rejectable until sync).
   * `baseSha` is optimistic concurrency: the draft must have been opened
   * from the content the server still has, or the save 409s with the draft
   * preserved client-side.
   */
  router.post('/documents/edit-save', (req: Request, res: Response) => {
    const db = deps.db;
    if (!db) return res.status(503).json({ error: 'database unavailable' });
    const body = req.body && typeof req.body === 'object' ? req.body as Record<string, unknown> : {};
    const docKey = String(body.docKey ?? '').trim();
    const draft = typeof body.draft === 'string' ? body.draft : null;
    const baseSha = String(body.baseSha ?? '').trim();
    if (!docKey || draft === null || !baseSha) return res.status(400).json({ error: 'docKey, draft, and baseSha are required' });

    const view = buildDocumentView(db, deps.contentStore, docKey);
    if (!view) return res.status(404).json({ error: 'unknown document' });
    if (String(view.doc.fileType ?? '').toLowerCase() !== '.docx') return res.status(400).json({ error: 'edit mode covers .docx documents' });
    if (view.contentTier !== 'full') return res.status(409).json({ error: 'this document is not fully extracted — Refresh first; truncated content cannot be edited safely' });
    if (!view.doc.serverRelativeUrl) return res.status(409).json({ error: 'the synced capture carries no SharePoint address — Refresh and retry' });
    const openEdits = (view.pendingEdits ?? []).filter(edit => edit.status === 'pending' || edit.status === 'approved');
    if (openEdits.length > 0) return res.status(409).json({ error: 'staged edits already exist for this document — approve & sync or reject them before editing' });
    const currentSha = createHash('sha256').update(String(view.content ?? ''), 'utf8').digest('hex');
    if (currentSha !== baseSha) return res.status(409).json({ error: 'the document changed while you were editing — copy your draft, refresh, and re-apply' });

    const { edits, unsupported } = decomposeEditedMarkdown(String(view.content ?? ''), draft);
    if (edits.length === 0) {
      return res.json({ staged: [], unsupported, message: unsupported.length ? 'no stageable changes' : 'no changes' });
    }
    try {
      const staged = db.transaction(() => edits.map(edit => {
        const created = createPendingEdit(db, {
          docKey,
          serverRelativeUrl: String(view.doc.serverRelativeUrl),
          siteUrl: view.doc.siteUrl ? String(view.doc.siteUrl) : undefined,
          kind: 'manual',
          operation: edit.operation,
          findText: edit.findText,
          replaceWith: edit.replaceWith,
          paragraphs: edit.paragraphs,
          originNote: 'edit mode save',
        });
        return decidePendingEdit(db, created.id, 'approved');
      }))();
      res.json({ staged, unsupported });
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
    }
  });

  router.post('/documents/pending-edits/:id/:decision', (req: Request, res: Response) => {
    if (!deps.db) return res.status(503).json({ error: 'database unavailable' });
    const decision = String(req.params.decision ?? '');
    if (decision !== 'approve' && decision !== 'reject') return res.status(404).json({ error: 'unknown action' });
    try {
      const edit = decidePendingEdit(deps.db, String(req.params.id ?? ''), decision === 'approve' ? 'approved' : 'rejected');
      res.json({ edit });
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
    }
  });

  /**
   * Selection → Ask BotBoy (doc editor E3). Derives the edit shape from the
   * CURRENT synced content at ASSIST time (second-pass rule: the approve
   * echoes this shape verbatim — block indexes never cross a content
   * boundary), runs the full-toolset agent loop, and returns ONLY the
   * proposal + shape. Nothing persists until the owner approves inline.
   *
   * The client renders the STAGED PREVIEW, so it sends the selected blocks'
   * TEXTS (not indexes): we locate them in the synced base by squashed
   * equality — exactly once → proceed; otherwise the selection sits on
   * staged-only or ambiguous text → honest 409.
   */
  router.post('/documents/assist-edit', async (req: Request, res: Response) => {
    const db = deps.db;
    if (!db) return res.status(503).json({ error: 'database unavailable' });
    if (!deps.agent) return res.status(503).json({ error: 'agent unavailable' });
    const body = req.body && typeof req.body === 'object' ? req.body as Record<string, unknown> : {};
    const docKey = String(body.docKey ?? '').trim();
    const selectedText = String(body.selectedText ?? '').trim();
    const instruction = String(body.instruction ?? '').trim();
    const blockTexts = Array.isArray(body.blockTexts) ? body.blockTexts.map(x => String(x)) : [];
    if (!docKey || !selectedText || !instruction || blockTexts.length === 0) {
      return res.status(400).json({ error: 'docKey, selectedText, blockTexts, and instruction are required' });
    }

    const view = buildDocumentView(db, deps.contentStore, docKey);
    if (!view) return res.status(404).json({ error: 'unknown document' });
    if (String(view.doc.fileType ?? '').toLowerCase() !== '.docx') return res.status(400).json({ error: 'BotBoy selection edits cover .docx documents' });
    if (!view.doc.serverRelativeUrl) return res.status(409).json({ error: 'the synced capture carries no SharePoint address — Refresh and retry' });
    const content = String(view.content ?? '');
    if (!content.trim()) return res.status(409).json({ error: 'no synced content to edit — Refresh first' });

    const squashText = (value: string) => value.replace(/\s+/g, ' ').trim();
    const blocks = markdownBlocksOf(content);
    const wanted = blockTexts.map(squashText);
    const hits: number[] = [];
    for (let i = 0; i + wanted.length <= blocks.length; i++) {
      if (wanted.every((text, k) => squashText(blocks[i + k].text) === text)) hits.push(i);
    }
    if (hits.length === 0) return res.status(409).json({ error: 'this passage has staged changes not yet on SharePoint — sync or reject them first, then ask BotBoy' });
    if (hits.length > 1) return res.status(409).json({ error: 'this passage appears more than once — select a longer stretch to make it unique' });
    const blockStart = hits[0];
    const blockEnd = blockStart + wanted.length - 1;
    const selected = blocks.slice(blockStart, blockEnd + 1);
    if (selected.some(block => block.kind === 'table')) {
      return res.status(400).json({ error: "tables can't be edited yet — select text outside tables" });
    }

    // Shape derivation (pre-LLM): sub-line replaceText when the selection is
    // a proper fragment of ONE single-line plain block, else paragraph range.
    const anchorLists = selected.map(blockToAnchorParagraphs);
    if (anchorLists.some(list => list === null || list.length === 0)) {
      return res.status(400).json({ error: 'this selection could not be anchored — select whole paragraphs' });
    }
    const anchors = anchorLists.flatMap(list => list ?? []);
    const squashedSelection = squashText(selectedText);
    let subLine: { findText: string; prefix: string; suffix: string } | null = null;
    if (selected.length === 1 && selected[0].kind === 'plain' && selected[0].lines.length === 1) {
      const blockDocxText = markdownLineToDocxText(selected[0].lines[0]);
      const at = blockDocxText.indexOf(squashedSelection);
      const unique = at !== -1 && blockDocxText.indexOf(squashedSelection, at + 1) === -1;
      if (unique && squashedSelection.length < blockDocxText.length && blockDocxText.length >= 20) {
        subLine = { findText: blockDocxText, prefix: blockDocxText.slice(0, at), suffix: blockDocxText.slice(at + squashedSelection.length) };
      }
    }

    // Overlap guard: an open staged edit already targets these paragraphs.
    const openEdits = (view.pendingEdits ?? []).filter(edit => edit.status === 'pending' || edit.status === 'approved');
    const overlaps = openEdits.some(edit => {
      if (edit.operation === 'replaceText' && edit.findText) {
        return anchors.some(anchor => anchor.includes(squashText(edit.findText!)));
      }
      if (edit.operation === 'replaceParagraphRange' && Array.isArray(edit.paragraphs)) {
        const staged = new Set(edit.paragraphs.map(squashText));
        return anchors.some(anchor => staged.has(anchor));
      }
      return false;
    });
    if (overlaps) return res.status(409).json({ error: 'this passage already has a staged edit — approve & sync or reject it first' });

    // Context: ±20 lines around the selection in the extracted markdown.
    const contentLines = content.split('\n');
    const probeLine = contentLines.findIndex(line => squashText(line).includes(squashText(selected[0].lines[0] ?? selected[0].text.slice(0, 80))));
    const ctxStart = Math.max(0, (probeLine === -1 ? 0 : probeLine) - 20);
    const context = contentLines.slice(ctxStart, ctxStart + 40 + selected.reduce((n, block) => n + block.lines.length, 0)).join('\n');

    const projectBit = view.doc.project ? `It belongs to project "${view.doc.project.title}" (id ${view.doc.project.id}) — use that project's brain and evidence for context.` : '';
    const task = [
      "You are editing one passage of a synced SharePoint document at the owner's request.",
      `Document: "${view.doc.title}" (docKey ${docKey}, .docx). ${projectBit}`,
      'The passage to edit (verbatim, from the extracted document text):',
      '<<<SELECTION', selectedText, 'SELECTION>>>',
      'Surrounding document context:',
      '<<<CONTEXT', context, 'CONTEXT>>>',
      `Owner's instruction: ${instruction}`,
      'Rules:',
      '- Use your tools when the instruction needs facts you do not have (read_document for the full doc, get_project_brain, search_items, MCP reads). Do NOT call any write or staging tool — the reader stages your text after the owner approves it.',
      '- Your FINAL message must be ONLY the replacement text for the passage, as plain markdown. No preamble, no explanation, no code fences. It replaces the passage verbatim.',
      "- Match the document's tone and heading/list conventions.",
      '- If the instruction implies removing the passage entirely, reply with exactly: [DELETE]',
    ].join('\n');

    const startedAt = Date.now();
    let out: string;
    try {
      out = await deps.agent.executeAction(task);
    } catch (error) {
      return res.status(502).json({ error: `BotBoy could not complete the edit: ${(error as Error).message}` });
    }
    console.log(`[Documents] assist-edit ${docKey} ${Date.now() - startedAt}ms`);
    let proposal = String(out ?? '').trim();
    const fenced = /^```[a-zA-Z]*\n([\s\S]*?)\n?```$/.exec(proposal);
    if (fenced) proposal = fenced[1].trim();
    if (!proposal || proposal.startsWith('Error:')) {
      return res.status(502).json({ error: proposal || 'BotBoy returned an empty proposal — try rephrasing the instruction' });
    }

    const isDelete = proposal === '[DELETE]';
    let editShape: Record<string, unknown>;
    if (subLine) {
      const spliced = squashText(`${subLine.prefix}${isDelete ? '' : markdownLineToDocxText(proposal)}${subLine.suffix}`);
      editShape = spliced
        ? { operation: 'replaceText', findText: subLine.findText, replaceWith: spliced }
        : { operation: 'replaceParagraphRange', paragraphs: anchors, replaceWith: '' };
    } else {
      editShape = { operation: 'replaceParagraphRange', paragraphs: anchors, replaceWith: isDelete ? '' : proposal };
    }
    res.json({ replacementMarkdown: isDelete ? '' : proposal, editShape });
  });

  /**
   * Document-level sync core: applies ALL approved edits in ONE download →
   * transform → upload pass (recorded decision: SharePoint has no
   * section-update API). Each edit is re-verified against the fresh
   * download; conflicts isolate per edit. guidedFlow is set server-side —
   * the owner's Approve clicks are the approval this write path requires.
   */
  async function runDocumentSync(docKey: string): Promise<
    | { status: 'done'; uploaded: boolean; verifiedOnReadBack: boolean; results: Array<{ id: string; applied: boolean; reason?: string }> }
    | { status: 'locked' }
    | { status: 'nothing-approved' }
    | { status: 'failed'; error: string }
  > {
    if (!deps.db || !deps.mcpManager) return { status: 'failed', error: 'runtime unavailable' };
    const approved = listPendingEdits(deps.db, docKey).filter(edit => edit.status === 'approved');
    if (approved.length === 0) return { status: 'nothing-approved' };

    // Creations never mix with edits on one docKey (staging enforces
    // corpus-absence), so the first approved createDocument routes the
    // whole sync to the publish path.
    const creation = approved.find(edit => edit.operation === 'createDocument');
    if (creation) return runDocumentCreate(creation);
    const target = { serverRelativeUrl: approved[0].serverRelativeUrl, siteUrl: approved[0].siteUrl };

    const bodyEdits = approved.filter(edit => edit.operation !== 'createDocument');
    const result = await applyDocxBodyEdits(deps.mcpManager, target, bodyEdits.map(edit => ({
      id: edit.id,
      operation: edit.operation as 'replaceText' | 'appendParagraphs' | 'replaceParagraphRange',
      findText: edit.findText,
      replaceWith: edit.replaceWith,
      paragraphs: edit.paragraphs,
    })));

    if (result.error && !result.uploaded) {
      if (/file is locked/i.test(result.error)) return { status: 'locked' };
      return { status: 'failed', error: result.error };
    }
    for (const entry of result.perEdit) {
      if (entry.applied && result.uploaded) markEditSynced(deps.db, entry.id);
      else if (!entry.applied) markEditConflicted(deps.db, entry.id, entry.reason ?? 'could not apply');
    }
    // Refresh the stored copy so the reader shows what was just written
    // (a fresh #rev= revision with its diff). AWAITED (soak find).
    try {
      if (deps.sharePointSync?.refreshDocument(docKey).queued) await deps.sharePointSync.drainNow();
    } catch { /* best-effort; the next discovery heals */ }
    return { status: 'done', uploaded: result.uploaded, verifiedOnReadBack: result.verifiedOnReadBack, results: result.perEdit };
  }

  /**
   * Publish an approved CREATION (authoring bridge A1/A2): existence check
   * FIRST (live), then .md content write or .docx build+upload, read-back
   * probes, mark synced, and enqueue corpus ingestion. guidedFlow is set
   * server-side — the owner's Approve click is the approval.
   */
  async function runDocumentCreate(creation: import('../../core/pending-edits.js').PendingEdit): Promise<
    | { status: 'done'; uploaded: boolean; verifiedOnReadBack: boolean; results: Array<{ id: string; applied: boolean; reason?: string }> }
    | { status: 'locked' }
    | { status: 'failed'; error: string }
  > {
    const db = deps.db!;
    const mcpManager = deps.mcpManager!;
    const mapped = mapSharePointWriteTarget(creation.serverRelativeUrl, creation.siteUrl ?? undefined);
    if (typeof mapped === 'string') {
      markEditConflicted(db, creation.id, mapped);
      return { status: 'done', uploaded: false, verifiedOnReadBack: false, results: [{ id: creation.id, applied: false, reason: mapped }] };
    }
    const content = String(creation.createContent ?? '');
    // The MCP's savePath allowlist covers the HOME dir but not os.tmpdir()
    // (live find 2026-08-26: /var/folders/... rejected) — staging files live
    // under our own dot-dir.
    const scratchDir = path.join(os.homedir(), '.personal-productivity-tracker', 'tmp');
    fs.mkdirSync(scratchDir, { recursive: true });

    // 1. The world may have changed since approval: a file now AT the target
    //    means someone created it — conflict, never overwrite.
    const probePath = path.join(scratchDir, `create-probe-${creation.id}.docx`);
    const probeRead = await mcpManager.callTool('sharepoint', 'sharepoint_read_file', {
      serverRelativeUrl: creation.serverRelativeUrl,
      ...(creation.siteUrl ? { siteUrl: creation.siteUrl } : {}),
      inline: creation.serverRelativeUrl.toLowerCase().endsWith('.md'),
      ...(creation.serverRelativeUrl.toLowerCase().endsWith('.docx') ? { savePath: probePath } : {}),
    }, { timeoutMs: 60_000 }).catch((error: Error) => ({ text: `Error: ${error.message}`, isError: true }));
    try { fs.unlinkSync(probePath); } catch { /* absent = fine */ }
    if (!probeRead.isError) {
      const reason = 'target already exists on SharePoint — edit the existing document instead';
      markEditConflicted(db, creation.id, reason);
      return { status: 'done', uploaded: false, verifiedOnReadBack: false, results: [{ id: creation.id, applied: false, reason }] };
    }
    if (!/not.?found|does not exist|404|no file|could not find/i.test(String(probeRead.text))) {
      // An auth/transport failure must never be mistaken for "missing" and
      // trigger a blind write (same rule as the guided update tool).
      return { status: 'failed', error: `could not verify the target is free: ${String(probeRead.text).slice(0, 300)}` };
    }

    // 2. Build bytes and upload under the guided waiver.
    const isDocx = creation.serverRelativeUrl.toLowerCase().endsWith('.docx');
    let tempDir: string | null = null;
    try {
      const writeArgs: Record<string, unknown> = {
        libraryName: 'Documents',
        fileName: mapped.fileName,
        ...(mapped.folderPath ? { folderPath: mapped.folderPath } : {}),
        ...(mapped.personal ? {} : { personal: false }),
        ...mapped.siteUrl,
      };
      if (isDocx) {
        const built = await buildDocxFromMarkdown(content);
        tempDir = built.tempDir;
        // Upload from the home scratch dir (same allowlist rule as savePath).
        const uploadPath = path.join(scratchDir, `create-upload-${creation.id}.docx`);
        fs.copyFileSync(built.filePath, uploadPath);
        writeArgs.sourcePath = uploadPath;
      } else {
        writeArgs.content = content;
      }
      const upload = await mcpManager.callTool('sharepoint', 'sharepoint_write_file', writeArgs, {
        guidedFlow: true, ownerApproved: true, timeoutMs: 120_000,
      });
      if (upload.isError) {
        if (/file is locked/i.test(String(upload.text))) return { status: 'locked' };
        return { status: 'failed', error: String(upload.text).slice(0, 400) };
      }

      // 3. Read-back probes: the document as SharePoint now serves it must
      //    contain the authored passages.
      const probes = content.split('\n')
        .map(line => line.replace(/^#{1,3}\s+/, '').replace(/^[-*]\s+/, '').replace(/^\d+[.)]\s+/, '').replace(/\*\*?/g, '').trim())
        .filter(line => line.length >= 12)
        .slice(0, 3);
      let verified = false;
      if (isDocx) {
        const readBackPath = path.join(scratchDir, `create-verify-${creation.id}.docx`);
        try {
          const back = await mcpManager.callTool('sharepoint', 'sharepoint_read_file', {
            serverRelativeUrl: creation.serverRelativeUrl,
            ...(creation.siteUrl ? { siteUrl: creation.siteUrl } : {}),
            savePath: readBackPath,
          }, { timeoutMs: 120_000 });
          if (!back.isError) {
            const xml = await readZipEntry(readBackPath, DOCUMENT_XML_ENTRY);
            const text = xml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
            verified = probes.length > 0 && probes.every(probe => text.includes(probe));
          }
        } finally {
          try { fs.unlinkSync(readBackPath); } catch { /* best effort */ }
        }
      } else {
        const back = await mcpManager.callTool('sharepoint', 'sharepoint_read_file', {
          serverRelativeUrl: creation.serverRelativeUrl,
          ...(creation.siteUrl ? { siteUrl: creation.siteUrl } : {}),
          inline: true,
        }, { timeoutMs: 60_000 });
        verified = !back.isError && probes.length > 0 && probes.every(probe => String(back.text).includes(probe));
      }

      markEditSynced(db, creation.id);
      // 4. Corpus ingestion: the document BotBoy just created becomes a
      //    synced document like any other (reader link live after drain).
      try {
        const enqueue = deps.sharePointSync?.enqueueByPath(creation.serverRelativeUrl, {
          siteUrl: creation.siteUrl ?? undefined,
        });
        if (enqueue?.queued) void deps.sharePointSync?.drainNow();
        console.log(`[Documents] created ${creation.serverRelativeUrl} (verified=${verified}); ingestion ${enqueue?.queued ? 'queued' : `skipped: ${enqueue?.reason ?? 'sync unavailable'}`}`);
      } catch { /* ingestion is best-effort; discovery heals */ }
      return { status: 'done', uploaded: true, verifiedOnReadBack: verified, results: [{ id: creation.id, applied: true }] };
    } finally {
      if (tempDir) { try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* best effort */ } }
      try { fs.unlinkSync(path.join(scratchDir, `create-upload-${creation.id}.docx`)); } catch { /* absent = fine */ }
    }
  }

  // ── Lock retry (soak find #2, 2026-08-25) ────────────────────────────────
  // SharePoint refuses whole-file uploads while ANYONE has an editing
  // session on the doc (Word or browser co-authoring) and holds the lock up
  // to ~10 min after the last close. Docs under active team review are
  // therefore locked for hours — bouncing the owner is useless. A locked
  // sync self-retries in the background and lands the moment the document
  // goes quiet. In-memory (a restart drops the timer; edits stay approved
  // and the owner can re-press Sync).
  // Env override exists for tests (real chain, millisecond interval).
  const LOCK_RETRY_INTERVAL_MS = (() => {
    const override = parseInt(process.env.PPT_LOCK_RETRY_INTERVAL_MS || '', 10);
    return Number.isFinite(override) && override > 0 ? override : 4 * 60_000;
  })();
  const LOCK_RETRY_MAX_ATTEMPTS = 30; // ~2 hours of coverage
  const lockRetries = new Map<string, { attempts: number; startedAt: string; timer: NodeJS.Timeout }>();

  function scheduleLockRetry(docKey: string, attempts: number): void {
    const existing = lockRetries.get(docKey);
    if (existing) clearTimeout(existing.timer);
    const timer = setTimeout(() => { void retryTick(docKey); }, LOCK_RETRY_INTERVAL_MS);
    timer.unref?.();
    lockRetries.set(docKey, { attempts, startedAt: existing?.startedAt ?? new Date().toISOString(), timer });
  }

  async function retryTick(docKey: string): Promise<void> {
    const entry = lockRetries.get(docKey);
    if (!entry) return;
    try {
      const outcome = await runDocumentSync(docKey);
      if (outcome.status === 'locked' && entry.attempts + 1 < LOCK_RETRY_MAX_ATTEMPTS) {
        scheduleLockRetry(docKey, entry.attempts + 1);
        return;
      }
      lockRetries.delete(docKey);
      if (outcome.status === 'done') {
        console.log(`[Documents] lock-retry sync landed for ${docKey} after ${entry.attempts + 1} attempt(s)`);
      } else if (outcome.status === 'locked') {
        console.warn(`[Documents] lock-retry gave up for ${docKey} after ${LOCK_RETRY_MAX_ATTEMPTS} attempts — edits stay approved`);
      }
    } catch (error) {
      lockRetries.delete(docKey);
      console.warn(`[Documents] lock-retry failed for ${docKey}: ${(error as Error).message}`);
    }
  }

  router.post('/documents/sync', async (req: Request, res: Response) => {
    if (!deps.db) return res.status(503).json({ error: 'database unavailable' });
    if (!deps.mcpManager) return res.status(503).json({ error: 'managed MCP runtime unavailable' });
    const body = req.body && typeof req.body === 'object' ? req.body as Record<string, unknown> : {};
    const docKey = String(body.docKey ?? '').trim();
    if (!docKey) return res.status(400).json({ error: 'docKey required' });

    const outcome = await runDocumentSync(docKey);
    if (outcome.status === 'nothing-approved') return res.status(400).json({ error: 'no approved edits to sync' });
    if (outcome.status === 'failed') return res.status(502).json({ error: outcome.error });
    if (outcome.status === 'locked') {
      scheduleLockRetry(docKey, 0);
      return res.status(202).json({
        retrying: true,
        note: 'Someone has the document open in Word or a browser (SharePoint holds an editing lock, and keeps it up to ~10 minutes after the last person closes). BotBoy will retry automatically every few minutes for the next 2 hours and publish the approved edits the moment the document is free — nothing else to do.',
        edits: listPendingEdits(deps.db, docKey),
      });
    }

    const existingRetry = lockRetries.get(docKey);
    if (existingRetry) { clearTimeout(existingRetry.timer); lockRetries.delete(docKey); }
    res.json({
      uploaded: outcome.uploaded,
      verifiedOnReadBack: outcome.verifiedOnReadBack,
      results: outcome.results,
      edits: listPendingEdits(deps.db, docKey),
      note: outcome.uploaded
        ? 'One upload applied all synced edits; the pre-edit version stays in SharePoint version history.'
        : 'Nothing was uploaded — every approved edit conflicted with the current document; re-create them from current text.',
    });
  });

  router.get('/documents/sync-retry', (req: Request, res: Response) => {
    const docKey = String(req.query.docKey ?? '').trim();
    const entry = docKey ? lockRetries.get(docKey) : undefined;
    res.json(entry ? { retrying: true, attempts: entry.attempts, startedAt: entry.startedAt } : { retrying: false });
  });

  router.post('/documents/refresh', async (req: Request, res: Response) => {
    if (!deps.sharePointSync) return res.status(503).json({ error: 'document sync unavailable' });
    const body = req.body && typeof req.body === 'object' ? req.body as Record<string, unknown> : {};
    const docKey = String(body.docKey ?? '').trim();
    if (!docKey) return res.status(400).json({ error: 'docKey required' });
    const queued = deps.sharePointSync.refreshDocument(docKey);
    if (!queued.queued) return res.status(400).json({ error: queued.reason ?? 'could not queue refresh' });
    try {
      const processed = await deps.sharePointSync.drainNow();
      res.json({ refreshed: true, processed });
    } catch (error) {
      res.status(502).json({ error: `refresh queued but drain failed: ${(error as Error).message}` });
    }
  });

  return router;
}
