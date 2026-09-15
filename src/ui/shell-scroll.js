/**
 * Outer routed-page scroll arbitration for the fixed-topbar shell.
 *
 * #workspace already starts below the global nav. Controls appear underneath
 * the nav only when stale JavaScript restores an old route's non-zero scroll.
 * Every delayed writer must therefore prove hash + navigation-epoch ownership.
 */

export function parseReloadScrollSnapshot(raw, currentHash) {
  if (raw === null || raw === undefined || raw === '') return null;
  try {
    const parsed = JSON.parse(String(raw));
    if (parsed && typeof parsed === 'object') {
      const top = Number(parsed.top);
      const hasHash = typeof parsed.hash === 'string';
      const hash = hasHash ? parsed.hash : '';
      return Number.isFinite(top) && top > 0 && hasHash ? { hash, top } : null;
    }
    // One-upgrade-cycle compatibility: old UI code stored a bare scalar. It
    // was written immediately before reload, so bind it to the landing hash.
    const top = Number(parsed);
    return Number.isFinite(top) && top > 0 ? { hash: currentHash, top } : null;
  } catch {
    const top = Number(raw);
    return Number.isFinite(top) && top > 0 ? { hash: currentHash, top } : null;
  }
}

export function beginRouteNavigation({
  routeChanged,
  navigationEpoch,
  workspace,
  cancelPendingRestore = () => {},
}) {
  if (!routeChanged) return navigationEpoch;
  cancelPendingRestore();
  if (workspace) workspace.scrollTop = 0;
  return navigationEpoch + 1;
}

export function shouldPreserveOuterScroll({
  routeChanged,
  preserveScroll,
  overlayOpen,
  userAction,
}) {
  return !routeChanged && Boolean(preserveScroll || overlayOpen || !userAction);
}

/**
 * Retry a reload restore only while the original route-navigation still owns
 * it. Returns a cancellation function; cancellation is idempotent.
 */
export function startOuterScrollRestore({
  snapshot,
  navigationEpoch,
  getNavigationEpoch,
  getHash,
  getScroller,
  schedule = (callback, delay) => setTimeout(callback, delay),
  now = () => Date.now(),
  retryMs = 250,
  timeoutMs = 8000,
  onFinish = () => {},
}) {
  let active = true;
  const startedAt = now();
  const finish = (reason) => {
    if (!active) return;
    active = false;
    onFinish(reason);
  };
  const attempt = () => {
    if (!active) return;
    if (getNavigationEpoch() !== navigationEpoch || getHash() !== snapshot.hash) {
      finish('route-changed');
      return;
    }
    const scroller = getScroller();
    if (!scroller) {
      if (now() - startedAt < timeoutMs) schedule(attempt, retryMs);
      else finish('expired');
      return;
    }
    if (scroller.scrollTop !== 0) {
      finish('owner-moved');
      return;
    }
    const maximum = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
    if (maximum >= snapshot.top) {
      scroller.scrollTop = snapshot.top;
      finish('restored');
      return;
    }
    if (now() - startedAt < timeoutMs) schedule(attempt, retryMs);
    else finish('expired');
  };
  attempt();
  return () => finish('cancelled');
}

/**
 * The document root is structural chrome, never a content scroller. Routed
 * content belongs to #workspace; a restored window/document scroll offset
 * shifts that entire scroller under the fixed topbar even when its own
 * scrollTop is zero. Reset both observable sources because browser history
 * restoration can update them after first paint.
 */
export function enforceRootScrollOrigin({
  scrollingElement,
  scrollWindow,
}) {
  const rootTop = Number(scrollingElement?.scrollTop) || 0;
  const rootLeft = Number(scrollingElement?.scrollLeft) || 0;
  const windowTop = Number(scrollWindow?.scrollY) || 0;
  const windowLeft = Number(scrollWindow?.scrollX) || 0;
  if (!rootTop && !rootLeft && !windowTop && !windowLeft) return false;
  if (scrollingElement) {
    scrollingElement.scrollTop = 0;
    scrollingElement.scrollLeft = 0;
  }
  scrollWindow?.scrollTo?.(0, 0);
  return true;
}
