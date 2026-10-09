import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createStorage, getSetting, type StorageLayer } from '../core/storage.js';
import type { RawWorkItem } from '../core/types.js';
import { GMAIL_READONLY_SCOPE, type GoogleEndpoints } from '../core/gmail-api.js';
import { createGmailConnection } from '../core/gmail-connection.js';
import { createGmailCredentialStore } from '../core/gmail-credentials.js';
import { createGmailSync } from './gmail-sync.js';

/**
 * End to end over the real connection, REST client, and sync against an
 * in-process fake of Google's OAuth and Gmail HTTP endpoints: connect →
 * full sync → partial sync → token refresh → early-expired token → revoked
 * grant → same-account reconnect → disconnect.
 */
const ENDPOINTS: GoogleEndpoints = {
  authUrl: 'https://accounts.test/o/oauth2/v2/auth',
  tokenUrl: 'https://oauth.test/token',
  revokeUrl: 'https://oauth.test/revoke',
  apiBase: 'https://gmail.test',
};
const CLIENT = { clientId: '1234567890-abcdefghijkl.apps.googleusercontent.com', clientSecret: 'GOCSPX-e2e-secret' };
const OWNER = 'jane.doe@gmail.com';
const HOUR = 3_600_000;
const START = Date.parse('2026-10-05T12:00:00Z');

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function fakeGoogle() {
  const messages = new Map<string, any>();
  const history: Array<{ id: string; messagesAdded: Array<{ message: any }> }> = [];
  let historyId = 5000;
  let issued = 0;
  let refreshTokens = 0;
  const validAccess = new Set<string>();
  const validRefresh = new Set<string>();
  const google = {
    historyExpired: false,
    revokes: [] as string[],
    tokenGrants: [] as string[],
    bearer: [] as string[],
    add(id: string, at: number, headers: Record<string, string>, labels = ['INBOX', 'UNREAD']) {
      const message = {
        id, threadId: `t-${id}`, labelIds: labels, internalDate: String(at),
        payload: {
          mimeType: 'text/plain',
          headers: Object.entries(headers).map(([name, value]) => ({ name, value })),
          body: { data: Buffer.from(`Body of ${id}`).toString('base64url') },
        },
      };
      messages.set(id, message);
      historyId += 2;
      history.push({ id: String(historyId), messagesAdded: [{ message: { id, threadId: message.threadId, labelIds: labels } }] });
    },
    expireAccessTokens() { validAccess.clear(); },
    revokeEverything() { validAccess.clear(); validRefresh.clear(); },
    fetch: async (input: string, init?: RequestInit): Promise<Response> => {
      const url = new URL(input);
      const form = typeof init?.body === 'string' ? Object.fromEntries(new URLSearchParams(init.body)) : {};
      if (input === ENDPOINTS.tokenUrl) {
        if (form.client_id !== CLIENT.clientId || form.client_secret !== CLIENT.clientSecret) return json({ error: 'invalid_client' }, 401);
        google.tokenGrants.push(form.grant_type);
        if (form.grant_type === 'authorization_code') {
          const refresh = `ref-${++refreshTokens}`;
          validRefresh.add(refresh);
          const access = `acc-${++issued}`;
          validAccess.add(access);
          return json({ access_token: access, refresh_token: refresh, expires_in: 3600, scope: GMAIL_READONLY_SCOPE });
        }
        if (!validRefresh.has(form.refresh_token)) return json({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }, 400);
        const access = `acc-${++issued}`;
        validAccess.add(access);
        return json({ access_token: access, expires_in: 3600, scope: GMAIL_READONLY_SCOPE });
      }
      if (input === ENDPOINTS.revokeUrl) {
        google.revokes.push(form.token);
        validRefresh.delete(form.token);
        return json({});
      }
      const token = String((init?.headers as Record<string, string>)?.Authorization ?? '').replace(/^Bearer /, '');
      google.bearer.push(token);
      if (!validAccess.has(token)) return json({ error: { code: 401, message: 'Invalid Credentials', errors: [{ reason: 'authError' }] } }, 401);
      const route = url.pathname.replace('/gmail/v1/users/me', '');
      if (route === '/profile') return json({ emailAddress: OWNER, historyId: String(historyId) });
      if (route === '/settings/sendAs') return json({ sendAs: [{ sendAsEmail: OWNER }] });
      if (route === '/messages') {
        const after = Number((url.searchParams.get('q') ?? '').match(/after:(\d+)/)?.[1] ?? 0) * 1000;
        const ids = [...messages.values()].filter(m => Number(m.internalDate) > after && !m.labelIds.includes('DRAFT'))
          .sort((a, b) => Number(b.internalDate) - Number(a.internalDate)).map(m => ({ id: m.id, threadId: m.threadId }));
        return json({ messages: ids });
      }
      if (route.startsWith('/messages/')) {
        const message = messages.get(decodeURIComponent(route.slice('/messages/'.length)));
        return message ? json(message) : json({ error: { code: 404, errors: [{ reason: 'notFound' }] } }, 404);
      }
      if (route === '/history') {
        if (google.historyExpired) return json({ error: { code: 404, errors: [{ reason: 'notFound' }] } }, 404);
        const start = Number(url.searchParams.get('startHistoryId'));
        return json({ history: history.filter(record => Number(record.id) > start), historyId: String(historyId) });
      }
      return json({ error: { code: 404 } }, 404);
    },
  };
  return google;
}

describe('Gmail end to end (fake Google over fetch)', () => {
  let storage: StorageLayer;
  let dir: string;
  let clock: number;

  beforeEach(() => {
    storage = createStorage(':memory:');
    storage.initialize();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ppt-gmail-e2e-'));
    clock = START;
  });
  afterEach(() => {
    storage.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('connects, syncs, refreshes, survives revocation with a reconnect, and disconnects cleanly', async () => {
    const google = fakeGoogle();
    const now = () => clock;
    const connection = createGmailConnection({
      redirectUri: 'http://127.0.0.1:7778/api/gmail-sync/oauth/callback',
      store: createGmailCredentialStore({ privateRoot: dir, builtInClient: null }),
      fetchImpl: google.fetch, endpoints: ENDPOINTS, now,
    });
    const emitted: RawWorkItem[] = [];
    const health = { reportSuccess: vi.fn(), reportFailure: vi.fn() };
    const sync = createGmailSync({
      db: storage.getDb(), connection, captureHealth: health, now, config: { getIntervalMs: 0 },
      emit: item => {
        emitted.push(item);
        storage.getDb().prepare("INSERT INTO work_items (id, type, source, title, url, captured_at) VALUES (?, ?, 'gmail', ?, ?, datetime('now'))")
          .run(`wi-${emitted.length}`, item.type, item.title, item.url);
      },
    });
    const setting = (key: string) => getSetting<unknown>(storage.getDb(), key);
    const connect = async (code: string) => {
      const { authUrl } = connection.beginConnect();
      return connection.completeConnect({ code, state: new URL(authUrl).searchParams.get('state') });
    };

    google.add('m1', START - 3 * HOUR, { Subject: 'Plan', From: 'Ann <ann@example.com>', To: OWNER });
    google.add('m2', START - 2 * HOUR, { Subject: 'Re: Plan', From: `Jane <${OWNER}>`, To: 'ann@example.com' }, ['SENT']);
    connection.saveClient(CLIENT);
    expect(await connect('code-1')).toEqual({ ok: true, accountEmail: OWNER, accountId: 'default' });

    // First sync: full, with the access token from the sign-in.
    const first = await sync.runNow();
    expect(first).toMatchObject({ status: 'completed', mode: 'full', counters: { emitted: 2, received: 1, sent: 1 } });
    expect(emitted.map(item => [item.url, item.type, item.source])).toEqual([
      ['gmail://mail/m1', 'email_read', 'gmail'],
      ['gmail://mail/m2', 'email_sent', 'gmail'],
    ]);
    expect(new Set(google.bearer)).toEqual(new Set(['acc-1']));

    // New mail: partial sync from the stored cursor.
    google.add('m3', START + 60_000, { Subject: 'Next', From: 'ann@example.com', To: OWNER });
    expect(await sync.runNow()).toMatchObject({ mode: 'partial', counters: { emitted: 1 } });

    // The access token aged out: one refresh, then the run proceeds.
    clock += 2 * HOUR;
    google.add('m4', clock - 60_000, { Subject: 'Later', From: 'ann@example.com', To: OWNER });
    expect(await sync.runNow()).toMatchObject({ status: 'completed', counters: { emitted: 1 } });
    expect(google.tokenGrants).toEqual(['authorization_code', 'refresh_token']);

    // Google drops the token early: the 401 triggers one refresh and a retry.
    google.expireAccessTokens();
    google.add('m5', clock, { Subject: 'Again', From: 'ann@example.com', To: OWNER });
    expect(await sync.runNow()).toMatchObject({ status: 'completed', counters: { emitted: 1 } });
    expect(google.tokenGrants).toEqual(['authorization_code', 'refresh_token', 'refresh_token']);

    // The owner removed BotBoy at Google: the run fails as a sign-in problem.
    google.revokeEverything();
    google.add('m6', clock + 1000, { Subject: 'Missed for now', From: 'ann@example.com', To: OWNER });
    const revoked = await sync.runNow();
    expect(revoked.status).toBe('failed');
    expect(revoked.reason).toContain('invalid_grant');
    // One refresh attempt for the whole run, then it stops.
    expect(google.tokenGrants).toEqual(['authorization_code', 'refresh_token', 'refresh_token', 'refresh_token']);
    expect(health.reportFailure).toHaveBeenLastCalledWith('gmail', expect.objectContaining({ kind: 'service_auth' }));
    expect(connection.status()).toMatchObject({ connected: true, needsReconnect: true });
    const cursorBeforeReconnect = setting('gmail_sync.history_id');

    // Reconnecting the same account keeps the cursor, revokes nothing, and catches up.
    expect(await connect('code-2')).toEqual({ ok: true, accountEmail: OWNER, accountId: 'default' });
    expect(google.revokes).toEqual([]);
    expect(setting('gmail_sync.history_id')).toBe(cursorBeforeReconnect);
    const caughtUp = await sync.runNow();
    expect(caughtUp).toMatchObject({ status: 'completed', mode: 'partial', counters: { emitted: 1 } });
    expect(emitted.map(item => item.url).at(-1)).toBe('gmail://mail/m6');
    expect(connection.status().needsReconnect).toBe(false);

    // Expired history: a bounded full sync, deduplicated against stored mail.
    google.historyExpired = true;
    google.add('m7', clock + 2000, { Subject: 'After expiry', From: 'ann@example.com', To: OWNER });
    const recovered = await sync.runNow();
    expect(recovered).toMatchObject({ status: 'completed', mode: 'full', counters: { emitted: 1 } });
    expect(recovered.counters.duplicates).toBeGreaterThan(0);
    google.historyExpired = false;

    // Disconnect revokes the grant at Google and starts the mailbox over.
    await connection.disconnect();
    expect(google.revokes).toEqual(['ref-2']);
    expect(setting('gmail_sync.history_id')).toBeNull();
    expect(setting('gmail_sync.mail_active')).toBe(false);
    expect(await sync.runNow()).toMatchObject({ status: 'skipped', reason: 'Gmail is not connected' });
    expect(new Set(emitted.map(item => item.url)).size).toBe(emitted.length);
  });
});
