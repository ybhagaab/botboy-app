import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';
import {
  applyDocumentReaderPresentation,
  syncDocumentReaderPresentation,
} from './document-reader-presentation.js';

function fixture() {
  const dom = new JSDOM(`<!doctype html><body>
    <header class="topbar"><button id="outside-top">Search</button></header>
    <section class="documents-shell has-selection library-open">
      <aside class="document-list-pane"><div id="document-library-content"></div></aside>
      <article class="document-detail-pane">
        <header class="document-detail-header"><div class="document-title-row"><button class="document-title-library-toggle" data-action="documents-toggle-library"><svg><use href="#i-panel-collapse"></use></svg></button><h2 id="document-detail-title">Document</h2><span></span></div></header>
        <div class="document-detail-toolbar">
          <button class="document-review-toggle" data-action="documents-toggle-review" aria-expanded="false">Review</button>
          <button class="document-focus-toggle" data-action="documents-focus" aria-pressed="false">
            <svg><use href="#i-expand"></use></svg><span data-document-focus-label>Focus</span><kbd data-document-focus-hint hidden>Esc</kbd>
          </button>
        </div>
        <div class="document-preview-shell"><div data-document-preview tabindex="0"></div>
          <aside id="document-review-rail" class="document-annotations" tabindex="-1" aria-hidden="true" inert>
            <header class="document-review-heading" tabindex="-1"></header>
          </aside>
        </div>
      </article>
    </section>
  </body>`, { url: 'http://localhost:7778/#/documents/a' });
  const win = dom.window as any;
  win.requestAnimationFrame = (callback: FrameRequestCallback) => { callback(0); return 1; };
  win.matchMedia = () => ({ matches: false });
  return dom;
}

describe('generated-document presentation synchronization', () => {
  it('keeps preview and Review nodes/scroll positions stable through Review → Focus → close Review → exit Focus', async () => {
    const dom = fixture();
    const document = dom.window.document as any;
    const previewShell = document.querySelector('.document-preview-shell');
    const preview = document.querySelector('[data-document-preview]');
    const rail = document.querySelector('#document-review-rail');
    previewShell.scrollTop = 320;
    rail.scrollTop = 140;
    const state = { libraryOpen: true, reviewOpen: false, focusMode: false };

    syncDocumentReaderPresentation(document, state);
    expect(rail.hasAttribute('inert')).toBe(true);

    state.libraryOpen = false;
    state.reviewOpen = true;
    applyDocumentReaderPresentation({ documentRef: document, state, focusTarget: 'review' });
    expect(document.querySelector('.documents-shell').classList.contains('review-open')).toBe(true);
    expect(rail.hasAttribute('inert')).toBe(false);
    expect(document.activeElement).toBe(document.querySelector('.document-review-heading'));

    document.startViewTransition = vi.fn((update: () => void) => {
      update();
      return { finished: Promise.resolve() };
    });
    state.focusMode = true;
    applyDocumentReaderPresentation({ documentRef: document, state, transition: 'focus', focusTarget: 'focus-content' });
    await Promise.resolve();
    await Promise.resolve();
    const shell = document.querySelector('.documents-shell');
    expect(shell.classList.contains('review-open')).toBe(true);
    expect(shell.classList.contains('document-focus')).toBe(true);
    expect(shell.getAttribute('aria-modal')).toBe('true');
    expect(document.querySelector('#outside-top').closest('.topbar').hasAttribute('inert')).toBe(true);
    expect(document.querySelector('#outside-top').closest('.topbar').getAttribute('aria-hidden')).toBe('true');
    expect(document.querySelector('[data-document-focus-label]').textContent).toBe('Exit Focus');
    expect(document.activeElement).toBe(preview);

    state.reviewOpen = false;
    applyDocumentReaderPresentation({ documentRef: document, state, focusTarget: 'review-control' });
    expect(shell.classList.contains('document-focus')).toBe(true);
    expect(shell.classList.contains('review-open')).toBe(false);
    expect(rail.hasAttribute('inert')).toBe(true);

    state.focusMode = false;
    applyDocumentReaderPresentation({ documentRef: document, state, transition: 'focus', focusTarget: 'focus-control' });
    await Promise.resolve();
    await Promise.resolve();
    expect(shell.classList.contains('document-focus')).toBe(false);
    expect(shell.hasAttribute('aria-modal')).toBe(false);
    expect(document.querySelector('#outside-top').hasAttribute('inert')).toBe(false);
    expect(document.querySelector('#outside-top').closest('.topbar').hasAttribute('aria-hidden')).toBe(false);
    expect(document.querySelector('[data-document-focus-label]').textContent).toBe('Focus');
    expect(previewShell.scrollTop).toBe(320);
    expect(rail.scrollTop).toBe(140);
    expect(document.querySelector('[data-document-preview]')).toBe(preview);
    expect(document.querySelector('#document-review-rail')).toBe(rail);
  });

  it('keeps Focus active when Review opens and Review active when Focus exits', async () => {
    const dom = fixture();
    const document = dom.window.document as any;
    document.startViewTransition = (update: () => void) => { update(); return { finished: Promise.resolve() }; };
    const state = { libraryOpen: false, reviewOpen: false, focusMode: true };

    syncDocumentReaderPresentation(document, state);
    state.reviewOpen = true;
    applyDocumentReaderPresentation({ documentRef: document, state, focusTarget: 'review' });
    const shell = document.querySelector('.documents-shell');
    expect(shell.classList.contains('document-focus')).toBe(true);
    expect(shell.classList.contains('review-open')).toBe(true);

    state.focusMode = false;
    applyDocumentReaderPresentation({ documentRef: document, state, transition: 'focus', focusTarget: 'focus-control' });
    await Promise.resolve();
    expect(shell.classList.contains('document-focus')).toBe(false);
    expect(shell.classList.contains('review-open')).toBe(true);
    expect(document.querySelector('#document-review-rail').hasAttribute('inert')).toBe(false);
  });

  it('uses View Transitions only for Focus and bypasses them under reduced motion', () => {
    const dom = fixture();
    const document = dom.window.document as any;
    const start = vi.fn((update: () => void) => { update(); return { finished: Promise.resolve() }; });
    document.startViewTransition = start;
    const state = { libraryOpen: true, reviewOpen: true, focusMode: false };

    applyDocumentReaderPresentation({ documentRef: document, state, transition: 'local' });
    expect(start).not.toHaveBeenCalled();
    applyDocumentReaderPresentation({ documentRef: document, state, transition: 'focus' });
    expect(start).toHaveBeenCalledOnce();

    (dom.window as any).matchMedia = () => ({ matches: true });
    start.mockClear();
    state.focusMode = true;
    applyDocumentReaderPresentation({ documentRef: document, state, transition: 'focus' });
    expect(start).not.toHaveBeenCalled();
    expect(document.querySelector('.documents-shell').classList.contains('document-focus')).toBe(true);
  });
});
