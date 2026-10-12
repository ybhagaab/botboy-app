import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createStorage, getSetting, setSetting, type StorageLayer } from './storage.js';
import { BROWSER_CAPTURE_SETTING_KEY, createBrowserCaptureState } from './browser-capture-state.js';

describe('browser capture state', () => {
  let storage: StorageLayer;
  beforeEach(() => { storage = createStorage(':memory:'); storage.initialize(); });
  afterEach(() => storage.close());
  const db = () => storage.getDb();

  it('starts unpaused with version 0 and writes nothing', () => {
    const state = createBrowserCaptureState({ db: db() });
    expect(state.paused()).toBe(false);
    expect(state.pause()).toEqual({ paused: false, changedAt: null });
    expect(state.version()).toBe(0);
    expect(getSetting(db(), BROWSER_CAPTURE_SETTING_KEY)).toBeNull();
  });

  it('persists the pause under browser_capture.v1 and bumps the version on each toggle', () => {
    const state = createBrowserCaptureState({ db: db(), now: () => new Date('2026-10-12T10:00:00.000Z') });
    expect(state.setPaused(true)).toEqual({ paused: true, changedAt: '2026-10-12T10:00:00.000Z' });
    expect(state.paused()).toBe(true);
    expect(state.version()).toBe(1);
    expect(getSetting(db(), BROWSER_CAPTURE_SETTING_KEY)).toEqual({ paused: true, changedAt: '2026-10-12T10:00:00.000Z' });
    state.setPaused(false);
    expect(state.version()).toBe(2);
    expect(getSetting<any>(db(), BROWSER_CAPTURE_SETTING_KEY)).toMatchObject({ paused: false });
  });

  it('a repeat of the current value changes neither the stored time nor the version', () => {
    let tick = 0;
    const state = createBrowserCaptureState({ db: db(), now: () => new Date(Date.UTC(2026, 9, 12, 10, 0, tick++)) });
    state.setPaused(true);
    const first = state.pause();
    state.setPaused(true);
    expect(state.pause()).toEqual(first);
    expect(state.version()).toBe(1);
  });

  it('survives a new state instance on the same database', () => {
    createBrowserCaptureState({ db: db() }).setPaused(true);
    const again = createBrowserCaptureState({ db: db() });
    expect(again.paused()).toBe(true);
    expect(again.pause().changedAt).toEqual(expect.any(String));
  });

  it('treats a malformed stored value as not paused', () => {
    setSetting(db(), BROWSER_CAPTURE_SETTING_KEY, 'yes');
    expect(createBrowserCaptureState({ db: db() }).paused()).toBe(false);
    setSetting(db(), BROWSER_CAPTURE_SETTING_KEY, { paused: 'true' });
    expect(createBrowserCaptureState({ db: db() }).paused()).toBe(false);
  });

  it('noteStatusChange bumps the version without touching the pause', () => {
    const state = createBrowserCaptureState({ db: db() });
    state.noteStatusChange();
    state.noteStatusChange();
    expect(state.version()).toBe(2);
    expect(state.paused()).toBe(false);
    expect(getSetting(db(), BROWSER_CAPTURE_SETTING_KEY)).toBeNull();
  });
});
