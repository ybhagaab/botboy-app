/**
 * Contract: the JavaScript resolver (scripts/native-prebuilt.mjs, used by
 * start.sh, the doctor, postinstall and the bundle builder) and its single
 * TypeScript port (src/core/native-helpers.ts, used by the server) must answer
 * identically over the same fixtures. The server cannot import the .mjs (rootDir
 * is src), which is why there are two; this test is what keeps them one rule.
 *
 * Compared: provenance, current, reason and path, for the table the boot verdict
 * covers (R0 to R5 and every reason that does not need a process: T0 to T2).
 * The download flag and the smoke run are job/first-use concerns and are fixed
 * to "clear" and "skip" in the first table. Each fixture supplies a consistent
 * pair of OS versions (macOS version for the JS side, Darwin kernel for the TS side).
 * The last block runs the smoke and the flag on BOTH sides (fix pass 1): fixing the
 * smoke to "skip" is what hid the server ignoring the local build once the prebuilt
 * was refused.
 */
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ensureVisionHelperReady,
  macosFromDarwinMajor,
  resetNativeHelperState,
  resolveVisionHelper as resolveTs,
  usableVisionHelper,
  visionHelperOffLine,
} from './native-helpers.js';
import { NEWER_SOURCE, SOURCE, cleanupFixtures, fixture, stubXattr, type FixtureOptions } from './native-helpers.testutil.js';

vi.setConfig({ testTimeout: 60_000 });

const nativeUrl = pathToFileURL(fileURLToPath(new URL('../../scripts/native-prebuilt.mjs', import.meta.url))).href;
type JsVerdict = { provenance: string; current: boolean; reason: string | null; path: string | null; minMacos: string | null; osVersion: string | null; detail: string };
type JsModule = {
  resolveVisionHelper: (options: Record<string, unknown>) => JsVerdict;
  macosFromDarwinMajor: (major: number) => string | null;
  ocrReasonLine: (reason: string, options?: Record<string, unknown>) => string;
};
const loadJs = () => import(/* @vite-ignore */ nativeUrl) as Promise<JsModule>;

afterEach(() => cleanupFixtures());

interface Scenario {
  name: string;
  options: FixtureOptions;
  /** [macOS version for the JS resolver, Darwin release for the TS port] */
  os?: [string, string];
}
const MAC13: [string, string] = ['13.0', '22.0.0'];

const scenarios: Scenario[] = [
  { name: 'R1 prebuilt usable, source same', options: {} },
  { name: 'R1 with a current local build too (prebuilt wins)', options: { local: 'current' } },
  { name: 'R2 source differs, local build current', options: { sourceOnDisk: NEWER_SOURCE, sourceInManifest: SOURCE, local: 'current' } },
  { name: 'R2 prebuilt corrupt, local build current', options: { corrupt: 'hash', local: 'current' } },
  { name: 'R3 source differs, no local build', options: { sourceOnDisk: NEWER_SOURCE, sourceInManifest: SOURCE } },
  { name: 'R3 source differs, local build outdated', options: { sourceOnDisk: NEWER_SOURCE, sourceInManifest: SOURCE, local: 'outdated' } },
  { name: 'R4 no prebuilt, local build outdated', options: { withBinary: false, local: 'outdated' } },
  { name: 'R4 no manifest, local build by file time (older than the source)', options: { manifest: 'missing', withBinary: false, local: 'no-sidecar-older' } },
  { name: 'local build by file time (newer than the source) is current', options: { manifest: 'missing', withBinary: false, local: 'no-sidecar-newer' } },
  { name: 'R5 manifest missing', options: { manifest: 'missing', withBinary: false } },
  { name: 'R5 manifest invalid', options: { manifest: 'invalid' } },
  { name: 'R5 prebuilt missing', options: { withBinary: false } },
  { name: 'R5 prebuilt size differs', options: { corrupt: 'size' } },
  { name: 'R5 prebuilt hash differs', options: { corrupt: 'hash' } },
  { name: 'R5 prebuilt not executable', options: { mode: 0o644 } },
  { name: 'R5 macOS 12.7.6 is below the floor', options: {}, os: ['12.7.6', '21.6.0'] },
  { name: 'R5 macOS 12 below the floor, local build current still wins (R2)', options: { local: 'current', sourceOnDisk: NEWER_SOURCE, sourceInManifest: SOURCE }, os: ['12.0', '21.0.0'] },
  { name: 'macOS 14', options: {}, os: ['14.4', '23.4.0'] },
  { name: 'macOS 15', options: {}, os: ['15.0', '24.0.0'] },
  { name: 'macOS 26 (Darwin 25)', options: {}, os: ['26.7.1', '25.6.0'] },
];

describe('the JavaScript resolver and the TypeScript port agree', () => {
  for (const scenario of scenarios) {
    it(scenario.name, async () => {
      const js = await loadJs();
      const f = fixture(scenario.options);
      stubXattr(f.root, 'none');
      const [macos, darwin] = scenario.os ?? MAC13;
      const fromJs = js.resolveVisionHelper({ root: f.root, platform: 'darwin', osVersion: macos, smoke: 'skip' });
      const fromTs = resolveTs({ root: f.root, platform: 'darwin', darwinRelease: darwin });
      expect({ provenance: fromTs.provenance, current: fromTs.current, reason: fromTs.reason, path: fromTs.path, minMacos: fromTs.minMacos })
        .toEqual({ provenance: fromJs.provenance, current: fromJs.current, reason: fromJs.reason, path: fromJs.path, minMacos: fromJs.minMacos });
      expect(f.ran()).toBe(0); // neither side executed anything
    });
  }

  it('a platform that is not macOS', async () => {
    const js = await loadJs();
    const f = fixture();
    expect(resolveTs({ root: f.root, platform: 'linux' })).toMatchObject({ provenance: 'none', reason: 'not_macos' });
    expect(js.resolveVisionHelper({ root: f.root, platform: 'linux' })).toMatchObject({ provenance: 'none', reason: 'not_macos' });
  });

  it('a manifest that holds a machine path is invalid on both sides', async () => {
    const js = await loadJs();
    const f = fixture();
    const manifest = JSON.parse(fs.readFileSync(f.files.manifest, 'utf8'));
    manifest.artifacts.visionOcr.toolchain.sdk = '/Users/someone/sdk';
    fs.writeFileSync(f.files.manifest, JSON.stringify(manifest));
    const fromJs = js.resolveVisionHelper({ root: f.root, platform: 'darwin', osVersion: '13.0', smoke: 'skip' });
    const fromTs = resolveTs({ root: f.root, platform: 'darwin', darwinRelease: '22.0.0' });
    expect(fromJs.reason).toBe('manifest_invalid');
    expect(fromTs.reason).toBe('manifest_invalid');
  });

  it('maps Darwin kernels to macOS versions the same way', async () => {
    const js = await loadJs();
    for (let major = 8; major <= 40; major++) expect(macosFromDarwinMajor(major), `Darwin ${major}`).toBe(js.macosFromDarwinMajor(major));
    expect(macosFromDarwinMajor(3)).toBe(js.macosFromDarwinMajor(3));
  });

  it('say the same sentence for every reason', async () => {
    const js = await loadJs();
    const { ocrReasonLine } = await import('./native-helpers.js');
    const reasons = ['manifest_missing', 'manifest_invalid', 'prebuilt_missing', 'prebuilt_corrupt', 'prebuilt_not_executable', 'os_too_old', 'quarantined', 'smoke_failed', 'resolver_error'];
    for (const reason of reasons) {
      const options = { root: '/x/botboy-app', osVersion: '12.7', minMacos: '13.0', detail: 'killed by macOS' };
      expect(ocrReasonLine(reason, options), reason).toBe(js.ocrReasonLine(reason, options));
    }
  });
});

/**
 * Fix pass 1 (review 3, finding 1). When the prebuilt is refused (macOS kills it at the smoke, or its download mark will
 * not clear), the shell resolver (smoke 'run', as the OCR job, the doctor and `--rebuild-ocr` run it) returns a local
 * build under rules R2 and R4, or nothing. The server runs the same smoke on first use and the same flag check before
 * it; here both run on the same fixture and must end with the same provenance, path and currency, and, when nothing is
 * left, the same sentence.
 */
describe('when the prebuilt would not run here, the shell resolver and the server end in the same place', () => {
  const killsItself = (calls: string) => `#!/bin/sh\necho run >> '${calls}'\nkill -KILL $$\n`;
  type Refusal = { name: string; options: FixtureOptions; flag: 'kill' | 'stuck' };
  const refusals: Refusal[] = [
    { name: 'macOS kills the prebuilt, a current local build', options: { helperBody: killsItself, local: 'current' }, flag: 'kill' },
    { name: 'macOS kills the prebuilt, an outdated local build (R4)', options: { helperBody: killsItself, local: 'outdated' }, flag: 'kill' },
    { name: 'macOS kills the prebuilt, no local build', options: { helperBody: killsItself }, flag: 'kill' },
    { name: 'a download mark that will not clear, a current local build', options: { local: 'current' }, flag: 'stuck' },
    { name: 'a download mark that will not clear, an outdated local build (R4)', options: { local: 'outdated' }, flag: 'stuck' },
    { name: 'a download mark that will not clear, no local build', options: {}, flag: 'stuck' },
    { name: 'the prebuilt source differs and the local build is current: the local build was chosen before any smoke', options: { sourceOnDisk: NEWER_SOURCE, sourceInManifest: SOURCE, local: 'current', helperBody: killsItself }, flag: 'kill' },
  ];

  for (const refusal of refusals) {
    it(refusal.name, async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      resetNativeHelperState();
      try {
        const js = await loadJs();
        const f = fixture(refusal.options);
        stubXattr(f.root, refusal.flag === 'stuck' ? 'flagged' : 'none', { stuck: refusal.flag === 'stuck' });
        process.env.BOTBOY_TEST_NATIVE_ROOT = f.root;
        const fromJs = js.resolveVisionHelper({ root: f.root, platform: 'darwin', osVersion: '13.0', smoke: 'run' });
        await ensureVisionHelperReady();
        const fromTs = usableVisionHelper();
        expect({ provenance: fromTs?.provenance ?? 'none', path: fromTs?.path ?? null, current: fromTs?.current ?? false })
          .toEqual({ provenance: fromJs.provenance, path: fromJs.path, current: fromJs.current });
        if (!fromTs) {
          // nothing is left: the same words, from the same table
          expect(visionHelperOffLine()).toBe(js.ocrReasonLine(fromJs.reason ?? '', { root: f.root, osVersion: fromJs.osVersion, minMacos: fromJs.minMacos, detail: fromJs.detail }));
        }
      } finally {
        vi.restoreAllMocks();
        resetNativeHelperState();
      }
    });
  }
});
