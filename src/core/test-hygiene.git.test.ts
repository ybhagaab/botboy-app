/**
 * The test net and the macOS git stand-in (Knowledge library P2-17). `/usr/bin/git` is an xcselect shim: with the
 * Command Line Tools it runs Apple's git, without them it raises the "install developer tools" dialog. The net refuses
 * and RECORDS it (like /usr/bin/python3) only while no developer-tools git exists; a working git, a Homebrew git and a
 * tripwire script of a test's own always run. The refusal is proven on any Mac by a nested run that pretends the tools
 * are absent (BOTBOY_TEST_NO_DEVELOPER_GIT=1), so the real stand-in is never started.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { DEVELOPER_GIT_PATHS, developerGitPresent, gitStandIns } from '../../vitest.git-standin.js';

vi.setConfig({ testTimeout: 120_000 });
const packageRoot = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));

describe('which git paths the net refuses', () => {
  it('refuses /usr/bin/git only while neither the Command Line Tools nor Xcode has a git', () => {
    expect(gitStandIns(() => false)).toEqual([['/usr/bin/git', 'git']]);
    for (const present of DEVELOPER_GIT_PATHS) {
      expect(gitStandIns((file) => file === present)).toEqual([]);
      expect(developerGitPresent((file) => file === present)).toBe(true);
    }
    expect(developerGitPresent(() => false)).toBe(false);
  });

  it('can be told to pretend the tools are absent (the nested proof below)', () => {
    const saved = process.env.BOTBOY_TEST_NO_DEVELOPER_GIT;
    process.env.BOTBOY_TEST_NO_DEVELOPER_GIT = '1';
    try {
      expect(gitStandIns(() => true)).toEqual([['/usr/bin/git', 'git']]);
    } finally {
      if (saved === undefined) delete process.env.BOTBOY_TEST_NO_DEVELOPER_GIT; else process.env.BOTBOY_TEST_NO_DEVELOPER_GIT = saved;
    }
  });
});

describe('the net in a run that has no developer-tools git (nested vitest, the real setup file)', () => {
  it.skipIf(process.platform !== 'darwin')('refuses and records /usr/bin/git by absolute path and by a bare name, before any process starts, and lets a tripwire git through', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'botboy-hygiene-git-'));
    try {
      fs.mkdirSync(path.join(tmp, 'bin'));
      fs.writeFileSync(path.join(tmp, 'bin', 'git'), '#!/bin/sh\necho tripwire-git\n', { mode: 0o755 });
      fs.writeFileSync(path.join(tmp, 'probe.test.ts'), [
        "import { execFileSync, spawnSync } from 'node:child_process';",
        "const guard = () => (globalThis as any).__botboyUiGuard;",
        "it('refuses the real git by absolute path', () => {",
        "  expect(() => spawnSync('/usr/bin/git', ['--version'])).toThrow(/would run the REAL git, an Xcode stand-in/);",
        "  expect(() => execFileSync('/usr/bin/git', ['--version'])).toThrow(/would run the REAL git/);",
        "  expect(guard().calls().filter((line: string) => line.startsWith('REFUSED the real git'))).toHaveLength(2);",
        "  guard().reset();",
        '});',
        "it('refuses a bare git that PATH resolves to the stand-in', () => {",
        "  expect(() => spawnSync('git', ['--version'], { env: { PATH: '/usr/bin:/bin' } })).toThrow(/would run the REAL git/);",
        "  guard().reset();",
        '});',
        "it('lets a git that is not the stand-in through (a tripwire first on the PATH)', () => {",
        `  const result = spawnSync('git', ['--version'], { env: { PATH: ${JSON.stringify(`${path.join(tmp, 'bin')}:/usr/bin:/bin`)} }, encoding: 'utf8' });`,
        "  expect(result.stdout.trim()).toBe('tripwire-git');",
        "  expect(guard().calls()).toEqual([]);",
        '});',
        '',
      ].join('\n'));
      fs.writeFileSync(path.join(tmp, 'vitest.config.mjs'), `export default { test: { globals: true, environment: 'node', include: ['probe.test.ts'], setupFiles: [${JSON.stringify(path.join(packageRoot, 'vitest.no-ui-tools.setup.ts'))}] } };\n`);
      const env: NodeJS.ProcessEnv = { ...process.env, TMPDIR: tmp, BOTBOY_TEST_NO_DEVELOPER_GIT: '1' };
      delete env.BOTBOY_TEST_UI_STUBS_RUN_DIR;
      const result = spawnSync(process.execPath, [path.join(packageRoot, 'node_modules', 'vitest', 'vitest.mjs'), 'run', '--config', path.join(tmp, 'vitest.config.mjs'), '--root', tmp], { cwd: packageRoot, env, encoding: 'utf8', timeout: 100_000 });
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform !== 'darwin')('a refusal the code under test swallowed still fails its file in afterAll', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'botboy-hygiene-git2-'));
    try {
      fs.writeFileSync(path.join(tmp, 'probe.test.ts'), [
        "import { spawnSync } from 'node:child_process';",
        "it('swallows the error', () => { try { spawnSync('/usr/bin/git', ['--version']); } catch { /* swallowed */ } });",
        '',
      ].join('\n'));
      fs.writeFileSync(path.join(tmp, 'vitest.config.mjs'), `export default { test: { globals: true, environment: 'node', include: ['probe.test.ts'], setupFiles: [${JSON.stringify(path.join(packageRoot, 'vitest.no-ui-tools.setup.ts'))}] } };\n`);
      const env: NodeJS.ProcessEnv = { ...process.env, TMPDIR: tmp, BOTBOY_TEST_NO_DEVELOPER_GIT: '1' };
      delete env.BOTBOY_TEST_UI_STUBS_RUN_DIR;
      const result = spawnSync(process.execPath, [path.join(packageRoot, 'node_modules', 'vitest', 'vitest.mjs'), 'run', '--config', path.join(tmp, 'vitest.config.mjs'), '--root', tmp], { cwd: packageRoot, env, encoding: 'utf8', timeout: 100_000 });
      expect(result.status).not.toBe(0);
      expect(`${result.stdout}${result.stderr}`).toMatch(/test hygiene/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
