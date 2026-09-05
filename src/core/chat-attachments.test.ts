/**
 * Chat image attachments — store, validation, dialect shaping, prompt-log
 * elision, and the history payload (feature: paste/upload images in chat,
 * 2026-09-05).
 *
 * The store writes real files under ~/.personal-productivity-tracker/
 * chat-attachments/ (the module hardcodes its home, same as the app);
 * every id this suite creates is deleted in afterAll.
 */

import { describe, it, expect, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  parseImageDataUrl,
  saveChatAttachment,
  loadChatAttachment,
  attachmentAsDataUrl,
  validateAttachmentIds,
  MAX_ATTACHMENTS_PER_MESSAGE,
} from './chat-attachments.js';
import { toResponsesInput, toWireMessages, type LlmMessage } from './llm-client.js';
import { elideImageDataUrls } from './llm-prompt-log.js';
import { createStorage } from './storage.js';
import { createChatInterface } from './chat-interface.js';

// 1x1 red PNG (67 bytes decoded) — a real image so parse/save round-trips.
const TINY_PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const TINY_PNG_DATA_URL = `data:image/png;base64,${TINY_PNG_B64}`;

const ATTACHMENT_DIR = path.join(os.homedir(), '.personal-productivity-tracker', 'chat-attachments');
const createdIds: string[] = [];

function saveTracked(dataUrl: string) {
  const saved = saveChatAttachment(dataUrl);
  createdIds.push(saved.id);
  return saved;
}

afterAll(() => {
  for (const id of createdIds) {
    for (const ext of ['png', 'jpg', 'webp', 'gif']) {
      try { fs.unlinkSync(path.join(ATTACHMENT_DIR, `${id}.${ext}`)); } catch {}
    }
  }
});

describe('chat-attachments store', () => {
  it('parses supported image data URLs and rejects everything else', () => {
    expect(parseImageDataUrl(TINY_PNG_DATA_URL)?.mime).toBe('image/png');
    expect(parseImageDataUrl(`data:image/jpeg;base64,${TINY_PNG_B64}`)?.mime).toBe('image/jpeg');
    expect(parseImageDataUrl(`data:image/webp;base64,${TINY_PNG_B64}`)?.mime).toBe('image/webp');
    expect(parseImageDataUrl(`data:image/gif;base64,${TINY_PNG_B64}`)?.mime).toBe('image/gif');
    // svg is scriptable — deliberately unsupported
    expect(parseImageDataUrl(`data:image/svg+xml;base64,${TINY_PNG_B64}`)).toBeNull();
    expect(parseImageDataUrl('data:text/plain;base64,aGVsbG8=')).toBeNull();
    expect(parseImageDataUrl('not a data url')).toBeNull();
    expect(parseImageDataUrl('data:image/png;base64,')).toBeNull();
    expect(parseImageDataUrl('data:image/png;base64,!!!invalid!!!')).toBeNull();
  });

  it('save → load → data URL round-trips the exact bytes', () => {
    const saved = saveTracked(TINY_PNG_DATA_URL);
    expect(saved.id).toMatch(/^att_[a-f0-9]{12}$/);
    expect(saved.mime).toBe('image/png');
    expect(saved.bytes).toBeGreaterThan(0);

    const loaded = loadChatAttachment(saved.id);
    expect(loaded?.mime).toBe('image/png');
    expect(loaded?.buffer.toString('base64')).toBe(TINY_PNG_B64);

    expect(attachmentAsDataUrl(saved.id)).toBe(TINY_PNG_DATA_URL);
  });

  it('rejects unsupported types and oversize payloads with plain-language errors', () => {
    expect(() => saveChatAttachment('data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=')).toThrow(/image\/png, image\/jpeg, image\/webp, or image\/gif/);
    // 9MB of zeros — over the 8MB cap after decode
    const big = `data:image/png;base64,${Buffer.alloc(9 * 1024 * 1024).toString('base64')}`;
    expect(() => saveChatAttachment(big)).toThrow(/8MB/);
  });

  it('loadChatAttachment refuses malformed ids (no path traversal surface)', () => {
    expect(loadChatAttachment('../../etc/passwd')).toBeNull();
    expect(loadChatAttachment('att_NOTHEX000000')).toBeNull();
    expect(loadChatAttachment('')).toBeNull();
    expect(loadChatAttachment('att_0123456789ab')).toBeNull(); // valid shape, no file
  });

  it('validateAttachmentIds: shape, existence, and per-message cap', () => {
    const saved = saveTracked(TINY_PNG_DATA_URL);

    expect(validateAttachmentIds(undefined)).toEqual({ ok: true, ids: [] });
    expect(validateAttachmentIds(null)).toEqual({ ok: true, ids: [] });
    expect(validateAttachmentIds([saved.id])).toEqual({ ok: true, ids: [saved.id] });

    expect(validateAttachmentIds('not-an-array').ok).toBe(false);
    expect(validateAttachmentIds(['bad id']).ok).toBe(false);
    expect(validateAttachmentIds(['att_ffffffffffff']).ok).toBe(false); // never uploaded

    const tooMany = Array(MAX_ATTACHMENTS_PER_MESSAGE + 1).fill(saved.id);
    const capped = validateAttachmentIds(tooMany);
    expect(capped.ok).toBe(false);
    if (!capped.ok) expect(capped.error).toContain(String(MAX_ATTACHMENTS_PER_MESSAGE));
  });
});

describe('vision content parts (dialect shaping)', () => {
  const withImage: LlmMessage[] = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'older question' },
    { role: 'assistant', content: 'older answer' },
    { role: 'user', content: 'what does this show?', images: [TINY_PNG_DATA_URL] },
  ];

  it('toResponsesInput: user message with images becomes input_text + input_image parts', () => {
    const { instructions, input } = toResponsesInput(withImage);
    expect(instructions).toBe('sys');
    // Older turns stay plain strings.
    expect(input[0]).toEqual({ role: 'user', content: 'older question' });
    expect(input[1]).toEqual({ role: 'assistant', content: 'older answer' });
    // Current turn: parts.
    expect(input[2].role).toBe('user');
    expect(input[2].content).toEqual([
      { type: 'input_text', text: 'what does this show?' },
      { type: 'input_image', image_url: TINY_PNG_DATA_URL },
    ]);
  });

  it('toWireMessages: user message with images becomes text + image_url parts; images never leak as a wire field', () => {
    const wire = toWireMessages({ dialect: 'openai' }, withImage);
    expect(wire[1].content).toBe('older question');
    expect(wire[3].content).toEqual([
      { type: 'text', text: 'what does this show?' },
      { type: 'image_url', image_url: { url: TINY_PNG_DATA_URL } },
    ]);
    for (const message of wire) expect('images' in message).toBe(false);
  });

  it('text-only messages keep plain string content on both dialects', () => {
    const textOnly: LlmMessage[] = [{ role: 'user', content: 'hello' }];
    expect(toResponsesInput(textOnly).input[0]).toEqual({ role: 'user', content: 'hello' });
    expect(toWireMessages({ dialect: 'openai' }, textOnly)[0].content).toBe('hello');
  });
});

describe('prompt log elision', () => {
  it('elides long image data URLs but keeps their length visible', () => {
    const longB64 = 'A'.repeat(5000);
    const body = { input: [{ role: 'user', content: [{ type: 'input_image', image_url: `data:image/png;base64,${longB64}` }] }] };
    const elided = elideImageDataUrls(body) as typeof body;
    const url = (elided.input[0].content[0] as any).image_url as string;
    expect(url).toContain('data:image-elided');
    expect(url).toContain('5022 chars'); // 22 prefix chars + 5000 base64
    expect(url.length).toBeLessThan(120);
  });

  it('leaves short data URLs and unrelated strings untouched', () => {
    const short = { text: `data:image/png;base64,${'A'.repeat(32)}`, other: 'https://example.com/image.png' };
    expect(elideImageDataUrls(short)).toEqual(short);
    const noImages = { messages: [{ role: 'user', content: 'plain' }] };
    expect(elideImageDataUrls(noImages)).toBe(noImages); // fast path: same reference
  });
});

describe('history payload', () => {
  it('getHistory maps attachments_json to id + servable URL and degrades safely', () => {
    const storage = createStorage(':memory:');
    storage.initialize();
    const db = storage.getDb();
    const chat = createChatInterface(db, {} as never);

    const insert = db.prepare('INSERT INTO chat_messages (id, role, content, attachments_json, created_at) VALUES (?, ?, ?, ?, ?)');
    insert.run('m1', 'user', 'with image', JSON.stringify(['att_0123456789ab']), '2026-09-05 10:00:00');
    insert.run('m2', 'assistant', 'reply', null, '2026-09-05 10:00:01');
    insert.run('m3', 'user', 'corrupt row', '{not json', '2026-09-05 10:00:02');

    const history = chat.getHistory(10);
    expect(history).toHaveLength(3);
    expect(history[0].attachments).toEqual([{ id: 'att_0123456789ab', url: '/api/chat/attachments/att_0123456789ab' }]);
    expect(history[1].attachments).toBeUndefined();
    expect(history[2].attachments).toBeUndefined(); // parse failure → text-only, not a crash

    storage.close();
  });
});
