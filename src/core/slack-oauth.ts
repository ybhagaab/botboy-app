/**
 * Sign in with Slack (OAuth v2, user token only; D6).
 *
 * The owner's own Slack app (slack-credentials.ts) authorizes BotBoy for the
 * user scopes below. BotBoy asks for `user_scope` only, never `scope`, so no
 * bot token is issued. The exchange reads `authed_user.access_token` (xoxp)
 * and proves it with `auth.test` before anything is saved.
 *
 * Redirect modes:
 *   - http_loopback: Slack redirects to http://127.0.0.1:<PORT>/api/slack/oauth/callback
 *   - https_paste:   the owner registers the https form; BotBoy serves no TLS,
 *     so the browser shows an error page and the owner pastes that address
 *     into "Finish sign-in". The exchange sends the exact registered URL.
 *
 * Codes, tokens, and secrets are never logged.
 */

import crypto from 'crypto';
import { WebClient } from '@slack/web-api';
import { allConnectPhase, retryAfterBackoff, transportCodesOf } from './transport-errors.js';

/** The user scopes BotBoy requests; rendered on the Slack card from this constant. */
export const SLACK_USER_SCOPES = [
  'channels:history', 'channels:read',
  'groups:history', 'groups:read',
  'im:history', 'im:read',
  'mpim:history', 'mpim:read',
  'users:read',
] as const;

/**
 * Every Slack Web API method BotBoy calls, with the scopes it needs. The
 * method-scan test fails when slack-monitor.ts or the Slack router call a
 * method missing here, so no call can ship without its scope.
 */
export const SLACK_METHOD_SCOPES: Readonly<Record<string, readonly string[]>> = {
  'auth.test': [],
  'conversations.history': ['channels:history', 'groups:history', 'im:history', 'mpim:history'],
  'conversations.replies': ['channels:history', 'groups:history', 'im:history', 'mpim:history'],
  'conversations.info': ['channels:read', 'groups:read', 'im:read', 'mpim:read'],
  'users.conversations': ['channels:read', 'groups:read', 'im:read', 'mpim:read'],
  'users.info': ['users:read'],
};

export const SLACK_AUTHORIZE_URL = 'https://slack.com/oauth/v2/authorize';
const STATE_TTL_MS = 10 * 60_000;
export const MAX_PASTE_CHARS = 4096;
/** Every Slack call of the sign-in has this deadline (the client's own default is none). */
export const SLACK_REQUEST_TIMEOUT_MS = 30_000;

export type SlackOAuthErrorCode =
  | 'slack_client_missing'
  | 'invalid_paste'
  | 'state_mismatch'
  | 'state_required'
  | 'access_denied'
  | 'rotation_enabled'
  | 'exchange_failed'
  | 'network_error'
  | 'auth_test_failed'
  | 'not_user_token';

export class SlackOAuthError extends Error {
  constructor(readonly code: SlackOAuthErrorCode, message: string) {
    super(message);
    this.name = 'SlackOAuthError';
  }
}

export function buildSlackAuthorizeUrl(input: { clientId: string; redirectUri: string; state: string }): string {
  const params = new URLSearchParams({
    client_id: input.clientId,
    user_scope: SLACK_USER_SCOPES.join(','),
    redirect_uri: input.redirectUri,
    state: input.state,
  });
  return `${SLACK_AUTHORIZE_URL}?${params.toString()}`;
}

/** Single-use, short-lived state values kept in memory only. */
export function createSlackOAuthStateStore(deps: { now?: () => number } = {}) {
  const now = deps.now ?? Date.now;
  const pending = new Map<string, { expiresAt: number; redirectUri: string }>();
  const sweep = () => { for (const [key, entry] of pending) if (entry.expiresAt <= now()) pending.delete(key); };
  return {
    issue(redirectUri: string): string {
      sweep();
      const state = crypto.randomBytes(32).toString('base64url');
      pending.set(state, { expiresAt: now() + STATE_TTL_MS, redirectUri });
      return state;
    },
    /** Consumes the state; null when unknown or expired. */
    take(state: string): { redirectUri: string } | null {
      sweep();
      const entry = pending.get(state);
      if (!entry) return null;
      pending.delete(state);
      return { redirectUri: entry.redirectUri };
    },
    /** The only live state, when exactly one exists. */
    single(): string | null {
      sweep();
      return pending.size === 1 ? [...pending.keys()][0] : null;
    },
    size(): number { sweep(); return pending.size; },
  };
}

export type SlackOAuthStateStore = ReturnType<typeof createSlackOAuthStateStore>;

/**
 * "Finish sign-in" input: the full address from the browser bar, or the bare
 * code. A bare code needs exactly one pending sign-in; a URL must carry a
 * state that is live.
 */
export function parseFinishPaste(pasted: unknown, states: SlackOAuthStateStore): { code: string; state: string } {
  const text = typeof pasted === 'string' ? pasted.trim() : '';
  if (!text || text.length > MAX_PASTE_CHARS) throw new SlackOAuthError('invalid_paste', 'Paste the address Slack sent you to (or its code).');
  if (/^https?:\/\//i.test(text)) {
    let url: URL;
    try { url = new URL(text); } catch { throw new SlackOAuthError('invalid_paste', 'That address could not be read.'); }
    const code = url.searchParams.get('code') ?? '';
    const state = url.searchParams.get('state') ?? '';
    if (!code) throw new SlackOAuthError('invalid_paste', 'That address has no code. Sign in with Slack again.');
    if (!state || states.size() === 0) throw new SlackOAuthError('state_mismatch', 'This sign-in does not match the one BotBoy started. Start again.');
    return { code, state };
  }
  if (!/^[A-Za-z0-9._-]{8,512}$/.test(text)) throw new SlackOAuthError('invalid_paste', 'Paste the address Slack sent you to (or its code).');
  const state = states.single();
  if (!state) throw new SlackOAuthError('state_required', 'Paste the whole address so BotBoy can match it to this sign-in.');
  return { code: text, state };
}

export interface SlackExchangeResult {
  token: string;
  identity: { user: string; team: string };
}

/**
 * A Slack call that never got an answer: the client wraps the transport error
 * (`slack_webapi_request_error`, the axios error under `original`). A refusal
 * from Slack (`data.error`) and an HTTP error status are NOT this.
 */
function isTransportFailure(error: any): boolean {
  return error?.code === 'slack_webapi_request_error';
}

/** The errno codes under the client's wrapper (its own `code` names the wrapper, not the cause). */
function slackTransportCodes(error: any): string[] {
  return transportCodesOf(error?.original ?? error?.cause ?? null);
}

/** The request provably never reached Slack, so a single-use code may be sent once more. */
function isConnectPhaseFailure(error: any): boolean {
  return isTransportFailure(error) && allConnectPhase(slackTransportCodes(error));
}

/** The owner-facing words for a call that failed without a Slack answer. */
function transportFailureMessage(error: any, doing: string, timeoutMs: number): string {
  const codes = slackTransportCodes(error);
  const timedOut = codes.includes('ECONNABORTED') || /timeout/i.test(String(error?.original?.message ?? ''));
  const cause = timedOut
    ? `Slack didn't answer within ${Math.round(timeoutMs / 1000)} seconds`
    : codes.includes('ETIMEDOUT')
      ? 'timed out on a slow route to Slack'
      : codes.some(code => code === 'ENOTFOUND' || code === 'EAI_AGAIN')
        ? "Slack's address could not be looked up"
        : 'network error';
  return `Couldn't reach Slack ${doing} (${cause}). Nothing was saved. Choose Sign in with Slack again.`;
}

/** Slack's own refusal code, or the transport failure's words, or a plain "request failed". */
function slackFailure(code: SlackOAuthErrorCode, error: any, doing: string, timeoutMs: number, refusal: (slackCode: string) => string): SlackOAuthError {
  if (isTransportFailure(error)) return new SlackOAuthError('network_error', transportFailureMessage(error, doing, timeoutMs));
  const slackCode = typeof error?.data?.error === 'string' ? error.data.error : 'request_failed';
  return new SlackOAuthError(code, refusal(slackCode.replace(/[^a-z0-9_]/gi, '').slice(0, 60)));
}

/**
 * Exchanges a code for the user token and proves it. Nothing is returned (and
 * so nothing is saved) unless every check passes.
 */
export async function exchangeSlackCode(input: {
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
  /** Tests point this at a fake Slack server. */
  slackApiUrl?: string;
  /** Tests record the pause before the single retry instead of waiting. */
  sleep?: (ms: number) => Promise<void>;
  /** Tests shorten the 30 s deadline. */
  timeoutMs?: number;
}): Promise<SlackExchangeResult> {
  const timeoutMs = input.timeoutMs ?? SLACK_REQUEST_TIMEOUT_MS;
  const options = { retryConfig: { retries: 0 }, timeout: timeoutMs, ...(input.slackApiUrl ? { slackApiUrl: input.slackApiUrl } : {}) };
  // The code is single use, so a call is repeated only when it never reached Slack
  // (a connect-phase failure); never after Slack answered or after a timeout.
  const retryable = <T>(run: () => Promise<T>): Promise<T> => retryAfterBackoff(run, {
    shouldRetry: isConnectPhaseFailure,
    sleep: input.sleep,
    onRetry: () => console.warn('[Slack] sign-in could not reach Slack; trying once more'),
  });
  let access: any;
  try {
    access = await retryable(() => new WebClient(undefined, options).oauth.v2.access({
      client_id: input.clientId,
      client_secret: input.clientSecret,
      code: input.code,
      redirect_uri: input.redirectUri,
    }));
  } catch (error: any) {
    throw slackFailure('exchange_failed', error, 'to finish the sign-in', timeoutMs, slackCode => `Slack refused the sign-in (${slackCode}).`);
  }
  const user = access?.authed_user ?? {};
  if (user.expires_in !== undefined || user.refresh_token !== undefined || access?.expires_in !== undefined || access?.refresh_token !== undefined) {
    throw new SlackOAuthError('rotation_enabled', 'Turn off token rotation for this Slack app (OAuth & Permissions), then sign in again.');
  }
  const token = typeof user.access_token === 'string' ? user.access_token : '';
  if (!token.startsWith('xoxp-')) throw new SlackOAuthError('not_user_token', 'Slack did not return a user token. Check that the app asks for User Token Scopes.');
  try {
    // auth.test only reads, so it may be repeated after the same connect-phase failures.
    const auth: any = await retryable(() => new WebClient(token, options).auth.test());
    return { token, identity: { user: String(auth.user ?? ''), team: String(auth.team ?? '') } };
  } catch (error: any) {
    throw slackFailure('auth_test_failed', error, 'to check the new token', timeoutMs, slackCode => `Slack did not accept the new token (${slackCode}).`);
  }
}

/** The redirect URL for a mode, built from the server's port (never hard-coded). */
export function slackRedirectUri(port: number, mode: 'http_loopback' | 'https_paste', callbackPath: string): string {
  return `${mode === 'https_paste' ? 'https' : 'http'}://127.0.0.1:${port}/api${callbackPath}`;
}
