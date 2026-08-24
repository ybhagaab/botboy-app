import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs';
import { createStorage, type StorageLayer } from './storage.js';
import {
  addLocalFolder,
  listLocalFolders,
  updateLocalFolder,
  removeLocalFolder,
  getLocalFolder,
  expandTilde,
} from './local-folders-config.js';

/**
 * Tests cover the addLocalFolder validation chain (1.4),
 * realpath/tilde canonicalization (1.5), malformed-JSON tolerance for
 * the glob columns (1.2), and the update/remove error shapes (1.3).
 */
describe('local-folders-config', () => {
  let storage: StorageLayer;
  let homeTestDir: string;
  let outsideHomeDir: string;

  beforeEach(() => {
    storage = createStorage(':memory:');
    storage.initialize();

    // A unique directory under $HOME we can register/update/delete.
    homeTestDir = fs.mkdtempSync(
      path.join(os.homedir(), '.ppt-test-local-folders-'),
    );

    // A unique directory under the system tmpdir so realpathSync succeeds
    // but the path falls outside $HOME (which is what the inside-home
    // guard rejects).
    outsideHomeDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'ppt-test-outside-home-'),
    );
  });

  afterEach(() => {
    storage.close();
    try {
      fs.rmSync(homeTestDir, { recursive: true, force: true });
    } catch {}
    try {
      fs.rmSync(outsideHomeDir, { recursive: true, force: true });
    } catch {}
  });

  // ── addLocalFolder validation chain ────────────────────────────────────

  describe('addLocalFolder', () => {
    it('rejects a path that does not exist with code "not_found"', () => {
      const db = storage.getDb();
      const missing = path.join(homeTestDir, 'does-not-exist');

      const result = addLocalFolder(db, { path: missing });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('not_found');
        expect(result.message).toContain(missing);
      }
      // Nothing was persisted.
      expect(listLocalFolders(db)).toHaveLength(0);
    });

    it('rejects a regular file (not a directory) with code "not_dir"', () => {
      const db = storage.getDb();
      const filePath = path.join(homeTestDir, 'a-file.txt');
      fs.writeFileSync(filePath, 'hello');

      const result = addLocalFolder(db, { path: filePath });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('not_dir');
      }
      expect(listLocalFolders(db)).toHaveLength(0);
    });

    it('rejects a path that resolves outside $HOME with code "outside_home"', () => {
      const db = storage.getDb();

      // Sanity: skip if the platform's tmpdir happens to live under $HOME
      // (no known case on macOS/Linux CI, but be explicit).
      const realOutside = fs.realpathSync(outsideHomeDir);
      const homePrefix = os.homedir().endsWith(path.sep)
        ? os.homedir()
        : os.homedir() + path.sep;
      if (
        realOutside === os.homedir() ||
        realOutside.startsWith(homePrefix)
      ) {
        return;
      }

      const result = addLocalFolder(db, { path: outsideHomeDir });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('outside_home');
      }
      expect(listLocalFolders(db)).toHaveLength(0);
    });

    it('rejects a duplicate path with code "duplicate"', () => {
      const db = storage.getDb();

      const first = addLocalFolder(db, { path: homeTestDir });
      expect(first.ok).toBe(true);

      const second = addLocalFolder(db, { path: homeTestDir });

      expect(second.ok).toBe(false);
      if (!second.ok) {
        expect(second.code).toBe('duplicate');
      }
      // Only the first row exists.
      expect(listLocalFolders(db)).toHaveLength(1);
    });

    it('canonicalizes input via realpathSync (resolves symlinks)', () => {
      const db = storage.getDb();
      const realTarget = path.join(homeTestDir, 'real-target');
      const symlink = path.join(homeTestDir, 'sym-link');
      fs.mkdirSync(realTarget);
      fs.symlinkSync(realTarget, symlink);

      const result = addLocalFolder(db, { path: symlink });

      expect(result.ok).toBe(true);
      if (result.ok) {
        // The persisted path is the symlink target's realpath, NOT the
        // symlink path itself.
        expect(result.folder.path).toBe(fs.realpathSync(realTarget));
        expect(result.folder.path).not.toBe(symlink);
      }
    });

    it('expands a leading "~/" via expandTilde before validation', () => {
      const db = storage.getDb();
      // homeTestDir is e.g. /Users/foo/.ppt-test-local-folders-XXXX.
      // Build the equivalent ~/-prefixed form.
      const relFromHome = path.relative(os.homedir(), homeTestDir);
      const tildePath = `~/${relFromHome}`;

      const result = addLocalFolder(db, { path: tildePath });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.folder.path).toBe(fs.realpathSync(homeTestDir));
      }
    });

    it('expandTilde helper expands "~" and "~/..." but passes other input through', () => {
      expect(expandTilde('~')).toBe(os.homedir());
      expect(expandTilde('~/foo/bar')).toBe(path.join(os.homedir(), 'foo/bar'));
      expect(expandTilde('/absolute/path')).toBe('/absolute/path');
      expect(expandTilde('relative/path')).toBe('relative/path');
      // Non-leading tilde is untouched.
      expect(expandTilde('/foo/~bar')).toBe('/foo/~bar');
    });
  });

  // ── listLocalFolders malformed-JSON tolerance ──────────────────────────

  describe('listLocalFolders', () => {
    it('returns [] for malformed include_globs JSON and warn-logs', () => {
      const db = storage.getDb();
      const now = Date.now();
      db.prepare(
        `INSERT INTO local_folders
           (path, recursive, include_globs, exclude_globs, enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run('/some/canonical/path', 1, 'not-valid-json{', '[]', 1, now, now);

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const folders = listLocalFolders(db);

      expect(folders).toHaveLength(1);
      expect(folders[0].include_globs).toEqual([]);
      expect(folders[0].exclude_globs).toEqual([]);
      expect(warnSpy).toHaveBeenCalled();

      warnSpy.mockRestore();
    });

    it('returns [] for non-array JSON in a glob column and warn-logs', () => {
      const db = storage.getDb();
      const now = Date.now();
      db.prepare(
        `INSERT INTO local_folders
           (path, recursive, include_globs, exclude_globs, enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run('/another/path', 1, '{"not":"an array"}', '[]', 1, now, now);

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const folders = listLocalFolders(db);

      expect(folders[0].include_globs).toEqual([]);
      expect(warnSpy).toHaveBeenCalled();

      warnSpy.mockRestore();
    });
  });

  // ── updateLocalFolder ──────────────────────────────────────────────────

  describe('updateLocalFolder', () => {
    it('returns code "not_found" for an unknown id', () => {
      const db = storage.getDb();

      const result = updateLocalFolder(db, 9999, { recursive: false });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('not_found');
      }
    });

    it('returns code "invalid" when recursive is not a boolean', () => {
      const db = storage.getDb();
      const added = addLocalFolder(db, { path: homeTestDir });
      expect(added.ok).toBe(true);
      if (!added.ok) return;

      const result = updateLocalFolder(db, added.folder.id, {
        recursive: 'yes' as any,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('invalid');
      }
      // The row was not mutated.
      const after = getLocalFolder(db, added.folder.id);
      expect(after?.recursive).toBe(true);
    });

    it('returns code "invalid" when include_globs is not an array', () => {
      const db = storage.getDb();
      const added = addLocalFolder(db, { path: homeTestDir });
      expect(added.ok).toBe(true);
      if (!added.ok) return;

      const result = updateLocalFolder(db, added.folder.id, {
        include_globs: 'not-an-array' as any,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('invalid');
      }
    });

    it('returns code "invalid" when include_globs contains a non-string entry', () => {
      const db = storage.getDb();
      const added = addLocalFolder(db, { path: homeTestDir });
      expect(added.ok).toBe(true);
      if (!added.ok) return;

      const result = updateLocalFolder(db, added.folder.id, {
        include_globs: ['*.md', 123 as any],
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('invalid');
      }
    });
  });

  // ── removeLocalFolder ──────────────────────────────────────────────────

  describe('removeLocalFolder', () => {
    it('returns false when no row matches the given id', () => {
      const db = storage.getDb();
      expect(removeLocalFolder(db, 99999)).toBe(false);
    });

    it('returns true and deletes the row when the id exists', () => {
      const db = storage.getDb();
      const added = addLocalFolder(db, { path: homeTestDir });
      expect(added.ok).toBe(true);
      if (!added.ok) return;

      expect(removeLocalFolder(db, added.folder.id)).toBe(true);
      expect(getLocalFolder(db, added.folder.id)).toBeNull();
      expect(listLocalFolders(db)).toHaveLength(0);
    });
  });
});
