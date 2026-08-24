/**
 * Content Store — the single, integrity-guaranteed access point for a work
 * item's full captured content (lossless-capture-brain-pipeline spec).
 *
 * Content at or below `inlineThresholdBytes` (default 32 KB) is stored inline
 * in the `work_items.raw_text` column; larger content is written atomically to
 * a file under the content directory and referenced by the row. Consumers never
 * need to know which path was taken — they call `get(ref)` and receive the
 * complete content or a thrown `ContentIntegrityError`. Nothing truncates.
 *
 * Guarantees (design Correctness Properties P1–P4):
 *   - Lossless round-trip: get(put(x)) === x for any x, any size.
 *   - Integrity or error: get() verifies sha256 + byte length and throws on
 *     missing/short/corrupt content — never returns partial/empty content.
 *   - No dangling references: verifyAll() detects missing/corrupt file blobs.
 *   - Storage transparency: inline vs file is invisible to callers.
 */

import { createHash } from 'crypto';
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  renameSync,
  existsSync,
  unlinkSync,
  openSync,
  fsyncSync,
  closeSync,
  copyFileSync,
} from 'fs';
import path from 'path';
import os from 'os';
import type Database from 'better-sqlite3';

// ── Types ────────────────────────────────────────────────────────────────

export interface ContentRef {
  storage: 'inline' | 'file';
  inlineText?: string; // present when storage === 'inline'
  filePath?: string; // absolute path, present when storage === 'file'
  sha256: string; // integrity checksum of the full content
  byteLength: number; // full content length in bytes (utf8)
  encoding: 'utf8';
}

export interface ContentStore {
  /** Store content, returning the ref to persist on the row. Never truncates. */
  put(itemId: string, content: string): ContentRef;
  /**
   * Store AUXILIARY content (e.g. the raw page HTML that accompanies a
   * browser capture's readable text). Always file-backed regardless of size —
   * aux refs live in item metadata, not row columns, so inlining would bloat
   * every metadata parse. Same atomic-write + integrity guarantees as put().
   */
  putAux(itemId: string, suffix: string, content: string): ContentRef;
  /** Return the full content; throws ContentIntegrityError on any mismatch. */
  get(ref: ContentRef): string;
  /** Non-throwing integrity probe. */
  verify(ref: ContentRef): { ok: true } | { ok: false; reason: string };
  /** Sweep every file-backed work_items row; report missing/corrupt blobs. */
  verifyAll(): { checked: number; missing: string[]; corrupt: string[] };
  /** Copy an original source file (image/binary) for future re-processing. */
  storeOriginal(itemId: string, sourcePath: string): string;
  /** Reconstruct a ref from persisted row columns. */
  refFromRow(row: ContentRowColumns): ContentRef | null;
}

/** The subset of work_items columns the store reads/writes. */
export interface ContentRowColumns {
  raw_text: string | null;
  content_storage: string | null;
  content_path: string | null;
  content_sha256: string | null;
  content_bytes: number | null;
}

export class ContentIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ContentIntegrityError';
  }
}

export interface ContentStoreConfig {
  /** Root directory for file-backed content + originals. */
  contentDir?: string;
  /** Inline vs file cutoff in bytes (default 32 KB). */
  inlineThresholdBytes?: number;
}

const DEFAULT_CONTENT_DIR = path.join(os.homedir(), '.personal-productivity-tracker', 'content');
const DEFAULT_INLINE_THRESHOLD = 32 * 1024; // 32 KB (see design)

function sha256Hex(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

// ── Factory ────────────────────────────────────────────────────────────────

export function createContentStore(
  db: Database.Database,
  config?: ContentStoreConfig,
): ContentStore {
  const contentDir = config?.contentDir ?? DEFAULT_CONTENT_DIR;
  const inlineThreshold = config?.inlineThresholdBytes ?? DEFAULT_INLINE_THRESHOLD;
  const originalsDir = path.join(contentDir, 'originals');

  function blobPathFor(itemId: string): string {
    // Shard by capture time bucket is nice, but itemId alone is stable and
    // collision-free; nest two levels by id prefix to avoid huge flat dirs.
    const a = itemId.slice(0, 2) || '00';
    const b = itemId.slice(2, 4) || '00';
    return path.join(contentDir, a, b, `${itemId}.txt`);
  }

  /** Atomic write: temp file → fsync → rename (design §Content Store, R2.8). */
  function atomicWrite(targetPath: string, data: string): void {
    mkdirSync(path.dirname(targetPath), { recursive: true });
    const tmpPath = path.join(
      path.dirname(targetPath),
      `.${path.basename(targetPath)}.tmp-${process.pid}-${Date.now()}`,
    );
    writeFileSync(tmpPath, data, 'utf8');
    // fsync the file contents before rename so a crash can't leave a
    // rename-visible-but-empty blob.
    const fd = openSync(tmpPath, 'r');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmpPath, targetPath);
  }

  return {
    put(itemId: string, content: string): ContentRef {
      const byteLength = Buffer.byteLength(content, 'utf8');
      const sha256 = sha256Hex(content);

      if (byteLength <= inlineThreshold) {
        return { storage: 'inline', inlineText: content, sha256, byteLength, encoding: 'utf8' };
      }

      const filePath = blobPathFor(itemId);
      atomicWrite(filePath, content);
      return { storage: 'file', filePath, sha256, byteLength, encoding: 'utf8' };
    },

    putAux(itemId: string, suffix: string, content: string): ContentRef {
      const byteLength = Buffer.byteLength(content, 'utf8');
      const sha256 = sha256Hex(content);
      const filePath = blobPathFor(`${itemId}-${suffix}`);
      atomicWrite(filePath, content);
      return { storage: 'file', filePath, sha256, byteLength, encoding: 'utf8' };
    },

    get(ref: ContentRef): string {
      let content: string;
      if (ref.storage === 'inline') {
        if (ref.inlineText == null) {
          throw new ContentIntegrityError('inline ref missing inlineText');
        }
        content = ref.inlineText;
      } else {
        if (!ref.filePath) {
          throw new ContentIntegrityError('file ref missing filePath');
        }
        if (!existsSync(ref.filePath)) {
          throw new ContentIntegrityError(`content file missing: ${ref.filePath}`);
        }
        content = readFileSync(ref.filePath, 'utf8');
      }

      const actualBytes = Buffer.byteLength(content, 'utf8');
      if (actualBytes !== ref.byteLength) {
        throw new ContentIntegrityError(
          `byte length mismatch (expected ${ref.byteLength}, got ${actualBytes})` +
            (ref.filePath ? ` for ${ref.filePath}` : ''),
        );
      }
      const actualSha = sha256Hex(content);
      if (actualSha !== ref.sha256) {
        throw new ContentIntegrityError(
          `sha256 mismatch (expected ${ref.sha256}, got ${actualSha})` +
            (ref.filePath ? ` for ${ref.filePath}` : ''),
        );
      }
      return content;
    },

    verify(ref: ContentRef): { ok: true } | { ok: false; reason: string } {
      try {
        this.get(ref);
        return { ok: true };
      } catch (err) {
        return { ok: false, reason: (err as Error).message };
      }
    },

    verifyAll(): { checked: number; missing: string[]; corrupt: string[] } {
      const rows = db
        .prepare(
          `SELECT id, raw_text, content_storage, content_path, content_sha256, content_bytes
           FROM work_items WHERE content_storage = 'file'`,
        )
        .all() as (ContentRowColumns & { id: string })[];

      const missing: string[] = [];
      const corrupt: string[] = [];
      for (const row of rows) {
        const ref = this.refFromRow(row);
        if (!ref) {
          corrupt.push(row.id);
          continue;
        }
        const result = this.verify(ref);
        if (!result.ok) {
          if (result.reason.includes('missing')) missing.push(row.id);
          else corrupt.push(row.id);
        }
      }
      return { checked: rows.length, missing, corrupt };
    },

    storeOriginal(itemId: string, sourcePath: string): string {
      if (!existsSync(sourcePath)) {
        throw new ContentIntegrityError(`original source missing: ${sourcePath}`);
      }
      const ext = path.extname(sourcePath);
      const dest = path.join(originalsDir, `${itemId}${ext}`);
      mkdirSync(path.dirname(dest), { recursive: true });
      copyFileSync(sourcePath, dest);
      return dest;
    },

    refFromRow(row: ContentRowColumns): ContentRef | null {
      if (row.content_sha256 == null || row.content_bytes == null) return null;
      if (row.content_storage === 'file') {
        if (!row.content_path) return null;
        return {
          storage: 'file',
          filePath: row.content_path,
          sha256: row.content_sha256,
          byteLength: row.content_bytes,
          encoding: 'utf8',
        };
      }
      // inline
      return {
        storage: 'inline',
        inlineText: row.raw_text ?? '',
        sha256: row.content_sha256,
        byteLength: row.content_bytes,
        encoding: 'utf8',
      };
    },
  };
}

/** Map a ContentRef onto the persistable work_items columns. */
export function refToColumns(ref: ContentRef): ContentRowColumns {
  return {
    raw_text: ref.storage === 'inline' ? (ref.inlineText ?? '') : null,
    content_storage: ref.storage,
    content_path: ref.storage === 'file' ? (ref.filePath ?? null) : null,
    content_sha256: ref.sha256,
    content_bytes: ref.byteLength,
  };
}

/** Best-effort cleanup of a file-backed blob (used when an item is purged). */
export function deleteBlob(ref: ContentRef): void {
  if (ref.storage === 'file' && ref.filePath && existsSync(ref.filePath)) {
    try {
      unlinkSync(ref.filePath);
    } catch {
      /* best-effort */
    }
  }
}
