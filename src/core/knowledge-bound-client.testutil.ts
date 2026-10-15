/**
 * A model-bound client built by the REAL `bindLlmModel` over a recording base client (tests only), so a test of how the
 * Knowledge library's own model calls behave at an owner's Thinking level cannot drift from the adapter it stands in for.
 */
import type { ChatCompletionRequest, ChatCompletionResponse, LlmClient } from './llm-client.js';
import { bindLlmModel, openAiModelEntries, type LlmConnection } from './llm-model-catalog.js';
import type { LlmThinkingLevel } from './llm-model-catalog.js';

export function realBoundClient(thinking: LlmThinkingLevel, answer: (request: ChatCompletionRequest) => ChatCompletionResponse): { client: LlmClient; seen: ChatCompletionRequest[] } {
  const seen: ChatCompletionRequest[] = [];
  const base = {
    chatCompletion: async (request: ChatCompletionRequest) => { seen.push(request); return answer(request); },
    getMaxCompletionTokens: () => 16_384,
    getContextBudgetTokens: () => 100_000,
    getDefaultModel: () => 'gpt-5.6-terra',
    getProviderId: () => 'openai',
    isAvailable: () => true,
    close: () => undefined,
  } as unknown as LlmClient;
  const connection: LlmConnection = {
    id: 'openai', label: 'OpenAI', source: 'settings', client: base,
    provider: { id: 'openai', endpoint: 'https://api.openai.com/v1', model: 'gpt-5.6-terra', apiMode: 'responses' } as LlmConnection['provider'],
    models: openAiModelEntries(['gpt-5.6-terra'], 'gpt-5.6-terra'), version: 1,
  };
  return { client: bindLlmModel(connection, connection.models[0], { thinking }), seen };
}
