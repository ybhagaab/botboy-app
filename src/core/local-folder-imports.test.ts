import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createStorage, type StorageLayer } from './storage.js';
import {
  FOLDER_FILE_OUTCOMES,
  captureSignature,
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
});
