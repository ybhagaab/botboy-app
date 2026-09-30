import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  LlmApiMode,
  LlmClient,
  LlmDialect,
  LlmProviderIssue,
  PrimaryRequestPreflight,
  StreamChunk,
  StreamResult,
} from './llm-client.js';
import type { LlmUsageContext } from './llm-usage.js';

/** Who is serving BotBoy's models right now, and how that was chosen. */
export interface LlmRuntimeIdentity {
  readonly providerId: string;
  readonly endpoint: string;
  readonly model: string;
  readonly apiMode: LlmApiMode;
  readonly maxContextTokens: number;
  /** 'settings' = the owner's key from Settings → AI model; 'environment' = launcher/.env configuration. */
  readonly source: 'environment' | 'settings';
}

/**
 * One stable LlmClient for every BotBoy consumer while the provider behind it
 * can change at runtime (Settings → AI model). Every call reads the active
 * client at call time, so background passes, chat, and tools switch together
 * without a restart.
 *
 * Multi-request operations that replay provider-bound state (Responses
 * encrypted reasoning inside a tool loop) must `pin()` once and use that
 * client for the whole operation: replaying one provider's opaque output to
 * another provider is never valid.
 */
export interface LlmClientSwitch extends LlmClient {
  /** The active client, fixed for the caller's operation. */
  pin(): LlmClient;
  /** Identity of the active client. */
  identity(): LlmRuntimeIdentity;
  /** Monotonic counter bumped by every activation; open UIs refresh on change. */
  configVersion(): number;
  /**
   * Make `next` the active client. Returns the previous client, which the
   * caller closes (its in-flight requests finish on it; its health timer stops).
   */
  activate(next: LlmClient, identity: LlmRuntimeIdentity): LlmClient;
  /**
   * Observe activations (synchronously, after the switch). Owners of pinned
   * multi-step work stop it here so no operation keeps sending to the old
   * provider data that was admitted under the new one. Returns an unsubscribe.
   */
  onActivate(listener: (identity: LlmRuntimeIdentity) => void): () => void;
}

export function isLlmClientSwitch(client: unknown): client is LlmClientSwitch {
  return Boolean(client)
    && typeof (client as LlmClientSwitch).pin === 'function'
    && typeof (client as LlmClientSwitch).activate === 'function';
}

/** Pin a switch for one operation; plain clients are already fixed. */
export function pinLlmClient<T extends LlmClient | undefined>(client: T): T {
  return (isLlmClientSwitch(client) ? client.pin() : client) as T;
}

export function createLlmClientSwitch(initial: LlmClient, initialIdentity: LlmRuntimeIdentity): LlmClientSwitch {
  let active = initial;
  let activeIdentity = initialIdentity;
  let version = 1;
  const listeners = new Set<(identity: LlmRuntimeIdentity) => void>();

  return {
    pin: () => active,
    identity: () => activeIdentity,
    configVersion: () => version,
    activate(next: LlmClient, identity: LlmRuntimeIdentity): LlmClient {
      const previous = active;
      active = next;
      activeIdentity = identity;
      version += 1;
      for (const listener of [...listeners]) {
        try { listener(identity); } catch (error) {
          console.warn(`[LLM] Activation listener failed: ${error instanceof Error ? error.name : 'Error'}`);
        }
      }
      return previous;
    },
    onActivate(listener: (identity: LlmRuntimeIdentity) => void): () => void {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },

    chatCompletion: (request: ChatCompletionRequest): Promise<ChatCompletionResponse> => active.chatCompletion(request),
    chatCompletionStream: (request: ChatCompletionRequest): AsyncGenerator<StreamChunk, StreamResult, undefined> =>
      active.chatCompletionStream(request),
    preflightPrimary: (request: ChatCompletionRequest): PrimaryRequestPreflight => active.preflightPrimary(request),
    chatCompletionPrimary: (request: ChatCompletionRequest): Promise<ChatCompletionResponse> => active.chatCompletionPrimary(request),
    getMaxRequestBytes: (): number => active.getMaxRequestBytes(),
    getDefaultModel: (): string => active.getDefaultModel(),
    getProviderId: (): string | undefined => active.getProviderId?.() ?? activeIdentity.providerId,
    getAvailableModels: (): readonly string[] | undefined => active.getAvailableModels?.(),
    getProviderIssue: (): LlmProviderIssue | undefined => active.getProviderIssue?.(),
    sendPrompt: (prompt: string, usageContext?: LlmUsageContext) => active.sendPrompt(prompt, usageContext),
    sendMessage: (messages, usageContext?: LlmUsageContext) => active.sendMessage(messages, usageContext),
    initialize: (): Promise<void> => active.initialize(),
    isAvailable: (): boolean => active.isAvailable(),
    getActiveEndpoint: () => active.getActiveEndpoint(),
    getActiveModel: (): string | undefined => active.getActiveModel?.(),
    getDialect: (): LlmDialect => active.getDialect?.() ?? 'openai',
    getApiMode: (): LlmApiMode => active.getApiMode?.() ?? activeIdentity.apiMode,
    getMaxCompletionTokens: (): number => active.getMaxCompletionTokens?.() ?? 16_384,
    getContextWindow: (): number => active.getContextWindow?.() ?? activeIdentity.maxContextTokens,
    getContextBudgetTokens: (): number => active.getContextBudgetTokens?.() ?? 16_000,
    healthCheck: (): Promise<boolean> => active.healthCheck(),
    close: (): void => active.close(),
  };
}
