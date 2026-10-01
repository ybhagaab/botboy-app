import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AI_MODEL_SETTINGS_FILE, AiModelSettingsError, createAiModelSettingsService } from './ai-model-settings.js';
import { createInferenceProviderFromEnv, type InferenceProvider } from './inference-provider.js';
import { createLlmUsageService } from './llm-usage.js';
import { pinLlmClient } from './llm-client-switch.js';
import type { LlmClient } from './llm-client.js';
import { createStorage, type StorageLayer } from './storage.js';

/**
 * Settings → AI model end to end against local fakes of the OpenAI and
 * DeepSeek APIs plus an OpenAI-compatible team gateway: connections side by
 * side, verification before any state change, private 0600 schema-2 storage,
 * per-role model and Thinking choices, pinned operations, connection-scoped
 * change events, schema-1 migration, and removal.
 */
const OPENAI_KEY = 'sk-proj-validsettingskey000000000000abcd';
const WRONG_KEY = 'sk-proj-wrongsettingskey000000000000zzzz';
const QUOTA_KEY = 'sk-proj-noquotasettingskey0000000000qqqq';
const NO_TERRA_KEY = 'sk-proj-noterrasettingskey0000000000nnnn';
const DEEPSEEK_KEY = 'sk-deepseeksettings0000000000000000dddd';
const DEEPSEEK_EMPTY_KEY = 'sk-deepseekempty000000000000000000eeee';

const DEEPSEEK_MODELS = [
  {
    id: 'deepseek-flash', object: 'model', owned_by: 'deepseek', name: 'DeepSeek V4.1 Flash',
    context_window: 1_000_000, max_output_tokens: 384_000, input_modalities: ['text', 'image'], output_modalities: ['text'],
    effort: { supported_levels: ['low', 'high', 'max'], default_level: 'high' },
  },
  {
    id: 'deepseek-v4-pro', object: 'model', owned_by: 'deepseek', name: 'DeepSeek V4 Pro',
    context_window: 1_000_000, max_output_tokens: 384_000, input_modalities: ['text'], output_modalities: ['text'],
  },
];

interface Fakes {
  openai: string;
  deepseek: string;
  gateway: string;
  requests: { host: 'openai' | 'deepseek' | 'gateway'; method: string; path: string; auth: string; body?: any }[];
  close(): Promise<void>;
}

const completed = (text: string) => ({
  status: 'completed',
  output: [{ type: 'message', content: [{ type: 'output_text', text }] }],
  usage: { input_tokens: 4, output_tokens: 1, total_tokens: 5 },
});

async function startFakes(): Promise<Fakes> {
  const requests: Fakes['requests'] = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', chunk => { raw += chunk; });
    req.on('end', () => {
      const auth = String(req.headers.authorization ?? '');
      const fullUrl = req.url ?? '/';
      const host = fullUrl.startsWith('/gw/') ? 'gateway' : fullUrl.startsWith('/ds/') ? 'deepseek' : 'openai';
      const url = host === 'openai' ? fullUrl : fullUrl.slice(3);
      const body = raw ? JSON.parse(raw) : undefined;
      requests.push({ host, method: req.method ?? 'GET', path: url, auth, body });
      const send = (status: number, value: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(value));
      };
      const key = auth.replace(/^Bearer /, '');
      if (host === 'gateway') return send(200, completed('gateway'));
      if (host === 'deepseek') {
        if (![DEEPSEEK_KEY, DEEPSEEK_EMPTY_KEY].includes(key)) return send(401, { error: { message: 'Authentication Fails, Your api key is invalid' } });
        if (req.method === 'GET' && url === '/models') return send(200, { object: 'list', data: DEEPSEEK_MODELS });
        if (req.method === 'POST' && url === '/responses') {
          if (key === DEEPSEEK_EMPTY_KEY) return send(402, { error: { message: 'Insufficient Balance' } });
          return send(200, completed('deepseek'));
        }
        return send(404, { error: { message: 'not found' } });
      }
      if (![OPENAI_KEY, QUOTA_KEY, NO_TERRA_KEY].includes(key)) {
        return send(401, { error: { code: 'invalid_api_key', message: `Incorrect API key provided: ${key.slice(0, 8)}****${key.slice(-4)}.` } });
      }
      const models = key === NO_TERRA_KEY
        ? ['gpt-5.6-luna', 'gpt-4o', 'text-embedding-3-small']
        : ['gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-6-sol', 'gpt-4o', 'whisper-1', 'dall-e-3', 'text-embedding-3-small'];
      if (req.method === 'GET' && url === '/v1/models') return send(200, { object: 'list', data: models.map(id => ({ id })) });
      if (req.method === 'GET' && url.startsWith('/v1/models/')) {
        const id = decodeURIComponent(url.slice('/v1/models/'.length));
        return models.includes(id) ? send(200, { id }) : send(404, { error: { code: 'model_not_found' } });
      }
      if (req.method === 'POST' && url === '/v1/responses') {
        if (key === QUOTA_KEY) return send(429, { error: { code: 'insufficient_quota', message: 'You exceeded your current quota.' } });
        return send(200, completed('OK'));
      }
      return send(404, { error: { message: 'not found' } });
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    openai: `http://127.0.0.1:${port}/v1`,
    deepseek: `http://127.0.0.1:${port}/ds`,
    gateway: `http://127.0.0.1:${port}/gw/v1`,
    requests,
    close: () => new Promise<void>(resolve => server.close(() => resolve())),
  };
}

describe('Settings → AI model connections', () => {
  let fakes: Fakes;
  let privateRoot: string;
  let storage: StorageLayer;
  let envProvider: InferenceProvider;
  const closers: { close(): void }[] = [];

  beforeEach(async () => {
    fakes = await startFakes();
    privateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'botboy-ai-model-'));
    storage = createStorage(':memory:');
    storage.initialize();
    envProvider = createInferenceProviderFromEnv({
      BOTBOY_INFERENCE_PROVIDER: 'gateway',
      BOTBOY_INFERENCE_ENDPOINT: fakes.gateway,
      BOTBOY_INFERENCE_API_KEY: 'gateway-static-key',
      BOTBOY_INFERENCE_MODEL: 'bedrock-mantle-luna/openai.gpt-5.6-terra',
      BOTBOY_INFERENCE_HEALTH_INTERVAL_MS: '0',
    });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(async () => {
    for (const closer of closers.splice(0)) closer.close();
    vi.restoreAllMocks();
    storage.close();
    fs.rmSync(privateRoot, { recursive: true, force: true });
    await fakes.close();
  });

  async function service(options: { onActivated?: ReturnType<typeof vi.fn>; credentials?: boolean } = {}) {
    const created = await createAiModelSettingsService({
      envProvider,
      usageService: createLlmUsageService(storage.getDb(), { primaryProvider: envProvider.id }),
      env: { BOTBOY_INFERENCE_HEALTH_INTERVAL_MS: '0', BOTBOY_INFERENCE_GPT6_ROLLOUT: 'off' },
      privateRoot,
      environmentCredentialsPresent: options.credentials ?? true,
      openAiEndpoint: fakes.openai,
      deepSeekEndpoint: fakes.deepseek,
      ...(options.onActivated ? { onActivated: options.onActivated } : {}),
    });
    closers.push(created);
    return created;
  }

  const settingsFile = () => path.join(privateRoot, AI_MODEL_SETTINGS_FILE);
  const storedFile = () => JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
  const posts = (host: Fakes['requests'][number]['host']) => fakes.requests.filter(entry => entry.host === host && entry.method === 'POST');

  it('starts on the team gateway when no key is saved', async () => {
    const settings = await service();
    const status = settings.status();
    expect(status).toMatchObject({ state: 'ready', source: 'environment', provider: 'gateway', backgroundModel: 'GPT-5.6 Terra' });
    expect(status.connections.map(connection => connection.id)).toEqual(['team']);
    expect(status.roles.processing).toMatchObject({ modelKey: 'team.terra', chosen: false, thinking: 'off' });
    expect(status.roles.documents).toMatchObject({ modelKey: 'team.terra', chosen: false });
    expect(settings.chatModels.catalog()?.defaultKey).toBe('team.terra');
    expect(fs.existsSync(settingsFile())).toBe(false);
  });

  it('adds an OpenAI key beside the team gateway, offering every chat model it lists', async () => {
    const settings = await service();
    const events: string[] = [];
    settings.chatModels.onChange(event => events.push(event.connectionId));

    const status = await settings.saveApiKey('openai', `  ${OPENAI_KEY}\n`);

    expect(status.connections.map(connection => connection.id)).toEqual(['team', 'openai']);
    const openai = status.connections.find(connection => connection.id === 'openai')!;
    expect(openai).toMatchObject({ label: 'OpenAI', source: 'settings', keySuffix: '…abcd', healthy: true });
    expect(openai.models.map(model => model.key)).toEqual(['openai.gpt-5.6-terra', 'openai.gpt-5.6-luna', 'openai.gpt-6-sol', 'openai.gpt-4o']);
    expect(JSON.stringify(status)).not.toContain(OPENAI_KEY);
    // Nothing chose OpenAI, so background work stays on the team default (D7).
    expect(status.roles.processing).toMatchObject({ modelKey: 'team.terra', chosen: false });
    expect(settings.processing.identity()).toMatchObject({ providerId: 'gateway' });
    // A new connection stops no chat turn.
    expect(events).toEqual([]);

    expect(fs.statSync(settingsFile()).mode & 0o777).toBe(0o600);
    expect(storedFile()).toMatchObject({ schemaVersion: 2, keys: { openai: { apiKey: OPENAI_KEY, models: ['gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-6-sol', 'gpt-4o'] } } });

    // Verification ran one tiny real generation on the Responses path.
    expect(posts('openai')[0]?.body).toMatchObject({ model: 'gpt-5.6-terra', store: false, max_output_tokens: 16 });

    // The chat picker groups both connections; the team default stays the default.
    const catalog = settings.chatModels.catalog()!;
    expect(catalog.groups).toEqual([{ id: 'team', label: 'Team gateway' }, { id: 'openai', label: 'OpenAI' }]);
    expect(catalog.defaultKey).toBe('team.terra');
    expect(catalog.models.find(model => model.key === 'openai.gpt-4o')).toMatchObject({ label: 'gpt-4o', group: 'openai' });
    expect(JSON.stringify(catalog)).not.toMatch(/bedrock-mantle|api\.openai|sk-/);
  });

  it('serves a chat turn on the picked connection with a plain model id', async () => {
    const settings = await service();
    await settings.saveApiKey('openai', OPENAI_KEY);
    fakes.requests.length = 0;
    const binding = settings.chatModels.resolve('openai.gpt-6-sol')!;
    expect(binding).toMatchObject({ key: 'openai.gpt-6-sol', connectionId: 'openai' });
    expect(binding.operation).toMatchObject({ connectionId: 'openai', provider: { id: 'openai' } });
    expect((await binding.client.chatCompletion({ messages: [{ role: 'user', content: 'hi' }] })).content).toBe('OK');
    expect(posts('openai')[0]).toMatchObject({ auth: `Bearer ${OPENAI_KEY}`, body: { model: 'gpt-6-sol' } });
    expect(posts('openai')[0].body.tools).toBeUndefined();
    // Older pickers' unqualified keys map to the team catalog.
    expect(settings.chatModels.resolve('sol')).toMatchObject({ key: 'team.sol', connectionId: 'team' });
    expect(settings.chatModels.resolve('default')).toMatchObject({ key: 'team.terra' });
    expect(settings.chatModels.resolve('openai.not-a-model')).toBeNull();
  });

  it('moves a background role to the chosen model and Thinking level, without a restart', async () => {
    const onActivated = vi.fn();
    const settings = await service({ onActivated });
    await settings.saveApiKey('openai', OPENAI_KEY);
    const pinnedBefore = pinLlmClient(settings.processing);
    const versionBefore = settings.processing.configVersion();

    const status = await settings.setRole('processing', { modelKey: 'openai.gpt-4o' });
    expect(status.roles.processing).toMatchObject({ modelKey: 'openai.gpt-4o', label: 'gpt-4o', connectionId: 'openai', chosen: true });
    expect(status).toMatchObject({ provider: 'openai', backgroundModel: 'gpt-4o' });
    expect(settings.processing.configVersion()).toBeGreaterThan(versionBefore);
    expect(onActivated).toHaveBeenCalledWith(expect.objectContaining({ providerId: 'openai', model: 'gpt-4o' }));
    expect(storedFile().roles).toEqual({ processing: { modelKey: 'openai.gpt-4o' } });

    fakes.requests.length = 0;
    await settings.processing.chatCompletion({ messages: [{ role: 'user', content: 'route this' }], think: false });
    const sent = posts('openai')[0];
    expect(sent.body.model).toBe('gpt-4o');
    // GPT-4o rejects reasoning parameters, so none are sent.
    expect(sent.body).not.toHaveProperty('reasoning');
    expect(sent.body).not.toHaveProperty('include');
    // An operation pinned before the change finishes where it started.
    expect((await pinnedBefore.chatCompletion({ messages: [{ role: 'user', content: 'hi' }] })).content).toBe('gateway');

    await settings.setRole('documents', { modelKey: 'openai.gpt-6-sol', thinking: 'high' });
    fakes.requests.length = 0;
    await settings.documents.chatCompletion({ messages: [{ role: 'user', content: 'draft' }], think: false });
    expect(posts('openai')[0].body).toMatchObject({ model: 'gpt-6-sol', reasoning: { effort: 'high' } });

    // Automatic again: back to the default chain, Thinking kept.
    const reset = await settings.setRole('documents', { modelKey: null });
    expect(reset.roles.documents).toMatchObject({ modelKey: 'team.terra', chosen: false, thinking: 'high' });
  });

  it('rejects role choices that no connection offers', async () => {
    const settings = await service();
    await expect(settings.setRole('processing', { modelKey: 'openai.gpt-4o' })).rejects.toMatchObject({ code: 'model_unavailable' });
    await expect(settings.setRole('processing', { thinking: 'extreme' })).rejects.toMatchObject({ code: 'invalid_thinking' });
    await expect(settings.setRole('chat', { thinking: 'low' })).rejects.toMatchObject({ code: 'invalid_role' });
    expect(fs.existsSync(settingsFile())).toBe(false);
  });

  it('adds a DeepSeek key with its reported models and DeepSeek thinking levels', async () => {
    const settings = await service();
    const status = await settings.saveApiKey('deepseek', DEEPSEEK_KEY);
    const deepseek = status.connections.find(connection => connection.id === 'deepseek')!;
    expect(deepseek).toMatchObject({ label: 'DeepSeek', keySuffix: '…dddd' });
    expect(deepseek.models).toEqual([
      { key: 'deepseek.deepseek-flash', label: 'DeepSeek V4.1 Flash', images: true, contextWindow: 1_000_000 },
      { key: 'deepseek.deepseek-v4-pro', label: 'DeepSeek V4 Pro', images: false, contextWindow: 1_000_000 },
    ]);
    // Verification: one tiny non-thinking generation.
    expect(posts('deepseek')[0].body).toMatchObject({ model: 'deepseek-flash', max_output_tokens: 16, reasoning: { effort: 'none' } });
    expect(posts('deepseek')[0].body).not.toHaveProperty('include');

    await settings.setRole('processing', { modelKey: 'deepseek.deepseek-v4-pro', thinking: 'max' });
    fakes.requests.length = 0;
    expect((await settings.processing.chatCompletion({ messages: [{ role: 'user', content: 'organize' }] })).content).toBe('deepseek');
    expect(posts('deepseek')[0]).toMatchObject({ auth: `Bearer ${DEEPSEEK_KEY}`, body: { model: 'deepseek-v4-pro', reasoning: { effort: 'max' } } });
    expect(settings.processing.getModelOperation?.()).toMatchObject({ connectionId: 'deepseek', capabilities: { images: false } });

    // Each attempt row names the connection that served it (the gateway row
    // is its boot health ping).
    const providers = storage.getDb().prepare('SELECT DISTINCT provider, attempt_reason AS reason FROM llm_usage_attempts ORDER BY provider').all();
    expect(providers).toEqual([
      { provider: 'deepseek', reason: 'initial' },
      { provider: 'gateway', reason: 'health_probe' },
    ]);
  });

  it('reports a DeepSeek account without balance as its own next action', async () => {
    const settings = await service();
    await expect(settings.saveApiKey('deepseek', DEEPSEEK_EMPTY_KEY)).rejects.toMatchObject({
      code: 'no_credit',
      nextAction: expect.stringContaining('platform.deepseek.com'),
    });
    await expect(settings.saveApiKey('deepseek', WRONG_KEY)).rejects.toMatchObject({ code: 'invalid_key', nextAction: expect.stringContaining('platform.deepseek.com') });
    expect(fs.existsSync(settingsFile())).toBe(false);
    expect(settings.status().connections.map(connection => connection.id)).toEqual(['team']);
  });

  it('changes nothing when OpenAI rejects the key', async () => {
    const settings = await service();
    const error = await settings.saveApiKey('openai', WRONG_KEY).catch(e => e);
    expect(error).toBeInstanceOf(AiModelSettingsError);
    expect(error).toMatchObject({ code: 'invalid_key', nextAction: expect.stringContaining('platform.openai.com') });
    expect(String(error.message)).not.toContain(WRONG_KEY);
    expect(fs.existsSync(settingsFile())).toBe(false);
    expect(settings.processing.identity()).toMatchObject({ providerId: 'gateway', source: 'environment' });
    expect(settings.version()).toBe(1);
  });

  it('rejects malformed input before any network call', async () => {
    const settings = await service();
    fakes.requests.length = 0;
    for (const value of ['', 'not-a-key', 'sk-short', 42, null]) {
      await expect(settings.saveApiKey('openai', value)).rejects.toMatchObject({ code: 'invalid_format' });
      await expect(settings.saveApiKey('deepseek', value)).rejects.toMatchObject({ code: 'invalid_format' });
    }
    await expect(settings.saveApiKey('anthropic' as any, OPENAI_KEY)).rejects.toMatchObject({ code: 'invalid_provider' });
    expect(fakes.requests).toHaveLength(0);
  });

  it('accepts a key without Terra and verifies it on a model it does list', async () => {
    const settings = await service();
    const status = await settings.saveApiKey('openai', NO_TERRA_KEY);
    const openai = status.connections.find(connection => connection.id === 'openai')!;
    expect(openai.models.map(model => model.key)).toEqual(['openai.gpt-5.6-luna', 'openai.gpt-4o']);
    expect(posts('openai')[0].body.model).toBe('gpt-5.6-luna');
  });

  it('reports an OpenAI account without credit as its own next action', async () => {
    const settings = await service();
    await expect(settings.saveApiKey('openai', QUOTA_KEY)).rejects.toMatchObject({
      code: 'no_credit',
      nextAction: expect.stringContaining('Billing'),
    });
    expect(fs.existsSync(settingsFile())).toBe(false);
  });

  it('allows one change at a time', async () => {
    const settings = await service();
    const first = settings.saveApiKey('openai', OPENAI_KEY);
    await expect(settings.saveApiKey('deepseek', DEEPSEEK_KEY)).rejects.toMatchObject({ code: 'busy', httpStatus: 409 });
    await expect(settings.setRole('processing', { thinking: 'low' })).rejects.toMatchObject({ code: 'busy' });
    await first;
  });

  it('boots straight onto saved keys and choices, and repairs loose file permissions', async () => {
    const first = await service();
    await first.saveApiKey('openai', OPENAI_KEY);
    await first.saveApiKey('deepseek', DEEPSEEK_KEY);
    await first.setRole('processing', { modelKey: 'deepseek.deepseek-flash', thinking: 'low' });
    fs.chmodSync(settingsFile(), 0o644);

    const rebooted = await service();
    const status = rebooted.status();
    expect(status.connections.map(connection => connection.id)).toEqual(['team', 'openai', 'deepseek']);
    expect(status.roles.processing).toMatchObject({ modelKey: 'deepseek.deepseek-flash', chosen: true, thinking: 'low' });
    expect(rebooted.processing.identity()).toMatchObject({ providerId: 'deepseek', model: 'deepseek-flash' });
    expect(fs.statSync(settingsFile()).mode & 0o777).toBe(0o600);
  });

  it('reads a schema-1 OpenAI file and rewrites it only on the next change', async () => {
    fs.writeFileSync(settingsFile(), JSON.stringify({
      schemaVersion: 1, provider: 'openai', apiKey: OPENAI_KEY,
      savedAt: '2026-09-30T00:00:00.000Z', verifiedAt: '2026-09-30T00:00:00.000Z', models: ['gpt-5.6-terra'],
    }), { mode: 0o600 });
    const settings = await service({ credentials: false });
    const status = settings.status();
    // No team credentials: OpenAI serves everything, as before the upgrade.
    expect(status.connections.map(connection => connection.id)).toEqual(['openai']);
    expect(status.roles.processing).toMatchObject({ modelKey: 'openai.gpt-5.6-terra', chosen: false });
    expect(status.connections[0].models.length).toBeGreaterThan(1); // boot refreshed the list
    expect(storedFile().schemaVersion).toBe(1);

    await settings.setRole('processing', { thinking: 'high' });
    expect(storedFile()).toMatchObject({ schemaVersion: 2, keys: { openai: { apiKey: OPENAI_KEY } }, roles: { processing: { thinking: 'high' } } });
  });

  it('ignores an unreadable settings file and keeps the launcher provider', async () => {
    fs.writeFileSync(settingsFile(), '{not json', { mode: 0o600 });
    const settings = await service();
    expect(settings.status()).toMatchObject({ source: 'environment', provider: 'gateway' });
  });

  it('removes a key: its turns stop, its role choice waits, and other connections keep working', async () => {
    const settings = await service();
    await settings.saveApiKey('openai', OPENAI_KEY);
    await settings.saveApiKey('deepseek', DEEPSEEK_KEY);
    await settings.setRole('processing', { modelKey: 'deepseek.deepseek-flash' });
    const events: string[] = [];
    settings.chatModels.onChange(event => events.push(event.connectionId));

    const status = await settings.removeApiKey('deepseek');
    expect(events).toEqual(['deepseek']);
    expect(status.connections.map(connection => connection.id)).toEqual(['team', 'openai']);
    expect(status.roles.processing).toMatchObject({ modelKey: 'team.terra', chosen: false, unavailableChoice: 'deepseek.deepseek-flash' });
    expect(storedFile()).toMatchObject({ keys: { openai: { apiKey: OPENAI_KEY } }, roles: { processing: { modelKey: 'deepseek.deepseek-flash' } } });
    expect(storedFile().keys.deepseek).toBeUndefined();

    // Replacing a key stops the turns pinned to that connection only.
    events.length = 0;
    await settings.saveApiKey('openai', OPENAI_KEY);
    expect(events).toEqual(['openai']);

    await settings.removeApiKey('openai');
    // Only a role choice remains on disk.
    expect(storedFile()).toEqual({ schemaVersion: 2, keys: {}, roles: { processing: { modelKey: 'deepseek.deepseek-flash' } } });
    await settings.setRole('processing', { modelKey: null });
    expect(fs.existsSync(settingsFile())).toBe(false);
    expect((await settings.processing.chatCompletion({ messages: [{ role: 'user', content: 'hi' }] })).content).toBe('gateway');
  });

  it('reports not_configured when neither a key nor launcher credentials exist, and retires that launcher on the first key', async () => {
    const offline: LlmClient = {
      healthCheck: async () => false,
      isAvailable: () => false,
      getDefaultModel: () => 'openai.gpt-5.6-terra',
      getMaxCompletionTokens: () => 16_384,
      getProviderIssue: () => undefined,
      getAvailableModels: () => undefined,
      close: vi.fn(),
    } as unknown as LlmClient;
    const settings = await createAiModelSettingsService({
      envProvider: { id: 'bedrock', endpoint: 'https://bedrock.test/v1', model: 'openai.gpt-5.6-terra', apiMode: 'responses', maxContextTokens: 1_000_000, localFallbackEnabled: false, createClient: () => offline },
      privateRoot,
      env: { BOTBOY_INFERENCE_HEALTH_INTERVAL_MS: '0' },
      environmentCredentialsPresent: false,
      openAiEndpoint: fakes.openai,
      deepSeekEndpoint: fakes.deepseek,
    });
    closers.push(settings);
    expect(settings.state()).toBe('not_configured');
    expect(settings.status()).toMatchObject({ state: 'not_configured', source: 'environment' });

    const status = await settings.saveApiKey('deepseek', DEEPSEEK_KEY);
    expect(status.state).toBe('ready');
    expect(status.connections.map(connection => connection.id)).toEqual(['deepseek']);
    expect(status.roles.processing).toMatchObject({ modelKey: 'deepseek.deepseek-flash', chosen: false });
    expect(settings.chatModels.catalog()?.defaultKey).toBe('deepseek.deepseek-flash');
    expect(offline.close).toHaveBeenCalled();
  });
});
