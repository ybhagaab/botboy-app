/**
 * Settings → AI model: which model connections BotBoy has and which model
 * serves each kind of work.
 *
 * Connections (any combination, all at once):
 *   - team: the launcher/.env provider (team gateway, Bedrock, self-hosted),
 *     present when its credentials exist or when nothing else is configured;
 *   - openai: the owner's OpenAI API key (every chat model the key lists);
 *   - deepseek: the owner's DeepSeek API key (every model the key lists).
 *
 * Model choices:
 *   - chat picks per message (chat panel), from every connection;
 *   - organizing (the information pipeline, planners, visual inspection,
 *     background agent loops) and document writing each have one owner choice
 *     with its own Thinking level. Until the owner picks, each uses the
 *     default chain: team default → OpenAI → DeepSeek.
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
  createDeepSeekInferenceProvider,
  createOpenAiPlatformInferenceProvider,
  type InferenceProvider,
} from './inference-provider.js';
import {
  isLlmProviderLimitError,
  redactProviderSecrets,
  type LlmClient,
  type LlmProviderIssue,
} from './llm-client.js';
import { createLlmClientSwitch, type LlmClientSwitch, type LlmRuntimeIdentity } from './llm-client-switch.js';
import {
  LLM_CONNECTION_ORDER,
  LLM_MODEL_KEY_PATTERN,
  bindLlmModel,
  connectionDefaultEntry,
  deepSeekModelCapabilities,
  deepSeekModelEntries,
  isLlmThinkingLevel,
  isOpenAiChatModelId,
  openAiModelEntries,
  openAiModelProfile,
  parseDeepSeekModelList,
  pickDeepSeekDefaultModel,
  pickOpenAiDefaultModel,
  teamConnectionLabel,
  teamModelEntries,
  type DeepSeekModelProfile,
  type LlmConnection,
  type LlmConnectionId,
  type LlmModelEntry,
  type LlmThinkingLevel,
} from './llm-model-catalog.js';
import { createConnectionChatModelSource, type ChatModelSource } from './chat-model-source.js';
import type { LlmUsageService } from './llm-usage.js';

export const AI_MODEL_SETTINGS_FILE = 'ai-model.json';
const SCHEMA_VERSION = 2;
const API_KEY_PATTERN = /^sk-[A-Za-z0-9_-]{16,400}$/;
const MODEL_LIST_TIMEOUT_MS = 15_000;
// Boot refreshes saved model lists in parallel but must not hold startup on a
// slow or blocked provider; the saved list stays usable when this expires.
const BOOT_MODEL_LIST_TIMEOUT_MS = 5_000;

export type AiModelState = 'ready' | 'unavailable' | 'not_configured';
export type AiModelKeyProvider = 'openai' | 'deepseek';
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

interface StoredRole {
  modelKey?: string;
  thinking?: LlmThinkingLevel;
}

interface StoredAiModelSettings {
  schemaVersion: 2;
  keys: { openai?: StoredOpenAiKey; deepseek?: StoredDeepSeekKey };
  roles: { processing?: StoredRole; documents?: StoredRole };
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
  fetchImpl?: typeof fetch;
  /** Called after the organizing model changes (kick the information pipeline, log). */
  onActivated?: (identity: LlmRuntimeIdentity) => void;
  now?: () => Date;
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
};

const ROLE_TEXT: Record<AiModelRole, string> = {
  processing: 'organizing',
  documents: 'document writing',
};

function legacyProviderLabel(providerId: string): string {
  if (providerId === 'openai') return 'OpenAI (your API key)';
  if (providerId === 'deepseek') return 'DeepSeek (your API key)';
  if (providerId === 'gateway') return 'Team gateway (Amazon Bedrock)';
  if (providerId === 'bedrock') return 'Amazon Bedrock';
  if (providerId === 'openai-compatible') return 'Self-hosted model endpoint';
  return providerId;
}

function keySuffix(apiKey: string): string {
  return `…${apiKey.slice(-4)}`;
}

function issueFor(issue: LlmProviderIssue | undefined, connection: LlmConnection): AiModelIssue | undefined {
  if (!issue) return undefined;
  const provider = connection.id === 'openai' || connection.id === 'deepseek' ? PROVIDER_TEXT[connection.id] : undefined;
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
  return {
    code: issue.code,
    message: `${provider.label} is rate-limiting this key.`,
    nextAction: 'BotBoy waits and retries automatically. New accounts have lower limits that rise with use.',
    at: issue.at,
  };
}

function modelSettingsError(error: unknown, provider: AiModelKeyProvider): AiModelSettingsError {
  if (error instanceof AiModelSettingsError) return error;
  const text = PROVIDER_TEXT[provider];
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
  if (status) {
    return new AiModelSettingsError('rejected', `${text.label} rejected the verification request (HTTP ${status}).`, `Try again in a minute. If it keeps failing, create a new key at ${text.keysUrl}.`, 502);
  }
  return new AiModelSettingsError('unreachable', `BotBoy could not reach ${text.host}.`, `Check your internet connection (and any proxy or VPN rules for ${text.host}), then try again.`, 502);
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
  } catch {
    throw modelSettingsError(new Error('fetch failed'), provider);
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

/** DeepSeek GET /models: id, display name, window, output limit, image input, effort levels. */
async function listDeepSeekModels(endpoint: string, apiKey: string, fetchImpl: typeof fetch, timeoutMs?: number): Promise<DeepSeekModelProfile[]> {
  const { status, text } = await getJson(`${endpoint.replace(/\/+$/, '')}/models`, apiKey, fetchImpl, 'deepseek', timeoutMs);
  if (status < 200 || status >= 300) throw modelSettingsError(new Error(`HTTP ${status}: ${text}`), 'deepseek');
  try {
    return parseDeepSeekModelList(JSON.parse(text));
  } catch {
    throw modelSettingsError(new Error('HTTP 502: unreadable model list'), 'deepseek');
  }
}

function emptySettings(): StoredAiModelSettings {
  return { schemaVersion: SCHEMA_VERSION, keys: {}, roles: {} };
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

function storedRole(value: any): StoredRole | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const modelKey = typeof value.modelKey === 'string' && LLM_MODEL_KEY_PATTERN.test(value.modelKey) ? value.modelKey : undefined;
  const thinking = isLlmThinkingLevel(value.thinking) ? value.thinking : undefined;
  return modelKey || thinking ? { ...(modelKey ? { modelKey } : {}), ...(thinking ? { thinking } : {}) } : undefined;
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
      ? { settings: { schemaVersion: SCHEMA_VERSION, keys: { openai }, roles: {} }, schemaVersion: 1 }
      : unreadable();
  }
  if (value?.schemaVersion !== SCHEMA_VERSION || !value.keys || typeof value.keys !== 'object') return unreadable();
  const openai = value.keys.openai ? storedOpenAi(value.keys.openai) : undefined;
  const deepseek = value.keys.deepseek ? storedDeepSeek(value.keys.deepseek) : undefined;
  const processing = storedRole(value.roles?.processing);
  const documents = storedRole(value.roles?.documents);
  return {
    settings: {
      schemaVersion: SCHEMA_VERSION,
      keys: { ...(openai ? { openai } : {}), ...(deepseek ? { deepseek } : {}) },
      roles: { ...(processing ? { processing } : {}), ...(documents ? { documents } : {}) },
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
      fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`);
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
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ?? (() => new Date());
  const credentialsPresent = Boolean(deps.environmentCredentialsPresent);

  const connections = new Map<LlmConnectionId, LlmConnection>();
  const connectionListeners = new Set<(event: { connectionId: string }) => void>();
  let connectionCounter = 0;
  let settingsVersion = 1;
  let saving: Promise<unknown> | null = null;

  const loaded = readStored(file);
  let stored: StoredAiModelSettings = loaded?.settings ?? emptySettings();
  // A schema-1 file is rewritten only when the owner next changes something.
  let persistedSchema = loaded?.schemaVersion ?? 0;

  function persist(next: StoredAiModelSettings): void {
    const empty = !next.keys.openai && !next.keys.deepseek && !next.roles.processing && !next.roles.documents;
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
    const defaultModel = pickDeepSeekDefaultModel(key.models);
    const provider = createDeepSeekInferenceProvider({
      apiKey: key.apiKey,
      availableModels: key.models.map(model => model.id),
      defaultModel,
      defaultContextTokens: deepSeekModelCapabilities(key.models.find(model => model.id === defaultModel)).contextWindow,
      endpoint: deepSeekEndpoint,
      env,
    });
    return {
      id: 'deepseek',
      label: 'DeepSeek',
      source: 'settings',
      client: provider.createClient({ usageService: deps.usageService }),
      provider: descriptor(provider),
      models: deepSeekModelEntries(key.models, defaultModel),
      version: ++connectionCounter,
    };
  }

  function keyedConnectionCount(): number {
    return (connections.has('openai') ? 1 : 0) + (connections.has('deepseek') ? 1 : 0);
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

  function findEntry(key: string): { connection: LlmConnection; entry: LlmModelEntry } | null {
    for (const connection of ordered()) {
      const entry = connection.models.find(model => model.key === key);
      if (entry) return { connection, entry };
    }
    return null;
  }

  /** Default chain: team default when configured, then OpenAI, then DeepSeek. */
  function defaultChain(): { connection: LlmConnection; entry: LlmModelEntry } {
    const candidates = configuredConnections();
    for (const connection of candidates.length ? candidates : ordered()) {
      const entry = connectionDefaultEntry(connection);
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
      ...defaultChain(),
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
  const [openAiListed, deepSeekListed] = await Promise.all([
    stored.keys.openai
      ? listOpenAiModels(openAiEndpoint, stored.keys.openai.apiKey, fetchImpl, BOOT_MODEL_LIST_TIMEOUT_MS).catch(() => null)
      : null,
    stored.keys.deepseek
      ? listDeepSeekModels(deepSeekEndpoint, stored.keys.deepseek.apiKey, fetchImpl, BOOT_MODEL_LIST_TIMEOUT_MS).catch(() => null)
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
      await bindLlmModel(candidate, entry).chatCompletionPrimary({
        messages: [{ role: 'user', content: 'Reply with the single word OK.' }],
        maxTokens: 16,
        think: false,
        usageContext: { workload: 'system' },
      });
      await candidate.client.healthCheck();
    } catch (error) {
      candidate.client.close();
      throw modelSettingsError(error, provider);
    }
  }

  async function saveKey(provider: AiModelKeyProvider, apiKey: string): Promise<AiModelStatus> {
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
      // The file changed even without a live connection; open pages refresh.
      settingsVersion += 1;
      rebindRoles();
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
    const nextRole: StoredRole = { ...(modelKey ? { modelKey } : {}), ...(thinking ? { thinking } : {}) };
    const { [role]: _previous, ...otherRoles } = stored.roles;
    try {
      persist({ ...stored, roles: { ...otherRoles, ...(modelKey || thinking ? { [role]: nextRole } : {}) } });
    } catch {
      throw storageFailed('save the model choice');
    }
    settingsVersion += 1;
    rebindRoles();
    return status();
  }

  function connectionReady(connection: LlmConnection): boolean {
    const issueCode = connection.client.getProviderIssue?.()?.code;
    return connection.client.isAvailable() && (!issueCode || issueCode === 'rate_limited');
  }

  /** Cheap, non-throwing state for the version poll. */
  function currentState(): AiModelState {
    const configured = configuredConnections();
    if (!configured.length) return 'not_configured';
    return configured.some(connectionReady) ? 'ready' : 'unavailable';
  }

  function connectionStatus(connection: LlmConnection): AiModelConnectionStatus {
    const key = connection.id === 'openai' ? stored.keys.openai : connection.id === 'deepseek' ? stored.keys.deepseek : undefined;
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
      })),
      ...(issue ? { issue } : {}),
    };
  }

  function roleStatus(role: AiModelRole): AiModelRoleStatus {
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
    };
  }

  function keySummary(key: StoredKey | undefined) {
    return key ? { keySuffix: keySuffix(key.apiKey), savedAt: key.savedAt, verifiedAt: key.verifiedAt } : undefined;
  }

  function status(): AiModelStatus {
    const visible = configuredConnections();
    const shown = visible.length ? visible : ordered();
    const organizing = boundRole('processing');
    const issue = issueFor(organizing.connection.client.getProviderIssue?.(), organizing.connection);
    const openai = keySummary(stored.keys.openai);
    const deepseek = keySummary(stored.keys.deepseek);
    return {
      state: currentState(),
      configVersion: settingsVersion,
      connections: shown.map(connectionStatus),
      roles: { processing: roleStatus('processing'), documents: roleStatus('documents') },
      source: organizing.connection.source,
      provider: organizing.connection.provider.id,
      providerLabel: legacyProviderLabel(organizing.connection.provider.id),
      // Owner-facing label ("GPT-5.6 Terra"), never a gateway target path.
      backgroundModel: organizing.entry.label,
      healthy: organizing.connection.client.isAvailable(),
      models: shown.flatMap(connection => connection.models.map(entry => ({ key: entry.key, label: entry.label }))),
      ...(openai ? { openai } : {}),
      ...(deepseek ? { deepseek } : {}),
      ...(credentialsPresent && keyedConnectionCount() > 0
        ? { environmentProviderLabel: legacyProviderLabel(deps.envProvider.id) }
        : {}),
      ...(issue ? { issue } : {}),
    };
  }

  const chatModels = createConnectionChatModelSource({
    connections: () => {
      const configured = configuredConnections();
      return configured.length ? configured : ordered();
    },
    // D4: the team default when configured, otherwise the organizing model.
    defaultKey: () => (teamConfigured()
      ? connectionDefaultEntry(connections.get('team')!)?.key
      : boundRole('processing').entry.key),
    onChange: listener => {
      connectionListeners.add(listener);
      return () => { connectionListeners.delete(listener); };
    },
  });

  function validKey(provider: AiModelKeyProvider, apiKey: unknown): string {
    const key = typeof apiKey === 'string' ? apiKey.trim() : '';
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
    if (provider === 'openai' || provider === 'deepseek') return provider;
    throw new AiModelSettingsError('invalid_provider', 'Unknown AI model provider.', 'Use OpenAI or DeepSeek in Settings → AI model.');
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
