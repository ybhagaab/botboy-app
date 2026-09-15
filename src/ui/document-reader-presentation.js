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
