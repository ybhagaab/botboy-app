import { execFile } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { promisify } from 'util';
import { fileURLToPath } from 'url';

/**
 * BotBoy's own PDF reader (`scripts/pdf-text.mjs`) against the pinned pdf.js
 * dependency, with no mocks: the reader every install has, whatever system
 * tools the Mac lacks (2026-10-05).
 */
const run = promisify(execFile);
const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'pdf-text.mjs');

/** A valid PDF with one Helvetica text line per page and a correct xref table. */
function pdfWithPages(lines: string[]): Buffer {
  const objects: string[] = [];
  const pageIds = lines.map((_, index) => 3 + index * 2);
  const fontId = 3 + lines.length * 2;
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${lines.length} >>`;
  lines.forEach((line, index) => {
    const pageId = pageIds[index];
    const stream = `BT /F1 18 Tf 20 100 Td (${line}) Tj ET`;
    objects[pageId] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 144] /Contents ${pageId + 1} 0 R /Resources << /Font << /F1 ${fontId} 0 R >> >> >>`;
    objects[pageId + 1] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  });
  objects[fontId] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';
  let body = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (let id = 1; id < objects.length; id++) {
    offsets[id] = Buffer.byteLength(body, 'latin1');
    body += `${id} 0 obj\n${objects[id]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(body, 'latin1');
  body += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let id = 1; id < objects.length; id++) body += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, 'latin1');
}

describe('pdf.js reader (scripts/pdf-text.mjs)', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(path.join(os.tmpdir(), 'ppt-pdfjs-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  async function read(file: string, ...extra: string[]): Promise<Record<string, unknown>> {
    const { stdout } = await run(process.execPath, [script, file, ...extra], { timeout: 60_000 });
    return JSON.parse(stdout.trim()) as Record<string, unknown>;
  }

  it('reads every page of a PDF as text, in order', async () => {
    const file = path.join(dir, 'plan.pdf');
    writeFileSync(file, pdfWithPages(['Kestrel launch plan', 'Budget review on Friday']));
    expect(await read(file)).toEqual({ text: 'Kestrel launch plan\n\nBudget review on Friday', pages: 2, pagesRead: 2 });
  });

  it('reads only the first pages when asked, and reports an unreadable file as an error', async () => {
    const file = path.join(dir, 'long.pdf');
    writeFileSync(file, pdfWithPages(['page one', 'page two', 'page three']));
    expect(await read(file, '2')).toEqual({ text: 'page one\n\npage two', pages: 3, pagesRead: 2 });

    const broken = path.join(dir, 'broken.pdf');
    writeFileSync(broken, 'not a pdf at all');
    expect(String((await read(broken)).error)).toMatch(/^pdf\.js could not open the file/);
  });
});
