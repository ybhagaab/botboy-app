/**
 * Pictures and diagrams put into Google Docs and Slides (docs/maps/google-workspace.md, "Pictures").
 *
 * Google's Docs and Slides APIs take a picture only from a public link they fetch once
 * (PNG, JPEG or GIF, under 50 MB and 25 megapixels; no SVG). So a picture BotBoy holds goes
 * in like this, in one call:
 *   1. it is read and checked (preparePicture): a file (core/media-sources.ts forms, or a path
 *      the Drive upload rules allow), a chat image or screenshot (va_…), or a diagram BotBoy
 *      draws from Mermaid or SVG (core/visual-render.ts); SVG and WebP become PNG;
 *   2. that link is anyone-with-the-link sharing, so it follows gdrive_share's rule for it
 *      (temporaryLinkConsent): the owner's chat turn, never a job, and the owner's own
 *      words in this message; otherwise nothing is uploaded and nothing changes;
 *   3. it is uploaded to the owner's Drive as a temporary file, shared "anyone with the link"
 *      (never findable in search) for the moment Google copies it (withPictureLinks);
 *   4. after the insert, in a finally, the sharing is removed and the temporary file trashed:
 *      the Doc or deck keeps its own copy. If removing the sharing fails, the receipt says so.
 * A public https link the owner gives goes to Google as it is: nothing is uploaded or shared.
 * A new Doc made from Markdown needs no link at all: Drive converts a Word file with the
 * pictures inside (gdrive_files create, document-exporter.ts › markdownToWordForGoogle).
 */

import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import type { DriveClient } from './gdrive-api.js';
import { GoogleApiError } from './gmail-api.js';
import { resolveUploadSource, type LocalFilePolicy } from './gdrive-local-files.js';
import { MAX_PICTURE_BYTES, rasterDimensions, resolveBotboyImage, sniffImageType, type ImageType } from './media-sources.js';
import { renderVisuals, type VisualRenderer } from './visual-render.js';
import { invalid, PUBLIC_WORDS, type GoogleFailure } from './google-tool-support.js';
import type { ToolExecutionContext } from './tool-executor.js';

/** Google's own limit on a picture's pixels. */
export const GOOGLE_PICTURE_MAX_PIXELS = 25_000_000;
/** Points per CSS pixel. */
export const PT_PER_PX = 0.75;

export interface PictureSpec {
  path?: string;
  assetId?: string;
  url?: string;
  mermaid?: string;
  svg?: string;
}

export type PreparedPicture =
  | { kind: 'bytes'; buffer: Buffer; mime: 'image/png' | 'image/jpeg' | 'image/gif'; width: number; height: number; from: string }
  | { kind: 'url'; url: string; from: string };

const SPEC_FIELDS = ['path', 'assetId', 'url', 'mermaid', 'svg'] as const;
const MAX_DIAGRAM_CHARS = 200_000;

/** The one picture an edit names: {path} | {assetId} | {url} | {mermaid} | {svg}. */
export function pictureSpecOf(value: unknown, field = 'image'): { ok: true; spec: PictureSpec } | { ok: false; failure: GoogleFailure } {
  const bad = (message: string) => ({ ok: false as const, failure: invalid(`${field} ${message}`, [{ path: field, message: '{path}, {assetId}, {url}, {mermaid} or {svg}' }]) });
  if (typeof value === 'string' && value.trim()) {
    // A bare string: a va_ id, a public link, or a path.
    const text = value.trim();
    if (/^va_[a-f0-9]{32}$/.test(text)) return { ok: true, spec: { assetId: text } };
    if (/^https?:\/\//i.test(text)) return { ok: true, spec: { url: text } };
    return { ok: true, spec: { path: text } };
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return bad('is required: one picture, like {"path": "/api/files/chart.png"} or {"mermaid": "flowchart LR\\n A-->B"}.');
  const record = value as Record<string, unknown>;
  const given = SPEC_FIELDS.filter(key => typeof record[key] === 'string' && String(record[key]).trim() !== '');
  if (given.length !== 1) return bad('names exactly one of path, assetId, url, mermaid or svg.');
  const key = given[0];
  const text = String(record[key]);
  if ((key === 'mermaid' || key === 'svg') && text.length > MAX_DIAGRAM_CHARS) return bad(`${key} is at most ${MAX_DIAGRAM_CHARS.toLocaleString('en-US')} characters.`);
  return { ok: true, spec: { [key]: key === 'mermaid' || key === 'svg' ? text : text.trim() } as PictureSpec };
}

function refused(message: string, nextAction = 'Use a PNG, JPEG or GIF picture BotBoy holds, or a diagram (mermaid or svg).'): { ok: false; failure: GoogleFailure } {
  return { ok: false, failure: { code: 'picture_not_usable', message, effect: 'none', nextAction } };
}

/** A picture as bytes Google takes (or a public link), checked before anything changes. */
export async function preparePicture(spec: PictureSpec, policy: LocalFilePolicy, render: VisualRenderer = renderVisuals): Promise<{ ok: true; picture: PreparedPicture } | { ok: false; failure: GoogleFailure }> {
  if (spec.url) {
    if (!/^https:\/\/[^\s]+$/i.test(spec.url) || spec.url.length > 2000) return refused('A picture link must be a public https:// address of at most 2,000 characters.', 'Give a public https link, or download the picture into BotBoy’s files workspace and use its path.');
    return { ok: true, picture: { kind: 'url', url: spec.url, from: spec.url } };
  }
  if (spec.mermaid !== undefined || spec.svg !== undefined) {
    const kind = spec.mermaid !== undefined ? 'mermaid' : 'svg';
    const drawn = (await render([{ id: 'picture', kind, source: String(spec.mermaid ?? spec.svg) }], { scale: 2 })).get('picture');
    if (!drawn?.ok || !drawn.png) return refused(`The ${kind === 'mermaid' ? 'Mermaid' : 'SVG'} diagram did not draw: ${drawn && !drawn.ok ? drawn.error : 'no picture came back'}`, 'Fix the diagram source and call again; nothing changed.');
    return { ok: true, picture: { kind: 'bytes', buffer: drawn.png, mime: 'image/png', width: drawn.width, height: drawn.height, from: kind } };
  }

  // A file or chat image: BotBoy's own (files workspace, va_…, att_…), or a path the Drive upload rules allow.
  const source = String(spec.assetId ?? spec.path ?? '');
  const resolved = resolveBotboyImage(source, { homeDir: policy.homeDir, filesDir: policy.filesDir });
  let buffer: Buffer;
  let from: string;
  if (resolved.ok) {
    if (resolved.source === 'files') {
      // The workspace file still passes the upload rules (credentials, secrets in text).
      const checked = resolveUploadSource({ path: resolved.path }, policy);
      if (!checked.ok) return { ok: false, failure: checked.failure };
      checked.source.close();
    }
    buffer = fs.readFileSync(resolved.path);
    from = resolved.displayUrl;
  } else if (resolved.code === 'outside_botboy' && spec.path) {
    const checked = resolveUploadSource({ path: spec.path }, policy);
    if (!checked.ok) return { ok: false, failure: checked.failure };
    try {
      if (checked.source.size > MAX_PICTURE_BYTES) return refused('The picture is larger than 25 MB.', 'Use a smaller picture or crop it.');
      buffer = checked.source.read(0, checked.source.size);
    } finally {
      checked.source.close();
    }
    from = checked.source.from;
  } else {
    return refused(resolved.message, resolved.nextAction);
  }
  if (buffer.length > MAX_PICTURE_BYTES) return refused('The picture is larger than 25 MB.', 'Use a smaller picture or crop it.');
  const type = sniffImageType(buffer.subarray(0, 4096));
  if (!type) return refused('This file is not a picture (PNG, JPEG, GIF, WebP or SVG).');
  if (type === 'svg' || type === 'webp') {
    // Google takes neither: BotBoy draws a PNG.
    const job = type === 'svg'
      ? { id: 'picture', kind: 'svg' as const, source: buffer.toString('utf8') }
      : { id: 'picture', kind: 'image' as const, source: `data:image/webp;base64,${buffer.toString('base64')}` };
    const drawn = (await render([job], { scale: type === 'svg' ? 2 : 1 })).get('picture');
    if (!drawn?.ok || !drawn.png) return refused(`The ${type.toUpperCase()} picture could not be turned into a PNG: ${drawn && !drawn.ok ? drawn.error : 'no picture came back'}`);
    return { ok: true, picture: { kind: 'bytes', buffer: drawn.png, mime: 'image/png', width: drawn.width, height: drawn.height, from } };
  }
  const size = rasterDimensions(buffer, type);
  if (!size || size.width < 1 || size.height < 1) return refused('The picture’s size could not be read; it may be damaged.');
  if (size.width * size.height > GOOGLE_PICTURE_MAX_PIXELS) return refused(`The picture is ${size.width}×${size.height}, more than the 25 megapixels Google takes.`, 'Use a smaller picture or crop it.');
  const mimeOf: Record<Exclude<ImageType, 'svg' | 'webp'>, 'image/png' | 'image/jpeg' | 'image/gif'> = { png: 'image/png', jpeg: 'image/jpeg', gif: 'image/gif' };
  return { ok: true, picture: { kind: 'bytes', buffer, mime: mimeOf[type], width: size.width, height: size.height, from } };
}

const LINK_WHY = 'Google copies a picture only from a link anyone can open, so BotBoy would share a temporary copy of it by link (not findable in search) for the seconds Google takes, then remove the sharing and trash the copy.';
const WITHOUT_LINK = 'Without a link: put the picture in a new Doc made from Markdown (gdrive_files create kind doc goes through Word), or use a public https picture address the owner gives.';

/**
 * May these pictures be lent a temporary link? A picture BotBoy holds reaches Google only as
 * an anyone-with-the-link copy, so it takes what gdrive_share takes for such a link: the
 * owner's chat turn (a job or a task the owner started never shares) and the owner's own
 * words in this message. A public https link the owner gives needs neither.
 */
export function temporaryLinkConsent(pictures: readonly PreparedPicture[], context: ToolExecutionContext | undefined): GoogleFailure | null {
  if (!pictures.some(picture => picture.kind === 'bytes')) return null;
  const words = String(context?.currentUserMessage ?? '');
  if (context?.callerKind !== 'interactive' || !words.trim()) {
    return {
      code: 'outside_job_mandate',
      message: `${LINK_WHY} That is sharing, so it needs the owner in chat, never a job. Nothing changed.`,
      effect: 'none',
      nextAction: `Finish what the job allows, then tell the owner the picture needs their go-ahead in chat for a temporary public link. ${WITHOUT_LINK}`,
    };
  }
  if (!PUBLIC_WORDS.test(words)) {
    return {
      code: 'owner_words_required',
      message: `${LINK_WHY} Like any anyone-with-the-link sharing, that needs the owner’s own words in this message. Nothing changed.`,
      effect: 'none',
      nextAction: `Ask the owner whether a temporary public link is fine for this insert, and call again after they say so in their own words (for example “yes, a temporary public link is fine”). ${WITHOUT_LINK}`,
    };
  }
  return null;
}

/** A width in points for a picture: the one asked for, else its natural size, at most `maxPt`. */
export function pictureWidthPt(picture: PreparedPicture, requested: unknown, maxPt: number): number | undefined {
  const asked = Number(requested);
  if (Number.isFinite(asked) && asked > 0) return Math.min(asked, maxPt);
  if (picture.kind !== 'bytes') return undefined;
  return Math.round(Math.min(picture.width * PT_PER_PX, maxPt) * 100) / 100;
}

export interface PictureLinksReceipt {
  /** Pictures uploaded for the moment Google copied them. */
  uploaded: number;
  /** Of those, sharing removed and the temporary file trashed. */
  cleaned: number;
  /** Temporary files whose sharing could not be removed (their Drive ids), for the owner. */
  stillShared: string[];
  /** Temporary files left in My Drive (unshared) because trashing them failed. */
  notTrashed: string[];
}

/** Two addresses Google can fetch a publicly shared Drive file at; the second if the first is refused. */
export function pictureUrlsFor(fileId: string): string[] {
  return [`https://drive.google.com/uc?export=view&id=${encodeURIComponent(fileId)}`, `https://lh3.googleusercontent.com/d/${encodeURIComponent(fileId)}`];
}

/** Google refused to fetch the picture (try the other address), as opposed to any other failure. */
export function isPictureFetchFailure(error: unknown): boolean {
  return error instanceof GoogleApiError && error.status === 400 && /image|retriev|fetch|access to the provided/i.test(error.message);
}

/**
 * Upload each byte picture as a temporary Drive file shared by link, run `insert` with each
 * picture's candidate addresses, then remove the sharing and trash the files, whatever happened.
 */
export async function withPictureLinks<T>(
  drive: DriveClient,
  pictures: readonly PreparedPicture[],
  insert: (addresses: string[][]) => Promise<T>,
): Promise<{ value: T; links: PictureLinksReceipt }> {
  const uploaded: Array<{ fileId: string; permissionId?: string }> = [];
  const links: PictureLinksReceipt = { uploaded: 0, cleaned: 0, stillShared: [], notTrashed: [] };
  const cleanUp = async () => {
    for (const entry of uploaded) {
      let unshared = !entry.permissionId;
      if (entry.permissionId) {
        try {
          await drive.deletePermission!(entry.fileId, entry.permissionId);
          unshared = true;
        } catch {
          links.stillShared.push(entry.fileId);
        }
      }
      try {
        await drive.updateFile!(entry.fileId, { trashed: true });
      } catch {
        links.notTrashed.push(entry.fileId);
      }
      if (unshared) links.cleaned++;
    }
  };
  try {
    const addresses: string[][] = [];
    for (const picture of pictures) {
      if (picture.kind === 'url') { addresses.push([picture.url]); continue; }
      if (!drive.createPermission || !drive.deletePermission || !drive.updateFile) throw new Error('This Drive client cannot share files.');
      const extension = picture.mime === 'image/png' ? 'png' : picture.mime === 'image/gif' ? 'gif' : 'jpg';
      const file = await drive.createFile({
        name: `BotBoy picture (temporary) ${randomBytes(3).toString('hex')}.${extension}`,
        parents: [],
        appProperties: { botboyTemporaryPicture: '1' },
        media: picture.buffer,
        mediaMimeType: picture.mime,
      });
      const entry: { fileId: string; permissionId?: string } = { fileId: file.id };
      uploaded.push(entry);
      links.uploaded++;
      const permission = await drive.createPermission(file.id, { type: 'anyone', role: 'reader', allowFileDiscovery: false });
      entry.permissionId = permission.id;
      addresses.push(pictureUrlsFor(file.id));
    }
    const value = await insert(addresses);
    return { value, links };
  } finally {
    await cleanUp();
  }
}

/** The receipt line about temporary links, for a tool result. */
export function pictureLinksNote(links: PictureLinksReceipt): Record<string, unknown> {
  if (!links.uploaded) return {};
  return {
    temporaryPictures: {
      uploaded: links.uploaded,
      removed: links.cleaned,
      note: 'Google copies an inserted picture from a link, so BotBoy shared each picture by link for those seconds, then removed the sharing and trashed the temporary file.',
      ...(links.stillShared.length ? {
        stillShared: links.stillShared,
        warning: 'The sharing of these temporary pictures could not be removed: tell the owner, and remove "Anyone with the link" with gdrive_share or trash them with gdrive_files.',
      } : {}),
      ...(links.notTrashed.length ? { notTrashed: links.notTrashed, notTrashedNote: 'These temporary pictures are unshared but still in My Drive; trash them with gdrive_files.' } : {}),
    },
  };
}
