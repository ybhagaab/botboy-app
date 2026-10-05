/**
 * One-time repair of local PDF captures stored as raw bytes (2026-10-05).
 *
 * Until 2026-10-05 the last PDF fallback, macOS textutil, echoed a PDF's
 * bytes as its "text", so a Mac without the vision-ocr helper and poppler
 * stored every PDF that way, and routing and briefs read those bytes (the
 * owner's July–August 2026 captures: 75 rows, 30 routed, some into projects
 * named after the filenames). This applies, on every store, the rules the
 * owner's store was cleaned with the same day:
 *
 * - Every local document capture whose stored text is a PDF's bytes is
 *   deleted with its search rows, links, and content files. Its todos and
 *   cross links move to the newest text capture of the same file.
 * - A watched file whose newest capture was such a row is captured again
 *   once through the pending lane (ledger `approved`, like an owner resume),
 *   so the normal pipeline extracts, routes, and briefs its real text. Every
 *   install reads PDFs now (`scripts/pdf-text.mjs`). A file of the big-file
 *   size or more waits for the owner's review instead, and a file the owner
 *   paused or excluded, or one held as a possible credential, is left alone.
 *
 * Briefs that read the bytes keep what they wrote until new evidence or an
 * owner rebuild; projects the bytes created stay for the owner to archive.
 *
 * Execution: the folder-import scheduler runs it after final-ready, after the
 * file-reference migration and before any folder walk, so the same pass
 * imports the re-captures. One small transaction per file with a yield
 * between them; a row the extractor or a librarian wave may still write
 * defers its file to the next pass. The marker, a receipt with the counts,
 * is set only after a pass that leaves nothing behind.
 */

import { closeSync, existsSync, openSync, readdirSync, readSync, statSync, unlinkSync } from 'fs';
import path from 'path';
import type Database from 'better-sqlite3';
import { getSetting, setSetting } from './storage.js';
import { deleteWorkItemFts } from './work-items-fts.js';
import { isPdfBytes } from './raw-file-text.js';
import { createLocalFolderImportLedger, folderImportThresholds } from './local-folder-imports.js';
import { NOOP_MAIN_THREAD_WATCHDOG, type MainThreadWatchdog } from './main-thread-watchdog.js';

export const RAW_CAPTURE_REPAIR_KEY = 'raw_pdf_captures.repair.v1';
/** Ledger `reason` of a re-capture this repair queued (read by nothing; kept for the record). */
export const RAW_RECAPTURE_REASON = 'raw_pdf_recapture';
const WATCHDOG_LABEL = 'raw-capture-repair';
const HEAD_BYTES = 64;
/** Ledger outcomes the owner or the credential gate decided; a re-capture never overrides them. */
const HELD_OUTCOMES = new Set(['sensitive', 'owner_paused', 'excluded']);

export interface RawCaptureRepairResult {
  /** True when the marker is set: nothing is left to repair. */
  done: boolean;
  aborted?: boolean;
  /** Captures deleted because their stored text was a PDF's bytes. */
  deleted: number;
  /** Watched files queued for one fresh capture. */
  recaptures: number;
  /** Files whose rows the extractor or a librarian wave may still write; retried on a later pass. */
  deferred: number;
  filesRemoved: number;
  bytesRemoved: number;
}

export interface RawCaptureRepair {
  isDone(): boolean;
  run(opts?: { signal?: AbortSignal }): Promise<RawCaptureRepairResult>;
}

interface CaptureRow {
  rowid: number;
  id: string;
  state: string;
  batchId: string | null;
  capturedAt: string;
  filePath: string;
  contentStorage: string | null;
  contentPath: string | null;
  inlineHead: string | null;
  originalPath: string | null;
}

function newestFirst(a: CaptureRow, b: CaptureRow): number {
  if (a.capturedAt !== b.capturedAt) return a.capturedAt < b.capturedAt ? 1 : -1;
  return b.rowid - a.rowid;
}

/** A row the extractor or a librarian wave may still write to. */
function inFlight(row: CaptureRow): boolean {
  return row.state === 'captured' || (row.state === 'extracted' && row.batchId != null);
}

export function createRawCaptureRepair(deps: {
  db: Database.Database;
  /** Content store directory. Only files inside it are ever removed. */
  contentDir: string;
  /** Files at or above this size wait for the owner's big-file review (`folderImportThresholds`). */
  bigFileBytes?: number;
  watchdog?: MainThreadWatchdog;
  yieldToLoop?: () => Promise<void>;
  now?: () => Date;
}): RawCaptureRepair {
  const { db } = deps;
  const contentRoot = path.resolve(deps.contentDir) + path.sep;
  const bigFileBytes = deps.bigFileBytes ?? folderImportThresholds().bigFileBytes;
  const watchdog = deps.watchdog ?? NOOP_MAIN_THREAD_WATCHDOG;
  const yieldToLoop = deps.yieldToLoop ?? (() => new Promise<void>((resolve) => setImmediate(resolve)));
  const now = deps.now ?? (() => new Date());
  const ledger = createLocalFolderImportLedger(db);

  const capturesStmt = db.prepare(`
    SELECT rowid AS rowid, id, process_state AS state, batch_id AS batchId, captured_at AS capturedAt,
           content_storage AS contentStorage, content_path AS contentPath, original_path AS originalPath,
           CASE WHEN content_storage = 'file' THEN NULL ELSE substr(raw_text, 1, ${HEAD_BYTES}) END AS inlineHead,
           COALESCE(file_path, CASE WHEN json_valid(metadata) THEN json_extract(metadata, '$.filePath') END) AS filePath
    FROM work_items
    WHERE source = 'filesystem' AND type = 'document_capture'
  `);
  const watchedFolders = db.prepare('SELECT id, path FROM local_folders WHERE enabled = 1');
  const unlink = {
    nodeLinks: db.prepare('DELETE FROM node_work_items WHERE work_item_id = ?'),
    todos: db.prepare('UPDATE agent_todos SET work_item_id = ? WHERE work_item_id = ?'),
    crossLinks: db.prepare('UPDATE project_cross_links SET evidence_item_id = ? WHERE evidence_item_id = ?'),
    ocr: db.prepare('DELETE FROM item_ocr_lines WHERE item_id = ?'),
    failures: db.prepare('DELETE FROM failures WHERE item_id = ?'),
    routing: db.prepare('DELETE FROM routing_decisions WHERE item_id = ?'),
    reads: db.prepare('DELETE FROM brain_document_reads WHERE item_id = ?'),
    // Rejections, discards, and project events cascade with the row.
    item: db.prepare("DELETE FROM work_items WHERE id = ? AND source = 'filesystem' AND type = 'document_capture'"),
  };

  function isDone(): boolean {
    return getSetting<unknown>(db, RAW_CAPTURE_REPAIR_KEY) != null;
  }

  function headOf(row: CaptureRow): string {
    if (row.contentStorage !== 'file') return row.inlineHead ?? '';
    if (!row.contentPath) return '';
    let fd: number | null = null;
    try {
      fd = openSync(row.contentPath, 'r');
      const buffer = Buffer.alloc(HEAD_BYTES);
      const bytes = readSync(fd, buffer, 0, HEAD_BYTES, 0);
      return buffer.subarray(0, bytes).toString('latin1');
    } catch {
      return '';
    } finally {
      if (fd != null) try { closeSync(fd); } catch { /* ignore */ }
    }
  }

  function insideContentDir(filePath: string): boolean {
    return path.resolve(filePath).startsWith(contentRoot);
  }

  /** Content files a row owns: its text blob, any aux blobs, a stored original. Only inside the store. */
  function storedFilesOf(row: CaptureRow): string[] {
    const files: string[] = [];
    if (row.contentStorage === 'file' && row.contentPath) files.push(row.contentPath);
    if (row.originalPath) files.push(row.originalPath);
    const shard = path.join(contentRoot, row.id.slice(0, 2) || '00', row.id.slice(2, 4) || '00');
    try {
      for (const name of readdirSync(shard)) if (name.startsWith(`${row.id}-`)) files.push(path.join(shard, name));
    } catch { /* no shard directory */ }
    return [...new Set(files)].filter(insideContentDir);
  }

  function removeFiles(files: string[], result: RawCaptureRepairResult): void {
    for (const file of files) {
      if (!insideContentDir(file)) continue;
      let size = 0;
      try { size = statSync(file).size; } catch { continue; }
      try {
        unlinkSync(file);
        result.filesRemoved++;
        result.bytesRemoved += size;
      } catch { /* left for a later cleanup */ }
    }
  }

  function folderFor(filePath: string, folders: Array<{ id: number; path: string }>): { id: number; path: string } | null {
    return folders
      .filter((folder) => filePath.startsWith(folder.path.endsWith(path.sep) ? folder.path : folder.path + path.sep))
      .sort((a, b) => b.path.length - a.path.length)[0] ?? null;
  }

  /**
   * Queue one fresh capture of a watched file, unless the owner or the
   * credential gate decided it. A big file goes to the owner's big-file
   * review instead (owner decision D7), like a resumed file that grew.
   */
  function queueRecapture(filePath: string, folders: Array<{ id: number; path: string }>): boolean {
    const folder = folderFor(path.resolve(filePath), folders);
    if (!folder || !existsSync(filePath)) return false;
    const held = ledger.get(folder.id, filePath);
    if (held && HELD_OUTCOMES.has(held.outcome)) return false;
    let size: number;
    let mtimeMs: number;
    try {
      const stat = statSync(filePath);
      if (!stat.isFile()) return false;
      size = stat.size;
      mtimeMs = stat.mtimeMs;
    } catch {
      return false;
    }
    const outcome = size >= bigFileBytes ? 'needs_review' : 'approved';
    ledger.record({ folderId: folder.id, path: filePath, size, mtimeMs, outcome, origin: 'import', reason: RAW_RECAPTURE_REASON });
    return true;
  }

  /** Delete one file's raw rows and queue its re-capture. Runs inside a transaction; returns content files. */
  function repairFile(filePath: string, rows: CaptureRow[], raw: CaptureRow[], folders: Array<{ id: number; path: string }>, result: RawCaptureRepairResult): string[] {
    const kept = rows.find((row) => !raw.includes(row))?.id ?? null;
    const files: string[] = [];
    for (const row of raw) {
      files.push(...storedFilesOf(row));
      deleteWorkItemFts(db, row.id);
      unlink.nodeLinks.run(row.id);
      unlink.todos.run(kept, row.id);
      unlink.crossLinks.run(kept, row.id);
      unlink.ocr.run(row.id);
      unlink.failures.run(row.id);
      unlink.routing.run(row.id);
      unlink.reads.run(row.id);
      result.deleted += unlink.item.run(row.id).changes;
    }
    // The newest capture held bytes: BotBoy has never read this version's text.
    if (raw.includes(rows[0]) && queueRecapture(filePath, folders)) result.recaptures++;
    return files;
  }

  return {
    isDone,

    async run(opts = {}) {
      const result: RawCaptureRepairResult = { done: false, deleted: 0, recaptures: 0, deferred: 0, filesRemoved: 0, bytesRemoved: 0 };
      if (isDone()) return { ...result, done: true };
      const signal = opts.signal;

      const byPath = new Map<string, CaptureRow[]>();
      let scanned = 0;
      for (const row of capturesStmt.all() as CaptureRow[]) {
        if (!row.filePath) continue;
        if (!byPath.has(row.filePath)) byPath.set(row.filePath, []);
        byPath.get(row.filePath)!.push(row);
      }
      const folders = (watchedFolders.all() as Array<{ id: number; path: string }>).map((folder) => ({ id: folder.id, path: path.resolve(folder.path) }));

      for (const [filePath, unsorted] of byPath) {
        if (signal?.aborted) return { ...result, aborted: true };
        const rows = [...unsorted].sort(newestFirst);
        const raw = rows.filter((row) => isPdfBytes(headOf(row)));
        if (++scanned % 200 === 0) await yieldToLoop();
        if (raw.length === 0) continue;
        if (raw.some(inFlight)) { result.deferred++; continue; }
        const files = watchdog.measure(WATCHDOG_LABEL, () => db.transaction(() => repairFile(filePath, rows, raw, folders, result))());
        removeFiles(files, result);
        await yieldToLoop();
      }

      if (result.deleted > 0 || result.deferred > 0) {
        console.log(
          `[raw-capture-repair] PDFs stored as raw bytes ${result.deferred > 0 ? 'partly repaired' : 'repaired'}: `
          + `${result.deleted} captures deleted, ${result.recaptures} watched files queued for a fresh capture, `
          + `${result.filesRemoved} content files removed (${(result.bytesRemoved / 1048576).toFixed(1)} MB)`
          + `${result.deferred ? `, ${result.deferred} waiting for extraction or routing` : ''}`,
        );
      }
      if (result.deferred > 0) return result;
      const { done: _done, aborted: _aborted, ...counts } = result;
      setSetting(db, RAW_CAPTURE_REPAIR_KEY, { doneAt: now().toISOString(), ...counts });
      return { ...result, done: true };
    },
  };
}
