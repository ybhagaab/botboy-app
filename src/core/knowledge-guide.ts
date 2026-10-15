/**
 * Knowledge guides: parsing, the rules digest, token estimates and the prompt text built from a guide
 * (knowledge-library.md K6, K7). Pure: no disk, no database, no clock.
 *
 * A guide is a markdown file named GUIDE.md at the root of a set. The owner's hand-written guides are the model:
 * a title and one-line purpose, a File Ecosystem table (File, Path, Loading Mechanism, Purpose, Audience), Change
 * Methodology per file, Guardrails ("Do NOT ..."), a Conflict Priority Order line, and File TOC Summaries. BotBoy adds
 * a small optional front matter (name, description, keywords, kind, writable, writeTypes). The parser reads such guides
 * tolerantly (CRLF, BOM, tabs, heading aliases, any subset and order of the table columns, backticked cells, notes in
 * block quotes) and NEVER throws: whatever it cannot read becomes an entry in `issues`, and a guide with no table
 * degrades to its title plus the folder listing.
 *
 * Operating Knowledge (the practical agent framework): a guide says how a set's files are used and changed. It is
 * delivered to a model fenced as untrusted data, and it can never change BotBoy's approvals, sandbox or send rules.
 */
import { createHash } from 'crypto';
import { ESTIMATED_CHARS_PER_TOKEN } from './analytics-chat-context.js';
import { describeSecretKinds, detectSecrets } from './sensitive-files.js';

export const SET_KINDS = ['analytics', 'product', 'research', 'memory', 'generic'] as const;
export type SetKind = (typeof SET_KINDS)[number];

/** A guide over this size is not parsed: the set is treated as unguided and the issue says why. */
export const GUIDE_MAX_BYTES = 256 * 1024;
/** The whole standing line, in characters: 40 estimated tokens at 2.7 characters per token. */
export const STANDING_LINE_MAX_CHARS = 108;
/** The matched-guide block (line, fence and trailer) in estimated tokens. */
export const PREVIEW_BLOCK_MAX_TOKENS = 700;
/** The part of the preview inside the fence, in characters. */
export const PREVIEW_FENCE_MAX_CHARS = 1_240;
const PURPOSE_CLIP = 110;
const NAME_CLIP = 24;

export interface GuideIssue {
  code: 'guide_too_large' | 'guide_has_secret' | 'parse_error' | 'no_file_table' | 'front_matter_kind_unknown';
  message: string;
}

export interface GuideFrontMatter {
  name?: string;
  description?: string;
  keywords: string[];
  kind?: SetKind;
  /** `no` means BotBoy never writes or proposes in this set. Defaults to writable. */
  writable: boolean;
  /** Extra writable types a guide declares (`json` only). */
  writeTypes: string[];
}

export interface GuideRow {
  /** The file name as written (backticks removed). */
  file: string;
  /** The folder as written; empty when the guide has no Path column. */
  path: string;
  mechanism: string;
  purpose: string;
  audience: string;
}

export interface GuideMethodology {
  /** The heading text, for example "Context File (`orders.md`)". Empty for a general entry. */
  label: string;
  /** The file this entry governs, from a backticked name in the heading or a match against the table. */
  file: string | null;
  text: string;
}

export interface GuideCategory {
  folder: string;
  holds: string;
  kind: SetKind | null;
}

export interface ParsedGuide {
  title: string;
  /** The first prose line after the title. */
  purpose: string;
  frontMatter: GuideFrontMatter;
  rows: GuideRow[];
  methodology: GuideMethodology[];
  /** Placement rules (the root guide only). */
  placementRules: string[];
  /** One verbatim-quotable rule per bullet. */
  guardrails: string[];
  /** The Conflict Priority Order as written, and its names left to right (null when it has no `>`). */
  conflictLine: string;
  conflictOrder: string[] | null;
  /** Per-file summaries from File TOC Summaries. */
  toc: Array<{ file: string; bullets: string[] }>;
  /** The root guide's category table. */
  categories: GuideCategory[];
  issues: GuideIssue[];
  bytes: number;
}

// ── Reading helpers ────────────────────────────────────────────────────────

export const HEADING_RE = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
export const BULLET_RE = /^(\s*)(?:[-*+]|\d+[.)])\s+(.*)$/;

/** Markdown emphasis, backticks and link wrappers removed; whitespace collapsed. */
export function plainText(value: string): string {
  return String(value ?? '')
    .replace(/\\\|/g, '|')
    .replace(/`+/g, '')
    .replace(/\*\*|__/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

// ── Which file a table row or a TOC heading stands for ─────────────────────

/** A set-relative file name as a comparison key: no leading `./` or `/`, single slashes, lower case. */
export function nameKey(value: string): string {
  return String(value ?? '').trim().replace(/^(?:\.\/)+/, '').replace(/\/{2,}/g, '/').replace(/^\/+/, '').toLowerCase();
}
const baseKey = (key: string) => key.replace(/^.*\//, '');
const stemKey = (key: string) => baseKey(key).replace(/\.[^.]+$/, '');

/**
 * The names a table row can stand for, in the order `knowledge-library.ts › resolveRow` tries them: Path/File as written,
 * Path without its first folder (a guide written for a project root names its own folder first), File alone.
 */
export function rowNameKeys(file: string, rowPath = ''): string[] {
  const name = nameKey(file);
  const raw = String(rowPath ?? '').trim();
  const dir = /^[/~]|^\.\.|this file/i.test(raw) ? '' : nameKey(raw).replace(/\/+$/, '');
  const keys: string[] = [];
  if (dir) {
    keys.push(`${dir}/${name}`);
    const rest = dir.split('/').slice(1).join('/');
    keys.push(rest ? `${rest}/${name}` : name);
  }
  keys.push(name);
  return keys.filter((key, at) => key !== '' && keys.indexOf(key) === at);
}

export interface FileNameIndex {
  /** The file of the set that `written` stands for (a row's File cell with its Path cell, or a TOC heading), or null. */
  resolve(written: string, rowPath?: string): string | null;
  /** Whether `written` stands for exactly `file`. */
  names(written: string, rowPath: string | undefined, file: string): boolean;
}

/**
 * Index the file names of ONE set (set-relative, posix). A row or heading is matched to a file by its exact names first.
 * Only when none of them is a file of the set does the base name count (a guide may write a bare name), and only when
 * exactly ONE file of the set has that base name; when no file has it, the written name is compared with the stems (a heading
 * may leave the extension off) the same way.
 * Two files that share a base name in two folders are therefore never mistaken for each other: a bare name that fits both
 * stands for neither (knowledge-library.md K15, P2 review R31). Pure.
 */
export function indexFileNames(names: readonly string[]): FileNameIndex {
  const exact = new Map<string, string>();
  const byBase = new Map<string, string[]>();
  const byStem = new Map<string, string[]>();
  for (const name of names) {
    const key = nameKey(name);
    if (!key || exact.has(key)) continue;
    exact.set(key, name);
    byBase.set(baseKey(key), [...(byBase.get(baseKey(key)) ?? []), name]);
    byStem.set(stemKey(key), [...(byStem.get(stemKey(key)) ?? []), name]);
  }
  const resolve = (written: string, rowPath = ''): string | null => {
    for (const key of rowNameKeys(written, rowPath)) {
      const hit = exact.get(key);
      if (hit !== undefined) return hit;
    }
    const wanted = baseKey(nameKey(written));
    if (!wanted) return null;
    const sameBase = byBase.get(wanted) ?? [];
    if (sameBase.length === 1) return sameBase[0];
    if (sameBase.length === 0) {
      const sameStem = byStem.get(wanted) ?? [];
      if (sameStem.length === 1) return sameStem[0];
    }
    return null;
  };
  return {
    resolve,
    names: (written, rowPath, file) => {
      const named = resolve(written, rowPath);
      return named !== null && nameKey(named) === nameKey(file);
    },
  };
}

/** `names` plus `file` itself: a file about to be created, or moved to, is judged among the files of the set it joins. */
export function fileNamesWith(names: readonly string[] | undefined, file: string): string[] {
  const list = [...(names ?? [])];
  if (!list.some((name) => nameKey(name) === nameKey(file))) list.push(file);
  return list;
}

function headingKey(text: string): string {
  return plainText(text).toLowerCase().replace(/^\d+[.)]\s*/, '').replace(/[:：]\s*$/, '').trim();
}

const SECTION_ALIASES: Record<'ecosystem' | 'methodology' | 'guardrails' | 'conflict' | 'toc' | 'placement' | 'categories', readonly string[]> = {
  ecosystem: ['file ecosystem', 'files', 'file table', 'file map', 'ecosystem', 'file index', 'file list'],
  methodology: ['change methodology', 'how to change', 'methodology', 'change rules', 'change guide', 'maintenance', 'how to update'],
  guardrails: ['guardrails', 'rules', 'do not', 'dos and donts', 'avoid', 'constraints', "don'ts", 'donts'],
  conflict: ['conflict priority order', 'conflict priority', 'priority order', 'precedence', 'conflict order', 'source of truth'],
  toc: ['file toc summaries', 'toc summaries', 'file summaries', 'file toc', 'summaries', 'table of contents'],
  placement: ['placement rules', 'placement', 'where things go'],
  categories: ['categories', 'category table', 'folders'],
};
export type SectionName = keyof typeof SECTION_ALIASES;

export function sectionOf(headingText: string): SectionName | null {
  const key = headingKey(headingText);
  for (const [name, aliases] of Object.entries(SECTION_ALIASES) as Array<[SectionName, readonly string[]]>) {
    for (const alias of aliases) {
      // A longer alias also matches a heading that continues after it ("Guardrails (read first)"); a short one must be exact,
      // so a sub-heading such as "Rules for the context file" never replaces the real section.
      if (key === alias || (alias.length >= 9 && key.startsWith(alias) && !/^[a-z0-9]/.test(key.slice(alias.length)))) return name;
    }
  }
  return null;
}

/** Split a table row on unescaped pipes. */
export function splitRow(line: string): string[] {
  let text = line.trim();
  if (text.startsWith('|')) text = text.slice(1);
  if (text.endsWith('|') && !text.endsWith('\\|')) text = text.slice(0, -1);
  const cells: string[] = [];
  let current = '';
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '\\' && text[index + 1] === '|') { current += '|'; index += 1; continue; }
    if (char === '|') { cells.push(current); current = ''; continue; }
    current += char;
  }
  cells.push(current);
  return cells.map((cell) => cell.trim());
}

export const isSeparatorRow = (cells: string[]) => cells.length > 0 && cells.every((cell) => /^:?-+:?$/.test(cell.replace(/\s+/g, '')));

interface ParsedTable { header: string[]; rows: string[][] }

/** Every pipe table in `lines`, in order. A table is a header row, a separator row and the rows after it. */
function tablesIn(lines: string[]): ParsedTable[] {
  const tables: ParsedTable[] = [];
  for (let index = 0; index < lines.length - 1; index += 1) {
    if (!lines[index].trim().startsWith('|')) continue;
    const separator = splitRow(lines[index + 1] ?? '');
    if (!(lines[index + 1] ?? '').trim().startsWith('|') || !isSeparatorRow(separator)) continue;
    const header = splitRow(lines[index]).map((cell) => plainText(cell).toLowerCase());
    const rows: string[][] = [];
    let cursor = index + 2;
    while (cursor < lines.length && lines[cursor].trim().startsWith('|')) {
      rows.push(splitRow(lines[cursor]));
      cursor += 1;
    }
    tables.push({ header, rows });
    index = cursor - 1;
  }
  return tables;
}

const COLUMN_ALIASES: Record<keyof GuideRow, readonly string[]> = {
  file: ['file', 'files', 'name', 'document', 'doc', 'filename', 'file name'],
  path: ['path', 'location', 'folder', 'directory', 'dir', 'where'],
  mechanism: ['loading mechanism', 'loading', 'mechanism', 'how loaded', 'load', 'loaded', 'delivery'],
  purpose: ['purpose', 'description', 'role', 'what it is for', 'use', 'used for', 'about', 'summary'],
  audience: ['audience', 'users', 'for', 'used by', 'reader', 'readers'],
};

export function columnIndexes(header: string[]): Partial<Record<keyof GuideRow, number>> {
  const found: Partial<Record<keyof GuideRow, number>> = {};
  header.forEach((cell, index) => {
    for (const [name, aliases] of Object.entries(COLUMN_ALIASES) as Array<[keyof GuideRow, readonly string[]]>) {
      if (found[name] === undefined && aliases.includes(cell)) found[name] = index;
    }
  });
  return found;
}

function rowsFromTable(table: ParsedTable): GuideRow[] {
  const columns = columnIndexes(table.header);
  if (columns.file === undefined) columns.file = 0;
  const cell = (cells: string[], name: keyof GuideRow) => (columns[name] === undefined ? '' : plainText(cells[columns[name] as number] ?? ''));
  const rows: GuideRow[] = [];
  for (const cells of table.rows) {
    const file = cell(cells, 'file');
    if (!file) continue;
    rows.push({ file, path: cell(cells, 'path'), mechanism: cell(cells, 'mechanism'), purpose: cell(cells, 'purpose'), audience: cell(cells, 'audience') });
  }
  return rows;
}

/** A line that states a rule without a bullet ("Do NOT ...", "Never ...") still counts as one rule. */
const DIRECTIVE_RE = /^(?:do\s+not|don't|never|always|must|avoid)\b/i;

function bulletsIn(lines: string[]): string[] {
  const items: string[] = [];
  let inFence = false;
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) { inFence = !inFence; continue; }
    if (inFence || !line.trim()) continue;
    const bullet = BULLET_RE.exec(line);
    if (bullet) { items.push(bullet[2].trim()); continue; }
    if (HEADING_RE.test(line) || line.trim().startsWith('|') || line.trim().startsWith('>')) continue;
    if (DIRECTIVE_RE.test(plainText(line))) { items.push(line.trim()); continue; }
    if (items.length > 0 && /^\s+\S/.test(line)) items[items.length - 1] += ` ${line.trim()}`;
  }
  return items;
}

function parseFrontMatter(block: string, issues: GuideIssue[]): GuideFrontMatter {
  const matter: GuideFrontMatter = { keywords: [], writable: true, writeTypes: [] };
  for (const line of block.split('\n')) {
    const match = /^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line.trim());
    if (!match) continue;
    const key = match[1].toLowerCase();
    const value = match[2].trim().replace(/^["']|["']$/g, '').trim();
    if (key === 'name' && value) matter.name = value.slice(0, 120);
    else if (key === 'description' && value) matter.description = value.slice(0, 400);
    else if (key === 'keywords' || key === 'writetypes') {
      const list = value.replace(/^\[|\]$/g, '').split(/[,;]/).map((entry) => entry.trim().replace(/^["']|["']$/g, '').toLowerCase()).filter(Boolean).slice(0, 40);
      if (key === 'keywords') matter.keywords = list;
      else matter.writeTypes = list.filter((entry) => entry === 'json');
    } else if (key === 'kind') {
      const kind = value.toLowerCase();
      if ((SET_KINDS as readonly string[]).includes(kind)) matter.kind = kind as SetKind;
      else if (value) issues.push({ code: 'front_matter_kind_unknown', message: `kind "${value.slice(0, 40)}" is not one of ${SET_KINDS.join(', ')}; the kind is inferred from the folder instead.` });
    } else if (key === 'writable') {
      matter.writable = !/^(no|false|0|off)$/i.test(value);
    }
  }
  return matter;
}

const EMPTY_FRONT_MATTER = (): GuideFrontMatter => ({ keywords: [], writable: true, writeTypes: [] });

function emptyGuide(bytes: number, issues: GuideIssue[]): ParsedGuide {
  return {
    title: '', purpose: '', frontMatter: EMPTY_FRONT_MATTER(), rows: [], methodology: [], placementRules: [], guardrails: [],
    conflictLine: '', conflictOrder: null, toc: [], categories: [], issues, bytes,
  };
}

function backtickedFile(heading: string): string | null {
  const ticks = /`([^`]+\.[A-Za-z0-9]{1,6})`/.exec(heading);
  if (ticks) return ticks[1];
  const paren = /\(([^()\s]+\.[A-Za-z0-9]{1,6})\)/.exec(heading);
  return paren ? paren[1] : null;
}

const stemOf = (file: string) => file.replace(/^.*\//, '').replace(/\.[^.]+$/, '').toLowerCase();

function matchFile(label: string, rows: GuideRow[]): string | null {
  const direct = backtickedFile(label);
  if (direct) return direct;
  const clean = plainText(label).toLowerCase();
  if (!clean) return null;
  for (const row of rows) {
    if (clean === row.file.toLowerCase() || clean === stemOf(row.file)) return row.file;
  }
  return null;
}

/**
 * Read a guide. Never throws.
 */
export function parseGuide(rawText: string): ParsedGuide {
  const bytes = Buffer.byteLength(String(rawText ?? ''), 'utf8');
  if (bytes > GUIDE_MAX_BYTES) {
    return emptyGuide(bytes, [{ code: 'guide_too_large', message: `This guide is ${Math.round(bytes / 1024)} KB, over the ${GUIDE_MAX_BYTES / 1024} KB limit, so the set is treated as having no guide. Shorten it or split the set.` }]);
  }
  // A guide holding a credential is as unusable as an oversize one: its purposes and summaries reach a prompt without a
  // load, so nothing of it is kept (P1 review N2). The kinds are named, never the values.
  const secrets = detectSecrets(String(rawText ?? ''));
  if (secrets.length > 0) {
    return emptyGuide(bytes, [{ code: 'guide_has_secret', message: `This guide ${describeSecretKinds(secrets).replace(/^Contains /, 'contains ')}, so the set is treated as having no guide and its text is not shown to a model. Remove the credential from the guide.` }]);
  }
  try {
    return parseGuideText(String(rawText ?? ''), bytes);
  } catch (error) {
    return emptyGuide(bytes, [{ code: 'parse_error', message: `The guide could not be read (${String((error as Error)?.message ?? error).slice(0, 120)}); the set is listed without a guide.` }]);
  }
}

function parseGuideText(rawText: string, bytes: number): ParsedGuide {
  const issues: GuideIssue[] = [];
  let text = rawText.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').replace(/\t/g, '    ');
  let frontMatter = EMPTY_FRONT_MATTER();
  const matter = /^---[ ]*\n([\s\S]*?)\n---[ ]*(?:\n|$)/.exec(text);
  if (matter) {
    frontMatter = parseFrontMatter(matter[1], issues);
    text = text.slice(matter[0].length);
  }
  const lines = text.split('\n');

  // Headings and the sections BotBoy knows by name.
  const headings: Array<{ index: number; level: number; text: string }> = [];
  let inFence = false;
  lines.forEach((line, index) => {
    if (/^\s*(```|~~~)/.test(line)) { inFence = !inFence; return; }
    if (inFence) return;
    const heading = HEADING_RE.exec(line);
    if (heading) headings.push({ index, level: heading[1].length, text: heading[2] });
  });
  const title = plainText(headings.find((heading) => heading.level === 1)?.text ?? headings[0]?.text ?? '');
  const titleAt = headings.find((heading) => heading.level === 1) ?? headings[0];
  let purpose = '';
  if (titleAt) {
    for (let index = titleAt.index + 1; index < lines.length; index += 1) {
      const line = lines[index].trim();
      if (!line) continue;
      if (HEADING_RE.test(line) || line.startsWith('|') || line.startsWith('>') || BULLET_RE.test(line)) break;
      purpose = plainText(line);
      break;
    }
  }

  const sections = new Map<SectionName, string[]>();
  const sectionRanges = new Map<SectionName, { start: number; end: number; level: number }>();
  headings.forEach((heading, order) => {
    const name = sectionOf(heading.text);
    if (!name || sections.has(name)) return;
    let end = lines.length;
    for (let next = order + 1; next < headings.length; next += 1) {
      if (headings[next].level <= heading.level) { end = headings[next].index; break; }
    }
    sections.set(name, lines.slice(heading.index + 1, end));
    sectionRanges.set(name, { start: heading.index + 1, end, level: heading.level });
  });

  // File Ecosystem table: its own section first, else the first table anywhere that has a File column.
  let rows: GuideRow[] = [];
  const ecosystem = sections.get('ecosystem');
  const ecosystemTables = ecosystem ? tablesIn(ecosystem) : [];
  if (ecosystemTables.length > 0) rows = rowsFromTable(ecosystemTables[0]);
  else {
    const fallback = tablesIn(lines).find((table) => table.header.some((cell) => COLUMN_ALIASES.file.includes(cell)) && !table.header.includes('folder'));
    if (fallback) rows = rowsFromTable(fallback);
  }
  if (rows.length === 0) issues.push({ code: 'no_file_table', message: 'No File Ecosystem table was found; files are listed from the folder with their first headings.' });

  // Change Methodology: one entry per sub-heading, mapped to its file.
  const methodology: GuideMethodology[] = [];
  const methodRange = sectionRanges.get('methodology');
  if (methodRange) {
    const subs = headings.filter((heading) => heading.index >= methodRange.start && heading.index < methodRange.end && heading.level > methodRange.level);
    const preface = lines.slice(methodRange.start, subs[0]?.index ?? methodRange.end).join('\n').trim();
    if (preface) methodology.push({ label: '', file: null, text: preface });
    subs.forEach((sub, order) => {
      let end = methodRange.end;
      for (let next = order + 1; next < subs.length; next += 1) {
        if (subs[next].level <= sub.level) { end = subs[next].index; break; }
      }
      const body = lines.slice(sub.index + 1, end).join('\n').trim();
      methodology.push({ label: plainText(sub.text), file: matchFile(sub.text, rows), text: body });
    });
  }

  const guardrails = bulletsIn(sections.get('guardrails') ?? []);
  const placementRules = bulletsIn(sections.get('placement') ?? []);

  let conflictLine = '';
  for (const line of sections.get('conflict') ?? []) {
    const candidate = line.trim().replace(/^(?:[-*+]|\d+[.)])\s+/, '');
    if (candidate && !HEADING_RE.test(candidate) && !candidate.startsWith('>') && !candidate.startsWith('|')) { conflictLine = candidate; break; }
  }
  const conflictParts = plainText(conflictLine).split(/\s*(?:>|→|›|»)\s*/).map((part) => part.trim()).filter(Boolean);
  const conflictOrder = conflictParts.length >= 2 ? conflictParts : null;

  const toc: Array<{ file: string; bullets: string[] }> = [];
  const tocRange = sectionRanges.get('toc');
  if (tocRange) {
    const subs = headings.filter((heading) => heading.index >= tocRange.start && heading.index < tocRange.end && heading.level > tocRange.level);
    subs.forEach((sub, order) => {
      let end = tocRange.end;
      for (let next = order + 1; next < subs.length; next += 1) {
        if (subs[next].level <= sub.level) { end = subs[next].index; break; }
      }
      const bullets = bulletsIn(lines.slice(sub.index + 1, end)).map(plainText).filter(Boolean);
      toc.push({ file: plainText(sub.text), bullets });
    });
  }

  const categories: GuideCategory[] = [];
  const categoryTables = tablesIn(sections.get('categories') ?? []);
  if (categoryTables.length > 0) {
    const table = categoryTables[0];
    const folderAt = Math.max(table.header.findIndex((cell) => cell === 'folder' || cell === 'name' || cell === 'category'), 0);
    const holdsAt = table.header.findIndex((cell) => cell === 'holds' || cell === 'description' || cell === 'purpose');
    const kindAt = table.header.findIndex((cell) => cell === 'kind' || cell === 'type');
    for (const cells of table.rows) {
      const folder = plainText(cells[folderAt] ?? '').replace(/\/+$/, '');
      if (!folder) continue;
      const kind = kindAt >= 0 ? plainText(cells[kindAt] ?? '').toLowerCase() : '';
      categories.push({ folder, holds: holdsAt >= 0 ? plainText(cells[holdsAt] ?? '') : '', kind: (SET_KINDS as readonly string[]).includes(kind) ? (kind as SetKind) : null });
    }
  }

  return { title, purpose, frontMatter, rows, methodology, placementRules, guardrails, conflictLine, conflictOrder, toc, categories, issues, bytes };
}

// ── Digest, kinds, estimates ───────────────────────────────────────────────

/** LF, collapsed whitespace, trimmed: the form the rules digest hashes. */
export function normalizeRuleText(value: string): string {
  return String(value ?? '').replace(/\r\n?/g, '\n').replace(/\s+/g, ' ').trim();
}

/**
 * The digest of a guide's RULES: the Change Methodology entries, the Placement Rules (root guide), the Guardrails and
 * the Conflict Priority Order, in that order. The File Ecosystem table, the TOC summaries and the front matter are
 * outside it, so a table or summary refresh never changes it and a hand edit of a rule always does. It is the receipt
 * a drafting model must echo before a write (P2) and is shown in a whole-guide load header (P1).
 */
export function rulesDigest(guide: ParsedGuide): string {
  const parts = [
    ...guide.methodology.map((entry) => `M:${normalizeRuleText(entry.label)}\n${normalizeRuleText(entry.text)}`),
    ...guide.placementRules.map((rule) => `P:${normalizeRuleText(rule)}`),
    ...guide.guardrails.map((rule) => `G:${normalizeRuleText(rule)}`),
    `C:${normalizeRuleText(guide.conflictLine)}`,
  ];
  return createHash('sha256').update(parts.join('\n\u0000\n')).digest('hex');
}

/** The kind a folder name implies when the guide does not say: its top-level category, else generic. */
export function inferKind(setId: string): SetKind {
  const top = String(setId ?? '').split('/')[0].toLowerCase();
  return (SET_KINDS as readonly string[]).includes(top) && top !== 'generic' ? (top as SetKind) : 'generic';
}

/** Estimated tokens, with the briefing's conservative estimator (2.7 characters per token). */
export function estimateTokens(text: string): number {
  return Math.ceil(String(text ?? '').length / ESTIMATED_CHARS_PER_TOKEN);
}

// ── Text that reaches a model ──────────────────────────────────────────────

/**
 * Text that is about to reach a model WITHOUT an explicit load (a purpose, a description, a summary line, a title taken from
 * a file's first line): empty when it holds a secret format, so the file or row shows by name only (P1 review N2). The
 * loads themselves refuse a file with a secret (`file_has_secret`).
 */
export function secretFree(text: string): string {
  const value = String(text ?? '');
  return value && detectSecrets(value).length > 0 ? '' : value;
}

/** Names sit OUTSIDE the untrusted fence, so they are cut down to a safe alphabet and a short length. */
export function sanitizeSetName(name: string): string {
  return String(name ?? '').replace(/[\r\n\t]+/g, ' ').replace(/[^A-Za-z0-9 ._&()-]/g, '').replace(/\s+/g, ' ').trim().slice(0, NAME_CLIP).trim();
}

const STANDING_PROTECTED_TAIL = '. knowledge_list / knowledge_load read it; commands cannot change it.';
const STANDING_OPEN_TAIL = '. Use knowledge_list / knowledge_load.';
const STANDING_HEAD = 'Knowledge library: ';

/**
 * The one resident line (at most 108 characters, about 40 tokens). It names sets greedily while the line fits and
 * falls back to a count. "Commands cannot change it" is said only when the sandbox deny reports the root, so the line
 * never claims protection that is not there. Returns '' when there are no sets.
 */
export function buildStandingLine(setNames: readonly string[], options: { protectedByDeny: boolean }): string {
  const names = [...new Set(setNames.map(sanitizeSetName).filter(Boolean))];
  if (names.length === 0) return '';
  const tail = options.protectedByDeny ? STANDING_PROTECTED_TAIL : STANDING_OPEN_TAIL;
  const fits = (middle: string) => (STANDING_HEAD + middle + tail).length <= STANDING_LINE_MAX_CHARS;
  const all = names.join(', ');
  if (fits(all)) return STANDING_HEAD + all + tail;
  let chosen: string[] = [];
  for (const name of names) {
    const attempt = [...chosen, name];
    const rest = names.length - attempt.length;
    if (!fits(attempt.join(', ') + (rest > 0 ? ` +${rest}` : ''))) break;
    chosen = attempt;
  }
  if (chosen.length > 0) {
    const rest = names.length - chosen.length;
    return STANDING_HEAD + chosen.join(', ') + (rest > 0 ? ` +${rest}` : '') + tail;
  }
  return STANDING_HEAD + `${names.length} set${names.length === 1 ? '' : 's'}` + tail;
}

/** Strip any attempt to open or close one of the knowledge fences from text placed inside one. */
export function protectKnowledgeDelimiters(text: string): string {
  return String(text ?? '').replace(/<\/?external_untrusted_(?:knowledge|schema_context)[a-z_]*\b[^>]*>/gi, '[knowledge delimiter removed]');
}

export function escapeAttribute(value: string): string {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/[\r\n]+/g, ' ');
}

/** The trusted trailer of a matched-guide block: the load rule (about 45 tokens). */
export const KNOWLEDGE_READ_TRAILER = 'Load a file whole only when the task needs it, and tell the owner when a result carries tellOwner.';

export interface PreviewFile { name: string; purpose: string }

export interface PreviewInput {
  setId: string;
  kind: SetKind;
  description: string;
  files: readonly PreviewFile[];
}

export interface PreviewBlock {
  /** The fence only. */
  fence: string;
  /** Files that did not fit and are reachable through knowledge_list. */
  omitted: number;
}

const clip = (value: string, max: number) => (value.length <= max ? value : `${value.slice(0, Math.max(0, max - 1)).trimEnd()}…`);

/**
 * The matched-guide preview: the set's name, description and one `- file: purpose` line per file, in the guide's order.
 * File table and per-file purposes only: no methodology, guardrails or summaries (those arrive on demand). Purposes are
 * clipped to 110 characters and lines are added greedily to a 1,240-character fence, then `+N more`.
 */
export function buildPreviewFence(input: PreviewInput): PreviewBlock {
  const description = secretFree(input.description);
  const header = [`set: ${clip(plainText(input.setId), 80) || 'set'}`, description ? clip(plainText(description), 200) : ''].filter(Boolean);
  const lines: string[] = [...header];
  let size = lines.join('\n').length;
  let omitted = 0;
  for (const file of input.files) {
    const purpose = secretFree(file.purpose);
    const line = `- ${file.name}${purpose ? `: ${clip(plainText(purpose), PURPOSE_CLIP)}` : ''}`;
    if (size + line.length + 1 > PREVIEW_FENCE_MAX_CHARS - 40) { omitted += 1; continue; }
    lines.push(line);
    size += line.length + 1;
  }
  if (omitted > 0) lines.push(`+${omitted} more: knowledge_list`);
  return { fence: protectKnowledgeDelimiters(lines.join('\n')), omitted };
}

/** The matched-guide block: the fenced preview and the read trailer. The standing line is added by the caller. */
export function buildPreviewBlock(input: PreviewInput): { text: string; estimatedTokens: number; omitted: number } {
  const { fence, omitted } = buildPreviewFence(input);
  const open = `<external_untrusted_knowledge_guide set="${escapeAttribute(input.setId)}" kind="${input.kind}" purpose="preview">`;
  const text = `${open}\n${fence}\n</external_untrusted_knowledge_guide>\n${KNOWLEDGE_READ_TRAILER}`;
  return { text, estimatedTokens: estimateTokens(text), omitted };
}
