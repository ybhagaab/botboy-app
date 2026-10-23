import fs from 'fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'os';
import path from 'path';
import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createStorage, type StorageLayer } from '../../core/storage.js';
import { GMAIL_COMPOSE_SCOPE, GMAIL_READONLY_SCOPE, type GoogleEndpoints } from '../../core/gmail-api.js';
import { GCALENDAR_SCOPE, GDRIVE_FULL_SCOPE, GDRIVE_READONLY_SCOPE } from '../../core/gdrive-api.js';
import { createGmailConnection, type GmailConnection } from '../../core/gmail-connection.js';
import { createGmailCredentialStore } from '../../core/gmail-credentials.js';
import { createGmailSyncs, type GmailSyncs } from '../../monitors/gmail-sync.js';
import { createGmailSyncRouter, GMAIL_OAUTH_CALLBACK_PATH } from './gmail-sync.js';
import { GmailComposeError } from '../../core/gmail-compose.js';

/**
 * Connections → Gmail API: status is readable locally and never carries a
 * secret; every change requires the rendered same-origin owner page; the
 * OAuth callback is a cross-site top-level navigation proven by its state.
 */
const ENDPOINTS: GoogleEndpoints = {
  authUrl: 'https://accounts.test/o/oauth2/v2/auth',
  tokenUrl: 'https://oauth.test/token',
  revokeUrl: 'https://oauth.test/revoke',
  apiBase: 'https://gmail.test',
};
const CLIENT = { clientId: '1234567890-abcdefghijkl.apps.googleusercontent.com', clientSecret: 'GOCSPX-router-secret' };
const DASHBOARD = 'http://localhost:7778';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

// Token-shaped fakes are assembled at runtime so secret scanners never see a
// token-shaped literal in the source (same convention as sensitive-files.test.ts).
const FAKE_ACCESS_TOKEN = ['ya29', 'router-access-token-value-0123456789'].join('.');
const FAKE_REFRESH_TOKEN = ['1/', '/0', 'router-refresh-token-value-0123456789'].join('');

/** The address the fake Gmail profile reports (a second sign-in can switch it). */
let profileEmail = 'jane.doe@gmail.com';
/** What the fake token endpoint does with the next code exchanges. */
let exchangeMode: 'ok' | 'connect_timeout' | 'invalid_grant' | 'drive_all' | 'drive_read_only' | 'api_not_enabled' = 'ok';
const errno = (code: string) => Object.assign(new Error(`connect ${code}`), { code, syscall: 'connect' });
const fakeFetch = async (input: string, init?: RequestInit): Promise<Response> => {
  const form = typeof init?.body === 'string' ? Object.fromEntries(new URLSearchParams(init.body)) : {};
  if (input === ENDPOINTS.tokenUrl && form.grant_type === 'authorization_code') {
    // What Node threw for every fetch to Google on the owner's Mac: a failed connect to both addresses.
    if (exchangeMode === 'connect_timeout') {
      throw Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new AggregateError([errno('ETIMEDOUT'), errno('EHOSTUNREACH')], ''), { code: 'ETIMEDOUT' }) });
    }
    if (exchangeMode === 'invalid_grant') return json({ error: 'invalid_grant', error_description: 'Bad Request' }, 400);
    const scope = exchangeMode === 'drive_all'
      ? `${GMAIL_READONLY_SCOPE} ${GMAIL_COMPOSE_SCOPE} ${GDRIVE_FULL_SCOPE} ${GCALENDAR_SCOPE}`
      : exchangeMode === 'drive_read_only'
        ? `${GMAIL_READONLY_SCOPE} ${GMAIL_COMPOSE_SCOPE} ${GDRIVE_READONLY_SCOPE}`
        : GMAIL_READONLY_SCOPE;
    return json({ access_token: FAKE_ACCESS_TOKEN, refresh_token: FAKE_REFRESH_TOKEN, expires_in: 3600, scope });
  }
  if (input === ENDPOINTS.revokeUrl) return json({});
  if (input.startsWith(`${ENDPOINTS.apiBase}/gmail/v1/users/me/profile`)) {
    // Google's answer when the Gmail API is switched off in the OAuth client's Cloud project.
    if (exchangeMode === 'api_not_enabled') {
      return json({ error: { code: 403, message: 'Gmail API has not been used in project 1234567890 before or it is disabled.', errors: [{ reason: 'accessNotConfigured' }], status: 'PERMISSION_DENIED' } }, 403);
    }
    return json({ emailAddress: profileEmail, historyId: '77' });
  }
  return json({ error: { code: 404, message: 'not found' } }, 404);
};

describe('Gmail sync router', () => {
  let server: http.Server;
  let origin: string;
  let dir: string;
  let storage: StorageLayer;
  let connection: GmailConnection;
  let sync: GmailSyncs;
  let runNow: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ppt-gmail-router-'));
    storage = createStorage(':memory:');
    storage.initialize();
    // No built-in client: these routes are tested with a client the owner saves.
    const store = createGmailCredentialStore({ privateRoot: dir, builtInClient: null });
    connection = createGmailConnection({ redirectUri: `http://127.0.0.1:7778/api${GMAIL_OAUTH_CALLBACK_PATH}`, store, fetchImpl: fakeFetch, endpoints: ENDPOINTS, sleep: async () => {} });
    profileEmail = 'jane.doe@gmail.com';
    exchangeMode = 'ok';
    sync = createGmailSyncs({ db: storage.getDb(), connection, emit: () => {} });
    runNow = vi.spyOn(sync, 'runNow').mockResolvedValue({ status: 'skipped', counters: {} as any, backlog: 0, durationMs: 0 });
    const app = express();
    app.use(express.json());
    app.use('/api', createGmailSyncRouter({ nodeManager: {} as any, db: storage.getDb(), gmailConnection: connection, gmailSync: sync, dashboardOrigin: DASHBOARD } as any));
    server = http.createServer(app);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => {
      origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      resolve();
    }));
  });

  afterEach(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    storage.close();
    fs.rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  const owner = (call: request.Test) => call.set('Origin', origin).set('Sec-Fetch-Site', 'same-origin');

  async function connectThroughCallback() {
    await owner(request(server).put('/api/gmail-sync/client')).send(CLIENT).expect(200);
    const started = await owner(request(server).post('/api/gmail-sync/connect')).send({}).expect(200);
    const state = new URL(started.body.authUrl).searchParams.get('state');
    return request(server).get(`/api${GMAIL_OAUTH_CALLBACK_PATH}`)
      .set('Sec-Fetch-Site', 'cross-site')
      .query({ code: 'auth-code', state, scope: GMAIL_READONLY_SCOPE });
  }

  it('serves status without caching and never a secret or token, even when connected', async () => {
    const empty = await request(server).get('/api/gmail-sync/status');
    expect(empty.status).toBe(200);
    expect(empty.headers['cache-control']).toBe('no-store');
    expect(empty.body.status).toMatchObject({ enabled: true, connection: { clientConfigured: false, connected: false } });

    await connectThroughCallback();
    const connected = await request(server).get('/api/gmail-sync/status');
    expect(connected.body.status.connection).toMatchObject({ connected: true, accountEmail: 'jane.doe@gmail.com', clientIdSuffix: '…ghijkl' });
    expect(JSON.stringify(connected.body)).not.toMatch(/GOCSPX|router-secret|ya29\.|1\/\/0|refresh-token/);
  });

  it('accepts every change only from the same-origin owner page', async () => {
    const changes: Array<() => request.Test> = [
      () => request(server).put('/api/gmail-sync/client').send(CLIENT),
      () => request(server).delete('/api/gmail-sync/client'),
      () => request(server).post('/api/gmail-sync/connect').send({}),
      () => request(server).post('/api/gmail-sync/disconnect').send({}),
      () => request(server).put('/api/gmail-sync/config').send({ enabled: false }),
      () => request(server).post('/api/gmail-sync/run').send({}),
      () => request(server).post('/api/gmail-sync/import').send({ months: 6 }),
      () => request(server).delete('/api/gmail-sync/import'),
      () => request(server).put('/api/gmail-sync/accounts/default/label').send({ label: 'Work' }),
    ];
    for (const change of changes) {
      expect((await change()).status).toBe(403);
      expect((await change().set('Origin', origin)).status).toBe(403);
      expect((await change().set('Origin', 'http://evil.example').set('Sec-Fetch-Site', 'same-origin')).status).toBe(403);
    }
    expect(connection.status().clientConfigured).toBe(false);
    expect(sync.getStatus().enabled).toBe(true);
    expect(runNow).not.toHaveBeenCalled();
  });

  it('validates the OAuth client without echoing it and refuses unexpected fields', async () => {
    const extra = await owner(request(server).put('/api/gmail-sync/client')).send({ ...CLIENT, refreshToken: 'x' });
    expect(extra.status).toBe(400);
    expect(extra.body.code).toBe('invalid_request');
    const bad = await owner(request(server).put('/api/gmail-sync/client')).send({ clientId: 'not-a-client-id-secretish', clientSecret: CLIENT.clientSecret });
    expect(bad.status).toBe(400);
    expect(bad.body).toMatchObject({ code: 'invalid_client', field: 'clientId' });
    expect(JSON.stringify(bad.body)).not.toContain('secretish');

    const noClient = await owner(request(server).post('/api/gmail-sync/connect')).send({});
    expect(noClient.status).toBe(409);
    expect(noClient.body.code).toBe('not_connected');

    const saved = await owner(request(server).put('/api/gmail-sync/client')).send(CLIENT);
    expect(saved.status).toBe(200);
    expect(saved.body.status.connection).toMatchObject({ clientConfigured: true, connected: false });
    expect(JSON.stringify(saved.body)).not.toContain(CLIENT.clientSecret);
    expect(fs.statSync(path.join(dir, 'gmail.json')).mode & 0o777).toBe(0o600);
  });

  it('starts sign-in with a Google URL for this loopback callback', async () => {
    await owner(request(server).put('/api/gmail-sync/client')).send(CLIENT).expect(200);
    const started = await owner(request(server).post('/api/gmail-sync/connect')).send({});
    expect(started.status).toBe(200);
    expect(started.headers['cache-control']).toBe('no-store');
    const url = new URL(started.body.authUrl);
    expect(`${url.origin}${url.pathname}`).toBe(ENDPOINTS.authUrl);
    expect(url.searchParams.get('redirect_uri')).toBe(`http://127.0.0.1:7778/api${GMAIL_OAUTH_CALLBACK_PATH}`);
    expect(url.searchParams.get('scope')).toBe(`${GMAIL_READONLY_SCOPE} ${GMAIL_COMPOSE_SCOPE}`);
  });

  it('completes the cross-site callback, redirects to the Gmail page, and starts the first sync', async () => {
    const callback = await connectThroughCallback();
    // The callback page says plainly that it worked and sends the browser on to the Gmail page.
    expect(callback.status).toBe(200);
    expect(callback.headers['content-type']).toMatch(/text\/html/);
    expect(callback.text).toContain('Gmail connected');
    expect(callback.text).toContain(`location.replace(${JSON.stringify(`${DASHBOARD}/#/connections/gmail-sync`)})`);
    expect(callback.text).toContain(`href="${DASHBOARD}/#/connections/gmail-sync"`);
    expect(callback.headers['referrer-policy']).toBe('no-referrer');
    expect(callback.headers['cache-control']).toBe('no-store');
    expect(connection.status()).toMatchObject({ connected: true, accountEmail: 'jane.doe@gmail.com' });
    expect(runNow).toHaveBeenCalledTimes(1);

    // A callback that matches no sign-in changes nothing and starts nothing; it is a sign-in result, not a connection error.
    const replay = await request(server).get(`/api${GMAIL_OAUTH_CALLBACK_PATH}`).query({ code: 'auth-code', state: 'replayed' });
    expect(replay.status).toBe(400);
    expect(replay.text).toContain('expired or was already used');
    expect(replay.text).toContain('Use the link below to go back to Connections → Gmail, then start the sign-in again.');
    expect(replay.text).not.toMatch(/close this tab/i);
    expect(connection.status().lastError).toBeNull();
    expect(connection.status().pageSignIn).toMatchObject({ kind: 'state_expired', ok: false });
    expect(runNow).toHaveBeenCalledTimes(1);

    // A callback carrying another site's Origin is refused outright.
    const foreign = await request(server).get(`/api${GMAIL_OAUTH_CALLBACK_PATH}`).set('Origin', 'https://evil.example').query({ code: 'x', state: 'y' });
    expect(foreign.status).toBe(403);
  });

  /** Connects Gmail, then returns the callback of a Drive consent started from the owner page. */
  async function driveCallback(mode: typeof exchangeMode, extraQuery: Record<string, string> = {}) {
    await connectThroughCallback();
    const started = await owner(request(server).post('/api/gmail-sync/accounts/default/drive/connect')).send({}).expect(200);
    const state = new URL(started.body.authUrl).searchParams.get('state')!;
    exchangeMode = mode;
    return request(server).get(`/api${GMAIL_OAUTH_CALLBACK_PATH}`).set('Sec-Fetch-Site', 'cross-site')
      .query({ ...(extraQuery.error ? {} : { code: 'drive-code' }), state, ...extraQuery });
  }

  it('says plainly on the callback page that Drive was not connected, and to go back with the link and press the button again', async () => {
    const callback = await driveCallback('connect_timeout');
    expect(callback.status).toBe(502);
    expect(callback.text).toContain('Google Drive was not connected');
    expect(callback.text).toContain("Couldn&#39;t connect Google Drive: BotBoy couldn&#39;t reach Google (timed out on a slow route to Google). Your current Gmail connection is unchanged. Press Connect Google Drive to try again.");
    // Connect sent BotBoy's own window to Google, so this page is that window: the way back is the link, never "close the tab".
    expect(callback.text).toContain('Use the link below to go back to Connections → Gmail, then press Connect Google Drive again.');
    expect(callback.text).not.toMatch(/close this tab/i);
    expect(callback.text).toContain(`href="${DASHBOARD}/#/connections/gmail-sync"`);
    // A failure does not send the browser anywhere on its own, and starts no sync.
    expect(callback.text).not.toContain('<script>');
    expect(runNow).toHaveBeenCalledTimes(1);

    // Gmail is untouched and healthy; the Drive section carries the result.
    const status = (await request(server).get('/api/gmail-sync/status')).body.status;
    expect(status.connection).toMatchObject({ connected: true, needsReconnect: false, lastError: null, canReadDrive: false, signIn: { drive: { kind: 'network', ok: false } } });
    expect(status.accounts[0].connection.signIn.drive.message).toContain('Press Connect Google Drive to try again.');
    expect(JSON.stringify(status)).not.toMatch(/GOCSPX|router-secret|ya29\.|refresh-token/);
  });

  it('words the other outcomes of a Drive consent: connected, a box left unticked, cancelled', async () => {
    const connected = await driveCallback('drive_all');
    expect(connected.status).toBe(200);
    expect(connected.text).toContain('Google Drive connected');
    expect(connected.text).toContain('location.replace(');

    const partial = await driveCallback('drive_read_only');
    expect(partial.status).toBe(200);
    expect(partial.text).toContain('Google connected, but Drive was not allowed');
    expect(partial.text).toContain('Drive not granted in full: Google allowed reading Drive but not changing it.');
    expect(partial.text).toContain('Use the link below to go back to Connections → Gmail, then press Connect Google Drive again.');
    expect(partial.text).not.toMatch(/close this tab/i);
    expect(partial.text).not.toContain('<script>');
    // Gmail is connected either way, so the first sync starts.
    expect(runNow).toHaveBeenLastCalledWith('default');
  });

  it('tells the owner on the callback page to turn the Gmail API on, with the link back and no tab to close', async () => {
    await owner(request(server).put('/api/gmail-sync/client')).send(CLIENT).expect(200);
    const started = await owner(request(server).post('/api/gmail-sync/connect')).send({}).expect(200);
    const state = new URL(started.body.authUrl).searchParams.get('state');
    exchangeMode = 'api_not_enabled';
    const callback = await request(server).get(`/api${GMAIL_OAUTH_CALLBACK_PATH}`).set('Sec-Fetch-Site', 'cross-site').query({ code: 'auth-code', state });
    expect(callback.status).toBe(400);
    expect(callback.text).toContain('Gmail was not connected');
    expect(callback.text).toContain('Google says the Gmail API is turned off.');
    expect(callback.text).toContain('Enable the Gmail API in the same Google Cloud project as your OAuth client (APIs &amp; Services → Library → Gmail API), wait a minute, then press Connect Gmail to try again.');
    expect(callback.text).toContain('Use the link below to go back to Connections → Gmail, then press Connect Gmail (or Reconnect) again.');
    expect(callback.text).toContain(`href="${DASHBOARD}/#/connections/gmail-sync"`);
    expect(callback.text).not.toMatch(/close this tab/i);
    expect(callback.text).not.toContain('<script>');
    // Nothing was saved, nothing started, and the status carries the result for the page.
    expect(connection.isConnected()).toBe(false);
    expect(runNow).not.toHaveBeenCalled();
    expect(connection.status().pageSignIn).toMatchObject({ kind: 'api_not_enabled', ok: false });
  });

  it('says a cancelled or expired sign-in did not finish, and never prints what the browser sent', async () => {
    const cancelled = await driveCallback('ok', { error: 'access_denied' });
    expect(cancelled.status).toBe(400);
    expect(cancelled.text).toContain('Sign-in cancelled');
    expect(cancelled.text).toContain('Drive not granted: the Google sign-in was cancelled, so nothing changed.');

    const hostile = await request(server).get(`/api${GMAIL_OAUTH_CALLBACK_PATH}`).query({ error: '<script>alert(1)</script>', state: 'nope' });
    expect(hostile.status).toBe(400);
    expect(hostile.text).toContain('Sign-in did not finish');
    expect(hostile.text).toContain('Use the link below to go back to Connections → Gmail, then start the sign-in again.');
    expect(hostile.text).not.toContain('alert(1)');
    expect(hostile.text).not.toContain('<script>');

    // Reloading a callback that was already handled says so and records no new failure.
    const handled = await connectThroughCallback();
    expect(handled.status).toBe(200);
    const handledState = new URL(handled.request.url).searchParams.get('state')!;
    const before = (await request(server).get('/api/gmail-sync/status')).body.status.connection;
    const replay = await request(server).get(`/api${GMAIL_OAUTH_CALLBACK_PATH}`).set('Sec-Fetch-Site', 'cross-site')
      .query({ code: 'auth-code', state: handledState });
    expect(replay.status).toBe(400);
    expect(replay.text).toContain('This sign-in link was already used');
    const after = (await request(server).get('/api/gmail-sync/status')).body.status.connection;
    expect(after.pageSignIn).toEqual(before.pageSignIn);
    expect(after.signIn).toEqual(before.signIn);
  });

  it('dismisses one sign-in notice from the owner page only, with a strict body', async () => {
    await driveCallback('connect_timeout');
    expect(connection.status().signIn.drive).not.toBeNull();
    const dismiss = () => request(server).post('/api/gmail-sync/sign-in/dismiss').send({ accountId: 'default', action: 'drive_connect' });
    expect((await dismiss()).status).toBe(403);
    expect((await dismiss().set('Origin', origin)).status).toBe(403);
    expect((await dismiss().set('Origin', 'http://evil.example').set('Sec-Fetch-Site', 'same-origin')).status).toBe(403);
    expect(connection.status().signIn.drive).not.toBeNull();

    for (const body of [{ action: 'other' }, { accountId: '../x', action: 'drive_connect' }, { action: 'drive_connect', extra: 1 }, {}]) {
      const bad = await owner(request(server).post('/api/gmail-sync/sign-in/dismiss')).send(body);
      expect(bad.status, JSON.stringify(body)).toBe(400);
      expect(bad.body.code).toBe('invalid_request');
    }
    expect(connection.status().signIn.drive).not.toBeNull();

    const ok = await owner(request(server).post('/api/gmail-sync/sign-in/dismiss')).send({ accountId: 'default', action: 'drive_connect' });
    expect(ok.status).toBe(200);
    expect(ok.headers['cache-control']).toBe('no-store');
    expect(ok.body.status.connection.signIn.drive).toBeNull();
    expect(connection.status().signIn.drive).toBeNull();

    // The page-level notice (no account) is dismissed without an accountId.
    await request(server).get(`/api${GMAIL_OAUTH_CALLBACK_PATH}`).query({ code: 'x', state: 'forged' });
    expect(connection.status().pageSignIn).not.toBeNull();
    await owner(request(server).post('/api/gmail-sync/sign-in/dismiss')).send({ action: 'unknown' }).expect(200);
    expect(connection.status().pageSignIn).toBeNull();
  });

  it('starts and stops the older-mail import from the owner page, with a validated window', async () => {
    const notConnected = await owner(request(server).post('/api/gmail-sync/import')).send({ months: 6 });
    expect(notConnected.status).toBe(409);
    expect(notConnected.body.code).toBe('not_connected');

    await connectThroughCallback();
    const wrongWindow = await owner(request(server).post('/api/gmail-sync/import')).send({ months: 3 });
    expect(wrongWindow.status).toBe(400);
    expect(wrongWindow.body.code).toBe('invalid_window');
    const extra = await owner(request(server).post('/api/gmail-sync/import')).send({ months: 6, since: '2020-01-01' });
    expect(extra.status).toBe(400);
    expect(extra.body.code).toBe('invalid_request');

    const started = await owner(request(server).post('/api/gmail-sync/import')).send({ months: 6 });
    expect(started.status).toBe(200);
    expect(started.headers['cache-control']).toBe('no-store');
    expect(started.body.status.import).toMatchObject({ status: 'requested', months: 6 });
    const again = await owner(request(server).post('/api/gmail-sync/import')).send({ months: 6 });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('import_active');

    const stopped = await owner(request(server).delete('/api/gmail-sync/import'));
    expect(stopped.status).toBe(200);
    expect(stopped.body.status.import).toMatchObject({ status: 'stopped' });
    const status = await request(server).get('/api/gmail-sync/status');
    expect(status.body.status.import.status).toBe('stopped');
    expect(status.body.status.captured).toEqual({ total: 0, received: 0, sent: 0, inProjects: 0 });
  });

  it('disconnects, pauses, and runs from the owner page', async () => {
    await connectThroughCallback();
    const paused = await owner(request(server).put('/api/gmail-sync/config')).send({ enabled: false });
    expect(paused.status).toBe(200);
    expect(paused.body.status.enabled).toBe(false);
    const invalid = await owner(request(server).put('/api/gmail-sync/config')).send({ noiseSenders: 'nope' });
    expect(invalid.status).toBe(400);

    const ran = await owner(request(server).post('/api/gmail-sync/run')).send({});
    expect(ran.status).toBe(200);
    expect(runNow).toHaveBeenCalledTimes(2);

    const disconnected = await owner(request(server).post('/api/gmail-sync/disconnect')).send({});
    expect(disconnected.status).toBe(200);
    expect(disconnected.body.status.connection).toMatchObject({ connected: false, clientConfigured: true, accountEmail: null });
  });

  it('adds a second account, labels it, and disconnects one account, deleting its mail only when asked', async () => {
    await connectThroughCallback();
    profileEmail = 'me@company.com';
    const started = await owner(request(server).post('/api/gmail-sync/connect')).send({ addAccount: true }).expect(200);
    const state = new URL(started.body.authUrl).searchParams.get('state');
    await request(server).get(`/api${GMAIL_OAUTH_CALLBACK_PATH}`).set('Sec-Fetch-Site', 'cross-site').query({ code: 'auth-code-2', state }).expect(200);
    const accounts = (await request(server).get('/api/gmail-sync/status')).body.status.accounts;
    expect(accounts.map((account: any) => account.email)).toEqual(['jane.doe@gmail.com', 'me@company.com']);
    const workId = accounts[1].id;
    expect(workId).toMatch(/^ga_[a-f0-9]{10}$/);
    expect(runNow).toHaveBeenLastCalledWith(workId);

    // Body validation: unknown fields and malformed ids are refused before anything changes.
    expect((await owner(request(server).post('/api/gmail-sync/connect')).send({ accountId: '../x' })).status).toBe(400);
    expect((await owner(request(server).post('/api/gmail-sync/connect')).send({ addAccount: 'yes' })).status).toBe(400);
    expect((await owner(request(server).put('/api/gmail-sync/accounts/default/label')).send({ label: 'x', other: 1 })).status).toBe(400);
    expect((await owner(request(server).put('/api/gmail-sync/accounts/ga_9999999999/label')).send({ label: 'x' })).status).toBe(404);

    const labelled = await owner(request(server).put(`/api/gmail-sync/accounts/${workId}/label`)).send({ label: '  Work  ' }).expect(200);
    expect(labelled.body.status.accounts[1].label).toBe('Work');

    // Each account's captured rows: deleting the Work account's mail leaves Personal's alone.
    const db = storage.getDb();
    const insert = db.prepare("INSERT INTO work_items (id, type, source, url, title, raw_text, metadata, captured_at) VALUES (?, 'email_read', 'gmail', ?, 't', 'b', '{}', '2026-10-08T00:00:00Z')");
    insert.run('wi-p', 'gmail://mail/m1');
    insert.run('wi-w', `gmail://${workId}/mail/m1`);
    const kept = await owner(request(server).post('/api/gmail-sync/disconnect')).send({ accountId: workId }).expect(200);
    expect(kept.body.deletedMail).toBe(0);
    expect(db.prepare('SELECT id FROM work_items ORDER BY id').all()).toEqual([{ id: 'wi-p' }, { id: 'wi-w' }]);
    expect(kept.body.status.accounts.map((account: any) => account.email)).toEqual(['jane.doe@gmail.com']);

    // Reconnect Work, then disconnect it with its mail.
    const again = await owner(request(server).post('/api/gmail-sync/connect')).send({ addAccount: true }).expect(200);
    await request(server).get(`/api${GMAIL_OAUTH_CALLBACK_PATH}`).set('Sec-Fetch-Site', 'cross-site')
      .query({ code: 'auth-code-3', state: new URL(again.body.authUrl).searchParams.get('state') }).expect(200);
    const newWorkId = (await request(server).get('/api/gmail-sync/status')).body.status.accounts[1].id;
    db.prepare('UPDATE work_items SET url = ? WHERE id = ?').run(`gmail://${newWorkId}/mail/m1`, 'wi-w');
    expect((await owner(request(server).post('/api/gmail-sync/disconnect')).send({ accountId: newWorkId, deleteMail: 'yes' })).status).toBe(400);
    const deleted = await owner(request(server).post('/api/gmail-sync/disconnect')).send({ accountId: newWorkId, deleteMail: true }).expect(200);
    expect(deleted.body.deletedMail).toBe(1);
    expect(db.prepare('SELECT id FROM work_items ORDER BY id').all()).toEqual([{ id: 'wi-p' }]);
    expect((await owner(request(server).post('/api/gmail-sync/disconnect')).send({ accountId: newWorkId })).status).toBe(404);
  });
});

/**
 * Chat draft card routes (GMAIL_CHAT_TOOLS_PLAN.md §7): viewing is a local
 * read; Send and Discard are same-origin owner clicks that name the exact
 * version shown; compose failures keep their code, effect, and next action.
 */
describe('Gmail draft card routes', () => {
  let server: http.Server;
  let origin: string;
  const view = (overrides: Record<string, unknown> = {}) => ({
    state: 'draft', draftId: 'r-1', account: 'owner@gmail.com', messageId: 'm-2', threadId: 't-1', to: ['jane@x.com'], cc: [], bcc: [],
    subject: 'Late', body: 'Running late.', bodyTruncated: false, updatedAt: '2026-10-06T09:00:00.000Z', gmailUrl: 'https://mail.google.com/mail/u/owner@gmail.com/#drafts',
    ...overrides,
  });
  const compose = {
    viewDraft: vi.fn(async (_draftId: string) => view()),
    sendDraftFromCard: vi.fn(async (_draftId: string, _messageId: string) => ({
      status: 'sent', messageId: 'm-9', threadId: 't-1', account: 'owner@gmail.com', to: ['jane@x.com'], cc: [], bcc: [], subject: 'Late',
      labelIds: ['SENT'], verified: true, sentAt: '2026-10-06T09:01:00.000Z', via: 'card', fromDraftId: 'r-1', gmailUrl: 'https://mail.google.com/mail/u/owner@gmail.com/#all/t-1',
    })),
    discardDraft: vi.fn(async (_draftId: string, _messageId: string) => view({ state: 'discarded' })),
    saveDraft: vi.fn(),
    send: vi.fn(),
  };

  beforeEach(async () => {
    for (const fn of Object.values(compose)) fn.mockClear();
    const app = express();
    app.use(express.json());
    app.use('/api', createGmailSyncRouter({ nodeManager: {} as any, gmailCompose: compose as any }));
    server = http.createServer(app);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => {
      origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      resolve();
    }));
  });
  afterEach(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
  });

  const owner = (call: request.Test) => call.set('Origin', origin).set('Sec-Fetch-Site', 'same-origin');

  it('shows a BotBoy draft to a local reader without caching and refuses malformed ids', async () => {
    const shown = await request(server).get('/api/gmail-sync/drafts/r-1');
    expect(shown.status).toBe(200);
    expect(shown.headers['cache-control']).toBe('no-store');
    expect(shown.body.draft).toMatchObject({ state: 'draft', messageId: 'm-2' });
    expect(compose.viewDraft).toHaveBeenCalledWith('r-1');
    expect((await request(server).get('/api/gmail-sync/drafts/r%2F..')).status).toBe(400);
    expect((await request(server).get('/api/gmail-sync/drafts/r-1').set('Origin', 'https://evil.example')).status).toBe(403);
    // A DNS-rebinding page reaches loopback without an Origin, but its Host names the attacker.
    const rebound = await request(server).get('/api/gmail-sync/drafts/r-1').set('Host', 'attacker.example:7778');
    expect(rebound.status).toBe(403);
    expect(JSON.stringify(rebound.body)).not.toContain('Running late');
    expect((await request(server).get('/api/gmail-sync/drafts/r-1').set('Host', 'localhost:7778')).status).toBe(200);
  });

  it('sends and discards only from the same-origin owner page, naming the version shown', async () => {
    for (const action of ['send', 'discard']) {
      const url = `/api/gmail-sync/drafts/r-1/${action}`;
      expect((await request(server).post(url).send({ messageId: 'm-2' })).status).toBe(403);
      expect((await request(server).post(url).set('Origin', origin).send({ messageId: 'm-2' })).status).toBe(403);
      expect((await request(server).post(url).set('Origin', 'http://evil.example').set('Sec-Fetch-Site', 'same-origin').send({ messageId: 'm-2' })).status).toBe(403);
      const unnamed = await owner(request(server).post(url)).send({});
      expect(unnamed.status).toBe(400);
      expect(unnamed.body).toMatchObject({ code: 'invalid_request', effect: 'none' });
    }
    expect(compose.sendDraftFromCard).not.toHaveBeenCalled();
    expect(compose.discardDraft).not.toHaveBeenCalled();

    compose.viewDraft.mockResolvedValueOnce(view({ state: 'sent', sentMessageId: 'm-9', sentAt: '2026-10-06T09:01:00.000Z' }));
    const sent = await owner(request(server).post('/api/gmail-sync/drafts/r-1/send')).send({ messageId: 'm-2' });
    expect(sent.status).toBe(200);
    expect(compose.sendDraftFromCard).toHaveBeenCalledWith('r-1', 'm-2');
    expect(sent.body).toMatchObject({ receipt: { status: 'sent', messageId: 'm-9' }, draft: { state: 'sent' } });

    const discarded = await owner(request(server).post('/api/gmail-sync/drafts/r-1/discard')).send({ messageId: 'm-2' });
    expect(discarded.status).toBe(200);
    expect(compose.discardDraft).toHaveBeenCalledWith('r-1', 'm-2');
    expect(discarded.body.draft.state).toBe('discarded');
  });

  it('reports a changed draft with its new version, an unanswered send as unknown, and a sent draft even if the re-read fails', async () => {
    compose.sendDraftFromCard.mockRejectedValueOnce(new GmailComposeError('draft_changed', 'The draft changed since it was shown.', 'none', [], undefined, { view: view({ messageId: 'm-3', body: 'New text' }) }));
    const changed = await owner(request(server).post('/api/gmail-sync/drafts/r-1/send')).send({ messageId: 'm-2' });
    expect(changed.status).toBe(409);
    expect(changed.body).toMatchObject({ code: 'draft_changed', effect: 'none', draft: { messageId: 'm-3', body: 'New text' } });

    compose.sendDraftFromCard.mockRejectedValueOnce(new GmailComposeError('send_unknown_effect', 'Gmail draft send timed out after 30s. Gmail may or may not have done it.', 'unknown'));
    const unknown = await owner(request(server).post('/api/gmail-sync/drafts/r-1/send')).send({ messageId: 'm-2' });
    expect(unknown.status).toBe(504);
    expect(unknown.body).toMatchObject({ code: 'send_unknown_effect', effect: 'unknown' });
    expect(unknown.body.nextAction).toMatch(/Do NOT send again/);

    compose.viewDraft.mockRejectedValueOnce(new Error('settings read failed'));
    const sentAnyway = await owner(request(server).post('/api/gmail-sync/drafts/r-1/send')).send({ messageId: 'm-2' });
    expect(sentAnyway.status).toBe(200);
    expect(sentAnyway.body.draft).toMatchObject({ state: 'sent', sentMessageId: 'm-9', to: ['jane@x.com'], attachments: [] });

    // With files, the fallback view still lists what was sent (names, types, sizes only).
    const receipt = await compose.sendDraftFromCard('r-1', 'm-2');
    compose.sendDraftFromCard.mockResolvedValueOnce({ ...receipt, attachments: [{ name: 'a.csv', mimeType: 'text/csv', sizeBytes: 4, sha256: 'f'.repeat(64), from: '/Users/someone/a.csv' }] });
    compose.viewDraft.mockRejectedValueOnce(new Error('settings read failed'));
    const withFiles = await owner(request(server).post('/api/gmail-sync/drafts/r-1/send')).send({ messageId: 'm-2' });
    expect(withFiles.body.draft.attachments).toEqual([{ name: 'a.csv', mimeType: 'text/csv', sizeBytes: 4 }]);

    compose.discardDraft.mockRejectedValueOnce(new Error('boom'));
    const crashed = await owner(request(server).post('/api/gmail-sync/drafts/r-1/discard')).send({ messageId: 'm-2' });
    expect(crashed.status).toBe(500);
    expect(crashed.body).toMatchObject({ code: 'internal_error' });
    expect(JSON.stringify(crashed.body)).not.toContain('boom');
  });
});
