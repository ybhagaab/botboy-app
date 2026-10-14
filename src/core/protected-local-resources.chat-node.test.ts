/**
 * Owner decision 2026-10-14 (EXTEND): chat is essential, so run_command and the chat terminal use BotBoy's own Node
 * exactly like a user-added MCP server does (protected-local-resources.runtime-read.test.ts): the sandbox may READ the
 * runtime folder in use, the bb7871a PATH strip is dropped for them, and `node`, `npx` and `npm` resolve to BotBoy's Node.
 * Both run `/bin/zsh -lc`, which has two hazards, proved here through the real zsh with a temporary HOME:
 *   - /etc/zprofile's `path_helper` moves the system folders in front of the inherited PATH;
 *   - a user's ~/.zprofile can reset PATH outright.
 * `modelShellLaunch` starts the command with `export PATH=<runtime bin>...`, after the login files have run.
 * On a Mac with its own Node nothing changes: the profile, the command line and the environment are what they were.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPrivateNodeFixture, livePrivateNode as live, type PrivateNodeFixture } from './private-node-fixture.testutil.js';
import {
  modelCommandSandboxInvocation,
  modelShellLaunch,
  privateNodeUse,
  type PrivateNodeUse,
} from './protected-local-resources.js';

// Each case starts a login shell (and sometimes npm) under sandbox-exec: slow when the machine is busy.
vi.setConfig({ testTimeout: 90_000, hookTimeout: 120_000 });

const execFileAsync = promisify(execFile);
let fixture: PrivateNodeFixture;
let use: PrivateNodeUse;
const PORTS = { appPort: 7778, cdpPort: 9222 };
const baseline = (root: string, files: string) =>
  `(version 1) (allow default) (deny network-outbound (remote ip "localhost:7778")) (deny network-outbound (remote ip "localhost:9222")) (deny appleevent-send) (deny file-read* file-write* (subpath "${root}")) (allow file-read* file-write* (subpath "${files}"))`;

beforeAll(() => {
  fixture = createPrivateNodeFixture();
  use = privateNodeUse({ execPath: fixture.nodeCopy, privateRoot: fixture.privateRoot })!;
}, 120_000);
afterAll(() => fixture?.cleanup());
// The server's HOME is the private root's: os.homedir() (the default private root of the PATH strip) must say so too.
beforeEach(() => {
  vi.stubEnv('HOME', fixture.home);
});
afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(path.join(fixture.home, '.zprofile'), { force: true });
});

/** The environment a server running on BotBoy's Node would hand down: its PATH has the runtime's bin first. */
const serverEnv = (extra: Record<string, string> = {}): Record<string, string> => ({
  HOME: fixture.home,
  USER: 'tester',
  PATH: `${fixture.runtimeBin}${path.delimiter}/usr/bin${path.delimiter}/bin`,
  npm_config_update_notifier: 'false',
  npm_config_cache: path.join(fixture.home, '.npm'),
  ...extra,
});
const launchOf = (command: string, options: Parameters<typeof modelShellLaunch>[1] = {}) =>
  modelShellLaunch(command, { privateRoot: fixture.privateRoot, filesDir: fixture.filesDir, ...PORTS, use, base: serverEnv(), ...options });
const run = async (launch: { executable: string; args: string[]; env: Record<string, string>; filesDir: string }) => {
  try {
    const done = await execFileAsync(launch.executable, launch.args, { cwd: launch.filesDir, env: launch.env, timeout: 90_000 });
    return { ok: true, out: `${done.stdout}${done.stderr}` };
  } catch (error: any) {
    return { ok: false, out: `${error.stdout ?? ''}${error.stderr ?? ''}${error.message ?? ''}` };
  }
};
const profileFile = (text: string) => fs.writeFileSync(path.join(fixture.home, '.zprofile'), text);
const lines = (out: string) => out.trim().split('\n');

describe.runIf(live)('chat commands on BotBoy\'s own Node (the real /bin/zsh -lc under sandbox-exec, temp HOME)', () => {
  const WHICH = 'command -v node; command -v npx; command -v npm; echo "$PATH"';
  const expected = () => ['node', 'npx', 'npm'].map((name) => path.join(fixture.runtimeBin, name));

  it('finds node, npx and npm in BotBoy\'s Node with an empty ~/.zprofile, though path_helper moved the system folders first', async () => {
    profileFile('');
    const result = await run(launchOf(WHICH));
    expect(result.ok, result.out).toBe(true);
    const out = lines(result.out);
    expect(out.slice(0, 3)).toEqual(expected());
    expect(out[3].split(path.delimiter)[0]).toBe(fixture.runtimeBin);
  });

  it('still finds them when ~/.zprofile resets PATH outright, and node, npx and npm run', async () => {
    profileFile('PATH=/usr/bin:/bin\n');
    const found = await run(launchOf(WHICH));
    expect(found.ok, found.out).toBe(true);
    expect(lines(found.out).slice(0, 3)).toEqual(expected());
    const versions = await run(launchOf('node -p process.execPath; npx --version; npm --version'));
    expect(versions.ok, versions.out).toBe(true);
    const out = lines(versions.out);
    expect(out[0]).toBe(fixture.nodeCopy);
    expect(out[1]).toMatch(/^\d+\.\d+\.\d+/);
    expect(out[2]).toMatch(/^\d+\.\d+\.\d+/);
  }, 120_000);

  it('beats another node that ~/.zprofile puts in front', async () => {
    fs.mkdirSync(path.join(fixture.home, 'other', 'bin'), { recursive: true });
    fs.writeFileSync(path.join(fixture.home, 'other', 'bin', 'node'), '#!/bin/sh\necho another-node\n', { mode: 0o755 });
    profileFile('export PATH="$HOME/other/bin:$PATH"\n');
    const result = await run(launchOf('command -v node'));
    expect(result.ok, result.out).toBe(true);
    expect(result.out.trim()).toBe(path.join(fixture.runtimeBin, 'node'));
  });

  it('control: without the PATH line, a profile that resets PATH loses node (the hazard the line removes)', async () => {
    profileFile('PATH=/usr/bin:/bin\n');
    const invocation = modelCommandSandboxInvocation('command -v node || echo "no node"', {
      privateRoot: fixture.privateRoot, filesDir: fixture.filesDir, ...PORTS, runtimeReadDir: use.runtimeDir,
    });
    expect(invocation.args.join(' ')).not.toContain('export PATH=');
    const result = await run({ ...invocation, env: serverEnv(), filesDir: fixture.filesDir });
    expect(result.out.trim()).toBe('no node');
  });

  it('keeps the rest of the sandbox: the saved key, the database and the runtime stay protected, files/ works', async () => {
    profileFile('');
    for (const secret of ['ai-model.json', 'tracker.db']) {
      const read = await run(launchOf(`cat "${path.join(fixture.privateRoot, secret)}"`));
      expect(read.ok, read.out).toBe(false);
      expect(read.out).toMatch(/operation not permitted/i);
      expect(read.out).not.toContain('secretkey');
    }
    const write = await run(launchOf(`echo x > "${path.join(fixture.versionDir, 'new.txt')}"`));
    expect(write.ok, write.out).toBe(false);
    expect(write.out).toMatch(/operation not permitted/i);
    expect(fs.existsSync(path.join(fixture.versionDir, 'new.txt'))).toBe(false);
    const ok = await run(launchOf(`echo workspace > "${path.join(fixture.filesDir, 'chat.txt')}" && cat "${path.join(fixture.filesDir, 'chat.txt')}"`));
    expect(ok.ok, ok.out).toBe(true);
    expect(ok.out.trim()).toBe('workspace');
  });

  it('quotes the PATH line: a runtime folder with a quote, a semicolon and a comment mark in its name runs nothing extra', async () => {
    const odd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "botboy-odd'; touch pwned.txt #")));
    try {
      const root = path.join(odd, '.personal-productivity-tracker');
      const bin = path.join(root, 'runtime', 'node-24.21.0-arm64', 'bin');
      fs.mkdirSync(bin, { recursive: true });
      fs.mkdirSync(path.join(root, 'files'), { recursive: true });
      fs.writeFileSync(path.join(bin, 'node'), '#!/bin/sh\necho odd-node\n', { mode: 0o755 });
      const oddUse = privateNodeUse({ execPath: path.join(bin, 'node'), privateRoot: root })!;
      expect(oddUse).not.toBeNull();
      const launch = modelShellLaunch('command -v node; node', {
        privateRoot: root, filesDir: path.join(root, 'files'), ...PORTS, use: oddUse,
        base: { HOME: odd, PATH: `${bin}${path.delimiter}/usr/bin${path.delimiter}/bin` },
      });
      const result = await run(launch);
      expect(result.ok, result.out).toBe(true);
      expect(lines(result.out)).toEqual([path.join(bin, 'node'), 'odd-node']);
      expect(fs.existsSync(path.join(root, 'files', 'pwned.txt'))).toBe(false);
      expect(fs.existsSync(path.join(odd, 'pwned.txt'))).toBe(false);
    } finally {
      fs.rmSync(odd, { recursive: true, force: true });
    }
  });
});

describe.runIf(live)('npm install -g in chat goes to ~/.npm-global, never into the runtime (owner: global installs must work)', () => {
  const name = 'botboy-tiny-cli';
  let tarball = '';
  beforeAll(() => {
    const pkg = path.join(fixture.tools, 'tiny-pkg');
    fs.mkdirSync(pkg, { recursive: true });
    fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name, version: '1.0.0', bin: { 'botboy-tiny': 'cli.js' } }));
    fs.writeFileSync(path.join(pkg, 'cli.js'), '#!/usr/bin/env node\nconsole.log("tiny-ok " + process.execPath);\n', { mode: 0o755 });
    tarball = path.join(fixture.tools, `${name}-1.0.0.tgz`);
  });
  const npm = '--no-audit --no-fund --offline';

  it('npm pack, npm install -g of the tarball, and its bin by name (after a ~/.zprofile that resets PATH too)', async () => {
    profileFile('PATH=/usr/bin:/bin\n');
    const libs = path.join(fixture.versionDir, 'lib', 'node_modules');
    const runtimeBefore = fs.readdirSync(libs).sort();
    const globalPrefix = path.join(fixture.home, '.npm-global');
    fs.rmSync(globalPrefix, { recursive: true, force: true }); // earlier cases created it: the install must work from nothing

    const packed = await run(launchOf(`cd "${path.join(fixture.tools, 'tiny-pkg')}" && npm pack --silent --pack-destination "${fixture.tools}"`));
    expect(packed.ok, packed.out).toBe(true);
    expect(fs.existsSync(tarball), packed.out).toBe(true);

    const installed = await run(launchOf(`npm install -g "${tarball}" ${npm}`));
    expect(installed.ok, installed.out).toBe(true);
    expect(fs.existsSync(path.join(globalPrefix, 'lib', 'node_modules', name, 'package.json'))).toBe(true);
    expect(fs.lstatSync(path.join(globalPrefix, 'bin', 'botboy-tiny')).isSymbolicLink()).toBe(true);
    expect(fs.readdirSync(libs).sort()).toEqual(runtimeBefore); // nothing was written into the runtime

    const byName = await run(launchOf('command -v botboy-tiny; botboy-tiny; echo "prefix=$npm_config_prefix"'));
    expect(byName.ok, byName.out).toBe(true);
    expect(lines(byName.out)).toEqual([path.join(globalPrefix, 'bin', 'botboy-tiny'), `tiny-ok ${fixture.nodeCopy}`, `prefix=${globalPrefix}`]);
  }, 180_000);

  it('a local install in a project folder still goes into that project (the prefix only moves GLOBAL installs)', async () => {
    const project = path.join(fixture.filesDir, 'proj');
    fs.mkdirSync(project, { recursive: true });
    fs.writeFileSync(path.join(project, 'package.json'), '{"name":"proj","version":"1.0.0"}');
    const result = await run(launchOf(`cd "${project}" && npm install "${tarball}" ${npm} && ls node_modules`));
    expect(result.ok, result.out).toBe(true);
    expect(fs.existsSync(path.join(project, 'node_modules', name, 'package.json'))).toBe(true);
  }, 180_000);

  it('the global bin is last: a command found earlier is never shadowed by it', async () => {
    fs.mkdirSync(path.join(fixture.home, 'early', 'bin'), { recursive: true });
    fs.writeFileSync(path.join(fixture.home, 'early', 'bin', 'botboy-tiny'), '#!/bin/sh\necho early-one\n', { mode: 0o755 });
    profileFile(`export PATH="${path.join(fixture.home, 'early', 'bin')}:$PATH"\n`);
    const result = await run(launchOf('botboy-tiny'));
    expect(result.out.trim()).toBe('early-one');
  });
});

describe('a Mac that uses its own Node is untouched (byte-identical)', () => {
  const command = 'ls; echo "$PATH"';
  const strippedBase = () => ({ HOME: fixture.home, PATH: `${fixture.runtimeBin}${path.delimiter}/opt/homebrew/bin${path.delimiter}/usr/bin`, TOKEN: 'owner-cli-token' });

  it('the profile, the command line and the environment are what they were', () => {
    vi.stubEnv('HOME', fixture.home); // the default private root, whose runtime folder the old PATH strip knew
    const launch = modelShellLaunch(command, { privateRoot: fixture.privateRoot, filesDir: fixture.filesDir, ...PORTS, use: null, base: strippedBase() });
    expect(launch.args).toEqual(['-p', baseline(fixture.privateRoot, fixture.filesDir), '/bin/zsh', '-lc', command]);
    expect(launch.env).toEqual({
      HOME: fixture.home,
      PATH: `/opt/homebrew/bin${path.delimiter}/usr/bin`,
      TOKEN: 'owner-cli-token',
      BOTBOY_FILES: fixture.filesDir,
    });
    expect(launch.env).not.toHaveProperty('npm_config_prefix');
  });

  it('the process default is the same answer when this process runs on a Node of its own', () => {
    expect(privateNodeUse({ privateRoot: fixture.privateRoot })).toBeNull(); // process.execPath is not under the temp private root
    vi.stubEnv('HOME', fixture.home);
    expect(privateNodeUse()).toBeNull();
    const launch = modelShellLaunch(command, { privateRoot: fixture.privateRoot, filesDir: fixture.filesDir, ...PORTS, base: strippedBase() });
    expect(launch.args[1]).toBe(baseline(fixture.privateRoot, fixture.filesDir));
    expect(launch.args.slice(2)).toEqual(['/bin/zsh', '-lc', command]);
  });

  it('a login-shell PATH line is never added unless the runtime rules were added', () => {
    const invocation = modelCommandSandboxInvocation(command, { privateRoot: fixture.privateRoot, filesDir: fixture.filesDir, ...PORTS, loginPathFirst: ['/x/bin'] });
    expect(invocation.args).toEqual(['-p', baseline(fixture.privateRoot, fixture.filesDir), '/bin/zsh', '-lc', command]);
    expect(invocation.runtimeRead).toBe(false);
  });

  it('when the sandbox cannot open the runtime, the runtime is not on PATH either (no half-working Node)', () => {
    vi.stubEnv('HOME', fixture.home);
    const elsewhere = path.join(fixture.home, 'elsewhere-root');
    fs.mkdirSync(path.join(elsewhere, 'files'), { recursive: true });
    const launch = modelShellLaunch(command, { privateRoot: elsewhere, filesDir: path.join(elsewhere, 'files'), ...PORTS, use, base: strippedBase() });
    expect(launch.args).toEqual(['-p', baseline(elsewhere, path.join(elsewhere, 'files')), '/bin/zsh', '-lc', command]);
    expect(launch.env.PATH).toBe(`/opt/homebrew/bin${path.delimiter}/usr/bin`);
  });

  it('~/.npm-global/bin is created on first use while BotBoy\'s Node is in use, and never otherwise', () => {
    const prefix = path.join(fixture.home, '.npm-global');
    fs.rmSync(prefix, { recursive: true, force: true });
    modelShellLaunch(command, { privateRoot: fixture.privateRoot, filesDir: fixture.filesDir, ...PORTS, use: null, base: strippedBase() });
    expect(fs.existsSync(prefix)).toBe(false);
    modelShellLaunch(command, { privateRoot: fixture.privateRoot, filesDir: fixture.filesDir, ...PORTS, use, base: strippedBase() });
    expect(fs.statSync(path.join(prefix, 'bin')).isDirectory()).toBe(true);
    // a prefix the child already carries is replaced by ours for chat (npm's EACCES fix), the upper-case twin too
    const launch = modelShellLaunch(command, { privateRoot: fixture.privateRoot, filesDir: fixture.filesDir, ...PORTS, use, base: { ...strippedBase(), npm_config_prefix: '/old/prefix', NPM_CONFIG_PREFIX: '/old/upper' } });
    expect(launch.env.npm_config_prefix).toBe(prefix);
    expect(launch.env).not.toHaveProperty('NPM_CONFIG_PREFIX');
  });

  it('with the runtime in use, the environment keeps BotBoy\'s Node on PATH and credentials are still removed', () => {
    const launch = modelShellLaunch(command, {
      privateRoot: fixture.privateRoot, filesDir: fixture.filesDir, ...PORTS, use,
      base: { ...strippedBase(), BOTBOY_INFERENCE_API_KEY: 'secret' },
      extraEnv: { TERM: 'xterm-256color' },
    });
    // The runtime's bin stays where it was (first); npm's global bin is added at the END, and the prefix points at it.
    expect(launch.env.PATH).toBe(`${fixture.runtimeBin}${path.delimiter}/opt/homebrew/bin${path.delimiter}/usr/bin${path.delimiter}${use.globalBin}`);
    expect(launch.env.npm_config_prefix).toBe(path.join(fixture.home, '.npm-global'));
    expect(launch.env).not.toHaveProperty('BOTBOY_INFERENCE_API_KEY');
    expect(launch.env).toMatchObject({ TOKEN: 'owner-cli-token', BOTBOY_FILES: fixture.filesDir, TERM: 'xterm-256color' });
    expect(launch.args[3]).toBe('-lc');
    expect(launch.args[4]).toBe(`export PATH='${fixture.runtimeBin}'\${PATH:+:"$PATH"}:'${use.globalBin}'; ${command}`);
  });
});
