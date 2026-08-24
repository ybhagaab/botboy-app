import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import type Database from 'better-sqlite3';
import { createStorage, type StorageLayer } from '../core/storage.js';
import type { RawWorkItem } from '../core/types.js';

/**
 * End-to-end integration test for the slack-channel-config feature.
 *
 * Boots Express with the real router, in-memory SQLite, and a real
 * `SlackMonitor` wired to a mocked `SocketModeClient`/`WebClient`. Drives
 * configuration changes via HTTP PUT and asserts that the in-memory filter
 * reflects them on the very next message — covering the full
 * persist → setWatchedChannels → classify pipeline.
 *
 * Validates: Requirements 4.4, 5.1, 5.2, 5.4, 6.1, 6.2, 6.3, 6.4
 */

// ── Mocks for @slack/socket-mode and @slack/web-api ────────────────────────
//
// Defined inside vi.hoisted() so the references survive vi.mock() factory
// hoisting. Mirrors the pattern in slack-monitor.test.ts so message events
// can be injected directly via the captured handler.

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
  const usersConversations = vi.fn();
  const WebClient = vi.fn().mockImplementation(() => ({
    auth: { test: authTest },
    users: { info: usersInfo, conversations: usersConversations },
    conversations: { info: conversationsInfo },
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
    usersConversations,
    WebClient,
  };
});

vi.mock('@slack/socket-mode', () => ({ SocketModeClient: mocks.SocketModeClient }));
vi.mock('@slack/web-api', () => ({ WebClient: mocks.WebClient }));

// Static imports are safe: createSlackMonitor only constructs the mocked
// clients when called, not at module load.
import { createSlackMonitor, type SlackMonitor } from '../monitors/slack-monitor.js';
import { createRouter } from './routes.js';

// ── conversations.info mock helper ─────────────────────────────────────────
//
// IDs starting with `D` are reported as DMs (is_im=true); everything else
// is a public channel. The monitor uses this to decide DM-emit vs. channel-buffer.
async function defaultConversationsInfo({ channel }: { channel: string }) {
  if (typeof channel === 'string' && channel.startsWith('D')) {
    return {
      channel: { id: channel, is_im: true, is_mpim: false, is_private: false, name: '' },
    };
  }
  return {
    channel: {
      id: channel,
      is_im: false,
      is_mpim: false,
      is_private: false,
      name: String(channel).toLowerCase(),
    },
  };
}

describe('Slack end-to-end integration (PUT → hot-reload → classify)', () => {
  let storage: StorageLayer;
  let db: Database.Database;
  let monitor: SlackMonitor;
  let app: express.Express;
  let emits: RawWorkItem[];

  beforeEach(async () => {
    // Force the active (token-present) factory branch so a real monitor is
    // returned rather than the disabled stub.
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
    mocks.usersConversations.mockReset().mockResolvedValue({
      channels: [],
      response_metadata: {},
    });

    monitor = createSlackMonitor({ db });

    emits = [];
    monitor.onWorkItem((item) => emits.push(item));

    await monitor.start();

    app = express();
    app.use(express.json());
    app.use(
      '/api',
      createRouter({
        nodeManager: {} as any,
        db,
        slackMonitor: monitor,
        // slackWebClient intentionally omitted — this test never hits
        // GET /api/slack/conversations.
      }),
    );
  });

  afterEach(() => {
    // Idempotent: stop() flushes the (already-empty) batch and clears the
    // 30-min interval. Safe to call even if the test already stopped it.
    monitor?.stop();
    storage.close();
    delete process.env.SLACK_APP_TOKEN;
    delete process.env.SLACK_USER_TOKEN;
  });

  it('PUT hot-reloads the watched set; watched channels/DMs emit immediately, unwatched drop', async () => {
    const messageHandler = mocks.socketHandlers.get('message');
    expect(messageHandler, 'monitor must register a message handler on start()').toBeDefined();

    const ack = vi.fn().mockResolvedValue(undefined);
    const channelsOf = () => emits.map((e) => e.metadata.channelId);

    // ── Case 1: configure ['C111'] then send a C111 channel message ──
    const res1 = await request(app).put('/api/slack/config').send({ ids: ['C111'] });
    expect(res1.status).toBe(200);
    expect(new Set(monitor.getWatchedChannels())).toEqual(new Set(['C111']));

    await messageHandler!({
      event: { type: 'message', text: 'hello channel C111', user: 'U1', channel: 'C111', ts: '1700000000.000100' },
      ack,
    });
    // Watched channel now emits IMMEDIATELY (no 30-min buffer).
    expect(channelsOf()).toEqual(['C111']);

    // ── Case 2: switch watched set to ['C222', 'D333'] (a channel + a DM) ──
    const res2 = await request(app).put('/api/slack/config').send({ ids: ['C222', 'D333'] });
    expect(res2.status).toBe(200);
    expect(new Set(monitor.getWatchedChannels())).toEqual(new Set(['C222', 'D333']));

    // 2a: C111 is no longer watched → dropped.
    await messageHandler!({
      event: { type: 'message', text: 'should be dropped', user: 'U2', channel: 'C111', ts: '1700000001.000200' },
      ack,
    });
    expect(channelsOf()).toEqual(['C111']); // unchanged

    // 2b: C222 channel message → emitted immediately.
    await messageHandler!({
      event: { type: 'message', text: 'channel C222 hi', user: 'U3', channel: 'C222', ts: '1700000002.000300' },
      ack,
    });
    expect(channelsOf()).toEqual(['C111', 'C222']);

    // 2c: D333 DM → emitted immediately.
    await messageHandler!({
      event: { type: 'message', text: 'dm hi', user: 'U4', channel: 'D333', ts: '1700000003.000400' },
      ack,
    });
    expect(channelsOf()).toEqual(['C111', 'C222', 'D333']);
    expect(emits[2].metadata.channelType).toBe('dm');

    // The dropped C111 (Case 2a) never appears again — exactly one C111 total.
    expect(channelsOf().filter((c) => c === 'C111')).toHaveLength(1);
  });
});
