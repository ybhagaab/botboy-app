/**
 * Folder import scheduler (LOCAL_FOLDER_IMPORT_SAFETY_PLAN.md C1/C7/C8).
 *
 * Identity: a background capture service. It never runs during startup —
 * `start()` is called after final-ready and arms a delay before the first
 * pass — and it imports one folder at a time. For each enabled folder:
 *
 *   1. First import (no `local_folders.backfilled.<id>` marker): a read-only
 *      scan records big files (≥ 25 MB) as `needs_review` and over-ceiling
 *      files as `too_large`. Any undecided big file ⇒ the folder waits
 *      ("watching only": live changes are captured, the import waits for the
 *      owner's review). Otherwise the import walk runs; a complete walk sets
 *      the marker.
 *   2. Pending rows: files the owner kept (`approved`) and live changes
 *      deferred for low disk are imported.
 *
 * Below the import disk floor a pass pauses and retries every minute. Every
 * pass registers with the shutdown coordinator, so a stop request aborts the
 * active walk within one file. Owner decisions arrive through `decide`
 * (protected by the router), are stored as literal `exclude_globs` entries,
 * and kick a new pass.
 */

import path from 'path';
import type Database from 'better-sqlite3';
import { getLocalFolder, listLocalFolders, updateLocalFolder, type LocalFolder } from '../core/local-folders-config.js';
import type { DiskSpaceMonitor } from '../core/disk-space.js';
import type { ShutdownRuntimeContext } from '../core/shutdown-coordinator.js';
import { NOOP_MAIN_THREAD_WATCHDOG, type MainThreadStats, type MainThreadWatchdog } from '../core/main-thread-watchdog.js';
import {
  READABLE_EXTENSIONS,
  clearFirstImportDone,
  contentRemovedPaths,
  directoryGlobForPath,
  folderImportThresholds,
  isFirstImportDone,
  literalGlobForPath,
  parseLiteralGlob,
  type FolderFileCounts,
  type FolderImportThresholds,
  type LocalFolderImportLedger,
} from '../core/local-folder-imports.js';
import { LOCAL_FOLDER_MAX_FILE_BYTES, type FilesystemMonitorWithImports, type FolderWalkState } from './filesystem-monitor.js';

export type FolderImportPhase =
  | 'disabled'
  | 'waiting'
  | 'scanning'
  | 'importing'
  | 'needs_review'
  | 'paused_low_disk'
  | 'watching';

export interface FolderImportResultSummary {
  at: number;
  kind: 'scan' | 'import' | 'pending';
  imported: number;
  unchanged: number;
  needsReview: number;
  tooLarge: number;
  failed: number;
  paused: boolean;
}

export interface FolderImportFolderStatus {
  folderId: number;
  path: string;
  enabled: boolean;
  phase: FolderImportPhase;
  firstImportDone: boolean;
  progress: FolderWalkState | null;
  counts: FolderFileCounts;
  /** Excluded-by-review entries (literal files and subfolders) in `exclude_globs`. */
  excludedEntries: number;
  lastResult: FolderImportResultSummary | null;
  lastError: string | null;
}

export interface FolderImportStatus {
  started: boolean;
  firstPassAt: number | null;
  disk: {
    freeBytes: number | null;
    totalBytes: number | null;
    measuredAt: number | null;
    importFloorBytes: number;
    liveFloorBytes: number;
    importsPaused: boolean;
    liveCapturesPaused: boolean;
  };
  thresholds: { bigFileBytes: number; maxFileBytes: number };
  mainThread: MainThreadStats;
  folders: FolderImportFolderStatus[];
}

export interface FolderReviewFile {
  path: string;
  /** Path relative to the folder root. */
  relPath: string;
  /** Subfolder relative to the root ('' for files directly in it). */
  dir: string;
  name: string;
  ext: string;
  size: number;
  mtimeMs: number;
  decision: 'undecided' | 'keep' | 'exclude';
  imported: boolean;
  readable: boolean;
  contentRemoved: boolean;
}

export interface FolderReview {
  folderId: number;
  root: string;
  bigFileBytes: number;
  maxFileBytes: number;
  undecided: number;
  files: FolderReviewFile[];
  tooLarge: Array<{ path: string; relPath: string; dir: string; name: string; ext: string; size: number }>;
  excludedDirs: Array<{ path: string; relPath: string; files: number }>;
}

export interface ReviewDecision {
  keep?: string[];
  exclude?: string[];
  excludeDirs?: string[];
  restoreDirs?: string[];
}

export type ReviewDecisionResult =
  | {
    ok: true;
    applied: { kept: number; excluded: number; excludedDirs: number; restoredDirs: number };
    review: FolderReview;
  }
  | {
    ok: false;
    status: 400 | 404;
    code: 'not_found' | 'invalid_decision';
    error: string;
    invalid?: Array<{ path: string; reason: string }>;
    nextAction: string;
  };

export interface FolderImportScheduler {
  /** Arm the first pass (`startDelayMs` after final-ready). Idempotent. */
  start(): void;
  /** Stop scheduling and abort the active walk. */
  stop(): void;
  /** Wait (bounded by the caller) for the active pass to finish after `stop`. */
  drain(): Promise<void>;
  /** Request a pass soon (after start); coalesces with a running pass. */
  kick(): void;
  /** A folder was disabled, deleted, or reconfigured: abort its active walk. */
  folderChanged(folderId: number): void;
  /** Forget ledger rows and the first-import marker of a deleted folder. */
  forgetFolder(folderId: number): void;
  isFolderBusy(folderId: number): boolean;
  status(): FolderImportStatus;
  review(folderId: number): FolderReview | null;
  decide(folderId: number, decision: ReviewDecision): Promise<ReviewDecisionResult>;
}

const MAX_DECISION_ENTRIES = 20_000;

export function createFolderImportScheduler(deps: {
  db: Database.Database;
  monitor: FilesystemMonitorWithImports;
  ledger: LocalFolderImportLedger;
  diskSpace?: DiskSpaceMonitor | null;
  thresholds?: FolderImportThresholds;
  watchdog?: MainThreadWatchdog;
  shutdown?: ShutdownRuntimeContext;
  readableExtensions?: ReadonlySet<string>;
  /** Delay after `start()` before the first pass. */
  startDelayMs?: number;
  /** Retry cadence while paused for disk or blocked by a busy folder. */
  retryMs?: number;
  /** Idle cadence that picks up deferred live changes. */
  idleMs?: number;
  now?: () => number;
}): FolderImportScheduler {
  const { db, monitor, ledger } = deps;
  const diskSpace = deps.diskSpace ?? null;
  const thresholds = deps.thresholds ?? folderImportThresholds();
  const watchdog = deps.watchdog ?? NOOP_MAIN_THREAD_WATCHDOG;
  const readable = deps.readableExtensions ?? READABLE_EXTENSIONS;
  const startDelayMs = deps.startDelayMs ?? 30_000;
  const retryMs = deps.retryMs ?? 60_000;
  const idleMs = deps.idleMs ?? 5 * 60_000;
  const now = deps.now ?? Date.now;

  let started = false;
  let stopped = false;
  let firstPassAt: number | null = null;
  let timer: NodeJS.Timeout | null = null;
  let running: Promise<void> | null = null;
  let rerun = false;
  let passCounter = 0;
  let active: { folderId: number; controller: AbortController } | null = null;
  const lastResults = new Map<number, FolderImportResultSummary>();
  const lastErrors = new Map<number, string>();

  function schedule(delayMs: number): void {
    if (stopped) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void runPass();
    }, Math.max(0, delayMs));
    timer.unref?.();
  }

  async function importFloorLow(): Promise<boolean> {
    if (!diskSpace) return false;
    const free = await diskSpace.freeBytes(5_000);
    return free != null && free < thresholds.importMinFreeBytes;
  }

  async function withFolderWalk<T>(folderId: number, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    active = { folderId, controller };
    try {
      return await run(controller.signal);
    } finally {
      if (active?.controller === controller) active = null;
    }
  }

  type FolderOutcome = 'done' | 'needs_review' | 'paused' | 'busy' | 'aborted' | 'stopped' | 'error';

  async function firstImport(folder: LocalFolder): Promise<FolderOutcome> {
    return withFolderWalk(folder.id, async (signal) => {
      const scan = await monitor.scanFolder(folder.id, { signal });
      if (scan.aborted) return stopped ? 'stopped' : 'aborted';
      if (scan.busy) return 'busy';
      if (scan.needsReview > 0) {
        lastResults.set(folder.id, {
          at: now(), kind: 'scan', imported: 0, unchanged: scan.unchanged,
          needsReview: scan.needsReview, tooLarge: scan.tooLarge, failed: 0, paused: false,
        });
        return 'needs_review';
      }
      const result = await monitor.backfill(folder.id, { signal, expectedTotal: scan.walked });
      if (result.aborted) return stopped ? 'stopped' : 'aborted';
      if (result.busy) return 'busy';
      lastResults.set(folder.id, {
        at: now(), kind: 'import',
        imported: result.imported ?? 0, unchanged: result.unchanged ?? 0,
        needsReview: result.needsReview ?? 0, tooLarge: result.tooLarge ?? 0,
        failed: result.failed ?? 0, paused: result.paused === 'low_disk',
      });
      return result.paused ? 'paused' : 'done';
    });
  }

  async function importPending(folder: LocalFolder): Promise<FolderOutcome> {
    const pending = ledger.list(folder.id, ['approved', 'deferred_low_disk']);
    if (pending.length === 0) return 'done';
    return withFolderWalk(folder.id, async (signal) => {
      const result = await monitor.importFiles(folder.id, pending, { signal });
      if (result.aborted) return stopped ? 'stopped' : 'aborted';
      if (result.busy) return 'busy';
      lastResults.set(folder.id, {
        at: now(), kind: 'pending', imported: result.imported, unchanged: 0,
        needsReview: result.held, tooLarge: 0, failed: result.failed, paused: result.paused === 'low_disk',
      });
      return result.paused ? 'paused' : 'done';
    });
  }

  /** One pass over enabled folders, one folder at a time. */
  async function passOnce(): Promise<'done' | 'paused' | 'retry' | 'stopped'> {
    let retry = false;
    for (const folder of listLocalFolders(db, { enabledOnly: true })) {
      if (stopped || deps.shutdown?.isShuttingDown()) return 'stopped';
      if (await importFloorLow()) return 'paused';
      try {
        let outcome: FolderOutcome = 'done';
        if (!isFirstImportDone(db, folder.id)) outcome = await firstImport(folder);
        if (outcome === 'done') outcome = await importPending(folder);
        if (outcome === 'stopped') return 'stopped';
        if (outcome === 'paused') return 'paused';
        if (outcome === 'busy') retry = true;
        if (outcome === 'done' || outcome === 'needs_review') lastErrors.delete(folder.id);
      } catch (err) {
        const message = String((err as Error)?.message ?? err).slice(0, 300);
        lastErrors.set(folder.id, message);
        console.warn(`[folder-imports] import of ${folder.path} failed: ${message}`);
      }
    }
    return retry ? 'retry' : 'done';
  }

  async function runPass(): Promise<void> {
    if (stopped || !started) return;
    if (running) {
      rerun = true;
      return running;
    }
    running = (async () => {
      const passId = ++passCounter;
      const unregister = deps.shutdown?.registerWork({
        id: `folder-imports:${passId}`,
        kind: 'local_folder_import',
        abort: () => active?.controller.abort(new Error('BotBoy process is shutting down')),
      });
      let next = idleMs;
      try {
        do {
          rerun = false;
          const outcome = await passOnce();
          if (outcome === 'stopped') return;
          if (outcome === 'paused' || outcome === 'retry') next = retryMs;
        } while (rerun && !stopped);
      } catch (err) {
        console.warn('[folder-imports] pass failed:', (err as Error)?.message ?? err);
        next = retryMs;
      } finally {
        unregister?.();
        running = null;
        if (!stopped) schedule(next);
      }
    })();
    return running;
  }

  function relativeParts(root: string, filePath: string): { relPath: string; dir: string; name: string } {
    const relPath = path.relative(root, filePath);
    const dir = path.dirname(relPath);
    return { relPath, dir: dir === '.' ? '' : dir, name: path.basename(filePath) };
  }

  function reviewEntriesIn(folder: LocalFolder): { files: Set<string>; dirs: Set<string> } {
    const files = new Set<string>();
    const dirs = new Set<string>();
    const rootPrefix = folder.path.endsWith(path.sep) ? folder.path : folder.path + path.sep;
    for (const glob of folder.exclude_globs) {
      const literal = parseLiteralGlob(glob);
      if (!literal || !literal.path.startsWith(rootPrefix)) continue;
      (literal.directory ? dirs : files).add(literal.path);
    }
    return { files, dirs };
  }

  function underAny(dirs: Iterable<string>, filePath: string): string | null {
    for (const dir of dirs) {
      if (filePath.startsWith(dir.endsWith(path.sep) ? dir : dir + path.sep)) return dir;
    }
    return null;
  }

  function buildReview(folder: LocalFolder): FolderReview {
    return watchdog.measure('folder-review', () => {
      const rows = [
        ...ledger.list(folder.id, ['too_large']),
        ...ledger.list(folder.id, ['needs_review', 'approved', 'excluded', 'imported'], thresholds.bigFileBytes),
      ];
      const removed = contentRemovedPaths(db, folder.path);
      const { dirs } = reviewEntriesIn(folder);
      const files: FolderReviewFile[] = [];
      const tooLarge: FolderReview['tooLarge'] = [];
      const excludedDirCounts = new Map<string, number>([...dirs].map(dir => [dir, 0]));
      let undecided = 0;
      for (const row of rows) {
        const parts = relativeParts(folder.path, row.path);
        const ext = path.extname(row.path).toLowerCase();
        if (row.outcome === 'too_large') {
          tooLarge.push({ path: row.path, ...parts, ext, size: row.size });
          continue;
        }
        if (row.size < thresholds.bigFileBytes) continue;
        if (row.outcome === 'excluded') {
          const dir = underAny(dirs, row.path);
          if (dir) {
            excludedDirCounts.set(dir, (excludedDirCounts.get(dir) ?? 0) + 1);
            continue;
          }
        }
        const decision: FolderReviewFile['decision'] = row.outcome === 'needs_review'
          ? 'undecided'
          : row.outcome === 'excluded' ? 'exclude' : 'keep';
        if (decision === 'undecided') undecided++;
        files.push({
          path: row.path,
          ...parts,
          ext,
          size: row.size,
          mtimeMs: row.mtimeMs,
          decision,
          imported: row.outcome === 'imported',
          readable: readable.has(ext),
          contentRemoved: removed.has(row.path),
        });
      }
      return {
        folderId: folder.id,
        root: folder.path,
        bigFileBytes: thresholds.bigFileBytes,
        maxFileBytes: LOCAL_FOLDER_MAX_FILE_BYTES,
        undecided,
        files,
        tooLarge,
        excludedDirs: [...excludedDirCounts].map(([dir, count]) => ({
          path: dir,
          relPath: path.relative(folder.path, dir),
          files: count,
        })),
      };
    });
  }

  function phaseFor(
    folder: LocalFolder,
    counts: FolderFileCounts,
    progress: FolderWalkState | null,
    firstDone: boolean,
    importsPaused: boolean,
  ): FolderImportPhase {
    if (!folder.enabled) return 'disabled';
    if (progress) return progress.kind === 'scan' ? 'scanning' : 'importing';
    if (counts.needs_review > 0) return 'needs_review';
    const pendingWork = !firstDone || counts.approved > 0 || counts.deferred_low_disk > 0;
    if (pendingWork && importsPaused) return 'paused_low_disk';
    if (pendingWork) return 'waiting';
    return 'watching';
  }

  function kick(): void {
    if (!started || stopped) return;
    if (running) {
      rerun = true;
      return;
    }
    // Before the first pass is due, the armed start timer covers it.
    if (firstPassAt != null && now() < firstPassAt) return;
    schedule(250);
  }

  return {
    start() {
      if (started || stopped) return;
      started = true;
      firstPassAt = now() + startDelayMs;
      schedule(startDelayMs);
    },

    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
      active?.controller.abort(new Error('Folder imports stopped'));
    },

    async drain() {
      try { await running; } catch { /* already logged */ }
    },

    kick,

    folderChanged(folderId) {
      if (active?.folderId === folderId) active.controller.abort(new Error('Folder configuration changed'));
      kick();
    },

    forgetFolder(folderId) {
      if (active?.folderId === folderId) active.controller.abort(new Error('Folder removed'));
      ledger.removeFolder(folderId);
      clearFirstImportDone(db, folderId);
      lastResults.delete(folderId);
      lastErrors.delete(folderId);
    },

    isFolderBusy(folderId) {
      return monitor.isWalking(folderId);
    },

    status() {
      const snapshot = diskSpace?.snapshot() ?? { freeBytes: null, totalBytes: null, measuredAt: null };
      // Refresh the cached value in the background for the next poll.
      diskSpace?.cachedFreeBytes();
      const free = snapshot.freeBytes;
      const importsPaused = free != null && free < thresholds.importMinFreeBytes;
      const folders = listLocalFolders(db).map((folder): FolderImportFolderStatus => {
        const counts = ledger.counts(folder.id);
        const progress = monitor.walkState(folder.id);
        const firstDone = isFirstImportDone(db, folder.id);
        const entries = reviewEntriesIn(folder);
        return {
          folderId: folder.id,
          path: folder.path,
          enabled: folder.enabled,
          phase: phaseFor(folder, counts, progress, firstDone, importsPaused),
          firstImportDone: firstDone,
          progress,
          counts,
          excludedEntries: entries.files.size + entries.dirs.size,
          lastResult: lastResults.get(folder.id) ?? null,
          lastError: lastErrors.get(folder.id) ?? null,
        };
      });
      return {
        started,
        firstPassAt,
        disk: {
          freeBytes: free,
          totalBytes: snapshot.totalBytes,
          measuredAt: snapshot.measuredAt,
          importFloorBytes: thresholds.importMinFreeBytes,
          liveFloorBytes: thresholds.liveMinFreeBytes,
          importsPaused,
          liveCapturesPaused: free != null && free < thresholds.liveMinFreeBytes,
        },
        thresholds: { bigFileBytes: thresholds.bigFileBytes, maxFileBytes: LOCAL_FOLDER_MAX_FILE_BYTES },
        mainThread: watchdog.stats(),
        folders,
      };
    },

    review(folderId) {
      const folder = getLocalFolder(db, folderId);
      return folder ? buildReview(folder) : null;
    },

    async decide(folderId, decision) {
      const folder = getLocalFolder(db, folderId);
      if (!folder) {
        return {
          ok: false, status: 404, code: 'not_found',
          error: `No folder with id ${folderId}`,
          nextAction: 'Reload Local folders; the folder may have been removed.',
        };
      }
      const keep = [...new Set(decision.keep ?? [])];
      const exclude = [...new Set(decision.exclude ?? [])];
      const excludeDirs = [...new Set(decision.excludeDirs ?? [])];
      const restoreDirs = [...new Set(decision.restoreDirs ?? [])];
      const invalid: Array<{ path: string; reason: string }> = [];
      const total = keep.length + exclude.length + excludeDirs.length + restoreDirs.length;
      if (total === 0 || total > MAX_DECISION_ENTRIES) {
        return {
          ok: false, status: 400, code: 'invalid_decision',
          error: total === 0
            ? 'The decision names no files or subfolders.'
            : `The decision names ${total} entries; the limit is ${MAX_DECISION_ENTRIES}.`,
          nextAction: 'Choose files to import or exclude in the review list, then save.',
        };
      }

      const rootPrefix = folder.path.endsWith(path.sep) ? folder.path : folder.path + path.sep;
      const insideRoot = (candidate: string) => typeof candidate === 'string'
        && candidate.length <= 4096
        && !candidate.includes('\u0000')
        && path.isAbsolute(candidate)
        && path.normalize(candidate) === candidate
        && candidate.startsWith(rootPrefix);
      const { dirs: currentDirs } = reviewEntriesIn(folder);
      const reviewable = new Map(ledger.list(folder.id, ['needs_review', 'approved', 'excluded', 'imported'], thresholds.bigFileBytes)
        .map(row => [row.path, row]));
      const keepSet = new Set(keep);
      const restoring = new Set(restoreDirs);

      for (const filePath of keep) {
        if (!insideRoot(filePath)) invalid.push({ path: filePath, reason: 'is not a file inside this folder' });
        else if (!reviewable.has(filePath)) invalid.push({ path: filePath, reason: 'is not in this folder’s big-file list' });
        else if (underAny(excludeDirs, filePath)) invalid.push({ path: filePath, reason: 'is inside a subfolder this decision excludes' });
        else {
          const excludedDir = underAny([...currentDirs].filter(dir => !restoring.has(dir)), filePath);
          if (excludedDir) invalid.push({ path: filePath, reason: `is inside the excluded subfolder ${path.relative(folder.path, excludedDir)}; restore that subfolder first` });
        }
      }
      for (const filePath of exclude) {
        if (!insideRoot(filePath)) invalid.push({ path: filePath, reason: 'is not a file inside this folder' });
        else if (!reviewable.has(filePath)) invalid.push({ path: filePath, reason: 'is not in this folder’s big-file list' });
        else if (keepSet.has(filePath)) invalid.push({ path: filePath, reason: 'is marked both import and exclude' });
      }
      for (const dir of excludeDirs) {
        if (!insideRoot(dir)) invalid.push({ path: dir, reason: 'is not a subfolder inside this folder' });
        else if (restoring.has(dir)) invalid.push({ path: dir, reason: 'is marked both exclude and restore' });
      }
      for (const dir of restoreDirs) {
        if (!currentDirs.has(dir)) invalid.push({ path: dir, reason: 'is not an excluded subfolder of this folder' });
      }
      if (invalid.length > 0) {
        return {
          ok: false, status: 400, code: 'invalid_decision',
          error: `${invalid.length} entr${invalid.length === 1 ? 'y' : 'ies'} could not be applied; nothing was changed.`,
          invalid: invalid.slice(0, 100),
          nextAction: 'Reload the big-file list and choose again.',
        };
      }

      // One transaction: exclusion globs and ledger decisions change together.
      const apply = db.transaction(() => {
        const globs = [...folder.exclude_globs];
        const present = new Set(globs);
        const add = (glob: string) => {
          if (!present.has(glob)) { globs.push(glob); present.add(glob); }
        };
        const drop = new Set<string>();
        for (const filePath of exclude) add(literalGlobForPath(filePath));
        for (const dir of excludeDirs) add(directoryGlobForPath(dir));
        for (const filePath of keep) drop.add(literalGlobForPath(filePath));
        for (const dir of restoreDirs) drop.add(directoryGlobForPath(dir));
        const nextGlobs = globs.filter(glob => !drop.has(glob));
        const updated = updateLocalFolder(db, folder.id, { exclude_globs: nextGlobs });
        if (!updated.ok) throw new Error(updated.message);

        for (const filePath of keep) {
          const row = reviewable.get(filePath);
          if (row && row.outcome !== 'imported') ledger.setOutcome(folder.id, filePath, 'approved');
        }
        for (const filePath of exclude) ledger.setOutcome(folder.id, filePath, 'excluded');
        for (const dir of excludeDirs) ledger.excludeUnder(folder.id, dir);
        for (const dir of restoreDirs) {
          for (const row of ledger.listUnder(folder.id, dir, ['excluded'])) {
            if (row.size >= thresholds.bigFileBytes) ledger.setOutcome(folder.id, row.path, 'needs_review');
            else ledger.remove(folder.id, row.path);
          }
        }
        // Restored subtrees were never walked: walk the folder again. The
        // walk skips every unchanged file, so this costs one cheap pass.
        if (restoreDirs.length > 0) clearFirstImportDone(db, folder.id);
      });
      try {
        apply();
      } catch (err) {
        return {
          ok: false, status: 400, code: 'invalid_decision',
          error: `The decision could not be saved: ${String((err as Error)?.message ?? err).slice(0, 200)}`,
          nextAction: 'Reload the big-file list and choose again.',
        };
      }

      // The engine holds exclude globs: re-attach before new events arrive.
      try {
        await monitor.setWatchedFolders(listLocalFolders(db));
      } catch (err) {
        console.warn('[folder-imports] setWatchedFolders failed after a review decision:', (err as Error)?.message ?? err);
      }
      kick();
      const refreshed = getLocalFolder(db, folder.id) ?? folder;
      return {
        ok: true,
        applied: {
          kept: keep.length,
          excluded: exclude.length,
          excludedDirs: excludeDirs.length,
          restoredDirs: restoreDirs.length,
        },
        review: buildReview(refreshed),
      };
    },
  };
}
