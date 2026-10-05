import fs from 'fs';
import os from 'os';
import path from 'path';
import { createStorage, getSetting, type StorageLayer } from './storage.js';
import { createContentStore, refToColumns, type ContentStore } from './content-store.js';
import { createLocalFolderImportLedger } from './local-folder-imports.js';
import {
  RAW_CAPTURE_REPAIR_KEY,
  RAW_RECAPTURE_REASON,
  createRawCaptureRepair,
  type RawCaptureRepair,
} from './raw-capture-repair.js';

/**
 * One-time repair of local PDF captures stored as raw bytes (2026-10-05):
 * the rules the owner's store was cleaned with, on every store. Rows whose
 * text is a PDF's bytes are deleted with their links, search rows, and
 * content files; a watched file whose newest capture was such a row is
 * captured again once through the pending lane.
 */
describe('raw PDF capture repair', () => {
  let storage: StorageLayer;
  let root: string;
  let outside: string;
  let contentDir: string;
  let store: ContentStore;

  const PDF_BYTES = `%PDF-1.4\n%\u00e2\u00e3\n5 0 obj << /Filter /FlateDecode >> stream\n${'x\u00ff'.repeat(40)}`;

  function db() { return storage.getDb(); }

  function repair(extra: Partial<Parameters<typeof createRawCaptureRepair>[0]> = {}): RawCaptureRepair {
    return createRawCaptureRepair({ db: db(), contentDir, yieldToLoop: async () => {}, now: () => new Date('2026-10-05T12:00:00Z'), ...extra });
  }

  function write(dir: string, rel: string, bytes = 100): string {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, Buffer.alloc(bytes, 1));
    return full;
  }

  function capture(id: string, filePath: string, opts: { capturedAt: string; text: string; state?: string; projectId?: string | null; batchId?: string; legacyPath?: boolean }): void {
    const cols = refToColumns(store.put(id, opts.text));
    db().prepare(`
      INSERT INTO work_items (id, type, source, title, file_path, raw_text, content_storage, content_path, content_sha256, content_bytes,
        metadata, captured_at, process_state, project_id, batch_id)
      VALUES (?, 'document_capture', 'filesystem', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, path.basename(filePath), opts.legacyPath ? null : filePath, cols.raw_text, cols.content_storage, cols.content_path, cols.content_sha256, cols.content_bytes,
      JSON.stringify({ filePath, fileType: '.pdf' }), opts.capturedAt, opts.state ?? 'routed', opts.projectId === undefined ? 'p1' : opts.projectId, opts.batchId ?? null,
    );
    db().prepare('INSERT INTO work_items_fts (item_id, title, body) VALUES (?, ?, ?)').run(id, path.basename(filePath), opts.text.slice(0, 200));
  }

  const ids = () => (db().prepare("SELECT id FROM work_items WHERE type = 'document_capture' ORDER BY id").all() as Array<{ id: string }>).map((row) => row.id);
  const count = (sql: string, ...args: unknown[]) => (db().prepare(sql).get(...args) as { c: number }).c;

  beforeEach(() => {
    storage = createStorage(':memory:');
    storage.initialize();
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ppt-raw-repair-root-'));
    outside = fs.mkdtempSync(path.join(os.tmpdir(), 'ppt-raw-repair-outside-'));
    contentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ppt-raw-repair-content-'));
    store = createContentStore(db(), { contentDir, inlineThresholdBytes: 64 });
    db().prepare('INSERT INTO local_folders (id, path, enabled, created_at, updated_at) VALUES (1, ?, 1, 0, 0)').run(root);
    db().prepare("INSERT INTO projects (id, title, brain_path) VALUES ('p1', 'Seattle receipts', '/tmp/p1.md')").run();
  });

  afterEach(() => {
    storage.close();
    for (const dir of [root, outside, contentDir]) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('deletes every capture stored as PDF bytes, with its links, search rows, and content files', async () => {
    const receipt = write(root, 'Downloads/receipt.pdf');
    capture('raw-old', receipt, { capturedAt: '2026-07-08T00:00:00Z', text: PDF_BYTES, legacyPath: true });
    capture('text-new', receipt, { capturedAt: '2026-09-09T00:00:00Z', text: 'Anchorhead Coffee latte $6.90', projectId: null, state: 'orphaned' });
    const rawFile = (db().prepare("SELECT content_path AS p FROM work_items WHERE id = 'raw-old'").get() as { p: string }).p;
    expect(fs.existsSync(rawFile)).toBe(true);
    const auxBlob = path.join(contentDir, 'ra', 'w-', 'raw-old-original.bin');
    fs.mkdirSync(path.dirname(auxBlob), { recursive: true });
    fs.writeFileSync(auxBlob, 'stored original');
    db().prepare("INSERT INTO nodes (id, title) VALUES ('n1', 'node')").run();
    db().prepare("INSERT INTO node_work_items (node_id, work_item_id) VALUES ('n1', 'raw-old')").run();
    db().prepare("INSERT INTO agent_todos (id, work_item_id, action) VALUES ('t1', 'raw-old', 'file it')").run();
    db().prepare("INSERT INTO project_cross_links (project_id, channel_id, channel_name, topic, evidence_item_id, reason) VALUES ('p1', 'C1', 'c', 'topic', 'raw-old', 'r')").run();
    db().prepare("INSERT INTO item_ocr_lines (item_id, line_index, text, confidence) VALUES ('raw-old', 0, 'x', 0.5)").run();
    db().prepare("INSERT INTO failures (item_id, step, message) VALUES ('raw-old', 'parse', 'boom')").run();
    db().prepare("INSERT INTO work_item_project_events (work_item_id, project_id) VALUES ('raw-old', 'p1')").run();
    db().prepare("INSERT INTO work_item_rejections (work_item_id, project_id) VALUES ('raw-old', 'p1')").run();
    db().prepare("INSERT INTO brain_document_reads (project_id, doc_key, item_id, mode, status, queued_at, updated_at) VALUES ('p1', 'file:x', 'raw-old', 'sample', 'skipped', 'a', 'a')").run();

    const result = await repair().run();

    expect(result).toMatchObject({ done: true, deleted: 1, recaptures: 0, deferred: 0, filesRemoved: 2 });
    expect(ids()).toEqual(['text-new']);
    expect(fs.existsSync(rawFile)).toBe(false);
    expect(fs.existsSync(auxBlob)).toBe(false);
    expect(count("SELECT COUNT(*) AS c FROM work_items_fts WHERE item_id = 'raw-old'")).toBe(0);
    for (const table of ['node_work_items WHERE work_item_id', 'item_ocr_lines WHERE item_id', 'failures WHERE item_id', 'work_item_project_events WHERE work_item_id', 'work_item_rejections WHERE work_item_id', 'brain_document_reads WHERE item_id']) {
      expect(count(`SELECT COUNT(*) AS c FROM ${table} = 'raw-old'`)).toBe(0);
    }
    // Links move to the newest text capture of the same file.
    expect(db().prepare("SELECT work_item_id AS id FROM agent_todos WHERE id = 't1'").get()).toEqual({ id: 'text-new' });
    expect(db().prepare('SELECT evidence_item_id AS id FROM project_cross_links').get()).toEqual({ id: 'text-new' });
    expect(db().pragma('foreign_key_check')).toEqual([]);
    expect(getSetting(db(), RAW_CAPTURE_REPAIR_KEY)).toMatchObject({ doneAt: '2026-10-05T12:00:00.000Z', deleted: 1, recaptures: 0 });
  });

  it('captures a watched file again when its newest capture was PDF bytes, through the pending lane', async () => {
    const ledger = createLocalFolderImportLedger(db());
    const onlyRaw = write(root, 'Documents/scan.pdf');
    const newerRaw = write(root, 'Documents/plan.pdf');
    const big = write(root, 'Documents/big.pdf', 2_000);
    const gone = path.join(root, 'Documents/deleted.pdf');
    const notWatched = write(outside, 'elsewhere.pdf');
    const paused = write(root, 'Documents/paused.pdf');
    const credential = write(root, 'Documents/held.pdf');
    capture('a', onlyRaw, { capturedAt: '2026-07-08T00:00:00Z', text: PDF_BYTES });
    capture('b-old', newerRaw, { capturedAt: '2026-07-08T00:00:00Z', text: 'the plan, version one' });
    capture('b-new', newerRaw, { capturedAt: '2026-08-04T00:00:00Z', text: PDF_BYTES });
    capture('c', big, { capturedAt: '2026-07-08T00:00:00Z', text: PDF_BYTES });
    capture('d', gone, { capturedAt: '2026-07-08T00:00:00Z', text: PDF_BYTES, state: 'noise', projectId: null });
    capture('e', notWatched, { capturedAt: '2026-07-08T00:00:00Z', text: PDF_BYTES, state: 'orphaned', projectId: null });
    capture('f', paused, { capturedAt: '2026-07-08T00:00:00Z', text: PDF_BYTES });
    capture('g', credential, { capturedAt: '2026-07-08T00:00:00Z', text: PDF_BYTES });
    ledger.record({ folderId: 1, path: paused, size: 100, mtimeMs: 1, outcome: 'owner_paused' });
    ledger.record({ folderId: 1, path: credential, size: 100, mtimeMs: 1, outcome: 'sensitive', reason: 'private key' });

    const result = await repair({ bigFileBytes: 1_000 }).run();

    expect(result).toMatchObject({ done: true, deleted: 7, recaptures: 3 });
    expect(ids()).toEqual(['b-old']);
    const queued = (db().prepare('SELECT path, outcome, origin, reason, size FROM local_folder_imports ORDER BY path').all() as Array<Record<string, unknown>>)
      .map((row) => ({ ...row, path: path.basename(String(row.path)) }));
    expect(queued).toEqual([
      { path: 'big.pdf', outcome: 'needs_review', origin: 'import', reason: RAW_RECAPTURE_REASON, size: 2_000 },
      { path: 'held.pdf', outcome: 'sensitive', origin: 'import', reason: 'private key', size: 100 },
      { path: 'paused.pdf', outcome: 'owner_paused', origin: 'import', reason: null, size: 100 },
      { path: 'plan.pdf', outcome: 'approved', origin: 'import', reason: RAW_RECAPTURE_REASON, size: 100 },
      { path: 'scan.pdf', outcome: 'approved', origin: 'import', reason: RAW_RECAPTURE_REASON, size: 100 },
    ]);
  });

  it('leaves a file whose rows may still be written, retries it later, and runs once', async () => {
    const pending = write(root, 'pending.pdf');
    const inWave = write(root, 'wave.pdf');
    capture('p', pending, { capturedAt: '2026-07-08T00:00:00Z', text: PDF_BYTES, state: 'captured', projectId: null });
    capture('w', inWave, { capturedAt: '2026-07-08T00:00:00Z', text: PDF_BYTES, state: 'extracted', projectId: null, batchId: 'wave-1' });
    capture('t', write(root, 'text.pdf'), { capturedAt: '2026-07-08T00:00:00Z', text: 'ordinary extracted text' });
    const first = await repair().run();
    expect(first).toMatchObject({ done: false, deleted: 0, deferred: 2 });
    expect(getSetting(db(), RAW_CAPTURE_REPAIR_KEY)).toBeNull();

    db().prepare("UPDATE work_items SET process_state = 'routed', project_id = 'p1', batch_id = NULL WHERE id IN ('p', 'w')").run();
    const second = await repair().run();
    expect(second).toMatchObject({ done: true, deleted: 2, deferred: 0 });
    expect(ids()).toEqual(['t']);

    capture('late', write(root, 'late.pdf'), { capturedAt: '2026-10-05T00:00:00Z', text: PDF_BYTES });
    expect(await repair().run()).toMatchObject({ done: true, deleted: 0 });
    expect(ids()).toContain('late');
  });

  it('stops when aborted and sets no marker', async () => {
    capture('a', write(root, 'a.pdf'), { capturedAt: '2026-07-08T00:00:00Z', text: PDF_BYTES });
    const controller = new AbortController();
    controller.abort();
    expect(await repair().run({ signal: controller.signal })).toMatchObject({ done: false, aborted: true, deleted: 0 });
    expect(getSetting(db(), RAW_CAPTURE_REPAIR_KEY)).toBeNull();
  });
});
