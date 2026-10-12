import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createProductDocumentsRouter } from './product-documents.js';
import { fakeGmailConnection } from '../../core/gmail-connection.fake.js';

describe('publication staging gates (Amazon toggle and Drive connection)', () => {
  const build = (amazon: boolean, canPublishDrive: boolean) => {
    const app = express();
    app.use(express.json());
    app.use('/api', createProductDocumentsRouter({
      nodeManager: {} as any,
      workplace: { amazonEmployee: () => amazon } as any,
      gmailConnection: fakeGmailConnection([{ id: 'default', email: 'jane@gmail.com', canPublishDrive, client: {} as any }]),
    } as any));
    return app;
  };
  const post = (app: express.Express, body: object) => request(app).post('/api/product-documents/a1/publications').send(body);

  it('toggle OFF: SharePoint staging is refused; a Drive destination needs Drive connected', async () => {
    const off = build(false, false);
    expect((await post(off, { action: 'create', format: 'docx', targetFolder: '/x', ownerRequested: true })).body.code).toBe('amazon_employee_off');
    expect((await post(off, { action: 'create', ownerRequested: true, destination: { provider: 'gdrive', accountId: 'default' } })).body.code).toBe('drive_not_connected');
    // Drive connected: the gate passes and the request reaches the publication service (absent here → 503).
    expect((await post(build(false, true), { action: 'create', ownerRequested: true, destination: { provider: 'gdrive', accountId: 'default' } })).status).toBe(503);
  });
});
