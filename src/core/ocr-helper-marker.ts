/**
 * The remembered failure of the optional OCR helper build: the read side.
 *
 * `scripts/bootstrap-deps.mjs` is the only writer. After a failed or timed-out
 * compile it records ~/.personal-productivity-tracker/ocr-helper-build.json,
 * and a successful build deletes it (format: the header of that script and
 * docs/maps/teammate-install-release.md). The server only reads it, so that
 * the advice it prints at boot is true: when the build already failed on this
 * Mac, "run npm run bootstrap" would just fail again.
 *
 * Fail-open by design: a missing, unreadable, oversized, or malformed file reads
 * as "no remembered failure" and every message keeps its original wording. The
 * server never writes, repairs, or deletes the file. It does not recompute the
 * signature either (that needs the Swift compiler): start.sh's background job
 * owns the retry decision and removes the marker when a later build succeeds.
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

const MARKER_SCHEMA = 1;
const MAX_MARKER_BYTES = 16 * 1024;

export function ocrBuildMarkerPath(homeDir: string = os.homedir()): string {
  return path.join(homeDir, '.personal-productivity-tracker', 'ocr-helper-build.json');
}

/** The remembered failed build, or null (also for any file that cannot be trusted). */
export function readOcrBuildFailure(options: { file?: string } = {}): OcrBuildFailure | null {
  try {
    const file = options.file ?? ocrBuildMarkerPath();
    if (fs.statSync(file).size > MAX_MARKER_BYTES) return null;
    const value = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown> | null;
    if (!value || typeof value !== 'object' || value.schema !== MARKER_SCHEMA) return null;
    if (value.kind !== 'failed' && value.kind !== 'timeout') return null;
    if (typeof value.failedAt !== 'string' || !Number.isFinite(Date.parse(value.failedAt))) return null;
    if (typeof value.reason !== 'string') return null;
    const signature = value.signature as Record<string, unknown> | null | undefined;
    if (!signature || typeof signature.source !== 'string' || typeof signature.swiftc !== 'string' || typeof signature.osBuild !== 'string') return null;
    const duration = value.durationMs;
    return {
      kind: value.kind,
      failedAt: value.failedAt,
      durationMs: typeof duration === 'number' && Number.isFinite(duration) && duration >= 0 ? Math.round(duration) : null,
      reason: value.reason,
    };
  } catch {
    return null;
  }
}

/**
 * What is true once the OCR helper build has failed on this Mac, as ONE line.
 * Used by the boot checks that used to say "run npm run bootstrap".
 */
export function ocrHelperUnavailableLine(): string {
  return 'The OCR helper could not be built on this Mac, so images and scanned PDFs are unavailable (text PDFs still work). '
    + 'See ./start.sh --doctor. A failed build usually means the Xcode Command Line Tools are out of date or half-installed: '
    + 'update them in System Settings > General > Software Update, then run ./start.sh --rebuild-ocr.';
}
