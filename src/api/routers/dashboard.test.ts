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
import express from 'express';
import request from 'supertest';
import { createStorage } from '../../core/storage.js';
import { computeUiAssetsVersion, createDashboardRouter, createDashboardState } from './dashboard.js';

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

describe('dashboard Data Room version receipt', () => {
  it('publishes one opaque receipt and changes it when projected room state changes', async () => {
    const storage = createStorage(':memory:');
    storage.initialize();
    try {
      const app = express();
      app.use('/api', createDashboardRouter(createDashboardState(), storage.getDb()));
      const first = await request(app).get('/api/dashboard/version');
      expect(first.status).toBe(200);
      expect(first.body.dataRoomVersion).toMatch(/^[a-f0-9]{64}$/);
      const stable = await request(app).get('/api/dashboard/version');
      expect(stable.body.dataRoomVersion).toBe(first.body.dataRoomVersion);
      storage.getDb().prepare(`
        UPDATE analytics_data_room_state SET revision = revision + 1 WHERE singleton = 1
      `).run();
      const changed = await request(app).get('/api/dashboard/version');
      expect(changed.body.dataRoomVersion).not.toBe(first.body.dataRoomVersion);
    } finally {
      storage.close();
    }
  });
});
describe('dashboard browser capture version', () => {
  const versionOf = async (callback?: () => { version: number }) => {
    const app = express();
    app.use('/api', createDashboardRouter(createDashboardState(), undefined, undefined, undefined, undefined, undefined, callback));
    return (await request(app).get('/api/dashboard/version')).body;
  };
  it('carries browserCaptureVersion from the new optional callback and follows it', async () => {
    let version = 3;
    expect((await versionOf(() => ({ version }))).browserCaptureVersion).toBe(3);
    version = 4;
    expect((await versionOf(() => ({ version }))).browserCaptureVersion).toBe(4);
  });
  it('omits the field when nothing is wired and survives a throwing callback', async () => {
    expect(await versionOf()).not.toHaveProperty('browserCaptureVersion');
    expect(await versionOf(() => { throw new Error('boom'); })).not.toHaveProperty('browserCaptureVersion');
  });
});
