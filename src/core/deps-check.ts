/**
 * Dependency verification for local parsing + OCR
 * (lossless-capture-brain-pipeline R13).
 *
 * At startup the app verifies the capabilities lossless extraction needs and
 * reports missing ones with actionable messages. Missing capabilities are
 * surfaced (never silently skipped) so no content is quietly dropped.
 *
 * The OCR helper ships PREBUILT; which helper this Mac uses is decided by
 * native-helpers.ts (one table, shared with start.sh and the doctor). OCR only
 * adds text from images and scanned PDFs, so its absence is information, not
 * a failure of the install: `DepsReport.ok` turns on the readers BotBoy cannot
 * work without, and `DepsReport.ocrOnly` says the only gap is the optional
 * OCR helper.
 */

import { existsSync } from 'fs';
import { execFileSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  currentVisionHelper,
  isHelperLatchedOff,
  localVisionHelperPath,
  ocrReasonLine,
  usableVisionHelperPath,
  type HelperProvenance,
  type HelperVerdict,
} from './native-helpers.js';
import {
  ocrHelperUnavailableLine,
  readOcrBuildFailure,
  readOcrUnavailable,
  type OcrBuildFailure,
  type OcrUnavailable,
} from './ocr-helper-marker.js';

export interface DepStatus {
  name: string;
  ok: boolean;
  detail: string;
}

export interface DepsReport {
  ok: boolean;
  deps: DepStatus[];
  /** Human-readable, actionable summary of what's missing (empty if all ok). */
  message: string;
  /** True when the only thing missing is the optional OCR helper (images and scanned PDFs). */
  ocrOnly: boolean;
}

function commandExists(bin: string): boolean {
  try {
    // `command -v` via execFileSync without a shell: use `which`-like probe.
    execFileSync('/usr/bin/env', ['which', bin], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function projectRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
}

/** What visionHelperPath returns when no helper may be tried: a path no file has, so a caller's `fs.existsSync` fails. */
const NO_HELPER_PATH = '';

/**
 * The OCR helper to run: what native-helpers.ts › usableVisionHelperPath allows, the verified prebuilt
 * one or a local build. When the prebuilt may not be used (latched off, an uncleared download flag) that
 * is the local build made on this Mac, if there is one and the process has not latched it off too (the
 * server's OCR engine asks the same function, so images and PDFs agree; fix pass 1). A file the latch
 * refused is not offered again, whichever file it is (review 2, finding 5): with nothing to try, the
 * path has no file. Callers keep their `fs.existsSync(helper)` test, so an unavailable helper is simply
 * "not built" to them and the next reader in their chain takes over.
 */
export function visionHelperPath(): string {
  const usable = usableVisionHelperPath();
  if (usable) return usable;
  const local = localVisionHelperPath();
  return isHelperLatchedOff(local) ? NO_HELPER_PATH : local;
}

/** BotBoy's own PDF reader (pdf.js, a pinned npm dependency), run as a child process. */
export function pdfTextScriptPath(): string {
  return path.join(projectRoot(), 'scripts', 'pdf-text.mjs');
}

/** Whether `npm install` put pdf.js in place for `pdfTextScriptPath`. */
export function pdfJsInstalled(): boolean {
  return existsSync(path.join(projectRoot(), 'node_modules', 'pdfjs-dist', 'legacy', 'build', 'pdf.mjs'))
    && existsSync(pdfTextScriptPath());
}

export interface VisionHelperStatus {
  /** A helper may be used for images and scanned PDFs. */
  ok: boolean;
  provenance: HelperProvenance;
  path: string | null;
  /** Why not, as the sentence to print, when !ok. */
  offLine: string | null;
  /** Which kind of sentence offLine is: a failed BUILD, or "nothing could be attempted". */
  cause: 'none' | 'build_failed' | 'unavailable';
}

/**
 * Is there an OCR helper, and if not, what is true? Boot-time and read-only:
 * the resolver's T0 to T2 verdict (no process is spawned) plus the job's
 * remembered outcome for the two reasons only a run can find out (the download
 * flag that would not clear, and a smoke run that failed) when it was recorded
 * against this very prebuilt file.
 *
 * Wording by kind (finding 8): a remembered failed or timed-out BUILD gets the
 * build-failed sentence; every "nothing was attempted" reason gets its own
 * sentence from the reason table, never a build-failed one.
 */
export function visionHelperStatus(options: {
  verdict?: HelperVerdict;
  ocrFailure?: OcrBuildFailure | null;
  ocrUnavailable?: OcrUnavailable | null;
} = {}): VisionHelperStatus {
  if (process.platform !== 'darwin') {
    return { ok: false, provenance: 'none', path: null, offLine: 'Apple Vision OCR requires macOS', cause: 'unavailable' };
  }
  const verdict = options.verdict ?? currentVisionHelper();
  const unavailable = options.ocrUnavailable !== undefined ? options.ocrUnavailable : readOcrUnavailable();
  if (verdict.provenance !== 'none') {
    const blockedByRun = verdict.provenance === 'prebuilt'
      && unavailable !== null
      && (unavailable.reasonCode === 'smoke_failed' || unavailable.reasonCode === 'quarantined')
      && unavailable.prebuilt !== null
      && unavailable.prebuilt === verdict.binarySha256;
    if (!blockedByRun) return { ok: true, provenance: verdict.provenance, path: verdict.path, offLine: null, cause: 'none' };
    return { ok: false, provenance: 'none', path: null, offLine: unavailable!.reason, cause: 'unavailable' };
  }
  const failure = options.ocrFailure !== undefined ? options.ocrFailure : readOcrBuildFailure();
  if (failure) return { ok: false, provenance: 'none', path: null, offLine: ocrHelperUnavailableLine(), cause: 'build_failed' };
  return {
    ok: false,
    provenance: 'none',
    path: null,
    offLine: ocrReasonLine(verdict.reason ?? 'resolver_error', { osVersion: verdict.osVersion, minMacos: verdict.minMacos, detail: verdict.detail }),
    cause: 'unavailable',
  };
}

/**
 * `ocrFailure` and `ocrUnavailable` are read from the remembered-outcome marker
 * unless a caller (a test) supplies them, and `helper` from the resolver. When
 * the OCR helper is off the report says why, once, on one line, and never
 * sends the owner to a build that is not the problem.
 */
export function checkDependencies(options: {
  ocrFailure?: OcrBuildFailure | null;
  ocrUnavailable?: OcrUnavailable | null;
  verdict?: HelperVerdict;
} = {}): DepsReport {
  const deps: DepStatus[] = [];

  // OCR: the prebuilt (or local) Apple Vision helper.
  const helper = visionHelperStatus(options);
  const ocrOk = helper.ok;
  const offLine = helper.offLine ?? '';
  deps.push({
    name: 'ocr (apple-vision helper)',
    ok: ocrOk,
    detail: ocrOk
      ? `found at ${helper.path} (${helper.provenance === 'prebuilt' ? 'prebuilt' : 'local build'})`
      : offLine,
  });

  // Document parsing: the native vision-ocr helper reads the PDF text layer
  // (PDFKit), then poppler's pdftotext if installed, then BotBoy's own pdf.js
  // reader, which `npm install` always provides. textutil does not count: it
  // cannot read PDFs and echoes their bytes.
  const pdftotext = commandExists('pdftotext');
  const pdfJs = pdfJsInstalled();
  const pdfOk = ocrOk || pdftotext || pdfJs;
  deps.push({
    name: 'pdf parsing (vision-ocr pdf-text|pdftotext|pdf.js)',
    ok: pdfOk,
    detail: pdfOk
      ? `available (${ocrOk ? 'native PDFKit helper' : pdftotext ? 'pdftotext' : 'pdf.js'})`
      : 'missing; PDFs fail extraction until you run "npm install" in the BotBoy folder',
  });

  // Scanned-PDF OCR rasterizes via the same native helper; pdftoppm optional.
  const pdftoppm = commandExists('pdftoppm');
  deps.push({
    name: 'scanned-pdf rasterize (vision-ocr pdf-rasterize|pdftoppm)',
    ok: ocrOk || pdftoppm,
    detail: ocrOk
      ? 'available (native CoreGraphics)'
      : pdftoppm
        ? 'available (pdftoppm)'
        : offLine,
  });

  // `ok` keeps its meaning: every extraction reader is there. The OCR helper is an
  // optional extra, so when it is the only gap `ocrOnly` lets the caller log it as
  // information instead of a warning (index.ts).
  const required = deps.filter((d) => d.name.startsWith('pdf'));
  const ok = required.every((d) => d.ok);
  const missing = deps.filter((d) => !d.ok);
  const ocrRows = missing.filter((d) => d.detail === offLine && offLine !== '');
  const others = missing.filter((d) => !ocrRows.includes(d));
  const lines: string[] = [];
  if (others.length > 0) {
    lines.push('Some local extraction dependencies are missing:\n' + others.map((d) => `  - ${d.name}: ${d.detail}`).join('\n'));
  }
  // One cause behind both OCR rows: say it once, on one line.
  if (ocrRows.length > 0) lines.push(offLine);
  const message = lines.join('\n');
  const ocrOnly = !ocrOk && others.length === 0;

  return { ok: ok && ocrOk, deps, message, ocrOnly };
}
