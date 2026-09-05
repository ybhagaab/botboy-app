/**
 * Self-eyes (SELF_EYES_PLAN.md) — BotBoy observes its OWN rendered UI.
 *
 * Chart-fix incident closure: BotBoy shipped a correct UI fix but had no
 * way to see its own render, so verification rode on the owner's eyes and
 * a stale tab. These primitives give the agent structural sight — element
 * geometry, computed styles, console errors, and owner-viewable
 * screenshots — over a SCRATCH TAB of the app.
 *
 * Identity boundaries (enforced structurally, not by model discretion):
 *  - EYES, NOT HANDS: observe-only; no clicks, no typing, no navigation
 *    of existing tabs.
 *  - SCRATCH-TAB ISOLATION: every observation creates its own tab and
 *    closes it in a finally — the owner's live tab, scroll, and session
 *    are never touched (no Target.activateTarget anywhere here).
 *  - PRIVACY SCOPE: the debug Chrome carries the owner's whole browsing
 *    session. Only `http://localhost:7778` targets can be created or
 *    observed — `normalizeAppRoute` rejects anything else, and no API in
 *    this module accepts a full URL or an existing target id.
 *  - NO ARBITRARY JS: evaluated expressions are code-built from a fixed
 *    op set; the only model-supplied fragment (the CSS selector) is
 *    JSON-escaped into the expression.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import WebSocket from 'ws';

const CDP_ENDPOINT = 'http://127.0.0.1:9222';
const APP_ORIGIN = 'http://localhost:7778';
const SHOT_DIR = path.join(os.homedir(), '.personal-productivity-tracker', 'self-eyes');
const READY_TIMEOUT_MS = 12_000;
const DEFAULT_SETTLE_MS = 1_800;
const MAX_SETTLE_MS = 8_000;
const MAX_SAMPLED_NODES = 10;

/**
 * App-origin route guard. Accepts '/dashboards', '#/doc/x', 'dashboards';
 * rejects full URLs, foreign origins, and junk. Returns the hash route
 * (leading '/').
 */
export function normalizeAppRoute(route: unknown): string {
  let cleaned = String(route ?? '').trim();
  if (cleaned === '') cleaned = '/';
  if (/:\/\//.test(cleaned) || cleaned.includes('..')) {
    throw new Error(`route must be an app hash route like "/dashboards" — full URLs are not allowed (got "${cleaned.slice(0, 80)}")`);
  }
  cleaned = cleaned.replace(/^#+/, '');
  if (!cleaned.startsWith('/')) cleaned = `/${cleaned}`;
  if (!/^[\w\-/?=&.%]*$/.test(cleaned.slice(1))) {
    throw new Error(`route contains unsupported characters: "${cleaned.slice(0, 80)}"`);
  }
  return cleaned;
}

export function appUrlForRoute(route: unknown): string {
  const normalized = normalizeAppRoute(route);
  return normalized === '/' ? `${APP_ORIGIN}/` : `${APP_ORIGIN}/#${normalized}`;
}

/** Code-built inspection expression — the selector is the ONLY foreign fragment, JSON-escaped. */
export function buildInspectExpression(selector: string): string {
  const escaped = JSON.stringify(String(selector ?? ''));
  return `(function () {
    var sel = ${escaped};
    var all = document.querySelectorAll(sel);
    var sampled = Array.prototype.slice.call(all, 0, ${MAX_SAMPLED_NODES}).map(function (node) {
      var rect = node.getBoundingClientRect();
      var cs = getComputedStyle(node);
      return {
        rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
        styles: { display: cs.display, visibility: cs.visibility, position: cs.position, overflow: cs.overflow, width: cs.width, height: cs.height },
        text: (node.textContent || '').trim().slice(0, 120)
      };
    });
    return JSON.stringify({ matches: all.length, sampled: sampled, viewport: { width: window.innerWidth, height: window.innerHeight }, readyState: document.readyState });
  })()`;
}

// ── CDP session over one target websocket ──

class CdpSession {
  private ws: WebSocket;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  readonly events: Array<{ method: string; params: any }> = [];

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.on('message', data => {
      try {
        const message = JSON.parse(String(data));
        if (message.id && this.pending.has(message.id)) {
          const waiter = this.pending.get(message.id)!;
          this.pending.delete(message.id);
          if (message.error) waiter.reject(new Error(message.error.message || 'CDP error'));
          else waiter.resolve(message.result);
        } else if (message.method) {
          this.events.push({ method: message.method, params: message.params });
          if (this.events.length > 400) this.events.shift();
        }
      } catch { /* non-JSON frame — ignore */ }
    });
  }

  static connect(wsUrl: string, timeoutMs = 8_000): Promise<CdpSession> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      const timer = setTimeout(() => { ws.close(); reject(new Error('CDP connect timeout')); }, timeoutMs);
      ws.on('open', () => { clearTimeout(timer); resolve(new CdpSession(ws)); });
      ws.on('error', error => { clearTimeout(timer); reject(error instanceof Error ? error : new Error(String(error))); });
    });
  }

  send(method: string, params: Record<string, unknown> = {}, timeoutMs = 10_000): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} timeout`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: value => { clearTimeout(timer); resolve(value); },
        reject: error => { clearTimeout(timer); reject(error); },
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  close(): void {
    try { this.ws.close(); } catch { /* already closed */ }
  }
}

async function cdpHttp(pathname: string, method: 'GET' | 'PUT' = 'GET'): Promise<any> {
  const response = await fetch(`${CDP_ENDPOINT}${pathname}`, { method });
  const text = await response.text();
  if (!response.ok) throw new Error(`CDP ${pathname}: HTTP ${response.status} ${text.slice(0, 120)}`);
  try { return JSON.parse(text); } catch { return text; }
}

async function createScratchTab(): Promise<{ id: string; webSocketDebuggerUrl: string }> {
  let target: any;
  try {
    // Chrome ≥111 requires PUT for /json/new; older accepted GET.
    target = await cdpHttp('/json/new?about:blank', 'PUT');
  } catch {
    target = await cdpHttp('/json/new?about:blank', 'GET');
  }
  if (!target?.webSocketDebuggerUrl) throw new Error('scratch tab created without a debugger URL');
  return { id: target.id, webSocketDebuggerUrl: target.webSocketDebuggerUrl };
}

async function evaluateJson(session: CdpSession, expression: string): Promise<any> {
  const result = await session.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (result?.exceptionDetails) {
    throw new Error(`page evaluation failed: ${result.exceptionDetails.text ?? 'exception'}`);
  }
  const value = result?.result?.value;
  if (typeof value === 'string') {
    try { return JSON.parse(value); } catch { return value; }
  }
  return value;
}

async function waitForReady(session: CdpSession): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < READY_TIMEOUT_MS) {
    try {
      const state = await session.send('Runtime.evaluate', { expression: 'document.readyState', returnByValue: true }, 4_000);
      if (state?.result?.value === 'complete') return;
    } catch { /* target mid-navigation — retry */ }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error(`app route did not reach readyState=complete within ${READY_TIMEOUT_MS / 1000}s`);
}

/**
 * The one lifecycle every observation rides: create scratch tab → attach →
 * enable Runtime+Log (console events collect from BOOT of the tab) →
 * navigate to the app route → readyState + settle → run the observation →
 * ALWAYS close the tab.
 */
export async function withScratchTab<T>(
  route: unknown,
  observe: (session: CdpSession) => Promise<T>,
  options: { settleMs?: number } = {},
): Promise<T> {
  const url = appUrlForRoute(route);
  try {
    await cdpHttp('/json/version');
  } catch {
    throw new Error('debug Chrome (CDP 9222) is unreachable — start.sh owns its lifecycle; a plain Chrome on that port cannot be used');
  }
  const tab = await createScratchTab();
  let session: CdpSession | null = null;
  try {
    session = await CdpSession.connect(tab.webSocketDebuggerUrl);
    await session.send('Runtime.enable');
    await session.send('Log.enable').catch(() => undefined);
    await session.send('Page.enable').catch(() => undefined);
    await session.send('Page.navigate', { url });
    await waitForReady(session);
    const settle = Math.min(MAX_SETTLE_MS, Math.max(0, Number(options.settleMs ?? DEFAULT_SETTLE_MS)));
    await new Promise(resolve => setTimeout(resolve, settle));
    return await observe(session);
  } finally {
    session?.close();
    await cdpHttp(`/json/close/${tab.id}`).catch(() => undefined);
  }
}

// ── The three observations ──

export interface UiInspectResult {
  route: string;
  selector: string;
  matches: number;
  sampled: Array<{ rect: { x: number; y: number; width: number; height: number }; styles: Record<string, string>; text: string }>;
  viewport: { width: number; height: number };
}

export async function uiInspect(route: unknown, selector: string, settleMs?: number): Promise<UiInspectResult> {
  const cleaned = String(selector ?? '').trim();
  if (!cleaned) throw new Error('selector required — a CSS selector like ".analytics-vega svg.marks"');
  const payload = await withScratchTab(route, session => evaluateJson(session, buildInspectExpression(cleaned)), { settleMs });
  return { route: normalizeAppRoute(route), selector: cleaned, ...payload };
}

export async function uiConsoleErrors(route: unknown, settleMs?: number): Promise<{ route: string; lines: string[] }> {
  const lines = await withScratchTab(route, async session => {
    return session.events
      .filter(event =>
        (event.method === 'Runtime.exceptionThrown')
        || (event.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(event.params?.type))
        || (event.method === 'Log.entryAdded' && ['error', 'warning'].includes(event.params?.entry?.level)))
      .map(event => {
        if (event.method === 'Runtime.exceptionThrown') {
          const detail = event.params?.exceptionDetails;
          return `exception: ${detail?.exception?.description ?? detail?.text ?? 'unknown'}`.slice(0, 300);
        }
        if (event.method === 'Runtime.consoleAPICalled') {
          const args = (event.params?.args ?? []).map((a: any) => a?.value ?? a?.description ?? '').join(' ');
          return `console.${event.params?.type}: ${args}`.slice(0, 300);
        }
        return `${event.params?.entry?.level}: ${event.params?.entry?.text ?? ''}`.slice(0, 300);
      })
      .slice(0, 40);
  }, { settleMs });
  return { route: normalizeAppRoute(route), lines };
}

export async function uiScreenshot(route: unknown, settleMs?: number): Promise<{ route: string; file: string; bytes: number }> {
  const data = await withScratchTab(route, async session => {
    const shot = await session.send('Page.captureScreenshot', { format: 'png' }, 15_000);
    return String(shot?.data ?? '');
  }, { settleMs });
  if (!data) throw new Error('screenshot returned no data');
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  const file = path.join(SHOT_DIR, `shot-${new Date().toISOString().replace(/[:.]/g, '-')}.png`);
  const buffer = Buffer.from(data, 'base64');
  fs.writeFileSync(file, buffer);
  return { route: normalizeAppRoute(route), file, bytes: buffer.length };
}
