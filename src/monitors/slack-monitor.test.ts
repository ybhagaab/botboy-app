import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { createStorage, getSetting, type StorageLayer } from '../core/storage.js';
import { setChannelConfig } from '../core/slack-config.js';
import type { RawWorkItem } from '../core/types.js';

// ─── Mocks ──────────────────────────────────────────────────────────────────
//
// We mock @slack/socket-mode and @slack/web-api so SlackMonitor can be driven
// without a real Slack connection. The SocketModeClient mock captures every
// `.on(event, handler)` registration into a shared Map so tests can invoke
// the registered message handler directly. Both mocks are defined inside
// vi.hoisted() so the references survive vi.mock factory hoisting.

const mocks = vi.hoisted(() => {
  // event-name -> registered handler
  const socketHandlers = new Map<string, (arg: any) => unknown | Promise<unknown>>();

  const socketStart = vi.fn();
  const socketDisconnect = vi.fn();
  const socketOn = vi.fn((event: string, handler: any) => {
    socketHandlers.set(event, handler);
  });
  const SocketModeClient = vi.fn().mockImplementation(() => ({
    on: socketOn,
    start: socketStart,
    disconnect: socketDisconnect,
  }));

  const authTest = vi.fn();
  const usersInfo = vi.fn();
  const conversationsInfo = vi.fn();
  const conversationsHistory = vi.fn();
  const conversationsReplies = vi.fn();
  const WebClient = vi.fn().mockImplementation(() => ({
    auth: { test: authTest },
    users: { info: usersInfo },
    conversations: { info: conversationsInfo, history: conversationsHistory, replies: conversationsReplies },
  }));

  return {
    socketHandlers,
    socketStart,
    socketDisconnect,
    socketOn,
    SocketModeClient,
    authTest,
    usersInfo,
    conversationsInfo,
    conversationsHistory,
    conversationsReplies,
    WebClient,
  };
});

vi.mock('@slack/socket-mode', () => ({ SocketModeClient: mocks.SocketModeClient }));
vi.mock('@slack/web-api', () => ({ WebClient: mocks.WebClient }));

// Static import is OK because createSlackMonitor reads env vars / constructs
// clients lazily inside the factory call (not at module load).
import { createSlackMonitor, type SlackMonitor } from './slack-monitor.js';

// Default conversations.info: anything starting with 'D' is a DM, everything
// else is a public channel. Individual tests can override per-channel.
function defaultConversationsInfo({ channel }: { channel: string }) {
  if (channel.startsWith('D')) {
    return Promise.resolve({
      channel: { id: channel, is_im: true, is_mpim: false, is_private: false, name: '' },
    });
  }
  return Promise.resolve({
    channel: { id: channel, is_im: false, is_mpim: false, is_private: false, name: channel.toLowerCase() },
  });
}

describe('SlackMonitor', () => {
  let storage: StorageLayer;
  let db: Database.Database;
  let monitor: SlackMonitor | null = null;

  beforeEach(() => {
    // Force the active (token-present) factory branch.
    process.env.SLACK_APP_TOKEN = 'xapp-test';
    process.env.SLACK_USER_TOKEN = 'xoxp-test';

    storage = createStorage(':memory:');
    storage.initialize();
    db = storage.getDb();

    // Reset shared mock state between tests.
    mocks.socketHandlers.clear();

    mocks.socketStart.mockReset().mockResolvedValue(undefined);
    mocks.socketDisconnect.mockReset();
    mocks.socketOn.mockReset().mockImplementation((event: string, handler: any) => {
      mocks.socketHandlers.set(event, handler);
    });
    mocks.SocketModeClient.mockClear();
    mocks.WebClient.mockClear();

    mocks.authTest.mockReset().mockResolvedValue({ user_id: 'UME' });
    mocks.usersInfo
      .mockReset()
      .mockResolvedValue({ user: { real_name: 'Alice', name: 'alice' } });
    mocks.conversationsInfo.mockReset().mockImplementation(defaultConversationsInfo);
    mocks.conversationsHistory.mockReset().mockResolvedValue({ messages: [] });
    mocks.conversationsReplies.mockReset().mockResolvedValue({ messages: [] });
  });

  afterEach(() => {
    monitor?.stop();
    monitor = null;
    storage.close();
    delete process.env.SLACK_APP_TOKEN;
    delete process.env.SLACK_USER_TOKEN;
  });

  // Validates: Requirement 5.5
  it('start() seeds the watched set from getChannelConfig(db)', async () => {
    setChannelConfig(db, ['C123', 'C456']);

    monitor = createSlackMonitor({ db });
    await monitor.start();

    expect(new Set(monitor.getWatchedChannels())).toEqual(new Set(['C123', 'C456']));
  });

  // Validates: Requirement 5.3
  it('setWatchedChannels updates the set without disconnecting or restarting the socket', async () => {
    monitor = createSlackMonitor({ db });
    await monitor.start();

    // Clear any calls made during start() so we only see what setWatchedChannels does.
    mocks.socketStart.mockClear();
    mocks.socketDisconnect.mockClear();

    monitor.setWatchedChannels(['C999']);

    expect(mocks.socketDisconnect).not.toHaveBeenCalled();
    expect(mocks.socketStart).not.toHaveBeenCalled();
    expect(monitor.getWatchedChannels()).toEqual(['C999']);
  });

  // Validates: watched DMs AND watched channels emit immediately (the 30-min
  // channel batch was removed); unwatched conversations are dropped.
  it('watched DM and watched channel both emit immediately; unwatched drops', async () => {
    // C111 is a public channel, D222 is a DM, C999 is unwatched.
    mocks.conversationsInfo.mockImplementation(async ({ channel }: { channel: string }) => {
      if (channel === 'D222') {
        return { channel: { id: 'D222', is_im: true, is_mpim: false, is_private: false, name: '' } };
      }
      if (channel === 'C111') {
        return {
          channel: { id: 'C111', is_im: false, is_mpim: false, is_private: false, name: 'general' },
        };
      }
      return {
        channel: { id: channel, is_im: false, is_mpim: false, is_private: false, name: channel.toLowerCase() },
      };
    });

    monitor = createSlackMonitor({ db });

    const emitted: RawWorkItem[] = [];
    monitor.onWorkItem((item) => emitted.push(item));

    await monitor.start();
    monitor.setWatchedChannels(['C111', 'D222']);

    const messageHandler = mocks.socketHandlers.get('message');
    expect(messageHandler).toBeDefined();

    const ack = vi.fn().mockResolvedValue(undefined);

    // Watched channel: now EMITTED immediately (no more 30-min buffer).
    await messageHandler!({
      event: { type: 'message', text: 'channel hello', user: 'U1', channel: 'C111', ts: '1700000000.000100' },
      ack,
    });
    expect(emitted).toHaveLength(1);
    expect(emitted[0].metadata.channelId).toBe('C111');

    // Watched DM: also emitted immediately.
    await messageHandler!({
      event: { type: 'message', text: 'dm hello', user: 'U2', channel: 'D222', ts: '1700000001.000200' },
      ack,
    });
    expect(emitted).toHaveLength(2);
    expect(emitted[1].metadata.channelId).toBe('D222');
    expect(emitted[1].metadata.channelType).toBe('dm');

    // Not in watched set: DROPPED.
    await messageHandler!({
      event: { type: 'message', text: 'should be dropped', user: 'U3', channel: 'C999', ts: '1700000002.000300' },
      ack,
    });
    expect(emitted).toHaveLength(2);
  });

  // ─── History backfill ──────────────────────────────────────────────────────

  describe('backfillChannel', () => {
    function collect(m: SlackMonitor): RawWorkItem[] {
      const out: RawWorkItem[] = [];
      m.onWorkItem((i) => out.push(i));
      return out;
    }

    it('emits history messages oldest-first through the live item path', async () => {
      // Slack returns newest-first; the backfill must reverse for timeline order.
      mocks.conversationsHistory.mockResolvedValue({
        messages: [
          { ts: '1700000300.000000', user: 'U1', text: 'newest' },
          { ts: '1700000200.000000', user: 'U1', text: 'middle' },
          { ts: '1700000100.000000', user: 'U1', text: 'oldest' },
        ],
      });
      monitor = createSlackMonitor({ db });
      const emitted = collect(monitor);

      const r = await monitor.backfillChannel!('C111');

      expect(r.error).toBeUndefined();
      expect(r).toMatchObject({ channelId: 'C111', fetched: 3, emitted: 3, skipped: 0 });
      expect(emitted.map((i) => i.content)).toEqual(['oldest', 'middle', 'newest']);
      // Same permalink scheme + historical capturedAt as live capture.
      expect(emitted[0].url).toBe('https://slack.com/archives/C111/p1700000100000000');
      expect(emitted[0].title).toBe('Slack #c111');
      expect(emitted[0].capturedAt.getTime()).toBe(1700000100000);
      expect(emitted[0].metadata.channelId).toBe('C111');
      expect(mocks.conversationsHistory).toHaveBeenCalledWith(
        expect.objectContaining({ channel: 'C111', limit: 200 }),
      );
    });

    it('skips messages already stored (permalink match) so reruns are idempotent', async () => {
      const ts = '1700000200.000000';
      db.prepare(
        'INSERT INTO work_items (id, type, source, title, url, captured_at) VALUES (?, ?, ?, ?, ?, ?)',
      ).run(
        'existing', 'slack_message', 'slack', 'Slack #c111',
        `https://slack.com/archives/C111/p${ts.replace('.', '')}`,
        new Date().toISOString(),
      );
      mocks.conversationsHistory.mockResolvedValue({
        messages: [
          { ts: '1700000300.000000', user: 'U1', text: 'new one' },
          { ts, user: 'U1', text: 'already captured' },
        ],
      });
      monitor = createSlackMonitor({ db });
      const emitted = collect(monitor);

      const r = await monitor.backfillChannel!('C111');

      expect(r).toMatchObject({ fetched: 2, emitted: 1, skipped: 1 });
      expect(emitted).toHaveLength(1);
      expect(emitted[0].content).toBe('new one');
    });

    it('applies the live-path exclusions (bots, non-file_share subtypes)', async () => {
      mocks.conversationsHistory.mockResolvedValue({
        messages: [
          { ts: '1700000400.000000', user: 'U1', text: 'human msg' },
          { ts: '1700000401.000000', bot_id: 'B1', text: 'bot msg' },
          { ts: '1700000402.000000', user: 'U2', subtype: 'channel_join', text: 'joined' },
        ],
      });
      monitor = createSlackMonitor({ db });
      const emitted = collect(monitor);

      const r = await monitor.backfillChannel!('C111');

      expect(r).toMatchObject({ fetched: 1, emitted: 1 });
      expect(emitted.map((i) => i.content)).toEqual(['human msg']);
    });

    it('fetches thread replies and drops the echoed parent', async () => {
      mocks.conversationsHistory.mockResolvedValue({
        messages: [{ ts: '1700000500.000000', user: 'U1', text: 'parent', reply_count: 2 }],
      });
      mocks.conversationsReplies.mockResolvedValue({
        messages: [
          { ts: '1700000500.000000', user: 'U1', text: 'parent', reply_count: 2 },
          { ts: '1700000510.000000', user: 'U2', text: 'reply 1', thread_ts: '1700000500.000000' },
          { ts: '1700000520.000000', user: 'U1', text: 'reply 2', thread_ts: '1700000500.000000' },
        ],
      });
      monitor = createSlackMonitor({ db });
      const emitted = collect(monitor);

      const r = await monitor.backfillChannel!('C111');

      expect(mocks.conversationsReplies).toHaveBeenCalledWith(
        expect.objectContaining({ channel: 'C111', ts: '1700000500.000000' }),
      );
      expect(r).toMatchObject({ fetched: 3, emitted: 3, threadsFetched: 1 });
      expect(emitted.map((i) => i.content)).toEqual(['parent', 'reply 1', 'reply 2']);
    });

    it('paginates with the cursor and keeps the NEWEST maxMessages', async () => {
      mocks.conversationsHistory
        .mockResolvedValueOnce({
          messages: [
            { ts: '1700000905.000000', user: 'U1', text: 'm5' },
            { ts: '1700000904.000000', user: 'U1', text: 'm4' },
          ],
          response_metadata: { next_cursor: 'cur2' },
        })
        .mockResolvedValueOnce({
          messages: [
            { ts: '1700000903.000000', user: 'U1', text: 'm3' },
            { ts: '1700000902.000000', user: 'U1', text: 'm2' },
            { ts: '1700000901.000000', user: 'U1', text: 'm1' },
          ],
        });
      monitor = createSlackMonitor({ db });
      const emitted = collect(monitor);

      const r = await monitor.backfillChannel!('C111', { maxMessages: 3 });

      expect(mocks.conversationsHistory).toHaveBeenCalledTimes(2);
      expect(mocks.conversationsHistory.mock.calls[1][0]).toMatchObject({ cursor: 'cur2' });
      expect(r).toMatchObject({ fetched: 3, emitted: 3 });
      // Oldest two beyond the cap are dropped; survivors emit oldest-first.
      expect(emitted.map((i) => i.content)).toEqual(['m3', 'm4', 'm5']);
    });

    it('records a completion marker in app_settings', async () => {
      mocks.conversationsHistory.mockResolvedValue({
        messages: [{ ts: '1700001000.000000', user: 'U1', text: 'x' }],
      });
      monitor = createSlackMonitor({ db });

      await monitor.backfillChannel!('C42');

      const marker = getSetting<any>(db, 'slack.backfill.C42');
      expect(marker).toMatchObject({ fetched: 1, emitted: 1, skipped: 0 });
      expect(typeof marker.at).toBe('string');
    });

    it('rejects a concurrent backfill for the same channel', async () => {
      let release!: (v: any) => void;
      mocks.conversationsHistory.mockImplementation(
        () => new Promise((resolve) => { release = resolve; }),
      );
      monitor = createSlackMonitor({ db });

      const first = monitor.backfillChannel!('C111');
      const second = await monitor.backfillChannel!('C111');

      expect(second.error).toMatch(/already in progress/);
      expect(monitor.backfillStatus!().inFlight).toEqual(['C111']);

      release({ messages: [] });
      const firstResult = await first;
      expect(firstResult.error).toBeUndefined();
      expect(monitor.backfillStatus!().inFlight).toEqual([]);
    });

    it('returns the Slack error and writes no marker on failure', async () => {
      mocks.conversationsHistory.mockRejectedValue({
        data: { error: 'not_in_channel' },
        message: 'An API error occurred',
      });
      monitor = createSlackMonitor({ db });

      const r = await monitor.backfillChannel!('C77');

      expect(r.error).toBe('not_in_channel');
      expect(r.emitted).toBe(0);
      expect(getSetting(db, 'slack.backfill.C77')).toBeNull();
    });
  });
});
