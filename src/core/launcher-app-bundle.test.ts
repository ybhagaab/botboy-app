/**
 * start.sh › the BotBoy.app launcher plan. macOS starts a shell-script app, and
 * a compiled launcher with no arm64 slice, under Rosetta unless Info.plist
 * prefers arm64; start.sh patches an existing bundle's plist without a
 * compiler, rebuilds an Intel-only launcher only when it safely can, and
 * never touches the owner's real /Applications/BotBoy.app here: every test
 * points BOTBOY_TEST_APP_BUNDLE at a scratch bundle and HOME at a temp dir.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Each case spawns the launcher a few times; a loaded Mac needs more than 5 s.
vi.setConfig({ testTimeout: 60_000 });

const launcherPath = fileURLToPath(new URL('../../start.sh', import.meta.url));
const PLISTBUDDY = '/usr/libexec/PlistBuddy';
const roots: string[] = [];
afterEach(() => {
  while (roots.length) {
    const root = roots.pop()!;
    spawnSync('/bin/chmod', ['-R', 'u+rwX', root]);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

const FAT = 'Mach-O universal binary with 2 architectures: [x86_64:Mach-O 64-bit executable x86_64] [arm64:Mach-O 64-bit executable arm64]';
const ARM_ONLY = 'Mach-O 64-bit executable arm64';
const INTEL_ONLY = 'Mach-O 64-bit executable x86_64';
const SCRIPT = 'Bourne-Again shell script text executable, Unicode text, UTF-8 text';

const PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>BotBoy</string>
  <key>CFBundleExecutable</key><string>BotBoy</string>
</dict>
</plist>
`;

type Priority = 'none' | 'arm64-first' | 'x86-first' | 'extra';

function box() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'botboy-applauncher-'));
  roots.push(root);
  const dir = path.join(root, 'app');
  const stubs = path.join(root, 'stubs');
  const marks = path.join(root, 'marks');
  const home = path.join(root, 'home');
  const bundle = path.join(root, 'BotBoy.app');
  for (const d of [dir, stubs, marks, home, path.join(dir, 'scripts')]) fs.mkdirSync(d, { recursive: true });
  fs.copyFileSync(launcherPath, path.join(dir, 'start.sh'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x' }));
  const stub = (name: string, body: string) => {
    const file = path.join(stubs, name);
    fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    return file;
  };
  const answerFile = path.join(root, 'file-answer');
  const fileStub = stub('file', `cat '${answerFile}'`);
  const xcodeSelectOk = stub('xcode-select', 'echo /stub/clt');
  const xcodeSelectNo = stub('xcode-select-no', 'exit 2');
  const xcrunOk = stub('xcrun', 'echo /stub/swiftc');
  const lsregister = stub('lsregister', `echo "$@" >> '${path.join(marks, 'lsregister')}'`);
  const plistPath = path.join(bundle, 'Contents', 'Info.plist');
  const exePath = path.join(bundle, 'Contents', 'MacOS', 'BotBoy');
  const buddy = (...commands: string[]) =>
    spawnSync(PLISTBUDDY, commands.flatMap((c) => ['-c', c]).concat(plistPath), { encoding: 'utf8' });
  /** Create the scratch bundle; `exe: null` leaves the executable out. */
  const makeBundle = (options: { file: string; priority: Priority; exe?: string | null }) => {
    fs.mkdirSync(path.dirname(plistPath), { recursive: true });
    fs.mkdirSync(path.dirname(exePath), { recursive: true });
    fs.writeFileSync(plistPath, PLIST);
    fs.writeFileSync(answerFile, `${options.file}\n`);
    if (options.exe !== null) fs.writeFileSync(exePath, options.exe ?? `launcher refers to ${path.join(dir, 'start.sh')}`);
    const entries: Record<Priority, string[]> = {
      none: [],
      'arm64-first': ['arm64', 'x86_64'],
      'x86-first': ['x86_64', 'arm64'],
      extra: ['x86_64', 'arm64', 'x86_64'],
    };
    if (options.priority !== 'none') {
      buddy('Add :LSArchitecturePriority array', ...entries[options.priority].map((value, index) => `Add :LSArchitecturePriority:${index} string ${value}`));
    }
  };
  const priorityOf = () => {
    const out = buddy('Print :LSArchitecturePriority').stdout;
    return out.split('\n').map((line) => line.trim()).filter((line) => line && line !== 'Array {' && line !== '}');
  };
  const env = (extra: Record<string, string> = {}) => {
    const base: Record<string, string | undefined> = { ...process.env };
    for (const key of ['BOTBOY_NATIVE_REEXEC', 'BOTBOY_REEXEC_FROM']) delete base[key];
    return {
      ...base,
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
      BOTBOY_TEST_LSOF_BIN: stub('lsof', ''),
      ...extra,
    } as Record<string, string>;
  };
  const run = (hook: string, extra: Record<string, string> = {}, args: string[] = []) =>
    spawnSync('/bin/bash', [path.join(dir, 'start.sh'), ...args], {
      cwd: dir,
      env: env({ [hook]: '1', ...extra }),
      encoding: 'utf8',
      timeout: 20_000,
    });
  const planOf = (extra: Record<string, string> = {}, args: string[] = []) => {
    const result = run('BOTBOY_TEST_APP_LAUNCHER_PLAN', extra, args);
    expect(result.status, result.stderr).toBe(0);
    return /^plan=(\w+)$/m.exec(result.stdout)![1];
  };
  const lsregisterCalls = () => {
    const file = path.join(marks, 'lsregister');
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n') : [];
  };
  return {
    root, dir, home, bundle, plistPath, exePath, marks, stub, xcodeSelectNo, makeBundle, priorityOf, buddy, env, run, planOf, lsregisterCalls,
  };
}

describe('app_launcher_plan', () => {
  it('leaves an existing bundle alone on an Intel Mac, and reads nothing from it', () => {
    const b = box();
    b.makeBundle({ file: INTEL_ONLY, priority: 'none' });
    expect(b.planOf({ BOTBOY_TEST_HW_ARM64: '0' })).toBe('none');
    const facts = b.run('BOTBOY_TEST_APP_LAUNCHER_PLAN', { BOTBOY_TEST_HW_ARM64: '0' }).stdout;
    expect(facts).toContain('kind=none archs= priority=');
  });
  it('creates the bundle when it is missing, on any hardware, or when its executable is gone', () => {
    const b = box();
    expect(b.planOf({ BOTBOY_TEST_HW_ARM64: '0' })).toBe('create');
    expect(b.planOf()).toBe('create');
    b.makeBundle({ file: SCRIPT, priority: 'none', exe: null });
    expect(b.planOf()).toBe('create');
  });
  it('patches the plist of a script or compiled launcher whose priority is missing or wrong', () => {
    for (const file of [SCRIPT, FAT, ARM_ONLY, 'data']) {
      for (const priority of ['none', 'x86-first'] as const) {
        const b = box();
        b.makeBundle({ file, priority });
        expect(b.planOf(), `${file} / ${priority}`).toBe('patch_plist');
      }
    }
  });
  it('does nothing when the priority already starts with arm64', () => {
    for (const file of [SCRIPT, FAT, ARM_ONLY]) {
      const b = box();
      b.makeBundle({ file, priority: 'arm64-first' });
      expect(b.planOf(), file).toBe('none');
    }
  });
  it('rebuilds an Intel-only launcher only with a toolchain, this checkout, not --foreground, and no recorded failure', () => {
    const b = box();
    b.makeBundle({ file: INTEL_ONLY, priority: 'arm64-first' });
    expect(b.planOf()).toBe('rebuild');
    expect(b.planOf({}, ['--foreground'])).toBe('warn_harmless');
    expect(b.planOf({ BOTBOY_TEST_XCODE_SELECT_BIN: b.xcodeSelectNo })).toBe('warn_harmless');
    // Another checkout's launcher is not ours to rebuild.
    fs.writeFileSync(b.exePath, 'launcher refers to /somewhere/else/start.sh');
    expect(b.planOf()).toBe('warn_harmless');
  });
  it('never rebuilds a launcher that already holds an arm64 slice, or a shell script', () => {
    for (const file of [FAT, ARM_ONLY, SCRIPT]) {
      const b = box();
      b.makeBundle({ file, priority: 'arm64-first' });
      expect(b.planOf(), file).not.toBe('rebuild');
    }
  });
  it('treats an Intel-only launcher as harmless without patching its plist', () => {
    const b = box();
    b.makeBundle({ file: INTEL_ONLY, priority: 'none' });
    expect(b.planOf({ BOTBOY_TEST_XCODE_SELECT_BIN: b.xcodeSelectNo })).toBe('warn_harmless');
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
    b.makeBundle({ file: SCRIPT, priority: 'none' });
    expect(patch(b)).toEqual([0, 1]);
    expect(b.priorityOf()).toEqual(['arm64', 'x86_64']);
    expect(fs.existsSync(`${b.plistPath}.botboy-new`)).toBe(false);
    expect(b.lsregisterCalls()).toEqual([`-f ${b.bundle}`]);
    expect(spawnSync('/usr/bin/plutil', ['-lint', b.plistPath]).status).toBe(0);
  });
  it('is idempotent: a second run changes nothing and never grows the array', () => {
    const b = box();
    b.makeBundle({ file: SCRIPT, priority: 'none' });
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
      b.makeBundle({ file: SCRIPT, priority });
      expect(patch(b)).toEqual([0, 1]);
      expect(b.priorityOf()).toEqual(['arm64', 'x86_64']);
    }
  });
  it('trusts the re-read, not PlistBuddy exit codes', () => {
    const b = box();
    b.makeBundle({ file: SCRIPT, priority: 'none' });
    // Does the work, then reports failure.
    const noisy = b.stub('buddy-noisy', `${PLISTBUDDY} "$@"\ncase "$*" in *Add*) exit 1;; esac`);
    expect(patch(b, { BOTBOY_TEST_PLISTBUDDY_BIN: noisy })).toEqual([0, 1]);
    expect(b.priorityOf()).toEqual(['arm64', 'x86_64']);
    // Reports success, changes nothing: the original stays and nothing is left behind.
    const b2 = box();
    b2.makeBundle({ file: SCRIPT, priority: 'none' });
    const before = fs.readFileSync(b2.plistPath);
    const liar = b2.stub('buddy-liar', 'exit 0');
    expect(patch(b2, { BOTBOY_TEST_PLISTBUDDY_BIN: liar })).toEqual([1, 0]);
    expect(fs.readFileSync(b2.plistPath).equals(before)).toBe(true);
    expect(fs.existsSync(`${b2.plistPath}.botboy-new`)).toBe(false);
    expect(b2.lsregisterCalls()).toEqual([]);
  });
  it('leaves the original intact and removes its temporary copy when it cannot write', () => {
    const b = box();
    b.makeBundle({ file: SCRIPT, priority: 'none' });
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

describe('install_app_bundle_if_missing (apply)', () => {
  /** A stand-in for scripts/make-app-bundle.mjs that records how it was called. */
  const builder = (b: ReturnType<typeof box>, exitCode: number, comment = '') => {
    const calls = path.join(b.root, 'builder-calls');
    fs.writeFileSync(
      path.join(b.dir, 'scripts', 'make-app-bundle.mjs'),
      `${comment}\nimport fs from 'node:fs';\nfs.appendFileSync(${JSON.stringify(calls)}, process.argv.slice(2).join(' ') + '\\n');\nprocess.exit(${exitCode});\n`,
    );
    return () => (fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').trim().split('\n') : []);
  };
  const apply = (b: ReturnType<typeof box>, args: string[] = []) => {
    const result = b.run('BOTBOY_TEST_APP_LAUNCHER_APPLY', {}, args);
    expect(result.status, result.stderr).toBe(0);
    return result.stdout;
  };

  it('creates a missing bundle through the builder', () => {
    const b = box();
    const calls = builder(b, 0);
    const out = apply(b);
    expect(calls()).toEqual([`--dest ${b.bundle}`]);
    expect(out).toContain('BotBoy.app installed');
  });
  it('never rebuilds in --foreground, and warns calmly instead', () => {
    const b = box();
    b.makeBundle({ file: INTEL_ONLY, priority: 'arm64-first' });
    const calls = builder(b, 0);
    const out = apply(b, ['--foreground']);
    expect(calls()).toEqual([]);
    expect(out).toContain('harmless, because start.sh re-launches BotBoy natively');
  });
  it('rebuilds the launcher once, patches the plist, and records success', () => {
    const b = box();
    b.makeBundle({ file: INTEL_ONLY, priority: 'none' });
    const calls = builder(b, 0);
    const out = apply(b);
    expect(calls()).toEqual([`--launcher-only --dest ${b.bundle}`]);
    expect(out).toContain('launcher rebuilt');
    const marker = fs.readFileSync(path.join(b.home, '.personal-productivity-tracker', 'app-launcher.v1'), 'utf8');
    expect(marker).toMatch(/^result=ok$/m);
    expect(marker).toMatch(/^launcher=\d+:\d+$/m);
    expect(marker).toMatch(/^date=\d{4}-\d{2}-\d{2}T/m);
    expect(b.priorityOf()).toEqual(['arm64', 'x86_64']);
  });
  it('does not retry a failed rebuild until the launcher or the builder changes', () => {
    const b = box();
    b.makeBundle({ file: INTEL_ONLY, priority: 'arm64-first' });
    const calls = builder(b, 1);
    const first = apply(b);
    expect(calls()).toHaveLength(1);
    expect(first).toContain('harmless');
    expect(fs.readFileSync(path.join(b.home, '.personal-productivity-tracker', 'app-launcher.v1'), 'utf8')).toMatch(/^result=failed$/m);
    // Same launcher, same builder: no second attempt, and the plan says why.
    apply(b);
    expect(calls()).toHaveLength(1);
    expect(b.planOf()).toBe('warn_harmless');
    // A changed launcher is a new situation.
    fs.writeFileSync(b.exePath, `different launcher refers to ${path.join(b.dir, 'start.sh')}`);
    expect(b.planOf()).toBe('rebuild');
    // So is a changed builder.
    fs.writeFileSync(b.exePath, `launcher refers to ${path.join(b.dir, 'start.sh')}`);
    builder(b, 1, '// a newer builder');
    expect(b.planOf()).toBe('rebuild');
  });
  it('patches only the plist for a script launcher, without running the builder', () => {
    const b = box();
    b.makeBundle({ file: SCRIPT, priority: 'none' });
    const calls = builder(b, 0);
    const out = apply(b);
    expect(calls()).toEqual([]);
    expect(out).toContain('takes effect at the next app launch: quit and reopen BotBoy');
    expect(b.priorityOf()).toEqual(['arm64', 'x86_64']);
  });
});

describe('doctor_app_launcher_row', () => {
  const row = (b: ReturnType<typeof box>, extra: Record<string, string> = {}) => {
    const result = b.run('BOTBOY_TEST_DOCTOR_APP', extra, ['--doctor']);
    expect(result.status, result.stderr).toBe(0);
    return result.stdout.trim();
  };

  it('names the launcher kind and the architecture priority', () => {
    const cases: Array<[string, Priority, string]> = [
      [FAT, 'arm64-first', 'app launcher: compiled universal; architecture priority: arm64 first'],
      [ARM_ONLY, 'arm64-first', 'app launcher: compiled arm64; architecture priority: arm64 first'],
      [INTEL_ONLY, 'arm64-first', 'app launcher: compiled x86_64 only; architecture priority: arm64 first'],
      [SCRIPT, 'arm64-first', 'app launcher: shell script; architecture priority: arm64 first'],
    ];
    for (const [file, priority, expected] of cases) {
      const b = box();
      b.makeBundle({ file, priority });
      expect(row(b)).toBe(expected);
    }
  });
  it('says what a missing priority means for a script or an Intel-only launcher', () => {
    const b = box();
    b.makeBundle({ file: SCRIPT, priority: 'none' });
    expect(row(b)).toContain('app launcher: shell script; architecture priority: missing (the app itself starts translated');
    expect(row(b)).toContain('start.sh adds the key on its next start');
    const compiled = box();
    compiled.makeBundle({ file: ARM_ONLY, priority: 'none' });
    expect(row(compiled)).toContain('missing (harmless for a compiled launcher with an arm64 slice');
  });
  it('reports a missing bundle and an Intel Mac without failing the doctor', () => {
    const b = box();
    expect(row(b)).toContain('app launcher: not installed');
    b.makeBundle({ file: INTEL_ONLY, priority: 'none' });
    expect(row(b, { BOTBOY_TEST_HW_ARM64: '0' })).toBe('app launcher: installed (Intel Mac: nothing to check)');
  });
});
