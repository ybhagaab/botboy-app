import express from 'express';
import request from 'supertest';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createStorage, type StorageLayer } from '../core/storage.js';
import { createNodeManager } from '../core/node-manager.js';
import { createConnectionChatModelSource } from '../core/chat-model-source.js';
import { currentLlmModelOperation } from '../core/llm-model-operation.js';
import { deepSeekModelEntries, teamModelEntries, type LlmConnection } from '../core/llm-model-catalog.js';
import { createRouter } from './routes.js';

/**
 * Chat across several model connections (Settings → AI model): one grouped
 * catalog, each turn pinned to the connection of the picked model, tool
 * executions inside that connection's model operation (so data checks judge
 * where results go), and stops scoped to the connection that changed.
 */
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

function connection(id: 'team' | 'deepseek', stream: ReturnType<typeof vi.fn>): LlmConnection {
  const client = {
    getDefaultModel: () => (id === 'team' ? 'bedrock-mantle-luna/openai.gpt-5.6-terra' : 'deepseek-flash'),
    getProviderId: () => (id === 'team' ? 'gateway' : 'deepseek'),
    getActiveEndpoint: () => 'ecs',
    getMaxCompletionTokens: () => 16_384,
    getContextBudgetTokens: () => 100_000,
    isAvailable: () => true,
    chatCompletionStream: stream,
    chatCompletion: vi.fn(),
    close: () => {},
  } as any;
  return id === 'team'
    ? {
        id, label: 'Team gateway', source: 'environment', client, version: 1,
        provider: { id: 'gateway', endpoint: 'https://gateway.test/inference/v1', model: 'bedrock-mantle-luna/openai.gpt-5.6-terra', apiMode: 'responses' },
        models: teamModelEntries({ providerId: 'gateway', defaultModel: 'bedrock-mantle-luna/openai.gpt-5.6-terra', maxContextTokens: 1_000_000, maxCompletionTokens: 16_384, env: { BOTBOY_INFERENCE_GPT6_ROLLOUT: 'off' } }),
      }
    : {
        id, label: 'DeepSeek', source: 'settings', client, version: 2,
        provider: { id: 'deepseek', endpoint: 'https://api.deepseek.test', model: 'deepseek-flash', apiMode: 'responses' },
        models: deepSeekModelEntries([
          { id: 'deepseek-flash', name: 'DeepSeek V4.1 Flash', images: true, contextWindow: 1_000_000, maxOutputTokens: 384_000 },
          { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', images: false, contextWindow: 1_000_000, maxOutputTokens: 384_000 },
        ], 'deepseek-flash'),
      };
}

function setup(db: Database.Database, streams: { team: ReturnType<typeof vi.fn>; deepseek: ReturnType<typeof vi.fn> }, executeTool = vi.fn()) {
  const connections = [connection('team', streams.team), connection('deepseek', streams.deepseek)];
  const listeners = new Set<(event: { connectionId: string }) => void>();
  const chatModels = createConnectionChatModelSource({
    connections: () => connections,
    defaultKey: () => 'team.terra',
    onChange: listener => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  });
  const app = express();
  app.use(express.json());
  app.use('/api', createRouter({
    nodeManager: createNodeManager(db),
    db,
    llmClient: connections[0].client,
    aiModelSettings: { state: () => 'ready', version: () => 3, status: vi.fn(), chatModels } as any,
    toolExecutor: { executeTool },
    chatInterface: {
      getHistory: () => [],
      sendMessage: async () => ({ message: { id: 'x', role: 'assistant', content: '' } }),
    } as any,
    promptManager: {
      getSystemPrompt: () => 'You are a test bot.',
      getToolDefinitions: () => [{ type: 'function', function: { name: 'search_items', description: 'search', parameters: {} } }],
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
      getRecentMessages: () => [{ role: 'user' as const, content: 'hello' }],
      saveSummary: vi.fn(),
    } as any,
  } as any));
  const emit = (connectionId: string) => { for (const listener of [...listeners]) listener({ connectionId }); };
  return { app, emit };
}

function hangingStream() {
  return vi.fn((input: any) => (async function* () {
    await new Promise((_resolve, reject) => {
      const signal: AbortSignal = input.signal;
      if (signal.aborted) reject(signal.reason);
      signal.addEventListener('abort', () => reject(signal.reason ?? new Error('aborted')), { once: true });
    });
    return streamResult({});
  })());
}

describe('chat across model connections', () => {
  let storage: StorageLayer;
  let db: Database.Database;

  beforeEach(() => {
    storage = createStorage(':memory:');
    storage.initialize();
    db = storage.getDb();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    storage.close();
  });

  it('serves one catalog grouped by provider, with no routes or endpoints', async () => {
    const { app } = setup(db, { team: vi.fn(), deepseek: vi.fn() });
    const response = await request(app).get('/api/chat/models');
    expect(response.status).toBe(200);
    expect(response.body.defaultKey).toBe('team.terra');
    expect(response.body.groups).toEqual([{ id: 'team', label: 'Team gateway' }, { id: 'deepseek', label: 'DeepSeek' }]);
    expect(response.body.models.map((model: any) => [model.key, model.label, model.group])).toEqual([
      ['team.terra', 'GPT-5.6 Terra', 'team'],
      ['team.luna', 'GPT-5.6 Luna', 'team'],
      ['team.sol', 'GPT-5.6 Sol', 'team'],
      ['deepseek.deepseek-flash', 'DeepSeek V4.1 Flash', 'deepseek'],
      ['deepseek.deepseek-v4-pro', 'DeepSeek V4 Pro', 'deepseek'],
    ]);
    expect(JSON.stringify(response.body)).not.toMatch(/bedrock-mantle|deepseek\.test|gateway\.test|route/);
  });

  it('pins a turn to the picked connection and runs its tools inside that model operation', async () => {
    const seen: any[] = [];
    let call = 0;
    const deepseek = vi.fn((input: any) => {
      seen.push(input);
      return (async function* () {
        if (++call === 1) {
          return streamResult({
            toolCalls: [{ id: 'c1', type: 'function', function: { name: 'search_items', arguments: '{"query":"x"}' } }],
            finishReason: 'tool_calls',
          });
        }
        yield { type: 'content', text: 'Found it.' };
        return streamResult({ content: 'Found it.' });
      })();
    });
    const team = vi.fn();
    const operations: any[] = [];
    const executeTool = vi.fn(async () => {
      operations.push(currentLlmModelOperation());
      return { content: 'one result' };
    });
    const { app } = setup(db, { team, deepseek }, executeTool);

    const response = await request(app).post('/api/chat/messages').send({ message: 'search for x', stream: true, model: 'deepseek.deepseek-v4-pro' });
    expect(response.status).toBe(200);
    expect(response.text).toContain('Found it.');
    expect(team).not.toHaveBeenCalled();
    expect(seen).toHaveLength(2);
    for (const input of seen) expect(input.route).toEqual({ model: 'deepseek-v4-pro' });
    expect(executeTool).toHaveBeenCalledTimes(1);
    expect(operations[0]).toMatchObject({
      connectionId: 'deepseek',
      modelKey: 'deepseek.deepseek-v4-pro',
      provider: { id: 'deepseek', endpoint: 'https://api.deepseek.test', model: 'deepseek-v4-pro' },
    });
    // Outside the turn no operation is active.
    expect(currentLlmModelOperation()).toBeUndefined();

    const rejected = await request(app).post('/api/chat/messages').send({ message: 'hi', stream: true, model: 'openai.gpt-4o' });
    expect(rejected.status).toBe(400);
    expect(rejected.body.error).toContain('deepseek.deepseek-flash');
  });

  it('stops only the turns pinned to the connection that changed', async () => {
    const team = hangingStream();
    const deepseek = hangingStream();
    const { app, emit } = setup(db, { team, deepseek });

    const onDeepSeek = request(app).post('/api/chat/messages').send({ message: 'long question', stream: true, model: 'deepseek.deepseek-flash' }).then(response => response);
    const onTeam = request(app).post('/api/chat/messages').send({ message: 'another question', stream: true, model: 'team.sol' }).then(response => response);
    await vi.waitFor(() => {
      expect(deepseek).toHaveBeenCalledTimes(1);
      expect(team).toHaveBeenCalledTimes(1);
    });

    emit('deepseek');
    const stopped = await onDeepSeek;
    expect(stopped.status).toBe(200);
    expect(stopped.text).toContain('Stopped because the AI model was changed in Settings');

    // The team turn is still running; stop it the ordinary way.
    let teamSettled = false;
    void onTeam.then(() => { teamSettled = true; });
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(teamSettled).toBe(false);
    await request(app).post('/api/chat/stop').send({});
    const teamResponse = await onTeam;
    expect(teamResponse.text).not.toContain('changed in Settings');
  });
});
