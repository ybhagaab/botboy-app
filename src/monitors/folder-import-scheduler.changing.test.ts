import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createStorage, getSetting, type StorageLayer } from '../core/storage.js';
import { addLocalFolder, type LocalFolder } from '../core/local-folders-config.js';
import type { DocumentParser } from '../core/document-parser.js';
import type { RawWorkItem } from '../core/types.js';
import { createLocalFolderImportLedger, markFirstImportDone, markReferenceWalkDone, type LocalFolderImportLedger } from '../core/local-folder-imports.js';
import { createFilesystemMonitor, type CookedWatchEvents, type FilesystemMonitorWithImports, type WatchEngine } from './filesystem-monitor.js';
import { createFolderImportScheduler, type FolderImportScheduler } from './folder-import-scheduler.js';

/**
 * Files that keep changing (owner design 2026-10-02): BotBoy warns about a
 * large file it re-captures often; the owner can pause its reprocessing
 * (changes are noted, never read), resume it later (the current version is
 * captured once), or keep processing it without the warning.
 */

const THRESHOLDS = { bigFileBytes: 500, importMinFreeBytes: 1_000, liveMinFreeBytes: 100 };
const MB = 1024 * 1024;

describe('pausing a file that keeps changing', () => {
  let storage: StorageLayer;
  let root: string;
  let folder: LocalFolder;
  let ledger: LocalFolderImportLedger;
  let monitor: FilesystemMonitorWithImports;
  let scheduler: FolderImportScheduler;
  let emitted: RawWorkItem[];
  let events: CookedWatchEvents | null;
  let parse: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    storage = createStorage(':memory:');
    storage.initialize();
    ledger = createLocalFolderImportLedger(storage.getDb());
    root = fs.mkdtempSync(path.join(os.homedir(), '.ppt-test-changing-'));
    emitted = [];
    events = null;
    parse = vi.fn((filePath: string) => ({ success: true, text: fs.readFileSync(filePath, 'utf-8'), filePath, fileType: path.extname(filePath) }));
    const engine = vi.fn((_row: LocalFolder, cooked: CookedWatchEvents) => {
      events = cooked;
      return { close: vi.fn(() => Promise.resolve()) };
    }) as unknown as WatchEngine;
    monitor = createFilesystemMonitor({
      db: storage.getDb(),
      documentParser: { parse, getSupportedFormats: () => ['.md', '.txt', '.csv', '.json'] } as unknown as DocumentParser,
      watchEngine: engine,
      ledger,
      thresholds: THRESHOLDS,
      yieldToLoop: () => Promise.resolve(),
    });
    monitor.onWorkItem(item => { emitted.push(item); });
    const added = addLocalFolder(storage.getDb(), { path: root });
    if (!added.ok) throw new Error(added.message);
    folder = added.folder;
    markFirstImportDone(storage.getDb(), folder.id);
    markReferenceWalkDone(storage.getDb(), folder.id);
    await monitor.start();
    scheduler = createFolderImportScheduler({
      db: storage.getDb(), monitor, ledger, thresholds: THRESHOLDS,
      startDelayMs: 10, retryMs: 40, idleMs: 60_000,
    });
    scheduler.start();
  });

  afterEach(async () => {
    scheduler.stop();
    await scheduler.drain();
    await monitor.stop();
    fs.rmSync(root, { recursive: true, force: true });
    storage.close();
  });

  const rewrite = (file: string, text: string) => {
    fs.writeFileSync(file, text, 'utf-8');
    const later = new Date(Date.now() + Math.floor(Math.random() * 1000) + 1000);
    fs.utimesSync(file, later, later);
  };

  it('notes changes without reading while paused, and captures the current version once on resume', async () => {
    // A document: data files such as JSON are references, never re-read.
    const file = path.join(root, 'dashboard', 'training-progress.md');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    rewrite(file, '{"epoch":1}');
    events!.onAddOrChange(file);
    expect(emitted).toHaveLength(1);

    expect(await scheduler.decide(folder.id, { pause: [file] })).toMatchObject({ ok: true, applied: { paused: 1 } });
    parse.mockClear();
    rewrite(file, '{"epoch":2}');
    events!.onAddOrChange(file);
    rewrite(file, '{"epoch":3,"loss":0.12}');
    events!.onAddOrChange(file);
    expect(emitted).toHaveLength(1);
    expect(parse).not.toHaveBeenCalled();

    const paused = scheduler.status().folders[0].ownerPaused;
    expect(paused).toHaveLength(1);
    expect(paused[0]).toMatchObject({ path: file, relPath: path.join('dashboard', 'training-progress.md'), size: '{"epoch":3,"loss":0.12}'.length });
    // A walk never re-imports a paused file either.
    expect(await monitor.backfill(folder.id)).toMatchObject({ imported: 0 });

    expect(await scheduler.decide(folder.id, { resume: [file] })).toMatchObject({ ok: true, applied: { resumed: 1 } });
    await vi.waitFor(() => expect(emitted).toHaveLength(2), { timeout: 3_000 });
    expect(emitted[1].content).toBe('{"epoch":3,"loss":0.12}');
    // The changes made while paused were never read: the brief reads this version in full.
    expect(emitted[1].metadata.briefRead).toBe('full');
    await vi.waitFor(() => expect(ledger.get(folder.id, file)?.outcome).toBe('imported'), { timeout: 3_000 });

    // Watching continues as usual after the resume.
    rewrite(file, '{"epoch":4}');
    events!.onAddOrChange(file);
    expect(emitted).toHaveLength(3);
    expect(emitted[2].metadata.briefRead).toBeUndefined();
  });

  it('keeps a paused file paused when its writer deletes and recreates it', async () => {
    const file = path.join(root, 'notes', 'progress.md');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    rewrite(file, 'epoch 1');
    events!.onAddOrChange(file);
    expect(await scheduler.decide(folder.id, { pause: [file] })).toMatchObject({ ok: true });
    fs.rmSync(file);
    events!.onUnlink(file);
    rewrite(file, 'epoch 2');
    events!.onAddOrChange(file);
    expect(ledger.get(folder.id, file)?.outcome).toBe('owner_paused');
    expect(emitted).toHaveLength(1); // no deletion record, no new capture
  });

  it('sends a file that grew past the big-file size while paused back to the review', async () => {
    const file = path.join(root, 'progress.md');
    rewrite(file, '{}');
    events!.onAddOrChange(file);
    expect(await scheduler.decide(folder.id, { pause: [file] })).toMatchObject({ ok: true });
    rewrite(file, `{"rows":"${'x'.repeat(800)}"}`);
    events!.onAddOrChange(file);
    expect(await scheduler.decide(folder.id, { resume: [file] })).toMatchObject({ ok: true });
    expect(ledger.get(folder.id, file)?.outcome).toBe('needs_review');
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(emitted).toHaveLength(1); // never read without the owner's big-file choice
  });

  it('validates pause and resume as a whole', async () => {
    const file = path.join(root, 'a.md');
    rewrite(file, 'x');
    const result = await scheduler.decide(folder.id, {
      pause: ['/etc/hosts', path.join(root, 'missing.md'), file],
      resume: [file],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const reasons = result.invalid!.map(entry => `${path.basename(entry.path)}: ${entry.reason}`);
    expect(reasons).toEqual(expect.arrayContaining([
      'hosts: is not a file inside this folder',
      'missing.md: no longer exists',
      'a.md: is marked both pause and resume',
      'a.md: is not paused',
    ]));
    expect(ledger.get(folder.id, file)).toBeUndefined();
  });

  it('warns about a large file captured often, and stops once the owner keeps processing it', async () => {
    const file = path.join(root, 'dashboard', 'training-progress.json');
    const insert = storage.getDb().prepare(`INSERT INTO work_items (id, type, source, file_path, content_bytes, captured_at)
      VALUES (?, 'document_capture', 'filesystem', ?, ?, ?)`);
    for (let i = 0; i < 12; i++) insert.run(`v${i}`, file, Math.round(2.4 * MB), new Date(Date.now() - i * 30 * 60_000).toISOString());

    const [entry] = scheduler.status().folders[0].changingOften;
    expect(entry).toMatchObject({ path: file, versions: 12, acknowledged: false });

    expect(await scheduler.decide(folder.id, { keepChanging: [file] })).toMatchObject({ ok: true, applied: { keptChanging: 1 } });
    expect(scheduler.status().folders[0].changingOften[0]).toMatchObject({ path: file, acknowledged: true });
    expect(getSetting<string[]>(storage.getDb(), `local_folders.changing_ack.${folder.id}`)).toEqual([file]);

    // Pausing later supersedes the choice; a paused file leaves the warning list.
    fs.mkdirSync(path.dirname(file), { recursive: true });
    rewrite(file, '{}');
    expect(await scheduler.decide(folder.id, { pause: [file] })).toMatchObject({ ok: true });
    expect(scheduler.status().folders[0].changingOften).toEqual([]);
    expect(getSetting<string[]>(storage.getDb(), `local_folders.changing_ack.${folder.id}`)).toEqual([]);
  });
});
