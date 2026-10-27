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
import { addSvgPngFallbacks, prepareExportMedia, type ExportMediaSummary } from './document-media.js';

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

/**
 * Conversion failed because a local tool is missing or errored. `code`
 * distinguishes the actionable "install pandoc" case (the export route maps
 * it to HTTP 424 and the UI offers the guided install) from ordinary tool
 * failures (502).
 */
export type DocumentExportErrorCode = 'pandoc_missing' | 'tool_failed';
export class DocumentExportError extends Error {
  constructor(message: string, public readonly code: DocumentExportErrorCode = 'tool_failed') {
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

/**
 * Verify candidate executables by running them; cache the first that works.
 * Only SUCCESSES are cached: a missing tool can be installed mid-session (the
 * guided pandoc install flow), and a cached null would keep every download
 * failing until a server restart. Probing absent binaries costs nothing —
 * spawn fails instantly with ENOENT.
 */
async function resolveExecutable(cacheKey: string, candidates: string[]): Promise<string | null> {
  const cached = resolvedBinaries.get(cacheKey);
  if (cached) return cached;
  for (const candidate of candidates) {
    try {
      await execFileAsync(candidate, ['--version'], { timeout: 10_000 });
      resolvedBinaries.set(cacheKey, candidate);
      return candidate;
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

/** Find an executable by name on PATH or in common local install dirs. */
function resolveBinary(name: string): Promise<string | null> {
  return resolveExecutable(name, [name, ...extraBinDirs().map((dir) => path.join(dir, name))]);
}

/**
 * Homebrew, for the guided pandoc install (the install endpoint needs the
 * absolute path — the terminal runs a fixed server-side command, and PATH on
 * a login shell may still miss a fresh Homebrew).
 */
export function resolveBrewExecutable(): Promise<string | null> {
  return resolveExecutable('brew', ['brew', ...extraBinDirs().map((dir) => path.join(dir, 'brew'))]);
}

/** True when Word/HTML/PDF exports can convert (markdown always works). */
export async function isPandocInstalled(): Promise<boolean> {
  return (await resolveBinary('pandoc')) !== null;
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
 * A CSS string literal for owner text: wrapped in double quotes, with \, ",
 * <, >, and & written as CSS hex escapes so footer text can never close the
 * string or break out of the <style> element in header.html.
 */
export function cssString(text: string): string {
  const escapes: Record<string, string> = { '\\': '\\5C ', '"': '\\22 ', '<': '\\3C ', '>': '\\3E ', '&': '\\26 ' };
  return '"' + text.replace(/[\\"<>&]/g, char => escapes[char]) + '"';
}

/**
 * Print styling shared by the HTML download and the Chrome-printed PDF.
 * House-style document geometry (owner request 2026-08-20): thin 0.5in page
 * margins, an 11pt body, and printed-page footers carrying the date, the
 * owner's export footer text (Settings → Workplace; omitted when blank), and
 * page numbers. The @page margin boxes render in Chrome 131+ print; older
 * engines ignore them without side effects, and they never affect on-screen
 * HTML viewing.
 */
export const buildExportStyle = (dateText: string, footerText = '') => `
  @page {
    margin: 12.7mm;
    @bottom-left { content: "${dateText}"; font: 8pt Calibri, "Segoe UI", Helvetica, Arial, sans-serif; color: #555b64; }
${footerText ? `    @bottom-center { content: ${cssString(footerText)}; font: 8pt Calibri, "Segoe UI", Helvetica, Arial, sans-serif; color: #555b64; }\n` : ''}    @bottom-right { content: "Page " counter(page) " of " counter(pages); font: 8pt Calibri, "Segoe UI", Helvetica, Arial, sans-serif; color: #555b64; }
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
  th { background: #000; color: #fff; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  blockquote { border-left: 3px solid #ccd0d7; margin-left: 0; padding-left: 14px; color: #4c515a; }
  hr { border: 0; border-top: 1px solid #d8dbe1; margin: 2em 0; }
  a { color: #2456c4; }
  h1, h2, h3, h4, tr, pre { break-inside: avoid; }
  /* Pictures and diagrams (document-media.ts): never wider than the page, and a
     picture on a line of its own sits centred. */
  img { max-width: 100%; height: auto; break-inside: avoid; }
  p > img:only-child { display: block; margin: 0.6em auto; }
`;

/**
 * Print-only additions for the Chrome-printed PDF (owner request 2026-08-28):
 * Amazon document sizes (10pt body, 11pt headings, 12pt title — the content's
 * own H1 is the title now that the metadata title block is gone) and margin
 * line numbers, which Amazon docs carry almost always. CSS cannot number
 * visual lines, so a small script measures each block's line boxes after layout
 * (Range.getClientRects) and absolutely positions continuous numbers in a
 * left gutter; headless Chrome runs scripts before printing. Tables are not
 * line-numbered, matching Word's own line-numbering behavior. The on-screen
 * HTML download never includes any of this.
 */
const buildPrintExtras = () => `
<style>
  html { font-size: 10pt; }
  h1 { font-size: 12pt; }
  h2, h3, h4, h5, h6 { font-size: 11pt; }
  /* The numbering script measures line positions in the loaded page (screen
     media) but Chrome prints under print media — the two layouts MUST be
     identical or the numbers drift off their lines. Lock BOTH to the same
     absolute geometry: pin the paper (the print default follows the system
     locale — A4 here — and A4 vs Letter wraps text differently) and give the
     body a fixed mm width equal to the printable area, so the wrap points
     stop depending on viewport or paper defaults entirely. */
  @page { size: 8.5in 11in; }
  /* font-size 1rem !important: pandoc's embedded defaults set body to 12pt
     UNDER PRINT MEDIA ONLY — the exact screen-vs-print reflow this geometry
     exists to prevent (found 2026-08-28: 2 lines measured, 3 printed). */
  body { box-sizing: border-box; width: 190.5mm; max-width: none !important;
    font-size: 1rem !important; margin: 0 !important; padding: 0 0 0 9mm !important; }
  /* Numbered blocks must never split across pages: each line's number is
     positioned INSIDE its block, so a fragmenting block would leave numbers
     on the wrong page. Amazon-length paragraphs fit comfortably on a page. */
  p, li { break-inside: avoid; }
  /* overflow-x would clip the absolutely positioned numbers that hang left
     of the code block; wrapped lines get numbered like any other line. */
  pre { overflow-x: visible; white-space: pre-wrap; }
  .amzn-line-no { position: absolute; width: 6.5mm; text-align: right;
    font: 7pt Calibri, "Segoe UI", Helvetica, Arial, sans-serif; color: #9aa0a8; }
</style>
<script>
window.addEventListener('load', () => {
  const blocks = document.querySelectorAll('p, h1, h2, h3, h4, h5, h6, li, pre');
  const seen = [];
  let lineNumber = 0;
  for (const el of blocks) {
    if (el.closest('table')) continue;                     // Word skips tables
    if (el.tagName === 'LI' && el.querySelector('p')) continue; // loose list: the inner p is the line container
    if (el.querySelector('img') && !el.textContent.trim()) continue; // a picture or diagram is not a line of text
    const blockRect = el.getBoundingClientRect();
    const range = document.createRange();
    range.selectNodeContents(el);
    const tops = [];
    for (const rect of range.getClientRects()) {
      if (rect.width < 1 || rect.height < 1) continue;
      const top = Math.round(rect.top);
      if (seen.some((t) => Math.abs(t - top) < 3)) continue; // nested lists: parent li already counted this line
      if (!tops.some((t) => Math.abs(t - top) < 3)) { tops.push(top); seen.push(top); }
    }
    if (!tops.length) continue;
    el.style.position = 'relative';
    for (const top of tops) {
      lineNumber += 1;
      const marker = document.createElement('span');
      marker.className = 'amzn-line-no';
      marker.textContent = String(lineNumber);
      // Block-relative placement; page x = 0 (left edge of the 9mm gutter).
      marker.style.top = (top - blockRect.top - el.clientTop) + 'px';
      marker.style.left = (-blockRect.left - el.clientLeft) + 'px';
      el.appendChild(marker);
    }
  }
});
</script>`;

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
  /** Pictures and diagrams (docs/maps/document-media.md); absent when the document has none. */
  media?: ExportMediaSummary;
}

function escapeXml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Word footer part: date, the owner's footer text (blank keeps the tab), and Page X of Y at 9pt. */
export function buildDocxFooterXml(dateText: string, footerText = ''): string {
  const run = (inner: string) => `<w:r><w:rPr><w:sz w:val="18" /><w:szCs w:val="18" /><w:color w:val="555B64" /></w:rPr>${inner}</w:r>`;
  const field = (instr: string) => `<w:fldSimple w:instr=" ${instr} ">${run('<w:t>1</w:t>')}</w:fldSimple>`;
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:pPr>',
    // Letter page (12240 twips) minus 720-twip margins = 10800 of text width.
    '<w:tabs><w:tab w:val="center" w:pos="5400" /><w:tab w:val="right" w:pos="10800" /></w:tabs>',
    '<w:rPr><w:sz w:val="18" /><w:szCs w:val="18" /></w:rPr></w:pPr>',
    run(`<w:t xml:space="preserve">${escapeXml(dateText)}</w:t>`),
    run(footerText ? `<w:tab /><w:t xml:space="preserve">${escapeXml(footerText)}</w:t>` : '<w:tab />'),
    run('<w:tab /><w:t xml:space="preserve">Page </w:t>'),
    field('PAGE'),
    run('<w:t xml:space="preserve"> of </w:t>'),
    field('NUMPAGES'),
    '</w:p></w:ftr>',
  ].join('');
}

/**
 * Post-process pandoc's DOCX to BotBoy's house-style document conventions:
 *   - 0.5in page margins (720 twips); pandoc's sectPr has NO pgMar, so Word
 *     falls back to its 1in default — margins must be injected, not replaced
 *   - 11pt default body (22 half-points; pandoc emits 12pt)
 *   - fully boxed tables: pandoc's default "Table" style draws only a header
 *     rule, so a full single-line grid (all edges + inside lines) is injected
 *     into that style, which every table in the document references
 *   - a footer part (date, the export footer text, Page X of Y), which needs
 *     four coordinated edits: the footer1.xml part, a content-type override,
 *     a document.xml.rels relationship, and a sectPr footerReference
 * OOXML sectPr child order matters: footerReference leads, pgMar follows
 * footnotePr, so the footer reference goes after the opening tag and pgMar
 * immediately before the closing tag. Uses the macOS-bundled zip/unzip CLIs,
 * matching this module's local-tools design. Best-effort: any failure leaves
 * the original pandoc output intact.
 */
async function applyDocxHouseStyle(docxPath: string, workDir: string, dateText: string, footerText = '', pngForSvg: ReadonlyMap<string, Buffer> = new Map()): Promise<void> {
  const extractDir = path.join(workDir, 'docx-geometry');
  try {
    await execFileAsync('/usr/bin/unzip', ['-q', docxPath, '-d', extractDir], { timeout: 20_000 });

    const documentPath = path.join(extractDir, 'word', 'document.xml');
    const stylesPath = path.join(extractDir, 'word', 'styles.xml');
    const contentTypesPath = path.join(extractDir, '[Content_Types].xml');
    const relsPath = path.join(extractDir, 'word', '_rels', 'document.xml.rels');
    const pgMar = '<w:pgMar w:top="720" w:right="720" w:bottom="720" w:left="720" w:header="360" w:footer="360" w:gutter="0" />';

    // Continuous margin line numbers (owner request 2026-08-28 — Amazon docs
    // carry them almost always). Schema order: lnNumType follows pgMar inside
    // sectPr, so it rides the same insertion points.
    const lnNum = '<w:lnNumType w:countBy="1" w:restart="continuous" w:distance="240" />';
    let documentXml = await fs.readFile(documentPath, 'utf8');
    if (!documentXml.includes('<w:sectPr')) {
      documentXml = documentXml.replace('</w:body>', '<w:sectPr></w:sectPr></w:body>');
    }
    const pgMarWithLn = documentXml.includes('<w:lnNumType') ? pgMar : `${pgMar}${lnNum}`;
    if (documentXml.includes('<w:pgMar')) {
      documentXml = documentXml.replace(/<w:pgMar[^/]*\/>/g, pgMarWithLn);
    } else {
      documentXml = documentXml.replace(/<\/w:sectPr>/, `${pgMarWithLn}</w:sectPr>`);
    }

    // Header-row conditional formatting only fires when the table's tblLook
    // enables firstRow — make sure every table asks for it. tblLook is the
    // LAST child in the tblPr sequence, so it goes just before the close.
    documentXml = documentXml
      .replace(/(<w:tblLook [^>]*w:firstRow=")0(")/g, '$11$2')
      .replace(/<w:tblPr>[\s\S]*?<\/w:tblPr>/g, (block) => block.includes('<w:tblLook')
        ? block
        : block.replace('</w:tblPr>', '<w:tblLook w:val="04A0" w:firstRow="1" w:lastRow="0" w:firstColumn="0" w:lastColumn="0" w:noHBand="1" w:noVBand="1" /></w:tblPr>'));

    // Belt AND braces for the black header row: conditional table styling is
    // ignored by several real viewers (Quick Look, Pages) even when perfectly
    // formed — so the first row of every table ALSO gets DIRECT formatting:
    // cell shading + white bold runs. Direct props win in every renderer.
    documentXml = documentXml.replace(/<w:tbl>[\s\S]*?<\/w:tbl>/g, (table) =>
      table.replace(/<w:tr[ >][\s\S]*?<\/w:tr>/, (headerRow) =>
        headerRow.replace(/<w:tc>([\s\S]*?)<\/w:tc>/g, (cellMatch, cellInner) => {
          let inner = cellInner;
          const shd = '<w:shd w:val="clear" w:color="auto" w:fill="000000" />';
          // Cell shading. THREE tcPr shapes exist: pandoc emits EMPTY
          // SELF-CLOSING `<w:tcPr />` per cell (an `includes('<w:tcPr>')`
          // check misses it — the double-tcPr bug, 2026-08-28); expanded
          // tcPr gets shd after the leading cnfStyle/tcW/gridSpan/tcBorders
          // group (CT_TcPr sequence); no tcPr gets a fresh one as the cell's
          // first child.
          if (/<w:tcPr\s*\/>/.test(inner)) {
            inner = inner.replace(/<w:tcPr\s*\/>/, `<w:tcPr>${shd}</w:tcPr>`);
          } else if (inner.includes('<w:tcPr>')) {
            if (!/<w:tcPr>[\s\S]*?<w:shd /.test(inner)) {
              inner = inner.replace(
                /<w:tcPr>((?:<w:cnfStyle[^>]*\/>)?(?:<w:tcW[^>]*\/>)?(?:<w:gridSpan[^>]*\/>)?(?:<w:tcBorders>[\s\S]*?<\/w:tcBorders>)?)/,
                `<w:tcPr>$1${shd}`,
              );
            }
          } else {
            inner = `<w:tcPr>${shd}</w:tcPr>${inner}`;
          }
          // White bold runs. Existing rPr: strip any b/bCs/color first (no
          // duplicates), then insert after the leading rStyle/rFonts group so
          // the rPr child sequence stays valid. Bare runs: fresh rPr as the
          // run's first child.
          inner = inner.replace(/<w:r><w:rPr>([\s\S]*?)<\/w:rPr>/g, (_runMatch: string, props: string) => {
            const cleaned = props.replace(/<w:b \/>|<w:b\/>|<w:bCs \/>|<w:bCs\/>|<w:color [^>]*\/>/g, '');
            const merged = cleaned.replace(
              /^((?:<w:rStyle[^>]*\/>)?(?:<w:rFonts[^>]*\/>)?)/,
              '$1<w:b /><w:bCs /><w:color w:val="FFFFFF" />',
            );
            return `<w:r><w:rPr>${merged}</w:rPr>`;
          });
          inner = inner.replace(/<w:r>(?!<w:rPr>)/g, '<w:r><w:rPr><w:b /><w:bCs /><w:color w:val="FFFFFF" /></w:rPr>');
          return `<w:tc>${inner}</w:tc>`;
        }),
      ));

    // Footer wiring: part + content type + relationship + section reference.
    // Skipped safely if the r namespace is missing or a footer already exists.
    const footerRelId = 'rIdBotboyFooter';
    if (documentXml.includes('xmlns:r=') && !documentXml.includes('<w:footerReference')) {
      await fs.writeFile(path.join(extractDir, 'word', 'footer1.xml'), buildDocxFooterXml(dateText, footerText), 'utf8');

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

    // Diagrams and SVG pictures: pandoc writes Word's SVG picture with no PNG
    // for readers that cannot draw SVG; give each one (document-media.ts).
    if (pngForSvg.size && documentXml.includes('svgBlip')) {
      try {
        const relsXml = await fs.readFile(relsPath, 'utf8');
        const svgByTarget = new Map<string, Buffer>();
        for (const target of relsXml.match(/Target="media\/[^"]+\.svg"/gi) ?? []) {
          const relative = target.slice('Target="'.length, -1);
          try { svgByTarget.set(relative, await fs.readFile(path.join(extractDir, 'word', relative))); } catch { /* not in the package */ }
        }
        const withFallbacks = addSvgPngFallbacks({ documentXml, relsXml, contentTypesXml: await fs.readFile(contentTypesPath, 'utf8') }, svgByTarget, pngForSvg);
        if (withFallbacks.added) {
          for (const file of withFallbacks.files) await fs.writeFile(path.join(extractDir, file.path), file.data);
          await fs.writeFile(relsPath, withFallbacks.relsXml, 'utf8');
          await fs.writeFile(contentTypesPath, withFallbacks.contentTypesXml, 'utf8');
          documentXml = withFallbacks.documentXml;
        }
      } catch (error) {
        console.warn(`[DocumentExport] SVG fallback pictures skipped: ${error instanceof Error ? error.message : error}`);
      }
    }
    await fs.writeFile(documentPath, documentXml, 'utf8');

    let stylesXml = await fs.readFile(stylesPath, 'utf8');
    // Amazon document sizes and ink (owner request 2026-08-28): 10pt body,
    // 11pt bold black headings, 12pt bold black title — pandoc's reference
    // styles ship Word's blue (2F5496-family) headings and larger sizes.
    // Color/size edits are IN PLACE where the elements already exist so the
    // rPr child order pandoc emitted stays schema-valid; bold is inserted
    // directly after rFonts (its legal slot) only when the style lacks it.
    stylesXml = stylesXml.replace(
      /(<w:rPrDefault>[\s\S]{0,600}?)<w:sz w:val="2\d" \/>(\s*)<w:szCs w:val="2\d" \/>/,
      '$1<w:sz w:val="20" />$2<w:szCs w:val="20" />',
    );
    const restyleHeading = (styleId: string, halfPoints: number) => {
      stylesXml = stylesXml.replace(
        new RegExp(`<w:style [^>]*w:styleId="${styleId}"[\\s\\S]*?</w:style>`),
        (styleBlock) => {
          let block = styleBlock
            // Replace the whole color element: theme attributes (w:themeColor/
            // w:themeShade) outrank a rewritten w:val in Word's rendering.
            .replace(/<w:color [^>]*\/>/g, '<w:color w:val="000000" />')
            .replace(/<w:sz w:val="\d+"\s*\/>/g, `<w:sz w:val="${halfPoints}" />`)
            .replace(/<w:szCs w:val="\d+"\s*\/>/g, `<w:szCs w:val="${halfPoints}" />`);
          if (!/<w:b\s*\/>/.test(block)) {
            block = block.replace(/(<w:rPr>(?:<w:rFonts[^>]*\/>)?)/, '$1<w:b /><w:bCs />');
          }
          return block;
        },
      );
    };
    restyleHeading('Title', 24);
    for (let level = 1; level <= 9; level += 1) restyleHeading(`Heading${level}`, 22);
    const border = (edge: string) => `<w:${edge} w:val="single" w:sz="4" w:space="0" w:color="000000" />`;
    const tblBorders = `<w:tblBorders>${['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map(border).join('')}</w:tblBorders>`;
    stylesXml = stylesXml.replace(
      /(<w:style [^>]*w:styleId="Table"[\s\S]*?)<\/w:style>/,
      (styleBlock) => {
        let block = styleBlock;
        if (!block.includes('<w:tblBorders>')) {
          // OOXML tblPr sequence places tblBorders after tblInd, before tblCellMar.
          block = block.includes('<w:tblInd')
            ? block.replace(/(<w:tblInd[^/]*\/>)/, `$1${tblBorders}`)
            : block.replace('<w:tblPr>', `<w:tblPr>${tblBorders}`);
        }
        // Amazon table convention (owner request 2026-08-28): header row gets
        // a black fill with white bold text. Pandoc's Table style SHIPS a
        // firstRow tblStylePr of its own (bottom border + vAlign only) — the
        // first version of this pass guarded on the block's mere presence and
        // silently skipped the fill (owner-reported regression 2026-08-28).
        // Merge into the existing block; only append a fresh one when a
        // future pandoc drops it.
        if (!block.includes('w:fill="000000"')) {
          if (block.includes('w:type="firstRow"')) {
            // rPr leads inside tblStylePr (before tblPr/trPr/tcPr)…
            block = block.replace(
              /(<w:tblStylePr w:type="firstRow">)/,
              '$1<w:rPr><w:b /><w:bCs /><w:color w:val="FFFFFF" /></w:rPr>',
            );
            // …and shd follows tcBorders inside its tcPr (CT_TcPr order).
            block = /<w:tblStylePr w:type="firstRow">[\s\S]*?<\/w:tcBorders>/.test(block)
              ? block.replace(
                  /(<w:tblStylePr w:type="firstRow">[\s\S]*?<\/w:tcBorders>)/,
                  '$1<w:shd w:val="clear" w:color="auto" w:fill="000000" />',
                )
              : block.replace(
                  /(<w:tblStylePr w:type="firstRow">[\s\S]*?<w:tcPr>)/,
                  '$1<w:shd w:val="clear" w:color="auto" w:fill="000000" />',
                );
          } else {
            block = block.replace(
              /<\/w:style>$/,
              '<w:tblStylePr w:type="firstRow"><w:rPr><w:b /><w:bCs /><w:color w:val="FFFFFF" /></w:rPr><w:tcPr><w:shd w:val="clear" w:color="auto" w:fill="000000" /></w:tcPr></w:tblStylePr></w:style>',
            );
          }
        }
        return block;
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

/** Only Word's SVG fallback pictures (no house style): for a .docx that Google converts. */
async function applySvgFallbacksOnly(docxPath: string, workDir: string, pngForSvg: ReadonlyMap<string, Buffer>): Promise<void> {
  if (!pngForSvg.size) return;
  const extractDir = path.join(workDir, 'docx-fallbacks');
  try {
    await execFileAsync('/usr/bin/unzip', ['-q', docxPath, '-d', extractDir], { timeout: 20_000 });
    const documentPath = path.join(extractDir, 'word', 'document.xml');
    const relsPath = path.join(extractDir, 'word', '_rels', 'document.xml.rels');
    const contentTypesPath = path.join(extractDir, '[Content_Types].xml');
    const relsXml = await fs.readFile(relsPath, 'utf8');
    const svgByTarget = new Map<string, Buffer>();
    for (const target of relsXml.match(/Target="media\/[^"]+\.svg"/gi) ?? []) {
      const relative = target.slice('Target="'.length, -1);
      try { svgByTarget.set(relative, await fs.readFile(path.join(extractDir, 'word', relative))); } catch { /* not in the package */ }
    }
    const result = addSvgPngFallbacks({ documentXml: await fs.readFile(documentPath, 'utf8'), relsXml, contentTypesXml: await fs.readFile(contentTypesPath, 'utf8') }, svgByTarget, pngForSvg);
    if (!result.added) return;
    for (const file of result.files) await fs.writeFile(path.join(extractDir, file.path), file.data);
    await fs.writeFile(documentPath, result.documentXml, 'utf8');
    await fs.writeFile(relsPath, result.relsXml, 'utf8');
    await fs.writeFile(contentTypesPath, result.contentTypesXml, 'utf8');
    const rebuiltPath = path.join(workDir, 'output-fallbacks.docx');
    await execFileAsync('/usr/bin/zip', ['-q', '-r', '-X', rebuiltPath, '.'], { timeout: 20_000, cwd: extractDir });
    await fs.copyFile(rebuiltPath, docxPath);
  } catch (error) {
    console.warn(`[DocumentExport] SVG fallback pictures skipped: ${error instanceof Error ? error.message : error}`);
  }
}

/**
 * Markdown with pictures or diagrams as a plain Word file for Google Drive to convert into a Doc
 * (gdrive_files create kind doc, gdrive_edit content): Drive's Markdown import cannot carry
 * pictures, its Word import can. No house style (that is for BotBoy's own documents). Null when the
 * Markdown has neither pictures nor diagrams, or pandoc is missing (the caller keeps Markdown import).
 */
export async function markdownToWordForGoogle(markdown: string): Promise<{ data: Buffer; media: ExportMediaSummary } | null> {
  const pandoc = await resolveBinary('pandoc');
  if (!pandoc) return null;
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'botboy-google-docx-'));
  try {
    const prepared = await prepareExportMedia(markdown, workDir);
    if (!prepared.summary.pictures && !prepared.summary.diagrams) return null;
    const inputPath = path.join(workDir, 'input.md');
    const outputPath = path.join(workDir, 'output.docx');
    await fs.writeFile(inputPath, prepared.markdown, 'utf8');
    try {
      await execFileAsync(pandoc, ['--from=gfm', `--resource-path=${workDir}`, '--to=docx', '--output', outputPath, inputPath], { timeout: EXPORT_TIMEOUT_MS, cwd: workDir });
    } catch (error) {
      throw toolFailure('pandoc', error);
    }
    await applySvgFallbacksOnly(outputPath, workDir, prepared.pngForSvg);
    return { data: await fs.readFile(outputPath), media: prepared.summary };
  } finally {
    await fs.rm(workDir, { recursive: true, force: true });
  }
}

export async function exportDocument(input: {
  title: string;
  content: string;
  format: DocumentExportFormat;
  /** Center page-footer text (export-footer.ts). Default '' = no footer text (D2). */
  footerText?: string;
}): Promise<DocumentExportResult> {
  const { title, content, format } = input;
  const footerText = input.footerText ?? '';
  const filename = exportFilename(title, format);
  const mediaType = DOCUMENT_EXPORT_FORMATS[format].mediaType;

  if (format === 'markdown') {
    return { data: Buffer.from(content, 'utf8'), filename, mediaType };
  }

  const pandoc = await resolveBinary('pandoc');
  if (!pandoc) {
    throw new DocumentExportError(
      'pandoc is not installed. Install it (for example: brew install pandoc) to export HTML, DOCX, or PDF.',
      'pandoc_missing',
    );
  }

  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'botboy-doc-export-'));
  try {
    const dateText = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
    const inputPath = path.join(workDir, 'input.md');
    const headerPath = path.join(workDir, 'header.html');
    // Pictures and diagrams land in workDir/media and pandoc runs in workDir,
    // so every format embeds the same files (document-media.ts).
    const prepared = await prepareExportMedia(content, workDir);
    const media = prepared.summary.pictures || prepared.summary.diagrams ? { media: prepared.summary } : {};
    await fs.writeFile(inputPath, prepared.markdown, 'utf8');
    await fs.writeFile(headerPath, `<style>${buildExportStyle(dateText, footerText)}</style>`, 'utf8');
    // No `--metadata=title`: pandoc renders that as a visible title block in
    // standalone HTML and a Title paragraph in DOCX, duplicating the H1 the
    // document content already opens with (owner report 2026-08-28 — markdown
    // was the only clean export). `pagetitle` below fills the HTML <title>
    // tag only, without entering the document body.
    const baseArgs = ['--from=gfm', `--resource-path=${workDir}`];

    const runPandoc = async (args: string[]) => {
      try {
        await execFileAsync(pandoc, args, { timeout: EXPORT_TIMEOUT_MS, cwd: workDir });
      } catch (error) {
        throw toolFailure('pandoc', error);
      }
    };

    const renderHtml = async (outputPath: string) => {
      await runPandoc([
        ...baseArgs,
        `--metadata=pagetitle:${title || 'Document'}`,
        '--to=html', '--standalone', '--embed-resources', `--include-in-header=${headerPath}`,
        '--output', outputPath, inputPath,
      ]);
    };

    if (format === 'html') {
      const outputPath = path.join(workDir, 'output.html');
      await renderHtml(outputPath);
      return { data: await fs.readFile(outputPath), filename, mediaType, ...media };
    }

    if (format === 'docx') {
      const outputPath = path.join(workDir, 'output.docx');
      await runPandoc([...baseArgs, '--to=docx', '--output', outputPath, inputPath]);
      await applyDocxHouseStyle(outputPath, workDir, dateText, footerText, prepared.pngForSvg);
      return { data: await fs.readFile(outputPath), filename, mediaType, ...media };
    }

    // PDF: print the styled HTML with headless Chrome (present on nearly
    // every macOS setup); weasyprint stays as a fallback engine for pandoc.
    const outputPath = path.join(workDir, 'output.pdf');
    const chrome = await resolveChrome();
    if (chrome) {
      const htmlPath = path.join(workDir, 'print.html');
      await renderHtml(htmlPath);
      // Print-only pass: Amazon sizes + margin line numbers (see
      // buildPrintExtras). Injected before </body> so the numbering script
      // runs after the content it measures.
      const printHtml = await fs.readFile(htmlPath, 'utf8');
      const extras = buildPrintExtras();
      await fs.writeFile(
        htmlPath,
        printHtml.includes('</body>') ? printHtml.replace('</body>', `${extras}</body>`) : printHtml + extras,
        'utf8',
      );
      try {
        await execFileAsync(chrome, [
          '--headless',
          '--disable-gpu',
          '--no-first-run',
          `--user-data-dir=${path.join(workDir, 'chrome-profile')}`,
          '--no-pdf-header-footer',
          // Match the print content width so the line-number measurement
          // layout equals the printed layout (see buildPrintExtras).
          '--window-size=720,1000',
          '--force-device-scale-factor=1',
          `--print-to-pdf=${outputPath}`,
          `file://${htmlPath}`,
        ], { timeout: EXPORT_TIMEOUT_MS });
      } catch (error) {
        throw toolFailure('Chrome PDF printing', error);
      }
      return { data: await fs.readFile(outputPath), filename, mediaType, ...media };
    }

    const weasyprint = await resolveBinary('weasyprint');
    if (!weasyprint) {
      throw new DocumentExportError(
        'PDF export needs Google Chrome or weasyprint installed locally; neither was found.',
      );
    }
    await runPandoc([...baseArgs, `--pdf-engine=${weasyprint}`, `--include-in-header=${headerPath}`, '--output', outputPath, inputPath]);
    return { data: await fs.readFile(outputPath), filename, mediaType, ...media };
  } finally {
    await fs.rm(workDir, { recursive: true, force: true });
  }
}
