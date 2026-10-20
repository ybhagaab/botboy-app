/**
 * Settings → AI model → Show model thinking (docs/maps/llm-runtime.md).
 *
 * One owner choice, read once per chat turn. On (the default): a chat turn
 * whose Thinking level is not Off asks its provider for readable thinking
 * (a summary on OpenAI-style Responses models, summarized thinking on Claude)
 * and streams it to the chat panel's thinking block. Off: no thinking text is
 * requested or shown for any provider. DeepSeek returns its reasoning either
 * way; BotBoy still replays it to DeepSeek, it just does not show it.
 *
 * Only the same-origin owner page changes it (api/routers/ai-model.ts).
 */
import type Database from 'better-sqlite3';
import { getSetting, setSetting } from './storage.js';

export const CHAT_THINKING_SETTING_KEY = 'chat.show_thinking.v1';

export interface ChatThinkingStatus {
  readonly showThinking: boolean;
  /** null until the owner first changes it. */
  readonly updatedAt: string | null;
}

interface StoredChatThinking {
  schema: 1;
  showThinking: boolean;
  updatedAt: string;
}

export interface ChatThinkingDisplay {
  /** The choice for this turn. Never throws. */
  showThinking(): boolean;
  status(): ChatThinkingStatus;
  setShowThinking(value: boolean): ChatThinkingStatus;
}

function readStored(db: Database.Database): StoredChatThinking | null {
  let raw: unknown;
  try {
    raw = getSetting<unknown>(db, CHAT_THINKING_SETTING_KEY);
  } catch {
    raw = undefined;
  }
  if (raw === null || raw === undefined) return null;
  const value = raw as Partial<StoredChatThinking>;
  if (typeof raw !== 'object' || value.schema !== 1 || typeof value.showThinking !== 'boolean' || typeof value.updatedAt !== 'string') {
    console.warn(`[AI model] ignoring malformed ${CHAT_THINKING_SETTING_KEY}; showing model thinking`);
    return null;
  }
  return value as StoredChatThinking;
}

export function createChatThinkingDisplay(deps: { db: Database.Database; now?: () => Date }): ChatThinkingDisplay {
  const now = deps.now ?? (() => new Date());
  const stored = readStored(deps.db);
  let show = stored?.showThinking ?? true;
  let updatedAt: string | null = stored?.updatedAt ?? null;
  const status = (): ChatThinkingStatus => ({ showThinking: show, updatedAt });
  return {
    showThinking: () => show,
    status,
    setShowThinking(value) {
      if (typeof value !== 'boolean') throw new TypeError('showThinking must be true or false');
      const at = now().toISOString();
      setSetting(deps.db, CHAT_THINKING_SETTING_KEY, { schema: 1, showThinking: value, updatedAt: at } satisfies StoredChatThinking);
      show = value;
      updatedAt = at;
      return status();
    },
  };
}
