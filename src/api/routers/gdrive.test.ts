import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createGdriveRouter, driveFolderIdOf } from './gdrive.js';
import { fakeGmailConnection, type FakeGmailAccount } from '../../core/gmail-connection.fake.js';

describe('Google Drive source routes', () => {
  let account: FakeGmailAccount;
  let app: express.Express;
  let runNow: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    account = { id: 'default', email: 'jane@gmail.com', canReadDrive: true, drive: { enabled: true, sources: { ownedByMe: false, sharedWithMe: false, folderIds: [] } }, client: {} as any };
    runNow = vi.fn().mockResolvedValue([]);
    app = express();
    app.use(express.json());
    app.use('/api', createGdriveRouter({
      nodeManager: {} as any,
      gmailConnection: fakeGmailConnection([account]),
      gdriveSync: { status: () => [{ accountId: 'default' }], runNow } as any,
    }));
  });
  const owner = (body: object) => {
    const req = request(app).put('/api/gdrive/accounts/default/sources');
    const port = new URL(req.url).port;
    return req.set('Origin', `http://127.0.0.1:${port}`).set('Sec-Fetch-Site', 'same-origin').send(body);
  };

  it('rejects a change without the same-origin owner UI', async () => {
    const res = await request(app).put('/api/gdrive/accounts/default/sources').send({ ownedByMe: true });
    expect(res.status).toBe(403);
    expect(account.drive!.sources.ownedByMe).toBe(false);
  });

  it('saves validated sources and accepts folder URLs', async () => {
    const res = await owner({ ownedByMe: true, folders: ['https://drive.google.com/drive/folders/1AbCdEfGhIjKlMnOp?usp=sharing', '1AbCdEfGhIjKlMnOp'] });
    expect(res.status).toBe(200);
    expect(account.drive).toEqual({ enabled: true, sources: { ownedByMe: true, sharedWithMe: false, folderIds: ['1AbCdEfGhIjKlMnOp'] } });
    expect(runNow).toHaveBeenCalledWith('default');
  });

  it('rejects bad input and accounts without the Drive grant', async () => {
    expect((await owner({ ownedByMe: 'yes' })).status).toBe(400);
    expect((await owner({ folders: ['https://evil.example/drive/folders/1AbCdEfGhIjKlMnOp'] })).body.code).toBe('invalid_folder');
    expect((await owner({ extra: 1 })).status).toBe(400);
    account.canReadDrive = false;
    expect((await owner({ ownedByMe: true })).status).toBe(409);
  });

  it('driveFolderIdOf', () => {
    expect(driveFolderIdOf('short')).toBeNull();
    expect(driveFolderIdOf('http://drive.google.com/drive/folders/1AbCdEfGhIjKlMnOp')).toBeNull();
    expect(driveFolderIdOf('https://drive.google.com/drive/u/0/folders/1AbCdEfGhIjKlMnOp')).toBe('1AbCdEfGhIjKlMnOp');
  });
});
