import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createStorage, getSetting, setSetting, type StorageLayer } from '../core/storage.js';
import type { RawWorkItem } from '../core/types.js';
import {
  GMAIL_READONLY_SCOPE,
  GoogleApiError,
  type GmailClient,
  type GmailMessage,
  type GmailMessageRef,
} from '../core/gmail-api.js';
import type { GmailConnection } from '../core/gmail-connection.js';
import { createGmailBrowserCaptureGate, createGmailSync, isGmailWebEmailItem, type GmailSyncConfig } from './gmail-sync.js';

const OWNER = 'jane.doe@gmail.com';
const HOUR = 3_600_000;
const NOW = Date.parse('2026-10-05T12:00:00Z');
const EXCLUSIONS = '-in:drafts -in:spam -in:trash -in:chats -category:promotions -category:social';

interface MailInput {
  id: string;
  at: number;
  labels?: string[];
  from?: string;
  to?: string;
  subject?: string;
  threadId?: string;
}

/** An in-memory mailbox speaking the GmailClient contract, with call logs. */
function fakeMailbox() {
  const messages = new Map<string, GmailMessage>();
  const history: Array<{ id: string; messagesAdded: GmailMessageRef[] }> = [];
  let historyId = 1000;
  const box = {
    pageSize: 500,
    historyExpired: false,
    /** When set, messages.list waits for it (to stop an import mid-listing). */
    listGate: null as Promise<void> | null,
    /** When set, messages.get waits for it (to stop an import mid-fetch). */
    getGate: null as Promise<void> | null,
    failGet: new Map<string, () => Error>(),
    override: new Map<string, () => GmailMessage>(),
    calls: { list: [] as string[], history: [] as string[], get: [] as string[], profile: 0 },
    get historyId() { return String(historyId); },
    add(input: MailInput): void {
      const labels = input.labels ?? ['INBOX', 'UNREAD'];
      const headers = [
        { name: 'Subject', value: input.subject ?? `Subject ${input.id}` },
        { name: 'From', value: input.from ?? 'Requester <requester@example.com>' },
        { name: 'To', value: input.to ?? OWNER },
      ];
      messages.set(input.id, {
        id: input.id,
        threadId: input.threadId ?? `t-${input.id}`,
        labelIds: labels,
        internalDate: String(input.at),
        payload: { mimeType: 'text/plain', headers, body: { data: Buffer.from(`Body of ${input.id}`).toString('base64url') } },
      });
      historyId += 3;
      history.push({ id: String(historyId), messagesAdded: [{ id: input.id, threadId: input.threadId ?? `t-${input.id}`, labelIds: labels }] });
    },
    client(): GmailClient {
      return {
        async getProfile() {
          box.calls.profile++;
          return { emailAddress: OWNER, historyId: String(historyId) };
        },
        async listMessages({ q, pageToken }) {
          box.calls.list.push(q);
          if (box.listGate) await box.listGate;
          const after = Number(q.match(/after:(\d+)/)?.[1] ?? 0) * 1000;
          const excluded = ['DRAFT', 'SPAM', 'TRASH', 'CHAT', 'CATEGORY_PROMOTIONS', 'CATEGORY_SOCIAL'];
          const matching = [...messages.values()]
            .filter(message => Number(message.internalDate) > after)
            .filter(message => !(message.labelIds ?? []).some(label => excluded.includes(label)))
            .sort((a, b) => Number(b.internalDate) - Number(a.internalDate));
          const offset = Number(pageToken ?? 0);
          const page = matching.slice(offset, offset + box.pageSize);
          const next = offset + box.pageSize < matching.length ? String(offset + box.pageSize) : undefined;
          return { messages: page.map(message => ({ id: message.id, threadId: message.threadId })), nextPageToken: next };
        },
        async getMessage(id) {
          box.calls.get.push(id);
          if (box.getGate) await box.getGate;
          const failure = box.failGet.get(id);
          if (failure) throw failure();
          const custom = box.override.get(id);
          if (custom) return custom();
          const message = messages.get(id);
          if (!message) throw new GoogleApiError('Gmail message failed (HTTP 404 notFound)', 404, 'notFound');
          return message;
        },
        async listHistory({ startHistoryId, pageToken }) {
          box.calls.history.push(startHistoryId);
          if (box.historyExpired) throw new GoogleApiError('Gmail history failed (HTTP 404 notFound)', 404, 'notFound');
          const records = history.filter(record => Number(record.id) > Number(startHistoryId));
          const offset = Number(pageToken ?? 0);
          const page = records.slice(offset, offset + box.pageSize);
          const next = offset + box.pageSize < records.length ? String(offset + box.pageSize) : undefined;
          return { records: page, nextPageToken: next, historyId: String(historyId) };
        },
        async listSendAsAddresses() {
          return [OWNER, 'jane@doe.dev'];
        },
      };
    },
  };
  return box;
}

function fakeConnection(client: GmailClient, initial: string | null = OWNER) {
  const listeners = new Set<() => void>();
  let account = initial;
  const connection = {
    status: () => ({
      clientConfigured: true, clientIdSuffix: '…abcdef', connected: account !== null, accountEmail: account,
      connectedAt: null, needsReconnect: false, lastError: null,
      redirectUri: 'http://127.0.0.1:7778/api/gmail-sync/oauth/callback', scope: GMAIL_READONLY_SCOPE,
    }),
    isConnected: () => account !== null,
    accountEmail: () => account,
    client: () => client,
    onChange: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener); },
  } as unknown as GmailConnection;
  return {
    connection,
    setAccount(next: string | null) {
      account = next;
      for (const listener of listeners) listener();
    },
  };
}

describe('Gmail sync', () => {
  let storage: StorageLayer;
  let box: ReturnType<typeof fakeMailbox>;
  let clock: number;
  let emitted: RawWorkItem[];
  const health = { reportSuccess: vi.fn(), reportFailure: vi.fn() };

  beforeEach(() => {
    storage = createStorage(':memory:');
    storage.initialize();
    box = fakeMailbox();
    clock = NOW;
    emitted = [];
    health.reportSuccess.mockReset();
    health.reportFailure.mockReset();
  });
  afterEach(() => storage.close());

  /** Emit like the capture pipeline: the row exists, so URL dedup sees it. */
  function emit(item: RawWorkItem): void {
    emitted.push(item);
    storage.getDb().prepare(
      "INSERT INTO work_items (id, type, source, title, url, captured_at) VALUES (?, ?, 'gmail', ?, ?, ?)",
    ).run(`wi-${emitted.length}`, item.type, item.title, item.url, item.capturedAt.toISOString());
  }

  function sync(config: GmailSyncConfig = {}, account: string | null = OWNER) {
    const fake = fakeConnection(box.client(), account);
    const instance = createGmailSync({
      db: storage.getDb(), connection: fake.connection, emit, captureHealth: health, now: () => clock,
      config: { getIntervalMs: 0, ...config },
    });
    return { sync: instance, ...fake };
  }

  const setting = <T>(key: string) => getSetting<T>(storage.getDb(), key);
  const urls = () => emitted.map(item => item.url);

  function seedFirstConnectMailbox(): void {
    // Just outside the 30-day first-connect window.
    box.add({ id: 'old', at: NOW - 31 * 24 * HOUR });
    box.add({ id: 'm1', at: NOW - 4 * HOUR, subject: 'Insights PRD' });
    box.add({ id: 'm2', at: NOW - 3 * HOUR, labels: ['SENT'], from: `Jane <${OWNER}>`, to: 'requester@example.com' });
    box.add({ id: 'm3', at: NOW - 2.5 * HOUR, from: 'Shop <no-reply@shop.example.com>' });
    box.add({ id: 'm4', at: NOW - 2 * HOUR, to: 'everyone@example.com' });
    box.add({ id: 'draft', at: NOW - 1.5 * HOUR, labels: ['DRAFT'] });
    box.add({ id: 'promo', at: NOW - 1 * HOUR, labels: ['INBOX', 'CATEGORY_PROMOTIONS'] });
  }

  it('first connect: bounded full sync, oldest-first decisions, cursor, counters, and health', async () => {
    seedFirstConnectMailbox();
    const { sync: gmail } = sync();
    const result = await gmail.runNow();

    expect(result).toMatchObject({ status: 'completed', mode: 'full', accountEmail: OWNER, backlog: 0 });
    expect(box.calls.list).toEqual([`after:${Math.floor((NOW - 30 * 24 * HOUR) / 1000)} ${EXCLUSIONS}`]);
    expect(box.calls.get).toEqual(['m1', 'm2', 'm3', 'm4']);
    expect(urls()).toEqual(['gmail://mail/m1', 'gmail://mail/m2']);
    expect(emitted.map(item => item.type)).toEqual(['email_read', 'email_sent']);
    expect(result.counters).toMatchObject({ listed: 4, emitted: 2, received: 1, sent: 1, noise: 1, notAddressed: 1, duplicates: 0, failed: 0 });

    expect(setting('gmail_sync.history_id')).toBe(box.historyId);
    expect(setting('gmail_sync.backlog')).toEqual([]);
    expect(setting('gmail_sync.account')).toBe(OWNER);
    expect(setting('gmail_sync.mail_active')).toBe(true);
    expect(setting('gmail_sync.last_message_at')).toBe(new Date(NOW - 2 * HOUR).toISOString());
    expect(setting<any>('gmail_sync.last_run')).toMatchObject({ status: 'completed', mode: 'full', accountEmail: OWNER, backlog: 0 });
    expect(health.reportSuccess).toHaveBeenCalledWith('gmail');
    expect(health.reportFailure).not.toHaveBeenCalled();
    expect(gmail.getStatus()).toMatchObject({ enabled: true, hasCursor: true, backlog: 0, mailActive: true, intervalMinutes: 5, import: null });
    // Totals come from the store, beside the last run's counters; Outlook mail is not Gmail.
    storage.getDb().prepare(
      "INSERT INTO work_items (id, type, source, title, captured_at, project_id) VALUES ('outlook', 'email_read', 'grasp', 'x', datetime('now'), 'p1')",
    ).run();
    expect(gmail.getStatus().captured).toEqual({ total: 2, received: 1, sent: 1, inProjects: 0 });
  });

  it('partial sync reads only new history, skips label-excluded adds without fetching, and moves the cursor', async () => {
    seedFirstConnectMailbox();
    const { sync: gmail } = sync();
    await gmail.runNow();
    const cursor = box.historyId;
    box.calls.get.length = 0;

    box.add({ id: 'm7', at: NOW + 60_000, subject: 'Follow-up' });
    box.add({ id: 'draft2', at: NOW + 120_000, labels: ['DRAFT'] });
    clock = NOW + 5 * 60_000;
    const result = await gmail.runNow();
    expect(result).toMatchObject({ status: 'completed', mode: 'partial' });
    expect(box.calls.history).toEqual([cursor]);
    expect(box.calls.get).toEqual(['m7']);
    expect(urls()).toEqual(['gmail://mail/m1', 'gmail://mail/m2', 'gmail://mail/m7']);
    expect(result.counters).toMatchObject({ listed: 2, skipped: 1, emitted: 1 });
    expect(setting('gmail_sync.history_id')).toBe(box.historyId);

    const idle = await gmail.runNow();
    expect(idle.counters).toMatchObject({ listed: 0, emitted: 0 });
    expect(box.calls.get).toEqual(['m7']);
    expect(box.calls.list).toHaveLength(1);
  });

  it('spends at most the per-run budget of messages.get and drains the rest on later runs, each id once', async () => {
    for (let index = 1; index <= 5; index++) box.add({ id: `b${index}`, at: NOW - (6 - index) * HOUR });
    const { sync: gmail } = sync({ maxMessagesPerRun: 2 });
    expect((await gmail.runNow()).backlog).toBe(3);
    expect(setting('gmail_sync.backlog')).toEqual(['b3', 'b4', 'b5']);
    expect(gmail.getStatus().backlog).toBe(3);
    expect((await gmail.runNow()).backlog).toBe(1);
    expect((await gmail.runNow()).backlog).toBe(0);
    expect(box.calls.get).toEqual(['b1', 'b2', 'b3', 'b4', 'b5']);
    expect(urls()).toEqual(['b1', 'b2', 'b3', 'b4', 'b5'].map(id => `gmail://mail/${id}`));
  });

  it('never fetches an id whose item is already stored', async () => {
    box.add({ id: 'seen', at: NOW - 2 * HOUR });
    box.add({ id: 'fresh', at: NOW - HOUR });
    storage.getDb().prepare(
      "INSERT INTO work_items (id, type, source, title, url, captured_at) VALUES ('prior', 'email_read', 'gmail', 'x', 'gmail://mail/seen', datetime('now'))",
    ).run();
    const { sync: gmail } = sync();
    const result = await gmail.runNow();
    expect(result.counters).toMatchObject({ duplicates: 1, emitted: 1 });
    expect(box.calls.get).toEqual(['fresh']);
  });

  it('a transport failure keeps the unread ids queued behind an advanced cursor; the next run loses nothing', async () => {
    box.add({ id: 'c1', at: NOW - 3 * HOUR });
    box.add({ id: 'c2', at: NOW - 2 * HOUR });
    box.add({ id: 'c3', at: NOW - HOUR });
    box.failGet.set('c2', () => new GoogleApiError('Gmail message failed: network error (ECONNRESET)', 0, 'network'));
    const { sync: gmail } = sync();

    const failed = await gmail.runNow();
    expect(failed).toMatchObject({ status: 'failed', reason: 'Gmail message failed: network error (ECONNRESET)', backlog: 2 });
    expect(urls()).toEqual(['gmail://mail/c1']);
    // The cursor and the ids it covered were written together.
    expect(setting('gmail_sync.history_id')).toBe(box.historyId);
    expect(setting('gmail_sync.backlog')).toEqual(['c2', 'c3']);
    expect(health.reportFailure).toHaveBeenCalledWith('gmail', { kind: 'network', reason: 'Gmail message failed: network error (ECONNRESET)' });
    expect(setting<any>('gmail_sync.last_run')).toMatchObject({ status: 'failed', backlog: 2 });

    box.failGet.clear();
    const resumed = await gmail.runNow();
    expect(resumed).toMatchObject({ status: 'completed', mode: 'partial', backlog: 0 });
    expect(urls()).toEqual(['c1', 'c2', 'c3'].map(id => `gmail://mail/${id}`));
    expect(box.calls.get).toEqual(['c1', 'c2', 'c2', 'c3']);
    expect(health.reportSuccess).toHaveBeenCalledWith('gmail');
  });

  it('skips a deleted, an unreadable, or an unparseable message so later mail still flows', async () => {
    box.add({ id: 'gone', at: NOW - 4 * HOUR });
    box.add({ id: 'broken', at: NOW - 3 * HOUR });
    box.add({ id: 'weird', at: NOW - 2 * HOUR });
    box.add({ id: 'fine', at: NOW - HOUR });
    box.failGet.set('gone', () => new GoogleApiError('Gmail message failed (HTTP 404 notFound)', 404, 'notFound'));
    box.failGet.set('broken', () => new GoogleApiError('Gmail message returned no id or thread id', 200, 'unreadable_response'));
    box.override.set('weird', () => ({ id: 'weird', threadId: 't', labelIds: 5 as unknown as string[] }));
    const { sync: gmail } = sync();
    const result = await gmail.runNow();
    expect(result).toMatchObject({ status: 'completed', backlog: 0 });
    expect(result.counters).toMatchObject({ skipped: 1, failed: 2, emitted: 1 });
    expect(urls()).toEqual(['gmail://mail/fine']);
  });

  it('expired history falls back to a full sync from the newest captured message, bounded to 7 days', async () => {
    box.add({ id: 'e1', at: NOW - 3 * HOUR });
    box.add({ id: 'e2', at: NOW - 2 * HOUR });
    const { sync: gmail } = sync();
    await gmail.runNow();
    const lastAt = Date.parse(setting<string>('gmail_sync.last_message_at')!);
    expect(lastAt).toBe(NOW - 2 * HOUR);

    box.historyExpired = true;
    clock = NOW + 2 * 24 * HOUR;
    box.add({ id: 'late', at: clock - HOUR });
    box.calls.get.length = 0;
    const result = await gmail.runNow();
    expect(result).toMatchObject({ status: 'completed', mode: 'full' });
    expect(box.calls.list.at(-1)).toBe(`after:${Math.floor((lastAt - 5 * 60_000) / 1000)} ${EXCLUSIONS}`);
    // The re-listed newest message was already stored: deduplicated, not fetched.
    expect(result.counters).toMatchObject({ listed: 2, duplicates: 1, emitted: 1 });
    expect(box.calls.get).toEqual(['late']);
    expect(setting('gmail_sync.history_id')).toBe(box.historyId);

    setSetting(storage.getDb(), 'gmail_sync.last_message_at', new Date(clock - 10 * 24 * HOUR).toISOString());
    await gmail.runNow();
    expect(box.calls.list.at(-1)).toBe(`after:${Math.floor((clock - 7 * 24 * HOUR) / 1000)} ${EXCLUSIONS}`);
  });

  it('resumes a capped history read after the last record it read', async () => {
    const { sync: gmail } = sync({ maxHistoryPages: 1 });
    await gmail.runNow(); // empty mailbox: cursor only
    box.pageSize = 2;
    for (let index = 1; index <= 5; index++) box.add({ id: `h${index}`, at: NOW + index * 1000 });
    await gmail.runNow();
    expect(urls()).toEqual(['gmail://mail/h1', 'gmail://mail/h2']);
    await gmail.runNow();
    await gmail.runNow();
    expect(urls()).toEqual(['h1', 'h2', 'h3', 'h4', 'h5'].map(id => `gmail://mail/${id}`));
    expect(setting('gmail_sync.history_id')).toBe(box.historyId);
    expect(box.calls.get).toEqual(['h1', 'h2', 'h3', 'h4', 'h5']);
  });

  it('starts over for a different account, at runtime or after a restart, and skips when disconnected', async () => {
    seedFirstConnectMailbox();
    const first = sync();
    await first.sync.runNow();
    expect(setting('gmail_sync.history_id')).toBeTruthy();

    first.setAccount('someone.else@gmail.com');
    expect(setting('gmail_sync.account')).toBe('someone.else@gmail.com');
    expect(setting('gmail_sync.history_id')).toBeNull();
    expect(setting('gmail_sync.backlog')).toEqual([]);
    expect(setting('gmail_sync.mail_active')).toBe(false);

    // A restart with a stored cursor for another account also starts over.
    setSetting(storage.getDb(), 'gmail_sync.account', 'stale@gmail.com');
    setSetting(storage.getDb(), 'gmail_sync.history_id', '1');
    const restarted = sync();
    expect((await restarted.sync.runNow()).mode).toBe('full');
    expect(setting('gmail_sync.account')).toBe(OWNER);

    restarted.setAccount(null);
    expect(await restarted.sync.runNow()).toMatchObject({ status: 'skipped', reason: 'Gmail is not connected' });
  });

  it('a paused sync contacts no one; settings are validated and noise patterns apply', async () => {
    box.add({ id: 'shop', at: NOW - HOUR, from: 'Deals <hello@shop.example>' });
    const { sync: gmail } = sync();
    gmail.updateConfig({ enabled: false });
    expect(await gmail.runNow()).toMatchObject({ status: 'skipped', reason: 'gmail_sync.enabled is false' });
    expect(box.calls.profile + box.calls.list.length + box.calls.get.length).toBe(0);
    expect(() => gmail.updateConfig({ enabled: 'yes' as unknown as boolean })).toThrow('enabled must be a boolean');

    const status = gmail.updateConfig({ enabled: true, noiseSenders: ['  Shop.Example ', 'x'] });
    expect(status.noiseSenders).toEqual(['shop.example']);
    const result = await gmail.runNow();
    expect(result.counters).toMatchObject({ noise: 1, emitted: 0 });
  });

  it('paces message reads', async () => {
    for (let index = 1; index <= 3; index++) box.add({ id: `p${index}`, at: NOW - index * HOUR });
    const { sync: gmail } = sync({ getIntervalMs: 25 });
    const started = Date.now();
    await gmail.runNow();
    expect(Date.now() - started).toBeGreaterThanOrEqual(45);
    expect(emitted).toHaveLength(3);
  });

  // ── Older-mail import (GMAIL_API_INTEGRATION_PLAN.md §12) ──

  const DAY = 24 * HOUR;
  const sixMonthsBefore = (at: number) => {
    const start = new Date(at);
    start.setUTCMonth(start.getUTCMonth() - 6);
    return start.getTime();
  };
  const importQuery = (at: number) => `after:${Math.floor(sixMonthsBefore(at) / 1000)} ${EXCLUSIONS}`;

  it('imports the last 6 months after new mail: one listing, oldest first, stored mail skipped, then done', async () => {
    box.add({ id: 'ancient', at: NOW - 200 * DAY });
    box.add({ id: 'o2', at: NOW - 90 * DAY });
    box.add({ id: 'o1', at: NOW - 40 * DAY });
    box.add({ id: 'recent', at: NOW - 2 * HOUR });
    const { sync: gmail } = sync({ maxMessagesPerRun: 2 });
    await gmail.runNow(); // first connect: the last 30 days only
    expect(urls()).toEqual(['gmail://mail/recent']);

    const requested = gmail.requestImport({ months: 6 });
    expect(requested.import).toMatchObject({ status: 'requested', months: 6, total: 0, checked: 0 });

    box.add({ id: 'new1', at: NOW + 60_000 });
    clock = NOW + 5 * 60_000;
    box.calls.get.length = 0;
    const first = await gmail.runNow();
    // New mail spent its share of the budget first; the import got the rest.
    expect(box.calls.get).toEqual(['new1', 'o2']);
    expect(box.calls.list.filter(query => query === importQuery(clock))).toHaveLength(1);
    expect(first.import).toEqual({ checked: 1, captured: 1, left: 3 });
    expect(setting('gmail_sync.import_ids')).toEqual(['o2', 'o1', 'recent', 'new1']);
    expect(gmail.getStatus().import).toMatchObject({
      status: 'importing', total: 4, checked: 1, captured: 1, sinceIso: new Date(sixMonthsBefore(clock)).toISOString(), truncated: false,
    });

    const second = await gmail.runNow();
    expect(box.calls.get).toEqual(['new1', 'o2', 'o1']);
    expect(second.import).toEqual({ checked: 3, captured: 1, left: 0 });
    expect(urls()).toEqual(['recent', 'new1', 'o2', 'o1'].map(id => `gmail://mail/${id}`));
    expect(gmail.getStatus().import).toMatchObject({ status: 'done', total: 4, checked: 4, captured: 2, duplicates: 2, filtered: 0 });
    expect(gmail.getStatus().import?.finishedAt).toBe(new Date(clock).toISOString());
    expect(setting('gmail_sync.import_ids')).toEqual([]);

    // Done means done: later runs fetch nothing for it, and it may run again.
    await gmail.runNow();
    expect(box.calls.get).toEqual(['new1', 'o2', 'o1']);
    expect(box.calls.list.filter(query => query.includes('after:'))).toHaveLength(2);
    expect(gmail.requestImport({ months: 6 }).import?.status).toBe('requested');
  });

  it('counts filtered mail and resumes after a failed fetch at the same position', async () => {
    box.add({ id: 'a1', at: NOW - 100 * DAY, from: 'Shop <no-reply@shop.example.com>' });
    box.add({ id: 'a2', at: NOW - 90 * DAY });
    box.add({ id: 'a3', at: NOW - 80 * DAY, to: 'everyone@example.com' });
    box.add({ id: 'a4', at: NOW - 70 * DAY });
    const { sync: gmail } = sync();
    await gmail.runNow();
    gmail.requestImport({ months: 6 });
    box.failGet.set('a2', () => new GoogleApiError('Gmail message failed: network error (ECONNRESET)', 0, 'network'));
    const failed = await gmail.runNow();
    expect(failed).toMatchObject({ status: 'failed', reason: 'Gmail message failed: network error (ECONNRESET)' });
    expect(gmail.getStatus().import).toMatchObject({ status: 'importing', total: 4, checked: 1, filtered: 1, captured: 0 });

    box.failGet.clear();
    const resumed = await gmail.runNow();
    expect(resumed.status).toBe('completed');
    expect(gmail.getStatus().import).toMatchObject({ status: 'done', checked: 4, captured: 2, filtered: 2 });
    expect(urls()).toEqual(['gmail://mail/a2', 'gmail://mail/a4']);
    expect(box.calls.get.filter(id => id === 'a2')).toHaveLength(2);
    expect(box.calls.get.filter(id => id === 'a1')).toHaveLength(1);
  });

  it('stops on request, even mid-listing, and never writes progress back over the stop', async () => {
    for (let index = 1; index <= 4; index++) box.add({ id: `s${index}`, at: NOW - (100 + index) * DAY });
    const { sync: gmail } = sync({ maxMessagesPerRun: 1 });
    await gmail.runNow();
    gmail.requestImport({ months: 6 });
    await gmail.runNow();
    expect(gmail.getStatus().import).toMatchObject({ status: 'importing', checked: 1 });

    const stopped = gmail.stopImport();
    expect(stopped.import).toMatchObject({ status: 'stopped', checked: 1, total: 4 });
    expect(setting('gmail_sync.import_ids')).toEqual([]);
    const gets = box.calls.get.length;
    await gmail.runNow();
    expect(box.calls.get).toHaveLength(gets);
    expect(gmail.getStatus().import?.status).toBe('stopped');

    // A stop while the window is being listed wins over the listing.
    gmail.requestImport({ months: 6 });
    let release!: () => void;
    box.listGate = new Promise<void>(resolve => { release = resolve; });
    const running = gmail.runNow();
    await vi.waitFor(() => expect(box.calls.list.filter(query => query === importQuery(clock)).length).toBe(2));
    gmail.stopImport();
    release();
    await running;
    box.listGate = null;
    expect(gmail.getStatus().import).toMatchObject({ status: 'stopped', total: 0 });
    expect(setting('gmail_sync.import_ids')).toEqual([]);

    // So does a stop while a message is being fetched.
    gmail.requestImport({ months: 6 });
    await gmail.runNow(); // lists the window, decides one message
    const before = box.calls.get.length;
    let releaseGet!: () => void;
    box.getGate = new Promise<void>(resolve => { releaseGet = resolve; });
    const deciding = gmail.runNow();
    await vi.waitFor(() => expect(box.calls.get).toHaveLength(before + 1));
    gmail.stopImport();
    releaseGet();
    await deciding;
    box.getGate = null;
    expect(gmail.getStatus().import?.status).toBe('stopped');
    expect(setting('gmail_sync.import_ids')).toEqual([]);
  });

  it('refuses another window, a disconnected mailbox, and a second import; a new account clears it', async () => {
    const { sync: gmail, setAccount } = sync();
    for (const months of [3, 12, '6', undefined]) {
      expect(() => gmail.requestImport({ months })).toThrow(expect.objectContaining({ code: 'invalid_window' }));
    }
    gmail.requestImport({ months: 6 });
    expect(() => gmail.requestImport({ months: 6 })).toThrow(expect.objectContaining({ code: 'import_active' }));
    expect(gmail.stopImport().import?.status).toBe('stopped');
    expect(gmail.stopImport().import?.status).toBe('stopped');

    gmail.requestImport({ months: 6 });
    setAccount('someone.else@gmail.com');
    expect(gmail.getStatus().import).toBeNull();
    expect(setting('gmail_sync.import')).toBeNull();

    const disconnected = sync({}, null);
    expect(() => disconnected.sync.requestImport({ months: 6 })).toThrow(expect.objectContaining({ code: 'not_connected' }));
  });

  it('keeps only the newest 10,000 ids of a huge window and says so', async () => {
    box.pageSize = 2;
    for (let index = 1; index <= 5; index++) box.add({ id: `w${index}`, at: NOW - (40 + index) * DAY });
    const { sync: gmail } = sync({ maxImportListPages: 2, maxMessagesPerRun: 0 });
    await gmail.runNow();
    gmail.requestImport({ months: 6 });
    await gmail.runNow();
    // Two pages of two: the newest four, oldest first; the oldest (w5) is left out.
    expect(setting('gmail_sync.import_ids')).toEqual(['w4', 'w3', 'w2', 'w1']);
    expect(gmail.getStatus().import).toMatchObject({ status: 'importing', total: 4, truncated: true });
  });

  it('runs every minute while an import has work left, and only once the sync is started', async () => {
    vi.useFakeTimers({ now: NOW });
    try {
      for (let index = 1; index <= 3; index++) box.add({ id: `f${index}`, at: NOW - (100 + index) * DAY });
      const { sync: gmail } = sync({ maxMessagesPerRun: 1, intervalMs: 60 * 60_000, initialDelayMs: 60 * 60_000, importIntervalMs: 60_000 });
      await gmail.runNow();
      gmail.requestImport({ months: 6 });
      await vi.advanceTimersByTimeAsync(5_000);
      expect(gmail.getStatus().import?.status).toBe('requested'); // not started: nothing scheduled

      gmail.start();
      gmail.stopImport();
      gmail.requestImport({ months: 6 });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(gmail.getStatus().import).toMatchObject({ status: 'importing', checked: 1 });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(gmail.getStatus().import).toMatchObject({ checked: 2 });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(gmail.getStatus().import).toMatchObject({ status: 'done', checked: 3 });
      const gets = box.calls.get.length;
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      expect(box.calls.get).toHaveLength(gets); // done: back to the hourly cadence of this test
      gmail.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('suppresses browser Gmail scrapes only while an enabled API sync has completed a run', () => {
    const db = storage.getDb();
    expect(createGmailBrowserCaptureGate(db)()).toBe(false);
    setSetting(db, 'gmail_sync.mail_active', true);
    expect(createGmailBrowserCaptureGate(db)()).toBe(true);
    setSetting(db, 'gmail_sync.enabled', false);
    expect(createGmailBrowserCaptureGate(db)()).toBe(false);

    const browserMail = { source: 'browser', type: 'email_read', url: 'https://mail.google.com/mail/u/0/#inbox/abc', title: 'x', capturedAt: new Date() } as RawWorkItem;
    expect(isGmailWebEmailItem(browserMail)).toBe(true);
    expect(isGmailWebEmailItem({ ...browserMail, url: 'https://outlook.office.com/mail/' })).toBe(false);
    expect(isGmailWebEmailItem({ ...browserMail, type: 'website_visit' } as RawWorkItem)).toBe(false);
    expect(isGmailWebEmailItem({ ...browserMail, source: 'gmail' } as RawWorkItem)).toBe(false);
  });
});
