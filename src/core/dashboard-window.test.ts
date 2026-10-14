/**
 * scripts/dashboard-window.mjs: which Chrome page is BotBoy's dashboard window, and bringing back one that
 * sits on Chrome's "This site can't be reached" page (owner report 2026-10-14: after Quit & Reopen the
 * Chrome window stayed open and dead). The table of who counts as the dashboard is the safety rule of the
 * whole feature, so it is tested directly and through the command line against a recording DevTools
 * stand-in on an ephemeral port. Nothing here starts a browser or reaches port 9222 or 7778.
 */
import { spawn } from 'node:child_process';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startStubApp, startStubDevTools, type StubDevTools, type StubTarget } from './stub-devtools.testutil.js';

vi.setConfig({ testTimeout: 30_000 });

const helperPath = fileURLToPath(new URL('../../scripts/dashboard-window.mjs', import.meta.url));

type App = { origin: string; port: string; hosts: Set<string> };
type Helper = {
  parseAppOrigin(value: unknown): App | null;
  parseCdpOrigin(value: unknown): string | null;
  isDashboardUrl(value: unknown, app: App): boolean;
  dashboardUrlFor(failed: unknown, app: App): string;
  mayBeOurErrorPage(target: unknown): boolean;
  pickLiveDashboard(targets: unknown[], app: App): { id: string } | null;
  findLive(cdp: string, app: App): Promise<{ id: string; url: string } | null>;
  revive(cdp: string, app: App, log?: (message: string) => void): Promise<string | null>;
};
const load = () => import(/* @vite-ignore */ pathToFileURL(helperPath).href) as Promise<Helper>;

const APP_PORT = 61234;
const app = (helper: Helper) => helper.parseAppOrigin(`http://localhost:${APP_PORT}`)!;

describe('who is BotBoy\'s own address', () => {
  it('accepts a loopback http address with a port, and nothing else', async () => {
    const helper = await load();
    expect(helper.parseAppOrigin('http://localhost:7778')).toMatchObject({ origin: 'http://localhost:7778', port: '7778' });
    expect(helper.parseAppOrigin('http://127.0.0.1:7778')).toMatchObject({ origin: 'http://127.0.0.1:7778' });
    for (const bad of ['https://localhost:7778', 'http://localhost', 'http://example.com:7778', 'http://10.0.0.2:7778', 'localhost:7778', '', undefined, 'http://localhost.evil.example:7778']) {
      expect(helper.parseAppOrigin(bad), String(bad)).toBeNull();
    }
    expect(helper.parseCdpOrigin('http://127.0.0.1:9222')).toBe('http://127.0.0.1:9222');
    expect(helper.parseCdpOrigin('http://example.com:9222')).toBeNull();
    expect(helper.parseCdpOrigin('ws://127.0.0.1:9222')).toBeNull();
  });

  it.each([
    ['localhost', `http://localhost:${APP_PORT}/#/today`, true],
    ['127.0.0.1', `http://127.0.0.1:${APP_PORT}/api/gmail-sync/oauth/callback?code=x`, true],
    ['the root', `http://localhost:${APP_PORT}/`, true],
    ['another port', `http://localhost:${APP_PORT + 1}/`, false],
    ['a port that starts the same', `http://localhost:${APP_PORT}0/`, false],
    ['https', `https://localhost:${APP_PORT}/`, false],
    ['a longer host', `http://localhost:${APP_PORT}.evil.example/`, false],
    ['a host that ends the same', `http://evil-localhost:${APP_PORT}/`, false],
    ['credentials that point elsewhere', `http://localhost:${APP_PORT}@evil.example/`, false],
    ['the name inside another URL', `https://example.com/?next=http://localhost:${APP_PORT}/`, false],
    ['Chrome\'s error page itself', 'chrome-error://chromewebdata/', false],
    ['not a URL', 'localhost', false],
    ['nothing', undefined, false],
  ])('isDashboardUrl: %s', async (_label, url, expected) => {
    const helper = await load();
    expect(helper.isDashboardUrl(url, app(helper))).toBe(expected);
  });
});

describe('where the dashboard is reloaded', () => {
  it('keeps BotBoy\'s own origin and the route, and drops the path, the query and any code', async () => {
    const helper = await load();
    const a = app(helper);
    expect(helper.dashboardUrlFor(`http://localhost:${APP_PORT}/#/settings/workplace`, a)).toBe(`http://localhost:${APP_PORT}/#/settings/workplace`);
    expect(helper.dashboardUrlFor(`http://127.0.0.1:${APP_PORT}/api/x/callback?code=SECRET&state=s#/connections/gmail-sync`, a)).toBe(`http://localhost:${APP_PORT}/#/connections/gmail-sync`);
    expect(helper.dashboardUrlFor(`http://localhost:${APP_PORT}/documents?q=1`, a)).toBe(`http://localhost:${APP_PORT}/`);
    expect(helper.dashboardUrlFor('not a url', a)).toBe(`http://localhost:${APP_PORT}/`);
  });
});

describe('which error pages are worth opening', () => {
  const error = (title: string | undefined, extra: Record<string, unknown> = {}) => ({ id: 'e', type: 'page', url: 'chrome-error://chromewebdata/', title, ...extra });

  it.each([
    ['an empty title', ''],
    ['no title', undefined],
    ['localhost', 'localhost'],
    ['localhost with a port', 'localhost:7778'],
    ['an address', '127.0.0.1'],
    ['a scheme and a path', 'http://localhost:7778/'],
    ['a loopback IPv6 address', '[::1]:7778'],
    ['capitals', 'LocalHost'],
  ])('looks at %s', async (_label, title) => {
    const helper = await load();
    expect(helper.mayBeOurErrorPage(error(title as string | undefined))).toBe(true);
  });

  it.each([
    ['another site', 'news.example.com'],
    ['a lookalike', 'localhost.evil.example'],
    ['a private address', '192.168.1.5'],
    ['a name that ends the same', 'notlocalhost'],
  ])('does not open an error page for %s', async (_label, title) => {
    const helper = await load();
    expect(helper.mayBeOurErrorPage(error(title))).toBe(false);
  });

  it('is only ever a page whose URL is Chrome\'s error page', async () => {
    const helper = await load();
    expect(helper.mayBeOurErrorPage({ id: 'p', type: 'page', url: 'http://localhost:61234/', title: 'localhost' })).toBe(false);
    expect(helper.mayBeOurErrorPage(error('localhost', { type: 'iframe' }))).toBe(false);
    expect(helper.mayBeOurErrorPage(null)).toBe(false);
  });
});

describe('the live dashboard page', () => {
  it('is the first page target on BotBoy\'s own address, never another type of target', async () => {
    const helper = await load();
    const a = app(helper);
    const picked = helper.pickLiveDashboard([
      { id: 'frame', type: 'iframe', url: `http://localhost:${APP_PORT}/frame` },
      { id: 'worker', type: 'service_worker', url: `http://localhost:${APP_PORT}/sw.js` },
      { id: 'site', type: 'page', url: `https://example.com/?u=localhost:${APP_PORT}` },
      { id: 'dash', type: 'page', url: `http://localhost:${APP_PORT}/#/today` },
      { id: 'second', type: 'page', url: `http://127.0.0.1:${APP_PORT}/` },
    ], a);
    expect(picked?.id).toBe('dash');
    expect(helper.pickLiveDashboard([{ id: 'x', type: 'page', url: 'about:blank' }], a)).toBeNull();
  });
});

describe('revive, against a recording DevTools stand-in', () => {
  let devtools: StubDevTools;
  beforeEach(async () => { devtools = await startStubDevTools(); });
  afterEach(async () => { await devtools.close(); });

  const errorPage = (id: string, unreachableUrl: string | undefined, extra: Partial<StubTarget> = {}): StubTarget =>
    ({ id, type: 'page', url: 'chrome-error://chromewebdata/', title: 'localhost', ...(unreachableUrl ? { unreachableUrl } : {}), ...extra });

  it('loads the dashboard in the tab that failed to load it, raises that tab, and says which', async () => {
    const helper = await load();
    devtools.add(errorPage('dead', `http://localhost:${APP_PORT}/#/projects`));
    const notes: string[] = [];
    expect(await helper.revive(devtools.origin, app(helper), (note) => notes.push(note))).toBe('dead');
    expect(devtools.events.filter((event) => event !== 'list')).toEqual([
      'frameTree dead',
      `navigate dead http://localhost:${APP_PORT}/#/projects`,
      'activate dead',
    ]);
    expect(notes.join('\n')).toContain('tab dead');
    expect(devtools.targets[0].url).toBe(`http://localhost:${APP_PORT}/#/projects`);
  });

  it('sends nothing but Page.getFrameTree to a tab it decides is not ours', async () => {
    const helper = await load();
    devtools.add(errorPage('other', 'http://localhost:3000/'));
    expect(await helper.revive(devtools.origin, app(helper))).toBeNull();
    expect(devtools.events.filter((event) => event !== 'list')).toEqual(['frameTree other']);
  });

  it('stops at the first tab it reloads, and moves on from a tab that is not ours', async () => {
    const helper = await load();
    devtools.add(errorPage('other', 'http://localhost:3000/'));
    devtools.add(errorPage('first', `http://localhost:${APP_PORT}/#/a`));
    devtools.add(errorPage('second', `http://localhost:${APP_PORT}/#/b`));
    expect(await helper.revive(devtools.origin, app(helper))).toBe('first');
    expect(devtools.events.filter((event) => event.startsWith('navigate'))).toEqual([`navigate first http://localhost:${APP_PORT}/#/a`]);
    expect(devtools.targets.find((target) => target.id === 'second')!.url).toBe('chrome-error://chromewebdata/');
  });

  it('answers null, and does not raise the tab, when Chrome refuses the reload', async () => {
    const helper = await load();
    devtools.add(errorPage('dead', `http://localhost:${APP_PORT}/#/x`, { navigateError: 'net::ERR_CONNECTION_REFUSED' }));
    const notes: string[] = [];
    expect(await helper.revive(devtools.origin, app(helper), (note) => notes.push(note))).toBeNull();
    expect(devtools.events.some((event) => event.startsWith('activate'))).toBe(false);
    expect(notes.join('\n')).toContain('ERR_CONNECTION_REFUSED');
  });

  it('looks at no more than eight error pages', async () => {
    const helper = await load();
    for (let i = 0; i < 12; i++) devtools.add(errorPage(`e${i}`, 'http://localhost:3000/'));
    expect(await helper.revive(devtools.origin, app(helper))).toBeNull();
    expect(devtools.events.filter((event) => event.startsWith('frameTree'))).toHaveLength(8);
  });

  it('finds the live page without opening any tab', async () => {
    const helper = await load();
    devtools.add(errorPage('dead', `http://localhost:${APP_PORT}/#/x`));
    devtools.add({ id: 'dash', type: 'page', url: `http://localhost:${APP_PORT}/#/today` });
    expect(await helper.findLive(devtools.origin, app(helper))).toEqual({ id: 'dash', url: `http://localhost:${APP_PORT}/#/today` });
    expect(devtools.events).toEqual(['list']);
  });
});

describe('the command line', () => {
  let devtools: StubDevTools;
  beforeEach(async () => { devtools = await startStubDevTools(); });
  afterEach(async () => { await devtools.close(); });

  const run = (args: string[]) => new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(process.execPath, [helperPath, ...args], { cwd: path.dirname(path.dirname(helperPath)) });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });

  it('find prints "<id><TAB><url>" for the live page and nothing otherwise', async () => {
    devtools.add({ id: 'dash', type: 'page', url: `http://localhost:${APP_PORT}/#/today` });
    const found = await run(['find', '--cdp', devtools.origin, '--app', `http://localhost:${APP_PORT}`]);
    expect(found).toMatchObject({ code: 0, stdout: `dash\thttp://localhost:${APP_PORT}/#/today` });
    const none = await run(['find', '--cdp', devtools.origin, '--app', `http://localhost:${APP_PORT + 1}`]);
    expect(none).toMatchObject({ code: 0, stdout: '' });
  });

  it('revive prints the id of the tab it reloaded and notes the rest on stderr', async () => {
    devtools.add({ id: 'dead', type: 'page', url: 'chrome-error://chromewebdata/', title: 'localhost', unreachableUrl: `http://localhost:${APP_PORT}/#/today` });
    const result = await run(['revive', '--cdp', devtools.origin, '--app', `http://localhost:${APP_PORT}`]);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe('dead');
    expect(result.stderr).toContain('dashboard-window: reloaded the dashboard in tab dead');
  });

  it('an unreachable DevTools endpoint is an empty answer with status 0, not a failure', async () => {
    const closed = await startStubDevTools();
    const origin = closed.origin;
    await closed.close();
    const result = await run(['revive', '--cdp', origin, '--app', `http://localhost:${APP_PORT}`]);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('dashboard-window: revive:');
  });

  it.each([
    ['no command', []],
    ['an unknown command', ['close', '--cdp', 'http://127.0.0.1:9', '--app', 'http://localhost:9']],
    ['a DevTools address that is not loopback', ['find', '--cdp', 'http://example.com:9222', '--app', 'http://localhost:7778']],
    ['an app address that is not loopback', ['find', '--cdp', 'http://127.0.0.1:9222', '--app', 'http://example.com:7778']],
    ['a missing app address', ['find', '--cdp', 'http://127.0.0.1:9222']],
  ])('refuses %s with status 2 before any request', async (_label, args) => {
    const result = await run(args as string[]);
    expect(result.code).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('usage:');
  });
});

describe('the stand-ins these tests run against', () => {
  it('listen on 127.0.0.1 only, on ephemeral ports that are neither BotBoy\'s nor the debug Chrome\'s', async () => {
    const devtools = await startStubDevTools();
    const app = await startStubApp();
    try {
      expect(devtools.listenAddress).toBe('127.0.0.1');
      expect(app.listenAddress).toBe('127.0.0.1');
      for (const port of [devtools.port, app.port]) {
        expect([7778, 9222]).not.toContain(port);
        expect(port).toBeGreaterThan(1023);
      }
      // Not reachable through this Mac's other addresses (the bind is loopback, not all interfaces).
      const others = Object.values(os.networkInterfaces()).flat().filter((entry) => entry && entry.family === 'IPv4' && !entry.internal).map((entry) => entry!.address);
      for (const host of others.slice(0, 2)) {
        const outcome = await new Promise<string>((resolve) => {
          const socket = net.connect({ host, port: devtools.port });
          const timer = setTimeout(() => { socket.destroy(); resolve('timeout'); }, 2000);
          socket.once('connect', () => { clearTimeout(timer); socket.destroy(); resolve('connected'); });
          socket.once('error', (error: NodeJS.ErrnoException) => { clearTimeout(timer); resolve(error.code ?? 'error'); });
        });
        expect(outcome, `${host} must not reach the stand-in`).not.toBe('connected');
      }
    } finally {
      await devtools.close();
      await app.close();
    }
  });
});
