/**
 * Local-folder import ledger (LOCAL_FOLDER_IMPORT_SAFETY_PLAN.md C2/C8).
 *
 * One durable row per (watched folder, file path) that BotBoy has handed to
 * capture during a folder import, or is holding for the owner. The ledger
 * makes folder imports resumable and idempotent (an unchanged file is never
 * handed to capture twice, even across restarts) and records the big-file
 * review: files at or above the big-file threshold wait as `needs_review`
 * until the owner keeps (`approved`) or excludes them. Files above the import
 * ceiling are recorded as `too_large`, so the owner can see they exist even
 * though BotBoy cannot import them yet.
 *
 * The ledger never stores file content; it holds path, size, mtime, outcome,
 * and origin only. Exclusions themselves live in the folder's `exclude_globs`
 * (literal path entries built by `literalGlobForPath`), so live watching and
 * imports honor them through one mechanism; an `excluded` row is only the
 * review list's memory of that choice.
 */

import path from 'path';
import type Database from 'better-sqlite3';
import { getSetting, migrateLocalFolderImports, setSetting } from './storage.js';

/** Files at or above this size wait for an owner decision before import. */
export const DEFAULT_BIG_FILE_BYTES = 25 * 1024 * 1024;
/** Folder imports pause while free space is below this floor. */
export const DEFAULT_IMPORT_MIN_FREE_BYTES = 10 * 1024 ** 3;
/** Live folder captures pause while free space is below this floor. */
export const DEFAULT_LIVE_MIN_FREE_BYTES = 2 * 1024 ** 3;

/** Types BotBoy's document parser reads; the review list defaults these to keep. */
export const READABLE_EXTENSIONS: ReadonlySet<string> = new Set([
  '.pdf', '.docx', '.xlsx', '.pptx', '.txt', '.md', '.csv', '.json',
]);

function positiveBytesFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    console.warn(`[local-folder-imports] Invalid ${name}=${raw}; using ${fallback}`);
    return fallback;
  }
  return parsed;
}

export interface FolderImportThresholds {
  bigFileBytes: number;
  importMinFreeBytes: number;
  liveMinFreeBytes: number;
}

/** Effective thresholds, with env overrides for power users and tests. */
export function folderImportThresholds(): FolderImportThresholds {
  return {
    bigFileBytes: positiveBytesFromEnv('LOCAL_FOLDERS_BIG_FILE_BYTES', DEFAULT_BIG_FILE_BYTES),
    importMinFreeBytes: positiveBytesFromEnv('LOCAL_FOLDERS_IMPORT_MIN_FREE_BYTES', DEFAULT_IMPORT_MIN_FREE_BYTES),
    liveMinFreeBytes: positiveBytesFromEnv('LOCAL_FOLDERS_LIVE_MIN_FREE_BYTES', DEFAULT_LIVE_MIN_FREE_BYTES),
  };
}

export const FOLDER_FILE_OUTCOMES = [
  'imported',
  'needs_review',
  'approved',
  'excluded',
  'too_large',
  'deferred_low_disk',
] as const;

export type FolderFileOutcome = typeof FOLDER_FILE_OUTCOMES[number];
/** `import` = found by a folder walk; `live` = a watched change. */
export type FolderFileOrigin = 'import' | 'live';

export interface FolderFileRecord {
  folderId: number;
  path: string;
  size: number;
  mtimeMs: number;
  outcome: FolderFileOutcome;
  origin: FolderFileOrigin;
  updatedAt: number;
}

export type FolderFileCounts = Record<FolderFileOutcome, number>;

export interface LocalFolderImportLedger {
  get(folderId: number, filePath: string): FolderFileRecord | undefined;
  /** Upsert one row. `origin` defaults to the existing row's, else `import`. */
  record(entry: Omit<FolderFileRecord, 'updatedAt' | 'origin'> & { origin?: FolderFileOrigin }): void;
  setOutcome(folderId: number, filePath: string, outcome: FolderFileOutcome): boolean;
  remove(folderId: number, filePath: string): boolean;
  /** Rows for one folder, optionally limited to outcomes and a minimum size (filtered in SQL). */
  list(folderId: number, outcomes?: readonly FolderFileOutcome[], minSize?: number): FolderFileRecord[];
  counts(folderId: number): FolderFileCounts;
  /** Every row for one folder, keyed by path (one query per walk). */
  forFolder(folderId: number): Map<string, FolderFileRecord>;
  /** Mark every held row under `dir` as excluded; returns rows changed. */
  excludeUnder(folderId: number, dir: string): number;
  /** Rows under `dir` whose outcome is one of `outcomes`. */
  listUnder(folderId: number, dir: string, outcomes: readonly FolderFileOutcome[]): FolderFileRecord[];
  removeFolder(folderId: number): void;
}

interface LedgerRow {
  folder_id: number;
  path: string;
  size: number;
  mtime_ms: number;
  outcome: FolderFileOutcome;
  origin: FolderFileOrigin;
  updated_at: number;
}

function toRecord(row: LedgerRow): FolderFileRecord {
  return {
    folderId: Number(row.folder_id),
    path: String(row.path),
    size: Number(row.size),
    mtimeMs: Number(row.mtime_ms),
    outcome: row.outcome,
    origin: row.origin === 'live' ? 'live' : 'import',
    updatedAt: Number(row.updated_at),
  };
}

function emptyCounts(): FolderFileCounts {
  return Object.fromEntries(FOLDER_FILE_OUTCOMES.map(outcome => [outcome, 0])) as FolderFileCounts;
}

function dirPrefix(dir: string): string {
  return dir.endsWith(path.sep) ? dir : dir + path.sep;
}

export function createLocalFolderImportLedger(db: Database.Database, now: () => number = Date.now): LocalFolderImportLedger {
  // Idempotent DDL so a monitor built on any initialized DB owns a ledger.
  migrateLocalFolderImports(db);
  const getStmt = db.prepare('SELECT * FROM local_folder_imports WHERE folder_id = ? AND path = ?');
  const upsertStmt = db.prepare(`
    INSERT INTO local_folder_imports (folder_id, path, size, mtime_ms, outcome, origin, updated_at)
    VALUES (@folderId, @path, @size, @mtimeMs, @outcome, COALESCE(@origin, 'import'), @updatedAt)
    ON CONFLICT(folder_id, path) DO UPDATE SET
      size = excluded.size, mtime_ms = excluded.mtime_ms, outcome = excluded.outcome,
      origin = COALESCE(@origin, local_folder_imports.origin), updated_at = excluded.updated_at
  `);
  const setOutcomeStmt = db.prepare('UPDATE local_folder_imports SET outcome = ?, updated_at = ? WHERE folder_id = ? AND path = ?');
  const removeStmt = db.prepare('DELETE FROM local_folder_imports WHERE folder_id = ? AND path = ?');
  const listAllStmt = db.prepare('SELECT * FROM local_folder_imports WHERE folder_id = ? ORDER BY path');
  const countsStmt = db.prepare('SELECT outcome, COUNT(*) AS n FROM local_folder_imports WHERE folder_id = ? GROUP BY outcome');
  const excludeUnderStmt = db.prepare(`
    UPDATE local_folder_imports SET outcome = 'excluded', updated_at = ?
    WHERE folder_id = ? AND substr(path, 1, ?) = ? AND outcome IN ('needs_review','approved','deferred_low_disk')
  `);
  const listUnderStmt = db.prepare('SELECT * FROM local_folder_imports WHERE folder_id = ? AND substr(path, 1, ?) = ? ORDER BY path');
  const removeFolderStmt = db.prepare('DELETE FROM local_folder_imports WHERE folder_id = ?');
  const listByOutcomeStmts = new Map<string, Database.Statement>();

  return {
    get(folderId, filePath) {
      const row = getStmt.get(folderId, filePath) as LedgerRow | undefined;
      return row ? toRecord(row) : undefined;
    },
    record(entry) {
      upsertStmt.run({
        folderId: entry.folderId,
        path: entry.path,
        size: entry.size,
        mtimeMs: entry.mtimeMs,
        outcome: entry.outcome,
        origin: entry.origin ?? null,
        updatedAt: now(),
      });
    },
    setOutcome(folderId, filePath, outcome) {
      return setOutcomeStmt.run(outcome, now(), folderId, filePath).changes > 0;
    },
    remove(folderId, filePath) {
      return removeStmt.run(folderId, filePath).changes > 0;
    },
    list(folderId, outcomes, minSize = 0) {
      if (!outcomes) return (listAllStmt.all(folderId) as LedgerRow[]).map(toRecord).filter(row => row.size >= minSize);
      const wanted = outcomes.filter(outcome => (FOLDER_FILE_OUTCOMES as readonly string[]).includes(outcome));
      if (wanted.length === 0) return [];
      const key = wanted.join(',');
      let stmt = listByOutcomeStmts.get(key);
      if (!stmt) {
        stmt = db.prepare(`SELECT * FROM local_folder_imports WHERE folder_id = ? AND outcome IN (${wanted.map(() => '?').join(',')}) AND size >= ? ORDER BY path`);
        listByOutcomeStmts.set(key, stmt);
      }
      return (stmt.all(folderId, ...wanted, minSize) as LedgerRow[]).map(toRecord);
    },
    counts(folderId) {
      const counts = emptyCounts();
      for (const row of countsStmt.all(folderId) as Array<{ outcome: FolderFileOutcome; n: number }>) {
        if (row.outcome in counts) counts[row.outcome] = Number(row.n);
      }
      return counts;
    },
    forFolder(folderId) {
      const map = new Map<string, FolderFileRecord>();
      for (const row of listAllStmt.all(folderId) as LedgerRow[]) map.set(row.path, toRecord(row));
      return map;
    },
    excludeUnder(folderId, dir) {
      const prefix = dirPrefix(dir);
      return excludeUnderStmt.run(now(), folderId, prefix.length, prefix).changes;
    },
    listUnder(folderId, dir, outcomes) {
      const prefix = dirPrefix(dir);
      return (listUnderStmt.all(folderId, prefix.length, prefix) as LedgerRow[])
        .map(toRecord)
        .filter(row => outcomes.includes(row.outcome));
    },
    removeFolder(folderId) {
      removeFolderStmt.run(folderId);
    },
  };
}

// ── First-import marker ────────────────────────────────────────────────────

/** Settings key recording that a folder's first import completed. */
export function firstImportMarkerKey(folderId: number): string {
  return `local_folders.backfilled.${folderId}`;
}

export function isFirstImportDone(db: Database.Database, folderId: number): boolean {
  return getSetting<boolean>(db, firstImportMarkerKey(folderId)) === true;
}

export function markFirstImportDone(db: Database.Database, folderId: number): void {
  setSetting(db, firstImportMarkerKey(folderId), true);
}

/** Clearing the marker makes the scheduler walk the folder again (idempotently). */
export function clearFirstImportDone(db: Database.Database, folderId: number): void {
  db.prepare('DELETE FROM app_settings WHERE key = ?').run(firstImportMarkerKey(folderId));
}

// ── Existing captures ──────────────────────────────────────────────────────

/**
 * Unchanged-capture signatures for files already captured under `rootPath`
 * (before the ledger existed, or by live watching). A walk skips a file whose
 * path, size, and mtime match one of these. Rows whose content was
 * deliberately removed (`metadata.contentRemoved`) are excluded, so a file
 * the owner later keeps is captured again rather than silently skipped.
 */
export function existingCaptureSignatures(db: Database.Database, rootPath: string): Set<string> {
  const prefix = dirPrefix(rootPath);
  const rows = db.prepare(`
    SELECT file_path,
           CASE WHEN json_valid(metadata) THEN json_extract(metadata, '$.size') END AS size,
           CASE WHEN json_valid(metadata) THEN json_extract(metadata, '$.mtime') END AS mtime,
           CASE WHEN json_valid(metadata) THEN json_extract(metadata, '$.contentRemoved') END AS removed
    FROM work_items
    WHERE source = 'filesystem' AND file_path IS NOT NULL AND substr(file_path, 1, ?) = ?
  `).all(prefix.length, prefix) as Array<{ file_path: string; size: unknown; mtime: unknown; removed: unknown }>;
  const signatures = new Set<string>();
  for (const row of rows) {
    if (row.removed != null) continue;
    if (row.size == null || row.mtime == null) continue;
    signatures.add(captureSignature(row.file_path, String(row.size), String(row.mtime)));
  }
  return signatures;
}

/** Paths under `rootPath` whose captured content was removed to free space. */
export function contentRemovedPaths(db: Database.Database, rootPath: string): Set<string> {
  const prefix = dirPrefix(rootPath);
  const rows = db.prepare(`
    SELECT file_path FROM work_items
    WHERE source = 'filesystem' AND file_path IS NOT NULL AND substr(file_path, 1, ?) = ?
      AND json_valid(metadata) AND json_extract(metadata, '$.contentRemoved') IS NOT NULL
  `).all(prefix.length, prefix) as Array<{ file_path: string }>;
  return new Set(rows.map(row => row.file_path));
}

/** Signature compared with a monitor capture's `metadata.size` / `metadata.mtime`. */
export function captureSignature(filePath: string, size: string, mtime: string): string {
  return `${filePath}\u0000${size}\u0000${mtime}`;
}

// ── Literal exclusion globs ────────────────────────────────────────────────

/**
 * Glob entry that matches exactly one absolute path in the folder monitor's
 * glob dialect (`**`, `*`, `?`; every other character literal; a backslash
 * escapes `*`, `?`, and itself).
 */
export function literalGlobForPath(filePath: string): string {
  return filePath.replace(/[\\*?]/g, ch => `\\${ch}`);
}

/** Glob entry that excludes everything under one directory. */
export function directoryGlobForPath(dirPath: string): string {
  const trimmed = dirPath.length > 1 && dirPath.endsWith(path.sep) ? dirPath.slice(0, -1) : dirPath;
  return `${literalGlobForPath(trimmed)}/**`;
}

/**
 * Inverse of `literalGlobForPath` / `directoryGlobForPath`: returns the
 * literal absolute path (and whether it names a directory), or `null` for
 * any glob containing an unescaped wildcard or naming a relative path.
 * Owner-written patterns therefore stay untouched by review decisions.
 */
export function parseLiteralGlob(glob: string): { path: string; directory: boolean } | null {
  let body = glob;
  let directory = false;
  if (body.endsWith('/**')) {
    directory = true;
    body = body.slice(0, -3);
  }
  let out = '';
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === '\\' && i + 1 < body.length && '\\*?'.includes(body[i + 1])) {
      out += body[i + 1];
      i++;
      continue;
    }
    if (ch === '*' || ch === '?') return null;
    out += ch;
  }
  if (!path.isAbsolute(out)) return null;
  return { path: out, directory };
}
