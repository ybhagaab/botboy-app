import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  createInferenceProviderFromEnv,
  defaultInferenceMaxContextTokens,
  BLESSED_CHAT_MODELS,
  getChatModelCatalog,
  resolveBlessedModelId,
  resolveBlessedModelRoute,
} from './inference-provider.js';
import { createLlmClient, type LlmRequestAuthorizer } from './llm-client.js';

/**
 * Gateway provider profile: teammates without AWS access point BotBoy at the
 * authenticated AgentCore gateway (OpenAI-compatible, Responses-native,
 * target-prefixed model ids) and authenticate with OAuth client credentials.
 * These tests pin the env contract and the 401 invalidate-and-retry seam.
 */

const GATEWAY_ENV = {
  BOTBOY_INFERENCE_PROVIDER: 'gateway',
  BOTBOY_INFERENCE_ENDPOINT: 'https://gw.test/inference/v1',
  BOTBOY_INFERENCE_OAUTH_TOKEN_URL: 'https://issuer.test/oauth2/token',
  BOTBOY_INFERENCE_OAUTH_CLIENT_ID: 'client-a',
  BOTBOY_INFERENCE_OAUTH_CLIENT_SECRET: 'secret-a',
  BOTBOY_INFERENCE_OAUTH_SCOPE: 'botboy-llm/invoke',
} as NodeJS.ProcessEnv;

describe('server-owned chat model catalog', () => {
  const defaultModel = 'bedrock-mantle-luna/openai.gpt-5.6-terra';
  const previewEnv = {
    BOTBOY_INFERENCE_GPT6_ROLLOUT: 'preview',
    BOTBOY_INFERENCE_GPT6_EAST_TARGET: 'botboy-gpt6-east',
    BOTBOY_INFERENCE_GPT6_ASTRA_TARGET: 'botboy-gpt6-astra-west',
    BOTBOY_INFERENCE_GPT6_ASTRA_ENDPOINT:
      'https://botboy-astra.gateway.bedrock-agentcore.us-west-2.amazonaws.com/inference/v1',
    BOTBOY_INFERENCE_GPT6_ASTRA_PROJECT: 'proj_gcag2sv5e6z2eni2azsx',
  } as NodeJS.ProcessEnv;

  it('retains all GPT-5.6 profiles and records all exact GPT-6 base ids', () => {
    expect(BLESSED_CHAT_MODELS.map(model => model.key)).toEqual([
      'terra', 'luna', 'sol', 'gpt6-astra', 'gpt6-sol', 'gpt6-luna',
    ]);
    expect(BLESSED_CHAT_MODELS.map(model => model.bareId)).toEqual([
      'openai.gpt-5.6-terra',
      'openai.gpt-5.6-luna',
      'openai.gpt-5.6-sol',
      'openai.gpt-6-astra',
      'openai.gpt-6-sol',
      'openai.gpt-6-luna',
    ]);
  });

  it('exposes only proven GPT-5.6 routes until GPT-6 preview is explicitly enabled', () => {
    const catalog = getChatModelCatalog(defaultModel, {});
    expect(catalog.defaultKey).toBe('terra');
    expect(catalog.models.map(model => model.key)).toEqual(['terra', 'luna', 'sol']);
    expect(resolveBlessedModelId(defaultModel, 'gpt6-astra', {})).toBeNull();
  });

  it('routes Astra to its west Project and Sol/Luna to the explicit east Mantle target', () => {
    const catalog = getChatModelCatalog(defaultModel, previewEnv);
    expect(catalog.models.map(model => model.key)).toEqual([
      'terra', 'luna', 'sol', 'gpt6-astra', 'gpt6-sol', 'gpt6-luna',
    ]);
    expect(catalog.models.filter(model => model.preview).map(model => model.key)).toEqual([
      'gpt6-astra', 'gpt6-sol', 'gpt6-luna',
    ]);
    const serializedCatalog = JSON.stringify(catalog);
    expect(serializedCatalog).not.toContain('botboy-gpt6-east');
    expect(serializedCatalog).not.toContain('botboy-gpt6-astra-west');
    expect(serializedCatalog).not.toContain('proj_gcag2sv5e6z2eni2azsx');

    expect(resolveBlessedModelRoute(defaultModel, 'gpt6-astra', previewEnv)).toEqual({
      model: 'botboy-gpt6-astra-west/openai.gpt-6-astra',
      endpoint: 'https://botboy-astra.gateway.bedrock-agentcore.us-west-2.amazonaws.com/inference/v1',
      headers: { 'OpenAI-Project': 'proj_gcag2sv5e6z2eni2azsx' },
    });
    expect(resolveBlessedModelRoute(defaultModel, 'gpt6-sol', previewEnv)).toEqual({
      model: 'botboy-gpt6-east/openai.gpt-6-sol',
    });
    expect(resolveBlessedModelRoute(defaultModel, 'gpt6-luna', previewEnv)).toEqual({
      model: 'botboy-gpt6-east/openai.gpt-6-luna',
    });
  });

  it('keeps GPT-6 unavailable on direct Mantle because it needs another endpoint', () => {
    const direct = getChatModelCatalog('openai.gpt-5.6-terra', previewEnv);
    expect(direct.models.map(model => model.key)).toEqual(['terra', 'luna', 'sol']);
    expect(resolveBlessedModelId('openai.gpt-5.6-terra', 'gpt6-astra', previewEnv)).toBeNull();
  });

  it('does not mistake local or Hugging Face model paths for a gateway target', () => {
    for (const providerModel of ['/app/models/qwen35-35b-a3b-fp8', 'Qwen/Qwen3.5-27B-Instruct']) {
      const catalog = getChatModelCatalog(providerModel, previewEnv);
      expect(catalog).toEqual({
        defaultKey: 'default',
        models: [{
          key: 'default', label: 'Provider default', family: 'Provider', isDefault: true, preview: false,
        }],
      });
      expect(resolveBlessedModelId(providerModel, 'terra', previewEnv)).toBeNull();
    }
  });

  it('fails configured preview closed when either final route is incomplete or malformed', () => {
    expect(() => getChatModelCatalog(defaultModel, {
      BOTBOY_INFERENCE_GPT6_ROLLOUT: 'preview',
    })).toThrow(/BOTBOY_INFERENCE_GPT6_EAST_TARGET/);
    expect(() => getChatModelCatalog(defaultModel, {
      ...previewEnv,
      BOTBOY_INFERENCE_GPT6_ASTRA_ENDPOINT: 'https://example.com/inference/v1',
    })).toThrow(/us-west-2 AgentCore/);
    expect(() => getChatModelCatalog(defaultModel, {
      ...previewEnv,
      BOTBOY_INFERENCE_GPT6_ASTRA_PROJECT: 'default',
    })).toThrow(/dedicated west Mantle Project/);
    expect(() => getChatModelCatalog(defaultModel, {
      ...previewEnv,
      BOTBOY_INFERENCE_GPT6_ASTRA_TARGET: 'bad/target',
    })).toThrow(/target name without slashes/);
  });

  it('inherits the existing gateway target for every GPT-5.6 choice', () => {
    expect(resolveBlessedModelId(defaultModel, 'luna'))
      .toBe('bedrock-mantle-luna/openai.gpt-5.6-luna');
    expect(resolveBlessedModelId(defaultModel, 'sol'))
      .toBe('bedrock-mantle-luna/openai.gpt-5.6-sol');
  });

  it('resolves GPT-5.6 bare on direct Bedrock and rejects arbitrary ids', () => {
    expect(resolveBlessedModelId('openai.gpt-5.6-terra', 'luna')).toBe('openai.gpt-5.6-luna');
    expect(resolveBlessedModelId(defaultModel, 'gpt-4')).toBeNull();
    expect(resolveBlessedModelId(defaultModel, '')).toBeNull();
    expect(resolveBlessedModelId(defaultModel, undefined)).toBeNull();
  });
});

describe('gateway inference provider from env', () => {
  it('applies the gateway profile: responses mode, openai dialect, prefixed Terra model, 1M context', () => {
    const provider = createInferenceProviderFromEnv({ ...GATEWAY_ENV });
    expect(provider.id).toBe('gateway');
    expect(provider.apiMode).toBe('responses');
    // The bedrock-mantle-luna/ prefix is the gateway TARGET (deployment
    // name); the model segment selects Terra (default since 2026-09-03).
    expect(provider.model).toBe('bedrock-mantle-luna/openai.gpt-5.6-terra');
    expect(provider.maxContextTokens).toBe(1_000_000);
    expect(provider.endpoint).toBe('https://gw.test/inference/v1');
  });

  it('reports the gateway default context profile to runtime limits', () => {
    expect(defaultInferenceMaxContextTokens('gateway')).toBe(1_000_000);
  });

  it('honors explicit model/dialect/apiMode overrides', () => {
    const provider = createInferenceProviderFromEnv({
      ...GATEWAY_ENV,
      BOTBOY_INFERENCE_MODEL: 'bedrock-mantle-luna/moonshotai.kimi-k2.5',
      BOTBOY_INFERENCE_API_MODE: 'chat-completions',
    });
    expect(provider.model).toBe('bedrock-mantle-luna/moonshotai.kimi-k2.5');
    expect(provider.apiMode).toBe('chat-completions');
  });

  it('rejects incomplete OAuth configuration instead of silently running unauthenticated', () => {
    expect(() => createInferenceProviderFromEnv({
      ...GATEWAY_ENV,
      BOTBOY_INFERENCE_OAUTH_CLIENT_SECRET: undefined,
    })).toThrow(/Incomplete OAuth config/);
  });

  it('requires some credential source for the gateway', () => {
    expect(() => createInferenceProviderFromEnv({
      BOTBOY_INFERENCE_PROVIDER: 'gateway',
      BOTBOY_INFERENCE_ENDPOINT: 'https://gw.test/inference/v1',
    })).toThrow(/BOTBOY_INFERENCE_OAUTH_CLIENT_ID/);
  });

  it('teammate two-line env (client id + secret only) selects the gateway with baked team defaults', () => {
    const provider = createInferenceProviderFromEnv({
      BOTBOY_INFERENCE_OAUTH_CLIENT_ID: 'client-a',
      BOTBOY_INFERENCE_OAUTH_CLIENT_SECRET: 'secret-a',
    });
    expect(provider.id).toBe('gateway');
    expect(provider.endpoint).toBe(
      'https://botboy-luna-gateway-tyagefrrnz.gateway.bedrock-agentcore.us-east-1.amazonaws.com/inference/v1',
    );
    expect(provider.apiMode).toBe('responses');
    expect(provider.model).toBe('bedrock-mantle-luna/openai.gpt-5.6-terra');
    expect(provider.maxContextTokens).toBe(1_000_000);
  });

  it('explicit endpoint/token URL/scope still override the baked defaults', () => {
    const provider = createInferenceProviderFromEnv({
      BOTBOY_INFERENCE_OAUTH_CLIENT_ID: 'client-a',
      BOTBOY_INFERENCE_OAUTH_CLIENT_SECRET: 'secret-a',
      BOTBOY_INFERENCE_ENDPOINT: 'https://other-gw.test/inference/v1',
      BOTBOY_INFERENCE_OAUTH_TOKEN_URL: 'https://other-issuer.test/oauth2/token',
      BOTBOY_INFERENCE_OAUTH_SCOPE: 'other/scope',
    });
    expect(provider.id).toBe('gateway');
    expect(provider.endpoint).toBe('https://other-gw.test/inference/v1');
  });

  it('client id without secret fails fast instead of hanging at request time', () => {
    expect(() => createInferenceProviderFromEnv({
      BOTBOY_INFERENCE_OAUTH_CLIENT_ID: 'client-a',
    })).toThrow(/Incomplete OAuth config/);
  });

  it('still accepts a static API key without OAuth env', () => {
    const provider = createInferenceProviderFromEnv({
      BOTBOY_INFERENCE_PROVIDER: 'gateway',
      BOTBOY_INFERENCE_ENDPOINT: 'https://gw.test/inference/v1',
      BOTBOY_INFERENCE_API_KEY: 'static-key',
    });
    expect(provider.id).toBe('gateway');
  });
});

describe('llm-client 401 invalidate-and-retry', () => {
  afterEach(() => vi.unstubAllGlobals());

  function respondersConfig(authorizer: LlmRequestAuthorizer) {
    return {
      ecs: {
        endpoint: 'https://gw.test/inference/v1',
        model: 'bedrock-mantle-luna/openai.gpt-5.6-terra',
        apiMode: 'responses' as const,
        dialect: 'openai' as const,
        maxContextTokens: 1_000_000,
        requestTimeoutMs: 0,
        requestAuthorizer: authorizer,
      },
      ollama: { endpoint: '', model: '', maxContextTokens: 0, requestTimeoutMs: 0 },
      defaults: { temperature: 0.7, maxCompletionTokens: 4096, contextBudgetTokens: 200000 },
      healthCheckIntervalMs: 3_600_000,
      fallbackEnabled: false,
    };
  }

  function responsesOk(text: string) {
    return {
      ok: true,
      status: 200,
      json: async () => ({
        status: 'completed',
        output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }],
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
      text: async () => '',
    } as unknown as Response;
  }

  /**
   * createLlmClient fires an immediate background health probe ("ping"), so
   * the mocks key off the request body: probes always succeed and only the
   * real user request exercises the 401 path. Counting "hi" calls isolates
   * the retry behavior from probe timing.
   */
  function isUserRequest(init: { body?: string } | undefined): boolean {
    return typeof init?.body === 'string' && init.body.includes('"hi"');
  }

  it('routes one request to an alternate gateway with fixed server metadata', async () => {
    const authorizer = vi.fn(async () => ({ Authorization: 'Bearer shared-oauth-token' }));
    const fetchMock = vi.fn(async () => responsesOk('routed'));
    vi.stubGlobal('fetch', fetchMock);

    const client = createLlmClient(respondersConfig(authorizer));
    const result = await client.chatCompletionPrimary({
      messages: [{ role: 'user', content: 'hi' }],
      route: {
        model: 'botboy-gpt6-astra-west/openai.gpt-6-astra',
        endpoint: 'https://astra.gateway.bedrock-agentcore.us-west-2.amazonaws.com/inference/v1',
        headers: { 'OpenAI-Project': 'proj_gcag2sv5e6z2eni2azsx' },
      },
    });

    expect(result.content).toBe('routed');
    const routedCall = fetchMock.mock.calls.find(([, init]) =>
      String(init?.body).includes('botboy-gpt6-astra-west/openai.gpt-6-astra'));
    expect(routedCall?.[0]).toBe(
      'https://astra.gateway.bedrock-agentcore.us-west-2.amazonaws.com/inference/v1/responses',
    );
    expect(routedCall?.[1]?.headers).toMatchObject({
      Authorization: 'Bearer shared-oauth-token',
      'Content-Type': 'application/json',
      'OpenAI-Project': 'proj_gcag2sv5e6z2eni2azsx',
    });
    client.close();
  });

  it('rejects route metadata that could replace authorization', async () => {
    const authorizer: LlmRequestAuthorizer = async () => ({ Authorization: 'Bearer shared-oauth-token' });
    const fetchMock = vi.fn(async () => responsesOk('unused'));
    vi.stubGlobal('fetch', fetchMock);
    const client = createLlmClient(respondersConfig(authorizer));

    await expect(client.chatCompletionPrimary({
      messages: [{ role: 'user', content: 'hi' }],
      route: {
        model: 'botboy-gpt6-astra-west/openai.gpt-6-astra',
        endpoint: 'https://astra.gateway.bedrock-agentcore.us-west-2.amazonaws.com/inference/v1',
        headers: { Authorization: 'Bearer attacker-controlled' },
      },
    })).rejects.toThrow(/route header is not allowed: Authorization/);
    expect(fetchMock.mock.calls.filter(([, init]) => String(init?.body).includes('"hi"'))).toHaveLength(0);
    client.close();
  });

  it('invalidates the authorizer and retries exactly once on 401', async () => {
    const invalidate = vi.fn();
    const authorizer: LlmRequestAuthorizer = async () => ({ Authorization: 'Bearer cached' });
    authorizer.invalidate = invalidate;

    let userCalls = 0;
    const fetchMock = vi.fn(async (_url: string, init?: { body?: string }) => {
      if (!isUserRequest(init)) return responsesOk('probe');
      userCalls += 1;
      return userCalls === 1
        ? { ok: false, status: 401, text: async () => 'expired' } as unknown as Response
        : responsesOk('healed');
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = createLlmClient(respondersConfig(authorizer));
    const result = await client.chatCompletion({ messages: [{ role: 'user', content: 'hi' }] });

    expect(result.content).toBe('healed');
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(userCalls).toBe(2);
    client.close();
  });

  it('does not loop when the retry also fails with 401', async () => {
    const invalidate = vi.fn();
    const authorizer: LlmRequestAuthorizer = async () => ({ Authorization: 'Bearer cached' });
    authorizer.invalidate = invalidate;

    let userCalls = 0;
    const fetchMock = vi.fn(async (_url: string, init?: { body?: string }) => {
      if (!isUserRequest(init)) return responsesOk('probe');
      userCalls += 1;
      return { ok: false, status: 401, text: async () => 'revoked client' } as unknown as Response;
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = createLlmClient(respondersConfig(authorizer));
    await expect(client.chatCompletion({ messages: [{ role: 'user', content: 'hi' }] }))
      .rejects.toThrow(/HTTP 401/);
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(userCalls).toBe(2);
    client.close();
  });
});
