/**
 * A fake Chrome DevTools endpoint for the browser monitor's tests: HTTP
 * `/json/list` plus one WebSocket per target that answers `Runtime.evaluate`.
 *
 * Answers are chosen by the KIND of expression (never by its exact text), so
 * the same fake serves the monitor before and after its reads were
 * restructured:
 *   ready     `document.readyState`
 *   href      any expression containing `location.href` (the error-page probe)
 *   pdf       the in-page PDF fetcher (it also contains `location.href`)
 *   html      the redacted-HTML serializer
 *   fields    the form-field reader
 *   whatsapp  the WhatsApp Web reader
 *   text      everything else (page, platform, and frame text)
 *
 * Failure injection is per target and kind: `hang` (never answers, so the
 * caller's own timeout fires), `reject` (an invalid frame, so the client
 * socket emits `error` at once), `close` (the server drops the socket), and
 * `delay`. The fake counts sockets, messages, received bytes, and evaluations
 * per kind and target, so tests can prove how much work a poll did.
 *
 * Test support only; nothing in the product imports this file.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';

export type EvalCategory = 'ready' | 'href' | 'fields' | 'html' | 'whatsapp' | 'pdf' | 'text';
export const EVAL_CATEGORIES: readonly EvalCategory[] = ['ready', 'href', 'fields', 'html', 'whatsapp', 'pdf', 'text'];

export interface FakeAnswer {
  href?: string;
  /** `document.visibilityState` (default `visible`). */
  visibility?: string;
  ready?: string;
  text?: string;
  html?: string;
  fields?: string;
  /** JSON of a WhatsApp view. */
  whatsapp?: string;
  /** Base64 of a PDF's bytes. */
  pdf?: string;
}

export type FakeBehavior =
  | { mode: 'hang' }
  | { mode: 'reject' }
  | { mode: 'close' }
  | { mode: 'delay'; ms: number };

export interface FakeCdpStats {
  /** WebSocket connections accepted, and per target. */
  sockets: number;
  socketsByTarget: Record<string, number>;
  /** Request ids in arrival order (a session's ids only grow). */
  requestIds: number[];
  /** Sockets open right now / the most open at once. */
  open: number;
  maxOpen: number;
  /** Client messages received and their bytes. */
  messages: number;
  bytes: number;
  /** Requests to `/json/list`. */
  listCalls: number;
  /** Evaluations per kind, and per target. */
  evals: Record<EvalCategory, number>;
  byTarget: Record<string, Record<EvalCategory, number>>;
  /** Requests deliberately left unanswered. */
  held: number;
}

function zeroEvals(): Record<EvalCategory, number> {
  return { ready: 0, href: 0, fields: 0, html: 0, whatsapp: 0, pdf: 0, text: 0 };
}

export function categorizeExpression(expression: string): EvalCategory {
  if (expression === 'document.readyState') return 'ready';
  if (expression.includes('btoa(')) return 'pdf';
  if (expression.includes('location.href')) return 'href';
  if (expression.includes('botboyRedactedHtml')) return 'html';
  if (expression.includes('botboyCollectFields')) return 'fields';
  if (expression.includes('conversation-info-header-chat-title')) return 'whatsapp';
  return 'text';
}

export interface FakeCdp {
  /** `host:port` (no scheme). */
  base: string;
  endpoint: string;
  targets: any[];
  answers: Map<string, () => FakeAnswer>;
  stats: FakeCdpStats;
  /** Add a page target. */
  page(id: string, url: string, title: string, answer: () => FakeAnswer, extra?: Record<string, unknown>): void;
  /** Add a cross-origin iframe target under a page. */
  frame(id: string, parentId: string, url: string, answer: () => FakeAnswer): void;
  /** Failure injection for one target and kind (`kind` `'*'` = every kind). */
  behave(id: string, kind: EvalCategory | '*', behavior: FakeBehavior | null): void;
  /** `/json/list` never answers while true. */
  hangList: boolean;
  resetStats(): void;
  /** Resolves once at least `count` requests have been deliberately left unanswered. */
  waitForHeld(count: number): Promise<void>;
  /** Drop every target, answer, and behavior; keep the server. */
  clear(): void;
  close(): Promise<void>;
}

export async function startFakeCdp(): Promise<FakeCdp> {
  const behaviors = new Map<string, FakeBehavior>();
  const sockets = new Set<WebSocket>();
  const heldWaiters: Array<{ count: number; resolve: () => void }> = [];
  const listRequests = new Set<http.ServerResponse>();
  let fake!: FakeCdp;

  const freshStats = (): FakeCdpStats => ({ sockets: 0, socketsByTarget: {}, requestIds: [], open: 0, maxOpen: 0, messages: 0, bytes: 0, listCalls: 0, evals: zeroEvals(), byTarget: {}, held: 0 });

  const server = http.createServer((req, res) => {
    if (req.url === '/json/list') {
      fake.stats.listCalls++;
      if (fake.hangList) {
        listRequests.add(res);
        fake.stats.held++;
        notifyHeld();
        return;
      }
    }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(req.url === '/json/list' ? fake.targets : {}));
  });
  const wss = new WebSocketServer({ server });

  function notifyHeld(): void {
    for (const waiter of [...heldWaiters]) {
      if (fake.stats.held >= waiter.count) {
        heldWaiters.splice(heldWaiters.indexOf(waiter), 1);
        waiter.resolve();
      }
    }
  }

  function answerFor(id: string, category: EvalCategory): string {
    const answer = fake.answers.get(id)?.() ?? {};
    switch (category) {
      case 'ready': return answer.ready ?? 'complete';
      case 'href': return answer.href ?? 'https://x.test/';
      case 'html': return answer.html ?? '';
      case 'fields': return answer.fields ?? '';
      case 'whatsapp': return answer.whatsapp ?? '';
      case 'pdf': return answer.pdf ?? '';
      default: return answer.text ?? '';
    }
  }

  wss.on('connection', (socket, req) => {
    const id = String(req.url ?? '').split('/').pop() ?? '';
    sockets.add(socket);
    fake.stats.sockets++;
    fake.stats.socketsByTarget[id] = (fake.stats.socketsByTarget[id] ?? 0) + 1;
    fake.stats.open++;
    fake.stats.maxOpen = Math.max(fake.stats.maxOpen, fake.stats.open);
    socket.on('close', () => { sockets.delete(socket); fake.stats.open--; });
    socket.on('error', () => { /* a client that hangs up mid-test */ });
    socket.on('message', (raw) => {
      fake.stats.messages++;
      fake.stats.bytes += Buffer.byteLength(String(raw));
      const msg = JSON.parse(String(raw));
      fake.stats.requestIds.push(msg.id);
      const expression = String(msg.params?.expression ?? '');
      const category = categorizeExpression(expression);
      // The widened probe answers the pair the monitor asked for; the plain
      // form answers just the address.
      const wantsPair = category === 'href' && expression.includes('visibilityState');
      fake.stats.evals[category]++;
      (fake.stats.byTarget[id] ??= zeroEvals())[category]++;
      const behavior = behaviors.get(`${id}:${category}`) ?? behaviors.get(`${id}:*`);
      const reply = () => {
        let value = answerFor(id, category);
        if (wantsPair) {
          const answer = fake.answers.get(id)?.() ?? {};
          value = JSON.stringify([value, answer.visibility ?? 'visible']);
        }
        if (socket.readyState === socket.OPEN) socket.send(JSON.stringify({ id: msg.id, result: { result: { value } } }));
      };
      if (!behavior) return reply();
      switch (behavior.mode) {
        case 'hang':
          fake.stats.held++;
          notifyHeld();
          return;
        case 'reject': {
          // An invalid frame (reserved opcode): the client socket emits 'error' at once.
          const raw = (socket as any)._socket;
          if (raw?.write) raw.write(Buffer.from([0x8f, 0x00])); else socket.terminate();
          return;
        }
        case 'close':
          socket.terminate();
          return;
        case 'delay':
          setTimeout(reply, behavior.ms);
          return;
      }
    });
  });

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `127.0.0.1:${(server.address() as AddressInfo).port}`;

  fake = {
    base,
    endpoint: `http://${base}`,
    targets: [],
    answers: new Map(),
    stats: freshStats(),
    hangList: false,
    page(id, url, title, answer, extra = {}) {
      fake.targets.push({ type: 'page', id, url, title, webSocketDebuggerUrl: `ws://${base}/devtools/page/${id}`, ...extra });
      fake.answers.set(id, answer);
    },
    frame(id, parentId, url, answer) {
      fake.targets.push({ type: 'iframe', id, parentId, url, webSocketDebuggerUrl: `ws://${base}/devtools/page/${id}` });
      fake.answers.set(id, answer);
    },
    behave(id, kind, behavior) {
      const key = `${id}:${kind}`;
      if (behavior) behaviors.set(key, behavior); else behaviors.delete(key);
    },
    resetStats() { fake.stats = freshStats(); },
    waitForHeld(count) {
      if (fake.stats.held >= count) return Promise.resolve();
      return new Promise<void>(resolve => heldWaiters.push({ count, resolve }));
    },
    clear() {
      fake.targets.length = 0;
      fake.answers.clear();
      behaviors.clear();
      fake.hangList = false;
      fake.resetStats();
    },
    async close() {
      for (const socket of sockets) socket.terminate();
      for (const res of listRequests) res.destroy();
      wss.close();
      server.closeAllConnections?.();
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
  return fake;
}
