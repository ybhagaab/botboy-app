/**
 * Chat image attachments — the file store behind paste/upload in the chat
 * composer (owner commission 2026-09-05: every blessed model is
 * vision-capable and the gateway accepts input_image; chat was text-only).
 *
 * Design: the UI uploads a data URL once (POST /chat/attachments), gets a
 * short id back, and the chat turn carries IDS — never base64 — so message
 * bodies, the DB, and the prompt log stay small. Files live under the
 * BotBoy home dir; the GET route serves them back for history thumbnails.
 * Model-side, the CURRENT turn's attachments are re-read from disk into
 * data URLs (llm-client content parts) — historical images deliberately do
 * NOT ride every subsequent request (token discipline; the transcript
 * keeps the thumbnail, the model keeps a text note).
 */

import { randomUUID } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

const ATTACHMENT_DIR = path.join(os.homedir(), '.personal-productivity-tracker', 'chat-attachments');
export const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
export const MAX_ATTACHMENTS_PER_MESSAGE = 4;

const MIME_EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

export interface ChatAttachment {
  id: string;
  mime: string;
  bytes: number;
}

const ID_RE = /^att_[a-f0-9]{12}$/;

/** Parse and validate a data URL; returns null when it is not a supported image. */
export function parseImageDataUrl(dataUrl: string): { mime: string; buffer: Buffer } | null {
  const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl ?? ''));
  if (!match) return null;
  try {
    const buffer = Buffer.from(match[2], 'base64');
    if (buffer.length === 0) return null;
    return { mime: match[1], buffer };
  } catch {
    return null;
  }
}

export function saveChatAttachment(dataUrl: string): ChatAttachment {
  const parsed = parseImageDataUrl(dataUrl);
  if (!parsed) {
    throw new Error('attachment must be a base64 data URL of type image/png, image/jpeg, image/webp, or image/gif');
  }
  if (parsed.buffer.length > MAX_ATTACHMENT_BYTES) {
    throw new Error(`attachment is ${Math.round(parsed.buffer.length / 1024 / 1024)}MB — the limit is ${MAX_ATTACHMENT_BYTES / 1024 / 1024}MB`);
  }
  const id = `att_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  fs.mkdirSync(ATTACHMENT_DIR, { recursive: true });
  fs.writeFileSync(path.join(ATTACHMENT_DIR, `${id}.${MIME_EXTENSIONS[parsed.mime]}`), parsed.buffer);
  return { id, mime: parsed.mime, bytes: parsed.buffer.length };
}

export function loadChatAttachment(id: string): { mime: string; buffer: Buffer } | null {
  if (!ID_RE.test(String(id ?? ''))) return null;
  for (const [mime, extension] of Object.entries(MIME_EXTENSIONS)) {
    const filePath = path.join(ATTACHMENT_DIR, `${id}.${extension}`);
    if (fs.existsSync(filePath)) {
      try {
        return { mime, buffer: fs.readFileSync(filePath) };
      } catch {
        return null;
      }
    }
  }
  return null;
}

/** Data URL for the model's content parts (current turn only). */
export function attachmentAsDataUrl(id: string): string | null {
  const loaded = loadChatAttachment(id);
  if (!loaded) return null;
  return `data:${loaded.mime};base64,${loaded.buffer.toString('base64')}`;
}

/** Validate an incoming id list from the chat body: shape, existence, cap. */
export function validateAttachmentIds(ids: unknown): { ok: true; ids: string[] } | { ok: false; error: string } {
  if (ids === undefined || ids === null) return { ok: true, ids: [] };
  if (!Array.isArray(ids)) return { ok: false, error: 'attachments must be an array of attachment ids' };
  const cleaned = ids.map(value => String(value ?? '').trim()).filter(Boolean);
  if (cleaned.length > MAX_ATTACHMENTS_PER_MESSAGE) {
    return { ok: false, error: `at most ${MAX_ATTACHMENTS_PER_MESSAGE} images per message` };
  }
  for (const id of cleaned) {
    if (!ID_RE.test(id)) return { ok: false, error: `invalid attachment id "${id.slice(0, 40)}"` };
    if (!loadChatAttachment(id)) return { ok: false, error: `attachment ${id} not found — upload it first via POST /chat/attachments` };
  }
  return { ok: true, ids: cleaned };
}
