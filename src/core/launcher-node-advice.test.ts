/**
 * What BotBoy tells a Mac with only macOS, Chrome and Node about Node itself (design 5.9, 5.10: F-D and F-F).
 *
 * - F-D: "brew install node" is wrong advice on a bare Mac (Homebrew installs the Command Line Tools first),
 *   so every place that says how to get Node names the nodejs.org installer and Node 24 or newer (the LTS
 *   download). Not Node 22: its npm 10.9.x crashes on `npm install` for this project (npm/cli#8261).
 * - F-F: a doctor advice row for a Node below 22 (Node 20 reached end-of-life on 2026-04-30 and compiles the
 *   database module on install; the doctor's own `node:` line already names the Node in use, so a current Node
 *   gets no second row) and for a Node with npm 10.9.x on a first install, while nothing is installed yet (a Mac
 *   whose BotBoy already runs gets none), and one calm line BEFORE an npm install on a Mac that has Node below 22 and
 *   no Command Line Tools. The line never blocks the install, and an ordinary start never prints it.
 *
 * Node is a stub that answers --version and otherwise runs the real node; npm and xcode-select are stubs.
 * HOME is private. Nothing here installs anything.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: 90_000 });

const packageRoot = fileURLToPath(new URL('../../', import.meta.url));
const launcherPath = path.join(packageRoot, 'start.sh');
const distribution = fs.existsSync(path.join(packageRoot, '.botboy-distribution'));
const roots: string[] = [];
afterEach(() => {
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

function box(options: { version: string; clt: boolean; dependencies?: boolean }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'botboy-node-advice-'));
  roots.push(root);
  const dir = path.join(root, 'app');
  const stubs = path.join(root, 'stubs');
  const home = path.join(root, 'home');
  for (const d of [dir, stubs, home]) fs.mkdirSync(d, { recursive: true });
  fs.copyFileSync(launcherPath, path.join(dir, 'start.sh'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', ...(options.dependencies ? { dependencies: { 'left-pad': '1.3.0' } } : {}) }));
  const stub = (name: string, body: string) => {
    const file = path.join(stubs, name);
    fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    return file;
  };
  const node = stub('node', `if [ "$1" = "--version" ]; then echo '${options.version}'; exit 0; fi\nexec '${process.execPath}' "$@"`);
  const npmCalls = path.join(root, 'npm-calls');
  const npm = stub('npm', `echo "$@" >> '${npmCalls}'\nexit 1`);
  const xcodeSelect = stub('xcode-select', options.clt ? 'echo /stub/clt' : 'exit 2');
  const env = (extra: Record<string, string> = {}) => {
    const base: Record<string, string | undefined> = { ...process.env };
    for (const key of ['BOTBOY_NATIVE_REEXEC', 'BOTBOY_REEXEC_FROM']) delete base[key];
    return {
      ...base,
      HOME: home,
      PPT_LOG_FILE: path.join(root, 'launcher.log'),
      BOTBOY_NO_ARCH_REEXEC: '1',
      BOTBOY_TEST_HW_ARM64: '0',
      BOTBOY_TEST_NODE_BIN: node,
      BOTBOY_TEST_NPM_BIN: npm,
      BOTBOY_TEST_XCODE_SELECT_BIN: xcodeSelect,
      BOTBOY_TEST_LSOF_BIN: stub('lsof', ''),
      ...extra,
    } as Record<string, string>;
  };
  const run = (hook: string, args: string[] = []) =>
    spawnSync('/bin/bash', [path.join(dir, 'start.sh'), ...args], { cwd: dir, env: env({ [hook]: '1' }), encoding: 'utf8', timeout: 60_000 });
  return { run, npmCalls: () => (fs.existsSync(npmCalls) ? fs.readFileSync(npmCalls, 'utf8').trim().split('\n') : []) };
}

describe('F-D: the advice names the nodejs.org installer, not Homebrew', () => {
  const launcher = fs.readFileSync(launcherPath, 'utf8');
  it('start.sh says Node 24 or newer from nodejs.org when node is missing', () => {
    expect(launcher).toContain('❌ node not found — install Node 24 or newer from nodejs.org (the LTS download; the installer needs no other tools), then re-run ./start.sh');
    expect(launcher).not.toContain('brew install node');
    expect(launcher).not.toMatch(/install Node 22 or newer/);
    expect(fs.readFileSync(path.join(packageRoot, 'scripts', 'node-runtime.sh'), 'utf8')).not.toMatch(/install Node 22 or newer|brew install node/);
  });
  const agrees = (doc: string) => {
    const text = fs.readFileSync(path.join(packageRoot, doc), 'utf8');
    expect(text, doc).not.toContain('brew install node');
    expect(text, doc).toContain('Node 24 or newer');
    expect(text, doc).toContain('nodejs.org');
    expect(text, doc).not.toMatch(/Node(\.js)? 22 or newer/);
  };
  it('the tool registry hint and the teammate setup page agree', () => {
    expect(fs.readFileSync(path.join(packageRoot, 'src', 'core', 'toolchain.ts'), 'utf8')).toContain("installHint: 'install Node 24 or newer from nodejs.org (the LTS download; the installer needs no other tools)'");
    agrees('docs/TEAMMATE_SETUP.md');
  });
  // docs/release/README.md is not in the release allowlist (it ships as the ROOT README of botboy-app), so a
  // distribution checkout has no such file (design amendment 14(d)).
  it.skipIf(distribution || !fs.existsSync(path.join(packageRoot, 'docs', 'release', 'README.md')))('the release README agrees too', () => {
    agrees('docs/release/README.md');
  });
});

// BotBoy's Node 24 needs macOS 13.5. On macOS 13.0 to 13.4 updating macOS comes first (a free update on Ventura);
// only a Mac that cannot update installs Node 22 and npm 11 (Node 22's npm 10.9 cannot do the first install).
// scripts/node-runtime.sh › node_runtime_fail macos says the same (node-runtime.test.ts runs it).
describe('a macOS below the pinned Node\'s floor: update macOS first, Node 22 + npm 11 only when the Mac cannot update', () => {
  const FREE_UPDATE = 'on macOS 13 Ventura, 13.5 or newer is a free update';
  const WAY_ROUND = "Only if your Mac cannot update: install Node 22 from nodejs.org, run `sudo npm install -g npm@11` once in Terminal (it asks for your Mac password; Node 22's own npm 10.9 cannot do BotBoy's first install), then run `./start.sh`";
  const says = (doc: string, times: number) => {
    const text = fs.readFileSync(path.join(packageRoot, doc), 'utf8').replace(/\s+/g, ' ');
    const at = [...text.matchAll(new RegExp(WAY_ROUND.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'))].map((match) => match.index!);
    expect(at, doc).toHaveLength(times);
    for (const index of at) {
      // Each time, the update comes first, in the same sentence or the one just before.
      const before = text.slice(Math.max(0, index - 260), index);
      expect(before, doc).toContain('System Settings > General > Software Update');
      expect(before, doc).toContain(FREE_UPDATE);
    }
  };
  it('the teammate setup page says so under Start here and in the troubleshooting row', () => {
    says('docs/TEAMMATE_SETUP.md', 2);
  });
  it.skipIf(distribution || !fs.existsSync(path.join(packageRoot, 'docs', 'release', 'README.md')))('the release README says so too', () => {
    says('docs/release/README.md', 1);
  });
});

describe('F-F: the doctor node advice row', () => {
  it('says a Node below 22 is end-of-life and what to install, and names the reason', () => {
    expect(box({ version: 'v20.19.0', clt: true }).run('BOTBOY_TEST_DOCTOR_NODE').stdout.trim())
      .toBe("node advice: Node 20 is end-of-life and compiles BotBoy's database module on install, which needs the Command Line Tools. Install Node 24 or newer from nodejs.org (the LTS download); its installer needs no other tools.");
    expect(box({ version: 'v21.7.3', clt: false }).run('BOTBOY_TEST_DOCTOR_NODE').stdout.trim()).toContain('node advice: Node 21 is end-of-life');
  });
  it('prints nothing for a Node at 22 or above, or a version it cannot read (the doctor already names the Node in use)', () => {
    for (const version of ['v22.11.0', 'v24.1.0', 'v26.8.2', 'not a version']) {
      const result = box({ version, clt: true }).run('BOTBOY_TEST_DOCTOR_NODE');
      expect(result.status, version).toBe(0);
      expect(result.stdout, version).toBe('');
    }
  });
  it('is part of the real doctor output, once, right after the shutdown-recovery row', () => {
    const source = fs.readFileSync(launcherPath, 'utf8');
    const doctor = source.slice(source.indexOf('if [ "$DOCTOR" = "1" ]; then'));
    expect(doctor.match(/^ {2}doctor_node_row$/gm)).toHaveLength(1);
    expect(doctor.indexOf('doctor_node_row')).toBeGreaterThan(doctor.indexOf('shutdown recovery: no active safety guard'));
    expect(doctor.indexOf('doctor_node_row')).toBeLessThan(doctor.indexOf('doctor_machine_rows'));
  });
});

describe('F-F: the early warning before an npm install', () => {
  it('is called right before each of the two places start.sh runs npm install', () => {
    const source = fs.readFileSync(launcherPath, 'utf8');
    const calls = [...source.matchAll(/^ +warn_if_node_needs_tools_to_install$/gm)];
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      const following = source.slice(call.index! + call[0].length, call.index! + call[0].length + 400);
      expect(following, 'the warning must come straight before the install line').toMatch(/^\s*echo "ℹ.*— npm install"/);
    }
  });

  const warning = (version: string) => `This Mac has Node ${version} and no Command Line Tools. Installing BotBoy's database module has to compile it. Install Node 24 or newer from nodejs.org (the LTS download; no extra tools needed), or run xcode-select --install first.`;

  it('says it once, before the install line, for Node 20 without the Command Line Tools, and still installs', () => {
    const b = box({ version: 'v20.19.0', clt: false, dependencies: true });
    const result = b.run('BOTBOY_TEST_HEAL_DEPS');
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(warning('v20.19.0'));
    expect(result.stdout.match(/no Command Line Tools/g)).toHaveLength(1);
    expect(result.stdout.indexOf('no Command Line Tools')).toBeLessThan(result.stdout.indexOf('Installing dependencies (left-pad)'));
    expect(b.npmCalls()).toEqual(['install --no-audit --no-fund']); // never blocked
  });
  it('is silent with the Command Line Tools, with a Node at 22 or above, and when there is nothing to install', () => {
    for (const options of [
      { version: 'v20.19.0', clt: true, dependencies: true },
      { version: 'v22.11.0', clt: false, dependencies: true },
      { version: 'v24.1.0', clt: false, dependencies: true },
      { version: 'v20.19.0', clt: false, dependencies: false },
    ]) {
      const b = box(options);
      const result = b.run('BOTBOY_TEST_HEAL_DEPS');
      expect(result.stdout, JSON.stringify(options)).not.toContain('no Command Line Tools');
    }
  });
});
