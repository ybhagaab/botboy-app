/**
 * Files BotBoy attaches to a Gmail draft or send (GMAIL_CHAT_TOOLS_PLAN.md §13).
 *
 * Two sources:
 *   - `path`: a local file, absolute, `~/…`, or relative to BotBoy's files
 *     workspace (where write_file and SQL exports put what BotBoy makes).
 *   - `assetId`: an image from this chat (`va_…`: an owner upload or a
 *     screenshot), read through the visual-asset registry, which verifies
 *     the stored bytes.
 *
 * Mail leaves this Mac, so the boundary is stricter than read_file's:
 *   - BotBoy's private state is refused after every link is resolved
 *     (`resolvesIntoPrivateState`); the files workspace is allowed.
 *   - Credential files (the sensitive-files.ts path rules), hidden files and
 *     folders, and app data in ~/Library (iCloud Drive and cloud-storage
 *     folders excepted) are refused from the path alone, for the path given
 *     and for the file it resolves to.
 *   - A text file that holds a high-confidence secret format
 *     (`detectSecrets`) is refused. Binary files are not inspected.
 *   - Types Gmail blocks (.exe, .js, …) are refused: Gmail would reject the email.
 * A refusal is not an argument mistake: the caller reports it as
 * `attachment_not_allowed`, so the model tells the owner instead of sending
 * without the file. Nothing here changes or copies a file.
 */

import { createHash } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { canonicalLocalPath, resolvesIntoPrivateState } from './protected-local-resources.js';
import { describeSecretKinds, detectSecrets, sensitiveLocalPathReason, type SecretKind } from './sensitive-files.js';
import {
  MAX_ATTACHMENTS,
  MAX_ATTACHMENT_BYTES,
  attachmentNameIssue,
  blockedAttachmentType,
  extensionOf,
  formatByteSize,
  mimeTypeForName,
  type ComposeIssue,
  type MimeAttachment,
} from './gmail-mime.js';
import type { VisualAssetRegistry } from './visual-assets.js';

const ASSET_ID_PATTERN = /^va_[a-f0-9]{32}$/;
const VERSION_ID_PATTERN = /^vav_[a-f0-9]{32}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const MAX_PATH_CHARS = 4096;
/** A NUL in the first 64 KB means binary; anything else that is valid UTF-8 is scanned for secrets. */
const BINARY_PROBE_BYTES = 64 * 1024;
const ENTRY_KEYS = new Set(['path', 'assetId', 'name']);
/** Extensions that name one type, so `photo.jpeg` may be sent as `photo.jpg`. */
const SAME_TYPE: Readonly<Record<string, string>> = { jpeg: 'jpg', htm: 'html', tif: 'tiff', yml: 'yaml', markdown: 'md', text: 'txt' };
/** Inside ~/Library only these hold the owner's documents (iCloud Drive; OneDrive, Dropbox, Google Drive). */
const LIBRARY_DOCUMENT_FOLDERS = ['Mobile Documents', 'CloudStorage'];
const PRIVATE_STATE = 'This is BotBoy’s private data (its database, credentials, and caches), which BotBoy never emails; files BotBoy makes for the owner are in its files workspace';
const ATTACH_AGAIN = 'pass attachments again to attach the current files, or [] for none';

export type AttachmentSource =
  | { kind: 'file'; path: string }
  | { kind: 'image'; assetId: string; versionId: string };

export interface ResolvedAttachment extends MimeAttachment {
  sizeBytes: number;
  sha256: string;
  source: AttachmentSource;
}

/** Kept in the draft ledger, so an update attaches the same bytes again. */
export interface StoredAttachment {
  name: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  source: AttachmentSource;
}

/** What a receipt says about one attached file. */
export interface AttachmentReceipt {
  name: string;
  mimeType: string;
  sizeBytes: number;
  sha256?: string;
  /** The local file, or the chat image id. */
  from?: string;
}

export interface AttachmentPolicy {
  homeDir: string;
  privateRoot: string;
  filesDir: string;
  images?: Pick<VisualAssetRegistry, 'readOriginal'>;
}

export function defaultAttachmentPolicy(
  images?: Pick<VisualAssetRegistry, 'readOriginal'>,
  homeDir = os.homedir(),
): AttachmentPolicy {
  const privateRoot = path.join(homeDir, '.personal-productivity-tracker');
  return { homeDir, privateRoot, filesDir: path.join(privateRoot, 'files'), ...(images ? { images } : {}) };
}

export interface AttachmentProblems {
  /** Argument mistakes the model can fix (`invalid_arguments`). */
  issues: ComposeIssue[];
  /** Files BotBoy will not email (`attachment_not_allowed`). */
  refusals: ComposeIssue[];
}

interface EntryRequest {
  path?: string;
  assetId?: string;
  versionId?: string;
  name?: string;
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function inside(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!!relative && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function sameType(a: string, b: string): boolean {
  return (SAME_TYPE[a] ?? a) === (SAME_TYPE[b] ?? b);
}

/** Why a file must not be emailed, from its path and size alone (the file is not opened). */
function pathHold(target: string, policy: AttachmentPolicy, sizeBytes: number): string | null {
  // Inside the files workspace only the part below it is judged: the
  // workspace itself sits in BotBoy's hidden folder.
  let judged = target;
  for (const root of [policy.filesDir, canonicalLocalPath(policy.filesDir)]) {
    if (inside(target, root)) {
      judged = path.relative(root, target);
      break;
    }
  }
  const credential = sensitiveLocalPathReason(judged, sizeBytes);
  if (credential) return `${credential}: BotBoy never emails credentials or keys`;
  const hidden = judged.split(path.sep).find(segment => segment.startsWith('.') && segment !== '.' && segment !== '..');
  if (hidden) return `In a hidden location (${hidden}): BotBoy does not email hidden files`;
  for (const home of [policy.homeDir, canonicalLocalPath(policy.homeDir)]) {
    const library = path.join(home, 'Library');
    if (inside(target, library) && !LIBRARY_DOCUMENT_FOLDERS.some(folder => inside(target, path.join(library, folder)))) {
      return 'App data in ~/Library, which BotBoy does not email (iCloud Drive and cloud-storage folders are fine)';
    }
  }
  return null;
}

/** Secret kinds in a text file; null for binary content or none found. */
function textSecrets(bytes: Buffer): SecretKind[] | null {
  if (bytes.subarray(0, BINARY_PROBE_BYTES).includes(0)) return null;
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
  const kinds = detectSecrets(text);
  return kinds.length ? kinds : null;
}

/** The name the recipient sees: the one asked for, which keeps the file's type, or the file's own. */
function finalName(
  requested: string | undefined,
  fallback: string,
  sourceExtension: string,
  at: string,
  problems: AttachmentProblems,
): string | null {
  if (requested === undefined) {
    const issue = attachmentNameIssue(fallback);
    if (!issue) return fallback;
    problems.issues.push({ path: at, message: `${issue}; pass a name for this file` });
    return null;
  }
  const name = requested.trim();
  const issue = attachmentNameIssue(name);
  if (issue) {
    problems.issues.push({ path: `${at}.name`, message: issue });
    return null;
  }
  if (sourceExtension && !sameType(extensionOf(name), sourceExtension)) {
    problems.issues.push({ path: `${at}.name`, message: `must end in .${sourceExtension}, like the file` });
    return null;
  }
  return name;
}

function resolveFile(request: EntryRequest, at: string, policy: AttachmentPolicy, problems: AttachmentProblems): ResolvedAttachment | null {
  const where = `${at}.path`;
  const issue = (message: string): null => { problems.issues.push({ path: where, message }); return null; };
  const refuse = (message: string): null => { problems.refusals.push({ path: where, message }); return null; };
  const raw = String(request.path ?? '').trim();
  if (!raw || raw.includes('\0') || raw.length > MAX_PATH_CHARS) {
    return issue('must name one file: an absolute path, ~/…, or a path in BotBoy’s files workspace');
  }
  let candidate: string;
  if (raw === '~' || raw.startsWith('~/')) candidate = path.join(policy.homeDir, raw.slice(1));
  else if (path.isAbsolute(raw)) candidate = path.resolve(raw);
  else if (raw.split(/[\\/]/).includes('..')) {
    return issue('a relative path is read inside BotBoy’s files workspace and may not contain ..; use an absolute or ~/ path for other files');
  } else candidate = path.resolve(policy.filesDir, raw);

  if (resolvesIntoPrivateState(candidate, { privateRoot: policy.privateRoot, filesDir: policy.filesDir })) return refuse(PRIVATE_STATE);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(candidate);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    return issue(code === 'EACCES' || code === 'EPERM'
      ? 'the file exists but this Mac account cannot read it'
      : 'no file at this path; use the exact path the owner gave or a tool returned');
  }
  if (stat.isDirectory()) return issue('is a folder: attach its files one by one, or zip it first');
  if (!stat.isFile()) return issue('is not a regular file');
  const real = canonicalLocalPath(candidate);
  const held = pathHold(candidate, policy, stat.size) ?? (real === candidate ? null : pathHold(real, policy, stat.size));
  if (held) return refuse(held);
  const shown = path.basename(candidate);
  const sourceExtension = extensionOf(shown);
  const name = finalName(request.name, shown, sourceExtension, at, problems);
  if (name === null) return null;
  const blocked = blockedAttachmentType(shown) ?? blockedAttachmentType(name);
  if (blocked) return refuse(`Gmail blocks ${blocked} files and would refuse the whole email; the owner can share it another way`);
  if (!stat.size) return issue('the file is empty');
  if (stat.size > MAX_ATTACHMENT_BYTES) {
    return issue(`the file is ${formatByteSize(stat.size)}; one email carries at most ${formatByteSize(MAX_ATTACHMENT_BYTES)} of files`);
  }
  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(real);
  } catch {
    return issue('the file could not be read');
  }
  if (!bytes.length || bytes.length > MAX_ATTACHMENT_BYTES) return issue('the file changed while BotBoy read it; try once more');
  const secrets = textSecrets(bytes);
  if (secrets) return refuse(`${describeSecretKinds(secrets)}: BotBoy never emails credentials`);
  return {
    name,
    mimeType: mimeTypeForName(sourceExtension ? shown : name),
    content: bytes,
    sizeBytes: bytes.length,
    sha256: sha256(bytes),
    source: { kind: 'file', path: real },
  };
}

function resolveImage(
  request: EntryRequest,
  at: string,
  policy: AttachmentPolicy,
  problems: AttachmentProblems,
  imageNames: Map<string, number>,
): ResolvedAttachment | null {
  const issue = (message: string): null => { problems.issues.push({ path: `${at}.assetId`, message }); return null; };
  const assetId = String(request.assetId ?? '').trim();
  if (!ASSET_ID_PATTERN.test(assetId) || (request.versionId !== undefined && !VERSION_ID_PATTERN.test(request.versionId))) {
    return issue('must be the exact va_… id of an image in this conversation (its VISUAL ASSETS line or screenshot receipt)');
  }
  if (!policy.images) return issue('chat images cannot be attached in this BotBoy build; attach the image file by path instead');
  let original: ReturnType<VisualAssetRegistry['readOriginal']>;
  try {
    original = policy.images.readOriginal(assetId, request.versionId);
  } catch {
    return issue('no image with this id; use an exact va_… id from this conversation');
  }
  const { record, buffer } = original;
  const extension = record.mime === 'image/png' ? 'png' : 'jpg';
  const base = record.ownerKind === 'browser_screenshot' ? 'screenshot' : 'image';
  const count = (imageNames.get(base) ?? 0) + 1;
  imageNames.set(base, count);
  const name = finalName(request.name, `${base}${count > 1 ? `-${count}` : ''}.${extension}`, extension, at, problems);
  if (name === null) return null;
  if (!buffer.length || buffer.length > MAX_ATTACHMENT_BYTES) {
    return issue(`the image is ${formatByteSize(buffer.length)}; one email carries at most ${formatByteSize(MAX_ATTACHMENT_BYTES)} of files`);
  }
  return {
    name,
    mimeType: record.mime,
    content: buffer,
    sizeBytes: buffer.length,
    sha256: sha256(buffer),
    source: { kind: 'image', assetId: record.assetId, versionId: record.versionId },
  };
}

function entryRequest(entry: unknown, at: string, issues: ComposeIssue[]): EntryRequest | null {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    issues.push({ path: at, message: 'must be an object: {"path": …} or {"assetId": …}, with an optional "name"' });
    return null;
  }
  const record = entry as Record<string, unknown>;
  const unknown = Object.keys(record).filter(key => !ENTRY_KEYS.has(key));
  if (unknown.length) {
    issues.push({ path: at, message: `unknown field ${unknown.map(key => `"${key.slice(0, 40)}"`).join(', ')}; use path or assetId, and name` });
    return null;
  }
  const given = (key: string) => record[key] !== undefined && record[key] !== null && record[key] !== '';
  if (given('path') === given('assetId')) {
    issues.push({ path: at, message: 'give exactly one of path (a local file) or assetId (an image from this chat)' });
    return null;
  }
  for (const key of ENTRY_KEYS) {
    if (given(key) && typeof record[key] !== 'string') {
      issues.push({ path: `${at}.${key}`, message: 'must be a string' });
      return null;
    }
  }
  return {
    ...(given('path') ? { path: record.path as string } : { assetId: record.assetId as string }),
    ...(given('name') ? { name: record.name as string } : {}),
  };
}

function resolveEntry(
  request: EntryRequest,
  at: string,
  policy: AttachmentPolicy,
  problems: AttachmentProblems,
  imageNames: Map<string, number>,
): ResolvedAttachment | null {
  return request.path !== undefined
    ? resolveFile(request, at, policy, problems)
    : resolveImage(request, at, policy, problems, imageNames);
}

/** The whole set: each source once, and no more than Gmail carries. */
function checkSet(list: readonly ResolvedAttachment[], issues: ComposeIssue[]): void {
  const seen = new Set<string>();
  for (const attachment of list) {
    const key = attachment.source.kind === 'file'
      ? `file:${attachment.source.path}`
      : `image:${attachment.source.assetId}:${attachment.source.versionId}`;
    if (seen.has(key)) issues.push({ path: 'attachments', message: `${attachment.name} is listed twice` });
    seen.add(key);
  }
  const total = list.reduce((sum, attachment) => sum + attachment.sizeBytes, 0);
  if (total > MAX_ATTACHMENT_BYTES) {
    issues.push({
      path: 'attachments',
      message: `one email carries at most ${formatByteSize(MAX_ATTACHMENT_BYTES)} of files and these are ${formatByteSize(total)}; attach fewer, or tell the owner to share the large ones another way`,
    });
  }
}

/**
 * The files named by a tool call's `attachments`, read and checked. Every
 * problem lands in `problems` (all entries in one pass); only usable files
 * are returned.
 */
export function resolveAttachments(value: unknown, policy: AttachmentPolicy, problems: AttachmentProblems): ResolvedAttachment[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    problems.issues.push({ path: 'attachments', message: 'must be a list of {"path": …} or {"assetId": …} entries ([] for none)' });
    return [];
  }
  if (value.length > MAX_ATTACHMENTS) {
    problems.issues.push({ path: 'attachments', message: `at most ${MAX_ATTACHMENTS} files in one email (got ${value.length})` });
  }
  const imageNames = new Map<string, number>();
  const out: ResolvedAttachment[] = [];
  for (const [index, entry] of value.slice(0, MAX_ATTACHMENTS).entries()) {
    const at = `attachments[${index}]`;
    const request = entryRequest(entry, at, problems.issues);
    const resolved = request ? resolveEntry(request, at, policy, problems, imageNames) : null;
    if (resolved) out.push(resolved);
  }
  checkSet(out, problems.issues);
  return out;
}

function isStoredAttachment(value: unknown): value is StoredAttachment {
  const entry = value as StoredAttachment;
  if (!entry || typeof entry !== 'object' || typeof entry.name !== 'string' || typeof entry.mimeType !== 'string'
    || !Number.isInteger(entry.sizeBytes) || typeof entry.sha256 !== 'string' || !SHA256_PATTERN.test(entry.sha256)) return false;
  const source = entry.source as AttachmentSource | undefined;
  if (source?.kind === 'file') return typeof source.path === 'string' && path.isAbsolute(source.path);
  return source?.kind === 'image' && ASSET_ID_PATTERN.test(String(source.assetId)) && VERSION_ID_PATTERN.test(String(source.versionId));
}

/**
 * A draft's earlier attachments, read again for an update that did not pass
 * `attachments`. Each must still be the same bytes (SHA-256): a file that
 * changed or is gone is an issue, never a silent swap.
 */
export function reattachStored(stored: unknown, policy: AttachmentPolicy, problems: AttachmentProblems): ResolvedAttachment[] {
  if (stored === undefined || stored === null) return [];
  if (!Array.isArray(stored) || !stored.every(isStoredAttachment)) {
    problems.issues.push({ path: 'attachments', message: `the draft’s earlier attachments could not be read back; ${ATTACH_AGAIN}` });
    return [];
  }
  const out: ResolvedAttachment[] = [];
  for (const entry of stored) {
    const label = `${entry.name} (attached to the draft before)`;
    const local: AttachmentProblems = { issues: [], refusals: [] };
    const request: EntryRequest = entry.source.kind === 'file'
      ? { path: entry.source.path, name: entry.name }
      : { assetId: entry.source.assetId, versionId: entry.source.versionId, name: entry.name };
    const resolved = resolveEntry(request, 'attachments', policy, local, new Map());
    problems.issues.push(...local.issues.map(issue => ({ path: 'attachments', message: `${label}: ${issue.message}; ${ATTACH_AGAIN}` })));
    problems.refusals.push(...local.refusals.map(issue => ({ path: 'attachments', message: `${label}: ${issue.message}` })));
    if (!resolved) continue;
    if (resolved.sha256 !== entry.sha256) {
      problems.issues.push({ path: 'attachments', message: `${label} changed since the draft was saved; ${ATTACH_AGAIN}` });
      continue;
    }
    out.push(resolved);
  }
  checkSet(out, problems.issues);
  return out;
}

export function storedAttachment(attachment: ResolvedAttachment): StoredAttachment {
  return {
    name: attachment.name,
    mimeType: attachment.mimeType,
    sizeBytes: attachment.sizeBytes,
    sha256: attachment.sha256,
    source: attachment.source,
  };
}

export function attachmentReceipt(attachment: ResolvedAttachment | StoredAttachment): AttachmentReceipt {
  return {
    name: attachment.name,
    mimeType: attachment.mimeType,
    sizeBytes: attachment.sizeBytes,
    sha256: attachment.sha256,
    from: attachment.source.kind === 'file' ? attachment.source.path : attachment.source.assetId,
  };
}

/** Stored entries from a ledger value, dropping anything malformed (for views and receipts only). */
export function storedAttachmentsOf(value: unknown): StoredAttachment[] {
  return Array.isArray(value) ? value.filter(isStoredAttachment) : [];
}
