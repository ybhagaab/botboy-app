import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createStorage, getSetting, type StorageLayer } from '../../core/storage.js';
import { BROWSER_CAPTURE_SETTING_KEY, createBrowserCaptureState, type BrowserCaptureState } from '../../core/browser-capture-state.js';
import type { BrowserCaptureStatus } from '../../monitors/browser-monitor.js';
import { createBrowserCaptureRouter } from './browser-capture.js';

describe('browser capture routes', () => {
  let storage: StorageLayer;
  let state: BrowserCaptureState;
  let wake: ReturnType<typeof vi.fn>;
  let app: express.Express;
  const monitorStatus = (): BrowserCaptureStatus => ({
    paused: state.paused(), intervalMs: 60_000, baseIntervalMs: 30_000, slowedReason: 'memory pressure: warn',
    lastPollMs: 120, lastPollAt: 1_700_000_000_000, tabsSeen: 8, tabsRead: 8, tabsDeferred: 0,
  });

  beforeEach(() => {
    storage = createStorage(':memory:');
    storage.initialize();
    state = createBrowserCaptureState({ db: storage.getDb() });
    wake = vi.fn();
    app = express();
    app.use(express.json());
    app.use('/api', createBrowserCaptureRouter({
      nodeManager: {} as any,
      browserCapture: { state, monitor: { status: monitorStatus, wake } },
    }));
  });
  afterEach(() => storage.close());

  const put = (body: unknown) => request(app).put('/api/browser-capture/pause').send(body as object);
  const owner = (body: unknown) => {
    const req = put(body);
    const port = new URL(req.url).port;
    return req.set('Origin', `http://127.0.0.1:${port}`).set('Sec-Fetch-Site', 'same-origin');
  };

  it('GET returns the monitor status with the pause and the change counter', async () => {
    const res = await request(app).get('/api/browser-capture');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      paused: false, changedAt: null, version: 0, intervalMs: 60_000, baseIntervalMs: 30_000,
      slowedReason: 'memory pressure: warn', tabsSeen: 8, tabsRead: 8, tabsDeferred: 0,
    });
  });

  it('GET is 503 when browser capture is not wired', async () => {
    const bare = express();
    bare.use('/api', createBrowserCaptureRouter({ nodeManager: {} as any }));
    expect((await request(bare).get('/api/browser-capture')).status).toBe(503);
  });

  it('PUT refuses a request without an Origin (403) and changes nothing', async () => {
    const res = await put({ paused: true });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('owner_action_required');
    expect(state.paused()).toBe(false);
  });

  it('PUT refuses a cross-origin or cross-site request (403)', async () => {
    const wrongOrigin = await put({ paused: true }).set('Origin', 'https://evil.example').set('Sec-Fetch-Site', 'same-origin');
    expect(wrongOrigin.status).toBe(403);
    const req = put({ paused: true });
    const port = new URL(req.url).port;
    const crossSite = await req.set('Origin', `http://127.0.0.1:${port}`).set('Sec-Fetch-Site', 'cross-site');
    expect(crossSite.status).toBe(403);
    expect(state.paused()).toBe(false);
    expect(getSetting(storage.getDb(), BROWSER_CAPTURE_SETTING_KEY)).toBeNull();
  });

  it('PUT answers 400 for an absent or non-boolean body', async () => {
    for (const body of [{}, { paused: 'true' }, { paused: 1 }, { paused: null }, [true]]) {
      const res = await owner(body);
      expect(res.status).toBe(400);
      expect(res.body.error).toEqual(expect.any(String));
    }
    expect(state.paused()).toBe(false);
  });

  it('pausing persists, bumps the version, and does not wake the monitor', async () => {
    const res = await owner({ paused: true });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ paused: true, version: 1 });
    expect(res.body.changedAt).toEqual(expect.any(String));
    expect(getSetting<any>(storage.getDb(), BROWSER_CAPTURE_SETTING_KEY)).toMatchObject({ paused: true });
    expect(wake).not.toHaveBeenCalled();
    // A new state on the same database still reads paused.
    expect(createBrowserCaptureState({ db: storage.getDb() }).paused()).toBe(true);
  });

  it('resuming wakes the monitor and bumps the version again', async () => {
    await owner({ paused: true });
    const res = await owner({ paused: false });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ paused: false, version: 2 });
    expect(wake).toHaveBeenCalledTimes(1);
    expect(getSetting<any>(storage.getDb(), BROWSER_CAPTURE_SETTING_KEY)).toMatchObject({ paused: false });
  });
});
