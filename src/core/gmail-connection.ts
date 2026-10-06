/**
 * Gmail connection: the active OAuth client (the owner's own, else BotBoy's
 * shared client from the credential file), the PKCE loopback sign-in, and the
 * access-token cache the sync and the chat tools use
 * (GMAIL_API_INTEGRATION_PLAN.md §7–8, GMAIL_CHAT_TOOLS_PLAN.md §7).
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
import {
  activeGmailClient,
  clientIdSuffix,
  createGmailCredentialStore,
  readStagedTeamClient,
  removeStagedTeamClient,
  validateGmailClient,
  type GmailClientSource,
  type GmailCredentialStore,
  type StoredGmailCredentials,
} from './gmail-credentials.js';

const STATE_TTL_MS = 10 * 60_000;
const MAX_PENDING_STATES = 5;
const ACCESS_TOKEN_SKEW_MS = 60_000;

export interface GmailConnectionStatus {
  /** A client BotBoy can sign in with exists (own or team). */
  clientConfigured: boolean;
  /** Which client is active: the owner's own (Advanced) or BotBoy's shared one. */
  clientSource: GmailClientSource | null;
  /** BotBoy's shared client arrived in the credential file (active unless an own client is saved). */
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

export interface GmailConnection {
  status(): GmailConnectionStatus;
  isConnected(): boolean;
  accountEmail(): string | null;
  /** The stored grant includes gmail.compose (drafts and sending). */
  canCompose(): boolean;
  /** Saves the owner's own client (Advanced); it becomes the active client. */
  saveClient(input: { clientId?: unknown; clientSecret?: unknown }): GmailConnectionStatus;
  /**
   * Removes the own client. BotBoy's shared client, if present, becomes
   * active; a connection made with another client ID is revoked and dropped.
   */
  removeClient(): Promise<GmailConnectionStatus>;
  /**
   * Boot step: moves BotBoy's shared client staged by the credential-file
   * import into the store and deletes the staged file. Never replaces an own
   * client.
   */
  applyStagedTeamClient(): { applied: boolean; reason?: 'none' | 'invalid' | 'unchanged' };
  beginConnect(): { authUrl: string };
  completeConnect(query: { code?: unknown; state?: unknown; error?: unknown }): Promise<
    { ok: true; accountEmail: string } | { ok: false; error: string }
  >;
  disconnect(): Promise<GmailConnectionStatus>;
  accessToken(): Promise<string>;
  invalidateAccessToken(): void;
  /** A Gmail REST client bound to this connection's tokens. */
  client(): GmailClient;
  /** Changes on every connection change (connect, disconnect, client save). */
  version(): number;
  /** Listeners run after connect/disconnect; the sync resets per-account state. */
  onChange(listener: () => void): () => void;
}

/** A rejected client is fixed by whoever owns it: the owner for the shared client. */
function rejectedClientAdvice(source: GmailClientSource): string {
  return source === 'team'
    ? 'Google rejected BotBoy’s shared Google client. Ask the BotBoy owner for a new credential file, then Reconnect.'
    : 'Google rejected the OAuth client. Check the client ID and secret, then Reconnect.';
}

export function createGmailConnection(deps: {
  redirectUri: string;
  store?: GmailCredentialStore;
  privateRoot?: string;
  fetchImpl?: FetchLike;
  endpoints?: GoogleEndpoints;
  now?: () => number;
}): GmailConnection {
  const store = deps.store ?? createGmailCredentialStore({ privateRoot: deps.privateRoot });
  const fetchImpl: FetchLike = deps.fetchImpl ?? ((input, init) => fetch(input, init));
  const endpoints = deps.endpoints ?? GOOGLE_ENDPOINTS;
  const now = deps.now ?? Date.now;
  const pending = new Map<string, { verifier: string; createdAt: number }>();
  const listeners = new Set<() => void>();

  let access: { token: string; expiresAt: number } | null = null;
  let refreshing: Promise<string> | null = null;
  let needsReconnect = false;
  let lastError: string | null = null;
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

  function grantedScopes(stored: StoredGmailCredentials): string[] {
    return stored.connection ? stored.connection.scope.split(/\s+/).filter(Boolean) : [];
  }

  function status(): GmailConnectionStatus {
    const stored = store.read();
    const active = activeGmailClient(stored);
    const granted = grantedScopes(stored);
    const canCompose = granted.includes(GMAIL_COMPOSE_SCOPE);
    return {
      clientConfigured: Boolean(active),
      clientSource: active?.source ?? null,
      teamClientAvailable: Boolean(stored.teamClient),
      ownClientConfigured: Boolean(stored.client),
      clientIdSuffix: active ? clientIdSuffix(active.client.clientId) : null,
      connected: Boolean(stored.connection),
      accountEmail: stored.connection?.accountEmail ?? null,
      connectedAt: stored.connection?.connectedAt || null,
      needsReconnect: Boolean(stored.connection) && needsReconnect,
      lastError,
      redirectUri: deps.redirectUri,
      scope: GMAIL_REQUESTED_SCOPES.join(' '),
      grantedScopes: granted,
      canCompose,
      needsComposeGrant: Boolean(stored.connection) && !canCompose,
    };
  }

  /**
   * After any client change: a dropped connection is revoked at Google (best
   * effort; the grant rule already removed it locally), and sign-ins started
   * with another client ID are void.
   */
  function afterClientChange(before: StoredGmailCredentials): Promise<void> {
    const after = store.read();
    if (activeGmailClient(before)?.client.clientId !== activeGmailClient(after)?.client.clientId) pending.clear();
    needsReconnect = false;
    lastError = null;
    if (!before.connection || after.connection) return Promise.resolve();
    access = null;
    const dropped = before.connection.refreshToken;
    return revokeToken(fetchImpl, endpoints, dropped).then(() => undefined, (error) => {
      console.warn(`[Gmail] revoke at Google failed (local grant removed anyway): ${(error as Error)?.message ?? error}`);
    });
  }

  async function revokeStored(): Promise<void> {
    const stored = store.read();
    const token = stored.connection?.refreshToken;
    if (!token) return;
    try {
      await revokeToken(fetchImpl, endpoints, token);
    } catch (error) {
      // The grant is deleted locally either way; the owner can also remove
      // BotBoy at myaccount.google.com → Security → Third-party connections.
      console.warn(`[Gmail] revoke at Google failed (local grant removed anyway): ${(error as Error)?.message ?? error}`);
    }
  }

  async function refresh(): Promise<string> {
    const stored = store.read();
    const active = activeGmailClient(stored);
    if (!active || !stored.connection) {
      throw new GmailAuthError('Gmail is not connected. Open Connections → Gmail and connect your account.', 'not_connected');
    }
    try {
      const tokens = await refreshAccessToken(fetchImpl, endpoints, {
        clientId: active.client.clientId,
        clientSecret: active.client.clientSecret,
        refreshToken: stored.connection.refreshToken,
      });
      access = { token: tokens.accessToken, expiresAt: now() + tokens.expiresInSeconds * 1000 };
      if (needsReconnect) { needsReconnect = false; changed(); }
      lastError = null;
      return tokens.accessToken;
    } catch (error) {
      if (error instanceof GoogleApiError && ['invalid_grant', 'invalid_client', 'unauthorized_client'].includes(error.code)) {
        if (!needsReconnect) { needsReconnect = true; changed(); }
        lastError = error.code === 'invalid_grant'
          ? 'Google ended BotBoy’s access to this account (revoked, expired, or the password changed). Choose Reconnect.'
          : rejectedClientAdvice(active.source);
        throw new GmailAuthError(`${error.message}. ${lastError}`, 'reconnect_required');
      }
      throw error;
    }
  }

  const service: GmailConnection = {
    status,
    isConnected: () => Boolean(store.read().connection),
    accountEmail: () => store.read().connection?.accountEmail ?? null,
    canCompose: () => grantedScopes(store.read()).includes(GMAIL_COMPOSE_SCOPE),

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

    applyStagedTeamClient() {
      const staged = readStagedTeamClient(store.privateRoot);
      if (staged.status === 'none') return { applied: false, reason: 'none' };
      if (staged.status === 'invalid') {
        // The import validated it, so this is a damaged or foreign file; it
        // can never become valid, and keeping it would warn on every start.
        console.warn(`[Gmail] Ignored a staged Google client (${staged.reason}); ask the BotBoy owner for a new credential file.`);
        removeStagedTeamClient(store.privateRoot);
        return { applied: false, reason: 'invalid' };
      }
      const before = store.read();
      const same = before.teamClient?.clientId === staged.client.clientId
        && before.teamClient?.clientSecret === staged.client.clientSecret;
      if (!same) {
        store.saveTeamClient(staged.client);
        void afterClientChange(before);
        changed();
        console.log(`[Gmail] BotBoy’s shared Google client ${clientIdSuffix(staged.client.clientId)} applied from the credential file${before.client ? ' (your own client stays active)' : ''}`);
      }
      // Applied (or already present) before the delete, so a crash in between
      // only re-applies the same client on the next start.
      removeStagedTeamClient(store.privateRoot);
      return same ? { applied: false, reason: 'unchanged' } : { applied: true };
    },

    beginConnect() {
      const stored = store.read();
      const active = activeGmailClient(stored);
      if (!active) {
        throw new GmailAuthError('Gmail has no Google client yet. Import the BotBoy credential file from the owner, or add your own client under Advanced.', 'not_connected');
      }
      prunePending();
      while (pending.size >= MAX_PENDING_STATES) {
        const oldest = pending.keys().next().value;
        if (oldest === undefined) break;
        pending.delete(oldest);
      }
      const state = createOAuthState();
      const pkce = createPkcePair();
      pending.set(state, { verifier: pkce.verifier, createdAt: now() });
      return {
        authUrl: buildAuthorizationUrl(endpoints, {
          clientId: active.client.clientId,
          redirectUri: deps.redirectUri,
          state,
          codeChallenge: pkce.challenge,
          loginHint: stored.connection?.accountEmail,
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
        lastError = error;
        changed();
        return { ok: false as const, error };
      };
      if (!entry) return fail('That sign-in link expired or was already used. Choose Connect again.');
      if (typeof query.error === 'string' && query.error) {
        return fail(query.error === 'access_denied'
          ? 'Google sign-in was cancelled, so nothing changed.'
          : `Google sign-in did not finish (${query.error.replace(/[^a-z_]/gi, '').slice(0, 40)}).`);
      }
      const code = typeof query.code === 'string' ? query.code : '';
      if (!code) return fail('Google returned no authorization code. Choose Connect again.');
      const active = activeGmailClient(store.read());
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
        const previous = store.read().connection;
        // Google revokes a whole grant (client + account), so only another
        // account's old grant may be revoked; reconnecting the same account
        // just replaces its token.
        if (previous && previous.accountEmail !== profile.emailAddress) await revokeStored();
        store.saveConnection({ refreshToken: tokens.refreshToken, accountEmail: profile.emailAddress, scope: granted.join(' ') });
        access = { token: tokens.accessToken, expiresAt: now() + tokens.expiresInSeconds * 1000 };
        needsReconnect = false;
        lastError = null;
        changed();
        console.log(`[Gmail] Connected ${profile.emailAddress} (${active.source} client ${clientIdSuffix(active.client.clientId)}; ${granted.includes(GMAIL_COMPOSE_SCOPE) ? 'read + compose' : 'read only'})`);
        return { ok: true, accountEmail: profile.emailAddress };
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

    async disconnect() {
      await revokeStored();
      store.clearConnection();
      access = null;
      needsReconnect = false;
      lastError = null;
      changed();
      return status();
    },

    async accessToken() {
      if (access && access.expiresAt - ACCESS_TOKEN_SKEW_MS > now()) return access.token;
      if (!refreshing) {
        refreshing = refresh().finally(() => { refreshing = null; });
      }
      return refreshing;
    },

    invalidateAccessToken() {
      access = null;
    },

    client() {
      return createGmailClient({
        fetchImpl,
        endpoints,
        accessToken: () => service.accessToken(),
        invalidateAccessToken: () => service.invalidateAccessToken(),
      });
    },

    version: () => version,

    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return service;
}
