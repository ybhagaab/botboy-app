/**
 * Pictures BotBoy holds, by the names a document or a tool uses for them
 * (docs/maps/document-media.md). One resolver serves documents (the reader and
 * every export) and Google insertions, so a picture that shows in one shows in all:
 *
 *   /api/files/<path>, ~/.personal-productivity-tracker/files/<path>, a path inside
 *   that folder, or a plain relative path      → a file in BotBoy's files workspace
 *   va_… (or /api/visual-assets/va_…/original) → a chat image or browser screenshot
 *   att_… (or /api/chat/attachments/att_…)     → a chat attachment
 *
 * Anything else is not BotBoy's: an https link is `external`, a path elsewhere on
 * this Mac is `outside_botboy`. Containment is judged on the real path, so a link
 * inside the workspace cannot point out of it.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { VisualAssetRegistry } from './visual-assets.js';

export type ImageType = 'png' | 'jpeg' | 'gif' | 'webp' | 'svg';

export const IMAGE_MIME: Readonly<Record<ImageType, string>> = Object.freeze({
  png: 'image/png', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
});
export const IMAGE_EXTENSION: Readonly<Record<ImageType, string>> = Object.freeze({
  png: 'png', jpeg: 'jpg', gif: 'gif', webp: 'webp', svg: 'svg',
});

/** The largest picture a document or an insertion takes. */
export const MAX_PICTURE_BYTES = 25 * 1024 * 1024;

export interface MediaSourceDeps {
  homeDir: string;
  filesDir: string;
  attachmentsDir: string;
  visualAssets?: Pick<VisualAssetRegistry, 'resolveOriginalPath'>;
}

let configured: Partial<MediaSourceDeps> = {};

/** Set once at startup (index.ts): the visual-asset registry, and test folders. */
export function configureMediaSources(deps: Partial<MediaSourceDeps>): void {
  configured = { ...configured, ...deps };
}

export function mediaSourceDeps(overrides: Partial<MediaSourceDeps> = {}): MediaSourceDeps {
  const homeDir = overrides.homeDir ?? configured.homeDir ?? os.homedir();
  const privateRoot = path.join(homeDir, '.personal-productivity-tracker');
  return {
    homeDir,
    filesDir: overrides.filesDir ?? configured.filesDir ?? path.join(privateRoot, 'files'),
    attachmentsDir: overrides.attachmentsDir ?? configured.attachmentsDir ?? path.join(privateRoot, 'chat-attachments'),
    ...((overrides.visualAssets ?? configured.visualAssets) ? { visualAssets: overrides.visualAssets ?? configured.visualAssets } : {}),
  };
}

/** What a picture's bytes are, from their first bytes (never from the name). */
export function sniffImageType(head: Buffer): ImageType | null {
  if (head.length >= 8 && head.toString('hex', 0, 8) === '89504e470d0a1a0a') return 'png';
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'jpeg';
  if (head.length >= 6 && /^GIF8[79]a$/.test(head.toString('latin1', 0, 6))) return 'gif';
  if (head.length >= 12 && head.toString('latin1', 0, 4) === 'RIFF' && head.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  const text = head.toString('utf8', 0, Math.min(head.length, 4096)).replace(/^\uFEFF/, '');
  if (/^\s*(?:<\?xml[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)*(?:<!DOCTYPE[^>]*>\s*)?<svg[\s>]/i.test(text)) return 'svg';
  return null;
}

/** Pixel size of a PNG, JPEG, GIF or WebP; null when the header does not say. */
export function rasterDimensions(buffer: Buffer, type: ImageType): { width: number; height: number } | null {
  try {
    if (type === 'png' && buffer.length >= 24) return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
    if (type === 'gif' && buffer.length >= 10) return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
    if (type === 'webp' && buffer.length >= 30) {
      const chunk = buffer.toString('latin1', 12, 16);
      if (chunk === 'VP8X') return { width: 1 + buffer.readUIntLE(24, 3), height: 1 + buffer.readUIntLE(27, 3) };
      if (chunk === 'VP8 ') return { width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff };
      if (chunk === 'VP8L') {
        const bits = buffer.readUInt32LE(21);
        return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
      }
      return null;
    }
    if (type === 'jpeg') {
      const sof = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
      let offset = 2;
      while (offset + 4 <= buffer.length) {
        while (offset < buffer.length && buffer[offset] === 0xff) offset++;
        const marker = buffer[offset++];
        if (marker === 0xd9 || marker === 0xda) break;
        if (marker >= 0xd0 && marker <= 0xd7) continue;
        const length = buffer.readUInt16BE(offset);
        if (length < 2) break;
        if (sof.has(marker) && length >= 7) return { height: buffer.readUInt16BE(offset + 3), width: buffer.readUInt16BE(offset + 5) };
        offset += length;
      }
    }
  } catch {
    return null;
  }
  return null;
}

export type BotboyImageSource = 'files' | 'visual_asset' | 'chat_attachment';

export interface ResolvedBotboyImage {
  ok: true;
  source: BotboyImageSource;
  /** The real file. */
  path: string;
  type: ImageType;
  bytes: number;
  /** Where the owner's page shows it. */
  displayUrl: string;
  /** A file name for it (what an upload or an export names it). */
  name: string;
}

export type UnresolvedImageCode = 'external' | 'outside_botboy' | 'not_found' | 'not_an_image' | 'too_large' | 'invalid_source';

export interface UnresolvedBotboyImage {
  ok: false;
  code: UnresolvedImageCode;
  message: string;
  nextAction: string;
  /** outside_botboy: the real path (it exists). */
  path?: string;
}

const ASSET = /^(?:\/api\/visual-assets\/)?(va_[a-f0-9]{32})(?:\/original)?(?:\?versionId=(vav_[a-f0-9]{32}))?$/;
const ATTACHMENT = /^(?:\/api\/chat\/attachments\/)?(att_[a-f0-9]{12})$/;
const ATTACHMENT_FILE = /^(att_[a-f0-9]{12})\.(png|jpg|jpeg|webp|gif)$/;
const NEXT_ACTION = 'Use a picture BotBoy holds: a file in its files workspace (/api/files/… as write_file, a download or a screenshot receipt gives it) or a chat image or screenshot id (va_…).';

function realpath(target: string): string | null {
  try { return fs.realpathSync.native(target); } catch { return null; }
}

function inside(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!!relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function decodeSegments(value: string): string[] | null {
  try {
    const segments = value.split('/').filter(segment => segment !== '').map(segment => decodeURIComponent(segment));
    if (!segments.length || segments.some(segment => segment === '..' || segment === '.' || segment.includes('\0') || segment.includes('/'))) return null;
    return segments;
  } catch {
    return null;
  }
}

function checkedFile(file: string, source: BotboyImageSource, displayUrl: string, name: string): ResolvedBotboyImage | UnresolvedBotboyImage {
  let stat: fs.Stats;
  try { stat = fs.statSync(file); } catch {
    return { ok: false, code: 'not_found', message: 'The picture file is gone.', nextAction: NEXT_ACTION };
  }
  if (!stat.isFile()) return { ok: false, code: 'not_an_image', message: 'This is a folder, not a picture.', nextAction: NEXT_ACTION };
  if (stat.size > MAX_PICTURE_BYTES) return { ok: false, code: 'too_large', message: `The picture is ${(stat.size / 1024 / 1024).toFixed(1)} MB; pictures are at most 25 MB.`, nextAction: 'Use a smaller picture or crop it.' };
  const head = Buffer.alloc(Math.min(stat.size, 4096));
  try {
    const fd = fs.openSync(file, 'r');
    try { fs.readSync(fd, head, 0, head.length, 0); } finally { fs.closeSync(fd); }
  } catch {
    return { ok: false, code: 'not_found', message: 'The picture file could not be read.', nextAction: NEXT_ACTION };
  }
  const type = sniffImageType(head);
  if (!type) return { ok: false, code: 'not_an_image', message: 'This file is not a picture (PNG, JPEG, GIF, WebP or SVG).', nextAction: NEXT_ACTION };
  return { ok: true, source, path: file, type, bytes: stat.size, displayUrl, name };
}

/** The picture a source names, if BotBoy holds it (see the header for the forms). */
export function resolveBotboyImage(rawSource: string, overrides: Partial<MediaSourceDeps> = {}): ResolvedBotboyImage | UnresolvedBotboyImage {
  const deps = mediaSourceDeps(overrides);
  let source = String(rawSource ?? '').trim();
  if (source.startsWith('<') && source.endsWith('>')) source = source.slice(1, -1).trim();
  if (!source || source.length > 4096 || source.includes('\0')) {
    return { ok: false, code: 'invalid_source', message: 'The picture has no usable source.', nextAction: NEXT_ACTION };
  }

  const asset = ASSET.exec(source);
  if (asset) {
    if (!deps.visualAssets) return { ok: false, code: 'not_found', message: 'Chat images are not available in this BotBoy build.', nextAction: NEXT_ACTION };
    try {
      const resolved = deps.visualAssets.resolveOriginalPath(asset[1], asset[2]);
      const type: ImageType = resolved.record.mime === 'image/png' ? 'png' : 'jpeg';
      return checkedFile(resolved.path, 'visual_asset', `/api/visual-assets/${asset[1]}/original${asset[2] ? `?versionId=${asset[2]}` : ''}`, `${resolved.record.ownerKind === 'browser_screenshot' ? 'screenshot' : 'image'}-${asset[1].slice(3, 11)}.${IMAGE_EXTENSION[type]}`);
    } catch {
      return { ok: false, code: 'not_found', message: `No chat image or screenshot ${asset[1]}.`, nextAction: 'Use the exact va_… id from this conversation, or a file in BotBoy’s files workspace.' };
    }
  }

  const attachment = ATTACHMENT.exec(source);
  if (attachment) return attachmentFile(attachment[1], deps);

  if (/^[a-z][a-z0-9+.-]*:/i.test(source) && !/^file:\/\//i.test(source)) {
    return /^https?:\/\//i.test(source)
      ? { ok: false, code: 'external', message: 'A picture on the web is not stored by BotBoy.', nextAction: 'Download it into BotBoy’s files workspace first (web_fetch or run_command), then use that file.' }
      : { ok: false, code: 'invalid_source', message: 'Pictures come from files or chat images, not from this kind of link.', nextAction: NEXT_ACTION };
  }

  let candidate: string;
  if (/^file:\/\//i.test(source)) {
    try { candidate = decodeURIComponent(new URL(source).pathname); } catch {
      return { ok: false, code: 'invalid_source', message: 'The file link could not be read.', nextAction: NEXT_ACTION };
    }
  } else if (source.startsWith('/api/files/')) {
    const segments = decodeSegments(source.slice('/api/files/'.length).split(/[?#]/)[0]);
    if (!segments) return { ok: false, code: 'invalid_source', message: 'The /api/files/ path is not a plain path inside BotBoy’s files.', nextAction: NEXT_ACTION };
    candidate = path.join(deps.filesDir, ...segments);
  } else if (source === '~' || source.startsWith('~/')) {
    candidate = path.join(deps.homeDir, source.slice(1));
  } else if (path.isAbsolute(source)) {
    candidate = path.resolve(source);
  } else {
    const segments = decodeSegments(source);
    if (!segments) return { ok: false, code: 'invalid_source', message: 'A relative picture path is read inside BotBoy’s files workspace and may not contain ..', nextAction: NEXT_ACTION };
    candidate = path.join(deps.filesDir, ...segments);
  }

  const real = realpath(candidate);
  if (!real) return { ok: false, code: 'not_found', message: 'No picture file at this path.', nextAction: NEXT_ACTION };
  const filesRoot = realpath(deps.filesDir);
  if (filesRoot && inside(real, filesRoot)) {
    const relative = path.relative(filesRoot, real);
    if (!relative) return { ok: false, code: 'not_an_image', message: 'This is BotBoy’s files folder itself, not a picture.', nextAction: NEXT_ACTION };
    return checkedFile(real, 'files', `/api/files/${relative.split(path.sep).map(encodeURIComponent).join('/')}`, path.basename(real));
  }
  const attachmentsRoot = realpath(deps.attachmentsDir);
  if (attachmentsRoot && path.dirname(real) === attachmentsRoot) {
    const named = ATTACHMENT_FILE.exec(path.basename(real));
    if (named) return attachmentFile(named[1], deps);
  }
  return {
    ok: false,
    code: 'outside_botboy',
    path: real,
    message: 'This picture is a file outside BotBoy’s files workspace.',
    nextAction: 'Copy it into BotBoy’s files workspace (run_command cp …) and use that path, or use the chat image id (va_…).',
  };
}

function attachmentFile(id: string, deps: MediaSourceDeps): ResolvedBotboyImage | UnresolvedBotboyImage {
  for (const extension of ['png', 'jpg', 'webp', 'gif']) {
    const file = path.join(deps.attachmentsDir, `${id}.${extension}`);
    if (fs.existsSync(file)) return checkedFile(file, 'chat_attachment', `/api/chat/attachments/${id}`, `${id}.${extension}`);
  }
  return { ok: false, code: 'not_found', message: `No chat attachment ${id}.`, nextAction: NEXT_ACTION };
}
