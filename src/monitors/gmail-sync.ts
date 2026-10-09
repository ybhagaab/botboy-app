/**
 * Gmail background sync — the Gmail API counterpart of grasp-sync.ts for
 * owners without Amazon's GRASP (GMAIL_API_INTEGRATION_PLAN.md).
 *
 * Google's recommended sync model (Gmail API "Synchronize clients"):
 *   - Full sync on first connect: messages.list over the lookback window
 *     (30 days, owner decision G4), then partial sync with history.list from
 *     the stored historyId (2 quota units per call; usually one per run).
 *   - An owner-started import (§12 of the plan) lists an older window once
 *     and works through it after new mail, every minute until done.
 *   - history.list answers 404 once the stored historyId is older than
 *     Gmail keeps history (~1 week): a bounded full sync resumes from the
 *     newest captured message.
 *
 * Exactly-once without double fetches:
 *   - Every new message id joins a persisted backlog (oldest first) in the
 *     same transaction that advances historyId, so a crash after the cursor
 *     moved still has every id it covered.
 *   - A run decides backlog ids under a per-run budget (100 messages.get =
 *     2,000 of the 6,000 units/minute per-user quota, paced). A decided id
 *     leaves the backlog; a failed get stops the run and keeps the id.
 *   - URL dedup (`gmail://mail/<id>`) runs before any get, so a re-listed or
 *     re-decided id is never fetched or emitted twice.
 *
 * Read-only: scope gmail.readonly; the mailbox is never marked read, labeled,
 * moved, or modified.
 */

import type Database from 'better-sqlite3';
import type { RawWorkItem } from '../core/types.js';
import { getSetting, setSetting } from '../core/storage.js';
import { classifyCaptureFailure, type CaptureHealth } from '../core/capture-health.js';
import { DEFAULT_NOISE_SENDERS, cleanNoisePatterns } from '../core/email-capture.js';
import { GoogleApiError, type GmailClient, type GmailMessageRef } from '../core/gmail-api.js';
import {
  GmailAuthError,
  gmailAccountName,
  type GmailAccountConnection,
  type GmailConnection,
  type GmailConnectionStatus,
} from '../core/gmail-connection.js';
import {
  decideGmailMessage,
  gmailItemUrl,
  messageTimestampOf,
  skipByLabels,
  type GmailCaptureAccount,
  type GmailOwner,
  type GmailSkipReason,
} from './gmail-message.js';

const KEYS = {
  enabled: 'gmail_sync.enabled',
  /** The account the cursor and backlog belong to. */
  account: 'gmail_sync.account',
  historyId: 'gmail_sync.history_id',
  backlog: 'gmail_sync.backlog',
  lastMessageAt: 'gmail_sync.last_message_at',
  noiseSenders: 'gmail_sync.noise_senders',
  mailActive: 'gmail_sync.mail_active',
  lastRun: 'gmail_sync.last_run',
  /** Older-mail import progress (GmailImportState). */
  import: 'gmail_sync.import',
  /** The import window's message ids, oldest first; written once per import. */
  importIds: 'gmail_sync.import_ids',
} as const;

/** Settings keys other modules read (browser gate, DOMAIN.md). These are the `default` account's. */
export const GMAIL_SYNC_KEYS = KEYS;

/** Shared by every account: the on/off switch and the noise senders. */
const SHARED_KEYS = new Set<string>([KEYS.enabled, KEYS.noiseSenders]);

/**
 * One account's settings keys. `default` keeps the original `gmail_sync.*`
 * keys; another account uses `gmail_sync.acct.<id>.*` for its cursor,
 * backlog, import, and last run.
 */
export function gmailSyncKeysFor(accountId: string): typeof KEYS {
  if (accountId === 'default') return KEYS;
  const out: Record<string, string> = {};
  for (const [name, key] of Object.entries(KEYS)) {
    out[name] = SHARED_KEYS.has(key) ? key : key.replace(/^gmail_sync\./, `gmail_sync.acct.${accountId}.`);
  }
  return out as unknown as typeof KEYS;
}

/** Full-sync query: everything but drafts, spam, trash, chats, and the bulk categories. */
const FULL_SYNC_EXCLUSIONS = '-in:drafts -in:spam -in:trash -in:chats -category:promotions -category:social';
/** A backlog larger than this is truncated to its newest ids (logged); protects the settings row. */
const MAX_BACKLOG = 5_000;
const PERSIST_EVERY = 10;

export interface GmailSyncConfig {
  intervalMs?: number; // default 5 min
  initialDelayMs?: number; // default 60 s
  lookbackHours?: number; // first-connect window (default 30 days = 720 h; owner decision G4)
  maxCatchUpDays?: number; // window cap after a history 404 (default 7)
  maxMessagesPerRun?: number; // messages.get budget per run (default 100)
  maxListPages?: number; // messages.list pages per full sync (default 10 × 500 ids)
  maxHistoryPages?: number; // history.list pages per run (default 10 × 500 records)
  /** Pause between messages.get calls (default 250 ms ≈ 80 quota units/s). */
  getIntervalMs?: number;
  /** Run cadence while an older-mail import has work left (default 60 s). */
  importIntervalMs?: number;
  /** messages.list pages for an import window (default 20 × 500 = the newest 10,000 ids). */
  maxImportListPages?: number;
}

/** Import windows the owner may choose (GMAIL_API_INTEGRATION_PLAN.md §12). */
export const GMAIL_IMPORT_MONTHS: readonly number[] = Object.freeze([6]);

export type GmailImportStatus = 'requested' | 'importing' | 'done' | 'stopped';

/** Persisted import progress; the listed ids live in their own key, written once. */
interface GmailImportState {
  status: GmailImportStatus;
  months: number;
  requestedAt: string;
  /** Window start, set when the window is listed. */
  sinceIso: string | null;
  finishedAt: string | null;
  total: number;
  /** Cursor into the stored ids (oldest first). */
  nextIndex: number;
  captured: number;
  duplicates: number;
  /** Not captured: automated senders, not addressed to the owner, drafts, spam, promotions, or deleted. */
  filtered: number;
  failed: number;
  /** The window held more mail than the listing cap; the newest ids were kept. */
  truncated: boolean;
}

export interface GmailImportView {
  status: GmailImportStatus;
  months: number;
  requestedAt: string;
  sinceIso: string | null;
  finishedAt: string | null;
  total: number;
  checked: number;
  captured: number;
  duplicates: number;
  filtered: number;
  truncated: boolean;
}

/** A refused import request; the router maps `code` to 400 or 409. */
export class GmailImportError extends Error {
  constructor(message: string, readonly code: 'invalid_window' | 'not_connected' | 'import_active') {
    super(message);
    this.name = 'GmailImportError';
  }
}

export interface GmailSyncCounters {
  listed: number;
  skipped: number;
  noise: number;
  notAddressed: number;
  duplicates: number;
  emitted: number;
  received: number;
  sent: number;
  failed: number;
}

export interface GmailSyncResult {
  status: 'completed' | 'skipped' | 'failed';
  reason?: string;
  mode?: 'full' | 'partial';
  accountEmail?: string;
  counters: GmailSyncCounters;
  backlog: number;
  durationMs: number;
  /** Older-mail import work done in this run, when an import is active. */
  import?: { checked: number; captured: number; left: number };
}

/** Every Gmail row BotBoy holds, so the page shows totals beside the last run's counters. */
export interface GmailCapturedCounts {
  total: number;
  received: number;
  sent: number;
  /** Rows the librarian linked to a project. */
  inProjects: number;
}

export interface GmailSyncStatusView {
  enabled: boolean;
  running: boolean;
  intervalMinutes: number;
  connection: GmailConnectionStatus;
  noiseSenders: string[];
  mailActive: boolean;
  backlog: number;
  hasCursor: boolean;
  lastRun: Record<string, unknown> | null;
  captured: GmailCapturedCounts;
  /** The older-mail import, or null when none was started for this mailbox. */
  import: GmailImportView | null;
}

export interface GmailSyncConfigInput {
  enabled?: boolean;
  noiseSenders?: string[];
}

export interface GmailSync {
  start(): void;
  stop(): void;
  runNow(): Promise<GmailSyncResult>;
  isRunning(): boolean;
  getStatus(): GmailSyncStatusView;
  updateConfig(input: GmailSyncConfigInput): GmailSyncStatusView;
  /**
   * Owner-started import of older mail (`months` from GMAIL_IMPORT_MONTHS).
   * The next run lists the window once; later runs work through it after new
   * mail. Throws GmailImportError when refused.
   */
  requestImport(input: { months?: unknown }): GmailSyncStatusView;
  /** Stops the import; mail already captured stays. */
  stopImport(): GmailSyncStatusView;
}

function emptyCounters(): GmailSyncCounters {
  return { listed: 0, skipped: 0, noise: 0, notAddressed: 0, duplicates: 0, emitted: 0, received: 0, sent: 0, failed: 0 };
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

export function createGmailSync(deps: {
  db: Database.Database;
  connection: GmailAccountConnection;
  emit: (item: RawWorkItem) => void;
  config?: GmailSyncConfig;
  captureHealth?: Pick<CaptureHealth, 'reportSuccess' | 'reportFailure'>;
  now?: () => number;
  /** Which account this sync captures for (default: `default`, unlabelled). */
  account?: () => GmailCaptureAccount;
  /** The owner's other mail addresses (other accounts, Outlook). */
  otherOwnAddresses?: () => string[];
}): GmailSync {
  const { db, connection, emit } = deps;
  const accountId = connection.id || 'default';
  const KEYS = gmailSyncKeysFor(accountId);
  const captureAccount = (): GmailCaptureAccount => deps.account?.() ?? { id: accountId, label: '', named: false };
  const itemUrl = (messageId: string) => gmailItemUrl(messageId, accountId);
  const TAG = accountId === 'default' ? '[GmailSync]' : `[GmailSync ${accountId}]`;
  const now = deps.now ?? Date.now;
  const intervalMs = deps.config?.intervalMs ?? 5 * 60_000;
  const initialDelayMs = deps.config?.initialDelayMs ?? 60_000;
  const lookbackHours = deps.config?.lookbackHours ?? 30 * 24;
  const maxCatchUpDays = deps.config?.maxCatchUpDays ?? 7;
  const maxMessagesPerRun = deps.config?.maxMessagesPerRun ?? 100;
  const maxListPages = deps.config?.maxListPages ?? 10;
  const maxHistoryPages = deps.config?.maxHistoryPages ?? 10;
  const getIntervalMs = deps.config?.getIntervalMs ?? 250;
  const importIntervalMs = deps.config?.importIntervalMs ?? 60_000;
  const maxImportListPages = deps.config?.maxImportListPages ?? 20;

  let timer: ReturnType<typeof setInterval> | null = null;
  let initialTimer: ReturnType<typeof setTimeout> | null = null;
  let followUpTimer: ReturnType<typeof setTimeout> | null = null;
  let running = false;
  let lastLoggedError = '';
  // Bumped by every import request, stop, and mailbox reset: a run that read
  // the import before the change never writes its progress back over it.
  let importGeneration = 0;

  const hasUrl = db.prepare('SELECT 1 FROM work_items WHERE url = ? LIMIT 1');
  // Gmail rows are only these two types, so idx_work_items_type keeps this a
  // few-millisecond read on the status path (no full table scan).
  // This account's rows: its URL form (`default` = the original form).
  const capturedCounts = db.prepare(`
    SELECT COUNT(*) AS total,
           COALESCE(SUM(type = 'email_sent'), 0) AS sent,
           COALESCE(SUM(project_id IS NOT NULL), 0) AS inProjects
      FROM work_items
     WHERE type IN ('email_read', 'email_sent') AND source = 'gmail' AND url LIKE ?
  `);
  const urlPattern = accountId === 'default' ? 'gmail://mail/%' : `gmail://${accountId}/mail/%`;

  // A different account (or a disconnect) starts over: cursors and backlog
  // belong to one mailbox.
  const offChange = connection.onChange(() => {
    const account = connection.accountEmail();
    if (account !== (getSetting<string>(db, KEYS.account) ?? null)) resetCursor(account);
  });

  function resetCursor(account: string | null): void {
    importGeneration++;
    db.transaction(() => {
      setSetting(db, KEYS.account, account);
      setSetting(db, KEYS.historyId, null);
      setSetting(db, KEYS.backlog, []);
      setSetting(db, KEYS.lastMessageAt, null);
      setSetting(db, KEYS.mailActive, false);
      setSetting(db, KEYS.import, null);
      setSetting(db, KEYS.importIds, []);
    })();
  }

  // ── Older-mail import (owner-started; §12) ──────────────────────────────

  function readImport(): GmailImportState | null {
    const value = getSetting<GmailImportState>(db, KEYS.import);
    return value && typeof value === 'object' && typeof value.status === 'string' ? value : null;
  }

  function importIds(): string[] {
    const value = getSetting<unknown>(db, KEYS.importIds);
    return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
  }

  const importActive = (state: GmailImportState | null): boolean =>
    state?.status === 'requested' || state?.status === 'importing';

  function importView(): GmailImportView | null {
    const state = readImport();
    if (!state) return null;
    return {
      status: state.status,
      months: state.months,
      requestedAt: state.requestedAt,
      sinceIso: state.sinceIso,
      finishedAt: state.finishedAt,
      total: state.total,
      checked: state.nextIndex,
      captured: state.captured,
      duplicates: state.duplicates,
      filtered: state.filtered,
      truncated: state.truncated,
    };
  }

  /** The window start: the same calendar day `months` ago. */
  function importSince(months: number): number {
    const start = new Date(now());
    start.setUTCMonth(start.getUTCMonth() - months);
    return start.getTime();
  }

  /** Runs again soon while an import has work left; only once the sync is started. */
  function scheduleFollowUp(delayMs: number): void {
    if (!timer || followUpTimer) return;
    followUpTimer = setTimeout(() => {
      followUpTimer = null;
      void guardedRun();
    }, delayMs);
    followUpTimer.unref?.();
  }

  function backlog(): string[] {
    const value = getSetting<unknown>(db, KEYS.backlog);
    return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
  }

  function noisePatterns(): string[] {
    const configured = getSetting<string[]>(db, KEYS.noiseSenders);
    if (Array.isArray(configured) && configured.length > 0) return configured.map(pattern => String(pattern).toLowerCase());
    return [...DEFAULT_NOISE_SENDERS];
  }

  /** Append new ids (oldest first) and move the cursor in one transaction. */
  function enqueue(ids: string[], cursor: { historyId: string } | null): number {
    const existing = backlog();
    const seen = new Set(existing);
    let added = 0;
    for (const id of ids) {
      if (seen.has(id)) continue;
      seen.add(id);
      existing.push(id);
      added++;
    }
    let next = existing;
    if (next.length > MAX_BACKLOG) {
      console.warn(`${TAG} backlog over ${MAX_BACKLOG}; keeping the newest ${MAX_BACKLOG} ids`);
      next = next.slice(-MAX_BACKLOG);
    }
    db.transaction(() => {
      setSetting(db, KEYS.backlog, next);
      if (cursor) setSetting(db, KEYS.historyId, cursor.historyId);
    })();
    return added;
  }

  /** Bounded full sync: list the window newest-first, enqueue oldest-first. */
  async function fullSync(client: GmailClient, sinceMs: number, counters: GmailSyncCounters): Promise<void> {
    // The history cursor is read BEFORE listing, so mail arriving during the
    // list is covered by the next partial sync (dedup absorbs the overlap).
    const profile = await client.getProfile();
    const query = `after:${Math.floor(sinceMs / 1000)} ${FULL_SYNC_EXCLUSIONS}`;
    const ids: string[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < maxListPages; page++) {
      const result = await client.listMessages({ q: query, pageToken, maxResults: 500 });
      for (const message of result.messages) ids.push(message.id);
      pageToken = result.nextPageToken;
      if (!pageToken) break;
    }
    if (pageToken) console.warn(`${TAG} full sync stopped at ${maxListPages} pages; older mail in the window is not captured`);
    counters.listed += ids.length;
    enqueue(ids.reverse(), { historyId: profile.historyId });
  }

  /** Partial sync from the stored historyId; returns false when history expired. */
  async function partialSync(client: GmailClient, startHistoryId: string, counters: GmailSyncCounters): Promise<boolean> {
    const ids: string[] = [];
    let pageToken: string | undefined;
    let cursor = startHistoryId;
    for (let page = 0; page < maxHistoryPages; page++) {
      let result;
      try {
        result = await client.listHistory({ startHistoryId, pageToken, maxResults: 500 });
      } catch (error) {
        if (error instanceof GoogleApiError && error.status === 404) return false;
        throw error;
      }
      for (const record of result.records) {
        for (const message of record.messagesAdded as GmailMessageRef[]) {
          counters.listed++;
          if (skipByLabels(message.labelIds)) { counters.skipped++; continue; }
          ids.push(message.id);
        }
        if (record.id) cursor = record.id;
      }
      pageToken = result.nextPageToken;
      // Without a next page the response historyId is the mailbox's current
      // one; with the page cap hit, resume after the last record read.
      if (!pageToken) { cursor = result.historyId || cursor; break; }
    }
    enqueue(ids, { historyId: cursor });
    return true;
  }

  async function ownerOf(client: GmailClient, account: string): Promise<GmailOwner> {
    let aliases: string[] = [];
    try {
      aliases = await client.listSendAsAddresses();
    } catch (error) {
      // A dead grant fails the whole run at once (one refresh attempt, one
      // Reconnect message) instead of failing again on the next call.
      if (error instanceof GmailAuthError) throw error;
      // Send-as needs no extra scope, but a Workspace policy may hide it;
      // the account address alone still works.
      console.warn(`${TAG} send-as aliases unavailable: ${(error as Error)?.message ?? error}`);
    }
    const own = new Set([account, ...aliases]);
    const others = new Set((deps.otherOwnAddresses?.() ?? []).map(address => address.toLowerCase()).filter(address => !own.has(address)));
    return { primary: account, aliases: own, otherOwnAddresses: others };
  }

  /** One run's messages.get budget, shared by new mail (first) and an import. */
  interface RunBudget { remaining: number; fetched: number }

  type MessageOutcome =
    | { kind: 'gone' }
    | { kind: 'unreadable' }
    | { kind: 'emitted'; direction: 'sent' | 'received'; at: string | null }
    | { kind: 'filtered'; reason: GmailSkipReason; at: string | null };

  /**
   * Fetches and decides one message. Transport, quota, and auth failures
   * throw, so the caller keeps the id for the next run.
   */
  async function fetchAndDecide(
    client: GmailClient,
    id: string,
    owner: GmailOwner,
    patterns: string[],
    budget: RunBudget,
  ): Promise<MessageOutcome> {
    if (budget.fetched > 0 && getIntervalMs > 0) await sleep(getIntervalMs);
    budget.fetched++;
    budget.remaining--;
    let message;
    try {
      message = await client.getMessage(id);
    } catch (error) {
      // Deleted between listing and fetching: nothing to capture.
      if (error instanceof GoogleApiError && error.status === 404) return { kind: 'gone' };
      // A structurally broken answer for this one id cannot improve on
      // retry; skipping it keeps the rest of the queue moving.
      if (error instanceof GoogleApiError && error.code === 'unreadable_response' && error.status === 200) {
        console.warn(`${TAG} skipped an unreadable message: ${error.message}`);
        return { kind: 'unreadable' };
      }
      throw error;
    }
    let decision;
    try {
      decision = decideGmailMessage(message, owner, patterns, captureAccount());
    } catch (error) {
      // One malformed message must not block every later one.
      console.warn(`${TAG} skipped a message that could not be parsed: ${(error as Error)?.name ?? 'Error'}`);
      return { kind: 'unreadable' };
    }
    const at = messageTimestampOf(message);
    if (decision.kind === 'emit') {
      emit(decision.item);
      return { kind: 'emitted', direction: decision.direction === 'sent' ? 'sent' : 'received', at };
    }
    return { kind: 'filtered', reason: decision.reason, at };
  }

  async function drain(client: GmailClient, owner: GmailOwner, counters: GmailSyncCounters, budget: RunBudget): Promise<number> {
    const queue = backlog();
    const patterns = noisePatterns();
    let decided = 0;
    let newest = getSetting<string>(db, KEYS.lastMessageAt) ?? '';
    const persist = () => {
      db.transaction(() => {
        setSetting(db, KEYS.backlog, queue.slice(decided));
        if (newest) setSetting(db, KEYS.lastMessageAt, newest);
      })();
    };
    try {
      while (decided < queue.length) {
        const id = queue[decided];
        if (hasUrl.get(itemUrl(id))) {
          counters.duplicates++;
          decided++;
          continue;
        }
        if (budget.remaining <= 0) break;
        let outcome: MessageOutcome;
        try {
          outcome = await fetchAndDecide(client, id, owner, patterns, budget);
        } catch (error) {
          // Transport, quota, and auth failures stop the run; the id stays
          // queued and the next run retries it.
          counters.failed++;
          throw error;
        }
        if (outcome.kind === 'gone') counters.skipped++;
        else if (outcome.kind === 'unreadable') counters.failed++;
        else if (outcome.kind === 'emitted') {
          counters.emitted++;
          if (outcome.direction === 'sent') counters.sent++; else counters.received++;
        } else countSkip(counters, outcome.reason);
        if ((outcome.kind === 'emitted' || outcome.kind === 'filtered') && outcome.at && outcome.at > newest) newest = outcome.at;
        decided++;
        if (decided % PERSIST_EVERY === 0) persist();
      }
    } finally {
      persist();
    }
    return queue.length - decided;
  }

  /**
   * An active import lists its window once (newest first, capped), stores the
   * ids oldest first, then decides them with whatever budget new mail left.
   * Mail already stored is skipped without a fetch. A failed fetch throws and
   * keeps the cursor; the next run resumes there.
   */
  async function importStep(client: GmailClient, owner: GmailOwner, budget: RunBudget): Promise<GmailSyncResult['import']> {
    let state = readImport();
    if (!state || !importActive(state)) return undefined;
    const generation = importGeneration;
    if (state.status === 'requested') {
      const since = importSince(state.months);
      const query = `after:${Math.floor(since / 1000)} ${FULL_SYNC_EXCLUSIONS}`;
      const listed: string[] = [];
      let pageToken: string | undefined;
      for (let page = 0; page < maxImportListPages; page++) {
        const result = await client.listMessages({ q: query, pageToken, maxResults: 500 });
        for (const message of result.messages) listed.push(message.id);
        pageToken = result.nextPageToken;
        if (!pageToken) break;
      }
      // Stopped, restarted, or the mailbox changed while listing.
      if (generation !== importGeneration) return undefined;
      if (pageToken) console.warn(`${TAG} import window holds more than ${listed.length} messages; importing the newest ${listed.length}`);
      const ids = listed.reverse();
      state = { ...state, status: 'importing', sinceIso: new Date(since).toISOString(), total: ids.length, nextIndex: 0, truncated: Boolean(pageToken) };
      const listedState = state;
      db.transaction(() => {
        setSetting(db, KEYS.importIds, ids);
        setSetting(db, KEYS.import, listedState);
      })();
      console.log(`${TAG} import listed ${ids.length} messages since ${listedState.sinceIso}`);
    }
    const ids = importIds();
    const current: GmailImportState = { ...state };
    const patterns = noisePatterns();
    const startIndex = current.nextIndex;
    const capturedBefore = current.captured;
    const persist = () => {
      if (generation !== importGeneration) return;
      const done = current.nextIndex >= ids.length;
      const saved: GmailImportState = done ? { ...current, status: 'done', finishedAt: new Date(now()).toISOString() } : current;
      db.transaction(() => {
        setSetting(db, KEYS.import, saved);
        if (done) setSetting(db, KEYS.importIds, []);
      })();
    };
    try {
      while (current.nextIndex < ids.length && generation === importGeneration) {
        const id = ids[current.nextIndex];
        if (hasUrl.get(itemUrl(id))) {
          current.duplicates++;
          current.nextIndex++;
          continue;
        }
        if (budget.remaining <= 0) break;
        const outcome = await fetchAndDecide(client, id, owner, patterns, budget);
        if (outcome.kind === 'emitted') current.captured++;
        else if (outcome.kind === 'unreadable') current.failed++;
        else current.filtered++;
        current.nextIndex++;
        if (current.nextIndex % PERSIST_EVERY === 0) persist();
      }
    } finally {
      persist();
    }
    return { checked: current.nextIndex - startIndex, captured: current.captured - capturedBefore, left: ids.length - current.nextIndex };
  }

  function countSkip(counters: GmailSyncCounters, reason: GmailSkipReason): void {
    if (reason === 'noise') counters.noise++;
    else if (reason === 'not_addressed') counters.notAddressed++;
    else counters.skipped++;
  }

  async function runOnce(): Promise<GmailSyncResult> {
    const startedAt = now();
    const result: GmailSyncResult = { status: 'completed', counters: emptyCounters(), backlog: backlog().length, durationMs: 0 };
    const finish = (): GmailSyncResult => {
      result.durationMs = now() - startedAt;
      return result;
    };

    if (getSetting<boolean>(db, KEYS.enabled) === false) {
      result.status = 'skipped';
      result.reason = 'gmail_sync.enabled is false';
      return finish();
    }
    const account = connection.accountEmail();
    if (!account) {
      result.status = 'skipped';
      result.reason = 'Gmail is not connected';
      return finish();
    }
    result.accountEmail = account;

    try {
      if ((getSetting<string>(db, KEYS.account) ?? null) !== account) resetCursor(account);
      const client = connection.client();
      const owner = await ownerOf(client, account);
      const historyId = getSetting<string>(db, KEYS.historyId);
      if (historyId) {
        result.mode = 'partial';
        const ok = await partialSync(client, historyId, result.counters);
        if (!ok) {
          // History expired: resume from the newest captured message.
          result.mode = 'full';
          const lastAt = Date.parse(getSetting<string>(db, KEYS.lastMessageAt) ?? '');
          const floor = now() - maxCatchUpDays * 86_400_000;
          const since = Number.isFinite(lastAt) ? Math.max(lastAt - 5 * 60_000, floor) : now() - lookbackHours * 3_600_000;
          console.warn(`${TAG} history expired; full sync from ${new Date(since).toISOString()}`);
          await fullSync(client, since, result.counters);
        }
      } else {
        result.mode = 'full';
        const lastAt = Date.parse(getSetting<string>(db, KEYS.lastMessageAt) ?? '');
        const since = Number.isFinite(lastAt)
          ? Math.max(lastAt - 5 * 60_000, now() - maxCatchUpDays * 86_400_000)
          : now() - lookbackHours * 3_600_000;
        await fullSync(client, since, result.counters);
      }
      const budget: RunBudget = { remaining: maxMessagesPerRun, fetched: 0 };
      result.backlog = await drain(client, owner, result.counters, budget);
      setSetting(db, KEYS.mailActive, true);
      // New mail first; an older-mail import gets whatever budget is left.
      result.import = await importStep(client, owner, budget);
    } catch (error) {
      result.status = 'failed';
      result.reason = error instanceof GmailAuthError || error instanceof GoogleApiError
        ? error.message
        : `Gmail sync failed: ${String((error as Error)?.message ?? error).slice(0, 240)}`;
      result.backlog = backlog().length;
    }

    finish();
    setSetting(db, KEYS.lastRun, {
      at: new Date(now()).toISOString(),
      status: result.status,
      reason: result.reason ?? null,
      mode: result.mode ?? null,
      accountEmail: result.accountEmail ?? null,
      counters: result.counters,
      backlog: result.backlog,
      durationMs: result.durationMs,
    });

    if (result.status === 'failed') {
      deps.captureHealth?.reportFailure('gmail', {
        kind: classifyCaptureFailure(result.reason ?? ''),
        reason: result.reason ?? 'sync failed',
      });
      if (result.reason !== lastLoggedError) {
        console.warn(`${TAG} sync failed: ${result.reason}`);
        lastLoggedError = result.reason ?? '';
      }
    } else {
      deps.captureHealth?.reportSuccess('gmail');
      lastLoggedError = '';
      const c = result.counters;
      const imported = result.import
        ? `; import: ${result.import.checked} checked, ${result.import.captured} captured, ${result.import.left} left`
        : '';
      console.log(
        `${TAG} ${result.mode} sync in ${(result.durationMs / 1000).toFixed(1)}s — ${c.listed} listed → `
        + `${c.emitted} emitted (${c.received} received, ${c.sent} sent; ${c.noise} noise, ${c.notAddressed} not addressed, `
        + `${c.skipped} skipped, ${c.duplicates} dup); ${result.backlog} left${imported}`,
      );
    }
    return result;
  }

  async function guardedRun(): Promise<GmailSyncResult> {
    if (running) {
      return { status: 'skipped', reason: 'sync already running', counters: emptyCounters(), backlog: backlog().length, durationMs: 0 };
    }
    running = true;
    try {
      return await runOnce();
    } finally {
      running = false;
      // An import with work left runs again in a minute, not five.
      if (importActive(readImport())) scheduleFollowUp(importIntervalMs);
    }
  }

  function captured(): GmailCapturedCounts {
    const row = capturedCounts.get(urlPattern) as { total: number; sent: number; inProjects: number };
    return { total: row.total, received: row.total - row.sent, sent: row.sent, inProjects: row.inProjects };
  }

  function getStatus(): GmailSyncStatusView {
    return {
      enabled: getSetting<boolean>(db, KEYS.enabled) !== false,
      running,
      intervalMinutes: Math.round(intervalMs / 60_000),
      connection: connection.status(),
      noiseSenders: getSetting<string[]>(db, KEYS.noiseSenders) ?? [...DEFAULT_NOISE_SENDERS],
      mailActive: getSetting<boolean>(db, KEYS.mailActive) === true,
      backlog: backlog().length,
      hasCursor: Boolean(getSetting<string>(db, KEYS.historyId)),
      lastRun: getSetting<Record<string, unknown>>(db, KEYS.lastRun) ?? null,
      captured: captured(),
      import: importView(),
    };
  }

  function updateConfig(input: GmailSyncConfigInput): GmailSyncStatusView {
    if (input.enabled !== undefined) {
      if (typeof input.enabled !== 'boolean') throw new Error('enabled must be a boolean');
      setSetting(db, KEYS.enabled, input.enabled);
    }
    if (input.noiseSenders !== undefined) {
      setSetting(db, KEYS.noiseSenders, cleanNoisePatterns(input.noiseSenders));
    }
    return getStatus();
  }

  function requestImport(input: { months?: unknown }): GmailSyncStatusView {
    const months = input?.months;
    if (typeof months !== 'number' || !GMAIL_IMPORT_MONTHS.includes(months)) {
      throw new GmailImportError(`Choose an import window of ${GMAIL_IMPORT_MONTHS.join(' or ')} months.`, 'invalid_window');
    }
    if (!connection.accountEmail()) {
      throw new GmailImportError('Connect Gmail before importing older mail.', 'not_connected');
    }
    if (importActive(readImport())) {
      throw new GmailImportError('An import is already running. Stop it to start a new one.', 'import_active');
    }
    importGeneration++;
    const state: GmailImportState = {
      status: 'requested',
      months,
      requestedAt: new Date(now()).toISOString(),
      sinceIso: null,
      finishedAt: null,
      total: 0,
      nextIndex: 0,
      captured: 0,
      duplicates: 0,
      filtered: 0,
      failed: 0,
      truncated: false,
    };
    db.transaction(() => {
      setSetting(db, KEYS.import, state);
      setSetting(db, KEYS.importIds, []);
    })();
    console.log(`${TAG} import of the last ${months} months requested`);
    // A run in progress picks it up or schedules the next one when it ends.
    if (!running) scheduleFollowUp(1_000);
    return getStatus();
  }

  function stopImport(): GmailSyncStatusView {
    const state = readImport();
    if (state && importActive(state)) {
      importGeneration++;
      db.transaction(() => {
        setSetting(db, KEYS.import, { ...state, status: 'stopped', finishedAt: new Date(now()).toISOString() });
        setSetting(db, KEYS.importIds, []);
      })();
      console.log(`${TAG} import stopped after ${state.nextIndex} of ${state.total} messages`);
    }
    return getStatus();
  }

  return {
    start(): void {
      if (timer || initialTimer) return;
      initialTimer = setTimeout(() => {
        initialTimer = null;
        void guardedRun();
      }, initialDelayMs);
      initialTimer.unref?.();
      timer = setInterval(() => { void guardedRun(); }, intervalMs);
      timer.unref?.();
    },
    stop(): void {
      offChange();
      if (initialTimer) { clearTimeout(initialTimer); initialTimer = null; }
      if (timer) { clearInterval(timer); timer = null; }
      if (followUpTimer) { clearTimeout(followUpTimer); followUpTimer = null; }
    },
    runNow: guardedRun,
    isRunning: () => running,
    getStatus,
    updateConfig,
    requestImport,
    stopImport,
  };
}

/** Browser-scraped Gmail web pages (browser-monitor.ts mail.google.com pattern). */
export function isGmailWebEmailItem(item: RawWorkItem): boolean {
  return item.source === 'browser'
    && (item.type === 'email_read' || item.type === 'email_sent')
    && /^https?:\/\/mail\.google\.com\//i.test(item.url ?? '');
}

/**
 * Once the Gmail API sync has completed a run and stays enabled, browser
 * scrapes of Gmail web are redundant noise (the same rule GRASP applies to
 * Outlook web). Cached briefly — this runs on the hot capture path.
 */
export function createGmailBrowserCaptureGate(db: Database.Database): () => boolean {
  let cached = false;
  let checkedAt = 0;
  return () => {
    const current = Date.now();
    if (current - checkedAt > 60_000) {
      // Any connected account whose sync has completed a run.
      const anyActive = getSetting<boolean>(db, KEYS.mailActive) === true
        || Boolean(db.prepare("SELECT 1 FROM app_settings WHERE key LIKE 'gmail_sync.acct.%.mail_active' AND value = 'true' LIMIT 1").get());
      cached = getSetting<boolean>(db, KEYS.enabled) !== false && anyActive;
      checkedAt = current;
    }
    return cached;
  };
}

// ── Every connected account (GMAIL_API_INTEGRATION_PLAN.md §13) ──────────

/** One account's sync view on the page. */
export interface GmailAccountSyncView {
  id: string;
  label: string;
  email: string;
  connection: GmailConnectionStatus;
  running: boolean;
  backlog: number;
  hasCursor: boolean;
  mailActive: boolean;
  lastRun: Record<string, unknown> | null;
  captured: GmailCapturedCounts;
  import: GmailImportView | null;
}

/** The page status: the first account's fields (unchanged shape) plus every account. */
export interface GmailSyncsStatusView extends GmailSyncStatusView {
  accounts: GmailAccountSyncView[];
}

export interface GmailSyncs {
  start(): void;
  stop(): void;
  /** Runs one account (default: every account, one after another). */
  runNow(accountId?: string): Promise<GmailSyncResult>;
  isRunning(): boolean;
  getStatus(): GmailSyncsStatusView;
  updateConfig(input: GmailSyncConfigInput): GmailSyncsStatusView;
  requestImport(input: { months?: unknown; accountId?: unknown }): GmailSyncsStatusView;
  stopImport(input?: { accountId?: unknown }): GmailSyncsStatusView;
  /** The sync of one account (tests, the router). */
  forAccount(accountId: string): GmailSync | null;
}

/**
 * One sync per connected account, created and stopped as accounts come and
 * go. Each account keeps its own cursor, backlog, import, and last run; the
 * on/off switch and the noise senders are shared. Capture health has one
 * Gmail source: any failing account fails it (named), and it recovers only
 * when no account is failing.
 */
export function createGmailSyncs(deps: {
  db: Database.Database;
  connection: GmailConnection;
  emit: (item: RawWorkItem) => void;
  config?: GmailSyncConfig;
  captureHealth?: Pick<CaptureHealth, 'reportSuccess' | 'reportFailure'>;
  now?: () => number;
  /** The owner's Outlook address, also "the owner" in Gmail mail. */
  extraOwnAddresses?: () => string[];
}): GmailSyncs {
  const syncs = new Map<string, GmailSync>();
  const failing = new Map<string, string>();
  let started = false;

  const accountsNow = () => deps.connection.accounts();
  const accountFor = (accountId: string): GmailCaptureAccount => {
    const all = accountsNow();
    const entry = all.find(account => account.id === accountId);
    const label = entry?.label ?? '';
    return { id: accountId, label, named: all.length > 1 || Boolean(label) };
  };
  const nameOf = (accountId: string): string => {
    const entry = accountsNow().find(account => account.id === accountId);
    return entry ? gmailAccountName(entry) : accountId;
  };

  function healthFor(accountId: string): Pick<CaptureHealth, 'reportSuccess' | 'reportFailure'> | undefined {
    const health = deps.captureHealth;
    if (!health) return undefined;
    return {
      reportFailure(source, failure) {
        const multi = accountsNow().length > 1;
        const reason = multi ? `${nameOf(accountId)}: ${failure.reason}` : failure.reason;
        failing.set(accountId, reason);
        health.reportFailure(source, { ...failure, reason });
      },
      reportSuccess(source) {
        failing.delete(accountId);
        if (!failing.size) health.reportSuccess(source);
      },
    };
  }

  function reconcile(): void {
    const ids = new Set(accountsNow().map(account => account.id));
    // The default slot always has a sync so a first connect starts at once.
    ids.add('default');
    for (const [id, sync] of syncs) {
      if (!ids.has(id)) {
        sync.stop();
        syncs.delete(id);
        failing.delete(id);
      }
    }
    for (const id of ids) {
      if (syncs.has(id)) continue;
      const sync = createGmailSync({
        db: deps.db,
        connection: deps.connection.slot(id),
        emit: deps.emit,
        config: deps.config,
        captureHealth: healthFor(id),
        now: deps.now,
        account: () => accountFor(id),
        otherOwnAddresses: () => [
          ...accountsNow().filter(account => account.id !== id).map(account => account.email),
          ...(deps.extraOwnAddresses?.() ?? []),
        ],
      });
      syncs.set(id, sync);
      if (started) sync.start();
    }
  }

  reconcile();
  deps.connection.onChange(() => reconcile());

  function accountViews(): GmailAccountSyncView[] {
    return accountsNow().map((account) => {
      const status = syncs.get(account.id)?.getStatus();
      return {
        id: account.id,
        label: account.label,
        email: account.email,
        connection: deps.connection.account(account.id)?.status() ?? deps.connection.status(),
        running: status?.running ?? false,
        backlog: status?.backlog ?? 0,
        hasCursor: status?.hasCursor ?? false,
        mailActive: status?.mailActive ?? false,
        lastRun: status?.lastRun ?? null,
        captured: status?.captured ?? { total: 0, received: 0, sent: 0, inProjects: 0 },
        import: status?.import ?? null,
      };
    });
  }

  function primary(): GmailSync {
    const first = accountsNow()[0]?.id ?? 'default';
    return syncs.get(first) ?? syncs.get('default')!;
  }

  function getStatus(): GmailSyncsStatusView {
    return { ...primary().getStatus(), accounts: accountViews() };
  }

  function pick(accountId: unknown): GmailSync {
    if (accountId === undefined || accountId === null || accountId === '') return primary();
    const sync = typeof accountId === 'string' && accountsNow().some(account => account.id === accountId) ? syncs.get(accountId) : undefined;
    if (!sync) throw new GmailImportError('That Gmail account is not connected.', 'not_connected');
    return sync;
  }

  return {
    start() {
      if (started) return;
      started = true;
      for (const sync of syncs.values()) sync.start();
    },
    stop() {
      started = false;
      for (const sync of syncs.values()) sync.stop();
    },
    async runNow(accountId) {
      if (accountId) return pick(accountId).runNow();
      let last: GmailSyncResult | null = null;
      for (const account of accountsNow()) {
        const sync = syncs.get(account.id);
        if (sync) last = await sync.runNow();
      }
      return last ?? primary().runNow();
    },
    isRunning: () => [...syncs.values()].some(sync => sync.isRunning()),
    getStatus,
    updateConfig(input) {
      // Shared keys: one write covers every account.
      primary().updateConfig(input);
      return getStatus();
    },
    requestImport(input) {
      pick(input?.accountId).requestImport({ months: input?.months });
      return getStatus();
    },
    stopImport(input) {
      pick(input?.accountId).stopImport();
      return getStatus();
    },
    forAccount: (accountId) => syncs.get(accountId) ?? null,
  };
}
