import {
  createLlmClient,
  type LlmClient,
  type LlmConfig,
  type LlmApiMode,
  type LlmDialect,
  type LlmRequestAuthorizer,
  type ReasoningEffort,
} from './llm-client.js';
import { getBedrockBearerToken, signBedrockRequest } from './aws-sigv4.js';
import { createOAuthClientCredentialsAuthorizer } from './oauth-authorizer.js';
import type { LlmUsageService } from './llm-usage.js';

/**
 * Application-level inference provider.
 *
 * Every generative BotBoy feature receives the single LlmClient created by one
 * provider at startup. The provider owns deployment concerns (endpoint, model,
 * authentication mode, context window, and optional local fallback), while
 * chat, project synthesis, routing, reconciliation, and organization remain
 * independent of where inference runs.
 *
 * `gateway` is intentionally an OpenAI-compatible transport today. The future
 * OIDC/JWT work belongs at this boundary; consumers must not acquire AWS or
 * gateway credentials themselves.
 */
/**
 * 'openai' and 'deepseek' are hosted APIs configured from Settings → AI model
 * (the owner's own keys). They are never derived from environment variables,
 * so an ambient OPENAI_API_KEY or DEEPSEEK_API_KEY can never silently redirect
 * BotBoy's data.
 */
export type InferenceProviderId = 'bedrock' | 'gateway' | 'openai-compatible' | 'openai' | 'deepseek';
/** Providers the launcher/environment can select. */
export type EnvInferenceProviderId = Exclude<InferenceProviderId, 'openai' | 'deepseek'>;

export interface InferenceProvider {
  readonly id: InferenceProviderId;
  readonly endpoint: string;
  readonly model: string;
  readonly apiMode: LlmApiMode;
  readonly maxContextTokens: number;
  readonly localFallbackEnabled: boolean;
  createClient(options?: { usageService?: LlmUsageService }): LlmClient;
}

interface SharedProviderOptions {
  endpoint: string;
  model: string;
  apiMode: LlmApiMode;
  dialect: LlmDialect;
  reasoningEffort?: ReasoningEffort;
  maxContextTokens: number;
  requestTimeoutMs: number;
  maxCompletionTokens: number;
  contextBudgetTokens: number;
  healthCheckIntervalMs: number;
  streamIdleTimeoutMs: number;
  localFallback: boolean;
  ollamaEndpoint: string;
  ollamaModel: string;
  ollamaMaxContextTokens: number;
  ollamaTimeoutMs: number;
}

export interface BedrockInferenceOptions extends Partial<Omit<SharedProviderOptions, 'endpoint' | 'model' | 'dialect'>> {
  endpoint?: string;
  model?: string;
  dialect?: LlmDialect;
  /** Explicit bearer override; otherwise Mantle uses locally generated short-lived tokens. */
  bearerToken?: string;
}

export interface OpenAiCompatibleInferenceOptions extends Omit<SharedProviderOptions, 'apiMode'> {
  apiMode?: LlmApiMode;
  id: 'gateway' | 'openai-compatible';
  apiKey?: string;
  /**
   * Invoked for every gateway request. A later OIDC/JWT implementation can
   * refresh a short-lived token here without changing LlmClient consumers.
   */
  requestAuthorizer?: LlmRequestAuthorizer;
}

const BEDROCK_ENDPOINT = 'https://bedrock-mantle.us-east-1.api.aws/openai/v1';
// Terra replaced Luna as the default model (owner decision 2026-09-03:
// stronger at librarian/routing judgment and general work). Same gpt-5.6
// Responses family and context profile — only the model id changes.
const BEDROCK_MODEL = 'openai.gpt-5.6-terra';

export type ChatModelFamily = 'GPT-5.6' | 'GPT-6' | 'GPT-6.1';

export interface ChatModelCatalogOption {
  readonly key: string;
  readonly label: string;
  readonly family: ChatModelFamily | 'Provider';
  readonly isDefault: boolean;
  readonly preview: boolean;
}

export interface ChatModelCatalog {
  readonly defaultKey: string;
  readonly models: readonly ChatModelCatalogOption[];
}

/** Server-only route; the browser receives only ChatModelCatalogOption. */
export interface ChatModelRoute {
  readonly model: string;
  readonly endpoint?: string;
  readonly headers?: Readonly<Record<string, string>>;
}

/**
 * Server-owned model profiles. GPT-5.6 keeps the proven provider-default
 * Mantle target. GPT-6 Sol/Luna and GPT-6.1 Sol use one explicit east Mantle
 * target so the gateway rewrites to the required /openai/v1 path; that
 * target admits only the exact model ids it lists, so an id added here must
 * also be added there. Astra uses a separate west gateway, Mantle target, and
 * Project.
 */
export const BLESSED_CHAT_MODELS = Object.freeze([
  Object.freeze({
    key: 'terra', label: 'GPT-5.6 Terra', family: 'GPT-5.6',
    bareId: 'openai.gpt-5.6-terra', openaiId: 'gpt-5.6-terra', route: 'provider-default' as const,
  }),
  Object.freeze({
    key: 'luna', label: 'GPT-5.6 Luna', family: 'GPT-5.6',
    bareId: 'openai.gpt-5.6-luna', openaiId: 'gpt-5.6-luna', route: 'provider-default' as const,
  }),
  Object.freeze({
    key: 'sol', label: 'GPT-5.6 Sol', family: 'GPT-5.6',
    bareId: 'openai.gpt-5.6-sol', openaiId: 'gpt-5.6-sol', route: 'provider-default' as const,
  }),
  Object.freeze({
    key: 'gpt6-astra', label: 'GPT-6 Astra', family: 'GPT-6',
    bareId: 'openai.gpt-6-astra', openaiId: 'gpt-6-astra', route: 'gpt6-astra-west' as const,
  }),
  Object.freeze({
    key: 'gpt6-sol', label: 'GPT-6 Sol', family: 'GPT-6',
    bareId: 'openai.gpt-6-sol', openaiId: 'gpt-6-sol', route: 'gpt6-east-mantle' as const,
  }),
  Object.freeze({
    key: 'gpt6-luna', label: 'GPT-6 Luna', family: 'GPT-6',
    bareId: 'openai.gpt-6-luna', openaiId: 'gpt-6-luna', route: 'gpt6-east-mantle' as const,
  }),
  Object.freeze({
    key: 'gpt6.1-sol', label: 'GPT-6.1 Sol', family: 'GPT-6.1',
    bareId: 'openai.gpt-6.1-sol', openaiId: 'gpt-6.1-sol', route: 'gpt6-east-mantle' as const,
  }),
] as const);

/**
 * Hosted OpenAI API profile (Settings → AI model). Every catalog model uses
 * the platform's plain id on one endpoint; there are no gateway targets,
 * alternate endpoints, or Mantle Project headers. Background work stays on
 * GPT-5.6 Terra, exactly as on the team gateway.
 */
export const OPENAI_PLATFORM_ENDPOINT = 'https://api.openai.com/v1';
export const OPENAI_PLATFORM_DEFAULT_MODEL = 'gpt-5.6-terra';
/** OpenAI lists 1.05M-token windows for these models; keep the gateway's 1M profile. */
const OPENAI_PLATFORM_MAX_CONTEXT_TOKENS = 1_000_000;

/** Catalog ids the hosted OpenAI API must list for a model to be offered. */
export const OPENAI_PLATFORM_MODEL_IDS: readonly string[] = Object.freeze(
  BLESSED_CHAT_MODELS.map(model => model.openaiId),
);

/** Provider facts the catalog needs beyond the default model id. */
export interface ChatModelCatalogContext {
  readonly providerId?: string;
  /** Plain OpenAI ids the configured key can call; undefined = not reported. */
  readonly availableModels?: readonly string[];
}

function openAiPlatformCatalog(
  providerDefaultModel: string,
  availableModels: readonly string[] | undefined,
): ChatModelCatalog {
  const available = new Set(availableModels ?? OPENAI_PLATFORM_MODEL_IDS);
  const offered = BLESSED_CHAT_MODELS.filter(model => available.has(model.openaiId));
  const defaultEntry = offered.find(model => model.openaiId === providerDefaultModel);
  if (!offered.length) {
    return {
      defaultKey: 'default',
      models: [{ key: 'default', label: 'Provider default', family: 'Provider', isDefault: true, preview: false }],
    };
  }
  const models = offered.map(model => ({
    key: model.key,
    label: model.label,
    family: model.family,
    isDefault: model === defaultEntry,
    // Generally available on the hosted API; the gateway's GPT-6 preview
    // attestation does not apply to the owner's own OpenAI account.
    preview: false,
  }));
  return defaultEntry
    ? { defaultKey: defaultEntry.key, models }
    : {
        defaultKey: 'default',
        models: [
          { key: 'default', label: 'Provider default', family: 'Provider', isDefault: true, preview: false },
          ...models,
        ],
      };
}
export type BlessedModelKey = (typeof BLESSED_CHAT_MODELS)[number]['key'];

interface Gpt6GatewayConfig {
  readonly eastTarget: string;
  readonly astraTarget: string;
  readonly astraEndpoint: string;
  readonly astraProject: string;
}

function gatewayTargetPrefix(model: string): string | null {
  const slash = model.lastIndexOf('/');
  // A target-qualified gateway id has a non-empty target before the slash.
  // Local/Hugging Face model paths are rejected later unless their suffix is
  // one of the exact proven provider-default profiles.
  return slash > 0 && !model.startsWith('/') ? model.slice(0, slash + 1) : null;
}

function validatedTarget(value: string | undefined, setting: string): string {
  const target = value?.trim() ?? '';
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,99}$/.test(target)) {
    throw new Error(`${setting} must be one AgentCore target name without slashes.`);
  }
  return target;
}

function validatedAstraEndpoint(value: string | undefined): string {
  const raw = value?.trim() ?? '';
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('BOTBOY_INFERENCE_GPT6_ASTRA_ENDPOINT must be the approved west AgentCore inference URL.');
  }
  const expectedHost = /^[a-z0-9-]+\.gateway\.bedrock-agentcore\.us-west-2\.amazonaws\.com$/;
  if (url.protocol !== 'https:' || !expectedHost.test(url.hostname)
    || url.username || url.password || url.search || url.hash
    || url.pathname.replace(/\/+$/, '') !== '/inference/v1') {
    throw new Error('BOTBOY_INFERENCE_GPT6_ASTRA_ENDPOINT must be an HTTPS us-west-2 AgentCore /inference/v1 URL.');
  }
  return `${url.origin}/inference/v1`;
}

function gpt6GatewayConfig(env: NodeJS.ProcessEnv): Gpt6GatewayConfig | null {
  const rollout = (env.BOTBOY_INFERENCE_GPT6_ROLLOUT ?? 'off').trim().toLowerCase();
  if (rollout !== 'off' && rollout !== 'preview') {
    throw new Error('Unsupported BOTBOY_INFERENCE_GPT6_ROLLOUT: use off or preview.');
  }
  if (rollout === 'off') return null;

  const eastTarget = validatedTarget(
    env.BOTBOY_INFERENCE_GPT6_EAST_TARGET,
    'BOTBOY_INFERENCE_GPT6_EAST_TARGET',
  );
  const astraTarget = validatedTarget(
    env.BOTBOY_INFERENCE_GPT6_ASTRA_TARGET,
    'BOTBOY_INFERENCE_GPT6_ASTRA_TARGET',
  );
  const astraEndpoint = validatedAstraEndpoint(env.BOTBOY_INFERENCE_GPT6_ASTRA_ENDPOINT);
  const astraProject = env.BOTBOY_INFERENCE_GPT6_ASTRA_PROJECT?.trim() ?? '';
  if (!/^proj_[a-z0-9]{20}$/.test(astraProject)) {
    throw new Error('BOTBOY_INFERENCE_GPT6_ASTRA_PROJECT must be the dedicated west Mantle Project id.');
  }
  return { eastTarget, astraTarget, astraEndpoint, astraProject };
}

/**
 * Return only routes the active provider can actually serve. The browser owns
 * no model ids, endpoints, targets, headers, or credentials.
 */
export function getChatModelCatalog(
  providerDefaultModel: string,
  env: NodeJS.ProcessEnv = process.env,
  context: ChatModelCatalogContext = {},
): ChatModelCatalog {
  if (context.providerId === 'openai') {
    return openAiPlatformCatalog(providerDefaultModel, context.availableModels);
  }
  const configuredGpt6 = gpt6GatewayConfig(env);
  const defaultProfile = BLESSED_CHAT_MODELS.find(
    candidate => candidate.route === 'provider-default'
      && providerDefaultModel.endsWith(candidate.bareId),
  );
  const inheritedTarget = gatewayTargetPrefix(providerDefaultModel);
  const directBedrock = defaultProfile ? providerDefaultModel === defaultProfile.bareId : false;
  const supportsBlessedProfiles = Boolean(defaultProfile && (inheritedTarget || directBedrock));
  if (!supportsBlessedProfiles) {
    return {
      defaultKey: 'default',
      models: [{
        key: 'default', label: 'Provider default', family: 'Provider', isDefault: true, preview: false,
      }],
    };
  }

  const gpt6 = inheritedTarget ? configuredGpt6 : null;
  const models = BLESSED_CHAT_MODELS
    .filter(model => model.route === 'provider-default' || gpt6 !== null)
    .map(model => ({
      key: model.key,
      label: model.label,
      family: model.family,
      isDefault: model === defaultProfile,
      preview: model.route !== 'provider-default',
    }));
  return {
    defaultKey: defaultProfile?.key ?? 'default',
    models: defaultProfile ? models : [
      { key: 'default', label: 'Provider default', family: 'Provider', isDefault: true, preview: false },
      ...models,
    ],
  };
}

/** Resolve one admitted key to its exact internal provider route. */
export function resolveBlessedModelRoute(
  providerDefaultModel: string,
  key: unknown,
  env: NodeJS.ProcessEnv = process.env,
  context: ChatModelCatalogContext = {},
): ChatModelRoute | null {
  const entry = BLESSED_CHAT_MODELS.find(candidate => candidate.key === key);
  if (!entry) return null;
  if (context.providerId === 'openai') {
    // One endpoint, plain ids, no route headers: a gateway Project id sent
    // here would be read as the owner's own OpenAI project selector.
    const available = context.availableModels ?? OPENAI_PLATFORM_MODEL_IDS;
    return available.includes(entry.openaiId) ? { model: entry.openaiId } : null;
  }
  const defaultProfile = BLESSED_CHAT_MODELS.find(
    candidate => candidate.route === 'provider-default'
      && providerDefaultModel.endsWith(candidate.bareId),
  );
  if (!defaultProfile) return null;

  const target = gatewayTargetPrefix(providerDefaultModel);
  const directBedrock = providerDefaultModel === defaultProfile.bareId;
  if (!target && !directBedrock) return null;
  if (entry.route === 'provider-default') {
    return { model: `${target ?? ''}${entry.bareId}` };
  }

  const config = target ? gpt6GatewayConfig(env) : null;
  if (!config) return null;
  if (entry.route === 'gpt6-astra-west') {
    return {
      model: `${config.astraTarget}/${entry.bareId}`,
      endpoint: config.astraEndpoint,
      headers: { 'OpenAI-Project': config.astraProject },
    };
  }
  return { model: `${config.eastTarget}/${entry.bareId}` };
}

/** Backward-compatible model-only projection used by focused callers/tests. */
export function resolveBlessedModelId(
  providerDefaultModel: string,
  key: unknown,
  env: NodeJS.ProcessEnv = process.env,
  context: ChatModelCatalogContext = {},
): string | null {
  return resolveBlessedModelRoute(providerDefaultModel, key, env, context)?.model ?? null;
}

/** Catalog context for one live client: its provider id and per-key model list. */
export function chatModelCatalogContext(client: {
  getProviderId?(): string | undefined;
  getAvailableModels?(): readonly string[] | undefined;
}): ChatModelCatalogContext {
  return {
    providerId: client.getProviderId?.(),
    availableModels: client.getAvailableModels?.(),
  };
}
const BEDROCK_MAX_CONTEXT_TOKENS = 1_000_000;
const LEGACY_BEDROCK_MODEL = 'moonshotai.kimi-k2.5';
const LEGACY_BEDROCK_MAX_CONTEXT_TOKENS = 262_144;
const OPENAI_COMPATIBLE_MODEL = '/app/models/qwen35-35b-a3b-fp8';
const OPENAI_COMPATIBLE_MAX_CONTEXT_TOKENS = 32768;
// AgentCore gateway model ids carry the gateway target name as a prefix.
// The 'bedrock-mantle-luna/' prefix is the DEPLOYMENT's target name (fixed
// infrastructure, named when Luna was the default) — not the model. The
// model segment after the slash is what actually selects Terra.
const GATEWAY_MODEL = 'bedrock-mantle-luna/openai.gpt-5.6-terra';
const GATEWAY_MAX_CONTEXT_TOKENS = BEDROCK_MAX_CONTEXT_TOKENS;
// Team deployment defaults, baked in so a teammate's .env needs only their
// personal client id/secret. None of these are secrets: the gateway rejects
// unauthenticated calls (401) and the issuer discovery document is public by
// design. The per-teammate CLIENT_ID/CLIENT_SECRET are the only credentials
// and must never be committed.
const GATEWAY_DEFAULT_ENDPOINT =
  'https://botboy-luna-gateway-tyagefrrnz.gateway.bedrock-agentcore.us-east-1.amazonaws.com/inference/v1';
const GATEWAY_DEFAULT_TOKEN_URL =
  'https://botboy-luna-603949561274.auth.us-east-1.amazoncognito.com/oauth2/token';
const GATEWAY_DEFAULT_SCOPE = 'botboy-llm/invoke';

const SHARED_DEFAULTS = {
  reasoningEffort: undefined,
  requestTimeoutMs: 300000,
  maxCompletionTokens: 16384,
  contextBudgetTokens: 100000,
  healthCheckIntervalMs: 30000,
  streamIdleTimeoutMs: 120000,
  localFallback: false,
  ollamaEndpoint: 'http://localhost:11434',
  ollamaModel: 'qwen3.5:9b',
  ollamaMaxContextTokens: 131072,
  ollamaTimeoutMs: 300000,
} satisfies Omit<SharedProviderOptions, 'endpoint' | 'model' | 'apiMode' | 'dialect' | 'maxContextTokens'>;

const authorizeLegacyBedrockRequest: LlmRequestAuthorizer = ({ url, method, body }) =>
  signBedrockRequest(url, method, body);

const authorizeBedrockMantleRequest: LlmRequestAuthorizer = async ({ url }) => ({
  Authorization: `Bearer ${await getBedrockBearerToken(url)}`,
});

function createStaticBearerAuthorizer(apiKey: string): LlmRequestAuthorizer {
  return async () => ({ Authorization: `Bearer ${apiKey}` });
}

function buildLlmConfig(
  options: SharedProviderOptions,
  auth: {
    authMode: 'apiKey' | 'sigv4';
    apiKey?: string;
    requestAuthorizer?: LlmRequestAuthorizer;
  },
  model: { supportsReasoning?: boolean } = {},
): LlmConfig {
  return {
    ecs: {
      endpoint: options.endpoint,
      model: options.model,
      apiMode: options.apiMode,
      maxContextTokens: options.maxContextTokens,
      requestTimeoutMs: options.requestTimeoutMs,
      dialect: options.dialect,
      reasoningEffort: options.reasoningEffort,
      authMode: auth.authMode,
      apiKey: auth.apiKey,
      requestAuthorizer: auth.requestAuthorizer,
      ...(model.supportsReasoning === false ? { supportsReasoning: false } : {}),
    },
    // A fallback endpoint is omitted entirely unless explicitly enabled. This
    // prevents background intelligence from silently switching models.
    ollama: {
      endpoint: options.localFallback ? options.ollamaEndpoint : '',
      model: options.ollamaModel,
      maxContextTokens: options.ollamaMaxContextTokens,
      requestTimeoutMs: options.ollamaTimeoutMs,
    },
    defaults: {
      temperature: 0.7,
      maxCompletionTokens: options.maxCompletionTokens,
      contextBudgetTokens: options.contextBudgetTokens,
    },
    healthCheckIntervalMs: options.healthCheckIntervalMs,
    fallbackEnabled: options.localFallback,
    streamIdleTimeoutMs: options.streamIdleTimeoutMs,
  };
}

function provider(
  id: InferenceProviderId,
  options: SharedProviderOptions,
  config: LlmConfig,
): InferenceProvider {
  // Each client stamps its own provider on usage rows and catalog lookups, so
  // a runtime provider change can never inherit another provider's identity.
  const identifiedConfig: LlmConfig = { ...config, providerId: config.providerId ?? id };
  return {
    id,
    endpoint: options.endpoint,
    model: options.model,
    apiMode: options.apiMode,
    maxContextTokens: options.maxContextTokens,
    localFallbackEnabled: options.localFallback,
    createClient: (clientOptions = {}) => createLlmClient(identifiedConfig, clientOptions.usageService),
  };
}

function inferBedrockApiMode(endpoint: string): LlmApiMode {
  return endpoint.includes('bedrock-runtime.') ? 'chat-completions' : 'responses';
}

/** Direct Bedrock provider used by developers and the default BotBoy runtime. */
export function createBedrockInferenceProvider(
  overrides: BedrockInferenceOptions = {},
): InferenceProvider {
  const endpoint = overrides.endpoint ?? BEDROCK_ENDPOINT;
  const apiMode = overrides.apiMode ?? inferBedrockApiMode(endpoint);
  const legacyChat = apiMode === 'chat-completions';
  const options: SharedProviderOptions = {
    endpoint,
    apiMode,
    model: overrides.model ?? (legacyChat ? LEGACY_BEDROCK_MODEL : BEDROCK_MODEL),
    dialect: overrides.dialect ?? (legacyChat ? 'kimi' : 'openai'),
    reasoningEffort: overrides.reasoningEffort ?? (legacyChat ? undefined : 'low'),
    maxContextTokens: overrides.maxContextTokens
      ?? (legacyChat ? LEGACY_BEDROCK_MAX_CONTEXT_TOKENS : BEDROCK_MAX_CONTEXT_TOKENS),
    requestTimeoutMs: overrides.requestTimeoutMs ?? SHARED_DEFAULTS.requestTimeoutMs,
    maxCompletionTokens: overrides.maxCompletionTokens ?? SHARED_DEFAULTS.maxCompletionTokens,
    contextBudgetTokens: overrides.contextBudgetTokens ?? SHARED_DEFAULTS.contextBudgetTokens,
    healthCheckIntervalMs: overrides.healthCheckIntervalMs ?? SHARED_DEFAULTS.healthCheckIntervalMs,
    streamIdleTimeoutMs: overrides.streamIdleTimeoutMs ?? SHARED_DEFAULTS.streamIdleTimeoutMs,
    localFallback: overrides.localFallback ?? SHARED_DEFAULTS.localFallback,
    ollamaEndpoint: overrides.ollamaEndpoint ?? SHARED_DEFAULTS.ollamaEndpoint,
    ollamaModel: overrides.ollamaModel ?? SHARED_DEFAULTS.ollamaModel,
    ollamaMaxContextTokens: overrides.ollamaMaxContextTokens ?? SHARED_DEFAULTS.ollamaMaxContextTokens,
    ollamaTimeoutMs: overrides.ollamaTimeoutMs ?? SHARED_DEFAULTS.ollamaTimeoutMs,
  };

  const bearerToken = overrides.bearerToken?.trim();
  const requestAuthorizer = bearerToken
    ? createStaticBearerAuthorizer(bearerToken)
    : (apiMode === 'responses' ? authorizeBedrockMantleRequest : authorizeLegacyBedrockRequest);
  return provider('bedrock', options, buildLlmConfig(options, {
    authMode: bearerToken || apiMode === 'responses' ? 'apiKey' : 'sigv4',
    requestAuthorizer,
  }));
}

/** OpenAI-compatible provider used for the future authenticated gateway and legacy vLLM. */
export function createOpenAiCompatibleInferenceProvider(
  options: OpenAiCompatibleInferenceOptions,
): InferenceProvider {
  const requestAuthorizer = options.requestAuthorizer
    ?? (options.apiKey ? createStaticBearerAuthorizer(options.apiKey) : undefined);
  if (options.id === 'gateway' && !requestAuthorizer) {
    throw new Error(
      'gateway inference requires BOTBOY_INFERENCE_OAUTH_CLIENT_ID + '
      + 'BOTBOY_INFERENCE_OAUTH_CLIENT_SECRET (your personal credentials), '
      + 'BOTBOY_INFERENCE_API_KEY, or a requestAuthorizer',
    );
  }
  const normalizedOptions: SharedProviderOptions = {
    ...options,
    // The authenticated gateway fronts Bedrock Mantle, which is Responses-native.
    apiMode: options.apiMode ?? (options.id === 'gateway' ? 'responses' : 'chat-completions'),
  };
  return provider(options.id, normalizedOptions, buildLlmConfig(normalizedOptions, {
    authMode: 'apiKey',
    apiKey: options.apiKey,
    requestAuthorizer,
  }));
}

function positiveIntSetting(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function nonNegativeIntSetting(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function boolSetting(value: string | undefined, fallback: boolean): boolean {
  if (value == null || value.trim() === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

function reasoningSetting(value: string | undefined): ReasoningEffort | undefined {
  return value === 'low' || value === 'high' || value === 'max' ? value : undefined;
}

function dialectSetting(value: string | undefined, fallback: LlmDialect): LlmDialect {
  return value === 'kimi' || value === 'qwen' || value === 'openai' ? value : fallback;
}

function apiModeSetting(value: string | undefined, fallback: LlmApiMode): LlmApiMode {
  if (value == null || value.trim() === '') return fallback;
  if (value === 'chat-completions' || value === 'responses') return value;
  throw new Error(`Unsupported BOTBOY_INFERENCE_API_MODE: ${value}`);
}

/**
 * Provider-independent runtime settings (timeouts, budgets, health cadence,
 * opt-in local fallback). Shared by every provider so switching providers at
 * runtime keeps the owner's tuning.
 */
function runtimeSettingsFromEnv(env: NodeJS.ProcessEnv) {
  return {
    requestTimeoutMs: nonNegativeIntSetting(
      env.BOTBOY_INFERENCE_TIMEOUT_MS ?? env.VLLM_TIMEOUT_MS,
      SHARED_DEFAULTS.requestTimeoutMs,
    ),
    maxCompletionTokens: positiveIntSetting(
      env.BOTBOY_INFERENCE_MAX_COMPLETION_TOKENS,
      SHARED_DEFAULTS.maxCompletionTokens,
    ),
    contextBudgetTokens: positiveIntSetting(
      env.BOTBOY_INFERENCE_CONTEXT_BUDGET_TOKENS,
      SHARED_DEFAULTS.contextBudgetTokens,
    ),
    // Zero disables periodic probes; an explicit healthCheck() still works.
    healthCheckIntervalMs: nonNegativeIntSetting(
      env.BOTBOY_INFERENCE_HEALTH_INTERVAL_MS,
      SHARED_DEFAULTS.healthCheckIntervalMs,
    ),
    streamIdleTimeoutMs: nonNegativeIntSetting(
      env.BOTBOY_INFERENCE_STREAM_IDLE_TIMEOUT_MS ?? env.VLLM_STREAM_IDLE_TIMEOUT_MS,
      SHARED_DEFAULTS.streamIdleTimeoutMs,
    ),
    localFallback: boolSetting(
      env.BOTBOY_LOCAL_LLM_FALLBACK ?? env.LLM_FALLBACK_ENABLED,
      false,
    ),
    ollamaEndpoint: env.OLLAMA_ENDPOINT || SHARED_DEFAULTS.ollamaEndpoint,
    ollamaModel: env.OLLAMA_MODEL || SHARED_DEFAULTS.ollamaModel,
    ollamaMaxContextTokens: positiveIntSetting(
      env.OLLAMA_MAX_CONTEXT_TOKENS,
      SHARED_DEFAULTS.ollamaMaxContextTokens,
    ),
    ollamaTimeoutMs: nonNegativeIntSetting(
      env.OLLAMA_TIMEOUT_MS,
      SHARED_DEFAULTS.ollamaTimeoutMs,
    ),
  };
}

export interface OpenAiPlatformInferenceOptions {
  /** The owner's OpenAI API key. Held only by the request authorizer. */
  apiKey: string;
  /** Plain chat-model ids the key reported (GET /v1/models); undefined = unknown. */
  availableModels?: readonly string[];
  /**
   * The connection's default model (health probe, route-less calls).
   * Defaults to GPT-5.6 Terra; Settings picks one the key actually lists.
   */
  defaultModel?: string;
  /** Context window of the default model (route-less budget math). */
  defaultContextTokens?: number;
  /** false when the default model rejects Responses reasoning parameters. */
  defaultSupportsReasoning?: boolean;
  /** Test seam only; production always uses the hosted OpenAI API. */
  endpoint?: string;
  /** Runtime tuning source (timeouts, health cadence, fallback). */
  env?: NodeJS.ProcessEnv;
}

/**
 * The hosted OpenAI API with the owner's key: Responses wire, OpenAI dialect,
 * and the per-key model list. Which model serves chat, organizing, and
 * document writing is chosen per use (Settings → AI model); the default model
 * here only anchors the free health probe and route-less calls.
 */
export function createOpenAiPlatformInferenceProvider(
  options: OpenAiPlatformInferenceOptions,
): InferenceProvider {
  const apiKey = options.apiKey.trim();
  if (!apiKey) throw new Error('An OpenAI API key is required.');
  const env = options.env ?? process.env;
  const settings: SharedProviderOptions = {
    endpoint: (options.endpoint ?? OPENAI_PLATFORM_ENDPOINT).replace(/\/+$/, ''),
    model: options.defaultModel?.trim() || OPENAI_PLATFORM_DEFAULT_MODEL,
    apiMode: 'responses',
    dialect: 'openai',
    reasoningEffort: reasoningSetting(env.BOTBOY_INFERENCE_REASONING_EFFORT) ?? 'low',
    maxContextTokens: options.defaultContextTokens ?? OPENAI_PLATFORM_MAX_CONTEXT_TOKENS,
    ...runtimeSettingsFromEnv(env),
  };
  const config = buildLlmConfig(settings, {
    authMode: 'apiKey',
    requestAuthorizer: createStaticBearerAuthorizer(apiKey),
  }, { supportsReasoning: options.defaultSupportsReasoning });
  return provider('openai', settings, {
    ...config,
    providerId: 'openai',
    platform: 'openai',
    ...(options.availableModels ? { availableModels: Object.freeze([...options.availableModels]) } : {}),
  });
}

/** DeepSeek API (Settings → AI model). Responses lives at the base URL. */
export const DEEPSEEK_PLATFORM_ENDPOINT = 'https://api.deepseek.com';
/** Preferred default when the key lists it: vision-capable and fastest. */
export const DEEPSEEK_PREFERRED_DEFAULT_MODEL = 'deepseek-flash';
/** DeepSeek's documented V4 profile, used only when GET /models omits a value. */
const DEEPSEEK_DEFAULT_CONTEXT_TOKENS = 1_000_000;

export interface DeepSeekInferenceOptions {
  /** The owner's DeepSeek API key. Held only by the request authorizer. */
  apiKey: string;
  /** Model ids the key reported (GET /models). */
  availableModels: readonly string[];
  /** The connection's default model (route-less calls); must be listed. */
  defaultModel: string;
  /** Context window of the default model, from GET /models. */
  defaultContextTokens?: number;
  /** Test seam only; production always uses the hosted DeepSeek API. */
  endpoint?: string;
  /** Runtime tuning source (timeouts, health cadence, fallback). */
  env?: NodeJS.ProcessEnv;
}

/**
 * The hosted DeepSeek API with the owner's key, on its Responses surface:
 * the same wire and dialect as OpenAI, with DeepSeek's effort levels and
 * error codes handled by `platform: 'deepseek'` in llm-client.ts.
 */
export function createDeepSeekInferenceProvider(options: DeepSeekInferenceOptions): InferenceProvider {
  const apiKey = options.apiKey.trim();
  if (!apiKey) throw new Error('A DeepSeek API key is required.');
  const defaultModel = options.defaultModel.trim();
  if (!defaultModel) throw new Error('A DeepSeek default model is required.');
  const env = options.env ?? process.env;
  const settings: SharedProviderOptions = {
    endpoint: (options.endpoint ?? DEEPSEEK_PLATFORM_ENDPOINT).replace(/\/+$/, ''),
    model: defaultModel,
    apiMode: 'responses',
    dialect: 'openai',
    reasoningEffort: reasoningSetting(env.BOTBOY_INFERENCE_REASONING_EFFORT) ?? 'low',
    maxContextTokens: options.defaultContextTokens ?? DEEPSEEK_DEFAULT_CONTEXT_TOKENS,
    ...runtimeSettingsFromEnv(env),
  };
  const config = buildLlmConfig(settings, {
    authMode: 'apiKey',
    requestAuthorizer: createStaticBearerAuthorizer(apiKey),
  });
  return provider('deepseek', settings, {
    ...config,
    providerId: 'deepseek',
    platform: 'deepseek',
    availableModels: Object.freeze([...options.availableModels]),
  });
}

function inferProvider(env: NodeJS.ProcessEnv): InferenceProviderId {
  const endpoint = (env.BOTBOY_INFERENCE_ENDPOINT || env.VLLM_ENDPOINT)?.trim();
  const authMode = env.VLLM_AUTH_MODE?.trim().toLowerCase();
  if (authMode === 'sigv4' || endpoint?.includes('bedrock-runtime.') || endpoint?.includes('bedrock-mantle.')) {
    return 'bedrock';
  }
  // Teammate mode: OAuth client credentials imply the authenticated gateway,
  // so a two-line .env (client id + secret) selects the right provider.
  if (env.BOTBOY_INFERENCE_OAUTH_CLIENT_ID?.trim() || env.BOTBOY_INFERENCE_OAUTH_CLIENT_SECRET?.trim()) {
    return 'gateway';
  }
  if (authMode === 'apikey' || endpoint) return 'openai-compatible';
  return 'bedrock';
}

/** Resolve explicit product configuration first, then legacy vLLM intent. */
export function resolveInferenceProviderId(
  env: NodeJS.ProcessEnv = process.env,
): EnvInferenceProviderId {
  const providerName = (env.BOTBOY_INFERENCE_PROVIDER || '').trim().toLowerCase()
    || inferProvider(env);
  if (providerName === 'openai' || providerName === 'deepseek') {
    const label = providerName === 'openai' ? 'OpenAI' : 'DeepSeek';
    throw new Error(`BOTBOY_INFERENCE_PROVIDER=${providerName} is not an environment setting. Add your ${label} API key in BotBoy Settings → AI model instead, and remove this variable.`);
  }
  if (providerName !== 'bedrock' && providerName !== 'gateway' && providerName !== 'openai-compatible') {
    throw new Error(`Unsupported BOTBOY_INFERENCE_PROVIDER: ${providerName}`);
  }
  return providerName;
}

/** Default context profile shared by provider construction and runtime limits. */
export function defaultInferenceMaxContextTokens(id: InferenceProviderId): number {
  if (id === 'bedrock') return BEDROCK_MAX_CONTEXT_TOKENS;
  if (id === 'gateway') return GATEWAY_MAX_CONTEXT_TOKENS;
  if (id === 'openai') return OPENAI_PLATFORM_MAX_CONTEXT_TOKENS;
  if (id === 'deepseek') return DEEPSEEK_DEFAULT_CONTEXT_TOKENS;
  return OPENAI_COMPATIBLE_MAX_CONTEXT_TOKENS;
}

/**
 * Composition-root loader. New BOTBOY_* names express product intent; VLLM_*
 * aliases preserve existing developer launch scripts during migration.
 */
export function createInferenceProviderFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): InferenceProvider {
  const id = resolveInferenceProviderId(env);
  const configuredEndpoint = env.BOTBOY_INFERENCE_ENDPOINT || env.VLLM_ENDPOINT;
  const endpoint = configuredEndpoint
    || (id === 'bedrock' ? BEDROCK_ENDPOINT : id === 'gateway' ? GATEWAY_DEFAULT_ENDPOINT : '');
  const defaultApiMode: LlmApiMode = id === 'bedrock'
    ? inferBedrockApiMode(endpoint)
    : id === 'gateway'
      ? 'responses'
      : 'chat-completions';
  const apiMode = apiModeSetting(env.BOTBOY_INFERENCE_API_MODE, defaultApiMode);
  const lunaProfile = id === 'bedrock' && apiMode === 'responses';
  const providerDefaults = id === 'gateway'
    ? {
        // The gateway fronts Bedrock Mantle: OpenAI Responses semantics with
        // target-prefixed model ids, same Luna context profile as bedrock.
        model: GATEWAY_MODEL,
        dialect: 'openai' as const,
        reasoningEffort: 'low' as const,
        maxContextTokens: GATEWAY_MAX_CONTEXT_TOKENS,
      }
    : id === 'openai-compatible'
    ? {
        model: OPENAI_COMPATIBLE_MODEL,
        dialect: 'qwen' as const,
        reasoningEffort: undefined,
        maxContextTokens: OPENAI_COMPATIBLE_MAX_CONTEXT_TOKENS,
      }
    : lunaProfile
      ? {
          model: BEDROCK_MODEL,
          dialect: 'openai' as const,
          reasoningEffort: 'low' as const,
          maxContextTokens: BEDROCK_MAX_CONTEXT_TOKENS,
        }
      : {
          model: LEGACY_BEDROCK_MODEL,
          dialect: 'kimi' as const,
          reasoningEffort: undefined,
          maxContextTokens: LEGACY_BEDROCK_MAX_CONTEXT_TOKENS,
        };
  const shared = {
    apiMode,
    reasoningEffort: reasoningSetting(
      env.BOTBOY_INFERENCE_REASONING_EFFORT ?? env.VLLM_REASONING_EFFORT,
    ) ?? providerDefaults.reasoningEffort,
    maxContextTokens: positiveIntSetting(
      env.BOTBOY_INFERENCE_MAX_CONTEXT_TOKENS ?? env.VLLM_MAX_CONTEXT_TOKENS,
      providerDefaults.maxContextTokens,
    ),
    ...runtimeSettingsFromEnv(env),
  };

  if (id === 'bedrock') {
    return createBedrockInferenceProvider({
      endpoint,
      model: env.BOTBOY_INFERENCE_MODEL || env.VLLM_MODEL || providerDefaults.model,
      dialect: dialectSetting(
        env.BOTBOY_INFERENCE_DIALECT ?? env.VLLM_DIALECT,
        providerDefaults.dialect,
      ),
      bearerToken: env.BOTBOY_INFERENCE_API_KEY || env.AWS_BEARER_TOKEN_BEDROCK,
      ...shared,
    });
  }

  if (!endpoint) {
    throw new Error(`${id} inference requires BOTBOY_INFERENCE_ENDPOINT (or legacy VLLM_ENDPOINT)`);
  }
  // OAuth client-credentials (teammate mode): mint short-lived gateway JWTs
  // from a client id/secret. Takes precedence over a static API key so a
  // deployment can carry both without ambiguity. The gateway profile bakes in
  // token URL and scope; only the per-person id/secret are ever configured.
  const oauthTokenUrl = env.BOTBOY_INFERENCE_OAUTH_TOKEN_URL?.trim()
    || (id === 'gateway' ? GATEWAY_DEFAULT_TOKEN_URL : undefined);
  const oauthClientId = env.BOTBOY_INFERENCE_OAUTH_CLIENT_ID?.trim();
  const oauthClientSecret = env.BOTBOY_INFERENCE_OAUTH_CLIENT_SECRET?.trim();
  const oauthConfigured = Boolean(oauthClientId || oauthClientSecret
    || env.BOTBOY_INFERENCE_OAUTH_TOKEN_URL?.trim());
  if (oauthConfigured && !(oauthTokenUrl && oauthClientId && oauthClientSecret)) {
    throw new Error(
      'Incomplete OAuth config: BOTBOY_INFERENCE_OAUTH_CLIENT_ID and '
      + 'BOTBOY_INFERENCE_OAUTH_CLIENT_SECRET must both be set '
      + '(BOTBOY_INFERENCE_OAUTH_TOKEN_URL defaults for the gateway provider)',
    );
  }
  const requestAuthorizer = oauthConfigured
    ? createOAuthClientCredentialsAuthorizer({
        tokenUrl: oauthTokenUrl!,
        clientId: oauthClientId!,
        clientSecret: oauthClientSecret!,
        scope: env.BOTBOY_INFERENCE_OAUTH_SCOPE
          ?? (id === 'gateway' ? GATEWAY_DEFAULT_SCOPE : undefined),
      })
    : undefined;
  return createOpenAiCompatibleInferenceProvider({
    id,
    endpoint,
    model: env.BOTBOY_INFERENCE_MODEL || env.VLLM_MODEL || providerDefaults.model,
    dialect: dialectSetting(
      env.BOTBOY_INFERENCE_DIALECT ?? env.VLLM_DIALECT,
      providerDefaults.dialect,
    ),
    apiKey: env.BOTBOY_INFERENCE_API_KEY || env.VLLM_API_KEY,
    requestAuthorizer,
    ...shared,
  });
}
