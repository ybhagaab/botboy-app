/**
 * Model connections and the models each one offers (Settings → AI model).
 *
 * A connection is one credential to one provider: the team gateway (launcher
 * configuration), the owner's OpenAI key, or the owner's DeepSeek key. Every
 * model a connection offers gets a provider-qualified key
 * (`team.terra`, `openai.gpt-5.6-terra`, `deepseek.deepseek-flash`), an exact
 * server-only route, and a capability profile.
 *
 * `bindLlmModel` turns one connection + model into an ordinary LlmClient:
 * every request carries that model's route, completion budgets fit that
 * model, and budget getters describe that model. Chat turns, the organizing
 * role, and the document-writing role each hold such a client, so no
 * consumer needs to know which provider it is talking to.
 */
import type { ChatCompletionRequest, LlmClient, LlmRequestRoute } from './llm-client.js';
import type { LlmModelCapabilities, LlmModelOperation, LlmProviderDescriptor } from './llm-model-operation.js';
import {
  BLESSED_CHAT_MODELS,
  OPENAI_PLATFORM_DEFAULT_MODEL,
  OPENAI_PLATFORM_MODEL_IDS,
  DEEPSEEK_PREFERRED_DEFAULT_MODEL,
  getChatModelCatalog,
  resolveBlessedModelRoute,
  type ChatModelCatalog,
} from './inference-provider.js';

export type LlmConnectionId = 'team' | 'openai' | 'deepseek';
/** Picker and Settings order. */
export const LLM_CONNECTION_ORDER: readonly LlmConnectionId[] = Object.freeze(['team', 'openai', 'deepseek']);

/** Same levels as the chat Thinking control. */
export type LlmThinkingLevel = 'off' | 'low' | 'high' | 'max';
export const LLM_THINKING_LEVELS: readonly LlmThinkingLevel[] = Object.freeze(['off', 'low', 'high', 'max']);

export function isLlmThinkingLevel(value: unknown): value is LlmThinkingLevel {
  return typeof value === 'string' && (LLM_THINKING_LEVELS as readonly string[]).includes(value);
}

/** `<connection>.<model id>`; model ids may contain dots and colons (fine-tunes). */
export const LLM_MODEL_KEY_PATTERN = /^(team|openai|deepseek)\.[A-Za-z0-9._:-]{1,160}$/;
const MODEL_ID_PATTERN = /^[A-Za-z0-9._:-]{1,160}$/;

export function qualifiedModelKey(connectionId: LlmConnectionId, modelId: string): string {
  return `${connectionId}.${modelId}`;
}

export interface LlmModelEntry {
  readonly key: string;
  readonly connectionId: LlmConnectionId;
  /** Model title shown in pickers; never carries the provider name. */
  readonly label: string;
  readonly family?: string;
  /** Exact wire model id. */
  readonly model: string;
  /** Server-only route; never sent to the browser. */
  readonly route: LlmRequestRoute;
  /**
   * The connection's default model. Background calls on it go out without a
   * route, so they keep the endpoint's health and fallback semantics.
   */
  readonly isConnectionDefault: boolean;
  readonly preview: boolean;
  readonly capabilities: LlmModelCapabilities;
}

export interface LlmConnection {
  readonly id: LlmConnectionId;
  /** Picker group heading and Settings card title. */
  readonly label: string;
  readonly source: 'environment' | 'settings';
  readonly client: LlmClient;
  readonly provider: LlmProviderDescriptor;
  readonly models: readonly LlmModelEntry[];
  /** Bumps whenever this connection is replaced; chat turns pin it. */
  readonly version: number;
}

export function connectionDefaultEntry(connection: LlmConnection): LlmModelEntry | undefined {
  return connection.models.find(entry => entry.isConnectionDefault) ?? connection.models[0];
}

// ── Team gateway (launcher configuration) ──

export function teamConnectionLabel(providerId: string): string {
  if (providerId === 'gateway') return 'Team gateway';
  if (providerId === 'bedrock') return 'Amazon Bedrock';
  if (providerId === 'openai-compatible') return 'Self-hosted model';
  return providerId;
}

/**
 * The launcher provider's curated catalog, unchanged: GPT-5.6 on its proven
 * route and GPT-6 only when its rollout is configured. Malformed GPT-6
 * settings degrade to the GPT-5.6 list instead of hiding the connection.
 */
export function teamModelEntries(input: {
  providerId: string;
  defaultModel: string;
  maxContextTokens: number;
  maxCompletionTokens: number;
  env: NodeJS.ProcessEnv;
}): LlmModelEntry[] {
  let env = input.env;
  let catalog: ChatModelCatalog;
  try {
    catalog = getChatModelCatalog(input.defaultModel, env, { providerId: input.providerId });
  } catch (error) {
    console.warn(`[AI model] GPT-6 gateway settings are invalid; offering GPT-5.6 only: ${error instanceof Error ? error.message : String(error)}`);
    env = { ...env, BOTBOY_INFERENCE_GPT6_ROLLOUT: 'off' };
    catalog = getChatModelCatalog(input.defaultModel, env, { providerId: input.providerId });
  }
  return catalog.models.map(option => {
    const blessed = option.key !== 'default';
    const route = blessed
      ? resolveBlessedModelRoute(input.defaultModel, option.key, env, { providerId: input.providerId })
      : null;
    const model = route?.model ?? input.defaultModel;
    return {
      key: qualifiedModelKey('team', option.key),
      connectionId: 'team' as const,
      label: option.label,
      family: option.family,
      model,
      route: route ?? { model: input.defaultModel },
      isConnectionDefault: option.isDefault,
      preview: option.preview,
      // A launcher model outside the blessed profiles (self-hosted, legacy
      // Kimi) keeps chat's 32K completion cap: large tool arguments
      // (write_file HTML) need it, and its server enforces its own limit.
      capabilities: blessed
        ? { images: true, contextWindow: input.maxContextTokens, maxOutputTokens: 128_000 }
        : { contextWindow: input.maxContextTokens, maxOutputTokens: Math.max(input.maxCompletionTokens, 32_768) },
    };
  });
}

// ── OpenAI API (owner's key) ──

const OPENAI_CHAT_PREFIX = /^(gpt-|o\d|codex-)/i;
// Families the Responses chat loop cannot use: embeddings, speech, image and
// video generation, moderation, search-only and computer-use models, and the
// legacy completions models.
const OPENAI_NON_CHAT = /(embedding|whisper|tts|transcribe|audio|realtime|dall-e|image|sora|moderation|search|deep-research|computer-use|instruct|babbage|davinci)/i;

/** The base model of a fine-tune (`ft:gpt-4o-mini:org::id` → `gpt-4o-mini`). */
function openAiBaseModel(id: string): string {
  return (id.startsWith('ft:') ? id.slice(3).split(':')[0] : id).toLowerCase();
}

/** Contexts under 32K tokens cannot hold BotBoy's chat prompt and tools. */
function openAiLegacySmallContext(base: string): boolean {
  return /^gpt-3\.5/.test(base) || /^gpt-4(-0314|-0613|-32k.*)?$/.test(base);
}

/** True for OpenAI models BotBoy can run as chat/background models. */
export function isOpenAiChatModelId(id: string): boolean {
  if (!MODEL_ID_PATTERN.test(id)) return false;
  const base = openAiBaseModel(id);
  return OPENAI_CHAT_PREFIX.test(base) && !OPENAI_NON_CHAT.test(base) && !openAiLegacySmallContext(base);
}

export interface OpenAiModelProfile {
  /** Accepts Responses `reasoning` / `include` parameters. */
  readonly reasoning: boolean;
  readonly images?: boolean;
  readonly contextWindow: number;
  readonly maxOutputTokens: number;
}

/**
 * Operating knowledge for hosted OpenAI models, by family. The models API
 * reports no capabilities, so unknown future families get a conservative
 * profile (reasoning on, images unknown, 128K window).
 */
export function openAiModelProfile(id: string): OpenAiModelProfile {
  const base = openAiBaseModel(id);
  const chatVariant = /-chat(-latest)?$/.test(base) || base.includes('-chat-');
  if (/^gpt-(5\.6|6)/.test(base)) {
    return { reasoning: !chatVariant, images: true, contextWindow: 1_000_000, maxOutputTokens: 128_000 };
  }
  if (/^gpt-5/.test(base)) return { reasoning: !chatVariant, images: true, contextWindow: 400_000, maxOutputTokens: 128_000 };
  if (/^gpt-4\.1/.test(base)) return { reasoning: false, images: true, contextWindow: 1_047_576, maxOutputTokens: 32_768 };
  if (/^gpt-4o/.test(base)) return { reasoning: false, images: true, contextWindow: 128_000, maxOutputTokens: 16_384 };
  if (/^gpt-4/.test(base)) return { reasoning: false, contextWindow: 128_000, maxOutputTokens: 4_096 };
  if (/^o1-mini/.test(base)) return { reasoning: true, images: false, contextWindow: 128_000, maxOutputTokens: 65_536 };
  if (/^o3-mini/.test(base)) return { reasoning: true, images: false, contextWindow: 200_000, maxOutputTokens: 100_000 };
  if (/^o\d/.test(base)) return { reasoning: true, images: true, contextWindow: 200_000, maxOutputTokens: 100_000 };
  if (/^codex-/.test(base)) return { reasoning: true, contextWindow: 200_000, maxOutputTokens: 100_000 };
  return { reasoning: true, contextWindow: 128_000, maxOutputTokens: 16_384 };
}

/** Terra when listed, then the other curated models, then any reasoning model. */
export function pickOpenAiDefaultModel(ids: readonly string[]): string {
  if (ids.includes(OPENAI_PLATFORM_DEFAULT_MODEL)) return OPENAI_PLATFORM_DEFAULT_MODEL;
  const curated = OPENAI_PLATFORM_MODEL_IDS.find(id => ids.includes(id));
  if (curated) return curated;
  return ids.find(id => openAiModelProfile(id).reasoning) ?? ids[0] ?? OPENAI_PLATFORM_DEFAULT_MODEL;
}

/** GPT models, then o-series, Codex, and fine-tunes. */
function openAiFamilyRank(id: string): number {
  if (/^gpt-/i.test(id)) return 0;
  if (/^o\d/i.test(id)) return 1;
  if (/^codex-/i.test(id)) return 2;
  if (/^ft:/i.test(id)) return 3;
  return 4;
}

/** Curated models first (catalog order), then every other chat model by family, newest-looking first. */
export function sortOpenAiModelIds(ids: readonly string[]): string[] {
  const unique = [...new Set(ids)];
  const curated = OPENAI_PLATFORM_MODEL_IDS.filter(id => unique.includes(id));
  const others = unique
    .filter(id => !OPENAI_PLATFORM_MODEL_IDS.includes(id))
    .sort((a, b) => openAiFamilyRank(a) - openAiFamilyRank(b) || b.localeCompare(a, 'en', { numeric: true }));
  return [...curated, ...others];
}

export function openAiModelEntries(ids: readonly string[], defaultModel: string): LlmModelEntry[] {
  return sortOpenAiModelIds(ids.filter(isOpenAiChatModelId)).map(id => {
    const blessed = BLESSED_CHAT_MODELS.find(model => model.openaiId === id);
    const profile = openAiModelProfile(id);
    return {
      key: qualifiedModelKey('openai', id),
      connectionId: 'openai' as const,
      label: blessed?.label ?? id,
      ...(blessed ? { family: blessed.family } : {}),
      model: id,
      // One endpoint, plain ids, never a gateway Project header: it would be
      // read as the owner's own OpenAI project selector.
      route: { model: id, ...(profile.reasoning ? {} : { supportsReasoning: false }) },
      isConnectionDefault: id === defaultModel,
      preview: false,
      capabilities: {
        ...(profile.images !== undefined ? { images: profile.images } : {}),
        contextWindow: profile.contextWindow,
        maxOutputTokens: profile.maxOutputTokens,
      },
    };
  });
}

// ── DeepSeek API (owner's key) ──

/** One model as DeepSeek's GET /models reports it (bounded, validated). */
export interface DeepSeekModelProfile {
  readonly id: string;
  readonly name?: string;
  readonly contextWindow?: number;
  readonly maxOutputTokens?: number;
  readonly images?: boolean;
  /** Thinking effort levels the model supports (none is always available). */
  readonly effortLevels?: readonly string[];
}

const DEEPSEEK_DEFAULT_CONTEXT_TOKENS = 1_000_000;
const DEEPSEEK_DEFAULT_MAX_OUTPUT_TOKENS = 384_000;

function boundedTokenCount(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && Number(value) > 0 && Number(value) <= 100_000_000 ? Number(value) : undefined;
}

function displayName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const clean = value.replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim();
  return clean ? clean.slice(0, 80) : undefined;
}

/** Parse DeepSeek's model list (or a stored copy of it); unusable entries are skipped. */
export function parseDeepSeekModelList(value: unknown): DeepSeekModelProfile[] {
  const rows = Array.isArray((value as any)?.data) ? (value as any).data : Array.isArray(value) ? value : [];
  const profiles: DeepSeekModelProfile[] = [];
  const seen = new Set<string>();
  for (const row of rows.slice(0, 200)) {
    const id = typeof row?.id === 'string' ? row.id.trim() : '';
    if (!MODEL_ID_PATTERN.test(id) || seen.has(id)) continue;
    const outputs = row?.output_modalities ?? row?.outputModalities;
    if (Array.isArray(outputs) && !outputs.includes('text')) continue;
    const inputs = row?.input_modalities ?? row?.inputModalities;
    const levels = row?.effort?.supported_levels ?? row?.effortLevels;
    seen.add(id);
    profiles.push({
      id,
      ...(displayName(row?.name) ? { name: displayName(row?.name) } : {}),
      ...(boundedTokenCount(row?.context_window ?? row?.contextWindow) ? { contextWindow: boundedTokenCount(row?.context_window ?? row?.contextWindow) } : {}),
      ...(boundedTokenCount(row?.max_output_tokens ?? row?.maxOutputTokens) ? { maxOutputTokens: boundedTokenCount(row?.max_output_tokens ?? row?.maxOutputTokens) } : {}),
      ...(Array.isArray(inputs) ? { images: inputs.includes('image') } : (typeof row?.images === 'boolean' ? { images: row.images } : {})),
      ...(Array.isArray(levels)
        ? { effortLevels: levels.filter((level: unknown): level is string => typeof level === 'string' && /^[a-z]{1,16}$/.test(level)).slice(0, 8) }
        : {}),
    });
  }
  return profiles;
}

export function pickDeepSeekDefaultModel(profiles: readonly DeepSeekModelProfile[]): string {
  return profiles.find(profile => profile.id === DEEPSEEK_PREFERRED_DEFAULT_MODEL)?.id ?? profiles[0]?.id ?? DEEPSEEK_PREFERRED_DEFAULT_MODEL;
}

export function deepSeekModelCapabilities(profile: DeepSeekModelProfile | undefined): LlmModelCapabilities {
  return {
    ...(profile?.images !== undefined ? { images: profile.images } : {}),
    contextWindow: profile?.contextWindow ?? DEEPSEEK_DEFAULT_CONTEXT_TOKENS,
    maxOutputTokens: profile?.maxOutputTokens ?? DEEPSEEK_DEFAULT_MAX_OUTPUT_TOKENS,
  };
}

export function deepSeekModelEntries(profiles: readonly DeepSeekModelProfile[], defaultModel: string): LlmModelEntry[] {
  return profiles.map(profile => ({
    key: qualifiedModelKey('deepseek', profile.id),
    connectionId: 'deepseek' as const,
    label: profile.name ?? profile.id,
    model: profile.id,
    route: { model: profile.id },
    isConnectionDefault: profile.id === defaultModel,
    preview: false,
    capabilities: deepSeekModelCapabilities(profile),
  }));
}

// ── Model-bound clients ──

export interface BindLlmModelOptions {
  /** Role default for calls that do not ask for thinking themselves. */
  readonly thinking?: LlmThinkingLevel;
  /**
   * Send the model's route even on the connection default. Chat does: its
   * failures must never mark the shared endpoint unhealthy or fall back.
   */
  readonly alwaysRoute?: boolean;
}

function safeInputBudget(contextWindow: number, maxCompletionTokens: number): number {
  const completionReserve = Math.min(maxCompletionTokens, Math.floor(contextWindow / 2));
  const serializationReserve = Math.min(4_096, Math.max(1_024, Math.floor(contextWindow * 0.02)));
  return Math.max(1_024, contextWindow - completionReserve - serializationReserve);
}

/** One connection + one model as an ordinary LlmClient. */
export function bindLlmModel(
  connection: LlmConnection,
  entry: LlmModelEntry,
  options: BindLlmModelOptions = {},
): LlmClient {
  const base = connection.client;
  const thinking = options.thinking ?? 'off';
  const route = options.alwaysRoute || !entry.isConnectionDefault ? entry.route : undefined;
  const modelMaxOutput = entry.capabilities.maxOutputTokens;
  const defaultMaxTokens = (): number => Math.max(1, Math.min(base.getMaxCompletionTokens?.() ?? 16_384, modelMaxOutput));

  function adapt(request: ChatCompletionRequest): ChatCompletionRequest {
    const effectiveRoute = request.route ?? route;
    const maxTokens = Math.max(1, Math.min(request.maxTokens ?? defaultMaxTokens(), modelMaxOutput));
    // The role's Thinking setting applies only where the caller did not ask
    // for thinking itself; explicit requests (document review at max) keep theirs.
    const roleThinking = request.think !== true && thinking !== 'off'
      ? { think: true, reasoningEffort: thinking }
      : {};
    return {
      ...request,
      ...(effectiveRoute ? { route: effectiveRoute } : {}),
      maxTokens,
      ...roleThinking,
    };
  }

  let operation: LlmModelOperation;
  const bound: LlmClient = {
    chatCompletion: request => base.chatCompletion(adapt(request)),
    chatCompletionStream: request => base.chatCompletionStream(adapt(request)),
    preflightPrimary: request => base.preflightPrimary(adapt(request)),
    chatCompletionPrimary: request => base.chatCompletionPrimary(adapt(request)),
    getMaxRequestBytes: () => base.getMaxRequestBytes(),
    // The connection anchor: legacy catalog helpers resolve routes against it.
    getDefaultModel: () => base.getDefaultModel(),
    getProviderId: () => base.getProviderId?.() ?? connection.provider.id,
    getAvailableModels: () => base.getAvailableModels?.(),
    getProviderIssue: () => base.getProviderIssue?.(),
    getModelOperation: () => operation,
    async sendPrompt(prompt, usageContext) {
      const response = await bound.chatCompletion({
        messages: [{ role: 'user', content: prompt }],
        usageContext: usageContext ?? { workload: 'background' },
      });
      return { content: response.content };
    },
    sendMessage: (messages, usageContext) =>
      bound.sendPrompt(messages.map(message => message.content).join('\n'), usageContext),
    initialize: () => base.initialize(),
    isAvailable: () => base.isAvailable(),
    getActiveEndpoint: () => base.getActiveEndpoint(),
    getActiveModel: () => (base.getActiveEndpoint() === 'ollama' ? base.getActiveModel?.() : undefined) ?? entry.model,
    getDialect: () => base.getDialect?.() ?? 'openai',
    getApiMode: () => base.getApiMode?.() ?? connection.provider.apiMode,
    getMaxCompletionTokens: () => defaultMaxTokens(),
    getContextWindow: () => entry.capabilities.contextWindow,
    getContextBudgetTokens: () => Math.max(1_024, Math.min(
      base.getContextBudgetTokens?.() ?? 16_000,
      safeInputBudget(entry.capabilities.contextWindow, defaultMaxTokens()),
    )),
    healthCheck: () => base.healthCheck(),
    // The connection owns its client; a binding has nothing of its own to stop.
    close: () => {},
  };
  operation = Object.freeze({
    connectionId: connection.id,
    modelKey: entry.key,
    label: entry.label,
    provider: Object.freeze({ ...connection.provider, model: entry.model }),
    capabilities: entry.capabilities,
    client: bound,
  });
  return bound;
}
