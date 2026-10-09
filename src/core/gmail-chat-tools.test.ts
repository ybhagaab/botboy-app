import { describe, expect, it, vi } from 'vitest';
import type { ToolCall } from './llm-client.js';
import type { ToolExecutionContext, ToolExecutor } from './tool-executor.js';
import { GoogleApiError, type GmailClient, type GmailMessage, type GmailMessagePart } from './gmail-api.js';
import { fakeGmailConnection } from './gmail-connection.fake.js';
import { GmailComposeError, type GmailCompose } from './gmail-compose.js';
import { GMAIL_CHAT_TOOL_NAMES, gmailDraftIdFromResult, gmailWriteConfirmed, withGmailChatTools } from './gmail-chat-tools.js';

/**
 * Gmail chat tools (GMAIL_CHAT_TOOLS_PLAN.md §2, §5–7): who may call them,
 * what the model sees from the live mailbox, and how failures read.
 */

const OWNER: ToolExecutionContext = { callerKind: 'interactive', currentUserMessage: 'email Jane that I will be late', ownerRequestId: 'req-00000001' };

function call(name: string, args: unknown, id = 'call-1'): ToolCall {
  return { id, type: 'function', function: { name, arguments: typeof args === 'string' ? args : JSON.stringify(args) } } as ToolCall;
}

function b64(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64url');
}

function mail(id: string, threadId: string, headers: Record<string, string>, body: string, extra: Partial<GmailMessage> = {}, parts?: GmailMessagePart[]): GmailMessage {
  return {
    id,
    threadId,
    labelIds: ['INBOX', 'UNREAD', 'Label_42', 'CATEGORY_UPDATES'],
    snippet: 'It&#39;s on &amp; ready',
    internalDate: String(Date.parse('2026-10-06T08:00:00Z')),
    payload: parts
      ? { mimeType: 'multipart/mixed', headers: Object.entries(headers).map(([name, value]) => ({ name, value })), parts }
      : { mimeType: 'text/plain', headers: Object.entries(headers).map(([name, value]) => ({ name, value })), body: { data: b64(body), size: body.length } },
    ...extra,
  };
}

function harness(options: { connected?: boolean; needsReconnect?: boolean } = {}) {
  const messages = new Map<string, GmailMessage>();
  const threads = new Map<string, GmailMessage[]>();
  const listCalls: Array<Record<string, unknown>> = [];
  const getCalls: string[] = [];
  let listResult: { messages: Array<{ id: string; threadId?: string }>; nextPageToken?: string; resultSizeEstimate?: number } = { messages: [] };
  const client = {
    async listMessages(input: Record<string, unknown>) { listCalls.push(input); return listResult; },
    async getMessage(id: string, opts?: { format?: string }) {
      getCalls.push(`${id}:${opts?.format}`);
      const found = messages.get(id);
      if (!found) throw new GoogleApiError('Gmail message failed (HTTP 404 notFound)', 404, 'notFound');
      return found;
    },
    async getThread(id: string) {
      const found = threads.get(id);
      if (!found) throw new GoogleApiError('Gmail thread failed (HTTP 404 notFound)', 404, 'notFound');
      return { id, messages: found };
    },
  } as unknown as GmailClient;
  const connection = fakeGmailConnection([{
    id: 'default', email: 'owner@gmail.com', connected: options.connected !== false, needsReconnect: options.needsReconnect === true, client,
  }]);
  const compose = {
    saveDraft: vi.fn(async (args: Record<string, unknown>) => ({
      status: 'drafted', updated: false, draftId: 'r-7', messageId: 'm-7', threadId: 't-7', account: 'owner@gmail.com',
      to: ['Jane <jane@x.com>'], cc: [], bcc: [], subject: String(args.subject ?? ''), bodyChars: 5, reply: false,
      card: '[[gmail-draft:r-7]]', gmailUrl: 'https://mail.google.com/mail/u/owner@gmail.com/#drafts',
    })),
    send: vi.fn(async () => ({
      status: 'sent', messageId: 'm-9', threadId: 't-9', account: 'owner@gmail.com', to: ['Jane <jane@x.com>'], cc: [], bcc: [],
      subject: 'Late', labelIds: ['SENT'], verified: true, sentAt: '2026-10-06T09:00:00.000Z', via: 'chat',
      gmailUrl: 'https://mail.google.com/mail/u/owner@gmail.com/#all/t-9',
    })),
  } as unknown as GmailCompose & { saveDraft: ReturnType<typeof vi.fn>; send: ReturnType<typeof vi.fn> };
  const base: ToolExecutor = { executeTool: vi.fn(async (toolCall: ToolCall) => ({ toolCallId: toolCall.id, content: 'base-result' })) };
  const tools = withGmailChatTools(base, { connection, compose, now: () => Date.parse('2026-10-06T09:00:00Z') });
  return {
    tools, base, compose, messages, threads, listCalls, getCalls,
    setList(value: typeof listResult) { listResult = value; },
  };
}

/** `context: null` runs with no context at all (a default parameter would replace `undefined`). */
async function run(h: ReturnType<typeof harness>, name: string, args: unknown, context: ToolExecutionContext | null = OWNER) {
  const result = await h.tools.executeTool(call(name, args), context ?? undefined);
  return { result, body: JSON.parse(result.content) };
}

describe('Gmail chat tool authority', () => {
  it('passes every other tool to the base executor untouched', async () => {
    const h = harness();
    const result = await h.tools.executeTool(call('query_db', { sql: 'SELECT 1' }), OWNER);
    expect(result.content).toBe('base-result');
    expect(h.base.executeTool).toHaveBeenCalledOnce();
  });

  it('refuses every Gmail tool outside the owner’s live chat turn', async () => {
    const h = harness();
    const outside: Array<ToolExecutionContext | null> = [
      null,
      { callerKind: 'background', currentUserMessage: 'organize the inbox', ownerRequestId: 'req-00000001' },
      { callerKind: 'interactive', currentUserMessage: '   ', ownerRequestId: 'req-00000001' },
      { currentUserMessage: 'hi', ownerRequestId: 'req-00000001' },
    ];
    for (const name of GMAIL_CHAT_TOOL_NAMES) {
      for (const context of outside) {
        const { result, body } = await run(h, name, { query: 'x', messageId: 'm1', body: 'x', to: ['a@x.com'], subject: 's', ownerRequested: true }, context);
        expect(result.isError).toBe(true);
        expect(body).toMatchObject({ ok: false, tool: name, code: 'owner_turn_required', effect: 'none' });
        expect(body.nextAction).toMatch(/background/);
      }
    }
    expect(h.listCalls).toEqual([]);
    expect(h.getCalls).toEqual([]);
    expect(h.compose.saveDraft).not.toHaveBeenCalled();
    expect(h.compose.send).not.toHaveBeenCalled();
  });

  it('requires the server request id and ownerRequested=true for drafts and sends, but not for reads', async () => {
    const h = harness();
    const args = { to: ['jane@x.com'], subject: 'Late', body: 'Running late.' };
    const denied: Array<[ToolExecutionContext, unknown]> = [
      [{ ...OWNER, ownerRequestId: undefined }, true],
      [OWNER, undefined],
      [OWNER, false],
      [OWNER, 'true'],
    ];
    for (const name of ['gmail_draft', 'gmail_send']) {
      for (const [context, ownerRequested] of denied) {
        const { body } = await run(h, name, { ...args, ownerRequested }, context);
        expect(body).toMatchObject({ code: 'owner_request_required', effect: 'none' });
      }
    }
    expect(h.compose.saveDraft).not.toHaveBeenCalled();
    expect(h.compose.send).not.toHaveBeenCalled();

    expect((await run(h, 'gmail_draft', { ...args, ownerRequested: true })).body).toMatchObject({ ok: true, status: 'drafted' });
    expect((await run(h, 'gmail_send', { ...args, ownerRequested: true })).body).toMatchObject({ ok: true, status: 'sent' });
    expect(h.compose.send).toHaveBeenCalledWith(expect.objectContaining({ to: ['jane@x.com'] }), { ownerRequestId: 'req-00000001' });

    // Reads need the live turn only.
    const reads = await run(h, 'gmail_search', { query: 'from:jane' }, { callerKind: 'interactive', currentUserMessage: 'any mail from Jane?' });
    expect(reads.body.trust).toBe('external_untrusted_data');
  });

  it('lets a task the owner started search and read live mail, but never draft or send', async () => {
    const h = harness();
    h.messages.set('m1', mail('m1', 't1', { From: 'sam@x.com', To: 'owner@gmail.com', Subject: 'Numbers' }, 'Q4 is 12% up.'));
    h.setList({ messages: [{ id: 'm1' }] });
    const ownerRun: ToolExecutionContext = { callerKind: 'background', ownerStartedRun: true, currentUserMessage: 'Rewrite this passage using Sam’s latest numbers.' };

    expect((await run(h, 'gmail_search', { query: 'from:sam' }, ownerRun)).body).toMatchObject({ trust: 'external_untrusted_data', result: { results: [{ messageId: 'm1' }] } });
    expect((await run(h, 'gmail_read', { messageId: 'm1' }, ownerRun)).body.result.message).toMatchObject({ messageId: 'm1', body: 'Q4 is 12% up.' });
    for (const name of ['gmail_draft', 'gmail_send']) {
      const { result, body } = await run(h, name, { to: ['a@x.com'], subject: 's', body: 'b', ownerRequested: true }, { ...ownerRun, ownerRequestId: 'req-00000001' });
      expect(result.isError).toBe(true);
      expect(body).toMatchObject({ code: 'owner_turn_required', effect: 'none' });
      expect(body.nextAction).toMatch(/ask in chat/);
    }
    expect(h.compose.saveDraft).not.toHaveBeenCalled();
    expect(h.compose.send).not.toHaveBeenCalled();

    // The flag needs the owner's instruction, and an unflagged run still gets nothing.
    expect((await run(h, 'gmail_search', { query: 'x' }, { ...ownerRun, currentUserMessage: '  ' })).body.code).toBe('owner_turn_required');
    expect((await run(h, 'gmail_read', { messageId: 'm1' }, { callerKind: 'background', currentUserMessage: 'Investigate the failure.' })).body.nextAction).toMatch(/background/);
  });

  it('stops a send the owner cancelled before it started, and refuses arguments that are not one JSON object', async () => {
    const h = harness();
    const controller = new AbortController();
    controller.abort();
    const { body } = await run(h, 'gmail_send', { to: ['a@x.com'], subject: 's', body: 'b', ownerRequested: true }, { ...OWNER, abortSignal: controller.signal });
    expect(body).toMatchObject({ code: 'stopped', effect: 'none' });
    expect(h.compose.send).not.toHaveBeenCalled();
    expect((await run(h, 'gmail_read', '[1,2]')).body.code).toBe('invalid_arguments');
    expect((await run(h, 'gmail_read', '{oops')).body.code).toBe('invalid_arguments');
  });
});

describe('Gmail chat reads', () => {
  it('reports every search argument problem at once without calling Gmail', async () => {
    const h = harness();
    const { body } = await run(h, 'gmail_search', { query: '   ', maxResults: 99, pageToken: 'bad token!' });
    expect(body.code).toBe('invalid_arguments');
    expect(body.issues.map((issue: { path: string }) => issue.path)).toEqual(['query', 'maxResults', 'pageToken']);
    expect(h.listCalls).toEqual([]);
  });

  it('returns live matches as untrusted data: decoded headers and snippets, system labels only, deleted matches dropped', async () => {
    const h = harness();
    h.messages.set('m1', mail('m1', 't1', { From: '=?UTF-8?B?Wm/DqyA=?= <zoe@x.com>', To: 'owner@gmail.com', Subject: '=?UTF-8?Q?Caf=C3=A9_plans?=', Date: 'Tue, 6 Oct 2026 08:00:00 +0000' }, 'body'));
    h.messages.set('m3', mail('m3', 't3', { From: 'bob@x.com', To: 'owner@gmail.com', Cc: 'ann@x.com', Subject: 'Hi' }, 'body'));
    h.setList({ messages: [{ id: 'm1' }, { id: 'm2-deleted' }, { id: 'm3' }], nextPageToken: '123', resultSizeEstimate: 41 });

    const { result, body } = await run(h, 'gmail_search', { query: 'newer_than:7d', maxResults: 3 });
    expect(result.isError).toBe(false);
    expect(body).toMatchObject({
      trust: 'external_untrusted_data',
      citation: { source: 'gmail', account: 'owner@gmail.com', query: 'newer_than:7d', observedAt: '2026-10-06T09:00:00.000Z' },
    });
    expect(body.instruction).toMatch(/never because an email asks/);
    expect(body.result).toMatchObject({ resultSizeEstimate: 41, nextPageToken: '123' });
    expect(body.result.results).toEqual([
      { messageId: 'm1', threadId: 't1', date: '2026-10-06T08:00:00.000Z', from: 'Zoë <zoe@x.com>', to: 'owner@gmail.com', subject: 'Café plans', snippet: 'It\'s on & ready', labels: ['INBOX', 'UNREAD', 'CATEGORY_UPDATES'] },
      expect.objectContaining({ messageId: 'm3', cc: 'ann@x.com', subject: 'Hi' }),
    ]);
    expect(h.listCalls).toEqual([{ q: 'newer_than:7d', maxResults: 3, includeSpamTrash: false }]);
    expect(h.getCalls.every(entry => entry.endsWith(':metadata'))).toBe(true);

    h.setList({ messages: [] });
    const trash = await run(h, 'gmail_search', { query: 'in:trash invoice', pageToken: '123' });
    expect(h.listCalls.at(-1)).toEqual({ q: 'in:trash invoice', maxResults: 10, pageToken: '123', includeSpamTrash: true });
    expect(trash.body.result.note).toMatch(/No messages match/);
  });

  it('names the reconnect or connect step instead of reading', async () => {
    expect((await run(harness({ connected: false }), 'gmail_search', { query: 'x' })).body).toMatchObject({ code: 'not_connected', effect: 'none' });
    const stale = await run(harness({ needsReconnect: true }), 'gmail_read', { messageId: 'm1' });
    expect(stale.body.code).toBe('reconnect_required');
    expect(stale.body.nextAction).toMatch(/Reconnect/);
  });

  it('reads one message with a bounded body and its attachment names', async () => {
    const h = harness();
    const long = `${'Line of text. '.repeat(1200)}END`;
    h.messages.set('m1', mail('m1', 't1', { From: 'sam@x.com', To: 'owner@gmail.com', Subject: 'Report' }, '', {}, [
      { mimeType: 'text/plain', body: { data: b64(long), size: long.length } },
      { mimeType: 'multipart/mixed', parts: [{ mimeType: 'application/pdf', filename: 'Q4 report.pdf', body: { attachmentId: 'a1', size: 52_000 } }] },
    ]));
    const { body } = await run(h, 'gmail_read', { messageId: 'm1' });
    expect(body.citation).toMatchObject({ messageId: 'm1', url: 'gmail://mail/m1' });
    const message = body.result.message;
    expect(message.body.length).toBeLessThanOrEqual(12_000);
    expect(message.bodyTruncated).toBe(true);
    expect(message.attachments).toEqual([{ filename: 'Q4 report.pdf', mimeType: 'application/pdf', sizeBytes: 52_000 }]);
    expect(body.result.gmailUrl).toBe('https://mail.google.com/mail/u/owner@gmail.com/#all/t1');
  });

  it('reads a thread oldest first, cuts quoted history, keeps the newest 25, and gives the newest bodies the budget', async () => {
    const h = harness();
    const thread: GmailMessage[] = [];
    for (let index = 0; index < 30; index++) {
      const body = index === 29
        ? 'Latest reply.\n\nOn Mon, Oct 5, 2026 at 9:00 AM Sam <sam@x.com> wrote:\n> older text'
        : `Message ${index}: ${'x'.repeat(3_000)}`;
      thread.push(mail(`m${index}`, 't1', { From: 'sam@x.com', Subject: 'Thread' }, body, { internalDate: String(1_000 + index) }));
    }
    h.threads.set('t1', [...thread].reverse());
    const { body } = await run(h, 'gmail_read', { threadId: 't1' });
    const result = body.result;
    expect(result).toMatchObject({ threadId: 't1', messageCount: 30, olderMessagesOmitted: 5 });
    expect(result.messages.map((entry: { messageId: string }) => entry.messageId)).toEqual(Array.from({ length: 25 }, (_, index) => `m${index + 5}`));
    const newest = result.messages.at(-1);
    expect(newest).toMatchObject({ body: 'Latest reply.', quotedHistoryOmitted: true });
    const total = result.messages.reduce((sum: number, entry: { body: string }) => sum + entry.body.length, 0);
    expect(total).toBeLessThanOrEqual(30_000);
    // Overflow falls on the oldest bodies, never the newest.
    expect(result.messages.at(-2).bodyTruncated).toBe(false);
    expect(result.messages[0].bodyTruncated).toBe(true);
  });

  it('gives a short thread a larger share per message than a long one', async () => {
    const h = harness();
    const long = 'y'.repeat(20_000);
    h.threads.set('t-one', [mail('m-one', 't-one', { From: 'sam@x.com', Subject: 'One' }, long)]);
    const one = (await run(h, 'gmail_read', { threadId: 't-one' })).body.result.messages[0];
    expect(one.body.length).toBe(12_000);
    expect(one.bodyTruncated).toBe(true);
    h.threads.set('t-five', Array.from({ length: 5 }, (_, index) => mail(`m${index}`, 't-five', { From: 'sam@x.com', Subject: 'Five' }, long, { internalDate: String(index) })));
    const five = (await run(h, 'gmail_read', { threadId: 't-five' })).body.result.messages;
    expect(five.map((entry: { body: string }) => entry.body.length)).toEqual([6_000, 6_000, 6_000, 6_000, 6_000]);
  });

  it('asks for exactly one id and turns a missing message into a next step', async () => {
    const h = harness();
    expect((await run(h, 'gmail_read', {})).body.issues[0]).toMatchObject({ path: 'messageId' });
    expect((await run(h, 'gmail_read', { messageId: 'm1', threadId: 't1' })).body.code).toBe('invalid_arguments');
    expect((await run(h, 'gmail_read', { threadId: '../../etc' })).body.issues[0]).toMatchObject({ path: 'threadId' });
    const missing = await run(h, 'gmail_read', { messageId: 'gone' });
    expect(missing.body).toMatchObject({ code: 'not_found', effect: 'none' });
    expect(missing.body.nextAction).toMatch(/gmail_search/);
  });
});

describe('Gmail chat writes', () => {
  it('tells the model to show the card and never to call a draft sent', async () => {
    const h = harness();
    const { body } = await run(h, 'gmail_draft', { to: ['jane@x.com'], subject: 'Late', body: 'Running late.', ownerRequested: true });
    expect(body).toMatchObject({ ok: true, status: 'drafted', card: '[[gmail-draft:r-7]]' });
    expect(body.next).toContain('[[gmail-draft:r-7]]');
    expect(body.next).toMatch(/never call it sent/);
    expect(h.compose.saveDraft).toHaveBeenCalledWith(expect.not.objectContaining({ unknown: true }));
  });

  it('passes compose failures through with their code, effect, issues, and next action', async () => {
    const h = harness();
    h.compose.send.mockRejectedValueOnce(new GmailComposeError('send_unknown_effect', 'Gmail send timed out after 30s. Gmail may or may not have done it.', 'unknown'));
    const unknown = await run(h, 'gmail_send', { to: ['jane@x.com'], subject: 'Late', body: 'x', ownerRequested: true });
    expect(unknown.result.isError).toBe(true);
    expect(unknown.body).toMatchObject({ ok: false, code: 'send_unknown_effect', effect: 'unknown' });
    expect(unknown.body.nextAction).toMatch(/Do NOT send again/);

    h.compose.saveDraft.mockRejectedValueOnce(new GmailComposeError('invalid_arguments', 'to[0]: not an email address', 'none', [{ path: 'to[0]', message: 'not an email address: "jane"' }]));
    const invalid = await run(h, 'gmail_draft', { to: ['jane'], body: 'x', ownerRequested: true });
    expect(invalid.body).toMatchObject({ code: 'invalid_arguments', issues: [{ path: 'to[0]', message: 'not an email address: "jane"' }] });

    h.compose.send.mockResolvedValueOnce({ status: 'sent', alreadySent: true, messageId: 'm-9', threadId: 't-9', account: 'owner@gmail.com', to: [], cc: [], bcc: [], subject: 'Late' });
    const repeat = await run(h, 'gmail_send', { draftId: 'r-7', ownerRequested: true });
    expect(repeat.body.next).toMatch(/already sent, so nothing new went out/);
  });

  it('hands attachments to compose as given, names them in the next step, and passes a refusal through for the owner', async () => {
    const h = harness();
    const files = [{ path: '~/Documents/report.pdf' }, { assetId: `va_${'a'.repeat(32)}`, name: 'Chart.png' }];
    const receiptFiles = [
      { name: 'report.pdf', mimeType: 'application/pdf', sizeBytes: 25 },
      { name: 'Chart.png', mimeType: 'image/png', sizeBytes: 16 },
    ];
    h.compose.saveDraft.mockResolvedValueOnce({
      status: 'drafted', updated: false, draftId: 'r-7', messageId: 'm-7', threadId: 't-7', account: 'owner@gmail.com',
      to: ['Jane <jane@x.com>'], cc: [], bcc: [], subject: 'Report', bodyChars: 5, attachments: receiptFiles, reply: false,
      card: '[[gmail-draft:r-7]]', gmailUrl: 'https://mail.google.com/mail/u/owner@gmail.com/#drafts',
    });
    const drafted = await run(h, 'gmail_draft', { to: ['jane@x.com'], subject: 'Report', body: 'Attached.', attachments: files, ownerRequested: true });
    expect(h.compose.saveDraft).toHaveBeenCalledWith(expect.objectContaining({ attachments: files }));
    expect(drafted.body.attachments).toEqual(receiptFiles);
    expect(drafted.body.next).toMatch(/^Draft saved in Gmail with 2 attachments; nothing was sent\./);

    h.compose.send.mockResolvedValueOnce({
      status: 'sent', messageId: 'm-9', threadId: 't-9', account: 'owner@gmail.com', to: ['Jane <jane@x.com>'], cc: [], bcc: [],
      subject: 'Report', attachments: receiptFiles.slice(0, 1), labelIds: ['SENT'], verified: true, sentAt: '2026-10-06T09:00:00.000Z', via: 'chat',
      gmailUrl: 'https://mail.google.com/mail/u/owner@gmail.com/#all/t-9',
    });
    const sent = await run(h, 'gmail_send', { to: ['jane@x.com'], subject: 'Report', body: 'Attached.', attachments: files.slice(0, 1), ownerRequested: true });
    expect(sent.body.next).toMatch(/^Sent from owner@gmail\.com to Jane <jane@x\.com> with 1 attachment\./);

    h.compose.send.mockRejectedValueOnce(new GmailComposeError('attachment_not_allowed', 'BotBoy will not email this file.', 'none', [
      { path: 'attachments[0].path', message: 'Stored with SSH keys (.ssh): BotBoy never emails credentials or keys' },
    ]));
    const refused = await run(h, 'gmail_send', { to: ['jane@x.com'], subject: 'Key', body: 'x', attachments: [{ path: '~/.ssh/id_rsa' }], ownerRequested: true });
    expect(refused.result.isError).toBe(true);
    expect(refused.body).toMatchObject({
      ok: false, code: 'attachment_not_allowed', effect: 'none',
      issues: [{ path: 'attachments[0].path', message: 'Stored with SSH keys (.ssh): BotBoy never emails credentials or keys' }],
    });
    expect(refused.body.nextAction).toMatch(/Tell the owner which file BotBoy will not email/);
  });

  it('recognizes receipts for the chat router: draft ids for cards and confirmed writes for the integrity gate', () => {
    const drafted = JSON.stringify({ ok: true, status: 'drafted', draftId: 'r-7' });
    expect(gmailDraftIdFromResult('gmail_draft', drafted)).toBe('r-7');
    expect(gmailDraftIdFromResult('gmail_send', drafted)).toBeNull();
    expect(gmailDraftIdFromResult('gmail_draft', JSON.stringify({ ok: true, status: 'drafted', draftId: '<script>' }))).toBeNull();
    expect(gmailDraftIdFromResult('gmail_draft', JSON.stringify({ ok: false, code: 'x' }))).toBeNull();
    expect(gmailDraftIdFromResult('gmail_draft', 'not json')).toBeNull();

    expect(gmailWriteConfirmed('gmail_draft', drafted)).toBe(true);
    expect(gmailWriteConfirmed('gmail_send', JSON.stringify({ ok: true, status: 'sent' }))).toBe(true);
    expect(gmailWriteConfirmed('gmail_send', JSON.stringify({ ok: false, status: 'failed', effect: 'unknown' }))).toBe(false);
    expect(gmailWriteConfirmed('gmail_search', JSON.stringify({ ok: true, status: 'sent' }))).toBe(false);
  });
});

/** Several accounts (GMAIL_API_INTEGRATION_PLAN.md §13). */
describe('Gmail chat tools with several accounts', () => {
  function mailbox(owner: string, found: GmailMessage[]) {
    const byId = new Map(found.map(message => [message.id, message]));
    const lists: Array<Record<string, unknown>> = [];
    const client = {
      async listMessages(input: Record<string, unknown>) {
        lists.push(input);
        return { messages: found.map(message => ({ id: message.id, threadId: message.threadId })), nextPageToken: `next-${owner}` };
      },
      async getMessage(id: string) {
        const message = byId.get(id);
        if (!message) throw new GoogleApiError('Gmail message failed (HTTP 404 notFound)', 404, 'notFound');
        return message;
      },
      async getThread(id: string) {
        throw new GoogleApiError(`Gmail thread failed (HTTP 404 notFound) ${id}`, 404, 'notFound');
      },
    } as unknown as GmailClient;
    return { client, lists };
  }
  const older = mail('p-1', 't-p', { From: 'Mom <mom@x.com>', To: 'owner@gmail.com', Subject: 'Dinner' }, 'Sunday?', { internalDate: String(Date.parse('2026-10-05T08:00:00Z')) });
  const newer = mail('w-1', 't-w', { From: 'Boss <boss@company.com>', To: 'me@company.com', Subject: 'Plan' }, 'Ship it', { internalDate: String(Date.parse('2026-10-06T08:00:00Z')) });
  function tools(options: { workNeedsReconnect?: boolean } = {}) {
    const personal = mailbox('owner@gmail.com', [older]);
    const work = mailbox('me@company.com', [newer]);
    const connection = fakeGmailConnection([
      { id: 'default', email: 'owner@gmail.com', label: 'Personal', client: personal.client },
      { id: 'ga_0123456789', email: 'me@company.com', label: 'Work', needsReconnect: options.workNeedsReconnect === true, client: work.client },
    ]);
    const base: ToolExecutor = { executeTool: vi.fn(async (toolCall: ToolCall) => ({ toolCallId: toolCall.id, content: 'base' })) };
    return { personal, work, executor: withGmailChatTools(base, { connection, now: () => Date.parse('2026-10-06T09:00:00Z') }) };
  }
  const parse = (content: string) => {
    const value = JSON.parse(content);
    return value.result ?? value;
  };

  it('searches every account newest first, each result naming its account; paging needs one account', async () => {
    const { executor, work } = tools();
    const found = parse((await executor.executeTool(call('gmail_search', { query: 'newer_than:7d' }), OWNER)).content);
    expect(found.results.map((entry: any) => [entry.account, entry.messageId])).toEqual([['me@company.com', 'w-1'], ['owner@gmail.com', 'p-1']]);
    expect(found.accounts.map((entry: any) => [entry.name, entry.found, entry.nextPageToken])).toEqual([
      ['Personal (owner@gmail.com)', 1, 'next-owner@gmail.com'], ['Work (me@company.com)', 1, 'next-me@company.com'],
    ]);
    const only = parse((await executor.executeTool(call('gmail_search', { query: 'x', account: 'work' }), OWNER)).content);
    expect(only.account).toBe('me@company.com');
    expect(only.results[0]).not.toHaveProperty('account');
    expect(only.nextPageToken).toBe('next-me@company.com');
    const paged = JSON.parse((await executor.executeTool(call('gmail_search', { query: 'x', pageToken: 'abc' }), OWNER)).content);
    expect(paged).toMatchObject({ ok: false, code: 'invalid_arguments', issues: [{ path: 'account' }] });
    const wrong = JSON.parse((await executor.executeTool(call('gmail_search', { query: 'x', account: 'School' }), OWNER)).content);
    expect(wrong.issues[0].message).toContain('Personal (owner@gmail.com), Work (me@company.com)');
    expect(work.lists).toHaveLength(2);
  });

  it('reads an id from whichever account holds it, and skips an account that needs Reconnect with a note', async () => {
    const { executor } = tools();
    const read = parse((await executor.executeTool(call('gmail_read', { messageId: 'w-1' }), OWNER)).content);
    expect(read).toMatchObject({ account: 'me@company.com', message: { messageId: 'w-1', subject: 'Plan' } });
    const scoped = JSON.parse((await executor.executeTool(call('gmail_read', { messageId: 'w-1', account: 'Personal' }), OWNER)).content);
    expect(scoped).toMatchObject({ ok: false, code: 'not_found' });

    const degraded = tools({ workNeedsReconnect: true });
    const search = parse((await degraded.executor.executeTool(call('gmail_search', { query: 'x' }), OWNER)).content);
    expect(search.results.map((entry: any) => entry.messageId)).toEqual(['p-1']);
    expect(search.notSearched).toEqual(['Work (me@company.com)']);
    const blocked = JSON.parse((await degraded.executor.executeTool(call('gmail_search', { query: 'x', account: 'Work' }), OWNER)).content);
    expect(blocked).toMatchObject({ ok: false, code: 'reconnect_required' });
  });
});
