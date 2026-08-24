import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import type Database from 'better-sqlite3';
import { createStorage, type StorageLayer } from '../core/storage.js';
import { createNodeManager } from '../core/node-manager.js';
import { createRouter } from './routes.js';

/**
 * Guards for the two loop-safety mechanisms added after the 2026-08-03
 * repeated-search post-mortem (12 identical search_items calls → stock
 * "Reached max tool iterations." dead-end):
 *
 *   1. Repeat-call breaker — a byte-identical tool call is executed once;
 *      the first repeat gets a nudge result instead of a re-execution, and a
 *      second repeat flips the tools kill-switch (next stream call gets no
 *      tool definitions, forcing a text answer).
 *   2. Cap synthesis — when all 15 iterations are spent, one final tools-off
 *      call produces a best-effort answer instead of the stock message.
 *
 * The llmClient is a scripted async-generator mock; toolExecutor counts real
 * executions; the DB is real in-memory SQLite.
 */

/** StreamResult scaffold for the mock generator's return value. */
function streamResult(partial: Record<string, unknown>) {
  return {
    content: '',
    reasoning: '',
    toolCalls: [],
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    finishReason: 'stop',
    ...partial,
  };
}

function makeDeps(db: Database.Database, llmClient: any, toolExecutor: any) {
  return {
    nodeManager: createNodeManager(db),
    db,
    llmClient,
    toolExecutor,
    chatInterface: {
      getHistory: () => [],
      sendMessage: async () => ({ message: { id: 'x', role: 'assistant', content: '' } }),
    } as any,
    promptManager: {
      getSystemPrompt: () => 'You are a test bot.',
      getToolDefinitions: () => [
        { type: 'function', function: { name: 'search_items', description: 'search', parameters: {} } },
      ],
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
      getRecentMessages: () => [{ role: 'user' as const, content: 'weblab question' }],
      saveSummary: vi.fn(),
    } as any,
  };
}

function buildApp(deps: any): express.Express {
  const app = express();
  app.use(express.json());
  app.use('/api', createRouter(deps));
  return app;
}

describe('chat streaming loop safety', () => {
  let storage: StorageLayer;
  let db: Database.Database;

  beforeEach(() => {
    storage = createStorage(':memory:');
    storage.initialize();
    db = storage.getDb();
  });

  afterEach(() => {
    storage.close();
  });

  it('breaks a repeated identical tool call: 1 execution, nudges, then tools-off answer', async () => {
    const seenRequests: any[] = [];
    const llmClient = {
      getActiveEndpoint: () => 'ecs',
      chatCompletionStream: vi.fn((req: any) => {
        seenRequests.push(req);
        return (async function* () {
          if (!req.tools || req.tools.length === 0) {
            yield { type: 'content', text: 'final answer after nudges' };
            return streamResult({ content: 'final answer after nudges' });
          }
          // Always the SAME tool call, byte-identical args.
          yield { type: 'tool_call_start', toolCall: { index: 0, id: 'c1', name: 'search_items' } };
          return streamResult({
            toolCalls: [{ id: 'c1', type: 'function', function: { name: 'search_items', arguments: '{"query":"weblab APT"}' } }],
            finishReason: 'tool_calls',
          });
        })();
      }),
    };
    const toolExecutor = { executeTool: vi.fn(async () => ({ content: 'same thin result' })) };
    const app = buildApp(makeDeps(db, llmClient, toolExecutor));

    const res = await request(app)
      .post('/api/chat/messages')
      .send({ message: 'weblab question', stream: true });

    // Executed once; repeats replaced by the nudge.
    expect(toolExecutor.executeTool).toHaveBeenCalledTimes(1);
    expect(res.text).toContain('REPEATED CALL BLOCKED');
    // Call sequence: tools, tools (repeat→nudge), tools (repeat→kill-switch), tools-off.
    expect(llmClient.chatCompletionStream).toHaveBeenCalledTimes(4);
    expect(seenRequests[3].tools).toEqual([]);
    // The forced text answer reaches the user as the terminal message.
    expect(res.text).toContain('final answer after nudges');
    const lastMsg = db.prepare("SELECT content FROM chat_messages WHERE role='assistant' ORDER BY created_at DESC LIMIT 1").get() as any;
    expect(lastMsg.content).toBe('final answer after nudges');
  });

  it('synthesizes a tools-off answer when the 15-iteration cap is hit', async () => {
    const seenRequests: any[] = [];
    let n = 0;
    const llmClient = {
      getActiveEndpoint: () => 'ecs',
      chatCompletionStream: vi.fn((req: any) => {
        seenRequests.push(req);
        return (async function* () {
          if (!req.tools || req.tools.length === 0) {
            yield { type: 'content', text: 'best-effort summary of findings' };
            return streamResult({ content: 'best-effort summary of findings' });
          }
          // A DIFFERENT (never-repeating) tool call every iteration.
          n++;
          yield { type: 'tool_call_start', toolCall: { index: 0, id: `c${n}`, name: 'search_items' } };
          return streamResult({
            toolCalls: [{ id: `c${n}`, type: 'function', function: { name: 'search_items', arguments: `{"query":"variant ${n}"}` } }],
            finishReason: 'tool_calls',
          });
        })();
      }),
    };
    const toolExecutor = { executeTool: vi.fn(async () => ({ content: 'partial evidence' })) };
    const app = buildApp(makeDeps(db, llmClient, toolExecutor));

    const res = await request(app)
      .post('/api/chat/messages')
      .send({ message: 'weblab question', stream: true });

    // 15 tool iterations + 1 synthesis call.
    expect(toolExecutor.executeTool).toHaveBeenCalledTimes(15);
    expect(llmClient.chatCompletionStream).toHaveBeenCalledTimes(16);
    const synthesisReq = seenRequests[15];
    expect(synthesisReq.tools).toBeUndefined();
    const lastPromptMsg = synthesisReq.messages[synthesisReq.messages.length - 1];
    expect(lastPromptMsg.role).toBe('user');
    expect(lastPromptMsg.content).toContain('tool-call limit');
    // The user gets the synthesis, not the stock dead-end line.
    expect(res.text).toContain('best-effort summary of findings');
    const lastMsg = db.prepare("SELECT content FROM chat_messages WHERE role='assistant' ORDER BY created_at DESC LIMIT 1").get() as any;
    expect(lastMsg.content).toBe('best-effort summary of findings');
    expect(lastMsg.content).not.toContain('Reached max tool iterations');
  });

  it('integrity gate: false "saved" claim with no write tool forces a corrective pass', async () => {
    const seenRequests: any[] = [];
    let call = 0;
    const llmClient = {
      getActiveEndpoint: () => 'ecs',
      chatCompletionStream: vi.fn((req: any) => {
        seenRequests.push(req);
        call++;
        return (async function* () {
          if (call === 1) {
            yield { type: 'content', text: 'x' };
            return streamResult({ content: '✅ Saved! **Item ID:** `f8c3d9a2-1b4e-4d5c-9f2a-8e7c6d5b4a3c`' });
          }
          yield { type: 'content', text: 'y' };
          return streamResult({ content: 'I have NOT saved anything yet — want me to create the item?' });
        })();
      }),
    };
    const toolExecutor = { executeTool: vi.fn(async () => ({ content: 'unused' })) };
    const app = buildApp(makeDeps(db, llmClient, toolExecutor));

    const res = await request(app)
      .post('/api/chat/messages')
      .send({ message: 'save a note', stream: true });

    // Two passes: the fabricated claim, then the corrective rewrite.
    expect(llmClient.chatCompletionStream).toHaveBeenCalledTimes(2);
    const correction = seenRequests[1].messages[seenRequests[1].messages.length - 1];
    expect(correction.role).toBe('user');
    expect(correction.content).toContain('REALITY CHECK');
    expect(res.text).toContain('"type":"retry"');
    const lastMsg = db.prepare("SELECT content FROM chat_messages WHERE role='assistant' ORDER BY created_at DESC LIMIT 1").get() as any;
    expect(lastMsg.content).toContain('NOT saved anything yet');
    expect(lastMsg.content).not.toContain('f8c3d9a2');
  });

  it('integrity gate: doubling down gets an appended system note', async () => {
    const llmClient = {
      getActiveEndpoint: () => 'ecs',
      chatCompletionStream: vi.fn(() =>
        (async function* () {
          yield { type: 'content', text: 'x' };
          return streamResult({ content: "✅ Done! I've created the tracking item you asked for." });
        })(),
      ),
    };
    const toolExecutor = { executeTool: vi.fn(async () => ({ content: 'unused' })) };
    const app = buildApp(makeDeps(db, llmClient, toolExecutor));

    await request(app).post('/api/chat/messages').send({ message: 'save it', stream: true });

    expect(llmClient.chatCompletionStream).toHaveBeenCalledTimes(2);
    const lastMsg = db.prepare("SELECT content FROM chat_messages WHERE role='assistant' ORDER BY created_at DESC LIMIT 1").get() as any;
    expect(lastMsg.content).toContain('nothing was actually created');
  });

  it('integrity gate: a claim backed by a real write tool passes untouched', async () => {
    let call = 0;
    const llmClient = {
      getActiveEndpoint: () => 'ecs',
      chatCompletionStream: vi.fn((req: any) => {
        call++;
        return (async function* () {
          if (call === 1 && req.tools?.length) {
            yield { type: 'tool_call_start', toolCall: { index: 0, id: 'c1', name: 'create_item' } };
            return streamResult({
              toolCalls: [{ id: 'c1', type: 'function', function: { name: 'create_item', arguments: '{"title":"n","content":"c"}' } }],
              finishReason: 'tool_calls',
            });
          }
          yield { type: 'content', text: 'x' };
          return streamResult({ content: '✅ Saved! Item ID: `real-id-123` (from the tool result)' });
        })();
      }),
    };
    const toolExecutor = { executeTool: vi.fn(async () => ({ content: '{"id":"real-id-123"}' })) };
    const app = buildApp(makeDeps(db, llmClient, toolExecutor));

    const res = await request(app).post('/api/chat/messages').send({ message: 'save it', stream: true });

    expect(toolExecutor.executeTool).toHaveBeenCalledTimes(1);
    // Tool pass + answer pass — no corrective third pass, no retry event, no note.
    expect(llmClient.chatCompletionStream).toHaveBeenCalledTimes(2);
    expect(res.text).not.toContain('"type":"retry"');
    const lastMsg = db.prepare("SELECT content FROM chat_messages WHERE role='assistant' ORDER BY created_at DESC LIMIT 1").get() as any;
    expect(lastMsg.content).toContain('real-id-123');
    expect(lastMsg.content).not.toContain('nothing was actually created');
  });

  it('never executes a tool whose arguments arrived truncated, and allows a retry', async () => {
    // Attempt 1: write_file args cut mid-JSON (output-token limit).
    // Attempt 2: the model retries smaller and succeeds.
    let call = 0;
    const llmClient = {
      getActiveEndpoint: () => 'ecs',
      getContextWindow: () => 262144,
      chatCompletionStream: vi.fn(() => {
        call++;
        return (async function* () {
          if (call === 1) {
            yield { type: 'tool_call_start', toolCall: { index: 0, id: 'c1', name: 'write_file' } };
            return streamResult({
              toolCalls: [{ id: 'c1', type: 'function', function: { name: 'write_file', arguments: '{"filename":"big.html","content":"<!DOCTYPE html><div>unterminated' } }],
              finishReason: 'tool_calls',
            });
          }
          if (call === 2) {
            yield { type: 'tool_call_start', toolCall: { index: 0, id: 'c2', name: 'write_file' } };
            return streamResult({
              toolCalls: [{ id: 'c2', type: 'function', function: { name: 'write_file', arguments: '{"filename":"big.html","content":"<h1>ok</h1>"}' } }],
              finishReason: 'tool_calls',
            });
          }
          yield { type: 'content', text: 'saved' };
          return streamResult({ content: 'Saved to big.html (see tool result).' });
        })();
      }),
    };
    const toolExecutor = { executeTool: vi.fn(async () => ({ content: '{"path":"/files/big.html","size":12}' })) };
    const app = buildApp(makeDeps(db, llmClient, toolExecutor));

    const res = await request(app)
      .post('/api/chat/messages')
      .send({ message: 'make me an html dashboard', stream: true });

    // The truncated call was NOT executed; only the valid retry ran.
    expect(toolExecutor.executeTool).toHaveBeenCalledTimes(1);
    expect(JSON.parse(toolExecutor.executeTool.mock.calls[0][0].function.arguments).content).toBe('<h1>ok</h1>');
    // The model was told why, in terms it can act on.
    expect(res.text).toContain('cut off mid-JSON');
    expect(res.text).toContain('mode=');
    // And the retry was not blocked as a "repeat" despite both sanitizing to {}.
    expect(res.text).not.toContain('REPEATED CALL BLOCKED');
    const lastMsg = db.prepare("SELECT content FROM chat_messages WHERE role='assistant' ORDER BY created_at DESC LIMIT 1").get() as any;
    expect(lastMsg.content).toContain('big.html');
  });

  it('falls back to the stock message when the synthesis call itself fails', async () => {
    let callCount = 0;
    const llmClient = {
      getActiveEndpoint: () => 'ecs',
      chatCompletionStream: vi.fn((req: any) => {
        callCount++;
        return (async function* () {
          if (!req.tools || req.tools.length === 0) {
            throw new Error('HTTP 400: synthetic failure');
          }
          const i = callCount;
          yield { type: 'tool_call_start', toolCall: { index: 0, id: `c${i}`, name: 'search_items' } };
          return streamResult({
            toolCalls: [{ id: `c${i}`, type: 'function', function: { name: 'search_items', arguments: `{"query":"v${i}"}` } }],
            finishReason: 'tool_calls',
          });
        })();
      }),
    };
    const toolExecutor = { executeTool: vi.fn(async () => ({ content: 'x' })) };
    const app = buildApp(makeDeps(db, llmClient, toolExecutor));

    const res = await request(app)
      .post('/api/chat/messages')
      .send({ message: 'weblab question', stream: true });

    expect(res.text).toContain('Reached max tool iterations.');
    const lastMsg = db.prepare("SELECT content FROM chat_messages WHERE role='assistant' ORDER BY created_at DESC LIMIT 1").get() as any;
    expect(lastMsg.content).toBe('Reached max tool iterations.');
  });
});
