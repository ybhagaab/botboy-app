import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GMAIL_COMPOSE_SCOPE, GMAIL_READONLY_SCOPE, GMAIL_REQUESTED_SCOPES, buildAuthorizationUrl, type GoogleEndpoints } from './gmail-api.js';
import { createGmailConnection } from './gmail-connection.js';
import { createGmailCredentialStore, parseDriveSettings } from './gmail-credentials.js';
import { GDRIVE_FILE_SCOPE, GDRIVE_READONLY_SCOPE } from './gdrive-api.js';

const CLIENT = { clientId: '1234567890-abcdefghijkl.apps.googleusercontent.com', clientSecret: 'GOCSPX-test-secret-value' };
const ENDPOINTS: GoogleEndpoints = {
  authUrl: 'https://accounts.test/o/oauth2/v2/auth',
  tokenUrl: 'https://oauth.test/token',
  revokeUrl: 'https://oauth.test/revoke',
  apiBase: 'https://gmail.test',
};
const REDIRECT = 'http://127.0.0.1:7778/api/gmail-sync/oauth/callback';
const GMAIL_ONLY = `${GMAIL_READONLY_SCOPE} ${GMAIL_COMPOSE_SCOPE}`;
const WITH_DRIVE = `${GMAIL_ONLY} ${GDRIVE_READONLY_SCOPE} ${GDRIVE_FILE_SCOPE}`;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('Gmail auth URL stays byte-identical without Drive', () => {
  it('default scopes are Gmail only, no include_granted_scopes', () => {
    const url = new URL(buildAuthorizationUrl(ENDPOINTS, { clientId: 'c', redirectUri: REDIRECT, state: 's', codeChallenge: 'x' }));
    expect(url.searchParams.get('scope')).toBe(GMAIL_REQUESTED_SCOPES.join(' '));
    expect(url.searchParams.has('include_granted_scopes')).toBe(false);
  });
});

describe('Connect Google Drive (incremental grant on the Gmail account)', () => {
  let dir: string;
  let grantScope: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ppt-gmail-drive-'));
    grantScope = GMAIL_ONLY;
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
  const fetchImpl = async (input: string, init?: RequestInit) => {
    const form = typeof init?.body === 'string' ? Object.fromEntries(new URLSearchParams(init.body)) : {};
    if (input === ENDPOINTS.tokenUrl && form.grant_type === 'authorization_code') {
      return json({ access_token: 'access-1', expires_in: 3600, scope: grantScope, refresh_token: 'refresh-1' });
    }
    if (input === ENDPOINTS.revokeUrl) return json({});
    if (input.startsWith(`${ENDPOINTS.apiBase}/gmail/v1/users/me/profile`)) return json({ emailAddress: 'jane@gmail.com', historyId: '1' });
    return json({ error: { code: 404 } }, 404);
  };
  const make = () => {
    const store = createGmailCredentialStore({ privateRoot: dir, builtInClient: null });
    const service = createGmailConnection({ redirectUri: REDIRECT, store, fetchImpl: fetchImpl as any, endpoints: ENDPOINTS });
    service.saveClient(CLIENT);
    return { store, service };
  };
  const sign = async (service: ReturnType<typeof make>['service'], options?: Parameters<ReturnType<typeof make>['service']['beginConnect']>[0]) => {
    const { authUrl } = service.beginConnect(options);
    const outcome = await service.completeConnect({ code: 'code', state: new URL(authUrl).searchParams.get('state') });
    return { authUrl: new URL(authUrl), outcome };
  };

  it('an old Gmail-only grant cannot read Drive and keeps working (Reconnect path)', async () => {
    const { service } = make();
    await sign(service);
    const [account] = service.accounts();
    expect(account).toMatchObject({ canReadDrive: false, canPublishDrive: false, drive: null, canCompose: true });
    expect(service.slot(account.id).canReadDrive()).toBe(false);
  });

  it('the Drive URL carries both scope sets, include_granted_scopes, and login_hint; the grant flips capabilities', async () => {
    const { service, store } = make();
    await sign(service);
    grantScope = WITH_DRIVE;
    const { authUrl, outcome } = await sign(service, { accountId: 'default', purpose: 'drive' });
    expect(authUrl.searchParams.get('scope')!.split(' ')).toEqual([...GMAIL_REQUESTED_SCOPES, GDRIVE_READONLY_SCOPE, GDRIVE_FILE_SCOPE]);
    expect(authUrl.searchParams.get('include_granted_scopes')).toBe('true');
    expect(authUrl.searchParams.get('login_hint')).toBe('jane@gmail.com');
    expect(outcome.ok).toBe(true);
    const [account] = service.accounts();
    expect(account).toMatchObject({ canReadDrive: true, canPublishDrive: true, lastError: null });
    expect(account.drive).toEqual({ enabled: true, sources: { ownedByMe: false, sharedWithMe: false, folderIds: [] } });
    expect(store.read().accounts[0].drive?.enabled).toBe(true);
  });

  it('a partial grant keeps Gmail and says Drive was not granted', async () => {
    const { service } = make();
    await sign(service);
    grantScope = `${GMAIL_ONLY} ${GDRIVE_READONLY_SCOPE}`;
    const { outcome } = await sign(service, { accountId: 'default', purpose: 'drive' });
    expect(outcome.ok).toBe(true);
    const [account] = service.accounts();
    expect(account.canReadDrive).toBe(true);
    expect(account.canPublishDrive).toBe(false);
    // The partial grant is a sign-in result for the Drive section, not a connection error.
    expect(account.lastError).toBeNull();
    expect(account.signIn.drive).toMatchObject({ action: 'drive_connect', kind: 'drive_not_granted', ok: false, accountId: 'default', message: expect.stringMatching(/Drive not granted/) });
    expect(account.drive).toBeNull();
  });

  it('a later Gmail Reconnect of a Drive account asks for Drive again', async () => {
    const { service } = make();
    await sign(service);
    grantScope = WITH_DRIVE;
    await sign(service, { accountId: 'default', purpose: 'drive' });
    const { authUrl } = await sign(service, { accountId: 'default' });
    expect(authUrl.searchParams.get('scope')).toContain(GDRIVE_READONLY_SCOPE);
  });

  it('drive settings survive every write: client save, label, reconnect, another account leaving', async () => {
    const { service, store } = make();
    await sign(service);
    grantScope = WITH_DRIVE;
    await sign(service, { accountId: 'default', purpose: 'drive' });
    const drive = { enabled: true, sources: { ownedByMe: true, sharedWithMe: false, folderIds: ['0AbCdEfGhIjKlMnOp'] } };
    service.setDriveSettings('default', drive);
    service.setLabel('default', 'Personal');
    service.saveClient(CLIENT); // same client id keeps the grant
    await sign(service, { accountId: 'default' });
    store.saveConnection('ga_0123456789', { refreshToken: 'r2', accountEmail: 'other@gmail.com', scope: GMAIL_ONLY });
    store.clearConnection('ga_0123456789');
    const reread = createGmailCredentialStore({ privateRoot: dir, builtInClient: null }).read();
    expect(reread.accounts[0].drive).toEqual(drive);
  });

  it('parseDriveSettings is strict', () => {
    expect(parseDriveSettings({ enabled: 'yes', sources: { ownedByMe: 1, folderIds: ['short', '0AbCdEfGhIjKlMnOp', '0AbCdEfGhIjKlMnOp', "bad'id-0000000"] } }))
      .toEqual({ enabled: false, sources: { ownedByMe: false, sharedWithMe: false, folderIds: ['0AbCdEfGhIjKlMnOp'] } });
    expect(parseDriveSettings(null)).toBeUndefined();
    const many = Array.from({ length: 60 }, (_, i) => `folder${String(i).padStart(6, '0')}`);
    expect(parseDriveSettings({ enabled: true, sources: { folderIds: many } })!.sources.folderIds).toHaveLength(50);
  });
});
