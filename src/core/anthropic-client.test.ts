import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { inspect } from 'node:util';
import {
  LlmPayloadTooLargeError,
  LlmProviderOverloadedError,
  LlmQuotaExhaustedError,
  LlmRateLimitedError,
  isLlmProviderLimitError,
  redactProviderSecrets,
  type ChatCompletionRequest,
  type LlmConfig,
  type ToolDefinition,
} from './llm-client.js';
import { createAnthropicLlmClient, ANTHROPIC_STREAM_IDLE_TIMEOUT_MS, type AnthropicClientOptions } from './anthropic-client.js';
import { AnthropicApiError } from './anthropic-errors.js';
import { AnthropicHistoryError } from './anthropic-messages.js';
import { AnthropicSchemaError } from './anthropic-schema.js';
import { createReplayGuard } from './anthropic-replay-guard.js';
import { parseAnthropicModel, type AnthropicModelProfile } from './anthropic-models.js';
import {
  FAKE_ANTHROPIC_KEY,
  FAKE_BINDING_BETA,
  FAKE_D10_ROWS,
  FAKE_LATEST_RUN_400,
  FAKE_SIGNATURE_400,
  fakeErrorBody,
  fakeModelRow,
  startFakeAnthropic,
  type FakeAnthropicOptions,
  type FakeAnthropicServer,
  type FakeMessageReply,
  type FakeModelSpec,
  type FakeRecordedRequest,
} from './anthropic-api.fake.js';
import { ANALYTICS_JOB_PLAN_RESPONSE_FORMAT } from './analytics-job-planner.js';
import { ANALYTICS_IMPORT_PROPOSAL_RESPONSE_FORMAT } from './analytics-import-semantic-proposal.js';
import { createStorage, type StorageLayer } from './storage.js';
import { createLlmUsageService } from './llm-usage.js';
import { isTransientStreamError } from '../api/routers/chat.js';

/**
 * Design v3 D1, D6, D7, D9, D10 (slice A2): the Anthropic client against the fake server. Scenario names mirror
 * `llm-client.deepseek-platform.test.ts` where they apply. No test here touches the real API or a real key.
 */
const SPECS = {
  sonnet: { id: 'claude-sonnet-5-5', variant: 'A', line: 'sonnet' },
  haiku: { id: 'claude-haiku-5-5', variant: 'B', line: 'haiku' },
  opus5: { id: 'claude-opus-5', variant: 'B', line: 'opus' }, // prefixCheck false in the known table
  c: { id: 'claude-opus-4-5-20251101', variant: 'C', line: 'opus', effort: { low: true, medium: true, high: true }, maxInputTokens: 200_000, maxTokens: 64_000 },
} satisfies Record<string, FakeModelSpec>;
const profiles = (): ReadonlyMap<string, AnthropicModelProfile> =>
  new Map(Object.values(SPECS).map(spec => [spec.id, parseAnthropicModel(fakeModelRow(spec))!] as const));

let fake: FakeAnthropicServer | undefined;
const clients: Array<{ close(): void }> = [];
const storages: StorageLayer[] = [];
beforeEach(() => { process.env.BOTBOY_LLM_PROMPT_LOG = '0'; });
afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  for (const storage of storages.splice(0)) storage.close();
  await fake?.close();
  fake = undefined;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function startFake(options: FakeAnthropicOptions = {}) {
  fake = await startFakeAnthropic({ models: Object.values(SPECS), ...options });
  return fake;
}

function configFor(url: string, overrides: Partial<LlmConfig> = {}): LlmConfig {
  return {
    ecs: { endpoint: url, model: 'claude-sonnet-5-5', maxContextTokens: 1_000_000, requestTimeoutMs: 30_000 },
    ollama: { endpoint: '', model: '', maxContextTokens: 0, requestTimeoutMs: 0 },
    defaults: { temperature: 0.7, maxCompletionTokens: 1024, contextBudgetTokens: 100_000 },
    healthCheckIntervalMs: 0,
    fallbackEnabled: false,
    providerId: 'anthropic',
    ...overrides,
  };
}

function makeClient(overrides: { config?: Partial<LlmConfig>; options?: Partial<AnthropicClientOptions>; usage?: ReturnType<typeof createLlmUsageService> } = {}) {
  const sleeps: number[] = [];
  const client = createAnthropicLlmClient(
    configFor(fake!.url, overrides.config),
    { apiKey: FAKE_ANTHROPIC_KEY, profiles, sleep: async ms => { sleeps.push(ms); }, ...overrides.options },
    overrides.usage,
  );
  clients.push(client);
  return { client, sleeps };
}

/** What one console call printed. Objects are opened up, so a header map or a request in a log line cannot hide behind `[object Object]`. */
const printed = (args: unknown[]) => args.map(arg => (typeof arg === 'string' ? arg : inspect(arg, { depth: 8, breakLength: Infinity }))).join(' ');

const hello: ChatCompletionRequest = { messages: [{ role: 'user', content: 'hello' }] };
const posts = () => fake!.requests.filter(request => request.method === 'POST' && request.path === '/v1/messages');
const tool = (name: string): ToolDefinition => ({
  type: 'function',
  function: { name, description: `${name} tool`, parameters: { type: 'object', properties: { path: { type: 'string' } } } },
});
const answer = (status: number, body: unknown, headers: Record<string, string> = {}) => ({ status, body, headers });
const failPosts = (status: number, body: unknown, headers: Record<string, string> = {}) => {
  fake!.respond = request => (request.path === '/v1/messages' ? answer(status, body, headers) : undefined);
};

describe('Anthropic client: health probe and provider issues', () => {
  it('probes with the free model list, never a billed generation, and writes no usage row', async () => {
    await startFake();
    const storage = createStorage(':memory:'); storage.initialize(); storages.push(storage);
    const { client } = makeClient({ usage: createLlmUsageService(storage.getDb(), { primaryProvider: 'gateway' }) });
    await expect(client.healthCheck()).resolves.toBe(true);
    expect(client.isAvailable()).toBe(true);
    expect(client.getActiveEndpoint()).toBe('ecs');
    expect(posts()).toHaveLength(0);
    const probe = fake!.requests.find(request => request.path === '/v1/models' && request.query.limit?.[0] === '1')!;
    expect(probe.auth).toEqual({ style: 'x-api-key', key: FAKE_ANTHROPIC_KEY });
    expect(probe.headers['anthropic-version']).toBe('2023-06-01');
    expect(probe.headers['anthropic-beta']).toBeUndefined();
    expect(storage.getDb().prepare('SELECT COUNT(*) AS n FROM llm_usage_attempts').get()).toEqual({ n: 0 });
  });

  it('records a rejected key from the probe (401, and 403 on the free list) but only a generation clears it', async () => {
    await startFake();
    const { client } = makeClient();
    for (const status of [401, 403]) {
      fake!.respond = request => (request.path === '/v1/models' ? answer(status, fakeErrorBody('authentication_error', 'no')) : undefined);
      await expect(client.healthCheck()).resolves.toBe(false);
      expect(client.getProviderIssue?.()).toMatchObject({ code: 'auth_rejected', httpStatus: status });
    }
    fake!.respond = undefined;
    await expect(client.healthCheck()).resolves.toBe(true);
    expect(client.getProviderIssue?.()?.code).toBe('auth_rejected'); // a good probe never clears a credential issue
    await client.chatCompletion(hello);
    expect(client.getProviderIssue?.()).toBeUndefined();
  });

  it('does not treat an account limit or provider capacity on the probe as an endpoint failure; a server error is one', async () => {
    await startFake();
    const { client } = makeClient();
    for (const [status, healthy] of [[429, true], [529, true], [500, false]] as const) {
      fake!.respond = request => (request.path === '/v1/models' ? answer(status, fakeErrorBody('api_error', 'x')) : undefined);
      await expect(client.healthCheck()).resolves.toBe(healthy);
    }
    fake!.respond = undefined;
    fake!.dropNext = 1;
    await expect(client.healthCheck()).resolves.toBe(false);
  });
});

describe('Anthropic client: the wire request', () => {
  it('sends the shaped body with the key only in x-api-key, no temperature, no beta header, and the key nowhere else', async () => {
    await startFake();
    const { client } = makeClient();
    await client.chatCompletion({ ...hello, temperature: 0.2, maxTokens: 300, think: true, reasoningEffort: 'high', usageContext: { workload: 'background' } });
    const [request] = posts();
    expect(request.auth).toEqual({ style: 'x-api-key', key: FAKE_ANTHROPIC_KEY });
    expect(request.headers).toMatchObject({ 'anthropic-version': '2023-06-01', 'content-type': 'application/json' });
    expect(request.headers['anthropic-beta']).toBeUndefined();
    expect(request.headers.authorization).toBeUndefined();
    expect(request.body).toMatchObject({ model: 'claude-sonnet-5-5', stream: true, messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }] });
    expect(request.body.temperature).toBeUndefined();
    expect(request.body.thinking).toEqual({ type: 'adaptive', display: 'omitted' });
    expect(request.body.output_config).toEqual({ effort: 'high' });
    expect(request.body.max_tokens).toBe(300 + 8_192);
    expect(request.rawBody).not.toContain(FAKE_ANTHROPIC_KEY);
  });

  it('routes by the request route model, ignores a route endpoint or headers, and never sends the key anywhere else', async () => {
    await startFake();
    // The fetch seam sends everything addressed to the fake server on to it and everything else to `elsewhere`, so a
    // client that honored the route's endpoint would reach `elsewhere` and fail the last assertion.
    const elsewhere = vi.fn(async (_input: unknown) => new Response('no', { status: 500 }));
    const seen: string[] = [];
    const { client } = makeClient({
      options: {
        fetchImpl: async (input, init) => {
          seen.push(String(input));
          return String(input).startsWith(fake!.url) ? fetch(input, init) : elsewhere(input);
        },
      },
    });
    await client.chatCompletion({ ...hello, route: { model: 'claude-haiku-5-5', endpoint: 'https://evil.example/v1', headers: { 'x-evil': '1' } } });
    expect(posts()[0].body.model).toBe('claude-haiku-5-5');
    expect(posts()[0].headers['x-evil']).toBeUndefined();
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every(url => url.startsWith(fake!.url))).toBe(true);
    expect(elsewhere).not.toHaveBeenCalled();
  });

  it('reads the profile map per call, so a refreshed model list applies at once', async () => {
    await startFake();
    let current = profiles();
    const { client } = makeClient({ options: { profiles: () => current } });
    await client.chatCompletion({ ...hello, think: true, reasoningEffort: 'low', route: { model: 'claude-haiku-5-5' } });
    expect(posts()[0].body.thinking?.type).toBe('adaptive');
    // The list now says this model cannot think: the next request sends no thinking field.
    const row = fakeModelRow({ ...SPECS.haiku, variant: 'D' });
    current = new Map([['claude-haiku-5-5', parseAnthropicModel(row)!]]);
    await client.chatCompletion({ ...hello, think: true, reasoningEffort: 'low', route: { model: 'claude-haiku-5-5' } });
    expect(posts()[1].body.thinking).toBeUndefined();
  });

  it('marks the top-level cache only for interactive calls that send tools, and honors the off switch', async () => {
    await startFake();
    const tools = [tool('read_file')];
    const { client } = makeClient();
    await client.chatCompletion({ ...hello, tools, usageContext: { workload: 'interactive' } });
    await client.chatCompletion({ ...hello, tools, usageContext: { workload: 'background' } });
    await client.chatCompletion({ ...hello, usageContext: { workload: 'interactive' } });
    expect(posts().map(request => request.body.cache_control)).toEqual([{ type: 'ephemeral' }, undefined, undefined]);
    const { client: off } = makeClient({ options: { promptCaching: false } });
    await off.chatCompletion({ ...hello, tools, usageContext: { workload: 'interactive' } });
    expect(posts().at(-1)!.body.cache_control).toBeUndefined();
  });

  it('reads cache and thinking tokens: a repeated interactive prefix is read from the cache', async () => {
    await startFake();
    const { client } = makeClient();
    const request: ChatCompletionRequest = { ...hello, tools: [tool('read_file')], usageContext: { workload: 'interactive' } };
    const first = await client.chatCompletion(request);
    const second = await client.chatCompletion(request);
    expect(first.usage.cacheWriteTokens).toBeGreaterThan(0);
    expect(first.usage.cacheReadTokens).toBe(0);
    expect(second.usage.cacheReadTokens).toBeGreaterThan(0);
    expect(second.usage.promptTokens).toBeGreaterThan(second.usage.cacheReadTokens!);
  });

  it('puts eager input streaming on exactly the two document tools and keeps tools byte-stable across requests', async () => {
    await startFake();
    const { client } = makeClient();
    const tools = ['read_file', 'write_file', 'save_product_document', 'list_files'].map(tool);
    await client.chatCompletion({ ...hello, tools });
    await client.chatCompletion({ ...hello, tools });
    const [first, second] = posts();
    expect(first.body.tools.filter((entry: any) => entry.eager_input_streaming).map((entry: any) => entry.name)).toEqual(['write_file', 'save_product_document']);
    expect(JSON.stringify(first.body.tools)).toBe(JSON.stringify(second.body.tools));
  });

  it('re-sends the real tools with tool_choice none when the caller withholds them mid tool loop, on a switchable model', async () => {
    await startFake();
    const { client } = makeClient();
    const tools = [tool('read_file')];
    fake!.reply = () => ({ content: [{ type: 'tool_use', id: 'toolu_1', name: 'read_file', input: { path: 'a' } }] });
    const opening = await client.chatCompletion({ messages: [{ role: 'user', content: 'go' }], tools, route: { model: 'claude-haiku-5-5' } });
    expect(opening.toolCalls?.[0].function.name).toBe('read_file');
    fake!.reply = undefined;
    const history: ChatCompletionRequest['messages'] = [
      { role: 'user', content: 'go' },
      { role: 'assistant', content: '', providerOutput: opening.providerOutput, tool_calls: opening.toolCalls! } as any,
      { role: 'tool', content: 'file contents', toolCallId: 'toolu_1' },
    ];
    for (const withheld of [undefined, []] as const) {
      await client.chatCompletion({ messages: history, tools: withheld ? [...withheld] : undefined, route: { model: 'claude-haiku-5-5' } });
      const sent = posts().at(-1)!.body;
      expect(sent.tool_choice).toEqual({ type: 'none' });
      expect(sent.tools.map((entry: any) => entry.name)).toEqual(['read_file']);
      expect(sent.thinking?.type).not.toBe('disabled');
    }
  });

  it('shims JSON mode (instruction plus fence removal) and sends native structured output for both real schemas', async () => {
    await startFake();
    const { client } = makeClient();
    fake!.reply = () => ({ content: [{ type: 'text', text: '```json\n{"ok":true}\n```' }] });
    const plain = await client.chatCompletion({ ...hello, responseFormat: { type: 'json_object' } });
    expect(plain.content).toBe('{"ok":true}');
    expect(posts()[0].body.system).toContain('Return exactly one JSON object');

    fake!.reply = () => ({ content: [{ type: 'text', text: '{"status":"ready"}' }] });
    for (const format of [ANALYTICS_JOB_PLAN_RESPONSE_FORMAT, ANALYTICS_IMPORT_PROPOSAL_RESPONSE_FORMAT]) {
      const result = await client.chatCompletion({ ...hello, responseFormat: format, think: true, reasoningEffort: 'low' });
      expect(result.content).toBe('{"status":"ready"}');
      const sent = posts().at(-1)!.body.output_config;
      expect(sent.format.type).toBe('json_schema');
      expect(JSON.stringify(sent.format.schema)).not.toMatch(/"(minimum|maximum|minItems|maxItems)"/);
      expect(sent.effort).toBe('low');
    }
  });
});

describe('Anthropic client: streaming and results', () => {
  it('streams thinking, text and tool calls, and returns blocks that replay verbatim', async () => {
    await startFake();
    const { client } = makeClient();
    fake!.reply = () => ({
      content: [
        { type: 'thinking', thinking: 'plan the read' },
        { type: 'text', text: 'Reading now. ' },
        { type: 'tool_use', id: 'toolu_a', name: 'read_file', input: { path: 'a.txt' } },
      ],
      stream: { pings: true, chunk: 5 },
    });
    const generator = client.chatCompletionStream({ ...hello, tools: [tool('read_file')], think: true, reasoningEffort: 'low', showThinking: true, usageContext: { workload: 'interactive' } });
    const chunks = [];
    let step = await generator.next();
    while (!step.done) { chunks.push(step.value); step = await generator.next(); }
    const result = step.value;
    expect(chunks.filter(chunk => chunk.type === 'thinking').map(chunk => chunk.text).join('')).toBe('plan the read');
    expect(chunks.filter(chunk => chunk.type === 'content').map(chunk => chunk.text).join('')).toBe('Reading now. ');
    expect(chunks.find(chunk => chunk.type === 'tool_call_start')!.toolCall).toEqual({ index: 0, id: 'toolu_a', name: 'read_file' });
    expect(chunks.at(-1)).toMatchObject({ type: 'done' });
    expect(result.finishReason).toBe('tool_calls');
    expect(result.toolCalls).toEqual([{ id: 'toolu_a', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } }]);
    expect(result.providerOutput?.map((block: any) => block.type)).toEqual(['thinking', 'text', 'tool_use']);
    expect((result.providerOutput![0] as any).signature).toMatch(/^sig_fake_/);
    // summarized thinking text reaches the UI only for interactive streaming with thinking on and Show model thinking on
    expect(posts()[0].body.thinking).toEqual({ type: 'adaptive', display: 'summarized' });
  });

  it('omits the thinking text when Show model thinking is off, and keeps the signed block for replay', async () => {
    await startFake();
    const { client } = makeClient();
    fake!.reply = () => ({ content: [{ type: 'thinking', thinking: 'plan the read' }, { type: 'text', text: 'Done.' }] });
    for (const showThinking of [false, undefined]) {
      const generator = client.chatCompletionStream({ ...hello, think: true, reasoningEffort: 'low', ...(showThinking === undefined ? {} : { showThinking }), usageContext: { workload: 'interactive' } });
      const chunks = [];
      let step = await generator.next();
      while (!step.done) { chunks.push(step.value); step = await generator.next(); }
      expect(posts().at(-1)!.body.thinking).toEqual({ type: 'adaptive', display: 'omitted' });
      expect(chunks.some(chunk => chunk.type === 'thinking')).toBe(false);
      expect((step.value.providerOutput![0] as any)).toMatchObject({ type: 'thinking', thinking: '' });
      expect((step.value.providerOutput![0] as any).signature).toMatch(/^sig_fake_/);
    }
    // Background work never shows thinking, even if a caller sets the flag.
    const background = client.chatCompletionStream({ ...hello, think: true, reasoningEffort: 'low', showThinking: true, usageContext: { workload: 'background' } });
    let step = await background.next();
    while (!step.done) step = await background.next();
    expect(posts().at(-1)!.body.thinking).toEqual({ type: 'adaptive', display: 'omitted' });
  });

  it('answers a non-streaming call through the same SSE path', async () => {
    await startFake();
    const { client } = makeClient();
    const response = await client.chatCompletion(hello);
    expect(response).toMatchObject({ content: 'pong', toolCalls: null, finishReason: 'stop' });
    expect(posts()[0].body.stream).toBe(true);
  });

  it('ignores a tool call the caller did not offer tools for', async () => {
    await startFake();
    const { client } = makeClient();
    fake!.reply = () => ({ content: [{ type: 'text', text: 'done' }, { type: 'tool_use', name: 'read_file', input: {} }] });
    const response = await client.chatCompletion(hello);
    expect(response.toolCalls).toBeNull();
    expect(response.finishReason).toBe('stop');
  });

  it('reports Stop as control flow: an aborted turn throws, leaves health alone and closes the attempt partial', async () => {
    await startFake();
    const storage = createStorage(':memory:'); storage.initialize(); storages.push(storage);
    const { client } = makeClient({ usage: createLlmUsageService(storage.getDb(), { primaryProvider: 'gateway' }) });
    await client.healthCheck();
    fake!.reply = () => ({ content: [{ type: 'text', text: 'x'.repeat(2_000) }], stream: { chunk: 10, gapMs: 20 } });
    const controller = new AbortController();
    const generator = client.chatCompletionStream({ ...hello, signal: controller.signal });
    await generator.next();
    controller.abort(new Error('stopped by owner'));
    await expect(generator.next()).rejects.toBeDefined();
    expect(client.isAvailable()).toBe(true);
    expect(storage.getDb().prepare('SELECT status FROM llm_usage_attempts').all()).toEqual([{ status: 'partial' }]);
  });

  it('turns a stream that ends without message_stop into a transient "terminated" error and marks only a route-less call', async () => {
    await startFake();
    const { client } = makeClient();
    fake!.reply = () => ({ stream: { truncateAfter: 3 } });
    await client.healthCheck();
    const routed = await client.chatCompletion({ ...hello, route: { model: 'claude-sonnet-5-5' } }).catch(error => error);
    expect(String(routed.message)).toMatch(/terminated before message_stop/);
    expect(isTransientStreamError(routed)).toBe(true);
    expect(client.isAvailable()).toBe(true);
    const routeless = await client.chatCompletion(hello).catch(error => error);
    expect(String(routeless.message)).toMatch(/terminated/);
    expect(client.isAvailable()).toBe(false);
    await client.healthCheck();
    expect(client.isAvailable()).toBe(true);
  });
});

describe('Anthropic client: errors, health and provider issues (D10 table)', () => {
  const first = (name: string) => FAKE_D10_ROWS.find(row => row.name.startsWith(name))!.answer;
  const reset = async (client: { healthCheck(): Promise<boolean> }) => { fake!.respond = undefined; await client.healthCheck(); };

  it('treats every 4xx but 401 as request-specific: health stays true for 400, 403, 404 and 409, route-less or routed', async () => {
    await startFake();
    const { client } = makeClient();
    for (const row of ['400 other', '403', '404', '409']) {
      await client.healthCheck();
      const answerRow = first(row);
      failPosts(answerRow.status, answerRow.body);
      const error = await client.chatCompletion(hello).catch(e => e);
      expect(error).toBeInstanceOf(AnthropicApiError);
      expect(String(error.message)).toMatch(new RegExp(`^HTTP ${answerRow.status}`));
      expect(client.isAvailable(), row).toBe(true);
      expect(client.getProviderIssue?.(), row).toBeUndefined();
      expect(isTransientStreamError(error), row).toBe(false);
    }
  });

  it('a 401 sets auth_rejected; a route-less call also marks health, a routed one only records the issue', async () => {
    await startFake();
    const { client } = makeClient();
    failPosts(401, first('401').body);
    await client.healthCheck();
    await client.chatCompletion({ ...hello, route: { model: 'claude-sonnet-5-5' } }).catch(() => undefined);
    expect(client.isAvailable()).toBe(true);
    expect(client.getProviderIssue?.()).toMatchObject({ code: 'auth_rejected', httpStatus: 401 });
    await reset(client);
    failPosts(401, first('401').body);
    await client.chatCompletion(hello).catch(() => undefined);
    expect(client.isAvailable()).toBe(false);
  });

  it('marks health for a route-less 5xx, 504 and network failure, never for a routed one (L15)', async () => {
    await startFake();
    const { client } = makeClient();
    for (const kind of ['500', '504', 'network'] as const) {
      for (const routed of [true, false]) {
        await reset(client);
        if (kind === 'network') fake!.dropNext = 1;
        else failPosts(kind === '500' ? 500 : 504, fakeErrorBody('api_error', 'boom'));
        const error = await client.chatCompletion(routed ? { ...hello, route: { model: 'claude-sonnet-5-5' } } : hello).catch(e => e);
        expect(error).toBeInstanceOf(Error);
        expect(client.isAvailable(), `${kind} routed=${routed}`).toBe(routed);
        if (kind !== 'network') expect(isTransientStreamError(error)).toBe(true);
      }
    }
  });

  it('keeps the primary path health-neutral even for a route-less 500', async () => {
    await startFake();
    const { client } = makeClient();
    await client.healthCheck();
    failPosts(500, fakeErrorBody('api_error', 'boom'));
    await client.chatCompletionPrimary(hello).catch(() => undefined);
    expect(client.isAvailable()).toBe(true);
  });

  it('is neutral both ways on the primary path: a good primary call does not clear an unhealthy flag, a route-less generation does', async () => {
    await startFake();
    const { client } = makeClient();
    await client.healthCheck();
    failPosts(500, fakeErrorBody('api_error', 'boom'));
    await client.chatCompletion(hello).catch(() => undefined);
    expect(client.isAvailable()).toBe(false);
    fake!.respond = undefined;
    expect((await client.chatCompletionPrimary(hello)).content).toBe('pong');
    expect(client.isAvailable()).toBe(false);
    expect((await client.chatCompletion(hello)).content).toBe('pong');
    expect(client.isAvailable()).toBe(true);
  });

  it('treats credit exhaustion as terminal: 402, a spend limit the owner set and the tier cap; one request, no retry, health untouched', async () => {
    await startFake();
    const { client, sleeps } = makeClient();
    for (const row of ['402', '400 owner spend limit', '429 tier spend cap']) {
      await reset(client);
      const answerRow = first(row);
      failPosts(answerRow.status, answerRow.body, answerRow.headers);
      const before = posts().length;
      const error = await client.chatCompletion(hello).catch(e => e);
      expect(error, row).toBeInstanceOf(LlmQuotaExhaustedError);
      expect(error.platform).toBe('anthropic');
      expect(error.nextAction).toContain('platform.claude.com/settings/billing');
      expect(posts().length - before, row).toBe(1);
      expect(client.isAvailable(), row).toBe(true);
      expect(client.getProviderIssue?.(), row).toMatchObject({ code: 'quota_exhausted' });
      expect(isLlmProviderLimitError(error)).toBe(true);
    }
    expect(sleeps).toEqual([]);
    fake!.respond = undefined;
    await client.chatCompletion(hello);
    expect(client.getProviderIssue?.()).toBeUndefined();
  });

  it('waits as instructed on a 429 and resends; every resend is another request', async () => {
    await startFake();
    const { client, sleeps } = makeClient();
    let calls = 0;
    fake!.respond = request => (request.path === '/v1/messages' && ++calls === 1 ? answer(429, first('429 rate_limit_error').body, { 'retry-after': '3' }) : undefined);
    const response = await client.chatCompletion(hello);
    expect(response.content).toBe('pong');
    expect(sleeps).toEqual([3000]);
    expect(posts()).toHaveLength(2);
    expect(client.getProviderIssue?.()).toBeUndefined();
  });

  it('gives up after three resends with a rate-limit error, never touching health, and ends at once when the wait is over 20 s', async () => {
    await startFake();
    const { client, sleeps } = makeClient();
    await client.healthCheck();
    failPosts(429, first('429 rate_limit_error').body, { 'retry-after': '2' });
    const error = await client.chatCompletion(hello).catch(e => e);
    expect(error).toBeInstanceOf(LlmRateLimitedError);
    expect(error.message).toContain('about 2s');
    expect(sleeps).toEqual([2000, 2000, 2000]);
    expect(posts()).toHaveLength(4);
    expect(client.isAvailable()).toBe(true);
    expect(client.getProviderIssue?.()).toMatchObject({ code: 'rate_limited', httpStatus: 429 });

    const before = posts().length;
    failPosts(429, first('429 rate_limit_error').body, { 'retry-after': '25' });
    await expect(client.chatCompletion(hello)).rejects.toBeInstanceOf(LlmRateLimitedError);
    expect(posts().length - before).toBe(1);
  });

  it('backs off 2 s, 4 s, 8 s without a usable retry-after, and ignores a negative or malformed one', async () => {
    await startFake();
    for (const header of [undefined, '-5', 'soon']) {
      const { client, sleeps } = makeClient();
      failPosts(429, first('429 rate_limit_error').body, header ? { 'retry-after': header } : {});
      await client.chatCompletion(hello).catch(() => undefined);
      expect(sleeps, String(header)).toEqual([2000, 4000, 8000]);
    }
  });

  it('retries 529 in the same bounded loop and then says Anthropic is busy; the key is fine, so health and Settings stay ready', async () => {
    await startFake();
    const { client, sleeps } = makeClient();
    await client.healthCheck();
    failPosts(529, first('529').body);
    const error = await client.chatCompletion(hello).catch(e => e);
    expect(error).toBeInstanceOf(LlmProviderOverloadedError);
    expect(error.message).toBe('Anthropic is temporarily overloaded.');
    expect(error.nextAction).toBe('Anthropic is busy. BotBoy already retried; try again in a minute.');
    expect(sleeps).toEqual([2000, 4000, 8000]);
    expect(isLlmProviderLimitError(error)).toBe(true);
    expect(client.isAvailable()).toBe(true);
    expect(client.getProviderIssue?.()).toMatchObject({ code: 'overloaded', httpStatus: 529 });
    await client.chatCompletion({ ...hello, route: { model: 'claude-haiku-5-5' } }).catch(() => undefined);
    expect(client.isAvailable()).toBe(true);
  });

  it('turns a 413 into the typed payload error without touching health', async () => {
    await startFake();
    const { client } = makeClient();
    await client.healthCheck();
    failPosts(413, first('413').body);
    const error = await client.chatCompletion(hello).catch(e => e);
    expect(error).toBeInstanceOf(LlmPayloadTooLargeError);
    expect(error.source).toBe('remote');
    expect(client.isAvailable()).toBe(true);
  });

  it('lets a mid-stream error event take the same table: overloaded becomes the typed error and a limit, billing becomes credit exhaustion', async () => {
    await startFake();
    const { client } = makeClient();
    await client.healthCheck();
    fake!.reply = () => ({ stream: { error: { type: 'overloaded_error', message: 'Overloaded', afterEvents: 3 } } });
    const busy = await client.chatCompletion(hello).catch(e => e);
    expect(busy).toBeInstanceOf(LlmProviderOverloadedError);
    expect(isTransientStreamError(busy)).toBe(true);
    fake!.reply = () => ({ stream: { error: { type: 'billing_error', message: 'low balance', afterEvents: 3 } } });
    await expect(client.chatCompletion(hello)).rejects.toBeInstanceOf(LlmQuotaExhaustedError);
    fake!.reply = () => ({ stream: { error: { type: 'api_error', message: 'internal', afterEvents: 3 } } });
    const server = await client.chatCompletion(hello).catch(e => e);
    expect(String(server.message)).toMatch(/^HTTP 500 \(api_error\)/);
    expect(isTransientStreamError(server)).toBe(true);
    expect(client.isAvailable()).toBe(false); // a route-less server error
  });

  it('never lets a key-shaped string out: provider text is redacted and a non-JSON body is never shown', async () => {
    await startFake();
    const { client } = makeClient();
    const planted = ['sk', 'ant', 'api03', 'leakedkey0123456789abcdef0123'].join('-');
    const logged: string[] = [];
    for (const method of ['log', 'warn', 'error', 'info', 'debug'] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => { logged.push(printed(args)); });
    }
    failPosts(400, fakeErrorBody('invalid_request_error', `bad request echoing ${planted} and Bearer abcdefghijklmnop`));
    const error = await client.chatCompletion(hello).catch(e => e);
    expect(String(error.message)).not.toContain(planted);
    expect(String(error.message)).not.toContain('abcdefghijklmnop');
    expect(String(error.message)).toContain('redacted');
    failPosts(502, '<html>Cloudflare says secret-page-text</html>');
    const html = await client.chatCompletion(hello).catch(e => e);
    expect(String(html.message)).not.toContain('secret-page-text');
    const everything = [String(error.stack), String(html.stack), ...logged].join('\n');
    expect(everything).not.toContain(FAKE_ANTHROPIC_KEY);
    expect(everything).not.toContain(planted);
  });

  it('removes a key-shaped string from a transport failure too, and keeps the failure class so chat retries it', async () => {
    await startFake();
    const planted = ['sk', 'ant', 'api03', 'transportleak0123456789abcdef'].join('-');
    const original = `fetch failed: connect ECONNRESET with Bearer abcdefghijklmnopq ${planted}`;
    const { client } = makeClient({ options: { fetchImpl: async () => { throw new TypeError(original); } } });
    const error = await client.chatCompletion(hello).catch(e => e);
    expect(error.name).toBe('TypeError');
    expect(String(error.message)).not.toContain(planted);
    expect(String(error.message)).not.toContain('abcdefghijklmnopq');
    // Redaction is the only change: nothing is appended to the text, so no header or key can ride along.
    expect(error.message).toBe(redactProviderSecrets(original));
    expect(`${error.stack}`).not.toContain(FAKE_ANTHROPIC_KEY);
    expect(isTransientStreamError(error)).toBe(true);
  });

  it('refuses locally, before any request: a conversation that ends with the assistant, an unsupported image, a schema it cannot adapt, a non-strict format', async () => {
    await startFake();
    const { client } = makeClient();
    const attempt = (request: ChatCompletionRequest) => client.chatCompletion(request).catch(error => error);
    expect(await attempt({ messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }] })).toBeInstanceOf(AnthropicHistoryError);
    expect(await attempt({ messages: [{ role: 'user', content: 'x', images: ['data:image/svg+xml;base64,PHN2Zz48L3N2Zz4='] }] })).toBeInstanceOf(AnthropicHistoryError);
    const open = { type: 'object', additionalProperties: false, required: ['a'], properties: { a: { type: 'string' } } };
    expect(await attempt({ ...hello, responseFormat: { type: 'json_schema', name: 'x', strict: false as unknown as true, schema: open } })).toBeInstanceOf(Error);
    expect(await attempt({ ...hello, responseFormat: { type: 'json_schema', name: 'x', strict: true, schema: { ...open, additionalProperties: true } } })).toBeInstanceOf(Error);
    expect(posts()).toHaveLength(0);
    expect(client.isAvailable()).toBe(false); // never probed here; local failures leave health alone
    expect(AnthropicSchemaError).toBeDefined();
  });

  it('only counts a retryable stream error as transient: 5xx, overloaded, truncation and idle aborts retry; 4xx and limits do not', () => {
    for (const text of ['HTTP 500 (api_error): x', 'HTTP 529 (overloaded_error): Overloaded', 'Anthropic stream terminated before message_stop', 'LLM stream aborted: no data received for 280000ms', 'fetch failed']) {
      expect(isTransientStreamError(new Error(text)), text).toBe(true);
    }
    for (const text of ['HTTP 400 (invalid_request_error): x', 'HTTP 404 (not_found_error): x']) expect(isTransientStreamError(new Error(text)), text).toBe(false);
    expect(isTransientStreamError(new LlmRateLimitedError(1000))).toBe(false);
    expect(isTransientStreamError(new LlmQuotaExhaustedError('anthropic'))).toBe(false);
  });

  it('asks for a model-list refresh on a thinking-type 400 and on a 404, and on nothing else', async () => {
    await startFake();
    const stale: string[] = [];
    const { client } = makeClient({ options: { onModelsStale: reason => { stale.push(reason); } } });
    failPosts(400, fakeErrorBody('invalid_request_error', '`thinking.type.enabled` is not supported for this model. Use adaptive.'));
    await client.chatCompletion(hello).catch(() => undefined);
    failPosts(404, fakeErrorBody('not_found_error', 'model: claude-gone'));
    await client.chatCompletion(hello).catch(() => undefined);
    failPosts(400, fakeErrorBody('invalid_request_error', 'max_tokens: field required'));
    await client.chatCompletion(hello).catch(() => undefined);
    failPosts(403, fakeErrorBody('permission_error', 'no'));
    await client.chatCompletion(hello).catch(() => undefined);
    expect(stale).toEqual(['invalid_request', 'model_unavailable']);
  });
});

describe('Anthropic client: thinking replay recovery (D3 item 5)', () => {
  const tools = [tool('read_file')];
  /** One tool turn on a model BotBoy does not guard (prefixCheck false in the table) but the fake enforces. */
  async function turnWithThinking(client: ReturnType<typeof makeClient>['client']) {
    fake!.reply = () => ({ content: [{ type: 'thinking', thinking: 'plan' }, { type: 'tool_use', id: 'toolu_a', name: 'read_file', input: { path: 'a' } }] });
    const opening = await client.chatCompletion({ messages: [{ role: 'user', content: 'go' }], tools, think: true, reasoningEffort: 'low', route: { model: 'claude-opus-5' } });
    fake!.reply = undefined;
    return (editedFirst: boolean): ChatCompletionRequest => ({
      messages: [
        { role: 'user', content: editedFirst ? 'go (edited)' : 'go' },
        { role: 'assistant', content: '', providerOutput: opening.providerOutput, tool_calls: opening.toolCalls! } as any,
        { role: 'tool', content: 'file contents', toolCallId: 'toolu_a' },
      ],
      tools, think: true, reasoningEffort: 'low', route: { model: 'claude-opus-5' },
    });
  }
  const thinkingIn = (request: FakeRecordedRequest) => JSON.stringify(request.body.messages).includes('"thinking"');

  it('recovers the signature 400 once: strips every thinking block, resends, and keeps them out afterwards', async () => {
    await startFake({ thinkingChecks: { prefix: id => id === 'claude-opus-5' } });
    const logged: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { logged.push(args.map(String).join(' ')); });
    const storage = createStorage(':memory:'); storage.initialize(); storages.push(storage);
    const { client } = makeClient({ usage: createLlmUsageService(storage.getDb(), { primaryProvider: 'gateway' }) });
    const build = await turnWithThinking(client);
    const before = posts().length;
    const response = await client.chatCompletion(build(true));
    expect(response.content).toBe('pong');
    const sent = posts().slice(before);
    expect(sent).toHaveLength(2);
    expect(thinkingIn(sent[0])).toBe(true);
    expect(thinkingIn(sent[1])).toBe(false);
    expect(logged.filter(line => line.includes('removed it')).length).toBe(1);
    // The 400 attempt and the resend are two rows, both reason initial.
    const rows = storage.getDb().prepare("SELECT status, attempt_reason FROM llm_usage_attempts WHERE http_status IS NOT 200 OR status = 'completed' ORDER BY rowid").all() as Array<{ status: string; attempt_reason: string }>;
    expect(rows.filter(row => row.attempt_reason === 'initial').length).toBeGreaterThanOrEqual(3);
    // Later requests never send those blocks again, even with the history unchanged.
    await client.chatCompletion(build(false));
    expect(thinkingIn(posts().at(-1)!)).toBe(false);
  });

  it('recovers the latest-run 400 as well, but only when the sent body held a thinking block, and only once', async () => {
    await startFake();
    const { client } = makeClient();
    const build = await turnWithThinking(client);
    let calls = 0;
    const s9 = fakeErrorBody('invalid_request_error', `messages.1.content.0: ${FAKE_LATEST_RUN_400}`);
    fake!.respond = request => (request.path === '/v1/messages' && thinkingIn(request) && ++calls >= 1 ? answer(400, s9) : undefined);
    const before = posts().length;
    await expect(client.chatCompletion(build(false))).resolves.toMatchObject({ content: 'pong' });
    expect(posts().length - before).toBe(2);
    // No thinking in the body: the same 400 text is NOT recovered, it is the typed error.
    fake!.respond = request => (request.path === '/v1/messages' ? answer(400, s9) : undefined);
    const beforePlain = posts().length;
    const plain = await client.chatCompletion({ messages: [{ role: 'user', content: 'hi' }] }).catch(e => e);
    expect(plain).toBeInstanceOf(AnthropicApiError);
    expect(plain.classification.requestCause).toBe('thinking_replay');
    expect(posts().length - beforePlain).toBe(1);
  });

  it('a second such 400 is the typed error after exactly two requests (no loop)', async () => {
    await startFake();
    const { client } = makeClient();
    const build = await turnWithThinking(client);
    const s22 = fakeErrorBody('invalid_request_error', `messages.1.content.0: ${FAKE_SIGNATURE_400}.`);
    fake!.respond = request => (request.path === '/v1/messages' ? answer(400, s22) : undefined);
    const before = posts().length;
    const error = await client.chatCompletion(build(false)).catch(e => e);
    expect(error).toBeInstanceOf(AnthropicApiError);
    expect(error.classification).toMatchObject({ kind: 'invalid_request', requestCause: 'thinking_replay' });
    expect(String(error.message)).toMatch(/^HTTP 400/);
    expect(posts().length - before).toBe(2);
  });

  it('with the optional first step on, retries with drop_block (beta header and field) first; the API then drops the block itself', async () => {
    await startFake({ thinkingChecks: { prefix: id => id === 'claude-opus-5' } });
    const { client } = makeClient({ options: { recoveryDropBlockFirst: true } });
    const build = await turnWithThinking(client);
    const before = posts().length;
    const accepted = await client.chatCompletion(build(true));
    expect(accepted.content).toBe('pong');
    const steps = posts().slice(before);
    expect(steps.map(request => request.headers['anthropic-beta'])).toEqual([undefined, FAKE_BINDING_BETA]);
    expect(steps[1].body.thinking.block_binding).toEqual({ prefix_mismatch_behavior: 'drop_block' });
    expect(thinkingIn(steps[0])).toBe(true);
  });

  it('with the optional first step on, strips everything when the account refuses the beta field', async () => {
    await startFake({ thinkingChecks: { prefix: id => id === 'claude-opus-5' } });
    const { client } = makeClient({ options: { recoveryDropBlockFirst: true } });
    const build = await turnWithThinking(client);
    fake!.respond = request => (request.path === '/v1/messages' && request.headers['anthropic-beta']
      ? answer(400, fakeErrorBody('invalid_request_error', 'anthropic-beta: Unexpected value(s) for the `anthropic-beta` header'))
      : undefined);
    const before = posts().length;
    const result = await client.chatCompletion(build(true));
    expect(result.content).toBe('pong');
    const steps = posts().slice(before);
    expect(steps.map(request => Boolean(request.headers['anthropic-beta']))).toEqual([false, true, false]);
    expect(thinkingIn(steps[2])).toBe(false);
  });

  it('never needs the recovery when the guard already dropped the edited run (an enforcing model)', async () => {
    await startFake({ thinkingChecks: { prefix: true } });
    const { client } = makeClient();
    fake!.reply = () => ({ content: [{ type: 'thinking', thinking: 'plan' }, { type: 'tool_use', id: 'toolu_a', name: 'read_file', input: { path: 'a' } }] });
    const opening = await client.chatCompletion({ messages: [{ role: 'user', content: 'go' }], tools, think: true, reasoningEffort: 'low' });
    fake!.reply = undefined;
    const before = posts().length;
    const response = await client.chatCompletion({
      messages: [
        { role: 'user', content: 'go (edited)' },
        { role: 'assistant', content: '', providerOutput: opening.providerOutput, tool_calls: opening.toolCalls! } as any,
        { role: 'tool', content: 'file contents', toolCallId: 'toolu_a' },
      ],
      tools, think: true, reasoningEffort: 'low',
    });
    expect(response.content).toBe('pong');
    expect(posts().length - before).toBe(1);
    expect(thinkingIn(posts().at(-1)!)).toBe(false);
  });

  it('keeps one guard per client: a shared instance sees the ledger across calls', async () => {
    await startFake({ thinkingChecks: { prefix: true } });
    const guard = createReplayGuard();
    const { client } = makeClient({ options: { guard } });
    fake!.reply = () => ({ content: [{ type: 'thinking', thinking: 'plan' }, { type: 'text', text: 'ok' }] });
    await client.chatCompletion({ ...hello, think: true, reasoningEffort: 'low' });
    expect(guard.sizes.ledger).toBe(1);
  });
});

describe('Anthropic client: usage rows (D3, D10)', () => {
  it('labels every attempt anthropic / messages and records cache and thinking tokens; a 429 resend is its own row', async () => {
    await startFake();
    const storage = createStorage(':memory:'); storage.initialize(); storages.push(storage);
    const { client } = makeClient({ usage: createLlmUsageService(storage.getDb(), { primaryProvider: 'gateway' }) });
    fake!.reply = () => ({
      content: [{ type: 'thinking', thinking: 'plan' }, { type: 'text', text: 'ok' }],
      usage: { input_tokens: 100, cache_creation_input_tokens: 20, cache_read_input_tokens: 300, output_tokens: 1 },
      finalUsage: { output_tokens: 50, output_tokens_details: { thinking_tokens: 30 } },
    });
    let calls = 0;
    fake!.respond = request => (request.path === '/v1/messages' && ++calls === 1 ? answer(429, fakeErrorBody('rate_limit_error', 'slow'), { 'retry-after': '1' }) : undefined);
    await client.chatCompletion({ ...hello, think: true, reasoningEffort: 'low', usageContext: { workload: 'interactive' } });
    const rows = storage.getDb().prepare(
      'SELECT provider, api_mode, model, stream, status, http_status, input_tokens, output_tokens, total_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens FROM llm_usage_attempts ORDER BY rowid',
    ).all() as any[];
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ provider: 'anthropic', api_mode: 'messages', model: 'claude-sonnet-5-5', stream: 1, status: 'failed', http_status: 429 });
    expect(rows[1]).toMatchObject({
      provider: 'anthropic', api_mode: 'messages', status: 'completed', http_status: 200,
      input_tokens: 420, output_tokens: 50, total_tokens: 470, cache_read_tokens: 300, cache_write_tokens: 20, reasoning_tokens: 30,
    });
  });
});

describe('Anthropic client: how a failed stream is recorded (A2 review carry-over 1)', () => {
  it('names the real cause of a mid-stream failure in error_class, and only a consumer that walks away reads StreamConsumerAbandoned', async () => {
    await startFake();
    const storage = createStorage(':memory:'); storage.initialize(); storages.push(storage);
    const { client } = makeClient({
      usage: createLlmUsageService(storage.getDb(), { primaryProvider: 'gateway' }),
      // Generous against a loaded machine: the first byte must arrive inside this window for the failure to be mid-stream.
      config: { streamIdleTimeoutMs: 400 },
    });
    const rows = () => storage.getDb().prepare('SELECT status, http_status, error_class, usage_reported FROM llm_usage_attempts ORDER BY rowid').all() as any[];
    const long = [{ type: 'text' as const, text: 'x'.repeat(200) }];

    // An idle abort: the server goes quiet after the first events.
    fake!.reply = () => ({ content: long, stream: { chunk: 20, gapMs: 2_500 } });
    const idle = await client.chatCompletion(hello).catch(error => error);
    expect(String(idle.message)).toMatch(/aborted: no data received for 400ms/);
    // A network reset: the connection drops after three events.
    fake!.reply = () => ({ content: long, stream: { chunk: 20, resetAfter: 3 } });
    const reset = await client.chatCompletion(hello).catch(error => error);
    expect(isTransientStreamError(reset)).toBe(true);
    // An overloaded `error` event after a 200.
    fake!.reply = () => ({ content: long, stream: { chunk: 20, error: { type: 'overloaded_error', message: 'Overloaded', afterEvents: 3 } } });
    const busy = await client.chatCompletion(hello).catch(error => error);
    expect(busy).toBeInstanceOf(LlmProviderOverloadedError);
    // A stream that ends without message_stop.
    fake!.reply = () => ({ content: long, stream: { chunk: 20, truncateAfter: 3 } });
    const cut = await client.chatCompletion(hello).catch(error => error);
    expect(String(cut.message)).toMatch(/terminated before message_stop/);
    // A consumer that stops reading after the first chunk.
    fake!.reply = () => ({ content: long, stream: { chunk: 10, gapMs: 20 } });
    const generator = client.chatCompletionStream(hello);
    await generator.next();
    await generator.return(undefined as never);

    const recorded = rows();
    expect(recorded.map(row => row.error_class)).toEqual([idle.name, reset.name, 'LlmProviderOverloadedError', cut.name, 'StreamConsumerAbandoned']);
    // Four failures carry a cause of their own; none of them reads as an abandoned stream.
    for (const row of recorded.slice(0, 4)) expect(row.error_class).not.toBe('StreamConsumerAbandoned');
    expect(recorded.map(row => row.status)).toEqual(['partial', 'partial', 'partial', 'partial', 'partial']);
    expect(recorded.every(row => row.http_status === 200)).toBe(true);
    // An overloaded error event is the provider's own busy answer, not an unnamed Error.
    expect(recorded[2].error_class).toBe('LlmProviderOverloadedError');
    expect(reset.name).not.toBe('');
  });

  it('closes a stopped turn (the owner pressed Stop) as a partial row with the abort as its cause', async () => {
    await startFake();
    const storage = createStorage(':memory:'); storage.initialize(); storages.push(storage);
    const { client } = makeClient({ usage: createLlmUsageService(storage.getDb(), { primaryProvider: 'gateway' }) });
    fake!.reply = () => ({ content: [{ type: 'text', text: 'x'.repeat(2_000) }], stream: { chunk: 10, gapMs: 20 } });
    const controller = new AbortController();
    const generator = client.chatCompletionStream({ ...hello, signal: controller.signal });
    await generator.next();
    controller.abort(new Error('stopped by owner'));
    const error = await generator.next().then(() => undefined, caught => caught);
    expect(error).toBeDefined();
    const [row] = storage.getDb().prepare('SELECT status, error_class FROM llm_usage_attempts').all() as any[];
    expect(row.status).toBe('partial');
    expect(row.error_class).toBe(error.name);
    expect(row.error_class).not.toBe('StreamConsumerAbandoned');
  });
});

describe('Anthropic client: stream timing and budgets', () => {
  it('aborts a silent stream after 280 s by default, lets a ping reset the clock, and lets a configured value win', async () => {
    vi.useFakeTimers();
    const encoder = new TextEncoder();
    /** A client whose POST returns a stream the test controls; the free probe gets a plain answer. */
    const silentClient = (overrides: Partial<LlmConfig> = {}) => {
      let controller!: ReadableStreamDefaultController<Uint8Array>;
      const body = new ReadableStream<Uint8Array>({ start(c) { controller = c; } });
      const fetchImpl = (async (input: unknown, init?: RequestInit) => {
        if (String(input).includes('/v1/models')) return new Response('{"data":[]}', { status: 200 });
        init?.signal?.addEventListener('abort', () => controller.error(init.signal!.reason));
        return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
      }) as typeof fetch;
      const client = createAnthropicLlmClient(configFor('http://127.0.0.1:9', overrides), { apiKey: FAKE_ANTHROPIC_KEY, profiles, fetchImpl });
      clients.push(client);
      let state = 'pending';
      client.chatCompletion(hello).then(() => { state = 'done'; }, error => { state = String(error.message); });
      return {
        state: () => state,
        ping: () => controller.enqueue(encoder.encode('event: ping\ndata: {"type":"ping"}\n\n')),
      };
    };
    expect(ANTHROPIC_STREAM_IDLE_TIMEOUT_MS).toBe(280_000);

    // Default: still waiting at 279,999 ms of silence; the typed abort fires at 280,000 ms.
    const quiet = silentClient();
    await vi.advanceTimersByTimeAsync(279_999);
    expect(quiet.state()).toBe('pending');
    await vi.advanceTimersByTimeAsync(2);
    expect(quiet.state()).toMatch(/aborted: no data received for 280000ms/);

    // A ping at 200 s resets the clock: the abort comes 280 s after the ping, not after the request.
    const pinged = silentClient();
    await vi.advanceTimersByTimeAsync(200_000);
    pinged.ping();
    await vi.advanceTimersByTimeAsync(279_000);
    expect(pinged.state()).toBe('pending');
    await vi.advanceTimersByTimeAsync(2_000);
    expect(pinged.state()).toMatch(/aborted: no data received for 280000ms/);

    // A configured value wins over the default.
    const short = silentClient({ streamIdleTimeoutMs: 5_000 });
    await vi.advanceTimersByTimeAsync(4_999);
    expect(short.state()).toBe('pending');
    await vi.advanceTimersByTimeAsync(2);
    expect(short.state()).toMatch(/no data received for 5000ms/);
  });

  it('reports exactly the shared budget of 100,000 tokens for 200K and 1M windows alike (the budget comes from config, never from this client)', async () => {
    await startFake();
    for (const window of [200_000, 1_000_000]) {
      const { client } = makeClient({ config: { ecs: { endpoint: fake!.url, model: 'claude-sonnet-5-5', maxContextTokens: window, requestTimeoutMs: 1000 } } });
      expect(client.getContextBudgetTokens?.()).toBe(100_000);
      expect(client.getContextWindow?.()).toBe(window);
    }
    const { client: tight } = makeClient({ config: { defaults: { temperature: 0, maxCompletionTokens: 1024, contextBudgetTokens: 60_000 } } });
    expect(tight.getContextBudgetTokens?.()).toBe(60_000);
  });

  it('describes itself: provider anthropic, messages api, no fallback endpoint, default model and sizes', async () => {
    await startFake();
    const { client } = makeClient();
    expect(client.getProviderId?.()).toBe('anthropic');
    expect(client.getApiMode?.()).toBe('messages');
    expect(client.getDialect?.()).toBe('openai');
    expect(client.getDefaultModel()).toBe('claude-sonnet-5-5');
    expect(client.getMaxRequestBytes()).toBe(5_500_000);
    expect(client.getMaxCompletionTokens?.()).toBe(1024);
    expect(client.getActiveEndpoint()).toBe('none');
    await client.healthCheck();
    expect(client.getActiveModel?.()).toBe('claude-sonnet-5-5');
  });
});

describe('Anthropic client: preflight and the request size gate', () => {
  it('measures the exact body without sending anything, counting base64 image blocks', async () => {
    await startFake();
    const { client } = makeClient();
    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
    const preflight = client.preflightPrimary({ messages: [{ role: 'user', content: 'look', images: [png] }] });
    expect(preflight).toMatchObject({ model: 'claude-sonnet-5-5', apiMode: 'messages', imageCount: 1, maximumBytes: 5_500_000 });
    expect(preflight.remainingBytes).toBe(5_500_000 - preflight.bodyBytes);
    expect(fake!.requests.filter(request => request.method === 'POST')).toHaveLength(0);
  });

  it('fails an over-limit body locally with no request, and an image-free constraint fails an Anthropic body that still holds an image', async () => {
    await startFake();
    const { client } = makeClient({ config: { maxRequestBytes: 2_000 } });
    const big = await client.chatCompletion({ messages: [{ role: 'user', content: 'x'.repeat(5_000) }] }).catch(e => e);
    expect(big).toBeInstanceOf(LlmPayloadTooLargeError);
    expect(big.source).toBe('local');
    const { client: normal } = makeClient();
    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
    const stillHasImage = await normal.chatCompletion({ messages: [{ role: 'user', content: 'look', images: [png] }], payloadConstraint: { requireImageFree: true } }).catch(e => e);
    expect(String(stillHasImage.message)).toMatch(/image-free body/);
    expect(posts()).toHaveLength(0);
  });
});

describe('Anthropic client: the prompt log (A2 review carry-over 4)', () => {
  const originalHome = process.env.HOME;
  const homes: string[] = [];
  afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME; else process.env.HOME = originalHome;
    vi.resetModules();
    for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true });
  });

  it('holds the exact wire body and nothing about the credential: no key, no header, no key in the url', async () => {
    await startFake();
    // The log directory is fixed when the log module loads, so the client and the log load fresh under a private HOME.
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'b-clientlog-'));
    homes.push(home);
    process.env.HOME = home;
    delete process.env.BOTBOY_LLM_PROMPT_LOG;
    vi.resetModules();
    const fresh = await import('./anthropic-client.js');
    const { llmPromptLogDir } = await import('./llm-prompt-log.js');
    const dir = llmPromptLogDir();
    expect(dir.startsWith(home)).toBe(true);
    const client = fresh.createAnthropicLlmClient(configFor(fake!.url), { apiKey: FAKE_ANTHROPIC_KEY, profiles, sleep: async () => {} });
    clients.push(client);
    await client.chatCompletion({ messages: [{ role: 'system', content: 'You are BotBoy.' }, { role: 'user', content: 'hello' }] });

    // Logging is fire and forget: wait for the pair to be written. A file is listed as soon as it is opened, before its
    // content lands, so wait for both to hold content and the .json to parse.
    const deadline = Date.now() + 5_000;
    let names: string[] = [];
    let json: any;
    while (Date.now() < deadline) {
      names = fs.existsSync(dir) ? fs.readdirSync(dir).sort() : [];
      const complete = names.length >= 2 && names.every(name => fs.statSync(path.join(dir, name)).size > 0);
      if (complete) {
        try { json = JSON.parse(fs.readFileSync(path.join(dir, names.find(name => name.endsWith('.json'))!), 'utf8')); break; } catch { /* still being written */ }
      }
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    expect(names).toHaveLength(2);
    expect(json).toBeDefined();
    // Exactly the documented fields: a header map or a key added anywhere on the entry shows up here.
    expect(Object.keys(json).sort()).toEqual(['apiMode', 'bodyBytes', 'bodyChars', 'imageChars', 'imageCount', 'model', 'request', 'stream', 'ts', 'url']);
    expect(json.url).toBe(`${fake!.url}/v1/messages`);
    expect(json.request).toEqual(posts()[0].body);
    for (const name of names) {
      const text = fs.readFileSync(path.join(dir, name), 'utf8');
      expect(text).not.toContain(FAKE_ANTHROPIC_KEY);
      expect(text).not.toMatch(/x-api-key|authorization|anthropic-version/i);
    }
  });
});
