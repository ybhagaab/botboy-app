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
import { statSync, watch as fsNativeWatch, promises as fsPromises } from 'fs';
import path from 'path';
import type Database from 'better-sqlite3';
import type { RawWorkItem } from '../core/types.js';
import type { DocumentParser } from '../core/document-parser.js';
import type { LocalFolder } from '../core/local-folders-config.js';
import { listLocalFolders, getLocalFolder } from '../core/local-folders-config.js';

// ── Public types ───────────────────────────────────────────────────────────

/**
 * Progress event emitted during a `backfill` run. Mirrors the SSE event shape
 * the route handler will forward to the client. The `phase` field is the
 * discriminant; not every field is populated for every phase.
 */
export interface BackfillProgress {
  phase: 'started' | 'progress' | 'done' | 'error' | 'aborted';
  folderId: number;
  total?: number;
  processed?: number;
  error?: string;
}

/**
 * Terminal result returned by `backfill`. `aborted: true` is returned when
 * the caller-provided `AbortSignal` fired mid-walk; otherwise `aborted: false`
 * with the total number of files inspected.
 */
export type BackfillResult =
  | { aborted: true }
  | { aborted: false; total: number };

/**
 * Public surface area of the filesystem monitor. Mirrors the slack-monitor
 * shape (start/stop/onWorkItem) and adds the watched-folders diff control
 * plus a `backfill` API used by the SSE backfill route.
 */
export interface FilesystemMonitor {
  start(): Promise<void>;
  stop(): Promise<void>;
  onWorkItem(cb: (item: RawWorkItem) => void): void;
  setWatchedFolders(folders: LocalFolder[]): Promise<void>;
  getWatchedFolders(): LocalFolder[];
  backfill(
    folderId: number,
    opts?: { onProgress?: (p: BackfillProgress) => void; signal?: AbortSignal },
  ): Promise<BackfillResult>;
}

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
 * `?` (single char). Other regex metacharacters are escaped. Patterns that do
 * not contain a `/` are matched against the file's basename so `*.md` matches
 * any markdown file regardless of directory depth.
 */
function compileGlob(glob: string): RegExp {
  let pattern = '';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === '*') {
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
  return new RegExp('^' + pattern + '$');
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
    if (row.exclude_globs.length > 0 && matchesAnyGlob(absolutePath, row.exclude_globs)) return;

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
}): FilesystemMonitor {
  const { db, documentParser } = deps;
  const watchEngine = deps.watchEngine ?? createNativeWatchEngine;

  const watchersByPath = new Map<string, WatchHandle>();
  let currentRows: LocalFolder[] = [];
  const seenHashes = new Map<string, string>();
  const listeners: Array<(item: RawWorkItem) => void> = [];
  // Folders whose watcher was force-closed after exhausting file descriptors.
  // Collapses an EMFILE error storm into a single actionable log line and
  // exactly one close() call (last-resort fuse; the native engine's O(1)
  // descriptor cost makes this near-impossible to trip).
  const fdExhausted = new Set<string>();

  // ── Private helpers ────────────────────────────────────────────────────

  /**
   * Fan-out a `RawWorkItem` to every registered listener. Each listener is
   * isolated — one throwing handler does not block siblings, matching the
   * clipboard-monitor pattern.
   */
  function emit(item: RawWorkItem): void {
    for (const fn of listeners) {
      try {
        fn(item);
      } catch (err) {
        console.error('[filesystem-monitor] listener error:', err);
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

  /**
   * Emit-or-skip a single file under `row`. The filter chain is:
   *
   *   1. `stat` the file (catch ENOENT/EACCES so a transient unlink during
   *      processing is silent rather than crashing the watcher).
   *   2. Skip when `size > MAX_FILE_BYTES` (Requirement 8.2).
   *   3. Skip when `extname(filePath)` is not in
   *      `documentParser.getSupportedFormats()` (Requirement 8.3 / 2.3).
   *   4. Skip when `row.include_globs` is non-empty AND nothing matches
   *      (Requirement 2.2).
   *   5. Parse via `documentParser.parse`. On `success: false` warn-log and
   *      return without emitting (Requirement 2.4).
   *   6. Compute `sha256(text)`. If the hash matches the last-seen hash for
   *      this file, short-circuit — this is the §2.5 content dedup that
   *      prevents `chokidar` `change` events triggered by `mtime`-only
   *      touches from flooding the classifier.
   *   7. Emit a `RawWorkItem` with the canonical filesystem shape per the
   *      design doc (`source: 'filesystem'`, `sourceApp: 'Local Files'`,
   *      `type: 'document_capture'`, `url: 'file://' + filePath`, full
   *      `metadata` map).
   *
   * Skipped paths are debug-logged with their reason so users can diagnose
   * missing ingests via `LOCAL_FOLDERS_DEBUG=1` (Requirement 8.5).
   */
  function handleAddOrChange(row: LocalFolder, filePath: string): void {
    let stat: ReturnType<typeof statSync>;
    try {
      stat = statSync(filePath);
    } catch (err) {
      if (process.env.LOCAL_FOLDERS_DEBUG) {
        console.debug(
          `[filesystem-monitor] stat failed for ${filePath}:`,
          (err as Error).message,
        );
      }
      return;
    }

    // 1. Size cap.
    if (stat.size > MAX_FILE_BYTES) {
      if (process.env.LOCAL_FOLDERS_DEBUG) {
        console.debug(
          `[filesystem-monitor] skip (size>${MAX_FILE_BYTES}): ${filePath} (${stat.size} bytes)`,
        );
      }
      return;
    }

    const ext = path.extname(filePath).toLowerCase();

    // 1b. Skip clearly-non-textual file types (video/audio/archive/binary/
    //     design assets). A productivity tracker has no text to gain from these,
    //     and OCR'ing them is wasteful — so we don't ingest them at all.
    if (SKIP_EXTENSIONS.has(ext)) {
      if (process.env.LOCAL_FOLDERS_DEBUG) {
        console.debug(`[filesystem-monitor] skip (non-content type ${ext}): ${filePath}`);
      }
      return;
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
      return;
    }

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
          return;
        }
        seenHashes.set(filePath, contentHash);
        emit({
          type: 'document_capture',
          source: 'filesystem',
          sourceApp: 'Local Files',
          url: 'file://' + filePath,
          title: path.basename(filePath),
          content: parsed.text,
          metadata: {
            filePath, fileType: ext,
            mtime: String(stat.mtimeMs), size: String(stat.size), contentHash,
          },
          capturedAt: new Date(),
        });
        return;
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
      return;
    }
    seenHashes.set(filePath, signature);
    emit({
      type: 'document_capture',
      source: 'filesystem',
      sourceApp: 'Local Files',
      url: 'file://' + filePath,
      title: path.basename(filePath),
      content: '', // extractor fills this via parse/OCR from metadata.filePath
      metadata: {
        filePath, fileType: ext,
        mtime: String(stat.mtimeMs), size: String(stat.size),
      },
      capturedAt: new Date(),
    });
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
  function handleUnlink(_row: LocalFolder, filePath: string): void {
    const item: RawWorkItem = {
      type: 'document_capture',
      source: 'filesystem',
      sourceApp: 'Local Files',
      url: 'file://' + filePath,
      title: path.basename(filePath),
      content: '',
      metadata: {
        filePath,
        archived: 'true',
      },
      capturedAt: new Date(),
    };
    emit(item);
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
    const handle = watchEngine(row, {
      onAddOrChange: (filePath) => handleAddOrChange(row, filePath),
      onUnlink: (filePath) => {
        // Parity with the previous engine's contract: unlink fires only for
        // paths we actually ingested. Without this guard, a transient editor
        // temp file (created and renamed away within the settle window) would
        // emit a spurious archive item for a path that never existed
        // downstream.
        if (!seenHashes.has(filePath)) return;
        handleUnlink(row, filePath);
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
      seenHashes.clear();
      currentRows = [];
    },

    /**
     * Register a fan-out callback for emitted work items. Multiple callbacks
     * are supported; ordering is registration order.
     */
    onWorkItem(cb: (item: RawWorkItem) => void): void {
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
     *      flicker, no replay.
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

      // Close removed paths (await each to avoid leaking fds across rapid
      // reconfigure calls).
      for (const [watchedPath, watcher] of [...watchersByPath]) {
        if (!nextByPath.has(watchedPath)) {
          try {
            await watcher.close();
          } catch (err) {
            console.warn(
              `[filesystem-monitor] close failed for ${watchedPath}:`,
              err,
            );
          }
          watchersByPath.delete(watchedPath);
          dropSeenHashesUnder(watchedPath);
          fdExhausted.delete(watchedPath);
        }
      }

      // Open newly-added paths. Existing paths are deliberately untouched so
      // the engine's internal state (settle timers, burst window) survives.
      for (const [nextPath, row] of nextByPath) {
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
     * Walk a folder and re-emit every existing file as a work item, reusing
     * `handleAddOrChange` so the size/extension/glob filter chain and
     * content-hash dedup match live ingestion exactly (Requirement 3.2).
     *
     * The walker is a tiny breadth-first traversal over `fs.promises.readdir`
     * with `withFileTypes: true` so we get directory/file information without
     * a per-entry `stat`. Recursion respects `row.recursive`, and the same
     * `STATIC_IGNORES` applied to chokidar are evaluated at the basename
     * level on both directories (so e.g. `node_modules` is pruned before we
     * ever pay the `readdir` cost) and files (so `.DS_Store` and `*.lock`
     * never reach the parser).
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
      opts?: { onProgress?: (p: BackfillProgress) => void; signal?: AbortSignal },
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

      onProgress?.({ phase: 'started', folderId });

      const queue: string[] = [row.path];
      let processed = 0;

      while (queue.length > 0) {
        // Outer cancellation check — handles aborts that fire while the
        // queue is still draining but no entries remain in the inner loop.
        if (signal?.aborted) {
          onProgress?.({ phase: 'aborted', folderId, processed });
          return { aborted: true };
        }

        const dir = queue.shift() as string;

        let entries;
        try {
          entries = await fsPromises.readdir(dir, { withFileTypes: true });
        } catch (err) {
          // EACCES on a subtree, ENOENT mid-walk, etc. Emit an error event
          // for visibility but keep walking — one unreadable directory
          // shouldn't sink an otherwise-healthy backfill.
          onProgress?.({
            phase: 'error',
            folderId,
            error: `readdir failed for ${dir}: ${(err as Error).message ?? String(err)}`,
          });
          continue;
        }

        for (const entry of entries) {
          // Inner cancellation check — keeps abort latency proportional to
          // entries-per-directory rather than total-files.
          if (signal?.aborted) {
            onProgress?.({ phase: 'aborted', folderId, processed });
            return { aborted: true };
          }

          const fullPath = path.join(dir, entry.name);

          if (entry.isDirectory()) {
            if (isStaticallyIgnored(entry.name, true)) continue;
            if (row.recursive) queue.push(fullPath);
            continue;
          }

          // Skip non-regular files (sockets, fifos, char devices, broken
          // symlinks). chokidar does the same for live events.
          if (!entry.isFile()) continue;

          if (isStaticallyIgnored(entry.name, false)) continue;

          try {
            handleAddOrChange(row, fullPath);
          } catch (err) {
            onProgress?.({
              phase: 'error',
              folderId,
              error: `handler failed for ${fullPath}: ${(err as Error).message ?? String(err)}`,
            });
            // Fall through — count the file as processed so the progress
            // counter doesn't stall on a single bad input.
          }

          processed++;
          if (processed % 50 === 0) {
            onProgress?.({ phase: 'progress', folderId, processed });
          }
        }
      }

      onProgress?.({ phase: 'done', folderId, total: processed });
      return { aborted: false, total: processed };
    },
  };
}
