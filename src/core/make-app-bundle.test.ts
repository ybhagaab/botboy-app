/**
 * scripts/make-app-bundle.mjs. macOS starts a shell-script .app, and a
 * compiled launcher with no arm64 slice, under Rosetta, and every child
 * inherits it; Info.plist's LSArchitecturePriority and a native re-exec in the
 * shell fallback fix that. Hardware is judged by sysctl, never process.arch.
 *
 * The launcher is GENERIC: it embeds no folder and reads the one it opens from
 * ~/.personal-productivity-tracker/app-checkout.v1, so every command-line case
 * below runs with HOME in a folder of its own (the script writes that file) and
 * with BOTBOY_TEST_NATIVE_ROOT at an empty folder unless it wants the real prebuilt
 * launcher. The tier choice, the checks and the migration have their own suites
 * (launcher-prebuilt, launcher-migration).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stubUiTools } from './launcher-fixtures.testutil';

vi.setConfig({ testTimeout: 60_000 });

const scriptPath = fileURLToPath(new URL('../../scripts/make-app-bundle.mjs', import.meta.url));
const scriptUrl = pathToFileURL(scriptPath).href;
const roots: string[] = [];
afterEach(() => {
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});
// Test hygiene: osascript, open and lsregister are recording stubs in every child here; none may be reached by accident.
let ui = null as unknown as ReturnType<typeof stubUiTools>;
beforeEach(() => {
  ui = stubUiTools(fs.mkdtempSync(path.join(os.tmpdir(), 'botboy-bundle-ui-')));
  roots.push(path.dirname(ui.dir));
});
afterEach(() => {
  expect(ui.calls(), 'a test reached osascript, open or lsregister').toEqual([]);
});

type Plan = { action: string; arch: string | null; lipo: boolean; notes: string[] };
type Mod = {
  renderInfoPlist: (options?: { appleSilicon?: boolean; bundleId?: string; launcherVersion?: number | null; minimumSystemVersion?: string }) => string;
  renderShellLauncher: (options?: { appleSilicon?: boolean }) => string;
  GENERIC_LAUNCHER_VERSION: number;
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
  it('marks a generic launcher with BotBoyLauncherVersion (the number native-prebuilt.mjs expects) and states the macOS floor', async () => {
    const { renderInfoPlist, GENERIC_LAUNCHER_VERSION } = await load();
    const nativeModule = await import(/* @vite-ignore */ pathToFileURL(path.join(path.dirname(scriptPath), 'native-prebuilt.mjs')).href) as { LAUNCHER_VERSION: number };
    expect(GENERIC_LAUNCHER_VERSION).toBe(nativeModule.LAUNCHER_VERSION);
    const plist = renderInfoPlist();
    expect(plist).toContain(`<key>BotBoyLauncherVersion</key><string>${nativeModule.LAUNCHER_VERSION}</string>`);
    expect(plist).toContain('<key>LSMinimumSystemVersion</key><string>12.0</string>');
    expect(renderInfoPlist({ minimumSystemVersion: '13.0' })).toContain('<key>LSMinimumSystemVersion</key><string>13.0</string>');
    // An unchanged older launcher keeps no marker it never earned.
    expect(renderInfoPlist({ launcherVersion: null })).not.toContain('BotBoyLauncherVersion');
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

describe('renderShellLauncher (generic: it reads the recorded folder)', () => {
  const record = (home: string, folder: string) => {
    fs.mkdirSync(path.join(home, '.personal-productivity-tracker'), { recursive: true });
    fs.writeFileSync(path.join(home, '.personal-productivity-tracker', 'app-checkout.v1'), `checkout=${folder}\nwritten=2026-10-13T10:00:00\n`);
  };
  const runScript = (launcher: string, env: Record<string, string>) => {
    const base = { ...process.env };
    for (const key of ['BOTBOY_APP_REEXEC', 'BOTBOY_APP_START_SCRIPT', 'BOTBOY_APP_PRINT_TARGET']) delete base[key];
    return spawnSync(launcher, [], { encoding: 'utf8', env: { ...base, ...ui.env, ...env } });
  };
  const awkward = ["it's $HOME `date` a b", 'plain'];
  for (const name of awkward) {
    it(`opens the recorded folder (${JSON.stringify(name)}) and runs its start.sh as written`, async () => {
      const { renderShellLauncher } = await load();
      const dir = tmp();
      const folder = path.join(dir, name);
      const startSh = path.join(folder, 'start.sh');
      fs.mkdirSync(folder, { recursive: true });
      fs.writeFileSync(startSh, '#!/bin/bash\necho "ran:$0:$*"\n', { mode: 0o755 });
      const home = path.join(dir, 'home');
      record(home, folder);
      for (const apple of [false, true]) {
        const launcher = path.join(dir, `launcher-${apple}`);
        fs.writeFileSync(launcher, renderShellLauncher({ appleSilicon: apple }), { mode: 0o755 });
        const syntax = spawnSync('/bin/bash', ['-n', launcher], { encoding: 'utf8' });
        expect(syntax.status, syntax.stderr).toBe(0);
        const result = runScript(launcher, { HOME: home });
        expect(result.stdout.trim()).toBe(`ran:${startSh}:--foreground`);
      }
    });
  }
  it('embeds no folder: the same script serves any checkout, and a moved folder is followed through the file', async () => {
    const { renderShellLauncher } = await load();
    const text = renderShellLauncher({ appleSilicon: false });
    expect(text).not.toMatch(/START_SH='/);
    expect(text).not.toMatch(/\/Users\//);
    expect(renderShellLauncher({ appleSilicon: false })).toBe(text);
    const dir = tmp();
    const launcher = path.join(dir, 'launcher');
    fs.writeFileSync(launcher, text, { mode: 0o755 });
    const home = path.join(dir, 'home');
    for (const name of ['first', 'second']) {
      const folder = path.join(dir, name);
      fs.mkdirSync(folder);
      fs.writeFileSync(path.join(folder, 'start.sh'), `#!/bin/bash\necho "${name}:$*"\n`, { mode: 0o755 });
    }
    record(home, path.join(dir, 'first'));
    expect(runScript(launcher, { HOME: home }).stdout.trim()).toBe('first:--foreground');
    record(home, path.join(dir, 'second'));
    expect(runScript(launcher, { HOME: home }).stdout.trim()).toBe('second:--foreground');
  });
  it('has the launcher\'s test hooks: BOTBOY_APP_PRINT_TARGET reports the folder and exits, BOTBOY_APP_START_SCRIPT overrides the file', async () => {
    const { renderShellLauncher } = await load();
    const dir = tmp();
    const launcher = path.join(dir, 'launcher');
    fs.writeFileSync(launcher, renderShellLauncher({ appleSilicon: true }), { mode: 0o755 });
    const folder = path.join(dir, 'folder');
    fs.mkdirSync(folder);
    const startSh = path.join(folder, 'start.sh');
    fs.writeFileSync(startSh, '#!/bin/bash\necho started\n', { mode: 0o755 });
    const home = path.join(dir, 'home');
    record(home, folder);
    const hook = { HOME: home, BOTBOY_APP_PRINT_TARGET: '1' };
    expect(runScript(launcher, hook)).toMatchObject({ status: 0, stdout: `target=${startSh}\n` });
    // An absolute override wins over the file; a relative one is ignored.
    const other = path.join(dir, 'other-start.sh');
    fs.writeFileSync(other, '#!/bin/bash\n', { mode: 0o755 });
    expect(runScript(launcher, { ...hook, BOTBOY_APP_START_SCRIPT: other }).stdout).toBe(`target=${other}\n`);
    expect(runScript(launcher, { ...hook, BOTBOY_APP_START_SCRIPT: 'relative/start.sh' }).stdout).toBe(`target=${startSh}\n`);
    // Nothing recorded, a folder without an executable start.sh, an override that is not executable: target=none, status 3.
    expect(runScript(launcher, { ...hook, HOME: path.join(dir, 'empty-home') })).toMatchObject({ status: 3 });
    fs.chmodSync(startSh, 0o644);
    expect(runScript(launcher, hook)).toMatchObject({ status: 3 });
  });
  it('treats an unusable record as "nothing recorded": relative path, control character, or a file over 8 KB', async () => {
    const { renderShellLauncher } = await load();
    const dir = tmp();
    const launcher = path.join(dir, 'launcher');
    fs.writeFileSync(launcher, renderShellLauncher({ appleSilicon: false }), { mode: 0o755 });
    const folder = path.join(dir, 'folder');
    fs.mkdirSync(folder);
    fs.writeFileSync(path.join(folder, 'start.sh'), '#!/bin/bash\n', { mode: 0o755 });
    const home = path.join(dir, 'home');
    fs.mkdirSync(path.join(home, '.personal-productivity-tracker'), { recursive: true });
    const file = path.join(home, '.personal-productivity-tracker', 'app-checkout.v1');
    const status = () => runScript(launcher, { HOME: home, BOTBOY_APP_PRINT_TARGET: '1' }).status;
    fs.writeFileSync(file, `checkout=${folder}\n`);
    expect(status()).toBe(0);
    fs.writeFileSync(file, 'checkout=relative/folder\n');
    expect(status()).toBe(3);
    fs.writeFileSync(file, `checkout=${folder}\u0007\n`);
    expect(status()).toBe(3);
    fs.writeFileSync(file, `checkout=${folder}\n${'#'.repeat(9000)}\n`);
    expect(status()).toBe(3);
  });
  it('re-executes natively under Rosetta on Apple Silicon only, once', async () => {
    if (!rosetta) return;
    const { renderShellLauncher } = await load();
    const dir = tmp();
    const startSh = path.join(dir, 'start.sh');
    fs.writeFileSync(startSh, '#!/bin/bash\necho "translated=$(/usr/sbin/sysctl -n sysctl.proc_translated) guard=${BOTBOY_APP_REEXEC:-}"\n', { mode: 0o755 });
    const run = (apple: boolean) => {
      const launcher = path.join(dir, `launcher-${apple}`);
      fs.writeFileSync(launcher, renderShellLauncher({ appleSilicon: apple }), { mode: 0o755 });
      const env = { ...process.env, ...ui.env, BOTBOY_APP_START_SCRIPT: startSh };
      delete env.BOTBOY_APP_REEXEC;
      return spawnSync('/usr/bin/arch', ['-x86_64', launcher], { encoding: 'utf8', env }).stdout.trim();
    };
    expect(run(true)).toBe('translated=0 guard=1');
    expect(run(false)).toBe('translated=1 guard=');
    // A second pass with the guard set never re-executes.
    const launcher = path.join(dir, 'launcher-true');
    const guarded = spawnSync('/usr/bin/arch', ['-x86_64', launcher], { encoding: 'utf8', env: { ...process.env, ...ui.env, BOTBOY_APP_START_SCRIPT: startSh, BOTBOY_APP_REEXEC: '1' } });
    expect(guarded.stdout.trim()).toBe('translated=1 guard=1');
  });
  it('shows a stale-launcher alert that names the next action instead of running when the folder is gone', async () => {
    const { renderShellLauncher } = await load();
    const launcher = renderShellLauncher({ appleSilicon: false });
    expect(launcher).toContain('BotBoy launcher is stale');
    expect(launcher).toContain('BotBoy could not find its folder. Open Terminal, go to your BotBoy folder (for example: cd ~/botboy-app) and run ./start.sh. That reconnects this app.');
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
  /**
   * A bundle destination in a folder of its own, HOME in a folder of its own (the script records the
   * folder and keeps a backup there), no Command Line Tools, and an empty native/ folder: no prebuilt
   * launcher exists, so the tier under test is the shell script unless a case says otherwise.
   */
  function build(extraArgs: string[], env: Record<string, string>) {
    const dir = tmp();
    const stubs = path.join(dir, 'stubs');
    const home = path.join(dir, 'home');
    const emptyNative = path.join(dir, 'native-root');
    for (const folder of [stubs, home, emptyNative]) fs.mkdirSync(folder);
    const calls = path.join(dir, 'lsregister-calls');
    const stub = (name: string, body: string) => {
      const file = path.join(stubs, name);
      fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
      return file;
    };
    const xcodeSelect = stub('xcode-select', 'exit 2');
    const lsregister = stub('lsregister', `echo "$@" >> '${calls}'`);
    // Not named *.app: macOS assesses (and may register) anything that looks like an application bundle once something runs from it.
    const dest = path.join(dir, 'bundle-under-test');
    const run = (args: string[] = extraArgs, more: Record<string, string> = {}) => spawnSync(process.execPath, [scriptPath, '--dest', dest, '--bundle-id', 'com.botboy.scratch', ...args], {
      env: { ...process.env, ...ui.env, HOME: home, BOTBOY_TEST_NATIVE_ROOT: emptyNative, BOTBOY_TEST_XCODE_SELECT_BIN: xcodeSelect, BOTBOY_TEST_LSREGISTER_BIN: lsregister, ...env, ...more },
      encoding: 'utf8',
      timeout: 60_000,
    });
    return { dir, home, dest, calls, run };
  }
  const packageRoot = fs.realpathSync(path.dirname(path.dirname(scriptPath)));

  it.skipIf(process.platform !== 'darwin')('with --no-register never calls lsregister; without it, calls it once', () => {
    const quiet = build(['--no-register'], { BOTBOY_TEST_HW_ARM64: '0' });
    const first = quiet.run();
    expect(first.status, first.stderr).toBe(0);
    expect(fs.existsSync(quiet.calls)).toBe(false);
    const loud = build([], { BOTBOY_TEST_HW_ARM64: '0' });
    expect(loud.run().status).toBe(0);
    expect(fs.readFileSync(loud.calls, 'utf8').trim().split('\n')).toEqual([`-f ${loud.dest}`]);
  });
  it.skipIf(process.platform !== 'darwin')('writes the priority key, the launcher version and a re-executing shell launcher on Apple Silicon, no priority and no re-exec on Intel', () => {
    const native = build(['--no-register'], { BOTBOY_TEST_HW_ARM64: '1' });
    const created = native.run();
    expect(created.status, created.stderr).toBe(0);
    const plist = fs.readFileSync(path.join(native.dest, 'Contents', 'Info.plist'), 'utf8');
    expect(plist).toContain('LSArchitecturePriority');
    expect(plist).toContain('<string>com.botboy.scratch</string>');
    expect(plist).toContain('<key>BotBoyLauncherVersion</key><string>2</string>');
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
  it.skipIf(process.platform !== 'darwin')('records this folder (its physical path) for the launcher, privately, and leaves no staged file in the bundle', () => {
    const b = build(['--no-register'], { BOTBOY_TEST_HW_ARM64: '1' });
    expect(b.run().status).toBe(0);
    const file = path.join(b.home, '.personal-productivity-tracker', 'app-checkout.v1');
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    expect(lines[0]).toBe(`checkout=${packageRoot}`);
    expect(lines[1]).toMatch(/^written=\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    const staged = (folder: string) => fs.readdirSync(folder).filter((name) => /botboy-(new|restore)/.test(name));
    expect(staged(path.join(b.dest, 'Contents'))).toEqual([]);
    expect(staged(path.join(b.dest, 'Contents', 'MacOS'))).toEqual([]);
    // The launcher it installed finds that folder: the script's own print-target hook says so.
    const printed = spawnSync(path.join(b.dest, 'Contents', 'MacOS', 'BotBoy'), [], { encoding: 'utf8', env: { ...process.env, ...ui.env, HOME: b.home, BOTBOY_APP_PRINT_TARGET: '1' } });
    expect(printed.stdout.trim()).toBe(`target=${path.join(packageRoot, 'start.sh')}`);
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
    // The plist is still refreshed, so a stale bundle gains the key, but it claims no launcher version it did not install.
    const plist = fs.readFileSync(path.join(b.dest, 'Contents', 'Info.plist'), 'utf8');
    expect(plist).toContain('LSArchitecturePriority');
    expect(plist).not.toContain('BotBoyLauncherVersion');
    expect(fs.readdirSync(macos)).toEqual(['BotBoy']);
  });
  it.skipIf(process.platform !== 'darwin')('--launcher-only needs a bundle, and when it cannot install it leaves the executable untouched and says why', () => {
    const b = build(['--launcher-only', '--no-register'], { BOTBOY_TEST_HW_ARM64: '1' });
    const missing = b.run();
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain('needs an existing bundle');
    expect(missing.stdout).toContain('reason=no_bundle');
    const macos = path.join(b.dest, 'Contents', 'MacOS');
    fs.mkdirSync(macos, { recursive: true });
    fs.copyFileSync('/bin/ls', path.join(macos, 'BotBoy'));
    const before = fs.readFileSync(path.join(macos, 'BotBoy'));
    const result = b.run();
    expect(result.status).toBe(1);
    expect(fs.readFileSync(path.join(macos, 'BotBoy')).equals(before)).toBe(true);
    expect(fs.readdirSync(macos)).toEqual(['BotBoy']);
    // The first reason start.sh would act on: there is no prebuilt launcher in this folder.
    expect(result.stdout).toMatch(/^reason=manifest_missing$/m);
    expect(result.stderr).toContain('the existing launcher is untouched');
    expect(fs.existsSync(b.calls)).toBe(false);
    // Nothing was recorded or backed up for a launcher that was not replaced.
    expect(fs.existsSync(path.join(b.home, '.personal-productivity-tracker', 'app-checkout.v1'))).toBe(false);
  });
  it.skipIf(process.platform !== 'darwin')('says so, and changes nothing, when scripts/native-prebuilt.mjs is missing from the folder', () => {
    // A copy of the script in a folder without its sibling module (a damaged checkout).
    const dir = tmp();
    const scripts = path.join(dir, 'scripts');
    fs.mkdirSync(scripts, { recursive: true });
    for (const name of ['make-app-bundle.mjs', 'bootstrap-deps.mjs']) fs.copyFileSync(path.join(path.dirname(scriptPath), name), path.join(scripts, name));
    const result = spawnSync(process.execPath, [path.join(scripts, 'make-app-bundle.mjs'), '--dest', path.join(dir, 'bundle-under-test'), '--no-register'], {
      env: { ...process.env, ...ui.env, HOME: path.join(dir, 'home') },
      encoding: 'utf8',
      timeout: 60_000,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('scripts/native-prebuilt.mjs is missing');
    expect(result.stderr).toContain('./start.sh --update');
    expect(result.stdout).toContain('reason=native_prebuilt_module_missing');
    expect(fs.existsSync(path.join(dir, 'bundle-under-test'))).toBe(false);
  });
});
