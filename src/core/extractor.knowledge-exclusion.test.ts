/**
 * The extractor re-check of the Knowledge library exclusion (knowledge-library.md K1). A work item queued before the
 * library existed, or a file moved into it, is stopped before anything reads the file: a one-line stub replaces its
 * content, the item becomes `noise`, and the parser and OCR engine are never called.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerCaptureExcludedRoots } from './capture-exclusions.js';
import { createContentStore } from './content-store.js';
import type { DocumentParser } from './document-parser.js';
import { createExtractor } from './extractor.js';
import { createFailureRecorder } from './failures.js';
import type { OcrEngine } from './ocr-engine.js';
import { createStorage, type StorageLayer } from './storage.js';

describe('Extractor and the Knowledge library', () => {
  let storage: StorageLayer;
  let dir: string;
  let library: string;
  const parse = vi.fn();
  const ocr = vi.fn();

  const parser = (): DocumentParser => ({
    getSupportedFormats: () => ['.txt', '.md'],
    parse: (filePath: string) => { parse(filePath); return { success: true, text: 'parsed text', filePath, fileType: path.extname(filePath) }; },
  });
  const ocrEngine = (): OcrEngine => ({
    name: 'stub',
    isAvailable: () => true,
    async ocr() { ocr(); return { text: 'ocr text', lines: [], aggConfidence: 0.9 }; },
    async ocrPdfPages() { ocr(); return { text: 'ocr text', lines: [], aggConfidence: 0.9 }; },
  });
  const insertItem = (id: string, source: string, filePath: string) => {
    storage.getDb().prepare(
      `INSERT INTO work_items (id, type, source, captured_at, metadata, process_state, raw_text)
       VALUES (?, 'document_capture', ?, '2026-10-15T10:00:00Z', ?, 'captured', 'inline text of the file')`,
    ).run(id, source, JSON.stringify({ filePath }));
  };
  const build = () => {
    const db = storage.getDb();
    return createExtractor({
      db,
      documentParser: parser(),
      ocrEngine: ocrEngine(),
      contentStore: createContentStore(db, { contentDir: path.join(dir, 'content'), inlineThresholdBytes: 4096 }),
      failures: createFailureRecorder(db),
    });
  };
  const row = (id: string) => storage.getDb().prepare('SELECT raw_text, process_state, extraction_kind, summary FROM work_items WHERE id = ?').get(id) as {
    raw_text: string; process_state: string; extraction_kind: string; summary: string;
  };

  beforeEach(() => {
    storage = createStorage(':memory:');
    storage.initialize();
    dir = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'kl-extract-')));
    library = path.join(dir, 'BotBoy Knowledge');
    mkdirSync(path.join(library, 'notes'), { recursive: true });
    writeFileSync(path.join(library, 'notes', 'reference.md'), '# Reference\nShopwave order columns.\n');
    writeFileSync(path.join(dir, 'beside.md'), '# Beside\n');
    parse.mockClear();
    ocr.mockClear();
    registerCaptureExcludedRoots(() => [library]);
  });

  afterEach(() => {
    registerCaptureExcludedRoots(null);
    storage.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('withholds a queued library file as noise without reading it, and replaces its stored text with a stub', async () => {
    insertItem('lib1', 'filesystem', path.join(library, 'notes', 'reference.md'));
    const out = await build().extract('lib1');
    expect(out).toMatchObject({ state: 'noise', kind: 'none', bytes: 0 });
    expect(parse).not.toHaveBeenCalled();
    expect(ocr).not.toHaveBeenCalled();
    const stored = row('lib1');
    expect(stored.process_state).toBe('noise');
    expect(stored.extraction_kind).toBe('none');
    expect(stored.summary).toBe('');
    expect(stored.raw_text).toContain('Knowledge library');
    expect(stored.raw_text).not.toContain('inline text of the file');
    expect(storage.getDb().prepare('SELECT COUNT(*) AS n FROM work_items_fts WHERE item_id = ?').get('lib1')).toEqual({ n: 1 });
    const fts = storage.getDb().prepare('SELECT body FROM work_items_fts WHERE item_id = ?').get('lib1') as { body: string };
    expect(fts.body).toContain('Knowledge library');
  });

  it('also stops a file that reaches the library through a link', async () => {
    const link = path.join(dir, 'shortcut.md');
    symlinkSync(path.join(library, 'notes', 'reference.md'), link);
    insertItem('lib2', 'filesystem', link);
    expect((await build().extract('lib2')).state).toBe('noise');
    expect(parse).not.toHaveBeenCalled();
  });

  it('control: a file beside the library is extracted as before', async () => {
    insertItem('out1', 'filesystem', path.join(dir, 'beside.md'));
    const out = await build().extract('out1');
    expect(out).toMatchObject({ state: 'extracted', kind: 'doc' });
    expect(parse).toHaveBeenCalledTimes(1);
    expect(row('out1').raw_text).toBe('parsed text');
  });

  it('control: with no library registered the same file is extracted', async () => {
    registerCaptureExcludedRoots(null);
    insertItem('lib3', 'filesystem', path.join(library, 'notes', 'reference.md'));
    expect((await build().extract('lib3')).state).toBe('extracted');
  });

  it('does not apply to captures that do not come from a watched folder', async () => {
    insertItem('clip1', 'clipboard', path.join(library, 'notes', 'reference.md'));
    expect((await build().extract('clip1')).state).toBe('extracted');
  });
});
