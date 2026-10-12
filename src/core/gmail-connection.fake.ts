/**
 * Test double for GmailConnection with one or more accounts (tests only).
 * Each account's fields are read live through getters, so a test can flip
 * `connected`, `canCompose`, or `needsReconnect` between calls.
 */
import type { GmailClient } from './gmail-api.js';
import type { StoredDriveSettings } from './gmail-credentials.js';
import type { GmailAccountConnection, GmailAccountSummary, GmailConnection } from './gmail-connection.js';

export interface FakeGmailAccount {
  id: string;
  email: string;
  label?: string;
  connected?: boolean;
  canCompose?: boolean;
  needsReconnect?: boolean;
  canReadDrive?: boolean;
  canPublishDrive?: boolean;
  drive?: StoredDriveSettings | null;
  client: GmailClient;
}

export function fakeGmailConnection(accounts: FakeGmailAccount[]): GmailConnection {
  const live = () => accounts.filter(account => account.connected !== false);
  const summary = (account: FakeGmailAccount): GmailAccountSummary => ({
    id: account.id,
    label: account.label ?? '',
    email: account.email,
    connectedAt: null,
    needsReconnect: account.needsReconnect === true,
    lastError: null,
    signIn: { gmail: null, drive: null },
    grantedScopes: [],
    canCompose: account.canCompose !== false,
    needsComposeGrant: account.canCompose === false,
    canReadDrive: account.canReadDrive === true,
    canPublishDrive: account.canPublishDrive === true,
    drive: account.drive ?? null,
  });
  const view = (account: FakeGmailAccount): GmailAccountConnection => ({
    id: account.id,
    label: () => account.label ?? '',
    status: () => ({
      needsReconnect: account.needsReconnect === true, connected: account.connected !== false, accountEmail: account.email,
      lastError: null, signIn: { gmail: null, drive: null }, pageSignIn: null,
    } as any),
    isConnected: () => account.connected !== false,
    accountEmail: () => (account.connected !== false ? account.email : null),
    canCompose: () => account.canCompose !== false,
    canReadDrive: () => account.canReadDrive === true,
    canPublishDrive: () => account.canPublishDrive === true,
    drive: () => account.drive ?? null,
    accessToken: async () => 'token',
    invalidateAccessToken: () => {},
    client: () => account.client,
    version: () => 1,
    onChange: () => () => {},
  });
  const find = (selector: string) => {
    const wanted = String(selector ?? '').trim().toLowerCase();
    return live().find(account => account.id === wanted)
      ?? live().find(account => account.email === wanted)
      ?? live().find(account => (account.label ?? '').toLowerCase() === wanted && wanted !== '');
  };
  const primary = () => live()[0] ?? accounts[0];
  return {
    get id() { return primary()?.id ?? 'default'; },
    label: () => primary()?.label ?? '',
    status: () => view(primary()).status(),
    isConnected: () => live().length > 0,
    accountEmail: () => live()[0]?.email ?? null,
    canCompose: () => live()[0]?.canCompose !== false,
    accessToken: async () => 'token',
    invalidateAccessToken: () => {},
    client: () => primary().client,
    version: () => 1,
    onChange: () => () => {},
    accounts: () => live().map(summary),
    account: (selector: string) => {
      const found = find(selector);
      return found ? view(found) : null;
    },
    slot: (accountId: string) => view(accounts.find(account => account.id === accountId) ?? primary()),
    setLabel: () => { throw new Error('not in the fake'); },
    setDriveSettings: (accountId: string, drive: StoredDriveSettings) => {
      const found = accounts.find(account => account.id === accountId);
      if (found) found.drive = drive;
      return {} as any;
    },
    saveClient: () => { throw new Error('not in the fake'); },
    removeClient: async () => { throw new Error('not in the fake'); },
    retireStagedTeamClient: () => false,
    beginConnect: () => { throw new Error('not in the fake'); },
    completeConnect: async () => ({ ok: false, error: 'not in the fake' }),
    completeSignIn: async () => ({ connected: false, accountId: null, accountEmail: null, attempt: null, replay: true }),
    dismissSignIn: () => { throw new Error('not in the fake'); },
    disconnect: async () => { throw new Error('not in the fake'); },
  } as unknown as GmailConnection;
}
