/**
 * Google Drive file tools (google-workspace.md, "Drive"): search, create,
 * upload, download, organize (rename, move, copy, trash, restore), share and
 * comment. Docs, Sheets, Slides and Forms content tools live in their own
 * modules; gdrive-chat-tools.ts dispatches and checks authority first.
 *
 * Creates carry appProperties.botboyCreate: a create Google answered unclearly
 * is looked up by that key before anything is said, and a repeat of the same
 * create in the same request returns the first receipt instead of a second
 * file. Moves, renames, trash and restore set a state, so a repeat is
 * harmless. Nothing here deletes permanently: trash keeps a file 30 days.
 */

import path from 'path';
import { createHash } from 'crypto';
import fs from 'fs';
import type { ToolResult } from './tool-executor.js';
import {
  DOCX_MIME,
  GDRIVE_DOC_MIME,
  GDRIVE_DRAWING_MIME,
  GDRIVE_EXPORT_LIMIT_BYTES,
  GDRIVE_FOLDER_MIME,
  GDRIVE_FORM_MIME,
  GDRIVE_SHEET_MIME,
  GDRIVE_SHORTCUT_MIME,
  GDRIVE_SLIDES_MIME,
  GDRIVE_UPLOAD_CHUNK_BYTES,
  PPTX_MIME,
  XLSX_MIME,
  classifyWriteFailure,
  escapeDriveQueryLiteral,
  type DriveFile,
  type DrivePermission,
  type FullDriveClient,
} from './gdrive-api.js';
import { GoogleApiError } from './gmail-api.js';
import { redactSecrets } from './sensitive-files.js';
import { formatByteSize } from './gmail-mime.js';
import {
  GDRIVE_MAX_TRANSFER_BYTES,
  downloadedSecretHold,
  resolveDownloadTarget,
  resolveUploadSource,
  safeFileName,
  type UploadSource,
} from './gdrive-local-files.js';
import {
  createKey,
  googleErrorFailure,
  googleResult,
  invalid,
  numberedLines,
  PUBLIC_WORDS,
  trimmed,
  untrustedEnvelope,
  type GoogleFailure,
} from './google-tool-support.js';
import { accountEmail, accountsFor, failedResult, locateFile, singleAccountFor, type GoogleToolEnv } from './google-tool-env.js';

export const KIND_MIME: Readonly<Record<string, string>> = Object.freeze({
  doc: GDRIVE_DOC_MIME,
  sheet: GDRIVE_SHEET_MIME,
  slides: GDRIVE_SLIDES_MIME,
  form: GDRIVE_FORM_MIME,
  folder: GDRIVE_FOLDER_MIME,
  drawing: GDRIVE_DRAWING_MIME,
});

/** A short kind for a mime type, for results and the model. */
export function kindOf(mimeType: string): string {
  for (const [kind, mime] of Object.entries(KIND_MIME)) if (mime === mimeType) return kind;
  if (mimeType === GDRIVE_SHORTCUT_MIME) return 'shortcut';
  if (mimeType === 'application/pdf') return 'pdf';
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('application/vnd.google-apps.')) return 'google_other';
  return 'file';
}

function compactFile(accountId: string, file: DriveFile, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    accountId,
    fileId: file.id,
    name: redactSecrets(file.name ?? ''),
    kind: kindOf(file.mimeType ?? ''),
    mimeType: file.mimeType,
    ...(file.modifiedTime ? { modifiedTime: file.modifiedTime } : {}),
    ...(file.size ? { size: formatByteSize(Number(file.size)) } : {}),
    ...(file.owners?.length ? { owners: file.owners.map(owner => owner.emailAddress ?? owner.displayName).filter(Boolean) } : {}),
    ...(file.parents?.length ? { parents: file.parents } : {}),
    ...(file.trashed ? { trashed: true } : {}),
    ...(file.webViewLink ? { webViewLink: file.webViewLink } : {}),
    ...extra,
  };
}

function receipt(env: GoogleToolEnv, accountId: string, status: string, body: Record<string, unknown>): ToolResult {
  return googleResult(env.call, { ok: true, tool: env.call.function.name, status, account: accountEmail(env, accountId), ...body });
}

const TYPE_CLAUSE: Readonly<Record<string, string>> = Object.freeze({
  doc: `mimeType = '${GDRIVE_DOC_MIME}'`,
  sheet: `mimeType = '${GDRIVE_SHEET_MIME}'`,
  slides: `mimeType = '${GDRIVE_SLIDES_MIME}'`,
  form: `mimeType = '${GDRIVE_FORM_MIME}'`,
  folder: `mimeType = '${GDRIVE_FOLDER_MIME}'`,
  pdf: "mimeType = 'application/pdf'",
  image: "mimeType contains 'image/'",
});

// ── gdrive_search ────────────────────────────────────────────────────────────

export async function driveSearch(env: GoogleToolEnv): Promise<ToolResult> {
  const query = trimmed(env.args.query);
  const folderId = trimmed(env.args.folderId);
  const type = trimmed(env.args.type);
  const limit = env.args.limit === undefined ? 10 : Number(env.args.limit);
  if (query.length > 200) return failedResult(env, invalid('query is at most 200 characters.'));
  if (!query && !folderId && !type && env.args.trashed !== true) return failedResult(env, invalid('Give query (words from the name or text), folderId (to list a folder), type, or trashed: true.'));
  if (type && !TYPE_CLAUSE[type] && type !== 'file') return failedResult(env, invalid(`type must be one of: ${[...Object.keys(TYPE_CLAUSE), 'file'].join(', ')}.`));
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) return failedResult(env, invalid('limit must be a whole number from 1 to 50.'));
  if (folderId && !/^[A-Za-z0-9_-]{2,200}$/.test(folderId)) return failedResult(env, invalid('folderId must be a Drive folder id (or root for My Drive).'));
  const picked = accountsFor(env, 'read');
  if ('failure' in picked) return failedResult(env, picked.failure);
  const clauses: string[] = [];
  if (query) clauses.push(`fullText contains '${escapeDriveQueryLiteral(query)}'`);
  if (folderId) clauses.push(`'${escapeDriveQueryLiteral(folderId)}' in parents`);
  if (type && TYPE_CLAUSE[type]) clauses.push(TYPE_CLAUSE[type]);
  if (type === 'file') clauses.push(`mimeType != '${GDRIVE_FOLDER_MIME}'`);
  if (query && !folderId && !type) clauses.push(`mimeType != '${GDRIVE_FOLDER_MIME}'`);
  clauses.push(env.args.trashed === true ? 'trashed=true' : 'trashed=false');
  const q = clauses.join(' and ');
  const files: unknown[] = [];
  try {
    for (const accountId of picked.ids) {
      const drive = env.driveFor(accountId);
      if (!drive) continue;
      // Drive refuses an order with fullText; a folder lists folders first by name, anything else newest first.
      const listed = await drive.listFiles({ q, pageSize: limit, ...(query ? {} : { orderBy: folderId ? 'folder,name' : 'modifiedTime desc' }) });
      for (const file of listed.files.slice(0, limit - files.length)) files.push(compactFile(accountId, file));
      if (files.length >= limit) break;
    }
  } catch (error) {
    return failedResult(env, googleErrorFailure(error, false, 'Drive search'));
  }
  return googleResult(env.call, untrustedEnvelope(env.now(), 'gdrive', { query: query || undefined, folderId: folderId || undefined }, {
    ok: true,
    files,
    ...(files.length ? {} : { note: 'Nothing matched. Try fewer or other words, or list a folder with folderId (root = My Drive).' }),
  }));
}

// ── gdrive_read (files that are not Docs, Sheets, Slides or Forms) ────────────

export async function readPlainFile(env: GoogleToolEnv, accountId: string, file: DriveFile): Promise<ToolResult> {
  if (file.mimeType === GDRIVE_FOLDER_MIME) {
    return failedResult(env, invalid('This is a folder: list it with gdrive_search folderId.', undefined, `Call gdrive_search with folderId "${file.id}".`));
  }
  let read;
  try {
    read = await env.readCaptureText(accountId, file.id);
  } catch (error) {
    return failedResult(env, googleErrorFailure(error, false, 'Drive read'));
  }
  const text = read.withheld ? '[withheld]' : redactSecrets(read.content);
  const lines = numberedLines(text.split('\n'), { startLine: env.args.startLine, endLine: env.args.endLine });
  if (!lines.ok) return failedResult(env, lines.failure);
  return googleResult(env.call, untrustedEnvelope(env.now(), 'gdrive', { accountId, fileId: file.id, webViewLink: file.webViewLink }, {
    ok: true,
    ...compactFile(accountId, file),
    tier: read.tier,
    ...(read.withheld ? { withheld: true, note: 'The file looks like a credential; its text never leaves Drive.' } : {}),
    startLine: lines.startLine,
    endLine: lines.endLine,
    totalLines: lines.totalLines,
    nextStartLine: lines.nextStartLine,
    readNote: lines.readNote,
    lines: lines.lines,
    ...(read.tier === 'reference' || read.tier === 'metadata_only' ? { hint: 'For the whole file (images, JSON, data, archives), use gdrive_files action download and open the local copy.' } : {}),
  }));
}

// ── gdrive_files action create ───────────────────────────────────────────────

/** RFC 4180 CSV from rows. */
export function rowsToCsv(rows: unknown[][]): string {
  return rows.map(row => row.map((cell) => {
    const value = cell === null || cell === undefined ? '' : typeof cell === 'string' ? cell : String(cell);
    return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
  }).join(',')).join('\r\n');
}

function isRowList(value: unknown): value is unknown[][] {
  return Array.isArray(value) && value.length > 0 && value.every(row => Array.isArray(row));
}

/** A create Google answered unclearly: find it by its key before saying anything. */
async function findByCreateKey(drive: FullDriveClient, key: string): Promise<DriveFile | null> {
  try {
    const listed = await drive.listFiles({ q: `appProperties has { key='botboyCreate' and value='${escapeDriveQueryLiteral(key)}' } and trashed=false`, pageSize: 5 });
    return listed.files[0] ?? null;
  } catch {
    return null;
  }
}

export interface CreateHooks {
  /** Slides from a Markdown outline ("# Title" starts a slide), after the blank deck exists. */
  fillSlides?(env: GoogleToolEnv, accountId: string, presentationId: string, outline: string): Promise<{ slides: number }>;
  /** A new form (Forms API), with its description and questions. */
  createForm?(env: GoogleToolEnv, accountId: string, input: { name: string; description: string; questions: unknown }): Promise<{ formId: string; questions: number; responderUri?: string }>;
}

export async function driveCreate(env: GoogleToolEnv, hooks: CreateHooks = {}): Promise<ToolResult> {
  const kind = trimmed(env.args.kind);
  const name = trimmed(env.args.name);
  const folderId = trimmed(env.args.folderId);
  const content = typeof env.args.content === 'string' ? env.args.content : '';
  const issues: Array<{ path: string; message: string }> = [];
  if (!['doc', 'sheet', 'slides', 'form', 'folder'].includes(kind)) issues.push({ path: 'kind', message: 'one of doc, sheet, slides, form, folder' });
  if (!name || name.length > 250) issues.push({ path: 'name', message: 'the file name, 1 to 250 characters' });
  if (folderId && !/^[A-Za-z0-9_-]{2,200}$/.test(folderId)) issues.push({ path: 'folderId', message: 'a Drive folder id (root = My Drive)' });
  if (env.args.rows !== undefined && kind !== 'sheet') issues.push({ path: 'rows', message: 'only for kind sheet' });
  if (env.args.rows !== undefined && !isRowList(env.args.rows)) issues.push({ path: 'rows', message: 'a list of rows, each a list of cell values' });
  if (env.args.questions !== undefined && kind !== 'form') issues.push({ path: 'questions', message: 'only for kind form' });
  if (kind === 'folder' && content) issues.push({ path: 'content', message: 'a folder has no content' });
  if (content.length > 1_000_000) issues.push({ path: 'content', message: 'at most 1,000,000 characters; upload a file for more' });
  if (issues.length) return failedResult(env, invalid('Some arguments need fixing.', issues));
  const picked = singleAccountFor(env, 'edit');
  if ('failure' in picked) return failedResult(env, picked.failure);
  const accountId = picked.id;
  const drive = env.driveFor(accountId);
  if (!drive) return failedResult(env, { code: 'drive_not_connected', message: 'Google Drive is not connected.', effect: 'none', nextAction: 'Tell the owner to choose Connect Google Drive on Connections → Gmail.' });
  const key = createKey(env.context?.ownerRequestId ?? env.context?.jobMandate?.jobId ?? '', 'gdrive_create', env.args);
  const earlier = env.created.get(key);
  if (earlier) return googleResult(env.call, { ...(earlier as object), repeated: true, note: 'Already created in this request; this is the same file, not a second one.' });
  const parents = folderId ? [folderId] : undefined;
  const appProperties = { botboyCreate: key };
  // The same create in the same request (or job) after a restart: Drive still holds the file under its key.
  const prior = await findByCreateKey(drive, key);
  const done = (file: DriveFile, extra: Record<string, unknown> = {}, confirmedLate = false): ToolResult => {
    const body = {
      ok: true,
      tool: 'gdrive_files',
      status: 'created',
      account: accountEmail(env, accountId),
      ...compactFile(accountId, file),
      ...extra,
      ...(confirmedLate ? { note: 'Google answered unclearly, then BotBoy found the new file by its key: it exists once.' } : {}),
      next: kind === 'doc' ? 'Read it with gdrive_read; change parts with gdrive_edit.'
        : kind === 'sheet' ? 'Read it with gdrive_read; change cells with gdrive_edit.'
          : kind === 'slides' ? 'Read it with gdrive_read; change slides with gdrive_edit.'
            : kind === 'form' ? 'Read it with gdrive_read; add or change questions with gdrive_edit. It takes no answers until published (gdrive_edit publish, only on the owner’s request in chat).'
              : 'Put files in it with gdrive_files (upload, create or move, with this folderId).',
    };
    env.created.set(key, body);
    return googleResult(env.call, body);
  };
  if (prior) return done(prior, { repeated: true, note: 'Already created in this request (Drive holds it under the same key); this is the same file, not a second one.' });
  try {
    if (kind === 'folder') {
      return done(await drive.createFolder({ name, ...(parents ? { parents } : {}), appProperties }));
    }
    if (kind === 'doc') {
      // Pictures and diagrams in the Markdown: Drive's Word import carries them, its Markdown import cannot.
      const word = content.trim() && env.wordFromMarkdown ? await env.wordFromMarkdown(content) : null;
      const file = word
        ? await drive.createFile({ name, parents: parents ?? [], mimeType: GDRIVE_DOC_MIME, appProperties, media: word.data, mediaMimeType: DOCX_MIME })
        : content.trim()
          ? await drive.createFile({ name, parents: parents ?? [], mimeType: GDRIVE_DOC_MIME, appProperties, media: Buffer.from(content, 'utf8'), mediaMimeType: 'text/markdown' })
          : await drive.createMetadataFile({ name, mimeType: GDRIVE_DOC_MIME, ...(parents ? { parents } : {}), appProperties });
      return done(file, word
        ? { from: 'markdown', via: 'word', pictures: word.media.pictures, diagrams: word.media.diagrams, ...(word.media.problems.length ? { mediaProblems: word.media.problems.slice(0, 10) } : {}) }
        : content.trim() ? { from: 'markdown' } : { blank: true });
    }
    if (kind === 'sheet') {
      const csv = isRowList(env.args.rows) ? rowsToCsv(env.args.rows) : content;
      const file = csv.trim()
        ? await drive.createFile({ name, parents: parents ?? [], mimeType: GDRIVE_SHEET_MIME, appProperties, media: Buffer.from(csv, 'utf8'), mediaMimeType: 'text/csv' })
        : await drive.createMetadataFile({ name, mimeType: GDRIVE_SHEET_MIME, ...(parents ? { parents } : {}), appProperties });
      return done(file, csv.trim() ? { from: isRowList(env.args.rows) ? 'rows' : 'csv' } : { blank: true });
    }
    if (kind === 'slides') {
      const file = await drive.createMetadataFile({ name, mimeType: GDRIVE_SLIDES_MIME, ...(parents ? { parents } : {}), appProperties });
      if (content.trim() && hooks.fillSlides) {
        try {
          const filled = await hooks.fillSlides(env, accountId, file.id, content);
          return done(file, { slidesAdded: filled.slides });
        } catch (error) {
          const failure = googleErrorFailure(error, true, 'Adding the slides');
          return done(file, { slidesAdded: 0, warning: `The deck was created, but its slides were not added: ${failure.message}`, nextAction: failure.code === 'api_not_enabled' ? failure.nextAction : 'Add the slides with gdrive_edit (action add_slide).' });
        }
      }
      return done(file, { blank: true });
    }
    // form
    if (!hooks.createForm) return failedResult(env, { code: 'unavailable', message: 'Forms are unavailable in this BotBoy build.', effect: 'none', nextAction: 'Tell the owner.' });
    const created = await hooks.createForm(env, accountId, { name, description: content, questions: env.args.questions });
    let file = await drive.getFile(created.formId);
    try {
      file = await drive.updateFile(created.formId, { appProperties }, parents ? { add: parents, remove: file.parents ?? [] } : {});
    } catch {
      // The form exists either way; only its folder or key did not land.
    }
    return done(file, { questions: created.questions, published: false, ...(created.responderUri ? { responderUri: created.responderUri } : {}) });
  } catch (error) {
    // A question that does not fit is caught before the form exists.
    if ((error as { botboyInvalid?: boolean })?.botboyInvalid) return failedResult(env, invalid(String((error as Error).message)));
    const failure = googleErrorFailure(error, true, 'Creating the file');
    if (failure.effect === 'unknown') {
      const found = await findByCreateKey(drive, key);
      if (found) return done(found, {}, true);
      return failedResult(env, { ...failure, nextAction: `Do not create it again yet: search Drive for "${name}" (gdrive_search) to see whether it was made; create it again only if it is not there.` });
    }
    return failedResult(env, failure);
  }
}

// ── gdrive_files action upload ───────────────────────────────────────────────

const CONVERTIBLE: Readonly<Record<string, readonly string[]>> = Object.freeze({
  doc: ['docx', 'doc', 'odt', 'rtf', 'txt', 'md', 'markdown', 'html', 'htm', 'pdf', 'jpg', 'jpeg', 'png', 'gif', 'bmp'],
  sheet: ['xlsx', 'xls', 'xlsm', 'ods', 'csv', 'tsv', 'txt'],
  slides: ['pptx', 'ppt', 'odp'],
});

function extensionOfName(name: string): string {
  return path.extname(name).slice(1).toLowerCase();
}

/** Bytes to Google in resumable chunks; an unclear chunk answer asks Google how far it got. */
async function sendResumable(drive: FullDriveClient, source: UploadSource, start: { metadata: Record<string, unknown>; fileId?: string }): Promise<DriveFile> {
  const session = await drive.startUpload({ metadata: start.metadata, mediaMimeType: source.mimeType, size: source.size, ...(start.fileId ? { fileId: start.fileId } : {}) })
    .catch((error) => {
      // Nothing exists until Google has every byte.
      throw error instanceof GoogleApiError ? new GoogleApiError(error.message, error.status, error.code, error.transportCode, 'none', error.transportCodes) : error;
    });
  let offset = 0;
  let tries = 0;
  if (source.size === 0) {
    const answer = await drive.uploadChunk(session, Buffer.alloc(0), 0, 0);
    if ('done' in answer) return answer.done;
  }
  while (offset < source.size) {
    const chunk = source.read(offset, GDRIVE_UPLOAD_CHUNK_BYTES);
    try {
      const answer = await drive.uploadChunk(session, chunk, offset, source.size);
      if ('done' in answer) return answer.done;
      offset = answer.next;
      tries = 0;
    } catch (error) {
      if (++tries > 3) throw error;
      // Where did Google get to? A done answer means the file exists.
      const status = await drive.uploadStatus(session, source.size).catch(() => null);
      if (!status) throw error instanceof GoogleApiError ? new GoogleApiError(error.message, error.status, error.code, error.transportCode, 'unknown', error.transportCodes) : error;
      if ('done' in status) return status.done;
      offset = status.next;
    }
  }
  const final = await drive.uploadStatus(session, source.size);
  if ('done' in final) return final.done;
  throw new GoogleApiError('Drive upload ended without a file', 0, 'unreadable_response', undefined, 'unknown');
}

export async function driveUpload(env: GoogleToolEnv): Promise<ToolResult> {
  const convertTo = trimmed(env.args.convertTo);
  const folderId = trimmed(env.args.folderId);
  const replace = env.args.replaceFileId !== undefined && env.args.replaceFileId !== null && env.args.replaceFileId !== '';
  if (convertTo && !CONVERTIBLE[convertTo]) return failedResult(env, invalid('convertTo must be doc, sheet or slides.'));
  if (replace && (folderId || convertTo)) return failedResult(env, invalid('replaceFileId replaces one file’s content in place; leave out folderId and convertTo.'));
  if (folderId && !/^[A-Za-z0-9_-]{2,200}$/.test(folderId)) return failedResult(env, invalid('folderId must be a Drive folder id (root = My Drive).'));
  const resolved = resolveUploadSource({ path: env.args.path, assetId: env.args.assetId, name: env.args.name }, env.local);
  if (!resolved.ok) return failedResult(env, resolved.failure);
  const source = resolved.source;
  try {
    if (replace) {
      const located = await locateFile(env, env.args.replaceFileId, 'edit', 'replaceFileId');
      if ('failure' in located) return failedResult(env, located.failure);
      const { accountId, drive, file } = located;
      const targetKind = kindOf(file.mimeType);
      if (['doc', 'sheet', 'slides'].includes(targetKind) && !CONVERTIBLE[targetKind].includes(extensionOfName(source.name))) {
        return failedResult(env, invalid(`A Google ${targetKind === 'doc' ? 'Doc' : targetKind === 'sheet' ? 'Sheet' : 'Slides deck'} takes new content only from ${CONVERTIBLE[targetKind].join(', ')} files.`));
      }
      if (['folder', 'form', 'drawing', 'google_other', 'shortcut'].includes(targetKind)) return failedResult(env, invalid('Only files, Docs, Sheets and Slides take new content from an upload.'));
      const updated = await sendResumable(drive, source, { metadata: {}, fileId: file.id });
      return receipt(env, accountId, 'replaced', {
        ...compactFile(accountId, updated),
        from: source.from,
        bytes: source.size,
        note: ['doc', 'sheet', 'slides'].includes(targetKind) ? 'Google converted the upload and replaced the whole content; the file keeps its link, sharing and version history.' : 'A new version of the file; Drive keeps the earlier one in its version history.',
      });
    }
    const picked = singleAccountFor(env, 'edit');
    if ('failure' in picked) return failedResult(env, picked.failure);
    const accountId = picked.id;
    const drive = env.driveFor(accountId);
    if (!drive) return failedResult(env, { code: 'drive_not_connected', message: 'Google Drive is not connected.', effect: 'none', nextAction: 'Tell the owner to choose Connect Google Drive on Connections → Gmail.' });
    if (convertTo && !CONVERTIBLE[convertTo].includes(extensionOfName(source.name))) {
      return failedResult(env, invalid(`convertTo ${convertTo} takes ${CONVERTIBLE[convertTo].join(', ')} files; this is .${extensionOfName(source.name) || 'unknown'}.`));
    }
    const key = createKey(env.context?.ownerRequestId ?? env.context?.jobMandate?.jobId ?? '', 'gdrive_upload', { ...env.args, sha256: source.sha256 });
    const earlier = env.created.get(key);
    if (earlier) return googleResult(env.call, { ...(earlier as object), repeated: true, note: 'Already uploaded in this request; this is the same file, not a second one.' });
    // The same upload of the same bytes in this request (or job) after a restart: Drive holds it under its key.
    const prior = await findByCreateKey(drive, key);
    if (prior) {
      const body = { ok: true, tool: 'gdrive_files', status: 'uploaded', account: accountEmail(env, accountId), ...compactFile(accountId, prior), from: source.from, bytes: source.size, sha256: source.sha256, repeated: true, note: 'Already uploaded in this request (Drive holds it under the same key); this is the same file, not a second one.' };
      env.created.set(key, body);
      return googleResult(env.call, body);
    }
    const name = convertTo ? source.name.replace(/\.[A-Za-z0-9]{1,8}$/, '') : source.name;
    const metadata: Record<string, unknown> = {
      name,
      ...(folderId ? { parents: [folderId] } : {}),
      appProperties: { botboyCreate: key },
      ...(convertTo ? { mimeType: { doc: GDRIVE_DOC_MIME, sheet: GDRIVE_SHEET_MIME, slides: GDRIVE_SLIDES_MIME }[convertTo] } : {}),
    };
    let file: DriveFile;
    try {
      file = await sendResumable(drive, source, { metadata });
    } catch (error) {
      if (classifyWriteFailure(error) === 'unknown') {
        const found = await findByCreateKey(drive, key);
        if (found) file = found;
        else throw error;
      } else throw error;
    }
    const verified = convertTo ? 'converted' : file.sha256Checksum ? (file.sha256Checksum === source.sha256 ? 'sha256' : 'mismatch') : (Number(file.size ?? -1) === source.size ? 'size' : 'unverified');
    const body = {
      ok: true,
      tool: 'gdrive_files',
      status: 'uploaded',
      account: accountEmail(env, accountId),
      ...compactFile(accountId, file),
      from: source.from,
      bytes: source.size,
      sha256: source.sha256,
      verified,
      ...(verified === 'mismatch' ? { warning: 'Google’s checksum differs from the local file: tell the owner and upload it again.' } : {}),
    };
    env.created.set(key, body);
    return googleResult(env.call, body);
  } catch (error) {
    const failure = googleErrorFailure(error, true, 'The upload');
    return failedResult(env, failure.effect === 'unknown'
      ? { ...failure, nextAction: `Do not upload it again yet: search Drive for "${source.name}" (gdrive_search) to see whether it arrived; upload again only if it is not there.` }
      : failure);
  } finally {
    source.close();
  }
}

// ── gdrive_files action download ─────────────────────────────────────────────

const EXPORTS: Readonly<Record<string, Readonly<Record<string, { mime: string; ext: string }>>>> = Object.freeze({
  doc: { docx: { mime: DOCX_MIME, ext: 'docx' }, pdf: { mime: 'application/pdf', ext: 'pdf' }, md: { mime: 'text/markdown', ext: 'md' }, txt: { mime: 'text/plain', ext: 'txt' }, odt: { mime: 'application/vnd.oasis.opendocument.text', ext: 'odt' }, rtf: { mime: 'application/rtf', ext: 'rtf' }, epub: { mime: 'application/epub+zip', ext: 'epub' }, html: { mime: 'application/zip', ext: 'zip' } },
  sheet: { xlsx: { mime: XLSX_MIME, ext: 'xlsx' }, csv: { mime: 'text/csv', ext: 'csv' }, tsv: { mime: 'text/tab-separated-values', ext: 'tsv' }, pdf: { mime: 'application/pdf', ext: 'pdf' }, ods: { mime: 'application/vnd.oasis.opendocument.spreadsheet', ext: 'ods' } },
  slides: { pptx: { mime: PPTX_MIME, ext: 'pptx' }, pdf: { mime: 'application/pdf', ext: 'pdf' }, txt: { mime: 'text/plain', ext: 'txt' }, odp: { mime: 'application/vnd.oasis.opendocument.presentation', ext: 'odp' } },
  drawing: { png: { mime: 'image/png', ext: 'png' }, jpg: { mime: 'image/jpeg', ext: 'jpg' }, svg: { mime: 'image/svg+xml', ext: 'svg' }, pdf: { mime: 'application/pdf', ext: 'pdf' } },
});
const DEFAULT_EXPORT: Readonly<Record<string, string>> = Object.freeze({ doc: 'docx', sheet: 'xlsx', slides: 'pptx', drawing: 'png' });
const DATA_ROOM_EXT = /\.(?:csv|tsv|tab|xlsx)$/i;

function sha256OfPath(file: string): string {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

export async function driveDownload(env: GoogleToolEnv): Promise<ToolResult> {
  const format = trimmed(env.args.format).toLowerCase().replace(/^\./, '');
  const located = await locateFile(env, env.args.fileId, 'read');
  if ('failure' in located) return failedResult(env, located.failure);
  const { accountId, drive, file } = located;
  const kind = kindOf(file.mimeType);
  if (kind === 'folder') return failedResult(env, invalid('This is a folder: list it with gdrive_search folderId and download its files one by one.'));
  if (kind === 'form') return failedResult(env, invalid('Google does not export Forms as files. Read it with gdrive_read (responses: true for the answers).'));
  if (kind === 'shortcut' || kind === 'google_other') return failedResult(env, invalid('This Google file type cannot be downloaded; open it in Drive.'));
  const exportsFor = EXPORTS[kind];
  let exportMime: string | undefined;
  let fileName = trimmed(env.args.name) || file.name || 'download';
  if (exportsFor) {
    const chosen = format || DEFAULT_EXPORT[kind];
    const target = exportsFor[chosen];
    if (!target) return failedResult(env, invalid(`format for a Google ${kind} is one of: ${Object.keys(exportsFor).join(', ')}.`));
    exportMime = target.mime;
    if (!fileName.toLowerCase().endsWith(`.${target.ext}`)) fileName = `${fileName}.${target.ext}`;
  } else {
    if (format && format !== extensionOfName(file.name)) return failedResult(env, invalid('format applies to Google Docs, Sheets, Slides and Drawings; other files download as they are.'));
    if (Number(file.size ?? 0) > GDRIVE_MAX_TRANSFER_BYTES) return failedResult(env, invalid(`The file is ${formatByteSize(Number(file.size))}; BotBoy downloads at most 2 GB at a time.`));
  }
  const target = resolveDownloadTarget({ saveTo: env.args.saveTo, fileName }, env.local);
  if (!target.ok) return failedResult(env, target.failure);
  let bytes: number;
  try {
    bytes = await drive.downloadTo(file.id, target.path, { ...(exportMime ? { exportMimeType: exportMime } : {}), maxBytes: GDRIVE_MAX_TRANSFER_BYTES });
  } catch (error) {
    try { fs.rmSync(target.path, { force: true }); } catch { /* best effort */ }
    if (error instanceof GoogleApiError && /exportSizeLimitExceeded/i.test(`${error.code} ${error.message}`)) {
      return failedResult(env, { code: 'export_too_large', message: `Google exports at most ${formatByteSize(GDRIVE_EXPORT_LIMIT_BYTES)} at a time, and this file is larger in that format.`, effect: 'none', nextAction: 'Try another format (pdf is often smaller), or ask the owner to download it from Drive.' });
    }
    return failedResult(env, googleErrorFailure(error, false, 'The download'));
  }
  const held = downloadedSecretHold(target.path);
  if (held) {
    try { fs.rmSync(target.path, { force: true }); } catch { /* best effort */ }
    return failedResult(env, { code: 'download_not_allowed', message: `${held}. BotBoy removed the copy again.`, effect: 'none', nextAction: 'Tell the owner; they can open the file in Drive themselves.' });
  }
  const relative = target.inWorkspace ? path.relative(env.local.filesDir, target.path) : null;
  return receipt(env, accountId, 'downloaded', {
    fileId: file.id,
    name: redactSecrets(file.name ?? ''),
    kind,
    path: target.path,
    ...(relative ? { filesPath: relative } : {}),
    bytes,
    size: formatByteSize(bytes),
    sha256: sha256OfPath(target.path),
    ...(exportMime ? { exportedAs: format || DEFAULT_EXPORT[kind] } : {}),
    ...(relative && DATA_ROOM_EXT.test(target.path) ? { dataRoomSource: { kind: 'local_file', path: relative } } : {}),
    next: relative
      ? 'Read it with read_file (text) or run_command (any type, e.g. jq for JSON); attach it with gmail_draft attachments {path}.'
      : `It is at ${target.path}.`,
  });
}

// ── gdrive_files actions rename, move, copy, trash, restore ──────────────────

const MANAGE_ACTIONS = ['rename', 'move', 'copy', 'trash', 'restore'] as const;

export async function driveManage(env: GoogleToolEnv): Promise<ToolResult> {
  const action = trimmed(env.args.action) as typeof MANAGE_ACTIONS[number];
  if (!MANAGE_ACTIONS.includes(action)) return failedResult(env, invalid(`action must be one of: ${MANAGE_ACTIONS.join(', ')}.`));
  const name = trimmed(env.args.name);
  const folderId = trimmed(env.args.folderId);
  const convertTo = trimmed(env.args.convertTo);
  const many = Array.isArray(env.args.fileIds) ? env.args.fileIds : null;
  if (many && !['move', 'trash', 'restore'].includes(action)) return failedResult(env, invalid('fileIds (several files) works for move, trash and restore; rename and copy take one fileId.'));
  if (many && (many.length < 1 || many.length > 20)) return failedResult(env, invalid('fileIds holds 1 to 20 ids.'));
  if (many && env.args.fileId !== undefined) return failedResult(env, invalid('Give fileId or fileIds, not both.'));
  if (action === 'rename' && (!name || name.length > 250)) return failedResult(env, invalid('rename needs name (1 to 250 characters).'));
  if (action === 'move' && !folderId) return failedResult(env, invalid('move needs folderId (root = My Drive).'));
  if (folderId && !/^[A-Za-z0-9_-]{2,200}$/.test(folderId)) return failedResult(env, invalid('folderId must be a Drive folder id (root = My Drive).'));
  if (convertTo && (action !== 'copy' || !['doc', 'sheet', 'slides'].includes(convertTo))) return failedResult(env, invalid('convertTo (doc, sheet or slides) works only with action copy: it turns a Word, Excel or PowerPoint file into a Google copy.'));
  const ids = many ?? [env.args.fileId];
  const results: unknown[] = [];
  let accountForReceipt = '';
  for (const raw of ids) {
    const located = await locateFile(env, raw, 'edit');
    if ('failure' in located) {
      if (ids.length === 1) return failedResult(env, located.failure);
      results.push({ fileId: String(raw).slice(0, 200), ok: false, code: located.failure.code, message: located.failure.message });
      continue;
    }
    const { accountId, drive, file } = located;
    accountForReceipt = accountId;
    try {
      if (action === 'rename') {
        const updated = await drive.updateFile(file.id, { name });
        results.push({ ...compactFile(accountId, updated), was: redactSecrets(file.name) });
      } else if (action === 'move') {
        // The folder's own id ("root" resolves to My Drive's real id), so a file already there is never unparented.
        const folder = await drive.getFile(folderId).catch(() => null);
        if (!folder || folder.mimeType !== GDRIVE_FOLDER_MIME) {
          return failedResult(env, invalid('folderId is not a folder in this account; find it with gdrive_search type folder (root = My Drive).'));
        }
        const parents = file.parents ?? [];
        const updated = await drive.updateFile(file.id, {}, { add: parents.includes(folder.id) ? [] : [folder.id], remove: parents.filter(parent => parent !== folder.id) });
        results.push({ ...compactFile(accountId, updated), from: parents });
      } else if (action === 'copy') {
        const key = createKey(env.context?.ownerRequestId ?? env.context?.jobMandate?.jobId ?? '', 'gdrive_manage_copy', { ...env.args, fileId: file.id });
        const earlier = env.created.get(key);
        if (earlier) return googleResult(env.call, { ...(earlier as object), repeated: true, note: 'Already copied in this request; this is the same copy, not a second one.' });
        const targetMime = convertTo ? ({ doc: GDRIVE_DOC_MIME, sheet: GDRIVE_SHEET_MIME, slides: GDRIVE_SLIDES_MIME } as Record<string, string>)[convertTo] : undefined;
        // The same copy in this request (or job) after a restart: Drive holds it under its key.
        let copy: DriveFile | null = await findByCreateKey(drive, key);
        const repeated = copy !== null;
        if (!copy) {
          try {
            copy = await drive.copyFile(file.id, {
              ...(name ? { name } : {}),
              ...(folderId ? { parents: [folderId] } : {}),
              appProperties: { botboyCreate: key },
              ...(targetMime ? { mimeType: targetMime } : {}),
            });
          } catch (error) {
            if (classifyWriteFailure(error) !== 'unknown') throw error;
            copy = await findByCreateKey(drive, key);
            if (!copy) throw error;
          }
        }
        // The receipt says converted only when Drive made a Google file.
        if (targetMime && copy.mimeType !== targetMime) {
          return failedResult(env, { code: 'not_converted', message: `Drive made the copy (${copy.id}) but kept it as ${copy.mimeType} instead of a Google ${convertTo}.`, effect: 'none', nextAction: 'Tell the owner; they can open the file in Drive and choose File → Save as Google Docs/Sheets/Slides.' });
        }
        const body = { ok: true, tool: 'gdrive_files', status: 'copied', account: accountEmail(env, accountId), ...compactFile(accountId, copy), copiedFrom: file.id, ...(targetMime ? { convertedTo: convertTo } : {}), ...(repeated ? { repeated: true, note: 'Already copied in this request (Drive holds it under the same key); this is the same copy, not a second one.' } : {}) };
        env.created.set(key, body);
        return googleResult(env.call, body);
      } else if (action === 'trash') {
        const updated = await drive.updateFile(file.id, { trashed: true });
        results.push({ ...compactFile(accountId, updated), trashed: true });
      } else {
        const updated = await drive.updateFile(file.id, { trashed: false });
        results.push({ ...compactFile(accountId, updated), trashed: false });
      }
    } catch (error) {
      const failure = googleErrorFailure(error, true, `The ${action}`);
      if (ids.length === 1) return failedResult(env, failure);
      results.push({ fileId: file.id, ok: false, code: failure.code, message: failure.message, effect: failure.effect });
    }
  }
  const done = results.filter(entry => (entry as { ok?: boolean }).ok !== false).length;
  return googleResult(env.call, {
    ok: done > 0,
    tool: 'gdrive_files',
    status: action === 'rename' ? 'renamed' : action === 'move' ? 'moved' : action === 'trash' ? 'trashed' : 'restored',
    ...(accountForReceipt ? { account: accountEmail(env, accountForReceipt) } : {}),
    files: results,
    ...(done < results.length ? { note: `${results.length - done} of ${results.length} did not change; see each entry.` } : {}),
    ...(action === 'trash' ? { restore: 'Trash keeps files 30 days: gdrive_files action restore brings them back (gdrive_search trashed: true lists them).' } : {}),
  }, done === 0);
}

// ── gdrive_share ─────────────────────────────────────────────────────────────

const ROLES = ['reader', 'commenter', 'writer'] as const;
const EMAIL = /^[^\s@<>()",;:]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,}$/;
const DOMAIN = /^(?=.{3,253}$)[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/;

function compactPermission(permission: DrivePermission): Record<string, unknown> {
  return {
    permissionId: permission.id,
    type: permission.type,
    role: permission.role,
    ...(permission.emailAddress ? { email: permission.emailAddress } : {}),
    ...(permission.domain ? { domain: permission.domain } : {}),
    ...(permission.displayName ? { name: permission.displayName } : {}),
    ...(permission.view === 'published' ? { responder: true } : {}),
    ...(permission.pendingOwner ? { pendingOwner: true } : {}),
  };
}

export function shareAction(args: Record<string, unknown>): string {
  return trimmed(args.action) || 'list';
}

export async function driveShare(env: GoogleToolEnv): Promise<ToolResult> {
  const action = shareAction(env.args);
  if (!['list', 'add', 'update', 'remove'].includes(action)) return failedResult(env, invalid('action must be list, add, update or remove.'));
  const located = await locateFile(env, env.args.fileId, action === 'list' ? 'read' : 'edit');
  if ('failure' in located) return failedResult(env, located.failure);
  const { accountId, drive, file } = located;
  const responder = env.args.responder === true;
  if (responder && file.mimeType !== GDRIVE_FORM_MIME) return failedResult(env, invalid('responder applies to Google Forms only (who may answer it).'));
  const listNow = async () => (await drive.listPermissions(file.id, { publishedView: file.mimeType === GDRIVE_FORM_MIME })).filter(permission => !permission.deleted).map(compactPermission);
  try {
    if (action === 'list') {
      const permissions = await listNow();
      return googleResult(env.call, untrustedEnvelope(env.now(), 'gdrive', { accountId, fileId: file.id }, {
        ok: true,
        ...compactFile(accountId, file),
        permissions,
        linkShared: permissions.some(permission => permission.type === 'anyone'),
      }));
    }
    const role = trimmed(env.args.role);
    const email = trimmed(env.args.email).toLowerCase();
    const domain = trimmed(env.args.domain).toLowerCase();
    const anyone = env.args.anyone === true;
    if (action === 'add') {
      const targets = [email ? 'email' : '', domain ? 'domain' : '', anyone ? 'anyone' : ''].filter(Boolean);
      if (targets.length !== 1) return failedResult(env, invalid('add needs exactly one of email (a person or group), domain, or anyone: true.'));
      if (!ROLES.includes(role as typeof ROLES[number]) && !(responder && (!role || role === 'reader'))) return failedResult(env, invalid('role must be reader, commenter or writer (ownership is never transferred).'));
      if (email && !EMAIL.test(email)) return failedResult(env, invalid('email must be one address, like ana@example.com.'));
      if (domain && !DOMAIN.test(domain)) return failedResult(env, invalid('domain must be a domain, like example.com.'));
      if (anyone || domain) {
        const ownerWords = String(env.context?.currentUserMessage ?? '');
        const allowed = anyone ? PUBLIC_WORDS.test(ownerWords) : ownerWords.toLowerCase().includes(domain);
        if (!allowed) {
          return failedResult(env, {
            code: 'owner_words_required',
            message: anyone
              ? 'Sharing with anyone who has the link makes the file reachable by people outside the owner’s list, so it needs the owner’s own words in this message (for example “share it with anyone with the link”). Nothing changed.'
              : `Sharing with everyone at ${domain} needs the owner to name that domain in this message. Nothing changed.`,
            effect: 'none',
            nextAction: anyone ? 'Ask the owner whether anyone with the link may open it; share only after they say so.' : `Ask the owner whether everyone at ${domain} may open it.`,
          });
        }
      }
      const permission = await drive.createPermission(file.id, {
        type: anyone ? 'anyone' : domain ? 'domain' : 'user',
        role: responder ? 'reader' : role,
        ...(email ? { emailAddress: email } : {}),
        ...(domain ? { domain } : {}),
        ...(responder ? { view: 'published' } : {}),
        ...(anyone || domain ? { allowFileDiscovery: false } : {}),
      }, email ? { sendNotificationEmail: env.args.notify !== false, ...(trimmed(env.args.message) ? { emailMessage: trimmed(env.args.message).slice(0, 1000) } : {}) } : {});
      return receipt(env, accountId, 'shared', {
        ...compactFile(accountId, file),
        added: compactPermission(permission),
        reach: anyone ? 'Anyone with the link can open it (not listed in search).' : domain ? `Everyone at ${domain} with the link can open it.` : `${email} can open it${env.args.notify !== false ? ' and was emailed' : ''}.`,
        permissions: await listNow(),
      });
    }
    // update / remove: by permissionId, or the email the owner named.
    const permissions = await drive.listPermissions(file.id, { publishedView: file.mimeType === GDRIVE_FORM_MIME });
    const permissionId = trimmed(env.args.permissionId);
    const wanted = permissionId
      ? permissions.find(permission => permission.id === permissionId)
      : email ? permissions.find(permission => permission.emailAddress?.toLowerCase() === email && (responder ? permission.view === 'published' : permission.view !== 'published'))
        : anyone ? permissions.find(permission => permission.type === 'anyone' && (responder ? permission.view === 'published' : permission.view !== 'published'))
          : domain ? permissions.find(permission => permission.domain?.toLowerCase() === domain) : undefined;
    if (!wanted) return failedResult(env, invalid('No such sharing entry on this file; list them with action list and use its permissionId.'));
    if (wanted.role === 'owner') return failedResult(env, invalid('That is the file’s owner; BotBoy never changes or removes ownership.'));
    if (action === 'update') {
      if (!ROLES.includes(role as typeof ROLES[number])) return failedResult(env, invalid('update needs role: reader, commenter or writer.'));
      const changed = await drive.updatePermission(file.id, wanted.id, { role });
      return receipt(env, accountId, 'changed', { ...compactFile(accountId, file), changed: compactPermission(changed), permissions: await listNow() });
    }
    await drive.deletePermission(file.id, wanted.id);
    return receipt(env, accountId, 'removed', { ...compactFile(accountId, file), removed: compactPermission(wanted), permissions: await listNow() });
  } catch (error) {
    return failedResult(env, googleErrorFailure(error, action !== 'list', 'Sharing'));
  }
}

// ── gdrive_share comments ────────────────────────────────────────────────────

/** Comments BotBoy writes say so, the way its SharePoint comments do. */
export const BOTBOY_COMMENT_PREFIX = '🤖 ';

export async function driveComments(env: GoogleToolEnv): Promise<ToolResult> {
  const action = trimmed(env.args.action) || 'list';
  if (!['list', 'add', 'reply', 'resolve', 'reopen'].includes(action)) return failedResult(env, invalid('action must be list, add, reply, resolve or reopen.'));
  const located = await locateFile(env, env.args.fileId, action === 'list' ? 'read' : 'edit');
  if ('failure' in located) return failedResult(env, located.failure);
  const { accountId, drive, file } = located;
  const content = typeof env.args.text === 'string' ? env.args.text.trim() : '';
  const commentId = trimmed(env.args.commentId);
  try {
    if (action === 'list') {
      const listed = await drive.listComments(file.id, { pageSize: 50 });
      return googleResult(env.call, untrustedEnvelope(env.now(), 'gdrive', { accountId, fileId: file.id }, {
        ok: true,
        ...compactFile(accountId, file),
        comments: listed.comments.map(comment => ({
          commentId: comment.id,
          author: comment.author?.displayName ?? comment.author?.emailAddress,
          at: comment.createdTime,
          resolved: Boolean(comment.resolved),
          ...(comment.quotedFileContent?.value ? { on: redactSecrets(comment.quotedFileContent.value).slice(0, 300) } : {}),
          text: redactSecrets(comment.content ?? '').slice(0, 2000),
          replies: (comment.replies ?? []).filter(reply => !reply.deleted).map(reply => ({ author: reply.author?.displayName ?? reply.author?.emailAddress, at: reply.createdTime, ...(reply.action ? { action: reply.action } : {}), text: redactSecrets(reply.content ?? '').slice(0, 1000) })),
        })),
        ...(listed.nextPageToken ? { more: true } : {}),
      }));
    }
    if ((action === 'add' || action === 'reply') && (!content || content.length > 4000)) return failedResult(env, invalid('text is required (at most 4,000 characters).'));
    if (action !== 'add' && !commentId) return failedResult(env, invalid(`${action} needs commentId (from action list).`));
    if (action === 'add') {
      const quote = typeof env.args.quote === 'string' ? env.args.quote.trim().slice(0, 1000) : '';
      const comment = await drive.createComment(file.id, { content: `${BOTBOY_COMMENT_PREFIX}${content}`, ...(quote ? { quotedFileContent: { value: quote, mimeType: 'text/plain' } } : {}) });
      return receipt(env, accountId, 'commented', { ...compactFile(accountId, file), commentId: comment.id, note: 'Posted under the owner’s name with a 🤖 mark showing it came from BotBoy; Google notifies the file’s editors.' });
    }
    const reply = await drive.createReply(file.id, commentId, {
      content: content ? `${BOTBOY_COMMENT_PREFIX}${content}` : '',
      ...(action === 'resolve' ? { action: 'resolve' as const } : action === 'reopen' ? { action: 'reopen' as const } : {}),
    });
    return receipt(env, accountId, action === 'reply' ? 'replied' : action === 'resolve' ? 'resolved' : 'reopened', { ...compactFile(accountId, file), commentId, replyId: reply.id });
  } catch (error) {
    return failedResult(env, googleErrorFailure(error, action !== 'list', 'Comments'));
  }
}

export type { GoogleFailure };
export const _forTests = { safeFileName };
