import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import type Database from 'better-sqlite3';
import { createStorage, type StorageLayer } from '../core/storage.js';
import { createNodeManager } from '../core/node-manager.js';
import { createConversationManager, type ConversationManager } from '../core/conversation-manager.js';
import { CHAT_HISTORY_OMITTED_NOTE } from '../core/chat-history-window.js';
import { CONTINUATION_TRIGGER_HEADER } from '../core/chat-continuations.js';
import type { ToolExecutor } from '../core/tool-executor.js';
import { createRouter } from './routes.js';

/**
 * What a real chat turn sends (docs/maps/chat-agent.md "Chat history window"): the window replaced the fixed 20 newest messages, so
 * the model gets the conversation up to the budget and the owner's own last messages behind a long automatic job. The real
 * conversation manager on SQLite; the model is scripted and records each request.
 */
function streamResult(partial: Record<string, unknown>) {
  return { content: '', reasoning: '', toolCalls: [], usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, finishReason: 'stop', ...partial };
}

describe('chat turn history window', () => {
  let storage: StorageLayer;
  let db: Database.Database;
  let cm: ConversationManager;
  let requests: any[];
  beforeEach(() => {
    storage = createStorage(':memory:');
    storage.initialize();
    db = storage.getDb();
    cm = createConversationManager(db);
    requests = [];
  });
  afterEach(() => storage.close());

  function app(contextWindow: number) {
    const llmClient = {
      getActiveEndpoint: () => 'ecs',
      getContextWindow: () => contextWindow,
      chatCompletionStream: vi.fn((req: any) => {
        requests.push(req);
        return (async function* () {
          yield { type: 'content', text: 'Noted.' };
          return streamResult({ content: 'Noted.' });
        })();
      }),
    };
    const toolExecutor: ToolExecutor = { executeTool: vi.fn(async (c) => ({ toolCallId: c.id, content: 'unused', isError: true })) };
    const server = express();
    server.use(express.json());
    server.use('/api', createRouter({
      nodeManager: createNodeManager(db),
      db,
      llmClient: llmClient as any,
      toolExecutor,
      chatInterface: { getHistory: () => [], sendMessage: async () => ({ message: { id: 'x', role: 'assistant', content: '' } }) } as any,
      promptManager: { getSystemPrompt: () => 'SYSTEM PROMPT', getToolDefinitions: () => [] } as any,
      conversationManager: cm,
    }));
    return server;
  }
  const say = (server: express.Express, message: string) => request(server).post('/api/chat/messages').send({ message, stream: true });
  const history = () => (requests[0].messages as any[]).slice(1);

  it('sends far more than the old 20 messages when the model has room', async () => {
    const sid = cm.createSession('chat');
    // About 4,100 tokens in all: more than a 32K model's 3,276-token budget, well inside the 1M model's 50K.
    for (let i = 0; i < 40; i += 1) { cm.appendUser(sid, `question ${i}`); cm.appendAssistant(sid, `answer ${i} `.padEnd(400, '.')); }
    await say(app(1_000_000), 'question 40');
    const sent = history();
    expect(sent).toHaveLength(81);
    expect(sent[0]).toMatchObject({ role: 'user', content: 'question 0' });
    expect(sent.at(-1)).toMatchObject({ role: 'user', content: 'question 40' });
    // No automatic turns were left out, so the system prompt is unchanged.
    expect(requests[0].messages[0].content).toBe('SYSTEM PROMPT');
  });

  it('keeps the owner\'s last 15 messages behind a long automatic job, and says what was left out', async () => {
    const sid = cm.createSession('chat');
    for (let i = 0; i < 30; i += 1) { cm.appendUser(sid, `owner message ${i}`); cm.appendAssistant(sid, `reply ${i}`); }
    for (let i = 0; i < 100; i += 1) {
      cm.appendUser(sid, `${CONTINUATION_TRIGGER_HEADER}\nWhy this turn started: the job's next step.`);
      cm.appendAssistant(sid, `report ${i} `.padEnd(4_000, '.'));
    }
    const rows = db.prepare('SELECT id FROM llm_messages WHERE session_id = ? ORDER BY rowid').all(sid) as Array<{ id: string }>;
    cm.saveSummary(sid, 'The owner is studying how customers reach the home screen.', rows[0].id, rows.at(-1)!.id, 130);
    await say(app(1_000_000), 'the newest instruction');
    const texts = history().map((message: any) => message.content);
    for (let i = 16; i < 30; i += 1) expect(texts, `owner message ${i}`).toContain(`owner message ${i}`);
    expect(texts).not.toContain('owner message 15');
    expect(texts.at(-1)).toBe('the newest instruction');
    expect(texts.slice(0, 2)).toEqual(['owner message 16', 'reply 16']);
    // The summary keeps its place and wording; the note about the left-out turns comes after it.
    expect(requests[0].messages[0].content).toBe([
      'SYSTEM PROMPT',
      '## Conversation Summary (use get_chat_messages tool to retrieve full messages by ID range if you need more context)\nThe owner is studying how customers reach the home screen.',
      CHAT_HISTORY_OMITTED_NOTE,
    ].join('\n\n'));
  });

  it('a small model keeps about the old 20 messages', async () => {
    const sid = cm.createSession('chat');
    for (let i = 0; i < 40; i += 1) { cm.appendUser(sid, `question ${i}`); cm.appendAssistant(sid, `answer ${i} `.padEnd(1_600, '.')); }
    await say(app(32_768), 'question 40');
    const sent = history();
    // A 32K model has 3,276 tokens of budget and the 20 newest already take about 4,000: the old 20, the question before them,
    // and two older questions of the owner's with their answers (the 819-token allowance for the owner's messages). Never the chat.
    expect(sent).toHaveLength(25);
    expect(sent[0]).toMatchObject({ role: 'user', content: 'question 28' });
    expect(sent.at(-1)).toMatchObject({ content: 'question 40' });
  });
});
