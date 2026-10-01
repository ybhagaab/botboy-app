/**
 * Storage card measurement (LOCAL_FOLDER_IMPORT_SAFETY_PLAN.md C11).
 *
 * Reports where BotBoy's disk use goes — database, stored file text, model
 * request logs, repair backups, attachments and caches, and the debug Chrome
 * profile — plus the Mac's free space, the folder-import floors, and the next
 * actions that free space. Sizes are allocated blocks measured by
 * `/usr/bin/du -sk` in a child process (never on the main thread), so the
 * card matches `du` by construction. Results are cached for 10 minutes and
 * refreshed on demand; concurrent requests share one measurement.
 */

import { execFile } from 'child_process';
import { promises as fsPromises } from 'fs';
import path from 'path';
import type { DiskSpaceMonitor } from './disk-space.js';
import type { FolderImportThresholds } from './local-folder-imports.js';

export type StorageCategoryKey = 'database' | 'fileText' | 'promptLogs' | 'backups' | 'other' | 'chromeProfile';

export interface StorageCategory {
  key: StorageCategoryKey;
  label: string;
  bytes: number;
  paths: string[];
}

export interface StorageUsageReport {
  measuredAt: number;
  durationMs: number;
  dataDir: string;
  /** BotBoy's total use: its data directory plus the debug Chrome profile. */
  botboyBytes: number;
  categories: StorageCategory[];
  disk: { freeBytes: number | null; totalBytes: number | null };
  floors: { importFloorBytes: number; liveFloorBytes: number };
  warnings: Array<{ level: 'import' | 'live'; message: string }>;
  nextActions: string[];
  error?: string;
}

export interface StorageUsageService {
  get(opts?: { refresh?: boolean }): Promise<StorageUsageReport>;
}

/** Measures allocated bytes for each path (children of one call must be disjoint). */
export type DuRunner = (paths: string[]) => Promise<Map<string, number>>;

/** `/usr/bin/du -sk` over disjoint paths; unreadable subpaths still report what du counted. */
export const runDu: DuRunner = (paths) => new Promise((resolve, reject) => {
  if (paths.length === 0) return resolve(new Map());
  execFile('/usr/bin/du', ['-sk', ...paths], { timeout: 120_000, maxBuffer: 1024 * 1024 }, (err, stdout) => {
    const sizes = new Map<string, number>();
    for (const line of String(stdout ?? '').split('\n')) {
      const match = /^(\d+)\t(.+)$/.exec(line);
      if (match) sizes.set(match[2], Number(match[1]) * 1024);
    }
    if (err && sizes.size === 0) return reject(err);
    resolve(sizes);
  });
});

const GB = 1024 ** 3;

type UsageCore = Omit<StorageUsageReport, 'disk' | 'warnings' | 'nextActions' | 'floors'>;

function formatGB(bytes: number): string {
  return `${(bytes / GB).toFixed(1)} GB`;
}

async function existing(paths: string[]): Promise<string[]> {
  const present: string[] = [];
  for (const candidate of paths) {
    try {
      await fsPromises.lstat(candidate);
      present.push(candidate);
    } catch { /* absent */ }
  }
  return present;
}

export function createStorageUsage(opts: {
  dataDir: string;
  chromeProfileDir: string;
  diskSpace?: DiskSpaceMonitor | null;
  thresholds: FolderImportThresholds;
  du?: DuRunner;
  now?: () => number;
  cacheMs?: number;
}): StorageUsageService {
  const du = opts.du ?? runDu;
  const now = opts.now ?? Date.now;
  const cacheMs = opts.cacheMs ?? 10 * 60_000;
  const dataDir = opts.dataDir;
  const groups: Array<{ key: Exclude<StorageCategoryKey, 'other' | 'chromeProfile'>; label: string; paths: string[] }> = [
    { key: 'database', label: 'Database', paths: ['tracker.db', 'tracker.db-wal', 'tracker.db-shm'].map(name => path.join(dataDir, name)) },
    { key: 'fileText', label: 'Stored file text', paths: [path.join(dataDir, 'content')] },
    { key: 'promptLogs', label: 'Model request logs', paths: [path.join(dataDir, 'logs', 'llm-prompts')] },
    { key: 'backups', label: 'Repair backups', paths: [path.join(dataDir, 'backups'), path.join(dataDir, 'recovery-backups')] },
  ];

  let cached: UsageCore | null = null;
  let inflight: Promise<UsageCore> | null = null;

  async function measure(): Promise<UsageCore> {
    const started = now();
    try {
      // Two du calls, each over disjoint paths (du dedups within one call).
      const roots = await existing([dataDir, opts.chromeProfileDir]);
      const totals = await du(roots);
      const subPaths = await existing(groups.flatMap(group => group.paths));
      const subSizes = await du(subPaths);
      const dataTotal = totals.get(dataDir) ?? 0;
      const categories: StorageCategory[] = groups.map(group => ({
        key: group.key,
        label: group.label,
        bytes: group.paths.reduce((sum, p) => sum + (subSizes.get(p) ?? 0), 0),
        paths: group.paths,
      }));
      const named = categories.reduce((sum, category) => sum + category.bytes, 0);
      categories.push({ key: 'other', label: 'Attachments and caches', bytes: Math.max(0, dataTotal - named), paths: [dataDir] });
      const chrome = totals.get(opts.chromeProfileDir) ?? 0;
      categories.push({ key: 'chromeProfile', label: 'Debug Chrome profile', bytes: chrome, paths: [opts.chromeProfileDir] });
      return { measuredAt: now(), durationMs: now() - started, dataDir, botboyBytes: dataTotal + chrome, categories };
    } catch (err) {
      return {
        measuredAt: now(),
        durationMs: now() - started,
        dataDir,
        botboyBytes: 0,
        categories: [],
        error: `Storage could not be measured: ${String((err as Error)?.message ?? err).slice(0, 200)}`,
      };
    }
  }

  function advice(usage: UsageCore, freeBytes: number | null) {
    const warnings: StorageUsageReport['warnings'] = [];
    const floors = { importFloorBytes: opts.thresholds.importMinFreeBytes, liveFloorBytes: opts.thresholds.liveMinFreeBytes };
    if (freeBytes != null && freeBytes < floors.liveFloorBytes) {
      warnings.push({
        level: 'live',
        message: `Free space is below ${formatGB(floors.liveFloorBytes)}. Folder imports and live folder captures are paused; BotBoy keeps watching and imports held changes when space returns.`,
      });
    } else if (freeBytes != null && freeBytes < floors.importFloorBytes) {
      warnings.push({
        level: 'import',
        message: `Free space is below ${formatGB(floors.importFloorBytes)}. Folder imports are paused; watching and live captures continue.`,
      });
    }
    const size = (key: StorageCategoryKey) => usage.categories.find(category => category.key === key)?.bytes ?? 0;
    const nextActions = ['Exclude big files, or disable a folder you do not need, in the list below.'];
    if (size('backups') > 0) {
      nextActions.push(`Delete old repair backups (${formatGB(size('backups'))}) in ${path.join(dataDir, 'backups')} and ${path.join(dataDir, 'recovery-backups')}. BotBoy does not read them at runtime.`);
    }
    if (size('promptLogs') > 0) {
      nextActions.push(`Model request logs (${formatGB(size('promptLogs'))}) are debug copies kept for 7 days in ${path.join(dataDir, 'logs', 'llm-prompts')}; deleting older files there is safe.`);
    }
    return { floors, warnings, nextActions };
  }

  return {
    async get(getOpts) {
      const stale = !cached || now() - cached.measuredAt >= cacheMs;
      if (getOpts?.refresh || stale) {
        if (!inflight) {
          inflight = measure().finally(() => { inflight = null; });
        }
        cached = await inflight;
      }
      const usage = cached as NonNullable<typeof cached>;
      const freeBytes = opts.diskSpace ? await opts.diskSpace.freeBytes(30_000) : null;
      const totalBytes = opts.diskSpace?.snapshot().totalBytes ?? null;
      return { ...usage, disk: { freeBytes, totalBytes }, ...advice(usage, freeBytes) };
    },
  };
}
