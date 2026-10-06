/**
 * Gmail background sync — the Gmail API counterpart of grasp-sync.ts for
 * owners without Amazon's GRASP (GMAIL_API_INTEGRATION_PLAN.md).
 *
 * Google's recommended sync model (Gmail API "Synchronize clients"):
 *   - Full sync on first connect: messages.list over the lookback window
 *     (48 h, the GRASP default), then partial sync with history.list from
 *     the stored historyId (2 quota units per call; usually one per run).
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
import { GmailAuthError, type GmailConnection, type GmailConnectionStatus } from '../core/gmail-connection.js';
import {
  decideGmailMessage,
  gmailItemUrl,
  messageTimestampOf,
  skipByLabels,
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
} as const;

/** Settings keys other modules read (browser gate, DOMAIN.md). */
export const GMAIL_SYNC_KEYS = KEYS;

/** Full-sync query: everything but drafts, spam, trash, chats, and the bulk categories. */
const FULL_SYNC_EXCLUSIONS = '-in:drafts -in:spam -in:trash -in:chats -category:promotions -category:social';
/** A backlog larger than this is truncated to its newest ids (logged); protects the settings row. */
const MAX_BACKLOG = 5_000;
const PERSIST_EVERY = 10;

export interface GmailSyncConfig {
  intervalMs?: number; // default 5 min
  initialDelayMs?: number; // default 60 s
  lookbackHours?: number; // first-connect window (default 48 h)
  maxCatchUpDays?: number; // window cap after a history 404 (default 7)
  maxMessagesPerRun?: number; // messages.get budget per run (default 100)
  maxListPages?: number; // messages.list pages per full sync (default 10 × 500 ids)
  maxHistoryPages?: number; // history.list pages per run (default 10 × 500 records)
  /** Pause between messages.get calls (default 250 ms ≈ 80 quota units/s). */
  getIntervalMs?: number;
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
}

function emptyCounters(): GmailSyncCounters {
  return { listed: 0, skipped: 0, noise: 0, notAddressed: 0, duplicates: 0, emitted: 0, received: 0, sent: 0, failed: 0 };
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

export function createGmailSync(deps: {
  db: Database.Database;
  connection: GmailConnection;
  emit: (item: RawWorkItem) => void;
  config?: GmailSyncConfig;
  captureHealth?: Pick<CaptureHealth, 'reportSuccess' | 'reportFailure'>;
  now?: () => number;
}): GmailSync {
  const { db, connection, emit } = deps;
  const now = deps.now ?? Date.now;
  const intervalMs = deps.config?.intervalMs ?? 5 * 60_000;
  const initialDelayMs = deps.config?.initialDelayMs ?? 60_000;
  const lookbackHours = deps.config?.lookbackHours ?? 48;
  const maxCatchUpDays = deps.config?.maxCatchUpDays ?? 7;
  const maxMessagesPerRun = deps.config?.maxMessagesPerRun ?? 100;
  const maxListPages = deps.config?.maxListPages ?? 10;
  const maxHistoryPages = deps.config?.maxHistoryPages ?? 10;
  const getIntervalMs = deps.config?.getIntervalMs ?? 250;

  let timer: ReturnType<typeof setInterval> | null = null;
  let initialTimer: ReturnType<typeof setTimeout> | null = null;
  let running = false;
  let lastLoggedError = '';

  const hasUrl = db.prepare('SELECT 1 FROM work_items WHERE url = ? LIMIT 1');

  // A different account (or a disconnect) starts over: cursors and backlog
  // belong to one mailbox.
  connection.onChange(() => {
    const account = connection.accountEmail();
    if (account !== (getSetting<string>(db, KEYS.account) ?? null)) resetCursor(account);
  });

  function resetCursor(account: string | null): void {
    db.transaction(() => {
      setSetting(db, KEYS.account, account);
      setSetting(db, KEYS.historyId, null);
      setSetting(db, KEYS.backlog, []);
      setSetting(db, KEYS.lastMessageAt, null);
      setSetting(db, KEYS.mailActive, false);
    })();
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
      console.warn(`[GmailSync] backlog over ${MAX_BACKLOG}; keeping the newest ${MAX_BACKLOG} ids`);
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
    if (pageToken) console.warn(`[GmailSync] full sync stopped at ${maxListPages} pages; older mail in the window is not captured`);
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
      console.warn(`[GmailSync] send-as aliases unavailable: ${(error as Error)?.message ?? error}`);
    }
    return { primary: account, aliases: new Set([account, ...aliases]) };
  }

  async function drain(client: GmailClient, owner: GmailOwner, counters: GmailSyncCounters): Promise<number> {
    const queue = backlog();
    const patterns = noisePatterns();
    let fetched = 0;
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
        if (hasUrl.get(gmailItemUrl(id))) {
          counters.duplicates++;
          decided++;
          continue;
        }
        if (fetched >= maxMessagesPerRun) break;
        if (fetched > 0 && getIntervalMs > 0) await sleep(getIntervalMs);
        fetched++;
        let message;
        try {
          message = await client.getMessage(id);
        } catch (error) {
          // Deleted between listing and fetching: nothing to capture.
          if (error instanceof GoogleApiError && error.status === 404) { counters.skipped++; decided++; continue; }
          // A structurally broken answer for this one id cannot improve on
          // retry; skipping it keeps the rest of the queue moving.
          if (error instanceof GoogleApiError && error.code === 'unreadable_response' && error.status === 200) {
            console.warn(`[GmailSync] skipped an unreadable message: ${error.message}`);
            counters.failed++;
            decided++;
            continue;
          }
          // Transport, quota, and auth failures stop the run; the id stays
          // queued and the next run retries it.
          counters.failed++;
          throw error;
        }
        let decision;
        try {
          decision = decideGmailMessage(message, owner, patterns);
        } catch (error) {
          // One malformed message must not block every later one.
          console.warn(`[GmailSync] skipped a message that could not be parsed: ${(error as Error)?.name ?? 'Error'}`);
          counters.failed++;
          decided++;
          continue;
        }
        if (decision.kind === 'emit') {
          emit(decision.item);
          counters.emitted++;
          if (decision.direction === 'sent') counters.sent++; else counters.received++;
        } else {
          countSkip(counters, decision.reason);
        }
        const at = messageTimestampOf(message);
        if (at && at > newest) newest = at;
        decided++;
        if (decided % PERSIST_EVERY === 0) persist();
      }
    } finally {
      persist();
    }
    return queue.length - decided;
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
          console.warn(`[GmailSync] history expired; full sync from ${new Date(since).toISOString()}`);
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
      result.backlog = await drain(client, owner, result.counters);
      setSetting(db, KEYS.mailActive, true);
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
        console.warn(`[GmailSync] sync failed: ${result.reason}`);
        lastLoggedError = result.reason ?? '';
      }
    } else {
      deps.captureHealth?.reportSuccess('gmail');
      lastLoggedError = '';
      const c = result.counters;
      console.log(
        `[GmailSync] ${result.mode} sync in ${(result.durationMs / 1000).toFixed(1)}s — ${c.listed} listed → `
        + `${c.emitted} emitted (${c.received} received, ${c.sent} sent; ${c.noise} noise, ${c.notAddressed} not addressed, `
        + `${c.skipped} skipped, ${c.duplicates} dup); ${result.backlog} left`,
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
    }
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
      if (initialTimer) { clearTimeout(initialTimer); initialTimer = null; }
      if (timer) { clearInterval(timer); timer = null; }
    },
    runNow: guardedRun,
    isRunning: () => running,
    getStatus,
    updateConfig,
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
      cached = getSetting<boolean>(db, KEYS.enabled) !== false
        && getSetting<boolean>(db, KEYS.mailActive) === true;
      checkedAt = current;
    }
    return cached;
  };
}
