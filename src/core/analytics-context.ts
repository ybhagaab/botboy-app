/**
 * Analytics knowledge directory (etl-analytics A2) — the local, on-demand
 * knowledge layer for data work on BOTH lanes (SQL and ETL).
 *
 * One directory, two producers, one loader:
 *   - user-dropped files at the ROOT (schema notes, methodology docs — e.g.
 *     an export of warehouse context or the opted-out-GAID note);
 *   - generated business presets under `presets/` (written by the A3
 *     onboarding flow; tagged in manifest.json).
 *
 * Principles (practical-agent framework #6/#9): context files load in
 * ISOLATION — list first, load exactly the ONE file matching the task,
 * never all of them. Every load is prefixed with a PROVENANCE header so the
 * model knows which kind of knowledge it is holding and what transfers
 * between sources (source arbitration is mechanical, not judgment).
 *
 * manifest.json (optional, A3 writes it; user files work without it):
 *   { "files": [ { "file": "presets/fatafat.md", "business": "fatafat",
 *       "keywords": ["fatafat", ...], "source": "etl-derived",
 *       "appliesTo": ["mcp_etl_*", "mcp_sql_*"], "derivedAt": "...",
 *       "corpusSize": 85 } ] }
 */
import type Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { getSetting, setSetting } from './storage.js';
import { effectiveAnalyticsDir, resolveKnowledgeRoot } from './knowledge-root.js';

export const ANALYTICS_CONTEXT_DIR_KEY = 'analytics_context.dir';
const ALLOWED_EXTENSIONS = new Set(['.md', '.txt']);
const DEFAULT_MAX_CHARS = 60_000;

export type AnalyticsContextSource = 'etl-derived' | 'user-dropped' | 'lesson';

export interface AnalyticsContextEntry {
  /** Relative name within the directory, e.g. `agent-note.md` or `presets/fatafat.md`. */
  name: string;
  /** First non-empty line with markdown heading markers stripped. */
  title: string;
  source: AnalyticsContextSource;
  appliesTo: string[];
  bytes: number;
  modifiedAt: string;
  business?: string;
  keywords?: string[];
  derivedAt?: string;
}

interface ManifestEntry {
  file: string;
  business?: string;
  keywords?: string[];
  source?: AnalyticsContextSource;
  appliesTo?: string[];
  derivedAt?: string;
  corpusSize?: number;
}

function expandHome(value: string): string {
  if (value === '~') return os.homedir();
  if (value.startsWith('~/')) return path.join(os.homedir(), value.slice(2));
  return value;
}

function privateDefaultDir(): string {
  return path.join(os.homedir(), '.personal-productivity-tracker', 'analytics-context');
}

/**
 * Where the analytics knowledge lived BEFORE the Knowledge library: the explicit setting, else the private default.
 * The migration copies from here; ETL onboarding keeps its work files here (or in the private default once the install
 * is in library mode), never inside the visible library (knowledge-library.md K10).
 */
export function legacyAnalyticsContextDir(db: Database.Database): string {
  const configured = (getSetting<string>(db, ANALYTICS_CONTEXT_DIR_KEY) ?? '').trim();
  if (configured) return path.resolve(expandHome(configured));
  return privateDefaultDir();
}

/** The private default folder, where ETL onboarding keeps its work files once the analytics knowledge is in the library. */
export function privateAnalyticsContextDir(): string {
  return privateDefaultDir();
}

/**
 * What the legacy analytics folder holds, read without creating or changing anything (no mkdir, unlike
 * `listAnalyticsContext` in legacy mode): the `.md` / `.txt` files in its root, `presets/` and `lessons/`, and whether a
 * `manifest.json` exists. The Knowledge library asks this to decide whether Move is offered and whether a fresh folder can
 * start in library mode. Never throws.
 */
export function legacyAnalyticsContentSummary(db: Database.Database): { dir: string; files: number; hasManifest: boolean } {
  const dir = legacyAnalyticsContextDir(db);
  let files = 0;
  for (const sub of ['', 'presets', 'lessons']) {
    try {
      for (const entry of fs.readdirSync(path.join(dir, sub), { withFileTypes: true })) {
        if (entry.name.startsWith('.') || !entry.isFile() && !entry.isSymbolicLink()) continue;
        if (ALLOWED_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) files += 1;
      }
    } catch { /* absent or unreadable: nothing to move */ }
  }
  return { dir, files, hasManifest: fs.existsSync(path.join(dir, 'manifest.json')) };
}

/** True once this install keeps its analytics knowledge in the Knowledge library's `analytics/` set. */
export function analyticsLibraryMode(db: Database.Database): boolean {
  return effectiveAnalyticsDir(db) === 'library';
}

/**
 * Directory resolution: explicit setting wins; then, in library mode, the library's `analytics/` set; the default
 * lives next to the rest of BotBoy's state. Every install today is in legacy mode, where this is exactly what it was.
 */
export function resolveAnalyticsContextDir(db: Database.Database): string {
  const configured = (getSetting<string>(db, ANALYTICS_CONTEXT_DIR_KEY) ?? '').trim();
  if (configured) return path.resolve(expandHome(configured));
  if (analyticsLibraryMode(db)) {
    const { root } = resolveKnowledgeRoot(db);
    if (root) return path.join(root, 'analytics');
  }
  return privateDefaultDir();
}

/** Why a library folder cannot be used, in the words the owner needs (macOS Documents access, a missing folder). */
export interface AnalyticsContextUnavailable {
  code: 'permission_denied' | 'root_unavailable';
  message: string;
  nextAction: string;
}

const PERMISSION_NEXT_ACTION = 'Open System Settings → Privacy & Security → Files and Folders, allow BotBoy (or the app that starts it) for the Knowledge folder, or choose another location in Settings → Knowledge.';

/** EPERM and EACCES (macOS withholding a protected folder) become a described problem; anything else is null. */
export function permissionProblem(error: unknown, where: string): AnalyticsContextUnavailable | null {
  const code = String((error as NodeJS.ErrnoException)?.code ?? '');
  if (code !== 'EPERM' && code !== 'EACCES') return null;
  return { code: 'permission_denied', message: `macOS did not let BotBoy read ${where}.`, nextAction: PERMISSION_NEXT_ACTION };
}

/**
 * Library mode only: a writer (lesson projection, ETL onboarding) may write into the library only while the root
 * exists. A deleted root is never recreated by a background writer (design amendment P2-13b); the answer names the fix.
 */
export function analyticsLibraryWriteBlocker(db: Database.Database): AnalyticsContextUnavailable | null {
  if (!analyticsLibraryMode(db)) return null;
  const { root } = resolveKnowledgeRoot(db);
  if (!root) {
    return { code: 'root_unavailable', message: 'The Knowledge folder is not set up.', nextAction: 'Open Settings → Knowledge and create the folder.' };
  }
  try {
    if (!fs.statSync(root).isDirectory()) throw Object.assign(new Error('not a directory'), { code: 'ENOTDIR' });
  } catch (error) {
    return permissionProblem(error, root) ?? {
      code: 'root_unavailable',
      message: `The Knowledge folder ${root} is missing, so nothing was written to it.`,
      nextAction: 'Restore the folder, or choose another location in Settings → Knowledge.',
    };
  }
  return null;
}

/** Set (or clear with '') the configured directory. Returns the resolved active dir. */
export function setAnalyticsContextDir(db: Database.Database, dir: string): string {
  const cleaned = String(dir ?? '').trim();
  if (cleaned.includes('\0')) throw new Error('directory contains a null byte');
  setSetting(db, ANALYTICS_CONTEXT_DIR_KEY, cleaned || null);
  const resolved = resolveAnalyticsContextDir(db);
  fs.mkdirSync(path.join(resolved, 'presets'), { recursive: true });
  return resolved;
}

function readManifest(dir: string): Map<string, ManifestEntry> {
  const byFile = new Map<string, ManifestEntry>();
  try {
    const raw = fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8');
    const parsed = JSON.parse(raw) as { files?: ManifestEntry[] };
    for (const entry of parsed.files ?? []) {
      if (entry && typeof entry.file === 'string') byFile.set(path.normalize(entry.file), entry);
    }
  } catch { /* absent or malformed manifest: user files still work */ }
  return byFile;
}

function titleOf(filePath: string): string {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    for (const line of raw.split('\n')) {
      const cleaned = line.replace(/^#+\s*/, '').trim();
      if (cleaned) return cleaned.slice(0, 160);
    }
  } catch { /* unreadable → empty title */ }
  return '';
}

/**
 * List the knowledge files (root + presets/ + lessons/), manifest tags folded in.
 *
 * Library mode (the analytics knowledge lives in the Knowledge library) differs in four ways, all of them refusals or
 * reports: it never creates a folder; it skips the root `GUIDE.md` (a guide is not a catalog entry); it skips symbolic
 * links and anything whose real path leaves the directory, so list and load agree; and a root that macOS will not let
 * BotBoy read is reported in `unavailable` instead of looking like an empty folder. Legacy mode is unchanged.
 */
export function listAnalyticsContext(db: Database.Database): { dir: string; files: AnalyticsContextEntry[]; unavailable?: AnalyticsContextUnavailable } {
  const dir = resolveAnalyticsContextDir(db);
  const library = analyticsLibraryMode(db);
  let realDir = dir;
  if (library) {
    try {
      fs.readdirSync(dir);
      realDir = fs.realpathSync.native(dir);
    } catch (error) {
      const blocked = permissionProblem(error, dir);
      if (blocked) return { dir, files: [], unavailable: blocked };
    }
  } else {
    fs.mkdirSync(path.join(dir, 'presets'), { recursive: true });
  }
  const manifest = readManifest(dir);
  const files: AnalyticsContextEntry[] = [];
  const scan = (subdir: string): void => {
    const absolute = path.join(dir, subdir);
    let names: string[] = [];
    try { names = fs.readdirSync(absolute); } catch { return; }
    if (library && subdir) {
      // A folder that is a link, or resolves outside the directory, holds nothing the library lists.
      try {
        if (fs.lstatSync(absolute).isSymbolicLink() || !isInsideDir(fs.realpathSync.native(absolute), realDir)) return;
      } catch { return; }
    }
    for (const fileName of names.sort()) {
      if (fileName.startsWith('.')) continue;
      if (library && !subdir && fileName.toLowerCase() === 'guide.md') continue;
      const relative = subdir ? path.join(subdir, fileName) : fileName;
      const fullPath = path.join(dir, relative);
      let stat: fs.Stats;
      try { stat = library ? fs.lstatSync(fullPath) : fs.statSync(fullPath); } catch { continue; }
      if (!stat.isFile()) continue;
      if (!ALLOWED_EXTENSIONS.has(path.extname(fileName).toLowerCase())) continue;
      const tagged = manifest.get(path.normalize(relative));
      files.push({
        name: relative,
        title: titleOf(fullPath),
        source: tagged?.source ?? (subdir === 'presets' ? 'etl-derived' : subdir === 'lessons' ? 'lesson' : 'user-dropped'),
        appliesTo: Array.isArray(tagged?.appliesTo) && tagged.appliesTo.length > 0
          ? tagged.appliesTo.map(String)
          : ['mcp_sql_*', 'mcp_etl_*'],
        bytes: stat.size,
        modifiedAt: stat.mtime.toISOString(),
        ...(tagged?.business ? { business: tagged.business } : {}),
        ...(Array.isArray(tagged?.keywords) && tagged.keywords.length > 0 ? { keywords: tagged.keywords.map(String) } : {}),
        ...(tagged?.derivedAt ? { derivedAt: tagged.derivedAt } : {}),
      });
    }
  };
  scan('');
  scan('presets');
  scan('lessons');
  return { dir, files };
}

function isInsideDir(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);
}

const SOURCE_LABEL: Record<AnalyticsContextSource, string> = {
  'etl-derived': 'generated from your team\'s production ETL profiles (Datanet)',
  'user-dropped': 'user-supplied warehouse/schema knowledge',
  'lesson': 'BotBoy experiential lessons — owner-adopted operating rules from live incidents',
};

const ARBITRATION_LINE =
  'Source rules: schema facts transfer across sources; wrapper/submission mechanics are ETL-only; '
  + 'when numbers depend on filters, name the regime used (report-matching vs analytical).';

/**
 * The provenance header every load starts with: which kind of knowledge this is, and the source-arbitration rule
 * (schema facts transfer, wrapper mechanics are ETL-only, name the filter regime). One builder, so `knowledge_load` of
 * an analytics file and `mcp_analytics_load_context` can never disagree about it (design amendment P2-7).
 */
export function analyticsContextHeader(name: string, source: AnalyticsContextSource): string {
  return `[KNOWLEDGE FILE: ${name} — ${SOURCE_LABEL[source]}]\n${ARBITRATION_LINE}\n---\n`;
}

export type LoadAnalyticsContextResult =
  | { ok: true; name: string; source: AnalyticsContextSource; content: string; truncated: boolean }
  | { ok: false; error: string };

/** The line that marks BotBoy's data dictionary (etl-data-dictionary.ts › renderDataDictionary). */
export const DATA_DICTIONARY_MARKER = '<!-- botboy:data-dictionary v1 -->';

export interface KnowledgeParts {
  /** Sections whose heading names one of these tables (schema.table or the bare name). */
  tables?: string[];
  /** Every line that holds this word, under its section heading. */
  find?: string;
}

const MAX_FIND_LINES = 160;
const MAX_PART_CHARS = 40_000;

/**
 * Part of a knowledge file (owner decision 2026-11-10: the data dictionary is one file, read in parts, so it scales with the
 * estate). `tables` returns the sections whose heading names a table; `find` every line holding a word, grouped under its
 * section heading; a data dictionary loaded with neither returns only its index. Null means: the whole file, as before.
 */
export function selectKnowledgeParts(raw: string, parts: KnowledgeParts = {}): string | null {
  const wanted = (parts.tables ?? []).map(name => String(name ?? '').trim().replace(/^`|`$/g, '').toLowerCase()).filter(Boolean).slice(0, 12);
  const term = String(parts.find ?? '').trim().toLowerCase().slice(0, 120);
  const dictionary = raw.includes(DATA_DICTIONARY_MARKER);
  if (!wanted.length && !term && !dictionary) return null;
  const lines = raw.split('\n');
  const headings: Array<{ line: number; level: number; text: string }> = [];
  lines.forEach((line, index) => {
    const match = /^(#{1,6})\s+(.*)$/.exec(line);
    if (match) headings.push({ line: index, level: match[1].length, text: match[2].replace(/`/g, '').trim().toLowerCase() });
  });
  const sectionEnd = (position: number) => {
    const next = headings.slice(position + 1).find(heading => heading.level <= headings[position].level);
    return next ? next.line : lines.length;
  };
  // A data dictionary's table entries are its level-2 headings named schema.table.
  const isTableHeading = (heading: { level: number; text: string }) => heading.level === 2 && /^[a-z0-9_$]+\.[a-z0-9_$]+$/.test(heading.text);
  if (!wanted.length && !term) {
    const first = headings.find(isTableHeading);
    if (!first) return raw;
    const count = headings.filter(isTableHeading).length;
    return `${lines.slice(0, first.line).join('\n').trimEnd()}\n\n[Index only: this file holds ${count} table entries. Read entries with tables:["<table>"], or search every table with find:"<column, ID or word>".]`;
  }
  const out: string[] = [];
  if (wanted.length) {
    const picked = new Set<number>();
    const misses: string[] = [];
    for (const name of wanted) {
      const bare = name.split('.').pop()!;
      const matches = headings.map((heading, position) => ({ heading, position })).filter(({ heading }) => (dictionary
        ? isTableHeading(heading) && (heading.text === name || heading.text.endsWith(`.${bare}`))
        : heading.text.includes(bare)));
      if (!matches.length) misses.push(name);
      for (const { position } of matches) picked.add(position);
    }
    for (const position of [...picked].sort((a, b) => a - b)) out.push(lines.slice(headings[position].line, sectionEnd(position)).join('\n').trimEnd());
    if (misses.length) out.push(`[Not in this file: ${misses.join(', ')}${dictionary ? '. The Index lists every table this dictionary covers.' : '.'}]`);
  }
  if (term) {
    // The section a line belongs to: in a dictionary its table entry, elsewhere its nearest heading.
    const sectionOf = (index: number) => {
      let found = -1;
      for (let position = 0; position < headings.length && headings[position].line <= index; position += 1) {
        if (!dictionary || headings[position].level <= 2) found = position;
      }
      return found;
    };
    const groups = new Map<number, number[]>();
    let shown = 0;
    let more = 0;
    lines.forEach((line, index) => {
      if (!line.toLowerCase().includes(term)) return;
      const position = sectionOf(index);
      // The index repeats what the table entries say; a dictionary search reads the entries.
      if (dictionary && (position < 0 || !isTableHeading(headings[position]))) return;
      if (shown >= MAX_FIND_LINES) { more += 1; return; }
      shown += 1;
      const list = groups.get(position) ?? [];
      list.push(index);
      groups.set(position, list);
    });
    if (groups.size === 0) {
      out.push(`[find "${term}": no matches${dictionary ? ". This dictionary covers the tables the team's ETL profiles read; a table no profile reads is not in it" : ''}.]`);
    } else {
      out.push(`[find "${term}": ${shown + more} matching line${shown + more === 1 ? '' : 's'} in ${groups.size} section${groups.size === 1 ? '' : 's'}${more ? `; the first ${shown} are shown, use a narrower word for the rest` : ''}.]`);
      for (const [position, indexes] of groups) {
        const headingLine = position >= 0 ? headings[position].line : -1;
        const block: string[] = headingLine >= 0 ? [lines[headingLine]] : [];
        const rest = indexes.filter(index => index !== headingLine);
        const rows = rest.filter(index => lines[index].startsWith('| `'));
        const other = rest.filter(index => !lines[index].startsWith('| `'));
        if (dictionary && position >= 0) {
          const purpose = lines.slice(headingLine, sectionEnd(position)).find(line => line.startsWith("**What it's for:**"));
          if (purpose && !other.some(index => lines[index] === purpose)) block.push(purpose);
        }
        block.push(...other.map(index => lines[index]));
        if (rows.length) block.push(...(dictionary ? ['| Column | Type | Profiles | Meaning |', '|---|---|---|---|'] : []), ...rows.map(index => lines[index]));
        out.push(block.join('\n'));
      }
    }
  }
  const text = out.join('\n\n');
  return text.length > MAX_PART_CHARS
    ? `${text.slice(0, MAX_PART_CHARS)}\n\n[Cut at ${MAX_PART_CHARS} characters: ask for fewer tables or a narrower word.]`
    : text;
}

/**
 * Load ONE file with the provenance header. Traversal-safe, size-capped. In library mode it also refuses a symbolic link
 * or a path whose real path leaves the directory, answers "not found" for the root `GUIDE.md` (not a catalog entry), and
 * answers a macOS permission refusal with the System Settings steps instead of "not found".
 */
export function loadAnalyticsContext(
  db: Database.Database,
  name: string,
  maxChars = DEFAULT_MAX_CHARS,
  parts: KnowledgeParts = {},
): LoadAnalyticsContextResult {
  const cleaned = String(name ?? '').trim();
  if (!cleaned) return { ok: false, error: 'name required — call mcp_analytics_list_context for the available files' };
  // Traversal guard: relative names only, resolved inside the directory.
  if (cleaned.includes('\0') || cleaned.includes('\\') || path.isAbsolute(cleaned)
    || cleaned.split('/').some(segment => segment === '..' || segment === '')) {
    return { ok: false, error: `invalid name "${cleaned}" — use a relative file name exactly as listed by mcp_analytics_list_context` };
  }
  const dir = resolveAnalyticsContextDir(db);
  const fullPath = path.resolve(dir, cleaned);
  if (fullPath !== dir && !fullPath.startsWith(dir + path.sep)) {
    return { ok: false, error: `invalid name "${cleaned}" — it resolves outside the analytics knowledge directory` };
  }
  if (!ALLOWED_EXTENSIONS.has(path.extname(fullPath).toLowerCase())) {
    return { ok: false, error: 'only .md and .txt knowledge files can be loaded' };
  }
  const library = analyticsLibraryMode(db);
  const notFound: LoadAnalyticsContextResult = { ok: false, error: `"${cleaned}" not found — call mcp_analytics_list_context for the current files` };
  if (library) {
    if (cleaned.toLowerCase() === 'guide.md') return notFound;
    try {
      const entry = fs.lstatSync(fullPath);
      if (entry.isSymbolicLink() || !entry.isFile()) return notFound;
      if (!isInsideDir(fs.realpathSync.native(fullPath), fs.realpathSync.native(dir))) {
        return { ok: false, error: `invalid name "${cleaned}" — it resolves outside the analytics knowledge directory` };
      }
    } catch (error) {
      const blocked = permissionProblem(error, dir);
      return blocked ? { ok: false, error: `${blocked.message} ${blocked.nextAction}` } : notFound;
    }
  }
  let raw: string;
  try {
    raw = fs.readFileSync(fullPath, 'utf8');
  } catch (error) {
    const blocked = library ? permissionProblem(error, dir) : null;
    return blocked ? { ok: false, error: `${blocked.message} ${blocked.nextAction}` } : notFound;
  }
  const manifest = readManifest(dir);
  const tagged = manifest.get(path.normalize(cleaned));
  const source: AnalyticsContextSource = tagged?.source
    ?? (cleaned.startsWith(`presets${path.sep}`) || cleaned.startsWith('presets/') ? 'etl-derived'
      : cleaned.startsWith(`lessons${path.sep}`) || cleaned.startsWith('lessons/') ? 'lesson'
        : 'user-dropped');
  // A part of the file when one is asked for, and a data dictionary's index by default (selectKnowledgeParts).
  const text = selectKnowledgeParts(raw, parts) ?? raw;
  const truncated = text.length > maxChars;
  const body = truncated
    ? `${text.slice(0, maxChars)}\n\n[Truncated at ${maxChars} of ${text.length} characters — the full file is at ${fullPath}.]`
    : text;
  const header = analyticsContextHeader(cleaned, source);
  return { ok: true, name: cleaned, source, content: `${header}${body}`, truncated };
}
