/**
 * Strict Slack thread provenance shared by routing and brain synthesis.
 *
 * Slack timestamps are durable message identities, not display dates. History
 * can represent a root with no thread_ts or with thread_ts equal to its own
 * timestamp; only a distinct valid thread_ts denotes a reply.
 */

export const WEAK_SLACK_ROOT_SCOPE_REASON_PREFIX = 'weak Slack root scope (';
/** Exact audit proof for a root placed later from one bounded chronological thread. */
export const RECONCILED_SLACK_ROOT_SCOPE_REASON_PREFIX = 'reconciled Slack thread scope (';
/** A 21st row proves the snapshot is partial; reconciliation then fails closed. */
export const MAX_RECONCILED_SLACK_THREAD_MESSAGES = 20;

const SLACK_TIMESTAMP_PATTERN = /^\d+\.\d+$/;

export interface SlackThreadIdentity {
  channelId: string;
  timestamp: string;
  rootTs: string;
  isReply: boolean;
  timestampSeconds: number;
}

export function isSlackTimestamp(value: unknown): value is string {
  return typeof value === 'string'
    && SLACK_TIMESTAMP_PATTERN.test(value.trim())
    && Number.isFinite(Number(value));
}

export function parseSlackThreadIdentity(
  metadata: Record<string, unknown>,
): SlackThreadIdentity | null {
  const channelId = String(metadata.channelId ?? '').trim();
  const timestamp = String(metadata.timestamp ?? '').trim();
  const threadTs = String(metadata.threadTs ?? '').trim();
  if (!channelId || !isSlackTimestamp(timestamp)) return null;
  if (threadTs && !isSlackTimestamp(threadTs)) return null;

  const timestampSeconds = Number(timestamp);
  const isReply = Boolean(threadTs && threadTs !== timestamp);
  if (isReply && Number(threadTs) >= timestampSeconds) return null;
  return {
    channelId,
    timestamp,
    rootTs: isReply ? threadTs : timestamp,
    isReply,
    timestampSeconds,
  };
}

export function sameSlackThread(
  left: SlackThreadIdentity | null,
  right: SlackThreadIdentity | null,
): boolean {
  return Boolean(left && right
    && left.channelId === right.channelId
    && left.rootTs === right.rootTs);
}

export function slackThreadKey(identity: SlackThreadIdentity): string {
  return `${identity.channelId}\0${identity.rootTs}`;
}
