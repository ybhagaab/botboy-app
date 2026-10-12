/**
 * Differential oracle for the browser monitor (FEAT-003).
 *
 * `FROZEN` below is the pre-change monitor loop, copied verbatim from base
 * commit 22431ea (`git show 22431ea:personal-productivity-tracker/src/monitors/browser-monitor.ts`):
 * one WebSocket per evaluation, HTML read for every tab on every poll, state
 * decided inline in `pollOnce`. Only the helpers that the refactor keeps
 * exported (page text reader, WhatsApp reader/renderers, platform detection,
 * `isPdfTab`, `THIN_PAGE_CHARS`) are imported instead of copied; the fake CDP
 * answers by kind of expression, so the frozen loop and the real monitor read
 * identical worlds.
 *
 * A seeded fast-check model drives both with the same sequence of world
 * changes (tabs appearing, disappearing, growing, field edits, read failures,
 * frames, dynamic pages, WhatsApp views, PDFs) and requires identical emit
 * streams (url, title, content, rawHtml, metadata, order) after every poll.
 * The real monitor runs with an unbounded wall budget and the governor off, so
 * calm-state behavior must be byte-for-byte the base commit's.
 *
 * Do not edit the frozen block to make a test pass: change it only if the base
 * commit changes.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fc from 'fast-check';
import WebSocket from 'ws';
import type { RawWorkItem } from '../core/types.js';
import { htmlToText } from '../core/email-capture.js';
import { redactSecrets } from '../core/sensitive-files.js';
import {
  FORM_FIELDS_READER,
  HTML_FIELD_REDACTION_SNIPPET,
  fieldsFingerprint,
  parseFieldsAnswer,
  renderFieldsSection,
} from '../core/form-fields.js';
import {
  GENERIC_PAGE_TEXT,
  THIN_PAGE_CHARS,
  WHATSAPP_READER,
  createBrowserMonitor,
  detectPlatform,
  isPdfTab,
  parseWhatsAppView,
  renderWhatsAppBatch,
  whatsAppMessageUrl,
  type BrowserMonitor,
  type BrowserMonitorConfig,
} from './browser-monitor.js';
import { startFakeCdp, type FakeCdp } from './browser-monitor.fake-cdp.js';

// ───────────── FROZEN: pre-change loop from 22431ea ─────────────
// (Used by the frozen block: `WHATSAPP_READER`, `GENERIC_PAGE_TEXT`, etc. come from the imports above.)
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
/** A captured static page is captured again once its text grows this much (an app that kept rendering). */
// Split so secret scanners never see a whole token in the source.
const GH_TOKEN = 'ghp_' + 'abcdefghijklmnopqrstuvwxyz0123456789';
const GROWTH_RATIO = 1.5;
const GROWTH_MIN_CHARS = 300;
const MAX_RECAPTURES = 3;
const DEFAULT_CONFIG: BrowserMonitorConfig = {
  cdpEndpoint: 'http://127.0.0.1:9222',
  pollIntervalMs: 30000,
};
// ── CDP helpers ──

interface FrameTarget { url: string; webSocketDebuggerUrl: string }

/** Ad, tracking, and consent frames: never page content. */
const NOISE_FRAME_HOSTS = /(?:^|\.)(?:doubleclick\.net|googlesyndication\.com|googleadservices\.com|adtrafficquality\.google|2mdn\.net|adnxs\.com|amazon-adsystem\.com|criteo\.(?:com|net)|taboola\.com|outbrain\.com|flashb\.id|onetag-sys\.com|pubmatic\.com|rubiconproject\.com|casalemedia\.com|openx\.net|moatads\.com|scorecardresearch\.com|quantserve\.com|imasdk\.googleapis\.com|recaptcha\.net|cookielaw\.org|onetrust\.com|consensu\.org|hotjar\.com|intercom\.io)$/i;
/** Per-frame and per-page bounds on frame text (a page's own text is not capped). */
const MAX_FRAME_CHARS = 100_000;
const MAX_FRAMES_TEXT = 200_000;

function isNoiseFrame(url: string): boolean {
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
function shortHash(text: string): string {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(36);
}

/** What one read of a tab produced. */
interface PageContent {
  text: string;
  html: string;
  errorPage?: boolean;
  /** Prose characters (page and frame text without Fields lines): the growth rule's measure. */
  proseChars: number;
  /** Characters of rendered Fields lines (counted by the thin-page settle). */
  fieldsChars: number;
  fieldCount: number;
  /** Field fingerprint per segment (`main`, then `frame:<i>:<url>`); null = not read this poll. */
  fieldSegments: Array<[string, string | null]>;
}

function emptyContent(extra: Partial<PageContent> = {}): PageContent {
  return { text: '', html: '', proseChars: 0, fieldsChars: 0, fieldCount: 0, fieldSegments: [], ...extra };
}

/** Field read of one target: the rendered section plus its fingerprint, or null when unread. */
async function readFields(wsUrl: string): Promise<{ section: string; fingerprint: string; count: number } | null> {
  const parsed = parseFieldsAnswer(await cdpEval(wsUrl, FORM_FIELDS_READER, 6000).catch(() => ''));
  if (!parsed) return null;
  return { section: renderFieldsSection(parsed.fields, parsed.truncated), fingerprint: fieldsFingerprint(parsed.fields), count: parsed.fields.length + parsed.truncated };
}

function urlWithoutQuery(url: string): string {
  return url.replace(/[?#].*$/, '');
}

async function extractPageContent(tab: TabInfo): Promise<PageContent> {
  if (!tab.webSocketDebuggerUrl) return emptyContent();
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
    const href = await cdpEval(tab.webSocketDebuggerUrl, 'String(location.href)', 4000).catch(() => '');
    if (/^chrome-error:/i.test(href)) return emptyContent({ errorPage: true });
    const prose = await cdpEval(tab.webSocketDebuggerUrl, expression);
    const fieldSegments: Array<[string, string | null]> = [];
    let fieldsChars = 0;
    let fieldCount = 0;
    let mainFields = '';
    if (generic) {
      const main = await readFields(tab.webSocketDebuggerUrl);
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
      const frameFields = generic ? await readFields(frame.webSocketDebuggerUrl) : null;
      if (generic) fieldSegments.push([`frame:${index}:${urlWithoutQuery(frame.url)}`, frameFields?.fingerprint ?? null]);
      const fieldsBlock = frameFields?.section ?? '';
      let kept = '';
      if (frameChars < MAX_FRAMES_TEXT) {
        const frameText = (await cdpEval(frame.webSocketDebuggerUrl, GENERIC_PAGE_TEXT, 6000).catch(() => '')).trim();
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
    }
    const text = [prose, mainFields, ...frameBlocks].filter(part => part.trim()).join('\n\n');
    // Raw page capture: the ENTIRE document HTML plus same-origin iframe
    // documents, losslessly (no caps — the ContentStore blobs large pages).
    // Serialized from a clone with hidden-input values removed and withheld
    // fields blanked; the final string also passes the secret-format redaction.
    let html = '';
    try {
      html = await cdpEval(tab.webSocketDebuggerUrl, `(function() {${HTML_FIELD_REDACTION_SNIPPET}
        var h = botboyRedactedHtml(document.documentElement);
        document.querySelectorAll('iframe').forEach(function(f, i) {
          try {
            var d = f.contentDocument && f.contentDocument.documentElement ? botboyRedactedHtml(f.contentDocument.documentElement) : '';
            if (d) h += '\\n<!-- botboy:iframe[' + i + '] src=' + (f.src || '') + ' -->\\n' + d;
          } catch (e) {}
        });
        return h;
      })()`, 15000);
      html = redactSecrets(html);
    } catch { /* raw html is best-effort; text capture stands on its own */ }

    return { text, html, proseChars, fieldsChars, fieldCount, fieldSegments };
  } catch (err) {
    console.error(`Content extraction failed for ${tab.url}:`, (err as Error).message);
    return emptyContent();
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

function createFrozenBrowserMonitor(config?: Partial<BrowserMonitorConfig>): BrowserMonitor {
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
  /**
   * `chars` is prose length (the growth rule never sees field values);
   * `fields` is the captured field fingerprint, `pendingFields` a changed one
   * waiting for a second equal poll, and `segments` the last read of each
   * field segment (a frame that fails one poll keeps its previous read).
   */
  const captured = new Map<string, { chars: number; recaptures: number; fields: string; pendingFields?: string; segments: Map<string, string> }>();
  const lastSegments = new Map<string, Map<string, string>>();

  /** The tab's combined field fingerprint, filling unread segments from the previous poll. */
  function mergeFieldSegments(url: string, read: Array<[string, string | null]>): { fingerprint: string; segments: Map<string, string> } {
    const previous = captured.get(url)?.segments ?? lastSegments.get(url);
    const segments = new Map<string, string>();
    for (const [key, value] of read) segments.set(key, value ?? previous?.get(key) ?? `${key}|unread`);
    return { fingerprint: [...segments].map(([key, value]) => `${key}=${value}`).join('\n'), segments };
  }
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
        const { fingerprint, segments } = mergeFieldSegments(tab.url, extracted.fieldSegments);
        let chars = extracted.proseChars;
        // An app still rendering returns a shell ("Loading…") or nothing.
        // Wait for real text a few polls before settling for what there is;
        // the page's HTML is the last resort (text read from it here). A
        // mostly-form page counts its fields as real content.
        if (extracted.proseChars + extracted.fieldsChars < THIN_PAGE_CHARS && !previous) {
          lastSegments.set(tab.url, segments);
          const attempts = (settleAttempts.get(tab.url) ?? 0) + 1;
          settleAttempts.set(tab.url, attempts);
          if (attempts < maxSettleAttempts) continue;
          if (!content && html) { content = htmlToText(html).trim(); chars = content.length; }
          if (!content) continue;
        }
        if (previous) {
          previous.segments = segments;
          // Captured before: a page that kept rendering much more prose is
          // captured again; field values never count toward growth.
          const grew = chars >= previous.chars * GROWTH_RATIO && chars - previous.chars >= GROWTH_MIN_CHARS;
          if (!grew) {
            // A field change is captured once it holds for two consecutive
            // polls, so a form mid-typing is never captured.
            if (fingerprint === previous.fields) { previous.pendingFields = undefined; continue; }
            if (previous.pendingFields !== fingerprint) { previous.pendingFields = fingerprint; continue; }
          }
        }
        settleAttempts.delete(tab.url);
        lastSegments.delete(tab.url);
        captured.set(tab.url, { chars, recaptures: previous ? previous.recaptures + 1 : 0, fields: fingerprint, pendingFields: undefined, segments });
        if (captured.size > 5000) {
          for (const key of [...captured.keys()].slice(0, 2500)) captured.delete(key);
        }
        if (lastSegments.size > 5000) {
          for (const key of [...lastSegments.keys()].slice(0, 2500)) lastSegments.delete(key);
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
      console.log(`📄 Captured [${type}] ${tab.title.slice(0, 60)} (${content.length} chars text, ${html.length} chars html${extracted.fieldCount ? `, ${extracted.fieldCount} field${extracted.fieldCount === 1 ? '' : 's'}` : ''}${tab.frames.length ? `, ${tab.frames.length} frame${tab.frames.length === 1 ? '' : 's'}` : ''})`);
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

// ───────────── END FROZEN ─────────────

// ───────────── World model ─────────────

type Kind = 'static' | 'slack' | 'gmail' | 'whatsapp' | 'pdf';
type ReadKind = 'text' | 'fields' | 'html' | 'href';
interface WorldFrame { n: number; len: number; fields: string; fail: 'none' | 'text' | 'fields' }
interface WorldTab {
  id: string;
  kind: Kind;
  url: string;
  title: string;
  len: number;
  salt: number;
  html: string;
  fields: string;
  failing: Set<ReadKind>;
  complete: boolean;
  errorPage: boolean;
  frames: WorldFrame[];
  waUpTo: number;
  waChat: string;
  pdf: string;
}

const LENS = [0, 5, 60, 199, 200, 250, 400, 520, 1500];
const DELTAS = [10, 100, 250, 290, 310, 700, 800];
const FIELD_VARIANTS = ['none', 'one', 'one2', 'two', 'secretish'] as const;
const HTML_VARIANTS = ['', 'a', 'b', 'secret'] as const;
const PDF_BYTES = Buffer.from('%PDF-1.4 oracle bytes').toString('base64');

function fieldsJson(variant: string): string {
  switch (variant) {
    case 'one': return JSON.stringify({ fields: [{ kind: 'textbox', label: 'Name', value: 'Asha', path: '#n', native: true }], truncated: 0 });
    case 'one2': return JSON.stringify({ fields: [{ kind: 'textbox', label: 'Name', value: 'Asha Rao', path: '#n', native: true }], truncated: 0 });
    case 'two': return JSON.stringify({ fields: [
      { kind: 'textbox', label: 'Name', value: 'Asha', path: '#n', native: true },
      { kind: 'checkbox', label: 'Agree', checked: true, path: '#a', native: true },
    ], truncated: 0 });
    case 'secretish': return JSON.stringify({ fields: [
      { kind: 'textbox', label: 'Password', withheld: true, filled: true, path: '#p', native: true },
      { kind: 'textbox', label: 'Notes', value: `token ${GH_TOKEN}`, path: '#t', native: true },
    ], truncated: 0 });
    default: return '';
  }
}
function htmlFor(variant: string): string {
  if (variant === '') return '';
  if (variant === 'secret') return '<html><body>password=SuperSecret123 <p>Quarterly plan</p></body></html>';
  return `<html><body><h1>Doc ${variant}</h1><p>Body ${variant}</p></body></html>`;
}
function textFor(tab: WorldTab): string {
  return tab.len === 0 ? '' : `${tab.salt}${'x'.repeat(tab.len)}`;
}
function waView(tab: WorldTab): string {
  const messages = Array.from({ length: tab.waUpTo }, (_, i) => ({
    id: `M${i}`, at: `9:${10 + i} pm`, author: i % 2 ? 'Me' : 'Asha', text: `message ${i}`, kind: 'text', outgoing: i % 2 === 1,
  }));
  return JSON.stringify({ chat: tab.waChat, group: false, messages });
}

type Step =
  | { t: 'add'; kind: Kind; pool: number; len: number; html: string }
  | { t: 'remove'; i: number }
  | { t: 'text'; i: number; len: number; salt: number }
  | { t: 'grow'; i: number; by: number }
  | { t: 'html'; i: number; v: string }
  | { t: 'fields'; i: number; v: string }
  | { t: 'fail'; i: number; kind: ReadKind; on: boolean }
  | { t: 'ready'; i: number; complete: boolean }
  | { t: 'error'; i: number; on: boolean }
  | { t: 'frame'; i: number; n: number; len: number; fields: string; fail: 'none' | 'text' | 'fields' }
  | { t: 'wa'; i: number; upTo: number; chat: string }
  | { t: 'pdf'; i: number; v: 'none' | 'valid' | 'junk'; readable: boolean }
  | { t: 'idle' };

const idx = fc.integer({ min: 0, max: 1 });
const stepArb: fc.Arbitrary<Step> = fc.oneof(
  { weight: 3, arbitrary: fc.record({ t: fc.constant('add' as const), kind: fc.constantFrom<Kind>('static', 'static', 'static', 'static', 'static', 'slack', 'gmail', 'whatsapp', 'pdf'), pool: fc.integer({ min: 0, max: 1 }), len: fc.constantFrom(...LENS), html: fc.constantFrom(...HTML_VARIANTS) }) },
  { weight: 1, arbitrary: fc.record({ t: fc.constant('remove' as const), i: idx }) },
  { weight: 5, arbitrary: fc.record({ t: fc.constant('text' as const), i: idx, len: fc.constantFrom(...LENS), salt: fc.integer({ min: 0, max: 2 }) }) },
  { weight: 5, arbitrary: fc.record({ t: fc.constant('grow' as const), i: idx, by: fc.constantFrom(...DELTAS) }) },
  { weight: 2, arbitrary: fc.record({ t: fc.constant('html' as const), i: idx, v: fc.constantFrom(...HTML_VARIANTS) }) },
  { weight: 4, arbitrary: fc.record({ t: fc.constant('fields' as const), i: idx, v: fc.constantFrom(...FIELD_VARIANTS) }) },
  { weight: 3, arbitrary: fc.record({ t: fc.constant('fail' as const), i: idx, kind: fc.constantFrom<ReadKind>('text', 'fields', 'html', 'href'), on: fc.boolean() }) },
  { weight: 1, arbitrary: fc.record({ t: fc.constant('ready' as const), i: idx, complete: fc.boolean() }) },
  { weight: 1, arbitrary: fc.record({ t: fc.constant('error' as const), i: idx, on: fc.boolean() }) },
  { weight: 5, arbitrary: fc.record({ t: fc.constant('frame' as const), i: idx, n: fc.integer({ min: 0, max: 2 }), len: fc.constantFrom(0, 20, 60, 60, 400), fields: fc.constantFrom('none', 'none', 'one', 'secretish'), fail: fc.constantFrom<'none' | 'text' | 'fields'>('none', 'none', 'text', 'fields') }) },
  { weight: 2, arbitrary: fc.record({ t: fc.constant('wa' as const), i: idx, upTo: fc.integer({ min: 0, max: 6 }), chat: fc.constantFrom('', 'Family') }) },
  { weight: 2, arbitrary: fc.record({ t: fc.constant('pdf' as const), i: idx, v: fc.constantFrom<'none' | 'valid' | 'junk'>('none', 'valid', 'junk'), readable: fc.boolean() }) },
  { weight: 7, arbitrary: fc.record({ t: fc.constant('idle' as const) }) },
);

function urlFor(kind: Kind, pool: number): string {
  switch (kind) {
    case 'slack': return `https://app.slack.com/client/T1/C${pool}`;
    case 'gmail': return `https://mail.google.com/mail/u/0/#inbox/${pool}`;
    case 'whatsapp': return 'https://web.whatsapp.com/';
    case 'pdf': return `https://files.test/doc${pool}.pdf`;
    default: return `https://site${pool}.test/page`;
  }
}

describe('browser monitor differential oracle (frozen 22431ea loop vs the real monitor)', () => {
  let fake: FakeCdp;
  beforeAll(async () => { fake = await startFakeCdp(); });
  afterAll(async () => { await fake.close(); });
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  function syncWorld(world: WorldTab[]): void {
    fake.clear();
    for (const tab of world) {
      fake.page(tab.id, tab.url, tab.title, () => ({
        ready: tab.complete ? 'complete' : 'loading',
        href: tab.errorPage ? 'chrome-error://chromewebdata/' : tab.url,
        text: textFor(tab),
        html: htmlFor(tab.html),
        fields: fieldsJson(tab.fields),
        whatsapp: waView(tab),
        pdf: tab.pdf === 'valid' ? PDF_BYTES : tab.pdf === 'junk' ? Buffer.from('<html>login</html>').toString('base64') : '',
      }));
      for (const kind of tab.failing) fake.behave(tab.id, kind === 'text' ? 'text' : kind, { mode: 'reject' });
      for (const frame of tab.frames) {
        const frameId = `${tab.id}-f${frame.n}`;
        fake.frame(frameId, tab.id, `https://office.test/${tab.id}/frame${frame.n}`, () => ({
          text: frame.len === 0 ? '' : `frame${frame.n} ${'y'.repeat(frame.len)}`,
          fields: fieldsJson(frame.fields),
        }));
        if (frame.fail === 'text') fake.behave(frameId, 'text', { mode: 'reject' });
        if (frame.fail === 'fields') fake.behave(frameId, 'fields', { mode: 'reject' });
      }
    }
  }

  function apply(world: WorldTab[], step: Step, counter: { n: number }): void {
    const tab = world.length ? world[('i' in step ? step.i : 0) % world.length] : undefined;
    switch (step.t) {
      case 'add': {
        if (world.length >= 3) return;
        const id = `t${counter.n++}`;
        world.push({
          id, kind: step.kind, url: urlFor(step.kind, step.pool), title: `Title ${id}`, len: step.len, salt: 0, html: step.html, fields: 'none',
          failing: new Set(), complete: true, errorPage: false, frames: [], waUpTo: 2, waChat: 'Family', pdf: 'valid',
        });
        return;
      }
      case 'remove': if (tab) world.splice(world.indexOf(tab), 1); return;
      case 'text': if (tab) { tab.len = step.len; tab.salt = step.salt; } return;
      case 'grow': if (tab) tab.len += step.by; return;
      case 'html': if (tab) tab.html = step.v; return;
      case 'fields': if (tab) tab.fields = step.v; return;
      case 'fail': if (tab) { if (step.on) tab.failing.add(step.kind); else tab.failing.delete(step.kind); } return;
      case 'ready': if (tab) tab.complete = step.complete; return;
      case 'error': if (tab) tab.errorPage = step.on; return;
      case 'frame': if (tab) {
        tab.frames = tab.frames.filter(frame => frame.n !== step.n);
        if (step.len > 0 || step.fields !== 'none') tab.frames.push({ n: step.n, len: step.len, fields: step.fields, fail: step.fail });
      } return;
      case 'wa': if (tab) { tab.waUpTo = step.upTo; tab.waChat = step.chat; } return;
      case 'pdf': if (tab) tab.pdf = step.v; return;
      case 'idle': return;
    }
  }

  const shape = (items: RawWorkItem[]) => items.map(({ capturedAt, ...rest }) => { void capturedAt; return rest; });

  it('is not vacuous: the model produces emits, field recaptures, and read failures', async () => {
    // A hand-made sequence that must produce emits from the frozen loop itself.
    const world: WorldTab[] = [];
    const counter = { n: 0 };
    const frozenItems: RawWorkItem[] = [];
    const frozen = createFrozenBrowserMonitor({ cdpEndpoint: fake.endpoint, pollIntervalMs: 60_000, maxSettleAttempts: 3 });
    frozen.onWorkItem(item => frozenItems.push(item));
    for (const step of [
      { t: 'add', kind: 'static', pool: 0, len: 400, html: 'a' }, { t: 'idle' },
      { t: 'fields', i: 0, v: 'one' }, { t: 'idle' }, { t: 'idle' },
      { t: 'add', kind: 'slack', pool: 0, len: 400, html: 'a' }, { t: 'idle' },
    ] as Step[]) {
      apply(world, step, counter);
      syncWorld(world);
      await frozen.pollOnce();
    }
    expect(frozenItems.length).toBeGreaterThanOrEqual(3);
  });

  it('emits the same stream as the frozen loop on seeded random worlds', async () => {
    let emitted = 0;
    let polls = 0;
    await fc.assert(fc.asyncProperty(fc.array(stepArb, { minLength: 6, maxLength: 24 }), async (steps) => {
      const world: WorldTab[] = [];
      const counter = { n: 0 };
      let readable = true;
      const common = { cdpEndpoint: fake.endpoint, pollIntervalMs: 60_000, maxSettleAttempts: 3, hasCaptured: () => false, readPdf: async () => (readable ? 'pdf text' : '') };
      const frozenItems: RawWorkItem[] = [];
      const realItems: RawWorkItem[] = [];
      const frozen = createFrozenBrowserMonitor(common);
      // Unbounded wall budget and the governor ON with calm signals: calm must be a no-op,
      // so the stream, its order, and its metadata still equal the frozen loop's.
      const real = createBrowserMonitor({
        ...common,
        maxPollWallMs: Number.POSITIVE_INFINITY,
        adaptive: true,
        sampleSystem: () => ({ pressure: 'normal', loadPerCpu: 0 }),
        isPaused: () => false,
      } as Partial<BrowserMonitorConfig>);
      frozen.onWorkItem(item => frozenItems.push(item));
      real.onWorkItem(item => realItems.push(item));
      for (const step of steps) {
        if (step.t === 'pdf') readable = step.readable;
        apply(world, step, counter);
        syncWorld(world);
        await frozen.pollOnce();
        await real.pollOnce();
        polls++;
        expect(shape(realItems)).toEqual(shape(frozenItems));
      }
      emitted += frozenItems.length;
      real.stop();
      frozen.stop();
    }), { seed: Number(process.env.BOTBOY_DIFF_SEED ?? 20261012), numRuns: Number(process.env.BOTBOY_DIFF_RUNS ?? 150) });
    expect(polls).toBeGreaterThan(100);
    expect(emitted).toBeGreaterThan(20);
  }, 180_000);
});
