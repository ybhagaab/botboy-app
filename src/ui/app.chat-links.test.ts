// @vitest-environment jsdom
//
// Chat markdown links to BotBoy's own views (owner report 2026-10-05). Tools
// return exact in-app routes — a staged SharePoint edit's `readerLink` is
// `#/doc/<base64url docKey>` — and the prompt tells the model to give them to
// the owner. The renderer used to accept only http(s) and /api/files/ links,
// so "Open the document to Approve + Sync" rendered as dead bracket text.
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

beforeAll(async () => {
  document.body.innerHTML = APP_HTML;
  // Same benign-init harness as app.file-preview.test.ts: polling never fires.
  vi.stubGlobal('setInterval', () => 0 as unknown as NodeJS.Timeout);
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
});

function anchors(html: string): HTMLAnchorElement[] {
  const root = document.createElement('div');
  root.innerHTML = html;
  return [...root.querySelectorAll('a')];
}

const READER = '#/doc/YW1hem9uLnNoYXJlcG9pbnQuY29tL3NpdGVzL214LXdlbmhhaS10ZWFtL1NoYXJlZCBEb2N1bWVudHMvQ29udHJhY3QuZG9jeA';

describe('chat links to in-app views', () => {
  it('renders the staged-edit reader link the model actually wrote as a same-tab link', () => {
    const html = render(`The changes are staged for review.\n\n[**Open the document to Approve + Sync**](${READER}).`);
    const [link] = anchors(html);
    expect(link?.getAttribute('href')).toBe(READER);
    expect(link?.hasAttribute('target')).toBe(false);
    expect(link?.querySelector('strong')?.textContent).toBe('Open the document to Approve + Sync');
    expect(html).not.toContain('](#/doc/');
  });

  it('turns a bare reader route into a readable link', () => {
    const [link] = anchors(render(`Review it here: ${READER}`));
    expect(link?.getAttribute('href')).toBe(READER);
    expect(link?.textContent).toBe('Open in the document reader');
    expect(link?.hasAttribute('target')).toBe(false);
  });

  it('accepts other dashboard routes and keeps external links in a new tab', () => {
    const html = render('[Project](#/projects/proj_96c0eb28) · [AI model](#/settings/ai-model) · [Docs](https://docs.aws.amazon.com/bedrock/)');
    const links = anchors(html);
    expect(links.map(link => link.getAttribute('href'))).toEqual([
      '#/projects/proj_96c0eb28', '#/settings/ai-model', 'https://docs.aws.amazon.com/bedrock/',
    ]);
    expect(links.map(link => link.getAttribute('target'))).toEqual([null, null, '_blank']);
  });

  it('still refuses scripts, markup, and plain fragments', () => {
    for (const unsafe of [
      '[x](javascript:alert(1))',
      '[x](#/doc/a"onmouseover="alert(1))',
      '[x](#/doc/<img>)',
      '[x](#section)',
      '[x](data:text/html,hi)',
    ]) {
      const html = render(unsafe);
      expect(anchors(html), unsafe).toHaveLength(0);
      expect(html).not.toMatch(/<img|onmouseover="/);
    }
  });

  it('leaves a reader route inside a code span as code', () => {
    const html = render(`\`${READER}\``);
    expect(anchors(html)).toHaveLength(0);
    expect(html).toContain('<code>');
  });
});
