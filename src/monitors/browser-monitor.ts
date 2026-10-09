/**
 * Browser Monitor — tracks browser activity via Chrome DevTools Protocol.
 *
 * Connects to a running Chrome instance (debug port 9222) and:
 * 1. Polls /json/list for open tabs
 * 2. Connects to each new tab via CDP WebSocket
 * 3. Extracts visible text content using Runtime.evaluate
 * 4. Detects platform-specific pages by URL pattern
 */

import WebSocket from 'ws';
import type { RawWorkItem, WorkItemType } from '../core/types.js';
import { htmlToText } from '../core/email-capture.js';

export interface BrowserMonitor {
  start(): Promise<void>;
  stop(): void;
  onWorkItem(callback: (item: RawWorkItem) => void): void;
  /** One poll now (tests; the timer calls the same). */
  pollOnce(): Promise<void>;
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

/** Below this, a page is still rendering (or is a shell) and is checked again. */
export const THIN_PAGE_CHARS = 200;
/** A captured static page is captured again once its text grows this much (an app that kept rendering). */
const GROWTH_RATIO = 1.5;
const GROWTH_MIN_CHARS = 300;
const MAX_RECAPTURES = 3;

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
    const resp = await fetch(`${endpoint}/json/list`);
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
    var outgoing = !!row.querySelector('[data-icon^="tail-out"], [data-icon^="msg-check"], [data-icon^="msg-dblcheck"], [data-icon^="msg-time"], .message-out');
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

async function extractPageContent(tab: TabInfo): Promise<{ text: string; html: string; errorPage?: boolean }> {
  if (!tab.webSocketDebuggerUrl) return { text: '', html: '' };
  try {
    // Use platform-specific extraction for messaging apps
    const url = tab.url;
    let expression: string;

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
    }

    // A browser error page ("This site can't be reached") is not content.
    const href = await cdpEval(tab.webSocketDebuggerUrl, 'String(location.href)', 4000).catch(() => '');
    if (/^chrome-error:/i.test(href)) return { text: '', html: '', errorPage: true };
    let text = await cdpEval(tab.webSocketDebuggerUrl, expression);
    // Cross-origin frames (Office/SharePoint viewers, embedded dashboards).
    const seenFrameText = new Set<string>();
    let frameChars = 0;
    for (const frame of tab.frames) {
      if (frameChars >= MAX_FRAMES_TEXT) break;
      const frameText = (await cdpEval(frame.webSocketDebuggerUrl, GENERIC_PAGE_TEXT, 6000).catch(() => '')).trim();
      // Tiny frames are widgets (a button, a counter); repeated ones add nothing.
      if (frameText.length < 40 || seenFrameText.has(frameText) || text.includes(frameText)) continue;
      seenFrameText.add(frameText);
      const kept = frameText.slice(0, Math.min(MAX_FRAME_CHARS, MAX_FRAMES_TEXT - frameChars));
      frameChars += kept.length;
      text += `${text ? '\n\n' : ''}[frame ${frame.url.slice(0, 200)}]\n${kept}`;
    }
    // Raw page capture: the ENTIRE document HTML plus same-origin iframe
    // documents, losslessly (no caps — the ContentStore blobs large pages).
    let html = '';
    try {
      html = await cdpEval(tab.webSocketDebuggerUrl, `(function() {
        var h = document.documentElement ? document.documentElement.outerHTML : '';
        document.querySelectorAll('iframe').forEach(function(f, i) {
          try {
            var d = f.contentDocument && f.contentDocument.documentElement ? f.contentDocument.documentElement.outerHTML : '';
            if (d) h += '\\n<!-- botboy:iframe[' + i + '] src=' + (f.src || '') + ' -->\\n' + d;
          } catch (e) {}
        });
        return h;
      })()`, 15000);
    } catch { /* raw html is best-effort; text capture stands on its own */ }

    return { text, html };
  } catch (err) {
    console.error(`Content extraction failed for ${tab.url}:`, (err as Error).message);
    return { text: '', html: '' };
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
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  // For dynamic pages: store last content hash to detect changes
  let lastDynamicContent = new Map<string, string>();

  function emit(item: RawWorkItem): void {
    for (const fn of listeners) {
      try { fn(item); } catch (err) { console.error('BrowserMonitor listener error:', err); }
    }
  }

  function simpleHash(text: string): string {
    let h = 0;
    for (let i = 0; i < text.length; i++) {
      h = ((h << 5) - h + text.charCodeAt(i)) | 0;
    }
    return h.toString(36);
  }

  /** Static pages: polls spent waiting for real text, and what was captured. */
  const settleAttempts = new Map<string, number>();
  const captured = new Map<string, { chars: number; recaptures: number }>();
  const maxSettleAttempts = cfg.maxSettleAttempts ?? 6;

  /** WhatsApp message ids already captured this process (the store check covers restarts). */
  const seenWhatsApp = new Set<string>();

  async function captureWhatsApp(tab: TabInfo): Promise<void> {
    const raw = await cdpEval(tab.webSocketDebuggerUrl, WHATSAPP_READER).catch(() => '');
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
    const bytes = Buffer.from(base64, 'base64');
    if (bytes.length < 5 || bytes.subarray(0, 5).toString('latin1') !== '%PDF-') {
      seenPdf.delete(tab.url); // not loaded yet, or not a PDF: try next poll
      return;
    }
    const content = (await cfg.readPdf(bytes).catch(() => '')).trim();
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

  async function pollOnce(): Promise<void> {
    const tabs = await fetchTabs(cfg.cdpEndpoint, cfg.shouldSkipTarget);
    for (const tab of tabs) {
      if (/^https:\/\/web\.whatsapp\.com\//.test(tab.url)) {
        await captureWhatsApp(tab);
        continue;
      }
      if (isPdfTab(tab)) {
        await capturePdf(tab);
        continue;
      }
      const dynamic = isDynamicPage(tab.url);
      const previous = captured.get(tab.url);
      // A static page settled and re-captured enough: leave it.
      if (!dynamic && previous && previous.recaptures >= MAX_RECAPTURES) continue;

      // Extract actual page content via CDP
      const extracted = await extractPageContent(tab);
      if (extracted.errorPage) continue; // not content; checked again next poll
      let content = extracted.text.trim();
      const html = extracted.html;

      if (!dynamic) {
        // An app still rendering returns a shell ("Loading…") or nothing.
        // Wait for real text a few polls before settling for what there is;
        // the page's HTML is the last resort (text read from it here).
        if (content.length < THIN_PAGE_CHARS && !previous) {
          const attempts = (settleAttempts.get(tab.url) ?? 0) + 1;
          settleAttempts.set(tab.url, attempts);
          if (attempts < maxSettleAttempts) continue;
          if (!content && html) content = htmlToText(html).trim();
          if (!content) continue;
        }
        if (previous) {
          // Captured before: only a page that kept rendering much more text is captured again.
          if (!(content.length >= previous.chars * GROWTH_RATIO && content.length - previous.chars >= GROWTH_MIN_CHARS)) continue;
        }
        settleAttempts.delete(tab.url);
        captured.set(tab.url, { chars: content.length, recaptures: previous ? previous.recaptures + 1 : 0 });
        if (captured.size > 5000) {
          for (const key of [...captured.keys()].slice(0, 2500)) captured.delete(key);
        }
      }

      if (dynamic) {
        if (!content) continue;
        // Only emit if content actually changed
        const hash = simpleHash(content);
        if (lastDynamicContent.get(tab.url) === hash) continue;
        lastDynamicContent.set(tab.url, hash);
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
      console.log(`📄 Captured [${type}] ${tab.title.slice(0, 60)} (${content.length} chars text, ${html.length} chars html${tab.frames.length ? `, ${tab.frames.length} frame${tab.frames.length === 1 ? '' : 's'}` : ''})`);
    }
  }

  return {
    async start(): Promise<void> {
      await pollOnce();
      pollTimer = setInterval(() => { pollOnce().catch(console.error); }, cfg.pollIntervalMs);
    },

    stop(): void {
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
    },

    onWorkItem(callback: (item: RawWorkItem) => void): void {
      listeners.push(callback);
    },

    pollOnce,
  };
}
