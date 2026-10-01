import { describe, expect, it, vi } from 'vitest';
import { createDiskSpaceMonitor } from './disk-space.js';

/** Free-space probe for the disk floors: cached, async, fail-open. */
describe('disk space monitor', () => {
  it('caches measurements and refreshes stale cached reads in the background', async () => {
    let now = 0;
    let free = 100;
    const statfs = vi.fn(async () => ({ bavail: free, bsize: 4096, blocks: 1000 }));
    const disk = createDiskSpaceMonitor({ path: '/', statfs, now: () => now, staleMs: 30_000 });

    expect(disk.cachedFreeBytes()).toBeNull(); // first call schedules a measurement
    await vi.waitFor(() => expect(disk.snapshot().freeBytes).toBe(100 * 4096));
    expect(disk.snapshot().totalBytes).toBe(1000 * 4096);

    free = 50;
    now = 1_000;
    expect(await disk.freeBytes(5_000)).toBe(100 * 4096); // fresh enough
    expect(statfs).toHaveBeenCalledTimes(1);
    now = 10_000;
    expect(await disk.freeBytes(5_000)).toBe(50 * 4096);
    expect(statfs).toHaveBeenCalledTimes(2);

    now = 50_000;
    expect(disk.cachedFreeBytes()).toBe(50 * 4096); // stale: returns cached, refreshes
    await vi.waitFor(() => expect(statfs).toHaveBeenCalledTimes(3));
  });

  it('reports null (no floor) with one warning when statfs fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const disk = createDiskSpaceMonitor({ path: '/nope', statfs: async () => { throw new Error('ENOSYS'); } });
    expect(await disk.freeBytes(0)).toBeNull();
    expect(await disk.freeBytes(0)).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('measures the real volume', async () => {
    const disk = createDiskSpaceMonitor({ path: process.cwd() });
    const free = await disk.freeBytes(0);
    expect(typeof free).toBe('number');
    expect(free!).toBeGreaterThan(0);
  });
});
