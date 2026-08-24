/**
 * Integration tests for `createNativeWatchEngine` — the fs.watch-backed
 * engine behind the filesystem monitor (folder-watch-scaling spec, phase 1).
 *
 * These run against the REAL filesystem and real FSEvents delivery (macOS),
 * with shrunk settle/burst thresholds so each case completes in well under a
 * second of wall time. Generous polling windows absorb FSEvents latency.
 *
 * Validates: folder-watch-scaling R1 (single handle per tree — implicitly,
 * the engine opens exactly one fs.watch), R2 (segment ignores + row exclude
 * globs on raw events), R3 (burst pause is per-folder and logs once), R4
 * (write settle; vanished paths dispatch unlink).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs';
import {
  createNativeWatchEngine,
  type WatchHandle,
  type CookedWatchEvents,
} from './filesystem-monitor.js';
import type { LocalFolder } from '../core/local-folders-config.js';

const SETTLE_MS = 40;

function makeRow(p: string, overrides?: Partial<LocalFolder>): LocalFolder {
  return {
    id: 1,
    path: p,
    recursive: true,
    include_globs: [],
    exclude_globs: [],
    enabled: true,
    created_at: Date.now(),
    updated_at: Date.now(),
    ...overrides,
  };
}

/** Poll until `cond()` is true or `timeoutMs` elapses. */
async function waitFor(cond: () => boolean, timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return cond();
}

/** Fixed settle wait: long enough for FSEvents delivery + settle + dispatch. */
function grace(ms = 800): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe('createNativeWatchEngine (real fs.watch)', () => {
  let dir: string;
  let handle: WatchHandle | null = null;
  let added: string[];
  let unlinked: string[];
  let errors: Error[];
  let events: CookedWatchEvents;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.homedir(), '.ppt-test-engine-'));
    added = [];
    unlinked = [];
    errors = [];
    events = {
      onAddOrChange: (p) => added.push(p),
      onUnlink: (p) => unlinked.push(p),
      onError: (e) => errors.push(e),
    };
  });

  afterEach(async () => {
    handle?.close();
    handle = null;
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    // Let any in-flight FSEvents drain before the next test's watcher opens.
    await grace(100);
  });

  it('dispatches a cooked add after a write settles', async () => {
    handle = createNativeWatchEngine(makeRow(dir), events, { settleMs: SETTLE_MS });
    await grace(150); // watcher warm-up

    const filePath = path.join(dir, 'note.md');
    fs.writeFileSync(filePath, 'hello', 'utf-8');

    const ok = await waitFor(() => added.includes(filePath));
    expect(ok).toBe(true);
    expect(errors).toHaveLength(0);
  });

  it('drops raw events for ignored segments and honors row exclude_globs', async () => {
    handle = createNativeWatchEngine(
      makeRow(dir, { exclude_globs: ['*.bak'] }),
      events,
      { settleMs: SETTLE_MS },
    );
    await grace(150);

    fs.mkdirSync(path.join(dir, 'node_modules'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'node_modules', 'dep.md'), 'x', 'utf-8');
    fs.writeFileSync(path.join(dir, '.DS_Store'), 'x', 'utf-8');
    fs.writeFileSync(path.join(dir, 'old.bak'), 'x', 'utf-8');
    const keptPath = path.join(dir, 'kept.md');
    fs.writeFileSync(keptPath, 'keep me', 'utf-8');

    // The kept file arriving proves the event pipeline ran end-to-end; the
    // filtered paths must not have arrived by then (plus a settle of grace).
    const ok = await waitFor(() => added.includes(keptPath));
    expect(ok).toBe(true);
    await grace(300);
    expect(added).toEqual([keptPath]);
  });

  it('dispatches unlink when a previously-settled file is deleted', async () => {
    handle = createNativeWatchEngine(makeRow(dir), events, { settleMs: SETTLE_MS });
    await grace(150);

    const filePath = path.join(dir, 'doomed.md');
    fs.writeFileSync(filePath, 'bye', 'utf-8');
    expect(await waitFor(() => added.includes(filePath))).toBe(true);

    fs.rmSync(filePath);
    expect(await waitFor(() => unlinked.includes(filePath))).toBe(true);
  });

  it('pauses the folder after an event burst, logs exactly once, and keeps the process alive', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      handle = createNativeWatchEngine(makeRow(dir), events, {
        settleMs: SETTLE_MS,
        burstMaxEvents: 5,
        burstWindowMs: 60_000,
        burstPauseMs: 60_000,
      });
      await grace(150);

      for (let i = 0; i < 30; i++) {
        fs.writeFileSync(path.join(dir, `flood-${i}.md`), String(i), 'utf-8');
      }

      const paused = await waitFor(() =>
        errorSpy.mock.calls.some((c) => String(c[0]).includes('pausing ingestion')),
      );
      expect(paused).toBe(true);

      await grace(400);
      // Pause log fired exactly once despite ~30 raw events past the limit.
      const pauseLogs = errorSpy.mock.calls.filter((c) => String(c[0]).includes('pausing ingestion'));
      expect(pauseLogs).toHaveLength(1);
      // Dispatches are bounded by the burst limit — the flood never reached
      // the cooked layer wholesale.
      expect(added.length).toBeLessThanOrEqual(5);
    } finally {
      errorSpy.mockRestore();
    }
  });
});
