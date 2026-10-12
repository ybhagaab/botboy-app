/**
 * In-memory Google Drive for tests: files with revisions, a changes feed,
 * exports, appProperties queries, and injectable failures. It understands the
 * query shapes BotBoy sends (and unescapes literals like Drive does).
 */

import { createHash } from 'crypto';
import { GoogleApiError } from './gmail-api.js';
import { GDRIVE_DOC_MIME, GDRIVE_FOLDER_MIME, type DriveChange, type DriveClient, type DriveFile } from './gdrive-api.js';

export interface FakeDriveFile extends DriveFile {
  content: Buffer;
  /** Per-mime export bodies (Google types). */
  exports?: Record<string, Buffer | string>;
}

type Op = keyof DriveClient;

export interface FakeDrive extends DriveClient {
  files: Map<string, FakeDriveFile>;
  calls: Array<{ op: Op; args: unknown[] }>;
  /** Next call of `op` throws this (once), optionally AFTER applying the effect (lost answer). */
  failNext(op: Op, error: GoogleApiError, opts?: { afterEffect?: boolean }): void;
  /** Adds or edits a file and records a change. */
  put(file: Partial<FakeDriveFile> & { id: string; name: string }): FakeDriveFile;
  ownerEmail: string;
}

function unescapeLiteral(text: string): string {
  return text.replace(/\\(.)/g, '$1');
}
const LITERAL = String.raw`'((?:[^'\\]|\\.)*)'`;

export function createFakeDrive(ownerEmail = 'me@example.com'): FakeDrive {
  const files = new Map<string, FakeDriveFile>();
  const changes: DriveChange[] = [];
  const calls: FakeDrive['calls'] = [];
  const failures = new Map<Op, { error: GoogleApiError; afterEffect: boolean }>();
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
      webViewLink: `https://docs.example/${input.id}`,
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
      else if (ch === '{') depth++;
      else if (ch === '}') depth--;
      else if (depth === 0 && q.startsWith(' and ', i)) { out.push(q.slice(start, i).trim()); start = i + 5; i += 4; }
    }
    out.push(q.slice(start).trim());
    return out.filter(Boolean);
  }

  function matches(file: FakeDriveFile, clauses: string[]): boolean {
    for (const clause of clauses) {
      let m: RegExpMatchArray | null;
      if (clause === 'trashed=false') { if (file.trashed) return false; continue; }
      if (clause === "'me' in owners") { if (!file.ownedByMe) return false; continue; }
      if (clause === 'sharedWithMe=true') { if (!file.sharedWithMeTime) return false; continue; }
      if ((m = clause.match(new RegExp(`^mimeType (!?=) ${LITERAL}$`)))) {
        const equal = file.mimeType === unescapeLiteral(m[2]);
        if (m[1] === '=' ? !equal : equal) return false;
        continue;
      }
      if ((m = clause.match(new RegExp(`^modifiedTime > ${LITERAL}$`)))) { if ((file.modifiedTime ?? '') <= m[1]) return false; continue; }
      if ((m = clause.match(new RegExp(`^${LITERAL} in parents$`)))) { if (!file.parents?.includes(unescapeLiteral(m[1]))) return false; continue; }
      if ((m = clause.match(new RegExp(`^name=${LITERAL}$`)))) { if (file.name !== unescapeLiteral(m[1])) return false; continue; }
      if ((m = clause.match(new RegExp(`^appProperties has \\{ key=${LITERAL} and value=${LITERAL} \\}$`)))) {
        if (file.appProperties?.[unescapeLiteral(m[1])] !== unescapeLiteral(m[2])) return false;
        continue;
      }
      if ((m = clause.match(new RegExp(`^fullText contains ${LITERAL}$`)))) {
        const needle = unescapeLiteral(m[1]).toLowerCase();
        if (!file.name.toLowerCase().includes(needle) && !file.content.toString('utf8').toLowerCase().includes(needle)) return false;
        continue;
      }
      throw new Error(`fake drive: unsupported clause ${clause}`);
    }
    return true;
  }

  const fake: FakeDrive = {
    files,
    calls,
    ownerEmail,
    put,
    failNext(op, error, opts = {}) { failures.set(op, { error, afterEffect: Boolean(opts.afterEffect) }); },
    async listFiles(input) {
      record('listFiles', [input]);
      const clauses = splitClauses(input.q);
      const out = [...files.values()].filter(file => matches(file, clauses)).map(meta);
      return { files: out };
    },
    async getFile(fileId) {
      record('getFile', [fileId]);
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
      const id = `f${++seq}x${'0'.repeat(10)}`;
      const isDoc = input.mimeType === GDRIVE_DOC_MIME;
      const file = put({
        id,
        name: input.name,
        parents: input.parents,
        mimeType: input.mimeType ?? input.mediaMimeType,
        appProperties: input.appProperties,
        content: isDoc ? Buffer.alloc(0) : input.media,
        ...(isDoc ? { exports: { 'text/plain': input.media.toString('utf8') } } : {}),
      });
      after('createFile');
      return meta(file);
    },
    async createFolder(input) {
      record('createFolder', [input]);
      const id = `d${++seq}x${'0'.repeat(10)}`;
      return meta(put({ id, name: input.name, mimeType: GDRIVE_FOLDER_MIME, parents: input.parents ?? ['root'], appProperties: input.appProperties }));
    },
    async updateMedia(fileId, input) {
      record('updateMedia', [fileId, input]);
      const file = files.get(fileId);
      if (!file || !file.appProperties?.botboyPublicationId) throw new GoogleApiError('Drive update failed (HTTP 403 appNotAuthorizedToFile)', 403, 'appNotAuthorizedToFile');
      const updated = put({ ...file, content: input.media });
      after('updateMedia');
      return meta(updated);
    },
  };
  return fake;
}
