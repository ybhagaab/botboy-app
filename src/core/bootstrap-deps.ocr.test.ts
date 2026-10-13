/**
 * scripts/bootstrap-deps.mjs and the optional OCR helper: the hard compile
 * time limit, the remembered failure (one documented marker file), the cut-down
 * compiler output, and who retries a remembered failure. Pure helpers are
 * imported; the script itself runs against a copy of a checkout with fake
 * `xcode-select`/`xcrun`/`sw_vers`/`swiftc` programs and a private HOME, so it
 * can never touch the real home folder or a running BotBoy.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: 60_000 });

const bootstrapPath = fileURLToPath(new URL('../../scripts/bootstrap-deps.mjs', import.meta.url));
const bootstrapUrl = pathToFileURL(bootstrapPath).href;
const roots: string[] = [];
afterEach(() => {
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

type Signature = { source: string; swiftc: string; osBuild: string };
type Marker = { schema: number; kind: string; failedAt: string; durationMs: number | null; reason: string; signature: Signature };
type Mod = {
  ocrBuildTimeoutMs: (env?: Record<string, string | undefined>) => number;
  excerptCompilerOutput: (text: string, head?: number, tail?: number) => { lines: string[]; total: number; omitted: number };
  firstErrorLine: (text: string) => string;
  formatSeconds: (ms: number) => string;
  ocrBuildFailedNote: (firstLine: string, extra?: { durationMs?: number }) => string;
  ocrOffNote: () => string;
  ocrMarkerPath: (home?: string) => string;
  readOcrMarker: (options?: { file?: string }) => Marker | null;
  writeOcrMarker: (marker: Omit<Marker, 'schema'>, options?: { file?: string }) => boolean;
  clearOcrMarker: (options?: { file?: string }) => void;
  ocrMarkerDoctorText: (marker: Marker) => string;
  sameOcrSignature: (a: Signature | null, b: Signature | null) => boolean;
  computeOcrSignature: (swiftc: string, deps?: { run?: (file: string, args: string[], opts?: unknown) => unknown; source?: string }) => Signature;
  acquireOcrBuildLock: (options?: { dir?: string; maxAgeMs: number; now?: () => number }) => { ok: boolean; release?: () => void; ageMs?: number };
};
const load = () => import(/* @vite-ignore */ bootstrapUrl) as Promise<Mod>;

const tempDir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'botboy-bootocr-'));
  roots.push(dir);
  return dir;
};
const SIGNATURE: Signature = { source: 'a'.repeat(64), swiftc: 'Apple Swift version 6.0', osBuild: '24A335' };
const MARKER = { kind: 'failed', failedAt: '2026-10-12T16:26:47.000Z', durationMs: 4213, reason: 'error: boom', signature: SIGNATURE };

describe('ocrBuildTimeoutMs', () => {
  it('defaults to 120 seconds and honors BOTBOY_OCR_BUILD_TIMEOUT_SECONDS', async () => {
    const { ocrBuildTimeoutMs } = await load();
    expect(ocrBuildTimeoutMs({})).toBe(120_000);
    expect(ocrBuildTimeoutMs({ BOTBOY_OCR_BUILD_TIMEOUT_SECONDS: '300' })).toBe(300_000);
    expect(ocrBuildTimeoutMs({ BOTBOY_OCR_BUILD_TIMEOUT_SECONDS: '1.5' })).toBe(1500);
  });
  it('ignores values that are not a sensible number of seconds', async () => {
    const { ocrBuildTimeoutMs } = await load();
    for (const bad of ['', 'abc', '0', '-5', '0.1', '99999', 'Infinity', '12 s']) {
      expect(ocrBuildTimeoutMs({ BOTBOY_OCR_BUILD_TIMEOUT_SECONDS: bad }), bad).toBe(120_000);
    }
  });
});

describe('excerptCompilerOutput', () => {
  const flood = (count: number) => Array.from({ length: count }, (_, index) => `line ${index + 1}`).join('\n');
  it('keeps the first 20 and the last 5 lines of a long output', async () => {
    const { excerptCompilerOutput } = await load();
    const result = excerptCompilerOutput(flood(400));
    expect(result.total).toBe(400);
    expect(result.omitted).toBe(375);
    expect(result.lines).toHaveLength(25);
    expect(result.lines[0]).toBe('line 1');
    expect(result.lines[19]).toBe('line 20');
    expect(result.lines[20]).toBe('line 396');
    expect(result.lines[24]).toBe('line 400');
  });
  it('keeps a short output whole, drops blank lines and control characters, and caps a long line', async () => {
    const { excerptCompilerOutput } = await load();
    expect(excerptCompilerOutput(flood(25))).toMatchObject({ total: 25, omitted: 0 });
    expect(excerptCompilerOutput(flood(25)).lines).toHaveLength(25);
    expect(excerptCompilerOutput('a\n\n\r\nb\u0007\n\u001b[31mred\u001b[0m\n').lines).toEqual(['a', 'b', 'red']);
    expect(excerptCompilerOutput('x'.repeat(5000)).lines[0].length).toBeLessThanOrEqual(400);
    expect(excerptCompilerOutput('')).toEqual({ lines: [], total: 0, omitted: 0 });
  });
});

describe('firstErrorLine', () => {
  it('is the first line that reports an error, else the first line, as one short line', async () => {
    const { firstErrorLine } = await load();
    expect(firstErrorLine('note: something\n/x/main.swift:3:8: error: cannot find type\nerror: second')).toBe('/x/main.swift:3:8: error: cannot find type');
    expect(firstErrorLine('first\nsecond')).toBe('first');
    expect(firstErrorLine('')).toBe('');
    expect(firstErrorLine(`error: ${'y'.repeat(1000)}`).length).toBeLessThanOrEqual(240);
    expect(firstErrorLine('error:\ttabs\tand\u0007bells')).toBe('error: tabs and bells');
  });
});

describe('notes', () => {
  it('formats seconds as people read them and puts the duration in the summary line', async () => {
    const { formatSeconds, ocrBuildFailedNote } = await load();
    expect(formatSeconds(4213)).toBe('4.2');
    expect(formatSeconds(0)).toBe('0.0');
    expect(formatSeconds(9949)).toBe('9.9');
    expect(formatSeconds(57_300)).toBe('57');
    expect(formatSeconds(120_040)).toBe('120');
    expect(ocrBuildFailedNote('error: boom', { durationMs: 4213 })).toBe(
      'OCR helper build failed after 4.2 s (error: boom); BotBoy works without it except text from images and scanned PDFs',
    );
    expect(ocrBuildFailedNote('error: boom')).toContain('OCR helper build failed (error: boom)');
  });
  it('the calm note is exactly the agreed text', async () => {
    const { ocrOffNote } = await load();
    expect(ocrOffNote()).toBe(
      "Text reading from images and scanned PDFs (OCR) is off: the Swift tools on this Mac cannot build BotBoy's helper (usually the Command Line Tools and macOS versions do not match). BotBoy works fine without it. To enable it, update macOS and the Command Line Tools in System Settings > Software Update, then run ./start.sh --rebuild-ocr.",
    );
  });
});

describe('the OCR marker file', () => {
  it('lives outside the repo, in the private app folder', async () => {
    const { ocrMarkerPath } = await load();
    expect(ocrMarkerPath('/Users/someone')).toBe('/Users/someone/.personal-productivity-tracker/ocr-helper-build.json');
  });

  it('is written privately and atomically, read back whole, and deleted', async () => {
    const { writeOcrMarker, readOcrMarker, clearOcrMarker } = await load();
    const file = path.join(tempDir(), 'new-folder', 'ocr-helper-build.json');
    expect(writeOcrMarker(MARKER, { file })).toBe(true);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
    expect(fs.readdirSync(path.dirname(file))).toEqual(['ocr-helper-build.json']); // no temporary file left
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ schema: 1, ...MARKER });
    expect(Object.keys(JSON.parse(fs.readFileSync(file, 'utf8')))).toEqual(['schema', 'kind', 'failedAt', 'durationMs', 'reason', 'signature']);
    expect(readOcrMarker({ file })).toEqual({ schema: 1, ...MARKER });
    clearOcrMarker({ file });
    expect(fs.existsSync(file)).toBe(false);
    expect(readOcrMarker({ file })).toBeNull();
    expect(() => clearOcrMarker({ file })).not.toThrow(); // nothing to delete is fine
  });

  it('reads as "no failure remembered" when it is missing, corrupt, oversized, or not this format', async () => {
    const { readOcrMarker } = await load();
    const dir = tempDir();
    const file = path.join(dir, 'm.json');
    const good = { schema: 1, ...MARKER };
    expect(readOcrMarker({ file })).toBeNull();
    const cases: Array<[string, unknown]> = [
      ['not json', '{ nope'],
      ['array', []],
      ['null', null],
      ['other schema', { ...good, schema: 2 }],
      ['unknown kind', { ...good, kind: 'crashed' }],
      ['bad date', { ...good, failedAt: 'yesterday' }],
      ['reason missing', { ...good, reason: undefined }],
      ['signature missing', { ...good, signature: undefined }],
      ['signature part missing', { ...good, signature: { source: 'a', swiftc: 'b' } }],
      ['signature part not text', { ...good, signature: { source: 'a', swiftc: 1, osBuild: 'c' } }],
    ];
    for (const [name, value] of cases) {
      fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
      expect(readOcrMarker({ file }), name).toBeNull();
    }
    fs.writeFileSync(file, JSON.stringify({ ...good, reason: 'x'.repeat(20_000) }));
    expect(readOcrMarker({ file }), 'oversized').toBeNull();
    // A missing duration is allowed (null); a bad one reads as unknown, not as a failure to read.
    fs.writeFileSync(file, JSON.stringify({ ...good, durationMs: 'long' }));
    expect(readOcrMarker({ file })?.durationMs).toBeNull();
  });

  it('never throws when it cannot be written', async () => {
    const { writeOcrMarker } = await load();
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, 'a-file'), 'x');
    expect(writeOcrMarker(MARKER, { file: path.join(dir, 'a-file', 'inside', 'm.json') })).toBe(false);
  });

  it('says what the doctor shows: date, how long, and why', async () => {
    const { ocrMarkerDoctorText } = await load();
    const text = ocrMarkerDoctorText({ schema: 1, ...MARKER } as Marker);
    expect(text).toMatch(/^OCR helper build failed on \d{4}-\d{2}-\d{2} after 4\.2 s: error: boom$/);
    expect(ocrMarkerDoctorText({ schema: 1, ...MARKER, durationMs: null, reason: '' } as Marker)).toMatch(/^OCR helper build failed on \d{4}-\d{2}-\d{2}: no reason recorded$/);
  });
});

describe('signature', () => {
  it('is the source hash, the first line of the compiler version, and the OS build', async () => {
    const { computeOcrSignature } = await load();
    const dir = tempDir();
    const source = path.join(dir, 'main.swift');
    fs.writeFileSync(source, 'print(1)\n');
    const calls: Array<[string, string[]]> = [];
    const signature = computeOcrSignature('/fake/swiftc', {
      source,
      run: (file, args) => {
        calls.push([file, args]);
        return file === '/fake/swiftc' ? 'Apple Swift version 6.0 (swiftlang-6.0.0.9.10)\nTarget: arm64-apple-macosx15.0\n' : '24A335\n';
      },
    });
    expect(signature).toEqual({
      source: createHash('sha256').update('print(1)\n').digest('hex'),
      swiftc: 'Apple Swift version 6.0 (swiftlang-6.0.0.9.10)',
      osBuild: '24A335',
    });
    expect(calls).toEqual([['/fake/swiftc', ['--version']], ['/usr/bin/sw_vers', ['-buildVersion']]]);
    // A different source gives a different signature.
    fs.writeFileSync(source, 'print(2)\n');
    expect(computeOcrSignature('/fake/swiftc', { source, run: () => 'x' }).source).not.toBe(signature.source);
  });

  it('survives probes that fail or hang (they come back empty)', async () => {
    const { computeOcrSignature } = await load();
    const signature = computeOcrSignature('/fake/swiftc', { source: '/nonexistent/main.swift', run: () => { throw new Error('boom'); } });
    expect(signature).toEqual({ source: '', swiftc: '', osBuild: '' });
  });

  it('matches only when all three parts match, and never on an unknown source', async () => {
    const { sameOcrSignature } = await load();
    expect(sameOcrSignature(SIGNATURE, { ...SIGNATURE })).toBe(true);
    expect(sameOcrSignature(SIGNATURE, { ...SIGNATURE, source: 'b'.repeat(64) })).toBe(false);
    expect(sameOcrSignature(SIGNATURE, { ...SIGNATURE, swiftc: 'Apple Swift version 6.1' })).toBe(false);
    expect(sameOcrSignature(SIGNATURE, { ...SIGNATURE, osBuild: '24A336' })).toBe(false);
    expect(sameOcrSignature(null, SIGNATURE)).toBe(false);
    expect(sameOcrSignature({ ...SIGNATURE, source: '' }, { ...SIGNATURE, source: '' })).toBe(false);
  });
});

describe('acquireOcrBuildLock', () => {
  it('lets one build run at a time and frees the lock on release', async () => {
    const { acquireOcrBuildLock } = await load();
    const dir = path.join(tempDir(), 'ocr-helper-build.lock');
    const first = acquireOcrBuildLock({ dir, maxAgeMs: 60_000 });
    expect(first.ok).toBe(true);
    expect(acquireOcrBuildLock({ dir, maxAgeMs: 60_000 }).ok).toBe(false);
    first.release!();
    expect(fs.existsSync(dir)).toBe(false);
    const second = acquireOcrBuildLock({ dir, maxAgeMs: 60_000 });
    expect(second.ok).toBe(true);
    second.release!();
  });
  it('takes over a lock dated in the future (the clock was set back)', async () => {
    const { acquireOcrBuildLock } = await load();
    const dir = path.join(tempDir(), 'ocr-helper-build.lock');
    fs.mkdirSync(dir);
    const taken = acquireOcrBuildLock({ dir, maxAgeMs: 60_000, now: () => Date.now() - 3_600_000 });
    expect(taken.ok).toBe(true);
    taken.release!();
  });
  it('takes over a lock left by a killed run, once it is older than the limit', async () => {
    const { acquireOcrBuildLock } = await load();
    const dir = path.join(tempDir(), 'ocr-helper-build.lock');
    fs.mkdirSync(dir);
    const now = Date.now();
    expect(acquireOcrBuildLock({ dir, maxAgeMs: 60_000, now: () => now }).ok).toBe(false);
    const later = acquireOcrBuildLock({ dir, maxAgeMs: 60_000, now: () => now + 61_000 });
    expect(later.ok).toBe(true);
    later.release!();
  });
});

// ── The script itself ────────────────────────────────────────────────────────

function checkout() {
  const root = tempDir();
  const app = path.join(root, 'app');
  const stubs = path.join(root, 'stubs');
  const home = path.join(root, 'home');
  for (const d of [path.join(app, 'scripts'), path.join(app, 'native', 'vision-ocr'), stubs, home]) fs.mkdirSync(d, { recursive: true });
  fs.copyFileSync(bootstrapPath, path.join(app, 'scripts', 'bootstrap-deps.mjs'));
  const source = path.join(app, 'native', 'vision-ocr', 'main.swift');
  fs.writeFileSync(source, '// stub\n');
  const helper = path.join(app, 'native', 'vision-ocr', 'bin', 'vision-ocr');
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
  const swiftc = (body: string, version = 'Fake Swift version 1.0 (fake-1)') =>
    write('swiftc', `case "$1" in --version) echo '${version}'; exit 0;; esac\necho x >> '${calls}'\n${body}`);
  const compiles = () => (fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').split('\n').filter(Boolean).length : 0);
  const run = (args: string[] = [], env: Record<string, string> = {}) => {
    const started = Date.now();
    const result = spawnSync(process.execPath, [path.join(app, 'scripts', 'bootstrap-deps.mjs'), ...args], {
      cwd: app,
      env: {
        ...process.env,
        HOME: home,
        npm_lifecycle_event: '',
        BOTBOY_DEFER_OCR_BUILD: '',
        BOTBOY_OCR_BUILD_TIMEOUT_SECONDS: '',
        PATH: `${stubs}:/usr/bin:/bin`,
        BOTBOY_TEST_XCODE_SELECT_BIN: xcodeSelect,
        BOTBOY_TEST_XCRUN_BIN: xcrun,
        BOTBOY_TEST_SW_VERS_BIN: swVers,
        ...env,
      },
      encoding: 'utf8',
      timeout: 40_000,
    });
    return { ...result, ms: Date.now() - started };
  };
  const readMarker = () => JSON.parse(fs.readFileSync(marker, 'utf8')) as Marker;
  return { app, stubs, home, source, helper, marker, calls, write, swiftc, compiles, run, readMarker };
}

const DARWIN = process.platform === 'darwin';
const FLOOD = 'i=1; while [ $i -le 300 ]; do echo "diagnostic $i" >&2; i=$((i+1)); done\necho "error: the SDK is not supported by the compiler" >&2\nexit 1';
const BUILDS = 'out=""; while [ $# -gt 0 ]; do [ "$1" = "-o" ] && out="$2"; shift; done\nprintf \'#!/bin/sh\\necho helper\\n\' > "$out"\nchmod +x "$out"\nexit 0';

describe('scripts/bootstrap-deps.mjs: the compile time limit', () => {
  it('stops a compile that hangs at BOTBOY_OCR_BUILD_TIMEOUT_SECONDS, records a timeout, and exits 2 outside npm', () => {
    if (!DARWIN) return;
    const box = checkout();
    box.swiftc('echo compiling >&2\nsleep 60');
    const result = box.run(['--ocr-helper'], { BOTBOY_OCR_BUILD_TIMEOUT_SECONDS: '1' });
    expect(result.ms).toBeLessThan(20_000);
    expect(result.status).toBe(2);
    expect(box.readMarker()).toMatchObject({ schema: 1, kind: 'timeout', reason: 'the compiler did not finish in time' });
    expect(box.readMarker().durationMs).toBeGreaterThanOrEqual(900);
    expect(result.stderr).toMatch(/OCR helper build failed after \d+(\.\d)? s \(the compiler did not finish in time\)/);
  });

  it('cannot hang npm install: during postinstall it exits 0 at the limit', () => {
    if (!DARWIN) return;
    const box = checkout();
    box.swiftc('sleep 60');
    const result = box.run([], { npm_lifecycle_event: 'postinstall', BOTBOY_OCR_BUILD_TIMEOUT_SECONDS: '1' });
    expect(result.status).toBe(0);
    expect(result.ms).toBeLessThan(25_000);
    expect(box.readMarker().kind).toBe('timeout');
  });

  it('the compile call carries the time limit, kills hard, and leaves no staged or half-written helper', () => {
    const text = fs.readFileSync(bootstrapPath, 'utf8');
    expect(text).toMatch(/execFileSync\(swiftc, \[\.\.\.swiftSdkArgs\(\), '-O', swiftSrc, '-o', staged\], \{[^}]*timeout: timeoutMs,[^}]*killSignal: 'SIGKILL'/);
    if (!DARWIN) return;
    const box = checkout();
    box.swiftc('sleep 60');
    box.run(['--ocr-helper'], { BOTBOY_OCR_BUILD_TIMEOUT_SECONDS: '1' });
    expect(fs.existsSync(box.helper)).toBe(false);
    expect(fs.readdirSync(path.dirname(box.helper))).toEqual([]);
  });

  it('leaves an existing helper in place when the new build fails', () => {
    if (!DARWIN) return;
    const box = checkout();
    fs.mkdirSync(path.dirname(box.helper), { recursive: true });
    fs.writeFileSync(box.helper, '#!/bin/sh\necho old-helper\n', { mode: 0o755 });
    const past = new Date(Date.now() - 3_600_000);
    fs.utimesSync(box.helper, past, past); // older than the source: a rebuild is due
    box.swiftc(FLOOD);
    box.run(['--ocr-helper']);
    expect(fs.readFileSync(box.helper, 'utf8')).toContain('old-helper');
    expect(fs.readdirSync(path.dirname(box.helper))).toEqual(['vision-ocr']);
  });
});

describe('scripts/bootstrap-deps.mjs: remembered failures', () => {
  it('cuts the compiler output to 20 + 5 lines plus one summary line, on stderr, and puts only the calm note on stdout', () => {
    if (!DARWIN) return;
    const box = checkout();
    box.swiftc(FLOOD);
    const result = box.run(['--ocr-helper']);
    expect(result.status).toBe(2);
    const diagnostics = result.stderr.split('\n').filter((line) => line.startsWith('  ')); // the excerpt is indented; the summary is not
    expect(diagnostics).toHaveLength(25);
    expect(result.stderr).toContain('diagnostic 20');
    expect(result.stderr).not.toContain('diagnostic 21\n');
    expect(result.stderr).toContain('diagnostic 300');
    expect(result.stderr.match(/OCR helper build failed/g)).toHaveLength(1);
    expect(result.stderr).toContain('[compiler output: 301 lines, showing the first 20 and the last 5]');
    expect(result.stderr.trim().split('\n').length).toBeLessThanOrEqual(27); // "building" + 25 + summary
    expect(result.stdout.trim().split('\n')).toHaveLength(1);
    expect(result.stdout).toContain('Text reading from images and scanned PDFs (OCR) is off');
    expect(box.readMarker().reason).toBe('error: the SDK is not supported by the compiler');
  });

  it('skips a remembered failure silently in the background job and in npm postinstall, but a run by hand retries', () => {
    if (!DARWIN) return;
    const box = checkout();
    box.swiftc(FLOOD);
    box.run(['--ocr-helper']);
    expect(box.compiles()).toBe(1);

    const job = box.run(['--ocr-helper']);
    expect(job.stdout + job.stderr).toBe('');
    expect(job.status).toBe(0);

    const postinstall = box.run([], { npm_lifecycle_event: 'postinstall' });
    expect(postinstall.status).toBe(0);
    expect(postinstall.stdout).not.toContain('OCR helper');
    expect(box.compiles()).toBe(1);

    const byHand = box.run([]); // npm run bootstrap
    expect(box.compiles()).toBe(2);
    expect(byHand.status).toBe(2);
    expect(byHand.stdout).toContain('OCR helper build failed');
    expect(byHand.stdout).toContain('Text reading from images and scanned PDFs (OCR) is off');
  });

  it('--force-ocr retries a remembered failure in the background mode too', () => {
    if (!DARWIN) return;
    const box = checkout();
    box.swiftc(FLOOD);
    box.run(['--ocr-helper']);
    box.run(['--ocr-helper', '--force-ocr']);
    expect(box.compiles()).toBe(2);
  });

  it('retries when the helper source, the compiler version, or the macOS build changes', () => {
    if (!DARWIN) return;
    const box = checkout();
    box.swiftc(FLOOD);
    box.run(['--ocr-helper']);
    fs.appendFileSync(box.source, '// new release\n');
    box.run(['--ocr-helper']);
    expect(box.compiles()).toBe(2);
    box.swiftc(FLOOD, 'Fake Swift version 1.1 (fake-2)');
    box.run(['--ocr-helper']);
    expect(box.compiles()).toBe(3);
    box.write('sw_vers', 'echo 24A999');
    box.run(['--ocr-helper']);
    expect(box.compiles()).toBe(4);
    expect(box.readMarker().signature).toMatchObject({ swiftc: 'Fake Swift version 1.1 (fake-2)', osBuild: '24A999' });
    box.run(['--ocr-helper']);
    expect(box.compiles()).toBe(4); // unchanged again: remembered again
  });

  it('a successful build installs the helper, deletes the remembered failure, and says nothing to the owner', () => {
    if (!DARWIN) return;
    const box = checkout();
    box.swiftc(FLOOD);
    box.run(['--ocr-helper']);
    expect(fs.existsSync(box.marker)).toBe(true);
    box.swiftc(BUILDS);
    const result = box.run(['--ocr-helper', '--force-ocr']);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    expect(fs.existsSync(box.marker)).toBe(false);
    expect(fs.statSync(box.helper).mode & 0o111).not.toBe(0);
    expect(fs.readdirSync(path.dirname(box.helper))).toEqual(['vision-ocr']);
    expect(fs.existsSync(path.join(box.home, '.personal-productivity-tracker', 'ocr-helper-build.lock'))).toBe(false);
  });

  it('a corrupt remembered failure reads as none: the build is tried', () => {
    if (!DARWIN) return;
    const box = checkout();
    fs.mkdirSync(path.dirname(box.marker), { recursive: true });
    fs.writeFileSync(box.marker, '{ not json');
    box.swiftc(BUILDS);
    expect(box.run(['--ocr-helper']).status).toBe(0);
    expect(fs.existsSync(box.helper)).toBe(true);
    expect(fs.existsSync(box.marker)).toBe(false);
  });

  it('--ocr-marker prints the doctor sentence, or nothing', () => {
    if (!DARWIN) return;
    const box = checkout();
    expect(box.run(['--ocr-marker']).stdout).toBe('');
    box.swiftc(FLOOD);
    box.run(['--ocr-helper']);
    const out = box.run(['--ocr-marker']);
    expect(out.status).toBe(0);
    expect(out.stdout.trim()).toMatch(/^OCR helper build failed on \d{4}-\d{2}-\d{2} after \d+(\.\d)? s: error: the SDK is not supported by the compiler$/);
    expect(box.compiles()).toBe(1); // reading the marker compiles nothing
  });

  it('writes nothing outside the private folder, even when the compile fails', () => {
    if (!DARWIN) return;
    const box = checkout();
    box.swiftc(FLOOD);
    box.run(['--ocr-helper']);
    expect(fs.readdirSync(box.home)).toEqual(['.personal-productivity-tracker']);
    expect(fs.readdirSync(path.join(box.home, '.personal-productivity-tracker'))).toEqual(['ocr-helper-build.json']);
  });
});

describe('scripts/bootstrap-deps.mjs: another build is running', () => {
  it('is silent in the background and says so when the owner asked', () => {
    if (!DARWIN) return;
    const box = checkout();
    box.swiftc(BUILDS);
    const lock = path.join(box.home, '.personal-productivity-tracker', 'ocr-helper-build.lock');
    fs.mkdirSync(lock, { recursive: true });
    const quiet = box.run(['--ocr-helper']);
    expect(quiet.stdout + quiet.stderr).toBe('');
    expect(box.compiles()).toBe(0);
    const asked = box.run(['--ocr-helper', '--force-ocr']);
    expect(asked.stdout).toContain('Another OCR helper build is already running');
    expect(box.compiles()).toBe(0);
    expect(fs.existsSync(box.helper)).toBe(false);
  });
});

describe('scripts/bootstrap-deps.mjs: npm install started by start.sh', () => {
  it('skips the compile when BOTBOY_DEFER_OCR_BUILD=1 during postinstall, and only then', () => {
    if (!DARWIN) return;
    const box = checkout();
    box.swiftc(BUILDS);
    const deferred = box.run([], { npm_lifecycle_event: 'postinstall', BOTBOY_DEFER_OCR_BUILD: '1' });
    expect(deferred.status).toBe(0);
    expect(box.compiles()).toBe(0);
    expect(fs.existsSync(box.helper)).toBe(false);
    expect(deferred.stdout).toContain('OCR helper build deferred');
    // A run by hand with the variable set still builds: only npm's postinstall defers.
    box.run([], { BOTBOY_DEFER_OCR_BUILD: '1' });
    expect(fs.existsSync(box.helper)).toBe(true);
  });
});
