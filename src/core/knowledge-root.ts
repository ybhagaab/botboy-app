/**
 * The Knowledge library's root folder (knowledge-library.md K1 to K4).
 *
 * One visible folder of "sets" (default `~/Documents/BotBoy Knowledge`). This module owns where it is: the stored root,
 * the test override, the in-memory root an activation is checking, and the two answers the rest of BotBoy asks of it
 * before any library feature exists:
 *   - `canonicalRootOrNull(db)` feeds the Seatbelt write-deny (`protected-local-resources.ts › registerWriteProtectedRoots`);
 *   - `knowledgeExcludedRoots(db)` feeds the capture exclusion (`capture-exclusions.ts`), the current root plus every
 *     former root.
 * Both read only the database and the environment, so `index.ts` registers them right after the database opens, before
 * the MCP manager launches any sandboxed server (design amendment P2-2).
 *
 * No answer here touches the disk while no root is recorded: an install that never created the library makes no path
 * access at all (macOS asks about Documents only on a click the owner made).
 */
import type Database from 'better-sqlite3';
import fs from 'fs';
import { promises as fsp } from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { invalidateCaptureExclusions, isCaptureExcludedPath } from './capture-exclusions.js';
import { writeProtectedRootsInEffect } from './protected-local-resources.js';
import { getSetting, setSetting } from './storage.js';
import { GUIDE_FILE_NAME, ROOT_GUIDE_SEED } from './knowledge-templates.js';

/** The one settings key. Its value is a `KnowledgeLibraryState`. */
export const KNOWLEDGE_LIBRARY_KEY = 'knowledge.library.v1';
/** Tests and live checks only. Production never sets it; while it is set, Settings cannot change the location. */
export const KNOWLEDGE_ROOT_ENV = 'BOTBOY_KNOWLEDGE_ROOT';
export const DEFAULT_KNOWLEDGE_FOLDER_NAME = 'BotBoy Knowledge';

/** What the analytics move left behind (knowledge-migration.ts fills it; here it is only stored). */
export interface KnowledgeMigrationRecord {
  at: string;
  source: string;
  files: number;
  planSha256: string;
  /** The explicit `analytics_context.dir` the install had before the move ('' when it used the private default). */
  previousDir: string;
}

export interface KnowledgeLibraryState {
  version: 1;
  /** The recorded root (a canonical path), or null before the owner created the folder. */
  root: string | null;
  /** Where the analytics knowledge lives: the library's `analytics/` set, or the legacy private folder until Move. */
  analyticsDir: 'library' | 'legacy';
  /** Every root this install has used before the current one. Capture stays excluded for each (amendment P2-1). */
  formerRoots: string[];
  activatedAt: string | null;
  migration: KnowledgeMigrationRecord | null;
}

export function emptyKnowledgeState(): KnowledgeLibraryState {
  return { version: 1, root: null, analyticsDir: 'legacy', formerRoots: [], activatedAt: null, migration: null };
}

const MAX_FORMER_ROOTS = 32;

function cleanPaths(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry === 'string' && entry.length > 0 && entry.length <= 1024 && path.isAbsolute(entry) && !entry.includes('\0')) seen.add(entry);
  }
  return [...seen].slice(-MAX_FORMER_ROOTS);
}

/** The stored state with every field defaulted and bounded. Never throws. */
export function readKnowledgeState(db: Database.Database): KnowledgeLibraryState {
  let stored: Partial<KnowledgeLibraryState> | null = null;
  try { stored = getSetting<Partial<KnowledgeLibraryState>>(db, KNOWLEDGE_LIBRARY_KEY); } catch { stored = null; }
  const base = emptyKnowledgeState();
  if (!stored || typeof stored !== 'object') return base;
  const root = typeof stored.root === 'string' && stored.root.length > 0 && stored.root.length <= 1024 && path.isAbsolute(stored.root) && !stored.root.includes('\0')
    ? stored.root
    : null;
  const migration = stored.migration && typeof stored.migration === 'object'
    ? {
        at: String(stored.migration.at ?? ''),
        source: String(stored.migration.source ?? ''),
        files: Number.isFinite(Number(stored.migration.files)) ? Number(stored.migration.files) : 0,
        planSha256: String(stored.migration.planSha256 ?? ''),
        previousDir: String(stored.migration.previousDir ?? ''),
      }
    : null;
  return {
    version: 1,
    root,
    analyticsDir: stored.analyticsDir === 'library' ? 'library' : 'legacy',
    formerRoots: cleanPaths(stored.formerRoots),
    activatedAt: typeof stored.activatedAt === 'string' ? stored.activatedAt : null,
    migration,
  };
}

export function writeKnowledgeState(db: Database.Database, state: KnowledgeLibraryState): void {
  setSetting(db, KNOWLEDGE_LIBRARY_KEY, state);
}

/** `~/Documents/BotBoy Knowledge`. */
export function defaultKnowledgeRoot(): string {
  return path.join(os.homedir(), 'Documents', DEFAULT_KNOWLEDGE_FOLDER_NAME);
}

/**
 * The real path of `target` when it exists. For a folder that does not exist yet (or was deleted), the real path of its
 * nearest existing ancestor plus the remaining names, so a sandbox rule or an exclusion written for a root the owner has
 * not created yet still matches the folder once it appears. Never throws.
 */
export function canonicalizeBestEffort(target: string): string {
  const resolved = path.resolve(target);
  const rest: string[] = [];
  let current = resolved;
  for (;;) {
    try {
      const real = fs.realpathSync.native(current);
      return rest.length > 0 ? path.join(real, ...[...rest].reverse()) : real;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return resolved;
      rest.push(path.basename(current));
      current = parent;
    }
  }
}

/** The root an activation is checking, held in memory so the registered providers report it before it is recorded. */
let pendingRoot: string | null = null;

/** Set while an activation or a location change asserts the sandbox deny and the capture exclusion. */
export function setPendingKnowledgeRoot(root: string | null): void {
  pendingRoot = root;
}

export type KnowledgeRootSource = 'pending' | 'environment' | 'settings' | 'none';

export interface ResolvedKnowledgeRoot {
  /** The root as recorded or set (not yet canonicalized), or null. */
  root: string | null;
  source: KnowledgeRootSource;
  /** True while BOTBOY_KNOWLEDGE_ROOT decides the root: Settings cannot change it. */
  pinnedByEnvironment: boolean;
}

function environmentRoot(): string | null {
  const raw = (process.env[KNOWLEDGE_ROOT_ENV] ?? '').trim();
  return raw && path.isAbsolute(raw) && !raw.includes('\0') ? raw : null;
}

/**
 * The analytics mode the test override decided for this process (P1 review N6 / D2). `BOTBOY_KNOWLEDGE_ROOT` must never
 * change a stored database, so the mode its activation derives lives in memory only, keyed by the override's own root: once
 * the variable is unset or points elsewhere the stored mode applies again.
 */
let environmentAnalyticsMode: { root: string; mode: 'library' | 'legacy' } | null = null;

/** Remember (or forget, with null) the mode the override's activation derived. Memory only: nothing is written. */
export function setEnvironmentAnalyticsMode(mode: 'library' | 'legacy' | null): void {
  const root = environmentRoot();
  environmentAnalyticsMode = mode && root ? { root, mode } : null;
}

/**
 * Where the analytics knowledge lives right now: the in-memory mode while the test override is set and has been
 * activated, else the stored one. Every reader of the mode goes through here (`analyticsLibraryMode`, the status).
 */
export function effectiveAnalyticsDir(db: Database.Database): 'library' | 'legacy' {
  const root = environmentRoot();
  if (root && environmentAnalyticsMode && environmentAnalyticsMode.root === root) return environmentAnalyticsMode.mode;
  return readKnowledgeState(db).analyticsDir;
}

/** An activation in progress, then the test override, then the stored root, else none. Never touches the disk. */
export function resolveKnowledgeRoot(db: Database.Database): ResolvedKnowledgeRoot {
  const fromEnv = environmentRoot();
  if (pendingRoot) return { root: pendingRoot, source: 'pending', pinnedByEnvironment: Boolean(fromEnv) };
  if (fromEnv) return { root: fromEnv, source: 'environment', pinnedByEnvironment: true };
  const stored = readKnowledgeState(db).root;
  return stored ? { root: stored, source: 'settings', pinnedByEnvironment: false } : { root: null, source: 'none', pinnedByEnvironment: false };
}

/** The write-deny provider: the canonical root, or null while the library does not exist. */
export function canonicalRootOrNull(db: Database.Database): string | null {
  const { root } = resolveKnowledgeRoot(db);
  return root ? canonicalizeBestEffort(root) : null;
}

/**
 * The write-deny roots for a sandbox launched now: the root an activation or a location change is copying into (it must be
 * protected before its first byte arrives) and the root that stays current until the switch. Normally just one.
 */
export function knowledgeDenyRoots(db: Database.Database): string[] {
  const roots: string[] = [];
  const add = (value: string | null | undefined) => {
    if (!value) return;
    const canonical = canonicalizeBestEffort(value);
    if (!roots.includes(canonical)) roots.push(canonical);
  };
  add(pendingRoot);
  const fromEnv = environmentRoot();
  add(fromEnv);
  if (!fromEnv) add(readKnowledgeState(db).root);
  return roots;
}

/**
 * The capture-exclusion provider: the current root, any root being activated, the stored root and the test override,
 * every former root, each as recorded and as its real path. Absolute paths; empty while no library was ever created.
 */
export function knowledgeExcludedRoots(db: Database.Database): string[] {
  const state = readKnowledgeState(db);
  const roots = new Set<string>();
  const add = (value: string | null | undefined) => {
    if (!value) return;
    roots.add(path.resolve(value));
    roots.add(canonicalizeBestEffort(value));
  };
  add(pendingRoot);
  add(environmentRoot());
  add(state.root);
  for (const former of state.formerRoots) add(former);
  return [...roots];
}

// ── Validation (K4) ────────────────────────────────────────────────────────

/** The program folder (`personal-productivity-tracker/`), found from this file in both `src/` and `dist/`. */
export function programDirectory(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
}

export interface RootValidationContext {
  home: string;
  privateRoot: string;
  filesDir: string;
  programDir: string;
}

export function defaultRootValidationContext(): RootValidationContext {
  const home = os.homedir();
  const privateRoot = path.join(home, '.personal-productivity-tracker');
  return { home, privateRoot, filesDir: path.join(privateRoot, 'files'), programDir: programDirectory() };
}

/** The standard folders of a Mac home folder: a library may live INSIDE them, never AS them. */
const STANDARD_HOME_FOLDERS = ['Documents', 'Desktop', 'Downloads', 'Library', 'Pictures', 'Movies', 'Music', 'Public', 'Applications'] as const;
const MAX_ROOT_CHARS = 1_024;

export type RootFailureCode =
  | 'invalid_path'
  | 'too_shallow'
  | 'not_allowed_location'
  | 'overlaps_private_state'
  | 'overlaps_program'
  | 'not_a_folder'
  | 'permission_denied'
  | 'root_unavailable'
  | 'io_error'
  | 'boundary_not_registered'
  | 'exclusion_not_registered'
  | 'confirm_existing'
  | 'change_location_required'
  | 'root_pinned_by_environment';

export interface RootFailure {
  ok: false;
  code: RootFailureCode;
  message: string;
  nextAction: string;
}

const failure = (code: RootFailureCode, message: string, nextAction: string): RootFailure => ({ ok: false, code, message, nextAction });

function isInside(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!!relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

/** A leading `~/` means the home folder, so the text box accepts what the owner types in Finder terms. */
export function expandKnowledgePath(raw: string): string {
  const value = String(raw ?? '').trim();
  if (value === '~') return os.homedir();
  if (value.startsWith('~/')) return path.join(os.homedir(), value.slice(2));
  return value;
}

/**
 * Is this a folder the library may live in? Pure apart from reading the real path of what exists. The Seatbelt deny
 * covers the whole subtree, so a root that holds, or lies inside, BotBoy's private state, its files workspace or the
 * program folder is refused (it would block the shell's only writable folder, or the program's own files). The home
 * folder, its ancestors and the standard folders themselves are refused; a folder INSIDE a standard folder is the
 * normal case (`~/Documents/BotBoy Knowledge`).
 */
export function validateKnowledgeRootCandidate(raw: string, context: RootValidationContext = defaultRootValidationContext()): { ok: true; root: string } | RootFailure {
  const expanded = expandKnowledgePath(raw);
  if (!expanded || expanded.length > MAX_ROOT_CHARS || expanded.includes('\0') || /[\r\n]/.test(expanded)) {
    return failure('invalid_path', 'That is not a usable folder path.', 'Type an absolute path such as ~/Documents/BotBoy Knowledge (at most 1,024 characters).');
  }
  if (!path.isAbsolute(expanded)) {
    return failure('invalid_path', 'The path must be absolute.', 'Start the path with / or ~/, for example ~/Documents/BotBoy Knowledge.');
  }
  const root = canonicalizeBestEffort(expanded);
  const segments = root.split(path.sep).filter(Boolean);
  if (root === path.sep || segments.length < 3) {
    return failure('too_shallow', 'That folder is too close to the top of the disk to hold a library.', 'Choose a folder inside your home folder, for example ~/Documents/BotBoy Knowledge.');
  }
  const home = canonicalizeBestEffort(context.home);
  if (root === home || isInside(home, root)) {
    return failure('not_allowed_location', 'Your home folder cannot be the library.', 'Choose a new folder inside it, for example ~/Documents/BotBoy Knowledge.');
  }
  for (const name of STANDARD_HOME_FOLDERS) {
    if (root === canonicalizeBestEffort(path.join(context.home, name))) {
      return failure('not_allowed_location', `${name} itself cannot be the library.`, `Choose a new folder inside it, for example ~/${name}/BotBoy Knowledge.`);
    }
  }
  const privateRoot = canonicalizeBestEffort(context.privateRoot);
  const filesDir = canonicalizeBestEffort(context.filesDir);
  if (isInside(root, privateRoot) || isInside(privateRoot, root) || isInside(root, filesDir) || isInside(filesDir, root)) {
    return failure('overlaps_private_state', "That folder overlaps BotBoy's private storage, which commands it runs are not allowed to use.", 'Choose a folder outside ~/.personal-productivity-tracker.');
  }
  const programDir = canonicalizeBestEffort(context.programDir);
  if (isInside(root, programDir) || isInside(programDir, root)) {
    return failure('overlaps_program', "That folder overlaps BotBoy's own program folder.", 'Choose a folder that is not part of the BotBoy install.');
  }
  return { ok: true, root };
}

/**
 * macOS may ask once for access to Documents (or Desktop, or an external volume), or deny it. Both surface as EPERM or
 * EACCES. They get a next action and are never retried in a loop.
 */
export function classifyRootError(error: unknown, root: string): RootFailure {
  const code = String((error as NodeJS.ErrnoException)?.code ?? '');
  if (code === 'EPERM' || code === 'EACCES') {
    return failure(
      'permission_denied',
      `macOS did not let BotBoy use ${root}.`,
      'Open System Settings → Privacy & Security → Files and Folders, allow BotBoy (or the app that starts it) for that folder, then try again. Or choose another location with Change location.',
    );
  }
  if (code === 'ENOENT' || code === 'ENOTDIR') {
    return failure('root_unavailable', `The folder ${root} is missing.`, 'Create the folder again from Settings → Knowledge, or choose another location with Change location.');
  }
  return failure('io_error', `BotBoy could not use ${root}: ${String((error as Error)?.message ?? error).slice(0, 200)}`, 'Check that the folder is on a connected disk and try again, or choose another location.');
}

// ── Boundaries an activation must see before it completes (K1, K2) ────────

/** The sandbox deny must already report this exact root; otherwise activation stops before it creates anything. */
export function assertWriteBoundary(root: string): RootFailure | null {
  if (writeProtectedRootsInEffect().includes(root)) return null;
  return failure(
    'boundary_not_registered',
    'The write protection for the Knowledge folder is not in effect, so the folder was not created.',
    'Restart BotBoy and try again. If this repeats, the program folder or the files workspace overlaps the chosen folder; choose another location.',
  );
}

/** The capture exclusion must already cover this root; otherwise the always-on watcher could read the library. */
export function assertCaptureExclusion(root: string): RootFailure | null {
  if (isCaptureExcludedPath(root)) return null;
  return failure(
    'exclusion_not_registered',
    'The capture exclusion for the Knowledge folder is not in effect, so the folder was not created.',
    'Restart BotBoy and try again.',
  );
}

// ── Activation (K3) ────────────────────────────────────────────────────────

export interface ActivationOptions {
  /** The owner saw what a non-empty existing folder means and chose it anyway. */
  confirmExisting?: boolean;
  /** Does the install have analytics knowledge in the legacy private folder? Unknown means yes (nothing moves). */
  legacyHasContent?: () => boolean;
  /** Test seam: a different validation context. */
  context?: RootValidationContext;
  /**
   * Record the chosen path as the stored root (default). The test override `BOTBOY_KNOWLEDGE_ROOT` passes false: it
   * decides the location by itself, and a temporary folder must never become the stored root of a real database.
   */
  recordRoot?: boolean;
}

export type ActivationResult =
  | { ok: true; root: string; created: boolean; seededGuide: boolean; analyticsDir: 'library' | 'legacy'; changedRoot: boolean }
  | (RootFailure & { existing?: { entries: number; sample: string[] } });

/**
 * The owner's Create folder click (and Change location's final step). Idempotent: running it again for the recorded root
 * creates nothing new. All disk work is async, so a macOS permission prompt cannot freeze the event loop. Order is the
 * safety argument: validate, put the root in memory, ask the two providers whether the deny and the exclusion already
 * cover it, and only then touch the disk. The root is recorded in one write after the folder and its guide exist.
 */
export async function activateKnowledgeRoot(db: Database.Database, raw: string, options: ActivationOptions = {}): Promise<ActivationResult> {
  if (environmentRoot()) {
    return failure('root_pinned_by_environment', `The location is set by ${KNOWLEDGE_ROOT_ENV} and cannot be changed here.`, `Unset ${KNOWLEDGE_ROOT_ENV} to choose a location in Settings.`);
  }
  return activateResolvedRoot(db, raw, options);
}

/** The environment root counts as activated: the service runs the same idempotent steps on first use. */
export async function activateResolvedRoot(db: Database.Database, raw: string, options: ActivationOptions = {}): Promise<ActivationResult> {
  const checked = validateKnowledgeRootCandidate(raw, options.context);
  if (!checked.ok) return checked;
  const root = checked.root;
  const before = readKnowledgeState(db);
  const known = new Set([before.root, ...before.formerRoots].filter((entry): entry is string => Boolean(entry)).map((entry) => canonicalizeBestEffort(entry)));
  const alreadyRecorded = known.has(root);

  setPendingKnowledgeRoot(root);
  invalidateCaptureExclusions();
  try {
    const boundary = assertWriteBoundary(root) ?? assertCaptureExclusion(root);
    if (boundary) return boundary;

    let existed = false;
    try {
      const stat = await fsp.stat(root);
      if (!stat.isDirectory()) return failure('not_a_folder', `${root} exists and is not a folder.`, 'Choose a different location.');
      existed = true;
      const names = (await fsp.readdir(root)).filter((name) => !name.startsWith('.'));
      if (names.length > 0 && !alreadyRecorded && !options.confirmExisting) {
        return {
          ...failure(
            'confirm_existing',
            `${root} already holds ${names.length} item${names.length === 1 ? '' : 's'}. BotBoy will treat each folder directly inside it as a knowledge set and will never change a file it did not write.`,
            'Confirm to use this folder, or choose an empty one.',
          ),
          existing: { entries: names.length, sample: names.sort().slice(0, 8) },
        };
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') return classifyRootError(error, root);
    }

    try {
      await fsp.mkdir(root, { recursive: true });
      let seededGuide = false;
      try {
        await fsp.writeFile(path.join(root, GUIDE_FILE_NAME), ROOT_GUIDE_SEED, { flag: 'wx' });
        seededGuide = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code !== 'EEXIST') throw error;
      }

      const legacyHasContent = options.legacyHasContent ? options.legacyHasContent() : true;
      const analyticsDir: 'library' | 'legacy' = before.analyticsDir === 'library' || !legacyHasContent ? 'library' : 'legacy';
      if (analyticsDir === 'library') {
        await fsp.mkdir(path.join(root, 'analytics', 'presets'), { recursive: true });
        await fsp.mkdir(path.join(root, 'analytics', 'lessons'), { recursive: true });
      }

      const recordRoot = options.recordRoot !== false;
      if (!recordRoot) {
        // The test override decides the location by itself and must never change a stored database: the mode this
        // activation derives lives in memory (`effectiveAnalyticsDir`), and the stored state is left exactly as it was.
        setEnvironmentAnalyticsMode(analyticsDir);
        return { ok: true, root, created: !existed, seededGuide, analyticsDir, changedRoot: false };
      }
      const changedRoot = before.root !== null && canonicalizeBestEffort(before.root) !== root;
      const formerRoots = changedRoot && before.root ? [...before.formerRoots.filter((entry) => entry !== before.root), before.root] : before.formerRoots;
      db.transaction(() => {
        writeKnowledgeState(db, {
          ...before,
          root,
          analyticsDir,
          formerRoots: formerRoots.filter((entry) => entry !== root),
          activatedAt: before.activatedAt ?? new Date().toISOString(),
        });
      })();
      return { ok: true, root, created: !existed, seededGuide, analyticsDir, changedRoot };
    } catch (error) {
      return classifyRootError(error, root);
    }
  } finally {
    setPendingKnowledgeRoot(null);
    invalidateCaptureExclusions();
  }
}
