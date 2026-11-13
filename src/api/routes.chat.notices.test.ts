import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type Database from 'better-sqlite3';
import { createStorage, type StorageLayer } from '../core/storage.js';
import { createNodeManager } from '../core/node-manager.js';
import { createChatInterface } from '../core/chat-interface.js';
import { CONTINUATION_HEADER, createContinuationBridge, type ContinuationBridge } from '../core/chat-continuations.js';
import { createRouter } from './routes.js';

/** Chat notices through the chat routes (MIDWAY_NOTICES_PLAN.md §4, §6). */
function listening(app: express.Express): Promise<Server> {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

describe('chat notice routes', () => {
  let storage: StorageLayer;
  let db: Database.Database;
  let bridge: ContinuationBridge;
  let servers: Server[];
  beforeEach(() => {
    storage = createStorage(':memory:');
    storage.initialize();
    db = storage.getDb();
    bridge = createContinuationBridge();
    servers = [];
  });
  afterEach(async () => {
    await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))));
    storage.close();
  });

  function makeApp(overrides: Record<string, unknown> = {}) {
    const app = express();
    app.use(express.json());
    app.use('/api', createRouter({
      nodeManager: createNodeManager(db),
      db,
      chatContinuations: bridge,
      chatInterface: createChatInterface(db, {} as any),
      ...overrides,
    } as any));
    return app;
  }
  async function serve(app: express.Express) {
    const server = await listening(app);
    servers.push(server);
    const port = (server.address() as AddressInfo).port;
    const ownerPost = (path: string) => request(server).post(path).set('Origin', `http://127.0.0.1:${port}`).set('Sec-Fetch-Site', 'same-origin');
    return { server, ownerPost };
  }

  it('Re-authenticate opens the sentinel terminal only from the rendered panel', async () => {
    const openReauth = vi.fn(() => ({ ok: true as const, sessionId: 'term-1', command: 'mwinit' }));
    const { server, ownerPost } = await serve(makeApp({ midwaySentinel: { openReauth } }));
    expect((await request(server).post('/api/chat/midway-reauth')).status).toBe(403); // no Origin: not the panel
    expect((await request(server).post('/api/chat/midway-reauth').set('Origin', 'http://evil.example').set('Sec-Fetch-Site', 'cross-site')).status).toBe(403);
    expect(openReauth).not.toHaveBeenCalled();
    const opened = await ownerPost('/api/chat/midway-reauth');
    expect(opened.status).toBe(200);
    expect(opened.body).toEqual({ ok: true, sessionId: 'term-1', command: 'mwinit' });
    expect(openReauth).toHaveBeenCalledTimes(1);
  });

  it('a busy terminal is a 409 that says what to do; no sentinel is a 503', async () => {
    const busy = { ok: false as const, code: 'terminal_busy' as const, error: 'A terminal is already running in the chat. Finish or stop it, then press Re-authenticate again.' };
    const { ownerPost } = await serve(makeApp({ midwaySentinel: { openReauth: () => busy } }));
    const refused = await ownerPost('/api/chat/midway-reauth');
    expect(refused.status).toBe(409);
    expect(refused.body).toEqual(busy);
    const { ownerPost: noSentinel } = await serve(makeApp());
    expect((await noSentinel('/api/chat/midway-reauth')).status).toBe(503);
  });

  it('BotBoy posts a notice row through agent-message; a malformed notice writes nothing', async () => {
    const app = makeApp();
    const notice = { key: 'startup:slack-sync', topic: 'startup', state: 'open', severity: 'warning', title: 'Slack sync did not start', labels: ['Slack'] };
    const posted = await request(app).post('/api/chat/agent-message').set(CONTINUATION_HEADER, bridge.secret)
      .send({ message: '⚠ Slack sync did not start with the app.', notice });
    expect(posted.status).toBe(200);
    expect(posted.body.notice).toMatchObject({ v: 1, ...notice });
    const malformed = await request(app).post('/api/chat/agent-message').set(CONTINUATION_HEADER, bridge.secret)
      .send({ message: 'x', notice: { topic: 'startup', state: 'open', severity: 'loud', title: 'x' } });
    expect(malformed.status).toBe(400);
    const spoofed = await request(app).post('/api/chat/agent-message').send({ message: 'x', notice });
    expect(spoofed.status).toBe(403);
    const rows = db.prepare('SELECT content, notice_json FROM chat_messages').all() as Array<{ content: string; notice_json: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].content).toBe('⚠ Slack sync did not start with the app.');
    expect(JSON.parse(rows[0].notice_json)).toMatchObject({ key: 'startup:slack-sync', title: 'Slack sync did not start' });
  });

  it('chat history carries the notice to the panel', async () => {
    db.prepare("INSERT INTO chat_messages (id, role, content, notice_json) VALUES ('notice-1', 'assistant', 'Midway sign-in needed (GRASP). Run mwinit.', ?)")
      .run(JSON.stringify({ v: 1, key: 'midway', topic: 'midway', state: 'open', severity: 'warning', title: 'Midway sign-in needed', labels: ['GRASP'], next: 'Run mwinit.' }));
    db.prepare("INSERT INTO chat_messages (id, role, content, notice_json, created_at) VALUES ('notice-2', 'assistant', 'plain', '{broken', '2026-10-29 04:26:20')").run();
    const history = await request(makeApp()).get('/api/chat/history');
    expect(history.status).toBe(200);
    const messages = history.body as any[];
    const byId = Object.fromEntries(messages.map(message => [message.id, message]));
    expect(byId['notice-1'].notice).toMatchObject({ title: 'Midway sign-in needed', labels: ['GRASP'], next: 'Run mwinit.' });
    expect(byId['notice-2'].notice).toBeUndefined();
    // created_at is SQLite UTC; the panel shows notice times, so it must not be read as local time.
    expect(byId['notice-2'].createdAt).toBe('2026-10-29T04:26:20.000Z');
  });
});
