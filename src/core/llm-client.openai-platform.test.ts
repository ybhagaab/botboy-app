import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createLlmClient,
  isLlmProviderLimitError,
  LlmQuotaExhaustedError,
  LlmRateLimitedError,
  redactProviderSecrets,
  retryAfterMs,
  type LlmConfig,
} from './llm-client.js';
import { createStorage, type StorageLayer } from './storage.js';
import { createLlmUsageService } from './llm-usage.js';

/**
 * Hosted OpenAI platform conventions (Settings → AI model): free model-retrieve
 * health probe, explicitly non-strict tools, bounded Retry-After handling,
 * terminal quota errors, key redaction, and per-attempt provider labels.
 */
const KEY = 'sk-proj-platformtest0000000000000000wxyz';
const BASE = 'https://api.openai.test/v1';

function openAiConfig(overrides: Partial<LlmConfig> = {}): LlmConfig {
  return {
    ecs: {
      endpoint: BASE,
      model: 'gpt-5.6-terra',
      apiMode: 'responses',
      dialect: 'openai',
      maxContextTokens: 1_000_000,
      requestTimeoutMs: 30_000,
      requestAuthorizer: async () => ({ Authorization: `Bearer ${KEY}` }),
    },
    ollama: { endpoint: '', model: '', maxContextTokens: 0, requestTimeoutMs: 0 },
    defaults: { temperature: 0.7, maxCompletionTokens: 1024, contextBudgetTokens: 100_000 },
    healthCheckIntervalMs: 0,
    fallbackEnabled: false,
    providerId: 'openai',
    platform: 'openai',
    ...overrides,
  };
}

const COMPLETED = {
  status: 'completed',
  output: [{ type: 'message', content: [{ type: 'output_text', text: 'OK' }] }],
  usage: { input_tokens: 5, output_tokens: 1, total_tokens: 6 },
};

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

type Handler = (url: string, init: RequestInit | undefined) => Response | Promise<Response>;

function installFetch(post: Handler, get: Handler = () => json(200, { id: 'gpt-5.6-terra' })) {
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

describe('OpenAI platform transport', () => {
  it('probes health with a free model retrieve, never a billed generation', async () => {
    const fetchMock = installFetch(() => json(500, {}));
    const client = createLlmClient(openAiConfig());
    await expect(client.healthCheck()).resolves.toBe(true);
    expect(posts(fetchMock)).toHaveLength(0);
    const [url, init] = fetchMock.mock.calls.at(-1)!;
    expect(String(url)).toBe(`${BASE}/models/gpt-5.6-terra`);
    expect((init as RequestInit).headers).toMatchObject({ Authorization: `Bearer ${KEY}` });
    client.close();
  });

  it('records a rejected key from the probe; only a successful generation clears it', async () => {
    let status = 401;
    installFetch(() => json(200, COMPLETED), () => json(status, { error: { message: 'Incorrect API key provided: sk-proj-****wxyz.' } }));
    const client = createLlmClient(openAiConfig());
    await expect(client.healthCheck()).resolves.toBe(false);
    expect(client.getProviderIssue?.()).toMatchObject({ code: 'auth_rejected', httpStatus: 401 });
    // A key can list models yet be refused generation: the free probe
    // restores health but never vouches for the credential.
    status = 200;
    await expect(client.healthCheck()).resolves.toBe(true);
    expect(client.getProviderIssue?.()?.code).toBe('auth_rejected');
    await client.chatCompletion({ messages: [{ role: 'user', content: 'hi' }] });
    expect(client.getProviderIssue?.()).toBeUndefined();
    client.close();
  });

  it('keeps a rate-limited probe healthy: account limits are not endpoint failures', async () => {
    installFetch(() => json(200, COMPLETED), () => json(429, { error: { code: 'rate_limit_exceeded' } }, { 'retry-after': '1' }));
    const client = createLlmClient(openAiConfig());
    await expect(client.healthCheck()).resolves.toBe(true);
    expect(client.isAvailable()).toBe(true);
    expect(client.getProviderIssue?.()).toBeUndefined();
    client.close();
  });

  it('sends tools as explicitly non-strict on the OpenAI platform only', async () => {
    const bodies: any[] = [];
    installFetch((_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return json(200, COMPLETED);
    });
    const tools = [{ type: 'function' as const, function: { name: 'search_items', description: 'search', parameters: { type: 'object', properties: {} } } }];
    const platform = createLlmClient(openAiConfig());
    await platform.chatCompletion({ messages: [{ role: 'user', content: 'hi' }], tools });
    const gateway = createLlmClient(openAiConfig({ platform: undefined, providerId: 'gateway' }));
    await gateway.chatCompletion({ messages: [{ role: 'user', content: 'hi' }], tools });
    // The gateway profile's construction-time ping is also a POST; compare
    // only the two tool-bearing chat requests.
    const [platformBody, gatewayBody] = bodies.filter(body => Array.isArray(body.tools));
    expect(platformBody).toMatchObject({ model: 'gpt-5.6-terra', store: false, include: ['reasoning.encrypted_content'] });
    expect(platformBody.tools[0]).toMatchObject({ type: 'function', name: 'search_items', strict: false });
    expect(gatewayBody.tools[0]).not.toHaveProperty('strict');
    platform.close();
    gateway.close();
  });

  it('waits as instructed on a 429 and resends without touching endpoint health', async () => {
    let calls = 0;
    const fetchMock = installFetch(() => (++calls === 1
      ? json(429, { error: { code: 'rate_limit_exceeded', message: 'slow down' } }, { 'retry-after-ms': '5' })
      : json(200, COMPLETED)));
    const client = createLlmClient(openAiConfig());
    await client.healthCheck();
    const response = await client.chatCompletion({ messages: [{ role: 'user', content: 'hi' }] });
    expect(response.content).toBe('OK');
    expect(posts(fetchMock)).toHaveLength(2);
    expect(client.isAvailable()).toBe(true);
    expect(client.getProviderIssue?.()).toBeUndefined();
    client.close();
  });

  it('gives up after bounded retries with a typed, health-neutral rate-limit error', async () => {
    const fetchMock = installFetch(() => json(429, { error: { code: 'rate_limit_exceeded' } }, { 'retry-after-ms': '1' }));
    const client = createLlmClient(openAiConfig());
    await client.healthCheck();
    const error = await client.chatCompletion({ messages: [{ role: 'user', content: 'hi' }] }).catch(e => e);
    expect(error).toBeInstanceOf(LlmRateLimitedError);
    expect(isLlmProviderLimitError(error)).toBe(true);
    expect(error.nextAction).toMatch(/Wait a minute/);
    expect(posts(fetchMock)).toHaveLength(4);
    expect(client.isAvailable()).toBe(true);
    expect(client.getProviderIssue?.()?.code).toBe('rate_limited');
    client.close();
  });

  it('does not wait when the provider asks for longer than the bound', async () => {
    const fetchMock = installFetch(() => json(429, { error: { code: 'rate_limit_exceeded' } }, { 'retry-after': '120' }));
    const client = createLlmClient(openAiConfig());
    const started = Date.now();
    const error = await client.chatCompletion({ messages: [{ role: 'user', content: 'hi' }] }).catch(e => e);
    expect(error).toBeInstanceOf(LlmRateLimitedError);
    expect(error.retryAfterMs).toBe(120_000);
    expect(posts(fetchMock)).toHaveLength(1);
    expect(Date.now() - started).toBeLessThan(5_000);
    client.close();
  });

  it('treats an exhausted account as terminal and recovers on the next success', async () => {
    let quota = true;
    const fetchMock = installFetch(() => (quota
      ? json(429, { error: { code: 'insufficient_quota', message: 'You exceeded your current quota' } })
      : json(200, COMPLETED)));
    const client = createLlmClient(openAiConfig());
    await client.healthCheck();
    const error = await client.chatCompletion({ messages: [{ role: 'user', content: 'hi' }] }).catch(e => e);
    expect(error).toBeInstanceOf(LlmQuotaExhaustedError);
    expect(error.code).toBe('LLM_QUOTA_EXHAUSTED');
    expect(posts(fetchMock)).toHaveLength(1);
    expect(client.isAvailable()).toBe(true);
    expect(client.getProviderIssue?.()?.code).toBe('quota_exhausted');
    quota = false;
    await client.chatCompletion({ messages: [{ role: 'user', content: 'hi' }] });
    expect(client.getProviderIssue?.()).toBeUndefined();
    client.close();
  });

  it('applies the same 429 handling to streaming requests', async () => {
    let calls = 0;
    installFetch(() => {
      if (++calls === 1) return json(429, { error: { code: 'rate_limit_exceeded' } }, { 'retry-after-ms': '1' });
      const events = [
        { type: 'response.output_text.delta', delta: 'Hel' },
        { type: 'response.output_text.delta', delta: 'lo' },
        { type: 'response.completed', response: { ...COMPLETED, output: [{ type: 'message', content: [{ type: 'output_text', text: 'Hello' }] }] } },
      ];
      const body = events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('');
      return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    });
    const client = createLlmClient(openAiConfig());
    const stream = client.chatCompletionStream({ messages: [{ role: 'user', content: 'hi' }] });
    let step = await stream.next();
    let text = '';
    while (!step.done) {
      if (step.value.type === 'content') text += step.value.text;
      step = await stream.next();
    }
    expect(text).toBe('Hello');
    expect(step.value.content).toBe('Hello');
    expect(calls).toBe(2);
    client.close();
  });

  it('never lets a key fragment reach an error message', async () => {
    const rejected = () => json(401, { error: { message: `Incorrect API key provided: ${KEY}. Also Bearer ${KEY}` } });
    // A rejected key fails every route, including the model-retrieve probe.
    installFetch(rejected, rejected);
    const client = createLlmClient(openAiConfig());
    const error = await client.chatCompletion({ messages: [{ role: 'user', content: 'hi' }] }).catch(e => e);
    expect(String(error.message)).toContain('HTTP 401');
    expect(String(error.message)).not.toContain('platformtest');
    expect(String(error.message)).toContain('sk-…[redacted]');
    expect(client.getProviderIssue?.()?.code).toBe('auth_rejected');
    client.close();
  });

  it('labels usage rows with the provider that served them', async () => {
    let storage: StorageLayer | undefined;
    try {
      storage = createStorage(':memory:');
      storage.initialize();
      const db = storage.getDb();
      const usage = createLlmUsageService(db, { primaryProvider: 'gateway' });
      installFetch(() => json(200, COMPLETED));
      const client = createLlmClient(openAiConfig(), usage);
      await client.chatCompletion({ messages: [{ role: 'user', content: 'hi' }], usageContext: { workload: 'background' } });
      client.close();
      const rows = db.prepare('SELECT provider, model, status FROM llm_usage_attempts').all() as any[];
      expect(rows).toEqual([{ provider: 'openai', model: 'gpt-5.6-terra', status: 'completed' }]);
    } finally {
      storage?.close();
    }
  });
});

describe('provider limit helpers', () => {
  it('reads every Retry-After form OpenAI uses', () => {
    const headers = (values: Record<string, string>) => new Headers(values);
    expect(retryAfterMs(headers({ 'retry-after-ms': '250' }))).toBe(250);
    expect(retryAfterMs(headers({ 'retry-after': '2' }))).toBe(2_000);
    expect(retryAfterMs(headers({ 'x-ratelimit-reset-requests': '1.5s', 'x-ratelimit-reset-tokens': '20ms' }))).toBe(1_500);
    expect(retryAfterMs(headers({ 'x-ratelimit-reset-tokens': '6m0s' }))).toBe(360_000);
    expect(retryAfterMs(headers({}))).toBeUndefined();
  });

  it('redacts keys and bearer tokens', () => {
    expect(redactProviderSecrets('bad key sk-proj-AbC_123-xyz and sk-svcacct-Z9')).toBe('bad key sk-…[redacted] and sk-…[redacted]');
    expect(redactProviderSecrets('Authorization: Bearer abcdefgh.ijklmnop')).toBe('Authorization: Bearer [redacted]');
    expect(redactProviderSecrets('no secrets here')).toBe('no secrets here');
  });
});
