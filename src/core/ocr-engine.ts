/**
 * OCR engine abstraction (lossless-capture-brain-pipeline R4).
 *
 * The interface is deliberately narrow and stable so a higher-accuracy engine
 * (e.g. dots.ocr) can be dropped in later as a confidence-gated escalation
 * WITHOUT changing storage or downstream consumers (R4.9). The default engine
 * is Apple Vision via the local `vision-ocr` helper binary (R4.6 — fully local,
 * no network).
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import { existsSync } from 'fs';
import path from 'path';
import os from 'os';
import {
  EXEC_FAILURE_NEXT_ACTION,
  ensureVisionHelperReady,
  isExecFailure,
  noteHelperExecFailure,
  usableVisionHelperPath,
  visionHelperOffLine,
} from './native-helpers.js';

const execFileP = promisify(execFile);

export interface OcrLine {
  text: string;
  confidence: number; // 0..1
  bbox?: [number, number, number, number];
}

export interface OcrResult {
  text: string;
  lines: OcrLine[];
  aggConfidence: number; // 0..1
}

export interface OcrEngine {
  /** OCR a single image file. */
  ocr(imagePath: string): Promise<OcrResult>;
  /** OCR each page of an image-only/scanned PDF and merge. */
  ocrPdfPages(pdfPath: string): Promise<OcrResult>;
  /** Whether the engine is usable on this machine right now. */
  isAvailable(): boolean;
  readonly name: string;
}

export class OcrUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OcrUnavailableError';
  }
}

export class OcrFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OcrFailedError';
  }
}

// ── Apple Vision engine ──────────────────────────────────────────────────

export interface VisionOcrConfig {
  /**
   * Absolute path to a `vision-ocr` helper binary. When omitted (production),
   * the helper is resolved on every call (native-helpers.ts): the verified
   * prebuilt one, or a local build, never a file that failed its checks. An
   * explicit path is used as given (tests).
   */
  helperPath?: string;
}

export function createVisionOcrEngine(config?: VisionOcrConfig): OcrEngine {
  const fixedPath = config?.helperPath;

  /** The helper to run now, or null with the reason in `visionHelperOffLine()`. */
  async function currentHelper(): Promise<string | null> {
    if (fixedPath) return existsSync(fixedPath) ? fixedPath : null;
    // T3 (download flag) and the once-per-process smoke run before the first exec.
    if (!(await ensureVisionHelperReady())) return null;
    return usableVisionHelperPath();
  }

  function unavailableMessage(): string {
    const why = fixedPath ? `not available at ${fixedPath}` : (visionHelperOffLine() ?? 'run ./start.sh --doctor for the reason');
    return `Apple Vision OCR helper ${fixedPath ? why : `not available (${why})`}`;
  }

  async function runHelper(helperPath: string, imagePath: string): Promise<OcrResult> {
    let stdout: string;
    try {
      const r = await execFileP(helperPath, [imagePath], {
        encoding: 'utf-8',
        timeout: 60000,
        maxBuffer: 1024 * 1024 * 256,
      });
      stdout = r.stdout as string;
    } catch (err: any) {
      // A failure with the shape of "the system would not run it" starts one fresh check of THIS file and may latch it off.
      if (!fixedPath) noteHelperExecFailure(err, helperPath);
      const tail = isExecFailure(err) ? ` (${EXEC_FAILURE_NEXT_ACTION})` : '';
      throw new OcrFailedError(`vision-ocr failed for ${imagePath}: ${err?.message ?? err}${tail}`);
    }
    let parsed: OcrResult;
    try {
      parsed = JSON.parse(stdout) as OcrResult;
    } catch {
      throw new OcrFailedError(`vision-ocr returned unparseable output for ${imagePath}`);
    }
    return {
      text: parsed.text ?? '',
      lines: parsed.lines ?? [],
      aggConfidence: parsed.aggConfidence ?? 0,
    };
  }

  return {
    name: 'apple-vision',

    isAvailable(): boolean {
      if (process.platform !== 'darwin') return false;
      return fixedPath ? existsSync(fixedPath) : usableVisionHelperPath() !== null;
    },

    async ocr(imagePath: string): Promise<OcrResult> {
      const helperPath = await currentHelper();
      if (!helperPath) throw new OcrUnavailableError(unavailableMessage());
      return await runHelper(helperPath, imagePath);
    },

    async ocrPdfPages(pdfPath: string): Promise<OcrResult> {
      const helperPath = await currentHelper();
      if (!helperPath) throw new OcrUnavailableError(unavailableMessage());
      // Rasterize each PDF page to PNG, OCR each, then merge. The helper's
      // native CoreGraphics rasterizer is primary (no external dependency);
      // poppler's pdftoppm remains as a fallback for odd PDFs. All subprocess
      // calls are async so the event loop stays free.
      const { mkdtempSync, readdirSync, rmSync } = await import('fs');
      const tmp = mkdtempSync(path.join(os.tmpdir(), 'ppt-ocr-pdf-'));
      try {
        try {
          await execFileP(helperPath, ['pdf-rasterize', pdfPath, tmp, '300'], {
            timeout: 120000,
            maxBuffer: 1024 * 1024,
          });
        } catch (err) {
          if (!fixedPath) noteHelperExecFailure(err, helperPath);
          // Native rasterize failed — try poppler if present (optional).
          await execFileP('pdftoppm', ['-png', '-r', '300', pdfPath, path.join(tmp, 'page')], {
            timeout: 120000,
          });
        }
        const pages = readdirSync(tmp).filter((f) => f.endsWith('.png')).sort();
        const merged: OcrResult = { text: '', lines: [], aggConfidence: 0 };
        const confs: number[] = [];
        for (const pg of pages) {
          const r = await runHelper(helperPath, path.join(tmp, pg));
          if (r.text) merged.text += (merged.text ? '\n\n' : '') + r.text;
          merged.lines.push(...r.lines);
          if (r.lines.length) confs.push(r.aggConfidence);
        }
        merged.aggConfidence = confs.length ? confs.reduce((a, b) => a + b, 0) / confs.length : 0;
        return merged;
      } catch (err: any) {
        throw new OcrFailedError(`PDF OCR failed for ${pdfPath}: ${err?.message ?? err}`);
      } finally {
        try { rmSync(tmp, { recursive: true, force: true }); } catch {}
      }
    },
  };
}
