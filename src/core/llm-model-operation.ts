/**
 * The model serving one operation (a chat turn or an agent loop).
 *
 * BotBoy can have several model connections at once (team gateway, the
 * owner's OpenAI key, the owner's DeepSeek key). Data-handling checks must
 * judge where data is about to go per operation, not from one global
 * provider: a Data Room tool called inside a DeepSeek chat turn sends its
 * result to DeepSeek even when background work runs on the team gateway.
 *
 * Entry points (chat turn, agent loop) run their tool executions inside
 * `runInLlmModelOperation`; readers (`answerProviderReceipt`,
 * `limits.endpointContextTokens`) call `currentLlmModelOperation()` and fall
 * back to the organizing model when no operation is active.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { LlmApiMode, LlmClient } from './llm-client.js';

/** Provider identity used for data-locality receipts. */
export interface LlmProviderDescriptor {
  readonly id: string;
  /** The connection's base endpoint (never an alternate route endpoint). */
  readonly endpoint: string;
  readonly model: string;
  readonly apiMode: LlmApiMode;
}

/** What one model can take; read per use, never cached across models. */
export interface LlmModelCapabilities {
  /** true/false when known; undefined when the provider does not report it. */
  readonly images?: boolean;
  readonly contextWindow: number;
  readonly maxOutputTokens: number;
}

export interface LlmModelOperation {
  readonly connectionId: string;
  readonly modelKey: string;
  readonly label: string;
  readonly provider: LlmProviderDescriptor;
  readonly capabilities: LlmModelCapabilities;
  /** The model-bound client serving this operation. */
  readonly client: LlmClient;
}

const storage = new AsyncLocalStorage<LlmModelOperation>();

/** Run `work` with `operation` as the active model operation (no-op when undefined). */
export function runInLlmModelOperation<T>(operation: LlmModelOperation | undefined, work: () => T): T {
  return operation ? storage.run(operation, work) : work();
}

/** The model operation the current async context belongs to, if any. */
export function currentLlmModelOperation(): LlmModelOperation | undefined {
  return storage.getStore();
}
