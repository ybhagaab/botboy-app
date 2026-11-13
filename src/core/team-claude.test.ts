import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LlmClient, LlmRequestAuthorizer } from './llm-client.js';
import {
  createInferenceProviderFromEnv,
  createTeamClaudeFactory,
  teamClaudeTargetPrefix,
} from './inference-provider.js';
import {
  TEAM_CLAUDE_FAMILY,
  TEAM_CLAUDE_MODELS,
  gatewayMessagesBase,
  teamClaudeProfile,
  teamClaudeWireModel,
} from './team-claude.js';
import {
  bindLlmModel,
  closeConnectionClients,
  teamClaudeModelEntries,
  teamModelEntries,
  type LlmConnection,
} from './llm-model-catalog.js';
import { AnthropicApiError, classifyAnthropicHttpError, forTeamGateway } from './anthropic-errors.js';
import { startFakeAnthropic, type FakeAnthropicServer } from './anthropic-api.fake.js';
import { createStorage, type StorageLayer } from './storage.js';
import { createLlmUsageService } from './llm-usage.js';
import { importModelTemperature } from './analytics-import-semantic-proposal.js';

/**
 * Claude on the team gateway (docs/maps/team-claude.md): the teammate's existing gateway credential, the gateway's
 * Messages path, the GPT client's health, and catalog entries on the team connection. No test reaches a real gateway.
 */
const PREFIX = 'bedrock-mantle-luna/';
const wire = (index: number) => teamClaudeWireModel(PREFIX, TEAM_CLAUDE_MODELS[index]);
const OPUS_55 = wire(0);
const SONNET_5 = wire(2);

let fake: FakeAnthropicServer | undefined;
const clients: Array<{ close(): void }> = [];
const storages: StorageLayer[] = [];

beforeEach(() => { process.env.BOTBOY_LLM_PROMPT_LOG = '0'; });
afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  for (const storage of storages.splice(0)) storage.close();
  await fake?.close();
  fake = undefined;
  vi.restoreAllMocks();
});

/** The fake Messages server standing in for the gateway: Bearer tokens only, the four team models by wire id. */
async function startGateway(tokens: readonly string[] = ['gw-fresh']) {
  fake = await startFakeAnthropic({
    keys: tokens,
    authStyles: ['bearer'],
    models: TEAM_CLAUDE_MODELS.map((model, index) => ({
      id: wire(index),
      name: model.label,
      variant: model.key === 'claude-opus-5-5' ? 'A' as const : 'B' as const,
      line: model.line,
    })),
  });
  return fake;
}

/** An OAuth-like authorizer: a cached token until `invalidate()`, then the next one. */
function rotatingAuthorizer(tokens: string[], options: { failMint?: Error } = {}) {
  let index = 0;
  const minted: string[] = [];
  const authorize = (async () => {
    if (options.failMint) throw options.failMint;
    const token = tokens[Math.min(index, tokens.length - 1)];
    minted.push(token);
    return { Authorization: `Bearer ${token}` };
  }) as LlmRequestAuthorizer;
  const invalidate = vi.fn(() => { index += 1; });
  authorize.invalidate = invalidate;
  return { authorize, invalidate, minted };
}

function sharedHealth(available = true) {
  return { isAvailable: vi.fn(() => available), healthCheck: vi.fn(async () => available) };
}

function claudeClient(authorize: LlmRequestAuthorizer, health = sharedHealth(), usage?: ReturnType<typeof createLlmUsageService>) {
  const factory = createTeamClaudeFactory({
    gatewayEndpoint: `${fake!.url}/v1`,
    targetPrefix: PREFIX,
    authorize,
    env: { BOTBOY_INFERENCE_HEALTH_INTERVAL_MS: '0' },
  });
  const client = factory.createClient({ health, ...(usage ? { usageService: usage } : {}) });
  clients.push(client);
  return client;
}

const posts = () => fake!.requests.filter(request => request.method === 'POST' && request.path === '/v1/messages');
const hello = (model = OPUS_55) => ({ messages: [{ role: 'user' as const, content: 'hello' }], route: { model }, maxTokens: 64 });

describe('team Claude: the gateway Messages client', () => {
  it('sends the gateway Bearer token and the Anthropic version to the gateway Messages path, never an Anthropic key', async () => {
    await startGateway();
    const { authorize } = rotatingAuthorizer(['gw-fresh']);
    const storage = createStorage(':memory:'); storage.initialize(); storages.push(storage);
    const client = claudeClient(authorize, sharedHealth(), createLlmUsageService(storage.getDb(), { primaryProvider: 'gateway' }));
    const reply = await client.chatCompletion(hello(SONNET_5));
    expect(reply.content).toBe('pong');
    expect(posts()).toHaveLength(1);
    const sent = posts()[0];
    expect(sent.auth).toEqual({ style: 'bearer', key: 'gw-fresh' });
    expect(sent.headers['x-api-key']).toBeUndefined();
    expect(sent.headers['anthropic-version']).toBe('2023-06-01');
    expect((sent.body as { model: string }).model).toBe(SONNET_5);
    expect('temperature' in (sent.body as object)).toBe(false);
    expect(storage.getDb().prepare('SELECT provider, api_mode, model, status FROM llm_usage_attempts').all())
      .toEqual([{ provider: 'gateway', api_mode: 'messages', model: SONNET_5, status: 'completed' }]);
  });

  it('drops a refused cached token and resends exactly once with a fresh one', async () => {
    await startGateway(['gw-fresh']);
    const { authorize, invalidate, minted } = rotatingAuthorizer(['gw-stale', 'gw-fresh']);
    const client = claudeClient(authorize);
    await expect(client.chatCompletion(hello())).resolves.toMatchObject({ content: 'pong' });
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(minted).toEqual(['gw-stale', 'gw-fresh']);
    expect(posts().map(request => request.auth.key)).toEqual(['gw-stale', 'gw-fresh']);
  });

  it('stops after one fresh-token resend and names the gateway, not an Anthropic key', async () => {
    await startGateway(['never-issued']);
    const { authorize, invalidate } = rotatingAuthorizer(['gw-a', 'gw-b', 'gw-c']);
    const client = claudeClient(authorize);
    const error = await client.chatCompletion(hello()).catch(caught => caught);
    expect(error).toBeInstanceOf(AnthropicApiError);
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(posts()).toHaveLength(2);
    const { classification } = error as AnthropicApiError;
    expect(classification.kind).toBe('auth_rejected');
    expect(classification.message).toMatch(/team gateway/);
    expect(`${classification.message} ${classification.nextAction}`).not.toMatch(/platform\.claude\.com|API key/);
  });

  it('sends nothing when the gateway token cannot be minted, keeps the reason and redacts a token', async () => {
    await startGateway();
    const { authorize } = rotatingAuthorizer([], {
      failMint: new Error('OAuth token request failed: HTTP 400 — {"error":"invalid_client"} Bearer eyJhbGciOiJSUzI1NiJ9.leaked'),
    });
    const client = claudeClient(authorize);
    const error = await client.chatCompletion(hello()).catch(caught => caught as Error);
    expect(error).toBeInstanceOf(Error);
    expect(posts()).toHaveLength(0);
    expect(error.message).toContain('OAuth token request failed: HTTP 400');
    expect(error.message).toContain('invalid_client');
    expect(error.message).not.toContain('eyJhbGciOiJSUzI1NiJ9');
  });

  it('runs no probe of its own and reports the GPT client\'s health', async () => {
    await startGateway();
    const health = sharedHealth(false);
    const client = claudeClient(rotatingAuthorizer(['gw-fresh']).authorize, health);
    expect(client.isAvailable()).toBe(false);
    expect(client.getActiveEndpoint()).toBe('none');
    await expect(client.healthCheck()).resolves.toBe(false);
    expect(health.healthCheck).toHaveBeenCalledTimes(1);
    // A successful generation never flips the shared view, and nothing listed models.
    await client.chatCompletion(hello());
    expect(client.isAvailable()).toBe(false);
    expect(fake!.requests.filter(request => request.method === 'GET')).toHaveLength(0);
  });

  it('a model the gateway does not serve gets gateway words and a next step', async () => {
    await startGateway();
    const client = claudeClient(rotatingAuthorizer(['gw-fresh']).authorize);
    const error = await client.chatCompletion(hello(`${PREFIX}anthropic.claude-fable-5`)).catch(caught => caught as AnthropicApiError);
    expect(error.classification.kind).toBe('model_unavailable');
    expect(error.classification.message).toMatch(/not available on the team gateway/);
    expect(error.classification.nextAction).toMatch(/BotBoy owner/);
  });
});

describe('team Claude: wording, paths and the target', () => {
  it('rewrites only key- and account-level words; class, retry and health stay as classified', () => {
    const headers = new Headers();
    for (const status of [401, 402, 403, 404, 429, 529, 503]) {
      const own = classifyAnthropicHttpError(status, headers, '');
      const gateway = forTeamGateway(own);
      expect(gateway.message, String(status)).not.toBe(own.message);
      expect(`${gateway.message} ${gateway.nextAction}`, String(status)).not.toMatch(/platform\.claude\.com|this key|API key|Anthropic account/);
      expect({ ...gateway, message: own.message, nextAction: own.nextAction }).toEqual(own);
    }
    const badRequest = classifyAnthropicHttpError(400, headers, JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'schema is too complex' } }));
    expect(forTeamGateway(badRequest)).toEqual(badRequest);
  });

  it('turns the gateway inference URL into the Messages base the client appends /v1/messages to', () => {
    const endpoint = 'https://botboy-luna-gateway-tyagefrrnz.gateway.bedrock-agentcore.us-east-1.amazonaws.com/inference/v1';
    expect(gatewayMessagesBase(endpoint)).toBe('https://botboy-luna-gateway-tyagefrrnz.gateway.bedrock-agentcore.us-east-1.amazonaws.com/inference');
    expect(gatewayMessagesBase(`${endpoint}/`)).toBe(gatewayMessagesBase(endpoint));
  });

  it('offers Claude only on the GPT-5.6 connector target', () => {
    expect(teamClaudeTargetPrefix('bedrock-mantle-luna/openai.gpt-5.6-terra')).toBe('bedrock-mantle-luna/');
    expect(teamClaudeTargetPrefix('bedrock-mantle-luna/openai.gpt-5.6-sol')).toBe('bedrock-mantle-luna/');
    expect(teamClaudeTargetPrefix('botboy-gpt6-east/openai.gpt-6-sol')).toBeNull();
    expect(teamClaudeTargetPrefix('openai.gpt-5.6-terra')).toBeNull();
    expect(teamClaudeTargetPrefix('/app/models/qwen35-35b-a3b-fp8')).toBeNull();
    expect(teamClaudeTargetPrefix('bedrock-mantle-luna/openai.gpt-5.6-terra-preview')).toBeNull();
  });

  it('the launcher gives the gateway provider a Claude factory and no other provider one', () => {
    const gateway = createInferenceProviderFromEnv({
      BOTBOY_INFERENCE_OAUTH_CLIENT_ID: 'client-id',
      BOTBOY_INFERENCE_OAUTH_CLIENT_SECRET: 'client-secret',
    });
    expect(gateway.id).toBe('gateway');
    expect(gateway.teamClaude?.targetPrefix).toBe('bedrock-mantle-luna/');
    expect(createInferenceProviderFromEnv({ BOTBOY_INFERENCE_PROVIDER: 'gateway', BOTBOY_INFERENCE_ENDPOINT: 'https://gw.test/inference/v1', BOTBOY_INFERENCE_API_KEY: 'static' }).teamClaude?.targetPrefix)
      .toBe('bedrock-mantle-luna/');
    expect(createInferenceProviderFromEnv({
      BOTBOY_INFERENCE_PROVIDER: 'gateway', BOTBOY_INFERENCE_ENDPOINT: 'https://gw.test/inference/v1', BOTBOY_INFERENCE_API_KEY: 'static',
      BOTBOY_INFERENCE_MODEL: 'botboy-gpt6-east/openai.gpt-6-sol',
    }).teamClaude).toBeUndefined();
    expect(createInferenceProviderFromEnv({ BOTBOY_INFERENCE_PROVIDER: 'bedrock' }).teamClaude).toBeUndefined();
    expect(createInferenceProviderFromEnv({ BOTBOY_INFERENCE_PROVIDER: 'openai-compatible', BOTBOY_INFERENCE_ENDPOINT: 'http://localhost:8000/v1' }).teamClaude).toBeUndefined();
  });

  it('records no temperature for a Messages model on any provider', () => {
    expect(importModelTemperature('gateway', 'messages')).toBeNull();
    expect(importModelTemperature('gateway', 'responses')).toBe(0);
    expect(importModelTemperature('anthropic')).toBeNull();
  });
});

describe('team Claude: catalog entries and bound clients', () => {
  const fakeClient = (name: string, defaultModel: string) => {
    const calls: unknown[] = [];
    const client = {
      name,
      calls,
      chatCompletion: vi.fn(async (request: unknown) => { calls.push(request); return { content: name }; }),
      getDefaultModel: () => defaultModel,
      getMaxCompletionTokens: () => 16_384,
      getContextBudgetTokens: () => 100_000,
      getApiMode: () => (name === 'claude' ? 'messages' : 'responses'),
      getActiveEndpoint: () => 'ecs',
      isAvailable: () => true,
      close: vi.fn(),
    };
    return client as unknown as LlmClient & { calls: unknown[]; close: ReturnType<typeof vi.fn> };
  };

  it('adds the four owner-chosen models after GPT, never as the default, each served by the Claude client', () => {
    const claude = fakeClient('claude', OPUS_55);
    const entries = teamClaudeModelEntries({ targetPrefix: PREFIX, client: claude });
    expect(entries.map(entry => [entry.key, entry.label, entry.model])).toEqual([
      ['team.claude-opus-5-5', 'Claude Opus 5.5', 'bedrock-mantle-luna/anthropic.claude-opus-5-5'],
      ['team.claude-opus-5', 'Claude Opus 5', 'bedrock-mantle-luna/anthropic.claude-opus-5'],
      ['team.claude-sonnet-5', 'Claude Sonnet 5', 'bedrock-mantle-luna/anthropic.claude-sonnet-5'],
      ['team.claude-opus-4-8', 'Claude Opus 4.8', 'bedrock-mantle-luna/anthropic.claude-opus-4-8'],
    ]);
    for (const entry of entries) {
      expect(entry).toMatchObject({ connectionId: 'team', family: TEAM_CLAUDE_FAMILY, isConnectionDefault: false, preview: false, apiMode: 'messages' });
      expect(entry.client).toBe(claude);
      expect(entry.route).toEqual({ model: entry.model });
      expect(entry.capabilities).toMatchObject({ images: true, contextWindow: 1_000_000, maxOutputTokens: 128_000 });
    }
    expect(TEAM_CLAUDE_MODELS.map(model => teamClaudeProfile(model).id)).toEqual(['claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5', 'claude-opus-4-8']);
  });

  it('a bound Claude model calls the Claude client with its route; GPT models keep the connection client', async () => {
    const gpt = fakeClient('gpt', `${PREFIX}openai.gpt-5.6-terra`);
    const claude = fakeClient('claude', OPUS_55);
    const connection: LlmConnection = {
      id: 'team',
      label: 'Team gateway',
      source: 'environment',
      client: gpt,
      provider: { id: 'gateway', endpoint: 'https://gw.test/inference/v1', model: `${PREFIX}openai.gpt-5.6-terra`, apiMode: 'responses' },
      models: [
        ...teamModelEntries({ providerId: 'gateway', defaultModel: `${PREFIX}openai.gpt-5.6-terra`, maxContextTokens: 1_000_000, maxCompletionTokens: 16_384, env: {} }),
        ...teamClaudeModelEntries({ targetPrefix: PREFIX, client: claude }),
      ],
      version: 1,
    };
    const sonnet = connection.models.find(entry => entry.key === 'team.claude-sonnet-5')!;
    const bound = bindLlmModel(connection, sonnet, { thinking: 'low' });
    await expect(bound.chatCompletion({ messages: [{ role: 'user', content: 'x' }] })).resolves.toEqual({ content: 'claude' });
    expect(claude.calls).toHaveLength(1);
    expect(gpt.calls).toHaveLength(0);
    expect(claude.calls[0]).toMatchObject({ route: { model: SONNET_5 }, think: true, reasoningEffort: 'low' });
    expect(bound.getApiMode?.()).toBe('messages');
    expect(bound.getModelOperation?.()?.provider).toEqual({ id: 'gateway', endpoint: 'https://gw.test/inference/v1', model: SONNET_5, apiMode: 'messages' });
    // The connection anchor stays the GPT default (legacy catalog helpers resolve routes against it).
    expect(bound.getDefaultModel()).toBe(`${PREFIX}openai.gpt-5.6-terra`);

    const terra = connection.models.find(entry => entry.key === 'team.terra')!;
    await bindLlmModel(connection, terra).chatCompletion({ messages: [{ role: 'user', content: 'x' }] });
    expect(gpt.calls).toHaveLength(1);
    expect(bindLlmModel(connection, terra).getModelOperation?.()?.provider.apiMode).toBe('responses');

    closeConnectionClients(connection);
    expect(gpt.close).toHaveBeenCalledTimes(1);
    expect(claude.close).toHaveBeenCalledTimes(1);
  });
});
