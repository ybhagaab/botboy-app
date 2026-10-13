#!/usr/bin/env node
/**
 * native-prebuilt — BotBoy's prebuilt native helpers: the manifest, its
 * verification, and the ONE resolver that decides which OCR helper this Mac
 * uses (prebuilt, local build, or none).
 *
 * Why it exists: nothing native is compiled on a teammate's Mac. The OCR
 * helper (native/vision-ocr) and the BotBoy.app launcher (native/botboy-launcher)
 * are built once on the owner's Mac, committed under native/*\/prebuilt/ with
 * one manifest, and shipped through git. A local compile stays only as a
 * background last resort (scripts/bootstrap-deps.mjs).
 *
 * This file is SHIPPED and runs on Macs without developer tools, so it runs
 * only real OS tools (sw_vers, xattr, arch) and never git, lipo, otool, vtool,
 * xcrun or swiftc. The build, the git-based and toolchain-based checks, and the
 * release import check are in scripts/build-native-prebuilt.mjs (dev only).
 *
 * Manifest: native/prebuilt-manifest.json (schema 1, at most 64 KB)
 *   { "schema": 1,
 *     "artifacts": { "visionOcr": {
 *       "source":    { "sha256": "<native/vision-ocr/main.swift>" },
 *       "binary":    { "sha256": "<universal file>", "bytes": <int> },
 *       "archs":     ["arm64", "x86_64"],
 *       "minMacos":  "13.0",
 *       "signature": { "kind": "adhoc", "identifier": "com.botboy.vision-ocr" },
 *       "toolchain": { "swift": "...", "sdk": "...", "ld": "..." },
 *       "builtAt":   "YYYY-MM-DD" } } }
 *   No paths and no user names anywhere (locations are constants below).
 *
 * Resolver, one decision table (first row that matches wins). Facts: manifest
 * {ok, missing, invalid}; prebuilt file {ok, missing, corrupt, not executable};
 * source = main.swift hash equals the manifest's {same, differs}; macOS floor
 * {ok, too old, unknown}; download flag {none, cleared, stuck}; smoke {ok,
 * failed, not run}; local build {absent, current, outdated}.
 *   R0 not macOS                              none      not_macos (silent)
 *   R1 prebuilt usable, source same           prebuilt  current
 *   R2 local build current                    local     current
 *   R3 prebuilt usable, source differs        prebuilt  prebuilt_outdated (still works)
 *   R4 local build outdated                   local     local_outdated (still works)
 *   R5 otherwise                              none      the first failing reason: manifest_missing,
 *      manifest_invalid, prebuilt_missing, prebuilt_corrupt, prebuilt_not_executable, os_too_old,
 *      quarantined, smoke_failed
 * A working helper is never discarded merely for being older than the source.
 * "Local build current" means bin/vision-ocr.built-from equals the SHA-256 of
 * main.swift (a build with no sidecar is judged by the old file-time rule).
 *
 * Tiers: T0 file exists, regular, executable, size = manifest. T1 SHA-256 of the
 * binary and of main.swift. T2 macOS version at or above minMacos (sw_vers).
 * T3 download flag (xattr -p): cleared when the caller may repair, and a flagged
 * file is NEVER executed. T4 smoke: run the helper with no arguments and expect
 * exit status 2 plus "usage: vision-ocr" on stderr.
 *
 * Test hooks (production never sets them): BOTBOY_TEST_NATIVE_ROOT (absolute
 * folder holding native/), BOTBOY_TEST_SW_VERS_BIN, BOTBOY_TEST_XATTR_BIN,
 * BOTBOY_TEST_ARCH_BIN.
 *
 * The BotBoy.app LAUNCHER is the second artifact (botboyLauncher, launcherVersion in
 * the manifest). It is generic: one fixed binary that reads the BotBoy folder it
 * opens at run time from ~/.personal-productivity-tracker/app-checkout.v1, so it
 * serves every checkout and nothing about this Mac is compiled into it. A launcher
 * replaces a working one only after it has been RUN: BOTBOY_APP_PRINT_TARGET=1
 * BOTBOY_APP_START_SCRIPT=<checkout>/start.sh prints `target=<that path>` and exits
 * before any application object exists (stdin ignored, 10 s limit, natively and
 * under each architecture the Mac can run). Anything else is
 * `launcher_smoke_failed` and the current launcher stays.
 * Extra test hooks: BOTBOY_TEST_CODESIGN_BIN.
 *
 * Usage:  node scripts/native-prebuilt.mjs verify [--json]
 *           Tier A checks (manifest, sizes, hashes, mode, source currency) against
 *           this folder. Exit 0 when everything matches, 1 with one line per
 *           problem and the fix, 2 on a bad argument.
 *         node scripts/native-prebuilt.mjs launcher-facts --app <BotBoy.app> [--checkout <folder>] [--smoke]
 *           key=value lines for start.sh's launcher plan: whether the prebuilt
 *           launcher is usable here, the installed bundle's state, the recorded
 *           folder, and the folder a legacy launcher had baked in. Without --smoke
 *           only the cheap structural checks run (prebuilt_usable=unchecked when
 *           they pass); --smoke runs the prebuilt (and, when it is the installed
 *           file, the installed launcher) in its print-target mode.
 */

import { createHash } from 'crypto';
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const MANIFEST_SCHEMA = 1;
export const MANIFEST_REL = 'native/prebuilt-manifest.json';
export const MAX_MANIFEST_BYTES = 64 * 1024;
export const QUARANTINE_ATTRIBUTE = 'com.apple.quarantine';
export const OCR_USAGE_TEXT = 'usage: vision-ocr';

/** What `verify` expects, and where each artifact lives (relative to the package folder). */
export const ARTIFACTS = {
  visionOcr: {
    label: 'OCR helper',
    source: 'native/vision-ocr/main.swift',
    binary: 'native/vision-ocr/prebuilt/vision-ocr',
    identifier: 'com.botboy.vision-ocr',
  },
  botboyLauncher: {
    label: 'launcher',
    source: 'native/botboy-launcher/main.swift',
    binary: 'native/botboy-launcher/prebuilt/botboy-launcher',
    identifier: 'com.botboy.tracker',
    // Bumped when the launcher's contract with its bundle changes (Info.plist key BotBoyLauncherVersion).
    launcherVersion: 2,
  },
};

export const LAUNCHER_VERSION = ARTIFACTS.botboyLauncher.launcherVersion;
export const CHECKOUT_FILE_NAME = 'app-checkout.v1';
const MAX_CHECKOUT_FILE_BYTES = 8 * 1024;
const MAX_CHECKOUT_LENGTH = 4096;
const LAUNCHER_SMOKE_TIMEOUT_MS = 10_000;

const LOCAL_HELPER_REL = 'native/vision-ocr/bin/vision-ocr';
const LOCAL_SIDECAR_REL = 'native/vision-ocr/bin/vision-ocr.built-from';
const SMOKE_TIMEOUT_MS = 20_000;
// A real OS tool answers in milliseconds (xattr 6 ms, sw_vers 14 ms, measured); the limit only has to stop a hang,
// and a Mac under heavy load must not read a slow answer as "flagged" or "unknown".
const TOOL_TIMEOUT_MS = 15_000;

const HEX64 = /^[0-9a-f]{64}$/;
const VERSION_TEXT = /^\d+(\.\d+){0,2}$/;
const BUILT_AT = /^\d{4}-\d{2}-\d{2}$/;
const KNOWN_ARCHS = ['arm64', 'x86_64'];

const toolPath = (envName, fallback) => {
  const override = process.env[envName];
  return override && path.isAbsolute(override) ? override : fallback;
};
const swVersBin = () => toolPath('BOTBOY_TEST_SW_VERS_BIN', '/usr/bin/sw_vers');
const xattrBin = () => toolPath('BOTBOY_TEST_XATTR_BIN', '/usr/bin/xattr');
const archBin = () => toolPath('BOTBOY_TEST_ARCH_BIN', '/usr/bin/arch');
const codesignBin = () => toolPath('BOTBOY_TEST_CODESIGN_BIN', '/usr/bin/codesign');

/** The package folder holding native/. BOTBOY_TEST_NATIVE_ROOT points tests at fixtures. */
export function nativeRoot(env = process.env) {
  const override = env.BOTBOY_TEST_NATIVE_ROOT;
  return override && path.isAbsolute(override) ? override : PACKAGE_ROOT;
}

export function sha256Buffer(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

/** SHA-256 of a file as hex, or '' when it cannot be read. */
export function sha256File(file) {
  try {
    return sha256Buffer(fs.readFileSync(file));
  } catch {
    return '';
  }
}

// ── versions ─────────────────────────────────────────────────────────────────

/** "13.0" → [13, 0, 0]; null for anything that is not 1 to 3 numeric segments. */
export function parseVersion(text) {
  const value = String(text ?? '').trim();
  if (!VERSION_TEXT.test(value)) return null;
  const parts = value.split('.').map(Number);
  while (parts.length < 3) parts.push(0);
  return parts;
}

export function compareVersions(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) return null;
  for (let index = 0; index < 3; index++) {
    if (left[index] !== right[index]) return left[index] < right[index] ? -1 : 1;
  }
  return 0;
}

/**
 * The macOS major version for a Darwin kernel major: 20 is macOS 11 ... 24 is
 * macOS 15, then 25 is macOS 26 (there is no macOS 16). Below 20 it is 10.x.
 * Null when the input is not a plain number. The server only has the kernel
 * version (os.release()); the shell side reads sw_vers.
 */
export function macosFromDarwinMajor(darwinMajor) {
  const major = Number(darwinMajor);
  if (!Number.isInteger(major) || major < 8) return null;
  if (major >= 25) return `${major + 1}.0`;
  if (major >= 20) return `${major - 9}.0`;
  return `10.${major - 4}`;
}

/** `sw_vers -productVersion` as digits and dots, or null (unreadable means unknown, never an error). */
export function readMacosVersion({ run = spawnSync } = {}) {
  try {
    const result = run(swVersBin(), ['-productVersion'], { encoding: 'utf8', timeout: TOOL_TIMEOUT_MS, killSignal: 'SIGKILL', stdio: ['ignore', 'pipe', 'ignore'] });
    if (result.status !== 0) return null;
    const text = String(result.stdout ?? '').trim();
    return VERSION_TEXT.test(text) ? text : null;
  } catch {
    return null;
  }
}

// ── manifest ─────────────────────────────────────────────────────────────────

const withinText = (value, max = 200) => typeof value === 'string' && value.length > 0 && value.length <= max;

function suspiciousPath(value) {
  return typeof value === 'string' && (value.includes('/Users/') || value.includes('/Library/'));
}

function collectStrings(value, out = []) {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) value.forEach((entry) => collectStrings(entry, out));
  else if (value && typeof value === 'object') Object.values(value).forEach((entry) => collectStrings(entry, out));
  return out;
}

/** Validate a parsed manifest. Returns { ok: true, manifest } or { ok: false, problems: [text] }. */
export function validateManifest(value) {
  const problems = [];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, problems: ['the manifest is not an object'] };
  if (value.schema !== MANIFEST_SCHEMA) problems.push(`schema must be ${MANIFEST_SCHEMA}`);
  if (!value.artifacts || typeof value.artifacts !== 'object' || Array.isArray(value.artifacts)) {
    problems.push('artifacts is missing');
    return { ok: false, problems };
  }
  for (const text of collectStrings(value)) {
    if (suspiciousPath(text)) {
      problems.push('a manifest string holds a machine path (/Users/ or /Library/)');
      break;
    }
  }
  for (const [key, spec] of Object.entries(ARTIFACTS)) {
    const entry = value.artifacts[key];
    if (entry === undefined) continue; // a missing entry is reported by the caller that needs it
    const at = (field) => `${key}.${field}`;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      problems.push(`${key} is not an object`);
      continue;
    }
    if (!HEX64.test(entry.source?.sha256 ?? '')) problems.push(`${at('source.sha256')} must be 64 lowercase hex characters`);
    if (!HEX64.test(entry.binary?.sha256 ?? '')) problems.push(`${at('binary.sha256')} must be 64 lowercase hex characters`);
    const bytes = entry.binary?.bytes;
    if (!Number.isInteger(bytes) || bytes < 1 || bytes > 5_000_000) problems.push(`${at('binary.bytes')} must be an integer from 1 to 5000000`);
    const archs = entry.archs;
    if (!Array.isArray(archs) || archs.length === 0 || new Set(archs).size !== archs.length || archs.some((arch) => !KNOWN_ARCHS.includes(arch))) {
      problems.push(`${at('archs')} must be a non-empty subset of ${KNOWN_ARCHS.join(', ')}`);
    }
    if (typeof entry.minMacos !== 'string' || !VERSION_TEXT.test(entry.minMacos)) problems.push(`${at('minMacos')} must look like 13.0`);
    if (entry.signature?.kind !== 'adhoc') problems.push(`${at('signature.kind')} must be adhoc`);
    if (!withinText(entry.signature?.identifier)) problems.push(`${at('signature.identifier')} must be a short string`);
    else if (entry.signature.identifier !== spec.identifier) problems.push(`${at('signature.identifier')} must be ${spec.identifier}`);
    if (!withinText(entry.toolchain?.swift)) problems.push(`${at('toolchain.swift')} must be a short string`);
    if (!withinText(entry.toolchain?.sdk)) problems.push(`${at('toolchain.sdk')} must be a short string`);
    if (typeof entry.toolchain?.ld !== 'string' || entry.toolchain.ld.length > 200) problems.push(`${at('toolchain.ld')} must be a short string`);
    if (typeof entry.builtAt !== 'string' || !BUILT_AT.test(entry.builtAt)) problems.push(`${at('builtAt')} must be YYYY-MM-DD`);
    if (spec.launcherVersion && (!Number.isInteger(entry.launcherVersion) || entry.launcherVersion < 1)) {
      problems.push(`${at('launcherVersion')} must be a positive integer`);
    } else if (spec.launcherVersion && entry.launcherVersion !== spec.launcherVersion) {
      problems.push(`${at('launcherVersion')} must be ${spec.launcherVersion} (the version this code expects)`);
    }
  }
  return problems.length ? { ok: false, problems } : { ok: true, manifest: value };
}

/**
 * Read and validate the manifest. { ok: true, manifest } or
 * { ok: false, reason: 'manifest_missing' | 'manifest_invalid', detail }.
 */
export function readManifest({ root = nativeRoot() } = {}) {
  const file = path.join(root, MANIFEST_REL);
  let text;
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile()) return { ok: false, reason: 'manifest_missing', detail: `${MANIFEST_REL} is not a file` };
    if (stat.size > MAX_MANIFEST_BYTES) return { ok: false, reason: 'manifest_invalid', detail: `${MANIFEST_REL} is larger than ${MAX_MANIFEST_BYTES} bytes` };
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return { ok: false, reason: 'manifest_missing', detail: `${MANIFEST_REL} does not exist` };
    return { ok: false, reason: 'manifest_invalid', detail: `${MANIFEST_REL} cannot be read` };
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'manifest_invalid', detail: `${MANIFEST_REL} is not valid JSON` };
  }
  const checked = validateManifest(value);
  if (!checked.ok) return { ok: false, reason: 'manifest_invalid', detail: checked.problems.join('; ') };
  return { ok: true, manifest: checked.manifest, file };
}

// ── Tier A: what every Mac (and the vitest drift test) can check ────────────

function isExecutableFile(file) {
  try {
    if (!fs.statSync(file).isFile()) return false;
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

const short = (hash) => (hash ? `${hash.slice(0, 8)}…` : 'unreadable');

/** The line printed after a failed check; the commands name the fix. */
export const VERIFY_FIX = 'Fix: npm run prebuilt:build, commit native/prebuilt-manifest.json and native/*/prebuilt/*, then npm run release';

/**
 * Tier A: manifest valid; each binary exists with the recorded size, SHA-256 and
 * an executable mode; each recorded source hash equals the current source file.
 * `skipSourceCurrency` is for a botboy-app checkout, where a customized source
 * file is allowed and only makes the artifact "outdated" at run time.
 */
export function verifyTierA({ root = nativeRoot(), skipSourceCurrency = false } = {}) {
  const problems = [];
  const read = readManifest({ root });
  if (!read.ok) {
    problems.push({ artifact: null, code: read.reason, message: read.detail });
    return { ok: false, problems };
  }
  for (const [key, spec] of Object.entries(ARTIFACTS)) {
    const entry = read.manifest.artifacts[key];
    if (!entry) {
      problems.push({ artifact: key, code: 'manifest_invalid', message: `${MANIFEST_REL} has no ${key} entry` });
      continue;
    }
    const binary = path.join(root, spec.binary);
    let stat = null;
    try {
      stat = fs.statSync(binary);
    } catch {
      // reported below
    }
    if (!stat || !stat.isFile()) {
      problems.push({ artifact: key, code: 'prebuilt_missing', message: `${spec.binary} is missing` });
    } else {
      if (stat.size !== entry.binary.bytes) {
        problems.push({ artifact: key, code: 'prebuilt_corrupt', message: `${spec.binary} is ${stat.size} bytes, the manifest says ${entry.binary.bytes}` });
      } else {
        const actual = sha256File(binary);
        if (actual !== entry.binary.sha256) {
          problems.push({ artifact: key, code: 'prebuilt_corrupt', message: `${spec.binary} does not match the manifest (manifest ${short(entry.binary.sha256)}, file ${short(actual)})` });
        }
      }
      if (!isExecutableFile(binary)) {
        problems.push({ artifact: key, code: 'prebuilt_not_executable', message: `${spec.binary} is not executable (mode ${(stat.mode & 0o777).toString(8)})` });
      }
    }
    if (!skipSourceCurrency) {
      const source = path.join(root, spec.source);
      const actual = sha256File(source);
      if (!actual) {
        problems.push({ artifact: key, code: 'source_missing', message: `${spec.source} is missing` });
      } else if (actual !== entry.source.sha256) {
        problems.push({ artifact: key, code: 'source_changed', message: `${spec.source} changed after the ${spec.label.toLowerCase()} was built (manifest ${short(entry.source.sha256)}, file ${short(actual)})` });
      }
    }
  }
  return { ok: problems.length === 0, problems };
}

export function formatProblems(problems) {
  return [
    '✗ Prebuilt native helpers are not ready to release:',
    ...problems.map((problem) => `    ${problem.message}`),
    `  ${VERIFY_FIX}`,
  ].join('\n');
}

// ── Tier T3: the download flag ──────────────────────────────────────────────

/**
 * 'none' (no flag), 'flagged', or 'unknown' (xattr could not answer). Only
 * "no such attribute" counts as none; anything unclear is treated as flagged by
 * the callers, because a flagged file must never be executed.
 */
export function quarantineState(file, { run = spawnSync } = {}) {
  try {
    const result = run(xattrBin(), ['-p', QUARANTINE_ATTRIBUTE, file], { encoding: 'utf8', timeout: TOOL_TIMEOUT_MS, killSignal: 'SIGKILL', stdio: ['ignore', 'pipe', 'pipe'] });
    if (result.error || typeof result.status !== 'number') return 'unknown';
    if (result.status === 0) return 'flagged';
    if (result.status === 1) return 'none';
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

/** Best-effort `xattr -d` on one file; returns the state afterwards. */
export function clearQuarantine(file, { run = spawnSync } = {}) {
  try {
    run(xattrBin(), ['-d', QUARANTINE_ATTRIBUTE, file], { encoding: 'utf8', timeout: TOOL_TIMEOUT_MS, killSignal: 'SIGKILL', stdio: 'ignore' });
  } catch {
    // the re-check below decides
  }
  return quarantineState(file, { run });
}

// ── Tier T4: smoke ──────────────────────────────────────────────────────────

/**
 * Run the OCR helper with no arguments: exit 2 and the usage line on stderr is
 * the helper working. { ok, detail } where detail is one of
 * 'killed by macOS', 'cannot start', 'unexpected output' when it is not.
 */
export function smokeVisionHelper(file, { timeoutMs = SMOKE_TIMEOUT_MS, archPrefix = null, run = spawnSync } = {}) {
  try {
    const command = archPrefix ? archBin() : file;
    const args = archPrefix ? [`-${archPrefix}`, file] : [];
    const result = run(command, args, { encoding: 'utf8', timeout: timeoutMs, killSignal: 'SIGKILL', stdio: ['ignore', 'pipe', 'pipe'] });
    if (result.error) return { ok: false, detail: result.error.code === 'ETIMEDOUT' ? 'did not answer in time' : 'cannot start' };
    if (result.signal) return { ok: false, detail: result.signal === 'SIGKILL' && !result.error ? 'killed by macOS' : `stopped by ${result.signal}` };
    if (result.status === 2 && String(result.stderr ?? '').includes(OCR_USAGE_TEXT)) return { ok: true, detail: 'ok' };
    return { ok: false, detail: 'unexpected output' };
  } catch {
    return { ok: false, detail: 'cannot start' };
  }
}

/** True when `arch -<arch>` can run a program here (arm64 on Apple Silicon, x86_64 where Rosetta is installed). */
export function archAnswers(arch, { run = spawnSync } = {}) {
  try {
    const result = run(archBin(), [`-${arch}`, '/usr/bin/true'], { timeout: TOOL_TIMEOUT_MS, killSignal: 'SIGKILL', stdio: 'ignore' });
    return result.status === 0;
  } catch {
    return false;
  }
}

export const rosettaAnswers = (options) => archAnswers('x86_64', options);

// ── the OCR helper resolver ──────────────────────────────────────────────────

const PREBUILT_REASON_ORDER = [
  'manifest_missing', 'manifest_invalid', 'prebuilt_missing', 'prebuilt_corrupt',
  'prebuilt_not_executable', 'os_too_old', 'quarantined', 'smoke_failed',
];

function localHelperFacts(root, sourceSha) {
  const file = path.join(root, LOCAL_HELPER_REL);
  if (!isExecutableFile(file)) return { state: 'absent', file };
  let recorded = '';
  try {
    recorded = fs.readFileSync(path.join(root, LOCAL_SIDECAR_REL), 'utf8').trim();
  } catch {
    // no sidecar: the old file-time rule below
  }
  let current = true;
  if (recorded) {
    current = sourceSha === '' || recorded === sourceSha;
  } else {
    try {
      current = !(fs.statSync(path.join(root, ARTIFACTS.visionOcr.source)).mtimeMs > fs.statSync(file).mtimeMs);
    } catch {
      current = true;
    }
  }
  return { state: current ? 'current' : 'outdated', file };
}

/** The first failing prebuilt check (T0 to T3), or { reason: null } with the entry and file. */
function prebuiltFacts({ root, osVersion, repair }) {
  const read = readManifest({ root });
  if (!read.ok) return { reason: read.reason, detail: read.detail };
  const entry = read.manifest.artifacts.visionOcr;
  if (!entry) return { reason: 'manifest_invalid', detail: `${MANIFEST_REL} has no visionOcr entry` };
  const file = path.join(root, ARTIFACTS.visionOcr.binary);
  const base = { entry, file };
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return { ...base, reason: 'prebuilt_missing' };
  }
  if (!stat.isFile()) return { ...base, reason: 'prebuilt_missing' };
  if (stat.size !== entry.binary.bytes) return { ...base, reason: 'prebuilt_corrupt', detail: 'size' };
  if (sha256File(file) !== entry.binary.sha256) return { ...base, reason: 'prebuilt_corrupt', detail: 'hash' };
  if (!isExecutableFile(file)) {
    if (repair) {
      try {
        fs.chmodSync(file, 0o755);
      } catch {
        // checked again below
      }
    }
    if (!isExecutableFile(file)) return { ...base, reason: 'prebuilt_not_executable' };
  }
  // An unreadable macOS version is "unknown": the floor is not enforced and the smoke decides.
  if (osVersion && compareVersions(osVersion, entry.minMacos) === -1) {
    return { ...base, reason: 'os_too_old', osVersion, minMacos: entry.minMacos };
  }
  return { ...base, reason: null };
}

/**
 * Decide which OCR helper this Mac uses. Never throws: an internal error is
 * { provenance: 'none', reason: 'resolver_error' }.
 *
 * options: root, env, platform, osVersion (the macOS product version; read with
 * sw_vers when omitted), smoke ('run' | 'skip'), smokeTimeoutMs, repair (chmod
 * a non-executable prebuilt and clear the download flag; the job, postinstall
 * and bundle builder pass true, the doctor never does).
 *
 * Result: { provenance: 'prebuilt'|'local'|'none', current, reason, path, detail,
 *           osVersion, minMacos, entry, smoke: 'ok'|'failed'|'not run' }.
 */
export function resolveVisionHelper(options = {}) {
  const env = options.env ?? process.env;
  const root = options.root ?? nativeRoot(env);
  const platform = options.platform ?? process.platform;
  const result = (provenance, current, reason, extra = {}) => ({
    provenance, current, reason, path: null, detail: '', osVersion: null, minMacos: null, entry: null, smoke: 'not run', ...extra,
  });
  if (platform !== 'darwin') return result('none', false, 'not_macos');
  try {
    const repair = options.repair === true;
    const sourceSha = sha256File(path.join(root, ARTIFACTS.visionOcr.source));
    const osVersion = options.osVersion !== undefined ? options.osVersion : readMacosVersion();
    const local = localHelperFacts(root, sourceSha);
    const pre = prebuiltFacts({ root, osVersion, repair });
    let reason = pre.reason;
    let detail = pre.detail ?? '';
    let smoke = 'not run';
    let quarantine = 'none';

    if (!reason) {
      // T3. A flagged file is never executed; only a caller that may repair clears it.
      quarantine = quarantineState(pre.file);
      if (quarantine !== 'none' && repair) quarantine = clearQuarantine(pre.file);
      if (quarantine !== 'none') {
        reason = 'quarantined';
        detail = quarantine === 'flagged' ? 'download mark present' : 'download mark could not be read';
      }
    }
    const srcSame = !pre.entry || sourceSha === '' || sourceSha === pre.entry.source.sha256;
    // The smoke runs only for a prebuilt that is about to be chosen: R1, or R3 when no current local build beats it.
    const prebuiltWouldWin = !reason && (srcSame || local.state !== 'current');
    if (prebuiltWouldWin && (options.smoke ?? 'run') === 'run') {
      const outcome = smokeVisionHelper(pre.file, { timeoutMs: options.smokeTimeoutMs ?? SMOKE_TIMEOUT_MS });
      smoke = outcome.ok ? 'ok' : 'failed';
      if (!outcome.ok) {
        reason = 'smoke_failed';
        detail = outcome.detail;
      }
    }
    const common = { osVersion, minMacos: pre.entry?.minMacos ?? null, entry: pre.entry ?? null, smoke };
    if (!reason && srcSame) return result('prebuilt', true, null, { ...common, path: pre.file });
    if (local.state === 'current') return result('local', true, null, { ...common, path: local.file });
    if (!reason) return result('prebuilt', false, 'prebuilt_outdated', { ...common, path: pre.file });
    if (local.state === 'outdated') return result('local', false, 'local_outdated', { ...common, path: local.file });
    return result('none', false, reason, { ...common, detail });
  } catch (error) {
    return result('none', false, 'resolver_error', { detail: String(error?.message ?? error).slice(0, 200) });
  }
}

// ── words for the owner: reason table, doctor row ────────────────────────────

/** True for the reasons that mean "no helper is usable and nothing was attempted". */
export function isUnavailableReason(reason) {
  return PREBUILT_REASON_ORDER.includes(reason) || reason === 'resolver_error';
}

/**
 * The one line the owner sees for a reason, every one naming its next action
 * (text is pinned by tests). `root` is the package folder, for the quarantine command.
 */
export function ocrReasonLine(reason, { osVersion = null, minMacos = null, detail = '', root = PACKAGE_ROOT } = {}) {
  switch (reason) {
    case 'os_too_old':
      return `Text reading from images and scanned PDFs (OCR) is off: this Mac runs macOS ${osVersion ?? 'older than the minimum'} and BotBoy's reader needs macOS ${minMacos ?? '13'} or newer. Update macOS in System Settings > General > Software Update (or install the Command Line Tools with xcode-select --install, then run ./start.sh --rebuild-ocr).`;
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
      return `OCR is off: macOS would not run BotBoy's prebuilt reader on this Mac (${detail || 'cannot start'}). Run ./start.sh --rebuild-ocr to build one on this Mac (it needs the Command Line Tools: xcode-select --install); if that does not help, send the output of ./start.sh --doctor to the owner.`;
    case 'resolver_error':
      return 'OCR status could not be worked out. Run ./start.sh --doctor and send the output to the owner.';
    default:
      return 'OCR is off for a reason BotBoy does not know. Run ./start.sh --doctor.';
  }
}

function swiftWords(toolchain) {
  const match = /Apple Swift version ([\d.]+)/.exec(toolchain?.swift ?? '');
  return match ? `Apple Swift ${match[1]}` : (toolchain?.swift ?? 'unknown toolchain');
}

/** The `ocr helper:` doctor row for a resolver verdict (the doctor changes nothing). */
export function ocrDoctorLine(verdict, { root = PACKAGE_ROOT } = {}) {
  if (verdict.provenance === 'prebuilt') {
    const entry = verdict.entry;
    const archs = entry?.archs?.length === 2 ? `universal ${entry.archs.join('+')}` : (entry?.archs ?? []).join('+');
    const facts = `${archs}, needs macOS ${String(entry?.minMacos ?? '13').replace(/\.0$/, '')}+, built ${entry?.builtAt ?? 'unknown'} with ${swiftWords(entry?.toolchain)}`;
    const smoke = verdict.smoke === 'ok' ? '; smoke ok' : '';
    if (verdict.current) return `ocr helper: prebuilt, current (${facts})${smoke}`;
    return `ocr helper: prebuilt, older than main.swift in this folder; it still works (./start.sh --rebuild-ocr builds a newer one)${smoke}`;
  }
  if (verdict.provenance === 'local') {
    return verdict.current
      ? 'ocr helper: local build, current (compiled on this Mac)'
      : 'ocr helper: local build, older than main.swift in this folder; it still works (./start.sh --rebuild-ocr builds a newer one)';
  }
  if (verdict.reason === 'not_macos') return 'ocr helper: not applicable (needs macOS)';
  if (verdict.reason === 'quarantined') {
    return `ocr helper: OFF, the download mark is still on BotBoy's reader; ./start.sh clears it (or run: xattr -r -d ${QUARANTINE_ATTRIBUTE} "${path.join(root, 'native')}")`;
  }
  return `ocr helper: OFF, ${ocrReasonLine(verdict.reason, { osVersion: verdict.osVersion, minMacos: verdict.minMacos, detail: verdict.detail, root })}`;
}

// ── the launcher: smoke, the recorded folder, and the facts start.sh plans from ──

/** Where the BotBoy folder the app opens is recorded (outside the bundle: nothing edits the .app after creation). */
export function checkoutFilePath(home = os.homedir()) {
  return path.join(home, '.personal-productivity-tracker', CHECKOUT_FILE_NAME);
}

/**
 * The recorded folder: { checkout } or null. The same rules as the launcher: the
 * file is read only up to 8 KB, `checkout=` is absolute, shorter than 4096
 * characters, with no control character. Anything else is "not recorded".
 */
export function readCheckoutFile({ home = os.homedir() } = {}) {
  try {
    const file = checkoutFilePath(home);
    if (fs.statSync(file).size > MAX_CHECKOUT_FILE_BYTES) return null;
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (!line.startsWith('checkout=')) continue;
      const value = line.slice('checkout='.length);
      if (!value.startsWith('/') || value.length >= MAX_CHECKOUT_LENGTH || /[\u0000-\u001f\u007f]/.test(value)) return null;
      return { checkout: value };
    }
    return null;
  } catch {
    return null;
  }
}

function localTimestamp(now = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
}

/**
 * Record `checkoutDir` (its physical path) as the folder the app opens: a
 * temporary file then a rename, mode 0600 in a 0700 folder. { ok, checkout }
 * or { ok: false, error }; never throws.
 */
export function writeCheckoutFile(checkoutDir, { home = os.homedir(), now = new Date() } = {}) {
  const file = checkoutFilePath(home);
  const staged = `${file}.${process.pid}.tmp`;
  try {
    const checkout = fs.realpathSync(checkoutDir);
    if (!checkout.startsWith('/') || checkout.length >= MAX_CHECKOUT_LENGTH || /[\u0000-\u001f\u007f]/.test(checkout)) {
      return { ok: false, error: 'the folder path cannot be recorded' };
    }
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(staged, `checkout=${checkout}\nwritten=${localTimestamp(now)}\n`, { mode: 0o600 });
    fs.chmodSync(staged, 0o600);
    fs.renameSync(staged, file);
    return { ok: true, checkout };
  } catch (error) {
    try {
      fs.rmSync(staged, { force: true });
    } catch {
      // nothing more to do
    }
    return { ok: false, error: String(error?.message ?? error).slice(0, 200) };
  }
}

/**
 * Run a launcher executable the way it will be run, but only to find its target
 * (BOTBOY_APP_PRINT_TARGET=1: it exits before any application object exists).
 * Passes only when it exits 0 and prints exactly `target=<startScript>`.
 * { ok, detail }; detail on failure is one of 'killed by macOS', 'cannot start',
 * 'did not answer in time', 'unexpected output'.
 */
export function smokeLauncher(file, { startScript, archPrefix = null, timeoutMs = LAUNCHER_SMOKE_TIMEOUT_MS, run = spawnSync } = {}) {
  try {
    const command = archPrefix ? archBin() : file;
    const args = archPrefix ? [`-${archPrefix}`, file] : [];
    const result = run(command, args, {
      encoding: 'utf8',
      timeout: timeoutMs,
      killSignal: 'SIGKILL',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, BOTBOY_APP_PRINT_TARGET: '1', BOTBOY_APP_START_SCRIPT: startScript },
    });
    if (result.error) return { ok: false, detail: result.error.code === 'ETIMEDOUT' ? 'did not answer in time' : 'cannot start' };
    if (result.signal) return { ok: false, detail: result.signal === 'SIGKILL' ? 'killed by macOS' : `stopped by ${result.signal}` };
    if (result.status === 0 && String(result.stdout ?? '').trim() === `target=${startScript}`) return { ok: true, detail: 'ok' };
    return { ok: false, detail: 'unexpected output' };
  } catch {
    return { ok: false, detail: 'cannot start' };
  }
}

/** Smoke a launcher natively and under each architecture this Mac can run. { ok, detail } (detail names the failing one). */
export function smokeLauncherEverywhere(file, { startScript, run = spawnSync } = {}) {
  const natively = smokeLauncher(file, { startScript, run });
  if (!natively.ok) return { ok: false, detail: natively.detail };
  for (const arch of KNOWN_ARCHS) {
    if (!archAnswers(arch, { run })) continue;
    const outcome = smokeLauncher(file, { startScript, archPrefix: arch, run });
    if (!outcome.ok) return { ok: false, detail: `arch -${arch}: ${outcome.detail}` };
  }
  return { ok: true, detail: 'ok' };
}

/** `codesign --verify --strict` on one file: true when the signature verifies. */
export function codesignVerifies(file, { run = spawnSync } = {}) {
  try {
    const result = run(codesignBin(), ['--verify', '--strict', file], { encoding: 'utf8', timeout: TOOL_TIMEOUT_MS, killSignal: 'SIGKILL', stdio: ['ignore', 'pipe', 'pipe'] });
    return result.status === 0;
  } catch {
    return false;
  }
}

/**
 * Is the committed prebuilt launcher usable on THIS Mac for THIS folder? Checks, in
 * order: manifest entry; size and SHA-256; macOS floor; and, unless `smoke` is
 * false, on a private COPY (a Node copy carries no download flag, and the copy is
 * what would be installed): code signature, and the execution smoke natively and
 * under each architecture the Mac can run. With `smoke: false` only the cheap
 * structural checks run (no process is started), and `checked` says so.
 * { ok, reason, detail, entry, file, checked } where reason is one of
 * manifest_missing, manifest_invalid, launcher_missing, launcher_corrupt, os_too_old,
 * launcher_codesign_failed, launcher_smoke_failed.
 */
export function launcherPrebuiltUsable({ root = nativeRoot(), startScript, osVersion, run = spawnSync, smoke = true } = {}) {
  const spec = ARTIFACTS.botboyLauncher;
  const read = readManifest({ root });
  if (!read.ok) return { ok: false, reason: read.reason, detail: read.detail, entry: null, file: null, checked: 'structure' };
  const entry = read.manifest.artifacts.botboyLauncher;
  if (!entry) return { ok: false, reason: 'manifest_invalid', detail: `${MANIFEST_REL} has no botboyLauncher entry`, entry: null, file: null, checked: 'structure' };
  const file = path.join(root, spec.binary);
  const fail = (reason, detail, checked = 'structure') => ({ ok: false, reason, detail, entry, file, checked });
  let stat = null;
  try {
    stat = fs.statSync(file);
  } catch {
    // reported below
  }
  if (!stat || !stat.isFile()) return fail('launcher_missing', `${spec.binary} is missing`);
  if (stat.size !== entry.binary.bytes || sha256File(file) !== entry.binary.sha256) {
    return fail('launcher_corrupt', `${spec.binary} does not match the manifest`);
  }
  const version = osVersion !== undefined ? osVersion : readMacosVersion();
  if (version && compareVersions(version, entry.minMacos) === -1) {
    return fail('os_too_old', `macOS ${version} is below ${entry.minMacos}`);
  }
  if (!smoke) return { ok: true, reason: '', detail: '', entry, file, checked: 'structure' };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'botboy-launcher-check-'));
  try {
    const copy = path.join(dir, 'BotBoy');
    fs.copyFileSync(file, copy);
    fs.chmodSync(copy, 0o755);
    if (!codesignVerifies(copy, { run })) return fail('launcher_codesign_failed', 'the code signature does not verify', 'smoke');
    const outcome = smokeLauncherEverywhere(copy, { startScript, run });
    if (!outcome.ok) return fail('launcher_smoke_failed', outcome.detail, 'smoke');
    return { ok: true, reason: '', detail: '', entry, file, checked: 'smoke' };
  } finally {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
}

/**
 * The start path a LEGACY launcher (built per Mac, before launcherVersion 2)
 * embeds, or ''. A compiled one holds it as its own NUL-terminated string
 * (never a fragment of a longer message); a script one in START_SH='...'. The
 * generic launchers hold none, which is also how a half-migrated bundle (new
 * Info.plist, old executable) is recognized.
 */
export function findBakedStartScript(file) {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > 32 * 1024 * 1024) return '';
    const text = fs.readFileSync(file).toString('latin1');
    const script = /^START_SH=('(?:[^']|'\\'')*')\s*$/m.exec(text);
    if (script && text.startsWith('#!')) {
      const unquoted = script[1].slice(1, -1).split("'\\''").join("'");
      return Buffer.from(unquoted, 'latin1').toString('utf8');
    }
    for (const candidate of text.split('\u0000')) {
      if (candidate.length > 12 && candidate.length < MAX_CHECKOUT_LENGTH && /^\/[^\u0000-\u001f]+\/start\.sh$/.test(candidate)) {
        return Buffer.from(candidate, 'latin1').toString('utf8');
      }
    }
  } catch {
    // not readable: no baked path
  }
  return '';
}

/**
 * The facts start.sh's launcher plan and the doctor row need beyond what the
 * shell reads itself (file kind, Info.plist keys). An object of strings and
 * numbers; printed as key=value lines by the CLI.
 */
export function launcherFacts({ app, checkout = PACKAGE_ROOT, root = nativeRoot(), home = os.homedir(), run = spawnSync, smoke = false } = {}) {
  const startScript = path.join(fs.realpathSync(checkout), 'start.sh');
  // The smoke (a copy of the prebuilt launcher run natively and under each architecture) costs about a
  // second, so a start asks for it only when it could change the plan; the cheap structural facts are always read.
  const usable = launcherPrebuiltUsable({ root, startScript, run, smoke });
  const exe = path.join(app, 'Contents', 'MacOS', 'BotBoy');
  const installed = sha256File(exe);
  const matches = installed !== '' && Boolean(usable.entry) && installed === usable.entry.binary.sha256;
  const recorded = readCheckoutFile({ home });
  const baked = findBakedStartScript(exe);
  const oneLine = (text) => String(text ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 200);
  let installedSmoke = 'unchecked';
  if (smoke) {
    // Nothing is run from inside the app (running a program from inside a *.app makes macOS assess and may register the
    // bundle, and a launcher of unknown origin may predate the print-target hook and would START the app). When the
    // installed bytes ARE the prebuilt launcher, the smoke of the checkout's copy, run in a private folder, answers.
    if (!matches) installedSmoke = 'n/a';
    else if (usable.ok && usable.checked === 'smoke') installedSmoke = 'ok';
    else installedSmoke = `failed: ${oneLine(usable.detail || usable.reason)}`;
  }
  return {
    checkout: path.dirname(startScript),
    prebuilt_usable: !usable.ok ? 0 : (usable.checked === 'smoke' ? 1 : 'unchecked'),
    prebuilt_reason: usable.ok ? '' : usable.reason,
    prebuilt_detail: usable.ok ? '' : oneLine(usable.detail),
    want_version: LAUNCHER_VERSION,
    installed_matches_prebuilt: matches ? 1 : 0,
    installed_smoke: installedSmoke,
    recorded_checkout: recorded?.checkout ?? '',
    recorded_live: recorded && isExecutableFile(path.join(recorded.checkout, 'start.sh')) ? 1 : 0,
    legacy_baked_path: baked,
    legacy_baked_live: baked && isExecutableFile(baked) ? 1 : 0,
  };
}

// ── CLI ──────────────────────────────────────────────────────────────────────

function usage() {
  console.error('usage: node scripts/native-prebuilt.mjs verify [--json]\n       node scripts/native-prebuilt.mjs launcher-facts --app <BotBoy.app> [--checkout <folder>] [--smoke]');
  return 2;
}

export function main(argv = process.argv.slice(2)) {
  const [command, ...rest] = argv;
  if (command === 'verify') {
    if (rest.some((arg) => arg !== '--json')) return usage();
    const root = nativeRoot();
    const checked = verifyTierA({ root, skipSourceCurrency: fs.existsSync(path.join(root, '.botboy-distribution')) });
    if (rest.includes('--json')) console.log(JSON.stringify(checked, null, 2));
    else if (!checked.ok) console.error(formatProblems(checked.problems));
    else console.log('Prebuilt native helpers match the manifest.');
    return checked.ok ? 0 : 1;
  }
  if (command === 'launcher-facts') {
    const value = (flag) => {
      const index = rest.indexOf(flag);
      return index > -1 ? rest[index + 1] : undefined;
    };
    const known = new Set(['--app', '--checkout']);
    const smoke = rest.includes('--smoke');
    const pairs = rest.filter((arg) => arg !== '--smoke');
    for (let index = 0; index < pairs.length; index += 2) if (!known.has(pairs[index]) || pairs[index + 1] === undefined) return usage();
    const app = value('--app');
    if (!app || !path.isAbsolute(app)) return usage();
    try {
      const facts = launcherFacts({ app, smoke, ...(value('--checkout') ? { checkout: value('--checkout') } : {}) });
      for (const [key, entry] of Object.entries(facts)) console.log(`${key}=${entry}`);
      return 0;
    } catch (error) {
      console.error(`launcher-facts failed: ${String(error?.message ?? error).slice(0, 200)}`);
      return 1;
    }
  }
  return usage();
}

export function isMainModule(metaUrl, argv1) {
  try {
    return Boolean(argv1) && fileURLToPath(metaUrl) === fs.realpathSync(argv1);
  } catch {
    return false;
  }
}

if (isMainModule(import.meta.url, process.argv[1])) {
  process.exitCode = main();
}
