/**
 * Filesystem Monitor — native-watch ingestion of locally-watched folders.
 *
 * Wraps a `Map<path, WatchHandle>` of watch-engine instances, one per row in
 * the `local_folders` table. Watcher lifecycle is driven by
 * `setWatchedFolders`, which performs a minimal diff against `currentRows` so
 * unchanged paths keep their existing engine instance (no flicker, no
 * duplicate `add` events).
 *
 * Watch engine (folder-watch-scaling spec): live watching runs on Node's
 * native `fs.watch` — `recursive: true` rides FSEvents on macOS, ONE file
 * descriptor per tree regardless of file count. The previous chokidar v5
 * engine opened one descriptor PER FILE and silently ignored its glob-based
 * `ignored` option (v4 dropped glob support), which is how a watched folder
 * holding a transient Android checkout exhausted the process fd table and
 * poisoned every subsequent syscall (EMFILE incident, 2026-08-24).
 *
 * The engine normalizes raw fs.watch events into cooked add/change/unlink
 * callbacks after segment-based ignores, per-row exclude globs, a burst
 * guard (a folder that floods pauses ITSELF, never the process), and a
 * write-settle debounce. The cooked layer (`handleAddOrChange`,
 * `handleUnlink`, backfill, diffing) is unchanged from the original design.
 */

import { createHash } from 'crypto';
import { statSync, watch as fsNativeWatch, promises as fsPromises, type Stats } from 'fs';
import path from 'path';
import { performance } from 'perf_hooks';
import type Database from 'better-sqlite3';
import type { RawWorkItem } from '../core/types.js';
import type { DocumentParser } from '../core/document-parser.js';
import type { LocalFolder } from '../core/local-folders-config.js';
import { listLocalFolders, getLocalFolder } from '../core/local-folders-config.js';
import type { DiskSpaceMonitor } from '../core/disk-space.js';
import { NOOP_MAIN_THREAD_WATCHDOG, type MainThreadWatchdog } from '../core/main-thread-watchdog.js';
import {
  captureSignature,
  createLocalFolderImportLedger,
  existingCaptureSignatures,
  folderImportThresholds,
  markFirstImportDone,
  parseLiteralGlob,
  type FolderFileOrigin,
  type FolderFileOutcome,
  type FolderFileRecord,
  type FolderImportThresholds,
  type LocalFolderImportLedger,
} from '../core/local-folder-imports.js';

// ── Public types ───────────────────────────────────────────────────────────

/**
 * Progress event emitted during a `backfill` run. Mirrors the SSE event shape
 * the route handler will forward to the client. The `phase` field is the
 * discriminant; not every field is populated for every phase. `paused` is
 * terminal: the walk stopped below the import disk floor and resumes later
 * (unchanged files are skipped, so resuming is cheap).
 */
export interface BackfillProgress {
  phase: 'started' | 'progress' | 'done' | 'error' | 'aborted' | 'paused';
  folderId: number;
  total?: number;
  processed?: number;
  error?: string;
  /** Files handed to capture during this walk. */
  imported?: number;
  /** Files skipped because this exact version was already handed to capture. */
  unchanged?: number;
  /** Big files held for the owner's review. */
  needsReview?: number;
  /** Files above the import ceiling, listed but never read. */
  tooLarge?: number;
  reason?: 'low_disk' | 'busy';
  freeBytes?: number;
}

/**
 * Terminal result returned by `backfill`. `aborted: true` is returned when
 * the caller-provided `AbortSignal` fired mid-walk; otherwise `aborted: false`
 * with the total number of files inspected. `paused` means the walk stopped
 * below the import disk floor; `busy` means another walk owns the folder.
 */
export type BackfillResult =
  | { aborted: true }
  | {
    aborted: false;
    total: number;
    imported?: number;
    unchanged?: number;
    needsReview?: number;
    tooLarge?: number;
    failed?: number;
    paused?: 'low_disk';
    busy?: boolean;
  };

/**
 * Public surface area of the filesystem monitor. Mirrors the slack-monitor
 * shape (start/stop/onWorkItem) and adds the watched-folders diff control
 * plus a `backfill` API used by the SSE backfill route. A listener may
 * return a promise; folder imports wait for it before recording a file as
 * imported, so a failed store is retried by the next walk.
 */
export interface FilesystemMonitor {
  start(): Promise<void>;
  stop(): Promise<void>;
  onWorkItem(cb: (item: RawWorkItem) => unknown): void;
  setWatchedFolders(folders: LocalFolder[]): Promise<void>;
  getWatchedFolders(): LocalFolder[];
  backfill(
    folderId: number,
    opts?: { onProgress?: (p: BackfillProgress) => void; signal?: AbortSignal; expectedTotal?: number },
  ): Promise<BackfillResult>;
}

/** Live progress of one folder walk (scan or import). */
export interface FolderWalkState {
  kind: 'scan' | 'import';
  processed: number;
  total: number | null;
  startedAt: number;
}

/** Result of the read-only first-import scan (no file content is read). */
export type FolderScanResult =
  | { aborted: true }
  | {
    aborted: false;
    busy?: boolean;
    /** Files an import walk would visit (its `total`). */
    walked: number;
    /** Capture candidates seen (after ignores, excludes, and include globs). */
    files: number;
    bytes: number;
    /** Candidates that an import walk would hand to capture now. */
    importable: number;
    unchanged: number;
    needsReview: number;
    tooLarge: number;
  };

export type ImportFilesResult =
  | { aborted: true }
  | { aborted: false; busy?: boolean; imported: number; held: number; failed: number; paused?: 'low_disk' };

/**
 * Folder-import operations used by `folder-import-scheduler.ts`. Kept off
 * `FilesystemMonitor` so route-level monitor stubs stay minimal.
 */
export interface FolderImportWalker {
  isWalking(folderId: number): boolean;
  walkState(folderId: number): FolderWalkState | null;
  scanFolder(folderId: number, opts?: { signal?: AbortSignal }): Promise<FolderScanResult>;
  importFiles(folderId: number, records: FolderFileRecord[], opts?: { signal?: AbortSignal }): Promise<ImportFilesResult>;
}

export type FilesystemMonitorWithImports = FilesystemMonitor & FolderImportWalker;

// ── Watch engine seam ──────────────────────────────────────────────────────

/** Cooked event callbacks the engine dispatches after filtering/settling. */
export interface CookedWatchEvents {
  onAddOrChange(absolutePath: string): void;
  onUnlink(absolutePath: string): void;
  onError(err: Error): void;
}

/** A live watch on one folder row. */
export interface WatchHandle {
  close(): Promise<void> | void;
}

/**
 * Engine factory: given a folder row and cooked-event callbacks, start
 * watching and return a handle. The default engine (`createNativeWatchEngine`
 * below) owns raw fs.watch, ignore filtering, burst guarding, and write
 * settling. Tests inject a fake engine and fire cooked events directly —
 * the same seam the previous chokidar module mock provided, now first-class.
 */
export type WatchEngine = (row: LocalFolder, events: CookedWatchEvents) => WatchHandle;

// ── Constants ──────────────────────────────────────────────────────────────

/**
 * Per-file size cap. Files larger than this are skipped (with a debug log)
 * by `handleAddOrChange` — task 4.3 will enforce. Overridable via env var so
 * power users can ingest larger documents without recompiling.
 */
// Default raised from 5 MB → 200 MB for the lossless-capture-brain-pipeline
// (R12.4): the pipeline no longer truncates, so we want to ingest realistically
// any document/image rather than silently dropping large files. The env var
// override is retained (used by tests to exercise the cap mechanism, and by
// power users who want a different ceiling). A true zero-cap is a later
// supersede of the local-folders spec's original size guard.
const DEFAULT_MAX_FILE_BYTES = 209_715_200; // 200 MB
const MAX_FILE_BYTES = (() => {
  const raw = process.env.LOCAL_FOLDERS_MAX_FILE_BYTES;
  if (!raw) return DEFAULT_MAX_FILE_BYTES;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    console.warn(
      `[filesystem-monitor] Invalid LOCAL_FOLDERS_MAX_FILE_BYTES=${raw}; using ${DEFAULT_MAX_FILE_BYTES}-byte default`,
    );
    return DEFAULT_MAX_FILE_BYTES;
  }
  return parsed;
})();

/** Import ceiling: files above it are listed as too large and never read. */
export const LOCAL_FOLDER_MAX_FILE_BYTES = MAX_FILE_BYTES;

/**
 * Static ignore patterns shared by `attachWatcher` and (later) `backfill` so
 * live ingestion and backfill semantics agree. Per-folder `exclude_globs` are
 * appended on top of these in `attachWatcher`.
 */
/**
 * File extensions that carry no extractable text for a productivity tracker —
 * video, audio, archives, binaries, disk images, and design/binary assets.
 * These are skipped at ingest time (never emitted) so we don't waste OCR/parse
 * cycles or flood the store with content-less items.
 */
const SKIP_EXTENSIONS: ReadonlySet<string> = new Set([
  // video
  '.mp4', '.mov', '.avi', '.mkv', '.webm', '.m4v', '.flv', '.wmv',
  // audio
  '.mp3', '.wav', '.aac', '.flac', '.m4a', '.ogg',
  // archives
  '.zip', '.tar', '.gz', '.tgz', '.rar', '.7z', '.bz2', '.xz', '.dmg', '.iso', '.pkg',
  // binaries / executables
  '.exe', '.dll', '.bin', '.so', '.dylib', '.o', '.a', '.class', '.jar', '.wasm',
  // design/binary assets (svg is XML but rarely useful text; sketch/psd binary)
  '.svg', '.psd', '.sketch', '.fig', '.ai', '.eps', '.ico', '.icns',
  // fonts
  '.ttf', '.otf', '.woff', '.woff2',
  // db/data blobs
  '.db', '.sqlite', '.sqlite3', '.dat',
]);

/**
 * Directory names that are never worth watching or walking: dependency
 * trees, build outputs, package caches. Dot-directories (`.git`, `.gradle`,
 * `.venv`, …) are covered by the dotfile rule in `isStaticallyIgnored`, not
 * listed here. Shared verbatim by the live engine's segment filter and the
 * backfill walker so both prune identically (folder-watch-scaling R2).
 */
/**
 * Formats the monitor parses INLINE on a live event. Restricted to formats
 * whose parse is a plain UTF-8 file read — never a format whose conversion
 * shells out to a subprocess (those block the event loop; the async pipeline
 * extractor owns them).
 */
const INLINE_PARSE_EXTS: ReadonlySet<string> = new Set(['.txt', '.md', '.csv', '.json']);

const IGNORED_DIR_SEGMENTS: ReadonlySet<string> = new Set([
  'node_modules', 'dist', 'build', 'out', 'target', 'Pods', 'venv',
  '__pycache__', 'coverage', 'DerivedData',
]);

/**
 * Basename-level static ignore shared by the live watch engine and the
 * backfill walker (identical semantics — folder-watch-scaling R2):
 *
 *   - dot-basenames at any depth (`.git`, `.DS_Store`, `.cache`, `.venv`, …)
 *   - `IGNORED_DIR_SEGMENTS` directory names
 *   - `*.lock` files
 *
 * Returning `true` means "skip this entry" — directories pruned this way are
 * never enqueued so we don't pay the `readdir` cost on giant trees like
 * `node_modules`.
 */
function isStaticallyIgnored(basename: string, isDir: boolean): boolean {
  // Dotfiles at any depth — covers `.git`, `.DS_Store`, `.cache`, etc.
  if (basename.startsWith('.')) return true;
  if (isDir && IGNORED_DIR_SEGMENTS.has(basename)) return true;
  if (!isDir && basename.endsWith('.lock')) return true;
  return false;
}

/**
 * Segment filter for LIVE watch events (relative path from the watch root).
 * Any dot-segment or ignored directory segment anywhere in the path drops the
 * event before we stat anything. The final segment additionally applies the
 * `*.lock` file rule. A directory event whose own name matches
 * `IGNORED_DIR_SEGMENTS` is also dropped — a false positive on a FILE
 * literally named `build`/`dist` is acceptable noise-vs-safety.
 */
export function isRelativePathIgnored(relPath: string): boolean {
  const segments = relPath.split(path.sep);
  for (const segment of segments) {
    if (segment.startsWith('.')) return true;
    if (IGNORED_DIR_SEGMENTS.has(segment)) return true;
  }
  return segments[segments.length - 1].endsWith('.lock');
}

// ── Glob helpers ───────────────────────────────────────────────────────────

/**
 * Compile a single glob pattern into a `RegExp`. Supports the subset chokidar
 * documents: `**` (any number of path segments), `*` (any chars except `/`),
 * `?` (single char). A backslash escapes `*`, `?`, or itself, so a literal
 * path written by the big-file review (`literalGlobForPath`) matches exactly
 * that path even when its name contains a wildcard character. Other regex
 * metacharacters are escaped. Patterns that do not contain a `/` are matched
 * against the file's basename so `*.md` matches any markdown file regardless
 * of directory depth. Compiled patterns are cached (bounded).
 */
const globRegexCache = new Map<string, RegExp>();
const GLOB_CACHE_LIMIT = 10_000;

function compileGlob(glob: string): RegExp {
  const cached = globRegexCache.get(glob);
  if (cached) return cached;
  let pattern = '';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === '\\' && i + 1 < glob.length && '\\*?'.includes(glob[i + 1])) {
      pattern += '\\' + glob[i + 1];
      i++;
    } else if (ch === '*') {
      if (glob[i + 1] === '*') {
        // `**` matches any number of characters including `/`.
        pattern += '.*';
        i++;
        // Eat a trailing `/` so `**/foo` matches `foo` at the root too.
        if (glob[i + 1] === '/') i++;
      } else {
        // `*` matches anything except `/`.
        pattern += '[^/]*';
      }
    } else if (ch === '?') {
      pattern += '[^/]';
    } else if ('.+^$()|{}[]\\'.includes(ch)) {
      pattern += '\\' + ch;
    } else {
      pattern += ch;
    }
  }
  const compiled = new RegExp('^' + pattern + '$');
  if (globRegexCache.size >= GLOB_CACHE_LIMIT) globRegexCache.clear();
  globRegexCache.set(glob, compiled);
  return compiled;
}

/**
 * Return `true` if `filePath` matches any of `globs`. A glob without a `/`
 * matches against `basename(filePath)`; a glob containing `/` matches against
 * the full path. Empty glob arrays are an error at the call site — the caller
 * should short-circuit before invoking this helper.
 */
function matchesAnyGlob(filePath: string, globs: ReadonlyArray<string>): boolean {
  const base = path.basename(filePath);
  for (const glob of globs) {
    const re = compileGlob(glob);
    if (glob.includes('/')) {
      if (re.test(filePath)) return true;
    } else {
      if (re.test(base)) return true;
    }
  }
  return false;
}

/**
 * A folder's `exclude_globs`, compiled once. Literal entries written by the
 * big-file review (one exact file, or `<dir>/**`) become set lookups, so a
 * review that excludes hundreds of files stays O(depth) per path; owner
 * patterns keep `matchesAnyGlob` semantics. `matchesFile` is exactly
 * equivalent to `matchesAnyGlob(filePath, globs)`. `prunesDir` is true only
 * when every path under the directory is excluded (a literal directory entry
 * or a pattern ending in `/**` that matches it), so a walk may skip the
 * subtree without reading it.
 */
interface CompiledExcludes {
  matchesFile(filePath: string): boolean;
  prunesDir(dirPath: string): boolean;
}

const compiledExcludesCache = new WeakMap<ReadonlyArray<string>, CompiledExcludes>();

function hasAncestorIn(dirs: ReadonlySet<string>, target: string): boolean {
  if (dirs.size === 0) return false;
  let current = path.dirname(target);
  for (;;) {
    if (dirs.has(current)) return true;
    const parent = path.dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

function compileExcludes(globs: ReadonlyArray<string>): CompiledExcludes {
  const cached = compiledExcludesCache.get(globs);
  if (cached) return cached;
  const literalFiles = new Set<string>();
  const literalDirs = new Set<string>();
  const patterns: string[] = [];
  for (const glob of globs) {
    const literal = parseLiteralGlob(glob);
    if (!literal) patterns.push(glob);
    else if (literal.directory) literalDirs.add(literal.path);
    else literalFiles.add(literal.path);
  }
  const subtreePatterns = patterns.filter(glob => glob.includes('/') && glob.endsWith('/**'));
  const compiled: CompiledExcludes = {
    matchesFile(filePath) {
      if (literalFiles.has(filePath) || hasAncestorIn(literalDirs, filePath)) return true;
      return patterns.length > 0 && matchesAnyGlob(filePath, patterns);
    },
    prunesDir(dirPath) {
      if (literalDirs.has(dirPath) || hasAncestorIn(literalDirs, dirPath)) return true;
      const probe = dirPath.endsWith('/') ? dirPath : dirPath + '/';
      return subtreePatterns.some(glob => compileGlob(glob).test(probe));
    },
  };
  compiledExcludesCache.set(globs, compiled);
  return compiled;
}

// ── Native watch engine ────────────────────────────────────────────────────

/** Burst guard: events allowed per rolling window before the folder pauses. */
const BURST_MAX_EVENTS = 2000;
const BURST_WINDOW_MS = 60_000;
const BURST_PAUSE_MS = 10 * 60_000;
/** Write settle: a path must be quiet and size-stable this long to ingest. */
const SETTLE_MS = 500;

/**
 * Default watch engine on Node's native `fs.watch`. On macOS a recursive
 * watch rides FSEvents: ONE descriptor per tree, so watching cost is
 * independent of folder size (R1). Raw events flow through:
 *
 *   filename → segment ignores + row exclude globs (R2, pre-stat)
 *            → burst guard (R3: flooding pauses THIS folder only)
 *            → settle map (R4: 500 ms quiet + size-stable, re-arm on growth)
 *            → stat: missing ⇒ cooked unlink · stable file ⇒ cooked add/change
 *
 * Settle timers are unref'd and cleared on close so a closed watcher never
 * fires and never holds the process open.
 */
export function createNativeWatchEngine(
  row: LocalFolder,
  events: CookedWatchEvents,
  config?: { settleMs?: number; burstMaxEvents?: number; burstWindowMs?: number; burstPauseMs?: number },
): WatchHandle {
  const settleMs = config?.settleMs ?? SETTLE_MS;
  const burstMaxEvents = config?.burstMaxEvents ?? BURST_MAX_EVENTS;
  const burstWindowMs = config?.burstWindowMs ?? BURST_WINDOW_MS;
  const burstPauseMs = config?.burstPauseMs ?? BURST_PAUSE_MS;

  const settle = new Map<string, { timer: NodeJS.Timeout; lastSize: number }>();
  const burst = { windowStart: Date.now(), count: 0, pausedUntil: 0, dropped: 0 };
  let closed = false;

  function armSettle(absolutePath: string): void {
    const existing = settle.get(absolutePath);
    if (existing) clearTimeout(existing.timer);

    // Stat NOW (only candidate files reach here — ignored paths were dropped
    // before any I/O): a vanished path is a delete and dispatches unlink
    // immediately; a present file records its size so one quiet settle
    // period with a stable size suffices to dispatch.
    let size: number;
    try {
      const stat = statSync(absolutePath);
      if (stat.isDirectory()) {
        settle.delete(absolutePath);
        return;
      }
      size = stat.size;
    } catch {
      // Gone already — a delete (or a transient file). The monitor's wiring
      // drops the unlink unless the path was actually ingested (seenHashes
      // guard), so editor temp files that appear and vanish emit nothing.
      settle.delete(absolutePath);
      events.onUnlink(absolutePath);
      return;
    }

    const timer = setTimeout(() => fireSettle(absolutePath), settleMs);
    timer.unref?.();
    settle.set(absolutePath, { timer, lastSize: size });
  }

  function fireSettle(absolutePath: string): void {
    const entry = settle.get(absolutePath);
    if (!entry || closed) return;
    let stat: ReturnType<typeof statSync>;
    try {
      stat = statSync(absolutePath);
    } catch {
      settle.delete(absolutePath);
      events.onUnlink(absolutePath);
      return;
    }
    if (stat.isDirectory()) {
      settle.delete(absolutePath);
      return;
    }
    if (stat.size !== entry.lastSize) {
      // Writer still active — remember the new size and wait another beat.
      entry.lastSize = stat.size;
      const timer = setTimeout(() => fireSettle(absolutePath), settleMs);
      timer.unref?.();
      entry.timer = timer;
      return;
    }
    settle.delete(absolutePath);
    events.onAddOrChange(absolutePath);
  }

  function onRawEvent(_eventType: string, filename: string | Buffer | null): void {
    if (closed || filename == null) return;
    const rel = filename.toString();
    if (rel.length === 0) return;
    // Non-recursive rows watch one directory level; native watch already
    // behaves that way, this is a defensive guard.
    if (!row.recursive && rel.includes(path.sep)) return;
    if (isRelativePathIgnored(rel)) return;
    const absolutePath = path.join(row.path, rel);
    if (row.exclude_globs.length > 0 && compileExcludes(row.exclude_globs).matchesFile(absolutePath)) return;

    // Burst guard (R3). Window reset first so a long-quiet folder starts
    // fresh; while paused, drop and count; on expiry, log the resume once.
    const now = Date.now();
    if (burst.pausedUntil > now) {
      burst.dropped++;
      return;
    }
    if (burst.pausedUntil !== 0) {
      console.warn(
        `[filesystem-monitor] ${row.path} resumed after burst pause — ${burst.dropped} events dropped while paused`,
      );
      burst.pausedUntil = 0;
      burst.dropped = 0;
      burst.windowStart = now;
      burst.count = 0;
    }
    if (now - burst.windowStart >= burstWindowMs) {
      burst.windowStart = now;
      burst.count = 0;
    }
    burst.count++;
    if (burst.count > burstMaxEvents) {
      burst.pausedUntil = now + burstPauseMs;
      console.error(
        `[filesystem-monitor] ${row.path} produced ${burst.count} events within its burst window — `
        + `pausing ingestion for this folder for ${Math.round(burstPauseMs / 60_000)} min (watching continues, other folders unaffected). `
        + 'A large tree probably appeared inside it; add an exclude pattern or watch a smaller subfolder.',
      );
      // Clear pending settles: a flood's half-settled paths are exactly the
      // noise the pause exists to shed.
      for (const [, pending] of settle) clearTimeout(pending.timer);
      settle.clear();
      return;
    }

    // Arm (or re-arm) the settle timer; stats now, dispatches after one
    // quiet, size-stable settle period.
    armSettle(absolutePath);
  }

  let watcher: ReturnType<typeof fsNativeWatch> | null = null;
  try {
    watcher = fsNativeWatch(row.path, { persistent: true, recursive: row.recursive }, onRawEvent);
    watcher.on('error', (err) => events.onError(err as Error));
  } catch (err) {
    events.onError(err as Error);
  }

  return {
    close(): void {
      closed = true;
      for (const [, pending] of settle) clearTimeout(pending.timer);
      settle.clear();
      try {
        watcher?.close();
      } catch {
        /* already closed */
      }
    },
  };
}

// ── Factory ────────────────────────────────────────────────────────────────

/**
 * Construct a `FilesystemMonitor` instance bound to the given database and
 * document parser. The returned monitor owns:
 *
 *   - `watchersByPath` — watch-engine handle per active folder path.
 *   - `currentRows`    — last-seen `LocalFolder[]`, returned (defensively
 *                         copied) by `getWatchedFolders`.
 *   - `seenHashes`     — `filePath → contentHash` for the §2.5 content
 *                         dedup. Populated by 4.3, consumed by 4.4.
 *   - `listeners`      — fan-out registered via `onWorkItem`.
 *
 * Stateless deps (db, documentParser) are captured in the closure so the
 * monitor can be spun up once per process.
 */
export function createFilesystemMonitor(deps: {
  db: Database.Database;
  documentParser: DocumentParser;
  /** Injectable watch engine; defaults to the native fs.watch engine. */
  watchEngine?: WatchEngine;
  /** Import ledger; defaults to one over `db`. */
  ledger?: LocalFolderImportLedger;
  /** Free-space probe for the disk floors; omitted ⇒ no floors apply. */
  diskSpace?: DiskSpaceMonitor | null;
  thresholds?: FolderImportThresholds;
  watchdog?: MainThreadWatchdog;
  /** Cooperative yield between files; defaults to `setImmediate`. */
  yieldToLoop?: () => Promise<void>;
}): FilesystemMonitorWithImports {
  const { db, documentParser } = deps;
  const watchEngine = deps.watchEngine ?? createNativeWatchEngine;
  const ledger = deps.ledger ?? createLocalFolderImportLedger(db);
  const diskSpace = deps.diskSpace ?? null;
  const thresholds = deps.thresholds ?? folderImportThresholds();
  const watchdog = deps.watchdog ?? NOOP_MAIN_THREAD_WATCHDOG;
  const yieldToLoop = deps.yieldToLoop ?? (() => new Promise<void>(resolve => setImmediate(resolve)));

  const watchersByPath = new Map<string, WatchHandle>();
  // Latest row per watched path. Cooked handlers read it at event time, so
  // an id/include-glob change applies without re-attaching; `recursive` and
  // `exclude_globs` live inside the engine and trigger a re-attach.
  const watchedRows = new Map<string, LocalFolder>();
  let currentRows: LocalFolder[] = [];
  const seenHashes = new Map<string, string>();
  const listeners: Array<(item: RawWorkItem) => unknown> = [];
  // Folders whose watcher was force-closed after exhausting file descriptors.
  // Collapses an EMFILE error storm into a single actionable log line and
  // exactly one close() call (last-resort fuse; the native engine's O(1)
  // descriptor cost makes this near-impossible to trip).
  const fdExhausted = new Set<string>();
  // One walk (scan, import, or pending import) per folder at a time.
  const walks = new Map<number, FolderWalkState>();
  let liveLowDiskNotified = false;

  // ── Private helpers ────────────────────────────────────────────────────

  /**
   * Fan-out a `RawWorkItem` to every registered listener. Each listener is
   * isolated — one throwing handler does not block siblings, matching the
   * clipboard-monitor pattern. Listeners are invoked synchronously; the
   * returned promise resolves `true` once every returned promise settled
   * successfully, and `false` when any listener threw or rejected (already
   * logged here, so callers never need their own catch).
   */
  function emit(item: RawWorkItem): Promise<boolean> {
    let failed = false;
    const pending: Array<Promise<unknown>> = [];
    for (const fn of listeners) {
      try {
        const result = fn(item);
        if (result && typeof (result as PromiseLike<unknown>).then === 'function') {
          pending.push(Promise.resolve(result).catch((err) => {
            failed = true;
            console.error('[filesystem-monitor] listener error:', err);
          }));
        }
      } catch (err) {
        failed = true;
        console.error('[filesystem-monitor] listener error:', err);
      }
    }
    if (pending.length === 0) return Promise.resolve(!failed);
    return Promise.all(pending).then(() => !failed);
  }

  /** True when the owner kept this path as a big file (approved or imported big). */
  function ownerKept(known: FolderFileRecord | undefined | null): boolean {
    if (!known) return false;
    return known.outcome === 'approved'
      || (known.outcome === 'imported' && known.size >= thresholds.bigFileBytes);
  }

  function holdFile(row: LocalFolder, filePath: string, stat: Stats, outcome: FolderFileOutcome, origin: FolderFileOrigin, known?: FolderFileRecord | null): void {
    // Skip the write when this exact version is already held the same way.
    if (known && known.outcome === outcome && known.size === stat.size && known.mtimeMs === stat.mtimeMs) return;
    ledger.record({ folderId: row.id, path: filePath, size: stat.size, mtimeMs: stat.mtimeMs, outcome, origin });
  }

  /** Live floor check on the cached free-space value (sync; never blocks). */
  function liveDiskLow(): boolean {
    if (!diskSpace) return false;
    const free = diskSpace.cachedFreeBytes();
    const low = free != null && free < thresholds.liveMinFreeBytes;
    if (low && !liveLowDiskNotified) {
      liveLowDiskNotified = true;
      console.warn(
        `[filesystem-monitor] Free disk space is ${formatGiB(free)} (below the ${formatGiB(thresholds.liveMinFreeBytes)} live floor): `
        + 'live folder captures are deferred and will be imported when space returns. Free space from Connections → Local folders → Storage.',
      );
    } else if (!low && liveLowDiskNotified) {
      liveLowDiskNotified = false;
      console.log('[filesystem-monitor] Free disk space recovered; live folder captures resumed.');
    }
    return low;
  }

  async function importDiskLow(): Promise<number | null> {
    if (!diskSpace) return null;
    const free = await diskSpace.freeBytes(5_000);
    return free != null && free < thresholds.importMinFreeBytes ? free : null;
  }

  function acquireWalk(folderId: number, kind: FolderWalkState['kind'], total: number | null = null): FolderWalkState | null {
    if (walks.has(folderId)) return null;
    const state: FolderWalkState = { kind, processed: 0, total, startedAt: Date.now() };
    walks.set(folderId, state);
    return state;
  }

  /**
   * Breadth-first walk over one folder yielding candidate file paths. Prunes
   * statically ignored directories, excluded subtrees, and (non-recursive
   * rows) every subdirectory; skips statically ignored and excluded files.
   * `readdir` is async; entry iteration yields to the event loop after
   * ~25 ms of synchronous work so a huge directory never starves the loop.
   */
  async function* walkFolderFiles(
    row: LocalFolder,
    excludes: CompiledExcludes,
  ): AsyncGenerator<{ path: string } | { error: string }> {
    const queue: string[] = [row.path];
    let sliceStarted = performance.now();
    while (queue.length > 0) {
      const dir = queue.shift() as string;
      let entries;
      try {
        entries = await fsPromises.readdir(dir, { withFileTypes: true });
      } catch (err) {
        yield { error: `readdir failed for ${dir}: ${(err as Error).message ?? String(err)}` };
        continue;
      }
      sliceStarted = performance.now();
      for (const entry of entries) {
        if (performance.now() - sliceStarted > 25) {
          await yieldToLoop();
          sliceStarted = performance.now();
        }
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (!row.recursive) continue;
          if (isStaticallyIgnored(entry.name, true)) continue;
          if (excludes.prunesDir(fullPath)) continue;
          queue.push(fullPath);
          continue;
        }
        // Skip non-regular files (sockets, fifos, char devices, broken
        // symlinks), matching live watching.
        if (!entry.isFile()) continue;
        if (isStaticallyIgnored(entry.name, false)) continue;
        if (excludes.matchesFile(fullPath)) continue;
        yield { path: fullPath };
        sliceStarted = performance.now();
      }
    }
  }

  /**
   * Cached `Set` of supported file extensions. Resolved lazily on the first
   * `handleAddOrChange` call so a swap of the document-parser instance for
   * tests is observed.
   */
  let supportedFormatsCache: Set<string> | null = null;
  function getSupportedFormats(): Set<string> {
    if (!supportedFormatsCache) {
      supportedFormatsCache = new Set(
        documentParser.getSupportedFormats().map((ext) => ext.toLowerCase()),
      );
    }
    return supportedFormatsCache;
  }

  type CaptureMode = 'live' | 'backfill';

  interface HandleOptions {
    /** Pre-fetched stat (walks stat asynchronously). */
    stat?: Stats;
    /** Ledger row for this path when the caller already holds it (`null` = none). */
    known?: FolderFileRecord | null;
    /** A folder import (walk or pending import) owns this call. */
    importWalk?: boolean;
  }

  /**
   * What happened to one file. `captured` carries `done`, which resolves
   * `true` once every capture listener stored the item (and the ledger was
   * updated), `false` when a listener failed — the file stays unrecorded,
   * so the next walk retries it.
   */
  type HandleResult =
    | { outcome: 'missing' | 'ignored' | 'too_large' | 'needs_review' | 'deferred_low_disk' | 'unchanged' }
    | { outcome: 'captured'; done: Promise<boolean> };

  /** Stable provenance consumed by evidence-gist.ts and Today. Never infer
   * backfill from timestamps: only the explicit tree-walk path may set it. */
  function captureProvenance(row: LocalFolder, captureMode: CaptureMode): Record<string, string> {
    return {
      captureMode,
      localFolderId: String(row.id),
      localFolderName: path.basename(row.path) || row.path,
    };
  }

  /**
   * Emit-or-hold a single file under `row`. The filter chain is:
   *
   *   1. `stat` the file (catch ENOENT/EACCES so a transient unlink during
   *      processing is silent rather than crashing the watcher).
   *   2. Skip non-content extensions and include-glob misses (not recorded).
   *   3. Above the import ceiling (`MAX_FILE_BYTES`): hold as `too_large`.
   *   4. At or above the big-file threshold without the owner's keep for
   *      this path: hold as `needs_review` (C8 — live and import alike).
   *   5. Live only: below the live disk floor, hold as `deferred_low_disk`.
   *   6. Parse plain-text types inline; `sha256(text)` short-circuits an
   *      unchanged file (§2.5 dedup). Other types emit raw.
   *   7. Emit a `RawWorkItem` with the canonical filesystem shape
   *      (`source: 'filesystem'`, `sourceApp: 'Local Files'`,
   *      `type: 'document_capture'`, `url: 'file://' + filePath`).
   *
   * `exclude_globs` are NOT applied here: the live engine drops excluded
   * raw events before cooking and folder walks prune them before calling.
   * Listeners run synchronously inside this call; `done` settles when they
   * finish. Skipped paths are debug-logged with their reason so users can
   * diagnose missing ingests via `LOCAL_FOLDERS_DEBUG=1` (Requirement 8.5).
   */
  function handleAddOrChange(
    row: LocalFolder,
    filePath: string,
    captureMode: CaptureMode = 'live',
    opts: HandleOptions = {},
  ): HandleResult {
    let stat: Stats;
    if (opts.stat) {
      stat = opts.stat;
    } else {
      try {
        stat = statSync(filePath);
      } catch (err) {
        if (process.env.LOCAL_FOLDERS_DEBUG) {
          console.debug(
            `[filesystem-monitor] stat failed for ${filePath}:`,
            (err as Error).message,
          );
        }
        return { outcome: 'missing' };
      }
    }

    const ext = path.extname(filePath).toLowerCase();

    // 1. Skip clearly-non-textual file types (video/audio/archive/binary/
    //    design assets). A productivity tracker has no text to gain from these,
    //    and OCR'ing them is wasteful — so we don't ingest them at all.
    if (SKIP_EXTENSIONS.has(ext)) {
      if (process.env.LOCAL_FOLDERS_DEBUG) {
        console.debug(`[filesystem-monitor] skip (non-content type ${ext}): ${filePath}`);
      }
      return { outcome: 'ignored' };
    }

    // 2. Per-folder include globs (only enforced when non-empty).
    if (
      row.include_globs.length > 0 &&
      !matchesAnyGlob(filePath, row.include_globs)
    ) {
      if (process.env.LOCAL_FOLDERS_DEBUG) {
        console.debug(
          `[filesystem-monitor] skip (no include_glob match): ${filePath}`,
        );
      }
      return { outcome: 'ignored' };
    }

    const origin: FolderFileOrigin = captureMode === 'live' ? 'live' : 'import';
    const known = opts.known !== undefined ? opts.known : ledger.get(row.id, filePath);

    // 3. Import ceiling: listed for the owner as "too large to import yet",
    //    never read (C8).
    if (stat.size > MAX_FILE_BYTES) {
      if (process.env.LOCAL_FOLDERS_DEBUG) {
        console.debug(
          `[filesystem-monitor] skip (size>${MAX_FILE_BYTES}): ${filePath} (${stat.size} bytes)`,
        );
      }
      holdFile(row, filePath, stat, 'too_large', origin, known);
      return { outcome: 'too_large' };
    }

    // 4. Big-file gate (C8, live and import): no file at or above the
    //    threshold is read without the owner's choice for its path.
    if (stat.size >= thresholds.bigFileBytes && !ownerKept(known)) {
      holdFile(row, filePath, stat, 'needs_review', origin, known);
      return { outcome: 'needs_review' };
    }

    // 5. Live disk floor (C7). Import walks check their own, higher floor
    //    before each file. A deferred change is imported when space returns.
    if (!opts.importWalk && liveDiskLow()) {
      holdFile(row, filePath, stat, 'deferred_low_disk', 'live', known);
      return { outcome: 'deferred_low_disk' };
    }

    // Imports record every version they hand over (resume skips it). Live
    // captures record only paths the ledger already tracks or big kept
    // files, so ordinary live churn adds no ledger writes.
    // A failed store forgets the in-process dedup entry, so the next event or
    // walk retries the file instead of treating it as unchanged.
    const recordImported = Boolean(opts.importWalk || known || stat.size >= thresholds.bigFileBytes);
    const settle = (done: Promise<boolean>): Promise<boolean> => {
      const seenValue = seenHashes.get(filePath);
      return done.then((ok) => {
        if (!ok) {
          if (seenHashes.get(filePath) === seenValue) seenHashes.delete(filePath);
          return false;
        }
        if (recordImported) {
          try {
            ledger.record({ folderId: row.id, path: filePath, size: stat.size, mtimeMs: stat.mtimeMs, outcome: 'imported', origin });
          } catch (err) {
            console.warn(`[filesystem-monitor] import ledger write failed for ${filePath}:`, (err as Error)?.message ?? err);
            return false;
          }
        }
        return true;
      });
    };
    // Same content already handed over by this process: nothing to record
    // (the stored item's signature covers later walks).
    const unchanged = (): HandleResult => ({ outcome: 'unchanged' });

    // 3. Parse plain-text types inline (a UTF-8 read — no subprocess). All
    //    heavier supported formats (.pdf/.docx/.pptx/.xlsx) are deliberately
    //    NOT parsed here: their conversions shell out synchronously, and a
    //    slow document dropped into a watched folder froze the whole server's
    //    event loop (2026-08-24, password-protected PDF in Downloads). They
    //    emit as "raw" items and the pipeline extractor — which parses
    //    asynchronously off the event loop — fills them within its 15 s tick.
    //    Unsupported extensions and parse failures likewise emit raw
    //    (lossless-capture-brain-pipeline R12.5); the extractor reads the
    //    file from metadata.filePath.
    if (INLINE_PARSE_EXTS.has(ext) && getSupportedFormats().has(ext)) {
      const parsed = documentParser.parse(filePath);
      if (parsed.success && typeof parsed.text === 'string') {
        // Content-hash dedup for successfully parsed text.
        const contentHash = createHash('sha256').update(parsed.text).digest('hex');
        if (seenHashes.get(filePath) === contentHash) {
          if (process.env.LOCAL_FOLDERS_DEBUG) {
            console.debug(`[filesystem-monitor] skip (unchanged contentHash): ${filePath}`);
          }
          return unchanged();
        }
        seenHashes.set(filePath, contentHash);
        const done = emit({
          type: 'document_capture',
          source: 'filesystem',
          sourceApp: 'Local Files',
          url: 'file://' + filePath,
          title: path.basename(filePath),
          content: parsed.text,
          metadata: {
            ...captureProvenance(row, captureMode),
            filePath, fileType: ext,
            mtime: String(stat.mtimeMs), size: String(stat.size), contentHash,
          },
          capturedAt: new Date(),
        });
        return { outcome: 'captured', done: settle(done) };
      }
      console.warn(
        `[filesystem-monitor] parse failed for ${filePath}: ${parsed.error ?? 'unknown error'} — emitting raw for extractor`,
      );
      // fall through to raw emit
    }

    // 4. Raw emit (unsupported extension OR parse failure) — dedup on a cheap
    //    size:mtime signature so we don't re-read large binaries just to hash.
    const signature = `raw:${stat.size}:${stat.mtimeMs}`;
    if (seenHashes.get(filePath) === signature) {
      if (process.env.LOCAL_FOLDERS_DEBUG) {
        console.debug(`[filesystem-monitor] skip (unchanged size/mtime): ${filePath}`);
      }
      return unchanged();
    }
    seenHashes.set(filePath, signature);
    const done = emit({
      type: 'document_capture',
      source: 'filesystem',
      sourceApp: 'Local Files',
      url: 'file://' + filePath,
      title: path.basename(filePath),
      content: '', // extractor fills this via parse/OCR from metadata.filePath
      metadata: {
        ...captureProvenance(row, captureMode),
        filePath, fileType: ext,
        mtime: String(stat.mtimeMs), size: String(stat.size),
      },
      capturedAt: new Date(),
    });
    return { outcome: 'captured', done: settle(done) };
  }

  /** Live cooked add/change: measured for the watchdog, never awaited. */
  function handleLiveChange(row: LocalFolder, filePath: string): void {
    const result = watchdog.measure('folder-live', () => handleAddOrChange(row, filePath, 'live'));
    if (result.outcome === 'captured') void result.done;
  }

  /**
   * Handle a chokidar `unlink` event by emitting a sentinel `RawWorkItem`
   * marking the file as archived (Requirement 2.6). The downstream pipeline
   * uses `metadata.archived === 'true'` plus the matching `url` /
   * `metadata.filePath` to retire any previously-stored work item for this
   * file without performing a hard delete — keeping history queryable.
   *
   * The shape mirrors the live add/change emit (same `source`, `sourceApp`,
   * `type`, `url`) so consumers do not need a special code path; only the
   * empty `content` and `metadata.archived = 'true'` distinguish it. We
   * deliberately do NOT include `fileType`/`mtime`/`size`/`contentHash` in
   * the metadata: the file is gone, so those fields are either unknowable
   * (size/mtime) or meaningless (contentHash of empty string would mask the
   * archive intent).
   *
   * The `seenHashes` entry is dropped so a future re-creation of the same
   * path is treated as a fresh `add` — without this, restoring a deleted
   * file with identical contents would be silently swallowed by the
   * content-hash dedup in `handleAddOrChange`.
   */
  function handleUnlink(row: LocalFolder, filePath: string): void {
    const item: RawWorkItem = {
      type: 'document_capture',
      source: 'filesystem',
      sourceApp: 'Local Files',
      url: 'file://' + filePath,
      title: path.basename(filePath),
      content: '',
      metadata: {
        ...captureProvenance(row, 'live'),
        filePath,
        archived: 'true',
      },
      capturedAt: new Date(),
    };
    void emit(item);
    seenHashes.delete(filePath);
  }

  /**
   * Open a watch-engine handle for the given folder row and wire its cooked
   * events into the handlers above. The handle is NOT registered in
   * `watchersByPath` here — the caller (`setWatchedFolders`) does that so
   * the diff loop owns the map.
   *
   * The engine owns everything raw: existing files are never replayed on
   * attach (backfill is the explicit opt-in path for that), non-recursive
   * rows watch one level, writes settle before ingestion, and static
   * segment ignores plus the row's `exclude_globs` are applied before any
   * stat. This wiring adds only the seen-path unlink guard and the EMFILE
   * fuse.
   */
  function attachWatcher(row: LocalFolder): WatchHandle {
    const currentRow = () => watchedRows.get(row.path) ?? row;
    const handle = watchEngine(row, {
      onAddOrChange: (filePath) => handleLiveChange(currentRow(), filePath),
      onUnlink: (filePath) => {
        // A vanished file no longer waits for review or import.
        try { ledger.remove(currentRow().id, filePath); } catch { /* ledger is advisory here */ }
        // Parity with the previous engine's contract: unlink fires only for
        // paths we actually ingested. Without this guard, a transient editor
        // temp file (created and renamed away within the settle window) would
        // emit a spurious archive item for a path that never existed
        // downstream.
        if (!seenHashes.has(filePath)) return;
        handleUnlink(currentRow(), filePath);
      },
      onError: (err) => {
        // EMFILE circuit breaker — near-impossible with the O(1)-descriptor
        // native engine, kept as the last-resort fuse (spec R5.2): watching
        // this folder is expendable, the rest of BotBoy is not.
        if ((err as NodeJS.ErrnoException)?.code === 'EMFILE') {
          if (fdExhausted.has(row.path)) return; // storm already handled
          fdExhausted.add(row.path);
          console.error(
            `[filesystem-monitor] ${row.path} exhausted file descriptors — `
            + 'stopped watching it to protect the rest of BotBoy. '
            + 'Remove large checkouts/build trees from this folder, add them to '
            + "the folder's exclude patterns, or watch a smaller subfolder, "
            + 'then toggle the folder in Connections → Local folders.',
          );
          const active = watchersByPath.get(row.path);
          watchersByPath.delete(row.path);
          if (active) void Promise.resolve(active.close()).catch(() => {});
          return;
        }
        console.warn(`[filesystem-monitor] watcher error on ${row.path}:`, err);
      },
    });
    return handle;
  }

  /**
   * Drop every `seenHashes` entry whose key lives under `folderPath`. Used
   * when a watcher is removed in `setWatchedFolders` so a re-add of the same
   * folder later starts with a clean dedup window.
   */
  function dropSeenHashesUnder(folderPath: string): void {
    const prefix = folderPath.endsWith('/') ? folderPath : folderPath + '/';
    for (const key of seenHashes.keys()) {
      if (key === folderPath || key.startsWith(prefix)) {
        seenHashes.delete(key);
      }
    }
  }

  // ── Public surface ─────────────────────────────────────────────────────

  return {
    /**
     * Load enabled folders from the database and seed the watcher set.
     * Idempotent: calling `start()` on an already-started monitor reconciles
     * the watcher set against the latest DB state.
     */
    async start(): Promise<void> {
      const folders = listLocalFolders(db, { enabledOnly: true });
      await this.setWatchedFolders(folders);
    },

    /**
     * Close every watch handle and clear all state. After `stop()` the
     * monitor can be re-started by calling `start()` again.
     */
    async stop(): Promise<void> {
      const closes: Array<Promise<void>> = [];
      for (const [, watcher] of watchersByPath) {
        try {
          closes.push(Promise.resolve(watcher.close()));
        } catch (err) {
          console.warn('[filesystem-monitor] close error:', err);
        }
      }
      await Promise.all(closes);
      watchersByPath.clear();
      watchedRows.clear();
      seenHashes.clear();
      currentRows = [];
    },

    /**
     * Register a fan-out callback for emitted work items. Multiple callbacks
     * are supported; ordering is registration order. A returned promise is
     * awaited by folder imports (see `emit`).
     */
    onWorkItem(cb: (item: RawWorkItem) => unknown): void {
      listeners.push(cb);
    },

    /**
     * Reconcile the live watcher set against `folders`. Performs the minimal
     * diff per the design doc:
     *
     *   1. Build the next desired path-set from `folders.filter(enabled)`.
     *   2. For every currently-watched path NOT in the next set: close it,
     *      drop it from `watchersByPath`, drop its `seenHashes` entries.
     *   3. For every path in the next set NOT currently watched: attach a
     *      fresh watch-engine handle and store it.
     *   4. Paths present in BOTH sets keep their existing instance — no
     *      flicker, no replay — unless the row's engine configuration
     *      (`recursive`, `exclude_globs`) changed: the engine holds those,
     *      so that path is closed and re-attached. Other row changes (id,
     *      include globs) apply in place through `watchedRows`.
     *
     * `currentRows` is replaced wholesale at the end so `getWatchedFolders`
     * reflects what the caller asked for (including disabled rows, which
     * the UI still needs to render).
     */
    async setWatchedFolders(folders: LocalFolder[]): Promise<void> {
      const nextByPath = new Map<string, LocalFolder>();
      for (const folder of folders) {
        if (folder.enabled) nextByPath.set(folder.path, folder);
      }

      const closeWatcher = async (watchedPath: string, watcher: WatchHandle) => {
        try {
          await watcher.close();
        } catch (err) {
          console.warn(
            `[filesystem-monitor] close failed for ${watchedPath}:`,
            err,
          );
        }
        watchersByPath.delete(watchedPath);
      };

      // Close removed paths (await each to avoid leaking fds across rapid
      // reconfigure calls).
      for (const [watchedPath, watcher] of [...watchersByPath]) {
        if (!nextByPath.has(watchedPath)) {
          await closeWatcher(watchedPath, watcher);
          watchedRows.delete(watchedPath);
          dropSeenHashesUnder(watchedPath);
          fdExhausted.delete(watchedPath);
        }
      }

      // Open newly-added paths and re-attach reconfigured ones. Unchanged
      // paths are deliberately untouched so the engine's internal state
      // (settle timers, burst window) survives.
      for (const [nextPath, row] of nextByPath) {
        const existing = watchersByPath.get(nextPath);
        const previous = watchedRows.get(nextPath);
        if (existing && previous && engineConfigKey(previous) !== engineConfigKey(row)) {
          await closeWatcher(nextPath, existing);
        }
        watchedRows.set(nextPath, row);
        if (!watchersByPath.has(nextPath)) {
          fdExhausted.delete(nextPath);
          watchersByPath.set(nextPath, attachWatcher(row));
        }
      }

      currentRows = [...folders];
    },

    /**
     * Return a defensive copy of `currentRows` so callers can mutate freely
     * without disturbing the monitor's internal view.
     */
    getWatchedFolders(): LocalFolder[] {
      return [...currentRows];
    },

    /**
     * Folder import walk (first import, resume, and manual "Backfill now"):
     * hand every existing file to capture once, reusing `handleAddOrChange`
     * so the extension/glob/size chain, the big-file gate, and content-hash
     * dedup match live ingestion exactly (Requirement 3.2).
     *
     * The walk (`walkFolderFiles`) prunes static ignores, excluded subtrees,
     * and (non-recursive rows) subdirectories. Per file it is idempotent and
     * cooperative (LOCAL_FOLDER_IMPORT_SAFETY_PLAN.md C2/C3/C7):
     *   - an exact version already in the ledger or already captured (path +
     *     size + mtime signature of an existing item) is skipped;
     *   - below the import disk floor the walk stops with `paused`;
     *   - the file is recorded `imported` only after every capture listener
     *     finished (awaited), so an interrupted import resumes without
     *     duplicates and a failed store is retried by the next walk;
     *   - the event loop gets a turn between files.
     * One walk per folder: a concurrent request returns `busy`. A complete
     * walk sets the folder's first-import marker.
     *
     * Progress events follow the design doc:
     *
     *   - `started`  — first event, no counts (we don't pre-walk to get a
     *                  total because pre-counting doubles the IO; the SSE
     *                  client renders an indeterminate spinner until the
     *                  first `progress` event).
     *   - `progress` — every 50 files visited, carrying the running
     *                  `processed` count.
     *   - `done`     — terminal happy-path event with `total: processedCount`.
     *   - `aborted`  — terminal event when `opts.signal?.aborted` was
     *                  observed mid-walk; carries `processed` so the UI can
     *                  show "stopped at X files".
     *   - `error`    — non-terminal event emitted for per-directory
     *                  `readdir` failures (e.g. EACCES on a subdir) AND for
     *                  per-file handler exceptions; the walk continues so
     *                  a single bad subtree doesn't kill the run.
     *
     * Error handling for the row lookup is "emit then return" rather than
     * "throw": the route layer is wired to forward `BackfillProgress` events
     * verbatim onto the SSE stream, so a missing folder reads as a clean
     * `error` event followed by stream end rather than an exception that
     * 500s the request.
     */
    async backfill(
      folderId: number,
      opts?: { onProgress?: (p: BackfillProgress) => void; signal?: AbortSignal; expectedTotal?: number },
    ): Promise<BackfillResult> {
      const onProgress = opts?.onProgress;
      const signal = opts?.signal;

      // Re-read the row from the DB rather than scanning `currentRows` so a
      // backfill triggered immediately after a `POST /api/local-folders`
      // (where the new row may not be in `currentRows` yet if the route
      // ordering ever shifts) still finds it.
      const row = getLocalFolder(db, folderId);
      if (!row) {
        onProgress?.({
          phase: 'error',
          folderId,
          error: `Folder not found: id=${folderId}`,
        });
        return { aborted: false, total: 0 };
      }

      const walk = acquireWalk(folderId, 'import', opts?.expectedTotal ?? null);
      if (!walk) {
        onProgress?.({
          phase: 'error',
          folderId,
          reason: 'busy',
          error: 'This folder is already being imported. Wait for that import to finish, then try again.',
        });
        return { aborted: false, total: 0, busy: true };
      }

      let processed = 0;
      const tally = { imported: 0, unchanged: 0, needsReview: 0, tooLarge: 0, failed: 0 };
      const summary = () => ({ ...tally });
      try {
        onProgress?.({ phase: 'started', folderId });
        const excludes = compileExcludes(row.exclude_globs);
        const ledgerRows = ledger.forFolder(row.id);
        const signatures = watchdog.measure('folder-import:index', () => existingCaptureSignatures(db, row.path));

        for await (const entry of walkFolderFiles(row, excludes)) {
          // Cancellation check per candidate — abort latency is one file.
          if (signal?.aborted) {
            onProgress?.({ phase: 'aborted', folderId, processed });
            return { aborted: true };
          }
          if ('error' in entry) {
            // EACCES on a subtree, ENOENT mid-walk, etc. Emit an error event
            // for visibility but keep walking — one unreadable directory
            // shouldn't sink an otherwise-healthy backfill.
            onProgress?.({ phase: 'error', folderId, error: entry.error });
            continue;
          }

          const fullPath = entry.path;
          processed++;
          walk.processed = processed;
          if (processed % 50 === 0) {
            onProgress?.({ phase: 'progress', folderId, processed, ...summary() });
          }

          let stat: Stats;
          try {
            stat = await fsPromises.stat(fullPath);
          } catch {
            continue; // vanished between readdir and stat
          }
          if (!stat.isFile()) continue;

          // Idempotency (C2): this exact version was already handed over.
          const known = ledgerRows.get(fullPath) ?? null;
          if (known && known.size === stat.size && known.mtimeMs === stat.mtimeMs) {
            if (known.outcome === 'imported') { tally.unchanged++; continue; }
            if (known.outcome === 'needs_review') { tally.needsReview++; continue; }
            if (known.outcome === 'too_large') { tally.tooLarge++; continue; }
          }
          if (signatures.has(captureSignature(fullPath, String(stat.size), String(stat.mtimeMs)))) {
            tally.unchanged++;
            continue;
          }

          // Disk floor (C7): pause the whole import; the next run resumes.
          const lowFree = await importDiskLow();
          if (lowFree != null) {
            onProgress?.({ phase: 'paused', folderId, processed, reason: 'low_disk', freeBytes: lowFree, ...summary() });
            return { aborted: false, total: processed, paused: 'low_disk', ...summary() };
          }

          try {
            const result = watchdog.measure('folder-import', () => handleAddOrChange(row, fullPath, 'backfill', { stat, known, importWalk: true }));
            if (result.outcome === 'captured') {
              if (await result.done) tally.imported++;
              else tally.failed++;
            } else if (result.outcome === 'needs_review') tally.needsReview++;
            else if (result.outcome === 'too_large') tally.tooLarge++;
            else if (result.outcome === 'unchanged') tally.unchanged++;
          } catch (err) {
            tally.failed++;
            onProgress?.({
              phase: 'error',
              folderId,
              error: `handler failed for ${fullPath}: ${(err as Error).message ?? String(err)}`,
            });
            // Fall through — the file stays unrecorded and is retried later.
          }
          await yieldToLoop();
        }

        if (signal?.aborted) {
          onProgress?.({ phase: 'aborted', folderId, processed });
          return { aborted: true };
        }
        // A complete walk is the folder's first import (idempotent re-runs).
        markFirstImportDone(db, row.id);
        onProgress?.({ phase: 'done', folderId, total: processed, ...summary() });
        return { aborted: false, total: processed, ...summary() };
      } finally {
        walks.delete(folderId);
      }
    },

    isWalking(folderId: number): boolean {
      return walks.has(folderId);
    },

    walkState(folderId: number): FolderWalkState | null {
      const state = walks.get(folderId);
      return state ? { ...state } : null;
    },

    /**
     * Read-only first-import scan (C8): walks the folder with the import's
     * exact filters, stats candidates (no content is read), and records big
     * files as `needs_review` and over-ceiling files as `too_large`. After a
     * complete scan, held rows for paths no longer present are removed, so
     * the review list only names files that exist.
     */
    async scanFolder(folderId: number, opts?: { signal?: AbortSignal }): Promise<FolderScanResult> {
      const signal = opts?.signal;
      const row = getLocalFolder(db, folderId);
      const empty = { walked: 0, files: 0, bytes: 0, importable: 0, unchanged: 0, needsReview: 0, tooLarge: 0 };
      if (!row) return { aborted: false, ...empty };
      const walk = acquireWalk(folderId, 'scan');
      if (!walk) return { aborted: false, busy: true, ...empty };
      try {
        const excludes = compileExcludes(row.exclude_globs);
        const ledgerRows = ledger.forFolder(row.id);
        const signatures = watchdog.measure('folder-scan:index', () => existingCaptureSignatures(db, row.path));
        const result = { ...empty };
        // Ledger paths still present as candidates (bounded by ledger size).
        const seenKnown = new Set<string>();
        let sinceYield = 0;

        for await (const entry of walkFolderFiles(row, excludes)) {
          if (signal?.aborted) return { aborted: true };
          if ('error' in entry) continue;
          const fullPath = entry.path;
          result.walked++;
          walk.processed = result.walked;
          const ext = path.extname(fullPath).toLowerCase();
          if (SKIP_EXTENSIONS.has(ext)) continue;
          if (row.include_globs.length > 0 && !matchesAnyGlob(fullPath, row.include_globs)) continue;
          let stat: Stats;
          try {
            stat = await fsPromises.stat(fullPath);
          } catch {
            continue;
          }
          if (!stat.isFile()) continue;
          result.files++;
          result.bytes += stat.size;
          const known = ledgerRows.get(fullPath) ?? null;
          if (known) seenKnown.add(fullPath);
          const sameVersion = Boolean(known && known.size === stat.size && known.mtimeMs === stat.mtimeMs);
          if ((sameVersion && known?.outcome === 'imported')
            || signatures.has(captureSignature(fullPath, String(stat.size), String(stat.mtimeMs)))) {
            result.unchanged++;
          } else if (stat.size > MAX_FILE_BYTES) {
            holdFile(row, fullPath, stat, 'too_large', 'import', known);
            result.tooLarge++;
          } else if (stat.size >= thresholds.bigFileBytes && !ownerKept(known)) {
            holdFile(row, fullPath, stat, 'needs_review', 'import', known);
            result.needsReview++;
          } else {
            result.importable++;
          }
          if (++sinceYield >= 64) {
            sinceYield = 0;
            await yieldToLoop();
          }
        }
        if (signal?.aborted) return { aborted: true };

        // Complete scans only: forget rows for files that are gone, so the
        // review list names only files that exist. Excluded subtrees are
        // pruned from the walk, so excluded rows are checked directly.
        for (const [knownPath, record] of ledgerRows) {
          if (seenKnown.has(knownPath)) continue;
          if (record.outcome === 'excluded') {
            try { await fsPromises.stat(knownPath); } catch { ledger.remove(row.id, knownPath); }
            continue;
          }
          ledger.remove(row.id, knownPath);
        }
        return { aborted: false, ...result };
      } finally {
        walks.delete(folderId);
      }
    },

    /**
     * Import held rows the owner kept (`approved`) or live changes deferred
     * for low disk. Each file is re-checked against the folder's current
     * exclusions, existence, the gate, and the import disk floor.
     */
    async importFiles(folderId: number, records: FolderFileRecord[], opts?: { signal?: AbortSignal }): Promise<ImportFilesResult> {
      const signal = opts?.signal;
      const row = getLocalFolder(db, folderId);
      if (!row) return { aborted: false, imported: 0, held: 0, failed: 0 };
      const walk = acquireWalk(folderId, 'import', records.length);
      if (!walk) return { aborted: false, busy: true, imported: 0, held: 0, failed: 0 };
      const tally = { imported: 0, held: 0, failed: 0 };
      try {
        const excludes = compileExcludes(row.exclude_globs);
        for (const record of records) {
          if (signal?.aborted) return { aborted: true };
          walk.processed++;
          const current = ledger.get(row.id, record.path);
          if (!current || (current.outcome !== 'approved' && current.outcome !== 'deferred_low_disk')) continue;
          if (excludes.matchesFile(record.path)) {
            ledger.setOutcome(row.id, record.path, 'excluded');
            continue;
          }
          let stat: Stats;
          try {
            stat = await fsPromises.stat(record.path);
          } catch {
            ledger.remove(row.id, record.path);
            continue;
          }
          if (!stat.isFile()) {
            ledger.remove(row.id, record.path);
            continue;
          }
          const lowFree = await importDiskLow();
          if (lowFree != null) return { aborted: false, ...tally, paused: 'low_disk' };
          const captureMode: CaptureMode = current.origin === 'live' ? 'live' : 'backfill';
          try {
            const result = watchdog.measure('folder-import', () => handleAddOrChange(row, record.path, captureMode, { stat, known: current, importWalk: true }));
            if (result.outcome === 'captured') {
              if (await result.done) tally.imported++;
              else tally.failed++;
            } else if (result.outcome === 'unchanged') {
              // Already captured by this process: the pending row is satisfied.
              ledger.record({ folderId: row.id, path: record.path, size: stat.size, mtimeMs: stat.mtimeMs, outcome: 'imported' });
            } else if (result.outcome === 'needs_review' || result.outcome === 'too_large') {
              tally.held++;
            } else if (result.outcome === 'ignored' || result.outcome === 'missing') {
              // No longer a capture candidate (type or include globs changed):
              // drop the pending row so it is not retried on every pass.
              ledger.remove(row.id, record.path);
            }
          } catch (err) {
            tally.failed++;
            console.warn(`[filesystem-monitor] pending import failed for ${record.path}:`, (err as Error)?.message ?? err);
          }
          await yieldToLoop();
        }
        return { aborted: false, ...tally };
      } finally {
        walks.delete(folderId);
      }
    },
  };
}

/** Engine-held row configuration; a change requires re-attaching the watcher. */
function engineConfigKey(row: LocalFolder): string {
  return JSON.stringify([Boolean(row.recursive), row.exclude_globs]);
}

function formatGiB(bytes: number | null): string {
  if (bytes == null) return 'unknown';
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}
