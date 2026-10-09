/**
 * Gmail connection: the active OAuth client (the owner's own; a built-in client
 * only if gmail-builtin-client.ts is filled, and it ships empty), the PKCE
 * loopback sign-in, and the access-token cache the sync and the chat tools use
 * (GMAIL_API_INTEGRATION_PLAN.md §7–8, GMAIL_CHAT_TOOLS_PLAN.md §7, D12).
 *
 * Sign-in: `beginConnect` mints a single-use `state` and a PKCE verifier
 * (memory only, 10-minute life) and returns Google's consent URL for
 * gmail.readonly + gmail.compose. Google sends the browser back to BotBoy's
 * loopback callback; `completeConnect` accepts only a live state, exchanges
 * the code with that state's verifier, requires a refresh token and the
 * gmail.readonly grant (compose is optional: Google lets the owner untick
 * it), reads the account address from Gmail itself, and only then stores the
 * connection with the scopes Google actually granted.
 *
 * Access tokens live in memory and refresh on demand (single flight). A
 * refresh rejected by Google (`invalid_grant`: revoked, expired Testing-mode
 * grant, password change) marks the connection as needing a reconnect; the
 * stored grant is kept so the page still names the account.
 */

import {
  GMAIL_COMPOSE_SCOPE,
  GMAIL_READONLY_SCOPE,
  GMAIL_REQUESTED_SCOPES,
  GOOGLE_ENDPOINTS,
  GoogleApiError,
  buildAuthorizationUrl,
  createGmailClient,
  createOAuthState,
  createPkcePair,
  exchangeAuthorizationCode,
  refreshAccessToken,
  revokeToken,
  type FetchLike,
  type GmailClient,
  type GoogleEndpoints,
} from './gmail-api.js';
import { randomBytes } from 'node:crypto';
import {
  GMAIL_DEFAULT_ACCOUNT_ID,
  activeGmailClient,
  cleanAccountLabel,
  clientIdSuffix,
  createGmailCredentialStore,
  removeStagedTeamClient,
  validateGmailClient,
  type GmailClientSource,
  type GmailCredentialStore,
  type StoredGmailAccount,
  type StoredGmailCredentials,
} from './gmail-credentials.js';

const STATE_TTL_MS = 10 * 60_000;
const MAX_PENDING_STATES = 5;
const ACCESS_TOKEN_SKEW_MS = 60_000;

export interface GmailConnectionStatus {
  /** A client BotBoy can sign in with exists (own or team). */
  clientConfigured: boolean;
  /** Which client is active: the owner's own, or a filled built-in slot. */
  clientSource: GmailClientSource | null;
  /** A built-in client exists (active unless an own client is saved); false on shipped installs (D12). */
  teamClientAvailable: boolean;
  ownClientConfigured: boolean;
  /** Last characters of the active client ID, never the secret. */
  clientIdSuffix: string | null;
  connected: boolean;
  accountEmail: string | null;
  connectedAt: string | null;
  /** True after Google rejected the stored grant; Reconnect fixes it. */
  needsReconnect: boolean;
  /** Owner-safe text of the last failed sign-in or refresh. */
  lastError: string | null;
  /** Every connected account (the fields above describe the first). */
  accounts: GmailAccountSummary[];
  /** The loopback address Google returns to (shown in setup help). */
  redirectUri: string;
  /** The scopes every sign-in requests, space-separated. */
  scope: string;
  /** What Google granted this connection (empty when not connected). */
  grantedScopes: string[];
  /** The grant covers drafts and sending (gmail.compose). */
  canCompose: boolean;
  /** Connected with read access only: Reconnect to allow drafting and sending. */
  needsComposeGrant: boolean;
}

/** Thrown when there is no usable grant; the message names the next action. */
export class GmailAuthError extends Error {
  constructor(message: string, readonly code: 'not_connected' | 'reconnect_required') {
    super(message);
    this.name = 'GmailAuthError';
  }
}

/** One connected account, as the page, the sync, and the chat tools see it. */
export interface GmailAccountSummary {
  id: string;
  /** The owner's name for it ("Work", "Personal"); '' when unset. */
  label: string;
  email: string;
  connectedAt: string | null;
  needsReconnect: boolean;
  lastError: string | null;
  grantedScopes: string[];
  canCompose: boolean;
  needsComposeGrant: boolean;
}

/** "Work (me@x.com)" or the address alone. */
export function gmailAccountName(account: { label: string; email: string }): string {
  return account.label ? `${account.label} (${account.email})` : account.email;
}

/** One account's tokens and client (the sync, compose, and chat tools use these). */
export interface GmailAccountConnection {
  readonly id: string;
  label(): string;
  status(): GmailConnectionStatus;
  isConnected(): boolean;
  accountEmail(): string | null;
  /** The stored grant includes gmail.compose (drafts and sending). */
  canCompose(): boolean;
  accessToken(): Promise<string>;
  invalidateAccessToken(): void;
  /** A Gmail REST client bound to this account's tokens. */
  client(): GmailClient;
  /** Changes on every connection change (any account, client save). */
  version(): number;
  /** Listeners run after any connect/disconnect/label change. */
  onChange(listener: () => void): () => void;
}

/**
 * Every connected account on one Google client (GMAIL_API_INTEGRATION_PLAN.md
 * §13). The account methods (status, client, accessToken, …) act on the first
 * account, which keeps one-account callers unchanged; `account(selector)`
 * returns any account by id, address, or label.
 */
export interface GmailConnection extends GmailAccountConnection {
  /** Saves the owner's own client (Advanced); it becomes the active client. */
  saveClient(input: { clientId?: unknown; clientSecret?: unknown }): GmailConnectionStatus;
  /**
   * Removes the own client. A built-in client, if the slot is filled, becomes
   * active; connections made with another client ID are revoked and dropped.
   */
  removeClient(): Promise<GmailConnectionStatus>;
  /**
   * Boot step: deletes a shared client an older credential-file import staged
   * (never applied: that delivery is retired, D11/D12). True when a file was
   * removed.
   */
  retireStagedTeamClient(): boolean;
  /** Reconnect `accountId`, add another account (`addAccount`), or connect the first one. */
  beginConnect(options?: { accountId?: string; addAccount?: boolean }): { authUrl: string };
  completeConnect(query: { code?: unknown; state?: unknown; error?: unknown }): Promise<
    { ok: true; accountEmail: string; accountId: string } | { ok: false; error: string }
  >;
  /** Disconnects one account (default: the first). Captured mail stays. */
  disconnect(accountId?: string): Promise<GmailConnectionStatus>;
  accounts(): GmailAccountSummary[];
  /** An account by id, address, or label (case-insensitive); null when none matches. */
  account(selector: string): GmailAccountConnection | null;
  /** The view of one account id whether or not it is connected now (the sync's slot). */
  slot(accountId: string): GmailAccountConnection;
  setLabel(accountId: string, label: unknown): GmailConnectionStatus;
}

/** A rejected client is fixed by whoever owns it: a BotBoy update for a filled built-in slot. */
function rejectedClientAdvice(source: GmailClientSource): string {
  return source === 'team'
    ? 'Google rejected BotBoy’s built-in Google client. Update BotBoy (./start.sh --update), then Reconnect; or add your own client under Advanced.'
    : 'Google rejected the OAuth client. Check the client ID and secret, then Reconnect.';
}

export function createGmailConnection(deps: {
  redirectUri: string;
  store?: GmailCredentialStore;
  privateRoot?: string;
  fetchImpl?: FetchLike;
  endpoints?: GoogleEndpoints;
  now?: () => number;
  /** New account ids (tests pin them). */
  newAccountId?: () => string;
}): GmailConnection {
  const store = deps.store ?? createGmailCredentialStore({ privateRoot: deps.privateRoot });
  const fetchImpl: FetchLike = deps.fetchImpl ?? ((input, init) => fetch(input, init));
  const endpoints = deps.endpoints ?? GOOGLE_ENDPOINTS;
  const now = deps.now ?? Date.now;
  const newAccountId = deps.newAccountId ?? (() => `ga_${randomBytes(5).toString('hex')}`);
  /** A sign-in in progress and what it is for: reconnect one account, or add one. */
  const pending = new Map<string, { verifier: string; createdAt: number; accountId?: string }>();
  const listeners = new Set<() => void>();

  /** Per-account runtime state (memory only). */
  interface Runtime {
    access: { token: string; expiresAt: number } | null;
    refreshing: Promise<string> | null;
    needsReconnect: boolean;
    lastError: string | null;
  }
  const runtimes = new Map<string, Runtime>();
  const runtime = (accountId: string): Runtime => {
    let entry = runtimes.get(accountId);
    if (!entry) {
      entry = { access: null, refreshing: null, needsReconnect: false, lastError: null };
      runtimes.set(accountId, entry);
    }
    return entry;
  };
  /** The last failed sign-in (no account yet). */
  let signInError: string | null = null;
  let version = 1;

  function changed(): void {
    version++;
    for (const listener of listeners) {
      try { listener(); } catch (error) {
        console.warn(`[Gmail] connection listener failed: ${(error as Error)?.message ?? error}`);
      }
    }
  }

  function prunePending(): void {
    const cutoff = now() - STATE_TTL_MS;
    for (const [state, entry] of pending) {
      if (entry.createdAt < cutoff) pending.delete(state);
    }
  }

  /** The own client, else the store's usable built-in one (none when the slot is empty). */
  const activeOf = (stored: StoredGmailCredentials) => activeGmailClient(stored, store.builtInClient);
  const scopesOf = (account: StoredGmailAccount | undefined): string[] => (account ? account.connection.scope.split(/\s+/).filter(Boolean) : []);
  const storedAccount = (accountId: string): StoredGmailAccount | undefined => store.read().accounts.find(account => account.id === accountId);
  const firstAccount = (): StoredGmailAccount | undefined => store.read().accounts[0];

  function summary(account: StoredGmailAccount): GmailAccountSummary {
    const granted = scopesOf(account);
    const canCompose = granted.includes(GMAIL_COMPOSE_SCOPE);
    const state = runtime(account.id);
    return {
      id: account.id,
      label: account.label,
      email: account.connection.accountEmail,
      connectedAt: account.connection.connectedAt || null,
      needsReconnect: state.needsReconnect,
      lastError: state.lastError,
      grantedScopes: granted,
      canCompose,
      needsComposeGrant: !canCompose,
    };
  }

  /** The page's status; the account fields describe `focus` (default: the first account). */
  function status(focus?: StoredGmailAccount): GmailConnectionStatus {
    const stored = store.read();
    const active = activeOf(stored);
    const account = focus ?? stored.accounts[0];
    const granted = scopesOf(account);
    const canCompose = granted.includes(GMAIL_COMPOSE_SCOPE);
    const state = account ? runtime(account.id) : null;
    return {
      clientConfigured: Boolean(active),
      clientSource: active?.source ?? null,
      teamClientAvailable: Boolean(store.builtInClient),
      ownClientConfigured: Boolean(stored.client),
      clientIdSuffix: active ? clientIdSuffix(active.client.clientId) : null,
      connected: Boolean(account),
      accountEmail: account?.connection.accountEmail ?? null,
      connectedAt: account?.connection.connectedAt || null,
      needsReconnect: Boolean(state?.needsReconnect),
      lastError: state?.lastError ?? signInError,
      accounts: stored.accounts.map(summary),
      redirectUri: deps.redirectUri,
      scope: GMAIL_REQUESTED_SCOPES.join(' '),
      grantedScopes: granted,
      canCompose,
      needsComposeGrant: Boolean(account) && !canCompose,
    };
  }

  /**
   * After any client change: dropped connections are revoked at Google (best
   * effort; the grant rule already removed them locally), and sign-ins started
   * with another client ID are void.
   */
  function afterClientChange(before: StoredGmailCredentials): Promise<void> {
    const after = store.read();
    if (activeOf(before)?.client.clientId !== activeOf(after)?.client.clientId) pending.clear();
    signInError = null;
    for (const state of runtimes.values()) { state.needsReconnect = false; state.lastError = null; }
    const kept = new Set(after.accounts.map(account => account.id));
    const dropped = before.accounts.filter(account => !kept.has(account.id));
    if (!dropped.length) return Promise.resolve();
    for (const account of dropped) runtimes.delete(account.id);
    return Promise.all(dropped.map(account => revokeToken(fetchImpl, endpoints, account.connection.refreshToken).then(() => undefined, (error) => {
      console.warn(`[Gmail] revoke at Google failed (local grant removed anyway): ${(error as Error)?.message ?? error}`);
    }))).then(() => undefined);
  }

  async function revokeAccount(account: StoredGmailAccount): Promise<void> {
    try {
      await revokeToken(fetchImpl, endpoints, account.connection.refreshToken);
    } catch (error) {
      // The grant is deleted locally either way; the owner can also remove
      // BotBoy at myaccount.google.com → Security → Third-party connections.
      console.warn(`[Gmail] revoke at Google failed (local grant removed anyway): ${(error as Error)?.message ?? error}`);
    }
  }

  async function refresh(accountId: string): Promise<string> {
    const stored = store.read();
    const active = activeOf(stored);
    const account = stored.accounts.find(entry => entry.id === accountId);
    const state = runtime(accountId);
    if (!active || !account) {
      throw new GmailAuthError('Gmail is not connected. Open Connections → Gmail and connect your account.', 'not_connected');
    }
    try {
      const tokens = await refreshAccessToken(fetchImpl, endpoints, {
        clientId: active.client.clientId,
        clientSecret: active.client.clientSecret,
        refreshToken: account.connection.refreshToken,
      });
      state.access = { token: tokens.accessToken, expiresAt: now() + tokens.expiresInSeconds * 1000 };
      if (state.needsReconnect) { state.needsReconnect = false; changed(); }
      state.lastError = null;
      return tokens.accessToken;
    } catch (error) {
      if (error instanceof GoogleApiError && ['invalid_grant', 'invalid_client', 'unauthorized_client'].includes(error.code)) {
        if (!state.needsReconnect) { state.needsReconnect = true; changed(); }
        state.lastError = error.code === 'invalid_grant'
          ? `Google ended BotBoy’s access to ${gmailAccountName({ label: account.label, email: account.connection.accountEmail })} (revoked, expired, or the password changed). Choose Reconnect.`
          : rejectedClientAdvice(active.source);
        throw new GmailAuthError(`${error.message}. ${state.lastError}`, 'reconnect_required');
      }
      throw error;
    }
  }

  function accountView(accountId: string): GmailAccountConnection {
    const view: GmailAccountConnection = {
      id: accountId,
      label: () => storedAccount(accountId)?.label ?? '',
      status: () => status(storedAccount(accountId)),
      isConnected: () => Boolean(storedAccount(accountId)),
      accountEmail: () => storedAccount(accountId)?.connection.accountEmail ?? null,
      canCompose: () => scopesOf(storedAccount(accountId)).includes(GMAIL_COMPOSE_SCOPE),
      async accessToken() {
        const state = runtime(accountId);
        if (state.access && state.access.expiresAt - ACCESS_TOKEN_SKEW_MS > now()) return state.access.token;
        if (!state.refreshing) {
          state.refreshing = refresh(accountId).finally(() => { state.refreshing = null; });
        }
        return state.refreshing;
      },
      invalidateAccessToken() {
        runtime(accountId).access = null;
      },
      client() {
        return createGmailClient({
          fetchImpl,
          endpoints,
          accessToken: () => view.accessToken(),
          invalidateAccessToken: () => view.invalidateAccessToken(),
        });
      },
      version: () => version,
      onChange(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
    return view;
  }

  /** The first account's view; with no account it reads as not connected. */
  const primaryId = (): string => firstAccount()?.id ?? GMAIL_DEFAULT_ACCOUNT_ID;

  function findAccount(selector: string): StoredGmailAccount | undefined {
    const wanted = String(selector ?? '').trim().toLowerCase();
    if (!wanted) return undefined;
    const accounts = store.read().accounts;
    return accounts.find(account => account.id === wanted)
      ?? accounts.find(account => account.connection.accountEmail === wanted)
      ?? accounts.find(account => account.label && account.label.toLowerCase() === wanted);
  }

  const service: GmailConnection = {
    get id() { return primaryId(); },
    label: () => firstAccount()?.label ?? '',
    status: () => status(),
    isConnected: () => Boolean(firstAccount()),
    accountEmail: () => firstAccount()?.connection.accountEmail ?? null,
    canCompose: () => scopesOf(firstAccount()).includes(GMAIL_COMPOSE_SCOPE),
    accessToken: () => accountView(primaryId()).accessToken(),
    invalidateAccessToken: () => accountView(primaryId()).invalidateAccessToken(),
    client: () => accountView(primaryId()).client(),

    accounts: () => store.read().accounts.map(summary),
    account(selector) {
      const found = findAccount(selector);
      return found ? accountView(found.id) : null;
    },

    slot: (accountId) => accountView(accountId),

    setLabel(accountId, label) {
      if (!storedAccount(accountId)) throw new GmailAuthError('That Gmail account is not connected.', 'not_connected');
      store.setLabel(accountId, cleanAccountLabel(label));
      changed();
      return status();
    },

    saveClient(input) {
      const client = validateGmailClient(input);
      const before = store.read();
      store.saveClient(client);
      // A grant made with another client ID cannot refresh any more; it is
      // revoked at Google too (best effort, no wait).
      void afterClientChange(before);
      changed();
      return status();
    },

    async removeClient() {
      const before = store.read();
      store.removeOwnClient();
      await afterClientChange(before);
      changed();
      return status();
    },

    retireStagedTeamClient() {
      const removed = removeStagedTeamClient(store.privateRoot);
      if (removed) console.log('[Gmail] Removed a Google client staged by an older credential-file import; Gmail uses the client saved in Connections → Gmail.');
      return removed;
    },

    beginConnect(options = {}) {
      const stored = store.read();
      const active = activeOf(stored);
      if (!active) {
        throw new GmailAuthError('Gmail has no Google client. Add your own client in Connections → Gmail.', 'not_connected');
      }
      const target = options.addAccount
        ? undefined
        : options.accountId
          ? stored.accounts.find(account => account.id === options.accountId)
          : stored.accounts[0];
      if (options.accountId && !options.addAccount && !target) {
        throw new GmailAuthError('That Gmail account is not connected.', 'not_connected');
      }
      prunePending();
      while (pending.size >= MAX_PENDING_STATES) {
        const oldest = pending.keys().next().value;
        if (oldest === undefined) break;
        pending.delete(oldest);
      }
      const state = createOAuthState();
      const pkce = createPkcePair();
      pending.set(state, { verifier: pkce.verifier, createdAt: now(), ...(target ? { accountId: target.id } : {}) });
      return {
        authUrl: buildAuthorizationUrl(endpoints, {
          clientId: active.client.clientId,
          redirectUri: deps.redirectUri,
          state,
          codeChallenge: pkce.challenge,
          loginHint: target?.connection.accountEmail,
          selectAccount: Boolean(options.addAccount),
        }),
      };
    },

    async completeConnect(query) {
      prunePending();
      const state = typeof query.state === 'string' ? query.state : '';
      const entry = state ? pending.get(state) : undefined;
      // Single use: a replayed or forged callback finds nothing.
      if (state) pending.delete(state);
      const fail = (error: string) => {
        signInError = error;
        changed();
        return { ok: false as const, error };
      };
      if (!entry) return fail('That sign-in link expired or was already used. Choose Connect again.');
      if (typeof query.error === 'string' && query.error) {
        return fail(query.error === 'access_denied'
          ? 'Google sign-in was cancelled, so nothing changed.'
          : query.error === 'admin_policy_enforced' || query.error === 'org_internal'
            ? 'This Google account’s organization does not allow BotBoy’s Google client (a Workspace admin policy). Use another account, or ask the admin to allow the client.'
            : `Google sign-in did not finish (${query.error.replace(/[^a-z_]/gi, '').slice(0, 40)}).`);
      }
      const code = typeof query.code === 'string' ? query.code : '';
      if (!code) return fail('Google returned no authorization code. Choose Connect again.');
      const active = activeOf(store.read());
      if (!active) return fail('The Google client was removed during sign-in. Connect again once a client is set up.');
      try {
        const tokens = await exchangeAuthorizationCode(fetchImpl, endpoints, {
          clientId: active.client.clientId,
          clientSecret: active.client.clientSecret,
          code,
          codeVerifier: entry.verifier,
          redirectUri: deps.redirectUri,
        });
        const granted = tokens.scope.split(/\s+/).filter(Boolean);
        if (!granted.includes(GMAIL_READONLY_SCOPE)) {
          return fail('Google did not grant read access to Gmail. Connect again and allow "View your email messages and settings".');
        }
        if (!tokens.refreshToken) {
          return fail('Google returned no refresh token. Remove BotBoy at myaccount.google.com → Security → Third-party connections, then connect again.');
        }
        // The account comes from Gmail itself, never from the browser.
        const probe = createGmailClient({
          fetchImpl,
          endpoints,
          accessToken: async () => tokens.accessToken,
          invalidateAccessToken: () => {},
        });
        const profile = await probe.getProfile();
        const email = profile.emailAddress.toLowerCase();
        const accounts = store.read().accounts;
        // The address decides the account: signing in to one already
        // connected replaces its token (Google revokes a whole grant, so
        // nothing is revoked); a new address adds an account, even when the
        // sign-in started as a Reconnect of another one.
        const existing = accounts.find(account => account.connection.accountEmail === email);
        const accountId = existing?.id ?? (accounts.length ? newAccountId() : GMAIL_DEFAULT_ACCOUNT_ID);
        store.saveConnection(accountId, { refreshToken: tokens.refreshToken, accountEmail: email, scope: granted.join(' ') });
        const fresh = runtime(accountId);
        fresh.access = { token: tokens.accessToken, expiresAt: now() + tokens.expiresInSeconds * 1000 };
        fresh.needsReconnect = false;
        fresh.lastError = null;
        signInError = null;
        changed();
        console.log(`[Gmail] ${existing ? 'Reconnected' : 'Connected'} ${email} as account ${accountId} (${active.source} client ${clientIdSuffix(active.client.clientId)}; ${granted.includes(GMAIL_COMPOSE_SCOPE) ? 'read + compose' : 'read only'})`);
        return { ok: true, accountEmail: email, accountId };
      } catch (error) {
        const message = error instanceof GoogleApiError
          ? (error.code === 'redirect_uri_mismatch' || error.code === 'invalid_client'
            ? (active.source === 'team'
              ? `${error.message}. ${rejectedClientAdvice('team')}`
              : `${error.message}. Use a Desktop app OAuth client (Google Cloud → Clients → Create client → Desktop app).`)
            : error.message)
          : 'Connecting Gmail failed unexpectedly. Choose Connect again.';
        return fail(message);
      }
    },

    async disconnect(accountId) {
      const account = accountId ? storedAccount(accountId) : firstAccount();
      if (account) {
        await revokeAccount(account);
        store.clearConnection(account.id);
        runtimes.delete(account.id);
      }
      signInError = null;
      changed();
      return status();
    },

    version: () => version,

    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return service;
}
