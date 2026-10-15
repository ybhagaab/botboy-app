/**
 * Git as the best-effort mirror of the Knowledge library's history (knowledge-library.md K13; brief 4.5). The real git runs
 * only against temp repositories with an explicit identity, never the macOS stand-in: the no-Command-Line-Tools case uses a
 * tripwire script that records any run. A space in the library path, no `.git` entry inside the folder, a poison global
 * configuration that is never read, the "unknown" answer that skips git silently, and the breaker are all covered.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GIT_COMMAND_CONFIG, GIT_DEGRADED_NOTICE, createGitMirror, resolveGit, scrubbedGitEnv, type GitRunner } from './knowledge-git.js';

/** A real git that is not the macOS stand-in (the tools' own, or Homebrew's). Null when there is none: those tests skip. */
const REAL_GIT = [
  '/Library/Developer/CommandLineTools/usr/bin/git',
  path.join(os.homedir(), 'homebrew', 'bin', 'git'),
  '/opt/homebrew/bin/git',
  '/usr/local/bin/git',
].find((candidate) => { try { return fs.statSync(candidate).isFile(); } catch { return false; } }) ?? null;

describe('the per-command configuration (R17)', () => {
  it('leaves git\'s own gc thresholds alone but never lets a gc detach into a background process', () => {
    const config = GIT_COMMAND_CONFIG.join(' ');
    expect(config).toContain('gc.autoDetach=false');
    expect(config).not.toMatch(/gc\.auto=/);
    expect(config).toContain('core.hooksPath=/dev/null');
    expect(config).toContain('commit.gpgsign=false');
  });
});
let base: string;
let workTree: string;
let gitDir: string;
let homeDir: string;
beforeEach(() => {
  base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'kl-git-')));
  workTree = path.join(base, 'Docs', 'BotBoy Knowledge');
  gitDir = path.join(base, 'state', 'knowledge-history.git');
  homeDir = path.join(base, 'state', 'knowledge-history-home');
  fs.mkdirSync(path.join(workTree, 'shop-data'), { recursive: true });
});
afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

const gitOut = (...args: string[]) => {
  const result = spawnSync(REAL_GIT as string, ['--no-pager', `--git-dir=${gitDir}`, ...args], {
    encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: homeDir, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
  });
  return result.stdout.trim();
};

describe('resolveGit', () => {
  const shim = '/usr/bin/git';
  it('uses a real git as is, whatever the tools answer', () => {
    expect(resolveGit({ find: () => '/opt/homebrew/bin/git', commandLineTools: () => false })).toEqual({ path: '/opt/homebrew/bin/git', state: 'ready' });
  });
  it('uses the stand-in only when the Command Line Tools are known to be installed', () => {
    expect(resolveGit({ find: () => shim, commandLineTools: () => true })).toEqual({ path: shim, state: 'ready' });
  });
  it('never returns the stand-in without the tools (false) and says unknown while the answer is not in yet (null)', () => {
    expect(resolveGit({ find: () => shim, commandLineTools: () => false })).toEqual({ path: null, state: 'stand_in' });
    expect(resolveGit({ find: () => shim, commandLineTools: () => null })).toEqual({ path: null, state: 'unknown' });
  });
  it('reports a missing git', () => {
    expect(resolveGit({ find: () => null })).toEqual({ path: null, state: 'missing' });
  });
});

describe('scrubbedGitEnv', () => {
  it('names nothing that could redirect git or load user configuration', () => {
    const env = scrubbedGitEnv('/private/tmp/h', '/opt/homebrew/bin/git');
    expect(env).toMatchObject({ HOME: '/private/tmp/h', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat' });
    for (const key of ['XDG_CONFIG_HOME', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'SSH_AUTH_SOCK']) expect(env[key]).toBeUndefined();
    expect(env.PATH).toContain('/opt/homebrew/bin');
  });
});

describe('the stand-in is never run (tripwire)', () => {
  it('records no run when the tools are absent or not yet known, and says so once', async () => {
    const tripwire = path.join(base, 'git');
    const log = path.join(base, 'tripwire.log');
    fs.writeFileSync(tripwire, `#!/bin/sh\necho "RAN $*" >> '${log}'\nexit 0\n`, { mode: 0o755 });
    let tools: boolean | null = false;
    const mirror = createGitMirror({
      gitDir, homeDir, workTree: () => workTree,
      resolve: () => resolveGit({ find: () => tripwire, shimTools: new Set([tripwire]), commandLineTools: () => tools }),
    });
    fs.writeFileSync(path.join(workTree, 'shop-data', 'orders.md'), '# Orders\n');
    expect(await mirror.record({ paths: ['shop-data/orders.md'], message: 'write' })).toMatchObject({ ok: false, reason: 'stand_in' });
    expect(mirror.status()).toMatchObject({ state: 'degraded', notice: GIT_DEGRADED_NOTICE, hint: null });
    tools = null;
    const fresh = createGitMirror({ gitDir, homeDir, workTree: () => workTree, resolve: () => resolveGit({ find: () => tripwire, shimTools: new Set([tripwire]), commandLineTools: () => tools }) });
    expect(await fresh.record({ paths: ['shop-data/orders.md'], message: 'write' })).toMatchObject({ ok: false, reason: 'unknown' });
    expect(fresh.status()).toMatchObject({ state: 'idle', notice: null });
    expect(fs.existsSync(log)).toBe(false);
    expect(fs.existsSync(gitDir)).toBe(false);
  });

  it('runs the very same script once the tools are known (the tripwire proves the gate is the only thing in the way)', async () => {
    const tripwire = path.join(base, 'git');
    const log = path.join(base, 'tripwire.log');
    fs.writeFileSync(tripwire, `#!/bin/sh\necho "RAN $*" >> '${log}'\nexit 0\n`, { mode: 0o755 });
    const mirror = createGitMirror({ gitDir, homeDir, workTree: () => workTree, resolve: () => resolveGit({ find: () => tripwire, shimTools: new Set([tripwire]), commandLineTools: () => true }) });
    await mirror.record({ paths: ['shop-data/orders.md'], message: 'write' });
    expect(fs.readFileSync(log, 'utf8')).toContain('RAN');
  });
});

describe('the breaker and failure handling (fake runner)', () => {
  it('three failures open a ten-minute breaker, then git is tried again', async () => {
    let clock = 1_000_000;
    let calls = 0;
    const run: GitRunner = async () => { calls += 1; return { code: 128, stdout: '', stderr: 'fatal: nope', timedOut: false }; };
    const mirror = createGitMirror({ gitDir, homeDir, workTree: () => workTree, resolve: () => ({ path: '/fake/git', state: 'ready' }), run, now: () => clock });
    for (let index = 0; index < 3; index += 1) expect(await mirror.record({ paths: ['a.md'], message: 'm' })).toMatchObject({ ok: false, reason: 'failed' });
    const callsAtOpen = calls;
    expect(await mirror.record({ paths: ['a.md'], message: 'm' })).toMatchObject({ ok: false, reason: 'breaker_open' });
    expect(calls).toBe(callsAtOpen);
    expect(mirror.status()).toMatchObject({ state: 'degraded', notice: GIT_DEGRADED_NOTICE });
    clock += 10 * 60_000 + 1;
    expect(await mirror.record({ paths: ['a.md'], message: 'm' })).toMatchObject({ ok: false, reason: 'failed' });
    expect(calls).toBeGreaterThan(callsAtOpen);
  });

  it('refuses paths that leave the work tree or name git internals, and never runs for an empty list', async () => {
    let calls = 0;
    const run: GitRunner = async () => { calls += 1; return { code: 0, stdout: '', stderr: '', timedOut: false }; };
    const mirror = createGitMirror({ gitDir, homeDir, workTree: () => workTree, resolve: () => ({ path: '/fake/git', state: 'ready' }), run });
    expect(await mirror.record({ paths: ['../outside.md', '/etc/passwd', '.git/config'], message: 'm' })).toEqual({ ok: true, committed: false });
    expect(calls).toBe(0);
  });

  it('a library that is gone is reported, not run', async () => {
    const mirror = createGitMirror({ gitDir, homeDir, workTree: () => null, resolve: () => ({ path: '/fake/git', state: 'ready' }) });
    expect(await mirror.record({ paths: ['a.md'], message: 'm' })).toMatchObject({ ok: false, reason: 'no_work_tree' });
  });
});

describe.skipIf(!REAL_GIT)('with a real git against a temp repository (spaced work tree)', () => {
  const resolveReal = () => ({ path: REAL_GIT, state: 'ready' as const });

  it('commits explicit paths, keeps the repository outside the folder, and writes no .git entry into it', async () => {
    const mirror = createGitMirror({ gitDir, homeDir, workTree: () => workTree, resolve: resolveReal });
    fs.writeFileSync(path.join(workTree, 'shop-data', 'orders.md'), '# Orders\n\nVersion one.\n');
    fs.writeFileSync(path.join(workTree, 'unrelated.md'), '# Not mine\n');
    expect(await mirror.record({ paths: ['shop-data/orders.md'], message: 'write: add orders' })).toEqual({ ok: true, committed: true });
    expect(fs.existsSync(path.join(gitDir, 'HEAD'))).toBe(true);
    expect(fs.readdirSync(workTree).some((name) => name === '.git')).toBe(false);
    expect(fs.existsSync(path.join(workTree, 'shop-data', '.git'))).toBe(false);
    expect(gitOut('log', '--format=%an <%ae>|%s')).toBe('BotBoy <botboy@localhost>|write: add orders');
    // Only the named path was staged: the unrelated untracked file is not swept in.
    expect(gitOut('ls-tree', '-r', '--name-only', 'HEAD')).toBe('shop-data/orders.md');
    expect(mirror.status()).toMatchObject({ state: 'active', notice: null, gitDirectory: gitDir });
    expect(mirror.status().hint).toContain(`--git-dir="${gitDir}"`);
  });

  it('records an edit, a deletion and a move, and treats an unchanged path as no commit', async () => {
    const mirror = createGitMirror({ gitDir, homeDir, workTree: () => workTree, resolve: resolveReal });
    const file = path.join(workTree, 'shop-data', 'orders.md');
    fs.writeFileSync(file, '# Orders\n\nVersion one.\n');
    await mirror.record({ paths: ['shop-data/orders.md'], message: 'one' });
    expect(await mirror.record({ paths: ['shop-data/orders.md'], message: 'again' })).toEqual({ ok: true, committed: false });
    fs.writeFileSync(file, '# Orders\n\nVersion two.\n');
    expect(await mirror.record({ paths: ['shop-data/orders.md'], message: 'two' })).toEqual({ ok: true, committed: true });
    fs.mkdirSync(path.join(workTree, 'shop-data', '_archive'));
    fs.renameSync(file, path.join(workTree, 'shop-data', '_archive', 'orders.md'));
    expect(await mirror.record({ paths: ['shop-data/orders.md', 'shop-data/_archive/orders.md'], message: 'archive' })).toEqual({ ok: true, committed: true });
    expect(gitOut('log', '--format=%s')).toBe('archive\ntwo\none');
    expect(gitOut('ls-tree', '-r', '--name-only', 'HEAD')).toBe('shop-data/_archive/orders.md');
  });

  it('never reads a poison global configuration or runs its hook, and signs nothing', async () => {
    const poisonHome = path.join(base, 'poison-home');
    fs.mkdirSync(path.join(poisonHome, 'hooks'), { recursive: true });
    const marker = path.join(base, 'hook-ran');
    fs.writeFileSync(path.join(poisonHome, 'hooks', 'pre-commit'), `#!/bin/sh\ntouch '${marker}'\nexit 1\n`, { mode: 0o755 });
    fs.writeFileSync(path.join(poisonHome, '.gitconfig'), `[user]\n\tname = Someone Else\n\temail = else@example.test\n[commit]\n\tgpgsign = true\n[core]\n\thooksPath = ${path.join(poisonHome, 'hooks')}\n`);
    const previousHome = process.env.HOME;
    process.env.HOME = poisonHome;
    process.env.GIT_CONFIG_GLOBAL = path.join(poisonHome, '.gitconfig');
    try {
      const mirror = createGitMirror({ gitDir, homeDir, workTree: () => workTree, resolve: resolveReal });
      fs.writeFileSync(path.join(workTree, 'shop-data', 'orders.md'), '# Orders\n');
      expect(await mirror.record({ paths: ['shop-data/orders.md'], message: 'write' })).toEqual({ ok: true, committed: true });
    } finally {
      process.env.HOME = previousHome;
      delete process.env.GIT_CONFIG_GLOBAL;
    }
    expect(fs.existsSync(marker)).toBe(false);
    expect(gitOut('log', '--format=%an')).toBe('BotBoy');
    expect(gitOut('log', '--format=%G?')).toBe('N');
  });

  it('survives a hostile inherited GIT_DIR / GIT_WORK_TREE / GIT_INDEX_FILE', async () => {
    const decoy = path.join(base, 'decoy');
    fs.mkdirSync(decoy);
    const saved = { dir: process.env.GIT_DIR, tree: process.env.GIT_WORK_TREE, index: process.env.GIT_INDEX_FILE };
    process.env.GIT_DIR = path.join(decoy, 'nope.git');
    process.env.GIT_WORK_TREE = decoy;
    process.env.GIT_INDEX_FILE = path.join(decoy, 'index');
    try {
      const mirror = createGitMirror({ gitDir, homeDir, workTree: () => workTree, resolve: resolveReal });
      fs.writeFileSync(path.join(workTree, 'shop-data', 'orders.md'), '# Orders\n');
      expect(await mirror.record({ paths: ['shop-data/orders.md'], message: 'write' })).toEqual({ ok: true, committed: true });
    } finally {
      for (const [key, value] of [['GIT_DIR', saved.dir], ['GIT_WORK_TREE', saved.tree], ['GIT_INDEX_FILE', saved.index]] as const) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    }
    expect(fs.existsSync(path.join(decoy, 'nope.git'))).toBe(false);
    expect(gitOut('ls-tree', '-r', '--name-only', 'HEAD')).toBe('shop-data/orders.md');
  });

  it('a call that outlasts its limit is killed and counted as a failure', async () => {
    const slow = path.join(base, 'slow-git');
    fs.writeFileSync(slow, '#!/bin/sh\nsleep 5\n', { mode: 0o755 });
    const mirror = createGitMirror({ gitDir, homeDir, workTree: () => workTree, resolve: () => ({ path: slow, state: 'ready' }), timeoutMs: 300 });
    const started = Date.now();
    const result = await mirror.record({ paths: ['shop-data/orders.md'], message: 'write' });
    expect(result).toMatchObject({ ok: false, reason: 'failed' });
    expect(Date.now() - started).toBeLessThan(3_000);
  });
});
