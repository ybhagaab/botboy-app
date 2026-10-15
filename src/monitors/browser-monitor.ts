/**
 * Browser Monitor — tracks browser activity via Chrome DevTools Protocol.
 *
 * Connects to a running Chrome instance (debug port 9222) and:
 * 1. Polls /json/list for open tabs
 * 2. Connects to each new tab via CDP WebSocket
 * 3. Extracts visible text content using Runtime.evaluate, in two phases:
 *    a probe (text, fields, frames) on one WebSocket per tab, then the page's
 *    HTML only when a capture will be emitted
 * 4. Detects platform-specific pages by URL pattern
 */

import WebSocket from 'ws';
import type { RawWorkItem, WorkItemType } from '../core/types.js';
import { fileURLToPath } from 'url';
import { isCaptureExcludedPath } from '../core/capture-exclusions.js';
import { redactSecrets } from '../core/sensitive-files.js';
import {
  FORM_FIELDS_READER,
  HTML_FIELD_REDACTION_SNIPPET,
  fieldsFingerprint,
  parseFieldsAnswer,
  renderFieldsSection,
} from '../core/form-fields.js';
import {
  THIN_PAGE_CHARS,
  decideDynamicCapture,
  decideStaticCapture,
  isStaticCaptureExhausted,
  type CapturedState,
  type StaticProbe,
  type StaticTabState,
} from './browser-capture-decision.js';
import {
  createPollGovernor,
  initialPlanState,
  medianOf,
  planTabReads,
  type PlannedTab,
} from './browser-poll-governor.js';
import { loadPerCpu, readMemoryPressure, type MemoryPressure } from '../core/system-pressure.js';

export { THIN_PAGE_CHARS };

/** What the pacing governor and the Connections card read about the monitor. */
export interface BrowserCaptureStatus {
  /** The owner paused browser capture (no /json/list, no CDP while true). */
  paused: boolean;
  /** The interval in force now, and the configured base. */
  intervalMs: number;
  baseIntervalMs: number;
  /** Why polls are slowed (for example `memory pressure: warn`); null when calm. */
  slowedReason: string | null;
  lastPollMs: number | null;
  lastPollAt: number | null;
  tabsSeen: number;
  tabsRead: number;
  tabsDeferred: number;
}

/** One read phase of one tab in one poll (measurement only). */
export interface PollTabStat {
  id: string;
  phase: 'probe' | 'html' | 'whatsapp' | 'pdf';
  ms: number;
  bytes: number;
}

export interface PollStats {
  wallMs: number;
  tabsSeen: number;
  tabsRead: number;
  tabsDeferred: number;
  perTab: PollTabStat[];
}

export interface BrowserMonitor {
  start(): Promise<void>;
  stop(): void;
  onWorkItem(callback: (item: RawWorkItem) => void): void;
  /** One poll now (tests; the timer calls the same). */
  pollOnce(): Promise<void>;
  /**
   * Back to the base interval and poll now (the owner resumed capture).
   * During a poll it runs exactly one follow-up when that poll ends.
   */
  wake(): void;
  status(): BrowserCaptureStatus;
}

export interface BrowserMonitorConfig {
  cdpEndpoint: string;
  pollIntervalMs: number;
  /** Hands-owned targets are active automation, not ambient browsing evidence. */
  shouldSkipTarget?: (targetId: string) => boolean;
  /**
   * A page whose text is still thin (an app still rendering) is checked again
   * on later polls before BotBoy settles for what it has (default 6 polls).
   */
  maxSettleAttempts?: number;
  /**
   * True when a capture URL is already stored (WhatsApp messages are one row
   * each, keyed by message id, so a restart never stores them twice).
   */
  hasCaptured?: (url: string) => boolean;
  /**
   * Text of a PDF's bytes (BotBoy's document parser). A PDF tab shows Chrome's
   * viewer, which has no page text, so the file itself is read.
   */
  readPdf?: (bytes: Buffer) => Promise<string>;
  /**
   * Wall-time bound of one poll (default 20 s), checked between tabs and
   * between a tab's read phases. The first tab of a poll is always read in
   * full; a tab left for the next poll keeps its remembered state untouched.
   */
  maxPollWallMs?: number;
  /** Clock for the wall bound and poll timings (tests). */
  now?: () => number;
  /**
   * Adaptive pacing (default off): the interval doubles up to 5 minutes while
   * polls are slow or the Mac is under memory pressure or load, and returns to
   * `pollIntervalMs` after three calm polls. Calm behaves exactly as without it.
   */
  adaptive?: boolean;
  /** Soft per-poll tab budget, applied only while slowed (default 12). */
  maxTabsPerPoll?: number;
  /** Memory pressure and load per core, sampled after each poll (default: the OS). */
  sampleSystem?: () => { pressure: MemoryPressure; loadPerCpu: number };
  /**
   * True while the owner has paused browser capture: no /json/list and no CDP
   * call is made, checked before every CDP call and before every emit.
   */
  isPaused?: () => boolean;
  /** Measurement per poll (never affects capture). */
  onPollStats?: (stats: PollStats) => void;
  /** The interval or the slowed reason changed. */
  onStatusChange?: (status: BrowserCaptureStatus) => void;
}
/** Largest PDF a browser tab capture downloads. */
export const MAX_TAB_PDF_BYTES = 25 * 1024 * 1024;
/** A tab showing a PDF: a .pdf address, or Chrome's PDF viewer frame inside it. */
export function isPdfTab(tab: { url: string; frames: { url: string }[] }): boolean {
  let pathname = '';
  try { pathname = new URL(tab.url).pathname; } catch { return false; }
  if (/\.pdf$/i.test(pathname)) return true;
  return tab.frames.some((frame) => frame.url.startsWith('chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/'));
}
/**
 * Fetches the tab's own PDF inside the page (the owner's cookies apply, so a
 * signed-in PDF reads too) and returns it as base64, or '' past the size cap.
 */
const PDF_BYTES_READER = `(async function() {
  try {
    const r = await fetch(location.href, { credentials: 'include' });
    if (!r.ok) return '';
    const b = new Uint8Array(await r.arrayBuffer());
    if (b.length > ${25 * 1024 * 1024} || b.length < 5) return '';
    let s = '';
    for (let i = 0; i < b.length; i += 32768) s += String.fromCharCode.apply(null, b.subarray(i, i + 32768));
    return btoa(s);
  } catch (e) { return ''; }
})()`;

/** The capture URL of one WhatsApp message (its own WhatsApp id). */
export function whatsAppMessageUrl(messageId: string): string {
  return `https://web.whatsapp.com/#msg=${encodeURIComponent(messageId)}`;
}

/** A poll that has used this much wall time leaves its remaining tabs for the next poll. */
const DEFAULT_MAX_POLL_WALL_MS = 20_000;

const DEFAULT_CONFIG: BrowserMonitorConfig = {
  cdpEndpoint: 'http://127.0.0.1:9222',
  pollIntervalMs: 30000,
};

// ── URL Pattern Matchers ──

interface PlatformMatch {
  type: WorkItemType;
  extractMetadata: (url: string, title: string) => Record<string, string>;
}

const PLATFORM_PATTERNS: [RegExp, PlatformMatch][] = [
  [/youtube\.com\/watch/, {
    type: 'youtube_video',
    extractMetadata: (_url, title) => ({ videoTitle: title, channelName: '' }),
  }],
  [/app\.slack\.com|slack\.com\/client/, {
    type: 'slack_message',
    extractMetadata: (_url, title) => ({ channelOrDm: title, platform: 'browser', direction: 'sent', recipientOrSender: '' }),
  }],
  [/web\.whatsapp\.com/, {
    type: 'whatsapp_message',
    extractMetadata: (_url, title) => ({ conversationName: title }),
  }],
  [/mail\.google\.com/, {
    type: 'email_read',
    extractMetadata: (_url, title) => ({ subject: title, direction: 'read', recipients: '' }),
  }],
  [/(?:outlook\.(?:office|live)\.com|outlook\.cloud\.microsoft)\/mail/i, {
    type: 'email_read',
    extractMetadata: (_url, title) => ({ subject: title, direction: 'read', recipients: '', platform: 'outlook_web' }),
  }],
  [/docs\.google\.com\/document/, {
    type: 'document_online',
    extractMetadata: (_url, title) => ({ documentType: 'google_docs', fileType: 'document' }),
  }],
  [/docs\.google\.com\/spreadsheets/, {
    type: 'document_online',
    extractMetadata: (_url, title) => ({ documentType: 'google_sheets', fileType: 'spreadsheet' }),
  }],
];

export function detectPlatform(url: string, title: string): { type: WorkItemType; metadata: Record<string, string> } {
  for (const [pattern, match] of PLATFORM_PATTERNS) {
    if (pattern.test(url)) {
      return { type: match.type, metadata: match.extractMetadata(url, title) };
    }
  }
  return { type: 'website_visit', metadata: {} };
}

// ── CDP helpers ──

interface FrameTarget { url: string; webSocketDebuggerUrl: string }

/** Ad, tracking, and consent frames: never page content. */
const NOISE_FRAME_HOSTS = /(?:^|\.)(?:doubleclick\.net|googlesyndication\.com|googleadservices\.com|adtrafficquality\.google|2mdn\.net|adnxs\.com|amazon-adsystem\.com|criteo\.(?:com|net)|taboola\.com|outbrain\.com|flashb\.id|onetag-sys\.com|pubmatic\.com|rubiconproject\.com|casalemedia\.com|openx\.net|moatads\.com|scorecardresearch\.com|quantserve\.com|imasdk\.googleapis\.com|recaptcha\.net|cookielaw\.org|onetrust\.com|consensu\.org|hotjar\.com|intercom\.io)$/i;
/** Per-frame and per-page bounds on frame text (a page's own text is not capped). */
const MAX_FRAME_CHARS = 100_000;
const MAX_FRAMES_TEXT = 200_000;

export function isNoiseFrame(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (!/^https?:$/.test(parsed.protocol)) return true;
    return NOISE_FRAME_HOSTS.test(parsed.hostname) || /\/(?:recaptcha|usersync|usync|pixel)\b/i.test(parsed.pathname);
  } catch {
    return true;
  }
}

/**
 * A `file:` page that lives in the Knowledge library (or in a former library folder) is never polled, so a reference
 * file the owner opens in the debug Chrome does not become a page capture (knowledge-library.md K1; P1 review N3). A
 * `file:` URL that cannot be turned into a local path is not judged here (it is captured as before).
 */
export function isCaptureExcludedFileUrl(url: string): boolean {
  if (!/^file:/i.test(String(url ?? ''))) return false;
  try {
    return isCaptureExcludedPath(fileURLToPath(url), { resolveLinks: true });
  } catch {
    return false;
  }
}
interface TabInfo {
  url: string;
  title: string;
  id: string;
  webSocketDebuggerUrl: string;
  /**
   * Cross-origin iframes (site isolation runs them as their own CDP targets
   * with `parentId`): SharePoint/Office viewers, embedded dashboards. The
   * page's own script cannot read them, so each is read on its own.
   */
  frames: FrameTarget[];
}

async function fetchTabs(endpoint: string, shouldSkipTarget?: (targetId: string) => boolean): Promise<TabInfo[]> {
  try {
    // A DevTools endpoint that accepts and never answers must not hold the (non-overlapping) poll forever.
    const resp = await fetch(`${endpoint}/json/list`, { signal: AbortSignal.timeout(10_000) });
    if (!resp.ok) return [];
    const tabs = await resp.json() as any[];
    // URL blocklist — skip these entirely
    const BLOCKED_URLS = [
      /^chrome:\/\//,
      /^devtools:\/\//,
      /^chrome-extension:\/\//,
      /localhost:7778/,          // BotBoy dashboard
      /127\.0\.0\.1:7778/,       // BotBoy loopback (Gmail OAuth callback)
      /accounts\.google\.com/,   // Google sign-in and consent (Gmail connect)
      /midway-auth\.amazon\.com/,
      /midway\.amazon\.com/,
      /fido\.a2z\.com/,
      /^about:/,
      /^data:/,
    ];
    const childrenOf = new Map<string, FrameTarget[]>();
    for (const t of tabs) {
      if (t?.type !== 'iframe' || !t.parentId || !t.webSocketDebuggerUrl || !t.url) continue;
      if (BLOCKED_URLS.some(p => p.test(t.url)) || isNoiseFrame(t.url)) continue;
      const list = childrenOf.get(String(t.parentId)) ?? [];
      list.push({ url: t.url, webSocketDebuggerUrl: t.webSocketDebuggerUrl });
      childrenOf.set(String(t.parentId), list);
    }
    // A frame's own frames belong to its page too (one level is the norm; two is rare).
    const framesFor = (id: string, depth = 0): FrameTarget[] => {
      const direct = childrenOf.get(id) ?? [];
      if (depth >= 2) return direct;
      const nested = tabs.filter((t: any) => t?.type === 'iframe' && String(t.parentId) === id)
        .flatMap((t: any) => framesFor(String(t.id), depth + 1));
      return [...direct, ...nested].slice(0, 8);
    };
    return tabs
      .filter((t: any) => {
        if (t.type !== 'page' || !t.url) return false;
        if (shouldSkipTarget?.(String(t.id ?? ''))) return false;
        if (isCaptureExcludedFileUrl(t.url)) return false;
        return !BLOCKED_URLS.some(p => p.test(t.url));
      })
      .map((t: any) => ({
        url: t.url,
        title: t.title || '',
        id: t.id,
        webSocketDebuggerUrl: t.webSocketDebuggerUrl || '',
        frames: framesFor(String(t.id)),
      }));
  } catch {
    return [];
  }
}

function cdpEval(wsUrl: string, expression: string, timeout = 8000): Promise<string> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error('CDP eval timeout'));
    }, timeout);

    ws.on('open', () => {
      // First check if page is fully loaded before injecting anything
      ws.send(JSON.stringify({
        id: 99,
        method: 'Runtime.evaluate',
        params: { expression: 'document.readyState', returnByValue: true },
      }));
    });

    ws.on('message', (data: Buffer) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.id === 99) {
          const readyState = msg.result?.result?.value;
          if (readyState !== 'complete') {
            // Page not fully loaded — skip this tab, don't interfere
            clearTimeout(timer);
            ws.close();
            resolve('');
            return;
          }
          // Page is loaded — now extract content
          ws.send(JSON.stringify({
            id: 1,
            method: 'Runtime.evaluate',
            params: { expression, returnByValue: true, awaitPromise: true },
          }));
        }
        if (msg.id === 1) {
          clearTimeout(timer);
          ws.close();
          const val = msg.result?.result?.value;
          resolve(typeof val === 'string' ? val : '');
        }
      } catch { /* ignore parse errors */ }
    });

    ws.on('error', (err: Error) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/**
 * One CDP connection to one target, reused for every evaluation of a read.
 *
 * Per call it behaves exactly like `cdpEval`: `document.readyState` is
 * checked first (answered `''` when the page is not `complete`, with no
 * expression injected), ids only grow, requests go out one at a time, and a
 * call that times out or hits a socket error rejects and discards the
 * connection. The next call on a discarded session reopens it lazily, so one
 * failed tolerated read never poisons the reads after it. A session opens no
 * socket until its first call; `close()` is always safe.
 */
export interface CdpSession {
  eval(expression: string, timeout?: number): Promise<string>;
  /** Bytes received from the target so far. */
  readonly bytes: number;
  close(): void;
}

export function openCdpSession(wsUrl: string): CdpSession {
  let socket: WebSocket | null = null;
  let bytes = 0;
  let nextId = 1;

  function connection(): WebSocket {
    if (socket && (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN)) return socket;
    const fresh = new WebSocket(wsUrl);
    // A dead socket is never reused; the call waiting on it reports the error.
    const forget = () => { if (socket === fresh) socket = null; };
    fresh.on('error', forget);
    fresh.on('close', forget);
    socket = fresh;
    return fresh;
  }

  function discard(): void {
    const dead = socket;
    socket = null;
    if (!dead) return;
    try { dead.close(); } catch { /* already gone */ }
  }

  function evaluate(expression: string, timeout = 8000): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      let settled = false;
      let ws: WebSocket | undefined;
      const readyId = nextId++;
      const expressionId = nextId++;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const detach = () => {
        if (timer) clearTimeout(timer);
        ws?.off('message', onMessage);
        ws?.off('error', onError);
        ws?.off('open', start);
      };
      const fail = (err: Error) => {
        if (settled) return;
        settled = true;
        detach();
        discard();
        reject(err);
      };
      const succeed = (value: string) => {
        if (settled) return;
        settled = true;
        detach();
        resolve(value);
      };
      function onError(err: Error): void { fail(err); }
      function start(): void {
        try {
          // First check if page is fully loaded before injecting anything
          ws!.send(JSON.stringify({
            id: readyId,
            method: 'Runtime.evaluate',
            params: { expression: 'document.readyState', returnByValue: true },
          }));
        } catch (err) { fail(err as Error); }
      }
      function onMessage(data: Buffer): void {
        bytes += data.length;
        try {
          const msg = JSON.parse(data.toString());
          if (msg.id === readyId) {
            const readyState = msg.result?.result?.value;
            if (readyState !== 'complete') {
              // Page not fully loaded — skip this read, don't interfere
              succeed('');
              return;
            }
            // Page is loaded — now extract content
            ws!.send(JSON.stringify({
              id: expressionId,
              method: 'Runtime.evaluate',
              params: { expression, returnByValue: true, awaitPromise: true },
            }));
          }
          if (msg.id === expressionId) {
            const val = msg.result?.result?.value;
            succeed(typeof val === 'string' ? val : '');
          }
        } catch { /* ignore parse errors */ }
      }
      timer = setTimeout(() => fail(new Error('CDP eval timeout')), timeout);
      try {
        ws = connection();
      } catch (err) {
        fail(err as Error);
        return;
      }
      ws.on('message', onMessage);
      ws.on('error', onError);
      if (ws.readyState === WebSocket.OPEN) start(); else ws.once('open', start);
    });
  }

  return {
    eval: evaluate,
    get bytes() { return bytes; },
    close: discard,
  };
}

/** Opens a session for one tab and always closes it. */
async function withTabSession<T>(tab: { webSocketDebuggerUrl: string }, fn: (session: CdpSession) => Promise<T>): Promise<T> {
  const session = openCdpSession(tab.webSocketDebuggerUrl);
  try {
    return await fn(session);
  } finally {
    session.close();
  }
}

/**
 * Visible page text: the main content when there is enough of it, else the
 * page without navigation and chrome; open shadow roots and same-origin
 * iframes included. Runs inside the page (and inside each cross-origin frame).
 */
export const GENERIC_PAGE_TEXT = `(function() {
  var SKIP = 'script, style, noscript, svg, template, nav, header, footer, aside, [role="navigation"], [role="banner"], [role="contentinfo"], .sidebar, .nav, .footer, .header, .menu';
  function shadowText(root, depth) {
    if (depth > 6) return '';
    var out = [];
    var hosts = root.querySelectorAll('*');
    for (var i = 0; i < hosts.length && out.length < 400; i++) {
      var sr = hosts[i].shadowRoot;
      if (!sr) continue;
      var own = Array.prototype.map.call(sr.children, function (c) {
        return c.matches && c.matches('script, style, template') ? '' : (c.innerText || c.textContent || '');
      }).join('\\n').trim();
      if (own) out.push(own);
      var deeper = shadowText(sr, depth + 1);
      if (deeper) out.push(deeper);
    }
    return out.join('\\n');
  }
  var body = document.body;
  if (!body) return '';
  var text = '';
  var main = document.querySelector('article, main, [role="main"], .post-content, .entry-content, .article-body, #content');
  if (main && (main.innerText || '').trim().length > 200) {
    text = main.innerText.trim();
  } else {
    var clone = body.cloneNode(true);
    clone.querySelectorAll(SKIP).forEach(function (el) { el.remove(); });
    // A detached clone has no layout, so innerText falls back to textContent rules; both are fine here.
    var stripped = (clone.innerText || clone.textContent || '').trim();
    text = stripped.length > 200 ? stripped : (body.innerText || '').trim();
  }
  var shadow = shadowText(document, 0);
  if (shadow && text.indexOf(shadow.slice(0, 80)) < 0) text += (text ? '\\n\\n' : '') + shadow;
  document.querySelectorAll('iframe').forEach(function (f) {
    try {
      var t = f.contentDocument && f.contentDocument.body ? f.contentDocument.body.innerText.trim() : '';
      if (t) text += '\\n\\n[iframe] ' + t;
    } catch (e) {}
  });
  return text;
})()`;

// ── WhatsApp Web (DOM verified live 2026-10-09) ──

/** One rendered WhatsApp message. */
export interface WhatsAppMessage {
  /** WhatsApp's own message id (`data-id`); the dedup key. */
  id: string;
  /** "[9:41 pm, 08/10/2026]" as WhatsApp writes it (locale order kept). */
  at: string;
  author: string;
  text: string;
  /** The reply's quoted message, shortened. */
  quoted?: string;
  kind: 'text' | 'poll' | 'image' | 'video' | 'audio' | 'document' | 'sticker' | 'other';
  outgoing: boolean;
}

export interface WhatsAppView {
  /** The open conversation's title; '' when no chat is open (list view). */
  chat: string;
  group: boolean;
  messages: WhatsAppMessage[];
}

/**
 * Reads the open WhatsApp conversation. WhatsApp renders only the rows on
 * screen (offscreen rows are empty placeholders), so each poll sees the
 * visible window; new rows are captured as they appear. Selectors are
 * WhatsApp's own `data-testid` / `data-pre-plain-text` / `data-id`, not its
 * generated class names, which change with every release.
 */
export const WHATSAPP_READER = `(function () {
  var main = document.querySelector('#main');
  if (!main) return JSON.stringify({ chat: '', group: false, messages: [] });
  var titleEl = main.querySelector('[data-testid="conversation-info-header-chat-title"]') || main.querySelector('header span[dir="auto"]');
  var chat = titleEl ? (titleEl.innerText || titleEl.textContent || '').trim() : '';
  var group = !!main.querySelector('[data-testid="group-chat-profile-picture"]');
  var out = [];
  var rows = main.querySelectorAll('[role="row"]');
  for (var i = 0; i < rows.length; i++) {
    var row = rows[i];
    var holder = row.querySelector('[data-id]');
    if (!holder) continue;
    var id = holder.getAttribute('data-id') || '';
    var copy = row.querySelector('[data-pre-plain-text]');
    if (!id || !copy) continue; // a placeholder, a system notice, or a bare media row
    var pre = copy.getAttribute('data-pre-plain-text') || '';
    var m = /^\\[([^\\]]*)\\]\\s*(.*?):\\s*$/.exec(pre);
    var quotedEl = row.querySelector('[data-testid="quoted-message"]');
    var parts = [];
    var pollEl = row.querySelector('[data-testid="poll-bubble"]');
    row.querySelectorAll('[data-testid="selectable-text"], [data-testid="image-caption"]').forEach(function (el) {
      if (quotedEl && quotedEl.contains(el)) return;
      // A poll's option labels are listed once below, not as body text.
      if (pollEl && parts.length) return;
      var t = (el.innerText || el.textContent || '').trim();
      if (t && parts.indexOf(t) < 0) parts.push(t);
    });
    var kind = 'text';
    if (pollEl) {
      kind = 'poll';
      var options = [];
      row.querySelectorAll('[data-testid^="poll-option-row-label"]').forEach(function (el) { var t = (el.innerText || '').trim(); if (t) options.push(t); });
      if (options.length) parts.push('Options: ' + options.join(' | '));
    } else if (row.querySelector('[data-testid="image-thumb"], img[src^="blob:"]')) kind = 'image';
    else if (row.querySelector('[data-icon*="video"], [data-testid*="video"]')) kind = 'video';
    else if (row.querySelector('[data-icon*="audio"], [data-icon*="ptt"], [data-testid*="audio"], [data-testid*="ptt"]')) kind = 'audio';
    else if (row.querySelector('[data-testid*="document"], [data-icon*="document"]')) kind = 'document';
    else if (row.querySelector('[data-testid*="sticker"]')) kind = 'sticker';
    var text = parts.join('\\n');
    if (!text && kind === 'text') continue;
    var quoted = quotedEl ? (quotedEl.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 200) : '';
    // A follow-up bubble has no tail icon, so the row's own labels decide:
    // the author label reads "You:" and only sent messages carry a status.
    var labels = Array.prototype.map.call(row.querySelectorAll('[aria-label]'), function (e) { return (e.getAttribute('aria-label') || '').trim(); });
    var outgoing = labels[0] === 'You:' || labels.some(function (l) { return /^(pending|sent|delivered|read)$/i.test(l); })
      || !!row.querySelector('[data-icon^="tail-out"], [data-icon^="msg-check"], [data-icon^="msg-dblcheck"], [data-icon^="msg-time"], .message-out');
    out.push({ id: id, at: m ? m[1] : '', author: m ? m[2] : '', text: text.slice(0, 8000), quoted: quoted || undefined, kind: kind, outgoing: outgoing });
  }
  return JSON.stringify({ chat: chat, group: group, messages: out });
})()`;

/** Parses the reader's answer; anything malformed is an empty view. */
export function parseWhatsAppView(raw: string): WhatsAppView {
  try {
    const value = JSON.parse(raw);
    const messages = Array.isArray(value?.messages) ? value.messages.filter((entry: any) => entry && typeof entry.id === 'string' && entry.id && typeof entry.text === 'string') : [];
    return { chat: typeof value?.chat === 'string' ? value.chat.trim().slice(0, 300) : '', group: value?.group === true, messages };
  } catch {
    return { chat: '', group: false, messages: [] };
  }
}

/** The capture text for a batch of new messages in one chat. */
export function renderWhatsAppBatch(view: WhatsAppView, messages: WhatsAppMessage[]): string {
  const lines = [`Chat: ${view.chat || '(unknown chat)'} (${view.group ? 'group' : 'direct message'})`, ''];
  for (const message of messages) {
    const who = message.outgoing ? `${message.author || 'Me'} (me)` : (message.author || 'Unknown');
    const tag = message.kind === 'text' ? '' : ` [${message.kind}]`;
    lines.push(`[${message.at}] ${who}${tag}: ${message.text}`.trim());
    if (message.quoted) lines.push(`  > replying to: ${message.quoted}`);
  }
  return lines.join('\n');
}

function shortHash(text: string): string {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(36);
}

/**
 * What one probe of a tab read: everything but the page's HTML, which is read
 * only when a capture will actually be emitted (`readTabHtml`).
 */
interface TabProbe extends StaticProbe {
  /** The tab's address and visibility as the page reports them. */
  href: string;
  /** `visible`, `hidden`, … — `unknown` when the answer was not the expected pair. */
  visibility: string;
  errorPage?: boolean;
  fieldCount: number;
}

function emptyProbe(extra: Partial<TabProbe> = {}): TabProbe {
  return { text: '', proseChars: 0, fieldsChars: 0, fieldCount: 0, fieldSegments: [], href: '', visibility: 'unknown', ...extra };
}

/** Field read of one target: the rendered section plus its fingerprint, or null when unread. */
async function readFields(session: CdpSession): Promise<{ section: string; fingerprint: string; count: number } | null> {
  const parsed = parseFieldsAnswer(await session.eval(FORM_FIELDS_READER, 6000).catch(() => ''));
  if (!parsed) return null;
  return { section: renderFieldsSection(parsed.fields, parsed.truncated), fingerprint: fieldsFingerprint(parsed.fields), count: parsed.fields.length + parsed.truncated };
}

function urlWithoutQuery(url: string): string {
  return url.replace(/[?#].*$/, '');
}

/** The address probe: the page's own address and whether it is visible. */
const HREF_PROBE = 'JSON.stringify([location.href, document.visibilityState])';

/** An answer that is not the expected pair is the address itself (visibility unknown). */
export function parseHrefProbe(raw: string): { href: string; visibility: string } {
  try {
    const value = JSON.parse(raw);
    if (Array.isArray(value) && typeof value[0] === 'string') {
      return { href: value[0], visibility: typeof value[1] === 'string' ? value[1] : 'unknown' };
    }
  } catch { /* not the pair */ }
  return { href: raw, visibility: 'unknown' };
}

/** Thrown by a guarded session when the owner paused capture mid-read. */
class PausedError extends Error {
  constructor() { super('Browser capture is paused'); }
}

/**
 * Phase one of a read: the address, the page text, form fields, and
 * cross-origin frames (each on its own connection). Failure policy, exactly
 * as before the split: the address is tolerated (`''`); the page text is fatal
 * for this tab this poll (logged, empty probe); main fields, frame fields, and
 * frame text are tolerated.
 */
async function readTabProbe(session: CdpSession, tab: TabInfo, openFrame: (wsUrl: string) => CdpSession = openCdpSession): Promise<TabProbe> {
  if (!tab.webSocketDebuggerUrl) return emptyProbe({ unavailable: true });
  try {
    // Use platform-specific extraction for messaging apps
    const url = tab.url;
    let expression: string;
    // Form fields are read on generic pages only: platform compose boxes churn,
    // and those pages have their own readers.
    let generic = false;

    if (/app\.slack\.com|slack\.com\/client/.test(url)) {
      // Slack: extract message content from the active channel
      expression = `(function() {
        const msgs = document.querySelectorAll('.c-message__body, .p-rich_text_section');
        if (msgs.length > 0) {
          return Array.from(msgs).slice(-30).map(el => el.innerText).filter(t => t.trim()).join('\\n');
        }
        return '';
      })()`;
    } else if (/mail\.google\.com/.test(url)) {
      // Gmail: preserve every rendered message body in the open thread. Gmail
      // nests some of these selectors, so keep only leaf matches. Preserve
      // repeated replies as distinct messages; the short DB summary is derived
      // later, while this lossless primary content supports recovery and FTS.
      expression = `(function() {
        const candidates = Array.from(document.querySelectorAll('.a3s.aiL, .ii.gt'));
        const leafBodies = candidates.filter(candidate =>
          !candidates.some(other => other !== candidate && candidate.contains(other))
        );
        const messages = [];
        for (const body of leafBodies) {
          const text = (body.innerText || '').trim();
          if (!text) continue;
          const container = body.closest('.h7, [data-message-id]') || body.parentElement;
          const senderEl = container?.querySelector('.gD');
          const dateEl = container?.querySelector('.g3');
          const sender = senderEl?.getAttribute('email') || senderEl?.innerText?.trim() || '';
          const date = dateEl?.getAttribute('title') || dateEl?.innerText?.trim() || '';
          const header = [sender ? 'From: ' + sender : '', date ? 'Date: ' + date : ''].filter(Boolean).join('\\n');
          messages.push({ text, header });
        }
        if (messages.length > 0) {
          const subject = document.querySelector('h2.hP')?.innerText?.trim() || document.title;
          const transcript = messages.map((message, index) =>
            '--- Message ' + (index + 1) + ' of ' + messages.length + ' ---\\n' +
            (message.header ? message.header + '\\n' : '') + message.text
          ).join('\\n\\n');
          return ('Subject: ' + subject + '\\n\\n' + transcript).trim();
        }
        const subjects = document.querySelectorAll('.bog span, .bqe');
        if (subjects.length > 0) {
          return Array.from(subjects).slice(0, 20).map(el => el.innerText).join('\\n');
        }
        return '';
      })()`;
    } else if (/(?:outlook\.(?:office|live)\.com|outlook\.cloud\.microsoft)\/mail/i.test(url)) {
      // Outlook Web: preserve the whole rendered conversation, not just the
      // first `role=document` body. Outlook commonly leaves all replies in the
      // DOM even when its conversation row is visually collapsed.
      expression = `(function() {
        const subject = document.querySelector('[role="heading"][aria-level="2"], .allowTextSelection[tabindex="-1"] > span, div[class*="subject"]');
        const sender = document.querySelector('[role="heading"][aria-level="3"], span[class*="sender"], div[class*="from"] span');
        const candidates = Array.from(document.querySelectorAll('div[role="document"], div[aria-label="Message body"], div[class*="bodyContent"], div.ReadingPaneContents'));
        const leafBodies = candidates.filter(candidate =>
          !candidates.some(other => other !== candidate && candidate.contains(other))
        );
        const messages = [];
        for (const body of leafBodies) {
          const text = (body.innerText || '').trim();
          if (!text) continue;
          let header = '';
          let ancestor = body.parentElement;
          while (ancestor && ancestor !== document.body) {
            const documentCount = ancestor.querySelectorAll('div[role="document"]').length;
            const ancestorText = ancestor.innerText || '';
            const bodyIndex = ancestorText.indexOf(text);
            if (documentCount === 1 && bodyIndex > 0) {
              const candidate = ancestorText.slice(0, bodyIndex)
                .replace(/[\\uE000-\\uF8FF]/g, ' ')
                .replace(/\\bReply all\\b|\\bReply\\b|\\bForward\\b/gi, ' ')
                .replace(/\\s+/g, ' ')
                .trim();
              if (candidate.length > 0) {
                header = candidate;
                break;
              }
            }
            ancestor = ancestor.parentElement;
          }
          messages.push({ text, header });
        }
        if (subject || messages.length > 0) {
          let result = '';
          if (subject) result += 'Subject: ' + subject.innerText.trim() + '\\n';
          if (sender) result += 'From: ' + sender.innerText.trim() + '\\n';
          if (messages.length > 0) {
            result += '\\n' + messages.map((message, index) =>
              '--- Message ' + (index + 1) + ' of ' + messages.length + ' ---\\n' +
              (message.header ? 'Header: ' + message.header + '\\n' : '') + message.text
            ).join('\\n\\n');
          }
          return result.trim();
        }
        // Fallback: inbox list view — grab visible email subjects only when no
        // reading-pane message bodies are available.
        const rows = document.querySelectorAll('[role="option"], [data-convid], div[class*="listItem"]');
        if (rows.length > 0) {
          return Array.from(rows).slice(0, 20).map(el => el.innerText.replace(/\\n+/g, ' | ').substring(0, 200)).join('\\n');
        }
        return document.body.innerText;
      })()`;
    } else {
      // Generic: tiered extraction (main content, else the page without its
      // chrome), shadow-DOM aware (web-component apps render inside open
      // shadow roots, which innerText never enters), plus same-origin iframes.
      // Cross-origin iframes are read separately as their own targets.
      expression = GENERIC_PAGE_TEXT;
      generic = true;
    }

    // A browser error page ("This site can't be reached") is not content.
    const { href, visibility } = parseHrefProbe(await session.eval(HREF_PROBE, 4000).catch(() => ''));
    if (/^chrome-error:/i.test(href)) return emptyProbe({ errorPage: true, href, visibility });
    const prose = await session.eval(expression);
    const fieldSegments: Array<[string, string | null]> = [];
    let fieldsChars = 0;
    let fieldCount = 0;
    let mainFields = '';
    if (generic) {
      const main = await readFields(session);
      fieldSegments.push(['main', main?.fingerprint ?? null]);
      if (main?.section) {
        mainFields = main.section;
        fieldsChars += main.section.length;
        fieldCount += main.count;
      }
    }
    // Cross-origin frames (Office/SharePoint viewers, embedded dashboards).
    const seenFrameText = new Set<string>();
    let frameChars = 0;
    const frameBlocks: string[] = [];
    let proseChars = prose.length;
    for (const [index, frame] of tab.frames.entries()) {
      const frameSession = openFrame(frame.webSocketDebuggerUrl);
      try {
        const frameFields = generic ? await readFields(frameSession) : null;
        if (generic) fieldSegments.push([`frame:${index}:${urlWithoutQuery(frame.url)}`, frameFields?.fingerprint ?? null]);
        const fieldsBlock = frameFields?.section ?? '';
        let kept = '';
        if (frameChars < MAX_FRAMES_TEXT) {
          const frameText = (await frameSession.eval(GENERIC_PAGE_TEXT, 6000).catch(() => '')).trim();
          // Tiny frames are widgets (a button, a counter); repeated ones add nothing.
          if (frameText.length >= 40 && !seenFrameText.has(frameText) && !prose.includes(frameText)) {
            seenFrameText.add(frameText);
            kept = frameText.slice(0, Math.min(MAX_FRAME_CHARS, MAX_FRAMES_TEXT - frameChars));
            frameChars += kept.length;
          }
        }
        if (!kept && !fieldsBlock) continue;
        proseChars += kept.length;
        fieldsChars += fieldsBlock.length;
        fieldCount += frameFields?.count ?? 0;
        frameBlocks.push(`[frame ${frame.url.slice(0, 200)}]\n${[kept, fieldsBlock].filter(Boolean).join('\n\n')}`);
      } finally {
        frameSession.close();
      }
    }
    const text = [prose, mainFields, ...frameBlocks].filter(part => part.trim()).join('\n\n');
    return { text, proseChars, fieldsChars, fieldCount, fieldSegments, href, visibility };
  } catch (err) {
    if (err instanceof PausedError) throw err;
    console.error(`Content extraction failed for ${tab.url}:`, (err as Error).message);
    return emptyProbe({ unavailable: true });
  }
}

/**
 * Phase two of a read, run only when a capture will be emitted: the ENTIRE
 * document HTML plus same-origin iframe documents, losslessly (no caps — the
 * ContentStore blobs large pages). Serialized from a clone with hidden-input
 * values removed and withheld fields blanked; the final string also passes the
 * secret-format redaction. Best-effort: a failed read is `''` and the text
 * capture stands on its own.
 */
const PAGE_HTML_READER = `(function() {${HTML_FIELD_REDACTION_SNIPPET}
        var h = botboyRedactedHtml(document.documentElement);
        document.querySelectorAll('iframe').forEach(function(f, i) {
          try {
            var d = f.contentDocument && f.contentDocument.documentElement ? botboyRedactedHtml(f.contentDocument.documentElement) : '';
            if (d) h += '\\n<!-- botboy:iframe[' + i + '] src=' + (f.src || '') + ' -->\\n' + d;
          } catch (e) {}
        });
        return h;
      })()`;

async function readTabHtml(session: CdpSession): Promise<string> {
  try {
    return redactSecrets(await session.eval(PAGE_HTML_READER, 15000));
  } catch {
    return ''; // raw html is best-effort; text capture stands on its own
  }
}
// URLs that should be re-polled for content changes (dynamic pages)
const DYNAMIC_URL_PATTERNS = [
  /app\.slack\.com/,
  /slack\.com\/client/,
  /mail\.google\.com/,
  /(?:outlook\.(?:office|live)\.com|outlook\.cloud\.microsoft)\/mail/i,
];

function isDynamicPage(url: string): boolean {
  return DYNAMIC_URL_PATTERNS.some(p => p.test(url));
}

export function createBrowserMonitor(config?: Partial<BrowserMonitorConfig>): BrowserMonitor {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const listeners: ((item: RawWorkItem) => void)[] = [];
  const now = cfg.now ?? Date.now;
  const maxPollWallMs = cfg.maxPollWallMs ?? DEFAULT_MAX_POLL_WALL_MS;
  const baseMs = cfg.pollIntervalMs;
  const governor = cfg.adaptive ? createPollGovernor({ baseMs }) : null;
  const maxTabsPerPoll = cfg.maxTabsPerPoll ?? 12;
  let planState = initialPlanState();
  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  let running = false;
  let generation = 0;
  let inFlight: Promise<void> | null = null;
  let chainBusy = false;
  let wakePending = false;
  let lastPoll: Pick<BrowserCaptureStatus, 'lastPollMs' | 'lastPollAt' | 'tabsSeen' | 'tabsRead' | 'tabsDeferred'> = {
    lastPollMs: null, lastPollAt: null, tabsSeen: 0, tabsRead: 0, tabsDeferred: 0,
  };

  /** The owner's pause, read fresh each time; a failing getter never pauses capture. */
  function paused(): boolean {
    try { return cfg.isPaused?.() === true; } catch { return false; }
  }

  /** A session that refuses every call once capture is paused. */
  function guarded(session: CdpSession): CdpSession {
    if (!cfg.isPaused) return session;
    return {
      eval: (expression, timeout) => (paused() ? Promise.reject(new PausedError()) : session.eval(expression, timeout)),
      get bytes() { return session.bytes; },
      close: () => session.close(),
    };
  }
  const openGuarded = (wsUrl: string): CdpSession => guarded(openCdpSession(wsUrl));

  const currentInterval = (): number => governor?.intervalMs() ?? cfg.pollIntervalMs;

  function status(): BrowserCaptureStatus {
    return {
      paused: paused(),
      intervalMs: currentInterval(),
      baseIntervalMs: baseMs,
      slowedReason: governor?.reason() ?? null,
      ...lastPoll,
    };
  }

  function notifyStatus(): void {
    try { cfg.onStatusChange?.(status()); } catch (err) { console.error('BrowserMonitor status listener error:', err); }
  }

  function sampleSystem(): { pressure: MemoryPressure; loadPerCpu: number } {
    try {
      return cfg.sampleSystem?.() ?? { pressure: readMemoryPressure(), loadPerCpu: loadPerCpu() };
    } catch {
      return { pressure: 'normal', loadPerCpu: 0 };
    }
  }
  // For dynamic pages: store last content hash to detect changes
  let lastDynamicContent = new Map<string, string>();

  function emit(item: RawWorkItem): void {
    for (const fn of listeners) {
      try { fn(item); } catch (err) { console.error('BrowserMonitor listener error:', err); }
    }
  }

  /** Static pages: polls spent waiting for real text, and what was captured (see `browser-capture-decision.ts`). */
  const settleAttempts = new Map<string, number>();
  const captured = new Map<string, CapturedState>();
  const lastSegments = new Map<string, Map<string, string>>();
  const maxSettleAttempts = cfg.maxSettleAttempts ?? 6;

  function staticStateFor(url: string): StaticTabState {
    return { captured: captured.get(url), lastSegments: lastSegments.get(url), settleAttempts: settleAttempts.get(url) ?? 0 };
  }

  /** Applies a decision's next state; `evict` only when a capture was emitted (bounds the maps). */
  function applyStaticState(url: string, next: StaticTabState, evict: boolean): void {
    if (next.settleAttempts > 0) settleAttempts.set(url, next.settleAttempts); else settleAttempts.delete(url);
    if (next.lastSegments) lastSegments.set(url, next.lastSegments); else lastSegments.delete(url);
    if (next.captured) captured.set(url, next.captured);
    if (!evict) return;
    if (captured.size > 5000) {
      for (const key of [...captured.keys()].slice(0, 2500)) captured.delete(key);
    }
    if (lastSegments.size > 5000) {
      for (const key of [...lastSegments.keys()].slice(0, 2500)) lastSegments.delete(key);
    }
  }

  /** WhatsApp message ids already captured this process (the store check covers restarts). */
  const seenWhatsApp = new Set<string>();

  async function captureWhatsApp(tab: TabInfo): Promise<void> {
    const raw = await cdpEval(tab.webSocketDebuggerUrl, WHATSAPP_READER).catch(() => '');
    if (paused()) return; // nothing is marked seen, so it is read when capture resumes
    const view = parseWhatsAppView(raw);
    if (!view.chat || !view.messages.length) return;
    const fresh = view.messages.filter((message) => {
      if (seenWhatsApp.has(message.id)) return false;
      seenWhatsApp.add(message.id);
      return !cfg.hasCaptured?.(whatsAppMessageUrl(message.id));
    });
    if (seenWhatsApp.size > 20_000) {
      for (const id of [...seenWhatsApp].slice(0, 10_000)) seenWhatsApp.delete(id);
    }
    for (const message of fresh.slice(-200)) {
      emit({
        type: 'whatsapp_message',
        source: 'browser',
        sourceApp: 'WhatsApp',
        url: whatsAppMessageUrl(message.id),
        title: view.chat,
        content: renderWhatsAppBatch(view, [message]),
        metadata: {
          conversationName: view.chat,
          chatType: view.group ? 'group' : 'direct',
          author: message.author,
          direction: message.outgoing ? 'sent' : 'received',
          messageAt: message.at,
          messageKind: message.kind,
          whatsappMessageId: message.id,
          chatKey: shortHash(view.chat),
          captureMode: 'passive_observation',
        },
        capturedAt: new Date(),
      });
    }
    if (fresh.length) console.log(`📄 Captured [whatsapp_message] ${fresh.length} new in "${view.chat.slice(0, 40)}"`);
  }

  /** PDF tab addresses already read this process (the store check covers restarts). */
  const seenPdf = new Set<string>();

  async function capturePdf(tab: TabInfo): Promise<void> {
    if (!cfg.readPdf || seenPdf.has(tab.url)) return;
    seenPdf.add(tab.url);
    if (cfg.hasCaptured?.(tab.url)) return;
    const base64 = await cdpEval(tab.webSocketDebuggerUrl, PDF_BYTES_READER, 30000).catch(() => '');
    if (paused()) { seenPdf.delete(tab.url); return; }
    const bytes = Buffer.from(base64, 'base64');
    if (bytes.length < 5 || bytes.subarray(0, 5).toString('latin1') !== '%PDF-') {
      seenPdf.delete(tab.url); // not loaded yet, or not a PDF: try next poll
      return;
    }
    const content = (await cfg.readPdf(bytes).catch(() => '')).trim();
    if (paused()) { seenPdf.delete(tab.url); return; }
    if (!content) {
      console.log(`📄 PDF tab had no readable text: ${tab.url.slice(0, 100)}`);
      return;
    }
    let title = tab.title;
    if (!title || title.includes('/') ) {
      try { title = decodeURIComponent(new URL(tab.url).pathname.split('/').pop() || tab.url); } catch { title = tab.url; }
    }
    emit({
      type: 'website_visit',
      source: 'browser',
      sourceApp: 'Chrome',
      url: tab.url,
      title,
      content,
      metadata: { captureMode: 'passive_observation', contentKind: 'pdf', pdfBytes: String(bytes.length) },
      capturedAt: new Date(),
    });
    console.log(`📄 Captured [pdf] ${title.slice(0, 60)} (${content.length} chars text, ${bytes.length} bytes)`);
  }

  /** What one poll learned about its tabs (measurement; the governor reads the probe times). */
  interface PollRecord {
    perTab: PollTabStat[];
    /** Probe times of tabs whose text was read (a timed-out or unreadable tab is left out). */
    probeMs: number[];
  }

  /**
   * One tab, in two phases. Phase one (the probe) reads text and fields;
   * the decision is made from it; phase two (the HTML) is read only when a
   * capture will be emitted. `late()` is true once the poll has used its wall
   * budget and this is not the poll's first tab: the tab is then left for the
   * next poll with none of its remembered state advanced. While capture is
   * paused a tab is left alone the same way: no read, no state change, no emit.
   */
  async function pollTab(tab: TabInfo, late: () => boolean, record: PollRecord): Promise<void> {
    if (paused()) return;
    if (/^https:\/\/web\.whatsapp\.com\//.test(tab.url)) {
      const startedAt = now();
      await captureWhatsApp(tab);
      record.perTab.push({ id: String(tab.id), phase: 'whatsapp', ms: now() - startedAt, bytes: 0 });
      return;
    }
    if (isPdfTab(tab)) {
      const startedAt = now();
      await capturePdf(tab);
      record.perTab.push({ id: String(tab.id), phase: 'pdf', ms: now() - startedAt, bytes: 0 });
      return;
    }
    const dynamic = isDynamicPage(tab.url);
    // A static page settled and re-captured enough: leave it.
    if (!dynamic && isStaticCaptureExhausted(staticStateFor(tab.url))) return;

    await withTabSession(tab, async (rawSession) => {
      const session = guarded(rawSession);
      const probeStartedAt = now();
      const probe = await readTabProbe(session, tab, openGuarded);
      const probeMs = now() - probeStartedAt;
      record.perTab.push({ id: String(tab.id), phase: 'probe', ms: probeMs, bytes: session.bytes });
      if (paused()) return; // a pause mid-read: nothing read counts
      if (!probe.unavailable) {
        record.probeMs.push(probeMs);
        if (probe.visibility === 'visible' || probe.visibility === 'unknown') planState.lastVisibleId = String(tab.id);
      }
      if (probe.errorPage) return; // not content; checked again next poll
      let content = probe.text.trim();
      let html: string | undefined;

      const readHtml = async (): Promise<string> => {
        const startedAt = now();
        const bytesBefore = session.bytes;
        const result = await readTabHtml(session);
        record.perTab.push({ id: String(tab.id), phase: 'html', ms: now() - startedAt, bytes: session.bytes - bytesBefore });
        return result;
      };

      if (!dynamic) {
        const state = staticStateFor(tab.url);
        let decision = decideStaticCapture({ state, probe, maxSettleAttempts });
        if (decision.action === 'need-html') {
          if (late() || paused()) return;
          html = await readHtml();
          decision = decideStaticCapture({ state, probe, html, maxSettleAttempts });
        }
        if (decision.action !== 'emit') {
          if (paused()) return;
          applyStaticState(tab.url, decision.next, false);
          return;
        }
        if (html === undefined) {
          if (late() || paused()) return;
          // A tab whose text could not be read has no HTML read either (as before the split).
          html = probe.unavailable ? '' : await readHtml();
        }
        // Immediately before the emit: a pause that arrived during the HTML read wins.
        if (paused()) return;
        applyStaticState(tab.url, decision.next, true);
        content = decision.content;
      } else {
        const decision = decideDynamicCapture(lastDynamicContent.get(tab.url), content);
        if (decision.action !== 'emit') return;
        if (late() || paused()) return;
        html = await readHtml();
        if (paused()) return;
        lastDynamicContent.set(tab.url, decision.hash);
      }

      const { type, metadata } = detectPlatform(tab.url, tab.title);

      const item: RawWorkItem = {
        type,
        source: 'browser',
        sourceApp: 'Chrome',
        url: tab.url,
        title: tab.title,
        content: content || undefined,
        rawHtml: html || undefined,
        metadata: {
          ...metadata,
          captureMode: 'passive_observation',
          ...(tab.frames.length ? { frames: String(tab.frames.length) } : {}),
          ...(type === 'slack_message' ? { direction: 'observed' } : {}),
        },
        capturedAt: new Date(),
      };

      emit(item);
      console.log(`📄 Captured [${type}] ${tab.title.slice(0, 60)} (${content.length} chars text, ${(html ?? '').length} chars html${probe.fieldCount ? `, ${probe.fieldCount} field${probe.fieldCount === 1 ? '' : 's'}` : ''}${tab.frames.length ? `, ${tab.frames.length} frame${tab.frames.length === 1 ? '' : 's'}` : ''})`);
    });
  }

  /** What the planner needs to know about a tab, from the remembered state. */
  type PlannedBrowserTab = PlannedTab & { tab: TabInfo };

  function describeTab(tab: TabInfo): PlannedBrowserTab {
    const url = tab.url;
    const whatsApp = /^https:\/\/web\.whatsapp\.com\//.test(url);
    const pdf = !whatsApp && isPdfTab(tab);
    const dynamic = !whatsApp && !pdf && isDynamicPage(url);
    const staticTab = !whatsApp && !pdf && !dynamic;
    const state = staticTab ? staticStateFor(url) : null;
    return {
      id: String(tab.id),
      tab,
      firstSight: !!state && !state.captured,
      pendingFields: !!state?.captured?.pendingFields,
      alwaysServe: whatsApp || dynamic || (pdf && !!cfg.readPdf && !seenPdf.has(url)),
      // Reading these costs nothing: a settled static page, or a PDF already read (or unreadable here).
      capped: (!!state && isStaticCaptureExhausted(state)) || (pdf && (!cfg.readPdf || seenPdf.has(url))),
    };
  }

  async function runPoll(): Promise<void> {
    // Paused: not even the tab list is fetched.
    if (paused()) return;
    const startedAt = now();
    const tabs = await fetchTabs(cfg.cdpEndpoint, cfg.shouldSkipTarget);
    // Calm (or ungoverned): Chrome's order, every tab. Slowed: the planner's soft budget.
    const slowed = governor?.slowed() === true;
    const plan = governor && slowed
      ? planTabReads(tabs.map(describeTab), planState, { slowed: true, maxTabsPerPoll })
      : null;
    if (plan) planState = plan.state;
    const order = plan ? plan.order.map(entry => entry.tab) : tabs;
    const record: PollRecord = { perTab: [], probeMs: [] };
    let started = 0;
    // The wall bound is checked between tabs and phases; a poll's first tab is
    // always read in full, so a slow tab cannot starve itself.
    const overBudget = () => now() - startedAt >= maxPollWallMs;
    const late = () => started > 1 && overBudget();
    for (const tab of order) {
      if (paused()) break;
      if (started > 0 && overBudget()) {
        console.log(`[BrowserMonitor] poll used its ${Math.round(maxPollWallMs / 1000)}s budget; ${order.length - started} tab(s) wait for the next poll`);
        break;
      }
      started++;
      try {
        await pollTab(tab, late, record);
      } catch (err) {
        if (err instanceof PausedError) break;
        throw err;
      }
    }
    if (paused()) return;
    const wallMs = now() - startedAt;
    lastPoll = { lastPollMs: wallMs, lastPollAt: now(), tabsSeen: tabs.length, tabsRead: started, tabsDeferred: tabs.length - started };
    try {
      cfg.onPollStats?.({ wallMs, tabsSeen: tabs.length, tabsRead: started, tabsDeferred: tabs.length - started, perTab: record.perTab });
    } catch (err) { console.error('BrowserMonitor stats listener error:', err); }
    if (governor) {
      const system = sampleSystem();
      const result = governor.observe({ wallMs, medianProbeMs: medianOf(record.probeMs), pressure: system.pressure, loadPerCpu: system.loadPerCpu });
      if (result.changed) notifyStatus();
    }
  }

  /**
   * One poll; a poll never overlaps itself (a caller during a poll gets that
   * poll's completion). A wake() that arrived during it adds exactly one more.
   */
  function pollOnce(): Promise<void> {
    if (inFlight) return inFlight;
    const run = (async () => {
      do {
        wakePending = false;
        await runPoll();
      } while (wakePending && running);
    })().finally(() => { if (inFlight === run) inFlight = null; });
    inFlight = run;
    return run;
  }

  async function tick(mine: number): Promise<void> {
    pollTimer = null;
    chainBusy = true;
    try {
      await pollOnce();
      while (wakePending && running && mine === generation) await pollOnce();
    } catch (err) { console.error(err); }
    chainBusy = false;
    if (running && mine === generation) pollTimer = setTimeout(() => { void tick(mine); }, currentInterval());
  }

  return {
    /** Starts polling; the first poll is fired, not awaited, so a slow Chrome cannot stall boot. */
    async start(): Promise<void> {
      if (running) return;
      running = true;
      void tick(++generation);
    },

    stop(): void {
      running = false;
      wakePending = false;
      if (pollTimer) {
        clearTimeout(pollTimer);
        pollTimer = null;
      }
    },

    onWorkItem(callback: (item: RawWorkItem) => void): void {
      listeners.push(callback);
    },

    pollOnce,

    wake(): void {
      if (!running) return;
      if (governor) {
        const result = governor.reset();
        if (result.changed) notifyStatus();
      }
      if (inFlight || chainBusy) {
        wakePending = true;
        return;
      }
      if (pollTimer) {
        clearTimeout(pollTimer);
        pollTimer = null;
      }
      void tick(generation);
    },

    status,
  };
}
