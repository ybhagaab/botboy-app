/**
 * scripts/make-app-bundle.mjs. macOS starts a shell-script .app, and a
 * compiled launcher with no arm64 slice, under Rosetta, and every child
 * inherits it; Info.plist's LSArchitecturePriority and a native re-exec in the
 * shell fallback fix that. Hardware is judged by sysctl, never process.arch.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: 60_000 });

const scriptPath = fileURLToPath(new URL('../../scripts/make-app-bundle.mjs', import.meta.url));
const scriptUrl = pathToFileURL(scriptPath).href;
const roots: string[] = [];
afterEach(() => {
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

type Plan = { action: string; arch: string | null; lipo: boolean; notes: string[] };
type Mod = {
  renderInfoPlist: (options?: { appleSilicon?: boolean; bundleId?: string }) => string;
  renderShellLauncher: (startSh: string, options?: { appleSilicon?: boolean }) => string;
  shellSingleQuote: (value: string) => string;
  planLauncherBuild: (facts: Record<string, boolean>) => Plan;
  hardwareIsAppleSilicon: (run?: (file: string, args: string[], options?: unknown) => unknown) => boolean;
  isMainModule: (metaUrl: string, argv1: string | undefined) => boolean;
  main: unknown;
};
const load = () => import(/* @vite-ignore */ scriptUrl) as Promise<Mod>;
const tmp = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'botboy-bundle-'));
  roots.push(dir);
  return dir;
};
const sysctl = (name: string) => spawnSync('/usr/sbin/sysctl', ['-n', name], { encoding: 'utf8' }).stdout.trim();
const appleSilicon = process.platform === 'darwin' && sysctl('hw.optional.arm64') === '1';
const rosetta = appleSilicon && spawnSync('/usr/bin/arch', ['-x86_64', '/usr/bin/true']).status === 0;

describe('importing make-app-bundle.mjs', () => {
  it('has no side effects and is not the main module there', async () => {
    const before = process.exitCode;
    const mod = await load();
    expect(process.exitCode).toBe(before);
    expect(typeof mod.main).toBe('function');
    expect(mod.isMainModule(scriptUrl, process.argv[1])).toBe(false);
    expect(mod.isMainModule(scriptUrl, scriptPath)).toBe(true);
    // The real file reached through a symlinked directory still counts.
    const link = path.join(tmp(), 'linked');
    fs.symlinkSync(path.dirname(scriptPath), link);
    expect(mod.isMainModule(scriptUrl, path.join(link, 'make-app-bundle.mjs'))).toBe(true);
  });
});

describe('renderInfoPlist', () => {
  it('writes LSArchitecturePriority [arm64, x86_64] only on Apple Silicon hardware', async () => {
    const { renderInfoPlist } = await load();
    const plain = renderInfoPlist({ appleSilicon: false });
    const native = renderInfoPlist({ appleSilicon: true });
    expect(plain).not.toContain('LSArchitecturePriority');
    expect(native).toContain('LSArchitecturePriority');
    expect(native.indexOf('<string>arm64</string>')).toBeGreaterThan(native.indexOf('LSArchitecturePriority'));
    expect(native.indexOf('<string>arm64</string>')).toBeLessThan(native.indexOf('<string>x86_64</string>'));
    expect(native.match(/<string>(arm64|x86_64)<\/string>/g)).toHaveLength(2);
    // Everything else is the same in both variants.
    expect(native.replace(/ {2}<key>LSArchitecturePriority<\/key>[\s\S]*?<\/array>\n/, '')).toBe(plain);
  });
  it('is a valid property list, with the bundle identifier it was given', async () => {
    if (process.platform !== 'darwin') return;
    const { renderInfoPlist } = await load();
    for (const apple of [false, true]) {
      const file = path.join(tmp(), 'Info.plist');
      fs.writeFileSync(file, renderInfoPlist({ appleSilicon: apple, bundleId: 'com.botboy.test.id' }));
      const lint = spawnSync('/usr/bin/plutil', ['-lint', file], { encoding: 'utf8' });
      expect(lint.status, lint.stdout + lint.stderr).toBe(0);
      expect(fs.readFileSync(file, 'utf8')).toContain('<string>com.botboy.test.id</string>');
    }
    expect(renderInfoPlist()).toContain('<string>com.botboy.tracker</string>');
  });
});

describe('renderShellLauncher', () => {
  const awkward = ["it's $HOME `date` a b", 'plain'];
  for (const name of awkward) {
    it(`single-quotes the script path (${JSON.stringify(name)}) so it runs as written`, async () => {
      const { renderShellLauncher } = await load();
      const dir = tmp();
      const startSh = path.join(dir, name, 'start.sh');
      fs.mkdirSync(path.dirname(startSh), { recursive: true });
      fs.writeFileSync(startSh, '#!/bin/bash\necho "ran:$0:$*"\n', { mode: 0o755 });
      for (const apple of [false, true]) {
        const launcher = path.join(dir, `launcher-${apple}`);
        fs.writeFileSync(launcher, renderShellLauncher(startSh, { appleSilicon: apple }), { mode: 0o755 });
        const syntax = spawnSync('/bin/bash', ['-n', launcher], { encoding: 'utf8' });
        expect(syntax.status, syntax.stderr).toBe(0);
        const result = spawnSync(launcher, [], { encoding: 'utf8', env: { ...process.env, BOTBOY_APP_REEXEC: '' } });
        expect(result.stdout.trim()).toBe(`ran:${startSh}:--foreground`);
      }
    });
  }
  it('re-executes natively under Rosetta on Apple Silicon only, once', async () => {
    if (!rosetta) return;
    const { renderShellLauncher } = await load();
    const dir = tmp();
    const startSh = path.join(dir, 'start.sh');
    fs.writeFileSync(startSh, '#!/bin/bash\necho "translated=$(/usr/sbin/sysctl -n sysctl.proc_translated) guard=${BOTBOY_APP_REEXEC:-}"\n', { mode: 0o755 });
    const run = (apple: boolean) => {
      const launcher = path.join(dir, `launcher-${apple}`);
      fs.writeFileSync(launcher, renderShellLauncher(startSh, { appleSilicon: apple }), { mode: 0o755 });
      const env = { ...process.env };
      delete env.BOTBOY_APP_REEXEC;
      return spawnSync('/usr/bin/arch', ['-x86_64', launcher], { encoding: 'utf8', env }).stdout.trim();
    };
    expect(run(true)).toBe('translated=0 guard=1');
    expect(run(false)).toBe('translated=1 guard=');
    // A second pass with the guard set never re-executes.
    const launcher = path.join(dir, 'launcher-true');
    const guarded = spawnSync('/usr/bin/arch', ['-x86_64', launcher], { encoding: 'utf8', env: { ...process.env, BOTBOY_APP_REEXEC: '1' } });
    expect(guarded.stdout.trim()).toBe('translated=1 guard=1');
  });
  it('shows a stale-launcher alert instead of running when start.sh is gone', async () => {
    const { renderShellLauncher } = await load();
    const launcher = renderShellLauncher('/no/such/start.sh', { appleSilicon: false });
    expect(launcher).toContain('Launcher is stale: start.sh not found. Re-run: npm run app:bundle');
    expect(launcher).not.toContain('sysctl');
  });
});

describe('planLauncherBuild', () => {
  it('ships a universal launcher when both slices built', async () => {
    const { planLauncherBuild } = await load();
    expect(planLauncherBuild({ appleSilicon: true, arm64: true, x86_64: true })).toEqual({ action: 'install', arch: 'universal', lipo: true, notes: [] });
  });
  it('ships the thin arm64 launcher with one note when the x86_64 slice failed', async () => {
    const { planLauncherBuild } = await load();
    const plan = planLauncherBuild({ appleSilicon: true, arm64: true, x86_64: false });
    expect(plan).toMatchObject({ action: 'install', arch: 'arm64', lipo: false });
    expect(plan.notes).toHaveLength(1);
  });
  it('keeps a working native launcher when the arm64 slice failed', async () => {
    const { planLauncherBuild } = await load();
    expect(planLauncherBuild({ appleSilicon: true, arm64: false, x86_64: true, hasExistingLauncher: true }).action).toBe('keep-existing');
  });
  it('falls back to the shell launcher only when no native launcher exists', async () => {
    const { planLauncherBuild } = await load();
    expect(planLauncherBuild({ appleSilicon: true, arm64: false, x86_64: false, hasExistingLauncher: false }).action).toBe('script');
  });
  it('keeps the plain build on Intel Macs', async () => {
    const { planLauncherBuild } = await load();
    expect(planLauncherBuild({ appleSilicon: false, plain: true })).toEqual({ action: 'install', arch: 'native', lipo: false, notes: [] });
    expect(planLauncherBuild({ appleSilicon: false, plain: false, hasExistingLauncher: true }).action).toBe('keep-existing');
    expect(planLauncherBuild({ appleSilicon: false, plain: false }).action).toBe('script');
  });
});

describe('hardwareIsAppleSilicon', () => {
  it('is true only when sysctl answers exactly 1, whatever process.arch says', async () => {
    const { hardwareIsAppleSilicon } = await load();
    const calls: Array<[string, string[]]> = [];
    const answer = (value: string | Error) => (file: string, args: string[]) => {
      calls.push([file, args]);
      if (value instanceof Error) throw value;
      return `${value}\n`;
    };
    expect(hardwareIsAppleSilicon(answer('1'))).toBe(true);
    expect(hardwareIsAppleSilicon(answer('0'))).toBe(false);
    expect(hardwareIsAppleSilicon(answer(''))).toBe(false);
    expect(hardwareIsAppleSilicon(answer(new Error('unknown oid')))).toBe(false);
    expect(calls[0]).toEqual(['/usr/sbin/sysctl', ['-n', 'hw.optional.arm64']]);
  });
});

describe('make-app-bundle.mjs command line', () => {
  function build(extraArgs: string[], env: Record<string, string>) {
    const dir = tmp();
    const stubs = path.join(dir, 'stubs');
    fs.mkdirSync(stubs);
    const calls = path.join(dir, 'lsregister-calls');
    const stub = (name: string, body: string) => {
      const file = path.join(stubs, name);
      fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
      return file;
    };
    // No Command Line Tools: the shell launcher is written, and nothing compiles.
    const xcodeSelect = stub('xcode-select', 'exit 2');
    const lsregister = stub('lsregister', `echo "$@" >> '${calls}'`);
    const dest = path.join(dir, 'BotBoy.app');
    const run = (args: string[] = extraArgs, more: Record<string, string> = {}) => spawnSync(process.execPath, [scriptPath, '--dest', dest, '--bundle-id', 'com.botboy.scratch', ...args], {
      env: { ...process.env, BOTBOY_TEST_XCODE_SELECT_BIN: xcodeSelect, BOTBOY_TEST_LSREGISTER_BIN: lsregister, ...env, ...more },
      encoding: 'utf8',
      timeout: 60_000,
    });
    return { dir, dest, calls, run };
  }

  it.skipIf(process.platform !== 'darwin')('with --no-register never calls lsregister; without it, calls it once', () => {
    const quiet = build(['--no-register'], { BOTBOY_TEST_HW_ARM64: '0' });
    const first = quiet.run();
    expect(first.status, first.stderr).toBe(0);
    expect(fs.existsSync(quiet.calls)).toBe(false);
    const loud = build([], { BOTBOY_TEST_HW_ARM64: '0' });
    expect(loud.run().status).toBe(0);
    expect(fs.readFileSync(loud.calls, 'utf8').trim().split('\n')).toEqual([`-f ${loud.dest}`]);
  });
  it.skipIf(process.platform !== 'darwin')('writes the priority key and a re-executing shell launcher on Apple Silicon, neither on Intel', () => {
    const native = build(['--no-register'], { BOTBOY_TEST_HW_ARM64: '1' });
    expect(native.run().status).toBe(0);
    const plist = fs.readFileSync(path.join(native.dest, 'Contents', 'Info.plist'), 'utf8');
    expect(plist).toContain('LSArchitecturePriority');
    expect(plist).toContain('<string>com.botboy.scratch</string>');
    const launcher = fs.readFileSync(path.join(native.dest, 'Contents', 'MacOS', 'BotBoy'), 'utf8');
    expect(launcher).toContain('BOTBOY_APP_REEXEC');
    expect(launcher).toContain('/usr/sbin/sysctl');
    expect(launcher).toContain('/usr/bin/arch');
    expect(launcher).toContain('shopt -s execfail');
    expect(fs.statSync(path.join(native.dest, 'Contents', 'MacOS', 'BotBoy')).mode & 0o111).toBe(0o111);
    const intel = build(['--no-register'], { BOTBOY_TEST_HW_ARM64: '0' });
    expect(intel.run().status).toBe(0);
    expect(fs.readFileSync(path.join(intel.dest, 'Contents', 'Info.plist'), 'utf8')).not.toContain('LSArchitecturePriority');
    expect(fs.readFileSync(path.join(intel.dest, 'Contents', 'MacOS', 'BotBoy'), 'utf8')).not.toContain('BOTBOY_APP_REEXEC');
  });
  it.skipIf(process.platform !== 'darwin')('never replaces a working native launcher with the shell fallback', () => {
    const b = build(['--no-register'], { BOTBOY_TEST_HW_ARM64: '1' });
    const macos = path.join(b.dest, 'Contents', 'MacOS');
    fs.mkdirSync(macos, { recursive: true });
    fs.copyFileSync('/bin/ls', path.join(macos, 'BotBoy'));
    const before = fs.readFileSync(path.join(macos, 'BotBoy'));
    const result = b.run();
    expect(result.status, result.stderr).toBe(0);
    expect(fs.readFileSync(path.join(macos, 'BotBoy')).equals(before)).toBe(true);
    expect(result.stdout).toContain('existing native launcher kept');
    // The plist is still refreshed, so a stale bundle gains the key.
    expect(fs.readFileSync(path.join(b.dest, 'Contents', 'Info.plist'), 'utf8')).toContain('LSArchitecturePriority');
  });
  it.skipIf(process.platform !== 'darwin')('--launcher-only leaves the executable untouched when it cannot build, and needs a bundle', () => {
    const b = build(['--launcher-only', '--no-register'], { BOTBOY_TEST_HW_ARM64: '1' });
    const missing = b.run();
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain('needs an existing bundle');
    const macos = path.join(b.dest, 'Contents', 'MacOS');
    fs.mkdirSync(macos, { recursive: true });
    fs.writeFileSync(path.join(macos, 'BotBoy'), 'original launcher bytes');
    const result = b.run();
    expect(result.status).toBe(1);
    expect(fs.readFileSync(path.join(macos, 'BotBoy'), 'utf8')).toBe('original launcher bytes');
    expect(fs.readdirSync(macos)).toEqual(['BotBoy']);
    expect(fs.existsSync(b.calls)).toBe(false);
  });
});
