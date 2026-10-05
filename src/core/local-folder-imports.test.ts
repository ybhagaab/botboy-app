import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { createStorage, migrateLocalFolderImports, type StorageLayer } from './storage.js';
import {
  FOLDER_FILE_OUTCOMES,
  captureSignature,
  changingOftenFiles,
  clearFirstImportDone,
  contentRemovedPaths,
  createLocalFolderImportLedger,
  directoryGlobForPath,
  existingCaptureSignatures,
  isFirstImportDone,
  literalGlobForPath,
  markFirstImportDone,
  parseLiteralGlob,
} from './local-folder-imports.js';

/**
 * Import ledger (LOCAL_FOLDER_IMPORT_SAFETY_PLAN.md C2/C8): durable
 * per-file outcomes, existing-capture signatures that make walks
 * idempotent across the ledger's introduction, and literal exclusion globs
 * that round-trip exactly (including wildcard characters in names).
 */
describe('local-folder import ledger', () => {
  let storage: StorageLayer;
  let clock = 1_000;

  beforeEach(() => {
    storage = createStorage(':memory:');
    storage.initialize();
    clock = 1_000;
  });
  afterEach(() => storage.close());

  function ledger() {
    return createLocalFolderImportLedger(storage.getDb(), () => ++clock);
  }

  it('accepts every declared outcome and rejects unknown ones', () => {
    const l = ledger();
    FOLDER_FILE_OUTCOMES.forEach((outcome, i) => {
      l.record({ folderId: 1, path: `/r/f${i}`, size: i, mtimeMs: i, outcome });
    });
    expect(l.list(1).map(row => row.outcome)).toEqual([...FOLDER_FILE_OUTCOMES]);
    expect(() => storage.getDb().prepare(
      "INSERT INTO local_folder_imports (folder_id, path, size, mtime_ms, outcome, updated_at) VALUES (1, '/r/x', 1, 1, 'deleted', 1)",
    ).run()).toThrow(/CHECK/);
  });

  it('upserts rows, preserves origin unless given, and filters by outcome and size in SQL', () => {
    const l = ledger();
    l.record({ folderId: 1, path: '/r/a.csv', size: 50, mtimeMs: 10, outcome: 'needs_review', origin: 'live' });
    l.record({ folderId: 1, path: '/r/a.csv', size: 60, mtimeMs: 11, outcome: 'approved' });
    l.record({ folderId: 1, path: '/r/b.txt', size: 5, mtimeMs: 1, outcome: 'imported' });
    l.record({ folderId: 2, path: '/s/c.csv', size: 90, mtimeMs: 1, outcome: 'needs_review' });
    const a = l.get(1, '/r/a.csv')!;
    expect(a).toMatchObject({ size: 60, mtimeMs: 11, outcome: 'approved', origin: 'live' });
    expect(l.list(1, ['approved', 'imported']).map(row => row.path)).toEqual(['/r/a.csv', '/r/b.txt']);
    expect(l.list(1, ['approved', 'imported'], 10).map(row => row.path)).toEqual(['/r/a.csv']);
    expect(l.counts(1)).toMatchObject({ approved: 1, imported: 1, needs_review: 0 });
    expect(l.setOutcome(1, '/r/b.txt', 'excluded')).toBe(true);
    expect(l.remove(1, '/r/b.txt')).toBe(true);
    expect(l.get(1, '/r/b.txt')).toBeUndefined();
    expect(l.forFolder(2).get('/s/c.csv')?.outcome).toBe('needs_review');
    l.removeFolder(2);
    expect(l.list(2)).toEqual([]);
  });

  it('excludes held rows under a directory without touching siblings with a shared prefix', () => {
    const l = ledger();
    l.record({ folderId: 1, path: '/r/data/a.csv', size: 1, mtimeMs: 1, outcome: 'needs_review' });
    l.record({ folderId: 1, path: '/r/data/deep/b.csv', size: 1, mtimeMs: 1, outcome: 'approved' });
    l.record({ folderId: 1, path: '/r/data/c.csv', size: 1, mtimeMs: 1, outcome: 'imported' });
    l.record({ folderId: 1, path: '/r/database/d.csv', size: 1, mtimeMs: 1, outcome: 'needs_review' });
    expect(l.excludeUnder(1, '/r/data')).toBe(2);
    expect(l.get(1, '/r/data/c.csv')?.outcome).toBe('imported');
    expect(l.get(1, '/r/database/d.csv')?.outcome).toBe('needs_review');
    expect(l.listUnder(1, '/r/data/', ['excluded']).map(row => row.path)).toEqual(['/r/data/a.csv', '/r/data/deep/b.csv']);
  });

  it('seeds idempotency from existing captures but not from content-removed stubs or other roots', () => {
    const db = storage.getDb();
    const insert = db.prepare(`INSERT INTO work_items (id, type, source, file_path, metadata, captured_at)
      VALUES (?, 'document_capture', 'filesystem', ?, ?, '2026-09-30T00:00:00.000Z')`);
    insert.run('i1', '/root/a.md', JSON.stringify({ size: '12', mtime: '1700.5' }));
    insert.run('i2', '/root/big.csv', JSON.stringify({ size: '99', mtime: '5', contentRemoved: { bytes: 99 } }));
    insert.run('i3', '/rootless/x.md', JSON.stringify({ size: '1', mtime: '1' }));
    insert.run('i4', '/root/broken.md', 'not json');
    const signatures = existingCaptureSignatures(db, '/root');
    expect([...signatures]).toEqual([captureSignature('/root/a.md', '12', '1700.5')]);
    expect([...contentRemovedPaths(db, '/root')]).toEqual(['/root/big.csv']);
  });

  it('round-trips literal file and directory globs, including wildcard characters in names', () => {
    for (const name of ['/r/plain.csv', '/r/star*file?.csv', '/r/back\\slash.txt']) {
      expect(parseLiteralGlob(literalGlobForPath(name))).toEqual({ path: name, directory: false });
    }
    expect(parseLiteralGlob(directoryGlobForPath('/r/data dir/'))).toEqual({ path: '/r/data dir', directory: true });
    expect(parseLiteralGlob(directoryGlobForPath('/r/odd*'))).toEqual({ path: '/r/odd*', directory: true });
    expect(parseLiteralGlob('*.csv')).toBeNull();
    expect(parseLiteralGlob('/r/**/x.csv')).toBeNull();
    expect(parseLiteralGlob('relative/file.csv')).toBeNull();
  });

  it('stores the first-import marker under the existing settings key', () => {
    const db = storage.getDb();
    expect(isFirstImportDone(db, 7)).toBe(false);
    markFirstImportDone(db, 7);
    expect(isFirstImportDone(db, 7)).toBe(true);
    expect(db.prepare("SELECT value FROM app_settings WHERE key = 'local_folders.backfilled.7'").get()).toEqual({ value: 'true' });
    clearFirstImportDone(db, 7);
    expect(isFirstImportDone(db, 7)).toBe(false);
  });

  it('records why a sensitive row is held, and clears the reason when the file is imported later', () => {
    const l = ledger();
    l.record({ folderId: 1, path: '/r/deploy.md', size: 10, mtimeMs: 1, outcome: 'sensitive', reason: 'Contains what looks like a GitHub token' });
    expect(l.get(1, '/r/deploy.md')).toMatchObject({ outcome: 'sensitive', reason: 'Contains what looks like a GitHub token' });
    expect(l.counts(1).sensitive).toBe(1);
    l.record({ folderId: 1, path: '/r/deploy.md', size: 12, mtimeMs: 2, outcome: 'imported' });
    expect(l.get(1, '/r/deploy.md')).toMatchObject({ outcome: 'imported', reason: null });
  });
});

describe('local-folder import ledger migration', () => {
  it('widens an existing ledger to hold sensitive files without losing a row', () => {
    const db = new Database(':memory:');
    try {
      // The ledger as shipped before sensitive holds existed.
      db.exec(`
        CREATE TABLE local_folder_imports (
          folder_id INTEGER NOT NULL,
          path TEXT NOT NULL,
          size INTEGER NOT NULL,
          mtime_ms REAL NOT NULL,
          outcome TEXT NOT NULL CHECK(outcome IN ('imported','needs_review','approved','excluded','too_large','deferred_low_disk')),
          origin TEXT NOT NULL DEFAULT 'import' CHECK(origin IN ('import','live')),
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (folder_id, path)
        );
        INSERT INTO local_folder_imports VALUES (1, '/r/a.md', 10, 1.5, 'imported', 'live', 100);
        INSERT INTO local_folder_imports VALUES (1, '/r/big.csv', 9000, 2.5, 'needs_review', 'import', 200);
      `);
      migrateLocalFolderImports(db);
      const l = createLocalFolderImportLedger(db);
      expect(l.get(1, '/r/a.md')).toMatchObject({ outcome: 'imported', origin: 'live', size: 10, mtimeMs: 1.5, updatedAt: 100, reason: null });
      expect(l.get(1, '/r/big.csv')).toMatchObject({ outcome: 'needs_review', size: 9000 });
      l.record({ folderId: 1, path: '/r/id_rsa', size: 3, mtimeMs: 3, outcome: 'sensitive', reason: 'Named like an SSH private key (id_rsa)' });
      expect(l.counts(1)).toMatchObject({ imported: 1, needs_review: 1, sensitive: 1 });
      // Idempotent: a second migration keeps the widened table as is.
      createLocalFolderImportLedger(db);
      expect(l.list(1)).toHaveLength(3);
      const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'local_folder_imports'").all();
      expect(indexes).toEqual(expect.arrayContaining([{ name: 'idx_local_folder_imports_outcome' }]));
    } finally {
      db.close();
    }
  });

  it('widens a ledger that already holds sensitive rows, keeping every reason', () => {
    const db = new Database(':memory:');
    try {
      // The ledger as rebuilt for sensitive holds, before owner pauses.
      db.exec(`
        CREATE TABLE local_folder_imports (
          folder_id INTEGER NOT NULL,
          path TEXT NOT NULL,
          size INTEGER NOT NULL,
          mtime_ms REAL NOT NULL,
          outcome TEXT NOT NULL CHECK(outcome IN ('imported','needs_review','approved','excluded','too_large','deferred_low_disk','sensitive')),
          origin TEXT NOT NULL DEFAULT 'import' CHECK(origin IN ('import','live')),
          updated_at INTEGER NOT NULL,
          reason TEXT,
          PRIMARY KEY (folder_id, path)
        );
        INSERT INTO local_folder_imports VALUES (6, '/r/key.pem', 3, 1, 'sensitive', 'live', 100, 'File type of a private key or certificate file (.pem)');
        INSERT INTO local_folder_imports VALUES (6, '/r/progress.json', 2400000, 2, 'imported', 'live', 200, NULL);
      `);
      migrateLocalFolderImports(db);
      const l = createLocalFolderImportLedger(db);
      expect(l.get(6, '/r/key.pem')).toMatchObject({ outcome: 'sensitive', reason: 'File type of a private key or certificate file (.pem)', updatedAt: 100 });
      expect(l.setOutcome(6, '/r/progress.json', 'owner_paused')).toBe(true);
      expect(l.counts(6)).toMatchObject({ sensitive: 1, owner_paused: 1 });
    } finally {
      db.close();
    }
  });
});

describe('files that keep changing', () => {
  let storage: StorageLayer;
  const NOW = Date.parse('2026-10-02T12:00:00.000Z');
  const MB = 1024 * 1024;

  beforeEach(() => {
    storage = createStorage(':memory:');
    storage.initialize();
  });
  afterEach(() => storage.close());

  function capture(id: string, filePath: string, hoursAgo: number, bytes: number) {
    storage.getDb().prepare(`INSERT INTO work_items (id, type, source, file_path, content_bytes, captured_at)
      VALUES (?, 'document_capture', 'filesystem', ?, ?, ?)`)
      .run(id, filePath, bytes, new Date(NOW - hoursAgo * 3600_000).toISOString());
  }

  it('flags a large file captured often in the last day that is still changing', () => {
    // Every 30 minutes for the last 10 hours, 2.4 MB each.
    for (let i = 0; i < 20; i++) capture(`t${i}`, '/r/dashboard/training-progress.json', i * 0.5, Math.round(2.4 * MB));
    const [file, ...rest] = changingOftenFiles(storage.getDb(), '/r', { now: NOW });
    expect(rest).toEqual([]);
    expect(file).toMatchObject({ path: '/r/dashboard/training-progress.json', versions: 20 });
    expect(file.maxBytes).toBe(Math.round(2.4 * MB));
    expect(file.storedBytes).toBe(20 * Math.round(2.4 * MB));
  });

  it('ignores small files, rare changes, files that settled, and other folders', () => {
    for (let i = 0; i < 20; i++) capture(`s${i}`, '/r/notes.md', i * 0.5, 200 * 1024); // small
    for (let i = 0; i < 3; i++) capture(`r${i}`, '/r/rare.json', i, 5 * MB);          // rare
    for (let i = 0; i < 10; i++) capture(`q${i}`, '/r/settled.json', 6 + i, 3 * MB);  // stopped 6 h ago
    capture('q-resumed', '/r/settled.json', 0.1, 3 * MB);                             // one capture on resume
    for (let i = 0; i < 20; i++) capture(`o${i}`, '/other/busy.json', i * 0.5, 3 * MB); // other root
    expect(changingOftenFiles(storage.getDb(), '/r', { now: NOW })).toEqual([]);
  });
});
