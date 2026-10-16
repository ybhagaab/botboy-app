// @vitest-environment jsdom
// The overlay that shows the whole of a Knowledge change (src/ui/knowledge-overlay.js, docs/maps/knowledge-library.md K20),
// run from the shipped source in jsdom: what makes it a dialog and not just a box. The markup it is handed comes from
// knowledge-ui.js (knowledge-changes-ui.test.ts), and the page's use of it from dashboard.js (same file).
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

type Overlay = {
  open: (html: string, options?: { focusBack?: () => Element | null; onClose?: () => void }) => HTMLElement;
  update: (html: string) => void;
  close: () => void;
  isOpen: () => boolean;
  element: () => HTMLElement | null;
};
let overlay: Overlay;

beforeAll(() => {
  // eslint-disable-next-line no-new-func
  new Function(readFileSync(path.join(process.cwd(), 'src/ui/knowledge-overlay.js'), 'utf8'))();
  overlay = (window as unknown as { BotBoyKnowledgeOverlay: Overlay }).BotBoyKnowledgeOverlay;
});
afterEach(() => {
  overlay.close();
  document.body.innerHTML = '';
});

const PANEL = (body = 'the whole change') => `<div class="knowledge-overlay-panel" role="dialog" aria-modal="true">
  <header><button type="button" id="exit" data-knowledge-action="overlay-close">x</button></header>
  <div class="knowledge-overlay-body" tabindex="0">${body}</div>
  <footer><button type="button" id="apply">Apply</button><button type="button" id="close" data-knowledge-action="overlay-close">Close</button></footer>
</div>`;
const press = (key: string, init: KeyboardEventInit = {}, target: Element = document.activeElement ?? document.body) => {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
};
const byId = (id: string) => document.getElementById(id) as HTMLElement;

describe('opening', () => {
  it('puts one fixed layer in the page with the panel in it, and moves the focus to the scrolling body so the keys scroll it', () => {
    document.body.innerHTML = '<main><button id="opener">Expand</button></main>';
    byId('opener').focus();
    const root = overlay.open(PANEL());
    expect(root.parentElement).toBe(document.body);
    expect(root.className).toBe('knowledge-overlay');
    expect(root.querySelector('[role="dialog"][aria-modal="true"]')).not.toBeNull();
    expect(overlay.isOpen()).toBe(true);
    expect(document.activeElement).toBe(root.querySelector('.knowledge-overlay-body'));
  });

  it('opening again replaces it: there is never more than one layer', () => {
    overlay.open(PANEL('first'));
    overlay.open(PANEL('second'));
    expect(document.querySelectorAll('.knowledge-overlay')).toHaveLength(1);
    expect(document.querySelector('.knowledge-overlay-body')!.textContent).toBe('second');
  });

  it('does not close on a click outside the panel: a long document is read in it, and a stray click must not lose the place', () => {
    const root = overlay.open(PANEL());
    root.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(overlay.isOpen()).toBe(true);
  });
});

describe('Escape', () => {
  it('closes it from anywhere inside, and nobody else hears the key (the chat panel closes on Escape too)', () => {
    overlay.open(PANEL());
    byId('apply').focus();
    const elsewhere = vi.fn();
    document.addEventListener('keydown', elsewhere);
    window.addEventListener('keydown', elsewhere);
    const event = press('Escape');
    document.removeEventListener('keydown', elsewhere);
    window.removeEventListener('keydown', elsewhere);
    expect(overlay.isOpen()).toBe(false);
    expect(document.querySelector('.knowledge-overlay')).toBeNull();
    expect(event.defaultPrevented).toBe(true);
    expect(elsewhere).not.toHaveBeenCalled();
  });

  it('is left alone once it is closed: the key reaches the page again', () => {
    overlay.open(PANEL());
    overlay.close();
    const elsewhere = vi.fn();
    document.addEventListener('keydown', elsewhere);
    const event = press('Escape', {}, document.body);
    document.removeEventListener('keydown', elsewhere);
    expect(elsewhere).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(false);
  });

  it('other keys pass through while it is open', () => {
    overlay.open(PANEL());
    const elsewhere = vi.fn();
    document.addEventListener('keydown', elsewhere);
    press('PageDown');
    document.removeEventListener('keydown', elsewhere);
    expect(elsewhere).toHaveBeenCalledTimes(1);
    expect(overlay.isOpen()).toBe(true);
  });
});

describe('focus', () => {
  it('Tab stays inside: from the last control it wraps to the first, Shift+Tab from the first wraps to the last, and from outside it comes in', () => {
    document.body.innerHTML = '<button id="behind">Behind</button>';
    overlay.open(PANEL());
    const order = ['exit', 'apply', 'close'];
    // The body (tabindex 0) is the first stop in document order after the header button.
    const stops = Array.from(document.querySelectorAll('.knowledge-overlay a[href], .knowledge-overlay button, .knowledge-overlay [tabindex]'));
    const first = stops[0] as HTMLElement;
    const last = stops[stops.length - 1] as HTMLElement;
    expect(order.every((id) => stops.includes(byId(id)))).toBe(true);
    last.focus();
    expect(press('Tab').defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(first);
    expect(press('Tab', { shiftKey: true }).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(last);
    byId('behind').focus();
    expect(press('Tab').defaultPrevented).toBe(true);
    expect(first.contains(document.activeElement) || document.activeElement === first).toBe(true);
    byId('apply').focus();
    expect(press('Tab').defaultPrevented).toBe(false); // a Tab in the middle is left to the browser
  });

  it('returns to the element focusBack names, looked up when it closes, and calls onClose once afterwards', () => {
    document.body.innerHTML = '<button id="opener">Expand</button>';
    const onClose = vi.fn(() => { expect(document.activeElement).toBe(byId('opener')); });
    overlay.open(PANEL(), { focusBack: () => byId('opener'), onClose });
    expect(document.activeElement).not.toBe(byId('opener'));
    // The page behind was repainted while it was open: the lookup finds the new button, not the old one.
    document.body.innerHTML = '<button id="opener">Expand again</button>';
    overlay.close();
    overlay.close();
    expect(document.activeElement).toBe(byId('opener'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closing without a place to return to is harmless', () => {
    overlay.open(PANEL(), { focusBack: () => null });
    expect(() => overlay.close()).not.toThrow();
    expect(overlay.isOpen()).toBe(false);
  });
});

describe('staying with the page', () => {
  it('leaving the page (the hash changes) closes it', () => {
    overlay.open(PANEL());
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    expect(overlay.isOpen()).toBe(false);
  });

  it('update replaces the panel, keeps the reader\'s place in the body, and keeps the focus where it was', () => {
    const scroll = new WeakMap<Element, number>();
    const original = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop');
    // jsdom has no layout: give scrollTop a value to keep, so the test can see whether update restored it.
    Object.defineProperty(Element.prototype, 'scrollTop', { configurable: true, get() { return scroll.get(this) ?? 0; }, set(value: number) { scroll.set(this, value); } });
    try {
      overlay.open(PANEL('before'));
      const before = document.querySelector('.knowledge-overlay-body') as HTMLElement;
      before.scrollTop = 480;
      overlay.update(PANEL('after, with a note'));
      const after = document.querySelector('.knowledge-overlay-body') as HTMLElement;
      expect(after).not.toBe(before);
      expect(after.textContent).toBe('after, with a note');
      expect(after.scrollTop).toBe(480);
      expect(document.activeElement).toBe(after);
      byId('apply').focus();
      overlay.update(PANEL('again'));
      expect(document.querySelectorAll('.knowledge-overlay')).toHaveLength(1);
    } finally {
      if (original) Object.defineProperty(Element.prototype, 'scrollTop', original); else delete (Element.prototype as unknown as Record<string, unknown>).scrollTop;
    }
  });

  it('update with nothing open does nothing', () => {
    overlay.update(PANEL());
    expect(document.querySelector('.knowledge-overlay')).toBeNull();
    expect(overlay.element()).toBeNull();
  });
});
