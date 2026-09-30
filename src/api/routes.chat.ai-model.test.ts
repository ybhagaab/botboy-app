import express from 'express';
import request from 'supertest';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createStorage, type StorageLayer } from '../core/storage.js';
import { createNodeManager } from '../core/node-manager.js';
import { createLlmClientSwitch, type LlmRuntimeIdentity } from '../core/llm-client-switch.js';
import { createRouter } from './routes.js';

/**
 * Chat on a runtime-switchable provider (Settings → AI model): the catalog is
 * computed per request, a turn stays on the provider it started with, a
 * provider change stops in-flight turns without another model call, and a
 * fresh install gets a plain "add a key" answer.
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

function identity(providerId: string): LlmRuntimeIdentity {
  return {
    providerId,
    endpoint: `https://${providerId}.test/v1`,
    model: providerId === 'openai' ? 'gpt-5.6-terra' : 'bedrock-mantle-luna/openai.gpt-5.6-terra',
    apiMode: 'responses',
    maxContextTokens: 1_000_000,
    source: providerId === 'openai' ? 'settings' : 'environment',
  };
}

function gatewayClient(stream = vi.fn()) {
  return {
    getDefaultModel: () => 'bedrock-mantle-luna/openai.gpt-5.6-terra',
    getProviderId: () => 'gateway',
    getActiveEndpoint: () => 'ecs',
    isAvailable: () => true,
    chatCompletionStream: stream,
    close: () => {},
  } as any;
}

function openAiClient(stream = vi.fn(), availableModels = ['gpt-5.6-terra', 'gpt-6-astra']) {
  return {
    getDefaultModel: () => 'gpt-5.6-terra',
    getProviderId: () => 'openai',
    getAvailableModels: () => availableModels,
    getActiveEndpoint: () => 'ecs',
    isAvailable: () => true,
    chatCompletionStream: stream,
    close: () => {},
  } as any;
}

function makeDeps(db: Database.Database, llmClient: any, extra: Record<string, unknown> = {}) {
  return {
    nodeManager: createNodeManager(db),
    db,
    llmClient,
    toolExecutor: { executeTool: vi.fn() },
    chatInterface: {
      getHistory: () => [],
      sendMessage: async () => ({ message: { id: 'x', role: 'assistant', content: '' } }),
    } as any,
    promptManager: {
      getSystemPrompt: () => 'You are a test bot.',
      getToolDefinitions: () => [],
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
    ...extra,
  };
}

function buildApp(deps: any): express.Express {
  const app = express();
  app.use(express.json());
  app.use('/api', createRouter(deps));
  return app;
}

describe('chat on a switchable AI model', () => {
  let storage: StorageLayer;
  let db: Database.Database;

  beforeEach(() => {
    storage = createStorage(':memory:');
    storage.initialize();
    db = storage.getDb();
    vi.stubEnv('BOTBOY_INFERENCE_GPT6_ROLLOUT', 'off');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    storage.close();
  });

  it('serves the catalog of whichever provider is active, per request', async () => {
    const llmSwitch = createLlmClientSwitch(gatewayClient(), identity('gateway'));
    const app = buildApp(makeDeps(db, llmSwitch));

    const before = await request(app).get('/api/chat/models');
    expect(before.body.models.map((model: any) => model.key)).toEqual(['terra', 'luna', 'sol']);

    llmSwitch.activate(openAiClient(), identity('openai'));
    const after = await request(app).get('/api/chat/models');
    expect(after.body.defaultKey).toBe('terra');
    expect(after.body.models.map((model: any) => model.key)).toEqual(['terra', 'gpt6-astra']);
    expect(JSON.stringify(after.body)).not.toContain('bedrock-mantle');
  });

  it('sends an OpenAI-provider turn its plain model id with no gateway headers', async () => {
    const seen: any[] = [];
    const stream = vi.fn((input: any) => {
      seen.push(input);
      return (async function* () {
        yield { type: 'content', text: 'Astra here' };
        return streamResult({ content: 'Astra here' });
      })();
    });
    const llmSwitch = createLlmClientSwitch(gatewayClient(), identity('gateway'));
    llmSwitch.activate(openAiClient(stream), identity('openai'));
    const app = buildApp(makeDeps(db, llmSwitch));

    const response = await request(app).post('/api/chat/messages').send({ message: 'Use Astra', stream: true, model: 'gpt6-astra' });
    expect(response.status).toBe(200);
    expect(seen[0].route).toEqual({ model: 'gpt-6-astra' });

    const rejected = await request(app).post('/api/chat/messages').send({ message: 'Use Sol', stream: true, model: 'sol' });
    expect(rejected.status).toBe(400);
    expect(rejected.body.error).toContain('terra');
  });

  it('stops an in-flight turn when the provider changes, without another model call', async () => {
    const gatewayStream = vi.fn((input: any) => (async function* () {
      await new Promise((_resolve, reject) => {
        const signal: AbortSignal = input.signal;
        if (signal.aborted) reject(signal.reason);
        signal.addEventListener('abort', () => reject(signal.reason ?? new Error('aborted')), { once: true });
      });
      return streamResult({});
    })());
    const openAiStream = vi.fn();
    const llmSwitch = createLlmClientSwitch(gatewayClient(gatewayStream), identity('gateway'));
    const app = buildApp(makeDeps(db, llmSwitch));

    const pending = request(app).post('/api/chat/messages').send({ message: 'long question', stream: true });
    const settled = pending.then(response => response);
    await vi.waitFor(() => expect(gatewayStream).toHaveBeenCalledTimes(1));
    llmSwitch.activate(openAiClient(openAiStream), identity('openai'));
    const response = await settled;

    expect(response.status).toBe(200);
    expect(response.text).toContain('Stopped because the AI model was changed in Settings');
    expect(gatewayStream).toHaveBeenCalledTimes(1);
    expect(openAiStream).not.toHaveBeenCalled();
    const stored = db.prepare("SELECT content FROM chat_messages WHERE role = 'assistant' ORDER BY rowid DESC LIMIT 1").get() as any;
    expect(stored.content).toContain('changed in Settings');
  });

  it('tells a fresh install to add a key instead of starting a turn', async () => {
    const stream = vi.fn();
    const app = buildApp(makeDeps(db, gatewayClient(stream), {
      aiModelSettings: { state: () => 'not_configured', version: () => 1, status: vi.fn() },
    }));
    const response = await request(app).post('/api/chat/messages').send({ message: 'hello', stream: true });
    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({
      code: 'ai_model_not_configured',
      nextAction: expect.stringContaining('Settings → AI model'),
    });
    expect(stream).not.toHaveBeenCalled();
  });

  it('publishes only a counter and a coarse state on the version poll', async () => {
    const app = buildApp(makeDeps(db, gatewayClient(), {
      aiModelSettings: { state: () => 'ready', version: () => 7, status: vi.fn() },
    }));
    const response = await request(app).get('/api/dashboard/version');
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ aiModelVersion: 7, aiModelState: 'ready' });

    const broken = buildApp(makeDeps(db, gatewayClient(), {
      aiModelSettings: { state: () => { throw new Error('boom'); }, version: () => 7, status: vi.fn() },
    }));
    const tolerant = await request(broken).get('/api/dashboard/version');
    expect(tolerant.status).toBe(200);
    expect(tolerant.body).not.toHaveProperty('aiModelState');
  });
});
