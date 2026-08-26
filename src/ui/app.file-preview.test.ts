// @vitest-environment jsdom
//
// File-preview interceptor regression tests (document-workbench W0,
// 2026-08-25). The delegated click listener must:
//   - route /api/files/<rel> anchors into the in-app overlay (previewFile),
//   - now ALSO re-preview file links INSIDE a previewed document (previously
//     the whole overlay was excluded, sending in-document links to a browser
//     tab — read as a regression by the owner),
//   - still let the overlay header's "Open in tab" (.fpv-actions) pass
//     through untouched,
//   - never intercept the open/reveal action shims.

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

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

beforeAll(async () => {
  document.body.innerHTML = APP_HTML;
  // Same benign-init harness as app.test.ts: array endpoints return arrays,
  // polling loops never fire.
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
});

/**
 * Dispatch a click and report whether the app's interceptor cancelled it.
 * A one-shot document-level listener (registered after the app's, so it runs
 * last) records the interceptor's verdict, then cancels unconditionally so
 * jsdom never attempts real anchor navigation ("Not implemented" noise).
 */
function clickAnchor(anchor: HTMLAnchorElement): { preventedByApp: boolean } {
  let preventedByApp = false;
  const probe = (e: Event) => { preventedByApp = e.defaultPrevented; e.preventDefault(); };
  document.addEventListener('click', probe, { once: true });
  anchor.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  document.removeEventListener('click', probe);
  return { preventedByApp };
}

describe('file-preview click interceptor', () => {
  let previewCalls: string[];

  beforeEach(() => {
    previewCalls = [];
    (window as unknown as { previewFile: (href: string) => void }).previewFile = (href: string) => { previewCalls.push(href); };
    document.querySelectorAll('.file-preview-expand, [data-test-root]').forEach(el => el.remove());
  });

  function mount(html: string): HTMLElement {
    const root = document.createElement('div');
    root.setAttribute('data-test-root', '1');
    root.innerHTML = html;
    document.body.appendChild(root);
    return root;
  }

  it('routes a chat file link into the overlay and cancels navigation', () => {
    const root = mount('<a id="l" href="/api/files/notes.md" target="_blank">notes.md</a>');
    const { preventedByApp } = clickAnchor(root.querySelector('#l')!);
    expect(previewCalls).toEqual(['/api/files/notes.md']);
    expect(preventedByApp).toBe(true);
  });

  it('REGRESSION: a file link inside a previewed document re-previews in-app instead of opening a tab', () => {
    const root = mount(`
      <div class="file-preview-expand"><div class="file-preview-modal">
        <div class="fpv-header"><div class="fpv-actions">
          <a id="open-tab" href="/api/files/index.md" target="_blank">Open in tab</a>
        </div></div>
        <div class="fpv-body"><a id="inner" href="/api/files/chapter2.md">chapter 2</a></div>
      </div></div>`);
    const inner = clickAnchor(root.querySelector('#inner')!);
    expect(previewCalls).toEqual(['/api/files/chapter2.md']);
    expect(inner.preventedByApp).toBe(true);

    // Header "Open in tab" still passes through untouched.
    const header = clickAnchor(root.querySelector('#open-tab')!);
    expect(previewCalls).toEqual(['/api/files/chapter2.md']);
    expect(header.preventedByApp).toBe(false);
  });

  it('never intercepts the open/reveal action shims', () => {
    const root = mount('<a id="shim" href="/api/files/open?path=%7E%2Fx">open</a>');
    const { preventedByApp } = clickAnchor(root.querySelector('#shim')!);
    expect(previewCalls).toEqual([]);
    expect(preventedByApp).toBe(false);
  });

  it('SOAK REGRESSION: ABSOLUTE same-origin file links preview in-app; cross-origin ones do not', () => {
    // The model writes full http://localhost:7778/api/files/... links in chat.
    const root = mount(`
      <a id="abs" href="${location.origin}/api/files/draft.html" target="_blank">draft</a>
      <a id="foreign" href="https://example.com/api/files/evil.md">foreign</a>`);
    const abs = clickAnchor(root.querySelector('#abs')!);
    expect(previewCalls).toEqual(['/api/files/draft.html']);
    expect(abs.preventedByApp).toBe(true);

    const foreign = clickAnchor(root.querySelector('#foreign')!);
    expect(previewCalls).toEqual(['/api/files/draft.html']); // unchanged
    expect(foreign.preventedByApp).toBe(false);
  });
});
