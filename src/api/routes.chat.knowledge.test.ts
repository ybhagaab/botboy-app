/**
 * The chat turn and the Knowledge library (knowledge-library.md K7, K9): the standing line and the matched set's file table
 * reach the system prompt, the two tools are offered only once the library exists, a whole-file load is told how much room
 * the next prompt has, a blocked folder never delays or fails the turn, and an install with no library sees no change.
 * Same harness as routes.chat.mcp-servers.test.ts, with the real prompt manager.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerCaptureExcludedRoots } from '../core/capture-exclusions.js';
import { sampleLibraryFiles, writeTree } from '../core/knowledge-fixtures.testutil.js';
import { createKnowledgeLibrary, type KnowledgeLibrary } from '../core/knowledge-library.js';
import { canonicalRootOrNull, emptyKnowledgeState, knowledgeExcludedRoots, writeKnowledgeState } from '../core/knowledge-root.js';
import { createNodeManager } from '../core/node-manager.js';
import { createPromptManager } from '../core/prompt-manager.js';
import { registerWriteProtectedRoots } from '../core/protected-local-resources.js';
import { createStorage, type StorageLayer } from '../core/storage.js';
import { createRouter } from './routes.js';

function streamResult(partial: Record<string, unknown>) {
  return { content: '', reasoning: '', toolCalls: [], usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, finishReason: 'stop', ...partial };
}

let storage: StorageLayer;
let db: Database.Database;
let base: string;
let root: string;
let library: KnowledgeLibrary;

function makeApp(options: { library?: KnowledgeLibrary; llm: any; executor?: any }) {
  const deps: any = {
    nodeManager: createNodeManager(db),
    db,
    llmClient: options.llm,
    toolExecutor: options.executor ?? { executeTool: vi.fn(async () => ({ content: 'ok' })) },
    chatInterface: { getHistory: () => [], sendMessage: async () => ({ message: { id: 'x', role: 'assistant', content: '' } }) } as any,
    promptManager: createPromptManager(),
    conversationManager: {
      getActiveSessionId: () => null, createSession: () => 'sess-test', appendUser: vi.fn(), appendAssistant: vi.fn(),
      countUserMessages: () => 1, getSummary: () => null, getMessages: () => [], getMessagesSinceId: () => [],
      getRecentMessages: () => [{ role: 'user' as const, content: 'hello' }], saveSummary: vi.fn(),
    } as any,
    ...(options.library ? { knowledgeLibrary: options.library } : {}),
  };
  const server = express();
  server.use(express.json());
  server.use('/api', createRouter(deps));
  return server;
}

/** A model that records every request and answers with plain text, or calls one tool first. */
function recordingModel(toolFirst?: { name: string; arguments: string }) {
  const requests: any[] = [];
  let call = 0;
  const llm = {
    getActiveEndpoint: () => 'ecs',
    chatCompletionStream: vi.fn((req: any) => {
      requests.push(req);
      call += 1;
      return (async function* () {
        if (toolFirst && call === 1) {
          yield { type: 'tool_call_start', toolCall: { index: 0, id: 'k1', name: toolFirst.name } };
          return streamResult({ toolCalls: [{ id: 'k1', type: 'function', function: toolFirst }], finishReason: 'tool_calls' });
        }
        yield { type: 'content', text: 'Done.' };
        return streamResult({ content: 'Done.' });
      })();
    }),
  };
  return { llm, requests };
}
const systemPromptOf = (req: any): string => String(req.messages.find((message: any) => message.role === 'system')?.content ?? '');
const toolNamesOf = (req: any): string[] => (req.tools ?? []).map((tool: any) => tool.function.name);

beforeEach(() => {
  storage = createStorage(':memory:');
  storage.initialize();
  db = storage.getDb();
  base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'kl-chat-')));
  const home = path.join(base, 'home');
  fs.mkdirSync(home, { recursive: true });
  vi.stubEnv('HOME', home);
  root = path.join(base, 'BotBoy Knowledge');
  registerWriteProtectedRoots(() => canonicalRootOrNull(db));
  registerCaptureExcludedRoots(() => knowledgeExcludedRoots(db));
});

afterEach(() => {
  registerWriteProtectedRoots(null);
  registerCaptureExcludedRoots(null);
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  storage.close();
  fs.rmSync(base, { recursive: true, force: true });
});

function activate(files: Record<string, string> = sampleLibraryFiles()) {
  writeTree(root, files);
  writeKnowledgeState(db, { ...emptyKnowledgeState(), root, analyticsDir: 'library' });
  library = createKnowledgeLibrary({ db });
}

describe('an install that never created the library', () => {
  it('sees no library text and no library tools, with or without the service present', async () => {
    const withService = recordingModel();
    await request(makeApp({ library: createKnowledgeLibrary({ db }), llm: withService.llm })).post('/api/chat/messages').send({ message: 'hello', stream: true });
    const without = recordingModel();
    await request(makeApp({ llm: without.llm })).post('/api/chat/messages').send({ message: 'hello', stream: true });
    for (const recorded of [withService, without]) {
      expect(systemPromptOf(recorded.requests[0])).not.toMatch(/Knowledge library/);
      expect(toolNamesOf(recorded.requests[0])).not.toContain('knowledge_list');
      expect(toolNamesOf(recorded.requests[0])).not.toContain('knowledge_load');
    }
    expect(systemPromptOf(withService.requests[0])).toBe(systemPromptOf(without.requests[0]));
  });
});

describe('a library with sets', () => {
  beforeEach(() => activate());

  it('puts the standing line in every turn and offers both tools', async () => {
    const model = recordingModel();
    await request(makeApp({ library, llm: model.llm })).post('/api/chat/messages').send({ message: 'hello there', stream: true });
    const prompt = systemPromptOf(model.requests[0]);
    expect(prompt).toMatch(/Knowledge library: .*commands cannot change it\./);
    expect(prompt).not.toContain('<external_untrusted_knowledge_guide');
    expect(toolNamesOf(model.requests[0])).toEqual(expect.arrayContaining(['knowledge_list', 'knowledge_load']));
  });

  it('adds the matched set\'s file table, and only that set\'s, when the message is about it', async () => {
    const model = recordingModel();
    await request(makeApp({ library, llm: model.llm })).post('/api/chat/messages').send({ message: 'open the shop-data reference for orders', stream: true });
    const prompt = systemPromptOf(model.requests[0]);
    expect(prompt).toContain('<external_untrusted_knowledge_guide set="shop-data" kind="generic" purpose="preview">');
    expect(prompt).toContain('- orders.md: SQL schemas, performance rules, query patterns, table routing');
    expect(prompt).not.toContain('ideas.md');
    expect(prompt.indexOf('Knowledge library:')).toBeLessThan(prompt.indexOf('<external_untrusted_knowledge_guide'));
  });

  it('tells a tool how much room the next prompt has, so a whole-file load stays under it', async () => {
    const executor = { executeTool: vi.fn(async () => ({ content: 'loaded' })) };
    const model = recordingModel({ name: 'knowledge_load', arguments: '{"set":"shop-data","file":"orders.md"}' });
    await request(makeApp({ library, llm: model.llm, executor })).post('/api/chat/messages').send({ message: 'load the orders reference', stream: true });
    expect(executor.executeTool).toHaveBeenCalledTimes(1);
    const context = (executor.executeTool.mock.calls[0] as unknown as [unknown, { promptHeadroomTokens?: number }])[1];
    expect(typeof context.promptHeadroomTokens).toBe('number');
    expect(context.promptHeadroomTokens).toBeGreaterThan(1_000);
  });

  it('a folder macOS blocks skips the block, keeps the tools, and never fails or delays the turn', async () => {
    const real = fs.promises.readdir.bind(fs.promises);
    vi.spyOn(fs.promises, 'readdir').mockImplementation(((target: unknown, ...rest: unknown[]) => {
      if (String(target) === root) return Promise.reject(Object.assign(new Error('nope'), { code: 'EPERM' }));
      return (real as (...a: unknown[]) => unknown)(target, ...rest);
    }) as never);
    const model = recordingModel();
    const response = await request(makeApp({ library, llm: model.llm })).post('/api/chat/messages').send({ message: 'open the shop-data reference', stream: true });
    expect(response.status).toBe(200);
    expect(response.text).not.toContain('"type":"error"');
    expect(systemPromptOf(model.requests[0])).not.toMatch(/Knowledge library/);
    expect(toolNamesOf(model.requests[0])).toContain('knowledge_load');
  });

  it('the analytics briefing and a library with no sets: an empty library gives no block but still offers the tools', async () => {
    fs.rmSync(path.join(root, 'shop-data'), { recursive: true });
    for (const name of ['analytics', 'memory', 'notes']) fs.rmSync(path.join(root, name), { recursive: true });
    const model = recordingModel();
    await request(makeApp({ library: createKnowledgeLibrary({ db }), llm: model.llm })).post('/api/chat/messages').send({ message: 'hello', stream: true });
    expect(systemPromptOf(model.requests[0])).not.toMatch(/Knowledge library/);
    expect(toolNamesOf(model.requests[0])).toContain('knowledge_list');
  });
});
