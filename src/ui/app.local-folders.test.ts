// @vitest-environment jsdom
//
// UI tests for the Local Folders panel (task 9.6).
// Verifies the four behaviours pinned in the spec:
//   - `loadLocalFolders` renders one row per folder with the path and the
//     "— items" badge                                          (Reqs 6.2)
//   - Submitting the add form sends `POST /api/local-folders` with
//     `{ path, recursive }`; on 4xx renders the error banner with HTTP
//     status + reason and preserves pending form input         (Reqs 6.4, 6.5)
//   - Clicking a "Reveal in Finder" anchor (`data-action="reveal"`) fires
//     `GET /api/files/reveal?path=<encoded>` via the delegated handler
//                                                              (Reqs 7.3, 7.4)
//   - Clicking an `<a href="file://...">` anchor fires
//     `GET /api/files/open?path=<encoded>` and prevents the default
//     navigation                                               (Reqs 7.1, 7.3)
//
// Strategy: install the panel DOM + stub `globalThis.fetch` BEFORE importing
// `app.js`, then dynamically import the module so its IIFE binds handlers,
// attaches the document-level click interceptor, and exposes the panel
// helpers on `window`. Each test re-installs a fresh DOM (the IIFE's
// original event-listener targets get orphaned) and re-binds the submit
// button to the saved `window.addLocalFolder` so submit-via-click still
// hits the right handler.

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

// ---------- DOM fixture ----------
// Includes the panel markup `app.js` reads at runtime + the minimum nodes
// other helpers (renderGrid, renderDetail, slack panel) touch so the
// startup IIFE can run without errors.
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
  <section id="local-folders">
    <div id="local-folders-status" hidden></div>
    <div id="local-folders-error" hidden></div>
    <button id="local-folders-add-btn" type="button">+ Add folder</button>
    <div id="local-folders-add-form" hidden>
      <input id="lf-path-input" type="text" />
      <label><input id="lf-recursive-input" type="checkbox" checked /> Recursive</label>
      <button id="lf-submit-add" type="button">Add</button>
      <button id="lf-cancel-add" type="button">Cancel</button>
    </div>
    <div id="local-folders-list"></div>
  </section>
`;

// ---------- Lightweight Response mock ----------
// Mirrors the surface app.js consumes (.ok, .status, .statusText, .json(),
// .clone(), .text()). Avoids depending on jsdom/Node `Response` semantics.
type MockResponse = {
  ok: boolean;
  status: number;
  statusText: string;
  text: () => Promise<string>;
  json: () => Promise<unknown>;
  clone: () => MockResponse;
};
function makeResponse(status: number, statusText: string, body: unknown): MockResponse {
  const isString = typeof body === 'string';
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    text: async () => (isString ? (body as string) : JSON.stringify(body)),
    json: async () => body,
    clone() { return makeResponse(status, statusText, body); },
  };
}

// ---------- Test harness ----------
type AnyFn = (...args: unknown[]) => unknown;
let fetchMock: ReturnType<typeof vi.fn>;
let appWindow: Window & {
  loadLocalFolders?: AnyFn;
  addLocalFolder?: AnyFn;
  removeLocalFolder?: AnyFn;
  showLocalFolders?: AnyFn;
};

// Default fetch handler used while app.js is initialising. The startup IIFE
// hits roots/chat-history/slack endpoints and the dashboard-version poll.
// Each returns benign 200 so the IIFE settles without errors.
function defaultFetch(input: RequestInfo, _init?: RequestInit): Promise<MockResponse> {
  const url = typeof input === 'string' ? input : (input as Request).url;
  if (url.endsWith('/api/nodes/roots')) return Promise.resolve(makeResponse(200, 'OK', []));
  if (url.endsWith('/api/chat/history')) return Promise.resolve(makeResponse(200, 'OK', []));
  if (url.endsWith('/api/slack/conversations')) return Promise.resolve(makeResponse(200, 'OK', { conversations: [] }));
  if (url.endsWith('/api/slack/config')) return Promise.resolve(makeResponse(200, 'OK', { ids: [] }));
  if (url.endsWith('/api/dashboard/version')) return Promise.resolve(makeResponse(200, 'OK', { version: 0 }));
  if (url.includes('/api/local-folders')) return Promise.resolve(makeResponse(200, 'OK', { folders: [] }));
  return Promise.resolve(makeResponse(200, 'OK', {}));
}

// Helpers: extract [url, init] pairs that match a given method + URL regex.
function callsMatching(method: string, urlRe: RegExp): Array<[string, RequestInit | undefined]> {
  const calls = fetchMock.mock.calls as Array<[unknown, RequestInit | undefined]>;
  return calls
    .map(([rawUrl, init]) => [typeof rawUrl === 'string' ? rawUrl : (rawUrl as Request).url, init] as [string, RequestInit | undefined])
    .filter(([u, init]) => urlRe.test(u) && (init?.method ?? 'GET') === method);
}

beforeAll(async () => {
  appWindow = window as typeof appWindow;

  // 1. Stub setInterval/setTimeout so the chat / dashboard polling loops
  //    never fire — keeps fetch call counts deterministic.
  vi.stubGlobal('setInterval', () => 0 as unknown as NodeJS.Timeout);
  vi.stubGlobal('setTimeout', ((fn: () => void) => { fn(); return 0; }) as unknown as typeof setTimeout);

  // 2. Render the DOM and install the default fetch BEFORE importing
  //    app.js — its IIFE awaits Promise.all(loadRoots, loadChatHistory,
  //    loadSlackSources) immediately at import.
  document.body.innerHTML = APP_HTML;
  fetchMock = vi.fn(defaultFetch as unknown as AnyFn);
  vi.stubGlobal('fetch', fetchMock);
  // `removeLocalFolder` calls confirm(); stub to true so the test can
  // exercise it deterministically should a future test need it.
  vi.stubGlobal('confirm', () => true);

  // 3. Dynamic import — the IIFE binds handlers and exposes
  //    `window.loadLocalFolders` / `window.addLocalFolder` / etc.
  await import('./app.js');

  // 4. Restore real setTimeout so test awaits actually defer; keep the
  //    other stubs in place.
  vi.unstubAllGlobals();
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('setInterval', () => 0 as unknown as NodeJS.Timeout);
  vi.stubGlobal('confirm', () => true);

  // Drain microtasks left by the IIFE.
  await Promise.resolve();
  await Promise.resolve();
});

beforeEach(() => {
  // Fresh DOM per test — the previous test's nodes are gone, so re-install
  // the markup and re-bind the submit button. (The IIFE's original
  // listener pointed at a now-orphan button node from beforeAll.)
  document.body.innerHTML = APP_HTML;
  document.getElementById('lf-submit-add')!.addEventListener('click', () => {
    void appWindow.addLocalFolder!();
  });
  fetchMock.mockReset();
});

describe('Local Folders panel — UI (jsdom)', () => {
  it('loadLocalFolders renders one row per folder with the path and item-count badge (Req 6.2)', async () => {
    fetchMock.mockImplementation((input: RequestInfo, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : (input as Request).url;
      const method = init?.method ?? 'GET';
      if (url.endsWith('/api/local-folders') && method === 'GET') {
        return Promise.resolve(makeResponse(200, 'OK', {
          folders: [
            { id: 1, path: '/Users/me/Documents/notes', recursive: true, enabled: true, include_globs: [], exclude_globs: [] },
            { id: 2, path: '/Users/me/code/repo', recursive: false, enabled: false, include_globs: [], exclude_globs: [] },
          ],
        }));
      }
      return defaultFetch(input, init);
    });

    await appWindow.loadLocalFolders!();

    const list = document.getElementById('local-folders-list')!;
    const rows = list.querySelectorAll('[data-folder-id]');
    expect(rows.length).toBe(2);

    const row1 = list.querySelector('[data-folder-id="1"]')!;
    const row2 = list.querySelector('[data-folder-id="2"]')!;
    expect(row1).not.toBeNull();
    expect(row2).not.toBeNull();

    // Path appears verbatim in each row.
    expect(row1.textContent).toContain('/Users/me/Documents/notes');
    expect(row2.textContent).toContain('/Users/me/code/repo');

    // Item-count badge: implementation renders a dash since no stats
    // endpoint exists yet — assert the placeholder is present.
    expect(row1.textContent).toContain('— items');
    expect(row2.textContent).toContain('— items');

    // Recursive flag is reflected in the meta line.
    expect(row1.textContent).toContain('recursive');
    expect(row2.textContent).toContain('non-recursive');
  });

  it('submitting the add form sends POST /api/local-folders with { path, recursive } and reloads on success (Req 6.5)', async () => {
    fetchMock.mockImplementation((input: RequestInfo, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : (input as Request).url;
      const method = init?.method ?? 'GET';
      if (url.endsWith('/api/local-folders') && method === 'POST') {
        return Promise.resolve(makeResponse(201, 'Created', {
          folder: { id: 7, path: '/Users/me/Documents/notes', recursive: true, enabled: true, include_globs: [], exclude_globs: [] },
        }));
      }
      if (url.endsWith('/api/local-folders') && method === 'GET') {
        return Promise.resolve(makeResponse(200, 'OK', { folders: [] }));
      }
      return defaultFetch(input, init);
    });

    // Fill the form. recursive checkbox starts checked in the fixture.
    const pathInput = document.getElementById('lf-path-input') as HTMLInputElement;
    const recInput = document.getElementById('lf-recursive-input') as HTMLInputElement;
    pathInput.value = '/Users/me/Documents/notes';
    expect(recInput.checked).toBe(true);

    // Click the submit button — handler is re-bound in beforeEach.
    document.getElementById('lf-submit-add')!.click();

    // Flush the chain: addLocalFolder → POST → loadLocalFolders → GET → render.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    const posts = callsMatching('POST', /\/api\/local-folders$/);
    expect(posts.length).toBe(1);

    const [postUrl, postInit] = posts[0];
    expect(postUrl).toMatch(/\/api\/local-folders$/);
    const headers = postInit!.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/json');

    const body = JSON.parse(postInit!.body as string) as { path: string; recursive: boolean };
    expect(body.path).toBe('/Users/me/Documents/notes');
    expect(body.recursive).toBe(true);

    // On success the form is hidden and the path input is cleared so the
    // user can register the next folder without retyping. (The success
    // banner is set briefly then cleared by `clearLfBanners` at the top
    // of the follow-up `loadLocalFolders`, so we don't assert on it here.)
    const form = document.getElementById('local-folders-add-form') as HTMLDivElement;
    expect(form.hidden).toBe(true);
    expect(pathInput.value).toBe('');

    // The follow-up GET reload happened.
    expect(callsMatching('GET', /\/api\/local-folders$/).length).toBeGreaterThanOrEqual(1);

    // No error banner.
    const error = document.getElementById('local-folders-error')!;
    expect(error.hidden).toBe(true);
  });

  it('on 4xx the add form renders the error banner with HTTP status + reason and preserves pending input (Req 6.4)', async () => {
    fetchMock.mockImplementation((input: RequestInfo, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : (input as Request).url;
      const method = init?.method ?? 'GET';
      if (url.endsWith('/api/local-folders') && method === 'POST') {
        return Promise.resolve(makeResponse(409, 'Conflict', { error: 'duplicate path' }));
      }
      if (url.endsWith('/api/local-folders') && method === 'GET') {
        return Promise.resolve(makeResponse(200, 'OK', { folders: [] }));
      }
      return defaultFetch(input, init);
    });

    const pathInput = document.getElementById('lf-path-input') as HTMLInputElement;
    const recInput = document.getElementById('lf-recursive-input') as HTMLInputElement;
    pathInput.value = '~/Documents/notes';
    recInput.checked = false;

    // User has the form open.
    const form = document.getElementById('local-folders-add-form') as HTMLDivElement;
    form.hidden = false;

    await appWindow.addLocalFolder!();

    // Error banner reflects the upstream status, reason, and body.error.
    const status = document.getElementById('local-folders-status')!;
    const error = document.getElementById('local-folders-error')!;
    expect(error.hidden).toBe(false);
    const text = error.textContent ?? '';
    expect(text).toContain('HTTP 409');
    expect(text).toContain('Conflict');
    expect(text).toContain('duplicate path');
    expect(status.hidden).toBe(true);

    // Pending input is preserved — both the path text and the recursive
    // toggle the user already touched.
    expect(pathInput.value).toBe('~/Documents/notes');
    expect(recInput.checked).toBe(false);

    // Form is still visible (only the success path hides it).
    expect(form.hidden).toBe(false);
  });

  it('clicking a "Reveal in Finder" link fires GET /api/files/reveal?path=<encoded> (Req 7.4)', async () => {
    fetchMock.mockImplementation((input: RequestInfo, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : (input as Request).url;
      if (url.startsWith('/api/files/reveal')) {
        return Promise.resolve(makeResponse(204, 'No Content', {}));
      }
      return defaultFetch(input, init);
    });

    // Inject a Reveal-in-Finder anchor — the delegated handler attached at
    // app.js import time (on `document`) survives DOM replacements.
    const target = document.getElementById('local-folders-list')!;
    const filePath = '/Users/me/Documents/foo bar.txt';
    target.innerHTML = `<a href="#" data-action="reveal" data-path="${filePath}">📂 Reveal in Finder</a>`;
    const anchor = target.querySelector('a[data-action="reveal"]') as HTMLAnchorElement;

    const evt = new MouseEvent('click', { bubbles: true, cancelable: true });
    anchor.dispatchEvent(evt);

    // Default is prevented (the handler calls preventDefault).
    expect(evt.defaultPrevented).toBe(true);

    // Microtask flush — the handler kicks off `fetch(...)` synchronously
    // but the call is recorded synchronously too.
    await Promise.resolve();

    const reveals = callsMatching('GET', /\/api\/files\/reveal/);
    expect(reveals.length).toBe(1);
    const [revealUrl] = reveals[0];
    // Path is URL-encoded: spaces → %20, slashes → %2F.
    expect(revealUrl).toBe(`/api/files/reveal?path=${encodeURIComponent(filePath)}`);

    // No /api/files/open call should have fired.
    expect(callsMatching('GET', /\/api\/files\/open/).length).toBe(0);
  });

  it('clicking an `<a href="file://...">` link fires GET /api/files/open?path=<encoded> and prevents default (Reqs 7.1, 7.3)', async () => {
    fetchMock.mockImplementation((input: RequestInfo, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : (input as Request).url;
      if (url.startsWith('/api/files/open')) {
        return Promise.resolve(makeResponse(204, 'No Content', {}));
      }
      return defaultFetch(input, init);
    });

    // Render an item-card-style file:// link in the panel.
    const target = document.getElementById('local-folders-list')!;
    const filePath = '/Users/me/notes/2024-01.md';
    target.innerHTML = `<a href="file://${filePath}">notes/2024-01.md</a>`;
    const anchor = target.querySelector('a[href^="file://"]') as HTMLAnchorElement;

    const evt = new MouseEvent('click', { bubbles: true, cancelable: true });
    anchor.dispatchEvent(evt);

    // Delegated handler intercepts and calls preventDefault so jsdom
    // doesn't try to navigate to the file:// URL.
    expect(evt.defaultPrevented).toBe(true);

    await Promise.resolve();

    const opens = callsMatching('GET', /\/api\/files\/open/);
    expect(opens.length).toBe(1);
    const [openUrl] = opens[0];
    expect(openUrl).toBe(`/api/files/open?path=${encodeURIComponent(filePath)}`);

    // No reveal call.
    expect(callsMatching('GET', /\/api\/files\/reveal/).length).toBe(0);
  });
});
