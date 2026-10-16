/**
 * The overlay that shows the WHOLE of a Knowledge change or a History file (docs/maps/knowledge-library.md K20): one fixed
 * layer over the page, a header with an exit button, a body that scrolls and a footer with the buttons. dashboard.js opens it
 * with the markup from knowledge-ui.js (renderChangeOverlay / renderHistoryOverlay) and handles the buttons inside it, which
 * carry data-knowledge-action like every other card button.
 *
 * A classic script loaded after knowledge-ui.js and before dashboard.js. It is the one part of the Knowledge UI that owns a
 * piece of the DOM outside the page's own markup, so it owns what a dialog must get right:
 *   - Escape closes it. The key is taken in the CAPTURE phase on window and stopped there, so it never also closes the chat
 *     panel or another layer behind it.
 *   - Focus moves into it when it opens, Tab and Shift+Tab stay inside it, and focus returns to the button that opened it.
 *   - Leaving the page (the hash changes) closes it.
 * It does not close on a click outside the panel: a long document is read in it, and a stray click must not lose the place.
 */
(function () {
  const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
  let root = null;
  let returnFocus = null;
  let afterClose = null;

  const isOpen = () => root !== null;

  function focusables() {
    return root ? Array.from(root.querySelectorAll(FOCUSABLE)).filter((element) => !element.hidden) : [];
  }

  function onKeyDown(event) {
    if (!root) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopImmediatePropagation();
      close();
      return;
    }
    if (event.key !== 'Tab') return;
    const items = focusables();
    if (items.length === 0) {
      event.preventDefault();
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    if (!root.contains(active)) {
      event.preventDefault();
      first.focus();
    } else if (event.shiftKey && active === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  }

  /**
   * Opens the overlay with `html` (the panel markup). `focusBack` returns the element to focus when it closes (looked up at
   * that moment, because the page behind may have been repainted since); `onClose` runs after it closes.
   */
  function open(html, options) {
    const opts = options || {};
    if (root) close();
    returnFocus = typeof opts.focusBack === 'function' ? opts.focusBack : null;
    afterClose = typeof opts.onClose === 'function' ? opts.onClose : null;
    root = document.createElement('div');
    root.className = 'knowledge-overlay';
    root.setAttribute('data-knowledge-overlay', '');
    root.innerHTML = html;
    document.body.appendChild(root);
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('hashchange', close);
    const body = root.querySelector('.knowledge-overlay-body');
    if (body) body.focus({ preventScroll: true });
    return root;
  }

  /** Replaces the panel (a refused Apply adds a note) and keeps the reader's place in the body. */
  function update(html) {
    if (!root) return;
    const before = root.querySelector('.knowledge-overlay-body');
    const scrollTop = before ? before.scrollTop : 0;
    const hadFocus = before !== null && document.activeElement === before;
    root.innerHTML = html;
    const after = root.querySelector('.knowledge-overlay-body');
    if (after) {
      after.scrollTop = scrollTop;
      if (hadFocus || !root.contains(document.activeElement)) after.focus({ preventScroll: true });
    }
  }

  function close() {
    if (!root) return;
    const target = returnFocus;
    const callback = afterClose;
    root.remove();
    root = null;
    returnFocus = null;
    afterClose = null;
    window.removeEventListener('keydown', onKeyDown, true);
    window.removeEventListener('hashchange', close);
    const element = target ? target() : null;
    if (element && typeof element.focus === 'function') element.focus({ preventScroll: true });
    if (callback) callback();
  }

  window.BotBoyKnowledgeOverlay = { open, update, close, isOpen, element: () => root };
})();
