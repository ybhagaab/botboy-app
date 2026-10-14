#!/usr/bin/env node
// Which Chrome page is BotBoy's dashboard window, and bringing back one that Chrome gave up on.
// Run by start.sh › open_dashboard_window (a start, a restart, and a Dock click all end there).
//
//   node scripts/dashboard-window.mjs find   --cdp <origin> --app <origin>
//       prints "<id><TAB><url>" of the first dashboard page that is alive, or nothing
//   node scripts/dashboard-window.mjs revive --cdp <origin> --app <origin>
//       a dashboard tab sitting on Chrome's "This site can't be reached" page runs no JavaScript, so
//       nothing in it can recover when the server comes back. This loads the dashboard in that same
//       tab (same route), raises it, and prints its id. Prints nothing when there is no such tab or
//       the reload was refused; start.sh then opens a window the old way.
//
// Which tabs are "the dashboard" (docs/maps/teammate-install-release.md › Dashboard window): only a
// DevTools target of type `page`, and either
//   - its URL is BotBoy's own address (http, host localhost or 127.0.0.1, BotBoy's port), or
//   - its URL is Chrome's error page (chrome-error://) AND Chrome says the address that failed to
//     load (the frame's `unreachableUrl`) is BotBoy's own address.
// Nothing else is ever moved, closed, raised or navigated. An error page is looked at (one read-only
// Page.getFrameTree) only when its title looks like a local host or is empty, so another site's
// error page is not even opened. Both addresses must be on this Mac's loopback.
//
// Exit status is 0 whatever was found (an empty answer is an answer); 2 is a usage error. Notes for
// support go to stderr, which start.sh appends to its log.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const REQUEST_TIMEOUT_MS = 3000;
const SESSION_TIMEOUT_MS = 4000;
const MAX_ERROR_PAGES_LOOKED_AT = 8;
const ERROR_PAGE_PREFIX = 'chrome-error://';

function parseUrl(value) {
  try {
    return new URL(String(value));
  } catch {
    return null;
  }
}

function isLoopbackHost(hostname) {
  const host = String(hostname).toLowerCase().replace(/^\[|\]$/g, '');
  return host === 'localhost' || host === '::1' || /^127(\.\d{1,3}){3}$/.test(host);
}

/** BotBoy's own address as the launcher knows it, e.g. http://localhost:7778. Null when it is not a loopback http address with a port. */
export function parseAppOrigin(value) {
  const url = parseUrl(value);
  if (!url || url.protocol !== 'http:' || !url.port || !isLoopbackHost(url.hostname)) return null;
  return { origin: `http://${url.host}`, port: url.port, hosts: new Set([`localhost:${url.port}`, `127.0.0.1:${url.port}`]) };
}

/** The debug Chrome's DevTools address. Null unless it is an http address on this Mac's loopback. */
export function parseCdpOrigin(value) {
  const url = parseUrl(value);
  if (!url || url.protocol !== 'http:' || !url.port || !isLoopbackHost(url.hostname)) return null;
  return `http://${url.host}`;
}

/** True when `value` is an address of BotBoy's dashboard: http, localhost or 127.0.0.1, BotBoy's port, nothing longer or looser. */
export function isDashboardUrl(value, app) {
  const url = parseUrl(value);
  return Boolean(url && url.protocol === 'http:' && app.hosts.has(url.host));
}

/** Where to reload the dashboard for a failed address: BotBoy's own origin and the route (the hash), nothing else. */
export function dashboardUrlFor(failedUrl, app) {
  const url = parseUrl(failedUrl);
  return `${app.origin}/${url ? url.hash : ''}`;
}

/** An error page worth opening: its title is empty or names a local host. Another site's error page is left unopened. */
export function mayBeOurErrorPage(target) {
  if (!target || target.type !== 'page' || !String(target.url ?? '').startsWith(ERROR_PAGE_PREFIX)) return false;
  const title = String(target.title ?? '').trim().toLowerCase();
  if (!title) return true;
  const withoutScheme = title.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
  const authority = withoutScheme.split(/[/?#]/)[0];
  const host = authority.startsWith('[') ? authority.slice(1, authority.indexOf(']')) : authority.replace(/:\d*$/, '');
  return isLoopbackHost(host);
}

async function listTargets(cdp) {
  const response = await fetch(`${cdp}/json/list`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`DevTools answered ${response.status}`);
  const targets = await response.json();
  return Array.isArray(targets) ? targets : [];
}

/** One DevTools connection to one page target. Every call is bounded; the socket is always closed. */
async function withSession(webSocketUrl, work) {
  const socket = new WebSocket(webSocketUrl, { perMessageDeflate: false, handshakeTimeout: SESSION_TIMEOUT_MS });
  const pending = new Map();
  let nextId = 0;
  const failAll = (error) => {
    for (const { reject } of pending.values()) reject(error);
    pending.clear();
  };
  socket.on('message', (raw) => {
    let message;
    try { message = JSON.parse(String(raw)); } catch { return; }
    const call = pending.get(message.id);
    if (!call) return;
    pending.delete(message.id);
    if (message.error) call.reject(new Error(String(message.error.message ?? 'DevTools error')));
    else call.resolve(message.result ?? {});
  });
  socket.on('error', (error) => failAll(error));
  socket.on('close', () => failAll(new Error('DevTools connection closed')));
  const timer = setTimeout(() => failAll(new Error('DevTools did not answer in time')), SESSION_TIMEOUT_MS);
  try {
    await new Promise((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });
    const send = (method, params = {}) => new Promise((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params }), (error) => {
        if (error) {
          pending.delete(id);
          reject(error);
        }
      });
    });
    return await work(send);
  } finally {
    clearTimeout(timer);
    socket.terminate();
  }
}

/** The first dashboard page that is alive: a `page` target on BotBoy's own address. */
export function pickLiveDashboard(targets, app) {
  return targets.find((target) => target && target.type === 'page' && isDashboardUrl(target.url, app)) ?? null;
}

export async function findLive(cdp, app) {
  const target = pickLiveDashboard(await listTargets(cdp), app);
  return target ? { id: String(target.id), url: String(target.url) } : null;
}

/**
 * Load the dashboard in the first tab that sits on Chrome's error page for BotBoy's address.
 * Returns that tab's id, or null when there is none (or Chrome refused the reload).
 */
export async function revive(cdp, app, log = () => {}) {
  const candidates = (await listTargets(cdp))
    .filter((target) => mayBeOurErrorPage(target) && target.webSocketDebuggerUrl)
    .slice(0, MAX_ERROR_PAGES_LOOKED_AT);
  for (const target of candidates) {
    const id = String(target.id);
    try {
      const outcome = await withSession(String(target.webSocketDebuggerUrl), async (send) => {
        const { frameTree } = await send('Page.getFrameTree');
        const failed = frameTree?.frame?.unreachableUrl;
        // Chrome's own record of what failed to load is the only proof this error page is ours.
        if (!failed || !isDashboardUrl(failed, app)) return { ours: false };
        const url = dashboardUrlFor(failed, app);
        const result = await send('Page.navigate', { url });
        return { ours: true, url, errorText: result.errorText ? String(result.errorText) : '' };
      });
      if (!outcome.ours) continue;
      if (outcome.errorText) {
        log(`could not reload tab ${id} on ${outcome.url}: ${outcome.errorText}`);
        return null;
      }
      await fetch(`${cdp}/json/activate/${encodeURIComponent(id)}`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }).catch(() => {});
      log(`reloaded the dashboard in tab ${id} (was on Chrome's error page) at ${outcome.url}`);
      return id;
    } catch (error) {
      log(`skipped tab ${id}: ${error instanceof Error ? error.message : error}`);
    }
  }
  return null;
}

function option(args, name) {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
}

async function main(args) {
  const command = args[0];
  const cdp = parseCdpOrigin(option(args, '--cdp'));
  const app = parseAppOrigin(option(args, '--app'));
  if (!['find', 'revive'].includes(command) || !cdp || !app) {
    process.stderr.write('usage: dashboard-window.mjs <find|revive> --cdp http://127.0.0.1:<port> --app http://localhost:<port>\n');
    return 2;
  }
  const log = (message) => process.stderr.write(`dashboard-window: ${message}\n`);
  try {
    if (command === 'find') {
      const live = await findLive(cdp, app);
      if (live) process.stdout.write(`${live.id}\t${live.url}`);
    } else {
      const id = await revive(cdp, app, log);
      if (id) process.stdout.write(id);
    }
  } catch (error) {
    // An unreachable DevTools endpoint is an empty answer, not a failure of the launcher.
    log(`${command}: ${error instanceof Error ? error.message : error}`);
  }
  return 0;
}

const entry = process.argv[1];
if (entry && fs.realpathSync(entry) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
