/**
 * Channel engagement tiers — deterministic personal-relevance signals.
 *
 * A channel is ENGAGED when the owner has a recorded engagement event (sent
 * message, @-mention of the owner, owner reaction, thread participation)
 * newer than the start of the channel's recent-message window: the last N
 * messages, or a trailing fallback window when fewer than N exist. DMs and
 * group DMs are always engaged. Everything else is AMBIENT: it can enrich
 * context and feed channel digests, but it cannot create projects, tasks, or
 * other commitments.
 *
 * These are lexical/DB checks only — no model involvement — so relevance can
 * never be argued into existence by message content.
 */

import type Database from 'better-sqlite3';

export type ChannelTier = 'engaged' | 'ambient';

const RECENT_MESSAGE_WINDOW = 40;
const FALLBACK_WINDOW_DAYS = 21;

export interface ChannelTierOptions {
  /** How many trailing messages define the engagement window (default 40). */
  recentMessageWindow?: number;
  /** Trailing window in days when the channel has fewer messages (default 21). */
  fallbackWindowDays?: number;
  now?: Date;
}

export function channelEngagementTier(
  db: Database.Database,
  channelId: string,
  channelType?: string,
  opts: ChannelTierOptions = {},
): ChannelTier {
  if (channelType === 'dm' || channelType === 'group_dm') return 'engaged';
  if (!channelId) return 'ambient';
  const windowSize = Math.max(1, opts.recentMessageWindow ?? RECENT_MESSAGE_WINDOW);
  const fallbackDays = Math.max(1, opts.fallbackWindowDays ?? FALLBACK_WINDOW_DAYS);
  const nowMs = (opts.now ?? new Date()).getTime();

  const recent = db.prepare(`
    SELECT captured_at AS capturedAt FROM work_items
    WHERE source = 'slack' AND type = 'slack_message'
      AND json_extract(metadata, '$.channelId') = ?
    ORDER BY captured_at DESC LIMIT ?
  `).all(channelId, windowSize) as { capturedAt: string }[];

  const fallbackStart = new Date(nowMs - fallbackDays * 86400000).toISOString();
  const windowStart = recent.length >= windowSize
    ? recent[recent.length - 1].capturedAt
    : fallbackStart;

  const engagement = db.prepare(
    'SELECT 1 FROM slack_engagement WHERE channel_id = ? AND occurred_at >= ? LIMIT 1',
  ).get(channelId, windowStart);
  return engagement ? 'engaged' : 'ambient';
}

/** Memoizing resolver so batch passes evaluate each channel at most once. */
export function createChannelTierResolver(
  db: Database.Database,
  opts: ChannelTierOptions = {},
): (channelId: string, channelType?: string) => ChannelTier {
  const cache = new Map<string, ChannelTier>();
  return (channelId, channelType) => {
    if (channelType === 'dm' || channelType === 'group_dm') return 'engaged';
    const cached = cache.get(channelId);
    if (cached) return cached;
    const tier = channelEngagementTier(db, channelId, channelType, opts);
    cache.set(channelId, tier);
    return tier;
  };
}

const isFlag = (value: unknown): boolean => value === true || value === 'true';

/** Message-level engagement: the owner sent it, was @-mentioned, or is in the thread. */
export function isEngagedSlackMessage(metadata: Record<string, unknown>): boolean {
  return isFlag(metadata.engaged)
    || isFlag(metadata.mentionedMe)
    || isFlag(metadata.threadEngaged)
    || metadata.direction === 'sent';
}

/**
 * A Slack message is personally relevant when it is a DM/group DM, carries a
 * message-level engagement flag, or belongs to a channel whose tier is
 * currently engaged.
 */
export function isPersonallyRelevantSlackMessage(
  metadata: Record<string, unknown>,
  resolveTier: (channelId: string, channelType?: string) => ChannelTier,
): boolean {
  const channelType = typeof metadata.channelType === 'string' ? metadata.channelType : '';
  if (channelType === 'dm' || channelType === 'group_dm') return true;
  if (isEngagedSlackMessage(metadata)) return true;
  const channelId = typeof metadata.channelId === 'string' ? metadata.channelId : '';
  return resolveTier(channelId, channelType) === 'engaged';
}
