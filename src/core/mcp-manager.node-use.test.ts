/**
 * Every MCP server runs on BotBoy's own Node when that is the Node in use (owner decision 2026-10-14: "let all botboy's
 * mcps and any mcp user adds to botboy use it ... please do test the external mcps, slack, aim, grasp etc all").
 * The real MCP manager and the real MCP SDK client start fake servers that stand in for the external ones, each a
 * `#!/usr/bin/env node` program that reports the node it runs on and the environment it got:
 *   - the built-in profiles (slack, grasp-m365, sharepoint, a2-analytics' AIM package script) run UNSANDBOXED on the
 *     runtime's node, and never get npm's global prefix or ~/.npm-global/bin (sandboxed code can write that folder);
 *   - AIM (`aim mcp start-server <name>`) and toolbox binaries (`builder-mcp`) are user-added custom commands, run under
 *     the REAL sandbox-exec with the runtime read rule, on the runtime's node, with the global prefix at the end of PATH.
 * The real servers (their credentials and Midway) are exercised in the orchestrator's live run, not here.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createMcpManager } from './mcp-manager.js';
import type { McpManager } from './mcp-types.js';
import { createPrivateNodeFixture, livePrivateNode as live, type PrivateNodeFixture } from './private-node-fixture.testutil.js';
import { createStorage, type StorageLayer } from './storage.js';

const mocked = vi.hoisted(() => ({ useFn: null as null | (() => unknown) }));
vi.mock('./protected-local-resources.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('./protected-local-resources.js')>();
  return {
    ...original,
    // Tests that stand in for "BotBoy runs on its own Node" answer with the fixture's runtime; the others ask the real function.
    privateNodeUse: (...args: Parameters<typeof original.privateNodeUse>) => (mocked.useFn ? mocked.useFn() : original.privateNodeUse(...args)),
  };
});

/** A `#!/usr/bin/env node` MCP server that first writes what it runs on to $HOME/reports/<name>.json. */
const fakeServer = (name: string, tools: string[]) => `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
fs.mkdirSync(path.join(process.env.HOME, 'reports'), { recursive: true });
fs.writeFileSync(path.join(process.env.HOME, 'reports', ${JSON.stringify(`${name}.json`)}), JSON.stringify({
  execPath: process.execPath, prefix: process.env.npm_config_prefix ?? null, path: process.env.PATH ?? '',
}));
const readline = require('node:readline');
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  if (message.method === 'initialize') {
    send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: ${JSON.stringify(name)}, version: '1.0.0' } } });
  } else if (message.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: message.id, result: { tools: ${JSON.stringify(tools)}.map((tool) => ({ name: tool, description: tool, inputSchema: { type: 'object', properties: {} } })) } });
  } else {
    send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } });
  }
});
`;

describe.runIf(live)('every MCP server on BotBoy\'s own Node (real manager, real SDK client, fake servers standing in for the external ones)', () => {
  let fixture: PrivateNodeFixture;
  let storage: StorageLayer | null = null;
  let manager: McpManager | null = null;
  let bin: string;
  let ownNodeBin: string;
  const secretStore = {
    async get() { return null; }, async set() {}, async delete() {}, async has() { return false; },
  };
  // execPath is the OS's spelling of the file (/var/... or /private/var/...): compare real paths.
  const report = (name: string) => {
    const seen = JSON.parse(fs.readFileSync(path.join(fixture.home, 'reports', `${name}.json`), 'utf8')) as { execPath: string; prefix: string | null; path: string };
    return { ...seen, execPath: fs.realpathSync(seen.execPath) };
  };
  const install = (dir: string, name: string, tools: string[] = ['ping']) => {
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, name);
    fs.writeFileSync(file, fakeServer(name, tools), { mode: 0o755 });
    return file;
  };

  beforeAll(() => {
    fixture = createPrivateNodeFixture();
    bin = path.join(fixture.home, 'external-bin');
    fs.mkdirSync(bin, { recursive: true });
    // A Mac with a Node of its own: a folder on PATH whose node is the one that runs this test.
    ownNodeBin = path.join(fixture.home, 'own-node', 'bin');
    fs.mkdirSync(ownNodeBin, { recursive: true });
    fs.symlinkSync(fs.realpathSync(process.execPath), path.join(ownNodeBin, 'node'));
  }, 120_000);
  afterAll(() => fixture?.cleanup());
  afterEach(async () => {
    await manager?.stop();
    manager = null;
    storage?.close();
    storage = null;
    mocked.useFn = null;
    vi.unstubAllEnvs();
    fs.rmSync(path.join(fixture.home, 'reports'), { recursive: true, force: true });
  });

  /** BotBoy running on its own Node: its PATH has the runtime's bin first, HOME is the fixture's. */
  async function startManager(options: { privateNode: boolean }): Promise<McpManager> {
    vi.stubEnv('HOME', fixture.home);
    vi.stubEnv('PATH', [options.privateNode ? fixture.runtimeBin : ownNodeBin, bin, '/usr/bin', '/bin'].join(path.delimiter));
    if (options.privateNode) {
      const actual = await vi.importActual<typeof import('./protected-local-resources.js')>('./protected-local-resources.js');
      mocked.useFn = () => actual.privateNodeUse({ execPath: fixture.nodeCopy, privateRoot: fixture.privateRoot });
    }
    storage = createStorage(':memory:');
    storage.initialize();
    manager = createMcpManager({ db: storage.getDb(), secretStore, healthIntervalMs: 3_600_000 });
    await manager.start();
    return manager;
  }

  it('the built-in profiles (slack, grasp-m365, sharepoint) run unsandboxed on the runtime\'s node and never get npm\'s global prefix or bin', async () => {
    const programs: Record<string, string> = { slack: 'ai-community-slack-mcp', 'grasp-m365': 'grasp-mcp', sharepoint: 'amazon-sharepoint-mcp' };
    for (const program of Object.values(programs)) install(bin, program);
    const mcp = await startManager({ privateNode: true });
    for (const [profile, program] of Object.entries(programs)) {
      const started = await mcp.startProfile(profile).catch((error: Error) => ({ state: `threw: ${error.message}` }));
      const seen = report(program);
      expect(seen.execPath, `${profile} (${started.state})`).toBe(fixture.nodeCopy);
      expect(seen.prefix, profile).toBeNull();
      // (the test-hygiene net may put its own stub folder in front of PATH; the runtime's bin is still ahead of every real folder)
      const entries = seen.path.split(path.delimiter);
      expect(entries.indexOf(fixture.runtimeBin), `${profile}: PATH ${seen.path}`).toBeGreaterThanOrEqual(0);
      expect(entries.indexOf(fixture.runtimeBin), profile).toBeLessThan(entries.indexOf(bin));
      expect(entries.indexOf(fixture.runtimeBin), profile).toBeLessThan(entries.indexOf('/usr/bin'));
      expect(seen.path, profile).not.toContain('.npm-global');
      await mcp.stopProfile(profile).catch(() => undefined);
    }
  }, 120_000);

  it('the a2-analytics AIM package script runs unsandboxed on the runtime\'s node, without the global bin', async () => {
    const scripts = path.join(fixture.home, '.aim', 'packages', 'A2AnalyticsAgent-1.0', 'eventId-1', 'context', 'scripts');
    fs.mkdirSync(scripts, { recursive: true });
    fs.writeFileSync(path.join(scripts, 'server.js'), fakeServer('a2-analytics', ['ping']).replace(/^#!.*\n/, ''));
    fs.writeFileSync(path.join(scripts, 'mcp-run.sh'), '#!/bin/sh\nexec node "$(dirname "$0")/server.js"\n', { mode: 0o755 });
    const mcp = await startManager({ privateNode: true });
    const started = await mcp.startProfile('a2-analytics').catch((error: Error) => ({ state: `threw: ${error.message}` }));
    const seen = report('a2-analytics');
    expect(seen.execPath, started.state).toBe(fixture.nodeCopy);
    expect(seen.prefix).toBeNull();
    expect(seen.path).not.toContain('.npm-global');
  }, 120_000);

  it('AIM (`aim mcp start-server <name>`) and a toolbox binary (`builder-mcp`) run under the real sandbox on the runtime\'s node, with the global prefix', async () => {
    // `aim` is a program that starts the server: here a shell script that execs `node` from PATH, like a package launcher.
    const aimServer = path.join(bin, 'aim-server.js');
    fs.writeFileSync(aimServer, fakeServer('aim-demo', ['search_docs']).replace(/^#!.*\n/, ''));
    fs.writeFileSync(path.join(bin, 'aim'), `#!/bin/sh\n[ "$1 $2 $3" = "mcp start-server demo" ] || exit 64\nexec node ${JSON.stringify(aimServer)}\n`, { mode: 0o755 });
    install(bin, 'builder-mcp', ['search_docs']);
    const mcp = await startManager({ privateNode: true });

    await mcp.createCustomServer({ name: 'AIM Demo', command: 'aim', args: ['mcp', 'start-server', 'demo'], about: { source: 'aim:demo' } } as never);
    const aim = await mcp.startProfile('custom-aim-demo');
    expect(aim.state).toBe('running');
    const aimSeen = report('aim-demo');
    expect(aimSeen.execPath).toBe(fixture.nodeCopy);
    expect(aimSeen.prefix).toBe(path.join(fixture.home, '.npm-global'));
    expect(aimSeen.path.split(path.delimiter).at(-1)).toBe(path.join(fixture.home, '.npm-global', 'bin'));

    await mcp.createCustomServer({ name: 'Builder', command: 'builder-mcp' });
    const builder = await mcp.startProfile('custom-builder');
    expect(builder.state).toBe('running');
    const builderSeen = report('builder-mcp');
    expect(builderSeen.execPath).toBe(fixture.nodeCopy);
    expect(builderSeen.prefix).toBe(path.join(fixture.home, '.npm-global'));
  }, 120_000);

  it('on a Mac with its own Node the same servers see no private prefix and no global bin', async () => {
    install(bin, 'builder-mcp', ['search_docs']);
    const mcp = await startManager({ privateNode: false });
    await mcp.createCustomServer({ name: 'Builder', command: 'builder-mcp' });
    expect((await mcp.startProfile('custom-builder')).state).toBe('running');
    const seen = report('builder-mcp');
    expect(seen.execPath).toBe(fs.realpathSync(process.execPath)); // its own Node, not the runtime
    expect(seen.prefix).toBeNull();
    expect(seen.path).not.toContain('.npm-global');
  }, 120_000);
});
