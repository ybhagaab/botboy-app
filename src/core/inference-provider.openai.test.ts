import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BLESSED_CHAT_MODELS,
  OPENAI_PLATFORM_ENDPOINT,
  OPENAI_PLATFORM_MODEL_IDS,
  chatModelCatalogContext,
  createOpenAiPlatformInferenceProvider,
  defaultInferenceMaxContextTokens,
  getChatModelCatalog,
  resolveBlessedModelRoute,
  resolveInferenceProviderId,
} from './inference-provider.js';

/**
 * Settings → AI model: the owner's own OpenAI key powers every workload on the
 * hosted OpenAI API with plain model ids, one endpoint, and no gateway
 * targets or Mantle Project headers.
 */
const GPT6_PREVIEW_ENV = {
  BOTBOY_INFERENCE_GPT6_ROLLOUT: 'preview',
  BOTBOY_INFERENCE_GPT6_EAST_TARGET: 'botboy-gpt6-east',
  BOTBOY_INFERENCE_GPT6_ASTRA_TARGET: 'botboy-gpt6-astra-west',
  BOTBOY_INFERENCE_GPT6_ASTRA_ENDPOINT:
    'https://botboy-astra.gateway.bedrock-agentcore.us-west-2.amazonaws.com/inference/v1',
  BOTBOY_INFERENCE_GPT6_ASTRA_PROJECT: 'proj_gcag2sv5e6z2eni2azsx',
} as NodeJS.ProcessEnv;

describe('hosted OpenAI provider (Settings → AI model)', () => {
  // A new client probes its endpoint once; never let a unit test reach the
  // real api.openai.com.
  const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
  beforeEach(() => vi.stubGlobal('fetch', fetchMock));
  afterEach(() => {
    vi.unstubAllGlobals();
    fetchMock.mockClear();
  });

  it('maps every catalog model to its plain OpenAI API id', () => {
    expect(BLESSED_CHAT_MODELS.map(model => model.openaiId)).toEqual([
      'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.6-sol', 'gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna', 'gpt-6.1-sol',
    ]);
    expect(OPENAI_PLATFORM_MODEL_IDS).toHaveLength(7);
  });

  it('builds a Responses provider on api.openai.com with Terra for background work', () => {
    const provider = createOpenAiPlatformInferenceProvider({ apiKey: 'sk-test-provider-000000000000', env: {} });
    expect(provider).toMatchObject({
      id: 'openai',
      endpoint: OPENAI_PLATFORM_ENDPOINT,
      model: 'gpt-5.6-terra',
      apiMode: 'responses',
      maxContextTokens: 1_000_000,
      localFallbackEnabled: false,
    });
    const client = provider.createClient();
    try {
      expect(client.getProviderId?.()).toBe('openai');
      expect(client.getDefaultModel()).toBe('gpt-5.6-terra');
      expect(client.getDialect?.()).toBe('openai');
      expect(client.getApiMode?.()).toBe('responses');
      expect(client.getContextWindow?.()).toBe(1_000_000);
    } finally {
      client.close();
    }
    expect(defaultInferenceMaxContextTokens('openai')).toBe(1_000_000);
  });

  it('rejects a blank key before building anything', () => {
    expect(() => createOpenAiPlatformInferenceProvider({ apiKey: '   ', env: {} })).toThrow(/OpenAI API key is required/);
  });

  it('offers all seven models when the key does not report a list, none as preview', () => {
    const catalog = getChatModelCatalog('gpt-5.6-terra', GPT6_PREVIEW_ENV, { providerId: 'openai' });
    expect(catalog.defaultKey).toBe('terra');
    expect(catalog.models.map(model => model.key)).toEqual([
      'terra', 'luna', 'sol', 'gpt6-astra', 'gpt6-sol', 'gpt6-luna', 'gpt6.1-sol',
    ]);
    expect(catalog.models.every(model => model.preview === false)).toBe(true);
    expect(catalog.models.find(model => model.isDefault)?.key).toBe('terra');
  });

  it('offers only the models the key can call', () => {
    const catalog = getChatModelCatalog('gpt-5.6-terra', {}, {
      providerId: 'openai',
      availableModels: ['gpt-5.6-terra', 'gpt-6-sol'],
    });
    expect(catalog.models.map(model => model.key)).toEqual(['terra', 'gpt6-sol']);
  });

  it('routes every model to its plain id with no endpoint or Project header', () => {
    const context = { providerId: 'openai' };
    expect(resolveBlessedModelRoute('gpt-5.6-terra', 'gpt6-astra', GPT6_PREVIEW_ENV, context))
      .toEqual({ model: 'gpt-6-astra' });
    expect(resolveBlessedModelRoute('gpt-5.6-terra', 'sol', GPT6_PREVIEW_ENV, context))
      .toEqual({ model: 'gpt-5.6-sol' });
    expect(resolveBlessedModelRoute('gpt-5.6-terra', 'gpt6.1-sol', GPT6_PREVIEW_ENV, context))
      .toEqual({ model: 'gpt-6.1-sol' });
    expect(resolveBlessedModelRoute('gpt-5.6-terra', 'gpt6-astra', {}, {
      providerId: 'openai',
      availableModels: ['gpt-5.6-terra'],
    })).toBeNull();
    expect(resolveBlessedModelRoute('gpt-5.6-terra', 'not-a-model', {}, context)).toBeNull();
  });

  it('keeps the gateway catalog and routes unchanged for non-OpenAI providers', () => {
    const gatewayDefault = 'bedrock-mantle-luna/openai.gpt-5.6-terra';
    expect(getChatModelCatalog(gatewayDefault, GPT6_PREVIEW_ENV, { providerId: 'gateway' }).models.map(model => model.key))
      .toEqual(['terra', 'luna', 'sol', 'gpt6-astra', 'gpt6-sol', 'gpt6-luna', 'gpt6.1-sol']);
    expect(resolveBlessedModelRoute(gatewayDefault, 'gpt6-astra', GPT6_PREVIEW_ENV, { providerId: 'gateway' }))
      .toMatchObject({ headers: { 'OpenAI-Project': 'proj_gcag2sv5e6z2eni2azsx' } });
  });

  it('derives the catalog context from a live client', () => {
    const client = createOpenAiPlatformInferenceProvider({
      apiKey: 'sk-test-context-000000000000',
      availableModels: ['gpt-5.6-terra', 'gpt-6-luna'],
      env: { BOTBOY_INFERENCE_HEALTH_INTERVAL_MS: '0' },
    }).createClient();
    try {
      expect(chatModelCatalogContext(client)).toEqual({
        providerId: 'openai',
        availableModels: ['gpt-5.6-terra', 'gpt-6-luna'],
      });
    } finally {
      client.close();
    }
  });

  it('is never selected from environment variables', () => {
    expect(() => resolveInferenceProviderId({ BOTBOY_INFERENCE_PROVIDER: 'openai' }))
      .toThrow(/Settings → AI model/);
    // An ambient OPENAI_API_KEY alone never redirects BotBoy's data.
    expect(resolveInferenceProviderId({ OPENAI_API_KEY: 'sk-ambient-0000000000000000' })).toBe('bedrock');
  });
});
