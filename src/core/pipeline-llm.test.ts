import { describe, expect, it } from 'vitest';
import { adaptSendPrompt } from './pipeline-llm.js';

/** What the information pipeline records about the model behind each pass (pipeline_llm_audit). */
describe('adaptSendPrompt audit metadata', () => {
  const client = (extra: Record<string, unknown> = {}) => ({
    isAvailable: () => true,
    sendPrompt: async () => ({ content: '[]' }),
    getActiveEndpoint: () => 'ecs',
    getActiveModel: () => 'live-model',
    getProviderId: () => 'live-provider',
    ...extra,
  });
  const fallbacks = { provider: 'boot-provider', model: 'boot-model', temperature: 0.7 };

  it('reads the live provider, model and endpoint and keeps the configured temperature for providers that receive one', () => {
    for (const apiMode of [undefined, 'responses', 'chat_completions']) {
      const llm = adaptSendPrompt(client({ getApiMode: () => apiMode }), fallbacks);
      expect(llm.auditMetadata!(), String(apiMode)).toEqual({ provider: 'live-provider', model: 'live-model', temperature: 0.7, activeEndpoint: 'ecs' });
    }
  });

  it('records no temperature for a client on the Anthropic Messages API, which never sends one', () => {
    const llm = adaptSendPrompt(client({ getProviderId: () => 'anthropic', getActiveModel: () => 'claude-haiku-5-5', getApiMode: () => 'messages' }), fallbacks);
    const audit = llm.auditMetadata!();
    expect(audit).toEqual({ provider: 'anthropic', model: 'claude-haiku-5-5', activeEndpoint: 'ecs' });
    expect(audit).not.toHaveProperty('temperature');
  });

  it('follows a runtime switch: the same adapter records a temperature again once a non-Messages client is live', () => {
    let mode: string = 'messages';
    const llm = adaptSendPrompt(client({ getApiMode: () => mode }), fallbacks);
    expect(llm.auditMetadata!()).not.toHaveProperty('temperature');
    mode = 'responses';
    expect(llm.auditMetadata!()).toMatchObject({ temperature: 0.7 });
  });

  it('names the local model when the local fallback is serving', () => {
    const llm = adaptSendPrompt(client({ getActiveEndpoint: () => 'ollama', getApiMode: () => 'messages' }), fallbacks);
    expect(llm.auditMetadata!()).toMatchObject({ provider: 'ollama', activeEndpoint: 'ollama' });
  });
});
