/**
 * Property tests for `FilesystemMonitor`.
 *
 * P-LF-2: Filter applies uniformly across all input combinations.
 *   For any randomly-generated tuple
 *     (filePath, size, ext, includeGlobs, excludeGlobs, content)
 *   `handleAddOrChange` emits a RawWorkItem iff:
 *     size       ≤ MAX_FILE_BYTES
 *     AND ext    ∈ documentParser.getSupportedFormats()
 *     AND matches(includeGlobs)            (empty list ⇒ match-all)
 *     AND ¬matches(excludeGlobs)           — see note below
 *     AND contentHash ≠ seenHashes[filePath]   (Requirement 2.5 dedup)
 *
 *   Note on exclude_globs (Requirement 8.4): the implementation does NOT
 *   enforce `exclude_globs` inside `handleAddOrChange`. The watch engine
 *   applies them to RAW events BEFORE cooked dispatch. These tests inject a
 *   fake engine and fire cooked events directly (so add/change is
 *   synchronous, per the same pattern as `filesystem-monitor.test.ts`),
 *   which means `exclude_globs` is a no-op at the cooked level here. The
 *   arbitrary still generates exclude_globs so the LocalFolder row matches
 *   a real one shape-wise; the predicate simply omits the exclude leg
 *   because the seam makes it tautologically true.
 *
 * Validates: Requirements 2.3, 2.4, 2.5, 8.2, 8.3, 8.4
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs';
import * as fc from 'fast-check';
import { createStorage, type StorageLayer } from '../core/storage.js';
import type { LocalFolder } from '../core/local-folders-config.js';
import type { DocumentParser, ParseResult } from '../core/document-parser.js';
import type { RawWorkItem } from '../core/types.js';

// ─── Hoisted: env-var setup BEFORE filesystem-monitor module is loaded ─────
//
// `MAX_FILE_BYTES` is captured at module-load time inside
// filesystem-monitor.ts. Shrink it to 500 here so size-cap iterations are
// cheap (a few hundred bytes vs. 5 MB). Mirrors filesystem-monitor.test.ts.
vi.hoisted(() => {
  process.env.LOCAL_FOLDERS_MAX_FILE_BYTES = '500';
});

const MAX_FILE_BYTES = 500;
const SUPPORTED_EXTS = ['.md', '.txt'] as const;

// ─── Fake watch engine ──────────────────────────────────────────────────────
//
// Same seam as filesystem-monitor.test.ts: the monitor's injectable
// `watchEngine` records cooked-event callbacks per folder path so the
// property body can fire add events synchronously.
import {
  createFilesystemMonitor,
  type WatchEngine,
  type CookedWatchEvents,
} from './filesystem-monitor.js';

const engineMocks = (() => {
  const enginesByPath = new Map<string, { events: CookedWatchEvents }>();

  const engine: WatchEngine = (row, events) => {
    enginesByPath.set(row.path, { events });
    return { close: vi.fn(() => Promise.resolve()) };
  };

  function reset() {
    enginesByPath.clear();
  }

  return { engine, enginesByPath, reset };
})();

// ─── Test helpers ──────────────────────────────────────────────────────────

/**
 * Stub DocumentParser whose default behavior reads the on-disk file as UTF-8
 * (so content-hash dedup tests work against real bytes) and whose supported
 * formats are limited to plain-text variants. Keeping `parse` real lets the
 * property assert end-to-end behavior — we don't shortcut the parser path.
 */
function createStubDocumentParser(
  supported: readonly string[] = SUPPORTED_EXTS,
): DocumentParser {
  return {
    parse(filePath: string): ParseResult {
      const fileType = path.extname(filePath).toLowerCase();
      try {
        const text = fs.readFileSync(filePath, 'utf-8');
        return { success: true, text, filePath, fileType };
      } catch (err: any) {
        return {
          success: false,
          error: err?.message ?? 'read failed',
          filePath,
          fileType,
        };
      }
    },
    getSupportedFormats(): string[] {
      return [...supported];
    },
  };
}

/**
 * Build an in-memory LocalFolder row. We don't go through `addLocalFolder`
 * here because the DB round-trip is irrelevant to this property — we want
 * direct, deterministic control over the row that the monitor's filter
 * chain reads from.
 */
function makeRow(input: {
  id: number;
  path: string;
  include_globs?: string[];
  exclude_globs?: string[];
}): LocalFolder {
  return {
    id: input.id,
    path: input.path,
    recursive: true,
    include_globs: input.include_globs ?? [],
    exclude_globs: input.exclude_globs ?? [],
    enabled: true,
    created_at: Date.now(),
    updated_at: Date.now(),
  };
}

/**
 * Predicate that mirrors the SUT's `matchesAnyGlob` for the restricted
 * generator alphabet we use. Generators only emit basename-style patterns
 * (no `/`), which `compileGlob` evaluates against `path.basename(filePath)`.
 *
 * Supported pattern shapes here:
 *   - `*`            — matches any basename
 *   - `*.<ext>`      — matches basenames ending with that extension
 *   - bare literal   — matches an exact basename
 *
 * Empty list ⇒ match-all (handler short-circuits before invoking glob match).
 */
function predictIncludeGlobMatch(
  filePath: string,
  globs: readonly string[],
): boolean {
  if (globs.length === 0) return true;
  const base = path.basename(filePath);
  return globs.some((g) => {
    if (g === '*') return true;
    const m = /^\*(\.[a-z0-9]+)$/i.exec(g);
    if (m) return base.toLowerCase().endsWith(m[1].toLowerCase());
    return base === g;
  });
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('FilesystemMonitor — property tests', () => {
  let storage: StorageLayer;
  let homeBase: string;

  beforeEach(() => {
    engineMocks.reset();
    storage = createStorage(':memory:');
    storage.initialize();
    // Tmpdir under $HOME so `addLocalFolder` would accept it (we don't use
    // addLocalFolder here, but keeping the convention parallel to the
    // existing unit test makes the env consistent).
    homeBase = fs.mkdtempSync(path.join(os.homedir(), '.ppt-pbt-fsmon-'));
  });

  afterEach(() => {
    storage.close();
    try {
      fs.rmSync(homeBase, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  // P-LF-2 — see file header for the predicate statement.
  // Validates: Requirements 2.3, 2.4, 2.5, 8.2, 8.3, 8.4
  it('handleAddOrChange emit decision matches the size/extension/include_globs/dedup predicate', async () => {
    // ── Arbitraries ──
    //
    // `extArb`: a mix of supported (`.md`, `.txt`) and unsupported
    // (`.xyz`, `.bin`, `.js`) extensions so the extension-filter leg is
    // exercised in both directions.
    // Mix of supported (.md/.txt) and unsupported-but-still-ingested (.xyz/.log/
    // .js) extensions. Deliberately excludes SKIP_EXTENSIONS (video/binary/etc.)
    // which are dropped by a separate, unconditional rule.
    const extArb = fc.constantFrom<string>('.md', '.txt', '.xyz', '.log', '.js');

    // `contentArb`: 0–700 bytes so we straddle MAX_FILE_BYTES (500). We use
    // ASCII-only graphemes so `Buffer.byteLength(content, 'utf-8')` equals
    // `content.length`, matching what `statSync(filePath).size` will report
    // after the file is written.
    const contentArb = fc.string({
      minLength: 0,
      maxLength: 700,
      unit: 'grapheme-ascii',
    });

    // `baseNameArb`: short alphanumeric-ish basenames so generated paths
    // don't trip OS-level filename rules. Filtered to be non-empty.
    const baseNameArb = fc
      .string({ minLength: 1, maxLength: 8, unit: 'grapheme-ascii' })
      .map((s) => s.replace(/[^a-zA-Z0-9_]/g, ''))
      .filter((s) => s.length > 0);

    // Glob alphabet restricted to basename-style patterns so
    // `predictIncludeGlobMatch` can mirror the SUT exactly.
    const globArb = fc.constantFrom<string>('*.md', '*.txt', '*.xyz', '*');
    const includeGlobsArb = fc.array(globArb, { minLength: 0, maxLength: 3 });
    const excludeGlobsArb = fc.array(globArb, { minLength: 0, maxLength: 3 });

    let iter = 0;

    await fc.assert(
      fc.asyncProperty(
        baseNameArb,
        extArb,
        contentArb,
        includeGlobsArb,
        excludeGlobsArb,
        async (baseName, ext, content, includeGlobs, excludeGlobs) => {
          // Each iteration uses a fresh sub-folder so paths never collide
          // across runs and the monitor's `seenHashes` for this filePath
          // starts empty (we get a clean dedup window per iteration).
          iter++;
          const folderPath = fs.mkdtempSync(path.join(homeBase, `f${iter}-`));

          try {
            const fileName = baseName + ext;
            const filePath = path.join(folderPath, fileName);
            fs.writeFileSync(filePath, content, 'utf-8');

            const row = makeRow({
              id: iter,
              path: folderPath,
              include_globs: includeGlobs,
              exclude_globs: excludeGlobs,
            });

            const monitor = createFilesystemMonitor({
              db: storage.getDb(),
              documentParser: createStubDocumentParser(SUPPORTED_EXTS),
              watchEngine: engineMocks.engine,
            });
            const emitted: RawWorkItem[] = [];
            monitor.onWorkItem((i) => emitted.push(i));

            // Wire the watcher; the fake engine registers cooked callbacks
            // at `folderPath` for synchronous firing.
            await monitor.setWatchedFolders([row]);
            const attached = engineMocks.enginesByPath.get(folderPath);
            if (!attached) throw new Error('engine not attached for ' + folderPath);
            const addHandler = (p: string) => attached.events.onAddOrChange(p);

            // ── Predicate ──
            // R12.5 supersede: extension no longer gates emission. Supported
            // types emit their parsed content; unsupported types emit a raw
            // item (empty content) for the extractor. So the emit decision is
            // now size + include-glob + change-dedup only.
            const size = Buffer.byteLength(content, 'utf-8');
            const sizeOk = size <= MAX_FILE_BYTES;
            const includeOk = predictIncludeGlobMatch(filePath, includeGlobs);
            const shouldEmitFirst = sizeOk && includeOk;

            // ── Fire #1: a fresh path with no prior seenHash. ──
            addHandler(filePath);
            expect(emitted.length).toBe(shouldEmitFirst ? 1 : 0);

            // ── Fire #2 with identical content. The §2.5 content-hash
            // dedup MUST suppress this emit even when the first was
            // allowed (contentHash === seenHashes[filePath]). ──
            addHandler(filePath);
            expect(emitted.length).toBe(shouldEmitFirst ? 1 : 0);

            // ── Fire #3 with mutated content. A different hash beats the
            // dedup, so we get another emit iff the size/ext/include legs
            // still permit it. (`extOk` and `includeOk` don't change
            // because the basename is unchanged; only `sizeOk` may flip
            // depending on the new content size.) ──
            const appended = '\nappended-' + iter;
            const newContent = content + appended;
            fs.writeFileSync(filePath, newContent, 'utf-8');
            const newSize = Buffer.byteLength(newContent, 'utf-8');
            const newSizeOk = newSize <= MAX_FILE_BYTES;
            const shouldEmitThird = newSizeOk && includeOk;

            addHandler(filePath);
            const expectedTotal =
              (shouldEmitFirst ? 1 : 0) + (shouldEmitThird ? 1 : 0);
            expect(emitted.length).toBe(expectedTotal);

            // ── Per-iteration cleanup ──
            // Stop the monitor (closes the fake handle and clears its
            // internal state) and drop the engine registry entry so the
            // next iteration starts clean.
            await monitor.stop();
            engineMocks.enginesByPath.delete(folderPath);
          } finally {
            try {
              fs.rmSync(folderPath, { recursive: true, force: true });
            } catch {
              /* ignore */
            }
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
