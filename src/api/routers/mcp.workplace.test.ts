import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createStorage, type StorageLayer } from '../../core/storage.js';
import { createMcpManager } from '../../core/mcp-manager.js';
import type { McpManager } from '../../core/mcp-types.js';
import { createWorkplace, type Workplace } from '../../core/workplace.js';
import { createMcpRouter } from './mcp.js';
import { createAnalyticsRouter } from './analytics.js';
import { createProductDocumentsRouter } from './product-documents.js';

/** MCP, Harmony, and SharePoint-staging routes while Amazon Employee is off (§7.1, §7.2, §23.4). */
describe('routes hidden by Amazon Employee', () => {
  let server: http.Server;
  let base: string;
  let storage: StorageLayer;
  let manager: McpManager;
  let workplace: Workplace;
  const secretStore = { async get() { return null; }, async set() {}, async delete() {}, async has() { return false; } };
  beforeEach(async () => {
    storage = createStorage(':memory:');
    storage.initialize();
    const quiet = console.log;
    console.log = () => {};
    workplace = createWorkplace({ db: storage.getDb(), env: {}, detect: () => ['midway_cookie'] });
    console.log = quiet;
    manager = createMcpManager({ db: storage.getDb(), secretStore: secretStore as any, healthIntervalMs: 3_600_000, amazonEmployee: () => workplace.amazonEmployee() });
    await manager.start();
    await manager.createCustomServer({ name: 'Aim Tool', command: 'aim', args: ['mcp', 'start-server', 'x'] });
    await workplace.setAmazonEmployee(false);
    const deps = { nodeManager: {} as any, mcpManager: manager, db: storage.getDb(), workplace };
    const app = express();
    app.use(express.json());
    app.use('/api', createMcpRouter(deps));
    app.use('/api', createAnalyticsRouter(deps as any));
    app.use('/api', createProductDocumentsRouter(deps as any));
    server = http.createServer(app);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(async () => {
    await manager.stop();
    await new Promise<void>(resolve => server.close(() => resolve()));
    storage.close();
  });
  const owner = (test: request.Test) => test.set('Origin', base).set('Sec-Fetch-Site', 'same-origin');

  it('answers 409 amazon_employee_off for hidden profile and custom-server routes; DELETE stays allowed', async () => {
    const calls: Array<[string, request.Test]> = [
      ['GET profile', request(server).get('/api/mcp/profiles/slack')],
      ['POST action', owner(request(server).post('/api/mcp/profiles/slack/actions/start')).send({})],
      ['POST terminal', owner(request(server).post('/api/mcp/profiles/grasp-m365/terminal')).send({ commandId: 'mwinit' })],
      ['GET config', request(server).get('/api/mcp/servers/custom-aim-tool/config')],
      ['PUT config', owner(request(server).put('/api/mcp/servers/custom-aim-tool/config')).send({ name: 'Aim Tool', command: 'aim' })],
      ['PUT secrets', owner(request(server).put('/api/mcp/servers/custom-aim-tool/secrets')).send({ env: {} })],
      ['POST tool', owner(request(server).post('/api/mcp/servers/custom-aim-tool/tools/x')).send({ arguments: {} })],
      ['POST restart', owner(request(server).post('/api/mcp/servers/custom-aim-tool/restart')).send({})],
      ['POST generate', owner(request(server).post('/api/mcp/analytics-context/generate')).send({})],
      ['PUT publisher', owner(request(server).put('/api/analytics/publisher')).send({})],
      ['POST share-request', owner(request(server).post('/api/analytics/dashboards/d1/share-request')).send({})],
      ['POST publish', owner(request(server).post('/api/analytics/dashboards/d1/publish')).send({})],
      ['POST publications', owner(request(server).post('/api/product-documents/a1/publications')).send({})],
    ];
    for (const [label, call] of calls) {
      const response = await call;
      expect(response.status, label).toBe(409);
      expect(response.body.code, label).toBe('amazon_employee_off');
    }
    const listed = await request(server).get('/api/mcp/profiles');
    expect(listed.body.profiles.map((profile: any) => profile.id)).not.toContain('slack');
    const deleted = await owner(request(server).delete('/api/mcp/servers/custom-aim-tool'));
    expect(deleted.status).toBe(200);
  });

  it('refuses adding an AIM install while off with 409 and writes no row', async () => {
    const response = await owner(request(server).post('/api/mcp/servers')).send({ name: 'New Aim', command: 'aim', args: [] });
    expect(response.status).toBe(409);
    expect(storage.getDb().prepare("SELECT 1 FROM mcp_servers WHERE id = 'custom-new-aim'").get()).toBeUndefined();
  });
});
