// @vitest-environment jsdom
//
// UI tests for the Slack Sources panel (task 8.10).
// Verifies the four behaviours pinned in the spec:
//   - Toggles match the current config after `loadSlackSources` resolves   (Req 7.2)
//   - Clicking save issues a PUT /api/slack/config with the selected IDs   (Req 7.3)
//   - 200 → success banner with the "took effect immediately" wording      (Req 7.4)
//   - Error → banner text includes status and reason; in-memory selection
//     is preserved so pending toggles survive                              (Reqs 7.5, 7.6)
//
// Strategy: install the panel's DOM, stub `globalThis.fetch` BEFORE importing
// `app.js`, then dynamically import the module so its IIFE binds handlers and
// exposes `window.loadSlackSources` / `window.saveSlackSources`. Each test
// re-installs a fresh DOM and re-binds the save button click → save() so we
// never depend on the original IIFE's listener (whose target node has since
// been replaced).

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

// ---------- DOM fixture ----------
// Includes only the elements `app.js` touches at init time + the Slack Sources
// section. Keep this minimal so the test stays focused on the panel.
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
`;

// ---------- Lightweight Response mock ----------
// Avoids depending on jsdom's / Node's `Response` semantics — we only need
// the surface app.js consumes: .ok, .status, .statusText, .json(), .clone().
type MockResponse = {
  ok: boolean;
  status: number;
  statusText: string;
  json: () => Promise<unknown>;
  clone: () => MockResponse;
};
function makeResponse(status: number, statusText: string, body: unknown): MockResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    json: async () => body,
    clone() { return makeResponse(status, statusText, body); },
  };
}

// ---------- Test harness ----------
type AnyFn = (...args: unknown[]) => unknown;
let fetchMock: ReturnType<typeof vi.fn>;
let appWindow: Window & {
  loadSlackSources?: AnyFn;
  saveSlackSources?: AnyFn;
};

// Default fetch handler used while app.js is initialising. Every endpoint the
// startup IIFE hits returns a benign 200 so the IIFE resolves without error.
function defaultFetch(input: RequestInfo, _init?: RequestInit): Promise<MockResponse> {
  const url = typeof input === 'string' ? input : (input as Request).url;
  if (url.endsWith('/api/nodes/roots')) return Promise.resolve(makeResponse(200, 'OK', []));
  if (url.endsWith('/api/chat/history')) return Promise.resolve(makeResponse(200, 'OK', []));
  if (url.endsWith('/api/slack/conversations')) return Promise.resolve(makeResponse(200, 'OK', { conversations: [] }));
  if (url.endsWith('/api/slack/config')) return Promise.resolve(makeResponse(200, 'OK', { ids: [] }));
  if (url.endsWith('/api/dashboard/version')) return Promise.resolve(makeResponse(200, 'OK', { version: 0 }));
  return Promise.resolve(makeResponse(200, 'OK', {}));
}

// Helper: extract the [url, init] pairs that match a PUT /api/slack/config.
function putConfigCalls(): Array<[string, RequestInit]> {
  const calls = fetchMock.mock.calls as Array<[unknown, RequestInit | undefined]>;
  return calls
    .map(([rawUrl, init]) => [typeof rawUrl === 'string' ? rawUrl : (rawUrl as Request).url, init] as const)
    .filter(([u, init]) => u.endsWith('/api/slack/config') && init?.method === 'PUT')
    .map(([u, init]) => [u, init as RequestInit]);
}

beforeAll(async () => {
  appWindow = window as typeof appWindow;

  // 1. Stub setInterval so the chat / dashboard polling loops never fire.
  //    This keeps the test deterministic and avoids spurious fetch calls
  //    that would clobber `fetchMock.mock.calls` mid-assertion.
  vi.stubGlobal('setInterval', () => 0 as unknown as NodeJS.Timeout);
  vi.stubGlobal('setTimeout', ((fn: () => void) => { fn(); return 0; }) as unknown as typeof setTimeout);

  // 2. Render the panel and install the default fetch mock BEFORE app.js
  //    runs — its IIFE awaits `loadSlackSources()` immediately at import.
  document.body.innerHTML = APP_HTML;
  fetchMock = vi.fn(defaultFetch as unknown as AnyFn);
  vi.stubGlobal('fetch', fetchMock);

  // 3. Dynamically import the module under test. This runs the IIFE which
  //    attaches `loadSlackSources` / `saveSlackSources` to `window`.
  await import('./app.js');

  // 4. Restore real setTimeout so our own awaits actually defer.
  vi.unstubAllGlobals();
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('setInterval', () => 0 as unknown as NodeJS.Timeout);

  // Drain any microtasks left by the IIFE (Promise.all + render).
  await Promise.resolve();
  await Promise.resolve();
});

beforeEach(() => {
  // Fresh DOM per test: the previous test's nodes are gone, so we
  // re-install the markup and re-bind the save button to the saved
  // module export. (The IIFE's original listener pointed at a now-orphan
  // button node from beforeAll's render.)
  document.body.innerHTML = APP_HTML;
  document.getElementById('slack-sources-save')!.addEventListener('click', () => {
    void appWindow.saveSlackSources!();
  });
  fetchMock.mockReset();
});

describe('Slack Sources panel — UI (jsdom)', () => {
  it('toggles match the current config after loadSlackSources resolves (Req 7.2)', async () => {
    fetchMock.mockImplementation((input: RequestInfo) => {
      const url = typeof input === 'string' ? input : (input as Request).url;
      if (url.endsWith('/api/slack/conversations')) {
        return Promise.resolve(makeResponse(200, 'OK', {
          conversations: [
            { id: 'C1', name: 'general', type: 'public_channel' },
            { id: 'C2', name: 'random', type: 'public_channel' },
          ],
        }));
      }
      if (url.endsWith('/api/slack/config')) {
        return Promise.resolve(makeResponse(200, 'OK', { ids: ['C2'] }));
      }
      return Promise.resolve(makeResponse(404, 'Not Found', {}));
    });

    await appWindow.loadSlackSources!();

    const c1 = document.querySelector<HTMLInputElement>('input[data-id="C1"]');
    const c2 = document.querySelector<HTMLInputElement>('input[data-id="C2"]');
    expect(c1).not.toBeNull();
    expect(c2).not.toBeNull();
    expect(c1!.checked).toBe(false);
    expect(c2!.checked).toBe(true);
  });

  it('clicking save issues a PUT /api/slack/config with the selected IDs (Req 7.3)', async () => {
    fetchMock.mockImplementation((input: RequestInfo, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : (input as Request).url;
      const method = init?.method ?? 'GET';
      if (url.endsWith('/api/slack/conversations')) {
        return Promise.resolve(makeResponse(200, 'OK', {
          conversations: [
            { id: 'C1', name: 'general', type: 'public_channel' },
            { id: 'C2', name: 'random', type: 'public_channel' },
          ],
        }));
      }
      if (url.endsWith('/api/slack/config') && method === 'PUT') {
        return Promise.resolve(makeResponse(200, 'OK', { ids: ['C1', 'C2'] }));
      }
      if (url.endsWith('/api/slack/config')) {
        return Promise.resolve(makeResponse(200, 'OK', { ids: ['C2'] }));
      }
      return Promise.resolve(makeResponse(404, 'Not Found', {}));
    });

    await appWindow.loadSlackSources!();

    // User toggles C1 on (C2 was already on from config).
    const c1 = document.querySelector<HTMLInputElement>('input[data-id="C1"]')!;
    c1.checked = true;
    c1.dispatchEvent(new Event('change'));

    // Clear the GET history so the next assertions only see the PUT.
    const callsBefore = fetchMock.mock.calls.length;
    document.getElementById('slack-sources-save')!.click();
    // Click handler kicks off an async save; flush microtasks.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(fetchMock.mock.calls.length).toBeGreaterThan(callsBefore);
    const puts = putConfigCalls();
    expect(puts.length).toBe(1);

    const [putUrl, putInit] = puts[0];
    expect(putUrl).toMatch(/\/api\/slack\/config$/);
    expect(putInit.method).toBe('PUT');
    const headers = putInit.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/json');

    const body = JSON.parse(putInit.body as string) as { ids: string[] };
    expect(body.ids.slice().sort()).toEqual(['C1', 'C2']);
  });

  it('200 response shows the success banner with the took-effect-immediately wording (Req 7.4)', async () => {
    fetchMock.mockImplementation((input: RequestInfo, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : (input as Request).url;
      const method = init?.method ?? 'GET';
      if (url.endsWith('/api/slack/conversations')) {
        return Promise.resolve(makeResponse(200, 'OK', {
          conversations: [{ id: 'C1', name: 'general', type: 'public_channel' }],
        }));
      }
      if (url.endsWith('/api/slack/config') && method === 'PUT') {
        return Promise.resolve(makeResponse(200, 'OK', { ids: ['C1'] }));
      }
      if (url.endsWith('/api/slack/config')) {
        return Promise.resolve(makeResponse(200, 'OK', { ids: [] }));
      }
      return Promise.resolve(makeResponse(404, 'Not Found', {}));
    });

    await appWindow.loadSlackSources!();
    const c1 = document.querySelector<HTMLInputElement>('input[data-id="C1"]')!;
    c1.checked = true;
    c1.dispatchEvent(new Event('change'));

    await appWindow.saveSlackSources!();

    const status = document.getElementById('slack-sources-status')!;
    const error = document.getElementById('slack-sources-error')!;
    expect(status.hidden).toBe(false);
    expect(status.textContent).toBe('Saved. Capture rules updated immediately.');
    expect(error.hidden).toBe(true);
    expect(error.textContent ?? '').toBe('');
  });

  it('error response renders banner with HTTP status & reason and preserves pending selection (Reqs 7.5, 7.6)', async () => {
    fetchMock.mockImplementation((input: RequestInfo, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : (input as Request).url;
      const method = init?.method ?? 'GET';
      if (url.endsWith('/api/slack/conversations')) {
        return Promise.resolve(makeResponse(200, 'OK', {
          conversations: [
            { id: 'C1', name: 'general', type: 'public_channel' },
            { id: 'C2', name: 'random', type: 'public_channel' },
          ],
        }));
      }
      if (url.endsWith('/api/slack/config') && method === 'PUT') {
        return Promise.resolve(makeResponse(500, 'Internal Server Error', { error: 'boom' }));
      }
      if (url.endsWith('/api/slack/config')) {
        return Promise.resolve(makeResponse(200, 'OK', { ids: [] }));
      }
      return Promise.resolve(makeResponse(404, 'Not Found', {}));
    });

    await appWindow.loadSlackSources!();

    // User toggles both channels on.
    const c1 = document.querySelector<HTMLInputElement>('input[data-id="C1"]')!;
    const c2 = document.querySelector<HTMLInputElement>('input[data-id="C2"]')!;
    c1.checked = true;
    c1.dispatchEvent(new Event('change'));
    c2.checked = true;
    c2.dispatchEvent(new Event('change'));

    await appWindow.saveSlackSources!();

    // Req 7.5: error banner reflects the upstream status & reason.
    const status = document.getElementById('slack-sources-status')!;
    const error = document.getElementById('slack-sources-error')!;
    expect(error.hidden).toBe(false);
    const text = error.textContent ?? '';
    expect(text).toContain('HTTP 500');
    expect(text).toContain('Internal Server Error');
    expect(text).toContain('boom'); // body.error included as detail
    expect(status.hidden).toBe(true);

    // Req 7.6: in-memory `selectedIds` untouched. The DOM checkboxes
    // still show user's pending toggles…
    expect(c1.checked).toBe(true);
    expect(c2.checked).toBe(true);

    // …and a follow-up save (now succeeding) sends the same {C1, C2}
    // proving the module-scoped Set was not cleared on the prior failure.
    fetchMock.mockReset();
    fetchMock.mockImplementation((input: RequestInfo, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : (input as Request).url;
      if (url.endsWith('/api/slack/config') && init?.method === 'PUT') {
        return Promise.resolve(makeResponse(200, 'OK', { ids: ['C1', 'C2'] }));
      }
      return Promise.resolve(makeResponse(404, 'Not Found', {}));
    });

    await appWindow.saveSlackSources!();

    const puts = putConfigCalls();
    expect(puts.length).toBe(1);
    const body = JSON.parse(puts[0][1].body as string) as { ids: string[] };
    expect(body.ids.slice().sort()).toEqual(['C1', 'C2']);
  });
});
