import fs from 'fs';
import os from 'os';
import path from 'path';
import { createStorage, type StorageLayer } from '../core/storage.js';
import { addLocalFolder, type LocalFolder } from '../core/local-folders-config.js';
import type { DocumentParser } from '../core/document-parser.js';
import type { RawWorkItem } from '../core/types.js';
import { createLocalFolderImportLedger, type LocalFolderImportLedger } from '../core/local-folder-imports.js';
import { REFERENCE_HEAD_BYTES } from '../core/file-references.js';
import {
  createFilesystemMonitor,
  type CookedWatchEvents,
  type FilesystemMonitorWithImports,
  type WatchEngine,
} from './filesystem-monitor.js';

// Import ceiling for this file: 2,000 bytes (read at module load).
vi.hoisted(() => {
  process.env.LOCAL_FOLDERS_MAX_FILE_BYTES = '2000';
});

/**
 * Data and code files are references (owner decision 2026-10-04): emitted
 * as one `file_reference` built from the first 64 KB at most, at any size,
 * without the import ceiling, the big-file review, or the disk floors. The
 * credential checks still run first, and an owner pause still holds.
 */

const BIG = 500;
const THRESHOLDS = { bigFileBytes: BIG, importMinFreeBytes: 1_000, liveMinFreeBytes: 100 };

describe('data and code files as references', () => {
  let storage: StorageLayer;
  let root: string;
  let folder: LocalFolder;
  let ledger: LocalFolderImportLedger;
  let emitted: RawWorkItem[];
  let monitor: FilesystemMonitorWithImports | null;
  let live: CookedWatchEvents | null;
  let parse: ReturnType<typeof vi.fn>;
  const disk = { free: 1e12 };

  function makeMonitor(): FilesystemMonitorWithImports {
    parse = vi.fn((filePath: string) => ({ success: true, text: fs.readFileSync(filePath, 'utf-8'), filePath, fileType: path.extname(filePath) }));
    const engine = vi.fn((_row: LocalFolder, events: CookedWatchEvents) => {
      live = events;
      return { close: vi.fn(() => Promise.resolve()) };
    }) as unknown as WatchEngine;
    monitor = createFilesystemMonitor({
      db: storage.getDb(),
      documentParser: { parse, getSupportedFormats: () => ['.md', '.txt', '.csv', '.json'] } as unknown as DocumentParser,
      watchEngine: engine,
      ledger,
      thresholds: THRESHOLDS,
      diskSpace: { cachedFreeBytes: () => disk.free, freeBytes: async () => disk.free, snapshot: () => ({ freeBytes: disk.free, totalBytes: 1e12, measuredAt: 1 }) },
      yieldToLoop: () => Promise.resolve(),
    });
    monitor.onWorkItem(item => { emitted.push(item); });
    return monitor;
  }

  function write(rel: string, text: string): string {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, text, 'utf-8');
    return full;
  }

  beforeEach(() => {
    storage = createStorage(':memory:');
    storage.initialize();
    ledger = createLocalFolderImportLedger(storage.getDb());
    root = fs.mkdtempSync(path.join(os.homedir(), '.ppt-test-refs-'));
    emitted = [];
    monitor = null;
    live = null;
    disk.free = 1e12;
    const added = addLocalFolder(storage.getDb(), { path: root });
    if (!added.ok) throw new Error(added.message);
    folder = added.folder;
  });

  afterEach(async () => {
    await monitor?.stop();
    fs.rmSync(root, { recursive: true, force: true });
    storage.close();
  });

  it('records a data file of any size from its first 64 KB, in walks and live changes', async () => {
    const tail = `"tail_marker_key": 1}`;
    const huge = write('runs/metrics.json', `{"epoch": 3, "loss": 0.12, "pad": "${'x'.repeat(REFERENCE_HEAD_BYTES * 2)}", ${tail}`);
    const m = makeMonitor();
    const walk = await m.backfill(folder.id);

    expect(walk).toMatchObject({ imported: 1, tooLarge: 0, needsReview: 0 });
    expect(emitted).toHaveLength(1);
    const [reference] = emitted;
    expect(reference.type).toBe('file_reference');
    expect(reference.metadata).toMatchObject({ filePath: huge, fileRole: 'data', format: 'JSON', outlineLabel: 'Top-level keys', outline: 'epoch, loss, pad' });
    expect(reference.content).not.toContain('tail_marker_key');
    expect(reference.content).toContain('without reading it');
    expect(parse).not.toHaveBeenCalled();
    expect(ledger.get(folder.id, huge)?.outcome).toBe('imported');

    // Live: a big CSV is recorded at once, never held for review or disk.
    disk.free = 50;
    await m.start();
    const table = write('runs/table.csv', `user_id,score\n${'1,0.5\n'.repeat(400)}`);
    live!.onAddOrChange(table);
    expect(emitted.map(item => [item.type, item.metadata.filePath])).toEqual([
      ['file_reference', huge],
      ['file_reference', table],
    ]);
    expect(emitted[1].metadata).toMatchObject({ outline: 'user_id, score', captureMode: 'live' });
    await vi.waitFor(() => expect(ledger.get(folder.id, table)).toMatchObject({ outcome: 'imported', origin: 'live' }));
  });

  it('records code files with their opening comment and the names they define', async () => {
    const script = write('src/train.py', '"""Train the catalog model."""\n\ndef main():\n    pass\n');
    const m = makeMonitor();
    await m.backfill(folder.id);
    expect(emitted[0]).toMatchObject({ type: 'file_reference', title: 'train.py' });
    expect(emitted[0].metadata).toMatchObject({ filePath: script, fileRole: 'code', format: 'Python', header: 'Train the catalog model.', outline: 'main', lines: '4' });
    expect(String(emitted[0].metadata.summary)).toBe('Python code, 53 B, 4 lines. Train the catalog model. Defines: main');
  });

  it('holds a data file whose first 64 KB holds a secret, and never emits it', async () => {
    // Built from split parts at run time: no token-shaped literal in the repo.
    const token = ['gh', 'p_', 'Zq7Lm2Xc9Vb4Nt6Rw1Ky8Hs3Jd5Fg0Pa1QeT'].join('');
    const leaked = write('config/settings.json', `{"github": "${token}", "region": "us-east-1"}`);
    const m = makeMonitor();
    const walk = await m.backfill(folder.id);
    expect(walk).toMatchObject({ imported: 0, sensitive: 1 });
    expect(emitted).toHaveLength(0);
    expect(ledger.get(folder.id, leaked)).toMatchObject({ outcome: 'sensitive', reason: 'Contains what looks like a GitHub token' });
    // That version stays held on the next walk without another read.
    expect(await m.backfill(folder.id)).toMatchObject({ imported: 0, sensitive: 1 });
  });

  it('converts a data file an older build captured in full or held as too large', async () => {
    const captured = write('old/results.json', '{"rows": 3}');
    const held = write('old/huge.jsonl', `{"id": 1}\n${'{"id": 2}\n'.repeat(400)}`);
    const sig = (file: string) => { const stat = fs.statSync(file); return { size: stat.size, mtimeMs: stat.mtimeMs }; };
    // The old full capture: a ledger "imported" row and a document_capture with the same signature.
    ledger.record({ folderId: folder.id, path: captured, ...sig(captured), outcome: 'imported' });
    storage.getDb().prepare(`INSERT INTO work_items (id, type, source, file_path, metadata, captured_at)
      VALUES ('legacy', 'document_capture', 'filesystem', ?, ?, '2026-09-30T00:00:00.000Z')`)
      .run(captured, JSON.stringify({ size: String(sig(captured).size), mtime: String(sig(captured).mtimeMs) }));
    ledger.record({ folderId: folder.id, path: held, ...sig(held), outcome: 'too_large' });
    const m = makeMonitor();
    const walk = await m.backfill(folder.id);
    expect(walk).toMatchObject({ imported: 2, tooLarge: 0 });
    expect(emitted.map(item => [path.basename(String(item.metadata.filePath)), item.type]).sort()).toEqual([
      ['huge.jsonl', 'file_reference'],
      ['results.json', 'file_reference'],
    ]);
    expect(ledger.get(folder.id, held)?.outcome).toBe('imported');
    const scan = await m.scanFolder(folder.id);
    expect(scan).toMatchObject({ tooLarge: 0, needsReview: 0 });
  });

  it('keeps an owner-paused data file paused', async () => {
    const progress = write('dashboard/training-progress.json', '{"epoch": 1}');
    ledger.record({ folderId: folder.id, path: progress, size: 1, mtimeMs: 1, outcome: 'owner_paused' });
    const m = makeMonitor();
    await m.start();
    live!.onAddOrChange(progress);
    expect(await m.backfill(folder.id)).toMatchObject({ imported: 0 });
    expect(emitted).toHaveLength(0);
    expect(ledger.get(folder.id, progress)?.outcome).toBe('owner_paused');
  });

  it('marks a deleted data file\'s reference archived instead of recording a deletion', async () => {
    const data = write('runs/a.json', '{"a": 1}');
    const m = makeMonitor();
    await m.start();
    live!.onAddOrChange(data);
    fs.rmSync(data);
    live!.onUnlink(data);
    expect(emitted.map(item => [item.type, item.metadata.archived ?? null])).toEqual([
      ['file_reference', null],
      ['file_reference', 'true'],
    ]);

    // A name with no extension: archived only when a reference exists for it.
    const blob = write('cache/0123456789abcdef0123456789abcdef', 'binary-ish');
    storage.getDb().prepare(`INSERT INTO work_items (id, type, source, file_path, captured_at, process_state)
      VALUES ('ref-blob', 'file_reference', 'filesystem', ?, '2026-10-04T00:00:00Z', 'orphaned')`).run(blob);
    live!.onAddOrChange(blob);
    fs.rmSync(blob);
    live!.onUnlink(blob);
    expect(emitted.at(-1)).toMatchObject({ type: 'file_reference', metadata: { filePath: blob, archived: 'true' } });
  });

  it('sniffs a big file with no extension, so a hash-named blob never waits for review', async () => {
    const blob = write('models/blobs/3f8a9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b', `\u0000\u0001${'w'.repeat(BIG * 2)}`);
    const readme = write('models/README', 'Notes on the model cache.');
    const m = makeMonitor();
    const scan = await m.scanFolder(folder.id);
    expect(scan).toMatchObject({ importable: 2, needsReview: 0, tooLarge: 0 });
    const walk = await m.backfill(folder.id);
    expect(walk).toMatchObject({ imported: 2, needsReview: 0 });
    const byPath = new Map(emitted.map(item => [item.metadata.filePath, item]));
    expect(byPath.get(blob)).toMatchObject({ type: 'file_reference', metadata: { fileRole: 'data', format: 'Binary' } });
    expect(byPath.get(readme)?.type).toBe('document_capture');
  });
});
