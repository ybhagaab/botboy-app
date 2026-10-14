// @vitest-environment jsdom
//
// Server link (server-link.js): the one calm status line the dashboard window shows
// when BotBoy's server has been unreachable for about ten seconds, and takes away
// again when the server answers. Owner report 2026-10-14: after Quit & Reopen the
// Chrome window stayed open and silently dead.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { OFFLINE_AFTER_MS, OFFLINE_MESSAGE, createServerLink, isUnreachable } from './server-link.js';
import { syncDocumentReaderPresentation } from './document-reader-presentation.js';

const SECOND = 1000;

function setup() {
  document.body.innerHTML = '<div id="server-link-banner" class="server-link-banner" role="status" aria-live="polite"></div>';
  const banner = document.getElementById('server-link-banner') as HTMLElement;
  const clock = { at: 1_000_000 };
  const link = createServerLink({ banner, now: () => clock.at });
  return { banner, clock, link };
}

const networkError = () => new TypeError('Failed to fetch');
const httpError = (status: number) => Object.assign(new Error(`HTTP ${status}`), { status });

describe('what counts as unreachable', () => {
  it('a request that fails outright, and 502 / 503 / 504, mean the server is not there', () => {
    expect(isUnreachable(networkError())).toBe(true);
    expect(isUnreachable(Object.assign(new Error('x'), { status: 0 }))).toBe(true);
    for (const status of [502, 503, 504]) expect(isUnreachable(httpError(status))).toBe(true);
  });

  it('any other HTTP answer proves the server is there, even an error', () => {
    for (const status of [400, 401, 403, 404, 409, 500]) expect(isUnreachable(httpError(status))).toBe(false);
  });
});

describe('the status line', () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => { ctx = setup(); });

  it('says nothing for the first ten seconds of failures, then names what happened', () => {
    ctx.link.failed();
    expect(ctx.banner.textContent).toBe('');
    ctx.clock.at += OFFLINE_AFTER_MS - 1;
    ctx.link.failed();
    expect(ctx.link.isOffline()).toBe(false);
    expect(ctx.banner.textContent).toBe('');
    ctx.clock.at += 1;
    ctx.link.failed();
    expect(ctx.link.isOffline()).toBe(true);
    expect(ctx.banner.textContent).toBe('BotBoy has stopped or is restarting. Open BotBoy from Applications to continue.');
    expect(ctx.banner.textContent).toBe(OFFLINE_MESSAGE);
    expect(ctx.banner.classList.contains('is-visible')).toBe(true);
  });

  it('is ten seconds in the contract the owner approved', () => {
    expect(OFFLINE_AFTER_MS).toBe(10 * SECOND);
  });

  it('goes away the moment the server answers, and the next outage starts a fresh ten seconds', () => {
    ctx.link.failed();
    ctx.clock.at += 12 * SECOND;
    ctx.link.failed();
    expect(ctx.link.isOffline()).toBe(true);
    ctx.link.reached();
    expect(ctx.link.isOffline()).toBe(false);
    expect(ctx.banner.textContent).toBe('');
    expect(ctx.banner.classList.contains('is-visible')).toBe(false);
    ctx.link.failed();
    ctx.clock.at += 9 * SECOND;
    ctx.link.failed();
    expect(ctx.link.isOffline()).toBe(false);
  });

  it('is not shown by failures that were interrupted by an answer', () => {
    for (let i = 0; i < 6; i++) {
      ctx.link.failed();
      ctx.clock.at += 6 * SECOND;
      ctx.link.reached();
    }
    expect(ctx.link.isOffline()).toBe(false);
    expect(ctx.banner.textContent).toBe('');
  });

  it('counts from the first failure, not from the last success (a hidden window does not poll)', () => {
    ctx.link.reached();
    ctx.clock.at += 3 * 60 * 60 * SECOND; // three hours without a poll
    ctx.link.failed(); // first poll after the window is shown again
    expect(ctx.link.isOffline()).toBe(false);
    ctx.clock.at += OFFLINE_AFTER_MS;
    ctx.link.failed();
    expect(ctx.link.isOffline()).toBe(true);
  });

  it('keeps the same text on later failures instead of repainting it', () => {
    ctx.link.failed();
    ctx.clock.at += 11 * SECOND;
    ctx.link.failed();
    const node = ctx.banner.firstChild;
    ctx.clock.at += 30 * SECOND;
    ctx.link.failed();
    expect(ctx.banner.firstChild).toBe(node);
  });

  it('works without a banner element (state only)', () => {
    const link = createServerLink({ banner: null, now: () => ctx.clock.at });
    link.failed();
    ctx.clock.at += 11 * SECOND;
    expect(() => link.failed()).not.toThrow();
    expect(link.isOffline()).toBe(true);
    expect(() => link.reached()).not.toThrow();
  });
});

describe('watch(request)', () => {
  it('gives back the answer, and an answer clears the line', async () => {
    const { link, banner, clock } = setup();
    link.failed();
    clock.at += 11 * SECOND;
    link.failed();
    expect(banner.textContent).not.toBe('');
    await expect(link.watch(Promise.resolve({ bootId: 'b1' }))).resolves.toEqual({ bootId: 'b1' });
    expect(banner.textContent).toBe('');
  });

  it('rethrows the same error, so the poll keeps its own failure handling', async () => {
    const { link } = setup();
    const error = networkError();
    await expect(link.watch(Promise.reject(error))).rejects.toBe(error);
  });

  it('counts a 503 (starting or shutting down) as unreachable, and a 500 as reachable', async () => {
    const { link, clock, banner } = setup();
    await expect(link.watch(Promise.reject(httpError(503)))).rejects.toThrow('HTTP 503');
    clock.at += 11 * SECOND;
    await expect(link.watch(Promise.reject(httpError(503)))).rejects.toThrow('HTTP 503');
    expect(banner.textContent).toBe(OFFLINE_MESSAGE);
    await expect(link.watch(Promise.reject(httpError(500)))).rejects.toThrow('HTTP 500');
    expect(banner.textContent).toBe('');
    expect(link.isOffline()).toBe(false);
  });
});

describe('the shipped page', () => {
  const html = readFileSync(path.join(process.cwd(), 'src/ui/index.html'), 'utf8');
  const css = readFileSync(path.join(process.cwd(), 'src/ui/dashboard.css'), 'utf8');

  it('has the live region outside the routed view, empty, announced politely', () => {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const banner = doc.getElementById('server-link-banner');
    expect(banner).not.toBeNull();
    expect(banner!.getAttribute('role')).toBe('status');
    expect(banner!.getAttribute('aria-live')).toBe('polite');
    expect(banner!.textContent).toBe('');
    expect(banner!.closest('#app-view')).toBeNull();
    expect(banner!.closest('#workspace')).toBeNull();
  });

  it('is styled as a pointer-transparent overlay that keeps an empty live region in the page', () => {
    const rule = (selector: string) => css.split('\n').find((line) => line.startsWith(selector)) ?? '';
    expect(rule('.server-link-banner {')).toContain('pointer-events:none');
    expect(rule('.server-link-banner {')).toContain('position:fixed');
    // Empty: 1px and clipped, never display:none (a live region that is not rendered is not announced).
    expect(rule('.server-link-banner:empty')).toContain('clip-path');
    expect(rule('.server-link-banner:empty')).not.toContain('display:none');
  });

  // Immersive document Focus covers the viewport (z-index 120) and makes every body-level sibling of the
  // reader aria-hidden and inert; a server that stops mid-Focus must still be shown and announced.
  it('stacks above the immersive document Focus shell', () => {
    const zIndexes = (selector: string) => [...css.matchAll(new RegExp(`${selector.replace(/\./g, '\\.')} \\{[^}]*z-index:(\\d+)`, 'g'))].map((match) => Number(match[1]));
    const banner = zIndexes('.server-link-banner');
    const focus = zIndexes('.documents-shell.document-focus');
    expect(banner).toHaveLength(1);
    expect(focus.length).toBeGreaterThan(0);
    for (const shell of focus) expect(banner[0]).toBeGreaterThan(shell);
  });

  it('stays visible and announced while the reader is in Focus, and the rest of the page is still shut out', () => {
    document.documentElement.innerHTML = html.replace(/<script[\s\S]*?<\/script>/g, '');
    document.getElementById('app-view')!.innerHTML = '<section class="documents-shell"><article class="document-detail-pane"><h2 id="document-detail-title">Plan</h2></article></section>';
    const banner = document.getElementById('server-link-banner')!;
    const toasts = document.getElementById('toast-region')!;
    const topbar = document.querySelector('.topbar')!;

    syncDocumentReaderPresentation(document, { libraryOpen: false, reviewOpen: false, focusMode: true });
    expect(document.querySelector('.documents-shell')!.getAttribute('aria-modal')).toBe('true');
    for (const covered of [topbar, toasts]) {
      expect(covered.hasAttribute('inert')).toBe(true);
      expect(covered.getAttribute('aria-hidden')).toBe('true');
    }
    expect(banner.hasAttribute('inert')).toBe(false);
    expect(banner.hasAttribute('aria-hidden')).toBe(false);
    expect(banner.getAttribute('role')).toBe('status');
    expect(banner.getAttribute('aria-live')).toBe('polite');

    syncDocumentReaderPresentation(document, { libraryOpen: false, reviewOpen: false, focusMode: false });
    expect(topbar.hasAttribute('inert')).toBe(false);
    expect(banner.hasAttribute('inert')).toBe(false);
    expect(banner.hasAttribute('aria-hidden')).toBe(false);
  });

  it('is wired into the version poll only through watch(), with the banner element', () => {
    const dashboard = readFileSync(path.join(process.cwd(), 'src/ui/dashboard.js'), 'utf8');
    expect(dashboard).toContain("import { createServerLink } from './server-link.js';");
    expect(dashboard).toContain("createServerLink({ banner: document.getElementById('server-link-banner') })");
    expect(dashboard).toContain("await serverLink.watch(request('/dashboard/version'))");
  });
});
