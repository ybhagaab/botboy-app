/**
 * Settings → AI model: the owner pastes an OpenAI API key, BotBoy verifies it,
 * stores it privately, and switches every model workload (chat and the
 * background information pipeline) to it immediately — no restart.
 *
 * Boundaries this module owns:
 *   - The key lives only in ~/.personal-productivity-tracker/ai-model.json
 *     (0600, atomic). Never SQLite (query_db can read the database), never
 *     process.env (model-run shells inherit it), never a browser response.
 *     The model-command Seatbelt profile denies that directory to every
 *     model-run process; in-process file tools refuse links into it.
 *   - Activation is verified before anything changes: the key must list the
 *     background model and complete one tiny generation. A failed save
 *     leaves the current provider untouched.
 *   - Choosing a provider is explicit. A saved key wins over launcher/.env
 *     configuration; removing it returns to that configuration. BotBoy never
 *     falls back between providers on its own.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  BLESSED_CHAT_MODELS,
  OPENAI_PLATFORM_DEFAULT_MODEL,
  OPENAI_PLATFORM_ENDPOINT,
  OPENAI_PLATFORM_MODEL_IDS,
  createOpenAiPlatformInferenceProvider,
  getChatModelCatalog,
  type InferenceProvider,
} from './inference-provider.js';
import {
  isLlmProviderLimitError,
  redactProviderSecrets,
  type LlmClient,
  type LlmProviderIssue,
} from './llm-client.js';
import { createLlmClientSwitch, type LlmClientSwitch, type LlmRuntimeIdentity } from './llm-client-switch.js';
import type { LlmUsageService } from './llm-usage.js';

export const AI_MODEL_SETTINGS_FILE = 'ai-model.json';
const SCHEMA_VERSION = 1;
const OPENAI_KEY_PATTERN = /^sk-[A-Za-z0-9_-]{16,400}$/;
const MODEL_LIST_TIMEOUT_MS = 15_000;

export type AiModelState = 'ready' | 'unavailable' | 'not_configured';

export interface AiModelStatus {
  readonly state: AiModelState;
  readonly source: 'settings' | 'environment';
  readonly provider: string;
  readonly providerLabel: string;
  /** Model BotBoy uses for background information management. */
  readonly backgroundModel: string;
  readonly healthy: boolean;
  /** Chat models the active configuration offers (labels only). */
  readonly models: readonly { key: string; label: string }[];
  readonly openai?: {
    readonly keySuffix: string;
    readonly savedAt: string;
    readonly verifiedAt: string;
  };
  /** Present only when an OpenAI key could be saved alongside the environment provider. */
  readonly environmentProviderLabel?: string;
  readonly issue?: {
    readonly code: string;
    readonly message: string;
    readonly nextAction: string;
    readonly at: string;
  };
  readonly configVersion: number;
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
  /** The single client every BotBoy consumer holds. */
  readonly client: LlmClientSwitch;
  status(): AiModelStatus;
  /** Cheap, non-throwing readiness for the dashboard version poll. */
  state(): AiModelState;
  saveOpenAiKey(apiKey: unknown): Promise<AiModelStatus>;
  removeOpenAiKey(): Promise<AiModelStatus>;
  version(): number;
}

interface StoredAiModelSettings {
  schemaVersion: 1;
  provider: 'openai';
  apiKey: string;
  savedAt: string;
  verifiedAt: string;
  models: string[];
}

interface AiModelSettingsDeps {
  envProvider: InferenceProvider;
  usageService?: LlmUsageService;
  env?: NodeJS.ProcessEnv;
  /** ~/.personal-productivity-tracker by default. */
  privateRoot?: string;
  /** True when launcher/.env carries a usable credential for envProvider. */
  environmentCredentialsPresent?: boolean;
  /** Test seams: hosted endpoint and HTTP client for the model list. */
  openAiEndpoint?: string;
  fetchImpl?: typeof fetch;
  /** Called after every activation (kick the information pipeline, log). */
  onActivated?: (identity: LlmRuntimeIdentity) => void;
  now?: () => Date;
}

function providerLabel(providerId: string): string {
  if (providerId === 'openai') return 'OpenAI (your API key)';
  if (providerId === 'gateway') return 'Team gateway (Amazon Bedrock)';
  if (providerId === 'bedrock') return 'Amazon Bedrock';
  if (providerId === 'openai-compatible') return 'Self-hosted model endpoint';
  return providerId;
}

function keySuffix(apiKey: string): string {
  return `…${apiKey.slice(-4)}`;
}

function identityFor(provider: InferenceProvider, source: LlmRuntimeIdentity['source']): LlmRuntimeIdentity {
  return {
    providerId: provider.id,
    endpoint: provider.endpoint,
    model: provider.model,
    apiMode: provider.apiMode,
    maxContextTokens: provider.maxContextTokens,
    source,
  };
}

function issueFor(issue: LlmProviderIssue | undefined): AiModelStatus['issue'] {
  if (!issue) return undefined;
  if (issue.code === 'auth_rejected') {
    return {
      code: issue.code,
      message: 'OpenAI rejected the saved API key.',
      nextAction: 'Create or copy a current key at platform.openai.com/api-keys and save it here again.',
      at: issue.at,
    };
  }
  if (issue.code === 'quota_exhausted') {
    return {
      code: issue.code,
      message: 'The OpenAI account behind this key has no available credit.',
      nextAction: 'Add credit at platform.openai.com → Billing. BotBoy resumes on its own once calls succeed.',
      at: issue.at,
    };
  }
  return {
    code: issue.code,
    message: 'OpenAI is rate-limiting this key.',
    nextAction: 'BotBoy waits and retries automatically. New OpenAI accounts have lower limits that rise with use.',
    at: issue.at,
  };
}

function modelSettingsError(error: unknown): AiModelSettingsError {
  if (error instanceof AiModelSettingsError) return error;
  if (isLlmProviderLimitError(error)) {
    return (error as any).code === 'LLM_QUOTA_EXHAUSTED'
      ? new AiModelSettingsError('no_credit', 'Your OpenAI account has no available credit.', 'Add credit at platform.openai.com → Billing, then save the key again.')
      : new AiModelSettingsError('rate_limited', 'OpenAI is rate-limiting this key right now.', 'Wait a minute, then save the key again.', 429);
  }
  const message = redactProviderSecrets(error instanceof Error ? error.message : String(error));
  const status = /^HTTP (\d{3})/.exec(message)?.[1];
  if (status === '401') {
    return new AiModelSettingsError('invalid_key', 'OpenAI rejected this API key.', 'Copy a current key from platform.openai.com/api-keys and try again.');
  }
  if (status === '403') {
    return new AiModelSettingsError('forbidden', 'This key is not allowed to use the models BotBoy needs.', 'Use a key whose project can call GPT-5.6 Terra (Responses API write access), then try again.');
  }
  if (status === '404') {
    return new AiModelSettingsError('model_unavailable', 'This key cannot use GPT-5.6 Terra, which BotBoy uses for background work.', 'Check the project\'s model access at platform.openai.com, then try again.');
  }
  if (status) {
    return new AiModelSettingsError('rejected', `OpenAI rejected the verification request (HTTP ${status}).`, 'Try again in a minute. If it keeps failing, create a new key at platform.openai.com/api-keys.', 502);
  }
  return new AiModelSettingsError('unreachable', 'BotBoy could not reach api.openai.com.', 'Check your internet connection (and any proxy or VPN rules for api.openai.com), then try again.', 502);
}

/** GET /models with the candidate key. Non-generative: no tokens, no usage row. */
async function listPlatformModels(
  endpoint: string,
  apiKey: string,
  fetchImpl: typeof fetch,
): Promise<readonly string[] | undefined> {
  let response: Response;
  try {
    response = await fetchImpl(`${endpoint.replace(/\/+$/, '')}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(MODEL_LIST_TIMEOUT_MS),
    });
  } catch {
    throw modelSettingsError(new Error('fetch failed'));
  }
  const text = await response.text().catch(() => '');
  if (response.status === 403) return undefined; // restricted key: listing not permitted, generation decides
  if (!response.ok) {
    if (response.status === 429 && /insufficient_quota/.test(text)) {
      throw modelSettingsError(Object.assign(new Error('quota'), { code: 'LLM_QUOTA_EXHAUSTED' }));
    }
    throw modelSettingsError(new Error(`HTTP ${response.status}: ${text}`));
  }
  let ids: string[] = [];
  try {
    const parsed = JSON.parse(text);
    ids = Array.isArray(parsed?.data) ? parsed.data.map((entry: any) => String(entry?.id ?? '')) : [];
  } catch {
    throw modelSettingsError(new Error('HTTP 502: unreadable model list'));
  }
  const offered = new Set(ids);
  return OPENAI_PLATFORM_MODEL_IDS.filter(id => offered.has(id));
}

function readStored(file: string): StoredAiModelSettings | undefined {
  let raw: string;
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) return undefined;
    // Self-heal permissions: the key must never be readable by other users.
    if ((stat.mode & 0o077) !== 0) fs.chmodSync(file, 0o600);
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
  try {
    const value = JSON.parse(raw);
    if (value?.schemaVersion !== SCHEMA_VERSION || value.provider !== 'openai'
      || typeof value.apiKey !== 'string' || !OPENAI_KEY_PATTERN.test(value.apiKey)) {
      console.warn('[AI model] Ignoring an unreadable Settings → AI model file; saving the key again replaces it.');
      return undefined;
    }
    return {
      schemaVersion: SCHEMA_VERSION,
      provider: 'openai',
      apiKey: value.apiKey,
      savedAt: String(value.savedAt ?? ''),
      verifiedAt: String(value.verifiedAt ?? ''),
      models: Array.isArray(value.models)
        ? value.models.map(String).filter((id: string) => OPENAI_PLATFORM_MODEL_IDS.includes(id))
        : [...OPENAI_PLATFORM_MODEL_IDS],
    };
  } catch {
    console.warn('[AI model] Ignoring an unreadable Settings → AI model file; saving the key again replaces it.');
    return undefined;
  }
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
    // Never leave a stray copy of the key behind a failed save.
    try { fs.rmSync(temporary, { force: true }); } catch { /* best effort */ }
    throw error;
  }
}

export async function createAiModelSettingsService(deps: AiModelSettingsDeps): Promise<AiModelSettingsService> {
  const env = deps.env ?? process.env;
  const privateRoot = deps.privateRoot ?? path.join(os.homedir(), '.personal-productivity-tracker');
  const file = path.join(privateRoot, AI_MODEL_SETTINGS_FILE);
  const endpoint = deps.openAiEndpoint ?? OPENAI_PLATFORM_ENDPOINT;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ?? (() => new Date());
  let saving: Promise<unknown> | null = null;

  function openAiProvider(stored: Pick<StoredAiModelSettings, 'apiKey' | 'models'>): InferenceProvider {
    return createOpenAiPlatformInferenceProvider({
      apiKey: stored.apiKey,
      availableModels: stored.models,
      endpoint,
      env,
    });
  }

  function publishRuntimeLimits(identity: LlmRuntimeIdentity): void {
    // limits.ts reads this per call (write_file ceilings, large-context rules).
    process.env.BOTBOY_INFERENCE_MAX_CONTEXT_TOKENS = String(identity.maxContextTokens);
  }

  // Boot: a saved key wins; otherwise the launcher/.env provider.
  let stored = readStored(file);
  let initialProvider = deps.envProvider;
  let initialSource: LlmRuntimeIdentity['source'] = 'environment';
  if (stored) {
    // Refresh which catalog models this key can call; offline keeps the saved list.
    const listed = await listPlatformModels(endpoint, stored.apiKey, fetchImpl).catch(() => null);
    if (listed && listed.join(',') !== stored.models.join(',')) {
      stored = { ...stored, models: [...listed] };
      try { writeStored(file, stored); } catch { /* the saved list stays usable */ }
    }
    initialProvider = openAiProvider(stored);
    initialSource = 'settings';
  }
  const initialClient = initialProvider.createClient({ usageService: deps.usageService });
  await initialClient.healthCheck();
  const initialIdentity = identityFor(initialProvider, initialSource);
  const client = createLlmClientSwitch(initialClient, initialIdentity);
  publishRuntimeLimits(initialIdentity);

  function activate(next: LlmClient, identity: LlmRuntimeIdentity): void {
    const previous = client.activate(next, identity);
    // Stop the previous health timer; its in-flight requests finish on it.
    try { previous.close(); } catch { /* closing a finished client is best effort */ }
    publishRuntimeLimits(identity);
    console.log(`✅ LLM client ready (provider: ${identity.providerId}, model: ${identity.model}, source: ${identity.source})`);
    try { deps.onActivated?.(identity); } catch (error) {
      console.warn(`[AI model] Post-activation hook failed: ${error instanceof Error ? error.name : 'Error'}`);
    }
  }

  function catalogModels(active: LlmClient, identity: LlmRuntimeIdentity): AiModelStatus['models'] {
    try {
      const catalog = getChatModelCatalog(active.getDefaultModel(), env, {
        providerId: identity.providerId,
        availableModels: active.getAvailableModels?.(),
      });
      return catalog.models
        .filter(model => model.key !== 'default')
        .map(model => ({ key: model.key, label: model.label }));
    } catch {
      // Malformed launcher GPT-6 settings must not break the status view.
      return [];
    }
  }

  /** Cheap, non-throwing state for the version poll. */
  function currentState(active: LlmClient = client.pin(), identity = client.identity()): AiModelState {
    const healthy = active.isAvailable();
    const issueCode = active.getProviderIssue?.()?.code;
    if (healthy && (!issueCode || issueCode === 'rate_limited')) return 'ready';
    return identity.source !== 'settings' && !deps.environmentCredentialsPresent ? 'not_configured' : 'unavailable';
  }

  function status(): AiModelStatus {
    const active = client.pin();
    const identity = client.identity();
    const healthy = active.isAvailable();
    const fromSettings = identity.source === 'settings';
    const issue = issueFor(active.getProviderIssue?.());
    const state = currentState(active, identity);
    return {
      state,
      source: identity.source,
      provider: identity.providerId,
      providerLabel: providerLabel(identity.providerId),
      // Owner-facing label ("GPT-5.6 Terra"), never a gateway target path.
      backgroundModel: BLESSED_CHAT_MODELS.find(model => identity.model === model.openaiId
        || identity.model === model.bareId
        || identity.model.endsWith(`/${model.bareId}`))?.label ?? identity.model,
      healthy,
      models: catalogModels(active, identity),
      ...(fromSettings && stored ? {
        openai: { keySuffix: keySuffix(stored.apiKey), savedAt: stored.savedAt, verifiedAt: stored.verifiedAt },
      } : {}),
      ...(deps.environmentCredentialsPresent && fromSettings
        ? { environmentProviderLabel: providerLabel(deps.envProvider.id) }
        : {}),
      ...(issue ? { issue } : {}),
      configVersion: client.configVersion(),
    };
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

  async function verifyAndActivate(apiKey: string): Promise<AiModelStatus> {
    const listed = await listPlatformModels(endpoint, apiKey, fetchImpl);
    if (listed && !listed.includes(OPENAI_PLATFORM_DEFAULT_MODEL)) {
      throw new AiModelSettingsError(
        'model_unavailable',
        'This key cannot use GPT-5.6 Terra, which BotBoy uses for background work.',
        'Check the project\'s model access at platform.openai.com, then try again.',
      );
    }
    const models = [...(listed ?? OPENAI_PLATFORM_MODEL_IDS)];
    const provider = openAiProvider({ apiKey, models });
    const candidate = provider.createClient({ usageService: deps.usageService });
    try {
      // One tiny real generation proves auth, model access, and credit on the
      // exact Responses path BotBoy will use. Recorded as a system usage row.
      await candidate.chatCompletionPrimary({
        messages: [{ role: 'user', content: 'Reply with the single word OK.' }],
        maxTokens: 16,
        think: false,
        usageContext: { workload: 'system' },
      });
      await candidate.healthCheck();
    } catch (error) {
      candidate.close();
      throw modelSettingsError(error);
    }
    const at = now().toISOString();
    const next: StoredAiModelSettings = {
      schemaVersion: SCHEMA_VERSION,
      provider: 'openai',
      apiKey,
      savedAt: at,
      verifiedAt: at,
      models,
    };
    try {
      writeStored(file, next);
    } catch (error) {
      candidate.close();
      throw new AiModelSettingsError(
        'storage_failed',
        'BotBoy verified the key but could not save it privately.',
        'Check that ~/.personal-productivity-tracker is writable, then try again.',
        500,
      );
    }
    stored = next;
    activate(candidate, identityFor(provider, 'settings'));
    console.log(`[AI model] OpenAI key ${keySuffix(apiKey)} verified; chat and background work now use OpenAI.`);
    return status();
  }

  return {
    client,
    status,
    state: () => {
      try { return currentState(); } catch { return 'unavailable'; }
    },
    version: () => client.configVersion(),

    saveOpenAiKey(apiKey: unknown): Promise<AiModelStatus> {
      const key = typeof apiKey === 'string' ? apiKey.trim() : '';
      if (!OPENAI_KEY_PATTERN.test(key)) {
        return Promise.reject(new AiModelSettingsError(
          'invalid_format',
          'That does not look like an OpenAI API key.',
          'Paste the full key from platform.openai.com/api-keys. It starts with "sk-".',
        ));
      }
      return exclusive(() => verifyAndActivate(key));
    },

    removeOpenAiKey(): Promise<AiModelStatus> {
      return exclusive(async () => {
        try {
          fs.rmSync(file, { force: true });
        } catch {
          throw new AiModelSettingsError('storage_failed', 'BotBoy could not remove the saved key.', 'Check that ~/.personal-productivity-tracker is writable, then try again.', 500);
        }
        const wasSettings = client.identity().source === 'settings';
        stored = undefined;
        if (wasSettings) {
          const envClient = deps.envProvider.createClient({ usageService: deps.usageService });
          await envClient.healthCheck().catch(() => false);
          activate(envClient, identityFor(deps.envProvider, 'environment'));
          console.log('[AI model] OpenAI key removed; BotBoy returned to its launcher configuration.');
        }
        return status();
      });
    },
  };
}
