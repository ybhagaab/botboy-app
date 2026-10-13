/**
 * The OCR helper resolver (scripts/native-prebuilt.mjs › resolveVisionHelper):
 * ONE decision table that says which helper this Mac uses (prebuilt, local, none)
 * and why, so a start never compiles, never runs a file it has not verified, and
 * every "no" names its next action.
 *
 * Fixtures are tiny shell scripts standing in for the helper (their hashes go in a
 * fixture manifest), a stub `xattr` that stands in for the download flag, and an
 * injected macOS version. No test flags or runs a real Mach-O: a flagged file
 * raises a Gatekeeper dialog on the developer's screen (design-evidence E9).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: 60_000 });

const nativeUrl = pathToFileURL(fileURLToPath(new URL('../../scripts/native-prebuilt.mjs', import.meta.url))).href;

type Verdict = {
  provenance: 'prebuilt' | 'local' | 'none'; current: boolean; reason: string | null; path: string | null;
  detail: string; osVersion: string | null; minMacos: string | null; smoke: string; entry: { archs: string[]; builtAt: string } | null;
};
type Mod = {
  resolveVisionHelper: (options?: Record<string, unknown>) => Verdict;
  ocrReasonLine: (reason: string, options?: Record<string, unknown>) => string;
  ocrDoctorLine: (verdict: Verdict, options?: Record<string, unknown>) => string;
  isUnavailableReason: (reason: string | null) => boolean;
  quarantineState: (file: string) => string;
};
const load = () => import(/* @vite-ignore */ nativeUrl) as Promise<Mod>;

const roots: string[] = [];
afterEach(() => {
  cleanupFixtures();
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

import { SOURCE, NEWER_SOURCE, cleanupFixtures, fixture, fixtureRoots, stubXattr, type FixtureOptions } from './native-helpers.testutil.js';

const mac13 = { platform: 'darwin', osVersion: '13.0' };

describe('resolveVisionHelper: the decision table', () => {
  it('R0 not macOS: none, silent reason, nothing read', async () => {
    const { resolveVisionHelper } = await load();
    const f = fixture();
    expect(resolveVisionHelper({ root: f.root, platform: 'linux' })).toMatchObject({ provenance: 'none', current: false, reason: 'not_macos', path: null });
    expect(f.ran()).toBe(0);
  });

  it('R1 prebuilt usable and source same: prebuilt, current, smoke ok', async () => {
    const { resolveVisionHelper } = await load();
    const f = fixture();
    stubXattr(f.root, 'none');
    const verdict = resolveVisionHelper({ root: f.root, ...mac13 });
    expect(verdict).toMatchObject({ provenance: 'prebuilt', current: true, reason: null, path: f.files.prebuilt, smoke: 'ok', minMacos: '13.0', osVersion: '13.0' });
    expect(f.ran()).toBe(1);
  });

  it('R2 a current local build beats a prebuilt whose source differs, and the prebuilt is never run', async () => {
    const { resolveVisionHelper } = await load();
    const f = fixture({ sourceOnDisk: NEWER_SOURCE, sourceInManifest: SOURCE, local: 'current' });
    stubXattr(f.root, 'none');
    const verdict = resolveVisionHelper({ root: f.root, ...mac13 });
    expect(verdict).toMatchObject({ provenance: 'local', current: true, reason: null, path: f.files.local });
    expect(f.ran()).toBe(0);
  });

  it('R2 also rescues a corrupt prebuilt when a current local build exists', async () => {
    const { resolveVisionHelper } = await load();
    const f = fixture({ corrupt: 'hash', local: 'current' });
    stubXattr(f.root, 'none');
    expect(resolveVisionHelper({ root: f.root, ...mac13 })).toMatchObject({ provenance: 'local', current: true });
    expect(f.ran()).toBe(0);
  });

  it('with both usable and the source the same, the prebuilt wins (developers test what teammates run)', async () => {
    const { resolveVisionHelper } = await load();
    const f = fixture({ local: 'current' });
    stubXattr(f.root, 'none');
    expect(resolveVisionHelper({ root: f.root, ...mac13 })).toMatchObject({ provenance: 'prebuilt', current: true });
  });

  it('R3 a usable prebuilt whose source differs stays in use as prebuilt_outdated', async () => {
    const { resolveVisionHelper } = await load();
    const f = fixture({ sourceOnDisk: NEWER_SOURCE, sourceInManifest: SOURCE });
    stubXattr(f.root, 'none');
    expect(resolveVisionHelper({ root: f.root, ...mac13 })).toMatchObject({ provenance: 'prebuilt', current: false, reason: 'prebuilt_outdated', path: f.files.prebuilt, smoke: 'ok' });
  });

  it('R4 an outdated local build stays in use when there is no usable prebuilt', async () => {
    const { resolveVisionHelper } = await load();
    const f = fixture({ withBinary: false, local: 'outdated' });
    expect(resolveVisionHelper({ root: f.root, ...mac13 })).toMatchObject({ provenance: 'local', current: false, reason: 'local_outdated', path: f.files.local });
  });

  it('a local build with no sidecar is judged by file time: newer than the source is current, older is outdated', async () => {
    const { resolveVisionHelper } = await load();
    const newer = fixture({ withBinary: false, manifest: 'missing', local: 'no-sidecar-newer' });
    expect(resolveVisionHelper({ root: newer.root, ...mac13 })).toMatchObject({ provenance: 'local', current: true });
    const older = fixture({ withBinary: false, manifest: 'missing', local: 'no-sidecar-older' });
    expect(resolveVisionHelper({ root: older.root, ...mac13 })).toMatchObject({ provenance: 'local', current: false, reason: 'local_outdated' });
  });
});

describe('resolveVisionHelper: R5, the first failing reason', () => {
  const cases: [string, FixtureOptions, string][] = [
    ['no manifest', { manifest: 'missing', withBinary: false }, 'manifest_missing'],
    ['an invalid manifest', { manifest: 'invalid' }, 'manifest_invalid'],
    ['no prebuilt file', { withBinary: false }, 'prebuilt_missing'],
    ['a truncated or extended prebuilt (size)', { corrupt: 'size' }, 'prebuilt_corrupt'],
    ['an edited prebuilt (hash)', { corrupt: 'hash' }, 'prebuilt_corrupt'],
    ['a prebuilt without the execute bit', { mode: 0o644 }, 'prebuilt_not_executable'],
  ];
  for (const [name, options, reason] of cases) {
    it(`${name} → ${reason}, and nothing is executed`, async () => {
      const { resolveVisionHelper } = await load();
      const f = fixture(options);
      stubXattr(f.root, 'none');
      const verdict = resolveVisionHelper({ root: f.root, ...mac13 });
      expect(verdict).toMatchObject({ provenance: 'none', current: false, reason, path: null });
      expect(f.ran()).toBe(0);
    });
  }

  it('a macOS below the floor → os_too_old, with both versions, and the file is never run', async () => {
    const { resolveVisionHelper, ocrReasonLine } = await load();
    const f = fixture();
    stubXattr(f.root, 'none');
    const verdict = resolveVisionHelper({ root: f.root, platform: 'darwin', osVersion: '12.7.6' });
    expect(verdict).toMatchObject({ provenance: 'none', reason: 'os_too_old', osVersion: '12.7.6', minMacos: '13.0' });
    expect(f.ran()).toBe(0);
    expect(ocrReasonLine('os_too_old', verdict)).toContain('macOS 12.7.6');
    expect(ocrReasonLine('os_too_old', verdict)).toContain('needs macOS 13.0 or newer');
  });

  it('an unreadable macOS version does not enforce the floor: the smoke decides', async () => {
    const { resolveVisionHelper } = await load();
    const f = fixture();
    stubXattr(f.root, 'none');
    expect(resolveVisionHelper({ root: f.root, platform: 'darwin', osVersion: null })).toMatchObject({ provenance: 'prebuilt', current: true, smoke: 'ok' });
  });

  it('reads the macOS version with sw_vers when none is injected', async () => {
    const { resolveVisionHelper } = await load();
    const f = fixture();
    stubXattr(f.root, 'none');
    const swVers = path.join(f.root, 'sw_vers-stub');
    fs.writeFileSync(swVers, '#!/bin/sh\necho 12.7.6\n', { mode: 0o755 });
    process.env.BOTBOY_TEST_SW_VERS_BIN = swVers;
    try {
      expect(resolveVisionHelper({ root: f.root, platform: 'darwin' })).toMatchObject({ reason: 'os_too_old', osVersion: '12.7.6' });
    } finally {
      delete process.env.BOTBOY_TEST_SW_VERS_BIN;
    }
  });

  it('the listed order wins when several things are wrong (os_too_old before quarantined)', async () => {
    const { resolveVisionHelper } = await load();
    const f = fixture();
    stubXattr(f.root, 'flagged');
    expect(resolveVisionHelper({ root: f.root, platform: 'darwin', osVersion: '12.0' }).reason).toBe('os_too_old');
    expect(f.ran()).toBe(0);
  });

  it('never throws: an unusable root is a verdict', async () => {
    const { resolveVisionHelper } = await load();
    const file = path.join(os.tmpdir(), `botboy-not-a-folder-${process.pid}`);
    fs.writeFileSync(file, 'x');
    roots.push(file);
    const verdict = resolveVisionHelper({ root: file, ...mac13 });
    expect(verdict.provenance).toBe('none');
    expect(typeof verdict.reason).toBe('string');
  });
});

describe('resolveVisionHelper: a flagged (quarantined) file is never executed', () => {
  it('the doctor path (no repair) reports quarantined and does not run, clear or change anything', async () => {
    const { resolveVisionHelper } = await load();
    const f = fixture();
    const xattr = stubXattr(f.root, 'flagged');
    const verdict = resolveVisionHelper({ root: f.root, ...mac13 });
    expect(verdict).toMatchObject({ provenance: 'none', reason: 'quarantined' });
    expect(f.ran()).toBe(0);
    expect(xattr.calls().every((call) => call.startsWith('-p '))).toBe(true);
    expect(fs.readFileSync(xattr.flag, 'utf8')).toBe('flagged');
  });

  it('the job path (repair) clears the flag, re-checks it, and then runs the smoke', async () => {
    const { resolveVisionHelper } = await load();
    const f = fixture();
    const xattr = stubXattr(f.root, 'flagged');
    const verdict = resolveVisionHelper({ root: f.root, ...mac13, repair: true });
    expect(verdict).toMatchObject({ provenance: 'prebuilt', current: true, smoke: 'ok' });
    expect(xattr.calls().map((call) => call.split(' ')[0])).toEqual(['-p', '-d', '-p']);
    expect(f.ran()).toBe(1);
  });

  it('a flag that cannot be cleared stays quarantined and the file is never run', async () => {
    const { resolveVisionHelper } = await load();
    const f = fixture();
    stubXattr(f.root, 'flagged', { stuck: true });
    const verdict = resolveVisionHelper({ root: f.root, ...mac13, repair: true });
    expect(verdict).toMatchObject({ provenance: 'none', reason: 'quarantined' });
    expect(f.ran()).toBe(0);
  });

  it('an xattr that cannot answer is treated as flagged (fail closed)', async () => {
    const { resolveVisionHelper } = await load();
    const f = fixture();
    stubXattr(f.root, 'broken');
    expect(resolveVisionHelper({ root: f.root, ...mac13 })).toMatchObject({ provenance: 'none', reason: 'quarantined', detail: expect.stringMatching(/could not be read/) });
    expect(f.ran()).toBe(0);
  });
});

describe('resolveVisionHelper: the smoke (T4)', () => {
  const failing: [string, (calls: string) => string, string][] = [
    ['a helper that exits 0 with no usage line', (c) => `#!/bin/sh\necho run >> '${c}'\nexit 0\n`, 'unexpected output'],
    ['a helper that exits 2 without the usage text', (c) => `#!/bin/sh\necho run >> '${c}'\necho boom >&2\nexit 2\n`, 'unexpected output'],
    ['a helper that kills itself (the way macOS kills a flagged or unsupported file)', (c) => `#!/bin/sh\necho run >> '${c}'\nkill -KILL $$\n`, 'killed by macOS'],
  ];
  for (const [name, body, detail] of failing) {
    it(`${name} → smoke_failed (${detail})`, async () => {
      const { resolveVisionHelper } = await load();
      const f = fixture({ helperBody: body });
      stubXattr(f.root, 'none');
      const verdict = resolveVisionHelper({ root: f.root, ...mac13 });
      expect(verdict).toMatchObject({ provenance: 'none', reason: 'smoke_failed', detail, smoke: 'failed' });
      expect(f.ran()).toBe(1);
    });
  }

  it('a hung helper is killed at the time limit and counts as failed', async () => {
    const { resolveVisionHelper } = await load();
    const f = fixture({ helperBody: (c) => `#!/bin/sh\necho run >> '${c}'\nexec sleep 30\n` });
    stubXattr(f.root, 'none');
    const started = Date.now();
    const verdict = resolveVisionHelper({ root: f.root, ...mac13, smokeTimeoutMs: 500 });
    expect(verdict).toMatchObject({ reason: 'smoke_failed', smoke: 'failed' });
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it('smoke "skip" runs nothing at all (the server boot verdict)', async () => {
    const { resolveVisionHelper } = await load();
    const f = fixture();
    stubXattr(f.root, 'none');
    const verdict = resolveVisionHelper({ root: f.root, ...mac13, smoke: 'skip' });
    expect(verdict).toMatchObject({ provenance: 'prebuilt', current: true, smoke: 'not run' });
    expect(f.ran()).toBe(0);
  });

  it('a failed smoke falls back to a current local build rather than losing OCR', async () => {
    const { resolveVisionHelper } = await load();
    const f = fixture({ helperBody: (c) => `#!/bin/sh\necho run >> '${c}'\nkill -KILL $$\n`, local: 'current' });
    stubXattr(f.root, 'none');
    expect(resolveVisionHelper({ root: f.root, ...mac13 })).toMatchObject({ provenance: 'local', current: true });
  });

  it('repair makes a hash-verified, non-executable prebuilt executable; without repair it is only reported', async () => {
    const { resolveVisionHelper } = await load();
    const f = fixture({ mode: 0o644 });
    stubXattr(f.root, 'none');
    expect(resolveVisionHelper({ root: f.root, ...mac13 }).reason).toBe('prebuilt_not_executable');
    expect(fs.statSync(f.files.prebuilt).mode & 0o111).toBe(0);
    expect(resolveVisionHelper({ root: f.root, ...mac13, repair: true })).toMatchObject({ provenance: 'prebuilt', current: true });
    expect(fs.statSync(f.files.prebuilt).mode & 0o111).not.toBe(0);
  });
});

describe('reason lines and the doctor row', () => {
  it('every reason names its next action, in the pinned words', async () => {
    const { ocrReasonLine } = await load();
    const root = '/some/botboy-app';
    expect(ocrReasonLine('manifest_missing', { root })).toBe("OCR is off: BotBoy's prebuilt reader is missing from this folder. Run ./start.sh --update to restore it.");
    expect(ocrReasonLine('prebuilt_missing', { root })).toBe(ocrReasonLine('manifest_missing', { root }));
    expect(ocrReasonLine('manifest_invalid', { root })).toBe("OCR is off: BotBoy's prebuilt reader does not match the release (damaged or edited). Run ./start.sh --update to restore it.");
    expect(ocrReasonLine('prebuilt_corrupt', { root })).toBe(ocrReasonLine('manifest_invalid', { root }));
    expect(ocrReasonLine('prebuilt_not_executable', { root })).toContain('./start.sh --update');
    expect(ocrReasonLine('quarantined', { root })).toContain('xattr -r -d com.apple.quarantine "/some/botboy-app/native"');
    expect(ocrReasonLine('quarantined', { root })).toContain('./start.sh --rebuild-ocr');
    expect(ocrReasonLine('smoke_failed', { detail: 'killed by macOS', root })).toContain('(killed by macOS)');
    expect(ocrReasonLine('smoke_failed', { detail: 'killed by macOS', root })).toContain('./start.sh --doctor');
    expect(ocrReasonLine('os_too_old', { osVersion: '12.7', minMacos: '13.0' })).toContain('System Settings > General > Software Update');
    for (const reason of ['manifest_missing', 'manifest_invalid', 'prebuilt_missing', 'prebuilt_corrupt', 'prebuilt_not_executable', 'os_too_old', 'quarantined', 'smoke_failed', 'resolver_error']) {
      expect(ocrReasonLine(reason, { root })).toMatch(/\.\/start\.sh|xattr|Software Update/);
      expect(ocrReasonLine(reason, { root })).not.toContain('System Settings > Software Update');
    }
  });

  it('classifies "nothing was attempted" reasons separately from a build failure', async () => {
    const { isUnavailableReason } = await load();
    for (const reason of ['manifest_missing', 'manifest_invalid', 'prebuilt_missing', 'prebuilt_corrupt', 'prebuilt_not_executable', 'os_too_old', 'quarantined', 'smoke_failed']) {
      expect(isUnavailableReason(reason)).toBe(true);
    }
    expect(isUnavailableReason('prebuilt_outdated')).toBe(false);
    expect(isUnavailableReason(null)).toBe(false);
  });

  it('prints one provenance row per verdict, never a build-failed sentence', async () => {
    const { resolveVisionHelper, ocrDoctorLine } = await load();
    const current = fixture();
    stubXattr(current.root, 'none');
    expect(ocrDoctorLine(resolveVisionHelper({ root: current.root, ...mac13 }), { root: current.root }))
      .toBe('ocr helper: prebuilt, current (universal arm64+x86_64, needs macOS 13+, built 2026-10-13 with Apple Swift 6.4); smoke ok');
    const outdated = fixture({ sourceOnDisk: NEWER_SOURCE, sourceInManifest: SOURCE });
    stubXattr(outdated.root, 'none');
    expect(ocrDoctorLine(resolveVisionHelper({ root: outdated.root, ...mac13 }), { root: outdated.root }))
      .toMatch(/^ocr helper: prebuilt, older than main\.swift in this folder; it still works \(\.\/start\.sh --rebuild-ocr builds a newer one\)/);
    const local = fixture({ withBinary: false, local: 'current' });
    expect(ocrDoctorLine(resolveVisionHelper({ root: local.root, ...mac13 }), { root: local.root })).toBe('ocr helper: local build, current (compiled on this Mac)');
    const off = fixture({ manifest: 'missing', withBinary: false });
    const line = ocrDoctorLine(resolveVisionHelper({ root: off.root, ...mac13 }), { root: off.root });
    expect(line).toMatch(/^ocr helper: OFF, OCR is off: BotBoy's prebuilt reader is missing/);
    expect(line).not.toMatch(/build failed/i);
    const flagged = fixture();
    stubXattr(flagged.root, 'flagged');
    expect(ocrDoctorLine(resolveVisionHelper({ root: flagged.root, ...mac13 }), { root: flagged.root })).toMatch(/the download mark is still on BotBoy's reader; \.\/start\.sh clears it/);
    expect(ocrDoctorLine({ provenance: 'none', current: false, reason: 'not_macos', path: null, detail: '', osVersion: null, minMacos: null, smoke: 'not run', entry: null })).toBe('ocr helper: not applicable (needs macOS)');
  });
});
