/**
 * Migrating BotBoy.app to the generic prebuilt launcher, end to end: start.sh decides
 * (scripts/native-prebuilt.mjs launcher-facts + the plan table) and the REAL
 * scripts/make-app-bundle.mjs does the swap, against fixture launchers. The owner's own
 * app is a per-Mac compiled launcher with this folder's path built in (design-evidence E20):
 * it must keep working through the upgrade, and a failed upgrade must leave it exactly as it was.
 *
 * Hygiene (test-hygiene.test.ts): the bundle is not named *.app, HOME and the data folder are
 * private, osascript/open/lsregister are recording stubs, and no real launcher is started.
 * The "running copy" case runs a shell script as the old launcher, never an application.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  FILE_ARM, FILE_SCRIPT, bundlePlist, launcherBody, legacyCompiledBytes, legacyScriptText, sha256, stubUiTools, writeLauncherArtifacts,
  type ArtifactOptions,
} from './launcher-fixtures.testutil';

vi.setConfig({ testTimeout: 120_000 });

const packageRoot = fileURLToPath(new URL('../../', import.meta.url));
const read = (rel: string) => path.join(packageRoot, rel);
const PLISTBUDDY = '/usr/libexec/PlistBuddy';
const onMac = describe.runIf(process.platform === 'darwin');
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const roots: string[] = [];
const boxes: Array<{ ui: ReturnType<typeof stubUiTools> }> = [];
afterEach(() => {
  for (const made of boxes.splice(0)) expect(made.ui.calls(), 'a test reached osascript, open or lsregister').toEqual([]);
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

type Options = { artifacts?: ArtifactOptions; hw?: 'arm64' | 'intel'; toolchain?: boolean; macos?: string };

function migrationBox(options: Options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'botboy-migration-'));
  roots.push(root);
  const ui = stubUiTools(root);
  boxes.push({ ui });
  const home = path.join(root, 'home');
  const stubs = path.join(root, 'stubs');
  const marks = path.join(root, 'marks');
  const bundle = path.join(root, 'bundle-under-test'); // not *.app: nothing in a test may look like an application bundle
  for (const dir of [home, stubs, marks]) fs.mkdirSync(dir, { recursive: true });
  const stub = (name: string, body: string) => {
    const file = path.join(stubs, name);
    fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    return file;
  };
  /** A package folder: the real start.sh and scripts, fixture launcher artifacts. */
  const packageFolder = (name: string) => {
    const dir = path.join(root, name);
    fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'src', 'ui'), { recursive: true });
    fs.copyFileSync(read('start.sh'), path.join(dir, 'start.sh'));
    fs.chmodSync(path.join(dir, 'start.sh'), 0o755);
    for (const script of ['native-prebuilt.mjs', 'make-app-bundle.mjs', 'bootstrap-deps.mjs']) fs.copyFileSync(read(`scripts/${script}`), path.join(dir, 'scripts', script));
    fs.copyFileSync(read('src/ui/botboy_icon_512.png'), path.join(dir, 'src', 'ui', 'botboy_icon_512.png'));
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x' }));
    return dir;
  };
  const dir = packageFolder('app');
  const artifacts = writeLauncherArtifacts(dir, options.artifacts ?? {});
  const answer = path.join(marks, 'file-answer');
  const fileCalls = path.join(marks, 'file-calls');
  fs.writeFileSync(answer, `${FILE_ARM}\n`);
  const fileStub = stub('file', `echo "$@" >> '${fileCalls}'\ncat '${answer}'`);
  const xcodeSelect = stub('xcode-select', options.toolchain ? 'echo /stub/clt' : 'exit 2');
  const xcrun = stub('xcrun', 'echo /stub/swiftc');
  const lsregister = stub('lsregister', `echo "$@" >> '${path.join(marks, 'lsregister')}'`);
  const swVers = stub('sw_vers', `echo ${options.macos ?? '14.5'}`);
  const codesign = stub('codesign', 'exit 0');
  const lsof = stub('lsof', '');
  const exePath = path.join(bundle, 'Contents', 'MacOS', 'BotBoy');
  const plistPath = path.join(bundle, 'Contents', 'Info.plist');
  const dataDir = path.join(home, '.personal-productivity-tracker');
  const env = (extra: Record<string, string> = {}) => {
    const base: Record<string, string | undefined> = { ...process.env };
    for (const key of ['BOTBOY_NATIVE_REEXEC', 'BOTBOY_REEXEC_FROM']) delete base[key];
    return {
      ...base,
      ...ui.env,
      HOME: home,
      PPT_LOG_FILE: path.join(root, 'launcher.log'),
      BOTBOY_NO_ARCH_REEXEC: '1',
      BOTBOY_TEST_HW_ARM64: (options.hw ?? 'arm64') === 'arm64' ? '1' : '0',
      BOTBOY_TEST_ARCH_PROBE_OK: '1',
      BOTBOY_TEST_APP_BUNDLE: bundle,
      BOTBOY_TEST_FILE_BIN: fileStub,
      BOTBOY_TEST_LSREGISTER_BIN: lsregister,
      BOTBOY_TEST_XCODE_SELECT_BIN: xcodeSelect,
      BOTBOY_TEST_XCRUN_BIN: xcrun,
      BOTBOY_TEST_SW_VERS_BIN: swVers,
      BOTBOY_TEST_CODESIGN_BIN: codesign,
      BOTBOY_TEST_LSOF_BIN: lsof,
      ...extra,
    } as Record<string, string>;
  };
  const start = (folder: string, hook: string, extra: Record<string, string> = {}, args: string[] = []) =>
    spawnSync('/bin/bash', [path.join(folder, 'start.sh'), ...args], { cwd: folder, env: env({ [hook]: '1', ...extra }), encoding: 'utf8', timeout: 90_000 });
  const apply = (extra: Record<string, string> = {}, folder = dir) => {
    const result = start(folder, 'BOTBOY_TEST_APP_LAUNCHER_APPLY', extra);
    expect(result.status, result.stderr).toBe(0);
    return result.stdout;
  };
  const planOf = (folder = dir) => /^plan=(\w+)$/m.exec(start(folder, 'BOTBOY_TEST_APP_LAUNCHER_PLAN').stdout)?.[1];
  const makeBundle = (kind: 'compiled' | 'script' | 'compiled-other-live' | 'none', plist = bundlePlist({ version: null, priority: 'arm64-first' })) => {
    fs.mkdirSync(path.dirname(exePath), { recursive: true });
    fs.writeFileSync(plistPath, plist);
    const startSh = path.join(dir, 'start.sh');
    if (kind === 'none') return;
    const other = path.join(root, 'other-live');
    if (kind === 'compiled-other-live') {
      fs.mkdirSync(other, { recursive: true });
      fs.writeFileSync(path.join(other, 'start.sh'), '#!/bin/bash\n', { mode: 0o755 });
    }
    const bytes = kind === 'script' ? Buffer.from(legacyScriptText(startSh)) : legacyCompiledBytes(kind === 'compiled-other-live' ? path.join(other, 'start.sh') : startSh);
    fs.writeFileSync(exePath, bytes, { mode: 0o755 });
    fs.writeFileSync(answer, `${kind === 'script' ? FILE_SCRIPT : FILE_ARM}\n`);
  };
  const snapshot = () => ({
    exe: fs.existsSync(exePath) ? sha256(fs.readFileSync(exePath)) : null,
    plist: fs.existsSync(plistPath) ? sha256(fs.readFileSync(plistPath)) : null,
  });
  const leftovers = () => [path.join(bundle, 'Contents'), path.join(bundle, 'Contents', 'MacOS')].flatMap((folder) => (fs.existsSync(folder) ? fs.readdirSync(folder).filter((name) => /botboy-(new|restore)/.test(name)) : []));
  const plistValue = (key: string) => spawnSync(PLISTBUDDY, ['-c', `Print :${key}`, plistPath], { encoding: 'utf8' }).stdout.trim();
  const marker = () => (fs.existsSync(path.join(dataDir, 'app-launcher.v1')) ? fs.readFileSync(path.join(dataDir, 'app-launcher.v1'), 'utf8') : '');
  const recorded = () => (fs.existsSync(path.join(dataDir, 'app-checkout.v1')) ? fs.readFileSync(path.join(dataDir, 'app-checkout.v1'), 'utf8').split('\n')[0] : '');
  const fileCallCount = () => (fs.existsSync(fileCalls) ? fs.readFileSync(fileCalls, 'utf8').split('\n').filter(Boolean).length : 0);
  return {
    root, dir, home, bundle, exePath, plistPath, dataDir, artifacts, answer, ui, env, start, apply, planOf, makeBundle, snapshot, leftovers, plistValue, marker, recorded,
    fileCallCount, packageFolder, physicalDir: fs.realpathSync(dir),
  };
}

onMac('upgrading an older launcher to the generic prebuilt one', () => {
  it("replaces the owner's kind of launcher (compiled, this folder's path inside) once, and the next start leaves it alone", () => {
    const x = migrationBox();
    x.makeBundle('compiled');
    expect(x.planOf()).toBe('migrate');
    const out = x.apply();
    expect(out).toContain("Upgrading BotBoy.app's launcher so it follows this folder (prebuilt, no developer tools needed)");
    expect(out).toContain('BotBoy.app upgraded; this takes effect at the next app launch: quit and reopen BotBoy');
    expect(sha256(fs.readFileSync(x.exePath))).toBe(sha256(x.artifacts.body));
    expect(x.plistValue('BotBoyLauncherVersion')).toBe('2');
    expect(x.plistValue('LSMinimumSystemVersion')).toBe('13.0');
    expect(x.plistValue('LSArchitecturePriority:0')).toBe('arm64');
    expect(x.recorded()).toBe(`checkout=${x.physicalDir}`);
    expect(x.marker()).toMatch(/^result=ok$/m);
    expect(x.leftovers()).toEqual([]);
    // Idempotent: generic, owned, key right: nothing to do, nothing printed, nothing rewritten.
    expect(x.planOf()).toBe('none');
    const before = x.snapshot();
    expect(x.apply()).toBe('');
    expect(x.snapshot()).toEqual(before);
  });

  it('upgrades an older script launcher to the native one without a compiler', () => {
    const x = migrationBox({ toolchain: false });
    x.makeBundle('script');
    const out = x.apply();
    expect(out).toContain('BotBoy.app upgraded');
    expect(sha256(fs.readFileSync(x.exePath))).toBe(sha256(x.artifacts.body));
    expect(x.plistValue('BotBoyLauncherVersion')).toBe('2');
  });

  it('keeps the old launcher and Info.plist in the data folder (latest only)', () => {
    const x = migrationBox();
    x.makeBundle('compiled');
    const before = x.snapshot();
    x.apply();
    const backup = path.join(x.dataDir, 'app-launcher-backup');
    expect(sha256(fs.readFileSync(path.join(backup, 'BotBoy')))).toBe(before.exe);
    expect(sha256(fs.readFileSync(path.join(backup, 'Info.plist')))).toBe(before.plist);
  });

  it("does not take another checkout's app: its launcher, Info.plist and recorded folder are untouched", () => {
    const x = migrationBox();
    x.makeBundle('compiled-other-live');
    const before = x.snapshot();
    expect(x.planOf()).toBe('none');
    expect(x.apply()).toBe('');
    expect(x.snapshot()).toEqual(before);
    expect(x.recorded()).toBe('');
    expect(fs.existsSync(path.join(x.dataDir, 'app-launcher-backup'))).toBe(false);
  });

  it('a Mac that can run the launcher only on macOS 13 keeps its older launcher on macOS 12, quietly', () => {
    const x = migrationBox({ macos: '12.7.6', toolchain: false });
    x.makeBundle('script');
    const before = x.snapshot();
    expect(x.planOf()).toBe('none');
    expect(x.apply()).toBe('');
    expect(x.snapshot()).toEqual(before);
  });

  it('an Intel Mac is upgraded without reading the executable with `file`, and gets no architecture key', () => {
    const x = migrationBox({ hw: 'intel' });
    x.makeBundle('compiled', bundlePlist({ version: null, priority: 'none' }));
    const out = x.apply();
    expect(out).toContain('BotBoy.app upgraded');
    expect(x.plistValue('BotBoyLauncherVersion')).toBe('2');
    expect(spawnSync(PLISTBUDDY, ['-c', 'Print :LSArchitecturePriority', x.plistPath], { encoding: 'utf8' }).status).not.toBe(0);
    // The builder asks `file` about the launcher it replaces (it must know whether a native one exists); start.sh does not.
    expect(x.fileCallCount()).toBeLessThanOrEqual(1);
  });

  it('an interrupted swap (new Info.plist beside the old executable) is repaired by the next start', () => {
    const x = migrationBox();
    x.makeBundle('compiled', bundlePlist({ version: 2, minimum: '13.0', priority: 'arm64-first' }));
    expect(x.planOf()).toBe('migrate');
    expect(x.apply()).toContain('BotBoy.app upgraded');
    expect(sha256(fs.readFileSync(x.exePath))).toBe(sha256(x.artifacts.body));
    expect(x.planOf()).toBe('none');
  });

  it('creates a missing bundle with the prebuilt launcher (first run) and records the folder', () => {
    const x = migrationBox();
    expect(x.planOf()).toBe('create');
    const out = x.apply();
    expect(out).toContain('BotBoy.app installed');
    expect(sha256(fs.readFileSync(x.exePath))).toBe(sha256(x.artifacts.body));
    expect(x.recorded()).toBe(`checkout=${x.physicalDir}`);
    expect(fs.existsSync(path.join(x.bundle, 'Contents', 'Resources', 'BotBoy.icns'))).toBe(true);
    expect(x.planOf()).toBe('none');
  });
});

onMac('the folder moves', () => {
  it('running ./start.sh from the new location re-points the app, once, and never while the old folder still exists', () => {
    const x = migrationBox();
    x.makeBundle('compiled');
    x.apply();
    expect(x.recorded()).toBe(`checkout=${x.physicalDir}`);
    // A second checkout while the first still exists: the app is not taken.
    const second = x.packageFolder('second');
    writeLauncherArtifacts(second, {});
    const before = x.recorded();
    expect(x.apply({}, second)).toBe('');
    expect(x.recorded()).toBe(before);
    // The first folder moves.
    const moved = path.join(x.root, 'moved to a new place');
    fs.renameSync(x.dir, moved);
    expect(x.planOf(moved)).toBe('none');
    const out = x.apply({}, moved);
    expect(out).toContain('BotBoy.app now opens this folder');
    expect(x.recorded()).toBe(`checkout=${fs.realpathSync(moved)}`);
    // Healed: the second run says nothing.
    expect(x.apply({}, moved)).toBe('');
    // And the other checkout, whose folder is still there, does not take it back.
    expect(x.apply({}, second)).toBe('');
    expect(x.recorded()).toBe(`checkout=${fs.realpathSync(moved)}`);
  });
});

onMac('a failed upgrade changes nothing (finding 1, finding 13)', () => {
  it('a Mac where the prebuilt launcher will not run and nothing can build one is left quiet: nothing is attempted, nothing is recorded', () => {
    const x = migrationBox({ artifacts: { kind: 'self-kill' }, toolchain: false });
    x.makeBundle('compiled');
    const before = x.snapshot();
    expect(x.planOf()).toBe('none');
    expect(x.apply()).toBe('');
    expect(x.snapshot()).toEqual(before);
    expect(x.marker()).toBe('');
  });

  it('an upgrade that was planned and then failed is reported with its reason, recorded, and not retried until something changes', () => {
    // A toolchain exists (so an upgrade is worth trying) but the prebuilt launcher will not run and the stub compiler is not there.
    const x = migrationBox({ artifacts: { kind: 'self-kill' }, toolchain: true });
    x.makeBundle('compiled');
    const before = x.snapshot();
    const first = x.apply();
    expect(first).toContain('could not be upgraded (macOS would not run the new launcher on this Mac); the current one keeps working. Next: ./start.sh --doctor');
    expect(x.snapshot()).toEqual(before);
    expect(x.leftovers()).toEqual([]);
    expect(x.marker()).toMatch(/^result=failed$/m);
    expect(x.marker()).toMatch(/^reason=launcher_smoke_failed$/m);
    expect(x.recorded()).toBe('');
    expect(fs.existsSync(path.join(x.dataDir, 'app-launcher-backup'))).toBe(false);
    // The same state is not tried again; it says why in one line.
    expect(x.planOf()).toBe('warn_harmless');
    const second = x.apply();
    expect(second).toContain('the last upgrade did not work here (macOS would not run the new launcher on this Mac)');
    expect(x.snapshot()).toEqual(before);
    // A release that ships a launcher that runs changes the manifest: the next start tries again, and succeeds.
    writeLauncherArtifacts(x.dir, { kind: 'ok' });
    expect(x.planOf()).toBe('migrate');
    expect(x.apply()).toContain('BotBoy.app upgraded');
    expect(sha256(fs.readFileSync(x.exePath))).toBe(sha256(launcherBody('ok')));
  });

  const injected: Array<[string, string]> = [
    ['before_swap', 'swap_failed'],
    ['after_plist', 'swap_failed'],
    ['after_exe', 'swap_failed'],
    ['readback', 'readback_failed'],
  ];
  for (const [point, reason] of injected) {
    it(`a failure at "${point}" puts the old launcher and Info.plist back byte for byte`, () => {
      const x = migrationBox();
      x.makeBundle('compiled');
      const before = x.snapshot();
      const out = x.apply({ BOTBOY_TEST_BUNDLE_FAIL_AT: point });
      expect(out).toContain('could not be upgraded');
      expect(out).toContain('the new launcher did not check out once it was in place, so the previous one was put back');
      expect(x.snapshot()).toEqual(before);
      expect(x.leftovers()).toEqual([]);
      expect(x.marker()).toMatch(new RegExp(`^reason=${reason}$`, 'm'));
    });
  }

  it('when the restore itself fails, it does not claim the old launcher is back: it names the copies and the way out', () => {
    const x = migrationBox();
    x.makeBundle('compiled');
    const before = x.snapshot();
    const out = x.apply({ BOTBOY_TEST_BUNDLE_FAIL_AT: 'readback+restore' });
    expect(out).toContain('the previous one could not be put back automatically; its copies are in ~/.personal-productivity-tracker/app-launcher-backup');
    expect(out).toContain(`Next: remove ${x.bundle} and run ./start.sh to build it again`);
    expect(out).not.toContain('the current one keeps working');
    expect(x.marker()).toMatch(/^reason=restore_failed$/m);
    // The copies of what was replaced are there to put back by hand.
    const backup = path.join(x.dataDir, 'app-launcher-backup');
    expect(sha256(fs.readFileSync(path.join(backup, 'BotBoy')))).toBe(before.exe);
    expect(sha256(fs.readFileSync(path.join(backup, 'Info.plist')))).toBe(before.plist);
    expect(x.leftovers()).toEqual([]);
  });

  it('a running copy of the old launcher is not disturbed by the swap (the new file is a new inode)', async () => {
    const x = migrationBox();
    x.makeBundle('script');
    const marks = path.join(x.root, 'running');
    fs.writeFileSync(
      x.exePath,
      `#!/bin/bash\nSTART_SH='${path.join(x.dir, 'start.sh')}'\necho started > '${marks}'\nsleep 3\necho finished >> '${marks}'\n`,
      { mode: 0o755 },
    );
    const child = spawn(x.exePath, [], { stdio: 'ignore' });
    const exited = new Promise<number | null>((resolve) => child.on('exit', resolve));
    for (let waited = 0; !fs.existsSync(marks) && waited < 100; waited++) await sleep(50);
    expect(fs.readFileSync(marks, 'utf8')).toBe('started\n');
    const out = x.apply();
    expect(out).toContain('BotBoy.app upgraded');
    expect(sha256(fs.readFileSync(x.exePath))).toBe(sha256(x.artifacts.body));
    expect(await exited).toBe(0);
    expect(fs.readFileSync(marks, 'utf8')).toBe('started\nfinished\n');
  });
});
