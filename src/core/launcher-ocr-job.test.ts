/**
 * start.sh and the optional OCR helper (Maria's Mac, 2026-10-13: a Command Line
 * Tools / SDK mismatch made `swiftc` fail, and every start compiled and failed
 * again BEFORE the server and window, so opening BotBoy "took ages").
 *
 * The helper is an extra: its build must never hold up a start. It runs after
 * the dashboard window is open, as a detached job with a hard time limit; a
 * failure is remembered per machine and printed once. Every case here uses
 * fake `xcode-select`/`xcrun`/`sw_vers`/`swiftc` programs and a private HOME
 * (the remembered failure lives under it), and exits through a test hook before
 * the real start flow, so it cannot touch a running BotBoy.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Several cases wait on a fake compiler that sleeps or times out.
vi.setConfig({ testTimeout: 60_000 });

const launcherPath = fileURLToPath(new URL('../../start.sh', import.meta.url));
const bootstrapPath = fileURLToPath(new URL('../../scripts/bootstrap-deps.mjs', import.meta.url));
const nativePrebuiltPath = fileURLToPath(new URL('../../scripts/native-prebuilt.mjs', import.meta.url));
const launcherText = fs.readFileSync(launcherPath, 'utf8');
const roots: string[] = [];
afterEach(() => {
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

const OFF_NOTE_START = 'Text reading from images and scanned PDFs (OCR) is off: the Swift tools on this Mac cannot build BotBoy\'s helper';
const OFF_NOTE = `${OFF_NOTE_START} (usually the Command Line Tools and macOS versions do not match). BotBoy works fine without it. To enable it, update macOS and the Command Line Tools in System Settings > General > Software Update, then run ./start.sh --rebuild-ocr.`;
// The build itself (scripts/bootstrap-deps.mjs) only runs on macOS; the text checks run anywhere.
const onMac = describe.runIf(process.platform === 'darwin');
const sleepMs = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

type Swiftc = { version?: string; body: string };

function box() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'botboy-ocrjob-'));
  roots.push(root);
  const dir = path.join(root, 'app');
  const stubs = path.join(root, 'stubs');
  const home = path.join(root, 'home');
  for (const d of [path.join(dir, 'scripts'), path.join(dir, 'native', 'vision-ocr'), stubs, home]) fs.mkdirSync(d, { recursive: true });
  fs.copyFileSync(launcherPath, path.join(dir, 'start.sh'));
  fs.copyFileSync(bootstrapPath, path.join(dir, 'scripts', 'bootstrap-deps.mjs'));
  // The resolver bootstrap-deps.mjs runs first. This harness has no manifest, so it answers "no prebuilt" and the
  // compile path below is what is under test (prebuilt cases: launcher-prebuilt-ocr.test.ts).
  fs.copyFileSync(nativePrebuiltPath, path.join(dir, 'scripts', 'native-prebuilt.mjs'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x' }));
  const source = path.join(dir, 'native', 'vision-ocr', 'main.swift');
  fs.writeFileSync(source, '// stub\n');
  const helper = path.join(dir, 'native', 'vision-ocr', 'bin', 'vision-ocr');
  const log = path.join(root, 'launcher.log');
  const calls = path.join(root, 'swiftc-calls');
  const marker = path.join(home, '.personal-productivity-tracker', 'ocr-helper-build.json');
  const write = (name: string, body: string) => {
    const file = path.join(stubs, name);
    fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    return file;
  };
  const xcodeSelect = write('xcode-select', 'echo /stub/clt');
  const xcrun = write('xcrun', `case "$1" in --show-sdk-path) echo /stub/sdk;; --find) echo '${path.join(stubs, 'swiftc')}';; esac`);
  const swVers = write('sw_vers', 'echo 24A335');
  /** Install the fake compiler. Every compile (not `--version`) appends a line to `calls`. */
  const swiftc = ({ version = 'Fake Swift version 1.0 (fake-1)', body }: Swiftc) =>
    write('swiftc', `case "$1" in --version) echo '${version}'; echo 'Target: arm64-apple-macosx15.0'; exit 0;; esac\necho x >> '${calls}'\n${body}`);
  const compiles = () => (fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').split('\n').filter(Boolean).length : 0);
  const env = (extra: Record<string, string> = {}) => {
    const base: Record<string, string | undefined> = { ...process.env };
    for (const key of ['BOTBOY_NATIVE_REEXEC', 'BOTBOY_REEXEC_FROM', 'BOTBOY_OCR_BUILD_TIMEOUT_SECONDS', 'BOTBOY_DEFER_OCR_BUILD', 'npm_lifecycle_event']) delete base[key];
    return {
      ...base,
      HOME: home,
      PPT_LOG_FILE: log,
      BOTBOY_NO_ARCH_REEXEC: '1',
      BOTBOY_TEST_XCODE_SELECT_BIN: xcodeSelect,
      BOTBOY_TEST_XCRUN_BIN: xcrun,
      BOTBOY_TEST_SW_VERS_BIN: swVers,
      ...extra,
    } as Record<string, string>;
  };
  /** Run start.sh once, optionally through a hook, optionally with arguments. */
  const run = (hook: string | null, extra: Record<string, string> = {}, args: string[] = []) => {
    const started = Date.now();
    const result = spawnSync('/bin/bash', [path.join(dir, 'start.sh'), ...args], {
      cwd: dir,
      env: env({ ...(hook ? { [hook]: '1' } : {}), ...extra }),
      encoding: 'utf8',
      timeout: 45_000,
    });
    return { ...result, ms: Date.now() - started };
  };
  const logText = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '');
  const readMarker = () => JSON.parse(fs.readFileSync(marker, 'utf8')) as {
    kind: string; failedAt: string; durationMs: number; reason: string; signature: { source: string; swiftc: string; osBuild: string };
  };
  const waitForMarker = (ms = 20_000) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline && !fs.existsSync(marker)) sleepMs(100);
    return fs.existsSync(marker);
  };
  const buildHelper = () => {
    fs.mkdirSync(path.dirname(helper), { recursive: true });
    fs.writeFileSync(helper, '#!/bin/sh\necho helper\n', { mode: 0o755 });
    const future = new Date(Date.now() + 60_000);
    fs.utimesSync(helper, future, future);
  };
  return { root, dir, stubs, home, source, helper, log, marker, calls, write, swiftc, compiles, env, run, logText, readMarker, waitForMarker, buildHelper };
}

/** A compiler that fails the way Maria's did: an error line, then a flood of diagnostics. */
const FAILING_FLOOD: Swiftc = {
  body: [
    'echo "error: failed to build module \'Swift\'; this SDK is not supported by the compiler" >&2',
    'i=1; while [ $i -le 300 ]; do echo "/Library/Developer/CommandLineTools/usr/include/swift/module.modulemap: 0: diagnostic $i" >&2; i=$((i+1)); done',
    'exit 1',
  ].join('\n'),
};
const SUCCEEDS: Swiftc = {
  body: 'out=""; while [ $# -gt 0 ]; do [ "$1" = "-o" ] && out="$2"; shift; done\nprintf \'#!/bin/sh\\necho helper\\n\' > "$out"\nchmod +x "$out"\nexit 0',
};

onMac('start.sh › OCR helper job: a failing swiftc', () => {
  it('prints the one calm note, no "rebuild failed" line, and keeps the compiler output to 20 + 5 lines', () => {
    const b = box();
    b.swiftc(FAILING_FLOOD);
    const result = b.run('BOTBOY_TEST_OCR_REBUILD');
    expect(result.status).toBe(0);
    // The terminal gets the calm note, exactly once (R3), and nothing else.
    expect(result.stdout.split(OFF_NOTE).length - 1).toBe(1);
    expect(result.stdout.trim().split('\n')).toHaveLength(1);
    expect(result.stdout).not.toContain('OCR helper rebuild failed');
    // The log gets the compiler output cut to its first 20 and last 5 lines, plus one summary line.
    const log = b.logText();
    const diagnostics = log.split('\n').filter((line) => line.includes('module.modulemap'));
    expect(diagnostics).toHaveLength(24); // 19 head lines after the error line + 5 tail lines
    expect(log).toContain('diagnostic 300');
    expect(log).not.toContain('diagnostic 100');
    expect(log).toMatch(/OCR helper build failed after [\d.]+ s \(error: failed to build module 'Swift'; this SDK is not supported by the compiler\)/);
    expect(log).toContain('[compiler output: 301 lines, showing the first 20 and the last 5]');
    expect(log.trim().split('\n').length).toBeLessThanOrEqual(28); // building + 20 + 5 + summary + the calm note
    expect(b.compiles()).toBe(1);
  });

  it('remembers the failure with its signature, duration, and a one-line reason', () => {
    const b = box();
    b.swiftc(FAILING_FLOOD);
    b.run('BOTBOY_TEST_OCR_REBUILD');
    const marker = b.readMarker();
    expect(marker).toMatchObject({ kind: 'failed', reason: "error: failed to build module 'Swift'; this SDK is not supported by the compiler" });
    expect(Number.isFinite(Date.parse(marker.failedAt))).toBe(true);
    expect(marker.durationMs).toBeGreaterThanOrEqual(0);
    expect(marker.signature.source).toMatch(/^[0-9a-f]{64}$/);
    expect(marker.signature.swiftc).toBe('Fake Swift version 1.0 (fake-1)');
    expect(marker.signature.osBuild).toBe('24A335');
    expect(fs.statSync(b.marker).mode & 0o777).toBe(0o600);
    expect(fs.existsSync(b.helper)).toBe(false);
  });

  it('does not try again while the source, compiler, and macOS build are unchanged, and says nothing', () => {
    const b = box();
    b.swiftc(FAILING_FLOOD);
    b.run('BOTBOY_TEST_OCR_REBUILD');
    const logAfterFirst = b.logText();
    for (let start = 0; start < 3; start++) {
      const again = b.run('BOTBOY_TEST_OCR_REBUILD');
      expect(again.status).toBe(0);
      expect(again.stdout).toBe('');
    }
    expect(b.compiles()).toBe(1);
    expect(b.logText()).toBe(logAfterFirst);
  });

  it('tries again when the Swift compiler changes, and only then prints a new note', () => {
    const b = box();
    b.swiftc(FAILING_FLOOD);
    b.run('BOTBOY_TEST_OCR_REBUILD');
    b.swiftc({ ...FAILING_FLOOD, version: 'Fake Swift version 1.1 (fake-2)' });
    const retry = b.run('BOTBOY_TEST_OCR_REBUILD');
    expect(b.compiles()).toBe(2);
    expect(retry.stdout.split(OFF_NOTE).length - 1).toBe(1);
    expect(b.readMarker().signature.swiftc).toBe('Fake Swift version 1.1 (fake-2)');
    // ... and is quiet again at the next start.
    expect(b.run('BOTBOY_TEST_OCR_REBUILD').stdout).toBe('');
    expect(b.compiles()).toBe(2);
  });

  it('tries again when macOS is updated', () => {
    const b = box();
    b.swiftc(FAILING_FLOOD);
    b.run('BOTBOY_TEST_OCR_REBUILD');
    b.write('sw_vers', 'echo 24A999');
    b.run('BOTBOY_TEST_OCR_REBUILD');
    expect(b.compiles()).toBe(2);
    expect(b.readMarker().signature.osBuild).toBe('24A999');
  });

  it('tries again when a release changes the helper source', () => {
    const b = box();
    b.swiftc(FAILING_FLOOD);
    b.run('BOTBOY_TEST_OCR_REBUILD');
    const before = b.readMarker().signature.source;
    fs.appendFileSync(b.source, '// a new release\n');
    b.run('BOTBOY_TEST_OCR_REBUILD');
    expect(b.compiles()).toBe(2);
    expect(b.readMarker().signature.source).not.toBe(before);
  });

  it('--rebuild-ocr forces a retry although nothing changed, shows the result, and exits 1 while it still fails', () => {
    const b = box();
    b.swiftc(FAILING_FLOOD);
    b.run('BOTBOY_TEST_OCR_REBUILD');
    expect(b.compiles()).toBe(1);
    const forced = b.run(null, {}, ['--rebuild-ocr']);
    expect(b.compiles()).toBe(2);
    expect(forced.status).toBe(1);
    expect(forced.stdout).toContain('Checking the OCR helper');
    expect(forced.stdout).toContain('module.modulemap'); // the owner asked, so the (cut-down) detail is shown
    expect(forced.stdout.split(OFF_NOTE).length - 1).toBe(1);
  });

  it('--rebuild-ocr builds the helper, deletes the remembered failure, and the next start is quiet', () => {
    const b = box();
    b.swiftc(FAILING_FLOOD);
    b.run('BOTBOY_TEST_OCR_REBUILD');
    expect(fs.existsSync(b.marker)).toBe(true);
    b.swiftc(SUCCEEDS);
    const forced = b.run(null, {}, ['--rebuild-ocr']);
    expect(forced.status).toBe(0);
    expect(forced.stdout).toContain('✅ OCR helper ready (local build, current (compiled on this Mac))');
    expect(fs.existsSync(b.marker)).toBe(false);
    expect(fs.statSync(b.helper).mode & 0o111).not.toBe(0);
    const compilesBefore = b.compiles();
    expect(b.run('BOTBOY_TEST_OCR_REBUILD').stdout).toBe('');
    expect(b.compiles()).toBe(compilesBefore);
  });

  it('a successful automatic build leaves no marker and says nothing on the terminal', () => {
    const b = box();
    b.swiftc(SUCCEEDS);
    const result = b.run('BOTBOY_TEST_OCR_REBUILD');
    expect(result.stdout).toBe('');
    expect(fs.existsSync(b.marker)).toBe(false);
    expect(fs.existsSync(b.helper)).toBe(true);
  });
});

onMac('start.sh › OCR helper job: a swiftc that hangs', () => {
  it('is stopped at the time limit, recorded as a timeout, and its detached children go with it', () => {
    const b = box();
    const uniqueSleep = 7000 + Math.floor(Math.random() * 2000);
    // A background child that would outlive the compiler if only the compiler were killed.
    b.swiftc({ body: `echo "compiling..." >&2\nsleep ${uniqueSleep} &\nwait` });
    const result = b.run('BOTBOY_TEST_OCR_REBUILD', { BOTBOY_OCR_BUILD_TIMEOUT_SECONDS: '1' });
    expect(result.status).toBe(0);
    expect(result.ms).toBeLessThan(15_000);
    const marker = b.readMarker();
    expect(marker.kind).toBe('timeout');
    expect(marker.reason).toBe('the compiler did not finish in time');
    expect(marker.durationMs).toBeGreaterThanOrEqual(900);
    expect(marker.durationMs).toBeLessThan(10_000);
    expect(result.stdout.split(OFF_NOTE).length - 1).toBe(1);
    expect(b.logText()).toMatch(/OCR helper build failed after \d+(\.\d)? s \(the compiler did not finish in time\)/);
    expect(spawnSync('/usr/bin/pgrep', ['-f', `sleep ${uniqueSleep}`], { encoding: 'utf8' }).status).toBe(1);
    // A killed compile leaves no half-written helper and no staging folder.
    expect(fs.existsSync(b.helper)).toBe(false);
    const binDir = path.dirname(b.helper);
    expect(fs.existsSync(binDir) ? fs.readdirSync(binDir) : []).toEqual([]);
  });

  it('a remembered timeout is not retried either', () => {
    const b = box();
    b.swiftc({ body: 'sleep 30' });
    b.run('BOTBOY_TEST_OCR_REBUILD', { BOTBOY_OCR_BUILD_TIMEOUT_SECONDS: '1' });
    const again = b.run('BOTBOY_TEST_OCR_REBUILD', { BOTBOY_OCR_BUILD_TIMEOUT_SECONDS: '1' });
    expect(again.ms).toBeLessThan(10_000);
    expect(again.stdout).toBe('');
    expect(b.compiles()).toBe(1);
  });
});

onMac('start.sh › startup does not wait for the OCR helper', () => {
  it('the kickoff returns at once while a slow compile keeps running, and the job finishes later on its own', () => {
    const b = box();
    b.swiftc({ body: 'sleep 6\necho "error: boom" >&2\nexit 1' });
    const kickoff = b.run('BOTBOY_TEST_OCR_JOB');
    expect(kickoff.status).toBe(0);
    expect(kickoff.stdout.trim()).toBe('ocr-job-kicked-off');
    // The marker is written only when the compile ends, about 6 s after it began.
    expect(fs.existsSync(b.marker)).toBe(false);
    expect(b.waitForMarker()).toBe(true);
    const jobMs = b.readMarker().durationMs;
    expect(jobMs).toBeGreaterThanOrEqual(5500);
    expect(kickoff.ms).toBeLessThan(jobMs); // start.sh was done before the compile was
    expect(b.logText()).toContain('error: boom');
  });

  it('does nothing visible when the helper is already built and current (the job still checks, silently)', () => {
    const b = box();
    b.swiftc(FAILING_FLOOD);
    b.buildHelper();
    const kickoff = b.run('BOTBOY_TEST_OCR_JOB');
    sleepMs(1500);
    expect(kickoff.stdout.trim()).toBe('ocr-job-kicked-off');
    expect(b.compiles()).toBe(0);
    expect(fs.existsSync(b.marker)).toBe(false);
    expect(b.logText()).toBe('');
  });

  it('a Mac without Command Line Tools and without a usable helper gets ONE reason line (it names the next action), no compiler, and silence afterwards', () => {
    // This harness has no prebuilt manifest (a damaged or very old checkout), so the reason is the missing reader.
    // With a valid prebuilt there is nothing to say at all: launcher-prebuilt-ocr.test.ts.
    const b = box();
    b.swiftc(FAILING_FLOOD);
    const noClt = b.write('xcode-select', 'exit 2');
    const result = b.run('BOTBOY_TEST_OCR_REBUILD', { BOTBOY_TEST_XCODE_SELECT_BIN: noClt });
    expect(result.stdout.trim()).toBe("ℹ  OCR is off: BotBoy's prebuilt reader is missing from this folder. Run ./start.sh --update to restore it.");
    expect(result.stdout).not.toContain('Command Line Tools with `xcode-select --install`');
    expect(b.compiles()).toBe(0);
    expect(b.readMarker()).toMatchObject({ kind: 'unavailable', reasonCode: 'manifest_missing' });
    expect(b.run('BOTBOY_TEST_OCR_REBUILD', { BOTBOY_TEST_XCODE_SELECT_BIN: noClt }).stdout).toBe('');
  });

  it('the job holds no pipe open for a caller that waits for end of output', () => {
    const b = box();
    b.swiftc({ body: 'sleep 6\nexit 1' });
    // spawnSync waits for EOF on its stdout pipe. If the job inherited that pipe,
    // this call would last as long as the compile.
    const kickoff = b.run('BOTBOY_TEST_OCR_JOB');
    expect(b.waitForMarker()).toBe(true);
    expect(kickoff.ms).toBeLessThan(b.readMarker().durationMs);
  });

  it('start.sh\'s process discovery (what a takeover or --stop would signal) never finds the job', () => {
    const b = box();
    b.swiftc({ body: 'sleep 3\nexit 1' });
    b.run('BOTBOY_TEST_OCR_JOB');
    sleepMs(700); // the job is compiling now
    const discovered = b.run('BOTBOY_TEST_DISCOVER_TRACKER_PIDS', { PPT_PID_FILE: path.join(b.root, 'ppt.pid') });
    const pids = discovered.stdout.split('\n').map((line) => line.trim()).filter((line) => /^\d+$/.test(line));
    for (const pid of pids) {
      const command = spawnSync('/bin/ps', ['-ww', '-o', 'command=', '-p', pid], { encoding: 'utf8' }).stdout;
      expect(command).not.toMatch(/bootstrap-deps|start\.sh|swiftc/);
    }
    expect(b.waitForMarker()).toBe(true);
  });
});

describe('start.sh › OCR helper job: structure', () => {
  it('starts the job only after the window is open, in both start flows, and nothing OCR runs before the build', () => {
    const lines = launcherText.split('\n');
    const code = lines.map((text, index) => ({ text, number: index + 1 })).filter(({ text }) => !text.trim().startsWith('#'));
    const allCalls = code.filter(({ text }) => /^\s*start_ocr_helper_job\s*$/.test(text));
    const windows = code.filter(({ text }) => text.includes('open_dashboard_window fresh "$SERVER_PID"'));
    expect(allCalls).toHaveLength(3);
    expect(windows).toHaveLength(2);
    // The first call is the test hook; it runs before any real start flow.
    const [hook, ...calls] = allCalls;
    expect(hook.number).toBeLessThan(windows[0].number);
    // Foreground (BotBoy.app) flow, then background (CLI) flow; each job call follows its window.
    expect(windows[0].number).toBeLessThan(calls[0].number);
    expect(calls[0].number).toBeLessThan(windows[1].number);
    expect(windows[1].number).toBeLessThan(calls[1].number);
    // Between the dependency self-heal and the first server spawn (the old place of the
    // synchronous rebuild) there is no OCR work at all.
    const healAt = launcherText.indexOf('\nheal_missing_npm_dependencies\n');
    const spawnAt = launcherText.search(/"\$NODE" dist\/index\.js/);
    expect(healAt).toBeGreaterThan(0);
    expect(spawnAt).toBeGreaterThan(healAt);
    expect(launcherText.slice(healAt, spawnAt).split('\n').filter((line) => !line.trim().startsWith('#')).join('\n'))
      .not.toMatch(/rebuild_ocr_helper_if_needed|start_ocr_helper_job|bootstrap-deps/);
    // The worker is called only by the detached job, the --rebuild-ocr mode, and the test hook.
    const workerCalls = code.filter(({ text }) => /^\s*rebuild_ocr_helper_if_needed\s/.test(text)).map(({ text }) => text.trim());
    expect(workerCalls).toEqual([
      'rebuild_ocr_helper_if_needed background',
      'rebuild_ocr_helper_if_needed "${BOTBOY_TEST_OCR_MODE:-background}"',
      'rebuild_ocr_helper_if_needed force',
    ]);
  });

  it('the job touches no lock, PID file, safety block, receipt, or signal of the launcher', () => {
    const worker = launcherText
      .slice(launcherText.indexOf('rebuild_ocr_helper_if_needed() {'), launcherText.indexOf('# The remembered BUILD failure of the last OCR helper build'))
      .split('\n').filter((line) => !line.trim().startsWith('#')).join('\n'); // code only: the comments explain these very things
    expect(worker.length).toBeGreaterThan(500);
    expect(worker).not.toMatch(/PID_FILE|STARTUP_SAFETY_BLOCK|LOCK_DIR|SHUTDOWN_RECEIPT_DIR|stop_existing_server|safe_takeover|stop_startup_child|release_start_lock|kill |\bwait\b|pkill|pgrep/);
    // Detached: HUP ignored, no input, never waited for, output only to a terminal.
    expect(worker).toContain("trap '' HUP");
    expect(worker).toContain('exec </dev/null');
    expect(worker).toContain('[ -t 1 ] || exec >/dev/null');
    expect(worker).toMatch(/\) &\n\s+return 0/);
  });
});

onMac('start.sh › --rebuild-ocr', () => {
  it('is documented in the header and exits before the Chrome and credential steps', () => {
    const header = launcherText.slice(0, launcherText.indexOf('FOREGROUND=0'));
    expect(header).toContain('./start.sh --rebuild-ocr');
    expect(header).toContain('BOTBOY_OCR_BUILD_TIMEOUT_SECONDS');
    const mode = launcherText.indexOf('if [ "$REBUILD_OCR" = "1" ]; then');
    expect(mode).toBeGreaterThan(0);
    expect(mode).toBeLessThan(launcherText.indexOf('# 1. Start debug Chrome if not already running'));
    expect(mode).toBeLessThan(launcherText.indexOf('import-credentials.sh'));
  });

  it('with the helper already built and current, says so without a compile when nothing is wrong', () => {
    const b = box();
    b.swiftc(FAILING_FLOOD);
    b.buildHelper();
    const result = b.run(null, {}, ['--rebuild-ocr']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('✅ OCR helper ready (local build, current (compiled on this Mac))');
    expect(b.compiles()).toBe(0);
  });

  it('on a Mac without Command Line Tools and without a usable helper names the reason and the next action, and exits 1', () => {
    const b = box();
    const noClt = b.write('xcode-select', 'exit 2');
    const result = b.run(null, { BOTBOY_TEST_XCODE_SELECT_BIN: noClt }, ['--rebuild-ocr']);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("BotBoy's prebuilt reader is missing from this folder. Run ./start.sh --update");
    expect(result.stdout).toContain('ocr helper: OFF');
    expect(b.compiles()).toBe(0);
  });

  it('names the problem when scripts/bootstrap-deps.mjs is missing, and exits 1', () => {
    const b = box();
    fs.rmSync(path.join(b.dir, 'scripts', 'bootstrap-deps.mjs'));
    const result = b.run(null, {}, ['--rebuild-ocr']);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('scripts/bootstrap-deps.mjs is missing');
    // A normal start says nothing about it.
    expect(b.run('BOTBOY_TEST_OCR_REBUILD').stdout).toBe('');
  });

  it('with no helper source and no prebuilt in the checkout, cannot build anything and says how to restore it', () => {
    const b = box();
    b.swiftc(SUCCEEDS);
    fs.rmSync(b.source);
    const result = b.run(null, {}, ['--rebuild-ocr']);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("BotBoy's prebuilt reader is missing from this folder. Run ./start.sh --update");
    expect(b.compiles()).toBe(0);
  });
});

onMac('start.sh › doctor rows after a failed OCR build', () => {
  const rows = (b: ReturnType<typeof box>) => b.run('BOTBOY_TEST_DOCTOR_TOOLCHAIN', { TZ: 'UTC' }).stdout;

  it('says what failed, when, after how long, and why, and stops telling the owner to run ./start.sh', () => {
    const b = box();
    b.swiftc(FAILING_FLOOD);
    b.run('BOTBOY_TEST_OCR_REBUILD');
    const marker = b.readMarker();
    fs.writeFileSync(b.marker, JSON.stringify({ schema: 1, ...marker, failedAt: '2026-10-12T16:26:47.000Z', durationMs: 4213 }));
    const out = rows(b);
    expect(out).toContain(
      "xcode-clt: installed (swiftc found); OCR helper build failed on 2026-10-12 after 4.2 s: error: failed to build module 'Swift'; this SDK is not supported by the compiler",
    );
    expect(out).toContain('ocr helper: OFF, ');
    expect(out).toContain('pdf readers: vision-ocr helper off (images and scanned PDFs unavailable; see the ocr helper row);');
    expect(out).not.toContain('tools present; run ./start.sh');
  });

  it('rounds long attempts to whole seconds', () => {
    const b = box();
    fs.mkdirSync(path.dirname(b.marker), { recursive: true });
    fs.writeFileSync(b.marker, JSON.stringify({
      schema: 1, kind: 'timeout', failedAt: '2026-10-12T16:26:47.000Z', durationMs: 120_040, reason: 'the compiler did not finish in time',
      signature: { source: 'a', swiftc: 'b', osBuild: 'c' },
    }));
    expect(rows(b)).toContain('xcode-clt: installed (swiftc found); OCR helper build failed on 2026-10-12 after 120 s: the compiler did not finish in time');
  });

  it('keeps today\'s rows when no failure is remembered, or the file is corrupt', () => {
    const b = box();
    expect(rows(b)).toContain('xcode-clt: installed (swiftc found)\n');
    expect(rows(b)).toContain('pdf readers: vision-ocr helper off (images and scanned PDFs unavailable; see the ocr helper row);');
    fs.mkdirSync(path.dirname(b.marker), { recursive: true });
    fs.writeFileSync(b.marker, '{ this is not json');
    expect(rows(b)).toContain('xcode-clt: installed (swiftc found)\n');
    expect(rows(b)).toContain('pdf readers: vision-ocr helper off (images and scanned PDFs unavailable; see the ocr helper row);');
  });

  it('keeps an older helper in use beside a failed rebuild: it still works, and the failure is still shown', () => {
    const b = box();
    b.swiftc(FAILING_FLOOD);
    b.run('BOTBOY_TEST_OCR_REBUILD');
    // A local build made before main.swift last changed: usable, not current.
    fs.mkdirSync(path.dirname(b.helper), { recursive: true });
    fs.writeFileSync(b.helper, '#!/bin/sh\necho helper\n', { mode: 0o755 });
    const past = new Date(Date.now() - 3_600_000);
    fs.utimesSync(b.helper, past, past);
    const out = rows(b);
    expect(out).toContain('ocr helper: local build, older than main.swift in this folder; it still works');
    expect(out).toContain('pdf readers: vision-ocr helper (local build);');
    expect(out).toContain('xcode-clt: installed (swiftc found); OCR helper build failed on');
  });

  it('does not repeat an old failure while a current helper is in use', () => {
    const b = box();
    b.swiftc(FAILING_FLOOD);
    b.run('BOTBOY_TEST_OCR_REBUILD');
    b.buildHelper();
    const out = rows(b);
    expect(out).toContain('ocr helper: local build, current (compiled on this Mac)');
    expect(out).toContain('xcode-clt: installed (swiftc found)\n');
    expect(out).not.toContain('build failed');
  });

  it('leaves the missing-tools rows alone', () => {
    const b = box();
    b.swiftc(FAILING_FLOOD);
    b.run('BOTBOY_TEST_OCR_REBUILD');
    const noClt = b.write('xcode-select', 'exit 2');
    const out = b.run('BOTBOY_TEST_DOCTOR_TOOLCHAIN', { BOTBOY_TEST_XCODE_SELECT_BIN: noClt }).stdout;
    // F-E: the tools are optional now; the row no longer claims OCR needs them.
    expect(out).toContain("xcode-clt: not installed (optional: BotBoy's helpers ship prebuilt; the tools are needed only for Node 20's database module, for git, and to build a helper from source)");
    expect(out).not.toContain('cannot read text inside images');
    expect(out).toContain('pdf readers: vision-ocr helper off (images and scanned PDFs unavailable; see the ocr helper row);');
  });
});

onMac('start.sh › its own npm install does not compile the OCR helper', () => {
  it('sets BOTBOY_DEFER_OCR_BUILD for the dependency install and for the native module reinstall', () => {
    const b = box();
    fs.writeFileSync(path.join(b.dir, 'package.json'), JSON.stringify({ name: 'x', dependencies: { alpha: '1.0.0' } }));
    const seen = path.join(b.root, 'npm-env');
    const npm = b.write('npm', `echo "defer=$BOTBOY_DEFER_OCR_BUILD" >> '${seen}'\nmkdir -p node_modules/alpha\necho '{"version":"1.0.0"}' > node_modules/alpha/package.json`);
    b.run('BOTBOY_TEST_HEAL_DEPS', { BOTBOY_TEST_NPM_BIN: npm });
    expect(fs.readFileSync(seen, 'utf8').trim()).toBe('defer=1');
    // The native-module reinstall in the start flow, read from the script itself.
    const reinstall = launcherText.slice(launcherText.indexOf('Reinstalling native modules'), launcherText.indexOf('Native modules reinstalled'));
    expect(reinstall).toContain('export BOTBOY_DEFER_OCR_BUILD=1');
  });
});
