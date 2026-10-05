/**
 * File references: data and code files in watched folders (owner decision
 * 2026-10-04).
 *
 * BotBoy needs to know these files exist and which project they belong to,
 * not to read them. A reference is ONE `work_items` row per file path
 * (`type = 'file_reference'`) holding the path, format, size, modified time,
 * and a deterministic outline taken from the file's first 64 KB: field names,
 * top-level keys, columns, or code symbols, plus a code file's own header
 * comment. A change updates that row in place, so there are no versions,
 * extraction, model calls, brain synthesis, gists, or Today entries. When
 * the owner asks, chat reads the file itself with `run_command`.
 *
 * Before this, every version of every data file was read, stored, routed,
 * folded into briefs, and gisted. Data files were 93% of local storage
 * (1,335 of 1,428 MB), and one 2.4 MB training log cost 3 model calls every
 * 31 minutes.
 *
 * Routing is deterministic: a reference follows the routed documents nearest
 * to it in the folder tree (`folderProject`). A folder whose nearest
 * documents disagree leaves the reference unassigned rather than guessing.
 */

import { closeSync, openSync, readSync } from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import type Database from 'better-sqlite3';
import type { ContentStore } from './content-store.js';
import { refToColumns } from './content-store.js';
import type { RawWorkItem } from './types.js';
import { deleteWorkItemFts } from './work-items-fts.js';
import { getSetting, setSetting } from './storage.js';
import { recordRoutingDecision } from './pipeline-audit.js';

export const FILE_REFERENCE_TYPE = 'file_reference' as const;

/** How BotBoy treats a local file: read it (`document`) or record it (`data`, `code`). */
export type LocalFileRole = 'document' | 'data' | 'code';

/** Bytes read from a reference file to build its outline. Nothing else is read. */
export const REFERENCE_HEAD_BYTES = 64 * 1024;
/** Bytes read from a file with no extension to decide its role. */
export const ROLE_SNIFF_BYTES = 8 * 1024;

const OUTLINE_MAX_NAMES = 24;
const SUMMARY_MAX_CHARS = 280;
const NAME_MAX_CHARS = 60;

type FormatNoun = 'data' | 'log' | 'model' | 'code' | 'config';

interface FormatInfo { label: string; noun: FormatNoun; binary?: boolean }

/** Data formats: tables, records, logs, arrays, and model weights. */
const DATA_FORMATS: ReadonlyMap<string, FormatInfo> = new Map([
  ['.json', { label: 'JSON', noun: 'data' }],
  ['.jsonl', { label: 'JSON Lines', noun: 'data' }],
  ['.ndjson', { label: 'JSON Lines', noun: 'data' }],
  ['.geojson', { label: 'GeoJSON', noun: 'data' }],
  ['.csv', { label: 'CSV', noun: 'data' }],
  ['.tsv', { label: 'TSV', noun: 'data' }],
  ['.xml', { label: 'XML', noun: 'data' }],
  ['.log', { label: 'Log', noun: 'log' }],
  ['.parquet', { label: 'Parquet', noun: 'data', binary: true }],
  ['.avro', { label: 'Avro', noun: 'data', binary: true }],
  ['.orc', { label: 'ORC', noun: 'data', binary: true }],
  ['.feather', { label: 'Feather', noun: 'data', binary: true }],
  ['.arrow', { label: 'Arrow', noun: 'data', binary: true }],
  ['.msgpack', { label: 'MessagePack', noun: 'data', binary: true }],
  ['.npy', { label: 'NumPy array', noun: 'data', binary: true }],
  ['.npz', { label: 'NumPy archive', noun: 'data', binary: true }],
  ['.mat', { label: 'MATLAB', noun: 'data', binary: true }],
  ['.h5', { label: 'HDF5', noun: 'data', binary: true }],
  ['.hdf5', { label: 'HDF5', noun: 'data', binary: true }],
  ['.tfrecord', { label: 'TFRecord', noun: 'data', binary: true }],
  ['.pkl', { label: 'Pickle', noun: 'data', binary: true }],
  ['.pickle', { label: 'Pickle', noun: 'data', binary: true }],
  ['.joblib', { label: 'Joblib', noun: 'model', binary: true }],
  ['.pt', { label: 'PyTorch', noun: 'model', binary: true }],
  ['.pth', { label: 'PyTorch', noun: 'model', binary: true }],
  ['.ckpt', { label: 'Checkpoint', noun: 'model', binary: true }],
  ['.safetensors', { label: 'Safetensors', noun: 'model', binary: true }],
  ['.onnx', { label: 'ONNX', noun: 'model', binary: true }],
  ['.gguf', { label: 'GGUF', noun: 'model', binary: true }],
]);

/** Source code, build files, and configuration. */
const CODE_FORMATS: ReadonlyMap<string, FormatInfo> = new Map([
  ['.py', { label: 'Python', noun: 'code' }],
  ['.pyi', { label: 'Python stub', noun: 'code' }],
  ['.ipynb', { label: 'Jupyter notebook', noun: 'code' }],
  ['.js', { label: 'JavaScript', noun: 'code' }],
  ['.mjs', { label: 'JavaScript', noun: 'code' }],
  ['.cjs', { label: 'JavaScript', noun: 'code' }],
  ['.jsx', { label: 'JavaScript (JSX)', noun: 'code' }],
  ['.ts', { label: 'TypeScript', noun: 'code' }],
  ['.mts', { label: 'TypeScript', noun: 'code' }],
  ['.cts', { label: 'TypeScript', noun: 'code' }],
  ['.tsx', { label: 'TypeScript (TSX)', noun: 'code' }],
  ['.vue', { label: 'Vue', noun: 'code' }],
  ['.svelte', { label: 'Svelte', noun: 'code' }],
  ['.go', { label: 'Go', noun: 'code' }],
  ['.rs', { label: 'Rust', noun: 'code' }],
  ['.java', { label: 'Java', noun: 'code' }],
  ['.kt', { label: 'Kotlin', noun: 'code' }],
  ['.kts', { label: 'Kotlin script', noun: 'code' }],
  ['.scala', { label: 'Scala', noun: 'code' }],
  ['.groovy', { label: 'Groovy', noun: 'code' }],
  ['.gradle', { label: 'Gradle', noun: 'code' }],
  ['.swift', { label: 'Swift', noun: 'code' }],
  ['.m', { label: 'Objective-C/MATLAB', noun: 'code' }],
  ['.mm', { label: 'Objective-C++', noun: 'code' }],
  ['.c', { label: 'C', noun: 'code' }],
  ['.h', { label: 'C header', noun: 'code' }],
  ['.cc', { label: 'C++', noun: 'code' }],
  ['.cpp', { label: 'C++', noun: 'code' }],
  ['.cxx', { label: 'C++', noun: 'code' }],
  ['.hpp', { label: 'C++ header', noun: 'code' }],
  ['.hh', { label: 'C++ header', noun: 'code' }],
  ['.cs', { label: 'C#', noun: 'code' }],
  ['.fs', { label: 'F#', noun: 'code' }],
  ['.rb', { label: 'Ruby', noun: 'code' }],
  ['.php', { label: 'PHP', noun: 'code' }],
  ['.pl', { label: 'Perl', noun: 'code' }],
  ['.pm', { label: 'Perl', noun: 'code' }],
  ['.lua', { label: 'Lua', noun: 'code' }],
  ['.r', { label: 'R', noun: 'code' }],
  ['.jl', { label: 'Julia', noun: 'code' }],
  ['.dart', { label: 'Dart', noun: 'code' }],
  ['.ex', { label: 'Elixir', noun: 'code' }],
  ['.exs', { label: 'Elixir', noun: 'code' }],
  ['.erl', { label: 'Erlang', noun: 'code' }],
  ['.hs', { label: 'Haskell', noun: 'code' }],
  ['.clj', { label: 'Clojure', noun: 'code' }],
  ['.cljs', { label: 'ClojureScript', noun: 'code' }],
  ['.elm', { label: 'Elm', noun: 'code' }],
  ['.ml', { label: 'OCaml', noun: 'code' }],
  ['.zig', { label: 'Zig', noun: 'code' }],
  ['.sol', { label: 'Solidity', noun: 'code' }],
  ['.sh', { label: 'Shell', noun: 'code' }],
  ['.bash', { label: 'Shell', noun: 'code' }],
  ['.zsh', { label: 'Shell', noun: 'code' }],
  ['.fish', { label: 'Shell', noun: 'code' }],
  ['.ps1', { label: 'PowerShell', noun: 'code' }],
  ['.bat', { label: 'Batch', noun: 'code' }],
  ['.cmd', { label: 'Batch', noun: 'code' }],
  ['.sql', { label: 'SQL', noun: 'code' }],
  ['.graphql', { label: 'GraphQL', noun: 'code' }],
  ['.gql', { label: 'GraphQL', noun: 'code' }],
  ['.proto', { label: 'Protocol Buffers', noun: 'code' }],
  ['.thrift', { label: 'Thrift', noun: 'code' }],
  ['.css', { label: 'CSS', noun: 'code' }],
  ['.scss', { label: 'Sass', noun: 'code' }],
  ['.sass', { label: 'Sass', noun: 'code' }],
  ['.less', { label: 'Less', noun: 'code' }],
  ['.tf', { label: 'Terraform', noun: 'code' }],
  ['.hcl', { label: 'HCL', noun: 'config' }],
  ['.cmake', { label: 'CMake', noun: 'code' }],
  ['.mk', { label: 'Makefile', noun: 'code' }],
  ['.bzl', { label: 'Bazel', noun: 'code' }],
  ['.bazel', { label: 'Bazel', noun: 'code' }],
  ['.nix', { label: 'Nix', noun: 'code' }],
  ['.dockerfile', { label: 'Dockerfile', noun: 'code' }],
  ['.yaml', { label: 'YAML', noun: 'config' }],
  ['.yml', { label: 'YAML', noun: 'config' }],
  ['.toml', { label: 'TOML', noun: 'config' }],
  ['.ini', { label: 'INI', noun: 'config' }],
  ['.cfg', { label: 'Config', noun: 'config' }],
  ['.conf', { label: 'Config', noun: 'config' }],
  ['.properties', { label: 'Properties', noun: 'config' }],
  ['.lock', { label: 'Lockfile', noun: 'config' }],
]);

/** Build and project files known by name. */
const CODE_FILENAMES: ReadonlyMap<string, FormatInfo> = new Map([
  ['makefile', { label: 'Makefile', noun: 'code' }],
  ['gnumakefile', { label: 'Makefile', noun: 'code' }],
  ['dockerfile', { label: 'Dockerfile', noun: 'code' }],
  ['containerfile', { label: 'Dockerfile', noun: 'code' }],
  ['jenkinsfile', { label: 'Jenkinsfile', noun: 'code' }],
  ['procfile', { label: 'Procfile', noun: 'config' }],
  ['gemfile', { label: 'Gemfile', noun: 'config' }],
  ['rakefile', { label: 'Rakefile', noun: 'code' }],
  ['vagrantfile', { label: 'Vagrantfile', noun: 'code' }],
  ['brewfile', { label: 'Brewfile', noun: 'config' }],
  ['podfile', { label: 'Podfile', noun: 'config' }],
  ['build', { label: 'Bazel build', noun: 'code' }],
  ['workspace', { label: 'Bazel workspace', noun: 'code' }],
  ['config', { label: 'Brazil config', noun: 'config' }],
  ['cmakelists.txt', { label: 'CMake', noun: 'code' }],
  ['constraints.txt', { label: 'pip constraints', noun: 'config' }],
]);

const CODE_FILENAME_PATTERNS: ReadonlyArray<readonly [RegExp, FormatInfo]> = [
  [/^requirements[\w.-]*\.txt$/, { label: 'pip requirements', noun: 'config' }],
  [/^dockerfile\..+$/, { label: 'Dockerfile', noun: 'code' }],
];

function namedFormat(lowerName: string): FormatInfo | undefined {
  const byName = CODE_FILENAMES.get(lowerName);
  if (byName) return byName;
  for (const [pattern, info] of CODE_FILENAME_PATTERNS) if (pattern.test(lowerName)) return info;
  return undefined;
}

/**
 * The role a path implies. `sniff` means the file has no extension and no
 * known name; `roleFromHead` decides from its first bytes.
 */
export function localFileRoleForPath(filePath: string): LocalFileRole | 'sniff' {
  const name = path.basename(filePath).toLowerCase();
  if (namedFormat(name)) return 'code';
  const ext = path.extname(name);
  if (DATA_FORMATS.has(ext)) return 'data';
  if (CODE_FORMATS.has(ext)) return 'code';
  return ext === '' ? 'sniff' : 'document';
}

/**
 * Role of a file with no extension, from its first bytes: content-addressed
 * blobs (model caches name files by hash), binaries, and JSON are data; a
 * script with a shebang is code; anything else is read like a document
 * (README, LICENSE, notes).
 */
export function roleFromHead(filePath: string, head: Buffer): LocalFileRole {
  if (/^[0-9a-f]{32,}$/i.test(path.basename(filePath))) return 'data';
  if (head.includes(0)) return 'data';
  const text = head.toString('utf8').replace(/^\uFEFF/, '').trimStart();
  if (text.startsWith('{') || text.startsWith('[')) return 'data';
  if (text.startsWith('#!')) return 'code';
  return 'document';
}

export function isReferenceRole(role: LocalFileRole | 'sniff'): role is 'data' | 'code' {
  return role === 'data' || role === 'code';
}

/** Binary data formats are recorded from their name and size alone. */
export function isBinaryReferenceFormat(filePath: string): boolean {
  return DATA_FORMATS.get(path.extname(filePath).toLowerCase())?.binary === true;
}

/** First `bytes` of a file, or null when it cannot be read. */
export function readFileHead(filePath: string, bytes: number): Buffer | null {
  let fd: number | null = null;
  try {
    fd = openSync(filePath, 'r');
    const buffer = Buffer.alloc(bytes);
    const read = readSync(fd, buffer, 0, bytes, 0);
    return buffer.subarray(0, read);
  } catch {
    return null;
  } finally {
    if (fd != null) try { closeSync(fd); } catch { /* ignore */ }
  }
}

// ── Outline ─────────────────────────────────────────────────────────────────

export interface FileReferenceInput {
  filePath: string;
  /** Watched folder root, for the relative path shown to the owner. */
  rootPath?: string | null;
  role: 'data' | 'code';
  /** Decoded head text, or null for binary formats and unreadable files. */
  head: string | null;
  /** True when `head` holds the whole file. */
  complete: boolean;
  size: number;
  mtimeMs: number;
}

export interface FileReferenceRecord {
  format: string;
  noun: FormatNoun;
  /** One line for lists and search: format, size, header, outline. */
  summary: string;
  /** Stored body and search text. */
  text: string;
  outlineLabel: string;
  outline: string[];
  /** First sentence of a code file's leading comment. */
  header: string | null;
  /** Line count, when the whole file was read. */
  lines: number | null;
  /** Folder-relative path shown to the owner. */
  displayPath: string;
}

function formatInfoFor(filePath: string, role: 'data' | 'code', head: string | null): FormatInfo {
  const lower = path.basename(filePath).toLowerCase();
  const known = namedFormat(lower) ?? DATA_FORMATS.get(path.extname(lower)) ?? CODE_FORMATS.get(path.extname(lower));
  if (known) return known;
  if (role === 'code') return { label: 'Script', noun: 'code' };
  const trimmed = (head ?? '').trimStart();
  return trimmed.startsWith('{') || trimmed.startsWith('[')
    ? { label: 'JSON', noun: 'data' }
    : { label: 'Binary', noun: 'data', binary: true };
}

/** Lines in a whole file: a final newline ends the last line, it does not start another. */
function lineCount(text: string): number {
  if (!text) return 0;
  let newlines = 0;
  for (let index = text.indexOf('\n'); index >= 0; index = text.indexOf('\n', index + 1)) newlines++;
  return text.endsWith('\n') ? newlines : newlines + 1;
}

export function humanFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return 'unknown size';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  return `${value >= 10 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

function pushName(names: string[], value: string): void {
  const name = value.replace(/\s+/g, ' ').trim().slice(0, NAME_MAX_CHARS);
  if (name && !names.includes(name) && names.length < OUTLINE_MAX_NAMES) names.push(name);
}

/** A key or column that names a field, not a value (an email, a number, an id, a sentence). */
function looksLikeFieldName(value: string): boolean {
  const name = value.trim();
  if (name.length === 0 || name.length > 48) return false;
  if (/@/.test(name)) return false;
  if (/^[-+]?\d[\d.,:\-/ ]*$/.test(name)) return false;
  if (/^[0-9a-f]{16,}$/i.test(name)) return false;
  return /^[\p{L}_$][\p{L}\p{N} _.()\/%#$:-]*$/u.test(name);
}

function fieldNames(candidates: string[]): { names: string[]; identifierLike: boolean } {
  const names = candidates.filter(looksLikeFieldName);
  return { names, identifierLike: candidates.length > 0 && names.length < candidates.length / 2 };
}

/** Keys at the top level of the JSON object that starts at `start`. Tolerates truncation. */
function objectKeys(text: string, start: number): string[] {
  const keys: string[] = [];
  let depth = 0;
  let expectingKey = false;
  for (let index = start; index < text.length && keys.length < OUTLINE_MAX_NAMES * 2; index++) {
    const ch = text[index];
    if (ch === '"') {
      let end = index + 1;
      let value = '';
      while (end < text.length && text[end] !== '"') {
        if (text[end] === '\\') { value += text[end + 1] ?? ''; end += 2; continue; }
        value += text[end];
        end++;
      }
      if (end >= text.length) break; // truncated inside a string
      if (depth === 1 && expectingKey) {
        let next = end + 1;
        while (next < text.length && /\s/.test(text[next])) next++;
        if (text[next] === ':') {
          if (!keys.includes(value)) keys.push(value);
          expectingKey = false;
        }
      }
      index = end;
      continue;
    }
    if (ch === '{' || ch === '[') {
      depth++;
      if (depth === 1) expectingKey = ch === '{';
      continue;
    }
    if (ch === '}' || ch === ']') {
      depth--;
      if (depth <= 0) break;
      continue;
    }
    if (ch === ',' && depth === 1) expectingKey = true;
  }
  return keys;
}

function jsonOutline(text: string): { label: string; names: string[] } | null {
  const body = text.replace(/^\uFEFF/, '');
  const first = body.search(/\S/);
  if (first < 0) return null;
  if (body[first] === '{') {
    const { names, identifierLike } = fieldNames(objectKeys(body, first));
    return identifierLike
      ? { label: 'Top-level keys', names: ['identifier-like keys'] }
      : { label: 'Top-level keys', names };
  }
  if (body[first] === '[') {
    const element = body.slice(first + 1).search(/\S/);
    const at = element < 0 ? -1 : first + 1 + element;
    if (at >= 0 && body[at] === '{') {
      const { names } = fieldNames(objectKeys(body, at));
      return { label: 'Record fields', names };
    }
    return { label: 'Array', names: [] };
  }
  return null;
}

function jsonLinesOutline(text: string): { label: string; names: string[] } | null {
  const line = text.split(/\r?\n/).find((candidate) => candidate.trim() !== '');
  if (!line) return null;
  const start = line.indexOf('{');
  if (start < 0) return null;
  const { names } = fieldNames(objectKeys(line, start));
  return { label: 'Record fields', names };
}

function delimitedOutline(text: string, ext: string): { label: string; names: string[] } | null {
  const line = text.replace(/^\uFEFF/, '').split(/\r?\n/, 1)[0] ?? '';
  if (!line.trim()) return null;
  const delimiter = ext === '.tsv' ? '\t' : (!line.includes(',') && line.includes(';') ? ';' : ',');
  const cells: string[] = [];
  let current = '';
  let quoted = false;
  for (const ch of line) {
    if (ch === '"') { quoted = !quoted; continue; }
    if (ch === delimiter && !quoted) { cells.push(current.trim()); current = ''; continue; }
    current += ch;
  }
  cells.push(current.trim());
  // A first row of values (no header) must not become "columns": it is data.
  const header = cells.every((cell) => cell === '' || looksLikeFieldName(cell));
  return header
    ? { label: 'Columns', names: cells.filter(Boolean) }
    : { label: 'Columns', names: [`${cells.length} columns, no header row`] };
}

function xmlOutline(text: string): { label: string; names: string[] } {
  const names: string[] = [];
  for (const match of text.matchAll(/<([A-Za-z_][\w:.-]*)[\s>/]/g)) {
    pushName(names, match[1]);
    if (names.length >= 12) break;
  }
  return { label: 'Elements', names };
}

function notebookOutline(text: string): { header: string | null; label: string; names: string[] } {
  const heading = text.match(/"source"\s*:\s*\[\s*"#{1,3}\s+([^"\\]{3,120})/)?.[1] ?? null;
  const language = text.match(/"language"\s*:\s*"([^"]{1,30})"/)?.[1];
  return { header: heading, label: 'Language', names: language ? [language] : [] };
}

/** First sentence of the comment a code file opens with (license boilerplate skipped). */
export function leadingComment(text: string): string | null {
  let rest = text.replace(/^\uFEFF/, '');
  rest = rest.replace(/^#![^\n]*\n/, '').replace(/^#[^\n]*coding[:=][^\n]*\n/, '').trimStart();
  let body: string | null = null;
  const quote = rest.slice(0, 3);
  if (quote === '"""' || quote === "'''") {
    const end = rest.indexOf(quote, 3);
    body = end > 3 ? rest.slice(3, end) : null;
  } else if (rest.startsWith('/*')) {
    const end = rest.indexOf('*/');
    body = end > 2 ? rest.slice(2, end) : null;
  } else {
    const marker = rest.match(/^(\/\/|#|--|;)/)?.[1];
    if (marker) {
      const lines: string[] = [];
      for (const line of rest.split('\n')) {
        const trimmed = line.trimStart();
        if (!trimmed.startsWith(marker)) break;
        lines.push(trimmed.slice(marker.length));
        if (lines.length >= 12) break;
      }
      body = lines.join('\n');
    }
  }
  if (!body) return null;
  const cleaned = body
    .split('\n')
    .map((line) => line.replace(/^\s*\*+\s?/, '').replace(/^\s*(?:\/\/|#|--|;)\s?/, ''))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (cleaned.length < 8) return null;
  if (/copyright|\blicen[cs]e|spdx|all rights reserved|eslint-|@ts-|prettier-ignore|^-\*-|^vim:/i.test(cleaned.slice(0, 100))) return null;
  const sentence = cleaned.match(/^(.{8,200}?[.!?])(?:\s|$)/)?.[1] ?? cleaned.slice(0, 160);
  return sentence.trim();
}

const SYMBOL_PATTERNS: ReadonlyMap<string, ReadonlyArray<RegExp>> = new Map([
  ['Python', [/^(?:async\s+)?def\s+([A-Za-z_]\w*)/gm, /^class\s+([A-Za-z_]\w*)/gm]],
  ['Python stub', [/^(?:async\s+)?def\s+([A-Za-z_]\w*)/gm, /^class\s+([A-Za-z_]\w*)/gm]],
  ['JavaScript', [/^(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function\*?|class|const|let|var)\s+([A-Za-z_$][\w$]*)/gm]],
  ['TypeScript', [/^(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:function\*?|class|interface|type|enum|const|let|var|namespace)\s+([A-Za-z_$][\w$]*)/gm]],
  ['Go', [/^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/gm, /^type\s+([A-Za-z_]\w*)/gm]],
  ['Rust', [/^(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:fn|struct|enum|trait|mod|type|const|static)\s+([A-Za-z_]\w*)/gm]],
  ['Java', [/^(?:public\s+|final\s+|abstract\s+|sealed\s+)*(?:class|interface|enum|record)\s+([A-Za-z_]\w*)/gm]],
  ['Kotlin', [/^(?:public\s+|internal\s+|private\s+|data\s+|sealed\s+|open\s+|abstract\s+)*(?:class|interface|object|fun|enum\s+class)\s+([A-Za-z_]\w*)/gm]],
  ['Swift', [/^(?:public\s+|open\s+|final\s+|internal\s+)*(?:class|struct|enum|protocol|extension|func)\s+([A-Za-z_]\w*)/gm]],
  ['C#', [/^\s{0,4}(?:public\s+|internal\s+|static\s+|sealed\s+|abstract\s+|partial\s+)*(?:class|interface|enum|struct|record)\s+([A-Za-z_]\w*)/gm]],
  ['Ruby', [/^\s{0,2}(?:class|module|def)\s+([A-Za-z_][\w:.?!]*)/gm]],
  ['PHP', [/^\s*(?:abstract\s+|final\s+)?(?:class|interface|trait|function)\s+([A-Za-z_]\w*)/gm]],
  ['Shell', [/^(?:function\s+)?([A-Za-z_][\w-]*)\s*\(\)\s*\{/gm, /^function\s+([A-Za-z_][\w-]*)/gm]],
  ['C', [/^(?:typedef\s+)?(?:struct|enum|union)\s+([A-Za-z_]\w*)/gm]],
  ['C header', [/^(?:typedef\s+)?(?:struct|enum|union)\s+([A-Za-z_]\w*)/gm]],
  ['C++', [/^(?:template\s*<[^>]*>\s*)?(?:class|struct|enum(?:\s+class)?|namespace)\s+([A-Za-z_]\w*)/gm]],
  ['C++ header', [/^(?:template\s*<[^>]*>\s*)?(?:class|struct|enum(?:\s+class)?|namespace)\s+([A-Za-z_]\w*)/gm]],
]);

function symbolOutline(format: FormatInfo, text: string): { label: string; names: string[] } | null {
  const base = format.label.replace(/ \((?:JSX|TSX)\)$/, '');
  const labelKey = base === 'TypeScript' || base === 'JavaScript' ? base : format.label;
  if (format.label === 'YAML') {
    const names: string[] = [];
    for (const match of text.matchAll(/^([A-Za-z_][\w.-]*)\s*:(?:\s|$)/gm)) pushName(names, match[1]);
    return { label: 'Keys', names };
  }
  if (format.label === 'TOML' || format.label === 'INI' || format.label === 'Config') {
    const names: string[] = [];
    for (const match of text.matchAll(/^\s*\[{1,2}([^\]\n]+)\]{1,2}\s*$/gm)) pushName(names, match[1]);
    if (names.length === 0) for (const match of text.matchAll(/^([A-Za-z_][\w.-]*)\s*=/gm)) pushName(names, match[1]);
    return { label: names.length ? 'Sections' : 'Keys', names };
  }
  if (format.label === 'Properties') {
    const names: string[] = [];
    for (const match of text.matchAll(/^([A-Za-z_][\w.-]*)\s*[=:]/gm)) pushName(names, match[1]);
    return { label: 'Keys', names };
  }
  if (format.label === 'Makefile') {
    const names: string[] = [];
    for (const match of text.matchAll(/^([A-Za-z0-9_][A-Za-z0-9_./-]*)\s*:(?!=)/gm)) {
      if (!match[1].startsWith('.')) pushName(names, match[1]);
    }
    return { label: 'Targets', names };
  }
  if (format.label === 'Dockerfile') {
    const names: string[] = [];
    for (const match of text.matchAll(/^FROM\s+(\S+)/gim)) pushName(names, match[1]);
    return { label: 'Base images', names };
  }
  if (format.label === 'SQL') {
    const names: string[] = [];
    const pattern = /\bcreate\s+(?:or\s+replace\s+)?(?:temp(?:orary)?\s+)?(table|view|materialized\s+view|function|procedure|index|schema)\s+(?:if\s+not\s+exists\s+)?([A-Za-z_"][\w."]*)/gi;
    for (const match of text.matchAll(pattern)) pushName(names, `${match[1].toLowerCase().replace(/\s+/g, ' ')} ${match[2].replace(/"/g, '')}`);
    return { label: 'Creates', names };
  }
  const patterns = SYMBOL_PATTERNS.get(labelKey);
  if (!patterns) return null;
  const found: Array<{ at: number; name: string }> = [];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) found.push({ at: match.index ?? 0, name: match[1] });
  }
  const names: string[] = [];
  for (const entry of found.sort((a, b) => a.at - b.at)) pushName(names, entry.name);
  return { label: 'Defines', names };
}

/**
 * The reference for one file: deterministic, from its path, size, and first
 * bytes. The caller has already checked those bytes for secrets.
 */
export function buildFileReference(input: FileReferenceInput): FileReferenceRecord {
  const ext = path.extname(input.filePath).toLowerCase();
  const format = formatInfoFor(input.filePath, input.role, input.head);
  const head = format.binary ? null : input.head;
  let outline: { label: string; names: string[] } | null = null;
  let header: string | null = null;
  if (head) {
    if (format.label === 'Jupyter notebook') {
      const notebook = notebookOutline(head);
      header = notebook.header;
      outline = { label: notebook.label, names: notebook.names };
    } else if (format.label === 'JSON Lines') outline = jsonLinesOutline(head);
    else if (format.label === 'JSON' || format.label === 'GeoJSON') outline = jsonOutline(head);
    else if (ext === '.csv' || ext === '.tsv') outline = delimitedOutline(head, ext);
    else if (format.label === 'XML') outline = xmlOutline(head);
    else if (format.noun === 'code' || format.noun === 'config') {
      header = leadingComment(head);
      outline = symbolOutline(format, head);
    }
    // Logs: name and size only. Their lines are data, often personal.
  }
  const names = outline?.names ?? [];
  const lines = head && input.complete ? lineCount(head) : null;
  const root = input.rootPath ? path.resolve(input.rootPath) : null;
  const relative = root && input.filePath.startsWith(root + path.sep)
    ? path.join(path.basename(root), path.relative(root, input.filePath))
    : input.filePath;
  const size = humanFileSize(input.size);
  const modified = Number.isFinite(input.mtimeMs) && input.mtimeMs > 0
    ? new Date(input.mtimeMs).toISOString().slice(0, 10)
    : null;

  // "JSON data", "Python code", "YAML config"; a label that already names
  // its kind stands alone ("Log", "Config").
  const kind = format.label.toLowerCase() === format.noun ? format.label : `${format.label} ${format.noun}`;
  const lineText = lines ? `${lines.toLocaleString('en-US')} line${lines === 1 ? '' : 's'}` : '';
  const summaryParts = [`${kind}, ${size}${lineText ? `, ${lineText}` : ''}`];
  if (header) summaryParts.push(header.replace(/[.!?]$/, ''));
  if (names.length) summaryParts.push(`${outline!.label}: ${names.slice(0, 10).join(', ')}${names.length > 10 ? ', …' : ''}`);
  let summary = summaryParts.join('. ');
  if (summary.length > SUMMARY_MAX_CHARS) summary = `${summary.slice(0, SUMMARY_MAX_CHARS - 1)}…`;

  const textLines = [
    relative,
    `${kind} · ${size}${lineText ? ` · ${lineText}` : ''}${modified ? ` · modified ${modified}` : ''}`,
  ];
  if (header) textLines.push(`Header: ${header}`);
  if (names.length) textLines.push(`${outline!.label}: ${names.join(', ')}`);
  textLines.push('BotBoy records this file without reading it. Open it with run_command when it is needed.');

  return {
    format: format.label,
    noun: format.noun,
    summary,
    text: textLines.join('\n'),
    outlineLabel: outline?.label ?? '',
    outline: names,
    header,
    lines,
    displayPath: relative,
  };
}

/**
 * The first 64 KB of a reference file as text, or null for binary formats,
 * binary content (a NUL byte), and unreadable files. `complete` is true when
 * the head holds the whole file. The caller checks the text for secrets.
 */
export function readReferenceHead(filePath: string, size: number): { head: string | null; complete: boolean } {
  if (isBinaryReferenceFormat(filePath)) return { head: null, complete: false };
  const bytes = readFileHead(filePath, REFERENCE_HEAD_BYTES);
  if (!bytes || bytes.includes(0)) return { head: null, complete: false };
  return { head: bytes.toString('utf8'), complete: size <= bytes.length };
}

/**
 * The metadata a reference row carries. The monitor and the one-time
 * migration (file-reference-migration.ts) both use it, so live and converted
 * references have the same shape. `summary` moves to the row's summary
 * column on store.
 */
export function referenceMetadataFields(
  file: { filePath: string; role: 'data' | 'code'; size: number; mtimeMs: number },
  reference: FileReferenceRecord,
): Record<string, string> {
  return {
    filePath: file.filePath,
    fileType: path.extname(file.filePath).toLowerCase(),
    fileRole: file.role,
    format: reference.format,
    mtime: String(file.mtimeMs),
    size: String(file.size),
    summary: reference.summary,
    displayPath: reference.displayPath,
    ...(reference.outline.length ? { outline: reference.outline.join(', '), outlineLabel: reference.outlineLabel } : {}),
    ...(reference.header ? { header: reference.header } : {}),
    ...(reference.lines != null ? { lines: String(reference.lines) } : {}),
  };
}

// ── Store and routing ───────────────────────────────────────────────────────

interface ReferenceRow {
  id: string;
  title: string | null;
  metadata: string | null;
  raw_text: string | null;
  process_state: string;
  project_id: string | null;
}

export interface FileReferenceAdoptionResult {
  checked: number;
  adopted: number;
}

export interface FileReferences {
  /** Insert or update the reference for one path; an `archived` sentinel marks it deleted. */
  upsert(item: RawWorkItem): void;
  /** The project a reference at `filePath` follows, or null (none or ambiguous). */
  folderProject(filePath: string, rootPath: string | null, referenceId?: string | null): string | null;
  /** Assign unassigned references whose folder now has routed documents. Cheap; runs every interpretation tick. */
  adoptOrphans(opts?: { limit?: number }): FileReferenceAdoptionResult;
}

const ROUTING_REASON = 'deterministic reference-follows-folder-documents rule';
const ADOPTION_WATERMARK_KEY = 'file_references.adoption_event_id';
const MAX_FOLDER_LEVELS = 16;
const DIR_CACHE_TTL_MS = 30_000;
const DIR_CACHE_MAX = 4_096;
/** Unassigned references checked by the first adoption run. */
const FIRST_SWEEP_MAX = 20_000;
/** Unassigned references checked under one folder whose documents routed. */
const ADOPT_PER_FOLDER_MAX = 5_000;

function parseMetadata(raw: string | null): Record<string, unknown> {
  try { return raw ? JSON.parse(raw) as Record<string, unknown> : {}; } catch { return {}; }
}

/**
 * Make the next `adoptOrphans` run check every unassigned reference again,
 * as on its first run. Used after references are added in bulk (the one-time
 * migration), which the event watermark would otherwise never revisit.
 */
export function requestFullAdoptionSweep(db: Database.Database): void {
  db.prepare('DELETE FROM app_settings WHERE key = ?').run(ADOPTION_WATERMARK_KEY);
}

/**
 * `INDEXED BY` for a path-range query over references. Without table
 * statistics the planner prefers an equality index (type, process_state)
 * and would scan every reference. Empty when the partial unique index is
 * missing (its creation is allowed to fail on a store with duplicates).
 */
export function referencePathIndexHint(db: Database.Database): string {
  const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_work_items_file_reference_path'").get();
  return exists ? 'INDEXED BY idx_work_items_file_reference_path' : '';
}

export function createFileReferences(deps: { db: Database.Database; contentStore: ContentStore; now?: () => Date }): FileReferences {
  const { db, contentStore } = deps;
  const now = deps.now ?? (() => new Date());

  const selectByPath = db.prepare(`
    SELECT id, title, metadata, raw_text, process_state, project_id
    FROM work_items WHERE type = 'file_reference' AND file_path = ?
  `);
  const folderRootStmt = db.prepare('SELECT path FROM local_folders WHERE id = ?');
  // Projects of the routed local documents directly inside one directory.
  // The range scan rides the partial index of routed local documents
  // (storage.ts › idx_work_items_routed_local_documents), whose entries
  // also answer the direct-child test; quarantined evidence never counts.
  // INDEXED BY: without table statistics the planner prefers the
  // process_state index and would scan every routed item per directory.
  const routedProjectsIn = db.prepare(`
    SELECT DISTINCT w.project_id AS projectId
    FROM work_items w INDEXED BY idx_work_items_routed_local_documents
    JOIN projects p ON p.id = w.project_id
    WHERE w.source = 'filesystem' AND w.type = 'document_capture' AND w.process_state = 'routed'
      AND w.file_path >= ? AND w.file_path < ?
      AND instr(substr(w.file_path, ?), ?) = 0
      AND COALESCE(json_extract(CASE WHEN json_valid(w.scope_alert) THEN w.scope_alert ELSE '{}' END, '$.quarantined'), 0) <> 1
      AND p.status IN ('active', 'paused')
    ORDER BY w.project_id
  `);
  const rejectedStmt = db.prepare('SELECT 1 FROM work_item_rejections WHERE work_item_id = ? AND project_id = ?');
  // Unassigned references of files that still exist (a deleted file's
  // reference is never placed in a project).
  const orphansUnder = db.prepare(`
    SELECT id, file_path AS filePath, metadata FROM work_items ${referencePathIndexHint(db)}
    WHERE type = 'file_reference' AND file_path >= ? AND file_path < ?
      AND process_state = 'orphaned'
      AND COALESCE(json_extract(CASE WHEN json_valid(metadata) THEN metadata ELSE '{}' END, '$.archived'), '') <> 'true'
    LIMIT ?
  `);
  const allOrphans = db.prepare(`
    SELECT id, file_path AS filePath, metadata FROM work_items
    WHERE type = 'file_reference' AND process_state = 'orphaned'
      AND COALESCE(json_extract(CASE WHEN json_valid(metadata) THEN metadata ELSE '{}' END, '$.archived'), '') <> 'true'
    LIMIT ?
  `);
  const adoptStmt = db.prepare(`
    UPDATE work_items SET project_id = ?, process_state = 'routed', batch_id = NULL
    WHERE id = ? AND type = 'file_reference' AND process_state = 'orphaned'
  `);
  const eventsSince = db.prepare(`
    SELECT e.id AS eventId, w.file_path AS filePath
    FROM work_item_project_events e
    JOIN work_items w ON w.id = e.work_item_id
    WHERE e.id > ? AND e.project_id IS NOT NULL
      AND w.source = 'filesystem' AND w.type = 'document_capture' AND w.file_path IS NOT NULL
    ORDER BY e.id
    LIMIT ?
  `);
  const maxEventStmt = db.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM work_item_project_events');

  function rootFor(metadata: Record<string, unknown>): string | null {
    const folderId = Number(metadata.localFolderId);
    if (!Number.isInteger(folderId)) return null;
    const row = folderRootStmt.get(folderId) as { path: string } | undefined;
    return row ? path.resolve(row.path) : null;
  }

  // Directory → projects, shared across calls: a walk over a code folder
  // asks about the same directories thousands of times. Entries expire
  // after DIR_CACHE_TTL_MS, and adoption clears them when documents route.
  const dirCache = new Map<string, { projects: string[]; at: number }>();

  /** Distinct projects of routed documents directly inside `dir`. */
  function projectsDirectlyIn(dir: string): string[] {
    const at = now().getTime();
    const cached = dirCache.get(dir);
    if (cached && at - cached.at < DIR_CACHE_TTL_MS) return cached.projects;
    const prefix = dir.endsWith(path.sep) ? dir : dir + path.sep;
    const upper = prefix.slice(0, -1) + String.fromCharCode(path.sep.charCodeAt(0) + 1);
    const projects = (routedProjectsIn.all(prefix, upper, prefix.length + 1, path.sep) as Array<{ projectId: string }>)
      .map((row) => row.projectId);
    if (dirCache.size >= DIR_CACHE_MAX) dirCache.clear();
    dirCache.set(dir, { projects, at });
    return projects;
  }

  /**
   * The nearest directory (walking up to the watched folder's root) that
   * holds routed documents decides: one project assigns it, several leave it
   * unassigned, and a project the owner rejected for this reference is never
   * chosen (nor does the walk go further up looking for another).
   */
  function folderProjectFor(filePath: string, rootPath: string | null, referenceId: string | null): string | null {
    let dir = path.dirname(filePath);
    const root = rootPath ? path.resolve(rootPath) : null;
    for (let level = 0; level < MAX_FOLDER_LEVELS; level++) {
      const projects = projectsDirectlyIn(dir);
      if (projects.length > 0) {
        if (projects.length > 1) return null; // the nearest documents disagree
        return referenceId && rejectedStmt.get(referenceId, projects[0]) ? null : projects[0];
      }
      if (!root || dir === root || !dir.startsWith(root + path.sep)) return null;
      const parent = path.dirname(dir);
      if (parent === dir) return null;
      dir = parent;
    }
    return null;
  }

  function adoptRows(rows: Array<{ id: string; filePath: string; metadata: string | null }>, result: FileReferenceAdoptionResult): void {
    for (const row of rows) {
      result.checked++;
      const projectId = folderProjectFor(row.filePath, rootFor(parseMetadata(row.metadata)), row.id);
      if (!projectId) continue;
      if (adoptStmt.run(projectId, row.id).changes > 0) {
        result.adopted++;
        recordRoutingDecision(db, {
          runId: 'file-references',
          batchId: 'file-references:adopt',
          itemId: row.id,
          modelDecision: 'not_called',
          appliedDecision: 'assign',
          appliedProjectId: projectId,
          validationReason: ROUTING_REASON,
        });
      }
    }
  }

  return {
    upsert(item) {
      const filePath = String(item.metadata?.filePath ?? '');
      if (!filePath) throw new Error('file reference without metadata.filePath');
      const existing = selectByPath.get(filePath) as ReferenceRow | undefined;
      const at = now().toISOString();

      if (item.metadata?.archived === 'true') {
        if (!existing) return;
        const meta = { ...parseMetadata(existing.metadata), archived: 'true', archivedAt: at };
        db.prepare('UPDATE work_items SET metadata = ? WHERE id = ?').run(JSON.stringify(meta), existing.id);
        return;
      }

      const text = item.content ?? '';
      const title = item.title ?? path.basename(filePath);
      const incoming: Record<string, unknown> = { ...(item.metadata ?? {}) };
      const summary = String(incoming.summary ?? text.split('\n')[0] ?? '').slice(0, 500);
      delete incoming.summary;

      if (existing) {
        const meta: Record<string, unknown> = { ...parseMetadata(existing.metadata), ...incoming, observedAt: at };
        delete meta.archived;
        delete meta.archivedAt;
        const cols = refToColumns(contentStore.put(existing.id, text));
        const changedText = text !== (existing.raw_text ?? '') || title !== (existing.title ?? '');
        db.transaction(() => {
          db.prepare(`
            UPDATE work_items SET title = ?, summary = ?, url = ?, parsed_text = ?,
              raw_text = ?, content_storage = ?, content_path = ?, content_sha256 = ?, content_bytes = ?,
              metadata = ?
            WHERE id = ?
          `).run(
            title, summary, item.url ?? null, text,
            cols.raw_text, cols.content_storage, cols.content_path, cols.content_sha256, cols.content_bytes,
            JSON.stringify(meta), existing.id,
          );
          if (changedText) {
            deleteWorkItemFts(db, existing.id);
            db.prepare('INSERT INTO work_items_fts (item_id, title, body) VALUES (?, ?, ?)').run(existing.id, title, text);
          }
        })();
        return;
      }

      const id = randomUUID();
      const metadata = { ...incoming, observedAt: at };
      const projectId = folderProjectFor(filePath, rootFor(metadata), null);
      const cols = refToColumns(contentStore.put(id, text));
      db.transaction(() => {
        db.prepare(`
          INSERT INTO work_items (id, type, source, source_app, title, summary, url, file_path,
            raw_text, content_storage, content_path, content_sha256, content_bytes, parsed_text,
            metadata, captured_at, process_state, project_id)
          VALUES (?, 'file_reference', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          id, item.source, item.sourceApp, title, summary, item.url ?? null, filePath,
          cols.raw_text, cols.content_storage, cols.content_path, cols.content_sha256, cols.content_bytes, text,
          JSON.stringify(metadata), item.capturedAt.toISOString(),
          projectId ? 'routed' : 'orphaned', projectId,
        );
        db.prepare('INSERT INTO work_items_fts (item_id, title, body) VALUES (?, ?, ?)').run(id, title, text);
      })();
      // Only an assignment is audited: a code folder's thousands of
      // unassigned files would otherwise each write a decision row.
      if (projectId) {
        recordRoutingDecision(db, {
          runId: 'file-references',
          batchId: 'file-references:ingest',
          itemId: id,
          modelDecision: 'not_called',
          appliedDecision: 'assign',
          appliedProjectId: projectId,
          validationReason: ROUTING_REASON,
        });
      }
    },

    folderProject(filePath, rootPath, referenceId = null) {
      return folderProjectFor(filePath, rootPath, referenceId);
    },

    adoptOrphans(opts = {}) {
      const limit = Math.max(1, opts.limit ?? 500);
      const result: FileReferenceAdoptionResult = { checked: 0, adopted: 0 };
      const watermark = getSetting<number>(db, ADOPTION_WATERMARK_KEY);
      if (typeof watermark !== 'number') {
        // First run: check every unassigned reference once, then follow the
        // routing events of local documents from here on.
        dirCache.clear();
        const maxEvent = (maxEventStmt.get() as { id: number }).id;
        adoptRows(allOrphans.all(FIRST_SWEEP_MAX) as Array<{ id: string; filePath: string; metadata: string | null }>, result);
        setSetting(db, ADOPTION_WATERMARK_KEY, maxEvent);
        return result;
      }
      const events = eventsSince.all(watermark, limit) as Array<{ eventId: number; filePath: string }>;
      if (events.length === 0) {
        // Nothing local was routed: skip past unrelated events cheaply.
        const maxEvent = (maxEventStmt.get() as { id: number }).id;
        if (maxEvent > watermark) setSetting(db, ADOPTION_WATERMARK_KEY, maxEvent);
        return result;
      }
      // Documents moved: what the cache says about their folders is stale.
      dirCache.clear();
      const dirs = new Set(events.map((event) => path.dirname(event.filePath)));
      for (const dir of dirs) {
        const prefix = dir + path.sep;
        const upper = dir + String.fromCharCode(path.sep.charCodeAt(0) + 1);
        adoptRows(orphansUnder.all(prefix, upper, ADOPT_PER_FOLDER_MAX) as Array<{ id: string; filePath: string; metadata: string | null }>, result);
      }
      const last = events[events.length - 1].eventId;
      setSetting(db, ADOPTION_WATERMARK_KEY, events.length < limit ? Math.max(last, (maxEventStmt.get() as { id: number }).id) : last);
      return result;
    },
  };
}
