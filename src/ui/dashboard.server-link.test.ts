// @vitest-environment jsdom
//
// The dashboard window while BotBoy's server stops, restarts, or never comes back
// (owner report 2026-10-14: after Quit & Reopen the Chrome window stayed open and
// silently dead). The SHIPPED index.html, app.js and dashboard.js are booted in jsdom
// with fake timers, a fake fetch and a fake EventSource; a fake server goes up,
// down, "starting" (503) and back with a new boot id.
//
// Contract (docs/maps/ui-shell.md › Server link):
//  - unreachable for more than about 10 s → one calm, announced status line;
//  - the server answers again → the line goes away at once; a NEW boot id reloads
//    this same window on the same route within one poll (the existing bootId branch);
//  - nothing opens a second window, nothing logs an unhandled rejection, no draft is lost.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const html = readFileSync(path.join(process.cwd(), 'src/ui/index.html'), 'utf8');
const MESSAGE = 'BotBoy has stopped or is restarting. Open BotBoy from Applications to continue.';

type Mode = 'up' | 'down' | 'starting' | 'stopping' | 'broken';
const server = { mode: 'up' as Mode, bootId: 'boot-1', pollsAnswered: 0 };

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

async function fakeFetch(input: unknown, init?: { method?: string }) {
  const { pathname } = new URL(String(input), 'http://localhost:7778');
  if (server.mode === 'down') throw new TypeError('Failed to fetch');
  if (server.mode === 'starting' && pathname.startsWith('/api/')) return json(503, { booting: true, uptimeMs: 1000 });
  if (server.mode === 'stopping' && pathname.startsWith('/api/')) return json(503, { error: 'BotBoy is shutting down', shuttingDown: true });
  if (server.mode === 'broken' && pathname === '/api/dashboard/version') return json(500, { error: 'boom' });
  if (pathname === '/api/dashboard/version') {
    server.pollsAnswered += 1;
    return json(200, {
      version: '1', analyticsVersion: '0', dataRoomVersion: '0', documentsVersion: '0',
      bootId: server.bootId, processId: 1234, uiVersion: '5:100', terminal: null,
    });
  }
  if (pathname === '/api/chat/history') return json(200, [{ id: 'm1', role: 'user', content: 'hello there' }, { id: 'm2', role: 'assistant', content: 'hi' }]);
  if (pathname === '/api/chat/jobs/active') return json(200, { job: null, recent: null });
  if (pathname === '/api/app-update/status') return json(200, { supported: true, available: true, updating: false, behind: 1 });
  if (pathname === '/api/app-update/start') return json(200, { ok: true, message: 'Updating. BotBoy will restart on its own.' });
  if (pathname === '/api/nodes/roots' || pathname === '/api/areas' || pathname === '/api/projects') return json(200, []);
  return json(200, init?.method === 'POST' ? { ok: true } : {});
}

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  readyState = 1;
  constructor(public url: string) { FakeEventSource.instances.push(this); }
  close() { this.readyState = 2; }
}

const navigations: string[] = [];
const unhandled: string[] = [];
const onUnhandled = (reason: unknown) => { unhandled.push(String((reason as Error)?.message ?? reason)); };

/** `location` with a reload that records instead of navigating (jsdom cannot navigate, and its own reload is unforgeable). */
function installLocationSpy() {
  const real = window.location;
  const fake: Record<string, unknown> = {
    reload: () => { navigations.push('reload'); },
    assign: (url: string) => { navigations.push(`assign ${url}`); },
    replace: (url: string) => { navigations.push(`replace ${url}`); },
    toString: () => real.href,
  };
  for (const key of ['hash', 'href', 'pathname', 'search', 'origin', 'host', 'hostname', 'port', 'protocol']) {
    Object.defineProperty(fake, key, {
      enumerable: true,
      get: () => (real as unknown as Record<string, unknown>)[key],
      set: key === 'hash' || key === 'href' ? (value: string) => { (real as unknown as Record<string, unknown>)[key] = value; } : undefined,
    });
  }
  Object.defineProperty(globalThis, 'location', { configurable: true, get: () => fake });
}

async function bootPage(hash = '#/settings/workplace') {
  vi.resetModules();
  server.mode = 'up';
  server.bootId = 'boot-1';
  server.pollsAnswered = 0;
  navigations.length = 0;
  unhandled.length = 0;
  FakeEventSource.instances.length = 0;
  sessionStorage.clear();
  localStorage.clear();
  document.documentElement.innerHTML = html.replace(/<script[\s\S]*?<\/script>/g, '');
  history.replaceState(null, '', `/${hash}`);
  vi.stubGlobal('fetch', fakeFetch);
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} });
  Element.prototype.scrollTo = function () {} as never;
  Element.prototype.scrollIntoView = function () {} as never;
  window.scrollTo = (() => {}) as never;
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  installLocationSpy();
  process.on('unhandledRejection', onUnhandled);
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  await import('./app.js');
  await import('./dashboard.js');
  await vi.advanceTimersByTimeAsync(200);
}

const seconds = (n: number) => vi.advanceTimersByTimeAsync(n * 1000);
const banner = () => document.getElementById('server-link-banner') as HTMLElement;

/** Advance one second at a time until `done()` or `limit` seconds pass; returns the seconds waited. */
async function waitUntil(done: () => boolean, limit: number): Promise<number> {
  let waited = 0;
  while (!done() && waited < limit) {
    await seconds(1);
    waited += 1;
  }
  return waited;
}

beforeEach(() => {
  // The page must not open windows or tabs.
  vi.stubGlobal('open', vi.fn());
});

afterEach(() => {
  process.off('unhandledRejection', onUnhandled);
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('server stopped, window alive', () => {
  it('stays quiet at first, then shows one status line within about ten to fifteen seconds', async () => {
    await bootPage();
    await seconds(12);
    expect(banner().textContent).toBe('');
    server.mode = 'down';
    await seconds(9);
    expect(banner().textContent).toBe(''); // fewer than ten seconds of failures: no line yet
    const waited = await waitUntil(() => banner().textContent !== '', 12);
    expect(banner().textContent).toBe(MESSAGE);
    expect(9 + waited).toBeLessThanOrEqual(15);
    expect(banner().getAttribute('role')).toBe('status');
    expect(banner().getAttribute('aria-live')).toBe('polite');
    expect(banner().classList.contains('is-visible')).toBe(true);
  });

  it('keeps the page itself as it was: no reload, no navigation, no window, the transcript stays', async () => {
    await bootPage();
    await seconds(12);
    server.mode = 'down';
    await seconds(90);
    expect(banner().textContent).toBe(MESSAGE);
    expect(navigations).toEqual([]);
    expect(window.open).not.toHaveBeenCalled();
    expect(document.getElementById('chat-messages')!.textContent).toContain('hello there');
    expect(location.hash).toBe('#/settings/workplace');
  });

  it('logs no unhandled rejection while the server is down (the chat poll used to log one every 5 s)', async () => {
    await bootPage();
    await seconds(12);
    server.mode = 'down';
    unhandled.length = 0;
    await seconds(60);
    expect(unhandled).toEqual([]);
  });

  it('a server that answers 500 is not "stopped"', async () => {
    await bootPage();
    await seconds(12);
    server.mode = 'broken';
    await seconds(60);
    expect(banner().textContent).toBe('');
  });
});

describe('server restarted (stopping 503, gone, starting 503, new boot)', () => {
  async function restart(options: { downSeconds?: number; startingSeconds?: number; newBoot?: boolean } = {}) {
    const { downSeconds = 20, startingSeconds = 15, newBoot = true } = options;
    server.mode = 'stopping';
    await seconds(4);
    server.mode = 'down';
    await seconds(downSeconds);
    server.mode = 'starting';
    await seconds(startingSeconds);
    if (newBoot) server.bootId = 'boot-2';
    server.mode = 'up';
  }

  it('shows the line through the outage and the starting phase, then reloads this window on the same route', async () => {
    await bootPage('#/settings/workplace');
    await seconds(12);
    server.mode = 'stopping';
    await seconds(4);
    server.mode = 'down';
    await seconds(20);
    expect(banner().textContent).toBe(MESSAGE);
    server.mode = 'starting'; // the new server is listening and answers 503 until it is ready
    await seconds(15);
    expect(banner().textContent).toBe(MESSAGE);
    expect(navigations).toEqual([]);
    server.bootId = 'boot-2';
    server.mode = 'up';
    const waited = await waitUntil(() => navigations.length > 0, 12);
    expect(waited).toBeLessThanOrEqual(6); // one poll after the new boot is ready
    expect(navigations).toEqual(['reload']); // this window, once: no assign, replace, or second window
    expect(window.open).not.toHaveBeenCalled();
    expect(banner().textContent).toBe(''); // the answer cleared the line before the reload
    // The route survives: same hash, and the stash that the reloaded page restores from.
    expect(location.hash).toBe('#/settings/workplace');
    expect(JSON.parse(sessionStorage.getItem('botboy-reload-scroll')!)).toMatchObject({ hash: '#/settings/workplace' });
  });

  it('keeps a half-typed chat message across the reload', async () => {
    await bootPage();
    await seconds(12);
    (document.getElementById('chatInput') as HTMLTextAreaElement).value = 'draft I was typing';
    await restart();
    await waitUntil(() => navigations.length > 0, 12);
    expect(sessionStorage.getItem('botboy-reload-draft')).toBe('draft I was typing');
  });

  it('does not reload while the owner is working, then does so once they pause (12 s)', async () => {
    await bootPage();
    await seconds(12);
    await restart();
    for (let i = 0; i < 4; i++) {
      window.dispatchEvent(new Event('pointerdown'));
      await seconds(5);
    }
    expect(navigations).toEqual([]);
    expect(banner().textContent).toBe(''); // the server is back, so the line is gone even while the reload waits
    await waitUntil(() => navigations.length > 0, 20);
    expect(navigations).toEqual(['reload']);
  });

  it('the same server coming back (a blip, same boot id) clears the line and does not reload', async () => {
    await bootPage();
    await seconds(12);
    server.mode = 'down';
    await seconds(30);
    expect(banner().textContent).toBe(MESSAGE);
    server.mode = 'up';
    await seconds(6);
    expect(banner().textContent).toBe('');
    expect(navigations).toEqual([]);
  });

  it('a restart too quick to fail a poll still reloads on the new boot id, with no line', async () => {
    await bootPage();
    await seconds(12);
    server.bootId = 'boot-2';
    await waitUntil(() => navigations.length > 0, 12);
    expect(navigations).toEqual(['reload']);
    expect(banner().textContent).toBe('');
  });

  it('the Update button path is the same: Updating, the server restarts, the window reloads', async () => {
    await bootPage();
    await seconds(20);
    const button = document.getElementById('app-update-button') as HTMLButtonElement;
    expect(button.hidden).toBe(false);
    button.click();
    await seconds(1);
    expect(button.textContent).toContain('Updating');
    server.mode = 'stopping';
    await seconds(8);
    server.mode = 'down';
    await seconds(40);
    expect(banner().textContent).toBe(MESSAGE);
    expect(button.textContent).toContain('Updating');
    server.mode = 'starting';
    await seconds(10);
    server.bootId = 'boot-2';
    server.mode = 'up';
    await waitUntil(() => navigations.length > 0, 12);
    expect(navigations).toEqual(['reload']);
    expect(banner().textContent).toBe('');
  });
});
