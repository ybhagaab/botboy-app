/**
 * Moving the analytics knowledge into the library, and changing the library's location (knowledge-library.md K11).
 * Everything runs on temp copies with a fresh HOME per test; the legacy folder is a synthetic lookalike. The binding
 * invariants are asserted one by one: nothing lost, ids and bytes identical, dry run writes nothing, conflicts abort
 * before the switch, idempotent and resumable, one transaction, reversible, never deletes.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ANALYTICS_CONTEXT_DIR_KEY,
  analyticsLibraryMode,
  listAnalyticsContext,
  loadAnalyticsContext,
  resolveAnalyticsContextDir,
} from './analytics-context.js';
import { registerCaptureExcludedRoots, isCaptureExcludedPath } from './capture-exclusions.js';
import { writeTree } from './knowledge-fixtures.testutil.js';
import { createKnowledgeLibrary, type KnowledgeLibrary } from './knowledge-library.js';
import { createKnowledgeMigration, type KnowledgeMigration, type MigrationPlan } from './knowledge-migration.js';
import { KNOWLEDGE_ROOT_ENV, canonicalRootOrNull, emptyKnowledgeState, knowledgeDenyRoots, knowledgeExcludedRoots, readKnowledgeState, writeKnowledgeState } from './knowledge-root.js';
import { adoptLesson, proposeLesson } from './lessons-ledger.js';
import { registerWriteProtectedRoots, writeProtectedRootsInEffect } from './protected-local-resources.js';
import { createStorage, getSetting, setSetting, type StorageLayer } from './storage.js';

let storage: StorageLayer;
let base: string;
let home: string;
let root: string;
let legacy: string;
let library: KnowledgeLibrary;
let migration: KnowledgeMigration;
let onboardingBusy = false;
const db = () => storage.getDb();
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const eperm = () => Object.assign(new Error('operation not permitted'), { code: 'EPERM' });

/** A synthetic legacy analytics folder: user notes, presets, lessons, the manifest, and things that are never listed. */
function legacyFiles(): Record<string, string> {
  return {
    'notes-on-events.md': '# Events note\n\nSession events use the visit_id key.\n',
    'schema-hints.txt': 'plain text hints\n',
    'presets/shopwave.md': '# Shopwave preset\n\nOrders, baskets and repeat purchase.\n',
    'presets/streamly.md': '# Streamly preset\n',
    'lessons/general.md': '# Lessons — general\n',
    'manifest.json': JSON.stringify({ files: [{ file: 'presets/shopwave.md', business: 'shopwave', keywords: ['orders'], source: 'etl-derived' }] }),
    '.hidden-note.md': 'hidden',
    'data.csv': 'a,b\n',
    'archive/old.md': '# Old\n',
    '.onboarding/estate.json': '{"profiles": []}',
  };
}

/** Hash every file under a folder (the "untouched" proof). */
function treeHash(dir: string): string {
  const lines: string[] = [];
  const walk = (current: string, relative: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const rel = relative ? `${relative}/${entry.name}` : entry.name;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full, rel);
      else lines.push(`${rel}:${entry.isSymbolicLink() ? 'link' : sha(fs.readFileSync(full))}`);
    }
  };
  if (fs.existsSync(dir)) walk(dir, '');
  return sha(lines.join('\n'));
}

function setup(options: { legacy?: Record<string, string> | null; explicit?: boolean; activate?: boolean } = {}) {
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'GUIDE.md'), '# Root\n');
  if (options.legacy !== null) writeTree(legacy, options.legacy ?? legacyFiles());
  if (options.explicit) setSetting(db(), ANALYTICS_CONTEXT_DIR_KEY, legacy);
  writeKnowledgeState(db(), { ...emptyKnowledgeState(), root: options.activate === false ? null : root, analyticsDir: 'legacy' });
}

beforeEach(() => {
  storage = createStorage(':memory:');
  storage.initialize();
  base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'kl-mig-')));
  home = path.join(base, 'home');
  fs.mkdirSync(home, { recursive: true });
  vi.stubEnv('HOME', home);
  root = path.join(base, 'Docs', 'BotBoy Knowledge');
  legacy = path.join(home, '.personal-productivity-tracker', 'analytics-context');
  onboardingBusy = false;
  registerWriteProtectedRoots(() => knowledgeDenyRoots(db()));
  registerCaptureExcludedRoots(() => knowledgeExcludedRoots(db()));
  library = createKnowledgeLibrary({ db: db() });
  migration = createKnowledgeMigration({ db: db(), library, onboardingBusy: () => onboardingBusy, logFile: path.join(base, 'migration.log') });
});

afterEach(() => {
  registerWriteProtectedRoots(null);
  registerCaptureExcludedRoots(null);
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  storage.close();
  fs.rmSync(base, { recursive: true, force: true });
});

const target = () => path.join(root, 'analytics');

// ── The dry run ────────────────────────────────────────────────────────────

describe('the dry run (plan)', () => {
  it('lists what would move, names what is ignored, and writes nothing at all', async () => {
    setup();
    const before = { legacy: treeHash(legacy), root: treeHash(root) };
    const spies = [vi.spyOn(fs.promises, 'mkdir'), vi.spyOn(fs.promises, 'writeFile'), vi.spyOn(fs.promises, 'rename'), vi.spyOn(fs, 'writeFileSync')];
    const plan = await migration.plan();
    expect(plan.ok).toBe(true);
    expect(plan.reason).toBeNull();
    expect(plan.entries.map((entry) => entry.name).sort()).toEqual(['lessons/general.md', 'manifest.json', 'notes-on-events.md', 'presets/shopwave.md', 'presets/streamly.md', 'schema-hints.txt']);
    expect(plan.entries.every((entry) => entry.state === 'copy' && /^[a-f0-9]{64}$/.test(entry.sha256))).toBe(true);
    expect(plan.ignored.map((entry) => entry.name).sort()).toEqual(['.hidden-note.md', '.onboarding', 'archive', 'data.csv']);
    expect(plan.ignored.find((entry) => entry.name === '.onboarding')?.reason).toMatch(/private state/);
    expect(plan.source).toBe(legacy);
    expect(plan.target).toBe(target());
    expect(plan.totalBytes).toBeGreaterThan(100);
    expect(plan.boundaryRegistered).toBe(true);
    expect(plan.planSha256).toMatch(/^[a-f0-9]{64}$/);
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    expect({ legacy: treeHash(legacy), root: treeHash(root) }).toEqual(before);
    expect(fs.existsSync(target())).toBe(false);
  });

  it('has a stable digest, and a different one when a byte of a source file changes', async () => {
    setup();
    const first = await migration.plan();
    expect((await migration.plan()).planSha256).toBe(first.planSha256);
    fs.appendFileSync(path.join(legacy, 'notes-on-events.md'), 'one more line\n');
    expect((await migration.plan()).planSha256).not.toBe(first.planSha256);
  });

  it('is empty and ok for an install with nothing to move', async () => {
    setup({ legacy: null });
    const plan = await migration.plan();
    expect(plan).toMatchObject({ ok: true, entries: [] });
  });

  it('copies a link to a regular file as that file\'s bytes under the link\'s name, and says so', async () => {
    setup();
    fs.writeFileSync(path.join(base, 'outside-note.md'), '# Outside\n');
    fs.symlinkSync(path.join(base, 'outside-note.md'), path.join(legacy, 'linked-note.md'));
    const plan = await migration.plan();
    expect(plan.ok).toBe(true);
    expect(plan.entries.find((entry) => entry.name === 'linked-note.md')).toMatchObject({ fromLink: true, sha256: sha('# Outside\n') });
  });

  it('BLOCKS on anything it could read before and cannot move: a link to a folder, a broken link, an unreadable file, too little space', async () => {
    setup();
    fs.mkdirSync(path.join(base, 'a-folder'));
    fs.symlinkSync(path.join(base, 'a-folder'), path.join(legacy, 'folder-link.md'));
    fs.symlinkSync(path.join(base, 'missing.md'), path.join(legacy, 'broken-link.md'));
    fs.writeFileSync(path.join(legacy, 'locked.md'), '# Locked\n');
    fs.chmodSync(path.join(legacy, 'locked.md'), 0o000);
    try {
      const plan = await migration.plan();
      expect(plan.ok).toBe(false);
      expect(plan.reason).toBe('blocked');
      expect(plan.blocked.map((entry) => entry.name).sort()).toEqual(['broken-link.md', 'folder-link.md', 'locked.md']);
      const apply = await migration.apply({ confirm: plan.planSha256 });
      expect(apply).toMatchObject({ ok: false, code: 'blocked' });
      expect(fs.existsSync(target())).toBe(false);
      expect(readKnowledgeState(db()).analyticsDir).toBe('legacy');
    } finally {
      fs.chmodSync(path.join(legacy, 'locked.md'), 0o644);
    }
    const spy = vi.spyOn(fs.promises, 'statfs').mockResolvedValue({ bavail: 1, bsize: 1 } as never);
    fs.rmSync(path.join(legacy, 'folder-link.md'));
    fs.rmSync(path.join(legacy, 'broken-link.md'));
    const tight = await migration.plan();
    expect(tight.reason).toBe('blocked');
    expect(tight.blocked.map((entry) => entry.reason).join(' ')).toMatch(/not enough free space/);
    spy.mockRestore();
  });

  it('marks a target that already holds the same bytes "present" and one with different bytes a conflict that blocks the move', async () => {
    setup();
    writeTree(target(), { 'notes-on-events.md': '# Events note\n\nSession events use the visit_id key.\n', 'schema-hints.txt': 'DIFFERENT\n' });
    const plan = await migration.plan();
    expect(plan.entries.find((entry) => entry.name === 'notes-on-events.md')?.state).toBe('present');
    expect(plan.entries.find((entry) => entry.name === 'schema-hints.txt')?.state).toBe('conflict');
    expect(plan.conflicts).toEqual(['schema-hints.txt']);
    expect(plan.ok).toBe(false);
    expect(plan.reason).toBe('conflict');
  });

  it('says why it cannot run: onboarding busy, the walls missing, no folder yet, already moved', async () => {
    setup();
    onboardingBusy = true;
    expect((await migration.plan()).reason).toBe('onboarding_running');
    onboardingBusy = false;
    registerWriteProtectedRoots(null);
    expect((await migration.plan()).reason).toBe('boundary_not_registered');
    registerWriteProtectedRoots(() => knowledgeDenyRoots(db()));
    writeKnowledgeState(db(), { ...emptyKnowledgeState(), root: null });
    expect((await migration.plan()).reason).toBe('not_activated');
    writeKnowledgeState(db(), { ...emptyKnowledgeState(), root, analyticsDir: 'library' });
    expect(await migration.plan()).toMatchObject({ reason: 'already_migrated', alreadyMigrated: true, ok: false });
  });

  it('flags a legacy root GUIDE.md as reclassified (design amendment P2-14a)', async () => {
    setup({ legacy: { ...legacyFiles(), 'GUIDE.md': '# A note that is called GUIDE\n' } });
    const plan = await migration.plan();
    expect(plan.reclassified).toEqual(['GUIDE.md']);
    expect(plan.ok).toBe(true);
  });
});

// ── Applying the move ──────────────────────────────────────────────────────

describe('apply', () => {
  it('copies, verifies and switches: identical bytes, same relative ids, the explicit directory cleared, the old folder untouched', async () => {
    setup({ explicit: true });
    const legacyBefore = treeHash(legacy);
    const oldList = listAnalyticsContext(db());
    const oldLoads = oldList.files.map((file) => [file.name, loadAnalyticsContext(db(), file.name)] as const);
    const plan = await migration.plan();
    const result = await migration.apply({ confirm: plan.planSha256 });
    if (!result.ok) throw new Error(result.message);
    expect(result).toMatchObject({ copied: 6, skipped: 0, source: legacy, target: target() });
    expect(result.record).toMatchObject({ files: 6, planSha256: plan.planSha256, previousDir: legacy, source: legacy });
    // The switch: library mode, the explicit directory cleared, the record kept.
    const state = readKnowledgeState(db());
    expect(state.analyticsDir).toBe('library');
    expect(state.migration).toMatchObject({ planSha256: plan.planSha256 });
    expect(getSetting(db(), ANALYTICS_CONTEXT_DIR_KEY)).toBeNull();
    expect(analyticsLibraryMode(db())).toBe(true);
    expect(resolveAnalyticsContextDir(db())).toBe(target());
    // Identical bytes at identical relative ids: what the old tool delivers is the same string before and after.
    for (const entry of plan.entries) {
      expect(sha(fs.readFileSync(path.join(target(), ...entry.name.split('/'))))).toBe(entry.sha256);
    }
    const newList = listAnalyticsContext(db());
    expect(newList.files.map((file) => file.name)).toEqual(oldList.files.map((file) => file.name));
    for (const [name, before] of oldLoads) expect(loadAnalyticsContext(db(), name)).toEqual(before);
    // Never listed, never copied; the old folder is exactly as it was.
    for (const never of ['.hidden-note.md', 'data.csv', 'archive/old.md', '.onboarding/estate.json']) expect(fs.existsSync(path.join(target(), ...never.split('/')))).toBe(false);
    expect(treeHash(legacy)).toBe(legacyBefore);
    // The library now sees the analytics set.
    expect((await library.status()).sets.map((set) => set.id)).toContain('analytics');
  });

  it('copies a custom directory\'s .onboarding/ work files to private state, never into the library', async () => {
    const custom = path.join(base, 'my analytics notes');
    writeTree(custom, legacyFiles());
    fs.mkdirSync(root, { recursive: true });
    setSetting(db(), ANALYTICS_CONTEXT_DIR_KEY, custom);
    writeKnowledgeState(db(), { ...emptyKnowledgeState(), root, analyticsDir: 'legacy' });
    const plan = await migration.plan();
    const result = await migration.apply({ confirm: plan.planSha256 });
    expect(result.ok).toBe(true);
    expect(fs.existsSync(path.join(home, '.personal-productivity-tracker', 'analytics-context', '.onboarding', 'estate.json'))).toBe(true);
    expect(fs.existsSync(path.join(target(), '.onboarding'))).toBe(false);
    expect(readKnowledgeState(db()).migration?.previousDir).toBe(custom);
  });

  it('refuses a wrong or missing confirmation, copying nothing', async () => {
    setup();
    expect(await migration.apply({ confirm: 'f'.repeat(64) })).toMatchObject({ ok: false, code: 'plan_changed' });
    expect(await migration.apply({ confirm: '' })).toMatchObject({ ok: false, code: 'plan_changed' });
    expect(fs.existsSync(target())).toBe(false);
    expect(readKnowledgeState(db()).analyticsDir).toBe('legacy');
  });

  it('a plan confirmed before the folder changed is refused', async () => {
    setup();
    const plan = await migration.plan();
    fs.appendFileSync(path.join(legacy, 'notes-on-events.md'), 'edited after preview\n');
    expect(await migration.apply({ confirm: plan.planSha256 })).toMatchObject({ ok: false, code: 'plan_changed' });
    expect(fs.existsSync(target())).toBe(false);
  });

  it('is idempotent: a second apply says it is already moved', async () => {
    setup();
    const plan = await migration.plan();
    expect((await migration.apply({ confirm: plan.planSha256 })).ok).toBe(true);
    expect(await migration.apply({ confirm: plan.planSha256 })).toMatchObject({ ok: false, code: 'already_migrated' });
  });

  it('resumes an interrupted copy: files already there with the same bytes are skipped, the rest copied, the same switch', async () => {
    setup();
    const plan = await migration.plan();
    for (const name of ['notes-on-events.md', 'presets/shopwave.md']) {
      writeTree(target(), { [name]: fs.readFileSync(path.join(legacy, ...name.split('/')), 'utf8') });
    }
    const resumed = await migration.plan();
    expect(resumed.planSha256).toBe(plan.planSha256); // the digest ignores progress, so the owner's confirmation still holds
    const result = await migration.apply({ confirm: plan.planSha256 });
    if (!result.ok) throw new Error(result.message);
    expect(result).toMatchObject({ copied: 4, skipped: 2 });
    expect(readKnowledgeState(db()).analyticsDir).toBe('library');
  });

  it('never overwrites: a target that appears with different bytes mid-copy aborts before the switch', async () => {
    setup();
    const plan = await migration.plan();
    const real = fs.promises.rename.bind(fs.promises);
    let renames = 0;
    vi.spyOn(fs.promises, 'rename').mockImplementation(((from: string, to: string) => {
      renames += 1;
      if (renames === 1) writeTree(target(), { 'presets/shopwave.md': 'SOMEONE ELSE WROTE THIS\n' });
      return real(from, to);
    }) as never);
    const result = await migration.apply({ confirm: plan.planSha256 });
    expect(result).toMatchObject({ ok: false, code: 'conflict' });
    expect(readKnowledgeState(db()).analyticsDir).toBe('legacy');
    expect(fs.readFileSync(path.join(target(), 'presets', 'shopwave.md'), 'utf8')).toBe('SOMEONE ELSE WROTE THIS\n');
  });

  it('recopies a source that changed during the copy, but only over a target that still holds what it wrote', async () => {
    setup();
    const plan = await migration.plan();
    const real = fs.promises.rename.bind(fs.promises);
    let renames = 0;
    vi.spyOn(fs.promises, 'rename').mockImplementation(((from: string, to: string) => {
      renames += 1;
      if (renames === 2) fs.writeFileSync(path.join(legacy, 'notes-on-events.md'), '# Events note\n\nEdited while the move ran.\n');
      return real(from, to);
    }) as never);
    const result = await migration.apply({ confirm: plan.planSha256 });
    if (!result.ok) throw new Error(result.message);
    expect(fs.readFileSync(path.join(target(), 'notes-on-events.md'), 'utf8')).toContain('Edited while the move ran.');
    expect(readKnowledgeState(db()).analyticsDir).toBe('library');
  });

  it('does not switch when a source changes at the last moment (the final check is synchronous)', async () => {
    setup();
    const plan = await migration.plan();
    const real = fs.readFileSync;
    let touched = false;
    // The first SYNCHRONOUS read of a copied file is the final check; the source changes right before it reads the source.
    vi.spyOn(fs, 'readFileSync').mockImplementation(((file: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
      if (!touched && String(file) === path.join(target(), 'schema-hints.txt')) {
        touched = true;
        fs.writeFileSync(path.join(legacy, 'schema-hints.txt'), 'changed at the last moment\n');
      }
      return (real as (...args: unknown[]) => unknown)(file, ...rest);
    }) as typeof fs.readFileSync);
    const result = await migration.apply({ confirm: plan.planSha256 });
    expect(touched).toBe(true);
    expect(result).toMatchObject({ ok: false });
    expect(readKnowledgeState(db()).analyticsDir).toBe('legacy');
  });

  it('switches in ONE transaction: if saving fails, neither setting changed', async () => {
    setup({ explicit: true });
    db().exec(`CREATE TRIGGER fail_clear BEFORE UPDATE ON app_settings WHEN NEW.key = '${ANALYTICS_CONTEXT_DIR_KEY}' BEGIN SELECT RAISE(ABORT, 'boom'); END;`);
    const plan = await migration.plan();
    const result = await migration.apply({ confirm: plan.planSha256 });
    expect(result).toMatchObject({ ok: false, code: 'io_error', nextAction: expect.stringContaining('Nothing was switched') });
    expect(readKnowledgeState(db()).analyticsDir).toBe('legacy');
    expect(readKnowledgeState(db()).migration).toBeNull();
    expect(getSetting(db(), ANALYTICS_CONTEXT_DIR_KEY)).toBe(legacy);
  });

  it('asks the owner to acknowledge a root GUIDE.md that becomes the analytics set\'s guide', async () => {
    setup({ legacy: { ...legacyFiles(), 'GUIDE.md': '# Called GUIDE\n' } });
    const plan = await migration.plan();
    const refused = await migration.apply({ confirm: plan.planSha256 });
    expect(refused).toMatchObject({ ok: false, code: 'acknowledgement_required' });
    expect(fs.existsSync(target())).toBe(false);
    const accepted = await migration.apply({ confirm: plan.planSha256, acknowledgeReclassified: true });
    expect(accepted.ok).toBe(true);
    expect(listAnalyticsContext(db()).files.map((file) => file.name)).not.toContain('GUIDE.md');
    expect(fs.existsSync(path.join(target(), 'GUIDE.md'))).toBe(true);
  });

  it('refuses while onboarding runs or the walls are down, naming the next action', async () => {
    setup();
    const plan = await migration.plan();
    onboardingBusy = true;
    const busy = await migration.apply({ confirm: plan.planSha256 });
    expect(busy).toMatchObject({ ok: false, code: 'onboarding_running' });
    onboardingBusy = false;
    registerWriteProtectedRoots(null);
    const walls = await migration.apply({ confirm: plan.planSha256 });
    expect(walls).toMatchObject({ ok: false, code: 'boundary_not_registered' });
    expect(fs.existsSync(target())).toBe(false);
  });

  it('turns a macOS refusal into permission_denied with the steps; nothing is switched', async () => {
    setup();
    const plan = await migration.plan();
    vi.spyOn(fs.promises, 'mkdir').mockRejectedValue(eperm());
    const result = await migration.apply({ confirm: plan.planSha256 });
    expect(result).toMatchObject({ ok: false, code: 'permission_denied' });
    expect((result as { nextAction: string }).nextAction).toMatch(/Files and Folders/);
    expect(readKnowledgeState(db()).analyticsDir).toBe('legacy');
  });

  it('writes a log of hashes only, never file content', async () => {
    setup();
    const plan = await migration.plan();
    await migration.apply({ confirm: plan.planSha256 });
    const log = fs.readFileSync(path.join(base, 'migration.log'), 'utf8');
    expect(log).toContain('migration_applied');
    expect(log).not.toContain('Session events use the visit_id key');
    expect(log).not.toContain('Orders, baskets');
  });

  it('keeps an adopted lesson projection correct afterwards without rewriting a moved, equal file', async () => {
    setup();
    const proposed = proposeLesson(db(), { scope: 'general', rule: 'Always name the filter regime beside a number.', evidence: 'seen in a synthetic run' });
    if (!proposed.ok) throw new Error(proposed.error);
    adoptLesson(db(), proposed.lesson.id); // legacy mode: renders into the legacy folder
    const plan = await migration.plan();
    expect(plan.entries.map((entry) => entry.name)).toContain('lessons/general.md');
    await migration.apply({ confirm: plan.planSha256 });
    const moved = path.join(target(), 'lessons', 'general.md');
    const mtime = fs.statSync(moved).mtimeMs;
    expect(sha(fs.readFileSync(moved))).toBe(plan.entries.find((entry) => entry.name === 'lessons/general.md')!.sha256);
    expect(fs.statSync(moved).mtimeMs).toBe(mtime);
  });
});

// ── Reverting ──────────────────────────────────────────────────────────────

describe('revert', () => {
  it('says there is nothing to revert before a move', async () => {
    setup();
    expect(await migration.revert()).toMatchObject({ ok: false, code: 'not_migrated' });
  });

  it('copies back what differs or is missing, saves a differing old file as .pre-revert, restores the setting, never deletes', async () => {
    setup({ explicit: true });
    const plan = await migration.plan();
    await migration.apply({ confirm: plan.planSha256 });
    // After the move the owner edits one library file, adds one, and the old folder gains a file the library lacks.
    fs.writeFileSync(path.join(target(), 'notes-on-events.md'), '# Events note\n\nEdited in the library.\n');
    fs.writeFileSync(path.join(target(), 'new-in-library.md'), '# New\n');
    fs.writeFileSync(path.join(legacy, 'only-in-legacy.md'), '# Only here\n');
    const libraryBefore = treeHash(target());
    const result = await migration.revert();
    if (!result.ok) throw new Error(result.message);
    expect(result).toMatchObject({ mirrored: 2, savedAsPreRevert: 1, source: legacy });
    expect(fs.readFileSync(path.join(legacy, 'notes-on-events.md'), 'utf8')).toContain('Edited in the library.');
    expect(fs.readFileSync(path.join(legacy, 'notes-on-events.md.pre-revert'), 'utf8')).toContain('Session events use the visit_id key');
    expect(fs.readFileSync(path.join(legacy, 'new-in-library.md'), 'utf8')).toBe('# New\n');
    expect(fs.existsSync(path.join(legacy, 'only-in-legacy.md'))).toBe(true);
    expect(treeHash(target())).toBe(libraryBefore);
    expect(readKnowledgeState(db())).toMatchObject({ analyticsDir: 'legacy', migration: null });
    expect(getSetting(db(), ANALYTICS_CONTEXT_DIR_KEY)).toBe(legacy);
    expect(resolveAnalyticsContextDir(db())).toBe(legacy);
    expect(await migration.revert()).toMatchObject({ ok: false, code: 'not_migrated' });
  });

  it('can be applied again after a revert (idempotent copies, same bytes)', async () => {
    setup();
    const first = await migration.plan();
    await migration.apply({ confirm: first.planSha256 });
    await migration.revert();
    const again = await migration.plan();
    expect(again.ok).toBe(true);
    expect(again.entries.every((entry) => entry.state === 'present')).toBe(true);
    const result = await migration.apply({ confirm: again.planSha256 });
    expect(result).toMatchObject({ ok: true, copied: 0, skipped: 6 });
  });
});

// ── Change location ────────────────────────────────────────────────────────

describe('change location', () => {
  let newRoot: string;
  beforeEach(() => {
    newRoot = path.join(base, 'Elsewhere', 'My Knowledge');
  });

  async function libraryWithSets() {
    setup({ legacy: null });
    writeTree(root, {
      'analytics/presets/shopwave.md': '# Shopwave\n',
      'analytics/manifest.json': '{"files": []}',
      'shop-data/GUIDE.md': '# Shop data guide\n',
      'shop-data/orders.md': '# Orders\n',
      'notes/ideas.md': '# Ideas\n',
      'notes/.secret-draft.md': 'hidden',
    });
    fs.symlinkSync(path.join(root, 'notes', 'ideas.md'), path.join(root, 'notes', 'link.md'));
    writeKnowledgeState(db(), { ...emptyKnowledgeState(), root, analyticsDir: 'library' });
  }

  it('copies the library across and verifies it, records the old root as a former root, and leaves the old folder exactly as it was', async () => {
    await libraryWithSets();
    const before = treeHash(root);
    const result = await migration.changeLocation({ path: newRoot });
    if (!result.ok) throw new Error(result.message);
    expect(result).toMatchObject({ root: newRoot, oldRoot: root, copied: 6 });
    expect(result.note).toMatch(/left exactly as it was; BotBoy never deletes it/);
    expect(fs.readFileSync(path.join(newRoot, 'shop-data', 'orders.md'), 'utf8')).toBe('# Orders\n');
    expect(fs.existsSync(path.join(newRoot, 'notes', '.secret-draft.md'))).toBe(false);
    expect(fs.existsSync(path.join(newRoot, 'notes', 'link.md'))).toBe(false);
    // What was not copied is told, not dropped silently (review D7): the hidden file and the link.
    expect(result.notCopied).toBe(2);
    expect([...result.notCopiedSample].sort()).toEqual(['notes/.secret-draft.md', 'notes/link.md']);
    expect(treeHash(root)).toBe(before);
    const state = readKnowledgeState(db());
    expect(state).toMatchObject({ root: newRoot, formerRoots: [root], analyticsDir: 'library' });
    expect(canonicalRootOrNull(db())).toBe(newRoot);
    expect(isCaptureExcludedPath(path.join(root, 'shop-data', 'orders.md'))).toBe(true);
    expect(isCaptureExcludedPath(path.join(newRoot, 'shop-data', 'orders.md'))).toBe(true);
    expect((await library.status()).sets.map((set) => set.id)).toEqual(['analytics', 'notes', 'shop-data']);
    expect(resolveAnalyticsContextDir(db())).toBe(path.join(newRoot, 'analytics'));
  });

  it('verifies every copied file against its source before switching: a source that changed after it was copied stops with verify_failed and nothing is switched (mutation M34)', async () => {
    await libraryWithSets();
    const orders = path.join(root, 'shop-data', 'orders.md');
    const realReadFile = fs.promises.readFile.bind(fs.promises);
    let changed = false;
    vi.spyOn(fs.promises, 'readFile').mockImplementation(((file: unknown, ...rest: unknown[]) => {
      const result = (realReadFile as (...args: unknown[]) => Promise<unknown>)(file, ...rest);
      if (changed || String(file) !== orders) return result;
      changed = true;
      // The owner edits the file the moment after BotBoy read it: the copy is now stale.
      return result.then((bytes) => { fs.appendFileSync(orders, 'edited after it was read\n'); return bytes; });
    }) as never);
    const result = await migration.changeLocation({ path: newRoot });
    expect(result).toMatchObject({ ok: false, code: 'verify_failed' });
    expect(readKnowledgeState(db()).root).toBe(root);
    expect(readKnowledgeState(db()).formerRoots).toEqual([]);
  });

  it('does not count Finder\'s .DS_Store as something left behind, and reports 0 when nothing was skipped (review D7)', async () => {
    setup({ legacy: null });
    writeTree(root, { 'analytics/presets/shopwave.md': '# Shopwave\n', 'shop-data/orders.md': '# Orders\n', '.DS_Store': 'x', 'shop-data/.DS_Store': 'x' });
    writeKnowledgeState(db(), { ...emptyKnowledgeState(), root, analyticsDir: 'library' });
    const result = await migration.changeLocation({ path: newRoot });
    if (!result.ok) throw new Error(result.message);
    expect(result).toMatchObject({ copied: 3, notCopied: 0, notCopiedSample: [] });
  });

  it('protects BOTH roots from commands while the copy runs, and the new one is covered before its first byte arrives', async () => {
    await libraryWithSets();
    const seen: string[][] = [];
    const real = fs.promises.rename.bind(fs.promises);
    vi.spyOn(fs.promises, 'rename').mockImplementation(((from: string, to: string) => {
      seen.push(writeProtectedRootsInEffect());
      return real(from, to);
    }) as never);
    await migration.changeLocation({ path: newRoot });
    expect(seen.length).toBeGreaterThan(3);
    for (const roots of seen) expect(roots).toEqual(expect.arrayContaining([root, newRoot]));
    expect(writeProtectedRootsInEffect()).toEqual([newRoot]);
  });

  it('lets the owner leave other sets behind, but the analytics set always travels in library mode', async () => {
    await libraryWithSets();
    const result = await migration.changeLocation({ path: newRoot, leaveBehind: ['notes', 'analytics', 'GUIDE.md'] });
    expect(result.ok).toBe(true);
    expect(fs.existsSync(path.join(newRoot, 'notes'))).toBe(false);
    expect(fs.existsSync(path.join(newRoot, 'shop-data', 'orders.md'))).toBe(true);
    expect(fs.existsSync(path.join(newRoot, 'analytics', 'presets', 'shopwave.md'))).toBe(true);
    expect(fs.existsSync(path.join(newRoot, 'GUIDE.md'))).toBe(true);
  });

  it('refuses without the walls and copies nothing', async () => {
    await libraryWithSets();
    registerWriteProtectedRoots(null);
    const result = await migration.changeLocation({ path: newRoot });
    expect(result).toMatchObject({ ok: false, code: 'boundary_not_registered' });
    expect(fs.existsSync(newRoot)).toBe(false);
    registerWriteProtectedRoots(() => knowledgeDenyRoots(db()));
    registerCaptureExcludedRoots(() => []);
    expect(await migration.changeLocation({ path: newRoot })).toMatchObject({ ok: false, code: 'exclusion_not_registered' });
    expect(fs.existsSync(newRoot)).toBe(false);
  });

  it('refuses the same folder, a nested folder, a bad location, an unset library, a pinned location and a running onboarding', async () => {
    await libraryWithSets();
    expect(await migration.changeLocation({ path: root })).toMatchObject({ ok: false, code: 'same_root' });
    expect(await migration.changeLocation({ path: path.join(root, 'inside') })).toMatchObject({ ok: false, code: 'nested_roots' });
    expect(await migration.changeLocation({ path: path.dirname(root) })).toMatchObject({ ok: false, code: 'nested_roots' });
    expect(await migration.changeLocation({ path: home })).toMatchObject({ ok: false, code: 'not_allowed_location' });
    expect(await migration.changeLocation({ path: '' })).toMatchObject({ ok: false, code: 'invalid_path' });
    onboardingBusy = true;
    expect(await migration.changeLocation({ path: newRoot })).toMatchObject({ ok: false, code: 'onboarding_running' });
    onboardingBusy = false;
    vi.stubEnv(KNOWLEDGE_ROOT_ENV, root);
    expect(await migration.changeLocation({ path: newRoot })).toMatchObject({ ok: false, code: 'root_pinned_by_environment' });
    vi.unstubAllEnvs();
    vi.stubEnv('HOME', home);
    writeKnowledgeState(db(), emptyKnowledgeState());
    expect(await migration.changeLocation({ path: newRoot })).toMatchObject({ ok: false, code: 'not_activated' });
    expect(fs.existsSync(newRoot)).toBe(false);
  });

  it('asks before copying into a folder that already holds things, and stops on a file with different content', async () => {
    await libraryWithSets();
    writeTree(newRoot, { 'shop-data/orders.md': '# DIFFERENT\n', 'unrelated.md': '# x\n' });
    const asked = await migration.changeLocation({ path: newRoot });
    expect(asked).toMatchObject({ ok: false, code: 'confirm_existing', existing: { entries: 2 } });
    const conflict = await migration.changeLocation({ path: newRoot, confirmExisting: true });
    expect(conflict).toMatchObject({ ok: false, code: 'conflict' });
    expect(readKnowledgeState(db()).root).toBe(root);
    expect(fs.readFileSync(path.join(newRoot, 'shop-data', 'orders.md'), 'utf8')).toBe('# DIFFERENT\n');
  });

  it('turns a macOS refusal into permission_denied and does not switch', async () => {
    await libraryWithSets();
    const real = fs.promises.mkdir.bind(fs.promises);
    vi.spyOn(fs.promises, 'mkdir').mockImplementation(((target: string, ...rest: unknown[]) => {
      if (String(target).startsWith(newRoot)) return Promise.reject(eperm());
      return (real as (...args: unknown[]) => unknown)(target, ...rest);
    }) as never);
    const result = await migration.changeLocation({ path: newRoot });
    expect(result).toMatchObject({ ok: false, code: 'permission_denied' });
    expect(readKnowledgeState(db()).root).toBe(root);
  });

  it('stops for lack of space before copying a byte', async () => {
    await libraryWithSets();
    vi.spyOn(fs.promises, 'statfs').mockResolvedValue({ bavail: 1, bsize: 1 } as never);
    const result = await migration.changeLocation({ path: newRoot });
    expect(result).toMatchObject({ ok: false, code: 'not_enough_space' });
    expect(fs.existsSync(path.join(newRoot, 'shop-data'))).toBe(false);
  });
});
