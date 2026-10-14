/**
 * start.sh › open_dashboard_window: which Chrome window is the dashboard, and what a start, a restart,
 * or a Dock click does with it (docs/maps/teammate-install-release.md, ui-shell.md).
 *
 * Every case runs the REAL start.sh (`--open-window`, which reaches the window logic without
 * starting a server) against stand-ins on ephemeral loopback ports: a DevTools endpoint that records
 * everything done to every tab (stub-devtools.testutil.ts), BotBoy's version receipt, and a "Chrome"
 * program that only records its arguments and opens a window in the stand-in. Nothing here is a
 * browser, and nothing can reach the debug Chrome on 9222 or the server on 7778: the addresses come
 * from BOTBOY_TEST_CDP_ORIGIN / BOTBOY_TEST_APP_ORIGIN, and `launch()` refuses to run without them.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stubUiTools } from './launcher-fixtures.testutil.js';
import { releaseAllowlist } from './release-allowlist.testutil.js';
import { startStubApp, startStubDevTools, type StubApp, type StubDevTools, type StubTarget } from './stub-devtools.testutil.js';

vi.setConfig({ testTimeout: 60_000 });

const packageRoot = fileURLToPath(new URL('../../', import.meta.url));
const startShPath = path.join(packageRoot, 'start.sh');
const helperPath = path.join(packageRoot, 'scripts', 'dashboard-window.mjs');

const roots: string[] = [];
let devtools: StubDevTools;
let app: StubApp;

beforeEach(async () => {
  devtools = await startStubDevTools();
  app = await startStubApp();
});

afterEach(async () => {
  await devtools.close();
  await app.close();
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

/** A private copy of the launcher folder: start.sh, the helper when there is one, and the real node_modules (for `ws`). */
function box() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'botboy-window-'));
  roots.push(root);
  const dir = path.join(root, 'app');
  const home = path.join(root, 'home');
  const stubs = path.join(root, 'stubs');
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(stubs, { recursive: true });
  fs.copyFileSync(startShPath, path.join(dir, 'start.sh'));
  if (fs.existsSync(helperPath)) fs.copyFileSync(helperPath, path.join(dir, 'scripts', 'dashboard-window.mjs'));
  // start.sh runs it on every start; with this private HOME it finds nothing to import.
  fs.copyFileSync(path.join(packageRoot, 'scripts', 'import-credentials.sh'), path.join(dir, 'scripts', 'import-credentials.sh'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x' }));
  fs.symlinkSync(path.join(packageRoot, 'node_modules'), path.join(dir, 'node_modules'));

  const chromeLog = path.join(root, 'chrome.log');
  fs.writeFileSync(chromeLog, '');
  // "Chrome": records its arguments and, like Chrome, opens a (blank) page for an --app window.
  const chrome = path.join(stubs, 'chrome');
  fs.writeFileSync(chrome, [
    '#!/bin/sh',
    `echo "$*" >> '${chromeLog}'`,
    'for arg in "$@"; do case "$arg" in --app=*) curl -s --max-time 2 -G "$STUB_CDP_ORIGIN/__spawn" --data-urlencode "url=about:blank" >/dev/null;; esac; done',
    'exit 0',
    '',
  ].join('\n'), { mode: 0o755 });
  const lsof = path.join(stubs, 'lsof');
  fs.writeFileSync(lsof, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  const ui = stubUiTools(root);

  const env = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => {
    const base: NodeJS.ProcessEnv = { ...process.env };
    for (const key of ['BOTBOY_NATIVE_REEXEC', 'BOTBOY_REEXEC_FROM', 'npm_lifecycle_event']) delete base[key];
    return {
      ...base,
      ...ui.env,
      HOME: home,
      PPT_LOG_FILE: path.join(root, 'launcher.log'),
      PPT_PID_FILE: path.join(root, 'ppt.pid'),
      PPT_STARTUP_SAFETY_BLOCK: path.join(root, 'safety-block.json'),
      PPT_SHUTDOWN_RECEIPT_DIR: root,
      BOTBOY_NO_ARCH_REEXEC: '1',
      BOTBOY_TEST_NODE_BIN: process.execPath,
      BOTBOY_TEST_CHROME_BIN: chrome,
      BOTBOY_TEST_LSOF_BIN: lsof,
      BOTBOY_TEST_CDP_ORIGIN: devtools.origin,
      BOTBOY_TEST_APP_ORIGIN: app.origin,
      BOTBOY_WINDOW_WAIT_SECONDS: '20', // the production wait; it ends the moment the window appears (a brand-new script can start slowly when the Mac is busy)
      STUB_CDP_ORIGIN: devtools.origin,
      ...extra,
    };
  };

  /** Run start.sh --open-window in `focus` (Dock click) or `fresh` (start / restart) mode. */
  const launch = (mode: 'focus' | 'fresh', extra: Record<string, string> = {}) => new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const environment = env({ ...(mode === 'fresh' ? { BOTBOY_TEST_OPEN_WINDOW_MODE: 'fresh' } : {}), ...extra });
    // Never a real port: the stand-ins' addresses must be in place, and must be loopback ephemeral ports.
    for (const name of ['BOTBOY_TEST_CDP_ORIGIN', 'BOTBOY_TEST_APP_ORIGIN']) {
      const port = Number(new URL(String(environment[name])).port);
      if (!port || port === 9222 || port === 7778) throw new Error(`${name} must be a stand-in, not a real port`);
    }
    const child = spawn('/bin/bash', [path.join(dir, 'start.sh'), '--open-window'], { cwd: dir, env: environment });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`start.sh did not finish\n${stdout}\n${stderr}`)); }, 45_000);
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });

  const chromeCalls = () => fs.readFileSync(chromeLog, 'utf8').split('\n').filter(Boolean);
  return { root, dir, home, launch, chromeCalls, ui };
}

const page = (id: string, url: string, extra: Partial<StubTarget> = {}): StubTarget => ({ id, type: 'page', url, ...extra });

describe('start.sh › open_dashboard_window: the dashboard page that is alive', () => {
  it('focus (Dock click): raises the existing dashboard window and opens nothing', async () => {
    devtools.add(page('dash', `${app.origin}/#/today`));
    const b = box();
    const run = await b.launch('focus');
    expect(run.code).toBe(0);
    expect(run.stdout).toContain('Dashboard window focused');
    expect(devtools.events).toContain('activate dash');
    expect(devtools.events.filter((event) => event.startsWith('close') || event.startsWith('spawn'))).toEqual([]);
    expect(b.chromeCalls()).toEqual([]);
    expect(b.ui.calls()).toEqual([]);
  });

  it('fresh (start or restart): closes the old window and opens one new window at the same route', async () => {
    devtools.add(page('dash', `${app.origin}/#/projects`));
    const b = box();
    const run = await b.launch('fresh');
    expect(run.code).toBe(0);
    expect(devtools.events).toContain('close dash');
    expect(b.chromeCalls()).toHaveLength(1);
    expect(b.chromeCalls()[0]).toContain(`--app=${app.origin}/#/projects`);
    expect(devtools.targets.filter((target) => target.type === 'page')).toHaveLength(1); // one window, not two
    expect(run.stdout).toContain('Dashboard ready');
  });

  it('with no dashboard window at all, opens exactly one', async () => {
    const b = box();
    const run = await b.launch('focus');
    expect(run.code).toBe(0);
    expect(b.chromeCalls()).toHaveLength(1);
    expect(b.chromeCalls()[0]).toContain(`--app=${app.origin}`);
    expect(devtools.events.filter((event) => event.startsWith('close'))).toEqual([]);
  });

  it('never closes or activates a tab that is not the dashboard', async () => {
    devtools.add(page('news', 'https://news.example.com/story?next=http://localhost:1/'));
    devtools.add(page('other-local', 'http://localhost:3000/'));
    devtools.add(page('blank', 'about:blank'));
    devtools.add(page('dash', `${app.origin}/#/today`));
    const b = box();
    const run = await b.launch('fresh');
    expect(run.code).toBe(0);
    expect(devtools.events.filter((event) => event.startsWith('close')).sort()).toEqual(['close dash']);
    for (const id of ['news', 'other-local', 'blank']) {
      expect(devtools.targets.find((target) => target.id === id)).toBeDefined();
    }
    expect(devtools.events.filter((event) => event.startsWith('activate') || event.startsWith('navigate'))).toEqual([]);
  });
});

// Chrome's own words for a page that could not load (a stopped server): the tab runs no JavaScript, so
// nothing inside it can recover; its DevTools URL is chrome-error://, and the address that failed is
// the frame's `unreachableUrl`. Such a tab is the dashboard window only when that address is BotBoy's.
const ERROR_URL = 'chrome-error://chromewebdata/';
const errorPage = (id: string, unreachableUrl: string | undefined, title = 'localhost', extra: Partial<StubTarget> = {}): StubTarget =>
  ({ id, type: 'page', url: ERROR_URL, title, ...(unreachableUrl ? { unreachableUrl } : {}), ...extra });
const navigations = () => devtools.events.filter((event) => event.startsWith('navigate'));
const spawns = () => devtools.events.filter((event) => event.startsWith('spawn'));

describe('start.sh › open_dashboard_window: the dashboard tab stuck on Chrome\'s error page', () => {
  it('focus (Dock click): loads the dashboard in that same tab, on the same route, and opens no second window', async () => {
    devtools.add(errorPage('dead', `${app.origin}/#/settings/workplace`));
    const b = box();
    const run = await b.launch('focus');
    expect(run.code).toBe(0);
    expect(navigations()).toEqual([`navigate dead ${app.origin}/#/settings/workplace`]);
    expect(devtools.events).toContain('activate dead');
    expect(spawns()).toEqual([]);
    expect(b.chromeCalls()).toEqual([]);
    expect(devtools.events.filter((event) => event.startsWith('close'))).toEqual([]);
    expect(devtools.targets.filter((target) => target.type === 'page')).toHaveLength(1);
    expect(run.stdout).toContain('Dashboard window reloaded');
    expect(run.stdout).not.toContain('Dashboard ready'); // a Dock click is not a start
    expect(b.ui.calls()).toEqual([]);
  });

  it('fresh (start or restart): the same tab is reused, not closed and not joined by a second window', async () => {
    devtools.add(errorPage('dead', `${app.origin}/#/projects`));
    const b = box();
    const run = await b.launch('fresh');
    expect(run.code).toBe(0);
    expect(navigations()).toEqual([`navigate dead ${app.origin}/#/projects`]);
    expect(spawns()).toEqual([]);
    expect(b.chromeCalls()).toEqual([]);
    expect(devtools.events.filter((event) => event.startsWith('close'))).toEqual([]);
    expect(devtools.targets.filter((target) => target.type === 'page')).toHaveLength(1);
    // A start or restart still ends with the line docs/TEAMMATE_SETUP.md and the release README promise.
    expect(run.stdout).toContain('✅ Dashboard window reloaded');
    expect(run.stdout).toContain(`✅ Dashboard ready: ${app.origin}\n`);
    expect(run.stdout.indexOf('Dashboard window reloaded')).toBeLessThan(run.stdout.indexOf('Dashboard ready'));
  });

  it('carries over the route (the hash) and nothing else: no path, no query, no sign-in code', async () => {
    devtools.add(errorPage('dead', `http://127.0.0.1:${app.port}/api/gmail-sync/oauth/callback?code=SECRET-CODE&state=x#/connections/gmail-sync`));
    const b = box();
    const run = await b.launch('focus');
    expect(run.code).toBe(0);
    // 127.0.0.1 is BotBoy's own address too; the tab comes back on the canonical one.
    expect(navigations()).toEqual([`navigate dead ${app.origin}/#/connections/gmail-sync`]);
    expect(devtools.events.join('\n')).not.toContain('SECRET-CODE');
  });

  it('a failed address without a route loads the dashboard root', async () => {
    devtools.add(errorPage('dead', `${app.origin}/`));
    const b = box();
    await b.launch('focus');
    expect(navigations()).toEqual([`navigate dead ${app.origin}/`]);
  });

  it('leaves another site\'s error page completely alone (it is not even looked at) and still opens the dashboard', async () => {
    devtools.add(errorPage('site', 'https://news.example.com/story', 'news.example.com'));
    const b = box();
    const run = await b.launch('focus');
    expect(run.code).toBe(0);
    expect(devtools.events.filter((event) => /^(frameTree|navigate|activate|close|cdp) site/.test(event))).toEqual([]);
    expect(spawns()).toHaveLength(1);
    expect(b.chromeCalls()).toHaveLength(1);
    expect(devtools.targets.find((target) => target.id === 'site')).toBeDefined();
  });

  it('looks at, but never moves, the error page of another local port', async () => {
    devtools.add(errorPage('other', 'http://localhost:3000/', 'localhost'));
    const b = box();
    const run = await b.launch('focus');
    expect(run.code).toBe(0);
    expect(devtools.events.filter((event) => /^(navigate|activate|close) other/.test(event))).toEqual([]);
    expect(spawns()).toHaveLength(1);
    expect(devtools.targets.find((target) => target.id === 'other')!.unreachableUrl).toBe('http://localhost:3000/');
  });

  it.each([
    ['a port that only starts the same', (p: number) => `http://localhost:${p}0/`],
    ['another host that contains the name', (p: number) => `http://evil-localhost:${p}/`],
    ['a longer host name', (p: number) => `http://localhost:${p}.evil.example/`],
    ['an https address on the port', (p: number) => `https://localhost:${p}/`],
    ['the next port', (p: number) => `http://localhost:${p + 1}/`],
    ['a host that carries it in the path', (p: number) => `https://example.com/localhost:${p}/`],
    ['an address that is not a URL', () => 'not a url'],
  ])('does not take %s for the dashboard', async (_label, failed) => {
    devtools.add(errorPage('lookalike', failed(app.port)));
    const b = box();
    const run = await b.launch('focus');
    expect(run.code).toBe(0);
    expect(devtools.events.filter((event) => /^(navigate|activate|close) lookalike/.test(event))).toEqual([]);
    expect(spawns()).toHaveLength(1);
  });

  it('does not touch an error page that does not say what failed', async () => {
    devtools.add(errorPage('mute', undefined));
    const b = box();
    await b.launch('focus');
    expect(devtools.events.filter((event) => /^(navigate|activate|close) mute/.test(event))).toEqual([]);
    expect(spawns()).toHaveLength(1);
  });

  it('only tabs of type page are ever touched', async () => {
    devtools.add(errorPage('frame', `${app.origin}/#/today`, 'localhost', { type: 'iframe' }));
    devtools.add({ id: 'worker', type: 'service_worker', url: `${app.origin}/sw.js` });
    devtools.add({ id: 'ext', type: 'background_page', url: `${app.origin}/#/today` });
    const b = box();
    const run = await b.launch('fresh');
    expect(run.code).toBe(0);
    expect(devtools.events.filter((event) => /^(frameTree|navigate|activate|close|cdp) (frame|worker|ext)/.test(event))).toEqual([]);
    expect(spawns()).toHaveLength(1);
  });

  it('a live dashboard page wins: it is focused as before and the error page is left as it is', async () => {
    devtools.add(errorPage('dead', `${app.origin}/#/today`));
    devtools.add(page('dash', `${app.origin}/#/projects`));
    const b = box();
    const run = await b.launch('focus');
    expect(run.code).toBe(0);
    expect(devtools.events).toContain('activate dash');
    expect(navigations()).toEqual([]);
    expect(spawns()).toEqual([]);
  });

  it('fresh with a live page AND an error page: the live page is replaced as before, the error page is not touched', async () => {
    devtools.add(errorPage('dead', `${app.origin}/#/today`));
    devtools.add(page('dash', `${app.origin}/#/projects`));
    const b = box();
    const run = await b.launch('fresh');
    expect(run.code).toBe(0);
    expect(devtools.events).toContain('close dash');
    expect(navigations()).toEqual([]);
    expect(devtools.events.some((event) => event.includes('frameTree dead'))).toBe(false);
    expect(b.chromeCalls()).toHaveLength(1);
    expect(b.chromeCalls()[0]).toContain(`--app=${app.origin}/#/projects`);
  });

  it('takes a live page on 127.0.0.1 for the dashboard too', async () => {
    devtools.add(page('loop', `http://127.0.0.1:${app.port}/#/today`));
    const b = box();
    const run = await b.launch('focus');
    expect(run.code).toBe(0);
    expect(devtools.events).toContain('activate loop');
    expect(spawns()).toEqual([]);
  });

  it('when the reload is refused (the server is gone again), opens a window the old way instead of claiming success', async () => {
    devtools.add(errorPage('dead', `${app.origin}/#/today`, 'localhost', { navigateError: 'net::ERR_CONNECTION_REFUSED' }));
    const b = box();
    const run = await b.launch('focus');
    expect(run.code).toBe(0);
    expect(run.stdout).not.toContain('Dashboard window reloaded');
    expect(spawns()).toHaveLength(1);
  });

  it('a tab that vanished while it was being looked at is ignored', async () => {
    devtools.add(errorPage('gone', `${app.origin}/#/today`, 'localhost', { frameTreeError: true }));
    const b = box();
    const run = await b.launch('focus');
    expect(run.code).toBe(0);
    expect(navigations()).toEqual([]);
    expect(spawns()).toHaveLength(1);
  });
});

describe('what start.sh needs from scripts/ reaches the teammates', () => {
  it('ships every script that start.sh runs from the install folder (a script missing there is a dead reference)', () => {
    const shipped = releaseAllowlist();
    const script = fs.readFileSync(startShPath, 'utf8');
    const used = Array.from(new Set(Array.from(script.matchAll(/\$PROJ_DIR\/(scripts\/[A-Za-z0-9._-]+)/g)).map((match) => match[1])));
    expect(used).toContain('scripts/dashboard-window.mjs');
    for (const file of used) expect(shipped, `${file} is run by start.sh but scripts/release.sh does not ship it`).toContain(file);
  });
});
