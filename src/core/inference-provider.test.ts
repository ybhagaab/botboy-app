import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ANTHROPIC_PLATFORM_ENDPOINT,
  createAnthropicInferenceProvider,
  createDeepSeekInferenceProvider,
  createOpenAiPlatformInferenceProvider,
  defaultInferenceMaxContextTokens,
  resolveInferenceProviderId,
} from './inference-provider.js';
import { parseAnthropicModel, type AnthropicModelProfile } from './anthropic-models.js';
import { FAKE_ANTHROPIC_KEY, fakeModelRow, startFakeAnthropic, type FakeAnthropicServer } from './anthropic-api.fake.js';
import { ANTHROPIC_STREAM_IDLE_TIMEOUT_MS } from './anthropic-client.js';
import type { LlmConfig } from './llm-client.js';

// Spy on the two client constructors so the exact config each provider hands over is visible, while the real clients still run.
const captured: { anthropic: LlmConfig[]; hosted: LlmConfig[] } = { anthropic: [], hosted: [] };
vi.mock('./anthropic-client.js', async importOriginal => {
  const actual = await importOriginal<typeof import('./anthropic-client.js')>();
  return { ...actual, createAnthropicLlmClient: vi.fn((config: LlmConfig, ...rest: unknown[]) => {
    captured.anthropic.push(config);
    return (actual.createAnthropicLlmClient as (...args: unknown[]) => unknown)(config, ...rest);
  }) };
});
vi.mock('./llm-client.js', async importOriginal => {
  const actual = await importOriginal<typeof import('./llm-client.js')>();
  return { ...actual, createLlmClient: vi.fn((config: LlmConfig, ...rest: unknown[]) => {
    captured.hosted.push(config);
    return (actual.createLlmClient as (...args: unknown[]) => unknown)(config, ...rest);
  }) };
});

/**
 * Design v3 D7 / D8 (slice A2): the Anthropic provider and, above all, its context budget. The owner's decision of
 * 2026-10-13 is that Claude uses the SHARED default of 100,000 tokens, exactly like every other provider, with no
 * Claude-specific number anywhere. Five tests keep it so: the literal pinned once, parity with the other two hosted
 * providers, the environment override, bound models of every window size, and a source guard.
 */
const model = (spec: { id: string; variant: 'A' | 'B' | 'C' | 'D'; maxInputTokens?: number | null; maxTokens?: number | null; line?: string }): AnthropicModelProfile =>
  parseAnthropicModel(fakeModelRow({ line: 'sonnet', ...spec }))!;
const SONNET = model({ id: 'claude-sonnet-5-5', variant: 'A', maxInputTokens: 1_000_000, maxTokens: 128_000 });
const HAIKU_200K = model({ id: 'claude-haiku-4-5-20251001', variant: 'C', line: 'haiku', maxInputTokens: 200_000, maxTokens: 64_000 });

const anthropic = (env: NodeJS.ProcessEnv = {}, models: AnthropicModelProfile[] = [SONNET, HAIKU_200K], defaultModel = 'claude-sonnet-5-5') =>
  createAnthropicInferenceProvider({ apiKey: FAKE_ANTHROPIC_KEY, models, defaultModel, env: { BOTBOY_INFERENCE_HEALTH_INTERVAL_MS: '0', ...env } });
const openai = (env: NodeJS.ProcessEnv = {}) =>
  createOpenAiPlatformInferenceProvider({ apiKey: 'sk-proj-parity0000000000000000abcd', env: { BOTBOY_INFERENCE_HEALTH_INTERVAL_MS: '0', ...env } });
const deepseek = (env: NodeJS.ProcessEnv = {}) =>
  createDeepSeekInferenceProvider({ apiKey: 'sk-parity00000000000000000000abcd', availableModels: ['deepseek-flash'], defaultModel: 'deepseek-flash', env: { BOTBOY_INFERENCE_HEALTH_INTERVAL_MS: '0', ...env } });

const clients: Array<{ close(): void }> = [];
const budgetOf = (provider: { createClient(): { close(): void; getContextBudgetTokens?(): number } }) => {
  const client = provider.createClient();
  clients.push(client);
  return client.getContextBudgetTokens?.();
};
let fake: FakeAnthropicServer | undefined;
afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  captured.anthropic.length = 0;
  captured.hosted.length = 0;
  await fake?.close();
  fake = undefined;
});

describe('Anthropic inference provider', () => {
  it('describes a Settings-only Messages provider on the Anthropic endpoint with the default model\'s window', () => {
    const provider = anthropic();
    expect(provider).toMatchObject({
      id: 'anthropic', endpoint: 'https://api.anthropic.com', model: 'claude-sonnet-5-5', apiMode: 'messages',
      maxContextTokens: 1_000_000, localFallbackEnabled: false,
    });
    expect(ANTHROPIC_PLATFORM_ENDPOINT).toBe('https://api.anthropic.com');
    expect(anthropic({}, [HAIKU_200K], 'claude-haiku-4-5-20251001').maxContextTokens).toBe(200_000);
    // A default model the list does not describe reads as the 200,000-token window.
    expect(anthropic({}, [], 'claude-unlisted').maxContextTokens).toBe(200_000);
    expect(defaultInferenceMaxContextTokens('anthropic')).toBe(200_000);
    const client = provider.createClient();
    clients.push(client);
    expect(client.getProviderId?.()).toBe('anthropic');
    expect(client.getApiMode?.()).toBe('messages');
    expect(client.getAvailableModels?.()).toEqual(['claude-sonnet-5-5', 'claude-haiku-4-5-20251001']);
    expect(client.getDefaultModel()).toBe('claude-sonnet-5-5');
  });

  it('refuses an empty key or default model, never echoing a key, and is never selectable from the environment', () => {
    expect(() => createAnthropicInferenceProvider({ apiKey: '   ', models: [SONNET], defaultModel: 'claude-sonnet-5-5' })).toThrow('An Anthropic API key is required.');
    expect(() => createAnthropicInferenceProvider({ apiKey: FAKE_ANTHROPIC_KEY, models: [SONNET], defaultModel: ' ' })).toThrow('An Anthropic default model is required.');
    expect(() => resolveInferenceProviderId({ BOTBOY_INFERENCE_PROVIDER: 'anthropic' })).toThrow(/Settings → AI model/);
    // An ambient ANTHROPIC_API_KEY changes nothing about provider selection.
    expect(resolveInferenceProviderId({ ANTHROPIC_API_KEY: FAKE_ANTHROPIC_KEY })).toBe('bedrock');
  });

  it('defaults the stream idle timeout to 280 s; a set value wins, the legacy name too; OpenAI and DeepSeek keep 120 s', () => {
    const idle = (env: NodeJS.ProcessEnv) => {
      const before = captured.anthropic.length;
      clients.push(anthropic(env).createClient());
      return captured.anthropic[before].streamIdleTimeoutMs;
    };
    expect(ANTHROPIC_STREAM_IDLE_TIMEOUT_MS).toBe(280_000);
    expect(idle({})).toBe(280_000);
    expect(idle({ BOTBOY_INFERENCE_STREAM_IDLE_TIMEOUT_MS: '5000' })).toBe(5_000);
    expect(idle({ VLLM_STREAM_IDLE_TIMEOUT_MS: '7000' })).toBe(7_000);
    expect(idle({ BOTBOY_INFERENCE_STREAM_IDLE_TIMEOUT_MS: '0' })).toBe(0);
    expect(idle({ BOTBOY_INFERENCE_STREAM_IDLE_TIMEOUT_MS: 'soon' })).toBe(280_000);
    for (const provider of [openai(), deepseek()]) {
      const before = captured.hosted.length;
      clients.push(provider.createClient());
      expect(captured.hosted[before].streamIdleTimeoutMs).toBe(120_000);
    }
  });

  it('turns prompt caching off with BOTBOY_ANTHROPIC_PROMPT_CACHE=off and nothing else', async () => {
    fake = await startFakeAnthropic({ models: [{ id: 'claude-sonnet-5-5', variant: 'A', line: 'sonnet' }] });
    const sent = async (env: NodeJS.ProcessEnv) => {
      const provider = createAnthropicInferenceProvider({
        apiKey: FAKE_ANTHROPIC_KEY, models: [SONNET], defaultModel: 'claude-sonnet-5-5', endpoint: fake!.url,
        env: { BOTBOY_INFERENCE_HEALTH_INTERVAL_MS: '0', ...env },
      });
      const client = provider.createClient();
      clients.push(client);
      await client.chatCompletion({
        messages: [{ role: 'user', content: 'hi' }],
        tools: [{ type: 'function', function: { name: 'read_file', description: 'r', parameters: { type: 'object', properties: {} } } }],
        usageContext: { workload: 'interactive' },
      });
      return fake!.requests.filter(request => request.method === 'POST').at(-1)!.body.cache_control;
    };
    expect(await sent({})).toEqual({ type: 'ephemeral' });
    expect(await sent({ BOTBOY_ANTHROPIC_PROMPT_CACHE: 'on' })).toEqual({ type: 'ephemeral' });
    expect(await sent({ BOTBOY_ANTHROPIC_PROMPT_CACHE: 'OFF' })).toBeUndefined();
  });
});

describe('Context budget 100,000 (D7; owner decision 2026-10-13: the shared default, no Claude-specific number)', () => {
  it('1. the Anthropic provider\'s budget is the literal 100,000 (the one place the number is pinned)', () => {
    const before = captured.anthropic.length;
    expect(budgetOf(anthropic())).toBe(100_000);
    expect(captured.anthropic[before].defaults.contextBudgetTokens).toBe(100_000);
  });

  it('2. it equals the OpenAI and DeepSeek providers\' budget built the same way (parity, so a Claude-only number cannot creep in)', () => {
    const hostedBefore = captured.hosted.length;
    const claude = budgetOf(anthropic());
    const gpt = budgetOf(openai());
    const deep = budgetOf(deepseek());
    expect(claude).toBe(gpt);
    expect(claude).toBe(deep);
    expect(captured.hosted.slice(hostedBefore).map(config => config.defaults.contextBudgetTokens)).toEqual([100_000, 100_000]);
    // A future change of the shared default moves all three together: they read the same environment name.
    const env = { BOTBOY_INFERENCE_CONTEXT_BUDGET_TOKENS: '64000' };
    expect([budgetOf(anthropic(env)), budgetOf(openai(env)), budgetOf(deepseek(env))]).toEqual([64_000, 64_000, 64_000]);
  });

  it('3. BOTBOY_INFERENCE_CONTEXT_BUDGET_TOKENS wins when set to a positive integer; unset or invalid falls back to 100,000, as for the others', () => {
    expect(budgetOf(anthropic({ BOTBOY_INFERENCE_CONTEXT_BUDGET_TOKENS: '48000' }))).toBe(48_000);
    expect(budgetOf(anthropic({ BOTBOY_INFERENCE_CONTEXT_BUDGET_TOKENS: '150000' }))).toBe(150_000);
    for (const invalid of ['', '0', '-5', 'abc', ' ']) {
      expect(budgetOf(anthropic({ BOTBOY_INFERENCE_CONTEXT_BUDGET_TOKENS: invalid })), JSON.stringify(invalid)).toBe(100_000);
      expect(budgetOf(openai({ BOTBOY_INFERENCE_CONTEXT_BUDGET_TOKENS: invalid })), JSON.stringify(invalid)).toBe(100_000);
    }
    expect(budgetOf(anthropic({ BOTBOY_INFERENCE_CONTEXT_BUDGET_TOKENS: '48000' }))).toBe(budgetOf(openai({ BOTBOY_INFERENCE_CONTEXT_BUDGET_TOKENS: '48000' })));
  });

  it('5. source guard: no src/core/anthropic-*.ts file and no Anthropic branch of inference-provider.ts defines or passes a context budget', () => {
    const dir = path.dirname(fileURLToPath(import.meta.url));
    const stripComments = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1');
    const anthropicFiles = fs.readdirSync(dir).filter(name => /^anthropic-.*\.ts$/.test(name) && !name.endsWith('.test.ts'));
    expect(anthropicFiles).toEqual(expect.arrayContaining(['anthropic-client.ts', 'anthropic-messages.ts', 'anthropic-models.ts', 'anthropic-errors.ts', 'anthropic-replay-guard.ts', 'anthropic-schema.ts']));
    for (const name of anthropicFiles) {
      const code = stripComments(fs.readFileSync(path.join(dir, name), 'utf8'));
      // A property or variable that is given a budget value ("contextBudgetTokens:" / "= "). Reading `config.defaults.contextBudgetTokens`
      // and the client's `getContextBudgetTokens:` accessor (a name that merely ends in the same words) are fine, hence the lookbehind.
      expect(code, `${name} must not define or pass a context budget`).not.toMatch(/(?<![A-Za-z])contextBudget\w*\s*[:=]/i);
      expect(code, `${name} must not carry a Claude-specific 75,000`).not.toMatch(/\b75_?000\b/);
      if (name !== 'anthropic-api.fake.ts') expect(code, `${name} must not carry a Claude-specific 128,000`).not.toMatch(/\b128_?000\b/);
    }
    const provider = stripComments(fs.readFileSync(path.join(dir, 'inference-provider.ts'), 'utf8'));
    const start = provider.indexOf('export function createAnthropicInferenceProvider');
    const end = provider.indexOf('function inferProvider', start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const branch = provider.slice(start, end);
    expect(branch).not.toMatch(/contextBudget/i);
    expect(branch).not.toMatch(/\b75_?000\b|\b128_?000\b/);
    // The branch takes its budget from the same runtime settings as the other providers.
    expect(branch).toContain('...runtimeSettingsFromEnv(env');
  });
});
