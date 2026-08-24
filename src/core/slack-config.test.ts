import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  getChannelConfig,
  setChannelConfig,
  hasChannelConfig,
  bootstrapFromEnv,
} from './slack-config.js';
import { createStorage, StorageLayer } from './storage.js';

/**
 * Build a minimal stand-in for `WebClient` that records calls to
 * `users.conversations` and returns the supplied page in a single response
 * with no continuation cursor. The returned object exposes the underlying
 * `vi.fn()` as `conversationsCall` so tests can assert call counts.
 */
function makeWeb(channels: any[], cursor?: string) {
  const conversationsCall = vi.fn().mockResolvedValue({
    channels,
    response_metadata: { next_cursor: cursor || '' },
  });
  return {
    users: { conversations: conversationsCall },
    conversationsCall,
  } as any;
}

describe('slack-config', () => {
  let storage: StorageLayer;

  beforeEach(() => {
    storage = createStorage(':memory:');
    storage.initialize();
  });

  afterEach(() => {
    storage.close();
  });

  it('getChannelConfig returns [] when no row exists (Req 1.4)', () => {
    const db = storage.getDb();
    expect(getChannelConfig(db)).toEqual([]);
  });

  it('setChannelConfig dedups, drops non-strings and empty strings, returns the persisted list (Req 1.5)', () => {
    const db = storage.getDb();

    const result = setChannelConfig(db, [
      'C1',
      'C2',
      'C1',
      '',
      123 as any,
      'C3',
    ]);

    expect(result).toEqual(['C1', 'C2', 'C3']);
    expect(getChannelConfig(db)).toEqual(['C1', 'C2', 'C3']);
  });

  it('bootstrapFromEnv with empty env value seeds an empty list and creates the row (Req 2.4)', async () => {
    const db = storage.getDb();
    const web = makeWeb([]);

    expect(hasChannelConfig(db)).toBe(false);

    const result = await bootstrapFromEnv(db, web, '');

    expect(result).toEqual({ seeded: true, ids: [] });
    expect(hasChannelConfig(db)).toBe(true);
    // No Slack call when there are no names to resolve.
    expect(web.conversationsCall).not.toHaveBeenCalled();
  });

  it('bootstrapFromEnv skips names not present in listJoinedConversations and persists the resolved subset (Req 2.2)', async () => {
    const db = storage.getDb();
    const web = makeWeb([
      { id: 'C1', name: 'general', is_im: false, is_mpim: false, is_private: false },
      { id: 'C2', name: 'random', is_im: false, is_mpim: false, is_private: false },
    ]);

    const result = await bootstrapFromEnv(db, web, '#general,nonexistent,random');

    expect(result.seeded).toBe(true);
    // Order is not guaranteed across the resolution stream — compare as sets.
    expect(new Set(result.ids)).toEqual(new Set(['C1', 'C2']));
    expect(new Set(getChannelConfig(db))).toEqual(new Set(['C1', 'C2']));
  });

  it('bootstrapFromEnv is idempotent: a second call after a row exists is a no-op even when env changes (Req 2.3)', async () => {
    const db = storage.getDb();
    const web = makeWeb([
      { id: 'C1', name: 'general', is_im: false, is_mpim: false, is_private: false },
    ]);

    const first = await bootstrapFromEnv(db, web, '#general');
    expect(first.seeded).toBe(true);
    expect(first.ids).toEqual(['C1']);
    expect(web.conversationsCall).toHaveBeenCalledTimes(1);

    web.conversationsCall.mockClear();

    // Second call with a different env value — should short-circuit on the
    // existing row without consulting Slack and without touching the persisted
    // list.
    const second = await bootstrapFromEnv(db, web, 'random');

    expect(second.seeded).toBe(false);
    expect(second.ids).toEqual(['C1']);
    expect(web.conversationsCall).not.toHaveBeenCalled();
    expect(getChannelConfig(db)).toEqual(['C1']);
  });
});
