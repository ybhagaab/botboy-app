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
import { fileURLToPath } from 'url';

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
  /** Absolute path to the compiled `vision-ocr` helper binary. */
  helperPath?: string;
}

function defaultHelperPath(): string {
  // Resolve <projectRoot>/native/vision-ocr/bin/vision-ocr from dist or src.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const projectRoot = path.resolve(here, '..', '..');
  return path.join(projectRoot, 'native', 'vision-ocr', 'bin', 'vision-ocr');
}

export function createVisionOcrEngine(config?: VisionOcrConfig): OcrEngine {
  const helperPath = config?.helperPath ?? defaultHelperPath();

  async function runHelper(imagePath: string): Promise<OcrResult> {
    let stdout: string;
    try {
      const r = await execFileP(helperPath, [imagePath], {
        encoding: 'utf-8',
        timeout: 60000,
        maxBuffer: 1024 * 1024 * 256,
      });
      stdout = r.stdout as string;
    } catch (err: any) {
      throw new OcrFailedError(`vision-ocr failed for ${imagePath}: ${err?.message ?? err}`);
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
      return process.platform === 'darwin' && existsSync(helperPath);
    },

    async ocr(imagePath: string): Promise<OcrResult> {
      if (!this.isAvailable()) {
        throw new OcrUnavailableError(
          `Apple Vision OCR helper not available at ${helperPath} (run the dependency bootstrap to build it)`,
        );
      }
      return await runHelper(imagePath);
    },

    async ocrPdfPages(pdfPath: string): Promise<OcrResult> {
      if (!this.isAvailable()) {
        throw new OcrUnavailableError(`Apple Vision OCR helper not available at ${helperPath}`);
      }
      // Rasterize each PDF page to PNG, OCR each, then merge. The helper's
      // native CoreGraphics rasterizer is primary (no external dependency);
      // poppler's pdftoppm remains as a fallback for odd PDFs. All subprocess
      // calls are async so the event loop stays free.
      const { mkdtempSync, readdirSync, rmSync } = await import('fs');
      const tmp = mkdtempSync(path.join(os.tmpdir(), 'ppt-ocr-pdf-'));
      try {
        try {
          await execFileP(helperPath, ['pdf-rasterize', pdfPath, tmp, '150'], {
            timeout: 120000,
            maxBuffer: 1024 * 1024,
          });
        } catch {
          // Native rasterize failed — try poppler if present (optional).
          await execFileP('pdftoppm', ['-png', '-r', '150', pdfPath, path.join(tmp, 'page')], {
            timeout: 120000,
          });
        }
        const pages = readdirSync(tmp).filter((f) => f.endsWith('.png')).sort();
        const merged: OcrResult = { text: '', lines: [], aggConfidence: 0 };
        const confs: number[] = [];
        for (const pg of pages) {
          const r = await runHelper(path.join(tmp, pg));
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
