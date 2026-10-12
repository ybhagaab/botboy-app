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
import { afterEach, describe, expect, it } from 'vitest';

const launcherPath = fileURLToPath(new URL('../../start.sh', import.meta.url));
const roots: string[] = [];
afterEach(() => {
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

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
  it('prints the one-line note and runs no compiler when xcode-select fails', () => {
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
    expect(result.stdout).toContain(OCR_NOTE);
    expect(result.stdout.split(OCR_NOTE).length - 1).toBe(1);
    expect(result.stdout).not.toContain('rebuild failed');
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

  it('warns "rebuild failed" only when the toolchain was ok and the helper is still absent', () => {
    const b = box();
    b.addOcrSource();
    const xcodeSelect = b.stub('xcode-select', 'echo /stub/clt');
    const xcrun = b.stub('xcrun', 'echo /stub/swiftc');
    // No scripts/bootstrap-deps.mjs in the copied checkout: the rebuild fails.
    const result = b.run('BOTBOY_TEST_OCR_REBUILD', { BOTBOY_TEST_XCODE_SELECT_BIN: xcodeSelect, BOTBOY_TEST_XCRUN_BIN: xcrun });
    expect(result.stdout).toContain('Rebuilding the OCR helper');
    expect(result.stdout).toContain('OCR helper rebuild failed');
    expect(result.stdout).not.toContain(OCR_NOTE);
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
    expect(result.stdout).toContain('vision-ocr helper not built (tools present; run ./start.sh)');
  });

  it('shows MISSING with the consequence when the tools are absent', () => {
    const b = box();
    const xcodeSelect = b.stub('xcode-select', 'exit 2');
    const result = b.run('BOTBOY_TEST_DOCTOR_TOOLCHAIN', { BOTBOY_TEST_XCODE_SELECT_BIN: xcodeSelect });
    expect(result.stdout).toContain(
      'xcode-clt: MISSING — run: xcode-select --install; without it BotBoy cannot read text inside images or scanned PDFs (text PDFs still work)',
    );
    expect(result.stdout).toContain('vision-ocr helper not built (Xcode Command Line Tools missing: images and scanned PDFs unavailable)');
  });

  it('says built when the helper exists', () => {
    const b = box();
    const binDir = path.join(b.dir, 'native', 'vision-ocr', 'bin');
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(path.join(binDir, 'vision-ocr'), '#!/bin/sh\n', { mode: 0o755 });
    const xcodeSelect = b.stub('xcode-select', 'exit 2');
    const result = b.run('BOTBOY_TEST_DOCTOR_TOOLCHAIN', { BOTBOY_TEST_XCODE_SELECT_BIN: xcodeSelect });
    expect(result.stdout).toContain('pdf readers: vision-ocr helper built;');
  });
});
