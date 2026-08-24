/**
 * Extractor — turns a captured item's source file/image into full text and
 * writes it losslessly (lossless-capture-brain-pipeline R3, R4, R9).
 *
 * Dispatch by extension:
 *   - image (png/jpg/jpeg/tiff/gif/bmp/webp) → OCR
 *   - document (pdf/docx/pptx/xlsx/txt/md/csv/json) → parse; a PDF that yields
 *     little/no text is additionally OCR'd page-by-page and merged (scanned PDFs)
 *   - anything else with no source file → nothing to extract (text already captured)
 *
 * The merged text is written via ContentStore (no caps). Extraction failures
 * are recorded (never silent), the item is flagged `incomplete`, and its state
 * is set to `extract_failed` so a later sweep can retry.
 */

import path from 'path';
import { existsSync, readFileSync, openSync, readSync, closeSync, statSync } from 'fs';
import type Database from 'better-sqlite3';
import type { DocumentParser } from './document-parser.js';
import type { OcrEngine } from './ocr-engine.js';
import { OcrUnavailableError } from './ocr-engine.js';
import type { ContentStore } from './content-store.js';
import { refToColumns } from './content-store.js';
import type { FailureRecorder } from './failures.js';

export type ExtractionKind = 'none' | 'doc' | 'ocr' | 'doc+ocr';

export interface ExtractOutcome {
  itemId: string;
  kind: ExtractionKind;
  bytes: number;
  ocrConfidence: number | null;
  state: 'extracted' | 'extract_failed' | 'noise';
}

/** Read a file as UTF-8 text if it looks textual (no NUL bytes in the head);
 *  returns null for binary content. The binary check reads only the first 8 KB
 *  (via a partial read) so we never load a large binary/video into memory just
 *  to reject it. Lets us capture code/log/config/tsv files the document parser
 *  doesn't special-case, without OCR'ing binaries. */
function readTextualFile(filePath: string): string | null {
  // 1) Cheap head-only binary probe.
  let fd: number | null = null;
  try {
    fd = openSync(filePath, 'r');
    const head = Buffer.alloc(8192);
    const n = readSync(fd, head, 0, 8192, 0);
    if (head.subarray(0, n).includes(0)) return null; // NUL byte ⇒ binary
  } catch {
    return null;
  } finally {
    if (fd != null) try { closeSync(fd); } catch { /* ignore */ }
  }
  // 2) Textual head → read the full file as UTF-8 (lossless).
  try {
    return readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

export interface Extractor {
  extract(itemId: string): Promise<ExtractOutcome>;
}

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.tiff', '.tif', '.gif', '.bmp', '.webp']);
/** A parsed PDF shorter than this is treated as image-only → OCR fallback. */
const PDF_TEXT_MIN_CHARS = 32;

interface ItemRow {
  id: string;
  type: string;
  source: string;
  url: string | null;
  screenshot_path: string | null;
  original_path: string | null;
  metadata: string | null;
  raw_text: string | null;
  content_storage: string | null;
  content_path: string | null;
  content_sha256: string | null;
  content_bytes: number | null;
}

/** Resolve the on-disk source path for an item, if any. */
export function resolveSourcePath(row: ItemRow): string | null {
  if (row.original_path && existsSync(row.original_path)) return row.original_path;
  let meta: Record<string, unknown> = {};
  try { meta = row.metadata ? JSON.parse(row.metadata) : {}; } catch { /* ignore */ }
  const fromMeta = typeof meta.filePath === 'string' ? meta.filePath : undefined;
  if (fromMeta && existsSync(fromMeta)) return fromMeta;
  if (row.url && row.url.startsWith('file://')) {
    const p = decodeURIComponent(row.url.slice('file://'.length));
    if (existsSync(p)) return p;
  }
  if (row.screenshot_path && existsSync(row.screenshot_path)) return row.screenshot_path;
  return null;
}

export function createExtractor(deps: {
  db: Database.Database;
  documentParser: DocumentParser;
  ocrEngine: OcrEngine;
  contentStore: ContentStore;
  failures: FailureRecorder;
}): Extractor {
  const { db, documentParser, ocrEngine, contentStore, failures } = deps;

  function persist(
    itemId: string,
    text: string,
    kind: ExtractionKind,
    ocrConfidence: number | null,
  ): ExtractOutcome {
    const ref = contentStore.put(itemId, text);
    const cols = refToColumns(ref);
    db.prepare(
      `UPDATE work_items SET
         raw_text = ?, content_storage = ?, content_path = ?, content_sha256 = ?, content_bytes = ?,
         extraction_kind = ?, ocr_confidence = ?, process_state = 'extracted'
       WHERE id = ?`,
    ).run(
      cols.raw_text, cols.content_storage, cols.content_path, cols.content_sha256, cols.content_bytes,
      kind, ocrConfidence, itemId,
    );
    return { itemId, kind, bytes: ref.byteLength, ocrConfidence, state: 'extracted' };
  }

  function persistOcrLines(itemId: string, lines: { text: string; confidence: number }[]): void {
    if (lines.length === 0) return;
    const stmt = db.prepare(
      'INSERT OR REPLACE INTO item_ocr_lines (item_id, line_index, text, confidence) VALUES (?, ?, ?, ?)',
    );
    const tx = db.transaction(() => {
      lines.forEach((l, i) => stmt.run(itemId, i, l.text, l.confidence));
    });
    tx();
  }

  function markFailed(itemId: string, step: 'parse' | 'ocr', message: string): ExtractOutcome {
    // Password-protected documents are a deterministic, permanent condition —
    // no retry can ever succeed, so record them non-retryable to keep the
    // failure health signal (and any future retry sweep) honest.
    const permanent = /password.?protected|password required/i.test(message);
    failures.record({ itemId, step, message, retryable: !permanent, markIncomplete: true });
    db.prepare("UPDATE work_items SET process_state = 'extract_failed' WHERE id = ?").run(itemId);
    return { itemId, kind: 'none', bytes: 0, ocrConfidence: null, state: 'extract_failed' };
  }

  return {
    async extract(itemId: string): Promise<ExtractOutcome> {
      const row = db.prepare('SELECT * FROM work_items WHERE id = ?').get(itemId) as ItemRow | undefined;
      if (!row) {
        failures.record({ itemId, step: 'parse', message: 'item not found for extraction', retryable: false });
        return { itemId, kind: 'none', bytes: 0, ocrConfidence: null, state: 'extract_failed' };
      }

      const sourcePath = resolveSourcePath(row);
      if (!sourcePath) {
        // Nothing to extract — text (if any) was already captured. Mark extracted.
        db.prepare("UPDATE work_items SET process_state = 'extracted', extraction_kind = 'none' WHERE id = ?").run(itemId);
        return { itemId, kind: 'none', bytes: row.content_bytes ?? 0, ocrConfidence: null, state: 'extracted' };
      }

      const ext = path.extname(sourcePath).toLowerCase();

      // ── Image → OCR ──
      if (IMAGE_EXTS.has(ext)) {
        try {
          const r = await ocrEngine.ocr(sourcePath);
          persistOcrLines(itemId, r.lines);
          return persist(itemId, r.text, 'ocr', r.aggConfidence);
        } catch (err) {
          if (err instanceof OcrUnavailableError) {
            return markFailed(itemId, 'ocr', `OCR unavailable: ${(err as Error).message}`);
          }
          return markFailed(itemId, 'ocr', (err as Error).message);
        }
      }

      // ── Document → parse ──
      // Prefer the non-blocking parser: extraction runs on the server's
      // event loop timers, and a synchronous 60 s subprocess per document
      // froze the whole dashboard (2026-08-24, password-protected PDF in a
      // watched Downloads). Falls back to sync parse for stub parsers.
      const parsed = documentParser.parseAsync
        ? await documentParser.parseAsync(sourcePath)
        : documentParser.parse(sourcePath);
      if (!parsed.success) {
        const unsupported = (parsed.error || '').includes('Unsupported format');
        if (unsupported) {
          // Not an error. Many "unsupported" files are still text (.tsv, .log,
          // .yaml, .xml, source code, etc.) — capture them as text. Genuinely
          // binary files (that slipped past the monitor's skip list) are marked
          // noise quietly rather than OCR'd or logged as failures.
          const text = readTextualFile(sourcePath);
          if (text != null) return persist(itemId, text, 'doc', null);
          db.prepare("UPDATE work_items SET process_state = 'noise', extraction_kind = 'none' WHERE id = ?").run(itemId);
          return { itemId, kind: 'none', bytes: 0, ocrConfidence: null, state: 'noise' };
        }
        // A supported type that genuinely failed to parse (e.g. corrupt) — real
        // failure worth surfacing.
        return markFailed(itemId, 'parse', parsed.error ?? 'parse failed');
      }

      let text = parsed.text ?? '';
      let kind: ExtractionKind = 'doc';
      let ocrConf: number | null = null;

      if (ext === '.pdf' && text.trim().length < PDF_TEXT_MIN_CHARS) {
        // Likely image-only / scanned PDF → OCR pages and merge (R3.5, R4.3).
        try {
          const r = await ocrEngine.ocrPdfPages(sourcePath);
          if (r.text.trim().length > 0) {
            text = text.trim() ? `${text}\n\n${r.text}` : r.text;
            kind = 'doc+ocr';
            ocrConf = r.aggConfidence;
            persistOcrLines(itemId, r.lines);
          }
        } catch (err) {
          // Parse produced (little) text but OCR fallback failed — keep what we
          // have, but record the OCR miss for visibility.
          failures.record({ itemId, step: 'ocr', message: `PDF OCR fallback failed: ${(err as Error).message}`, retryable: true });
        }
      }

      return persist(itemId, text, kind, ocrConf);
    },
  };
}
