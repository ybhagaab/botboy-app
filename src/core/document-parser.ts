/**
 * Document Parser — converts document files to plain text (lossless: no length
 * caps; full extracted text is returned).
 *
 * Conversions run locally via subprocess tools. All invocations use
 * `execFileSync(bin, [args])` (never a shell string) so file paths cannot be
 * interpreted as shell metacharacters — closing the command-injection hole in
 * the previous `execSync(\`... "${filePath}" ...\`)` implementation
 * (lossless-capture-brain-pipeline R3.7).
 */

import { execFileSync, execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);
import fs from 'fs';
import os from 'os';
import path from 'path';
import { visionHelperPath } from './deps-check.js';

export interface ParseResult {
  success: boolean;
  text?: string;
  error?: string;
  filePath: string;
  fileType: string;
}

export interface DocumentParser {
  parse(filePath: string): ParseResult;
  /**
   * Non-blocking variant for background pipeline use (subprocess conversions
   * run through async execFile instead of execFileSync, so a slow or hostile
   * document cannot stall the server's event loop). Optional so lightweight
   * test stubs only need `parse`; callers fall back to `parse` when absent.
   */
  parseAsync?(filePath: string): Promise<ParseResult>;
  getSupportedFormats(): string[];
}

const SUPPORTED_FORMATS = new Set(['.pdf', '.docx', '.xlsx', '.pptx', '.txt', '.md', '.csv', '.json']);
const PLAIN_TEXT = new Set(['.txt', '.md', '.csv', '.json']);

/** Run a binary with argv (no shell). Returns trimmed stdout as utf8. */
function run(bin: string, args: string[], timeoutMs: number): string {
  return execFileSync(bin, args, {
    encoding: 'utf-8',
    timeout: timeoutMs,
    maxBuffer: 1024 * 1024 * 512, // 512 MB — no artificial content cap
  }).trim();
}

/**
 * Async twin of `run` for the background pipeline: the subprocess runs off
 * the event loop, so a slow conversion (scanned/password-protected PDF, huge
 * deck) cannot freeze the HTTP server. Same no-shell/argv contract.
 * (Incident 2026-08-24: a password-protected PDF in a watched Downloads
 * folder made the dashboard time out — the sync exec held the event loop.)
 */
async function runAsync(bin: string, args: string[], timeoutMs: number): Promise<string> {
  const { stdout } = await execFileAsync(bin, args, {
    encoding: 'utf-8',
    timeout: timeoutMs,
    maxBuffer: 1024 * 1024 * 512,
  });
  return stdout.trim();
}

export function createDocumentParser(): DocumentParser {
  function getFileType(filePath: string): string {
    return path.extname(filePath).toLowerCase();
  }

  /**
   * Interpret the vision helper's stdout JSON. The helper reports structured
   * errors (e.g. "PDF is password protected: …") — a password error is a
   * deterministic, permanent condition, so it is thrown immediately instead
   * of falling through to fallback tools that cannot open the file either
   * (each fallthrough costs another 60 s subprocess attempt).
   */
  function pdfHelperText(raw: string): string {
    const parsed = JSON.parse(raw) as { text?: string; error?: string };
    if (typeof parsed.text === 'string') return parsed.text.trim();
    if (typeof parsed.error === 'string' && /password/i.test(parsed.error)) {
      throw new Error(parsed.error);
    }
    throw new Error(parsed.error ?? 'vision helper returned no text');
  }

  function parsePdf(filePath: string): string {
    // Native PDFKit text layer first (the vision-ocr helper — zero external
    // dependencies), then poppler's pdftotext if installed, then textutil.
    const helper = visionHelperPath();
    if (fs.existsSync(helper)) {
      try {
        return pdfHelperText(run(helper, ['pdf-text', filePath], 60000));
      } catch (err) {
        if (err instanceof Error && /password/i.test(err.message)) throw err;
        // Helper missing/failed for this file — fall through to the others.
      }
    }
    try {
      return run('pdftotext', [filePath, '-'], 60000);
    } catch {
      try {
        return run('textutil', ['-convert', 'txt', '-stdout', filePath], 60000);
      } catch {
        throw new Error('No PDF conversion tool available (tried vision-ocr pdf-text, pdftotext, textutil)');
      }
    }
  }

  async function parsePdfAsync(filePath: string): Promise<string> {
    const helper = visionHelperPath();
    if (fs.existsSync(helper)) {
      try {
        return pdfHelperText(await runAsync(helper, ['pdf-text', filePath], 60000));
      } catch (err) {
        if (err instanceof Error && /password/i.test(err.message)) throw err;
      }
    }
    try {
      return await runAsync('pdftotext', [filePath, '-'], 60000);
    } catch {
      try {
        return await runAsync('textutil', ['-convert', 'txt', '-stdout', filePath], 60000);
      } catch {
        throw new Error('No PDF conversion tool available (tried vision-ocr pdf-text, pdftotext, textutil)');
      }
    }
  }

  function parseOffice(filePath: string): string {
    // textutil (macOS built-in) first, then libreoffice headless.
    try {
      return run('textutil', ['-convert', 'txt', '-stdout', filePath], 60000);
    } catch {
      try {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ppt-docparse-'));
        run('libreoffice', ['--headless', '--convert-to', 'txt', '--outdir', tmpDir, filePath], 120000);
        const txtPath = path.join(tmpDir, path.basename(filePath, path.extname(filePath)) + '.txt');
        const text = fs.readFileSync(txtPath, 'utf-8').trim();
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
        return text;
      } catch {
        throw new Error('No Office conversion tool available (tried textutil, libreoffice)');
      }
    }
  }

  async function parseOfficeAsync(filePath: string): Promise<string> {
    try {
      return await runAsync('textutil', ['-convert', 'txt', '-stdout', filePath], 60000);
    } catch {
      try {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ppt-docparse-'));
        await runAsync('libreoffice', ['--headless', '--convert-to', 'txt', '--outdir', tmpDir, filePath], 120000);
        const txtPath = path.join(tmpDir, path.basename(filePath, path.extname(filePath)) + '.txt');
        const text = fs.readFileSync(txtPath, 'utf-8').trim();
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
        return text;
      } catch {
        throw new Error('No Office conversion tool available (tried textutil, libreoffice)');
      }
    }
  }

  function decodeXmlEntities(value: string): string {
    return value
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
      .replace(/&amp;/g, '&');
  }

  /** Archive member names inside an OOXML zip. */
  function listZipMembers(filePath: string): string[] {
    return run('unzip', ['-Z1', filePath], 30000).split('\n').map((line) => line.trim()).filter(Boolean);
  }

  /** Slide/notes member classification shared by both PPTX parse paths. */
  function pptxMembers(members: string[]) {
    const slideNumber = (member: string) => Number(member.match(/(\d+)\.xml$/)?.[1] ?? 0);
    const slides = members
      .filter((member) => /^ppt\/slides\/slide\d+\.xml$/.test(member))
      .sort((a, b) => slideNumber(a) - slideNumber(b));
    const notes = new Set(members.filter((member) => /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(member)));
    return { slides, notes, slideNumber };
  }

  /**
   * PowerPoint text assembly, pure: textutil silently emits EMPTY output for
   * .pptx (exit 0, so the libreoffice fallback never fires), which is why
   * every captured deck extracted to zero bytes. Slide and notes XML carry
   * all text in <a:t> runs — pull them per slide, in slide order. The
   * `readMember` reader is injected so the sync path streams from unzip and
   * the async path serves from pre-fetched contents, with ONE text builder.
   */
  function buildPptxText(members: string[], readMember: (member: string) => string): string {
    const { slides, notes, slideNumber } = pptxMembers(members);
    const textOf = (member: string): string => {
      const xml = readMember(member);
      // Paragraph boundaries (<a:p>) become newlines; runs within join as-is.
      return xml
        .split(/<\/a:p>/)
        .map((paragraph) =>
          [...paragraph.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((match) => decodeXmlEntities(match[1])).join(''))
        .filter((line) => line.trim().length > 0)
        .join('\n');
    };

    const parts: string[] = [];
    for (const slide of slides) {
      const body = textOf(slide);
      if (!body) continue;
      parts.push(`--- Slide ${slideNumber(slide)} ---\n${body}`);
      const note = slide.replace('ppt/slides/slide', 'ppt/notesSlides/notesSlide');
      if (notes.has(note)) {
        const noteText = textOf(note);
        if (noteText) parts.push(`[Notes] ${noteText}`);
      }
    }
    if (parts.length === 0) throw new Error('PPTX contains no extractable slide text');
    return parts.join('\n\n');
  }

  function parsePptx(filePath: string): string {
    const members = listZipMembers(filePath);
    return buildPptxText(members, (member) => run('unzip', ['-p', filePath, member], 30000));
  }

  async function parsePptxAsync(filePath: string): Promise<string> {
    const members = (await runAsync('unzip', ['-Z1', filePath], 30000))
      .split('\n').map((line) => line.trim()).filter(Boolean);
    const { slides, notes } = pptxMembers(members);
    const needed = [
      ...slides,
      ...slides
        .map((slide) => slide.replace('ppt/slides/slide', 'ppt/notesSlides/notesSlide'))
        .filter((note) => notes.has(note)),
    ];
    const contents = new Map<string, string>();
    for (const member of needed) {
      contents.set(member, await runAsync('unzip', ['-p', filePath, member], 30000));
    }
    return buildPptxText(members, (member) => contents.get(member) ?? '');
  }

  /** Worksheet member list in sheet order, shared by both XLSX parse paths. */
  function xlsxSheetMembers(members: string[]): string[] {
    return members
      .filter((member) => /^xl\/worksheets\/sheet\d+\.xml$/.test(member))
      .sort((a, b) => Number(a.match(/(\d+)\.xml$/)?.[1] ?? 0) - Number(b.match(/(\d+)\.xml$/)?.[1] ?? 0));
  }

  /**
   * Excel text assembly, pure: textutil does not read .xlsx either. Resolve
   * the shared-strings table, then walk each worksheet row-by-row emitting
   * tab-separated values — enough structure for evidence extraction and
   * routing without a spreadsheet engine.
   */
  function buildXlsxText(sharedXml: string | null, sheets: Array<{ member: string; xml: string }>): string {
    const shared: string[] = sharedXml
      ? [...sharedXml.matchAll(/<si(?:\s[^>]*)?>([\s\S]*?)<\/si>/g)]
        .map((si) => [...si[1].matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((t) => decodeXmlEntities(t[1])).join(''))
      : [];

    const parts: string[] = [];
    for (const { member, xml } of sheets) {
      const rows: string[] = [];
      for (const row of xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
        const cells: string[] = [];
        for (const cell of row[1].matchAll(/<c([^>]*)>([\s\S]*?)<\/c>/g)) {
          const attrs = cell[1];
          const body = cell[2];
          const value = body.match(/<v>([\s\S]*?)<\/v>/)?.[1]
            ?? body.match(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/)?.[1]
            ?? '';
          if (/t="s"/.test(attrs)) cells.push(shared[Number(value)] ?? '');
          else cells.push(decodeXmlEntities(value));
        }
        const line = cells.join('\t').trimEnd();
        if (line.trim().length > 0) rows.push(line);
      }
      if (rows.length > 0) parts.push(`--- ${member.replace('xl/worksheets/', '').replace('.xml', '')} ---\n${rows.join('\n')}`);
    }
    if (parts.length === 0) throw new Error('XLSX contains no extractable cell text');
    return parts.join('\n\n');
  }

  function parseXlsx(filePath: string): string {
    const members = listZipMembers(filePath);
    const sharedXml = members.includes('xl/sharedStrings.xml')
      ? run('unzip', ['-p', filePath, 'xl/sharedStrings.xml'], 30000)
      : null;
    const sheets = xlsxSheetMembers(members)
      .map((member) => ({ member, xml: run('unzip', ['-p', filePath, member], 60000) }));
    return buildXlsxText(sharedXml, sheets);
  }

  async function parseXlsxAsync(filePath: string): Promise<string> {
    const members = (await runAsync('unzip', ['-Z1', filePath], 30000))
      .split('\n').map((line) => line.trim()).filter(Boolean);
    const sharedXml = members.includes('xl/sharedStrings.xml')
      ? await runAsync('unzip', ['-p', filePath, 'xl/sharedStrings.xml'], 30000)
      : null;
    const sheets: Array<{ member: string; xml: string }> = [];
    for (const member of xlsxSheetMembers(members)) {
      sheets.push({ member, xml: await runAsync('unzip', ['-p', filePath, member], 60000) });
    }
    return buildXlsxText(sharedXml, sheets);
  }

  return {
    parse(filePath: string): ParseResult {
      const fileType = getFileType(filePath);

      if (!SUPPORTED_FORMATS.has(fileType)) {
        return { success: false, error: `Unsupported format: ${fileType}`, filePath, fileType };
      }
      if (!fs.existsSync(filePath)) {
        return { success: false, error: `File not found: ${filePath}`, filePath, fileType };
      }

      try {
        let text: string;
        if (PLAIN_TEXT.has(fileType)) {
          text = fs.readFileSync(filePath, 'utf-8'); // full content, no cap
        } else if (fileType === '.pdf') {
          text = parsePdf(filePath);
        } else if (fileType === '.pptx') {
          text = parsePptx(filePath);
        } else if (fileType === '.xlsx') {
          text = parseXlsx(filePath);
        } else {
          text = parseOffice(filePath);
        }
        return { success: true, text, filePath, fileType };
      } catch (err: any) {
        return { success: false, error: err.message, filePath, fileType };
      }
    },

    async parseAsync(filePath: string): Promise<ParseResult> {
      const fileType = getFileType(filePath);

      if (!SUPPORTED_FORMATS.has(fileType)) {
        return { success: false, error: `Unsupported format: ${fileType}`, filePath, fileType };
      }
      if (!fs.existsSync(filePath)) {
        return { success: false, error: `File not found: ${filePath}`, filePath, fileType };
      }

      try {
        let text: string;
        if (PLAIN_TEXT.has(fileType)) {
          text = await fs.promises.readFile(filePath, 'utf-8'); // full content, no cap
        } else if (fileType === '.pdf') {
          text = await parsePdfAsync(filePath);
        } else if (fileType === '.pptx') {
          text = await parsePptxAsync(filePath);
        } else if (fileType === '.xlsx') {
          text = await parseXlsxAsync(filePath);
        } else {
          text = await parseOfficeAsync(filePath);
        }
        return { success: true, text, filePath, fileType };
      } catch (err: any) {
        return { success: false, error: err.message, filePath, fileType };
      }
    },

    getSupportedFormats(): string[] {
      return [...SUPPORTED_FORMATS];
    },
  };
}
