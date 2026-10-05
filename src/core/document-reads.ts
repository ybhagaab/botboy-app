/**
 * Long documents in project brains (policy C, owner decisions 2026-10-03/04).
 *
 * One brain call shows an item at most `LARGE_DOCUMENT_CHARS` characters, so
 * a longer document used to reach its brief only as a balanced excerpt
 * (head, three interior windows, tail). Instead, per project and document:
 *
 * - The first version a project sees (or the version the owner resumes
 *   after pausing a file) is read in full, one part per idle interpretation
 *   tick, in order.
 * - A later version is read as its changes against the version read last;
 *   when more than half of it changed, it is read in full again.
 * - A document longer than `MAX_FULL_READ_PARTS` parts keeps the excerpt
 *   (`sample`); the owner can ask for a full read from the project page.
 * - Documents that were already routed when this shipped get one full read
 *   of their newest version (`seedExisting`, once).
 * - A document whose text the project brain has already read under another
 *   name (a Slack attachment and its Downloads copy) is not read again.
 * - A document stored as raw file bytes (`isRawFileText`) is never read in
 *   parts; its batch keeps the excerpt, as before.
 *
 * Identity: a read row per (project, document). The document is its
 * SharePoint `docKey`, local file path, or Slack file id, else the item.
 * Execution: the orchestrator calls `tick` under its interpretation lock
 * only when no librarian wave is due, so routing never waits for reading.
 * Every write is a compare-and-swap on (item, mode, offset): a version that
 * arrives mid-part simply restarts the read on the new version.
 */

import type Database from 'better-sqlite3';
import type { ContentStore, ContentRowColumns } from './content-store.js';
import type { BrainStore } from './brain-store.js';
import type { PipelineLlm } from './pipeline-llm.js';
import { getSetting, setSetting } from './storage.js';
import { changedTextForBrief } from './document-diff.js';
import { isRawFileText } from './raw-file-text.js';

/** The most characters of one item a brain call shows; longer documents are read in parts. */
export const LARGE_DOCUMENT_CHARS = 128_000;
/** Longest document read in full on its own: 40 parts. Longer ones keep the excerpt until the owner asks. */
export const MAX_FULL_READ_PARTS = 40;
/** Largest part, whatever the model's input budget. */
export const MAX_PART_CHARS = 220_000;
/** Below this the model's input budget is too small to read in parts; the document is read as an excerpt. */
export const MIN_PART_CHARS = 20_000;
/** Read in full again when more than this share of a new version changed. */
export const DIFF_FULL_READ_RATIO = 0.5;
export const MAX_PART_ATTEMPTS = 3;

const DOCUMENT_TYPES = new Set(['document_capture', 'document_online', 'pdf_download']);
const SEED_KEY = 'brain_document_reads.seeded.v1';
const RAW_FILE_REASON = 'stored as raw file bytes, not text';

export const DOCUMENT_PART_PROMPT_VERSION = 'brain-v9-document-part';
export const DOCUMENT_DIFF_PROMPT_VERSION = 'brain-v9-document-diff';

const PART_NOTE = 'The evidence item is one part of a long document that BotBoy reads in order, one part per update. '
  + 'The current brain already reflects the earlier parts. Add what this part contributes, keep facts from earlier parts '
  + 'unless this part corrects them, and never describe the brain or the document as partial or incomplete.';
const DIFF_NOTE = 'The evidence item lists what changed in a long document since the version this brain last read: '
  + 'lines added or changed (marked +, with a little unchanged context) under their section, then lines removed. '
  + 'The rest of the document is unchanged and already reflected in the brain. Update the brain for these changes only, '
  + 'and quote newActivity only from added or context lines.';

export type DocumentReadMode = 'full' | 'diff' | 'sample';
export type DocumentReadStatus = 'reading' | 'done' | 'sample' | 'failed' | 'skipped';

/** What one brain call shows of a long document instead of its (excerpted) whole text. */
export interface DocumentReadView {
  itemId: string;
  text: string;
  /** Prefix for the item's CONTENT label, e.g. "part 2 of 9 of this document (…)". */
  label: string;
  note: string;
  promptVersion: string;
  /** The text is sized to fit and must be shown whole (false: excerpt it like any item). */
  complete: boolean;
  /** Scope was decided on the whole document when its read started; later parts skip the check. */
  scopeDecided: boolean;
}

/** The brain side of a read (implemented by brain-updater.ts). */
export interface DocumentReader {
  /** Characters of document text one brain call for this project can show now. */
  partBudgetChars(projectId: string): number;
  readDocumentPart(projectId: string, view: DocumentReadView): Promise<{ status: string; skipReason?: string }>;
}

export interface DocumentReadInfo {
  docKey: string;
  itemId: string;
  mode: DocumentReadMode;
  status: DocumentReadStatus;
  partsDone: number;
  /** Estimate: parts done plus the rest at the largest part size. */
  partsTotal: number;
  reason: string | null;
}

export interface DocumentReadTick {
  ran: boolean;
  projectId?: string;
  docKey?: string;
  part?: number;
  partsTotal?: number;
  outcome?: string;
}

export interface DocumentReads {
  /**
   * A new long version reached a project brain. Returns `reading` when this
   * lane reads it (the caller leaves it out of its batch) or `sample` when it
   * is too long to read in full (the caller synthesizes its excerpt).
   */
  enqueue(projectId: string, item: DocumentItem, capChars: number): 'reading' | 'sample';
  /** Read one part of the oldest waiting document. The caller holds the interpretation lock. */
  tick(reader: DocumentReader): Promise<DocumentReadTick>;
  /** Owner request: read this version in full, whatever its length. */
  readInFull(projectId: string, itemId: string): { ok: true; info: DocumentReadInfo } | { ok: false; status: number; error: string };
  forProject(projectId: string): Map<string, DocumentReadInfo>;
  counts(): Record<DocumentReadStatus, number>;
}

export interface DocumentItem {
  id: string;
  type: string;
  source: string;
  content: string;
  metadata: Record<string, unknown>;
}

interface ReadRow {
  project_id: string;
  doc_key: string;
  item_id: string;
  base_item_id: string | null;
  mode: DocumentReadMode;
  status: DocumentReadStatus;
  next_offset: number;
  text_chars: number;
  parts_done: number;
  attempts: number;
  reason: string | null;
}

interface LoadedItem {
  id: string;
  type: string;
  source: string;
  projectId: string | null;
  state: string;
  capturedAt: string;
  metadata: Record<string, unknown>;
  content: string;
}

/** A document's file or page name for logs: the last segment of its identity. */
function documentName(docKey: string): string {
  const name = docKey.slice(docKey.lastIndexOf('/') + 1) || docKey;
  return name.length > 80 ? `${name.slice(0, 77)}…` : name;
}

/** Let the event loop run between steps that each handle megabytes of text. */
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * A routed document version too long for one brain call, whose stored text
 * is extracted text. A row stored as raw file bytes (`isRawFileText`;
 * reading it in parts would show the model only file structure) is not.
 */
export function isLargeDocument(item: { type: string; content: string }): boolean {
  return DOCUMENT_TYPES.has(item.type) && item.content.length > LARGE_DOCUMENT_CHARS && !isRawFileText(item.content);
}

/** One identity across a document's versions: SharePoint docKey, local path, Slack file, else the item. */
export function documentKeyOf(item: { id: string; source: string; metadata: Record<string, unknown> }): string {
  const meta = item.metadata ?? {};
  if (typeof meta.docKey === 'string' && meta.docKey) return `sharepoint:${meta.docKey}`;
  if (typeof meta.filePath === 'string' && meta.filePath) return `file:${meta.filePath}`;
  if (typeof meta.fileId === 'string' && meta.fileId) return `${item.source}:${meta.fileId}`;
  return `item:${item.id}`;
}

/**
 * The part of `text` that starts at `offset`, at most `maxChars` long, ending
 * at a paragraph break when one falls in its last 40%, else a line break,
 * else a space; never inside a surrogate pair.
 */
export function nextDocumentPart(text: string, offset: number, maxChars: number): { start: number; end: number; text: string } {
  const start = Math.max(0, Math.min(offset, text.length));
  const limit = Math.min(text.length, start + Math.max(1, maxChars));
  if (limit >= text.length) return { start, end: text.length, text: text.slice(start) };
  const floor = start + Math.floor((limit - start) * 0.6);
  let end = -1;
  for (const separator of ['\n\n', '\n', ' ']) {
    const at = text.lastIndexOf(separator, limit - separator.length);
    if (at >= floor) { end = at + separator.length; break; }
  }
  if (end < 0) end = limit;
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return { start, end, text: text.slice(start, end) };
}

export function createDocumentReads(deps: {
  db: Database.Database;
  contentStore: ContentStore;
  brainStore: Pick<BrainStore, 'getProject'>;
  llm: Pick<PipelineLlm, 'isAvailable'>;
  now?: () => Date;
}): DocumentReads {
  const { db, contentStore, brainStore, llm } = deps;
  const now = deps.now ?? (() => new Date());

  const selectRow = db.prepare('SELECT * FROM brain_document_reads WHERE project_id = ? AND doc_key = ?');
  const upsertRow = db.prepare(`
    INSERT INTO brain_document_reads (project_id, doc_key, item_id, base_item_id, mode, status, next_offset, text_chars,
      parts_done, attempts, reason, queued_at, updated_at)
    VALUES (@projectId, @docKey, @itemId, @baseItemId, @mode, @status, 0, @textChars, 0, 0, @reason, @at, @at)
    ON CONFLICT(project_id, doc_key) DO UPDATE SET
      item_id = excluded.item_id, base_item_id = excluded.base_item_id, mode = excluded.mode, status = excluded.status,
      next_offset = 0, text_chars = excluded.text_chars, parts_done = 0, attempts = 0, reason = excluded.reason,
      queued_at = excluded.queued_at, updated_at = excluded.updated_at
  `);
  // Owner requests first, then changed versions (usually one part), then full reads, oldest first.
  const nextReading = db.prepare(`
    SELECT * FROM brain_document_reads WHERE status = 'reading'
    ORDER BY CASE WHEN reason = 'owner_requested' THEN 0 WHEN mode = 'diff' THEN 1 ELSE 2 END, queued_at, rowid
    LIMIT 1
  `);
  const advance = db.prepare(`
    UPDATE brain_document_reads SET next_offset = @nextOffset, text_chars = @textChars, parts_done = parts_done + 1,
      attempts = 0, status = @status, reason = CASE WHEN @status = 'done' THEN NULL ELSE reason END, updated_at = @at
    WHERE project_id = @projectId AND doc_key = @docKey AND item_id = @itemId AND mode = @mode
      AND next_offset = @offset AND status = 'reading'
  `);
  const finish = db.prepare(`
    UPDATE brain_document_reads SET status = @status, reason = @reason, updated_at = @at
    WHERE project_id = @projectId AND doc_key = @docKey AND item_id = @itemId AND mode = @mode AND status = 'reading'
  `);
  const switchToFull = db.prepare(`
    UPDATE brain_document_reads SET mode = 'full', base_item_id = NULL, next_offset = 0, parts_done = 0, text_chars = @textChars,
      reason = @reason, updated_at = @at
    WHERE project_id = @projectId AND doc_key = @docKey AND item_id = @itemId AND mode = 'diff' AND status = 'reading'
  `);
  const failAttempt = db.prepare(`
    UPDATE brain_document_reads SET attempts = attempts + 1,
      status = CASE WHEN attempts + 1 >= @maxAttempts THEN 'failed' ELSE status END,
      reason = CASE WHEN reason = 'owner_requested' AND attempts + 1 < @maxAttempts THEN reason ELSE @reason END, updated_at = @at
    WHERE project_id = @projectId AND doc_key = @docKey AND item_id = @itemId AND mode = @mode
      AND next_offset = @offset AND status = 'reading'
  `);
  const selectItem = db.prepare(`
    SELECT id, type, source, project_id AS projectId, process_state AS state, captured_at AS capturedAt, metadata,
           raw_text, content_storage, content_path, content_sha256, content_bytes
    FROM work_items WHERE id = ?
  `);
  // Another document still in this project whose read finished on the very same text.
  const sameTextRead = db.prepare(`
    SELECT r.doc_key AS docKey FROM brain_document_reads r
    JOIN work_items other ON other.id = r.item_id
    JOIN work_items mine ON mine.id = @itemId
    WHERE r.project_id = @projectId AND r.status = 'done'
      AND other.project_id = r.project_id AND other.process_state = 'routed'
      AND other.content_sha256 = mine.content_sha256
    LIMIT 1
  `);

  function parse(raw: unknown): Record<string, unknown> {
    try { return typeof raw === 'string' ? JSON.parse(raw) as Record<string, unknown> : {}; } catch { return {}; }
  }

  function loadItem(itemId: string | null): LoadedItem | null {
    if (!itemId) return null;
    const row = selectItem.get(itemId) as (ContentRowColumns & { id: string; type: string; source: string; projectId: string | null; state: string; capturedAt: string; metadata: string | null }) | undefined;
    if (!row) return null;
    const ref = contentStore.refFromRow(row);
    let content = '';
    try { content = ref ? contentStore.get(ref) : ''; } catch { return null; }
    return {
      id: row.id, type: row.type, source: row.source, projectId: row.projectId, state: row.state,
      capturedAt: row.capturedAt, metadata: parse(row.metadata), content,
    };
  }

  function info(row: ReadRow): DocumentReadInfo {
    const remaining = Math.max(0, row.text_chars - row.next_offset);
    return {
      docKey: row.doc_key,
      itemId: row.item_id,
      mode: row.mode,
      status: row.status,
      partsDone: row.parts_done,
      partsTotal: row.status === 'reading' ? row.parts_done + Math.max(1, Math.ceil(remaining / MAX_PART_CHARS)) : row.parts_done,
      reason: row.reason,
    };
  }

  function queue(entry: { projectId: string; docKey: string; itemId: string; baseItemId: string | null; mode: DocumentReadMode; status: DocumentReadStatus; textChars: number; reason: string | null }): void {
    upsertRow.run({ ...entry, at: now().toISOString() });
  }

  function key(row: ReadRow): { projectId: string; docKey: string; itemId: string; mode: DocumentReadMode } {
    return { projectId: row.project_id, docKey: row.doc_key, itemId: row.item_id, mode: row.mode };
  }

  /**
   * Existing routed long documents: one full read of each document whose
   * newest routed version in a project is long. An older long version never
   * qualifies on its own (the brain has read the newer one). Text is loaded
   * only for those versions, one per event-loop turn, so a store holding
   * hundreds of megabytes of documents never stalls the app.
   */
  async function seedExisting(reader: DocumentReader): Promise<void> {
    if (getSetting<unknown>(db, SEED_KEY) != null) return;
    const versions = db.prepare(`
      SELECT w.id, w.source, w.project_id AS projectId, w.metadata, COALESCE(w.content_bytes, 0) AS bytes
      FROM work_items w JOIN projects p ON p.id = w.project_id
      WHERE w.type IN ('document_capture', 'document_online', 'pdf_download') AND w.process_state = 'routed'
        AND p.status IN ('active', 'paused')
      ORDER BY w.captured_at DESC, w.rowid DESC
    `).all() as Array<{ id: string; source: string; projectId: string; metadata: string | null; bytes: number }>;
    const newest = new Map<string, { id: string; projectId: string; docKey: string; bytes: number }>();
    for (const version of versions) {
      const docKey = documentKeyOf({ id: version.id, source: version.source, metadata: parse(version.metadata) });
      const seenKey = `${version.projectId}\u0000${docKey}`;
      if (!newest.has(seenKey)) newest.set(seenKey, { id: version.id, projectId: version.projectId, docKey, bytes: version.bytes });
    }
    let reading = 0;
    let sample = 0;
    for (const candidate of newest.values()) {
      // UTF-8 bytes bound the text length: a version this small was read whole in its batch.
      if (candidate.bytes <= LARGE_DOCUMENT_CHARS) continue;
      await yieldToEventLoop();
      const item = loadItem(candidate.id);
      if (!item || !isLargeDocument(item)) continue;
      // A read queued meanwhile (a newer version) stands.
      if (selectRow.get(candidate.projectId, candidate.docKey)) continue;
      const budget = Math.min(MAX_PART_CHARS, reader.partBudgetChars(candidate.projectId));
      if (budget < MIN_PART_CHARS) continue;
      const entry = { projectId: candidate.projectId, docKey: candidate.docKey, itemId: item.id, baseItemId: null, textChars: item.content.length };
      if (item.content.length > MAX_FULL_READ_PARTS * budget) {
        queue({ ...entry, mode: 'sample', status: 'sample', reason: 'too long to read in full' });
        sample++;
      } else {
        queue({ ...entry, mode: 'full', status: 'reading', reason: 'one-time full read of a document routed before parts' });
        reading++;
      }
    }
    setSetting(db, SEED_KEY, { seededAt: now().toISOString(), reading, sample });
    if (reading + sample > 0) console.log(`[Brain] Long documents: ${reading} queued for one full read, ${sample} too long (excerpt kept)`);
    await yieldToEventLoop();
  }

  return {
    enqueue(projectId, item, capChars) {
      const docKey = documentKeyOf(item);
      const row = selectRow.get(projectId, docKey) as ReadRow | undefined;
      if (item.content.length > capChars) {
        queue({ projectId, docKey, itemId: item.id, baseItemId: null, mode: 'sample', status: 'sample', textChars: item.content.length, reason: 'too long to read in full' });
        return 'sample';
      }
      // Already queued or read: nothing new (an update called twice for one version).
      if (row && row.item_id === item.id && (row.status === 'reading' || row.status === 'done') && row.mode !== 'sample') return 'reading';
      const forceFull = item.metadata.briefRead === 'full';
      const base = !forceFull && row
        ? row.status === 'done' ? row.item_id : row.status === 'reading' && row.mode === 'diff' ? row.base_item_id : null
        : null;
      if (base && base !== item.id) {
        queue({ projectId, docKey, itemId: item.id, baseItemId: base, mode: 'diff', status: 'reading', textChars: 0, reason: null });
      } else {
        queue({ projectId, docKey, itemId: item.id, baseItemId: null, mode: 'full', status: 'reading', textChars: item.content.length, reason: forceFull ? 'owner resumed the file' : null });
      }
      return 'reading';
    },

    async tick(reader) {
      await seedExisting(reader);
      if (!llm.isAvailable()) return { ran: false };
      const row = nextReading.get() as ReadRow | undefined;
      if (!row) return { ran: false };
      const at = () => now().toISOString();
      const name = documentName(row.doc_key);
      const stop = (status: DocumentReadStatus, reason: string): DocumentReadTick => {
        finish.run({ ...key(row), status, reason, at: at() });
        console.log(`[Brain] Long document "${name}" in ${row.project_id}: ${status} (${reason})`);
        return { ran: false, projectId: row.project_id, docKey: row.doc_key, outcome: status };
      };

      const project = brainStore.getProject(row.project_id);
      if (!project || (project.status !== 'active' && project.status !== 'paused')) return stop('skipped', 'the project is no longer active');
      const item = loadItem(row.item_id);
      if (!item || item.projectId !== row.project_id || item.state !== 'routed') return stop('skipped', 'this version left the project');
      if (isRawFileText(item.content)) return stop('skipped', RAW_FILE_REASON);
      // This brain has read this very text already, under another name (a
      // Slack attachment and its Downloads copy). An owner request reads it regardless.
      if (row.reason !== 'owner_requested') {
        const twin = sameTextRead.get({ projectId: row.project_id, itemId: row.item_id }) as { docKey: string } | undefined;
        if (twin) return stop('done', `same text as ${documentName(twin.docKey)}, read already`);
      }

      let mode = row.mode;
      let text = item.content;
      let offset = row.next_offset;
      let partsDone = row.parts_done;
      if (mode === 'diff') {
        const base = loadItem(row.base_item_id);
        const changes = base ? changedTextForBrief(base.content, item.content, { since: base.capturedAt?.slice(0, 10) }) : undefined;
        if (changes === null) return stop('done', 'no text changed');
        if (!changes || changes.changedChars > DIFF_FULL_READ_RATIO * item.content.length) {
          switchToFull.run({ ...key(row), textChars: item.content.length, reason: base ? 'more than half of it changed' : 'the version read last is gone', at: at() });
          mode = 'full';
          offset = 0;
          partsDone = 0;
        } else {
          text = changes.text;
        }
      }

      const budget = Math.min(MAX_PART_CHARS, reader.partBudgetChars(row.project_id));
      const current = { projectId: row.project_id, docKey: row.doc_key, itemId: row.item_id, mode };
      if (budget < MIN_PART_CHARS) {
        // The model cannot hold a useful part: read it as an excerpt, once.
        const result = await reader.readDocumentPart(row.project_id, {
          itemId: row.item_id, text, label: 'excerpt (the model input is too small to read this document in parts)',
          note: mode === 'diff' ? DIFF_NOTE : PART_NOTE, promptVersion: mode === 'diff' ? DOCUMENT_DIFF_PROMPT_VERSION : DOCUMENT_PART_PROMPT_VERSION,
          complete: false, scopeDecided: false,
        });
        finish.run({ ...current, status: 'done', reason: `read as an excerpt (${result.skipReason ?? result.status})`, at: at() });
        return { ran: true, projectId: row.project_id, docKey: row.doc_key, outcome: 'excerpt' };
      }

      const part = nextDocumentPart(text, offset, budget);
      const partNumber = partsDone + 1;
      const partsTotal = partNumber + Math.ceil((text.length - part.end) / budget);
      const view: DocumentReadView = {
        itemId: row.item_id,
        text: part.text,
        label: mode === 'diff'
          ? `changes since the version read last${partsTotal > 1 ? `, part ${partNumber} of ${partsTotal}` : ''}`
          : `part ${partNumber} of ${partsTotal} of this document (characters ${(part.start + 1).toLocaleString('en-US')}–${part.end.toLocaleString('en-US')} of ${text.length.toLocaleString('en-US')})`,
        note: mode === 'diff' ? DIFF_NOTE : PART_NOTE,
        promptVersion: mode === 'diff' ? DOCUMENT_DIFF_PROMPT_VERSION : DOCUMENT_PART_PROMPT_VERSION,
        complete: true,
        scopeDecided: partsDone > 0,
      };
      let result: { status: string; skipReason?: string };
      try {
        result = await reader.readDocumentPart(row.project_id, view);
      } catch {
        // An unexpected error counts like a model failure: bounded retries, never a loop.
        result = { status: 'skipped', skipReason: 'model_failure' };
      }
      const tick: DocumentReadTick = { ran: true, projectId: row.project_id, docKey: row.doc_key, part: partNumber, partsTotal, outcome: result.skipReason ?? result.status };

      const where = `[Brain] Long document "${name}" in ${row.project_id}`;
      if (result.status === 'conflict') {
        finish.run({ ...current, status: 'failed', reason: 'the brain was edited by hand; its proposed update is saved beside it', at: at() });
        console.log(`${where}: stopped at part ${partNumber}, the brain was edited by hand`);
        return tick;
      }
      if (result.skipReason === 'out_of_scope') {
        finish.run({ ...current, status: 'skipped', reason: "outside this project's scope", at: at() });
        console.log(`${where}: skipped, outside the project's scope`);
        return tick;
      }
      if (result.skipReason === 'model_failure') {
        failAttempt.run({ ...current, offset, maxAttempts: MAX_PART_ATTEMPTS, reason: `the model failed on part ${partNumber}`, at: at() });
        console.log(`${where}: the model failed on part ${partNumber} (attempt ${row.attempts + 1} of ${MAX_PART_ATTEMPTS})`);
        return tick;
      }
      // Updated, unchanged, or held back by the brain's own safety checks:
      // this part is done either way.
      const done = part.end >= text.length;
      advance.run({ ...current, offset, nextOffset: part.end, textChars: text.length, status: done ? 'done' : 'reading', at: at() });
      if (done) console.log(`${where}: ${mode === 'diff' ? 'changes read' : `read in full (${partNumber} part${partNumber === 1 ? '' : 's'})`}`);
      return tick;
    },

    readInFull(projectId, itemId) {
      const item = loadItem(itemId);
      if (!item || item.projectId !== projectId || item.state !== 'routed') return { ok: false, status: 404, error: 'this document is not routed to this project' };
      if (!DOCUMENT_TYPES.has(item.type)) return { ok: false, status: 409, error: 'only documents are read in parts' };
      if (isRawFileText(item.content)) return { ok: false, status: 409, error: `${RAW_FILE_REASON}: there is no text to read` };
      const docKey = documentKeyOf(item);
      queue({ projectId, docKey, itemId, baseItemId: null, mode: 'full', status: 'reading', textChars: item.content.length, reason: 'owner_requested' });
      return { ok: true, info: info(selectRow.get(projectId, docKey) as ReadRow) };
    },

    forProject(projectId) {
      const rows = db.prepare('SELECT * FROM brain_document_reads WHERE project_id = ?').all(projectId) as ReadRow[];
      return new Map(rows.map((row) => [row.item_id, info(row)]));
    },

    counts() {
      const counts: Record<DocumentReadStatus, number> = { reading: 0, done: 0, sample: 0, failed: 0, skipped: 0 };
      for (const row of db.prepare('SELECT status, COUNT(*) AS n FROM brain_document_reads GROUP BY status').all() as Array<{ status: DocumentReadStatus; n: number }>) {
        counts[row.status] = row.n;
      }
      return counts;
    },
  };
}
