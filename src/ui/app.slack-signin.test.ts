// @vitest-environment jsdom
//
// Sign in with Slack card (app.js): "Approve in Slack; this page updates when
// you come back" must stay true. The approval happens in another tab, so when
// the owner returns the card clears that line and re-reads Slack's state (the
// status line then says who is signed in) instead of showing a stale
// instruction beside a finished sign-in. The pasted-address flow keeps its
// instruction until the owner finishes it.
//
// Same strategy as app.test.ts: install the DOM, stub fetch BEFORE importing
// app.js, then call the exported loadSlackSources to bind the card.
import { beforeAll, describe, expect, it, vi } from 'vitest';

const APP_HTML = `
  <div id="breadcrumb"></div>
  <div id="grid-view"></div>
  <div id="detail-view"></div>
  <div id="chat-messages"></div>
  <div id="chat-panel"></div>
  <input id="chatInput" />
  <span id="noise-toggle"></span>
  <section id="slack-sources">
    <div id="slack-sources-status" hidden></div>
    <div id="slack-sources-error" hidden></div>
    <div id="slack-sources-list"></div>
    <button id="slack-sources-save" type="button">Save</button>
  </section>
  <section id="slack-signin-card">
    <p id="slack-signin-status"></p>
    <code id="slack-signin-redirect"></code>
    <code id="slack-signin-scopes"></code>
    <input id="slack-signin-https" type="checkbox">
    <input id="slack-signin-client-id"><input id="slack-signin-client-secret">
    <button id="slack-signin-save-client" type="button">Save app</button>
    <button id="slack-signin-start" type="button">Sign in with Slack</button>
    <div id="slack-signin-finish" hidden><input id="slack-signin-paste"><button id="slack-signin-finish-btn" type="button">Finish</button></div>
    <p id="slack-signin-result" role="status" hidden></p>
  </section>
`;

type AnyFn = (...args: unknown[]) => unknown;
let appWindow: Window & { loadSlackSources?: AnyFn };

function reply(body: unknown) {
  const response = { ok: true, status: 200, statusText: 'OK', json: async () => body, clone: () => response };
  return Promise.resolve(response);
}

/** What the server says right now; the test flips it when the "other tab" finishes the sign-in. */
const server = {
  connected: false,
  redirectMode: 'http_loopback' as 'http_loopback' | 'https_paste',
  starts: 0,
};

function fakeFetch(input: RequestInfo): Promise<unknown> {
  const url = typeof input === 'string' ? input : (input as Request).url;
  if (url.endsWith('/api/slack/oauth/client')) {
    return reply({
      configured: true, clientIdSuffix: '…543210', redirectMode: server.redirectMode, userScopes: ['channels:history'],
      redirectUri: 'http://127.0.0.1:7778/api/slack/oauth/callback',
    });
  }
  if (url.endsWith('/api/slack/token/status')) {
    return reply(server.connected
      ? { configured: true, connectedVia: 'oauth', identity: { user: 'owner', team: 'Acme' }, tokenMasked: 'xoxp-…abcd' }
      : { configured: false });
  }
  if (url.endsWith('/api/slack/oauth/start')) {
    server.starts++;
    return reply({ authorizeUrl: 'https://slack.com/oauth/v2/authorize?state=s', redirectMode: server.redirectMode });
  }
  if (url.endsWith('/api/settings/workplace')) return reply({ amazonEmployee: false });
  if (url.endsWith('/api/slack/conversations')) return reply({ conversations: [] });
  if (url.endsWith('/api/slack/config')) return reply({ ids: [] });
  if (url.endsWith('/api/dashboard/version')) return reply({ version: 0 });
  if (url.endsWith('/api/nodes/roots') || url.endsWith('/api/chat/history')) return reply([]);
  return reply({});
}

const fetchMock = vi.fn(fakeFetch as unknown as AnyFn);

beforeAll(async () => {
  appWindow = window as typeof appWindow;
  vi.stubGlobal('setInterval', () => 0 as unknown as NodeJS.Timeout);
  vi.stubGlobal('setTimeout', ((fn: () => void) => { fn(); return 0; }) as unknown as typeof setTimeout);
  document.body.innerHTML = APP_HTML;
  vi.stubGlobal('fetch', fetchMock);
  await import('./app.js');
  vi.unstubAllGlobals();
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('setInterval', () => 0 as unknown as NodeJS.Timeout);
  await Promise.resolve();
  await Promise.resolve();
});

const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); await new Promise(resolve => setTimeout(resolve, 0)); };
const text = (id: string) => document.getElementById(id)!.textContent;
const message = () => document.getElementById('slack-signin-result') as HTMLElement;
function becomeVisible() {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
  document.dispatchEvent(new Event('visibilitychange'));
}

describe('Sign in with Slack card: the line that promises an update', () => {
  it('clears "Approve in Slack…" on return and re-reads who is signed in; the pasted flow keeps its instruction', async () => {
    const open = vi.fn();
    vi.stubGlobal('open', open);
    // app.js bound the card's buttons to the DOM it found at import; keep that DOM.
    await appWindow.loadSlackSources!();
    await settle();
    expect(text('slack-signin-status')).toBe('Slack app …543210 saved. Sign in to connect.');

    // Start: the approval opens in another tab and the card says the page updates when the owner comes back.
    document.getElementById('slack-signin-start')!.click();
    await settle();
    expect(open).toHaveBeenCalledWith('https://slack.com/oauth/v2/authorize?state=s', '_blank', 'noopener');
    expect(message().hidden).toBe(false);
    expect(message().textContent).toBe('Approve in Slack; this page updates when you come back.');

    // Coming back before the other tab finished: the instruction goes, the status line stays truthful.
    becomeVisible();
    await settle();
    expect(message().hidden).toBe(true);
    expect(message().textContent).toBe('');
    expect(text('slack-signin-status')).toBe('Slack app …543210 saved. Sign in to connect.');

    // Start again, finish in the other tab, come back: the card now says who is signed in.
    document.getElementById('slack-signin-start')!.click();
    await settle();
    expect(message().textContent).toContain('Approve in Slack');
    server.connected = true;
    becomeVisible();
    await settle();
    expect(message().hidden).toBe(true);
    expect(text('slack-signin-status')).toBe('Signed in as owner in Acme.');

    // Returning to the tab again, with nothing pending, changes nothing.
    const calls = fetchMock.mock.calls.length;
    becomeVisible();
    await settle();
    expect(fetchMock.mock.calls.length).toBe(calls);

    // The pasted-address flow: the instruction stays until the owner finishes it.
    server.redirectMode = 'https_paste';
    document.getElementById('slack-signin-start')!.click();
    await settle();
    expect(message().textContent).toContain('copy its whole address and paste it below');
    becomeVisible();
    await settle();
    expect(message().hidden).toBe(false);
    expect(message().textContent).toContain('copy its whole address and paste it below');
  });
});
