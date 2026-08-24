import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs';
import express from 'express';
import request from 'supertest';

/**
 * Unit tests for the local-folders routes mounted at `/api/local-folders/*`
 * and the file-action shims `/api/files/open` and `/api/files/reveal`.
 *
 * The router is exercised end-to-end with a real in-memory SQLite DB and a
 * stub `filesystemMonitor`. `child_process.spawn` is mocked so the file-shim
 * tests can assert the exact command line without launching a real process.
 *
 * Validates: Requirements 4.1, 4.2, 4.3, 4.4, 4.5, 7.2, 7.4, 8.1
 */

// ── Hoisted child_process mock ────────────────────────────────────────────
//
// vi.hoisted runs before module imports, so the mock is in place when
// routes.ts is statically imported below. The shared `child` stub exposes a
// vi.fn .unref() so tests can assert the route called .unref() to detach
// the spawned process.
const spawnMocks = vi.hoisted(() => {
  const child = { unref: vi.fn() };
  const spawn = vi.fn(() => child);
  return { spawn, child };
});

vi.mock('child_process', () => ({
  spawn: spawnMocks.spawn,
}));

// Static imports — vi.mock is hoisted above this so routes.ts picks up the
// child_process mock.
import { createRouter } from './routes.js';
import { createStorage, type StorageLayer } from '../core/storage.js';
import { listLocalFolders } from '../core/local-folders-config.js';

// ── Test helpers ───────────────────────────────────────────────────────────

type FsMonitorStub = {
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  onWorkItem: ReturnType<typeof vi.fn>;
  setWatchedFolders: ReturnType<typeof vi.fn>;
  getWatchedFolders: ReturnType<typeof vi.fn>;
  backfill: ReturnType<typeof vi.fn>;
};

function makeFsMonitorStub(): FsMonitorStub {
  return {
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    onWorkItem: vi.fn(),
    setWatchedFolders: vi.fn(async () => {}),
    getWatchedFolders: vi.fn(() => []),
    backfill: vi.fn(async () => ({ aborted: false, total: 0 })),
  };
}

function buildApp(deps: Parameters<typeof createRouter>[0]): express.Express {
  const app = express();
  app.use(express.json());
  app.use('/api', createRouter(deps));
  return app;
}

/**
 * Some CI/test environments may host their `$TMPDIR` under `$HOME`. The
 * "outside-home" tests skip themselves in that case (mirrors the pattern
 * used in `local-folders-config.test.ts`).
 */
function tmpdirIsInsideHome(realOutside: string): boolean {
  const homePrefix = os.homedir().endsWith(path.sep)
    ? os.homedir()
    : os.homedir() + path.sep;
  return realOutside === os.homedir() || realOutside.startsWith(homePrefix);
}

describe('Local folders routes', () => {
  let storage: StorageLayer;
  let fsMonitor: FsMonitorStub;
  let app: express.Express;
  let homeTestDir: string;
  let outsideHomeDir: string;

  beforeEach(() => {
    spawnMocks.spawn.mockClear();
    spawnMocks.child.unref.mockClear();

    storage = createStorage(':memory:');
    storage.initialize();

    fsMonitor = makeFsMonitorStub();
    app = buildApp({
      nodeManager: {} as any,
      db: storage.getDb(),
      filesystemMonitor: fsMonitor as any,
    });

    // A unique tmp dir under $HOME (passes the inside-home guard).
    homeTestDir = fs.mkdtempSync(
      path.join(os.homedir(), '.ppt-test-routes-lf-'),
    );

    // A unique tmp dir under the system tmpdir (fails the inside-home
    // guard on platforms where $TMPDIR is outside $HOME).
    outsideHomeDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'ppt-test-routes-outside-'),
    );
  });

  afterEach(() => {
    storage.close();
    try { fs.rmSync(homeTestDir, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(outsideHomeDir, { recursive: true, force: true }); } catch {}
  });

  // ── POST /api/local-folders ─────────────────────────────────────────────

  describe('POST /api/local-folders', () => {
    // Validates: Requirement 4.2
    it('returns 400 when path is missing from the body', async () => {
      const res = await request(app).post('/api/local-folders').send({});
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/path/);
      expect(fsMonitor.setWatchedFolders).not.toHaveBeenCalled();
      expect(listLocalFolders(storage.getDb())).toHaveLength(0);
    });

    // Validates: Requirement 4.2
    it('returns 400 when include_globs contains a non-string entry', async () => {
      const res = await request(app)
        .post('/api/local-folders')
        .send({ path: homeTestDir, include_globs: ['*.md', 42] });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/include_globs/);
      expect(fsMonitor.setWatchedFolders).not.toHaveBeenCalled();
      expect(listLocalFolders(storage.getDb())).toHaveLength(0);
    });

    // Validates: Requirement 4.2 (duplicate handling)
    it('returns 409 when the same path is added twice', async () => {
      const first = await request(app)
        .post('/api/local-folders')
        .send({ path: homeTestDir });
      expect(first.status).toBe(201);

      fsMonitor.setWatchedFolders.mockClear();

      const second = await request(app)
        .post('/api/local-folders')
        .send({ path: homeTestDir });

      expect(second.status).toBe(409);
      expect(second.body.code).toBe('duplicate');
      // No hot-reload on conflict — DB state is unchanged.
      expect(fsMonitor.setWatchedFolders).not.toHaveBeenCalled();
      expect(listLocalFolders(storage.getDb())).toHaveLength(1);
    });

    // Validates: Requirement 4.2 (success), 4.5 (hot-reload before response), 8.1
    it('responds 201 with the persisted folder and calls setWatchedFolders with the new list before responding', async () => {
      // Snapshot the argument that setWatchedFolders saw when it was called
      // — the route awaits it before sending the response, so this snapshot
      // proves "called BEFORE response".
      let callTimePersisted: any[] | null = null;
      fsMonitor.setWatchedFolders.mockImplementation(async (folders: any[]) => {
        callTimePersisted = folders.map((f) => ({ ...f }));
      });

      const res = await request(app)
        .post('/api/local-folders')
        .send({ path: homeTestDir, recursive: true });

      expect(res.status).toBe(201);
      expect(res.body.folder).toMatchObject({
        path: fs.realpathSync(homeTestDir),
        recursive: true,
        enabled: true,
      });
      expect(typeof res.body.folder.id).toBe('number');

      // Hot-reload was invoked exactly once with the persisted list before
      // the route returned.
      expect(fsMonitor.setWatchedFolders).toHaveBeenCalledTimes(1);
      expect(callTimePersisted).not.toBeNull();
      expect(callTimePersisted).toHaveLength(1);
      expect(callTimePersisted![0].id).toBe(res.body.folder.id);
      expect(callTimePersisted![0].path).toBe(res.body.folder.path);

      // Response body equals what was persisted to the DB.
      const persisted = listLocalFolders(storage.getDb());
      expect(persisted).toHaveLength(1);
      expect(persisted[0]).toEqual(res.body.folder);
    });
  });

  // ── PATCH /api/local-folders/:id ────────────────────────────────────────

  describe('PATCH /api/local-folders/:id', () => {
    let folderId: number;

    beforeEach(async () => {
      const created = await request(app)
        .post('/api/local-folders')
        .send({ path: homeTestDir });
      expect(created.status).toBe(201);
      folderId = created.body.folder.id;
      // Reset call history; preserve the default no-op implementation.
      fsMonitor.setWatchedFolders.mockClear();
    });

    // Validates: Requirement 4.3 (success), 4.5 (hot-reload)
    it('returns 200 and hot-reloads the watcher set on a valid patch', async () => {
      let callTimePersisted: any[] | null = null;
      fsMonitor.setWatchedFolders.mockImplementation(async (folders: any[]) => {
        callTimePersisted = folders.map((f) => ({ ...f }));
      });

      const res = await request(app)
        .patch(`/api/local-folders/${folderId}`)
        .send({ enabled: false });

      expect(res.status).toBe(200);
      expect(res.body.folder.id).toBe(folderId);
      expect(res.body.folder.enabled).toBe(false);

      expect(fsMonitor.setWatchedFolders).toHaveBeenCalledTimes(1);
      expect(callTimePersisted).not.toBeNull();
      expect(callTimePersisted![0].enabled).toBe(false);
    });

    // Validates: Requirement 4.3 (404 missing)
    it('returns 404 for an unknown folder id', async () => {
      const res = await request(app)
        .patch('/api/local-folders/99999')
        .send({ enabled: false });
      expect(res.status).toBe(404);
      expect(fsMonitor.setWatchedFolders).not.toHaveBeenCalled();
    });

    // Validates: Requirement 4.3 (400 invalid)
    it('returns 400 when the patch body is invalid', async () => {
      const res = await request(app)
        .patch(`/api/local-folders/${folderId}`)
        .send({ recursive: 'not-a-boolean' });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/recursive/);
      expect(fsMonitor.setWatchedFolders).not.toHaveBeenCalled();
    });
  });

  // ── DELETE /api/local-folders/:id ───────────────────────────────────────

  describe('DELETE /api/local-folders/:id', () => {
    // Validates: Requirement 4.4 (success), 4.5 (hot-reload)
    it('returns 204 and hot-reloads the watcher set with an empty list on the last delete', async () => {
      const created = await request(app)
        .post('/api/local-folders')
        .send({ path: homeTestDir });
      expect(created.status).toBe(201);
      const id = created.body.folder.id;
      fsMonitor.setWatchedFolders.mockClear();

      let callTimePersisted: any[] | null = null;
      fsMonitor.setWatchedFolders.mockImplementation(async (folders: any[]) => {
        callTimePersisted = folders.map((f) => ({ ...f }));
      });

      const res = await request(app).delete(`/api/local-folders/${id}`);

      expect(res.status).toBe(204);
      // 204 means no body; supertest exposes res.body as {} for empty bodies.
      expect(fsMonitor.setWatchedFolders).toHaveBeenCalledTimes(1);
      expect(callTimePersisted).toEqual([]);
      expect(listLocalFolders(storage.getDb())).toHaveLength(0);
    });

    // Validates: Requirement 4.4 (404 missing)
    it('returns 404 for an unknown folder id', async () => {
      const res = await request(app).delete('/api/local-folders/99999');
      expect(res.status).toBe(404);
      expect(fsMonitor.setWatchedFolders).not.toHaveBeenCalled();
    });
  });

  // ── GET /api/files/open ─────────────────────────────────────────────────

  describe('GET /api/files/open', () => {
    // Validates: Requirements 7.2, 8.1
    it('returns 403 for paths that resolve outside $HOME', async () => {
      const realOutside = fs.realpathSync(outsideHomeDir);
      if (tmpdirIsInsideHome(realOutside)) return;

      const res = await request(app)
        .get('/api/files/open')
        .query({ path: outsideHomeDir });

      expect(res.status).toBe(403);
      expect(spawnMocks.spawn).not.toHaveBeenCalled();
    });

    // Validates: Requirement 7.2 (404)
    it('returns 404 for paths that do not exist', async () => {
      const missing = path.join(homeTestDir, 'no-such-file.md');
      const res = await request(app)
        .get('/api/files/open')
        .query({ path: missing });

      expect(res.status).toBe(404);
      expect(spawnMocks.spawn).not.toHaveBeenCalled();
    });

    // Validates: Requirement 7.2 (success path)
    it('responds 204 and spawns "open <resolved>" detached for files under $HOME', async () => {
      const filePath = path.join(homeTestDir, 'doc.md');
      fs.writeFileSync(filePath, 'hello');
      const realFile = fs.realpathSync(filePath);

      const res = await request(app)
        .get('/api/files/open')
        .query({ path: filePath });

      expect(res.status).toBe(204);
      expect(spawnMocks.spawn).toHaveBeenCalledTimes(1);
      const [cmd, args, opts] = spawnMocks.spawn.mock.calls[0] as [
        string,
        string[],
        any,
      ];
      expect(cmd).toBe('open');
      expect(args).toEqual([realFile]);
      expect(opts).toMatchObject({ detached: true, stdio: 'ignore' });
      expect(spawnMocks.child.unref).toHaveBeenCalledTimes(1);
    });
  });

  // ── GET /api/files/reveal ───────────────────────────────────────────────

  describe('GET /api/files/reveal', () => {
    // Validates: Requirements 7.4, 8.1
    it('returns 403 for paths that resolve outside $HOME', async () => {
      const realOutside = fs.realpathSync(outsideHomeDir);
      if (tmpdirIsInsideHome(realOutside)) return;

      const res = await request(app)
        .get('/api/files/reveal')
        .query({ path: outsideHomeDir });

      expect(res.status).toBe(403);
      expect(spawnMocks.spawn).not.toHaveBeenCalled();
    });

    // Validates: Requirement 7.4 (404)
    it('returns 404 for paths that do not exist', async () => {
      const missing = path.join(homeTestDir, 'no-such-file.md');
      const res = await request(app)
        .get('/api/files/reveal')
        .query({ path: missing });

      expect(res.status).toBe(404);
      expect(spawnMocks.spawn).not.toHaveBeenCalled();
    });

    // Validates: Requirement 7.4 (success path with -R)
    it('responds 204 and spawns "open -R <resolved>" detached for files under $HOME', async () => {
      const filePath = path.join(homeTestDir, 'doc.md');
      fs.writeFileSync(filePath, 'hello');
      const realFile = fs.realpathSync(filePath);

      const res = await request(app)
        .get('/api/files/reveal')
        .query({ path: filePath });

      expect(res.status).toBe(204);
      expect(spawnMocks.spawn).toHaveBeenCalledTimes(1);
      const [cmd, args, opts] = spawnMocks.spawn.mock.calls[0] as [
        string,
        string[],
        any,
      ];
      expect(cmd).toBe('open');
      expect(args).toEqual(['-R', realFile]);
      expect(opts).toMatchObject({ detached: true, stdio: 'ignore' });
      expect(spawnMocks.child.unref).toHaveBeenCalledTimes(1);
    });
  });
});
