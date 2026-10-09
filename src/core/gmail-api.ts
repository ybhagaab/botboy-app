/**
 * Google OAuth 2.0 (installed app, PKCE) and Gmail REST over Node's fetch.
 *
 * No SDK dependency on purpose: teammates update with `./start.sh --update`,
 * which never runs `npm install`, so a new package would break their next
 * start. Every call has a timeout, and no error message ever carries a token:
 * Google's error bodies are reduced to their error code and a short,
 * redacted description.
 *
 * References: developers.google.com/identity/protocols/oauth2/native-app,
 * developers.google.com/workspace/gmail/api/reference/rest.
 */

import { createHash, randomBytes } from 'crypto';
import { redactSecrets } from './sensitive-files.js';

export const GMAIL_READONLY_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
/** Drafts and sending (GMAIL_CHAT_TOOLS_PLAN.md §6). Never gmail.modify: no mailbox state changes. */
export const GMAIL_COMPOSE_SCOPE = 'https://www.googleapis.com/auth/gmail.compose';
/** Every sign-in asks for both; read access is required, compose is optional (granular consent). */
export const GMAIL_REQUESTED_SCOPES: readonly string[] = Object.freeze([GMAIL_READONLY_SCOPE, GMAIL_COMPOSE_SCOPE]);

export interface GoogleEndpoints {
  authUrl: string;
  tokenUrl: string;
  revokeUrl: string;
  apiBase: string;
}

export const GOOGLE_ENDPOINTS: GoogleEndpoints = Object.freeze({
  authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenUrl: 'https://oauth2.googleapis.com/token',
  revokeUrl: 'https://oauth2.googleapis.com/revoke',
  apiBase: 'https://gmail.googleapis.com',
});

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const REQUEST_TIMEOUT_MS = 30_000;
/** Gmail's media-upload limit for drafts and sends (discovery document `mediaUpload.maxSize`). */
export const GMAIL_MAX_UPLOAD_BYTES = 36_700_160;
/** An upload may run as slow as this (about 1 Mbit/s) before its deadline ends it. */
const UPLOAD_MIN_BYTES_PER_SECOND = 128 * 1024;
/** After one interruption the upload resumes once; then Google's status decides. */
const MAX_UPLOAD_RESUMES = 1;
/** Transport failures that happen before a request can reach Google. */
export const GOOGLE_NEVER_CONNECTED: ReadonlySet<string> = new Set([
  'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'UND_ERR_CONNECT_TIMEOUT',
]);

/**
 * A Google or transport failure. `code` is Google's error code
 * (`invalid_grant`, `rateLimitExceeded`, `notFound`, …) or a local one
 * (`network`, `timeout`, `unreadable_response`, `upload_incomplete`). The
 * message is owner-safe.
 */
export class GoogleApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    /** For `network`: the transport cause (`ENOTFOUND`, `ECONNRESET`, …), so a send can tell "never connected" from "lost mid-request". */
    readonly transportCode?: string,
    /** Set by a resumable upload, which knows whether Google kept the message; otherwise the caller judges from the status. */
    readonly effect?: 'none' | 'unknown',
  ) {
    super(message);
    this.name = 'GoogleApiError';
  }
}

/** The same failure with the effect the upload established; other errors pass through. */
function withEffect(error: unknown, effect: 'none' | 'unknown'): unknown {
  return error instanceof GoogleApiError
    ? new GoogleApiError(error.message, error.status, error.code, error.transportCode, effect)
    : error;
}

function safeText(value: unknown, limit = 200): string {
  return redactSecrets(String(value ?? '')).replace(/\s+/g, ' ').trim().slice(0, limit);
}

async function send(fetchImpl: FetchLike, url: string, init: RequestInit, what: string, timeoutMs = REQUEST_TIMEOUT_MS): Promise<Response> {
  try {
    return await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    const name = (error as Error)?.name ?? '';
    if (name === 'TimeoutError' || name === 'AbortError') {
      throw new GoogleApiError(`${what} timed out after ${Math.round(timeoutMs / 1000)}s`, 0, 'timeout');
    }
    // fetch failed: DNS, refused, reset. The cause text is transport-only.
    const cause = (error as { cause?: { code?: string } })?.cause?.code;
    const transportCode = typeof cause === 'string' ? cause.replace(/[^A-Z0-9_]/gi, '').slice(0, 40) : undefined;
    throw new GoogleApiError(`${what} failed: network error${transportCode ? ` (${transportCode})` : ''}`, 0, 'network', transportCode);
  }
}

async function readJson(response: Response, what: string): Promise<any> {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new GoogleApiError(`${what} returned an unreadable (non-JSON) response (HTTP ${response.status})`, response.status, 'unreadable_response');
  }
}

/** OAuth token endpoint failures: `{error, error_description}`. */
function tokenError(status: number, body: any, what: string): GoogleApiError {
  const code = typeof body?.error === 'string' ? body.error : `http_${status}`;
  const description = typeof body?.error_description === 'string' ? `: ${safeText(body.error_description)}` : '';
  return new GoogleApiError(`${what} failed (HTTP ${status} ${code}${description})`, status, code);
}

/** Gmail API failures: `{error: {code, message, errors: [{reason}], status}}`. */
function apiError(status: number, body: any, what: string): GoogleApiError {
  const error = body?.error;
  const reason = Array.isArray(error?.errors) && typeof error.errors[0]?.reason === 'string'
    ? error.errors[0].reason
    : typeof error?.status === 'string' ? error.status : `http_${status}`;
  const message = typeof error?.message === 'string' ? `: ${safeText(error.message)}` : '';
  return new GoogleApiError(`${what} failed (HTTP ${status} ${reason}${message})`, status, reason);
}

// ── PKCE (RFC 7636) ──────────────────────────────────────────────────────

function base64Url(buffer: Buffer): string {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** A 43-character verifier from 32 random bytes and its S256 challenge. */
export function createPkcePair(): { verifier: string; challenge: string } {
  const verifier = base64Url(randomBytes(32));
  const challenge = base64Url(createHash('sha256').update(verifier, 'ascii').digest());
  return { verifier, challenge };
}

export function createOAuthState(): string {
  return base64Url(randomBytes(24));
}

export function buildAuthorizationUrl(endpoints: GoogleEndpoints, input: {
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
  loginHint?: string;
  /** Adding another account: Google shows its account chooser first. */
  selectAccount?: boolean;
}): string {
  const url = new URL(endpoints.authUrl);
  url.searchParams.set('client_id', input.clientId);
  url.searchParams.set('redirect_uri', input.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', GMAIL_REQUESTED_SCOPES.join(' '));
  // Offline access + forced consent: Google returns a refresh token on every
  // grant, so reconnecting always replaces a dead one.
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', input.selectAccount ? 'select_account consent' : 'consent');
  url.searchParams.set('state', input.state);
  url.searchParams.set('code_challenge', input.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  if (input.loginHint) url.searchParams.set('login_hint', input.loginHint);
  return url.toString();
}

export interface GoogleTokenResponse {
  accessToken: string;
  expiresInSeconds: number;
  refreshToken?: string;
  scope: string;
}

function parseTokenResponse(body: any, what: string, status: number): GoogleTokenResponse {
  if (typeof body?.access_token !== 'string' || !body.access_token) {
    throw new GoogleApiError(`${what} returned no access token`, status, 'unreadable_response');
  }
  const expires = Number(body.expires_in);
  return {
    accessToken: body.access_token,
    expiresInSeconds: Number.isFinite(expires) && expires > 0 ? expires : 3600,
    refreshToken: typeof body.refresh_token === 'string' && body.refresh_token ? body.refresh_token : undefined,
    scope: typeof body.scope === 'string' ? body.scope : '',
  };
}

async function postForm(fetchImpl: FetchLike, url: string, form: Record<string, string>, what: string): Promise<{ status: number; body: any }> {
  const response = await send(fetchImpl, url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams(form).toString(),
  }, what);
  return { status: response.status, body: await readJson(response, what) };
}

export async function exchangeAuthorizationCode(fetchImpl: FetchLike, endpoints: GoogleEndpoints, input: {
  clientId: string;
  clientSecret: string;
  code: string;
  codeVerifier: string;
  redirectUri: string;
}): Promise<GoogleTokenResponse> {
  const what = 'Google sign-in';
  const { status, body } = await postForm(fetchImpl, endpoints.tokenUrl, {
    client_id: input.clientId,
    client_secret: input.clientSecret,
    code: input.code,
    code_verifier: input.codeVerifier,
    grant_type: 'authorization_code',
    redirect_uri: input.redirectUri,
  }, what);
  if (status !== 200) throw tokenError(status, body, what);
  return parseTokenResponse(body, what, status);
}

export async function refreshAccessToken(fetchImpl: FetchLike, endpoints: GoogleEndpoints, input: {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}): Promise<GoogleTokenResponse> {
  const what = 'Gmail token refresh';
  const { status, body } = await postForm(fetchImpl, endpoints.tokenUrl, {
    client_id: input.clientId,
    client_secret: input.clientSecret,
    refresh_token: input.refreshToken,
    grant_type: 'refresh_token',
  }, what);
  if (status !== 200) throw tokenError(status, body, what);
  return parseTokenResponse(body, what, status);
}

/** Best effort: Google answers 200 on success and 400 for an already-dead token. */
export async function revokeToken(fetchImpl: FetchLike, endpoints: GoogleEndpoints, token: string): Promise<boolean> {
  const { status } = await postForm(fetchImpl, endpoints.revokeUrl, { token }, 'Google revoke');
  return status === 200;
}

// ── Gmail REST ───────────────────────────────────────────────────────────

export interface GmailProfile {
  emailAddress: string;
  historyId: string;
  messagesTotal?: number;
}

export interface GmailHeader {
  name: string;
  value: string;
}

export interface GmailMessagePart {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: GmailHeader[];
  body?: { attachmentId?: string; size?: number; data?: string };
  parts?: GmailMessagePart[];
}

export interface GmailMessage {
  id: string;
  threadId: string;
  labelIds?: string[];
  snippet?: string;
  historyId?: string;
  internalDate?: string;
  sizeEstimate?: number;
  payload?: GmailMessagePart;
}

export interface GmailMessageRef {
  id: string;
  threadId?: string;
  labelIds?: string[];
}

export interface GmailHistoryPage {
  records: Array<{ id: string; messagesAdded: GmailMessageRef[] }>;
  nextPageToken?: string;
  historyId: string;
}

export interface GmailThread {
  id: string;
  historyId?: string;
  messages: GmailMessage[];
}

export interface GmailDraft {
  /** Stable draft id; the message inside is replaced on every update. */
  id: string;
  message: GmailMessage;
}

/**
 * An RFC 5322 message plus the thread a reply belongs to: base64url text sent
 * as JSON (`raw`, text-only mail), or its bytes for Gmail's resumable upload
 * (`rfc822`, mail with attachments).
 */
export type GmailRawMessage =
  | { raw: string; threadId?: string }
  | { rfc822: Buffer; threadId?: string };

export type GmailMessageFormat = 'full' | 'metadata' | 'minimal';

export interface GmailClient {
  getProfile(): Promise<GmailProfile>;
  listMessages(input: { q: string; pageToken?: string; maxResults?: number; includeSpamTrash?: boolean }): Promise<{ messages: GmailMessageRef[]; nextPageToken?: string; resultSizeEstimate?: number }>;
  /** Default format `full`; `metadata` returns only the named headers. */
  getMessage(id: string, options?: { format?: GmailMessageFormat; metadataHeaders?: readonly string[] }): Promise<GmailMessage>;
  getThread(id: string, options?: { format?: GmailMessageFormat; metadataHeaders?: readonly string[] }): Promise<GmailThread>;
  listHistory(input: { startHistoryId: string; pageToken?: string; maxResults?: number }): Promise<GmailHistoryPage>;
  /** Send-as addresses (primary + aliases), lowercase. */
  listSendAsAddresses(): Promise<string[]>;
  // ── gmail.compose (GMAIL_CHAT_TOOLS_PLAN.md §6) ──
  createDraft(message: GmailRawMessage): Promise<GmailDraft>;
  updateDraft(draftId: string, message: GmailRawMessage): Promise<GmailDraft>;
  getDraft(draftId: string): Promise<GmailDraft>;
  deleteDraft(draftId: string): Promise<void>;
  /** Sends the draft's current message; Gmail removes the draft. */
  sendDraft(draftId: string): Promise<GmailMessage>;
  sendMessage(message: GmailRawMessage): Promise<GmailMessage>;
}

/**
 * Gmail client bound to an access-token source. A 401 drops the cached token
 * once and retries with a fresh one (an access token can expire mid-run).
 */
export function createGmailClient(deps: {
  fetchImpl?: FetchLike;
  endpoints?: GoogleEndpoints;
  accessToken: () => Promise<string>;
  invalidateAccessToken: () => void;
}): GmailClient {
  const fetchImpl = deps.fetchImpl ?? ((input, init) => fetch(input, init));
  const endpoints = deps.endpoints ?? GOOGLE_ENDPOINTS;
  const base = `${endpoints.apiBase.replace(/\/$/, '')}/gmail/v1/users/me`;

  /**
   * One call with one 401 retry. Google rejects a bad token before it
   * processes a request, so retrying a 401 is safe for a send too.
   */
  async function call(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    params: Record<string, string | readonly string[] | undefined>,
    body: unknown,
    what: string,
  ): Promise<any> {
    const url = new URL(`${base}${path}`);
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined) continue;
      for (const entry of Array.isArray(value) ? value : [value as string]) url.searchParams.append(key, entry);
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await deps.accessToken();
      const headers: Record<string, string> = { Authorization: `Bearer ${token}`, Accept: 'application/json' };
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      const response = await send(fetchImpl, url.toString(), {
        method,
        headers,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      }, what);
      if (response.status === 401 && attempt === 0) {
        deps.invalidateAccessToken();
        await response.text().catch(() => '');
        continue;
      }
      const parsed = await readJson(response, what);
      if (response.status < 200 || response.status > 299) throw apiError(response.status, parsed, what);
      return parsed;
    }
    throw new GoogleApiError(`${what} failed (HTTP 401 unauthorized after a token refresh)`, 401, 'unauthorized');
  }

  const get = (path: string, params: Record<string, string | readonly string[] | undefined>, what: string) => call('GET', path, params, undefined, what);

  function messageOf(body: any, what: string): GmailMessage {
    if (typeof body?.id !== 'string' || typeof body?.threadId !== 'string') {
      throw new GoogleApiError(`${what} returned no message id or thread id`, 200, 'unreadable_response');
    }
    return body as GmailMessage;
  }

  function draftOf(body: any, what: string): GmailDraft {
    if (typeof body?.id !== 'string' || !body.id) throw new GoogleApiError(`${what} returned no draft id`, 200, 'unreadable_response');
    return { id: body.id, message: messageOf(body.message, what) };
  }

  function rawBody(message: { raw: string; threadId?: string }): { raw: string; threadId?: string } {
    return { raw: message.raw, ...(message.threadId ? { threadId: message.threadId } : {}) };
  }

  // ── Resumable upload (developers.google.com/workspace/gmail/api/guides/uploads) ──

  const uploadBase = `${endpoints.apiBase.replace(/\/$/, '')}/upload/gmail/v1/users/me`;
  const apiOrigin = new URL(endpoints.apiBase).origin;

  async function authorized(headers: Record<string, string>): Promise<Record<string, string>> {
    return { Authorization: `Bearer ${await deps.accessToken()}`, ...headers };
  }

  /** Google's session address, only if it is a Google API address: it receives the token and the message. */
  function sessionAddress(location: string | null): string | null {
    if (!location) return null;
    try {
      const url = new URL(location, `${apiOrigin}/`);
      const googleApi = url.protocol === 'https:' && (url.hostname === 'googleapis.com' || url.hostname.endsWith('.googleapis.com'));
      return url.origin === apiOrigin || googleApi ? url.toString() : null;
    } catch {
      return null;
    }
  }

  /** Opens an upload session. It holds no message yet, so a failure here saved or sent nothing. */
  async function openSession(method: 'POST' | 'PUT', path: string, metadata: Record<string, unknown>, total: number, what: string): Promise<string> {
    const url = new URL(`${uploadBase}${path}`);
    url.searchParams.set('uploadType', 'resumable');
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await send(fetchImpl, url.toString(), {
        method,
        redirect: 'manual',
        headers: await authorized({
          Accept: 'application/json',
          'Content-Type': 'application/json; charset=UTF-8',
          'X-Upload-Content-Type': 'message/rfc822',
          'X-Upload-Content-Length': String(total),
        }),
        body: JSON.stringify(metadata),
      }, what);
      if (response.status === 401 && attempt === 0) {
        deps.invalidateAccessToken();
        await response.text().catch(() => '');
        continue;
      }
      if (response.status < 200 || response.status > 299) {
        throw apiError(response.status, await readJson(response, what).catch(() => ({})), what);
      }
      await response.text().catch(() => '');
      const session = sessionAddress(response.headers.get('location'));
      if (!session) throw new GoogleApiError(`${what} returned no usable upload session`, response.status, 'unreadable_response');
      return session;
    }
    throw new GoogleApiError(`${what} failed (HTTP 401 unauthorized after a token refresh)`, 401, 'unauthorized');
  }

  type UploadStep =
    | { kind: 'done'; body: any }
    | { kind: 'rejected'; error: GoogleApiError }
    | { kind: 'interrupted'; error: GoogleApiError };

  /**
   * PUTs the bytes from `offset` on (a resume names its range). Rejected =
   * Google answered no; interrupted = ask Google what it holds.
   */
  async function putBytes(session: string, bytes: Buffer, offset: number, resume: boolean, what: string): Promise<UploadStep> {
    const chunk = bytes.subarray(offset);
    let response: Response;
    try {
      response = await send(fetchImpl, session, {
        method: 'PUT',
        redirect: 'manual',
        headers: await authorized({
          Accept: 'application/json',
          'Content-Type': 'message/rfc822',
          ...(resume ? { 'Content-Range': `bytes ${offset}-${bytes.length - 1}/${bytes.length}` } : {}),
        }),
        body: chunk,
      }, what, REQUEST_TIMEOUT_MS + Math.ceil(chunk.length / UPLOAD_MIN_BYTES_PER_SECOND) * 1000);
    } catch (error) {
      if (!(error instanceof GoogleApiError)) throw error;
      // The bytes never left this Mac: Google holds no more than before.
      if (error.code === 'network' && error.transportCode && GOOGLE_NEVER_CONNECTED.has(error.transportCode)) return { kind: 'rejected', error };
      return { kind: 'interrupted', error };
    }
    // An unreadable 2xx throws from here: Google finished, so its effect is unknown.
    if (response.status === 200 || response.status === 201) return { kind: 'done', body: await readJson(response, what) };
    const error = apiError(response.status, await readJson(response, what).catch(() => ({})), what);
    if (response.status === 401) deps.invalidateAccessToken();
    const retryable = response.status === 308 || response.status === 401 || response.status === 408 || response.status === 429 || response.status >= 500;
    return retryable ? { kind: 'interrupted', error } : { kind: 'rejected', error };
  }

  type UploadStatus = { kind: 'done'; body: any } | { kind: 'incomplete'; received: number } | { kind: 'unknown' };

  /** Asks Google how much of the message it holds (`Content-Range: bytes *\/total`). */
  async function uploadStatus(session: string, total: number, what: string): Promise<UploadStatus> {
    for (let attempt = 0; attempt < 2; attempt++) {
      let response: Response;
      try {
        response = await send(fetchImpl, session, {
          method: 'PUT',
          redirect: 'manual',
          headers: await authorized({ Accept: 'application/json', 'Content-Range': `bytes */${total}` }),
        }, `${what} status check`);
      } catch {
        return { kind: 'unknown' };
      }
      if (response.status === 200 || response.status === 201) {
        try {
          return { kind: 'done', body: await readJson(response, what) };
        } catch {
          return { kind: 'unknown' };
        }
      }
      await response.text().catch(() => '');
      if (response.status === 308) {
        const range = response.headers.get('range');
        if (!range) return { kind: 'incomplete', received: 0 };
        const last = /^bytes=0-(\d+)$/.exec(range.trim());
        const received = last ? Number(last[1]) + 1 : Number.NaN;
        return Number.isSafeInteger(received) && received < total ? { kind: 'incomplete', received } : { kind: 'unknown' };
      }
      if (response.status === 401 && attempt === 0) {
        deps.invalidateAccessToken();
        continue;
      }
      return { kind: 'unknown' };
    }
    return { kind: 'unknown' };
  }

  /**
   * One message through Gmail's resumable upload: open a session, PUT the
   * RFC 822 bytes, and after an interruption ask Google how many bytes it
   * holds and resume once. Whenever Google answers, the effect is known: a
   * failed open, a rejected PUT, or bytes Google says it lacks saved or sent
   * nothing (`none`). Only a status Google never gave is `unknown`.
   */
  async function upload(method: 'POST' | 'PUT', path: string, metadata: Record<string, unknown>, bytes: Buffer, what: string): Promise<any> {
    if (bytes.length > GMAIL_MAX_UPLOAD_BYTES) {
      throw new GoogleApiError(`${what}: the message is ${(bytes.length / (1024 * 1024)).toFixed(1)} MB; Gmail accepts at most 35 MB`, 413, 'message_too_large', undefined, 'none');
    }
    let session: string;
    try {
      session = await openSession(method, path, metadata, bytes.length, what);
    } catch (error) {
      throw withEffect(error, 'none');
    }
    let offset = 0;
    for (let resumes = 0; ; resumes++) {
      const step = await putBytes(session, bytes, offset, resumes > 0, what);
      if (step.kind === 'done') return step.body;
      if (step.kind === 'rejected') throw withEffect(step.error, 'none');
      const status = await uploadStatus(session, bytes.length, what);
      if (status.kind === 'done') return status.body;
      if (status.kind === 'unknown') throw withEffect(step.error, 'unknown');
      if (resumes >= MAX_UPLOAD_RESUMES) {
        throw new GoogleApiError(`${what} was interrupted twice; Gmail holds only part of the message, so nothing was saved or sent`, 0, 'upload_incomplete', undefined, 'none');
      }
      offset = status.received;
    }
  }

  return {
    async getProfile() {
      const body = await get('/profile', {}, 'Gmail profile');
      const emailAddress = typeof body.emailAddress === 'string' ? body.emailAddress.trim().toLowerCase() : '';
      const historyId = body.historyId == null ? '' : String(body.historyId);
      if (!emailAddress || !historyId) throw new GoogleApiError('Gmail profile returned no address or history id', 200, 'unreadable_response');
      return { emailAddress, historyId, messagesTotal: Number(body.messagesTotal) || undefined };
    },

    async listMessages(input) {
      const body = await get('/messages', {
        q: input.q,
        pageToken: input.pageToken,
        maxResults: String(input.maxResults ?? 500),
        includeSpamTrash: input.includeSpamTrash ? 'true' : 'false',
      }, 'Gmail message list');
      const messages = Array.isArray(body.messages)
        ? body.messages.filter((entry: any) => typeof entry?.id === 'string')
          .map((entry: any) => ({ id: entry.id, threadId: typeof entry.threadId === 'string' ? entry.threadId : undefined }))
        : [];
      const estimate = Number(body.resultSizeEstimate);
      return {
        messages,
        nextPageToken: typeof body.nextPageToken === 'string' ? body.nextPageToken : undefined,
        ...(Number.isFinite(estimate) && estimate >= 0 ? { resultSizeEstimate: estimate } : {}),
      };
    },

    async getMessage(id, options = {}) {
      const format = options.format ?? 'full';
      const body = await get(`/messages/${encodeURIComponent(id)}`, {
        format,
        ...(format === 'metadata' && options.metadataHeaders?.length ? { metadataHeaders: options.metadataHeaders } : {}),
      }, 'Gmail message');
      if (typeof body.id !== 'string' || typeof body.threadId !== 'string') {
        throw new GoogleApiError('Gmail message returned no id or thread id', 200, 'unreadable_response');
      }
      return body as GmailMessage;
    },

    async getThread(id, options = {}) {
      const format = options.format ?? 'full';
      const body = await get(`/threads/${encodeURIComponent(id)}`, {
        format,
        ...(format === 'metadata' && options.metadataHeaders?.length ? { metadataHeaders: options.metadataHeaders } : {}),
      }, 'Gmail thread');
      if (typeof body.id !== 'string') throw new GoogleApiError('Gmail thread returned no id', 200, 'unreadable_response');
      const messages = Array.isArray(body.messages)
        ? body.messages.filter((entry: any) => typeof entry?.id === 'string' && typeof entry?.threadId === 'string')
        : [];
      return { id: body.id, historyId: body.historyId == null ? undefined : String(body.historyId), messages };
    },

    async createDraft(message) {
      const what = 'Gmail draft create';
      const body = 'rfc822' in message
        ? await upload('POST', '/drafts', message.threadId ? { message: { threadId: message.threadId } } : {}, message.rfc822, what)
        : await call('POST', '/drafts', {}, { message: rawBody(message) }, what);
      return draftOf(body, what);
    },

    async updateDraft(draftId, message) {
      const what = 'Gmail draft update';
      const path = `/drafts/${encodeURIComponent(draftId)}`;
      const body = 'rfc822' in message
        ? await upload('PUT', path, { id: draftId, ...(message.threadId ? { message: { threadId: message.threadId } } : {}) }, message.rfc822, what)
        : await call('PUT', path, {}, { id: draftId, message: rawBody(message) }, what);
      return draftOf(body, what);
    },

    async getDraft(draftId) {
      const what = 'Gmail draft';
      return draftOf(await get(`/drafts/${encodeURIComponent(draftId)}`, { format: 'full' }, what), what);
    },

    async deleteDraft(draftId) {
      await call('DELETE', `/drafts/${encodeURIComponent(draftId)}`, {}, undefined, 'Gmail draft delete');
    },

    async sendDraft(draftId) {
      const what = 'Gmail draft send';
      return messageOf(await call('POST', '/drafts/send', {}, { id: draftId }, what), what);
    },

    async sendMessage(message) {
      const what = 'Gmail send';
      const body = 'rfc822' in message
        ? await upload('POST', '/messages/send', message.threadId ? { threadId: message.threadId } : {}, message.rfc822, what)
        : await call('POST', '/messages/send', {}, rawBody(message), what);
      return messageOf(body, what);
    },

    async listHistory(input) {
      const body = await get('/history', {
        startHistoryId: input.startHistoryId,
        pageToken: input.pageToken,
        maxResults: String(input.maxResults ?? 500),
        historyTypes: 'messageAdded',
      }, 'Gmail history');
      const records = Array.isArray(body.history)
        ? body.history.map((record: any) => ({
          id: record?.id == null ? '' : String(record.id),
          messagesAdded: Array.isArray(record?.messagesAdded)
            ? record.messagesAdded
              .map((added: any) => added?.message)
              .filter((message: any) => typeof message?.id === 'string')
              .map((message: any) => ({
                id: message.id,
                threadId: typeof message.threadId === 'string' ? message.threadId : undefined,
                labelIds: Array.isArray(message.labelIds) ? message.labelIds.map(String) : [],
              }))
            : [],
        }))
        : [];
      return {
        records,
        nextPageToken: typeof body.nextPageToken === 'string' ? body.nextPageToken : undefined,
        historyId: body.historyId == null ? '' : String(body.historyId),
      };
    },

    async listSendAsAddresses() {
      const body = await get('/settings/sendAs', {}, 'Gmail send-as list');
      return Array.isArray(body.sendAs)
        ? body.sendAs
          .map((entry: any) => (typeof entry?.sendAsEmail === 'string' ? entry.sendAsEmail.trim().toLowerCase() : ''))
          .filter(Boolean)
        : [];
    },
  };
}
