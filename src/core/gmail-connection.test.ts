import { createHash } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GMAIL_COMPOSE_SCOPE, GMAIL_READONLY_SCOPE, type GoogleEndpoints } from './gmail-api.js';
import { GDRIVE_FILE_SCOPE, GDRIVE_READONLY_SCOPE } from './gdrive-api.js';
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
    /** Thrown, in order, by the next code exchanges (a connect timeout, the 30 s deadline, …). */
    exchangeFailures: [] as Error[],
    /** Thrown, in order, by the next Gmail profile reads. */
    profileFailures: [] as Error[],
    /** When set, every Gmail profile read answers with this HTTP status and body (a Cloud project with the API off, say). */
    profileHttpError: null as { status: number; body: unknown } | null,
    /** Delays every Gmail profile read (a request still out while something else happens). */
    profileDelayMs: 0,
    /** A token renewal sent with this client secret answers invalid_client (an old secret Google no longer takes). */
    rejectClientSecret: '' as string,
    /** When set, the code exchange answers HTTP 400 with this error code. */
    exchangeError: '' as string,
    fetch: async (input: string, init?: RequestInit): Promise<Response> => {
      const form = typeof init?.body === 'string' ? Object.fromEntries(new URLSearchParams(init.body)) : {};
      const auth = (init?.headers as Record<string, string> | undefined)?.Authorization;
      calls.push({ url: input, form, auth });
      if (input === ENDPOINTS.tokenUrl && form.grant_type === 'authorization_code') {
        const failure = google.exchangeFailures.shift();
        if (failure) throw failure;
        if (google.exchangeError) return json({ error: google.exchangeError, error_description: 'Bad Request' }, 400);
        google.issued++;
        return json({
          access_token: `access-${google.issued}`, expires_in: 3600, scope: google.grantScope, token_type: 'Bearer',
          ...(google.grantRefreshToken ? { refresh_token: google.grantRefreshToken } : {}),
        });
      }
      if (input === ENDPOINTS.tokenUrl && form.grant_type === 'refresh_token') {
        if (google.refreshDelayMs) await new Promise(resolve => setTimeout(resolve, google.refreshDelayMs));
        if (google.rejectClientSecret && form.client_secret === google.rejectClientSecret) return json({ error: 'invalid_client', error_description: 'Unauthorized' }, 400);
        if (google.refreshError) return json({ error: google.refreshError, error_description: 'Token has been expired or revoked.' }, 400);
        google.issued++;
        return json({ access_token: `access-${google.issued}`, expires_in: 3600, scope: GMAIL_READONLY_SCOPE });
      }
      if (input === ENDPOINTS.revokeUrl) return json({});
      if (input.startsWith(`${ENDPOINTS.apiBase}/gmail/v1/users/me/profile`)) {
        if (google.profileDelayMs) await new Promise(resolve => setTimeout(resolve, google.profileDelayMs));
        const failure = google.profileFailures.shift();
        if (failure) throw failure;
        if (google.profileHttpError) return json(google.profileHttpError.body, google.profileHttpError.status);
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
    // A failed sign-in is a sign-in result, never a connection error: health stays clean.
    expect(service.status()).toMatchObject({ connected: false, lastError: null, pageSignIn: { action: 'unknown', kind: 'state_expired', ok: false, message: expect.stringContaining('expired') } });
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

  // Owner report 2026-10-23: chat called a working Gmail disconnected. The "needs Reconnect" flag is only Google's
  // answer about the sign-in BotBoy still uses, and any successful Gmail answer clears it.
  it('a token request still out when the owner reconnects neither marks the account nor fails its callers', async () => {
    const service = connection();
    service.saveClient(CLIENT);
    await connect(service);
    clock += 3600_000; // access-1 expired
    google.refreshError = 'invalid_grant'; // Google ended refresh-1 ...
    google.refreshDelayMs = 20; // ... and its answer is slow
    const waiting = service.accessToken();
    await new Promise(resolve => setTimeout(resolve, 2));
    expect(google.calls.filter(call => call.form.grant_type === 'refresh_token').map(call => call.form.refresh_token)).toEqual(['refresh-1']);
    google.grantRefreshToken = 'refresh-2';
    expect((await connect(service, 'code-2')).outcome).toMatchObject({ ok: true, accountId: 'default' });
    // The old request's "revoked" now arrives: it was about refresh-1, which BotBoy no longer uses.
    expect(await waiting).toBe('access-2');
    expect(service.status()).toMatchObject({ connected: true, needsReconnect: false, lastError: null });
    // A real revocation of the current sign-in still marks the account.
    google.refreshDelayMs = 0;
    service.invalidateAccessToken();
    const failure = await service.accessToken().catch(error => error);
    expect(failure).toMatchObject({ code: 'reconnect_required' });
    expect(service.status()).toMatchObject({ needsReconnect: true, lastError: expect.stringContaining('Choose Reconnect') });
  });

  it('asks once more with the current sign-in when the client secret changed while a token request was out', async () => {
    const service = connection();
    service.saveClient(CLIENT);
    await connect(service);
    clock += 3600_000;
    google.rejectClientSecret = CLIENT.clientSecret; // the old secret no longer works ...
    google.refreshDelayMs = 20;
    const waiting = service.accessToken();
    await new Promise(resolve => setTimeout(resolve, 2));
    service.saveClient({ clientId: CLIENT.clientId, clientSecret: 'GOCSPX-new-secret-value' }); // ... the owner saves the new one; same ID keeps the grant
    expect(await waiting).toBe('access-2');
    expect(google.calls.filter(call => call.form.grant_type === 'refresh_token').map(call => call.form.client_secret)).toEqual([CLIENT.clientSecret, 'GOCSPX-new-secret-value']);
    expect(service.status()).toMatchObject({ needsReconnect: false, lastError: null });
  });

  it('a successful Gmail answer clears a remembered needs-Reconnect, and says so', async () => {
    const service = connection();
    service.saveClient(CLIENT);
    await connect(service);
    google.profileDelayMs = 20;
    const read = service.client().getProfile(); // out with access-1, which Google still accepts
    await new Promise(resolve => setTimeout(resolve, 2));
    service.invalidateAccessToken();
    google.refreshError = 'invalid_grant';
    await service.accessToken().catch(() => undefined);
    expect(service.status()).toMatchObject({ needsReconnect: true });
    let changes = 0;
    service.onChange(() => { changes++; });
    await expect(read).resolves.toMatchObject({ emailAddress: 'jane.doe@gmail.com' });
    expect(service.status()).toMatchObject({ needsReconnect: false, lastError: null });
    expect(changes).toBe(1);
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

/**
 * Owner report 2026-10-12: a green "Active" badge beside "Google sign-in
 * failed: network error (ETIMEDOUT)". Health (needsReconnect / lastError) and
 * the result of the last sign-in attempt (signIn / pageSignIn) are separate
 * answers; the attempt is shown where it was made, ends after 15 minutes or on
 * Dismiss, and a failure that a later success outdates is not shown. The
 * measured cause of the ETIMEDOUT itself (Node's 250 ms connect limit) is
 * network-defaults.test.ts; here the code exchange meets the failure it caused.
 */
const WITH_DRIVE = `${GMAIL_READONLY_SCOPE} ${GMAIL_COMPOSE_SCOPE} ${GDRIVE_READONLY_SCOPE} ${GDRIVE_FILE_SCOPE}`;
const GMAIL_ONLY = `${GMAIL_READONLY_SCOPE} ${GMAIL_COMPOSE_SCOPE}`;
const errnoError = (code: string, syscall = 'connect') => Object.assign(new Error(`${syscall} ${code}`), { code, syscall });
/** What Node threw for every fetch to Google on the owner's Mac: a failed connect to both addresses. */
const connectFailure = () => Object.assign(new TypeError('fetch failed'), {
  cause: Object.assign(new AggregateError([errnoError('ETIMEDOUT'), errnoError('EHOSTUNREACH')], ''), { code: 'ETIMEDOUT' }),
});
const lookupFailure = () => Object.assign(new TypeError('fetch failed'), { cause: errnoError('ENOTFOUND', 'getaddrinfo') });
const deadlineFailure = () => Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });

describe('Gmail sign-in results: the last attempt is not the connection’s health', () => {
  let dir: string;
  let google: ReturnType<typeof fakeGoogle>;
  let clock: number;
  let pauses: number[];
  let warnings: string[];
  let logs: string[];

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ppt-gmail-signin-'));
    google = fakeGoogle();
    clock = Date.parse('2026-10-12T06:00:00Z');
    pauses = [];
    warnings = [];
    logs = [];
    vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => { warnings.push(args.map(String).join(' ')); });
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { logs.push(args.map(String).join(' ')); });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function make() {
    const store = createGmailCredentialStore({ privateRoot: dir, builtInClient: null });
    const service = createGmailConnection({
      redirectUri: REDIRECT, store, fetchImpl: google.fetch, endpoints: ENDPOINTS, now: () => clock,
      sleep: async (ms) => { pauses.push(ms); },
      newAccountId: (() => { let n = 0; return () => `ga_${String(++n).padStart(10, '0')}`; })(),
    });
    service.saveClient(CLIENT);
    return { store, service };
  }
  async function signIn(service: ReturnType<typeof make>['service'], options?: Parameters<ReturnType<typeof make>['service']['beginConnect']>[0], code = 'code-1') {
    const { authUrl } = service.beginConnect(options);
    const state = queryOf(authUrl).get('state');
    return { authUrl, state, result: await service.completeSignIn({ code, state }) };
  }
  const exchanges = () => google.calls.filter(call => call.form.grant_type === 'authorization_code');
  const gmailJson = () => fs.readFileSync(path.join(dir, 'gmail.json'), 'utf8');

  it('retries the code exchange once after a connect timeout, with the same code and verifier, then connects', async () => {
    const { service } = make();
    google.exchangeFailures = [connectFailure()];
    const { authUrl, result } = await signIn(service);
    expect(result).toMatchObject({ connected: true, accountId: 'default', accountEmail: 'jane.doe@gmail.com', replay: false, attempt: { action: 'gmail_connect', kind: 'ok', ok: true } });
    expect(exchanges()).toHaveLength(2);
    const [first, second] = exchanges();
    expect(second.form).toEqual(first.form);
    expect(createHash('sha256').update(second.form.code_verifier).digest('base64url')).toBe(queryOf(authUrl).get('code_challenge'));
    expect(pauses).toEqual([1500]);
    expect(service.status()).toMatchObject({ connected: true, needsReconnect: false, lastError: null, pageSignIn: null });
    expect(warnings.join('\n')).toContain('sign-in could not reach Google (ETIMEDOUT+EHOSTUNREACH); trying once more');
  });

  it('after two connect timeouts says so plainly, writes no grant, and leaves the existing one untouched', async () => {
    const { service, store } = make();
    await signIn(service);
    const before = gmailJson();
    const callsBefore = exchanges().length;
    google.exchangeFailures = [connectFailure(), connectFailure()];
    google.grantRefreshToken = 'refresh-2';
    const { result } = await signIn(service, { accountId: 'default', purpose: 'drive' }, 'code-drive');
    expect(result.connected).toBe(false);
    expect(result.attempt).toMatchObject({ action: 'drive_connect', kind: 'network', ok: false, accountId: 'default' });
    expect(result.attempt!.message).toBe("Couldn't connect Google Drive: BotBoy couldn't reach Google (timed out on a slow route to Google). Your current Gmail connection is unchanged. Press Connect Google Drive to try again.");
    expect(exchanges().length - callsBefore).toBe(2);
    expect(pauses).toEqual([1500]);
    // No tokens came back, so Gmail was never asked who signed in, and nothing was written.
    expect(google.calls.filter(call => call.url.includes('/profile'))).toHaveLength(1);
    expect(gmailJson()).toBe(before);
    expect(store.read().accounts[0].connection.refreshToken).toBe('refresh-1');
    expect(service.status()).toMatchObject({ connected: true, needsReconnect: false, lastError: null });
    expect(service.status().signIn.drive).toMatchObject({ kind: 'network', ok: false });
    expect(service.status().signIn.gmail?.ok).toBe(true);
  });

  it('writes no grant when a first connect times out twice', async () => {
    const { service, store } = make();
    google.exchangeFailures = [connectFailure(), connectFailure()];
    const { result } = await signIn(service);
    expect(result).toMatchObject({ connected: false, accountId: null, attempt: { action: 'gmail_connect', kind: 'network', accountId: null } });
    expect(result.attempt!.message).toBe("Couldn't connect Gmail: BotBoy couldn't reach Google (timed out on a slow route to Google). Press Connect Gmail to try again.");
    expect(store.read().accounts).toEqual([]);
    expect(service.isConnected()).toBe(false);
    expect(service.status()).toMatchObject({ connected: false, lastError: null, pageSignIn: { kind: 'network', ok: false } });
  });

  it('never sends the code again after Google answered or after the 30 s deadline', async () => {
    const { service } = make();
    google.exchangeError = 'invalid_grant';
    const answered = (await signIn(service)).result;
    expect(answered.attempt).toMatchObject({ kind: 'invalid_grant', ok: false });
    expect(answered.attempt!.message).toBe("Couldn't connect Gmail: Google rejected the sign-in code (it was already used or expired). Press Connect Gmail to try again.");
    expect(exchanges()).toHaveLength(1);
    google.exchangeError = '';
    google.exchangeFailures = [deadlineFailure()];
    const timedOut = (await signIn(service, undefined, 'code-2')).result;
    expect(timedOut.attempt).toMatchObject({ kind: 'timeout', ok: false });
    expect(timedOut.attempt!.message).toBe("Couldn't connect Gmail: Google didn't answer within 30 seconds. Press Connect Gmail to try again.");
    expect(exchanges()).toHaveLength(2);
    expect(pauses).toEqual([]);
    expect(service.isConnected()).toBe(false);
  });

  it('retries the Gmail profile read once instead of losing the refresh token Google just issued', async () => {
    const { service } = make();
    google.profileFailures = [connectFailure()];
    const { result } = await signIn(service);
    expect(result.connected).toBe(true);
    expect(exchanges()).toHaveLength(1);
    expect(google.calls.filter(call => call.url.includes('/profile'))).toHaveLength(2);
    expect(pauses).toEqual([1500]);

    google.profileFailures = [connectFailure(), connectFailure()];
    const lost = await signIn(make().service, undefined, 'code-3').catch(error => error);
    expect(lost.result.connected).toBe(false);
    expect(lost.result.attempt).toMatchObject({ kind: 'network', ok: false });
  });

  it('puts each failure in words that name the action, the cause, and the next step', async () => {
    const { service } = make();
    await signIn(service);
    const fail = async (options: Parameters<typeof service.beginConnect>[0], setup: () => void = () => {}) => {
      setup();
      return (await signIn(service, options, 'code-x')).result.attempt!;
    };
    const drive = { accountId: 'default', purpose: 'drive' as const };

    google.exchangeFailures = [lookupFailure(), lookupFailure()];
    expect((await fail(drive)).message).toBe("Couldn't connect Google Drive: BotBoy couldn't reach Google (Google's address could not be looked up). Your current Gmail connection is unchanged. Press Connect Google Drive to try again.");
    google.exchangeFailures = [deadlineFailure()];
    expect((await fail(drive)).message).toBe("Couldn't connect Google Drive: Google didn't answer within 30 seconds. Your current Gmail connection is unchanged. Press Connect Google Drive to try again.");
    google.exchangeError = 'invalid_grant';
    expect((await fail(drive)).message).toBe("Couldn't connect Google Drive: Google rejected the sign-in code (it was already used or expired). Your current Gmail connection is unchanged. Press Connect Google Drive to try again.");
    google.exchangeError = 'redirect_uri_mismatch';
    const redirect = await fail(drive);
    expect(redirect).toMatchObject({ kind: 'client_rejected' });
    expect(redirect.message).toContain('does not match this OAuth client (redirect mismatch)');
    expect(redirect.message).toContain('Desktop app OAuth client');
    google.exchangeError = 'invalid_client';
    expect((await fail(drive)).message).toContain('Google rejected the OAuth client ID or secret');
    google.exchangeError = '503';
    expect((await fail(drive)).message).toBe("Couldn't connect Google Drive: Google answered with an error (HTTP 400 503). Your current Gmail connection is unchanged. Press Connect Google Drive to try again.");
    google.exchangeError = '';

    // The owner pressed Cancel on Google's Drive screen.
    const cancelled = service.beginConnect(drive);
    const denied = await service.completeSignIn({ error: 'access_denied', state: queryOf(cancelled.authUrl).get('state') });
    expect(denied.attempt).toMatchObject({ kind: 'cancelled', action: 'drive_connect' });
    expect(denied.attempt!.message).toBe('Drive not granted: the Google sign-in was cancelled, so nothing changed. Press Connect Google Drive to try again.');

    // A link that matches no sign-in (BotBoy restarted, or the page was opened twice).
    const stale = await service.completeSignIn({ code: 'x', state: 'never-issued' });
    expect(stale.attempt).toMatchObject({ action: 'unknown', kind: 'state_expired', accountId: null });
    expect(stale.attempt!.message).toBe('That sign-in link expired or was already used (BotBoy restarted, or the page was opened twice). Choose Connect again.');

    // A Reconnect names Reconnect and says the current connection is unchanged.
    google.exchangeFailures = [connectFailure(), connectFailure()];
    expect((await fail({ accountId: 'default' })).message).toBe("Couldn't reconnect Gmail: BotBoy couldn't reach Google (timed out on a slow route to Google). Your current Gmail connection is unchanged. Press Reconnect to try again.");
    // Adding a second account names that button.
    google.exchangeFailures = [connectFailure(), connectFailure()];
    expect((await fail({ addAccount: true })).message).toContain('Press Add another account to try again.');
  });

  it('says the Gmail API is turned off, and what to do, when Google answers the profile read with accessNotConfigured', async () => {
    const { service, store } = make();
    const fix = (button: string) => `Enable the Gmail API in the same Google Cloud project as your OAuth client (APIs & Services → Library → Gmail API), wait a minute, then press ${button} to try again.`;
    const off = {
      error: {
        code: 403,
        message: 'Gmail API has not been used in project 1234567890 before or it is disabled. Enable it by visiting https://console.developers.google.com/apis/api/gmail.googleapis.com/overview?project=1234567890 then retry.',
        errors: [{ message: 'Access Not Configured.', domain: 'usageLimits', reason: 'accessNotConfigured' }],
        status: 'PERMISSION_DENIED',
      },
    };

    // A first connect: Google issued tokens, then the profile read said the API is off.
    google.profileHttpError = { status: 403, body: off };
    const first = (await signIn(service)).result;
    expect(first).toMatchObject({ connected: false, attempt: { action: 'gmail_connect', kind: 'api_not_enabled', ok: false, accountId: null } });
    expect(first.attempt!.message).toBe(`Couldn't connect Gmail: Google says the Gmail API is turned off. ${fix('Connect Gmail')}`);
    expect(first.attempt!.nextAction).toBe(fix('Connect Gmail'));
    // Google answered, so nothing is retried, and no grant is written.
    expect(google.calls.filter(call => call.url.includes('/profile'))).toHaveLength(1);
    expect(pauses).toEqual([]);
    expect(store.read().accounts).toEqual([]);
    expect(warnings).toContain('[Gmail] sign-in failed: action=gmail_connect kind=api_not_enabled code=403 accessNotConfigured');

    // Connected, a Drive attempt names its own button, leaves the grant alone, and
    // gives no Gmail reassurance (Gmail itself is the cause).
    google.profileHttpError = null;
    await signIn(service, undefined, 'code-2');
    const before = gmailJson();
    google.profileHttpError = { status: 403, body: off };
    const drive = (await signIn(service, { accountId: 'default', purpose: 'drive' }, 'code-3')).result;
    expect(drive.attempt).toMatchObject({ action: 'drive_connect', kind: 'api_not_enabled', accountId: 'default' });
    expect(drive.attempt!.message).toBe(`Couldn't connect Google Drive: Google says the Gmail API is turned off. ${fix('Connect Google Drive')}`);
    expect(gmailJson()).toBe(before);
    expect(service.status()).toMatchObject({ connected: true, needsReconnect: false, lastError: null });

    // Newer error bodies carry no reason list (the reason reads PERMISSION_DENIED): the text says it.
    google.profileHttpError = { status: 403, body: { error: { code: 403, message: 'Gmail API has not been used in project 1 before or it is disabled.', status: 'PERMISSION_DENIED' } } };
    expect((await signIn(service, { accountId: 'default' }, 'code-4')).result.attempt).toMatchObject({ kind: 'api_not_enabled' });
    google.profileHttpError = { status: 403, body: { error: { code: 403, message: 'Service disabled.', errors: [{ reason: 'SERVICE_DISABLED' }] } } };
    expect((await signIn(service, { accountId: 'default' }, 'code-5')).result.attempt).toMatchObject({ kind: 'api_not_enabled' });

    // Other 403s, and other statuses, are not mistaken for it.
    google.profileHttpError = { status: 403, body: { error: { code: 403, message: 'Request had insufficient authentication scopes.', errors: [{ reason: 'insufficientPermissions' }] } } };
    const other = (await signIn(service, { accountId: 'default' }, 'code-6')).result.attempt!;
    expect(other.kind).toBe('google_error');
    expect(other.message).toBe("Couldn't reconnect Gmail: Google answered with an error (HTTP 403 insufficientPermissions). Your current Gmail connection is unchanged. Press Reconnect to try again.");
    google.profileHttpError = { status: 500, body: { error: { code: 500, message: 'Backend is disabled for maintenance.' } } };
    expect((await signIn(service, { accountId: 'default' }, 'code-7')).result.attempt!.kind).toBe('google_error');
  });

  it('never states Gmail’s health in a notice that outlives the moment it was written', async () => {
    // A notice stays 15 minutes; "Gmail is still working" could outlast an outage that turns the badge amber.
    const { service } = make();
    await signIn(service);
    const messages: string[] = [];
    const record = async (options: Parameters<typeof service.beginConnect>[0]) => {
      messages.push((await signIn(service, options, 'code-h')).result.attempt!.message);
    };
    const drive = { accountId: 'default', purpose: 'drive' as const };
    google.exchangeFailures = [connectFailure(), connectFailure()];
    await record(drive);
    google.exchangeFailures = [deadlineFailure()];
    await record(drive);
    google.exchangeError = 'invalid_grant';
    await record(drive);
    google.exchangeError = '';
    google.grantScope = GMAIL_ONLY;
    await record(drive);
    google.grantScope = `${GMAIL_ONLY} ${GDRIVE_READONLY_SCOPE}`;
    await record(drive);
    google.exchangeFailures = [connectFailure(), connectFailure()];
    await record({ accountId: 'default' });
    expect(messages).toHaveLength(6);
    for (const message of messages) expect(message).not.toMatch(/working|still works/i);
    // What the failed attempts say instead is true of the attempt itself: it left the connection alone.
    expect(messages.filter(message => message.includes('Your current Gmail connection is unchanged.'))).toHaveLength(4);
  });

  it('says a Drive box was left unticked, for none or one of the two, and keeps Gmail connected', async () => {
    const { service } = make();
    await signIn(service);
    google.grantScope = GMAIL_ONLY;
    const none = (await signIn(service, { accountId: 'default', purpose: 'drive' }, 'code-2')).result;
    expect(none).toMatchObject({ connected: true, attempt: { kind: 'drive_not_granted', ok: false, action: 'drive_connect' } });
    expect(none.attempt!.message).toBe('Drive not granted: Google connected, but both Drive boxes were left unticked. Press Connect Google Drive and tick both Drive boxes.');
    google.grantScope = `${GMAIL_ONLY} ${GDRIVE_READONLY_SCOPE}`;
    const some = (await signIn(service, { accountId: 'default', purpose: 'drive' }, 'code-3')).result;
    expect(some.attempt!.message).toBe('Drive not granted in full: Google allowed reading Drive but not publishing to it. Press Connect Google Drive and tick both Drive boxes.');
    expect(service.accounts()[0]).toMatchObject({ canReadDrive: true, canPublishDrive: false, drive: null, lastError: null });
  });

  it('keeps a partial Drive grant’s notice through later token refreshes (it is a fact, not a transient error)', async () => {
    const { service } = make();
    await signIn(service);
    google.grantScope = GMAIL_ONLY;
    await signIn(service, { accountId: 'default', purpose: 'drive' }, 'code-2');
    clock += 60_000;
    service.invalidateAccessToken();
    await service.accessToken();
    await service.client().getProfile();
    expect(service.status().signIn.drive).toMatchObject({ kind: 'drive_not_granted' });
    expect(service.accounts()[0].signIn.drive).toMatchObject({ kind: 'drive_not_granted' });
    expect(service.status().lastError).toBeNull();
  });

  it('never shows a failed Reconnect as health, and hides it once a refresh, an API answer, or a grant save outdates it', async () => {
    const { service } = make();
    await signIn(service);
    const failReconnect = async () => {
      clock += 60_000;
      google.exchangeFailures = [connectFailure(), connectFailure()];
      await signIn(service, { accountId: 'default' }, 'code-r');
      expect(service.status()).toMatchObject({ connected: true, needsReconnect: false, lastError: null, signIn: { gmail: { kind: 'network', ok: false } } });
      expect(service.accounts()[0].signIn.gmail).toMatchObject({ kind: 'network' });
    };

    // 1. the hourly token refresh works
    await failReconnect();
    clock += 60_000;
    service.invalidateAccessToken();
    await service.accessToken();
    expect(service.status().signIn.gmail).toBeNull();
    expect(service.accounts()[0].signIn.gmail).toBeNull();

    // 2. a Gmail call answers with the cached token (a sync run)
    await failReconnect();
    clock += 60_000;
    await service.client().getProfile();
    expect(service.status().signIn.gmail).toBeNull();

    // 3. the next Connect saves a grant
    await failReconnect();
    clock += 60_000;
    expect((await signIn(service, { accountId: 'default' }, 'code-ok')).result.connected).toBe(true);
    expect(service.status().signIn.gmail).toMatchObject({ kind: 'ok', ok: true });
    expect(service.status().signIn.gmail?.message).toBe('Gmail reconnected as jane.doe@gmail.com.');
  });

  it('keeps a Drive failure through Gmail successes; it ends on Dismiss, after 15 minutes, or when Drive connects', async () => {
    const { service } = make();
    await signIn(service);
    const failDrive = async () => {
      clock += 60_000;
      google.exchangeFailures = [connectFailure(), connectFailure()];
      await signIn(service, { accountId: 'default', purpose: 'drive' }, 'code-d');
      return Date.parse(service.status().signIn.drive!.at);
    };

    // Gmail working says nothing about the Drive grant.
    let at = await failDrive();
    clock += 60_000;
    service.invalidateAccessToken();
    await service.accessToken();
    await service.client().getProfile();
    expect(service.status().signIn.drive).toMatchObject({ kind: 'network', ok: false });

    // Fifteen minutes after the attempt it is gone (14:59.999 still shows it).
    clock = at + 15 * 60_000 - 1;
    expect(service.status().signIn.drive).not.toBeNull();
    clock = at + 15 * 60_000;
    expect(service.status().signIn.drive).toBeNull();

    // Dismiss ends it early, only for that account and action.
    at = await failDrive();
    google.exchangeFailures = [connectFailure(), connectFailure()];
    await signIn(service, { accountId: 'default' }, 'code-g');
    service.dismissSignIn('default', 'drive_connect');
    expect(service.status().signIn.drive).toBeNull();
    expect(service.status().signIn.gmail).toMatchObject({ kind: 'network' });
    service.dismissSignIn('default', 'gmail_connect');
    expect(service.status().signIn.gmail).toBeNull();

    // A successful Drive connect replaces the failure with its own result.
    await failDrive();
    google.grantScope = WITH_DRIVE;
    clock += 60_000;
    expect((await signIn(service, { accountId: 'default', purpose: 'drive' }, 'code-ok')).result.connected).toBe(true);
    expect(service.status().signIn.drive).toMatchObject({ kind: 'ok', ok: true, message: 'Google Drive connected. Choose the Drive sources BotBoy should capture below.' });
    expect(service.accounts()[0]).toMatchObject({ canReadDrive: true, canPublishDrive: true });
  });

  it('shows a first connect’s failure on the page level, dismissable, and clears it on the next success', async () => {
    const { service } = make();
    google.exchangeFailures = [connectFailure(), connectFailure()];
    await signIn(service);
    expect(service.status().pageSignIn).toMatchObject({ action: 'gmail_connect', accountId: null, kind: 'network' });
    expect(service.status().signIn).toEqual({ gmail: null, drive: null });
    service.dismissSignIn(null, 'gmail_connect');
    expect(service.status().pageSignIn).toBeNull();

    // A link that matched nothing sits in the same page-level place and also ends on the next success.
    await service.completeSignIn({ code: 'x', state: 'forged' });
    expect(service.status().pageSignIn).toMatchObject({ action: 'unknown', kind: 'state_expired' });
    await signIn(service, undefined, 'code-ok');
    expect(service.status()).toMatchObject({ connected: true, pageSignIn: null });
  });

  it('scopes a second account’s results to that account', async () => {
    const { service } = make();
    await signIn(service);
    google.account = 'work@example.com';
    google.grantRefreshToken = 'refresh-2';
    const { result } = await signIn(service, { addAccount: true }, 'code-2');
    const workId = result.accountId!;
    expect(workId).toBe('ga_0000000001');
    google.exchangeFailures = [connectFailure(), connectFailure()];
    await signIn(service, { accountId: workId }, 'code-3');
    expect(service.account(workId)!.status().signIn.gmail).toMatchObject({ kind: 'network', accountId: workId });
    // The first account keeps its own (successful) result; the failure is not copied to it.
    expect(service.account('default')!.status().signIn.gmail).toMatchObject({ kind: 'ok', ok: true });
    expect(service.accounts().find(account => account.id === workId)!.signIn.gmail).toMatchObject({ kind: 'network' });
    expect(service.accounts().find(account => account.id === 'default')!.signIn.gmail).toMatchObject({ kind: 'ok' });
    // Disconnecting the account takes its results with it.
    await service.disconnect(workId);
    expect(service.status().accounts.map(account => account.id)).toEqual(['default']);
    expect(service.status().pageSignIn).toBeNull();
  });

  it('does not record a failure when a callback BotBoy already handled is opened again', async () => {
    const { service } = make();
    const { state, result } = await signIn(service);
    expect(result.connected).toBe(true);
    const again = await service.completeSignIn({ code: 'code-1', state });
    expect(again).toEqual({ connected: false, accountId: null, accountEmail: null, attempt: null, replay: true });
    expect(await service.completeConnect({ code: 'code-1', state })).toMatchObject({ ok: false, error: expect.stringContaining('expired or was already used') });
    expect(exchanges()).toHaveLength(1);
    expect(service.status()).toMatchObject({ connected: true, pageSignIn: null, signIn: { gmail: { kind: 'ok' } } });
  });

  it('keeps health separate: a rejected grant sets lastError, a good refresh clears it, and sign-in results never touch it', async () => {
    const { service } = make();
    await signIn(service);
    google.exchangeFailures = [connectFailure(), connectFailure()];
    await signIn(service, { accountId: 'default', purpose: 'drive' }, 'code-d');
    expect(service.status().lastError).toBeNull();

    service.invalidateAccessToken();
    google.refreshError = 'invalid_grant';
    await expect(service.accessToken()).rejects.toMatchObject({ code: 'reconnect_required' });
    expect(service.status()).toMatchObject({ needsReconnect: true, lastError: expect.stringContaining('Choose Reconnect'), signIn: { drive: { kind: 'network' } } });
    expect(service.accounts()[0].lastError).toContain('Choose Reconnect');

    google.refreshError = '';
    await service.accessToken();
    expect(service.status()).toMatchObject({ needsReconnect: false, lastError: null });
    expect(service.accounts()[0].lastError).toBeNull();
  });

  it('logs one token-free warning per failed attempt and a connected line that names Drive', async () => {
    const { service } = make();
    google.grantScope = GMAIL_ONLY;
    google.exchangeFailures = [connectFailure(), connectFailure()];
    google.grantRefreshToken = 'refresh-secret-value';
    await signIn(service, undefined, 'code-secret-value');
    const failed = warnings.filter(line => line.startsWith('[Gmail] sign-in failed'));
    expect(failed).toEqual(['[Gmail] sign-in failed: action=gmail_connect kind=network code=ETIMEDOUT+EHOSTUNREACH']);

    await signIn(service, undefined, 'code-2');
    expect(logs.find(line => line.includes('Connected jane.doe@gmail.com'))).toContain('(own client …ghijkl; read + compose; no Drive)');

    google.grantScope = GMAIL_ONLY;
    await signIn(service, { accountId: 'default', purpose: 'drive' }, 'code-3');
    expect(logs.filter(line => line.includes('Reconnected')).at(-1)).toContain('; Drive not granted)');
    expect(warnings.filter(line => line.startsWith('[Gmail] sign-in failed')).length).toBe(1);

    google.grantScope = WITH_DRIVE;
    await signIn(service, { accountId: 'default', purpose: 'drive' }, 'code-4');
    expect(logs.filter(line => line.includes('Reconnected')).at(-1)).toContain('; Drive read + publish)');

    google.exchangeError = 'invalid_grant';
    await signIn(service, { accountId: 'default', purpose: 'drive' }, 'code-5');
    expect(warnings.filter(line => line.startsWith('[Gmail] sign-in failed')).at(-1)).toBe('[Gmail] sign-in failed: action=drive_connect kind=invalid_grant code=400 invalid_grant account=default');
    const everything = [...warnings, ...logs].join('\n');
    for (const secret of ['code-secret-value', 'refresh-secret-value', 'access-1', CLIENT.clientSecret, 'refresh-1']) expect(everything).not.toContain(secret);
  });
});

/**
 * Owner follow-up 2026-10-12: Drive consent worked as soon as the connect
 * limit was raised, and the stale "Google sign-in failed" label changed in the
 * same restart. These tests pin that the label was only a symptom: a recorded
 * failure never refuses, short-circuits, or alters the next attempt.
 */
describe('Regression: a recorded sign-in failure never gates a new attempt', () => {
  let dir: string;
  let google: ReturnType<typeof fakeGoogle>;
  let pauses: number[];

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ppt-gmail-nogate-'));
    google = fakeGoogle();
    pauses = [];
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function make() {
    const store = createGmailCredentialStore({ privateRoot: dir, builtInClient: null });
    const service = createGmailConnection({
      redirectUri: REDIRECT, store, fetchImpl: google.fetch, endpoints: ENDPOINTS,
      now: () => Date.parse('2026-10-12T06:00:00Z'), sleep: async ms => { pauses.push(ms); },
    });
    service.saveClient(CLIENT);
    return { store, service };
  }
  const exchanges = () => google.calls.filter(call => call.form.grant_type === 'authorization_code');

  it('with a failed first connect on record, a new start → callback → exchange connects, saves the grant, and replaces the failure', async () => {
    const { service, store } = make();
    google.exchangeFailures = [connectFailure(), connectFailure()];
    const first = service.beginConnect();
    const failed = await service.completeSignIn({ code: 'old-code', state: queryOf(first.authUrl).get('state') });
    expect(failed.attempt).toMatchObject({ kind: 'network', ok: false });
    expect(service.status().pageSignIn).toMatchObject({ kind: 'network' });
    expect(store.read().accounts).toEqual([]);
    const before = exchanges().length;

    // The failure is still on record. A new start is not refused…
    const second = service.beginConnect();
    const state = queryOf(second.authUrl).get('state');
    expect(state).not.toBe(queryOf(first.authUrl).get('state'));
    expect(service.status().pageSignIn).toMatchObject({ kind: 'network' });
    // …and its callback runs its own exchange with its own code and verifier.
    const done = await service.completeSignIn({ code: 'new-code', state });
    expect(done).toMatchObject({ connected: true, accountId: 'default', replay: false, attempt: { action: 'gmail_connect', kind: 'ok', ok: true } });
    expect(exchanges().length - before).toBe(1);
    const exchange = exchanges().at(-1)!;
    expect(exchange.form.code).toBe('new-code');
    expect(createHash('sha256').update(exchange.form.code_verifier).digest('base64url')).toBe(queryOf(second.authUrl).get('code_challenge'));
    expect(store.read().accounts[0].connection.refreshToken).toBe('refresh-1');
    expect(service.status()).toMatchObject({ connected: true, needsReconnect: false, lastError: null, pageSignIn: null, signIn: { gmail: { kind: 'ok', ok: true } } });
  });

  it('reads no recorded result anywhere on the connect path: beginConnect and completeSignIn only write results', () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'src/core/gmail-connection.ts'), 'utf8');
    const start = source.indexOf('    beginConnect(options = {}) {');
    const end = source.indexOf('    async completeConnect(query) {');
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const connectPath = source.slice(start, end);
    // The readers of a result are status(), summary(), and the helpers they use; the connect path calls none of them.
    for (const reader of ['signInView(', 'pageSignIn(', 'visibleAttempt(', 'isVisible(', 'attempts.get(', 'attempts.has(', '.signIn', 'pageSignIn']) {
      expect(connectPath, `the connect path must not read ${reader}`).not.toContain(reader);
    }
    // The only reader of the attempts map is the visibility helper.
    expect(source.match(/attempts\.get\(/g)).toHaveLength(1);
    expect(source.match(/\bsignInError\b/g)).toBeNull();
  });

  it('with a stale failed Drive attempt on record, a new Connect Google Drive start → callback → exchange connects Drive and replaces the failure', async () => {
    const { service, store } = make();
    const gmail = service.beginConnect();
    await service.completeSignIn({ code: 'gmail-code', state: queryOf(gmail.authUrl).get('state') });

    // The owner's two attempts: both lost to the connect limit, so a failure notice is on record.
    google.exchangeFailures = [connectFailure(), connectFailure()];
    const lost = service.beginConnect({ accountId: 'default', purpose: 'drive' });
    const failed = await service.completeSignIn({ code: 'lost-code', state: queryOf(lost.authUrl).get('state') });
    expect(failed.attempt).toMatchObject({ action: 'drive_connect', kind: 'network', ok: false });
    expect(service.status().signIn.drive).toMatchObject({ kind: 'network' });
    expect(service.accounts()[0]).toMatchObject({ canReadDrive: false, canPublishDrive: false, drive: null });
    const before = exchanges().length;

    // With the notice still visible a new Drive start is accepted and asks for both Drive scopes.
    google.grantScope = WITH_DRIVE;
    const retry = service.beginConnect({ accountId: 'default', purpose: 'drive' });
    expect(queryOf(retry.authUrl).get('scope')).toContain(GDRIVE_READONLY_SCOPE);
    expect(queryOf(retry.authUrl).get('scope')).toContain(GDRIVE_FILE_SCOPE);
    expect(service.status().signIn.drive).toMatchObject({ kind: 'network' });
    const done = await service.completeSignIn({ code: 'retry-code', state: queryOf(retry.authUrl).get('state') });

    expect(done).toMatchObject({ connected: true, accountId: 'default', attempt: { action: 'drive_connect', kind: 'ok', ok: true } });
    expect(exchanges().length - before).toBe(1);
    expect(exchanges().at(-1)!.form.code).toBe('retry-code');
    expect(service.accounts()[0]).toMatchObject({ canReadDrive: true, canPublishDrive: true, drive: { enabled: true } });
    expect(store.read().accounts[0].connection.scope).toContain(GDRIVE_FILE_SCOPE);
    expect(service.status().signIn.drive).toMatchObject({ kind: 'ok', ok: true });
    expect(pauses).toEqual([1500]);
  });
});
