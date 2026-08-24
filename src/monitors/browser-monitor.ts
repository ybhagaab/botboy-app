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

export interface BrowserMonitor {
  start(): Promise<void>;
  stop(): void;
  onWorkItem(callback: (item: RawWorkItem) => void): void;
}

export interface BrowserMonitorConfig {
  cdpEndpoint: string;
  pollIntervalMs: number;
}

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

interface TabInfo {
  url: string;
  title: string;
  id: string;
  webSocketDebuggerUrl: string;
}

async function fetchTabs(endpoint: string): Promise<TabInfo[]> {
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
      /midway-auth\.amazon\.com/,
      /midway\.amazon\.com/,
      /fido\.a2z\.com/,
      /^about:/,
      /^data:/,
    ];
    return tabs
      .filter((t: any) => {
        if (t.type !== 'page' || !t.url) return false;
        return !BLOCKED_URLS.some(p => p.test(t.url));
      })
      .map((t: any) => ({
        url: t.url,
        title: t.title || '',
        id: t.id,
        webSocketDebuggerUrl: t.webSocketDebuggerUrl || '',
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

async function extractPageContent(tab: TabInfo): Promise<{ text: string; html: string }> {
  if (!tab.webSocketDebuggerUrl) return { text: '', html: '' };
  try {
    // Use platform-specific extraction for messaging apps
    const url = tab.url;
    let expression: string;

    if (/web\.whatsapp\.com/.test(url)) {
      // WhatsApp: extract actual chat messages, not UI chrome
      expression = `(function() {
        const msgs = document.querySelectorAll('[data-pre-plain-text], .message-in .copyable-text, .message-out .copyable-text, ._amjv, ._amjw');
        if (msgs.length > 0) {
          return Array.from(msgs).slice(-30).map(el => {
            const pre = el.getAttribute('data-pre-plain-text') || '';
            const text = el.innerText || '';
            return pre ? pre + ' ' + text : text;
          }).filter(t => t.trim()).join('\\n');
        }
        // Fallback: get conversation list
        const convos = document.querySelectorAll('[data-testid="cell-frame-container"]');
        if (convos.length > 0) {
          return Array.from(convos).slice(0, 20).map(el => el.innerText.replace(/\\n+/g, ' | ')).join('\\n');
        }
        return document.querySelector('#main')?.innerText? || '';
      })()`;
    } else if (/app\.slack\.com|slack\.com\/client/.test(url)) {
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
      // Generic: tiered extraction — try main content first, then stripped
      // innerText. Same-origin iframe text is appended (SPAs like Pippin
      // render artifacts inside iframes; top-document innerText misses them).
      expression = `(function() {
        var text = '';
        // Try semantic content selectors first (clean content, no nav/footer)
        var main = document.querySelector('article, main, [role="main"], .post-content, .entry-content, .article-body, #content');
        if (main && main.innerText.trim().length > 200) {
          text = main.innerText.trim();
        } else {
          // Try stripping nav, header, footer, sidebar
          var clone = document.body.cloneNode(true);
          clone.querySelectorAll('script, style, noscript, svg, img, nav, header, footer, aside, [role="navigation"], [role="banner"], [role="contentinfo"], .sidebar, .nav, .footer, .header, .menu').forEach(function(el) { el.remove(); });
          var stripped = clone.innerText.trim();
          text = stripped.length > 200 ? stripped : document.body.innerText.trim();
        }
        // Same-origin iframes (cross-origin ones throw — skipped)
        document.querySelectorAll('iframe').forEach(function(f) {
          try {
            var t = f.contentDocument && f.contentDocument.body ? f.contentDocument.body.innerText.trim() : '';
            if (t) text += '\\n\\n[iframe] ' + t;
          } catch (e) {}
        });
        return text;
      })()`;
    }

    const text = await cdpEval(tab.webSocketDebuggerUrl, expression);
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
  /web\.whatsapp\.com/,
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
  let seenStaticUrls = new Set<string>();
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

  async function pollOnce(): Promise<void> {
    const tabs = await fetchTabs(cfg.cdpEndpoint);
    for (const tab of tabs) {
      const dynamic = isDynamicPage(tab.url);

      if (!dynamic && seenStaticUrls.has(tab.url)) continue;

      // Extract actual page content via CDP
      const { text: content, html } = await extractPageContent(tab);

      if (!dynamic) {
        // Mark a static page as captured ONLY once real content arrived.
        // SPAs (Pippin, Quip, …) return empty while loading — the old code
        // blacklisted the URL on that first empty poll and the page was never
        // captured at all (post-mortem 2026-08-05). Empty extractions retry
        // on the next poll instead.
        if (!content && !html) continue;
        seenStaticUrls.add(tab.url);
        if (seenStaticUrls.size > 5000) {
          const arr = [...seenStaticUrls];
          seenStaticUrls = new Set(arr.slice(-2500));
        }
      }

      if (dynamic) {
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
          ...(type === 'slack_message' ? { direction: 'observed' } : {}),
        },
        capturedAt: new Date(),
      };

      emit(item);
      console.log(`📄 Captured [${type}] ${tab.title.slice(0, 60)} (${content.length} chars text, ${html.length} chars html)`);
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
  };
}
