/**
 * The server's half of the OCR helper decision: which helper does this process
 * run, and may it run it at all?
 *
 * The helper ships PREBUILT (native/vision-ocr/prebuilt, one universal ad-hoc
 * signed file beside native/prebuilt-manifest.json). The decision table is
 * written once, in scripts/native-prebuilt.mjs › resolveVisionHelper (it serves
 * start.sh, the doctor, npm's postinstall and the bundle builder). This file is
 * its single TypeScript port: the server cannot import the .mjs (rootDir is
 * src, the same reason src/core/ocr-helper-marker.ts duplicates the marker
 * reader), and src/core/native-helpers.contract.test.ts runs both over the same
 * fixtures so they cannot drift apart.
 *
 * Boot verdict: tiers T0 to T2 only (file, size, SHA-256, execute bit, source
 * currency, macOS floor from the Darwin kernel version). No process is spawned
 * and nothing waits, so a start gains no measurable work.
 *
 * Before the FIRST exec of a prebuilt, in this process, on the async AND the
 * synchronous path: T3 (download flag). A flagged file is cleared when
 * possible and NEVER executed while the flag stays: macOS kills it about 6 s
 * after the exec and can raise a dialog whose default button is Move to Trash
 * (design-evidence E9). T4 (a smoke run with no arguments) runs once per
 * process on the async path only, because a synchronous smoke would hold the
 * event loop.
 *
 * Exec-failure latch: any later failure that has the SHAPE of "the system would
 * not run this file" (never a helper's own non-zero exit with JSON on stderr)
 * triggers one fresh T3 + T4. If that fails the helper is latched off for the
 * process and one line naming the next action is logged. A single transient
 * kill does not disable OCR, and a blocked file is not retried on every PDF.
 *
 * A prebuilt that may not run here (latched off, or its download flag will not
 * clear) is not the end of OCR when this Mac also holds a local build: after a
 * failed smoke the shell resolver (start.sh, the doctor, --rebuild-ocr) returns
 * that build (rules R2 and R4), and so does the server, so the three agree. The
 * local build was compiled on this Mac, so it is neither flag-checked nor
 * smoke-run; it has a latch of its own if a run of it dies the way an
 * unrunnable file does. Only when nothing is left is OCR off.
 *
 * Error shape, measured on Node 20.19.0: a Mach-O the kernel refuses to run
 * (unsupported CPU type) fails with errno -86 and code 'Unknown system error
 * -86' (async syscall 'spawn', sync 'spawnSync <path>'); util.getSystemErrorMap()
 * has no entry for -8 or -86, so matching ENOEXEC/EBADARCH by name can never
 * fire. A killed child has `signal` set (including Node's own timeout kill). A
 * helper that ran and said no has a numeric exit status and no errno.
 *
 * Test hooks (production never sets them): BOTBOY_TEST_NATIVE_ROOT,
 * BOTBOY_TEST_XATTR_BIN.
 */
import { execFile, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export type HelperProvenance = 'prebuilt' | 'local' | 'none';

export type HelperReason =
  | 'not_macos' | 'manifest_missing' | 'manifest_invalid' | 'prebuilt_missing' | 'prebuilt_corrupt'
  | 'prebuilt_not_executable' | 'os_too_old' | 'quarantined' | 'smoke_failed'
  | 'prebuilt_outdated' | 'local_outdated' | 'resolver_error';

export interface LocalBuild {
  path: string;
  /** Built from the current main.swift (rule R2); false is rule R4: outdated, but it still works. */
  current: boolean;
}

export interface HelperVerdict {
  provenance: HelperProvenance;
  /** A usable helper built from the current source. */
  current: boolean;
  reason: HelperReason | null;
  /** Absolute path of the helper to run, or null. */
  path: string | null;
  detail: string;
  /** The macOS version used for the floor check (from the Darwin kernel), or null. */
  osVersion: string | null;
  minMacos: string | null;
  /** The manifest's binary hash (what the prebuilt must be), when there is a valid manifest. */
  binarySha256: string | null;
  /**
   * The local build on disk (an executable file), whether or not this verdict chose it. The boot verdict ranks the
   * prebuilt first and never runs it; this is where the server falls back to if the prebuilt turns out not to run.
   */
  localBuild: LocalBuild | null;
}

export interface ResolveOptions {
  root?: string;
  platform?: NodeJS.Platform;
  /** os.release(), for example "25.6.0". Defaults to the running kernel. */
  darwinRelease?: string;
}

const MANIFEST_REL = path.join('native', 'prebuilt-manifest.json');
const PREBUILT_REL = path.join('native', 'vision-ocr', 'prebuilt', 'vision-ocr');
const SOURCE_REL = path.join('native', 'vision-ocr', 'main.swift');
const LOCAL_REL = path.join('native', 'vision-ocr', 'bin', 'vision-ocr');
const SIDECAR_REL = path.join('native', 'vision-ocr', 'bin', 'vision-ocr.built-from');
const QUARANTINE_ATTRIBUTE = 'com.apple.quarantine';
const OCR_USAGE_TEXT = 'usage: vision-ocr';
const MAX_MANIFEST_BYTES = 64 * 1024;
const TOOL_TIMEOUT_MS = 15_000;
const SMOKE_TIMEOUT_MS = 20_000;
/** How long a "still flagged" answer is trusted before xattr is asked again. */
const BLOCKED_RECHECK_MS = 60_000;

const HEX64 = /^[0-9a-f]{64}$/;
const VERSION_TEXT = /^\d+(\.\d+){0,2}$/;
const BUILT_AT = /^\d{4}-\d{2}-\d{2}$/;
const KNOWN_ARCHS = ['arm64', 'x86_64'];
const VISION_IDENTIFIER = 'com.botboy.vision-ocr';

function packageRoot(): string {
  const override = process.env.BOTBOY_TEST_NATIVE_ROOT;
  if (override && path.isAbsolute(override)) return override;
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
}

function xattrBin(): string {
  const override = process.env.BOTBOY_TEST_XATTR_BIN;
  return override && path.isAbsolute(override) ? override : '/usr/bin/xattr';
}

// ── versions ─────────────────────────────────────────────────────────────────

/** The macOS version for a Darwin kernel major: 22 is 13, 24 is 15, 25 is 26 (there is no macOS 16). */
export function macosFromDarwinMajor(darwinMajor: number): string | null {
  if (!Number.isInteger(darwinMajor) || darwinMajor < 8) return null;
  if (darwinMajor >= 25) return `${darwinMajor + 1}.0`;
  if (darwinMajor >= 20) return `${darwinMajor - 9}.0`;
  return `10.${darwinMajor - 4}`;
}

function macosFromRelease(release: string): string | null {
  const major = Number.parseInt(String(release).split('.')[0] ?? '', 10);
  return macosFromDarwinMajor(major);
}

function majorOf(version: string): number {
  return Number.parseInt(version.split('.')[0] ?? '', 10);
}

// ── manifest ─────────────────────────────────────────────────────────────────

interface ManifestEntry {
  source: { sha256: string };
  binary: { sha256: string; bytes: number };
  archs: string[];
  minMacos: string;
}

function withinText(value: unknown, max = 200): boolean {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}

function collectStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) value.forEach((entry) => collectStrings(entry, out));
  else if (value && typeof value === 'object') Object.values(value as Record<string, unknown>).forEach((entry) => collectStrings(entry, out));
  return out;
}

/** The same rules as scripts/native-prebuilt.mjs › validateManifest for the OCR entry (fail closed). */
function validEntry(entry: unknown): entry is ManifestEntry {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
  const e = entry as Record<string, any>;
  if (!HEX64.test(e.source?.sha256 ?? '') || !HEX64.test(e.binary?.sha256 ?? '')) return false;
  const bytes = e.binary?.bytes;
  if (!Number.isInteger(bytes) || bytes < 1 || bytes > 5_000_000) return false;
  const archs = e.archs;
  if (!Array.isArray(archs) || archs.length === 0 || new Set(archs).size !== archs.length || archs.some((arch: unknown) => !KNOWN_ARCHS.includes(String(arch)))) return false;
  if (typeof e.minMacos !== 'string' || !VERSION_TEXT.test(e.minMacos)) return false;
  if (e.signature?.kind !== 'adhoc' || !withinText(e.signature?.identifier) || e.signature.identifier !== VISION_IDENTIFIER) return false;
  if (!withinText(e.toolchain?.swift) || !withinText(e.toolchain?.sdk)) return false;
  if (typeof e.toolchain?.ld !== 'string' || e.toolchain.ld.length > 200) return false;
  if (typeof e.builtAt !== 'string' || !BUILT_AT.test(e.builtAt)) return false;
  return true;
}

type ManifestRead = { ok: true; entry: ManifestEntry } | { ok: false; reason: 'manifest_missing' | 'manifest_invalid'; detail: string };

function readManifest(root: string): ManifestRead {
  const file = path.join(root, MANIFEST_REL);
  let text: string;
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile()) return { ok: false, reason: 'manifest_missing', detail: 'the manifest is not a file' };
    if (stat.size > MAX_MANIFEST_BYTES) return { ok: false, reason: 'manifest_invalid', detail: 'the manifest is too large' };
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return { ok: false, reason: 'manifest_missing', detail: 'the manifest does not exist' };
    return { ok: false, reason: 'manifest_invalid', detail: 'the manifest cannot be read' };
  }
  let value: any;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'manifest_invalid', detail: 'the manifest is not valid JSON' };
  }
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.schema !== 1) return { ok: false, reason: 'manifest_invalid', detail: 'unknown schema' };
  if (!value.artifacts || typeof value.artifacts !== 'object' || Array.isArray(value.artifacts)) return { ok: false, reason: 'manifest_invalid', detail: 'artifacts is missing' };
  if (collectStrings(value).some((s) => s.includes('/Users/') || s.includes('/Library/'))) return { ok: false, reason: 'manifest_invalid', detail: 'a manifest string holds a machine path' };
  if (value.artifacts.visionOcr === undefined || !validEntry(value.artifacts.visionOcr)) return { ok: false, reason: 'manifest_invalid', detail: 'the OCR helper entry is missing or invalid' };
  return { ok: true, entry: value.artifacts.visionOcr as ManifestEntry };
}

// ── files ────────────────────────────────────────────────────────────────────

function sha256File(file: string): string {
  try {
    return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  } catch {
    return '';
  }
}

function isExecutableFile(file: string): boolean {
  try {
    if (!fs.statSync(file).isFile()) return false;
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function localHelper(root: string, sourceSha: string): { state: 'absent' | 'current' | 'outdated'; file: string } {
  const file = path.join(root, LOCAL_REL);
  if (!isExecutableFile(file)) return { state: 'absent', file };
  let recorded = '';
  try {
    recorded = fs.readFileSync(path.join(root, SIDECAR_REL), 'utf8').trim();
  } catch {
    // no sidecar: the file-time rule below
  }
  let current = true;
  if (recorded) {
    current = sourceSha === '' || recorded === sourceSha;
  } else {
    try {
      current = !(fs.statSync(path.join(root, SOURCE_REL)).mtimeMs > fs.statSync(file).mtimeMs);
    } catch {
      current = true;
    }
  }
  return { state: current ? 'current' : 'outdated', file };
}

// ── the decision (T0 to T2, no spawn) ────────────────────────────────────────

/**
 * Decide which helper this process uses. Never throws. The table and the reason
 * order are those of scripts/native-prebuilt.mjs (R0 to R5); the smoke and the
 * download flag are not part of this verdict (see the file header).
 */
export function resolveVisionHelper(options: ResolveOptions = {}): HelperVerdict {
  const platform = options.platform ?? process.platform;
  const root = options.root ?? packageRoot();
  const result = (provenance: HelperProvenance, current: boolean, reason: HelperReason | null, extra: Partial<HelperVerdict> = {}): HelperVerdict => ({
    provenance, current, reason, path: null, detail: '', osVersion: null, minMacos: null, binarySha256: null, localBuild: null, ...extra,
  });
  if (platform !== 'darwin') return result('none', false, 'not_macos');
  try {
    const sourceSha = sha256File(path.join(root, SOURCE_REL));
    const osVersion = macosFromRelease(options.darwinRelease ?? os.release());
    const local = localHelper(root, sourceSha);
    const manifest = readManifest(root);
    let reason: HelperReason | null = null;
    let detail = '';
    let prebuiltFile = path.join(root, PREBUILT_REL);
    let entry: ManifestEntry | null = null;
    if (!manifest.ok) {
      reason = manifest.reason;
      detail = manifest.detail;
    } else {
      entry = manifest.entry;
      let stat: fs.Stats | null = null;
      try {
        stat = fs.statSync(prebuiltFile);
      } catch {
        // missing
      }
      if (!stat || !stat.isFile()) reason = 'prebuilt_missing';
      else if (stat.size !== entry.binary.bytes) reason = 'prebuilt_corrupt';
      else if (sha256File(prebuiltFile) !== entry.binary.sha256) reason = 'prebuilt_corrupt';
      else if (!isExecutableFile(prebuiltFile)) reason = 'prebuilt_not_executable';
      else if (osVersion && majorOf(osVersion) < majorOf(entry.minMacos)) reason = 'os_too_old';
    }
    const localBuild: LocalBuild | null = local.state === 'absent' ? null : { path: local.file, current: local.state === 'current' };
    const common = { osVersion, minMacos: entry?.minMacos ?? null, binarySha256: entry?.binary.sha256 ?? null, localBuild };
    const srcSame = !entry || sourceSha === '' || sourceSha === entry.source.sha256;
    if (!reason && srcSame) return result('prebuilt', true, null, { ...common, path: prebuiltFile });
    if (local.state === 'current') return result('local', true, null, { ...common, path: local.file });
    if (!reason) return result('prebuilt', false, 'prebuilt_outdated', { ...common, path: prebuiltFile });
    if (local.state === 'outdated') return result('local', false, 'local_outdated', { ...common, path: local.file });
    return result('none', false, reason, { ...common, detail });
  } catch (error) {
    return result('none', false, 'resolver_error', { detail: String((error as Error)?.message ?? error).slice(0, 200) });
  }
}

// ── words for the owner (the same table as scripts/native-prebuilt.mjs › ocrReasonLine) ──

export function ocrReasonLine(reason: string, detail: { osVersion?: string | null; minMacos?: string | null; detail?: string; root?: string } = {}): string {
  const root = detail.root ?? packageRoot();
  switch (reason) {
    case 'os_too_old':
      return `Text reading from images and scanned PDFs (OCR) is off: this Mac runs macOS ${detail.osVersion ?? 'older than the minimum'} and BotBoy's reader needs macOS ${detail.minMacos ?? '13'} or newer. Update macOS in System Settings > General > Software Update (or install the Command Line Tools with xcode-select --install, then run ./start.sh --rebuild-ocr).`;
    case 'manifest_missing':
    case 'prebuilt_missing':
      return "OCR is off: BotBoy's prebuilt reader is missing from this folder. Run ./start.sh --update to restore it.";
    case 'manifest_invalid':
    case 'prebuilt_corrupt':
      return "OCR is off: BotBoy's prebuilt reader does not match the release (damaged or edited). Run ./start.sh --update to restore it.";
    case 'prebuilt_not_executable':
      return "OCR is off: macOS will not let BotBoy run its reader (file permissions). Move BotBoy to a folder you can write to, or run ./start.sh --update.";
    case 'quarantined':
      return `OCR is off: macOS marked BotBoy's reader as downloaded from the internet and the mark could not be cleared. Run: xattr -r -d ${QUARANTINE_ATTRIBUTE} "${path.join(root, 'native')}" and then ./start.sh --rebuild-ocr.`;
    case 'smoke_failed':
      return `OCR is off: macOS would not run BotBoy's prebuilt reader on this Mac (${detail.detail || 'cannot start'}). Run ./start.sh --rebuild-ocr to build one on this Mac (it needs the Command Line Tools: xcode-select --install); if that does not help, send the output of ./start.sh --doctor to the owner.`;
    case 'resolver_error':
      return 'OCR status could not be worked out. Run ./start.sh --doctor and send the output to the owner.';
    default:
      return 'OCR is off for a reason BotBoy does not know. Run ./start.sh --doctor.';
  }
}

/**
 * Server log only: the prebuilt reader would not run here, but a reader built on this Mac takes over, so OCR is not off
 * (the doctor says the same as `ocr helper: local build`). No instruction: nothing is wrong that the owner has to fix.
 */
export function ocrFallbackLine(detail: string): string {
  return `The prebuilt OCR reader would not run here (${detail || 'cannot start'}); using the one built on this Mac.`;
}

/**
 * OCR is off because macOS would not run the reader built on this Mac. It does not say `./start.sh --rebuild-ocr`: the
 * shell side judges that build current, so the command would end in "OCR helper ready" and change nothing.
 */
export function ocrLocalRefusedLine(detail: string): string {
  return `OCR is off: macOS would not run the reader built on this Mac (${detail || 'cannot start'}). Send the output of ./start.sh --doctor to the owner.`;
}

// ── the cached verdict ───────────────────────────────────────────────────────

function fileSignature(file: string): string {
  try {
    const stat = fs.statSync(file);
    return `${stat.size}:${stat.mtimeMs}`;
  } catch {
    return 'absent';
  }
}

let cached: { key: string; verdict: HelperVerdict } | null = null;

/**
 * The verdict for this process, recomputed only when one of the five files
 * changed (a local build that appears twenty seconds after boot is picked up).
 */
export function currentVisionHelper(): HelperVerdict {
  const root = packageRoot();
  const key = [root, MANIFEST_REL, PREBUILT_REL, LOCAL_REL, SIDECAR_REL, SOURCE_REL].map((rel, index) => (index === 0 ? rel : fileSignature(path.join(root, rel)))).join('|');
  if (cached && cached.key === key) return cached.verdict;
  const verdict = resolveVisionHelper({ root });
  cached = { key, verdict };
  return verdict;
}

// ── T3: the download flag ────────────────────────────────────────────────────

type FlagState = 'none' | 'flagged' | 'unknown';

function quarantineState(file: string): FlagState {
  try {
    const result = spawnSync(xattrBin(), ['-p', QUARANTINE_ATTRIBUTE, file], { encoding: 'utf8', timeout: TOOL_TIMEOUT_MS, killSignal: 'SIGKILL', stdio: ['ignore', 'pipe', 'pipe'] });
    if (result.error || typeof result.status !== 'number') return 'unknown';
    if (result.status === 0) return 'flagged';
    if (result.status === 1) return 'none';
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

function clearAndRecheck(file: string): FlagState {
  try {
    spawnSync(xattrBin(), ['-d', QUARANTINE_ATTRIBUTE, file], { encoding: 'utf8', timeout: TOOL_TIMEOUT_MS, killSignal: 'SIGKILL', stdio: 'ignore' });
  } catch {
    // the re-check decides
  }
  return quarantineState(file);
}

// ── process state ────────────────────────────────────────────────────────────

interface Latch {
  reason: HelperReason;
  detail: string;
  /** The helper file the latch refused (the prebuilt or the local build). */
  file: string;
}

const state: {
  /** T3 result for the prebuilt at this file signature. */
  flagCheck: { signature: string; clear: boolean; at: number } | null;
  smoke: { signature: string; promise: Promise<boolean> } | null;
  smokeOk: string | null;
  /** Every helper file this process gave up on, in order: at most the prebuilt and the local build. */
  latches: Latch[];
  retest: Promise<void> | null;
  warned: Set<string>;
} = { flagCheck: null, smoke: null, smokeOk: null, latches: [], retest: null, warned: new Set() };

/** Forget everything this process learned about the helper (tests, and after a restore). */
export function resetNativeHelperState(): void {
  cached = null;
  state.flagCheck = null;
  state.smoke = null;
  state.smokeOk = null;
  state.latches = [];
  state.retest = null;
  state.warned = new Set();
}

/** The prebuilt helper file under the package root the resolver uses. */
function prebuiltFile(): string {
  return path.join(packageRoot(), PREBUILT_REL);
}

/** True when this process latched `file` off: a run died the way an unrunnable file does and a fresh check failed too. */
export function isHelperLatchedOff(file: string): boolean {
  return state.latches.some((entry) => entry.file === file);
}

/**
 * The local build to use when the prebuilt may not be (rules R2 and R4 of the shell resolver): present and executable
 * (the verdict only records such a file), and not itself latched. Only a verdict that chose the prebuilt has one to
 * fall back to; a verdict that chose the local build already uses it.
 */
function localFallback(verdict: HelperVerdict | undefined): LocalBuild | null {
  const local = verdict?.provenance === 'prebuilt' ? verdict.localBuild : null;
  return local && !isHelperLatchedOff(local.path) ? local : null;
}

function warnLine(key: string, line: string): void {
  if (state.warned.has(key)) return;
  state.warned.add(key);
  console.warn(`ℹ️  ${line}`);
}

function warnOnce(reason: HelperReason, detail: string, verdict?: HelperVerdict): void {
  warnLine(`${reason}:${detail}`, ocrReasonLine(reason, { detail, osVersion: verdict?.osVersion, minMacos: verdict?.minMacos }));
}

/**
 * The one line logged when the PREBUILT file is refused (latched off, or a download flag that will not clear): "using the
 * one built on this Mac" when a local build takes over, the OCR-is-off sentence only when nothing is left.
 */
function warnPrebuiltRefused(reason: HelperReason, detail: string, verdict: HelperVerdict | undefined): void {
  if (localFallback(verdict)) warnLine(`fallback:${detail}`, ocrFallbackLine(detail));
  else warnOnce(reason, detail, verdict);
}

/** T3 for the prebuilt, once per file signature (and again after a minute when it was blocked). True = may be executed. */
function prebuiltFlagClear(file: string, force = false): boolean {
  const signature = fileSignature(file);
  const known = state.flagCheck;
  if (!force && known && known.signature === signature && (known.clear || Date.now() - known.at < BLOCKED_RECHECK_MS)) return known.clear;
  let flag = quarantineState(file);
  if (flag !== 'none') flag = clearAndRecheck(file);
  const clear = flag === 'none';
  state.flagCheck = { signature, clear, at: Date.now() };
  if (!clear) warnPrebuiltRefused('quarantined', flag === 'flagged' ? 'download mark present' : 'download mark could not be read', cached?.verdict);
  return clear;
}

// ── what callers use ─────────────────────────────────────────────────────────

export interface UsableHelper {
  provenance: 'prebuilt' | 'local';
  path: string;
  /** Built from the current main.swift: a prebuilt that is not outdated, or a local build under rule R2. */
  current: boolean;
  /** True for the local build the server fell back to because the prebuilt may not run here. */
  fallback: boolean;
}

/**
 * The helper to execute and where it came from, or null when nothing may run. The verdict's own helper is used unless
 * this process latched it off or it is a prebuilt carrying a download flag that cannot be cleared; then a local build is
 * the next best (see localFallback), exactly as the shell resolver returns one after a failed smoke. Synchronous (T3 is
 * a 6 ms xattr call, once per file signature).
 */
export function usableVisionHelper(): UsableHelper | null {
  const verdict = currentVisionHelper();
  if (verdict.provenance === 'none' || !verdict.path) return null;
  const own = !isHelperLatchedOff(verdict.path) && (verdict.provenance !== 'prebuilt' || prebuiltFlagClear(verdict.path));
  if (own) return { provenance: verdict.provenance, path: verdict.path, current: verdict.current, fallback: false };
  const local = localFallback(verdict);
  return local ? { provenance: 'local', path: local.path, current: local.current, fallback: true } : null;
}

/** The path of usableVisionHelper(), or null when no helper may run. */
export function usableVisionHelperPath(): string | null {
  return usableVisionHelper()?.path ?? null;
}

/** The sentence for the last helper file this process gave up on. */
function refusedLine(entry: Latch, verdict: HelperVerdict): string {
  if (entry.file !== prebuiltFile()) return ocrLocalRefusedLine(entry.detail);
  return ocrReasonLine(entry.reason, { detail: entry.detail, osVersion: verdict.osVersion, minMacos: verdict.minMacos });
}

/** Why no helper is available now, as the owner's sentence, or null when one is. */
export function visionHelperOffLine(): string | null {
  const verdict = currentVisionHelper();
  if (usableVisionHelper()) return null;
  const last = state.latches[state.latches.length - 1];
  if (last) return refusedLine(last, verdict);
  if (verdict.provenance === 'none') {
    if (verdict.reason === 'not_macos') return null;
    return ocrReasonLine(verdict.reason ?? 'resolver_error', { osVersion: verdict.osVersion, minMacos: verdict.minMacos, detail: verdict.detail });
  }
  if (verdict.provenance === 'prebuilt' && state.flagCheck && !state.flagCheck.clear) return ocrReasonLine('quarantined');
  return null;
}

function smokeAsync(file: string): Promise<{ ok: boolean; detail: string }> {
  return new Promise((resolve) => {
    try {
      execFile(file, [], { encoding: 'utf8', timeout: SMOKE_TIMEOUT_MS, killSignal: 'SIGKILL' }, (error, _stdout, stderr) => {
        if (!error) return resolve({ ok: false, detail: 'unexpected output' });
        // execFile reports a helper's own exit status as a numeric `code`.
        const e = error as { killed?: boolean; signal?: string | null; errno?: unknown; code?: unknown };
        if (e.killed && e.signal) return resolve({ ok: false, detail: 'did not answer in time' });
        if (e.signal) return resolve({ ok: false, detail: 'killed by macOS' });
        if (typeof e.errno === 'number') return resolve({ ok: false, detail: 'cannot start' });
        if (e.code === 2 && String(stderr ?? '').includes(OCR_USAGE_TEXT)) return resolve({ ok: true, detail: 'ok' });
        resolve({ ok: false, detail: 'unexpected output' });
      });
    } catch {
      // Node THROWS, instead of calling back, for most spawn errors (EBADARCH -86 and ENOEXEC -8 among them): the file cannot be started.
      // Left alone, this promise rejected, no latch was recorded and a local build never took over.
      resolve({ ok: false, detail: 'cannot start' });
    }
  });
}

/** Give up on `file` for the rest of this process and say, once, what happens now (the local build takes over, or OCR is off). */
function latch(reason: HelperReason, detail: string, file: string): void {
  if (isHelperLatchedOff(file)) return;
  state.latches.push({ reason, detail, file });
  state.smokeOk = null;
  if (file === prebuiltFile()) warnPrebuiltRefused(reason, detail, cached?.verdict);
  else warnLine(`local:${detail}`, ocrLocalRefusedLine(detail));
}

/**
 * Before the first use of the helper on the async path: T3 (inside
 * usableVisionHelper) then one smoke run per process, shared by concurrent
 * callers. True when a helper may be executed. A local build, compiled on this
 * Mac, is not flag-checked or smoke-run, so it is ready as soon as it is chosen,
 * and a prebuilt whose smoke fails hands over to it at once (the same call, not
 * the next one).
 */
export function ensureVisionHelperReady(): Promise<boolean> {
  const chosen = usableVisionHelper();
  if (!chosen) return Promise.resolve(false);
  if (chosen.provenance !== 'prebuilt') return Promise.resolve(true);
  const file = chosen.path;
  const signature = fileSignature(file);
  if (state.smokeOk === signature) return Promise.resolve(true);
  if (state.smoke && state.smoke.signature === signature) return state.smoke.promise;
  const promise = smokeAsync(file).then((outcome) => {
    if (outcome.ok) {
      state.smokeOk = signature;
      return true;
    }
    latch('smoke_failed', outcome.detail, file);
    return usableVisionHelper() !== null;
  }).finally(() => {
    if (state.smoke?.promise === promise) state.smoke = null;
  });
  state.smoke = { signature, promise };
  return promise;
}

/**
 * Does this error have the shape of "the system would not run the helper"?
 * Counted: a child killed by a signal (Node's own timeout kill included), and
 * any spawn-phase error carrying a negative errno, named (EACCES, ENOENT) or
 * not (-8 and -86 have no name in Node 20). Never counted: a numeric exit
 * status, which is the helper running and saying no (exit 2, 3, 4 with a JSON
 * error on stderr).
 */
export function isExecFailure(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const e = error as { signal?: unknown; errno?: unknown; syscall?: unknown };
  if (typeof e.signal === 'string' && e.signal !== '') return true;
  return typeof e.errno === 'number' && e.errno < 0 && String(e.syscall ?? '').startsWith('spawn');
}

/**
 * Call from the catch block of every helper run, with the file that ran. Non-blocking: it only starts
 * one fresh T3 + T4 on that file when the failure has the shape above, and latches it off for the
 * process when that fails. Ordinary failures (a bad PDF, a password) never come here. Without `file`
 * the helper usableVisionHelper() would hand out now is meant. Only the two files the verdict knows
 * (the prebuilt, the local build) can be latched, each on its own: a refused prebuilt leaves the local
 * build in use, and a refused local build is not offered again.
 */
export function noteHelperExecFailure(error: unknown, file?: string): void {
  if (!isExecFailure(error) || state.retest) return;
  const verdict = currentVisionHelper();
  const target = file ?? usableVisionHelper()?.path ?? verdict.path;
  if (!target || ![verdict.path, verdict.localBuild?.path].includes(target) || isHelperLatchedOff(target)) return;
  const retest = (async () => {
    if (target === prebuiltFile() && !prebuiltFlagClear(target, true)) {
      latch('quarantined', 'download mark present', target);
      return;
    }
    const outcome = await smokeAsync(target);
    if (outcome.ok) {
      state.smokeOk = fileSignature(target);
      return;
    }
    latch('smoke_failed', outcome.detail, target);
  })().finally(() => {
    state.retest = null;
  });
  state.retest = retest;
}

/** Resolves when the re-test started by noteHelperExecFailure (if any) has finished. For tests and shutdown. */
export function settleHelperRetest(): Promise<void> {
  return state.retest ?? Promise.resolve();
}

/** Whether a helper has been latched off in this process, and why (the first file it gave up on). */
export function helperLatch(): { reason: HelperReason; detail: string } | null {
  const first = state.latches[0];
  return first ? { reason: first.reason, detail: first.detail } : null;
}

/**
 * The conventional local build (native/vision-ocr/bin/vision-ocr), whether or not it exists, under the same package
 * root the resolver uses (so a test root applies to it too). Synchronous readers fall back to it when the prebuilt may
 * not be used; see deps-check.ts › visionHelperPath.
 */
export function localVisionHelperPath(): string {
  return path.join(packageRoot(), LOCAL_REL);
}

/** The text an exec failure adds to an error message: the next action. */
export const EXEC_FAILURE_NEXT_ACTION = 'macOS would not run the OCR helper; run ./start.sh --doctor for the reason.';
