import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fc from 'fast-check';
import os from 'os';
import path from 'path';
import fs from 'fs';
import { createStorage } from './storage.js';
import {
  addLocalFolder,
  listLocalFolders,
  updateLocalFolder,
  removeLocalFolder,
} from './local-folders-config.js';

/**
 * Property test P-LF-1: Persisted folder list is the source of truth.
 *
 * For any sequence of `addLocalFolder` / `updateLocalFolder` / `removeLocalFolder`
 * calls, `listLocalFolders(db)` returns rows whose (id, path) pairs match the
 * in-memory shadow model that mirrors the DB. The model is the spec:
 *   • add succeeds iff the canonical path is not already present (else duplicate)
 *   • update of a known id mutates only metadata, never path
 *   • remove of a known id deletes exactly that row
 *
 * Validates: Requirements 1.1, 1.3
 */

// Pool of real directories under $HOME — needed because addLocalFolder
// validates existence, dir-ness, and inside-home before persisting. Created
// once in beforeAll so fast-check shrinking is deterministic across runs.
const POOL_SIZE = 8;
const pool: string[] = [];
let poolHome: string | null = null;

beforeAll(() => {
  poolHome = fs.mkdtempSync(path.join(os.homedir(), '.ppt-prop-lf-'));
  for (let i = 0; i < POOL_SIZE; i++) {
    const p = path.join(poolHome, `dir-${i}`);
    fs.mkdirSync(p);
    // Store the realpath so it matches what addLocalFolder canonicalizes to.
    pool.push(fs.realpathSync(p));
  }
});

afterAll(() => {
  if (poolHome) {
    try {
      fs.rmSync(poolHome, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup; tmpdir leaks are non-fatal in CI.
    }
  }
});

// Operation arbitraries. `targetIdx` is modulo'd against the live id-list at
// run time so the generator stays simple but still hits every existing row.
const addOpArb = fc.record({
  kind: fc.constant('add' as const),
  pathIdx: fc.integer({ min: 0, max: POOL_SIZE - 1 }),
  recursive: fc.boolean(),
  enabled: fc.boolean(),
  includeGlobs: fc.array(fc.constantFrom('*.md', '*.txt', '*.json'), { maxLength: 3 }),
  excludeGlobs: fc.array(fc.constantFrom('*.tmp', '*.log'), { maxLength: 2 }),
});

const updateOpArb = fc.record({
  kind: fc.constant('update' as const),
  targetIdx: fc.nat(),
  recursive: fc.option(fc.boolean(), { nil: undefined }),
  enabled: fc.option(fc.boolean(), { nil: undefined }),
  includeGlobs: fc.option(fc.array(fc.constantFrom('*.md', '*.txt'), { maxLength: 2 }), {
    nil: undefined,
  }),
});

const removeOpArb = fc.record({
  kind: fc.constant('remove' as const),
  targetIdx: fc.nat(),
});

const opArb = fc.oneof(
  { weight: 4, arbitrary: addOpArb },
  { weight: 3, arbitrary: updateOpArb },
  { weight: 2, arbitrary: removeOpArb },
);

describe('local-folders-config property tests', () => {
  it('P-LF-1: listLocalFolders matches the shadow model after every op (Requirements 1.1, 1.3)', () => {
    fc.assert(
      fc.property(fc.array(opArb, { minLength: 0, maxLength: 30 }), (ops) => {
        const storage = createStorage(':memory:');
        storage.initialize();
        const db = storage.getDb();

        try {
          // Shadow: db id → canonical path. Since `path` is UNIQUE in the
          // schema, the shadow's value-set is also unique at all times.
          const shadow = new Map<number, string>();

          for (const op of ops) {
            if (op.kind === 'add') {
              const p = pool[op.pathIdx];
              const result = addLocalFolder(db, {
                path: p,
                recursive: op.recursive,
                enabled: op.enabled,
                include_globs: op.includeGlobs,
                exclude_globs: op.excludeGlobs,
              });

              const pathAlreadyPresent = Array.from(shadow.values()).includes(p);
              if (pathAlreadyPresent) {
                expect(result.ok).toBe(false);
                if (!result.ok) {
                  expect(result.code).toBe('duplicate');
                }
              } else {
                expect(result.ok).toBe(true);
                if (result.ok) {
                  expect(result.folder.path).toBe(p);
                  expect(result.folder.recursive).toBe(op.recursive);
                  expect(result.folder.enabled).toBe(op.enabled);
                  shadow.set(result.folder.id, p);
                }
              }
            } else if (op.kind === 'update') {
              const ids = Array.from(shadow.keys());
              if (ids.length === 0) continue;
              const id = ids[op.targetIdx % ids.length];

              const patch: Parameters<typeof updateLocalFolder>[2] = {};
              if (op.recursive !== undefined) patch.recursive = op.recursive;
              if (op.enabled !== undefined) patch.enabled = op.enabled;
              if (op.includeGlobs !== undefined) patch.include_globs = op.includeGlobs;

              const result = updateLocalFolder(db, id, patch);
              expect(result.ok).toBe(true);
              if (result.ok) {
                // Path is immutable — patch must never relocate the row.
                expect(result.folder.path).toBe(shadow.get(id));
                expect(result.folder.id).toBe(id);
              }
            } else if (op.kind === 'remove') {
              const ids = Array.from(shadow.keys());
              if (ids.length === 0) continue;
              const id = ids[op.targetIdx % ids.length];

              const removed = removeLocalFolder(db, id);
              expect(removed).toBe(true);
              shadow.delete(id);
            }

            // Invariant after every op: list ↔ shadow agree on both ids and paths.
            const listed = listLocalFolders(db);
            const listedById = new Map(listed.map((f) => [f.id, f.path]));

            // Same set of ids.
            expect([...listedById.keys()].sort((a, b) => a - b)).toEqual(
              [...shadow.keys()].sort((a, b) => a - b),
            );
            // Same id → path mapping.
            for (const [id, p] of shadow) {
              expect(listedById.get(id)).toBe(p);
            }
            // Same multiset (here: set) of paths regardless of interleaving.
            expect(listed.map((f) => f.path).sort()).toEqual(
              [...shadow.values()].sort(),
            );
          }
        } finally {
          storage.close();
        }
      }),
      { numRuns: 100 },
    );
  });
});
