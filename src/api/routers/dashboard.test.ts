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
describe('dashboard analytics version', () => {
  // An in-place presentation edit runs no query, so analytics_runs never moves;
  // open dashboard pages must still reload (2026-10-21).
  it('changes when a widget revision, the widget set, or a dashboard updated_at changes, and only then', async () => {
    const storage = createStorage(':memory:');
    storage.initialize();
    try {
      const db = storage.getDb();
      db.prepare(`INSERT INTO analytics_dashboards (id, title, updated_at) VALUES ('dash_v', 'V', '2026-10-21 01:00:00')`).run();
      db.prepare(`INSERT INTO analytics_widgets (id, dashboard_id, position, kind, title) VALUES ('w_a', 'dash_v', 0, 'table', 'A')`).run();
      const app = express();
      app.use('/api', createDashboardRouter(createDashboardState(), db));
      const version = async () => (await request(app).get('/api/dashboard/version')).body.analyticsVersion as string;
      const first = await version();
      expect(first).not.toBe('0');
      expect(await version()).toBe(first);
      db.prepare(`UPDATE analytics_widgets SET revision = revision + 1 WHERE id = 'w_a'`).run();
      const revised = await version();
      expect(revised).not.toBe(first);
      db.prepare(`UPDATE analytics_dashboards SET updated_at = '2026-10-21 01:00:01' WHERE id = 'dash_v'`).run();
      const retitled = await version();
      expect(retitled).not.toBe(revised);
      db.prepare(`INSERT INTO analytics_widgets (id, dashboard_id, position, kind, title) VALUES ('w_b', 'dash_v', 1, 'text', 'B')`).run();
      const added = await version();
      expect(added).not.toBe(retitled);
      // Removing it again moves the receipt too (pages compare with the last poll).
      db.prepare(`DELETE FROM analytics_widgets WHERE id = 'w_b'`).run();
      const removed = await version();
      expect(removed).not.toBe(added);
      // A revision-2 widget replaced by two new ones keeps the revision sum (2) but not the count.
      db.prepare(`DELETE FROM analytics_widgets WHERE id = 'w_a'`).run();
      db.prepare(`INSERT INTO analytics_widgets (id, dashboard_id, position, kind, title) VALUES ('w_c', 'dash_v', 0, 'text', 'C'), ('w_d', 'dash_v', 1, 'text', 'D')`).run();
      expect(await version()).not.toBe(removed);
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
