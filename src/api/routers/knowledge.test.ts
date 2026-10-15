/**
 * Settings → Knowledge routes (knowledge-library.md K12): who may call them, what they refuse, what they create, and the
 * one existing route they gate (GET /mcp/analytics-context). A real loopback server like mcp.test.ts, synthetic folders,
 * the sandbox deny and the capture exclusion registered the way index.ts registers them.
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerCaptureExcludedRoots } from '../../core/capture-exclusions.js';
import { ANALYTICS_CONTEXT_DIR_KEY } from '../../core/analytics-context.js';
import { sampleLibraryFiles, writeTree } from '../../core/knowledge-fixtures.testutil.js';
import { createKnowledgeLibrary, type KnowledgeLibrary } from '../../core/knowledge-library.js';
import { createKnowledgeMigration, type KnowledgeMigration } from '../../core/knowledge-migration.js';
import { KNOWLEDGE_ROOT_ENV, emptyKnowledgeState, knowledgeDenyRoots, knowledgeExcludedRoots, readKnowledgeState, writeKnowledgeState } from '../../core/knowledge-root.js';
import { ROOT_GUIDE_SEED } from '../../core/knowledge-templates.js';
import { registerWriteProtectedRoots } from '../../core/protected-local-resources.js';
import { createStorage, setSetting, type StorageLayer } from '../../core/storage.js';
import { createDashboardRouter, createDashboardState } from './dashboard.js';
import { createKnowledgeRouter } from './knowledge.js';
import { createMcpRouter } from './mcp.js';

let storage: StorageLayer;
let server: http.Server;
let base: string;
let port: number;
let tmp: string;
let home: string;
let library: KnowledgeLibrary;
let migration: KnowledgeMigration;
const db = () => storage.getDb();

/** A request from the rendered dashboard: same-origin Origin plus Sec-Fetch-Site. */
const ui = (test: request.Test) => test.set('Origin', base).set('Sec-Fetch-Site', 'same-origin');
const eperm = () => Object.assign(new Error('operation not permitted'), { code: 'EPERM' });

async function startServer(withLibrary = true) {
  const app = express();
  app.use(express.json());
  const deps: any = { nodeManager: {} as any, db: db(), ...(withLibrary ? { knowledgeLibrary: library, knowledgeMigration: migration } : {}) };
  app.use('/api', createKnowledgeRouter(deps));
  app.use('/api', createMcpRouter(deps));
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  port = (server.address() as AddressInfo).port;
  base = `http://127.0.0.1:${port}`;
}

beforeEach(async () => {
  storage = createStorage(':memory:');
  storage.initialize();
  tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'kl-routes-')));
  home = path.join(tmp, 'home');
  fs.mkdirSync(path.join(home, 'Documents'), { recursive: true });
  vi.stubEnv('HOME', home);
  registerWriteProtectedRoots(() => knowledgeDenyRoots(db()));
  registerCaptureExcludedRoots(() => knowledgeExcludedRoots(db()));
  library = createKnowledgeLibrary({ db: db() });
  migration = createKnowledgeMigration({ db: db(), library, logFile: path.join(tmp, 'migration.log') });
  await startServer();
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  registerWriteProtectedRoots(null);
  registerCaptureExcludedRoots(null);
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  storage.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const libraryRoot = () => path.join(home, 'Documents', 'BotBoy Knowledge');

describe('who may call the routes', () => {
  const routes: Array<['get' | 'post', string, boolean]> = [
    ['get', '/api/knowledge/status', false],
    ['get', '/api/knowledge/set?path=shop-data', false],
    ['post', '/api/knowledge/root', true],
    ['post', '/api/knowledge/rescan', true],
    ['get', '/api/knowledge/migration', false],
    ['post', '/api/knowledge/migration/preview', true],
    ['post', '/api/knowledge/migration/apply', true],
    ['post', '/api/knowledge/migration/revert', true],
    ['post', '/api/knowledge/root/change', true],
  ];

  it.each(routes)('%s %s refuses another site and another local port', async (method, url) => {
    const asForeign = (headers: Record<string, string>) => {
      const test = request(server)[method](url);
      for (const [name, value] of Object.entries(headers)) test.set(name, value);
      return test.send(method === 'post' ? { path: libraryRoot() } : undefined);
    };
    expect((await asForeign({ Origin: 'http://evil.example', 'Sec-Fetch-Site': 'cross-site' })).status).toBe(403);
    expect((await asForeign({ Origin: `http://127.0.0.1:${port + 1}`, 'Sec-Fetch-Site': 'same-site' })).status).toBe(403);
  });

  it.each(routes.filter(([, , changes]) => changes))('%s %s needs the rendered same-origin interface: no Origin, or no same-origin fetch context, is refused', async (method, url) => {
    const bare = await request(server)[method](url).send({ path: libraryRoot() });
    expect(bare.status).toBe(403);
    expect(bare.body.code).toBe('owner_action_required');
    const sameOriginNoFetch = await request(server)[method](url).set('Origin', base).set('Sec-Fetch-Site', 'cross-site').send({ path: libraryRoot() });
    expect(sameOriginNoFetch.status).toBe(403);
    expect(fs.existsSync(libraryRoot())).toBe(false);
  });

  it('reads accept a native client (no Origin) and are never cached', async () => {
    const status = await request(server).get('/api/knowledge/status');
    expect(status.status).toBe(200);
    expect(status.headers['cache-control']).toBe('no-store');
    const missing = await request(server).get('/api/knowledge/set?path=x');
    expect(missing.headers['cache-control']).toBe('no-store');
  });

  it('answers 503 with the fix when the service is absent', async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await startServer(false);
    const response = await request(server).get('/api/knowledge/status');
    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({ code: 'library_unavailable', nextAction: expect.stringContaining('Restart') });
  });
});

describe('GET /knowledge/status', () => {
  it('before the folder exists: not created, the default location, no disk access', async () => {
    const tripwire = vi.spyOn(fs.promises, 'readdir');
    const response = await request(server).get('/api/knowledge/status');
    expect(response.body).toMatchObject({ activated: false, state: 'not_created', root: null, sets: [], defaultRoot: libraryRoot() });
    expect(tripwire).not.toHaveBeenCalledWith(expect.stringContaining('BotBoy Knowledge'), expect.anything());
  });

  it('after creation: ready, with the sets', async () => {
    writeTree(libraryRoot(), sampleLibraryFiles());
    writeKnowledgeState(db(), { ...emptyKnowledgeState(), root: libraryRoot(), analyticsDir: 'library' });
    const response = await request(server).get('/api/knowledge/status');
    expect(response.body).toMatchObject({ activated: true, state: 'ready', denyActive: true });
    expect(response.body.sets.map((set: { id: string }) => set.id)).toEqual(['analytics', 'memory/preferences', 'notes', 'shop-data']);
  });
});

describe('POST /knowledge/root', () => {
  it('creates the folder on the owner\'s click, seeds the root guide, and answers with the new status', async () => {
    const response = await ui(request(server).post('/api/knowledge/root')).send({ path: libraryRoot() });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ ok: true, root: libraryRoot(), created: true, seededGuide: true, analyticsDir: 'library' });
    expect(response.body.status).toMatchObject({ state: 'ready', activated: true });
    expect(fs.readFileSync(path.join(libraryRoot(), 'GUIDE.md'), 'utf8')).toBe(ROOT_GUIDE_SEED);
    expect(readKnowledgeState(db()).root).toBe(libraryRoot());
    const again = await ui(request(server).post('/api/knowledge/root')).send({ path: libraryRoot() });
    expect(again.body).toMatchObject({ ok: true, created: false, seededGuide: false });
  });

  it('accepts a path written with ~/', async () => {
    const response = await ui(request(server).post('/api/knowledge/root')).send({ path: '~/Documents/BotBoy Knowledge' });
    expect(response.status).toBe(200);
    expect(response.body.root).toBe(libraryRoot());
  });

  it.each([
    ['an array body', [1, 2]],
    ['no path', {}],
    ['a path that is not a string', { path: 5 }],
    ['an empty path', { path: '   ' }],
    ['a NUL byte', { path: '/tmp/x\0y' }],
    ['a path over 1,024 characters', { path: `/tmp/${'x'.repeat(1_100)}` }],
  ])('refuses %s with a 400 and the next action', async (_label, body) => {
    const response = await ui(request(server).post('/api/knowledge/root')).send(body as never);
    expect(response.status).toBe(400);
    expect(response.body.nextAction.length).toBeGreaterThan(5);
  });

  it('refuses a bad location: the home folder, a standard folder, private state', async () => {
    for (const bad of [home, path.join(home, 'Documents'), path.join(home, '.personal-productivity-tracker', 'knowledge')]) {
      const response = await ui(request(server).post('/api/knowledge/root')).send({ path: bad });
      expect(response.status, bad).toBe(400);
      expect(['not_allowed_location', 'overlaps_private_state']).toContain(response.body.code);
    }
    expect(readKnowledgeState(db()).root).toBeNull();
  });

  it('asks first about a folder that already holds things, listing the effect; a second click with confirmExisting goes through', async () => {
    writeTree(libraryRoot(), { 'old-notes.md': '# Old\n', 'more.md': '# More\n' });
    const asked = await ui(request(server).post('/api/knowledge/root')).send({ path: libraryRoot() });
    expect(asked.status).toBe(409);
    expect(asked.body).toMatchObject({ code: 'confirm_existing', existing: { entries: 2, sample: ['more.md', 'old-notes.md'] } });
    expect(fs.existsSync(path.join(libraryRoot(), 'GUIDE.md'))).toBe(false);
    const confirmed = await ui(request(server).post('/api/knowledge/root')).send({ path: libraryRoot(), confirmExisting: true });
    expect(confirmed.status).toBe(200);
    expect(fs.readFileSync(path.join(libraryRoot(), 'old-notes.md'), 'utf8')).toBe('# Old\n');
  });

  it('a macOS refusal is a 403 with the System Settings steps', async () => {
    vi.spyOn(fs.promises, 'mkdir').mockRejectedValue(eperm());
    const response = await ui(request(server).post('/api/knowledge/root')).send({ path: libraryRoot() });
    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({ code: 'permission_denied' });
    expect(response.body.nextAction).toMatch(/System Settings → Privacy & Security → Files and Folders/);
  });

  it('refuses without the sandbox deny, with a 503, and creates nothing', async () => {
    registerWriteProtectedRoots(null);
    const response = await ui(request(server).post('/api/knowledge/root')).send({ path: libraryRoot() });
    expect(response.status).toBe(503);
    expect(response.body.code).toBe('boundary_not_registered');
    expect(fs.existsSync(libraryRoot())).toBe(false);
  });

  it('a second, different folder is Change location, not a silent switch that would strand the analytics knowledge', async () => {
    await ui(request(server).post('/api/knowledge/root')).send({ path: libraryRoot() });
    const other = await ui(request(server).post('/api/knowledge/root')).send({ path: path.join(home, 'Documents', 'Elsewhere') });
    expect(other.status).toBe(409);
    expect(other.body.code).toBe('change_location_required');
    expect(fs.existsSync(path.join(home, 'Documents', 'Elsewhere'))).toBe(false);
    expect(readKnowledgeState(db()).root).toBe(libraryRoot());
  });

  it('cannot change the location while the test override pins it', async () => {
    vi.stubEnv(KNOWLEDGE_ROOT_ENV, path.join(tmp, 'Pinned Knowledge'));
    const response = await ui(request(server).post('/api/knowledge/root')).send({ path: libraryRoot() });
    expect(response.status).toBe(409);
    expect(response.body.code).toBe('root_pinned_by_environment');
    expect(fs.existsSync(libraryRoot())).toBe(false);
  });

  it('refuses while the override pins the location without even asking the service to activate (the route is its own wall; mutation M56)', async () => {
    vi.stubEnv(KNOWLEDGE_ROOT_ENV, path.join(tmp, 'Pinned Knowledge'));
    const activate = vi.spyOn(library, 'activate');
    const response = await ui(request(server).post('/api/knowledge/root')).send({ path: libraryRoot() });
    expect(response.status).toBe(409);
    expect(activate).not.toHaveBeenCalled();
  });
});

describe('GET /knowledge/set', () => {
  beforeEach(() => {
    writeTree(libraryRoot(), sampleLibraryFiles());
    writeKnowledgeState(db(), { ...emptyKnowledgeState(), root: libraryRoot(), analyticsDir: 'library' });
  });

  it('returns one set with its files; the path is a set id resolved against the discovered sets', async () => {
    const response = await request(server).get('/api/knowledge/set').query({ path: 'shop-data' });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ id: 'shop-data', hasGuide: true, fileCount: 3 });
    expect(response.body.files[0]).toMatchObject({ name: 'orders.md' });
    const byName = await request(server).get('/api/knowledge/set').query({ path: 'Work Preferences' });
    expect(byName.body.id).toBe('memory/preferences');
  });

  it('answers 404 with the valid ids for anything that is not a discovered set, including a real path', async () => {
    for (const path_ of ['nope', '../notes', '/etc', libraryRoot(), 'shop-data/orders.md']) {
      const response = await request(server).get('/api/knowledge/set').query({ path: path_ });
      expect(response.status, path_).toBe(404);
      expect(response.body.code).toBe('set_not_found');
      expect(response.body.validSets).toContain('shop-data');
    }
  });

  it('refuses a missing, NUL-bearing or overlong path with a 400', async () => {
    expect((await request(server).get('/api/knowledge/set')).status).toBe(400);
    expect((await request(server).get('/api/knowledge/set').query({ path: 'a\0b' })).status).toBe(400);
    expect((await request(server).get('/api/knowledge/set').query({ path: 'x'.repeat(1_100) })).status).toBe(400);
    expect((await request(server).get('/api/knowledge/set?path=a&path=b')).status).toBe(400);
  });

  it('is a 409 before the folder exists', async () => {
    writeKnowledgeState(db(), emptyKnowledgeState());
    const response = await request(server).get('/api/knowledge/set').query({ path: 'shop-data' });
    expect(response.status).toBe(409);
    expect(response.body.code).toBe('not_activated');
  });
});

describe('POST /knowledge/rescan', () => {
  it('reads the sets again, repairs nothing it should not, and moves the version', async () => {
    writeTree(libraryRoot(), sampleLibraryFiles());
    writeKnowledgeState(db(), { ...emptyKnowledgeState(), root: libraryRoot(), analyticsDir: 'library' });
    const before = library.version();
    writeTree(libraryRoot(), { 'brand-new/a.md': '# A\n' });
    const response = await ui(request(server).post('/api/knowledge/rescan')).send({});
    expect(response.status).toBe(200);
    expect(response.body.sets.map((set: { id: string }) => set.id)).toContain('brand-new');
    expect(library.version()).toBeGreaterThan(before);
  });
});

describe('moving the analytics knowledge into the library, and changing the location', () => {
  const legacyDir = () => path.join(home, '.personal-productivity-tracker', 'analytics-context');
  const legacyFiles = () => ({
    'notes-on-events.md': '# Events note\n',
    'presets/shopwave.md': '# Shopwave preset\n',
    'lessons/general.md': '# Lessons\n',
  });
  const hashTree = (dir: string): string => {
    const lines: string[] = [];
    const walk = (current: string, relative: string) => {
      for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
        const rel = relative ? `${relative}/${entry.name}` : entry.name;
        if (entry.isDirectory()) walk(path.join(current, entry.name), rel);
        else lines.push(`${rel}:${fs.statSync(path.join(current, entry.name)).size}`);
      }
    };
    if (fs.existsSync(dir)) walk(dir, '');
    return lines.join('|');
  };
  /** An install with legacy analytics knowledge and the folder created: the state the Move card is for. */
  async function withLegacyInstall(files: Record<string, string> = legacyFiles()) {
    writeTree(legacyDir(), files);
    const created = await ui(request(server).post('/api/knowledge/root')).send({ path: libraryRoot() });
    expect(created.body.analyticsDir).toBe('legacy');
  }

  it('GET /knowledge/migration reports where the analytics knowledge lives and what the old folder holds', async () => {
    await withLegacyInstall();
    const response = await request(server).get('/api/knowledge/migration');
    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body).toMatchObject({ analyticsDir: 'legacy', migration: null, activated: true, legacy: { files: 3, hasManifest: false } });
    expect(response.body.syncNote).toMatch(/iCloud/);
  });

  it('preview is a dry run: it answers the plan and writes nothing, in the old folder or the library', async () => {
    await withLegacyInstall();
    const before = [hashTree(legacyDir()), hashTree(libraryRoot())];
    const response = await ui(request(server).post('/api/knowledge/migration/preview')).send({});
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ ok: true, reason: null, source: legacyDir(), target: path.join(libraryRoot(), 'analytics') });
    expect(response.body.entries).toHaveLength(3);
    expect(response.body.planSha256).toMatch(/^[a-f0-9]{64}$/);
    expect([hashTree(legacyDir()), hashTree(libraryRoot())]).toEqual(before);
    expect(readKnowledgeState(db()).analyticsDir).toBe('legacy');
  });

  it('apply needs the plan hash from a preview: a missing or malformed confirm is a 400, a stale one is a 409, and nothing is switched', async () => {
    await withLegacyInstall();
    for (const confirm of [undefined, 5, 'not-a-hash', 'A'.repeat(64), `${'a'.repeat(63)}`]) {
      const response = await ui(request(server).post('/api/knowledge/migration/apply')).send(confirm === undefined ? {} : { confirm });
      expect(response.status, String(confirm)).toBe(400);
      expect(response.body.code).toBe('invalid_confirm');
    }
    const stale = await ui(request(server).post('/api/knowledge/migration/apply')).send({ confirm: 'a'.repeat(64) });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('plan_changed');
    expect(readKnowledgeState(db()).analyticsDir).toBe('legacy');
    expect(fs.existsSync(path.join(libraryRoot(), 'analytics', 'notes-on-events.md'))).toBe(false);
  });

  it('previews, applies the exact plan, and reverts; the old folder is never emptied', async () => {
    await withLegacyInstall();
    const oldTree = hashTree(legacyDir());
    const plan = (await ui(request(server).post('/api/knowledge/migration/preview')).send({})).body;
    const applied = await ui(request(server).post('/api/knowledge/migration/apply')).send({ confirm: plan.planSha256 });
    expect(applied.status).toBe(200);
    expect(applied.body).toMatchObject({ ok: true, copied: 3, skipped: 0, source: legacyDir() });
    expect(readKnowledgeState(db()).analyticsDir).toBe('library');
    expect(fs.readFileSync(path.join(libraryRoot(), 'analytics', 'presets', 'shopwave.md'), 'utf8')).toBe('# Shopwave preset\n');
    expect(hashTree(legacyDir())).toBe(oldTree);
    const status = await request(server).get('/api/knowledge/status');
    expect(status.body).toMatchObject({ analyticsDir: 'library', legacyAnalytics: null });

    const again = await ui(request(server).post('/api/knowledge/migration/apply')).send({ confirm: plan.planSha256 });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('already_migrated');

    const reverted = await ui(request(server).post('/api/knowledge/migration/revert')).send({});
    expect(reverted.status).toBe(200);
    expect(reverted.body).toMatchObject({ ok: true, source: legacyDir() });
    expect(readKnowledgeState(db()).analyticsDir).toBe('legacy');
    expect(hashTree(legacyDir())).toBe(oldTree);

    const second = await ui(request(server).post('/api/knowledge/migration/revert')).send({});
    expect(second.status).toBe(409);
    expect(second.body.code).toBe('not_migrated');
  });

  it('a legacy GUIDE.md becomes the analytics guide only when the owner says they understand', async () => {
    await withLegacyInstall({ ...legacyFiles(), 'GUIDE.md': '# My old guide note\n' });
    const plan = (await ui(request(server).post('/api/knowledge/migration/preview')).send({})).body;
    expect(plan.reclassified).toEqual(['GUIDE.md']);
    const refused = await ui(request(server).post('/api/knowledge/migration/apply')).send({ confirm: plan.planSha256 });
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ code: 'acknowledgement_required', reclassified: ['GUIDE.md'] });
    expect(readKnowledgeState(db()).analyticsDir).toBe('legacy');
    const accepted = await ui(request(server).post('/api/knowledge/migration/apply')).send({ confirm: plan.planSha256, acknowledgeReclassified: true });
    expect(accepted.status).toBe(200);
  });

  it('a file that differs in the library stops the move with the names, a 409, and nothing switched', async () => {
    await withLegacyInstall();
    writeTree(path.join(libraryRoot(), 'analytics'), { 'notes-on-events.md': '# Someone else wrote this\n' });
    const plan = (await ui(request(server).post('/api/knowledge/migration/preview')).send({})).body;
    expect(plan).toMatchObject({ ok: false, reason: 'conflict', conflicts: ['notes-on-events.md'] });
    const response = await ui(request(server).post('/api/knowledge/migration/apply')).send({ confirm: plan.planSha256 });
    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({ code: 'conflict', conflicts: ['notes-on-events.md'] });
    expect(response.body.nextAction.length).toBeGreaterThan(10);
    expect(readKnowledgeState(db()).analyticsDir).toBe('legacy');
  });

  it('answers 503 with the fix when the migration service is absent', async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    const app = express();
    app.use(express.json());
    app.use('/api', createKnowledgeRouter({ nodeManager: {} as any, db: db(), knowledgeLibrary: library } as any));
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    port = (server.address() as AddressInfo).port;
    base = `http://127.0.0.1:${port}`;
    for (const url of ['/api/knowledge/migration/preview', '/api/knowledge/migration/apply', '/api/knowledge/migration/revert', '/api/knowledge/root/change']) {
      const response = await ui(request(server).post(url)).send({ confirm: 'a'.repeat(64), path: libraryRoot() });
      expect(response.status, url).toBe(503);
      expect(response.body.code).toBe('library_unavailable');
    }
  });

  describe('POST /knowledge/root/change', () => {
    const newRoot = () => path.join(home, 'Documents', 'Moved Knowledge');

    it.each([
      ['an array body', [1]],
      ['no path', {}],
      ['a path that is not a string', { path: 3 }],
      ['an empty path', { path: ' ' }],
      ['a NUL byte', { path: '/tmp/a\0b' }],
      ['a path over 1,024 characters', { path: `/tmp/${'x'.repeat(1_100)}` }],
    ])('refuses %s with a 400 and the next action', async (_label, body) => {
      await withLegacyInstall();
      const response = await ui(request(server).post('/api/knowledge/root/change')).send(body as never);
      expect(response.status).toBe(400);
      expect(response.body.nextAction.length).toBeGreaterThan(5);
    });

    it('is not_activated before the folder exists, and refuses a bad location without touching the disk', async () => {
      const early = await ui(request(server).post('/api/knowledge/root/change')).send({ path: newRoot() });
      expect(early.status).toBe(409);
      expect(early.body.code).toBe('not_activated');
      await withLegacyInstall();
      for (const bad of [home, path.join(home, 'Documents'), path.join(home, '.personal-productivity-tracker', 'knowledge')]) {
        const response = await ui(request(server).post('/api/knowledge/root/change')).send({ path: bad });
        expect(response.status, bad).toBe(400);
      }
      expect(readKnowledgeState(db()).root).toBe(libraryRoot());
    });

    it('copies the library across, switches, keeps the old folder exactly as it was, and answers the new status', async () => {
      await withLegacyInstall();
      writeTree(libraryRoot(), sampleLibraryFiles());
      const oldTree = hashTree(libraryRoot());
      const response = await ui(request(server).post('/api/knowledge/root/change')).send({ path: newRoot() });
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ ok: true, root: newRoot(), oldRoot: libraryRoot() });
      expect(response.body.copied).toBeGreaterThan(3);
      expect(response.body.note).toMatch(/never deletes/);
      expect(response.body.status).toMatchObject({ root: newRoot(), state: 'ready' });
      expect(hashTree(libraryRoot())).toBe(oldTree);
      expect(hashTree(newRoot())).toBe(oldTree);
      expect(readKnowledgeState(db())).toMatchObject({ root: newRoot(), formerRoots: expect.arrayContaining([libraryRoot()]) });
    });

    it('asks before copying into a folder that already holds things, naming a sample, and nothing is written', async () => {
      await withLegacyInstall();
      writeTree(newRoot(), { 'already-here.md': '# Here\n' });
      const response = await ui(request(server).post('/api/knowledge/root/change')).send({ path: newRoot() });
      expect(response.status).toBe(409);
      expect(response.body).toMatchObject({ code: 'confirm_existing', existing: { entries: 1, sample: ['already-here.md'] } });
      expect(fs.existsSync(path.join(newRoot(), 'GUIDE.md'))).toBe(false);
      expect(readKnowledgeState(db()).root).toBe(libraryRoot());
    });

    it('cannot run while the test override pins the location', async () => {
      await withLegacyInstall();
      vi.stubEnv(KNOWLEDGE_ROOT_ENV, libraryRoot());
      const response = await ui(request(server).post('/api/knowledge/root/change')).send({ path: newRoot() });
      expect(response.status).toBe(409);
      expect(response.body.code).toBe('root_pinned_by_environment');
      expect(fs.existsSync(newRoot())).toBe(false);
    });

    it('turns a macOS refusal into a 403 with the steps, switches nothing, and leaves no pending root behind', async () => {
      await withLegacyInstall();
      const real = fs.promises.mkdir;
      vi.spyOn(fs.promises, 'mkdir').mockImplementation(((target: fs.PathLike, ...rest: unknown[]) => {
        if (String(target).startsWith(newRoot())) return Promise.reject(eperm());
        return (real as (...args: unknown[]) => Promise<unknown>)(target, ...rest);
      }) as typeof fs.promises.mkdir);
      const response = await ui(request(server).post('/api/knowledge/root/change')).send({ path: newRoot() });
      expect(response.status).toBe(403);
      expect(response.body.code).toBe('permission_denied');
      expect(response.body.nextAction).toMatch(/System Settings → Privacy & Security → Files and Folders/);
      expect(readKnowledgeState(db()).root).toBe(libraryRoot());
      expect(knowledgeDenyRoots(db())).toEqual([libraryRoot()]);
    });
  });
});

describe('/dashboard/version carries the library counter', () => {
  it('adds knowledgeVersion only when the service is wired, and it moves with the library', async () => {
    const app = express();
    app.use('/api', createDashboardRouter(createDashboardState(), undefined, undefined, undefined, undefined, undefined, undefined, () => ({ version: library.version() })));
    const wired = http.createServer(app);
    await new Promise<void>((resolve) => wired.listen(0, '127.0.0.1', () => resolve()));
    try {
      const first = await request(wired).get('/api/dashboard/version');
      expect(first.body.knowledgeVersion).toBe(library.version());
      library.bump();
      const second = await request(wired).get('/api/dashboard/version');
      expect(second.body.knowledgeVersion).toBe(first.body.knowledgeVersion + 1);
    } finally {
      await new Promise<void>((resolve) => wired.close(() => resolve()));
    }
    const bare = express();
    bare.use('/api', createDashboardRouter(createDashboardState()));
    const unwired = http.createServer(bare);
    await new Promise<void>((resolve) => unwired.listen(0, '127.0.0.1', () => resolve()));
    try {
      expect((await request(unwired).get('/api/dashboard/version')).body).not.toHaveProperty('knowledgeVersion');
    } finally {
      await new Promise<void>((resolve) => unwired.close(() => resolve()));
    }
  });
});

describe('the existing analytics knowledge route', () => {
  it('GET now answers only the local owner and is never cached; a native client still works', async () => {
    setSetting(db(), ANALYTICS_CONTEXT_DIR_KEY, path.join(tmp, 'legacy'));
    const foreign = await request(server).get('/api/mcp/analytics-context').set('Origin', 'http://evil.example').set('Sec-Fetch-Site', 'cross-site');
    expect(foreign.status).toBe(403);
    const native = await request(server).get('/api/mcp/analytics-context');
    expect(native.status).toBe(200);
    expect(native.headers['cache-control']).toBe('no-store');
    expect(native.body).toMatchObject({ dir: path.join(tmp, 'legacy'), fileCount: 0 });
    expect(native.body).not.toHaveProperty('library');
    expect(native.body).not.toHaveProperty('unavailable');
    const sameOrigin = await ui(request(server).get('/api/mcp/analytics-context'));
    expect(sameOrigin.status).toBe(200);
  });

  it('in library mode it says so, names a blocked folder, and refuses a directory change with moved_to_library', async () => {
    writeTree(libraryRoot(), sampleLibraryFiles());
    writeKnowledgeState(db(), { ...emptyKnowledgeState(), root: libraryRoot(), analyticsDir: 'library' });
    const listed = await request(server).get('/api/mcp/analytics-context');
    expect(listed.body).toMatchObject({ library: true, dir: path.join(libraryRoot(), 'analytics') });
    const refused = await ui(request(server).post('/api/mcp/analytics-context')).send({ dir: path.join(tmp, 'somewhere') });
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ code: 'moved_to_library', nextAction: expect.stringContaining('Settings → Knowledge') });
    expect(readKnowledgeState(db()).analyticsDir).toBe('library');

    const real = fs.readdirSync;
    vi.spyOn(fs, 'readdirSync').mockImplementation(((target: fs.PathLike, ...rest: unknown[]) => {
      if (String(target) === path.join(libraryRoot(), 'analytics')) throw eperm();
      return (real as (...args: unknown[]) => unknown)(target, ...rest);
    }) as typeof fs.readdirSync);
    const blocked = await request(server).get('/api/mcp/analytics-context');
    expect(blocked.status).toBe(200);
    expect(blocked.body.unavailable).toMatchObject({ code: 'permission_denied' });
    expect(blocked.body.fileCount).toBe(0);
  });

  it('in legacy mode the directory change still works', async () => {
    const response = await ui(request(server).post('/api/mcp/analytics-context')).send({ dir: path.join(tmp, 'moved legacy') });
    expect(response.status).toBe(200);
    expect(response.body.dir).toBe(path.join(tmp, 'moved legacy'));
  });
});
