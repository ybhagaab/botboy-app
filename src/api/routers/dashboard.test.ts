/**
 * Dashboard router unit tests — the UI-assets version stamp that lets open
 * SPA tabs detect rebuilt UI files without a server restart (bootId only
 * changes on restart; incident 2026-09-03: a correct chart fix read as two
 * phantom verification failures because the open tab never re-fetched).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, utimesSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { computeUiAssetsVersion } from './dashboard.js';

describe('computeUiAssetsVersion', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'ui-version-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const touch = (rel: string, mtimeSec: number) => {
    const p = path.join(dir, rel);
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, rel);
    utimesSync(p, mtimeSec, mtimeSec);
  };

  it('is stable across calls when nothing changed', () => {
    touch('app.js', 1_000_000);
    touch('dashboard.js', 1_000_100);
    expect(computeUiAssetsVersion(dir)).toBe(computeUiAssetsVersion(dir));
  });

  it('changes when a file is rewritten with a newer mtime (the rebuild case)', () => {
    touch('app.js', 1_000_000);
    touch('dashboard.js', 1_000_100);
    const before = computeUiAssetsVersion(dir);
    touch('dashboard.js', 1_000_200); // npm run build refreshed the asset
    expect(computeUiAssetsVersion(dir)).not.toBe(before);
  });

  it('changes when a file is added, even with an older mtime', () => {
    touch('app.js', 1_000_100);
    const before = computeUiAssetsVersion(dir);
    touch('new-widget.js', 1_000_000); // count component catches it
    expect(computeUiAssetsVersion(dir)).not.toBe(before);
  });

  it('walks subdirectories (vendor bundles count)', () => {
    touch('app.js', 1_000_000);
    const before = computeUiAssetsVersion(dir);
    touch('vendor/vega.min.js', 1_000_500);
    expect(computeUiAssetsVersion(dir)).not.toBe(before);
  });

  it('returns the "0" sentinel instead of throwing on a missing directory', () => {
    expect(computeUiAssetsVersion(path.join(dir, 'does-not-exist'))).toBe('0');
  });
});
