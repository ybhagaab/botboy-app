import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';

const DEFAULT_CDP_ENDPOINT = 'http://127.0.0.1:9222';
const DEFAULT_ACTION_TIMEOUT_MS = 30_000;
const NAVIGATION_TIMEOUT_MS = 45_000;
const MAX_INSPECT_NODES = 200;
const MAX_PAGE_TEXT_CHARS = 20_000;
const MAX_HTML_CHARS = 16_000;

export type BrowserHandsAction =
  | 'list'
  | 'open'
  | 'navigate'
  | 'inspect'
  | 'click'
  | 'type'
  | 'select'
  | 'key'
  | 'scroll'
  | 'wait'
  | 'dialog'
  | 'close';

export interface BrowserElementTarget {
  ref?: string;
  selector?: string;
}

export interface BrowserHandsInput {
  action: BrowserHandsAction;
  tabId?: string;
  url?: string;
  target?: BrowserElementTarget;
  inspect?: {
    mode?: 'accessibility' | 'dom' | 'both';
    selector?: string;
    maxNodes?: number;
  };
  text?: string;
  values?: string[];
  replace?: boolean;
  key?: string;
  modifiers?: Array<'Alt' | 'Control' | 'Meta' | 'Shift'>;
  deltaX?: number;
  deltaY?: number;
  clickCount?: number;
  wait?: {
    kind?: 'load' | 'url' | 'selector' | 'text' | 'timeout';
    value?: string;
    state?: 'present' | 'visible' | 'hidden' | 'absent';
    timeoutMs?: number;
  };
  dialog?: {
    decision?: 'accept' | 'dismiss';
    promptText?: string;
  };
}

export interface BrowserReceipt {
  ok: boolean;
  action: BrowserHandsAction | 'screenshot';
  tabId?: string;
  url?: string;
  title?: string;
  readyState?: string;
  dialog?: { type: string; message: string; hasBrowserHandler?: boolean; handled?: 'accept' | 'dismiss'; open?: boolean };
  newTabs?: Array<{ tabId: string; url: string; title: string; openerTabId?: string }>;
  error?: { code: string; message: string; nextAction: string };
  [key: string]: unknown;
}

export interface BrowserScreenshotReceipt extends BrowserReceipt {
  action: 'screenshot';
  filePath?: string;
  fileUrl?: string;
  bytes?: number;
  width?: number;
  height?: number;
  fullPage?: boolean;
  clipped?: boolean;
  modelImageIncluded?: boolean;
}

export interface BrowserHandsService {
  initialize(): Promise<void>;
  execute(input: BrowserHandsInput): Promise<BrowserReceipt>;
  screenshot(input: { tabId?: string; fullPage?: boolean }): Promise<{
    receipt: BrowserScreenshotReceipt;
    dataUrl?: string;
  }>;
  ownsTarget(targetId: string): boolean;
}

export interface BrowserHandsOptions {
  cdpEndpoint?: string;
  stateDir?: string;
  filesDir?: string;
}

interface OwnedTab {
  tabId: string;
  targetId: string;
  openerTabId?: string;
  createdAt: string;
}

interface ChromeTarget {
  id: string;
  type: string;
  url: string;
  title?: string;
  webSocketDebuggerUrl?: string;
}

interface TargetInfo {
  targetId: string;
  type: string;
  title?: string;
  url?: string;
  openerId?: string;
}

interface StoredRegistry {
  version: 1;
  tabs: OwnedTab[];
}

interface RefState {
  documentToken: string;
  refs: Map<string, string>;
}

class BrowserHandsError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly nextAction: string,
  ) {
    super(message);
  }
}

class CdpSession {
  private nextId = 1;
  private closed = false;
  private readonly pending = new Map<number, {
    resolve: (value: any) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  readonly events: Array<{ method: string; params: any }> = [];

  private constructor(private readonly ws: WebSocket) {
    ws.on('message', data => {
      try {
        const message = JSON.parse(String(data));
        if (message.id && this.pending.has(message.id)) {
          const waiter = this.pending.get(message.id)!;
          this.pending.delete(message.id);
          clearTimeout(waiter.timer);
          if (message.error) waiter.reject(new Error(message.error.message || 'CDP error'));
          else waiter.resolve(message.result);
        } else if (message.method) {
          this.events.push({ method: message.method, params: message.params });
          if (this.events.length > 800) this.events.shift();
        }
      } catch {
        // Ignore non-JSON frames.
      }
    });
    ws.on('close', () => this.rejectPending(new Error('CDP socket closed')));
    ws.on('error', error => this.rejectPending(error instanceof Error ? error : new Error(String(error))));
  }

  static connect(wsUrl: string, timeoutMs = 8_000): Promise<CdpSession> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      const timer = setTimeout(() => {
        ws.close();
        reject(new Error('CDP connect timeout'));
      }, timeoutMs);
      ws.once('open', () => {
        clearTimeout(timer);
        resolve(new CdpSession(ws));
      });
      ws.once('error', error => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
  }

  send(method: string, params: Record<string, unknown> = {}, timeoutMs = 12_000): Promise<any> {
    if (this.closed || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('CDP socket is not open'));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} timeout`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.rejectPending(new Error('CDP session closed'));
    try { this.ws.close(); } catch { /* already closed */ }
  }

  private rejectPending(error: Error): void {
    for (const waiter of this.pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.pending.clear();
  }
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function clamp(value: unknown, minimum: number, maximum: number, fallback: number): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.min(maximum, Math.max(minimum, numeric)) : fallback;
}

function normalizeHttpUrl(value: unknown): string {
  const raw = String(value ?? '').trim();
  if (!raw) throw new BrowserHandsError('URL_REQUIRED', 'url is required', 'Pass the complete http:// or https:// URL.');
  let parsed: URL;
  try { parsed = new URL(raw); } catch {
    throw new BrowserHandsError('INVALID_URL', `Invalid URL: ${raw.slice(0, 160)}`, 'Pass a complete http:// or https:// URL.');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new BrowserHandsError('UNSUPPORTED_URL', `Only http(s) pages are supported (got ${parsed.protocol})`, 'Use an http:// or https:// page.');
  }
  return parsed.toString();
}

function pngDimensions(buffer: Buffer): { width: number; height: number } {
  if (buffer.length < 24 || buffer.toString('ascii', 1, 4) !== 'PNG') {
    throw new BrowserHandsError('INVALID_SCREENSHOT', 'Chrome returned invalid PNG data', 'Retry browser_screenshot.');
  }
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

function keyDefinition(input: string): { key: string; code: string; windowsVirtualKeyCode: number } {
  const named: Record<string, { key: string; code: string; windowsVirtualKeyCode: number }> = {
    Enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 },
    Tab: { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 },
    Escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
    Backspace: { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 },
    Delete: { key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 },
    ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 },
    ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 },
    ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 },
    ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 },
    Home: { key: 'Home', code: 'Home', windowsVirtualKeyCode: 36 },
    End: { key: 'End', code: 'End', windowsVirtualKeyCode: 35 },
    PageUp: { key: 'PageUp', code: 'PageUp', windowsVirtualKeyCode: 33 },
    PageDown: { key: 'PageDown', code: 'PageDown', windowsVirtualKeyCode: 34 },
    Space: { key: ' ', code: 'Space', windowsVirtualKeyCode: 32 },
  };
  if (named[input]) return named[input];
  if (input.length === 1) {
    const upper = input.toUpperCase();
    return {
      key: input,
      code: /[A-Z]/.test(upper) ? `Key${upper}` : input,
      windowsVirtualKeyCode: upper.charCodeAt(0),
    };
  }
  throw new BrowserHandsError('UNSUPPORTED_KEY', `Unsupported key: ${input}`, 'Use Enter, Tab, Escape, Backspace, Delete, an arrow/navigation key, Space, or one character.');
}

function modifierMask(modifiers: BrowserHandsInput['modifiers']): number {
  let mask = 0;
  for (const modifier of modifiers ?? []) {
    if (modifier === 'Alt') mask |= 1;
    if (modifier === 'Control') mask |= 2;
    if (modifier === 'Meta') mask |= 4;
    if (modifier === 'Shift') mask |= 8;
  }
  return mask;
}

function latestDialog(session: CdpSession): BrowserReceipt['dialog'] | undefined {
  let dialog: BrowserReceipt['dialog'] | undefined;
  for (const event of session.events) {
    if (event.method === 'Page.javascriptDialogOpening') {
      dialog = {
        type: String(event.params?.type ?? 'dialog'),
        message: String(event.params?.message ?? ''),
        hasBrowserHandler: Boolean(event.params?.hasBrowserHandler),
      };
    } else if (event.method === 'Page.javascriptDialogClosed') {
      dialog = undefined;
    }
  }
  return dialog;
}

function errorReceipt(action: BrowserHandsAction | 'screenshot', error: unknown, tabId?: string): BrowserReceipt {
  const normalized = error instanceof BrowserHandsError
    ? error
    : new BrowserHandsError('BROWSER_ACTION_FAILED', String((error as any)?.message ?? error), 'Inspect the tab state, then retry with a current ref or narrower selector.');
  return {
    ok: false,
    action,
    ...(tabId ? { tabId } : {}),
    error: { code: normalized.code, message: normalized.message, nextAction: normalized.nextAction },
  };
}

export function createBrowserHandsService(options: BrowserHandsOptions = {}): BrowserHandsService {
  const cdpEndpoint = options.cdpEndpoint ?? DEFAULT_CDP_ENDPOINT;
  const stateDir = options.stateDir ?? path.join(os.homedir(), '.personal-productivity-tracker', 'browser-hands');
  const filesDir = options.filesDir ?? path.join(os.homedir(), '.personal-productivity-tracker', 'files', 'browser-hands');
  const registryFile = path.join(stateDir, 'tabs.json');
  const tabs = new Map<string, OwnedTab>();
  const targetToTab = new Map<string, string>();
  const refs = new Map<string, RefState>();
  const queues = new Map<string, Promise<void>>();
  let initializePromise: Promise<void> | null = null;

  async function cdpHttp(pathname: string, method: 'GET' | 'PUT' = 'GET'): Promise<any> {
    const response = await fetch(`${cdpEndpoint}${pathname}`, { method });
    const text = await response.text();
    if (!response.ok) throw new Error(`CDP ${pathname}: HTTP ${response.status} ${text.slice(0, 160)}`);
    try { return JSON.parse(text); } catch { return text; }
  }

  async function listChromeTargets(): Promise<ChromeTarget[]> {
    const raw = await cdpHttp('/json/list');
    return Array.isArray(raw) ? raw.filter(target => target?.type === 'page' && target?.id) : [];
  }

  function rebuildTargetIndex(): void {
    targetToTab.clear();
    for (const entry of tabs.values()) targetToTab.set(entry.targetId, entry.tabId);
  }

  function saveRegistry(): void {
    fs.mkdirSync(stateDir, { recursive: true });
    const payload: StoredRegistry = { version: 1, tabs: [...tabs.values()] };
    const temporary = `${registryFile}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(payload, null, 2), { mode: 0o600 });
    fs.renameSync(temporary, registryFile);
  }

  function forgetTab(tabId: string): void {
    const entry = tabs.get(tabId);
    if (entry) targetToTab.delete(entry.targetId);
    tabs.delete(tabId);
    refs.delete(tabId);
    saveRegistry();
  }

  async function reconcile(): Promise<Map<string, ChromeTarget>> {
    const targets = await listChromeTargets();
    const byId = new Map(targets.map(target => [target.id, target]));
    let changed = false;
    for (const [tabId, entry] of tabs) {
      if (!byId.has(entry.targetId)) {
        tabs.delete(tabId);
        refs.delete(tabId);
        changed = true;
      }
    }
    if (changed) {
      rebuildTargetIndex();
      saveRegistry();
    }
    return byId;
  }

  async function initialize(): Promise<void> {
    if (!initializePromise) {
      initializePromise = (async () => {
        await cdpHttp('/json/version').catch(() => {
          throw new BrowserHandsError('DEBUG_CHROME_UNREACHABLE', 'Debug Chrome on CDP port 9222 is unreachable', 'Start BotBoy through start.sh, then retry.');
        });
        fs.mkdirSync(stateDir, { recursive: true });
        fs.mkdirSync(filesDir, { recursive: true });
        try {
          const parsed = JSON.parse(fs.readFileSync(registryFile, 'utf8')) as StoredRegistry;
          if (parsed?.version === 1 && Array.isArray(parsed.tabs)) {
            for (const entry of parsed.tabs) {
              if (entry?.tabId && entry?.targetId) tabs.set(entry.tabId, entry);
            }
          }
        } catch {
          // First run or malformed stale registry: start empty and reconcile.
        }
        rebuildTargetIndex();
        await reconcile();
        saveRegistry();
      })();
    }
    try {
      await initializePromise;
    } catch (error) {
      initializePromise = null;
      throw error;
    }
  }

  async function createBlankTarget(): Promise<ChromeTarget> {
    let created: any;
    try {
      created = await cdpHttp('/json/new?about:blank', 'PUT');
    } catch {
      created = await cdpHttp('/json/new?about:blank', 'GET');
    }
    if (!created?.id || !created?.webSocketDebuggerUrl) {
      throw new BrowserHandsError('TARGET_CREATE_FAILED', 'Chrome created a tab without a debuggable target', 'Retry after checking CDP /json/version.');
    }
    return created as ChromeTarget;
  }

  async function resolveOwnedTarget(tabId: string): Promise<{ entry: OwnedTab; target: ChromeTarget }> {
    const entry = tabs.get(tabId);
    if (!entry) {
      throw new BrowserHandsError('TAB_NOT_FOUND', `Unknown browser tabId: ${tabId}`, 'Call browser_hands action=list and use one of the returned tabIds, or open a new tab.');
    }
    const targets = await reconcile();
    const current = targets.get(entry.targetId);
    if (!current?.webSocketDebuggerUrl) {
      if (!current) forgetTab(tabId);
      throw new BrowserHandsError('TAB_CLOSED', `Browser tab ${tabId} is no longer available`, 'Call action=list, then open or use an available tab.');
    }
    return { entry, target: current };
  }

  async function withSession<T>(tabId: string, operation: (session: CdpSession, entry: OwnedTab, target: ChromeTarget) => Promise<T>): Promise<T> {
    const { entry, target } = await resolveOwnedTarget(tabId);
    const session = await CdpSession.connect(target.webSocketDebuggerUrl!);
    try {
      await session.send('Page.enable').catch(() => undefined);
      await session.send('Runtime.enable').catch(() => undefined);
      return await operation(session, entry, target);
    } finally {
      session.close();
    }
  }

  function enqueue<T>(tabId: string, operation: () => Promise<T>): Promise<T> {
    const previous = queues.get(tabId) ?? Promise.resolve();
    const running = previous.catch(() => undefined).then(operation);
    const marker = running.then(() => undefined, () => undefined);
    queues.set(tabId, marker);
    return running.finally(() => {
      if (queues.get(tabId) === marker) queues.delete(tabId);
    });
  }

  async function evaluate<T>(session: CdpSession, expression: string, timeoutMs = 12_000): Promise<T> {
    const result = await session.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
    }, timeoutMs);
    if (result?.exceptionDetails) {
      const detail = result.exceptionDetails;
      throw new Error(detail?.exception?.description ?? detail?.text ?? 'page evaluation failed');
    }
    const value = result?.result?.value;
    if (typeof value === 'string') {
      try { return JSON.parse(value) as T; } catch { return value as T; }
    }
    return value as T;
  }

  async function pageState(session: CdpSession, target?: ChromeTarget): Promise<{
    url: string;
    title: string;
    readyState: string;
    documentToken: string;
    scrollX: number;
    scrollY: number;
    viewport: { width: number; height: number };
  }> {
    try {
      return await evaluate(session, `(function () {
        return JSON.stringify({
          url: location.href,
          title: document.title || '',
          readyState: document.readyState,
          documentToken: String(performance.timeOrigin) + '|' + location.href,
          scrollX: Math.round(window.scrollX),
          scrollY: Math.round(window.scrollY),
          viewport: { width: window.innerWidth, height: window.innerHeight }
        });
      })()`);
    } catch {
      return {
        url: target?.url ?? '',
        title: target?.title ?? '',
        readyState: 'unknown',
        documentToken: `unknown|${target?.url ?? ''}`,
        scrollX: 0,
        scrollY: 0,
        viewport: { width: 0, height: 0 },
      };
    }
  }

  async function adoptPopups(session: CdpSession): Promise<Array<{ tabId: string; url: string; title: string; openerTabId?: string }>> {
    const result = await session.send('Target.getTargets').catch(() => ({ targetInfos: [] }));
    const infos = Array.isArray(result?.targetInfos) ? result.targetInfos as TargetInfo[] : [];
    const adopted: Array<{ tabId: string; url: string; title: string; openerTabId?: string }> = [];
    let changed = true;
    while (changed) {
      changed = false;
      for (const info of infos) {
        if (info.type !== 'page' || !info.targetId || targetToTab.has(info.targetId) || !info.openerId) continue;
        const openerTabId = targetToTab.get(info.openerId);
        if (!openerTabId) continue;
        const tabId = `tab_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
        const entry: OwnedTab = { tabId, targetId: info.targetId, openerTabId, createdAt: new Date().toISOString() };
        tabs.set(tabId, entry);
        targetToTab.set(info.targetId, tabId);
        adopted.push({ tabId, url: info.url ?? '', title: info.title ?? '', openerTabId });
        changed = true;
      }
    }
    if (adopted.length) saveRegistry();
    return adopted;
  }

  async function settleAndReceipt(
    action: BrowserHandsAction,
    tabId: string,
    session: CdpSession,
    target: ChromeTarget,
    extra: Record<string, unknown> = {},
  ): Promise<BrowserReceipt> {
    await sleep(250);
    const newTabs = await adoptPopups(session);
    const dialog = latestDialog(session);
    // Runtime evaluation blocks while a JavaScript dialog is open. Return the
    // dialog immediately so the next action can accept/dismiss it instead of
    // waiting for an avoidable Runtime timeout.
    const state = dialog
      ? {
          url: target.url ?? '',
          title: target.title ?? '',
          readyState: 'dialog',
          documentToken: `dialog|${target.url ?? ''}`,
          scrollX: 0,
          scrollY: 0,
          viewport: { width: 0, height: 0 },
        }
      : await pageState(session, target);
    return {
      ok: true,
      action,
      tabId,
      url: state.url,
      title: state.title,
      readyState: state.readyState,
      ...(dialog ? { dialog } : {}),
      ...(newTabs.length ? { newTabs } : {}),
      ...extra,
    };
  }

  async function navigate(session: CdpSession, url: string): Promise<void> {
    const startIndex = session.events.length;
    const result = await session.send('Page.navigate', { url }, 15_000);
    if (result?.errorText) {
      throw new BrowserHandsError('NAVIGATION_FAILED', result.errorText, 'Check the URL or network, then retry navigate.');
    }
    const startedAt = Date.now();
    while (Date.now() - startedAt < NAVIGATION_TIMEOUT_MS) {
      const events = session.events.slice(startIndex);
      if (events.some(event => event.method === 'Page.loadEventFired' || event.method === 'Page.domContentEventFired')) {
        await sleep(500);
        return;
      }
      try {
        const state = await evaluate<{ readyState: string; url: string }>(session, `JSON.stringify({ readyState: document.readyState, url: location.href })`, 3_000);
        if (Date.now() - startedAt > 750 && state?.readyState === 'complete' && state.url !== 'about:blank') {
          await sleep(500);
          return;
        }
      } catch {
        // Target is between documents; retry.
      }
      await sleep(200);
    }
    throw new BrowserHandsError('NAVIGATION_TIMEOUT', `Page did not finish loading within ${NAVIGATION_TIMEOUT_MS / 1000}s`, 'Inspect the tab; if useful content is present continue, otherwise retry or wait for a selector.');
  }

  function inspectExpression(selector: string | undefined, maxNodes: number): string {
    const scope = JSON.stringify(selector ?? '');
    return `(function () {
      var scopeSelector = ${scope};
      var root = scopeSelector ? document.querySelector(scopeSelector) : document.body;
      if (!root) return JSON.stringify({ error: 'scope selector did not match', selector: scopeSelector });
      function cssPath(el) {
        if (el.id) return '#' + CSS.escape(el.id);
        var parts = [];
        while (el && el.nodeType === 1 && el !== document.documentElement) {
          var part = el.tagName.toLowerCase();
          var parent = el.parentElement;
          if (parent) {
            var same = Array.from(parent.children).filter(function (child) { return child.tagName === el.tagName; });
            if (same.length > 1) part += ':nth-of-type(' + (same.indexOf(el) + 1) + ')';
          }
          parts.unshift(part);
          el = parent;
          if (parts.length >= 8) break;
        }
        return parts.join(' > ');
      }
      function visible(el) {
        var rect = el.getBoundingClientRect();
        var style = getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
      }
      var query = 'a,button,input,textarea,select,option,summary,[role],[tabindex],[contenteditable="true"],iframe';
      var candidates = Array.from(root.querySelectorAll(query)).filter(visible).slice(0, ${maxNodes});
      var elements = candidates.map(function (el) {
        var rect = el.getBoundingClientRect();
        var text = (el.innerText || el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 500);
        var value = ('value' in el && typeof el.value === 'string') ? el.value.slice(0, 500) : '';
        var name = el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('alt') || text || value || el.getAttribute('placeholder') || '';
        return {
          selector: cssPath(el),
          tag: el.tagName.toLowerCase(),
          role: el.getAttribute('role') || '',
          name: name.slice(0, 500),
          text: text,
          value: value,
          href: el.href || '',
          checked: typeof el.checked === 'boolean' ? el.checked : undefined,
          selected: typeof el.selected === 'boolean' ? el.selected : undefined,
          disabled: !!el.disabled,
          expanded: el.getAttribute('aria-expanded'),
          rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) }
        };
      });
      return JSON.stringify({
        documentToken: String(performance.timeOrigin) + '|' + location.href,
        selector: scopeSelector || null,
        pageText: (root.innerText || root.textContent || '').trim().slice(0, ${MAX_PAGE_TEXT_CHARS}),
        htmlExcerpt: root.outerHTML.slice(0, ${MAX_HTML_CHARS}),
        elements: elements,
        totalInteractive: root.querySelectorAll(query).length
      });
    })()`;
  }

  async function inspectTab(tabId: string, input: BrowserHandsInput): Promise<BrowserReceipt> {
    return enqueue(tabId, () => withSession(tabId, async (session, _entry, target) => {
      const mode = input.inspect?.mode ?? 'both';
      const maxNodes = Math.round(clamp(input.inspect?.maxNodes, 1, MAX_INSPECT_NODES, 80));
      const dom = mode === 'accessibility'
        ? undefined
        : await evaluate<any>(session, inspectExpression(input.inspect?.selector, maxNodes), 20_000);
      if (dom?.error) {
        throw new BrowserHandsError('SELECTOR_NOT_FOUND', dom.error, 'Use a valid CSS selector or omit inspect.selector to inspect the whole page.');
      }
      let accessibility: any[] | undefined;
      if (mode !== 'dom') {
        await session.send('Accessibility.enable').catch(() => undefined);
        const tree = await session.send('Accessibility.getFullAXTree', { depth: 8 }, 15_000).catch(() => ({ nodes: [] }));
        accessibility = (Array.isArray(tree?.nodes) ? tree.nodes : [])
          .filter((node: any) => !node.ignored)
          .slice(0, maxNodes)
          .map((node: any) => ({
            role: node.role?.value ?? '',
            name: node.name?.value ?? '',
            value: node.value?.value ?? '',
            description: node.description?.value ?? '',
            disabled: node.properties?.find((property: any) => property.name === 'disabled')?.value?.value,
            focused: node.properties?.find((property: any) => property.name === 'focused')?.value?.value,
          }));
      }
      const refMap = new Map<string, string>();
      const elements = Array.isArray(dom?.elements)
        ? dom.elements.map((element: any, index: number) => {
            const ref = `r${index + 1}`;
            refMap.set(ref, String(element.selector));
            const { selector: _selector, ...rest } = element;
            return { ref, ...rest };
          })
        : [];
      const state = await pageState(session, target);
      refs.set(tabId, { documentToken: dom?.documentToken ?? state.documentToken, refs: refMap });
      const newTabs = await adoptPopups(session);
      return {
        ok: true,
        action: 'inspect',
        tabId,
        url: state.url,
        title: state.title,
        readyState: state.readyState,
        snapshotId: dom?.documentToken ?? state.documentToken,
        ...(mode !== 'accessibility' ? {
          pageText: dom?.pageText ?? '',
          htmlExcerpt: dom?.htmlExcerpt ?? '',
          elements,
          totalInteractive: dom?.totalInteractive ?? 0,
        } : {}),
        ...(mode !== 'dom' ? { accessibility } : {}),
        ...(latestDialog(session) ? { dialog: latestDialog(session) } : {}),
        ...(newTabs.length ? { newTabs } : {}),
      };
    }));
  }

  async function resolveSelector(session: CdpSession, tabId: string, targetInput: BrowserElementTarget | undefined): Promise<string> {
    const explicit = String(targetInput?.selector ?? '').trim();
    if (explicit) return explicit;
    const ref = String(targetInput?.ref ?? '').trim();
    if (!ref) {
      throw new BrowserHandsError('TARGET_REQUIRED', 'This action requires target.ref or target.selector', 'Inspect the page, then pass a returned ref or a CSS selector.');
    }
    const refState = refs.get(tabId);
    const selector = refState?.refs.get(ref);
    if (!refState || !selector) {
      throw new BrowserHandsError('STALE_REF', `Unknown or expired element ref: ${ref}`, 'Inspect the page again and use a current ref.');
    }
    const state = await pageState(session);
    if (state.documentToken !== refState.documentToken) {
      refs.delete(tabId);
      throw new BrowserHandsError('STALE_REF', `Element ref ${ref} belongs to a previous document`, 'Inspect the current page and use a new ref.');
    }
    return selector;
  }

  async function elementPoint(session: CdpSession, selector: string): Promise<{ x: number; y: number; tag: string }> {
    const escaped = JSON.stringify(selector);
    const point = await evaluate<any>(session, `(function () {
      var el = document.querySelector(${escaped});
      if (!el) return { error: 'selector did not match' };
      el.scrollIntoView({ block: 'center', inline: 'center' });
      var rect = el.getBoundingClientRect();
      var style = getComputedStyle(el);
      if (rect.width <= 0 || rect.height <= 0 || style.display === 'none' || style.visibility === 'hidden') return { error: 'element is not visible' };
      if (typeof el.focus === 'function') el.focus();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, tag: el.tagName.toLowerCase() };
    })()`);
    if (point?.error) {
      throw new BrowserHandsError('ELEMENT_NOT_ACTIONABLE', `${point.error}: ${selector}`, 'Inspect the page and choose a visible element or narrower selector.');
    }
    return point;
  }

  async function clickAt(
    session: CdpSession,
    point: { x: number; y: number },
    clickCount = 1,
    dialogDecision: 'accept' | 'dismiss' = 'dismiss',
    promptText?: string,
  ): Promise<BrowserReceipt['dialog'] | undefined> {
    // Real Chrome suppresses some user-gesture behavior (notably dialogs and
    // popups) from a background target. Bring the owned tab to the front before
    // dispatching the same pointer sequence a person would generate.
    await session.send('Page.bringToFront').catch(() => undefined);
    await session.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y });
    await session.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount });
    const eventStart = session.events.length;
    let releaseSettled = false;
    const release = session.send(
      'Input.dispatchMouseEvent',
      { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount },
      15_000,
    ).then(() => { releaseSettled = true; });

    // A JavaScript dialog blocks the mouseReleased response. Detect and handle
    // it on the SAME CDP connection; closing this short-lived connection with
    // the dialog pending would make Chrome dismiss it before a later tool call.
    const deadline = Date.now() + 1_000;
    while (!releaseSettled && Date.now() < deadline) {
      const opening = session.events
        .slice(eventStart)
        .find(event => event.method === 'Page.javascriptDialogOpening');
      if (opening) {
        await session.send('Page.handleJavaScriptDialog', {
          accept: dialogDecision === 'accept',
          ...(promptText !== undefined ? { promptText } : {}),
        });
        await release;
        return {
          type: String(opening.params?.type ?? 'dialog'),
          message: String(opening.params?.message ?? ''),
          hasBrowserHandler: Boolean(opening.params?.hasBrowserHandler),
          handled: dialogDecision,
          open: false,
        };
      }
      await sleep(20);
    }
    await release;
    return undefined;
  }

  async function actionOnTab(tabId: string, input: BrowserHandsInput): Promise<BrowserReceipt> {
    return enqueue(tabId, () => withSession(tabId, async (session, _entry, target) => {
      if (input.action === 'navigate') {
        const url = normalizeHttpUrl(input.url);
        refs.delete(tabId);
        await navigate(session, url);
        return settleAndReceipt('navigate', tabId, session, target);
      }

      if (input.action === 'click') {
        const selector = await resolveSelector(session, tabId, input.target);
        const point = await elementPoint(session, selector);
        const handledDialog = await clickAt(
          session,
          point,
          Math.round(clamp(input.clickCount, 1, 3, 1)),
          input.dialog?.decision ?? 'dismiss',
          input.dialog?.promptText,
        );
        return settleAndReceipt('click', tabId, session, target, {
          target: input.target,
          ...(handledDialog ? { dialog: handledDialog } : {}),
        });
      }

      if (input.action === 'type') {
        const selector = await resolveSelector(session, tabId, input.target);
        const point = await elementPoint(session, selector);
        await clickAt(session, point);
        if (input.replace !== false) {
          await session.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 4 });
          await session.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 4 });
          await session.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
          await session.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
        }
        await session.send('Input.insertText', { text: String(input.text ?? '') });
        return settleAndReceipt('type', tabId, session, target, { target: input.target, characters: String(input.text ?? '').length });
      }

      if (input.action === 'select') {
        const selector = await resolveSelector(session, tabId, input.target);
        const values = Array.isArray(input.values) ? input.values.map(String) : [];
        if (!values.length) {
          throw new BrowserHandsError('VALUES_REQUIRED', 'select requires at least one value', 'Pass values exactly as present in the option value attributes.');
        }
        const outcome = await evaluate<any>(session, `(function () {
          var el = document.querySelector(${JSON.stringify(selector)});
          if (!(el instanceof HTMLSelectElement)) return { error: 'target is not a select element' };
          var wanted = new Set(${JSON.stringify(values)});
          Array.from(el.options).forEach(function (option) { option.selected = wanted.has(option.value); });
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          return { selected: Array.from(el.selectedOptions).map(function (option) { return option.value; }) };
        })()`);
        if (outcome?.error) {
          throw new BrowserHandsError('SELECT_FAILED', outcome.error, 'Inspect and target a native <select>, then pass its option values.');
        }
        return settleAndReceipt('select', tabId, session, target, outcome);
      }

      if (input.action === 'key') {
        const key = keyDefinition(String(input.key ?? ''));
        const modifiers = modifierMask(input.modifiers);
        await session.send('Page.bringToFront').catch(() => undefined);
        await session.send('Input.dispatchKeyEvent', { type: 'keyDown', ...key, modifiers });
        await session.send('Input.dispatchKeyEvent', { type: 'keyUp', ...key, modifiers });
        return settleAndReceipt('key', tabId, session, target, { key: key.key, modifiers: input.modifiers ?? [] });
      }

      if (input.action === 'scroll') {
        let x: number;
        let y: number;
        if (input.target?.ref || input.target?.selector) {
          const selector = await resolveSelector(session, tabId, input.target);
          const point = await elementPoint(session, selector);
          x = point.x;
          y = point.y;
        } else {
          const state = await pageState(session, target);
          x = state.viewport.width / 2;
          y = state.viewport.height / 2;
        }
        const deltaX = clamp(input.deltaX, -10_000, 10_000, 0);
        const deltaY = clamp(input.deltaY, -10_000, 10_000, 700);
        await session.send('Page.bringToFront').catch(() => undefined);
        await session.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX, deltaY });
        return settleAndReceipt('scroll', tabId, session, target, { deltaX, deltaY });
      }

      if (input.action === 'wait') {
        const kind = input.wait?.kind ?? 'load';
        const timeoutMs = Math.round(clamp(input.wait?.timeoutMs, 0, DEFAULT_ACTION_TIMEOUT_MS, 10_000));
        if (kind === 'timeout') {
          await sleep(timeoutMs);
          return settleAndReceipt('wait', tabId, session, target, { wait: { kind, timeoutMs } });
        }
        const startedAt = Date.now();
        const value = String(input.wait?.value ?? '');
        const desiredState = input.wait?.state ?? 'visible';
        let lastObserved: unknown = null;
        while (Date.now() - startedAt <= timeoutMs) {
          if (kind === 'load') {
            lastObserved = await evaluate(session, 'document.readyState', 3_000).catch(() => 'loading');
            if (lastObserved === 'complete') break;
          } else if (kind === 'url') {
            lastObserved = await evaluate(session, 'location.href', 3_000).catch(() => '');
            if (String(lastObserved).includes(value)) break;
          } else if (kind === 'text') {
            lastObserved = await evaluate(session, `(document.body?.innerText || '').includes(${JSON.stringify(value)})`, 3_000).catch(() => false);
            if (lastObserved === true) break;
          } else if (kind === 'selector') {
            if (!value) throw new BrowserHandsError('WAIT_VALUE_REQUIRED', 'wait kind=selector requires wait.value', 'Pass a CSS selector in wait.value.');
            lastObserved = await evaluate<any>(session, `(function () {
              var el = document.querySelector(${JSON.stringify(value)});
              if (!el) return { present: false, visible: false };
              var rect = el.getBoundingClientRect();
              var style = getComputedStyle(el);
              return { present: true, visible: rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden' };
            })()`, 3_000).catch(() => ({ present: false, visible: false }));
            const observed = lastObserved as any;
            if (
              (desiredState === 'present' && observed.present) ||
              (desiredState === 'visible' && observed.visible) ||
              (desiredState === 'hidden' && observed.present && !observed.visible) ||
              (desiredState === 'absent' && !observed.present)
            ) break;
          }
          await sleep(250);
        }
        if (Date.now() - startedAt > timeoutMs) {
          throw new BrowserHandsError('WAIT_TIMEOUT', `Timed out waiting for ${kind}${value ? `: ${value}` : ''}`, 'Inspect the current page state, then adjust the wait condition or continue with what loaded.');
        }
        return settleAndReceipt('wait', tabId, session, target, { wait: { kind, value, state: desiredState, observed: lastObserved } });
      }

      if (input.action === 'dialog') {
        const decision = input.dialog?.decision;
        if (decision !== 'accept' && decision !== 'dismiss') {
          throw new BrowserHandsError('DIALOG_DECISION_REQUIRED', 'dialog.decision must be accept or dismiss', 'Pass dialog: { decision: "accept" } or { decision: "dismiss" }.');
        }
        try {
          await session.send('Page.handleJavaScriptDialog', {
            accept: decision === 'accept',
            ...(input.dialog?.promptText !== undefined ? { promptText: input.dialog.promptText } : {}),
          });
        } catch (error: any) {
          throw new BrowserHandsError('NO_DIALOG', error?.message ?? 'No JavaScript dialog is open', 'Inspect the page or continue with another action.');
        }
        return settleAndReceipt('dialog', tabId, session, target, { decision });
      }

      throw new BrowserHandsError('UNSUPPORTED_ACTION', `Unsupported action: ${input.action}`, 'Use list, open, navigate, inspect, click, type, select, key, scroll, wait, dialog, or close.');
    }));
  }

  async function execute(input: BrowserHandsInput): Promise<BrowserReceipt> {
    const action = String(input?.action ?? '') as BrowserHandsAction;
    try {
      await initialize();
      if (!['list', 'open', 'navigate', 'inspect', 'click', 'type', 'select', 'key', 'scroll', 'wait', 'dialog', 'close'].includes(action)) {
        throw new BrowserHandsError('ACTION_REQUIRED', 'A supported browser action is required', 'Use list, open, navigate, inspect, click, type, select, key, scroll, wait, dialog, or close.');
      }

      if (action === 'list') {
        const targets = await reconcile();
        const owned = [...tabs.values()].map(entry => {
          const target = targets.get(entry.targetId);
          return {
            tabId: entry.tabId,
            url: target?.url ?? '',
            title: target?.title ?? '',
            ...(entry.openerTabId ? { openerTabId: entry.openerTabId } : {}),
            createdAt: entry.createdAt,
          };
        });
        return { ok: true, action, tabs: owned, count: owned.length };
      }

      if (action === 'open') {
        const url = normalizeHttpUrl(input.url);
        const target = await createBlankTarget();
        const tabId = `tab_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
        tabs.set(tabId, { tabId, targetId: target.id, createdAt: new Date().toISOString() });
        targetToTab.set(target.id, tabId);
        saveRegistry();
        try {
          return await enqueue(tabId, () => withSession(tabId, async (session, _entry, current) => {
            await navigate(session, url);
            return settleAndReceipt('open', tabId, session, current);
          }));
        } catch (error) {
          return errorReceipt('open', error, tabId);
        }
      }

      const tabId = String(input.tabId ?? '').trim();
      if (!tabId) throw new BrowserHandsError('TAB_ID_REQUIRED', `${action} requires tabId`, 'Call action=list or open, then pass the returned tabId.');

      if (action === 'close') {
        try {
          const entry = tabs.get(tabId);
          if (!entry) throw new BrowserHandsError('TAB_NOT_FOUND', `Unknown browser tabId: ${tabId}`, 'Call action=list to see available tabs.');
          await enqueue(tabId, async () => {
            await cdpHttp(`/json/close/${encodeURIComponent(entry.targetId)}`).catch(async () => {
              const targets = await listChromeTargets();
              if (targets.some(target => target.id === entry.targetId)) throw new Error('Chrome did not close the target');
            });
          });
          forgetTab(tabId);
          return { ok: true, action, tabId, closed: true };
        } catch (error) {
          return errorReceipt(action, error, tabId);
        }
      }

      if (action === 'inspect') return await inspectTab(tabId, input);
      return await actionOnTab(tabId, input);
    } catch (error) {
      return errorReceipt(action || 'list', error, input?.tabId);
    }
  }

  async function screenshot(input: { tabId?: string; fullPage?: boolean }): Promise<{ receipt: BrowserScreenshotReceipt; dataUrl?: string }> {
    const tabId = String(input.tabId ?? '').trim();
    try {
      await initialize();
      if (!tabId) throw new BrowserHandsError('TAB_ID_REQUIRED', 'browser_screenshot requires tabId', 'Call browser_hands action=list or open, then pass the returned tabId.');
      return await enqueue(tabId, () => withSession(tabId, async (session, _entry, target) => {
        let clip: Record<string, number> | undefined;
        let clipped = false;
        if (input.fullPage) {
          const metrics = await session.send('Page.getLayoutMetrics');
          const size = metrics?.cssContentSize ?? metrics?.contentSize;
          if (size?.width && size?.height) {
            const width = Math.min(16_384, Math.max(1, Number(size.width)));
            const height = Math.min(16_384, Math.max(1, Number(size.height)));
            clipped = width < Number(size.width) || height < Number(size.height);
            clip = { x: 0, y: 0, width, height, scale: 1 };
          }
        }
        const shot = await session.send('Page.captureScreenshot', {
          format: 'png',
          fromSurface: true,
          captureBeyondViewport: Boolean(input.fullPage),
          ...(clip ? { clip } : {}),
        }, 30_000);
        const data = String(shot?.data ?? '');
        if (!data) throw new BrowserHandsError('SCREENSHOT_EMPTY', 'Chrome returned no screenshot data', 'Wait for the page to render, then retry browser_screenshot.');
        const buffer = Buffer.from(data, 'base64');
        const dimensions = pngDimensions(buffer);
        fs.mkdirSync(filesDir, { recursive: true });
        const filename = `browser-${new Date().toISOString().replace(/[:.]/g, '-')}-${tabId}.png`;
        const filePath = path.join(filesDir, filename);
        fs.writeFileSync(filePath, buffer, { mode: 0o600 });
        const state = await pageState(session, target);
        const newTabs = await adoptPopups(session);
        const receipt: BrowserScreenshotReceipt = {
          ok: true,
          action: 'screenshot',
          tabId,
          url: state.url,
          title: state.title,
          readyState: state.readyState,
          filePath,
          fileUrl: `/api/files/browser-hands/${encodeURIComponent(filename)}`,
          bytes: buffer.length,
          width: dimensions.width,
          height: dimensions.height,
          fullPage: Boolean(input.fullPage),
          clipped,
          modelImageIncluded: true,
          ...(latestDialog(session) ? { dialog: latestDialog(session) } : {}),
          ...(newTabs.length ? { newTabs } : {}),
        };
        return { receipt, dataUrl: `data:image/png;base64,${data}` };
      }));
    } catch (error) {
      return { receipt: errorReceipt('screenshot', error, tabId || undefined) as BrowserScreenshotReceipt };
    }
  }

  return {
    initialize,
    execute,
    screenshot,
    ownsTarget(targetId: string): boolean {
      return targetToTab.has(targetId);
    },
  };
}
