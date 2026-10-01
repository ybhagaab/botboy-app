/**
 * Where the chat picker's models come from and how one picker key becomes the
 * client that serves a whole chat turn.
 *
 * Production uses the connection-aware source from Settings → AI model
 * (`ai-model-settings.ts › chatModels`): every configured connection's models,
 * provider-qualified keys, and turns pinned to one connection. The
 * single-client source keeps the original behavior for callers that hold one
 * LlmClient (tests, older wiring): that client's catalog, explicit routes, and
 * every activation stops in-flight turns.
 */
import {
  BLESSED_CHAT_MODELS,
  chatModelCatalogContext,
  getChatModelCatalog,
  resolveBlessedModelRoute,
} from './inference-provider.js';
import type { LlmClient, LlmRequestRoute } from './llm-client.js';
import { isLlmClientSwitch, pinLlmClient } from './llm-client-switch.js';
import type { LlmModelOperation } from './llm-model-operation.js';
import {
  LLM_CONNECTION_ORDER,
  LLM_MODEL_KEY_PATTERN,
  bindLlmModel,
  connectionDefaultEntry,
  qualifiedModelKey,
  type LlmConnection,
  type LlmModelEntry,
} from './llm-model-catalog.js';

export interface ChatModelCatalogGroup {
  readonly id: string;
  readonly label: string;
}

export interface ChatModelCatalogEntry {
  readonly key: string;
  readonly label: string;
  readonly family: string;
  readonly isDefault: boolean;
  readonly preview: boolean;
  /** Group id (connection) when the catalog has groups. */
  readonly group?: string;
  /** Whether the model reads images; omitted when unknown. */
  readonly images?: boolean;
}

/** Browser-safe catalog: labels and stable keys only, never routes or credentials. */
export interface ChatModelCatalogPayload {
  readonly defaultKey: string;
  readonly groups?: readonly ChatModelCatalogGroup[];
  readonly models: readonly ChatModelCatalogEntry[];
}

export interface ChatModelBinding {
  readonly key: string;
  /** The connection this turn is pinned to; its replacement or removal stops the turn. */
  readonly connectionId: string;
  readonly client: LlmClient;
  /** Explicit route for the single-client source; bound clients carry their own. */
  readonly route?: LlmRequestRoute;
  /** Data-locality context for the turn's tool executions. */
  readonly operation?: LlmModelOperation;
}

export interface ChatModelSource {
  catalog(): ChatModelCatalogPayload | null;
  /** Resolve a picker key (`default`/empty = the default). null = not offered. */
  resolve(key: unknown): ChatModelBinding | null;
  /** Observe connection replacement or removal. Returns an unsubscribe. */
  onChange(listener: (event: { connectionId: string }) => void): () => void;
}

function isDefaultKey(key: unknown): boolean {
  return key === undefined || key === null || key === '' || key === 'default';
}

/** Original behavior: one (possibly switchable) client, explicit routes. */
export function createSingleClientChatModelSource(client: LlmClient | undefined): ChatModelSource {
  const catalogFor = (pinned: LlmClient) => getChatModelCatalog(
    pinned.getDefaultModel?.() ?? '',
    process.env,
    chatModelCatalogContext(pinned),
  );
  return {
    catalog() {
      const pinned = pinLlmClient(client);
      return pinned ? catalogFor(pinned) : null;
    },
    resolve(key) {
      // One client serves the whole turn, even if the provider changes mid-turn.
      const pinned = pinLlmClient(client);
      if (!pinned) return null;
      if (isDefaultKey(key)) return { key: 'default', connectionId: 'active', client: pinned };
      if (!catalogFor(pinned).models.some(model => model.key === key)) return null;
      const route = resolveBlessedModelRoute(
        pinned.getDefaultModel?.() ?? '',
        key,
        process.env,
        chatModelCatalogContext(pinned),
      );
      return route ? { key: String(key), connectionId: 'active', client: pinned, route } : null;
    },
    onChange(listener) {
      return isLlmClientSwitch(client)
        ? client.onActivate(() => listener({ connectionId: 'active' }))
        : () => {};
    },
  };
}

/** Every configured connection's models, grouped by provider. */
export function createConnectionChatModelSource(input: {
  connections: () => readonly LlmConnection[];
  /** D4: the team default when configured, otherwise the organizing model. */
  defaultKey: () => string | undefined;
  onChange: (listener: (event: { connectionId: string }) => void) => () => void;
}): ChatModelSource {
  const ordered = (): LlmConnection[] => [...input.connections()]
    .sort((a, b) => LLM_CONNECTION_ORDER.indexOf(a.id) - LLM_CONNECTION_ORDER.indexOf(b.id));

  function find(key: string): { connection: LlmConnection; entry: LlmModelEntry } | null {
    for (const connection of ordered()) {
      const entry = connection.models.find(model => model.key === key);
      if (entry) return { connection, entry };
    }
    return null;
  }

  function effectiveDefault(): { connection: LlmConnection; entry: LlmModelEntry } | null {
    const preferred = input.defaultKey();
    const found = preferred ? find(preferred) : null;
    if (found) return found;
    for (const connection of ordered()) {
      const entry = connectionDefaultEntry(connection);
      if (entry) return { connection, entry };
    }
    return null;
  }

  /** Older pickers stored unqualified keys (`terra`, `gpt6-sol`). */
  function legacyKey(key: string): string | null {
    const blessed = BLESSED_CHAT_MODELS.find(model => model.key === key);
    if (!blessed) return null;
    const team = qualifiedModelKey('team', blessed.key);
    if (find(team)) return team;
    const openai = qualifiedModelKey('openai', blessed.openaiId);
    return find(openai) ? openai : null;
  }

  return {
    catalog() {
      const connections = ordered();
      const fallback = effectiveDefault();
      if (!connections.length || !fallback) return null;
      const defaultKey = fallback.entry.key;
      return {
        defaultKey,
        groups: connections.map(connection => ({ id: connection.id, label: connection.label })),
        models: connections.flatMap(connection => connection.models.map(entry => ({
          key: entry.key,
          label: entry.label,
          family: entry.family ?? 'Provider',
          isDefault: entry.key === defaultKey,
          preview: entry.preview,
          group: connection.id,
          ...(entry.capabilities.images !== undefined ? { images: entry.capabilities.images } : {}),
        }))),
      };
    },
    resolve(key) {
      let found: { connection: LlmConnection; entry: LlmModelEntry } | null = null;
      if (isDefaultKey(key)) {
        found = effectiveDefault();
      } else if (typeof key === 'string' && LLM_MODEL_KEY_PATTERN.test(key)) {
        found = find(key);
      } else if (typeof key === 'string') {
        const mapped = legacyKey(key);
        found = mapped ? find(mapped) : null;
      }
      if (!found) return null;
      // Chat always sends the model's route: a chat failure must never mark
      // the shared endpoint unhealthy or fall back to another model.
      const client = bindLlmModel(found.connection, found.entry, { alwaysRoute: true });
      return {
        key: found.entry.key,
        connectionId: found.connection.id,
        client,
        operation: client.getModelOperation?.(),
      };
    },
    onChange: listener => input.onChange(listener),
  };
}
