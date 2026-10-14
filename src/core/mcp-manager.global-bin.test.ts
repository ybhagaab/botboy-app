/**
 * The MCP manager and BotBoy's own Node (owner decisions B and EXTEND, 2026-10-14; brief section 10e):
 *  - a user-added command that lives only in ~/.npm-global/bin (installed from chat with `npm install -g`) is found by its
 *    bare name, LAST, while BotBoy runs on its own Node; with a Node of its own nothing is searched there;
 *  - "Command not found: <name>" keeps its text and says the next step;
 *  - a sandboxed child that can read BotBoy's Node gets npm's global prefix and the global bin at the END of its PATH; a
 *    prefix the owner declared for the server is kept; nothing is added when the sandbox did not open the runtime.
 * The sandbox call itself is replaced by a pass-through that records what the manager asked for (the real sandbox is
 * proved in protected-local-resources.runtime-read.test.ts): this file is about what the manager decides.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { commandNotFound, createMcpManager } from './mcp-manager.js';
import type { McpManager } from './mcp-types.js';
import { createStorage, type StorageLayer } from './storage.js';

// Servers are real child processes: slow when the machine is busy.
vi.setConfig({ testTimeout: 60_000 });

const mocked = vi.hoisted(() => ({
  use: null as null | { runtimeDir: string; runtimeBin: string; globalPrefix: string; globalBin: string },
  runtimeRead: false,
  sandboxCalls: [] as Array<{ executable: string; args: string[]; options: Record<string, unknown> | undefined }>,
}));
vi.mock('./protected-local-resources.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('./protected-local-resources.js')>();
  return {
    ...original,
    privateNodeUse: () => mocked.use,
    modelProcessSandboxInvocation: (executable: string, args: string[], options?: Record<string, unknown>) => {
      mocked.sandboxCalls.push({ executable, args, options });
      // `opened` says which runtime folders the profile opened; the manager keys the npm prefix off `opened.node`.
      return { executable, args, filesDir: '', profile: '', runtimeRead: mocked.runtimeRead, opened: mocked.runtimeRead && mocked.use ? { node: mocked.use.runtimeDir } : {} };
    },
  };
});

// A minimal newline-delimited JSON-RPC MCP server; its one tool reports the environment it was started with.
const FAKE_SERVER = `
const readline = require('node:readline');
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  if (message.method === 'initialize') {
    send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'env-probe', version: '1.0.0' } } });
  } else if (message.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: message.id, result: { tools: [{ name: 'get_env', description: 'Report the environment', inputSchema: { type: 'object', properties: {} } }] } });
  } else if (message.method === 'tools/call') {
    send({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: JSON.stringify({ prefix: process.env.npm_config_prefix ?? null, path: process.env.PATH ?? null }) }] } });
  } else {
    send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } });
  }
});
`;

describe('the MCP manager and BotBoy\'s own Node', () => {
  let storage: StorageLayer | null = null;
  let manager: McpManager | null = null;
  const roots: string[] = [];
  const secrets = new Map<string, string>();
  const secretStore = {
    async get(id: string, key: string) { return secrets.get(`${id}:${key}`) ?? null; },
    async set(id: string, key: string, value: string) { secrets.set(`${id}:${key}`, value); },
    async delete(id: string, key: string) { secrets.delete(`${id}:${key}`); },
    async has(id: string, key: string) { return secrets.has(`${id}:${key}`); },
  };
  const temp = () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'botboy-mcp-global-')));
    roots.push(dir);
    return dir;
  };
  const useIn = (home: string) => ({
    runtimeDir: path.join(home, '.personal-productivity-tracker', 'runtime', 'node-24.21.0-arm64'),
    runtimeBin: path.join(home, '.personal-productivity-tracker', 'runtime', 'node-24.21.0-arm64', 'bin'),
    globalPrefix: path.join(home, '.npm-global'),
    globalBin: path.join(home, '.npm-global', 'bin'),
  });
  async function setup(): Promise<McpManager> {
    storage = createStorage(':memory:');
    storage.initialize();
    manager = createMcpManager({ db: storage.getDb(), secretStore, healthIntervalMs: 3_600_000 });
    await manager.start();
    return manager;
  }
  const rowOf = (id: string) => storage!.getDb().prepare('SELECT state, last_error FROM mcp_servers WHERE id = ?').get(id) as { state: string; last_error: string | null };
  afterEach(async () => {
    await manager?.stop();
    manager = null;
    storage?.close();
    storage = null;
    secrets.clear();
    mocked.use = null;
    mocked.runtimeRead = false;
    mocked.sandboxCalls.length = 0;
    while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
  });

  describe('the lookup of a user-added command', () => {
    it('finds a command that is only in ~/.npm-global/bin while BotBoy runs on its own Node', async () => {
      const home = temp();
      mocked.use = useIn(home);
      fs.mkdirSync(mocked.use.globalBin, { recursive: true });
      fs.writeFileSync(path.join(mocked.use.globalBin, 'botboy-global-probe'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      const mcp = await setup();
      const created = await mcp.createCustomServer({ name: 'Global Probe', command: 'botboy-global-probe' });
      expect(created.installationState).toBe('installed');
      expect(rowOf('custom-global-probe')).toEqual({ state: 'stopped', last_error: null });
    });

    it('with a Node of its own the same command is not found, and the message names the next step', async () => {
      const home = temp();
      const globalBin = path.join(home, '.npm-global', 'bin');
      fs.mkdirSync(globalBin, { recursive: true });
      fs.writeFileSync(path.join(globalBin, 'botboy-global-probe'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      const mcp = await setup(); // mocked.use stays null
      const created = await mcp.createCustomServer({ name: 'Global Probe', command: 'botboy-global-probe' });
      expect(created.installationState).toBe('not_installed');
      expect(rowOf('custom-global-probe')).toEqual({
        state: 'needs_configuration',
        last_error: 'Command not found: botboy-global-probe. If it is an npm program, ask BotBoy in chat to install it, then press Start again.',
      });
    });

    it('says what to do for uvx: BotBoy sets up its own uv at start (Python on demand, design review finding 13)', () => {
      expect(commandNotFound('uvx')).toBe('Command not found: uvx. BotBoy sets up its own uv at start and has not done so yet on this Mac (./start.sh --doctor, row "uv source"): run ./start.sh again while online, or install uv yourself, then press Start.');
      expect(commandNotFound('/opt/homebrew/bin/uvx')).toContain('row "uv source"');
      expect(commandNotFound('foo-mcp')).toBe('Command not found: foo-mcp. If it is an npm program, ask BotBoy in chat to install it, then press Start again.');
    });

    it('every launch executable is looked up through one helper, and only user-added commands get the extra folder', () => {
      const source = fs.readFileSync(new URL('./mcp-manager.ts', import.meta.url), 'utf8');
      expect(source.match(/resolveDefinitionExecutable\(/g)).toHaveLength(1);
      expect(source).toContain('resolveDefinitionExecutable(definition, undefined, lastResortFolders())');
      expect(source).toContain('return [...(use ? [use.globalBin] : []), ...(python ? [python.userBin] : [])];');
      expect(source.match(/npmGlobalEnvironment\(/g)).toHaveLength(1);
      expect(source).toContain("if (nodeUse && launch.opened.node) childEnv = npmGlobalEnvironment(childEnv, nodeUse, customEnv);");
      expect(source).toContain("if ('opened' in launch) {");
    });
  });

  describe('the environment of a user-added server', () => {
    const start = async (extra: { env?: Record<string, string> } = {}) => {
      const dir = temp();
      const entry = path.join(dir, 'env-probe.cjs');
      fs.writeFileSync(entry, FAKE_SERVER);
      const mcp = await setup();
      await mcp.createCustomServer({ name: 'Env Probe', command: process.execPath, args: [entry], ...extra });
      expect((await mcp.startProfile('custom-env-probe')).state).toBe('running');
      const result = await mcp.callTool('custom-env-probe', 'get_env', {});
      expect(result.isError).toBe(false);
      return JSON.parse(result.text) as { prefix: string | null; path: string | null };
    };

    it('gets npm\'s global prefix and its bin at the END of PATH when its sandbox can read BotBoy\'s Node', async () => {
      const home = temp();
      mocked.use = useIn(home);
      mocked.runtimeRead = true;
      const seen = await start();
      expect(seen.prefix).toBe(mocked.use.globalPrefix);
      expect(seen.path!.split(path.delimiter).at(-1)).toBe(mocked.use.globalBin);
      expect(fs.statSync(mocked.use.globalBin).isDirectory()).toBe(true); // created on first use
      expect(mocked.sandboxCalls).toHaveLength(1);
      expect(mocked.sandboxCalls[0].options).toEqual({ runtimeReadDir: mocked.use.runtimeDir });
    });

    it('keeps a prefix the owner declared for the server', async () => {
      const home = temp();
      mocked.use = useIn(home);
      mocked.runtimeRead = true;
      const seen = await start({ env: { npm_config_prefix: '/declared/prefix' } });
      expect(seen.prefix).toBe('/declared/prefix');
      expect(seen.path!.split(path.delimiter).at(-1)).toBe(mocked.use.globalBin);
    });

    it('gets nothing extra when the sandbox did not open the runtime (fail closed)', async () => {
      const home = temp();
      mocked.use = useIn(home);
      mocked.runtimeRead = false;
      const seen = await start();
      expect(seen.prefix).toBeNull();
      expect(seen.path!.split(path.delimiter)).not.toContain(mocked.use.globalBin);
      expect(fs.existsSync(mocked.use.globalPrefix)).toBe(false);
    });

    it('on a Mac with a Node of its own: no runtime folder is named, no prefix, no global bin', async () => {
      const seen = await start();
      expect(seen.prefix).toBeNull();
      expect(seen.path!.split(path.delimiter).some((entry) => entry.endsWith(`${path.sep}.npm-global${path.sep}bin`))).toBe(false);
      expect(mocked.sandboxCalls).toHaveLength(1);
      expect(mocked.sandboxCalls[0].options).toEqual({ runtimeReadDir: undefined });
    });
  });
});
