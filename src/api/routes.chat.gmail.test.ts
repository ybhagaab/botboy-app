import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import type Database from 'better-sqlite3';
import { createStorage, type StorageLayer } from '../core/storage.js';
import { createNodeManager } from '../core/node-manager.js';
import { createRouter } from './routes.js';
import { withGmailDraftCards } from './routers/chat.js';

/**
 * The chat loop around Gmail writes (GMAIL_CHAT_TOOLS_PLAN.md §7): every
 * draft saved in a turn reaches the owner as its card, and "sent"/"drafted"
 * claims need a Gmail receipt, same harness as routes.chat.loop.test.ts.
 */

function streamResult(partial: Record<string, unknown>) {
  return { content: '', reasoning: '', toolCalls: [], usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, finishReason: 'stop', ...partial };
}

function makeDeps(db: Database.Database, llmClient: any, toolExecutor: any) {
  return {
    nodeManager: createNodeManager(db),
    db,
    llmClient,
    toolExecutor,
    chatInterface: { getHistory: () => [], sendMessage: async () => ({ message: { id: 'x', role: 'assistant', content: '' } }) } as any,
    promptManager: {
      getSystemPrompt: () => 'You are a test bot.',
      getToolDefinitions: () => [{ type: 'function', function: { name: 'gmail_draft', description: 'draft', parameters: {} } }],
    } as any,
    conversationManager: {
      getActiveSessionId: () => null,
      createSession: () => 'sess-test',
      appendUser: vi.fn(),
      appendAssistant: vi.fn(),
      countUserMessages: () => 1,
      getSummary: () => null,
      getMessages: () => [],
      getMessagesSinceId: () => [],
      getRecentMessages: () => [{ role: 'user' as const, content: 'email Jane' }],
      saveSummary: vi.fn(),
    } as any,
  };
}

/** One Gmail tool call, then the model's final reply (or replies, for a corrective pass). */
function scriptedModel(tool: { name: string; arguments: string }, replies: string[]) {
  let call = 0;
  return {
    getActiveEndpoint: () => 'ecs',
    chatCompletionStream: vi.fn((req: any) => {
      call++;
      return (async function* () {
        if (call === 1 && req.tools?.length) {
          yield { type: 'tool_call_start', toolCall: { index: 0, id: 'c1', name: tool.name } };
          return streamResult({ toolCalls: [{ id: 'c1', type: 'function', function: tool }], finishReason: 'tool_calls' });
        }
        const text = replies[Math.min(call - 2, replies.length - 1)];
        yield { type: 'content', text };
        return streamResult({ content: text });
      })();
    }),
  };
}

describe('chat loop around Gmail writes', () => {
  let storage: StorageLayer;
  let db: Database.Database;
  beforeEach(() => {
    storage = createStorage(':memory:');
    storage.initialize();
    db = storage.getDb();
  });
  afterEach(() => storage.close());

  const lastReply = () => (db.prepare("SELECT content FROM chat_messages WHERE role='assistant' ORDER BY created_at DESC LIMIT 1").get() as any).content as string;
  const app = (llm: any, executor: any) => {
    const server = express();
    server.use(express.json());
    server.use('/api', createRouter(makeDeps(db, llm, executor)));
    return server;
  };
  const drafted = JSON.stringify({ ok: true, status: 'drafted', draftId: 'r-5', card: '[[gmail-draft:r-5]]' });

  it('appends the card of a draft the reply did not mention, once', async () => {
    const llm = scriptedModel({ name: 'gmail_draft', arguments: '{"to":["jane@x.com"],"subject":"Late","body":"x","ownerRequested":true}' }, ['Here is the draft for you to check.']);
    const executor = { executeTool: vi.fn(async () => ({ content: drafted })) };
    await request(app(llm, executor)).post('/api/chat/messages').send({ message: 'draft an email to Jane, show me first', stream: true });
    expect(executor.executeTool).toHaveBeenCalledOnce();
    expect(executor.executeTool.mock.calls[0][1]).toMatchObject({ callerKind: 'interactive', ownerRequestId: expect.any(String) });
    expect(lastReply()).toBe('Here is the draft for you to check.\n\n[[gmail-draft:r-5]]');
  });

  it('keeps a card token the reply already placed, without a duplicate', async () => {
    const llm = scriptedModel({ name: 'gmail_draft', arguments: '{"body":"x","ownerRequested":true}' }, ['Draft below:\n\n[[gmail-draft:r-5]]\n\nSay send when ready.']);
    const executor = { executeTool: vi.fn(async () => ({ content: drafted })) };
    await request(app(llm, executor)).post('/api/chat/messages').send({ message: 'draft it', stream: true });
    expect(lastReply().match(/\[\[gmail-draft:r-5\]\]/g)).toHaveLength(1);
  });

  it('a send that failed or has an unknown effect does not license a "sent" claim', async () => {
    const llm = scriptedModel({ name: 'gmail_send', arguments: '{"to":["jane@x.com"],"subject":"Late","body":"x","ownerRequested":true}' }, [
      "✅ Email sent to Jane. I've sent it from your Gmail.",
      'Gmail did not confirm the send, so I cannot say it went out. I will check Sent.',
    ]);
    const executor = { executeTool: vi.fn(async () => ({ content: JSON.stringify({ ok: false, status: 'failed', code: 'send_unknown_effect', effect: 'unknown' }), isError: true })) };
    const res = await request(app(llm, executor)).post('/api/chat/messages').send({ message: 'email Jane that I am late', stream: true });
    expect(llm.chatCompletionStream).toHaveBeenCalledTimes(3);
    expect(res.text).toContain('"type":"retry"');
    expect(lastReply()).toContain('Gmail did not confirm the send');
  });

  it('a send with a receipt passes the integrity gate untouched', async () => {
    const llm = scriptedModel({ name: 'gmail_send', arguments: '{"to":["jane@x.com"],"subject":"Late","body":"x","ownerRequested":true}' }, ["✅ Sent — I've emailed Jane that you are running late."]);
    const executor = { executeTool: vi.fn(async () => ({ content: JSON.stringify({ ok: true, status: 'sent', messageId: 'm-1', threadId: 't-1' }) })) };
    const res = await request(app(llm, executor)).post('/api/chat/messages').send({ message: 'email Jane that I am late', stream: true });
    expect(llm.chatCompletionStream).toHaveBeenCalledTimes(2);
    expect(res.text).not.toContain('"type":"retry"');
    expect(lastReply()).toBe("✅ Sent — I've emailed Jane that you are running late.");
  });
});

describe('withGmailDraftCards', () => {
  it('adds each missing token on its own line, keeps placed ones, and leaves a reply without drafts alone', () => {
    expect(withGmailDraftCards('Done.  \n', ['r-1', 'r-2'])).toBe('Done.\n\n[[gmail-draft:r-1]]\n[[gmail-draft:r-2]]');
    expect(withGmailDraftCards('See [[gmail-draft:r-1]] above', ['r-1'])).toBe('See [[gmail-draft:r-1]] above');
    expect(withGmailDraftCards('No mail today.', [])).toBe('No mail today.');
  });
});
