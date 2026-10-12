import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createStorage, type StorageLayer } from '../../core/storage.js';
import { createWorkplace, type Workplace } from '../../core/workplace.js';
import { createExportFooterSettings, type ExportFooterSettings } from '../../product-manager/export-footer.js';
import { createWorkplaceRouter, requireAmazonEmployee } from './workplace.js';
import { createDashboardRouter, createDashboardState } from './dashboard.js';

/** Settings → Workplace API (design §6.5, §16 item 2). */
describe('workplace router', () => {
  let storage: StorageLayer;
  let server: http.Server;
  let origin: string;
  let workplace: Workplace;
  let footer: ExportFooterSettings;
  const hidden = new Set(['slack']);
  const mcpManager = {
    listProfiles: vi.fn(async () => [
      { id: 'sql-context', displayName: 'SQL', enabled: true },
      { id: 'slack', displayName: 'Slack', enabled: true, lastStartedAt: '2026-10-01' },
    ]),
    isHiddenByWorkplace: (id: string) => !workplace.amazonEmployee() && hidden.has(id),
  };

  beforeEach(async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    storage = createStorage(':memory:');
    storage.initialize();
    workplace = createWorkplace({ db: storage.getDb(), env: {}, detect: () => ['midway_cookie'] });
    footer = createExportFooterSettings({ db: storage.getDb(), amazonEmployee: () => workplace.amazonEmployee() });
    const app = express();
    app.use(express.json());
    app.use('/api', createWorkplaceRouter({ nodeManager: {} as any, workplace, exportFooter: footer, mcpManager: mcpManager as any }));
    server = http.createServer(app);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => {
      origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      resolve();
    }));
  });
  afterEach(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    storage.close();
    vi.restoreAllMocks();
  });
  const ownerPut = (path: string, body: unknown) => request(server).put(path).set('Origin', origin).set('Sec-Fetch-Site', 'same-origin').send(body as object);

  it('serves status without caching and without secrets', async () => {
    const response = await request(server).get('/api/settings/workplace');
    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body).toMatchObject({
      amazonEmployee: true, source: 'detected', signals: ['midway_cookie'], hiddenConnections: [],
      exportFooter: { text: '', source: 'default' }, appliesWithoutRestart: true,
    });
  });

  it('changes the toggle only from the same-origin owner page', async () => {
    expect((await request(server).put('/api/settings/workplace').send({ amazonEmployee: false })).status).toBe(403);
    const crossSite = await request(server).put('/api/settings/workplace').set('Origin', origin).set('Sec-Fetch-Site', 'cross-site').send({ amazonEmployee: false });
    expect(crossSite.status).toBe(403);
    expect(workplace.amazonEmployee()).toBe(true);
    const saved = await ownerPut('/api/settings/workplace', { amazonEmployee: false });
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ amazonEmployee: false, source: 'owner', version: 1 });
    expect(saved.body.hiddenConnections).toEqual([{ id: 'slack', displayName: 'Slack', setUp: true }]);
  });

  it('rejects extra keys and non-boolean values', async () => {
    for (const body of [{ amazonEmployee: 'no' }, { amazonEmployee: false, extra: 1 }, {}, [true]]) {
      const response = await ownerPut('/api/settings/workplace', body);
      expect(response.status).toBe(400);
      expect(response.body.code).toBe('invalid_request');
    }
  });

  it('validates the export footer', async () => {
    for (const text of ['x'.repeat(121), 'two\nlines', 'bell\u0007', 42]) {
      const response = await ownerPut('/api/settings/workplace/export-footer', { text });
      expect(response.status).toBe(400);
      expect(response.body).toMatchObject({ code: 'invalid_footer', nextAction: expect.any(String) });
    }
    expect((await ownerPut('/api/settings/workplace/export-footer', { text: 'Internal draft', more: 1 })).status).toBe(400);
    const blank = await ownerPut('/api/settings/workplace/export-footer', { text: '' });
    expect(blank.status).toBe(200);
    expect(blank.body.exportFooter).toMatchObject({ text: '', source: 'owner' });
    const set = await ownerPut('/api/settings/workplace/export-footer', { text: '  Internal draft  ' });
    expect(set.body.exportFooter).toMatchObject({ text: 'Internal draft', source: 'owner', setBy: 'settings' });
    expect((await request(server).put('/api/settings/workplace/export-footer').send({ text: 'x' })).status).toBe(403);
  });

  it('requireAmazonEmployee answers 409 with a next action while off', async () => {
    const res = { status: vi.fn(() => res), json: vi.fn(() => res) } as any;
    expect(requireAmazonEmployee({ workplace }, res)).toBe(true);
    await workplace.setAmazonEmployee(false);
    expect(requireAmazonEmployee({ workplace }, res)).toBe(false);
    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith({
      error: "This is part of BotBoy's Amazon internal paths, which are off.",
      code: 'amazon_employee_off',
      nextAction: 'Turn on Amazon Employee in Settings → Workplace.',
    });
    expect(requireAmazonEmployee({}, res)).toBe(true);
  });

  it('/dashboard/version carries flat workplace fields; a throwing getter only omits them', async () => {
    const versionApp = (getter?: () => { version: number; amazonEmployee: boolean }) => {
      const app = express();
      app.use('/api', createDashboardRouter(createDashboardState(), undefined, undefined, undefined, undefined, getter));
      return app;
    };
    const ok = await request(versionApp(() => ({ version: 3, amazonEmployee: false }))).get('/api/dashboard/version');
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ workplaceVersion: 3, amazonEmployee: false });
    const broken = await request(versionApp(() => { throw new Error('x'); })).get('/api/dashboard/version');
    expect(broken.status).toBe(200);
    expect(broken.body.workplaceVersion).toBeUndefined();
    expect(broken.body.amazonEmployee).toBeUndefined();
  });
});
