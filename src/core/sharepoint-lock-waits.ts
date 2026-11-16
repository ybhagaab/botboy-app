/**
 * Waiting for a SharePoint file to be closed (docs/maps/document-workbench.md › Lock waits).
 *
 * SharePoint refuses a whole-file upload while anyone has the file open in Word or a browser, and for up to about 10 minutes
 * after the last person closes it ("File is locked"). Only Word itself can merge co-authors' edits, so BotBoy waits: an
 * approved write (a publication, or approved reader edits) is tried again until the file is free. Owner report 2026-11-16:
 * the wait lived in memory for 2 hours, the publication card said only "Publication phase recorded", and when the wait ran
 * out (or BotBoy restarted) the card had no button left.
 *
 * One row per document while BotBoy waits; the row goes when the wait ends (the write landed, the owner stopped it, it ran
 * out, or another failure ended it). The schedule: every 4 minutes for the first hour, then every 15 minutes, up to 24 hours
 * from the first refusal (owner decision 2026-11-16). A refused write changes nothing in SharePoint.
 */
import type Database from 'better-sqlite3';

export const LOCK_WAIT_FAST_MS = 4 * 60_000;
export const LOCK_WAIT_SLOW_MS = 15 * 60_000;
export const LOCK_WAIT_FAST_FOR_MS = 60 * 60_000;
export const LOCK_WAIT_LIMIT_MS = 24 * 60 * 60_000;

/**
 * The publication error that says SharePoint (or Drive) did not take the write: nothing changed remotely, so it is safe to
 * try again. Drive's not-written outcome uses the same words (documents.ts › runDriveCreate).
 */
export const NOT_WRITTEN_PREFIX = 'Not written: ';

export function isNotWrittenError(error: string | null | undefined): boolean {
  return typeof error === 'string' && error.startsWith(NOT_WRITTEN_PREFIX);
}

export function isFileLockedError(text: string | null | undefined): boolean {
  return /file is locked/i.test(String(text ?? ''));
}

export interface LockWait {
  docKey: string;
  /** The first refused write. */
  startedAt: string;
  /** Writes SharePoint refused so far (the first one included). */
  tries: number;
  lastTryAt: string;
  nextTryAt: string;
  /** When BotBoy stops trying (24 hours after the first refusal). */
  endsAt: string;
}

export interface LockWaitSchedule {
  fastMs: number;
  slowMs: number;
  fastForMs: number;
  limitMs: number;
}

export const DEFAULT_LOCK_WAIT_SCHEDULE: LockWaitSchedule = {
  fastMs: LOCK_WAIT_FAST_MS,
  slowMs: LOCK_WAIT_SLOW_MS,
  fastForMs: LOCK_WAIT_FAST_FOR_MS,
  limitMs: LOCK_WAIT_LIMIT_MS,
};

/** The schedule, with the test overrides (`PPT_LOCK_RETRY_INTERVAL_MS` for every step, `PPT_LOCK_WAIT_LIMIT_MS`); read per call. */
export function lockWaitSchedule(env: NodeJS.ProcessEnv = process.env): LockWaitSchedule {
  const positive = (name: string): number | null => {
    const value = parseInt(env[name] || '', 10);
    return Number.isFinite(value) && value > 0 ? value : null;
  };
  const step = positive('PPT_LOCK_RETRY_INTERVAL_MS');
  return {
    fastMs: step ?? LOCK_WAIT_FAST_MS,
    slowMs: step ?? LOCK_WAIT_SLOW_MS,
    fastForMs: LOCK_WAIT_FAST_FOR_MS,
    limitMs: positive('PPT_LOCK_WAIT_LIMIT_MS') ?? LOCK_WAIT_LIMIT_MS,
  };
}

/** When to try next after a refusal at `nowMs`, or null when the wait has run its course. */
export function nextLockTryAt(startedAtMs: number, nowMs: number, schedule: LockWaitSchedule = DEFAULT_LOCK_WAIT_SCHEDULE): number | null {
  const endsAt = startedAtMs + schedule.limitMs;
  if (nowMs >= endsAt) return null;
  const step = nowMs - startedAtMs < schedule.fastForMs ? schedule.fastMs : schedule.slowMs;
  return Math.min(nowMs + step, endsAt);
}

export interface LockWaitStore {
  get(docKey: string): LockWait | null;
  open(): LockWait[];
  /**
   * SharePoint refused a write at `nowMs`: starts the wait, or counts the try on the open one. Null when the wait has run its
   * course (the caller ends it).
   */
  noteRefused(docKey: string, nowMs: number): LockWait | null;
  /** Ends the wait; returns what it was (null when there was none). */
  end(docKey: string): LockWait | null;
}

interface Row { doc_key: string; started_at: string; tries: number; last_try_at: string; next_try_at: string }

const stores = new WeakMap<Database.Database, LockWaitStore>();

/** One store per database (the documents and product-documents routers share it). */
export function getLockWaitStore(db: Database.Database, schedule: () => LockWaitSchedule = () => lockWaitSchedule()): LockWaitStore {
  const existing = stores.get(db);
  if (existing) return existing;
  const store = createLockWaitStore(db, schedule);
  stores.set(db, store);
  return store;
}

export function createLockWaitStore(db: Database.Database, schedule: () => LockWaitSchedule = () => lockWaitSchedule()): LockWaitStore {
  db.exec(`CREATE TABLE IF NOT EXISTS sharepoint_lock_waits (
    doc_key TEXT PRIMARY KEY,
    started_at TEXT NOT NULL,
    tries INTEGER NOT NULL,
    last_try_at TEXT NOT NULL,
    next_try_at TEXT NOT NULL
  )`);
  const toWait = (row: Row): LockWait => ({
    docKey: row.doc_key,
    startedAt: row.started_at,
    tries: Number(row.tries),
    lastTryAt: row.last_try_at,
    nextTryAt: row.next_try_at,
    endsAt: new Date(Date.parse(row.started_at) + schedule().limitMs).toISOString(),
  });
  const select = db.prepare('SELECT * FROM sharepoint_lock_waits WHERE doc_key = ?');
  const get = (docKey: string): LockWait | null => {
    const row = select.get(docKey) as Row | undefined;
    return row ? toWait(row) : null;
  };
  return {
    get,
    open() {
      return (db.prepare('SELECT * FROM sharepoint_lock_waits ORDER BY next_try_at').all() as Row[]).map(toWait);
    },
    noteRefused(docKey, nowMs) {
      return db.transaction(() => {
        const current = get(docKey);
        const startedMs = current ? Date.parse(current.startedAt) : nowMs;
        const next = nextLockTryAt(startedMs, nowMs, schedule());
        if (next === null) return null;
        const nowIso = new Date(nowMs).toISOString();
        const nextIso = new Date(next).toISOString();
        if (current) {
          db.prepare('UPDATE sharepoint_lock_waits SET tries = tries + 1, last_try_at = ?, next_try_at = ? WHERE doc_key = ?').run(nowIso, nextIso, docKey);
        } else {
          db.prepare('INSERT INTO sharepoint_lock_waits (doc_key, started_at, tries, last_try_at, next_try_at) VALUES (?, ?, 1, ?, ?)').run(docKey, nowIso, nowIso, nextIso);
        }
        return get(docKey);
      })();
    },
    end(docKey) {
      return db.transaction(() => {
        const current = get(docKey);
        if (current) db.prepare('DELETE FROM sharepoint_lock_waits WHERE doc_key = ?').run(docKey);
        return current;
      })();
    },
  };
}

/** What one write of a document's approved changes did (documents.ts › runDocumentSync). */
export type DocumentSyncOutcome =
  | { status: 'done'; uploaded: boolean; alreadyCurrent?: boolean; verifiedOnReadBack: boolean; results: Array<{ id: string; applied: boolean; reason?: string }> }
  | { status: 'locked' }
  | { status: 'nothing-approved' }
  | { status: 'failed'; error: string };

/** How a wait ended. `byOwner`: his own Sync or Stop ended it (he sees the answer there, so no chat notice). */
export type LockWaitEnd =
  | { kind: 'landed'; byOwner: boolean }
  | { kind: 'not_applied'; reason: string; byOwner: boolean }
  | { kind: 'gave_up'; byOwner: boolean }
  | { kind: 'failed'; error: string; effectUnknown: boolean; byOwner: boolean }
  | { kind: 'stopped'; byOwner: true }
  | { kind: 'cleared'; byOwner: boolean };

export interface LockWaitRunner {
  /** The owner's Sync: one write, never beside another for the same document; a refusal starts or counts the wait. */
  syncNow(docKey: string): Promise<{ outcome: DocumentSyncOutcome | { status: 'busy' }; wait: LockWait | null }>;
  /** The owner stops waiting. A try running right now still finishes; its refusal then ends as stopped. */
  stop(docKey: string): LockWait | null;
  /** At boot: every open wait tries again (not before `resumeDelayMs`, so the connections are up). */
  resume(): void;
  isBusy(docKey: string): boolean;
  dispose(): void;
}

export function createLockWaitRunner(options: {
  store: LockWaitStore;
  sync: (docKey: string) => Promise<DocumentSyncOutcome>;
  onEnd: (docKey: string, wait: LockWait, end: LockWaitEnd) => void;
  isShuttingDown?: () => boolean;
  now?: () => number;
  resumeDelayMs?: number;
  log?: (line: string) => void;
}): LockWaitRunner {
  const { store } = options;
  const now = options.now ?? Date.now;
  const log = options.log ?? ((line: string) => console.log(line));
  const shuttingDown = () => options.isShuttingDown?.() === true;
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const inFlight = new Set<string>();
  /** Waits the owner stopped while a try ran: that try's refusal ends as stopped. */
  const stoppedDuringTry = new Map<string, LockWait>();

  const clear = (docKey: string) => {
    const timer = timers.get(docKey);
    if (timer) clearTimeout(timer);
    timers.delete(docKey);
  };
  const arm = (docKey: string, atMs: number) => {
    clear(docKey);
    const timer = setTimeout(() => { void tick(docKey); }, Math.max(0, atMs - now()));
    (timer as { unref?: () => void }).unref?.();
    timers.set(docKey, timer);
  };
  const end = (docKey: string, wait: LockWait, ended: LockWaitEnd) => {
    clear(docKey);
    try { options.onEnd(docKey, wait, ended); } catch (error: any) { log(`[Documents] lock wait end for ${docKey} failed: ${error?.message ?? error}`); }
  };

  /** A write's outcome, for the open wait: count a refusal, or end the wait. */
  function settle(docKey: string, outcome: DocumentSyncOutcome, byOwner: boolean): LockWait | null {
    if (outcome.status === 'locked') {
      const counted = store.noteRefused(docKey, now());
      if (counted) {
        arm(docKey, Date.parse(counted.nextTryAt));
        return counted;
      }
      const last = store.end(docKey);
      if (last) end(docKey, { ...last, tries: last.tries + 1, lastTryAt: new Date(now()).toISOString() }, { kind: 'gave_up', byOwner });
      return null;
    }
    const wait = store.end(docKey);
    if (!wait) return null;
    if (outcome.status === 'done') {
      const applied = outcome.results.some(result => result.applied);
      if (applied && (outcome.uploaded || outcome.alreadyCurrent)) end(docKey, wait, { kind: 'landed', byOwner });
      else end(docKey, wait, { kind: 'not_applied', reason: outcome.results.find(result => !result.applied)?.reason ?? 'the approved change could not be applied', byOwner });
    } else if (outcome.status === 'failed') {
      end(docKey, wait, { kind: 'failed', error: outcome.error, effectUnknown: false, byOwner });
    } else {
      end(docKey, wait, { kind: 'cleared', byOwner });
    }
    return null;
  }

  async function guarded(docKey: string): Promise<DocumentSyncOutcome | { status: 'busy' }> {
    if (inFlight.has(docKey)) return { status: 'busy' };
    inFlight.add(docKey);
    try {
      return await options.sync(docKey);
    } finally {
      inFlight.delete(docKey);
    }
  }

  async function tick(docKey: string): Promise<void> {
    timers.delete(docKey);
    if (shuttingDown()) return; // the wait stays recorded; the next start resumes it
    if (!store.get(docKey)) return;
    let outcome: DocumentSyncOutcome | { status: 'busy' };
    try {
      outcome = await guarded(docKey);
    } catch (error: any) {
      if (shuttingDown()) return;
      // The write may have started: its effect is not known, so nothing is marked as not written.
      const wait = store.end(docKey) ?? stoppedDuringTry.get(docKey) ?? null;
      stoppedDuringTry.delete(docKey);
      if (wait) end(docKey, wait, { kind: 'failed', error: String(error?.message ?? error), effectUnknown: true, byOwner: false });
      return;
    }
    if (outcome.status === 'busy') {
      // The owner's own Sync is running; it settles the wait. Look again shortly in case it did not.
      arm(docKey, now() + 30_000);
      return;
    }
    const stopped = stoppedDuringTry.get(docKey);
    stoppedDuringTry.delete(docKey);
    if (stopped) {
      // Stopped while this try ran: a refusal ends as stopped; a write that landed is reported as landed.
      if (outcome.status === 'locked') end(docKey, stopped, { kind: 'stopped', byOwner: true });
      else if (outcome.status === 'done' && outcome.results.some(result => result.applied)) end(docKey, stopped, { kind: 'landed', byOwner: false });
      return;
    }
    if (outcome.status === 'failed' && shuttingDown()) return;
    const counted = settle(docKey, outcome, false);
    if (counted) log(`[Documents] ${docKey}: still open in Word or a browser (try ${counted.tries}); next try ${counted.nextTryAt}`);
  }

  return {
    async syncNow(docKey) {
      const outcome = await guarded(docKey);
      if (outcome.status === 'busy') return { outcome, wait: store.get(docKey) };
      return { outcome, wait: settle(docKey, outcome, true) };
    },
    stop(docKey) {
      const wait = store.end(docKey);
      if (!wait) return null;
      clear(docKey);
      if (inFlight.has(docKey)) stoppedDuringTry.set(docKey, wait);
      else end(docKey, wait, { kind: 'stopped', byOwner: true });
      return wait;
    },
    resume() {
      const earliest = now() + (options.resumeDelayMs ?? 90_000);
      for (const wait of store.open()) arm(wait.docKey, Math.max(Date.parse(wait.nextTryAt), earliest));
    },
    isBusy(docKey) {
      return inFlight.has(docKey);
    },
    dispose() {
      for (const docKey of [...timers.keys()]) clear(docKey);
    },
  };
}

/** The chat notice for a wait that ended by itself (code-owned words; chat-notices.md). Null: nothing to say. */
export function lockWaitNotice(input: {
  docKey: string;
  fileName: string;
  wait: LockWait;
  end: LockWaitEnd;
  /** A publication of a BotBoy document (its card has the buttons), or approved reader edits. */
  publication: boolean;
  route?: string | null;
  clock: (iso: string) => string;
  nowIso: string;
}): {
  key: string; topic: 'sharepoint-write'; state: 'open' | 'resolved'; severity: 'success' | 'warning'; title: string;
  labels: string[]; next: string; detail: string; action?: { kind: 'open_route'; label: string; route: string };
} | null {
  const { end, wait } = input;
  if (end.byOwner || end.kind === 'cleared') return null;
  const key = `sharepoint-write:${hashKey(input.docKey)}`;
  const labels = [chipLabel(input.fileName)];
  const span = `from ${input.clock(wait.startedAt)}`;
  const action = input.route ? { kind: 'open_route' as const, label: input.publication ? 'Open document' : 'Open file', route: input.route } : undefined;
  const base = { key, topic: 'sharepoint-write' as const, labels, ...(action ? { action } : {}) };
  if (end.kind === 'landed') {
    return {
      ...base, state: 'resolved', severity: 'success',
      title: input.publication ? 'Published to SharePoint' : 'Edits published to SharePoint',
      next: 'The file was closed, so BotBoy wrote the approved version.',
      detail: `${input.fileName}: SharePoint refused ${wait.tries} ${wait.tries === 1 ? 'try' : 'tries'} ${span} while the file was open; the write landed at ${input.clock(input.nowIso)}.`,
    };
  }
  if (end.kind === 'gave_up') {
    return {
      ...base, state: 'open', severity: 'warning', title: 'SharePoint file stayed open',
      next: input.publication
        ? 'Nothing was written. Open the document and press Update when the file is closed.'
        : 'Nothing was written; your approved edits are kept. Press Sync when the file is closed.',
      detail: `${input.fileName}: SharePoint refused all ${wait.tries} tries ${span} to ${input.clock(wait.lastTryAt)}: someone had the file open in Word or a browser.`,
    };
  }
  return {
    ...base, state: 'open', severity: 'warning', title: 'SharePoint write stopped',
    next: end.kind === 'not_applied'
      ? 'The file changed while BotBoy waited. Open it to review the change.'
      : end.effectUnknown
        ? 'BotBoy lost track of the last try, so check the file before trying again.'
        : 'Nothing was written. Open it to see why and try again.',
    detail: `${input.fileName}: ${end.kind === 'not_applied' ? end.reason : end.error}`,
  };
}

/** A notice chip holds 28 characters (chat-notices.ts): the file's name without its extension, cut at a word. */
function chipLabel(fileName: string): string {
  const name = fileName.replace(/\.(docx|md)$/i, '').trim();
  if (name.length <= 28) return name;
  const cut = name.slice(0, 27);
  const space = /\s/.test(name[27] ?? '') ? cut.length : cut.lastIndexOf(' ');
  return `${(space >= 12 ? cut.slice(0, space) : cut).replace(/[\s—–-]+$/, '')}…`;
}

function hashKey(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}
