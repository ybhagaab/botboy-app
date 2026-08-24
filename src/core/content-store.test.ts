import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fc from 'fast-check';
import { writeFileSync, existsSync, rmSync, mkdtempSync } from 'fs';
import os from 'os';
import path from 'path';
import { createStorage, StorageLayer } from './storage.js';
import {
  createContentStore,
  ContentStore,
  ContentIntegrityError,
  refToColumns,
} from './content-store.js';

describe('ContentStore', () => {
  let storage: StorageLayer;
  let store: ContentStore;
  let contentDir: string;

  beforeEach(() => {
    storage = createStorage(':memory:');
    storage.initialize();
    contentDir = mkdtempSync(path.join(os.tmpdir(), 'ppt-content-'));
    // Small threshold so tests exercise the file path without huge strings.
    store = createContentStore(storage.getDb(), { contentDir, inlineThresholdBytes: 64 });
  });

  afterEach(() => {
    storage.close();
    try { rmSync(contentDir, { recursive: true, force: true }); } catch {}
  });

  // ── P1: lossless round-trip ──────────────────────────────────────────────
  it('P1: get(put(x)) === x for arbitrary content and sizes', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 5000 }), (x) => {
        const ref = store.put('item-' + Math.random().toString(36).slice(2), x);
        expect(store.get(ref)).toBe(x);
      }),
      { numRuns: 200 },
    );
  });

  it('P1: round-trips multi-MB content via the file path', () => {
    const big = 'x'.repeat(3 * 1024 * 1024) + '—end—';
    const ref = store.put('bigitem', big);
    expect(ref.storage).toBe('file');
    expect(store.get(ref)).toBe(big);
  });

  it('stores small content inline and large content as a file (transparency)', () => {
    const small = store.put('s1', 'hello');
    expect(small.storage).toBe('inline');
    const large = store.put('l1', 'y'.repeat(1000));
    expect(large.storage).toBe('file');
    // Both read back identically regardless of storage location (P4).
    expect(store.get(small)).toBe('hello');
    expect(store.get(large)).toBe('y'.repeat(1000));
  });

  // ── P2: integrity or error, never partial ────────────────────────────────
  it('P2: throws ContentIntegrityError when a file blob is corrupted', () => {
    const ref = store.put('c1', 'z'.repeat(500));
    expect(ref.storage).toBe('file');
    // Corrupt the blob on disk.
    writeFileSync(ref.filePath!, 'z'.repeat(499), 'utf8'); // truncated by one byte
    expect(() => store.get(ref)).toThrow(ContentIntegrityError);
  });

  it('P2: throws when a file blob is missing', () => {
    const ref = store.put('m1', 'w'.repeat(500));
    rmSync(ref.filePath!, { force: true });
    expect(() => store.get(ref)).toThrow(ContentIntegrityError);
  });

  it('P2: throws on sha256 mismatch even when length matches', () => {
    const ref = store.put('h1', 'a'.repeat(500));
    // Same length, different bytes → sha mismatch.
    writeFileSync(ref.filePath!, 'b'.repeat(500), 'utf8');
    expect(() => store.get(ref)).toThrow(/sha256 mismatch/);
  });

  // ── P4: storage transparency via row columns ─────────────────────────────
  it('P4: refToColumns / refFromRow round-trip for inline and file', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 2000 }), (x) => {
        const ref = store.put('rt-' + Math.random().toString(36).slice(2), x);
        const cols = refToColumns(ref);
        const rebuilt = store.refFromRow(cols)!;
        expect(store.get(rebuilt)).toBe(x);
      }),
      { numRuns: 150 },
    );
  });

  // ── P3: no dangling references ────────────────────────────────────────────
  it('P3: verifyAll reports missing and corrupt file-backed rows', () => {
    const db = storage.getDb();
    const insert = (id: string, text: string) => {
      const ref = store.put(id, text);
      const cols = refToColumns(ref);
      db.prepare(
        `INSERT INTO work_items (id, type, source, captured_at, raw_text, content_storage, content_path, content_sha256, content_bytes)
         VALUES (?, 'website_visit', 'browser', '2026-07-08T10:00:00Z', ?, ?, ?, ?, ?)`,
      ).run(id, cols.raw_text, cols.content_storage, cols.content_path, cols.content_sha256, cols.content_bytes);
      return ref;
    };

    const good = insert('good', 'q'.repeat(500));
    const gone = insert('gone', 'r'.repeat(500));
    const bad = insert('bad', 's'.repeat(500));
    insert('inlineOne', 'tiny'); // inline — not checked by verifyAll

    // Break two of the file blobs.
    rmSync(gone.filePath!, { force: true });
    writeFileSync(bad.filePath!, 's'.repeat(400), 'utf8');

    const result = store.verifyAll();
    expect(result.checked).toBe(3); // only file-backed rows
    expect(result.missing).toContain('gone');
    expect(result.corrupt).toContain('bad');
    expect(result.missing).not.toContain('good');
    expect(result.corrupt).not.toContain('good');
    expect(existsSync(good.filePath!)).toBe(true);
  });

  it('atomic write leaves no visible partial file on the happy path', () => {
    const ref = store.put('atomic', 'u'.repeat(500));
    // No leftover temp files in the blob directory.
    const dir = path.dirname(ref.filePath!);
    const fs = require('fs') as typeof import('fs');
    const leftovers = fs.readdirSync(dir).filter((f: string) => f.includes('.tmp-'));
    expect(leftovers).toHaveLength(0);
  });
});

// ── Auxiliary content (raw page HTML) ────────────────────────────────────────
// Added 2026-08-05: browser captures store the ENTIRE page HTML alongside the
// readable text. Aux blobs are always file-backed (refs live in metadata).
import { describe as describeAux, it as itAux, expect as expectAux } from 'vitest';
import { mkdtempSync as mkdtempAux, rmSync as rmAux } from 'fs';
import osAux from 'os';
import pathAux from 'path';
import DatabaseAux from 'better-sqlite3';
import { createContentStore as createStoreAux } from './content-store.js';

describeAux('ContentStore.putAux', () => {
  itAux('stores aux content file-backed regardless of size and round-trips losslessly', () => {
    const dir = mkdtempAux(pathAux.join(osAux.tmpdir(), 'ppt-aux-'));
    const db = new DatabaseAux(':memory:');
    try {
      const store = createStoreAux(db, { contentDir: dir });
      const smallHtml = '<html><body>tiny</body></html>'; // far below inline threshold
      const ref = store.putAux('item-1', 'html', smallHtml);
      expectAux(ref.storage).toBe('file'); // never inline for aux
      expectAux(ref.filePath).toContain('item-1-html');
      expectAux(store.get(ref)).toBe(smallHtml);

      const bigHtml = '<div>' + 'x'.repeat(200 * 1024) + '</div>';
      const bigRef = store.putAux('item-1', 'html', bigHtml);
      expectAux(store.get(bigRef)).toBe(bigHtml);
      expectAux(bigRef.byteLength).toBe(Buffer.byteLength(bigHtml, 'utf8'));
    } finally {
      db.close();
      try { rmAux(dir, { recursive: true, force: true }); } catch {}
    }
  });

  itAux('aux blob does not collide with the item primary blob', () => {
    const dir = mkdtempAux(pathAux.join(osAux.tmpdir(), 'ppt-aux-'));
    const db = new DatabaseAux(':memory:');
    try {
      const store = createStoreAux(db, { contentDir: dir, inlineThresholdBytes: 4 });
      const mainRef = store.put('item-2', 'main content body');
      const auxRef = store.putAux('item-2', 'html', '<html>raw</html>');
      expectAux(mainRef.filePath).not.toBe(auxRef.filePath);
      expectAux(store.get(mainRef)).toBe('main content body');
      expectAux(store.get(auxRef)).toBe('<html>raw</html>');
    } finally {
      db.close();
      try { rmAux(dir, { recursive: true, force: true }); } catch {}
    }
  });
});
