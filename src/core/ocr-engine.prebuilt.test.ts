/**
 * The server path, end to end, through the REAL prebuilt OCR helper that ships in
 * native/vision-ocr/prebuilt (macOS only): the default engine resolves it (hash,
 * floor, download flag, first-use smoke), reads an image, rasterizes and reads a
 * PDF page, and the document parser reads a PDF's text layer through it.
 *
 * Nothing here flags or modifies the committed file. If a Mac blocks the file
 * (a download flag that cannot be cleared), the cases say so instead of failing
 * mysteriously: the engine then reports the reason, which is itself the feature.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createVisionOcrEngine, OcrUnavailableError } from './ocr-engine.js';
import { createDocumentParser } from './document-parser.js';
import { currentVisionHelper, resetNativeHelperState, usableVisionHelperPath } from './native-helpers.js';

vi.setConfig({ testTimeout: 120_000 });

const onMac = describe.runIf(process.platform === 'darwin');
const packageRoot = fileURLToPath(new URL('../../', import.meta.url));
const screenshot = path.join(packageRoot, 'docs', 'screenshots', 'connections.png');
const roots: string[] = [];

beforeEach(() => resetNativeHelperState());
afterEach(() => {
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

/** A one-page PDF with a real text layer, built by hand (no tools needed). */
function textPdf(text: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'botboy-prebuilt-pdf-'));
  roots.push(dir);
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    (() => { const content = `BT /F1 22 Tf 72 700 Td (${text}) Tj ET`; return `<< /Length ${content.length} >>\nstream\n${content}\nendstream`; })(),
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, index) => {
    offsets.push(out.length);
    out += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  const file = path.join(dir, 'sample.pdf');
  fs.writeFileSync(file, out, 'latin1');
  return file;
}

onMac('the default OCR engine uses the committed prebuilt helper', () => {
  it('resolves to the prebuilt file with the shipped manifest, and is available', () => {
    const verdict = currentVisionHelper();
    expect(verdict.provenance === 'prebuilt' || verdict.provenance === 'local').toBe(true);
    if (verdict.provenance === 'prebuilt') {
      expect(verdict.path).toBe(path.join(packageRoot, 'native', 'vision-ocr', 'prebuilt', 'vision-ocr'));
      expect(verdict.minMacos).toBe('13.0');
    }
    const engine = createVisionOcrEngine();
    expect(engine.isAvailable()).toBe(usableVisionHelperPath() !== null);
  });

  it('reads an image through it', async () => {
    const engine = createVisionOcrEngine();
    if (!engine.isAvailable()) return expect(engine.ocr(screenshot)).rejects.toBeInstanceOf(OcrUnavailableError);
    const result = await engine.ocr(screenshot);
    expect(result.lines.length).toBeGreaterThan(10);
    expect(result.aggConfidence).toBeGreaterThan(0.5);
    expect(result.text.length).toBeGreaterThan(100);
  });

  it('rasterizes a PDF page (the helper\'s CoreGraphics path) and reads the page', async () => {
    const engine = createVisionOcrEngine();
    if (!engine.isAvailable()) return;
    const result = await engine.ocrPdfPages(textPdf('BotBoy prebuilt helper check'));
    expect(result.text.toLowerCase()).toContain('botboy');
    expect(result.lines.length).toBeGreaterThan(0);
  });

  it('the document parser reads a PDF text layer through it (visionHelperPath + pdf-text)', () => {
    const parser = createDocumentParser();
    const parsed = parser.parse(textPdf('BotBoy prebuilt helper check 12345'));
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.text).toContain('BotBoy prebuilt helper check 12345');
  });
});
