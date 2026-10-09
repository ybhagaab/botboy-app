import { createHash } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GMAIL_COMPOSE_SCOPE, GMAIL_READONLY_SCOPE, type GoogleEndpoints } from './gmail-api.js';
import { createGmailConnection, GmailAuthError } from './gmail-connection.js';
import { BOTBOY_GOOGLE_CLIENT } from './gmail-builtin-client.js';
import { createGmailCredentialStore, GmailCredentialInputError, usableBuiltInClient, validateGmailClient } from './gmail-credentials.js';

const CLIENT = { clientId: '1234567890-abcdefghijkl.apps.googleusercontent.com', clientSecret: 'GOCSPX-test-secret-value' };
const OTHER_CLIENT = { clientId: '9876543210-zyxwvutsrqpo.apps.googleusercontent.com', clientSecret: 'GOCSPX-other-secret-value' };
/** Fills the built-in slot in tests; the shipped slot (gmail-builtin-client.ts) is empty. */
const TEAM = { clientId: '5555555555-teamclientabc.apps.googleusercontent.com', clientSecret: 'GOCSPX-team-secret-one' };
const NEW_TEAM = { clientId: '6666666666-teamclientxyz.apps.googleusercontent.com', clientSecret: 'GOCSPX-team-secret-new' };
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

/**
 * Release safety (GMAIL_CHAT_TOOLS_PLAN.md D12): botboy-app is public and
 * Google's API terms forbid credentials in open source, so the built-in slot
 * ships empty and every install connects with its own client.
 */
describe('Gmail built-in client slot', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ppt-gmail-slot-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('ships empty, so an install has no client until the owner saves one', () => {
    expect(BOTBOY_GOOGLE_CLIENT).toEqual({ clientId: '', clientSecret: '' });
    expect(createGmailCredentialStore({ privateRoot: dir }).builtInClient).toBeNull();
    const service = createGmailConnection({ redirectUri: REDIRECT, privateRoot: dir });
    expect(service.status()).toMatchObject({ clientConfigured: false, clientSource: null, teamClientAvailable: false, ownClientConfigured: false, connected: false });
    expect(() => service.beginConnect()).toThrow('Add your own client in Connections → Gmail');
    service.saveClient(CLIENT);
    expect(service.status()).toMatchObject({ clientConfigured: true, clientSource: 'own', teamClientAvailable: false });
    expect(queryOf(service.beginConnect().authUrl).get('client_id')).toBe(CLIENT.clientId);
  });

  it('counts a blank or half-filled slot as no built-in client', () => {
    expect(usableBuiltInClient(TEAM)).toBe(TEAM);
    for (const slot of [null, undefined, { clientId: '', clientSecret: '' }, { clientId: TEAM.clientId, clientSecret: '' }, { clientId: '  ', clientSecret: TEAM.clientSecret }, { clientId: TEAM.clientId, clientSecret: ' \t' }]) {
      expect(usableBuiltInClient(slot)).toBeNull();
    }
    const halfFilled = createGmailCredentialStore({ privateRoot: dir, builtInClient: { clientId: TEAM.clientId, clientSecret: '' } });
    expect(halfFilled.builtInClient).toBeNull();
    expect(createGmailConnection({ redirectUri: REDIRECT, store: halfFilled }).status()).toMatchObject({ clientConfigured: false, teamClientAvailable: false });
  });
});

describe('Gmail credential store', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ppt-gmail-store-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('writes an owner-only schema-2 file and keeps the accounts only for the same client', () => {
    const store = createGmailCredentialStore({ privateRoot: dir, builtInClient: null });
    store.saveClient(CLIENT);
    expect(fs.statSync(store.file).mode & 0o777).toBe(0o600);
    store.saveConnection('default', { refreshToken: 'refresh-1', accountEmail: 'jane.doe@gmail.com', scope: GMAIL_READONLY_SCOPE });
    const reread = createGmailCredentialStore({ privateRoot: dir, builtInClient: null }).read();
    expect(reread).toMatchObject({ schemaVersion: 2, client: CLIENT, accounts: [{ id: 'default', label: '', connection: { refreshToken: 'refresh-1', accountEmail: 'jane.doe@gmail.com' } }] });

    store.saveClient(CLIENT);
    expect(store.read().accounts[0]?.connection.refreshToken).toBe('refresh-1');
    store.saveClient(OTHER_CLIENT);
    expect(store.read().accounts).toEqual([]);
    expect(createGmailCredentialStore({ privateRoot: dir, builtInClient: null }).read().accounts).toEqual([]);

    store.clearAll();
    expect(fs.existsSync(store.file)).toBe(false);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('keeps the grant while the active client ID stays: a new own secret, or removing an own copy of the built-in client', () => {
    const store = createGmailCredentialStore({ privateRoot: dir, builtInClient: TEAM });
    store.saveClient(CLIENT);
    store.saveConnection('default', { refreshToken: 'refresh-1', accountEmail: 'jane.doe@gmail.com', scope: GMAIL_READONLY_SCOPE });
    store.saveClient({ clientId: CLIENT.clientId, clientSecret: 'GOCSPX-rotated-secret' });
    expect(store.read().accounts[0]?.connection.refreshToken).toBe('refresh-1');
    // Removing the own client makes the built-in one active: another ID, so the grant goes with the file.
    store.removeOwnClient();
    expect(store.read()).toEqual({ schemaVersion: 2, accounts: [] });
    expect(fs.existsSync(store.file)).toBe(false);

    store.saveClient({ clientId: TEAM.clientId, clientSecret: 'GOCSPX-own-copy-secret' });
    store.saveConnection('default', { refreshToken: 'refresh-2', accountEmail: 'jane.doe@gmail.com', scope: GMAIL_READONLY_SCOPE });
    store.removeOwnClient();
    expect(store.read()).toEqual({ schemaVersion: 2, accounts: [expect.objectContaining({ connection: expect.objectContaining({ refreshToken: 'refresh-2' }) })] });
    // The file never holds the built-in client.
    expect(fs.readFileSync(store.file, 'utf8')).not.toContain(TEAM.clientSecret);

    // Without a built-in client a connection needs an own client, on read and on save.
    const bare = createGmailCredentialStore({ privateRoot: dir, builtInClient: null });
    expect(bare.read()).toEqual({ schemaVersion: 2, accounts: [] });
    expect(() => bare.saveConnection('default', { refreshToken: 'refresh-3', accountEmail: 'jane.doe@gmail.com', scope: GMAIL_READONLY_SCOPE })).toThrow('Save the Google OAuth client');
  });

  it('refuses a linked file, restores 0600, and ignores unreadable or unknown-schema files', () => {
    const elsewhere = path.join(dir, 'elsewhere.json');
    fs.writeFileSync(elsewhere, JSON.stringify({ schemaVersion: 1, client: CLIENT }));
    const file = path.join(dir, 'gmail.json');
    fs.symlinkSync(elsewhere, file);
    expect(createGmailCredentialStore({ privateRoot: dir }).read()).toEqual({ schemaVersion: 2, accounts: [] });
    // Saving replaces the link itself and never writes through it.
    createGmailCredentialStore({ privateRoot: dir }).saveClient(OTHER_CLIENT);
    expect(fs.lstatSync(file).isSymbolicLink()).toBe(false);
    expect(JSON.parse(fs.readFileSync(elsewhere, 'utf8')).client.clientId).toBe(CLIENT.clientId);

    fs.chmodSync(file, 0o644);
    expect(createGmailCredentialStore({ privateRoot: dir }).read().client?.clientId).toBe(OTHER_CLIENT.clientId);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);

    fs.writeFileSync(file, 'not json');
    expect(createGmailCredentialStore({ privateRoot: dir }).read()).toEqual({ schemaVersion: 2, accounts: [] });
    fs.writeFileSync(file, JSON.stringify({ schemaVersion: 3, client: CLIENT }));
    expect(createGmailCredentialStore({ privateRoot: dir }).read()).toEqual({ schemaVersion: 2, accounts: [] });
  });

  it('reads a schema-1 connection as the default account and adds, labels, and removes accounts', () => {
    fs.writeFileSync(path.join(dir, 'gmail.json'), JSON.stringify({
      schemaVersion: 1, client: CLIENT,
      connection: { refreshToken: 'refresh-1', accountEmail: 'Jane.Doe@gmail.com', scope: GMAIL_READONLY_SCOPE, connectedAt: '2026-10-06T00:00:00Z' },
    }), { mode: 0o600 });
    const store = createGmailCredentialStore({ privateRoot: dir, builtInClient: null });
    expect(store.read().accounts).toEqual([{ id: 'default', label: '', connection: { refreshToken: 'refresh-1', accountEmail: 'jane.doe@gmail.com', scope: GMAIL_READONLY_SCOPE, connectedAt: '2026-10-06T00:00:00Z' } }]);
    store.saveConnection('ga_0123456789', { refreshToken: 'refresh-2', accountEmail: 'work@company.com', scope: GMAIL_READONLY_SCOPE });
    store.setLabel('ga_0123456789', '  Work\n account  ');
    const reread = createGmailCredentialStore({ privateRoot: dir, builtInClient: null }).read();
    expect(reread.schemaVersion).toBe(2);
    expect(reread.accounts.map(account => [account.id, account.label, account.connection.accountEmail])).toEqual([
      ['default', '', 'jane.doe@gmail.com'],
      ['ga_0123456789', 'Work account', 'work@company.com'],
    ]);
    // One account per address: the same address under another id replaces it.
    store.saveConnection('ga_abcdefabcd', { refreshToken: 'refresh-3', accountEmail: 'work@company.com', scope: GMAIL_READONLY_SCOPE });
    expect(store.read().accounts.map(account => account.id)).toEqual(['default', 'ga_abcdefabcd']);
    store.clearConnection('default');
    expect(store.read().accounts.map(account => account.id)).toEqual(['ga_abcdefabcd']);
    expect(() => store.saveConnection('../escape', { refreshToken: 'x', accountEmail: 'x@y.com', scope: '' })).toThrow('Unknown Gmail account id');
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

  /** No built-in client here: these tests save their own (the built-in one is covered below). */
  function connection() {
    const store = createGmailCredentialStore({ privateRoot: dir, builtInClient: null });
    return createGmailConnection({ redirectUri: REDIRECT, store, fetchImpl: google.fetch, endpoints: ENDPOINTS, now: () => clock });
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
    expect(outcome).toEqual({ ok: true, accountEmail: 'jane.doe@gmail.com', accountId: 'default' });
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
    expect(createGmailCredentialStore({ privateRoot: dir }).read().accounts).toEqual([]);
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

  it('never revokes on reconnect; another address adds an account, each with its own token, label, and disconnect', async () => {
    let next = 0;
    const service = createGmailConnection({ redirectUri: REDIRECT, store: createGmailCredentialStore({ privateRoot: dir, builtInClient: null }), fetchImpl: google.fetch, endpoints: ENDPOINTS, now: () => clock, newAccountId: () => `ga_${String(++next).padStart(10, '0')}` });
    service.saveClient(CLIENT);
    await connect(service);
    google.grantRefreshToken = 'refresh-2';
    await connect(service, 'code-2');
    expect(google.calls.some(call => call.url === ENDPOINTS.revokeUrl)).toBe(false);
    expect(createGmailCredentialStore({ privateRoot: dir }).read().accounts[0]?.connection.refreshToken).toBe('refresh-2');

    // Add another account: Google's chooser first, and a second account with its own id.
    const { authUrl } = service.beginConnect({ addAccount: true });
    expect(new URL(authUrl).searchParams.get('prompt')).toBe('select_account consent');
    expect(new URL(authUrl).searchParams.get('login_hint')).toBeNull();
    google.account = 'other@example.com';
    google.grantRefreshToken = 'refresh-3';
    const added = await service.completeConnect({ code: 'code-3', state: new URL(authUrl).searchParams.get('state') });
    expect(added).toEqual({ ok: true, accountEmail: 'other@example.com', accountId: 'ga_0000000001' });
    expect(google.calls.some(call => call.url === ENDPOINTS.revokeUrl)).toBe(false);
    expect(service.accounts().map(account => [account.id, account.email])).toEqual([['default', 'jane.doe@gmail.com'], ['ga_0000000001', 'other@example.com']]);
    // The first account stays primary; any account is found by id, address, or label.
    expect(service.accountEmail()).toBe('jane.doe@gmail.com');
    service.setLabel('ga_0000000001', 'Side project');
    expect(service.account('side project')?.accountEmail()).toBe('other@example.com');
    expect(service.account('OTHER@example.com')?.id).toBe('ga_0000000001');
    expect(service.account('nobody@example.com')).toBeNull();
    expect(service.status().accounts.map(account => account.label)).toEqual(['', 'Side project']);
    // Reconnect of one account hints that account.
    expect(new URL(service.beginConnect({ accountId: 'ga_0000000001' }).authUrl).searchParams.get('login_hint')).toBe('other@example.com');
    expect(() => service.beginConnect({ accountId: 'ga_9999999999' })).toThrow('not connected');

    // Disconnect one account: only its grant is revoked.
    await service.disconnect('ga_0000000001');
    expect(google.calls.filter(call => call.url === ENDPOINTS.revokeUrl).map(call => call.form.token)).toEqual(['refresh-3']);
    expect(service.accounts().map(account => account.email)).toEqual(['jane.doe@gmail.com']);
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
 * A filled built-in slot and the granted scopes (GMAIL_CHAT_TOOLS_PLAN.md
 * D11–D12, §7). The shipped slot is empty (see the release-safety tests
 * above); these tests fill it with a fake client to keep the mechanism honest:
 * a built-in client is active until an own client is saved and is never
 * written to the file, a client staged by the retired credential-file
 * delivery is deleted unread, and one grant rule covers every change.
 */
describe('Gmail connection: built-in client and granted scopes', () => {
  let dir: string;
  let google: ReturnType<typeof fakeGoogle>;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ppt-gmail-team-'));
    google = fakeGoogle();
  });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  const file = () => path.join(dir, 'gmail.json');
  const staged = () => path.join(dir, 'gmail-team-client.json');
  /** One BotBoy build: `builtInClient` is what that build's slot holds. */
  function connection(builtInClient: { clientId: string; clientSecret: string } | null = TEAM) {
    const store = createGmailCredentialStore({ privateRoot: dir, builtInClient });
    return createGmailConnection({ redirectUri: REDIRECT, store, fetchImpl: google.fetch, endpoints: ENDPOINTS, now: () => Date.parse('2026-10-06T08:00:00Z') });
  }
  async function connect(service: ReturnType<typeof connection>, code = 'code-1') {
    const { authUrl } = service.beginConnect();
    return service.completeConnect({ code, state: queryOf(authUrl).get('state') });
  }
  const revoked = () => google.calls.filter(call => call.url === ENDPOINTS.revokeUrl).map(call => call.form.token);
  const lastRefresh = () => google.calls.filter(call => call.form.grant_type === 'refresh_token').at(-1)?.form;

  it('uses the built-in client until an own client is saved, without writing it anywhere', () => {
    // A build without a built-in client (a fork) needs an own client to connect.
    const bare = connection(null);
    expect(bare.status()).toMatchObject({ clientConfigured: false, clientSource: null, teamClientAvailable: false });
    expect(() => bare.beginConnect()).toThrow('Add your own client in Connections → Gmail');

    const service = connection();
    expect(service.status()).toMatchObject({ clientConfigured: true, clientSource: 'team', teamClientAvailable: true, ownClientConfigured: false, clientIdSuffix: '…entabc', connected: false });
    expect(queryOf(service.beginConnect().authUrl).get('client_id')).toBe(TEAM.clientId);
    expect(fs.readdirSync(dir)).toEqual([]);

    service.saveClient(CLIENT);
    expect(service.status()).toMatchObject({ clientSource: 'own', teamClientAvailable: true, ownClientConfigured: true, clientIdSuffix: '…ghijkl' });
    expect(queryOf(service.beginConnect().authUrl).get('client_id')).toBe(CLIENT.clientId);
    const stored = JSON.parse(fs.readFileSync(file(), 'utf8'));
    expect(Object.keys(stored).sort()).toEqual(['accounts', 'client', 'schemaVersion']);
    expect(fs.statSync(file()).mode & 0o777).toBe(0o600);
    expect(JSON.stringify(service.status())).not.toMatch(/GOCSPX/);
  });

  it('signs in and refreshes with the built-in ID and secret; the file keeps only the connection', async () => {
    const service = connection();
    expect(await connect(service)).toMatchObject({ ok: true });
    expect(google.calls.find(call => call.form.grant_type === 'authorization_code')?.form).toMatchObject({ client_id: TEAM.clientId, client_secret: TEAM.clientSecret });
    service.invalidateAccessToken();
    await service.accessToken();
    expect(lastRefresh()).toMatchObject({ client_id: TEAM.clientId, client_secret: TEAM.clientSecret, refresh_token: 'refresh-1' });
    const stored = JSON.parse(fs.readFileSync(file(), 'utf8'));
    expect(Object.keys(stored).sort()).toEqual(['accounts', 'schemaVersion']);
    expect(JSON.stringify(stored)).not.toContain(TEAM.clientSecret);
    expect(fs.statSync(file()).mode & 0o777).toBe(0o600);
  });

  it('an update with a new built-in secret keeps the connection; a new client ID makes Google ask for Reconnect', async () => {
    expect(await connect(connection())).toMatchObject({ ok: true });

    const rotated = connection({ clientId: TEAM.clientId, clientSecret: 'GOCSPX-team-secret-two' });
    expect(rotated.status()).toMatchObject({ connected: true, clientSource: 'team' });
    await rotated.accessToken();
    expect(lastRefresh()).toMatchObject({ client_id: TEAM.clientId, client_secret: 'GOCSPX-team-secret-two', refresh_token: 'refresh-1' });

    // Google binds the refresh token to the client ID, so a replaced client
    // cannot use it: the page asks for Reconnect (rotate secrets, not clients).
    const replaced = connection(NEW_TEAM);
    google.refreshError = 'unauthorized_client';
    await expect(replaced.accessToken()).rejects.toMatchObject({ code: 'reconnect_required' });
    expect(replaced.status()).toMatchObject({ connected: true, needsReconnect: true, clientSource: 'team', clientIdSuffix: '…entxyz' });
    expect(replaced.status().lastError).toContain('then Reconnect');
    expect(revoked()).toEqual([]);
  });

  it('removing an own client returns to the built-in one; the grant survives only for the same client ID', async () => {
    const service = connection();
    service.saveClient(CLIENT);
    await connect(service);
    const afterRemove = await service.removeClient();
    expect(afterRemove).toMatchObject({ connected: false, clientConfigured: true, clientSource: 'team', ownClientConfigured: false });
    expect(revoked()).toEqual(['refresh-1']);
    expect(fs.existsSync(file())).toBe(false);

    // An own copy of the built-in client ID: removing it keeps the grant.
    service.saveClient({ clientId: TEAM.clientId, clientSecret: 'GOCSPX-own-copy-secret' });
    google.grantRefreshToken = 'refresh-2';
    await connect(service, 'code-2');
    expect((await service.removeClient())).toMatchObject({ connected: true, clientSource: 'team' });
    expect(revoked()).toEqual(['refresh-1']);
  });

  it('ignores a teamClient left by the credential-file delivery and drops it on the next write', async () => {
    const connectedAt = '2026-10-05T08:00:00.000Z';
    fs.writeFileSync(file(), JSON.stringify({
      schemaVersion: 1,
      teamClient: { clientId: TEAM.clientId, clientSecret: 'GOCSPX-team-secret-old', savedAt: connectedAt },
      connection: { refreshToken: 'refresh-old', accountEmail: 'jane.doe@gmail.com', scope: GMAIL_READONLY_SCOPE, connectedAt },
    }), { mode: 0o600 });
    const service = connection();
    expect(service.status()).toMatchObject({ connected: true, clientSource: 'team', ownClientConfigured: false, accountEmail: 'jane.doe@gmail.com' });
    await service.accessToken();
    expect(lastRefresh()).toMatchObject({ client_id: TEAM.clientId, client_secret: TEAM.clientSecret, refresh_token: 'refresh-old' });

    await connect(service);
    expect(fs.readFileSync(file(), 'utf8')).not.toContain('teamClient');
    expect(fs.readFileSync(file(), 'utf8')).not.toContain('GOCSPX');
  });

  it('deletes a client staged by an older import unread, removing a planted link but never a directory', () => {
    const service = connection();
    expect(service.retireStagedTeamClient()).toBe(false);
    fs.writeFileSync(staged(), JSON.stringify({ schemaVersion: 1, ...OTHER_CLIENT }), { mode: 0o600 });
    expect(service.retireStagedTeamClient()).toBe(true);
    expect(fs.existsSync(staged())).toBe(false);
    expect(service.status()).toMatchObject({ clientSource: 'team', clientIdSuffix: '…entabc' });
    expect(fs.existsSync(file())).toBe(false);

    const elsewhere = path.join(dir, 'elsewhere.json');
    fs.writeFileSync(elsewhere, 'keep me');
    fs.symlinkSync(elsewhere, staged());
    expect(service.retireStagedTeamClient()).toBe(true);
    expect(() => fs.lstatSync(staged())).toThrow();
    expect(fs.readFileSync(elsewhere, 'utf8')).toBe('keep me');

    fs.mkdirSync(staged());
    expect(service.retireStagedTeamClient()).toBe(false);
    expect(fs.statSync(staged()).isDirectory()).toBe(true);
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

  it('sends a rejected built-in client to a BotBoy update and a rejected own client to its settings', async () => {
    const team = connection();
    await connect(team);
    team.invalidateAccessToken();
    google.refreshError = 'invalid_client';
    await expect(team.accessToken()).rejects.toMatchObject({ code: 'reconnect_required' });
    expect(team.status().lastError).toContain('Update BotBoy (./start.sh --update), then Reconnect');

    const ownDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ppt-gmail-own-'));
    try {
      const store = createGmailCredentialStore({ privateRoot: ownDir, builtInClient: TEAM });
      const own = createGmailConnection({ redirectUri: REDIRECT, store, fetchImpl: google.fetch, endpoints: ENDPOINTS });
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
