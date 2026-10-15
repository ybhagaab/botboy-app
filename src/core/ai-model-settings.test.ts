import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { inspect } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AI_MODEL_SETTINGS_FILE, AiModelSettingsError, aiModelIssueText, createAiModelSettingsService, modelSettingsError } from './ai-model-settings.js';
import {
  FAKE_ANTHROPIC_KEY,
  FAKE_D10_ROWS,
  FAKE_DEFAULT_MODELS,
  fakeErrorBody,
  startFakeAnthropic,
  type FakeAnthropicServer,
} from './anthropic-api.fake.js';
import { analyticsImportProviderReceipt } from './analytics-import-semantic-proposal.js';
import { createInferenceProviderFromEnv, type InferenceProvider } from './inference-provider.js';
import { createLlmUsageService } from './llm-usage.js';
import { pinLlmClient } from './llm-client-switch.js';
import type { LlmClient } from './llm-client.js';
import { createStorage, type StorageLayer } from './storage.js';
import { canMakeSelfSignedCert, closedLoopbackPort, startSelfSignedServer } from './tls-loopback.testutil.js';

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
// A DeepSeek key whose model list works but whose generations answer HTTP 503 "Server Overloaded".
const DEEPSEEK_BUSY_KEY = 'sk-deepseekbusy00000000000000000000bbbb';
// A DeepSeek key whose model list works but whose generations are cut off mid-request (the socket is destroyed).
const DEEPSEEK_CUT_KEY = 'sk-deepseekcut000000000000000000000cccc';
// A DeepSeek key whose model list works but whose generations answer HTTP 400 with a long body that echoes a key.
const DEEPSEEK_REJECT_KEY = 'sk-deepseekreject00000000000000000rrrr';
const ECHOED_KEY = 'sk-plantedecho0123456789abcdefghij';

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
        if (![DEEPSEEK_KEY, DEEPSEEK_EMPTY_KEY, DEEPSEEK_BUSY_KEY, DEEPSEEK_CUT_KEY, DEEPSEEK_REJECT_KEY].includes(key)) return send(401, { error: { message: 'Authentication Fails, Your api key is invalid' } });
        if (req.method === 'GET' && url === '/models') return send(200, { object: 'list', data: DEEPSEEK_MODELS });
        if (req.method === 'POST' && url === '/responses') {
          if (key === DEEPSEEK_CUT_KEY) { req.socket.destroy(); return; }
          if (key === DEEPSEEK_REJECT_KEY) {
            return send(400, { error: { message: `Invalid request: reasoning is not accepted here. Echoed ${ECHOED_KEY} ${'padding '.repeat(60)}` } });
          }
          if (key === DEEPSEEK_EMPTY_KEY) return send(402, { error: { message: 'Insufficient Balance' } });
          if (key === DEEPSEEK_BUSY_KEY) {
            res.writeHead(503, { 'content-type': 'text/plain' });
            return res.end('Server Overloaded');
          }
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
    // No test may reach the real Anthropic API, however its endpoint is wired: such a request fails at once.
    const realFetch = globalThis.fetch;
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
      if (/(^|\.)anthropic\.com$/i.test(new URL(url).hostname)) return Promise.reject(new Error('the real Anthropic API is off limits in tests'));
      return realFetch(input as any, init);
    });
  });

  afterEach(async () => {
    for (const closer of closers.splice(0)) closer.close();
    vi.restoreAllMocks();
    storage.close();
    fs.rmSync(privateRoot, { recursive: true, force: true });
    await fakes.close();
  });

  async function service(options: { onActivated?: ReturnType<typeof vi.fn>; credentials?: boolean; anthropicEndpoint?: string; now?: () => Date; fetchImpl?: typeof fetch; deepSeekEndpoint?: string } = {}) {
    const created = await createAiModelSettingsService({
      envProvider,
      usageService: createLlmUsageService(storage.getDb(), { primaryProvider: envProvider.id }),
      env: { BOTBOY_INFERENCE_HEALTH_INTERVAL_MS: '0', BOTBOY_INFERENCE_GPT6_ROLLOUT: 'off' },
      privateRoot,
      environmentCredentialsPresent: options.credentials ?? true,
      openAiEndpoint: fakes.openai,
      deepSeekEndpoint: options.deepSeekEndpoint ?? fakes.deepseek,
      ...(options.anthropicEndpoint ? { anthropicEndpoint: options.anthropicEndpoint } : {}),
      ...(options.onActivated ? { onActivated: options.onActivated } : {}),
      ...(options.now ? { now: options.now } : {}),
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    });
    closers.push(created);
    return created;
  }

  /**
   * A launcher provider with no credentials and no reachable gateway: the
   * owner relies on saved keys only, so the team connection is never
   * "configured" and never takes part in the chat default.
   */
  async function serviceWithoutTeam(options: { anthropicEndpoint?: string; usage?: boolean } = {}) {
    const offline = {
      healthCheck: async () => false,
      isAvailable: () => false,
      getDefaultModel: () => 'openai.gpt-5.6-terra',
      getMaxCompletionTokens: () => 16_384,
      getProviderIssue: () => undefined,
      getAvailableModels: () => undefined,
      close: vi.fn(),
    } as unknown as LlmClient;
    const created = await createAiModelSettingsService({
      envProvider: { id: 'bedrock', endpoint: 'https://bedrock.test/v1', model: 'openai.gpt-5.6-terra', apiMode: 'responses', maxContextTokens: 1_000_000, localFallbackEnabled: false, createClient: () => offline },
      privateRoot,
      env: { BOTBOY_INFERENCE_HEALTH_INTERVAL_MS: '0' },
      environmentCredentialsPresent: false,
      openAiEndpoint: fakes.openai,
      deepSeekEndpoint: fakes.deepseek,
      ...(options.anthropicEndpoint ? { anthropicEndpoint: options.anthropicEndpoint } : {}),
      ...(options.usage ? { usageService: createLlmUsageService(storage.getDb(), { primaryProvider: 'bedrock' }) } : {}),
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

  // D1 (deepseek-failures report § 6): a provider 5xx at Save used to read "BotBoy could not reach api.deepseek.com
  // (check your internet, proxy or VPN)", a network verdict for a service that had answered.
  it('reports a DeepSeek 503 at Save as the provider\'s own trouble, never as a network failure, and changes nothing', async () => {
    const settings = await service();
    const error = await settings.saveApiKey('deepseek', DEEPSEEK_BUSY_KEY).catch(e => e);
    expect(error).toBeInstanceOf(AiModelSettingsError);
    expect(error).toMatchObject({ code: 'provider_unavailable', httpStatus: 502 });
    expect(error.message).toBe("DeepSeek answered HTTP 503 (Server Overloaded). That is a problem on DeepSeek's side, so BotBoy could not finish checking the key.");
    expect(error.nextAction).toBe('Wait a minute, then save the key again. If it keeps failing, the provider may be having an outage.');
    for (const text of [error.message, error.nextAction]) expect(text).not.toMatch(/could not reach|internet|proxy|VPN/i);
    expect(String(error.message) + String(error.nextAction)).not.toContain(DEEPSEEK_BUSY_KEY);
    expect(fs.existsSync(settingsFile())).toBe(false);
    expect(settings.status().connections.map(connection => connection.id)).toEqual(['team']);
    // The verification generation ran once; Save does not wait out the client's backoff for a health-neutral check.
    expect(posts('deepseek')).toHaveLength(1);
  });

  // D2 (deepseek-failures report § 6): "BotBoy could not reach api.deepseek.com" hid WHY, because getJson swallowed the
  // error and Node keeps the errno one level down (TypeError: fetch failed → cause). Codes only: never a URL or a key.
  // D4 (report § 6): the owner sees "rejected the verification request (HTTP 400)" and the provider's own words, which
  // say WHAT it rejected, were dropped; a failed Save left nothing in /tmp/ppt.log to read.
  describe('a failed Save check leaves a trace in the log (D4)', () => {
    const keyCheckLines = () => vi.mocked(console.warn).mock.calls.map(call => call.map(String).join(' ')).filter(text => text.includes('key check failed'));

    it('logs the status and the provider\'s words for a 400, redacted and bounded to 200 characters, while the owner still sees the short sentence', async () => {
      const settings = await service();
      const error = await settings.saveApiKey('deepseek', DEEPSEEK_REJECT_KEY).catch(e => e);
      expect(error).toMatchObject({ code: 'rejected', httpStatus: 502, message: 'DeepSeek rejected the verification request (HTTP 400).' });
      const lines = keyCheckLines();
      expect(lines).toHaveLength(1);
      const [line] = lines;
      expect(line).toMatch(/^\[AI model\] DeepSeek key check failed: HTTP 400 \{"error":\{"message":"Invalid request: reasoning is not accepted here\. Echoed sk-…\[redacted\]/);
      // A key-shaped string the provider echoed, and the saved key itself, never reach the log.
      expect(line).not.toContain(ECHOED_KEY);
      expect(line).not.toContain(DEEPSEEK_REJECT_KEY);
      expect(line.length).toBeLessThanOrEqual('[AI model] DeepSeek key check failed: HTTP 400 '.length + 200);
      expect(line).not.toContain('\n');
    });

    it('logs the same line for a 503 and a cut connection, and nothing for a Save that works', async () => {
      const settings = await service();
      await settings.saveApiKey('deepseek', DEEPSEEK_BUSY_KEY).catch(() => undefined);
      expect(keyCheckLines().at(-1)).toBe('[AI model] DeepSeek key check failed: HTTP 503 Server Overloaded');
      await settings.saveApiKey('deepseek', DEEPSEEK_CUT_KEY).catch(() => undefined);
      expect(keyCheckLines().at(-1)).toMatch(/^\[AI model\] DeepSeek key check failed: fetch failed \((UND_ERR_SOCKET|ECONNRESET)\)$/);
      expect(keyCheckLines()).toHaveLength(2);
      await settings.saveApiKey('deepseek', DEEPSEEK_KEY);
      expect(keyCheckLines()).toHaveLength(2);
    });

    it('names the provider of the card, and logs a typed limit (no HTTP status in its message) by its own words', async () => {
      const settings = await service();
      await settings.saveApiKey('openai', QUOTA_KEY).catch(() => undefined);
      expect(keyCheckLines()).toEqual(['[AI model] OpenAI key check failed: The OpenAI account behind this API key has no available credit.']);
    });
  });

  describe('the network cause at Save (D2)', () => {
    const errno = (code: string) => Object.assign(new Error(`connect ${code}`), { code, syscall: 'connect' });
    const failingFetch = (error: unknown) => (async () => { throw error; }) as unknown as typeof fetch;

    it('names the errno of a refused connection (a real loopback socket nothing listens on)', async () => {
      const settings = await service({ deepSeekEndpoint: `http://127.0.0.1:${await closedLoopbackPort()}` });
      const error = await settings.saveApiKey('deepseek', DEEPSEEK_KEY).catch(e => e);
      expect(error).toBeInstanceOf(AiModelSettingsError);
      expect(error).toMatchObject({ code: 'unreachable', httpStatus: 502, message: 'BotBoy could not reach api.deepseek.com (ECONNREFUSED).' });
      expect(error.nextAction).toBe('Check your internet connection (and any proxy or VPN rules for api.deepseek.com), then try again.');
      expect(String(error.message) + String(error.nextAction)).not.toMatch(/127\.0\.0\.1|sk-/);
      expect(fs.existsSync(settingsFile())).toBe(false);
    });

    it('lists every address of a failed connect the way Node reports them, and calls a timeout a timeout', async () => {
      const both = Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new AggregateError([errno('ETIMEDOUT'), errno('EHOSTUNREACH')], ''), { code: 'ETIMEDOUT' }) });
      for (const provider of ['openai', 'deepseek'] as const) {
        const settings = await service({ fetchImpl: failingFetch(both) });
        const error = await settings.saveApiKey(provider, provider === 'openai' ? OPENAI_KEY : DEEPSEEK_KEY).catch(e => e);
        expect(error, provider).toMatchObject({ code: 'unreachable', message: `BotBoy could not reach ${provider === 'openai' ? 'api.openai.com' : 'api.deepseek.com'} (ETIMEDOUT+EHOSTUNREACH).` });
      }
      const slow = await service({ fetchImpl: failingFetch(new DOMException('The operation was aborted due to timeout', 'TimeoutError')) });
      await expect(slow.saveApiKey('deepseek', DEEPSEEK_KEY)).rejects.toMatchObject({ code: 'unreachable', message: 'BotBoy could not reach api.deepseek.com (timed out).' });
      // No cause to show: the text is what it was.
      const bare = await service({ fetchImpl: failingFetch(new Error('boom')) });
      await expect(bare.saveApiKey('deepseek', DEEPSEEK_KEY)).rejects.toMatchObject({ code: 'unreachable', message: 'BotBoy could not reach api.deepseek.com.' });
    });

    it.skipIf(!canMakeSelfSignedCert())('says in words that a proxy or security product replaced the certificate (a real self-signed loopback server)', async () => {
      const tls = await startSelfSignedServer();
      try {
        const settings = await service({ deepSeekEndpoint: tls.url });
        const error = await settings.saveApiKey('deepseek', DEEPSEEK_KEY).catch(e => e);
        expect(error).toMatchObject({ code: 'unreachable', httpStatus: 502, message: 'BotBoy could not reach api.deepseek.com (DEPTH_ZERO_SELF_SIGNED_CERT).' });
        expect(error.nextAction).toBe("A proxy or security product on this network replaces api.deepseek.com's certificate, and BotBoy does not trust the replacement. Try another network (a phone hotspot works) and tell the owner.");
        expect(tls.requests, 'the handshake failed, so no request was served').toEqual([]);
      } finally {
        await tls.close();
      }
    });

    it('keeps the cause when the failure is in the verification generation, through the client\'s own rethrow', async () => {
      const settings = await service();
      const error = await settings.saveApiKey('deepseek', DEEPSEEK_CUT_KEY).catch(e => e);
      expect(error).toBeInstanceOf(AiModelSettingsError);
      expect(error.code).toBe('unreachable');
      expect(error.message).toMatch(/^BotBoy could not reach api\.deepseek\.com \((UND_ERR_SOCKET|ECONNRESET)\)\.$/);
      expect(fs.existsSync(settingsFile())).toBe(false);
    });
  });

  it('maps a provider 5xx to provider_unavailable with its words, and leaves 4xx answers and network failures where they were', () => {
    for (const status of [500, 502, 503, 504]) {
      const error = modelSettingsError(new Error(`HTTP ${status}: {"error":{"message":"upstream trouble"}}`), 'deepseek');
      expect(error, String(status)).toMatchObject({ code: 'provider_unavailable', httpStatus: 502, message: expect.stringContaining(`answered HTTP ${status} (upstream trouble)`) });
    }
    // A plain-text body is shown as it came, on one line and bounded; a key echoed in it never reaches the owner.
    const wordy = modelSettingsError(new Error(`HTTP 503: ${'busy '.repeat(100)}\nsk-plantedleakage0123456789abcdef`), 'openai');
    expect(wordy.message.length).toBeLessThan(260);
    expect(wordy.message).not.toContain('plantedleakage');
    expect(wordy.message).toMatch(/^OpenAI answered HTTP 503 \(busy busy/);
    expect(modelSettingsError(new Error('HTTP 503:'), 'deepseek').message).toMatch(/^DeepSeek answered HTTP 503\. That is/);
    expect(modelSettingsError(new Error('HTTP 400: nope'), 'deepseek').code).toBe('rejected');
    expect(modelSettingsError(new Error('HTTP 404: nope'), 'deepseek').code).toBe('model_unavailable');
    expect(modelSettingsError(new Error('fetch failed'), 'deepseek').code).toBe('unreachable');
    expect(modelSettingsError(new Error('boom'), 'deepseek').code).toBe('unreachable');
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
    await expect(settings.saveApiKey('gemini' as any, OPENAI_KEY)).rejects.toMatchObject({ code: 'invalid_provider' });
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

  it('hides team models when Amazon Employee is off and nothing is set up (Settings → Workplace)', async () => {
    const offline = {
      healthCheck: async () => false, isAvailable: () => false, getDefaultModel: () => 'openai.gpt-5.6-terra',
      getMaxCompletionTokens: () => 16_384, getProviderIssue: () => undefined, getAvailableModels: () => undefined, close: vi.fn(),
    } as unknown as LlmClient;
    let visible = false;
    const settings = await createAiModelSettingsService({
      envProvider: { id: 'bedrock', endpoint: 'https://bedrock.test/v1', model: 'openai.gpt-5.6-terra', apiMode: 'responses', maxContextTokens: 1_000_000, localFallbackEnabled: false, createClient: () => offline },
      privateRoot,
      env: { BOTBOY_INFERENCE_HEALTH_INTERVAL_MS: '0' },
      environmentCredentialsPresent: false,
      openAiEndpoint: fakes.openai,
      deepSeekEndpoint: fakes.deepseek,
      teamVisibleWithoutCredentials: () => visible,
    });
    closers.push(settings);
    const status = settings.status();
    expect(status.connections).toEqual([]);
    expect(status.models).toEqual([]);
    expect(status.backgroundModel).toBe('Not set up');
    for (const role of ['processing', 'documents'] as const) {
      expect(status.roles[role]).toMatchObject({ modelKey: '', label: 'Not set up', connectionLabel: '', chosen: false });
    }
    expect(settings.chatModels.catalog()).toEqual({ defaultKey: '', groups: [], models: [], configured: false });
    expect(JSON.stringify(status)).not.toMatch(/GPT-5\.6|Terra/);
    const events: string[] = [];
    settings.chatModels.onChange(event => events.push(event.connectionId));
    const before = settings.version();
    settings.refreshVisibility();
    expect(settings.version()).toBe(before + 1);
    expect(events).toEqual([]);
    visible = true;
    expect(settings.status().connections.map(connection => connection.id)).toEqual(['team']);
  });

  it('keeps team models for an OFF owner who holds team credentials', async () => {
    const settings = await createAiModelSettingsService({
      envProvider,
      usageService: createLlmUsageService(storage.getDb(), { primaryProvider: envProvider.id }),
      env: { BOTBOY_INFERENCE_HEALTH_INTERVAL_MS: '0', BOTBOY_INFERENCE_GPT6_ROLLOUT: 'off' },
      privateRoot,
      environmentCredentialsPresent: true,
      openAiEndpoint: fakes.openai,
      deepSeekEndpoint: fakes.deepseek,
      teamVisibleWithoutCredentials: () => false,
    });
    closers.push(settings);
    expect(settings.status().connections.map(connection => connection.id)).toEqual(['team']);
    expect(settings.chatModels.catalog()?.defaultKey).toBe('team.terra');
  });

  // ── Chat default pins (design v3 D8 / §6 N2) ──
  // Written before any Claude change and passing on the unchanged rule: the
  // team default when the team connection is configured, otherwise the model
  // serving Organizing. A Claude connection must not alter any of these
  // results for team, OpenAI, or DeepSeek owners.
  describe('chat default model', () => {
    const chatDefaults = (settings: Awaited<ReturnType<typeof service>>) => ({
      catalog: settings.chatModels.catalog()?.defaultKey,
      flagged: settings.chatModels.catalog()?.models.filter(model => model.isDefault).map(model => model.key),
      undefinedKey: settings.chatModels.resolve(undefined)?.key,
      defaultWord: settings.chatModels.resolve('default')?.key,
    });

    it('stays the team default while the team connection is configured, whatever Organizing is set to', async () => {
      const settings = await service();
      await settings.saveApiKey('openai', OPENAI_KEY);
      await settings.saveApiKey('deepseek', DEEPSEEK_KEY);
      await settings.setRole('processing', { modelKey: 'deepseek.deepseek-v4-pro' });
      expect(settings.status().roles.processing).toMatchObject({ modelKey: 'deepseek.deepseek-v4-pro', chosen: true });
      expect(chatDefaults(settings)).toEqual({
        catalog: 'team.terra', flagged: ['team.terra'], undefinedKey: 'team.terra', defaultWord: 'team.terra',
      });
    });

    it('without team credentials follows an Automatic Organizing: the first connection default', async () => {
      const settings = await serviceWithoutTeam();
      await settings.saveApiKey('openai', OPENAI_KEY);
      await settings.saveApiKey('deepseek', DEEPSEEK_KEY);
      expect(settings.status().connections.map(connection => connection.id)).toEqual(['openai', 'deepseek']);
      expect(settings.status().roles.processing).toMatchObject({ modelKey: 'openai.gpt-5.6-terra', chosen: false });
      expect(chatDefaults(settings)).toEqual({
        catalog: 'openai.gpt-5.6-terra', flagged: ['openai.gpt-5.6-terra'],
        undefinedKey: 'openai.gpt-5.6-terra', defaultWord: 'openai.gpt-5.6-terra',
      });
    });

    it('without team credentials follows an explicit non-default Organizing model, in the catalog and in resolve()', async () => {
      const settings = await serviceWithoutTeam();
      await settings.saveApiKey('openai', OPENAI_KEY);
      await settings.saveApiKey('deepseek', DEEPSEEK_KEY);

      // A non-default model of the second connection.
      await settings.setRole('processing', { modelKey: 'deepseek.deepseek-v4-pro' });
      expect(settings.status().roles.processing).toMatchObject({ modelKey: 'deepseek.deepseek-v4-pro', chosen: true });
      expect(chatDefaults(settings)).toEqual({
        catalog: 'deepseek.deepseek-v4-pro', flagged: ['deepseek.deepseek-v4-pro'],
        undefinedKey: 'deepseek.deepseek-v4-pro', defaultWord: 'deepseek.deepseek-v4-pro',
      });

      // A non-default model of the first connection.
      await settings.setRole('processing', { modelKey: 'openai.gpt-4o' });
      expect(chatDefaults(settings)).toEqual({
        catalog: 'openai.gpt-4o', flagged: ['openai.gpt-4o'],
        undefinedKey: 'openai.gpt-4o', defaultWord: 'openai.gpt-4o',
      });

      // Back to Automatic: the default chain again.
      await settings.setRole('processing', { modelKey: null });
      expect(chatDefaults(settings).catalog).toBe('openai.gpt-5.6-terra');
      expect(chatDefaults(settings).undefinedKey).toBe('openai.gpt-5.6-terra');
    });

    it('follows an explicit Organizing model on a single connection too', async () => {
      const settings = await serviceWithoutTeam();
      await settings.saveApiKey('deepseek', DEEPSEEK_KEY);
      expect(chatDefaults(settings).catalog).toBe('deepseek.deepseek-flash');
      await settings.setRole('processing', { modelKey: 'deepseek.deepseek-v4-pro' });
      expect(chatDefaults(settings)).toEqual({
        catalog: 'deepseek.deepseek-v4-pro', flagged: ['deepseek.deepseek-v4-pro'],
        undefinedKey: 'deepseek.deepseek-v4-pro', defaultWord: 'deepseek.deepseek-v4-pro',
      });
    });

    it('returns to the default chain when the explicit Organizing model disappears', async () => {
      const settings = await serviceWithoutTeam();
      await settings.saveApiKey('openai', OPENAI_KEY);
      await settings.saveApiKey('deepseek', DEEPSEEK_KEY);
      await settings.setRole('processing', { modelKey: 'deepseek.deepseek-v4-pro' });
      await settings.removeApiKey('deepseek');
      expect(settings.status().roles.processing).toMatchObject({
        modelKey: 'openai.gpt-5.6-terra', chosen: false, unavailableChoice: 'deepseek.deepseek-v4-pro',
      });
      expect(chatDefaults(settings)).toEqual({
        catalog: 'openai.gpt-5.6-terra', flagged: ['openai.gpt-5.6-terra'],
        undefinedKey: 'openai.gpt-5.6-terra', defaultWord: 'openai.gpt-5.6-terra',
      });
    });
  });

  // ── Anthropic (Claude) key and connection (slices A1 and A2) ──
  // The key is verified, stored with its model list and shown on its card (A1); A2 registers the Claude
  // connection, so its models appear in the chat picker and the role selects. Claude is last in the default
  // chain, so nothing that was automatic changes unless Claude is the only connection (the five pin tests).
  describe('Anthropic (Claude) key', () => {
    const SECOND_KEY = ['sk', 'ant', 'api03', `second${'0123456789'.repeat(3)}`].join('-');
    const NO_ACCESS_KEY = ['sk', 'ant', 'api03', `unknown${'abcdefghij'.repeat(3)}`].join('-');
    const ADMIN_KEY = ['sk', 'ant', 'admin01', `admin${'0123456789'.repeat(3)}`].join('-');
    let anthropic: FakeAnthropicServer;
    const CLAUDE_MODELS: [string, string][] = [
      ['anthropic.claude-sonnet-5-5', 'Claude Sonnet 5.5'],
      ['anthropic.claude-haiku-5-5', 'Claude Haiku 5.5'],
      ['anthropic.claude-opus-5-5', 'Claude Opus 5.5'],
      ['anthropic.claude-opus-4-5-20251101', 'Claude Opus 4.5'],
      ['anthropic.claude-haiku-4-5-20251001', 'Claude Haiku 4.5'],
    ];

    beforeEach(async () => {
      anthropic = await startFakeAnthropic({ keys: [FAKE_ANTHROPIC_KEY, SECOND_KEY] });
    });
    afterEach(async () => {
      await anthropic.close();
    });

    const saveWith = () => service({ anthropicEndpoint: anthropic.url });
    const anthropicPosts = () => anthropic.requests.filter(request => request.method === 'POST');
    const suffixOf = (key: string) => `…${key.slice(-4)}`;
    const connectionIds = (settings: Awaited<ReturnType<typeof service>>) => settings.status().connections.map(connection => connection.id);

    it('verifies the key, stores it privately with its model list, registers the Claude connection, and shows only the suffix and times', async () => {
      const settings = await saveWith();
      const before = settings.version();
      const statusBefore = settings.status();
      const events: string[] = [];
      settings.chatModels.onChange(event => events.push(event.connectionId));

      const status = await settings.saveApiKey('anthropic', `  ${FAKE_ANTHROPIC_KEY}\n`);

      expect(status.anthropic).toEqual({ keySuffix: suffixOf(FAKE_ANTHROPIC_KEY), savedAt: expect.any(String), verifiedAt: expect.any(String) });
      expect(JSON.stringify(status)).not.toContain(FAKE_ANTHROPIC_KEY);
      expect(settings.version()).toBeGreaterThan(before);

      // The connection appears beside the team gateway under its own heading, with the key's models under their reported titles.
      expect(connectionIds(settings)).toEqual(['team', 'anthropic']);
      expect(status.connections[0]).toEqual(statusBefore.connections[0]);
      const claude = status.connections.find(connection => connection.id === 'anthropic')!;
      expect(claude).toMatchObject({ label: 'Anthropic (Claude)', source: 'settings', healthy: true, keySuffix: suffixOf(FAKE_ANTHROPIC_KEY) });
      expect(claude.models.map(model => [model.key, model.label])).toEqual(CLAUDE_MODELS);
      expect(claude.models[0]).toEqual({ key: 'anthropic.claude-sonnet-5-5', label: 'Claude Sonnet 5.5', images: true, contextWindow: 1_000_000, thinkingOff: 'lowest_effort' });
      expect(claude.models[3]).toMatchObject({ key: 'anthropic.claude-opus-4-5-20251101', contextWindow: 200_000 });
      expect(claude.issue).toBeUndefined();
      expect(status.models.map(model => model.key)).toEqual([...statusBefore.models.map(model => model.key), ...CLAUDE_MODELS.map(([key]) => key)]);
      expect(status.state).toBe('ready');

      // Claude is last in the default chain: organizing, document writing and the chat default stay on the team gateway.
      expect(status.roles).toEqual(statusBefore.roles);
      const catalog = settings.chatModels.catalog()!;
      expect(catalog.defaultKey).toBe('team.terra');
      expect(catalog.groups).toEqual([{ id: 'team', label: 'Team gateway' }, { id: 'anthropic', label: 'Anthropic (Claude)' }]);
      expect(catalog.models.filter(model => model.group === 'anthropic').map(model => model.key)).toEqual(CLAUDE_MODELS.map(([key]) => key));
      expect(catalog.models.find(model => model.key === 'anthropic.claude-sonnet-5-5')).toMatchObject({ label: 'Claude Sonnet 5.5', group: 'anthropic', images: true });
      expect(JSON.stringify(catalog)).not.toMatch(/api\.anthropic|sk-ant|x-api-key|127\.0\.0\.1/);
      // A new connection stops no chat turn.
      expect(events).toEqual([]);
      expect(settings.chatModels.resolve('anthropic.claude-sonnet-5-5')).toMatchObject({ key: 'anthropic.claude-sonnet-5-5', connectionId: 'anthropic' });
      expect(settings.chatModels.resolve('anthropic.claude-not-listed')).toBeNull();

      // Private 0600 schema-2 file with the key and the profiles the key lists.
      expect(fs.statSync(settingsFile()).mode & 0o777).toBe(0o600);
      const file = storedFile();
      expect(file).toMatchObject({ schemaVersion: 2, keys: { anthropic: { apiKey: FAKE_ANTHROPIC_KEY } } });
      expect(file.keys.anthropic.models.map((model: any) => model.id)).toEqual(CLAUDE_MODELS.map(([key]) => key.slice('anthropic.'.length)));
      expect(file.keys.anthropic.models[0]).toMatchObject({
        id: 'claude-sonnet-5-5', line: 'sonnet', lifecycle: 'active', images: true, structuredOutputs: true,
        thinking: { adaptive: true, enabled: false, disabled: false },
      });

      // One model list and exactly one minimal message call verified the key; the new client then made its free
      // one-model probe (its start-up probe and the one Save awaits), and nothing else was generated.
      expect(anthropic.requests.map(request => `${request.method} ${request.path}`)).toEqual(['GET /v1/models', 'POST /v1/messages', 'GET /v1/models', 'GET /v1/models']);
      expect(anthropicPosts()).toHaveLength(1);
      expect(anthropicPosts()[0].rawBody).toBe('{"model":"claude-sonnet-5-5","max_tokens":16,"messages":[{"role":"user","content":"ping"}]}');
      expect(anthropicPosts()[0].auth).toEqual({ style: 'x-api-key', key: FAKE_ANTHROPIC_KEY });
      for (const probe of anthropic.requests.slice(2)) {
        expect(probe.query).toEqual({ limit: ['1'] });
        expect(probe.auth).toEqual({ style: 'x-api-key', key: FAKE_ANTHROPIC_KEY });
      }
    });

    it('rejects a wrong-shape key before any network call, naming the next action', async () => {
      const settings = await saveWith();
      for (const value of ['', 'not-a-key', OPENAI_KEY, DEEPSEEK_KEY, 'sk-ant-short', `${FAKE_ANTHROPIC_KEY}-`.slice(0, 20), 42, null]) {
        const error = await settings.saveApiKey('anthropic', value).catch(e => e);
        expect(error, String(value)).toBeInstanceOf(AiModelSettingsError);
        expect(error, String(value)).toMatchObject({ code: 'invalid_format', httpStatus: 400 });
        expect(error.nextAction, String(value)).toContain('platform.claude.com/settings/keys');
        expect(error.nextAction, String(value)).toContain('sk-ant-');
        expect(error.message).toContain('Anthropic API key');
      }
      expect(anthropic.requests).toHaveLength(0);
      expect(fs.existsSync(settingsFile())).toBe(false);
    });

    it('tells an Admin key apart from a regular key', async () => {
      const settings = await saveWith();
      const error = await settings.saveApiKey('anthropic', ADMIN_KEY).catch(e => e);
      expect(error).toMatchObject({ code: 'invalid_format', message: expect.stringContaining('Admin key') });
      expect(error.nextAction).toContain('regular API key');
      expect(anthropic.requests).toHaveLength(0);
    });

    it('sends an Anthropic key pasted into the OpenAI or DeepSeek card to the Claude card, without a network call', async () => {
      const settings = await saveWith();
      fakes.requests.length = 0;
      for (const [provider, article] of [['openai', 'an OpenAI'], ['deepseek', 'a DeepSeek']] as const) {
        for (const key of [FAKE_ANTHROPIC_KEY, ADMIN_KEY]) {
          const error = await settings.saveApiKey(provider, key).catch(e => e);
          expect(error, `${provider} ${key.slice(0, 12)}`).toMatchObject({
            code: 'invalid_format', message: `That is an Anthropic key, not ${article} key.`, nextAction: 'Paste it into the Anthropic (Claude) card instead.',
          });
        }
      }
      expect(fakes.requests).toHaveLength(0);
      expect(anthropic.requests).toHaveLength(0);
      // Other keys keep their own messages.
      await expect(settings.saveApiKey('openai', 'sk-short')).rejects.toMatchObject({ code: 'invalid_format', nextAction: expect.stringContaining('platform.openai.com') });
    });

    it('maps every D10 answer at Save to its code, changes nothing, and never leaks the key', async () => {
      const sinks = (['log', 'info', 'warn', 'error'] as const).map(method => vi.spyOn(console, method).mockImplementation(() => {}));
      const expected: Record<string, [string, number]> = {
        '401 authentication_error': ['invalid_key', 400],
        '402 billing_error': ['no_credit', 400],
        '400 owner spend limit': ['no_credit', 400],
        '429 tier spend cap': ['no_credit', 400],
        '400 workspace id required': ['workspace_required', 400],
        '400 other': ['rejected', 502],
        '403 permission_error': ['forbidden', 400],
        '404 not_found_error': ['model_unavailable', 400],
        '409 conflict_error': ['rejected', 502],
        '413 request_too_large (Cloudflare page)': ['rejected', 502],
        '429 rate_limit_error': ['rate_limited', 429],
        '529 overloaded_error': ['provider_overloaded', 503],
        '500 api_error': ['rejected', 502],
        '504 timeout_error': ['rejected', 502],
      };
      expect(Object.keys(expected).sort()).toEqual(FAKE_D10_ROWS.map(row => row.name).sort());
      const settings = await saveWith();
      const version = settings.version();
      for (const row of FAKE_D10_ROWS) {
        // The answer arrives on the message call (after a good model list) and, separately, on the list itself.
        for (const path of ['/v1/messages', '/v1/models']) {
          anthropic.respond = request => (request.path === path ? row.answer : undefined);
          const error = await settings.saveApiKey('anthropic', FAKE_ANTHROPIC_KEY).catch(e => e);
          const label = `${row.name} on ${path}`;
          expect(error, label).toBeInstanceOf(AiModelSettingsError);
          const [code, httpStatus] = expected[row.name];
          // A 403/404 on the list is the key's problem, on a generation it names the model: same codes either way.
          expect(error, label).toMatchObject({ code, httpStatus });
          expect(error.message.length, label).toBeGreaterThan(10);
          expect(error.nextAction.length, label).toBeGreaterThan(10);
          expect(`${error.message} ${error.nextAction}`, label).not.toContain(FAKE_ANTHROPIC_KEY);
          expect(`${error.message} ${error.nextAction}`, label).not.toMatch(/cloudflare|<html/i);
        }
      }
      anthropic.respond = undefined;
      expect(fs.existsSync(settingsFile())).toBe(false);
      expect(settings.status().anthropic).toBeUndefined();
      expect(settings.version()).toBe(version);
      expect(connectionIds(settings)).toEqual(['team']);
      for (const sink of sinks) for (const args of sink.mock.calls) expect(args.map(String).join(' ')).not.toContain(FAKE_ANTHROPIC_KEY);
    });

    it('names the owner-facing next action for the cases an owner can fix', async () => {
      const settings = await saveWith();
      const byName = (name: string) => FAKE_D10_ROWS.find(row => row.name === name)!.answer;
      const fail = async (name: string) => {
        anthropic.respond = request => (request.path === '/v1/messages' ? byName(name) : undefined);
        return settings.saveApiKey('anthropic', FAKE_ANTHROPIC_KEY).catch(e => e);
      };
      expect(await fail('401 authentication_error')).toMatchObject({ message: expect.stringContaining('expired, revoked or malformed'), nextAction: expect.stringContaining('platform.claude.com/settings/keys') });
      expect(await fail('402 billing_error')).toMatchObject({ nextAction: expect.stringContaining('platform.claude.com/settings/billing') });
      expect(await fail('400 owner spend limit')).toMatchObject({ message: expect.stringContaining('spend limit you set') });
      expect(await fail('400 workspace id required')).toMatchObject({
        message: 'This key is not tied to one workspace.',
        nextAction: 'Create a key scoped to one workspace (Console → Settings → API keys → Create key, choose a workspace), then save it here.',
      });
      expect(await fail('529 overloaded_error')).toMatchObject({ message: 'Anthropic is temporarily overloaded.' });
    });

    it('reports a dropped connection as unreachable and a key without usable models as no_chat_models', async () => {
      const settings = await saveWith();
      anthropic.dropNext = 1;
      await expect(settings.saveApiKey('anthropic', FAKE_ANTHROPIC_KEY)).rejects.toMatchObject({
        code: 'unreachable', httpStatus: 502, message: expect.stringContaining('api.anthropic.com'),
      });
      anthropic.setModels([{ id: 'claude-old', variant: 'B', lifecycle: 'deprecated' }, { id: 'claude-gone', variant: 'A', lifecycle: 'retired' }]);
      anthropic.requests.length = 0;
      await expect(settings.saveApiKey('anthropic', FAKE_ANTHROPIC_KEY)).rejects.toMatchObject({
        code: 'no_chat_models', nextAction: expect.stringContaining('platform.claude.com'),
      });
      expect(anthropicPosts()).toHaveLength(0);
      expect(fs.existsSync(settingsFile())).toBe(false);
      // A key the server does not know is a 401 at the model list.
      anthropic.setModels([{ id: 'claude-sonnet-5-5', variant: 'A', line: 'sonnet' }]);
      await expect(settings.saveApiKey('anthropic', NO_ACCESS_KEY)).rejects.toMatchObject({ code: 'invalid_key' });
    });

    it('replaces a saved key and removes it, deleting the file when nothing else is stored', async () => {
      const settings = await saveWith();
      await settings.saveApiKey('anthropic', FAKE_ANTHROPIC_KEY);
      const versionAfterSave = settings.version();
      const replaced = await settings.saveApiKey('anthropic', SECOND_KEY);
      expect(replaced.anthropic?.keySuffix).toBe(suffixOf(SECOND_KEY));
      expect(storedFile().keys.anthropic.apiKey).toBe(SECOND_KEY);
      expect(settings.version()).toBeGreaterThan(versionAfterSave);

      const removed = await settings.removeApiKey('anthropic');
      expect(removed.anthropic).toBeUndefined();
      expect(fs.existsSync(settingsFile())).toBe(false);
      expect(settings.version()).toBeGreaterThan(versionAfterSave + 1);
      // Removing again is harmless, and the key can be added back.
      await expect(settings.removeApiKey('anthropic')).resolves.toMatchObject({ state: expect.any(String) });
      expect((await settings.saveApiKey('anthropic', FAKE_ANTHROPIC_KEY)).anthropic?.keySuffix).toBe(suffixOf(FAKE_ANTHROPIC_KEY));
    });

    it('keeps the other keys and roles when the Claude key is removed, and the Claude key when they change', async () => {
      const settings = await saveWith();
      await settings.saveApiKey('openai', OPENAI_KEY);
      await settings.saveApiKey('anthropic', FAKE_ANTHROPIC_KEY);
      await settings.setRole('processing', { modelKey: 'openai.gpt-4o', thinking: 'low' });
      await settings.saveApiKey('deepseek', DEEPSEEK_KEY);
      expect(storedFile().keys.anthropic.apiKey).toBe(FAKE_ANTHROPIC_KEY);
      await settings.removeApiKey('openai');
      expect(storedFile().keys.anthropic.apiKey).toBe(FAKE_ANTHROPIC_KEY);
      await settings.removeApiKey('anthropic');
      expect(storedFile()).toMatchObject({ keys: { deepseek: { apiKey: DEEPSEEK_KEY } }, roles: { processing: { modelKey: 'openai.gpt-4o', thinking: 'low' } } });
      expect(storedFile().keys.anthropic).toBeUndefined();
    });

    it('allows one change at a time across providers', async () => {
      const settings = await saveWith();
      const first = settings.saveApiKey('anthropic', FAKE_ANTHROPIC_KEY);
      await expect(settings.saveApiKey('openai', OPENAI_KEY)).rejects.toMatchObject({ code: 'busy', httpStatus: 409 });
      await expect(settings.removeApiKey('anthropic')).rejects.toMatchObject({ code: 'busy' });
      await first;
    });

    it('adds Claude behind the other connections without changing what was automatic, and lets a role pick a Claude model', async () => {
      const settings = await serviceWithoutTeam({ anthropicEndpoint: anthropic.url });
      await settings.saveApiKey('openai', OPENAI_KEY);
      const snapshot = () => ({
        roles: settings.status().roles,
        defaults: settings.chatModels.catalog()?.defaultKey,
        resolved: settings.chatModels.resolve(undefined)?.key,
      });
      const before = snapshot();
      expect(before.defaults).toBe('openai.gpt-5.6-terra');
      await settings.saveApiKey('anthropic', FAKE_ANTHROPIC_KEY);
      expect(connectionIds(settings)).toEqual(['openai', 'anthropic']);
      expect(snapshot()).toEqual(before);
      expect(settings.status().models.filter(model => model.key.startsWith('anthropic.')).map(model => model.label)).toEqual(CLAUDE_MODELS.map(([, label]) => label));

      // A role can now be pointed at a Claude model, with its own Thinking level, and the choice is stored.
      const status = await settings.setRole('processing', { modelKey: 'anthropic.claude-haiku-5-5', thinking: 'low' });
      expect(status.roles.processing).toMatchObject({
        modelKey: 'anthropic.claude-haiku-5-5', label: 'Claude Haiku 5.5', connectionId: 'anthropic', connectionLabel: 'Anthropic (Claude)', chosen: true, thinking: 'low', images: true,
      });
      expect(status).toMatchObject({ provider: 'anthropic', backgroundModel: 'Claude Haiku 5.5', providerLabel: 'Anthropic (your API key)' });
      expect(storedFile().roles).toEqual({ processing: { modelKey: 'anthropic.claude-haiku-5-5', thinking: 'low' } });
      expect(settings.processing.identity()).toMatchObject({ providerId: 'anthropic', model: 'claude-haiku-5-5', apiMode: 'messages', maxContextTokens: 1_000_000 });
      // Documents stay automatic, and with no team gateway the chat default follows the organizing model (the unchanged D4 rule).
      expect(status.roles.documents).toMatchObject({ modelKey: 'openai.gpt-5.6-terra', chosen: false });
      expect(settings.chatModels.catalog()?.defaultKey).toBe('anthropic.claude-haiku-5-5');

      // The organizing role really runs on Claude: the key in x-api-key, the chosen model, the role's Thinking, no temperature.
      anthropic.requests.length = 0;
      fakes.requests.length = 0;
      const reply = await settings.processing.chatCompletion({ messages: [{ role: 'user', content: 'organize this' }], think: false });
      expect(reply.content).toBe('pong');
      const sent = anthropicPosts()[0];
      expect(sent.auth).toEqual({ style: 'x-api-key', key: FAKE_ANTHROPIC_KEY });
      expect(sent.body.model).toBe('claude-haiku-5-5');
      expect(sent.body.thinking).toMatchObject({ type: 'adaptive' });
      expect(sent.body.output_config).toEqual({ effort: 'low' });
      expect(sent.body).not.toHaveProperty('temperature');
      expect(posts('openai')).toHaveLength(0);
    });

    it('boots with the Claude connection when the only saved key is Claude, after refreshing its saved list', async () => {
      fs.writeFileSync(settingsFile(), JSON.stringify({
        schemaVersion: 2,
        keys: { anthropic: { apiKey: FAKE_ANTHROPIC_KEY, savedAt: '2026-10-13T00:00:00.000Z', verifiedAt: '2026-10-13T00:00:00.000Z', models: [] } },
        roles: {},
      }), { mode: 0o600 });
      // Without launcher credentials the never-set-up team connection is retired, as for any registered keyed connection.
      const bare = await serviceWithoutTeam({ anthropicEndpoint: anthropic.url });
      expect(connectionIds(bare)).toEqual(['anthropic']);
      expect(bare.status()).toMatchObject({ state: 'ready', provider: 'anthropic', backgroundModel: 'Claude Haiku 5.5', healthy: true });
      expect(bare.status().anthropic?.keySuffix).toBe(suffixOf(FAKE_ANTHROPIC_KEY));
      expect(bare.status().connections[0].models.map(model => model.key)).toEqual(CLAUDE_MODELS.map(([key]) => key));
      expect(bare.chatModels.catalog()?.groups).toEqual([{ id: 'anthropic', label: 'Anthropic (Claude)' }]);
      // Organizing starts on the Haiku-line default (design D8); Document writing and the chat default stay on the
      // connection default, the Sonnet-line pick.
      expect(bare.chatModels.catalog()?.defaultKey).toBe('anthropic.claude-sonnet-5-5');
      expect(bare.status().roles.processing).toMatchObject({ modelKey: 'anthropic.claude-haiku-5-5', chosen: false, connectionId: 'anthropic' });
      expect(bare.status().roles.documents).toMatchObject({ modelKey: 'anthropic.claude-sonnet-5-5', chosen: false });
      // The boot refresh read the saved key's list and stored it.
      expect(storedFile().keys.anthropic.models.map((model: any) => model.id)).toContain('claude-sonnet-5-5');
      // With launcher credentials the team gateway stays the default and the order is team first.
      const withTeam = await service({ anthropicEndpoint: anthropic.url });
      expect(connectionIds(withTeam)).toEqual(['team', 'anthropic']);
      expect(withTeam.status()).toMatchObject({ state: 'ready', provider: 'gateway', environmentProviderLabel: 'Team gateway (Amazon Bedrock)' });
      expect(withTeam.chatModels.catalog()?.defaultKey).toBe('team.terra');
    });

    it('registers no connection for a saved Claude key whose list yields no model, and keeps the never-set-up launcher connection', async () => {
      fs.writeFileSync(settingsFile(), JSON.stringify({
        schemaVersion: 2,
        keys: { anthropic: { apiKey: FAKE_ANTHROPIC_KEY, savedAt: 'x', verifiedAt: 'x', models: [] } },
        roles: {},
      }), { mode: 0o600 });
      // The API is unreachable at boot and the saved list is empty: nothing to build a connection on.
      const gone = await startFakeAnthropic();
      const url = gone.url;
      await gone.close();
      const bare = await serviceWithoutTeam({ anthropicEndpoint: url });
      expect(connectionIds(bare)).toEqual(['team']);
      expect(bare.status().state).toBe('not_configured');
      expect(bare.status().anthropic?.keySuffix).toBe(suffixOf(FAKE_ANTHROPIC_KEY));
      expect(bare.chatModels.catalog()?.groups?.map(group => group.id)).toEqual(['team']);
      // Removing the key still clears the file and refreshes open pages.
      const version = bare.version();
      const removed = await bare.removeApiKey('anthropic');
      expect(removed.anthropic).toBeUndefined();
      expect(bare.version()).toBeGreaterThan(version);
      expect(fs.existsSync(settingsFile())).toBe(false);
    });

    it('lets a Claude-only file retire the never-set-up team connection, and a later key of another provider joins it', async () => {
      fs.writeFileSync(settingsFile(), JSON.stringify({
        schemaVersion: 2,
        keys: { anthropic: { apiKey: FAKE_ANTHROPIC_KEY, savedAt: 'x', verifiedAt: 'x', models: [] } },
        roles: {},
      }), { mode: 0o600 });
      const settings = await serviceWithoutTeam({ anthropicEndpoint: anthropic.url });
      expect(connectionIds(settings)).toEqual(['anthropic']);
      const status = await settings.saveApiKey('deepseek', DEEPSEEK_KEY);
      // Automatic order is team, OpenAI, DeepSeek, Claude: DeepSeek now leads the default chain.
      expect(status.connections.map(connection => connection.id)).toEqual(['deepseek', 'anthropic']);
      expect(status.roles.processing).toMatchObject({ modelKey: 'deepseek.deepseek-flash', chosen: false });
      expect(settings.chatModels.catalog()?.defaultKey).toBe('deepseek.deepseek-flash');
      expect(status.anthropic).toBeDefined();
    });

    it('refreshes the saved model list at boot, keeps the saved list when the API is unreachable, and keeps held deprecated models', async () => {
      const first = await saveWith();
      await first.saveApiKey('anthropic', FAKE_ANTHROPIC_KEY);
      first.close();
      const idsOnDisk = () => storedFile().keys.anthropic.models.map((model: any) => model.id);
      expect(idsOnDisk()).toHaveLength(5);

      // A model gets deprecated, a new one appears; the held deprecated model stays, the retired one goes.
      anthropic.setModels([
        { id: 'claude-opus-6', variant: 'A', line: 'opus' },
        { id: 'claude-sonnet-5-5', variant: 'A', line: 'sonnet' },
        { id: 'claude-haiku-4-5-20251001', variant: 'C', line: 'haiku', lifecycle: 'deprecated', retiresAt: '2026-12-01T00:00:00Z' },
        { id: 'claude-opus-4-5-20251101', variant: 'C', line: 'opus', lifecycle: 'deprecated' },
        { id: 'claude-haiku-5-5', variant: 'B', line: 'haiku', lifecycle: 'retired' },
      ]);
      const second = await saveWith();
      // Held across the refresh: both deprecated models were in the previous list.
      expect(idsOnDisk()).toEqual(['claude-opus-6', 'claude-sonnet-5-5', 'claude-haiku-4-5-20251001', 'claude-opus-4-5-20251101']);
      expect(storedFile().keys.anthropic.models[2]).toMatchObject({ lifecycle: 'deprecated', retiresAt: '2026-12-01T00:00:00Z' });
      second.close();

      // Offline at boot: the saved list stays.
      const offlineList = idsOnDisk();
      const unreachable = await startFakeAnthropic();
      const url = unreachable.url;
      await unreachable.close();
      const third = await service({ anthropicEndpoint: url });
      expect(idsOnDisk()).toEqual(offlineList);
      expect(third.status().anthropic).toBeDefined();
      third.close();

      // An empty or unusable answer never wipes the saved list either.
      anthropic.setModels([]);
      const fourth = await saveWith();
      expect(idsOnDisk()).toEqual(offlineList);
      fourth.close();
      anthropic.respond = () => ({ status: 401, body: fakeErrorBody('authentication_error', 'invalid x-api-key') });
      const fifth = await saveWith();
      expect(idsOnDisk()).toEqual(offlineList);
      expect(fifth.status().anthropic?.keySuffix).toBe(suffixOf(FAKE_ANTHROPIC_KEY));
    });

    it('words a Save-time 403 on the model list at the key, and on the generation at the model; both are the same code', async () => {
      const settings = await saveWith();
      const body = fakeErrorBody('permission_error', 'Your API key does not have permission to use the specified resource.');
      anthropic.respond = request => (request.path === '/v1/models' ? { status: 403, body } : undefined);
      const onList = await settings.saveApiKey('anthropic', FAKE_ANTHROPIC_KEY).catch(e => e);
      expect(onList).toMatchObject({ code: 'forbidden', httpStatus: 400, message: 'This key is not allowed to list Claude models.' });
      expect(onList.nextAction).toContain('permissions and workspace');
      anthropic.respond = request => (request.path === '/v1/messages' ? { status: 403, body } : undefined);
      const onGeneration = await settings.saveApiKey('anthropic', FAKE_ANTHROPIC_KEY).catch(e => e);
      expect(onGeneration).toMatchObject({ code: 'forbidden', httpStatus: 400, message: 'This key is not allowed to use that Claude model.' });
      expect(fs.existsSync(settingsFile())).toBe(false);
    });
    it('gives the boot model-list refresh ONE deadline for all pages, and keeps the saved list when it expires', async () => {
      const models = Array.from({ length: 9 }, (_, index) => ({ id: `claude-model-${String(index).padStart(3, '0')}`, variant: 'A' as const, line: 'sonnet' }));
      const paged = await startFakeAnthropic({ models, pageSize: 1 });
      try {
        const saved = { apiKey: FAKE_ANTHROPIC_KEY, savedAt: '2026-10-13T00:00:00.000Z', verifiedAt: '2026-10-13T00:00:00.000Z', models: [] };
        fs.writeFileSync(settingsFile(), JSON.stringify({ schemaVersion: 2, keys: { anthropic: saved }, roles: {} }), { mode: 0o600 });
        let pageRequests = 0;
        const slow = ((input: unknown, init?: RequestInit) => new Promise<Response>((resolve, reject) => {
          if (String(input).startsWith(paged.url)) pageRequests += 1;
          const timer = setTimeout(() => resolve(fetch(input as string, init)), 150);
          init?.signal?.addEventListener('abort', () => { clearTimeout(timer); reject(init.signal!.reason); });
        })) as typeof fetch;
        const began = Date.now();
        const settings = await createAiModelSettingsService({
          envProvider,
          env: { BOTBOY_INFERENCE_HEALTH_INTERVAL_MS: '0' },
          privateRoot,
          environmentCredentialsPresent: true,
          openAiEndpoint: fakes.openai,
          deepSeekEndpoint: fakes.deepseek,
          anthropicEndpoint: paged.url,
          bootModelListTimeoutMs: 300,
          fetchImpl: slow,
        });
        closers.push(settings);
        // Five pages of 150 ms would take 750 ms; the shared 300 ms deadline stops the listing after two.
        expect(Date.now() - began).toBeLessThan(2_000);
        expect(pageRequests).toBeLessThanOrEqual(3);
        expect(storedFile().keys.anthropic.models).toEqual([]);
        expect(settings.status().anthropic?.keySuffix).toBe(suffixOf(FAKE_ANTHROPIC_KEY));
      } finally {
        await paged.close();
      }
    });
    it('passes unknown keys, role names, role fields and top-level fields through every write unchanged', async () => {
      const future = {
        futureTopLevel: { note: 'kept', list: [1, 2, 3] },
        keys: {
          gemini: { apiKey: 'gm-future-0000000000000000', models: ['g1'], extra: { deep: true } },
          openai: { apiKey: OPENAI_KEY, savedAt: '2026-09-30T00:00:00.000Z', verifiedAt: '2026-09-30T00:00:00.000Z', models: ['gpt-5.6-terra', 'gpt-4o'] },
        },
        roles: {
          vision: { modelKey: 'gemini.g1', temperature: 0.2 },
          processing: { thinking: 'low', futureField: { a: [1, 2] }, note: 'x' },
        },
      };
      fs.writeFileSync(settingsFile(), JSON.stringify({ schemaVersion: 2, ...future }), { mode: 0o600 });
      const settings = await saveWith();

      const unknownParts = () => {
        const file = storedFile();
        return {
          top: file.futureTopLevel,
          gemini: file.keys.gemini,
          vision: file.roles.vision,
          processingExtras: { futureField: file.roles.processing?.futureField, note: file.roles.processing?.note },
        };
      };
      const expected = {
        top: future.futureTopLevel,
        gemini: future.keys.gemini,
        vision: future.roles.vision,
        processingExtras: { futureField: future.roles.processing.futureField, note: future.roles.processing.note },
      };
      expect(unknownParts()).toEqual(expected);

      await settings.saveApiKey('anthropic', FAKE_ANTHROPIC_KEY);
      expect(unknownParts()).toEqual(expected);
      await settings.setRole('documents', { thinking: 'high' });
      expect(unknownParts()).toEqual(expected);
      await settings.saveApiKey('deepseek', DEEPSEEK_KEY);
      await settings.removeApiKey('deepseek');
      expect(unknownParts()).toEqual(expected);
      // A role keeps its unknown fields while its known ones change or disappear.
      await settings.setRole('processing', { thinking: 'off' });
      expect(storedFile().roles.processing).toEqual({ futureField: { a: [1, 2] }, note: 'x' });
      await settings.setRole('processing', { modelKey: 'openai.gpt-4o', thinking: 'max' });
      expect(storedFile().roles.processing).toEqual({ futureField: { a: [1, 2] }, note: 'x', modelKey: 'openai.gpt-4o', thinking: 'max' });
      await settings.setRole('processing', { modelKey: null, thinking: 'off' });
      expect(storedFile().roles.processing).toEqual({ futureField: { a: [1, 2] }, note: 'x' });
      // Removing every key this build knows keeps the file for the ones it does not.
      await settings.removeApiKey('anthropic');
      await settings.removeApiKey('openai');
      await settings.setRole('documents', { thinking: 'off' });
      expect(fs.existsSync(settingsFile())).toBe(true);
      expect(storedFile()).toEqual({
        schemaVersion: 2,
        futureTopLevel: future.futureTopLevel,
        keys: { gemini: future.keys.gemini },
        roles: { vision: future.roles.vision, processing: { futureField: { a: [1, 2] }, note: 'x' } },
      });
    });

    it('keeps a file that holds only fields this build does not know, and deletes it once nothing at all remains', async () => {
      const onlyUnknown: [string, Record<string, unknown>][] = [
        ['a provider key', { schemaVersion: 2, keys: { gemini: { apiKey: 'gm-future-0000000000000000' } }, roles: {} }],
        ['a role name', { schemaVersion: 2, keys: {}, roles: { vision: { modelKey: 'gemini.g1' } } }],
        ['a top-level field', { schemaVersion: 2, keys: {}, roles: {}, futureTopLevel: { note: 'kept' } }],
      ];
      for (const [label, file] of onlyUnknown) {
        fs.writeFileSync(settingsFile(), JSON.stringify(file), { mode: 0o600 });
        const settings = await saveWith();
        await settings.saveApiKey('anthropic', FAKE_ANTHROPIC_KEY);
        await settings.removeApiKey('anthropic');
        expect(fs.existsSync(settingsFile()), label).toBe(true);
        expect(storedFile(), label).toEqual(file);
        settings.close();
      }
      // Nothing known and nothing unknown: the file goes away, as before.
      fs.writeFileSync(settingsFile(), JSON.stringify({ schemaVersion: 2, keys: {}, roles: {} }), { mode: 0o600 });
      const empty = await saveWith();
      await empty.saveApiKey('anthropic', FAKE_ANTHROPIC_KEY);
      await empty.removeApiKey('anthropic');
      expect(fs.existsSync(settingsFile())).toBe(false);
    });

    it('treats a __proto__ entry in the file as plain data', async () => {
      fs.writeFileSync(settingsFile(), '{"schemaVersion":2,"keys":{"__proto__":{"polluted":true},"deepseek":null},"roles":{"__proto__":{"x":1}},"__proto__":{"y":2}}', { mode: 0o600 });
      const settings = await saveWith();
      await settings.saveApiKey('anthropic', FAKE_ANTHROPIC_KEY);
      expect(({} as any).polluted).toBeUndefined();
      expect(({} as any).x).toBeUndefined();
      expect(({} as any).y).toBeUndefined();
      const text = fs.readFileSync(settingsFile(), 'utf8');
      expect(text).toContain('"__proto__"');
      expect(JSON.parse(text).keys.anthropic.apiKey).toBe(FAKE_ANTHROPIC_KEY);
    });

    it('applies a stored Claude role choice once the model is listed, and keeps it unavailable when it is not', async () => {
      fs.writeFileSync(settingsFile(), JSON.stringify({
        schemaVersion: 2,
        keys: { anthropic: { apiKey: FAKE_ANTHROPIC_KEY, savedAt: 'x', verifiedAt: 'x', models: [] } },
        roles: {
          processing: { modelKey: 'anthropic.claude-haiku-5-5', thinking: 'low' },
          documents: { modelKey: 'anthropic.claude-no-longer-listed' },
        },
      }), { mode: 0o600 });
      const settings = await saveWith();
      expect(settings.status().roles.processing).toMatchObject({ modelKey: 'anthropic.claude-haiku-5-5', connectionId: 'anthropic', chosen: true, thinking: 'low' });
      expect(settings.status().roles.documents).toMatchObject({ modelKey: 'team.terra', chosen: false, unavailableChoice: 'anthropic.claude-no-longer-listed' });
      // The unavailable choice stays stored; removing the key leaves both choices in place but unavailable.
      await settings.removeApiKey('anthropic');
      expect(storedFile().roles).toEqual({
        processing: { modelKey: 'anthropic.claude-haiku-5-5', thinking: 'low' },
        documents: { modelKey: 'anthropic.claude-no-longer-listed' },
      });
      expect(settings.status().roles.processing).toMatchObject({ modelKey: 'team.terra', chosen: false, unavailableChoice: 'anthropic.claude-haiku-5-5', thinking: 'low' });
      await settings.saveApiKey('openai', OPENAI_KEY);
      expect(storedFile().roles.processing).toEqual({ modelKey: 'anthropic.claude-haiku-5-5', thinking: 'low' });
    });

    // Owner Gate C step 1: the picker has three groups, in this order, and Remove key / saving again moves only Claude's.
    it('three picker groups: Team gateway, OpenAI and Anthropic (Claude), in that order; Remove key drops only the Claude group and saving it again restores it', async () => {
      const settings = await saveWith();
      await settings.saveApiKey('openai', OPENAI_KEY);
      await settings.saveApiKey('anthropic', FAKE_ANTHROPIC_KEY);
      const groups = () => settings.chatModels.catalog()!.groups;
      const THREE = [{ id: 'team', label: 'Team gateway' }, { id: 'openai', label: 'OpenAI' }, { id: 'anthropic', label: 'Anthropic (Claude)' }];
      expect(groups()).toEqual(THREE);
      const catalog = settings.chatModels.catalog()!;
      for (const group of THREE) {
        const keys = catalog.models.filter(model => model.group === group.id).map(model => model.key);
        expect(keys.length, group.id).toBeGreaterThan(0);
        expect(keys.every(key => key.startsWith(`${group.id}.`)), group.id).toBe(true);
      }
      expect(catalog.models.every(model => THREE.some(group => group.id === model.group))).toBe(true);
      expect(catalog.defaultKey).toBe('team.terra');
      const events: string[] = [];
      settings.chatModels.onChange(event => events.push(event.connectionId));
      await settings.removeApiKey('anthropic');
      expect(groups()).toEqual(THREE.slice(0, 2));
      expect(settings.chatModels.resolve('anthropic.claude-sonnet-5-5')).toBeNull();
      expect(settings.chatModels.resolve('openai.gpt-4o')).not.toBeNull();
      // Only the Claude connection's turns stop; the other two connections are untouched.
      expect(events).toEqual(['anthropic']);
      await settings.saveApiKey('anthropic', FAKE_ANTHROPIC_KEY);
      expect(groups()).toEqual(THREE);
      expect(settings.chatModels.resolve('anthropic.claude-sonnet-5-5')).toMatchObject({ connectionId: 'anthropic' });
    });

    it('keeps the chat default and Organizing exactly as the pins say, whether or not a Claude key is saved', async () => {
      const settings = await serviceWithoutTeam({ anthropicEndpoint: anthropic.url });
      await settings.saveApiKey('openai', OPENAI_KEY);
      await settings.saveApiKey('deepseek', DEEPSEEK_KEY);
      await settings.setRole('processing', { modelKey: 'deepseek.deepseek-v4-pro' });
      const defaults = () => [settings.chatModels.catalog()?.defaultKey, settings.chatModels.resolve(undefined)?.key];
      expect(defaults()).toEqual(['deepseek.deepseek-v4-pro', 'deepseek.deepseek-v4-pro']);
      await settings.saveApiKey('anthropic', FAKE_ANTHROPIC_KEY);
      expect(defaults()).toEqual(['deepseek.deepseek-v4-pro', 'deepseek.deepseek-v4-pro']);
      expect(settings.status().roles.processing).toMatchObject({ modelKey: 'deepseek.deepseek-v4-pro', chosen: true });
      await settings.removeApiKey('anthropic');
      expect(defaults()).toEqual(['deepseek.deepseek-v4-pro', 'deepseek.deepseek-v4-pro']);
    });

    // D8 (slice B): the chat default is the team default when configured; otherwise an explicit Organizing choice
    // keeps today's rule, and Automatic resolves through the Organizing connection's own default model.
    describe('chat default model with Claude (D8)', () => {
      const chatDefaults = (settings: Awaited<ReturnType<typeof service>>) => ({
        catalog: settings.chatModels.catalog()?.defaultKey,
        flagged: settings.chatModels.catalog()?.models.filter(model => model.isDefault).map(model => model.key),
        undefinedKey: settings.chatModels.resolve(undefined)?.key,
        defaultWord: settings.chatModels.resolve('default')?.key,
      });
      const only = (key: string) => ({ catalog: key, flagged: [key], undefinedKey: key, defaultWord: key });

      it('Claude-only: Automatic chats on the connection default, an explicit Claude Organizing choice is the chat default, and Automatic returns to the default', async () => {
        const settings = await serviceWithoutTeam({ anthropicEndpoint: anthropic.url });
        await settings.saveApiKey('anthropic', FAKE_ANTHROPIC_KEY);
        // The Organizing role runs the Haiku-line model on its own, yet the chat default is the Sonnet-line key, in the
        // catalog and for a message that names no model: the role default never leaks into chat.
        expect(settings.status().roles.processing).toMatchObject({ modelKey: 'anthropic.claude-haiku-5-5', chosen: false });
        expect(chatDefaults(settings)).toEqual(only('anthropic.claude-sonnet-5-5'));
        await settings.setRole('processing', { modelKey: 'anthropic.claude-haiku-5-5' });
        expect(settings.status().roles.processing).toMatchObject({ modelKey: 'anthropic.claude-haiku-5-5', chosen: true });
        expect(chatDefaults(settings)).toEqual(only('anthropic.claude-haiku-5-5'));
        await settings.setRole('processing', { modelKey: 'anthropic.claude-opus-4-5-20251101' });
        expect(chatDefaults(settings)).toEqual(only('anthropic.claude-opus-4-5-20251101'));
        await settings.setRole('processing', { modelKey: null });
        expect(settings.status().roles.processing.chosen).toBe(false);
        expect(chatDefaults(settings)).toEqual(only('anthropic.claude-sonnet-5-5'));
      });

      it('stays the team default while the team connection is configured, whatever Claude is set to', async () => {
        const settings = await service({ anthropicEndpoint: anthropic.url });
        await settings.saveApiKey('anthropic', FAKE_ANTHROPIC_KEY);
        expect(chatDefaults(settings)).toEqual(only('team.terra'));
        await settings.setRole('processing', { modelKey: 'anthropic.claude-haiku-5-5' });
        expect(chatDefaults(settings)).toEqual(only('team.terra'));
      });

      it('follows an explicit Organizing choice of another provider on top of Claude, and drops back to the Claude default when that model disappears', async () => {
        const settings = await serviceWithoutTeam({ anthropicEndpoint: anthropic.url });
        await settings.saveApiKey('anthropic', FAKE_ANTHROPIC_KEY);
        await settings.saveApiKey('openai', OPENAI_KEY);
        // OpenAI comes first in the default chain, so Automatic chats on the OpenAI default.
        expect(chatDefaults(settings)).toEqual(only('openai.gpt-5.6-terra'));
        await settings.setRole('processing', { modelKey: 'anthropic.claude-haiku-5-5' });
        expect(chatDefaults(settings)).toEqual(only('anthropic.claude-haiku-5-5'));
        await settings.removeApiKey('anthropic');
        expect(settings.status().roles.processing).toMatchObject({ modelKey: 'openai.gpt-5.6-terra', chosen: false, unavailableChoice: 'anthropic.claude-haiku-5-5' });
        expect(chatDefaults(settings)).toEqual(only('openai.gpt-5.6-terra'));
      });
    });

    // Design D5: how Thinking Off behaves is derived per thinking profile and shown on Claude rows only.
    describe('thinkingOff on rows, role status and the chat catalog (D5)', () => {
      // The fake list: Sonnet 5.5 and Opus 5.5 are always-on (A), Haiku 5.5 is switchable (B), the 4.5 models are extended-only (C).
      const EXPECTED: [string, string][] = [
        ['anthropic.claude-sonnet-5-5', 'lowest_effort'],
        ['anthropic.claude-haiku-5-5', 'native_without_tools'],
        ['anthropic.claude-opus-5-5', 'lowest_effort'],
        ['anthropic.claude-opus-4-5-20251101', 'native'],
        ['anthropic.claude-haiku-4-5-20251001', 'native'],
      ];

      it('puts thinkingOff on every Claude model row of the status and the chat catalog, and on no other provider\'s row', async () => {
        const settings = await saveWith();
        await settings.saveApiKey('openai', OPENAI_KEY);
        await settings.saveApiKey('deepseek', DEEPSEEK_KEY);
        const status = await settings.saveApiKey('anthropic', FAKE_ANTHROPIC_KEY);
        const claudeRows = status.connections.find(connection => connection.id === 'anthropic')!.models;
        expect(claudeRows.map(model => [model.key, model.thinkingOff])).toEqual(EXPECTED);
        for (const connection of status.connections.filter(entry => entry.id !== 'anthropic')) {
          for (const model of connection.models) expect(model, `${connection.id}: ${model.key}`).not.toHaveProperty('thinkingOff');
        }
        const catalog = settings.chatModels.catalog()!;
        expect(catalog.models.filter(model => model.group === 'anthropic').map(model => [model.key, model.thinkingOff])).toEqual(EXPECTED);
        for (const model of catalog.models.filter(entry => entry.group !== 'anthropic')) expect(model, model.key).not.toHaveProperty('thinkingOff');
        // The field is a closed word: nothing about routes, endpoints or keys comes with it.
        expect(JSON.stringify(catalog)).not.toMatch(/api\.anthropic|127\.0\.0\.1|x-api-key|sk-ant|route/);
      });

      it('puts thinkingOff on the role status of the model serving the role, following the model, and on none for other providers', async () => {
        const settings = await serviceWithoutTeam({ anthropicEndpoint: anthropic.url });
        await settings.saveApiKey('openai', OPENAI_KEY);
        expect(settings.status().roles.processing).not.toHaveProperty('thinkingOff');
        await settings.saveApiKey('anthropic', FAKE_ANTHROPIC_KEY);
        // OpenAI is first in the chain, so Claude serves no role yet.
        expect(settings.status().roles.processing).not.toHaveProperty('thinkingOff');
        let status = await settings.setRole('processing', { modelKey: 'anthropic.claude-haiku-5-5' });
        expect(status.roles.processing).toMatchObject({ modelKey: 'anthropic.claude-haiku-5-5', thinkingOff: 'native_without_tools' });
        status = await settings.setRole('processing', { modelKey: 'anthropic.claude-opus-4-5-20251101' });
        expect(status.roles.processing.thinkingOff).toBe('native');
        status = await settings.setRole('documents', { modelKey: 'anthropic.claude-sonnet-5-5' });
        expect(status.roles.documents.thinkingOff).toBe('lowest_effort');
        // Back to OpenAI: the field disappears with the model.
        status = await settings.setRole('processing', { modelKey: null });
        expect(status.roles.processing).not.toHaveProperty('thinkingOff');
        // A Claude-only setup serves Organizing on the Haiku-line default (switchable) and Document writing on Sonnet (always-on).
        await settings.removeApiKey('openai');
        expect(settings.status().roles.processing).toMatchObject({ modelKey: 'anthropic.claude-haiku-5-5', thinkingOff: 'native_without_tools' });
        expect(settings.status().roles.documents).toMatchObject({ modelKey: 'anthropic.claude-sonnet-5-5', thinkingOff: 'lowest_effort' });
      });

      it('reads a model with no thinking control as unavailable and a model with unknown capabilities the same way', async () => {
        anthropic.setModels([
          { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5', line: 'sonnet', variant: 'A' },
          { id: 'claude-3-haiku-20240307', name: 'Claude Haiku 3', line: 'haiku', variant: 'D', maxInputTokens: 200_000, maxTokens: 4_096 },
        ]);
        const settings = await saveWith();
        const status = await settings.saveApiKey('anthropic', FAKE_ANTHROPIC_KEY);
        const rows = status.connections.find(connection => connection.id === 'anthropic')!.models;
        expect(rows.map(model => [model.key, model.thinkingOff])).toEqual([
          ['anthropic.claude-sonnet-5-5', 'lowest_effort'],
          ['anthropic.claude-3-haiku-20240307', 'unavailable'],
        ]);
      });
    });

    // Design D8: Organizing starts on the newest active Haiku-line model that reads images and takes structured output
    // (background work runs on every captured item); Document writing, key verification and chat stay on the Sonnet line.
    describe('role defaults on Claude (D8)', () => {
      const [SONNET, HAIKU_55, , , HAIKU_45] = FAKE_DEFAULT_MODELS;
      const roles = (settings: Awaited<ReturnType<typeof service>>) => ({
        processing: settings.status().roles.processing.modelKey,
        documents: settings.status().roles.documents.modelKey,
      });

      it('runs Organizing on the Haiku line and Document writing on the Sonnet line, on the wire too, and keeps the Save-time check on the connection default', async () => {
        const settings = await serviceWithoutTeam({ anthropicEndpoint: anthropic.url });
        await settings.saveApiKey('anthropic', FAKE_ANTHROPIC_KEY);
        expect(anthropicPosts().map(request => request.body.model)).toEqual(['claude-sonnet-5-5']); // verification
        expect(settings.status().roles.processing).toMatchObject({ modelKey: 'anthropic.claude-haiku-5-5', label: 'Claude Haiku 5.5', connectionId: 'anthropic', chosen: false, images: true });
        expect(settings.status().roles.documents).toMatchObject({ modelKey: 'anthropic.claude-sonnet-5-5', label: 'Claude Sonnet 5.5', chosen: false });
        expect(settings.status()).toMatchObject({ provider: 'anthropic', backgroundModel: 'Claude Haiku 5.5' });
        expect(settings.processing.identity()).toMatchObject({ providerId: 'anthropic', model: 'claude-haiku-5-5', apiMode: 'messages' });
        expect(settings.documents.identity()).toMatchObject({ providerId: 'anthropic', model: 'claude-sonnet-5-5', apiMode: 'messages' });

        anthropic.requests.length = 0;
        await settings.processing.chatCompletion({ messages: [{ role: 'user', content: 'organize' }] });
        await settings.documents.chatCompletion({ messages: [{ role: 'user', content: 'write' }] });
        await settings.chatModels.resolve(undefined)!.client.chatCompletion({ messages: [{ role: 'user', content: 'chat' }] });
        expect(anthropicPosts().map(request => request.body.model)).toEqual(['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-sonnet-5-5']);
        for (const post of anthropicPosts()) expect(post.body).not.toHaveProperty('temperature');
      });

      it('lets an explicit choice win, returns to the role default on Automatic, and leaves Document writing its own role', async () => {
        const settings = await serviceWithoutTeam({ anthropicEndpoint: anthropic.url });
        await settings.saveApiKey('anthropic', FAKE_ANTHROPIC_KEY);
        await settings.setRole('processing', { modelKey: 'anthropic.claude-sonnet-5-5' });
        expect(settings.status().roles.processing).toMatchObject({ modelKey: 'anthropic.claude-sonnet-5-5', chosen: true });
        await settings.setRole('processing', { modelKey: 'anthropic.claude-opus-5-5' });
        expect(roles(settings)).toEqual({ processing: 'anthropic.claude-opus-5-5', documents: 'anthropic.claude-sonnet-5-5' });
        await settings.setRole('processing', { modelKey: null });
        expect(settings.status().roles.processing).toMatchObject({ modelKey: 'anthropic.claude-haiku-5-5', chosen: false });
        // Document writing can be pointed at the Haiku line by choice; Automatic is the Sonnet line.
        await settings.setRole('documents', { modelKey: 'anthropic.claude-haiku-5-5' });
        expect(roles(settings)).toEqual({ processing: 'anthropic.claude-haiku-5-5', documents: 'anthropic.claude-haiku-5-5' });
        await settings.setRole('documents', { modelKey: null });
        expect(roles(settings)).toEqual({ processing: 'anthropic.claude-haiku-5-5', documents: 'anthropic.claude-sonnet-5-5' });
        // Each role keeps its own Thinking level whatever its model.
        const status = await settings.setRole('processing', { thinking: 'low' });
        expect(status.roles.processing).toMatchObject({ modelKey: 'anthropic.claude-haiku-5-5', thinking: 'low', chosen: false });
        expect(status.roles.documents).toMatchObject({ thinking: 'off' });
        expect(storedFile().roles).toEqual({ processing: { thinking: 'low' } });
      });

      it('falls back to the connection default when no Haiku-line model reads images and takes structured output', async () => {
        for (const haiku of [
          { ...HAIKU_55, images: false },
          { ...HAIKU_55, structuredOutputs: false },
          { ...HAIKU_55, lifecycle: 'deprecated' as const },
          { ...HAIKU_55, line: null },
        ]) {
          anthropic.setModels([SONNET, haiku]);
          const settings = await serviceWithoutTeam({ anthropicEndpoint: anthropic.url });
          await settings.saveApiKey('anthropic', FAKE_ANTHROPIC_KEY);
          expect(roles(settings), JSON.stringify(haiku)).toEqual({ processing: 'anthropic.claude-sonnet-5-5', documents: 'anthropic.claude-sonnet-5-5' });
          settings.close();
          fs.rmSync(settingsFile(), { force: true });
        }
        // A key that lists no Haiku line at all behaves the same.
        anthropic.setModels([SONNET]);
        const settings = await serviceWithoutTeam({ anthropicEndpoint: anthropic.url });
        await settings.saveApiKey('anthropic', FAKE_ANTHROPIC_KEY);
        expect(roles(settings)).toEqual({ processing: 'anthropic.claude-sonnet-5-5', documents: 'anthropic.claude-sonnet-5-5' });
      });

      it('follows the key\'s list: the newest eligible Haiku wins, an older one serves when the newest is gone, and boot re-reads the list', async () => {
        const first = await serviceWithoutTeam({ anthropicEndpoint: anthropic.url });
        await first.saveApiKey('anthropic', FAKE_ANTHROPIC_KEY);
        expect(roles(first).processing).toBe('anthropic.claude-haiku-5-5');
        first.close();
        // The key's list changes while BotBoy is closed: Haiku 5.5 is gone, Haiku 4.5 (extended-only) remains.
        anthropic.setModels([SONNET, HAIKU_45]);
        const second = await serviceWithoutTeam({ anthropicEndpoint: anthropic.url });
        expect(roles(second)).toEqual({ processing: 'anthropic.claude-haiku-4-5-20251001', documents: 'anthropic.claude-sonnet-5-5' });
        expect(second.status().roles.processing).toMatchObject({ label: 'Claude Haiku 4.5', chosen: false });
      });

      it('leaves team, OpenAI and DeepSeek Automatic roles exactly on their connection defaults, with or without Claude beside them', async () => {
        const settings = await serviceWithoutTeam({ anthropicEndpoint: anthropic.url });
        await settings.saveApiKey('openai', OPENAI_KEY);
        await settings.saveApiKey('deepseek', DEEPSEEK_KEY);
        const before = roles(settings);
        expect(before).toEqual({ processing: 'openai.gpt-5.6-terra', documents: 'openai.gpt-5.6-terra' });
        await settings.saveApiKey('anthropic', FAKE_ANTHROPIC_KEY);
        expect(roles(settings)).toEqual(before); // Claude is last in the chain, so its Haiku default stays unused
        await settings.removeApiKey('openai');
        await settings.removeApiKey('deepseek');
        expect(roles(settings)).toEqual({ processing: 'anthropic.claude-haiku-5-5', documents: 'anthropic.claude-sonnet-5-5' });
      });
    });

    // Design D3/D10 and slice B item 6: a Claude Organizing or Document writing call is accounted like any other, and
    // its receipt says the data goes to an external provider whatever endpoint it is reached through.
    describe('usage rows and locality through the Claude roles', () => {
      const usageRows = () => storage.getDb().prepare(
        `SELECT provider, api_mode, model, workload, status, stream, http_status, input_tokens, output_tokens, total_tokens,
                cache_read_tokens, cache_write_tokens, reasoning_tokens
         FROM llm_usage_attempts WHERE provider = 'anthropic' ORDER BY rowid`,
      ).all() as any[];
      const reported = (thinking: number) => ({
        content: [{ type: 'thinking' as const, thinking: 'plan' }, { type: 'text' as const, text: 'done' }],
        usage: { input_tokens: 100, cache_creation_input_tokens: 20, cache_read_input_tokens: 300, output_tokens: 1 },
        finalUsage: { output_tokens: 50, output_tokens_details: { thinking_tokens: thinking } },
      });

      it('writes anthropic / messages rows with cache and thinking tokens for an Organizing call and a Document writing call, each on its own model', async () => {
        const settings = await serviceWithoutTeam({ anthropicEndpoint: anthropic.url, usage: true });
        await settings.saveApiKey('anthropic', FAKE_ANTHROPIC_KEY);
        await settings.setRole('processing', { thinking: 'low' });
        await settings.setRole('documents', { thinking: 'low' });
        expect(usageRows()).toEqual([]); // the Save-time check and the health probes record nothing
        anthropic.reply = () => reported(30);

        await settings.processing.chatCompletion({ messages: [{ role: 'user', content: 'organize' }], usageContext: { workload: 'background' } });
        await settings.documents.chatCompletion({ messages: [{ role: 'user', content: 'write the document' }], usageContext: { workload: 'interactive' } });

        const common = { provider: 'anthropic', api_mode: 'messages', stream: 1, status: 'completed', http_status: 200 };
        const tokens = { input_tokens: 420, output_tokens: 50, total_tokens: 470, cache_read_tokens: 300, cache_write_tokens: 20, reasoning_tokens: 30 };
        expect(usageRows()).toEqual([
          { ...common, model: 'claude-haiku-5-5', workload: 'background', ...tokens },
          { ...common, model: 'claude-sonnet-5-5', workload: 'interactive', ...tokens },
        ]);
        // The Settings → Diagnostics table groups by model: both Claude models appear with the cache and thinking columns.
        const daily = createLlmUsageService(storage.getDb(), { primaryProvider: 'bedrock' }).dailyUsage({ days: 1, timeZone: 'UTC' });
        const models = daily.days.flatMap(day => day.models);
        expect(models.map(model => model.model).sort()).toEqual(['claude-haiku-5-5', 'claude-sonnet-5-5']);
        for (const model of models) {
          expect(model).toMatchObject({ attempts: 1, reportedAttempts: 1, inputTokens: 420, outputTokens: 50, cacheReadTokens: 300, cacheWriteTokens: 20, reasoningTokens: 30 });
        }
        expect(models.find(model => model.model === 'claude-haiku-5-5')).toMatchObject({ backgroundAttempts: 1, interactiveAttempts: 0 });
        expect(models.find(model => model.model === 'claude-sonnet-5-5')).toMatchObject({ backgroundAttempts: 0, interactiveAttempts: 1 });
      });

      it('records a failed role call with its HTTP class and the real cause, never the key, and a 429 resend as its own row', async () => {
        const settings = await serviceWithoutTeam({ anthropicEndpoint: anthropic.url, usage: true });
        await settings.saveApiKey('anthropic', FAKE_ANTHROPIC_KEY);
        let calls = 0;
        anthropic.respond = request => (request.path === '/v1/messages' && ++calls === 1
          ? { status: 429, headers: { 'retry-after': '0' }, body: fakeErrorBody('rate_limit_error', 'slow down') }
          : undefined);
        await settings.processing.chatCompletion({ messages: [{ role: 'user', content: 'organize' }], usageContext: { workload: 'background' } });
        const rows = usageRows();
        expect(rows.map(row => [row.model, row.status, row.http_status])).toEqual([['claude-haiku-5-5', 'failed', 429], ['claude-haiku-5-5', 'completed', 200]]);
        const everything = JSON.stringify(storage.getDb().prepare('SELECT * FROM llm_usage_attempts').all());
        expect(everything).not.toContain(FAKE_ANTHROPIC_KEY);
      });

      it('receipts a Claude Organizing and Document writing call as an external provider, even through a loopback endpoint, and Claude only', async () => {
        const settings = await serviceWithoutTeam({ anthropicEndpoint: anthropic.url, usage: true });
        await settings.saveApiKey('anthropic', FAKE_ANTHROPIC_KEY);
        expect(anthropic.url).toMatch(/^http:\/\/127\.0\.0\.1:/);
        for (const role of [settings.processing, settings.documents]) {
          const operation = role.getModelOperation!();
          expect(operation!.provider).toMatchObject({ id: 'anthropic', apiMode: 'messages' });
          // The same call the Data Room import and its approval receipt make.
          expect(analyticsImportProviderReceipt(operation!.provider)).toEqual({
            providerLocality: 'external_remote',
            endpointSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
          });
        }
        expect(settings.processing.getModelOperation!()!.provider.model).toBe('claude-haiku-5-5');
        expect(settings.documents.getModelOperation!()!.provider.model).toBe('claude-sonnet-5-5');
        // A loopback OpenAI-shaped endpoint of the team gateway is still device-local; only the keyed providers are forced external.
        expect(analyticsImportProviderReceipt({ id: 'gateway', endpoint: 'http://127.0.0.1:9/v1' }).providerLocality).toBe('device_local');
        expect(analyticsImportProviderReceipt({ id: 'anthropic', endpoint: 'http://127.0.0.1:9' }).providerLocality).toBe('external_remote');
      });
    });

    it('serves a chat turn on the picked Claude model with its plain id and records the attempt as an anthropic messages row', async () => {
      const settings = await saveWith();
      await settings.saveApiKey('anthropic', FAKE_ANTHROPIC_KEY);
      anthropic.requests.length = 0;
      const binding = settings.chatModels.resolve('anthropic.claude-opus-4-5-20251101')!;
      expect(binding.operation).toMatchObject({
        connectionId: 'anthropic', modelKey: 'anthropic.claude-opus-4-5-20251101', label: 'Claude Opus 4.5',
        provider: { id: 'anthropic', apiMode: 'messages', model: 'claude-opus-4-5-20251101' },
        capabilities: { images: true, contextWindow: 200_000, maxOutputTokens: 64_000, thinkingOff: 'native' },
      });
      expect(binding.client.getContextBudgetTokens?.()).toBe(100_000);
      expect((await binding.client.chatCompletion({ messages: [{ role: 'user', content: 'hi' }] })).content).toBe('pong');
      expect(anthropicPosts()).toHaveLength(1);
      expect(anthropicPosts()[0]).toMatchObject({ auth: { style: 'x-api-key', key: FAKE_ANTHROPIC_KEY }, body: { model: 'claude-opus-4-5-20251101' } });
      expect(anthropicPosts()[0].body.messages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]);
      expect(anthropicPosts()[0].body).not.toHaveProperty('temperature');
      const rows = storage.getDb().prepare("SELECT provider, api_mode AS apiMode, stream FROM llm_usage_attempts WHERE provider = 'anthropic'").all();
      expect(rows).toEqual([{ provider: 'anthropic', apiMode: 'messages', stream: 1 }]);
      // Older pickers' unqualified keys still map to the team catalog, not to Claude.
      expect(settings.chatModels.resolve('sol')).toMatchObject({ key: 'team.sol', connectionId: 'team' });
    });

    it('keeps state() ready and shows the busy notice when Claude answers 529, and clears it on the next good call', async () => {
      const settings = await serviceWithoutTeam({ anthropicEndpoint: anthropic.url });
      await settings.saveApiKey('anthropic', FAKE_ANTHROPIC_KEY);
      const busy = { status: 529, headers: { 'retry-after': '0' }, body: fakeErrorBody('overloaded_error', 'Overloaded') };
      anthropic.reply = () => busy;
      const binding = settings.chatModels.resolve('anthropic.claude-sonnet-5-5')!;
      anthropic.requests.length = 0;
      const error = await binding.client.chatCompletion({ messages: [{ role: 'user', content: 'hi' }] }).catch(e => e);
      expect(error).toBeInstanceOf(Error);
      expect(String(error.message)).toMatch(/overloaded/i);
      // One send and three resends, then the typed error; the key is fine, so the connection stays ready.
      expect(anthropicPosts()).toHaveLength(4);
      const status = settings.status();
      expect(status.state).toBe('ready');
      expect(settings.state()).toBe('ready');
      expect(status.connections[0]).toMatchObject({ id: 'anthropic', healthy: true, issue: { code: 'overloaded', message: 'Anthropic is busy right now.' } });
      expect(status.issue).toMatchObject({ code: 'overloaded' });
      anthropic.reply = undefined;
      await binding.client.chatCompletion({ messages: [{ role: 'user', content: 'hi' }] });
      expect(settings.status().connections[0].issue).toBeUndefined();
      expect(settings.status().issue).toBeUndefined();
    });

    it('marks Claude as needing attention when the key is rejected, with the next action, and recovers after a good call', async () => {
      const settings = await serviceWithoutTeam({ anthropicEndpoint: anthropic.url });
      await settings.saveApiKey('anthropic', FAKE_ANTHROPIC_KEY);
      anthropic.reply = () => FAKE_D10_ROWS.find(row => row.name === '401 authentication_error')!.answer;
      const binding = settings.chatModels.resolve('anthropic.claude-sonnet-5-5')!;
      await binding.client.chatCompletion({ messages: [{ role: 'user', content: 'hi' }] }).catch(() => undefined);
      const status = settings.status();
      expect(status.state).toBe('unavailable');
      expect(status.connections[0].issue).toMatchObject({
        code: 'auth_rejected', message: 'Anthropic rejected the saved API key.', nextAction: expect.stringContaining('platform.claude.com/settings/keys'),
      });
      expect(status.issue).toMatchObject({ code: 'auth_rejected' });
      anthropic.reply = undefined;
      await binding.client.chatCompletion({ messages: [{ role: 'user', content: 'hi' }] });
      expect(settings.status().state).toBe('ready');
      expect(settings.status().connections[0].issue).toBeUndefined();
    });

    it('reports a credit problem on a Claude call as the account\'s next action and leaves the key stored', async () => {
      const settings = await serviceWithoutTeam({ anthropicEndpoint: anthropic.url });
      await settings.saveApiKey('anthropic', FAKE_ANTHROPIC_KEY);
      anthropic.reply = () => FAKE_D10_ROWS.find(row => row.name === '402 billing_error')!.answer;
      const binding = settings.chatModels.resolve('anthropic.claude-sonnet-5-5')!;
      anthropic.requests.length = 0;
      await binding.client.chatCompletion({ messages: [{ role: 'user', content: 'hi' }] }).catch(() => undefined);
      // Credit exhaustion is terminal: one send, no retry loop.
      expect(anthropicPosts()).toHaveLength(1);
      expect(settings.status().connections[0].issue).toMatchObject({
        code: 'quota_exhausted', nextAction: expect.stringContaining('platform.claude.com/settings/billing'),
      });
      expect(settings.status().state).toBe('unavailable');
      expect(settings.status().anthropic?.keySuffix).toBe(suffixOf(FAKE_ANTHROPIC_KEY));
    });

    it('removes the connection with the key: turns pinned to it stop, role choices fall back, and the picker drops Claude', async () => {
      const settings = await saveWith();
      await settings.saveApiKey('anthropic', FAKE_ANTHROPIC_KEY);
      await settings.setRole('processing', { modelKey: 'anthropic.claude-haiku-5-5', thinking: 'low' });
      const events: string[] = [];
      settings.chatModels.onChange(event => events.push(event.connectionId));
      const versionBefore = settings.version();

      const removed = await settings.removeApiKey('anthropic');

      expect(events).toEqual(['anthropic']);
      expect(settings.version()).toBeGreaterThan(versionBefore);
      expect(removed.anthropic).toBeUndefined();
      expect(connectionIds(settings)).toEqual(['team']);
      expect(removed.roles.processing).toMatchObject({ modelKey: 'team.terra', chosen: false, unavailableChoice: 'anthropic.claude-haiku-5-5', thinking: 'low' });
      expect(settings.chatModels.catalog()?.models.some(model => model.key.startsWith('anthropic.'))).toBe(false);
      expect(settings.chatModels.resolve('anthropic.claude-haiku-5-5')).toBeNull();
      // The role choice survives in the file, and comes back with the key.
      expect(storedFile()).toEqual({ schemaVersion: 2, keys: {}, roles: { processing: { modelKey: 'anthropic.claude-haiku-5-5', thinking: 'low' } } });
      const again = await settings.saveApiKey('anthropic', FAKE_ANTHROPIC_KEY);
      expect(again.roles.processing).toMatchObject({ modelKey: 'anthropic.claude-haiku-5-5', chosen: true });
    });

    it('replaces the connection when the key is replaced: the old one is retired, its pinned turns stop, new calls use the new key', async () => {
      const settings = await saveWith();
      await settings.saveApiKey('anthropic', FAKE_ANTHROPIC_KEY);
      const pinned = settings.chatModels.resolve('anthropic.claude-sonnet-5-5')!;
      const events: string[] = [];
      settings.chatModels.onChange(event => events.push(event.connectionId));
      await settings.saveApiKey('anthropic', SECOND_KEY);
      expect(events).toEqual(['anthropic']);
      const fresh = settings.chatModels.resolve('anthropic.claude-sonnet-5-5')!;
      expect(fresh.operation?.client).not.toBe(pinned.operation?.client);
      anthropic.requests.length = 0;
      await fresh.client.chatCompletion({ messages: [{ role: 'user', content: 'hi' }] });
      expect(anthropicPosts()[0].auth).toEqual({ style: 'x-api-key', key: SECOND_KEY });
      // A failed replacement changes nothing: the working connection keeps serving.
      anthropic.respond = request => (request.path === '/v1/messages' ? FAKE_D10_ROWS.find(row => row.name === '401 authentication_error')!.answer : undefined);
      await expect(settings.saveApiKey('anthropic', FAKE_ANTHROPIC_KEY)).rejects.toMatchObject({ code: 'invalid_key' });
      anthropic.respond = undefined;
      expect(events).toEqual(['anthropic']);
      expect(storedFile().keys.anthropic.apiKey).toBe(SECOND_KEY);
      expect((await settings.chatModels.resolve('anthropic.claude-sonnet-5-5')!.client.chatCompletion({ messages: [{ role: 'user', content: 'hi' }] })).content).toBe('pong');
    });

    it('re-lists the models once when a model turns out to be gone, applies a changed list, and waits before asking again', async () => {
      let clock = Date.parse('2026-10-13T12:00:00.000Z');
      const settings = await service({ anthropicEndpoint: anthropic.url, now: () => new Date(clock) });
      await settings.saveApiKey('anthropic', FAKE_ANTHROPIC_KEY);
      const events: string[] = [];
      settings.chatModels.onChange(event => events.push(event.connectionId));
      const listings = () => anthropic.requests.filter(request => request.method === 'GET' && request.path === '/v1/models' && request.query.limit?.[0] !== '1').length;
      const call = (key: string) => settings.chatModels.resolve(key)!.client.chatCompletion({ messages: [{ role: 'user', content: 'hi' }] }).catch(() => undefined);
      const listedBefore = listings();

      // The API drops Opus 5.5; the next call on it answers 404, which asks for a re-list.
      anthropic.setModels(FAKE_DEFAULT_MODELS.filter(model => model.id !== 'claude-opus-5-5'));
      anthropic.reply = request => (request.body?.model === 'claude-opus-5-5' ? FAKE_D10_ROWS.find(row => row.name === '404 not_found_error')!.answer : undefined);
      await call('anthropic.claude-opus-5-5');
      await vi.waitFor(() => expect(events).toEqual(['anthropic']));
      expect(listings()).toBe(listedBefore + 1);
      expect(storedFile().keys.anthropic.models.map((model: any) => model.id)).not.toContain('claude-opus-5-5');
      expect(settings.chatModels.catalog()?.models.some(model => model.key === 'anthropic.claude-opus-5-5')).toBe(false);
      expect(settings.chatModels.resolve('anthropic.claude-opus-5-5')).toBeNull();
      expect(settings.chatModels.resolve('anthropic.claude-haiku-5-5')).not.toBeNull();

      // Another stale answer inside the interval does not list again.
      anthropic.reply = () => FAKE_D10_ROWS.find(row => row.name === '404 not_found_error')!.answer;
      await call('anthropic.claude-haiku-5-5');
      await new Promise(resolve => setTimeout(resolve, 60));
      expect(listings()).toBe(listedBefore + 1);

      // After the interval it lists again; an unchanged list replaces nothing.
      clock += 11 * 60_000;
      await call('anthropic.claude-haiku-5-5');
      await vi.waitFor(() => expect(listings()).toBe(listedBefore + 2));
      await new Promise(resolve => setTimeout(resolve, 60));
      expect(events).toEqual(['anthropic']);

      // An empty answer keeps the saved list.
      clock += 11 * 60_000;
      anthropic.setModels([]);
      await call('anthropic.claude-haiku-5-5');
      await vi.waitFor(() => expect(listings()).toBe(listedBefore + 3));
      await new Promise(resolve => setTimeout(resolve, 60));
      expect(events).toEqual(['anthropic']);
      expect(settings.chatModels.resolve('anthropic.claude-haiku-5-5')).not.toBeNull();
    });

    it('does not apply a re-list when the key was replaced while it was in flight', async () => {
      const clock = Date.parse('2026-10-13T12:00:00.000Z');
      // Hold the first full listing made with the first key open, replace the key meanwhile, then let the old listing finish.
      let release!: () => void;
      const held = new Promise<void>(resolve => { release = resolve; });
      let holding = false;
      let heldOnce = false;
      const gate = (async (input: any, init?: RequestInit) => {
        const url = new URL(String(input));
        const key = new Headers(init?.headers).get('x-api-key');
        if (holding && !heldOnce && init?.method !== 'POST' && url.pathname === '/v1/models' && url.searchParams.get('limit') !== '1' && key === FAKE_ANTHROPIC_KEY) {
          heldOnce = true;
          await held;
        }
        return fetch(input, init);
      }) as typeof fetch;
      const settings = await service({ anthropicEndpoint: anthropic.url, now: () => new Date(clock), fetchImpl: gate });
      await settings.saveApiKey('anthropic', FAKE_ANTHROPIC_KEY);
      const events: string[] = [];
      settings.chatModels.onChange(event => events.push(event.connectionId));
      holding = true;
      anthropic.setModels(FAKE_DEFAULT_MODELS.filter(model => model.id !== 'claude-opus-5-5'));
      anthropic.reply = request => (request.body?.model === 'claude-opus-5-5' ? FAKE_D10_ROWS.find(row => row.name === '404 not_found_error')!.answer : undefined);
      await settings.chatModels.resolve('anthropic.claude-opus-5-5')!.client.chatCompletion({ messages: [{ role: 'user', content: 'hi' }] }).catch(() => undefined);
      anthropic.reply = undefined;
      await vi.waitFor(() => expect(heldOnce).toBe(true));
      anthropic.setModels(FAKE_DEFAULT_MODELS);
      await settings.saveApiKey('anthropic', SECOND_KEY);
      expect(events).toEqual(['anthropic']);
      // The old listing now finishes with a list that differs from the new key's stored one.
      anthropic.setModels(FAKE_DEFAULT_MODELS.filter(model => model.id !== 'claude-opus-5-5'));
      release();
      await new Promise(resolve => setTimeout(resolve, 80));
      // It belonged to the old key: nothing replaced the new connection or rewrote the file.
      expect(events).toEqual(['anthropic']);
      expect(storedFile().keys.anthropic.apiKey).toBe(SECOND_KEY);
      expect(storedFile().keys.anthropic.models.map((model: any) => model.id)).toContain('claude-opus-5-5');
      expect(settings.chatModels.resolve('anthropic.claude-opus-5-5')).not.toBeNull();
    });

    it('never writes the key to a log, a status, an error, or anywhere but the private file', async () => {
      const sinks = (['log', 'info', 'warn', 'error', 'debug'] as const).map(method => vi.spyOn(console, method).mockImplementation(() => {}));
      const settings = await saveWith();
      const outputs: string[] = [];
      outputs.push(JSON.stringify(await settings.saveApiKey('anthropic', FAKE_ANTHROPIC_KEY)));
      outputs.push(JSON.stringify(settings.status()));
      anthropic.respond = request => (request.path === '/v1/messages'
        ? { status: 401, body: fakeErrorBody('authentication_error', `invalid x-api-key ${SECOND_KEY}`) }
        : undefined);
      const error = await settings.saveApiKey('anthropic', SECOND_KEY).catch(e => e);
      outputs.push(JSON.stringify({ message: error.message, nextAction: error.nextAction, code: error.code }));
      outputs.push(String(error.stack ?? ''));
      // The same on the connection's own calls: the thrown text, the connection's issue and the status carry no key either.
      const binding = settings.chatModels.resolve('anthropic.claude-sonnet-5-5')!;
      const callError = await binding.client.chatCompletion({ messages: [{ role: 'user', content: 'hi' }] }).catch(e => e);
      expect(callError).toBeInstanceOf(Error);
      outputs.push(String(callError.message), String(callError.stack ?? ''), JSON.stringify(settings.status()));
      // Objects are opened up (`inspect`), so a stored key record in a log line cannot hide behind `[object Object]`.
      for (const sink of sinks) for (const args of sink.mock.calls) outputs.push(args.map(arg => (typeof arg === 'string' ? arg : inspect(arg, { depth: 8, breakLength: Infinity }))).join(' '));
      for (const text of outputs) {
        expect(text).not.toContain(FAKE_ANTHROPIC_KEY);
        expect(text).not.toContain(SECOND_KEY);
      }
      expect(outputs.some(text => text.includes(suffixOf(FAKE_ANTHROPIC_KEY)))).toBe(true);
      // Only the private file holds the key.
      expect(fs.readFileSync(settingsFile(), 'utf8')).toContain(FAKE_ANTHROPIC_KEY);
      expect(JSON.stringify(storage.getDb().prepare('SELECT * FROM llm_usage_attempts').all())).not.toContain(FAKE_ANTHROPIC_KEY);
    });
  });

  describe('provider overload (a 529) and connection readiness', () => {
    function envProviderReporting(code: string | undefined): InferenceProvider {
      const client = {
        healthCheck: async () => true,
        isAvailable: () => true,
        getDefaultModel: () => 'openai.gpt-5.6-terra',
        getMaxCompletionTokens: () => 16_384,
        getProviderIssue: () => (code ? { code, httpStatus: 529, at: '2026-10-13T00:00:00.000Z' } : undefined),
        getAvailableModels: () => undefined,
        close: vi.fn(),
      } as unknown as LlmClient;
      return { id: 'bedrock', endpoint: 'https://bedrock.test/v1', model: 'openai.gpt-5.6-terra', apiMode: 'responses', maxContextTokens: 1_000_000, localFallbackEnabled: false, createClient: () => client };
    }

    it('leaves state() ready for overloaded and rate_limited, and unavailable for credential or credit problems', async () => {
      const states: Record<string, string> = {};
      for (const code of [undefined, 'overloaded', 'rate_limited', 'auth_rejected', 'quota_exhausted']) {
        const created = await createAiModelSettingsService({
          envProvider: envProviderReporting(code),
          privateRoot,
          env: { BOTBOY_INFERENCE_HEALTH_INTERVAL_MS: '0' },
          environmentCredentialsPresent: true,
          openAiEndpoint: fakes.openai,
          deepSeekEndpoint: fakes.deepseek,
        });
        closers.push(created);
        states[String(code)] = created.state();
      }
      expect(states).toEqual({ undefined: 'ready', overloaded: 'ready', rate_limited: 'ready', auth_rejected: 'unavailable', quota_exhausted: 'unavailable' });
    });

    it('words a provider issue for each keyed provider, with an explicit overloaded text', () => {
      const at = '2026-10-13T00:00:00.000Z';
      const issue = (code: any) => ({ code, httpStatus: 529, at });
      expect(aiModelIssueText(issue('overloaded'), 'anthropic')).toEqual({
        code: 'overloaded', message: 'Anthropic is busy right now.', nextAction: 'BotBoy retries on its own; nothing to change.', at,
      });
      // Overload no longer reads as rate-limiting.
      expect(aiModelIssueText(issue('overloaded'), 'openai')?.message).toBe('OpenAI is busy right now.');
      expect(aiModelIssueText(issue('rate_limited'), 'anthropic')?.message).toBe('Anthropic is rate-limiting this key.');
      expect(aiModelIssueText(issue('auth_rejected'), 'anthropic')).toMatchObject({
        message: 'Anthropic rejected the saved API key.', nextAction: expect.stringContaining('platform.claude.com/settings/keys'),
      });
      expect(aiModelIssueText(issue('quota_exhausted'), 'anthropic')).toMatchObject({
        message: expect.stringContaining('no available credit'), nextAction: expect.stringContaining('platform.claude.com/settings/billing'),
      });
      expect(aiModelIssueText(issue('quota_exhausted'), 'deepseek')?.nextAction).toContain('platform.deepseek.com');
      // The launcher provider has no keyed text, and no issue means no text.
      expect(aiModelIssueText(issue('overloaded'), 'team')).toBeUndefined();
      expect(aiModelIssueText(undefined, 'anthropic')).toBeUndefined();
    });
  });
});
