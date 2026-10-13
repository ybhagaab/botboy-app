/**
 * start.sh and scripts/bootstrap-deps.mjs with a PREBUILT OCR helper (success
 * criteria S1 to S3 of the prebuilt-native-helpers task).
 *
 * S1 a Mac with no usable toolchain never compiles and never touches an Xcode
 *    shim, and OCR still works through the prebuilt helper (tripwire stubs).
 * S2 a toolchain that exists but fails or hangs changes nothing, start time included.
 * S3 a stale manifest, a damaged prebuilt, a macOS below the floor or a flagged
 *    file never blocks a start, says what is true ONCE, and never claims a build failed.
 *
 * The "helper" is a tiny shell script whose hash is in a fixture manifest; the
 * tools (xcode-select, xcrun, swiftc, lipo, otool, vtool, git, python3, xattr,
 * sw_vers) are stubs in a private folder at the front of PATH, and HOME is
 * private. Nothing here runs a real Mach-O, flags one, or touches a running BotBoy.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: 90_000 });

const launcherPath = fileURLToPath(new URL('../../start.sh', import.meta.url));
const bootstrapPath = fileURLToPath(new URL('../../scripts/bootstrap-deps.mjs', import.meta.url));
const nativePrebuiltPath = fileURLToPath(new URL('../../scripts/native-prebuilt.mjs', import.meta.url));
const launcherText = fs.readFileSync(launcherPath, 'utf8');
const onMac = describe.runIf(process.platform === 'darwin');
const sleepMs = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

const roots: string[] = [];
afterEach(() => {
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

const sha = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
const SOURCE = '// vision helper source\nprint("ok")\n';
// Xcode shims that nothing on the OCR path may ever run (xcrun and swiftc are handled per toolchain below).
const SHIMS = ['lipo', 'otool', 'vtool', 'python3'];

type Setup = {
  /** The prebuilt in the fixture: valid, or damaged in one way. */
  prebuilt?: 'valid' | 'none' | 'stale-source' | 'corrupt-hash' | 'truncated';
  macos?: string;
  /** A Swift toolchain on the Mac: none (xcode-select fails), or a compiler that fails, hangs or builds. */
  toolchain?: 'none' | 'fails' | 'hangs' | 'builds';
  flagged?: boolean;
  /** The flag cannot be cleared. */
  stuck?: boolean;
};

function box(setup: Setup = {}) {
  const { prebuilt = 'valid', macos = '14.5', toolchain = 'none', flagged = false, stuck = false } = setup;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'botboy-prebuilt-ocr-'));
  roots.push(root);
  const dir = path.join(root, 'app');
  const stubs = path.join(root, 'stubs');
  const home = path.join(root, 'home');
  for (const d of [path.join(dir, 'scripts'), path.join(dir, 'native', 'vision-ocr', 'prebuilt'), stubs, home]) fs.mkdirSync(d, { recursive: true });
  fs.copyFileSync(launcherPath, path.join(dir, 'start.sh'));
  fs.copyFileSync(bootstrapPath, path.join(dir, 'scripts', 'bootstrap-deps.mjs'));
  fs.copyFileSync(nativePrebuiltPath, path.join(dir, 'scripts', 'native-prebuilt.mjs'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x' }));
  const files = {
    source: path.join(dir, 'native', 'vision-ocr', 'main.swift'),
    helper: path.join(dir, 'native', 'vision-ocr', 'prebuilt', 'vision-ocr'),
    manifest: path.join(dir, 'native', 'prebuilt-manifest.json'),
    local: path.join(dir, 'native', 'vision-ocr', 'bin', 'vision-ocr'),
  };
  const log = path.join(root, 'launcher.log');
  const tripwire = path.join(root, 'tripwire');
  const helperRuns = path.join(root, 'helper-runs');
  const marker = path.join(home, '.personal-productivity-tracker', 'ocr-helper-build.json');
  const write = (name: string, body: string) => {
    const file = path.join(stubs, name);
    fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    return file;
  };

  const body = `#!/bin/sh\necho run >> '${helperRuns}'\necho '{"error":"usage: vision-ocr <imagePath> | pdf-text <pdfPath> | pdf-rasterize <pdfPath> <outDir> [dpi]"}' >&2\nexit 2\n`;
  fs.writeFileSync(files.source, prebuilt === 'stale-source' ? `${SOURCE}// customized in this checkout\n` : SOURCE);
  if (prebuilt !== 'none') {
    fs.writeFileSync(files.helper, body, { mode: 0o755 });
    fs.chmodSync(files.helper, 0o755);
    const manifest = {
      schema: 1,
      artifacts: {
        visionOcr: {
          source: { sha256: sha(SOURCE) },
          binary: { sha256: sha(body), bytes: Buffer.byteLength(body) },
          archs: ['arm64', 'x86_64'],
          minMacos: '13.0',
          signature: { kind: 'adhoc', identifier: 'com.botboy.vision-ocr' },
          toolchain: { swift: 'Apple Swift version 6.4 (swiftlang-6.4.0.34.1 clang-2100.3.34.1)', sdk: 'macosx27.0 (26A425)', ld: '27037.1' },
          builtAt: '2026-10-13',
        },
      },
    };
    fs.writeFileSync(files.manifest, JSON.stringify(manifest, null, 2));
    if (prebuilt === 'corrupt-hash') fs.writeFileSync(files.helper, body.replace('run', 'ran'), { mode: 0o755 });
    if (prebuilt === 'truncated') fs.writeFileSync(files.helper, body.slice(0, body.length - 12), { mode: 0o755 });
  }

  // Tripwires: every Xcode shim records that it ran. None may, on any path here.
  for (const name of SHIMS) write(name, `echo "${name} $*" >> '${tripwire}'\nexit 1`);
  // git is not under test here; a silent stand-in keeps start.sh's own git check from tripping the wire.
  write('git', 'exit 1');
  const compilerCalls = path.join(root, 'compiler-calls');
  const toolchainCalls = path.join(root, 'toolchain-calls');
  const xcodeSelect = write('xcode-select', `echo "xcode-select $*" >> '${toolchainCalls}'\n${toolchain === 'none' ? 'exit 2' : 'echo /stub/clt'}`);
  const xcrun = write('xcrun', toolchain === 'none'
    ? `echo "xcrun $*" >> '${tripwire}'\nexit 1`
    : `echo "xcrun $*" >> '${toolchainCalls}'\ncase "$1" in --show-sdk-path) echo /stub/sdk;; --find) echo '${path.join(stubs, 'swiftc')}';; esac`);
  if (toolchain === 'none') write('swiftc', `echo "swiftc $*" >> '${tripwire}'\nexit 1`);
  if (toolchain !== 'none') {
    const compile = {
      fails: 'echo x >> \'' + compilerCalls + '\'\necho "error: the SDK is not supported by the compiler" >&2\nexit 1',
      hangs: 'echo x >> \'' + compilerCalls + '\'\nexec sleep 60',
      builds: 'echo x >> \'' + compilerCalls + '\'\nout=""; while [ $# -gt 0 ]; do [ "$1" = "-o" ] && out="$2"; shift; done\nprintf \'#!/bin/sh\\necho local-helper\\n\' > "$out"\nchmod +x "$out"\nexit 0',
    }[toolchain];
    write('swiftc', `case "$1" in --version) echo 'Fake Swift version 1.0 (fake-1)'; exit 0;; esac\n${compile}`);
  }
  const swVers = write('sw_vers', `case "$1" in -productVersion) echo ${macos};; -buildVersion) echo 24A335;; esac`);
  const flag = path.join(root, 'flag-state');
  fs.writeFileSync(flag, flagged ? 'flagged' : 'none');
  const xattrCalls = path.join(root, 'xattr-calls');
  const xattr = write('xattr', `echo "$@" >> '${xattrCalls}'
case "$1" in
  -p) if [ "$(cat '${flag}')" = flagged ]; then echo "0081;5f5e1000;Chrome;"; exit 0; fi; echo "xattr: No such xattr: com.apple.quarantine" >&2; exit 1;;
  -d|-r) ${stuck ? 'exit 1' : `echo none > '${flag}'; exit 0`};;
esac
exit 64`);

  const env = (extra: Record<string, string> = {}) => {
    const base: Record<string, string | undefined> = { ...process.env };
    for (const key of ['BOTBOY_NATIVE_REEXEC', 'BOTBOY_REEXEC_FROM', 'BOTBOY_OCR_BUILD_TIMEOUT_SECONDS', 'BOTBOY_DEFER_OCR_BUILD', 'npm_lifecycle_event']) delete base[key];
    return {
      ...base,
      HOME: home,
      PPT_LOG_FILE: log,
      BOTBOY_NO_ARCH_REEXEC: '1',
      PATH: `${stubs}:${base.PATH ?? '/usr/bin:/bin'}`,
      BOTBOY_TEST_XCODE_SELECT_BIN: xcodeSelect,
      BOTBOY_TEST_XCRUN_BIN: xcrun,
      BOTBOY_TEST_SW_VERS_BIN: swVers,
      BOTBOY_TEST_XATTR_BIN: xattr,
      BOTBOY_TEST_GIT_SHIM: '/nonexistent/shim/git',
      ...extra,
    } as Record<string, string>;
  };
  const run = (hook: string | null, extra: Record<string, string> = {}, args: string[] = []) => {
    const started = Date.now();
    const result = spawnSync('/bin/bash', [path.join(dir, 'start.sh'), ...args], {
      cwd: dir,
      env: env({ ...(hook ? { [hook]: '1' } : {}), ...extra }),
      encoding: 'utf8',
      timeout: 60_000,
    });
    return { ...result, ms: Date.now() - started };
  };
  const bootstrap = (args: string[] = [], extra: Record<string, string> = {}) => {
    const started = Date.now();
    const result = spawnSync(process.execPath, [path.join(dir, 'scripts', 'bootstrap-deps.mjs'), ...args], { cwd: dir, env: env(extra), encoding: 'utf8', timeout: 60_000 });
    return { ...result, ms: Date.now() - started };
  };
  const count = (file: string) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).length : 0);
  return {
    root, dir, home, stubs, files, marker, log, write,
    env, run, bootstrap,
    tripwire: () => (fs.existsSync(tripwire) ? fs.readFileSync(tripwire, 'utf8').trim() : ''),
    helperRuns: () => count(helperRuns),
    compiles: () => count(compilerCalls),
    toolchainCalls: () => (fs.existsSync(toolchainCalls) ? fs.readFileSync(toolchainCalls, 'utf8').trim() : ''),
    xattrCalls: () => (fs.existsSync(xattrCalls) ? fs.readFileSync(xattrCalls, 'utf8').split('\n').filter(Boolean) : []),
    flagState: () => fs.readFileSync(flag, 'utf8').trim(),
    logText: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : ''),
    readMarker: () => JSON.parse(fs.readFileSync(marker, 'utf8')) as { kind: string; reasonCode?: string; reason: string; signature: Record<string, string> },
    hasMarker: () => fs.existsSync(marker),
  };
}

const CURRENT_ROW = 'ocr helper: prebuilt, current (universal arm64+x86_64, needs macOS 13+, built 2026-10-13 with Apple Swift 6.4); smoke ok';

onMac('S1: no usable toolchain: nothing compiles, no Xcode shim runs, OCR works through the prebuilt helper', () => {
  it('the job (worker hook, background mode) ends silently, runs the helper once, and touches no tool', () => {
    const b = box();
    const result = b.run('BOTBOY_TEST_OCR_REBUILD');
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    expect(b.tripwire()).toBe('');
    // Not even the silent probe: a current helper is decided before any toolchain question is asked.
    expect(b.toolchainCalls()).toBe('');
    expect(b.hasMarker()).toBe(false);
    expect(b.helperRuns()).toBe(1); // the smoke
  });

  it('the detached job kicked off at the end of a start does the same, in the background', () => {
    const b = box();
    const kickoff = b.run('BOTBOY_TEST_OCR_JOB');
    expect(kickoff.stdout.trim()).toBe('ocr-job-kicked-off');
    sleepMs(2500);
    expect(b.tripwire()).toBe('');
    expect(b.hasMarker()).toBe(false);
    expect(b.logText()).toBe('');
  });

  it('./start.sh --rebuild-ocr says the helper is ready and names its provenance, with no compile', () => {
    const b = box();
    const result = b.run(null, {}, ['--rebuild-ocr']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`✅ OCR helper ready (prebuilt, current (universal arm64+x86_64, needs macOS 13+, built 2026-10-13 with Apple Swift 6.4); smoke ok): BotBoy can read text inside images and scanned PDFs`);
    expect(b.tripwire()).toBe('');
  });

  it('the doctor rows name the prebuilt helper and the tools as optional, and touch no shim', () => {
    const b = box();
    const out = b.run('BOTBOY_TEST_DOCTOR_TOOLCHAIN').stdout;
    expect(out).toContain("xcode-clt: not installed (optional: BotBoy's helpers ship prebuilt; the tools are needed only for Node 20's database module, for git, and to build a helper from source)");
    expect(out).toContain(CURRENT_ROW);
    expect(out).toContain('pdf readers: vision-ocr helper (prebuilt);');
    expect(out).not.toMatch(/MISSING — run: xcode-select|cannot read text inside images/);
    expect(b.tripwire()).toBe('');
    expect(b.hasMarker()).toBe(false); // the doctor writes nothing
  });

  it('npm postinstall and npm run bootstrap find the prebuilt helper without asking for a toolchain', () => {
    for (const extra of [{ npm_lifecycle_event: 'postinstall' }, { npm_lifecycle_event: 'postinstall', BOTBOY_DEFER_OCR_BUILD: '1' }, {}]) {
      const b = box();
      const result = b.bootstrap([], extra);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('OCR helper: using the prebuilt helper (nothing to build).');
      expect(result.stdout).not.toMatch(/deferred|not built|Command Line Tools/);
      expect(b.tripwire()).toBe('');
      expect(b.toolchainCalls()).toBe('');
      expect(b.compiles()).toBe(0);
    }
  });

  it('an old remembered failure is deleted once a current helper is found', () => {
    const b = box();
    fs.mkdirSync(path.dirname(b.marker), { recursive: true });
    fs.writeFileSync(b.marker, JSON.stringify({ schema: 1, kind: 'failed', failedAt: '2026-10-12T16:26:47.000Z', durationMs: 4213, reason: 'error: boom', signature: { source: 'a', swiftc: 'b', osBuild: 'c' } }));
    expect(b.run('BOTBOY_TEST_OCR_REBUILD').stdout).toBe('');
    expect(b.hasMarker()).toBe(false);
  });

  it('--ocr-status prints the doctor row and exits 0; it writes and clears nothing', () => {
    const b = box();
    const status = b.bootstrap(['--ocr-status']);
    expect(status.status).toBe(0);
    expect(status.stdout.trim()).toBe(CURRENT_ROW);
    expect(b.hasMarker()).toBe(false);
    expect(b.tripwire()).toBe('');
  });
});

onMac('S2: a toolchain that exists but fails or hangs changes nothing, start time included', () => {
  for (const toolchain of ['fails', 'hangs'] as const) {
    it(`a compiler that ${toolchain} is never invoked while a current prebuilt exists`, () => {
      const baseline = box();
      const base = baseline.run('BOTBOY_TEST_OCR_REBUILD');
      const b = box({ toolchain });
      const result = b.run('BOTBOY_TEST_OCR_REBUILD');
      expect(result.status).toBe(0);
      expect(result.stdout).toBe('');
      expect(b.compiles()).toBe(0);
      expect(b.tripwire()).toBe('');
      expect(b.toolchainCalls()).toBe(''); // not even xcode-select or xcrun --find
      expect(b.hasMarker()).toBe(false);
      // A hanging compiler would hold the job for 120 s (60 s here); this finishes in the same few seconds as with no compiler.
      expect(result.ms).toBeLessThan(15_000);
      expect(base.ms).toBeLessThan(15_000);
    });
  }

  it('the detached job and --rebuild-ocr behave the same with a hanging compiler', () => {
    const b = box({ toolchain: 'hangs' });
    const kickoff = b.run('BOTBOY_TEST_OCR_JOB');
    expect(kickoff.ms).toBeLessThan(10_000);
    sleepMs(2000);
    expect(b.compiles()).toBe(0);
    const forced = b.run(null, {}, ['--rebuild-ocr']);
    expect(forced.status).toBe(0);
    expect(forced.ms).toBeLessThan(15_000);
    expect(b.compiles()).toBe(0);
  });
});

onMac('S3: stale, damaged or unusable prebuilt: start unaffected, one true note, never "build failed"', () => {
  it('a stale manifest (main.swift customized) keeps the prebuilt in use and is silent without a toolchain', () => {
    const b = box({ prebuilt: 'stale-source' });
    const result = b.run('BOTBOY_TEST_OCR_REBUILD');
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    expect(b.hasMarker()).toBe(false);
    expect(b.tripwire()).toBe('');
    const row = b.bootstrap(['--ocr-status']);
    expect(row.status).toBe(0);
    expect(row.stdout).toMatch(/^ocr helper: prebuilt, older than main\.swift in this folder; it still works \(\.\/start\.sh --rebuild-ocr builds a newer one\)/);
  });

  it('a stale manifest plus a failing compiler: ONE compile, the kept-helper note (not "OCR is off"), silent afterwards', () => {
    const b = box({ prebuilt: 'stale-source', toolchain: 'fails' });
    const first = b.run('BOTBOY_TEST_OCR_REBUILD');
    expect(b.compiles()).toBe(1);
    expect(first.stdout).toContain("Could not update BotBoy's reader for images and scanned PDFs (error: the SDK is not supported by the compiler); the previous reader stays and keeps working.");
    expect(first.stdout).toContain('System Settings > General > Software Update');
    expect(first.stdout).not.toContain('is off');
    expect(b.readMarker()).toMatchObject({ kind: 'failed' });
    expect(b.bootstrap(['--ocr-status']).status).toBe(0); // OCR still works through the prebuilt helper
    const second = b.run('BOTBOY_TEST_OCR_REBUILD');
    expect(second.stdout).toBe('');
    expect(b.compiles()).toBe(1);
  });

  for (const [prebuilt, label] of [['corrupt-hash', 'an edited'], ['truncated', 'a truncated']] as const) {
    it(`${label} prebuilt and no toolchain: one true sentence naming ./start.sh --update, remembered as unavailable, not as a failed build`, () => {
      const b = box({ prebuilt });
      const first = b.run('BOTBOY_TEST_OCR_REBUILD');
      expect(first.status).toBe(0);
      expect(first.stdout.trim()).toBe("ℹ  OCR is off: BotBoy's prebuilt reader does not match the release (damaged or edited). Run ./start.sh --update to restore it.");
      expect(first.stdout).not.toMatch(/build failed|could not be built|Command Line Tools/);
      expect(b.helperRuns()).toBe(0); // a file that fails its hash is never executed
      expect(b.tripwire()).toBe('');
      const marker = b.readMarker();
      expect(marker).toMatchObject({ kind: 'unavailable', reasonCode: 'prebuilt_corrupt' });
      expect(marker.reason).toContain('./start.sh --update');
      expect(marker.signature.swiftc).toBe('');
      expect(marker.signature.prebuilt).toMatch(/^[0-9a-f]{64}$/);
      // The calm note appears once; the next starts are silent.
      expect(b.run('BOTBOY_TEST_OCR_REBUILD').stdout).toBe('');
      expect(b.run('BOTBOY_TEST_OCR_REBUILD').stdout).toBe('');
      // --rebuild-ocr is the owner asking: it speaks again, and exits 1.
      const asked = b.run(null, {}, ['--rebuild-ocr']);
      expect(asked.status).toBe(1);
      expect(asked.stdout).toContain('ocr helper: OFF');
      // The doctor words the unavailable outcome as a reason, never as a failed build.
      const doctor = b.run('BOTBOY_TEST_DOCTOR_TOOLCHAIN').stdout;
      expect(doctor).toContain('ocr helper: OFF, OCR is off: BotBoy\'s prebuilt reader does not match the release');
      expect(doctor).not.toMatch(/build failed/i);
    });
  }

  it('a macOS below the floor: the helper is never run, the sentence names both versions and the update path, once', () => {
    const b = box({ macos: '12.7.6' });
    const first = b.run('BOTBOY_TEST_OCR_REBUILD');
    expect(first.stdout.trim()).toBe("ℹ  Text reading from images and scanned PDFs (OCR) is off: this Mac runs macOS 12.7.6 and BotBoy's reader needs macOS 13.0 or newer. Update macOS in System Settings > General > Software Update (or install the Command Line Tools with xcode-select --install, then run ./start.sh --rebuild-ocr).");
    expect(b.helperRuns()).toBe(0);
    expect(b.readMarker()).toMatchObject({ kind: 'unavailable', reasonCode: 'os_too_old' });
    expect(b.run('BOTBOY_TEST_OCR_REBUILD').stdout).toBe('');
    expect(b.tripwire()).toBe('');
  });

  it('a macOS below the floor WITH a toolchain compiles locally under the usual rules and then OCR works', () => {
    const b = box({ macos: '12.7.6', toolchain: 'builds' });
    const result = b.run('BOTBOY_TEST_OCR_REBUILD');
    expect(result.stdout).toBe('');
    expect(b.compiles()).toBe(1);
    expect(b.hasMarker()).toBe(false);
    expect(b.helperRuns()).toBe(0); // the prebuilt is still never run on that macOS
    const row = b.bootstrap(['--ocr-status']);
    expect(row.status).toBe(0);
    expect(row.stdout.trim()).toBe('ocr helper: local build, current (compiled on this Mac)');
  });

  it('no prebuilt at all and no toolchain: the reader-missing sentence, once', () => {
    const b = box({ prebuilt: 'none' });
    expect(b.run('BOTBOY_TEST_OCR_REBUILD').stdout.trim()).toBe("ℹ  OCR is off: BotBoy's prebuilt reader is missing from this folder. Run ./start.sh --update to restore it.");
    expect(b.readMarker()).toMatchObject({ kind: 'unavailable', reasonCode: 'manifest_missing' });
    expect(b.run('BOTBOY_TEST_OCR_REBUILD').stdout).toBe('');
  });

  it('a new release (a different prebuilt) re-evaluates: the remembered note is dropped once the helper is current', () => {
    const b = box({ prebuilt: 'corrupt-hash' });
    b.run('BOTBOY_TEST_OCR_REBUILD');
    expect(b.readMarker().kind).toBe('unavailable');
    // --update restores the real file: same manifest, matching bytes.
    const good = `#!/bin/sh\necho run >> '${path.join(b.root, 'helper-runs')}'\necho '{"error":"usage: vision-ocr <imagePath> | pdf-text <pdfPath> | pdf-rasterize <pdfPath> <outDir> [dpi]"}' >&2\nexit 2\n`;
    fs.writeFileSync(b.files.helper, good, { mode: 0o755 });
    expect(b.run('BOTBOY_TEST_OCR_REBUILD').stdout).toBe('');
    expect(b.hasMarker()).toBe(false);
  });
});

onMac('quarantine: a flagged helper is cleared before its first run, and never run while the flag stays', () => {
  it('the strip does two cheap checks when nothing is flagged and changes nothing', () => {
    const b = box();
    const result = b.run('BOTBOY_TEST_NATIVE_STRIP');
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('native-strip-done');
    expect(b.xattrCalls().every((call) => call.startsWith('-p com.apple.quarantine '))).toBe(true);
    expect(b.xattrCalls().length).toBeLessThanOrEqual(2);
    expect(b.logText()).toBe('');
  });

  it('a flagged prebuilt makes the strip clear the whole native/ folder once and log one line', () => {
    const b = box({ flagged: true });
    const result = b.run('BOTBOY_TEST_NATIVE_STRIP');
    expect(result.status).toBe(0);
    const calls = b.xattrCalls();
    expect(calls[0]).toMatch(/^-p com\.apple\.quarantine .*native\/vision-ocr\/prebuilt\/vision-ocr$/);
    expect(calls.some((call) => call.startsWith('-r -d com.apple.quarantine ') && call.endsWith('/native'))).toBe(true);
    expect(b.flagState()).toBe('none');
    expect(b.logText()).toBe("Cleared the download mark on BotBoy's helpers\n");
    expect(b.helperRuns()).toBe(0); // clearing never runs the helper
  });

  it('says so in the log, with the manual command, when the flag could not be cleared', () => {
    const b = box({ flagged: true, stuck: true });
    b.run('BOTBOY_TEST_NATIVE_STRIP');
    expect(b.logText()).toMatch(/^Could not clear the download mark on BotBoy's helpers; OCR stays off until it is cleared: xattr -r -d com\.apple\.quarantine ".*\/native"\n$/);
  });

  it('the strip is best effort: a tool that fails does not fail the start', () => {
    const b = box({ flagged: true, stuck: true });
    const result = b.run('BOTBOY_TEST_NATIVE_STRIP');
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('native-strip-done');
    expect(b.flagState()).toBe('flagged');
  });

  it('the job clears a flagged helper and then runs it once', () => {
    const b = box({ flagged: true });
    const result = b.run('BOTBOY_TEST_OCR_REBUILD');
    expect(result.stdout).toBe('');
    expect(b.flagState()).toBe('none');
    expect(b.helperRuns()).toBe(1);
    expect(b.xattrCalls().map((call) => call.split(' ')[0])).toEqual(['-p', '-d', '-p']);
  });

  it('a flag that cannot be cleared: the helper is never run, one sentence with the manual command, remembered', () => {
    const b = box({ flagged: true, stuck: true });
    const first = b.run('BOTBOY_TEST_OCR_REBUILD');
    expect(first.stdout).toContain("OCR is off: macOS marked BotBoy's reader as downloaded from the internet and the mark could not be cleared.");
    expect(first.stdout).toContain('xattr -r -d com.apple.quarantine');
    expect(first.stdout).toContain('./start.sh --rebuild-ocr');
    expect(b.helperRuns()).toBe(0);
    expect(b.readMarker()).toMatchObject({ kind: 'unavailable', reasonCode: 'quarantined' });
    expect(b.run('BOTBOY_TEST_OCR_REBUILD').stdout).toBe('');
    expect(b.helperRuns()).toBe(0);
  });

  it('the doctor reports a flagged helper and changes nothing (it is read-only)', () => {
    const b = box({ flagged: true });
    const out = b.run('BOTBOY_TEST_DOCTOR_TOOLCHAIN').stdout;
    expect(out).toContain("ocr helper: OFF, the download mark is still on BotBoy's reader; ./start.sh clears it");
    expect(b.flagState()).toBe('flagged');
    expect(b.helperRuns()).toBe(0);
    expect(b.xattrCalls().every((call) => call.startsWith('-p '))).toBe(true);
  });
});

describe('start.sh structure (this change)', () => {
  const lines = launcherText.split('\n');
  const code = lines.map((text, index) => ({ text, number: index + 1 })).filter(({ text }) => !text.trim().startsWith('#'));

  it('clears the download mark before the dependency self-heal in the start flow, and only there', () => {
    const calls = code.filter(({ text }) => /^\s*strip_native_download_mark\s*$/.test(text));
    // the hook call and the one real call
    expect(calls).toHaveLength(2);
    // The last bare call is the real one in the start flow (the first sits inside the BOTBOY_TEST_HEAL_DEPS hook).
    const heals = code.filter(({ text }) => /^heal_missing_npm_dependencies$/.test(text.trim()));
    expect(heals).toHaveLength(2);
    expect(calls[1].number).toBeLessThan(heals[1].number);
    expect(heals[1].number - calls[1].number).toBeLessThan(3); // directly before it
    // The doctor, --stop, --open-window and --rebuild-ocr blocks exit before that line.
    const exits = ['if [ "$DOCTOR" = "1" ]', 'if [ "$STOP_ONLY" = "1" ]', 'if [ "$OPEN_WINDOW_ONLY" = "1" ]', 'if [ "$REBUILD_OCR" = "1" ]'];
    for (const marker of exits) {
      const at = launcherText.indexOf(marker);
      expect(at, marker).toBeGreaterThan(0);
      expect(launcherText.slice(0, at).split('\n').length, marker).toBeLessThan(calls[1].number);
    }
  });

  it('the shell never decides whether OCR works: no file-time gate, no CLT gate, no OCR note of its own', () => {
    expect(launcherText).not.toMatch(/ocr_helper_current|print_ocr_note|OCR_BIN/);
    const worker = launcherText.slice(launcherText.indexOf('rebuild_ocr_helper_if_needed() {'), launcherText.indexOf('start_ocr_helper_job() {'));
    expect(worker).not.toMatch(/clt_installed|clt_toolchain_ok|swiftc|xcrun/);
    expect(launcherText).toMatch(/scripts\/bootstrap-deps\.mjs" --ocr-status/);
  });

  it('uses only a real OS tool for the flag (xattr), reached through a variable the tests can replace', () => {
    expect(launcherText).toContain('XATTR_BIN="${BOTBOY_TEST_XATTR_BIN:-/usr/bin/xattr}"');
    expect(code.filter(({ text }) => /\bxattr\b/.test(text) && !text.includes('XATTR_BIN') && !/^\s*echo\b/.test(text)).map(({ text }) => text.trim())).toEqual([]);
  });
});
