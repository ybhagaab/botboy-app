import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { createStorage, StorageLayer } from './storage.js';
import { createContentStore } from './content-store.js';
import { createFailureRecorder } from './failures.js';
import { createExtractor } from './extractor.js';
import type { DocumentParser } from './document-parser.js';
import type { OcrEngine, OcrResult } from './ocr-engine.js';
import { OcrUnavailableError } from './ocr-engine.js';

describe('Extractor', () => {
  let storage: StorageLayer;
  let dir: string;

  beforeEach(() => {
    storage = createStorage(':memory:');
    storage.initialize();
    dir = mkdtempSync(path.join(os.tmpdir(), 'ppt-extract-'));
  });
  afterEach(() => {
    storage.close();
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  });

  function insertItem(id: string, type: string, source: string, filePath: string) {
    storage.getDb().prepare(
      `INSERT INTO work_items (id, type, source, captured_at, metadata, process_state)
       VALUES (?, ?, ?, '2026-07-08T10:00:00Z', ?, 'captured')`,
    ).run(id, type, source, JSON.stringify({ filePath }));
  }

  const okParser = (text: string): DocumentParser => ({
    getSupportedFormats: () => ['.pdf', '.txt', '.md', '.docx'],
    parse: (fp) => ({ success: true, text, filePath: fp, fileType: path.extname(fp) }),
  });
  const failParser = (): DocumentParser => ({
    getSupportedFormats: () => ['.pdf'],
    parse: (fp) => ({ success: false, error: 'boom', filePath: fp, fileType: path.extname(fp) }),
  });
  const okOcr = (text: string, conf = 0.9): OcrEngine => ({
    name: 'stub',
    isAvailable: () => true,
    async ocr(): Promise<OcrResult> { return { text, lines: [{ text, confidence: conf }], aggConfidence: conf }; },
    async ocrPdfPages(): Promise<OcrResult> { return { text, lines: [{ text, confidence: conf }], aggConfidence: conf }; },
  });
  const unavailableOcr = (): OcrEngine => ({
    name: 'stub',
    isAvailable: () => false,
    async ocr(): Promise<OcrResult> { throw new OcrUnavailableError('no helper'); },
    async ocrPdfPages(): Promise<OcrResult> { throw new OcrUnavailableError('no helper'); },
  });

  function build(parser: DocumentParser, ocr: OcrEngine) {
    const db = storage.getDb();
    return createExtractor({
      db,
      documentParser: parser,
      ocrEngine: ocr,
      contentStore: createContentStore(db, { contentDir: dir, inlineThresholdBytes: 64 }),
      failures: createFailureRecorder(db),
    });
  }

  it('OCRs an image item and stores the text + confidence + lines', async () => {
    const img = path.join(dir, 'shot.png');
    writeFileSync(img, 'not-a-real-png-but-path-exists');
    insertItem('img1', 'clipboard_capture', 'clipboard', img);

    const ex = build(okParser(''), okOcr('receipt total $42', 0.8));
    const out = await ex.extract('img1');
    expect(out.state).toBe('extracted');
    expect(out.kind).toBe('ocr');
    expect(out.ocrConfidence).toBeCloseTo(0.8);

    const row = storage.getDb().prepare('SELECT raw_text, process_state, ocr_confidence FROM work_items WHERE id = ?').get('img1') as any;
    expect(row.raw_text).toBe('receipt total $42');
    expect(row.process_state).toBe('extracted');
    const lines = storage.getDb().prepare('SELECT * FROM item_ocr_lines WHERE item_id = ?').all('img1');
    expect(lines.length).toBe(1);
  });

  it('parses a document item to text', async () => {
    const doc = path.join(dir, 'notes.txt');
    writeFileSync(doc, 'x');
    insertItem('doc1', 'document_capture', 'filesystem', doc);

    const ex = build(okParser('the full parsed document text'), okOcr('should-not-be-used'));
    const out = await ex.extract('doc1');
    expect(out.kind).toBe('doc');
    const row = storage.getDb().prepare('SELECT raw_text FROM work_items WHERE id = ?').get('doc1') as any;
    expect(row.raw_text).toBe('the full parsed document text');
  });

  it('OCRs a scanned PDF whose parse yields little text and merges (doc+ocr)', async () => {
    const pdf = path.join(dir, 'scan.pdf');
    writeFileSync(pdf, '%PDF-1.4');
    insertItem('pdf1', 'document_capture', 'filesystem', pdf);

    const ex = build(okParser(''), okOcr('scanned page text here', 0.7)); // empty parse → OCR fallback
    const out = await ex.extract('pdf1');
    expect(out.kind).toBe('doc+ocr');
    const row = storage.getDb().prepare('SELECT raw_text FROM work_items WHERE id = ?').get('pdf1') as any;
    expect(row.raw_text).toContain('scanned page text here');
  });

  const unsupportedParser = (): DocumentParser => ({
    getSupportedFormats: () => ['.pdf', '.txt', '.md'],
    parse: (fp) => ({ success: false, error: `Unsupported format: ${path.extname(fp)}`, filePath: fp, fileType: path.extname(fp) }),
  });

  it('captures an unsupported but TEXTUAL file (e.g. .tsv/.log) as text, not OCR', async () => {
    const f = path.join(dir, 'data.tsv');
    writeFileSync(f, 'col1\tcol2\nval1\tval2', 'utf8');
    insertItem('t1', 'document_capture', 'filesystem', f);

    const ex = build(unsupportedParser(), okOcr('SHOULD NOT OCR'));
    const out = await ex.extract('t1');
    expect(out.kind).toBe('doc');
    const row = storage.getDb().prepare('SELECT raw_text FROM work_items WHERE id = ?').get('t1') as any;
    expect(row.raw_text).toContain('col1');
  });

  it('marks an unsupported BINARY file as noise (no OCR, no failure spam)', async () => {
    const f = path.join(dir, 'blob.xyz');
    writeFileSync(f, Buffer.from([0x00, 0x01, 0x02, 0x00, 0xff])); // NUL bytes → binary
    insertItem('b2', 'document_capture', 'filesystem', f);

    const ex = build(unsupportedParser(), okOcr('SHOULD NOT OCR'));
    const out = await ex.extract('b2');
    expect(out.state).toBe('noise');
    const row = storage.getDb().prepare('SELECT process_state FROM work_items WHERE id = ?').get('b2') as any;
    expect(row.process_state).toBe('noise');
    // No failure row for a merely-unsupported binary.
    const fail = storage.getDb().prepare("SELECT COUNT(*) AS c FROM failures WHERE item_id = 'b2'").get() as any;
    expect(fail.c).toBe(0);
  });

  it('records a failure and flags incomplete when extraction fully fails', async () => {
    const f = path.join(dir, 'broken.pdf');
    writeFileSync(f, 'x');
    insertItem('b1', 'document_capture', 'filesystem', f);

    const ex = build(failParser(), unavailableOcr()); // parse fails, OCR unavailable
    const out = await ex.extract('b1');
    expect(out.state).toBe('extract_failed');
    const row = storage.getDb().prepare('SELECT process_state, incomplete FROM work_items WHERE id = ?').get('b1') as any;
    expect(row.process_state).toBe('extract_failed');
    expect(row.incomplete).toBe(1);
    const fail = storage.getDb().prepare('SELECT * FROM failures WHERE item_id = ?').get('b1') as any;
    expect(fail.step).toBe('parse');
  });

  it('marks items with no source file as extracted (nothing to do)', async () => {
    storage.getDb().prepare(
      `INSERT INTO work_items (id, type, source, captured_at, raw_text, content_bytes, process_state)
       VALUES ('t1', 'slack_message', 'slack', '2026-07-08T10:00:00Z', 'already text', 11, 'captured')`,
    ).run();
    const ex = build(okParser(''), okOcr(''));
    const out = await ex.extract('t1');
    expect(out.state).toBe('extracted');
    expect(out.kind).toBe('none');
  });
});
