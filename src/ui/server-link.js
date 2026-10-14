// Server link: tells the open dashboard window when BotBoy's server is gone.
//
// Why (2026-10-14): Quit & Reopen, a crash, or an update restart stops the
// server while the Chrome window stays open. Every poll then failed in silence,
// so the window looked alive and nothing worked. This module turns "the server
// has been unreachable for about ten seconds" into one calm status line, and
// removes it the moment the server answers again.
//
// It is fed by the existing /dashboard/version poll in dashboard.js (`watch`),
// so it adds no timer, no request and no route. Recovery is not here: when the
// server comes back with a new boot id, the poll's own reload branch reloads the
// window on the same route (docs/maps/ui-shell.md › Server link).
//
// "Unreachable" means the request failed outright (nothing is listening) or the
// server answered 502/503/504 (BotBoy is starting up or shutting down). Any other
// HTTP answer proves the server is there, even when it is an error.

export const OFFLINE_AFTER_MS = 10_000;
export const OFFLINE_MESSAGE = 'BotBoy has stopped or is restarting. Open BotBoy from Applications to continue.';

const UNREACHABLE_STATUSES = new Set([502, 503, 504]);

/** True when a failed request means "the server is not there", not "the server said no". */
export function isUnreachable(error) {
  const status = Number(error && error.status);
  if (!Number.isFinite(status) || status === 0) return true; // fetch itself failed
  return UNREACHABLE_STATUSES.has(status);
}

/**
 * @param {object} options
 * @param {Element|null} [options.banner] the live region to fill (`#server-link-banner`); null keeps state only
 * @param {() => number} [options.now] clock, replaced in tests
 * @param {number} [options.offlineAfterMs] how long failures must last before the status shows
 * @param {string} [options.message] the status text
 */
export function createServerLink({ banner = null, now = () => Date.now(), offlineAfterMs = OFFLINE_AFTER_MS, message = OFFLINE_MESSAGE } = {}) {
  let failingSince = null;
  let offline = false;

  function paint() {
    if (!banner) return;
    // The live region stays in the page, empty, so assistive technology announces the text when it appears.
    banner.textContent = offline ? message : '';
    banner.classList.toggle('is-visible', offline);
  }

  function reached() {
    failingSince = null;
    if (!offline) return;
    offline = false;
    paint();
  }

  function failed() {
    const at = now();
    // Measure from the first failure of this streak, not from the last success: a hidden
    // window does not poll, so the last success can be hours old.
    if (failingSince === null) failingSince = at;
    if (offline || at - failingSince < offlineAfterMs) return;
    offline = true;
    paint();
  }

  return {
    isOffline: () => offline,
    reached,
    failed,
    /** Await a request, record how it went, and give the caller the same result or error. */
    async watch(attempt) {
      try {
        const value = await attempt;
        reached();
        return value;
      } catch (error) {
        if (isUnreachable(error)) failed();
        else reached();
        throw error;
      }
    },
  };
}
