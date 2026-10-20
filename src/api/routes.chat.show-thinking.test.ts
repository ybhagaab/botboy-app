import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import type Database from 'better-sqlite3';
import { createStorage, type StorageLayer } from '../core/storage.js';
import { createNodeManager } from '../core/node-manager.js';
import { createChatThinkingDisplay, type ChatThinkingDisplay } from '../core/chat-thinking-display.js';
import { createRouter } from './routes.js';

/**
 * Settings → AI model → Show model thinking in the chat route: read once per
 * turn; on, a turn whose Thinking is not Off asks the model for readable
 * thinking and streams it; off, nothing is asked for and no thinking text
 * reaches the panel, whatever the provider sends.
 */
const THOUGHT = '**Plan**\n\nLook it up.';

function streamResult(partial: Record<string, unknown>) {
  return { content: '', reasoning: '', toolCalls: [], usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, finishReason: 'stop', ...partial };
}

function thinkingModel() {
  const requests: any[] = [];
  return {
    requests,
    getActiveEndpoint: () => 'ecs',
    chatCompletionStream: vi.fn((req: any) => {
      requests.push(req);
      return (async function* () {
        // Sent whatever was asked, as DeepSeek does.
        yield { type: 'thinking', text: THOUGHT };
        yield { type: 'content', text: 'Answer.' };
        return streamResult({ content: 'Answer.', reasoning: THOUGHT });
      })();
    }),
  };
}

function events(text: string): any[] {
  return text.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)));
}

describe('Show model thinking in the chat route', () => {
  let storage: StorageLayer;
  let db: Database.Database;
  beforeEach(() => {
    storage = createStorage(':memory:');
    storage.initialize();
    db = storage.getDb();
  });
  afterEach(() => storage.close());

  function makeApp(llmClient: any, chatThinking?: ChatThinkingDisplay) {
    const server = express();
    server.use(express.json());
    server.use('/api', createRouter({
      nodeManager: createNodeManager(db),
      db,
      llmClient,
      toolExecutor: { executeTool: vi.fn() },
      ...(chatThinking ? { chatThinking } : {}),
      chatInterface: { getHistory: () => [], sendMessage: async () => ({ message: { id: 'x', role: 'assistant', content: '' } }) } as any,
      promptManager: { getSystemPrompt: () => 'You are a test bot.', getToolDefinitions: () => [] } as any,
      conversationManager: {
        getActiveSessionId: () => 'sess-test',
        createSession: () => 'sess-test',
        appendUser: vi.fn(),
        appendAssistant: vi.fn(),
        countUserMessages: () => 1,
        getSummary: () => null,
        getMessages: () => [],
        getMessagesSinceId: () => [],
        getRecentMessages: () => [{ role: 'user' as const, content: 'latest' }],
        saveSummary: vi.fn(),
      } as any,
    } as any));
    return server;
  }

  const turn = (app: express.Express, thinking?: string) =>
    request(app).post('/api/chat/messages').send({ message: 'what is on my plate?', stream: true, ...(thinking ? { thinking } : {}) });

  it('on: a thinking turn asks for readable thinking and streams it with the reply', async () => {
    const llm = thinkingModel();
    const display = createChatThinkingDisplay({ db });
    const res = await turn(makeApp(llm, display), 'high');
    expect(res.status).toBe(200);
    expect(llm.requests[0]).toMatchObject({ think: true, reasoningEffort: 'high', showThinking: true, usageContext: { workload: 'interactive' } });
    const sent = events(res.text);
    expect(sent.filter(event => event.type === 'thinking').map(event => event.text)).toEqual([THOUGHT]);
    expect(sent.find(event => event.type === 'done').message).toMatchObject({ content: 'Answer.', reasoning: THOUGHT });
  });

  it('on, with Thinking Off: nothing is asked for; text a provider sends anyway still shows', async () => {
    const llm = thinkingModel();
    const res = await turn(makeApp(llm, createChatThinkingDisplay({ db })));
    expect(llm.requests[0].think).toBe(false);
    expect(llm.requests[0]).not.toHaveProperty('showThinking');
    expect(events(res.text).some(event => event.type === 'thinking')).toBe(true);
  });

  it('off: nothing is asked for and no thinking text leaves the server, the reply unchanged', async () => {
    const llm = thinkingModel();
    const display = createChatThinkingDisplay({ db });
    display.setShowThinking(false);
    const res = await turn(makeApp(llm, display), 'max');
    expect(llm.requests[0]).toMatchObject({ think: true, reasoningEffort: 'max' });
    expect(llm.requests[0]).not.toHaveProperty('showThinking');
    const sent = events(res.text);
    expect(sent.some(event => event.type === 'thinking')).toBe(false);
    expect(res.text).not.toContain('Look it up');
    expect(sent.filter(event => event.type === 'token').map(event => event.text).join('')).toBe('Answer.');
    const done = sent.find(event => event.type === 'done').message;
    expect(done.content).toBe('Answer.');
    expect(done).not.toHaveProperty('reasoning');
  });

  it('reads the choice per turn: turning it back on applies to the next message', async () => {
    const llm = thinkingModel();
    const display = createChatThinkingDisplay({ db });
    display.setShowThinking(false);
    const app = makeApp(llm, display);
    expect(events((await turn(app, 'low')).text).some(event => event.type === 'thinking')).toBe(false);
    display.setShowThinking(true);
    expect(events((await turn(app, 'low')).text).some(event => event.type === 'thinking')).toBe(true);
    expect(llm.requests.map(req => req.showThinking)).toEqual([undefined, true]);
  });

  it('without the setting wired (older callers) behaves as on', async () => {
    const llm = thinkingModel();
    const res = await turn(makeApp(llm), 'low');
    expect(llm.requests[0].showThinking).toBe(true);
    expect(events(res.text).some(event => event.type === 'thinking')).toBe(true);
  });
});
