/**
 * start.sh on a Mac without Xcode Command Line Tools. Every /usr/bin shim
 * (git, swiftc, lipo, otool) raises the macOS install dialog there, so the
 * launcher asks `xcode-select -p` first. Tool paths are variables with
 * BOTBOY_TEST_* overrides; the hooks exit before the real start flow.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Each case starts the launcher a few times; a loaded Mac needs more than the 5 s default.
vi.setConfig({ testTimeout: 60_000 });

const launcherPath = fileURLToPath(new URL('../../start.sh', import.meta.url));
const roots: string[] = [];
afterEach(() => {
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

// Until the prebuilt OCR helper (2026-10-13) start.sh printed this itself when xcode-select failed. The words now come from the Node job
// (scripts/bootstrap-deps.mjs, reason table in scripts/native-prebuilt.mjs), so the shell stays silent.
const OCR_NOTE =
  'OCR helper not built: install Xcode Command Line Tools with `xcode-select --install`; BotBoy works without it except text from images and scanned PDFs';

function box(deps: Record<string, string> = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'botboy-toolchain-'));
  roots.push(root);
  const dir = path.join(root, 'app');
  const stubs = path.join(root, 'stubs');
  fs.mkdirSync(dir);
  fs.mkdirSync(stubs);
  fs.copyFileSync(launcherPath, path.join(dir, 'start.sh'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', dependencies: deps }));
  const marks = path.join(root, 'marks');
  fs.mkdirSync(marks);
  // A private HOME: the OCR helper's remembered-failure marker lives under it
  // and must never land in the real home folder.
  const home = path.join(root, 'home');
  fs.mkdirSync(home);
  const stub = (name: string, body: string) => {
    const file = path.join(stubs, name);
    fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    return file;
  };
  const marker = (name: string) => path.join(marks, name);
  const ran = (name: string) => fs.existsSync(marker(name));
  const run = (hook: string, env: Record<string, string> = {}) =>
    spawnSync('/bin/bash', [path.join(dir, 'start.sh')], {
      cwd: dir,
      env: {
        ...process.env,
        HOME: home,
        BOTBOY_NO_ARCH_REEXEC: '1',
        PPT_LOG_FILE: path.join(root, 'launcher.log'),
        [hook]: '1',
        ...env,
      },
      encoding: 'utf8',
      timeout: 20_000,
    });
  const addOcrSource = () => {
    fs.mkdirSync(path.join(dir, 'native', 'vision-ocr'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'native', 'vision-ocr', 'main.swift'), '// stub\n');
  };
  return { dir, stubs, stub, marker, ran, run, addOcrSource };
}

describe('start.sh › heal_missing_npm_dependencies', () => {
  it('says every package is present when npm fails but nothing is missing', () => {
    const b = box({ alpha: '1.0.0' });
    const npm = b.stub('npm', `mkdir -p node_modules/alpha\necho '{"version":"1.0.0"}' > node_modules/alpha/package.json\nexit 1`);
    const result = b.run('BOTBOY_TEST_HEAL_DEPS', { BOTBOY_TEST_NPM_BIN: npm });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('every BotBoy package is present');
    expect(result.stdout).not.toContain('BotBoy starts without');
  });

  it('names only the packages still missing', () => {
    const b = box({ alpha: '1.0.0', beta: '2.0.0' });
    const npm = b.stub('npm', `mkdir -p node_modules/alpha\necho '{"version":"1.0.0"}' > node_modules/alpha/package.json\nexit 1`);
    const result = b.run('BOTBOY_TEST_HEAL_DEPS', { BOTBOY_TEST_NPM_BIN: npm });
    expect(result.stdout).toContain('npm install failed');
    expect(result.stdout).toContain('BotBoy starts without: beta');
    expect(result.stdout).not.toMatch(/starts without:.*alpha/);
  });

  it('does nothing when nothing is missing', () => {
    const b = box({});
    const npm = b.stub('npm', `touch '${b.marker('npm')}'`);
    const result = b.run('BOTBOY_TEST_HEAL_DEPS', { BOTBOY_TEST_NPM_BIN: npm });
    expect(result.status).toBe(0);
    expect(b.ran('npm')).toBe(false);
  });
});

describe('start.sh › rebuild_ocr_helper_if_needed', () => {
  it('runs no compiler and prints nothing of its own when xcode-select fails (the Node job owns the words)', () => {
    const b = box();
    b.addOcrSource();
    const xcodeSelect = b.stub('xcode-select', 'exit 2');
    const xcrun = b.stub('xcrun', `touch '${b.marker('xcrun')}'\nexit 1`);
    b.stub('swiftc', `touch '${b.marker('swiftc')}'`);
    const result = b.run('BOTBOY_TEST_OCR_REBUILD', {
      BOTBOY_TEST_XCODE_SELECT_BIN: xcodeSelect,
      BOTBOY_TEST_XCRUN_BIN: xcrun,
      PATH: `${b.stubs}:${process.env.PATH}`,
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stdout).not.toContain(OCR_NOTE);
    expect(b.ran('swiftc')).toBe(false);
    expect(b.ran('xcrun')).toBe(false);
  });

  it('stays silent when the helper is already built and current', () => {
    const b = box();
    b.addOcrSource();
    const binDir = path.join(b.dir, 'native', 'vision-ocr', 'bin');
    fs.mkdirSync(binDir);
    fs.writeFileSync(path.join(binDir, 'vision-ocr'), '#!/bin/sh\n', { mode: 0o755 });
    const future = new Date(Date.now() + 60_000);
    fs.utimesSync(path.join(binDir, 'vision-ocr'), future, future);
    const xcodeSelect = b.stub('xcode-select', 'exit 2');
    const result = b.run('BOTBOY_TEST_OCR_REBUILD', { BOTBOY_TEST_XCODE_SELECT_BIN: xcodeSelect });
    expect(result.stdout).toBe('');
  });

  it('never prints a "rebuild failed" warning, even when the toolchain is ok but the build cannot run', () => {
    // Before 2026-10-13 this printed "OCR helper rebuild failed" at every start.
    // Now a failed or impossible build says nothing here: scripts/bootstrap-deps.mjs
    // remembers a real failure and prints one calm note (launcher-ocr-job.test.ts).
    const b = box();
    b.addOcrSource();
    const xcodeSelect = b.stub('xcode-select', 'echo /stub/clt');
    const xcrun = b.stub('xcrun', 'echo /stub/swiftc');
    // No scripts/bootstrap-deps.mjs in the copied checkout: there is nothing to run.
    const result = b.run('BOTBOY_TEST_OCR_REBUILD', { BOTBOY_TEST_XCODE_SELECT_BIN: xcodeSelect, BOTBOY_TEST_XCRUN_BIN: xcrun });
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain('rebuild failed');
    expect(result.stdout).not.toContain(OCR_NOTE);
    expect(result.stdout).toBe('');
  });
});

describe('start.sh › git_usable', () => {
  it('never calls the git shim when xcode-select fails', () => {
    const b = box();
    const git = b.stub('git', `touch '${b.marker('git')}'\nexit 1`);
    const xcodeSelect = b.stub('xcode-select', 'exit 2');
    const result = b.run('BOTBOY_TEST_GIT_USABLE', {
      BOTBOY_TEST_XCODE_SELECT_BIN: xcodeSelect,
      BOTBOY_TEST_GIT_SHIM: git,
      PATH: `${b.stubs}:${process.env.PATH}`,
    });
    expect(result.stdout.trim()).toBe('git_usable: no');
    expect(b.ran('git')).toBe(false);
  });

  it('uses the shim once xcode-select answers', () => {
    const b = box();
    const git = b.stub('git', `touch '${b.marker('git')}'\nexit 1`);
    const xcodeSelect = b.stub('xcode-select', 'echo /stub/clt');
    const result = b.run('BOTBOY_TEST_GIT_USABLE', {
      BOTBOY_TEST_XCODE_SELECT_BIN: xcodeSelect,
      BOTBOY_TEST_GIT_SHIM: git,
      PATH: `${b.stubs}:${process.env.PATH}`,
    });
    expect(result.stdout.trim()).toBe('git_usable: yes');
    expect(b.ran('git')).toBe(true);
  });

  it('treats a git that is not the shim as usable without asking xcode-select', () => {
    const b = box();
    b.stub('git', 'exit 1');
    const xcodeSelect = b.stub('xcode-select', `touch '${b.marker('xcode-select')}'\nexit 2`);
    const result = b.run('BOTBOY_TEST_GIT_USABLE', {
      BOTBOY_TEST_XCODE_SELECT_BIN: xcodeSelect,
      BOTBOY_TEST_GIT_SHIM: '/nonexistent/shim/git',
      PATH: `${b.stubs}:${process.env.PATH}`,
    });
    expect(result.stdout.trim()).toBe('git_usable: yes');
    expect(b.ran('xcode-select')).toBe(false);
  });
});

describe('start.sh › doctor_toolchain_rows', () => {
  it('shows installed (swiftc found) when the compiler is reachable', () => {
    const b = box();
    const xcodeSelect = b.stub('xcode-select', 'echo /stub/clt');
    const xcrun = b.stub('xcrun', 'echo /stub/swiftc');
    const result = b.run('BOTBOY_TEST_DOCTOR_TOOLCHAIN', { BOTBOY_TEST_XCODE_SELECT_BIN: xcodeSelect, BOTBOY_TEST_XCRUN_BIN: xcrun });
    expect(result.stdout).toContain('xcode-clt: installed (swiftc found)');
    // This bare box has no scripts/bootstrap-deps.mjs, so the shell cannot ask the resolver: the row says unknown (never "run ./start.sh" to build).
    expect(result.stdout).toContain('ocr helper: unknown');
    expect(result.stdout).not.toContain('tools present; run ./start.sh');
  });

  it('shows MISSING with the consequence when the tools are absent', () => {
    const b = box();
    const xcodeSelect = b.stub('xcode-select', 'exit 2');
    const result = b.run('BOTBOY_TEST_DOCTOR_TOOLCHAIN', { BOTBOY_TEST_XCODE_SELECT_BIN: xcodeSelect });
    expect(result.stdout).toContain(
      "xcode-clt: not installed (optional: BotBoy's helpers ship prebuilt; the tools are needed only for Node 20's database module, for git, and to build a helper from source)",
    );
    expect(result.stdout).not.toContain('xcode-clt: MISSING');
    expect(result.stdout).toContain('pdf readers: vision-ocr helper unknown (see the ocr helper row);');
  });

  it('says a local helper is in use when one exists', () => {
    const b = box();
    const binDir = path.join(b.dir, 'native', 'vision-ocr', 'bin');
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(path.join(binDir, 'vision-ocr'), '#!/bin/sh\n', { mode: 0o755 });
    const xcodeSelect = b.stub('xcode-select', 'exit 2');
    const result = b.run('BOTBOY_TEST_DOCTOR_TOOLCHAIN', { BOTBOY_TEST_XCODE_SELECT_BIN: xcodeSelect });
    // This bare box also lacks scripts/bootstrap-deps.mjs, so the shell cannot ask the resolver: the row says unknown, never "built".
    expect(result.stdout).toContain('ocr helper: unknown');
    expect(result.stdout).toContain('pdf readers: vision-ocr helper unknown (see the ocr helper row);');
  });
});
