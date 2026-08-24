/**
 * Property test for `FilesystemMonitor.setWatchedFolders` — task 9.9.
 *
 * P-LF-3: Diff closes exactly the symmetric difference of paths.
 *
 * Validates: Requirement 2.7
 *
 * The diff's contract has three pieces, exercised together below over
 * randomised `(beforePaths, afterPaths)` pairs drawn from a small pool so
 * fast-check generates non-trivial overlap (full replacement, full
 * preservation, partial overlap, empty-on-either-side):
 *
 *   1. Close-call set equals `before \ after` — every removed path is
 *      closed exactly once and no other watcher is closed.
 *   2. Open-call set equals `after \ before` — `chokidar.watch` is invoked
 *      exactly for the newly-added paths, never for unchanged paths.
 *   3. Unchanged paths share their chokidar instance across the call —
 *      `Object.is` of the pre-diff watcher and the post-diff watcher
 *      returns true, proving no flicker / no replay.
 *
 * chokidar is mocked using the same `vi.hoisted` + `vi.mock` pattern as
 * `filesystem-monitor.test.ts`. Each `chokidar.watch(path, opts)` call
 * returns a fresh fake watcher whose `close()` is a `vi.fn` so per-path
 * close counts are observable; the mock additionally records every
 * `watch()` call in order so `after \ before` can be derived from the
 * second-call slice of the call log.
 *
 * Folder rows are constructed in-memory via `makeRow` rather than via
 * `addLocalFolder` because the on-disk existence guard would force every
 * generated path to physically exist — this test is about the watcher
 * map's diff algorithm, not about row persistence, so synthetic paths
 * under a fixed prefix are sufficient and keep the property test fast.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as fc from 'fast-check';
import { createStorage, type StorageLayer } from '../core/storage.js';
import type { DocumentParser, ParseResult } from '../core/document-parser.js';
import type { LocalFolder } from '../core/local-folders-config.js';

// ─── Fake watch engine ──────────────────────────────────────────────────────
//
// Mirrors the seam in `filesystem-monitor.test.ts`. Each engine attach
// allocates a fresh fake handle and records both the path-keyed instance and
// an ordered attach log, so the diff property can:
//
//   - look up a handle object by path (for the unchanged-identity check),
//   - count `close()` invocations per handle (for the close-set check),
//   - derive the "newly opened" set as the slice of attach-log entries that
//     came in AFTER the seed call (for the open-set check).
import {
  createFilesystemMonitor,
  type WatchEngine,
  type CookedWatchEvents,
} from './filesystem-monitor.js';

const engineMocks = (() => {
  const enginesByPath = new Map<string, any>();
  const attachCalls: Array<{ path: string }> = [];
  const closedPaths: string[] = [];

  const engine: WatchEngine & ReturnType<typeof vi.fn> = vi.fn((row: LocalFolder, _events: CookedWatchEvents) => {
    const handle: any = {
      path: row.path,
      close: vi.fn(() => {
        closedPaths.push(row.path);
        return Promise.resolve();
      }),
    };
    enginesByPath.set(row.path, handle);
    attachCalls.push({ path: row.path });
    return handle;
  }) as any;

  function reset() {
    enginesByPath.clear();
    attachCalls.length = 0;
    closedPaths.length = 0;
    engine.mockClear();
  }

  return { engine, enginesByPath, attachCalls, closedPaths, reset };
})();

// ─── Test helpers ──────────────────────────────────────────────────────────

/**
 * Minimal stub document parser. The diff property never invokes the
 * add/change handlers (we never fire chokidar events from the mock here),
 * so a no-op parser with a placeholder supported-format set is enough.
 */
function createStubDocumentParser(): DocumentParser {
  return {
    parse(): ParseResult {
      return { success: true, text: '', filePath: '', fileType: '' };
    },
    getSupportedFormats(): string[] {
      return ['.md', '.txt'];
    },
  };
}

/**
 * Build a synthetic LocalFolder row. Paths are NOT realpath-canonical here
 * because the diff algorithm only compares string equality on `path`; on-disk
 * existence is irrelevant once chokidar is mocked out.
 */
function makeRow(p: string, id: number): LocalFolder {
  return {
    id,
    path: p,
    recursive: true,
    include_globs: [],
    exclude_globs: [],
    enabled: true,
    created_at: 0,
    updated_at: 0,
  };
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('FilesystemMonitor — setWatchedFolders diff (property)', () => {
  let storage: StorageLayer;

  beforeEach(() => {
    engineMocks.reset();
    storage = createStorage(':memory:');
    storage.initialize();
  });

  // P-LF-3
  // Validates: Requirement 2.7
  it('closes exactly before \\ after, opens exactly after \\ before, keeps unchanged path watchers identical', async () => {
    // A small pool of distinct paths is enough to drive every interesting
    // overlap shape (full replacement, full preservation, mixed, empty
    // on either side). Eight entries gives the generator enough room to
    // pick non-trivial subsets without exploding shrink time.
    const PATH_POOL = Array.from({ length: 8 }, (_, i) => `/tmp/pbt-fsmon-${i}`);
    const pathsArb = fc.uniqueArray(fc.constantFrom(...PATH_POOL), {
      minLength: 0,
      maxLength: PATH_POOL.length,
    });

    await fc.assert(
      fc.asyncProperty(pathsArb, pathsArb, async (beforePaths, afterPaths) => {
        // Fresh mock state per iteration so closed/open counts and the
        // watchersByPath map don't leak between fast-check runs.
        engineMocks.reset();

        const monitor = createFilesystemMonitor({
          db: storage.getDb(),
          documentParser: createStubDocumentParser(),
          watchEngine: engineMocks.engine,
        });

        // ── 1. Seed: install watchers for `beforePaths`. ─────────────────
        await monitor.setWatchedFolders(
          beforePaths.map((p, i) => makeRow(p, i + 1)),
        );

        // Snapshot the watcher object attached to each path BEFORE the
        // diff. We use this to (a) verify identity preservation for
        // unchanged paths and (b) assert per-path close counts.
        const watchersBefore = new Map<string, any>();
        for (const p of beforePaths) {
          watchersBefore.set(p, engineMocks.enginesByPath.get(p));
        }

        // The position in the call log right after the seed — anything
        // appended after this point is from the diff call.
        const watchCallsBeforeDiff = engineMocks.attachCalls.length;

        // Clear close trackers so the post-diff close set is clean. The
        // seed call does not close anything, but reset to be safe.
        engineMocks.closedPaths.length = 0;
        for (const w of watchersBefore.values()) {
          if (w && w.close && typeof (w.close as any).mockClear === 'function') {
            (w.close as any).mockClear();
          }
        }

        // ── 2. Apply the diff. ───────────────────────────────────────────
        await monitor.setWatchedFolders(
          afterPaths.map((p, i) => makeRow(p, i + 1)),
        );

        // ── 3. Compute the expected sets in plain JS. ────────────────────
        const beforeSet = new Set(beforePaths);
        const afterSet = new Set(afterPaths);
        const expectedClosed = beforePaths.filter((p) => !afterSet.has(p));
        const expectedOpened = afterPaths.filter((p) => !beforeSet.has(p));
        const expectedUnchanged = beforePaths.filter((p) => afterSet.has(p));

        // ── 4. Close-call set equals before \ after. ─────────────────────
        // Set equality on the recorded close paths.
        expect(new Set(engineMocks.closedPaths)).toEqual(
          new Set(expectedClosed),
        );
        // Strengthen with a per-path call count: every removed watcher
        // closed exactly once; no other watcher closed at all.
        for (const p of expectedClosed) {
          const watcher = watchersBefore.get(p);
          expect(watcher.close).toHaveBeenCalledTimes(1);
        }
        for (const p of expectedUnchanged) {
          const watcher = watchersBefore.get(p);
          expect(watcher.close).not.toHaveBeenCalled();
        }

        // ── 5. Open-call set equals after \ before. ──────────────────────
        // The chokidar.watch calls recorded after the seed must be
        // exactly the new paths — same multiset (no duplicate opens) and
        // same set (no missed opens, no spurious opens for unchanged).
        const diffWatchPaths = engineMocks.attachCalls
          .slice(watchCallsBeforeDiff)
          .map((c) => c.path);
        expect(new Set(diffWatchPaths)).toEqual(new Set(expectedOpened));
        expect(diffWatchPaths.length).toBe(expectedOpened.length);

        // ── 6. Unchanged paths keep the same chokidar instance. ──────────
        // `Object.is` is the strict identity check called for in the spec
        // — proves the watcher was never closed-and-reopened across the
        // diff.
        for (const p of expectedUnchanged) {
          const watcherAfter = engineMocks.enginesByPath.get(p);
          const watcherBeforeRef = watchersBefore.get(p);
          expect(Object.is(watcherAfter, watcherBeforeRef)).toBe(true);
        }
      }),
      { numRuns: 100 },
    );
  });
});
