/**
 * Prebuilt native helpers (scripts/native-prebuilt.mjs, scripts/build-native-prebuilt.mjs).
 *
 * Nothing native is compiled on a teammate's Mac: the OCR helper and the
 * launcher are built once on the owner's Mac, committed under native/*\/prebuilt/
 * with native/prebuilt-manifest.json, and shipped through git. This suite is the
 * drift guard (editing a .swift file without rebuilding fails here), the
 * manifest rules, and the write rule of the builder (review 1, finding 4: a
 * comment-only source edit is repaired by rebuilding, it is not a dead end).
 * Mutation cases run on temporary copies, never on the repository files.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { stubUiTools } from './launcher-fixtures.testutil.js';

vi.setConfig({ testTimeout: 60_000 });

const packageRoot = fileURLToPath(new URL('../../', import.meta.url));
const nativeUrl = pathToFileURL(path.join(packageRoot, 'scripts', 'native-prebuilt.mjs')).href;
const builderPath = path.join(packageRoot, 'scripts', 'build-native-prebuilt.mjs');
const builderUrl = pathToFileURL(builderPath).href;
// The builder is dev-only: a botboy-app checkout does not have it, and its sources may be customized.
const distribution = fs.existsSync(path.join(packageRoot, '.botboy-distribution'));
const devOnly = describe.runIf(!distribution && fs.existsSync(builderPath));
const onMac = describe.runIf(process.platform === 'darwin');

type Problem = { artifact: string | null; code: string; message: string };
type Entry = {
  source: { sha256: string }; binary: { sha256: string; bytes: number }; archs: string[]; minMacos: string;
  signature: { kind: string; identifier: string }; toolchain: { swift: string; sdk: string; ld: string }; builtAt: string;
  launcherVersion?: number;
};
type Manifest = { schema: number; artifacts: Record<string, Entry> };
type Native = {
  ARTIFACTS: Record<string, { source: string; binary: string; identifier: string; label: string; launcherVersion?: number }>;
  LAUNCHER_VERSION: number;
  smokeLauncher: (file: string, options: { startScript: string; archPrefix?: string | null }) => { ok: boolean; detail: string };
  MANIFEST_REL: string;
  validateManifest: (value: unknown) => { ok: boolean; problems?: string[]; manifest?: Manifest };
  readManifest: (options: { root: string }) => { ok: boolean; reason?: string; detail?: string; manifest?: Manifest };
  verifyTierA: (options: { root: string; skipSourceCurrency?: boolean }) => { ok: boolean; problems: Problem[] };
  sha256File: (file: string) => string;
  sha256Buffer: (buffer: Buffer) => string;
  parseVersion: (text: string) => number[] | null;
  compareVersions: (a: string, b: string) => number | null;
  macosFromDarwinMajor: (major: number) => string | null;
  smokeVisionHelper: (file: string, options?: { archPrefix?: string | null }) => { ok: boolean; detail: string };
  archAnswers: (arch: string) => boolean;
};
type Builder = {
  planManifestWrite: (input: { key: string; previous?: Entry; built: Record<string, unknown> }) => { writeBinary: boolean; entry: Entry; sourceChanged: boolean };
  writeBuildResult: (input: { root: string; key: string; candidateFile: string; built: Record<string, unknown> }) => { wroteBinary: boolean; wroteManifest: boolean; sourceChanged: boolean; paths: string[] };
  serializeManifest: (manifest: Manifest) => string;
  parseVtoolBuild: (text: string) => { minos: string | null; sdk: string | null; ldVersion: string | null };
  parseOtoolLibraries: (text: string) => string[];
  isSystemLibraryPath: (library: string) => boolean;
  isSeedBuild: (id: string) => boolean;
  verifyTierC: (options: { root: string }) => { skipped: string | null; problems: { message: string }[] };
};
const loadNative = () => import(/* @vite-ignore */ nativeUrl) as Promise<Native>;
const loadBuilder = () => import(/* @vite-ignore */ builderUrl) as Promise<Builder>;

const roots: string[] = [];
afterEach(() => {
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});
const tmp = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'botboy-prebuilt-test-'));
  roots.push(dir);
  return dir;
};

/** A temp package folder holding a copy of the real manifest, binary and source. */
function copyOfRepoArtifacts(native: Native) {
  const root = tmp();
  for (const rel of [native.MANIFEST_REL, ...Object.values(native.ARTIFACTS).flatMap((spec) => [spec.binary, spec.source])]) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.copyFileSync(path.join(packageRoot, rel), path.join(root, rel));
  }
  for (const spec of Object.values(native.ARTIFACTS)) fs.chmodSync(path.join(root, spec.binary), 0o755);
  return root;
}

const sha = (text: string | Buffer) => createHash('sha256').update(text).digest('hex');

function entryFor(source: string, binary: Buffer, overrides: Partial<Entry> = {}): Entry {
  return {
    source: { sha256: sha(source) },
    binary: { sha256: sha(binary), bytes: binary.length },
    archs: ['arm64', 'x86_64'],
    minMacos: '13.0',
    signature: { kind: 'adhoc', identifier: 'com.botboy.vision-ocr' },
    toolchain: { swift: 'Apple Swift version 6.4 (swiftlang-6.4.0.34.1 clang-2100.3.34.1)', sdk: 'macosx27.0 (26A425)', ld: '27037.1' },
    builtAt: '2026-10-13',
    ...overrides,
  };
}

describe('the committed prebuilt artifacts match their manifest (drift guard)', () => {
  it('manifest valid, binaries match size and SHA-256, executable, source hash current', async () => {
    const native = await loadNative();
    const result = native.verifyTierA({ root: packageRoot, skipSourceCurrency: distribution });
    expect(result.problems).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('the manifest holds no machine path or user name', () => {
    const text = fs.readFileSync(path.join(packageRoot, 'native', 'prebuilt-manifest.json'), 'utf8');
    expect(text).not.toMatch(/\/Users\/|\/Library\/|\/home\//);
    expect(text.endsWith('\n')).toBe(true);
    expect(text.length).toBeLessThan(64 * 1024);
  });

  it('records a universal binary, a macOS 13 floor and an ad-hoc signature for the OCR helper', async () => {
    const native = await loadNative();
    const read = native.readManifest({ root: packageRoot });
    expect(read.ok).toBe(true);
    const entry = read.manifest!.artifacts.visionOcr;
    expect(entry.archs).toEqual(['arm64', 'x86_64']);
    expect(entry.minMacos).toBe('13.0');
    expect(entry.signature).toEqual({ kind: 'adhoc', identifier: 'com.botboy.vision-ocr' });
    expect(entry.binary.bytes).toBeGreaterThan(100_000);
    expect(entry.binary.bytes).toBeLessThan(400_000);
  });
});

describe('the committed launcher entry', () => {
  it('records a universal binary, a macOS 13 floor, the bundle identifier and the launcher version this code expects', async () => {
    const native = await loadNative();
    const read = native.readManifest({ root: packageRoot });
    expect(read.ok).toBe(true);
    const entry = read.manifest!.artifacts.botboyLauncher;
    expect(entry.archs).toEqual(['arm64', 'x86_64']);
    expect(entry.minMacos).toBe('13.0');
    expect(entry.signature).toEqual({ kind: 'adhoc', identifier: 'com.botboy.tracker' });
    expect(entry.launcherVersion).toBe(native.LAUNCHER_VERSION);
    expect(native.ARTIFACTS.botboyLauncher.launcherVersion).toBe(native.LAUNCHER_VERSION);
    expect(entry.binary.bytes).toBeGreaterThan(100_000);
    expect(entry.binary.bytes).toBeLessThan(400_000);
  });

  it('a manifest naming another launcher version is invalid (the code and the file must agree)', async () => {
    const native = await loadNative();
    const root = copyOfRepoArtifacts(native);
    const file = path.join(root, native.MANIFEST_REL);
    const manifest = JSON.parse(fs.readFileSync(file, 'utf8')) as Manifest;
    manifest.artifacts.botboyLauncher.launcherVersion = native.LAUNCHER_VERSION + 1;
    fs.writeFileSync(file, JSON.stringify(manifest, null, 2));
    expect(native.verifyTierA({ root }).problems.map((p) => p.code)).toEqual(['manifest_invalid']);
    delete manifest.artifacts.botboyLauncher.launcherVersion;
    fs.writeFileSync(file, JSON.stringify(manifest, null, 2));
    expect(native.readManifest({ root })).toMatchObject({ ok: false, reason: 'manifest_invalid', detail: expect.stringMatching(/launcherVersion/) });
  });
});

describe('manifest validation', () => {
  const valid = (): Manifest => ({ schema: 1, artifacts: { visionOcr: entryFor('source', Buffer.from('binary')) } });

  it('accepts a well-formed manifest', async () => {
    const { validateManifest } = await loadNative();
    expect(validateManifest(valid()).ok).toBe(true);
  });

  const mutations: [string, (m: Manifest) => void, RegExp][] = [
    ['schema 2', (m) => { m.schema = 2; }, /schema/],
    ['a source hash that is not 64 lowercase hex', (m) => { m.artifacts.visionOcr.source.sha256 = 'ABC'; }, /source\.sha256/],
    ['an uppercase binary hash', (m) => { m.artifacts.visionOcr.binary.sha256 = m.artifacts.visionOcr.binary.sha256.toUpperCase(); }, /binary\.sha256/],
    ['zero bytes', (m) => { m.artifacts.visionOcr.binary.bytes = 0; }, /binary\.bytes/],
    ['a file larger than 5 MB', (m) => { m.artifacts.visionOcr.binary.bytes = 5_000_001; }, /binary\.bytes/],
    ['no architectures', (m) => { m.artifacts.visionOcr.archs = []; }, /archs/],
    ['an unknown architecture', (m) => { m.artifacts.visionOcr.archs = ['arm64', 'ppc']; }, /archs/],
    ['a repeated architecture', (m) => { m.artifacts.visionOcr.archs = ['arm64', 'arm64']; }, /archs/],
    ['a macOS floor that is not a version', (m) => { m.artifacts.visionOcr.minMacos = '13.x'; }, /minMacos/],
    ['a signature that is not ad-hoc', (m) => { m.artifacts.visionOcr.signature.kind = 'developer-id'; }, /signature\.kind/],
    ['the wrong signing identifier', (m) => { m.artifacts.visionOcr.signature.identifier = 'com.example.other'; }, /signature\.identifier/],
    ['a missing compiler version', (m) => { m.artifacts.visionOcr.toolchain.swift = ''; }, /toolchain\.swift/],
    ['a build date in the wrong format', (m) => { m.artifacts.visionOcr.builtAt = '13/10/2026'; }, /builtAt/],
    ['a machine path in any string', (m) => { m.artifacts.visionOcr.toolchain.sdk = '/Users/someone/sdk'; }, /machine path/],
    ['a library path in any string', (m) => { m.artifacts.visionOcr.toolchain.ld = '/Library/Developer/ld'; }, /machine path/],
  ];
  for (const [name, mutate, expected] of mutations) {
    it(`rejects ${name}`, async () => {
      const { validateManifest } = await loadNative();
      const manifest = valid();
      mutate(manifest);
      const checked = validateManifest(manifest);
      expect(checked.ok).toBe(false);
      expect(checked.problems!.join('\n')).toMatch(expected);
    });
  }

  it('reads missing, oversized, non-JSON and invalid files as distinct reasons', async () => {
    const { readManifest, MANIFEST_REL } = await loadNative();
    const root = tmp();
    expect(readManifest({ root })).toMatchObject({ ok: false, reason: 'manifest_missing' });
    fs.mkdirSync(path.join(root, 'native'), { recursive: true });
    fs.writeFileSync(path.join(root, MANIFEST_REL), '{not json');
    expect(readManifest({ root })).toMatchObject({ ok: false, reason: 'manifest_invalid' });
    fs.writeFileSync(path.join(root, MANIFEST_REL), JSON.stringify({ schema: 1, artifacts: {}, pad: 'x'.repeat(70 * 1024) }));
    expect(readManifest({ root })).toMatchObject({ ok: false, reason: 'manifest_invalid', detail: expect.stringMatching(/larger than/) });
    fs.writeFileSync(path.join(root, MANIFEST_REL), JSON.stringify({ schema: 7, artifacts: {} }));
    expect(readManifest({ root })).toMatchObject({ ok: false, reason: 'manifest_invalid' });
  });
});

describe('Tier A on temporary copies (mutation checks of the drift guard)', () => {
  it('a changed source byte fails with the source_changed fix, and is ignored in a distribution checkout', async () => {
    const native = await loadNative();
    const root = copyOfRepoArtifacts(native);
    const source = path.join(root, native.ARTIFACTS.visionOcr.source);
    fs.appendFileSync(source, '// edited\n');
    const result = native.verifyTierA({ root });
    expect(result.ok).toBe(false);
    expect(result.problems.map((p) => p.code)).toEqual(['source_changed']);
    expect(result.problems[0].message).toMatch(/changed after the ocr helper was built/);
    expect(native.verifyTierA({ root, skipSourceCurrency: true }).ok).toBe(true);
  });

  it('a truncated binary is prebuilt_corrupt (size)', async () => {
    const native = await loadNative();
    const root = copyOfRepoArtifacts(native);
    const binary = path.join(root, native.ARTIFACTS.visionOcr.binary);
    fs.truncateSync(binary, fs.statSync(binary).size - 10);
    fs.chmodSync(binary, 0o755);
    expect(native.verifyTierA({ root }).problems.map((p) => p.code)).toEqual(['prebuilt_corrupt']);
  });

  it('a same-size edit is prebuilt_corrupt (hash)', async () => {
    const native = await loadNative();
    const root = copyOfRepoArtifacts(native);
    const binary = path.join(root, native.ARTIFACTS.visionOcr.binary);
    const bytes = fs.readFileSync(binary);
    bytes[bytes.length - 1] ^= 0xff;
    fs.writeFileSync(binary, bytes, { mode: 0o755 });
    fs.chmodSync(binary, 0o755);
    const problems = native.verifyTierA({ root }).problems;
    expect(problems.map((p) => p.code)).toEqual(['prebuilt_corrupt']);
    expect(problems[0].message).toMatch(/does not match the manifest/);
  });

  it('mode 644 is prebuilt_not_executable', async () => {
    const native = await loadNative();
    const root = copyOfRepoArtifacts(native);
    fs.chmodSync(path.join(root, native.ARTIFACTS.visionOcr.binary), 0o644);
    expect(native.verifyTierA({ root }).problems.map((p) => p.code)).toEqual(['prebuilt_not_executable']);
  });

  it('a deleted binary and a deleted manifest are named', async () => {
    const native = await loadNative();
    const root = copyOfRepoArtifacts(native);
    fs.rmSync(path.join(root, native.ARTIFACTS.visionOcr.binary));
    expect(native.verifyTierA({ root }).problems.map((p) => p.code)).toEqual(['prebuilt_missing']);
    fs.rmSync(path.join(root, native.MANIFEST_REL));
    expect(native.verifyTierA({ root }).problems.map((p) => p.code)).toEqual(['manifest_missing']);
  });

  it('a hand-edited manifest field is manifest_invalid or a hash mismatch, never a pass', async () => {
    const native = await loadNative();
    const root = copyOfRepoArtifacts(native);
    const file = path.join(root, native.MANIFEST_REL);
    const manifest = JSON.parse(fs.readFileSync(file, 'utf8')) as Manifest;
    manifest.artifacts.visionOcr.binary.sha256 = '0'.repeat(64);
    fs.writeFileSync(file, JSON.stringify(manifest, null, 2));
    expect(native.verifyTierA({ root }).problems.map((p) => p.code)).toContain('prebuilt_corrupt');
    manifest.artifacts.visionOcr.minMacos = 'thirteen';
    fs.writeFileSync(file, JSON.stringify(manifest, null, 2));
    expect(native.verifyTierA({ root }).problems.map((p) => p.code)).toEqual(['manifest_invalid']);
  });
});

devOnly('the builder writes the manifest so a drift can always be repaired (finding 4)', () => {
  const built = (source: string, binary: Buffer, extra: Record<string, unknown> = {}) => ({
    source: { sha256: sha(source) },
    binary: { sha256: sha(binary), bytes: binary.length },
    archs: ['arm64', 'x86_64'],
    minMacos: '13.0',
    signature: { identifier: 'com.botboy.vision-ocr' },
    toolchain: { swift: 'Apple Swift version 6.4 (swiftlang-6.4.0.34.1 clang-2100.3.34.1)', sdk: 'macosx27.0 (26A425)', ld: '27037.1' },
    builtAt: '2026-10-14',
    ...extra,
  });

  async function setup() {
    const native = await loadNative();
    const builder = await loadBuilder();
    const root = tmp();
    const source = '// helper\nlet x = 1\n';
    fs.mkdirSync(path.join(root, 'native', 'vision-ocr'), { recursive: true });
    fs.writeFileSync(path.join(root, native.ARTIFACTS.visionOcr.source), source);
    const bytes = Buffer.from('universal-binary-bytes-v1');
    const candidate = path.join(tmp(), 'vision-ocr');
    fs.writeFileSync(candidate, bytes, { mode: 0o755 });
    const first = builder.writeBuildResult({ root, key: 'visionOcr', candidateFile: candidate, built: built(source, bytes, { builtAt: '2026-10-13' }) });
    // The launcher is the second artifact: Tier A needs every artifact in the manifest.
    const launcherSource = '// launcher\nlet y = 2\n';
    fs.mkdirSync(path.join(root, 'native', 'botboy-launcher'), { recursive: true });
    fs.writeFileSync(path.join(root, native.ARTIFACTS.botboyLauncher.source), launcherSource);
    const launcherBytes = Buffer.from('universal-launcher-bytes-v1');
    const launcherCandidate = path.join(tmp(), 'botboy-launcher');
    fs.writeFileSync(launcherCandidate, launcherBytes, { mode: 0o755 });
    builder.writeBuildResult({ root, key: 'botboyLauncher', candidateFile: launcherCandidate, built: built(launcherSource, launcherBytes, { signature: { identifier: 'com.botboy.tracker' }, launcherVersion: native.LAUNCHER_VERSION }) });
    return { native, builder, root, source, bytes, candidate, first, launcherSource, launcherBytes };
  }

  it('a first build writes the binary (mode 755) and the manifest in its fixed format', async () => {
    const { native, root, first } = await setup();
    expect(first).toMatchObject({ wroteBinary: true, wroteManifest: true });
    const binary = path.join(root, native.ARTIFACTS.visionOcr.binary);
    expect(fs.statSync(binary).mode & 0o777).toBe(0o755);
    const text = fs.readFileSync(path.join(root, native.MANIFEST_REL), 'utf8');
    expect(text.endsWith('\n')).toBe(true);
    expect(text).toContain('\n  "schema": 1,\n  "artifacts": {\n    "visionOcr": {\n      "source": {');
    expect(Object.keys(JSON.parse(text).artifacts.visionOcr)).toEqual(['source', 'binary', 'archs', 'minMacos', 'signature', 'toolchain', 'builtAt']);
    // The launcher entry has the same shape plus its contract version, and artifacts keep the code's order.
    expect(Object.keys(JSON.parse(text).artifacts)).toEqual(['visionOcr', 'botboyLauncher']);
    expect(Object.keys(JSON.parse(text).artifacts.botboyLauncher)).toEqual(['source', 'binary', 'archs', 'minMacos', 'signature', 'toolchain', 'builtAt', 'launcherVersion']);
    expect(JSON.parse(text).artifacts.botboyLauncher.launcherVersion).toBe(native.LAUNCHER_VERSION);
    expect(native.verifyTierA({ root }).ok).toBe(true);
  });

  it('a rebuild with nothing changed touches neither file', async () => {
    const { native, builder, root, source, bytes, candidate } = await setup();
    const binary = path.join(root, native.ARTIFACTS.visionOcr.binary);
    const manifest = path.join(root, native.MANIFEST_REL);
    const before = { binary: fs.statSync(binary).mtimeMs, manifest: fs.readFileSync(manifest, 'utf8') };
    const again = builder.writeBuildResult({ root, key: 'visionOcr', candidateFile: candidate, built: built(source, bytes, { builtAt: '2026-12-31' }) });
    expect(again).toMatchObject({ wroteBinary: false, wroteManifest: false, sourceChanged: false });
    expect(fs.statSync(binary).mtimeMs).toBe(before.binary);
    expect(fs.readFileSync(manifest, 'utf8')).toBe(before.manifest);
  });

  it('a comment-only source edit with identical bytes changes ONLY source.sha256, and Tier A passes again', async () => {
    const { native, builder, root, source, bytes, candidate } = await setup();
    const sourceFile = path.join(root, native.ARTIFACTS.visionOcr.source);
    const manifestFile = path.join(root, native.MANIFEST_REL);
    const before = JSON.parse(fs.readFileSync(manifestFile, 'utf8')) as Manifest;
    const edited = `${source}// a comment that changes the file hash and not the binary\n`;
    fs.writeFileSync(sourceFile, edited);
    expect(native.verifyTierA({ root }).problems.map((p) => p.code)).toEqual(['source_changed']);
    const binaryBefore = fs.statSync(path.join(root, native.ARTIFACTS.visionOcr.binary));
    const repaired = builder.writeBuildResult({ root, key: 'visionOcr', candidateFile: candidate, built: built(edited, bytes, { builtAt: '2027-01-01', toolchain: { swift: 'newer', sdk: 'newer', ld: '1' } }) });
    expect(repaired).toMatchObject({ wroteBinary: false, wroteManifest: true, sourceChanged: true });
    const after = JSON.parse(fs.readFileSync(manifestFile, 'utf8')) as Manifest;
    expect(after.artifacts.visionOcr.source.sha256).toBe(sha(edited));
    // Everything else, including builtAt and the toolchain block, is held back.
    const strip = (m: Manifest) => ({ ...m.artifacts.visionOcr, source: undefined });
    expect(strip(after)).toEqual(strip(before));
    expect(fs.statSync(path.join(root, native.ARTIFACTS.visionOcr.binary)).mtimeMs).toBe(binaryBefore.mtimeMs);
    expect(native.verifyTierA({ root })).toMatchObject({ ok: true, problems: [] });
  });

  it('changed bytes refresh the binary, the toolchain block and the build date', async () => {
    const { native, builder, root, source } = await setup();
    const newBytes = Buffer.from('universal-binary-bytes-v2-longer');
    const candidate = path.join(tmp(), 'vision-ocr');
    fs.writeFileSync(candidate, newBytes, { mode: 0o755 });
    const result = builder.writeBuildResult({ root, key: 'visionOcr', candidateFile: candidate, built: built(source, newBytes, { builtAt: '2026-11-02', toolchain: { swift: 'Apple Swift version 6.5', sdk: 'macosx28.0 (27A1)', ld: '28000.1' } }) });
    expect(result).toMatchObject({ wroteBinary: true, wroteManifest: true });
    const manifest = JSON.parse(fs.readFileSync(path.join(root, native.MANIFEST_REL), 'utf8')) as Manifest;
    expect(manifest.artifacts.visionOcr).toMatchObject({ binary: { sha256: sha(newBytes), bytes: newBytes.length }, builtAt: '2026-11-02', toolchain: { swift: 'Apple Swift version 6.5' } });
    expect(fs.readFileSync(path.join(root, native.ARTIFACTS.visionOcr.binary))).toEqual(newBytes);
    expect(native.verifyTierA({ root }).ok).toBe(true);
  });

  it('planManifestWrite is pure: same binary keeps the old facts, new binary takes the new ones', async () => {
    const builder = await loadBuilder();
    const previous = entryFor('old source', Buffer.from('bytes'));
    const same = builder.planManifestWrite({ key: 'visionOcr', previous, built: built('new source', Buffer.from('bytes'), { builtAt: '2030-01-01' }) });
    expect(same.writeBinary).toBe(false);
    expect(same.entry.builtAt).toBe(previous.builtAt);
    expect(same.entry.source.sha256).toBe(sha('new source'));
    const changed = builder.planManifestWrite({ key: 'visionOcr', previous, built: built('new source', Buffer.from('other'), { builtAt: '2030-01-01' }) });
    expect(changed.writeBinary).toBe(true);
    expect(changed.entry.builtAt).toBe('2030-01-01');
  });
});

devOnly('builder parsers and the toolchain policy', () => {
  it('reads minos, sdk and the linker version from vtool output', async () => {
    const { parseVtoolBuild } = await loadBuilder();
    const text = 'x:\nLoad command 9\n      cmd LC_BUILD_VERSION\n  cmdsize 32\n platform MACOS\n    minos 13.0\n      sdk 27.0\n   ntools 1\n     tool LD\n  version 27037.1\n';
    expect(parseVtoolBuild(text)).toEqual({ minos: '13.0', sdk: '27.0', ldVersion: '27037.1' });
    expect(parseVtoolBuild('')).toEqual({ minos: null, sdk: null, ldVersion: null });
  });

  it('accepts only OS libraries from otool -L and rejects @rpath and embedded ones', async () => {
    const { parseOtoolLibraries, isSystemLibraryPath } = await loadBuilder();
    const text = 'f (architecture arm64):\n\t/usr/lib/libSystem.B.dylib (compatibility version 1.0.0, current version 1356.0.0)\n\t/System/Library/Frameworks/Vision.framework/Versions/A/Vision (compatibility version 1.0.0)\n\t@rpath/libFoo.dylib (compatibility version 1.0.0)\n\t/opt/homebrew/lib/libz.dylib (compatibility version 1.0.0)\n';
    const libraries = parseOtoolLibraries(text);
    expect(libraries).toHaveLength(4);
    expect(libraries.filter(isSystemLibraryPath)).toEqual(['/usr/lib/libSystem.B.dylib', '/System/Library/Frameworks/Vision.framework/Versions/A/Vision']);
  });

  it('refuses a seed (beta) SDK build id and accepts a release one', async () => {
    const { isSeedBuild } = await loadBuilder();
    expect(isSeedBuild('26A425')).toBe(false);
    expect(isSeedBuild('25F70')).toBe(false);
    expect(isSeedBuild('26A5378c')).toBe(true);
    expect(isSeedBuild('')).toBe(false);
  });
});

describe('small helpers', () => {
  it('compares macOS versions segment by segment and rejects text that is not a version', async () => {
    const { compareVersions, parseVersion } = await loadNative();
    expect(compareVersions('12.7.6', '13.0')).toBe(-1);
    expect(compareVersions('13', '13.0.0')).toBe(0);
    expect(compareVersions('26.7.1', '13.0')).toBe(1);
    expect(compareVersions('13.5', '13.4.9')).toBe(1);
    expect(parseVersion('13.x')).toBeNull();
    expect(parseVersion('1.2.3.4')).toBeNull();
  });

  it('maps the Darwin kernel major to the macOS major (there is no macOS 16)', async () => {
    const { macosFromDarwinMajor } = await loadNative();
    expect([20, 21, 22, 23, 24, 25, 26].map(macosFromDarwinMajor)).toEqual(['11.0', '12.0', '13.0', '14.0', '15.0', '26.0', '27.0']);
    expect(macosFromDarwinMajor(19)).toBe('10.15');
    expect(macosFromDarwinMajor(Number.NaN)).toBeNull();
    expect(macosFromDarwinMajor(3)).toBeNull();
  });

  it('this Mac maps to the macOS version sw_vers reports (major)', async () => {
    if (process.platform !== 'darwin') return;
    const { macosFromDarwinMajor } = await loadNative();
    const { execFileSync } = await import('node:child_process');
    const reported = execFileSync('/usr/bin/sw_vers', ['-productVersion'], { encoding: 'utf8' }).trim();
    const darwinMajor = Number(os.release().split('.')[0]);
    expect(macosFromDarwinMajor(darwinMajor)!.split('.')[0]).toBe(reported.split('.')[0]);
  });
});

onMac('the real prebuilt OCR helper (this Mac)', () => {
  it('prints its usage and exits 2 with no arguments, natively and under each architecture the Mac can run', async () => {
    const native = await loadNative();
    const file = path.join(packageRoot, native.ARTIFACTS.visionOcr.binary);
    expect(native.smokeVisionHelper(file)).toEqual({ ok: true, detail: 'ok' });
    for (const arch of ['arm64', 'x86_64']) {
      if (!native.archAnswers(arch)) continue;
      expect(native.smokeVisionHelper(file, { archPrefix: arch })).toEqual({ ok: true, detail: 'ok' });
    }
  });

  it('the real prebuilt launcher prints the folder it would open and exits, natively and under each architecture', async () => {
    const native = await loadNative();
    const file = path.join(packageRoot, native.ARTIFACTS.botboyLauncher.binary);
    const startScript = path.join(packageRoot, 'start.sh');
    expect(native.smokeLauncher(file, { startScript })).toEqual({ ok: true, detail: 'ok' });
    for (const arch of ['arm64', 'x86_64']) {
      if (!native.archAnswers(arch)) continue;
      expect(native.smokeLauncher(file, { startScript, archPrefix: arch })).toEqual({ ok: true, detail: 'ok' });
    }
    // A folder without an executable start.sh is not a pass: the launcher says target=none.
    expect(native.smokeLauncher(file, { startScript: path.join(tmp(), 'start.sh') })).toEqual({ ok: false, detail: 'unexpected output' });
  });

  it('is universal, minos 13.0, links only OS libraries and verifies ad-hoc signed (Tier C)', async () => {
    if (distribution) return;
    const builder = await loadBuilder();
    const checked = builder.verifyTierC({ root: packageRoot });
    if (checked.skipped) return; // no Command Line Tools on this Mac: Tier C needs lipo, vtool and otool
    expect(checked.problems).toEqual([]);
  });
});

/**
 * Review 3, finding 3. A launch from the Dock or Spotlight is HOME plus ~/.personal-productivity-tracker/app-checkout.v1
 * with NO BOTBOY_APP_START_SCRIPT, and that is the route this suite never ran with the committed binary: smokeLauncher,
 * launcher-facts and the installer all set the override. Here the bare binary (never a bundle, never `open`) is run in
 * its print-target mode, which exits before any application object exists, with stdin closed, a private HOME, a minimal
 * environment without the override, and the UI tools stubbed first on PATH (a call to one fails the test).
 */
onMac('the real prebuilt launcher through the recorded-folder route (what a Dock or Spotlight launch uses)', () => {
  const MISSING = 'target=none (no BotBoy folder is recorded)';

  /** A private HOME holding `app-checkout.v1` with the given text (or none), and the stubs that would catch a UI tool. */
  function setup(record: ((checkout: string) => string) | null) {
    const root = tmp();
    const home = path.join(root, 'home');
    const checkout = path.join(root, 'BotBoy Folder'); // a space in the path, as in a real one
    fs.mkdirSync(checkout, { recursive: true });
    fs.writeFileSync(path.join(checkout, 'start.sh'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    fs.mkdirSync(path.join(home, '.personal-productivity-tracker'), { recursive: true });
    if (record) fs.writeFileSync(path.join(home, '.personal-productivity-tracker', 'app-checkout.v1'), record(checkout));
    const ui = stubUiTools(root);
    const env = { HOME: home, PATH: ui.env.PATH, BOTBOY_APP_PRINT_TARGET: '1', LANG: 'C' };
    return { root, checkout, ui, env };
  }

  /** The binary natively, then under each architecture this Mac can run. */
  async function run(env: Record<string, string>) {
    const native = await loadNative();
    const binary = path.join(packageRoot, native.ARTIFACTS.botboyLauncher.binary);
    const { spawnSync } = await import('node:child_process');
    const options = { env, encoding: 'utf8' as const, stdio: ['ignore', 'pipe', 'pipe'] as ['ignore', 'pipe', 'pipe'], timeout: 10_000, killSignal: 'SIGKILL' as const };
    const outcomes = [{ via: 'native', ...spawnSync(binary, [], options) }];
    for (const arch of ['arm64', 'x86_64']) {
      if (native.archAnswers(arch)) outcomes.push({ via: `arch -${arch}`, ...spawnSync('/usr/bin/arch', [`-${arch}`, binary], options) });
    }
    return outcomes;
  }

  it('prints <recorded folder>/start.sh and exits 0, natively and under each architecture', async () => {
    const { checkout, ui, env } = setup((folder) => `checkout=${folder}\nwritten=2026-10-13T10:05:00\n`);
    const outcomes = await run(env);
    expect(outcomes.length).toBeGreaterThanOrEqual(2); // native, and arm64 or x86_64 where the Mac answers
    for (const outcome of outcomes) {
      expect({ via: outcome.via, status: outcome.status, stdout: outcome.stdout.trim() })
        .toEqual({ via: outcome.via, status: 0, stdout: `target=${checkout}/start.sh` });
    }
    expect(ui.allCalls()).toEqual([]); // no osascript, open, lsregister or xattr was reached
  });

  it('prints target=none and exits 3 when nothing is recorded, the folder is gone, or the path is not absolute', async () => {
    const cases: [string, ((checkout: string) => string) | null, string][] = [
      ['no record', null, MISSING],
      ['a record whose folder is missing', (folder) => `checkout=${folder}-gone\n`, 'target=none (start.sh is missing or not executable in the recorded folder)'],
      ['a relative path', () => 'checkout=BotBoy Folder\n', MISSING],
    ];
    for (const [name, record, line] of cases) {
      const { ui, env } = setup(record);
      for (const outcome of await run(env)) {
        expect({ name, via: outcome.via, status: outcome.status, stdout: outcome.stdout.trim() })
          .toEqual({ name, via: outcome.via, status: 3, stdout: line });
      }
      expect(ui.allCalls(), name).toEqual([]);
    }
  });
});
