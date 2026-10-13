/**
 * Boot messages about the OCR helper, with and without a remembered failed
 * build (`ocr-helper-marker.ts`). When the build already failed on this Mac,
 * "run npm run bootstrap" / "run npm run setup" would only repeat it, so the
 * three places that said that (deps-check, the toolchain registry, the boot
 * warning in index.ts) say what is true instead, once, on one line. With no
 * remembered failure, or an unreadable marker, every message keeps its wording.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
    if (file.endsWith('vision-ocr')) return 'vision-ocr';
    if (file.endsWith('pdfjs-dist/legacy/build/pdf.mjs') || file.endsWith('scripts/pdf-text.mjs')) return 'pdf.js';
    return null;
  };
  return { ...actual, existsSync: (file: string) => { const name = controlled(String(file)); return name ? present.has(name) : actual.existsSync(file); } };
});
const { checkDependencies } = await import('./deps-check.js');
const { formatMissingRequiredWarning, visionHelperInstallHint, TOOL_REGISTRY } = await import('./toolchain.js');
const { ocrHelperUnavailableLine } = await import('./ocr-helper-marker.js');

const ON_MAC = process.platform === 'darwin';
const OLD_OCR_DETAIL = /^missing; run "npm run bootstrap" to build the vision-ocr helper \(/;
const OLD_RASTER_DETAIL = 'missing; run "npm run bootstrap" to build the native helper';
const FAILURE = { kind: 'failed' as const, failedAt: '2026-10-12T16:26:47.000Z', durationMs: 4213, reason: 'error: boom' };
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
const goodMarker = { schema: 1, ...FAILURE, signature: { source: 'a'.repeat(64), swiftc: 'Apple Swift version 6.0', osBuild: '24A335' } };

beforeEach(() => {
  present.clear();
  present.add('pdf.js'); // text PDFs work: BotBoy's own pdf.js reader
  savedHome = process.env.HOME;
});
afterEach(() => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('checkDependencies with the OCR helper missing', () => {
  it.runIf(ON_MAC)('after a failed build: one true line, no "npm run bootstrap" anywhere', () => {
    fakeHome(goodMarker);
    const report = checkDependencies();
    expect(report.ok).toBe(false);
    expect(report.message).toBe(ocrHelperUnavailableLine());
    expect(report.message.split('\n')).toHaveLength(1);
    expect(report.message).not.toContain('npm run');
    expect(report.message).not.toContain('Some local extraction dependencies are missing');
    const details = report.deps.filter((dep) => !dep.ok).map((dep) => dep.detail);
    expect(details).toEqual([ocrHelperUnavailableLine(), ocrHelperUnavailableLine()]); // the OCR row and the scanned-PDF row
    for (const detail of details) expect(detail).not.toContain('npm run');
    // Text PDFs are still read.
    expect(report.deps.find((dep) => dep.name.startsWith('pdf parsing'))).toMatchObject({ ok: true, detail: 'available (pdf.js)' });
  });

  it.runIf(ON_MAC)('without a remembered failure: today\'s wording', () => {
    fakeHome(null);
    const report = checkDependencies();
    expect(report.ok).toBe(false);
    expect(report.deps.find((dep) => dep.name.startsWith('ocr'))!.detail).toMatch(OLD_OCR_DETAIL);
    expect(report.deps.find((dep) => dep.name.startsWith('scanned-pdf'))!.detail).toBe(OLD_RASTER_DETAIL);
    expect(report.message).toContain('Some local extraction dependencies are missing:');
    expect(report.message).toContain('  - ocr (apple-vision helper): missing; run "npm run bootstrap"');
    expect(report.message.split('\n').length).toBeGreaterThan(2);
  });

  it.runIf(ON_MAC)('with an unreadable marker: today\'s wording (fail-open)', () => {
    fakeHome('corrupt');
    expect(checkDependencies().deps.find((dep) => dep.name.startsWith('ocr'))!.detail).toMatch(OLD_OCR_DETAIL);
    fakeHome({ ...goodMarker, schema: 7 });
    expect(checkDependencies().deps.find((dep) => dep.name.startsWith('ocr'))!.detail).toMatch(OLD_OCR_DETAIL);
  });

  it.runIf(ON_MAC)('a failed build does not hide other missing dependencies: they keep their list, the OCR cause is one more line', () => {
    fakeHome(goodMarker);
    present.delete('pdf.js'); // pdf.js missing too
    const report = checkDependencies();
    expect(report.message).toContain('Some local extraction dependencies are missing:\n  - pdf parsing');
    expect(report.message).not.toContain('  - ocr (apple-vision helper)');
    expect(report.message.split('\n').at(-1)).toBe(ocrHelperUnavailableLine());
  });

  it.runIf(ON_MAC)('a built helper needs no explanation, whatever the marker says', () => {
    fakeHome(goodMarker);
    present.add('vision-ocr');
    const report = checkDependencies();
    expect(report.ok).toBe(true);
    expect(report.message).toBe('');
  });

  it.runIf(ON_MAC)('a caller can supply the failure directly', () => {
    fakeHome(null);
    expect(checkDependencies({ ocrFailure: FAILURE }).message).toBe(ocrHelperUnavailableLine());
    fakeHome(goodMarker);
    expect(checkDependencies({ ocrFailure: null }).deps.find((dep) => dep.name.startsWith('ocr'))!.detail).toMatch(OLD_OCR_DETAIL);
  });
});

describe('the toolchain registry entry for the OCR helper', () => {
  it('after a failed build the hint says what is true; otherwise it keeps "npm run bootstrap"', () => {
    expect(visionHelperInstallHint(null)).toBe('run "npm run bootstrap" to build it');
    expect(visionHelperInstallHint(FAILURE)).toBe(ocrHelperUnavailableLine());
    expect(TOOL_REGISTRY.some((tool) => tool.name === 'vision-ocr')).toBe(false); // it is added by discovery, not registered
  });

  it.runIf(ON_MAC)('discovery puts the right hint on the vision-ocr entry', async () => {
    const { discoverToolchain } = await import('./toolchain.js');
    fakeHome(goodMarker);
    const failed = (await discoverToolchain({ PATH: '/usr/bin:/bin' })).tools.find((tool) => tool.name === 'vision-ocr')!;
    expect(failed.path).toBeNull();
    expect(failed.installHint).toBe(ocrHelperUnavailableLine());
    fakeHome(null);
    expect((await discoverToolchain({ PATH: '/usr/bin:/bin' })).tools.find((tool) => tool.name === 'vision-ocr')!.installHint).toBe('run "npm run bootstrap" to build it');
    // A helper that exists is not "missing", so the failure never shows on it.
    fakeHome(goodMarker);
    present.add('vision-ocr');
    const built = (await discoverToolchain({ PATH: '/usr/bin:/bin' })).tools.find((tool) => tool.name === 'vision-ocr')!;
    expect(built.path).not.toBeNull();
    expect(built.installHint).toBe('run "npm run bootstrap" to build it');
  });
});

describe('the boot warning about missing required tools', () => {
  const tool = (name: string, extra: Record<string, unknown> = {}) => ({
    name, purpose: name, requirement: 'required' as const, path: null, version: null, ...extra,
  });
  const ocr = tool('vision-ocr', { installHint: 'run "npm run bootstrap" to build it', internalOnly: true });
  const WARN = '\u26a0\ufe0f  Missing required tools: ';

  it('without a remembered failure: exactly today\'s line', () => {
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
  });

  it.runIf(ON_MAC)('reads the marker itself when none is supplied', () => {
    fakeHome(goodMarker);
    expect(formatMissingRequiredWarning([ocr])).toBeNull();
    fakeHome(null);
    expect(formatMissingRequiredWarning([ocr])).toContain('run "npm run setup"');
  });

  it('is what index.ts prints at boot', () => {
    const index = fs.readFileSync(new URL('../index.ts', import.meta.url), 'utf8');
    expect(index).toContain('const missingRequiredWarning = formatMissingRequiredWarning(toolchain.tools);');
    expect(index).toContain('if (missingRequiredWarning) console.warn(missingRequiredWarning);');
    expect(index).toContain('if (!deps.ok) console.warn(`\u26a0\ufe0f  ${deps.message}`);');
    expect(index).not.toContain('Missing required tools');
  });
});
