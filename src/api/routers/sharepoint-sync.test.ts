import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createSharePointSyncRouter } from './sharepoint-sync.js';
import type { RouterDeps } from './deps.js';

/** Router-level tests (sharepoint-docs-brain R9.2): validation, busy handling. */

function appWith(deps: Partial<RouterDeps>) {
  const app = express();
  app.use(express.json());
  app.use('/api', createSharePointSyncRouter(deps as RouterDeps));
  return app;
}

const fakeSync = () => {
  const status = { enabled: true, queue: { queued: 1, failed: 0, live: 1, backfill: 0 }, sources: [], gates: { backlog: true, cache: true, connection: true }, backoffs: {}, lastRun: null, discovering: false, draining: false };
  return {
    getStatus: () => status,
    updateConfig: (input: any) => {
      if (input.sources && input.sources.some((s: any) => s.kind === 'bad')) throw new Error("source kind 'bad' is not supported");
      return status;
    },
    runNow: async () => ({ status: 'completed', perSource: {}, durationMs: 5 }),
    drainNow: async () => 2,
    confirmSurge: (id: string) => { if (id !== 'known') throw new Error(`unknown source '${id}'`); return status; },
    purge: () => ({ items: 3, cacheFiles: 1 }),
  };
};

describe('sharepoint-sync router', () => {
  it('503s everywhere when the sync is not wired', async () => {
    const app = appWith({});
    for (const [method, url] of [['get', '/api/sharepoint-sync/status'], ['put', '/api/sharepoint-sync/config'], ['post', '/api/sharepoint-sync/run']] as const) {
      const response = await (request(app) as any)[method](url).send({});
      expect(response.status).toBe(503);
    }
  });

  it('returns status, accepts config, rejects invalid sources with 400', async () => {
    const app = appWith({ sharePointSync: fakeSync() as any });
    const status = await request(app).get('/api/sharepoint-sync/status');
    expect(status.status).toBe(200);
    expect(status.body.status.queue.queued).toBe(1);

    const ok = await request(app).put('/api/sharepoint-sync/config').send({ enabled: true });
    expect(ok.status).toBe(200);

    const notObject = await request(app).put('/api/sharepoint-sync/config').send([1, 2]);
    expect(notObject.status).toBe(400);

    const badSource = await request(app).put('/api/sharepoint-sync/config').send({ sources: [{ kind: 'bad' }] });
    expect(badSource.status).toBe(400);
    expect(badSource.body.error).toMatch(/not supported/);
  });

  it('run and drain report results; confirm-surge validates sourceId', async () => {
    const app = appWith({ sharePointSync: fakeSync() as any });
    const run = await request(app).post('/api/sharepoint-sync/run').send({});
    expect(run.status).toBe(200);
    expect(run.body.result.status).toBe('completed');

    const drain = await request(app).post('/api/sharepoint-sync/drain').send({});
    expect(drain.body.processed).toBe(2);

    const missing = await request(app).post('/api/sharepoint-sync/confirm-surge').send({});
    expect(missing.status).toBe(400);
    const unknown = await request(app).post('/api/sharepoint-sync/confirm-surge').send({ sourceId: 'nope' });
    expect(unknown.status).toBe(400);
    const known = await request(app).post('/api/sharepoint-sync/confirm-surge').send({ sourceId: 'known' });
    expect(known.status).toBe(200);
  });

  it('site picker maps a busy runtime to 409 and passes results through otherwise', async () => {
    let busy = true;
    const mcpManager = {
      callTool: async () => {
        if (busy) throw new Error("MCP server 'sharepoint' is busy");
        return { text: JSON.stringify([{ Title: 'MX Team', Path: 'https://amazon.sharepoint.com/sites/mx-team' }]), isError: false };
      },
    };
    const app = appWith({ mcpManager: mcpManager as any });

    const blocked = await request(app).get('/api/sharepoint/sites?query=mx');
    expect(blocked.status).toBe(409);
    expect(blocked.body.busy).toBe(true);

    busy = false;
    const okResponse = await request(app).get('/api/sharepoint/sites?query=mx');
    expect(okResponse.status).toBe(200);
    expect(okResponse.body.sites[0].Title).toBe('MX Team');
  });

  it('library picker rejects non-sharepoint site URLs before any MCP call', async () => {
    let called = false;
    const mcpManager = { callTool: async () => { called = true; return { text: '[]', isError: false }; } };
    const app = appWith({ mcpManager: mcpManager as any });
    const bad = await request(app).get('/api/sharepoint/libraries?siteUrl=https://evil.example.com/sites/x');
    expect(bad.status).toBe(400);
    expect(called).toBe(false);
  });
});
