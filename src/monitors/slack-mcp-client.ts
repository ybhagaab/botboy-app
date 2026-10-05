/**
 * Slack data client backed by the AI Community Slack MCP (built-in `slack`
 * profile) — the ingestion transport that replaces the xoxp WebClient.
 *
 * Design: expose the same response shapes the slack-monitor already consumes
 * from @slack/web-api (`conversations.history` → { messages, response_metadata },
 * etc.), so the monitor's polling, cursor, engagement, and dedup logic runs
 * unchanged over either transport. The MCP batch tools return
 * `[{ channelId, result: { ok, messages, ... } }]`; this adapter unwraps them.
 *
 * Identity: the MCP has no auth.test equivalent. The owner's Slack user ID is
 * resolved once by searching the owner's own recent messages (`from:@alias`)
 * and cached durably. The OS username matches the Amazon alias on managed
 * machines; SLACK_SELF_ALIAS overrides it when it does not.
 *
 * Availability: history, replies, and listing throw a `SlackCallError` whose
 * kind says whether one conversation or the whole transport failed (Midway
 * session lapsed, sign-in rejected, rate limited, network). Callers defer —
 * capture is lossless because polling cursors only advance after successful
 * processing.
 */

import os from 'node:os';
import type Database from 'better-sqlite3';
import type { McpManager } from '../core/mcp-types.js';
import { SLACK_MCP_PROFILE_ID } from '../core/mcp-profiles.js';
import { getSetting, setSetting } from '../core/storage.js';
import { classifyCaptureFailure, sanitizeCaptureReason, type CaptureFailureKind } from '../core/capture-health.js';

/**
 * What a failed Slack call means for the poll cycle. `conversation_access`
 * concerns one conversation (archived, left, no scope); every other kind is
 * transport-wide: one failure stands for all of them.
 */
export type SlackCallErrorKind = CaptureFailureKind | 'conversation_access';

export class SlackCallError extends Error {
  readonly kind: SlackCallErrorKind;
  constructor(kind: SlackCallErrorKind, message: string) {
    super(message);
    this.name = 'SlackCallError';
    this.kind = kind;
  }
}

/** Slack API and Slack MCP error text → kind (deterministic). */
export function classifySlackError(text: string): SlackCallErrorKind {
  if (/channel_not_found|not_in_channel|missing_scope|access_denied|is_archived|method_not_supported_for_channel_type|thread_not_found|user_not_found/i.test(text)) {
    return 'conversation_access';
  }
  return classifyCaptureFailure(text);
}

/** Kind of any error a Slack call can raise (typed or not). */
export function slackErrorKind(error: unknown): SlackCallErrorKind {
  if (error instanceof SlackCallError) return error.kind;
  const data = (error as { data?: { error?: unknown } } | null)?.data?.error;
  const message = typeof data === 'string' && data ? data : String((error as Error)?.message ?? error);
  return classifySlackError(message);
}

export interface SlackHistoryPage {
  messages: any[];
  response_metadata?: { next_cursor?: string };
}

export interface SlackMcpClient {
  /** True when the managed slack MCP server is running. */
  isAvailable(): Promise<boolean>;
  /** Owner's Slack user ID (cached; '' when it cannot be resolved). */
  getSelfUserId(): Promise<string>;
  userInfo(userId: string): Promise<{ real_name?: string; name?: string; email?: string; tz?: string } | null>;
  channelInfo(channelId: string): Promise<Record<string, any> | null>;
  history(channelId: string, opts: { oldest?: string; latest?: string; limit?: number; cursor?: string }): Promise<SlackHistoryPage>;
  replies(channelId: string, threadTs: string, opts?: { cursor?: string }): Promise<SlackHistoryPage>;
  /** Conversations of the given kinds; shape mirrors users.conversations. */
  listConversations(types: Array<'public_and_private' | 'dm' | 'group_dm'>, opts?: { cursor?: string; limit?: number; unreadOnly?: boolean }): Promise<{ channels: any[]; response_metadata?: { next_cursor?: string } }>;
  /** Download one Slack file through the MCP; returns the temp path it saved. */
  downloadFile(fileId: string): Promise<{ savedPath?: string; inlineText?: string; title?: string; mimetype?: string } | null>;
  search(query: string, page?: number): Promise<any>;
}

const SELF_ID_SETTING = 'slack.mcp.selfUserId';

/**
 * Flatten a list_channels payload into conversation records. The tool varies
 * its shape by requested kind: flat `channels`, sidebar `sections` (each with
 * nested channels), and kind-specific keys such as `ims` / `mpims` for DMs in
 * combined requests. Collect every object that carries a conversation id.
 */
export function collectConversationRecords(payload: unknown): any[] {
  const out: any[] = [];
  const pushRecords = (value: unknown): void => {
    if (!Array.isArray(value)) return;
    for (const entry of value) {
      if (!entry || typeof entry !== 'object') continue;
      if (typeof (entry as any).id === 'string') out.push(entry);
      else if (Array.isArray((entry as any).channels)) pushRecords((entry as any).channels);
    }
  };
  if (Array.isArray(payload)) pushRecords(payload);
  else if (payload && typeof payload === 'object') {
    for (const value of Object.values(payload)) pushRecords(value);
  }
  return out;
}

export function createSlackMcpClient(deps: {
  db: Database.Database;
  mcpManager: Pick<McpManager, 'callTool' | 'getServer'>;
  selfAlias?: string;
}): SlackMcpClient {
  const { db, mcpManager } = deps;
  const selfAlias = deps.selfAlias
    || process.env.SLACK_SELF_ALIAS
    || os.userInfo().username;

  async function isAvailable(): Promise<boolean> {
    try {
      const snapshot = await mcpManager.getServer(SLACK_MCP_PROFILE_ID);
      return Boolean(snapshot && snapshot.state === 'running');
    } catch {
      return false;
    }
  }

  async function call<T = any>(tool: string, args: Record<string, unknown>, timeoutMs = 60_000): Promise<T> {
    let result: Awaited<ReturnType<typeof mcpManager.callTool>>;
    try {
      result = await mcpManager.callTool(SLACK_MCP_PROFILE_ID, tool, args, { source: 'api', timeoutMs });
    } catch (error) {
      const message = String((error as Error)?.message ?? error);
      throw new SlackCallError(classifySlackError(message), `${tool}: ${sanitizeCaptureReason(message)}`);
    }
    if (result.isError) {
      const text = result.text || `${tool} failed`;
      throw new SlackCallError(classifySlackError(text), `${tool}: ${sanitizeCaptureReason(text)}`);
    }
    try {
      return JSON.parse(result.text) as T;
    } catch {
      throw new SlackCallError('unexpected_response', `${tool} returned a non-JSON payload`);
    }
  }

  /**
   * Unwrap `[{ channelId|threadTs, result: {...} }]` batch envelopes. The
   * server reports a failed item as `{ channelId, error }` with no result
   * (a Midway 401 arrives this way), so the error text is kept for the
   * caller instead of collapsing into "unavailable".
   */
  function unwrapBatch(payload: unknown, matchKey: string, matchValue: string): { result: Record<string, any> } | { error: string } {
    if (!Array.isArray(payload)) return { error: 'unexpected batch response shape' };
    // One item is requested per call, so a lone entry answers it even when
    // the server names its key differently.
    const entry = payload.find((row) => row && typeof row === 'object' && String((row as any)[matchKey]) === matchValue)
      ?? (payload.length === 1 ? payload[0] : undefined);
    if (!entry || typeof entry !== 'object') return { error: `unexpected batch response: no entry for ${matchValue}` };
    const entryError = (entry as any).error;
    if (typeof entryError === 'string' && entryError) return { error: entryError };
    const result = (entry as any).result;
    if (!result || typeof result !== 'object') return { error: 'unexpected batch response: entry has no result' };
    if (result.ok === false) return { error: String(result.error || 'ok:false') };
    // A result that carries only an error (e.g. an unparseable timestamp) is
    // not an empty success.
    if (typeof result.error === 'string' && result.error && !Array.isArray(result.messages)) return { error: result.error };
    return { result };
  }

  function batchFailure(what: string, error: string): SlackCallError {
    return new SlackCallError(classifySlackError(error), `${what}: ${sanitizeCaptureReason(error)}`);
  }

  return {
    isAvailable,

    async getSelfUserId(): Promise<string> {
      const cached = getSetting<string>(db, SELF_ID_SETTING);
      if (cached) return cached;
      try {
        // The owner's most recent own message identifies their user ID.
        const found = await call<any>('search', { query: `from:@${selfAlias}` }, 45_000);
        const matches = found?.messages?.matches ?? found?.matches ?? [];
        const userId = String(matches.find((m: any) => m?.user)?.user ?? '');
        if (userId) setSetting(db, SELF_ID_SETTING, userId);
        return userId;
      } catch {
        return '';
      }
    },

    async userInfo(userId) {
      const payload = await call<any>('batch_get_user_info', { users: [userId] }, 45_000);
      const unwrapped = unwrapBatch(payload, 'user', userId);
      return 'result' in unwrapped ? unwrapped.result : null;
    },

    async channelInfo(channelId) {
      const payload = await call<any>('batch_get_channel_info', { channelIds: [channelId] }, 45_000);
      const unwrapped = unwrapBatch(payload, 'channelId', channelId);
      return 'result' in unwrapped ? unwrapped.result : null;
    },

    async history(channelId, opts) {
      const channel: Record<string, unknown> = { channelId };
      if (opts.oldest) channel.oldest = opts.oldest;
      if (opts.latest) channel.latest = opts.latest;
      if (opts.limit) channel.limit = opts.limit;
      if (opts.cursor) channel.cursor = opts.cursor;
      const payload = await call<any>('batch_get_conversation_history', { channels: [channel] }, 90_000);
      const unwrapped = unwrapBatch(payload, 'channelId', channelId);
      if ('error' in unwrapped) throw batchFailure(`history ${channelId}`, unwrapped.error);
      const { result } = unwrapped;
      return {
        messages: result.messages ?? [],
        response_metadata: { next_cursor: result.response_metadata?.next_cursor || result.next_cursor || undefined },
      };
    },

    async replies(channelId, threadTs, opts = {}) {
      const thread: Record<string, unknown> = { channelId, threadTs };
      if (opts.cursor) thread.cursor = opts.cursor;
      const payload = await call<any>('batch_get_thread_replies', { threads: [thread] }, 90_000);
      const unwrapped = unwrapBatch(payload, 'threadTs', threadTs);
      if ('error' in unwrapped) throw batchFailure(`replies ${channelId}/${threadTs}`, unwrapped.error);
      const { result } = unwrapped;
      return {
        messages: result.messages ?? [],
        response_metadata: { next_cursor: result.response_metadata?.next_cursor || result.next_cursor || undefined },
      };
    },

    async listConversations(types, opts = {}) {
      const args: Record<string, unknown> = { channelTypes: types };
      if (opts.cursor) args.cursor = opts.cursor;
      if (opts.limit) args.limit = opts.limit;
      if (opts.unreadOnly != null) args.unreadOnly = opts.unreadOnly;
      const payload = await call<any>('list_channels', args, 90_000);
      return {
        channels: collectConversationRecords(payload),
        response_metadata: { next_cursor: payload?.response_metadata?.next_cursor || payload?.next_cursor || undefined },
      };
    },

    async downloadFile(fileId) {
      const payload = await call<any>('download_file_content', { file: fileId }, 120_000);
      if (!payload) return null;
      return {
        savedPath: payload.saved_to || payload.savedPath || undefined,
        inlineText: typeof payload.content === 'string' ? payload.content : undefined,
        title: payload.title || payload.name || undefined,
        mimetype: payload.mimetype || undefined,
      };
    },

    async search(query, page) {
      return call<any>('search', page ? { query, page } : { query }, 60_000);
    },
  };
}
