/**
 * Shutdown with the dashboard open (owner's live restart, 2026-10-14): every stop ended with
 * "⚠ pid N required bounded escalation but closed SQLite", receipt outcome `forced`, forcedReasons
 * `http_grace_timeout` and `stages_complete_remaining_http`. The open GET /api/chat/live stream (open whenever a
 * dashboard window is) never ended, so the coordinator waited out its HTTP grace and forced.
 *
 * Contract (docs/maps/teammate-install-release.md › Shutdown/takeover): no long-lived response survives admission
 * close. The real chat and MCP routers run behind the real shutdown coordinator on a loopback server with an
 * ephemeral port; the viewers are keep-alive clients, like a browser's EventSource.
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import { createShutdownCoordinator } from '../core/shutdown-coordinator.js';
import { createContinuationBridge } from '../core/chat-continuations.js';
import { createChatRouter } from './routers/chat.js';
import { createDashboardState } from './routers/dashboard.js';
import { createMcpRouter } from './routers/mcp.js';

const GRACE_MS = 1_500; // shorter than Node's 5 s keep-alive timeout, so a socket left open would outlast it
const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

/** A terminal engine as the routes see it: replays one chunk, then streams to whoever is still subscribed. */
function fakeTerminal() {
  const state = { subscribed: 0, unsubscribed: 0 };
  const listeners = new Set<(chunk: string) => void>();
  const subscribe = (onChunk: (chunk: string) => void) => {
    state.subscribed += 1;
    onChunk('$ ');
    listeners.add(onChunk);
    let released = false;
    return () => {
      if (!released) { released = true; state.unsubscribed += 1; }
      listeners.delete(onChunk);
    };
  };
  return {
    state,
    /** Output that keeps coming; returns how many streams it reached. */
    emit: (chunk: string) => { for (const listener of listeners) listener(chunk); return listeners.size; },
    chat: { subscribe: (_session: string, onChunk: (chunk: string) => void) => subscribe(onChunk) },
    mcp: {
      isHiddenByWorkplace: () => false,
      subscribeTerminal: (_profile: string, _session: string, onChunk: (chunk: string) => void) => subscribe(onChunk),
    },
  };
}

/** One viewer: resolves with how its stream ended ('end' = a clean end of the response). */
function watch(port: number, urlPath: string, agent: http.Agent) {
  return new Promise<{ status: number; body: string; how: 'end' | 'error' }>((resolve) => {
    const request = http.get({ host: '127.0.0.1', port, path: urlPath, agent }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode ?? 0, body, how: 'end' }));
      response.on('error', () => resolve({ status: response.statusCode ?? 0, body, how: 'error' }));
    });
    request.on('error', () => resolve({ status: 0, body: '', how: 'error' }));
  });
}

async function server() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'botboy-shutdown-streams-'));
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const databasePath = path.join(root, 'tracker.db');
  fs.writeFileSync(databasePath, 'synthetic-db');
  const exitCodes: number[] = [];
  const httpServer = http.createServer();
  const coordinator = createShutdownCoordinator({
    server: httpServer,
    databasePath,
    receiptPath: path.join(root, 'shutdown.json'),
    pid: 4747,
    httpGraceMs: GRACE_MS,
    httpSettleMs: 200,
    hardDeadlineMs: 6_000,
    quiesce: () => {},
    closeStages: [],
    flushQueue: () => {},
    closeDatabase: () => {},
    exit: (code) => { exitCodes.push(code); },
  });
  const bridge = createContinuationBridge();
  const hub = { subscribed: 0, unsubscribed: 0, delivered: 0 };
  const subscribe = bridge.hub.subscribe.bind(bridge.hub);
  bridge.hub.subscribe = (listener) => {
    hub.subscribed += 1;
    const unsubscribe = subscribe((message) => { hub.delivered += 1; listener(message); });
    let released = false;
    return () => { if (!released) { released = true; hub.unsubscribed += 1; } unsubscribe(); };
  };
  const terminal = fakeTerminal();
  const deps = {
    nodeManager: {} as any,
    shutdown: coordinator.context,
    chatContinuations: bridge,
    chatTerminal: terminal.chat as any,
    mcpManager: terminal.mcp as any,
  };
  const seen: string[] = [];
  const app = express();
  app.use((req, _res, next) => { seen.push(req.path); next(); });
  app.use('/api', createChatRouter(deps as any, createDashboardState()));
  app.use('/api', createMcpRouter(deps as any));
  httpServer.on('request', coordinator.wrapRequestHandler(app));
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const port = (httpServer.address() as { port: number }).port;
  cleanups.push(() => { if (httpServer.listening) httpServer.close(); });
  return { port, coordinator, bridge, hub, terminal, seen, exitCodes };
}

async function until(done: () => boolean) {
  for (let i = 0; i < 300 && !done(); i++) await new Promise((resolve) => setTimeout(resolve, 10));
  expect(done()).toBe(true);
}

describe('shutdown with the dashboard open: no long-lived response survives admission close', () => {
  it('ends /chat/live and the two terminal streams at once, so the HTTP stage completes inside its grace and the receipt is clean', async () => {
    const s = await server();
    const agent = new http.Agent({ keepAlive: true });
    cleanups.push(() => agent.destroy());
    const paths = ['/api/chat/live', '/api/chat/terminal/term-1/stream', '/api/mcp/profiles/sql-context/terminal/sess-1/stream'];
    // /chat/live with no continuation running, as on every restart: the stream has sent nothing yet.
    const viewers = paths.map((urlPath) => watch(s.port, urlPath, agent));
    await until(() => paths.every((urlPath) => s.seen.includes(urlPath)) && s.terminal.state.subscribed === 2 && s.hub.subscribed === 1);

    const completion = s.coordinator.begin('SIGINT');
    // The streams ended the moment admission closed, producers first: output that keeps coming reaches none of
    // them (a write after the end would emit an unhandled error and take the server down before its receipt).
    expect(s.terminal.emit('late output')).toBe(0);
    const delivered = s.hub.delivered;
    s.bridge.hub.begin({ turnKey: 'late', jobId: 'job-1', goal: 'g', note: '', startedAt: new Date().toISOString() });
    expect(s.hub.delivered).toBe(delivered);
    const receipt = await completion;
    const outcomes = await Promise.all(viewers);

    // Each viewer saw its response end cleanly: not a reset, not a destroyed socket.
    expect(outcomes.map((outcome) => outcome.how)).toEqual(['end', 'end', 'end']);
    expect(outcomes.map((outcome) => outcome.status)).toEqual([200, 200, 200]);
    expect(outcomes[1].body).toContain('event: output');
    expect(outcomes[2].body).toContain('event: output');
    // The three streams were open when shutdown began, and none of them held it.
    expect(receipt.http.requestsAtStart.map((entry) => entry.path).sort()).toEqual([...paths].sort());
    expect(receipt.forcedReasons).toEqual([]);
    expect(receipt.outcome).toBe('clean');
    expect(receipt.status).toBe('complete');
    expect(receipt.http.destroyedSocketCount).toBe(0);
    const httpStage = receipt.stages.find((stage) => stage.name === 'http');
    expect(httpStage?.status).toBe('completed');
    expect(httpStage!.durationMs!).toBeLessThan(GRACE_MS);
    expect(s.exitCodes).toEqual([0]);
    // Every producer let go before its stream ended, so nothing can write after the end.
    expect(s.hub.unsubscribed).toBe(1);
    expect(s.terminal.state.unsubscribed).toBe(2);
  });

  it('a viewer that reconnects meets a closed port, not a stopping server it could keep busy', async () => {
    const s = await server();
    const agent = new http.Agent({ keepAlive: true });
    cleanups.push(() => agent.destroy());
    const viewer = watch(s.port, '/api/chat/live', agent);
    await until(() => s.seen.includes('/api/chat/live'));
    await s.coordinator.begin('SIGINT');
    expect((await viewer).how).toBe('end');
    // The browser's EventSource retries at its own interval (about 3 s); each retry is refused until the next
    // server listens, so a stopping server sees no reconnect traffic at all.
    const again = await watch(s.port, '/api/chat/live', new http.Agent({ keepAlive: false }));
    expect(again).toEqual({ status: 0, body: '', how: 'error' });
  });
});
