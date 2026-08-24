/**
 * Local document export: converts a product-document artifact's Markdown
 * content into downloadable files by running locally installed tools
 * directly (no cloud calls, no bundled conversion libraries).
 *
 *   markdown — raw content, no conversion tool required
 *   html     — pandoc -f gfm -t html (standalone, styled page)
 *   docx     — pandoc -f gfm -t docx
 *   pdf      — pandoc HTML printed by headless Chrome; falls back to the
 *              weasyprint pandoc engine when Chrome is unavailable
 *
 * Tools are resolved from PATH plus common Homebrew/app locations so exports
 * work even when the server was launched outside a login shell.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Deliberately lazy: resolving execFile at call time keeps this module
// importable in tests that partially mock child_process.
function execFileAsync(file: string, args: string[], options: { timeout: number; cwd?: string }) {
  return promisify(execFile)(file, args, options);
}

export type DocumentExportFormat = 'markdown' | 'html' | 'docx' | 'pdf';

export const DOCUMENT_EXPORT_FORMATS: Record<DocumentExportFormat, { extension: string; mediaType: string }> = {
  markdown: { extension: 'md', mediaType: 'text/markdown; charset=utf-8' },
  html: { extension: 'html', mediaType: 'text/html; charset=utf-8' },
  docx: { extension: 'docx', mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
  pdf: { extension: 'pdf', mediaType: 'application/pdf' },
};

export function isDocumentExportFormat(value: unknown): value is DocumentExportFormat {
  return typeof value === 'string' && value in DOCUMENT_EXPORT_FORMATS;
}

/** Conversion failed because a local tool is missing or errored. */
export class DocumentExportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DocumentExportError';
  }
}

const EXPORT_TIMEOUT_MS = 60_000;

/** Candidate directories for Homebrew installs when PATH lacks them. */
function extraBinDirs(): string[] {
  return [
    path.join(os.homedir(), 'homebrew', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
  ];
}

const resolvedBinaries = new Map<string, string | null>();

/** Verify candidate executables by running them; cache the first that works. */
async function resolveExecutable(cacheKey: string, candidates: string[]): Promise<string | null> {
  if (resolvedBinaries.has(cacheKey)) return resolvedBinaries.get(cacheKey) ?? null;
  for (const candidate of candidates) {
    try {
      await execFileAsync(candidate, ['--version'], { timeout: 10_000 });
      resolvedBinaries.set(cacheKey, candidate);
      return candidate;
    } catch {
      // Try the next candidate.
    }
  }
  resolvedBinaries.set(cacheKey, null);
  return null;
}

/** Find an executable by name on PATH or in common local install dirs. */
function resolveBinary(name: string): Promise<string | null> {
  return resolveExecutable(name, [name, ...extraBinDirs().map((dir) => path.join(dir, name))]);
}

/** Headless-capable Chrome/Chromium for printing HTML to PDF. */
function resolveChrome(): Promise<string | null> {
  return resolveExecutable('chrome', [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    path.join(os.homedir(), 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    'google-chrome',
    'chromium',
  ]);
}

/**
 * Print styling shared by the HTML download and the Chrome-printed PDF.
 * Amazon-standard document geometry (owner request 2026-08-20): thin 0.5in
 * page margins, an 11pt body, and printed-page footers carrying the date,
 * "Amazon Confidential", and page numbers (Amazon Writing Guidelines
 * mechanics). The @page margin boxes render in Chrome 131+ print; older
 * engines ignore them without side effects, and they never affect on-screen
 * HTML viewing.
 */
const buildExportStyle = (dateText: string) => `
  @page {
    margin: 12.7mm;
    @bottom-left { content: "${dateText}"; font: 8pt Calibri, "Segoe UI", Helvetica, Arial, sans-serif; color: #555b64; }
    @bottom-center { content: "Amazon Confidential"; font: 8pt Calibri, "Segoe UI", Helvetica, Arial, sans-serif; color: #555b64; }
    @bottom-right { content: "Page " counter(page) " of " counter(pages); font: 8pt Calibri, "Segoe UI", Helvetica, Arial, sans-serif; color: #555b64; }
  }
  html { font-size: 11pt; }
  body { max-width: 780px; margin: 0 auto; padding: 24px;
    font-family: Calibri, -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
    color: #1e2126; line-height: 1.5; }
  @media print {
    body { max-width: none; margin: 0; padding: 0; }
  }
  h1, h2, h3, h4 { line-height: 1.3; letter-spacing: -0.01em; }
  h1 { font-size: 1.7em; border-bottom: 1px solid #d8dbe1; padding-bottom: .3em; }
  h2 { font-size: 1.32em; border-bottom: 1px solid #e3e6ea; padding-bottom: .25em; margin-top: 1.7em; }
  h3 { font-size: 1.12em; margin-top: 1.5em; }
  code { background: #f1f2f5; border-radius: 4px; padding: .1em .35em; font-size: .88em; }
  pre { background: #f6f7f9; border: 1px solid #e3e6ea; border-radius: 8px; padding: 12px 14px; overflow-x: auto; }
  pre code { background: transparent; padding: 0; }
  table { border-collapse: collapse; margin: 1em 0; }
  th, td { border: 1px solid #ccd0d7; padding: 6px 11px; text-align: left; vertical-align: top; }
  th { background: #f1f2f5; }
  blockquote { border-left: 3px solid #ccd0d7; margin-left: 0; padding-left: 14px; color: #4c515a; }
  hr { border: 0; border-top: 1px solid #d8dbe1; margin: 2em 0; }
  a { color: #2456c4; }
  h1, h2, h3, h4, tr, pre { break-inside: avoid; }
`;

/** ASCII-safe attachment filename derived from the document title. */
export function exportFilename(title: string, format: DocumentExportFormat): string {
  const base = String(title || 'document')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'document';
  return `${base}.${DOCUMENT_EXPORT_FORMATS[format].extension}`;
}

function toolFailure(tool: string, error: unknown): DocumentExportError {
  const detail = error instanceof Error ? error.message : String(error);
  const stderr = (error as { stderr?: string })?.stderr?.trim();
  return new DocumentExportError(`${tool} conversion failed: ${stderr || detail}`.slice(0, 600));
}

export interface DocumentExportResult {
  data: Buffer;
  filename: string;
  mediaType: string;
}

function escapeXml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Word footer part: date, "Amazon Confidential", and Page X of Y at 9pt. */
function buildDocxFooterXml(dateText: string): string {
  const run = (inner: string) => `<w:r><w:rPr><w:sz w:val="18" /><w:szCs w:val="18" /><w:color w:val="555B64" /></w:rPr>${inner}</w:r>`;
  const field = (instr: string) => `<w:fldSimple w:instr=" ${instr} ">${run('<w:t>1</w:t>')}</w:fldSimple>`;
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:pPr>',
    // Letter page (12240 twips) minus 720-twip margins = 10800 of text width.
    '<w:tabs><w:tab w:val="center" w:pos="5400" /><w:tab w:val="right" w:pos="10800" /></w:tabs>',
    '<w:rPr><w:sz w:val="18" /><w:szCs w:val="18" /></w:rPr></w:pPr>',
    run(`<w:t xml:space="preserve">${escapeXml(dateText)}</w:t>`),
    run('<w:tab /><w:t>Amazon Confidential</w:t>'),
    run('<w:tab /><w:t xml:space="preserve">Page </w:t>'),
    field('PAGE'),
    run('<w:t xml:space="preserve"> of </w:t>'),
    field('NUMPAGES'),
    '</w:p></w:ftr>',
  ].join('');
}

/**
 * Post-process pandoc's DOCX to Amazon-standard document conventions:
 *   - 0.5in page margins (720 twips); pandoc's sectPr has NO pgMar, so Word
 *     falls back to its 1in default — margins must be injected, not replaced
 *   - 11pt default body (22 half-points; pandoc emits 12pt)
 *   - fully boxed tables: pandoc's default "Table" style draws only a header
 *     rule, so a full single-line grid (all edges + inside lines) is injected
 *     into that style, which every table in the document references
 *   - a footer part (date, Amazon Confidential, Page X of Y), which needs
 *     four coordinated edits: the footer1.xml part, a content-type override,
 *     a document.xml.rels relationship, and a sectPr footerReference
 * OOXML sectPr child order matters: footerReference leads, pgMar follows
 * footnotePr, so the footer reference goes after the opening tag and pgMar
 * immediately before the closing tag. Uses the macOS-bundled zip/unzip CLIs,
 * matching this module's local-tools design. Best-effort: any failure leaves
 * the original pandoc output intact.
 */
async function applyDocxHouseStyle(docxPath: string, workDir: string, dateText: string): Promise<void> {
  const extractDir = path.join(workDir, 'docx-geometry');
  try {
    await execFileAsync('/usr/bin/unzip', ['-q', docxPath, '-d', extractDir], { timeout: 20_000 });

    const documentPath = path.join(extractDir, 'word', 'document.xml');
    const stylesPath = path.join(extractDir, 'word', 'styles.xml');
    const contentTypesPath = path.join(extractDir, '[Content_Types].xml');
    const relsPath = path.join(extractDir, 'word', '_rels', 'document.xml.rels');
    const pgMar = '<w:pgMar w:top="720" w:right="720" w:bottom="720" w:left="720" w:header="360" w:footer="360" w:gutter="0" />';

    let documentXml = await fs.readFile(documentPath, 'utf8');
    if (!documentXml.includes('<w:sectPr')) {
      documentXml = documentXml.replace('</w:body>', '<w:sectPr></w:sectPr></w:body>');
    }
    if (documentXml.includes('<w:pgMar')) {
      documentXml = documentXml.replace(/<w:pgMar[^/]*\/>/g, pgMar);
    } else {
      documentXml = documentXml.replace(/<\/w:sectPr>/, `${pgMar}</w:sectPr>`);
    }

    // Footer wiring: part + content type + relationship + section reference.
    // Skipped safely if the r namespace is missing or a footer already exists.
    const footerRelId = 'rIdAmznFooter';
    if (documentXml.includes('xmlns:r=') && !documentXml.includes('<w:footerReference')) {
      await fs.writeFile(path.join(extractDir, 'word', 'footer1.xml'), buildDocxFooterXml(dateText), 'utf8');

      let contentTypes = await fs.readFile(contentTypesPath, 'utf8');
      if (!contentTypes.includes('/word/footer1.xml')) {
        contentTypes = contentTypes.replace(
          '</Types>',
          '<Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml" /></Types>',
        );
        await fs.writeFile(contentTypesPath, contentTypes, 'utf8');
      }

      let rels = await fs.readFile(relsPath, 'utf8');
      if (!rels.includes(footerRelId)) {
        rels = rels.replace(
          '</Relationships>',
          `<Relationship Id="${footerRelId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml" /></Relationships>`,
        );
        await fs.writeFile(relsPath, rels, 'utf8');
      }

      documentXml = documentXml.replace(
        /<w:sectPr(\s[^>]*)?>/,
        (match) => `${match}<w:footerReference w:type="default" r:id="${footerRelId}" />`,
      );
    }
    await fs.writeFile(documentPath, documentXml, 'utf8');

    let stylesXml = await fs.readFile(stylesPath, 'utf8');
    stylesXml = stylesXml.replace(
      /(<w:rPrDefault>[\s\S]{0,600}?)<w:sz w:val="24" \/>(\s*)<w:szCs w:val="24" \/>/,
      '$1<w:sz w:val="22" />$2<w:szCs w:val="22" />',
    );
    const border = (edge: string) => `<w:${edge} w:val="single" w:sz="4" w:space="0" w:color="000000" />`;
    const tblBorders = `<w:tblBorders>${['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map(border).join('')}</w:tblBorders>`;
    stylesXml = stylesXml.replace(
      /(<w:style [^>]*w:styleId="Table"[\s\S]*?)<\/w:style>/,
      (styleBlock) => {
        if (styleBlock.includes('<w:tblBorders>')) return styleBlock;
        // OOXML tblPr sequence places tblBorders after tblInd, before tblCellMar.
        if (styleBlock.includes('<w:tblInd')) {
          return styleBlock.replace(/(<w:tblInd[^/]*\/>)/, `$1${tblBorders}`);
        }
        return styleBlock.replace('<w:tblPr>', `<w:tblPr>${tblBorders}`);
      },
    );
    await fs.writeFile(stylesPath, stylesXml, 'utf8');

    // Rebuild in place: -X drops extra file attributes; DOCX readers accept
    // any member order, so a plain recursive zip of the tree is sufficient.
    const rebuiltPath = path.join(workDir, 'output-geometry.docx');
    await execFileAsync('/usr/bin/zip', ['-q', '-r', '-X', rebuiltPath, '.'], { timeout: 20_000, cwd: extractDir });
    await fs.copyFile(rebuiltPath, docxPath);
  } catch (error) {
    console.warn(`[DocumentExport] DOCX house-style pass skipped: ${error instanceof Error ? error.message : error}`);
  }
}

export async function exportDocument(input: {
  title: string;
  content: string;
  format: DocumentExportFormat;
}): Promise<DocumentExportResult> {
  const { title, content, format } = input;
  const filename = exportFilename(title, format);
  const mediaType = DOCUMENT_EXPORT_FORMATS[format].mediaType;

  if (format === 'markdown') {
    return { data: Buffer.from(content, 'utf8'), filename, mediaType };
  }

  const pandoc = await resolveBinary('pandoc');
  if (!pandoc) {
    throw new DocumentExportError(
      'pandoc is not installed. Install it (for example: brew install pandoc) to export HTML, DOCX, or PDF.',
    );
  }

  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'botboy-doc-export-'));
  try {
    const dateText = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
    const inputPath = path.join(workDir, 'input.md');
    const headerPath = path.join(workDir, 'header.html');
    await fs.writeFile(inputPath, content, 'utf8');
    await fs.writeFile(headerPath, `<style>${buildExportStyle(dateText)}</style>`, 'utf8');
    const baseArgs = ['--from=gfm', `--metadata=title:${title || 'Document'}`];

    const runPandoc = async (args: string[]) => {
      try {
        await execFileAsync(pandoc, args, { timeout: EXPORT_TIMEOUT_MS });
      } catch (error) {
        throw toolFailure('pandoc', error);
      }
    };

    const renderHtml = async (outputPath: string) => {
      await runPandoc([
        ...baseArgs,
        '--to=html', '--standalone', '--embed-resources', `--include-in-header=${headerPath}`,
        '--output', outputPath, inputPath,
      ]);
    };

    if (format === 'html') {
      const outputPath = path.join(workDir, 'output.html');
      await renderHtml(outputPath);
      return { data: await fs.readFile(outputPath), filename, mediaType };
    }

    if (format === 'docx') {
      const outputPath = path.join(workDir, 'output.docx');
      await runPandoc([...baseArgs, '--to=docx', '--output', outputPath, inputPath]);
      await applyDocxHouseStyle(outputPath, workDir, dateText);
      return { data: await fs.readFile(outputPath), filename, mediaType };
    }

    // PDF: print the styled HTML with headless Chrome (present on nearly
    // every macOS setup); weasyprint stays as a fallback engine for pandoc.
    const outputPath = path.join(workDir, 'output.pdf');
    const chrome = await resolveChrome();
    if (chrome) {
      const htmlPath = path.join(workDir, 'print.html');
      await renderHtml(htmlPath);
      try {
        await execFileAsync(chrome, [
          '--headless',
          '--disable-gpu',
          '--no-first-run',
          `--user-data-dir=${path.join(workDir, 'chrome-profile')}`,
          '--no-pdf-header-footer',
          `--print-to-pdf=${outputPath}`,
          `file://${htmlPath}`,
        ], { timeout: EXPORT_TIMEOUT_MS });
      } catch (error) {
        throw toolFailure('Chrome PDF printing', error);
      }
      return { data: await fs.readFile(outputPath), filename, mediaType };
    }

    const weasyprint = await resolveBinary('weasyprint');
    if (!weasyprint) {
      throw new DocumentExportError(
        'PDF export needs Google Chrome or weasyprint installed locally; neither was found.',
      );
    }
    await runPandoc([...baseArgs, `--pdf-engine=${weasyprint}`, `--include-in-header=${headerPath}`, '--output', outputPath, inputPath]);
    return { data: await fs.readFile(outputPath), filename, mediaType };
  } finally {
    await fs.rm(workDir, { recursive: true, force: true });
  }
}
