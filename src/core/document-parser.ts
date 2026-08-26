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

import { execFileSync, execFile, spawn } from 'child_process';
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

/**
 * Bounded extraction result for the large-file lane. `truncation` is the
 * machine-readable coverage record (sharepoint plan §11.5.2 — truncation is
 * first-class, never silent). Typed as an open record so consumers (the
 * SharePoint drain, item metadata) can carry it verbatim; the shape is:
 *   sheets?: Array<{ name, rowsKept, rowsTotal: number|null }>
 *   sharedStringsBudgetHit?: boolean
 *   slides?: { kept, total, charCapped }
 *   pages?: { capApplied: number|null, tool: string, totalUnknown?: boolean }
 */
export interface LargeParseResult {
  text: string;
  truncation: Record<string, unknown>;
}

export interface LargeParseOptions {
  rowsPerSheet?: number; // default 200
  sharedStringsBudgetBytes?: number; // default 8 MB
  slideCharCap?: number; // default 4096
  pdfPageCap?: number; // default 50
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
  /**
   * Large-file lane (25–150 MB xlsx/pptx/pdf): streamed, early-aborting,
   * bounded extraction that never inflates a whole oversized member into
   * memory. Streams `unzip -p` child stdout and kills the child the moment
   * a cap is reached, so a 120 MB worksheet costs only its first rows.
   * No new dependency — same system-unzip/execFile path as the full parsers.
   */
  parseLargeAsync?(filePath: string, options?: LargeParseOptions): Promise<LargeParseResult>;
  /**
   * Sheet-scoped on-demand read (xlsx-deep-reads X1): resolve a sheet by
   * NAME via workbook.xml + rels (never positional), stream it under row and
   * char budgets, resolve shared/inline strings, formula cached values, and
   * date serials. Without `sheet`, returns the workbook inventory only.
   */
  parseXlsxSheet?(filePath: string, options?: SheetReadOptions): Promise<SheetReadResult>;
  getSupportedFormats(): string[];
}

export interface SheetReadOptions {
  sheet?: string;
  maxRows?: number; // default 2000, cap 10000
  maxChars?: number; // default 60_000, cap 120_000
}

export interface SheetReadResult {
  sheets: Array<{ name: string; member: string }>;
  /** Present when a sheet was requested. */
  sheet?: {
    name: string;
    rows: string[][];
    rowsTotal: number | null;
    truncation: { rowsCut: boolean; charsCut: boolean; sharedStringsBudgetHit: boolean };
    formulaCells: number;
  };
}

const SUPPORTED_FORMATS = new Set(['.pdf', '.docx', '.xlsx', '.pptx', '.txt', '.md', '.csv', '.json']);
const PLAIN_TEXT = new Set(['.txt', '.md', '.csv', '.json']);

// Large-lane defaults (sharepoint-docs-brain R6).
const LARGE_ROWS_PER_SHEET = 200;
const LARGE_SHARED_STRINGS_BUDGET = 8 * 1024 * 1024;
const LARGE_SLIDE_CHAR_CAP = 4096;
const LARGE_PDF_PAGE_CAP = 50;
const LARGE_PDF_CHAR_CAP = 200_000;
const STREAM_CARRY_CAP = 2 * 1024 * 1024;

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

  // ── Native .docx extraction (structure-preserving) ────────────────────────
  // textutil/libreoffice flatten Word TABLES to one line per cell and drop
  // heading structure (owner report 2026-08-26: a gap-analysis table rendered
  // as a paragraph stream in the doc reader). We already read document.xml
  // everywhere else — walk it directly: tables become markdown pipe tables
  // (the UI renderer supports GFM tables), Heading styles become #-headings,
  // list paragraphs become bullets. Falls back to textutil on any failure.

  function docxParagraphText(pXml: string): string {
    const pieces: string[] = [];
    // w:t text, tabs and breaks as spaces — document order.
    for (const m of pXml.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\/>|<w:br\/>/g)) {
      pieces.push(m[1] !== undefined ? decodeXmlEntities(m[1]) : ' ');
    }
    return pieces.join('').replace(/\s+/g, ' ').trim();
  }

  function docxParagraphToMarkdown(pXml: string): string {
    const text = docxParagraphText(pXml);
    if (!text) return '';
    const style = /<w:pStyle[^>]*w:val="([^"]*)"/.exec(pXml)?.[1] ?? '';
    const headingLevel = /^Heading([1-6])$/i.exec(style)?.[1];
    if (headingLevel) return `${'#'.repeat(Number(headingLevel))} ${text}`;
    if (/^Title$/i.test(style)) return `# ${text}`;
    if (pXml.includes('<w:numPr>')) return `- ${text}`;
    return text;
  }

  /** Outer <w:tbl> ranges via depth scan (tables nest inside cells). */
  function docxTableRanges(xml: string): Array<{ start: number; end: number }> {
    const ranges: Array<{ start: number; end: number }> = [];
    let depth = 0;
    let start = -1;
    for (const m of xml.matchAll(/<w:tbl(?=[\s>])|<\/w:tbl>/g)) {
      if (m[0] === '</w:tbl>') {
        depth--;
        if (depth === 0 && start >= 0) { ranges.push({ start, end: m.index! + m[0].length }); start = -1; }
      } else {
        if (depth === 0) start = m.index!;
        depth++;
      }
    }
    return ranges;
  }

  function docxTableToMarkdown(tblXml: string): string {
    // Nested tables keep v1 honest: fall back to the flattened text of the
    // whole construct rather than emitting a broken grid. Boundary-aware
    // count (`<w:tblPr` must NOT read as a table start).
    if ((tblXml.match(/<w:tbl(?=[\s>])/g) ?? []).length !== 1) {
      return docxParagraphText(tblXml);
    }
    const rows: string[][] = [];
    for (const tr of tblXml.matchAll(/<w:tr(?:\s[^>]*)?>([\s\S]*?)<\/w:tr>/g)) {
      const cells: string[] = [];
      for (const tc of tr[1].matchAll(/<w:tc(?:\s[^>]*)?>([\s\S]*?)<\/w:tc>/g)) {
        cells.push(docxParagraphText(tc[1]).replace(/\|/g, '\\|'));
      }
      if (cells.some(cell => cell !== '')) rows.push(cells);
    }
    if (rows.length === 0) return '';
    const width = Math.max(...rows.map(row => row.length));
    // Single-column "tables" are layout artifacts — plain paragraphs read
    // better and the renderer needs ≥2 columns anyway.
    if (width < 2) return rows.map(row => row.join(' ')).join('\n\n');
    const pad = (row: string[]) => Array.from({ length: width }, (_unused, i) => row[i] ?? '');
    const line = (row: string[]) => `| ${pad(row).join(' | ')} |`;
    return [line(rows[0]), `| ${Array.from({ length: width }, () => '---').join(' | ')} |`, ...rows.slice(1).map(line)].join('\n');
  }

  /** document.xml body → markdown (exported for tests via parser instance). */
  function docxXmlToMarkdown(documentXml: string): string {
    const body = documentXml.match(/<w:body(?:\s[^>]*)?>([\s\S]*)<\/w:body>/)?.[1] ?? documentXml;
    const tables = docxTableRanges(body);
    const blocks: Array<{ at: number; text: string }> = [];
    for (const range of tables) {
      const text = docxTableToMarkdown(body.slice(range.start, range.end));
      if (text) blocks.push({ at: range.start, text });
    }
    for (const p of body.matchAll(/<w:p(?:\s[^>]*)?>([\s\S]*?)<\/w:p>/g)) {
      if (tables.some(range => p.index! >= range.start && p.index! < range.end)) continue;
      const text = docxParagraphToMarkdown(p[0]);
      if (text) blocks.push({ at: p.index!, text });
    }
    return blocks.sort((a, b) => a.at - b.at).map(block => block.text).join('\n\n');
  }

  function parseDocxNative(filePath: string): string {
    const xml = run('unzip', ['-p', filePath, 'word/document.xml'], 60000);
    const text = docxXmlToMarkdown(xml);
    if (!text.trim()) throw new Error('docx native extraction produced no text');
    return text;
  }

  async function parseDocxNativeAsync(filePath: string): Promise<string> {
    const xml = await runAsync('unzip', ['-p', filePath, 'word/document.xml'], 60000);
    const text = docxXmlToMarkdown(xml);
    if (!text.trim()) throw new Error('docx native extraction produced no text');
    return text;
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

  // ── Large-file lane ────────────────────────────────────────────────────────

  /**
   * Stream one zip member's stdout through `onChunk`. Returning false from
   * the callback aborts: the child is killed immediately (early abort — the
   * point of the lane). A kill-induced non-zero exit is expected and NOT an
   * error; any other non-zero exit rejects.
   */
  function streamZipMember(
    filePath: string,
    member: string,
    onChunk: (chunk: string) => boolean,
    timeoutMs = 120_000,
  ): Promise<{ aborted: boolean }> {
    return new Promise((resolve, reject) => {
      const child = spawn('unzip', ['-p', filePath, member], { stdio: ['ignore', 'pipe', 'ignore'] });
      let aborted = false;
      let settled = false;
      const timer = setTimeout(() => {
        aborted = true;
        child.kill('SIGKILL');
        if (!settled) { settled = true; reject(new Error(`unzip ${member} timed out`)); }
      }, timeoutMs);
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        if (aborted) return;
        if (!onChunk(chunk)) {
          aborted = true;
          child.kill('SIGKILL');
        }
      });
      child.on('error', (error) => {
        clearTimeout(timer);
        if (!settled) { settled = true; reject(error); }
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (settled) return;
        settled = true;
        if (!aborted && code !== 0) reject(new Error(`unzip ${member} exited with ${code}`));
        else resolve({ aborted });
      });
    });
  }

  /** One worksheet row's cells → tab-separated line (shared with the full builder's rules). */
  function xlsxRowToLine(rowXml: string, shared: string[]): string {
    const cells: string[] = [];
    for (const cell of rowXml.matchAll(/<c([^>]*)>([\s\S]*?)<\/c>/g)) {
      const attrs = cell[1];
      const body = cell[2];
      const value = body.match(/<v>([\s\S]*?)<\/v>/)?.[1]
        ?? body.match(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/)?.[1]
        ?? '';
      if (/t="s"/.test(attrs)) cells.push(shared[Number(value)] ?? '');
      else cells.push(decodeXmlEntities(value));
    }
    return cells.join('\t').trimEnd();
  }

  /** Shared-strings table under a byte budget — the table itself reaches tens
   * of MB on huge workbooks. Cells indexing past the loaded range render
   * blank; the budget hit is reported, never silent. */
  async function readSharedStringsBudgeted(
    filePath: string,
    members: string[],
    budgetBytes: number,
  ): Promise<{ shared: string[]; budgetHit: boolean }> {
    if (!members.includes('xl/sharedStrings.xml')) return { shared: [], budgetHit: false };
    let acc = '';
    let bytes = 0;
    let budgetHit = false;
    await streamZipMember(filePath, 'xl/sharedStrings.xml', (chunk) => {
      acc += chunk;
      bytes += Buffer.byteLength(chunk);
      if (bytes >= budgetBytes) { budgetHit = true; return false; }
      return true;
    });
    if (budgetHit) {
      // Trim to the budget FIRST (a small table can arrive in one chunk that
      // already overshoots), then cut back to the last complete entry so a
      // torn <si> never yields a mangled string.
      acc = acc.slice(0, budgetBytes);
      const lastComplete = acc.lastIndexOf('</si>');
      acc = lastComplete >= 0 ? acc.slice(0, lastComplete + 5) : '';
    }
    const shared = [...acc.matchAll(/<si(?:\s[^>]*)?>([\s\S]*?)<\/si>/g)]
      .map((si) => [...si[1].matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((t) => decodeXmlEntities(t[1])).join(''));
    return { shared, budgetHit };
  }

  /** Positional sheet display names from xl/workbook.xml (best effort). */
  async function xlsxSheetNames(filePath: string, members: string[], count: number): Promise<string[] | null> {
    if (!members.includes('xl/workbook.xml')) return null;
    try {
      const xml = await runAsync('unzip', ['-p', filePath, 'xl/workbook.xml'], 30000);
      const names = [...xml.matchAll(/<sheet[^>]*\sname="([^"]*)"/g)].map((m) => decodeXmlEntities(m[1]));
      return names.length === count ? names : null;
    } catch {
      return null;
    }
  }

  async function parseXlsxLarge(filePath: string, opts: Required<Pick<LargeParseOptions, 'rowsPerSheet' | 'sharedStringsBudgetBytes'>>): Promise<LargeParseResult> {
    const members = (await runAsync('unzip', ['-Z1', filePath], 30000))
      .split('\n').map((line) => line.trim()).filter(Boolean);
    const sheetMembers = xlsxSheetMembers(members);
    if (sheetMembers.length === 0) throw new Error('XLSX contains no worksheets');
    const { shared, budgetHit } = await readSharedStringsBudgeted(filePath, members, opts.sharedStringsBudgetBytes);
    const displayNames = await xlsxSheetNames(filePath, members, sheetMembers.length);

    const parts: string[] = [];
    const sheetDetails: Array<{ name: string; rowsKept: number; rowsTotal: number | null }> = [];
    for (let index = 0; index < sheetMembers.length; index++) {
      const member = sheetMembers[index];
      const label = displayNames?.[index] ?? member.replace('xl/worksheets/', '').replace('.xml', '');
      const rows: string[] = [];
      let rowsTotal: number | null = null;
      let carry = '';
      let sawDimension = false;
      await streamZipMember(filePath, member, (chunk) => {
        carry += chunk;
        if (!sawDimension) {
          const dim = carry.match(/<dimension\s+ref="[A-Z]+\d+(?::[A-Z]+(\d+))?"/);
          if (dim) {
            rowsTotal = dim[1] ? Number(dim[1]) : 1;
            sawDimension = true;
          } else if (carry.length > 64 * 1024) {
            sawDimension = true; // header passed without a dimension element
          }
        }
        const rowRe = /<row[^>]*>([\s\S]*?)<\/row>/g;
        let match: RegExpExecArray | null;
        let lastEnd = -1;
        while ((match = rowRe.exec(carry))) {
          lastEnd = rowRe.lastIndex;
          const line = xlsxRowToLine(match[1], shared);
          if (line.trim().length > 0) rows.push(line);
          if (rows.length >= opts.rowsPerSheet) return false; // early abort
        }
        carry = lastEnd >= 0 ? carry.slice(lastEnd) : carry;
        if (carry.length > STREAM_CARRY_CAP) carry = carry.slice(-STREAM_CARRY_CAP);
        return true;
      });

      sheetDetails.push({ name: label, rowsKept: rows.length, rowsTotal });
      if (rows.length > 0) {
        const remainder = rowsTotal !== null && rowsTotal > rows.length
          ? `\n(+ ${(rowsTotal - rows.length).toLocaleString()} more rows in '${label}' — not synced; open in SharePoint for full data)`
          : '';
        parts.push(`--- ${label} ---\n${rows.join('\n')}${remainder}`);
      }
    }
    if (parts.length === 0) throw new Error('XLSX contains no extractable cell text');
    const notes: string[] = [];
    if (budgetHit) notes.push('(Some cell text rendered blank: the workbook string table exceeded the extraction budget.)');
    return {
      text: [...parts, ...notes].join('\n\n'),
      truncation: { sheets: sheetDetails, sharedStringsBudgetHit: budgetHit },
    };
  }

  // ── Sheet-scoped deep read (xlsx-deep-reads X1) ────────────────────────────

  /** workbook.xml sheets (name + r:id) joined to the rels part targets —
   * the ONLY correct name→member mapping (parts are freely reordered). */
  async function resolveSheetMembers(filePath: string, members: string[]): Promise<Array<{ name: string; member: string }>> {
    if (!members.includes('xl/workbook.xml')) return [];
    const workbook = await runAsync('unzip', ['-p', filePath, 'xl/workbook.xml'], 30000);
    const relsXml = members.includes('xl/_rels/workbook.xml.rels')
      ? await runAsync('unzip', ['-p', filePath, 'xl/_rels/workbook.xml.rels'], 30000)
      : '';
    const relTargets = new Map<string, string>();
    for (const rel of relsXml.matchAll(/<Relationship\b[^>]*>/g)) {
      const id = /Id="([^"]*)"/.exec(rel[0])?.[1];
      const target = /Target="([^"]*)"/.exec(rel[0])?.[1];
      if (id && target) relTargets.set(id, target.replace(/^\//, '').replace(/^(?!xl\/)/, 'xl/'));
    }
    const out: Array<{ name: string; member: string }> = [];
    for (const sheet of workbook.matchAll(/<sheet\b[^>]*>/g)) {
      const name = /\sname="([^"]*)"/.exec(sheet[0])?.[1];
      const rid = /r:id="([^"]*)"/.exec(sheet[0])?.[1];
      if (name === undefined) continue;
      const member = rid ? relTargets.get(rid) : undefined;
      if (member && members.includes(member)) out.push({ name: decodeXmlEntities(name), member });
    }
    // Rels missing/odd: fall back to positional pairing (best effort).
    if (out.length === 0) {
      const sheetMembers = xlsxSheetMembers(members);
      const names = [...workbook.matchAll(/<sheet[^>]*\sname="([^"]*)"/g)].map(m => decodeXmlEntities(m[1]));
      return sheetMembers.map((member, index) => ({ name: names[index] ?? member.replace('xl/worksheets/', '').replace('.xml', ''), member }));
    }
    return out;
  }

  /** Style indexes whose number format is a date/time format: builtin ids
   * 14–22 and 45–47, plus custom formats containing date tokens. */
  async function dateStyleIndexes(filePath: string, members: string[]): Promise<Set<number>> {
    const out = new Set<number>();
    if (!members.includes('xl/styles.xml')) return out;
    try {
      const xml = await runAsync('unzip', ['-p', filePath, 'xl/styles.xml'], 30000);
      const customDateIds = new Set<number>();
      for (const fmt of xml.matchAll(/<numFmt\b[^>]*numFmtId="(\d+)"[^>]*formatCode="([^"]*)"/g)) {
        const code = fmt[2].replace(/\[[^\]]*\]/g, '').replace(/&quot;[^&]*&quot;/g, '');
        if (/[ymdhs]/i.test(code) && !/#|0/.test(code)) customDateIds.add(Number(fmt[1]));
      }
      const cellXfs = xml.match(/<cellXfs\b[\s\S]*?<\/cellXfs>/)?.[0] ?? '';
      let index = 0;
      for (const xf of cellXfs.matchAll(/<xf\b[^>]*>/g)) {
        const numFmtId = Number(/numFmtId="(\d+)"/.exec(xf[0])?.[1] ?? 0);
        if ((numFmtId >= 14 && numFmtId <= 22) || (numFmtId >= 45 && numFmtId <= 47) || customDateIds.has(numFmtId)) {
          out.add(index);
        }
        index++;
      }
    } catch { /* dates render as raw serials — noted, never fatal */ }
    return out;
  }

  /** Excel date serial → ISO (1900 system; serial 1 = 1900-01-01, epoch anchor 1899-12-30). */
  function serialToIso(serial: number): string {
    const ms = Math.round((serial - 25569) * 86_400_000); // 25569 = days 1899-12-30 → 1970-01-01
    const date = new Date(ms);
    if (Number.isNaN(date.getTime())) return String(serial);
    // Time-of-day matters only when the serial has a fraction.
    return serial % 1 === 0 ? date.toISOString().slice(0, 10) : date.toISOString().replace('.000Z', 'Z');
  }

  async function parseXlsxSheet(filePath: string, options: SheetReadOptions = {}): Promise<SheetReadResult> {
    const members = (await runAsync('unzip', ['-Z1', filePath], 30000))
      .split('\n').map(line => line.trim()).filter(Boolean);
    const sheets = await resolveSheetMembers(filePath, members);
    if (sheets.length === 0) throw new Error('XLSX contains no worksheets');
    if (!options.sheet) return { sheets };

    const wanted = sheets.find(s => s.name.toLowerCase() === String(options.sheet).toLowerCase());
    if (!wanted) {
      throw new Error(`no sheet named '${options.sheet}' — workbook has: ${sheets.map(s => s.name).join(', ')}`);
    }
    const maxRows = Math.max(1, Math.min(10_000, options.maxRows ?? 2000));
    const maxChars = Math.max(2_000, Math.min(120_000, options.maxChars ?? 60_000));
    const { shared, budgetHit } = await readSharedStringsBudgeted(filePath, members, LARGE_SHARED_STRINGS_BUDGET);
    const dateStyles = await dateStyleIndexes(filePath, members);

    const rows: string[][] = [];
    let rowsTotal: number | null = null;
    let chars = 0;
    let rowsCut = false;
    let charsCut = false;
    let formulaCells = 0;
    let carry = '';
    let sawDimension = false;
    await streamZipMember(filePath, wanted.member, (chunk) => {
      carry += chunk;
      if (!sawDimension) {
        const dim = carry.match(/<dimension\s+ref="[A-Z]+\d+(?::[A-Z]+(\d+))?"/);
        if (dim) { rowsTotal = dim[1] ? Number(dim[1]) : 1; sawDimension = true; }
        else if (carry.length > 64 * 1024) sawDimension = true;
      }
      const rowRe = /<row[^>]*>([\s\S]*?)<\/row>/g;
      let match: RegExpExecArray | null;
      let lastEnd = -1;
      while ((match = rowRe.exec(carry))) {
        lastEnd = rowRe.lastIndex;
        const cells: string[] = [];
        for (const cell of match[1].matchAll(/<c([^>]*)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
          const attrs = cell[1];
          const body = cell[2] ?? '';
          if (body.includes('<f')) formulaCells++;
          const raw = body.match(/<v>([\s\S]*?)<\/v>/)?.[1]
            ?? body.match(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/)?.[1]
            ?? '';
          if (/t="s"/.test(attrs)) {
            cells.push(shared[Number(raw)] ?? '');
          } else if (/t="b"/.test(attrs)) {
            cells.push(raw === '1' ? 'TRUE' : 'FALSE');
          } else {
            const styleIndex = Number(/\ss="(\d+)"/.exec(attrs)?.[1] ?? -1);
            const numeric = Number(raw);
            if (raw !== '' && Number.isFinite(numeric) && dateStyles.has(styleIndex)) {
              cells.push(serialToIso(numeric));
            } else {
              cells.push(decodeXmlEntities(raw));
            }
          }
        }
        while (cells.length && cells[cells.length - 1] === '') cells.pop();
        if (cells.length > 0) {
          rows.push(cells);
          chars += cells.reduce((total, value) => total + value.length + 1, 0);
        }
        if (rows.length >= maxRows) { rowsCut = true; return false; }
        if (chars >= maxChars) { charsCut = true; return false; }
      }
      carry = lastEnd >= 0 ? carry.slice(lastEnd) : carry;
      if (carry.length > STREAM_CARRY_CAP) carry = carry.slice(-STREAM_CARRY_CAP);
      return true;
    });

    return {
      sheets,
      sheet: {
        name: wanted.name,
        rows,
        rowsTotal,
        truncation: { rowsCut, charsCut, sharedStringsBudgetHit: budgetHit },
        formulaCells,
      },
    };
  }

  async function parsePptxLarge(filePath: string, slideCharCap: number): Promise<LargeParseResult> {
    // Slide text is tiny even in 200 MB decks — the size lives in media
    // parts, which this path never reads. Reuses the async member approach.
    const members = (await runAsync('unzip', ['-Z1', filePath], 30000))
      .split('\n').map((line) => line.trim()).filter(Boolean);
    const { slides, notes, slideNumber } = pptxMembers(members);
    if (slides.length === 0) throw new Error('PPTX contains no slides');
    let charCapped = 0;
    const textOf = async (member: string): Promise<string> => {
      const xml = await runAsync('unzip', ['-p', filePath, member], 30000);
      let text = xml
        .split(/<\/a:p>/)
        .map((paragraph) =>
          [...paragraph.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((m) => decodeXmlEntities(m[1])).join(''))
        .filter((line) => line.trim().length > 0)
        .join('\n');
      if (text.length > slideCharCap) {
        text = `${text.slice(0, slideCharCap)}… [slide text truncated]`;
        charCapped++;
      }
      return text;
    };
    const parts: string[] = [];
    for (const slide of slides) {
      const body = await textOf(slide);
      if (!body) continue;
      parts.push(`--- Slide ${slideNumber(slide)} ---\n${body}`);
      const note = slide.replace('ppt/slides/slide', 'ppt/notesSlides/notesSlide');
      if (notes.has(note)) {
        const noteText = await textOf(note);
        if (noteText) parts.push(`[Notes] ${noteText}`);
      }
    }
    if (parts.length === 0) throw new Error('PPTX contains no extractable slide text');
    return {
      text: parts.join('\n\n'),
      truncation: { slides: { kept: slides.length, total: slides.length, charCapped } },
    };
  }

  async function parsePdfLarge(filePath: string, pageCap: number): Promise<LargeParseResult> {
    // pdftotext caps pages natively; the vision helper cannot, so its output
    // is char-capped instead. Either way coverage is recorded, never silent.
    try {
      const text = (await runAsync('pdftotext', ['-l', String(pageCap), filePath, '-'], 120_000)).trim();
      if (!text) throw new Error('empty text layer');
      return { text, truncation: { pages: { capApplied: pageCap, tool: 'pdftotext' } } };
    } catch { /* fall through */ }
    const helper = visionHelperPath();
    if (fs.existsSync(helper)) {
      const raw = pdfHelperText(await runAsync(helper, ['pdf-text', filePath], 120_000));
      const capped = raw.length > LARGE_PDF_CHAR_CAP;
      return {
        text: capped ? `${raw.slice(0, LARGE_PDF_CHAR_CAP)}\n… [document text truncated]` : raw,
        truncation: { pages: { capApplied: null, tool: 'vision-helper', charCapped: capped } },
      };
    }
    throw new Error('No large-PDF extraction tool available (tried pdftotext, vision helper)');
  }

  async function parseLargeAsync(filePath: string, options?: LargeParseOptions): Promise<LargeParseResult> {
    const fileType = getFileType(filePath);
    if (!fs.existsSync(filePath)) throw new Error(`File not found: ${filePath}`);
    if (fileType === '.xlsx') {
      return parseXlsxLarge(filePath, {
        rowsPerSheet: options?.rowsPerSheet ?? LARGE_ROWS_PER_SHEET,
        sharedStringsBudgetBytes: options?.sharedStringsBudgetBytes ?? LARGE_SHARED_STRINGS_BUDGET,
      });
    }
    if (fileType === '.pptx') return parsePptxLarge(filePath, options?.slideCharCap ?? LARGE_SLIDE_CHAR_CAP);
    if (fileType === '.pdf') return parsePdfLarge(filePath, options?.pdfPageCap ?? LARGE_PDF_PAGE_CAP);
    throw new Error(`Unsupported format for the large-file lane: ${fileType}`);
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
        } else if (fileType === '.docx') {
          // Native first (tables + headings survive); converters as fallback.
          try { text = parseDocxNative(filePath); } catch { text = parseOffice(filePath); }
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
        } else if (fileType === '.docx') {
          // Native first (tables + headings survive); converters as fallback.
          try { text = await parseDocxNativeAsync(filePath); } catch { text = await parseOfficeAsync(filePath); }
        } else {
          text = await parseOfficeAsync(filePath);
        }
        return { success: true, text, filePath, fileType };
      } catch (err: any) {
        return { success: false, error: err.message, filePath, fileType };
      }
    },

    parseLargeAsync,

    parseXlsxSheet,

    getSupportedFormats(): string[] {
      return [...SUPPORTED_FORMATS];
    },
  };
}
