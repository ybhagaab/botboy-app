import { describe, expect, it, vi } from 'vitest';
import type { ChatCompletionRequest, LlmClient } from './llm-client.js';
import {
  bindLlmModel,
  deepSeekModelEntries,
  isOpenAiChatModelId,
  openAiModelEntries,
  openAiModelProfile,
  parseDeepSeekModelList,
  pickDeepSeekDefaultModel,
  pickOpenAiDefaultModel,
  sortOpenAiModelIds,
  teamModelEntries,
  type LlmConnection,
} from './llm-model-catalog.js';

/**
 * Model knowledge per connection and the model-bound client: which OpenAI
 * models BotBoy offers, what each can take, DeepSeek's reported profiles, the
 * unchanged team catalog, and the per-request route/budget/thinking rules.
 */
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
