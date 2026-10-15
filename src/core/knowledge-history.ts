/**
 * History and Undo for the Knowledge library (knowledge-library.md K13; brief 4.5).
 *
 * TWO stores, one behavior. The JOURNAL is always written and powers Undo and the History view: an append-only
 * `log.jsonl`, content-addressed `objects/<sha256>` blobs and a `state.json` of what was last seen on disk. It lives in
 * BotBoy's private state, outside the visible folder, so an update, a sync client or a Time Machine run never meets it.
 * Git (`knowledge-git.ts`) is a best-effort browsable mirror of the same entries; missing, stand-in or failing git leaves
 * the journal alone, and Undo is identical either way.
 *
 * Edits made outside BotBoy (Finder, an editor, a shell command) are found by `reconcile()` (a content hash against the
 * last state, taken only when a file's size or mtime moved) and recorded as "edited outside BotBoy", so Undo and the log
 * stay true. Files the server's own writers produce (lesson projections, the analytics manifest, generated presets) are
 * recorded as `generated`. An intent record written before a change and resolved by the next `reconcile` makes a crash
 * between the file write and the log line harmless. A `reconcile` never judges the folder while a write of THIS process is
 * between `begin` and `record` (the files are BotBoy's own, mid-change), and a walk that overlapped one is thrown away, so no
 * caller needs the writer's lock to avoid recording BotBoy's own write as an outside edit.
 *
 * Blobs of secrets are never copied into the store (an outside edit that added a credential is logged by path and kind).
 */
import fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { diffLines, renderUnifiedDiff, type UnifiedDiff } from './knowledge-diff.js';
import { isInside, newId, readIfExists, realParentInside, sha256Hex, writeFileAtomic } from './knowledge-fs.js';
import type { GitMirror, GitMirrorStatus } from './knowledge-git.js';
import { describeSecretKinds, detectSecrets } from './sensitive-files.js';

export type HistoryActor = 'botboy' | 'owner-via-botboy' | 'outside' | 'generated';
export type HistoryKind = 'write' | 'create_set' | 'undo' | 'outside' | 'baseline' | 'migration';

export interface HistoryFile {
  /** Root-relative POSIX path. */
  path: string;
  /** SHA-256 of the content before; null when the file did not exist. */
  before: string | null;
  /** SHA-256 of the content after; null when the file no longer exists. */
  after: string | null;
  /** Kinds of secret formats found in an outside edit; its content was not copied into the store. */
  secret?: string;
}

export interface CheckNote { tier: 'should_fix' | 'note'; rule?: string; problem: string; fix?: string }

export interface HistoryEntry {
  id: string;
  at: string;
  actor: HistoryActor;
  kind: HistoryKind;
  files: HistoryFile[];
  summary: string;
  changeId?: string;
  checkNotes?: CheckNote[];
  /** The guide-check items an "Apply anyway" overrode. */
  overrode?: string[];
  /** Where an untrusted-derived change came from ("email, web page"), when it did. */
  sources?: string[];
  /** For `undo`: the entry it reverted. */
  undoes?: string;
}

export interface HistoryRecordInput {
  actor: HistoryActor;
  kind: HistoryKind;
  summary: string;
  files: Array<{ path: string; before: Buffer | null; after: Buffer | null }>;
  changeId?: string;
  checkNotes?: CheckNote[];
  overrode?: string[];
  sources?: string[];
  undoes?: string;
}

interface TrackedFile { size: number; mtimeMs: number; sha256: string }
interface HistoryState { version: 1; files: Record<string, TrackedFile>; started: boolean }
interface Intent { id: string; at: string; actor: HistoryActor; kind: HistoryKind; summary: string; files: HistoryFile[]; changeId?: string }

export const HISTORY_KEEP_ENTRIES = 200;
export const HISTORY_KEEP_BYTES = 100 * 1024 * 1024;
const RECONCILE_DEBOUNCE_MS = 3_000;
const MAX_WALK_FILES = 8_000;
const MAX_WALK_DEPTH = 6;
const MAX_TRACKED_BYTES = 4 * 1024 * 1024;
const TRACKED_EXTENSIONS = new Set(['.md', '.txt', '.yaml', '.yml', '.json', '.sql']);
const MAX_LIST = 500;

export interface UndoSuccess { ok: true; entry: HistoryEntry; undone: HistoryEntry }
export interface UndoFailure {
  ok: false;
  code: 'nothing_to_undo' | 'changed_since' | 'blob_missing' | 'io_error' | 'root_unavailable';
  message: string;
  nextAction: string;
  paths?: string[];
}
export type UndoResult = UndoSuccess | UndoFailure;

export interface HistoryDiffFile {
  path: string;
  kind: 'created' | 'removed' | 'changed' | 'moved';
  diff: UnifiedDiff | null;
  note?: string;
}

export interface KnowledgeHistoryOptions {
  /** `~/.personal-productivity-tracker/knowledge-history`. */
  dir: string;
  /** The canonical library root, or null while there is none. */
  root: () => string | null;
  git?: GitMirror | null;
  /** `generated` for the files the server's own writers produce. */
  classify?: (relativePath: string) => 'generated' | 'outside';
  now?: () => number;
}

export interface KnowledgeHistory {
  readonly dir: string;
  record(input: HistoryRecordInput): Promise<HistoryEntry>;
  /** Write the intent record before a change touches the folder; resolved by `finish` or by the next `reconcile`. */
  begin(intent: { actor: HistoryActor; kind: HistoryKind; summary: string; changeId?: string; files: Array<{ path: string; before: Buffer | null; after: Buffer | null }> }): Promise<void>;
  reconcile(options?: { force?: boolean }): Promise<HistoryEntry[]>;
  /**
   * A write that began and will not be recorded (the files were rolled back, or could not be): the process is no longer
   * mid-change. `restored: true` also drops the intent record (nothing is left to resolve); false leaves it for the next
   * `reconcile`, which records whatever the folder holds as it finds it.
   */
  abandon(options: { restored: boolean }): Promise<void>;
  list(options?: { limit?: number; offset?: number }): HistoryEntry[];
  get(id: string): HistoryEntry | null;
  diff(id: string, options?: { maxLines?: number }): Promise<HistoryDiffFile[] | null>;
  latestUndoable(): HistoryEntry | null;
  undo(): Promise<UndoResult>;
  gitStatus(): GitMirrorStatus | null;
  /** The blob for a hash, or null when it was pruned or never stored. */
  blob(sha: string): Promise<Buffer | null>;
}

const isTrackedName = (name: string) => !name.startsWith('.') && TRACKED_EXTENSIONS.has(path.extname(name).toLowerCase());
const toPosix = (value: string) => value.split(path.sep).join('/');

export function defaultHistoryDir(home: string = os.homedir()): string {
  return path.join(home, '.personal-productivity-tracker', 'knowledge-history');
}

export function createKnowledgeHistory(options: KnowledgeHistoryOptions): KnowledgeHistory {
  const { dir } = options;
  const now = options.now ?? (() => Date.now());
  const classify = options.classify ?? (() => 'outside' as const);
  const logFile = path.join(dir, 'log.jsonl');
  const objectsDir = path.join(dir, 'objects');
  const stateFile = path.join(dir, 'state.json');
  const intentFile = path.join(dir, 'intent.json');
  let lastReconcile = 0;
  let logCache: { size: number; mtimeMs: number; entries: HistoryEntry[] } | null = null;
  let stateCache: HistoryState | null = null;
  // A write of THIS process is between begin() and record()/abandon(). `epoch` moves whenever a write begins or ends, so a
  // reconcile that overlapped one throws its walk away instead of recording BotBoy's own files as an outside edit.
  let writing = false;
  let epoch = 0;
  const startWrite = () => { writing = true; epoch += 1; };
  const endWrite = () => { writing = false; epoch += 1; };

  // ── storage ──

  function readState(): HistoryState {
    if (stateCache) return stateCache;
    try {
      const parsed = JSON.parse(fs.readFileSync(stateFile, 'utf8')) as Partial<HistoryState>;
      stateCache = { version: 1, files: parsed.files && typeof parsed.files === 'object' ? parsed.files : {}, started: Boolean(parsed.started) };
    } catch {
      stateCache = { version: 1, files: {}, started: false };
    }
    return stateCache;
  }

  async function writeState(state: HistoryState): Promise<void> {
    stateCache = state;
    await writeFileAtomic(stateFile, JSON.stringify(state), { ensureDir: true });
  }

  function readLog(): HistoryEntry[] {
    let stat: fs.Stats;
    try { stat = fs.statSync(logFile); } catch { return []; }
    if (logCache && logCache.size === stat.size && logCache.mtimeMs === stat.mtimeMs) return logCache.entries;
    const entries: HistoryEntry[] = [];
    for (const line of fs.readFileSync(logFile, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { entries.push(JSON.parse(line) as HistoryEntry); } catch { /* a torn last line is skipped */ }
    }
    logCache = { size: stat.size, mtimeMs: stat.mtimeMs, entries };
    return entries;
  }

  async function appendLog(entry: HistoryEntry): Promise<void> {
    await fsp.mkdir(dir, { recursive: true });
    await fsp.appendFile(logFile, `${JSON.stringify(entry)}\n`);
    logCache = null;
  }

  async function storeBlob(content: Buffer | null): Promise<{ sha: string | null; secret?: string }> {
    if (content === null) return { sha: null };
    const sha = sha256Hex(content);
    const secrets = detectSecrets(content.toString('utf8'));
    if (secrets.length > 0) return { sha, secret: describeSecretKinds(secrets).replace(/^Contains what looks like /, '') };
    await fsp.mkdir(objectsDir, { recursive: true });
    const target = path.join(objectsDir, sha);
    try { await fsp.access(target); } catch { await writeFileAtomic(target, content, { mode: 0o600 }); }
    return { sha };
  }

  async function blob(sha: string): Promise<Buffer | null> {
    if (!/^[a-f0-9]{64}$/.test(sha)) return null;
    return readIfExists(path.join(objectsDir, sha));
  }

  const iso = () => new Date(now()).toISOString();

  // ── recording ──

  async function trackPaths(root: string, files: Array<{ path: string; after: Buffer | null }>): Promise<void> {
    const state = readState();
    for (const file of files) {
      if (file.after === null) { delete state.files[file.path]; continue; }
      try {
        const stat = await fsp.stat(path.join(root, ...file.path.split('/')));
        state.files[file.path] = { size: stat.size, mtimeMs: Math.round(stat.mtimeMs), sha256: sha256Hex(file.after) };
      } catch {
        state.files[file.path] = { size: file.after.length, mtimeMs: 0, sha256: sha256Hex(file.after) };
      }
    }
    state.started = true;
    await writeState(state);
  }

  async function record(input: HistoryRecordInput): Promise<HistoryEntry> {
    const files: HistoryFile[] = [];
    let entry: HistoryEntry;
    let root: string | null;
    try {
      for (const file of input.files) {
        const before = await storeBlob(file.before);
        const after = await storeBlob(file.after);
        files.push({ path: file.path, before: before.sha, after: after.sha, ...(after.secret || before.secret ? { secret: after.secret ?? before.secret } : {}) });
      }
      entry = {
        id: newId('h'), at: iso(), actor: input.actor, kind: input.kind, files, summary: input.summary.slice(0, 600),
        ...(input.changeId ? { changeId: input.changeId } : {}),
        ...(input.checkNotes?.length ? { checkNotes: input.checkNotes.slice(0, 12) } : {}),
        ...(input.overrode?.length ? { overrode: input.overrode.slice(0, 12) } : {}),
        ...(input.sources?.length ? { sources: input.sources.slice(0, 8) } : {}),
        ...(input.undoes ? { undoes: input.undoes } : {}),
      };
      await appendLog(entry);
      root = options.root();
      if (root) await trackPaths(root, input.files);
      await clearIntent();
    } finally {
      // The journal, the state and the intent are consistent (or the next reconcile resolves the intent): the write is over.
      endWrite();
    }
    await prune();
    // The mirror is best effort: its failure never fails a change.
    if (options.git && root) {
      await options.git.record({ paths: files.map((file) => file.path), message: `${entry.kind}: ${entry.summary}`.slice(0, 200) }).catch(() => undefined);
    }
    return entry;
  }

  async function begin(intent: { actor: HistoryActor; kind: HistoryKind; summary: string; changeId?: string; files: Array<{ path: string; before: Buffer | null; after: Buffer | null }> }): Promise<void> {
    const files: HistoryFile[] = intent.files.map((file) => ({ path: file.path, before: file.before ? sha256Hex(file.before) : null, after: file.after ? sha256Hex(file.after) : null }));
    const record: Intent = { id: newId('h'), at: iso(), actor: intent.actor, kind: intent.kind, summary: intent.summary.slice(0, 600), files, ...(intent.changeId ? { changeId: intent.changeId } : {}) };
    startWrite();
    try {
      await writeFileAtomic(intentFile, JSON.stringify(record), { ensureDir: true });
    } catch (error) {
      endWrite();
      throw error;
    }
  }

  async function abandon(abandonOptions: { restored: boolean }): Promise<void> {
    try {
      if (abandonOptions.restored) await clearIntent();
    } finally {
      endWrite();
    }
  }

  async function clearIntent(): Promise<void> {
    await fsp.unlink(intentFile).catch(() => undefined);
  }

  // ── pruning ──

  async function prune(): Promise<void> {
    try {
      const entries = readLog();
      const keep = new Set<string>();
      for (const entry of entries.slice(-HISTORY_KEEP_ENTRIES)) for (const file of entry.files) { if (file.before) keep.add(file.before); if (file.after) keep.add(file.after); }
      let names: string[];
      try { names = await fsp.readdir(objectsDir); } catch { return; }
      const stats: Array<{ name: string; size: number; mtimeMs: number }> = [];
      for (const name of names) {
        if (!/^[a-f0-9]{64}$/.test(name)) continue;
        try { const stat = await fsp.stat(path.join(objectsDir, name)); stats.push({ name, size: stat.size, mtimeMs: stat.mtimeMs }); } catch { /* gone */ }
      }
      for (const item of stats) if (!keep.has(item.name)) await fsp.unlink(path.join(objectsDir, item.name)).catch(() => undefined);
      let total = stats.filter((item) => keep.has(item.name)).reduce((sum, item) => sum + item.size, 0);
      if (total > HISTORY_KEEP_BYTES) {
        // Oldest kept blobs go first, but never the blobs of the latest entry (Undo needs them).
        const latest = new Set<string>();
        const last = entries[entries.length - 1];
        for (const file of last?.files ?? []) { if (file.before) latest.add(file.before); if (file.after) latest.add(file.after); }
        for (const item of stats.filter((entry) => keep.has(entry.name) && !latest.has(entry.name)).sort((a, b) => a.mtimeMs - b.mtimeMs)) {
          if (total <= HISTORY_KEEP_BYTES) break;
          await fsp.unlink(path.join(objectsDir, item.name)).catch(() => undefined);
          total -= item.size;
        }
      }
    } catch { /* pruning is housekeeping; it never fails a change */ }
  }

  // ── reconcile ──

  interface Seen { size: number; mtimeMs: number }

  async function walkTracked(root: string): Promise<Map<string, Seen>> {
    const found = new Map<string, Seen>();
    const walk = async (current: string, relative: string, depth: number): Promise<void> => {
      if (found.size >= MAX_WALK_FILES || depth > MAX_WALK_DEPTH) return;
      let entries: fs.Dirent[];
      try { entries = await fsp.readdir(current, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
        const rel = relative ? `${relative}/${entry.name}` : entry.name;
        if (entry.isDirectory()) { await walk(path.join(current, entry.name), rel, depth + 1); continue; }
        if (!entry.isFile() || !isTrackedName(entry.name)) continue;
        try {
          const stat = await fsp.stat(path.join(current, entry.name));
          if (stat.size <= MAX_TRACKED_BYTES) found.set(rel, { size: stat.size, mtimeMs: Math.round(stat.mtimeMs) });
        } catch { /* vanished */ }
      }
    };
    await walk(root, '', 0);
    return found;
  }

  async function resolveIntent(root: string, epochAtStart: number): Promise<HistoryEntry | null> {
    let intent: Intent | null = null;
    try { intent = JSON.parse(await fsp.readFile(intentFile, 'utf8')) as Intent; } catch { return null; }
    // The intent of a write of THIS process is not a leftover: leave it (and the files it is changing) alone.
    if (writing || epoch !== epochAtStart) return null;
    if (!intent || !Array.isArray(intent.files)) { await clearIntent(); return null; }
    const current = async (file: HistoryFile) => {
      const bytes = await readIfExists(path.join(root, ...file.path.split('/'))).catch(() => null);
      return bytes ? sha256Hex(bytes) : null;
    };
    let allAfter = true;
    let allBefore = true;
    for (const file of intent.files) {
      const sha = await current(file);
      if (sha !== file.after) allAfter = false;
      if (sha !== file.before) allBefore = false;
    }
    if (writing || epoch !== epochAtStart) return null;
    await clearIntent();
    if (allBefore && !allAfter) return null;
    if (allAfter) {
      // The change reached the folder but the process ended before its log line: finish the entry as BotBoy's.
      const entry: HistoryEntry = { id: intent.id, at: intent.at, actor: intent.actor, kind: intent.kind, files: intent.files, summary: `${intent.summary} (recovered after an interrupted write)`, ...(intent.changeId ? { changeId: intent.changeId } : {}) };
      if (!readLog().some((existing) => existing.id === entry.id)) {
        await appendLog(entry);
        const state = readState();
        for (const file of entry.files) {
          if (file.after === null) delete state.files[file.path];
          else {
            const stat = await fsp.stat(path.join(root, ...file.path.split('/'))).catch(() => null);
            state.files[file.path] = { size: stat?.size ?? 0, mtimeMs: Math.round(stat?.mtimeMs ?? 0), sha256: file.after };
          }
        }
        await writeState(state);
        return entry;
      }
    }
    return null;
  }

  async function reconcile(reconcileOptions: { force?: boolean } = {}): Promise<HistoryEntry[]> {
    const root = options.root();
    if (!root) return [];
    if (writing) return [];
    if (!reconcileOptions.force && now() - lastReconcile < RECONCILE_DEBOUNCE_MS) return [];
    const epochAtStart = epoch;
    lastReconcile = now();
    const recorded: HistoryEntry[] = [];
    try {
      await fsp.stat(root);
    } catch {
      return [];
    }
    const recovered = await resolveIntent(root, epochAtStart);
    if (recovered) recorded.push(recovered);
    const state = readState();
    const seen = await walkTracked(root);
    // A write began or ended while the folder was being read: this view mixes its files with the old ones. The next reconcile
    // sees a settled folder (and the write's own record), so nothing is lost by waiting.
    if (writing || epoch !== epochAtStart) return recorded;
    if (!state.started && !fs.existsSync(logFile)) {
      // First sight: everything present now is the starting point.
      for (const [rel, info] of seen) {
        const bytes = await readIfExists(path.join(root, ...rel.split('/'))).catch(() => null);
        if (bytes) state.files[rel] = { size: info.size, mtimeMs: info.mtimeMs, sha256: sha256Hex(bytes) };
      }
      state.started = true;
      await writeState(state);
      if (seen.size > 0) {
        const entry: HistoryEntry = { id: newId('h'), at: iso(), actor: 'outside', kind: 'baseline', files: [], summary: `${seen.size} file${seen.size === 1 ? ' was' : 's were'} in the folder when history started` };
        await appendLog(entry);
        recorded.push(entry);
      }
      return recorded;
    }
    const changes: Array<{ path: string; before: Buffer | null; beforeSha: string | null; after: Buffer | null }> = [];
    for (const [rel, info] of seen) {
      const known = state.files[rel];
      if (known && known.size === info.size && known.mtimeMs === info.mtimeMs) continue;
      const bytes = await readIfExists(path.join(root, ...rel.split('/'))).catch(() => null);
      if (!bytes) continue;
      const sha = sha256Hex(bytes);
      if (known && known.sha256 === sha) { state.files[rel] = { size: info.size, mtimeMs: info.mtimeMs, sha256: sha }; continue; }
      const previous = known ? await blob(known.sha256) : null;
      changes.push({ path: rel, before: previous, beforeSha: known?.sha256 ?? null, after: bytes });
    }
    for (const rel of Object.keys(state.files)) {
      if (seen.has(rel)) continue;
      // Absent from the walk: removed or moved away. A file that still exists but is no longer tracked (a deeper path) is left alone.
      if (fs.existsSync(path.join(root, ...rel.split('/')))) continue;
      const previous = await blob(state.files[rel].sha256);
      changes.push({ path: rel, before: previous, beforeSha: state.files[rel].sha256, after: null });
    }
    if (writing || epoch !== epochAtStart) return recorded;
    if (changes.length > 0) {
      const byActor = new Map<'generated' | 'outside', typeof changes>();
      for (const change of changes) {
        const actor = classify(change.path);
        byActor.set(actor, [...(byActor.get(actor) ?? []), change]);
      }
      for (const [actor, group] of byActor) {
        const files: HistoryFile[] = [];
        for (const change of group) {
          const after = await storeBlob(change.after);
          if (change.before) await storeBlob(change.before);
          files.push({ path: change.path, before: change.beforeSha, after: after.sha, ...(after.secret ? { secret: after.secret } : {}) });
          if (change.after === null) delete state.files[change.path];
          else {
            const info = seen.get(change.path);
            state.files[change.path] = { size: info?.size ?? change.after.length, mtimeMs: info?.mtimeMs ?? 0, sha256: sha256Hex(change.after) };
          }
        }
        const names = files.slice(0, 3).map((file) => file.path).join(', ');
        const entry: HistoryEntry = {
          id: newId('h'), at: iso(), actor, kind: 'outside', files,
          summary: actor === 'generated'
            ? `Generated by BotBoy: ${names}${files.length > 3 ? ` and ${files.length - 3} more` : ''}`
            : `Edited outside BotBoy: ${names}${files.length > 3 ? ` and ${files.length - 3} more` : ''}`,
        };
        await appendLog(entry);
        recorded.push(entry);
        if (options.git) await options.git.record({ paths: files.map((file) => file.path), message: `${actor === 'generated' ? 'generated' : 'outside'}: ${entry.summary}`.slice(0, 200) }).catch(() => undefined);
      }
    }
    await writeState(state);
    if (recorded.length > 0) await prune();
    return recorded;
  }

  // ── reading ──

  function list(listOptions: { limit?: number; offset?: number } = {}): HistoryEntry[] {
    const limit = Math.max(1, Math.min(MAX_LIST, listOptions.limit ?? 50));
    const offset = Math.max(0, listOptions.offset ?? 0);
    const entries = readLog();
    return entries.slice().reverse().slice(offset, offset + limit);
  }

  function get(id: string): HistoryEntry | null {
    return readLog().find((entry) => entry.id === id) ?? null;
  }

  async function diff(id: string, diffOptions: { maxLines?: number } = {}): Promise<HistoryDiffFile[] | null> {
    const entry = get(id);
    if (!entry) return null;
    const out: HistoryDiffFile[] = [];
    for (const file of entry.files.slice(0, 20)) {
      const before = file.before ? await blob(file.before) : null;
      const after = file.after ? await blob(file.after) : null;
      const kind: HistoryDiffFile['kind'] = file.before === null ? 'created' : file.after === null ? 'removed' : 'changed';
      if (file.secret) { out.push({ path: file.path, kind, diff: null, note: `Content not shown or copied: it contains ${file.secret}.` }); continue; }
      if ((file.before && !before) || (file.after && !after)) { out.push({ path: file.path, kind, diff: null, note: 'The older copy was pruned; only the log line is kept.' }); continue; }
      out.push({ path: file.path, kind, diff: renderUnifiedDiff(diffLines(before?.toString('utf8') ?? '', after?.toString('utf8') ?? ''), { label: file.path, maxLines: diffOptions.maxLines ?? 200 }) });
    }
    return out;
  }

  function latestUndoable(): HistoryEntry | null {
    const entries = readLog();
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index];
      if ((entry.kind === 'write' || entry.kind === 'create_set' || entry.kind === 'undo') && entry.files.length > 0) return entry;
    }
    return null;
  }

  // ── undo ──

  async function undo(): Promise<UndoResult> {
    const root = options.root();
    if (!root) return { ok: false, code: 'root_unavailable', message: 'There is no Knowledge folder to undo in.', nextAction: 'Open Settings → Knowledge.' };
    await reconcile({ force: true });
    const target = latestUndoable();
    if (!target) return { ok: false, code: 'nothing_to_undo', message: 'There is nothing BotBoy changed that can be undone.', nextAction: 'Nothing to do.' };
    // Every touched path must still be what that change left, or Undo would erase a later edit.
    const moved: string[] = [];
    const plan: Array<{ path: string; absolute: string; current: Buffer | null; restore: Buffer | null }> = [];
    for (const file of target.files) {
      const absolute = path.join(root, ...file.path.split('/'));
      if (!isInside(root, absolute)) return { ok: false, code: 'io_error', message: 'A recorded path leaves the Knowledge folder, so the entry cannot be undone.', nextAction: 'Restore the file by hand.', paths: [file.path] };
      // A folder swapped for a link since the change would carry the restore (or the removal) outside the library.
      if (!(await realParentInside(root, absolute))) return { ok: false, code: 'io_error', message: `${file.path} now lies behind a link that leaves the Knowledge folder, so the entry cannot be undone.`, nextAction: 'Restore the file by hand.', paths: [file.path] };
      const current = await readIfExists(absolute).catch(() => null);
      if ((current ? sha256Hex(current) : null) !== file.after) moved.push(file.path);
      if (file.before === null) { plan.push({ path: file.path, absolute, current, restore: null }); continue; }
      const old = await blob(file.before);
      if (!old) return { ok: false, code: 'blob_missing', message: 'The older copy needed for Undo was pruned from the history store.', nextAction: 'Restore the file by hand or from a backup.', paths: [file.path] };
      plan.push({ path: file.path, absolute, current, restore: old });
    }
    if (moved.length > 0) {
      return { ok: false, code: 'changed_since', message: `${moved.slice(0, 3).join(', ')} changed after BotBoy's last change, so Undo would erase that edit.`, nextAction: 'Open Settings → Knowledge → History to see what changed, then restore by hand if you want.', paths: moved };
    }
    const summary = `Undid: ${target.summary}`.slice(0, 300);
    try {
      await begin({ actor: 'owner-via-botboy', kind: 'undo', summary, files: plan.map((item) => ({ path: item.path, before: item.current, after: item.restore })) });
      for (const item of plan) {
        if (item.restore === null) {
          await fsp.unlink(item.absolute).catch((error: NodeJS.ErrnoException) => { if (error?.code !== 'ENOENT') throw error; });
        } else {
          await writeFileAtomic(item.absolute, item.restore, { ensureDir: true });
        }
      }
    } catch (error) {
      await clearIntent();
      endWrite();
      return { ok: false, code: 'io_error', message: `Undo could not finish: ${String((error as Error)?.message ?? error).slice(0, 160)}`, nextAction: 'Check Settings → Knowledge → History, then try again.' };
    }
    // The entry keeps what the change had left as `before`, so an Undo of this entry (a redo) can verify and restore it.
    let entry: HistoryEntry;
    try {
      entry = await record({ actor: 'owner-via-botboy', kind: 'undo', summary, undoes: target.id, files: plan.map((item) => ({ path: item.path, before: item.current, after: item.restore })) });
    } catch (error) {
      // The files are restored; only the log line is missing. The intent record stays, so the next reconcile finishes the entry.
      return { ok: false, code: 'io_error', message: `Undo restored the files, but History could not record it (${String((error as Error)?.message ?? error).slice(0, 160)}).`, nextAction: 'Free some space on this Mac; History picks the change up at the next check.' };
    }
    return { ok: true, entry, undone: target };
  }

  return {
    dir, record, begin, abandon, reconcile, list, get, diff, latestUndoable, undo, blob,
    gitStatus: () => options.git?.status() ?? null,
  };
}
