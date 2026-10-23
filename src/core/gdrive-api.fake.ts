/**
 * In-memory Google Drive for tests: files with revisions, a changes feed,
 * exports, appProperties queries, and injectable failures. It understands the
 * query shapes BotBoy sends (and unescapes literals like Drive does).
 *
 * By default it behaves like the drive.file grant for media updates (only
 * files BotBoy published may change). `fullAccess: true` behaves like the full
 * drive grant (google-workspace.md): any file may change, be moved, copied,
 * trashed, shared, or commented on.
 */

import { createHash } from 'crypto';
import fs from 'fs';
import { GoogleApiError } from './gmail-api.js';
import {
  GDRIVE_DOC_MIME,
  GDRIVE_FOLDER_MIME,
  type DriveChange,
  type DriveClient,
  type DriveComment,
  type DriveFile,
  type DrivePermission,
} from './gdrive-api.js';

export interface FakeDriveFile extends DriveFile {
  content: Buffer;
  /** Per-mime export bodies (Google types). */
  exports?: Record<string, Buffer | string>;
  description?: string;
  starred?: boolean;
}

type Op = keyof DriveClient;

export interface FakeDrive extends Required<DriveClient> {
  files: Map<string, FakeDriveFile>;
  permissions: Map<string, DrivePermission[]>;
  comments: Map<string, DriveComment[]>;
  calls: Array<{ op: Op; args: unknown[] }>;
  /** Next call of `op` throws this (once), optionally AFTER applying the effect (lost answer). */
  failNext(op: Op, error: GoogleApiError, opts?: { afterEffect?: boolean }): void;
  /** Adds or edits a file and records a change. */
  put(file: Partial<FakeDriveFile> & { id: string; name: string }): FakeDriveFile;
  ownerEmail: string;
  /** Called when an upload converts into a Google type (the Workspace fake builds the document). */
  onConvert?: (file: FakeDriveFile, media: Buffer, mediaMimeType: string) => void;
  /** Called when a blank Google file is created by metadata alone. */
  onCreateBlank?: (file: FakeDriveFile) => void;
}

function unescapeLiteral(text: string): string {
  return text.replace(/\\(.)/g, '$1');
}
const LITERAL = String.raw`'((?:[^'\\]|\\.)*)'`;

export function createFakeDrive(ownerEmail = 'me@example.com', options: { fullAccess?: boolean } = {}): FakeDrive {
  const files = new Map<string, FakeDriveFile>();
  const permissions = new Map<string, DrivePermission[]>();
  const comments = new Map<string, DriveComment[]>();
  const changes: DriveChange[] = [];
  const calls: FakeDrive['calls'] = [];
  const failures = new Map<Op, { error: GoogleApiError; afterEffect: boolean }>();
  const sessions = new Map<string, { metadata: Record<string, unknown>; mediaMimeType: string; size: number; fileId?: string; received: Buffer[]; length: number; done?: DriveFile }>();
  let seq = 0;
  let revision = 0;

  const meta = (file: FakeDriveFile): DriveFile => {
    const { content: _content, exports: _exports, ...rest } = file;
    return { ...rest };
  };
  const record = (op: Op, args: unknown[]) => {
    calls.push({ op, args });
    const failure = failures.get(op);
    if (failure && !failure.afterEffect) { failures.delete(op); throw failure.error; }
  };
  const after = (op: Op) => {
    const failure = failures.get(op);
    if (failure && failure.afterEffect) { failures.delete(op); throw failure.error; }
  };
  const notFound = (what: string) => new GoogleApiError(`${what} failed (HTTP 404 notFound: File not found.)`, 404, 'notFound');
  const existing = (fileId: string, what: string): FakeDriveFile => {
    const file = files.get(fileId);
    if (!file) throw notFound(what);
    return file;
  };

  function put(input: Partial<FakeDriveFile> & { id: string; name: string }): FakeDriveFile {
    const prior = files.get(input.id);
    const content = input.content ?? prior?.content ?? Buffer.alloc(0);
    const file: FakeDriveFile = {
      mimeType: 'text/plain',
      parents: ['root'],
      owners: [{ emailAddress: ownerEmail }],
      ownedByMe: true,
      trashed: false,
      ...prior,
      ...input,
      content,
      headRevisionId: `rev${++revision}`,
      md5Checksum: createHash('md5').update(content).digest('hex'),
      sha256Checksum: createHash('sha256').update(content).digest('hex'),
      size: String(content.length),
      modifiedTime: new Date(Date.UTC(2026, 9, 12, 0, 0, revision)).toISOString(),
      webViewLink: input.webViewLink ?? prior?.webViewLink ?? `https://docs.example/${input.id}`,
    };
    files.set(file.id, file);
    changes.push({ fileId: file.id, file: meta(file) });
    return file;
  }

  /** Splits on top-level ` and ` (not inside quotes or braces). */
  function splitClauses(q: string): string[] {
    const out: string[] = [];
    let depth = 0;
    let quoted = false;
    let start = 0;
    for (let i = 0; i < q.length; i++) {
      const ch = q[i];
      if (quoted) { if (ch === '\\') i++; else if (ch === "'") quoted = false; continue; }
      if (ch === "'") quoted = true;
      else if (ch === '{' || ch === '(') depth++;
      else if (ch === '}' || ch === ')') depth--;
      else if (depth === 0 && q.startsWith(' and ', i)) { out.push(q.slice(start, i).trim()); start = i + 5; i += 4; }
    }
    out.push(q.slice(start).trim());
    return out.filter(Boolean);
  }

  function matchesOne(file: FakeDriveFile, clause: string): boolean {
    let m: RegExpMatchArray | null;
    if (clause.startsWith('(') && clause.endsWith(')')) {
      // ( a or b or c )
      return clause.slice(1, -1).split(' or ').some(part => matchesOne(file, part.trim()));
    }
    if (clause === 'trashed=false') return !file.trashed;
    if (clause === 'trashed=true') return Boolean(file.trashed);
    if (clause === "'me' in owners") return Boolean(file.ownedByMe);
    if (clause === 'sharedWithMe=true') return Boolean(file.sharedWithMeTime);
    if ((m = clause.match(new RegExp(`^mimeType (!?=) ${LITERAL}$`)))) {
      const equal = file.mimeType === unescapeLiteral(m[2]);
      return m[1] === '=' ? equal : !equal;
    }
    if ((m = clause.match(new RegExp(`^mimeType contains ${LITERAL}$`)))) return file.mimeType.includes(unescapeLiteral(m[1]));
    if ((m = clause.match(new RegExp(`^modifiedTime > ${LITERAL}$`)))) return (file.modifiedTime ?? '') > m[1];
    if ((m = clause.match(new RegExp(`^${LITERAL} in parents$`)))) return Boolean(file.parents?.includes(unescapeLiteral(m[1])));
    if ((m = clause.match(new RegExp(`^name=${LITERAL}$`)))) return file.name === unescapeLiteral(m[1]);
    if ((m = clause.match(new RegExp(`^name contains ${LITERAL}$`)))) return file.name.toLowerCase().includes(unescapeLiteral(m[1]).toLowerCase());
    if ((m = clause.match(new RegExp(`^appProperties has \\{ key=${LITERAL} and value=${LITERAL} \\}$`)))) {
      return file.appProperties?.[unescapeLiteral(m[1])] === unescapeLiteral(m[2]);
    }
    if ((m = clause.match(new RegExp(`^fullText contains ${LITERAL}$`)))) {
      const needle = unescapeLiteral(m[1]).toLowerCase();
      return file.name.toLowerCase().includes(needle) || file.content.toString('utf8').toLowerCase().includes(needle);
    }
    throw new Error(`fake drive: unsupported clause ${clause}`);
  }

  const matches = (file: FakeDriveFile, clauses: string[]) => clauses.every(clause => matchesOne(file, clause));

  const mayChange = (file: FakeDriveFile, what: string) => {
    if (!options.fullAccess && !file.appProperties?.botboyPublicationId) {
      throw new GoogleApiError(`${what} failed (HTTP 403 appNotAuthorizedToFile)`, 403, 'appNotAuthorizedToFile');
    }
  };
  const isGoogleType = (mime?: string) => Boolean(mime?.startsWith('application/vnd.google-apps.'));

  function create(input: { name: string; parents?: string[]; mimeType?: string; appProperties?: Record<string, string>; media: Buffer; mediaMimeType: string; description?: string }): FakeDriveFile {
    const id = `f${++seq}x${'0'.repeat(10)}`;
    const converts = isGoogleType(input.mimeType) && input.mimeType !== GDRIVE_FOLDER_MIME;
    const file = put({
      id,
      name: input.name,
      parents: input.parents?.length ? input.parents : ['root'],
      mimeType: input.mimeType ?? input.mediaMimeType,
      appProperties: input.appProperties,
      ...(input.description ? { description: input.description } : {}),
      content: converts ? Buffer.alloc(0) : input.media,
      ...(input.mimeType === GDRIVE_DOC_MIME ? { exports: { 'text/plain': input.media.toString('utf8'), 'text/markdown': input.media.toString('utf8') } } : {}),
    });
    if (converts) fake.onConvert?.(file, input.media, input.mediaMimeType);
    return file;
  }

  const fake: FakeDrive = {
    files,
    permissions,
    comments,
    calls,
    ownerEmail,
    put,
    failNext(op, error, opts = {}) { failures.set(op, { error, afterEffect: Boolean(opts.afterEffect) }); },
    async listFiles(input) {
      record('listFiles', [input]);
      const clauses = splitClauses(input.q);
      const out = [...files.values()].filter(file => matches(file, clauses)).map(meta);
      const size = input.pageSize ?? 100;
      return { files: out.slice(0, size) };
    },
    async getFile(fileId) {
      record('getFile', [fileId]);
      // Like Drive, "root" is My Drive's top folder.
      if (fileId === 'root' && !files.has('root')) return { id: 'root', name: 'My Drive', mimeType: GDRIVE_FOLDER_MIME, ownedByMe: true };
      const file = files.get(fileId);
      if (!file) throw new GoogleApiError('Drive file read failed (HTTP 404 notFound)', 404, 'notFound');
      return meta(file);
    },
    async exportFile(fileId, mimeType) {
      record('exportFile', [fileId, mimeType]);
      const file = files.get(fileId);
      const body = file?.exports?.[mimeType];
      if (body === undefined) throw new GoogleApiError('Drive export failed (HTTP 400 badRequest)', 400, 'badRequest');
      return Buffer.isBuffer(body) ? body : Buffer.from(body);
    },
    async downloadFile(fileId) {
      record('downloadFile', [fileId]);
      const file = files.get(fileId);
      if (!file) throw new GoogleApiError('Drive download failed (HTTP 404 notFound)', 404, 'notFound');
      return file.content;
    },
    async getStartPageToken() {
      record('getStartPageToken', []);
      return String(changes.length);
    },
    async listChanges(pageToken) {
      record('listChanges', [pageToken]);
      const from = Number(pageToken);
      return { changes: changes.slice(from), newStartPageToken: String(changes.length) };
    },
    async createFile(input) {
      record('createFile', [input]);
      const file = create(input);
      after('createFile');
      return meta(file);
    },
    async createFolder(input) {
      record('createFolder', [input]);
      const id = `d${++seq}x${'0'.repeat(10)}`;
      const folder = meta(put({ id, name: input.name, mimeType: GDRIVE_FOLDER_MIME, parents: input.parents ?? ['root'], appProperties: input.appProperties }));
      after('createFolder');
      return folder;
    },
    async updateMedia(fileId, input) {
      record('updateMedia', [fileId, input]);
      const file = files.get(fileId);
      if (!file || (!options.fullAccess && !file.appProperties?.botboyPublicationId)) throw new GoogleApiError('Drive update failed (HTTP 403 appNotAuthorizedToFile)', 403, 'appNotAuthorizedToFile');
      const converts = isGoogleType(file.mimeType);
      const updated = put({ ...file, content: converts ? Buffer.alloc(0) : input.media, ...(file.mimeType === GDRIVE_DOC_MIME ? { exports: { 'text/plain': input.media.toString('utf8'), 'text/markdown': input.media.toString('utf8') } } : {}) });
      if (converts) fake.onConvert?.(updated, input.media, input.mediaMimeType);
      after('updateMedia');
      return meta(updated);
    },
    async createMetadataFile(input) {
      record('createMetadataFile', [input]);
      const id = `${input.mimeType === GDRIVE_FOLDER_MIME ? 'd' : 'g'}${++seq}x${'0'.repeat(10)}`;
      const file = put({ id, name: input.name, mimeType: input.mimeType, parents: input.parents?.length ? input.parents : ['root'], appProperties: input.appProperties, ...(input.description ? { description: input.description } : {}) });
      fake.onCreateBlank?.(file);
      after('createMetadataFile');
      return meta(file);
    },
    async updateFile(fileId, update, parents = {}) {
      record('updateFile', [fileId, update, parents]);
      const file = existing(fileId, 'Drive file update');
      mayChange(file, 'Drive file update');
      let nextParents = [...(file.parents ?? [])];
      if (parents.remove?.length) nextParents = nextParents.filter(parent => !parents.remove!.includes(parent));
      if (parents.add?.length) {
        for (const parent of parents.add) {
          if (parent !== 'root' && !files.has(parent)) throw notFound('Drive file update');
          if (!nextParents.includes(parent)) nextParents.push(parent);
        }
      }
      const updated = put({
        ...file,
        ...(update.name !== undefined ? { name: update.name } : {}),
        ...(update.description !== undefined ? { description: update.description } : {}),
        ...(update.trashed !== undefined ? { trashed: update.trashed } : {}),
        ...(update.starred !== undefined ? { starred: update.starred } : {}),
        ...(update.appProperties ? { appProperties: { ...(file.appProperties ?? {}), ...update.appProperties } } : {}),
        parents: nextParents,
      });
      after('updateFile');
      return meta(updated);
    },
    async copyFile(fileId, input) {
      record('copyFile', [fileId, input]);
      const source = existing(fileId, 'Drive copy');
      const id = `c${++seq}x${'0'.repeat(10)}`;
      const converts = Boolean(input.mimeType && input.mimeType !== source.mimeType && isGoogleType(input.mimeType));
      const copy = put({
        ...source,
        id,
        name: input.name ?? `Copy of ${source.name}`,
        parents: input.parents?.length ? input.parents : source.parents,
        appProperties: input.appProperties ?? source.appProperties,
        ...(input.mimeType ? { mimeType: input.mimeType } : {}),
        ...(converts ? { content: Buffer.alloc(0) } : {}),
        webViewLink: `https://docs.example/${id}`,
      });
      if (converts) fake.onConvert?.(copy, source.content, source.mimeType);
      after('copyFile');
      return meta(copy);
    },
    async listPermissions(fileId, opts = {}) {
      record('listPermissions', [fileId, opts]);
      existing(fileId, 'Drive sharing read');
      const all = permissions.get(fileId) ?? [{ id: 'owner', type: 'user', role: 'owner', emailAddress: ownerEmail }];
      return all.filter(permission => opts.publishedView || permission.view !== 'published').map(permission => ({ ...permission }));
    },
    async createPermission(fileId, permission, opts = {}) {
      record('createPermission', [fileId, permission, opts]);
      const file = existing(fileId, 'Drive share');
      mayChange(file, 'Drive share');
      const list = permissions.get(fileId) ?? [{ id: 'owner', type: 'user', role: 'owner', emailAddress: ownerEmail }];
      const same = list.find(entry => entry.type === permission.type && entry.view === permission.view
        && (entry.emailAddress ?? '') === (permission.emailAddress ?? '') && (entry.domain ?? '') === (permission.domain ?? ''));
      if (same) { same.role = permission.role; permissions.set(fileId, list); after('createPermission'); return { ...same }; }
      const created: DrivePermission = { id: `perm${++seq}`, ...permission };
      list.push(created);
      permissions.set(fileId, list);
      after('createPermission');
      return { ...created };
    },
    async updatePermission(fileId, permissionId, input) {
      record('updatePermission', [fileId, permissionId, input]);
      const list = permissions.get(fileId) ?? [];
      const entry = list.find(permission => permission.id === permissionId);
      if (!entry) throw notFound('Drive sharing change');
      entry.role = input.role;
      after('updatePermission');
      return { ...entry };
    },
    async deletePermission(fileId, permissionId) {
      record('deletePermission', [fileId, permissionId]);
      const list = permissions.get(fileId) ?? [];
      const index = list.findIndex(permission => permission.id === permissionId);
      if (index < 0) throw notFound('Drive unshare');
      list.splice(index, 1);
      after('deletePermission');
    },
    async listComments(fileId) {
      record('listComments', [fileId]);
      existing(fileId, 'Drive comments read');
      return { comments: (comments.get(fileId) ?? []).filter(comment => !comment.deleted).map(comment => JSON.parse(JSON.stringify(comment))) };
    },
    async createComment(fileId, input) {
      record('createComment', [fileId, input]);
      existing(fileId, 'Drive comment');
      const comment: DriveComment = { id: `cm${++seq}`, content: input.content, author: { displayName: 'Me', emailAddress: ownerEmail }, createdTime: new Date(Date.UTC(2026, 9, 23)).toISOString(), resolved: false, ...(input.quotedFileContent ? { quotedFileContent: { value: input.quotedFileContent.value } } : {}), replies: [] };
      comments.set(fileId, [...(comments.get(fileId) ?? []), comment]);
      after('createComment');
      return JSON.parse(JSON.stringify(comment));
    },
    async createReply(fileId, commentId, input) {
      record('createReply', [fileId, commentId, input]);
      const comment = (comments.get(fileId) ?? []).find(entry => entry.id === commentId);
      if (!comment) throw notFound('Drive comment reply');
      const reply = { id: `rp${++seq}`, content: input.content, ...(input.action ? { action: input.action } : {}) };
      comment.replies = [...(comment.replies ?? []), { ...reply, author: { displayName: 'Me', emailAddress: ownerEmail } }];
      if (input.action === 'resolve') comment.resolved = true;
      if (input.action === 'reopen') comment.resolved = false;
      after('createReply');
      return reply;
    },
    async startUpload(input) {
      record('startUpload', [input]);
      if (input.fileId) mayChange(existing(input.fileId, 'Drive upload start'), 'Drive upload start');
      const url = `https://upload.example/session/${++seq}`;
      sessions.set(url, { metadata: input.metadata, mediaMimeType: input.mediaMimeType, size: input.size, ...(input.fileId ? { fileId: input.fileId } : {}), received: [], length: 0 });
      return url;
    },
    async uploadChunk(sessionUrl, chunk, offset, total) {
      record('uploadChunk', [sessionUrl, chunk.length, offset, total]);
      const session = sessions.get(sessionUrl);
      if (!session) throw new GoogleApiError('Drive upload failed (HTTP 404 notFound)', 404, 'notFound');
      if (session.done) return { done: session.done };
      if (offset !== session.length) throw new GoogleApiError('Drive upload failed (HTTP 400 badRequest: offset)', 400, 'badRequest');
      session.received.push(Buffer.from(chunk));
      session.length += chunk.length;
      if (session.length < total) { after('uploadChunk'); return { next: session.length }; }
      const media = Buffer.concat(session.received);
      const metadata = session.metadata as { name?: string; parents?: string[]; mimeType?: string; appProperties?: Record<string, string>; description?: string };
      let file: FakeDriveFile;
      if (session.fileId) {
        const prior = existing(session.fileId, 'Drive upload');
        const converts = isGoogleType(prior.mimeType);
        file = put({ ...prior, ...(metadata.name ? { name: metadata.name } : {}), content: converts ? Buffer.alloc(0) : media });
        if (converts) fake.onConvert?.(file, media, session.mediaMimeType);
      } else {
        file = create({ name: metadata.name ?? 'Untitled', parents: metadata.parents, mimeType: metadata.mimeType, appProperties: metadata.appProperties, media, mediaMimeType: session.mediaMimeType, description: metadata.description });
      }
      session.done = meta(file);
      after('uploadChunk');
      return { done: session.done };
    },
    async uploadStatus(sessionUrl) {
      record('uploadStatus', [sessionUrl]);
      const session = sessions.get(sessionUrl);
      if (!session) throw new GoogleApiError('Drive upload status failed (HTTP 404 notFound)', 404, 'notFound');
      return session.done ? { done: session.done } : { next: session.length };
    },
    async downloadTo(fileId, destination, opts = {}) {
      record('downloadTo', [fileId, destination, opts]);
      const file = existing(fileId, opts.exportMimeType ? 'Drive export' : 'Drive download');
      let body: Buffer;
      if (opts.exportMimeType) {
        const exported = file.exports?.[opts.exportMimeType];
        if (exported === undefined) throw new GoogleApiError('Drive export failed (HTTP 400 badRequest)', 400, 'badRequest');
        body = Buffer.isBuffer(exported) ? exported : Buffer.from(exported);
      } else {
        if (file.mimeType.startsWith('application/vnd.google-apps.')) throw new GoogleApiError('Drive download failed (HTTP 403 fileNotDownloadable)', 403, 'fileNotDownloadable');
        body = file.content;
      }
      if (opts.maxBytes !== undefined && body.length > opts.maxBytes) throw new GoogleApiError(`Drive download is larger than ${opts.maxBytes} bytes`, 413, 'too_large');
      fs.writeFileSync(destination, body, { mode: 0o600, flag: 'wx' });
      after('downloadTo');
      return body.length;
    },
  };
  return fake;
}
