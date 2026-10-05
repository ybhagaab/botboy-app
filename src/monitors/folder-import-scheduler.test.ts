import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createStorage, type StorageLayer } from '../core/storage.js';
import { addLocalFolder, getLocalFolder, type LocalFolder } from '../core/local-folders-config.js';
import type { DocumentParser } from '../core/document-parser.js';
import type { RawWorkItem } from '../core/types.js';
import type { ShutdownRuntimeContext, ShutdownWorkRegistration } from '../core/shutdown-coordinator.js';
import {
  createLocalFolderImportLedger,
  isFirstImportDone,
  isReferenceWalkDone,
  literalGlobForPath,
  markFirstImportDone,
  markReferenceWalkDone,
  type LocalFolderImportLedger,
} from '../core/local-folder-imports.js';
import { createFilesystemMonitor, type FilesystemMonitorWithImports, type WatchEngine } from './filesystem-monitor.js';
import { createFolderImportScheduler, type FolderImportScheduler } from './folder-import-scheduler.js';
import { createRawCaptureRepair } from '../core/raw-capture-repair.js';

vi.hoisted(() => {
  process.env.LOCAL_FOLDERS_MAX_FILE_BYTES = '2000';
});

/**
 * Post-ready folder import scheduler (LOCAL_FOLDER_IMPORT_SAFETY_PLAN.md
 * C1/C7/C8): nothing runs before `start()` + delay; a folder with an
 * undecided big file waits (small files too) while live watching continues;
 * the owner's decision is validated all-or-nothing, stored as literal
 * exclusion globs, and resumes the import; low disk pauses; shutdown aborts.
 */

const THRESHOLDS = { bigFileBytes: 500, importMinFreeBytes: 1_000, liveMinFreeBytes: 100 };

function parser(): DocumentParser {
  return {
    parse: (filePath: string) => ({ success: true, text: fs.readFileSync(filePath, 'utf-8'), filePath, fileType: path.extname(filePath) }),
    getSupportedFormats: () => ['.md', '.txt', '.csv'],
  } as unknown as DocumentParser;
}

const engine = vi.fn(() => ({ close: vi.fn() })) as unknown as WatchEngine;

function write(root: string, rel: string, bytes: number): string {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, 'x'.repeat(bytes), 'utf-8');
  return full;
}

function fakeShutdown() {
  const registered: ShutdownWorkRegistration[] = [];
  let shuttingDown = false;
  const context: ShutdownRuntimeContext = {
    signal: new AbortController().signal,
    isShuttingDown: () => shuttingDown,
    registerWork(work) {
      registered.push(work);
      return () => { const i = registered.indexOf(work); if (i >= 0) registered.splice(i, 1); };
    },
  };
  return { context, registered, begin: () => { shuttingDown = true; for (const work of [...registered]) work.abort?.(); } };
}

describe('folder import scheduler', () => {
  let storage: StorageLayer;
  let root: string;
  let ledger: LocalFolderImportLedger;
  let monitor: FilesystemMonitorWithImports;
  let scheduler: FolderImportScheduler | null;
  let emitted: RawWorkItem[];
  const disk = { free: 1e12 };

  function build(extra: Partial<Parameters<typeof createFolderImportScheduler>[0]> = {}) {
    scheduler = createFolderImportScheduler({
      db: storage.getDb(),
      monitor,
      ledger,
      thresholds: THRESHOLDS,
      diskSpace: { cachedFreeBytes: () => disk.free, freeBytes: async () => disk.free, snapshot: () => ({ freeBytes: disk.free, totalBytes: 1e12, measuredAt: 1 }) },
      startDelayMs: 20,
      retryMs: 40,
      idleMs: 60_000,
      ...extra,
    });
    return scheduler;
  }

  function addFolder(dir = root): LocalFolder {
    const added = addLocalFolder(storage.getDb(), { path: dir });
    if (!added.ok) throw new Error(added.message);
    return added.folder;
  }

  beforeEach(() => {
    storage = createStorage(':memory:');
    storage.initialize();
    ledger = createLocalFolderImportLedger(storage.getDb());
    root = fs.mkdtempSync(path.join(os.homedir(), '.ppt-test-sched-'));
    disk.free = 1e12;
    emitted = [];
    monitor = createFilesystemMonitor({
      db: storage.getDb(), documentParser: parser(), watchEngine: engine, ledger, thresholds: THRESHOLDS,
      diskSpace: { cachedFreeBytes: () => disk.free, freeBytes: async () => disk.free, snapshot: () => ({ freeBytes: disk.free, totalBytes: 1e12, measuredAt: 1 }) },
      yieldToLoop: () => Promise.resolve(),
    });
    monitor.onWorkItem(item => { emitted.push(item); });
    scheduler = null;
  });

  afterEach(async () => {
    scheduler?.stop();
    await scheduler?.drain();
    await monitor.stop();
    fs.rmSync(root, { recursive: true, force: true });
    storage.close();
  });

  it('does no folder work before start, then imports a folder without big files', async () => {
    write(root, 'a.md', 10);
    write(root, 'sub/b.md', 12);
    const folder = addFolder();
    const s = build();
    s.kick();
    await new Promise(resolve => setTimeout(resolve, 80));
    expect(emitted).toHaveLength(0);
    expect(s.status().folders[0]).toMatchObject({ phase: 'waiting', firstImportDone: false });
    expect(s.status().started).toBe(false);

    s.start();
    await vi.waitFor(() => expect(isFirstImportDone(storage.getDb(), folder.id)).toBe(true), { timeout: 3_000 });
    expect(emitted).toHaveLength(2);
    expect(s.status().folders[0]).toMatchObject({ phase: 'watching', lastResult: { kind: 'import', imported: 2 } });
  });

  it('holds the whole first import for an undecided big file, then imports after the owner decides', async () => {
    const small = write(root, 'notes/small.md', 10);
    const keep = write(root, 'data/keep.txt', 600);
    const drop = write(root, 'data/drop.txt', 700);
    const huge = write(root, 'data/huge.txt', 3_000);
    const folder = addFolder();
    const s = build();
    s.start();
    await vi.waitFor(() => expect(s.status().folders[0].phase).toBe('needs_review'), { timeout: 3_000 });
    expect(emitted).toHaveLength(0);
    expect(isFirstImportDone(storage.getDb(), folder.id)).toBe(false);

    const review = s.review(folder.id)!;
    expect(review.undecided).toBe(2);
    expect(review.files.map(file => [file.relPath, file.dir, file.decision, file.readable])).toEqual([
      [path.join('data', 'drop.txt'), 'data', 'undecided', true],
      [path.join('data', 'keep.txt'), 'data', 'undecided', true],
    ]);
    expect(review.tooLarge.map(file => file.path)).toEqual([huge]);

    const result = await s.decide(folder.id, { keep: [keep], exclude: [drop] });
    expect(result).toMatchObject({ ok: true, applied: { kept: 1, excluded: 1 } });
    expect(getLocalFolder(storage.getDb(), folder.id)!.exclude_globs).toEqual([literalGlobForPath(drop)]);

    await vi.waitFor(() => expect(isFirstImportDone(storage.getDb(), folder.id)).toBe(true), { timeout: 3_000 });
    const imported = emitted.map(item => item.metadata.filePath).sort();
    expect(imported).toEqual([keep, small].sort());
    expect(ledger.get(folder.id, drop)?.outcome).toBe('excluded');
    expect(s.status().folders[0]).toMatchObject({ phase: 'watching', excludedEntries: 1 });
    const after = s.review(folder.id)!;
    expect(after.files.map(file => [file.name, file.decision, file.imported])).toEqual([
      ['drop.txt', 'exclude', false],
      ['keep.txt', 'keep', true],
    ]);
  });

  it('rejects an invalid decision as a whole and names every bad entry', async () => {
    write(root, 'data/a.txt', 600);
    const folder = addFolder();
    const s = build();
    await monitor.scanFolder(folder.id);
    const inside = path.join(root, 'data', 'a.txt');
    const before = getLocalFolder(storage.getDb(), folder.id)!.exclude_globs;
    const result = await s.decide(folder.id, {
      keep: [inside, '/etc/passwd', path.join(root, 'unknown.txt')],
      exclude: [inside],
      restoreDirs: [path.join(root, 'never-excluded')],
      excludeDirs: [root],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(400);
    expect(result.nextAction).toContain('Reload');
    const reasons = result.invalid!.map(entry => `${path.basename(entry.path)}: ${entry.reason}`);
    expect(reasons).toEqual(expect.arrayContaining([
      'passwd: is not a file inside this folder',
      'unknown.txt: is not in this folder’s big-file list',
      'a.txt: is marked both import and exclude',
      'never-excluded: is not an excluded subfolder of this folder',
      `${path.basename(root)}: is not a subfolder inside this folder`,
    ]));
    expect(getLocalFolder(storage.getDb(), folder.id)!.exclude_globs).toEqual(before);
    expect(ledger.get(folder.id, inside)?.outcome).toBe('needs_review');
    expect(await s.decide(folder.id, {})).toMatchObject({ ok: false, status: 400 });
    expect(await s.decide(999, { keep: [inside] })).toMatchObject({ ok: false, status: 404 });
  });

  it('excludes and restores whole subfolders; a restore re-walks the folder', async () => {
    const big = write(root, 'registry/model.bin2', 800);
    const smallInside = write(root, 'registry/readme.md', 10);
    write(root, 'top.md', 10);
    const folder = addFolder();
    const s = build();
    s.start();
    await vi.waitFor(() => expect(s.status().folders[0].phase).toBe('needs_review'), { timeout: 3_000 });
    expect(s.review(folder.id)!.files[0]).toMatchObject({ path: big, readable: false });

    const registry = path.join(root, 'registry');
    expect(await s.decide(folder.id, { excludeDirs: [registry] })).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(isFirstImportDone(storage.getDb(), folder.id)).toBe(true), { timeout: 3_000 });
    expect(emitted.map(item => path.basename(String(item.metadata.filePath)))).toEqual(['top.md']);
    expect(s.review(folder.id)!.excludedDirs).toEqual([{ path: registry, relPath: 'registry', files: 1 }]);
    expect(await s.decide(folder.id, { keep: [big] })).toMatchObject({ ok: false, status: 400 });

    expect(await s.decide(folder.id, { restoreDirs: [registry] })).toMatchObject({ ok: true });
    expect(getLocalFolder(storage.getDb(), folder.id)!.exclude_globs).toEqual([]);
    await vi.waitFor(() => expect(s.status().folders[0].phase).toBe('needs_review'), { timeout: 3_000 });
    expect(ledger.get(folder.id, big)?.outcome).toBe('needs_review');
    expect(await s.decide(folder.id, { keep: [big] })).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(emitted.map(item => item.metadata.filePath)).toEqual(expect.arrayContaining([big, smallInside])), { timeout: 3_000 });
    expect(emitted).toHaveLength(3);
  });

  it('imports one folder at a time', async () => {
    const other = fs.mkdtempSync(path.join(os.homedir(), '.ppt-test-sched-b-'));
    try {
      write(root, 'a.md', 10);
      write(other, 'b.md', 10);
      addFolder();
      addFolder(other);
      let active = 0;
      let maxActive = 0;
      const original = monitor.backfill.bind(monitor);
      monitor.backfill = async (id, opts) => {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise(resolve => setTimeout(resolve, 30));
        try { return await original(id, opts); } finally { active--; }
      };
      const s = build();
      s.start();
      await vi.waitFor(() => expect(emitted).toHaveLength(2), { timeout: 3_000 });
      expect(maxActive).toBe(1);
    } finally {
      fs.rmSync(other, { recursive: true, force: true });
    }
  });

  it('pauses below the import floor and resumes when space returns', async () => {
    write(root, 'a.md', 10);
    const folder = addFolder();
    disk.free = 500;
    const s = build();
    s.start();
    await vi.waitFor(() => expect(s.status().folders[0].phase).toBe('paused_low_disk'), { timeout: 3_000 });
    expect(s.status().disk).toMatchObject({ importsPaused: true, liveCapturesPaused: false });
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(emitted).toHaveLength(0);
    disk.free = 1e12;
    await vi.waitFor(() => expect(isFirstImportDone(storage.getDb(), folder.id)).toBe(true), { timeout: 3_000 });
    expect(emitted).toHaveLength(1);
  });

  it('registers each pass with shutdown, and a shutdown aborts the active walk', async () => {
    for (let i = 0; i < 20; i++) write(root, `f${i}.md`, 10 + i);
    const folder = addFolder();
    const shutdown = fakeShutdown();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    monitor.onWorkItem(async () => { await gate; });
    const s = build({ shutdown: shutdown.context });
    s.start();
    await vi.waitFor(() => expect(emitted.length).toBe(1), { timeout: 3_000 });
    expect(shutdown.registered.map(work => work.kind)).toEqual(['local_folder_import']);
    expect(s.isFolderBusy(folder.id)).toBe(true);
    shutdown.begin();
    s.stop();
    release();
    await s.drain();
    expect(emitted.length).toBeLessThan(20);
    expect(isFirstImportDone(storage.getDb(), folder.id)).toBe(false);
    expect(shutdown.registered).toHaveLength(0);
    expect(s.isFolderBusy(folder.id)).toBe(false);
  });

  it('forgets a deleted folder and never re-imports a folder whose first import is done', async () => {
    write(root, 'a.md', 10);
    const folder = addFolder();
    markFirstImportDone(storage.getDb(), folder.id);
    markReferenceWalkDone(storage.getDb(), folder.id);
    ledger.record({ folderId: folder.id, path: path.join(root, 'a.md'), size: 10, mtimeMs: 1, outcome: 'too_large' });
    const s = build();
    s.start();
    await new Promise(resolve => setTimeout(resolve, 120));
    expect(emitted).toHaveLength(0);
    s.forgetFolder(folder.id);
    expect(ledger.list(folder.id)).toEqual([]);
    expect(isFirstImportDone(storage.getDb(), folder.id)).toBe(false);
    expect(isReferenceWalkDone(storage.getDb(), folder.id)).toBe(false);
  });

  it('converts stored data and code versions before any folder walk, and retries a deferred conversion', async () => {
    write(root, 'a.md', 10);
    const folder = addFolder();
    const calls: string[] = [];
    let runs = 0;
    const referenceMigration = {
      isDone: () => runs >= 2,
      run: vi.fn(async () => { calls.push('migration'); runs++; return { done: runs >= 2 }; }),
    };
    const scan = monitor.scanFolder.bind(monitor);
    monitor.scanFolder = async (id, opts) => { calls.push('scan'); return scan(id, opts); };
    const s = build({ referenceMigration });
    s.start();
    await vi.waitFor(() => expect(referenceMigration.run).toHaveBeenCalledTimes(2), { timeout: 3_000 });
    await vi.waitFor(() => expect(isFirstImportDone(storage.getDb(), folder.id)).toBe(true), { timeout: 3_000 });
    expect(calls.slice(0, 2)).toEqual(['migration', 'scan']);
    await new Promise(resolve => setTimeout(resolve, 120));
    expect(referenceMigration.run).toHaveBeenCalledTimes(2); // done: never run again
  });

  it('repairs PDF captures stored as raw bytes after the conversion, before walks, and imports the re-captures in the same pass', async () => {
    const done = addFolder();
    markFirstImportDone(storage.getDb(), done.id);
    markReferenceWalkDone(storage.getDb(), done.id);
    const pdf = write(root, 'Documents/scan.pdf', 300);
    storage.getDb().prepare(`
      INSERT INTO work_items (id, type, source, title, file_path, raw_text, content_storage, content_sha256, content_bytes, metadata, captured_at, process_state)
      VALUES ('raw', 'document_capture', 'filesystem', 'scan.pdf', ?, '%PDF-1.4 raw bytes', 'inline', 'sha', 18, ?, '2026-07-08T00:00:00Z', 'routed')
    `).run(pdf, JSON.stringify({ filePath: pdf }));
    const contentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ppt-sched-content-'));
    const calls: string[] = [];
    const referenceMigration = { isDone: () => calls.includes('migration'), run: vi.fn(async () => { calls.push('migration'); return { done: true }; }) };
    const repair = createRawCaptureRepair({ db: storage.getDb(), contentDir, bigFileBytes: THRESHOLDS.bigFileBytes, yieldToLoop: async () => {} });
    const rawCaptureRepair = { isDone: () => repair.isDone(), run: async (opts?: { signal?: AbortSignal }) => { calls.push('repair'); return repair.run(opts); } };
    const importFiles = monitor.importFiles.bind(monitor);
    monitor.importFiles = async (id, records, opts) => { calls.push('import'); return importFiles(id, records, opts); };
    const s = build({ referenceMigration, rawCaptureRepair });
    s.start();
    await vi.waitFor(() => expect(emitted.map(item => item.metadata.filePath)).toContain(pdf), { timeout: 3_000 });
    expect(calls).toEqual(['migration', 'repair', 'import']);
    expect(storage.getDb().prepare("SELECT COUNT(*) AS c FROM work_items WHERE id = 'raw'").get()).toEqual({ c: 0 });
    expect(emitted.find(item => item.metadata.filePath === pdf)).toMatchObject({ type: 'document_capture', content: '' });
    expect(repair.isDone()).toBe(true);
    fs.rmSync(contentDir, { recursive: true, force: true });
  });

  it('a stop aborts the conversion and the pass', async () => {
    addFolder();
    let seen: AbortSignal | undefined;
    const referenceMigration = {
      isDone: () => false,
      run: (opts?: { signal?: AbortSignal }) => new Promise<{ done: boolean; aborted?: boolean }>((resolve) => {
        seen = opts?.signal;
        opts?.signal?.addEventListener('abort', () => resolve({ done: false, aborted: true }), { once: true });
      }),
    };
    const scanned = vi.spyOn(monitor, 'scanFolder');
    const s = build({ referenceMigration });
    s.start();
    await vi.waitFor(() => expect(seen).toBeDefined(), { timeout: 3_000 });
    s.stop();
    await s.drain();
    expect(seen!.aborted).toBe(true);
    expect(scanned).not.toHaveBeenCalled();
  });

  it('walks a folder imported before the reference rules once: data and code become references, documents are skipped', async () => {
    const note = write(root, 'notes/plan.md', 10);
    const data = write(root, 'notes/results.json', 3_000);
    const code = write(root, 'src/train.py', 40);
    const folder = addFolder();
    // An upgraded store: the first import finished under the old rules, the
    // document was captured then, and the data file was held as too large.
    markFirstImportDone(storage.getDb(), folder.id);
    const noteStat = fs.statSync(note);
    ledger.record({ folderId: folder.id, path: note, size: noteStat.size, mtimeMs: noteStat.mtimeMs, outcome: 'imported' });
    const dataStat = fs.statSync(data);
    ledger.record({ folderId: folder.id, path: data, size: dataStat.size, mtimeMs: dataStat.mtimeMs, outcome: 'too_large' });
    const s = build();
    s.start();
    await vi.waitFor(() => expect(isReferenceWalkDone(storage.getDb(), folder.id)).toBe(true), { timeout: 3_000 });
    expect(emitted.map(item => [path.basename(String(item.metadata.filePath)), item.type]).sort()).toEqual([
      ['results.json', 'file_reference'],
      ['train.py', 'file_reference'],
    ]);
    expect(ledger.get(folder.id, data)?.outcome).toBe('imported');
    expect(emitted.find(item => item.metadata.filePath === code)?.metadata).toMatchObject({ fileRole: 'code', format: 'Python' });

    // Done once: a later pass does not walk the folder again.
    const before = emitted.length;
    s.kick();
    await new Promise(resolve => setTimeout(resolve, 120));
    expect(emitted).toHaveLength(before);
  });
});
