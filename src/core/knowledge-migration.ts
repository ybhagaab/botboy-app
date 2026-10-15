/**
 * Moving the analytics knowledge into the library, and changing the library's location (knowledge-library.md K11).
 *
 * Option A of the design (owner-approved by default, the orchestrator's recommendation): COPY, verify, then switch, as one
 * explicit owner action. Nothing is moved or deleted; the legacy folder stays exactly as it was and is named in the UI;
 * revert copies back and never deletes. Binding invariants, each tested:
 *   - no install loses a file it could read before (scope = what `listAnalyticsContext` lists in the legacy folder, plus
 *     `manifest.json`; a symbolic link to a regular file is copied as that file's bytes under the link's name; a listed
 *     entry that cannot be read, a link to a non-file or too little free space BLOCKS the move);
 *   - relative ids (`presets/shopwave.md`) and the R6.2a file-SHA receipts stay valid: the bytes are identical;
 *   - ETL onboarding's `.onboarding/` work folder stays in BotBoy's private state;
 *   - idempotent and resumable (a target with the same SHA is skipped; a target with different bytes is a conflict that
 *     aborts BEFORE any switch, never an overwrite); reversible; a dry run (`plan`) writes nothing;
 *   - the final verification and the switch run in one tick with no await between them (design amendment P2-14b), so a
 *     lesson adopted meanwhile cannot land in the legacy folder after the last check.
 *
 * Change location uses the same copy-and-verify mechanics for the whole library (hidden entries and links are not
 * copied), asserts the sandbox deny and the capture exclusion for the NEW root before it copies a single byte, and
 * records the old root as a former root. The old folder is never deleted.
 */
import type Database from 'better-sqlite3';
import { createHash } from 'crypto';
import fs from 'fs';
import { promises as fsp } from 'fs';
import os from 'os';
import path from 'path';
import { ANALYTICS_CONTEXT_DIR_KEY, legacyAnalyticsContentSummary, legacyAnalyticsContextDir, privateAnalyticsContextDir } from './analytics-context.js';
import { invalidateCaptureExclusions } from './capture-exclusions.js';
import type { KnowledgeLibrary } from './knowledge-library.js';
import {
  activateKnowledgeRoot,
  assertCaptureExclusion,
  assertWriteBoundary,
  canonicalizeBestEffort,
  classifyRootError,
  effectiveAnalyticsDir,
  readKnowledgeState,
  resolveKnowledgeRoot,
  setPendingKnowledgeRoot,
  validateKnowledgeRootCandidate,
  writeKnowledgeState,
  type KnowledgeMigrationRecord,
  type RootFailure,
} from './knowledge-root.js';
import { renderAllLessonScopes } from './lessons-ledger.js';
import { getSetting, setSetting } from './storage.js';

const ALLOWED_EXTENSIONS = new Set(['.md', '.txt']);
const LISTED_SUBDIRS = ['presets', 'lessons'] as const;
const MAX_RECOPY_ROUNDS = 3;
const MAX_TREE_ENTRIES = 20_000;

const sha256 = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');

export interface MigrationEntry {
  /** Relative id inside the analytics folder, POSIX: `notes.md`, `presets/shopwave.md`, `manifest.json`. */
  name: string;
  bytes: number;
  sha256: string;
  fromLink: boolean;
  /** What apply does: copy it, it is already there with the same bytes, or the target differs (a conflict). */
  state: 'copy' | 'present' | 'conflict';
}

export interface MigrationPlan {
  /** Move can be applied right now. */
  ok: boolean;
  /** The first reason it cannot, when it cannot. */
  reason: MigrationFailureCode | null;
  alreadyMigrated: boolean;
  source: string;
  target: string | null;
  entries: MigrationEntry[];
  conflicts: string[];
  blocked: Array<{ name: string; reason: string }>;
  ignored: Array<{ name: string; reason: string }>;
  /** A legacy root GUIDE.md becomes the analytics set's guide metadata and leaves the old catalog: the owner must acknowledge. */
  reclassified: string[];
  totalBytes: number;
  freeBytes: number | null;
  onboardingBusy: boolean;
  boundaryRegistered: boolean;
  planSha256: string;
  /** The explicit directory the install used before ('' when it used the private default). */
  previousDir: string;
}

export type MigrationFailureCode =
  | 'not_activated'
  | 'already_migrated'
  | 'not_migrated'
  | 'blocked'
  | 'conflict'
  | 'plan_changed'
  | 'acknowledgement_required'
  | 'onboarding_running'
  | 'boundary_not_registered'
  | 'exclusion_not_registered'
  | 'source_changed'
  | 'verify_failed'
  | 'not_enough_space'
  | 'io_error'
  | 'permission_denied'
  | 'nested_roots'
  | 'same_root'
  | 'invalid_path'
  | RootFailure['code'];

export interface MigrationFailure {
  ok: false;
  code: MigrationFailureCode;
  message: string;
  nextAction: string;
  details?: Record<string, unknown>;
}

const fail = (code: MigrationFailureCode, message: string, nextAction: string, details?: Record<string, unknown>): MigrationFailure => ({ ok: false, code, message, nextAction, ...(details ? { details } : {}) });

export interface MigrationDeps {
  db: Database.Database;
  library: KnowledgeLibrary;
  /** True while ETL onboarding is running: it writes presets, so nothing moves meanwhile. */
  onboardingBusy?: () => boolean;
  /** Where the append-only log goes; default `~/.personal-productivity-tracker/knowledge-migration.log`. */
  logFile?: string;
  now?: () => Date;
}

export interface KnowledgeMigration {
  plan(): Promise<MigrationPlan>;
  apply(input: { confirm: string; acknowledgeReclassified?: boolean }): Promise<{ ok: true; record: KnowledgeMigrationRecord; copied: number; skipped: number; source: string; target: string } | MigrationFailure>;
  revert(): Promise<{ ok: true; mirrored: number; savedAsPreRevert: number; source: string } | MigrationFailure>;
  changeLocation(input: { path: string; confirmExisting?: boolean; leaveBehind?: string[] }): Promise<{ ok: true; root: string; oldRoot: string; copied: number; skipped: number; notCopied: number; notCopiedSample: string[]; note: string } | MigrationFailure | (RootFailure & { existing?: unknown })>;
}

// ── Enumeration ────────────────────────────────────────────────────────────

interface Enumerated {
  entries: Array<{ name: string; absolute: string; bytes: number; sha256: string; fromLink: boolean }>;
  blocked: Array<{ name: string; reason: string }>;
  ignored: Array<{ name: string; reason: string }>;
  reclassified: string[];
}

/** What the legacy folder lists today (root, presets/, lessons/ notes and the manifest), read without changing anything. */
async function enumerateAnalyticsFolder(dir: string): Promise<Enumerated> {
  const out: Enumerated = { entries: [], blocked: [], ignored: [], reclassified: [] };
  const scan = async (subdir: string) => {
    const absolute = path.join(dir, subdir);
    let names: fs.Dirent[];
    try {
      names = (await fsp.readdir(absolute, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : 1));
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT' && subdir === '') out.blocked.push({ name: subdir || '.', reason: `the folder cannot be read (${(error as NodeJS.ErrnoException)?.code ?? 'error'})` });
      return;
    }
    for (const entry of names) {
      const relative = subdir ? `${subdir}/${entry.name}` : entry.name;
      const file = path.join(absolute, entry.name);
      if (entry.name.startsWith('.')) { out.ignored.push({ name: relative, reason: entry.name === '.onboarding' ? 'work files stay in BotBoy private state' : 'hidden' }); continue; }
      let stat: fs.Stats;
      let fromLink = false;
      try {
        const lstat = await fsp.lstat(file);
        fromLink = lstat.isSymbolicLink();
        stat = fromLink ? await fsp.stat(file) : lstat;
      } catch (error) {
        const wasLink = entry.isSymbolicLink();
        if (/\.(md|txt)$/i.test(entry.name) || entry.name === 'manifest.json') out.blocked.push({ name: relative, reason: wasLink ? 'a link whose target cannot be read' : `cannot be read (${(error as NodeJS.ErrnoException)?.code ?? 'error'})` });
        else out.ignored.push({ name: relative, reason: 'cannot be read' });
        continue;
      }
      const listed = ALLOWED_EXTENSIONS.has(path.extname(entry.name).toLowerCase()) || (subdir === '' && entry.name === 'manifest.json');
      if (stat.isDirectory()) {
        if (subdir === '' && (LISTED_SUBDIRS as readonly string[]).includes(entry.name) && !fromLink) continue;
        // A link named like a note whose target is a folder is something to look at, not something to skip silently.
        if (fromLink && listed) { out.blocked.push({ name: relative, reason: 'a link whose target is not a regular file' }); continue; }
        out.ignored.push({ name: relative, reason: 'a sub-folder BotBoy never listed' });
        continue;
      }
      if (!listed) { out.ignored.push({ name: relative, reason: 'a type BotBoy never listed' }); continue; }
      if (!stat.isFile()) { out.blocked.push({ name: relative, reason: 'a link whose target is not a regular file' }); continue; }
      try {
        const bytes = await fsp.readFile(file);
        out.entries.push({ name: relative, absolute: file, bytes: bytes.length, sha256: sha256(bytes), fromLink });
        if (subdir === '' && entry.name.toLowerCase() === 'guide.md') out.reclassified.push(entry.name);
      } catch (error) {
        out.blocked.push({ name: relative, reason: `cannot be read (${(error as NodeJS.ErrnoException)?.code ?? 'error'})` });
      }
    }
  };
  await scan('');
  for (const sub of LISTED_SUBDIRS) await scan(sub);
  return out;
}

async function hashIfExists(file: string): Promise<string | null> {
  try { return sha256(await fsp.readFile(file)); } catch { return null; }
}

/** Write `bytes` beside `target` and rename into place: a reader never sees half a file. */
async function writeAtomically(target: string, bytes: Buffer): Promise<void> {
  await fsp.mkdir(path.dirname(target), { recursive: true });
  const temp = `${target}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    await fsp.writeFile(temp, bytes);
    await fsp.rename(temp, target);
  } catch (error) {
    await fsp.rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function freeBytesOf(dir: string): Promise<number | null> {
  let probe = dir;
  for (let depth = 0; depth < 12; depth += 1) {
    try {
      const stats = await fsp.statfs(probe);
      return Number(stats.bavail) * Number(stats.bsize);
    } catch {
      const parent = path.dirname(probe);
      if (parent === probe) return null;
      probe = parent;
    }
  }
  return null;
}

const insideOrEqual = (child: string, parent: string) => child === parent || child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);

// ── The migration ──────────────────────────────────────────────────────────

export function createKnowledgeMigration(deps: MigrationDeps): KnowledgeMigration {
  const { db, library } = deps;
  const now = deps.now ?? (() => new Date());
  const logFile = deps.logFile ?? path.join(os.homedir(), '.personal-productivity-tracker', 'knowledge-migration.log');

  function log(event: string, data: Record<string, unknown>): void {
    try {
      fs.mkdirSync(path.dirname(logFile), { recursive: true });
      fs.appendFileSync(logFile, `${JSON.stringify({ at: now().toISOString(), event, ...data })}\n`);
    } catch { /* the log is advisory */ }
  }

  const targetOf = (): string | null => {
    const { root } = resolveKnowledgeRoot(db);
    return root ? path.join(canonicalizeBestEffort(root), 'analytics') : null;
  };

  async function plan(): Promise<MigrationPlan> {
    const mode = effectiveAnalyticsDir(db);
    const source = legacyAnalyticsContextDir(db);
    const target = targetOf();
    const explicit = (getSetting<string>(db, ANALYTICS_CONTEXT_DIR_KEY) ?? '').trim();
    const base: MigrationPlan = {
      ok: false, reason: null, alreadyMigrated: mode === 'library', source, target, entries: [], conflicts: [], blocked: [], ignored: [],
      reclassified: [], totalBytes: 0, freeBytes: null, onboardingBusy: Boolean(deps.onboardingBusy?.()), boundaryRegistered: false, planSha256: '', previousDir: explicit,
    };
    if (!target) return { ...base, reason: 'not_activated' };
    if (mode === 'library') return { ...base, reason: 'already_migrated', planSha256: sha256('already-migrated') };
    const root = path.dirname(target);
    const boundaryRegistered = !assertWriteBoundary(root) && !assertCaptureExclusion(root);
    const enumerated = await enumerateAnalyticsFolder(source);
    const entries: MigrationEntry[] = [];
    const conflicts: string[] = [];
    for (const entry of enumerated.entries) {
      const present = await hashIfExists(path.join(target, ...entry.name.split('/')));
      const entryState: MigrationEntry['state'] = present === null ? 'copy' : present === entry.sha256 ? 'present' : 'conflict';
      if (entryState === 'conflict') conflicts.push(entry.name);
      entries.push({ name: entry.name, bytes: entry.bytes, sha256: entry.sha256, fromLink: entry.fromLink, state: entryState });
    }
    const totalBytes = entries.reduce((sum, entry) => sum + entry.bytes, 0);
    const freeBytes = await freeBytesOf(root);
    const blocked = [...enumerated.blocked];
    if (freeBytes !== null && freeBytes < totalBytes * 2) blocked.push({ name: '.', reason: `not enough free space (${totalBytes * 2} bytes needed, ${freeBytes} free)` });
    const digest = sha256(JSON.stringify({
      source, target, entries: entries.map((entry) => [entry.name, entry.sha256, entry.bytes, entry.fromLink]),
      ignored: enumerated.ignored.map((entry) => entry.name), reclassified: enumerated.reclassified,
    }));
    const planned: MigrationPlan = {
      ...base, entries, conflicts, blocked, ignored: enumerated.ignored, reclassified: enumerated.reclassified, totalBytes, freeBytes, boundaryRegistered, planSha256: digest,
    };
    const reason: MigrationFailureCode | null = blocked.length ? 'blocked'
      : conflicts.length ? 'conflict'
        : planned.onboardingBusy ? 'onboarding_running'
          : !boundaryRegistered ? 'boundary_not_registered'
            : null;
    return { ...planned, reason, ok: reason === null };
  }

  const reasonMessage = (planned: MigrationPlan): MigrationFailure => {
    switch (planned.reason) {
      case 'not_activated': return fail('not_activated', 'The Knowledge folder has not been created yet.', 'Create the folder in Settings → Knowledge first.');
      case 'already_migrated': return fail('already_migrated', 'Your analytics knowledge already lives in the Knowledge library.', 'Nothing to move.');
      case 'blocked': return fail('blocked', `${planned.blocked.length} item(s) cannot be moved safely: ${planned.blocked.slice(0, 3).map((item) => `${item.name} (${item.reason})`).join('; ')}.`, 'Fix or remove them in the old folder, then preview again. Nothing was changed.', { blocked: planned.blocked });
      case 'conflict': return fail('conflict', `${planned.conflicts.length} file(s) already exist in the library with different content: ${planned.conflicts.slice(0, 3).join(', ')}.`, 'Rename or move those files in the library, then preview again. Nothing was changed.', { conflicts: planned.conflicts });
      case 'onboarding_running': return fail('onboarding_running', 'ETL preset generation is running, and it writes into this folder.', 'Wait for it to finish, then preview again.');
      case 'boundary_not_registered': return fail('boundary_not_registered', 'The protection for the Knowledge folder is not in effect, so nothing was moved.', 'Restart BotBoy and try again.');
      default: return fail('io_error', 'The move cannot run.', 'Preview again.');
    }
  };

  /**
   * While `BOTBOY_KNOWLEDGE_ROOT` decides the location, Move and Revert are refused: they store `analyticsDir` while the
   * stored root stays empty, which leaves a real database in library mode with no folder (P1 review N6 / D2). Preview stays
   * available; it writes nothing.
   */
  const pinnedFailure = (): MigrationFailure | null =>
    resolveKnowledgeRoot(db).pinnedByEnvironment
      ? fail('root_pinned_by_environment', 'The location is set by BOTBOY_KNOWLEDGE_ROOT, so the analytics knowledge cannot be moved or moved back here.', 'Unset BOTBOY_KNOWLEDGE_ROOT, then use Settings → Knowledge. Preview is still available.')
      : null;
  async function apply(input: { confirm: string; acknowledgeReclassified?: boolean }) {
    return library.withLock(async () => {
      const pinned = pinnedFailure();
      if (pinned) return pinned;
      const planned = await plan();
      if (planned.reason === 'already_migrated' || planned.reason === 'not_activated') return reasonMessage(planned);
      if (!input?.confirm || input.confirm !== planned.planSha256) {
        return fail('plan_changed', 'The folder changed since you previewed the move, or the confirmation does not match.', 'Preview the move again and confirm that plan.');
      }
      if (!planned.ok) return reasonMessage(planned);
      if (planned.reclassified.length > 0 && input.acknowledgeReclassified !== true) {
        return fail('acknowledgement_required', `${planned.reclassified.join(', ')} in your old folder becomes the guide of the analytics set and leaves its list of notes.`, 'Confirm that you understand, then apply again.', { reclassified: planned.reclassified });
      }
      const target = planned.target as string;
      const ledger = new Map<string, string>();
      let copied = 0;
      let skipped = 0;
      try {
        for (const entry of planned.entries) {
          const destination = path.join(target, ...entry.name.split('/'));
          const present = await hashIfExists(destination);
          if (present === entry.sha256) { skipped += 1; continue; }
          if (present !== null) return fail('conflict', `${entry.name} appeared in the library with different content while the move ran.`, 'Nothing was switched. Rename that file, then preview again.', { conflicts: [entry.name] });
          const bytes = await fsp.readFile(path.join(planned.source, ...entry.name.split('/')));
          if (sha256(bytes) !== entry.sha256) return fail('source_changed', `${entry.name} changed in the old folder while the move ran.`, 'Nothing was switched. Preview again.');
          await writeAtomically(destination, bytes);
          ledger.set(destination, entry.sha256);
          copied += 1;
        }
        // Verify every target, and recopy a source that moved ONLY over a target that still holds what we wrote.
        for (let round = 0; ; round += 1) {
          let dirty = false;
          for (const entry of planned.entries) {
            const destination = path.join(target, ...entry.name.split('/'));
            const sourceNow = await hashIfExists(path.join(planned.source, ...entry.name.split('/')));
            const targetNow = await hashIfExists(destination);
            if (sourceNow === entry.sha256 && targetNow === entry.sha256) continue;
            if (sourceNow !== null && sourceNow !== entry.sha256 && targetNow === ledger.get(destination)) {
              const bytes = await fsp.readFile(path.join(planned.source, ...entry.name.split('/')));
              await writeAtomically(destination, bytes);
              ledger.set(destination, sha256(bytes));
              entry.sha256 = sha256(bytes);
              dirty = true;
              continue;
            }
            return fail(sourceNow === null || sourceNow !== entry.sha256 ? 'source_changed' : 'verify_failed', `${entry.name} no longer matches between the old folder and the library.`, 'Nothing was switched. Preview again.', { name: entry.name });
          }
          if (!dirty) break;
          if (round + 1 >= MAX_RECOPY_ROUNDS) return fail('source_changed', 'The old folder kept changing while the move ran.', 'Nothing was switched. Wait for other work to stop, then preview again.');
        }
      } catch (error) {
        const blocked = classifyRootError(error, target);
        return fail(blocked.code === 'permission_denied' ? 'permission_denied' : 'io_error', blocked.message, blocked.nextAction);
      }

      // ── Final verify and the switch: synchronous, no await between them (design amendment P2-14b). ──
      const record: KnowledgeMigrationRecord = {
        at: now().toISOString(), source: planned.source, files: planned.entries.length, planSha256: planned.planSha256, previousDir: planned.previousDir,
      };
      const verdict = ((): MigrationFailure | null => {
        for (const entry of planned.entries) {
          const destination = path.join(target, ...entry.name.split('/'));
          let targetBytes: Buffer;
          let sourceBytes: Buffer;
          try {
            targetBytes = fs.readFileSync(destination);
            sourceBytes = fs.readFileSync(path.join(planned.source, ...entry.name.split('/')));
          } catch {
            return fail('verify_failed', `${entry.name} could not be read for the final check.`, 'Nothing was switched. Preview again.');
          }
          if (sha256(targetBytes) !== entry.sha256 || sha256(sourceBytes) !== entry.sha256) {
            return fail('source_changed', `${entry.name} changed just before the switch.`, 'Nothing was switched. Preview again.');
          }
        }
        const before = readKnowledgeState(db);
        try {
          db.transaction(() => {
            writeKnowledgeState(db, { ...before, analyticsDir: 'library', migration: record });
            setSetting(db, ANALYTICS_CONTEXT_DIR_KEY, null);
          })();
        } catch (error) {
          // One transaction: either both settings changed or neither did.
          return fail('io_error', `The switch could not be saved (${String((error as Error)?.message ?? error).slice(0, 120)}).`, 'Nothing was switched. Try again.');
        }
        return null;
      })();
      if (verdict) return verdict;

      // After the switch. None of this can undo it; each step reports through the log.
      try {
        const custom = planned.previousDir !== '';
        if (custom) {
          const from = path.join(planned.source, '.onboarding');
          const to = path.join(privateAnalyticsContextDir(), '.onboarding');
          if (fs.existsSync(from) && !fs.existsSync(to)) fs.cpSync(from, to, { recursive: true, errorOnExist: false });
        }
      } catch (error) {
        log('onboarding_workfiles_copy_failed', { message: String((error as Error)?.message ?? error).slice(0, 200) });
      }
      try { renderAllLessonScopes(db); } catch (error) { log('lesson_render_failed', { message: String((error as Error)?.message ?? error).slice(0, 200) }); }
      library.invalidate();
      library.bump();
      log('migration_applied', { source: planned.source, target, files: planned.entries.length, planSha256: planned.planSha256, copied, skipped, hashes: planned.entries.map((entry) => [entry.name, entry.sha256.slice(0, 12)]) });
      return { ok: true as const, record, copied, skipped, source: planned.source, target };
    });
  }

  async function revert() {
    return library.withLock(async () => {
      const pinned = pinnedFailure();
      if (pinned) return pinned;
      const state = readKnowledgeState(db);
      if (state.analyticsDir !== 'library' || !state.migration) {
        return fail('not_migrated', 'Your analytics knowledge was not moved by the Move button, so there is nothing to revert.', 'Nothing was changed.');
      }
      const target = targetOf();
      if (!target) return fail('not_activated', 'The Knowledge folder is not set up.', 'Open Settings → Knowledge.');
      const legacy = state.migration.source;
      let mirrored = 0;
      let savedAsPreRevert = 0;
      try {
        const enumerated = await enumerateAnalyticsFolder(target);
        if (enumerated.blocked.length) return fail('blocked', `${enumerated.blocked.length} item(s) in the library cannot be copied back: ${enumerated.blocked.slice(0, 3).map((item) => item.name).join(', ')}.`, 'Fix them, then revert again. Nothing was changed.');
        for (const entry of enumerated.entries) {
          const destination = path.join(legacy, ...entry.name.split('/'));
          const bytes = await fsp.readFile(entry.absolute);
          const present = await hashIfExists(destination);
          if (present === entry.sha256) continue;
          if (present !== null) {
            // The old folder holds different bytes under this name: keep them beside it, never overwrite blind.
            await writeAtomically(`${destination}.pre-revert`, await fsp.readFile(destination));
            savedAsPreRevert += 1;
          }
          await writeAtomically(destination, bytes);
          mirrored += 1;
        }
      } catch (error) {
        const blocked = classifyRootError(error, legacy);
        return fail(blocked.code === 'permission_denied' ? 'permission_denied' : 'io_error', blocked.message, blocked.nextAction);
      }
      db.transaction(() => {
        writeKnowledgeState(db, { ...readKnowledgeState(db), analyticsDir: 'legacy', migration: null });
        setSetting(db, ANALYTICS_CONTEXT_DIR_KEY, state.migration!.previousDir || null);
      })();
      try { renderAllLessonScopes(db); } catch (error) { log('lesson_render_failed', { message: String((error as Error)?.message ?? error).slice(0, 200) }); }
      library.invalidate();
      library.bump();
      log('migration_reverted', { source: legacy, target, mirrored, savedAsPreRevert, planSha256: state.migration.planSha256 });
      return { ok: true as const, mirrored, savedAsPreRevert, source: legacy };
    });
  }

  // ── Change location ──

  /**
   * Every regular file of a tree, relative POSIX paths. Hidden entries and links are not copied, and are counted so the owner
   * is told (`notCopied`); Finder's `.DS_Store` is not worth a sentence and is not counted.
   */
  async function listTree(root: string, leaveBehind: ReadonlySet<string>): Promise<{ files: Array<{ name: string; absolute: string; bytes: number }>; notCopied: string[] }> {
    const files: Array<{ name: string; absolute: string; bytes: number }> = [];
    const notCopied: string[] = [];
    let count = 0;
    const walk = async (dir: string, relative: string) => {
      for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
        if (++count > MAX_TREE_ENTRIES) throw Object.assign(new Error('the library is too large to copy in one step'), { code: 'EFBIG' });
        const rel = relative ? `${relative}/${entry.name}` : entry.name;
        if (entry.name.startsWith('.') || entry.isSymbolicLink()) {
          if (entry.name !== '.DS_Store') notCopied.push(rel);
          continue;
        }
        if (relative === '' && leaveBehind.has(entry.name.toLowerCase())) continue;
        const absolute = path.join(dir, entry.name);
        if (entry.isDirectory()) await walk(absolute, rel);
        else if (entry.isFile()) files.push({ name: rel, absolute, bytes: (await fsp.stat(absolute)).size });
      }
    };
    await walk(root, '');
    return { files, notCopied };
  }

  async function changeLocation(input: { path: string; confirmExisting?: boolean; leaveBehind?: string[] }) {
    return library.withLock(async () => {
      const state = readKnowledgeState(db);
      const resolved = resolveKnowledgeRoot(db);
      if (resolved.pinnedByEnvironment) return fail('root_pinned_by_environment', 'The location is set by BOTBOY_KNOWLEDGE_ROOT and cannot be changed here.', 'Unset BOTBOY_KNOWLEDGE_ROOT to choose a location in Settings.');
      if (!state.root) return fail('not_activated', 'There is no Knowledge folder to move yet.', 'Create the folder in Settings → Knowledge first.');
      if (deps.onboardingBusy?.()) return fail('onboarding_running', 'ETL preset generation is running, and it writes into this folder.', 'Wait for it to finish, then try again.');
      const checked = validateKnowledgeRootCandidate(String(input.path ?? ''));
      if (!checked.ok) return checked;
      const oldRoot = canonicalizeBestEffort(state.root);
      const newRoot = checked.root;
      if (newRoot === oldRoot) return fail('same_root', 'That is already the Knowledge folder.', 'Choose a different folder.');
      if (insideOrEqual(newRoot, oldRoot) || insideOrEqual(oldRoot, newRoot)) return fail('nested_roots', 'The new folder cannot be inside the old one, or the other way round.', 'Choose a folder beside it.');

      // The walls first: nothing is copied into the new folder until the deny and the capture exclusion cover it.
      setPendingKnowledgeRoot(newRoot);
      invalidateCaptureExclusions();
      try {
        const walls = assertWriteBoundary(newRoot) ?? assertCaptureExclusion(newRoot);
        if (walls) return walls;
        const leave = new Set((input.leaveBehind ?? []).map((name) => String(name).trim().toLowerCase()).filter(Boolean));
        // The analytics set always travels while the install keeps its analytics knowledge in the library.
        if (state.analyticsDir === 'library') leave.delete('analytics');
        leave.delete('guide.md');
        let tree: Array<{ name: string; absolute: string; bytes: number }>;
        let notCopied: string[];
        try {
          ({ files: tree, notCopied } = await listTree(oldRoot, leave));
        } catch (error) {
          const blocked = classifyRootError(error, oldRoot);
          return blocked.code === 'permission_denied' ? blocked : fail('io_error', blocked.message, blocked.nextAction);
        }
        const total = tree.reduce((sum, file) => sum + file.bytes, 0);
        const free = await freeBytesOf(newRoot);
        if (free !== null && free < total * 2) return fail('not_enough_space', `Not enough free space for the copy (${total * 2} bytes needed, ${free} free).`, 'Free some space or choose another disk. Nothing was changed.');
        let copied = 0;
        let skipped = 0;
        const existing = await fsp.readdir(newRoot).catch(() => [] as string[]);
        if (existing.length > 0 && !input.confirmExisting) {
          return { ...fail('confirm_existing', `${newRoot} already holds ${existing.length} item(s).`, 'Confirm to copy into it (files with different content stop the copy), or choose an empty folder.'), existing: { entries: existing.length, sample: existing.sort().slice(0, 8) } } as RootFailure & { existing: unknown };
        }
        try {
          for (const file of tree) {
            const destination = path.join(newRoot, ...file.name.split('/'));
            const bytes = await fsp.readFile(file.absolute);
            const present = await hashIfExists(destination);
            if (present === sha256(bytes)) { skipped += 1; continue; }
            if (present !== null) return fail('conflict', `${file.name} already exists in the new folder with different content.`, 'Nothing was switched. Rename it or choose an empty folder.', { conflicts: [file.name] });
            await writeAtomically(destination, bytes);
            copied += 1;
          }
          for (const file of tree) {
            const destination = path.join(newRoot, ...file.name.split('/'));
            const [from, to] = [await hashIfExists(file.absolute), await hashIfExists(destination)];
            if (from === null || from !== to) return fail('verify_failed', `${file.name} does not match after the copy.`, 'Nothing was switched. Try again.', { name: file.name });
          }
        } catch (error) {
          const blocked = classifyRootError(error, newRoot);
          return blocked.code === 'permission_denied' ? blocked : fail('io_error', blocked.message, blocked.nextAction);
        }
        const legacyHasContent = () => {
          const summary = legacyAnalyticsContentSummary(db);
          return summary.files > 0 || summary.hasManifest;
        };
        const activated = await activateKnowledgeRoot(db, newRoot, { confirmExisting: true, legacyHasContent });
        if (!activated.ok) return activated;
        try { renderAllLessonScopes(db); } catch (error) { log('lesson_render_failed', { message: String((error as Error)?.message ?? error).slice(0, 200) }); }
        library.invalidate();
        library.bump();
        log('location_changed', { from: oldRoot, to: newRoot, copied, skipped, notCopied: notCopied.length, leftBehind: [...leave] });
        return {
          ok: true as const, root: newRoot, oldRoot, copied, skipped, notCopied: notCopied.length, notCopiedSample: notCopied.slice(0, 5),
          note: `Your old folder at ${oldRoot} was left exactly as it was; BotBoy never deletes it. Terminals or tools started before this change keep the old protection until they restart.`,
        };
      } finally {
        setPendingKnowledgeRoot(null);
        invalidateCaptureExclusions();
      }
    });
  }

  return { plan, apply, revert, changeLocation };
}

