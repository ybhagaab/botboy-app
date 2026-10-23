/**
 * Google Drive v3 over plain fetch (no googleapis dependency), on the Gmail
 * account's grant (NON_AMAZON_PATHS_PLAN.md A6/A7, D3; design §6; Google
 * Workspace tools, owner request 2026-10-23: google-workspace.md).
 *
 * Scopes ("Connect Google Drive", opt-in per account):
 *   - drive (full): capture, search, read, create, edit, upload, download,
 *     rename, move, copy, trash, share and comment. The Docs, Sheets, Slides
 *     and Forms APIs accept it too, so one grant covers them all.
 *   - calendar: the owner's calendars and events (google-workspace-api.ts).
 * Older grants of drive.readonly + drive.file keep reading and publishing;
 * the edit tools ask the owner to press Connect Google Drive again.
 *
 * Write outcomes are judged by `classifyWriteFailure`: `not_written` only when
 * the request provably never reached Google or Google answered a readable
 * 4xx other than 408/429; everything else is `unknown` and is never resent.
 * Tokens are never logged; error text passes through secret redaction.
 */

import fs from 'fs';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import { GOOGLE_NEVER_CONNECTED, GoogleApiError, type FetchLike } from './gmail-api.js';
import { redactSecrets } from './sensitive-files.js';

export const GDRIVE_READONLY_SCOPE = 'https://www.googleapis.com/auth/drive.readonly';
export const GDRIVE_FILE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
export const GDRIVE_FULL_SCOPE = 'https://www.googleapis.com/auth/drive';
export const GCALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar';
/**
 * What Connect Google Drive asks for (owner request 2026-10-23: "renaming,
 * deleting, moving, sharing, everything"): full Drive, which the Docs, Sheets,
 * Slides and Forms APIs also accept, and Calendar. Google's consent screen
 * lets the owner leave Calendar unticked; Drive then works without it.
 */
export const GDRIVE_REQUESTED_SCOPES: readonly string[] = Object.freeze([GDRIVE_FULL_SCOPE, GCALENDAR_SCOPE]);

/** What a granted scope list allows. Full Drive covers reading and publishing. */
export function googleGrantOf(scopes: readonly string[]): { readDrive: boolean; publishDrive: boolean; editDrive: boolean; calendar: boolean } {
  const has = (scope: string) => scopes.includes(scope);
  const editDrive = has(GDRIVE_FULL_SCOPE);
  return {
    readDrive: editDrive || has(GDRIVE_READONLY_SCOPE),
    publishDrive: editDrive || has(GDRIVE_FILE_SCOPE),
    editDrive,
    calendar: has(GCALENDAR_SCOPE),
  };
}

export const GDRIVE_FOLDER_MIME = 'application/vnd.google-apps.folder';
export const GDRIVE_DOC_MIME = 'application/vnd.google-apps.document';
export const GDRIVE_SHEET_MIME = 'application/vnd.google-apps.spreadsheet';
export const GDRIVE_SLIDES_MIME = 'application/vnd.google-apps.presentation';
export const GDRIVE_FORM_MIME = 'application/vnd.google-apps.form';
export const GDRIVE_DRAWING_MIME = 'application/vnd.google-apps.drawing';
export const GDRIVE_SHORTCUT_MIME = 'application/vnd.google-apps.shortcut';
export const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
export const PPTX_MIME = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
/** Google's files.export limit. */
export const GDRIVE_EXPORT_LIMIT_BYTES = 10 * 1024 * 1024;

export const GDRIVE_API_BASE = 'https://www.googleapis.com';
const REQUEST_TIMEOUT_MS = 60_000;
/** One resumable-upload chunk (a multiple of 256 KiB, as Drive requires). */
export const GDRIVE_UPLOAD_CHUNK_BYTES = 8 * 1024 * 1024;

export const GDRIVE_FILE_FIELDS = 'id,name,mimeType,modifiedTime,headRevisionId,md5Checksum,sha256Checksum,size,parents,owners(emailAddress,displayName),ownedByMe,sharedWithMeTime,webViewLink,trashed,appProperties';
const PERMISSION_FIELDS = 'id,type,role,emailAddress,domain,displayName,view,deleted,pendingOwner,allowFileDiscovery';
const COMMENT_FIELDS = 'id,content,author(displayName,emailAddress),createdTime,modifiedTime,resolved,deleted,quotedFileContent(value),replies(id,content,author(displayName,emailAddress),createdTime,action,deleted)';

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

export interface DrivePermission {
  id: string;
  type: 'user' | 'group' | 'domain' | 'anyone' | string;
  role: string;
  emailAddress?: string;
  domain?: string;
  displayName?: string;
  view?: string;
  deleted?: boolean;
  pendingOwner?: boolean;
  allowFileDiscovery?: boolean;
}

export interface DriveComment {
  id: string;
  content?: string;
  author?: { displayName?: string; emailAddress?: string };
  createdTime?: string;
  modifiedTime?: string;
  resolved?: boolean;
  deleted?: boolean;
  quotedFileContent?: { value?: string };
  replies?: Array<{ id: string; content?: string; author?: { displayName?: string; emailAddress?: string }; createdTime?: string; action?: string; deleted?: boolean }>;
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
  if (error.effect === 'none') return 'not_written';
  if (error.effect === 'unknown') return 'unknown';
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

async function send(fetchImpl: FetchLike, url: string, init: RequestInit, what: string, timeoutMs = REQUEST_TIMEOUT_MS): Promise<Response> {
  try {
    return await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    const name = (error as Error)?.name ?? '';
    if (name === 'TimeoutError' || name === 'AbortError') throw new GoogleApiError(`${what} timed out`, 0, 'timeout');
    const cause = (error as { cause?: { code?: string } })?.cause?.code;
    const transportCode = typeof cause === 'string' ? cause.replace(/[^A-Z0-9_]/gi, '').slice(0, 40) : undefined;
    throw new GoogleApiError(`${what} failed: network error${transportCode ? ` (${transportCode})` : ''}`, 0, 'network', transportCode);
  }
}

/** The link Google gives to switch an API on, from the error details or its text. */
function activationUrlOf(error: any, message: string): string | null {
  const details = Array.isArray(error?.details) ? error.details : [];
  for (const detail of details) {
    const url = detail?.metadata?.activationUrl;
    if (typeof url === 'string' && /^https:\/\/console\.(?:developers|cloud)\.google\.com\//.test(url)) return url.slice(0, 300);
  }
  const match = message.match(/https:\/\/console\.(?:developers|cloud)\.google\.com\/\S+/);
  return match ? match[0].replace(/[).,]+$/, '').slice(0, 300) : null;
}

async function failure(response: Response, what: string): Promise<GoogleApiError> {
  const text = await response.text().catch(() => '');
  let body: any = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = null; }
  if (!body) return new GoogleApiError(`${what} failed (HTTP ${response.status})`, response.status, text ? 'unreadable_response' : `http_${response.status}`);
  const error = body.error;
  const reason = Array.isArray(error?.errors) && typeof error.errors[0]?.reason === 'string'
    ? error.errors[0].reason
    : Array.isArray(error?.details) && typeof error.details.find((detail: any) => typeof detail?.reason === 'string')?.reason === 'string'
      ? error.details.find((detail: any) => typeof detail?.reason === 'string').reason
      : typeof error?.status === 'string' ? error.status : typeof error === 'string' ? error : `http_${response.status}`;
  const rawMessage = typeof error?.message === 'string' ? redactSecrets(error.message).replace(/\s+/g, ' ') : '';
  const activation = activationUrlOf(error, rawMessage);
  const message = rawMessage ? `: ${rawMessage.slice(0, 260)}${activation && !rawMessage.slice(0, 260).includes(activation) ? ` Enable it at ${activation}` : ''}` : '';
  return new GoogleApiError(`${what} failed (HTTP ${response.status} ${reason}${message})`, response.status, reason);
}

/** One authorized Google REST caller (Drive and the Workspace APIs share it). */
export interface GoogleRest {
  /** A call that must answer 2xx; a 401 refreshes the access token and tries once more (401 = nothing written). */
  call(url: string, init: RequestInit, what: string, options?: { okStatuses?: number[]; timeoutMs?: number }): Promise<Response>;
  json<T = any>(url: string, init: RequestInit, what: string): Promise<T>;
  bytes(url: string, what: string): Promise<Buffer>;
}

export function createGoogleRest(deps: {
  fetchImpl?: FetchLike;
  accessToken: () => Promise<string>;
  invalidateAccessToken?: () => void;
}): GoogleRest {
  const fetchImpl: FetchLike = deps.fetchImpl ?? ((input, init) => fetch(input, init));

  async function call(url: string, init: RequestInit, what: string, options: { okStatuses?: number[]; timeoutMs?: number } = {}): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      const token = await deps.accessToken();
      const response = await send(fetchImpl, url, { ...init, headers: { ...(init.headers as Record<string, string> ?? {}), Authorization: `Bearer ${token}` } }, what, options.timeoutMs);
      if (response.status === 401 && attempt === 0) {
        deps.invalidateAccessToken?.();
        await response.text().catch(() => '');
        continue;
      }
      if (!response.ok && !options.okStatuses?.includes(response.status)) throw await failure(response, what);
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

  return { call, json, bytes };
}

/** Metadata changes one files.update makes; parents move with addParents/removeParents. */
export interface DriveFileUpdate {
  name?: string;
  description?: string;
  trashed?: boolean;
  starred?: boolean;
  appProperties?: Record<string, string>;
}

export interface DriveClient {
  listFiles(input: { q: string; pageToken?: string; pageSize?: number; fields?: string; orderBy?: string; allDrives?: boolean }): Promise<{ files: DriveFile[]; nextPageToken?: string }>;
  getFile(fileId: string, fields?: string): Promise<DriveFile>;
  exportFile(fileId: string, mimeType: string): Promise<Buffer>;
  downloadFile(fileId: string): Promise<Buffer>;
  getStartPageToken(): Promise<string>;
  listChanges(pageToken: string): Promise<{ changes: DriveChange[]; nextPageToken?: string; newStartPageToken?: string }>;
  createFile(input: { name: string; parents: string[]; mimeType?: string; appProperties?: Record<string, string>; media: Buffer; mediaMimeType: string }): Promise<DriveFile>;
  createFolder(input: { name: string; parents?: string[]; appProperties?: Record<string, string> }): Promise<DriveFile>;
  updateMedia(fileId: string, input: { media: Buffer; mediaMimeType: string }): Promise<DriveFile>;
  /** A file with no content (a blank Google Doc, Sheet, Slides deck, or a folder). */
  createMetadataFile?(input: { name: string; mimeType: string; parents?: string[]; appProperties?: Record<string, string>; description?: string }): Promise<DriveFile>;
  updateFile?(fileId: string, update: DriveFileUpdate, parents?: { add?: string[]; remove?: string[] }): Promise<DriveFile>;
  /** A copy; `mimeType` set to a Google type converts an Office file into a Google Doc, Sheet or Slides deck. */
  copyFile?(fileId: string, input: { name?: string; parents?: string[]; appProperties?: Record<string, string>; mimeType?: string }): Promise<DriveFile>;
  listPermissions?(fileId: string, options?: { publishedView?: boolean }): Promise<DrivePermission[]>;
  createPermission?(fileId: string, permission: { type: string; role: string; emailAddress?: string; domain?: string; view?: string; allowFileDiscovery?: boolean }, options?: { sendNotificationEmail?: boolean; emailMessage?: string }): Promise<DrivePermission>;
  updatePermission?(fileId: string, permissionId: string, input: { role: string }): Promise<DrivePermission>;
  deletePermission?(fileId: string, permissionId: string): Promise<void>;
  listComments?(fileId: string, options?: { pageToken?: string; pageSize?: number }): Promise<{ comments: DriveComment[]; nextPageToken?: string }>;
  createComment?(fileId: string, input: { content: string; quotedFileContent?: { value: string; mimeType?: string } }): Promise<DriveComment>;
  createReply?(fileId: string, commentId: string, input: { content: string; action?: 'resolve' | 'reopen' }): Promise<{ id: string; content?: string; action?: string }>;
  /** Starts a resumable upload (a new file, or new content for `fileId`); returns the session URL. */
  startUpload?(input: { metadata: Record<string, unknown>; mediaMimeType: string; size: number; fileId?: string }): Promise<string>;
  /** Sends one chunk; `done` carries the file once Google has all the bytes, else the next offset. */
  uploadChunk?(sessionUrl: string, chunk: Buffer, offset: number, total: number): Promise<{ done: DriveFile } | { next: number }>;
  /** How far Google got with a session (after a lost answer). */
  uploadStatus?(sessionUrl: string, total: number): Promise<{ done: DriveFile } | { next: number }>;
  /** Streams a file's bytes (or an export) to a local path; returns the bytes written. */
  downloadTo?(fileId: string, destination: string, options?: { exportMimeType?: string; maxBytes?: number }): Promise<number>;
}

/** A full-access client: every optional method is there. */
export type FullDriveClient = Required<DriveClient>;

export function createDriveClient(deps: {
  fetchImpl?: FetchLike;
  apiBase?: string;
  accessToken: () => Promise<string>;
  invalidateAccessToken?: () => void;
}): FullDriveClient {
  const base = (deps.apiBase ?? GDRIVE_API_BASE).replace(/\/+$/, '');
  const rest = createGoogleRest(deps);
  const { call, json, bytes } = rest;
  const file = (fileId: string) => `${base}/drive/v3/files/${encodeURIComponent(fileId)}`;

  function multipart(metadata: Record<string, unknown>, media: Buffer, mediaMimeType: string): { body: Buffer; contentType: string } {
    const boundary = `botboy-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
    const head = Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: ${mediaMimeType}\r\n\r\n`);
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
    return { body: Buffer.concat([head, media, tail]), contentType: `multipart/related; boundary=${boundary}` };
  }

  /** A 308 (more bytes wanted) or a final 200/201 file of one resumable session. */
  async function uploadAnswer(response: Response, what: string): Promise<{ done: DriveFile } | { next: number }> {
    if (response.status === 308) {
      const range = response.headers.get('range');
      await response.text().catch(() => '');
      const match = range?.match(/bytes=0-(\d+)/);
      return { next: match ? Number(match[1]) + 1 : 0 };
    }
    const text = await response.text();
    try { return { done: JSON.parse(text) as DriveFile }; } catch {
      throw new GoogleApiError(`${what} returned an unreadable response`, response.status, 'unreadable_response');
    }
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
      if (input.allDrives) {
        params.set('includeItemsFromAllDrives', 'true');
        params.set('supportsAllDrives', 'true');
        params.set('corpora', 'allDrives');
      }
      const body = await json(`${base}/drive/v3/files?${params}`, { method: 'GET' }, 'Drive file list');
      return { files: Array.isArray(body.files) ? body.files : [], ...(body.nextPageToken ? { nextPageToken: body.nextPageToken } : {}) };
    },
    async getFile(fileId, fields = GDRIVE_FILE_FIELDS) {
      return json(`${file(fileId)}?fields=${encodeURIComponent(fields)}&supportsAllDrives=true`, { method: 'GET' }, 'Drive file read');
    },
    exportFile(fileId, mimeType) {
      return bytes(`${file(fileId)}/export?mimeType=${encodeURIComponent(mimeType)}`, 'Drive export');
    },
    downloadFile(fileId) {
      return bytes(`${file(fileId)}?alt=media&supportsAllDrives=true`, 'Drive download');
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
      // No parents = My Drive (an empty list is left out rather than sent).
      const metadata: Record<string, unknown> = { name: input.name, ...(input.parents?.length ? { parents: input.parents } : {}) };
      if (input.mimeType) metadata.mimeType = input.mimeType;
      if (input.appProperties) metadata.appProperties = input.appProperties;
      const { body, contentType } = multipart(metadata, input.media, input.mediaMimeType);
      return json(`${base}/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=${encodeURIComponent(GDRIVE_FILE_FIELDS)}`, {
        method: 'POST', headers: { 'Content-Type': contentType }, body,
      }, 'Drive upload');
    },
    async createFolder(input) {
      return json(`${base}/drive/v3/files?supportsAllDrives=true&fields=${encodeURIComponent(GDRIVE_FILE_FIELDS)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: input.name, mimeType: GDRIVE_FOLDER_MIME, ...(input.parents ? { parents: input.parents } : {}), ...(input.appProperties ? { appProperties: input.appProperties } : {}) }),
      }, 'Drive folder create');
    },
    async updateMedia(fileId, input) {
      return json(`${base}/upload/drive/v3/files/${encodeURIComponent(fileId)}?uploadType=media&supportsAllDrives=true&fields=${encodeURIComponent(GDRIVE_FILE_FIELDS)}`, {
        method: 'PATCH', headers: { 'Content-Type': input.mediaMimeType }, body: input.media,
      }, 'Drive update');
    },
    async createMetadataFile(input) {
      return json(`${base}/drive/v3/files?supportsAllDrives=true&fields=${encodeURIComponent(GDRIVE_FILE_FIELDS)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: input.name,
          mimeType: input.mimeType,
          ...(input.parents ? { parents: input.parents } : {}),
          ...(input.appProperties ? { appProperties: input.appProperties } : {}),
          ...(input.description ? { description: input.description } : {}),
        }),
      }, 'Drive create');
    },
    async updateFile(fileId, update, parents = {}) {
      const params = new URLSearchParams({ supportsAllDrives: 'true', fields: GDRIVE_FILE_FIELDS });
      if (parents.add?.length) params.set('addParents', parents.add.join(','));
      if (parents.remove?.length) params.set('removeParents', parents.remove.join(','));
      return json(`${file(fileId)}?${params}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(update),
      }, 'Drive file update');
    },
    async copyFile(fileId, input) {
      return json(`${file(fileId)}/copy?supportsAllDrives=true&fields=${encodeURIComponent(GDRIVE_FILE_FIELDS)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...(input.name ? { name: input.name } : {}),
          ...(input.parents ? { parents: input.parents } : {}),
          ...(input.appProperties ? { appProperties: input.appProperties } : {}),
          ...(input.mimeType ? { mimeType: input.mimeType } : {}),
        }),
      }, 'Drive copy');
    },
    async listPermissions(fileId, options = {}) {
      const params = new URLSearchParams({ supportsAllDrives: 'true', fields: `permissions(${PERMISSION_FIELDS})`, pageSize: '100' });
      if (options.publishedView) params.set('includePermissionsForView', 'published');
      const body = await json(`${file(fileId)}/permissions?${params}`, { method: 'GET' }, 'Drive sharing read');
      return Array.isArray(body.permissions) ? body.permissions : [];
    },
    async createPermission(fileId, permission, options = {}) {
      const params = new URLSearchParams({ supportsAllDrives: 'true', fields: PERMISSION_FIELDS });
      if (options.sendNotificationEmail !== undefined) params.set('sendNotificationEmail', String(options.sendNotificationEmail));
      if (options.emailMessage) params.set('emailMessage', options.emailMessage);
      return json(`${file(fileId)}/permissions?${params}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(permission),
      }, 'Drive share');
    },
    async updatePermission(fileId, permissionId, input) {
      return json(`${file(fileId)}/permissions/${encodeURIComponent(permissionId)}?supportsAllDrives=true&fields=${encodeURIComponent(PERMISSION_FIELDS)}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ role: input.role }),
      }, 'Drive sharing change');
    },
    async deletePermission(fileId, permissionId) {
      const response = await call(`${file(fileId)}/permissions/${encodeURIComponent(permissionId)}?supportsAllDrives=true`, { method: 'DELETE' }, 'Drive unshare');
      await response.text().catch(() => '');
    },
    async listComments(fileId, options = {}) {
      const params = new URLSearchParams({ fields: `nextPageToken,comments(${COMMENT_FIELDS})`, pageSize: String(Math.min(Math.max(options.pageSize ?? 50, 1), 100)), includeDeleted: 'false' });
      if (options.pageToken) params.set('pageToken', options.pageToken);
      const body = await json(`${file(fileId)}/comments?${params}`, { method: 'GET' }, 'Drive comments read');
      return { comments: Array.isArray(body.comments) ? body.comments : [], ...(body.nextPageToken ? { nextPageToken: body.nextPageToken } : {}) };
    },
    async createComment(fileId, input) {
      return json(`${file(fileId)}/comments?fields=${encodeURIComponent(COMMENT_FIELDS)}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input),
      }, 'Drive comment');
    },
    async createReply(fileId, commentId, input) {
      return json(`${file(fileId)}/comments/${encodeURIComponent(commentId)}/replies?fields=${encodeURIComponent('id,content,action')}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input),
      }, 'Drive comment reply');
    },
    async startUpload(input) {
      const url = input.fileId
        ? `${base}/upload/drive/v3/files/${encodeURIComponent(input.fileId)}?uploadType=resumable&supportsAllDrives=true&fields=${encodeURIComponent(GDRIVE_FILE_FIELDS)}`
        : `${base}/upload/drive/v3/files?uploadType=resumable&supportsAllDrives=true&fields=${encodeURIComponent(GDRIVE_FILE_FIELDS)}`;
      const response = await call(url, {
        method: input.fileId ? 'PATCH' : 'POST',
        headers: {
          'Content-Type': 'application/json; charset=UTF-8',
          'X-Upload-Content-Type': input.mediaMimeType,
          'X-Upload-Content-Length': String(input.size),
        },
        body: JSON.stringify(input.metadata),
      }, 'Drive upload start');
      const location = response.headers.get('location');
      await response.text().catch(() => '');
      if (!location || !/^https:\/\//.test(location)) throw new GoogleApiError('Drive upload start returned no session', response.status, 'unreadable_response', undefined, 'none');
      return location;
    },
    async uploadChunk(sessionUrl, chunk, offset, total) {
      const end = offset + chunk.length - 1;
      const response = await call(sessionUrl, {
        method: 'PUT',
        headers: { 'Content-Length': String(chunk.length), 'Content-Range': `bytes ${offset}-${end}/${total}` },
        body: chunk,
      }, 'Drive upload', { okStatuses: [308], timeoutMs: 5 * 60_000 });
      return uploadAnswer(response, 'Drive upload');
    },
    async uploadStatus(sessionUrl, total) {
      const response = await call(sessionUrl, {
        method: 'PUT',
        headers: { 'Content-Length': '0', 'Content-Range': `bytes */${total}` },
      }, 'Drive upload status', { okStatuses: [308] });
      return uploadAnswer(response, 'Drive upload status');
    },
    async downloadTo(fileId, destination, options = {}) {
      const url = options.exportMimeType
        ? `${file(fileId)}/export?mimeType=${encodeURIComponent(options.exportMimeType)}`
        : `${file(fileId)}?alt=media&supportsAllDrives=true`;
      const response = await call(url, { method: 'GET' }, options.exportMimeType ? 'Drive export' : 'Drive download', { timeoutMs: 30 * 60_000 });
      if (!response.body) throw new GoogleApiError('Drive download returned no body', response.status, 'unreadable_response');
      const limit = options.maxBytes ?? Number.POSITIVE_INFINITY;
      let written = 0;
      const source = Readable.fromWeb(response.body as any);
      source.on('data', (chunk: Buffer) => {
        written += chunk.length;
        if (written > limit) source.destroy(new GoogleApiError(`Drive download is larger than ${limit} bytes`, 413, 'too_large'));
      });
      await pipeline(source, fs.createWriteStream(destination, { mode: 0o600, flags: 'wx' }));
      return written;
    },
  };
}
