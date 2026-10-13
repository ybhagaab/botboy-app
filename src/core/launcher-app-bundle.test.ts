/**
 * start.sh › the BotBoy.app launcher plan. macOS starts a shell-script app, and
 * a compiled launcher with no arm64 slice, under Rosetta unless Info.plist
 * prefers arm64; the launcher itself is now GENERIC (it reads the folder it opens
 * from ~/.personal-productivity-tracker/app-checkout.v1), so start.sh also
 * upgrades older per-Mac launchers, keeps the recorded folder current (a moved
 * folder is followed), and never takes the app from a checkout that still exists.
 *
 * The plan is a pure table over facts. Facts come from the shell (`file -b`, the
 * Info.plist keys, the ownership grep) and from ONE Node call
 * (scripts/native-prebuilt.mjs launcher-facts) that runs here against fixtures:
 * a fixture prebuilt launcher with a manifest, older launchers that embed the folder.
 * Nothing touches the owner's real /Applications/BotBoy.app: every test points
 * BOTBOY_TEST_APP_BUNDLE at a scratch bundle and HOME at a temp dir.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  FILE_ARM, FILE_FAT, FILE_INTEL, FILE_SCRIPT, bundlePlist, legacyCompiledBytes, legacyScriptText, launcherBody, stubUiTools, writeLauncherArtifacts,
} from './launcher-fixtures.testutil';

// Each case spawns the launcher a few times; a loaded Mac needs more than 5 s.
vi.setConfig({ testTimeout: 120_000 });

const launcherPath = fileURLToPath(new URL('../../start.sh', import.meta.url));
const nativePrebuiltPath = fileURLToPath(new URL('../../scripts/native-prebuilt.mjs', import.meta.url));
const PLISTBUDDY = '/usr/libexec/PlistBuddy';
const roots: string[] = [];
// Test hygiene: every box has recording stubs for osascript, open and lsregister first on PATH; none may be reached.
const boxes: Array<{ ui: ReturnType<typeof stubUiTools> }> = [];
afterEach(() => {
  for (const made of boxes.splice(0)) expect(made.ui.calls(), 'a test reached osascript, open or lsregister').toEqual([]);
  while (roots.length) {
    const root = roots.pop()!;
    spawnSync('/bin/chmod', ['-R', 'u+rwX', root]);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

type Priority = 'none' | 'arm64-first' | 'x86-first' | 'extra';
type Prebuilt = 'usable' | 'missing' | 'os-too-old';
type Exe = 'legacy' | 'legacy-physical' | 'legacy-other-live' | 'legacy-other-gone' | 'generic' | 'generic-script' | 'legacy-script' | 'legacy-script-other-live' | 'none';
type Recorded = 'none' | 'this' | 'other-live' | 'other-gone';
type Marker = 'none' | 'failed-current' | 'failed-old-launcher' | 'failed-old-builder' | 'failed-old-manifest' | 'ok';

function box(options: { facts?: boolean; prebuilt?: Prebuilt } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'botboy-applauncher-'));
  roots.push(root);
  const dir = path.join(root, 'app');
  const stubs = path.join(root, 'stubs');
  const marks = path.join(root, 'marks');
  const home = path.join(root, 'home');
  // Not named *.app: macOS assesses (and may register) anything that looks like an application bundle once something runs from it.
  const bundle = path.join(root, 'bundle-under-test');
  const otherLive = path.join(root, 'other-live');
  for (const d of [dir, stubs, marks, home, path.join(dir, 'scripts'), otherLive]) fs.mkdirSync(d, { recursive: true });
  fs.copyFileSync(launcherPath, path.join(dir, 'start.sh'));
  fs.chmodSync(path.join(dir, 'start.sh'), 0o755);
  fs.writeFileSync(path.join(otherLive, 'start.sh'), '#!/bin/bash\n', { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x' }));
  if (options.facts !== false) fs.copyFileSync(nativePrebuiltPath, path.join(dir, 'scripts', 'native-prebuilt.mjs'));
  const prebuilt = options.prebuilt ?? 'usable';
  if (prebuilt !== 'missing') writeLauncherArtifacts(dir);
  const stub = (name: string, body: string) => {
    const file = path.join(stubs, name);
    fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    return file;
  };
  const answerFile = path.join(root, 'file-answer');
  const fileCalls = path.join(marks, 'file-calls');
  const fileStub = stub('file', `echo "$@" >> '${fileCalls}'\ncat '${answerFile}'`);
  const xcodeSelectOk = stub('xcode-select', 'echo /stub/clt');
  const xcodeSelectNo = stub('xcode-select-no', 'exit 2');
  const xcrunOk = stub('xcrun', 'echo /stub/swiftc');
  const ui = stubUiTools(root);
  boxes.push({ ui });
  const lsregister = stub('lsregister', `echo "$@" >> '${path.join(marks, 'lsregister')}'`);
  const codesign = stub('codesign', 'exit 0');
  const swVers = stub('sw_vers', `echo ${prebuilt === 'os-too-old' ? '12.7.6' : '14.5'}`);
  const plistPath = path.join(bundle, 'Contents', 'Info.plist');
  const exePath = path.join(bundle, 'Contents', 'MacOS', 'BotBoy');
  const physicalDir = fs.realpathSync(dir);
  const buddy = (...commands: string[]) =>
    spawnSync(PLISTBUDDY, commands.flatMap((c) => ['-c', c]).concat(plistPath), { encoding: 'utf8' });
  const exeBytes = (kind: Exe): Buffer => {
    const startSh = path.join(dir, 'start.sh');
    switch (kind) {
      case 'legacy': return legacyCompiledBytes(startSh);
      case 'legacy-physical': return legacyCompiledBytes(path.join(physicalDir, 'start.sh'));
      case 'legacy-other-live': return legacyCompiledBytes(path.join(otherLive, 'start.sh'));
      case 'legacy-other-gone': return legacyCompiledBytes('/no/such/folder/start.sh');
      case 'legacy-script': return Buffer.from(legacyScriptText(startSh));
      case 'legacy-script-other-live': return Buffer.from(legacyScriptText(path.join(otherLive, 'start.sh')));
      case 'generic-script': return Buffer.from('#!/bin/bash\n# generic script launcher fixture\nexit 0\n');
      default: return launcherBody('ok');
    }
  };
  const record = (state: Recorded) => {
    const file = path.join(home, '.personal-productivity-tracker', 'app-checkout.v1');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const folder = { this: physicalDir, 'other-live': otherLive, 'other-gone': '/no/such/folder' }[state as 'this'];
    if (state === 'none') fs.rmSync(file, { force: true });
    else fs.writeFileSync(file, `checkout=${folder}\nwritten=2026-10-13T10:00:00\n`, { mode: 0o600 });
  };
  /** Create the scratch bundle; `exe: 'none'` leaves the executable out. */
  const makeBundle = (o: { file?: string; priority?: Priority; exe?: Exe; version?: number | null; recorded?: Recorded; plist?: string }) => {
    fs.mkdirSync(path.dirname(plistPath), { recursive: true });
    fs.mkdirSync(path.dirname(exePath), { recursive: true });
    const priority = o.priority ?? 'none';
    fs.writeFileSync(plistPath, o.plist ?? bundlePlist({ version: o.version ?? null }));
    fs.writeFileSync(answerFile, `${o.file ?? FILE_ARM}\n`);
    const exe = o.exe ?? 'legacy';
    if (exe !== 'none') fs.writeFileSync(exePath, exeBytes(exe), { mode: 0o755 });
    const entries: Record<Priority, string[]> = {
      none: [],
      'arm64-first': ['arm64', 'x86_64'],
      'x86-first': ['x86_64', 'arm64'],
      extra: ['x86_64', 'arm64', 'x86_64'],
    };
    if (priority !== 'none') {
      buddy('Add :LSArchitecturePriority array', ...entries[priority].map((value, index) => `Add :LSArchitecturePriority:${index} string ${value}`));
    }
    if (o.recorded) record(o.recorded);
  };
  const priorityOf = () => {
    const out = buddy('Print :LSArchitecturePriority').stdout;
    return out.split('\n').map((line) => line.trim()).filter((line) => line && line !== 'Array {' && line !== '}');
  };
  const markerFile = path.join(home, '.personal-productivity-tracker', 'app-launcher.v1');
  const signature = (file: string) => {
    const stat = fs.statSync(file);
    return `${stat.size}:${Math.floor(stat.mtimeMs / 1000)}`;
  };
  /** Write the marker of an earlier failed upgrade, matching the current launcher/builder/manifest or not. */
  const writeMarker = (kind: Marker, reason = 'launcher_smoke_failed') => {
    fs.mkdirSync(path.dirname(markerFile), { recursive: true });
    const builder = path.join(dir, 'scripts', 'make-app-bundle.mjs');
    if (!fs.existsSync(builder)) fs.writeFileSync(builder, '// builder\n');
    const manifest = path.join(dir, 'native', 'prebuilt-manifest.json');
    const sigs = {
      launcher: signature(exePath),
      builder: signature(builder),
      manifest: fs.existsSync(manifest) ? signature(manifest) : '',
    };
    if (kind === 'failed-old-launcher') sigs.launcher = '1:1';
    if (kind === 'failed-old-builder') sigs.builder = '1:1';
    if (kind === 'failed-old-manifest') sigs.manifest = '1:1';
    fs.writeFileSync(markerFile, `launcher=${sigs.launcher}\nbuilder=${sigs.builder}\nmanifest=${sigs.manifest}\nresult=${kind === 'ok' ? 'ok' : 'failed'}\nreason=${reason}\ndate=2026-10-13T10:00:00\n`);
  };
  const env = (extra: Record<string, string> = {}) => {
    const base: Record<string, string | undefined> = { ...process.env };
    for (const key of ['BOTBOY_NATIVE_REEXEC', 'BOTBOY_REEXEC_FROM']) delete base[key];
    return {
      ...base,
      ...ui.env,
      HOME: home,
      PPT_LOG_FILE: path.join(root, 'launcher.log'),
      BOTBOY_NO_ARCH_REEXEC: '1',
      BOTBOY_TEST_HW_ARM64: '1',
      BOTBOY_TEST_ARCH_PROBE_OK: '1',
      BOTBOY_TEST_APP_BUNDLE: bundle,
      BOTBOY_TEST_FILE_BIN: fileStub,
      BOTBOY_TEST_LSREGISTER_BIN: lsregister,
      BOTBOY_TEST_XCODE_SELECT_BIN: xcodeSelectOk,
      BOTBOY_TEST_XCRUN_BIN: xcrunOk,
      BOTBOY_TEST_CODESIGN_BIN: codesign,
      BOTBOY_TEST_SW_VERS_BIN: swVers,
      BOTBOY_TEST_LSOF_BIN: stub('lsof', ''),
      ...extra,
    } as Record<string, string>;
  };
  const run = (hook: string, extra: Record<string, string> = {}, args: string[] = []) =>
    spawnSync('/bin/bash', [path.join(dir, 'start.sh'), ...args], {
      cwd: dir,
      env: env({ [hook]: '1', ...extra }),
      encoding: 'utf8',
      timeout: 60_000,
    });
  const planOf = (extra: Record<string, string> = {}, args: string[] = []) => {
    const result = run('BOTBOY_TEST_APP_LAUNCHER_PLAN', extra, args);
    expect(result.status, result.stderr).toBe(0);
    return {
      plan: /^plan=(\w+)$/m.exec(result.stdout)![1],
      claim: /^checkout_action=(\w+)$/m.exec(result.stdout)![1] === 'claim',
      facts: /^kind=.*$/m.exec(result.stdout)?.[0] ?? '',
    };
  };
  const lsregisterCalls = () => {
    const file = path.join(marks, 'lsregister');
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n') : [];
  };
  const fileCallCount = () => (fs.existsSync(fileCalls) ? fs.readFileSync(fileCalls, 'utf8').split('\n').filter(Boolean).length : 0);
  return {
    root, dir, physicalDir, home, bundle, otherLive, plistPath, exePath, marks, markerFile, stub, xcodeSelectNo, makeBundle, record, writeMarker,
    priorityOf, buddy, env, run, planOf, lsregisterCalls, fileCallCount,
  };
}

type Case = {
  name: string;
  hw?: 'arm64' | 'intel';
  file?: string;
  exe?: Exe;
  version?: number | null;
  priority?: Priority;
  recorded?: Recorded;
  prebuilt?: Prebuilt;
  toolchain?: boolean;
  args?: string[];
  marker?: Marker;
  noBundle?: boolean;
  plan: string;
  claim?: boolean;
};

function runCase(c: Case) {
  const b = box({ prebuilt: c.prebuilt });
  if (!c.noBundle) {
    b.makeBundle({ file: c.file ?? FILE_ARM, priority: c.priority ?? 'arm64-first', exe: c.exe ?? 'legacy', version: c.version, recorded: c.recorded });
    if (c.marker && c.marker !== 'none') b.writeMarker(c.marker);
  }
  const extra: Record<string, string> = {};
  if (c.hw === 'intel') extra.BOTBOY_TEST_HW_ARM64 = '0';
  if (c.toolchain === false) extra.BOTBOY_TEST_XCODE_SELECT_BIN = b.xcodeSelectNo;
  const got = b.planOf(extra, c.args ?? []);
  expect({ plan: got.plan, claim: got.claim }, `${c.name} [${got.facts}]`).toEqual({ plan: c.plan, claim: c.claim ?? false });
  return b;
}

describe('app_launcher_plan: the total table (design 5.8, rows 1 to 8)', () => {
  it('row 1: creates the bundle when it is missing or has no executable, on any hardware', () => {
    runCase({ name: 'no bundle', noBundle: true, plan: 'create' });
    runCase({ name: 'no bundle, Intel', noBundle: true, hw: 'intel', plan: 'create' });
    runCase({ name: 'bundle without executable', exe: 'none', plan: 'create' });
    runCase({ name: 'bundle without executable, Intel', exe: 'none', hw: 'intel', plan: 'create' });
  });

  it('create does not depend on Node: with no scripts/native-prebuilt.mjs a missing bundle is still created', () => {
    const b = box({ facts: false });
    expect(b.planOf().plan).toBe('create');
  });

  it('row 2: leaves a launcher of an unknown kind alone', () => {
    runCase({ name: 'file -b says data', file: 'data', plan: 'none' });
  });

  it('row 3: never takes the app from another checkout that still exists', () => {
    runCase({ name: 'older compiled launcher of another live folder', exe: 'legacy-other-live', plan: 'none' });
    runCase({ name: 'older script launcher of another live folder', exe: 'legacy-script-other-live', file: FILE_SCRIPT, plan: 'none' });
    runCase({ name: 'generic launcher recording another live folder', exe: 'generic', version: 2, recorded: 'other-live', file: FILE_FAT, plan: 'none' });
    runCase({ name: 'generic launcher recording another live folder, Intel', exe: 'generic', version: 2, recorded: 'other-live', hw: 'intel', plan: 'none' });
    // Not even the architecture key of another checkout's app is touched, and nothing is claimed.
    runCase({ name: 'generic launcher of another live folder with a wrong key', exe: 'generic', version: 2, recorded: 'other-live', file: FILE_FAT, priority: 'none', plan: 'none' });
  });

  it('row 4: a generic native launcher needs only the architecture key (and the recorded folder)', () => {
    runCase({ name: 'generic, this folder, arm64 first', exe: 'generic', version: 2, recorded: 'this', file: FILE_FAT, plan: 'none' });
    runCase({ name: 'generic, this folder, key missing', exe: 'generic', version: 2, recorded: 'this', file: FILE_FAT, priority: 'none', plan: 'patch_plist' });
    runCase({ name: 'generic, this folder, x86_64 first', exe: 'generic', version: 2, recorded: 'this', file: FILE_FAT, priority: 'x86-first', plan: 'patch_plist' });
    runCase({ name: 'a newer launcher version than this code wants is still generic', exe: 'generic', version: 3, recorded: 'this', file: FILE_FAT, plan: 'none' });
    runCase({ name: 'generic and prebuilt unusable: still nothing to upgrade', exe: 'generic', version: 2, recorded: 'this', file: FILE_FAT, prebuilt: 'missing', plan: 'none' });
  });

  it('the folder moved: a generic launcher whose recorded folder is gone, or empty, is claimed by this folder', () => {
    runCase({ name: 'recorded folder gone', exe: 'generic', version: 2, recorded: 'other-gone', file: FILE_FAT, plan: 'none', claim: true });
    runCase({ name: 'nothing recorded', exe: 'generic', version: 2, recorded: 'none', file: FILE_FAT, plan: 'none', claim: true });
    runCase({ name: 'recorded folder gone and the key is missing', exe: 'generic', version: 2, recorded: 'other-gone', file: FILE_FAT, priority: 'none', plan: 'patch_plist', claim: true });
    // The recorded folder is this one: nothing to do. A second checkout never claims a live one.
    runCase({ name: 'recorded this folder', exe: 'generic', version: 2, recorded: 'this', file: FILE_FAT, plan: 'none', claim: false });
    runCase({ name: 'recorded another live folder', exe: 'generic', version: 2, recorded: 'other-live', file: FILE_FAT, plan: 'none', claim: false });
  });

  it('row 5: while the app may be this very launcher (--foreground) nothing is swapped, and the earlier rules still apply', () => {
    runCase({ name: 'older arm64 launcher, key right', args: ['--foreground'], plan: 'none' });
    runCase({ name: 'older script launcher, key missing', exe: 'legacy-script', file: FILE_SCRIPT, priority: 'none', args: ['--foreground'], plan: 'patch_plist' });
    runCase({ name: 'older Intel-only launcher', exe: 'legacy', file: FILE_INTEL, args: ['--foreground'], plan: 'warn_harmless' });
  });

  it('row 6: a recorded failure that matches the launcher, the builder and the manifest is not retried', () => {
    runCase({ name: 'failure recorded for exactly this state', marker: 'failed-current', plan: 'warn_harmless' });
    runCase({ name: 'a changed launcher is a new situation', marker: 'failed-old-launcher', plan: 'migrate' });
    runCase({ name: 'a changed builder is a new situation', marker: 'failed-old-builder', plan: 'migrate' });
    runCase({ name: 'a changed manifest is a new situation', marker: 'failed-old-manifest', plan: 'migrate' });
    runCase({ name: 'a recorded success does not block', marker: 'ok', plan: 'migrate' });
  });

  it('row 7: an older launcher of any kind, or the script fallback, is upgraded when a native launcher can be had', () => {
    runCase({ name: 'older compiled arm64, prebuilt usable', plan: 'migrate' });
    runCase({ name: 'older compiled Intel-only, prebuilt usable (the earlier rebuild rule, now without a compiler)', file: FILE_INTEL, plan: 'migrate' });
    runCase({ name: 'older script, prebuilt usable', exe: 'legacy-script', file: FILE_SCRIPT, plan: 'migrate' });
    runCase({ name: 'older compiled, no prebuilt, a toolchain exists', prebuilt: 'missing', plan: 'migrate' });
    runCase({ name: 'macOS below the prebuilt floor, a toolchain exists', prebuilt: 'os-too-old', plan: 'migrate' });
    runCase({ name: 'embedding the physical path of this folder', exe: 'legacy-physical', plan: 'migrate' });
    runCase({ name: 'its embedded folder is gone: claimable', exe: 'legacy-other-gone', plan: 'migrate' });
  });

  it('row 7, version bump and an interrupted swap: anything below the wanted version, or with a path still inside, is older', () => {
    runCase({ name: 'a generic executable under a version 1 Info.plist', exe: 'generic', version: 1, recorded: 'this', file: FILE_FAT, plan: 'migrate' });
    runCase({ name: 'a new Info.plist beside an old executable (an interrupted swap)', exe: 'legacy', version: 2, plan: 'migrate' });
    runCase({ name: 'the generic script launcher becomes native when it can', exe: 'generic-script', version: 2, recorded: 'this', file: FILE_SCRIPT, plan: 'migrate' });
    runCase({ name: 'the generic script launcher stays when nothing native can be had', exe: 'generic-script', version: 2, recorded: 'this', file: FILE_SCRIPT, prebuilt: 'missing', toolchain: false, priority: 'arm64-first', plan: 'none' });
  });

  it('row 8: when no native launcher can be had, the earlier rules decide', () => {
    runCase({ name: 'Intel-only compiled launcher', file: FILE_INTEL, prebuilt: 'missing', toolchain: false, plan: 'warn_harmless' });
    runCase({ name: 'Intel-only compiled launcher, os too old and no tools', file: FILE_INTEL, prebuilt: 'os-too-old', toolchain: false, plan: 'warn_harmless' });
    runCase({ name: 'arm64 launcher with the key already right', prebuilt: 'missing', toolchain: false, plan: 'none' });
    runCase({ name: 'script launcher with the key missing', exe: 'legacy-script', file: FILE_SCRIPT, priority: 'none', prebuilt: 'missing', toolchain: false, plan: 'patch_plist' });
    runCase({ name: 'compiled launcher with an arm64 slice and the key missing', file: FILE_FAT, priority: 'x86-first', prebuilt: 'missing', toolchain: false, plan: 'patch_plist' });
  });

  it('Intel Macs read nothing from the executable (kind=unread, no `file` call) and still follow the table', () => {
    const generic = runCase({ name: 'Intel, generic launcher of this folder', hw: 'intel', exe: 'generic', version: 2, recorded: 'this', plan: 'none' });
    expect(generic.fileCallCount()).toBe(0);
    const facts = generic.planOf({ BOTBOY_TEST_HW_ARM64: '0' }).facts;
    expect(facts).toContain('kind=unread archs= priority= version=2');
    const older = runCase({ name: 'Intel, older launcher, prebuilt usable', hw: 'intel', plan: 'migrate' });
    expect(older.fileCallCount()).toBe(0);
    runCase({ name: 'Intel, older launcher, nothing native to be had: left alone', hw: 'intel', prebuilt: 'missing', toolchain: false, plan: 'none' });
    runCase({ name: 'Intel, generic launcher and nothing recorded: claimed', hw: 'intel', exe: 'generic', version: 2, recorded: 'none', plan: 'none', claim: true });
    // A generic bundle is final on Intel: the script/native question is never asked there.
    runCase({ name: 'Intel, generic script launcher stays', hw: 'intel', exe: 'generic-script', version: 2, recorded: 'this', plan: 'none' });
  });

  it('without Node facts nothing about an existing bundle can be judged, so it is left alone', () => {
    const b = box({ facts: false });
    b.makeBundle({ file: FILE_ARM, priority: 'none', exe: 'legacy' });
    const got = b.planOf();
    expect(got).toMatchObject({ plan: 'none', claim: false });
    expect(got.facts).toContain('facts_ok=0');
    // A module that cannot run is the same: no verdict, no change.
    const broken = box();
    broken.makeBundle({ file: FILE_ARM, priority: 'none', exe: 'legacy' });
    fs.writeFileSync(path.join(broken.dir, 'scripts', 'native-prebuilt.mjs'), 'throw new Error("damaged");\n');
    expect(broken.planOf()).toMatchObject({ plan: 'none', claim: false });
  });

  it('asks for the execution smoke only when the plan could reach "migrate"', () => {
    // A generic launcher of this folder never needs the smoke: the facts stay "unchecked".
    const generic = box();
    generic.makeBundle({ file: FILE_FAT, priority: 'arm64-first', exe: 'generic', version: 2, recorded: 'this' });
    expect(generic.planOf().facts).toContain('prebuilt=unchecked');
    // An older launcher of this folder asks, and learns the prebuilt runs here.
    const older = box();
    older.makeBundle({ file: FILE_ARM, priority: 'arm64-first', exe: 'legacy' });
    expect(older.planOf().facts).toContain('prebuilt=1');
    // A prebuilt that macOS will not run here is learned as 0 and the plan falls through to the toolchain.
    const broken = box();
    fs.rmSync(path.join(broken.dir, 'native'), { recursive: true });
    writeLauncherArtifacts(broken.dir, { kind: 'self-kill' });
    broken.makeBundle({ file: FILE_ARM, priority: 'arm64-first', exe: 'legacy' });
    const withTools = broken.planOf();
    expect(withTools.plan).toBe('migrate');
    expect(withTools.facts).toContain('prebuilt=0 toolchain=1');
    const noTools = broken.planOf({ BOTBOY_TEST_XCODE_SELECT_BIN: broken.xcodeSelectNo });
    expect(noTools.plan).toBe('none');
    expect(noTools.facts).toContain('prebuilt=0 toolchain=0');
  });
});

describe('patch_app_plist_arch (scratch plist, real PlistBuddy)', () => {
  const patch = (b: ReturnType<typeof box>, extra: Record<string, string> = {}) => {
    const result = b.run('BOTBOY_TEST_APP_PLIST_PATCH', extra);
    expect(result.status, result.stderr).toBe(0);
    return /patch_status=(\d+) changed=(\d)/.exec(result.stdout)!.slice(1).map(Number);
  };

  it('adds [arm64, x86_64] once, registers the app, and leaves no temporary file', () => {
    const b = box();
    b.makeBundle({ file: FILE_SCRIPT, priority: 'none', exe: 'legacy-script' });
    expect(patch(b)).toEqual([0, 1]);
    expect(b.priorityOf()).toEqual(['arm64', 'x86_64']);
    expect(fs.existsSync(`${b.plistPath}.botboy-new`)).toBe(false);
    expect(b.lsregisterCalls()).toEqual([`-f ${b.bundle}`]);
    expect(spawnSync('/usr/bin/plutil', ['-lint', b.plistPath]).status).toBe(0);
  });
  it('is idempotent: a second run changes nothing and never grows the array', () => {
    const b = box();
    b.makeBundle({ file: FILE_SCRIPT, priority: 'none', exe: 'legacy-script' });
    patch(b);
    const once = fs.readFileSync(b.plistPath);
    expect(patch(b)).toEqual([0, 0]);
    expect(patch(b)).toEqual([0, 0]);
    expect(fs.readFileSync(b.plistPath).equals(once)).toBe(true);
    expect(b.priorityOf()).toEqual(['arm64', 'x86_64']);
    expect(b.lsregisterCalls()).toHaveLength(1);
  });
  it('repairs an x86_64-first order and trims stray entries to exactly two', () => {
    for (const priority of ['x86-first', 'extra'] as const) {
      const b = box();
      b.makeBundle({ file: FILE_SCRIPT, priority, exe: 'legacy-script' });
      expect(patch(b)).toEqual([0, 1]);
      expect(b.priorityOf()).toEqual(['arm64', 'x86_64']);
    }
  });
  it('trusts the re-read, not PlistBuddy exit codes', () => {
    const b = box();
    b.makeBundle({ file: FILE_SCRIPT, priority: 'none', exe: 'legacy-script' });
    // Does the work, then reports failure.
    const noisy = b.stub('buddy-noisy', `${PLISTBUDDY} "$@"\ncase "$*" in *Add*) exit 1;; esac`);
    expect(patch(b, { BOTBOY_TEST_PLISTBUDDY_BIN: noisy })).toEqual([0, 1]);
    expect(b.priorityOf()).toEqual(['arm64', 'x86_64']);
    // Reports success, changes nothing: the original stays and nothing is left behind.
    const b2 = box();
    b2.makeBundle({ file: FILE_SCRIPT, priority: 'none', exe: 'legacy-script' });
    const before = fs.readFileSync(b2.plistPath);
    const liar = b2.stub('buddy-liar', 'exit 0');
    expect(patch(b2, { BOTBOY_TEST_PLISTBUDDY_BIN: liar })).toEqual([1, 0]);
    expect(fs.readFileSync(b2.plistPath).equals(before)).toBe(true);
    expect(fs.existsSync(`${b2.plistPath}.botboy-new`)).toBe(false);
    expect(b2.lsregisterCalls()).toEqual([]);
  });
  it('leaves the original intact and removes its temporary copy when it cannot write', () => {
    const b = box();
    b.makeBundle({ file: FILE_SCRIPT, priority: 'none', exe: 'legacy-script' });
    const before = fs.readFileSync(b.plistPath);
    const contents = path.dirname(b.plistPath);
    fs.chmodSync(contents, 0o555);
    try {
      expect(patch(b)).toEqual([1, 0]);
    } finally {
      fs.chmodSync(contents, 0o755);
    }
    expect(fs.readFileSync(b.plistPath).equals(before)).toBe(true);
    expect(fs.readdirSync(contents).filter((name) => name.includes('botboy-new'))).toEqual([]);
  });
  it('fails quietly when the bundle has no Info.plist', () => {
    const b = box();
    expect(patch(b)).toEqual([1, 0]);
  });
});

describe('install_app_bundle_if_missing (apply, with a stand-in builder)', () => {
  /** A stand-in for scripts/make-app-bundle.mjs that records how it was called and prints what the real one would. */
  const builder = (b: ReturnType<typeof box>, exitCode: number, output = '', comment = '') => {
    const calls = path.join(b.root, 'builder-calls');
    fs.writeFileSync(
      path.join(b.dir, 'scripts', 'make-app-bundle.mjs'),
      `${comment}\nimport fs from 'node:fs';\nfs.appendFileSync(${JSON.stringify(calls)}, process.argv.slice(2).join(' ') + '\\n');\nconsole.log(${JSON.stringify(output)});\nprocess.exit(${exitCode});\n`,
    );
    return () => (fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').trim().split('\n') : []);
  };
  const apply = (b: ReturnType<typeof box>, args: string[] = [], extra: Record<string, string> = {}) => {
    const result = b.run('BOTBOY_TEST_APP_LAUNCHER_APPLY', extra, args);
    expect(result.status, result.stderr).toBe(0);
    return result.stdout;
  };
  const markerText = (b: ReturnType<typeof box>) => fs.readFileSync(b.markerFile, 'utf8');

  it('creates a missing bundle through the builder', () => {
    const b = box();
    const calls = builder(b, 0);
    const out = apply(b);
    expect(calls()).toEqual([`--dest ${b.bundle}`]);
    expect(out).toContain('BotBoy.app installed');
  });
  it('never swaps a launcher in --foreground, and says calmly what stays', () => {
    const b = box();
    b.makeBundle({ file: FILE_INTEL, priority: 'arm64-first' });
    const calls = builder(b, 0);
    const out = apply(b, ['--foreground']);
    expect(calls()).toEqual([]);
    expect(out).toContain('harmless, because start.sh re-launches BotBoy natively');
  });
  it('upgrades an older launcher once, patches the plist, and records success with all three signatures', () => {
    const b = box();
    b.makeBundle({ file: FILE_ARM, priority: 'none' });
    const calls = builder(b, 0);
    const out = apply(b);
    expect(calls()).toEqual([`--launcher-only --dest ${b.bundle}`]);
    expect(out).toContain('Upgrading BotBoy.app\'s launcher so it follows this folder (prebuilt, no developer tools needed)');
    expect(out).toContain('BotBoy.app upgraded; this takes effect at the next app launch: quit and reopen BotBoy');
    const marker = markerText(b);
    expect(marker).toMatch(/^result=ok$/m);
    expect(marker).toMatch(/^launcher=\d+:\d+$/m);
    expect(marker).toMatch(/^builder=\d+:\d+$/m);
    expect(marker).toMatch(/^manifest=\d+:\d+$/m);
    expect(marker).toMatch(/^date=\d{4}-\d{2}-\d{2}T/m);
    expect(b.priorityOf()).toEqual(['arm64', 'x86_64']);
  });
  it('says it builds the launcher on this Mac when no prebuilt one runs here', () => {
    const b = box({ prebuilt: 'missing' });
    b.makeBundle({ file: FILE_ARM, priority: 'arm64-first' });
    builder(b, 0);
    expect(apply(b)).toContain('(building it on this Mac)');
  });
  it('a failed upgrade names the reason and the next step, records it, and is not retried until the launcher, the builder or the manifest changes', () => {
    const b = box();
    b.makeBundle({ file: FILE_ARM, priority: 'arm64-first' });
    const calls = builder(b, 1, 'Launcher not upgraded (arm64: killed by macOS); the existing launcher is untouched.\nreason=launcher_smoke_failed\ndetail=arm64: killed by macOS');
    const first = apply(b);
    expect(calls()).toHaveLength(1);
    expect(first).toContain('could not be upgraded (macOS would not run the new launcher on this Mac); the current one keeps working. Next: ./start.sh --doctor');
    expect(markerText(b)).toMatch(/^result=failed$/m);
    expect(markerText(b)).toMatch(/^reason=launcher_smoke_failed$/m);
    // Same launcher, same builder, same manifest: no second attempt, and the plan says why.
    const second = apply(b);
    expect(calls()).toHaveLength(1);
    expect(second).toContain('the last upgrade did not work here (macOS would not run the new launcher on this Mac)');
    expect(b.planOf().plan).toBe('warn_harmless');
    // A changed launcher, builder or manifest is a new situation.
    const original = fs.readFileSync(b.exePath);
    fs.writeFileSync(b.exePath, Buffer.concat([original, Buffer.from('\u0000more')]));
    expect(b.planOf().plan).toBe('migrate');
    fs.writeFileSync(b.exePath, original);
    builder(b, 1, 'reason=launcher_smoke_failed', '// a newer builder');
    expect(b.planOf().plan).toBe('migrate');
    builder(b, 1, 'reason=launcher_smoke_failed');
    b.writeMarker('failed-current');
    expect(b.planOf().plan).toBe('warn_harmless');
    fs.appendFileSync(path.join(b.dir, 'native', 'prebuilt-manifest.json'), ' ');
    expect(b.planOf().plan).toBe('migrate');
  });
  it('words every reason code the builder can print, and shows an unknown one as it is', () => {
    const cases: Array<[string, string]> = [
      ['os_too_old', 'older than the prebuilt launcher needs (macOS 13)'],
      ['launcher_corrupt', 'missing or damaged; run ./start.sh --update'],
      ['no_toolchain', 'no prebuilt launcher runs here and there are no developer tools to build one'],
      ['app_not_writable', 'macOS did not allow changes inside'],
      ['readback_failed', 'the previous one was put back'],
      ['checkout_file_failed', 'BotBoy could not write to ~/.personal-productivity-tracker'],
      ['something_new', 'something_new'],
    ];
    for (const [reason, words] of cases) {
      const b = box();
      b.makeBundle({ file: FILE_ARM, priority: 'arm64-first' });
      builder(b, 1, `reason=${reason}`);
      expect(apply(b), reason).toContain(words);
    }
  });
  it('a script launcher whose key is missing is patched without running the builder when nothing native can be had', () => {
    const b = box({ prebuilt: 'missing' });
    b.makeBundle({ file: FILE_SCRIPT, priority: 'none', exe: 'legacy-script' });
    const calls = builder(b, 0);
    const out = apply(b, [], { BOTBOY_TEST_XCODE_SELECT_BIN: b.xcodeSelectNo });
    expect(calls()).toEqual([]);
    expect(out).toContain('takes effect at the next app launch: quit and reopen BotBoy');
    expect(b.priorityOf()).toEqual(['arm64', 'x86_64']);
  });
  it('writes the recorded folder when it is empty or gone (a moved folder is followed), even in --foreground, and never over a live one', () => {
    const recorded = (b: ReturnType<typeof box>) => fs.readFileSync(path.join(b.home, '.personal-productivity-tracker', 'app-checkout.v1'), 'utf8');
    const gone = box();
    gone.makeBundle({ file: FILE_FAT, priority: 'arm64-first', exe: 'generic', version: 2, recorded: 'other-gone' });
    const goneCalls = builder(gone, 0);
    const out = apply(gone, ['--foreground']);
    expect(goneCalls()).toEqual([]);
    expect(out).toContain('BotBoy.app now opens this folder');
    expect(recorded(gone).split('\n')[0]).toBe(`checkout=${gone.physicalDir}`);
    expect(fs.statSync(path.join(gone.home, '.personal-productivity-tracker', 'app-checkout.v1')).mode & 0o777).toBe(0o600);
    expect(gone.planOf().claim).toBe(false);
    const empty = box();
    empty.makeBundle({ file: FILE_FAT, priority: 'arm64-first', exe: 'generic', version: 2, recorded: 'none' });
    builder(empty, 0);
    apply(empty);
    expect(recorded(empty).split('\n')[0]).toBe(`checkout=${empty.physicalDir}`);
    // Another folder that still exists keeps the app, and the file is not touched.
    const live = box();
    live.makeBundle({ file: FILE_FAT, priority: 'arm64-first', exe: 'generic', version: 2, recorded: 'other-live' });
    builder(live, 0);
    const before = recorded(live);
    expect(apply(live)).not.toContain('now opens this folder');
    expect(recorded(live)).toBe(before);
  });
  it('a recorded folder it cannot write is reported, and nothing else changes', () => {
    const b = box();
    b.makeBundle({ file: FILE_FAT, priority: 'arm64-first', exe: 'generic', version: 2, recorded: 'other-gone' });
    builder(b, 0);
    const dataDir = path.join(b.home, '.personal-productivity-tracker');
    fs.chmodSync(dataDir, 0o555);
    try {
      const out = apply(b);
      expect(out).toContain('Could not record this folder for BotBoy.app');
      expect(fs.readdirSync(dataDir).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    } finally {
      fs.chmodSync(dataDir, 0o755);
    }
    expect(fs.readFileSync(path.join(dataDir, 'app-checkout.v1'), 'utf8')).toContain('/no/such/folder');
  });
});

describe('doctor_app_launcher_row (exact words)', () => {
  const row = (b: ReturnType<typeof box>, extra: Record<string, string> = {}) => {
    const result = b.run('BOTBOY_TEST_DOCTOR_APP', extra, ['--doctor']);
    expect(result.status, result.stderr).toBe(0);
    return result.stdout.trim();
  };
  const arm = 'architecture priority: arm64 first';

  it('a bundle that is not there, and a bundle that cannot be judged', () => {
    const b = box();
    expect(row(b)).toBe('app launcher: not installed (./start.sh installs it on its first successful start)');
    const noFacts = box({ facts: false });
    noFacts.makeBundle({ file: FILE_ARM, priority: 'arm64-first' });
    expect(row(noFacts)).toBe('app launcher: unknown (the check could not run; run ./start.sh --update)');
    const unknown = box();
    unknown.makeBundle({ file: 'data', priority: 'arm64-first' });
    expect(row(unknown)).toBe(`app launcher: unknown; ${arm}`);
  });
  it('the prebuilt launcher: its version, the folder it opens, the architecture key, and that it was run', () => {
    const b = box();
    b.makeBundle({ file: FILE_FAT, priority: 'arm64-first', exe: 'generic', version: 2, recorded: 'this' });
    expect(row(b)).toBe(`app launcher: prebuilt universal (v2); opens ${b.physicalDir}; ${arm}; smoke ok`);
  });
  it('a prebuilt launcher that macOS will not run here says so, and what to do', () => {
    const b = box();
    fs.rmSync(path.join(b.dir, 'native'), { recursive: true });
    writeLauncherArtifacts(b.dir, { kind: 'self-kill' });
    b.makeBundle({ file: FILE_FAT, priority: 'arm64-first', exe: 'none', version: 2, recorded: 'this' });
    fs.writeFileSync(b.exePath, launcherBody('self-kill'), { mode: 0o755 });
    expect(row(b)).toBe(`app launcher: prebuilt universal (v2); opens ${b.physicalDir}; ${arm}; smoke FAILED (killed by macOS): run ./start.sh --update, or remove ${b.bundle} and run ./start.sh`);
  });
  it('a launcher compiled on this Mac, and the shell script one', () => {
    const compiled = box();
    compiled.makeBundle({ file: FILE_FAT, priority: 'arm64-first', exe: 'generic', version: 2, recorded: 'this' });
    fs.appendFileSync(compiled.exePath, '# not the prebuilt bytes\n');
    expect(row(compiled)).toBe(`app launcher: compiled on this Mac (v2, universal); opens ${compiled.physicalDir}; ${arm}`);
    const script = box();
    script.makeBundle({ file: FILE_SCRIPT, priority: 'arm64-first', exe: 'generic-script', version: 2, recorded: 'this' });
    expect(row(script)).toBe(`app launcher: shell script (v2); opens ${script.physicalDir}; ${arm}`);
  });
  it('an older launcher: which kind, and that the next ./start.sh upgrades it', () => {
    const compiled = box();
    compiled.makeBundle({ file: FILE_ARM, priority: 'arm64-first' });
    expect(row(compiled)).toBe(`app launcher: older compiled launcher (arm64); upgrades at the next ./start.sh; ${arm}`);
    const intel = box();
    intel.makeBundle({ file: FILE_INTEL, priority: 'arm64-first' });
    expect(row(intel)).toBe(`app launcher: older compiled launcher (x86_64 only); upgrades at the next ./start.sh; ${arm}`);
    const script = box();
    script.makeBundle({ file: FILE_SCRIPT, priority: 'arm64-first', exe: 'legacy-script' });
    expect(row(script)).toBe(`app launcher: older script launcher; upgrades at the next ./start.sh; ${arm}`);
  });
  it('says what a missing priority means for a script or an Intel-only launcher', () => {
    const b = box();
    b.makeBundle({ file: FILE_SCRIPT, priority: 'none', exe: 'legacy-script' });
    expect(row(b)).toContain('architecture priority: missing (the app itself starts translated');
    expect(row(b)).toContain('start.sh adds the key on its next start');
    const compiled = box();
    compiled.makeBundle({ file: FILE_ARM, priority: 'none' });
    expect(row(compiled)).toContain('missing (harmless for a compiled launcher with an arm64 slice');
  });
  it('which folder the app opens: another live one, a gone one, none yet', () => {
    const other = box();
    other.makeBundle({ file: FILE_FAT, priority: 'arm64-first', exe: 'generic', version: 2, recorded: 'other-live' });
    expect(row(other)).toBe(`app launcher: prebuilt universal (v2); opens another folder (${other.otherLive}): run ./start.sh there, or remove ${other.bundle} and run ./start.sh here; ${arm}; smoke ok`);
    const gone = box();
    gone.makeBundle({ file: FILE_FAT, priority: 'arm64-first', exe: 'generic', version: 2, recorded: 'other-gone' });
    expect(row(gone)).toBe(`app launcher: prebuilt universal (v2); its folder is gone (/no/such/folder): run ./start.sh here to reconnect it; ${arm}; smoke ok`);
    const none = box();
    none.makeBundle({ file: FILE_FAT, priority: 'arm64-first', exe: 'generic', version: 2, recorded: 'none' });
    expect(row(none)).toBe(`app launcher: prebuilt universal (v2); no folder is recorded yet (run ./start.sh in the BotBoy folder to record it); ${arm}; smoke ok`);
  });
  it('an older launcher of another checkout, and one whose upgrade failed here', () => {
    const other = box();
    other.makeBundle({ file: FILE_ARM, priority: 'arm64-first', exe: 'legacy-other-live' });
    expect(row(other)).toBe(`app launcher: older compiled launcher (arm64); belongs to another folder (${path.join(other.otherLive, 'start.sh')}); ${arm}`);
    const failed = box();
    failed.makeBundle({ file: FILE_ARM, priority: 'arm64-first' });
    failed.writeMarker('failed-current', 'launcher_smoke_failed');
    expect(row(failed)).toBe(`app launcher: older compiled launcher (arm64); the last upgrade did not work here (macOS would not run the new launcher on this Mac); it keeps working; ${arm}`);
  });
  it('an Intel Mac has no architecture part, reads nothing from the executable, and still says the rest', () => {
    const b = box();
    b.makeBundle({ file: FILE_INTEL, priority: 'none', exe: 'generic', version: 2, recorded: 'this' });
    expect(row(b, { BOTBOY_TEST_HW_ARM64: '0' })).toBe(`app launcher: prebuilt universal (v2); opens ${b.physicalDir}; smoke ok`);
    expect(b.fileCallCount()).toBe(0);
    const older = box();
    older.makeBundle({ file: FILE_INTEL, priority: 'none' });
    expect(row(older, { BOTBOY_TEST_HW_ARM64: '0' })).toBe('app launcher: older launcher; upgrades at the next ./start.sh');
  });
  it('is read-only: the doctor never writes the recorded folder or the bundle', () => {
    const b = box();
    b.makeBundle({ file: FILE_FAT, priority: 'none', exe: 'generic', version: 2, recorded: 'other-gone' });
    const before = [fs.readFileSync(b.plistPath), fs.readFileSync(b.exePath), fs.readFileSync(path.join(b.home, '.personal-productivity-tracker', 'app-checkout.v1'))];
    row(b);
    expect([fs.readFileSync(b.plistPath), fs.readFileSync(b.exePath), fs.readFileSync(path.join(b.home, '.personal-productivity-tracker', 'app-checkout.v1'))].map((x) => x.toString('hex')))
      .toEqual(before.map((x) => x.toString('hex')));
  });
});
