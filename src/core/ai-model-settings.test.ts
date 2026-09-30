import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AI_MODEL_SETTINGS_FILE, AiModelSettingsError, createAiModelSettingsService } from './ai-model-settings.js';
import {
  chatModelCatalogContext,
  createInferenceProviderFromEnv,
  getChatModelCatalog,
  type InferenceProvider,
} from './inference-provider.js';
import { createLlmUsageService } from './llm-usage.js';
import { pinLlmClient } from './llm-client-switch.js';
import type { LlmClient } from './llm-client.js';
import { createStorage, type StorageLayer } from './storage.js';

/**
 * End-to-end Settings → AI model activation against a local fake of the
 * OpenAI API: verification before any state change, private 0600 storage,
 * no-restart activation, pinned operations, usage labels, boot from a saved
 * key, and removal back to the launcher provider.
 */
const VALID_KEY = 'sk-proj-validsettingskey000000000000abcd';
const WRONG_KEY = 'sk-proj-wrongsettingskey000000000000zzzz';
const QUOTA_KEY = 'sk-proj-noquotasettingskey0000000000qqqq';
const NO_TERRA_KEY = 'sk-proj-noterrasettingskey0000000000nnnn';

interface FakeOpenAi {
  base: string;
  gatewayBase: string;
  requests: { method: string; path: string; auth: string; body?: any }[];
  close(): Promise<void>;
}

async function startFakeOpenAi(): Promise<FakeOpenAi> {
  const requests: FakeOpenAi['requests'] = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', chunk => { raw += chunk; });
    req.on('end', () => {
      const auth = String(req.headers.authorization ?? '');
      const url = req.url ?? '/';
      const body = raw ? JSON.parse(raw) : undefined;
      requests.push({ method: req.method ?? 'GET', path: url, auth, body });
      const send = (status: number, value: unknown, headers: Record<string, string> = {}) => {
        res.writeHead(status, { 'content-type': 'application/json', ...headers });
        res.end(JSON.stringify(value));
      };
      const key = auth.replace(/^Bearer /, '');
      if (url.startsWith('/gw/')) {
        // Launcher (environment) provider: an OpenAI-compatible gateway.
        return send(200, { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'gateway' }] }] });
      }
      if (![VALID_KEY, QUOTA_KEY, NO_TERRA_KEY].includes(key)) {
        return send(401, { error: { code: 'invalid_api_key', message: `Incorrect API key provided: ${key.slice(0, 8)}****${key.slice(-4)}.` } });
      }
      const models = key === NO_TERRA_KEY
        ? ['gpt-5.6-luna', 'gpt-4o']
        : ['gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-6-sol', 'gpt-4o'];
      if (req.method === 'GET' && url === '/v1/models') return send(200, { object: 'list', data: models.map(id => ({ id })) });
      if (req.method === 'GET' && url.startsWith('/v1/models/')) {
        const id = decodeURIComponent(url.slice('/v1/models/'.length));
        return models.includes(id) ? send(200, { id }) : send(404, { error: { code: 'model_not_found' } });
      }
      if (req.method === 'POST' && url === '/v1/responses') {
        if (key === QUOTA_KEY) return send(429, { error: { code: 'insufficient_quota', message: 'You exceeded your current quota.' } });
        if (body?.stream) {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.write(`data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'Hello' })}\n\n`);
          res.end(`data: ${JSON.stringify({ type: 'response.completed', response: { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'Hello' }] }], usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4 } } })}\n\n`);
          return;
        }
        return send(200, {
          status: 'completed',
          output: [{ type: 'message', content: [{ type: 'output_text', text: 'OK' }] }],
          usage: { input_tokens: 4, output_tokens: 1, total_tokens: 5 },
        });
      }
      return send(404, { error: { message: 'not found' } });
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    base: `http://127.0.0.1:${port}/v1`,
    gatewayBase: `http://127.0.0.1:${port}/gw/v1`,
    requests,
    close: () => new Promise<void>(resolve => server.close(() => resolve())),
  };
}

describe('Settings → AI model (OpenAI key)', () => {
  let fake: FakeOpenAi;
  let privateRoot: string;
  let storage: StorageLayer;
  let envProvider: InferenceProvider;
  const clients: LlmClient[] = [];

  beforeEach(async () => {
    fake = await startFakeOpenAi();
    privateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'botboy-ai-model-'));
    storage = createStorage(':memory:');
    storage.initialize();
    envProvider = createInferenceProviderFromEnv({
      BOTBOY_INFERENCE_PROVIDER: 'gateway',
      BOTBOY_INFERENCE_ENDPOINT: fake.gatewayBase,
      BOTBOY_INFERENCE_API_KEY: 'gateway-static-key',
      BOTBOY_INFERENCE_HEALTH_INTERVAL_MS: '0',
    });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(async () => {
    for (const client of clients.splice(0)) client.close();
    vi.restoreAllMocks();
    storage.close();
    fs.rmSync(privateRoot, { recursive: true, force: true });
    await fake.close();
  });

  async function service(onActivated = vi.fn()) {
    const created = await createAiModelSettingsService({
      envProvider,
      usageService: createLlmUsageService(storage.getDb(), { primaryProvider: envProvider.id }),
      env: { BOTBOY_INFERENCE_HEALTH_INTERVAL_MS: '0' },
      privateRoot,
      environmentCredentialsPresent: true,
      openAiEndpoint: fake.base,
      onActivated,
    });
    clients.push(created.client);
    return created;
  }

  const settingsFile = () => path.join(privateRoot, AI_MODEL_SETTINGS_FILE);

  it('starts on the launcher provider when no key is saved', async () => {
    const settings = await service();
    const status = settings.status();
    expect(status).toMatchObject({ source: 'environment', provider: 'gateway', state: 'ready' });
    expect(status.openai).toBeUndefined();
    expect(fs.existsSync(settingsFile())).toBe(false);
  });

  it('verifies, stores privately, and switches every workload without a restart', async () => {
    const onActivated = vi.fn();
    const settings = await service(onActivated);
    const gatewayOperation = pinLlmClient(settings.client);

    const status = await settings.saveOpenAiKey(`  ${VALID_KEY}\n`);

    expect(status).toMatchObject({
      state: 'ready',
      source: 'settings',
      provider: 'openai',
      providerLabel: 'OpenAI (your API key)',
      backgroundModel: 'GPT-5.6 Terra',
      openai: { keySuffix: '…abcd' },
      environmentProviderLabel: 'Team gateway (Amazon Bedrock)',
      configVersion: 2,
    });
    expect(status.models.map(model => model.label)).toEqual(['GPT-5.6 Terra', 'GPT-5.6 Luna', 'GPT-6 Sol']);
    expect(JSON.stringify(status)).not.toContain(VALID_KEY);
    expect(onActivated).toHaveBeenCalledWith(expect.objectContaining({ providerId: 'openai', source: 'settings' }));

    const stat = fs.statSync(settingsFile());
    expect(stat.mode & 0o777).toBe(0o600);
    expect(JSON.parse(fs.readFileSync(settingsFile(), 'utf8'))).toMatchObject({ provider: 'openai', apiKey: VALID_KEY });

    // Verification ran one tiny real generation on the Responses path.
    const verification = fake.requests.find(entry => entry.method === 'POST' && entry.path === '/v1/responses');
    expect(verification?.body).toMatchObject({ model: 'gpt-5.6-terra', store: false, max_output_tokens: 16 });

    // Background and chat calls now reach OpenAI with the owner's key.
    fake.requests.length = 0;
    const tools = [{ type: 'function' as const, function: { name: 'search_items', description: 'search', parameters: { type: 'object', properties: {} } } }];
    expect((await settings.client.chatCompletion({ messages: [{ role: 'user', content: 'route this' }], tools, usageContext: { workload: 'background' } })).content).toBe('OK');
    const sent = fake.requests.find(entry => entry.method === 'POST');
    expect(sent).toMatchObject({ path: '/v1/responses', auth: `Bearer ${VALID_KEY}` });
    expect(sent?.body.tools[0]).toMatchObject({ name: 'search_items', strict: false });

    const stream = settings.client.chatCompletionStream({ messages: [{ role: 'user', content: 'hi' }] });
    let step = await stream.next();
    while (!step.done) step = await stream.next();
    expect(step.value.content).toBe('Hello');

    // An operation pinned before the switch finishes on its original provider.
    expect((await gatewayOperation.chatCompletion({ messages: [{ role: 'user', content: 'hi' }] })).content).toBe('gateway');

    // Chat offers exactly the models this key can call, with plain ids.
    const catalog = getChatModelCatalog(settings.client.getDefaultModel(), {}, chatModelCatalogContext(settings.client));
    expect(catalog.models.map(model => model.key)).toEqual(['terra', 'luna', 'gpt6-sol']);

    // Usage rows carry the provider that actually served each attempt.
    const providers = storage.getDb().prepare('SELECT provider, COUNT(*) AS n FROM llm_usage_attempts GROUP BY provider ORDER BY provider').all();
    expect(providers).toEqual([
      { provider: 'gateway', n: expect.any(Number) },
      { provider: 'openai', n: 3 },
    ]);
  });

  it('changes nothing when OpenAI rejects the key', async () => {
    const settings = await service();
    const error = await settings.saveOpenAiKey(WRONG_KEY).catch(e => e);
    expect(error).toBeInstanceOf(AiModelSettingsError);
    expect(error).toMatchObject({ code: 'invalid_key', nextAction: expect.stringContaining('platform.openai.com') });
    expect(String(error.message)).not.toContain(WRONG_KEY);
    expect(fs.existsSync(settingsFile())).toBe(false);
    expect(settings.client.identity()).toMatchObject({ providerId: 'gateway', source: 'environment' });
    expect(settings.version()).toBe(1);
  });

  it('rejects malformed input before any network call', async () => {
    const settings = await service();
    fake.requests.length = 0;
    for (const value of ['', 'not-a-key', 'sk-short', 42, null]) {
      await expect(settings.saveOpenAiKey(value)).rejects.toMatchObject({ code: 'invalid_format' });
    }
    expect(fake.requests).toHaveLength(0);
  });

  it('refuses a key that cannot run the background model', async () => {
    const settings = await service();
    await expect(settings.saveOpenAiKey(NO_TERRA_KEY)).rejects.toMatchObject({ code: 'model_unavailable' });
    expect(fs.existsSync(settingsFile())).toBe(false);
  });

  it('reports an account without credit as its own next action', async () => {
    const settings = await service();
    await expect(settings.saveOpenAiKey(QUOTA_KEY)).rejects.toMatchObject({
      code: 'no_credit',
      nextAction: expect.stringContaining('Billing'),
    });
    expect(fs.existsSync(settingsFile())).toBe(false);
    expect(settings.client.identity().providerId).toBe('gateway');
  });

  it('allows one change at a time', async () => {
    const settings = await service();
    const first = settings.saveOpenAiKey(VALID_KEY);
    await expect(settings.saveOpenAiKey(VALID_KEY)).rejects.toMatchObject({ code: 'busy', httpStatus: 409 });
    await first;
  });

  it('boots straight onto a saved key and repairs loose file permissions', async () => {
    const first = await service();
    await first.saveOpenAiKey(VALID_KEY);
    fs.chmodSync(settingsFile(), 0o644);

    const rebooted = await service();
    expect(rebooted.status()).toMatchObject({ source: 'settings', provider: 'openai', state: 'ready' });
    expect(fs.statSync(settingsFile()).mode & 0o777).toBe(0o600);
  });

  it('ignores an unreadable settings file and keeps the launcher provider', async () => {
    fs.writeFileSync(settingsFile(), '{not json', { mode: 0o600 });
    const settings = await service();
    expect(settings.status()).toMatchObject({ source: 'environment', provider: 'gateway' });
  });

  it('removes the key and returns to the launcher provider immediately', async () => {
    const settings = await service();
    await settings.saveOpenAiKey(VALID_KEY);
    const status = await settings.removeOpenAiKey();
    expect(fs.existsSync(settingsFile())).toBe(false);
    expect(status).toMatchObject({ source: 'environment', provider: 'gateway', configVersion: 3 });
    expect(status.openai).toBeUndefined();
    expect((await settings.client.chatCompletion({ messages: [{ role: 'user', content: 'hi' }] })).content).toBe('gateway');
  });

  it('reports not_configured when neither a key nor launcher credentials exist', async () => {
    const offline: LlmClient = {
      healthCheck: async () => false,
      isAvailable: () => false,
      getDefaultModel: () => 'openai.gpt-5.6-terra',
      getProviderIssue: () => undefined,
      getAvailableModels: () => undefined,
      close: () => {},
    } as unknown as LlmClient;
    const settings = await createAiModelSettingsService({
      envProvider: { id: 'bedrock', endpoint: 'https://bedrock.test/v1', model: 'openai.gpt-5.6-terra', apiMode: 'responses', maxContextTokens: 1_000_000, localFallbackEnabled: false, createClient: () => offline },
      privateRoot,
      environmentCredentialsPresent: false,
      openAiEndpoint: fake.base,
    });
    expect(settings.state()).toBe('not_configured');
    expect(settings.status()).toMatchObject({ state: 'not_configured', source: 'environment' });
  });
});
