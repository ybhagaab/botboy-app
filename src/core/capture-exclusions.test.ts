/**
 * The capture-exclusion registry (knowledge-library.md K1): what it excludes, what it leaves alone, and how it heals.
 * Synthetic folder names only; no real library is touched.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  captureExcludedRootsInEffect,
  invalidateCaptureExclusions,
  isCaptureExcludedPath,
  registerCaptureExcludedRoots,
} from './capture-exclusions.js';

const ROOT = '/private/tmp/kl-excl-fixture/Docs/BotBoy Knowledge';

afterEach(() => {
  registerCaptureExcludedRoots(null);
  vi.useRealTimers();
});

describe('capture exclusion registry', () => {
  it('excludes nothing without a provider, with an empty provider, or for a bad candidate', () => {
    expect(isCaptureExcludedPath(ROOT)).toBe(false);
    registerCaptureExcludedRoots(() => []);
    expect(isCaptureExcludedPath(ROOT)).toBe(false);
    registerCaptureExcludedRoots(() => [ROOT]);
    expect(isCaptureExcludedPath('')).toBe(false);
    expect(captureExcludedRootsInEffect()).toEqual([ROOT.toLowerCase()]);
  });

  it('excludes the root itself and anything inside it, and nothing beside it', () => {
    registerCaptureExcludedRoots(() => [ROOT]);
    expect(isCaptureExcludedPath(ROOT)).toBe(true);
    expect(isCaptureExcludedPath(`${ROOT}/analytics/presets/shopwave.md`)).toBe(true);
    expect(isCaptureExcludedPath(`${ROOT}/GUIDE.md`)).toBe(true);
    // A sibling that merely starts with the same characters is a different folder.
    expect(isCaptureExcludedPath(`${ROOT} 2/notes.md`)).toBe(false);
    expect(isCaptureExcludedPath(`${ROOT}-old/notes.md`)).toBe(false);
    // An ancestor is not excluded; its walks prune the library instead.
    expect(isCaptureExcludedPath(path.dirname(ROOT))).toBe(false);
    expect(isCaptureExcludedPath('/private/tmp/kl-excl-fixture/Docs/other.md')).toBe(false);
  });

  it('compares case-insensitively and in normalized Unicode, and resolves dot segments', () => {
    registerCaptureExcludedRoots(() => [ROOT]);
    expect(isCaptureExcludedPath('/PRIVATE/tmp/kl-excl-fixture/docs/botboy knowledge/x.md')).toBe(true);
    expect(isCaptureExcludedPath(`${ROOT}/sub/../../BotBoy Knowledge/x.md`)).toBe(true);
    registerCaptureExcludedRoots(() => ['/private/tmp/kl-excl-fixture/Caf\u00e9 Notes']);
    expect(isCaptureExcludedPath('/private/tmp/kl-excl-fixture/Cafe\u0301 Notes/a.md')).toBe(true);
  });

  it('keeps every former root excluded beside the current one', () => {
    registerCaptureExcludedRoots(() => [ROOT, '/private/tmp/kl-excl-fixture/Old Knowledge']);
    expect(isCaptureExcludedPath('/private/tmp/kl-excl-fixture/Old Knowledge/analytics/x.md')).toBe(true);
    expect(isCaptureExcludedPath(`${ROOT}/x.md`)).toBe(true);
  });

  it('ignores provider entries that are not absolute paths, and survives a provider that throws', () => {
    registerCaptureExcludedRoots(() => ['', 'relative/folder', '   ', ROOT]);
    expect(captureExcludedRootsInEffect()).toEqual([ROOT.toLowerCase()]);
    registerCaptureExcludedRoots(() => { throw new Error('boom'); });
    expect(isCaptureExcludedPath(ROOT)).toBe(false);
  });

  it('caches the answer, forgets it on invalidate, and heals by itself after the TTL', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-15T10:00:00Z'));
    let roots: string[] = [ROOT];
    const provider = vi.fn(() => roots);
    registerCaptureExcludedRoots(provider);
    expect(isCaptureExcludedPath(`${ROOT}/a.md`)).toBe(true);
    expect(isCaptureExcludedPath(`${ROOT}/b.md`)).toBe(true);
    expect(provider).toHaveBeenCalledTimes(1);
    roots = [];
    // Still cached: a change nobody announced is not seen yet.
    expect(isCaptureExcludedPath(`${ROOT}/a.md`)).toBe(true);
    invalidateCaptureExclusions();
    expect(isCaptureExcludedPath(`${ROOT}/a.md`)).toBe(false);
    roots = [ROOT];
    vi.advanceTimersByTime(4_000);
    expect(isCaptureExcludedPath(`${ROOT}/a.md`)).toBe(false);
    vi.advanceTimersByTime(2_000);
    expect(isCaptureExcludedPath(`${ROOT}/a.md`)).toBe(true);
  });

  describe('links', () => {
    let base: string;
    beforeEach(() => {
      // The real path: a provider hands over every spelling it knows, and this test is about the candidate's.
      base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'kl-excl-links-')));
    });
    afterEach(() => {
      fs.rmSync(base, { recursive: true, force: true });
    });

    it('tests the real path too when asked: a link from outside the library into it is excluded', () => {
      const library = path.join(base, 'BotBoy Knowledge');
      fs.mkdirSync(path.join(library, 'notes'), { recursive: true });
      fs.writeFileSync(path.join(library, 'notes', 'a.md'), '# a\n');
      const outside = path.join(base, 'watched');
      fs.mkdirSync(outside);
      const link = path.join(outside, 'link.md');
      fs.symlinkSync(path.join(library, 'notes', 'a.md'), link);
      registerCaptureExcludedRoots(() => [library]);
      expect(isCaptureExcludedPath(link)).toBe(false);
      expect(isCaptureExcludedPath(link, { resolveLinks: true })).toBe(true);
      expect(isCaptureExcludedPath(path.join(outside, 'plain.md'), { resolveLinks: true })).toBe(false);
      // A path that does not exist is never a link into the library.
      expect(isCaptureExcludedPath(path.join(outside, 'missing.md'), { resolveLinks: true })).toBe(false);
    });
  });
});
