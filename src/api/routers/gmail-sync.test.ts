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
const fakeFetch = async (input: string, init?: RequestInit): Promise<Response> => {
  const form = typeof init?.body === 'string' ? Object.fromEntries(new URLSearchParams(init.body)) : {};
  if (input === ENDPOINTS.tokenUrl && form.grant_type === 'authorization_code') {
    return json({ access_token: FAKE_ACCESS_TOKEN, refresh_token: FAKE_REFRESH_TOKEN, expires_in: 3600, scope: GMAIL_READONLY_SCOPE });
  }
  if (input === ENDPOINTS.revokeUrl) return json({});
  if (input.startsWith(`${ENDPOINTS.apiBase}/gmail/v1/users/me/profile`)) return json({ emailAddress: profileEmail, historyId: '77' });
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
    connection = createGmailConnection({ redirectUri: `http://127.0.0.1:7778/api${GMAIL_OAUTH_CALLBACK_PATH}`, store, fetchImpl: fakeFetch, endpoints: ENDPOINTS });
    profileEmail = 'jane.doe@gmail.com';
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
    expect(callback.status).toBe(302);
    expect(callback.headers.location).toBe(`${DASHBOARD}/#/connections/gmail-sync`);
    expect(callback.headers['referrer-policy']).toBe('no-referrer');
    expect(callback.headers['cache-control']).toBe('no-store');
    expect(connection.status()).toMatchObject({ connected: true, accountEmail: 'jane.doe@gmail.com' });
    expect(runNow).toHaveBeenCalledTimes(1);

    // A replayed callback changes nothing and starts nothing.
    const replay = await request(server).get(`/api${GMAIL_OAUTH_CALLBACK_PATH}`).query({ code: 'auth-code', state: 'replayed' });
    expect(replay.status).toBe(302);
    expect(connection.status().lastError).toMatch(/expired or was already used/);
    expect(runNow).toHaveBeenCalledTimes(1);

    // A callback carrying another site's Origin is refused outright.
    const foreign = await request(server).get(`/api${GMAIL_OAUTH_CALLBACK_PATH}`).set('Origin', 'https://evil.example').query({ code: 'x', state: 'y' });
    expect(foreign.status).toBe(403);
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
    await request(server).get(`/api${GMAIL_OAUTH_CALLBACK_PATH}`).set('Sec-Fetch-Site', 'cross-site').query({ code: 'auth-code-2', state }).expect(302);
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
      .query({ code: 'auth-code-3', state: new URL(again.body.authUrl).searchParams.get('state') }).expect(302);
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
