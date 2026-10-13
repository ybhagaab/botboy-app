/**
 * Fix pass 1 (review 3, finding 1, the blocker): the server's OCR engine must use a working local build once the
 * prebuilt may not run here, as the shell resolver, the doctor and `./start.sh --rebuild-ocr` already do.
 *
 * The scenario: a Mac whose prebuilt reader macOS kills at first use (or whose download mark will not clear) and which
 * holds a local build (the Mac with Command Line Tools that the fallback exists for). Before the fix the boot verdict
 * said "prebuilt", the first use latched it off, and `usableVisionHelperPath()` stayed null: images and scanned PDFs
 * were unread until the process ended and again after every restart, while `./start.sh --doctor` said
 * `ocr helper: local build, current`.
 *
 * Fixtures are shell scripts under a fixture root (BOTBOY_TEST_NATIVE_ROOT) and a stub xattr; nothing real is flagged
 * or run. Every test here fails without the fallback (mutation M37 in verification-log.md).
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createVisionOcrEngine, OcrFailedError, OcrUnavailableError } from './ocr-engine.js';
import { visionHelperPath } from './deps-check.js';
import {
  ensureVisionHelperReady,
  helperLatch,
  isHelperLatchedOff,
  noteHelperExecFailure,
  ocrFallbackLine,
  ocrLocalRefusedLine,
  ocrReasonLine,
  resetNativeHelperState,
  settleHelperRetest,
  usableVisionHelper,
  usableVisionHelperPath,
  visionHelperOffLine,
} from './native-helpers.js';
import { SOURCE, cleanupFixtures, fixture, sha, stubXattr } from './native-helpers.testutil.js';

vi.setConfig({ testTimeout: 60_000 });

const USAGE = '{"error":"usage: vision-ocr <imagePath> | pdf-text <pdfPath> | pdf-rasterize <pdfPath> <outDir> [dpi]"}';
/** A prebuilt that macOS kills at first use. */
const killsItself = (calls: string) => `#!/bin/sh\necho run >> '${calls}'\nkill -KILL $$\n`;

beforeEach(() => {
  resetNativeHelperState();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  cleanupFixtures();
  resetNativeHelperState();
});

function useRoot(f: ReturnType<typeof fixture>) {
  process.env.BOTBOY_TEST_NATIVE_ROOT = f.root;
}

/**
 * Give the fixture's local build a body that answers like the real helper (usage on no arguments, JSON for an image,
 * one PNG for `pdf-rasterize`), or one that dies the way a file macOS refuses to run does. The sidecar fixture()
 * wrote ("current" or "outdated") stays, so the build keeps its state. Returns how often it ran.
 */
function localReader(f: ReturnType<typeof fixture>, mode: 'works' | 'dies' | 'breakable' = 'works') {
  const calls = `${f.files.local}.calls`;
  const breakFile = path.join(f.root, 'break-local');
  const body = mode === 'dies'
    ? `#!/bin/sh\necho local >> '${calls}'\nkill -KILL $$\n`
    : `#!/bin/sh
echo local >> '${calls}'
${mode === 'breakable' ? `if [ -f '${breakFile}' ]; then kill -KILL $$; fi\n` : ''}case "$1" in
  '') echo '${USAGE}' >&2; exit 2;;
  pdf-rasterize) : > "$3/page-1.png"; echo '{"pages":1}';;
  *) echo '{"text":"read by the local build","lines":[],"aggConfidence":0.9}';;
esac
`;
  fs.writeFileSync(f.files.local, body, { mode: 0o755 });
  fs.chmodSync(f.files.local, 0o755);
  return {
    ran: () => (fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').split('\n').filter(Boolean).length : 0),
    breakNow: () => fs.writeFileSync(breakFile, 'x'),
  };
}

const warnings = () => vi.mocked(console.warn).mock.calls.map((call) => String(call[0]));
const onMac = describe.runIf(process.platform === 'darwin');

describe('a prebuilt that macOS kills at first use, and a local build on this Mac', () => {
  it('the same call is handed to the local build, and the path stays usable', async () => {
    const f = fixture({ helperBody: killsItself, local: 'current' });
    useRoot(f);
    stubXattr(f.root, 'none');
    const local = localReader(f);
    expect(usableVisionHelper()).toMatchObject({ provenance: 'prebuilt', fallback: false }); // the boot verdict knows nothing yet
    expect(await ensureVisionHelperReady()).toBe(true); // was false: the smoke fails, and nothing was left
    expect(usableVisionHelper()).toEqual({ provenance: 'local', path: f.files.local, current: true, fallback: true });
    expect(usableVisionHelperPath()).toBe(f.files.local);
    expect(helperLatch()).toMatchObject({ reason: 'smoke_failed', detail: 'killed by macOS' });
    expect(isHelperLatchedOff(f.files.prebuilt)).toBe(true);
    expect(isHelperLatchedOff(f.files.local)).toBe(false);
    expect(visionHelperOffLine()).toBeNull(); // OCR is not off
    expect(f.ran()).toBe(1); // the first-use smoke of the prebuilt, never again
    expect(local.ran()).toBe(0); // a local build is not smoke-run
  });

  it('says so once, and does not say OCR is off', async () => {
    const f = fixture({ helperBody: killsItself, local: 'current' });
    useRoot(f);
    stubXattr(f.root, 'none');
    localReader(f);
    await ensureVisionHelperReady();
    await ensureVisionHelperReady();
    usableVisionHelperPath();
    expect(warnings()).toEqual([`ℹ️  ${ocrFallbackLine('killed by macOS')}`]);
    expect(ocrFallbackLine('killed by macOS')).toBe('The prebuilt OCR reader would not run here (killed by macOS); using the one built on this Mac.');
    expect(warnings().join('\n')).not.toContain('OCR is off');
  });

  it('an outdated local build serves too (rule R4), and the shell resolver would have returned it', async () => {
    const f = fixture({ helperBody: killsItself, local: 'outdated' });
    useRoot(f);
    stubXattr(f.root, 'none');
    localReader(f);
    expect(await ensureVisionHelperReady()).toBe(true);
    expect(usableVisionHelper()).toEqual({ provenance: 'local', path: f.files.local, current: false, fallback: true });
  });

  it('the synchronous readers get the same file the OCR engine does', async () => {
    const f = fixture({ helperBody: killsItself, local: 'current' });
    useRoot(f);
    stubXattr(f.root, 'none');
    localReader(f);
    await ensureVisionHelperReady();
    expect(visionHelperPath()).toBe(usableVisionHelperPath());
    expect(visionHelperPath()).toBe(f.files.local);
  });

  it('a local build that shows up after the latch (a rebuild while the server runs) is picked up without a restart', async () => {
    const f = fixture({ helperBody: killsItself });
    useRoot(f);
    stubXattr(f.root, 'none');
    expect(await ensureVisionHelperReady()).toBe(false);
    expect(usableVisionHelperPath()).toBeNull();
    expect(visionHelperOffLine()).toContain('./start.sh --rebuild-ocr');
    // what `./start.sh --rebuild-ocr` leaves behind: the build and the sidecar naming the source it was built from
    fs.mkdirSync(path.dirname(f.files.local), { recursive: true });
    fs.writeFileSync(f.files.local, '#!/bin/sh\nexit 2\n', { mode: 0o755 });
    fs.writeFileSync(f.files.sidecar, `${sha(SOURCE)}\n`);
    expect(usableVisionHelperPath()).toBe(f.files.local);
    expect(visionHelperOffLine()).toBeNull();
  });
});

describe('a download mark that will not clear, and a local build', () => {
  it('the prebuilt is never executed and the local build is used', async () => {
    const f = fixture({ local: 'current' });
    useRoot(f);
    stubXattr(f.root, 'flagged', { stuck: true });
    localReader(f);
    expect(usableVisionHelperPath()).toBe(f.files.local); // was null
    expect(await ensureVisionHelperReady()).toBe(true); // was false
    expect(usableVisionHelper()).toMatchObject({ provenance: 'local', fallback: true });
    expect(f.ran()).toBe(0); // the flagged file was never run, not even for the smoke
    expect(visionHelperOffLine()).toBeNull();
    expect(warnings()).toEqual([`ℹ️  ${ocrFallbackLine('download mark present')}`]);
  });

  it('an unreadable mark is treated the same way (fail closed, fall back)', () => {
    const f = fixture({ local: 'current' });
    useRoot(f);
    stubXattr(f.root, 'broken', { stuck: true });
    expect(usableVisionHelperPath()).toBe(f.files.local);
    expect(f.ran()).toBe(0);
    expect(warnings()).toEqual([`ℹ️  ${ocrFallbackLine('download mark could not be read')}`]);
  });
});

describe('with no local build the answer is what it was: nothing, and the one sentence', () => {
  it('a prebuilt macOS kills', async () => {
    const f = fixture({ helperBody: killsItself });
    useRoot(f);
    stubXattr(f.root, 'none');
    expect(await ensureVisionHelperReady()).toBe(false);
    expect(usableVisionHelper()).toBeNull();
    expect(usableVisionHelperPath()).toBeNull();
    expect(visionHelperOffLine()).toBe(ocrReasonLine('smoke_failed', { detail: 'killed by macOS' }));
    // a Mac with the Command Line Tools can still build one, and the sentence says what the command needs
    expect(visionHelperOffLine()).toContain('./start.sh --rebuild-ocr to build one on this Mac (it needs the Command Line Tools: xcode-select --install)');
    expect(visionHelperOffLine()).toContain('if that does not help, send the output of ./start.sh --doctor to the owner');
    expect(warnings()).toEqual([`ℹ️  ${ocrReasonLine('smoke_failed', { detail: 'killed by macOS' })}`]);
  });

  it('a download mark that will not clear', () => {
    const f = fixture();
    useRoot(f);
    stubXattr(f.root, 'flagged', { stuck: true });
    expect(usableVisionHelperPath()).toBeNull();
    expect(visionHelperOffLine()).toBe(ocrReasonLine('quarantined'));
    expect(warnings()).toEqual([`ℹ️  ${ocrReasonLine('quarantined', {})}`]);
  });
});

describe('the local build is latched on its own', () => {
  it('a run of the fallback that dies the way an unrunnable file does latches IT, not the prebuilt again', async () => {
    const f = fixture({ helperBody: killsItself, local: 'current' });
    useRoot(f);
    stubXattr(f.root, 'none');
    const local = localReader(f, 'dies');
    expect(await ensureVisionHelperReady()).toBe(true);
    noteHelperExecFailure({ signal: 'SIGKILL' }, f.files.local); // the engine passes the file that ran
    await settleHelperRetest();
    expect(isHelperLatchedOff(f.files.local)).toBe(true);
    expect(f.ran()).toBe(1); // the prebuilt was not tried again
    expect(local.ran()).toBe(1); // the fresh check of the local build
    expect(usableVisionHelperPath()).toBeNull();
    expect(visionHelperPath()).toBe(''); // the synchronous readers move on to pdftotext and pdf.js
    expect(await ensureVisionHelperReady()).toBe(false);
    expect(local.ran()).toBe(1); // not offered again
  });

  it('its sentence does not send the owner to --rebuild-ocr (the shell side calls that build current and would change nothing)', async () => {
    const f = fixture({ helperBody: killsItself, local: 'current' });
    useRoot(f);
    stubXattr(f.root, 'none');
    localReader(f, 'dies');
    await ensureVisionHelperReady();
    noteHelperExecFailure({ signal: 'SIGKILL' }, f.files.local);
    await settleHelperRetest();
    const line = visionHelperOffLine();
    expect(line).toBe(ocrLocalRefusedLine('killed by macOS'));
    expect(line).toContain('./start.sh --doctor');
    expect(line).not.toContain('--rebuild-ocr');
    expect(line).not.toContain("prebuilt reader"); // it is not the prebuilt that failed now
    expect(warnings()).toHaveLength(2);
    expect(warnings()[1]).toBe(`ℹ️  ${ocrLocalRefusedLine('killed by macOS')}`);
  });

  it('one transient kill of the fallback does not latch it', async () => {
    const f = fixture({ helperBody: killsItself, local: 'current' });
    useRoot(f);
    stubXattr(f.root, 'none');
    const local = localReader(f, 'breakable');
    await ensureVisionHelperReady();
    noteHelperExecFailure({ signal: 'SIGKILL' }, f.files.local);
    await settleHelperRetest();
    expect(isHelperLatchedOff(f.files.local)).toBe(false);
    expect(local.ran()).toBe(1); // the fresh check passed
    expect(usableVisionHelperPath()).toBe(f.files.local);
    local.breakNow();
    noteHelperExecFailure({ signal: 'SIGKILL' }, f.files.local);
    await settleHelperRetest();
    expect(isHelperLatchedOff(f.files.local)).toBe(true);
  });

  it('a file the verdict does not know is never latched (a stray path from a caller)', async () => {
    const f = fixture({ helperBody: killsItself, local: 'current' });
    useRoot(f);
    stubXattr(f.root, 'none');
    localReader(f, 'dies');
    await ensureVisionHelperReady();
    noteHelperExecFailure({ signal: 'SIGKILL' }, path.join(f.root, 'somewhere-else'));
    await settleHelperRetest();
    expect(isHelperLatchedOff(f.files.local)).toBe(false);
    expect(usableVisionHelperPath()).toBe(f.files.local);
  });
});

/**
 * The closest thing to "macOS would not run the prebuilt" that needs no Gatekeeper: a 32-byte Mach-O header with a CPU
 * type no Mac has, which the KERNEL refuses (errno -86, a code Node 20 has no name for; native-helpers.test.ts measures
 * the shape). Nothing here flags or runs a real helper.
 */
onMac('a prebuilt the kernel itself refuses to run, and a local build', () => {
  /** The fixture, with its prebuilt replaced by that header and the manifest naming the header's size and hash. */
  function kernelRefused(options: Parameters<typeof fixture>[0]) {
    const f = fixture(options);
    const header = Buffer.alloc(32);
    header.writeUInt32LE(0xfeedfacf, 0);
    header.writeUInt32LE(0x99, 4);
    header.writeUInt32LE(3, 8);
    header.writeUInt32LE(2, 12);
    fs.writeFileSync(f.files.prebuilt, header, { mode: 0o755 });
    const manifest = JSON.parse(fs.readFileSync(f.files.manifest, 'utf8'));
    manifest.artifacts.visionOcr.binary = { sha256: sha(header), bytes: header.length };
    fs.writeFileSync(f.files.manifest, JSON.stringify(manifest, null, 2));
    useRoot(f);
    stubXattr(f.root, 'none');
    return f;
  }

  it('with no local build the first-use smoke RESOLVES (Node throws for this errno instead of calling back): latched, one sentence', async () => {
    const f = kernelRefused({});
    expect(await ensureVisionHelperReady()).toBe(false); // used to REJECT with "spawn Unknown system error -86", with no latch
    expect(helperLatch()).toMatchObject({ reason: 'smoke_failed', detail: 'cannot start' });
    expect(usableVisionHelperPath()).toBeNull();
    expect(visionHelperOffLine()).toBe(ocrReasonLine('smoke_failed', { detail: 'cannot start' }));
    expect(await ensureVisionHelperReady()).toBe(false); // not tried again
    expect(f.ran()).toBe(0);
    expect(warnings()).toEqual([`ℹ️  ${ocrReasonLine('smoke_failed', { detail: 'cannot start' })}`]);
  });

  it('the first-use smoke fails with that shape and the engine reads with the local build', async () => {
    const f = kernelRefused({ local: 'current' });
    const local = localReader(f);
    const engine = createVisionOcrEngine();
    expect(engine.isAvailable()).toBe(true); // the boot verdict hashes the file; nothing has run it yet
    expect((await engine.ocr('/nowhere/image.png')).text).toBe('read by the local build');
    expect(helperLatch()).toMatchObject({ reason: 'smoke_failed', detail: 'cannot start' });
    expect(usableVisionHelper()).toMatchObject({ provenance: 'local', path: f.files.local, fallback: true });
    expect(local.ran()).toBe(1);
    expect(warnings()).toEqual([`ℹ️  ${ocrFallbackLine('cannot start')}`]);
  });
});

describe('the default OCR engine (images and scanned PDFs)', () => {
  const image = '/nowhere/image.png';

  it('macOS kills the prebuilt at first use: the first image is read by the local build and OCR stays available', async () => {
    const f = fixture({ helperBody: killsItself, local: 'current' });
    useRoot(f);
    stubXattr(f.root, 'none');
    const local = localReader(f);
    const engine = createVisionOcrEngine();
    expect(engine.isAvailable()).toBe(true); // the boot verdict, before the first use
    const first = await engine.ocr(image);
    expect(first.text).toBe('read by the local build');
    expect(engine.isAvailable()).toBe(true); // was false after the first-use smoke latched the prebuilt off
    expect((await engine.ocr(image)).text).toBe('read by the local build');
    expect(f.ran()).toBe(1); // only the smoke of the prebuilt
    expect(local.ran()).toBe(2); // the two images; never smoke-run
    expect(warnings()).toEqual([`ℹ️  ${ocrFallbackLine('killed by macOS')}`]);
  });

  it('a download mark that will not clear: the prebuilt is never executed, the local build reads', async () => {
    const f = fixture({ local: 'current' });
    useRoot(f);
    stubXattr(f.root, 'flagged', { stuck: true });
    const local = localReader(f);
    const engine = createVisionOcrEngine();
    expect(engine.isAvailable()).toBe(true); // was false
    expect((await engine.ocr(image)).text).toBe('read by the local build');
    expect(f.ran()).toBe(0);
    expect(local.ran()).toBe(1);
  });

  it('a scanned PDF is rasterized and read by the local build too', async () => {
    const f = fixture({ helperBody: killsItself, local: 'current' });
    useRoot(f);
    stubXattr(f.root, 'none');
    const local = localReader(f);
    const result = await createVisionOcrEngine().ocrPdfPages('/nowhere/scan.pdf');
    expect(result.text).toBe('read by the local build');
    expect(local.ran()).toBe(2); // pdf-rasterize, then the one page
    expect(f.ran()).toBe(1);
  });

  it('with no local build the engine is unavailable with the one sentence (unchanged)', async () => {
    const f = fixture({ helperBody: killsItself });
    useRoot(f);
    stubXattr(f.root, 'none');
    const engine = createVisionOcrEngine();
    const error = await engine.ocr(image).catch((e) => e);
    expect(error).toBeInstanceOf(OcrUnavailableError);
    expect(String(error.message)).toContain(ocrReasonLine('smoke_failed', { detail: 'killed by macOS' }));
    expect(engine.isAvailable()).toBe(false);
  });

  it('when the local build dies too, OCR is off with its own sentence and nothing is run again', async () => {
    const f = fixture({ helperBody: killsItself, local: 'current' });
    useRoot(f);
    stubXattr(f.root, 'none');
    const local = localReader(f, 'dies');
    const engine = createVisionOcrEngine();
    const failure = await engine.ocr(image).catch((e) => e);
    expect(failure).toBeInstanceOf(OcrFailedError); // the run itself died
    await settleHelperRetest();
    expect(isHelperLatchedOff(f.files.local)).toBe(true);
    expect(engine.isAvailable()).toBe(false);
    const unavailable = await engine.ocr(image).catch((e) => e);
    expect(unavailable).toBeInstanceOf(OcrUnavailableError);
    expect(String(unavailable.message)).toContain(ocrLocalRefusedLine('killed by macOS'));
    expect(String(unavailable.message)).not.toContain('--rebuild-ocr');
    expect(local.ran()).toBe(2); // the image, and the fresh check; the third call ran nothing
    expect(f.ran()).toBe(1);
  });
});
