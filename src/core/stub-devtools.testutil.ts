/**
 * Stand-ins for the debug Chrome's DevTools endpoint and for BotBoy's own server, for the tests
 * of the dashboard-window logic (start.sh › open_dashboard_window, scripts/dashboard-window.mjs).
 *
 * Nothing here is a browser and nothing here binds a fixed port: both servers listen on an
 * ephemeral port of 127.0.0.1, so a test can never reach the owner's debug Chrome (9222) or the
 * owner's server (7778). start.sh and the helper are pointed at them through
 * BOTBOY_TEST_CDP_ORIGIN / BOTBOY_TEST_APP_ORIGIN (start.sh) and `--cdp` / `--app` (the helper).
 *
 * The DevTools stand-in speaks the part of the protocol the window logic uses:
 *   GET /json/version, /json/list, /json/activate/<id>, /json/close/<id>
 *   WebSocket /devtools/page/<id>:  Page.getFrameTree, Page.navigate (anything else is recorded and answered empty)
 * plus one control route a stand-in Chrome program calls to open a window: GET /__spawn?url=<url>.
 * Every request is appended to `events`, in order, so a test can assert exactly what was done to
 * which target, and that nothing else was.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer } from 'ws';

export type StubTarget = {
  id: string;
  type: string;
  url: string;
  title?: string;
  /** What Chrome reports for a page that failed to load: the address that could not be loaded. */
  unreachableUrl?: string;
  /** Answer Page.getFrameTree with a protocol error (a tab that went away). */
  frameTreeError?: boolean;
  /** Answer Page.navigate with an errorText, like Chrome does when the server is not reachable. */
  navigateError?: string;
};

export type StubDevTools = {
  origin: string;
  port: number;
  /** The address the operating system reports the listener is bound to; always 127.0.0.1. */
  listenAddress: string;
  targets: StubTarget[];
  /** Ordered log: `list`, `version`, `activate <id>`, `close <id>`, `spawn <url>`, `frameTree <id>`, `navigate <id> <url>`, `cdp <id> <method>`. */
  events: string[];
  add(target: StubTarget): void;
  close(): Promise<void>;
};

export async function startStubDevTools(initial: StubTarget[] = []): Promise<StubDevTools> {
  const targets: StubTarget[] = initial.map((target) => ({ ...target }));
  const events: string[] = [];
  let spawned = 0;
  let port = 0;
  const find = (id: string) => targets.find((target) => target.id === id);
  const listing = () => targets.map((target) => ({
    id: target.id,
    type: target.type,
    url: target.url,
    title: target.title ?? '',
    webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/${target.id}`,
  }));

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const send = (status: number, body: string, type = 'text/plain') => {
      res.writeHead(status, { 'content-type': type });
      res.end(body);
    };
    if (url.pathname === '/json/version') {
      events.push('version');
      return send(200, JSON.stringify({ Browser: 'StubChrome/1', 'Protocol-Version': '1.3' }), 'application/json');
    }
    if (url.pathname === '/json/list' || url.pathname === '/json') {
      events.push('list');
      return send(200, JSON.stringify(listing()), 'application/json');
    }
    const activate = /^\/json\/activate\/(.+)$/.exec(url.pathname);
    if (activate) {
      events.push(`activate ${activate[1]}`);
      return send(find(activate[1]) ? 200 : 404, find(activate[1]) ? 'Target activated' : 'No such target id');
    }
    const close = /^\/json\/close\/(.+)$/.exec(url.pathname);
    if (close) {
      events.push(`close ${close[1]}`);
      const at = targets.findIndex((target) => target.id === close[1]);
      if (at < 0) return send(404, 'No such target id');
      targets.splice(at, 1);
      return send(200, 'Target is closing');
    }
    if (url.pathname === '/__spawn') {
      const opened = url.searchParams.get('url') ?? 'about:blank';
      spawned += 1;
      events.push(`spawn ${opened}`);
      targets.push({ id: `spawned-${spawned}`, type: 'page', url: opened });
      return send(200, 'ok');
    }
    return send(404, 'not found');
  });

  const sockets = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    const match = /^\/devtools\/page\/([^/?]+)/.exec(req.url ?? '');
    const target = match ? find(match[1]) : undefined;
    if (!target) {
      socket.destroy();
      return;
    }
    sockets.handleUpgrade(req, socket, head, (ws) => {
      ws.on('message', (raw) => {
        let message: { id?: number; method?: string; params?: { url?: string } };
        try { message = JSON.parse(String(raw)); } catch { return; }
        const reply = (result: unknown) => ws.send(JSON.stringify({ id: message.id, result }));
        const fail = (text: string) => ws.send(JSON.stringify({ id: message.id, error: { code: -32000, message: text } }));
        if (message.method === 'Page.getFrameTree') {
          events.push(`frameTree ${target.id}`);
          if (target.frameTreeError) return fail('Target closed');
          return reply({
            frameTree: {
              frame: {
                id: `frame-${target.id}`,
                loaderId: 'loader',
                url: target.url,
                securityOrigin: '',
                mimeType: 'text/html',
                ...(target.unreachableUrl ? { unreachableUrl: target.unreachableUrl } : {}),
              },
            },
          });
        }
        if (message.method === 'Page.navigate') {
          const to = String(message.params?.url ?? '');
          events.push(`navigate ${target.id} ${to}`);
          if (target.navigateError) return reply({ frameId: `frame-${target.id}`, loaderId: 'loader', errorText: target.navigateError });
          target.url = to;
          delete target.unreachableUrl;
          return reply({ frameId: `frame-${target.id}`, loaderId: 'loader' });
        }
        events.push(`cdp ${target.id} ${message.method ?? '?'}`);
        return reply({});
      });
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;

  return {
    origin: `http://127.0.0.1:${port}`,
    port,
    listenAddress: (server.address() as AddressInfo).address,
    targets,
    events,
    add: (target) => { targets.push({ ...target }); },
    close: () => new Promise<void>((resolve) => {
      for (const client of sockets.clients) client.terminate();
      sockets.close();
      server.closeAllConnections?.();
      server.close(() => resolve());
    }),
  };
}

export type StubApp = {
  origin: string;
  port: number;
  /** The address the operating system reports the listener is bound to; always 127.0.0.1. */
  listenAddress: string;
  /** Hosts the stand-in answers to, as seen in a tab URL: `localhost:<port>`. */
  host: string;
  requests: string[];
  close(): Promise<void>;
};

/**
 * BotBoy's server as start.sh sees it: only the version receipt answers. The first `fastFirst` receipts answer at once,
 * the next `stallFirst` take `stallMs`, like a freshly booted server whose event loop is busy for a second or two (the
 * launcher probes with a 1 s limit); every later one answers at once.
 */
export async function startStubApp(processId = 424242, options: { fastFirst?: number; stallFirst?: number; stallMs?: number } = {}): Promise<StubApp> {
  const requests: string[] = [];
  const stalled = new Set<NodeJS.Timeout>();
  let fastLeft = options.fastFirst ?? 0;
  let stallLeft = options.stallFirst ?? 0;
  const server = http.createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    if ((req.url ?? '').startsWith('/api/dashboard/version')) {
      let stall = 0;
      if (fastLeft > 0) fastLeft -= 1;
      else if (stallLeft > 0) { stallLeft -= 1; stall = options.stallMs ?? 1500; }
      const timer = setTimeout(() => {
        stalled.delete(timer);
        if (res.destroyed || res.writableEnded) return;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ bootId: 'stub-boot', processId }));
      }, stall);
      stalled.add(timer);
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    origin: `http://localhost:${port}`,
    port,
    listenAddress: (server.address() as AddressInfo).address,
    host: `localhost:${port}`,
    requests,
    close: () => new Promise<void>((resolve) => {
      for (const timer of stalled) clearTimeout(timer);
      stalled.clear();
      server.closeAllConnections?.();
      server.close(() => resolve());
    }),
  };
}
