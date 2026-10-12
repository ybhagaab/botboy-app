/**
 * scripts/bootstrap-deps.mjs on a Mac without Xcode Command Line Tools.
 * Without them every `swiftc`, `git`, and `xcrun` shim raises the macOS
 * install dialog, so the script asks `xcode-select -p` first and never runs a
 * compiler it has not found.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const bootstrapPath = fileURLToPath(new URL('../../scripts/bootstrap-deps.mjs', import.meta.url));
const bootstrapUrl = pathToFileURL(bootstrapPath).href;
const roots: string[] = [];
afterEach(() => {
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

type Mod = {
  detectSwiftToolchain: (opts?: { run?: (file: string, args: string[], opts?: unknown) => unknown }) => unknown;
  ocrNotBuiltNote: () => string;
  ocrBuildFailedNote: (firstLine: string) => string;
  isMainModule: (metaUrl: string, argv1: string | undefined) => boolean;
};
const load = () => import(/* @vite-ignore */ bootstrapUrl) as Promise<Mod>;

describe('detectSwiftToolchain', () => {
  it('asks xcode-select first and never calls xcrun when it fails', async () => {
    const { detectSwiftToolchain } = await load();
    const calls: string[] = [];
    const result = detectSwiftToolchain({
      run: (file) => {
        calls.push(file);
        throw new Error('no developer tools');
      },
    });
    expect(result).toEqual({ ok: false, reason: 'no-clt' });
    expect(calls).toEqual(['/usr/bin/xcode-select']);
  });

  it('reports no-swiftc when xcode-select works but xcrun cannot find the compiler', async () => {
    const { detectSwiftToolchain } = await load();
    const result = detectSwiftToolchain({
      run: (file) => {
        if (file === '/usr/bin/xcrun') throw new Error('not found');
        return '/Library/Developer/CommandLineTools\n';
      },
    });
    expect(result).toEqual({ ok: false, reason: 'no-swiftc' });
  });

  it('returns the compiler path xcrun finds', async () => {
    const { detectSwiftToolchain } = await load();
    const calls: Array<[string, string[]]> = [];
    const result = detectSwiftToolchain({
      run: (file, args) => {
        calls.push([file, args]);
        return file === '/usr/bin/xcrun' ? '/Library/Developer/CommandLineTools/usr/bin/swiftc\n' : '';
      },
    });
    expect(result).toEqual({ ok: true, swiftc: '/Library/Developer/CommandLineTools/usr/bin/swiftc' });
    expect(calls).toEqual([
      ['/usr/bin/xcode-select', ['-p']],
      ['/usr/bin/xcrun', ['--find', 'swiftc']],
    ]);
  });
});

describe('notes and entry guard', () => {
  it('prints the exact OCR notes', async () => {
    const { ocrNotBuiltNote, ocrBuildFailedNote } = await load();
    expect(ocrNotBuiltNote()).toBe(
      'OCR helper not built: install Xcode Command Line Tools with `xcode-select --install`; BotBoy works without it except text from images and scanned PDFs',
    );
    expect(ocrBuildFailedNote('error: boom')).toContain('error: boom');
  });

  it('has no side effects on import and is not the main module there', async () => {
    const { isMainModule } = await load();
    expect(isMainModule(bootstrapUrl, process.argv[1])).toBe(false);
    expect(isMainModule(bootstrapUrl, undefined)).toBe(false);
    expect(isMainModule(bootstrapUrl, '/nonexistent/path/x.mjs')).toBe(false);
    expect(isMainModule(bootstrapUrl, bootstrapPath)).toBe(true);
  });
});

function checkout() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'botboy-bootstrap-clt-'));
  roots.push(root);
  const real = path.join(root, 'real');
  fs.mkdirSync(path.join(real, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(real, 'native', 'vision-ocr'), { recursive: true });
  fs.copyFileSync(bootstrapPath, path.join(real, 'scripts', 'bootstrap-deps.mjs'));
  fs.writeFileSync(path.join(real, 'native', 'vision-ocr', 'main.swift'), '// stub\n');
  // The script is started through a symlinked path, like os.tmpdir() on macOS.
  const linked = path.join(root, 'linked');
  fs.symlinkSync(real, linked);
  const stubs = path.join(root, 'stubs');
  fs.mkdirSync(stubs);
  const marker = path.join(root, 'swiftc-ran');
  const stub = (name: string, body: string) => {
    const file = path.join(stubs, name);
    fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    return file;
  };
  const swiftc = stub('swiftc', `touch '${marker}'\necho 'error: stub compile failure' >&2\nexit 1`);
  const run = (env: Record<string, string>) =>
    spawnSync(process.execPath, [path.join(linked, 'scripts', 'bootstrap-deps.mjs')], {
      cwd: linked,
      env: { ...process.env, npm_lifecycle_event: '', PATH: `${stubs}:/usr/bin:/bin`, ...env },
      encoding: 'utf8',
      timeout: 20_000,
    });
  return { stub, swiftc, marker, run };
}

describe('scripts/bootstrap-deps.mjs without Command Line Tools', () => {
  it('exits 0, prints the note, and never runs swiftc, also through a symlink', () => {
    if (process.platform !== 'darwin') return;
    const box = checkout();
    const xcodeSelect = box.stub('xcode-select', 'exit 2');
    const result = box.run({ BOTBOY_TEST_XCODE_SELECT_BIN: xcodeSelect });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      'OCR helper not built: install Xcode Command Line Tools with `xcode-select --install`; BotBoy works without it except text from images and scanned PDFs',
    );
    expect(fs.existsSync(box.marker)).toBe(false);
  });

  it('exits 2 on a compile error outside npm, and 0 during postinstall', () => {
    if (process.platform !== 'darwin') return;
    const box = checkout();
    const xcodeSelect = box.stub('xcode-select', 'echo /stub/clt');
    const xcrun = box.stub('xcrun', `echo '${box.swiftc}'`);
    const env = { BOTBOY_TEST_XCODE_SELECT_BIN: xcodeSelect, BOTBOY_TEST_XCRUN_BIN: xcrun };

    const plain = box.run(env);
    expect(plain.status).toBe(2);
    expect(fs.existsSync(box.marker)).toBe(true);
    expect(plain.stdout).toContain('OCR helper build failed');

    const postinstall = box.run({ ...env, npm_lifecycle_event: 'postinstall' });
    expect(postinstall.status).toBe(0);
    expect(postinstall.stdout).toContain('OCR helper build failed');
  });
});
