/**
 * Lesson projections on an install that has NOT moved its analytics knowledge into the library (P1 review N1,
 * knowledge-library.md K10): creating the folder, a rescan, the boot scan and the test-override's first use must leave the
 * legacy `lessons/` folder byte-identical. A repair there would rewrite a file an R6.2a receipt may pin, and removing a
 * projection with no adopted lesson would delete a file the owner made by hand. Library mode still repairs
 * (`lessons-ledger.library.test.ts`). Synthetic scopes only.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerCaptureExcludedRoots } from './capture-exclusions.js';
import { ANALYTICS_CONTEXT_DIR_KEY } from './analytics-context.js';
import { createKnowledgeLibrary, type KnowledgeLibrary } from './knowledge-library.js';
import { KNOWLEDGE_ROOT_ENV, canonicalRootOrNull, emptyKnowledgeState, knowledgeExcludedRoots, readKnowledgeState, writeKnowledgeState } from './knowledge-root.js';
import { adoptLesson, proposeLesson, renderAllLessonScopes } from './lessons-ledger.js';
import { registerWriteProtectedRoots } from './protected-local-resources.js';
import { createStorage, setSetting, type StorageLayer } from './storage.js';

let storage: StorageLayer;
let base: string;
let legacy: string;
let root: string;
let library: KnowledgeLibrary;
const db = () => storage.getDb();

function propose(scope: string, rule: string): string {
  const result = proposeLesson(db(), { scope, rule, evidence: 'observed in a synthetic run', provenance: 'test' });
  if (!result.ok) throw new Error(result.error);
  return result.lesson.id;
}

/** The legacy folder as an install has it: an adopted lesson re-proposed once (so its on-disk text is one bump behind the
 * ledger), a hand-made projection for a scope with only a proposed lesson, and a manifest. */
function seedLegacy() {
  const id = propose('shopwave', 'Always name the filter regime beside a number.');
  adoptLesson(db(), id);
  const again = proposeLesson(db(), { scope: 'shopwave', rule: 'Always name the filter regime beside a number.', evidence: 'seen again', provenance: 'test' });
  expect(again.ok && again.kind).toBe('recurrence');
  propose('streamly', 'Only a proposal, never adopted.');
  fs.writeFileSync(path.join(legacy, 'lessons', 'streamly.md'), '# my own notes on streamly\n');
  return {
    shop: path.join(legacy, 'lessons', 'shopwave.md'),
    own: path.join(legacy, 'lessons', 'streamly.md'),
    manifest: path.join(legacy, 'manifest.json'),
  };
}

beforeEach(() => {
  storage = createStorage(':memory:');
  storage.initialize();
  base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'kl-legacy-')));
  vi.stubEnv('HOME', path.join(base, 'home'));
  fs.mkdirSync(path.join(base, 'home'), { recursive: true });
  legacy = path.join(base, 'legacy');
  root = path.join(base, 'BotBoy Knowledge');
  fs.mkdirSync(path.join(legacy, 'lessons'), { recursive: true });
  setSetting(db(), ANALYTICS_CONTEXT_DIR_KEY, legacy);
  registerWriteProtectedRoots(() => canonicalRootOrNull(db()));
  registerCaptureExcludedRoots(() => knowledgeExcludedRoots(db()));
  library = createKnowledgeLibrary({ db: db() });
});
afterEach(() => {
  registerWriteProtectedRoots(null);
  registerCaptureExcludedRoots(null);
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  storage.close();
  fs.rmSync(base, { recursive: true, force: true });
});

describe('legacy mode: nothing repairs, rewrites or removes a legacy lessons file', () => {
  it('renderAllLessonScopes does nothing and reports nothing held', () => {
    const files = seedLegacy();
    fs.writeFileSync(files.shop, '# stale on purpose\n');
    const before = { shop: fs.readFileSync(files.shop, 'utf8'), own: fs.readFileSync(files.own, 'utf8'), manifest: fs.readFileSync(files.manifest, 'utf8') };
    expect(renderAllLessonScopes(db())).toEqual({ rendered: [], unchanged: [], held: false });
    expect(fs.readFileSync(files.shop, 'utf8')).toBe(before.shop);
    expect(fs.readFileSync(files.own, 'utf8')).toBe(before.own);
    expect(fs.readFileSync(files.manifest, 'utf8')).toBe(before.manifest);
  });

  it('Create folder, Rescan and the boot scan leave the re-proposed lesson and the hand-made file byte-identical and present', async () => {
    const files = seedLegacy();
    const before = { shop: fs.readFileSync(files.shop), own: fs.readFileSync(files.own), manifest: fs.readFileSync(files.manifest) };
    // The ledger now says "seen ×2" while the file does not: library mode would rewrite it, legacy mode must not.
    expect(before.shop.toString()).not.toContain('seen ×2');

    const created = await library.activate(root);
    expect(created.ok).toBe(true);
    expect(readKnowledgeState(db()).analyticsDir).toBe('legacy');
    await library.rescan();
    await library.rescan();

    expect(fs.readFileSync(files.shop).equals(before.shop)).toBe(true);
    expect(fs.existsSync(files.own)).toBe(true);
    expect(fs.readFileSync(files.own).equals(before.own)).toBe(true);
    expect(fs.readFileSync(files.manifest).equals(before.manifest)).toBe(true);
    // Nothing was added to the new folder's analytics area either: the move is the owner's explicit step.
    expect(fs.existsSync(path.join(root, 'analytics', 'lessons'))).toBe(false);
  });

  it('the test override\'s first use (an environment root counts as activated) leaves the legacy folder alone', async () => {
    const files = seedLegacy();
    const before = { shop: fs.readFileSync(files.shop), own: fs.readFileSync(files.own) };
    vi.stubEnv(KNOWLEDGE_ROOT_ENV, root);
    const status = await library.status();
    expect(status.state).toBe('ready');
    await library.listSets();
    expect(fs.readFileSync(files.shop).equals(before.shop)).toBe(true);
    expect(fs.readFileSync(files.own).equals(before.own)).toBe(true);
  });

  it('after Move (library mode) the same call repairs a stale projection: the gate is the mode, not the folder', () => {
    seedLegacy();
    // What Move does in one transaction: library mode on, the explicit legacy folder setting cleared.
    writeKnowledgeState(db(), { ...emptyKnowledgeState(), root, analyticsDir: 'library' });
    setSetting(db(), ANALYTICS_CONTEXT_DIR_KEY, null);
    fs.mkdirSync(path.join(root, 'analytics', 'lessons'), { recursive: true });
    const result = renderAllLessonScopes(db());
    expect(result.rendered).toEqual(['shopwave']);
    expect(fs.readFileSync(path.join(root, 'analytics', 'lessons', 'shopwave.md'), 'utf8')).toContain('seen ×2');
  });
});
