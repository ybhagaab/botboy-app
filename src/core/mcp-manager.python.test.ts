/**
 * The MCP manager and BotBoy's own uv and CPython (Python on demand; design review findings 4, 7 and 13; orchestrator
 * clarifications 1, 2 and 4):
 *  - a user-added command that lives only in ~/.botboy-python/bin (`uv tool install` / `pip install --user` from chat)
 *    is found by its bare name, LAST, after ~/.npm-global/bin, while BotBoy's uv or Python is in use; built-in launches
 *    never search it (10e invariant, extended);
 *  - a sandboxed user-added server keeps on PATH only the runtime folders its profile opened, and gets ~/.botboy-python
 *    the same way chat does (pip settings only while BotBoy's CPython is the python3 in use);
 *  - "Command not found" for uv, uvx and python3 names the doctor row and a start while online;
 *  - the setup terminal: a login-shell script starts with BotBoy's Python bin while that Python is in use; a2's launch
 *    and terminal lose BotBoy's Python only under the live-run switch, and get exactly every other built-in's PATH without it.
 * The sandbox call is replaced by a pass-through that records what the manager asked for (the real sandbox is proved in
 * protected-local-resources.python.test.ts).
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { a2PathForLiveRun, commandNotFound, createMcpManager, setupTerminalArgs } from './mcp-manager.js';
import { A2_ANALYTICS_PROFILE_ID, getBuiltInMcpProfile, resolveCommandExecutable, resolveDefinitionExecutable, type McpServerDefinition } from './mcp-profiles.js';
import type { McpManager } from './mcp-types.js';
import type { PythonRuntimeUse, RuntimeOpened } from './protected-local-resources.js';
import { createStorage, type StorageLayer } from './storage.js';

vi.setConfig({ testTimeout: 60_000 });
const execFileAsync = promisify(execFile);

const mocked = vi.hoisted(() => ({
  python: null as null | PythonRuntimeUse,
  opened: {} as RuntimeOpened,
  clt: true as boolean | null,
  sandboxCalls: [] as Array<{ executable: string; args: string[]; options: Record<string, unknown> | undefined }>,
}));
vi.mock('./protected-local-resources.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('./protected-local-resources.js')>();
  return {
    ...original,
    privateNodeUse: () => null,
    pythonRuntimeUse: () => mocked.python,
    modelProcessSandboxInvocation: (executable: string, args: string[], options?: Record<string, unknown>) => {
      mocked.sandboxCalls.push({ executable, args, options });
      return { executable, args, filesDir: '', profile: '', runtimeRead: Object.keys(mocked.opened).length > 0, opened: mocked.opened };
    },
  };
});
vi.mock('./command-line-tools.js', () => ({
  commandLineToolsKnown: () => mocked.clt,
  refreshCommandLineTools: async () => mocked.clt === true,
  resetCommandLineToolsForTests: () => undefined,
}));

const roots: string[] = [];
const temp = () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'botboy-mcp-python-')));
  roots.push(dir);
  return dir;
};
const script = (file: string, body: string) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
};
/** A stand-in runtime under `home`, named as scripts/python-runtime.sh names it. */
function runtimeIn(home: string) {
  const runtime = path.join(home, '.personal-productivity-tracker', 'runtime');
  const uvDir = path.join(runtime, 'uv-0.13.0-arm64');
  const pythonRoot = path.join(runtime, 'python');
  const patch = path.join(pythonRoot, 'cpython-3.13.16-macos-aarch64-none');
  const minor = path.join(pythonRoot, 'cpython-3.13-macos-aarch64-none');
  script(path.join(patch, 'bin', 'python3.13'), 'echo "botboy-cpython 3.13.16"');
  fs.symlinkSync('python3.13', path.join(patch, 'bin', 'python3'));
  fs.symlinkSync(patch, minor);
  script(path.join(uvDir, 'uv'), 'echo uv 0.13.0');
  script(path.join(uvDir, 'uvx'), 'echo uvx 0.13.0');
  const userBase = path.join(home, '.botboy-python');
  return { runtime, uvDir, pythonRoot, pythonBin: path.join(minor, 'bin'), userBase, userBin: path.join(userBase, 'bin') };
}
const useOf = (r: ReturnType<typeof runtimeIn>, parts: { uv?: boolean; python?: boolean }): PythonRuntimeUse => ({
  uv: parts.uv ? { uvDir: r.uvDir, pythonRoot: r.pythonRoot } : null,
  python: parts.python ? { pythonRoot: r.pythonRoot, pythonBin: r.pythonBin } : null,
  userBase: r.userBase,
  userBin: r.userBin,
});

afterEach(() => {
  vi.unstubAllEnvs();
  mocked.python = null;
  mocked.opened = {};
  mocked.clt = true;
  mocked.sandboxCalls.length = 0;
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('"Command not found" for uv, uvx and python3 names the next action (review finding 13)', () => {
  it('uv and uvx: the doctor row "uv source" and a start while online', () => {
    const uvx = 'Command not found: uvx. BotBoy sets up its own uv at start and has not done so yet on this Mac (./start.sh --doctor, row "uv source"): run ./start.sh again while online, or install uv yourself, then press Start.';
    expect(commandNotFound('uvx')).toBe(uvx);
    expect(commandNotFound('uv')).toBe(uvx.replace('Command not found: uvx.', 'Command not found: uv.'));
    expect(commandNotFound('/opt/homebrew/bin/uvx')).toContain('row "uv source"');
  });
  it('python3 and its versioned names: the doctor row "python source"', () => {
    for (const name of ['python3', 'python3.12', 'python']) {
      expect(commandNotFound(name)).toBe(`Command not found: ${name}. BotBoy sets up its own Python at start and has not done so yet on this Mac (./start.sh --doctor, row "python source"): run ./start.sh again while online, or install Python 3.10 or newer yourself, then press Start.`);
    }
  });
  it('anything else keeps its text', () => {
    expect(commandNotFound('foo-mcp')).toBe('Command not found: foo-mcp. If it is an npm program, ask BotBoy in chat to install it, then press Start again.');
    expect(commandNotFound('python3-mcp')).toContain('If it is an npm program');
  });
});

describe('where a launch command is looked up (10e invariant, extended to ~/.botboy-python/bin)', () => {
  const custom = (command: string) => ({ launch: { type: 'custom-command', command, args: [] } }) as unknown as McpServerDefinition;
  const builtIn = (executableName: string) => ({ launch: { type: 'local-executable', executableName } }) as unknown as McpServerDefinition;

  it('a user-added command found only in ~/.botboy-python/bin resolves there, LAST; a built-in never does', async () => {
    const r = runtimeIn(temp());
    script(path.join(r.userBin, 'botboy-py-probe'), 'exit 0');
    const npmBin = path.join(path.dirname(r.userBase), '.npm-global', 'bin');
    expect(await resolveDefinitionExecutable(custom('botboy-py-probe'), '/usr/bin', [npmBin, r.userBin])).toBe(path.join(r.userBin, 'botboy-py-probe'));
    expect(await resolveDefinitionExecutable(builtIn('botboy-py-probe'), '/usr/bin', [npmBin, r.userBin])).toBeNull();
    // npm's global bin comes first, and any folder on PATH comes before both.
    script(path.join(npmBin, 'botboy-py-probe'), 'exit 0');
    expect(await resolveCommandExecutable('botboy-py-probe', '/usr/bin', [npmBin, r.userBin])).toBe(path.join(npmBin, 'botboy-py-probe'));
    const first = path.join(path.dirname(r.userBase), 'first');
    script(path.join(first, 'botboy-py-probe'), 'exit 0');
    expect(await resolveCommandExecutable('botboy-py-probe', first, [npmBin, r.userBin])).toBe(path.join(first, 'botboy-py-probe'));
  });

  it('the manager adds ~/.botboy-python/bin only while BotBoy\'s uv or Python is in use, and through one helper', async () => {
    const home = temp();
    const r = runtimeIn(home);
    script(path.join(r.userBin, 'botboy-py-probe'), 'exit 0');
    const storage = createStorage(':memory:');
    storage.initialize();
    const manager = createMcpManager({ db: storage.getDb(), secretStore: memorySecrets(), healthIntervalMs: 3_600_000 });
    await manager.start();
    try {
      expect((await manager.createCustomServer({ name: 'Py Probe', command: 'botboy-py-probe' })).installationState).toBe('not_installed');
      mocked.python = useOf(r, { uv: true });
      expect((await manager.createCustomServer({ name: 'Py Probe Two', command: 'botboy-py-probe' })).installationState).toBe('installed');
    } finally {
      await manager.stop();
      storage.close();
    }
    const source = fs.readFileSync(new URL('./mcp-manager.ts', import.meta.url), 'utf8');
    expect(source.match(/resolveDefinitionExecutable\(/g)).toHaveLength(1);
    expect(source).toContain('return [...(use ? [use.globalBin] : []), ...(python ? [python.userBin] : [])];');
    expect(source.match(/pythonUserEnvironment\(/g)).toHaveLength(1);
  });
});

function memorySecrets() {
  const secrets = new Map<string, string>();
  return {
    async get(id: string, key: string) { return secrets.get(`${id}:${key}`) ?? null; },
    async set(id: string, key: string, value: string) { secrets.set(`${id}:${key}`, value); },
    async delete(id: string, key: string) { secrets.delete(`${id}:${key}`); },
    async has(id: string, key: string) { return secrets.has(`${id}:${key}`); },
  };
}

// A minimal newline-delimited JSON-RPC MCP server; its one tool reports the environment it was started with.
const ENV_PROBE = `
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
    const pick = ['PATH', 'PYTHONUSERBASE', 'PIP_BREAK_SYSTEM_PACKAGES', 'PIP_USER', 'UV_PYTHON_INSTALL_DIR', 'UV_MANAGED_PYTHON'];
    send({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: JSON.stringify(Object.fromEntries(pick.map((k) => [k, process.env[k] ?? null]))) }] } });
  } else {
    send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } });
  }
});
`;

describe('the environment of a sandboxed user-added server', () => {
  type Seen = Record<'PATH' | 'PYTHONUSERBASE' | 'PIP_BREAK_SYSTEM_PACKAGES' | 'PIP_USER' | 'UV_PYTHON_INSTALL_DIR' | 'UV_MANAGED_PYTHON', string | null>;
  async function start(env?: Record<string, string>): Promise<Seen> {
    const dir = temp();
    fs.writeFileSync(path.join(dir, 'env-probe.cjs'), ENV_PROBE);
    const storage = createStorage(':memory:');
    storage.initialize();
    const manager: McpManager = createMcpManager({ db: storage.getDb(), secretStore: memorySecrets(), healthIntervalMs: 3_600_000 });
    await manager.start();
    try {
      await manager.createCustomServer({ name: 'Env Probe', command: process.execPath, args: [path.join(dir, 'env-probe.cjs')], ...(env ? { env } : {}) });
      expect((await manager.startProfile('custom-env-probe')).state).toBe('running');
      const result = await manager.callTool('custom-env-probe', 'get_env', {});
      expect(result.isError).toBe(false);
      return JSON.parse(result.text) as Seen;
    } finally {
      await manager.stop();
      storage.close();
    }
  }
  /** The server's own PATH as start.sh leaves it while BotBoy's Python and uv are in use (HOME is the test's). */
  const serverPath = (r: ReturnType<typeof runtimeIn>) => {
    vi.stubEnv('HOME', path.dirname(r.userBase));
    vi.stubEnv('PATH', [r.pythonBin, r.uvDir, process.env.PATH].join(path.delimiter));
  };

  it('BotBoy\'s Python in use and opened: its entries stay, ~/.botboy-python/bin last, pip settings, no UV_* and no PIP_USER', async () => {
    const r = runtimeIn(temp());
    serverPath(r);
    mocked.python = useOf(r, { uv: true, python: true });
    mocked.opened = { uv: r.uvDir, python: r.pythonRoot };
    mocked.clt = false;
    const seen = await start();
    const entries = seen.PATH!.split(path.delimiter);
    expect(entries.filter((entry) => entry === r.pythonBin || entry === r.uvDir)).toEqual([r.pythonBin, r.uvDir]);
    expect(entries.at(-1)).toBe(r.userBin);
    expect(seen).toMatchObject({ PYTHONUSERBASE: r.userBase, PIP_BREAK_SYSTEM_PACKAGES: '1', PIP_USER: null, UV_PYTHON_INSTALL_DIR: null, UV_MANAGED_PYTHON: null });
    expect(fs.statSync(r.userBase).mode & 0o777).toBe(0o700);
    expect(mocked.sandboxCalls).toHaveLength(1);
    expect(mocked.sandboxCalls[0].options).toEqual({ runtimeReadDir: undefined, uvReadDir: r.uvDir, pythonReadDir: r.pythonRoot, denyXcodeStandIns: true });
  });

  it('a value the owner declared for the server is kept', async () => {
    const r = runtimeIn(temp());
    serverPath(r);
    mocked.python = useOf(r, { uv: true, python: true });
    mocked.opened = { uv: r.uvDir, python: r.pythonRoot };
    const seen = await start({ PYTHONUSERBASE: '/declared/base', PIP_BREAK_SYSTEM_PACKAGES: '0' });
    expect(seen).toMatchObject({ PYTHONUSERBASE: '/declared/base', PIP_BREAK_SYSTEM_PACKAGES: '0' });
    expect(mocked.sandboxCalls[0].options).toMatchObject({ denyXcodeStandIns: false }); // the tools are there
  });

  it('BotBoy\'s uv with this Mac\'s own Python: the bin is added, pip settings are not (clarification 1)', async () => {
    const r = runtimeIn(temp());
    vi.stubEnv('HOME', path.dirname(r.userBase));
    vi.stubEnv('PATH', [r.uvDir, process.env.PATH].join(path.delimiter));
    mocked.python = useOf(r, { uv: true });
    mocked.opened = { uv: r.uvDir, python: r.pythonRoot };
    const seen = await start();
    expect(seen.PATH!.split(path.delimiter)).toContain(r.uvDir);
    expect(seen.PATH!.split(path.delimiter).at(-1)).toBe(r.userBin);
    expect(seen).toMatchObject({ PYTHONUSERBASE: null, PIP_BREAK_SYSTEM_PACKAGES: null });
  });

  it('a profile that opened no Python folder (fail closed, review finding 4): the runtime entries leave PATH and nothing is added', async () => {
    const r = runtimeIn(temp());
    serverPath(r);
    mocked.python = useOf(r, { uv: true, python: true });
    mocked.opened = {};
    const seen = await start();
    const entries = seen.PATH!.split(path.delimiter);
    expect(entries).not.toContain(r.pythonBin);
    expect(entries).not.toContain(r.uvDir);
    expect(entries).not.toContain(r.userBin);
    expect(seen).toMatchObject({ PYTHONUSERBASE: null, PIP_BREAK_SYSTEM_PACKAGES: null });
    expect(fs.existsSync(r.userBase)).toBe(false);
  });

  it('nothing of BotBoy\'s in use: the sandbox call is what it was', async () => {
    const seen = await start();
    expect(seen).toMatchObject({ PYTHONUSERBASE: null, PIP_BREAK_SYSTEM_PACKAGES: null });
    expect(mocked.sandboxCalls[0].options).toEqual({ runtimeReadDir: undefined });
  });
});

describe('a2 and the setup terminal (review finding 7, clarification 2)', () => {
  const a2 = A2_ANALYTICS_PROFILE_ID;

  it('without the live-run switch a2 gets exactly the PATH of every other built-in, launch and terminal alike', () => {
    const r = runtimeIn(temp());
    vi.stubEnv('HOME', path.dirname(r.userBase));
    const value = [r.pythonBin, r.uvDir, '/usr/bin'].join(path.delimiter);
    for (const env of [{}, { BOTBOY_TEST_PREFER_PRIVATE_PYTHON: '0' }, { BOTBOY_PYTHON_RUNTIME: 'private' }]) {
      expect(a2PathForLiveRun(a2, value, env)).toBe(value);
      expect(a2PathForLiveRun(a2, value, env)).toBe(a2PathForLiveRun('slack', value, env));
    }
    // Both a2 paths go through the helper: the launch and the terminal environment.
    const source = fs.readFileSync(new URL('./mcp-manager.ts', import.meta.url), 'utf8');
    expect(source).toContain('childEnv.PATH = a2PathForLiveRun(serverId, pathValueWithFallbackDirectories(childEnv.PATH ?? process.env.PATH));');
    expect(source).toContain('PATH: a2PathForLiveRun(profileId, pathValueWithFallbackDirectories(base.PATH ?? process.env.PATH)),');
    expect(source).toContain('args: setupTerminalArgs(command.argv, env.PATH),');
  });

  it('under BOTBOY_TEST_PREFER_PRIVATE_PYTHON=1 only a2 loses BotBoy\'s Python bin (it stays on the owner\'s Python); uv stays', () => {
    const r = runtimeIn(temp());
    vi.stubEnv('HOME', path.dirname(r.userBase));
    const value = [r.pythonBin, r.uvDir, '/usr/bin'].join(path.delimiter);
    const live = { BOTBOY_TEST_PREFER_PRIVATE_PYTHON: '1' };
    expect(a2PathForLiveRun(a2, value, live)).toBe([r.uvDir, '/usr/bin'].join(path.delimiter));
    expect(a2PathForLiveRun('slack', value, live)).toBe(value);
  });

  it('a login-shell setup script starts with BotBoy\'s Python bin while that Python is in use; everything else is byte-identical', () => {
    const r = runtimeIn(temp());
    const privateRoot = path.join(path.dirname(r.userBase), '.personal-productivity-tracker');
    const inUse = [r.pythonBin, '/usr/bin'].join(path.delimiter);
    const line = `export PATH='${r.pythonBin}'\${PATH:+:"$PATH"}; `;
    expect(setupTerminalArgs(['bash', '-lc', 'echo hi'], inUse, privateRoot)).toEqual(['-lc', `${line}echo hi`]);
    expect(setupTerminalArgs(['/bin/zsh', '-lc', 'echo hi'], inUse, privateRoot)).toEqual(['-lc', `${line}echo hi`]);
    for (const argv of [['aim', 'agents', 'install', 'A2AnalyticsAgent'], ['bash', '-c', 'echo hi'], ['sh', '-lc', 'echo hi'], ['bash', '-lc', 'echo hi', 'extra']]) {
      expect(setupTerminalArgs(argv, inUse, privateRoot)).toEqual(argv.slice(1));
    }
    // Not in use (this Mac's own Python, or a2 in the live run whose PATH lost BotBoy's bin): byte-identical.
    expect(setupTerminalArgs(['bash', '-lc', 'echo hi'], '/usr/bin', privateRoot)).toEqual(['-lc', 'echo hi']);
    vi.stubEnv('HOME', path.dirname(r.userBase));
    expect(setupTerminalArgs(['bash', '-lc', 'echo hi'], a2PathForLiveRun(a2, inUse, { BOTBOY_TEST_PREFER_PRIVATE_PYTHON: '1' }), privateRoot)).toEqual(['-lc', 'echo hi']);
    // The real a2 step is such a script.
    const step = getBuiltInMcpProfile(a2)!.terminalCommands.find((command) => command.id === 'python-deps')!;
    expect(step.argv.slice(0, 2)).toEqual(['bash', '-lc']);
    expect(setupTerminalArgs(step.argv, inUse, privateRoot)).toEqual(['-lc', `${line}${step.argv[2]}`]);
  });

  it('the a2 texts name BotBoy\'s own Python instead of a Homebrew install (review finding 7)', () => {
    const profile = getBuiltInMcpProfile(a2)!;
    expect(JSON.stringify(profile)).not.toContain('brew install python');
    const step = profile.ui.steps.find((entry) => entry.title === 'Install the Python MCP library')!;
    expect(step.description).toContain("Needs Python 3.10 or newer. BotBoy uses this Mac's own Python when it has one, otherwise its own Python 3.13, which ./start.sh sets up.");
    const script = profile.terminalCommands.find((command) => command.id === 'python-deps')!.argv[2];
    expect(script).toContain('echo "No Python 3.10+ found — the ETL server needs one. BotBoy sets up its own Python 3.13 when ./start.sh runs while online');
  });

  it.runIf(process.platform === 'darwin')('the real bash -lc finds BotBoy\'s python3.13 though ~/.bash_profile resets PATH (nothing is run)', async () => {
    const home = temp();
    const r = runtimeIn(home);
    const privateRoot = path.join(home, '.personal-productivity-tracker');
    fs.writeFileSync(path.join(home, '.bash_profile'), 'PATH=/usr/bin:/bin\n');
    const pathValue = [r.pythonBin, '/usr/bin', '/bin'].join(path.delimiter);
    const probe = 'command -v python3.13 || echo none';
    const env = { HOME: home, USER: 'tester', PATH: pathValue, TERM: 'xterm-256color' };
    const withLine = await execFileAsync('/bin/bash', setupTerminalArgs(['bash', '-lc', probe], pathValue, privateRoot), { env, cwd: home });
    expect(withLine.stdout.trim()).toBe(path.join(r.pythonBin, 'python3.13'));
    // Control: the same login shell without the line has lost it.
    const without = await execFileAsync('/bin/bash', ['-lc', probe], { env, cwd: home });
    expect(without.stdout.trim()).toBe('none');
  });
});
