/**
 * The server's read side of the remembered OCR helper build failure, and its
 * contract with the only writer, scripts/bootstrap-deps.mjs: both sides read
 * and write the one documented JSON format. The reader is fail-open (anything
 * it cannot trust reads as "no failure remembered") and the server never
 * writes the file.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { ocrBuildMarkerPath, ocrHelperUnavailableLine, readOcrBuildFailure } from './ocr-helper-marker.js';

const roots: string[] = [];
afterEach(() => {
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});
const tempDir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'botboy-ocrmarker-'));
  roots.push(dir);
  return dir;
};

const SIGNATURE = { source: 'a'.repeat(64), swiftc: 'Apple Swift version 6.0', osBuild: '24A335' };
const GOOD = { schema: 1, kind: 'failed', failedAt: '2026-10-12T16:26:47.000Z', durationMs: 4213, reason: 'error: boom', signature: SIGNATURE };

describe('ocrHelperUnavailableLine', () => {
  it('is one line that says what is true, where to look, and what to do', () => {
    const line = ocrHelperUnavailableLine();
    expect(line).not.toContain('\n');
    expect(line).toContain('The OCR helper could not be built on this Mac');
    expect(line).toContain('images and scanned PDFs are unavailable (text PDFs still work)');
    expect(line).toContain('./start.sh --doctor');
    expect(line).toContain('Xcode Command Line Tools are out of date or half-installed');
    expect(line).toContain('System Settings > General > Software Update');
    expect(line).toContain('./start.sh --rebuild-ocr');
    expect(line).not.toContain('npm run');
  });
});

describe('readOcrBuildFailure', () => {
  it('lives in the private app folder of the home directory', () => {
    expect(ocrBuildMarkerPath('/Users/someone')).toBe('/Users/someone/.personal-productivity-tracker/ocr-helper-build.json');
    const home = tempDir();
    const saved = process.env.HOME;
    process.env.HOME = home;
    try {
      expect(ocrBuildMarkerPath()).toBe(path.join(home, '.personal-productivity-tracker', 'ocr-helper-build.json'));
    } finally {
      if (saved === undefined) delete process.env.HOME;
      else process.env.HOME = saved;
    }
  });

  it('returns the failure, without the signature the server has no use for', () => {
    const file = path.join(tempDir(), 'm.json');
    fs.writeFileSync(file, JSON.stringify(GOOD));
    expect(readOcrBuildFailure({ file })).toEqual({ kind: 'failed', failedAt: '2026-10-12T16:26:47.000Z', durationMs: 4213, reason: 'error: boom' });
    fs.writeFileSync(file, JSON.stringify({ ...GOOD, kind: 'timeout', durationMs: undefined }));
    expect(readOcrBuildFailure({ file })).toMatchObject({ kind: 'timeout', durationMs: null });
  });

  it('is fail-open: missing, corrupt, oversized, or foreign files read as no failure', () => {
    const dir = tempDir();
    const file = path.join(dir, 'm.json');
    expect(readOcrBuildFailure({ file })).toBeNull();
    const bad: Array<[string, string]> = [
      ['not json', '{ nope'],
      ['empty', ''],
      ['array', '[]'],
      ['null', 'null'],
      ['other schema', JSON.stringify({ ...GOOD, schema: 2 })],
      ['unknown kind', JSON.stringify({ ...GOOD, kind: 'crashed' })],
      ['bad date', JSON.stringify({ ...GOOD, failedAt: 'soon' })],
      ['no reason', JSON.stringify({ ...GOOD, reason: 1 })],
      ['no signature', JSON.stringify({ ...GOOD, signature: null })],
      ['oversized', JSON.stringify({ ...GOOD, reason: 'x'.repeat(20_000) })],
    ];
    for (const [name, text] of bad) {
      fs.writeFileSync(file, text);
      expect(readOcrBuildFailure({ file }), name).toBeNull();
    }
    expect(readOcrBuildFailure({ file: dir }), 'a folder').toBeNull();
  });

  it('only reads: it never creates, changes, or deletes the file or its folder', () => {
    const dir = tempDir();
    const file = path.join(dir, 'private', 'm.json');
    expect(readOcrBuildFailure({ file })).toBeNull();
    expect(fs.existsSync(path.join(dir, 'private'))).toBe(false);
    fs.mkdirSync(path.dirname(file));
    fs.writeFileSync(file, '{ corrupt');
    const before = fs.statSync(file).mtimeMs;
    expect(readOcrBuildFailure({ file })).toBeNull();
    expect(fs.readFileSync(file, 'utf8')).toBe('{ corrupt'); // a corrupt marker is left for the next build to replace
    expect(fs.statSync(file).mtimeMs).toBe(before);
    const source = fs.readFileSync(fileURLToPath(new URL('./ocr-helper-marker.ts', import.meta.url)), 'utf8');
    expect(source).not.toMatch(/writeFile|appendFile|unlink|rmSync|rename|mkdir|chmod|createWriteStream/);
  });
});

describe('contract with scripts/bootstrap-deps.mjs', () => {
  const scriptUrl = pathToFileURL(fileURLToPath(new URL('../../scripts/bootstrap-deps.mjs', import.meta.url))).href;
  type Script = {
    writeOcrMarker: (marker: Record<string, unknown>, options: { file: string }) => boolean;
    readOcrMarker: (options: { file: string }) => Record<string, unknown> | null;
    clearOcrMarker: (options: { file: string }) => void;
  };

  it('reads what the script writes, and the script reads what the server reads', async () => {
    const script = (await import(/* @vite-ignore */ scriptUrl)) as Script;
    const file = path.join(tempDir(), 'ocr-helper-build.json');
    const written = { kind: 'timeout', failedAt: new Date('2026-10-12T16:26:47.000Z').toISOString(), durationMs: 120_015, reason: 'the compiler did not finish in time', signature: SIGNATURE };
    expect(script.writeOcrMarker(written, { file })).toBe(true);
    expect(readOcrBuildFailure({ file })).toEqual({ kind: 'timeout', failedAt: written.failedAt, durationMs: 120_015, reason: written.reason });
    expect(script.readOcrMarker({ file })).toMatchObject({ schema: 1, ...written });
    // Both accept the same hand-written file, and both reject the same bad ones.
    for (const text of [JSON.stringify(GOOD), JSON.stringify({ ...GOOD, schema: 2 }), '{ nope', JSON.stringify({ ...GOOD, signature: { source: 1 } })]) {
      fs.writeFileSync(file, text);
      expect(Boolean(readOcrBuildFailure({ file })), text).toBe(Boolean(script.readOcrMarker({ file })));
    }
    script.clearOcrMarker({ file });
    expect(readOcrBuildFailure({ file })).toBeNull();
  });

  it('the documented path is the one both sides use', async () => {
    const script = (await import(/* @vite-ignore */ scriptUrl)) as { ocrMarkerPath: (home?: string) => string };
    expect(script.ocrMarkerPath('/h')).toBe(ocrBuildMarkerPath('/h'));
  });
});
