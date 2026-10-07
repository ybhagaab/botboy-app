import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createStorage, type StorageLayer } from '../../core/storage.js';
import { createMcpManager } from '../../core/mcp-manager.js';
import type { McpManager } from '../../core/mcp-types.js';
import { createMcpRouter } from './mcp.js';

/**
 * MCP routes (MCP_REMOTE_TRANSPORTS_PLAN.md MR1): every change needs the
 * rendered same-origin owner interface, owner-typed values go to Keychain
 * through one write-only route, and no response carries a secret value.
 */

// Assembled at runtime so secret scanners never see a key-shaped literal.
const OWNER_KEY = ['sk', 'router', 'owner', 'key', '0123456789'].join('-');
const OWNER_TOKEN = ['tok', 'router', 'env', 'value', '9876543210'].join('-');

describe('MCP router', () => {
  let server: http.Server;
  let base: string;
  let port: number;
  let storage: StorageLayer;
  let manager: McpManager;
  const secrets = new Map<string, string>();
  const secretStore = {
    async get(id: string, key: string) { return secrets.get(`${id}:${key}`) ?? null; },
    async set(id: string, key: string, value: string) { secrets.set(`${id}:${key}`, value); },
    async delete(id: string, key: string) { secrets.delete(`${id}:${key}`); },
    async has(id: string, key: string) { return secrets.has(`${id}:${key}`); },
  };

  beforeEach(async () => {
    storage = createStorage(':memory:');
    storage.initialize();
    manager = createMcpManager({ db: storage.getDb(), secretStore, healthIntervalMs: 3_600_000 });
    await manager.start();
    const app = express();
    app.use(express.json());
    app.use('/api', createMcpRouter({ nodeManager: {} as any, mcpManager: manager, db: storage.getDb() }));
    server = http.createServer(app);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
    port = (server.address() as AddressInfo).port;
    base = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    await manager.stop();
    await new Promise<void>(resolve => server.close(() => resolve()));
    storage.close();
    secrets.clear();
  });

  /** A request from the rendered dashboard: same-origin Origin plus Sec-Fetch-Site. */
  function owner(test: request.Test): request.Test {
    return test.set('Origin', base).set('Sec-Fetch-Site', 'same-origin');
  }

  const rowOf = (id: string) => storage.getDb().prepare('SELECT * FROM mcp_servers WHERE id = ?').get(id) as
    { config_json: string; display_name: string; enabled: number } | undefined;

  async function addRemote(): Promise<void> {
    const created = await owner(request(base).post('/api/mcp/servers')).send({
      name: 'Docs',
      url: 'https://docs.example.com/mcp',
      headers: { Authorization: 'Bearer {api_key}' },
    });
    expect(created.status).toBe(201);
  }

  it('refuses every MCP change that does not come from the same-origin owner interface', async () => {
    await addRemote();
    const before = rowOf('custom-docs')!.config_json;
    const routes: Array<[method: 'post' | 'put' | 'delete', path: string, body?: Record<string, unknown>]> = [
      ['post', '/api/mcp/servers', { name: 'Other', url: 'https://other.example.com/mcp' }],
      ['put', '/api/mcp/servers/custom-docs/config', { name: 'Renamed' }],
      ['put', '/api/mcp/servers/custom-docs/secrets', { headers: { Authorization: OWNER_KEY } }],
      ['delete', '/api/mcp/servers/custom-docs'],
      ['post', '/api/mcp/servers/custom-docs/restart', {}],
      ['post', '/api/mcp/servers/custom-docs/tools/create_page', { arguments: {}, ownerRequested: true }],
      ['put', '/api/mcp/sql-context/config', {}],
      ['post', '/api/mcp/sql-context/test', {}],
      ['post', '/api/mcp/profiles/custom-docs/actions/start', {}],
      ['post', '/api/mcp/profiles/custom-docs/terminal', { commandId: 'login' }],
      ['post', '/api/mcp/profiles/custom-docs/terminal/session-1/input', { data: 'y\n' }],
      ['post', '/api/mcp/profiles/custom-docs/terminal/session-1/stop', {}],
      ['post', '/api/mcp/analytics-context', { dir: '/tmp' }],
      ['post', '/api/mcp/analytics-context/generate', {}],
    ];
    const variants: Array<[label: string, headers: Record<string, string>]> = [
      ['no Origin (a native client)', {}],
      ['another site', { Origin: 'http://evil.example', 'Sec-Fetch-Site': 'cross-site' }],
      ['another local port', { Origin: `http://127.0.0.1:${port + 1}`, 'Sec-Fetch-Site': 'same-site' }],
      ['same Origin without a same-origin fetch context', { Origin: base, 'Sec-Fetch-Site': 'cross-site' }],
    ];
    for (const [method, path, body] of routes) {
      for (const [label, headers] of variants) {
        let pending = request(base)[method](path);
        for (const [name, value] of Object.entries(headers)) pending = pending.set(name, value);
        const response = body ? await pending.send(body) : await pending;
        expect(response.status, `${method.toUpperCase()} ${path} from ${label}`).toBe(403);
        // The owner-UI guard refused it, not some later check.
        expect(response.body.error, `${method.toUpperCase()} ${path} from ${label}`).toMatch(/^(MCP connection change|MCP tool call|Analytics knowledge change) /);
      }
    }
    // Nothing changed: one server, the same definition, no value saved.
    expect(storage.getDb().prepare("SELECT COUNT(*) AS n FROM mcp_servers WHERE kind = 'custom'").get()).toEqual({ n: 1 });
    expect(rowOf('custom-docs')!.config_json).toBe(before);
    expect(secrets.size).toBe(0);
  });

  it('keeps an owner-typed key in Keychain and never returns it from any route', async () => {
    await addRemote();
    const created = await owner(request(base).get('/api/mcp/profiles/custom-docs'));
    expect(created.body.profile).toMatchObject({
      custom: true,
      needsReview: false,
      configured: false,
      customDefinition: { transport: 'auto', endpointHost: 'docs.example.com', missingValues: ['header Authorization'] },
    });

    const saved = await owner(request(base).put('/api/mcp/servers/custom-docs/secrets')).send({ headers: { authorization: OWNER_KEY } });
    expect(saved.status).toBe(200);
    expect(saved.headers['cache-control']).toBe('no-store');
    expect(saved.body.config.headers).toEqual([
      { name: 'Authorization', secret: true, required: true, saved: true, template: 'Bearer {value}' },
    ]);
    expect(saved.body.config.missingValues).toEqual([]);
    expect(secrets.get('custom-docs:header-Authorization')).toBe(OWNER_KEY);

    const reads = await Promise.all([
      request(base).get('/api/mcp/servers/custom-docs/config'),
      request(base).get('/api/mcp/profiles/custom-docs'),
      request(base).get('/api/mcp/profiles'),
      request(base).get('/api/mcp/servers'),
    ]);
    for (const response of [saved, ...reads]) {
      expect(response.status).toBe(200);
      expect(JSON.stringify(response.body)).not.toContain(OWNER_KEY);
    }
    expect(rowOf('custom-docs')!.config_json).not.toContain(OWNER_KEY);
    expect(reads[1].body.profile).toMatchObject({ configured: true, customDefinition: { missingValues: [] } });

    // An empty value clears the key, and Start waits for it again.
    const cleared = await owner(request(base).put('/api/mcp/servers/custom-docs/secrets')).send({ headers: { Authorization: '' } });
    expect(cleared.body.config.headers[0]).toMatchObject({ saved: false });
    expect(cleared.body.config.missingValues).toEqual(['header Authorization']);
    expect(secrets.has('custom-docs:header-Authorization')).toBe(false);
  });

  it('shows non-secret values to the owner and BotBoy, and secret ones to nobody', async () => {
    const created = await owner(request(base).post('/api/mcp/servers')).send({
      name: 'Local tool',
      command: 'node',
      args: ['server.js'],
      env: { LOG_LEVEL: 'debug', API_TOKEN: OWNER_TOKEN },
    });
    expect(created.status).toBe(201);
    expect(JSON.stringify(created.body)).not.toContain(OWNER_TOKEN);
    const config = await request(base).get('/api/mcp/servers/custom-local-tool/config');
    expect(config.body.config).toMatchObject({
      transport: 'stdio',
      command: 'node',
      args: ['server.js'],
      origin: 'user',
      reviewed: true,
      env: [
        { name: 'LOG_LEVEL', secret: false, saved: true, value: 'debug' },
        { name: 'API_TOKEN', secret: true, saved: true },
      ],
    });
    expect(config.body.config.env[1]).not.toHaveProperty('value');
    expect(JSON.stringify(config.body)).not.toContain(OWNER_TOKEN);
    expect(rowOf('custom-local-tool')!.config_json).not.toContain(OWNER_TOKEN);
    expect(rowOf('custom-local-tool')!.config_json).not.toContain('debug');
    expect(secrets.get('custom-local-tool:env-API_TOKEN')).toBe(OWNER_TOKEN);
  });

  it('accepts only env and headers maps on the secrets route, and names the entry rather than echoing a value', async () => {
    await addRemote();
    const put = (path: string, body: unknown) => owner(request(base).put(path)).send(body as object);

    const extra = await put('/api/mcp/servers/custom-docs/secrets', { headers: { Authorization: OWNER_KEY }, url: 'https://evil.example/mcp' });
    expect(extra.status).toBe(400);
    expect(extra.body.error).toMatch(/only env and headers/);

    const unknownName = await put('/api/mcp/servers/custom-docs/secrets', { headers: { 'X-Other': OWNER_KEY } });
    expect(unknownName.status).toBe(400);
    expect(unknownName.body.error).toMatch(/no header named X-Other/);
    expect(JSON.stringify(unknownName.body)).not.toContain(OWNER_KEY);

    const notText = await put('/api/mcp/servers/custom-docs/secrets', { headers: { Authorization: 5 } });
    expect(notText.status).toBe(400);
    expect(notText.body.error).toMatch(/must be a string/);

    const twoLines = await put('/api/mcp/servers/custom-docs/secrets', { headers: { Authorization: `${OWNER_KEY}\r\nX-Injected: 1` } });
    expect(twoLines.status).toBe(400);
    expect(JSON.stringify(twoLines.body)).not.toContain(OWNER_KEY);

    expect((await put('/api/mcp/servers/sql-context/secrets', { env: {} })).status).toBe(403);
    expect((await put('/api/mcp/servers/custom-missing/secrets', { env: {} })).status).toBe(404);
    const text = await owner(request(base).put('/api/mcp/servers/custom-docs/secrets'))
      .set('Content-Type', 'text/plain').send('Authorization=abc');
    expect(text.status).toBe(415);
    expect(secrets.size).toBe(0);
  });

  it('treats Start on an assistant-written server as the review, and reports a missing key as the owner\'s next step', async () => {
    await manager.createCustomServer(
      { name: 'Keyed', url: 'https://keyed.example.com/mcp', headers: { 'X-Api-Key': '' } },
      { origin: 'assistant' },
    );
    expect((await request(base).get('/api/mcp/profiles/custom-keyed')).body.profile.needsReview).toBe(true);
    const start = await owner(request(base).post('/api/mcp/profiles/custom-keyed/actions/start')).send({});
    expect(start.status).toBe(409);
    expect(start.body.error).toMatch(/^Waiting for header X-Api-Key/);
    const after = (await request(base).get('/api/mcp/profiles/custom-keyed')).body.profile;
    expect(after).toMatchObject({ needsReview: false, enabled: false, state: 'needs_configuration' });
  });

  it('refuses edits and deletes of built-in profiles', async () => {
    expect((await owner(request(base).put('/api/mcp/servers/slack/config')).send({ name: 'x' })).status).toBe(403);
    expect((await owner(request(base).delete('/api/mcp/servers/slack'))).status).toBe(403);
  });
});
