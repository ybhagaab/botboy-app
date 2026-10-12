import { afterEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createStorage, type StorageLayer } from './storage.js';
import { createMcpManager, McpHiddenByWorkplaceError } from './mcp-manager.js';
import type { McpManager } from './mcp-types.js';

/**
 * Settings → Workplace manager gate (design §7.1, §16 item 3): while Amazon
 * Employee is off, Amazon built-in profiles and AIM installs are hidden and
 * inactive; their rows stay enabled and resume when the toggle goes back on.
 * Uses a real SDK server over loopback HTTP as an "AIM install" (about.source aim:).
 */
async function startFake(): Promise<{ url: string; calls: string[]; close(): Promise<void> }> {
  const sessions = new Map<string, StreamableHTTPServerTransport>();
  const calls: string[] = [];
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString('utf8');
    const sessionId = req.headers['mcp-session-id'];
    let transport = typeof sessionId === 'string' ? sessions.get(sessionId) : undefined;
    if (!transport) {
      const created: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        enableJsonResponse: true,
        onsessioninitialized: id => { sessions.set(id, created); },
      });
      transport = created;
      const mcp = new Server({ name: 'fake-aim', version: '1.0.0' }, { capabilities: { tools: {} } });
      mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: 'search_docs', description: 'Search', inputSchema: { type: 'object', properties: {} } }] }));
      mcp.setRequestHandler(CallToolRequestSchema, async request => {
        calls.push(request.params.name);
        return { content: [{ type: 'text', text: 'ok' }] };
      });
      await mcp.connect(transport);
    }
    await transport.handleRequest(req, res, raw ? JSON.parse(raw) : undefined);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`,
    calls,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}

describe('mcp-manager workplace gate', () => {
  let storage: StorageLayer | null = null;
  let manager: McpManager | null = null;
  let fake: Awaited<ReturnType<typeof startFake>> | null = null;
  let amazon = true;
  const secretStore = {
    async get() { return null; }, async set() {}, async delete() {}, async has() { return false; },
  };
  async function setup(options: { gated?: boolean } = {}): Promise<McpManager> {
    storage = createStorage(':memory:');
    storage.initialize();
    manager = createMcpManager({
      db: storage.getDb(), secretStore: secretStore as any, healthIntervalMs: 3_600_000,
      ...(options.gated === false ? {} : { amazonEmployee: () => amazon }),
    });
    await manager.start();
    return manager;
  }
  const row = (id: string) => storage!.getDb().prepare('SELECT * FROM mcp_servers WHERE id = ?').get(id) as any;
  afterEach(async () => {
    await manager?.stop();
    manager = null;
    storage?.close();
    storage = null;
    await fake?.close();
    fake = null;
    amazon = true;
  });

  it('hides and stops an AIM install while off, records blocked calls, and resumes it when on', { timeout: 30_000 }, async () => {
    fake = await startFake();
    const mcp = await setup();
    await mcp.createCustomServer({ name: 'Docs', url: fake.url, about: { source: 'aim:docs-mcp' } });
    expect((await mcp.startProfile('custom-docs')).state).toBe('running');
    expect((await mcp.listProfiles()).map(profile => profile.id)).toContain('custom-docs');

    amazon = false;
    await mcp.applyWorkplaceChange();
    expect(row('custom-docs')).toMatchObject({ enabled: 1, state: 'stopped' });
    expect(mcp.isHiddenByWorkplace('custom-docs')).toBe(true);
    expect((await mcp.listProfiles()).map(profile => profile.id)).not.toContain('custom-docs');
    expect((await mcp.listServers()).map(server => server.id)).not.toContain('custom-docs');
    expect((await mcp.listProfiles({ includeHidden: true })).map(profile => profile.id)).toContain('custom-docs');
    expect(await mcp.getServer('custom-docs')).toBeNull();
    expect(await mcp.getProfile('custom-docs')).toBeNull();
    const error = await mcp.callTool('custom-docs', 'search_docs', {}).catch(caught => caught);
    expect(error).toBeInstanceOf(McpHiddenByWorkplaceError);
    expect(error.code).toBe('amazon_employee_off');
    expect(error.message).toContain('(code: amazon_employee_off)');
    const audit = storage!.getDb().prepare("SELECT status FROM mcp_tool_calls WHERE server_id = 'custom-docs' ORDER BY rowid DESC LIMIT 1").get() as any;
    expect(audit.status).toBe('blocked');
    await expect(mcp.startProfile('custom-docs')).rejects.toBeInstanceOf(McpHiddenByWorkplaceError);
    await expect(mcp.checkProfile('custom-docs')).rejects.toBeInstanceOf(McpHiddenByWorkplaceError);
    expect(fake.calls).toEqual([]);

    amazon = true;
    await mcp.applyWorkplaceChange();
    for (let i = 0; i < 100 && row('custom-docs').state !== 'running'; i++) await new Promise(resolve => setTimeout(resolve, 50));
    expect(row('custom-docs').state).toBe('running');
    expect((await mcp.callTool('custom-docs', 'search_docs', {})).text).toBe('ok');
  });

  it('classifies AIM installs by command too, keeps npx servers visible, and refuses AIM adds and edits while off', async () => {
    const mcp = await setup();
    await mcp.createCustomServer({ name: 'Aim Tool', command: 'aim', args: ['mcp', 'start-server', 'x'] });
    await mcp.createCustomServer({ name: 'Notes', command: 'npx', args: ['-y', 'notes-mcp'] });
    amazon = false;
    expect(mcp.isHiddenByWorkplace('custom-aim-tool')).toBe(true);
    expect(mcp.isHiddenByWorkplace('custom-notes')).toBe(false);
    expect((await mcp.listProfiles()).map(profile => profile.id)).toContain('custom-notes');
    await expect(mcp.createCustomServer({ name: 'New Aim', command: 'aim', args: [] })).rejects.toBeInstanceOf(McpHiddenByWorkplaceError);
    expect(row('custom-new-aim')).toBeUndefined();
    await expect(mcp.createCustomServer({ name: 'Sourced', command: 'npx', args: [], about: { source: 'aim:x' } })).rejects.toBeInstanceOf(McpHiddenByWorkplaceError);
    await expect(mcp.updateCustomServer('custom-notes', { name: 'Notes', command: 'aim', args: [] })).rejects.toBeInstanceOf(McpHiddenByWorkplaceError);
    expect(JSON.parse(row('custom-notes').config_json).command).toBe('npx');
  });

  it('never launches a hidden enabled built-in profile at start, and keeps it enabled', async () => {
    amazon = false;
    storage = createStorage(':memory:');
    storage.initialize();
    storage.getDb().prepare("UPDATE mcp_servers SET enabled = 1, state = 'stopped' WHERE id = 'slack'").run();
    manager = createMcpManager({ db: storage.getDb(), secretStore: secretStore as any, healthIntervalMs: 3_600_000, amazonEmployee: () => amazon });
    await manager.start();
    expect(row('slack')).toMatchObject({ enabled: 1, state: 'stopped', restart_count: 0 });
    expect(manager.isHiddenByWorkplace('slack')).toBe(true);
    expect(manager.isHiddenByWorkplace('sql-context')).toBe(false);
    await expect(manager.restart('slack')).rejects.toBeInstanceOf(McpHiddenByWorkplaceError);
  });

  it('without the option nothing is hidden (today’s behavior)', async () => {
    const mcp = await setup({ gated: false });
    await mcp.createCustomServer({ name: 'Aim Tool', command: 'aim', args: [] });
    amazon = false;
    expect(mcp.isHiddenByWorkplace('custom-aim-tool')).toBe(false);
    expect(mcp.isHiddenByWorkplace('slack')).toBe(false);
    expect((await mcp.listProfiles()).map(profile => profile.id)).toEqual(expect.arrayContaining(['slack', 'custom-aim-tool']));
  });
});
