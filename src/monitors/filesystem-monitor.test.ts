import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs';
import { createStorage, type StorageLayer } from '../core/storage.js';
import {
  addLocalFolder,
  updateLocalFolder,
  listLocalFolders,
  type LocalFolder,
} from '../core/local-folders-config.js';
import type { DocumentParser, ParseResult } from '../core/document-parser.js';
import type { RawWorkItem } from '../core/types.js';

// ─── Hoisted: env-var setup BEFORE filesystem-monitor module is loaded ─────
//
// `MAX_FILE_BYTES` is captured at module-load time in filesystem-monitor.ts,
// so we shrink the cap to 500 bytes here so the size-limit test can produce
// an "oversized" file from just a few hundred bytes (vs. allocating 5+ MB).
// `LOCAL_FOLDERS_DEBUG=1` flips the monitor into debug-log mode so we can
// assert console.debug was called when a path is skipped.
vi.hoisted(() => {
  process.env.LOCAL_FOLDERS_MAX_FILE_BYTES = '500';
  process.env.LOCAL_FOLDERS_DEBUG = '1';
});

// ─── Fake watch engine ──────────────────────────────────────────────────────
//
// The monitor accepts an injectable `watchEngine` (the seam that replaced the
// old chokidar module mock). Each engine attach records the row and cooked
// callbacks so tests can:
//   - fire `onAddOrChange`/`onUnlink` synchronously for a given folder path,
//   - count `close()` calls per handle (diff assertions),
//   - inspect the ordered attach log.
import {
  createFilesystemMonitor,
  isRelativePathIgnored,
  type FilesystemMonitor,
  type WatchEngine,
  type CookedWatchEvents,
} from './filesystem-monitor.js';

function createEngineMocks() {
  const enginesByPath = new Map<string, { row: LocalFolder; events: CookedWatchEvents; close: ReturnType<typeof vi.fn> }>();
  const attachCalls: Array<{ path: string; row: LocalFolder }> = [];

  const engine: WatchEngine & ReturnType<typeof vi.fn> = vi.fn((row: LocalFolder, events: CookedWatchEvents) => {
    const close = vi.fn(() => Promise.resolve());
    enginesByPath.set(row.path, { row, events, close });
    attachCalls.push({ path: row.path, row });
    return { close };
  }) as any;

  function reset() {
    enginesByPath.clear();
    attachCalls.length = 0;
    engine.mockClear();
  }

  return { engine, enginesByPath, attachCalls, reset };
}

const engineMocks = createEngineMocks();

// ─── Test helpers ──────────────────────────────────────────────────────────

/**
 * Stub DocumentParser whose default behavior reads the on-disk file as UTF-8
 * (so content-hash dedup tests work against real bytes) and whose supported
 * formats are limited to plain-text variants. Tests can swap the supported
 * set via the optional `supported` arg.
 */
function createStubDocumentParser(supported: string[] = ['.md', '.txt']): DocumentParser {
  return {
    parse(filePath: string): ParseResult {
      const fileType = path.extname(filePath).toLowerCase();
      try {
        const text = fs.readFileSync(filePath, 'utf-8');
        return { success: true, text, filePath, fileType };
      } catch (err: any) {
        return { success: false, error: err?.message ?? 'read failed', filePath, fileType };
      }
    },
    getSupportedFormats(): string[] {
      return [...supported];
    },
  };
}

/**
 * Build an in-memory LocalFolder row. Used by tests that drive
 * `setWatchedFolders` directly without round-tripping through the DB
 * (e.g. the diff test, where the row paths don't need to actually exist
 * because the watch engine is faked).
 */
function makeRow(overrides: Partial<LocalFolder> & { id: number; path: string }): LocalFolder {
  return {
    id: overrides.id,
    path: overrides.path,
    recursive: overrides.recursive ?? true,
    include_globs: overrides.include_globs ?? [],
    exclude_globs: overrides.exclude_globs ?? [],
    enabled: overrides.enabled ?? true,
    created_at: overrides.created_at ?? Date.now(),
    updated_at: overrides.updated_at ?? Date.now(),
  };
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('FilesystemMonitor', () => {
  let storage: StorageLayer;
  let homeTestDir: string;
  let monitor: FilesystemMonitor | null = null;

  beforeEach(() => {
    engineMocks.reset();

    storage = createStorage(':memory:');
    storage.initialize();

    // Tmpdir under $HOME so addLocalFolder's inside-home guard accepts it.
    homeTestDir = fs.mkdtempSync(path.join(os.homedir(), '.ppt-test-fsmon-'));
  });

  afterEach(async () => {
    if (monitor) {
      try {
        await monitor.stop();
      } catch {
        /* ignore */
      }
      monitor = null;
    }
    storage.close();
    try {
      fs.rmSync(homeTestDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  // ── Add / change / unlink emit semantics ─────────────────────────────────

  // Validates: Requirements 2.1, 2.2, 2.4
  it('emits a RawWorkItem with the expected shape on a cooked add event', () => {
    const db = storage.getDb();
    const added = addLocalFolder(db, { path: homeTestDir });
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    const watchedPath = added.folder.path;

    const filePath = path.join(watchedPath, 'note.md');
    const content = '# Hello world';
    fs.writeFileSync(filePath, content, 'utf-8');

    const documentParser = createStubDocumentParser();
    monitor = createFilesystemMonitor({ db, documentParser, watchEngine: engineMocks.engine });

    const emitted: RawWorkItem[] = [];
    monitor.onWorkItem((item) => emitted.push(item));

    return monitor.start().then(() => {
      const attached = engineMocks.enginesByPath.get(watchedPath);
      expect(attached).toBeDefined();

      attached!.events.onAddOrChange(filePath);

      expect(emitted).toHaveLength(1);
      const item = emitted[0];
      expect(item.source).toBe('filesystem');
      expect(item.sourceApp).toBe('Local Files');
      expect(item.type).toBe('document_capture');
      expect(item.url).toBe('file://' + filePath);
      expect(item.title).toBe('note.md');
      expect(item.content).toBe(content);
      expect(item.metadata.filePath).toBe(filePath);
      expect(item.metadata.fileType).toBe('.md');
      expect(item.metadata.contentHash).toMatch(/^[0-9a-f]{64}$/);
      expect(typeof item.metadata.mtime).toBe('string');
      expect(typeof item.metadata.size).toBe('string');
      expect(item.capturedAt).toBeInstanceOf(Date);
    });
  });

  // Validates: Requirement 2.5
  it('does NOT re-emit on `change` when the content hash is unchanged', async () => {
    const db = storage.getDb();
    const added = addLocalFolder(db, { path: homeTestDir });
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    const watchedPath = added.folder.path;

    const filePath = path.join(watchedPath, 'note.md');
    fs.writeFileSync(filePath, 'stable content', 'utf-8');

    monitor = createFilesystemMonitor({ db, documentParser: createStubDocumentParser(), watchEngine: engineMocks.engine });
    const emitted: RawWorkItem[] = [];
    monitor.onWorkItem((i) => emitted.push(i));
    await monitor.start();

    const attached = engineMocks.enginesByPath.get(watchedPath)!;
    attached.events.onAddOrChange(filePath);
    expect(emitted).toHaveLength(1);

    // Bump mtime without changing bytes (utimes simulates an editor "save"
    // that didn't actually mutate the file).
    const future = new Date(Date.now() + 1000);
    fs.utimesSync(filePath, future, future);

    attached.events.onAddOrChange(filePath);
    expect(emitted).toHaveLength(1); // still 1 — no re-emit
  });

  // Validates: Requirement 2.4
  it('emits on `change` when the content has actually changed (different hash)', async () => {
    const db = storage.getDb();
    const added = addLocalFolder(db, { path: homeTestDir });
    if (!added.ok) throw new Error('addLocalFolder failed');
    const watchedPath = added.folder.path;

    const filePath = path.join(watchedPath, 'note.md');
    fs.writeFileSync(filePath, 'first version', 'utf-8');

    monitor = createFilesystemMonitor({ db, documentParser: createStubDocumentParser(), watchEngine: engineMocks.engine });
    const emitted: RawWorkItem[] = [];
    monitor.onWorkItem((i) => emitted.push(i));
    await monitor.start();

    const attached = engineMocks.enginesByPath.get(watchedPath)!;
    attached.events.onAddOrChange(filePath);
    expect(emitted).toHaveLength(1);
    const firstHash = emitted[0].metadata.contentHash;

    // Real content change → different hash → must re-emit.
    fs.writeFileSync(filePath, 'second version', 'utf-8');
    attached.events.onAddOrChange(filePath);

    expect(emitted).toHaveLength(2);
    expect(emitted[1].metadata.contentHash).not.toBe(firstHash);
    expect(emitted[1].content).toBe('second version');
  });

  // Validates: Requirement 2.6
  it('emits an archive work item on `unlink` with metadata.archived = "true"', async () => {
    const db = storage.getDb();
    const added = addLocalFolder(db, { path: homeTestDir });
    if (!added.ok) throw new Error('addLocalFolder failed');
    const watchedPath = added.folder.path;

    const filePath = path.join(watchedPath, 'doomed.md');
    fs.writeFileSync(filePath, 'going away', 'utf-8');

    monitor = createFilesystemMonitor({ db, documentParser: createStubDocumentParser(), watchEngine: engineMocks.engine });
    const emitted: RawWorkItem[] = [];
    monitor.onWorkItem((i) => emitted.push(i));
    await monitor.start();

    const attached = engineMocks.enginesByPath.get(watchedPath)!;
    attached.events.onAddOrChange(filePath);
    expect(emitted).toHaveLength(1);

    attached.events.onUnlink(filePath);
    expect(emitted).toHaveLength(2);

    const archive = emitted[1];
    expect(archive.source).toBe('filesystem');
    expect(archive.url).toBe('file://' + filePath);
    expect(archive.title).toBe('doomed.md');
    expect(archive.content).toBe('');
    expect(archive.metadata.archived).toBe('true');
    expect(archive.metadata.filePath).toBe(filePath);
  });

  // ── setWatchedFolders diff ───────────────────────────────────────────────

  // Validates: Requirement 2.7
  it('setWatchedFolders closes only-removed watchers, opens only-new ones, leaves unchanged paths alone', async () => {
    const db = storage.getDb();
    monitor = createFilesystemMonitor({ db, documentParser: createStubDocumentParser(), watchEngine: engineMocks.engine });

    const rowA = makeRow({ id: 1, path: '/tmp/test-fsmon-A' });
    const rowB = makeRow({ id: 2, path: '/tmp/test-fsmon-B' });
    const rowC = makeRow({ id: 3, path: '/tmp/test-fsmon-C' });

    await monitor.setWatchedFolders([rowA, rowB]);

    const engineA = engineMocks.enginesByPath.get(rowA.path);
    const engineB = engineMocks.enginesByPath.get(rowB.path);
    expect(engineA).toBeDefined();
    expect(engineB).toBeDefined();
    expect(engineMocks.engine).toHaveBeenCalledTimes(2);

    // Replace {A, B} with {B, C}: A should close, B is unchanged, C is new.
    await monitor.setWatchedFolders([rowB, rowC]);

    const engineC = engineMocks.enginesByPath.get(rowC.path);
    expect(engineC).toBeDefined();

    // A's handle was closed exactly once; B's handle was NOT closed.
    expect(engineA!.close).toHaveBeenCalledTimes(1);
    expect(engineB!.close).not.toHaveBeenCalled();

    // The engine attached once more (for C only — not for B).
    expect(engineMocks.engine).toHaveBeenCalledTimes(3);
    const attachedPaths = engineMocks.attachCalls.map((c) => c.path);
    expect(attachedPaths).toEqual([rowA.path, rowB.path, rowC.path]);
  });

  // ── Static segment ignores (live-event filter) ──────────────────────────

  // Validates: folder-watch-scaling R2 — the segment filter the native
  // engine applies to every raw event before any stat. Replaces the old
  // assertion that ignore globs were handed to chokidar (whose v5 silently
  // ignored them — the reason this filter exists).
  it('isRelativePathIgnored drops dependency/build/VCS trees, dotfiles, and lock files', () => {
    // Ignored: dot-segments anywhere, known dependency/build dirs, *.lock.
    expect(isRelativePathIgnored(path.join('.git', 'HEAD'))).toBe(true);
    expect(isRelativePathIgnored('.DS_Store')).toBe(true);
    expect(isRelativePathIgnored(path.join('sub', '.cache', 'x.md'))).toBe(true);
    expect(isRelativePathIgnored(path.join('node_modules', 'pkg', 'README.md'))).toBe(true);
    expect(isRelativePathIgnored(path.join('app', 'dist', 'index.js'))).toBe(true);
    expect(isRelativePathIgnored(path.join('proj', 'build', 'out.txt'))).toBe(true);
    expect(isRelativePathIgnored(path.join('py', '__pycache__', 'm.pyc'))).toBe(true);
    expect(isRelativePathIgnored(path.join('ios', 'Pods', 'Pod.md'))).toBe(true);
    expect(isRelativePathIgnored(path.join('rust', 'target', 'doc.md'))).toBe(true);
    expect(isRelativePathIgnored('package.lock')).toBe(true);

    // Not ignored: ordinary documents at any depth.
    expect(isRelativePathIgnored('note.md')).toBe(false);
    expect(isRelativePathIgnored(path.join('docs', 'design.md'))).toBe(false);
    expect(isRelativePathIgnored(path.join('deep', 'nested', 'report.pdf'))).toBe(false);
    // Names that merely CONTAIN an ignored word are not segment matches.
    expect(isRelativePathIgnored(path.join('distribution', 'plan.md'))).toBe(false);
    expect(isRelativePathIgnored('rebuild-notes.txt')).toBe(false);
  });

  // ── Filter chain: size cap, unsupported extension, include-globs ─────────

  // Validates: Requirement 8.2
  it('skips files larger than MAX_FILE_BYTES with a debug log and no emit', async () => {
    const db = storage.getDb();
    const added = addLocalFolder(db, { path: homeTestDir });
    if (!added.ok) throw new Error('addLocalFolder failed');
    const watchedPath = added.folder.path;

    // MAX_FILE_BYTES is set to 500 by the hoisted env-var block.
    const bigPath = path.join(watchedPath, 'big.md');
    fs.writeFileSync(bigPath, 'x'.repeat(600), 'utf-8');

    monitor = createFilesystemMonitor({ db, documentParser: createStubDocumentParser(), watchEngine: engineMocks.engine });
    const emitted: RawWorkItem[] = [];
    monitor.onWorkItem((i) => emitted.push(i));
    await monitor.start();

    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    try {
      engineMocks.enginesByPath.get(watchedPath)!.events.onAddOrChange(bigPath);

      expect(emitted).toHaveLength(0);
      expect(debugSpy).toHaveBeenCalled();
      const allLogs = debugSpy.mock.calls.flat().join(' ');
      expect(allLogs).toContain('size');
    } finally {
      debugSpy.mockRestore();
    }
  });

  // Validates: lossless-capture-brain-pipeline R12.5 (supersedes local-folders
  // R8.3): unsupported extensions are NO LONGER dropped — they emit a "raw"
  // item (empty content + filePath) so the pipeline extractor can OCR/parse it.
  it('emits a raw item (empty content) for an unsupported extension so the extractor can handle it', async () => {
    const db = storage.getDb();
    const added = addLocalFolder(db, { path: homeTestDir });
    if (!added.ok) throw new Error('addLocalFolder failed');
    const watchedPath = added.folder.path;

    const xyzPath = path.join(watchedPath, 'mystery.xyz');
    fs.writeFileSync(xyzPath, 'unsupported', 'utf-8');

    // Stub parser only supports .md/.txt — `.xyz` is not parsed inline.
    monitor = createFilesystemMonitor({
      db,
      documentParser: createStubDocumentParser(['.md', '.txt']),
      watchEngine: engineMocks.engine,
    });
    const emitted: RawWorkItem[] = [];
    monitor.onWorkItem((i) => emitted.push(i));
    await monitor.start();

    engineMocks.enginesByPath.get(watchedPath)!.events.onAddOrChange(xyzPath);

    expect(emitted).toHaveLength(1);
    const item = emitted[0];
    expect(item.type).toBe('document_capture');
    expect(item.content).toBe(''); // extractor fills this downstream
    expect(item.metadata.filePath).toBe(xyzPath);
    expect(item.metadata.fileType).toBe('.xyz');
  });

  // Validates: Requirement 2.2 (per-folder include_globs, exercised at the
  // cooked-handler level — the engine's raw-event filtering is bypassed by
  // the fake engine, same as the old chokidar mock bypassed `ignored`).
  it('skips files that fail include_globs match with a debug log and no emit', async () => {
    const db = storage.getDb();
    const added = addLocalFolder(db, {
      path: homeTestDir,
      include_globs: ['*.md'],
    });
    if (!added.ok) throw new Error('addLocalFolder failed');
    const watchedPath = added.folder.path;

    const txtPath = path.join(watchedPath, 'note.txt'); // supported ext but excluded by glob
    fs.writeFileSync(txtPath, 'hello', 'utf-8');

    monitor = createFilesystemMonitor({ db, documentParser: createStubDocumentParser(), watchEngine: engineMocks.engine });
    const emitted: RawWorkItem[] = [];
    monitor.onWorkItem((i) => emitted.push(i));
    await monitor.start();

    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    try {
      engineMocks.enginesByPath.get(watchedPath)!.events.onAddOrChange(txtPath);

      expect(emitted).toHaveLength(0);
      expect(debugSpy).toHaveBeenCalled();
      const allLogs = debugSpy.mock.calls.flat().join(' ');
      expect(allLogs).toContain('include_glob');
    } finally {
      debugSpy.mockRestore();
    }
  });

  // ── start() loads enabledOnly folders ────────────────────────────────────

  // Validates: Requirements 2.1, 2.8
  it('start() loads listLocalFolders(db, { enabledOnly: true }) and seeds the watcher set', async () => {
    const db = storage.getDb();

    // Two real-on-disk dirs, one enabled and one disabled.
    const enabledDir = fs.mkdtempSync(path.join(homeTestDir, 'enabled-'));
    const disabledDir = fs.mkdtempSync(path.join(homeTestDir, 'disabled-'));

    const enabledRes = addLocalFolder(db, { path: enabledDir });
    const disabledRes = addLocalFolder(db, { path: disabledDir });
    if (!enabledRes.ok || !disabledRes.ok) throw new Error('addLocalFolder failed');

    // Flip the second row off via updateLocalFolder so it is persisted as
    // enabled=0 in the DB.
    const upd = updateLocalFolder(db, disabledRes.folder.id, { enabled: false });
    expect(upd.ok).toBe(true);

    // Sanity: enabledOnly listing returns only the enabled row.
    const enabledOnly = listLocalFolders(db, { enabledOnly: true });
    expect(enabledOnly).toHaveLength(1);
    expect(enabledOnly[0].id).toBe(enabledRes.folder.id);

    monitor = createFilesystemMonitor({ db, documentParser: createStubDocumentParser(), watchEngine: engineMocks.engine });
    await monitor.start();

    // Only the enabled folder has a watcher.
    expect(engineMocks.engine).toHaveBeenCalledTimes(1);
    expect(engineMocks.enginesByPath.has(enabledRes.folder.path)).toBe(true);
    expect(engineMocks.enginesByPath.has(disabledRes.folder.path)).toBe(false);

    // currentRows reflects what start() seeded with (enabled-only).
    const watched = monitor.getWatchedFolders();
    expect(watched).toHaveLength(1);
    expect(watched[0].id).toBe(enabledRes.folder.id);
  });
});
