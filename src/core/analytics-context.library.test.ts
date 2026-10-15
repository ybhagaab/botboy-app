/**
 * The analytics knowledge folder in library mode (knowledge-library.md K10; design amendments P2-7, P2-13b) and the
 * guarantee that LEGACY mode, which is every install today, is exactly what it was. Synthetic names only; every root is
 * a temp folder with a space in its name.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ANALYTICS_CONTEXT_DIR_KEY,
  analyticsContextHeader,
  analyticsLibraryMode,
  analyticsLibraryWriteBlocker,
  legacyAnalyticsContextDir,
  listAnalyticsContext,
  loadAnalyticsContext,
  permissionProblem,
  privateAnalyticsContextDir,
  resolveAnalyticsContextDir,
} from './analytics-context.js';
import { AnalyticsImportInboxError, blockedContextError } from './analytics-import-inbox.js';
import { analyticsCatalogOrThrow } from './analytics-import-semantic-proposal.js';
import { createNodeManager } from './node-manager.js';
import { emptyKnowledgeState, KNOWLEDGE_ROOT_ENV, writeKnowledgeState } from './knowledge-root.js';
import { createStorage, setSetting, type StorageLayer } from './storage.js';
import { createToolExecutor } from './tool-executor.js';
import { writeTree } from './knowledge-fixtures.testutil.js';

let storage: StorageLayer;
let base: string;
let root: string;

const db = () => storage.getDb();
const libraryOn = (recorded: string | null = root) => writeKnowledgeState(db(), { ...emptyKnowledgeState(), root: recorded, analyticsDir: 'library' });
const eperm = () => Object.assign(new Error('operation not permitted'), { code: 'EPERM' });

beforeEach(() => {
  storage = createStorage(':memory:');
  storage.initialize();
  base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'kl-actx-')));
  root = path.join(base, 'BotBoy Knowledge');
  fs.mkdirSync(root, { recursive: true });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  storage.close();
  fs.rmSync(base, { recursive: true, force: true });
});

describe('which directory the analytics knowledge lives in', () => {
  it('is the private default in legacy mode, exactly as before', () => {
    expect(analyticsLibraryMode(db())).toBe(false);
    expect(resolveAnalyticsContextDir(db())).toBe(path.join(os.homedir(), '.personal-productivity-tracker', 'analytics-context'));
    expect(privateAnalyticsContextDir()).toBe(resolveAnalyticsContextDir(db()));
  });

  it('is <root>/analytics in library mode', () => {
    libraryOn();
    expect(analyticsLibraryMode(db())).toBe(true);
    expect(resolveAnalyticsContextDir(db())).toBe(path.join(root, 'analytics'));
  });

  it('follows the test override root once the install is in library mode', () => {
    vi.stubEnv(KNOWLEDGE_ROOT_ENV, root);
    writeKnowledgeState(db(), { ...emptyKnowledgeState(), analyticsDir: 'library' });
    expect(resolveAnalyticsContextDir(db())).toBe(path.join(root, 'analytics'));
  });

  it('lets an explicit directory win in either mode, and falls back to the private default if library mode has no root', () => {
    libraryOn();
    setSetting(db(), ANALYTICS_CONTEXT_DIR_KEY, path.join(base, 'explicit'));
    expect(resolveAnalyticsContextDir(db())).toBe(path.join(base, 'explicit'));
    setSetting(db(), ANALYTICS_CONTEXT_DIR_KEY, '');
    writeKnowledgeState(db(), { ...emptyKnowledgeState(), root: null, analyticsDir: 'library' });
    expect(resolveAnalyticsContextDir(db())).toBe(privateAnalyticsContextDir());
  });

  it('keeps the legacy folder addressable for the migration: the explicit setting, else the private default', () => {
    libraryOn();
    expect(legacyAnalyticsContextDir(db())).toBe(privateAnalyticsContextDir());
    setSetting(db(), ANALYTICS_CONTEXT_DIR_KEY, path.join(base, 'old-custom'));
    expect(legacyAnalyticsContextDir(db())).toBe(path.join(base, 'old-custom'));
  });
});

describe('legacy mode is untouched', () => {
  beforeEach(() => {
    setSetting(db(), ANALYTICS_CONTEXT_DIR_KEY, path.join(base, 'legacy dir'));
  });

  it('creates presets/, lists a root note called GUIDE.md, and follows a symbolic link to a note', () => {
    const legacy = path.join(base, 'legacy dir');
    writeTree(legacy, { 'GUIDE.md': '# A note that happens to be called GUIDE\n', 'real-note.md': '# Real\n' });
    fs.writeFileSync(path.join(base, 'outside-note.md'), '# Outside\n');
    fs.symlinkSync(path.join(base, 'outside-note.md'), path.join(legacy, 'linked-note.md'));
    const listing = listAnalyticsContext(db());
    expect(listing.unavailable).toBeUndefined();
    expect(fs.statSync(path.join(legacy, 'presets')).isDirectory()).toBe(true);
    expect(listing.files.map((file) => file.name)).toEqual(['GUIDE.md', 'linked-note.md', 'real-note.md']);
    const loaded = loadAnalyticsContext(db(), 'linked-note.md');
    expect(loaded.ok).toBe(true);
    expect(loaded.ok && loaded.content).toContain('# Outside');
    expect(loadAnalyticsContext(db(), 'GUIDE.md').ok).toBe(true);
  });

  it('says "not found" for a file it cannot read, with no permission wording', () => {
    const result = loadAnalyticsContext(db(), 'missing.md');
    expect(result).toEqual({ ok: false, error: '"missing.md" not found — call mcp_analytics_list_context for the current files' });
  });
});

describe('library mode: list', () => {
  beforeEach(() => libraryOn());

  it('never creates a folder, lists the root notes, presets and lessons, and skips the root guide in any case', () => {
    expect(listAnalyticsContext(db()).files).toEqual([]);
    expect(fs.existsSync(path.join(root, 'analytics'))).toBe(false);
    writeTree(path.join(root, 'analytics'), {
      'GUIDE.md': '# guide\n',
      'events-note.md': '# Events\n',
      'presets/shopwave.md': '# Shopwave\n',
      'lessons/general.md': '# Lessons\n',
      'manifest.json': JSON.stringify({ files: [{ file: 'presets/shopwave.md', business: 'shopwave', keywords: ['orders'], source: 'etl-derived' }] }),
      '.hidden.md': 'x',
      'data.json': '{}',
    });
    fs.writeFileSync(path.join(root, 'analytics', 'Guide.MD'), '# guide too\n');
    const files = listAnalyticsContext(db()).files;
    expect(files.map((file) => file.name).sort()).toEqual(['events-note.md', path.join('lessons', 'general.md'), path.join('presets', 'shopwave.md')].sort());
    expect(files.find((file) => file.name.endsWith('shopwave.md'))).toMatchObject({ source: 'etl-derived', business: 'shopwave', keywords: ['orders'] });
    expect(files.find((file) => file.name.endsWith('general.md'))?.source).toBe('lesson');
    expect(fs.existsSync(path.join(root, 'analytics', 'presets')) && listAnalyticsContext(db()).dir).toBe(path.join(root, 'analytics'));
  });

  it('skips symbolic links to files, and folders that are links or resolve outside the directory', () => {
    const analytics = path.join(root, 'analytics');
    writeTree(analytics, { 'real.md': '# Real\n' });
    fs.writeFileSync(path.join(base, 'outside.md'), '# Outside\n');
    fs.symlinkSync(path.join(base, 'outside.md'), path.join(analytics, 'linked.md'));
    fs.symlinkSync(path.join(analytics, 'real.md'), path.join(analytics, 'alias.md'));
    writeTree(path.join(base, 'elsewhere'), { 'secret.md': '# Elsewhere\n' });
    fs.symlinkSync(path.join(base, 'elsewhere'), path.join(analytics, 'presets'));
    expect(listAnalyticsContext(db()).files.map((file) => file.name)).toEqual(['real.md']);
  });

  it('reports a folder macOS will not let BotBoy read, in "unavailable", without throwing', () => {
    const analytics = path.join(root, 'analytics');
    fs.mkdirSync(analytics);
    const real = fs.readdirSync;
    vi.spyOn(fs, 'readdirSync').mockImplementation(((target: fs.PathLike, ...rest: unknown[]) => {
      if (String(target) === analytics) throw eperm();
      return (real as (...args: unknown[]) => unknown)(target, ...rest);
    }) as typeof fs.readdirSync);
    const listing = listAnalyticsContext(db());
    expect(listing.files).toEqual([]);
    expect(listing.unavailable).toMatchObject({ code: 'permission_denied' });
    expect(listing.unavailable?.nextAction).toMatch(/System Settings → Privacy & Security → Files and Folders/);
  });

  it('reports a real EACCES the same way', () => {
    const analytics = path.join(root, 'analytics');
    fs.mkdirSync(analytics);
    fs.chmodSync(analytics, 0o000);
    try {
      expect(listAnalyticsContext(db()).unavailable).toMatchObject({ code: 'permission_denied' });
    } finally {
      fs.chmodSync(analytics, 0o755);
    }
  });
});

describe('library mode: load', () => {
  beforeEach(() => {
    libraryOn();
    writeTree(path.join(root, 'analytics'), { 'GUIDE.md': '# guide\n', 'note.md': '# Note\nbody\n', 'presets/shopwave.md': '# Shopwave\n', 'lessons/general.md': '# Lessons\n' });
  });

  it('loads a note with the provenance header, byte for byte what legacy mode renders', () => {
    const library = loadAnalyticsContext(db(), 'note.md');
    expect(library).toMatchObject({ ok: true, source: 'user-dropped' });
    const legacyDb = createStorage(':memory:');
    legacyDb.initialize();
    setSetting(legacyDb.getDb(), ANALYTICS_CONTEXT_DIR_KEY, path.join(root, 'analytics'));
    try {
      expect(loadAnalyticsContext(legacyDb.getDb(), 'note.md')).toEqual(library);
    } finally {
      legacyDb.close();
    }
  });

  it('answers "not found" for the root guide, a link, and a missing file; names an outside path as outside', () => {
    expect(loadAnalyticsContext(db(), 'GUIDE.md')).toMatchObject({ ok: false, error: expect.stringContaining('not found') });
    expect(loadAnalyticsContext(db(), 'guide.md')).toMatchObject({ ok: false });
    fs.writeFileSync(path.join(base, 'outside.md'), '# Outside\n');
    fs.symlinkSync(path.join(base, 'outside.md'), path.join(root, 'analytics', 'linked.md'));
    expect(loadAnalyticsContext(db(), 'linked.md')).toMatchObject({ ok: false, error: expect.stringContaining('not found') });
    expect(loadAnalyticsContext(db(), 'nope.md')).toMatchObject({ ok: false, error: expect.stringContaining('not found') });
    expect(loadAnalyticsContext(db(), '../outside.md')).toMatchObject({ ok: false, error: expect.stringContaining('invalid name') });
  });

  it('refuses a file reached through a folder link that leaves the directory', () => {
    writeTree(path.join(base, 'elsewhere'), { 'x.md': '# X\n' });
    fs.rmSync(path.join(root, 'analytics', 'presets'), { recursive: true });
    fs.symlinkSync(path.join(base, 'elsewhere'), path.join(root, 'analytics', 'presets'));
    expect(loadAnalyticsContext(db(), 'presets/x.md')).toMatchObject({ ok: false, error: expect.stringContaining('outside') });
  });

  it('answers a permission refusal with the System Settings steps instead of "not found"', () => {
    const target = path.join(root, 'analytics', 'note.md');
    const real = fs.readFileSync;
    vi.spyOn(fs, 'readFileSync').mockImplementation(((file: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
      if (String(file) === target) throw eperm();
      return (real as (...args: unknown[]) => unknown)(file, ...rest);
    }) as typeof fs.readFileSync);
    const result = loadAnalyticsContext(db(), 'note.md');
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toMatch(/System Settings → Privacy & Security → Files and Folders/);
    expect(!result.ok && result.error).not.toMatch(/not found/);
  });
});

describe('provenance header (design amendment P2-7)', () => {
  beforeEach(() => {
    libraryOn();
    writeTree(path.join(root, 'analytics'), { 'note.md': '# Note\n', 'presets/shopwave.md': '# Shopwave\n', 'lessons/general.md': '# Lessons\n' });
  });
  it('is one builder: every load starts with exactly analyticsContextHeader for its source', () => {
    for (const [name, source] of [['note.md', 'user-dropped'], ['presets/shopwave.md', 'etl-derived'], ['lessons/general.md', 'lesson']] as const) {
      const result = loadAnalyticsContext(db(), name);
      expect(result.ok && result.source).toBe(source);
      const header = analyticsContextHeader(name, source);
      expect(result.ok && result.content.startsWith(header)).toBe(true);
      expect(header.split('\n')[0]).toBe(`[KNOWLEDGE FILE: ${name} — ${{
        'user-dropped': 'user-supplied warehouse/schema knowledge',
        'etl-derived': "generated from your team's production ETL profiles (Datanet)",
        lesson: 'BotBoy experiential lessons — owner-adopted operating rules from live incidents',
      }[source]}]`);
      expect(header.split('\n')[1]).toMatch(/^Source rules: schema facts transfer across sources/);
    }
  });
});

describe('library writers need the root to exist (design amendment P2-13b)', () => {
  it('lets legacy mode through, and a present root', () => {
    expect(analyticsLibraryWriteBlocker(db())).toBeNull();
    libraryOn();
    expect(analyticsLibraryWriteBlocker(db())).toBeNull();
  });
  it('blocks when the root was deleted or never set, and names the fix', () => {
    libraryOn(path.join(base, 'Gone'));
    expect(analyticsLibraryWriteBlocker(db())).toMatchObject({ code: 'root_unavailable', message: expect.stringContaining('missing') });
    writeKnowledgeState(db(), { ...emptyKnowledgeState(), root: null, analyticsDir: 'library' });
    expect(analyticsLibraryWriteBlocker(db())).toMatchObject({ code: 'root_unavailable' });
  });
  it('blocks a root that is a file, and a macOS refusal', () => {
    const file = path.join(base, 'a-file');
    fs.writeFileSync(file, 'x');
    libraryOn(file);
    expect(analyticsLibraryWriteBlocker(db())).toMatchObject({ code: 'root_unavailable' });
    libraryOn(root);
    const real = fs.statSync;
    vi.spyOn(fs, 'statSync').mockImplementation(((target: fs.PathLike, ...rest: unknown[]) => {
      if (String(target) === root) throw eperm();
      return (real as (...args: unknown[]) => unknown)(target, ...rest);
    }) as typeof fs.statSync);
    expect(analyticsLibraryWriteBlocker(db())).toMatchObject({ code: 'permission_denied' });
  });
});

describe('a blocked Knowledge folder, caller by caller (design Q1)', () => {
  beforeEach(() => {
    libraryOn();
    fs.mkdirSync(path.join(root, 'analytics'));
    const real = fs.readdirSync;
    vi.spyOn(fs, 'readdirSync').mockImplementation(((target: fs.PathLike, ...rest: unknown[]) => {
      if (String(target) === path.join(root, 'analytics')) throw eperm();
      return (real as (...args: unknown[]) => unknown)(target, ...rest);
    }) as typeof fs.readdirSync);
  });

  it('mcp_analytics_list_context keeps its JSON and adds "unavailable"', async () => {
    const executor = createToolExecutor(db(), createNodeManager(db()), {});
    const result = await executor.executeTool({ id: 'c1', type: 'function', function: { name: 'mcp_analytics_list_context', arguments: '{}' } });
    const body = JSON.parse(result.content);
    expect(body.files).toEqual([]);
    expect(body.unavailable).toMatchObject({ code: 'permission_denied' });
    expect(body.unavailable.nextAction).toMatch(/Files and Folders/);
  });

  it('mcp_analytics_list_context leaves legacy output without the field', async () => {
    writeKnowledgeState(db(), emptyKnowledgeState());
    setSetting(db(), ANALYTICS_CONTEXT_DIR_KEY, path.join(base, 'legacy'));
    const executor = createToolExecutor(db(), createNodeManager(db()), {});
    const result = await executor.executeTool({ id: 'c2', type: 'function', function: { name: 'mcp_analytics_list_context', arguments: '{}' } });
    expect(Object.keys(JSON.parse(result.content))).toEqual(['dir', 'files', 'note']);
  });

  it('R6.2a prepare/verify: the catalog throws AnalyticsImportInboxError "unavailable" with the next action, never a conflict', () => {
    let thrown: unknown;
    try { analyticsCatalogOrThrow(db()); } catch (error) { thrown = error; }
    expect(thrown).toBeInstanceOf(AnalyticsImportInboxError);
    expect(thrown).toMatchObject({ code: 'unavailable' });
    expect((thrown as AnalyticsImportInboxError).nextAction).toMatch(/Files and Folders/);
  });

  it('R6.2a file reads: a permission refusal maps to "unavailable"; anything else is left alone', () => {
    expect(blockedContextError(eperm(), root)).toMatchObject({ code: 'unavailable' });
    expect(blockedContextError(Object.assign(new Error('x'), { code: 'EACCES' }), root)).toMatchObject({ code: 'unavailable' });
    expect(blockedContextError(Object.assign(new Error('x'), { code: 'ENOENT' }), root)).toBeNull();
  });

  it('outside library mode a permission refusal is NOT mapped: legacy installs keep the raw error, as before the library existed (review D6)', () => {
    expect(blockedContextError(eperm(), root, false)).toBeNull();
    expect(blockedContextError(Object.assign(new Error('x'), { code: 'EACCES' }), root, false)).toBeNull();
    // Both R6.2a read sites hand the current mode to the helper, so a legacy folder's errors propagate unchanged.
    const promotion = fs.readFileSync(path.join(process.cwd(), 'src/core/analytics-import-promotion.ts'), 'utf8');
    const proposal = fs.readFileSync(path.join(process.cwd(), 'src/core/analytics-import-semantic-proposal.ts'), 'utf8');
    for (const source of [promotion, proposal]) {
      expect(source).toContain('throw blockedContextError(error, root, analyticsLibraryMode(db)) ?? error;');
      expect(source).not.toMatch(/blockedContextError\(error, root\)/);
    }
  });

  it('permissionProblem names only EPERM and EACCES', () => {
    expect(permissionProblem(eperm(), 'x')).toMatchObject({ code: 'permission_denied' });
    expect(permissionProblem(Object.assign(new Error('x'), { code: 'ENOENT' }), 'x')).toBeNull();
    expect(permissionProblem(new Error('plain'), 'x')).toBeNull();
    expect(permissionProblem(null, 'x')).toBeNull();
  });
});
