import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import type Database from 'better-sqlite3';
import { createStorage, type StorageLayer } from '../core/storage.js';
import { createNodeManager } from '../core/node-manager.js';
import { createRouter } from './routes.js';
import { isTransientStreamError } from './routers/chat.js';

/**
 * D2 of the DeepSeek diagnosability fixes (deepseek-failures report § 6): the chat route's `[Chat] Stream error:` log
 * line (/tmp/ppt.log, the first place a teammate's failure is looked up) carried the message and the stack but not the
 * network cause Node keeps one level down. It now adds the errno codes, and the bubble keeps its own text.
 */
const errno = (code: string, syscall = 'connect') => Object.assign(new Error(`${syscall} ${code}`), { code, syscall });

function appFor(db: Database.Database, chatCompletionStream: unknown) {
  const llmClient = { getActiveEndpoint: () => 'ecs', getContextWindow: () => 262144, chatCompletionStream };
  const deps: any = {
    nodeManager: createNodeManager(db),
    db,
    llmClient,
    toolExecutor: { executeTool: vi.fn() },
    chatInterface: { getHistory: () => [], sendMessage: async () => ({ message: { id: 'x', role: 'assistant', content: '' } }) },
    promptManager: { getSystemPrompt: () => 'You are a test bot.', getToolDefinitions: () => [] },
    conversationManager: {
      getActiveSessionId: () => null,
      createSession: () => 'sess-test',
      appendUser: vi.fn(),
      appendAssistant: vi.fn(),
      countUserMessages: () => 1,
      getSummary: () => null,
      getMessages: () => [],
      getMessagesSinceId: () => [],
      getRecentMessages: () => [{ role: 'user' as const, content: 'hello' }],
      saveSummary: vi.fn(),
    },
  };
  const app = express();
  app.use(express.json());
  app.use('/api', createRouter(deps));
  return app;
}

describe('the chat stream-error log line carries the network cause (D2)', () => {
  let storage: StorageLayer;
  let db: Database.Database;
  let errorLog: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    storage = createStorage(':memory:');
    storage.initialize();
    db = storage.getDb();
    errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    storage.close();
  });

  const streamErrorLine = () => errorLog.mock.calls.find(call => call[0] === '[Chat] Stream error:');

  it('adds the errno codes behind the message, and leaves the persisted ⚠️ message with the error\'s own text', async () => {
    const failure = Object.assign(new Error('provider call failed'), { cause: Object.assign(new AggregateError([errno('ETIMEDOUT'), errno('EHOSTUNREACH')], ''), { code: 'ETIMEDOUT' }) });
    const app = appFor(db, vi.fn(() => (async function* () { throw failure; })()));
    const res = await request(app).post('/api/chat/messages').send({ message: 'hi', stream: true });
    expect(res.status).toBe(200);
    const line = streamErrorLine();
    expect(line, 'a [Chat] Stream error: line was logged').toBeTruthy();
    expect(line![1]).toBe('provider call failed (ETIMEDOUT+EHOSTUNREACH)');
    expect(String(line![2])).toContain('Error: provider call failed');
    expect(res.text).toContain('This turn failed before I could finish: provider call failed.');
  });

  it('shows the words for a replaced certificate, and no address, header or key', async () => {
    const failure = Object.assign(new TypeError('fetch failed'), { cause: errno('DEPTH_ZERO_SELF_SIGNED_CERT') });
    // The real client already words this at its own rethrow; a failure from anywhere else in the turn gets it here.
    expect(isTransientStreamError(failure)).toBe(true);
    const app = appFor(db, vi.fn(() => (async function* () { throw failure; })()));
    await request(app).post('/api/chat/messages').send({ message: 'hi', stream: true });
    const line = streamErrorLine();
    expect(line![1]).toMatch(/^fetch failed \(DEPTH_ZERO_SELF_SIGNED_CERT: a proxy or security product/);
    expect(String(line![1])).not.toMatch(/127\.0\.0\.1|sk-|Bearer/);
  });

  it('logs a failure with no network cause exactly as before', async () => {
    const app = appFor(db, vi.fn(() => (async function* () { throw new Error('HTTP 400: {"error":{"message":"bad"}}'); })()));
    await request(app).post('/api/chat/messages').send({ message: 'hi', stream: true });
    expect(streamErrorLine()![1]).toBe('HTTP 400: {"error":{"message":"bad"}}');
  });
});
