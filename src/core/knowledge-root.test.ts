/**
 * Where the Knowledge library lives (knowledge-library.md K1 to K4): the stored root, the test override, the root an
 * activation is checking, and the two answers the sandbox and the capture exclusion ask before any library feature
 * exists. Synthetic names only; a temp folder under /private/tmp or the temp HOME.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createStorage, type StorageLayer } from './storage.js';
import { registerCaptureExcludedRoots } from './capture-exclusions.js';
import {
  KNOWLEDGE_LIBRARY_KEY,
  KNOWLEDGE_ROOT_ENV,
  activateKnowledgeRoot,
  activateResolvedRoot,
  assertCaptureExclusion,
  assertWriteBoundary,
  canonicalRootOrNull,
  canonicalizeBestEffort,
  classifyRootError,
  defaultKnowledgeRoot,
  defaultRootValidationContext,
  emptyKnowledgeState,
  expandKnowledgePath,
  knowledgeDenyRoots,
  knowledgeExcludedRoots,
  readKnowledgeState,
  resolveKnowledgeRoot,
  setPendingKnowledgeRoot,
  validateKnowledgeRootCandidate,
  writeKnowledgeState,
  type RootValidationContext,
} from './knowledge-root.js';
import { registerWriteProtectedRoots } from './protected-local-resources.js';
import { GUIDE_FILE_NAME, ROOT_GUIDE_SEED } from './knowledge-templates.js';
import { setSetting } from './storage.js';

let storage: StorageLayer;
let base: string;

beforeEach(() => {
  storage = createStorage(':memory:');
  storage.initialize();
  base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'kl-root-')));
});

afterEach(() => {
  setPendingKnowledgeRoot(null);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  storage.close();
});

describe('the stored state', () => {
  it('is empty on a fresh install and reads without touching the disk', () => {
    const db = storage.getDb();
    const tripwire = () => { throw new Error('the disk was touched'); };
    vi.spyOn(fs, 'existsSync').mockImplementation(tripwire);
    vi.spyOn(fs, 'statSync').mockImplementation(tripwire);
    vi.spyOn(fs, 'readdirSync').mockImplementation(tripwire as never);
    vi.spyOn(fs.realpathSync, 'native').mockImplementation(tripwire);
    expect(readKnowledgeState(db)).toEqual(emptyKnowledgeState());
    expect(resolveKnowledgeRoot(db)).toEqual({ root: null, source: 'none', pinnedByEnvironment: false });
    expect(canonicalRootOrNull(db)).toBeNull();
    expect(knowledgeExcludedRoots(db)).toEqual([]);
  });

  it('defaults the folder to ~/Documents/BotBoy Knowledge', () => {
    expect(defaultKnowledgeRoot()).toBe(path.join(os.homedir(), 'Documents', 'BotBoy Knowledge'));
  });

  it('round-trips and bounds what it reads: junk fields fall back, relative or NUL paths are dropped', () => {
    const db = storage.getDb();
    writeKnowledgeState(db, { ...emptyKnowledgeState(), root: `${base}/BotBoy Knowledge`, analyticsDir: 'library', formerRoots: [`${base}/Old`], activatedAt: '2026-10-15T10:00:00.000Z' });
    expect(readKnowledgeState(db)).toMatchObject({ root: `${base}/BotBoy Knowledge`, analyticsDir: 'library', formerRoots: [`${base}/Old`] });
    setSetting(db, KNOWLEDGE_LIBRARY_KEY, {
      root: 'relative/dir',
      analyticsDir: 'somewhere',
      formerRoots: ['relative', `${base}/ok`, `${base}/nul\0`, 5, null, `${base}/ok`],
      migration: { at: 1, files: 'x' },
    });
    const state = readKnowledgeState(db);
    expect(state.root).toBeNull();
    expect(state.analyticsDir).toBe('legacy');
    expect(state.formerRoots).toEqual([`${base}/ok`]);
    expect(state.migration).toMatchObject({ files: 0 });
    setSetting(db, KNOWLEDGE_LIBRARY_KEY, 'not an object');
    expect(readKnowledgeState(db)).toEqual(emptyKnowledgeState());
  });

  it('keeps at most 32 former roots, newest last', () => {
    const db = storage.getDb();
    const many = Array.from({ length: 40 }, (_, i) => `${base}/old-${i}`);
    writeKnowledgeState(db, { ...emptyKnowledgeState(), formerRoots: many });
    const kept = readKnowledgeState(db).formerRoots;
    expect(kept).toHaveLength(32);
    expect(kept[31]).toBe(`${base}/old-39`);
  });
});

describe('which root counts', () => {
  it('prefers an activation in progress, then the test override, then the stored root', () => {
    const db = storage.getDb();
    writeKnowledgeState(db, { ...emptyKnowledgeState(), root: `${base}/stored` });
    expect(resolveKnowledgeRoot(db)).toEqual({ root: `${base}/stored`, source: 'settings', pinnedByEnvironment: false });
    vi.stubEnv(KNOWLEDGE_ROOT_ENV, `${base}/env root`);
    expect(resolveKnowledgeRoot(db)).toEqual({ root: `${base}/env root`, source: 'environment', pinnedByEnvironment: true });
    setPendingKnowledgeRoot(`${base}/pending`);
    expect(resolveKnowledgeRoot(db)).toEqual({ root: `${base}/pending`, source: 'pending', pinnedByEnvironment: true });
    setPendingKnowledgeRoot(null);
    expect(resolveKnowledgeRoot(db).source).toBe('environment');
  });

  it('ignores an override that is not an absolute path', () => {
    const db = storage.getDb();
    vi.stubEnv(KNOWLEDGE_ROOT_ENV, 'relative/place');
    expect(resolveKnowledgeRoot(db)).toEqual({ root: null, source: 'none', pinnedByEnvironment: false });
    vi.stubEnv(KNOWLEDGE_ROOT_ENV, '   ');
    expect(resolveKnowledgeRoot(db).source).toBe('none');
  });
});

describe('the canonical root (what the Seatbelt deny is built from)', () => {
  it('is the real path of an existing root, spaces and all', () => {
    const db = storage.getDb();
    const real = path.join(base, 'Real Place', 'BotBoy Knowledge');
    fs.mkdirSync(real, { recursive: true });
    const link = path.join(base, 'Link Place');
    fs.symlinkSync(path.join(base, 'Real Place'), link);
    writeKnowledgeState(db, { ...emptyKnowledgeState(), root: path.join(link, 'BotBoy Knowledge') });
    expect(canonicalRootOrNull(db)).toBe(real);
  });

  it('resolves a folder that does not exist yet through its nearest existing ancestor', () => {
    const real = path.join(base, 'Real');
    fs.mkdirSync(real);
    const link = path.join(base, 'Link');
    fs.symlinkSync(real, link);
    expect(canonicalizeBestEffort(path.join(link, 'Not Yet', 'BotBoy Knowledge'))).toBe(path.join(real, 'Not Yet', 'BotBoy Knowledge'));
    expect(canonicalizeBestEffort('/definitely-missing-kl/zzz')).toBe('/definitely-missing-kl/zzz');
  });

  it('follows the test override and an activation in progress', () => {
    const db = storage.getDb();
    vi.stubEnv(KNOWLEDGE_ROOT_ENV, path.join(base, 'Env Root'));
    expect(canonicalRootOrNull(db)).toBe(path.join(base, 'Env Root'));
    setPendingKnowledgeRoot(path.join(base, 'Pending Root'));
    expect(canonicalRootOrNull(db)).toBe(path.join(base, 'Pending Root'));
  });
});

describe('the roots a sandbox launched now must not write (knowledgeDenyRoots)', () => {
  it('is empty while no library exists, and reads without touching the disk', () => {
    const db = storage.getDb();
    const tripwire = () => { throw new Error('the disk was touched'); };
    vi.spyOn(fs, 'existsSync').mockImplementation(tripwire);
    vi.spyOn(fs, 'statSync').mockImplementation(tripwire);
    vi.spyOn(fs, 'readdirSync').mockImplementation(tripwire as never);
    vi.spyOn(fs.realpathSync, 'native').mockImplementation(tripwire);
    expect(knowledgeDenyRoots(db)).toEqual([]);
  });

  it('is the current root alone in normal times', () => {
    const db = storage.getDb();
    const real = path.join(base, 'Current Place', 'BotBoy Knowledge');
    fs.mkdirSync(real, { recursive: true });
    writeKnowledgeState(db, { ...emptyKnowledgeState(), root: real });
    expect(knowledgeDenyRoots(db)).toEqual([real]);
  });

  it('names BOTH the root being copied into and the current root while a location change runs (P2-14)', () => {
    const db = storage.getDb();
    const current = path.join(base, 'Current Place', 'BotBoy Knowledge');
    const incoming = path.join(base, 'Incoming Place', 'BotBoy Knowledge');
    fs.mkdirSync(current, { recursive: true });
    fs.mkdirSync(incoming, { recursive: true });
    writeKnowledgeState(db, { ...emptyKnowledgeState(), root: current });
    setPendingKnowledgeRoot(incoming);
    expect(knowledgeDenyRoots(db)).toEqual([incoming, current]);
    setPendingKnowledgeRoot(null);
    expect(knowledgeDenyRoots(db)).toEqual([current]);
  });

  it('answers the real path of a root spelled through a link, once even when two spellings meet', () => {
    const db = storage.getDb();
    const real = path.join(base, 'Real');
    fs.mkdirSync(path.join(real, 'BotBoy Knowledge'), { recursive: true });
    const link = path.join(base, 'Link');
    fs.symlinkSync(real, link);
    writeKnowledgeState(db, { ...emptyKnowledgeState(), root: path.join(link, 'BotBoy Knowledge') });
    setPendingKnowledgeRoot(path.join(real, 'BotBoy Knowledge'));
    expect(knowledgeDenyRoots(db)).toEqual([path.join(real, 'BotBoy Knowledge')]);
  });

  it('answers the pinned root alone while the test override is set, as the override is the current root', () => {
    const db = storage.getDb();
    writeKnowledgeState(db, { ...emptyKnowledgeState(), root: path.join(base, 'Stored') });
    vi.stubEnv(KNOWLEDGE_ROOT_ENV, path.join(base, 'Env Root'));
    expect(knowledgeDenyRoots(db)).toEqual([path.join(base, 'Env Root')]);
  });
});

describe('the roots capture must skip', () => {
  it('lists the current root in both spellings, the override, an activation in progress, and every former root', () => {
    const db = storage.getDb();
    const real = path.join(base, 'Real');
    fs.mkdirSync(path.join(real, 'BotBoy Knowledge'), { recursive: true });
    const link = path.join(base, 'Link');
    fs.symlinkSync(real, link);
    const former = path.join(base, 'Former Knowledge');
    writeKnowledgeState(db, { ...emptyKnowledgeState(), root: path.join(link, 'BotBoy Knowledge'), formerRoots: [former] });
    vi.stubEnv(KNOWLEDGE_ROOT_ENV, path.join(base, 'Env Root'));
    setPendingKnowledgeRoot(path.join(base, 'Pending Root'));
    const roots = knowledgeExcludedRoots(db);
    expect(roots).toEqual(expect.arrayContaining([
      path.join(link, 'BotBoy Knowledge'),
      path.join(real, 'BotBoy Knowledge'),
      former,
      path.join(base, 'Env Root'),
      path.join(base, 'Pending Root'),
    ]));
  });

  it('keeps a root excluded after the library moves on (formerRoots)', () => {
    const db = storage.getDb();
    writeKnowledgeState(db, { ...emptyKnowledgeState(), root: path.join(base, 'New'), formerRoots: [path.join(base, 'Old')] });
    expect(knowledgeExcludedRoots(db)).toContain(path.join(base, 'Old'));
  });
});

// ── Validation (K4) ────────────────────────────────────────────────────────

describe('which folders may hold the library', () => {
  let ctx: RootValidationContext;
  let sandboxHome: string;

  beforeEach(() => {
    sandboxHome = path.join(base, 'home');
    fs.mkdirSync(path.join(sandboxHome, 'Documents'), { recursive: true });
    ctx = {
      home: sandboxHome,
      privateRoot: path.join(sandboxHome, '.personal-productivity-tracker'),
      filesDir: path.join(sandboxHome, '.personal-productivity-tracker', 'files'),
      programDir: path.join(base, 'program', 'personal-productivity-tracker'),
    };
  });

  const ok = (raw: string) => validateKnowledgeRootCandidate(raw, ctx);

  it('accepts a new folder inside a standard folder, spaces and all', () => {
    expect(ok(path.join(sandboxHome, 'Documents', 'BotBoy Knowledge'))).toEqual({ ok: true, root: path.join(sandboxHome, 'Documents', 'BotBoy Knowledge') });
    expect(ok(path.join(sandboxHome, 'Library', 'Mobile Documents', 'Knowledge'))).toMatchObject({ ok: true });
    expect(ok(path.join(sandboxHome, 'Knowledge'))).toMatchObject({ ok: true });
  });

  it('expands a leading ~/ against the home folder', () => {
    expect(expandKnowledgePath('~/Documents/BotBoy Knowledge')).toBe(path.join(os.homedir(), 'Documents', 'BotBoy Knowledge'));
    expect(expandKnowledgePath('~')).toBe(os.homedir());
    expect(expandKnowledgePath('  /a/b  ')).toBe('/a/b');
    expect(validateKnowledgeRootCandidate('~/Documents/BotBoy Knowledge')).toMatchObject({ ok: true });
  });

  it.each([
    ['an empty string', ''],
    ['whitespace', '   '],
    ['a relative path', 'Documents/BotBoy Knowledge'],
    ['a NUL byte', '/private/tmp/kl-val/Know\0ledge'],
    ['a line break', '/private/tmp/kl-val/Know\nledge'],
    ['more than 1,024 characters', `/private/tmp/${'x'.repeat(1_100)}`],
  ])('refuses %s as invalid_path', (_label, raw) => {
    expect(ok(raw)).toMatchObject({ ok: false, code: 'invalid_path' });
  });

  it.each([['the disk root', '/'], ['one folder deep', '/Users'], ['two folders deep', '/Volumes/Backup']])('refuses %s as too_shallow', (_label, raw) => {
    expect(ok(raw)).toMatchObject({ ok: false, code: 'too_shallow' });
  });

  it('refuses the home folder, its parent, and every standard folder itself', () => {
    expect(ok(sandboxHome)).toMatchObject({ ok: false, code: 'not_allowed_location' });
    expect(ok(path.dirname(sandboxHome))).toMatchObject({ ok: false });
    for (const name of ['Documents', 'Desktop', 'Downloads', 'Library', 'Pictures', 'Movies', 'Music', 'Public', 'Applications']) {
      expect(ok(path.join(sandboxHome, name)), name).toMatchObject({ ok: false, code: 'not_allowed_location' });
    }
  });

  it('refuses a link that resolves to a standard folder', () => {
    const link = path.join(base, 'docs-link');
    fs.symlinkSync(path.join(sandboxHome, 'Documents'), link);
    expect(ok(link)).toMatchObject({ ok: false, code: 'not_allowed_location' });
  });

  it('refuses private state, the files workspace and the program folder as equal, inside or ancestor', () => {
    for (const candidate of [
      ctx.privateRoot,
      path.join(ctx.privateRoot, 'knowledge'),
      ctx.filesDir,
      path.join(ctx.filesDir, 'Knowledge'),
    ]) {
      expect(ok(candidate), candidate).toMatchObject({ ok: false, code: 'overlaps_private_state' });
    }
    for (const candidate of [ctx.programDir, path.join(ctx.programDir, 'Knowledge'), path.dirname(ctx.programDir)]) {
      expect(ok(candidate), candidate).toMatchObject({ ok: false, code: 'overlaps_program' });
    }
  });

  it('every refusal names the next action', () => {
    for (const raw of ['', '/', sandboxHome, ctx.privateRoot, ctx.programDir]) {
      const result = ok(raw);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.nextAction.length).toBeGreaterThan(10);
    }
  });

  it('defaults to the real home, private state and program folder', () => {
    const real = defaultRootValidationContext();
    expect(real.home).toBe(os.homedir());
    expect(real.privateRoot).toBe(path.join(os.homedir(), '.personal-productivity-tracker'));
    expect(real.filesDir).toBe(path.join(real.privateRoot, 'files'));
    expect(fs.existsSync(path.join(real.programDir, 'package.json'))).toBe(true);
  });
});

describe('how a filesystem failure is described', () => {
  const root = '/private/tmp/kl-x/BotBoy Knowledge';
  it('maps EPERM and EACCES to permission_denied with the System Settings steps, and never says retry', () => {
    for (const code of ['EPERM', 'EACCES']) {
      const result = classifyRootError(Object.assign(new Error('nope'), { code }), root);
      expect(result).toMatchObject({ ok: false, code: 'permission_denied' });
      expect(result.nextAction).toMatch(/System Settings → Privacy & Security → Files and Folders/);
      expect(result.nextAction).toMatch(/Change location/);
      expect(result.nextAction).not.toMatch(/retry|again later/i);
    }
  });
  it('maps a missing folder and anything else', () => {
    expect(classifyRootError(Object.assign(new Error('x'), { code: 'ENOENT' }), root)).toMatchObject({ code: 'root_unavailable' });
    expect(classifyRootError(Object.assign(new Error('x'), { code: 'ENOTDIR' }), root)).toMatchObject({ code: 'root_unavailable' });
    expect(classifyRootError(Object.assign(new Error('disk exploded'), { code: 'EIO' }), root)).toMatchObject({ code: 'io_error' });
  });
});

// ── Activation (K3) ────────────────────────────────────────────────────────

describe('creating the folder (activation)', () => {
  let db: ReturnType<StorageLayer['getDb']>;
  let ctx: RootValidationContext;
  let rootPath: string;

  const registerBoundaries = () => {
    registerWriteProtectedRoots(() => canonicalRootOrNull(db));
    registerCaptureExcludedRoots(() => knowledgeExcludedRoots(db));
  };

  beforeEach(() => {
    db = storage.getDb();
    const home = path.join(base, 'home');
    fs.mkdirSync(path.join(home, 'Documents'), { recursive: true });
    ctx = {
      home,
      privateRoot: path.join(home, '.personal-productivity-tracker'),
      filesDir: path.join(home, '.personal-productivity-tracker', 'files'),
      programDir: path.join(base, 'program'),
    };
    rootPath = path.join(home, 'Documents', 'BotBoy Knowledge');
    registerBoundaries();
  });

  afterEach(() => {
    registerWriteProtectedRoots(null);
    registerCaptureExcludedRoots(null);
  });

  it('seeds the root guide, records the root, and reports what it did', async () => {
    const result = await activateKnowledgeRoot(db, rootPath, { context: ctx, legacyHasContent: () => false });
    expect(result).toEqual({ ok: true, root: rootPath, created: true, seededGuide: true, analyticsDir: 'library', changedRoot: false });
    expect(fs.readFileSync(path.join(rootPath, GUIDE_FILE_NAME), 'utf8')).toBe(ROOT_GUIDE_SEED);
    expect(fs.statSync(path.join(rootPath, 'analytics', 'presets')).isDirectory()).toBe(true);
    expect(fs.statSync(path.join(rootPath, 'analytics', 'lessons')).isDirectory()).toBe(true);
    const state = readKnowledgeState(db);
    expect(state).toMatchObject({ root: rootPath, analyticsDir: 'library', formerRoots: [] });
    expect(state.activatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(resolveKnowledgeRoot(db)).toMatchObject({ root: rootPath, source: 'settings' });
  });

  it('keeps analytics in the legacy folder when the install has legacy content, or when it cannot tell', async () => {
    const withContent = await activateKnowledgeRoot(db, rootPath, { context: ctx, legacyHasContent: () => true });
    expect(withContent).toMatchObject({ ok: true, analyticsDir: 'legacy' });
    expect(fs.existsSync(path.join(rootPath, 'analytics'))).toBe(false);
    expect(readKnowledgeState(db).analyticsDir).toBe('legacy');
    const other = path.join(ctx.home, 'Documents', 'Second Knowledge');
    const unknown = await activateKnowledgeRoot(storage.getDb(), other, { context: ctx });
    expect(unknown).toMatchObject({ ok: true, analyticsDir: 'legacy' });
  });

  it('never moves analytics back once the install is in library mode', async () => {
    writeKnowledgeState(db, { ...emptyKnowledgeState(), analyticsDir: 'library' });
    const result = await activateKnowledgeRoot(db, rootPath, { context: ctx, legacyHasContent: () => true });
    expect(result).toMatchObject({ ok: true, analyticsDir: 'library' });
    expect(fs.existsSync(path.join(rootPath, 'analytics', 'lessons'))).toBe(true);
  });

  it('is idempotent: a second run creates nothing and never rewrites an edited guide', async () => {
    await activateKnowledgeRoot(db, rootPath, { context: ctx, legacyHasContent: () => false });
    const edited = '# My own root guide\n';
    fs.writeFileSync(path.join(rootPath, GUIDE_FILE_NAME), edited);
    const again = await activateKnowledgeRoot(db, rootPath, { context: ctx, legacyHasContent: () => false });
    expect(again).toMatchObject({ ok: true, created: false, seededGuide: false, changedRoot: false });
    expect(fs.readFileSync(path.join(rootPath, GUIDE_FILE_NAME), 'utf8')).toBe(edited);
  });

  it('works through the providers index.ts registers: the root is visible to them before it is recorded', async () => {
    expect(canonicalRootOrNull(db)).toBeNull();
    const result = await activateKnowledgeRoot(db, rootPath, { context: ctx, legacyHasContent: () => false });
    expect(result.ok).toBe(true);
    expect(canonicalRootOrNull(db)).toBe(rootPath);
    expect(knowledgeExcludedRoots(db)).toContain(rootPath);
  });

  it('stops before creating anything when the sandbox deny does not report the root', async () => {
    registerWriteProtectedRoots(null);
    const result = await activateKnowledgeRoot(db, rootPath, { context: ctx, legacyHasContent: () => false });
    expect(result).toMatchObject({ ok: false, code: 'boundary_not_registered' });
    expect(fs.existsSync(rootPath)).toBe(false);
    expect(readKnowledgeState(db).root).toBeNull();
    expect(assertWriteBoundary(rootPath)).toMatchObject({ code: 'boundary_not_registered' });
  });

  it('stops before creating anything when the capture exclusion does not cover the root', async () => {
    registerCaptureExcludedRoots(null);
    const result = await activateKnowledgeRoot(db, rootPath, { context: ctx, legacyHasContent: () => false });
    expect(result).toMatchObject({ ok: false, code: 'exclusion_not_registered' });
    expect(fs.existsSync(rootPath)).toBe(false);
    expect(readKnowledgeState(db).root).toBeNull();
    expect(assertCaptureExclusion(rootPath)).toMatchObject({ code: 'exclusion_not_registered' });
  });

  it('refuses a bad location without touching the disk', async () => {
    const spy = vi.spyOn(fs.promises, 'mkdir');
    const result = await activateKnowledgeRoot(db, ctx.home, { context: ctx });
    expect(result).toMatchObject({ ok: false, code: 'not_allowed_location' });
    expect(spy).not.toHaveBeenCalled();
    expect(readKnowledgeState(db).root).toBeNull();
  });

  it('asks before using a folder that already holds things, and lists the effect without writing', async () => {
    fs.mkdirSync(rootPath, { recursive: true });
    for (const name of ['b-notes.md', 'a-notes.md']) fs.writeFileSync(path.join(rootPath, name), '# n\n');
    fs.writeFileSync(path.join(rootPath, '.hidden'), 'x');
    const asked = await activateKnowledgeRoot(db, rootPath, { context: ctx, legacyHasContent: () => false });
    expect(asked).toMatchObject({ ok: false, code: 'confirm_existing', existing: { entries: 2, sample: ['a-notes.md', 'b-notes.md'] } });
    expect(fs.existsSync(path.join(rootPath, GUIDE_FILE_NAME))).toBe(false);
    expect(readKnowledgeState(db).root).toBeNull();

    const confirmed = await activateKnowledgeRoot(db, rootPath, { context: ctx, legacyHasContent: () => false, confirmExisting: true });
    expect(confirmed).toMatchObject({ ok: true, created: false, seededGuide: true });
    expect(fs.readFileSync(path.join(rootPath, 'a-notes.md'), 'utf8')).toBe('# n\n');
  });

  it('does not ask again for a root the install already recorded', async () => {
    await activateKnowledgeRoot(db, rootPath, { context: ctx, legacyHasContent: () => false });
    fs.writeFileSync(path.join(rootPath, 'extra.md'), '# extra\n');
    expect(await activateKnowledgeRoot(db, rootPath, { context: ctx, legacyHasContent: () => false })).toMatchObject({ ok: true });
  });

  it('refuses a path that is a file', async () => {
    fs.mkdirSync(path.dirname(rootPath), { recursive: true });
    fs.writeFileSync(rootPath, 'not a folder');
    expect(await activateKnowledgeRoot(db, rootPath, { context: ctx })).toMatchObject({ ok: false, code: 'not_a_folder' });
  });

  it('turns EPERM into permission_denied with the steps, records nothing, and clears the pending root', async () => {
    vi.spyOn(fs.promises, 'mkdir').mockRejectedValue(Object.assign(new Error('operation not permitted'), { code: 'EPERM' }));
    const result = await activateKnowledgeRoot(db, rootPath, { context: ctx, legacyHasContent: () => false });
    expect(result).toMatchObject({ ok: false, code: 'permission_denied' });
    if (!result.ok) expect(result.nextAction).toMatch(/Files and Folders/);
    expect(readKnowledgeState(db).root).toBeNull();
    expect(canonicalRootOrNull(db)).toBeNull();
  });

  it('turns a real EACCES (an unreadable parent folder) into permission_denied', async () => {
    const locked = path.join(ctx.home, 'Documents', 'Locked');
    fs.mkdirSync(locked);
    fs.chmodSync(locked, 0o000);
    try {
      const result = await activateKnowledgeRoot(db, path.join(locked, 'BotBoy Knowledge'), { context: ctx });
      expect(result).toMatchObject({ ok: false, code: 'permission_denied' });
    } finally {
      fs.chmodSync(locked, 0o755);
    }
  });

  it('records the old root as a former root when the location changes, and keeps it excluded', async () => {
    await activateKnowledgeRoot(db, rootPath, { context: ctx, legacyHasContent: () => false });
    const second = path.join(ctx.home, 'Documents', 'Moved Knowledge');
    const moved = await activateKnowledgeRoot(db, second, { context: ctx, legacyHasContent: () => false });
    expect(moved).toMatchObject({ ok: true, changedRoot: true, root: second });
    expect(readKnowledgeState(db)).toMatchObject({ root: second, formerRoots: [rootPath] });
    expect(knowledgeExcludedRoots(db)).toEqual(expect.arrayContaining([second, rootPath]));
    // Going back does not list the active root as a former root.
    const back = await activateKnowledgeRoot(db, rootPath, { context: ctx, legacyHasContent: () => false });
    expect(back).toMatchObject({ ok: true, changedRoot: true });
    expect(readKnowledgeState(db)).toMatchObject({ root: rootPath, formerRoots: [second] });
  });

  it('cannot be changed from Settings while the test override is set, but the override itself activates', async () => {
    vi.stubEnv(KNOWLEDGE_ROOT_ENV, rootPath);
    const refused = await activateKnowledgeRoot(db, path.join(ctx.home, 'Documents', 'Elsewhere'), { context: ctx });
    expect(refused).toMatchObject({ ok: false, code: 'root_pinned_by_environment' });
    expect(fs.existsSync(path.join(ctx.home, 'Documents', 'Elsewhere'))).toBe(false);
    const viaEnvironment = await activateResolvedRoot(db, rootPath, { context: ctx, legacyHasContent: () => false });
    expect(viaEnvironment).toMatchObject({ ok: true, root: rootPath });
  });

  it('puts nothing on the disk for a root it only reads: resolving and listing providers are free of I/O writes', () => {
    const spy = vi.spyOn(fs.promises, 'mkdir');
    resolveKnowledgeRoot(db);
    canonicalRootOrNull(db);
    knowledgeExcludedRoots(db);
    expect(spy).not.toHaveBeenCalled();
  });
});
