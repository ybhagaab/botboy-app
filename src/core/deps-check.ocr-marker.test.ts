/**
 * Boot messages about the OCR helper, by the kind of remembered outcome
 * (`ocr-helper-marker.ts`):
 *   - a BUILD that failed or timed out (kind failed | timeout): the build-failed sentence;
 *   - "nothing could be attempted" (kind unavailable, a reason code, the reason
 *     table's sentence): that sentence, never a build-failed one (review 1, finding 8);
 *   - nothing remembered: the resolver's own reason for the missing helper.
 * Each surface is checked per kind: the dependency report (deps-check), the
 * toolchain inventory hint, the boot warning for required tools, and index.ts.
 * Which helper exists is decided from a fixture folder (BOTBOY_TEST_NATIVE_ROOT);
 * HOME is private so the real marker is never read.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanupFixtures, fixture } from './native-helpers.testutil.js';

const { present } = vi.hoisted(() => ({ present: new Set<string>() }));
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    // pdftotext / pdftoppm are not installed on this fake Mac.
    execFileSync: (_bin: string, args: string[]) => {
      if (present.has(args[1])) return Buffer.from('/usr/bin/x');
      throw Object.assign(new Error('not found'), { status: 1 });
    },
    // Tool discovery asks each tool for its version; no real program (not even a
    // developer-tools shim) may run in a test.
    execFile: (_bin: string, _args: string[], _options: unknown, callback: (error: Error | null, result: { stdout: string; stderr: string }) => void) =>
      callback(null, { stdout: '', stderr: '' }),
  };
});
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  const controlled = (file: string): string | null => {
    if (file.endsWith('pdfjs-dist/legacy/build/pdf.mjs') || file.endsWith('scripts/pdf-text.mjs')) return 'pdf.js';
    return null;
  };
  return { ...actual, existsSync: (file: string) => { const name = controlled(String(file)); return name ? present.has(name) : actual.existsSync(file); } };
});

const { checkDependencies, visionHelperStatus } = await import('./deps-check.js');
const { formatMissingRequiredWarning, visionHelperInstallHint, TOOL_REGISTRY } = await import('./toolchain.js');
const { ocrHelperUnavailableLine, readOcrBuildFailure, readOcrUnavailable } = await import('./ocr-helper-marker.js');
const { ocrReasonLine, resetNativeHelperState } = await import('./native-helpers.js');

const ON_MAC = process.platform === 'darwin';
const FAILURE = { kind: 'failed' as const, failedAt: '2026-10-12T16:26:47.000Z', durationMs: 4213, reason: 'error: boom' };
const MISSING_READER = "OCR is off: BotBoy's prebuilt reader is missing from this folder. Run ./start.sh --update to restore it.";
const OLD_BOOTSTRAP = /npm run (bootstrap|setup)/;
const roots: string[] = [];
let savedHome: string | undefined;

/** A private HOME, optionally holding a marker, so the real one is never read. */
function fakeHome(marker: unknown | null | 'corrupt'): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'botboy-depsmarker-'));
  roots.push(home);
  if (marker !== null) {
    const file = path.join(home, '.personal-productivity-tracker', 'ocr-helper-build.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, marker === 'corrupt' ? '{ not json' : JSON.stringify(marker));
  }
  process.env.HOME = home;
  return home;
}
/** Which OCR helper this fake Mac has: none (no manifest) or a valid prebuilt one. */
function helper(kind: 'none' | 'prebuilt') {
  const f = kind === 'none' ? fixture({ manifest: 'missing', withBinary: false }) : fixture();
  process.env.BOTBOY_TEST_NATIVE_ROOT = f.root;
  resetNativeHelperState();
  return f;
}
const signature = { source: 'a'.repeat(64), swiftc: 'Apple Swift version 6.0', osBuild: '24A335' };
const failedMarker = { schema: 1, ...FAILURE, signature };
const unavailableMarker = (reasonCode: string, reason: string, prebuilt?: string) => ({
  schema: 1, kind: 'unavailable', reasonCode, failedAt: '2026-10-12T16:26:47.000Z', durationMs: null, reason,
  signature: { ...signature, swiftc: '', ...(prebuilt ? { prebuilt } : {}) },
});

beforeEach(() => {
  present.clear();
  present.add('pdf.js'); // text PDFs work: BotBoy's own pdf.js reader
  savedHome = process.env.HOME;
});
afterEach(() => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  cleanupFixtures();
  resetNativeHelperState();
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('the marker reader keeps the two kinds apart', () => {
  it('readOcrBuildFailure is a failed or timed-out BUILD only; readOcrUnavailable is the other kind only', () => {
    const readFrom = (marker: unknown) => {
      const home = fakeHome(marker as never);
      const file = path.join(home, '.personal-productivity-tracker', 'ocr-helper-build.json');
      return { failure: readOcrBuildFailure({ file }), unavailable: readOcrUnavailable({ file }) };
    };
    expect(readFrom(failedMarker)).toMatchObject({ failure: { kind: 'failed', reason: 'error: boom' }, unavailable: null });
    expect(readFrom({ ...failedMarker, kind: 'timeout' }).failure).toMatchObject({ kind: 'timeout' });
    const unavailable = readFrom(unavailableMarker('os_too_old', 'macOS too old. Update macOS.', 'f'.repeat(64)));
    expect(unavailable.failure).toBeNull();
    expect(unavailable.unavailable).toEqual({ reasonCode: 'os_too_old', reason: 'macOS too old. Update macOS.', notedAt: '2026-10-12T16:26:47.000Z', prebuilt: 'f'.repeat(64) });
    // an unavailable marker without a reason code is not this format
    expect(readFrom({ ...unavailableMarker('x', 'y'), reasonCode: undefined })).toEqual({ failure: null, unavailable: null });
    expect(readFrom('corrupt')).toEqual({ failure: null, unavailable: null });
  });
});

describe('checkDependencies with the OCR helper missing', () => {
  it.runIf(ON_MAC)('after a failed build: one true line (the build-failed sentence), no "npm run bootstrap" anywhere', () => {
    helper('none');
    fakeHome(failedMarker);
    const report = checkDependencies();
    expect(report.ok).toBe(false);
    expect(report.ocrOnly).toBe(true);
    expect(report.message).toBe(ocrHelperUnavailableLine());
    expect(report.message.split('\n')).toHaveLength(1);
    expect(report.message).not.toMatch(OLD_BOOTSTRAP);
    expect(report.message).not.toContain('Some local extraction dependencies are missing');
    const details = report.deps.filter((dep) => !dep.ok).map((dep) => dep.detail);
    expect(details).toEqual([ocrHelperUnavailableLine(), ocrHelperUnavailableLine()]); // the OCR row and the scanned-PDF row
    // Text PDFs are still read.
    expect(report.deps.find((dep) => dep.name.startsWith('pdf parsing'))).toMatchObject({ ok: true, detail: 'available (pdf.js)' });
  });

  it.runIf(ON_MAC)('with nothing remembered: the resolver\'s own reason, which names the next action (never "run npm run bootstrap")', () => {
    helper('none');
    fakeHome(null);
    const report = checkDependencies();
    expect(report.ok).toBe(false);
    expect(report.ocrOnly).toBe(true);
    expect(report.message).toBe(MISSING_READER);
    expect(report.message).not.toMatch(OLD_BOOTSTRAP);
    expect(report.message).not.toMatch(/build failed|could not be built/i);
    expect(report.deps.find((dep) => dep.name.startsWith('ocr'))!.detail).toBe(MISSING_READER);
    expect(report.deps.find((dep) => dep.name.startsWith('scanned-pdf'))!.detail).toBe(MISSING_READER);
  });

  it.runIf(ON_MAC)('with an unreadable marker: fail-open, the same resolver reason', () => {
    helper('none');
    fakeHome('corrupt');
    expect(checkDependencies().message).toBe(MISSING_READER);
    fakeHome({ ...failedMarker, schema: 7 });
    expect(checkDependencies().message).toBe(MISSING_READER);
  });

  it.runIf(ON_MAC)('a failed build does not hide other missing dependencies: they keep their list, the OCR cause is one more line', () => {
    helper('none');
    fakeHome(failedMarker);
    present.delete('pdf.js'); // pdf.js missing too
    const report = checkDependencies();
    expect(report.ocrOnly).toBe(false);
    expect(report.message).toContain('Some local extraction dependencies are missing:\n  - pdf parsing');
    expect(report.message).not.toContain('  - ocr (apple-vision helper)');
    expect(report.message.split('\n').at(-1)).toBe(ocrHelperUnavailableLine());
  });

  it.runIf(ON_MAC)('a usable prebuilt helper needs no explanation, whatever the marker says', () => {
    const f = helper('prebuilt');
    fakeHome(failedMarker);
    const report = checkDependencies();
    expect(report.ok).toBe(true);
    expect(report.ocrOnly).toBe(false);
    expect(report.message).toBe('');
    expect(report.deps.find((dep) => dep.name.startsWith('ocr'))!.detail).toBe(`found at ${f.files.prebuilt} (prebuilt)`);
  });

  it.runIf(ON_MAC)('a caller can supply the outcome and the verdict directly', () => {
    helper('none');
    fakeHome(null);
    expect(checkDependencies({ ocrFailure: FAILURE }).message).toBe(ocrHelperUnavailableLine());
    fakeHome(failedMarker);
    expect(checkDependencies({ ocrFailure: null }).message).toBe(MISSING_READER);
    const osLine = ocrReasonLine('os_too_old', { osVersion: '12.7', minMacos: '13.0' });
    const verdict = { provenance: 'none' as const, current: false, reason: 'os_too_old' as const, path: null, detail: '', osVersion: '12.7', minMacos: '13.0', binarySha256: null };
    expect(checkDependencies({ verdict, ocrFailure: null, ocrUnavailable: null }).message).toBe(osLine);
  });
});

describe('an "unavailable" outcome is never worded as a failed build (finding 8)', () => {
  it.runIf(ON_MAC)('macOS below the floor: the update-macOS sentence, on every surface', () => {
    helper('none');
    fakeHome(null);
    const osLine = ocrReasonLine('os_too_old', { osVersion: '12.7', minMacos: '13.0' });
    const verdict = { provenance: 'none' as const, current: false, reason: 'os_too_old' as const, path: null, detail: '', osVersion: '12.7', minMacos: '13.0', binarySha256: null };
    const report = checkDependencies({ verdict });
    expect(report.message).toBe(osLine);
    expect(report.message).not.toMatch(/could not be built|build failed|Command Line Tools out of date/i);
    expect(visionHelperStatus({ verdict })).toMatchObject({ ok: false, cause: 'unavailable', offLine: osLine });
    expect(visionHelperInstallHint(null, visionHelperStatus({ verdict }).offLine)).toBe(osLine);
  });

  it.runIf(ON_MAC)('a smoke run that failed for this very prebuilt file: the job\'s sentence, even though the file looks fine', () => {
    const f = helper('prebuilt');
    const sha = JSON.parse(fs.readFileSync(f.files.manifest, 'utf8')).artifacts.visionOcr.binary.sha256 as string;
    const reason = ocrReasonLine('smoke_failed', { detail: 'killed by macOS' });
    fakeHome(unavailableMarker('smoke_failed', reason, sha));
    const report = checkDependencies();
    expect(report.ok).toBe(false);
    expect(report.message).toBe(reason);
    expect(report.message).not.toMatch(/could not be built|build failed/i);
  });

  it.runIf(ON_MAC)('an outcome recorded against a DIFFERENT prebuilt file (an older release) is ignored', () => {
    helper('prebuilt');
    fakeHome(unavailableMarker('smoke_failed', ocrReasonLine('smoke_failed', {}), 'e'.repeat(64)));
    expect(checkDependencies().ok).toBe(true);
    fakeHome(unavailableMarker('smoke_failed', ocrReasonLine('smoke_failed', {}))); // no hash at all
    expect(checkDependencies().ok).toBe(true);
  });

  it.runIf(ON_MAC)('reasons the boot verdict already knows (a damaged file) are not taken from the marker', () => {
    helper('none');
    fakeHome(unavailableMarker('os_too_old', 'a stale sentence from an older run'));
    // The live resolver says the reader is missing; the stale marker does not override it.
    expect(checkDependencies().message).toBe(MISSING_READER);
  });
});

describe('the toolchain registry entry for the OCR helper', () => {
  it('the hint: a failed build says what is true; an off reason is its own sentence; otherwise the bootstrap hint', () => {
    expect(visionHelperInstallHint(null)).toBe('run "npm run bootstrap" to build it');
    expect(visionHelperInstallHint(FAILURE)).toBe(ocrHelperUnavailableLine());
    expect(visionHelperInstallHint(null, MISSING_READER)).toBe(MISSING_READER);
    expect(visionHelperInstallHint(FAILURE, MISSING_READER)).toBe(ocrHelperUnavailableLine()); // a real build failure wins
    expect(TOOL_REGISTRY.some((tool) => tool.name === 'vision-ocr')).toBe(false); // it is added by discovery, not registered
  });

  it.runIf(ON_MAC)('discovery: recommended (not required), the right hint per outcome, and a usable helper carries no hint', async () => {
    const { discoverToolchain } = await import('./toolchain.js');
    helper('none');
    fakeHome(failedMarker);
    const failed = (await discoverToolchain({ PATH: '/usr/bin:/bin' })).tools.find((tool) => tool.name === 'vision-ocr')!;
    expect(failed.requirement).toBe('recommended');
    expect(failed.path).toBeNull();
    expect(failed.installHint).toBe(ocrHelperUnavailableLine());
    fakeHome(null);
    const missing = (await discoverToolchain({ PATH: '/usr/bin:/bin' })).tools.find((tool) => tool.name === 'vision-ocr')!;
    expect(missing.installHint).toBe(MISSING_READER);
    helper('prebuilt');
    fakeHome(failedMarker);
    const built = (await discoverToolchain({ PATH: '/usr/bin:/bin' })).tools.find((tool) => tool.name === 'vision-ocr')!;
    expect(built.path).not.toBeNull();
    expect(built.installHint).toBe('run "npm run bootstrap" to build it'); // only shown when missing
  });

  it.runIf(ON_MAC)('a Mac without the helper logs no "Missing required tools" warning for it (F-C)', async () => {
    const { discoverToolchain } = await import('./toolchain.js');
    helper('none');
    fakeHome(null);
    const snapshot = await discoverToolchain({ PATH: '/usr/bin:/bin' });
    expect(snapshot.tools.find((tool) => tool.name === 'vision-ocr')!.path).toBeNull();
    const warning = formatMissingRequiredWarning(snapshot.tools);
    expect(warning ?? '').not.toContain('vision-ocr');
  });
});

describe('the boot warning about missing required tools', () => {
  const tool = (name: string, extra: Record<string, unknown> = {}) => ({
    name, purpose: name, requirement: 'required' as const, path: null, version: null, ...extra,
  });
  const ocr = tool('vision-ocr', { installHint: 'run "npm run bootstrap" to build it', internalOnly: true });
  const WARN = '\u26a0\ufe0f  Missing required tools: ';

  it('a required helper without a remembered failure: exactly the old line (kept for any caller that marks it required)', () => {
    expect(formatMissingRequiredWarning([ocr], { ocrFailure: null })).toBe(`${WARN}vision-ocr (run "npm run bootstrap" to build it) — run "npm run setup"`);
    expect(formatMissingRequiredWarning([ocr, tool('curl', { brewFormula: 'curl' })], { ocrFailure: null }))
      .toBe(`${WARN}vision-ocr (run "npm run bootstrap" to build it), curl (brew install curl) — run "npm run setup"`);
  });

  it('after a failed build: nothing about the helper (checkDependencies says it once), but other missing tools are still named', () => {
    expect(formatMissingRequiredWarning([ocr], { ocrFailure: FAILURE })).toBeNull();
    expect(formatMissingRequiredWarning([ocr, tool('curl', { brewFormula: 'curl' })], { ocrFailure: FAILURE }))
      .toBe(`${WARN}curl (brew install curl) — run "npm run setup"`);
  });

  it('says nothing when everything required is present, or the missing one is not required', () => {
    expect(formatMissingRequiredWarning([{ ...ocr, path: '/x/vision-ocr' }], { ocrFailure: null })).toBeNull();
    expect(formatMissingRequiredWarning([tool('ffmpeg', { requirement: 'optional' })], { ocrFailure: null })).toBeNull();
    expect(formatMissingRequiredWarning([{ ...ocr, requirement: 'recommended' as const }], { ocrFailure: null })).toBeNull();
  });

  it.runIf(ON_MAC)('reads the marker itself when none is supplied', () => {
    fakeHome(failedMarker);
    expect(formatMissingRequiredWarning([ocr])).toBeNull();
    fakeHome(null);
    expect(formatMissingRequiredWarning([ocr])).toContain('run "npm run setup"');
  });

  it('is what index.ts prints at boot: the OCR gap is information (no warning prefix), other gaps still warn', () => {
    const index = fs.readFileSync(new URL('../index.ts', import.meta.url), 'utf8');
    expect(index).toContain('const missingRequiredWarning = formatMissingRequiredWarning(toolchain.tools);');
    expect(index).toContain('if (missingRequiredWarning) console.warn(missingRequiredWarning);');
    expect(index).toContain("if (deps.ok) console.log('✅ Local extraction dependencies available (parsing + OCR)');");
    expect(index).toContain('else if (deps.ocrOnly) console.log(`\u2139\ufe0f  ${deps.message}`);');
    expect(index).toContain('else console.warn(`\u26a0\ufe0f  ${deps.message}`);');
    expect(index).not.toContain('Missing required tools');
  });
});
