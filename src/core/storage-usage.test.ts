import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createStorageUsage, runDu } from './storage-usage.js';
import type { DiskSpaceMonitor } from './disk-space.js';

const GB = 1024 ** 3;
const thresholds = { bigFileBytes: 25 * 1024 ** 2, importMinFreeBytes: 10 * GB, liveMinFreeBytes: 2 * GB };

function fakeDisk(freeBytes: number): DiskSpaceMonitor {
  return {
    cachedFreeBytes: () => freeBytes,
    freeBytes: async () => freeBytes,
    snapshot: () => ({ freeBytes, totalBytes: 500 * GB, measuredAt: 1 }),
  };
}

/** C11: where BotBoy's space goes, the floors, and what to do about it. */
describe('storage usage', () => {
  let root: string;
  let dataDir: string;
  let chromeDir: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ppt-storage-'));
    dataDir = path.join(root, 'data');
    chromeDir = path.join(root, 'chrome');
    for (const dir of ['content', 'logs/llm-prompts', 'backups', 'files']) fs.mkdirSync(path.join(dataDir, dir), { recursive: true });
    fs.mkdirSync(chromeDir);
    fs.writeFileSync(path.join(dataDir, 'tracker.db'), Buffer.alloc(64 * 1024, 1));
    fs.writeFileSync(path.join(dataDir, 'content', 'a.txt'), Buffer.alloc(128 * 1024, 2));
    fs.writeFileSync(path.join(dataDir, 'logs', 'llm-prompts', 'p.json'), Buffer.alloc(32 * 1024, 3));
    fs.writeFileSync(path.join(dataDir, 'backups', 'old.db'), Buffer.alloc(256 * 1024, 4));
    fs.writeFileSync(path.join(dataDir, 'files', 'report.csv'), Buffer.alloc(16 * 1024, 5));
    fs.writeFileSync(path.join(chromeDir, 'Cookies'), Buffer.alloc(48 * 1024, 6));
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('splits real du totals into categories that add up and match du', async () => {
    const usage = createStorageUsage({ dataDir, chromeProfileDir: chromeDir, diskSpace: fakeDisk(50 * GB), thresholds });
    const report = await usage.get();
    const bytes = Object.fromEntries(report.categories.map(category => [category.key, category.bytes]));
    const duKb = (target: string) => Number(execFileSync('/usr/bin/du', ['-sk', target]).toString().split('\t')[0]);
    expect(bytes.fileText).toBe(duKb(path.join(dataDir, 'content')) * 1024);
    expect(bytes.backups).toBe(duKb(path.join(dataDir, 'backups')) * 1024);
    expect(bytes.chromeProfile).toBe(duKb(chromeDir) * 1024);
    const dataTotal = duKb(dataDir) * 1024;
    const sum = report.categories.filter(category => category.key !== 'chromeProfile').reduce((total, category) => total + category.bytes, 0);
    expect(sum).toBe(dataTotal);
    expect(report.botboyBytes).toBe(dataTotal + bytes.chromeProfile);
    expect(report.warnings).toEqual([]);
    expect(report.nextActions.some(action => action.includes('repair backups'))).toBe(true);
    expect(report.nextActions.some(action => action.includes('Model request logs'))).toBe(true);
  });

  it('caches for ten minutes, refreshes on demand, and shares one measurement', async () => {
    let now = 0;
    const du = vi.fn(async (paths: string[]) => new Map(paths.map(p => [p, 1024])));
    const usage = createStorageUsage({ dataDir, chromeProfileDir: chromeDir, thresholds, du, now: () => now });
    await Promise.all([usage.get(), usage.get()]);
    expect(du).toHaveBeenCalledTimes(2); // one measurement = two disjoint du calls
    now = 9 * 60_000;
    await usage.get();
    expect(du).toHaveBeenCalledTimes(2);
    await usage.get({ refresh: true });
    expect(du).toHaveBeenCalledTimes(4);
    now = 30 * 60_000;
    await usage.get();
    expect(du).toHaveBeenCalledTimes(6);
  });

  it('warns at the import and live floors with the paused behavior named', async () => {
    const du = async (paths: string[]) => new Map(paths.map(p => [p, 0]));
    const importLow = await createStorageUsage({ dataDir, chromeProfileDir: chromeDir, thresholds, du, diskSpace: fakeDisk(5 * GB) }).get();
    expect(importLow.warnings).toEqual([{ level: 'import', message: expect.stringContaining('Folder imports are paused; watching and live captures continue') }]);
    const liveLow = await createStorageUsage({ dataDir, chromeProfileDir: chromeDir, thresholds, du, diskSpace: fakeDisk(1 * GB) }).get();
    expect(liveLow.warnings).toEqual([{ level: 'live', message: expect.stringContaining('live folder captures are paused') }]);
    expect(liveLow.disk.freeBytes).toBe(1 * GB);
  });

  it('reports a measurement failure instead of throwing', async () => {
    const usage = createStorageUsage({ dataDir, chromeProfileDir: chromeDir, thresholds, du: async () => { throw new Error('du missing'); } });
    const report = await usage.get();
    expect(report.error).toContain('du missing');
    expect(report.categories).toEqual([]);
  });

  it('runDu reports what it measured for disjoint paths', async () => {
    const sizes = await runDu([path.join(dataDir, 'content'), chromeDir]);
    expect(sizes.get(path.join(dataDir, 'content'))).toBeGreaterThan(0);
    expect(sizes.get(chromeDir)).toBeGreaterThan(0);
  });
});
