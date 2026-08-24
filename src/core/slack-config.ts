import type Database from 'better-sqlite3';
import type { WebClient } from '@slack/web-api';
import { getSetting, setSetting } from './storage.js';

/**
 * SQLite `app_settings` key under which the watched-channel ID list is stored.
 * The persisted value has shape `{ ids: string[] }`.
 */
const KEY = 'slack.channel_config';

/**
 * Read the persisted watched-channel ID list. Returns `[]` when the row is
 * absent so callers don't have to special-case "not yet configured".
 */
export function getChannelConfig(db: Database.Database): string[] {
  return getSetting<{ ids: string[] }>(db, KEY)?.ids ?? [];
}

/**
 * Persist `ids` as the watched-channel list, deduplicated and stripped of
 * non-string / empty entries. Returns the cleaned list that was actually
 * stored so callers can use it as the source of truth.
 */
export function setChannelConfig(db: Database.Database, ids: string[]): string[] {
  const dedup = Array.from(
    new Set(ids.filter((s) => typeof s === 'string' && s.length > 0)),
  );
  setSetting(db, KEY, { ids: dedup });
  return dedup;
}

/**
 * Whether the watched-channel row has been written at least once. Used by
 * `bootstrapFromEnv` to enforce one-shot migration semantics regardless of
 * whether the persisted list is empty.
 */
export function hasChannelConfig(db: Database.Database): boolean {
  return getSetting<unknown>(db, KEY) !== null;
}

/**
 * A Slack conversation the bot user is a member of, normalized into a
 * shape that the dashboard panel and bootstrap migration both consume.
 */
export type JoinedConversation = {
  id: string;
  name: string;
  type: 'public_channel' | 'private_channel' | 'dm' | 'group_dm';
};

/**
 * Map a raw Slack `conversations.list` channel object into a JoinedConversation.
 *
 * The Slack API returns a single record shape for all conversation types and
 * differentiates them via flags (`is_im`, `is_mpim`, `is_private`). Names are
 * absent for DMs and group DMs, so we synthesize a stable display name.
 */
export function toJoinedConversation(ch: any): JoinedConversation {
  let type: JoinedConversation['type'];
  if (ch.is_im) type = 'dm';
  else if (ch.is_mpim) type = 'group_dm';
  else if (ch.is_private) type = 'private_channel';
  else type = 'public_channel';

  let name: string;
  if (typeof ch.name === 'string' && ch.name.length > 0) {
    name = ch.name;
  } else if (type === 'dm' && ch.user) {
    name = `dm:${ch.user}`;
  } else {
    name = `group-${String(ch.id ?? '').slice(-4)}`;
  }

  return { id: ch.id as string, name, type };
}

/**
 * Async generator that yields every conversation the bot user is a member of,
 * across `public_channel`, `private_channel`, `im`, and `mpim` types.
 *
 * Pagination is mandatory — workspaces commonly exceed 100 conversations — so
 * we follow `response_metadata.next_cursor` until it is empty. Errors from the
 * Slack client are intentionally not caught: callers (the GET handler and the
 * bootstrap migration) need to map them to HTTP 502 / log-and-skip respectively.
 */
export async function* listJoinedConversations(
  web: WebClient,
): AsyncIterable<JoinedConversation> {
  let cursor: string | undefined;
  do {
    const res = await web.users.conversations({
      types: 'public_channel,private_channel,im,mpim',
      exclude_archived: true,
      limit: 200,
      cursor,
    });
    const channels = (res.channels ?? []) as any[];
    for (const ch of channels) {
      yield toJoinedConversation(ch);
    }
    const next = res.response_metadata?.next_cursor;
    cursor = typeof next === 'string' && next.length > 0 ? next : undefined;
  } while (cursor);
}

/**
 * One-shot bootstrap migration that seeds `slack.channel_config` from the
 * legacy `SLACK_WATCHED_CHANNELS` env var the very first time the application
 * runs against a fresh database.
 *
 * Semantics:
 *   - If a config row already exists, return immediately without reading the
 *     env or contacting Slack. The persisted value is the source of truth.
 *   - If `envValue` is empty (unset or all-whitespace), persist `[]` so the
 *     row exists and subsequent runs short-circuit.
 *   - Otherwise resolve each comma-separated channel name to a Slack
 *     conversation ID by walking `listJoinedConversations`. Names that don't
 *     match anything in the joined set are silently skipped.
 */
export async function bootstrapFromEnv(
  db: Database.Database,
  web: WebClient,
  envValue: string | undefined,
): Promise<{ seeded: boolean; ids: string[] }> {
  if (hasChannelConfig(db)) {
    return { seeded: false, ids: getChannelConfig(db) };
  }

  const names = (envValue ?? '')
    .split(',')
    .map((s) => s.trim().replace(/^#/, '').toLowerCase())
    .filter(Boolean);

  if (names.length === 0) {
    setChannelConfig(db, []);
    return { seeded: true, ids: [] };
  }

  const wanted = new Set(names);
  const resolved: string[] = [];
  for await (const conv of listJoinedConversations(web)) {
    if (conv.name && wanted.has(conv.name.toLowerCase())) {
      resolved.push(conv.id);
    }
  }

  const ids = setChannelConfig(db, resolved);
  return { seeded: true, ids };
}
