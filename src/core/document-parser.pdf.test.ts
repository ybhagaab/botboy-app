import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';

/**
 * PDF reader chain (2026-10-05): the vision-ocr helper, then pdftotext, then
 * BotBoy's own pdf.js reader (`scripts/pdf-text.mjs`, a pinned npm
 * dependency), never textutil. textutil cannot read PDFs and echoes the
 * file's bytes as text; as the last fallback on a Mac without the helper and
 * poppler, it stored every PDF as raw bytes (the owner's July–August 2026
 * captures).
 */
const { calls, tools } = vi.hoisted(() => ({
  calls: [] as string[],
  tools: {
    helper: '/nonexistent/vision-ocr',
    helperOutput: null as string | null,
    pdftotext: null as string | null,
    pdfjs: null as string | null,
    pdfjsArgs: [] as string[],
  },
}));

vi.mock('./deps-check.js', () => ({
  visionHelperPath: () => tools.helper,
  pdfTextScriptPath: () => '/botboy/scripts/pdf-text.mjs',
}));

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  const missing = (bin: string) => Object.assign(new Error(`spawn ${bin} ENOENT`), { code: 'ENOENT' });
  const output = (bin: string, args: string[]): string | Error => {
    if (bin === process.execPath) {
      calls.push('pdf.js');
      tools.pdfjsArgs = args;
      return tools.pdfjs ?? JSON.stringify({ error: 'pdf.js is not installed (run npm install in the BotBoy folder)' });
    }
    calls.push(path.basename(bin));
    if (bin === tools.helper && tools.helperOutput != null) return tools.helperOutput;
    if (bin === 'pdftotext' && tools.pdftotext != null) return tools.pdftotext;
    if (bin === 'textutil') return '%PDF-1.4\n%\u00e2\u00e3\n1 0 obj << /Type /Catalog >> endobj';
    return missing(bin);
  };
  return {
    ...actual,
    execFileSync: (bin: string, args: string[]) => {
      const result = output(bin, args);
      if (result instanceof Error) throw result;
      return result;
    },
    execFile: (bin: string, args: string[], _options: unknown, callback: (error: Error | null, out?: { stdout: string; stderr: string }) => void) => {
      const result = output(bin, args);
      if (result instanceof Error) callback(result);
      else callback(null, { stdout: result, stderr: '' });
    },
  };
});

const { createDocumentParser } = await import('./document-parser.js');

describe('PDF reader chain', () => {
  let dir: string;
  let pdf: string;

  beforeEach(() => {
    calls.length = 0;
    tools.helper = '/nonexistent/vision-ocr';
    tools.helperOutput = null;
    tools.pdftotext = null;
    tools.pdfjs = null;
    tools.pdfjsArgs = [];
    dir = mkdtempSync(path.join(os.tmpdir(), 'ppt-pdf-chain-'));
    pdf = path.join(dir, 'receipt.pdf');
    writeFileSync(pdf, '%PDF-1.4\n%\u00e2\u00e3\n1 0 obj << /Type /Catalog >> endobj\n');
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('reads with BotBoy\'s own pdf.js reader when neither the helper nor pdftotext is there', async () => {
    tools.pdfjs = JSON.stringify({ text: ' Anchorhead Coffee latte $6.90 ', pages: 1, pagesRead: 1 });
    const parser = createDocumentParser();
    expect(await parser.parseAsync!(pdf)).toMatchObject({ success: true, text: 'Anchorhead Coffee latte $6.90' });
    expect(parser.parse(pdf)).toMatchObject({ success: true, text: 'Anchorhead Coffee latte $6.90' });
    expect(calls).toEqual(['pdftotext', 'pdf.js', 'pdftotext', 'pdf.js']);
    expect(tools.pdfjsArgs).toEqual(['/botboy/scripts/pdf-text.mjs', pdf]);
  });

  it('fails with a next step instead of echoing the bytes when no reader can read it', async () => {
    const parser = createDocumentParser();
    const sync = parser.parse(pdf);
    expect(sync.success).toBe(false);
    expect(sync.error).toContain('No PDF reader could read this file (vision-ocr helper: not built; pdftotext: not installed; pdf.js: pdf.js is not installed');
    expect(sync.error).toContain('Run "npm install" in the BotBoy folder.');
    tools.pdfjs = JSON.stringify({ error: 'pdf.js could not open the file: Invalid PDF structure.' });
    const async = await parser.parseAsync!(pdf);
    expect(async).toMatchObject({ success: false });
    expect(async.error).toContain('pdf.js: pdf.js could not open the file: Invalid PDF structure.)');
    expect(async.error).not.toContain('npm install');
    expect(calls).not.toContain('textutil');
  });

  it('reads with the helper first, then pdftotext, then pdf.js; a password stops the chain', async () => {
    writeFileSync(path.join(dir, 'vision-ocr'), '');
    tools.helper = path.join(dir, 'vision-ocr');
    tools.helperOutput = JSON.stringify({ text: ' Anchorhead Coffee latte $6.90 ' });
    const parser = createDocumentParser();
    expect(await parser.parseAsync!(pdf)).toMatchObject({ success: true, text: 'Anchorhead Coffee latte $6.90' });

    tools.helperOutput = JSON.stringify({ error: 'could not open the document' });
    tools.pdftotext = 'Receipt text from poppler';
    expect(parser.parse(pdf)).toMatchObject({ success: true, text: 'Receipt text from poppler' });

    tools.pdftotext = null;
    tools.pdfjs = JSON.stringify({ text: 'Receipt text from pdf.js' });
    expect(await parser.parseAsync!(pdf)).toMatchObject({ success: true, text: 'Receipt text from pdf.js' });

    tools.pdfjs = JSON.stringify({ error: 'nothing' });
    const failed = await parser.parseAsync!(pdf);
    expect(failed.error).toContain('vision-ocr helper: could not open the document; pdftotext: not installed; pdf.js: nothing');

    calls.length = 0;
    tools.helperOutput = JSON.stringify({ error: 'password required' });
    expect(await parser.parseAsync!(pdf)).toMatchObject({ success: false, error: 'password required' });
    expect(calls).toEqual(['vision-ocr']);
    tools.helper = '/nonexistent/vision-ocr';
    tools.pdfjs = JSON.stringify({ error: 'password required to open this PDF' });
    expect(parser.parse(pdf)).toMatchObject({ success: false, error: 'password required to open this PDF' });
    expect(calls).not.toContain('textutil');
  });

  it('caps pages with pdf.js in the large-file lane when the other readers are missing', async () => {
    tools.pdfjs = JSON.stringify({ text: 'first pages of a long report', pages: 400, pagesRead: 50 });
    const parser = createDocumentParser();
    const result = await parser.parseLargeAsync!(pdf, { pdfPageCap: 50 });
    expect(result).toMatchObject({ text: 'first pages of a long report', truncation: { pages: { capApplied: 50, tool: 'pdf.js' } } });
    expect(tools.pdfjsArgs).toEqual(['/botboy/scripts/pdf-text.mjs', pdf, '50']);
  });
});
