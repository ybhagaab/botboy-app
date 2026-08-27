/**
 * Surgical docx body editing (sharepoint-writes R4).
 *
 * A .docx is a zip; the body text lives in the `word/document.xml` entry as
 * paragraphs (`<w:p>`) of runs (`<w:r>`) holding text nodes (`<w:t>`). Word
 * routinely SPLITS visually contiguous text across many runs (spell-check
 * state, formatting boundaries, revision save points), so a naive string
 * replace on the XML misses most real passages. This module:
 *
 *   - concatenates each paragraph's run texts (entity-decoded) and finds the
 *     target passage across run boundaries;
 *   - requires the passage to match exactly ONCE document-wide — the
 *     unique-match rule doubles as the freshness guard (a stale quote from
 *     an edited document simply no longer matches);
 *   - splices the replacement into the FIRST matched run (inheriting its
 *     formatting) and blanks the matched remainder of the other runs;
 *   - rewrites ONLY the document.xml entry of the archive via the system
 *     `zip` binary (same system-binary convention as document-parser), so
 *     styles, embedded comments, images, and tracked changes survive
 *     byte-identical.
 *
 * Everything here is pure string/child-process work — no XML library, no new
 * dependencies. The transforms never touch anything outside `<w:t>` text
 * nodes and the pre-`sectPr` append point.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const execFileAsync = promisify(execFile);

// ── XML text helpers ────────────────────────────────────────────────────────

function decodeXml(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function encodeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// ── document.xml transforms (pure) ─────────────────────────────────────────

interface TextNode {
  /** Offset of the full <w:t…>…</w:t> element in the paragraph string. */
  start: number;
  end: number;
  /** Opening tag, e.g. `<w:t xml:space="preserve">`. */
  openTag: string;
  /** Decoded text content. */
  text: string;
}

function textNodesOf(paragraphXml: string): TextNode[] {
  const nodes: TextNode[] = [];
  const re = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(paragraphXml)) !== null) {
    const openEnd = paragraphXml.indexOf('>', match.index);
    nodes.push({
      start: match.index,
      end: match.index + match[0].length,
      openTag: paragraphXml.slice(match.index, openEnd + 1),
      text: decodeXml(match[1]),
    });
  }
  return nodes;
}

/** A modified text node always gets xml:space="preserve": splices routinely
 * produce leading/trailing spaces that Word would otherwise drop. */
function renderTextNode(node: TextNode, newText: string): string {
  const open = node.openTag.includes('xml:space')
    ? node.openTag
    : node.openTag.replace(/<w:t(\s|>)/, (_m, tail: string) => `<w:t xml:space="preserve"${tail === '>' ? '>' : tail}`);
  return `${open}${encodeXml(newText)}</w:t>`;
}

export interface ReplaceResult {
  status: 'replaced' | 'not_found' | 'ambiguous';
  xml?: string;
  occurrences: number;
}

/**
 * Replace one exact passage in the document body. The passage must lie
 * within a single paragraph (runs may split it arbitrarily) and match
 * exactly once across the whole document.
 */
export function replaceTextInDocumentXml(documentXml: string, findText: string, replaceWith: string): ReplaceResult {
  if (findText === '') return { status: 'not_found', occurrences: 0 };
  const paraRe = /<w:p\b[\s\S]*?<\/w:p>/g;
  interface Hit { paraStart: number; paraXml: string; matchIndex: number }
  let firstHit: Hit | null = null;
  let occurrences = 0;
  let para: RegExpExecArray | null;
  while ((para = paraRe.exec(documentXml)) !== null && occurrences <= 1) {
    const joined = textNodesOf(para[0]).map(n => n.text).join('');
    let from = 0;
    for (;;) {
      const at = joined.indexOf(findText, from);
      if (at === -1) break;
      occurrences++;
      if (occurrences === 1) {
        firstHit = { paraStart: para.index, paraXml: para[0], matchIndex: at };
      } else {
        break; // two is already too many — no need to keep counting
      }
      from = at + findText.length;
    }
  }
  if (occurrences === 0 || firstHit === null) return { status: 'not_found', occurrences: 0 };
  if (occurrences > 1) return { status: 'ambiguous', occurrences };

  const hit = firstHit;
  const nodes = textNodesOf(hit.paraXml);
  const matchStart = hit.matchIndex;
  const matchEnd = matchStart + findText.length;

  // Splice across the runs: first overlapping node carries prefix +
  // replacement (+ suffix when the match ends in the same node); later
  // overlapping nodes keep only their post-match tail.
  let cursor = 0;
  let replaced = false;
  const pieces: Array<{ node: TextNode; newText: string }> = [];
  for (const node of nodes) {
    const nodeStart = cursor;
    const nodeEnd = cursor + node.text.length;
    cursor = nodeEnd;
    if (nodeEnd <= matchStart || nodeStart >= matchEnd) continue; // untouched
    const localStart = Math.max(0, matchStart - nodeStart);
    const localEnd = Math.min(node.text.length, matchEnd - nodeStart);
    let newText = node.text.slice(0, localStart) + (replaced ? '' : replaceWith) + node.text.slice(localEnd);
    replaced = true;
    pieces.push({ node, newText });
  }

  let rebuilt = '';
  let last = 0;
  for (const piece of pieces) {
    rebuilt += hit.paraXml.slice(last, piece.node.start) + renderTextNode(piece.node, piece.newText);
    last = piece.node.end;
  }
  rebuilt += hit.paraXml.slice(last);

  const xml = documentXml.slice(0, hit.paraStart) + rebuilt + documentXml.slice(hit.paraStart + hit.paraXml.length);
  return { status: 'replaced', xml, occurrences: 1 };
}

export interface ReplaceRangeResult {
  status: 'replaced' | 'not_found' | 'ambiguous' | 'in_table';
  xml?: string;
  occurrences: number;
}

/** Squashed paragraph text, matching document-parser › docxParagraphText
 * (w:t text; tabs and breaks count as spaces; whitespace squashed). Anchors
 * derived from extracted markdown compare against exactly this form. */
function paragraphSquashedText(paragraphXml: string): string {
  const pieces: string[] = [];
  for (const m of paragraphXml.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\/>|<w:br\/>/g)) {
    pieces.push(m[1] !== undefined ? decodeXml(m[1]) : ' ');
  }
  return pieces.join('').replace(/\s+/g, ' ').trim();
}

/** Outer <w:tbl> spans via depth scan (tables nest inside cells) — mirrors
 * document-parser › docxTableRanges. Paragraphs inside these spans are
 * invisible to the parser's markdown, so range anchors must not bind them. */
function tableRangesOf(documentXml: string): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  let depth = 0;
  let start = -1;
  for (const m of documentXml.matchAll(/<w:tbl(?=[\s>])|<\/w:tbl>/g)) {
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

/**
 * Replace a CONTIGUOUS run of paragraphs (matched by their squashed text, in
 * order) with pre-built paragraph XML blocks (doc editor E1). Empty
 * `replacementBlocksXml` deletes the run. Matching skips text-empty spacer
 * paragraphs (the parser never emitted them into the markdown the anchors
 * came from); spacers INSIDE the matched span are replaced with it. The
 * anchor sequence must match exactly once among non-table paragraphs;
 * a sequence that exists only inside a table reports `in_table` (splicing
 * table internals would corrupt the package).
 */
/**
 * Anchor comparison normalization: leading list markers are AMBIGUOUS across
 * markdown dialects — the local parser INJECTS "1. "/"- " for real Word
 * lists (marker NOT in w:t text), while BotBoy-built docs carry literal
 * "1. "/"• " IN the text (and the MCP converter escapes them as "1\\.").
 * Stripping the marker from BOTH sides makes every dialect meet in the
 * middle; sequence matching + the exactly-once rule keep it safe.
 */
function anchorComparableText(value: string): string {
  return value.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, '').replace(/\s+/g, ' ').trim();
}

export function replaceParagraphRangeInDocumentXml(
  documentXml: string,
  anchorParagraphs: string[],
  replacementBlocksXml: string[],
): ReplaceRangeResult {
  const anchors = anchorParagraphs.map(a => anchorComparableText(String(a))).filter(a => a.length > 0);
  if (anchors.length === 0) return { status: 'not_found', occurrences: 0 };

  const tables = tableRangesOf(documentXml);
  const inTable = (offset: number) => tables.some(range => offset >= range.start && offset < range.end);

  interface Para { start: number; end: number; text: string; table: boolean }
  const paras: Para[] = [];
  for (const m of documentXml.matchAll(/<w:p\b[\s\S]*?<\/w:p>/g)) {
    const text = anchorComparableText(paragraphSquashedText(m[0]));
    if (!text) continue; // parser-invisible spacers never anchor
    paras.push({ start: m.index!, end: m.index! + m[0].length, text, table: inTable(m.index!) });
  }

  const matchesAt = (list: Para[], from: number): boolean =>
    anchors.every((anchor, i) => list[from + i] && list[from + i].text === anchor);

  const bodyParas = paras.filter(p => !p.table);
  const hits: Array<{ first: Para; last: Para }> = [];
  for (let i = 0; i + anchors.length <= bodyParas.length; i++) {
    if (matchesAt(bodyParas, i)) hits.push({ first: bodyParas[i], last: bodyParas[i + anchors.length - 1] });
  }
  if (hits.length === 0) {
    // Distinguish "moved/changed" from "only lives inside a table".
    for (let i = 0; i + anchors.length <= paras.length; i++) {
      if (matchesAt(paras, i)) return { status: 'in_table', occurrences: 1 };
    }
    return { status: 'not_found', occurrences: 0 };
  }
  if (hits.length > 1) return { status: 'ambiguous', occurrences: hits.length };

  const hit = hits[0];
  // Guard: the span between first and last must not cross INTO a table
  // (anchors matched outside tables, but a table could sit between them —
  // that means the anchors were not truly contiguous in the document).
  if (tables.some(range => range.start >= hit.first.end && range.end <= hit.last.start)) {
    return { status: 'not_found', occurrences: 0 };
  }
  const xml = documentXml.slice(0, hit.first.start)
    + replacementBlocksXml.join('')
    + documentXml.slice(hit.last.end);
  return { status: 'replaced', xml, occurrences: 1 };
}

/**
 * Extract each comment's anchored passage from the document body. Word
 * marks comment ranges with <w:commentRangeStart w:id="N"/> …
 * <w:commentRangeEnd w:id="N"/>; the text between them (possibly spanning
 * paragraphs and split runs) is what the comment is ABOUT. Reader UX
 * (workbench soak find 2026-08-25): comments need their passage so they can
 * link back to the document text. Ranges may nest/overlap — each id is
 * tracked independently. Anchors are capped and whitespace-squashed.
 */
export function extractCommentAnchors(documentXml: string, maxChars = 160): Map<string, string> {
  const anchors = new Map<string, string>();
  const open = new Map<string, string[]>(); // id → collected text pieces
  // Tokenize the elements we care about, in document order. Paragraph and
  // table-cell closes become spaces so multi-block anchors stay readable and
  // matchable against rendered text ("Tenets Requirement", not
  // "TenetsRequirement").
  const re = /<w:commentRangeStart[^>]*w:id="(\d+)"[^>]*\/>|<w:commentRangeEnd[^>]*w:id="(\d+)"[^>]*\/>|<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<\/w:p>|<\/w:tc>/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(documentXml)) !== null) {
    if (match[1] !== undefined) {
      open.set(match[1], []);
    } else if (match[2] !== undefined) {
      const pieces = open.get(match[2]);
      if (pieces) {
        const text = decodeXml(pieces.join('')).replace(/\s+/g, ' ').trim();
        if (text) anchors.set(match[2], text.length > maxChars ? `${text.slice(0, maxChars)}…` : text);
        open.delete(match[2]);
      }
    } else if (match[3] !== undefined && open.size > 0) {
      for (const pieces of open.values()) pieces.push(match[3]);
    } else if (match[3] === undefined && open.size > 0) {
      // Block boundary (</w:p> or </w:tc>) inside an open range.
      for (const pieces of open.values()) pieces.push(' ');
    }
  }
  return anchors;
}

export interface TrackedChange {
  kind: 'insertion' | 'deletion';
  author: string;
  /** ISO date when parseable and not Word's 1900 placeholder. */
  date?: string;
  text: string;
}

/**
 * Extract UNACCEPTED tracked changes (Word suggestions) from document.xml:
 * `<w:ins>` insertions and `<w:del>` deletions, author/date-attributed.
 * Converters render inserted text as if it were final body content (soak
 * find 2026-08-25: a suggested Tenet rewrite read as the actual document),
 * so these are the honest "this text is only proposed" record. Adjacent
 * runs by the same author within one revision id burst stay separate
 * entries; text capped per entry.
 */
export function extractTrackedChanges(documentXml: string, maxChars = 400): TrackedChange[] {
  const changes: TrackedChange[] = [];
  const collect = (regex: RegExp, kind: TrackedChange['kind'], textPattern: RegExp) => {
    let match: RegExpExecArray | null;
    while ((match = regex.exec(documentXml)) !== null) {
      const attrs = match[1];
      const inner = match[2];
      const author = decodeXml(/w:author="([^"]*)"/.exec(attrs)?.[1] ?? 'unknown');
      const rawDate = /w:date="([^"]*)"/.exec(attrs)?.[1];
      const parsed = rawDate ? Date.parse(rawDate) : NaN;
      const date = Number.isFinite(parsed) && parsed >= 0 ? new Date(rawDate!).toISOString() : undefined;
      const pieces: string[] = [];
      let tm: RegExpExecArray | null;
      const tRe = new RegExp(textPattern.source, 'g');
      while ((tm = tRe.exec(inner)) !== null) pieces.push(tm[1]);
      const text = decodeXml(pieces.join('')).replace(/\s+/g, ' ').trim();
      if (!text) continue;
      changes.push({ kind, author, date, text: text.length > maxChars ? `${text.slice(0, maxChars)}…` : text });
    }
  };
  // Insertions carry normal <w:t>; deletions keep removed text in <w:delText>.
  collect(/<w:ins\b([^>]*)>([\s\S]*?)<\/w:ins>/g, 'insertion', /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/);
  collect(/<w:del\b([^>]*)>([\s\S]*?)<\/w:del>/g, 'deletion', /<w:delText(?:\s[^>]*)?>([\s\S]*?)<\/w:delText>/);
  return changes;
}

/**
 * Append plain paragraphs at the end of the body (before the trailing
 * sectPr when present — Word keeps section properties as the body's last
 * child and content inserted after it is ignored).
 */
export function appendParagraphsToDocumentXml(documentXml: string, paragraphs: string[]): string {
  const blocks = paragraphs
    .map(p => `<w:p><w:r><w:t xml:space="preserve">${encodeXml(p)}</w:t></w:r></w:p>`)
    .join('');
  const sectPr = documentXml.lastIndexOf('<w:sectPr');
  const bodyEnd = documentXml.lastIndexOf('</w:body>');
  if (bodyEnd === -1) throw new Error('document.xml has no </w:body> — not a Word document body');
  const insertAt = sectPr !== -1 && sectPr < bodyEnd ? sectPr : bodyEnd;
  return documentXml.slice(0, insertAt) + blocks + documentXml.slice(insertAt);
}

// ── zip plumbing (system binaries, like document-parser) ────────────────────

export async function readZipEntry(zipPath: string, entryName: string): Promise<string> {
  const { stdout } = await execFileAsync('unzip', ['-p', zipPath, entryName], {
    maxBuffer: 64 * 1024 * 1024,
    encoding: 'buffer' as never,
  }) as unknown as { stdout: Buffer };
  return stdout.toString('utf8');
}

/**
 * Replace exactly one entry inside a zip archive in place. Every other entry
 * is untouched (the `zip` CLI updates the named member only) — this is what
 * keeps comments/styles/media byte-identical through a body edit.
 */
export async function replaceZipEntry(zipPath: string, entryName: string, content: string): Promise<void> {
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'docx-edit-'));
  try {
    const target = path.join(staging, entryName);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, 'utf8');
    await execFileAsync('zip', ['-X', '-q', path.resolve(zipPath), entryName], { cwd: staging });
  } finally {
    try { fs.rmSync(staging, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

export const DOCUMENT_XML_ENTRY = 'word/document.xml';

// ── Shared apply core (document-workbench R3.5) ─────────────────────────────
// One download → all edits applied sequentially against the SAME working
// copy → ONE upload (SharePoint has no section-update API; per-edit uploads
// would mean N version-history entries and race windows) → read-back verify.
// Used by BOTH the chat guided tool (direct mode) and the reader's Sync.

import type { McpManager } from './mcp-types.js';
import { markdownLineToDocxText } from './markdown-anchor.js';

/**
 * Map a SharePoint server-relative URL onto sharepoint_write_file's
 * library-title addressing (URL path "Shared Documents" = library TITLE
 * "Documents"; the personal OneDrive library is titled "Documents").
 * Team-site paths need the caller-provided siteUrl. Returns an Error string
 * for unsupported shapes.
 */
export function mapSharePointWriteTarget(serverRelativeUrl: string, siteUrlArg: unknown):
  | { personal: boolean; folderPath: string; fileName: string; siteUrl: Record<string, string> }
  | string {
  const segments = serverRelativeUrl.split('/').filter(Boolean);
  const fileName = segments[segments.length - 1] ?? '';
  if (segments[0] === 'personal' && segments[2] === 'Documents') {
    return { personal: true, folderPath: segments.slice(3, -1).join('/'), fileName, siteUrl: {} };
  }
  if (segments[0] === 'sites' && (segments[2] === 'Shared Documents' || segments[2] === 'Documents')) {
    const site = typeof siteUrlArg === 'string' ? siteUrlArg.trim() : '';
    if (!site) return 'Error: siteUrl is required for team-site documents';
    return { personal: false, folderPath: segments.slice(3, -1).join('/'), fileName, siteUrl: { siteUrl: site } };
  }
  return 'Error: unsupported document path — guided writes cover personal OneDrive Documents and team-site Shared Documents';
}

// ── Markdown → docx builder (authoring-bridge A2) ───────────────────────────

/**
 * Build a minimal, valid .docx from markdown. Deliberately small surface
 * (recorded design decisions, spec `.kiro/specs/document-authoring-bridge/`):
 *   - headings #/##/### → sized bold paragraphs (direct formatting — no
 *     styles.xml plumbing v1; Word renders and edits these fine);
 *   - paragraphs with **bold** and *italic* inline runs;
 *   - lists render as literal "• " / "N. " prefixed paragraphs (no
 *     numbering.xml v1 — visually correct, structurally plain);
 *   - tables degrade to plain text rows; images are rejected UPSTREAM at
 *     staging (pending-edits validation).
 * Returns the path of the built file inside a fresh temp dir; the caller
 * owns cleanup of the returned directory.
 */
export async function buildDocxFromMarkdown(markdown: string): Promise<{ filePath: string; tempDir: string }> {
  const paragraphs = markdownToDocxParagraphs(markdown);
  const documentXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
    + `<w:body>${paragraphs.join('')}<w:sectPr/></w:body></w:document>`;

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ppt-docx-build-'));
  const src = path.join(tempDir, 'src');
  fs.mkdirSync(path.join(src, '_rels'), { recursive: true });
  fs.mkdirSync(path.join(src, 'word'), { recursive: true });
  fs.writeFileSync(path.join(src, '[Content_Types].xml'),
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    + '<Default Extension="xml" ContentType="application/xml"/>'
    + '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
    + '</Types>');
  fs.writeFileSync(path.join(src, '_rels', '.rels'),
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
    + '</Relationships>');
  fs.writeFileSync(path.join(src, 'word', 'document.xml'), documentXml);

  const filePath = path.join(tempDir, 'built.docx');
  await execFileAsync('zip', ['-X', '-q', '-r', filePath, '.'], { cwd: src });
  return { filePath, tempDir };
}

/** One markdown block → OOXML paragraph(s). Exported for direct testing. */
export function markdownToDocxParagraphs(markdown: string): string[] {
  const out: string[] = [];
  const paragraph = (runs: string, headingSize?: number) =>
    `<w:p>${headingSize ? `<w:pPr><w:spacing w:before="240" w:after="120"/></w:pPr>` : ''}${runs}</w:p>`;
  // Inline markdown → runs: **bold**, *italic*, plain. Escape-first.
  const inlineRuns = (text: string, opts: { bold?: boolean; size?: number } = {}): string => {
    const props = (bold: boolean, italic: boolean) => {
      const bits = [
        (bold || opts.bold) ? '<w:b/>' : '',
        italic ? '<w:i/>' : '',
        opts.size ? `<w:sz w:val="${opts.size}"/><w:szCs w:val="${opts.size}"/>` : '',
      ].join('');
      return bits ? `<w:rPr>${bits}</w:rPr>` : '';
    };
    const run = (value: string, bold = false, italic = false) =>
      value ? `<w:r>${props(bold, italic)}<w:t xml:space="preserve">${encodeXml(value)}</w:t></w:r>` : '';
    const runs: string[] = [];
    // Tokenize bold first, then italic within the remainder.
    const boldSplit = text.split(/(\*\*[^*]+\*\*)/g);
    for (const piece of boldSplit) {
      const boldMatch = /^\*\*([^*]+)\*\*$/.exec(piece);
      if (boldMatch) { runs.push(run(boldMatch[1], true)); continue; }
      for (const sub of piece.split(/(\*[^*]+\*)/g)) {
        const italicMatch = /^\*([^*]+)\*$/.exec(sub);
        if (italicMatch) runs.push(run(italicMatch[1], false, true));
        else runs.push(run(sub));
      }
    }
    return runs.join('') || run(' ');
  };

  // Block pass: split on blank lines, then classify each block line-wise.
  for (const block of markdown.replace(/\r\n/g, '\n').split(/\n{2,}/)) {
    const lines = block.split('\n').map(l => l.trimEnd()).filter(l => l.trim() !== '');
    if (lines.length === 0) continue;
    let pendingPlain: string[] = [];
    const flushPlain = () => {
      if (pendingPlain.length === 0) return;
      out.push(paragraph(inlineRuns(pendingPlain.join(' '))));
      pendingPlain = [];
    };
    for (const line of lines) {
      const heading = /^(#{1,3})\s+(.*)$/.exec(line);
      const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
      const ordered = /^\s*(\d+)[.)]\s+(.*)$/.exec(line);
      const tableRow = /^\s*\|(.+)\|\s*$/.exec(line);
      if (heading) {
        flushPlain();
        const size = heading[1].length === 1 ? 40 : heading[1].length === 2 ? 32 : 26; // half-points
        out.push(paragraph(inlineRuns(heading[2], { bold: true, size }), size));
      } else if (bullet) {
        flushPlain();
        out.push(paragraph(inlineRuns(`• ${bullet[1]}`)));
      } else if (ordered) {
        flushPlain();
        out.push(paragraph(inlineRuns(`${ordered[1]}. ${ordered[2]}`)));
      } else if (tableRow) {
        // Tables degrade to plain rows (recorded v1 limitation); separator
        // rows (|---|---|) drop entirely.
        flushPlain();
        const cells = tableRow[1].split('|').map(c => c.trim());
        if (!cells.every(c => /^:?-{2,}:?$/.test(c))) {
          out.push(paragraph(inlineRuns(cells.join(' — '))));
        }
      } else {
        pendingPlain.push(line.trim());
      }
    }
    flushPlain();
  }
  return out.length ? out : ['<w:p><w:r><w:t xml:space="preserve"> </w:t></w:r></w:p>'];
}

export interface DocxBodyEdit {
  id: string;
  operation: 'replaceText' | 'appendParagraphs' | 'replaceParagraphRange';
  findText?: string | null;
  replaceWith?: string | null;
  /** appendParagraphs: plain paragraph texts. replaceParagraphRange: docx-text anchors (one per paragraph). */
  paragraphs?: string[] | null;
}

export interface ApplyDocxBodyEditsResult {
  /** False when nothing applied (all edits conflicted) or download failed. */
  uploaded: boolean;
  verifiedOnReadBack: boolean;
  perEdit: Array<{ id: string; applied: boolean; reason?: string }>;
  uploadResultText?: string;
  /** Download/upload-level failure — perEdit is untouched when set. */
  error?: string;
}

export async function applyDocxBodyEdits(
  mcpManager: McpManager,
  target: { serverRelativeUrl: string; siteUrl?: string | null },
  edits: DocxBodyEdit[],
): Promise<ApplyDocxBodyEditsResult> {
  const mapped = mapSharePointWriteTarget(target.serverRelativeUrl, target.siteUrl ?? undefined);
  if (typeof mapped === 'string') return { uploaded: false, verifiedOnReadBack: false, perEdit: [], error: mapped };
  const { personal, folderPath, fileName, siteUrl } = mapped;

  const stagingDir = path.join(os.homedir(), '.personal-productivity-tracker', 'tmp');
  fs.mkdirSync(stagingDir, { recursive: true });
  const staged = path.join(stagingDir, `docx-edit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.docx`);
  try {
    // 1. Fresh download — never a cached copy.
    const download = await mcpManager.callTool('sharepoint', 'sharepoint_read_file',
      { serverRelativeUrl: target.serverRelativeUrl, ...siteUrl, ...(personal ? {} : { personal: false }), savePath: staged },
      { source: 'agent', timeoutMs: 120_000 });
    if (download.isError) return { uploaded: false, verifiedOnReadBack: false, perEdit: [], error: `could not download the current document (${download.text.slice(0, 200)})` };
    if (!fs.existsSync(staged)) return { uploaded: false, verifiedOnReadBack: false, perEdit: [], error: 'download reported success but produced no file' };

    // 2. Apply sequentially against ONE working copy. Later edits see earlier
    //    ones — two approved edits to the same paragraph compose instead of
    //    conflicting on stale text.
    let xml = await readZipEntry(staged, DOCUMENT_XML_ENTRY);
    const perEdit: ApplyDocxBodyEditsResult['perEdit'] = [];
    const probes: string[] = [];
    for (const edit of edits) {
      if (edit.operation === 'replaceText') {
        const findText = String(edit.findText ?? '');
        const replaceWith = String(edit.replaceWith ?? '');
        const result = replaceTextInDocumentXml(xml, findText, replaceWith);
        if (result.status === 'replaced') {
          xml = result.xml!;
          probes.push(replaceWith);
          perEdit.push({ id: edit.id, applied: true });
        } else if (result.status === 'ambiguous') {
          perEdit.push({ id: edit.id, applied: false, reason: `passage matches ${result.occurrences} places — add surrounding text to make it unique` });
        } else {
          perEdit.push({ id: edit.id, applied: false, reason: 'passage not found in the current document — it changed since this edit was written; re-create the edit from current text' });
        }
      } else if (edit.operation === 'replaceParagraphRange') {
        const anchors = (edit.paragraphs ?? []).map(a => String(a)).filter(a => a.trim());
        if (anchors.length === 0) {
          perEdit.push({ id: edit.id, applied: false, reason: 'no anchor paragraphs for the range' });
          continue;
        }
        const replacementMarkdown = String(edit.replaceWith ?? '');
        const blocks = replacementMarkdown.trim() ? markdownToDocxParagraphs(replacementMarkdown) : [];
        const result = replaceParagraphRangeInDocumentXml(xml, anchors, blocks);
        if (result.status === 'replaced') {
          xml = result.xml!;
          // Read-back probe: the longest replacement line in docx-text form
          // (read-back is converter markdown; block markers may differ, so
          // probe the marker-stripped text — same form the converter's text
          // carries). Deletions probe nothing (same as empty-probe skip).
          const probe = replacementMarkdown.trim()
            ? replacementMarkdown.split('\n').map(markdownLineToDocxText).reduce((a, b) => (b.length > a.length ? b : a), '')
            : '';
          if (probe) probes.push(probe);
          perEdit.push({ id: edit.id, applied: true });
        } else if (result.status === 'ambiguous') {
          perEdit.push({ id: edit.id, applied: false, reason: `the paragraph run matches ${result.occurrences} places — extend the range to make it unique` });
        } else if (result.status === 'in_table') {
          perEdit.push({ id: edit.id, applied: false, reason: "the passage is inside a table — table edits aren't supported yet" });
        } else {
          perEdit.push({ id: edit.id, applied: false, reason: 'the paragraph run was not found in the current document — it changed since this edit was written; re-create the edit from current text' });
        }
      } else {
        const paragraphs = (edit.paragraphs ?? []).filter(p => p.trim());
        if (paragraphs.length === 0) {
          perEdit.push({ id: edit.id, applied: false, reason: 'no paragraphs to append' });
          continue;
        }
        xml = appendParagraphsToDocumentXml(xml, paragraphs);
        probes.push(paragraphs[paragraphs.length - 1]);
        perEdit.push({ id: edit.id, applied: true });
      }
    }

    if (!perEdit.some(entry => entry.applied)) {
      return { uploaded: false, verifiedOnReadBack: false, perEdit };
    }

    // 3. One upload under the guided waiver.
    await replaceZipEntry(staged, DOCUMENT_XML_ENTRY, xml);
    const upload = await mcpManager.callTool('sharepoint', 'sharepoint_write_file',
      {
        libraryName: 'Documents',
        fileName,
        sourcePath: staged,
        ...(folderPath ? { folderPath } : {}),
        ...(personal ? {} : { personal: false }),
        ...siteUrl,
        includeWebUrl: true,
      },
      { source: 'agent', timeoutMs: 120_000, ownerApproved: true, guidedFlow: true });
    if (upload.isError) {
      return { uploaded: false, verifiedOnReadBack: false, perEdit, error: `edited locally but the upload failed (${upload.text.slice(0, 200)}); the document on SharePoint is unchanged` };
    }

    // 4. Read back: EVERY applied probe must be visible.
    const readBack = await mcpManager.callTool('sharepoint', 'sharepoint_read_file',
      { serverRelativeUrl: target.serverRelativeUrl, ...siteUrl, ...(personal ? {} : { personal: false }), inline: true, format: 'markdown', stripImages: true },
      { source: 'agent', timeoutMs: 120_000 });
    const squash = (value: string) => value.replace(/\s+/g, ' ').trim();
    const verified = !readBack.isError && probes.every(probe => probe.trim() === '' || squash(readBack.text).includes(squash(probe)));

    return { uploaded: true, verifiedOnReadBack: verified, perEdit, uploadResultText: upload.text.slice(0, 2_000) };
  } finally {
    try { fs.unlinkSync(staged); } catch { /* best effort */ }
  }
}
