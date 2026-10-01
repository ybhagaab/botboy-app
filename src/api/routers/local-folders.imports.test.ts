import http from 'node:http';
import type { AddressInfo } from 'node:net';
import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createStorage, type StorageLayer } from '../../core/storage.js';
import { addLocalFolder } from '../../core/local-folders-config.js';
import type { FolderImportScheduler, FolderImportStatus } from '../../monitors/folder-import-scheduler.js';
import type { StorageUsageService } from '../../core/storage-usage.js';
import { createLocalFoldersRouter } from './local-folders.js';

/**
 * Local folders import API (LOCAL_FOLDER_IMPORT_SAFETY_PLAN.md P1/P3):
 * status and storage are local reads; the big-file decision is a
 * same-origin owner-UI action; a manual backfill never races a scheduled
 * import; folder CRUD keeps the scheduler informed.
 */

const STATUS = { started: true, firstPassAt: 1, folders: [] } as unknown as FolderImportStatus;

function fakeScheduler(overrides: Partial<FolderImportScheduler> = {}): FolderImportScheduler {
  return {
    start: vi.fn(), stop: vi.fn(), drain: vi.fn(async () => {}),
    kick: vi.fn(), folderChanged: vi.fn(), forgetFolder: vi.fn(),
    isFolderBusy: vi.fn(() => false),
    status: vi.fn(() => STATUS),
    review: vi.fn(() => ({ folderId: 1, root: '/r', bigFileBytes: 1, maxFileBytes: 2, undecided: 0, files: [], tooLarge: [], excludedDirs: [] })),
    decide: vi.fn(async () => ({ ok: true as const, applied: { kept: 1, excluded: 0, excludedDirs: 0, restoredDirs: 0 }, review: {} as any })),
    ...overrides,
  };
}

describe('local folders import routes', () => {
  let storage: StorageLayer;
  let server: http.Server;
  let origin: string;
  let scheduler: FolderImportScheduler;
  let storageUsage: StorageUsageService;
  let monitor: any;
  let dir: string;

  async function listen(deps: Record<string, unknown>): Promise<void> {
    const app = express();
    app.use(express.json());
    app.use('/api', createLocalFoldersRouter({ nodeManager: {} as any, ...deps } as any));
    server = http.createServer(app);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  beforeEach(async () => {
    storage = createStorage(':memory:');
    storage.initialize();
    dir = fs.mkdtempSync(path.join(os.homedir(), '.ppt-test-routes-'));
    scheduler = fakeScheduler();
    storageUsage = { get: vi.fn(async () => ({ categories: [], botboyBytes: 0 } as any)) };
    monitor = {
      start: vi.fn(), stop: vi.fn(), onWorkItem: vi.fn(),
      setWatchedFolders: vi.fn(async () => {}), getWatchedFolders: vi.fn(() => []),
      backfill: vi.fn(async () => ({ aborted: false, total: 0 })),
    };
    await listen({ db: storage.getDb(), filesystemMonitor: monitor, folderImports: scheduler, storageUsage });
  });

  afterEach(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    fs.rmSync(dir, { recursive: true, force: true });
    storage.close();
  });

  const ownerPost = (url: string, body: unknown) => request(server).post(url)
    .set('Origin', origin).set('Sec-Fetch-Site', 'same-origin').send(body as object);

  it('serves import status and storage, forwarding an explicit refresh', async () => {
    const status = await request(server).get('/api/local-folders/imports');
    expect(status.status).toBe(200);
    expect(status.body).toEqual(STATUS);
    await request(server).get('/api/local-folders/storage');
    await request(server).get('/api/local-folders/storage?refresh=1');
    expect(storageUsage.get).toHaveBeenNthCalledWith(1, { refresh: false });
    expect(storageUsage.get).toHaveBeenNthCalledWith(2, { refresh: true });
  });

  it('returns a review, 404 for an unknown folder, and 400 for a malformed id', async () => {
    expect((await request(server).get('/api/local-folders/1/review')).body.review).toMatchObject({ folderId: 1 });
    (scheduler.review as any).mockReturnValueOnce(null);
    expect((await request(server).get('/api/local-folders/2/review')).status).toBe(404);
    expect((await request(server).get('/api/local-folders/abc/review')).status).toBe(400);
  });

  it('accepts a big-file decision only from the same-origin owner UI', async () => {
    const body = { keep: ['/r/a.csv'] };
    const native = await request(server).post('/api/local-folders/1/review').send(body);
    expect(native.status).toBe(403);
    expect(native.body).toMatchObject({ code: 'owner_action_required', nextAction: expect.stringContaining('Local folders') });
    const crossSite = await request(server).post('/api/local-folders/1/review')
      .set('Origin', origin).set('Sec-Fetch-Site', 'cross-site').send(body);
    expect(crossSite.status).toBe(403);
    const foreign = await request(server).post('/api/local-folders/1/review')
      .set('Origin', 'https://evil.example').set('Sec-Fetch-Site', 'same-origin').send(body);
    expect(foreign.status).toBe(403);
    expect(scheduler.decide).not.toHaveBeenCalled();

    const owner = await ownerPost('/api/local-folders/1/review', body);
    expect(owner.status).toBe(200);
    expect(scheduler.decide).toHaveBeenCalledWith(1, { keep: ['/r/a.csv'] });
  });

  it('rejects malformed decisions before the scheduler and maps decision failures', async () => {
    for (const bad of [[], { keep: 'x' }, { keep: [1] }, { approve: [] }]) {
      const res = await ownerPost('/api/local-folders/1/review', bad);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('invalid_decision');
    }
    expect(scheduler.decide).not.toHaveBeenCalled();
    (scheduler.decide as any).mockResolvedValueOnce({
      ok: false, status: 400, code: 'invalid_decision', error: '1 entry could not be applied; nothing was changed.',
      invalid: [{ path: '/etc/passwd', reason: 'is not a file inside this folder' }], nextAction: 'Reload the big-file list and choose again.',
    });
    const res = await ownerPost('/api/local-folders/1/review', { keep: ['/etc/passwd'] });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ invalid: [{ path: '/etc/passwd' }], nextAction: expect.stringContaining('Reload') });
  });

  it('refuses a manual backfill while a scheduled import owns the folder', async () => {
    const added = addLocalFolder(storage.getDb(), { path: dir });
    if (!added.ok) throw new Error(added.message);
    (scheduler.isFolderBusy as any).mockReturnValue(true);
    const res = await request(server).post(`/api/local-folders/${added.folder.id}/backfill`);
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'import_running', nextAction: expect.stringContaining('resume') });
    expect(monitor.backfill).not.toHaveBeenCalled();
  });

  it('keeps the scheduler informed on add, patch, and delete', async () => {
    const created = await request(server).post('/api/local-folders').send({ path: dir });
    expect(created.status).toBe(201);
    expect(scheduler.kick).toHaveBeenCalledTimes(1);
    const id = created.body.folder.id;
    expect((await request(server).patch(`/api/local-folders/${id}`).send({ enabled: false })).status).toBe(200);
    expect(scheduler.folderChanged).toHaveBeenCalledWith(id);
    expect((await request(server).delete(`/api/local-folders/${id}`)).status).toBe(204);
    expect(scheduler.forgetFolder).toHaveBeenCalledWith(id);
  });

  it('reports 503 with a next action when imports are not wired', async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await listen({ db: storage.getDb() });
    for (const url of ['/api/local-folders/imports', '/api/local-folders/storage', '/api/local-folders/1/review']) {
      const res = await request(server).get(url);
      expect(res.status).toBe(503);
      expect(res.body.nextAction).toBeTruthy();
    }
  });
});
