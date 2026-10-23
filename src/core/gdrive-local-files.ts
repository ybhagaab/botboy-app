/**
 * Local files and Google Drive (google-workspace.md, "Uploads and downloads").
 *
 * Upload sources are a local file (absolute, ~/…, or a path in BotBoy's files
 * workspace) or a chat image (va_…). The boundary is the one Gmail attachments
 * keep, because an upload leaves this Mac: BotBoy's private state, credential
 * files, hidden files and folders, app data in ~/Library (iCloud Drive and
 * cloud-storage folders excepted), and text files holding a secret are
 * refused, never silently skipped. Any type is fine (images, JSON, archives).
 *
 * Downloads land in BotBoy's files workspace (files/gdrive/) or a folder the
 * owner names outside private state; an existing file is never overwritten
 * ("name (2).ext"). A Drive file named like a credential is not downloaded,
 * and a downloaded text file holding a secret is removed again.
 */

import { createHash } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { canonicalLocalPath, resolvesIntoPrivateState } from './protected-local-resources.js';
import { describeSecretKinds, detectSecrets, sensitiveLocalPathReason } from './sensitive-files.js';
import { mimeTypeForName } from './gmail-mime.js';
import type { VisualAssetRegistry } from './visual-assets.js';
import { invalid, type GoogleFailure } from './google-tool-support.js';

/** Largest upload or download BotBoy moves in one call. */
export const GDRIVE_MAX_TRANSFER_BYTES = 2 * 1024 * 1024 * 1024;
/** Text files up to this size are scanned for secrets before upload / after download. */
const SECRET_SCAN_BYTES = 20 * 1024 * 1024;
const BINARY_PROBE_BYTES = 64 * 1024;
const MAX_PATH_CHARS = 4096;
const ASSET_ID_PATTERN = /^va_[a-f0-9]{32}$/;
const LIBRARY_DOCUMENT_FOLDERS = ['Mobile Documents', 'CloudStorage'];

export interface LocalFilePolicy {
  homeDir: string;
  privateRoot: string;
  filesDir: string;
  images?: Pick<VisualAssetRegistry, 'readOriginal'>;
}

export function defaultLocalFilePolicy(images?: Pick<VisualAssetRegistry, 'readOriginal'>, homeDir = os.homedir()): LocalFilePolicy {
  const privateRoot = path.join(homeDir, '.personal-productivity-tracker');
  return { homeDir, privateRoot, filesDir: path.join(privateRoot, 'files'), ...(images ? { images } : {}) };
}

export interface UploadSource {
  name: string;
  mimeType: string;
  size: number;
  sha256: string;
  /** The local file, or the chat image id. */
  from: string;
  read(offset: number, length: number): Buffer;
  close(): void;
}

function inside(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!!relative && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

/** Why a path must not leave this Mac (or receive a download), from the path alone. */
function pathHold(target: string, policy: LocalFilePolicy, sizeBytes: number | undefined, verb: string): string | null {
  let judged = target;
  for (const root of [policy.filesDir, canonicalLocalPath(policy.filesDir)]) {
    if (inside(target, root)) {
      judged = path.relative(root, target);
      break;
    }
  }
  const credential = sensitiveLocalPathReason(judged, sizeBytes);
  if (credential) return `${credential}: BotBoy never ${verb} credentials or keys`;
  const hidden = judged.split(path.sep).find(segment => segment.startsWith('.') && segment !== '.' && segment !== '..');
  if (hidden) return `In a hidden location (${hidden}): BotBoy does not ${verb === 'uploads' ? 'upload hidden files' : 'write into hidden folders'}`;
  for (const home of [policy.homeDir, canonicalLocalPath(policy.homeDir)]) {
    const library = path.join(home, 'Library');
    if (inside(target, library) && !LIBRARY_DOCUMENT_FOLDERS.some(folder => inside(target, path.join(library, folder)))) {
      return 'App data in ~/Library, which BotBoy does not touch (iCloud Drive and cloud-storage folders are fine)';
    }
  }
  return null;
}

function resolvePathArgument(raw: string, policy: LocalFilePolicy): { ok: true; path: string } | { ok: false; message: string } {
  if (!raw || raw.includes('\0') || raw.length > MAX_PATH_CHARS) return { ok: false, message: 'must name one path: absolute, ~/…, or a path in BotBoy’s files workspace' };
  if (raw === '~' || raw.startsWith('~/')) return { ok: true, path: path.join(policy.homeDir, raw.slice(1)) };
  if (path.isAbsolute(raw)) return { ok: true, path: path.resolve(raw) };
  if (raw.split(/[\\/]/).includes('..')) return { ok: false, message: 'a relative path is read inside BotBoy’s files workspace and may not contain ..; use an absolute or ~/ path for other files' };
  return { ok: true, path: path.resolve(policy.filesDir, raw) };
}

function sha256OfFile(file: string): string {
  const hash = createHash('sha256');
  const fd = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(4 * 1024 * 1024);
    for (;;) {
      const read = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (!read) break;
      hash.update(buffer.subarray(0, read));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

/** Secret kinds in a text file's bytes; null for binary or none found. */
export function textSecretsOf(bytes: Buffer): string | null {
  if (bytes.subarray(0, BINARY_PROBE_BYTES).includes(0)) return null;
  let decoded: string;
  try {
    decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
  const kinds = detectSecrets(decoded);
  return kinds.length ? describeSecretKinds(kinds) : null;
}

/** The file or chat image an upload sends, read and checked. A refusal is `upload_not_allowed`, never a silent skip. */
export function resolveUploadSource(input: { path?: unknown; assetId?: unknown; name?: unknown }, policy: LocalFilePolicy): { ok: true; source: UploadSource } | { ok: false; failure: GoogleFailure } {
  const hasPath = typeof input.path === 'string' && input.path.trim() !== '';
  const hasAsset = typeof input.assetId === 'string' && input.assetId.trim() !== '';
  if (hasPath === hasAsset) return { ok: false, failure: invalid('Give exactly one of path (a local file) or assetId (an image from this chat).') };
  const refuse = (message: string): { ok: false; failure: GoogleFailure } => ({
    ok: false,
    failure: { code: 'upload_not_allowed', message, effect: 'none', nextAction: 'Tell the owner BotBoy will not upload this file and why; they can upload it themselves in Drive.' },
  });
  const requestedName = typeof input.name === 'string' ? input.name.trim() : '';
  if (requestedName && (requestedName.length > 250 || /[\u0000-\u001f]/.test(requestedName))) return { ok: false, failure: invalid('name must be a plain file name of at most 250 characters.') };

  if (hasAsset) {
    const assetId = String(input.assetId).trim();
    if (!ASSET_ID_PATTERN.test(assetId)) return { ok: false, failure: invalid('assetId must be the exact va_… id of an image in this conversation.') };
    if (!policy.images) return { ok: false, failure: invalid('Chat images cannot be uploaded in this BotBoy build; upload the image file by path instead.') };
    let original: ReturnType<VisualAssetRegistry['readOriginal']>;
    try {
      original = policy.images.readOriginal(assetId);
    } catch {
      return { ok: false, failure: invalid('No image with this id; use an exact va_… id from this conversation.') };
    }
    const buffer = original.buffer;
    const extension = original.record.mime === 'image/png' ? 'png' : 'jpg';
    const name = requestedName || `${original.record.ownerKind === 'browser_screenshot' ? 'screenshot' : 'image'}.${extension}`;
    return {
      ok: true,
      source: {
        name,
        mimeType: original.record.mime,
        size: buffer.length,
        sha256: createHash('sha256').update(buffer).digest('hex'),
        from: assetId,
        read: (offset, length) => buffer.subarray(offset, offset + length),
        close: () => {},
      },
    };
  }

  const resolved = resolvePathArgument(String(input.path).trim(), policy);
  if (!resolved.ok) return { ok: false, failure: invalid(`path ${resolved.message}.`) };
  const candidate = resolved.path;
  if (resolvesIntoPrivateState(candidate, { privateRoot: policy.privateRoot, filesDir: policy.filesDir })) {
    return refuse('This is BotBoy’s private data (its database, credentials, and caches), which BotBoy never uploads; files BotBoy makes for the owner are in its files workspace.');
  }
  let stat: fs.Stats;
  try {
    stat = fs.statSync(candidate);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    return { ok: false, failure: invalid(code === 'EACCES' || code === 'EPERM' ? 'The file exists but this Mac account cannot read it.' : 'No file at this path; use the exact path the owner gave or a tool returned.') };
  }
  if (stat.isDirectory()) return { ok: false, failure: invalid('This is a folder: upload its files one by one (or zip it first with run_command), and make the folder in Drive with gdrive_files action create kind folder.') };
  if (!stat.isFile()) return { ok: false, failure: invalid('This is not a regular file.') };
  const real = canonicalLocalPath(candidate);
  const held = pathHold(candidate, policy, stat.size, 'uploads') ?? (real === candidate ? null : pathHold(real, policy, stat.size, 'uploads'));
  if (held) return refuse(held);
  if (stat.size > GDRIVE_MAX_TRANSFER_BYTES) return { ok: false, failure: invalid(`The file is ${(stat.size / 1024 / 1024 / 1024).toFixed(1)} GB; BotBoy uploads at most 2 GB at a time.`) };
  if (stat.size <= SECRET_SCAN_BYTES) {
    let bytes: Buffer;
    try {
      bytes = fs.readFileSync(real);
    } catch {
      return { ok: false, failure: invalid('The file could not be read.') };
    }
    const secrets = textSecretsOf(bytes);
    if (secrets) return refuse(`${secrets}: BotBoy never uploads credentials.`);
  }
  const name = requestedName || path.basename(candidate);
  let fd: number | null = null;
  return {
    ok: true,
    source: {
      name,
      mimeType: mimeTypeForName(path.basename(candidate)),
      size: stat.size,
      sha256: sha256OfFile(real),
      from: real,
      read(offset, length) {
        if (fd === null) fd = fs.openSync(real, 'r');
        const buffer = Buffer.alloc(Math.min(length, Math.max(0, stat.size - offset)));
        const read = fs.readSync(fd, buffer, 0, buffer.length, offset);
        return buffer.subarray(0, read);
      },
      close() {
        if (fd !== null) {
          try { fs.closeSync(fd); } catch { /* already closed */ }
          fd = null;
        }
      },
    },
  };
}

/** A safe local file name from a Drive name. */
export function safeFileName(name: string, fallback = 'download'): string {
  const cleaned = String(name ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[/\\:]/g, '-')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 200);
  return cleaned || fallback;
}

/** Where a download goes: files/gdrive/ (default) or the folder the owner named, never over an existing file. */
export function resolveDownloadTarget(input: { saveTo?: unknown; fileName: string }, policy: LocalFilePolicy): { ok: true; path: string; inWorkspace: boolean } | { ok: false; failure: GoogleFailure } {
  const refuse = (message: string): { ok: false; failure: GoogleFailure } => ({
    ok: false,
    failure: { code: 'download_not_allowed', message, effect: 'none', nextAction: 'Download into BotBoy’s files workspace (leave saveTo out), or a normal folder such as ~/Downloads.' },
  });
  let folder: string;
  const saveTo = typeof input.saveTo === 'string' ? input.saveTo.trim() : '';
  if (!saveTo) {
    folder = path.join(policy.filesDir, 'gdrive');
    fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
  } else {
    const resolved = resolvePathArgument(saveTo, policy);
    if (!resolved.ok) return { ok: false, failure: invalid(`saveTo ${resolved.message}.`) };
    folder = resolved.path;
    if (resolvesIntoPrivateState(folder, { privateRoot: policy.privateRoot, filesDir: policy.filesDir })) return refuse('That is BotBoy’s private data folder.');
    const held = pathHold(folder, policy, undefined, 'writes');
    if (held) return refuse(held);
    if (inside(folder, policy.filesDir) || inside(canonicalLocalPath(folder), canonicalLocalPath(policy.filesDir))) {
      fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
    }
    let stat: fs.Stats;
    try {
      stat = fs.statSync(folder);
    } catch {
      return { ok: false, failure: invalid('saveTo must be a folder that exists (BotBoy creates folders only inside its files workspace).') };
    }
    if (!stat.isDirectory()) return { ok: false, failure: invalid('saveTo must be a folder, not a file.') };
  }
  const name = safeFileName(input.fileName);
  const credential = sensitiveLocalPathReason(name);
  if (credential) return refuse(`${credential}: BotBoy does not download credentials or keys`);
  const ext = path.extname(name);
  const stem = ext ? name.slice(0, -ext.length) : name;
  for (let n = 1; n <= 200; n++) {
    const candidate = path.join(folder, n === 1 ? name : `${stem} (${n})${ext}`);
    if (!fs.existsSync(candidate)) {
      return { ok: true, path: candidate, inWorkspace: inside(canonicalLocalPath(folder), canonicalLocalPath(policy.filesDir)) };
    }
  }
  return { ok: false, failure: invalid('That folder already has 200 files with this name; choose another name or folder.') };
}

/** After a download: a text file holding a secret is removed again. */
export function downloadedSecretHold(file: string): string | null {
  let stat: fs.Stats;
  try { stat = fs.statSync(file); } catch { return null; }
  if (stat.size > SECRET_SCAN_BYTES) return null;
  const secrets = textSecretsOf(fs.readFileSync(file));
  return secrets ? `${secrets}: BotBoy keeps credentials out of its files` : null;
}
