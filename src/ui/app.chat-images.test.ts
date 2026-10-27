// @vitest-environment jsdom
//
// Pictures in Markdown (docs/maps/document-media.md): the reader and chat show
// ![description](source) only for pictures BotBoy holds, at same-origin routes,
// with the same source forms the exports accept (core/media-sources.ts).
import { beforeAll, describe, expect, it, vi } from 'vitest';

const APP_HTML = `
  <div id="breadcrumb"></div>
  <div id="grid-view"></div>
  <div id="detail-view"></div>
  <div id="chat-messages"></div>
  <div id="chat-panel"></div>
  <input id="chatInput" />
  <span id="noise-toggle"></span>
`;

function makeResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: 'OK',
    json: async () => body,
    text: async () => JSON.stringify(body),
    clone() { return makeResponse(status, body); },
  };
}

type Render = (raw: string) => string;
let render: Render;
let imageUrl: (source: string) => string | null;

beforeAll(async () => {
  document.body.innerHTML = APP_HTML;
  vi.stubGlobal('setInterval', () => 0 as unknown as NodeJS.Timeout);
  // Same benign-init harness as app.chat-links.test.ts: polling never fires.
  vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
    const url = typeof input === 'string' ? input : (input as Request).url;
    if (url.endsWith('/api/nodes/roots')) return makeResponse(200, []);
    if (url.endsWith('/api/chat/history')) return makeResponse(200, []);
    if (url.endsWith('/api/slack/conversations')) return makeResponse(200, { conversations: [] });
    if (url.endsWith('/api/slack/config')) return makeResponse(200, { ids: [] });
    return makeResponse(200, {});
  }));
  await import('./app.js');
  render = (window as unknown as { formatMarkdownContent: Render }).formatMarkdownContent;
  imageUrl = (window as unknown as { markdownImageUrl: (source: string) => string | null }).markdownImageUrl;
});

function images(html: string): HTMLImageElement[] {
  const root = document.createElement('div');
  root.innerHTML = html;
  return [...root.querySelectorAll('img')];
}

const ASSET = `va_${'a'.repeat(32)}`;
const VERSION = `vav_${'b'.repeat(32)}`;

describe('pictures in the reader and in chat', () => {
  it('maps every source form BotBoy holds to its same-origin route', () => {
    expect(imageUrl('/api/files/shots/pie%20chart.png')).toBe('/api/files/shots/pie%20chart.png');
    expect(imageUrl('<shots/pie chart.png>')).toBe('/api/files/shots/pie%20chart.png');
    expect(imageUrl('~/.personal-productivity-tracker/files/a/b.svg')).toBe('/api/files/a/b.svg');
    expect(imageUrl('/Users/jane/.personal-productivity-tracker/files/additional inputs/x.png')).toBe('/api/files/additional%20inputs/x.png');
    expect(imageUrl(ASSET)).toBe(`/api/visual-assets/${ASSET}/original`);
    expect(imageUrl(`/api/visual-assets/${ASSET}/original?versionId=${VERSION}`)).toBe(`/api/visual-assets/${ASSET}/original?versionId=${VERSION}`);
    expect(imageUrl('att_0123456789ab')).toBe('/api/chat/attachments/att_0123456789ab');
    expect(imageUrl('/Users/jane/.personal-productivity-tracker/chat-attachments/att_0123456789ab.png')).toBe('/api/chat/attachments/att_0123456789ab');
  });

  it('never makes the page load an outside address or a path outside BotBoy’s files', () => {
    for (const source of [
      'https://tracker.example.com/pixel.png',
      'http://127.0.0.1:9222/json',
      '//evil.example.com/x.png',
      'javascript:alert(1)',
      'data:image/svg+xml;base64,PHN2Zz4=',
      '/Users/jane/.ssh/id_rsa',
      '/api/files/../tracker.db',
      '/api/files/%2e%2e/tracker.db',
      'a/../../b.png',
      '"onerror="alert(1).png',
    ]) {
      expect(imageUrl(source), source).toBeNull();
    }
  });

  it('renders a picture as an image with its description, and an outside one as text', () => {
    const [picture] = images(render('Before.\n\n![Pie chart](/api/files/chart.png "Share")\n\nAfter.'));
    expect(picture?.getAttribute('src')).toBe('/api/files/chart.png');
    expect(picture?.getAttribute('alt')).toBe('Pie chart');
    expect(picture?.getAttribute('loading')).toBe('lazy');
    expect(picture?.closest('a')?.getAttribute('href')).toBe('/api/files/chart.png');
    const outside = render('![Tracker](https://tracker.example.com/pixel.png)');
    expect(images(outside)).toHaveLength(0);
    expect(outside).not.toContain('<img');
  });

  it('escapes the description, keeps code as code, and leaves links beside pictures working', () => {
    const [picture] = images(render('![<b>"x"</b> & y](chart.png)'));
    expect(picture?.getAttribute('alt')).toBe('<b>"x"</b> & y');
    expect(render('`![not a picture](chart.png)`')).toContain('<code>![not a picture](chart.png)</code>');
    const mixed = render(`![Shot](${ASSET}) and [the doc](https://example.com/doc)`);
    expect(images(mixed)).toHaveLength(1);
    expect(mixed).toContain('href="https://example.com/doc"');
    expect(mixed).not.toContain('!<a');
  });

  it('a picture whose file is gone says so instead of showing a broken image', () => {
    const root = document.createElement('div');
    root.innerHTML = render('![Old chart](/api/files/gone.png)');
    document.body.appendChild(root);
    root.querySelector('img')!.dispatchEvent(new Event('error'));
    expect(root.querySelector('img')).toBeNull();
    expect(root.querySelector('.md-image-missing')?.textContent).toBe('Picture not found: Old chart');
    root.remove();
  });
});
