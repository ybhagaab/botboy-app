import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  createInferenceProviderFromEnv,
  defaultInferenceMaxContextTokens,
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

describe('gateway inference provider from env', () => {
  it('applies the gateway profile: responses mode, openai dialect, prefixed Luna model, 1M context', () => {
    const provider = createInferenceProviderFromEnv({ ...GATEWAY_ENV });
    expect(provider.id).toBe('gateway');
    expect(provider.apiMode).toBe('responses');
    expect(provider.model).toBe('bedrock-mantle-luna/openai.gpt-5.6-luna');
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
    expect(provider.model).toBe('bedrock-mantle-luna/openai.gpt-5.6-luna');
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
        model: 'bedrock-mantle-luna/openai.gpt-5.6-luna',
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
