/**
 * Browser capture state — the owner's pause switch and a change counter.
 *
 * The pause is the owner's choice, not a failure: it lives here (not in
 * capture-health) and is persisted under `app_settings` key
 * `browser_capture.v1` as `{ paused, changedAt }`, so it survives a restart.
 * The counter feeds `/dashboard/version` (`browserCaptureVersion`): it moves
 * when the owner toggles the pause and when the monitor reports a pacing
 * change, so open tabs refetch `/browser-capture`.
 */
import type Database from 'better-sqlite3';
import { getSetting, setSetting } from './storage.js';

export const BROWSER_CAPTURE_SETTING_KEY = 'browser_capture.v1';

export interface BrowserCapturePause {
  paused: boolean;
  /** ISO time of the last toggle; null when never toggled. */
  changedAt: string | null;
}

export interface BrowserCaptureState {
  paused(): boolean;
  pause(): BrowserCapturePause;
  /** Persists and returns the new state; a repeat of the current value changes nothing. */
  setPaused(paused: boolean): BrowserCapturePause;
  version(): number;
  /** The monitor's interval or slowed reason changed. */
  noteStatusChange(): void;
}

export function createBrowserCaptureState(deps: { db: Database.Database; now?: () => Date }): BrowserCaptureState {
  const now = deps.now ?? (() => new Date());
  let version = 0;
  let current: BrowserCapturePause = { paused: false, changedAt: null };
  try {
    const stored = getSetting<Partial<BrowserCapturePause>>(deps.db, BROWSER_CAPTURE_SETTING_KEY);
    if (stored && typeof stored === 'object') {
      current = {
        paused: stored.paused === true,
        changedAt: typeof stored.changedAt === 'string' ? stored.changedAt : null,
      };
    }
  } catch { /* an unreadable setting means not paused */ }

  return {
    paused: () => current.paused,
    pause: () => ({ ...current }),
    setPaused(paused) {
      if (paused === current.paused) return { ...current };
      const next: BrowserCapturePause = { paused, changedAt: now().toISOString() };
      setSetting(deps.db, BROWSER_CAPTURE_SETTING_KEY, next);
      current = next;
      version++;
      return { ...current };
    },
    version: () => version,
    noteStatusChange() { version++; },
  };
}
