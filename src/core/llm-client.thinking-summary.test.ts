import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLlmClient, isReasoningSummaryRefusal, type ChatCompletionRequest, type LlmConfig } from './llm-client.js';
import { createStorage, type StorageLayer } from './storage.js';
import { createLlmUsageService } from './llm-usage.js';

/**
 * Settings → AI model → Show model thinking on Responses streams: the chat
 * panel's thinking turn asks for `reasoning.summary: 'auto'` (team gateway and
 * the owner's OpenAI key, never DeepSeek or a non-stream call), shows each
 * summary part as a paragraph, and survives a refused summary (an unverified
 * OpenAI organization) with one resend that the client remembers.
 */
const KEY = 'sk-proj-thinkingtest00000000000000wxyz';
const BASE = 'https://api.openai.test/v1';
const VERIFY_ORGANIZATION = {
  error: {
    message: 'Your organization must be verified to generate reasoning summaries. Please go to: https://platform.openai.com/settings/organization/general and click on Verify Organization. If you just verified, it can take up to 15 minutes for access to propagate.',
    type: 'invalid_request_error',
    param: 'reasoning.summary',
    code: 'unsupported_value',
  },
};

function config(overrides: Partial<LlmConfig> = {}): LlmConfig {
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
const gatewayConfig = () => config({ platform: undefined, providerId: 'gateway' });
const deepSeekConfig = () => config({ platform: 'deepseek', providerId: 'deepseek' });

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function sse(events: unknown[]): Response {
  return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

const USAGE = { input_tokens: 5, output_tokens: 3, total_tokens: 8 };
const plainStream = () => sse([
  { type: 'response.output_text.delta', delta: 'Hello' },
  { type: 'response.completed', response: { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'Hello' }] }], usage: USAGE } },
]);
const SUMMARY_ITEM = {
  type: 'reasoning',
  id: 'rs_1',
  encrypted_content: 'enc_1',
  summary: [{ type: 'summary_text', text: '**Planning**\n\nCheck the file.' }, { type: 'summary_text', text: '**Answering**\n\nReply now.' }],
};
const SUMMARY_TEXT = '**Planning**\n\nCheck the file.\n\n**Answering**\n\nReply now.';
const summaryStream = () => sse([
  { type: 'response.output_item.added', output_index: 0, item: { type: 'reasoning', id: 'rs_1', summary: [] } },
  { type: 'response.reasoning_summary_part.added', item_id: 'rs_1', output_index: 0, summary_index: 0 },
  { type: 'response.reasoning_summary_text.delta', item_id: 'rs_1', output_index: 0, summary_index: 0, delta: '**Planning**\n\nCheck ' },
  { type: 'response.reasoning_summary_text.delta', item_id: 'rs_1', output_index: 0, summary_index: 0, delta: 'the file.' },
  { type: 'response.reasoning_summary_part.added', item_id: 'rs_1', output_index: 0, summary_index: 1 },
  { type: 'response.reasoning_summary_text.delta', item_id: 'rs_1', output_index: 0, summary_index: 1, delta: '**Answering**\n\nReply now.' },
  { type: 'response.output_text.delta', delta: 'Done' },
  { type: 'response.completed', response: { status: 'completed', output: [SUMMARY_ITEM, { type: 'message', content: [{ type: 'output_text', text: 'Done' }] }], usage: USAGE } },
]);

type Handler = (body: any) => Response | Promise<Response>;

/** Records every generation POST body; the gateway profile's construction ping (non-stream "ping") is answered and skipped. */
function installFetch(answer: Handler) {
  const bodies: any[] = [];
  vi.stubGlobal('fetch', vi.fn(async (_input: unknown, init?: RequestInit) => {
    if (init?.method !== 'POST') return json(200, { id: 'gpt-5.6-terra', object: 'list', data: [{ id: 'gpt-5.6-terra' }] });
    const body = JSON.parse(String(init.body));
    if (JSON.stringify(body.input) === JSON.stringify([{ role: 'user', content: 'ping' }])) {
      return json(200, { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'pong' }] }], usage: USAGE });
    }
    bodies.push(body);
    return answer(body);
  }));
  return bodies;
}

const ask = (overrides: Partial<ChatCompletionRequest> = {}): ChatCompletionRequest => ({
  messages: [{ role: 'user', content: 'hi' }],
  think: true,
  reasoningEffort: 'high',
  showThinking: true,
  ...overrides,
});

async function drain(client: ReturnType<typeof createLlmClient>, request: ChatCompletionRequest) {
  const generator = client.chatCompletionStream(request);
  const thinking: string[] = [];
  let content = '';
  let step = await generator.next();
  while (!step.done) {
    if (step.value.type === 'thinking') thinking.push(step.value.text ?? '');
    if (step.value.type === 'content') content += step.value.text ?? '';
    step = await generator.next();
  }
  return { thinking, content, result: step.value };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('thinking summaries on Responses streams', () => {
  it('asks for a summary only on a thinking chat stream, on the gateway and the OpenAI key, never on DeepSeek', async () => {
    const bodies = installFetch(body => (body.stream
      ? plainStream()
      : json(200, { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'Hello' }] }], usage: USAGE })));
    const openai = createLlmClient(config());
    await drain(openai, ask());
    expect(bodies.at(-1)).toMatchObject({ reasoning: { effort: 'high', summary: 'auto' }, include: ['reasoning.encrypted_content'], stream: true });
    // Thinking Off, the switch unset or off: effort only.
    for (const request of [ask({ think: false }), ask({ showThinking: undefined }), ask({ showThinking: false })]) {
      await drain(openai, request);
      expect(bodies.at(-1).reasoning).toEqual({ effort: request.think ? 'high' : 'low' });
    }
    // A non-stream call never asks: only the stream path owns the refusal resend.
    await openai.chatCompletion(ask());
    expect(bodies.at(-1)).toMatchObject({ stream: false, reasoning: { effort: 'high' } });
    expect(bodies.at(-1).reasoning).not.toHaveProperty('summary');
    // A model that rejects reasoning parameters gets none.
    await drain(openai, ask({ route: { model: 'gpt-4o', supportsReasoning: false } }));
    expect(bodies.at(-1)).not.toHaveProperty('reasoning');
    openai.close();

    const gateway = createLlmClient(gatewayConfig());
    await drain(gateway, ask({ reasoningEffort: 'low' }));
    expect(bodies.at(-1)).toMatchObject({ reasoning: { effort: 'low', summary: 'auto' }, include: ['reasoning.encrypted_content'] });
    gateway.close();

    const deepseek = createLlmClient(deepSeekConfig());
    await drain(deepseek, ask());
    expect(bodies.at(-1).reasoning).toEqual({ effort: 'high' });
    expect(bodies.at(-1)).not.toHaveProperty('include');
    deepseek.close();
  });

  it('streams each summary part as its own paragraph and returns the same text, and the full response parses the same way', async () => {
    installFetch(body => (body.stream ? summaryStream() : json(200, { status: 'completed', output: [SUMMARY_ITEM, { type: 'message', content: [{ type: 'output_text', text: 'Done' }] }], usage: USAGE })));
    const client = createLlmClient(gatewayConfig());
    const { thinking, content, result } = await drain(client, ask());
    expect(thinking.join('')).toBe(SUMMARY_TEXT);
    expect(thinking).toContain('\n\n**Answering**\n\nReply now.');
    expect(result.reasoning).toBe(SUMMARY_TEXT);
    expect(content).toBe('Done');
    // The reasoning item, summary included, replays as it came.
    expect(result.providerOutput?.[0]).toEqual(SUMMARY_ITEM);
    const full = await client.chatCompletion(ask());
    expect(full.reasoning).toBe(SUMMARY_TEXT);
    client.close();
  });

  it('resends once without the summary when OpenAI refuses it, remembers the refusal per model, and keeps the endpoint healthy', async () => {
    let storage: StorageLayer | undefined;
    try {
      storage = createStorage(':memory:');
      storage.initialize();
      const db = storage.getDb();
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const bodies = installFetch(body => (body.reasoning?.summary ? json(400, VERIFY_ORGANIZATION) : plainStream()));
      const client = createLlmClient(config(), createLlmUsageService(db, { primaryProvider: 'openai' }));
      await client.healthCheck();

      const first = await drain(client, ask({ usageContext: { workload: 'interactive', operationId: 'op-1' } }));
      expect(first.content).toBe('Hello');
      expect(first.thinking).toEqual([]);
      expect(bodies.map(body => body.reasoning)).toEqual([{ effort: 'high', summary: 'auto' }, { effort: 'high' }]);
      expect(warn.mock.calls.filter(([line]) => String(line).includes('refused thinking summaries'))).toHaveLength(1);
      expect(String(warn.mock.calls.find(([line]) => String(line).includes('refused thinking summaries'))![0])).not.toContain('thinkingtest');
      expect(client.isAvailable()).toBe(true);
      const attempts = db.prepare("SELECT attempt_ordinal, status, http_status, error_class FROM llm_usage_attempts WHERE operation_id = 'op-1' ORDER BY attempt_ordinal").all();
      expect(attempts).toEqual([
        { attempt_ordinal: 1, status: 'failed', http_status: 400, error_class: 'HTTP_400' },
        { attempt_ordinal: 2, status: 'completed', http_status: 200, error_class: null },
      ]);

      // The same model is not asked again; another model is.
      bodies.length = 0;
      await drain(client, ask());
      expect(bodies.map(body => body.reasoning)).toEqual([{ effort: 'high' }]);
      bodies.length = 0;
      await drain(client, ask({ route: { model: 'gpt-6-sol' } }));
      expect(bodies.map(body => [body.model, body.reasoning])).toEqual([
        ['gpt-6-sol', { effort: 'high', summary: 'auto' }],
        ['gpt-6-sol', { effort: 'high' }],
      ]);
      client.close();
    } finally {
      storage?.close();
    }
  });

  it('treats a gateway that names the field the same way', async () => {
    const bodies = installFetch(body => (body.reasoning?.summary
      ? json(400, { message: "Unsupported parameter: 'reasoning.summary' is not supported with this model." })
      : plainStream()));
    const client = createLlmClient(gatewayConfig());
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect((await drain(client, ask())).content).toBe('Hello');
    expect(bodies.map(body => body.reasoning)).toEqual([{ effort: 'high', summary: 'auto' }, { effort: 'high' }]);
    client.close();
  });

  it('keeps every other failure ordinary: no resend, and a refusal text on a request without a summary is not retried', async () => {
    let answer = () => json(400, { error: { message: 'Invalid value for input.' } });
    const bodies = installFetch(() => answer());
    const client = createLlmClient(config());
    await expect(drain(client, ask())).rejects.toThrow(/HTTP 400: .*Invalid value for input/);
    expect(bodies).toHaveLength(1);

    bodies.length = 0;
    answer = () => json(400, VERIFY_ORGANIZATION);
    await expect(drain(client, ask({ showThinking: false }))).rejects.toThrow(/HTTP 400/);
    expect(bodies).toHaveLength(1);

    bodies.length = 0;
    answer = () => json(500, VERIFY_ORGANIZATION);
    await expect(drain(client, ask())).rejects.toThrow(/HTTP 500/);
    expect(bodies).toHaveLength(1);
    expect(bodies[0].reasoning).toEqual({ effort: 'high', summary: 'auto' });
    client.close();
  });
});

describe('isReasoningSummaryRefusal', () => {
  it('matches only an HTTP 400 that names reasoning summaries', () => {
    expect(isReasoningSummaryRefusal(400, JSON.stringify(VERIFY_ORGANIZATION))).toBe(true);
    expect(isReasoningSummaryRefusal(400, "Unsupported parameter: 'reasoning.summary'")).toBe(true);
    expect(isReasoningSummaryRefusal(400, 'unknown field reasoning_summary')).toBe(true);
    expect(isReasoningSummaryRefusal(400, 'Invalid value for input.')).toBe(false);
    expect(isReasoningSummaryRefusal(400, 'The summary is too long')).toBe(false);
    expect(isReasoningSummaryRefusal(500, JSON.stringify(VERIFY_ORGANIZATION))).toBe(false);
    expect(isReasoningSummaryRefusal(403, JSON.stringify(VERIFY_ORGANIZATION))).toBe(false);
    expect(isReasoningSummaryRefusal(400, '')).toBe(false);
  });
});
