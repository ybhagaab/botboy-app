/**
 * The Knowledge library is on-demand knowledge, never capture (knowledge-library.md K1; design amendment P2-1).
 *
 * The Local folders watcher seeds Documents on a first run and the library's default home is
 * ~/Documents/BotBoy Knowledge, so without an exclusion every library file would become a capture on its first
 * write. Every way into capture is tested here with a real library root inside a watched folder: the live engine
 * (real fs.watch), the cooked live handler, a link into the library, unlinks, backfill, the read-only scan, a
 * pending import row, a watched row that sits inside the library, a former root, and the folder registration.
 * A control case shows the same files ARE captured when no exclusion is registered, so removing it fails here.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerCaptureExcludedRoots } from '../core/capture-exclusions.js';
import type { DocumentParser } from '../core/document-parser.js';
import { createLocalFolderImportLedger, type LocalFolderImportLedger } from '../core/local-folder-imports.js';
import { addLocalFolder, type LocalFolder } from '../core/local-folders-config.js';
import {
  KNOWLEDGE_ROOT_ENV,
  emptyKnowledgeState,
  knowledgeExcludedRoots,
  writeKnowledgeState,
} from '../core/knowledge-root.js';
import { createStorage, type StorageLayer } from '../core/storage.js';
import type { RawWorkItem } from '../core/types.js';
import {
  createFilesystemMonitor,
  createNativeWatchEngine,
  type CookedWatchEvents,
  type FilesystemMonitorWithImports,
  type WatchEngine,
} from './filesystem-monitor.js';

const THRESHOLDS = { bigFileBytes: 5_000_000, importMinFreeBytes: 1_000, liveMinFreeBytes: 100 };

describe('the Local folders watcher never captures the Knowledge library', () => {
  let storage: StorageLayer;
  let watched: string;
  let library: string;
  let folder: LocalFolder;
  let ledger: LocalFolderImportLedger;
  let emitted: RawWorkItem[];
  let monitor: FilesystemMonitorWithImports | null;
  let live: CookedWatchEvents | null;
  let parsed: string[];

  const db = () => storage.getDb();
  const write = (full: string, text: string): string => {
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, text, 'utf-8');
    return full;
  };
  const pathsOf = () => emitted.map((item) => String(item.metadata?.filePath ?? '')).sort();
  const insideLibrary = (p: string) => p === library || p.startsWith(library + path.sep);

  function makeMonitor(): FilesystemMonitorWithImports {
    const engine = vi.fn((_row: LocalFolder, events: CookedWatchEvents) => {
      live = events;
      return { close: vi.fn(() => Promise.resolve()) };
    }) as unknown as WatchEngine;
    monitor = createFilesystemMonitor({
      db: db(),
      documentParser: {
        parse: (filePath: string) => { parsed.push(filePath); return { success: true, text: fs.readFileSync(filePath, 'utf-8'), filePath, fileType: path.extname(filePath) }; },
        getSupportedFormats: () => ['.md', '.txt', '.csv', '.json'],
      } as unknown as DocumentParser,
      watchEngine: engine,
      ledger,
      thresholds: THRESHOLDS,
      diskSpace: { cachedFreeBytes: () => 1e12, freeBytes: async () => 1e12, snapshot: () => ({ freeBytes: 1e12, totalBytes: 1e12, measuredAt: 1 }) },
      yieldToLoop: () => Promise.resolve(),
    });
    monitor.onWorkItem((item) => { emitted.push(item); });
    return monitor;
  }

  beforeEach(() => {
    storage = createStorage(':memory:');
    storage.initialize();
    ledger = createLocalFolderImportLedger(db());
    watched = fs.realpathSync.native(fs.mkdtempSync(path.join(os.homedir(), '.kl-excl-watch-')));
    library = path.join(watched, 'BotBoy Knowledge');
    emitted = [];
    parsed = [];
    monitor = null;
    live = null;
    // Files beside the library (captured) and inside it (never captured), synthetic content only.
    write(path.join(watched, 'outside-note.md'), '# Outside note\nShopwave weekly plan.\n');
    write(path.join(watched, 'data', 'orders.json'), '{"orders": 3}');
    write(path.join(library, 'GUIDE.md'), '# Knowledge root guide\n');
    write(path.join(library, 'analytics', 'presets', 'shopwave.md'), '# Shopwave preset\n');
    write(path.join(library, 'analytics', 'manifest.json'), '{"files": []}');
    write(path.join(library, 'notes', 'reference.json'), '{"column": "order_id"}');
    write(path.join(library, 'notes', 'query.sql'), 'select 1;\n');
    vi.stubEnv(KNOWLEDGE_ROOT_ENV, library);
    registerCaptureExcludedRoots(() => knowledgeExcludedRoots(db()));
    const added = addLocalFolder(db(), { path: watched });
    if (!added.ok) throw new Error(added.message);
    folder = added.folder;
  });

  afterEach(async () => {
    await monitor?.stop();
    registerCaptureExcludedRoots(null);
    vi.unstubAllEnvs();
    fs.rmSync(watched, { recursive: true, force: true });
    storage.close();
  });

  it('control: with no exclusion registered the same files are captured', async () => {
    registerCaptureExcludedRoots(null);
    await makeMonitor().backfill(folder.id);
    expect(pathsOf().some(insideLibrary)).toBe(true);
    expect(pathsOf()).toContain(path.join(library, 'analytics', 'presets', 'shopwave.md'));
  });

  it('backfill hands over the files beside the library and nothing inside it', async () => {
    const result = await makeMonitor().backfill(folder.id);
    expect(result).toMatchObject({ aborted: false, total: 2 });
    expect(pathsOf()).toEqual([path.join(watched, 'data', 'orders.json'), path.join(watched, 'outside-note.md')].sort());
    expect(parsed.some(insideLibrary)).toBe(false);
    for (const file of ['GUIDE.md', 'analytics/presets/shopwave.md', 'analytics/manifest.json', 'notes/reference.json', 'notes/query.sql']) {
      expect(ledger.get(folder.id, path.join(library, file))).toBeFalsy();
    }
  });

  it('the read-only scan does not count library files', async () => {
    const scan = await makeMonitor().scanFolder(folder.id);
    expect(scan).toMatchObject({ aborted: false, walked: 2, files: 2 });
  });

  it('a pending import row that points into the library is stopped before anything reads the file', async () => {
    const target = path.join(library, 'analytics', 'presets', 'shopwave.md');
    const stat = fs.statSync(target);
    ledger.record({ folderId: folder.id, path: target, size: stat.size, mtimeMs: stat.mtimeMs, outcome: 'approved', origin: 'import', reason: null });
    const record = ledger.get(folder.id, target)!;
    const result = await makeMonitor().importFiles(folder.id, [record]);
    expect(result).toMatchObject({ aborted: false, imported: 0 });
    expect(emitted).toHaveLength(0);
    expect(parsed).toHaveLength(0);
  });

  it('a live change inside the library, or through a link that points into it, is never captured', async () => {
    const m = makeMonitor();
    await m.start();
    expect(live).not.toBeNull();
    live!.onAddOrChange(path.join(library, 'notes', 'reference.json'));
    live!.onAddOrChange(path.join(library, 'GUIDE.md'));
    const link = path.join(watched, 'link-to-preset.md');
    fs.symlinkSync(path.join(library, 'analytics', 'presets', 'shopwave.md'), link);
    live!.onAddOrChange(link);
    expect(emitted).toHaveLength(0);
    expect(parsed).toHaveLength(0);
    // The same handler still captures a file beside the library.
    live!.onAddOrChange(path.join(watched, 'outside-note.md'));
    expect(pathsOf()).toEqual([path.join(watched, 'outside-note.md')]);
  });

  it('a live delete inside the library archives nothing, even for a reference recorded before the library existed', async () => {
    const insideRef = path.join(library, 'notes', 'reference.json');
    const outsideRef = path.join(watched, 'data', 'orders.json');
    const insert = db().prepare(
      "INSERT INTO work_items (id, type, source, captured_at, file_path, process_state) VALUES (?, 'file_reference', 'filesystem', '2026-10-01T10:00:00Z', ?, 'extracted')",
    );
    insert.run('ref-inside', insideRef);
    insert.run('ref-outside', outsideRef);
    const m = makeMonitor();
    await m.start();
    live!.onUnlink(insideRef);
    live!.onUnlink(path.join(library, 'GUIDE.md'));
    expect(emitted).toHaveLength(0);
    // Control: the same delete beside the library still marks its reference deleted.
    live!.onUnlink(outsideRef);
    expect(emitted).toHaveLength(1);
    expect(emitted[0].metadata).toMatchObject({ filePath: outsideRef, archived: 'true' });
  });

  it('a watched folder that sits inside the library yields nothing, in walks or live', async () => {
    const inner = path.join(library, 'notes');
    // Registered before the library existed (the owner watched it earlier), so the folder registration did not refuse it.
    registerCaptureExcludedRoots(null);
    const added = addLocalFolder(db(), { path: inner });
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    registerCaptureExcludedRoots(() => knowledgeExcludedRoots(db()));
    const m = makeMonitor();
    await m.backfill(added.folder.id);
    expect(emitted).toHaveLength(0);
    await m.start();
    live!.onAddOrChange(path.join(inner, 'reference.json'));
    expect(emitted).toHaveLength(0);
  });

  it('walks never list the library: its folders are pruned unread, and a watched row inside it lists nothing (mutations M43, M46)', async () => {
    const realReaddir = fs.promises.readdir.bind(fs.promises);
    const listed: string[] = [];
    vi.spyOn(fs.promises, 'readdir').mockImplementation(((dir: unknown, ...rest: unknown[]) => {
      listed.push(String(dir));
      return (realReaddir as (...args: unknown[]) => unknown)(dir, ...rest);
    }) as never);
    await makeMonitor().backfill(folder.id);
    expect(listed).toContain(watched);
    expect(listed.some(insideLibrary)).toBe(false);
    // A folder registered inside the library before it existed is not listed at all.
    const inner = path.join(library, 'notes');
    registerCaptureExcludedRoots(null);
    const added = addLocalFolder(db(), { path: inner });
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    registerCaptureExcludedRoots(() => knowledgeExcludedRoots(db()));
    listed.length = 0;
    await makeMonitor().backfill(added.folder.id);
    expect(listed).toEqual([]);
  });

  it('keeps a former root excluded after the library moved elsewhere', async () => {
    vi.unstubAllEnvs();
    const moved = path.join(watched, 'Moved Knowledge');
    write(path.join(moved, 'analytics', 'x.md'), '# x\n');
    writeKnowledgeState(db(), { ...emptyKnowledgeState(), root: moved, formerRoots: [library] });
    registerCaptureExcludedRoots(() => knowledgeExcludedRoots(db()));
    await makeMonitor().backfill(folder.id);
    expect(pathsOf().some((p) => insideLibrary(p) || p.startsWith(moved + path.sep))).toBe(false);
    expect(pathsOf()).toContain(path.join(watched, 'outside-note.md'));
  });

  it('real fs.watch: a write inside the library produces no event, a write beside it does', async () => {
    const added: string[] = [];
    const handle = createNativeWatchEngine(
      folder,
      { onAddOrChange: (p) => added.push(p), onUnlink: () => undefined, onError: () => undefined },
      { settleMs: 40 },
    );
    try {
      await new Promise((r) => setTimeout(r, 300));
      write(path.join(library, 'analytics', 'presets', 'second.md'), '# second\n');
      write(path.join(watched, 'beside.md'), '# beside\n');
      const deadline = Date.now() + 8_000;
      while (Date.now() < deadline && !added.includes(path.join(watched, 'beside.md'))) {
        await new Promise((r) => setTimeout(r, 25));
      }
      await new Promise((r) => setTimeout(r, 400));
      expect(added).toContain(path.join(watched, 'beside.md'));
      expect(added.some(insideLibrary)).toBe(false);
    } finally {
      handle.close();
    }
  }, 30_000);

  it('a library event does not count toward the burst guard, so a busy library cannot pause its watched ancestor', async () => {
    const added: string[] = [];
    const handle = createNativeWatchEngine(
      folder,
      { onAddOrChange: (p) => added.push(p), onUnlink: () => undefined, onError: () => undefined },
      { settleMs: 30, burstMaxEvents: 5, burstWindowMs: 60_000 },
    );
    try {
      await new Promise((r) => setTimeout(r, 300));
      for (let i = 0; i < 25; i += 1) write(path.join(library, 'notes', `n${i}.md`), `# ${i}\n`);
      await new Promise((r) => setTimeout(r, 600));
      write(path.join(watched, 'after-burst.md'), '# after\n');
      const deadline = Date.now() + 8_000;
      while (Date.now() < deadline && !added.includes(path.join(watched, 'after-burst.md'))) {
        await new Promise((r) => setTimeout(r, 25));
      }
      expect(added).toContain(path.join(watched, 'after-burst.md'));
    } finally {
      handle.close();
    }
  }, 30_000);

  describe('registering a folder', () => {
    it('refuses the library and anything inside it, and allows its ancestor and a look-alike sibling', () => {
      const refusedRoot = addLocalFolder(db(), { path: library });
      expect(refusedRoot).toMatchObject({ ok: false, code: 'knowledge_library' });
      const refusedInner = addLocalFolder(db(), { path: path.join(library, 'analytics') });
      expect(refusedInner).toMatchObject({ ok: false, code: 'knowledge_library' });
      // The ancestor is already watched in this fixture; a look-alike sibling is a different folder.
      const sibling = path.join(watched, 'BotBoy Knowledge 2');
      fs.mkdirSync(sibling);
      expect(addLocalFolder(db(), { path: sibling }).ok).toBe(true);
      expect(addLocalFolder(db(), { path: watched })).toMatchObject({ ok: false, code: 'duplicate' });
    });

    it('refuses a link that resolves into the library', () => {
      const link = path.join(watched, 'shortcut');
      fs.symlinkSync(path.join(library, 'notes'), link);
      expect(addLocalFolder(db(), { path: link })).toMatchObject({ ok: false, code: 'knowledge_library' });
    });
  });
});
