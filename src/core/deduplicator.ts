import crypto from 'crypto';
import type { RawWorkItem } from './types.js';

export interface Deduplicator {
  isDuplicate(item: RawWorkItem): boolean;
  register(item: RawWorkItem): void;
}

const BUCKET_MS = 60_000; // 60-second timestamp bucket
const MAX_CACHE = 1000;
const MAX_AGE_MS = 3600_000; // 1 hour

export function createDeduplicator(): Deduplicator {
  const cache = new Map<string, number>(); // hash → timestamp

  function contentHash(item: RawWorkItem): string {
    const platform = item.type;
    const channel = item.metadata?.channelOrDm ?? item.metadata?.conversationName ?? '';
    const content = (item.content ?? item.title ?? '').trim().toLowerCase();
    const bucket = Math.floor(item.capturedAt.getTime() / BUCKET_MS);
    const raw = `${platform}|${channel}|${content}|${bucket}`;
    return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 32);
  }

  function isSlackItem(item: RawWorkItem): boolean {
    return item.type === 'slack_message';
  }

  function prune(): void {
    if (cache.size <= MAX_CACHE) return;
    const now = Date.now();
    for (const [hash, ts] of cache) {
      if (now - ts > MAX_AGE_MS || cache.size > MAX_CACHE) {
        cache.delete(hash);
      }
    }
  }

  return {
    isDuplicate(item: RawWorkItem): boolean {
      // Cross-source dedup only for Slack items
      if (!isSlackItem(item)) return false;
      const hash = contentHash(item);
      return cache.has(hash);
    },

    register(item: RawWorkItem): void {
      if (!isSlackItem(item)) return;
      const hash = contentHash(item);
      cache.set(hash, Date.now());
      prune();
    },
  };
}
