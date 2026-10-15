/**
 * Settings → AI model: which model connections BotBoy has and which model
 * serves each kind of work.
 *
 * Connections (any combination, all at once):
 *   - team: the launcher/.env provider (team gateway, Bedrock, self-hosted),
 *     present when its credentials exist or when nothing else is configured;
 *   - openai: the owner's OpenAI API key (every chat model the key lists);
 *   - deepseek: the owner's DeepSeek API key (every model the key lists);
 *   - anthropic: the owner's Anthropic (Claude) API key (every Claude model
 *     the key lists, through the native Messages API).
 *
 * Model choices:
 *   - chat picks per message (chat panel), from every connection;
 *   - organizing (the information pipeline, planners, visual inspection,
 *     background agent loops) and document writing each have one owner choice
 *     with its own Thinking level. Until the owner picks, each uses the
 *     default chain: team default → OpenAI → DeepSeek → Anthropic. Chat
 *     follows the same chain through each connection's default model, so a
 *     role default (Claude's Haiku-line Organizing model) never becomes the
 *     chat default.
 *
 * Boundaries this module owns:
 *   - Keys live only in ~/.personal-productivity-tracker/ai-model.json (0600,
 *     atomic). Never SQLite (query_db can read the database), never
 *     process.env (model-run shells inherit it), never a browser response.
 *     The model-command Seatbelt profile denies that directory to every
 *     model-run process; in-process file tools refuse links into it.
 *   - A key is verified (model list + one tiny generation) before anything
 *     changes. A failed save leaves every connection untouched.
 *   - Replacing or removing a connection stops only the chat turns pinned to
 *     it. Changing a role's model stops that role's background loops before
 *     their next call. BotBoy never falls back between providers on its own.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  DEEPSEEK_PLATFORM_ENDPOINT,
  OPENAI_PLATFORM_ENDPOINT,
  OPENAI_PLATFORM_MODEL_IDS,
  createAnthropicInferenceProvider,
  createDeepSeekInferenceProvider,
  createOpenAiPlatformInferenceProvider,
  type InferenceProvider,
} from './inference-provider.js';
import {
  ANTHROPIC_API_ENDPOINT,
  deriveProfile,
  isAnthropicAdminKey,
  isAnthropicApiKey,
  listAnthropicModels,
  logProfileDisagreementsOnce,
  looksLikeAnthropicKey,
  parseStoredAnthropicModels,
  pickAnthropicDefaultModel,
  pickAnthropicProcessingModel,
  selectOfferedModels,
  verifyKey as verifyAnthropicKey,
  type AnthropicModelProfile,
} from './anthropic-models.js';
import { ANTHROPIC_BILLING_URL, ANTHROPIC_KEYS_URL, isAnthropicApiError } from './anthropic-errors.js';
import {
  isLlmProviderLimitError,
  redactProviderSecrets,
  type ChatCompletionRequest,
  type LlmClient,
  type LlmProviderIssue,
} from './llm-client.js';
import { createLlmClientSwitch, type LlmClientSwitch, type LlmRuntimeIdentity } from './llm-client-switch.js';
import {
  LLM_CONNECTION_ORDER,
  LLM_MODEL_KEY_PATTERN,
  anthropicModelEntries,
  bindLlmModel,
  connectionDefaultEntry,
  connectionRoleDefaultEntry,
  deepSeekModelCapabilities,
  deepSeekModelEntries,
  isLlmThinkingLevel,
  isOpenAiChatModelId,
  openAiModelEntries,
  openAiModelProfile,
  parseDeepSeekModelList,
  pickDeepSeekDefaultModel,
  pickOpenAiDefaultModel,
  qualifiedModelKey,
  teamConnectionLabel,
  teamModelEntries,
  type DeepSeekModelProfile,
  type LlmConnection,
  type LlmConnectionId,
  type LlmModelEntry,
  type LlmThinkingLevel,
} from './llm-model-catalog.js';
import { createConnectionChatModelSource, type ChatModelSource } from './chat-model-source.js';
import type { LlmThinkingOffMode } from './llm-model-operation.js';
import type { LlmUsageService } from './llm-usage.js';
import { hasTlsInterceptionCode, transportCodesOf } from './transport-errors.js';

export const AI_MODEL_SETTINGS_FILE = 'ai-model.json';
const SCHEMA_VERSION = 2;
const API_KEY_PATTERN = /^sk-[A-Za-z0-9_-]{16,400}$/;
const MODEL_LIST_TIMEOUT_MS = 15_000;
// Boot refreshes saved model lists in parallel but must not hold startup on a
// slow or blocked provider; the saved list stays usable when this expires.
const BOOT_MODEL_LIST_TIMEOUT_MS = 5_000;
// A Claude answer that says the model list is stale (a 404 on a model, a thinking-type 400) asks for a re-list;
// at most one starts per interval, so a failing model cannot turn into a polling loop.
const ANTHROPIC_STALE_REFRESH_INTERVAL_MS = 10 * 60_000;

export type AiModelState = 'ready' | 'unavailable' | 'not_configured';
export type AiModelKeyProvider = 'openai' | 'deepseek' | 'anthropic';
export type AiModelRole = 'processing' | 'documents';
export const AI_MODEL_ROLES: readonly AiModelRole[] = Object.freeze(['processing', 'documents']);

export interface AiModelIssue {
  readonly code: string;
  readonly message: string;
  readonly nextAction: string;
  readonly at: string;
}

export interface AiModelConnectionStatus {
  readonly id: LlmConnectionId;
  readonly label: string;
  readonly source: 'environment' | 'settings';
  readonly healthy: boolean;
  readonly keySuffix?: string;
  readonly savedAt?: string;
  readonly verifiedAt?: string;
  readonly models: readonly {
    readonly key: string;
    readonly label: string;
    readonly images?: boolean;
    readonly contextWindow: number;
    /** How Thinking "Off" behaves on this model (Claude only; absent for the other providers). */
    readonly thinkingOff?: LlmThinkingOffMode;
  }[];
  readonly issue?: AiModelIssue;
}

export interface AiModelRoleStatus {
  /** The model serving this role now. */
  readonly modelKey: string;
  readonly label: string;
  readonly connectionId: LlmConnectionId;
  readonly connectionLabel: string;
  readonly thinking: LlmThinkingLevel;
  /** true when the owner picked this model; false = the default chain. */
  readonly chosen: boolean;
  /** The owner's stored choice when it is not offered right now. */
  readonly unavailableChoice?: string;
  readonly images?: boolean;
  /** How Thinking "Off" behaves on the model serving this role (Claude only). */
  readonly thinkingOff?: LlmThinkingOffMode;
}

export interface AiModelStatus {
  readonly state: AiModelState;
  readonly configVersion: number;
  readonly connections: readonly AiModelConnectionStatus[];
  readonly roles: { readonly processing: AiModelRoleStatus; readonly documents: AiModelRoleStatus };
  // ── Single-provider fields, kept for an older Settings page (mixed build) ──
  readonly source: 'settings' | 'environment';
  readonly provider: string;
  readonly providerLabel: string;
  /** Model BotBoy uses for background organizing. */
  readonly backgroundModel: string;
  readonly healthy: boolean;
  /** Chat models across connections (labels only). */
  readonly models: readonly { key: string; label: string }[];
  readonly openai?: { readonly keySuffix: string; readonly savedAt: string; readonly verifiedAt: string };
  readonly deepseek?: { readonly keySuffix: string; readonly savedAt: string; readonly verifiedAt: string };
  /** The saved Anthropic key (suffix and times only). */
  readonly anthropic?: { readonly keySuffix: string; readonly savedAt: string; readonly verifiedAt: string };
  /** Present when launcher credentials exist alongside saved keys. */
  readonly environmentProviderLabel?: string;
  readonly issue?: AiModelIssue;
}

/** Owner-facing failure: every code names the next action and never contains the key. */
export class AiModelSettingsError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly nextAction: string,
    readonly httpStatus = 400,
  ) {
    super(message);
    this.name = 'AiModelSettingsError';
  }
}

export interface AiModelSettingsService {
  /** The organizing role's client: what most BotBoy consumers hold. */
  readonly client: LlmClientSwitch;
  readonly processing: LlmClientSwitch;
  readonly documents: LlmClientSwitch;
  /** Chat picker catalog and per-turn resolution across every connection. */
  readonly chatModels: ChatModelSource;
  status(): AiModelStatus;
  /** Cheap, non-throwing readiness for the dashboard version poll. */
  state(): AiModelState;
  version(): number;
  /** The Amazon Employee toggle changed: bump the version so open tabs repaint (no connection change). */
  refreshVisibility(): void;
  saveApiKey(provider: AiModelKeyProvider, apiKey: unknown): Promise<AiModelStatus>;
  removeApiKey(provider: AiModelKeyProvider): Promise<AiModelStatus>;
  /** modelKey: a catalog key, or null to return to the default chain. */
  setRole(role: unknown, choice: { modelKey?: unknown; thinking?: unknown }): Promise<AiModelStatus>;
  saveOpenAiKey(apiKey: unknown): Promise<AiModelStatus>;
  removeOpenAiKey(): Promise<AiModelStatus>;
  /** Stop every connection's health timer (shutdown). */
  close(): void;
}

interface StoredKey {
  apiKey: string;
  savedAt: string;
  verifiedAt: string;
}

interface StoredOpenAiKey extends StoredKey {
  /** Chat model ids the key listed. */
  models: string[];
}

interface StoredDeepSeekKey extends StoredKey {
  models: DeepSeekModelProfile[];
}

interface StoredAnthropicKey extends StoredKey {
  /** The models the key offers (lifecycle-filtered, at most 100), with the capabilities that drive request shaping. */
  models: AnthropicModelProfile[];
}

interface StoredRole {
  modelKey?: string;
  thinking?: LlmThinkingLevel;
  /** Role fields this build does not know, written back unchanged. */
  extra?: Record<string, unknown>;
}

/**
 * Fields this build does not know, kept so a rewrite never loses a newer
 * build's data (a provider's key, a role's extra fields): D11. They are read
 * from the file and written back unchanged; nothing here interprets them.
 */
interface StoredPassthrough {
  top: Record<string, unknown>;
  keys: Record<string, unknown>;
  roles: Record<string, unknown>;
}

interface StoredAiModelSettings {
  schemaVersion: 2;
  keys: { openai?: StoredOpenAiKey; deepseek?: StoredDeepSeekKey; anthropic?: StoredAnthropicKey };
  roles: { processing?: StoredRole; documents?: StoredRole };
  passthrough: StoredPassthrough;
}

interface AiModelSettingsDeps {
  envProvider: InferenceProvider;
  usageService?: LlmUsageService;
  env?: NodeJS.ProcessEnv;
  /** ~/.personal-productivity-tracker by default. */
  privateRoot?: string;
  /** True when launcher/.env carries a usable credential for envProvider. */
  environmentCredentialsPresent?: boolean;
  /** Test seams: hosted endpoints and HTTP client for model lists. */
  openAiEndpoint?: string;
  deepSeekEndpoint?: string;
  anthropicEndpoint?: string;
  /** Test seam: the deadline of the boot model-list refresh (default 5 s; Claude's listing shares it across pages). */
  bootModelListTimeoutMs?: number;
  fetchImpl?: typeof fetch;
  /** Called after the organizing model changes (kick the information pipeline, log). */
  onActivated?: (identity: LlmRuntimeIdentity) => void;
  now?: () => Date;
  /**
   * Settings → Workplace: whether the team gateway catalog shows when no
   * connection is configured. False while Amazon Employee is off, so a
   * non-Amazon owner never sees team model names. Absent = shown.
   */
  teamVisibleWithoutCredentials?: () => boolean;
}

const PROVIDER_TEXT: Record<AiModelKeyProvider, {
  label: string;
  host: string;
  keysUrl: string;
  billing: string;
}> = {
  openai: {
    label: 'OpenAI',
    host: 'api.openai.com',
    keysUrl: 'platform.openai.com/api-keys',
    billing: 'platform.openai.com → Billing',
  },
  deepseek: {
    label: 'DeepSeek',
    host: 'api.deepseek.com',
    keysUrl: 'platform.deepseek.com/api_keys',
    billing: 'platform.deepseek.com → Top up',
  },
  anthropic: {
    label: 'Anthropic',
    host: 'api.anthropic.com',
    keysUrl: ANTHROPIC_KEYS_URL,
    billing: ANTHROPIC_BILLING_URL,
  },
};

const ROLE_TEXT: Record<AiModelRole, string> = {
  processing: 'organizing',
  documents: 'document writing',
};

function legacyProviderLabel(providerId: string): string {
  if (providerId === 'openai') return 'OpenAI (your API key)';
  if (providerId === 'deepseek') return 'DeepSeek (your API key)';
  if (providerId === 'anthropic') return 'Anthropic (your API key)';
  if (providerId === 'gateway') return 'Team gateway (Amazon Bedrock)';
  if (providerId === 'bedrock') return 'Amazon Bedrock';
  if (providerId === 'openai-compatible') return 'Self-hosted model endpoint';
  return providerId;
}

function keySuffix(apiKey: string): string {
  return `…${apiKey.slice(-4)}`;
}

/** Owner-facing text for a provider issue on one keyed connection (undefined for the launcher provider). */
export function aiModelIssueText(issue: LlmProviderIssue | undefined, providerId: string): AiModelIssue | undefined {
  if (!issue) return undefined;
  const provider = providerId === 'openai' || providerId === 'deepseek' || providerId === 'anthropic' ? PROVIDER_TEXT[providerId] : undefined;
  if (!provider) return undefined;
  if (issue.code === 'auth_rejected') {
    return {
      code: issue.code,
      message: `${provider.label} rejected the saved API key.`,
      nextAction: `Create or copy a current key at ${provider.keysUrl} and save it here again.`,
      at: issue.at,
    };
  }
  if (issue.code === 'quota_exhausted') {
    return {
      code: issue.code,
      message: `The ${provider.label} account behind this key has no available credit.`,
      nextAction: `Add credit at ${provider.billing}. BotBoy resumes on its own once calls succeed.`,
      at: issue.at,
    };
  }
  if (issue.code === 'overloaded') {
    return {
      code: issue.code,
      message: `${provider.label} is busy right now.`,
      nextAction: 'BotBoy retries on its own; nothing to change.',
      at: issue.at,
    };
  }
  return {
    code: issue.code,
    message: `${provider.label} is rate-limiting this key.`,
    nextAction: 'BotBoy waits and retries automatically. New accounts have lower limits that rise with use.',
    at: issue.at,
  };
}

function issueFor(issue: LlmProviderIssue | undefined, connection: LlmConnection): AiModelIssue | undefined {
  return aiModelIssueText(issue, connection.id);
}

/**
 * What the provider said in an `HTTP nnn: <body>` message, for an owner-facing line: the JSON `error.message` when the
 * body has one, else the text itself, on one line and bounded. ` (…)` or '' (the message is already redacted).
 */
function providerWords(message: string): string {
  let said = message.replace(/^HTTP \d{3}:?\s*/, '');
  try {
    const parsed = JSON.parse(said);
    const inner = parsed?.error?.message ?? parsed?.message;
    if (typeof inner === 'string') said = inner;
  } catch { /* plain text: use it as it came */ }
  said = said.replace(/\s+/g, ' ').trim().slice(0, 120);
  return said ? ` (${said})` : '';
}

/**
 * The log line of a failed Save check (D4): `[AI model] DeepSeek key check failed: HTTP 400 <the provider's body, first
 * 200 characters>`. Provider text only, through `redactProviderSecrets`, on one line; a failure with no HTTP status
 * (a network cause, a typed limit) logs its own message. The key itself is never part of an error message.
 */
function keyCheckFailureLine(error: unknown, label: string): string {
  const message = redactProviderSecrets(error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ').trim();
  const http = /^HTTP (\d{3}):?\s*(.*)$/.exec(message);
  const said = http ? `HTTP ${http[1]} ${http[2].slice(0, 200)}`.trimEnd() : message.slice(0, 200);
  return `[AI model] ${label} key check failed: ${said}`;
}

/** Exported for tests. */
export function modelSettingsError(error: unknown, provider: AiModelKeyProvider): AiModelSettingsError {
  if (error instanceof AiModelSettingsError) return error;
  // Anthropic answers are classified once, in anthropic-errors.ts (D10); Save shows that text and code.
  if (provider === 'anthropic' && isAnthropicApiError(error)) {
    const c = error.classification;
    return new AiModelSettingsError(c.saveCode, c.message, c.nextAction, c.saveStatus);
  }
  const text = PROVIDER_TEXT[provider];
  // A provider at capacity is not this key's rate limit: the key is fine and the wait is short.
  if ((error as { code?: unknown } | null)?.code === 'LLM_PROVIDER_OVERLOADED') {
    return new AiModelSettingsError('provider_overloaded', `${text.label} is temporarily overloaded.`, `${text.label} is busy. Save the key again in a minute.`, 503);
  }
  if (isLlmProviderLimitError(error)) {
    return (error as any).code === 'LLM_QUOTA_EXHAUSTED'
      ? new AiModelSettingsError('no_credit', `Your ${text.label} account has no available credit.`, `Add credit at ${text.billing}, then save the key again.`)
      : new AiModelSettingsError('rate_limited', `${text.label} is rate-limiting this key right now.`, 'Wait a minute, then save the key again.', 429);
  }
  const message = redactProviderSecrets(error instanceof Error ? error.message : String(error));
  const status = /^HTTP (\d{3})/.exec(message)?.[1];
  if (status === '401') {
    return new AiModelSettingsError('invalid_key', `${text.label} rejected this API key.`, `Copy a current key from ${text.keysUrl} and try again.`);
  }
  if (status === '402') {
    return new AiModelSettingsError('no_credit', `Your ${text.label} account has no available credit.`, `Add credit at ${text.billing}, then save the key again.`);
  }
  if (status === '403') {
    return new AiModelSettingsError('forbidden', `This key is not allowed to call ${text.label}'s models.`, 'Use a key with model (Responses API) access, then try again.');
  }
  if (status === '404') {
    return new AiModelSettingsError('model_unavailable', 'This key cannot use the model BotBoy checked it with.', `Check the key's model access at ${text.keysUrl.split('/')[0]}, then try again.`);
  }
  // A 5xx is the provider's own trouble, not a verdict on the key and not a network failure: say so, with its words.
  if (status && Number(status) >= 500) {
    return new AiModelSettingsError(
      'provider_unavailable',
      `${text.label} answered HTTP ${status}${providerWords(message)}. That is a problem on ${text.label}'s side, so BotBoy could not finish checking the key.`,
      'Wait a minute, then save the key again. If it keeps failing, the provider may be having an outage.',
      502,
    );
  }
  if (status) {
    return new AiModelSettingsError('rejected', `${text.label} rejected the verification request (HTTP ${status}).`, `Try again in a minute. If it keeps failing, create a new key at ${text.keysUrl}.`, 502);
  }
  // No HTTP answer at all. Name the cause Node kept (errno codes, or a timeout) so the fix can be the right one.
  const codes = transportCodesOf(error);
  const cause = codes.length ? codes.join('+') : (error as { name?: unknown } | null)?.name === 'TimeoutError' ? 'timed out' : '';
  return new AiModelSettingsError(
    'unreachable',
    `BotBoy could not reach ${text.host}${cause ? ` (${cause})` : ''}.`,
    hasTlsInterceptionCode(codes)
      ? `A proxy or security product on this network replaces ${text.host}'s certificate, and BotBoy does not trust the replacement. Try another network (a phone hotspot works) and tell the owner.`
      : `Check your internet connection (and any proxy or VPN rules for ${text.host}), then try again.`,
    502,
  );
}

async function getJson(
  url: string,
  apiKey: string,
  fetchImpl: typeof fetch,
  provider: AiModelKeyProvider,
  timeoutMs = MODEL_LIST_TIMEOUT_MS,
): Promise<{ status: number; text: string }> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    // The real error goes on: its cause chain holds the errno (or the timeout) that tells the owner what to fix.
    throw modelSettingsError(error, provider);
  }
  return { status: response.status, text: await response.text().catch(() => '') };
}

/** OpenAI GET /models: every chat model the key lists. undefined = listing not permitted. */
async function listOpenAiModels(endpoint: string, apiKey: string, fetchImpl: typeof fetch, timeoutMs?: number): Promise<string[] | undefined> {
  const { status, text } = await getJson(`${endpoint.replace(/\/+$/, '')}/models`, apiKey, fetchImpl, 'openai', timeoutMs);
  if (status === 403) return undefined; // restricted key: listing not permitted, generation decides
  if (status < 200 || status >= 300) {
    if (status === 429 && /insufficient_quota/.test(text)) {
      throw modelSettingsError(Object.assign(new Error('quota'), { code: 'LLM_QUOTA_EXHAUSTED' }), 'openai');
    }
    throw modelSettingsError(new Error(`HTTP ${status}: ${text}`), 'openai');
  }
  let ids: string[] = [];
  try {
    const parsed = JSON.parse(text);
    ids = Array.isArray(parsed?.data) ? parsed.data.map((entry: any) => String(entry?.id ?? '')) : [];
  } catch {
    throw modelSettingsError(new Error('HTTP 502: unreadable model list'), 'openai');
  }
  return [...new Set(ids.filter(isOpenAiChatModelId))].slice(0, 300);
}

/**
 * DeepSeek GET /models: id, display name, window, output limit, image input, effort levels.
 */
async function listDeepSeekModels(endpoint: string, apiKey: string, fetchImpl: typeof fetch, timeoutMs?: number): Promise<DeepSeekModelProfile[]> {
  const { status, text } = await getJson(`${endpoint.replace(/\/+$/, '')}/models`, apiKey, fetchImpl, 'deepseek', timeoutMs);
  if (status < 200 || status >= 300) throw modelSettingsError(new Error(`HTTP ${status}: ${text}`), 'deepseek');
  try {
    return parseDeepSeekModelList(JSON.parse(text));
  } catch {
    throw modelSettingsError(new Error('HTTP 502: unreadable model list'), 'deepseek');
  }
}

/**
 * A DeepSeek connection for a key's model list: one client, the default pick (`deepseek-flash` when listed, else the
 * first listed model) and one entry per model. This is what Save and the boot refresh build.
 */
function createDeepSeekConnection(input: {
  apiKey: string;
  models: readonly DeepSeekModelProfile[];
  endpoint: string;
  env: NodeJS.ProcessEnv;
  usageService?: LlmUsageService;
  version: number;
}): LlmConnection {
  const defaultModel = pickDeepSeekDefaultModel(input.models);
  const provider = createDeepSeekInferenceProvider({
    apiKey: input.apiKey,
    availableModels: input.models.map(model => model.id),
    defaultModel,
    defaultContextTokens: deepSeekModelCapabilities(input.models.find(model => model.id === defaultModel)).contextWindow,
    endpoint: input.endpoint,
    env: input.env,
  });
  return {
    id: 'deepseek',
    label: 'DeepSeek',
    source: 'settings',
    client: provider.createClient({ usageService: input.usageService }),
    provider: { id: provider.id, endpoint: provider.endpoint, model: provider.model, apiMode: provider.apiMode },
    models: deepSeekModelEntries(input.models, defaultModel),
    version: input.version,
  };
}

/**
 * The one tiny generation Save runs to prove auth, model access and credit (a fresh object each call: the client never
 * sees a shared one).
 */
function keyVerificationRequest(): ChatCompletionRequest {
  return {
    messages: [{ role: 'user', content: 'Reply with the single word OK.' }],
    maxTokens: 16,
    think: false,
    usageContext: { workload: 'system' },
  };
}

function noPassthrough(): StoredPassthrough {
  return { top: {}, keys: {}, roles: {} };
}

function emptySettings(): StoredAiModelSettings {
  return { schemaVersion: SCHEMA_VERSION, keys: {}, roles: {}, passthrough: noPassthrough() };
}

/** The entries of a parsed JSON object whose names this build does not know (own keys only; `__proto__` stays plain data). */
function unknownEntries(source: unknown, known: ReadonlySet<string>): Record<string, unknown> {
  if (!source || typeof source !== 'object' || Array.isArray(source)) return {};
  return Object.fromEntries(Object.entries(source).filter(([name]) => !known.has(name)));
}

const KNOWN_TOP_FIELDS: ReadonlySet<string> = new Set(['schemaVersion', 'keys', 'roles']);
const KNOWN_KEY_PROVIDERS: ReadonlySet<string> = new Set(['openai', 'deepseek', 'anthropic']);
const KNOWN_ROLE_NAMES: ReadonlySet<string> = new Set(AI_MODEL_ROLES);
const KNOWN_ROLE_FIELDS: ReadonlySet<string> = new Set(['modelKey', 'thinking']);

function hasPassthrough(passthrough: StoredPassthrough): boolean {
  return Object.keys(passthrough.top).length + Object.keys(passthrough.keys).length + Object.keys(passthrough.roles).length > 0;
}

function storedKeyBase(value: any): StoredKey | undefined {
  if (typeof value?.apiKey !== 'string' || !API_KEY_PATTERN.test(value.apiKey)) return undefined;
  return { apiKey: value.apiKey, savedAt: String(value.savedAt ?? ''), verifiedAt: String(value.verifiedAt ?? '') };
}

function storedOpenAi(value: any): StoredOpenAiKey | undefined {
  const base = storedKeyBase(value);
  if (!base) return undefined;
  const models = Array.isArray(value.models)
    ? [...new Set(value.models.map(String).filter(isOpenAiChatModelId))] as string[]
    : [];
  return { ...base, models: models.length ? models : [...OPENAI_PLATFORM_MODEL_IDS] };
}

function storedDeepSeek(value: any): StoredDeepSeekKey | undefined {
  const base = storedKeyBase(value);
  if (!base) return undefined;
  const models = parseDeepSeekModelList(Array.isArray(value.models) ? value.models : []);
  return models.length ? { ...base, models } : undefined;
}

function storedAnthropic(value: any): StoredAnthropicKey | undefined {
  if (typeof value?.apiKey !== 'string' || !isAnthropicApiKey(value.apiKey)) return undefined;
  return {
    apiKey: value.apiKey,
    savedAt: String(value.savedAt ?? ''),
    verifiedAt: String(value.verifiedAt ?? ''),
    models: parseStoredAnthropicModels(value.models),
  };
}

function storedRole(value: any): StoredRole | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const modelKey = typeof value.modelKey === 'string' && LLM_MODEL_KEY_PATTERN.test(value.modelKey) ? value.modelKey : undefined;
  const thinking = isLlmThinkingLevel(value.thinking) ? value.thinking : undefined;
  const extra = unknownEntries(value, KNOWN_ROLE_FIELDS);
  const hasExtra = Object.keys(extra).length > 0;
  return modelKey || thinking || hasExtra
    ? { ...(modelKey ? { modelKey } : {}), ...(thinking ? { thinking } : {}), ...(hasExtra ? { extra } : {}) }
    : undefined;
}

function serializeRole(role: StoredRole): Record<string, unknown> {
  return { ...(role.extra ?? {}), ...(role.modelKey ? { modelKey: role.modelKey } : {}), ...(role.thinking ? { thinking: role.thinking } : {}) };
}

/** The JSON written to disk: known fields, then everything this build did not recognize, unchanged. */
function serializeStored(value: StoredAiModelSettings): Record<string, unknown> {
  const roles = Object.fromEntries(AI_MODEL_ROLES.flatMap(role => (value.roles[role] ? [[role, serializeRole(value.roles[role]!)]] : [])));
  return {
    ...value.passthrough.top,
    schemaVersion: SCHEMA_VERSION,
    keys: { ...value.passthrough.keys, ...value.keys },
    roles: { ...value.passthrough.roles, ...roles },
  };
}

/** Read schema 1 (one OpenAI key) or 2; undefined when absent or unreadable. */
function readStored(file: string): { settings: StoredAiModelSettings; schemaVersion: number } | undefined {
  let raw: string;
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) return undefined;
    // Self-heal permissions: the keys must never be readable by other users.
    if ((stat.mode & 0o077) !== 0) fs.chmodSync(file, 0o600);
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
  const unreadable = () => {
    console.warn('[AI model] Ignoring an unreadable Settings → AI model file; saving a key again replaces it.');
    return undefined;
  };
  let value: any;
  try {
    value = JSON.parse(raw);
  } catch {
    return unreadable();
  }
  if (value?.schemaVersion === 1) {
    if (value.provider !== 'openai') return unreadable();
    const openai = storedOpenAi(value);
    return openai
      ? { settings: { schemaVersion: SCHEMA_VERSION, keys: { openai }, roles: {}, passthrough: noPassthrough() }, schemaVersion: 1 }
      : unreadable();
  }
  if (value?.schemaVersion !== SCHEMA_VERSION || !value.keys || typeof value.keys !== 'object') return unreadable();
  const openai = value.keys.openai ? storedOpenAi(value.keys.openai) : undefined;
  const deepseek = value.keys.deepseek ? storedDeepSeek(value.keys.deepseek) : undefined;
  const anthropic = value.keys.anthropic ? storedAnthropic(value.keys.anthropic) : undefined;
  const processing = storedRole(value.roles?.processing);
  const documents = storedRole(value.roles?.documents);
  return {
    settings: {
      schemaVersion: SCHEMA_VERSION,
      keys: { ...(openai ? { openai } : {}), ...(deepseek ? { deepseek } : {}), ...(anthropic ? { anthropic } : {}) },
      roles: { ...(processing ? { processing } : {}), ...(documents ? { documents } : {}) },
      // A newer build's provider keys and role fields survive this build's writes (D11).
      passthrough: {
        top: unknownEntries(value, KNOWN_TOP_FIELDS),
        keys: unknownEntries(value.keys, KNOWN_KEY_PROVIDERS),
        roles: unknownEntries(value.roles, KNOWN_ROLE_NAMES),
      },
    },
    schemaVersion: SCHEMA_VERSION,
  };
}

function writeStored(file: string, value: StoredAiModelSettings): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.tmp-${process.pid}-${Date.now()}`;
  try {
    // 'wx': create new only, never through a pre-existing file or link.
    const fd = fs.openSync(temporary, 'wx', 0o600);
    try {
      fs.writeFileSync(fd, `${JSON.stringify(serializeStored(value), null, 2)}\n`);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temporary, file);
    fs.chmodSync(file, 0o600);
  } catch (error) {
    // Never leave a stray copy of a key behind a failed save.
    try { fs.rmSync(temporary, { force: true }); } catch { /* best effort */ }
    throw error;
  }
}

function identityFor(connection: LlmConnection, entry: LlmModelEntry): LlmRuntimeIdentity {
  return {
    providerId: connection.provider.id,
    endpoint: connection.provider.endpoint,
    model: entry.model,
    apiMode: connection.provider.apiMode,
    maxContextTokens: entry.capabilities.contextWindow,
    source: connection.source,
  };
}

export async function createAiModelSettingsService(deps: AiModelSettingsDeps): Promise<AiModelSettingsService> {
  const env = deps.env ?? process.env;
  const privateRoot = deps.privateRoot ?? path.join(os.homedir(), '.personal-productivity-tracker');
  const file = path.join(privateRoot, AI_MODEL_SETTINGS_FILE);
  const openAiEndpoint = deps.openAiEndpoint ?? OPENAI_PLATFORM_ENDPOINT;
  const deepSeekEndpoint = deps.deepSeekEndpoint ?? DEEPSEEK_PLATFORM_ENDPOINT;
  const anthropicEndpoint = deps.anthropicEndpoint ?? ANTHROPIC_API_ENDPOINT;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const bootListTimeoutMs = deps.bootModelListTimeoutMs ?? BOOT_MODEL_LIST_TIMEOUT_MS;
  const now = deps.now ?? (() => new Date());
  const credentialsPresent = Boolean(deps.environmentCredentialsPresent);

  const connections = new Map<LlmConnectionId, LlmConnection>();
  const connectionListeners = new Set<(event: { connectionId: string }) => void>();
  let connectionCounter = 0;
  let settingsVersion = 1;
  let saving: Promise<unknown> | null = null;
  let anthropicRefreshing = false;
  let anthropicRefreshedAt = Number.NEGATIVE_INFINITY;

  const loaded = readStored(file);
  let stored: StoredAiModelSettings = loaded?.settings ?? emptySettings();
  // A schema-1 file is rewritten only when the owner next changes something.
  let persistedSchema = loaded?.schemaVersion ?? 0;

  function persist(next: StoredAiModelSettings): void {
    const empty = !next.keys.openai && !next.keys.deepseek && !next.keys.anthropic
      && !next.roles.processing && !next.roles.documents && !hasPassthrough(next.passthrough);
    if (empty) fs.rmSync(file, { force: true });
    else writeStored(file, next);
    stored = next;
    persistedSchema = empty ? 0 : SCHEMA_VERSION;
  }

  function descriptor(provider: InferenceProvider): LlmConnection['provider'] {
    return { id: provider.id, endpoint: provider.endpoint, model: provider.model, apiMode: provider.apiMode };
  }

  function buildTeamConnection(client: LlmClient): LlmConnection {
    const provider = deps.envProvider;
    return {
      id: 'team',
      label: teamConnectionLabel(provider.id),
      source: 'environment',
      client,
      provider: descriptor(provider),
      models: teamModelEntries({
        providerId: provider.id,
        defaultModel: client.getDefaultModel(),
        maxContextTokens: provider.maxContextTokens,
        maxCompletionTokens: client.getMaxCompletionTokens?.() ?? 16_384,
        env,
      }),
      version: ++connectionCounter,
    };
  }

  function buildOpenAiConnection(key: StoredOpenAiKey): LlmConnection {
    const defaultModel = pickOpenAiDefaultModel(key.models);
    const profile = openAiModelProfile(defaultModel);
    const provider = createOpenAiPlatformInferenceProvider({
      apiKey: key.apiKey,
      availableModels: key.models,
      defaultModel,
      defaultContextTokens: profile.contextWindow,
      defaultSupportsReasoning: profile.reasoning,
      endpoint: openAiEndpoint,
      env,
    });
    return {
      id: 'openai',
      label: 'OpenAI',
      source: 'settings',
      client: provider.createClient({ usageService: deps.usageService }),
      provider: descriptor(provider),
      models: openAiModelEntries(key.models, defaultModel),
      version: ++connectionCounter,
    };
  }

  function buildDeepSeekConnection(key: StoredDeepSeekKey): LlmConnection {
    return createDeepSeekConnection({
      apiKey: key.apiKey,
      models: key.models,
      endpoint: deepSeekEndpoint,
      env,
      usageService: deps.usageService,
      version: ++connectionCounter,
    });
  }

  /**
   * The Claude connection for a saved key: every model the key lists, the Sonnet-line pick as its default (chat,
   * Document writing, key verification) and the Haiku-line pick as its Organizing default, because background work
   * runs on every captured item (design D8). undefined when the list yields no model to build on (a hand-edited
   * file; Save refuses an empty list), in which case the key stays saved and nothing is registered.
   */
  function buildAnthropicConnection(key: StoredAnthropicKey): LlmConnection | undefined {
    const defaultModel = pickAnthropicDefaultModel(key.models) ?? key.models[0]?.id;
    if (!defaultModel) return undefined;
    const processingModel = pickAnthropicProcessingModel(key.models);
    const provider = createAnthropicInferenceProvider({
      apiKey: key.apiKey,
      models: key.models,
      defaultModel,
      endpoint: anthropicEndpoint,
      env,
      onModelsStale: refreshAnthropicModelsSoon,
      ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
    });
    return {
      id: 'anthropic',
      label: 'Anthropic (Claude)',
      source: 'settings',
      client: provider.createClient({ usageService: deps.usageService }),
      provider: descriptor(provider),
      models: anthropicModelEntries(key.models, defaultModel),
      ...(processingModel ? { roleDefaultModels: { processing: qualifiedModelKey('anthropic', processingModel) } } : {}),
      version: ++connectionCounter,
    };
  }

  /**
   * The Claude client saw an answer that says its model list is stale: list again, at most once per interval and one
   * at a time. A changed list is stored and replaces the connection (which stops chat turns pinned to it, the same
   * as any other replacement); an unchanged, empty or failed answer keeps the saved list. Nothing is applied when
   * the key was saved, replaced or removed meanwhile.
   */
  function refreshAnthropicModelsSoon(): void {
    const key = stored.keys.anthropic;
    const at = now().getTime();
    if (!key || anthropicRefreshing || at - anthropicRefreshedAt < ANTHROPIC_STALE_REFRESH_INTERVAL_MS) return;
    anthropicRefreshing = true;
    anthropicRefreshedAt = at;
    void (async () => {
      try {
        const listed = await listAnthropicModels({
          endpoint: anthropicEndpoint, apiKey: key.apiKey, fetchImpl, timeoutMs: MODEL_LIST_TIMEOUT_MS, overallTimeoutMs: MODEL_LIST_TIMEOUT_MS,
        });
        const models = selectOfferedModels(listed.models, anthropicKeepIds());
        const current = stored.keys.anthropic;
        if (!models.length || saving || !current || current.apiKey !== key.apiKey) return;
        if (JSON.stringify(models) === JSON.stringify(current.models)) return;
        const next: StoredAnthropicKey = { ...current, models };
        persist({ ...stored, keys: { ...stored.keys, anthropic: next } });
        const connection = buildAnthropicConnection(next);
        if (connection) replaceConnection('anthropic', connection);
        for (const model of models) logProfileDisagreementsOnce(deriveProfile(model));
        console.log(`[AI model] The Claude model list changed; ${models.length} model(s) are offered now.`);
      } catch {
        // A failed re-list keeps the saved list; the next stale answer tries again after the interval.
      } finally {
        anthropicRefreshing = false;
      }
    })();
  }

  /**
   * Keyed connections that are REGISTERED. It decides when the never-set-up
   * launcher connection is retired, so it counts connections, not saved keys:
   * a Claude key whose list yields no model has no connection and does not
   * retire the launcher one.
   */
  function keyedConnectionCount(): number {
    return (['openai', 'deepseek', 'anthropic'] as const).filter(id => connections.has(id)).length;
  }

  /** Models an Anthropic listing must keep offering even when deprecated: the key's previous list and role choices. */
  function anthropicKeepIds(): Set<string> {
    const ids = new Set((stored.keys.anthropic?.models ?? []).map(model => model.id));
    for (const choice of Object.values(stored.roles)) {
      const match = /^anthropic\.(.+)$/.exec(choice?.modelKey ?? '');
      if (match) ids.add(match[1]);
    }
    return ids;
  }

  /** Team counts as configured with launcher credentials or a healthy client. */
  function teamConfigured(): boolean {
    const team = connections.get('team');
    return Boolean(team && (credentialsPresent || team.client.isAvailable()));
  }

  function configuredConnections(): LlmConnection[] {
    return LLM_CONNECTION_ORDER
      .map(id => connections.get(id))
      .filter((connection): connection is LlmConnection => Boolean(connection))
      .filter(connection => connection.id !== 'team' || teamConfigured());
  }

  function ordered(): LlmConnection[] {
    return LLM_CONNECTION_ORDER
      .map(id => connections.get(id))
      .filter((connection): connection is LlmConnection => Boolean(connection));
  }

  const teamVisibleWithoutCredentials = deps.teamVisibleWithoutCredentials ?? (() => true);
  /** Team is hidden (Amazon Employee off) unless it really is configured. */
  function teamHidden(): boolean {
    return !teamVisibleWithoutCredentials() && !teamConfigured();
  }
  /** What the owner sees: configured connections, else every one (team only when it may show). */
  function displayConnections(): LlmConnection[] {
    const configured = configuredConnections();
    if (configured.length) return configured;
    return teamVisibleWithoutCredentials() ? ordered() : ordered().filter(connection => connection.id !== 'team');
  }
  /** Nothing is set up and team may not show: no model name reaches the browser. */
  function nothingSetUp(): boolean {
    return teamHidden() && configuredConnections().length === 0;
  }

  function findEntry(key: string): { connection: LlmConnection; entry: LlmModelEntry } | null {
    for (const connection of ordered()) {
      const entry = connection.models.find(model => model.key === key);
      if (entry) return { connection, entry };
    }
    return null;
  }

  /**
   * Default chain: team default when configured, then OpenAI, then DeepSeek, then Claude. On the chosen connection a
   * role gets its role default when it has one (Claude's Haiku-line Organizing model), else the connection default.
   */
  function defaultChain(role: AiModelRole): { connection: LlmConnection; entry: LlmModelEntry } {
    const candidates = configuredConnections();
    for (const connection of candidates.length ? candidates : ordered()) {
      const entry = connectionRoleDefaultEntry(connection, role);
      if (entry) return { connection, entry };
    }
    throw new Error('No AI model connection exists.');
  }

  function resolveRole(role: AiModelRole): {
    connection: LlmConnection;
    entry: LlmModelEntry;
    thinking: LlmThinkingLevel;
    chosen: boolean;
    unavailableChoice?: string;
  } {
    const choice = stored.roles[role];
    const thinking = choice?.thinking ?? 'off';
    const picked = choice?.modelKey ? findEntry(choice.modelKey) : null;
    if (picked) return { ...picked, thinking, chosen: true };
    return {
      ...defaultChain(role),
      thinking,
      chosen: false,
      ...(choice?.modelKey ? { unavailableChoice: choice.modelKey } : {}),
    };
  }

  function publishRuntimeLimits(identity: LlmRuntimeIdentity): void {
    // limits.ts reads this per call outside a model operation (write_file
    // ceilings, large-context rules); chat turns use their own model's window.
    process.env.BOTBOY_INFERENCE_MAX_CONTEXT_TOKENS = String(identity.maxContextTokens);
  }

  // ── Boot ──
  // Refresh each saved key's model list (best effort: offline keeps the
  // saved list). Persisted only for schema-2 files.
  const refreshed = { ...stored.keys };
  const [openAiListed, deepSeekListed, anthropicListed] = await Promise.all([
    stored.keys.openai
      ? listOpenAiModels(openAiEndpoint, stored.keys.openai.apiKey, fetchImpl, bootListTimeoutMs).catch(() => null)
      : null,
    stored.keys.deepseek
      ? listDeepSeekModels(deepSeekEndpoint, stored.keys.deepseek.apiKey, fetchImpl, bootListTimeoutMs).catch(() => null)
      : null,
    stored.keys.anthropic
      ? listAnthropicModels({ endpoint: anthropicEndpoint, apiKey: stored.keys.anthropic.apiKey, fetchImpl, timeoutMs: bootListTimeoutMs, overallTimeoutMs: bootListTimeoutMs })
          .then(result => selectOfferedModels(result.models, anthropicKeepIds()))
          .catch(() => null)
      : null,
  ]);
  let listsChanged = false;
  if (refreshed.openai && openAiListed?.length && openAiListed.join(',') !== refreshed.openai.models.join(',')) {
    refreshed.openai = { ...refreshed.openai, models: openAiListed };
    listsChanged = true;
  }
  if (refreshed.deepseek && deepSeekListed?.length
    && JSON.stringify(deepSeekListed) !== JSON.stringify(refreshed.deepseek.models)) {
    refreshed.deepseek = { ...refreshed.deepseek, models: deepSeekListed };
    listsChanged = true;
  }
  if (refreshed.anthropic && anthropicListed?.length
    && JSON.stringify(anthropicListed) !== JSON.stringify(refreshed.anthropic.models)) {
    refreshed.anthropic = { ...refreshed.anthropic, models: anthropicListed };
    listsChanged = true;
  }
  for (const model of anthropicListed ?? []) logProfileDisagreementsOnce(deriveProfile(model));
  if (listsChanged) {
    const next = { ...stored, keys: refreshed };
    if (persistedSchema === SCHEMA_VERSION) {
      try { persist(next); } catch { stored = next; /* the saved lists stay usable */ }
    } else {
      stored = next;
    }
  }
  if (stored.keys.openai) connections.set('openai', buildOpenAiConnection(stored.keys.openai));
  if (stored.keys.deepseek) connections.set('deepseek', buildDeepSeekConnection(stored.keys.deepseek));
  if (stored.keys.anthropic) {
    const claude = buildAnthropicConnection(stored.keys.anthropic);
    if (claude) connections.set('anthropic', claude);
  }
  // The launcher provider stays available whenever its credentials exist, and
  // is the only (possibly not set up) connection when nothing else is.
  if (credentialsPresent || keyedConnectionCount() === 0) {
    connections.set('team', buildTeamConnection(deps.envProvider.createClient({ usageService: deps.usageService })));
  }
  await Promise.all(ordered().map(connection => connection.client.healthCheck().catch(() => false)));

  type ResolvedRole = ReturnType<typeof resolveRole>;
  // What each role is bound to right now. Status reads this, never a fresh
  // resolution, so a health flap cannot make Settings show a model that is
  // not the one serving the role.
  const roleBindings = new Map<AiModelRole, ResolvedRole>();
  const signatureOf = (resolved: ResolvedRole) =>
    `${resolved.connection.id}#${resolved.connection.version}#${resolved.entry.key}#${resolved.thinking}`;
  const roleSwitches = Object.fromEntries(AI_MODEL_ROLES.map(role => {
    const resolved = resolveRole(role);
    roleBindings.set(role, resolved);
    const bound = bindLlmModel(resolved.connection, resolved.entry, { thinking: resolved.thinking });
    return [role, createLlmClientSwitch(bound, identityFor(resolved.connection, resolved.entry))];
  })) as Record<AiModelRole, LlmClientSwitch>;
  const processing = roleSwitches.processing;
  const documents = roleSwitches.documents;
  publishRuntimeLimits(processing.identity());

  /** Re-point each role whose model, thinking level, or connection changed. */
  function rebindRoles(): void {
    for (const role of AI_MODEL_ROLES) {
      const resolved = resolveRole(role);
      const previous = roleBindings.get(role);
      roleBindings.set(role, resolved);
      if (previous && signatureOf(previous) === signatureOf(resolved)) continue;
      const identity = identityFor(resolved.connection, resolved.entry);
      roleSwitches[role].activate(bindLlmModel(resolved.connection, resolved.entry, { thinking: resolved.thinking }), identity);
      console.log(`✅ AI model for ${ROLE_TEXT[role]}: ${resolved.entry.label} (${resolved.connection.label}${resolved.chosen ? '' : ', default'}; thinking ${resolved.thinking})`);
      if (role === 'processing') {
        publishRuntimeLimits(identity);
        try { deps.onActivated?.(identity); } catch (error) {
          console.warn(`[AI model] Post-activation hook failed: ${error instanceof Error ? error.name : 'Error'}`);
        }
      }
    }
  }

  function boundRole(role: AiModelRole): ResolvedRole {
    return roleBindings.get(role) ?? resolveRole(role);
  }

  function emitConnectionChange(connectionId: LlmConnectionId): void {
    for (const listener of [...connectionListeners]) {
      try { listener({ connectionId }); } catch (error) {
        console.warn(`[AI model] Connection listener failed: ${error instanceof Error ? error.name : 'Error'}`);
      }
    }
  }

  /**
   * Install, replace, or remove one connection: re-point roles first, then
   * stop chat turns pinned to each retired connection, then close its client
   * (requests already in flight finish on it; only its health timer stops).
   */
  function replaceConnection(id: LlmConnectionId, next: LlmConnection | undefined): void {
    const retired: LlmConnection[] = [];
    const previous = connections.get(id);
    if (previous) retired.push(previous);
    if (next) connections.set(id, next);
    else connections.delete(id);
    // Removing the last key returns to the launcher configuration; saving the
    // first key retires a launcher provider that was never set up.
    if (keyedConnectionCount() === 0 && !connections.has('team')) {
      const team = buildTeamConnection(deps.envProvider.createClient({ usageService: deps.usageService }));
      connections.set('team', team);
      void team.client.healthCheck().catch(() => false);
    } else if (keyedConnectionCount() > 0 && connections.has('team') && !teamConfigured()) {
      retired.push(connections.get('team')!);
      connections.delete('team');
    }
    settingsVersion += 1;
    rebindRoles();
    for (const connection of retired) {
      emitConnectionChange(connection.id);
      try { connection.client.close(); } catch { /* closing a finished client is best effort */ }
    }
  }

  async function exclusive<T>(work: () => Promise<T>): Promise<T> {
    if (saving) {
      throw new AiModelSettingsError('busy', 'Another AI model change is still being verified.', 'Wait for it to finish, then try again.', 409);
    }
    const running = work();
    saving = running;
    try {
      return await running;
    } finally {
      saving = null;
    }
  }

  function storageFailed(action: string): AiModelSettingsError {
    return new AiModelSettingsError(
      'storage_failed',
      `BotBoy could not ${action}.`,
      'Check that ~/.personal-productivity-tracker is writable, then try again.',
      500,
    );
  }

  /** One tiny real generation proves auth, model access, and credit. */
  async function verifyConnection(candidate: LlmConnection, provider: AiModelKeyProvider): Promise<void> {
    const entry = connectionDefaultEntry(candidate);
    if (!entry) {
      throw new AiModelSettingsError('no_chat_models', `This ${PROVIDER_TEXT[provider].label} key lists no chat models BotBoy can use.`, `Check the key's model access at ${PROVIDER_TEXT[provider].keysUrl.split('/')[0]}, then try again.`);
    }
    try {
      await bindLlmModel(candidate, entry).chatCompletionPrimary(keyVerificationRequest());
      await candidate.client.healthCheck();
    } catch (error) {
      candidate.client.close();
      // The owner sees a short mapped sentence ("rejected the verification request (HTTP 400)"); the provider's own
      // words, which say WHAT it rejected, are kept here for whoever reads the log.
      console.warn(keyCheckFailureLine(error, PROVIDER_TEXT[provider].label));
      throw modelSettingsError(error, provider);
    }
  }

  /**
   * Anthropic (Claude): verify the key (model list, then one minimal 16-token
   * message), store it with its model list, then register the connection that
   * offers every listed Claude model in chat and the role selects. A failed
   * check leaves every connection and the stored file untouched.
   */
  async function saveAnthropicKey(apiKey: string): Promise<AiModelStatus> {
    const at = now().toISOString();
    let verification: Awaited<ReturnType<typeof verifyAnthropicKey>>;
    try {
      verification = await verifyAnthropicKey({ endpoint: anthropicEndpoint, apiKey, fetchImpl, keep: anthropicKeepIds() });
    } catch (error) {
      throw modelSettingsError(error, 'anthropic');
    }
    if (!verification.models.length || !verification.verifiedModel) {
      throw new AiModelSettingsError(
        'no_chat_models',
        'This Anthropic key lists no Claude models BotBoy can use.',
        `Check the key's model access at ${PROVIDER_TEXT.anthropic.keysUrl.split('/')[0]}, then try again.`,
      );
    }
    const key: StoredAnthropicKey = { apiKey, savedAt: at, verifiedAt: at, models: [...verification.models] };
    const candidate = buildAnthropicConnection(key);
    if (!candidate) {
      throw new AiModelSettingsError(
        'no_chat_models',
        'This Anthropic key lists no Claude models BotBoy can use.',
        `Check the key's model access at ${PROVIDER_TEXT.anthropic.keysUrl.split('/')[0]}, then try again.`,
      );
    }
    // The free model-list probe marks the new client healthy; a failure here only leaves it "needs attention".
    await candidate.client.healthCheck().catch(() => false);
    try {
      persist({ ...stored, keys: { ...stored.keys, anthropic: key } });
    } catch {
      candidate.client.close();
      throw storageFailed('save the verified key privately');
    }
    replaceConnection('anthropic', candidate);
    for (const model of key.models) logProfileDisagreementsOnce(deriveProfile(model));
    console.log(`[AI model] ${PROVIDER_TEXT.anthropic.label} key ${keySuffix(apiKey)} verified; ${key.models.length} Claude model(s) listed.`);
    return status();
  }

  async function saveKey(provider: AiModelKeyProvider, apiKey: string): Promise<AiModelStatus> {
    if (provider === 'anthropic') return saveAnthropicKey(apiKey);
    const at = now().toISOString();
    let candidate: LlmConnection;
    let nextKeys: StoredAiModelSettings['keys'];
    if (provider === 'openai') {
      const listed = await listOpenAiModels(openAiEndpoint, apiKey, fetchImpl);
      if (listed && !listed.length) {
        throw new AiModelSettingsError('no_chat_models', 'This OpenAI key lists no chat models BotBoy can use.', 'Check the project\'s model access at platform.openai.com, then try again.');
      }
      const key: StoredOpenAiKey = { apiKey, savedAt: at, verifiedAt: at, models: listed ?? [...OPENAI_PLATFORM_MODEL_IDS] };
      candidate = buildOpenAiConnection(key);
      nextKeys = { ...stored.keys, openai: key };
    } else {
      const listed = await listDeepSeekModels(deepSeekEndpoint, apiKey, fetchImpl);
      if (!listed.length) {
        throw new AiModelSettingsError('no_chat_models', 'This DeepSeek key lists no chat models BotBoy can use.', 'Check the key at platform.deepseek.com, then try again.');
      }
      const key: StoredDeepSeekKey = { apiKey, savedAt: at, verifiedAt: at, models: listed };
      candidate = buildDeepSeekConnection(key);
      nextKeys = { ...stored.keys, deepseek: key };
    }
    await verifyConnection(candidate, provider);
    try {
      persist({ ...stored, keys: nextKeys });
    } catch {
      candidate.client.close();
      throw storageFailed('save the verified key privately');
    }
    replaceConnection(provider, candidate);
    console.log(`[AI model] ${PROVIDER_TEXT[provider].label} key ${keySuffix(apiKey)} verified; ${candidate.models.length} model(s) available.`);
    return status();
  }

  async function removeKey(provider: AiModelKeyProvider): Promise<AiModelStatus> {
    const { [provider]: _removed, ...remaining } = stored.keys;
    try {
      persist({ ...stored, keys: remaining });
    } catch {
      throw storageFailed('remove the saved key');
    }
    if (connections.has(provider)) {
      replaceConnection(provider, undefined);
      console.log(`[AI model] ${PROVIDER_TEXT[provider].label} key removed.`);
    } else {
      // The file changed even without a live connection (a Claude key whose list yielded no model); open pages refresh.
      settingsVersion += 1;
      rebindRoles();
      if (provider === 'anthropic') console.log(`[AI model] ${PROVIDER_TEXT[provider].label} key removed.`);
    }
    return status();
  }

  async function setRoleChoice(role: AiModelRole, choice: { modelKey?: unknown; thinking?: unknown }): Promise<AiModelStatus> {
    const current = stored.roles[role] ?? {};
    let modelKey = current.modelKey;
    if (choice.modelKey !== undefined) {
      if (choice.modelKey === null || choice.modelKey === '') {
        modelKey = undefined;
      } else if (typeof choice.modelKey !== 'string' || !LLM_MODEL_KEY_PATTERN.test(choice.modelKey) || !findEntry(choice.modelKey)) {
        throw new AiModelSettingsError('model_unavailable', 'That model is not offered by a connected provider right now.', 'Pick a model from the list in Settings → AI model.');
      } else {
        modelKey = choice.modelKey;
      }
    }
    let thinking = current.thinking;
    if (choice.thinking !== undefined) {
      if (!isLlmThinkingLevel(choice.thinking)) {
        throw new AiModelSettingsError('invalid_thinking', 'Thinking must be off, low, high, or max.', 'Pick a Thinking level from the list in Settings → AI model.');
      }
      thinking = choice.thinking === 'off' ? undefined : choice.thinking;
    }
    const nextRole: StoredRole = { ...(modelKey ? { modelKey } : {}), ...(thinking ? { thinking } : {}), ...(current.extra ? { extra: current.extra } : {}) };
    const { [role]: _previous, ...otherRoles } = stored.roles;
    try {
      persist({ ...stored, roles: { ...otherRoles, ...(modelKey || thinking || current.extra ? { [role]: nextRole } : {}) } });
    } catch {
      throw storageFailed('save the model choice');
    }
    settingsVersion += 1;
    rebindRoles();
    return status();
  }

  function connectionReady(connection: LlmConnection): boolean {
    const issueCode = connection.client.getProviderIssue?.()?.code;
    // Rate limiting and provider overload (a 529) clear on their own and do not make a connection unusable.
    return connection.client.isAvailable() && (!issueCode || issueCode === 'rate_limited' || issueCode === 'overloaded');
  }

  /** Cheap, non-throwing state for the version poll. */
  function currentState(): AiModelState {
    const configured = configuredConnections();
    if (!configured.length) return 'not_configured';
    return configured.some(connectionReady) ? 'ready' : 'unavailable';
  }

  function connectionStatus(connection: LlmConnection): AiModelConnectionStatus {
    const key = connection.id === 'openai' ? stored.keys.openai
      : connection.id === 'deepseek' ? stored.keys.deepseek
        : connection.id === 'anthropic' ? stored.keys.anthropic
          : undefined;
    const issue = issueFor(connection.client.getProviderIssue?.(), connection);
    return {
      id: connection.id,
      // Same heading the chat picker groups under.
      label: connection.label,
      source: connection.source,
      healthy: connection.client.isAvailable(),
      ...(key ? { keySuffix: keySuffix(key.apiKey), savedAt: key.savedAt, verifiedAt: key.verifiedAt } : {}),
      models: connection.models.map(entry => ({
        key: entry.key,
        label: entry.label,
        ...(entry.capabilities.images !== undefined ? { images: entry.capabilities.images } : {}),
        contextWindow: entry.capabilities.contextWindow,
        ...(entry.capabilities.thinkingOff !== undefined ? { thinkingOff: entry.capabilities.thinkingOff } : {}),
      })),
      ...(issue ? { issue } : {}),
    };
  }

  function roleStatus(role: AiModelRole): AiModelRoleStatus {
    if (nothingSetUp()) {
      return {
        modelKey: '',
        label: 'Not set up',
        connectionId: 'team',
        connectionLabel: '',
        thinking: stored.roles[role]?.thinking ?? 'off',
        chosen: false,
      };
    }
    const resolved = boundRole(role);
    return {
      modelKey: resolved.entry.key,
      label: resolved.entry.label,
      connectionId: resolved.connection.id,
      connectionLabel: resolved.connection.label,
      thinking: resolved.thinking,
      chosen: resolved.chosen,
      ...(resolved.unavailableChoice ? { unavailableChoice: resolved.unavailableChoice } : {}),
      ...(resolved.entry.capabilities.images !== undefined ? { images: resolved.entry.capabilities.images } : {}),
      ...(resolved.entry.capabilities.thinkingOff !== undefined ? { thinkingOff: resolved.entry.capabilities.thinkingOff } : {}),
    };
  }

  function keySummary(key: StoredKey | undefined) {
    return key ? { keySuffix: keySuffix(key.apiKey), savedAt: key.savedAt, verifiedAt: key.verifiedAt } : undefined;
  }

  function status(): AiModelStatus {
    const shown = displayConnections();
    const organizing = boundRole('processing');
    const issue = issueFor(organizing.connection.client.getProviderIssue?.(), organizing.connection);
    const openai = keySummary(stored.keys.openai);
    const deepseek = keySummary(stored.keys.deepseek);
    const anthropic = keySummary(stored.keys.anthropic);
    return {
      state: currentState(),
      configVersion: settingsVersion,
      connections: shown.map(connectionStatus),
      roles: { processing: roleStatus('processing'), documents: roleStatus('documents') },
      source: organizing.connection.source,
      provider: organizing.connection.provider.id,
      providerLabel: legacyProviderLabel(organizing.connection.provider.id),
      // Owner-facing label ("GPT-5.6 Terra"), never a gateway target path.
      backgroundModel: nothingSetUp() ? 'Not set up' : organizing.entry.label,
      healthy: organizing.connection.client.isAvailable(),
      models: shown.flatMap(connection => connection.models.map(entry => ({ key: entry.key, label: entry.label }))),
      ...(openai ? { openai } : {}),
      ...(deepseek ? { deepseek } : {}),
      ...(anthropic ? { anthropic } : {}),
      ...(credentialsPresent && keyedConnectionCount() > 0
        ? { environmentProviderLabel: legacyProviderLabel(deps.envProvider.id) }
        : {}),
      ...(issue ? { issue } : {}),
    };
  }

  const chatModels = createConnectionChatModelSource({
    connections: displayConnections,
    // D8: the team default when configured. Otherwise an explicit Organizing choice keeps today's rule (the model
    // the owner picked is the chat default); Automatic resolves through the Organizing connection's own default
    // model, so a role default (Claude's Haiku-line Organizing model) never becomes the chat default.
    defaultKey: () => {
      if (teamConfigured()) return connectionDefaultEntry(connections.get('team')!)?.key;
      const organizing = boundRole('processing');
      return organizing.chosen ? organizing.entry.key : connectionDefaultEntry(organizing.connection)?.key;
    },
    onChange: listener => {
      connectionListeners.add(listener);
      return () => { connectionListeners.delete(listener); };
    },
  });

  function validKey(provider: AiModelKeyProvider, apiKey: unknown): string {
    const key = typeof apiKey === 'string' ? apiKey.trim() : '';
    if (provider === 'anthropic') {
      // Admin keys serve the Admin API only; a regular key is `sk-ant-api…`. The one place a key enters, before any header exists (D10).
      if (isAnthropicAdminKey(key)) {
        throw new AiModelSettingsError(
          'invalid_format',
          'That is an Anthropic Admin key, which cannot call models.',
          `Create a regular API key at ${ANTHROPIC_KEYS_URL}. It starts with "sk-ant-api".`,
        );
      }
      if (!isAnthropicApiKey(key)) {
        throw new AiModelSettingsError(
          'invalid_format',
          'That does not look like an Anthropic API key.',
          `Paste the full key from ${ANTHROPIC_KEYS_URL}. It starts with "sk-ant-".`,
        );
      }
      return key;
    }
    // An Anthropic key also passes the shared sk- pattern; send it to its own card instead of failing later.
    if (looksLikeAnthropicKey(key)) {
      throw new AiModelSettingsError(
        'invalid_format',
        `That is an Anthropic key, not ${provider === 'openai' ? 'an OpenAI' : 'a DeepSeek'} key.`,
        'Paste it into the Anthropic (Claude) card instead.',
      );
    }
    if (!API_KEY_PATTERN.test(key)) {
      throw new AiModelSettingsError(
        'invalid_format',
        `That does not look like ${provider === 'openai' ? 'an OpenAI' : 'a DeepSeek'} API key.`,
        `Paste the full key from ${PROVIDER_TEXT[provider].keysUrl}. It starts with "sk-".`,
      );
    }
    return key;
  }

  function validProvider(provider: unknown): AiModelKeyProvider {
    if (provider === 'openai' || provider === 'deepseek' || provider === 'anthropic') return provider;
    throw new AiModelSettingsError('invalid_provider', 'Unknown AI model provider.', 'Use OpenAI, DeepSeek or Anthropic (Claude) in Settings → AI model.');
  }

  const service: AiModelSettingsService = {
    client: processing,
    processing,
    documents,
    chatModels,
    status,
    state: () => {
      try { return currentState(); } catch { return 'unavailable'; }
    },
    version: () => settingsVersion,
    refreshVisibility() {
      settingsVersion += 1;
    },
    saveApiKey(provider, apiKey) {
      try {
        const id = validProvider(provider);
        const key = validKey(id, apiKey);
        return exclusive(() => saveKey(id, key));
      } catch (error) {
        return Promise.reject(error);
      }
    },
    removeApiKey(provider) {
      try {
        const id = validProvider(provider);
        return exclusive(() => removeKey(id));
      } catch (error) {
        return Promise.reject(error);
      }
    },
    setRole(role, choice) {
      if (role !== 'processing' && role !== 'documents') {
        return Promise.reject(new AiModelSettingsError('invalid_role', 'Unknown background role.', 'Use the organizing or document-writing model control in Settings → AI model.'));
      }
      return exclusive(() => setRoleChoice(role, choice ?? {}));
    },
    saveOpenAiKey: apiKey => service.saveApiKey('openai', apiKey),
    removeOpenAiKey: () => service.removeApiKey('openai'),
    close() {
      for (const connection of connections.values()) {
        try { connection.client.close(); } catch { /* best effort */ }
      }
    },
  };
  console.log(`✅ AI model connections: ${ordered().map(connection => `${connection.label} (${connection.models.length} models)`).join(', ')}; organizing on ${boundRole('processing').entry.label}`);
  return service;
}
