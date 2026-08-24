import os from 'os';
import path from 'path';
import fs from 'fs';
import type Database from 'better-sqlite3';

// ── Types ──────────────────────────────────────────────────────────────────

/**
 * A persisted row from the `local_folders` table, parsed into TypeScript-native
 * shapes (booleans for the 0/1 columns; arrays for the JSON-serialized glob
 * columns).
 */
export interface LocalFolder {
  id: number;
  path: string;
  recursive: boolean;
  include_globs: string[];
  exclude_globs: string[];
  enabled: boolean;
  created_at: number;
  updated_at: number;
}

/**
 * Inputs accepted by `addLocalFolder`. Only `path` is required; the rest match
 * the schema defaults if omitted.
 */
export interface AddLocalFolderInput {
  path: string;
  recursive?: boolean;
  include_globs?: string[];
  exclude_globs?: string[];
  enabled?: boolean;
}

/**
 * Discriminated union returned by `addLocalFolder`. The route layer maps the
 * `code` to an HTTP status (`not_found`/`not_dir` → 400, `outside_home` → 400,
 * `duplicate` → 409) without needing a try/catch tower.
 */
export type AddLocalFolderResult =
  | { ok: true; folder: LocalFolder }
  | {
      ok: false;
      code: 'not_found' | 'not_dir' | 'outside_home' | 'duplicate';
      message: string;
    };

/**
 * Discriminated union returned by `updateLocalFolder`. `not_found` covers a
 * missing row; `invalid` covers payloads where every field was rejected by the
 * patch validator (e.g. non-string entries in `include_globs`).
 */
export type UpdateLocalFolderResult =
  | { ok: true; folder: LocalFolder }
  | { ok: false; code: 'not_found' | 'invalid'; message: string };

// ── Path helpers ───────────────────────────────────────────────────────────

/**
 * Expand a leading `~/` to the user's home directory. Anything else (absolute
 * paths, relative paths, paths with `~` not at position 0) passes through
 * untouched so the caller keeps full control.
 */
export function expandTilde(p: string): string {
  if (typeof p !== 'string') return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

// ── Internal helpers ───────────────────────────────────────────────────────

/**
 * Parse a JSON-encoded TEXT column expected to hold a `string[]`. On any
 * parse/shape failure return `[]` and warn-log so a corrupt cell doesn't kill
 * the whole list query (matches the slack-config pattern).
 */
function parseGlobsField(raw: unknown, columnName: string, rowId: unknown): string[] {
  if (typeof raw !== 'string') return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      console.warn(
        `[local-folders-config] ${columnName} for row ${String(rowId)} is not a JSON array; defaulting to []`,
      );
      return [];
    }
    // Drop non-string entries silently — the column contract is string[].
    return parsed.filter((s): s is string => typeof s === 'string');
  } catch (err) {
    console.warn(
      `[local-folders-config] Failed to parse ${columnName} JSON for row ${String(rowId)}:`,
      (err as Error).message,
    );
    return [];
  }
}

/**
 * Convert a raw `local_folders` row (columns of type INTEGER/TEXT) into the
 * TypeScript-native `LocalFolder` shape.
 */
function rowToFolder(row: any): LocalFolder {
  return {
    id: Number(row.id),
    path: String(row.path),
    recursive: row.recursive === 1 || row.recursive === true,
    include_globs: parseGlobsField(row.include_globs, 'include_globs', row.id),
    exclude_globs: parseGlobsField(row.exclude_globs, 'exclude_globs', row.id),
    enabled: row.enabled === 1 || row.enabled === true,
    created_at: Number(row.created_at),
    updated_at: Number(row.updated_at),
  };
}

/**
 * Validate that every entry in an unknown value is a non-empty string.
 * Returns `null` when the input is `undefined` (caller treats as "not
 * provided"), `false` when validation fails, or the cleaned array otherwise.
 */
function validateGlobs(value: unknown): string[] | null | false {
  if (value === undefined) return null;
  if (!Array.isArray(value)) return false;
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string') return false;
    if (entry.length === 0) continue;
    out.push(entry);
  }
  return out;
}

// ── Read helpers ───────────────────────────────────────────────────────────

/**
 * Return every persisted folder, optionally filtered to the enabled-only
 * subset. Order is by `id` ASC so callers (UI list, FilesystemMonitor) see a
 * stable ordering across calls.
 */
export function listLocalFolders(
  db: Database.Database,
  opts?: { enabledOnly?: boolean },
): LocalFolder[] {
  const sql = opts?.enabledOnly
    ? `SELECT id, path, recursive, include_globs, exclude_globs, enabled, created_at, updated_at
       FROM local_folders WHERE enabled = 1 ORDER BY id ASC`
    : `SELECT id, path, recursive, include_globs, exclude_globs, enabled, created_at, updated_at
       FROM local_folders ORDER BY id ASC`;
  const rows = db.prepare(sql).all() as any[];
  return rows.map(rowToFolder);
}

/**
 * Return a single folder by id, or `null` if no such row exists.
 */
export function getLocalFolder(db: Database.Database, id: number): LocalFolder | null {
  const row = db
    .prepare(
      `SELECT id, path, recursive, include_globs, exclude_globs, enabled, created_at, updated_at
       FROM local_folders WHERE id = ?`,
    )
    .get(id) as any;
  return row ? rowToFolder(row) : null;
}

// ── Write helpers ──────────────────────────────────────────────────────────

/**
 * Persist a new watched folder after the 6-step validation chain:
 *   1. Expand `~/` to the user's home directory.
 *   2. Canonicalize via `fs.realpathSync` so symlinks are resolved.
 *   3. Reject paths that don't exist (`not_found`).
 *   4. Reject paths that aren't directories (`not_dir`).
 *   5. Reject paths that escape `$HOME` (`outside_home`).
 *   6. Insert; on UNIQUE conflict return `duplicate`.
 *
 * The caller (the route layer) maps the four error codes to HTTP statuses.
 */
export function addLocalFolder(
  db: Database.Database,
  input: AddLocalFolderInput,
): AddLocalFolderResult {
  if (!input || typeof input.path !== 'string' || input.path.length === 0) {
    return { ok: false, code: 'not_found', message: 'path must be a non-empty string' };
  }

  // 1. Tilde expansion.
  let candidate = expandTilde(input.path);

  // 2. Canonicalize. `realpathSync` throws on missing paths, which we treat as
  //    `not_found` so the caller doesn't have to distinguish realpath ENOENT
  //    from a deferred existsSync miss.
  let canonical: string;
  try {
    canonical = fs.realpathSync(candidate);
  } catch {
    return {
      ok: false,
      code: 'not_found',
      message: `Path does not exist: ${input.path}`,
    };
  }

  // 3. Defensive existsSync — in practice realpathSync would have already
  //    thrown, but a TOCTOU race between realpath and stat is still possible.
  if (!fs.existsSync(canonical)) {
    return {
      ok: false,
      code: 'not_found',
      message: `Path does not exist: ${input.path}`,
    };
  }

  // 4. Directory check.
  let stat: fs.Stats;
  try {
    stat = fs.statSync(canonical);
  } catch {
    return {
      ok: false,
      code: 'not_found',
      message: `Path does not exist: ${input.path}`,
    };
  }
  if (!stat.isDirectory()) {
    return {
      ok: false,
      code: 'not_dir',
      message: `Path is not a directory: ${input.path}`,
    };
  }

  // 5. Inside-home guard. We compare against `$HOME + path.sep` so a folder
  //    named `${HOME}-other` can't slip through a prefix-match.
  const homePrefix = os.homedir().endsWith(path.sep)
    ? os.homedir()
    : os.homedir() + path.sep;
  if (canonical !== os.homedir() && !canonical.startsWith(homePrefix)) {
    return {
      ok: false,
      code: 'outside_home',
      message: `Path is outside the user home directory: ${canonical}`,
    };
  }

  // 6. Insert.
  const now = Date.now();
  const recursive = input.recursive === false ? 0 : 1;
  const enabled = input.enabled === false ? 0 : 1;
  const includeGlobs = JSON.stringify(
    Array.isArray(input.include_globs)
      ? input.include_globs.filter((s): s is string => typeof s === 'string')
      : [],
  );
  const excludeGlobs = JSON.stringify(
    Array.isArray(input.exclude_globs)
      ? input.exclude_globs.filter((s): s is string => typeof s === 'string')
      : [],
  );

  let result: Database.RunResult;
  try {
    result = db
      .prepare(
        `INSERT INTO local_folders
           (path, recursive, include_globs, exclude_globs, enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(canonical, recursive, includeGlobs, excludeGlobs, enabled, now, now);
  } catch (err: any) {
    const msg = String(err?.message ?? '');
    // better-sqlite3 surfaces unique-constraint violations as
    // SqliteError with code 'SQLITE_CONSTRAINT_UNIQUE' or
    // a generic 'SQLITE_CONSTRAINT' depending on version.
    if (
      err?.code === 'SQLITE_CONSTRAINT_UNIQUE' ||
      msg.includes('UNIQUE constraint failed')
    ) {
      return {
        ok: false,
        code: 'duplicate',
        message: `Folder is already registered: ${canonical}`,
      };
    }
    throw err;
  }

  const inserted = getLocalFolder(db, Number(result.lastInsertRowid));
  if (!inserted) {
    // Shouldn't happen — INSERT succeeded but SELECT failed. Surface as
    // not_found so callers don't get a silent null.
    return {
      ok: false,
      code: 'not_found',
      message: `Inserted folder could not be re-read (id=${String(result.lastInsertRowid)})`,
    };
  }
  return { ok: true, folder: inserted };
}

/**
 * Update an existing folder. `path` is intentionally not patchable — users
 * delete + re-add to relocate so the realpath canonicalization path runs
 * fresh. Unknown ids return `not_found`; payloads with no patchable fields
 * after validation return `invalid`.
 */
export function updateLocalFolder(
  db: Database.Database,
  id: number,
  patch: Partial<AddLocalFolderInput>,
): UpdateLocalFolderResult {
  const existing = getLocalFolder(db, id);
  if (!existing) {
    return { ok: false, code: 'not_found', message: `No folder with id ${id}` };
  }

  if (!patch || typeof patch !== 'object') {
    return { ok: false, code: 'invalid', message: 'patch must be an object' };
  }

  const sets: string[] = [];
  const params: any[] = [];

  if (patch.recursive !== undefined) {
    if (typeof patch.recursive !== 'boolean') {
      return { ok: false, code: 'invalid', message: 'recursive must be a boolean' };
    }
    sets.push('recursive = ?');
    params.push(patch.recursive ? 1 : 0);
  }

  if (patch.enabled !== undefined) {
    if (typeof patch.enabled !== 'boolean') {
      return { ok: false, code: 'invalid', message: 'enabled must be a boolean' };
    }
    sets.push('enabled = ?');
    params.push(patch.enabled ? 1 : 0);
  }

  if (patch.include_globs !== undefined) {
    const validated = validateGlobs(patch.include_globs);
    if (validated === false) {
      return {
        ok: false,
        code: 'invalid',
        message: 'include_globs must be an array of strings',
      };
    }
    if (validated !== null) {
      sets.push('include_globs = ?');
      params.push(JSON.stringify(validated));
    }
  }

  if (patch.exclude_globs !== undefined) {
    const validated = validateGlobs(patch.exclude_globs);
    if (validated === false) {
      return {
        ok: false,
        code: 'invalid',
        message: 'exclude_globs must be an array of strings',
      };
    }
    if (validated !== null) {
      sets.push('exclude_globs = ?');
      params.push(JSON.stringify(validated));
    }
  }

  if (sets.length === 0) {
    // No fields to update. Return the existing row unchanged so the caller
    // has a uniform success shape.
    return { ok: true, folder: existing };
  }

  sets.push('updated_at = ?');
  params.push(Date.now());
  params.push(id);

  db.prepare(`UPDATE local_folders SET ${sets.join(', ')} WHERE id = ?`).run(...params);

  const updated = getLocalFolder(db, id);
  if (!updated) {
    return { ok: false, code: 'not_found', message: `No folder with id ${id}` };
  }
  return { ok: true, folder: updated };
}

/**
 * Remove a folder by id. Returns `false` when no row matched so the caller
 * can map to a 404 without a separate existence check.
 */
export function removeLocalFolder(db: Database.Database, id: number): boolean {
  const result = db.prepare('DELETE FROM local_folders WHERE id = ?').run(id);
  return result.changes > 0;
}
