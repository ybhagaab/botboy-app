/**
 * The server's OCR helper decision (src/core/native-helpers.ts).
 *
 * What a server process must guarantee, in this order of importance:
 *  - a file that failed its hash, its macOS floor, or that carries the download
 *    flag is never executed, on the async path AND the synchronous one
 *    (review 1, finding 3);
 *  - a failure with the shape of "the system would not run it" is recognised
 *    whether or not Node has a NAME for its errno (finding 2), and a helper's
 *    own non-zero exit is never mistaken for one;
 *  - a latched helper stops being offered, a transient kill does not latch;
 *  - the boot verdict spawns nothing.
 * Fixtures are shell scripts, a stub xattr and a fixture root
 * (BOTBOY_TEST_NATIVE_ROOT); the only real Mach-O is a 32-byte file the kernel
 * itself refuses (no Gatekeeper is involved), on macOS.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  EXEC_FAILURE_NEXT_ACTION,
  currentVisionHelper,
  ensureVisionHelperReady,
  helperLatch,
  isExecFailure,
  macosFromDarwinMajor,
  noteHelperExecFailure,
  ocrReasonLine,
  resetNativeHelperState,
  resolveVisionHelper,
  settleHelperRetest,
  usableVisionHelperPath,
  visionHelperOffLine,
} from './native-helpers.js';
import { visionHelperPath } from './deps-check.js';
import { NEWER_SOURCE, SOURCE, cleanupFixtures, fixture, stubXattr } from './native-helpers.testutil.js';

vi.setConfig({ testTimeout: 60_000 });
const execFileP = promisify(execFile);
const onMac = describe.runIf(process.platform === 'darwin');
const MAC13 = '22.0.0'; // Darwin 22 is macOS 13
const tmpFiles: string[] = [];

beforeEach(() => {
  resetNativeHelperState();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  cleanupFixtures();
  resetNativeHelperState();
  while (tmpFiles.length) fs.rmSync(tmpFiles.pop()!, { recursive: true, force: true });
});

/** Use a fixture folder as the package root for this process. */
function useRoot(f: ReturnType<typeof fixture>) {
  process.env.BOTBOY_TEST_NATIVE_ROOT = f.root;
}

describe('resolveVisionHelper (boot verdict: T0 to T2, no process spawned)', () => {
  const resolve = (f: ReturnType<typeof fixture>, darwinRelease = MAC13) => resolveVisionHelper({ root: f.root, platform: 'darwin', darwinRelease });

  it('R0 not macOS', () => {
    expect(resolveVisionHelper({ root: fixture().root, platform: 'linux' })).toMatchObject({ provenance: 'none', reason: 'not_macos', path: null });
  });

  it('R1 prebuilt usable and source same → current', () => {
    const f = fixture();
    expect(resolve(f)).toMatchObject({ provenance: 'prebuilt', current: true, reason: null, path: f.files.prebuilt, minMacos: '13.0', osVersion: '13.0' });
    expect(resolve(f).binarySha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('R2 a current local build beats a prebuilt whose source differs; R3 otherwise the old prebuilt stays', () => {
    const withLocal = fixture({ sourceOnDisk: NEWER_SOURCE, sourceInManifest: SOURCE, local: 'current' });
    expect(resolve(withLocal)).toMatchObject({ provenance: 'local', current: true, path: withLocal.files.local });
    const alone = fixture({ sourceOnDisk: NEWER_SOURCE, sourceInManifest: SOURCE });
    expect(resolve(alone)).toMatchObject({ provenance: 'prebuilt', current: false, reason: 'prebuilt_outdated' });
  });

  it('R4 an outdated local build stays in use when there is no usable prebuilt', () => {
    const f = fixture({ withBinary: false, local: 'outdated' });
    expect(resolve(f)).toMatchObject({ provenance: 'local', current: false, reason: 'local_outdated' });
  });

  const reasons: [string, Parameters<typeof fixture>[0], string][] = [
    ['no manifest', { manifest: 'missing', withBinary: false }, 'manifest_missing'],
    ['an invalid manifest', { manifest: 'invalid' }, 'manifest_invalid'],
    ['no prebuilt file', { withBinary: false }, 'prebuilt_missing'],
    ['a wrong size', { corrupt: 'size' }, 'prebuilt_corrupt'],
    ['a wrong hash', { corrupt: 'hash' }, 'prebuilt_corrupt'],
    ['mode 644', { mode: 0o644 }, 'prebuilt_not_executable'],
  ];
  for (const [name, options, reason] of reasons) {
    it(`R5 ${name} → ${reason}`, () => {
      const f = fixture(options);
      expect(resolve(f)).toMatchObject({ provenance: 'none', current: false, reason, path: null });
      expect(f.ran()).toBe(0);
    });
  }

  it('maps the Darwin kernel to the macOS floor: Darwin 21 is macOS 12 (too old), 22 is 13, 25 is 26', () => {
    const f = fixture();
    expect(resolve(f, '21.6.0')).toMatchObject({ provenance: 'none', reason: 'os_too_old', osVersion: '12.0', minMacos: '13.0' });
    expect(resolve(f, '22.0.0').provenance).toBe('prebuilt');
    expect(resolve(f, '25.6.0')).toMatchObject({ provenance: 'prebuilt', osVersion: '26.0' });
    expect([20, 21, 22, 23, 24, 25, 26].map(macosFromDarwinMajor)).toEqual(['11.0', '12.0', '13.0', '14.0', '15.0', '26.0', '27.0']);
    expect(macosFromDarwinMajor(Number.NaN)).toBeNull();
  });

  it('an unreadable kernel version does not enforce the floor', () => {
    expect(resolve(fixture(), 'not-a-version')).toMatchObject({ provenance: 'prebuilt', osVersion: null });
  });

  it('spawns nothing and executes nothing', () => {
    const f = fixture();
    const xattr = stubXattr(f.root, 'flagged');
    resolve(f);
    resolve(fixture({ corrupt: 'hash' }));
    expect(f.ran()).toBe(0);
    expect(xattr.calls()).toEqual([]);
  });

  it('never throws', () => {
    const file = path.join(os.tmpdir(), `botboy-helpers-not-a-folder-${process.pid}`);
    fs.writeFileSync(file, 'x');
    tmpFiles.push(file);
    expect(() => resolveVisionHelper({ root: file, platform: 'darwin', darwinRelease: MAC13 })).not.toThrow();
  });
});

describe('the cached verdict follows the files', () => {
  it('picks up a local build that appears after boot, without a restart', () => {
    const f = fixture({ withBinary: false, manifest: 'missing' });
    useRoot(f);
    expect(currentVisionHelper()).toMatchObject({ provenance: 'none', reason: 'manifest_missing' });
    fs.mkdirSync(path.dirname(f.files.local), { recursive: true });
    fs.writeFileSync(f.files.local, '#!/bin/sh\nexit 2\n', { mode: 0o755 });
    expect(currentVisionHelper()).toMatchObject({ provenance: 'local', path: f.files.local });
  });
});

describe('a flagged (quarantined) helper is never executed (finding 3)', () => {
  it('the synchronous path clears the flag first, then offers the path; the helper itself is not run', () => {
    const f = fixture();
    useRoot(f);
    const xattr = stubXattr(f.root, 'flagged');
    expect(usableVisionHelperPath()).toBe(f.files.prebuilt);
    expect(xattr.calls().map((call) => call.split(' ')[0])).toEqual(['-p', '-d', '-p']);
    expect(f.ran()).toBe(0);
    // once per file signature: asking again does not ask xattr again
    expect(usableVisionHelperPath()).toBe(f.files.prebuilt);
    expect(xattr.calls()).toHaveLength(3);
  });

  it('a flag that cannot be cleared: no path on the sync path, no smoke on the async path, one sentence logged once', async () => {
    const f = fixture();
    useRoot(f);
    stubXattr(f.root, 'flagged', { stuck: true });
    expect(usableVisionHelperPath()).toBeNull();
    expect(usableVisionHelperPath()).toBeNull();
    expect(await ensureVisionHelperReady()).toBe(false);
    expect(f.ran()).toBe(0);
    expect(visionHelperOffLine()).toContain('macOS marked BotBoy\'s reader as downloaded from the internet');
    expect(visionHelperOffLine()).toContain('xattr -r -d com.apple.quarantine');
    const warnings = vi.mocked(console.warn).mock.calls.map((call) => String(call[0]));
    expect(warnings.filter((line) => line.includes('downloaded from the internet'))).toHaveLength(1);
  });

  it('an xattr that cannot answer is treated as flagged (fail closed)', () => {
    const f = fixture();
    useRoot(f);
    stubXattr(f.root, 'broken', { stuck: true }); // -p cannot answer and -d changes nothing
    expect(usableVisionHelperPath()).toBeNull();
    expect(f.ran()).toBe(0);
  });

  it('a local build, compiled on this Mac, is not flag-checked or smoke-run', async () => {
    const f = fixture({ corrupt: 'hash', local: 'current' });
    useRoot(f);
    const xattr = stubXattr(f.root, 'flagged', { stuck: true });
    expect(usableVisionHelperPath()).toBe(f.files.local);
    expect(await ensureVisionHelperReady()).toBe(true);
    expect(xattr.calls()).toEqual([]);
    expect(f.ran()).toBe(0);
  });
});

describe('the first-use smoke (async path, once per process)', () => {
  it('runs once for concurrent callers and then never again', async () => {
    const f = fixture();
    useRoot(f);
    stubXattr(f.root, 'none');
    const results = await Promise.all([ensureVisionHelperReady(), ensureVisionHelperReady(), ensureVisionHelperReady()]);
    expect(results).toEqual([true, true, true]);
    expect(await ensureVisionHelperReady()).toBe(true);
    expect(f.ran()).toBe(1);
  });

  it('a helper that fails its smoke is latched off for the process, with a sentence naming the next action', async () => {
    const f = fixture({ helperBody: (c) => `#!/bin/sh\necho run >> '${c}'\nkill -KILL $$\n` });
    useRoot(f);
    stubXattr(f.root, 'none');
    expect(await ensureVisionHelperReady()).toBe(false);
    expect(helperLatch()).toMatchObject({ reason: 'smoke_failed', detail: 'killed by macOS' });
    expect(usableVisionHelperPath()).toBeNull();
    expect(visionHelperOffLine()).toContain('./start.sh --rebuild-ocr');
    expect(visionHelperOffLine()).toContain('./start.sh --doctor');
    expect(await ensureVisionHelperReady()).toBe(false);
    expect(f.ran()).toBe(1); // not retried on every call
  });
});

describe('isExecFailure: the shape of "the system would not run it" (finding 2)', () => {
  const sh = (body: string) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'botboy-exec-shapes-'));
    tmpFiles.push(dir);
    const file = path.join(dir, 'helper');
    fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    return file;
  };
  const failure = async (file: string, options: Record<string, unknown> = {}) => {
    try {
      await execFileP(file, [], options);
    } catch (error) {
      return error;
    }
    return null;
  };

  it('a child killed by a signal counts (including Node\'s own timeout kill)', async () => {
    expect(isExecFailure(await failure(sh('kill -KILL $$')))).toBe(true);
    expect(isExecFailure(await failure(sh('exec sleep 5'), { timeout: 200 }))).toBe(true);
  });

  it('a helper that ran and said no does not count: exit 2, 3, 4 with a JSON error', async () => {
    for (const code of [1, 2, 3, 4]) {
      const error = await failure(sh(`echo '{"error":"bad input"}' >&2\nexit ${code}`));
      expect(error).toBeTruthy();
      expect(isExecFailure(error), `exit ${code}`).toBe(false);
    }
  });

  it('a spawn-phase error with a negative errno counts, named or not', () => {
    expect(isExecFailure({ errno: -13, code: 'EACCES', syscall: 'spawn /x/helper' })).toBe(true);
    expect(isExecFailure({ errno: -2, code: 'ENOENT', syscall: 'spawn /x/helper' })).toBe(true);
    expect(isExecFailure({ errno: -86, code: 'Unknown system error -86', syscall: 'spawn' })).toBe(true);
    expect(isExecFailure({ errno: -8, code: 'Unknown system error -8', syscall: 'spawnSync /x/helper' })).toBe(true);
  });

  it('other shapes do not count', () => {
    expect(isExecFailure(null)).toBe(false);
    expect(isExecFailure(undefined)).toBe(false);
    expect(isExecFailure(new Error('boom'))).toBe(false);
    expect(isExecFailure({ code: 2, status: 2 })).toBe(false);
    expect(isExecFailure({ errno: -13, syscall: 'open' })).toBe(false); // a file error, not a failure to run
    expect(isExecFailure({ errno: 13, syscall: 'spawn' })).toBe(false); // errno must be negative
    expect(isExecFailure({ signal: '' })).toBe(false);
  });

  onMac('on this Mac', () => {
    /** A 32-byte Mach-O header with a CPU type no kernel can run: the kernel itself refuses it. */
    const badCpu = () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'botboy-badcpu-'));
      tmpFiles.push(dir);
      const file = path.join(dir, 'helper');
      const header = Buffer.alloc(32);
      header.writeUInt32LE(0xfeedfacf, 0);
      header.writeUInt32LE(0x99, 4);
      header.writeUInt32LE(3, 8);
      header.writeUInt32LE(2, 12);
      fs.writeFileSync(file, header, { mode: 0o755 });
      return file;
    };

    it('an unrunnable Mach-O fails with an errno Node has no name for, and the shape check still sees it (async)', async () => {
      const error = (await failure(badCpu())) as { errno?: number; code?: string; syscall?: string } | null;
      expect(error).toBeTruthy();
      expect(typeof error!.errno).toBe('number');
      expect(error!.errno!).toBeLessThan(0);
      expect(String(error!.syscall)).toMatch(/^spawn/);
      // the property the name-matching version missed:
      expect(['ENOEXEC', 'EBADARCH', 'EACCES']).not.toContain(error!.code);
      expect(isExecFailure(error)).toBe(true);
    });

    it('and on the synchronous path (execFileSync, syscall "spawnSync <path>")', () => {
      let caught: unknown = null;
      try {
        execFileSync(badCpu(), [], { stdio: 'pipe' });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeTruthy();
      expect(String((caught as { syscall?: string }).syscall)).toMatch(/^spawnSync /);
      expect(isExecFailure(caught)).toBe(true);
    });
  });
});

describe('the exec-failure latch', () => {
  /** A helper whose smoke passes until a "break" file appears (the bytes, and so the hash, never change). */
  function breakable() {
    const f = fixture({
      helperBody: (calls) => `#!/bin/sh\necho run >> '${calls}'\nif [ -f '${path.join(path.dirname(calls), 'break')}' ]; then kill -KILL $$; fi\necho '{"error":"usage: vision-ocr <imagePath> | pdf-text <pdfPath> | pdf-rasterize <pdfPath> <outDir> [dpi]"}' >&2\nexit 2\n`,
    });
    useRoot(f);
    stubXattr(f.root, 'none');
    return { f, breakNow: () => fs.writeFileSync(path.join(f.root, 'break'), 'x'), fix: () => fs.rmSync(path.join(f.root, 'break'), { force: true }) };
  }

  it('a failure that is not a failure to run starts no re-test and changes nothing', async () => {
    const { f } = breakable();
    expect(await ensureVisionHelperReady()).toBe(true);
    const runs = f.ran();
    noteHelperExecFailure(Object.assign(new Error('Command failed'), { code: 3 }));
    noteHelperExecFailure(new Error('could not open PDF'));
    await settleHelperRetest();
    expect(f.ran()).toBe(runs);
    expect(helperLatch()).toBeNull();
    expect(usableVisionHelperPath()).toBe(f.files.prebuilt);
  });

  it('one transient kill does not disable OCR: the fresh check passes and the helper stays in use', async () => {
    const { f } = breakable();
    expect(await ensureVisionHelperReady()).toBe(true);
    noteHelperExecFailure({ signal: 'SIGKILL' });
    await settleHelperRetest();
    expect(helperLatch()).toBeNull();
    expect(usableVisionHelperPath()).toBe(f.files.prebuilt);
    expect(f.ran()).toBe(2); // the first smoke and the re-test
  });

  it('a kill that repeats on the fresh check latches the helper off, once, with the next action', async () => {
    const { f, breakNow } = breakable();
    expect(await ensureVisionHelperReady()).toBe(true);
    breakNow();
    noteHelperExecFailure({ signal: 'SIGKILL' });
    noteHelperExecFailure({ signal: 'SIGKILL' }); // a second report while the re-test runs starts no second one
    await settleHelperRetest();
    expect(helperLatch()).toMatchObject({ reason: 'smoke_failed' });
    expect(usableVisionHelperPath()).toBeNull();
    expect(f.ran()).toBe(2);
    noteHelperExecFailure({ signal: 'SIGKILL' }); // already latched: nothing more is run
    await settleHelperRetest();
    expect(f.ran()).toBe(2);
    expect(visionHelperOffLine()).toContain('./start.sh --rebuild-ocr');
    expect(vi.mocked(console.warn).mock.calls.filter((call) => String(call[0]).includes('would not run')).length).toBe(1);
  });

  it('the re-test asks the download flag first and never runs a helper whose flag came back', async () => {
    const { f } = breakable();
    expect(await ensureVisionHelperReady()).toBe(true);
    const xattr = stubXattr(f.root, 'flagged', { stuck: true });
    noteHelperExecFailure({ errno: -86, syscall: 'spawn', code: 'Unknown system error -86' });
    await settleHelperRetest();
    expect(helperLatch()).toMatchObject({ reason: 'quarantined' });
    expect(f.ran()).toBe(1); // only the original smoke
    expect(xattr.calls().length).toBeGreaterThan(0);
  });

  it('the text added to an exec-failure error ends with the next action', () => {
    expect(EXEC_FAILURE_NEXT_ACTION).toBe('macOS would not run the OCR helper; run ./start.sh --doctor for the reason.');
  });
});

/**
 * Review 2, finding 5. deps-check.ts › visionHelperPath() is what the synchronous readers (the PDF chain in
 * document-parser.ts) ask: the usable helper, else the conventional local build. When the helper this process
 * latched off WAS that local build, the fallback was the very file the latch refused, so every PDF ran it again.
 */
onMac('a latched helper is not offered to the synchronous readers either (review 2, finding 5)', () => {
  const latchOff = async () => {
    noteHelperExecFailure({ signal: 'SIGKILL' });
    await settleHelperRetest();
  };

  it('a latched LOCAL build is no longer handed back: the path has no file, so each reader moves on to the next', async () => {
    // The fixture local build answers like a program macOS would not run: exit 2 without the usage line.
    const f = fixture({ withBinary: false, manifest: 'missing', local: 'current' });
    useRoot(f);
    expect(visionHelperPath()).toBe(f.files.local); // before the latch it is theirs to try
    await latchOff();
    expect(helperLatch()).toMatchObject({ reason: 'smoke_failed' });
    expect(usableVisionHelperPath()).toBeNull();
    // The local file is still on disk (the latch is for this process only); the readers' fs.existsSync test must fail.
    expect(fs.existsSync(f.files.local)).toBe(true);
    expect(fs.existsSync(visionHelperPath())).toBe(false);
  });

  it('a latched PREBUILT still leaves a local build to them: it is a different file, and a build made on this Mac', async () => {
    const f = fixture({ helperBody: () => '#!/bin/sh\nkill -9 $$\n', local: 'current' });
    useRoot(f);
    stubXattr(f.root, 'none');
    expect(visionHelperPath()).toBe(f.files.prebuilt);
    await latchOff();
    expect(helperLatch()).toMatchObject({ reason: 'smoke_failed' });
    // Fix pass 1: the server's OCR engine asks this function, so it now agrees with the synchronous readers (it was null here).
    expect(usableVisionHelperPath()).toBe(f.files.local);
    expect(visionHelperPath()).toBe(f.files.local);
  });

  it('nothing is latched by default, and a reset forgets a latch: the local build is offered again', async () => {
    const f = fixture({ withBinary: false, manifest: 'missing', local: 'current' });
    useRoot(f);
    await latchOff();
    expect(fs.existsSync(visionHelperPath())).toBe(false);
    resetNativeHelperState();
    expect(visionHelperPath()).toBe(f.files.local);
  });
});

describe('reason lines', () => {
  it('say the same words as scripts/native-prebuilt.mjs and always name the next action', () => {
    for (const reason of ['manifest_missing', 'manifest_invalid', 'prebuilt_missing', 'prebuilt_corrupt', 'prebuilt_not_executable', 'os_too_old', 'quarantined', 'smoke_failed', 'resolver_error']) {
      const line = ocrReasonLine(reason, { root: '/x/botboy-app', osVersion: '12.7', minMacos: '13.0', detail: 'killed by macOS' });
      expect(line).toMatch(/\.\/start\.sh|xattr|Software Update/);
      expect(line).not.toContain('System Settings > Software Update');
      expect(line).not.toMatch(/build failed|could not be built/i);
    }
  });
});
