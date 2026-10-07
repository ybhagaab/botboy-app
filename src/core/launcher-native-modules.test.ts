/**
 * The launcher's native-module check (start.sh › native_modules_status) and
 * the spawn-helper fix in scripts/bootstrap-deps.mjs. Teammate report
 * 2026-10-07: on Homebrew Node 26 with npm 12, npm skipped the native builds,
 * the server crashed at import, the doctor still said better-sqlite3 "loads",
 * and each failed start left a shutdown guard.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const launcherPath = fileURLToPath(new URL('../../start.sh', import.meta.url));
const bootstrapPath = fileURLToPath(new URL('../../scripts/bootstrap-deps.mjs', import.meta.url));
const roots: string[] = [];
afterEach(() => {
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

type SqliteStub = 'works' | 'unbuilt' | 'other-node';

/** A checkout copy whose node_modules hold stand-ins for the two native modules. */
function app(sqlite: SqliteStub) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'botboy-native-'));
  roots.push(root);
  const dir = path.join(root, 'app');
  fs.mkdirSync(dir);
  fs.copyFileSync(launcherPath, path.join(dir, 'start.sh'));
  const sqliteDir = path.join(dir, 'node_modules', 'better-sqlite3');
  fs.mkdirSync(sqliteDir, { recursive: true });
  fs.writeFileSync(path.join(sqliteDir, 'package.json'), '{"name":"better-sqlite3","version":"12.11.1","main":"index.js"}\n');
  const failures: Record<SqliteStub, string> = {
    works: '',
    // The real messages, as seen on the teammate's Mac and on a Node switch.
    // Node reports the module's real path.
    unbuilt: 'Could not locate the bindings file. Tried:\n → node_modules/better-sqlite3/build/better_sqlite3.node',
    'other-node': `The module '${fs.realpathSync(sqliteDir)}/build/Release/better_sqlite3.node'\nwas compiled against a different Node.js version using\nNODE_MODULE_VERSION 115. This version of Node.js requires\nNODE_MODULE_VERSION 147.`,
  };
  // Like the real module: `require` succeeds; only `new Database()` binds.
  fs.writeFileSync(path.join(sqliteDir, 'index.js'), failures[sqlite]
    ? `module.exports = class { constructor() { throw new Error(${JSON.stringify(failures[sqlite])}); } };\n`
    : 'module.exports = class { close() {} };\n');
  const ptyDir = path.join(dir, 'node_modules', 'node-pty');
  const helper = path.join(ptyDir, 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper');
  fs.mkdirSync(path.dirname(helper), { recursive: true });
  fs.writeFileSync(path.join(ptyDir, 'package.json'), '{"name":"node-pty","version":"1.1.0","main":"index.js"}\n');
  // Spawning fails as the real one does while its helper is not executable.
  fs.writeFileSync(path.join(ptyDir, 'index.js'), `
    const fs = require('fs');
    exports.spawn = () => {
      if ((fs.statSync(${JSON.stringify(helper)}).mode & 0o111) !== 0o111) throw new Error('posix_spawnp failed.');
      return { onExit(callback) { setTimeout(() => callback({ exitCode: 0 }), 10); }, kill() {} };
    };
  `);
  fs.writeFileSync(helper, 'helper', { mode: 0o644 });
  fs.chmodSync(helper, 0o644);
  const run = (mode: 'check' | 'repair') => spawnSync('/bin/bash', [path.join(dir, 'start.sh')], {
    cwd: dir,
    env: { ...process.env, BOTBOY_TEST_NATIVE_STATUS: mode, PPT_LOG_FILE: path.join(root, 'launcher.log') },
    encoding: 'utf8',
    timeout: 20_000,
  });
  return { dir, helper, run };
}

describe('start.sh › native_modules_status', () => {
  it('counts better-sqlite3 only when it opens a database, not when require succeeds', () => {
    const unbuilt = app('unbuilt');
    fs.chmodSync(unbuilt.helper, 0o755);
    const result = unbuilt.run('check');
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('better-sqlite3|Could not locate the bindings file.');
    expect(result.stdout).not.toContain('Tried:');
    expect(result.stdout).toContain('node-pty|ok');
  });

  it('names a module built for another Node, without the checkout path', () => {
    const otherNode = app('other-node');
    fs.chmodSync(otherNode.helper, 0o755);
    const result = otherNode.run('check');
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('NODE_MODULE_VERSION 115. This version of Node.js requires NODE_MODULE_VERSION 147.');
    expect(result.stdout).toContain("better-sqlite3|The module 'node_modules/better-sqlite3/build/Release/better_sqlite3.node'");
    expect(result.stdout).not.toContain(fs.realpathSync(otherNode.dir));
  });

  it('reports node-pty\'s unexecutable spawn-helper in check, and fixes only that in repair', () => {
    const box = app('works');
    const checked = box.run('check');
    expect(checked.status).toBe(1);
    expect(checked.stdout).toContain('better-sqlite3|ok');
    expect(checked.stdout).toContain('node-pty|posix_spawnp failed.');
    expect(fs.statSync(box.helper).mode & 0o777).toBe(0o644);

    const repaired = box.run('repair');
    expect(repaired.status).toBe(0);
    expect(repaired.stdout.trim().split('\n')).toEqual(['better-sqlite3|ok', 'node-pty|ok']);
    expect(fs.statSync(box.helper).mode & 0o777).toBe(0o755);
  });

  it('fails both when the modules are not installed at all', () => {
    const box = app('works');
    fs.rmSync(path.join(box.dir, 'node_modules'), { recursive: true });
    const result = box.run('repair');
    expect(result.status).toBe(1);
    expect(result.stdout).toMatch(/^better-sqlite3\|Cannot find module 'better-sqlite3'/m);
    expect(result.stdout).toMatch(/^node-pty\|Cannot find module 'node-pty'/m);
  });

  it('stops a start before spawning when the reinstall does not fix them, after reinstalling once', () => {
    const launcher = fs.readFileSync(launcherPath, 'utf8');
    const preflightAt = launcher.indexOf('if ! NATIVE_STATUS="$(native_modules_status repair)"; then');
    const block = launcher.slice(preflightAt, launcher.indexOf('\nNEED_BUILD=""', preflightAt));
    expect(preflightAt).toBeGreaterThan(0);
    // Remove, then install: npm writes new files instead of rewriting a
    // binary a running BotBoy has loaded.
    expect(block).toContain('rm -rf node_modules/better-sqlite3 node_modules/node-pty \\\n    && npm install --no-audit --no-fund');
    expect(block.indexOf('print_native_modules_failure')).toBeGreaterThan(block.indexOf('npm install'));
    expect(block).toMatch(/print_native_modules_failure "\$NATIVE_STATUS" \| tee -a "\$LOG_FILE"\n\s+exit 1/);
    // Every server spawn comes after the check.
    const firstSpawn = launcher.search(/"\$NODE" dist\/index\.js/);
    expect(firstSpawn).toBeGreaterThan(preflightAt);
    expect(launcher.indexOf('BotBoy never opened its database, so nothing needs recovery.')).toBeGreaterThan(0);
  });

  it('keeps the doctor read-only and reports what failed', () => {
    const launcher = fs.readFileSync(launcherPath, 'utf8');
    const doctor = launcher.slice(launcher.indexOf('if [ "$DOCTOR" = "1" ]; then'), launcher.indexOf('# Folder watching rides FSEvents'));
    expect(doctor).toContain('DOCTOR_NATIVE="$(native_modules_status check)"');
    expect(doctor).not.toContain('native_modules_status repair');
    expect(doctor).not.toMatch(/require\('\$mod'\)/);
    expect(doctor).toContain('native $mod: FAILS — ${DOCTOR_NATIVE_LINE#*|}');
  });
});

describe('package.json native dependencies', () => {
  it('pins both native modules exactly and lets npm 12 run their install scripts', () => {
    const pkg = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
    // Exact pins make start.sh › missing_npm_dependencies upgrade existing
    // installs; a range would leave a teammate on the old build forever.
    expect(pkg.dependencies['better-sqlite3']).toMatch(/^\d+\.\d+\.\d+$/);
    expect(pkg.dependencies['node-pty']).toMatch(/^\d+\.\d+\.\d+$/);
    // better-sqlite3 12.10+ is the first line with Node 26 prebuilds; 11.x
    // cannot be built for Node 26 at all.
    const [major, minor] = pkg.dependencies['better-sqlite3'].split('.').map(Number);
    expect(major > 12 || (major === 12 && minor >= 10)).toBe(true);
    // npm 12 skips every dependency install script not listed here.
    expect(pkg.allowScripts).toMatchObject({ 'better-sqlite3': true, 'node-pty': true });
  });
});

describe('scripts/bootstrap-deps.mjs (npm postinstall)', () => {
  it('makes node-pty\'s prebuilt macOS spawn-helpers executable', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'botboy-bootstrap-'));
    roots.push(root);
    fs.mkdirSync(path.join(root, 'scripts'));
    fs.copyFileSync(bootstrapPath, path.join(root, 'scripts', 'bootstrap-deps.mjs'));
    const helpers = ['darwin-arm64', 'darwin-x64'].map(platform => path.join(root, 'node_modules', 'node-pty', 'prebuilds', platform, 'spawn-helper'));
    for (const helper of helpers) {
      fs.mkdirSync(path.dirname(helper), { recursive: true });
      fs.writeFileSync(helper, 'helper');
      fs.chmodSync(helper, 0o644);
    }
    const result = spawnSync(process.execPath, [path.join(root, 'scripts', 'bootstrap-deps.mjs')], {
      cwd: root,
      env: { ...process.env, PATH: '/usr/bin:/bin' },
      encoding: 'utf8',
      timeout: 20_000,
    });
    expect(result.status).toBe(0);
    for (const helper of helpers) expect(fs.statSync(helper).mode & 0o777).toBe(0o755);
    expect(result.stdout).toContain('made node-pty darwin-arm64 spawn-helper executable');

    // Idempotent: nothing to fix on a second run.
    const again = spawnSync(process.execPath, [path.join(root, 'scripts', 'bootstrap-deps.mjs')], {
      cwd: root,
      env: { ...process.env, PATH: '/usr/bin:/bin' },
      encoding: 'utf8',
      timeout: 20_000,
    });
    expect(again.status).toBe(0);
    expect(again.stdout).not.toContain('spawn-helper executable');
  });
});
