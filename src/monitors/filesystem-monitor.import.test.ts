import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createStorage, type StorageLayer } from '../core/storage.js';
import { addLocalFolder, getLocalFolder, type LocalFolder } from '../core/local-folders-config.js';
import type { DocumentParser } from '../core/document-parser.js';
import type { RawWorkItem } from '../core/types.js';
import type { DiskSpaceMonitor } from '../core/disk-space.js';
import {
  createLocalFolderImportLedger,
  directoryGlobForPath,
  isFirstImportDone,
  literalGlobForPath,
  type LocalFolderImportLedger,
} from '../core/local-folder-imports.js';
import {
  createFilesystemMonitor,
  type BackfillProgress,
  type CookedWatchEvents,
  type FilesystemMonitorWithImports,
  type WatchEngine,
} from './filesystem-monitor.js';

// Import ceiling for this file: 2,000 bytes (read at module load).
vi.hoisted(() => {
  process.env.LOCAL_FOLDERS_MAX_FILE_BYTES = '2000';
});

/**
 * Folder import walk (LOCAL_FOLDER_IMPORT_SAFETY_PLAN.md P1/P3): idempotent
 * and resumable through the ledger, awaited stores, the big-file gate for
 * walks and live changes, disk floors, exclusion pruning, one walk per
 * folder, and cooperative yields.
 */

const BIG = 500;
const THRESHOLDS = { bigFileBytes: BIG, importMinFreeBytes: 1_000, liveMinFreeBytes: 100 };

function parser(): DocumentParser {
  return {
    parse: vi.fn((filePath: string) => ({
      success: true,
      text: fs.readFileSync(filePath, 'utf-8'),
      filePath,
      fileType: path.extname(filePath),
    })),
    getSupportedFormats: () => ['.md', '.txt', '.csv'],
  } as unknown as DocumentParser;
}

function engineMocks() {
  const byPath = new Map<string, { row: LocalFolder; events: CookedWatchEvents; close: ReturnType<typeof vi.fn> }>();
  const engine = vi.fn((row: LocalFolder, events: CookedWatchEvents) => {
    const close = vi.fn(() => Promise.resolve());
    byPath.set(row.path, { row, events, close });
    return { close };
  }) as unknown as WatchEngine & ReturnType<typeof vi.fn>;
  return { engine, byPath };
}

function fakeDisk(state: { free: number }): DiskSpaceMonitor {
  return {
    cachedFreeBytes: () => state.free,
    freeBytes: async () => state.free,
    snapshot: () => ({ freeBytes: state.free, totalBytes: 1e12, measuredAt: 1 }),
  };
}

function write(root: string, rel: string, bytes: number, fill = 'x'): string {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, fill.repeat(bytes), 'utf-8');
  return full;
}

describe('folder import walk', () => {
  let storage: StorageLayer;
  let root: string;
  let folder: LocalFolder;
  let ledger: LocalFolderImportLedger;
  let mocks: ReturnType<typeof engineMocks>;
  let emitted: RawWorkItem[];
  let monitor: FilesystemMonitorWithImports | null;

  function makeMonitor(extra: Partial<Parameters<typeof createFilesystemMonitor>[0]> = {}) {
    const created = createFilesystemMonitor({
      db: storage.getDb(),
      documentParser: parser(),
      watchEngine: mocks.engine,
      ledger,
      thresholds: THRESHOLDS,
      yieldToLoop: () => Promise.resolve(),
      ...extra,
    });
    monitor = created;
    return created;
  }

  function addFolder(opts: { exclude_globs?: string[] } = {}): LocalFolder {
    const added = addLocalFolder(storage.getDb(), { path: root, ...opts });
    if (!added.ok) throw new Error(added.message);
    folder = added.folder;
    return folder;
  }

  beforeEach(() => {
    storage = createStorage(':memory:');
    storage.initialize();
    ledger = createLocalFolderImportLedger(storage.getDb());
    root = fs.mkdtempSync(path.join(os.homedir(), '.ppt-test-import-'));
    mocks = engineMocks();
    emitted = [];
    monitor = null;
  });

  afterEach(async () => {
    await monitor?.stop();
    fs.rmSync(root, { recursive: true, force: true });
    storage.close();
  });

  it('imports each file once, records it after the store, and skips unchanged files next time', async () => {
    write(root, 'a.md', 10);
    write(root, 'sub/b.txt', 20);
    write(root, 'sub/deep/c.csv', 30);
    addFolder();
    const m = makeMonitor();
    const stored: string[] = [];
    m.onWorkItem(async (item) => {
      emitted.push(item);
      await new Promise(resolve => setTimeout(resolve, 5));
      stored.push(String(item.metadata.filePath));
      // The ledger row appears only after the store completed.
      expect(ledger.get(folder.id, String(item.metadata.filePath))).toBeUndefined();
    });

    const first = await m.backfill(folder.id);
    expect(first).toMatchObject({ aborted: false, total: 3, imported: 3, unchanged: 0 });
    expect(stored).toHaveLength(3);
    expect(ledger.list(folder.id, ['imported'])).toHaveLength(3);
    expect(emitted.every(item => item.metadata.captureMode === 'backfill')).toBe(true);
    expect(isFirstImportDone(storage.getDb(), folder.id)).toBe(true);

    const second = await m.backfill(folder.id);
    expect(second).toMatchObject({ aborted: false, total: 3, imported: 0, unchanged: 3 });
    expect(emitted).toHaveLength(3);
  });

  it('resumes an interrupted import without duplicate captures', async () => {
    for (let i = 0; i < 5; i++) write(root, `f${i}.md`, 10 + i);
    addFolder();
    const controller = new AbortController();
    const first = makeMonitor();
    first.onWorkItem((item) => {
      emitted.push(item);
      if (emitted.length === 2) controller.abort();
    });
    const phases: string[] = [];
    const interrupted = await first.backfill(folder.id, { signal: controller.signal, onProgress: p => phases.push(p.phase) });
    expect(interrupted).toEqual({ aborted: true });
    expect(phases.at(-1)).toBe('aborted');
    expect(isFirstImportDone(storage.getDb(), folder.id)).toBe(false);
    expect(ledger.list(folder.id, ['imported'])).toHaveLength(2);
    await first.stop();

    // A new process: in-memory dedup is gone; only the ledger remains.
    const second = makeMonitor();
    second.onWorkItem(item => { emitted.push(item); });
    const resumed = await second.backfill(folder.id);
    expect(resumed).toMatchObject({ imported: 3, unchanged: 2 });
    const paths = emitted.map(item => item.metadata.filePath);
    expect(new Set(paths).size).toBe(5);
    expect(paths).toHaveLength(5);
  });

  it('skips files captured before the ledger existed, but re-captures content-removed stubs', async () => {
    const kept = write(root, 'kept.md', 12);
    const removed = write(root, 'removed.md', 14);
    const fresh = write(root, 'fresh.md', 16);
    addFolder();
    const insert = storage.getDb().prepare(`INSERT INTO work_items (id, type, source, file_path, metadata, captured_at)
      VALUES (?, 'document_capture', 'filesystem', ?, ?, '2026-09-30T00:00:00.000Z')`);
    const sig = (p: string) => { const s = fs.statSync(p); return { size: String(s.size), mtime: String(s.mtimeMs) }; };
    insert.run('old-1', kept, JSON.stringify(sig(kept)));
    insert.run('old-2', removed, JSON.stringify({ ...sig(removed), contentRemoved: { bytes: 14 } }));
    const m = makeMonitor();
    m.onWorkItem(item => { emitted.push(item); });
    const result = await m.backfill(folder.id);
    expect(result).toMatchObject({ imported: 2, unchanged: 1 });
    expect(emitted.map(item => item.metadata.filePath).sort()).toEqual([fresh, removed].sort());
  });

  it('leaves a file unrecorded when its store fails, so the next walk retries it', async () => {
    const target = write(root, 'x.md', 10);
    addFolder();
    const m = makeMonitor();
    let failNext = true;
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    m.onWorkItem(async (item) => {
      emitted.push(item);
      if (failNext) { failNext = false; throw new Error('SQLITE_FULL'); }
    });
    const failed = await m.backfill(folder.id);
    expect(failed).toMatchObject({ imported: 0, failed: 1 });
    expect(ledger.get(folder.id, target)).toBeUndefined();
    const retried = await m.backfill(folder.id);
    expect(retried).toMatchObject({ imported: 1, failed: 0 });
    expect(ledger.get(folder.id, target)?.outcome).toBe('imported');
    expect(emitted).toHaveLength(2);
    errors.mockRestore();
  });

  it('holds big files for review in walks and live changes, and imports them once kept', async () => {
    const big = write(root, 'data/big.csv', 600);
    const huge = write(root, 'data/huge.csv', 3_000);
    const small = write(root, 'small.md', 10);
    addFolder();
    const m = makeMonitor();
    m.onWorkItem(item => { emitted.push(item); });
    const walk = await m.backfill(folder.id);
    expect(walk).toMatchObject({ imported: 1, needsReview: 1, tooLarge: 1 });
    expect(emitted.map(item => item.metadata.filePath)).toEqual([small]);
    expect(ledger.get(folder.id, big)).toMatchObject({ outcome: 'needs_review', origin: 'import' });
    expect(ledger.get(folder.id, huge)?.outcome).toBe('too_large');

    await m.start();
    const live = mocks.byPath.get(root)!.events;
    const big2 = write(root, 'data/big2.csv', 700);
    live.onAddOrChange(big2);
    expect(emitted).toHaveLength(1);
    expect(ledger.get(folder.id, big2)).toMatchObject({ outcome: 'needs_review', origin: 'live' });

    ledger.setOutcome(folder.id, big, 'approved');
    ledger.setOutcome(folder.id, big2, 'approved');
    const pending = ledger.list(folder.id, ['approved']);
    const imported = await m.importFiles(folder.id, pending);
    expect(imported).toMatchObject({ aborted: false, imported: 2, held: 0 });
    const byPath = new Map(emitted.map(item => [item.metadata.filePath, item.metadata.captureMode]));
    expect(byPath.get(big)).toBe('backfill');
    expect(byPath.get(big2)).toBe('live');
    expect(ledger.get(folder.id, big)?.outcome).toBe('imported');

    // A kept big file stays kept: its later live change is captured.
    fs.appendFileSync(big, 'more');
    live.onAddOrChange(big);
    expect(emitted.filter(item => item.metadata.filePath === big)).toHaveLength(2);
  });

  it('drops a pending row whose file is no longer a capture candidate', async () => {
    const video = write(root, 'clip.mp4', 600);
    addFolder();
    ledger.record({ folderId: folder.id, path: video, size: 600, mtimeMs: fs.statSync(video).mtimeMs, outcome: 'approved' });
    const m = makeMonitor();
    m.onWorkItem(item => { emitted.push(item); });
    expect(await m.importFiles(folder.id, ledger.list(folder.id, ['approved']))).toMatchObject({ imported: 0, held: 0 });
    expect(ledger.get(folder.id, video)).toBeUndefined();
    expect(emitted).toHaveLength(0);
  });

  it('pauses below the import floor and defers live changes below the live floor', async () => {
    write(root, 'a.md', 10);
    addFolder();
    const disk = { free: 500 };
    const m = makeMonitor({ diskSpace: fakeDisk(disk) });
    m.onWorkItem(item => { emitted.push(item); });
    const progress: BackfillProgress[] = [];
    const paused = await m.backfill(folder.id, { onProgress: p => progress.push(p) });
    expect(paused).toMatchObject({ aborted: false, paused: 'low_disk', imported: 0 });
    expect(progress.at(-1)).toMatchObject({ phase: 'paused', reason: 'low_disk', freeBytes: 500 });
    expect(isFirstImportDone(storage.getDb(), folder.id)).toBe(false);
    expect(emitted).toHaveLength(0);

    await m.start();
    disk.free = 50;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const change = write(root, 'live.md', 12);
    mocks.byPath.get(root)!.events.onAddOrChange(change);
    expect(emitted).toHaveLength(0);
    expect(ledger.get(folder.id, change)).toMatchObject({ outcome: 'deferred_low_disk', origin: 'live' });
    expect(warn.mock.calls.flat().join(' ')).toContain('live folder captures are deferred');
    warn.mockRestore();

    disk.free = 5_000;
    const result = await m.importFiles(folder.id, ledger.list(folder.id, ['deferred_low_disk']));
    expect(result).toMatchObject({ imported: 1 });
    expect(emitted[0].metadata).toMatchObject({ filePath: change, captureMode: 'live' });
    expect(ledger.get(folder.id, change)?.outcome).toBe('imported');
  });

  it('prunes excluded subtrees and literal files, including names with wildcard characters', async () => {
    const keep = write(root, 'keep.md', 10);
    const odd = write(root, 'odd*name?.md', 10);
    write(root, 'skip/inner.md', 10);
    write(root, 'skip/deeper/inner2.md', 10);
    const data = write(root, 'data/x.md', 10);
    addFolder({ exclude_globs: [literalGlobForPath(odd), directoryGlobForPath(path.join(root, 'skip'))] });
    const readdir = vi.spyOn(fs.promises, 'readdir');
    const m = makeMonitor();
    m.onWorkItem(item => { emitted.push(item); });
    const result = await m.backfill(folder.id);
    expect(emitted.map(item => item.metadata.filePath).sort()).toEqual([data, keep].sort());
    expect(result).toMatchObject({ total: 2 });
    const readDirs = readdir.mock.calls.map(call => String(call[0]));
    expect(readDirs).toEqual(expect.arrayContaining([root, path.join(root, 'data')]));
    expect(readDirs.some(dir => dir.startsWith(path.join(root, 'skip')))).toBe(false);
    readdir.mockRestore();
  });

  it('re-attaches the watcher when engine configuration changes and applies other row changes in place', async () => {
    addFolder();
    const m = makeMonitor();
    m.onWorkItem(item => { emitted.push(item); });
    await m.setWatchedFolders([folder]);
    expect(mocks.engine).toHaveBeenCalledTimes(1);
    const firstClose = mocks.byPath.get(root)!.close;

    await m.setWatchedFolders([{ ...folder, id: 99, include_globs: ['*.md'] }]);
    expect(mocks.engine).toHaveBeenCalledTimes(1);
    const note = write(root, 'n.md', 5);
    mocks.byPath.get(root)!.events.onAddOrChange(note);
    expect(emitted[0].metadata.localFolderId).toBe('99');

    await m.setWatchedFolders([{ ...folder, exclude_globs: ['*.bak'] }]);
    expect(mocks.engine).toHaveBeenCalledTimes(2);
    expect(firstClose).toHaveBeenCalledTimes(1);
    expect(mocks.byPath.get(root)!.row.exclude_globs).toEqual(['*.bak']);
  });

  it('allows one walk per folder at a time', async () => {
    write(root, 'a.md', 10);
    write(root, 'b.md', 11);
    addFolder();
    const m = makeMonitor();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    m.onWorkItem(async (item) => { emitted.push(item); await gate; });
    const running = m.backfill(folder.id);
    await vi.waitFor(() => expect(emitted).toHaveLength(1));
    expect(m.isWalking(folder.id)).toBe(true);
    expect(m.walkState(folder.id)).toMatchObject({ kind: 'import', processed: 1 });
    const progress: BackfillProgress[] = [];
    expect(await m.backfill(folder.id, { onProgress: p => progress.push(p) })).toMatchObject({ busy: true, total: 0 });
    expect(progress[0]).toMatchObject({ phase: 'error', reason: 'busy' });
    expect(await m.scanFolder(folder.id)).toMatchObject({ busy: true });
    release();
    expect(await running).toMatchObject({ imported: 2 });
    expect(m.isWalking(folder.id)).toBe(false);
  });

  it('scans without reading content and forgets rows for files that are gone', async () => {
    const big = write(root, 'data/big.csv', 600);
    write(root, 'data/huge.csv', 3_000);
    write(root, 'small.md', 10);
    write(root, 'movie.mp4', 10);
    addFolder();
    const documentParser = parser();
    const m = makeMonitor({ documentParser });
    const scan = await m.scanFolder(folder.id);
    expect(scan).toMatchObject({ aborted: false, walked: 4, files: 3, importable: 1, needsReview: 1, tooLarge: 1 });
    expect(documentParser.parse).not.toHaveBeenCalled();
    expect(ledger.counts(folder.id)).toMatchObject({ needs_review: 1, too_large: 1 });

    fs.rmSync(big);
    const rescan = await m.scanFolder(folder.id);
    expect(rescan).toMatchObject({ needsReview: 0, tooLarge: 1 });
    expect(ledger.get(folder.id, big)).toBeUndefined();
  });

  it('yields to the event loop between files and labels import work for the watchdog', async () => {
    write(root, 'a.md', 10);
    write(root, 'b.md', 10);
    write(root, 'c.md', 10);
    addFolder();
    const yieldToLoop = vi.fn(() => Promise.resolve());
    const labels: string[] = [];
    const watchdog = {
      start() {}, stop() {},
      measure: <T>(label: string, fn: () => T) => { labels.push(label); return fn(); },
      stats: () => ({ enabled: false, p99Ms: null, maxMs: null, stallCount: 0, recentStalls: [] }),
    };
    const m = makeMonitor({ yieldToLoop, watchdog });
    m.onWorkItem(item => { emitted.push(item); });
    await m.backfill(folder.id);
    expect(yieldToLoop.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(labels.filter(label => label === 'folder-import')).toHaveLength(3);
    expect(getLocalFolder(storage.getDb(), folder.id)).not.toBeNull();
  });
});
