import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import type Database from 'better-sqlite3';
import { createStorage, type StorageLayer } from '../core/storage.js';
import { createNodeManager } from '../core/node-manager.js';
import { createRouter } from './routes.js';
import { LlmPayloadTooLargeError } from '../core/llm-client.js';
import { saveChatAttachment } from '../core/chat-attachments.js';

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

  it('UNCAPPED LOOP: runs far past the old 15 cap, checkpoints every 40 iterations, and synthesizes at the 500 runaway ceiling', async () => {
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

    // 500 tool iterations (the runaway ceiling — NOT a working limit) + 1 synthesis call.
    expect(toolExecutor.executeTool).toHaveBeenCalledTimes(500);
    expect(llmClient.chatCompletionStream).toHaveBeenCalledTimes(501);
    const synthesisReq = seenRequests[500];
    expect(synthesisReq.tools).toBeUndefined();
    const lastPromptMsg = synthesisReq.messages[synthesisReq.messages.length - 1];
    expect(lastPromptMsg.role).toBe('user');
    expect(lastPromptMsg.content).toContain('runaway safety ceiling');
    // Checkpoint self-summaries were injected at 40, 80, … 480 → 12 of them.
    const checkpoints = synthesisReq.messages.filter((m: any) =>
      typeof m.content === 'string' && m.content.includes('SYSTEM CHECKPOINT'));
    expect(checkpoints.length).toBe(12);
    // The user gets the synthesis, not a stock dead-end line.
    expect(res.text).toContain('best-effort summary of findings');
    const lastMsg = db.prepare("SELECT content FROM chat_messages WHERE role='assistant' ORDER BY created_at DESC LIMIT 1").get() as any;
    expect(lastMsg.content).toBe('best-effort summary of findings');
    expect(lastMsg.content).not.toContain('Reached max tool iterations');
  });

  it('STOP BUTTON: /chat/stop ends the in-flight turn at the next iteration boundary with an honest progress summary', async () => {
    const seenRequests: any[] = [];
    let n = 0;
    const llmClient = {
      getActiveEndpoint: () => 'ecs',
      chatCompletionStream: vi.fn((req: any) => {
        seenRequests.push(req);
        return (async function* () {
          if (!req.tools || req.tools.length === 0) {
            yield { type: 'content', text: 'stopped: fetched 2 of 5 outputs so far' };
            return streamResult({ content: 'stopped: fetched 2 of 5 outputs so far' });
          }
          n++;
          yield { type: 'tool_call_start', toolCall: { index: 0, id: `c${n}`, name: 'search_items' } };
          return streamResult({
            toolCalls: [{ id: `c${n}`, type: 'function', function: { name: 'search_items', arguments: `{"query":"variant ${n}"}` } }],
            finishReason: 'tool_calls',
          });
        })();
      }),
    };
    // The 3rd tool execution presses Stop mid-turn (in-process, same app).
    let appRef: express.Express | null = null;
    const toolExecutor = {
      executeTool: vi.fn(async () => {
        if (toolExecutor.executeTool.mock.calls.length === 3 && appRef) {
          const stopRes = await request(appRef).post('/api/chat/stop');
          expect(stopRes.body.ok).toBe(true);
          expect(stopRes.body.stopped).toBe(1);
        }
        return { content: 'partial evidence' };
      }),
    };
    const app = buildApp(makeDeps(db, llmClient, toolExecutor));
    appRef = app;

    const res = await request(app)
      .post('/api/chat/messages')
      .send({ message: 'long fetch task', stream: true });

    // Stopped at the boundary after iteration 3 — nowhere near the ceiling.
    expect(toolExecutor.executeTool).toHaveBeenCalledTimes(3);
    // 3 tool iterations + 1 stop-synthesis call.
    expect(llmClient.chatCompletionStream).toHaveBeenCalledTimes(4);
    const synthesisReq = seenRequests[3];
    const lastPromptMsg = synthesisReq.messages[synthesisReq.messages.length - 1];
    expect(lastPromptMsg.content).toContain('pressed Stop');
    expect(res.text).toContain('⏹️ Stopping');
    // Cancel ≠ failure: the turn closes with the model's honest summary.
    const lastMsg = db.prepare("SELECT content FROM chat_messages WHERE role='assistant' ORDER BY created_at DESC LIMIT 1").get() as any;
    expect(lastMsg.content).toBe('stopped: fetched 2 of 5 outputs so far');
  });

  it('STOP endpoint with no in-flight turn is a harmless no-op', async () => {
    const app = buildApp(makeDeps(db, { getActiveEndpoint: () => 'ecs', chatCompletionStream: vi.fn() }, { executeTool: vi.fn() }));
    const res = await request(app).post('/api/chat/stop');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, stopped: 0, active: 0 });
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

  it('keeps screenshot evidence through follow-up calls, then supersedes an older same-tab screenshot', async () => {
    const seenRequests: any[] = [];
    let call = 0;
    const firstImage = `data:image/jpeg;base64,${'A'.repeat(1_000)}`;
    const secondImage = `data:image/jpeg;base64,${'B'.repeat(1_200)}`;
    const llmClient = {
      getActiveEndpoint: () => 'ecs',
      getContextWindow: () => 262144,
      chatCompletionStream: vi.fn((req: any) => {
        seenRequests.push(structuredClone(req));
        const index = call++;
        return (async function* () {
          if (index === 3) {
            yield { type: 'content', text: 'final visual answer' };
            return streamResult({ content: 'final visual answer' });
          }
          const name = index === 1 ? 'search_items' : 'browser_screenshot';
          const id = `vision_${index}`;
          return streamResult({
            toolCalls: [{ id, type: 'function', function: { name, arguments: name === 'browser_screenshot' ? '{"tabId":"tab_1"}' : '{"query":"follow-up"}' } }],
            finishReason: 'tool_calls',
          });
        })();
      }),
    };
    let screenshots = 0;
    const toolExecutor = {
      executeTool: vi.fn(async (toolCall: any) => {
        if (toolCall.function.name !== 'browser_screenshot') return { content: 'follow-up complete' };
        const dataUrl = screenshots++ === 0 ? firstImage : secondImage;
        return {
          content: JSON.stringify({ filePath: `/tmp/shot-${screenshots}.png` }),
          imageEvidence: [{
            dataUrl,
            evidenceKey: 'browser:tab_1',
            source: 'browser_screenshot',
            mimeType: 'image/jpeg',
            bytes: 900,
            width: 100,
            height: 100,
          }],
        };
      }),
    };
    const app = buildApp(makeDeps(db, llmClient, toolExecutor));
    const res = await request(app).post('/api/chat/messages').send({ message: 'inspect twice', stream: true });

    const images = (requestIndex: number) => seenRequests[requestIndex].messages.flatMap((message: any) => message.images ?? []);
    expect(images(1)).toEqual([firstImage]);
    expect(images(2)).toEqual([firstImage]); // survives non-image follow-up
    expect(images(3)).toEqual([secondImage]);
    expect(seenRequests[3].messages.some((message: any) => String(message.content).includes('superseded by a newer capture'))).toBe(true);
    expect(res.text).toContain('final visual answer');
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

    expect(res.text).toContain('runaway ceiling');
    const lastMsg = db.prepare("SELECT content FROM chat_messages WHERE role='assistant' ORDER BY created_at DESC LIMIT 1").get() as any;
    expect(lastMsg.content).toContain('runaway ceiling of 500');
  });
});

describe('chat payload rejection recovery', () => {
  it('rebuilds one smaller image-free continuation, resumes tools, and completes the original turn', async () => {
    const storage = createStorage(':memory:');
    storage.initialize();
    const db = storage.getDb();
    try {
      const seenRequests: any[] = [];
      const screenshot = `data:image/jpeg;base64,${'P'.repeat(4_200)}`;
      let call = 0;
      const llmClient = {
        getActiveEndpoint: () => 'ecs',
        getContextWindow: () => 262144,
        chatCompletionStream: vi.fn((req: any) => {
          seenRequests.push(structuredClone(req));
          const index = call++;
          return (async function* () {
            if (index === 0) {
              return streamResult({
                toolCalls: [{ id: 'shot_1', type: 'function', function: { name: 'browser_screenshot', arguments: '{"tabId":"tab_1"}' } }],
                finishReason: 'tool_calls',
              });
            }
            if (index === 1) {
              throw new LlmPayloadTooLargeError(
                { bodyChars: 6_099_000, bodyBytes: 6_100_000, imageCount: 1, imageChars: screenshot.length },
                5_500_000,
              );
            }
            if (index === 2) {
              return streamResult({
                toolCalls: [{ id: 'search_1', type: 'function', function: { name: 'search_items', arguments: '{"query":"continue original task"}' } }],
                finishReason: 'tool_calls',
              });
            }
            yield { type: 'content', text: 'I resumed the original task and finished it from the focused evidence.' };
            return streamResult({ content: 'I resumed the original task and finished it from the focused evidence.' });
          })();
        }),
      };
      const toolExecutor = {
        executeTool: vi.fn(async (toolCall: any) => toolCall.function.name === 'browser_screenshot'
          ? {
              content: '{"filePath":"/tmp/full-owner.png","tabId":"tab_1"}',
              imageEvidence: [{
                dataUrl: screenshot,
                evidenceKey: 'browser:tab_1',
                source: 'browser_screenshot',
                mimeType: 'image/jpeg',
                bytes: 3_000,
                width: 100,
                height: 100,
              }],
            }
          : { content: '{"matches":["focused evidence"]}' }),
      };
      const app = buildApp(makeDeps(db, llmClient, toolExecutor));

      const res = await request(app)
        .post('/api/chat/messages')
        .send({ message: 'inspect the page and finish the task', stream: true });

      expect(llmClient.chatCompletionStream).toHaveBeenCalledTimes(4);
      expect(toolExecutor.executeTool).toHaveBeenCalledTimes(2);
      expect(seenRequests[1].messages.flatMap((message: any) => message.images ?? [])).toEqual([screenshot]);
      expect(seenRequests[2].messages.flatMap((message: any) => message.images ?? [])).toEqual([]);
      expect(seenRequests[2].payloadConstraint).toEqual({
        requireImageFree: true,
        smallerThanBytes: 6_100_000,
      });
      const recoveryNote = seenRequests[2].messages.at(-1)?.content ?? '';
      expect(recoveryNote).toContain('continue the same owner task');
      expect(recoveryNote).toContain('NO image pixels');
      expect(recoveryNote).toContain('Never claim visual verification');
      const rejectedOwnerMessages = seenRequests[1].messages
        .filter((message: any) => message.role === 'user' && !message.visionEvidenceSource)
        .map((message: any) => message.content);
      const recoveryOwnerMessages = seenRequests[2].messages
        .filter((message: any) => message.role === 'user' && !message.visionEvidenceSource)
        .slice(0, rejectedOwnerMessages.length)
        .map((message: any) => message.content);
      expect(recoveryOwnerMessages).toEqual(rejectedOwnerMessages);
      expect(seenRequests[2].messages.some((message: any) => String(message.content).includes('/tmp/full-owner.png'))).toBe(true);
      expect(res.text).toContain('"reason":"payload_size"');
      expect(res.text).toContain('I resumed the original task and finished it');
      expect(res.text).not.toContain('This turn failed before I could finish');
      const lastMsg = db.prepare("SELECT content FROM chat_messages WHERE role='assistant' ORDER BY created_at DESC LIMIT 1").get() as any;
      expect(lastMsg.content).toContain('finished it from the focused evidence');
    } finally {
      storage.close();
    }
  });

  it('spends the recovery budget once and fails honestly instead of looping on a second rejection', async () => {
    const storage = createStorage(':memory:');
    storage.initialize();
    const db = storage.getDb();
    try {
      const screenshot = 'data:image/jpeg;base64,AAAA';
      let call = 0;
      const llmClient = {
        getActiveEndpoint: () => 'ecs',
        getContextWindow: () => 262144,
        chatCompletionStream: vi.fn(() => {
          const index = call++;
          return (async function* () {
            if (index === 0) {
              return streamResult({
                toolCalls: [{ id: 'shot_1', type: 'function', function: { name: 'browser_screenshot', arguments: '{"tabId":"tab_1"}' } }],
                finishReason: 'tool_calls',
              });
            }
            throw new LlmPayloadTooLargeError(
              { bodyChars: 6_000_000, bodyBytes: 6_000_100, imageCount: index === 1 ? 1 : 0, imageChars: index === 1 ? screenshot.length : 0 },
              5_500_000,
            );
          })();
        }),
      };
      const toolExecutor = {
        executeTool: vi.fn(async () => ({
          content: '{"filePath":"/tmp/full-owner.png"}',
          imageEvidence: [{
            dataUrl: screenshot,
            evidenceKey: 'browser:tab_1',
            source: 'browser_screenshot',
            mimeType: 'image/jpeg',
            bytes: 4,
            width: 1,
            height: 1,
          }],
        })),
      };
      const app = buildApp(makeDeps(db, llmClient, toolExecutor));
      const res = await request(app).post('/api/chat/messages').send({ message: 'inspect', stream: true });

      expect(llmClient.chatCompletionStream).toHaveBeenCalledTimes(3);
      expect(res.text).toContain('"reason":"payload_size"');
      expect(res.text).toContain('This turn failed before I could finish');
    } finally {
      storage.close();
    }
  });
});

describe('chat visual asset manifest and grounding gate', () => {
  it('keeps attachment pixels out of the main prompt and requires a successful inspection receipt before visual claims', async () => {
    const storage = createStorage(':memory:');
    storage.initialize();
    const db = storage.getDb();
    const tinyPng = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const attachment = saveChatAttachment(tinyPng);
    const attachmentPath = path.join(os.homedir(), '.personal-productivity-tracker', 'chat-attachments', `${attachment.id}.png`);
    try {
      const assetId = 'va_0123456789abcdef0123456789abcdef';
      const visualRecord = {
        assetId,
        versionId: 'vav_0123456789abcdef0123456789abcdef',
        ordinal: 1,
        sha256: 'a'.repeat(64),
        bytes: 67,
        mime: 'image/png',
        width: 1,
        height: 1,
        ownerKind: 'chat_attachment',
        ownerId: attachment.id,
        originalUrl: `/api/visual-assets/${assetId}/original`,
        createdAt: new Date().toISOString(),
      };
      const visualAssets = {
        getByReference: vi.fn(() => visualRecord),
        formatManifest: vi.fn(() => `VISUAL ASSETS AVAILABLE LOCALLY (pixels are not in this prompt and have not been inspected):\n- ${assetId} version=${visualRecord.versionId}`),
      };
      const seenRequests: any[] = [];
      let call = 0;
      const llmClient = {
        getActiveEndpoint: () => 'ecs',
        getContextWindow: () => 262144,
        getDefaultModel: () => 'openai.gpt-5.6-terra',
        chatCompletionStream: vi.fn((request: any) => {
          seenRequests.push(structuredClone(request));
          const index = call++;
          return (async function* () {
            if (index === 0) {
              yield { type: 'content', text: 'The attached image looks correct.' };
              return streamResult({ content: 'The attached image looks correct.' });
            }
            if (index === 1) {
              return streamResult({
                toolCalls: [{
                  id: 'inspect_1',
                  type: 'function',
                  function: { name: 'inspect_visual_assets', arguments: JSON.stringify({ assetIds: [assetId], question: 'What is visibly present?' }) },
                }],
                finishReason: 'tool_calls',
              });
            }
            yield { type: 'content', text: 'Inspection verified the visible content.' };
            return streamResult({ content: 'Inspection verified the visible content.' });
          })();
        }),
      };
      const toolExecutor = {
        executeTool: vi.fn(async (_toolCall: any, context: any) => ({
          content: JSON.stringify({ ok: true, runId: 'vir_test', coverage: { eligible: 1, inspected: 1, complete: true }, receiptSha256: 'b'.repeat(64) }),
          isError: false,
          context,
        })),
      };
      const deps: any = makeDeps(db, llmClient, toolExecutor);
      deps.visualAssets = visualAssets;
      deps.promptManager.getToolDefinitions = () => [{
        type: 'function',
        function: { name: 'inspect_visual_assets', description: 'inspect', parameters: {} },
      }];
      const app = buildApp(deps);

      const response = await request(app).post('/api/chat/messages').send({
        message: 'What is in this image?',
        stream: true,
        attachments: [attachment.id],
      });

      expect(response.text).toContain('"reason":"visual_grounding"');
      expect(response.text).toContain('Inspection verified the visible content.');
      expect(response.text).not.toContain('were not inspected in this turn');
      expect(llmClient.chatCompletionStream).toHaveBeenCalledTimes(3);
      expect(seenRequests[0].messages.flatMap((message: any) => message.images ?? [])).toEqual([]);
      expect(seenRequests[0].messages.some((message: any) => String(message.content).includes(assetId))).toBe(true);
      expect(toolExecutor.executeTool).toHaveBeenCalledTimes(1);
      expect(toolExecutor.executeTool.mock.calls[0][1]).toMatchObject({
        currentUserMessage: 'What is in this image?',
        callerKind: 'interactive',
      });
    } finally {
      storage.close();
      fs.rmSync(attachmentPath, { force: true });
    }
  });
});