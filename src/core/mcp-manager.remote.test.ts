import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createStorage, type StorageLayer } from './storage.js';
import { createMcpManager } from './mcp-manager.js';
import type { McpManager } from './mcp-types.js';

/**
 * Remote MCP servers end to end (MCP_REMOTE_TRANSPORTS_PLAN.md MR1): the real
 * manager and SDK client talk to the SDK's own server transports over real
 * HTTP on 127.0.0.1. Each test drives one owner-visible outcome.
 */

interface FakeOptions {
  /** Streamable HTTP answers JSON instead of SSE. */
  json?: boolean;
  /** Required `Authorization` header value. */
  authorization?: string;
  bigResponseChars?: number;
}

interface FakeServer {
  base: string;
  port: number;
  requests: Array<{ method: string; path: string; authorization?: string }>;
  calls: string[];
  forgetSessions(): void;
  holdDeletes: boolean;
  close(): Promise<void>;
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function toolServer(label: string, calls: string[], bigChars: number): Server {
  const server = new Server({ name: `fake-${label}`, version: '1.0.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      { name: 'search_docs', description: 'Search the docs', inputSchema: { type: 'object', properties: { q: { type: 'string' } } } },
      { name: 'create_page', description: 'Create a page', inputSchema: { type: 'object', properties: {} } },
      { name: 'read_big', description: 'A large answer', inputSchema: { type: 'object', properties: {} } },
    ],
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    calls.push(request.params.name);
    const text = request.params.name === 'read_big'
      ? 'x'.repeat(bigChars)
      : `${label}:${request.params.name}:${JSON.stringify(request.params.arguments ?? {})}`;
    return { content: [{ type: 'text', text }] };
  });
  return server;
}

async function startFake(options: FakeOptions = {}): Promise<FakeServer> {
  const sessions = new Map<string, StreamableHTTPServerTransport>();
  const sseSessions = new Map<string, SSEServerTransport>();
  const requests: FakeServer['requests'] = [];
  const calls: string[] = [];
  const held: http.ServerResponse[] = [];
  const fake = { holdDeletes: false } as FakeServer;
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    requests.push({ method: req.method ?? '', path: url.pathname, authorization: req.headers.authorization });
    if (options.authorization && req.headers.authorization !== options.authorization) {
      res.writeHead(401, { 'content-type': 'text/plain' }).end('unauthorized');
      return;
    }
    try {
      if (url.pathname === '/mcp' || url.pathname === '/mcp/') {
        if (req.method === 'DELETE' && fake.holdDeletes) { held.push(res); return; }
        const raw = req.method === 'POST' ? await readBody(req) : '';
        const body = raw ? JSON.parse(raw) : undefined;
        const sessionId = req.headers['mcp-session-id'];
        let transport = typeof sessionId === 'string' ? sessions.get(sessionId) : undefined;
        if (!transport) {
          if (sessionId) {
            res.writeHead(404, { 'content-type': 'application/json' })
              .end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32001, message: 'Session not found' }, id: null }));
            return;
          }
          const created: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            enableJsonResponse: options.json === true,
            onsessioninitialized: (id) => { sessions.set(id, created); },
          });
          transport = created;
          await toolServer('http', calls, options.bigResponseChars ?? 10).connect(transport);
        }
        await transport.handleRequest(req, res, body);
        return;
      }
      if (url.pathname === '/sse' && req.method === 'GET') {
        const transport = new SSEServerTransport('/messages', res);
        sseSessions.set(transport.sessionId, transport);
        res.on('close', () => sseSessions.delete(transport.sessionId));
        await toolServer('sse', calls, options.bigResponseChars ?? 10).connect(transport);
        return;
      }
      if (url.pathname === '/sse') {
        // A legacy server refuses the Streamable HTTP POST.
        res.writeHead(405, { allow: 'GET' }).end();
        return;
      }
      if (url.pathname === '/messages' && req.method === 'POST') {
        const transport = sseSessions.get(url.searchParams.get('sessionId') ?? '');
        if (!transport) { res.writeHead(404).end(); return; }
        await transport.handlePostMessage(req, res, JSON.parse(await readBody(req)));
        return;
      }
      if (url.pathname === '/moved') {
        res.writeHead(307, { location: `http://localhost:${(server.address() as AddressInfo).port}/mcp` }).end();
        return;
      }
      res.writeHead(404).end();
    } catch (error) {
      if (!res.headersSent) res.writeHead(500).end(String(error));
    }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  Object.assign(fake, {
    base: `http://127.0.0.1:${port}`,
    port,
    requests,
    calls,
    forgetSessions: () => sessions.clear(),
    close: async () => {
      for (const res of held) res.destroy();
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  });
  return fake;
}

describe('remote MCP servers', () => {
  let storage: StorageLayer | null = null;
  let manager: McpManager | null = null;
  const fakes: FakeServer[] = [];
  const secrets = new Map<string, string>();
  const secretStore = {
    async get(id: string, key: string) { return secrets.get(`${id}:${key}`) ?? null; },
    async set(id: string, key: string, value: string) { secrets.set(`${id}:${key}`, value); },
    async delete(id: string, key: string) { secrets.delete(`${id}:${key}`); },
    async has(id: string, key: string) { return secrets.has(`${id}:${key}`); },
  };

  async function setup(extra: Partial<Parameters<typeof createMcpManager>[0]> = {}): Promise<McpManager> {
    storage = createStorage(':memory:');
    storage.initialize();
    manager = createMcpManager({ db: storage.getDb(), secretStore, healthIntervalMs: 3_600_000, ...extra });
    await manager.start();
    return manager;
  }
  async function fake(options?: FakeOptions): Promise<FakeServer> {
    const created = await startFake(options);
    fakes.push(created);
    return created;
  }
  const rowOf = (id: string) => storage!.getDb().prepare('SELECT * FROM mcp_servers WHERE id = ?').get(id) as {
    state: string; enabled: number; last_error: string | null; pid: number | null; config_json: string; tools_json: string;
  };

  afterEach(async () => {
    await manager?.stop();
    manager = null;
    storage?.close();
    storage = null;
    secrets.clear();
    for (const created of fakes.splice(0)) await created.close();
  });

  for (const json of [false, true]) {
    it(`connects a Streamable HTTP server by URL and calls its tools (${json ? 'JSON' : 'SSE'} answers)`, { timeout: 30_000 }, async () => {
      const server = await fake({ json });
      const mcp = await setup();
      const created = await mcp.createCustomServer({ name: 'Docs', url: `${server.base}/mcp` });
      expect(created).toMatchObject({ id: 'custom-docs', needsReview: false, installationState: 'installed', custom: { transport: 'auto', endpointHost: `127.0.0.1:${server.port}` } });
      const started = await mcp.startProfile('custom-docs');
      expect(started.state).toBe('running');
      expect(started.tools.map(tool => [tool.name, tool.risk])).toEqual([['search_docs', 'read'], ['create_page', 'write'], ['read_big', 'read']]);
      const result = await mcp.callTool('custom-docs', 'search_docs', { q: 'mcp' });
      expect(result).toMatchObject({ isError: false, text: 'http:search_docs:{"q":"mcp"}' });
      const row = rowOf('custom-docs');
      expect(row.pid).toBeNull();
      expect(JSON.parse(row.config_json).detectedTransport).toBe('http');
    });
  }

  it('falls back to legacy SSE when the endpoint refuses the Streamable HTTP initialize, and tries SSE first next time', { timeout: 30_000 }, async () => {
    const server = await fake();
    const mcp = await setup();
    await mcp.createCustomServer({ name: 'Legacy', url: `${server.base}/sse` });
    expect((await mcp.startProfile('custom-legacy')).state).toBe('running');
    expect(JSON.parse(rowOf('custom-legacy').config_json).detectedTransport).toBe('sse');
    expect((await mcp.callTool('custom-legacy', 'search_docs', {})).text).toBe('sse:search_docs:{}');
    await mcp.stopProfile('custom-legacy');
    const postsBefore = server.requests.filter(request => request.method === 'POST' && request.path === '/sse').length;
    expect(postsBefore).toBe(1);
    expect((await mcp.startProfile('custom-legacy')).state).toBe('running');
    expect(server.requests.filter(request => request.method === 'POST' && request.path === '/sse').length).toBe(postsBefore);
  });

  it('waits for the owner\'s key, pauses on a refused key, and connects with the saved one sent only as a header', { timeout: 30_000 }, async () => {
    const server = await fake({ authorization: 'Bearer good', json: true });
    const mcp = await setup();
    const created = await mcp.createCustomServer(
      { name: 'Keyed', url: `${server.base}/mcp`, headers: { Authorization: 'Bearer {api_key}' } },
      { origin: 'assistant' },
    );
    expect(created).toMatchObject({ needsReview: true, configured: false, custom: { missingValues: ['header Authorization'] } });
    await expect(mcp.startProfile('custom-keyed')).rejects.toThrow(/needs the owner's review/);
    await mcp.approveCustomServer('custom-keyed');
    await expect(mcp.startProfile('custom-keyed')).rejects.toThrow(/Waiting for header Authorization/);
    expect(rowOf('custom-keyed')).toMatchObject({ enabled: 0, state: 'needs_configuration' });
    expect(server.requests).toHaveLength(0);

    const saved = await mcp.setCustomServerValues('custom-keyed', { headers: { Authorization: 'wrong' } });
    expect(saved.headers).toEqual([{ name: 'Authorization', secret: true, required: true, saved: true, template: 'Bearer {value}' }]);
    expect(rowOf('custom-keyed')).toMatchObject({ state: 'stopped', last_error: null });
    await expect(mcp.startProfile('custom-keyed')).rejects.toThrow(/refused BotBoy's credentials \(HTTP 401\)/);
    expect(rowOf('custom-keyed')).toMatchObject({ enabled: 0, state: 'needs_configuration' });

    await mcp.setCustomServerValues('custom-keyed', { headers: { Authorization: 'good' } });
    expect((await mcp.startProfile('custom-keyed')).state).toBe('running');
    expect(server.requests.at(-1)?.authorization).toBe('Bearer good');
    // The value is in Keychain only, never in the row or the view.
    expect(secrets.get('custom-keyed:header-Authorization')).toBe('good');
    expect(rowOf('custom-keyed').config_json).not.toContain('good');
    expect(JSON.stringify(await mcp.getCustomServerConfig('custom-keyed'))).not.toContain('good');
  });

  it('refuses BotBoy\'s own port and cross-origin redirects before any MCP traffic', { timeout: 30_000 }, async () => {
    const server = await fake();
    const mcp = await setup({ remotePolicy: { appPort: server.port, cdpPort: 9222 } });
    await mcp.createCustomServer({ name: 'Own port', url: `${server.base}/mcp` });
    await expect(mcp.startProfile('custom-own-port')).rejects.toThrow(/BotBoy's own app/);
    expect(server.requests).toHaveLength(0);
    expect(rowOf('custom-own-port')).toMatchObject({ enabled: 0, state: 'needs_configuration' });

    const target = await fake();
    await manager!.stop();
    storage!.close();
    manager = null;
    const plain = await setup();
    await plain.createCustomServer({ name: 'Moved', url: `${target.base}/moved`, type: 'http' });
    await expect(plain.startProfile('custom-moved')).rejects.toThrow(/redirected BotBoy to localhost/);
    expect(target.requests.map(request => request.path)).toEqual(['/moved']);
  });

  it('fails one oversized answer and keeps the connection for the next call', { timeout: 30_000 }, async () => {
    const server = await fake({ json: true, bigResponseChars: 300_000 });
    const mcp = await setup({ remoteMaxResponseBytes: 100_000 });
    await mcp.createCustomServer({ name: 'Big', url: `${server.base}/mcp` });
    await mcp.startProfile('custom-big');
    await expect(mcp.callTool('custom-big', 'read_big', {}, { timeoutMs: 10_000 })).rejects.toThrow(/more than BotBoy accepts/);
    expect((await mcp.callTool('custom-big', 'search_docs', {})).isError).toBe(false);
    expect(rowOf('custom-big').state).toBe('running');
  });

  it('reconnects when the server forgot the session: a read runs once more, a write is never re-sent', { timeout: 30_000 }, async () => {
    const server = await fake({ json: true });
    const mcp = await setup();
    await mcp.createCustomServer({ name: 'Forgetful', url: `${server.base}/mcp` });
    await mcp.startProfile('custom-forgetful');
    server.forgetSessions();
    expect((await mcp.callTool('custom-forgetful', 'search_docs', { q: 'a' })).text).toBe('http:search_docs:{"q":"a"}');
    server.forgetSessions();
    await expect(mcp.callTool('custom-forgetful', 'create_page', {}, { ownerApproved: true }))
      .rejects.toThrow(/had ended BotBoy's session, so it did not run create_page\. Nothing changed/);
    expect(server.calls).toEqual(['search_docs']);
  });

  it('reconnects when a health check finds the session gone, instead of pausing the server (live 2026-10-07)', { timeout: 30_000 }, async () => {
    const server = await fake({ json: true });
    const mcp = await setup({ healthIntervalMs: 50 });
    await mcp.createCustomServer({ name: 'Docs', url: `${server.base}/mcp` });
    expect((await mcp.startProfile('custom-docs')).state).toBe('running');
    // The server restarted and lost every session.
    server.forgetSessions();
    await new Promise(resolve => setTimeout(resolve, 500));
    expect(rowOf('custom-docs')).toMatchObject({ enabled: 1, state: 'running', last_error: null });
    expect((await mcp.callTool('custom-docs', 'search_docs', { q: 'again' })).text).toBe('http:search_docs:{"q":"again"}');
  });

  it('tests a server that forgot the session on a new one', { timeout: 30_000 }, async () => {
    const server = await fake();
    const mcp = await setup();
    await mcp.createCustomServer({ name: 'Docs', url: `${server.base}/mcp` });
    await mcp.startProfile('custom-docs');
    server.forgetSessions();
    expect(await mcp.testProfile('custom-docs')).toMatchObject({ compatibilityState: 'compatible', discoveredToolCount: 3 });
    expect(rowOf('custom-docs')).toMatchObject({ enabled: 1, state: 'running' });
  });

  it('backs off an unreachable server instead of reconnecting on every health check (live 2026-10-07)', { timeout: 30_000 }, async () => {
    // A port with nothing listening on it.
    const probe = http.createServer();
    await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', resolve));
    const port = (probe.address() as AddressInfo).port;
    await new Promise<void>(resolve => probe.close(() => resolve()));
    let attempts = 0;
    const mcp = await setup({
      healthIntervalMs: 40,
      remoteBackoffBaseMs: 300,
      remoteFetch: async (url, init) => {
        if ((init?.method ?? 'GET').toUpperCase() === 'POST') attempts += 1;
        return fetch(url, init);
      },
    });
    await mcp.createCustomServer({ name: 'Gone', url: `http://127.0.0.1:${port}/mcp` });
    await expect(mcp.startProfile('custom-gone')).rejects.toThrow(/can't reach 127\.0\.0\.1/);
    await new Promise(resolve => setTimeout(resolve, 1_000));
    // About 25 health checks ran. Reconnects followed the backoff instead:
    // the start, one probe, then about 300 ms and 600 ms later.
    expect(attempts).toBeGreaterThanOrEqual(2);
    expect(attempts).toBeLessThanOrEqual(5);
    expect(rowOf('custom-gone')).toMatchObject({ enabled: 1, state: 'degraded' });
  });

  it('stops within its bound when the server never answers the session DELETE', { timeout: 30_000 }, async () => {
    const server = await fake({ json: true });
    const mcp = await setup();
    await mcp.createCustomServer({ name: 'Slow close', url: `${server.base}/mcp` });
    await mcp.startProfile('custom-slow-close');
    server.holdDeletes = true;
    const stopStarted = Date.now();
    await mcp.stopProfile('custom-slow-close');
    expect(Date.now() - stopStarted).toBeLessThan(4_000);
    expect(server.requests.some(request => request.method === 'DELETE')).toBe(true);
  });

  it('keeps the review across edits on the same host and asks again when the host changes', { timeout: 30_000 }, async () => {
    const server = await fake({ json: true });
    const mcp = await setup();
    await mcp.createCustomServer({ name: 'Reviewed', url: `${server.base}/mcp` }, { origin: 'assistant' });
    await mcp.approveCustomServer('custom-reviewed');
    await mcp.startProfile('custom-reviewed');
    await mcp.stopProfile('custom-reviewed');
    const sameHost = await mcp.updateCustomServer('custom-reviewed', { url: `${server.base}/mcp/`, headers: { 'X-Team': 'botboy' } }, { origin: 'assistant' });
    expect(sameHost.needsReview).toBe(false);
    expect(sameHost.tools.length).toBe(3);
    const view = await mcp.getCustomServerConfig('custom-reviewed');
    // Non-secret values are visible; nothing is hidden but secrets.
    expect(view?.headers).toEqual([{ name: 'X-Team', secret: false, required: false, saved: true, value: 'botboy' }]);
    const otherHost = await mcp.updateCustomServer('custom-reviewed', { url: `http://localhost:${server.port}/mcp` }, { origin: 'assistant' });
    expect(otherHost.needsReview).toBe(true);
    expect(otherHost.tools).toEqual([]);
  });
});

describe('custom server values', () => {
  let storage: StorageLayer | null = null;
  let manager: McpManager | null = null;
  let dir: string | null = null;
  const secrets = new Map<string, string>();
  const secretStore = {
    async get(id: string, key: string) { return secrets.get(`${id}:${key}`) ?? null; },
    async set(id: string, key: string, value: string) { secrets.set(`${id}:${key}`, value); },
    async delete(id: string, key: string) { secrets.delete(`${id}:${key}`); },
    async has(id: string, key: string) { return secrets.has(`${id}:${key}`); },
  };
  afterEach(async () => {
    await manager?.stop();
    manager = null;
    storage?.close();
    storage = null;
    secrets.clear();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  it('moves version-1 env values into Keychain on start and launches a local server with them', { timeout: 30_000 }, async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'botboy-mcp-env-'));
    const script = path.join(dir, 'env-server.cjs');
    fs.writeFileSync(script, `
const readline = require('node:readline');
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  if (message.method === 'initialize') send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'env-fake', version: '1.0.0' } } });
  else if (message.method === 'tools/list') send({ jsonrpc: '2.0', id: message.id, result: { tools: [{ name: 'get_env', inputSchema: { type: 'object', properties: {} } }] } });
  else if (message.method === 'tools/call') send({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: process.env.GREETING + '/' + process.env.API_TOKEN } ] } });
  else send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } });
});
`);
    storage = createStorage(':memory:');
    storage.initialize();
    storage.getDb().prepare(`
      INSERT INTO mcp_servers (id, kind, display_name, enabled, config_json, state)
      VALUES ('custom-env', 'custom', 'Env', 0, ?, 'stopped')
    `).run(JSON.stringify({ name: 'Env', command: process.execPath, args: [script], env: { GREETING: 'hello', API_TOKEN: 'tok-1' }, origin: 'user', reviewed: true }));
    manager = createMcpManager({ db: storage.getDb(), secretStore, healthIntervalMs: 3_600_000 });
    await manager.start();
    const raw = (storage.getDb().prepare("SELECT config_json FROM mcp_servers WHERE id = 'custom-env'").get() as { config_json: string }).config_json;
    expect(raw).not.toContain('tok-1');
    expect(raw).not.toContain('hello');
    expect(JSON.parse(raw)).toMatchObject({ version: 2, transport: 'stdio', env: [{ name: 'GREETING', secret: false, hasValue: true }, { name: 'API_TOKEN', secret: true, hasValue: true }] });
    expect(secrets.get('custom-env:env-API_TOKEN')).toBe('tok-1');
    expect(secrets.get('custom-env:env-GREETING')).toBe('hello');

    expect((await manager.startProfile('custom-env')).state).toBe('running');
    expect((await manager.callTool('custom-env', 'get_env', {})).text).toBe('hello/tok-1');
    const view = await manager.getCustomServerConfig('custom-env');
    expect(view?.env).toEqual([
      { name: 'GREETING', secret: false, required: false, saved: true, value: 'hello' },
      { name: 'API_TOKEN', secret: true, required: false, saved: true },
    ]);
  });
});
