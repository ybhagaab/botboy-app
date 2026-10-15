/**
 * Deterministic helpers of the Knowledge library's write path (knowledge-library.md K17): names and paths that stay inside
 * the folder, the text view an edit runs on (LF inside, the file's own line endings and BOM restored), the gates a change
 * must pass before any model call, the source of an `import`, and the related files a guide check reads. No model call, no
 * database. Every refusal is a structured failure that names the next action.
 */
import fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { defaultAnalyticsLocalFilePolicy } from './analytics-local-file-source.js';
import { MAX_KNOWLEDGE_FILE_BYTES, type LibrarySet } from './knowledge-library.js';
import { isInside, sha256Hex } from './knowledge-fs.js';
import { rowFor } from './knowledge-rules.js';
import { type ParsedGuide } from './knowledge-guide.js';
import { GUIDE_FILE_NAME } from './knowledge-templates.js';
import { canonicalLocalPath } from './protected-local-resources.js';
import { detectSecrets, sensitiveLocalFileReason } from './sensitive-files.js';

export const MAX_SET_ID_CHARS = 120;
export const MAX_FILE_CHARS = 200;
export const MAX_SEGMENT = 80;
export const MAX_SUBFOLDERS = 3;
export const MAX_RESULT_BYTES = MAX_KNOWLEDGE_FILE_BYTES;
export const MAX_IMPORT_BYTES = 4 * 1024 * 1024;
const WRITABLE_EXTENSIONS = new Set(['.md', '.txt']);

export interface Failure { ok: false; code: string; message: string; nextAction: string; details?: Record<string, unknown> }
export const failure = (code: string, message: string, nextAction: string, details?: Record<string, unknown>): Failure => ({ ok: false, code, message, nextAction, ...(details ? { details } : {}) });

/**
 * A set-relative file id: segments of at most 80 characters, no `..`, backslash, NUL or hidden segment, at most 3 sub-folders.
 * A GUIDE.md has no folder part: the guide of a set is addressed as GUIDE.md of that set, and a nested set by its own id, so
 * `child/GUIDE.md` can neither edit the parent's guide under another name nor start a nested set unasked (P2 review R33).
 */
export function validateFileName(raw: unknown): { ok: true; name: string; segments: string[] } | Failure {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!value || value.length > MAX_FILE_CHARS || value.includes('\0') || value.includes('\\') || value.startsWith('/') || value.startsWith('~')) {
    return failure('invalid_path', 'The file name must be relative to its set: no leading slash, backslash or ~, at most 200 characters.', 'Use a name such as "notes.md" or "how-to/steps.md".');
  }
  const segments = value.split('/');
  if (segments.length - 1 > MAX_SUBFOLDERS || segments.some((segment) => segment === '' || segment === '.' || segment === '..' || segment.length > MAX_SEGMENT || segment.startsWith('.') || /[\u0000-\u001f]/.test(segment))) {
    return failure('invalid_path', `"${value.slice(0, 80)}" is not a valid file name (no "..", hidden folders, empty parts, parts over 80 characters, or more than three sub-folders).`, 'Use a plain relative name such as "notes.md".');
  }
  if (segments.length > 1 && segments[segments.length - 1].toLowerCase() === GUIDE_FILE_NAME.toLowerCase()) {
    return failure('invalid_path', `"${value.slice(0, 80)}" puts a folder in front of ${GUIDE_FILE_NAME}. A guide belongs to the set whose folder holds it.`, `Address a nested set by its own id (the set argument), and name its guide just ${GUIDE_FILE_NAME}.`);
  }
  return { ok: true, name: value, segments };
}

/** Writable types: `.md` and `.txt`, plus `.json` when the guide declares it; the content of a `.json` must parse. */
export function validateWritableType(name: string, guide: ParsedGuide | null, content: string | null): Failure | null {
  const extension = path.extname(name).toLowerCase();
  if (WRITABLE_EXTENSIONS.has(extension)) return null;
  if (extension === '.json' && guide?.frontMatter.writeTypes.includes('json')) {
    if (content !== null) {
      try { JSON.parse(content); } catch { return failure('invalid_json', `${name} must be valid JSON.`, 'Fix the JSON, then try again.'); }
    }
    return null;
  }
  return failure('unsupported_type', `${name} is not a writable type. BotBoy writes .md and .txt files${extension === '.json' ? ' (and .json only when the set\'s guide declares writeTypes: json)' : ''}.`, 'Use a .md or .txt name; YAML, SQL and other types are read-only.');
}

/** True for the files the server itself generates in the analytics set (lessons, the manifest, ETL-derived presets). */
export function generatedFileReason(set: LibrarySet | null, name: string): string | null {
  if (!set?.reserved) return null;
  const lower = name.toLowerCase();
  if (lower.startsWith('lessons/')) return 'lessons/ holds adopted lessons that BotBoy writes from its lessons ledger';
  if (lower === 'manifest.json') return 'manifest.json is BotBoy\'s own index of this set';
  const member = set.files.find((file) => file.name.toLowerCase() === lower);
  if (member?.analytics?.source === 'etl-derived') return 'this preset is generated from ETL profiles and would be overwritten';
  if (member?.analytics?.source === 'lesson') return 'this file is an adopted lesson projection';
  return null;
}

/** The root-relative POSIX path of an absolute path inside `root`. */
export function relativeToRoot(root: string, absolute: string): string {
  return path.relative(root, absolute).split(path.sep).join('/');
}

/**
 * Where `segments` sit inside `dir` (a set folder), with containment proven on REAL paths: the nearest existing ancestor
 * must resolve inside the real set folder, and an existing final component must be a regular file, not a link.
 */
export async function resolveInsideSet(dir: string, segments: readonly string[]): Promise<{ ok: true; absolute: string; exists: boolean } | Failure> {
  const absolute = path.join(dir, ...segments);
  // The name is judged as written first: a climb ("..") that lands outside the set on a path that does not exist yet has no
  // existing ancestor inside the set for the real-path walk below to judge, so only this check stops it.
  if (!isInside(path.resolve(dir), absolute)) return failure('invalid_path', 'That path leaves the set.', 'Choose a plain name inside the set.');
  const realDir = canonicalLocalPath(dir);
  let probe = absolute;
  for (;;) {
    try {
      const real = fs.realpathSync.native(probe);
      if (!isInside(realDir, real) && !isInside(canonicalLocalPath(realDir), canonicalLocalPath(real))) {
        return failure('invalid_path', 'That path resolves outside the set (a link or a changed folder).', 'Choose a plain name inside the set.');
      }
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') return failure('invalid_path', 'That path cannot be used.', 'Choose a different name.');
      const parent = path.dirname(probe);
      if (parent === probe || !isInside(dir, parent)) break;
      probe = parent;
    }
  }
  try {
    const stat = await fsp.lstat(absolute);
    if (stat.isSymbolicLink() || !stat.isFile()) return failure('invalid_path', 'That name is a link or not a regular file.', 'Choose a different name; links are never written.');
    return { ok: true, absolute, exists: true };
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return { ok: true, absolute, exists: false };
    return failure('root_unavailable', 'The folder could not be read.', 'Check Settings → Knowledge.');
  }
}

/** A file's text and the line-ending view an edit runs on. */
export interface TextView { bom: boolean; eol: '\n' | '\r\n'; lf: string }

export function viewOf(raw: string): TextView {
  const bom = raw.startsWith('\uFEFF');
  const body = bom ? raw.slice(1) : raw;
  const crlf = (body.match(/\r\n/g) ?? []).length;
  const lf = (body.match(/(?<!\r)\n/g) ?? []).length;
  return { bom, eol: crlf > lf ? '\r\n' : '\n', lf: body.replace(/\r\n?/g, '\n') };
}

export function restoreView(lf: string, view: Pick<TextView, 'bom' | 'eol'>): string {
  const text = view.eol === '\r\n' ? lf.replace(/\n/g, '\r\n') : lf;
  return (view.bom ? '\uFEFF' : '') + text;
}

/** Read a regular text file of the library: absent is null, a link, a binary or an oversize file is refused. */
export async function readLibraryText(absolute: string): Promise<{ ok: true; text: string | null; bytes: Buffer | null } | Failure> {
  try {
    const stat = await fsp.lstat(absolute);
    if (stat.isSymbolicLink() || !stat.isFile()) return failure('invalid_path', 'That is a link or not a regular file.', 'Choose a different file.');
    if (stat.size > MAX_KNOWLEDGE_FILE_BYTES) return failure('result_too_large', 'That file is larger than 4 MB, so it is not part of the library.', 'Split it into smaller files.');
    const bytes = await fsp.readFile(absolute);
    if (bytes.subarray(0, 8_192).includes(0)) return failure('not_text', 'That is not a text file.', 'Choose a text file.');
    return { ok: true, text: bytes.toString('utf8'), bytes };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT') return { ok: true, text: null, bytes: null };
    if (code === 'EPERM' || code === 'EACCES') return failure('root_unavailable', 'macOS has not allowed BotBoy to use this folder.', 'Open System Settings → Privacy & Security → Files and Folders and allow it, or choose another location in Settings → Knowledge.');
    return failure('internal_error', 'The file could not be read.', 'Run knowledge_list to see the current state.');
  }
}

export const hashText = (text: string | null): string | null => (text === null ? null : sha256Hex(text));

// ── Edits ──────────────────────────────────────────────────────────────────

export function applyEdits(before: string, edits: ReadonlyArray<{ find: string; replace: string }>): { ok: true; text: string } | Failure {
  let text = before;
  for (let index = 0; index < edits.length; index += 1) {
    const { find, replace } = edits[index];
    if (typeof find !== 'string' || typeof replace !== 'string' || !find) return failure('invalid_arguments', `edits[${index}] needs a non-empty find and a replace string.`, 'Fix the edit, then call again.');
    const first = text.indexOf(find);
    if (first < 0) return failure('edit_not_found', `edits[${index}].find does not occur in the file.`, 'knowledge_load the file again, copy the exact text to replace, then retry once.', { index });
    if (text.indexOf(find, first + 1) >= 0) return failure('edit_not_unique', `edits[${index}].find occurs more than once.`, 'Include enough surrounding text for it to occur exactly once, then retry.', { index });
    text = text.slice(0, first) + replace + text.slice(first + find.length);
  }
  return { ok: true, text };
}

// ── Imports ────────────────────────────────────────────────────────────────

export interface ImportSource { path: string; fileName: string; bytes: Buffer; sha256: string; text: string }

/**
 * The source of an `import`: `~/`, an absolute path or a path inside BotBoy's files workspace (no `..`), resolved on real
 * paths, a regular file, not BotBoy's private state (artifact downloads excepted), not a sensitive file, text, at most
 * 4 MB and free of secret formats. The same boundary the Data Room's local-file source applies.
 */
export function readImportSource(raw: unknown, libraryRoot: string): ImportSource | Failure {
  const policy = defaultAnalyticsLocalFilePolicy();
  const value = typeof raw === 'string' ? raw.trim() : '';
  const deny = (message: string) => failure('import_source_denied', message, 'Use a file in the files workspace or a path the owner named; to rearrange files already in the library use mode "move".');
  if (!value || value.includes('\0')) return deny('from must name one local file.');
  let candidate: string;
  if (value === '~' || value.startsWith('~/')) candidate = path.join(policy.homeDir, value.slice(1));
  else if (path.isAbsolute(value)) candidate = path.resolve(value);
  else {
    if (value.split(/[\\/]/).some((segment) => segment === '..')) return deny('A relative path may not contain "..".');
    candidate = path.resolve(policy.filesDir, value);
  }
  let real: string;
  let stat: fs.Stats;
  try {
    real = fs.realpathSync.native(candidate);
    stat = fs.statSync(real);
  } catch {
    return failure('import_source_denied', 'That file could not be read.', 'Use the exact path of an existing file.');
  }
  if (!stat.isFile()) return deny('That is not a regular file.');
  const privateRoot = canonicalLocalPath(policy.privateRoot);
  const inArtifactFolder = policy.artifactDirs.map(canonicalLocalPath).some((directory) => isInside(directory, real));
  // Hidden files and folders are never imported (a dotfile such as .env, anything under ~/.config), BotBoy's own download
  // folders excepted: they sit inside a hidden folder by design.
  if (!inArtifactFolder && real.split(path.sep).some((segment) => segment.startsWith('.') && segment !== '.' && segment !== '..')) return deny('That file is hidden or lies in a hidden folder.');
  if (isInside(privateRoot, real) && !inArtifactFolder) return deny('That file is BotBoy private state.');
  if (isInside(canonicalLocalPath(libraryRoot), real)) return deny('That file is already inside the library.');
  // BotBoy's own download folders sit inside a hidden folder by design; the path rule is for the owner's files elsewhere.
  if (!inArtifactFolder && sensitiveLocalFileReason(real, stat.size)) return deny('That file looks sensitive (a credential, key or hidden folder).');
  if (stat.size < 1 || stat.size > MAX_IMPORT_BYTES) return deny('The file must be between 1 byte and 4 MB.');
  const bytes = fs.readFileSync(real);
  if (bytes.subarray(0, 8_192).includes(0)) return failure('not_text', 'That file is not text.', 'Import a text file (.md or .txt).');
  const text = bytes.toString('utf8');
  const secrets = detectSecrets(text);
  if (secrets.length > 0) return failure('secret_in_content', 'That file contains what looks like a credential, so it is not imported.', 'Remove the credential from the file first.');
  return { path: real, fileName: path.basename(real), bytes, sha256: sha256Hex(bytes), text };
}

/** Re-read an import source at apply time; the pinned bytes must still be what is there. */
export function importSourceStillMatches(source: { path: string; sha256: string }): boolean {
  try {
    return sha256Hex(fs.readFileSync(source.path)) === source.sha256;
  } catch {
    return false;
  }
}

// ── Related files for the check ────────────────────────────────────────────

/**
 * The files a check should read next to the target: the files named in a guardrail that mentions the target, and the
 * neighbours of the target in the Conflict Priority Order (stems matched best effort); at most three.
 */
export function tiedFileNames(guide: ParsedGuide, set: LibrarySet | null, targetFile: string): string[] {
  if (!set) return [];
  const stemOf = (file: string) => file.replace(/^.*\//, '').replace(/\.[^.]+$/, '').toLowerCase();
  const names = new Map(set.files.map((file) => [file.name.toLowerCase(), file.name]));
  const byStem = new Map(set.files.map((file) => [stemOf(file.name), file.name]));
  const target = stemOf(targetFile);
  const found: string[] = [];
  const add = (name: string | undefined) => { if (name && stemOf(name) !== target && !found.includes(name)) found.push(name); };
  const targetRow = rowFor(guide, targetFile, set.files.map((file) => file.name));
  const targetMentioned = (text: string) => text.toLowerCase().includes(target) || (targetRow?.file ? text.toLowerCase().includes(stemOf(targetRow.file)) : false);
  for (const rule of guide.guardrails) {
    if (!targetMentioned(rule)) continue;
    for (const file of set.files) if (rule.toLowerCase().includes(stemOf(file.name))) add(names.get(file.name.toLowerCase()));
  }
  const order = guide.conflictOrder ?? [];
  const role = (label: string): string | undefined => {
    const clean = label.toLowerCase();
    for (const entry of guide.methodology) if (entry.file && entry.label.toLowerCase().includes(clean.split(' ')[0])) return byStem.get(stemOf(entry.file));
    return byStem.get(stemOf(clean.replace(/\s+/g, '_'))) ?? byStem.get(stemOf(clean.replace(/\s+/g, '-')));
  };
  const resolved = order.map(role);
  const at = resolved.findIndex((name) => name && stemOf(name) === target);
  if (at >= 0) { add(resolved[at - 1]); add(resolved[at + 1]); }
  return found.slice(0, 3);
}
