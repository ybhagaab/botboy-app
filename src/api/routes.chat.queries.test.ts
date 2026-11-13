import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type Database from 'better-sqlite3';
import { createStorage, type StorageLayer } from '../core/storage.js';
import { createNodeManager } from '../core/node-manager.js';
import { createRouter } from './routes.js';
import type { RunningQuery } from '../core/query-control.js';

/**
 * Running queries in the chat panel (docs/maps/query-control.md): the owner sees every SQL query and ETL run BotBoy has
 * running and stops any of them. Stop is the rendered panel's alone; nothing else can reach it through these routes.
 */
function listening(app: express.Express): Promise<Server> {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}
const query = (over: Partial<RunningQuery>): RunningQuery => ({
  id: 'aaaaaaaa-0000-4000-8000-000000000001', kind: 'sql', origin: 'main', label: 'Revenue by week', preview: 'SELECT 1',
  startedAt: '2026-11-12T08:00:00.000Z', runningForMs: 60_000, where: 'botboy', ...over,
});

describe('running queries routes', () => {
  let storage: StorageLayer;
  let db: Database.Database;
  let servers: Server[];
  beforeEach(() => {
    storage = createStorage(':memory:');
    storage.initialize();
    db = storage.getDb();
    servers = [];
  });
  afterEach(async () => {
    await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))));
    storage.close();
  });
  async function serve(overrides: Record<string, unknown> = {}) {
    const app = express();
    app.use(express.json());
    app.use('/api', createRouter({ nodeManager: createNodeManager(db), db, ...overrides } as any));
    const server = await listening(app);
    servers.push(server);
    const port = (server.address() as AddressInfo).port;
    const origin = `http://127.0.0.1:${port}`;
    const ownerPost = (path: string) => request(server).post(path).set('Origin', origin).set('Sec-Fetch-Site', 'same-origin');
    return { server, origin, ownerPost };
  }
  const control = () => {
    const list = vi.fn(async () => ({
      queries: [query({}), query({ id: 'etl:77', kind: 'etl', origin: 'job', jobId: 'cj_5', where: 'datanet', runId: '77', label: 'Weekly streams' })],
      checkedAt: '2026-11-12T08:01:00.000Z',
      warnings: ['Datanet did not answer for 1 ETL run; it is listed as still running.'],
    }));
    const stop = vi.fn(async (id: string) => (id === 'missing'
      ? { ok: false, id, code: 'not_running' as const, error: 'No running BotBoy query has the id missing.' }
      : id === 'stuck'
        ? { ok: false, id, kind: 'sql' as const, state: 'still_running' as const, code: 'stop_failed' as const, error: 'still runs' }
        : { ok: true, id, kind: 'sql' as const, state: 'stopped' as const, verified: true }));
    const starterOf = vi.fn((running: RunningQuery) => (running.origin === 'job' ? 'job #5 OTT CX behaviour study' : 'the main chat'));
    return { list, stop, starterOf };
  };

  it('lists BotBoy\'s running queries with who started them, fresh when the owner looks, and one job\'s on its own', async () => {
    const queryControl = control();
    const { server } = await serve({ queryControl });
    const all = await request(server).get('/api/chat/queries?fresh=1');
    expect(all.status).toBe(200);
    expect(all.headers['cache-control']).toBe('no-store');
    expect(all.body).toMatchObject({ available: true, checkedAt: '2026-11-12T08:01:00.000Z', warnings: [expect.stringContaining('Datanet')] });
    expect(all.body.queries.map((entry: any) => [entry.id, entry.startedBy])).toEqual([
      ['aaaaaaaa-0000-4000-8000-000000000001', 'the main chat'], ['etl:77', 'job #5 OTT CX behaviour study'],
    ]);
    expect(queryControl.list).toHaveBeenLastCalledWith({ fresh: true });
    const one = await request(server).get('/api/chat/queries?jobId=cj_5');
    expect(one.body.queries.map((entry: any) => entry.id)).toEqual(['etl:77']);
    expect(queryControl.list).toHaveBeenLastCalledWith({ fresh: false });
  });

  it('reads as nothing running when query control is not wired', async () => {
    const { server } = await serve();
    const res = await request(server).get('/api/chat/queries');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ available: false, queries: [] });
  });

  it('refuses the list to another website', async () => {
    const queryControl = control();
    const { server } = await serve({ queryControl });
    expect((await request(server).get('/api/chat/queries').set('Origin', 'https://attacker.example')).status).toBe(403);
    expect(queryControl.list).not.toHaveBeenCalled();
  });

  it('Stop works only from the rendered panel, and answers with the stop\'s receipt', async () => {
    const queryControl = control();
    const { server, origin, ownerPost } = await serve({ queryControl });
    const id = 'aaaaaaaa-0000-4000-8000-000000000001';
    expect((await request(server).post('/api/chat/queries/stop').send({ id })).status).toBe(403); // no Origin: not the panel
    expect((await request(server).post('/api/chat/queries/stop').set('Origin', origin).set('Sec-Fetch-Site', 'cross-site').send({ id })).status).toBe(403);
    expect((await request(server).post('/api/chat/queries/stop').set('Origin', 'https://attacker.example').set('Sec-Fetch-Site', 'same-origin').send({ id })).status).toBe(403);
    expect(queryControl.stop).not.toHaveBeenCalled();
    const stopped = await ownerPost('/api/chat/queries/stop').send({ id });
    expect(stopped.status).toBe(200);
    expect(stopped.body).toMatchObject({ ok: true, state: 'stopped', verified: true });
    expect(queryControl.stop).toHaveBeenCalledWith(id, { kind: 'owner' });
    expect((await ownerPost('/api/chat/queries/stop').send({ id: 'missing' })).status).toBe(404);
    expect((await ownerPost('/api/chat/queries/stop').send({ id: 'stuck' })).status).toBe(409);
    expect((await ownerPost('/api/chat/queries/stop').send({})).status).toBe(400);
    expect((await ownerPost('/api/chat/queries/stop').send({ id: 'x'.repeat(201) })).status).toBe(400);
  });

  it('Stop says so when stopping queries is unavailable', async () => {
    const { ownerPost } = await serve();
    const res = await ownerPost('/api/chat/queries/stop').send({ id: 'aaaaaaaa-0000-4000-8000-000000000001' });
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ ok: false, code: 'unavailable' });
  });
});
