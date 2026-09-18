function setInert(element, inert) {
  if (!element) return;
  if (inert) element.setAttribute('inert', '');
  else element.removeAttribute('inert');
  try { element.inert = inert; } catch { /* inert property unavailable */ }
}

function scheduleFocus(documentRef, target) {
  if (!target) return;
  const run = () => focusDocumentReaderTarget(documentRef, target);
  const raf = documentRef.defaultView?.requestAnimationFrame;
  if (typeof raf === 'function') raf.call(documentRef.defaultView, run);
  else queueMicrotask(run);
}

function syncFocusBoundary(documentRef, shell, focusMode) {
  if (focusMode) {
    let child = shell;
    while (child?.parentElement) {
      const parent = child.parentElement;
      for (const sibling of parent.children) {
        if (sibling === child || sibling.hasAttribute('data-document-focus-inert')) continue;
        sibling.setAttribute('data-document-focus-inert', sibling.hasAttribute('aria-hidden') ? sibling.getAttribute('aria-hidden') ?? '' : '__absent__');
        sibling.setAttribute('aria-hidden', 'true');
        setInert(sibling, true);
      }
      child = parent;
      if (parent === documentRef.body) break;
    }
    shell.setAttribute('role', 'dialog');
    const title = shell.querySelector('#document-detail-title');
    if (title) {
      shell.setAttribute('aria-labelledby', 'document-detail-title');
      shell.removeAttribute('aria-label');
    } else {
      shell.setAttribute('aria-label', 'Document Focus');
    }
    shell.setAttribute('aria-modal', 'true');
    return;
  }
  documentRef.querySelectorAll('[data-document-focus-inert]').forEach(element => {
    const previous = element.getAttribute('data-document-focus-inert');
    element.removeAttribute('data-document-focus-inert');
    setInert(element, false);
    if (previous === '__absent__') element.removeAttribute('aria-hidden');
    else element.setAttribute('aria-hidden', previous ?? '');
  });
  shell.removeAttribute('role');
  shell.removeAttribute('aria-modal');
  shell.removeAttribute('aria-label');
  shell.removeAttribute('aria-labelledby');
}

/** Synchronize presentation-only reader state without replacing any nodes. */
export function syncDocumentReaderPresentation(documentRef, state) {
  const shell = documentRef.querySelector('.documents-shell');
  if (!shell) return null;
  const libraryOpen = Boolean(state.libraryOpen);
  const reviewOpen = Boolean(state.reviewOpen);
  const focusMode = Boolean(state.focusMode);

  shell.classList.toggle('library-open', libraryOpen);
  shell.classList.toggle('library-collapsed', !libraryOpen);
  shell.classList.toggle('review-open', reviewOpen);
  shell.classList.toggle('document-focus', focusMode);
  syncFocusBoundary(documentRef, shell, focusMode);

  const libraryPane = shell.querySelector('.document-list-pane');
  const libraryContent = shell.querySelector('#document-library-content');
  const libraryHidden = !libraryOpen || focusMode;
  libraryPane?.setAttribute('aria-hidden', String(libraryHidden));
  setInert(libraryPane, libraryHidden);
  libraryContent?.setAttribute('aria-hidden', String(libraryHidden));
  setInert(libraryContent, libraryHidden);

  const libraryToggle = shell.querySelector('.document-title-library-toggle');
  if (libraryToggle) {
    libraryToggle.setAttribute('aria-expanded', String(libraryOpen));
    libraryToggle.setAttribute('aria-label', libraryOpen ? 'Hide generated documents' : 'Show generated documents');
    libraryToggle.setAttribute('title', libraryOpen ? 'Hide generated documents' : 'Show generated documents');
    const use = libraryToggle.querySelector('use');
    if (use) use.setAttribute('href', libraryOpen ? '#i-panel-collapse' : '#i-panel-expand');
  }

  const reviewRail = shell.querySelector('#document-review-rail');
  reviewRail?.setAttribute('aria-hidden', String(!reviewOpen));
  setInert(reviewRail, !reviewOpen);
  shell.querySelectorAll('.document-review-toggle').forEach(button => {
    button.classList.toggle('active', reviewOpen);
    button.setAttribute('aria-expanded', String(reviewOpen));
    button.setAttribute('aria-label', reviewOpen ? 'Close review notes' : 'Open review notes');
  });

  const focusButton = shell.querySelector('[data-action="documents-focus"]');
  if (focusButton) {
    focusButton.classList.toggle('active', focusMode);
    focusButton.setAttribute('aria-pressed', String(focusMode));
    focusButton.setAttribute('aria-label', focusMode ? 'Exit Focus' : 'Enter Focus');
    focusButton.setAttribute('title', focusMode ? 'Exit Focus (Esc)' : 'Open immersive Focus');
    const label = focusButton.querySelector('[data-document-focus-label]');
    if (label) label.textContent = focusMode ? 'Exit Focus' : 'Focus';
    const hint = focusButton.querySelector('[data-document-focus-hint]');
    if (hint) hint.hidden = !focusMode;
    const use = focusButton.querySelector('use');
    if (use) use.setAttribute('href', focusMode ? '#i-x' : '#i-expand');
  }

  return shell;
}

export function computeDocumentPublicationDrawerGeometry({
  viewportWidth,
  viewportHeight,
  paneRect,
  triggerRect,
  mobile = false,
}) {
  const width = Math.max(0, Number(viewportWidth) || 0);
  const height = Math.max(0, Number(viewportHeight) || 0);
  const pane = paneRect || { left: 0, right: width, top: 0, bottom: height };
  const trigger = triggerRect || { left: pane.right, right: pane.right, bottom: pane.top };
  if (mobile) {
    return { mobile: true, top: 0, right: 8, bottom: 61, width: Math.max(0, width - 16), caretX: 0 };
  }

  const paneLeft = Math.max(8, Number(pane.left) + 12);
  const paneRight = Math.min(width - 8, Number(pane.right) - 12);
  const paneTop = Math.max(8, Number(pane.top) + 12);
  const paneBottom = Math.min(height - 8, Number(pane.bottom) - 12);
  const availableWidth = Math.max(280, paneRight - paneLeft);
  const drawerWidth = Math.min(460, availableWidth);
  const right = Math.max(8, width - paneRight);
  const bottom = Math.max(8, height - paneBottom);
  const minimumHeight = Math.min(240, Math.max(180, paneBottom - paneTop));
  const preferredTop = Number(trigger.bottom) + 8;
  const top = Math.max(paneTop, Math.min(preferredTop, paneBottom - minimumHeight));
  const drawerLeft = width - right - drawerWidth;
  const triggerCenter = (Number(trigger.left) + Number(trigger.right)) / 2;
  const caretX = Math.max(28, Math.min(drawerWidth - 28, triggerCenter - drawerLeft));
  return { mobile: false, top, right, bottom, width: drawerWidth, caretX };
}

/** Promote the publication workflow into the browser top layer without changing reader geometry. */
export function syncDocumentPublicationDialog(documentRef, state) {
  const dialog = documentRef.querySelector('#document-publication-dialog');
  if (!dialog) return null;
  const allowedOrigins = new Set(['status', 'toolbar', 'summary']);
  const origin = allowedOrigins.has(state.publicationTrigger) ? state.publicationTrigger : 'summary';
  const triggers = [...documentRef.querySelectorAll('[data-publication-trigger]')];
  triggers.forEach(trigger => trigger.classList.toggle('is-publication-origin', state.publicationOpen && trigger.dataset.publicationTrigger === origin));

  if (!state.publicationOpen) {
    if (dialog.open && typeof dialog.close === 'function') dialog.close();
    return { dialog, open: false, origin };
  }

  const pane = documentRef.querySelector('.document-detail-pane');
  const trigger = documentRef.querySelector(`[data-publication-trigger="${origin}"]`)
    || documentRef.querySelector('[data-publication-trigger="summary"]')
    || triggers[0];
  if (!pane || !trigger) return { dialog, open: false, origin };

  const view = documentRef.defaultView;
  const viewportWidth = view?.innerWidth || documentRef.documentElement?.clientWidth || 0;
  const viewportHeight = view?.innerHeight || documentRef.documentElement?.clientHeight || 0;
  const mobile = view?.matchMedia?.('(max-width: 820px)')?.matches === true || viewportWidth <= 820;
  const geometry = computeDocumentPublicationDrawerGeometry({
    viewportWidth,
    viewportHeight,
    paneRect: pane.getBoundingClientRect(),
    triggerRect: trigger.getBoundingClientRect(),
    mobile,
  });
  const drawer = dialog.querySelector('.document-publication-drawer');
  if (drawer) {
    drawer.style.setProperty('--document-publication-top', `${geometry.top}px`);
    drawer.style.setProperty('--document-publication-right', `${geometry.right}px`);
    drawer.style.setProperty('--document-publication-bottom', `${geometry.bottom}px`);
    drawer.style.setProperty('--document-publication-width', `${geometry.width}px`);
    drawer.style.setProperty('--document-publication-caret-x', `${geometry.caretX}px`);
  }
  dialog.dataset.presentation = mobile ? 'sheet' : 'drawer';
  if (!dialog.open) {
    if (typeof dialog.showModal === 'function') dialog.showModal();
    else dialog.setAttribute('open', '');
  }
  return { dialog, drawer, open: true, origin, geometry };
}

export function focusDocumentReaderTarget(documentRef, target) {
  const shell = documentRef.querySelector('.documents-shell');
  if (!shell) return false;
  const selectors = {
    review: '.document-review-heading',
    'review-control': '.document-review-toggle',
    'focus-content': '[data-document-preview], [data-document-editor]',
    'focus-control': '[data-action="documents-focus"]',
    'library-control': '.document-title-library-toggle',
  };
  const element = shell.querySelector(selectors[target]);
  if (!element) return false;
  element.focus({ preventScroll: true });
  return true;
}

/**
 * Apply presentation state locally. Focus uses the browser View Transition API
 * for its large embedded↔immersive geometry change; Review/Library rely on CSS
 * transitions so the exact preview and rail nodes remain mounted.
 */
export function applyDocumentReaderPresentation({
  documentRef,
  state,
  transition = 'local',
  focusTarget = '',
}) {
  const previewScroller = documentRef.querySelector('.document-preview-shell');
  const reviewScroller = documentRef.querySelector('#document-review-rail');
  const previewTop = previewScroller?.scrollTop ?? 0;
  const reviewTop = reviewScroller?.scrollTop ?? 0;
  const restoreOffsets = () => {
    if (previewScroller) previewScroller.scrollTop = previewTop;
    if (reviewScroller) reviewScroller.scrollTop = reviewTop;
  };
  const apply = () => {
    const shell = syncDocumentReaderPresentation(documentRef, state);
    restoreOffsets();
    return shell;
  };
  const reducedMotion = documentRef.defaultView?.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches === true;
  const startViewTransition = documentRef.startViewTransition;
  if ((transition === 'focus' || transition === 'library') && typeof startViewTransition === 'function' && !reducedMotion) {
    const transitionRoot = documentRef.documentElement;
    const transitionToken = `${transition}:${Date.now()}:${Math.random()}`;
    transitionRoot?.setAttribute('data-document-transition', transition);
    transitionRoot?.setAttribute('data-document-transition-token', transitionToken);
    const clearTransitionMarker = () => {
      if (transitionRoot?.getAttribute('data-document-transition-token') !== transitionToken) return;
      transitionRoot.removeAttribute('data-document-transition');
      transitionRoot.removeAttribute('data-document-transition-token');
    };
    let viewTransition;
    try {
      viewTransition = startViewTransition.call(documentRef, apply);
    } catch {
      clearTransitionMarker();
      apply();
      scheduleFocus(documentRef, focusTarget);
      return null;
    }
    Promise.resolve(viewTransition?.finished).catch(() => undefined).then(() => {
      clearTransitionMarker();
      scheduleFocus(documentRef, focusTarget);
    });
    return viewTransition;
  }
  apply();
  scheduleFocus(documentRef, focusTarget);
  return null;
}
