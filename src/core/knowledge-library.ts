/**
 * The Knowledge library service (knowledge-library.md K3, K5, K8): discovery of sets, their status, and whole-file
 * loads. One instance serves the chat tools, the Settings routes and the prompt.
 *
 * A set is a folder of reference files plus a GUIDE.md. Discovery is top-down from the root, at most three levels:
 * the folders the root guide's Categories table names hold sets; any other top-level folder is a set that owns its
 * subtree; a sub-folder with its own GUIDE.md is a nested set. `<root>/analytics` is the reserved set `analytics` once
 * the install is in library mode: its members are exactly what `listAnalyticsContext` returns, so
 * `{set:'analytics', file:'presets/shopwave.md'}` keeps the relative id the R6.2a receipts pin. Unguided folders are
 * sets too ("no guide yet", still readable), including inside the analytics set (design amendment P2-3).
 *
 * Practical agent framework: guides are Operating Knowledge, a set's files are Retrieved Knowledge. A file enters a prompt
 * only through an explicit load, whole, complete-or-explicit-range, fenced as untrusted data with a receipt.
 *
 * Cost control: a walk stats everything it lists but reads a guide or a file head only when its (path, size, mtime) is new;
 * a result is reused for one second; a walk that outlasts its budget is abandoned (routing then skips its block rather
 * than delay the turn) and is not retried for a minute. A deep folder or a slow volume cannot stall a chat turn.
 */
import type Database from 'better-sqlite3';
import { createHash } from 'crypto';
import fs from 'fs';
import { promises as fsp } from 'fs';
import path from 'path';
import { KNOWLEDGE_COMPLETE_MAX_CHARS, RUNTIME_RESERVE_TOKENS } from './analytics-chat-context.js';
import {
  analyticsContextHeader,
  analyticsLibraryMode,
  legacyAnalyticsContentSummary,
  listAnalyticsContext,
  permissionProblem,
  resolveAnalyticsContextDir,
  type AnalyticsContextEntry,
  type AnalyticsContextSource,
} from './analytics-context.js';
import { endpointContextTokens } from './limits.js';
import {
  GUIDE_MAX_BYTES,
  escapeAttribute,
  estimateTokens,
  indexFileNames,
  inferKind,
  parseGuide,
  plainText,
  protectKnowledgeDelimiters,
  rulesDigest,
  sanitizeSetName,
  secretFree,
  type GuideCategory,
  type GuideRow,
  type ParsedGuide,
  type SetKind,
} from './knowledge-guide.js';
import {
  activateKnowledgeRoot,
  activateResolvedRoot,
  canonicalizeBestEffort,
  classifyRootError,
  defaultKnowledgeRoot,
  effectiveAnalyticsDir,
  readKnowledgeState,
  resolveKnowledgeRoot,
  validateKnowledgeRootCandidate,
  type ActivationOptions,
  type ActivationResult,
  type KnowledgeMigrationRecord,
  type RootFailure,
} from './knowledge-root.js';
import { buildKnowledgeBlock, deriveKeywords, matchSets, type KnowledgeBlock, type MatchResult, type RoutingSet } from './knowledge-routing.js';
import { renderAllLessonScopes } from './lessons-ledger.js';
import { writeProtectedRootsInEffect } from './protected-local-resources.js';
import { detectSecrets, describeSecretKinds } from './sensitive-files.js';
import { GUIDE_FILE_NAME } from './knowledge-templates.js';

// ── Limits ─────────────────────────────────────────────────────────────────

export const READABLE_EXTENSIONS: ReadonlySet<string> = new Set(['.md', '.txt', '.yaml', '.yml', '.json', '.sql']);
/** A file over this size is skipped by discovery and counted; nothing can be loaded past it. */
export const MAX_KNOWLEDGE_FILE_BYTES = 4 * 1024 * 1024;
const MEMBER_DEPTH = 3;
const MAX_SET_DEPTH = 3;
const MAX_MEMBERS_PER_SET = 1_000;
const MAX_WALK_ENTRIES = 8_000;
const MAX_FILE_ID_CHARS = 200;
const MAX_SEGMENT_CHARS = 80;
const HEAD_BYTES = 2_048;
const RESULT_REUSE_MS = 1_000;
const SLOW_BACKOFF_MS = 60_000;
export const STATUS_BUDGET_MS = 4_000;
export const ROUTING_BUDGET_MS = 800;
/** The shared context budget (tokens) every chat model works inside; loads use 60 percent of it at most. */
export const SHARED_CONTEXT_BUDGET_TOKENS = 100_000;
const HEADROOM_MARGIN_TOKENS = 4_000;
const RESERVED_ANALYTICS_SUBFOLDERS = new Set(['presets', 'lessons', '.onboarding', '_archive']);

// ── Types ──────────────────────────────────────────────────────────────────

export interface LibraryIssue { code: string; message: string; file?: string }

export interface LibraryFile {
  /** Set-relative POSIX path, for example `presets/shopwave.md`. */
  name: string;
  absolute: string;
  bytes: number;
  mtimeMs: number;
  /** First heading or first line. */
  title: string;
  /** From the guide's table; else the title. */
  purpose: string;
  summary: string[];
  mechanism: string;
  audience: string;
  status: 'ok' | 'unlisted' | 'not_downloaded';
  analytics?: { source: AnalyticsContextSource; business?: string; keywords?: string[] };
}

export interface LibrarySet {
  id: string;
  name: string;
  kind: SetKind;
  description: string;
  category: string | null;
  /** True for the built-in `analytics` set. */
  reserved: boolean;
  hasGuide: boolean;
  guidePath: string | null;
  guideSha256: string | null;
  rulesSha256: string | null;
  writable: boolean;
  headerKeywords: string[];
  keywords: string[];
  files: LibraryFile[];
  /** Rows of the guide's table whose file is not in the folder / lives outside it. */
  missingRows: string[];
  externalRows: string[];
  conflictOrder: string[] | null;
  archived: number;
  skipped: { hidden: number; links: number; large: number; other: number };
  issues: LibraryIssue[];
  dir: string;
  guide: ParsedGuide | null;
}

export interface DiscoveredLibrary {
  root: string;
  builtAt: number;
  signature: string;
  sets: LibrarySet[];
  categories: GuideCategory[];
  /** Files directly in the root or a category folder: they belong to no set. */
  loose: string[];
  rootGuide: { present: boolean; issues: LibraryIssue[]; /** The root guide's absolute path (its real spelling), or null. */ path: string | null };
}

export class LibraryUnavailable extends Error {
  constructor(readonly failure: RootFailure) {
    super(failure.message);
    this.name = 'LibraryUnavailable';
  }
}

class DiscoveryTimeout extends Error {
  constructor() {
    super('discovery timed out');
    this.name = 'DiscoveryTimeout';
  }
}

export type KnowledgeState = 'not_created' | 'ready' | 'needs_permission' | 'folder_missing' | 'error';

export interface KnowledgeSetView {
  id: string;
  name: string;
  kind: SetKind;
  description: string;
  category: string | null;
  fileCount: number;
  archived: number;
  hasGuide: boolean;
  writable: boolean;
  reserved: boolean;
  issues: LibraryIssue[];
}

export interface KnowledgeStatus {
  version: number;
  activated: boolean;
  root: string | null;
  defaultRoot: string;
  pinnedByEnvironment: boolean;
  state: KnowledgeState;
  message?: string;
  nextAction?: string;
  /** Commands BotBoy runs can read the folder and cannot write it: the sandbox deny reports the root. */
  denyActive: boolean;
  sets: KnowledgeSetView[];
  categories: GuideCategory[];
  looseCount: number;
  analyticsDir: 'library' | 'legacy';
  legacyAnalytics: { dir: string; files: number; hasManifest: boolean } | null;
  migration: KnowledgeMigrationRecord | null;
  formerRoots: string[];
  /** One sentence about sync and backup, shown beside the location and on the Move card. */
  syncNote: string;
}

export const SYNC_NOTE = 'This folder may be synced by iCloud Drive or backed up by Time Machine; use Change location first if you do not want that.';

export interface FileSummary {
  name: string;
  bytes: number;
  purpose: string;
  summary: string[];
  status: LibraryFile['status'];
  mechanism: string;
  audience: string;
}

export interface KnowledgeSetDetail extends KnowledgeSetView {
  guideTitle: string;
  guidePurpose: string;
  conflictOrder: string[] | null;
  files: FileSummary[];
  missingRows: string[];
  externalRows: string[];
  guideSha256: string | null;
  rulesSha256: string | null;
  keywords: string[];
}

export interface LoadLimits {
  /** The shared context budget (default 100,000). */
  contextBudgetTokens?: number;
  /** The model's context window (default: the endpoint's). */
  contextWindowTokens?: number;
  /** What the next prompt can still take, set by the chat loop each iteration. */
  promptHeadroomTokens?: number;
}

export interface LoadRequest {
  set: string;
  file: string;
  section?: string;
  lines?: [number, number];
}

export type LoadFailureCode =
  | 'not_activated'
  | 'root_unavailable'
  | 'set_not_found'
  | 'file_not_found'
  | 'invalid_path'
  | 'unsupported_type'
  | 'not_text'
  | 'not_downloaded'
  | 'file_has_secret'
  | 'file_too_large_for_context'
  | 'capacity_exceeded'
  | 'invalid_range'
  | 'section_not_found'
  | 'range_too_large'
  | 'internal_error';

export interface LoadFailure {
  ok: false;
  code: LoadFailureCode;
  message: string;
  nextAction: string;
  effect: 'none';
  details?: Record<string, unknown>;
}

export interface LoadReceipt {
  fileSha256: string;
  sentSha256: string;
  chars: number;
  estimatedTokens: number;
  partial: boolean;
  range?: { lines: [number, number]; of: number; section?: string };
  rangeSha256?: string;
}

export interface LoadSuccess {
  ok: true;
  /** The fenced text for the model. */
  text: string;
  receipt: LoadReceipt;
  set: string;
  file: string;
  /** Said to the owner when a range was read instead of the whole file. */
  tellOwner?: string;
}

export type LoadResult = LoadSuccess | LoadFailure;

// ── Small helpers ──────────────────────────────────────────────────────────

const sha256 = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
const posix = (value: string) => value.split(path.sep).join('/');
const hasReadableExtension = (name: string) => READABLE_EXTENSIONS.has(path.extname(name).toLowerCase());
const isGuideName = (name: string) => name.toLowerCase() === GUIDE_FILE_NAME.toLowerCase();
/** A name from a folder or a file, made safe for a sentence the model reads outside any fence: no control characters or line breaks, short. */
const sayName = (value: unknown, max = 120): string => String(value ?? '').replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
/** A set's name for such a sentence: the same safe alphabet the standing line uses, or its folder id when nothing is left. */
const sayWithSetName = (set: { name: string; id: string }): string => sanitizeSetName(set.name) || sayName(set.id, 60);
/** Two spellings of one folder: canonical paths compared without case, because APFS ignores it. */
const sameFolder = (left: string, right: string): boolean => canonicalizeBestEffort(left).toLowerCase() === canonicalizeBestEffort(right).toLowerCase();

function failure(code: LoadFailureCode, message: string, nextAction: string, details?: Record<string, unknown>): LoadFailure {
  return { ok: false, code, message, nextAction, effect: 'none', ...(details ? { details } : {}) };
}

function titleFromHead(head: string): string {
  for (const line of head.split('\n')) {
    const cleaned = line.replace(/^\s*(?:#+\s*|[-*]\s+|<!--\s*)/, '').replace(/\s*-->\s*$/, '').trim();
    if (cleaned && cleaned !== '---') return cleaned.slice(0, 160);
  }
  return '';
}

async function readHead(file: string): Promise<string> {
  let handle: fsp.FileHandle | null = null;
  try {
    handle = await fsp.open(file, 'r');
    const buffer = Buffer.alloc(HEAD_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, HEAD_BYTES, 0);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } catch {
    return '';
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/** The limit, in estimated tokens, on a whole-file load right now. */
export function wholeFileTokenLimit(limits: LoadLimits = {}): number {
  const budget = limits.contextBudgetTokens ?? SHARED_CONTEXT_BUDGET_TOKENS;
  const window = limits.contextWindowTokens ?? endpointContextTokens();
  const byBudget = Math.floor(0.6 * budget);
  const byWindow = window - RUNTIME_RESERVE_TOKENS;
  const byHeadroom = limits.promptHeadroomTokens === undefined ? Number.POSITIVE_INFINITY : limits.promptHeadroomTokens - HEADROOM_MARGIN_TOKENS;
  return Math.max(0, Math.min(byBudget, byWindow, byHeadroom));
}

interface OutlineEntry { heading: string; level: number; line: number; estimatedTokens: number }

/** Headings with their first line and size, or 300-line blocks when a file has no headings. Fences are skipped. */
export function buildOutline(text: string): { kind: 'headings' | 'blocks'; entries: Array<OutlineEntry | { lines: [number, number]; estimatedTokens: number }>; totalLines: number } {
  const lines = text.split('\n');
  const headings: Array<{ line: number; level: number; heading: string }> = [];
  let inFence = false;
  lines.forEach((value, index) => {
    if (/^\s*(```|~~~)/.test(value)) { inFence = !inFence; return; }
    if (inFence) return;
    const match = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(value);
    if (match) headings.push({ line: index + 1, level: match[1].length, heading: plainText(match[2]) });
  });
  const sizeOf = (from: number, to: number) => estimateTokens(lines.slice(from - 1, to).join('\n'));
  if (headings.length === 0) {
    const entries: Array<{ lines: [number, number]; estimatedTokens: number }> = [];
    for (let from = 1; from <= lines.length; from += 300) {
      const to = Math.min(lines.length, from + 299);
      entries.push({ lines: [from, to], estimatedTokens: sizeOf(from, to) });
    }
    return { kind: 'blocks', entries, totalLines: lines.length };
  }
  const entries: OutlineEntry[] = headings.map((heading, index) => {
    let end = lines.length;
    for (let next = index + 1; next < headings.length; next += 1) {
      if (headings[next].level <= heading.level) { end = headings[next].line - 1; break; }
    }
    return { heading: heading.heading, level: heading.level, line: heading.line, estimatedTokens: sizeOf(heading.line, end) };
  });
  return { kind: 'headings', entries, totalLines: lines.length };
}

/** The lines of one section (its heading, its text and its sub-sections), by exact heading text, case-insensitive. */
export function sectionRange(text: string, heading: string): [number, number] | null {
  const wanted = plainText(heading).toLowerCase();
  if (!wanted) return null;
  const lines = text.split('\n');
  let inFence = false;
  let start = -1;
  let level = 0;
  for (let index = 0; index < lines.length; index += 1) {
    if (/^\s*(```|~~~)/.test(lines[index])) { inFence = !inFence; continue; }
    if (inFence) continue;
    const match = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(lines[index]);
    if (!match) continue;
    if (start < 0) {
      if (plainText(match[2]).toLowerCase() === wanted) { start = index; level = match[1].length; }
    } else if (match[1].length <= level) {
      return [start + 1, index];
    }
  }
  return start < 0 ? null : [start + 1, lines.length];
}

// ── The service ────────────────────────────────────────────────────────────

export interface InspectResult {
  ok: true;
  root: string;
  rootGuidePath: string | null;
  categories: GuideCategory[];
  sets: LibrarySet[];
  /** The set named by the request; null when it named the root guide (`/`). */
  set: LibrarySet | null;
}

export interface KnowledgeLibraryDeps {
  db: Database.Database;
  now?: () => number;
}

export interface KnowledgeLibrary {
  /** Bumped whenever the library changes (rides `/dashboard/version`). */
  version(): number;
  bump(): number;
  /** A root is recorded (or the test override is set). No disk access. */
  isActivated(): boolean;
  denyActive(): boolean;
  status(options?: { budgetMs?: number }): Promise<KnowledgeStatus>;
  activate(rawPath: string, options?: Pick<ActivationOptions, 'confirmExisting'>): Promise<ActivationResult>;
  rescan(): Promise<KnowledgeStatus>;
  listSets(options?: { budgetMs?: number }): Promise<{ sets: KnowledgeSetView[]; categories: GuideCategory[]; looseCount: number } | LoadFailure>;
  getSet(id: string, options?: { budgetMs?: number }): Promise<KnowledgeSetDetail | LoadFailure>;
  /**
   * The raw discovery result for the write path: the canonical root, the root guide's path and categories, every set (with
   * absolute paths and its parsed guide), and the one named by `id` (null for the root guide, id `/`). Walks like `getSet`.
   */
  inspect(id: string, options?: { budgetMs?: number }): Promise<InspectResult | LoadFailure>;
  load(request: LoadRequest, limits?: LoadLimits): Promise<LoadResult>;
  /** Sets prepared for the matcher and the prompt block; null when there is nothing to say or the walk was too slow. */
  routingSets(options?: { budgetMs?: number }): Promise<{ sets: RoutingSet[]; denyActive: boolean } | null>;
  /** Build the prompt block for one turn; '' when the library has no sets. */
  routeTurn(input: { message: string; jobGoal?: string; analyticsMode?: boolean; loadedFiles?: readonly string[]; budgetMs?: number }): Promise<(KnowledgeBlock & { match: MatchResult }) | null>;
  /** One sentence for the briefing's "no knowledge" text when the library has analytics sets (cached; sync). */
  analyticsHint(): string | null;
  /** Run `task` with the library's one lock held (migration, activation). */
  withLock<T>(task: () => Promise<T>): Promise<T>;
  /** Forget cached results (after a change made outside this service). */
  invalidate(): void;
}

export function createKnowledgeLibrary(deps: KnowledgeLibraryDeps): KnowledgeLibrary {
  const { db } = deps;
  const now = deps.now ?? (() => Date.now());
  let version = 1;
  let lastSignature = '';
  let cache: { result: DiscoveredLibrary; at: number; root: string } | null = null;
  let inflight: { promise: Promise<DiscoveredLibrary>; budgetMs: number } | null = null;
  let slowUntil = 0;
  let environmentActivated: string | null = null;
  const headMemo = new Map<string, { key: string; title: string; withheld: string | null }>();
  const guideMemo = new Map<string, { key: string; text: string; sha: string; guide: ParsedGuide }>();
  let lockChain: Promise<unknown> = Promise.resolve();

  const legacyHasContent = () => {
    const summary = legacyAnalyticsContentSummary(db);
    return summary.files > 0 || summary.hasManifest;
  };

  function bump(): number {
    version += 1;
    return version;
  }

  function invalidate(): void {
    cache = null;
    inflight = null;
  }

  async function withLock<T>(task: () => Promise<T>): Promise<T> {
    const run = lockChain.then(task, task);
    lockChain = run.catch(() => undefined);
    return run;
  }

  // ── root ──

  function currentRoot(): { root: string | null; pinned: boolean } {
    const resolved = resolveKnowledgeRoot(db);
    return { root: resolved.root ? canonicalizeBestEffort(resolved.root) : null, pinned: resolved.pinnedByEnvironment };
  }

  /** The test override counts as activated: run the same idempotent steps once per root, on first use. */
  async function ensureEnvironmentActivated(): Promise<RootFailure | null> {
    const resolved = resolveKnowledgeRoot(db);
    if (resolved.source !== 'environment' || !resolved.root) return null;
    if (environmentActivated === resolved.root) return null;
    const result = await activateResolvedRoot(db, resolved.root, { recordRoot: false, legacyHasContent, confirmExisting: true });
    if (!result.ok) return result;
    environmentActivated = resolved.root;
    renderAllLessonScopes(db);
    invalidate();
    bump();
    return null;
  }

  // ── discovery ──

  interface WalkState { deadline: number; entries: number; signature: string[] }

  const tick = (state: WalkState): void => {
    if (now() > state.deadline) throw new DiscoveryTimeout();
    state.entries += 1;
    if (state.entries > MAX_WALK_ENTRIES) throw new DiscoveryTimeout();
  };

  async function listDir(dir: string, state: WalkState): Promise<fs.Dirent[]> {
    tick(state);
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
    return entries;
  }

  async function statSignature(absolute: string, relative: string, state: WalkState): Promise<fs.Stats | null> {
    tick(state);
    try {
      const stat = await fsp.lstat(absolute);
      state.signature.push(`${relative}|${stat.size}|${Math.round(stat.mtimeMs)}`);
      return stat;
    } catch {
      return null;
    }
  }

  /**
   * The first line of a file, for a listing. When the start of the file holds a secret format the title is withheld (the
   * file shows by name) and the issue names the kind, never the value (P1 review N2).
   */
  async function titleOf(absolute: string, stat: fs.Stats): Promise<{ title: string; withheld: string | null }> {
    const key = `${stat.size}:${Math.round(stat.mtimeMs)}`;
    const memo = headMemo.get(absolute);
    if (memo && memo.key === key) return { title: memo.title, withheld: memo.withheld };
    const head = await readHead(absolute);
    const kinds = detectSecrets(head);
    const entry = kinds.length > 0
      ? { key, title: '', withheld: describeSecretKinds(kinds) }
      : { key, title: secretFree(titleFromHead(head)), withheld: null };
    headMemo.set(absolute, entry);
    return { title: entry.title, withheld: entry.withheld };
  }

  async function readGuide(absolute: string, state: WalkState): Promise<{ guide: ParsedGuide; sha: string } | { guide: ParsedGuide; sha: null }> {
    const stat = await statSignature(absolute, `guide:${absolute}`, state);
    if (!stat || !stat.isFile()) return { guide: parseGuide(''), sha: null };
    if (stat.size > GUIDE_MAX_BYTES) return { guide: parseGuide('x'.repeat(GUIDE_MAX_BYTES + 1)), sha: null };
    const key = `${stat.size}:${Math.round(stat.mtimeMs)}`;
    const memo = guideMemo.get(absolute);
    if (memo && memo.key === key) return { guide: memo.guide, sha: memo.sha };
    const raw = await fsp.readFile(absolute);
    const text = raw.toString('utf8');
    const entry = { key, text, sha: sha256(raw), guide: parseGuide(text) };
    guideMemo.set(absolute, entry);
    return { guide: entry.guide, sha: entry.sha };
  }

  interface Collected { files: Array<{ name: string; absolute: string; stat: fs.Stats; placeholder: boolean }>; nested: Array<{ name: string; absolute: string; hasGuide: boolean }>; archived: number; skipped: LibrarySet['skipped'] }

  /** Members of a set folder to a depth of three, leaving nested sets (sub-folders with their own GUIDE.md) alone. */
  async function collectMembers(dir: string, state: WalkState, options: { analyticsUnguidedNested: boolean }): Promise<Collected> {
    const collected: Collected = { files: [], nested: [], archived: 0, skipped: { hidden: 0, links: 0, large: 0, other: 0 } };
    const walk = async (current: string, relative: string, depth: number): Promise<void> => {
      for (const entry of await listDir(current, state)) {
        const rel = relative ? `${relative}/${entry.name}` : entry.name;
        const absolute = path.join(current, entry.name);
        if (entry.isSymbolicLink()) { collected.skipped.links += 1; continue; }
        if (entry.isDirectory()) {
          if (entry.name === '_archive') { collected.archived += await countArchived(absolute, state); continue; }
          if (entry.name.startsWith('.')) { collected.skipped.hidden += 1; continue; }
          if (depth >= MEMBER_DEPTH) { collected.skipped.other += 1; continue; }
          // Inside the built-in analytics set, presets/ and lessons/ are the old tools' own folders: whatever they hold, even a
          // GUIDE.md, they stay part of the set and are never a nested set (their files would be listed twice).
          if (options.analyticsUnguidedNested && depth === 1 && RESERVED_ANALYTICS_SUBFOLDERS.has(entry.name.toLowerCase())) continue;
          const inner = await listDir(absolute, state);
          const hasGuide = inner.some((child) => child.isFile() && isGuideName(child.name));
          const unguidedNested = options.analyticsUnguidedNested && depth === 1;
          if (hasGuide || unguidedNested) { collected.nested.push({ name: rel, absolute, hasGuide }); continue; }
          await walk(absolute, rel, depth + 1);
          continue;
        }
        if (!entry.isFile()) { collected.skipped.other += 1; continue; }
        if (relative === '' && isGuideName(entry.name)) continue;
        if (entry.name.startsWith('.')) {
          const placeholder = /^\.(.+)\.icloud$/i.exec(entry.name);
          if (placeholder && hasReadableExtension(placeholder[1])) {
            const stat = await statSignature(absolute, rel, state);
            if (stat) collected.files.push({ name: relative ? `${relative}/${placeholder[1]}` : placeholder[1], absolute, stat, placeholder: true });
          } else {
            collected.skipped.hidden += 1;
          }
          continue;
        }
        if (!hasReadableExtension(entry.name)) { collected.skipped.other += 1; continue; }
        const stat = await statSignature(absolute, rel, state);
        if (!stat) continue;
        if (stat.size > MAX_KNOWLEDGE_FILE_BYTES) { collected.skipped.large += 1; continue; }
        if (collected.files.length >= MAX_MEMBERS_PER_SET) { collected.skipped.other += 1; continue; }
        collected.files.push({ name: rel, absolute, stat, placeholder: false });
      }
    };
    await walk(dir, '', 1);
    return collected;
  }

  async function countArchived(dir: string, state: WalkState): Promise<number> {
    let count = 0;
    try {
      for (const entry of await listDir(dir, state)) if (entry.isFile() && !entry.name.startsWith('.')) count += 1;
    } catch { /* an unreadable archive counts as empty */ }
    return count;
  }

  /** Match a guide row to one of the folder's files: by Path + File, by File alone, with the set folder name stripped. */
  function resolveRow(row: GuideRow, byName: Map<string, LibraryFile>, byLower: Map<string, LibraryFile>): { file: LibraryFile | null; kind: 'self' | 'ok' | 'missing' | 'external' } {
    const rowPath = row.path.trim();
    const fileName = row.file.trim().replace(/^\.\//, '');
    if (/this file/i.test(rowPath) || /this file/i.test(row.mechanism) || path.basename(fileName).toLowerCase() === GUIDE_FILE_NAME.toLowerCase()) return { file: null, kind: 'self' };
    const candidates: string[] = [];
    const relativePath = rowPath && !path.isAbsolute(rowPath) && !rowPath.startsWith('~') && !rowPath.startsWith('..') ? rowPath.replace(/^\.\//, '').replace(/\/+$/, '') : '';
    if (relativePath) candidates.push(`${relativePath}/${fileName}`);
    if (relativePath) {
      // A guide written for the project root names its own folder first ("shop-analytics/reference/"); the folder may
      // have been renamed since, so the first segment is dropped whether or not it matches the folder's name.
      const segments = relativePath.split('/');
      const rest = segments.slice(1).join('/');
      candidates.push(rest ? `${rest}/${fileName}` : fileName);
    }
    candidates.push(fileName);
    for (const candidate of candidates) {
      const hit = byName.get(candidate) ?? byLower.get(candidate.toLowerCase());
      if (hit) return { file: hit, kind: 'ok' };
    }
    const outside = path.isAbsolute(rowPath) || rowPath.startsWith('~') || rowPath.startsWith('..') || fileName.startsWith('..') || path.isAbsolute(fileName);
    return { file: null, kind: outside ? 'external' : 'missing' };
  }

  async function buildSet(input: {
    id: string; dir: string; category: string | null; state: WalkState; reserved: boolean; analyticsEntries?: AnalyticsContextEntry[]; analyticsUnguidedNested?: boolean; guideRequired?: boolean;
  }): Promise<{ set: LibrarySet | null; nested: Array<{ name: string; absolute: string; hasGuide: boolean }> }> {
    const { id, dir, state } = input;
    const folderName = id.split('/').pop() as string;
    const collected = await collectMembers(dir, state, { analyticsUnguidedNested: Boolean(input.analyticsUnguidedNested) });
    const dirEntries = await listDir(dir, state);
    const guideEntry = dirEntries.find((entry) => entry.isFile() && isGuideName(entry.name));
    let guide: ParsedGuide | null = null;
    let guideSha: string | null = null;
    let guidePath: string | null = null;
    if (guideEntry) {
      guidePath = path.join(dir, guideEntry.name);
      const read = await readGuide(guidePath, state);
      guide = read.guide;
      guideSha = read.sha;
    }
    const guideUsable = Boolean(guide) && !guide!.issues.some((issue) => issue.code === 'guide_too_large' || issue.code === 'guide_has_secret' || issue.code === 'parse_error');
    const issues: LibraryIssue[] = (guide?.issues ?? [])
      .filter((issue) => issue.code !== 'no_file_table' || guideUsable)
      .map((issue) => ({ code: issue.code, message: issue.message }));

    // Members
    let files: LibraryFile[] = [];
    if (input.reserved && input.analyticsEntries) {
      for (const entry of input.analyticsEntries) {
        const name = posix(entry.name);
        const title = secretFree(entry.title);
        if (title !== entry.title) issues.push({ code: 'title_withheld', message: `${name}: the first line of this file looks like a credential, so only its name is shown.`, file: name });
        files.push({
          name, absolute: path.join(dir, entry.name), bytes: entry.bytes, mtimeMs: Date.parse(entry.modifiedAt) || 0,
          title, purpose: title, summary: [], mechanism: '', audience: '', status: 'unlisted',
          analytics: { source: entry.source, ...(entry.business ? { business: entry.business } : {}), ...(entry.keywords ? { keywords: entry.keywords } : {}) },
        });
      }
    } else {
      for (const member of collected.files) {
        const head = member.placeholder ? { title: '', withheld: null } : await titleOf(member.absolute, member.stat);
        if (head.withheld) issues.push({ code: 'title_withheld', message: `${member.name}: the start of this file looks like a credential (${head.withheld.replace(/^Contains what looks like /, '')}), so only its name is shown. A load of it is refused.`, file: member.name });
        files.push({
          name: member.name, absolute: member.absolute, bytes: member.stat.size, mtimeMs: member.stat.mtimeMs,
          title: head.title, purpose: '', summary: [], mechanism: '', audience: '',
          status: member.placeholder ? 'not_downloaded' : 'unlisted',
        });
      }
    }
    files.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));

    // Guide rows -> files
    const missingRows: string[] = [];
    const externalRows: string[] = [];
    const orderedNames: string[] = [];
    if (guide && guideUsable) {
      const byName = new Map(files.map((file) => [file.name, file]));
      const byLower = new Map(files.map((file) => [file.name.toLowerCase(), file]));
      for (const row of guide.rows) {
        const resolved = resolveRow(row, byName, byLower);
        if (resolved.kind === 'self') continue;
        if (resolved.kind === 'missing') { missingRows.push(row.file); issues.push({ code: 'row_missing', message: `The guide lists ${row.file}, but it is not in the folder.`, file: row.file }); continue; }
        if (resolved.kind === 'external') { externalRows.push(row.file); continue; }
        const file = resolved.file as LibraryFile;
        if (file.status !== 'not_downloaded') file.status = 'ok';
        file.purpose = row.purpose || file.title;
        file.mechanism = row.mechanism;
        file.audience = row.audience;
        orderedNames.push(file.name);
      }
      // A summary belongs to the file its heading names by its name relative to the set; two files may share a base name
      // (indexFileNames: a bare name counts only when exactly one file has it).
      const index = indexFileNames(files.map((file) => file.name));
      const summaries = new Map<string, string[]>();
      for (const entry of guide.toc) {
        const named = index.resolve(entry.file);
        if (named !== null && !summaries.has(named)) summaries.set(named, entry.bullets);
      }
      for (const file of files) {
        const bullets = summaries.get(file.name);
        if (bullets?.length) file.summary = bullets.slice(0, 6);
      }
    }
    for (const file of files) if (!file.purpose) file.purpose = file.title;
    // The guide's table order first, then the files it does not list.
    const rank = new Map(orderedNames.map((name, index) => [name, index]));
    files = [...files].sort((left, right) => {
      const l = rank.has(left.name) ? (rank.get(left.name) as number) : Number.MAX_SAFE_INTEGER;
      const r = rank.has(right.name) ? (rank.get(right.name) as number) : Number.MAX_SAFE_INTEGER;
      return l - r || (left.name < right.name ? -1 : 1);
    });

    const hasGuide = Boolean(guideEntry) && guideUsable;
    if (!input.reserved && !guideEntry && files.length === 0) return { set: null, nested: collected.nested };

    const matter = guide?.frontMatter;
    const kind: SetKind = matter?.kind ?? inferKind(id);
    const name = matter?.name ?? folderName;
    const description = matter?.description ?? (guideUsable ? guide?.purpose ?? '' : '');
    const analyticsTags = files.flatMap((file) => [file.analytics?.business ?? '', ...(file.analytics?.keywords ?? [])]).filter(Boolean);
    const keywords = deriveKeywords({ id, title: guideUsable ? guide?.title : undefined, fileNames: files.map((file) => file.name), extra: [...(matter?.keywords ?? []), ...analyticsTags] });
    const set: LibrarySet = {
      id, name, kind, description, category: input.category, reserved: input.reserved,
      hasGuide, guidePath, guideSha256: guideSha, rulesSha256: hasGuide && guide ? rulesDigest(guide) : null,
      writable: matter?.writable ?? true,
      headerKeywords: matter?.keywords ?? [], keywords, files,
      missingRows, externalRows,
      conflictOrder: hasGuide ? guide?.conflictOrder ?? null : null,
      archived: collected.archived, skipped: collected.skipped, issues, dir, guide: hasGuide ? guide : null,
    };
    return { set, nested: collected.nested };
  }

  async function discover(root: string, state: WalkState): Promise<DiscoveredLibrary> {
    const realRoot = canonicalizeBestEffort(root);
    let topEntries: fs.Dirent[];
    try {
      topEntries = await listDir(realRoot, state);
    } catch (error) {
      if (error instanceof DiscoveryTimeout) throw error;
      throw new LibraryUnavailable(classifyRootError(error, realRoot));
    }
    const rootGuideEntry = topEntries.find((entry) => entry.isFile() && isGuideName(entry.name));
    let categories: GuideCategory[] = [];
    const rootIssues: LibraryIssue[] = [];
    if (rootGuideEntry) {
      const read = await readGuide(path.join(realRoot, rootGuideEntry.name), state);
      categories = read.guide.categories;
      for (const issue of read.guide.issues) if (issue.code !== 'no_file_table') rootIssues.push({ code: issue.code, message: issue.message });
    }
    const categoryNames = new Set(categories.map((category) => category.folder.toLowerCase()));
    const analyticsLibrary = analyticsLibraryMode(db);
    const sets: LibrarySet[] = [];
    const loose: string[] = [];

    const addTree = async (dir: string, id: string, category: string | null, depth: number, options: { reserved?: boolean; analyticsEntries?: AnalyticsContextEntry[]; analyticsNested?: boolean } = {}): Promise<void> => {
      const built = await buildSet({ id, dir, category, state, reserved: Boolean(options.reserved), analyticsEntries: options.analyticsEntries, analyticsUnguidedNested: options.analyticsNested });
      if (built.set) sets.push(built.set);
      if (depth + 1 > MAX_SET_DEPTH) return;
      for (const nested of built.nested) {
        const nestedId = `${id}/${nested.name}`;
        if (nestedId.split('/').length > MAX_SET_DEPTH) continue;
        await addTree(nested.absolute, nestedId, category, depth + 1, { analyticsNested: false, reserved: false });
      }
    };

    for (const entry of topEntries) {
      const absolute = path.join(realRoot, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isFile()) {
        if (!isGuideName(entry.name) && !entry.name.startsWith('.')) loose.push(entry.name);
        continue;
      }
      if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === '_archive') continue;
      const lower = entry.name.toLowerCase();
      if (lower === 'analytics' && analyticsLibrary) {
        let entries: AnalyticsContextEntry[] | undefined;
        // The same folder, whatever its spelling: a folder named `Analytics` (APFS ignores case) or a root reached through a link
        // is still the folder the old tools list, so compare canonical, lower-cased paths.
        if (sameFolder(resolveAnalyticsContextDir(db), absolute)) entries = listAnalyticsContext(db).files;
        await addTree(absolute, 'analytics', 'analytics', 1, { reserved: true, analyticsEntries: entries ?? [], analyticsNested: true });
      } else if (categoryNames.has(lower)) {
        for (const child of await listDir(absolute, state)) {
          const childPath = path.join(absolute, child.name);
          if (child.isSymbolicLink() || child.name.startsWith('.') || child.name === '_archive') continue;
          if (child.isFile()) { if (!isGuideName(child.name)) loose.push(`${entry.name}/${child.name}`); continue; }
          if (!child.isDirectory()) continue;
          await addTree(childPath, `${entry.name}/${child.name}`, entry.name, 2);
        }
      } else {
        await addTree(absolute, entry.name, null, 1);
      }
    }
    sets.sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
    const signature = sha256(state.signature.sort().join('\n'));
    return { root: realRoot, builtAt: now(), signature, sets, categories, loose, rootGuide: { present: Boolean(rootGuideEntry), issues: rootIssues, path: rootGuideEntry ? path.join(realRoot, rootGuideEntry.name) : null } };
  }

  /** Discovery with the reuse rules: one second of reuse, a budget, and a back-off after a timeout. */
  async function discovery(budgetMs: number, options: { routing?: boolean } = {}): Promise<DiscoveredLibrary> {
    const { root } = currentRoot();
    if (!root) throw new LibraryUnavailable({ ok: false, code: 'root_unavailable', message: 'No Knowledge folder has been created yet.', nextAction: 'Open Settings → Knowledge and press Create folder.' });
    if (cache && cache.root === root && now() - cache.at < RESULT_REUSE_MS) return cache.result;
    // The back-off protects the chat turn (routing). An explicit call has its own, longer budget and walks anyway; a timeout of
    // either kind still starts the back-off, because the folder really is slow.
    if (options.routing && now() < slowUntil) throw new DiscoveryTimeout();
    // Join a walk that is already running only when its budget is at least this call's: a short routing walk must not cut an
    // explicit call short.
    if (inflight && inflight.budgetMs >= budgetMs) return inflight.promise;
    const state: WalkState = { deadline: now() + budgetMs, entries: 0, signature: [] };
    const run: Promise<DiscoveredLibrary> = discover(root, state).then((result) => {
      cache = { result, at: now(), root };
      if (result.signature !== lastSignature) {
        if (lastSignature) bump();
        lastSignature = result.signature;
      }
      return result;
    }).catch((error) => {
      if (error instanceof DiscoveryTimeout) slowUntil = now() + SLOW_BACKOFF_MS;
      throw error;
    }).finally(() => { if (inflight?.promise === run) inflight = null; });
    inflight = { promise: run, budgetMs };
    return run;
  }

  function unavailableFailure(error: unknown): LoadFailure {
    if (error instanceof LibraryUnavailable) {
      const base = error.failure;
      return failure(base.code === 'permission_denied' || base.code === 'root_unavailable' ? 'root_unavailable' : 'root_unavailable', base.message, base.nextAction, { reason: base.code });
    }
    if (error instanceof DiscoveryTimeout) {
      return failure('root_unavailable', 'The Knowledge folder was too slow to read.', 'Check that its disk is connected, or choose another location in Settings → Knowledge.', { reason: 'timeout' });
    }
    return failure('internal_error', `The Knowledge folder could not be read: ${String((error as Error)?.message ?? error).slice(0, 160)}`, 'Run knowledge_list again; tell the owner if it repeats.');
  }

  const notActivated = (): LoadFailure => failure('not_activated', 'The Knowledge library has not been created yet.', 'Ask the owner to open Settings → Knowledge and press Create folder.');

  const viewOf = (set: LibrarySet): KnowledgeSetView => ({
    id: set.id, name: set.name, kind: set.kind, description: set.description, category: set.category,
    fileCount: set.files.length, archived: set.archived, hasGuide: set.hasGuide, writable: set.writable, reserved: set.reserved, issues: set.issues,
  });

  function findSet(library: DiscoveredLibrary, wanted: string): LibrarySet | null {
    const key = wanted.trim().toLowerCase().replace(/\/+$/, '');
    if (!key) return null;
    const byId = library.sets.find((set) => set.id.toLowerCase() === key);
    if (byId) return byId;
    const byName = library.sets.filter((set) => set.name.toLowerCase() === key);
    return byName.length === 1 ? byName[0] : null;
  }

  const validIds = (library: DiscoveredLibrary) => library.sets.slice(0, 40).map((set) => set.id);

  // ── public API ──

  async function status(options: { budgetMs?: number } = {}): Promise<KnowledgeStatus> {
    const state = readKnowledgeState(db);
    const resolved = resolveKnowledgeRoot(db);
    const pinned = resolved.pinnedByEnvironment;
    const mode = effectiveAnalyticsDir(db);
    const legacy = mode === 'library' ? null : legacyAnalyticsContentSummary(db);
    const base: KnowledgeStatus = {
      version, activated: Boolean(resolved.root), root: null, defaultRoot: defaultKnowledgeRoot(), pinnedByEnvironment: pinned,
      state: 'not_created', denyActive: false, sets: [], categories: [], looseCount: 0,
      analyticsDir: mode, legacyAnalytics: legacy && (legacy.files > 0 || legacy.hasManifest) ? legacy : null,
      migration: state.migration, formerRoots: state.formerRoots, syncNote: SYNC_NOTE,
    };
    if (!resolved.root) return base;
    const activation = await ensureEnvironmentActivated();
    const root = currentRoot().root as string;
    const denyActive = writeProtectedRootsInEffect().includes(root);
    const result: KnowledgeStatus = { ...base, root, denyActive, analyticsDir: effectiveAnalyticsDir(db) };
    if (activation) return { ...result, state: activation.code === 'permission_denied' ? 'needs_permission' : 'error', message: activation.message, nextAction: activation.nextAction };
    try {
      const library = await discovery(options.budgetMs ?? STATUS_BUDGET_MS);
      return { ...result, state: 'ready', sets: library.sets.map(viewOf), categories: library.categories, looseCount: library.loose.length };
    } catch (error) {
      if (error instanceof LibraryUnavailable) {
        const code = error.failure.code;
        return { ...result, state: code === 'permission_denied' ? 'needs_permission' : code === 'root_unavailable' ? 'folder_missing' : 'error', message: error.failure.message, nextAction: error.failure.nextAction };
      }
      if (error instanceof DiscoveryTimeout) return { ...result, state: 'error', message: 'The Knowledge folder was too slow to read.', nextAction: 'Check that its disk is connected, or choose another location.' };
      return { ...result, state: 'error', message: String((error as Error)?.message ?? error).slice(0, 200), nextAction: 'Try Rescan, or choose another location.' };
    }
  }

  async function activate(rawPath: string, options: Pick<ActivationOptions, 'confirmExisting'> = {}): Promise<ActivationResult> {
    return withLock(async () => {
      // A different folder than the recorded one is Change location, which copies the sets across first; creating a
      // folder here would leave the analytics knowledge behind in the old one.
      const recorded = readKnowledgeState(db).root;
      const asked = validateKnowledgeRootCandidate(rawPath);
      if (recorded && asked.ok && canonicalizeBestEffort(recorded) !== asked.root) {
        return {
          ok: false, code: 'change_location_required',
          message: 'A Knowledge folder already exists. Choosing a different one needs Change location, which copies your sets across first.',
          nextAction: 'Use Change location in Settings → Knowledge.',
        } satisfies RootFailure;
      }
      const result = await activateKnowledgeRoot(db, rawPath, { ...options, legacyHasContent });
      if (result.ok) {
        renderAllLessonScopes(db);
        invalidate();
        bump();
      }
      return result;
    });
  }

  async function rescan(): Promise<KnowledgeStatus> {
    invalidate();
    slowUntil = 0;
    renderAllLessonScopes(db);
    bump();
    return status();
  }

  async function listSets(options: { budgetMs?: number } = {}) {
    if (!resolveKnowledgeRoot(db).root) return notActivated();
    const activation = await ensureEnvironmentActivated();
    if (activation) return unavailableFailure(new LibraryUnavailable(activation));
    try {
      const library = await discovery(options.budgetMs ?? STATUS_BUDGET_MS);
      return { sets: library.sets.map(viewOf), categories: library.categories, looseCount: library.loose.length };
    } catch (error) {
      return unavailableFailure(error);
    }
  }

  async function getSet(id: string, options: { budgetMs?: number } = {}): Promise<KnowledgeSetDetail | LoadFailure> {
    if (!resolveKnowledgeRoot(db).root) return notActivated();
    const activation = await ensureEnvironmentActivated();
    if (activation) return unavailableFailure(new LibraryUnavailable(activation));
    try {
      const library = await discovery(options.budgetMs ?? STATUS_BUDGET_MS);
      const set = findSet(library, id);
      if (!set) return failure('set_not_found', `No set named "${String(id).slice(0, 80)}".`, 'Call knowledge_list with no argument and use one of the set ids it returns.', { validSets: validIds(library) });
      return {
        ...viewOf(set),
        guideTitle: set.guide?.title ?? '', guidePurpose: set.guide?.purpose ?? '', conflictOrder: set.conflictOrder,
        files: set.files.slice(0, 200).map((file) => ({ name: file.name, bytes: file.bytes, purpose: file.purpose, summary: file.summary, status: file.status, mechanism: file.mechanism, audience: file.audience })),
        missingRows: set.missingRows, externalRows: set.externalRows, guideSha256: set.guideSha256, rulesSha256: set.rulesSha256, keywords: set.keywords,
      };
    } catch (error) {
      return unavailableFailure(error);
    }
  }

  async function inspect(id: string, options: { budgetMs?: number } = {}): Promise<InspectResult | LoadFailure> {
    if (!resolveKnowledgeRoot(db).root) return notActivated();
    const activation = await ensureEnvironmentActivated();
    if (activation) return unavailableFailure(new LibraryUnavailable(activation));
    try {
      const library = await discovery(options.budgetMs ?? STATUS_BUDGET_MS);
      const wanted = String(id ?? '').trim();
      const base = { ok: true as const, root: library.root, rootGuidePath: library.rootGuide.path, categories: library.categories, sets: library.sets };
      if (wanted === '/') return { ...base, set: null };
      const set = findSet(library, wanted);
      if (!set) return failure('set_not_found', `No set named "${sayName(wanted, 80)}".`, 'Call knowledge_list with no argument and use one of the set ids it returns.', { validSets: validIds(library) });
      return { ...base, set };
    } catch (error) {
      return unavailableFailure(error);
    }
  }

  function validateFileId(file: string): string | null {
    const value = String(file ?? '').trim();
    if (!value || value.length > MAX_FILE_ID_CHARS || value.includes('\0') || value.includes('\\') || path.isAbsolute(value) || value.startsWith('~')) return null;
    const segments = value.split('/');
    if (segments.some((segment) => segment === '' || segment === '.' || segment === '..' || segment.length > MAX_SEGMENT_CHARS || segment.startsWith('.'))) return null;
    return value;
  }

  async function load(request: LoadRequest, limits: LoadLimits = {}): Promise<LoadResult> {
    if (!resolveKnowledgeRoot(db).root) return notActivated();
    const activation = await ensureEnvironmentActivated();
    if (activation) return unavailableFailure(new LibraryUnavailable(activation));
    let library: DiscoveredLibrary;
    try {
      library = await discovery(STATUS_BUDGET_MS);
    } catch (error) {
      return unavailableFailure(error);
    }
    const setName = String(request.set ?? '').trim();

    // The root guide is addressed as set "/". "root" is a nickname for it only while no real set is called that: a set named
    // Root keeps its files (P1 review N4).
    const rootGuide = setName === '/' || (setName.toLowerCase() === 'root' && !findSet(library, setName));
    let set: LibrarySet | null = null;
    let absolute = '';
    let relativeName = '';
    let isGuide = false;
    let analyticsSource: AnalyticsContextSource | null = null;

    if (rootGuide) {
      if (!isGuideName(String(request.file ?? '').trim())) {
        return failure('file_not_found', 'The root of the library holds only its GUIDE.md.', 'Load GUIDE.md from set "/", or call knowledge_list for the sets.');
      }
      const entries = await fsp.readdir(library.root).catch(() => [] as string[]);
      const actual = entries.find((entry) => isGuideName(entry));
      if (!actual) return failure('file_not_found', 'The library root has no GUIDE.md.', 'Ask the owner to add one, or continue without it.');
      absolute = path.join(library.root, actual);
      relativeName = actual;
      isGuide = true;
    } else {
      set = findSet(library, setName);
      if (!set) return failure('set_not_found', `No set named "${sayName(setName, 80)}".`, 'Call knowledge_list with no argument and use one of the set ids it returns.', { validSets: validIds(library) });
      const wanted = validateFileId(request.file);
      if (!wanted) return failure('invalid_path', `"${sayName(request.file)}" is not a valid file id.`, 'Use the file name exactly as knowledge_list shows it for this set: relative, no "..", no hidden folders.');
      if (isGuideName(wanted)) {
        if (!set.guidePath) return failure('file_not_found', `${sayWithSetName(set)} has no guide yet.`, 'Call knowledge_list for this set to see its files.', { validFiles: set.files.slice(0, 50).map((file) => file.name) });
        absolute = set.guidePath;
        relativeName = path.basename(set.guidePath);
        isGuide = true;
      } else {
        if (!hasReadableExtension(wanted)) return failure('unsupported_type', `${sayName(wanted)} is not a readable type.`, 'Readable types are .md, .txt, .yaml, .yml, .json and .sql.');
        const member = set.files.find((file) => file.name === wanted) ?? set.files.find((file) => file.name.toLowerCase() === wanted.toLowerCase());
        if (!member) return failure('file_not_found', `${sayName(wanted)} is not a file of ${sayWithSetName(set)}.`, 'Use one of the file names knowledge_list returns for this set.', { validFiles: set.files.slice(0, 50).map((file) => file.name) });
        if (member.status === 'not_downloaded') return failure('not_downloaded', `${member.name} is an iCloud placeholder that has not been downloaded.`, 'Ask the owner to open the file in Finder so it downloads, then load it again.');
        absolute = member.absolute;
        relativeName = member.name;
        if (set.reserved && member.analytics) analyticsSource = member.analytics.source;
      }
    }

    // The file must still be a regular file inside the library (a link or a swapped folder is refused).
    let bytes: Buffer;
    try {
      const entry = await fsp.lstat(absolute);
      if (entry.isSymbolicLink() || !entry.isFile()) return failure('invalid_path', `${sayName(relativeName)} is not a regular file.`, 'Choose a different file; links are not read.');
      const realRoot = canonicalizeBestEffort(library.root);
      const real = await fsp.realpath(absolute);
      if (!(real === realRoot || real.startsWith(realRoot + path.sep))) return failure('invalid_path', `${sayName(relativeName)} resolves outside the Knowledge folder.`, 'Choose a different file.');
      if (entry.size > MAX_KNOWLEDGE_FILE_BYTES) return failure('file_too_large_for_context', `${sayName(relativeName)} is larger than 4 MB, so it is not part of the library.`, 'Split it into smaller files.');
      bytes = await fsp.readFile(absolute);
    } catch (error) {
      const blocked = permissionProblem(error, library.root);
      if (blocked) return failure('root_unavailable', blocked.message, blocked.nextAction, { reason: blocked.code });
      return failure('file_not_found', `${sayName(relativeName)} could not be read.`, 'Call knowledge_list to see the current files.');
    }
    if (bytes.subarray(0, 8_192).includes(0)) return failure('not_text', `${sayName(relativeName)} is not a text file.`, 'Choose a text file (.md, .txt, .yaml, .yml, .json or .sql).');
    const raw = bytes.toString('utf8');
    const secrets = detectSecrets(raw);
    if (secrets.length > 0) {
      return failure('file_has_secret', `${sayName(relativeName)} contains what looks like a credential (${describeSecretKinds(secrets)}), so it is not sent to a model.`, 'Ask the owner to remove the credential from the file; BotBoy never reads values like that.', { kinds: describeSecretKinds(secrets) });
    }

    // Build the delivered text: the analytics set keeps its provenance header (design amendment P2-7).
    let body = raw;
    let header = '';
    if (analyticsSource && set) {
      header = analyticsContextHeader(relativeName, analyticsSource);
    } else if (isGuide) {
      const guide = rootGuide ? parseGuide(raw) : set?.guide ?? parseGuide(raw);
      header = `[KNOWLEDGE FILE ${rootGuide ? '/' : set?.id}/${relativeName}, guide, rulesSha256 ${rulesDigest(guide)}]\n`;
    } else if (set) {
      const order = set.conflictOrder?.length ? `, conflict order: ${set.conflictOrder.join(' > ')}` : '';
      header = `[KNOWLEDGE FILE ${set.id}/${relativeName}, ${set.kind} set${order}]\n`;
    }
    const setLabel = rootGuide ? '/' : (set as LibrarySet).id;

    const limit = wholeFileTokenLimit(limits);
    const wholeTokens = estimateTokens(header + body);
    const wantsPartial = request.section !== undefined || request.lines !== undefined;
    const fileSha = sha256(bytes);
    if (request.section !== undefined && request.lines !== undefined) {
      return failure('invalid_range', 'Give either section or lines, not both.', 'Call again with one of them.');
    }
    if (!wantsPartial && wholeTokens > limit) {
      const outline = buildOutline(raw);
      return failure(
        'file_too_large_for_context',
        `${sayName(relativeName)} is about ${wholeTokens.toLocaleString('en-US')} tokens and only about ${limit.toLocaleString('en-US')} fit in this turn, so it was not loaded.`,
        'Call knowledge_load again with section (an exact heading from the outline) or lines [from, to]; tell the owner you read part of the file.',
        { estimatedTokens: wholeTokens, limitTokens: limit, outline: { kind: outline.kind, entries: outline.entries.slice(0, 80), totalLines: outline.totalLines } },
      );
    }
    if (wantsPartial) {
      const lines = raw.split('\n');
      let range: [number, number] | null = null;
      if (request.section !== undefined) {
        range = sectionRange(raw, String(request.section));
        if (!range) {
          const outline = buildOutline(raw);
          return failure('section_not_found', `No heading "${String(request.section).slice(0, 80)}" in ${sayName(relativeName)}.`, 'Use an exact heading from the outline.', { outline: { kind: outline.kind, entries: outline.entries.slice(0, 80), totalLines: outline.totalLines } });
        }
      } else if (Array.isArray(request.lines) && request.lines.length === 2 && request.lines.every((value) => Number.isInteger(value))) {
        const [from, to] = request.lines as [number, number];
        if (from < 1 || to < from || from > lines.length) return failure('invalid_range', `lines must be [from, to] with 1 <= from <= to; the file has ${lines.length} lines.`, 'Call again with a valid range.');
        range = [from, Math.min(to, lines.length)];
      } else {
        return failure('invalid_range', 'lines must be two whole numbers [from, to].', 'Call again with lines like [1, 120], or use section.');
      }
      const slice = lines.slice(range[0] - 1, range[1]).join('\n');
      const sliceTokens = estimateTokens(header + slice);
      if (sliceTokens > limit) {
        return failure('range_too_large', `That range is about ${sliceTokens.toLocaleString('en-US')} tokens, over the ${limit.toLocaleString('en-US')} that fit.`, 'Ask for a smaller range or a smaller section.', { estimatedTokens: sliceTokens, limitTokens: limit });
      }
      const text = header + slice;
      const sent = sha256(text);
      const rangeSha = sha256(slice);
      const tellOwner = `Read lines ${range[0]} to ${range[1]} of ${lines.length} of ${sayName(relativeName)} because the file is too large to load whole.`;
      return {
        ok: true, set: setLabel, file: relativeName, tellOwner,
        text: fence({ set: setLabel, file: relativeName, sha: fileSha, complete: false, range, body: text, guideDigest: isGuide ? rulesHeaderDigest(header) : undefined }),
        receipt: { fileSha256: fileSha, sentSha256: sent, chars: text.length, estimatedTokens: sliceTokens, partial: true, range: { lines: range, of: lines.length, ...(request.section !== undefined ? { section: String(request.section).slice(0, 120) } : {}) }, rangeSha256: rangeSha },
      };
    }
    // Whole file. The briefing's complete-or-fail rule: never silently cut.
    if (raw.length > KNOWLEDGE_COMPLETE_MAX_CHARS) {
      return failure('capacity_exceeded', `${sayName(relativeName)} is larger than the complete-load cap.`, 'Load it by section or lines.');
    }
    const text = header + body;
    return {
      ok: true, set: setLabel, file: relativeName,
      text: fence({ set: setLabel, file: relativeName, sha: fileSha, complete: true, body: text, guideDigest: isGuide ? rulesHeaderDigest(header) : undefined }),
      receipt: { fileSha256: fileSha, sentSha256: sha256(text), chars: text.length, estimatedTokens: wholeTokens, partial: false },
    };
  }

  const rulesHeaderDigest = (header: string): string | undefined => /rulesSha256 ([a-f0-9]{64})/.exec(header)?.[1];

  function fence(input: { set: string; file: string; sha: string; complete: boolean; range?: [number, number]; body: string; guideDigest?: string }): string {
    const attributes = [
      `set="${escapeAttribute(input.set)}"`, `file="${escapeAttribute(input.file)}"`, `sha256="${input.sha}"`, `complete="${input.complete}"`,
      ...(input.range ? [`range="${input.range[0]}-${input.range[1]}"`] : []),
      ...(input.guideDigest ? [`rulesSha256="${input.guideDigest}"`] : []),
    ].join(' ');
    return `<external_untrusted_knowledge ${attributes}>\n${protectKnowledgeDelimiters(input.body)}\n</external_untrusted_knowledge>`;
  }

  // ── routing ──

  const toRoutingSet = (set: LibrarySet): RoutingSet => ({
    id: set.id, name: set.name, kind: set.kind, description: set.description,
    headerKeywords: set.headerKeywords, keywords: set.keywords,
    files: set.files.map((file) => ({ name: file.name, purpose: file.purpose })),
  });

  async function routingSets(options: { budgetMs?: number } = {}): Promise<{ sets: RoutingSet[]; denyActive: boolean } | null> {
    if (!resolveKnowledgeRoot(db).root) return null;
    try {
      if (await ensureEnvironmentActivated()) return null;
      const library = await discovery(options.budgetMs ?? ROUTING_BUDGET_MS, { routing: true });
      const sets = library.sets.map(toRoutingSet);
      if (sets.length === 0) return null;
      return { sets, denyActive: writeProtectedRootsInEffect().includes(library.root) };
    } catch {
      return null;
    }
  }

  async function routeTurn(input: { message: string; jobGoal?: string; analyticsMode?: boolean; loadedFiles?: readonly string[]; budgetMs?: number }) {
    const prepared = await routingSets({ budgetMs: input.budgetMs });
    if (!prepared) return null;
    const match = matchSets({ message: input.message, jobGoal: input.jobGoal, analyticsMode: input.analyticsMode, sets: prepared.sets });
    // The analytics set is left out when the briefing already loaded its files this turn.
    const exclude = new Set<string>();
    if (input.loadedFiles?.length && cache) {
      const loaded = new Set(input.loadedFiles.map((name) => posix(name)));
      const analytics = cache.result.sets.find((set) => set.reserved);
      if (analytics && analytics.files.some((file) => loaded.has(file.name))) exclude.add(analytics.id);
    }
    const block = buildKnowledgeBlock({ sets: prepared.sets, match, protectedByDeny: prepared.denyActive, excludeSetIds: exclude });
    return { ...block, match };
  }

  function analyticsHint(): string | null {
    const library = cache?.result;
    if (!library) return null;
    const sets = library.sets.filter((set) => set.kind === 'analytics' && set.files.length > 0);
    if (sets.length === 0) return null;
    return `Your Knowledge library has analytics sets (${sets.slice(0, 4).map((set) => set.id).join(', ')}): call knowledge_list and knowledge_load to read them.`;
  }

  return {
    version: () => version,
    bump,
    isActivated: () => Boolean(resolveKnowledgeRoot(db).root),
    denyActive: () => {
      const { root } = currentRoot();
      return Boolean(root) && writeProtectedRootsInEffect().includes(root as string);
    },
    status, activate, rescan, listSets, getSet, inspect, load, routingSets, routeTurn, analyticsHint, withLock, invalidate,
  };
}
