import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createStorage, getSetting, type StorageLayer } from './storage.js';
import { GoogleApiError, type GmailClient, type GmailMessage, type GmailRawMessage } from './gmail-api.js';
import type { AttachmentPolicy } from './gmail-attachments.js';
import { GmailAuthError, type GmailConnection } from './gmail-connection.js';
import {
  GMAIL_COMPOSE_KEY,
  GmailComposeError,
  MAX_SENDS_PER_REQUEST,
  composeFailure,
  createGmailCompose,
  writeEffectOf,
  type GmailCompose,
} from './gmail-compose.js';
import { decodeMimeWords } from '../monitors/gmail-message.js';

/**
 * Gmail drafts and sends (GMAIL_CHAT_TOOLS_PLAN.md §7) against an in-memory
 * mailbox: what reaches Gmail, what the ledger remembers, and which failures
 * may be retried.
 */

function parseRaw(raw: string) {
  const text = Buffer.from(raw, 'base64url').toString('utf8');
  const at = text.indexOf('\r\n\r\n');
  const headers = text.slice(0, at).replace(/\r\n(?=[ \t])/g, '').split('\r\n').map(line => {
    const colon = line.indexOf(':');
    return { name: line.slice(0, colon), value: line.slice(colon + 1).trim() };
  });
  const body = Buffer.from(text.slice(at + 4).replace(/\r\n/g, ''), 'base64').toString('utf8');
  return { headers, body };
}

function headerOf(raw: string, name: string): string | undefined {
  return parseRaw(raw).headers.find(header => header.name.toLowerCase() === name.toLowerCase())?.value;
}

function messageFromRaw(id: string, threadId: string, raw: string, labelIds: string[]): GmailMessage {
  const parsed = parseRaw(raw);
  return {
    id,
    threadId,
    labelIds,
    payload: { mimeType: 'text/plain', headers: parsed.headers, body: { data: Buffer.from(parsed.body, 'utf8').toString('base64url'), size: parsed.body.length } },
  };
}

function headerLines(block: string) {
  return block.replace(/\r\n(?=[ \t])/g, '').split('\r\n').map(line => {
    const colon = line.indexOf(':');
    return { name: line.slice(0, colon), value: line.slice(colon + 1).trim() };
  });
}

/** An uploaded multipart/mixed message as Gmail parses it: the text part, then each file with its name and size. */
function messageFromUpload(id: string, threadId: string, bytes: Buffer, labelIds: string[]): GmailMessage {
  const text = bytes.toString('utf8');
  const at = text.indexOf('\r\n\r\n');
  const headers = headerLines(text.slice(0, at));
  const boundary = /boundary="([^"]+)"/.exec(headers.find(header => header.name === 'Content-Type')!.value)![1];
  const rest = text.slice(at + 4);
  const sections = rest.slice(`--${boundary}\r\n`.length, rest.lastIndexOf(`\r\n--${boundary}--`)).split(`\r\n--${boundary}\r\n`);
  const parts = sections.map((section, index) => {
    const split = section.indexOf('\r\n\r\n');
    const partHeaders = headerLines(section.slice(0, split));
    const content = Buffer.from(section.slice(split + 4).replace(/\r\n/g, ''), 'base64');
    const disposition = partHeaders.find(header => header.name === 'Content-Disposition')?.value ?? '';
    const filename = /filename="(.*)"$/.exec(disposition)?.[1];
    return {
      partId: String(index),
      mimeType: partHeaders.find(header => header.name === 'Content-Type')!.value.split(';')[0].trim(),
      filename: filename ? decodeMimeWords(filename.replace(/\\(.)/g, '$1')) : '',
      headers: partHeaders,
      body: filename ? { attachmentId: `a-${index}`, size: content.length } : { data: content.toString('base64url'), size: content.length },
    };
  });
  return { id, threadId, labelIds, payload: { mimeType: 'multipart/mixed', headers, parts } };
}

function messageFrom(id: string, threadId: string, message: GmailRawMessage, labelIds: string[]): GmailMessage {
  return 'rfc822' in message ? messageFromUpload(id, threadId, message.rfc822, labelIds) : messageFromRaw(id, threadId, message.raw, labelIds);
}

const via = (message: GmailRawMessage) => ('rfc822' in message ? ' upload' : '');

function received(id: string, threadId: string, headers: Record<string, string>, labelIds = ['INBOX']): GmailMessage {
  return { id, threadId, labelIds, payload: { mimeType: 'text/plain', headers: Object.entries(headers).map(([name, value]) => ({ name, value })) } };
}

const notFound = (what: string) => new GoogleApiError(`${what} failed (HTTP 404 notFound: Requested entity was not found.)`, 404, 'notFound');

function fakeGmail() {
  let counter = 0;
  const next = (prefix: string) => `${prefix}${++counter}`;
  const box = {
    sendAs: ['owner@gmail.com', 'me@alias.example'],
    messages: new Map<string, GmailMessage>(),
    drafts: new Map<string, GmailMessage>(),
    raws: new Map<string, string>(),
    /** Messages that came through the resumable upload (mail with attachments), by message id. */
    uploads: new Map<string, Buffer>(),
    calls: [] as string[],
    fail: new Map<string, unknown>(),
  };
  const keep = (id: string, message: GmailRawMessage) => {
    if ('rfc822' in message) box.uploads.set(id, message.rfc822);
    else box.raws.set(id, message.raw);
  };
  const failOnce = (name: string) => {
    if (!box.fail.has(name)) return;
    const error = box.fail.get(name);
    box.fail.delete(name);
    throw error;
  };
  const client: GmailClient = {
    async getProfile() { return { emailAddress: 'owner@gmail.com', historyId: '1' }; },
    async listMessages() { return { messages: [] }; },
    async getMessage(id, options) {
      box.calls.push(`getMessage ${id} ${options?.format ?? 'full'}`);
      failOnce('getMessage');
      const found = box.messages.get(id);
      if (!found) throw notFound('Gmail message');
      return found;
    },
    async getThread(id) { return { id, messages: [] }; },
    async listHistory() { return { records: [], historyId: '1' }; },
    async listSendAsAddresses() {
      box.calls.push('listSendAsAddresses');
      return box.sendAs;
    },
    async createDraft(message) {
      box.calls.push(`createDraft${via(message)}`);
      failOnce('createDraft');
      const draftId = next('r-');
      const draft = messageFrom(next('m'), message.threadId ?? next('t'), message, ['DRAFT']);
      box.drafts.set(draftId, draft);
      keep(draft.id, message);
      return { id: draftId, message: draft };
    },
    async updateDraft(draftId, message) {
      box.calls.push(`updateDraft ${draftId}${message.threadId ? ` thread ${message.threadId}` : ''}${via(message)}`);
      failOnce('updateDraft');
      const current = box.drafts.get(draftId);
      if (!current) throw notFound('Gmail draft update');
      const draft = messageFrom(next('m'), message.threadId ?? current.threadId, message, ['DRAFT']);
      box.drafts.set(draftId, draft);
      keep(draft.id, message);
      return { id: draftId, message: draft };
    },
    async getDraft(draftId) {
      box.calls.push(`getDraft ${draftId}`);
      failOnce('getDraft');
      const draft = box.drafts.get(draftId);
      if (!draft) throw notFound('Gmail draft');
      return { id: draftId, message: draft };
    },
    async deleteDraft(draftId) {
      box.calls.push(`deleteDraft ${draftId}`);
      if (!box.drafts.delete(draftId)) throw notFound('Gmail draft delete');
    },
    async sendDraft(draftId) {
      box.calls.push(`sendDraft ${draftId}`);
      failOnce('sendDraft');
      const draft = box.drafts.get(draftId);
      if (!draft) throw notFound('Gmail draft send');
      box.drafts.delete(draftId);
      const sent = { ...draft, id: next('m'), labelIds: ['SENT'] };
      box.messages.set(sent.id, sent);
      return sent;
    },
    async sendMessage(message) {
      box.calls.push(`sendMessage${message.threadId ? ` thread ${message.threadId}` : ''}${via(message)}`);
      failOnce('sendMessage');
      const sent = messageFrom(next('m'), message.threadId ?? next('t'), message, ['SENT']);
      box.messages.set(sent.id, sent);
      keep(sent.id, message);
      return sent;
    },
  };
  return { box, client };
}

describe('Gmail compose service', () => {
  let storage: StorageLayer;
  let gmail: ReturnType<typeof fakeGmail>;
  let state: { connected: boolean; account: string; canCompose: boolean; needsReconnect: boolean };
  let clock: number;
  let compose: GmailCompose;

  beforeEach(() => {
    storage = createStorage(':memory:');
    storage.initialize();
    gmail = fakeGmail();
    state = { connected: true, account: 'owner@gmail.com', canCompose: true, needsReconnect: false };
    clock = Date.parse('2026-10-06T09:00:00Z');
    const connection = {
      isConnected: () => state.connected,
      accountEmail: () => (state.connected ? state.account : null),
      canCompose: () => state.canCompose,
      status: () => ({ needsReconnect: state.needsReconnect }),
      client: () => gmail.client,
    } as unknown as GmailConnection;
    compose = createGmailCompose({ db: storage.getDb(), connection, now: () => clock });
  });
  afterEach(() => storage.close());

  async function failureOf(run: () => Promise<unknown>): Promise<GmailComposeError> {
    const error = await run().then(() => null, caught => caught);
    expect(error).toBeInstanceOf(GmailComposeError);
    return error as GmailComposeError;
  }

  const ledger = () => (getSetting<{ drafts: any[] }>(storage.getDb(), GMAIL_COMPOSE_KEY)?.drafts ?? []);
  const NEW = { to: ['Jane Doe <jane@x.com>'], cc: 'bob@x.com', subject: 'Plan for Friday', body: 'Hi Jane,\nShall we meet at noon?' };

  function seedThread() {
    gmail.box.messages.set('m-orig', received('m-orig', 't-orig', {
      From: 'Sam Lee <sam@x.com>',
      'Reply-To': 'Budget list <list@x.com>',
      To: 'owner@gmail.com, Ann <ann@x.com>',
      Cc: 'me@alias.example, Bob <bob@x.com>',
      Subject: '=?UTF-8?B?QnVkZ2V0IOKAlCBRNA==?=',
      'Message-ID': '<orig@mail.x>',
      References: '<root@mail.x>',
    }));
  }

  it('refuses before any Google call when Gmail is not connected, needs a reconnect, or may only read', async () => {
    state.connected = false;
    expect((await failureOf(() => compose.saveDraft(NEW))).code).toBe('not_connected');
    state.connected = true;
    state.needsReconnect = true;
    expect((await failureOf(() => compose.send(NEW, { ownerRequestId: 'req-1' }))).code).toBe('reconnect_required');
    state.needsReconnect = false;
    state.canCompose = false;
    const readOnly = await failureOf(() => compose.saveDraft(NEW));
    expect(readOnly).toMatchObject({ code: 'compose_not_granted', effect: 'none' });
    expect(readOnly.nextAction).toContain('Reconnect');
    expect(gmail.box.calls).toEqual([]);
  });

  it('drafts a new message with exact headers and records it in the ledger with its card token', async () => {
    const receipt = await compose.saveDraft(NEW);
    expect(receipt).toMatchObject({
      status: 'drafted', updated: false, draftId: 'r-1', account: 'owner@gmail.com',
      to: ['Jane Doe <jane@x.com>'], cc: ['bob@x.com'], bcc: [], subject: 'Plan for Friday', reply: false,
      card: '[[gmail-draft:r-1]]', gmailUrl: 'https://mail.google.com/mail/u/owner@gmail.com/#drafts',
    });
    const raw = gmail.box.raws.get(receipt.messageId)!;
    expect(headerOf(raw, 'To')).toBe('Jane Doe <jane@x.com>');
    expect(headerOf(raw, 'Cc')).toBe('bob@x.com');
    expect(headerOf(raw, 'From')).toBeUndefined();
    expect(parseRaw(raw).body).toBe('Hi Jane,\r\nShall we meet at noon?');
    expect(ledger()).toEqual([expect.objectContaining({ draftId: 'r-1', account: 'owner@gmail.com', messageId: receipt.messageId, state: 'draft', subject: 'Plan for Friday' })]);
    expect(gmail.box.calls).toEqual(['createDraft']);
  });

  it('reports every problem of a new message in one wave without calling Gmail', async () => {
    const error = await failureOf(() => compose.saveDraft({ to: ['nope', 'ok@x.com'], subject: '', body: '  ', replyAll: 'yes' }));
    expect(error.code).toBe('invalid_arguments');
    expect(error.issues.map(issue => issue.path).sort()).toEqual(['body', 'replyAll', 'subject', 'to[0]']);
    expect((await failureOf(() => compose.saveDraft({ subject: 'x', body: 'y' }))).issues).toEqual([{ path: 'to', message: 'at least one recipient is required' }]);
    expect((await failureOf(() => compose.saveDraft({ to: 'a@x.com', subject: 'x', body: 'y', replyToMessageId: '../etc' }))).issues[0].path).toBe('replyToMessageId');
    expect(gmail.box.calls).toEqual([]);
  });

  it('replies inside the thread: In-Reply-To, References, Re: subject, Reply-To first, and reply-all without the owner', async () => {
    seedThread();
    const receipt = await compose.saveDraft({ replyToMessageId: 'm-orig', replyAll: true, body: 'Agreed.' });
    // Reply-To replaces the sender; reply-all copies To + Cc without the owner's own addresses.
    expect(receipt).toMatchObject({ reply: true, threadId: 't-orig', to: ['Budget list <list@x.com>'], cc: ['Ann <ann@x.com>', 'Bob <bob@x.com>'], subject: 'Re: Budget — Q4' });
    const raw = gmail.box.raws.get(receipt.messageId)!;
    expect(headerOf(raw, 'In-Reply-To')).toBe('<orig@mail.x>');
    expect(headerOf(raw, 'References')!.split(/\s+/)).toEqual(['<root@mail.x>', '<orig@mail.x>']);
    expect(decodeMimeWords(headerOf(raw, 'Subject')!)).toBe('Re: Budget — Q4');
    expect(gmail.box.calls).toEqual(['listSendAsAddresses', 'getMessage m-orig metadata', 'createDraft']);
    expect(ledger()[0]).toMatchObject({ replyToMessageId: 'm-orig', threadId: 't-orig' });
  });

  it('answers the owner’s own message to its recipients and refuses a changed subject, a draft, or an unknown original', async () => {
    gmail.box.messages.set('m-mine', received('m-mine', 't-mine', { From: 'Me <owner@gmail.com>', To: 'Ann <ann@x.com>', Subject: 'Notes', 'Message-ID': '<mine@mail.x>' }, ['SENT']));
    expect((await compose.saveDraft({ replyToMessageId: 'm-mine', body: 'One more thing.' })).to).toEqual(['Ann <ann@x.com>']);

    const renamed = await failureOf(() => compose.saveDraft({ replyToMessageId: 'm-mine', subject: 'Something else', body: 'x' }));
    expect(renamed.issues).toEqual([expect.objectContaining({ path: 'subject' })]);
    // The same subject, with or without Re:, is fine.
    expect((await compose.saveDraft({ replyToMessageId: 'm-mine', subject: 'RE: notes', body: 'x' })).subject).toBe('Re: Notes');

    gmail.box.messages.set('m-draft', received('m-draft', 't-d', { Subject: 'x' }, ['DRAFT']));
    expect((await failureOf(() => compose.saveDraft({ replyToMessageId: 'm-draft', body: 'x' }))).issues[0]).toMatchObject({ path: 'replyToMessageId' });
    const missing = await failureOf(() => compose.saveDraft({ replyToMessageId: 'm-gone', body: 'x' }));
    expect(missing).toMatchObject({ code: 'not_found', effect: 'none' });
  });

  it('updates only BotBoy drafts, keeps their thread, and refuses foreign, finished, or vanished drafts', async () => {
    seedThread();
    const first = await compose.saveDraft({ replyToMessageId: 'm-orig', body: 'First try' });
    const second = await compose.saveDraft({ draftId: first.draftId, body: 'Second try' });
    expect(second).toMatchObject({ updated: true, draftId: first.draftId, threadId: 't-orig', subject: 'Re: Budget — Q4' });
    expect(second.messageId).not.toBe(first.messageId);
    expect(gmail.box.calls).toContain(`updateDraft ${first.draftId} thread t-orig`);
    expect(ledger()).toEqual([expect.objectContaining({ draftId: first.draftId, messageId: second.messageId, state: 'draft' })]);

    expect((await failureOf(() => compose.saveDraft({ draftId: 'r-999', body: 'x' }))).code).toBe('unknown_draft');
    gmail.box.drafts.delete(first.draftId);
    const vanished = await failureOf(() => compose.saveDraft({ draftId: first.draftId, body: 'x' }));
    expect(vanished).toMatchObject({ code: 'not_found' });
    expect(vanished.nextAction).toContain('without draftId');
    state.account = 'other@gmail.com';
    expect((await failureOf(() => compose.saveDraft({ draftId: first.draftId, body: 'x' }))).code).toBe('other_account');
  });

  it('sends once per owner request: a duplicate returns the first receipt, a new request may send again, the cap stops the sixth', async () => {
    const receipt = await compose.send(NEW, { ownerRequestId: 'req-1' });
    expect(receipt).toMatchObject({ status: 'sent', verified: true, via: 'chat', to: ['Jane Doe <jane@x.com>'], subject: 'Plan for Friday' });
    expect(receipt.labelIds).toContain('SENT');
    expect(receipt.gmailUrl).toBe(`https://mail.google.com/mail/u/owner@gmail.com/#all/${receipt.threadId}`);
    // Same message (cosmetic differences only), same request: no second send.
    const again = await compose.send({ ...NEW, to: ['jane@X.com'], body: `${NEW.body}\n\n` }, { ownerRequestId: 'req-1' });
    expect(again).toMatchObject({ alreadySent: true, messageId: receipt.messageId });
    expect(gmail.box.calls.filter(call => call.startsWith('sendMessage'))).toHaveLength(1);

    for (let index = 2; index <= MAX_SENDS_PER_REQUEST; index++) {
      await compose.send({ ...NEW, body: `Message ${index}` }, { ownerRequestId: 'req-1' });
    }
    const capped = await failureOf(() => compose.send({ ...NEW, body: 'One too many' }, { ownerRequestId: 'req-1' }));
    expect(capped).toMatchObject({ code: 'send_cap_reached', effect: 'none' });
    expect(gmail.box.calls.filter(call => call.startsWith('sendMessage'))).toHaveLength(MAX_SENDS_PER_REQUEST);
    expect((await compose.send({ ...NEW, body: 'One too many' }, { ownerRequestId: 'req-2' })).alreadySent).toBeUndefined();
  });

  it('lets a rejected send be fixed and retried, but never resends one Gmail did not answer', async () => {
    gmail.box.fail.set('sendMessage', new GoogleApiError('Gmail send failed (HTTP 400 invalidArgument: Invalid To header)', 400, 'invalidArgument'));
    const rejected = await failureOf(() => compose.send(NEW, { ownerRequestId: 'req-1' }));
    expect(rejected).toMatchObject({ code: 'google_error', effect: 'none' });
    expect((await compose.send(NEW, { ownerRequestId: 'req-1' })).status).toBe('sent');

    gmail.box.fail.set('sendMessage', new GoogleApiError('Gmail send timed out after 30s', 0, 'timeout'));
    const lost = { ...NEW, body: 'Lost in transit' };
    const unknown = await failureOf(() => compose.send(lost, { ownerRequestId: 'req-1' }));
    expect(unknown).toMatchObject({ code: 'send_unknown_effect', effect: 'unknown' });
    expect(unknown.nextAction).toMatch(/Do NOT send again/);
    const sendsBefore = gmail.box.calls.filter(call => call.startsWith('sendMessage')).length;
    expect((await failureOf(() => compose.send(lost, { ownerRequestId: 'req-1' }))).code).toBe('send_unknown_effect');
    expect(gmail.box.calls.filter(call => call.startsWith('sendMessage'))).toHaveLength(sendsBefore);
  });

  it('classifies write effects: only a request Google never processed is none', () => {
    const network = (code: string) => new GoogleApiError('Gmail send failed: network error', 0, 'network', code);
    expect(writeEffectOf(network('ENOTFOUND'))).toBe('none');
    expect(writeEffectOf(network('ECONNREFUSED'))).toBe('none');
    expect(writeEffectOf(network('ECONNRESET'))).toBe('unknown');
    expect(writeEffectOf(new GoogleApiError('x', 0, 'network'))).toBe('unknown');
    expect(writeEffectOf(new GoogleApiError('x', 0, 'timeout'))).toBe('unknown');
    expect(writeEffectOf(new GoogleApiError('x', 503, 'backendError'))).toBe('unknown');
    expect(writeEffectOf(new GoogleApiError('x', 408, 'http_408'))).toBe('unknown');
    expect(writeEffectOf(new GoogleApiError('x', 200, 'unreadable_response'))).toBe('unknown');
    expect(writeEffectOf(new GoogleApiError('x', 429, 'rateLimitExceeded'))).toBe('none');
    expect(writeEffectOf(new GmailAuthError('gone', 'reconnect_required'))).toBe('none');
    expect(writeEffectOf(new Error('surprise'))).toBe('unknown');

    expect(composeFailure(new GoogleApiError('x', 403, 'insufficientPermissions'), 'none', 'Send').code).toBe('compose_not_granted');
    expect(composeFailure(new GoogleApiError('x', 429, 'rateLimitExceeded'), 'none', 'Send').code).toBe('rate_limited');
    expect(composeFailure(new GoogleApiError('x', 403, 'userRateLimitExceeded'), 'none', 'Send').code).toBe('rate_limited');
    expect(composeFailure(new GmailAuthError('gone', 'reconnect_required'), 'none', 'Send').code).toBe('reconnect_required');
    expect(composeFailure(new GoogleApiError('x', 503, 'backendError'), 'unknown', 'Send')).toMatchObject({ code: 'send_unknown_effect', effect: 'unknown' });
  });

  it('sends a BotBoy draft by id alone, once, and reports an already-sent draft without resending', async () => {
    const draft = await compose.saveDraft(NEW);
    const mixed = await failureOf(() => compose.send({ draftId: draft.draftId, body: 'changed' }, { ownerRequestId: 'req-1' }));
    expect(mixed.issues).toEqual([{ path: 'body', message: expect.stringContaining('call gmail_draft with the draftId first') }]);

    const sent = await compose.send({ draftId: draft.draftId }, { ownerRequestId: 'req-1' });
    expect(sent).toMatchObject({ status: 'sent', fromDraftId: draft.draftId, verified: true, to: ['Jane Doe <jane@x.com>'], subject: 'Plan for Friday' });
    expect(ledger()[0]).toMatchObject({ state: 'sent', sentMessageId: sent.messageId, via: 'chat' });

    const again = await compose.send({ draftId: draft.draftId }, { ownerRequestId: 'req-2' });
    expect(again).toMatchObject({ alreadySent: true, messageId: sent.messageId });
    expect(gmail.box.calls.filter(call => call.startsWith('sendDraft'))).toHaveLength(1);
    expect((await failureOf(() => compose.saveDraft({ draftId: draft.draftId, body: 'x' }))).code).toBe('draft_not_open');
  });

  it('card: shows the exact draft and sends only the version shown', async () => {
    const draft = await compose.saveDraft(NEW);
    const view = await compose.viewDraft(draft.draftId);
    expect(view).toMatchObject({
      state: 'draft', messageId: draft.messageId, to: ['Jane Doe <jane@x.com>'], cc: ['bob@x.com'], subject: 'Plan for Friday',
      body: 'Hi Jane,\nShall we meet at noon?', bodyTruncated: false,
    });

    const changed = await compose.saveDraft({ ...NEW, draftId: draft.draftId, body: 'Changed my mind.' });
    const stale = await failureOf(() => compose.sendDraftFromCard(draft.draftId, view.messageId!));
    expect(stale.code).toBe('draft_changed');
    expect((stale.detail?.view as any)).toMatchObject({ messageId: changed.messageId, body: 'Changed my mind.' });
    expect(gmail.box.calls.some(call => call.startsWith('sendDraft'))).toBe(false);

    const sent = await compose.sendDraftFromCard(draft.draftId, changed.messageId);
    expect(sent).toMatchObject({ status: 'sent', via: 'card', fromDraftId: draft.draftId });
    const after = await compose.viewDraft(draft.draftId);
    expect(after).toMatchObject({ state: 'sent', sentMessageId: sent.messageId, sentAt: '2026-10-06T09:00:00.000Z' });
    expect(after.gmailUrl).toBe(`https://mail.google.com/mail/u/owner@gmail.com/#all/${after.threadId}`);
    // The ledger answers; Gmail is not asked again.
    expect(gmail.box.calls.filter(call => call === `getDraft ${draft.draftId}`)).toHaveLength(3);
  });

  it('card: one send at a time, and an unanswered send stays blocked until Gmail settles', async () => {
    const draft = await compose.saveDraft(NEW);
    const original = gmail.client.sendDraft;
    let release!: () => void;
    gmail.client.sendDraft = (id) => new Promise(resolve => { release = () => resolve(original(id)); });
    const first = compose.sendDraftFromCard(draft.draftId, draft.messageId);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect((await failureOf(() => compose.sendDraftFromCard(draft.draftId, draft.messageId))).code).toBe('send_in_progress');
    expect((await failureOf(() => compose.send({ draftId: draft.draftId }, { ownerRequestId: 'req-1' }))).code).toBe('send_in_progress');
    release();
    expect((await first).status).toBe('sent');
    gmail.client.sendDraft = original;

    const next = await compose.saveDraft({ ...NEW, body: 'Second draft' });
    gmail.box.fail.set('sendDraft', new GoogleApiError('Gmail draft send timed out after 30s', 0, 'timeout'));
    const unknown = await failureOf(() => compose.sendDraftFromCard(next.draftId, next.messageId));
    expect(unknown).toMatchObject({ code: 'send_unknown_effect', effect: 'unknown' });
    expect(ledger().find(entry => entry.draftId === next.draftId)).toMatchObject({ state: 'send_unknown' });
    expect((await compose.viewDraft(next.draftId)).state).toBe('send_unknown');
    expect((await failureOf(() => compose.sendDraftFromCard(next.draftId, next.messageId))).code).toBe('send_unknown_effect');
    expect((await failureOf(() => compose.send({ draftId: next.draftId }, { ownerRequestId: 'req-1' }))).code).toBe('send_unknown_effect');

    // Still in Drafts after the settle window: that send never happened.
    clock += 121_000;
    expect((await compose.viewDraft(next.draftId)).state).toBe('draft');
    expect((await compose.sendDraftFromCard(next.draftId, next.messageId)).status).toBe('sent');
  });

  it('card: an unanswered send whose draft vanished reads as missing, not as resendable', async () => {
    const draft = await compose.saveDraft(NEW);
    gmail.box.fail.set('sendDraft', new GoogleApiError('Gmail draft send failed: network error (ECONNRESET)', 0, 'network', 'ECONNRESET'));
    await failureOf(() => compose.sendDraftFromCard(draft.draftId, draft.messageId));
    gmail.box.drafts.delete(draft.draftId);
    expect((await compose.viewDraft(draft.draftId))).toMatchObject({ state: 'missing', gmailUrl: 'https://mail.google.com/mail/u/owner@gmail.com/#sent' });
  });

  it('card: discards only the version shown and then answers from the ledger', async () => {
    const draft = await compose.saveDraft(NEW);
    const changed = await compose.saveDraft({ ...NEW, draftId: draft.draftId, body: 'v2' });
    expect((await failureOf(() => compose.discardDraft(draft.draftId, draft.messageId))).code).toBe('draft_changed');
    expect(gmail.box.drafts.has(draft.draftId)).toBe(true);
    expect(await compose.discardDraft(draft.draftId, changed.messageId)).toMatchObject({ state: 'discarded' });
    expect(gmail.box.drafts.has(draft.draftId)).toBe(false);
    const calls = gmail.box.calls.length;
    expect((await compose.viewDraft(draft.draftId)).state).toBe('discarded');
    expect(gmail.box.calls).toHaveLength(calls);
    expect((await failureOf(() => compose.sendDraftFromCard(draft.draftId, changed.messageId))).code).toBe('draft_not_open');
  });

  it('views unknown ids, another account, and a disconnected Gmail without asking Google', async () => {
    const draft = await compose.saveDraft(NEW);
    const calls = gmail.box.calls.length;
    expect((await compose.viewDraft('r-404')).state).toBe('unknown');
    expect((await compose.viewDraft('../bad')).state).toBe('unknown');
    state.account = 'other@gmail.com';
    expect(await compose.viewDraft(draft.draftId)).toMatchObject({ state: 'other_account', account: 'owner@gmail.com', gmailUrl: null });
    state.connected = false;
    expect((await compose.viewDraft(draft.draftId)).state).toBe('not_connected');
    expect(gmail.box.calls).toHaveLength(calls);
  });

  it('keeps the newest 200 drafts in the ledger', async () => {
    for (let index = 0; index < 205; index++) await compose.saveDraft({ ...NEW, body: `Draft ${index}` });
    const entries = ledger();
    expect(entries).toHaveLength(200);
    // The fake numbers draft k as r-(1 + 3k): the five oldest (r-1 … r-13) are gone.
    expect(entries[0].draftId).toBe('r-16');
    expect((await compose.viewDraft('r-1')).state).toBe('unknown');
  });
});

/**
 * Drafts and sends with files (GMAIL_CHAT_TOOLS_PLAN.md §13): what reaches
 * Gmail through the upload path, what the ledger keeps, and what is refused.
 */
describe('Gmail compose with attachments', () => {
  const IMAGE = `va_${'d'.repeat(32)}`;
  const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
  const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
  let storage: StorageLayer;
  let gmail: ReturnType<typeof fakeGmail>;
  let compose: GmailCompose;
  let home: string;
  let clock: number;

  function write(relative: string, content: string | Buffer): string {
    const target = path.join(home, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
    return target;
  }

  beforeEach(() => {
    storage = createStorage(':memory:');
    storage.initialize();
    gmail = fakeGmail();
    clock = Date.parse('2026-10-06T09:00:00Z');
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'gmail-compose-files-'));
    const privateRoot = path.join(home, '.personal-productivity-tracker');
    fs.mkdirSync(path.join(privateRoot, 'files'), { recursive: true });
    const policy: AttachmentPolicy = {
      homeDir: home,
      privateRoot,
      filesDir: path.join(privateRoot, 'files'),
      images: {
        readOriginal(assetId: string, versionId?: string) {
          if (assetId !== IMAGE || (versionId && versionId !== `vav_${'d'.repeat(32)}`)) throw new Error('VISUAL_ASSET_NOT_FOUND');
          return {
            record: { assetId, versionId: `vav_${'d'.repeat(32)}`, ordinal: 1, sha256: sha(PNG), bytes: PNG.length, mime: 'image/png', width: 1, height: 1, ownerKind: 'chat_attachment', originalUrl: '', createdAt: '' },
            buffer: PNG,
          };
        },
      },
    };
    const connection = {
      isConnected: () => true,
      accountEmail: () => 'owner@gmail.com',
      canCompose: () => true,
      status: () => ({ needsReconnect: false }),
      client: () => gmail.client,
    } as unknown as GmailConnection;
    compose = createGmailCompose({ db: storage.getDb(), connection, now: () => clock, attachments: policy });
  });
  afterEach(() => {
    storage.close();
    fs.rmSync(home, { recursive: true, force: true });
  });

  async function failureOf(run: () => Promise<unknown>): Promise<GmailComposeError> {
    const error = await run().then(() => null, caught => caught);
    expect(error).toBeInstanceOf(GmailComposeError);
    return error as GmailComposeError;
  }
  const ledger = () => (getSetting<{ drafts: any[] }>(storage.getDb(), GMAIL_COMPOSE_KEY)?.drafts ?? []);
  const NEW = { to: ['Jane Doe <jane@x.com>'], subject: 'Q3 report', body: 'Hi Jane,\nThe report is attached.' };
  const filesOf = (message: GmailMessage) => (message.payload?.parts ?? []).filter(part => part.filename).map(part => [part.filename, part.mimeType, part.body?.size]);

  it('drafts with files through the upload: Gmail holds the text and each file, the ledger keeps their sources, the card lists them', async () => {
    const pdf = write('Documents/report.pdf', '%PDF-1.4 synthetic report');
    const receipt = await compose.saveDraft({ ...NEW, attachments: [{ path: pdf }, { assetId: IMAGE, name: 'Chart.png' }] });
    expect(gmail.box.calls).toEqual(['createDraft upload']);
    expect(receipt.attachments).toEqual([
      { name: 'report.pdf', mimeType: 'application/pdf', sizeBytes: 25, sha256: sha(Buffer.from('%PDF-1.4 synthetic report')), from: fs.realpathSync.native(pdf) },
      { name: 'Chart.png', mimeType: 'image/png', sizeBytes: PNG.length, sha256: sha(PNG), from: IMAGE },
    ]);

    const held = gmail.box.drafts.get(receipt.draftId)!;
    expect(filesOf(held)).toEqual([['report.pdf', 'application/pdf', 25], ['Chart.png', 'image/png', PNG.length]]);
    const textPart = held.payload!.parts![0];
    expect(Buffer.from(textPart.body!.data!, 'base64url').toString('utf8')).toBe('Hi Jane,\r\nThe report is attached.');
    const uploaded = gmail.box.uploads.get(receipt.messageId)!.toString('utf8');
    expect(uploaded).toContain(Buffer.from('%PDF-1.4 synthetic report').toString('base64'));

    expect(ledger()[0].attachments).toEqual([
      { name: 'report.pdf', mimeType: 'application/pdf', sizeBytes: 25, sha256: sha(Buffer.from('%PDF-1.4 synthetic report')), source: { kind: 'file', path: fs.realpathSync.native(pdf) } },
      { name: 'Chart.png', mimeType: 'image/png', sizeBytes: PNG.length, sha256: sha(PNG), source: { kind: 'image', assetId: IMAGE, versionId: `vav_${'d'.repeat(32)}` } },
    ]);
    expect((await compose.viewDraft(receipt.draftId)).attachments).toEqual([
      { name: 'report.pdf', mimeType: 'application/pdf', sizeBytes: 25 },
      { name: 'Chart.png', mimeType: 'image/png', sizeBytes: PNG.length },
    ]);
    // Text-only mail keeps the JSON raw path.
    await compose.saveDraft(NEW);
    expect(gmail.box.calls.at(-1)).toBe('createDraft');
  });

  it('an update attaches the draft’s files again while their bytes are unchanged, [] drops them, a changed file is an issue', async () => {
    const notes = write('Documents/notes.txt', 'version 1');
    const first = await compose.saveDraft({ ...NEW, attachments: [{ path: notes }] });
    const second = await compose.saveDraft({ draftId: first.draftId, ...NEW, body: 'Updated text.' });
    expect(gmail.box.calls.at(-1)).toBe(`updateDraft ${first.draftId} upload`);
    expect(second.attachments.map(file => file.name)).toEqual(['notes.txt']);
    expect(filesOf(gmail.box.drafts.get(first.draftId)!)).toEqual([['notes.txt', 'text/plain', 9]]);

    fs.writeFileSync(notes, 'version 2, edited after the draft');
    const calls = gmail.box.calls.length;
    const changed = await failureOf(() => compose.saveDraft({ draftId: first.draftId, ...NEW, body: 'Again.' }));
    expect(changed).toMatchObject({ code: 'invalid_arguments', effect: 'none' });
    expect(changed.issues).toEqual([{ path: 'attachments', message: 'notes.txt (attached to the draft before) changed since the draft was saved; pass attachments again to attach the current files, or [] for none' }]);
    expect(gmail.box.calls).toHaveLength(calls);
    // Passing the file again attaches the current version.
    const current = await compose.saveDraft({ draftId: first.draftId, ...NEW, attachments: [{ path: notes }] });
    expect(current.attachments[0]).toMatchObject({ name: 'notes.txt', sizeBytes: 33 });

    const cleared = await compose.saveDraft({ draftId: first.draftId, ...NEW, attachments: [] });
    expect(gmail.box.calls.at(-1)).toBe(`updateDraft ${first.draftId}`);
    expect(cleared.attachments).toEqual([]);
    expect(ledger()[0].attachments).toBeUndefined();
    expect((await compose.viewDraft(first.draftId)).attachments).toEqual([]);
  });

  it('refuses files BotBoy will not email before any Google call, naming each one with every other problem', async () => {
    write('.ssh/id_rsa', 'key');
    const refused = await failureOf(() => compose.saveDraft({ ...NEW, attachments: [{ path: '~/.ssh/id_rsa' }, { path: '~/Documents/missing.pdf' }] }));
    expect(refused).toMatchObject({ code: 'attachment_not_allowed', effect: 'none', message: 'BotBoy will not email this file.' });
    expect(refused.issues).toEqual([
      { path: 'attachments[0].path', message: 'Stored with SSH keys (.ssh): BotBoy never emails credentials or keys' },
      { path: 'attachments[1].path', message: 'no file at this path; use the exact path the owner gave or a tool returned' },
    ]);
    expect(refused.nextAction).toMatch(/Tell the owner which file BotBoy will not email/);
    const send = await failureOf(() => compose.send({ ...NEW, attachments: [{ path: '~/.ssh/id_rsa' }] }, { ownerRequestId: 'req-1' }));
    expect(send.code).toBe('attachment_not_allowed');
    // Fixable mistakes alone stay invalid_arguments.
    expect((await failureOf(() => compose.saveDraft({ ...NEW, attachments: [{ path: '~/Documents/missing.pdf' }] }))).code).toBe('invalid_arguments');
    expect(gmail.box.calls).toEqual([]);
  });

  it('sends with files once per owner request: the files are part of the message identity', async () => {
    const a = write('Documents/a.csv', 'x,1\n');
    const b = write('Documents/b.csv', 'y,2\n');
    const sent = await compose.send({ ...NEW, attachments: [{ path: a }] }, { ownerRequestId: 'req-1' });
    expect(sent).toMatchObject({ status: 'sent', verified: true, attachments: [{ name: 'a.csv', mimeType: 'text/csv', sizeBytes: 4 }] });
    expect(filesOf(gmail.box.messages.get(sent.messageId)!)).toEqual([['a.csv', 'text/csv', 4]]);
    expect((await compose.send({ ...NEW, attachments: [{ path: a }] }, { ownerRequestId: 'req-1' })).alreadySent).toBe(true);
    const other = await compose.send({ ...NEW, attachments: [{ path: b }] }, { ownerRequestId: 'req-1' });
    expect(other.alreadySent).toBeUndefined();
    expect(other.messageId).not.toBe(sent.messageId);
    expect(gmail.box.calls.filter(call => call === 'sendMessage upload')).toHaveLength(2);
  });

  it('follows the upload’s own effect: a session that never held the message may be retried, an unanswered one never is', async () => {
    const a = write('Documents/a.csv', 'x,1\n');
    gmail.box.fail.set('sendMessage', new GoogleApiError('Gmail send timed out after 30s', 0, 'timeout', undefined, 'none'));
    const notSent = await failureOf(() => compose.send({ ...NEW, attachments: [{ path: a }] }, { ownerRequestId: 'req-1' }));
    expect(notSent).toMatchObject({ code: 'google_error', effect: 'none' });
    expect((await compose.send({ ...NEW, attachments: [{ path: a }] }, { ownerRequestId: 'req-1' })).status).toBe('sent');

    gmail.box.fail.set('sendMessage', new GoogleApiError('Gmail send failed (HTTP 400 failedPrecondition)', 400, 'failedPrecondition', undefined, 'unknown'));
    const lost = { ...NEW, body: 'Second message', attachments: [{ path: a }] };
    expect(await failureOf(() => compose.send(lost, { ownerRequestId: 'req-1' }))).toMatchObject({ code: 'send_unknown_effect', effect: 'unknown' });
    expect((await failureOf(() => compose.send(lost, { ownerRequestId: 'req-1' }))).code).toBe('send_unknown_effect');
    expect(writeEffectOf(new GoogleApiError('x', 0, 'timeout', undefined, 'none'))).toBe('none');
    expect(writeEffectOf(new GoogleApiError('x', 400, 'invalidArgument', undefined, 'unknown'))).toBe('unknown');

    gmail.box.fail.set('createDraft', new GoogleApiError('Gmail draft create failed: network error (ECONNRESET)', 0, 'network', 'ECONNRESET', 'unknown'));
    expect(await failureOf(() => compose.saveDraft({ ...NEW, attachments: [{ path: a }] }))).toMatchObject({ code: 'draft_unknown_effect', effect: 'unknown' });
  });

  it('sends a draft with its own files only, and its card lists what Gmail sent', async () => {
    const a = write('Documents/a.csv', 'x,1\n');
    const draft = await compose.saveDraft({ ...NEW, attachments: [{ path: a }] });
    const mixed = await failureOf(() => compose.send({ draftId: draft.draftId, attachments: [{ path: a }] }, { ownerRequestId: 'req-1' }));
    expect(mixed.issues).toEqual([{ path: 'attachments', message: expect.stringContaining('send a draft by draftId alone') }]);

    // The owner removed the file in Gmail before pressing Send: the card shows what went out.
    const held = gmail.box.drafts.get(draft.draftId)!;
    held.payload = { ...held.payload, parts: held.payload!.parts!.filter(part => !part.filename) };
    const sent = await compose.sendDraftFromCard(draft.draftId, draft.messageId);
    expect(sent.attachments).toEqual([]);
    expect(ledger()[0]).toMatchObject({ state: 'sent', sentAttachments: [] });
    expect((await compose.viewDraft(draft.draftId))).toMatchObject({ state: 'sent', attachments: [] });

    const kept = await compose.saveDraft({ ...NEW, attachments: [{ path: a }] });
    await compose.send({ draftId: kept.draftId }, { ownerRequestId: 'req-2' });
    expect((await compose.viewDraft(kept.draftId)).attachments).toEqual([{ name: 'a.csv', mimeType: 'text/csv', sizeBytes: 4 }]);
    // An already-sent draft's receipt names its files too.
    expect((await compose.send({ draftId: kept.draftId }, { ownerRequestId: 'req-3' })).attachments).toEqual([{ name: 'a.csv', mimeType: 'text/csv', sizeBytes: 4 }]);
  });
});
