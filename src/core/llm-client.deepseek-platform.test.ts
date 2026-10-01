import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createLlmClient,
  LlmQuotaExhaustedError,
  type LlmConfig,
} from './llm-client.js';
import { createStorage, type StorageLayer } from './storage.js';
import { createLlmUsageService } from './llm-usage.js';

/**
 * DeepSeek API conventions (Settings → AI model): free model-list probe,
 * DeepSeek's effort levels (Thinking off = none, max = max), no `include`,
 * HTTP 402 as terminal no-balance, bounded 429 handling, plain-text
 * reasoning parsed from both the response and the stream, and per-attempt
 * provider labels. Also the OpenAI route flag for non-reasoning models.
 */
const KEY = 'sk-deepseektransport000000000000abcd';
const BASE = 'https://api.deepseek.test';

function deepSeekConfig(overrides: Partial<LlmConfig> = {}): LlmConfig {
  return {
    ecs: {
      endpoint: BASE,
      model: 'deepseek-flash',
      apiMode: 'responses',
      dialect: 'openai',
      maxContextTokens: 1_000_000,
      requestTimeoutMs: 30_000,
      reasoningEffort: 'low',
      requestAuthorizer: async () => ({ Authorization: `Bearer ${KEY}` }),
    },
    ollama: { endpoint: '', model: '', maxContextTokens: 0, requestTimeoutMs: 0 },
    defaults: { temperature: 0.7, maxCompletionTokens: 1024, contextBudgetTokens: 100_000 },
    healthCheckIntervalMs: 0,
    fallbackEnabled: false,
    providerId: 'deepseek',
    platform: 'deepseek',
    ...overrides,
  };
}

const COMPLETED = {
  status: 'completed',
  output: [
    { type: 'reasoning', id: 'rs_1', content: [{ type: 'reasoning_text', text: 'Think it through.' }] },
    { type: 'message', content: [{ type: 'output_text', text: 'OK' }] },
  ],
  usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8, output_tokens_details: { reasoning_tokens: 2 } },
};

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

type Handler = (url: string, init: RequestInit | undefined) => Response | Promise<Response>;

function installFetch(post: Handler, get: Handler = () => json(200, { object: 'list', data: [{ id: 'deepseek-flash' }] })) {
  const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    return init?.method === 'POST' ? post(url, init) : get(url, init);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function posts(fetchMock: ReturnType<typeof installFetch>) {
  return fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === 'POST');
}

afterEach(() => vi.unstubAllGlobals());

describe('DeepSeek platform transport', () => {
  it('probes health with the free model list, never a billed generation', async () => {
    const fetchMock = installFetch(() => json(500, {}));
    const client = createLlmClient(deepSeekConfig());
    await expect(client.healthCheck()).resolves.toBe(true);
    expect(posts(fetchMock)).toHaveLength(0);
    const [url, init] = fetchMock.mock.calls.at(-1)!;
    expect(String(url)).toBe(`${BASE}/models`);
    expect((init as RequestInit).headers).toMatchObject({ Authorization: `Bearer ${KEY}` });
    client.close();
  });

  it('records a rejected key from the probe', async () => {
    installFetch(() => json(200, COMPLETED), () => json(401, { error: { message: 'Authentication Fails' } }));
    const client = createLlmClient(deepSeekConfig());
    await expect(client.healthCheck()).resolves.toBe(false);
    expect(client.getProviderIssue?.()).toMatchObject({ code: 'auth_rejected', httpStatus: 401 });
    client.close();
  });

  it('maps Thinking off to none and passes low, high, and max through, without include or strict tools', async () => {
    const bodies: any[] = [];
    installFetch((_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return json(200, COMPLETED);
    });
    const client = createLlmClient(deepSeekConfig());
    const tools = [{ type: 'function' as const, function: { name: 'search_items', description: 'search', parameters: { type: 'object', properties: {} } } }];
    await client.chatCompletion({ messages: [{ role: 'user', content: 'hi' }], tools, think: false });
    await client.chatCompletion({ messages: [{ role: 'user', content: 'hi' }], think: true, reasoningEffort: 'low' });
    await client.chatCompletion({ messages: [{ role: 'user', content: 'hi' }], think: true, reasoningEffort: 'high' });
    await client.chatCompletion({ messages: [{ role: 'user', content: 'hi' }], think: true, reasoningEffort: 'max' });
    expect(bodies.map(body => body.reasoning?.effort)).toEqual(['none', 'low', 'high', 'max']);
    for (const body of bodies) {
      expect(body).toMatchObject({ model: 'deepseek-flash', store: false });
      expect(body).not.toHaveProperty('include');
    }
    expect(bodies[0].tools[0]).toMatchObject({ type: 'function', name: 'search_items' });
    expect(bodies[0].tools[0]).not.toHaveProperty('strict');
    client.close();
  });

  it('reads DeepSeek plain-text reasoning from the response output', async () => {
    installFetch(() => json(200, COMPLETED));
    const client = createLlmClient(deepSeekConfig());
    const response = await client.chatCompletion({ messages: [{ role: 'user', content: 'hi' }], think: true, reasoningEffort: 'high' });
    expect(response.content).toBe('OK');
    expect(response.reasoning).toBe('Think it through.');
    // Replayed verbatim on the next tool turn; DeepSeek merges the plain text.
    expect(response.providerOutput).toEqual(COMPLETED.output);
    client.close();
  });

  it('streams reasoning_text deltas as thinking', async () => {
    installFetch(() => {
      const events = [
        { type: 'response.reasoning_text.delta', delta: 'Let me ' },
        { type: 'response.reasoning_text.delta', delta: 'check.' },
        { type: 'response.output_text.delta', delta: 'Hel' },
        { type: 'response.output_text.delta', delta: 'lo' },
        { type: 'response.completed', response: COMPLETED },
      ];
      const body = events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('');
      return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    });
    const client = createLlmClient(deepSeekConfig());
    const stream = client.chatCompletionStream({ messages: [{ role: 'user', content: 'hi' }], think: true, reasoningEffort: 'high' });
    let thinking = '';
    let text = '';
    let step = await stream.next();
    while (!step.done) {
      if (step.value.type === 'thinking') thinking += step.value.text;
      if (step.value.type === 'content') text += step.value.text;
      step = await stream.next();
    }
    expect(thinking).toBe('Let me check.');
    expect(text).toBe('Hello');
    expect(step.value.reasoning).toBe('Let me check.');
    client.close();
  });

  it('treats HTTP 402 as a terminal empty balance without touching endpoint health', async () => {
    let empty = true;
    const fetchMock = installFetch(() => (empty
      ? json(402, { error: { message: 'Insufficient Balance', type: 'unknown_error' } })
      : json(200, COMPLETED)));
    const client = createLlmClient(deepSeekConfig());
    await client.healthCheck();
    const error = await client.chatCompletion({ messages: [{ role: 'user', content: 'hi' }] }).catch(e => e);
    expect(error).toBeInstanceOf(LlmQuotaExhaustedError);
    expect(error.message).toContain('DeepSeek');
    expect(error.nextAction).toContain('platform.deepseek.com');
    expect(posts(fetchMock)).toHaveLength(1);
    expect(client.isAvailable()).toBe(true);
    expect(client.getProviderIssue?.()).toMatchObject({ code: 'quota_exhausted', httpStatus: 402 });
    empty = false;
    await client.chatCompletion({ messages: [{ role: 'user', content: 'hi' }] });
    expect(client.getProviderIssue?.()).toBeUndefined();
    client.close();
  });

  it('waits and resends on a 429 like the OpenAI platform', async () => {
    let calls = 0;
    const fetchMock = installFetch(() => (++calls === 1
      ? json(429, { error: { message: 'Rate Limit Reached' } }, { 'retry-after-ms': '2' })
      : json(200, COMPLETED)));
    const client = createLlmClient(deepSeekConfig());
    await client.healthCheck();
    const response = await client.chatCompletion({ messages: [{ role: 'user', content: 'hi' }] });
    expect(response.content).toBe('OK');
    expect(posts(fetchMock)).toHaveLength(2);
    expect(client.isAvailable()).toBe(true);
    client.close();
  });

  it('labels usage rows deepseek', async () => {
    let storage: StorageLayer | undefined;
    try {
      storage = createStorage(':memory:');
      storage.initialize();
      const db = storage.getDb();
      installFetch(() => json(200, COMPLETED));
      const client = createLlmClient(deepSeekConfig(), createLlmUsageService(db, { primaryProvider: 'gateway' }));
      await client.chatCompletion({ messages: [{ role: 'user', content: 'hi' }], usageContext: { workload: 'background' } });
      client.close();
      expect(db.prepare('SELECT provider, model, status FROM llm_usage_attempts').all())
        .toEqual([{ provider: 'deepseek', model: 'deepseek-flash', status: 'completed' }]);
    } finally {
      storage?.close();
    }
  });
});

describe('Responses reasoning parameters per model', () => {
  it('omits reasoning and include for a route whose model rejects them', async () => {
    const bodies: any[] = [];
    installFetch((_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return json(200, COMPLETED);
    }, () => json(200, { id: 'gpt-5.6-terra' }));
    const client = createLlmClient(deepSeekConfig({
      ecs: { ...deepSeekConfig().ecs, endpoint: 'https://api.openai.test/v1', model: 'gpt-5.6-terra' },
      providerId: 'openai',
      platform: 'openai',
    }));
    await client.chatCompletion({ messages: [{ role: 'user', content: 'hi' }], route: { model: 'gpt-4o', supportsReasoning: false } });
    await client.chatCompletion({ messages: [{ role: 'user', content: 'hi' }] });
    expect(bodies[0]).toMatchObject({ model: 'gpt-4o' });
    expect(bodies[0]).not.toHaveProperty('reasoning');
    expect(bodies[0]).not.toHaveProperty('include');
    expect(bodies[1]).toMatchObject({ model: 'gpt-5.6-terra', reasoning: { effort: 'low' }, include: ['reasoning.encrypted_content'] });
    client.close();
  });

  it('honors a non-reasoning default model when no route is sent', async () => {
    const bodies: any[] = [];
    installFetch((_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return json(200, COMPLETED);
    }, () => json(200, { id: 'gpt-4o' }));
    const client = createLlmClient(deepSeekConfig({
      ecs: { ...deepSeekConfig().ecs, endpoint: 'https://api.openai.test/v1', model: 'gpt-4o', supportsReasoning: false },
      providerId: 'openai',
      platform: 'openai',
    }));
    await client.chatCompletion({ messages: [{ role: 'user', content: 'hi' }] });
    expect(bodies[0]).not.toHaveProperty('reasoning');
    expect(bodies[0]).not.toHaveProperty('include');
    client.close();
  });
});
