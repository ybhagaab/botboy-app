import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import type Database from 'better-sqlite3';
import { createStorage, setSetting, type StorageLayer } from '../core/storage.js';
import { setChannelConfig } from '../core/slack-config.js';
import { createRouter } from './routes.js';

/**
 * HTTP tests for the Slack history-backfill surface:
 *
 *   - PUT  /api/slack/config          → auto-backfill of newly added channels
 *   - POST /api/slack/backfill        → manual trigger (202 fire-and-forget)
 *   - GET  /api/slack/backfill/status → in-flight + completion markers
 *
 * The SlackMonitor is a hand-rolled mock (same pattern as routes.slack.test.ts);
 * the DB is real in-memory SQLite so marker reads/writes are exercised for real.
 */

function makeMonitor(overrides: Record<string, any> = {}) {
  return {
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn(),
    isConnected: vi.fn().mockReturnValue(true),
    onWorkItem: vi.fn(),
    setWatchedChannels: vi.fn(),
    getWatchedChannels: vi.fn().mockReturnValue([]),
    backfillChannel: vi.fn().mockResolvedValue({
      channelId: 'CX', fetched: 0, emitted: 0, skipped: 0, threadsFetched: 0,
    }),
    backfillStatus: vi.fn().mockReturnValue({ inFlight: [] }),
    ...overrides,
  };
}

function buildApp(deps: Parameters<typeof createRouter>[0]): express.Express {
  const app = express();
  app.use(express.json());
  app.use('/api', createRouter(deps));
  return app;
}

describe('Slack backfill routes', () => {
  let storage: StorageLayer;
  let db: Database.Database;

  beforeEach(() => {
    storage = createStorage(':memory:');
    storage.initialize();
    db = storage.getDb();
  });

  afterEach(() => {
    storage.close();
  });

  describe('PUT /api/slack/config auto-trigger', () => {
    it('backfills only channels newly added to the watched set', async () => {
      setChannelConfig(db, ['C_OLD']);
      const monitor = makeMonitor();
      const app = buildApp({ nodeManager: {} as any, db, slackMonitor: monitor as any });

      const res = await request(app).put('/api/slack/config').send({ ids: ['C_OLD', 'C_NEW'] });

      expect(res.status).toBe(200);
      expect(new Set(res.body.ids)).toEqual(new Set(['C_OLD', 'C_NEW']));
      expect(monitor.backfillChannel).toHaveBeenCalledTimes(1);
      expect(monitor.backfillChannel).toHaveBeenCalledWith('C_NEW');
    });

    it('skips newly added channels that already have a completion marker', async () => {
      setChannelConfig(db, ['C_OLD']);
      setSetting(db, 'slack.backfill.C_BACK', { at: '2026-08-01T00:00:00Z', emitted: 5 });
      const monitor = makeMonitor();
      const app = buildApp({ nodeManager: {} as any, db, slackMonitor: monitor as any });

      const res = await request(app)
        .put('/api/slack/config')
        .send({ ids: ['C_OLD', 'C_BACK'] });

      expect(res.status).toBe(200);
      expect(monitor.backfillChannel).not.toHaveBeenCalled();
    });

    it('does not backfill on a no-op save (same set)', async () => {
      setChannelConfig(db, ['C1', 'C2']);
      const monitor = makeMonitor();
      const app = buildApp({ nodeManager: {} as any, db, slackMonitor: monitor as any });

      await request(app).put('/api/slack/config').send({ ids: ['C1', 'C2'] });

      expect(monitor.backfillChannel).not.toHaveBeenCalled();
    });
  });

  describe('POST /api/slack/backfill', () => {
    it('starts a backfill and returns 202 with the channel id', async () => {
      const monitor = makeMonitor();
      const app = buildApp({ nodeManager: {} as any, db, slackMonitor: monitor as any });

      const res = await request(app)
        .post('/api/slack/backfill')
        .send({ channelId: 'C123', days: 7, maxMessages: 100 });

      expect(res.status).toBe(202);
      expect(res.body).toEqual({ started: true, channelId: 'C123' });
      expect(monitor.backfillChannel).toHaveBeenCalledWith('C123', {
        oldestDays: 7,
        maxMessages: 100,
      });
    });

    it('400s without a channelId and on invalid numeric options', async () => {
      const monitor = makeMonitor();
      const app = buildApp({ nodeManager: {} as any, db, slackMonitor: monitor as any });

      expect((await request(app).post('/api/slack/backfill').send({})).status).toBe(400);
      expect(
        (await request(app).post('/api/slack/backfill').send({ channelId: 'C1', days: -2 })).status,
      ).toBe(400);
      expect(
        (await request(app).post('/api/slack/backfill').send({ channelId: 'C1', maxMessages: 0 }))
          .status,
      ).toBe(400);
      expect(monitor.backfillChannel).not.toHaveBeenCalled();
    });

    it('409s when a backfill for the channel is already in flight', async () => {
      const monitor = makeMonitor({
        backfillStatus: vi.fn().mockReturnValue({ inFlight: ['C123'] }),
      });
      const app = buildApp({ nodeManager: {} as any, db, slackMonitor: monitor as any });

      const res = await request(app).post('/api/slack/backfill').send({ channelId: 'C123' });

      expect(res.status).toBe(409);
      expect(monitor.backfillChannel).not.toHaveBeenCalled();
    });

    it('503s when the Slack monitor is absent', async () => {
      const app = buildApp({ nodeManager: {} as any, db });

      const res = await request(app).post('/api/slack/backfill').send({ channelId: 'C123' });

      expect(res.status).toBe(503);
    });
  });

  describe('GET /api/slack/backfill/status', () => {
    it('returns in-flight channels and parsed completion markers', async () => {
      setSetting(db, 'slack.backfill.C_A', { at: '2026-08-01T00:00:00Z', emitted: 12 });
      setSetting(db, 'slack.backfill.C_B', { at: '2026-08-02T00:00:00Z', emitted: 3 });
      const monitor = makeMonitor({
        backfillStatus: vi.fn().mockReturnValue({ inFlight: ['C_RUNNING'] }),
      });
      const app = buildApp({ nodeManager: {} as any, db, slackMonitor: monitor as any });

      const res = await request(app).get('/api/slack/backfill/status');

      expect(res.status).toBe(200);
      expect(res.body.inFlight).toEqual(['C_RUNNING']);
      expect(res.body.completed).toMatchObject({
        C_A: { emitted: 12 },
        C_B: { emitted: 3 },
      });
    });
  });
});
