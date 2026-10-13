import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatCompletionRequest, LlmClient } from './llm-client.js';
import { parseAnthropicModel, type AnthropicModelProfile } from './anthropic-models.js';
import { FAKE_ANTHROPIC_KEY, fakeModelRow } from './anthropic-api.fake.js';
import { createAnthropicInferenceProvider } from './inference-provider.js';
import {
  LLM_CONNECTION_ORDER,
  LLM_MODEL_KEY_PATTERN,
  anthropicModelEntries,
  bindLlmModel,
  connectionDefaultEntry,
  connectionRoleDefaultEntry,
  deepSeekModelEntries,
  isOpenAiChatModelId,
  openAiModelEntries,
  openAiModelProfile,
  parseDeepSeekModelList,
  pickDeepSeekDefaultModel,
  pickOpenAiDefaultModel,
  qualifiedModelKey,
  sortOpenAiModelIds,
  teamModelEntries,
  type LlmConnection,
} from './llm-model-catalog.js';

/**
 * Model knowledge per connection and the model-bound client: which OpenAI
 * models BotBoy offers, what each can take, DeepSeek's reported profiles, the
 * unchanged team catalog, and the per-request route/budget/thinking rules.
 */
describe('connection ids and model keys', () => {
  it('lists Claude last, so the Automatic order of team, OpenAI and DeepSeek is unchanged', () => {
    expect(LLM_CONNECTION_ORDER).toEqual(['team', 'openai', 'deepseek', 'anthropic']);
  });
  it('accepts provider-qualified keys for every connection, Claude snapshot ids included', () => {
    for (const key of ['team.terra', 'openai.gpt-5.6-terra', 'deepseek.deepseek-flash', 'anthropic.claude-sonnet-5-5', 'anthropic.claude-haiku-4-5-20251001']) {
      expect(LLM_MODEL_KEY_PATTERN.test(key), key).toBe(true);
    }
    for (const key of ['gemini.pro', 'anthropic.', 'anthropic.bad id', 'Anthropic.claude', 'anthropic']) {
      expect(LLM_MODEL_KEY_PATTERN.test(key), key).toBe(false);
    }
    expect(qualifiedModelKey('anthropic', 'claude-opus-5-5')).toBe('anthropic.claude-opus-5-5');
  });
});

describe('OpenAI model list', () => {
  it('offers chat models and drops embeddings, speech, image, moderation, search, and tiny legacy models', () => {
    const listed = [
      'gpt-5.6-terra', 'gpt-6.1-sol', 'gpt-4o', 'gpt-4.1-mini', 'o4-mini', 'codex-mini-latest',
      'ft:gpt-4o-mini:acme::abc123',
      'text-embedding-3-large', 'whisper-1', 'tts-1', 'gpt-4o-mini-tts', 'gpt-4o-transcribe',
      'gpt-4o-realtime-preview', 'gpt-4o-audio-preview', 'dall-e-3', 'gpt-image-1', 'sora-2',
      'omni-moderation-latest', 'gpt-4o-search-preview', 'o3-deep-research', 'computer-use-preview',
      'gpt-3.5-turbo', 'gpt-4', 'gpt-4-0613', 'gpt-3.5-turbo-instruct', 'davinci-002', 'chatgpt-4o-latest',
    ];
    expect(listed.filter(isOpenAiChatModelId)).toEqual([
      'gpt-5.6-terra', 'gpt-6.1-sol', 'gpt-4o', 'gpt-4.1-mini', 'o4-mini', 'codex-mini-latest',
      'ft:gpt-4o-mini:acme::abc123',
    ]);
  });

  it('knows which families take reasoning parameters and images', () => {
    expect(openAiModelProfile('gpt-5.6-terra')).toMatchObject({ reasoning: true, images: true, contextWindow: 1_000_000 });
    expect(openAiModelProfile('gpt-6-astra')).toMatchObject({ reasoning: true, images: true });
    expect(openAiModelProfile('gpt-5-mini')).toMatchObject({ reasoning: true, contextWindow: 400_000 });
    expect(openAiModelProfile('gpt-5-chat-latest')).toMatchObject({ reasoning: false });
    expect(openAiModelProfile('gpt-4o')).toMatchObject({ reasoning: false, images: true, maxOutputTokens: 16_384 });
    expect(openAiModelProfile('ft:gpt-4o-mini:acme::abc123')).toMatchObject({ reasoning: false });
    expect(openAiModelProfile('o3-mini')).toMatchObject({ reasoning: true, images: false });
    expect(openAiModelProfile('some-future-model').images).toBeUndefined();
  });

  it('puts the curated models first, then the rest by family, newest-looking first', () => {
    expect(sortOpenAiModelIds(['gpt-4o', 'gpt-6-sol', 'gpt-6.1-sol', 'gpt-5.6-terra', 'o4-mini', 'gpt-5.6-terra', 'ft:gpt-4o:acme::x', 'o3']))
      .toEqual(['gpt-5.6-terra', 'gpt-6-sol', 'gpt-6.1-sol', 'gpt-4o', 'o4-mini', 'o3', 'ft:gpt-4o:acme::x']);
  });

  it('defaults to Terra when listed, else another curated model, else a reasoning model', () => {
    expect(pickOpenAiDefaultModel(['gpt-4o', 'gpt-5.6-terra'])).toBe('gpt-5.6-terra');
    expect(pickOpenAiDefaultModel(['gpt-4o', 'gpt-5.6-luna'])).toBe('gpt-5.6-luna');
    expect(pickOpenAiDefaultModel(['gpt-4o', 'o4-mini'])).toBe('o4-mini');
    expect(pickOpenAiDefaultModel(['gpt-4o'])).toBe('gpt-4o');
  });

  it('builds provider-qualified entries with plain-id routes and no provider text in titles', () => {
    const entries = openAiModelEntries(['gpt-4o', 'gpt-5.6-terra', 'whisper-1'], 'gpt-5.6-terra');
    expect(entries.map(entry => [entry.key, entry.label, entry.isConnectionDefault])).toEqual([
      ['openai.gpt-5.6-terra', 'GPT-5.6 Terra', true],
      ['openai.gpt-4o', 'gpt-4o', false],
    ]);
    expect(entries[0].route).toEqual({ model: 'gpt-5.6-terra' });
    expect(entries[1].route).toEqual({ model: 'gpt-4o', supportsReasoning: false });
    expect(JSON.stringify(entries)).not.toContain('OpenAI-Project');
  });
});

describe('DeepSeek model list', () => {
  const listed = {
    object: 'list',
    data: [
      {
        id: 'deepseek-flash', object: 'model', owned_by: 'deepseek', name: 'DeepSeek V4.1 Flash',
        context_window: 1_000_000, max_output_tokens: 384_000,
        input_modalities: ['text', 'image'], output_modalities: ['text'],
        effort: { supported_levels: ['low', 'high', 'max'], default_level: 'high' },
      },
      {
        id: 'deepseek-v4-pro', object: 'model', owned_by: 'deepseek', name: 'DeepSeek V4 Pro',
        context_window: 1_000_000, max_output_tokens: 384_000, input_modalities: ['text'], output_modalities: ['text'],
      },
      { id: 'deepseek-image-gen', output_modalities: ['image'] },
      { id: '../etc/passwd' },
      { id: 'deepseek-flash' },
    ],
  };

  it('keeps reported names, windows, output limits, image input, and effort levels', () => {
    const profiles = parseDeepSeekModelList(listed);
    expect(profiles).toEqual([
      { id: 'deepseek-flash', name: 'DeepSeek V4.1 Flash', contextWindow: 1_000_000, maxOutputTokens: 384_000, images: true, effortLevels: ['low', 'high', 'max'] },
      { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', contextWindow: 1_000_000, maxOutputTokens: 384_000, images: false },
    ]);
    // Stored copies round-trip through the same validation.
    expect(parseDeepSeekModelList(profiles)).toEqual(profiles);
    expect(pickDeepSeekDefaultModel(profiles)).toBe('deepseek-flash');
    expect(pickDeepSeekDefaultModel(profiles.slice(1))).toBe('deepseek-v4-pro');
  });

  it('titles entries with the reported display name', () => {
    const entries = deepSeekModelEntries(parseDeepSeekModelList(listed), 'deepseek-flash');
    expect(entries.map(entry => [entry.key, entry.label, entry.capabilities.images])).toEqual([
      ['deepseek.deepseek-flash', 'DeepSeek V4.1 Flash', true],
      ['deepseek.deepseek-v4-pro', 'DeepSeek V4 Pro', false],
    ]);
  });
});

describe('team catalog', () => {
  it('keeps the curated GPT-5.6 list on the gateway with target-qualified routes', () => {
    const entries = teamModelEntries({
      providerId: 'gateway',
      defaultModel: 'bedrock-mantle-luna/openai.gpt-5.6-terra',
      maxContextTokens: 1_000_000,
      maxCompletionTokens: 16_384,
      env: { BOTBOY_INFERENCE_GPT6_ROLLOUT: 'off' },
    });
    expect(entries.map(entry => [entry.key, entry.route.model, entry.isConnectionDefault])).toEqual([
      ['team.terra', 'bedrock-mantle-luna/openai.gpt-5.6-terra', true],
      ['team.luna', 'bedrock-mantle-luna/openai.gpt-5.6-luna', false],
      ['team.sol', 'bedrock-mantle-luna/openai.gpt-5.6-sol', false],
    ]);
  });

  it('degrades malformed GPT-6 settings to the GPT-5.6 list', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const entries = teamModelEntries({
      providerId: 'gateway',
      defaultModel: 'bedrock-mantle-luna/openai.gpt-5.6-terra',
      maxContextTokens: 1_000_000,
      maxCompletionTokens: 16_384,
      env: { BOTBOY_INFERENCE_GPT6_ROLLOUT: 'preview' },
    });
    expect(entries.map(entry => entry.key)).toEqual(['team.terra', 'team.luna', 'team.sol']);
    vi.restoreAllMocks();
  });

  it('offers a non-blessed launcher model as the provider default', () => {
    const entries = teamModelEntries({
      providerId: 'openai-compatible',
      defaultModel: '/app/models/qwen35-35b-a3b-fp8',
      maxContextTokens: 32_768,
      maxCompletionTokens: 4_096,
      env: {},
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ key: 'team.default', label: 'Provider default', isConnectionDefault: true });
    // Chat's existing completion cap is preserved; the server enforces its own limit.
    expect(entries[0].capabilities).toEqual({ contextWindow: 32_768, maxOutputTokens: 32_768 });
  });
});

describe('Claude entries', () => {
  const profile = (spec: Parameters<typeof fakeModelRow>[0]) => parseAnthropicModel(fakeModelRow(spec))!;
  const SONNET = profile({ id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5', variant: 'A', line: 'sonnet' });
  const HAIKU = profile({ id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5', variant: 'B', line: 'haiku' });
  const OPUS_45 = profile({ id: 'claude-opus-4-5-20251101', name: 'Claude Opus 4.5', variant: 'C', line: 'opus', maxInputTokens: 200_000, maxTokens: 64_000 });
  const LEGACY = profile({ id: 'claude-3-haiku-20240307', name: 'Claude Haiku 3', variant: 'D', line: 'haiku', maxInputTokens: 200_000, maxTokens: 4_096 });

  it('builds one provider-qualified entry per listed model: the reported title, the plain id as route, the default marked', () => {
    const entries = anthropicModelEntries([SONNET, HAIKU, OPUS_45], 'claude-haiku-5-5');
    expect(entries.map(entry => [entry.key, entry.connectionId, entry.label, entry.model, entry.isConnectionDefault, entry.preview])).toEqual([
      ['anthropic.claude-sonnet-5-5', 'anthropic', 'Claude Sonnet 5.5', 'claude-sonnet-5-5', false, false],
      ['anthropic.claude-haiku-5-5', 'anthropic', 'Claude Haiku 5.5', 'claude-haiku-5-5', true, false],
      ['anthropic.claude-opus-4-5-20251101', 'anthropic', 'Claude Opus 4.5', 'claude-opus-4-5-20251101', false, false],
    ]);
    // The route names only the model: an Anthropic route can never carry an endpoint, headers or a reasoning flag.
    expect(entries.map(entry => entry.route)).toEqual([{ model: 'claude-sonnet-5-5' }, { model: 'claude-haiku-5-5' }, { model: 'claude-opus-4-5-20251101' }]);
    for (const entry of entries) expect(LLM_MODEL_KEY_PATTERN.test(entry.key), entry.key).toBe(true);
    expect(anthropicModelEntries([], 'claude-sonnet-5-5')).toEqual([]);
  });

  it('records each model\'s window, output limit, image input and how Thinking Off behaves (D2)', () => {
    const [sonnet, haiku, opus, legacy] = anthropicModelEntries([SONNET, HAIKU, OPUS_45, LEGACY], 'claude-sonnet-5-5');
    // Kind A (always-on) models think a little even at Off; kind B can switch it off but not beside tools; kind C is native; kind D has no control.
    expect(sonnet.capabilities).toEqual({ images: true, contextWindow: 1_000_000, maxOutputTokens: 128_000, thinkingOff: 'lowest_effort' });
    expect(haiku.capabilities).toEqual({ images: true, contextWindow: 1_000_000, maxOutputTokens: 128_000, thinkingOff: 'native_without_tools' });
    expect(opus.capabilities).toMatchObject({ contextWindow: 200_000, maxOutputTokens: 64_000, thinkingOff: 'native' });
    expect(legacy.capabilities).toMatchObject({ contextWindow: 200_000, thinkingOff: 'unavailable' });
  });

  it('leaves image input unknown when the list does not say, rather than guessing', () => {
    const silent = parseAnthropicModel({ ...fakeModelRow({ id: 'claude-future-9', variant: 'A', line: 'sonnet' }), capabilities: null })!;
    const [entry] = anthropicModelEntries([silent], 'claude-future-9');
    expect('images' in entry.capabilities).toBe(false);
    expect(entry.capabilities.thinkingOff).toBeDefined();
  });
});

describe('Role defaults on a connection (design D8)', () => {
  const profile = (spec: Parameters<typeof fakeModelRow>[0]) => parseAnthropicModel(fakeModelRow(spec))!;
  const SONNET = profile({ id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5', variant: 'A', line: 'sonnet' });
  const HAIKU = profile({ id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5', variant: 'B', line: 'haiku' });
  const OPUS = profile({ id: 'claude-opus-5-5', name: 'Claude Opus 5.5', variant: 'A', line: 'opus' });
  // Only `models` and `roleDefaultModels` are read, so the client and provider are placeholders.
  const connection = (models: LlmConnection['models'], roleDefaultModels?: LlmConnection['roleDefaultModels']): LlmConnection => ({
    id: 'anthropic', label: 'Anthropic (Claude)', source: 'settings', client: {} as LlmClient,
    provider: { id: 'anthropic', endpoint: 'https://example.test', model: 'claude-sonnet-5-5', apiMode: 'messages' },
    models, ...(roleDefaultModels ? { roleDefaultModels } : {}), version: 1,
  });
  const entries = anthropicModelEntries([SONNET, HAIKU, OPUS], 'claude-sonnet-5-5');

  it('answers the connection default for every role when the connection names no role default', () => {
    const plain = connection(entries);
    expect(connectionRoleDefaultEntry(plain, 'processing')?.key).toBe('anthropic.claude-sonnet-5-5');
    expect(connectionRoleDefaultEntry(plain, 'documents')?.key).toBe('anthropic.claude-sonnet-5-5');
    expect(connectionRoleDefaultEntry(plain, 'processing')).toBe(connectionDefaultEntry(plain));
  });

  it('answers the named model for Organizing only; Document writing stays on the connection default', () => {
    const claude = connection(entries, { processing: 'anthropic.claude-haiku-5-5' });
    expect(connectionRoleDefaultEntry(claude, 'processing')?.key).toBe('anthropic.claude-haiku-5-5');
    expect(connectionRoleDefaultEntry(claude, 'documents')?.key).toBe('anthropic.claude-sonnet-5-5');
    // The connection default itself (chat, key verification) is untouched by a role default.
    expect(connectionDefaultEntry(claude)?.key).toBe('anthropic.claude-sonnet-5-5');
  });

  it('falls back to the connection default when the named model is not offered, and answers nothing for an empty connection', () => {
    const stale = connection(entries, { processing: 'anthropic.claude-haiku-4-5-20251001' });
    expect(connectionRoleDefaultEntry(stale, 'processing')?.key).toBe('anthropic.claude-sonnet-5-5');
    expect(connectionRoleDefaultEntry(connection([], { processing: 'anthropic.claude-haiku-5-5' }), 'processing')).toBeUndefined();
  });
});

describe('Context budget 100,000 on a bound Claude model (D7; owner decision 2026-10-13)', () => {
  const clients: Array<{ close(): void }> = [];
  afterEach(() => { for (const client of clients.splice(0)) client.close(); });

  // The connection is built the way ai-model-settings builds it: the real provider factory with a Claude list, no budget override.
  function claudeConnection(models: AnthropicModelProfile[], env: NodeJS.ProcessEnv = {}): LlmConnection {
    const provider = createAnthropicInferenceProvider({
      apiKey: FAKE_ANTHROPIC_KEY, models, defaultModel: models[0].id, env: { BOTBOY_INFERENCE_HEALTH_INTERVAL_MS: '0', ...env },
    });
    const client = provider.createClient();
    clients.push(client);
    return {
      id: 'anthropic', label: 'Anthropic (Claude)', source: 'settings', client,
      provider: { id: 'anthropic', endpoint: provider.endpoint, model: provider.model, apiMode: 'messages' },
      models: anthropicModelEntries(models, models[0].id), version: 1,
    };
  }
  const row = (spec: Parameters<typeof fakeModelRow>[0]) => parseAnthropicModel(fakeModelRow(spec))!;

  it('4. a 1,000,000-token model, a 200,000-token model and a model whose window is unknown each report exactly 100,000', () => {
    const million = row({ id: 'claude-sonnet-5-5', variant: 'A', line: 'sonnet', maxInputTokens: 1_000_000, maxTokens: 128_000 });
    const twoHundredK = row({ id: 'claude-haiku-4-5-20251001', variant: 'C', line: 'haiku', maxInputTokens: 200_000, maxTokens: 64_000 });
    const unknown = row({ id: 'claude-mystery-1', variant: 'A', line: 'sonnet', maxInputTokens: null, maxTokens: null });
    expect(unknown.contextWindow).toBe(200_000);
    const connection = claudeConnection([million, twoHundredK, unknown]);
    const budgets = connection.models.map(entry => [entry.model, bindLlmModel(connection, entry).getContextBudgetTokens?.()]);
    expect(budgets).toEqual([
      ['claude-sonnet-5-5', 100_000],
      ['claude-haiku-4-5-20251001', 100_000],
      ['claude-mystery-1', 100_000],
    ]);
    // The budget is the same literal whether the model is routed explicitly (chat) or not (background roles).
    expect(bindLlmModel(connection, connection.models[1], { alwaysRoute: true }).getContextBudgetTokens?.()).toBe(100_000);
    // The window still limits the budget when it is genuinely small: a 40,000-token model cannot be given 100,000.
    const small = row({ id: 'claude-small-1', variant: 'A', line: 'haiku', maxInputTokens: 40_000, maxTokens: 8_000 });
    const smallConnection = claudeConnection([small]);
    expect(bindLlmModel(smallConnection, smallConnection.models[0]).getContextBudgetTokens?.()).toBeLessThan(40_000);
  });
});

describe('model-bound client', () => {
  function connection(seen: ChatCompletionRequest[]): LlmConnection {
    const base = {
      chatCompletion: vi.fn(async (request: ChatCompletionRequest) => {
        seen.push(request);
        return { content: 'ok', toolCalls: null, usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, finishReason: 'stop' as const };
      }),
      getMaxCompletionTokens: () => 16_384,
      getContextBudgetTokens: () => 100_000,
      getDefaultModel: () => 'gpt-5.6-terra',
      getProviderId: () => 'openai',
      getActiveEndpoint: () => 'ecs' as const,
      isAvailable: () => true,
      close: vi.fn(),
    } as unknown as LlmClient;
    return {
      id: 'openai',
      label: 'OpenAI',
      source: 'settings',
      client: base,
      provider: { id: 'openai', endpoint: 'https://api.openai.com/v1', model: 'gpt-5.6-terra', apiMode: 'responses' },
      models: openAiModelEntries(['gpt-5.6-terra', 'gpt-4o'], 'gpt-5.6-terra'),
      version: 1,
    };
  }

  it('routes non-default models, keeps the default route-less for background roles, and always routes for chat', async () => {
    const seen: ChatCompletionRequest[] = [];
    const target = connection(seen);
    const [terra, gpt4o] = target.models;
    await bindLlmModel(target, terra).chatCompletion({ messages: [] });
    await bindLlmModel(target, gpt4o).chatCompletion({ messages: [] });
    await bindLlmModel(target, terra, { alwaysRoute: true }).chatCompletion({ messages: [] });
    expect(seen.map(request => request.route)).toEqual([
      undefined,
      { model: 'gpt-4o', supportsReasoning: false },
      { model: 'gpt-5.6-terra' },
    ]);
  });

  it('fits completion budgets to the model and describes the model in its getters', async () => {
    const seen: ChatCompletionRequest[] = [];
    const target = connection(seen);
    const bound = bindLlmModel(target, target.models[1]);
    await bound.chatCompletion({ messages: [], maxTokens: 32_768 });
    await bound.chatCompletion({ messages: [] });
    expect(seen.map(request => request.maxTokens)).toEqual([16_384, 16_384]);
    expect(bound.getContextWindow?.()).toBe(128_000);
    expect(bound.getMaxCompletionTokens?.()).toBe(16_384);
    expect(bound.getContextBudgetTokens?.()).toBeLessThan(128_000);
    expect(bound.getActiveModel?.()).toBe('gpt-4o');
    expect(bound.getModelOperation?.()).toMatchObject({
      connectionId: 'openai',
      modelKey: 'openai.gpt-4o',
      label: 'gpt-4o',
      provider: { id: 'openai', endpoint: 'https://api.openai.com/v1', model: 'gpt-4o' },
      capabilities: { images: true, contextWindow: 128_000 },
    });
    // The connection owns its client.
    bound.close();
    expect(target.client.close).not.toHaveBeenCalled();
  });

  it('applies a role Thinking level only where the caller did not ask for thinking', async () => {
    const seen: ChatCompletionRequest[] = [];
    const target = connection(seen);
    const bound = bindLlmModel(target, target.models[0], { thinking: 'high' });
    await bound.chatCompletion({ messages: [], think: false });
    await bound.chatCompletion({ messages: [], think: true, reasoningEffort: 'max' });
    await bound.sendPrompt('organize this');
    expect(seen.map(request => [request.think, request.reasoningEffort])).toEqual([
      [true, 'high'],
      [true, 'max'],
      [true, 'high'],
    ]);
    expect(seen[2].usageContext).toEqual({ workload: 'background' });
    const off = bindLlmModel(target, target.models[0]);
    await off.chatCompletion({ messages: [], think: false });
    expect(seen[3]).toMatchObject({ think: false });
    expect(seen[3].reasoningEffort).toBeUndefined();
  });
});
