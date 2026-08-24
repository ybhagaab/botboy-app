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
export type InferenceProviderId = 'bedrock' | 'gateway' | 'openai-compatible';

export interface InferenceProvider {
  readonly id: InferenceProviderId;
  readonly endpoint: string;
  readonly model: string;
  readonly apiMode: LlmApiMode;
  readonly maxContextTokens: number;
  readonly localFallbackEnabled: boolean;
  createClient(): LlmClient;
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
const BEDROCK_MODEL = 'openai.gpt-5.6-luna';
const BEDROCK_MAX_CONTEXT_TOKENS = 1_000_000;
const LEGACY_BEDROCK_MODEL = 'moonshotai.kimi-k2.5';
const LEGACY_BEDROCK_MAX_CONTEXT_TOKENS = 262_144;
const OPENAI_COMPATIBLE_MODEL = '/app/models/qwen35-35b-a3b-fp8';
const OPENAI_COMPATIBLE_MAX_CONTEXT_TOKENS = 32768;
// AgentCore gateway model ids carry the gateway target name as a prefix.
const GATEWAY_MODEL = 'bedrock-mantle-luna/openai.gpt-5.6-luna';
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
  return {
    id,
    endpoint: options.endpoint,
    model: options.model,
    apiMode: options.apiMode,
    maxContextTokens: options.maxContextTokens,
    localFallbackEnabled: options.localFallback,
    createClient: () => createLlmClient(config),
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
): InferenceProviderId {
  const providerName = (env.BOTBOY_INFERENCE_PROVIDER || '').trim().toLowerCase()
    || inferProvider(env);
  if (providerName !== 'bedrock' && providerName !== 'gateway' && providerName !== 'openai-compatible') {
    throw new Error(`Unsupported BOTBOY_INFERENCE_PROVIDER: ${providerName}`);
  }
  return providerName;
}

/** Default context profile shared by provider construction and runtime limits. */
export function defaultInferenceMaxContextTokens(id: InferenceProviderId): number {
  if (id === 'bedrock') return BEDROCK_MAX_CONTEXT_TOKENS;
  if (id === 'gateway') return GATEWAY_MAX_CONTEXT_TOKENS;
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
  const localFallback = boolSetting(
    env.BOTBOY_LOCAL_LLM_FALLBACK ?? env.LLM_FALLBACK_ENABLED,
    false,
  );
  const shared = {
    apiMode,
    reasoningEffort: reasoningSetting(
      env.BOTBOY_INFERENCE_REASONING_EFFORT ?? env.VLLM_REASONING_EFFORT,
    ) ?? providerDefaults.reasoningEffort,
    maxContextTokens: positiveIntSetting(
      env.BOTBOY_INFERENCE_MAX_CONTEXT_TOKENS ?? env.VLLM_MAX_CONTEXT_TOKENS,
      providerDefaults.maxContextTokens,
    ),
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
    localFallback,
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
