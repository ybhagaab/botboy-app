import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createStorage, type StorageLayer } from '../core/storage.js';
import { createRouter } from './routes.js';
import { getChannelConfig } from '../core/slack-config.js';

/**
 * Unit tests for the Slack routes mounted at `/api/slack/*`.
 *
 * The router is a thin layer over `slack-config.ts` and the running
 * `SlackMonitor`, so the tests exercise it with hand-rolled mocks for
 * `slackMonitor` and `slackWebClient` and a real in-memory SQLite DB.
 *
 * Validates: Requirements 3.3, 3.4, 4.3, 4.4, 5.1
 */

type SlackMonitorMock = {
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  isConnected: ReturnType<typeof vi.fn>;
  onWorkItem: ReturnType<typeof vi.fn>;
  setWatchedChannels: ReturnType<typeof vi.fn>;
  getWatchedChannels: ReturnType<typeof vi.fn>;
};

function makeSlackMonitorMock(): SlackMonitorMock {
  return {
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn(),
    isConnected: vi.fn().mockReturnValue(true),
    onWorkItem: vi.fn(),
    setWatchedChannels: vi.fn(),
    getWatchedChannels: vi.fn().mockReturnValue([]),
  };
}

function buildApp(deps: Parameters<typeof createRouter>[0]): express.Express {
  const app = express();
  app.use(express.json());
  app.use('/api', createRouter(deps));
  return app;
}

describe('Slack routes', () => {
  let storage: StorageLayer;

  beforeEach(() => {
    storage = createStorage(':memory:');
    storage.initialize();
  });

  afterEach(() => {
    storage.close();
  });

  describe('GET /api/slack/conversations', () => {
    // Validates: Requirement 3.4
    it('returns 503 when slackMonitor and slackWebClient are absent', async () => {
      const app = buildApp({
        nodeManager: {} as any,
        db: storage.getDb(),
        // slackMonitor / slackWebClient intentionally undefined
      });

      const res = await request(app).get('/api/slack/conversations');

      expect(res.status).toBe(503);
      expect(res.body).toEqual({
        error: 'Slack capture is not running',
      });
    });

    // Validates: Requirement 3.3
    it('returns 502 with the upstream error message when the WebClient throws', async () => {
      const upstreamError: any = new Error('connection refused');
      upstreamError.data = { error: 'channel_not_found' };

      const slackWebClient = {
        users: {
          conversations: vi.fn().mockRejectedValue(upstreamError),
        },
      } as any;

      const app = buildApp({
        nodeManager: {} as any,
        db: storage.getDb(),
        slackMonitor: makeSlackMonitorMock() as any,
        slackWebClient,
      });

      const res = await request(app).get('/api/slack/conversations');

      expect(res.status).toBe(502);
      // The handler prefers err.data.error over err.message when present.
      expect(res.body.error).toBe('Slack API error: channel_not_found');
    });

    it('returns 502 falling back to err.message when err.data.error is absent', async () => {
      const slackWebClient = {
        users: {
          conversations: vi.fn().mockRejectedValue(new Error('socket hang up')),
        },
      } as any;

      const app = buildApp({
        nodeManager: {} as any,
        db: storage.getDb(),
        slackMonitor: makeSlackMonitorMock() as any,
        slackWebClient,
      });

      const res = await request(app).get('/api/slack/conversations');

      expect(res.status).toBe(502);
      expect(res.body.error).toBe('Slack API error: socket hang up');
    });
  });

  describe('PUT /api/slack/config', () => {
    // Validates: Requirement 4.3
    it('returns 400 when the body has a non-array ids field', async () => {
      const monitor = makeSlackMonitorMock();
      const app = buildApp({
        nodeManager: {} as any,
        db: storage.getDb(),
        slackMonitor: monitor as any,
      });

      const res = await request(app)
        .put('/api/slack/config')
        .send({ ids: 'not-an-array' });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/ids/);
      expect(monitor.setWatchedChannels).not.toHaveBeenCalled();
    });

    // Validates: Requirement 4.3
    it('returns 400 when the ids array contains a non-string element', async () => {
      const monitor = makeSlackMonitorMock();
      const app = buildApp({
        nodeManager: {} as any,
        db: storage.getDb(),
        slackMonitor: monitor as any,
      });

      const res = await request(app)
        .put('/api/slack/config')
        .send({ ids: ['C1', 2] });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/ids/);
      expect(monitor.setWatchedChannels).not.toHaveBeenCalled();
    });

    // Validates: Requirement 4.3
    it('returns 400 when the body has no ids field at all', async () => {
      const monitor = makeSlackMonitorMock();
      const app = buildApp({
        nodeManager: {} as any,
        db: storage.getDb(),
        slackMonitor: monitor as any,
      });

      const res = await request(app).put('/api/slack/config').send({});

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/ids/);
      expect(monitor.setWatchedChannels).not.toHaveBeenCalled();
    });

    // Validates: Requirement 4.4
    it('200-response body equals the persisted (deduped) list', async () => {
      const app = buildApp({
        nodeManager: {} as any,
        db: storage.getDb(),
        slackMonitor: makeSlackMonitorMock() as any,
      });

      const res = await request(app)
        .put('/api/slack/config')
        .send({ ids: ['C1', 'C1', 'C2'] });

      expect(res.status).toBe(200);
      // Order isn't part of the contract — compare as a set.
      expect(new Set(res.body.ids)).toEqual(new Set(['C1', 'C2']));
      // Response body equals what was persisted to the DB.
      expect(new Set(getChannelConfig(storage.getDb()))).toEqual(
        new Set(res.body.ids),
      );
    });

    // Validates: Requirement 5.1
    it('calls slackMonitor.setWatchedChannels with the persisted IDs before responding', async () => {
      const monitor = makeSlackMonitorMock();
      const app = buildApp({
        nodeManager: {} as any,
        db: storage.getDb(),
        slackMonitor: monitor as any,
      });

      const res = await request(app)
        .put('/api/slack/config')
        .send({ ids: ['C1', 'C1', 'C2'] });

      expect(res.status).toBe(200);
      expect(monitor.setWatchedChannels).toHaveBeenCalledTimes(1);

      // The argument is the persisted (deduped) list — same content as the response body.
      const [arg] = monitor.setWatchedChannels.mock.calls[0];
      expect(new Set(arg as string[])).toEqual(new Set(res.body.ids));
      expect(new Set(arg as string[])).toEqual(new Set(['C1', 'C2']));
    });
  });
});
