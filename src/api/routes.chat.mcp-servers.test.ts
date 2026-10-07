import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import type Database from 'better-sqlite3';
import { createStorage, type StorageLayer } from '../core/storage.js';
import { createNodeManager } from '../core/node-manager.js';
import { createRouter } from './routes.js';
import { mcpServerIdFromToolResult, withMcpServerCards } from '../core/mcp-custom-config.js';

/**
 * The chat loop around MCP server setup (MCP_REMOTE_TRANSPORTS_PLAN.md MR1):
 * every server BotBoy adds or changes in a turn reaches the owner as its
 * review card, and "I've added it" is true once the add receipt exists.
 * Same harness as routes.chat.gmail.test.ts.
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
      getToolDefinitions: () => [{ type: 'function', function: { name: 'mcp_add_custom_server', description: 'add', parameters: {} } }],
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
      getRecentMessages: () => [{ role: 'user' as const, content: 'add deepwiki' }],
      saveSummary: vi.fn(),
    } as any,
  };
}

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

describe('chat loop around MCP server setup', () => {
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
  const added = JSON.stringify({ ok: true, action: 'created', serverId: 'custom-deepwiki', card: '[[mcp-server:custom-deepwiki]]', needsReview: true });
  const addCall = { name: 'mcp_add_custom_server', arguments: '{"name":"DeepWiki","url":"https://mcp.deepwiki.com/mcp","ownerRequested":true}' };

  it('appends the card of a server the reply did not show, and the add receipt licenses "I\'ve added"', async () => {
    const llm = scriptedModel(addCall, ["I've added DeepWiki. Press Start on its card to connect."]);
    const executor = { executeTool: vi.fn(async () => ({ content: added })) };
    const res = await request(app(llm, executor)).post('/api/chat/messages').send({ message: 'add the deepwiki mcp', stream: true });
    expect(llm.chatCompletionStream).toHaveBeenCalledTimes(2);
    expect(res.text).not.toContain('"type":"retry"');
    expect(lastReply()).toBe("I've added DeepWiki. Press Start on its card to connect.\n\n[[mcp-server:custom-deepwiki]]");
  });

  it('a refused add does not license the claim', async () => {
    const llm = scriptedModel(addCall, ["I've added DeepWiki.", 'I could not add DeepWiki yet: the address was refused.']);
    const executor = { executeTool: vi.fn(async () => ({ content: 'Error: url must use https://' })) };
    const res = await request(app(llm, executor)).post('/api/chat/messages').send({ message: 'add the deepwiki mcp', stream: true });
    expect(res.text).toContain('"type":"retry"');
    expect(lastReply()).toBe('I could not add DeepWiki yet: the address was refused.');
    expect(lastReply()).not.toContain('[[mcp-server:');
  });
});

describe('MCP server card markers', () => {
  it('reads the server id only from a successful add or update receipt', () => {
    expect(mcpServerIdFromToolResult('mcp_add_custom_server', JSON.stringify({ ok: true, serverId: 'custom-x' }))).toBe('custom-x');
    expect(mcpServerIdFromToolResult('mcp_update_custom_server', JSON.stringify({ ok: true, serverId: 'custom-x-2' }))).toBe('custom-x-2');
    expect(mcpServerIdFromToolResult('mcp_add_custom_server', 'Error: name is required')).toBeNull();
    expect(mcpServerIdFromToolResult('mcp_add_custom_server', JSON.stringify({ ok: true, serverId: 'slack' }))).toBeNull();
    expect(mcpServerIdFromToolResult('mcp_call_tool', JSON.stringify({ ok: true, serverId: 'custom-x' }))).toBeNull();
  });

  it('adds each missing marker once on its own line and keeps placed ones', () => {
    expect(withMcpServerCards('Done. ', ['custom-a', 'custom-b', 'custom-a'])).toBe('Done.\n\n[[mcp-server:custom-a]]\n[[mcp-server:custom-b]]');
    expect(withMcpServerCards('See [[mcp-server:custom-a]]', ['custom-a'])).toBe('See [[mcp-server:custom-a]]');
    expect(withMcpServerCards('Nothing added.', [])).toBe('Nothing added.');
  });
});
