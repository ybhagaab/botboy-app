import { describe, it, expect } from 'vitest';
import { detectPlatform } from './browser-monitor.js';

describe('detectPlatform', () => {
  it('detects YouTube videos', () => {
    const result = detectPlatform('https://www.youtube.com/watch?v=abc123', 'Cool Video');
    expect(result.type).toBe('youtube_video');
    expect(result.metadata.videoTitle).toBe('Cool Video');
  });

  it('detects Slack in browser', () => {
    const result = detectPlatform('https://app.slack.com/client/T123/C456', 'general');
    expect(result.type).toBe('slack_message');
    expect(result.metadata.platform).toBe('browser');
  });

  it('detects WhatsApp Web', () => {
    const result = detectPlatform('https://web.whatsapp.com/', 'WhatsApp');
    expect(result.type).toBe('whatsapp_message');
  });

  it('detects Gmail', () => {
    const result = detectPlatform('https://mail.google.com/mail/u/0/#inbox', 'Inbox');
    expect(result.type).toBe('email_read');
  });

  it('detects Outlook', () => {
    const result = detectPlatform('https://outlook.office.com/mail/inbox', 'Inbox');
    expect(result.type).toBe('email_read');
  });

  it('detects Google Docs', () => {
    const result = detectPlatform('https://docs.google.com/document/d/abc/edit', 'My Doc');
    expect(result.type).toBe('document_online');
    expect(result.metadata.documentType).toBe('google_docs');
  });

  it('detects Google Sheets', () => {
    const result = detectPlatform('https://docs.google.com/spreadsheets/d/abc/edit', 'My Sheet');
    expect(result.type).toBe('document_online');
    expect(result.metadata.documentType).toBe('google_sheets');
  });

  it('falls back to website_visit for unknown URLs', () => {
    const result = detectPlatform('https://example.com/page', 'Example');
    expect(result.type).toBe('website_visit');
    expect(result.metadata).toEqual({});
  });

  it('falls back for chrome-internal URLs', () => {
    const result = detectPlatform('https://news.ycombinator.com', 'HN');
    expect(result.type).toBe('website_visit');
  });
});

/**
 * Page capture against a fake Chrome DevTools endpoint (/json/list + one
 * WebSocket per target answering Runtime.evaluate). The real-Chrome shapes
 * behind each case (an app still rendering, a cross-origin viewer frame, a
 * browser error page) were reproduced live on 2026-10-09.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer } from 'ws';
import { afterEach, beforeEach } from 'vitest';
import { createBrowserMonitor, GENERIC_PAGE_TEXT, THIN_PAGE_CHARS } from './browser-monitor.js';

describe('browser page capture', () => {
  type Answer = { href?: string; ready?: string; text?: string; html?: string };
  let server: http.Server;
  let wss: WebSocketServer;
  let base: string;
  let targets: any[];
  let answers: Map<string, () => Answer>;
  const LONG = 'Real page content that BotBoy must keep. '.repeat(20);

  beforeEach(async () => {
    targets = [];
    answers = new Map();
    server = http.createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(req.url === '/json/list' ? targets : {}));
    });
    wss = new WebSocketServer({ server });
    wss.on('connection', (socket, req) => {
      const id = String(req.url ?? '').split('/').pop() ?? '';
      socket.on('message', (raw) => {
        const msg = JSON.parse(String(raw));
        const answer = answers.get(id)?.() ?? {};
        const expression = String(msg.params?.expression ?? '');
        const value = expression === 'document.readyState' ? (answer.ready ?? 'complete')
          : expression === 'String(location.href)' ? (answer.href ?? 'https://x.test/')
          : expression.includes('outerHTML') ? (answer.html ?? '')
          : (answer.text ?? '');
        socket.send(JSON.stringify({ id: msg.id, result: { result: { value } } }));
      });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    base = `127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(async () => {
    wss.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });

  function page(id: string, url: string, title: string, answer: () => Answer, extra: Record<string, unknown> = {}) {
    targets.push({ type: 'page', id, url, title, webSocketDebuggerUrl: `ws://${base}/devtools/page/${id}`, ...extra });
    answers.set(id, answer);
  }
  function monitor(maxSettleAttempts = 3) {
    const items: any[] = [];
    const m = createBrowserMonitor({ cdpEndpoint: `http://${base}`, pollIntervalMs: 60_000, maxSettleAttempts });
    m.onWorkItem(item => items.push(item));
    return { m, items };
  }

  it('waits for an app that is still rendering instead of capturing its loading shell', async () => {
    let polls = 0;
    page('spa', 'https://app.test/report', 'Report', () => ({ text: polls < 2 ? 'Loading…' : LONG }));
    const { m, items } = monitor();
    await m.pollOnce(); polls++;
    await m.pollOnce(); polls++;
    expect(items).toEqual([]);
    await m.pollOnce();
    expect(items).toHaveLength(1);
    expect(items[0].content).toBe(LONG.trim());
    // Captured: the same text is not captured again.
    await m.pollOnce();
    expect(items).toHaveLength(1);
  });

  it('settles for the HTML’s text after the attempts, and never stores an empty capture', async () => {
    page('shell', 'https://app.test/shell', 'Shell', () => ({ text: '', html: '<html><body><h1>Workbook.xlsx</h1><p>Only the shell</p></body></html>' }));
    page('blank', 'https://app.test/blank', 'Blank', () => ({ text: '', html: '' }));
    const { m, items } = monitor(2);
    await m.pollOnce();
    await m.pollOnce();
    expect(items.map(item => item.url)).toEqual(['https://app.test/shell']);
    expect(items[0].content).toContain('Workbook.xlsx');
    await m.pollOnce();
    expect(items.every(item => item.content)).toBe(true);
  });

  it('reads cross-origin frames as their own targets and appends their text', async () => {
    page('viewer', 'https://share.test/doc', 'Viewer', () => ({ text: 'Toolbar' }));
    targets.push({ type: 'iframe', id: 'f1', parentId: 'viewer', url: 'https://office.test/frame', webSocketDebuggerUrl: `ws://${base}/devtools/page/f1` });
    answers.set('f1', () => ({ text: `CELL APAC 42 ${LONG}` }));
    const { m, items } = monitor();
    await m.pollOnce();
    expect(items).toHaveLength(1);
    expect(items[0].content).toContain('Toolbar');
    expect(items[0].content).toContain('[frame https://office.test/frame]\nCELL APAC 42');
    expect(items[0].metadata.frames).toBe('1');
  });

  it('skips ad frames, tiny widgets, and repeated frame text', async () => {
    page('ads', 'https://news.test/story', 'Story', () => ({ text: LONG }));
    targets.push({ type: 'iframe', id: 'ad', parentId: 'ads', url: 'https://googleads.g.doubleclick.net/pagead/ads', webSocketDebuggerUrl: `ws://${base}/devtools/page/ad` });
    targets.push({ type: 'iframe', id: 'w1', parentId: 'ads', url: 'https://widget.test/a', webSocketDebuggerUrl: `ws://${base}/devtools/page/w1` });
    targets.push({ type: 'iframe', id: 'w2', parentId: 'ads', url: 'https://widget.test/b', webSocketDebuggerUrl: `ws://${base}/devtools/page/w2` });
    targets.push({ type: 'iframe', id: 'w3', parentId: 'ads', url: 'https://widget.test/c', webSocketDebuggerUrl: `ws://${base}/devtools/page/w3` });
    answers.set('ad', () => ({ text: `BUY NOW ${LONG}` }));
    answers.set('w1', () => ({ text: 'Like 12' }));
    answers.set('w2', () => ({ text: `Comments: ${LONG}` }));
    answers.set('w3', () => ({ text: `Comments: ${LONG}` }));
    const { m, items } = monitor();
    await m.pollOnce();
    const content = items[0].content as string;
    expect(content).not.toContain('BUY NOW');
    expect(content).not.toContain('Like 12');
    expect(content.match(/\[frame /g)).toHaveLength(1);
    expect(items[0].metadata.frames).toBe('3');
  });

  it('skips browser error pages without giving up on the tab', async () => {
    let down = true;
    page('err', 'https://flaky.test/', 'flaky.test', () => (down ? { href: 'chrome-error://chromewebdata/', text: 'This site can’t be reached' } : { text: LONG }));
    const { m, items } = monitor();
    await m.pollOnce();
    await m.pollOnce();
    await m.pollOnce();
    expect(items).toEqual([]);
    down = false;
    await m.pollOnce();
    expect(items).toHaveLength(1);
    expect(items[0].content).not.toContain('can’t be reached');
  });

  it('captures a static page again when it kept rendering much more text, a bounded number of times', async () => {
    let text = 'A'.repeat(THIN_PAGE_CHARS + 100);
    page('grow', 'https://app.test/grow', 'Grow', () => ({ text }));
    const { m, items } = monitor();
    await m.pollOnce();
    text += ' small edit';
    await m.pollOnce();
    expect(items).toHaveLength(1);
    for (let round = 0; round < 6; round++) {
      text += 'B'.repeat(text.length);
      await m.pollOnce();
    }
    expect(items).toHaveLength(4);
  });

  it('the in-page reader enters open shadow roots and skips page chrome', () => {
    expect(GENERIC_PAGE_TEXT).toContain('shadowRoot');
    expect(GENERIC_PAGE_TEXT).toContain('nav, header, footer');
    expect(() => new Function(`return ${GENERIC_PAGE_TEXT.slice(0, -2)}`)).not.toThrow();
  });
});

describe('isNoiseFrame', () => {
  it('drops ad, tracking, and consent frames, and keeps content viewers', async () => {
    const { isNoiseFrame } = await import('./browser-monitor.js');
    for (const url of ['https://googleads.g.doubleclick.net/xbbe/pixel?d=1', 'https://ep2.adtrafficquality.google/sodar/x.html', 'https://acdn.adnxs.com/dmp/async_usersync.html', 'https://srv.flashb.id/sf/render.html', 'https://www.google.com/recaptcha/api2/anchor', 'javascript:void(0)']) {
      expect(isNoiseFrame(url), url).toBe(true);
    }
    for (const url of ['https://amazon-my.sharepoint.com/:x:/r/_layouts/15/Doc.aspx', 'https://excel.officeapps.live.com/x/_layouts/xlviewerinternal.aspx', 'https://786946de.sandpack-bundler.pages.dev/']) {
      expect(isNoiseFrame(url), url).toBe(false);
    }
  });
});

/**
 * WhatsApp Web: the reader runs against DOM shaped like the live page
 * (verified 2026-10-09: `data-id`, `data-pre-plain-text`, `data-testid`
 * selectors; generated class names ignored), and each new message becomes
 * one row keyed by its WhatsApp id.
 */
describe('WhatsApp Web capture', () => {
  it('reads text, captions, polls, quoted replies, and direction from the live DOM shape', async () => {
    const { JSDOM } = await import('jsdom');
    const { WHATSAPP_READER, parseWhatsAppView } = await import('./browser-monitor.js');
    const row = (id: string, pre: string | null, inner: string) => `<div role="row"><div data-id="${id}"><div data-testid="msg-container">${pre === null ? inner : `<div class="copyable-text" data-pre-plain-text="${pre}">${inner}</div>`}</div></div></div>`;
    const dom = new JSDOM(`<div id="pane-side"></div><div id="main"><header><div data-testid="conversation-info-header-chat-title"><span dir="auto">Family</span></div><img data-testid="group-chat-profile-picture"></header>
      ${row('PLACEHOLDER1', null, '')}
      ${row('A1', '[9:41 pm, 08/10/2026] Asha: ', '<span data-icon="tail-in"></span><span data-testid="selectable-text">Dinner at 8?</span>')}
      ${row('A2', '[9:42 pm, 08/10/2026] Me: ', '<span data-icon="tail-out"></span><span data-testid="selectable-text">Yes, booked</span><span data-icon="msg-dblcheck"></span>')}
      ${row('A3', '[9:43 pm, 08/10/2026] Ravi: ', '<div data-testid="poll-bubble"><span data-testid="selectable-text">Which day?</span><div data-testid="poll-option-row-label-0"><span data-testid="selectable-text">Sat</span></div><div data-testid="poll-option-row-label-1"><span data-testid="selectable-text">Sun</span></div></div>')}
      ${row('A4', '[9:44 pm, 08/10/2026] Asha: ', '<div data-testid="image-thumb"></div><span data-testid="image-caption">Menu</span>')}
      ${row('A5', '[9:45 pm, 08/10/2026] Ravi: ', '<div data-testid="quoted-message"><span data-testid="selectable-text">Dinner at 8?</span></div><span data-testid="selectable-text">Make it 8:30</span>')}
      ${row('A6', '[9:46 pm, 08/10/2026] Ravi: ', '<div data-testid="image-thumb"></div>')}
      ${row('A7', '[9:47 pm, 08/10/2026] Ravi: ', '<span data-testid="selectable-text"> </span>')}
      ${row('A8', '[9:48 pm, 08/10/2026] Me: ', '<span aria-label="You:"></span><span data-testid="selectable-text">Follow-up, no tail</span><span aria-label=" Delivered "></span>')}
      ${row('A9', '[9:49 pm, 08/10/2026] Asha: ', '<span aria-label="Asha:"></span><span data-testid="selectable-text">Seen</span>')}
    </div>`, { runScripts: 'outside-only' });
    // jsdom has no layout, so innerText is textContent here.
    Object.defineProperty(dom.window.HTMLElement.prototype, 'innerText', { get() { return this.textContent; } });
    const view = parseWhatsAppView(dom.window.eval(WHATSAPP_READER) as string);
    expect(view).toMatchObject({ chat: 'Family', group: true });
    expect(view.messages.map(m => [m.id, m.author, m.kind, m.outgoing, m.text])).toEqual([
      ['A1', 'Asha', 'text', false, 'Dinner at 8?'],
      ['A2', 'Me', 'text', true, 'Yes, booked'],
      ['A3', 'Ravi', 'poll', false, 'Which day?\nOptions: Sat | Sun'],
      ['A4', 'Asha', 'image', false, 'Menu'],
      ['A5', 'Ravi', 'text', false, 'Make it 8:30'],
      ['A6', 'Ravi', 'image', false, ''],
      ['A8', 'Me', 'text', true, 'Follow-up, no tail'],
      ['A9', 'Asha', 'text', false, 'Seen'],
    ]);
    expect(view.messages[0].at).toBe('9:41 pm, 08/10/2026');
    expect(view.messages[4].quoted).toBe('Dinner at 8?');
    // No chat open: an empty view.
    const list = new JSDOM('<div id="pane-side"></div>', { runScripts: 'outside-only' });
    expect(parseWhatsAppView(list.window.eval(WHATSAPP_READER) as string)).toEqual({ chat: '', group: false, messages: [] });
    expect(parseWhatsAppView('not json')).toEqual({ chat: '', group: false, messages: [] });
  });

  it('emits each new message once, keyed by its id, and skips ones already stored', async () => {
    const http = await import('node:http');
    const { WebSocketServer } = await import('ws');
    const { createBrowserMonitor, whatsAppMessageUrl } = await import('./browser-monitor.js');
    let view = { chat: 'Family', group: true, messages: [
      { id: 'A1', at: '9:41 pm, 08/10/2026', author: 'Asha', text: 'Dinner at 8?', kind: 'text', outgoing: false },
      { id: 'A2', at: '9:42 pm, 08/10/2026', author: 'Me', text: 'Yes, booked', kind: 'text', outgoing: true },
    ] };
    const server = http.createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(req.url === '/json/list' ? [{ type: 'page', id: 'wa', url: 'https://web.whatsapp.com/', title: '(3) WhatsApp', webSocketDebuggerUrl: `ws://127.0.0.1:${(server.address() as any).port}/devtools/page/wa` }] : {}));
    });
    const wss = new WebSocketServer({ server });
    wss.on('connection', socket => socket.on('message', raw => {
      const msg = JSON.parse(String(raw));
      const value = msg.params.expression === 'document.readyState' ? 'complete' : JSON.stringify(view);
      socket.send(JSON.stringify({ id: msg.id, result: { result: { value } } }));
    }));
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const stored = new Set([whatsAppMessageUrl('A1')]);
      const items: any[] = [];
      const m = createBrowserMonitor({ cdpEndpoint: `http://127.0.0.1:${(server.address() as any).port}`, hasCaptured: url => stored.has(url) });
      m.onWorkItem(item => items.push(item));
      await m.pollOnce();
      expect(items.map(item => item.url)).toEqual([whatsAppMessageUrl('A2')]);
      expect(items[0]).toMatchObject({ type: 'whatsapp_message', title: 'Family', metadata: { chatType: 'group', author: 'Me', direction: 'sent', whatsappMessageId: 'A2' } });
      expect(items[0].content).toBe('Chat: Family (group)\n\n[9:42 pm, 08/10/2026] Me (me): Yes, booked');
      // Same view again: nothing new. A new message: only it.
      await m.pollOnce();
      view = { ...view, messages: [...view.messages, { id: 'A3', at: '9:50 pm, 08/10/2026', author: 'Asha', text: 'Great', kind: 'text', outgoing: false }] };
      await m.pollOnce();
      expect(items.map(item => item.metadata.whatsappMessageId)).toEqual(['A2', 'A3']);
    } finally {
      wss.close();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
});

import { isPdfTab } from './browser-monitor.js';

describe('isPdfTab (PDF tabs are read from the file, 2026-10-09)', () => {
  it('knows a .pdf address and Chrome\'s PDF viewer frame', () => {
    expect(isPdfTab({ url: 'https://northorp.com/research/competitive-intelligence.pdf', frames: [] })).toBe(true);
    expect(isPdfTab({ url: 'https://x.com/a.PDF?dl=1#page=2', frames: [] })).toBe(true);
    expect(isPdfTab({ url: 'https://x.com/view?id=7', frames: [{ url: 'chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/index.html' }] })).toBe(true);
    expect(isPdfTab({ url: 'https://x.com/pdf-guide', frames: [] })).toBe(false);
    expect(isPdfTab({ url: 'https://x.com/a.pdf.html', frames: [] })).toBe(false);
    expect(isPdfTab({ url: 'not a url', frames: [] })).toBe(false);
  });
});
