import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStorage, type StorageLayer } from './storage.js';
import { createMcpManager } from './mcp-manager.js';
import type { McpManager } from './mcp-types.js';
import type { SqlContextPackageResolver } from './sql-context-package.js';

/**
 * The MCP SDK (1.31) caps each stdio message at 10 MiB by default and closes
 * the transport on overflow. SharePoint inline reads have returned 9.5M-char
 * results, so the manager raises the cap. This drives a real stdio child
 * through the real SDK client: one tool result above the SDK default must
 * arrive intact, and the connector must stay up for the next call.
 */
const RESULT_CHARS = 12 * 1024 * 1024;

// Minimal newline-delimited JSON-RPC MCP server: initialize, tools/list, and
// tools/call. `list_presets` returns RESULT_CHARS characters; any other tool
// returns a short text.
const FAKE_SERVER = `
const readline = require('node:readline');
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
const tool = (name) => ({ name, description: name, inputSchema: { type: 'object', properties: {} } });
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  if (message.method === 'initialize') {
    send({ jsonrpc: '2.0', id: message.id, result: {
      protocolVersion: message.params.protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: 'large-result-fake', version: '1.0.0' },
    } });
  } else if (message.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: message.id, result: { tools: [tool('list_presets'), tool('connection_status')] } });
  } else if (message.method === 'tools/call') {
    const text = message.params.name === 'list_presets' ? 'x'.repeat(${RESULT_CHARS}) : 'ok';
    send({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text }] } });
  } else {
    send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } });
  }
});
`;

describe('MCP stdio message size', () => {
  let storage: StorageLayer | null = null;
  let manager: McpManager | null = null;
  let dir: string | null = null;

  afterEach(async () => {
    await manager?.stop();
    manager = null;
    storage?.close();
    storage = null;
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  it('accepts a tool result larger than the SDK default and keeps the connector running', { timeout: 60_000 }, async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'botboy-mcp-large-'));
    const entry = path.join(dir, 'fake-server.cjs');
    fs.writeFileSync(entry, FAKE_SERVER);

    storage = createStorage(':memory:');
    storage.initialize();
    const secrets = new Map<string, string>();
    const secretStore = {
      async get(id: string, key: string) { return secrets.get(`${id}:${key}`) ?? null; },
      async set(id: string, key: string, value: string) { secrets.set(`${id}:${key}`, value); },
      async delete(id: string, key: string) { secrets.delete(`${id}:${key}`); },
      async has(id: string, key: string) { return secrets.has(`${id}:${key}`); },
    };
    const sqlContextPackages: SqlContextPackageResolver = {
      resolveLaunch: async () => ({ version: '1.5.0', entry, source: 'bundled' as const }),
    };
    manager = createMcpManager({ db: storage.getDb(), secretStore, healthIntervalMs: 3_600_000, sqlContextPackages });
    await manager.start();
    await manager.updateSqlContextConfig({
      enabled: true, authMethod: 'direct', host: '127.0.0.1', port: 5439,
      database: 'db', username: 'user', sslMode: 'disable', password: 'secret',
    });

    const large = await manager.callTool('sql-context', 'list_presets', {}, { timeoutMs: 30_000 });
    expect(large.isError).toBe(false);
    expect(large.text.length).toBe(RESULT_CHARS);

    // Same runtime, still connected: no overflow close or restart happened.
    const next = await manager.callTool('sql-context', 'connection_status', {}, { timeoutMs: 30_000 });
    expect(next).toMatchObject({ isError: false, text: 'ok' });
    const row = storage.getDb()
      .prepare("SELECT state, restart_count FROM mcp_servers WHERE id = 'sql-context'")
      .get() as { state: string; restart_count: number };
    expect(row).toEqual({ state: 'running', restart_count: 0 });
  });
});
