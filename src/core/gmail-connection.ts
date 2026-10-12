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
 *
 * Two separate answers, never mixed (owner report 2026-10-12: a green "Active"
 * badge beside "Google sign-in failed: network error (ETIMEDOUT)"):
 *   - HEALTH is `needsReconnect` + `lastError`, set only while Google rejects
 *     the stored grant. A transient network error never lands there (capture
 *     health tracks it and clears itself).
 *   - The RESULT OF A SIGN-IN ATTEMPT (`signIn`, `pageSignIn`) is what the last
 *     Connect / Reconnect / Connect Google Drive did: its action, time,
 *     message, and next step. It shows only in the section that made the
 *     attempt, ends after 15 minutes or on Dismiss, is replaced by the next
 *     attempt of the same action, and a failure that a later token refresh,
 *     API call, or grant save outdates is not shown (see `isVisible`). A Drive
 *     failure is kept until then: Gmail working says nothing about Drive.
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
  retryConnectPhase,
  revokeToken,
  type FetchLike,
  type GmailClient,
  type GoogleEndpoints,
} from './gmail-api.js';
import { sleepMs } from './transport-errors.js';
import { randomBytes } from 'node:crypto';
import { GDRIVE_FILE_SCOPE, GDRIVE_READONLY_SCOPE, GDRIVE_REQUESTED_SCOPES } from './gdrive-api.js';
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
  type StoredDriveSettings,
  type StoredGmailAccount,
  type StoredGmailCredentials,
} from './gmail-credentials.js';

const STATE_TTL_MS = 10 * 60_000;
const MAX_PENDING_STATES = 5;
const ACCESS_TOKEN_SKEW_MS = 60_000;
/** A sign-in notice stays this long after its attempt (Dismiss ends it sooner). */
export const SIGN_IN_NOTICE_TTL_MS = 15 * 60_000;

/** What the owner pressed: Connect / Reconnect / Add another account, or Connect Google Drive. `unknown`: the callback matched no sign-in BotBoy started. */
export type GmailSignInAction = 'gmail_connect' | 'drive_connect' | 'unknown';

export type GmailSignInKind =
  | 'ok'
  | 'network'
  | 'timeout'
  | 'cancelled'
  | 'state_expired'
  | 'invalid_grant'
  | 'drive_not_granted'
  | 'gmail_not_granted'
  | 'no_refresh_token'
  | 'no_code'
  | 'client_missing'
  | 'client_rejected'
  /** Google answered the sign-in's Gmail profile read with 403 accessNotConfigured / SERVICE_DISABLED: the Gmail API is off in the client's Cloud project. */
  | 'api_not_enabled'
  | 'admin_policy'
  | 'google_error'
  | 'unexpected';

/**
 * The result of one sign-in attempt (memory only, never in gmail.json). One
 * slot per account and action: the next attempt of that action replaces it.
 */
export interface GmailSignInAttempt {
  action: GmailSignInAction;
  kind: GmailSignInKind;
  /** The attempt did what it was started for. A Drive consent that left a Drive box unticked is `ok: false` (kind `drive_not_granted`) even though Gmail is connected. */
  ok: boolean;
  /** ISO time of the attempt. */
  at: string;
  /** Owner-safe: what was attempted, the cause, and the next step. Never a token or code. */
  message: string;
  /** The next step alone (the message already contains it). */
  nextAction: string;
  /** The account the attempt was for; null for a first connect, Add another account, or a link that matched nothing. */
  accountId: string | null;
}

/** The visible results for one account. */
export interface GmailSignInView {
  gmail: GmailSignInAttempt | null;
  drive: GmailSignInAttempt | null;
}

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
  /**
   * HEALTH only: why Google rejected the stored grant, set exactly while
   * `needsReconnect` is true (null otherwise). The result of a sign-in attempt
   * is `signIn` / `pageSignIn`, never this.
   */
  lastError: string | null;
  /** Visible results of the last Connect / Connect Google Drive attempts for the focused account. */
  signIn: GmailSignInView;
  /** The visible result of a sign-in that belongs to no account yet (first connect, Add another account, a link that matched nothing). */
  pageSignIn: GmailSignInAttempt | null;
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
  /** The focused account's grant covers drive.readonly / drive.file, and its Drive choices. */
  canReadDrive: boolean;
  canPublishDrive: boolean;
  drive: StoredDriveSettings | null;
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
  /** Health only (see GmailConnectionStatus.lastError). */
  lastError: string | null;
  /** Visible results of this account's last Connect / Connect Google Drive attempts. */
  signIn: GmailSignInView;
  grantedScopes: string[];
  canCompose: boolean;
  needsComposeGrant: boolean;
  /** The grant covers drive.readonly (capture, search, read). */
  canReadDrive: boolean;
  /** The grant covers drive.file (publishing BotBoy documents). */
  canPublishDrive: boolean;
  /** Drive capture choices; null until the owner connects Drive. */
  drive: StoredDriveSettings | null;
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
  /** The stored grant includes drive.readonly. */
  canReadDrive(): boolean;
  /** The stored grant includes drive.file. */
  canPublishDrive(): boolean;
  /** Drive capture choices (null until Drive is connected). */
  drive(): StoredDriveSettings | null;
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
  /**
   * Reconnect `accountId`, add another account (`addAccount`), or connect the
   * first one. `purpose: 'drive'` asks for Drive on top of the account's Gmail
   * scopes (incremental grant, Connect Google Drive).
   */
  beginConnect(options?: { accountId?: string; addAccount?: boolean; purpose?: 'gmail' | 'drive' }): { authUrl: string };
  /** Saves one account's Drive capture choices. */
  setDriveSettings(accountId: string, drive: StoredDriveSettings): GmailConnectionStatus;
  completeConnect(query: { code?: unknown; state?: unknown; error?: unknown }): Promise<
    { ok: true; accountEmail: string; accountId: string } | { ok: false; error: string }
  >;
  /**
   * The callback's full answer: what `completeConnect` returns plus the attempt
   * it recorded (the loopback page words its result from it). Every outcome
   * but a replayed link records exactly one attempt and logs failures.
   */
  completeSignIn(query: { code?: unknown; state?: unknown; error?: unknown }): Promise<GmailSignInResult>;
  /** Ends one sign-in notice early (the owner pressed Dismiss). `accountId` null: the page-level slot. */
  dismissSignIn(accountId: string | null, action: GmailSignInAction): GmailConnectionStatus;
  /** Disconnects one account (default: the first). Captured mail stays. */
  disconnect(accountId?: string): Promise<GmailConnectionStatus>;
  accounts(): GmailAccountSummary[];
  /** An account by id, address, or label (case-insensitive); null when none matches. */
  account(selector: string): GmailAccountConnection | null;
  /** The view of one account id whether or not it is connected now (the sync's slot). */
  slot(accountId: string): GmailAccountConnection;
  setLabel(accountId: string, label: unknown): GmailConnectionStatus;
}

/** What the callback learned: the account when one is connected, and the attempt that was recorded. */
export interface GmailSignInResult {
  /** An account is connected now (a partial Drive grant still connects Gmail). */
  connected: boolean;
  accountId: string | null;
  accountEmail: string | null;
  /** The recorded attempt; null for a replayed link. */
  attempt: GmailSignInAttempt | null;
  /** The link was already handled once: nothing changed and nothing was recorded. */
  replay: boolean;
}

const STATE_EXPIRED_MESSAGE = 'That sign-in link expired or was already used (BotBoy restarted, or the page was opened twice). Choose Connect again.';
/** Returned for a link BotBoy already handled; recorded nowhere, so a reload never adds a failure beside a good connection. */
export const SIGN_IN_REPLAY_MESSAGE = 'That sign-in link expired or was already used, so nothing changed. Open Connections → Gmail to see where things stand.';

interface FailureContext {
  action: GmailSignInAction;
  /** A Reconnect of a connected account. */
  reconnect: boolean;
  /** Another account is being added to existing ones. */
  addAccount: boolean;
  /** The account is connected and Google had not rejected its grant when the attempt ended. */
  connectionIntact: boolean;
  codes?: readonly string[];
  status?: number;
  googleCode?: string;
  source?: GmailClientSource;
}

/** The button the owner presses to try again. */
function retryButton(ctx: FailureContext): string {
  if (ctx.action === 'drive_connect') return 'Connect Google Drive';
  if (ctx.reconnect) return 'Reconnect';
  if (ctx.addAccount) return 'Add another account';
  return 'Connect Gmail';
}

function failureLead(ctx: FailureContext): string {
  if (ctx.action === 'drive_connect') return "Couldn't connect Google Drive";
  if (ctx.reconnect) return "Couldn't reconnect Gmail";
  if (ctx.action === 'gmail_connect') return "Couldn't connect Gmail";
  return "Google sign-in didn't finish";
}

/**
 * Says what the failed attempt left alone, not how Gmail is doing. A notice lives
 * 15 minutes, so a health claim ("Gmail is still working") could outlast an outage
 * that turns the badge amber and contradict it; "unchanged" stays true of the attempt.
 */
function failureAssurance(ctx: FailureContext): string {
  if (!ctx.connectionIntact) return '';
  return ctx.action === 'drive_connect' || ctx.reconnect ? ' Your current Gmail connection is unchanged.' : '';
}

/** The cause of a network failure, from the codes the transport reported. */
function networkCause(codes: readonly string[] | undefined): string {
  const list = codes ?? [];
  if (list.includes('ETIMEDOUT')) return 'timed out on a slow route to Google';
  if (list.some(code => code === 'ENOTFOUND' || code === 'EAI_AGAIN')) return "Google's address could not be looked up";
  if (list.some(code => code === 'ECONNREFUSED' || code === 'ENETUNREACH' || code === 'EHOSTUNREACH')) return 'there is no route to Google';
  if (list.includes('ECONNRESET')) return 'the connection to Google was reset';
  return 'network error';
}

/**
 * The words for one failure: what was attempted, the cause, and the next step.
 * Kinds whose wording existed before (no read access, no refresh token, admin
 * policy, cancelled Gmail sign-in) keep it.
 */
function describeFailure(kind: GmailSignInKind, ctx: FailureContext): { message: string; nextAction: string } {
  const again = `Press ${retryButton(ctx)} to try again.`;
  const lead = failureLead(ctx);
  const assurance = failureAssurance(ctx);
  const withNext = (message: string, nextAction = again) => ({ message, nextAction });
  switch (kind) {
    case 'network':
      return withNext(`${lead}: BotBoy couldn't reach Google (${networkCause(ctx.codes)}).${assurance} ${again}`);
    case 'timeout':
      return withNext(`${lead}: Google didn't answer within 30 seconds.${assurance} ${again}`);
    case 'cancelled':
      // "nothing changed" already says what the assurance would.
      return ctx.action === 'drive_connect'
        ? withNext(`Drive not granted: the Google sign-in was cancelled, so nothing changed. ${again}`)
        : withNext('Google sign-in was cancelled, so nothing changed.');
    case 'invalid_grant':
      return withNext(`${lead}: Google rejected the sign-in code (it was already used or expired).${assurance} ${again}`);
    case 'state_expired':
      return withNext(STATE_EXPIRED_MESSAGE, 'Choose Connect again.');
    case 'client_rejected': {
      if (ctx.source === 'team') return withNext(`${lead}: ${rejectedClientAdvice('team')}`, 'Update BotBoy, then Reconnect.');
      const next = `Then press ${retryButton(ctx)} again.`;
      return ctx.googleCode === 'redirect_uri_mismatch'
        ? withNext(`${lead}: Google says the sign-in address does not match this OAuth client (redirect mismatch). Use a Desktop app OAuth client (Google Cloud → Clients → Create client → Desktop app), save it in Connections → Gmail. ${next}`, next)
        : withNext(`${lead}: Google rejected the OAuth client ID or secret. Check them in Connections → Gmail (Google Cloud → Clients → your Desktop app client). ${next}`, next);
    }
    case 'api_not_enabled': {
      // No assurance: the cause is Gmail itself, so a reassurance about Gmail would be wrong.
      const fix = `Enable the Gmail API in the same Google Cloud project as your OAuth client (APIs & Services → Library → Gmail API), wait a minute, then press ${retryButton(ctx)} to try again.`;
      return withNext(`${lead}: Google says the Gmail API is turned off. ${fix}`, fix);
    }
    case 'admin_policy':
      return withNext('This Google account’s organization does not allow BotBoy’s Google client (a Workspace admin policy). Use another account, or ask the admin to allow the client.', 'Use another account, or ask the admin to allow the client.');
    case 'gmail_not_granted':
      return withNext('Google did not grant read access to Gmail. Connect again and allow "View your email messages and settings".', 'Connect again and allow "View your email messages and settings".');
    case 'no_refresh_token':
      return withNext('Google returned no refresh token. Remove BotBoy at myaccount.google.com → Security → Third-party connections, then connect again.', 'Remove BotBoy at myaccount.google.com → Security → Third-party connections, then connect again.');
    case 'no_code':
      return withNext('Google returned no authorization code. Choose Connect again.', 'Choose Connect again.');
    case 'client_missing':
      return withNext('The Google client was removed during sign-in. Connect again once a client is set up.', 'Add a Google client in Connections → Gmail, then connect again.');
    case 'google_error': {
      const detail = ctx.status ? `HTTP ${ctx.status}${ctx.googleCode ? ` ${ctx.googleCode}` : ''}` : ctx.googleCode || 'an unreadable answer';
      return withNext(`${lead}: Google answered with an error (${detail}).${assurance} ${again}`);
    }
    default:
      return withNext(`${lead}: it failed unexpectedly.${assurance} ${again}`);
  }
}

/**
 * Which Drive box the consent left out, as the words for the notice. It says
 * nothing about Gmail's health: the notice outlives the moment it was written
 * (see `failureAssurance`), and "Google connected" already tells what happened.
 */
function driveNotGrantedMessage(read: boolean, publish: boolean): string {
  const next = 'Press Connect Google Drive and tick both Drive boxes.';
  if (!read && !publish) return `Drive not granted: Google connected, but both Drive boxes were left unticked. ${next}`;
  return read
    ? `Drive not granted in full: Google allowed reading Drive but not publishing to it. ${next}`
    : `Drive not granted in full: Google allowed publishing to Drive but not reading it. ${next}`;
}

/**
 * Google's answer when an API was never switched on in the OAuth client's Cloud
 * project: HTTP 403 `accessNotConfigured` / `SERVICE_DISABLED`, or (newer error
 * bodies, where the reason is `PERMISSION_DENIED`) text saying the API "has not
 * been used in project N before or it is disabled". The Gmail profile read is
 * the only API call a sign-in makes, so here it is always the Gmail API.
 */
function isApiNotEnabled(error: GoogleApiError): boolean {
  if (error.status !== 403) return false;
  return /accessNotConfigured|SERVICE_DISABLED/i.test(error.code) || /has not been used|is disabled/i.test(error.message);
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
  /** The pause before the sign-in code's single retry (tests record it instead of waiting). */
  sleep?: (ms: number) => Promise<void>;
}): GmailConnection {
  const store = deps.store ?? createGmailCredentialStore({ privateRoot: deps.privateRoot });
  const fetchImpl: FetchLike = deps.fetchImpl ?? ((input, init) => fetch(input, init));
  const endpoints = deps.endpoints ?? GOOGLE_ENDPOINTS;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? sleepMs;
  const newAccountId = deps.newAccountId ?? (() => `ga_${randomBytes(5).toString('hex')}`);
  /** A sign-in in progress and what it is for: reconnect one account, or add one. */
  const pending = new Map<string, { verifier: string; createdAt: number; accountId?: string; purpose?: 'drive' }>();
  /** States already handled (time handled), so a reloaded callback is told apart from a forged one. */
  const spent = new Map<string, number>();
  const listeners = new Set<() => void>();

  /** Per-account runtime state (memory only). */
  interface Runtime {
    access: { token: string; expiresAt: number } | null;
    refreshing: Promise<string> | null;
    needsReconnect: boolean;
    lastError: string | null;
    /** The last time Google worked for this account: a token refresh, any successful Gmail API answer, or a grant save. */
    okAt: number;
  }
  const runtimes = new Map<string, Runtime>();
  const runtime = (accountId: string): Runtime => {
    let entry = runtimes.get(accountId);
    if (!entry) {
      entry = { access: null, refreshing: null, needsReconnect: false, lastError: null, okAt: 0 };
      runtimes.set(accountId, entry);
    }
    return entry;
  };
  /** The result of the last sign-in attempt per account and action (`*` = no account yet). Memory only. */
  const attempts = new Map<string, GmailSignInAttempt>();
  const slotKey = (accountId: string | null, action: GmailSignInAction): string => `${accountId ?? '*'}|${action}`;
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
    for (const [state, at] of spent) {
      if (at < cutoff) spent.delete(state);
    }
  }

  // ── Sign-in attempts (the result of Connect / Reconnect / Connect Google Drive) ──

  /** The newest time Google worked for any account (judges attempts that belong to no account). */
  const latestOkAt = (): number => {
    let latest = 0;
    for (const entry of runtimes.values()) latest = Math.max(latest, entry.okAt);
    return latest;
  };

  /**
   * Shown while it is fresh (15 minutes), and, for Gmail and unknown attempts,
   * while no later success outdates a failure: a token refresh, any successful
   * Gmail answer, or a grant save for that account. A Drive failure stays: the
   * Drive grant is a separate fact that Gmail working does not change.
   */
  function isVisible(attempt: GmailSignInAttempt): boolean {
    const at = Date.parse(attempt.at);
    if (!(now() - at < SIGN_IN_NOTICE_TTL_MS)) return false;
    if (attempt.ok || attempt.action === 'drive_connect') return true;
    const okAt = attempt.accountId ? (runtimes.get(attempt.accountId)?.okAt ?? 0) : latestOkAt();
    return !(okAt > at);
  }

  function visibleAttempt(accountId: string | null, action: GmailSignInAction): GmailSignInAttempt | null {
    const attempt = attempts.get(slotKey(accountId, action));
    return attempt && isVisible(attempt) ? attempt : null;
  }

  /** The focused account's visible results. */
  const signInView = (accountId: string | undefined): GmailSignInView => ({
    gmail: accountId ? visibleAttempt(accountId, 'gmail_connect') : null,
    drive: accountId ? visibleAttempt(accountId, 'drive_connect') : null,
  });

  /** The visible result that belongs to no account yet (the newest of its two slots). */
  function pageSignIn(): GmailSignInAttempt | null {
    const found = [visibleAttempt(null, 'gmail_connect'), visibleAttempt(null, 'unknown')].filter((entry): entry is GmailSignInAttempt => entry !== null);
    return found.sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0] ?? null;
  }

  function recordAttempt(input: Omit<GmailSignInAttempt, 'at'>): GmailSignInAttempt {
    const attempt: GmailSignInAttempt = { ...input, at: new Date(now()).toISOString() };
    attempts.set(slotKey(attempt.accountId, attempt.action), attempt);
    return attempt;
  }

  function dropAttempts(accountIds: Array<string | null | undefined>, actions: GmailSignInAction[]): void {
    for (const accountId of accountIds) {
      for (const action of actions) attempts.delete(slotKey(accountId ?? null, action));
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
      lastError: state.needsReconnect ? state.lastError : null,
      signIn: signInView(account.id),
      grantedScopes: granted,
      canCompose,
      needsComposeGrant: !canCompose,
      canReadDrive: granted.includes(GDRIVE_READONLY_SCOPE),
      canPublishDrive: granted.includes(GDRIVE_FILE_SCOPE),
      drive: account.drive ?? null,
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
      // Health only: the reason Google rejected the grant, while it does. A sign-in
      // result is signIn / pageSignIn, so a recovered error can never sit beside Active.
      lastError: state?.needsReconnect ? state.lastError : null,
      signIn: signInView(account?.id),
      pageSignIn: pageSignIn(),
      accounts: stored.accounts.map(summary),
      redirectUri: deps.redirectUri,
      scope: GMAIL_REQUESTED_SCOPES.join(' '),
      grantedScopes: granted,
      canCompose,
      needsComposeGrant: Boolean(account) && !canCompose,
      canReadDrive: granted.includes(GDRIVE_READONLY_SCOPE),
      canPublishDrive: granted.includes(GDRIVE_FILE_SCOPE),
      drive: account?.drive ?? null,
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
    // A new client starts clean: earlier sign-in results belong to the old one.
    attempts.clear();
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
      state.okAt = now();
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
      canReadDrive: () => scopesOf(storedAccount(accountId)).includes(GDRIVE_READONLY_SCOPE),
      canPublishDrive: () => scopesOf(storedAccount(accountId)).includes(GDRIVE_FILE_SCOPE),
      drive: () => storedAccount(accountId)?.drive ?? null,
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
          // Any successful Gmail answer proves the grant and the route work: it
          // outdates an earlier transient sign-in failure for this account.
          fetchImpl: async (input, init) => {
            const response = await fetchImpl(input, init);
            if (response.ok) runtime(accountId).okAt = now();
            return response;
          },
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
    canReadDrive: () => scopesOf(firstAccount()).includes(GDRIVE_READONLY_SCOPE),
    canPublishDrive: () => scopesOf(firstAccount()).includes(GDRIVE_FILE_SCOPE),
    drive: () => firstAccount()?.drive ?? null,
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

    setDriveSettings(accountId, drive) {
      if (!storedAccount(accountId)) throw new GmailAuthError('That Gmail account is not connected.', 'not_connected');
      store.setDrive(accountId, drive);
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
      const forDrive = options.purpose === 'drive';
      if (forDrive && !target) throw new GmailAuthError('Connect the Gmail account first, then connect Google Drive.', 'not_connected');
      // A reconnect of an account that already has Drive asks for Drive again,
      // so a fresh consent never silently drops it.
      const targetScopes = scopesOf(target);
      const keepDrive = targetScopes.includes(GDRIVE_READONLY_SCOPE) || targetScopes.includes(GDRIVE_FILE_SCOPE);
      const scopes = forDrive || keepDrive ? [...GMAIL_REQUESTED_SCOPES, ...GDRIVE_REQUESTED_SCOPES] : GMAIL_REQUESTED_SCOPES;
      prunePending();
      while (pending.size >= MAX_PENDING_STATES) {
        const oldest = pending.keys().next().value;
        if (oldest === undefined) break;
        pending.delete(oldest);
      }
      const state = createOAuthState();
      const pkce = createPkcePair();
      pending.set(state, { verifier: pkce.verifier, createdAt: now(), ...(target ? { accountId: target.id } : {}), ...(forDrive ? { purpose: 'drive' as const } : {}) });
      return {
        authUrl: buildAuthorizationUrl(endpoints, {
          clientId: active.client.clientId,
          redirectUri: deps.redirectUri,
          state,
          codeChallenge: pkce.challenge,
          loginHint: target?.connection.accountEmail,
          selectAccount: Boolean(options.addAccount),
          ...(scopes !== GMAIL_REQUESTED_SCOPES ? { scopes, includeGrantedScopes: true } : {}),
        }),
      };
    },

    async completeSignIn(query) {
      prunePending();
      const state = typeof query.state === 'string' ? query.state : '';
      const entry = state ? pending.get(state) : undefined;
      // Single use: a replayed or forged callback finds nothing.
      if (state) pending.delete(state);
      if (!entry && state && spent.has(state)) {
        // The owner reloaded a callback BotBoy already handled: nothing changed, so
        // nothing is recorded (a failure notice here would sit beside a good connection).
        return { connected: false, accountId: null, accountEmail: null, attempt: null, replay: true };
      }
      if (entry) spent.set(state, now());
      const action: GmailSignInAction = entry ? (entry.purpose === 'drive' ? 'drive_connect' : 'gmail_connect') : 'unknown';
      const targetId = entry?.accountId ?? null;
      let source: GmailClientSource | undefined;
      /** Records the failure, logs one token-free line, and tells the callback. */
      const fail = (kind: GmailSignInKind, detail: Partial<FailureContext> & { logCode?: string } = {}): GmailSignInResult => {
        const target = targetId ? storedAccount(targetId) : undefined;
        const { message, nextAction } = describeFailure(kind, {
          action,
          reconnect: action === 'gmail_connect' && Boolean(target),
          addAccount: action === 'gmail_connect' && !target && store.read().accounts.length > 0,
          connectionIntact: Boolean(target) && !runtime(target!.id).needsReconnect,
          source,
          ...detail,
        });
        const attempt = recordAttempt({ action, kind, ok: false, message, nextAction, accountId: targetId });
        const logCode = (detail.logCode ?? '').replace(/[^A-Za-z0-9_+ ]/g, '').slice(0, 60);
        console.warn(`[Gmail] sign-in failed: action=${action} kind=${kind}${logCode ? ` code=${logCode}` : ''}${targetId ? ` account=${targetId}` : ''}`);
        changed();
        return { connected: false, accountId: null, accountEmail: null, attempt, replay: false };
      };
      if (!entry) return fail('state_expired', { logCode: state ? 'unknown_state' : 'no_state' });
      if (typeof query.error === 'string' && query.error) {
        const reason = query.error.replace(/[^a-z_]/gi, '').slice(0, 40);
        if (query.error === 'access_denied') return fail('cancelled', { logCode: reason });
        if (query.error === 'admin_policy_enforced' || query.error === 'org_internal') return fail('admin_policy', { logCode: reason });
        return fail('google_error', { googleCode: reason, logCode: reason });
      }
      const code = typeof query.code === 'string' ? query.code : '';
      if (!code) return fail('no_code');
      const active = activeOf(store.read());
      if (!active) return fail('client_missing');
      source = active.source;
      const retryNote = (error: GoogleApiError): void => {
        console.warn(`[Gmail] sign-in could not reach Google (${(error.transportCodes?.length ? error.transportCodes : [error.transportCode ?? 'network']).join('+')}); trying once more`);
      };
      try {
        const tokens = await exchangeAuthorizationCode(fetchImpl, endpoints, {
          clientId: active.client.clientId,
          clientSecret: active.client.clientSecret,
          code,
          codeVerifier: entry.verifier,
          redirectUri: deps.redirectUri,
        }, { sleep, onRetry: retryNote });
        const granted = tokens.scope.split(/\s+/).filter(Boolean);
        if (!granted.includes(GMAIL_READONLY_SCOPE)) return fail('gmail_not_granted');
        if (!tokens.refreshToken) return fail('no_refresh_token');
        // The account comes from Gmail itself, never from the browser. The
        // profile read is a GET, so a connect-phase failure is retried once
        // rather than losing the refresh token Google just issued.
        const probe = createGmailClient({
          fetchImpl,
          endpoints,
          accessToken: async () => tokens.accessToken,
          invalidateAccessToken: () => {},
        });
        const profile = await retryConnectPhase(() => probe.getProfile(), { sleep, onRetry: retryNote });
        const email = profile.emailAddress.toLowerCase();
        const accounts = store.read().accounts;
        // The address decides the account: signing in to one already
        // connected replaces its token (Google revokes a whole grant, so
        // nothing is revoked); a new address adds an account, even when the
        // sign-in started as a Reconnect of another one.
        const existing = accounts.find(account => account.connection.accountEmail === email);
        const accountId = existing?.id ?? (accounts.length ? newAccountId() : GMAIL_DEFAULT_ACCOUNT_ID);
        store.saveConnection(accountId, { refreshToken: tokens.refreshToken, accountEmail: email, scope: granted.join(' ') });
        const driveRead = granted.includes(GDRIVE_READONLY_SCOPE);
        const drivePublish = granted.includes(GDRIVE_FILE_SCOPE);
        const driveGranted = driveRead && drivePublish;
        if (entry.purpose === 'drive' && driveGranted && !store.read().accounts.find(account => account.id === accountId)?.drive) {
          // Drive is on; nothing is captured until the owner picks sources.
          store.setDrive(accountId, { enabled: true, sources: { ownedByMe: false, sharedWithMe: false, folderIds: [] } });
        }
        const fresh = runtime(accountId);
        fresh.access = { token: tokens.accessToken, expiresAt: now() + tokens.expiresInSeconds * 1000 };
        fresh.needsReconnect = false;
        // Health is clean: a partial Drive grant is a sign-in result, not a connection error.
        fresh.lastError = null;
        fresh.okAt = now();
        // This success outdates every earlier failure of its action (and, once both
        // Drive boxes are granted, an earlier Drive failure on any sign-in).
        dropAttempts([null, targetId, accountId], [action]);
        dropAttempts([null], ['unknown']);
        if (driveGranted) dropAttempts([targetId, accountId], ['drive_connect']);
        let attempt: GmailSignInAttempt;
        if (entry.purpose === 'drive' && !driveGranted) {
          attempt = recordAttempt({
            action, kind: 'drive_not_granted', ok: false, accountId,
            message: driveNotGrantedMessage(driveRead, drivePublish),
            nextAction: 'Press Connect Google Drive and tick both Drive boxes.',
          });
        } else {
          attempt = recordAttempt({
            action, kind: 'ok', ok: true, accountId, nextAction: '',
            message: entry.purpose === 'drive'
              ? 'Google Drive connected. Choose the Drive sources BotBoy should capture below.'
              : `Gmail ${existing ? 'reconnected' : 'connected'} as ${email}.`,
          });
        }
        changed();
        const drive = driveGranted ? 'Drive read + publish'
          : driveRead ? 'Drive read only'
            : drivePublish ? 'Drive publish only'
              : entry.purpose === 'drive' ? 'Drive not granted' : 'no Drive';
        console.log(`[Gmail] ${existing ? 'Reconnected' : 'Connected'} ${email} as account ${accountId} (${active.source} client ${clientIdSuffix(active.client.clientId)}; ${granted.includes(GMAIL_COMPOSE_SCOPE) ? 'read + compose' : 'read only'}; ${drive})`);
        return { connected: true, accountId, accountEmail: email, attempt, replay: false };
      } catch (error) {
        if (error instanceof GoogleApiError) {
          const codes = error.transportCodes?.length ? error.transportCodes : error.transportCode ? [error.transportCode] : [];
          const googleCode = error.code.replace(/[^A-Za-z0-9_]/g, '').slice(0, 40);
          if (error.code === 'network') return fail('network', { codes, logCode: codes.join('+') || 'network' });
          if (error.code === 'timeout') return fail('timeout', { logCode: 'timeout' });
          if (error.code === 'invalid_grant') return fail('invalid_grant', { logCode: `${error.status} ${googleCode}` });
          if (['redirect_uri_mismatch', 'invalid_client', 'unauthorized_client'].includes(error.code)) {
            return fail('client_rejected', { googleCode, logCode: `${error.status} ${googleCode}` });
          }
          // The Gmail profile read after a good exchange: the API is off in the client's project.
          if (isApiNotEnabled(error)) return fail('api_not_enabled', { logCode: `${error.status} ${googleCode}` });
          return fail('google_error', { status: error.status || undefined, googleCode, logCode: `${error.status} ${googleCode}` });
        }
        return fail('unexpected', { logCode: error instanceof Error ? error.name : 'Error' });
      }
    },

    async completeConnect(query) {
      const result = await service.completeSignIn(query);
      return result.connected && result.accountId && result.accountEmail
        ? { ok: true as const, accountEmail: result.accountEmail, accountId: result.accountId }
        : { ok: false as const, error: result.attempt?.message ?? SIGN_IN_REPLAY_MESSAGE };
    },

    dismissSignIn(accountId, action) {
      attempts.delete(slotKey(accountId, action));
      changed();
      return status();
    },

    async disconnect(accountId) {
      const account = accountId ? storedAccount(accountId) : firstAccount();
      if (account) {
        await revokeAccount(account);
        store.clearConnection(account.id);
        runtimes.delete(account.id);
        dropAttempts([account.id], ['gmail_connect', 'drive_connect']);
      }
      dropAttempts([null], ['gmail_connect', 'unknown']);
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
