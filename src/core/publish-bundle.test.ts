/**
 * Interactive dashboard bundle — CSP safety, data allowlist, manifest
 * identity, vendor completeness (dashboard-sharing plan §2 / step 1a).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import os from 'os';
import path from 'path';
import { renderDashboardBundle, writeBundle } from './publish-bundle.js';
import type { AnalyticsDashboard } from './analytics-types.js';

let vendorDir: string;
let outDir: string;

beforeAll(() => {
  vendorDir = mkdtempSync(path.join(os.tmpdir(), 'bundle-vendor-'));
  for (const name of ['vega.min.js', 'vega-lite.min.js', 'vega-embed.min.js', 'vega-interpreter.js']) {
    writeFileSync(path.join(vendorDir, name), `/* fixture ${name} */`);
  }
  outDir = mkdtempSync(path.join(os.tmpdir(), 'bundle-out-'));
});
afterAll(() => {
  rmSync(vendorDir, { recursive: true, force: true });
  rmSync(outDir, { recursive: true, force: true });
});

function dashboard(overrides: Partial<AnalyticsDashboard> = {}): AnalyticsDashboard {
  return {
    id: 'dash_test',
    title: 'Test Dashboard <script>alert(1)</script>',
    description: 'A test',
    status: 'ready',
    lastRefreshedAt: '2026-09-08T00:00:00.000Z',
    widgets: [
      {
        id: 'w_metric',
        dashboardId: 'dash_test',
        kind: 'metric',
        title: 'Streamers',
        subtitle: '',
        sql: 'SELECT super_secret FROM warehouse',
        preset: 'ott',
        config: { precision: 0, suffix: ' users', internalNote: 'DROP ME' },
        result: { trust: 'external_untrusted_data', columns: ['n'], rows: [[61609]], rowCount: 1, truncated: false, refreshedAt: '2026-09-08T00:00:00.000Z' },
      },
      {
        id: 'w_viz',
        dashboardId: 'dash_test',
        kind: 'visualization',
        title: 'Trend',
        subtitle: 'daily',
        sql: 'SELECT day, n FROM t',
        config: { spec: { mark: 'line', encoding: { x: { field: 'day' }, y: { field: 'n' } } } },
        result: { trust: 'external_untrusted_data', columns: ['day', 'n'], rows: [['a', 1], ['b', 2]], rowCount: 2, truncated: false, refreshedAt: '2026-09-08T00:00:00.000Z' },
      },
    ],
    recentRuns: [],
    projects: [],
    ...overrides,
  } as unknown as AnalyticsDashboard;
}

describe('renderDashboardBundle', () => {
  it('produces the full file set with a stable manifest sha', () => {
    const a = renderDashboardBundle(dashboard(), '2026-09-08T01:00:00.000Z', { vendorDir });
    const b = renderDashboardBundle(dashboard(), '2026-09-08T01:00:00.000Z', { vendorDir });
    expect(a.files.map(f => f.path).sort()).toEqual([
      'assets/data.js', 'assets/render.js', 'assets/style.css',
      'assets/vega-embed.min.js', 'assets/vega-interpreter.js', 'assets/vega-lite.min.js', 'assets/vega.min.js',
      'index.html',
    ]);
    expect(a.manifestSha256).toBe(b.manifestSha256);
    // Content drift must change identity (the publish token binds this sha).
    const c = renderDashboardBundle(dashboard({ title: 'Changed' as any }), '2026-09-08T01:00:00.000Z', { vendorDir });
    expect(c.manifestSha256).not.toBe(a.manifestSha256);
  });

  it('index.html is CSP-safe: no inline script/style, external assets only, escaped title', () => {
    const bundle = renderDashboardBundle(dashboard(), '2026-09-08T01:00:00.000Z', { vendorDir });
    const html = String(bundle.files.find(f => f.path === 'index.html')!.content);
    expect(html).not.toMatch(/<script>[^<]/);          // no inline script bodies
    expect(html).not.toMatch(/<script(?![^>]*src=)/); // every script tag has src
    expect(html).not.toContain('<style>');
    expect(html).not.toMatch(/ on[a-z]+="/);           // no inline event handlers
    expect(html).toContain('script-src \'self\'');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;'); // title escaped
    expect(html).toContain('data-analytics-visualization="w_viz"');
    expect(html).toContain('<noscript><div class="table-wrap">'); // no-JS fallback rows
  });

  it('data.js carries results but never SQL, presets, or unknown config keys', () => {
    const bundle = renderDashboardBundle(dashboard(), '2026-09-08T01:00:00.000Z', { vendorDir });
    const data = String(bundle.files.find(f => f.path === 'assets/data.js')!.content);
    expect(data).toContain('window.BOTBOY_DASHBOARD');
    expect(data).toContain('61609');
    expect(data).not.toContain('super_secret');
    expect(data).not.toContain('SELECT');
    expect(data).not.toContain('ott');
    expect(data).not.toContain('DROP ME');
    expect(data).not.toContain('</script'); // < escaped so the block cannot terminate early
    expect(data).toContain('"spec"');
  });

  it('throws when the Vega runtime is missing instead of publishing a chartless bundle', () => {
    const emptyVendor = mkdtempSync(path.join(os.tmpdir(), 'bundle-novendor-'));
    try {
      expect(() => renderDashboardBundle(dashboard(), '2026-09-08T01:00:00.000Z', { vendorDir: emptyVendor }))
        .toThrow(/Vega runtime file missing/);
    } finally {
      rmSync(emptyVendor, { recursive: true, force: true });
    }
  });

  it('writeBundle materializes the directory layout', () => {
    const bundle = renderDashboardBundle(dashboard(), '2026-09-08T01:00:00.000Z', { vendorDir });
    const target = path.join(outDir, 'd', 'dash_test');
    mkdirSync(target, { recursive: true });
    writeBundle(bundle, target);
    expect(require('fs').existsSync(path.join(target, 'index.html'))).toBe(true);
    expect(require('fs').existsSync(path.join(target, 'assets', 'render.js'))).toBe(true);
    expect(require('fs').existsSync(path.join(target, 'assets', 'vega.min.js'))).toBe(true);
  });
});
