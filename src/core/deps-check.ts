/**
 * Dependency verification for local parsing + OCR
 * (lossless-capture-brain-pipeline R13).
 *
 * At startup the app verifies the capabilities lossless extraction needs and
 * reports missing ones with actionable messages. Missing capabilities are
 * surfaced (never silently skipped) so no content is quietly dropped.
 */

import { existsSync } from 'fs';
import { execFileSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

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

export function visionHelperPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const projectRoot = path.resolve(here, '..', '..');
  return path.join(projectRoot, 'native', 'vision-ocr', 'bin', 'vision-ocr');
}

export function checkDependencies(): DepsReport {
  const deps: DepStatus[] = [];

  // OCR — macOS Vision helper (built by the bootstrap step).
  const helper = visionHelperPath();
  const ocrOk = process.platform === 'darwin' && existsSync(helper);
  deps.push({
    name: 'ocr (apple-vision helper)',
    ok: ocrOk,
    detail: ocrOk
      ? `found at ${helper}`
      : process.platform !== 'darwin'
        ? 'Apple Vision OCR requires macOS'
        : `missing; run "npm run bootstrap" to build the vision-ocr helper (${helper})`,
  });

  // Document parsing — the native vision-ocr helper handles the PDF text
  // layer (PDFKit) and page rasterization (CoreGraphics), so PDF support
  // needs no external tool. poppler and textutil remain as fallbacks.
  const pdftotext = commandExists('pdftotext');
  const textutil = commandExists('textutil');
  const pdfOk = ocrOk || pdftotext || textutil;
  deps.push({
    name: 'pdf parsing (vision-ocr pdf-text|pdftotext|textutil)',
    ok: pdfOk,
    detail: pdfOk
      ? `available (${ocrOk ? 'native PDFKit helper' : pdftotext ? 'pdftotext' : 'textutil'})`
      : 'missing; run "npm run bootstrap" to build the native helper',
  });

  // Scanned-PDF OCR rasterizes via the same native helper; pdftoppm optional.
  const pdftoppm = commandExists('pdftoppm');
  deps.push({
    name: 'scanned-pdf rasterize (vision-ocr pdf-rasterize|pdftoppm)',
    ok: ocrOk || pdftoppm,
    detail: ocrOk ? 'available (native CoreGraphics)' : pdftoppm ? 'available (pdftoppm)' : 'missing; run "npm run bootstrap" to build the native helper',
  });

  const required = deps.filter((d) => d.name.startsWith('ocr') || d.name.startsWith('pdf'));
  const ok = required.every((d) => d.ok);
  const missing = deps.filter((d) => !d.ok);
  const message = ok
    ? ''
    : 'Some local extraction dependencies are missing:\n' +
      missing.map((d) => `  - ${d.name}: ${d.detail}`).join('\n');

  return { ok, deps, message };
}
