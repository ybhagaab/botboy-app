import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { RawWorkItem } from '../core/types.js';
import { createClipboardMonitor, looksLikeCopiedPassword, privateCopyReasonFromText } from './clipboard-monitor.js';

// Synthetic secrets are assembled at run time from split prefixes, so no
// token-shaped literal lives in the repository.
const GITHUB_TOKEN = `${['gh', 'p_'].join('')}A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8`;
const SLACK_TOKEN = `${['xo', 'xp-'].join('')}123456789012-123456789012-AbCdEfGh1234`;

describe('privateCopyReasonFromText', () => {
  it('holds high-confidence secret formats by kind', () => {
    expect(privateCopyReasonFromText(GITHUB_TOKEN)).toBe('Contains what looks like a GitHub token');
    expect(privateCopyReasonFromText(`export SLACK_USER_TOKEN=${SLACK_TOKEN}`)).toMatch(/Slack token/);
  });

  it('holds a lone generated-password token and lets ordinary copies through', () => {
    expect(looksLikeCopiedPassword('Xk9$mP2!qLw7')).toBe(true);
    expect(privateCopyReasonFromText('Xk9$mP2!qLw7')).toBe('Looks like a copied password');
    for (const ordinary of [
      'Quarterly plan for the launch',  // prose
      'https://example.com/a?B=1&c=2',   // URL
      '~/Downloads/Report_Q3.pdf',       // path
      'Report_Q3-2026.pdf',             // file name
      'ada.lovelace@example.com',        // email
      '3f2b9c1e-8d4a-4f6b-9e2a-1c7d5b8a9f00', // UUID
      'BOTBOY-1234',                    // ticket id
      'handleAddOrChange',              // identifier
      'Short1!',                        // too short to be a generated password
    ]) {
      expect(privateCopyReasonFromText(ordinary), ordinary).toBeNull();
    }
  });
});

describe('clipboard monitor', () => {
  let clipboard: string | null;
  let types: string[] | null;
  let typeReads: number;
  let changeDuringTypeRead: string | null;
  let held: string[];
  let emitted: RawWorkItem[];
  let monitor: ReturnType<typeof createClipboardMonitor> | null;

  const settle = async () => { for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve)); };

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    clipboard = null;
    types = ['public.utf8-plain-text'];
    typeReads = 0;
    changeDuringTypeRead = null;
    held = [];
    emitted = [];
    monitor = createClipboardMonitor({ pollIntervalMs: 1000 }, {
      readText: () => clipboard,
      readTypes: async () => {
        typeReads++;
        if (changeDuringTypeRead !== null) {
          clipboard = changeDuringTypeRead;
          changeDuringTypeRead = null;
        }
        return types;
      },
      onHeld: reason => held.push(reason),
    });
    monitor.onWorkItem(item => emitted.push(item));
  });

  afterEach(() => {
    monitor?.stop();
    vi.useRealTimers();
  });

  const poll = async () => {
    await vi.advanceTimersByTimeAsync(1000);
    await settle();
  };

  it('captures an ordinary copy once', async () => {
    clipboard = 'Meeting notes: launch moves to Thursday';
    monitor!.start();
    await settle();
    await poll();
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({ type: 'clipboard_capture', source: 'clipboard', content: 'Meeting notes: launch moves to Thursday' });
    expect(held).toEqual([]);
  });

  it('never captures a copied token and does not re-check it every poll', async () => {
    clipboard = GITHUB_TOKEN;
    monitor!.start();
    await settle();
    await poll();
    expect(emitted).toEqual([]);
    expect(held).toEqual(['Contains what looks like a GitHub token']);
    // The format check decided it; the pasteboard types were never needed.
    expect(typeReads).toBe(0);
  });

  it('honors the password-manager privacy marker without reading anything else', async () => {
    clipboard = 'correct horse battery staple';
    types = ['public.utf8-plain-text', 'org.nspasteboard.ConcealedType'];
    monitor!.start();
    await settle();
    expect(emitted).toEqual([]);
    expect(held).toEqual(['Marked private by the app it was copied from']);
  });

  it('decides afresh when the clipboard changes while its types are read', async () => {
    clipboard = 'first copy';
    changeDuringTypeRead = 'second copy';
    monitor!.start();
    await settle();
    expect(emitted).toEqual([]); // the types may describe the newer copy
    await poll();
    expect(emitted.map(item => item.content)).toEqual(['second copy']);
  });

  it('keeps capturing when the type list is unavailable', async () => {
    clipboard = 'a plain sentence that was copied';
    types = null;
    monitor!.start();
    await settle();
    expect(emitted).toHaveLength(1);
  });
});
