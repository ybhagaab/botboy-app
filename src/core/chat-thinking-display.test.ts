import { afterEach, describe, expect, it, vi } from 'vitest';
import { CHAT_THINKING_SETTING_KEY, createChatThinkingDisplay } from './chat-thinking-display.js';
import { createStorage, getSetting, setSetting, type StorageLayer } from './storage.js';

/** Settings → AI model → Show model thinking: on by default, kept in one settings row, malformed rows read as on. */
describe('chat thinking display setting', () => {
  let storage: StorageLayer | undefined;
  const db = () => {
    storage = createStorage(':memory:');
    storage.initialize();
    return storage.getDb();
  };

  afterEach(() => {
    storage?.close();
    storage = undefined;
    vi.restoreAllMocks();
  });

  it('is on until the owner turns it off, and the choice is stored and read back', () => {
    const database = db();
    const display = createChatThinkingDisplay({ db: database, now: () => new Date('2026-10-19T09:30:00.000Z') });
    expect(display.status()).toEqual({ showThinking: true, updatedAt: null });
    expect(getSetting(database, CHAT_THINKING_SETTING_KEY)).toBeNull();
    expect(display.setShowThinking(false)).toEqual({ showThinking: false, updatedAt: '2026-10-19T09:30:00.000Z' });
    expect(display.showThinking()).toBe(false);
    expect(getSetting(database, CHAT_THINKING_SETTING_KEY)).toEqual({ schema: 1, showThinking: false, updatedAt: '2026-10-19T09:30:00.000Z' });
    expect(createChatThinkingDisplay({ db: database }).status()).toEqual({ showThinking: false, updatedAt: '2026-10-19T09:30:00.000Z' });
  });

  it('refuses anything but a boolean and leaves the stored choice alone', () => {
    const database = db();
    const display = createChatThinkingDisplay({ db: database });
    display.setShowThinking(false);
    for (const value of ['true', 1, null, undefined]) {
      expect(() => display.setShowThinking(value as unknown as boolean)).toThrow(TypeError);
    }
    expect(display.showThinking()).toBe(false);
    expect(createChatThinkingDisplay({ db: database }).showThinking()).toBe(false);
  });

  it('reads a malformed row as on, with a warning', () => {
    const database = db();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    for (const value of [{ schema: 2, showThinking: false, updatedAt: 'x' }, { schema: 1, showThinking: 'no', updatedAt: 'x' }, 'off']) {
      setSetting(database, CHAT_THINKING_SETTING_KEY, value);
      expect(createChatThinkingDisplay({ db: database }).showThinking()).toBe(true);
    }
    expect(warn).toHaveBeenCalledTimes(3);
  });
});
