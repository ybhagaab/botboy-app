/**
 * Deterministic edits of a guide's table rows and File TOC Summaries (knowledge-library.md K15). When a write adds, moves
 * or archives a file, or refreshes what a file says, the SERVER splices the guide, in the same diff and the same History
 * entry as the change that caused it: no model rewrites a guide to keep a table current.
 *
 * Every function is a text splice of the one changed section: every other byte of the guide, including the owner's hand
 * edits, survives (line endings and a leading BOM are kept as found). None of them touches the Change Methodology, the
 * Guardrails or the Conflict Priority Order, so `rulesDigest` is the same before and after (a test pins it). Pure.
 *
 * A row or a TOC heading belongs to a file by the file's name RELATIVE TO THE SET, never by its base name alone: every
 * function takes the set's file names (`names`; the file being created or moved to is counted too) and a bare name stands
 * for a file only when no other file of the set has that base name (`knowledge-guide.ts › indexFileNames`, P2 review R31).
 */
import {
  HEADING_RE, columnIndexes, fileNamesWith, indexFileNames, isSeparatorRow, plainText, sectionOf, splitRow,
  type FileNameIndex, type SectionName,
} from './knowledge-guide.js';

interface Doc { bom: string; eol: string; lines: string[]; endsWithNewline: boolean }

function openDoc(text: string): Doc {
  const bom = text.startsWith('\uFEFF') ? '\uFEFF' : '';
  const body = bom ? text.slice(1) : text;
  const crlf = (body.match(/\r\n/g) ?? []).length;
  const lf = (body.match(/(?<!\r)\n/g) ?? []).length;
  const eol = crlf > lf ? '\r\n' : '\n';
  const normalized = body.replace(/\r\n?/g, '\n');
  const endsWithNewline = normalized.endsWith('\n');
  const lines = normalized.split('\n');
  if (endsWithNewline) lines.pop();
  return { bom, eol, lines, endsWithNewline };
}

function closeDoc(doc: Doc): string {
  return doc.bom + doc.lines.join(doc.eol) + (doc.endsWithNewline || doc.lines.length === 0 ? doc.eol : '');
}

interface Heading { index: number; level: number; text: string }

function headingsOf(lines: string[]): Heading[] {
  const found: Heading[] = [];
  let inFence = false;
  lines.forEach((line, index) => {
    if (/^\s*(```|~~~)/.test(line)) { inFence = !inFence; return; }
    if (inFence) return;
    const match = HEADING_RE.exec(line);
    if (match) found.push({ index, level: match[1].length, text: match[2] });
  });
  return found;
}

/** The first section named `name`: its heading, and the [start, end) lines of its body (to the next heading of the same or a higher level). */
function sectionRange(lines: string[], name: SectionName): { heading: Heading; start: number; end: number } | null {
  const headings = headingsOf(lines);
  for (let order = 0; order < headings.length; order += 1) {
    const heading = headings[order];
    if (sectionOf(heading.text) !== name) continue;
    let end = lines.length;
    for (let next = order + 1; next < headings.length; next += 1) {
      if (headings[next].level <= heading.level) { end = headings[next].index; break; }
    }
    return { heading, start: heading.index + 1, end };
  }
  return null;
}

interface TableAt { header: number; separator: number; rows: number[]; headerCells: string[] }

function tableIn(lines: string[], from: number, to: number, wantFileColumn: boolean): TableAt | null {
  for (let index = from; index < to - 1; index += 1) {
    if (!lines[index].trim().startsWith('|')) continue;
    if (!lines[index + 1].trim().startsWith('|') || !isSeparatorRow(splitRow(lines[index + 1]))) continue;
    const headerCells = splitRow(lines[index]).map((cell) => plainText(cell).toLowerCase());
    if (wantFileColumn && (headerCells.includes('folder') || columnIndexes(headerCells).file === undefined)) { index += 1; continue; }
    const rows: number[] = [];
    let cursor = index + 2;
    while (cursor < to && lines[cursor].trim().startsWith('|')) { rows.push(cursor); cursor += 1; }
    return { header: index, separator: index + 1, rows, headerCells };
  }
  return null;
}

const STANDARD_HEADER = ['File', 'Path', 'Loading Mechanism', 'Purpose', 'Audience'];

function cellText(value: string): string {
  return String(value ?? '').replace(/\r?\n+/g, ' ').replace(/\|/g, '\\|').trim();
}

export interface RowSpec { file: string; path?: string; mechanism?: string; purpose: string; audience?: string }

const lc = (value: string) => value.toLowerCase();
const indexFor = (names: readonly string[] | undefined, file: string): FileNameIndex => indexFileNames(fileNamesWith(names, file));

function fileTable(doc: Doc): { table: TableAt; within: 'section' | 'anywhere' } | null {
  const section = sectionRange(doc.lines, 'ecosystem');
  if (section) {
    const table = tableIn(doc.lines, section.start, section.end, false);
    if (table) return { table, within: 'section' };
  }
  const anywhere = tableIn(doc.lines, 0, doc.lines.length, true);
  return anywhere ? { table: anywhere, within: 'anywhere' } : null;
}

function rowMatches(line: string, table: TableAt, file: string, index: FileNameIndex): boolean {
  const columns = columnIndexes(table.headerCells);
  const cells = splitRow(line);
  const written = plainText(cells[columns.file ?? 0] ?? '');
  const rowPath = columns.path === undefined ? '' : plainText(cells[columns.path] ?? '');
  return index.names(written, rowPath, file);
}

function formatRow(table: TableAt, spec: RowSpec, backticks: boolean): string {
  const columns = columnIndexes(table.headerCells);
  const cells = table.headerCells.map(() => '');
  const put = (key: 'file' | 'path' | 'mechanism' | 'purpose' | 'audience', value: string) => {
    const at = columns[key];
    if (at !== undefined) cells[at] = value;
  };
  if (columns.file === undefined) cells[0] = backticks ? `\`${spec.file}\`` : spec.file;
  put('file', backticks ? `\`${cellText(spec.file)}\`` : cellText(spec.file));
  put('path', cellText(spec.path ?? ''));
  put('mechanism', cellText(spec.mechanism ?? 'On demand'));
  put('purpose', cellText(spec.purpose));
  put('audience', cellText(spec.audience ?? ''));
  return `| ${cells.join(' | ')} |`;
}

function usesBackticks(doc: Doc, table: TableAt): boolean {
  const first = table.rows[0];
  if (first === undefined) return true;
  const at = columnIndexes(table.headerCells).file ?? 0;
  return (splitRow(doc.lines[first])[at] ?? '').trim().startsWith('`');
}

function ensureEcosystemSection(doc: Doc): TableAt {
  const methodology = sectionRange(doc.lines, 'methodology');
  const insertAt = methodology ? methodology.heading.index : doc.lines.length;
  const block = ['## File Ecosystem', '', `| ${STANDARD_HEADER.join(' | ')} |`, `| ${STANDARD_HEADER.map(() => '---').join(' | ')} |`, ''];
  const padded = insertAt > 0 && doc.lines[insertAt - 1].trim() !== '' ? ['', ...block] : block;
  doc.lines.splice(insertAt, 0, ...padded);
  const table = fileTable(doc);
  if (!table) throw new Error('the new file table could not be read back');
  return table.table;
}

/** Add the row for `spec.file`, or replace the cells of the row that is already there. */
export function upsertFileRow(guideText: string, spec: RowSpec, names?: readonly string[]): string {
  const doc = openDoc(guideText);
  const index = indexFor(names, spec.file);
  let found = fileTable(doc);
  const table = found?.table ?? ensureEcosystemSection(doc);
  if (!found) found = { table, within: 'section' };
  const backticks = usesBackticks(doc, table);
  const existing = table.rows.find((line) => rowMatches(doc.lines[line], table, spec.file, index));
  const text = formatRow(table, spec, backticks);
  if (existing !== undefined) doc.lines[existing] = text;
  else {
    const after = table.rows.length > 0 ? table.rows[table.rows.length - 1] : table.separator;
    doc.lines.splice(after + 1, 0, text);
  }
  return closeDoc(doc);
}

/** Remove the row for `file` (no row: the text is returned as it was). */
export function removeFileRow(guideText: string, file: string, names?: readonly string[]): string {
  const doc = openDoc(guideText);
  const found = fileTable(doc);
  if (!found) return guideText;
  const index = indexFor(names, file);
  const at = found.table.rows.find((line) => rowMatches(doc.lines[line], found.table, file, index));
  if (at === undefined) return guideText;
  doc.lines.splice(at, 1);
  return closeDoc(doc);
}

/** Point the row of `from` at `to` (a new File cell and, when given, a new Path cell). */
export function renameFileRow(guideText: string, from: string, to: string, newPath?: string, names?: readonly string[]): string {
  const doc = openDoc(guideText);
  const found = fileTable(doc);
  if (!found) return guideText;
  const index = indexFor(names, from);
  const at = found.table.rows.find((line) => rowMatches(doc.lines[line], found.table, from, index));
  if (at === undefined) return guideText;
  const columns = columnIndexes(found.table.headerCells);
  const cells = splitRow(doc.lines[at]);
  const fileAt = columns.file ?? 0;
  const backticks = (cells[fileAt] ?? '').trim().startsWith('`');
  cells[fileAt] = backticks ? `\`${cellText(to)}\`` : cellText(to);
  if (newPath !== undefined && columns.path !== undefined) cells[columns.path] = cellText(newPath);
  doc.lines[at] = `| ${cells.join(' | ')} |`;
  return closeDoc(doc);
}

// ── File TOC Summaries ─────────────────────────────────────────────────────

interface TocAt { section: { heading: Heading; start: number; end: number }; sub: { heading: Heading; start: number; end: number } | null }

function tocFor(doc: Doc, file: string, index: FileNameIndex): TocAt | null {
  const section = sectionRange(doc.lines, 'toc');
  if (!section) return null;
  const headings = headingsOf(doc.lines).filter((heading) => heading.index >= section.start && heading.index < section.end && heading.level > section.heading.level);
  for (let order = 0; order < headings.length; order += 1) {
    const heading = headings[order];
    if (!index.names(plainText(heading.text), '', file)) continue;
    let end = section.end;
    for (let next = order + 1; next < headings.length; next += 1) {
      if (headings[next].level <= heading.level) { end = headings[next].index; break; }
    }
    return { section, sub: { heading, start: heading.index + 1, end } };
  }
  return { section, sub: null };
}

const bulletLine = (bullet: string) => `- ${String(bullet).replace(/\r?\n+/g, ' ').trim()}`;

/** Make the TOC summary of `file` say exactly `bullets` (at most 6 bullets of 160 characters): replace its sub-section, add one, or create the section. */
export function setTocSection(guideText: string, file: string, bullets: readonly string[], names?: readonly string[]): string {
  const clean = bullets.map((bullet) => String(bullet).replace(/\s+/g, ' ').trim().slice(0, 160)).filter(Boolean).slice(0, 6);
  const doc = openDoc(guideText);
  const found = tocFor(doc, file, indexFor(names, file));
  const body = clean.map(bulletLine);
  if (!found) {
    const tail = doc.lines.length > 0 && doc.lines[doc.lines.length - 1].trim() !== '' ? [''] : [];
    doc.lines.push(...tail, '## File TOC Summaries', '', `### ${file}`, ...body);
    doc.endsWithNewline = true;
    return closeDoc(doc);
  }
  if (found.sub) {
    const trailingBlank = found.sub.end > found.sub.start && doc.lines[found.sub.end - 1].trim() === '' ? [''] : [];
    doc.lines.splice(found.sub.start, found.sub.end - found.sub.start, ...body, ...trailingBlank);
    return closeDoc(doc);
  }
  const level = found.section.heading.level + 1;
  let at = found.section.end;
  while (at > found.section.start && doc.lines[at - 1].trim() === '') at -= 1;
  doc.lines.splice(at, 0, '', `${'#'.repeat(level)} ${file}`, ...body, ...(at < doc.lines.length ? [''] : []));
  return closeDoc(doc);
}

/** Remove the TOC summary of `file`, heading and bullets (none there: unchanged). */
export function removeTocSection(guideText: string, file: string, names?: readonly string[]): string {
  const doc = openDoc(guideText);
  const found = tocFor(doc, file, indexFor(names, file));
  if (!found?.sub) return guideText;
  const from = found.sub.heading.index;
  doc.lines.splice(from, found.sub.end - from);
  // A doubled blank line would be left behind: keep one.
  if (from > 0 && from < doc.lines.length && doc.lines[from - 1].trim() === '' && doc.lines[from].trim() === '') doc.lines.splice(from, 1);
  return closeDoc(doc);
}

/** Rename the TOC heading of `from` to `to`, keeping its bullets. */
export function renameTocSection(guideText: string, from: string, to: string, names?: readonly string[]): string {
  const doc = openDoc(guideText);
  const found = tocFor(doc, from, indexFor(names, from));
  if (!found?.sub) return guideText;
  doc.lines[found.sub.heading.index] = `${'#'.repeat(found.sub.heading.level)} ${to}`;
  return closeDoc(doc);
}

// ── The root guide's Categories table ──────────────────────────────────────

/** Add a row to the root guide's `## Categories` table (the folder and what it holds); an existing folder is left as it is. */
export function addCategoryRow(rootGuideText: string, category: { folder: string; holds: string; kind?: string }): string {
  const doc = openDoc(rootGuideText);
  const section = sectionRange(doc.lines, 'categories');
  if (!section) return rootGuideText;
  const table = tableIn(doc.lines, section.start, section.end, false);
  if (!table) return rootGuideText;
  const folderAt = Math.max(table.headerCells.findIndex((cell) => cell === 'folder' || cell === 'name' || cell === 'category'), 0);
  const holdsAt = table.headerCells.findIndex((cell) => cell === 'holds' || cell === 'description' || cell === 'purpose');
  const kindAt = table.headerCells.findIndex((cell) => cell === 'kind' || cell === 'type');
  const wanted = lc(category.folder.replace(/\/+$/, ''));
  for (const line of table.rows) {
    if (lc(plainText(splitRow(doc.lines[line])[folderAt] ?? '').replace(/\/+$/, '')) === wanted) return rootGuideText;
  }
  const cells = table.headerCells.map(() => '');
  cells[folderAt] = `\`${cellText(category.folder.replace(/\/+$/, ''))}\``;
  if (holdsAt >= 0) cells[holdsAt] = cellText(category.holds);
  if (kindAt >= 0) cells[kindAt] = cellText(category.kind ?? 'generic');
  const after = table.rows.length > 0 ? table.rows[table.rows.length - 1] : table.separator;
  doc.lines.splice(after + 1, 0, `| ${cells.join(' | ')} |`);
  return closeDoc(doc);
}
