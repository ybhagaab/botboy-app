/**
 * Fixtures shared by the OCR helper resolver tests (JS and TypeScript): a package
 * folder with a fixture manifest, a fixture "helper" (a tiny shell script whose
 * hash is in the manifest), an optional local build, and a stub `xattr` for the
 * download flag. No test flags or runs a real Mach-O: a flagged file raises a
 * Gatekeeper dialog on the developer's screen (design-evidence E9).
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const fixtureRoots: string[] = [];

/** Remove every fixture folder made so far (call from afterEach). */
export function cleanupFixtures(): void {
  delete process.env.BOTBOY_TEST_XATTR_BIN;
  delete process.env.BOTBOY_TEST_NATIVE_ROOT;
  while (fixtureRoots.length) fs.rmSync(fixtureRoots.pop()!, { recursive: true, force: true });
}

export const sha = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
export const SOURCE = '// helper source\nprint("ok")\n';
export const NEWER_SOURCE = `${SOURCE}// edited in a customized checkout\n`;

export type FixtureOptions = {
  helperBody?: (calls: string) => string;
  mode?: number;
  manifest?: 'valid' | 'missing' | 'invalid';
  sourceInManifest?: string;
  withBinary?: boolean;
  corrupt?: 'size' | 'hash';
  local?: 'none' | 'current' | 'outdated' | 'no-sidecar-newer' | 'no-sidecar-older';
  sourceOnDisk?: string;
};

/** A package folder with a fixture manifest, a fixture "helper", and optional local build. */
export function fixture(options: FixtureOptions = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'botboy-resolver-'));
  fixtureRoots.push(root);
  const calls = path.join(root, 'helper-calls');
  const sourceOnDisk = options.sourceOnDisk ?? SOURCE;
  const files = {
    source: path.join(root, 'native', 'vision-ocr', 'main.swift'),
    prebuilt: path.join(root, 'native', 'vision-ocr', 'prebuilt', 'vision-ocr'),
    manifest: path.join(root, 'native', 'prebuilt-manifest.json'),
    local: path.join(root, 'native', 'vision-ocr', 'bin', 'vision-ocr'),
    sidecar: path.join(root, 'native', 'vision-ocr', 'bin', 'vision-ocr.built-from'),
  };
  for (const file of Object.values(files)) fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(files.source, sourceOnDisk);
  const helperBody = options.helperBody ?? ((c: string) => `#!/bin/sh\necho run >> '${c}'\necho '{"error":"usage: vision-ocr <imagePath> | pdf-text <pdfPath> | pdf-rasterize <pdfPath> <outDir> [dpi]"}' >&2\nexit 2\n`);
  const body = helperBody(calls);
  if (options.withBinary !== false) fs.writeFileSync(files.prebuilt, body, { mode: options.mode ?? 0o755 });
  if (options.withBinary !== false) fs.chmodSync(files.prebuilt, options.mode ?? 0o755);
  const manifest = {
    schema: 1,
    artifacts: {
      visionOcr: {
        source: { sha256: sha(options.sourceInManifest ?? SOURCE) },
        binary: { sha256: sha(body), bytes: Buffer.byteLength(body) },
        archs: ['arm64', 'x86_64'],
        minMacos: '13.0',
        signature: { kind: 'adhoc', identifier: 'com.botboy.vision-ocr' },
        toolchain: { swift: 'Apple Swift version 6.4 (swiftlang-6.4.0.34.1 clang-2100.3.34.1)', sdk: 'macosx27.0 (26A425)', ld: '27037.1' },
        builtAt: '2026-10-13',
      },
    },
  };
  if (options.corrupt === 'size') fs.appendFileSync(files.prebuilt, '# extra\n');
  if (options.corrupt === 'hash') fs.writeFileSync(files.prebuilt, body.replace('run', 'ran'), { mode: 0o755 });
  if ((options.manifest ?? 'valid') === 'valid') fs.writeFileSync(files.manifest, JSON.stringify(manifest, null, 2));
  if (options.manifest === 'invalid') fs.writeFileSync(files.manifest, '{ "schema": 1, "artifacts": { "visionOcr": { } } }');
  const local = options.local ?? 'none';
  if (local !== 'none') {
    fs.writeFileSync(files.local, '#!/bin/sh\necho local-helper >> "$0.calls"\nexit 2\n', { mode: 0o755 });
    if (local === 'current') fs.writeFileSync(files.sidecar, `${sha(sourceOnDisk)}\n`);
    if (local === 'outdated') fs.writeFileSync(files.sidecar, `${sha('some older source')}\n`);
    const past = new Date(Date.now() - 3_600_000);
    const future = new Date(Date.now() + 3_600_000);
    if (local === 'no-sidecar-newer') {
      fs.utimesSync(files.source, past, past);
      fs.utimesSync(files.local, future, future);
    }
    if (local === 'no-sidecar-older') {
      fs.utimesSync(files.source, future, future);
      fs.utimesSync(files.local, past, past);
    }
  }
  return { root, calls, files, ran: () => (fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').split('\n').filter(Boolean).length : 0) };
}

/** A stub xattr: -p reports the flag file's state, -d clears it unless `stuck`. */
export function stubXattr(root: string, state: 'flagged' | 'none' | 'broken', { stuck = false } = {}) {
  const flag = path.join(root, 'flag-state');
  fs.writeFileSync(flag, state);
  const log = path.join(root, 'xattr-calls');
  const script = path.join(root, 'xattr-stub');
  fs.writeFileSync(script, `#!/bin/sh
echo "$@" >> '${log}'
case "$1" in
  -p) case "$(cat '${flag}')" in
        flagged) echo "0081;5f5e1000;Chrome;"; exit 0;;
        broken) exit 5;;
        *) echo "xattr: No such xattr: com.apple.quarantine" >&2; exit 1;;
      esac;;
  -d) ${stuck ? 'exit 1' : `echo none > '${flag}'; exit 0`};;
esac
exit 64
`, { mode: 0o755 });
  process.env.BOTBOY_TEST_XATTR_BIN = script;
  return { flag, calls: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean) : []) };
}

