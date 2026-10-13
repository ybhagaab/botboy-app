/**
 * The prebuilt BotBoy.app launcher and the tier choice of scripts/make-app-bundle.mjs
 * (scope B of the prebuilt-native-helpers task, review finding 1: a launcher is RUN
 * before it replaces a working one).
 *
 * The fixture "launcher" is a tiny program that speaks the print-target protocol
 * (BOTBOY_APP_PRINT_TARGET=1 prints `target=<start.sh>` and exits); the misbehaving
 * ones are what a real launcher could do on a Mac nobody here has: an unsupported CPU,
 * killed by macOS, the wrong folder, no answer. Nothing here starts a real launcher
 * through LaunchServices, `open`, or from inside an application bundle: temporary
 * bundles are NOT named *.app, osascript/open/lsregister are recording stubs, and HOME
 * is private (test-hygiene.test.ts holds the rules). The one real launcher run is the
 * committed prebuilt file, run from the repository in its print-target mode.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FILE_ARM, FILE_SCRIPT, LAUNCHER_SOURCE, bundlePlist, launcherBody, legacyCompiledBytes, legacyScriptText, sha256, stubArch, stubUiTools, writeLauncherArtifacts,
  type ArtifactOptions, type LauncherKind,
} from './launcher-fixtures.testutil';

vi.setConfig({ testTimeout: 120_000 });

const packageRoot = fs.realpathSync(fileURLToPath(new URL('../../', import.meta.url)));
const builderPath = path.join(packageRoot, 'scripts', 'make-app-bundle.mjs');
const nativeUrl = pathToFileURL(path.join(packageRoot, 'scripts', 'native-prebuilt.mjs')).href;
const distribution = fs.existsSync(path.join(packageRoot, '.botboy-distribution'));
const onMac = describe.runIf(process.platform === 'darwin');
const PLISTBUDDY = '/usr/libexec/PlistBuddy';

const roots: string[] = [];
let ui = null as unknown as ReturnType<typeof stubUiTools>;
const tmp = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'botboy-launcher-test-'));
  roots.push(dir);
  return dir;
};
beforeEach(() => {
  ui = stubUiTools(tmp());
});
afterEach(() => {
  expect(ui.calls(), 'a test reached osascript, open or lsregister').toEqual([]);
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

type Native = {
  smokeLauncher: (file: string, options: { startScript: string; archPrefix?: string | null; timeoutMs?: number }) => { ok: boolean; detail: string };
  smokeLauncherEverywhere: (file: string, options: { startScript: string }) => { ok: boolean; detail: string };
  launcherPrebuiltUsable: (options: Record<string, unknown>) => { ok: boolean; reason: string; detail: string; checked: string; file: string | null };
  launcherFacts: (options: Record<string, unknown>) => Record<string, string | number>;
  findBakedStartScript: (file: string) => string;
  readCheckoutFile: (options: { home: string }) => { checkout: string } | null;
  writeCheckoutFile: (folder: string, options: { home: string }) => { ok: boolean; checkout?: string; error?: string };
  checkoutFilePath: (home: string) => string;
  codesignVerifies: (file: string) => boolean;
  LAUNCHER_VERSION: number;
  main: (argv: string[]) => number;
};
const loadNative = () => import(/* @vite-ignore */ nativeUrl) as Promise<Native>;

type Scenario = {
  artifacts?: ArtifactOptions;
  /** What `file -b` answers for the launcher already in the bundle. */
  existing?: 'native' | 'script' | 'none';
  /** A Swift toolchain: none (xcode-select fails), or one whose compiler writes a launcher of this kind. */
  toolchain?: 'none' | 'builds' | 'fails';
  compiledKind?: LauncherKind;
  hw?: 'arm64' | 'intel';
  macos?: string;
  codesign?: 'ok' | 'fails';
  /** xattr: the download flag on candidates. */
  flag?: 'none' | 'stuck';
};

function scenario(s: Scenario = {}) {
  const root = tmp();
  const nativeRoot = path.join(root, 'native-root');
  const home = path.join(root, 'home');
  const stubs = path.join(root, 'stubs');
  const dest = path.join(root, 'bundle-under-test'); // not *.app: nothing in a test may look like an application bundle
  for (const dir of [nativeRoot, home, stubs]) fs.mkdirSync(dir, { recursive: true });
  const artifacts = writeLauncherArtifacts(nativeRoot, s.artifacts ?? {});
  const stub = (name: string, body: string) => {
    const file = path.join(stubs, name);
    fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    return file;
  };
  const calls = path.join(root, 'tool-calls');
  const toolchain = s.toolchain ?? 'none';
  const xcodeSelect = stub('xcode-select', `echo "xcode-select $*" >> '${calls}'\n${toolchain === 'none' ? 'exit 2' : 'echo /stub/clt'}`);
  const compiled = launcherBody(s.compiledKind ?? 'ok');
  const compiledFile = path.join(root, 'compiled-body');
  fs.writeFileSync(compiledFile, compiled);
  const swiftc = stub('swiftc', toolchain === 'fails'
    ? `echo "swiftc $*" >> '${calls}'\necho "error: compile failed" >&2\nexit 1`
    : `echo "swiftc $*" >> '${calls}'\nout=""; prev=""; for a in "$@"; do [ "$prev" = "-o" ] && out="$a"; prev="$a"; done\ncp '${compiledFile}' "$out"\nchmod 755 "$out"`);
  const xcrun = stub('xcrun', `echo "xcrun $*" >> '${calls}'\ncase "$1" in --show-sdk-path) echo /stub/sdk;; --find) case "$2" in swiftc) echo '${swiftc}';; *) echo "/stub/$2";; esac;; esac`);
  const answer = path.join(root, 'file-answer');
  const existing = s.existing ?? 'none';
  fs.writeFileSync(answer, `${existing === 'script' ? FILE_SCRIPT : FILE_ARM}\n`);
  const file = stub('file', `cat '${answer}'`);
  const swVers = stub('sw_vers', `echo ${s.macos ?? '14.5'}`);
  const codesign = stub('codesign', `exit ${(s.codesign ?? 'ok') === 'ok' ? 0 : 1}`);
  const xattr = (s.flag ?? 'none') === 'stuck'
    ? stub('xattr', 'case "$1" in -p) echo "0081;5f5e1000;Chrome;"; exit 0;; -d) exit 1;; esac\nexit 0')
    : ui.env.BOTBOY_TEST_XATTR_BIN;
  const lsregister = stub('lsregister', `echo "$@" >> '${path.join(root, 'lsregister-calls')}'`);
  const contents = path.join(dest, 'Contents');
  const exePath = path.join(contents, 'MacOS', 'BotBoy');
  const plistPath = path.join(contents, 'Info.plist');
  const dataDir = path.join(home, '.personal-productivity-tracker');
  const env = (extra: Record<string, string> = {}) => ({
    ...process.env,
    ...ui.env,
    HOME: home,
    BOTBOY_TEST_NATIVE_ROOT: nativeRoot,
    BOTBOY_TEST_HW_ARM64: (s.hw ?? 'arm64') === 'arm64' ? '1' : '0',
    BOTBOY_TEST_XCODE_SELECT_BIN: xcodeSelect,
    BOTBOY_TEST_XCRUN_BIN: xcrun,
    BOTBOY_TEST_FILE_BIN: file,
    BOTBOY_TEST_SW_VERS_BIN: swVers,
    BOTBOY_TEST_CODESIGN_BIN: codesign,
    BOTBOY_TEST_XATTR_BIN: xattr,
    BOTBOY_TEST_LSREGISTER_BIN: lsregister,
    ...extra,
  }) as Record<string, string>;
  const run = (args: string[] = ['--launcher-only', '--no-register'], extra: Record<string, string> = {}) =>
    spawnSync(process.execPath, [builderPath, '--dest', dest, '--bundle-id', 'com.botboy.scratch', ...args], { env: env(extra), encoding: 'utf8', timeout: 120_000 });
  /** A bundle with a working older launcher. */
  const legacyBundle = (kind: 'compiled' | 'script' = 'compiled') => {
    fs.mkdirSync(path.dirname(exePath), { recursive: true });
    const startSh = path.join(packageRoot, 'start.sh');
    fs.writeFileSync(exePath, kind === 'compiled' ? legacyCompiledBytes(startSh) : legacyScriptText(startSh), { mode: 0o755 });
    fs.writeFileSync(plistPath, bundlePlist({ version: null, priority: 'arm64-first' }));
  };
  const snapshot = () => ({
    exe: fs.existsSync(exePath) ? sha256(fs.readFileSync(exePath)) : null,
    plist: fs.existsSync(plistPath) ? sha256(fs.readFileSync(plistPath)) : null,
  });
  const staged = () => [path.join(contents, 'MacOS'), contents].flatMap((dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((name) => /botboy-(new|restore)/.test(name)) : []));
  const toolCalls = () => (fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').split('\n').filter(Boolean) : []);
  const plistValue = (key: string) => spawnSync(PLISTBUDDY, ['-c', `Print :${key}`, plistPath], { encoding: 'utf8' }).stdout.trim();
  return { root, nativeRoot, home, dest, exePath, plistPath, dataDir, artifacts, run, env, legacyBundle, snapshot, staged, toolCalls, plistValue, lsregisterCalls: path.join(root, 'lsregister-calls') };
}

const reasonOf = (stdout: string) => /^reason=(\w+)$/m.exec(stdout)?.[1];

onMac('tier 1: the prebuilt launcher', () => {
  it('is installed byte for byte, with no developer tools touched, the folder recorded, and the marker keys written', () => {
    const x = scenario({ toolchain: 'none' });
    x.legacyBundle('compiled');
    const result = x.run();
    expect(result.status, result.stderr + result.stdout).toBe(0);
    expect(sha256(fs.readFileSync(x.exePath))).toBe(sha256(x.artifacts.body));
    expect(x.plistValue('BotBoyLauncherVersion')).toBe('2');
    expect(x.plistValue('LSMinimumSystemVersion')).toBe('13.0');
    expect(x.plistValue('LSArchitecturePriority:0')).toBe('arm64');
    expect(x.plistValue('CFBundleIdentifier')).toBe('com.botboy.scratch');
    expect(fs.statSync(x.exePath).mode & 0o777).toBe(0o755);
    // Tripwire: the prebuilt tier never asks about a toolchain, never runs xcrun or a compiler.
    expect(x.toolCalls()).toEqual([]);
    expect(x.staged()).toEqual([]);
    expect(result.stdout).toContain('prebuilt universal launcher (no developer tools needed)');
    const record = fs.readFileSync(path.join(x.dataDir, 'app-checkout.v1'), 'utf8').split('\n');
    expect(record[0]).toBe(`checkout=${packageRoot}`);
    expect(fs.statSync(path.join(x.dataDir, 'app-checkout.v1')).mode & 0o777).toBe(0o600);
  });

  it('keeps the launcher and Info.plist it replaced (latest only) so a failed upgrade can be undone by hand', () => {
    const x = scenario();
    x.legacyBundle('compiled');
    const before = x.snapshot();
    expect(x.run().status).toBe(0);
    const backup = path.join(x.dataDir, 'app-launcher-backup');
    expect(sha256(fs.readFileSync(path.join(backup, 'BotBoy')))).toBe(before.exe);
    expect(sha256(fs.readFileSync(path.join(backup, 'Info.plist')))).toBe(before.plist);
    expect(fs.statSync(backup).mode & 0o777).toBe(0o700);
    // A second upgrade replaces the backup with what was installed then.
    const second = x.snapshot();
    expect(x.run().status).toBe(0);
    expect(sha256(fs.readFileSync(path.join(backup, 'BotBoy')))).toBe(second.exe);
    expect(fs.readdirSync(backup).sort()).toEqual(['BotBoy', 'Info.plist']);
  });

  it('the installer never runs anything from inside the bundle: the candidate is run in a private folder, the installed file is only compared', () => {
    const log = path.join(tmp(), 'runs');
    const body = Buffer.from(`#!/bin/sh\necho "$0" >> '${log}'\n${launcherBody('ok').toString().split('\n').slice(1).join('\n')}`);
    const x = scenario();
    // The manifest describes this recording launcher.
    fs.writeFileSync(x.artifacts.binary, body, { mode: 0o755 });
    const manifest = JSON.parse(fs.readFileSync(x.artifacts.manifest, 'utf8'));
    manifest.artifacts.botboyLauncher.binary = { sha256: sha256(body), bytes: body.length };
    fs.writeFileSync(x.artifacts.manifest, JSON.stringify(manifest, null, 2));
    x.legacyBundle('compiled');
    const result = x.run();
    expect(result.status, result.stderr + result.stdout).toBe(0);
    const ran = fs.readFileSync(log, 'utf8').split('\n').filter(Boolean);
    expect(ran.length).toBeGreaterThanOrEqual(1);
    for (const path_ of ran) {
      expect(path_, 'a launcher was run from inside the bundle').not.toContain('bundle-under-test');
      expect(path_).toContain('candidate-prebuilt');
    }
    expect(sha256(fs.readFileSync(x.exePath))).toBe(sha256(body));
  });
});

onMac('a launcher that cannot run here never replaces a working one (finding 1)', () => {
  const kinds: Array<[LauncherKind, RegExp]> = [
    ['self-kill', /killed by macOS/],
    ['wrong-target', /unexpected output/],
    ['bad-cpu', /cannot start/],
    ['exit-2', /unexpected output/],
    ['ignores-hook', /unexpected output/],
  ];
  for (const [kind, detail] of kinds) {
    it(`refuses a launcher that ${kind}, leaves the working one byte for byte, and names the reason`, () => {
      const x = scenario({ artifacts: { kind }, toolchain: 'none', existing: 'native' });
      x.legacyBundle('compiled');
      const before = x.snapshot();
      const result = x.run();
      expect(result.status).toBe(1);
      expect(reasonOf(result.stdout)).toBe('launcher_smoke_failed');
      expect(result.stdout).toMatch(new RegExp(`^detail=.*${detail.source}`, 'm'));
      expect(result.stderr).toContain('the existing launcher is untouched');
      expect(x.snapshot()).toEqual(before);
      expect(x.staged()).toEqual([]);
      // Nothing was backed up or recorded for an upgrade that did not happen.
      expect(fs.existsSync(path.join(x.dataDir, 'app-launcher-backup'))).toBe(false);
      expect(fs.existsSync(path.join(x.dataDir, 'app-checkout.v1'))).toBe(false);
    });
  }

  it('gives up on a launcher that does not answer in time, without waiting for it', () => {
    const x = scenario({ artifacts: { kind: 'hang' } });
    return loadNative().then((native) => {
      const started = Date.now();
      const outcome = native.smokeLauncher(x.artifacts.binary, { startScript: path.join(packageRoot, 'start.sh'), timeoutMs: 400 });
      expect(outcome).toEqual({ ok: false, detail: 'did not answer in time' });
      expect(Date.now() - started).toBeLessThan(8_000);
    });
  });

  it('runs the launcher only in print-target mode, with stdin closed: a program that reads its input cannot hold the smoke', async () => {
    const native = await loadNative();
    const dir = tmp();
    const reader = path.join(dir, 'reader');
    // Without BOTBOY_APP_PRINT_TARGET it would start the app; it waits on stdin to prove stdin is closed.
    fs.writeFileSync(reader, '#!/bin/sh\n[ "$BOTBOY_APP_PRINT_TARGET" = "1" ] || exit 7\ncat >/dev/null\necho "target=$BOTBOY_APP_START_SCRIPT"\n', { mode: 0o755 });
    const startScript = path.join(packageRoot, 'start.sh');
    expect(native.smokeLauncher(reader, { startScript, timeoutMs: 5_000 })).toEqual({ ok: true, detail: 'ok' });
  });

  it('refuses a signature that does not verify', () => {
    const x = scenario({ codesign: 'fails', existing: 'native' });
    x.legacyBundle('compiled');
    const before = x.snapshot();
    const result = x.run();
    expect(result.status).toBe(1);
    expect(reasonOf(result.stdout)).toBe('launcher_codesign_failed');
    expect(x.snapshot()).toEqual(before);
  });

  it('refuses a launcher macOS has marked as downloaded when the mark cannot be cleared (it would be killed or shown a dialog)', () => {
    const x = scenario({ flag: 'stuck', existing: 'native' });
    x.legacyBundle('compiled');
    const before = x.snapshot();
    const result = x.run();
    expect(result.status).toBe(1);
    expect(reasonOf(result.stdout)).toBe('launcher_quarantined');
    expect(x.snapshot()).toEqual(before);
  });

  const unusable: Array<[string, Scenario, string]> = [
    ['a changed prebuilt file', { artifacts: { corrupt: true } }, 'launcher_corrupt'],
    ['a missing prebuilt file', { artifacts: { withBinary: false } }, 'launcher_missing'],
    ['no manifest', { artifacts: { manifest: 'missing' } }, 'manifest_missing'],
    ['an invalid manifest', { artifacts: { manifest: 'invalid' } }, 'manifest_invalid'],
    ['a manifest for another launcher version', { artifacts: { launcherVersion: 9 } }, 'manifest_invalid'],
    ['macOS below the floor', { macos: '12.7.6' }, 'os_too_old'],
  ];
  for (const [name, setup, reason] of unusable) {
    it(`${name} is ${reason}: the working launcher stays`, () => {
      const x = scenario({ ...setup, existing: 'native', toolchain: 'none' });
      x.legacyBundle('compiled');
      const before = x.snapshot();
      const result = x.run();
      expect(result.status).toBe(1);
      expect(reasonOf(result.stdout)).toBe(reason);
      expect(x.snapshot()).toEqual(before);
      expect(x.staged()).toEqual([]);
    });
  }
});

/**
 * Review 2, finding 1: the smoke runs a launcher natively AND under each architecture the Mac can run
 * (`arch -arm64`, `arch -x86_64`); a failure under either keeps the working launcher. Every fixture behaves
 * the same under `arch`, so the failing branch of that loop was unreachable. `stubArch` is a recording
 * stand-in for /usr/bin/arch (BOTBOY_TEST_ARCH_BIN) under which a launcher passes natively and fails under one
 * architecture, or a Mac has no Rosetta.
 */
onMac('the architecture half of the execution smoke (review 2, finding 1)', () => {
  const withArch = async <T>(stub: { env: Record<string, string> }, body: () => Promise<T> | T): Promise<T> => {
    process.env.BOTBOY_TEST_ARCH_BIN = stub.env.BOTBOY_TEST_ARCH_BIN;
    try {
      return await body();
    } finally {
      delete process.env.BOTBOY_TEST_ARCH_BIN;
    }
  };
  const startScript = path.join(packageRoot, 'start.sh');
  const parseFacts = (stdout: string) => Object.fromEntries(stdout.split('\n').filter(Boolean).map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));

  describe('smokeLauncherEverywhere', () => {
    it('runs the launcher once natively, then under each architecture this Mac can run: probe first, then the launcher itself', async () => {
      const native = await loadNative();
      const x = scenario();
      const arch = stubArch(x.root);
      const outcome = await withArch(arch, () => native.smokeLauncherEverywhere(x.artifacts.binary, { startScript }));
      expect(outcome).toEqual({ ok: true, detail: 'ok' });
      expect(arch.calls()).toEqual([
        'arch -arm64 /usr/bin/true',
        `arch -arm64 ${x.artifacts.binary}`,
        'arch -x86_64 /usr/bin/true',
        `arch -x86_64 ${x.artifacts.binary}`,
      ]);
    });

    const failures: Array<[string, 'exit-1' | 'self-kill' | 'wrong-target', string]> = [
      ['dies (SIGKILL)', 'self-kill', 'killed by macOS'],
      ['exits with a failure', 'exit-1', 'unexpected output'],
      ['names another folder', 'wrong-target', 'unexpected output'],
    ];
    for (const [what, runs, detail] of failures) {
      it(`refuses a launcher that passes natively but ${what} under arch -x86_64, and names the architecture`, async () => {
        const native = await loadNative();
        const x = scenario();
        const arch = stubArch(x.root, { x86_64: { runs } });
        const outcome = await withArch(arch, () => native.smokeLauncherEverywhere(x.artifacts.binary, { startScript }));
        expect(outcome).toEqual({ ok: false, detail: `arch -x86_64: ${detail}` });
        // The native run and arm64 passed (that is how the loop got to x86_64).
        expect(arch.runs()).toEqual([`arch -arm64 ${x.artifacts.binary}`, `arch -x86_64 ${x.artifacts.binary}`]);
      });
    }

    it('refuses a launcher that passes natively but dies under arch -arm64, and does not go on to x86_64', async () => {
      const native = await loadNative();
      const x = scenario();
      const arch = stubArch(x.root, { arm64: { runs: 'self-kill' } });
      const outcome = await withArch(arch, () => native.smokeLauncherEverywhere(x.artifacts.binary, { startScript }));
      expect(outcome).toEqual({ ok: false, detail: 'arch -arm64: killed by macOS' });
      expect(arch.calls().some((call) => call.includes('-x86_64'))).toBe(false);
    });

    it('skips an architecture this Mac cannot run (no Rosetta) and still passes: it is not a failure of the launcher', async () => {
      const native = await loadNative();
      const x = scenario();
      const arch = stubArch(x.root, { x86_64: { answers: false } });
      const outcome = await withArch(arch, () => native.smokeLauncherEverywhere(x.artifacts.binary, { startScript }));
      expect(outcome).toEqual({ ok: true, detail: 'ok' });
      expect(arch.runs()).toEqual([`arch -arm64 ${x.artifacts.binary}`]);
      expect(arch.calls()).toContain('arch -x86_64 /usr/bin/true'); // it was asked, and said no
    });

    it('a launcher that fails natively is refused before any architecture is tried', async () => {
      const native = await loadNative();
      const x = scenario({ artifacts: { kind: 'self-kill' } });
      const arch = stubArch(x.root);
      const outcome = await withArch(arch, () => native.smokeLauncherEverywhere(x.artifacts.binary, { startScript }));
      expect(outcome).toEqual({ ok: false, detail: 'killed by macOS' });
      expect(arch.calls()).toEqual([]);
    });
  });

  describe('the installer (make-app-bundle.mjs --launcher-only)', () => {
    for (const [name, behavior, expectedDetail] of [
      ['x86_64', { x86_64: { runs: 'self-kill' } }, 'arch -x86_64: killed by macOS'],
      ['arm64', { arm64: { runs: 'exit-1' } }, 'arch -arm64: unexpected output'],
    ] as const) {
      it(`a launcher that passes natively but fails under arch -${name} is refused: the working launcher, Info.plist and data folder stay exactly as they were`, () => {
        const x = scenario({ toolchain: 'none', existing: 'native' });
        x.legacyBundle('compiled');
        const before = x.snapshot();
        const arch = stubArch(x.root, behavior);
        const result = x.run(['--launcher-only', '--no-register'], arch.env);
        expect(result.status).toBe(1);
        expect(reasonOf(result.stdout)).toBe('launcher_smoke_failed');
        expect(result.stdout).toContain(`detail=${expectedDetail}`);
        expect(result.stderr).toContain('the existing launcher is untouched');
        expect(x.snapshot()).toEqual(before);
        expect(x.staged()).toEqual([]);
        // Nothing was backed up or recorded for an upgrade that did not happen, and the bundle was never run.
        expect(fs.existsSync(path.join(x.dataDir, 'app-launcher-backup'))).toBe(false);
        expect(fs.existsSync(path.join(x.dataDir, 'app-checkout.v1'))).toBe(false);
        for (const call of arch.runs()) expect(call, 'a launcher was run from inside the bundle').not.toContain('bundle-under-test');
      });
    }

    it('a Mac without Rosetta (arch -x86_64 cannot run anything) skips that architecture, and the install succeeds', () => {
      const x = scenario({ toolchain: 'none', existing: 'native' });
      x.legacyBundle('compiled');
      const arch = stubArch(x.root, { x86_64: { answers: false } });
      const result = x.run(['--launcher-only', '--no-register'], arch.env);
      expect(result.status, result.stderr + result.stdout).toBe(0);
      expect(sha256(fs.readFileSync(x.exePath))).toBe(sha256(x.artifacts.body));
      expect(x.plistValue('BotBoyLauncherVersion')).toBe('2');
      expect(arch.runs().some((call) => call.includes('-x86_64'))).toBe(false);
      expect(arch.runs().some((call) => call.startsWith('arch -arm64 '))).toBe(true);
    });

    it('when both architectures pass, both ran the checked candidate in a private folder, never the bundle, and the launcher is installed', () => {
      const x = scenario({ toolchain: 'none', existing: 'native' });
      x.legacyBundle('compiled');
      const arch = stubArch(x.root);
      const result = x.run(['--launcher-only', '--no-register'], arch.env);
      expect(result.status, result.stderr + result.stdout).toBe(0);
      const ran = arch.runs();
      expect(ran.filter((call) => call.startsWith('arch -arm64 '))).toHaveLength(1);
      expect(ran.filter((call) => call.startsWith('arch -x86_64 '))).toHaveLength(1);
      for (const call of ran) {
        expect(call).toContain('candidate-prebuilt');
        expect(call).not.toContain('bundle-under-test');
      }
      expect(sha256(fs.readFileSync(x.exePath))).toBe(sha256(x.artifacts.body));
    });
  });

  describe('launcher-facts --smoke (the doctor row and the plan)', () => {
    const script = path.join(packageRoot, 'scripts', 'native-prebuilt.mjs');
    const facts = (x: ReturnType<typeof scenario>, extraEnv: Record<string, string>) => {
      const app = path.dirname(path.dirname(path.dirname(x.exePath)));
      const result = spawnSync(process.execPath, [script, 'launcher-facts', '--app', app, '--checkout', packageRoot, '--smoke'], { env: x.env(extraEnv), encoding: 'utf8', timeout: 120_000 });
      expect(result.status, result.stderr).toBe(0);
      return parseFacts(result.stdout);
    };

    it('reports prebuilt_usable=0 with the same reason and the architecture when the launcher fails under arch -x86_64', () => {
      const x = scenario();
      x.legacyBundle('compiled');
      const arch = stubArch(x.root, { x86_64: { runs: 'self-kill' } });
      expect(facts(x, arch.env)).toMatchObject({
        prebuilt_usable: '0',
        prebuilt_reason: 'launcher_smoke_failed',
        prebuilt_detail: 'arch -x86_64: killed by macOS',
      });
    });

    it('says the installed launcher failed too when its bytes ARE the prebuilt one, and ok when it passes everywhere', () => {
      const x = scenario();
      x.legacyBundle('compiled');
      fs.writeFileSync(x.exePath, x.artifacts.body, { mode: 0o755 });
      const failing = stubArch(x.root, { x86_64: { runs: 'self-kill' } });
      expect(facts(x, failing.env)).toMatchObject({ installed_matches_prebuilt: '1', installed_smoke: 'failed: arch -x86_64: killed by macOS' });
      const passing = stubArch(path.join(x.root, 'second'), {});
      expect(facts(x, passing.env)).toMatchObject({ prebuilt_usable: '1', prebuilt_reason: '', installed_smoke: 'ok' });
    });

    it('a Mac without Rosetta is usable: the architecture it cannot run is skipped', () => {
      const x = scenario();
      x.legacyBundle('compiled');
      const arch = stubArch(x.root, { x86_64: { answers: false } });
      expect(facts(x, arch.env)).toMatchObject({ prebuilt_usable: '1', prebuilt_reason: '' });
    });
  });
});

/**
 * Review 2, finding 3: the installer stops BEFORE the swap when it cannot stage the new pair, write its
 * Info.plist, back up the current pair, or record the folder. These are the properties that protect a
 * working launcher: if the backup check were lost, a later read-back failure would find an incomplete
 * backup and leave the new launcher in place with nothing to restore. Each failure is a real filesystem
 * condition (no test hook in the production script): a file where the backup folder belongs, a folder where
 * the recorded-folder file belongs, a folder where the staged executable belongs, and a bundle identifier
 * that is not valid XML.
 */
onMac('the installer stops before the swap when it cannot back up, record, stage or write the plist (review 2, finding 3)', () => {
  const abortScenario = () => {
    const x = scenario({ toolchain: 'none', existing: 'native' });
    x.legacyBundle('compiled');
    return { x, before: x.snapshot() };
  };

  it('backup_failed: a file where the backup folder belongs leaves the old pair as it was, nothing staged, nothing recorded', () => {
    const { x, before } = abortScenario();
    fs.mkdirSync(x.dataDir, { recursive: true });
    fs.writeFileSync(path.join(x.dataDir, 'app-launcher-backup'), 'not a folder');
    const result = x.run();
    expect(result.status).toBe(1);
    expect(reasonOf(result.stdout)).toBe('backup_failed');
    expect(result.stderr).toContain('the existing launcher is untouched');
    expect(x.snapshot()).toEqual(before);
    expect(x.staged()).toEqual([]);
    expect(fs.existsSync(path.join(x.dataDir, 'app-checkout.v1'))).toBe(false);
    expect(fs.readFileSync(path.join(x.dataDir, 'app-launcher-backup'), 'utf8')).toBe('not a folder');
  });

  it('checkout_file_failed: a folder where the recorded-folder file belongs leaves the old pair as it was and no temporary file behind', () => {
    const { x, before } = abortScenario();
    const record = path.join(x.dataDir, 'app-checkout.v1');
    fs.mkdirSync(record, { recursive: true });
    const result = x.run();
    expect(result.status).toBe(1);
    expect(reasonOf(result.stdout)).toBe('checkout_file_failed');
    expect(result.stderr).toContain('the existing launcher is untouched');
    expect(x.snapshot()).toEqual(before);
    expect(x.staged()).toEqual([]);
    expect(fs.statSync(record).isDirectory()).toBe(true);
    expect(fs.readdirSync(x.dataDir).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    // The copies of the pair are the old ones (the backup finished before the record was tried).
    expect(sha256(fs.readFileSync(path.join(x.dataDir, 'app-launcher-backup', 'BotBoy')))).toBe(before.exe);
  });

  it('stage_failed: a folder where the staged executable belongs leaves the old pair as it was, and nothing else is staged', () => {
    const { x, before } = abortScenario();
    const blocker = `${x.exePath}.botboy-new`;
    fs.mkdirSync(blocker, { recursive: true });
    fs.writeFileSync(path.join(blocker, 'in-the-way'), 'x');
    const result = x.run();
    expect(result.status).toBe(1);
    expect(reasonOf(result.stdout)).toBe('stage_failed');
    expect(result.stderr).toContain('the existing launcher is untouched');
    expect(x.snapshot()).toEqual(before);
    expect(x.staged()).toEqual(['BotBoy.botboy-new']); // only the folder the test put there
    expect(fs.existsSync(`${x.plistPath}.botboy-new`)).toBe(false);
    expect(fs.existsSync(path.join(x.dataDir, 'app-launcher-backup'))).toBe(false);
    expect(fs.existsSync(path.join(x.dataDir, 'app-checkout.v1'))).toBe(false);
  });

  it('plist_invalid: an Info.plist that does not lint leaves the old pair as it was, nothing staged, nothing backed up or recorded', () => {
    const { x, before } = abortScenario();
    const result = spawnSync(process.execPath, [builderPath, '--dest', x.dest, '--bundle-id', 'not<valid>xml', '--launcher-only', '--no-register'], {
      env: x.env(),
      encoding: 'utf8',
      timeout: 120_000,
    });
    expect(result.status).toBe(1);
    expect(reasonOf(result.stdout)).toBe('plist_invalid');
    expect(result.stderr).toContain('the existing launcher is untouched');
    expect(x.snapshot()).toEqual(before);
    expect(x.staged()).toEqual([]);
    expect(fs.existsSync(path.join(x.dataDir, 'app-launcher-backup'))).toBe(false);
    expect(fs.existsSync(path.join(x.dataDir, 'app-checkout.v1'))).toBe(false);
  });
});

onMac('tiers 2 and 3 when the prebuilt launcher cannot be used', () => {
  it('compiles the generic source when a toolchain exists (Intel path), checks the result like any candidate, and says it was built here', () => {
    const x = scenario({ artifacts: { corrupt: true }, toolchain: 'builds', hw: 'intel', existing: 'script' });
    x.legacyBundle('script');
    const result = x.run();
    expect(result.status, result.stderr + result.stdout).toBe(0);
    expect(result.stdout).toContain('launcher compiled on this Mac');
    expect(sha256(fs.readFileSync(x.exePath))).toBe(sha256(launcherBody('ok')));
    expect(x.plistValue('BotBoyLauncherVersion')).toBe('2');
    expect(x.plistValue('LSMinimumSystemVersion')).toBe('12.0');
    // The compiler was handed the generic source, with no injected START_SCRIPT shim file.
    const compile = x.toolCalls().find((line) => line.startsWith('swiftc '))!;
    expect(compile).toContain('main.swift');
    expect(compile).not.toContain('start_script.swift');
  });

  it('a compiled launcher that fails its check is dropped like a prebuilt one', () => {
    const x = scenario({ artifacts: { corrupt: true }, toolchain: 'builds', compiledKind: 'self-kill', hw: 'intel', existing: 'native' });
    x.legacyBundle('compiled');
    const before = x.snapshot();
    const result = x.run();
    expect(result.status).toBe(1);
    expect(x.snapshot()).toEqual(before);
  });

  it('with no native launcher at all and nothing to build one, installs the shell script that reads the same file', () => {
    const x = scenario({ artifacts: { corrupt: true }, toolchain: 'none', existing: 'script' });
    x.legacyBundle('script');
    const result = x.run();
    expect(result.status, result.stderr + result.stdout).toBe(0);
    const text = fs.readFileSync(x.exePath, 'utf8');
    expect(text.startsWith('#!/bin/bash')).toBe(true);
    expect(text).toContain('app-checkout.v1');
    expect(text).not.toMatch(/START_SH='/);
    expect(x.plistValue('BotBoyLauncherVersion')).toBe('2');
    expect(result.stdout).toContain('shell script (no Dock icon)');
    expect(result.stderr).toContain('Falling back to the shell launcher');
  });

  it('never puts the shell script in place of a working native launcher', () => {
    const x = scenario({ artifacts: { corrupt: true }, toolchain: 'none', existing: 'native' });
    x.legacyBundle('compiled');
    const before = x.snapshot();
    const result = x.run();
    expect(result.status).toBe(1);
    expect(x.snapshot()).toEqual(before);
    expect(result.stderr).toContain('The existing native launcher stays in place.');
  });

  it('a compiler that fails leaves a working script launcher on its way to the generic script, and reports the first reason', () => {
    const x = scenario({ artifacts: { manifest: 'missing' }, toolchain: 'fails', hw: 'intel', existing: 'script' });
    x.legacyBundle('script');
    const result = x.run();
    // Replacing a script launcher with the generic script is allowed; the exit says it worked.
    expect(result.status, result.stderr + result.stdout).toBe(0);
    expect(fs.readFileSync(x.exePath, 'utf8')).toContain('app-checkout.v1');
  });

  it('a fresh create falls through the tiers the same way, and reports nothing was installed when even the script fails the check', () => {
    const x = scenario({ artifacts: { corrupt: true }, toolchain: 'none', existing: 'none' });
    const result = x.run(['--no-register']);
    expect(result.status, result.stderr + result.stdout).toBe(0);
    expect(fs.readFileSync(x.exePath, 'utf8')).toContain('app-checkout.v1');
    expect(x.staged()).toEqual([]);
  });

  it('refuses to start from a folder whose start.sh is missing or not executable', async () => {
    const { pathToFileURL: toUrl } = await import('node:url');
    const mod = (await import(/* @vite-ignore */ toUrl(builderPath).href)) as { chooseLauncher: (o: Record<string, unknown>) => { ok: boolean; reason: string } };
    const dir = tmp();
    const result = mod.chooseLauncher({ stagedPath: path.join(dir, 'x'), startSh: path.join(dir, 'no-start.sh'), appleSilicon: true, hasExistingNative: false, workDir: dir, swiftSrc: path.join(dir, 'main.swift'), root: dir });
    expect(result).toMatchObject({ ok: false, reason: 'start_script_missing' });
  });
});

describe('the generic launcher contract (native-prebuilt.mjs)', () => {
  const home = () => tmp();

  it('records a folder as its physical path, privately, in one rename, and reads back only what the launcher would accept', async () => {
    const native = await loadNative();
    const h = home();
    const folder = path.join(tmp(), 'real folder');
    fs.mkdirSync(folder);
    const link = path.join(tmp(), 'link');
    fs.symlinkSync(folder, link);
    const written = native.writeCheckoutFile(link, { home: h });
    expect(written).toEqual({ ok: true, checkout: fs.realpathSync(folder) });
    const file = native.checkoutFilePath(h);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(path.dirname(file))).toEqual(['app-checkout.v1']);
    expect(native.readCheckoutFile({ home: h })).toEqual({ checkout: fs.realpathSync(folder) });
    // Not recorded: relative path, control character, over 8 KB, no file.
    for (const bad of ['checkout=relative/folder\n', `checkout=${folder}\u0007\n`, `checkout=${folder}\n${'#'.repeat(9000)}\n`, 'written=2026-10-13T10:00:00\n']) {
      fs.writeFileSync(file, bad);
      expect(native.readCheckoutFile({ home: h }), bad.slice(0, 30)).toBeNull();
    }
    expect(native.readCheckoutFile({ home: home() })).toBeNull();
    // A folder the file cannot hold is refused before anything is written.
    expect(native.writeCheckoutFile(path.join(tmp(), 'missing'), { home: home() }).ok).toBe(false);
  });

  it('finds the folder an older launcher embeds: a compiled one as its own string, a script one in START_SH (quotes and spaces included)', async () => {
    const native = await loadNative();
    const dir = tmp();
    const compiled = path.join(dir, 'compiled');
    fs.writeFileSync(compiled, legacyCompiledBytes('/Users/maria/botboy app/start.sh'));
    expect(native.findBakedStartScript(compiled)).toBe('/Users/maria/botboy app/start.sh');
    const script = path.join(dir, 'script');
    fs.writeFileSync(script, legacyScriptText("/Users/o'brien/botboy-app/start.sh"));
    expect(native.findBakedStartScript(script)).toBe("/Users/o'brien/botboy-app/start.sh");
    // A generic launcher embeds nothing, and a path inside a longer message is not a baked path.
    const generic = path.join(dir, 'generic');
    fs.writeFileSync(generic, launcherBody('ok'));
    expect(native.findBakedStartScript(generic)).toBe('');
    const message = path.join(dir, 'message');
    fs.writeFileSync(message, Buffer.from('\u0000see /Users/x/start.sh for details\u0000'));
    expect(native.findBakedStartScript(message)).toBe('');
    expect(native.findBakedStartScript(path.join(dir, 'missing'))).toBe('');
  });

  it('the committed prebuilt launcher embeds no folder (it is generic) and the committed manifest agrees with the code', async () => {
    if (distribution) return;
    const native = await loadNative();
    const file = path.join(packageRoot, 'native', 'botboy-launcher', 'prebuilt', 'botboy-launcher');
    expect(native.findBakedStartScript(file)).toBe('');
    // Booleans only: a failing assertion must not print a binary into the log.
    const text = fs.readFileSync(file).toString('latin1');
    const oldShimConstant = /(?<!BOTBOY_APP_)START_SCRIPT/; // the injected per-Mac constant; the env var BOTBOY_APP_START_SCRIPT is the test override
    expect(text.includes('/Users/'), 'a user path is compiled into the launcher').toBe(false);
    expect(oldShimConstant.test(text), 'the old START_SCRIPT constant is compiled into the launcher').toBe(false);
    expect(text.includes('app-checkout.v1')).toBe(true);
    expect(text.includes('BOTBOY_APP_PRINT_TARGET')).toBe(true);
    expect(oldShimConstant.test(fs.readFileSync(path.join(packageRoot, 'native', 'botboy-launcher', 'main.swift'), 'utf8'))).toBe(false);
  });

  it('launcher-facts: the cheap facts always, the smoke only when asked, and nothing run from inside the app', async () => {
    const native = await loadNative();
    const x = scenario();
    x.legacyBundle('compiled');
    const app = path.dirname(path.dirname(path.dirname(x.exePath)));
    process.env.BOTBOY_TEST_NATIVE_ROOT = x.nativeRoot;
    process.env.BOTBOY_TEST_CODESIGN_BIN = x.env().BOTBOY_TEST_CODESIGN_BIN;
    process.env.BOTBOY_TEST_SW_VERS_BIN = x.env().BOTBOY_TEST_SW_VERS_BIN;
    try {
      const cheap = native.launcherFacts({ app, checkout: packageRoot, home: x.home });
      expect(cheap).toMatchObject({
        checkout: packageRoot,
        prebuilt_usable: 'unchecked',
        want_version: native.LAUNCHER_VERSION,
        installed_matches_prebuilt: 0,
        installed_smoke: 'unchecked',
        recorded_checkout: '',
        recorded_live: 0,
        legacy_baked_path: path.join(packageRoot, 'start.sh'),
        legacy_baked_live: 1,
      });
      const asked = native.launcherFacts({ app, checkout: packageRoot, home: x.home, smoke: true });
      expect(asked).toMatchObject({ prebuilt_usable: 1, installed_smoke: 'n/a' });
      // The installed file IS the prebuilt launcher: the answer comes from running the checkout's copy, not the installed file.
      fs.writeFileSync(x.exePath, x.artifacts.body, { mode: 0o755 });
      expect(native.launcherFacts({ app, checkout: packageRoot, home: x.home, smoke: true })).toMatchObject({ installed_matches_prebuilt: 1, installed_smoke: 'ok' });
      expect(native.launcherFacts({ app, checkout: packageRoot, home: x.home })).toMatchObject({ installed_matches_prebuilt: 1, installed_smoke: 'unchecked' });
      // Reasons are words, on one line.
      process.env.BOTBOY_TEST_SW_VERS_BIN = path.join(x.root, 'stubs', 'old-sw_vers');
      fs.writeFileSync(process.env.BOTBOY_TEST_SW_VERS_BIN, '#!/bin/sh\necho 12.7.6\n', { mode: 0o755 });
      const old = native.launcherFacts({ app, checkout: packageRoot, home: x.home, smoke: true });
      expect(old).toMatchObject({ prebuilt_usable: 0, prebuilt_reason: 'os_too_old' });
      expect(String(old.prebuilt_detail)).not.toContain('\n');
    } finally {
      delete process.env.BOTBOY_TEST_NATIVE_ROOT;
      delete process.env.BOTBOY_TEST_CODESIGN_BIN;
      delete process.env.BOTBOY_TEST_SW_VERS_BIN;
    }
  });

  it('the launcher-facts command prints key=value lines and rejects unknown arguments', async () => {
    const x = scenario();
    x.legacyBundle('compiled');
    const app = path.dirname(path.dirname(path.dirname(x.exePath)));
    const script = path.join(packageRoot, 'scripts', 'native-prebuilt.mjs');
    const ok = spawnSync(process.execPath, [script, 'launcher-facts', '--app', app, '--checkout', packageRoot], { env: x.env(), encoding: 'utf8' });
    expect(ok.status, ok.stderr).toBe(0);
    const keys = ok.stdout.split('\n').filter(Boolean).map((line) => line.split('=')[0]);
    expect(keys).toEqual(['checkout', 'prebuilt_usable', 'prebuilt_reason', 'prebuilt_detail', 'want_version', 'installed_matches_prebuilt', 'installed_smoke', 'recorded_checkout', 'recorded_live', 'legacy_baked_path', 'legacy_baked_live']);
    expect(spawnSync(process.execPath, [script, 'launcher-facts', '--app', app, '--surprise', 'x'], { env: x.env(), encoding: 'utf8' }).status).toBe(2);
    expect(spawnSync(process.execPath, [script, 'launcher-facts', '--app', 'relative/path'], { env: x.env(), encoding: 'utf8' }).status).toBe(2);
  });
});

onMac('the real prebuilt launcher on this Mac', () => {
  it('is installed into a scratch bundle byte for byte, passes every check, and the folder it opens is recorded', () => {
    if (distribution) return;
    const root = tmp();
    const home = path.join(root, 'home');
    fs.mkdirSync(home);
    const dest = path.join(root, 'bundle-under-test');
    const result = spawnSync(process.execPath, [builderPath, '--dest', dest, '--bundle-id', 'com.botboy.scratch', '--no-register'], {
      env: { ...process.env, ...ui.env, HOME: home },
      encoding: 'utf8',
      timeout: 120_000,
    });
    expect(result.status, result.stderr + result.stdout).toBe(0);
    const manifest = JSON.parse(fs.readFileSync(path.join(packageRoot, 'native', 'prebuilt-manifest.json'), 'utf8'));
    const installed = path.join(dest, 'Contents', 'MacOS', 'BotBoy');
    expect(sha256(fs.readFileSync(installed))).toBe(manifest.artifacts.botboyLauncher.binary.sha256);
    expect(result.stdout).toContain('prebuilt universal launcher (no developer tools needed)');
    const plist = path.join(dest, 'Contents', 'Info.plist');
    const value = (key: string) => spawnSync(PLISTBUDDY, ['-c', `Print :${key}`, plist], { encoding: 'utf8' }).stdout.trim();
    expect(value('BotBoyLauncherVersion')).toBe(String(manifest.artifacts.botboyLauncher.launcherVersion));
    expect(value('LSMinimumSystemVersion')).toBe('13.0');
    expect(fs.readFileSync(path.join(home, '.personal-productivity-tracker', 'app-checkout.v1'), 'utf8').split('\n')[0]).toBe(`checkout=${packageRoot}`);
    expect(ui.calls()).toEqual([]);
  });
});

describe('fixtures describe what the code expects', () => {
  it('the fixture source and manifest hashes line up (a sanity check of the test helpers)', () => {
    const x = scenario();
    const manifest = JSON.parse(fs.readFileSync(x.artifacts.manifest, 'utf8'));
    expect(manifest.artifacts.botboyLauncher.source.sha256).toBe(sha256(LAUNCHER_SOURCE));
    expect(manifest.artifacts.botboyLauncher.binary.sha256).toBe(sha256(x.artifacts.body));
    expect(fs.statSync(x.artifacts.binary).mode & 0o111).toBeGreaterThan(0);
  });
});
