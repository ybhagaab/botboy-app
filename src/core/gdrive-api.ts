/**
 * Google Drive v3 over plain fetch (no googleapis dependency), on the Gmail
 * account's grant (NON_AMAZON_PATHS_PLAN.md A6/A7, D3; design §6).
 *
 * Scopes (opt-in per account, "Connect Google Drive"):
 *   - drive.readonly: capture, search, and read files the owner chose.
 *   - drive.file: create BotBoy documents and update only files BotBoy made.
 * Full `drive` is never requested.
 *
 * Write outcomes are judged by `classifyWriteFailure`: `not_written` only when
 * the request provably never reached Google or Google answered a readable
 * 4xx other than 408/429; everything else is `unknown` and is never resent.
 * Tokens are never logged; error text passes through secret redaction.
 */

import { GOOGLE_NEVER_CONNECTED, GoogleApiError, type FetchLike } from './gmail-api.js';
import { redactSecrets } from './sensitive-files.js';

export const GDRIVE_READONLY_SCOPE = 'https://www.googleapis.com/auth/drive.readonly';
export const GDRIVE_FILE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
export const GDRIVE_REQUESTED_SCOPES: readonly string[] = Object.freeze([GDRIVE_READONLY_SCOPE, GDRIVE_FILE_SCOPE]);

export const GDRIVE_FOLDER_MIME = 'application/vnd.google-apps.folder';
export const GDRIVE_DOC_MIME = 'application/vnd.google-apps.document';
export const GDRIVE_SHEET_MIME = 'application/vnd.google-apps.spreadsheet';
export const GDRIVE_SLIDES_MIME = 'application/vnd.google-apps.presentation';
export const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
/** Google's files.export limit. */
export const GDRIVE_EXPORT_LIMIT_BYTES = 10 * 1024 * 1024;

export const GDRIVE_API_BASE = 'https://www.googleapis.com';
const REQUEST_TIMEOUT_MS = 60_000;

export const GDRIVE_FILE_FIELDS = 'id,name,mimeType,modifiedTime,headRevisionId,md5Checksum,sha256Checksum,size,parents,owners(emailAddress,displayName),ownedByMe,sharedWithMeTime,webViewLink,trashed,appProperties';

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime?: string;
  headRevisionId?: string;
  md5Checksum?: string;
  sha256Checksum?: string;
  size?: string;
  parents?: string[];
  owners?: Array<{ emailAddress?: string; displayName?: string }>;
  webViewLink?: string;
  trashed?: boolean;
  ownedByMe?: boolean;
  sharedWithMeTime?: string;
  appProperties?: Record<string, string>;
}

export interface DriveChange {
  fileId: string;
  removed?: boolean;
  file?: DriveFile;
  time?: string;
}

/** Backslash first, then apostrophe (Drive query syntax). */
export function escapeDriveQueryLiteral(value: string): string {
  return String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

export type DriveWriteJudgement = 'not_written' | 'unknown';

const TLS_FAILURE = /^(?:ERR_TLS|ERR_SSL|CERT_|UNABLE_TO_|SELF_SIGNED|DEPTH_ZERO|EPROTO)/;

/** May BotBoy safely try this write again (`not_written`), or is the effect unknown? */
export function classifyWriteFailure(error: unknown): DriveWriteJudgement {
  if (!(error instanceof GoogleApiError)) return 'unknown';
  if (error.code === 'network' && error.transportCode
    && (GOOGLE_NEVER_CONNECTED.has(error.transportCode) || TLS_FAILURE.test(error.transportCode))) return 'not_written';
  const { status } = error;
  const readableBody = error.code !== 'unreadable_response' && !error.code.startsWith('http_');
  if (status >= 400 && status < 500 && status !== 408 && status !== 429 && readableBody) return 'not_written';
  return 'unknown';
}

/** Drive failure → capture-health kind + owner-safe reason (the reason text picks the next action). */
export function driveFailureForHealth(error: unknown): { kind: 'service_auth' | 'rate_limited' | 'network' | 'unknown'; reason: string } {
  const message = redactSecrets(String((error as Error)?.message ?? error)).slice(0, 240);
  const code = error instanceof GoogleApiError ? error.code : (error as { code?: string })?.code ?? '';
  if (/rateLimitExceeded|userRateLimitExceeded|ratelimited/i.test(code) || (error instanceof GoogleApiError && error.status === 429)) {
    return { kind: 'rate_limited', reason: message };
  }
  if (/accessNotConfigured|SERVICE_DISABLED/i.test(code) || /accessNotConfigured|SERVICE_DISABLED|has not been used/i.test(message)) {
    return { kind: 'service_auth', reason: `accessNotConfigured: ${message}` };
  }
  if (/insufficient/i.test(code) || /insufficient.*scope|drive_not_granted/i.test(message)) {
    return { kind: 'service_auth', reason: `insufficient scope: ${message}` };
  }
  if (code === 'reconnect_required' || code === 'invalid_grant' || code === 'not_connected' || /invalid_grant/.test(message)) {
    return { kind: 'service_auth', reason: `invalid_grant: ${message}` };
  }
  if (code === 'network' || code === 'timeout') return { kind: 'network', reason: message };
  return { kind: 'unknown', reason: message };
}

async function send(fetchImpl: FetchLike, url: string, init: RequestInit, what: string): Promise<Response> {
  try {
    return await fetchImpl(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch (error) {
    const name = (error as Error)?.name ?? '';
    if (name === 'TimeoutError' || name === 'AbortError') throw new GoogleApiError(`${what} timed out`, 0, 'timeout');
    const cause = (error as { cause?: { code?: string } })?.cause?.code;
    const transportCode = typeof cause === 'string' ? cause.replace(/[^A-Z0-9_]/gi, '').slice(0, 40) : undefined;
    throw new GoogleApiError(`${what} failed: network error${transportCode ? ` (${transportCode})` : ''}`, 0, 'network', transportCode);
  }
}

async function failure(response: Response, what: string): Promise<GoogleApiError> {
  const text = await response.text().catch(() => '');
  let body: any = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = null; }
  if (!body) return new GoogleApiError(`${what} failed (HTTP ${response.status})`, response.status, text ? 'unreadable_response' : `http_${response.status}`);
  const error = body.error;
  const reason = Array.isArray(error?.errors) && typeof error.errors[0]?.reason === 'string'
    ? error.errors[0].reason
    : typeof error?.status === 'string' ? error.status : typeof error === 'string' ? error : `http_${response.status}`;
  const message = typeof error?.message === 'string' ? `: ${redactSecrets(error.message).replace(/\s+/g, ' ').slice(0, 200)}` : '';
  return new GoogleApiError(`${what} failed (HTTP ${response.status} ${reason}${message})`, response.status, reason);
}

export interface DriveClient {
  listFiles(input: { q: string; pageToken?: string; pageSize?: number; fields?: string; orderBy?: string }): Promise<{ files: DriveFile[]; nextPageToken?: string }>;
  getFile(fileId: string, fields?: string): Promise<DriveFile>;
  exportFile(fileId: string, mimeType: string): Promise<Buffer>;
  downloadFile(fileId: string): Promise<Buffer>;
  getStartPageToken(): Promise<string>;
  listChanges(pageToken: string): Promise<{ changes: DriveChange[]; nextPageToken?: string; newStartPageToken?: string }>;
  createFile(input: { name: string; parents: string[]; mimeType?: string; appProperties?: Record<string, string>; media: Buffer; mediaMimeType: string }): Promise<DriveFile>;
  createFolder(input: { name: string; parents?: string[]; appProperties?: Record<string, string> }): Promise<DriveFile>;
  updateMedia(fileId: string, input: { media: Buffer; mediaMimeType: string }): Promise<DriveFile>;
}

export function createDriveClient(deps: {
  fetchImpl?: FetchLike;
  apiBase?: string;
  accessToken: () => Promise<string>;
  invalidateAccessToken?: () => void;
}): DriveClient {
  const fetchImpl: FetchLike = deps.fetchImpl ?? ((input, init) => fetch(input, init));
  const base = (deps.apiBase ?? GDRIVE_API_BASE).replace(/\/+$/, '');

  /** One authorized call; a 401 refreshes the access token and tries once more (401 = nothing written). */
  async function call(url: string, init: RequestInit, what: string): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      const token = await deps.accessToken();
      const response = await send(fetchImpl, url, { ...init, headers: { ...(init.headers as Record<string, string> ?? {}), Authorization: `Bearer ${token}` } }, what);
      if (response.status === 401 && attempt === 0) {
        deps.invalidateAccessToken?.();
        await response.text().catch(() => '');
        continue;
      }
      if (!response.ok) throw await failure(response, what);
      return response;
    }
  }

  async function json(url: string, init: RequestInit, what: string): Promise<any> {
    const response = await call(url, init, what);
    const text = await response.text();
    try { return text ? JSON.parse(text) : {}; } catch {
      throw new GoogleApiError(`${what} returned an unreadable response`, response.status, 'unreadable_response');
    }
  }

  async function bytes(url: string, what: string): Promise<Buffer> {
    const response = await call(url, { method: 'GET' }, what);
    return Buffer.from(await response.arrayBuffer());
  }

  function multipart(metadata: Record<string, unknown>, media: Buffer, mediaMimeType: string): { body: Buffer; contentType: string } {
    const boundary = `botboy-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
    const head = Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: ${mediaMimeType}\r\n\r\n`);
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
    return { body: Buffer.concat([head, media, tail]), contentType: `multipart/related; boundary=${boundary}` };
  }

  return {
    async listFiles(input) {
      const params = new URLSearchParams({
        q: input.q,
        pageSize: String(Math.min(Math.max(input.pageSize ?? 100, 1), 1000)),
        fields: `nextPageToken,files(${input.fields ?? GDRIVE_FILE_FIELDS})`,
        spaces: 'drive',
      });
      if (input.pageToken) params.set('pageToken', input.pageToken);
      if (input.orderBy) params.set('orderBy', input.orderBy);
      const body = await json(`${base}/drive/v3/files?${params}`, { method: 'GET' }, 'Drive file list');
      return { files: Array.isArray(body.files) ? body.files : [], ...(body.nextPageToken ? { nextPageToken: body.nextPageToken } : {}) };
    },
    async getFile(fileId, fields = GDRIVE_FILE_FIELDS) {
      return json(`${base}/drive/v3/files/${encodeURIComponent(fileId)}?fields=${encodeURIComponent(fields)}`, { method: 'GET' }, 'Drive file read');
    },
    exportFile(fileId, mimeType) {
      return bytes(`${base}/drive/v3/files/${encodeURIComponent(fileId)}/export?mimeType=${encodeURIComponent(mimeType)}`, 'Drive export');
    },
    downloadFile(fileId) {
      return bytes(`${base}/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`, 'Drive download');
    },
    async getStartPageToken() {
      const body = await json(`${base}/drive/v3/changes/startPageToken`, { method: 'GET' }, 'Drive changes start');
      if (typeof body.startPageToken !== 'string') throw new GoogleApiError('Drive changes start returned no token', 200, 'unreadable_response');
      return body.startPageToken;
    },
    async listChanges(pageToken) {
      const params = new URLSearchParams({
        pageToken,
        pageSize: '200',
        includeItemsFromAllDrives: 'false',
        includeRemoved: 'true',
        spaces: 'drive',
        fields: `nextPageToken,newStartPageToken,changes(fileId,removed,time,file(${GDRIVE_FILE_FIELDS}))`,
      });
      const body = await json(`${base}/drive/v3/changes?${params}`, { method: 'GET' }, 'Drive changes');
      return {
        changes: Array.isArray(body.changes) ? body.changes : [],
        ...(body.nextPageToken ? { nextPageToken: body.nextPageToken } : {}),
        ...(body.newStartPageToken ? { newStartPageToken: body.newStartPageToken } : {}),
      };
    },
    async createFile(input) {
      const metadata: Record<string, unknown> = { name: input.name, parents: input.parents };
      if (input.mimeType) metadata.mimeType = input.mimeType;
      if (input.appProperties) metadata.appProperties = input.appProperties;
      const { body, contentType } = multipart(metadata, input.media, input.mediaMimeType);
      return json(`${base}/upload/drive/v3/files?uploadType=multipart&fields=${encodeURIComponent(GDRIVE_FILE_FIELDS)}`, {
        method: 'POST', headers: { 'Content-Type': contentType }, body,
      }, 'Drive upload');
    },
    async createFolder(input) {
      return json(`${base}/drive/v3/files?fields=${encodeURIComponent(GDRIVE_FILE_FIELDS)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: input.name, mimeType: GDRIVE_FOLDER_MIME, ...(input.parents ? { parents: input.parents } : {}), ...(input.appProperties ? { appProperties: input.appProperties } : {}) }),
      }, 'Drive folder create');
    },
    async updateMedia(fileId, input) {
      return json(`${base}/upload/drive/v3/files/${encodeURIComponent(fileId)}?uploadType=media&fields=${encodeURIComponent(GDRIVE_FILE_FIELDS)}`, {
        method: 'PATCH', headers: { 'Content-Type': input.mediaMimeType }, body: input.media,
      }, 'Drive update');
    },
  };
}
