import { describe, it, expect } from 'vitest';
import { existsSync, writeFileSync, mkdtempSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import {
  createVisionOcrEngine,
  OcrEngine,
  OcrResult,
  OcrUnavailableError,
} from './ocr-engine.js';

const helperPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..', '..', 'native', 'vision-ocr', 'bin', 'vision-ocr',
);
const helperBuilt = existsSync(helperPath) && process.platform === 'darwin';

// Can we render a test image? Prefer ImageMagick/`convert`, fall back to Python PIL.
function makeTextImage(text: string, out: string): boolean {
  try {
    execFileSync('convert', ['-size', '600x120', 'xc:white', '-pointsize', '28', '-fill', 'black', '-annotate', '+20+70', text, out], { timeout: 15000 });
    return existsSync(out);
  } catch {
    try {
      execFileSync('python3', ['-c',
        `from PIL import Image,ImageDraw;i=Image.new('RGB',(600,120),'white');ImageDraw.Draw(i).text((20,45),'''${text}''',fill='black');i.save('${out}')`,
      ], { timeout: 15000 });
      return existsSync(out);
    } catch {
      return false;
    }
  }
}

describe('OcrEngine (interface contract)', () => {
  it('a stub engine satisfies the interface (drop-in contract for future engines)', async () => {
    const stub: OcrEngine = {
      name: 'stub',
      isAvailable: () => true,
      async ocr(): Promise<OcrResult> {
        return { text: 'hello', lines: [{ text: 'hello', confidence: 0.9 }], aggConfidence: 0.9 };
      },
      async ocrPdfPages(): Promise<OcrResult> {
        return { text: 'pdf', lines: [], aggConfidence: 0 };
      },
    };
    const r = await stub.ocr('x');
    expect(r.text).toBe('hello');
    expect(r.aggConfidence).toBeCloseTo(0.9);
  });

  it('throws OcrUnavailableError when the helper binary is absent', async () => {
    const engine = createVisionOcrEngine({ helperPath: '/nonexistent/vision-ocr' });
    expect(engine.isAvailable()).toBe(false);
    await expect(engine.ocr('/tmp/whatever.png')).rejects.toBeInstanceOf(OcrUnavailableError);
  });
});

describe.skipIf(!helperBuilt)('Apple Vision OCR (real helper)', () => {
  it('extracts text from a rendered image with confidence', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'ppt-ocr-'));
    const img = path.join(dir, 'sample.png');
    const phrase = 'BotBoy lossless capture 2026';
    if (!makeTextImage(phrase, img)) {
      // No image tooling available; skip the assertion gracefully.
      rmSync(dir, { recursive: true, force: true });
      return;
    }
    const engine = createVisionOcrEngine({ helperPath });
    const r = await engine.ocr(img);
    expect(r.text.toLowerCase()).toContain('botboy');
    expect(r.aggConfidence).toBeGreaterThan(0.3);
    expect(r.lines.length).toBeGreaterThan(0);
    rmSync(dir, { recursive: true, force: true });
  });
});
