import { describe, expect, it, vi } from 'vitest';
import { createLlmClientSwitch, isLlmClientSwitch, pinLlmClient, type LlmRuntimeIdentity } from './llm-client-switch.js';
import type { LlmClient } from './llm-client.js';

function stubClient(name: string): LlmClient {
  return {
    chatCompletion: vi.fn(async () => ({ content: name, toolCalls: null, usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, finishReason: 'stop' as const })),
    chatCompletionStream: vi.fn(),
    preflightPrimary: vi.fn(),
    chatCompletionPrimary: vi.fn(async () => ({ content: name, toolCalls: null, usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, finishReason: 'stop' as const })),
    getMaxRequestBytes: () => 5_500_000,
    getDefaultModel: () => `${name}-model`,
    getProviderId: () => name,
    sendPrompt: vi.fn(async () => ({ content: name })),
    sendMessage: vi.fn(async () => ({ content: name })),
    initialize: async () => {},
    isAvailable: () => name === 'openai',
    getActiveEndpoint: () => 'ecs',
    healthCheck: vi.fn(async () => true),
    close: vi.fn(),
  } as unknown as LlmClient;
}

const identity = (providerId: string): LlmRuntimeIdentity => ({
  providerId,
  endpoint: `https://${providerId}.test/v1`,
  model: `${providerId}-model`,
  apiMode: 'responses',
  maxContextTokens: 1_000_000,
  source: providerId === 'openai' ? 'settings' : 'environment',
});

describe('switchable LLM client', () => {
  it('delegates every call to the active client and swaps without a restart', async () => {
    const gateway = stubClient('gateway');
    const openai = stubClient('openai');
    const client = createLlmClientSwitch(gateway, identity('gateway'));
    expect(isLlmClientSwitch(client)).toBe(true);
    expect(client.getDefaultModel()).toBe('gateway-model');
    expect((await client.chatCompletion({ messages: [] })).content).toBe('gateway');
    expect(client.isAvailable()).toBe(false);

    const previous = client.activate(openai, identity('openai'));
    expect(previous).toBe(gateway);
    expect(client.configVersion()).toBe(2);
    expect(client.identity()).toMatchObject({ providerId: 'openai', source: 'settings' });
    expect(client.getProviderId?.()).toBe('openai');
    expect((await client.sendPrompt('hi')).content).toBe('openai');
    expect(client.isAvailable()).toBe(true);
  });

  it('keeps a pinned operation on the provider it started with', async () => {
    const gateway = stubClient('gateway');
    const client = createLlmClientSwitch(gateway, identity('gateway'));
    const pinned = pinLlmClient(client);
    client.activate(stubClient('openai'), identity('openai'));
    expect(pinned).toBe(gateway);
    expect((await pinned.chatCompletion({ messages: [] })).content).toBe('gateway');
    // A plain client is already fixed.
    expect(pinLlmClient(gateway)).toBe(gateway);
  });

  it('notifies listeners after each activation and survives a failing listener', () => {
    const client = createLlmClientSwitch(stubClient('gateway'), identity('gateway'));
    const seen: string[] = [];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    client.onActivate(() => { throw new Error('listener broke'); });
    const stop = client.onActivate(active => seen.push(active.providerId));
    client.activate(stubClient('openai'), identity('openai'));
    stop();
    client.activate(stubClient('gateway'), identity('gateway'));
    expect(seen).toEqual(['openai']);
    expect(client.configVersion()).toBe(3);
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });
});
