import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createStorage, type StorageLayer } from './storage.js';
import { createNodeManager } from './node-manager.js';
import { createMcpManager } from './mcp-manager.js';
import type { McpManager, McpProfileSnapshot } from './mcp-types.js';
import { createToolExecutor } from './tool-executor.js';
import type { McpServerFinder } from './mcp-registry-lookup.js';

/**
 * BotBoy adds and fixes MCP servers from chat (MCP_REMOTE_TRANSPORTS_PLAN.md
 * MR1): the model sees the whole definition except secret values, writes
 * none of them, gets the card marker and a next step, and an update is one
 * composite call.
 */

// Assembled at runtime so secret scanners never see a key-shaped literal.
const PASTED_KEY = ['sk', 'live', 'pasted', 'into', 'chat', '42'].join('-');

describe('MCP server chat tools', () => {
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
  });
  afterEach(async () => {
    await manager.stop();
    storage.close();
    secrets.clear();
  });

  const executor = (extras: Parameters<typeof createToolExecutor>[2] = {}) =>
    createToolExecutor(storage.getDb(), createNodeManager(storage.getDb()), { mcpManager: manager, ...extras });
  const run = async (tools: ReturnType<typeof createToolExecutor>, name: string, args: Record<string, unknown>) =>
    (await tools.executeTool({ id: `${name}-1`, type: 'function', function: { name, arguments: JSON.stringify(args) } })).content;

  it('adds a remote server from a pasted snippet and returns its card, the waiting key, and no value', async () => {
    const tools = executor();
    const out = JSON.parse(await run(tools, 'mcp_add_custom_server', {
      name: 'Docs Search',
      url: 'https://docs.example.com/mcp',
      type: 'streamable-http',
      headers: { Authorization: 'Bearer {api_key}', 'X-Region': 'eu' },
      about: { publisher: 'example.com', source: 'registry:com.example/docs@1.0.0' },
      ownerRequested: true,
    }));
    expect(out).toMatchObject({
      ok: true,
      action: 'created',
      serverId: 'custom-docs-search',
      card: '[[mcp-server:custom-docs-search]]',
      needsReview: true,
      waitingFor: ['header Authorization'],
      definition: {
        transport: 'http',
        url: 'https://docs.example.com/mcp',
        origin: 'assistant',
        reviewed: false,
        about: { publisher: 'example.com' },
        headers: [
          { name: 'Authorization', secret: true, required: true, saved: false, template: 'Bearer {value}' },
          { name: 'X-Region', secret: false, saved: true, value: 'eu' },
        ],
      },
      nextStep: expect.stringMatching(/^Put \[\[mcp-server:custom-docs-search\]\] on its own line.*types header Authorization on the card, then presses Start.*you cannot start it/),
    });
    // The same address again is refused with the server that already has it.
    expect(await run(tools, 'mcp_add_custom_server', { name: 'Again', url: 'https://docs.example.com/mcp/', ownerRequested: true }))
      .toMatch(/^Error: Docs Search \(custom-docs-search\) already runs this address.*\[\[mcp-server:custom-docs-search\]\]/);
    // Starting is the owner's press, not BotBoy's.
    const start = JSON.parse(await run(tools, 'mcp_profile_action', { profileId: 'custom-docs-search', action: 'start' }));
    expect(start).toMatchObject({ error: expect.stringMatching(/needs the owner's review first/), card: '[[mcp-server:custom-docs-search]]' });
  });

  it('refuses a secret value BotBoy was told in chat, without storing or echoing it', async () => {
    const tools = executor();
    const refused = await run(tools, 'mcp_add_custom_server', {
      name: 'Brave',
      command: 'npx',
      args: ['-y', '@brave/brave-search-mcp-server@2.1.3'],
      env: { BRAVE_API_KEY: PASTED_KEY },
      ownerRequested: true,
    });
    expect(refused).toMatch(/^Error: BRAVE_API_KEY is a secret: leave its value empty and ask the owner to type it into the server's card/);
    expect(refused).not.toContain(PASTED_KEY);
    expect(secrets.size).toBe(0);
    expect(await manager.listProfiles().then(list => list.filter(profile => profile.kind === 'custom'))).toEqual([]);
    expect(await run(tools, 'mcp_add_custom_server', { name: 'X', url: 'https://x.example.com/mcp' }))
      .toMatch(/requires ownerRequested=true/);
  });

  it('reads the whole definition except secret values', async () => {
    await manager.createCustomServer({ name: 'Local', command: 'node', args: ['server.js'], env: { LOG_LEVEL: 'debug', API_TOKEN: PASTED_KEY } });
    const config = JSON.parse(await run(executor(), 'mcp_get_custom_server_config', { serverId: 'custom-local' }));
    expect(config).toMatchObject({
      id: 'custom-local',
      transport: 'stdio',
      command: 'node',
      args: ['server.js'],
      env: [{ name: 'LOG_LEVEL', value: 'debug', secret: false }, { name: 'API_TOKEN', secret: true, saved: true }],
      card: '[[mcp-server:custom-local]]',
      connectionPage: '#/connections/custom-local',
      needsReview: false,
    });
    expect(JSON.stringify(config)).not.toContain(PASTED_KEY);
  });

  it('applies a non-identity fix directly and asks for a new Start only when the host changes', async () => {
    await manager.createCustomServer({ name: 'Docs', url: 'https://docs.example.com/mcp' });
    const tools = executor();
    const renamed = JSON.parse(await run(tools, 'mcp_update_custom_server', {
      serverId: 'custom-docs', type: 'sse', headers: { 'X-Team': 'payments' }, ownerRequested: true,
    }));
    expect(renamed).toMatchObject({ ok: true, action: 'updated', needsReview: false, definition: { transport: 'sse', url: 'https://docs.example.com/mcp', reviewed: true, origin: 'assistant' } });
    expect(renamed.nextStep).toBe('Start it with mcp_profile_action start, then test it.');

    const moved = JSON.parse(await run(tools, 'mcp_update_custom_server', { serverId: 'custom-docs', url: 'https://other.example.org/mcp', ownerRequested: true }));
    expect(moved).toMatchObject({ needsReview: true, card: '[[mcp-server:custom-docs]]', definition: { reviewed: false } });
    expect(await run(tools, 'mcp_update_custom_server', { serverId: 'slack', name: 'x', ownerRequested: true })).toMatch(/^Error: unknown custom MCP server 'slack'/);
  });

  it('stops a running server, applies the change, and starts it again; a refused change restores it', async () => {
    const profile = (patch: Partial<McpProfileSnapshot>): McpProfileSnapshot => ({
      id: 'custom-docs', kind: 'custom', displayName: 'Docs', enabled: true, configured: true, state: 'running', tools: [],
      restartCount: 0, lastError: null, lastStartedAt: null, lastHealthyAt: null, updatedAt: '',
      installationState: 'installed', compatibilityState: 'compatible', requiredTools: [], missingTools: [], needsReview: false,
      custom: { transport: 'http', endpointHost: 'docs.example.com', about: {}, missingValues: [] },
      ...patch,
    } as McpProfileSnapshot);
    const calls: string[] = [];
    let updateFails = false;
    const fake = {
      getProfile: vi.fn(async () => profile({})),
      stopProfile: vi.fn(async () => { calls.push('stop'); return profile({ enabled: false, state: 'stopped' }); }),
      updateCustomServer: vi.fn(async () => {
        calls.push('update');
        if (updateFails) throw new Error('url must use https://');
        return profile({ enabled: false, state: 'stopped' });
      }),
      startProfile: vi.fn(async () => { calls.push('start'); return profile({ tools: [{ name: 'search', risk: 'read' } as any] }); }),
      getCustomServerConfig: vi.fn(async () => ({ id: 'custom-docs', missingValues: [] })),
    } as unknown as McpManager;
    const tools = createToolExecutor(storage.getDb(), createNodeManager(storage.getDb()), { mcpManager: fake });
    const out = JSON.parse(await run(tools, 'mcp_update_custom_server', { serverId: 'custom-docs', headers: { 'X-Team': 'a' }, ownerRequested: true }));
    expect(calls).toEqual(['stop', 'update', 'start']);
    expect(out).toMatchObject({ ok: true, restarted: true, state: 'running', nextStep: expect.stringMatching(/running with 1 tools/) });

    // A change of host needs the owner's Start again: BotBoy does not start it.
    calls.length = 0;
    (fake.updateCustomServer as any).mockImplementationOnce(async () => {
      calls.push('update');
      return profile({ enabled: false, state: 'stopped', needsReview: true });
    });
    const moved = JSON.parse(await run(tools, 'mcp_update_custom_server', { serverId: 'custom-docs', url: 'https://other.example.org/mcp', ownerRequested: true }));
    expect(calls).toEqual(['stop', 'update']);
    expect(moved).toMatchObject({ needsReview: true, restarted: false });

    calls.length = 0;
    updateFails = true;
    const refused = await run(tools, 'mcp_update_custom_server', { serverId: 'custom-docs', url: 'http://plain.example.com/mcp', ownerRequested: true });
    expect(calls).toEqual(['stop', 'update', 'start']);
    expect(refused).toBe('Error: url must use https:// Nothing changed, and the server was started again as it was.');
  });

  it('finds servers through the injected finder inside the untrusted envelope', async () => {
    const finder: McpServerFinder = {
      find: vi.fn(async (query: string) => ({
        query,
        candidates: [{ source: 'aim' as const, id: 'enterprise-asana-mcp', title: 'Enterprise Asana MCP Server', publisher: 'Amazon AIM registry', description: 'Asana', options: [] }],
        sources: { 'mcp-registry': { status: 'ok' as const, matches: 0 }, aim: { status: 'ok' as const, matches: 1 } },
      })),
    };
    const out = JSON.parse(await run(executor({ mcpServerFinder: finder }), 'mcp_find_server', { query: 'asana', limit: 3 }));
    expect(finder.find).toHaveBeenCalledWith('asana', { limit: 3 });
    expect(out).toMatchObject({
      trust: 'external_untrusted_data',
      query: 'asana',
      candidates: [{ id: 'enterprise-asana-mcp' }],
      next: expect.stringMatching(/mcp_add_custom_server with ownerRequested=true/),
    });
    expect(await run(executor(), 'mcp_find_server', { query: 'asana' })).toMatch(/lookup is unavailable/);
    expect(await run(executor({ mcpServerFinder: finder }), 'mcp_find_server', { query: '  ' })).toMatch(/query is required/);
  });
});
