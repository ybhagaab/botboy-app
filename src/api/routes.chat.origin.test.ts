import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type Database from 'better-sqlite3';
import { createStorage, type StorageLayer } from '../core/storage.js';
import { createNodeManager } from '../core/node-manager.js';
import { createRouter } from './routes.js';

/**
 * Another website must not start a chat turn (a turn can send email and run
 * tools). POST /chat/messages admits the dashboard's own loopback origin and
 * native/no-Origin clients only (routers/local-owner.ts).
 */
describe('POST /chat/messages origin guard', () => {
  let storage: StorageLayer;
  let db: Database.Database;
  let server: http.Server;
  let port: number;
  let sendMessage: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    storage = createStorage(':memory:');
    storage.initialize();
    db = storage.getDb();
    sendMessage = vi.fn(async () => ({ message: { id: 'reply-1', role: 'assistant', content: 'Hello.' } }));
    const app = express();
    app.use(express.json());
    app.use('/api', createRouter({
      nodeManager: createNodeManager(db),
      db,
      chatInterface: { getHistory: () => [], sendMessage } as any,
    }));
    server = http.createServer(app);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
    port = (server.address() as AddressInfo).port;
  });

  afterEach(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    storage.close();
  });

  const chatMessages = () => (db.prepare('SELECT COUNT(*) AS count FROM chat_messages').get() as { count: number }).count;
  const post = (headers: Record<string, string>, stream = true) => {
    let call = request(server).post('/api/chat/messages');
    for (const [name, value] of Object.entries(headers)) call = call.set(name, value);
    return call.send({ message: 'Email Jane the report.', stream });
  };

  it.each([
    ['another website', { Origin: 'https://attacker.example' }],
    ['a rebinding host name on the same port', { Origin: 'http://attacker.example:PORT', Host: 'attacker.example:PORT' }],
    ['another local port', { Origin: 'http://127.0.0.1:1' }],
    ['an https origin', { Origin: 'https://127.0.0.1:PORT' }],
    ['an opaque (null) origin', { Origin: 'null' }],
  ])('refuses %s before any effect', async (_label, template) => {
    const headers = Object.fromEntries(Object.entries(template).map(([name, value]) => [name, value.replace('PORT', String(port))]));
    for (const stream of [true, false]) {
      const res = await post(headers, stream);
      expect(res.status).toBe(403);
      expect(res.body.error).toMatch(/^Chat (origin|is local-only)/);
      expect(res.headers['content-type']).not.toContain('text/event-stream');
    }
    expect(sendMessage).not.toHaveBeenCalled();
    expect(chatMessages()).toBe(0);
  });

  it.each([
    ['the dashboard at 127.0.0.1', (p: number) => ({ Origin: `http://127.0.0.1:${p}` })],
    ['the dashboard at localhost', (p: number) => ({ Origin: `http://localhost:${p}` })],
    ['a native client without Origin', () => ({})],
  ])('admits %s', async (_label, headersFor) => {
    const streamed = await post(headersFor(port), true);
    expect(streamed.status).toBe(200);
    expect(streamed.text).toContain('Hello.');
    const plain = await post(headersFor(port), false);
    expect(plain.status).toBe(200);
    expect(plain.body.message.content).toBe('Hello.');
    expect(sendMessage).toHaveBeenCalledTimes(2);
  });
});
