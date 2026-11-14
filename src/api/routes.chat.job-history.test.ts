import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type Database from 'better-sqlite3';
import { createStorage, type StorageLayer } from '../core/storage.js';
import { createNodeManager } from '../core/node-manager.js';
import { createChatJobStore, type ChatJobStore } from '../core/chat-jobs.js';
import { createRouter } from './routes.js';

/**
 * GET /api/chat/jobs/history (docs/maps/job-history.md): the Jobs page's one read. It answers only BotBoy's own pages on this
 * Mac (no other website, no DNS-rebinding host name), and so do the chat panel's job reads, which carry the jobs' threads.
 */
function listening(app: express.Express): Promise<Server> {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

describe('job history route', () => {
  let storage: StorageLayer;
  let db: Database.Database;
  let jobs: ChatJobStore;
  let servers: Server[];
  beforeEach(() => {
    storage = createStorage(':memory:');
    storage.initialize();
    db = storage.getDb();
    jobs = createChatJobStore(db);
    servers = [];
  });
  afterEach(async () => {
    await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))));
    storage.close();
  });
  async function serve() {
    const app = express();
    app.use(express.json());
    app.use('/api', createRouter({ nodeManager: createNodeManager(db), db, chatJobs: jobs } as any));
    const server = await listening(app);
    servers.push(server);
    return { server, port: (server.address() as AddressInfo).port };
  }
  const started = (goal: string, hoursAgo: number) => {
    const job = jobs.start({ goal });
    db.prepare('UPDATE chat_jobs SET created_at = ? WHERE id = ?').run(new Date(Date.now() - hoursAgo * 3_600_000).toISOString(), job.id);
    return job;
  };

  it('answers the page with rows, counts and a cursor, and passes the words, filter and cursor through', async () => {
    const roadmap = started('Plan the 2027 roadmap', 3);
    jobs.end(roadmap.id, 'done', 'Saved the roadmap.');
    const stopped = started('Pull the numbers', 2);
    jobs.end(stopped.id, 'stopped', 'stopped by the owner');
    const running = started('Watch the export', 1);
    const { server } = await serve();
    const all = await request(server).get('/api/chat/jobs/history?limit=2');
    expect(all.status).toBe(200);
    expect(all.headers['cache-control']).toBe('no-store');
    expect(all.body.counts).toEqual({ all: 3, done: 1, stopped: 1 });
    expect(all.body.jobs.map((row: any) => [row.id, row.state])).toEqual([[running.id, 'running'], [stopped.id, 'stopped']]);
    expect(all.body.jobs[1]).toMatchObject({ title: expect.any(String), goal: 'Pull the numbers', ending: 'You stopped it', outputs: [], hasThread: false });
    const older = await request(server).get(`/api/chat/jobs/history?limit=2&before=${encodeURIComponent(all.body.next)}`);
    expect(older.body.jobs.map((row: any) => row.id)).toEqual([roadmap.id]);
    expect(older.body.next).toBeUndefined();
    const done = await request(server).get('/api/chat/jobs/history?status=done');
    expect(done.body.jobs.map((row: any) => row.id)).toEqual([roadmap.id]);
    const words = await request(server).get(`/api/chat/jobs/history?q=${encodeURIComponent('2027')}`);
    expect(words.body.jobs.map((row: any) => row.id)).toEqual([roadmap.id]);
    // An unknown filter reads as All.
    expect((await request(server).get('/api/chat/jobs/history?status=everything')).body.jobs).toHaveLength(3);
  });

  it('refuses another website and a rebinding host name, for the history and for the chat panel\'s job reads', async () => {
    const job = started('Anything', 1);
    const { server, port } = await serve();
    for (const url of ['/api/chat/jobs/history', '/api/chat/jobs', `/api/chat/jobs/${job.id}`]) {
      expect((await request(server).get(url)).status, url).toBe(200);
      expect((await request(server).get(url).set('Origin', 'https://evil.example')).status, `${url} foreign origin`).toBe(403);
      expect((await request(server).get(url).set('Host', `evil.example:${port}`)).status, `${url} rebinding host`).toBe(403);
      expect((await request(server).get(url).set('Origin', `http://localhost:${port}`).set('Host', `localhost:${port}`)).status, `${url} own page`).toBe(200);
    }
  });

  it('answers an empty page when the job store is not wired, and a real job id still reads as a job', async () => {
    const app = express();
    app.use('/api', createRouter({ nodeManager: createNodeManager(db), db } as any));
    const server = await listening(app);
    servers.push(server);
    const empty = await request(server).get('/api/chat/jobs/history');
    expect(empty.body).toEqual({ jobs: [], counts: { all: 0, done: 0, stopped: 0 } });
    const { server: wired } = await serve();
    const job = started('A job', 1);
    expect((await request(wired).get(`/api/chat/jobs/${job.id}`)).body.job.id).toBe(job.id);
    expect((await request(wired).get('/api/chat/jobs/history')).body.jobs.map((row: any) => row.id)).toEqual([job.id]);
  });
});
