import { createHash } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GMAIL_COMPOSE_SCOPE, GMAIL_READONLY_SCOPE, type GoogleEndpoints } from './gmail-api.js';
import { createGmailConnection, GmailAuthError } from './gmail-connection.js';
import { createGmailCredentialStore, GmailCredentialInputError, validateGmailClient } from './gmail-credentials.js';

const CLIENT = { clientId: '1234567890-abcdefghijkl.apps.googleusercontent.com', clientSecret: 'GOCSPX-test-secret-value' };
const OTHER_CLIENT = { clientId: '9876543210-zyxwvutsrqpo.apps.googleusercontent.com', clientSecret: 'GOCSPX-other-secret-value' };
const ENDPOINTS: GoogleEndpoints = {
  authUrl: 'https://accounts.test/o/oauth2/v2/auth',
  tokenUrl: 'https://oauth.test/token',
  revokeUrl: 'https://oauth.test/revoke',
  apiBase: 'https://gmail.test',
};
const REDIRECT = 'http://127.0.0.1:7778/api/gmail-sync/oauth/callback';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** A scripted Google: token grants, refreshes, revokes, and the Gmail profile. */
function fakeGoogle() {
  const calls: Array<{ url: string; form: Record<string, string>; auth?: string }> = [];
  const google = {
    calls,
    account: 'Jane.Doe@gmail.com',
    grantScope: GMAIL_READONLY_SCOPE,
    grantRefreshToken: 'refresh-1' as string | undefined,
    refreshError: '' as string,
    refreshDelayMs: 0,
    issued: 0,
    fetch: async (input: string, init?: RequestInit): Promise<Response> => {
      const form = typeof init?.body === 'string' ? Object.fromEntries(new URLSearchParams(init.body)) : {};
      const auth = (init?.headers as Record<string, string> | undefined)?.Authorization;
      calls.push({ url: input, form, auth });
      if (input === ENDPOINTS.tokenUrl && form.grant_type === 'authorization_code') {
        google.issued++;
        return json({
          access_token: `access-${google.issued}`, expires_in: 3600, scope: google.grantScope, token_type: 'Bearer',
          ...(google.grantRefreshToken ? { refresh_token: google.grantRefreshToken } : {}),
        });
      }
      if (input === ENDPOINTS.tokenUrl && form.grant_type === 'refresh_token') {
        if (google.refreshDelayMs) await new Promise(resolve => setTimeout(resolve, google.refreshDelayMs));
        if (google.refreshError) return json({ error: google.refreshError, error_description: 'Token has been expired or revoked.' }, 400);
        google.issued++;
        return json({ access_token: `access-${google.issued}`, expires_in: 3600, scope: GMAIL_READONLY_SCOPE });
      }
      if (input === ENDPOINTS.revokeUrl) return json({});
      if (input.startsWith(`${ENDPOINTS.apiBase}/gmail/v1/users/me/profile`)) {
        return json({ emailAddress: google.account, historyId: '4242', messagesTotal: 10 });
      }
      return json({ error: { code: 404, message: 'not found' } }, 404);
    },
  };
  return google;
}

function queryOf(url: string): URLSearchParams {
  return new URL(url).searchParams;
}

describe('Gmail credential store', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ppt-gmail-store-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('writes an owner-only schema-1 file and keeps a connection only for the same client', () => {
    const store = createGmailCredentialStore({ privateRoot: dir });
    store.saveClient(CLIENT);
    expect(fs.statSync(store.file).mode & 0o777).toBe(0o600);
    store.saveConnection({ refreshToken: 'refresh-1', accountEmail: 'jane.doe@gmail.com', scope: GMAIL_READONLY_SCOPE });
    const reread = createGmailCredentialStore({ privateRoot: dir }).read();
    expect(reread).toMatchObject({ schemaVersion: 1, client: CLIENT, connection: { refreshToken: 'refresh-1', accountEmail: 'jane.doe@gmail.com' } });

    store.saveClient(CLIENT);
    expect(store.read().connection?.refreshToken).toBe('refresh-1');
    store.saveClient(OTHER_CLIENT);
    expect(store.read().connection).toBeUndefined();
    expect(createGmailCredentialStore({ privateRoot: dir }).read().connection).toBeUndefined();

    store.clearAll();
    expect(fs.existsSync(store.file)).toBe(false);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('keeps the grant while the active client ID stays, across a new secret, an added team client, or removing an own copy', () => {
    const store = createGmailCredentialStore({ privateRoot: dir });
    store.saveClient(CLIENT);
    store.saveConnection({ refreshToken: 'refresh-1', accountEmail: 'jane.doe@gmail.com', scope: GMAIL_READONLY_SCOPE });
    store.saveClient({ clientId: CLIENT.clientId, clientSecret: 'GOCSPX-rotated-secret' });
    expect(store.read().connection?.refreshToken).toBe('refresh-1');
    // A team client behind an active own client changes nothing.
    store.saveTeamClient(OTHER_CLIENT);
    expect(store.read()).toMatchObject({ client: { clientId: CLIENT.clientId }, teamClient: { clientId: OTHER_CLIENT.clientId }, connection: { refreshToken: 'refresh-1' } });
    // Removing the own client makes the team client active: another ID, so the grant goes.
    store.removeOwnClient();
    expect(store.read().client).toBeUndefined();
    expect(store.read().connection).toBeUndefined();
    expect(createGmailCredentialStore({ privateRoot: dir }).read().teamClient?.clientId).toBe(OTHER_CLIENT.clientId);
  });

  it('refuses a linked file, restores 0600, and ignores unreadable or unknown-schema files', () => {
    const elsewhere = path.join(dir, 'elsewhere.json');
    fs.writeFileSync(elsewhere, JSON.stringify({ schemaVersion: 1, client: CLIENT }));
    const file = path.join(dir, 'gmail.json');
    fs.symlinkSync(elsewhere, file);
    expect(createGmailCredentialStore({ privateRoot: dir }).read()).toEqual({ schemaVersion: 1 });
    // Saving replaces the link itself and never writes through it.
    createGmailCredentialStore({ privateRoot: dir }).saveClient(OTHER_CLIENT);
    expect(fs.lstatSync(file).isSymbolicLink()).toBe(false);
    expect(JSON.parse(fs.readFileSync(elsewhere, 'utf8')).client.clientId).toBe(CLIENT.clientId);

    fs.chmodSync(file, 0o644);
    expect(createGmailCredentialStore({ privateRoot: dir }).read().client?.clientId).toBe(OTHER_CLIENT.clientId);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);

    fs.writeFileSync(file, 'not json');
    expect(createGmailCredentialStore({ privateRoot: dir }).read()).toEqual({ schemaVersion: 1 });
    fs.writeFileSync(file, JSON.stringify({ schemaVersion: 2, client: CLIENT }));
    expect(createGmailCredentialStore({ privateRoot: dir }).read()).toEqual({ schemaVersion: 1 });
  });

  it('validates client input without echoing it', () => {
    expect(validateGmailClient({ clientId: `  ${CLIENT.clientId} `, clientSecret: CLIENT.clientSecret })).toEqual(CLIENT);
    for (const [input, field] of [
      [{ clientId: 'my-secret-value', clientSecret: CLIENT.clientSecret }, 'clientId'],
      [{ clientId: CLIENT.clientId, clientSecret: 'short' }, 'clientSecret'],
      [{ clientId: CLIENT.clientId, clientSecret: 'has spaces in it' }, 'clientSecret'],
      [{}, 'clientId'],
    ] as const) {
      let error: unknown;
      try { validateGmailClient(input); } catch (caught) { error = caught; }
      expect(error).toBeInstanceOf(GmailCredentialInputError);
      expect((error as GmailCredentialInputError).field).toBe(field);
      expect((error as Error).message).not.toContain('my-secret-value');
      expect((error as Error).message).not.toContain('has spaces');
    }
  });
});

describe('Gmail connection (OAuth loopback + PKCE)', () => {
  let dir: string;
  let google: ReturnType<typeof fakeGoogle>;
  let clock: number;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ppt-gmail-conn-'));
    google = fakeGoogle();
    clock = Date.parse('2026-10-05T08:00:00Z');
  });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  function connection() {
    return createGmailConnection({ redirectUri: REDIRECT, privateRoot: dir, fetchImpl: google.fetch, endpoints: ENDPOINTS, now: () => clock });
  }

  async function connect(service: ReturnType<typeof connection>, code = 'code-1') {
    const { authUrl } = service.beginConnect();
    return { authUrl, outcome: await service.completeConnect({ code, state: queryOf(authUrl).get('state') }) };
  }

  it('builds an offline, consent, S256 authorization URL for read + compose', () => {
    const service = connection();
    expect(() => service.beginConnect()).toThrow(GmailAuthError);
    service.saveClient(CLIENT);
    const { authUrl } = service.beginConnect();
    expect(authUrl.startsWith(ENDPOINTS.authUrl)).toBe(true);
    const query = queryOf(authUrl);
    expect(Object.fromEntries(query)).toMatchObject({
      client_id: CLIENT.clientId, redirect_uri: REDIRECT, response_type: 'code', scope: `${GMAIL_READONLY_SCOPE} ${GMAIL_COMPOSE_SCOPE}`,
      access_type: 'offline', prompt: 'consent', code_challenge_method: 'S256',
    });
    expect(query.get('state')).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(query.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(authUrl).not.toContain(CLIENT.clientSecret);
  });

  it('connects with the verifier that matches the challenge and names the account from Gmail itself', async () => {
    const service = connection();
    service.saveClient(CLIENT);
    let changes = 0;
    service.onChange(() => { changes++; });
    const { authUrl, outcome } = await connect(service);
    expect(outcome).toEqual({ ok: true, accountEmail: 'jane.doe@gmail.com' });
    const exchange = google.calls.find(call => call.form.grant_type === 'authorization_code')!;
    expect(exchange.form).toMatchObject({ client_id: CLIENT.clientId, client_secret: CLIENT.clientSecret, code: 'code-1', redirect_uri: REDIRECT });
    const challenge = createHash('sha256').update(exchange.form.code_verifier).digest('base64url');
    expect(challenge).toBe(queryOf(authUrl).get('code_challenge'));
    expect(google.calls.find(call => call.url.includes('/profile'))?.auth).toBe('Bearer access-1');

    const status = service.status();
    expect(status).toMatchObject({ clientConfigured: true, connected: true, accountEmail: 'jane.doe@gmail.com', needsReconnect: false, lastError: null, redirectUri: REDIRECT });
    expect(JSON.stringify(status)).not.toMatch(/refresh-1|access-1|GOCSPX/);
    expect(changes).toBeGreaterThan(0);
    // The fresh access token is reused until it nears expiry.
    expect(await service.accessToken()).toBe('access-1');
    expect(google.calls.filter(call => call.form.grant_type === 'refresh_token')).toHaveLength(0);
  });

  it('accepts each state once, only while fresh, and reports a cancelled sign-in without changes', async () => {
    const service = connection();
    service.saveClient(CLIENT);
    const first = service.beginConnect();
    const state = queryOf(first.authUrl).get('state');
    expect(await service.completeConnect({ code: 'x', state: 'forged' })).toMatchObject({ ok: false });
    expect((await service.completeConnect({ error: 'access_denied', state })) as any).toEqual({ ok: false, error: 'Google sign-in was cancelled, so nothing changed.' });
    // The cancelled state is spent: a replay with a code finds nothing.
    expect(await service.completeConnect({ code: 'x', state })).toMatchObject({ ok: false, error: expect.stringContaining('expired or was already used') });

    const late = service.beginConnect();
    clock += 11 * 60_000;
    expect(await service.completeConnect({ code: 'x', state: queryOf(late.authUrl).get('state') })).toMatchObject({ ok: false, error: expect.stringContaining('expired') });
    expect(google.calls.some(call => call.form.grant_type === 'authorization_code')).toBe(false);
    expect(service.status()).toMatchObject({ connected: false, lastError: expect.stringContaining('expired') });
  });

  it('refuses a grant without read access or without a refresh token, storing nothing', async () => {
    const service = connection();
    service.saveClient(CLIENT);
    google.grantScope = 'openid email';
    expect((await connect(service)).outcome).toMatchObject({ ok: false, error: expect.stringContaining('read access') });
    google.grantScope = GMAIL_READONLY_SCOPE;
    google.grantRefreshToken = undefined;
    expect((await connect(service)).outcome).toMatchObject({ ok: false, error: expect.stringContaining('no refresh token') });
    expect(service.isConnected()).toBe(false);
    expect(createGmailCredentialStore({ privateRoot: dir }).read().connection).toBeUndefined();
  });

  it('refreshes once for concurrent callers and turns invalid_grant into a reconnect, then recovers', async () => {
    const service = connection();
    service.saveClient(CLIENT);
    await connect(service);
    clock += 3600_000; // the first access token expired
    google.refreshDelayMs = 5;
    const [a, b] = await Promise.all([service.accessToken(), service.accessToken()]);
    expect(a).toBe('access-2');
    expect(b).toBe('access-2');
    expect(google.calls.filter(call => call.form.grant_type === 'refresh_token')).toHaveLength(1);
    expect(google.calls.find(call => call.form.grant_type === 'refresh_token')?.form.refresh_token).toBe('refresh-1');

    service.invalidateAccessToken();
    google.refreshError = 'invalid_grant';
    const failure = await service.accessToken().catch(error => error);
    expect(failure).toBeInstanceOf(GmailAuthError);
    expect(failure.code).toBe('reconnect_required');
    expect(failure.message).not.toContain('refresh-1');
    expect(service.status()).toMatchObject({ connected: true, needsReconnect: true, accountEmail: 'jane.doe@gmail.com' });

    google.refreshError = '';
    expect(await service.accessToken()).toBe('access-3');
    expect(service.status()).toMatchObject({ needsReconnect: false, lastError: null });
  });

  it('never revokes when the same account reconnects, but revokes another account’s old grant', async () => {
    const service = connection();
    service.saveClient(CLIENT);
    await connect(service);
    google.grantRefreshToken = 'refresh-2';
    await connect(service, 'code-2');
    expect(google.calls.some(call => call.url === ENDPOINTS.revokeUrl)).toBe(false);
    expect(createGmailCredentialStore({ privateRoot: dir }).read().connection?.refreshToken).toBe('refresh-2');

    google.account = 'other@example.com';
    google.grantRefreshToken = 'refresh-3';
    await connect(service, 'code-3');
    expect(google.calls.filter(call => call.url === ENDPOINTS.revokeUrl).map(call => call.form.token)).toEqual(['refresh-2']);
    expect(service.accountEmail()).toBe('other@example.com');
  });

  it('disconnect revokes and forgets the grant but keeps the client; a new client drops and revokes the old grant', async () => {
    const service = connection();
    service.saveClient(CLIENT);
    await connect(service);
    const afterDisconnect = await service.disconnect();
    expect(google.calls.filter(call => call.url === ENDPOINTS.revokeUrl).map(call => call.form.token)).toEqual(['refresh-1']);
    expect(afterDisconnect).toMatchObject({ connected: false, clientConfigured: true, accountEmail: null });
    await expect(service.accessToken()).rejects.toMatchObject({ code: 'not_connected' });

    google.grantRefreshToken = 'refresh-9';
    await connect(service, 'code-9');
    service.saveClient(OTHER_CLIENT);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(google.calls.filter(call => call.url === ENDPOINTS.revokeUrl).map(call => call.form.token)).toEqual(['refresh-1', 'refresh-9']);
    expect(service.status()).toMatchObject({ connected: false, clientConfigured: true });

    await service.removeClient();
    expect(service.status()).toMatchObject({ connected: false, clientConfigured: false });
    expect(fs.existsSync(path.join(dir, 'gmail.json'))).toBe(false);
  });
});

/**
 * BotBoy's shared Google client from the credential file and the granted
 * scopes (GMAIL_CHAT_TOOLS_PLAN.md §7): the staged file is applied once at
 * boot, an own client always wins, and one grant rule covers every change.
 */
describe('Gmail connection: shared client and granted scopes', () => {
  const TEAM = { clientId: '5555555555-teamclientabc.apps.googleusercontent.com', clientSecret: 'GOCSPX-team-secret-one' };
  const NEW_TEAM = { clientId: '6666666666-teamclientxyz.apps.googleusercontent.com', clientSecret: 'GOCSPX-team-secret-new' };
  let dir: string;
  let google: ReturnType<typeof fakeGoogle>;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ppt-gmail-team-'));
    google = fakeGoogle();
  });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  const staged = () => path.join(dir, 'gmail-team-client.json');
  function stage(client: { clientId: string; clientSecret: string } | string) {
    fs.writeFileSync(staged(), typeof client === 'string' ? client : JSON.stringify({ schemaVersion: 1, ...client }), { mode: 0o600 });
  }
  function connection() {
    return createGmailConnection({ redirectUri: REDIRECT, privateRoot: dir, fetchImpl: google.fetch, endpoints: ENDPOINTS, now: () => Date.parse('2026-10-06T08:00:00Z') });
  }
  async function connect(service: ReturnType<typeof connection>, code = 'code-1') {
    const { authUrl } = service.beginConnect();
    return service.completeConnect({ code, state: queryOf(authUrl).get('state') });
  }
  const revoked = () => google.calls.filter(call => call.url === ENDPOINTS.revokeUrl).map(call => call.form.token);

  it('applies the staged client once and deletes the file; an own client stays active over it', () => {
    const service = connection();
    expect(service.applyStagedTeamClient()).toEqual({ applied: false, reason: 'none' });
    stage(TEAM);
    expect(service.applyStagedTeamClient()).toEqual({ applied: true });
    expect(fs.existsSync(staged())).toBe(false);
    expect(service.status()).toMatchObject({ clientConfigured: true, clientSource: 'team', teamClientAvailable: true, ownClientConfigured: false, clientIdSuffix: '…entabc' });
    expect(queryOf(service.beginConnect().authUrl).get('client_id')).toBe(TEAM.clientId);

    stage(TEAM);
    expect(service.applyStagedTeamClient()).toEqual({ applied: false, reason: 'unchanged' });
    expect(fs.existsSync(staged())).toBe(false);

    service.saveClient(CLIENT);
    stage(NEW_TEAM);
    expect(service.applyStagedTeamClient()).toEqual({ applied: true });
    expect(service.status()).toMatchObject({ clientSource: 'own', teamClientAvailable: true, ownClientConfigured: true });
    const stored = JSON.parse(fs.readFileSync(path.join(dir, 'gmail.json'), 'utf8'));
    expect(stored).toMatchObject({ schemaVersion: 1, client: { clientId: CLIENT.clientId }, teamClient: { clientId: NEW_TEAM.clientId } });
    expect(fs.statSync(path.join(dir, 'gmail.json')).mode & 0o777).toBe(0o600);
    expect(JSON.stringify(service.status())).not.toMatch(/GOCSPX/);
  });

  it('keeps the connection across a rotated shared secret, and drops and revokes it for a new client ID', async () => {
    const service = connection();
    stage(TEAM);
    service.applyStagedTeamClient();
    expect(await connect(service)).toMatchObject({ ok: true });

    stage({ clientId: TEAM.clientId, clientSecret: 'GOCSPX-team-secret-two' });
    expect(service.applyStagedTeamClient()).toEqual({ applied: true });
    expect(service.status().connected).toBe(true);
    service.invalidateAccessToken();
    await service.accessToken();
    expect(google.calls.filter(call => call.form.grant_type === 'refresh_token').at(-1)?.form.client_secret).toBe('GOCSPX-team-secret-two');
    expect(revoked()).toEqual([]);

    const pendingSignIn = service.beginConnect();
    stage(NEW_TEAM);
    expect(service.applyStagedTeamClient()).toEqual({ applied: true });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(service.status()).toMatchObject({ connected: false, clientSource: 'team', clientIdSuffix: '…entxyz' });
    expect(revoked()).toEqual(['refresh-1']);
    // A sign-in started with the old client cannot complete with the new one.
    expect(await service.completeConnect({ code: 'late', state: queryOf(pendingSignIn.authUrl).get('state') })).toMatchObject({ ok: false, error: expect.stringContaining('expired or was already used') });
  });

  it('removing an own client falls back to the shared one; the grant survives only for the same client ID', async () => {
    const service = connection();
    stage(TEAM);
    service.applyStagedTeamClient();
    service.saveClient(CLIENT);
    await connect(service);
    const afterRemove = await service.removeClient();
    expect(afterRemove).toMatchObject({ connected: false, clientConfigured: true, clientSource: 'team', ownClientConfigured: false });
    expect(revoked()).toEqual(['refresh-1']);

    // An own copy of the very same client ID: removing it keeps the grant.
    service.saveClient({ clientId: TEAM.clientId, clientSecret: 'GOCSPX-own-copy-secret' });
    google.grantRefreshToken = 'refresh-2';
    await connect(service, 'code-2');
    expect((await service.removeClient())).toMatchObject({ connected: true, clientSource: 'team' });
    expect(revoked()).toEqual(['refresh-1']);
  });

  it('refuses a damaged, foreign, or linked staged file and deletes it without touching the store', () => {
    const service = connection();
    service.saveClient(CLIENT);
    for (const bad of ['not json', JSON.stringify({ schemaVersion: 2, ...TEAM }), JSON.stringify({ schemaVersion: 1, clientId: 'nope', clientSecret: TEAM.clientSecret })]) {
      stage(bad);
      expect(service.applyStagedTeamClient()).toEqual({ applied: false, reason: 'invalid' });
      expect(fs.existsSync(staged())).toBe(false);
    }
    const elsewhere = path.join(dir, 'elsewhere.json');
    fs.writeFileSync(elsewhere, JSON.stringify({ schemaVersion: 1, ...TEAM }));
    fs.symlinkSync(elsewhere, staged());
    expect(service.applyStagedTeamClient()).toEqual({ applied: false, reason: 'invalid' });
    expect(fs.existsSync(staged())).toBe(false);
    expect(fs.existsSync(elsewhere)).toBe(true);
    expect(service.status()).toMatchObject({ clientSource: 'own', teamClientAvailable: false });
  });

  it('records what Google granted: read is required, compose is optional and upgradable', async () => {
    const service = connection();
    service.saveClient(CLIENT);
    await connect(service);
    expect(service.status()).toMatchObject({ connected: true, grantedScopes: [GMAIL_READONLY_SCOPE], canCompose: false, needsComposeGrant: true });
    expect(service.canCompose()).toBe(false);

    google.grantScope = `${GMAIL_READONLY_SCOPE} ${GMAIL_COMPOSE_SCOPE}`;
    await connect(service, 'code-2');
    expect(service.status()).toMatchObject({ grantedScopes: [GMAIL_READONLY_SCOPE, GMAIL_COMPOSE_SCOPE], canCompose: true, needsComposeGrant: false });
    expect(service.canCompose()).toBe(true);

    google.grantScope = GMAIL_COMPOSE_SCOPE;
    expect(await connect(service, 'code-3')).toMatchObject({ ok: false, error: expect.stringContaining('read access') });
    // The refused grant changed nothing.
    expect(service.canCompose()).toBe(true);
  });

  it('sends a rejected shared client to the owner and a rejected own client to its settings', async () => {
    const team = connection();
    stage(TEAM);
    team.applyStagedTeamClient();
    await connect(team);
    team.invalidateAccessToken();
    google.refreshError = 'invalid_client';
    await expect(team.accessToken()).rejects.toMatchObject({ code: 'reconnect_required' });
    expect(team.status().lastError).toContain('Ask the BotBoy owner for a new credential file');

    const ownDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ppt-gmail-own-'));
    try {
      const own = createGmailConnection({ redirectUri: REDIRECT, privateRoot: ownDir, fetchImpl: google.fetch, endpoints: ENDPOINTS });
      own.saveClient(CLIENT);
      google.refreshError = '';
      await connect(own);
      own.invalidateAccessToken();
      google.refreshError = 'invalid_client';
      await expect(own.accessToken()).rejects.toMatchObject({ code: 'reconnect_required' });
      expect(own.status().lastError).toContain('Check the client ID and secret');
    } finally {
      fs.rmSync(ownDir, { recursive: true, force: true });
    }
  });
});
