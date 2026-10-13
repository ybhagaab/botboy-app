/**
 * The remembered outcome of the optional OCR helper check: the read side.
 *
 * `scripts/bootstrap-deps.mjs` is the only writer. It records
 * ~/.personal-productivity-tracker/ocr-helper-build.json in one of two cases
 * (format: the header of that script and docs/maps/native-helpers.md):
 *   - a compile was attempted and FAILED or TIMED OUT  (kind failed | timeout);
 *   - no helper is usable and NOTHING WAS ATTEMPTED, because there is no
 *     toolchain to compile with  (kind unavailable, with a reasonCode and the
 *     sentence the owner was shown).
 * A usable current helper or a successful build deletes the file. The server
 * only reads it, so that what it prints at boot is true.
 *
 * The two kinds are kept apart on purpose (design review 1, finding 8):
 * `readOcrBuildFailure()` returns only a real build failure, so nothing that
 * says "could not be built ... update the Command Line Tools" is ever printed
 * for a Mac where nothing was tried (macOS below the floor, a damaged prebuilt
 * file, a download flag that would not clear). `readOcrUnavailable()` returns
 * the other kind, and its `reason` is the sentence to print.
 *
 * Fail-open by design: a missing, unreadable, oversized, or malformed file reads
 * as "nothing remembered" and every message keeps its original wording. The
 * server never writes, repairs, or deletes the file.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface OcrBuildFailure {
  kind: 'failed' | 'timeout';
  /** ISO-8601, UTC. */
  failedAt: string;
  /** Wall time of the failed attempt; null when the marker does not record it. */
  durationMs: number | null;
  /** One line: the first compiler error line, or why the compile timed out. */
  reason: string;
}

export interface OcrUnavailable {
  /** manifest_missing, prebuilt_corrupt, os_too_old, quarantined, smoke_failed, ... */
  reasonCode: string;
  /** The sentence the owner was shown, naming the next action. */
  reason: string;
  /** ISO-8601, UTC. */
  notedAt: string;
  /** The manifest's binary hash the outcome was recorded against, when there was a manifest. */
  prebuilt: string | null;
}

const MARKER_SCHEMA = 1;
const MAX_MARKER_BYTES = 16 * 1024;

export function ocrBuildMarkerPath(homeDir: string = os.homedir()): string {
  return path.join(homeDir, '.personal-productivity-tracker', 'ocr-helper-build.json');
}

type RawMarker = {
  kind: 'failed' | 'timeout' | 'unavailable';
  failedAt: string;
  durationMs: number | null;
  reason: string;
  reasonCode: string | null;
  prebuilt: string | null;
};

/** The marker as a validated record, or null (also for any file that cannot be trusted). */
function readMarker(file: string): RawMarker | null {
  try {
    if (fs.statSync(file).size > MAX_MARKER_BYTES) return null;
    const value = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown> | null;
    if (!value || typeof value !== 'object' || value.schema !== MARKER_SCHEMA) return null;
    if (value.kind !== 'failed' && value.kind !== 'timeout' && value.kind !== 'unavailable') return null;
    if (typeof value.failedAt !== 'string' || !Number.isFinite(Date.parse(value.failedAt))) return null;
    if (typeof value.reason !== 'string') return null;
    if (value.kind === 'unavailable' && (typeof value.reasonCode !== 'string' || value.reasonCode === '')) return null;
    const signature = value.signature as Record<string, unknown> | null | undefined;
    if (!signature || typeof signature.source !== 'string' || typeof signature.swiftc !== 'string' || typeof signature.osBuild !== 'string') return null;
    const duration = value.durationMs;
    return {
      kind: value.kind,
      failedAt: value.failedAt,
      durationMs: typeof duration === 'number' && Number.isFinite(duration) && duration >= 0 ? Math.round(duration) : null,
      reason: value.reason,
      reasonCode: typeof value.reasonCode === 'string' ? value.reasonCode : null,
      prebuilt: typeof signature.prebuilt === 'string' && signature.prebuilt !== '' ? signature.prebuilt : null,
    };
  } catch {
    return null;
  }
}

/** The remembered failed or timed-out BUILD, or null. An "unavailable" outcome is not a build failure. */
export function readOcrBuildFailure(options: { file?: string } = {}): OcrBuildFailure | null {
  const marker = readMarker(options.file ?? ocrBuildMarkerPath());
  if (!marker || (marker.kind !== 'failed' && marker.kind !== 'timeout')) return null;
  return { kind: marker.kind, failedAt: marker.failedAt, durationMs: marker.durationMs, reason: marker.reason };
}

/** The remembered "nothing could be attempted" outcome, or null. */
export function readOcrUnavailable(options: { file?: string } = {}): OcrUnavailable | null {
  const marker = readMarker(options.file ?? ocrBuildMarkerPath());
  if (!marker || marker.kind !== 'unavailable' || !marker.reasonCode) return null;
  return { reasonCode: marker.reasonCode, reason: marker.reason, notedAt: marker.failedAt, prebuilt: marker.prebuilt };
}

/**
 * What is true once the OCR helper BUILD has failed on this Mac, as ONE line.
 * Used by the boot checks that used to say "run npm run bootstrap". Never used
 * for an "unavailable" outcome: nothing was built there.
 */
export function ocrHelperUnavailableLine(): string {
  return 'The OCR helper could not be built on this Mac, so images and scanned PDFs are unavailable (text PDFs still work). '
    + 'See ./start.sh --doctor. A failed build usually means the Xcode Command Line Tools are out of date or half-installed: '
    + 'update them in System Settings > General > Software Update, then run ./start.sh --rebuild-ocr.';
}
