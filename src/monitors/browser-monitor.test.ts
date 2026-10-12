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
 * WebSocket per target answering Runtime.evaluate; `browser-monitor.fake-cdp.ts`).
 * The real-Chrome shapes behind each case (an app still rendering, a
 * cross-origin viewer frame, a browser error page) were reproduced live on
 * 2026-10-09.
 */
import { afterAll, afterEach, beforeAll, beforeEach, vi } from 'vitest';
import { createBrowserMonitor, GENERIC_PAGE_TEXT, openCdpSession, parseHrefProbe, THIN_PAGE_CHARS, whatsAppMessageUrl } from './browser-monitor.js';
import { startFakeCdp, type FakeAnswer, type FakeCdp } from './browser-monitor.fake-cdp.js';
import { redactSecrets } from '../core/sensitive-files.js';

// Split so secret scanners never see a whole token in the source.
const GH_TOKEN = 'ghp_' + 'abcdefghijklmnopqrstuvwxyz0123456789';
const AWS_KEY = 'AKIA' + 'Q7XJ4MZP3N2KD5VB';
let fakeCdp: FakeCdp;
beforeAll(async () => { fakeCdp = await startFakeCdp(); });
afterAll(async () => { await fakeCdp.close(); });

describe('browser page capture', () => {
  type Answer = FakeAnswer;
  const LONG = 'Real page content that BotBoy must keep. '.repeat(20);

  beforeEach(() => { fakeCdp.clear(); });

  function page(id: string, url: string, title: string, answer: () => Answer, extra: Record<string, unknown> = {}) {
    fakeCdp.page(id, url, title, answer, extra);
  }
  function monitor(maxSettleAttempts = 3) {
    const items: any[] = [];
    const m = createBrowserMonitor({ cdpEndpoint: fakeCdp.endpoint, pollIntervalMs: 60_000, maxSettleAttempts });
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
    fakeCdp.frame('f1', 'viewer', 'https://office.test/frame', () => ({ text: `CELL APAC 42 ${LONG}` }));
    const { m, items } = monitor();
    await m.pollOnce();
    expect(items).toHaveLength(1);
    expect(items[0].content).toContain('Toolbar');
    expect(items[0].content).toContain('[frame https://office.test/frame]\nCELL APAC 42');
    expect(items[0].metadata.frames).toBe('1');
  });

  it('skips ad frames, tiny widgets, and repeated frame text', async () => {
    page('ads', 'https://news.test/story', 'Story', () => ({ text: LONG }));
    fakeCdp.frame('ad', 'ads', 'https://googleads.g.doubleclick.net/pagead/ads', () => ({ text: `BUY NOW ${LONG}` }));
    fakeCdp.frame('w1', 'ads', 'https://widget.test/a', () => ({ text: 'Like 12' }));
    fakeCdp.frame('w2', 'ads', 'https://widget.test/b', () => ({ text: `Comments: ${LONG}` }));
    fakeCdp.frame('w3', 'ads', 'https://widget.test/c', () => ({ text: `Comments: ${LONG}` }));
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

  const formFields = (name: string, extra: any[] = []) => JSON.stringify({ fields: [
    { kind: 'textbox', label: 'Full name', value: name, path: '#n', native: true },
    { kind: 'textbox', label: 'Password', withheld: true, filled: true, path: '#p', native: true },
    ...extra,
  ], truncated: 0 });

  it('appends a Fields section with values and withheld secrets, and redacts the HTML', async () => {
    page('form', 'https://forms.test/apply', 'Apply', () => ({ text: LONG, fields: formFields('Asha Rao'), html: '<html><body>password=SuperSecret123 <input value="[withheld]"></body></html>' }));
    const { m, items } = monitor();
    await m.pollOnce();
    expect(items).toHaveLength(1);
    const content = items[0].content as string;
    expect(content.startsWith(LONG.trim())).toBe(true);
    expect(content).toContain('--- Fields (2) ---\nFull name: Asha Rao\nPassword: [withheld]');
    expect(items[0].rawHtml).not.toContain('SuperSecret123');
  });

  it('a mostly-form page counts its fields as content and is captured without settling', async () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ kind: 'textbox', label: `Question ${i + 1}`, value: `Answer number ${i + 1}`, path: `#q${i}` }));
    page('short', 'https://forms.test/short', 'Short', () => ({ text: 'Form', fields: formFields('Asha', many) }));
    const { m, items } = monitor();
    await m.pollOnce();
    expect(items).toHaveLength(1);
    expect(items[0].content).toContain('Question 12: Answer number 12');
  });

  it('captures a field change again only after it holds for two polls, a bounded number of times', async () => {
    let name = 'Asha';
    page('edit', 'https://forms.test/edit', 'Edit', () => ({ text: LONG, fields: formFields(name) }));
    const { m, items } = monitor();
    await m.pollOnce();
    name = 'Asha Rao';
    await m.pollOnce();
    expect(items).toHaveLength(1);
    await m.pollOnce();
    expect(items).toHaveLength(2);
    expect(items[1].content).toContain('Full name: Asha Rao');
    await m.pollOnce();
    expect(items).toHaveLength(2);
    for (let round = 0; round < 6; round++) {
      name = `Name ${round}`;
      await m.pollOnce();
      await m.pollOnce();
    }
    expect(items).toHaveLength(4);
  });

  it('never captures a form mid-typing, even when a textarea grows past the growth ratio', async () => {
    let typed = 'x';
    const notes = () => Array.from({ length: 5 }, (_, i) => ({ kind: 'textbox', label: `Notes ${i}`, value: typed, path: `#t${i}` }));
    page('typing', 'https://forms.test/typing', 'Typing', () => ({ text: LONG, fields: formFields(typed, notes()) }));
    const { m, items } = monitor();
    await m.pollOnce();
    for (let round = 0; round < 8; round++) {
      typed = `${round} ${typed}${'y'.repeat(typed.length + 400)}`;
      await m.pollOnce();
    }
    expect(items).toHaveLength(1);
  });

  it('a cross-origin frame field edit recaptures after two equal polls; a failed frame read is no change', async () => {
    let frameName = 'Frame A';
    let frameDown = false;
    page('host', 'https://share.test/host', 'Host', () => ({ text: LONG, fields: formFields('Asha') }));
    fakeCdp.frame('ff', 'host', 'https://office.test/form?x=1', () => ({ text: 'Frame form', fields: frameDown ? '' : JSON.stringify({ fields: [{ kind: 'textbox', label: 'Frame name', value: frameName, path: '#f' }] }) }));
    const { m, items } = monitor();
    await m.pollOnce();
    expect(items).toHaveLength(1);
    expect(items[0].content).toContain('[frame https://office.test/form?x=1]\n--- Fields (1) ---\nFrame name: Frame A');
    frameDown = true;
    await m.pollOnce();
    frameDown = false;
    await m.pollOnce();
    await m.pollOnce();
    expect(items).toHaveLength(1);
    frameName = 'Frame B';
    await m.pollOnce();
    expect(items).toHaveLength(1);
    await m.pollOnce();
    expect(items).toHaveLength(2);
    expect(items[1].content).toContain('Frame name: Frame B');
  });

  it('platform pages are not read for fields', async () => {
    page('slack', 'https://app.slack.com/client/T1/C1', 'general', () => ({ text: LONG, fields: formFields('Asha') }));
    const { m, items } = monitor();
    await m.pollOnce();
    expect(items).toHaveLength(1);
    expect(items[0].content).not.toContain('--- Fields');
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
    fakeCdp.clear();
    let view = { chat: 'Family', group: true, messages: [
      { id: 'A1', at: '9:41 pm, 08/10/2026', author: 'Asha', text: 'Dinner at 8?', kind: 'text', outgoing: false },
      { id: 'A2', at: '9:42 pm, 08/10/2026', author: 'Me', text: 'Yes, booked', kind: 'text', outgoing: true },
    ] };
    fakeCdp.page('wa', 'https://web.whatsapp.com/', '(3) WhatsApp', () => ({ whatsapp: JSON.stringify(view) }));
    const stored = new Set([whatsAppMessageUrl('A1')]);
    const items: any[] = [];
    const m = createBrowserMonitor({ cdpEndpoint: fakeCdp.endpoint, hasCaptured: url => stored.has(url) });
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

/**
 * Characterization of the monitor's emit stream (url, content, rawHtml,
 * metadata, order) and of how it degrades when a read fails. These cases
 * pin today's behavior so the read path can be restructured without
 * changing what BotBoy stores; they hold the same on the original monitor
 * and after the two-phase refactor.
 */
describe('browser emit stream (characterization)', () => {
  const LONG = 'Real page content that BotBoy must keep. '.repeat(20);
  const fields = (name: string, extra: any[] = []) => JSON.stringify({ fields: [{ kind: 'textbox', label: 'Full name', value: name, path: '#n', native: true }, ...extra], truncated: 0 });
  const shape = (items: any[]) => items.map(({ capturedAt, ...rest }) => { void capturedAt; return rest; });

  beforeEach(() => { fakeCdp.clear(); });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  function monitor(config: Record<string, unknown> = {}) {
    const items: any[] = [];
    const m = createBrowserMonitor({ cdpEndpoint: fakeCdp.endpoint, pollIntervalMs: 60_000, maxSettleAttempts: 3, ...config });
    m.onWorkItem(item => items.push(item));
    return { m, items };
  }
  /** Runs a poll whose reads include one the fake leaves unanswered until the caller's own timeout fires. */
  async function pollThroughTimeout(m: { pollOnce(): Promise<void> }, timeoutMs: number): Promise<void> {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const heldBefore = fakeCdp.stats.held;
    const poll = m.pollOnce();
    await fakeCdp.waitForHeld(heldBefore + 1);
    vi.advanceTimersByTime(timeoutMs);
    await poll;
    vi.useRealTimers();
  }

  it('first sight emits the page once, in full, with redacted HTML and the base metadata', async () => {
    const html = `<html><body>token=${GH_TOKEN} hello</body></html>`;
    fakeCdp.page('p1', 'https://news.test/story', 'Story', () => ({ text: `  ${LONG}  `, html }));
    const { m, items } = monitor();
    await m.pollOnce();
    expect(shape(items)).toEqual([{
      type: 'website_visit', source: 'browser', sourceApp: 'Chrome', url: 'https://news.test/story', title: 'Story',
      content: LONG.trim(), rawHtml: redactSecrets(html), metadata: { captureMode: 'passive_observation' },
    }]);
    expect(items[0].rawHtml).not.toContain(GH_TOKEN);
  });

  it('an unchanged page is not emitted again over three more polls', async () => {
    fakeCdp.page('p1', 'https://news.test/story', 'Story', () => ({ text: LONG, html: '<html>one</html>' }));
    const { m, items } = monitor();
    for (let i = 0; i < 4; i++) await m.pollOnce();
    expect(items.map(item => item.url)).toEqual(['https://news.test/story']);
  });

  it('growth re-emits the new full text with the new HTML, then settles after three recaptures', async () => {
    let text = 'A'.repeat(THIN_PAGE_CHARS + 100);
    let n = 0;
    fakeCdp.page('g', 'https://app.test/grow', 'Grow', () => ({ text, html: `<html>${n}</html>` }));
    const { m, items } = monitor();
    await m.pollOnce();
    for (let round = 1; round <= 5; round++) {
      n = round;
      text += 'B'.repeat(text.length);
      await m.pollOnce();
    }
    expect(items.map(item => [item.content.length, item.rawHtml])).toEqual([
      [300, '<html>0</html>'],
      [600, '<html>1</html>'],
      [1200, '<html>2</html>'],
      [2400, '<html>3</html>'],
    ]);
  });

  it('a field change is emitted after two equal polls with a Fields section and the later HTML', async () => {
    let name = 'Asha';
    let n = 0;
    fakeCdp.page('f', 'https://forms.test/edit', 'Edit', () => ({ text: LONG, fields: fields(name), html: `<html>${n}</html>` }));
    const { m, items } = monitor();
    await m.pollOnce();
    name = 'Asha Rao'; n = 1;
    await m.pollOnce();
    expect(items).toHaveLength(1);
    await m.pollOnce();
    expect(shape(items).map(({ content, rawHtml }) => ({ content, rawHtml }))).toEqual([
      { content: `${LONG}\n\n--- Fields (1) ---\nFull name: Asha`, rawHtml: '<html>0</html>' },
      { content: `${LONG}\n\n--- Fields (1) ---\nFull name: Asha Rao`, rawHtml: '<html>1</html>' },
    ]);
  });

  it('a field change that flips back before the second poll is never emitted', async () => {
    let name = 'Asha';
    fakeCdp.page('f', 'https://forms.test/flip', 'Flip', () => ({ text: LONG, fields: fields(name) }));
    const { m, items } = monitor();
    await m.pollOnce();
    name = 'Asha R'; await m.pollOnce();
    name = 'Asha'; await m.pollOnce();
    name = 'Asha R'; await m.pollOnce();
    name = 'Asha'; await m.pollOnce();
    expect(items).toHaveLength(1);
  });

  it('a thin page settles after its attempts into the text of its HTML', async () => {
    fakeCdp.page('s', 'https://app.test/shell', 'Shell', () => ({ text: '', html: '<html><body><h1>Workbook.xlsx</h1><p>Only the shell</p></body></html>' }));
    const { m, items } = monitor();
    await m.pollOnce();
    await m.pollOnce();
    expect(items).toEqual([]);
    await m.pollOnce();
    expect(shape(items)).toEqual([{
      type: 'website_visit', source: 'browser', sourceApp: 'Chrome', url: 'https://app.test/shell', title: 'Shell',
      content: items[0].content, rawHtml: '<html><body><h1>Workbook.xlsx</h1><p>Only the shell</p></body></html>',
      metadata: { captureMode: 'passive_observation' },
    }]);
    expect(items[0].content).toContain('Workbook.xlsx');
    expect(items[0].content).toContain('Only the shell');
  });

  it('a thin page whose text is short but not empty is emitted as is at the final attempt', async () => {
    fakeCdp.page('s', 'https://app.test/short', 'Short', () => ({ text: 'Tiny but real', html: '<html>x</html>' }));
    const { m, items } = monitor();
    await m.pollOnce();
    await m.pollOnce();
    expect(items).toEqual([]);
    await m.pollOnce();
    expect(shape(items).map(({ content, rawHtml }) => ({ content, rawHtml }))).toEqual([{ content: 'Tiny but real', rawHtml: '<html>x</html>' }]);
  });

  it('a dynamic page emits on a text change only, with its platform metadata, and ignores empty text', async () => {
    let text = 'general: first message';
    fakeCdp.page('sl', 'https://app.slack.com/client/T1/C1', 'general', () => ({ text, html: '<html>slack</html>' }));
    const { m, items } = monitor();
    await m.pollOnce();
    await m.pollOnce();
    text = '  general: first message\nsecond message ';
    await m.pollOnce();
    await m.pollOnce();
    text = '   ';
    await m.pollOnce();
    expect(shape(items)).toEqual([
      { type: 'slack_message', source: 'browser', sourceApp: 'Chrome', url: 'https://app.slack.com/client/T1/C1', title: 'general', content: 'general: first message', rawHtml: '<html>slack</html>',
        metadata: { channelOrDm: 'general', platform: 'browser', direction: 'observed', recipientOrSender: '', captureMode: 'passive_observation' } },
      { type: 'slack_message', source: 'browser', sourceApp: 'Chrome', url: 'https://app.slack.com/client/T1/C1', title: 'general', content: 'general: first message\nsecond message', rawHtml: '<html>slack</html>',
        metadata: { channelOrDm: 'general', platform: 'browser', direction: 'observed', recipientOrSender: '', captureMode: 'passive_observation' } },
    ]);
  });

  it('a dynamic page is never read for form fields', async () => {
    fakeCdp.page('sl', 'https://app.slack.com/client/T1/C1', 'general', () => ({ text: LONG, fields: fields('Asha') }));
    const { m } = monitor();
    await m.pollOnce();
    expect(fakeCdp.stats.evals.fields).toBe(0);
  });

  it('an error page emits nothing and reads no further than its address', async () => {
    fakeCdp.page('e', 'https://down.test/', 'down.test', () => ({ href: 'chrome-error://chromewebdata/', text: LONG, html: '<html>err</html>' }));
    const { m, items } = monitor();
    await m.pollOnce();
    expect(items).toEqual([]);
    expect(fakeCdp.stats.evals.text).toBe(0);
  });

  it('frames add their text and frame count, in order, after the page text', async () => {
    fakeCdp.page('v', 'https://share.test/doc', 'Viewer', () => ({ text: `Toolbar ${LONG}`, html: '<html>v</html>' }));
    fakeCdp.frame('fa', 'v', 'https://office.test/a', () => ({ text: `CELL A ${LONG}` }));
    fakeCdp.frame('fb', 'v', 'https://office.test/b', () => ({ text: 'x', fields: fields('Frame') }));
    const { m, items } = monitor();
    await m.pollOnce();
    expect(items[0].content).toBe([
      `Toolbar ${LONG}`,
      `[frame https://office.test/a]\nCELL A ${LONG.trim()}`,
      '[frame https://office.test/b]\n--- Fields (1) ---\nFull name: Frame',
    ].join('\n\n'));
    expect(items[0].metadata).toEqual({ captureMode: 'passive_observation', frames: '2' });
  });

  it('a secret field is withheld in the content and never reaches the HTML', async () => {
    const secretFields = JSON.stringify({ fields: [
      { kind: 'textbox', label: 'API token', withheld: true, filled: true, path: '#t', native: true },
      { kind: 'textbox', label: 'Notes', value: `key ${AWS_KEY} here`, path: '#n', native: true },
    ], truncated: 0 });
    const html = '<html><body>password=SuperSecret123</body></html>';
    fakeCdp.page('sec', 'https://forms.test/secret', 'Secret', () => ({ text: LONG, fields: secretFields, html }));
    const { m, items } = monitor();
    await m.pollOnce();
    expect(items[0].content).toContain('API token: [withheld]');
    expect(items[0].content).not.toContain(AWS_KEY);
    expect(items[0].rawHtml).toBe(redactSecrets(html));
    expect(items[0].rawHtml).not.toContain('SuperSecret123');
  });

  describe('PDF tabs', () => {
    const PDF = Buffer.from('%PDF-1.4 fake pdf bytes').toString('base64');
    it('emits the file’s text with its size, once, and never reads the tab as a page', async () => {
      fakeCdp.page('pdf', 'https://x.test/files/report.pdf', 'Report', () => ({ pdf: PDF, text: 'viewer chrome' }));
      const readPdf = vi.fn(async () => '  Quarterly numbers  ');
      const { m, items } = monitor({ readPdf });
      await m.pollOnce();
      await m.pollOnce();
      expect(shape(items)).toEqual([{
        type: 'website_visit', source: 'browser', sourceApp: 'Chrome', url: 'https://x.test/files/report.pdf', title: 'Report',
        content: 'Quarterly numbers', metadata: { captureMode: 'passive_observation', contentKind: 'pdf', pdfBytes: String(Buffer.from(PDF, 'base64').length) },
      }]);
      expect(readPdf).toHaveBeenCalledTimes(1);
      expect(fakeCdp.stats.evals.pdf).toBe(1);
      expect(fakeCdp.stats.evals.text).toBe(0);
      expect(fakeCdp.stats.evals.html).toBe(0);
    });

    it('past the size cap the page answers nothing, and the next poll tries again', async () => {
      let answer = '';
      fakeCdp.page('pdf', 'https://x.test/big.pdf', 'Big', () => ({ pdf: answer }));
      const readPdf = vi.fn(async () => 'text');
      const { m, items } = monitor({ readPdf });
      await m.pollOnce();
      expect(items).toEqual([]);
      expect(readPdf).not.toHaveBeenCalled();
      answer = PDF;
      await m.pollOnce();
      expect(items).toHaveLength(1);
      expect(fakeCdp.stats.evals.pdf).toBe(2);
    });

    it('bytes that are not a PDF are retried on the next poll', async () => {
      fakeCdp.page('pdf', 'https://x.test/not.pdf', 'Not', () => ({ pdf: Buffer.from('<html>login</html>').toString('base64') }));
      const { m, items } = monitor({ readPdf: async () => 'text' });
      await m.pollOnce();
      await m.pollOnce();
      expect(items).toEqual([]);
      expect(fakeCdp.stats.evals.pdf).toBe(2);
    });

    it('a PDF with no readable text emits nothing and is not fetched again', async () => {
      fakeCdp.page('pdf', 'https://x.test/scan.pdf', 'Scan', () => ({ pdf: PDF }));
      const { m, items } = monitor({ readPdf: async () => '   ' });
      await m.pollOnce();
      await m.pollOnce();
      expect(items).toEqual([]);
      expect(fakeCdp.stats.evals.pdf).toBe(1);
    });

    it('a PDF already stored is not fetched at all', async () => {
      fakeCdp.page('pdf', 'https://x.test/stored.pdf', 'Stored', () => ({ pdf: PDF }));
      const { m, items } = monitor({ readPdf: async () => 'text', hasCaptured: url => url === 'https://x.test/stored.pdf' });
      await m.pollOnce();
      expect(items).toEqual([]);
      expect(fakeCdp.stats.evals.pdf).toBe(0);
    });

    it('without a PDF reader a PDF tab does nothing', async () => {
      fakeCdp.page('pdf', 'https://x.test/a.pdf', 'A', () => ({ pdf: PDF }));
      const { m, items } = monitor();
      await m.pollOnce();
      expect(items).toEqual([]);
      expect(fakeCdp.stats.evals.pdf).toBe(0);
    });

    it('a title that is a path falls back to the file name', async () => {
      fakeCdp.page('pdf', 'https://x.test/files/Annual%20Plan.pdf', 'x.test/files/Annual Plan.pdf', () => ({ pdf: PDF }));
      const { m, items } = monitor({ readPdf: async () => 'text' });
      await m.pollOnce();
      expect(items[0].title).toBe('Annual Plan.pdf');
    });
  });

  describe('read failures', () => {
    it('a prose read that times out logs the extraction failure and stores nothing, even with HTML available', async () => {
      const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
      fakeCdp.page('t', 'https://slow.test/page', 'Slow', () => ({ text: LONG, html: '<html>h</html>', fields: fields('Asha') }));
      fakeCdp.behave('t', 'text', { mode: 'hang' });
      const { m, items } = monitor({ maxSettleAttempts: 1 });
      await pollThroughTimeout(m, 8000);
      expect(items).toEqual([]);
      expect(errors).toHaveBeenCalledWith('Content extraction failed for https://slow.test/page:', 'CDP eval timeout');
      // The page recovers: the next poll captures it normally.
      fakeCdp.behave('t', 'text', null);
      await m.pollOnce();
      expect(items.map(item => item.url)).toEqual(['https://slow.test/page']);
    });

    it('a prose read that is rejected is the same: fatal for that tab this poll, others unaffected', async () => {
      const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
      fakeCdp.page('bad', 'https://bad.test/', 'Bad', () => ({ text: LONG, html: '<html>bad</html>', fields: fields('Asha') }));
      fakeCdp.page('ok', 'https://ok.test/', 'Ok', () => ({ text: LONG, html: '<html>ok</html>' }));
      fakeCdp.behave('bad', 'text', { mode: 'reject' });
      const { m, items } = monitor({ maxSettleAttempts: 1 });
      await m.pollOnce();
      expect(items.map(item => item.url)).toEqual(['https://ok.test/']);
      expect(errors.mock.calls.filter(call => String(call[0]).startsWith('Content extraction failed for https://bad.test/:'))).toHaveLength(1);
    });

    it('a failed address read is tolerated: the page is still captured', async () => {
      fakeCdp.page('h', 'https://h.test/', 'H', () => ({ text: LONG }));
      fakeCdp.behave('h', 'href', { mode: 'reject' });
      const { m, items } = monitor();
      await m.pollOnce();
      expect(items.map(item => item.url)).toEqual(['https://h.test/']);
    });

    it('a failed HTML read is tolerated: the item is emitted without rawHtml', async () => {
      fakeCdp.page('h', 'https://h.test/', 'H', () => ({ text: LONG, html: '<html>h</html>' }));
      fakeCdp.behave('h', 'html', { mode: 'reject' });
      const { m, items } = monitor();
      await m.pollOnce();
      expect(items).toHaveLength(1);
      expect(items[0].content).toBe(LONG.trim());
      expect(items[0].rawHtml).toBeUndefined();
    });

    it('a failed main-fields read is tolerated and recorded as unread, then picked up once it reads', async () => {
      fakeCdp.page('u', 'https://forms.test/u', 'U', () => ({ text: LONG, fields: fields('Asha') }));
      fakeCdp.behave('u', 'fields', { mode: 'reject' });
      const { m, items } = monitor();
      await m.pollOnce();
      expect(items).toHaveLength(1);
      expect(items[0].content).toBe(LONG.trim());
      // Still unreadable: no change. Readable: a change that holds two polls.
      await m.pollOnce();
      expect(items).toHaveLength(1);
      fakeCdp.behave('u', 'fields', null);
      await m.pollOnce();
      expect(items).toHaveLength(1);
      await m.pollOnce();
      expect(items).toHaveLength(2);
      expect(items[1].content).toContain('Full name: Asha');
    });

    it('an unread main-fields segment falls back to the previous read, so a blip is no change', async () => {
      fakeCdp.page('u', 'https://forms.test/blip', 'Blip', () => ({ text: LONG, fields: fields('Asha') }));
      const { m, items } = monitor();
      await m.pollOnce();
      fakeCdp.behave('u', 'fields', { mode: 'reject' });
      await m.pollOnce();
      await m.pollOnce();
      fakeCdp.behave('u', 'fields', null);
      await m.pollOnce();
      await m.pollOnce();
      expect(items).toHaveLength(1);
    });

    it('a failed frame field read reuses the frame’s previous read; a failed frame text read drops only that frame’s text', async () => {
      let frameName = 'Frame A';
      fakeCdp.page('host', 'https://share.test/host', 'Host', () => ({ text: LONG, fields: fields('Asha') }));
      fakeCdp.frame('ff', 'host', 'https://office.test/form?x=1', () => ({ text: `Frame form text that is long enough to keep. ${'z'.repeat(40)}`, fields: JSON.stringify({ fields: [{ kind: 'textbox', label: 'Frame name', value: frameName, path: '#f' }] }) }));
      const { m, items } = monitor();
      await m.pollOnce();
      expect(items[0].content).toContain('Frame name: Frame A');
      expect(items[0].content).toContain('Frame form text');
      fakeCdp.behave('ff', 'fields', { mode: 'reject' });
      await m.pollOnce();
      await m.pollOnce();
      expect(items).toHaveLength(1);
      fakeCdp.behave('ff', 'fields', null);
      frameName = 'Frame B';
      await m.pollOnce();
      await m.pollOnce();
      expect(items).toHaveLength(2);
      expect(items[1].content).toContain('Frame name: Frame B');
      // Frame text failing on a fresh page: the frame contributes no text, the page still captures.
      fakeCdp.page('host2', 'https://share.test/host2', 'Host2', () => ({ text: LONG }));
      fakeCdp.frame('ff2', 'host2', 'https://office.test/two', () => ({ text: `Frame two text ${'q'.repeat(60)}` }));
      fakeCdp.behave('ff2', 'text', { mode: 'reject' });
      await m.pollOnce();
      const second = items.find(item => item.url === 'https://share.test/host2');
      expect(second.content).toBe(LONG.trim());
      expect(second.metadata.frames).toBe('1');
    });

    it('a page that is not complete reads as empty on every call, then captures once complete', async () => {
      let ready = 'loading';
      fakeCdp.page('l', 'https://slowload.test/', 'Slow load', () => ({ ready, text: LONG, html: '<html>l</html>' }));
      const { m, items } = monitor({ maxSettleAttempts: 2 });
      await m.pollOnce();
      await m.pollOnce();
      await m.pollOnce();
      expect(items).toEqual([]);
      ready = 'complete';
      await m.pollOnce();
      expect(items).toHaveLength(1);
      expect(items[0].content).toBe(LONG.trim());
      expect(fakeCdp.stats.evals.text).toBe(1);
    });

    it('a target without a debugger address is treated as an empty page', async () => {
      fakeCdp.page('nows', 'https://nows.test/', 'No socket', () => ({ text: LONG }), { webSocketDebuggerUrl: '' });
      const { m, items } = monitor({ maxSettleAttempts: 1 });
      await m.pollOnce();
      expect(items).toEqual([]);
    });
  });

  it('tabs are read in the endpoint’s order and blocked or skipped targets are never opened', async () => {
    fakeCdp.page('a', 'https://a.test/', 'A', () => ({ text: `A ${LONG}` }));
    fakeCdp.page('b', 'https://b.test/', 'B', () => ({ text: `B ${LONG}` }));
    fakeCdp.page('own', 'https://own.test/', 'Hands-owned', () => ({ text: `own ${LONG}` }));
    fakeCdp.page('dash', 'http://localhost:7778/', 'Dashboard', () => ({ text: LONG }));
    fakeCdp.page('chrome', 'chrome://settings', 'Settings', () => ({ text: LONG }));
    fakeCdp.page('c', 'https://c.test/', 'C', () => ({ text: `C ${LONG}` }));
    const { m, items } = monitor({ shouldSkipTarget: (id: string) => id === 'own' });
    await m.pollOnce();
    expect(items.map(item => item.title)).toEqual(['A', 'B', 'C']);
    expect(Object.keys(fakeCdp.stats.byTarget).sort()).toEqual(['a', 'b', 'c']);
  });
});

/**
 * The two-phase read and the per-tab session: HTML only when a capture is
 * emitted, one WebSocket per tab per poll (frames on their own), failures of
 * tolerated reads that never poison later reads, a non-blocking first poll,
 * and a wall-time bound.
 */
describe('browser two-phase read and sessions', () => {
  const LONG = 'Real page content that BotBoy must keep. '.repeat(20);
  const fields = (name: string) => JSON.stringify({ fields: [{ kind: 'textbox', label: 'Full name', value: name, path: '#n', native: true }], truncated: 0 });

  beforeEach(() => { fakeCdp.clear(); vi.spyOn(console, 'log').mockImplementation(() => {}); vi.spyOn(console, 'error').mockImplementation(() => {}); });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  function monitor(config: Record<string, unknown> = {}) {
    const items: any[] = [];
    const m = createBrowserMonitor({ cdpEndpoint: fakeCdp.endpoint, pollIntervalMs: 60_000, maxSettleAttempts: 3, ...config });
    m.onWorkItem(item => items.push(item));
    return { m, items };
  }
  async function pollThroughTimeout(m: { pollOnce(): Promise<void> }, timeoutMs: number): Promise<void> {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const heldBefore = fakeCdp.stats.held;
    const poll = m.pollOnce();
    await fakeCdp.waitForHeld(heldBefore + 1);
    vi.advanceTimersByTime(timeoutMs);
    await poll;
    vi.useRealTimers();
  }

  describe('HTML is read only when a capture is emitted', () => {
    it('an unchanged page issues no HTML eval after the first emit', async () => {
      fakeCdp.page('p', 'https://news.test/story', 'Story', () => ({ text: LONG, html: '<html>one</html>' }));
      const { m, items } = monitor();
      await m.pollOnce();
      expect(fakeCdp.stats.evals.html).toBe(1);
      for (let i = 0; i < 4; i++) await m.pollOnce();
      expect(items).toHaveLength(1);
      expect(fakeCdp.stats.evals.html).toBe(1);
      // The text is still read every poll: that is how a change is noticed.
      expect(fakeCdp.stats.evals.text).toBe(5);
    });

    it('a thin page being waited on, a pending field change, and an unchanged dynamic page read no HTML', async () => {
      let name = 'Asha';
      fakeCdp.page('thin', 'https://app.test/loading', 'Loading', () => ({ text: '', html: '<html><body><p>Shell text</p></body></html>' }));
      fakeCdp.page('form', 'https://forms.test/f', 'Form', () => ({ text: LONG, fields: fields(name), html: '<html>form</html>' }));
      fakeCdp.page('slack', 'https://app.slack.com/client/T1/C1', 'general', () => ({ text: 'same message', html: '<html>slack</html>' }));
      const { m, items } = monitor();
      await m.pollOnce(); // thin attempt 1; form + slack first emit
      expect(fakeCdp.stats.byTarget.thin.html).toBe(0);
      expect(fakeCdp.stats.byTarget.form.html).toBe(1);
      expect(fakeCdp.stats.byTarget.slack.html).toBe(1);
      name = 'Asha Rao';
      await m.pollOnce(); // thin attempt 2; form change pending; slack unchanged
      expect(fakeCdp.stats.byTarget.thin.html).toBe(0);
      expect(fakeCdp.stats.byTarget.form.html).toBe(1);
      expect(fakeCdp.stats.byTarget.slack.html).toBe(1);
      await m.pollOnce(); // thin final attempt asks for HTML; form change confirmed
      expect(fakeCdp.stats.byTarget.thin.html).toBe(1);
      expect(fakeCdp.stats.byTarget.form.html).toBe(2);
      expect(fakeCdp.stats.byTarget.slack.html).toBe(1);
      expect(items.map(item => item.title)).toEqual(['Form', 'general', 'Loading', 'Form']);
    });

    it('an error page, a prose failure, and a blocked read issue no HTML eval', async () => {
      fakeCdp.page('err', 'https://down.test/', 'down', () => ({ href: 'chrome-error://chromewebdata/', html: '<html>err</html>' }));
      fakeCdp.page('bad', 'https://bad.test/', 'bad', () => ({ text: LONG, html: '<html>bad</html>' }));
      fakeCdp.behave('bad', 'text', { mode: 'reject' });
      const { m } = monitor({ maxSettleAttempts: 1 });
      await m.pollOnce();
      expect(fakeCdp.stats.evals.html).toBe(0);
    });

    it('rawHtml is always the redacted serialization', async () => {
      const html = '<html><body>api_key=sk_live_abcdefghijklmnop1234 and password=SuperSecret123</body></html>';
      fakeCdp.page('p', 'https://x.test/', 'X', () => ({ text: LONG, html }));
      fakeCdp.page('s', 'https://app.slack.com/client/T1/C2', 'dm', () => ({ text: 'a message', html }));
      const { m, items } = monitor();
      await m.pollOnce();
      expect(items).toHaveLength(2);
      for (const item of items) {
        expect(item.rawHtml).toBe(redactSecrets(html));
        expect(item.rawHtml).not.toContain('SuperSecret123');
      }
    });
  });

  describe('one WebSocket per tab per poll', () => {
    it('a tab’s address, text, fields, and HTML reads share one socket; each frame has its own', async () => {
      fakeCdp.page('p', 'https://share.test/doc', 'Doc', () => ({ text: LONG, fields: fields('Asha'), html: '<html>doc</html>' }));
      fakeCdp.frame('fa', 'p', 'https://office.test/a', () => ({ text: `Frame A ${LONG}`, fields: fields('A') }));
      fakeCdp.frame('fb', 'p', 'https://office.test/b', () => ({ text: `Frame B ${LONG}`, fields: fields('B') }));
      const { m, items } = monitor();
      await m.pollOnce();
      expect(items).toHaveLength(1);
      expect(fakeCdp.stats.socketsByTarget).toEqual({ p: 1, fa: 1, fb: 1 });
      expect(fakeCdp.stats.sockets).toBe(3);
      // href + text + fields + html on the page; fields + text per frame; each preceded by its readiness check.
      expect(fakeCdp.stats.byTarget.p).toMatchObject({ href: 1, text: 1, fields: 1, html: 1, ready: 4 });
      expect(fakeCdp.stats.byTarget.fa).toMatchObject({ text: 1, fields: 1, ready: 2 });
      expect(fakeCdp.stats.maxOpen).toBeLessThanOrEqual(2);
      expect(fakeCdp.stats.open).toBe(0);
    });

    it('opens one socket per tab per poll, however many polls, and none for tabs it leaves alone', async () => {
      fakeCdp.page('a', 'https://a.test/', 'A', () => ({ text: `A ${LONG}` }));
      fakeCdp.page('b', 'https://b.test/', 'B', () => ({ text: `B ${LONG}` }));
      const { m } = monitor();
      for (let i = 0; i < 3; i++) await m.pollOnce();
      expect(fakeCdp.stats.socketsByTarget).toEqual({ a: 3, b: 3 });
    });

    it('a session’s request ids only grow', async () => {
      fakeCdp.page('p', 'https://x.test/', 'X', () => ({ text: LONG }));
      const { m } = monitor();
      await m.pollOnce();
      const ids = fakeCdp.stats.requestIds;
      expect(ids.length).toBeGreaterThan(4);
      expect(ids).toEqual([...ids].sort((a, b) => a - b));
      expect(new Set(ids).size).toBe(ids.length);
    });

    it('a failed tolerated read does not poison the reads after it: the session reopens lazily', async () => {
      fakeCdp.page('p', 'https://forms.test/p', 'P', () => ({ text: LONG, fields: fields('Asha'), html: '<html>after</html>' }));
      fakeCdp.behave('p', 'fields', { mode: 'reject' });
      const { m, items } = monitor();
      await m.pollOnce();
      expect(items).toHaveLength(1);
      expect(items[0].content).toBe(LONG.trim());
      expect(items[0].rawHtml).toBe('<html>after</html>');
      // The socket the fields read died; the HTML read opened a new one.
      expect(fakeCdp.stats.socketsByTarget.p).toBe(2);
      expect(fakeCdp.stats.open).toBe(0);
    });

    it('a tolerated read that times out closes its socket and the next read still works', async () => {
      fakeCdp.page('p', 'https://forms.test/t', 'T', () => ({ text: LONG, fields: fields('Asha'), html: '<html>after-timeout</html>' }));
      fakeCdp.behave('p', 'fields', { mode: 'hang' });
      const { m, items } = monitor();
      await pollThroughTimeout(m, 6000);
      expect(items).toHaveLength(1);
      expect(items[0].rawHtml).toBe('<html>after-timeout</html>');
      expect(fakeCdp.stats.socketsByTarget.p).toBe(2);
    });

    it('a prose failure still yields an empty read with the same log text and closes the socket', async () => {
      const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
      fakeCdp.page('p', 'https://bad.test/', 'Bad', () => ({ text: LONG }));
      fakeCdp.behave('p', 'text', { mode: 'reject' });
      const { m, items } = monitor({ maxSettleAttempts: 1 });
      await m.pollOnce();
      expect(items).toEqual([]);
      expect(errors).toHaveBeenCalledWith('Content extraction failed for https://bad.test/:', expect.any(String));
      await vi.waitFor(() => expect(fakeCdp.stats.open).toBe(0));
    });
  });

  describe('openCdpSession', () => {
    const target = (answer: () => any = () => ({ text: 'hello' })) => {
      fakeCdp.page('s', 'https://s.test/', 'S', answer);
      return `ws://${fakeCdp.base}/devtools/page/s`;
    };

    it('opens nothing until its first call, and close() is always safe', async () => {
      const session = openCdpSession(target());
      session.close();
      expect(fakeCdp.stats.sockets).toBe(0);
      expect(await session.eval('"x"')).toBe('hello');
      expect(fakeCdp.stats.sockets).toBe(1);
      session.close();
      session.close();
      await vi.waitFor(() => expect(fakeCdp.stats.open).toBe(0));
    });

    it('reuses one socket for many evaluations, checking readiness before each', async () => {
      const session = openCdpSession(target());
      for (let i = 0; i < 5; i++) expect(await session.eval(`"expr ${i}"`)).toBe('hello');
      expect(fakeCdp.stats.sockets).toBe(1);
      expect(fakeCdp.stats.evals.ready).toBe(5);
      expect(fakeCdp.stats.evals.text).toBe(5);
      expect(session.bytes).toBeGreaterThan(0);
      session.close();
    });

    it('answers an empty string and injects nothing while the page is not complete', async () => {
      const session = openCdpSession(target(() => ({ ready: 'loading', text: 'never' })));
      expect(await session.eval('"x"')).toBe('');
      expect(await session.eval('"y"')).toBe('');
      expect(fakeCdp.stats.evals.text).toBe(0);
      expect(fakeCdp.stats.sockets).toBe(1);
      session.close();
    });

    it('a socket error rejects the call, discards the socket, and the next call reopens', async () => {
      const session = openCdpSession(target());
      fakeCdp.behave('s', 'text', { mode: 'reject' });
      await expect(session.eval('"boom"')).rejects.toBeTruthy();
      await vi.waitFor(() => expect(fakeCdp.stats.open).toBe(0));
      fakeCdp.behave('s', 'text', null);
      expect(await session.eval('"again"')).toBe('hello');
      expect(fakeCdp.stats.sockets).toBe(2);
      session.close();
    });

    it('a timeout rejects with the eval-timeout error, closes the socket, and the next call reopens', async () => {
      const session = openCdpSession(target());
      fakeCdp.behave('s', 'text', { mode: 'hang' });
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const call = session.eval('"slow"', 3000);
      const outcome = call.then(() => 'resolved', (err: Error) => err.message);
      await fakeCdp.waitForHeld(1);
      vi.advanceTimersByTime(3000);
      expect(await outcome).toBe('CDP eval timeout');
      vi.useRealTimers();
      await vi.waitFor(() => expect(fakeCdp.stats.open).toBe(0));
      fakeCdp.behave('s', 'text', null);
      expect(await session.eval('"later"')).toBe('hello');
      expect(fakeCdp.stats.sockets).toBe(2);
      session.close();
    });

    it('a server that drops the socket leaves the call to its own timeout, like the one-shot eval', async () => {
      const session = openCdpSession(target());
      fakeCdp.behave('s', 'text', { mode: 'close' });
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const outcome = session.eval('"dropped"', 2000).then(() => 'resolved', (err: Error) => err.message);
      await vi.waitFor(() => expect(fakeCdp.stats.evals.text).toBe(1), { interval: 5 }).catch(() => {});
      // Real I/O settles on real macrotasks; the fake clock moves only when told.
      await new Promise<void>(resolve => setImmediate(resolve));
      vi.advanceTimersByTime(2000);
      expect(await outcome).toBe('CDP eval timeout');
      vi.useRealTimers();
      fakeCdp.behave('s', 'text', null);
      expect(await session.eval('"after"')).toBe('hello');
      session.close();
    });
  });

  describe('parseHrefProbe', () => {
    it('reads the address and visibility pair; anything else is the address with unknown visibility', () => {
      expect(parseHrefProbe('["https://x.test/a","visible"]')).toEqual({ href: 'https://x.test/a', visibility: 'visible' });
      expect(parseHrefProbe('["chrome-error://chromewebdata/","hidden"]')).toEqual({ href: 'chrome-error://chromewebdata/', visibility: 'hidden' });
      expect(parseHrefProbe('["https://x.test/a"]')).toEqual({ href: 'https://x.test/a', visibility: 'unknown' });
      expect(parseHrefProbe('https://x.test/plain')).toEqual({ href: 'https://x.test/plain', visibility: 'unknown' });
      expect(parseHrefProbe('')).toEqual({ href: '', visibility: 'unknown' });
      expect(parseHrefProbe('[1,2]')).toEqual({ href: '[1,2]', visibility: 'unknown' });
      expect(parseHrefProbe('"quoted"')).toEqual({ href: '"quoted"', visibility: 'unknown' });
    });

    it('the monitor treats a plain-address answer like the pair (older pages, other fakes)', async () => {
      fakeCdp.page('e', 'https://down.test/', 'down', () => ({ href: 'chrome-error://chromewebdata/', text: LONG }));
      const { m, items } = monitor();
      await m.pollOnce();
      expect(items).toEqual([]);
    });
  });

  describe('start, stop, and overlapping polls', () => {
    it('start() resolves at once when the endpoint never answers, and stop() leaves no timer', async () => {
      fakeCdp.hangList = true;
      const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
      const { m } = monitor({ pollIntervalMs: 54_321 });
      const startedAt = Date.now();
      await m.start();
      expect(Date.now() - startedAt).toBeLessThan(1000);
      await fakeCdp.waitForHeld(1);
      m.stop();
      // Nothing is scheduled while the first poll is pending, and nothing after stop().
      expect(setTimeoutSpy.mock.calls.filter(call => call[1] === 54_321)).toEqual([]);
      fakeCdp.hangList = false;
    });

    it('schedules the next poll one interval after a poll ends, and stop() clears that pending timer', async () => {
      fakeCdp.page('p', 'https://x.test/', 'X', () => ({ text: LONG }));
      const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
      const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');
      const { m, items } = monitor({ pollIntervalMs: 54_321 });
      await m.start();
      await vi.waitFor(() => expect(setTimeoutSpy.mock.calls.filter(call => call[1] === 54_321)).toHaveLength(1));
      expect(items).toHaveLength(1);
      const handle = setTimeoutSpy.mock.results[setTimeoutSpy.mock.calls.findIndex(call => call[1] === 54_321)].value;
      m.stop();
      expect(clearTimeoutSpy).toHaveBeenCalledWith(handle);
    });

    it('polls again on its own interval, never overlapping itself', async () => {
      fakeCdp.page('p', 'https://x.test/', 'X', () => ({ text: LONG }));
      const { m } = monitor({ pollIntervalMs: 25 });
      await m.start();
      await vi.waitFor(() => expect(fakeCdp.stats.listCalls).toBeGreaterThanOrEqual(3), { timeout: 3000 });
      m.stop();
      const calls = fakeCdp.stats.listCalls;
      await new Promise(resolve => setTimeout(resolve, 120));
      // At most the one poll that was already running when stop() was called.
      expect(fakeCdp.stats.listCalls).toBeLessThanOrEqual(calls + 1);
    });

    it('a second pollOnce during a poll joins it instead of starting another', async () => {
      fakeCdp.page('p', 'https://x.test/', 'X', () => ({ text: LONG }));
      const { m, items } = monitor();
      await Promise.all([m.pollOnce(), m.pollOnce(), m.pollOnce()]);
      expect(fakeCdp.stats.listCalls).toBe(1);
      expect(items).toHaveLength(1);
      await m.pollOnce();
      expect(fakeCdp.stats.listCalls).toBe(2);
    });

    it('a restarted monitor runs one chain of polls, not two', async () => {
      fakeCdp.page('p', 'https://x.test/', 'X', () => ({ text: LONG }));
      const { m } = monitor({ pollIntervalMs: 20 });
      await m.start();
      m.stop();
      await m.start();
      await new Promise(resolve => setTimeout(resolve, 200));
      m.stop();
      await new Promise(resolve => setTimeout(resolve, 60));
      const total = fakeCdp.stats.listCalls;
      // One chain at a 20 ms interval cannot exceed ~10 polls in 200 ms plus the two starts.
      expect(total).toBeLessThanOrEqual(14);
    });
  });

  describe('wall-time bound', () => {
    it('defers the remaining tabs once the budget is used, reads the first tab in full, and advances no remembered state for deferred tabs', async () => {
      let clock = 0;
      let slowOnce = true;
      fakeCdp.page('a', 'https://a.test/', 'A', () => { if (slowOnce) { slowOnce = false; clock += 25_000; } return { text: `A ${LONG}` }; });
      // B is thin until its third attempt: a deferred poll must not count as an attempt.
      fakeCdp.page('b', 'https://b.test/', 'B', () => ({ text: 'Loading…' }));
      fakeCdp.page('c', 'https://c.test/', 'C', () => ({ text: `C ${LONG}` }));
      const { m, items } = monitor({ maxPollWallMs: 20_000, now: () => clock, maxSettleAttempts: 2 });
      await m.pollOnce(); // A alone: the budget is gone after it
      expect(items.map(item => item.title)).toEqual(['A']);
      expect(fakeCdp.stats.byTarget.b).toBeUndefined();
      expect(fakeCdp.stats.byTarget.c).toBeUndefined();
      await m.pollOnce(); // B attempt 1 (wait), C first sight
      expect(items.map(item => item.title)).toEqual(['A', 'C']);
      await m.pollOnce(); // B attempt 2: settles for its thin text
      expect(items.map(item => item.title)).toEqual(['A', 'C', 'B']);
    });

    it('defers a tab between its probe and its HTML read with its state untouched, then emits it next poll', async () => {
      let clock = 0;
      let slowOnce = true;
      fakeCdp.page('a', 'https://a.test/', 'A', () => ({ text: `A ${LONG}`, html: '<html>a</html>' }));
      fakeCdp.page('b', 'https://b.test/', 'B', () => { if (slowOnce) { slowOnce = false; clock += 25_000; } return { text: `B ${LONG}`, html: '<html>b</html>' }; });
      const { m, items } = monitor({ maxPollWallMs: 20_000, now: () => clock });
      await m.pollOnce();
      expect(items.map(item => item.title)).toEqual(['A']);
      expect(fakeCdp.stats.byTarget.b).toMatchObject({ text: 1, html: 0 });
      await m.pollOnce();
      expect(items.map(item => item.title)).toEqual(['A', 'B']);
      expect(items[1].rawHtml).toBe('<html>b</html>');
    });

    it('a pending field change does not advance on a poll that never reached the tab', async () => {
      let clock = 0;
      let name = 'Asha';
      let burn = true; // the first read of A uses up the poll's whole budget
      fakeCdp.page('a', 'https://a.test/', 'A', () => { if (burn) { burn = false; clock += 25_000; } return { text: `A ${LONG}` }; });
      fakeCdp.page('f', 'https://forms.test/', 'F', () => ({ text: LONG, fields: fields(name) }));
      const { m, items } = monitor({ maxPollWallMs: 20_000, now: () => clock });
      await m.pollOnce(); // A burns the budget; F deferred
      expect(fakeCdp.stats.byTarget.f).toBeUndefined();
      await m.pollOnce(); // F first sight
      expect(items.map(item => item.title)).toEqual(['A', 'F']);
      name = 'Asha Rao';
      burn = true;
      await m.pollOnce(); // A burns the budget again: F is not read, so its change is not even pending
      await m.pollOnce(); // F read: the change is pending (first equal read)
      expect(items.map(item => item.title)).toEqual(['A', 'F']);
      await m.pollOnce(); // F read again: confirmed
      expect(items.map(item => item.title)).toEqual(['A', 'F', 'F']);
    });

    it('the default budget is 20 seconds and an infinite budget never defers', async () => {
      let clock = 0;
      fakeCdp.page('a', 'https://a.test/', 'A', () => { clock += 1_000_000; return { text: `A ${LONG}` }; });
      fakeCdp.page('b', 'https://b.test/', 'B', () => ({ text: `B ${LONG}` }));
      const unbounded = monitor({ maxPollWallMs: Number.POSITIVE_INFINITY, now: () => clock });
      await unbounded.m.pollOnce();
      expect(unbounded.items.map(item => item.title)).toEqual(['A', 'B']);
    });
  });
});

describe('adaptive pacing, owner pause, and wake', () => {
  const LONG = 'Real page content that BotBoy must keep. '.repeat(20);
  beforeEach(() => { fakeCdp.clear(); vi.spyOn(console, 'log').mockImplementation(() => {}); vi.spyOn(console, 'error').mockImplementation(() => {}); });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
  type Sample = { pressure: 'normal' | 'warn' | 'critical'; loadPerCpu: number };
  function monitor(config: Record<string, unknown> = {}) {
    const items: any[] = [];
    const sample: Sample = { pressure: 'normal', loadPerCpu: 0 };
    const changes: any[] = [];
    const stats: any[] = [];
    const m = createBrowserMonitor({
      cdpEndpoint: fakeCdp.endpoint,
      pollIntervalMs: 30_000,
      maxSettleAttempts: 3,
      adaptive: true,
      sampleSystem: () => ({ ...sample }),
      onStatusChange: (status: any) => changes.push(status),
      onPollStats: (s: any) => stats.push(s),
      ...config,
    });
    m.onWorkItem(item => items.push(item));
    return { m, items, sample, changes, stats };
  }
  const addPages = (count: number) => {
    for (let i = 0; i < count; i++) {
      const id = `t${String(i).padStart(2, '0')}`;
      fakeCdp.page(id, `https://site.test/${id}`, id, () => ({ text: `${id} ${LONG}` }));
    }
  };

  it('doubles the interval under memory pressure, holds the 5 minute cap, and reports each change', async () => {
    addPages(1);
    const { m, sample, changes } = monitor();
    expect(m.status()).toMatchObject({ paused: false, intervalMs: 30_000, baseIntervalMs: 30_000, slowedReason: null });
    sample.pressure = 'warn';
    const seen: number[] = [];
    for (let i = 0; i < 6; i++) { await m.pollOnce(); seen.push(m.status().intervalMs); }
    expect(seen).toEqual([60_000, 120_000, 240_000, 300_000, 300_000, 300_000]);
    expect(m.status().slowedReason).toBe('memory pressure: warn');
    expect(changes).toHaveLength(4);
  });

  it('schedules the next poll at the governed interval', async () => {
    addPages(1);
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    const { m, sample } = monitor({ pollIntervalMs: 31_000 });
    sample.pressure = 'critical';
    await m.start();
    await vi.waitFor(() => expect(setTimeoutSpy.mock.calls.filter(call => call[1] === 62_000)).toHaveLength(1));
    m.stop();
  });

  it('returns to the base interval after three calm polls', async () => {
    addPages(1);
    const { m, sample, changes } = monitor();
    sample.loadPerCpu = 2;
    await m.pollOnce();
    await m.pollOnce();
    expect(m.status()).toMatchObject({ intervalMs: 120_000, slowedReason: 'high CPU load' });
    sample.loadPerCpu = 0.2;
    await m.pollOnce();
    await m.pollOnce();
    expect(m.status().intervalMs).toBe(120_000);
    await m.pollOnce();
    expect(m.status()).toMatchObject({ intervalMs: 30_000, slowedReason: null });
    expect(changes[changes.length - 1]).toMatchObject({ intervalMs: 30_000 });
  });

  it('slows on a slow median probe measured with the injected clock', async () => {
    let clock = 0;
    for (const id of ['a', 'b', 'c']) {
      fakeCdp.page(id, `https://slow.test/${id}`, id, () => ({
        get text() { clock += 5_000; return `${id} ${LONG}`; },
      }));
    }
    const { m, stats } = monitor({ now: () => clock, maxPollWallMs: Number.POSITIVE_INFINITY });
    await m.pollOnce();
    expect(stats[0].perTab.filter((t: any) => t.phase === 'probe').map((t: any) => t.ms)).toEqual([5_000, 5_000, 5_000]);
    expect(m.status()).toMatchObject({ intervalMs: 60_000, slowedReason: 'slow polls' });
  });

  it('does not count a tab whose text timed out toward the median probe', async () => {
    let clock = 0;
    fakeCdp.page('ok', 'https://ok.test/', 'ok', () => ({ text: `ok ${LONG}` }));
    fakeCdp.page('dead', 'https://dead.test/', 'dead', () => ({ text: `dead ${LONG}` }));
    fakeCdp.behave('dead', 'text', { mode: 'reject' });
    const { m, stats } = monitor({ now: () => { clock += 1; return clock; }, maxPollWallMs: Number.POSITIVE_INFINITY });
    await m.pollOnce();
    // Both probes are recorded for measurement; only the readable tab feeds the governor.
    expect(stats[0].perTab.filter((t: any) => t.phase === 'probe')).toHaveLength(2);
    expect(m.status().intervalMs).toBe(30_000);
  });

  it('applies the tab budget only while slowed, never defers first-sight tabs, and reaches every tab', async () => {
    addPages(20);
    const { m, sample } = monitor({ maxTabsPerPoll: 5, maxPollWallMs: Number.POSITIVE_INFINITY });
    await m.pollOnce(); // calm: all 20 read, all captured
    expect(m.status()).toMatchObject({ tabsSeen: 20, tabsRead: 20, tabsDeferred: 0 });
    sample.pressure = 'warn';
    await m.pollOnce(); // planned while calm: still every tab; this poll observes the pressure
    expect(m.status()).toMatchObject({ tabsRead: 20, tabsDeferred: 0 });
    fakeCdp.resetStats();
    // One last-visible tab plus four round-robin slots: ceil(19 / 4) = 5 polls reach every tab.
    for (let i = 0; i < 5; i++) {
      await m.pollOnce();
      expect(m.status().tabsRead).toBe(5);
      expect(m.status().tabsDeferred).toBe(15);
    }
    for (let i = 0; i < 20; i++) expect(fakeCdp.stats.byTarget[`t${String(i).padStart(2, '0')}`]?.text ?? 0).toBeGreaterThanOrEqual(1);
    // A tab opened while slowed is first sight: read in the very next poll.
    fakeCdp.page('fresh', 'https://site.test/fresh', 'fresh', () => ({ text: `fresh ${LONG}` }));
    fakeCdp.resetStats();
    await m.pollOnce();
    expect(fakeCdp.stats.byTarget.fresh?.text).toBe(1);
  });

  it('serves a pending field change every poll while slowed, so its debounce completes', async () => {
    addPages(12);
    let name = 'Asha';
    const fields = (value: string) => JSON.stringify({ fields: [{ kind: 'textbox', label: 'Full name', value, path: '#n', native: true }], truncated: 0 });
    fakeCdp.page('form', 'https://forms.test/', 'Form', () => ({ text: LONG, fields: fields(name), visibility: 'hidden' }));
    const { m, items, sample } = monitor({ maxTabsPerPoll: 4, maxPollWallMs: Number.POSITIVE_INFINITY });
    await m.pollOnce();
    sample.pressure = 'warn';
    await m.pollOnce();
    const base = items.length;
    name = 'Asha Rao';
    await m.pollOnce(); // pending (slowed from here on)
    await m.pollOnce(); // confirmed
    expect(items.length).toBe(base + 1);
    expect(items[items.length - 1].title).toBe('Form');
  });

  describe('owner pause', () => {
    it('makes no /json/list request and no CDP call while paused, and resumes on the next poll', async () => {
      addPages(2);
      let paused = true;
      const { m, items } = monitor({ isPaused: () => paused });
      await m.pollOnce();
      await m.pollOnce();
      expect(fakeCdp.stats.listCalls).toBe(0);
      expect(fakeCdp.stats.sockets).toBe(0);
      expect(m.status().paused).toBe(true);
      paused = false;
      await m.pollOnce();
      expect(fakeCdp.stats.listCalls).toBe(1);
      expect(items).toHaveLength(2);
      expect(m.status().paused).toBe(false);
    });

    it('a pause that arrives mid-poll blocks the next emit and advances no remembered state', async () => {
      let paused = false;
      let flipOnce = true;
      fakeCdp.page('a', 'https://a.test/', 'A', () => ({
        get text() { if (flipOnce) { flipOnce = false; paused = true; } return `A ${LONG}`; },
        html: '<html>a</html>',
      }));
      fakeCdp.page('b', 'https://b.test/', 'B', () => ({ text: `B ${LONG}` }));
      const { m, items } = monitor({ isPaused: () => paused });
      await m.pollOnce();
      expect(items).toEqual([]);
      expect(fakeCdp.stats.byTarget.b).toBeUndefined();
      expect(fakeCdp.stats.evals.html).toBe(0);
      paused = false;
      await m.pollOnce();
      // A is still first sight: nothing was marked captured while paused.
      expect(items.map(item => item.title)).toEqual(['A', 'B']);
    });

    it('a pause that arrives during the HTML read drops that emit and keeps the tab first sight', async () => {
      let paused = false;
      let flipOnce = true;
      fakeCdp.page('a', 'https://a.test/', 'A', () => ({
        text: `A ${LONG}`,
        get html() { if (flipOnce) { flipOnce = false; paused = true; } return '<html>a</html>'; },
      }));
      const { m, items } = monitor({ isPaused: () => paused });
      await m.pollOnce();
      expect(items).toEqual([]);
      paused = false;
      await m.pollOnce();
      // Still first sight, so it is captured now, once, with its HTML.
      expect(items.map(item => item.title)).toEqual(['A']);
      expect(items[0].rawHtml).toBe('<html>a</html>');
    });
  });

  describe('wake', () => {
    it('does nothing on a stopped monitor', async () => {
      addPages(1);
      const { m } = monitor();
      m.wake();
      await new Promise(resolve => setTimeout(resolve, 50));
      expect(fakeCdp.stats.listCalls).toBe(0);
    });

    it('resets a slowed interval to base and polls once now', async () => {
      addPages(1);
      const { m, sample } = monitor({ pollIntervalMs: 60_000 });
      sample.pressure = 'warn';
      await m.start();
      await vi.waitFor(() => expect(m.status().intervalMs).toBe(120_000));
      expect(fakeCdp.stats.listCalls).toBe(1);
      sample.pressure = 'normal';
      m.wake();
      expect(m.status().intervalMs).toBe(60_000);
      await vi.waitFor(() => expect(fakeCdp.stats.listCalls).toBe(2));
      m.stop();
    });

    it('during an in-flight poll sets a flag and runs exactly one follow-up', async () => {
      addPages(1);
      fakeCdp.behave('t00', 'text', { mode: 'delay', ms: 120 });
      const { m } = monitor({ pollIntervalMs: 60_000 });
      await m.start();
      await vi.waitFor(() => expect(fakeCdp.stats.listCalls).toBe(1));
      m.wake();
      m.wake();
      m.wake();
      await vi.waitFor(() => expect(fakeCdp.stats.listCalls).toBe(2), { timeout: 3000 });
      await new Promise(resolve => setTimeout(resolve, 400));
      expect(fakeCdp.stats.listCalls).toBe(2);
      m.stop();
    });

    it('a resume while paused polls at once', async () => {
      addPages(1);
      let paused = true;
      const { m, items } = monitor({ pollIntervalMs: 60_000, isPaused: () => paused });
      await m.start();
      await new Promise(resolve => setTimeout(resolve, 50));
      expect(fakeCdp.stats.listCalls).toBe(0);
      paused = false;
      m.wake();
      await vi.waitFor(() => expect(items).toHaveLength(1));
      m.stop();
    });
  });

  it('reports per-poll stats: tabs seen, read and deferred, and each phase of each tab', async () => {
    addPages(2);
    const { m, stats } = monitor();
    await m.pollOnce();
    expect(stats).toHaveLength(1);
    expect(stats[0]).toMatchObject({ tabsSeen: 2, tabsRead: 2, tabsDeferred: 0 });
    expect(stats[0].perTab.map((t: any) => t.phase)).toEqual(['probe', 'html', 'probe', 'html']);
    expect(stats[0].perTab.every((t: any) => t.bytes > 0)).toBe(true);
    await m.pollOnce();
    // An unchanged page is probed only: no HTML phase.
    expect(stats[1].perTab.map((t: any) => t.phase)).toEqual(['probe', 'probe']);
  });
});
