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
