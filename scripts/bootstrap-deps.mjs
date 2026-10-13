#!/usr/bin/env node
/**
 * bootstrap-deps — build/verify/install local tool dependencies.
 *
 * Modes:
 *   node scripts/bootstrap-deps.mjs                  verify + build helper (no installs); run by hand
 *                                                    (npm run bootstrap / setup) it retries a failed OCR
 *                                                    build, run by npm's postinstall it does not
 *   node scripts/bootstrap-deps.mjs --install        also install missing core tools via Homebrew
 *   node scripts/bootstrap-deps.mjs --install --with-optional
 *                                                    also install the optional set (ffmpeg, whisper, ollama)
 *   node scripts/bootstrap-deps.mjs --ocr-helper     only the OCR helper: what start.sh runs in the
 *                                                    background once the dashboard window is open.
 *                                                    Progress and compiler detail go to stderr, the one
 *                                                    note meant for the owner goes to stdout
 *   node scripts/bootstrap-deps.mjs --ocr-helper --force-ocr
 *                                                    the same, ignoring a remembered failure
 *                                                    (./start.sh --rebuild-ocr)
 *   node scripts/bootstrap-deps.mjs --ocr-marker     print the remembered failure as one sentence for
 *                                                    ./start.sh --doctor (nothing when there is none)
 *   node scripts/bootstrap-deps.mjs --ocr-status     print the `ocr helper:` doctor row (which helper this
 *                                                    Mac uses and why) and exit 0 when one is usable, 1
 *                                                    when none is. Read-only: it clears and writes nothing
 *
 * Idempotent and safely re-runnable:
 *   - Makes node-pty's prebuilt macOS spawn-helper executable (its npm
 *     tarball drops the execute bit).
 *   - Decides which OCR helper this Mac uses (scripts/native-prebuilt.mjs): the
 *     PREBUILT universal helper that ships in native/vision-ocr/prebuilt, or a
 *     local build. A current helper means nothing is compiled and no toolchain
 *     is probed. Only when there is none (or a stale one) and a Swift toolchain
 *     exists is `vision-ocr` compiled locally, as a background last resort.
 *   - Verifies every external CLI tool BotBoy shells out to (the canonical
 *     registry lives in src/core/toolchain.ts — keep the lists aligned).
 *   - With --install, installs missing Homebrew formulas non-interactively.
 *   - Does NOT modify OS-wide auto-update settings.
 *
 * Safe to run on non-macOS (it no-ops the OCR build with a clear notice) so it
 * can sit in a guarded `postinstall` without breaking CI installs.
 *
 * The OCR helper is optional (BotBoy reads PDF text with pdf.js and works
 * without it), so it must never hold anything up:
 *   - The compile has a hard timeout, BOTBOY_OCR_BUILD_TIMEOUT_SECONDS
 *     (default 120), so it cannot hang `npm install` or the background job.
 *     A timed-out compile is killed with its children, and the compiler output
 *     is cut to its first 20 and last 5 lines plus one summary line.
 *   - The helper is compiled in a staging folder and moved into place, so a
 *     killed or failed build never leaves a half-written helper behind.
 *   - A failed or timed-out build is REMEMBERED per machine, so the same
 *     failure is not retried at every start (Maria's Mac, 2026-10-13: a Command
 *     Line Tools / SDK mismatch made every start compile and fail again).
 *     start.sh sets BOTBOY_DEFER_OCR_BUILD=1 for its own `npm install`, which
 *     then skips the compile; the background job builds the helper instead.
 *
 * OCR helper marker — ONE format, written only by this script:
 *   File:  ~/.personal-productivity-tracker/ocr-helper-build.json (0600; the
 *          folder is created 0700 when missing). Lock: ocr-helper-build.lock/
 *          beside it (a folder; one build at a time).
 *   {
 *     "schema": 1,
 *     "kind": "failed" | "timeout" | "unavailable",
 *     "failedAt": "<ISO-8601 UTC>",
 *     "durationMs": <integer, wall time of the failed attempt; null for unavailable>,
 *     "reason": "<one line: the first compiler error line, why it timed out, or for
 *                 unavailable the sentence the owner was shown>",
 *     "reasonCode": "<unavailable only: manifest_missing | manifest_invalid | prebuilt_missing |
 *                     prebuilt_corrupt | prebuilt_not_executable | os_too_old | quarantined |
 *                     smoke_failed | resolver_error>",
 *     "signature": {
 *       "source": "<sha256 of native/vision-ocr/main.swift>",
 *       "swiftc": "<first line of swiftc --version; empty when there is no toolchain>",
 *       "osBuild": "<sw_vers -buildVersion>",
 *       "prebuilt": "<sha256 of the manifest's binary; the key is absent when there is no manifest>"
 *     }
 *   }
 *   `unavailable` means no helper is usable and NOTHING WAS ATTEMPTED (no toolchain
 *   to compile with); it must never be worded as a failed build. While the
 *   signature (and reasonCode) is unchanged the note is not printed again. It is
 *   tried again when any part changes (a release updates main.swift or the
 *   prebuilt, the compiler or macOS is updated, a toolchain appears) or when the
 *   owner asks (./start.sh --rebuild-ocr, npm run bootstrap). A usable current
 *   helper or a successful build deletes the marker. Readers: this script (the
 *   skip, --ocr-marker for start.sh --doctor) and the server
 *   (src/core/ocr-helper-marker.ts, read-only and fail-open).
 */

import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, rmdirSync, statSync, writeFileSync } from 'fs';
import { createHash } from 'crypto';
import { execFileSync } from 'child_process';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const swiftSrc = path.join(root, 'native', 'vision-ocr', 'main.swift');
const binDir = path.join(root, 'native', 'vision-ocr', 'bin');
const bin = path.join(binDir, 'vision-ocr');
// Written beside a local build: the SHA-256 of the main.swift it was built from.
const builtFromFile = path.join(binDir, 'vision-ocr.built-from');

// scripts/native-prebuilt.mjs holds the manifest and the resolver. A damaged
// checkout may lack it (or it may fail to load): then this script behaves as it
// did before prebuilt helpers existed (the compile path), so `npm install`
// still cannot fail on OCR.
let prebuilt = null;
try {
  prebuilt = await import('./native-prebuilt.mjs');
} catch {
  prebuilt = null;
}

const INSTALL = process.argv.includes('--install');
const WITH_OPTIONAL = process.argv.includes('--with-optional');

// Absolute system tools. The Xcode shims in /usr/bin raise the macOS install
// dialog on a Mac without Command Line Tools, so they run only through
// detectSwiftToolchain, and `xcode-select -p` always runs first. The
// BOTBOY_TEST_* overrides exist for tests; production never sets them.
const XCODE_SELECT_BIN = process.env.BOTBOY_TEST_XCODE_SELECT_BIN || '/usr/bin/xcode-select';
const XCRUN_BIN = process.env.BOTBOY_TEST_XCRUN_BIN || '/usr/bin/xcrun';
const SW_VERS_BIN = process.env.BOTBOY_TEST_SW_VERS_BIN || '/usr/bin/sw_vers';

// Every probe is short (milliseconds on a healthy Mac); a stuck one must not
// hold the background job or `npm install`.
const PROBE_TIMEOUT_MS = 15_000;
const DEFAULT_OCR_BUILD_TIMEOUT_SECONDS = 120;
const OCR_HEAD_LINES = 20;
const OCR_TAIL_LINES = 5;
const OCR_MARKER_SCHEMA = 1;
const OCR_MARKER_KINDS = ['failed', 'timeout', 'unavailable'];

// Keep aligned with TOOL_REGISTRY in src/core/toolchain.ts.
// Core is EMPTY by design: BotBoy's own pdf.js reader (scripts/pdf-text.mjs,
// an npm dependency) reads PDF text on every install, and the native
// vision-ocr helper (built below) adds faster PDF text, page rasterization,
// and OCR via PDFKit/CoreGraphics/Vision. Homebrew is fully optional.
const CORE_FORMULAS = [];
const OPTIONAL_FORMULAS = [
  { bins: ['pdftotext', 'pdftoppm'], formula: 'poppler', why: 'PDF tooling fallback (native helper is primary)' },
  { bins: ['ffmpeg'], formula: 'ffmpeg', why: 'audio/video conversion' },
  { bins: ['whisper'], formula: 'openai-whisper', why: 'audio transcription' },
  { bins: ['ollama'], formula: 'ollama', why: 'local LLM fallback' },
];

// `log` carries progress and diagnostics: stdout normally, stderr in
// --ocr-helper mode (start.sh sends that to the log). `say` is the one place
// text meant for the owner is printed, always on stdout.
let writeDiagnostic = (line) => console.log(line);
// The background job (--ocr-helper) runs at every start and must stay silent when
// nothing is wrong; npm's postinstall and a run by hand say which helper they found.
let quietWhenCurrent = false;

function log(msg) {
  writeDiagnostic(`[bootstrap-deps] ${msg}`);
}

function say(line) {
  console.log(line);
}

function hasBin(b) {
  // Search PATH plus the install layouts BotBoy's runtime discovery checks,
  // so verification matches what the server will actually find.
  const home = os.homedir();
  const dirs = [
    ...(process.env.PATH || '').split(path.delimiter),
    path.join(home, 'homebrew', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    path.join(home, '.local', 'bin'),
    '/usr/bin',
    '/bin',
  ];
  return dirs.filter(Boolean).some((d) => existsSync(path.join(d, b)));
}

function findBrew() {
  const home = os.homedir();
  const candidates = [
    ...(process.env.PATH || '').split(path.delimiter).map((d) => path.join(d, 'brew')),
    path.join(home, 'homebrew', 'bin', 'brew'),
    '/opt/homebrew/bin/brew',
    '/usr/local/bin/brew',
  ];
  return candidates.find((c) => c && existsSync(c)) || null;
}

/**
 * Whether a Swift compiler is reachable, without ever raising the macOS
 * "install developer tools" dialog: `xcode-select -p` answers silently, and
 * only after it succeeds is `xcrun --find swiftc` asked for the real path.
 * Never launches `xcode-select --install`.
 */
export function detectSwiftToolchain({ run = execFileSync } = {}) {
  try {
    run(XCODE_SELECT_BIN, ['-p'], { stdio: 'pipe', timeout: PROBE_TIMEOUT_MS, killSignal: 'SIGKILL' });
  } catch {
    return { ok: false, reason: 'no-clt' };
  }
  try {
    const swiftc = String(run(XCRUN_BIN, ['--find', 'swiftc'], { stdio: 'pipe', encoding: 'utf8', timeout: PROBE_TIMEOUT_MS, killSignal: 'SIGKILL' })).trim();
    if (swiftc) return { ok: true, swiftc };
  } catch {
    // fall through
  }
  return { ok: false, reason: 'no-swiftc' };
}

/**
 * Arguments that point swiftc at the macOS SDK. The shim in /usr/bin/swiftc
 * runs through xcrun, which sets SDKROOT; the absolute path xcrun returns does
 * not, and then fails with "unable to load standard library" (seen 2026-10-12
 * on a Mac with Command Line Tools). Best effort: no answer means no argument.
 */
export function swiftSdkArgs({ run = execFileSync } = {}) {
  try {
    const sdk = String(run(XCRUN_BIN, ['--show-sdk-path'], { stdio: 'pipe', encoding: 'utf8', timeout: PROBE_TIMEOUT_MS, killSignal: 'SIGKILL' })).trim();
    return sdk ? ['-sdk', sdk] : [];
  } catch {
    return [];
  }
}

export function ocrNotBuiltNote() {
  return 'OCR helper not built: install Xcode Command Line Tools with `xcode-select --install`; BotBoy works without it except text from images and scanned PDFs';
}

/** Seconds as people read them: 4.2 below ten, whole seconds from ten up. */
export function formatSeconds(ms) {
  const seconds = Math.max(0, Number(ms) || 0) / 1000;
  return seconds < 10 ? seconds.toFixed(1) : String(Math.round(seconds));
}

/** The summary line of a failed build (the log keeps this and the cut-down compiler output). */
export function ocrBuildFailedNote(firstLine, { durationMs } = {}) {
  const after = typeof durationMs === 'number' ? ` after ${formatSeconds(durationMs)} s` : '';
  return `OCR helper build failed${after} (${firstLine || 'unknown error'}); BotBoy works without it except text from images and scanned PDFs`;
}

/**
 * The one calm note printed (terminal and log) when a build fails or times
 * out. At most once per signature, because a remembered failure is not retried.
 */
export function ocrOffNote() {
  return "Text reading from images and scanned PDFs (OCR) is off: the Swift tools on this Mac cannot build BotBoy's helper (usually the Command Line Tools and macOS versions do not match). BotBoy works fine without it. To enable it, update macOS and the Command Line Tools in System Settings > General > Software Update, then run ./start.sh --rebuild-ocr.";
}

/**
 * The variant when a rebuild failed but a working helper (the prebuilt one, or
 * an older local build) is still in use: nothing is off, an update did not happen.
 */
export function ocrKeptNote(reason) {
  const why = reason ? ` (${reason})` : '';
  return `Could not update BotBoy's reader for images and scanned PDFs${why}; the previous reader stays and keeps working. To retry, update macOS and the Command Line Tools in System Settings > General > Software Update, then run ./start.sh --rebuild-ocr.`;
}

/** True when this file is the script node was started with, also through symlinks (os.tmpdir() is one on macOS). */
export function isMainModule(metaUrl, argv1) {
  try {
    if (!argv1) return false;
    return fileURLToPath(metaUrl) === realpathSync(argv1);
  } catch {
    return false;
  }
}

// ── OCR helper: remembered failures ──────────────────────────────────────────

function privateRoot(home = os.homedir()) {
  return path.join(home, '.personal-productivity-tracker');
}

export function ocrMarkerPath(home) {
  return path.join(privateRoot(home), 'ocr-helper-build.json');
}

function ocrLockPath(home) {
  return path.join(privateRoot(home), 'ocr-helper-build.lock');
}

/** The hard limit for one compile, from BOTBOY_OCR_BUILD_TIMEOUT_SECONDS (default 120; 0.25 to 3600 accepted). */
export function ocrBuildTimeoutMs(env = process.env) {
  const asked = Number(String(env.BOTBOY_OCR_BUILD_TIMEOUT_SECONDS ?? '').trim());
  const seconds = Number.isFinite(asked) && asked >= 0.25 && asked <= 3600 ? asked : DEFAULT_OCR_BUILD_TIMEOUT_SECONDS;
  return Math.round(seconds * 1000);
}

function oneLine(text, max = 240) {
  const clean = String(text ?? '')
    .replace(/\u001b\[[0-9;]*[A-Za-z]/g, '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

function firstLine(text, max = 200) {
  const line = String(text ?? '').split('\n').map((entry) => oneLine(entry, max)).find(Boolean);
  return line || '';
}

function sha256OfFile(file) {
  try {
    return createHash('sha256').update(readFileSync(file)).digest('hex');
  } catch {
    return '';
  }
}

function probeLine(run, file, args) {
  try {
    return firstLine(run(file, args, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: PROBE_TIMEOUT_MS, killSignal: 'SIGKILL' }));
  } catch {
    return '';
  }
}

/** The SHA-256 of the manifest's prebuilt OCR binary, or '' when there is no usable manifest. */
function prebuiltBinarySha() {
  try {
    const read = prebuilt?.readManifest({ root });
    return read?.ok ? read.manifest.artifacts.visionOcr?.binary?.sha256 ?? '' : '';
  } catch {
    return '';
  }
}

/**
 * What a remembered outcome depends on: the helper source, the Swift compiler
 * (empty when there is none), the macOS build, and the prebuilt binary the
 * manifest names. `prebuilt` is left out when empty, so a signature made
 * without a manifest keeps its original three-part shape.
 */
export function computeOcrSignature(swiftc, { run = execFileSync, source = swiftSrc, prebuiltSha = prebuiltBinarySha() } = {}) {
  const signature = {
    source: sha256OfFile(source),
    swiftc: swiftc ? probeLine(run, swiftc, ['--version']) : '',
    osBuild: probeLine(run, SW_VERS_BIN, ['-buildVersion']),
  };
  if (prebuiltSha) signature.prebuilt = prebuiltSha;
  return signature;
}

export function sameOcrSignature(a, b) {
  return Boolean(a && b)
    && a.source !== ''
    && a.source === b.source
    && a.swiftc === b.swiftc
    && a.osBuild === b.osBuild
    && (a.prebuilt ?? '') === (b.prebuilt ?? '');
}

/**
 * The remembered failure, or null. Fail-open: a missing, unreadable, oversized,
 * or malformed file reads as "no failure remembered", so the build is tried.
 */
export function readOcrMarker({ file = ocrMarkerPath() } = {}) {
  try {
    const text = readFileSync(file, 'utf8');
    if (text.length > 16 * 1024) return null;
    const value = JSON.parse(text);
    if (!value || typeof value !== 'object' || value.schema !== OCR_MARKER_SCHEMA) return null;
    if (!OCR_MARKER_KINDS.includes(value.kind)) return null;
    if (typeof value.failedAt !== 'string' || !Number.isFinite(Date.parse(value.failedAt))) return null;
    if (typeof value.reason !== 'string') return null;
    if (value.kind === 'unavailable' && (typeof value.reasonCode !== 'string' || value.reasonCode === '')) return null;
    const signature = value.signature;
    if (!signature || typeof signature.source !== 'string' || typeof signature.swiftc !== 'string' || typeof signature.osBuild !== 'string') return null;
    const marker = {
      schema: OCR_MARKER_SCHEMA,
      kind: value.kind,
      failedAt: value.failedAt,
      durationMs: Number.isFinite(value.durationMs) && value.durationMs >= 0 ? Math.round(value.durationMs) : null,
      reason: value.reason,
      signature: { source: signature.source, swiftc: signature.swiftc, osBuild: signature.osBuild },
    };
    if (typeof signature.prebuilt === 'string' && signature.prebuilt !== '') marker.signature.prebuilt = signature.prebuilt;
    if (value.kind === 'unavailable') marker.reasonCode = value.reasonCode;
    return marker;
  } catch {
    return null;
  }
}

/** Write the marker atomically and privately. Never throws; false when it could not be written. */
export function writeOcrMarker(marker, { file = ocrMarkerPath() } = {}) {
  const staged = `${file}.${process.pid}.tmp`;
  try {
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(staged, `${JSON.stringify({ schema: OCR_MARKER_SCHEMA, ...marker }, null, 2)}\n`, { mode: 0o600 });
    chmodSync(staged, 0o600);
    renameSync(staged, file);
    return true;
  } catch {
    try {
      rmSync(staged, { force: true });
    } catch {
      // nothing more to do
    }
    return false;
  }
}

export function clearOcrMarker({ file = ocrMarkerPath() } = {}) {
  try {
    rmSync(file, { force: true });
  } catch {
    // a marker that cannot be removed only costs one more silent skip
  }
}

function localDate(iso) {
  const date = new Date(iso);
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * The sentence ./start.sh --doctor appends to its xcode-clt row: a BUILD failure
 * only. An `unavailable` marker means nothing was attempted, so it never
 * reads as a failed build (its words are on the `ocr helper:` row).
 */
export function ocrMarkerDoctorText(marker) {
  if (marker.kind !== 'failed' && marker.kind !== 'timeout') return '';
  const after = marker.durationMs == null ? '' : ` after ${formatSeconds(marker.durationMs)} s`;
  return `OCR helper build failed on ${localDate(marker.failedAt)}${after}: ${oneLine(marker.reason, 240) || 'no reason recorded'}`;
}

/**
 * One build at a time: a folder made with an atomic mkdir. A lock older than
 * maxAgeMs belongs to a killed run and is taken over. If the lock cannot be
 * made for any reason other than "already there", the build goes ahead.
 */
export function acquireOcrBuildLock({ dir = ocrLockPath(), maxAgeMs, now = Date.now } = {}) {
  try {
    mkdirSync(path.dirname(dir), { recursive: true, mode: 0o700 });
  } catch {
    return { ok: true, release() {} };
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      mkdirSync(dir);
      return {
        ok: true,
        release() {
          try {
            rmdirSync(dir);
          } catch {
            // already gone
          }
        },
      };
    } catch (error) {
      if (error?.code !== 'EEXIST') return { ok: true, release() {} };
      let ageMs = Infinity;
      try {
        ageMs = now() - statSync(dir).mtimeMs;
      } catch {
        // vanished between the two calls: try to take it
      }
      // A lock dated well in the future (the clock was set back) cannot be a live one for
      // long; a few seconds ahead is only timestamp rounding.
      if (ageMs >= -5000 && ageMs <= maxAgeMs) return { ok: false, ageMs };
      try {
        rmdirSync(dir);
      } catch {
        // someone else took it over first
      }
    }
  }
  return { ok: false, ageMs: 0 };
}

// ── OCR helper: compiler output ──────────────────────────────────────────────

function outputLines(text) {
  return String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/\u001b\[[0-9;]*[A-Za-z]/g, '').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ').trimEnd())
    .filter((line) => line.trim() !== '')
    .map((line) => (line.length > 400 ? `${line.slice(0, 399)}…` : line));
}

/** The first `head` and last `tail` lines of the compiler output (all of it when short). */
export function excerptCompilerOutput(text, head = OCR_HEAD_LINES, tail = OCR_TAIL_LINES) {
  const lines = outputLines(text);
  const total = lines.length;
  if (total <= head + tail) return { lines, total, omitted: 0 };
  return { lines: [...lines.slice(0, head), ...lines.slice(total - tail)], total, omitted: total - head - tail };
}

function plainPaths(text) {
  const home = os.homedir();
  let result = String(text).split(`${root}${path.sep}`).join('');
  if (home && home.length > 1) result = result.split(home).join('~');
  return result;
}

/** The first line that reports an error (else the first line). A display choice, never a classification. */
export function firstErrorLine(text) {
  const lines = outputLines(text);
  const hit = lines.find((line) => /\berror:/i.test(line)) ?? lines[0] ?? '';
  return oneLine(plainPaths(hit), 240);
}

function failureReason(result) {
  if (result.timedOut) return 'the compiler did not finish in time';
  const fromOutput = firstErrorLine(result.output);
  if (fromOutput) return fromOutput;
  if (typeof result.status === 'number') return `the Swift compiler exited with status ${result.status}`;
  if (result.spawnError) return `could not run the Swift compiler (${result.spawnError})`;
  if (result.signal) return `the Swift compiler was stopped by ${result.signal}`;
  return 'the Swift compiler failed';
}

/**
 * Compile the helper into a staging folder and move it into place. The
 * compiler runs with a hard timeout (SIGKILL), in its own process group so a
 * timed-out compile is stopped together with its children. A killed or failed
 * build leaves any existing helper untouched.
 */
function compileOcrHelper(swiftc, timeoutMs) {
  mkdirSync(binDir, { recursive: true });
  // Staging folders left by a killed run (this run holds the lock, so none is in use).
  try {
    for (const name of readdirSync(binDir)) {
      if (name.startsWith('.build-')) rmSync(path.join(binDir, name), { recursive: true, force: true });
    }
  } catch {
    // best effort
  }
  const stage = mkdtempSync(path.join(binDir, '.build-'));
  const staged = path.join(stage, 'vision-ocr');
  const started = Date.now();
  // The source this build is made from, noted before the compile starts.
  const sourceSha = sha256OfFile(swiftSrc);
  try {
    execFileSync(swiftc, [...swiftSdkArgs(), '-O', swiftSrc, '-o', staged], {
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
      timeout: timeoutMs,
      killSignal: 'SIGKILL',
      maxBuffer: 32 * 1024 * 1024,
      detached: true,
    });
    if (!existsSync(staged)) {
      return { ok: false, durationMs: Date.now() - started, output: 'the Swift compiler finished but wrote no helper' };
    }
    chmodSync(staged, 0o755);
    renameSync(staged, bin);
    // Remember which source this build came from, so the resolver can tell a current local build from an outdated
    // one. Without the note it falls back to file times.
    try {
      writeFileSync(builtFromFile, `${sourceSha}\n`);
    } catch {
      // not fatal
    }
    return { ok: true, durationMs: Date.now() - started };
  } catch (error) {
    const timedOut = error?.code === 'ETIMEDOUT';
    // The group id is the compiler's own pid. Only a real pid is signalled: a negative
    // pid of 0 or 1 would mean this process's group or every process.
    if (timedOut && Number.isInteger(error.pid) && error.pid > 1) {
      try {
        process.kill(-error.pid, 'SIGKILL');
      } catch {
        // the group is already gone
      }
    }
    return {
      ok: false,
      timedOut,
      durationMs: Date.now() - started,
      status: typeof error?.status === 'number' ? error.status : undefined,
      signal: error?.signal || undefined,
      spawnError: typeof error?.code === 'string' && error.code !== 'ETIMEDOUT' ? error.code : undefined,
      output: `${error?.stderr ?? ''}\n${error?.stdout ?? ''}`,
    };
  } finally {
    try {
      rmSync(stage, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
}

/** The resolver's verdict for this folder, or null when the resolver itself is unavailable (damaged checkout). */
function resolveOcrHelper({ repair = true } = {}) {
  if (!prebuilt) return null;
  try {
    return prebuilt.resolveVisionHelper({ root, repair });
  } catch {
    return null;
  }
}

/**
 * No helper is usable and nothing can be compiled here (no toolchain, or no
 * source to compile). Say so ONCE per signature in the reason table's words,
 * which always name the next action, and remember it as `unavailable`: this is
 * not a failed build and must never read as one.
 */
function noteHelperUnavailable(verdict, { force }) {
  const signature = computeOcrSignature('');
  if (!force) {
    const remembered = readOcrMarker();
    if (remembered && remembered.kind === 'unavailable' && remembered.reasonCode === verdict.reason && sameOcrSignature(remembered.signature, signature)) return 'remembered';
  }
  const line = prebuilt.ocrReasonLine(verdict.reason, { osVersion: verdict.osVersion, minMacos: verdict.minMacos, detail: verdict.detail, root });
  writeOcrMarker({
    kind: 'unavailable',
    reasonCode: verdict.reason,
    failedAt: new Date().toISOString(),
    durationMs: null,
    reason: oneLine(line, 400),
    signature,
  });
  say(`ℹ  ${line}`);
  return 'no-toolchain';
}

/**
 * Returns 'ok' (a current helper, a built one, or nothing to do here),
 * 'no-toolchain' (expected, exit 0), 'remembered' (nothing changed since the
 * last note: silent), 'busy' (another build is running), or 'failed' (compile
 * error or timeout). `force` ignores a remembered outcome; `defer` (npm's
 * postinstall under start.sh) skips the compile.
 *
 * Order, and the reason for it: the resolver runs FIRST. A current helper (the
 * shipped prebuilt one, or a current local build) means no toolchain probe and
 * no compile on any Mac. A helper that works but is older than main.swift stays
 * in use while a newer one is built. Only then is a toolchain looked for.
 */
function buildVisionHelper({ force = false, defer = false } = {}) {
  if (process.platform !== 'darwin') {
    log('skip: Apple Vision OCR helper only builds on macOS (non-darwin platform).');
    return 'ok';
  }
  const verdict = resolveOcrHelper();
  if (verdict?.current) {
    if (!quietWhenCurrent) log(`OCR helper: using the ${verdict.provenance === 'prebuilt' ? 'prebuilt' : 'local'} helper (nothing to build).`);
    clearOcrMarker();
    return 'ok';
  }
  if (!verdict) {
    // Legacy rule (no resolver): build when the binary is missing or older than its source.
    if (!existsSync(swiftSrc)) {
      log(`skip: helper source not found at ${swiftSrc}`);
      return 'ok';
    }
    if (existsSync(bin) && statSync(bin).mtimeMs >= statSync(swiftSrc).mtimeMs) {
      log('vision-ocr helper is up to date.');
      return 'ok';
    }
  }
  if (defer) {
    log('OCR helper build deferred: start.sh builds it in the background once the dashboard window is open.');
    return 'ok';
  }
  const usable = Boolean(verdict) && verdict.provenance !== 'none';
  const toolchain = existsSync(swiftSrc) ? detectSwiftToolchain() : { ok: false, reason: 'no-source' };
  if (!toolchain.ok) {
    if (usable) return 'ok'; // the helper in use works; it just cannot be updated on this Mac
    if (!verdict) {
      say(`ℹ  ${ocrNotBuiltNote()}`);
      return 'no-toolchain';
    }
    return noteHelperUnavailable(verdict, { force });
  }
  const signature = computeOcrSignature(toolchain.swiftc);
  if (!force) {
    const remembered = readOcrMarker();
    if (remembered && remembered.kind !== 'unavailable' && sameOcrSignature(remembered.signature, signature)) return 'remembered';
  }
  const timeoutMs = ocrBuildTimeoutMs();
  const lock = acquireOcrBuildLock({ maxAgeMs: timeoutMs + 60_000 });
  if (!lock.ok) {
    if (force) say('ℹ  Another OCR helper build is already running; give it a minute, then run ./start.sh --doctor.');
    return 'busy';
  }
  try {
    log('building vision-ocr helper...');
    const result = compileOcrHelper(toolchain.swiftc, timeoutMs);
    if (result.ok) {
      clearOcrMarker();
      log(`built ${bin}`);
      return 'ok';
    }
    const reason = failureReason(result);
    const excerpt = excerptCompilerOutput(result.output);
    for (const line of excerpt.lines) console.error(`  ${plainPaths(line)}`);
    const cut = excerpt.omitted > 0 ? ` [compiler output: ${excerpt.total} lines, showing the first ${OCR_HEAD_LINES} and the last ${OCR_TAIL_LINES}]` : '';
    log(`WARNING: ${ocrBuildFailedNote(reason, { durationMs: result.durationMs })}${cut}`);
    writeOcrMarker({
      kind: result.timedOut ? 'timeout' : 'failed',
      failedAt: new Date().toISOString(),
      durationMs: result.durationMs,
      reason,
      signature,
    });
    say(`ℹ  ${usable ? ocrKeptNote(reason) : ocrOffNote()}`);
    return 'failed';
  } finally {
    lock.release();
  }
}

/**
 * node-pty 1.1.0 ships its macOS `spawn-helper` without the execute bit (the
 * npm tarball stores it as 0644), so every terminal spawn fails with
 * `posix_spawnp failed`. Its own install scripts never fix the mode. start.sh
 * repeats this check before each start (native_modules_problem repair).
 */
function makePtySpawnHelperExecutable() {
  const prebuilds = path.join(root, 'node_modules', 'node-pty', 'prebuilds');
  for (const platform of ['darwin-arm64', 'darwin-x64']) {
    const helper = path.join(prebuilds, platform, 'spawn-helper');
    try {
      const mode = statSync(helper).mode;
      if ((mode & 0o111) !== 0o111) {
        chmodSync(helper, (mode & 0o777) | 0o755);
        log(`made node-pty ${platform} spawn-helper executable`);
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') log(`WARNING: could not check node-pty ${platform} spawn-helper: ${error?.message || error}`);
    }
  }
}

function missingEntries(entries) {
  return entries.filter((e) => e.bins.some((b) => !hasBin(b)));
}

function installFormulas(brew, entries) {
  for (const entry of entries) {
    log(`installing ${entry.formula} (${entry.why})...`);
    try {
      execFileSync(brew, ['install', entry.formula], {
        stdio: 'inherit',
        env: { ...process.env, HOMEBREW_NO_AUTO_UPDATE: '1', NONINTERACTIVE: '1' },
        timeout: 15 * 60 * 1000,
      });
    } catch (e) {
      log(`WARNING: brew install ${entry.formula} failed (${e?.message || 'unknown error'}). Install it manually.`);
    }
  }
}

function warnOnCustomBrewPrefix(brew) {
  // Homebrew only ships prebuilt bottles for its default prefix
  // (/opt/homebrew on Apple Silicon). A custom prefix (e.g. ~/homebrew from a
  // no-admin install) forces SOURCE BUILDS: poppler took 35+ minutes on such
  // a setup (observed 2026-08-20). Warn so teammates know why installs crawl.
  if (!brew) return;
  const prefix = path.resolve(brew, '..', '..');
  if (prefix === '/opt/homebrew' || prefix === '/usr/local') return;
  log(`NOTE: your Homebrew prefix is ${prefix} (non-standard).`);
  log('      Installs COMPILE FROM SOURCE instead of using prebuilt bottles — expect long install times.');
  log('      If you have admin rights, the standard install (https://brew.sh) into /opt/homebrew is much faster.');
}

function verifyAndInstallTools() {
  if (process.platform !== 'darwin') {
    log('skip: tool install/verify targets macOS.');
    return;
  }
  warnOnCustomBrewPrefix(findBrew());
  const missingCore = missingEntries(CORE_FORMULAS);
  const missingOptional = missingEntries(OPTIONAL_FORMULAS);

  if (missingCore.length === 0) {
    log('no Homebrew tools are required — pdf.js reads PDF text; the native helper adds OCR for scans and images.');
  } else if (INSTALL) {
    const brew = findBrew();
    if (brew) {
      installFormulas(brew, missingCore);
    } else {
      log('WARNING: Homebrew not found — cannot auto-install. Install brew (https://brew.sh), then run: npm run setup');
      for (const e of missingCore) log(`  missing: ${e.bins.join(', ')} — brew install ${e.formula} (${e.why})`);
    }
  } else {
    for (const e of missingCore) {
      log(`WARNING: missing ${e.bins.join(', ')} — run "npm run setup" or: brew install ${e.formula} (${e.why})`);
    }
  }

  if (WITH_OPTIONAL && INSTALL && missingOptional.length > 0) {
    const brew = findBrew();
    if (brew) installFormulas(brew, missingOptional);
    else log('WARNING: Homebrew not found — skipping optional installs.');
  } else if (missingOptional.length > 0) {
    log(
      `optional tools not installed: ${missingOptional.map((e) => e.formula).join(', ')} ` +
        '(install later with "npm run bootstrap -- --install --with-optional" or brew).',
    );
  }

  if (!hasBin('libreoffice')) {
    log('note: libreoffice absent — .docx/.xlsx fall back to textutil (fine for most files). Optional: brew install --cask libreoffice');
  }
}

/**
 * The `ocr helper:` doctor row. Read-only: nothing is cleared, repaired or
 * written (a flagged file is reported, never executed). Exit 0 when a helper is
 * usable (current or not), 1 when none is. A missing resolver prints `unknown`.
 */
function printOcrStatus() {
  if (!prebuilt) {
    say('ocr helper: unknown (scripts/native-prebuilt.mjs is missing from this folder; run ./start.sh --update)');
    return 1;
  }
  try {
    const verdict = prebuilt.resolveVisionHelper({ root, repair: false, smokeTimeoutMs: 10_000 });
    say(prebuilt.ocrDoctorLine(verdict, { root }));
    return verdict.provenance === 'none' ? 1 : 0;
  } catch {
    say('ocr helper: unknown (the check itself failed; run ./start.sh --update)');
    return 1;
  }
}

/**
 * Returns the exit status. A missing toolchain is expected (exit 0). A compile
 * error or unexpected throw exits 0 only inside `npm install` (postinstall must
 * never fail the install) and 2 otherwise.
 *
 * Who retries a remembered OCR failure: a run by hand (`npm run bootstrap`,
 * `npm run setup`) and `--force-ocr` do, because the owner asked; npm's
 * postinstall and the background job (`--ocr-helper`) do not.
 */
export function main({ argv = process.argv.slice(2), env = process.env } = {}) {
  const ocrOnly = argv.includes('--ocr-helper');
  writeDiagnostic = ocrOnly ? (line) => console.error(line) : (line) => console.log(line);
  quietWhenCurrent = ocrOnly;
  if (argv.includes('--ocr-marker')) {
    const remembered = readOcrMarker();
    const sentence = remembered ? ocrMarkerDoctorText(remembered) : '';
    if (sentence) say(sentence);
    return 0;
  }
  if (argv.includes('--ocr-status')) {
    return printOcrStatus();
  }
  const lenient = env.npm_lifecycle_event === 'postinstall';
  const force = argv.includes('--force-ocr') || (!ocrOnly && !lenient);
  try {
    if (!ocrOnly) makePtySpawnHelperExecutable();
    const built = buildVisionHelper({ force, defer: lenient && env.BOTBOY_DEFER_OCR_BUILD === '1' });
    if (!ocrOnly) {
      verifyAndInstallTools();
      log('done.');
    }
    return built === 'failed' && !lenient ? 2 : 0;
  } catch (error) {
    log(`WARNING: unexpected failure: ${error?.message || error}`);
    return lenient ? 0 : 2;
  }
}

if (isMainModule(import.meta.url, process.argv[1])) {
  // A closed pipe (the terminal or tee went away) must not crash the run.
  process.stdout.on('error', () => {});
  process.stderr.on('error', () => {});
  process.exitCode = main();
}
