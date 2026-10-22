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

/**
 * HTML views in a published bundle (2026-10-10): Harmony serves
 * `script-src 'self'; style-src 'self' 'nonce-…'`, so a view ships as its own
 * same-origin page with its styles, scripts, and data as separate files.
 */
describe('html views in a published bundle', () => {
  const page = {
    id: 'widget_view', dashboardId: 'dash_1', position: 0, revision: 1, bindingRevision: 0, kind: 'html', title: 'Funnel page', subtitle: '',
    preset: '', config: { html: '<style>.k{color:red}</style><div class="k" style="margin:4px">x</div><script>botboy.onData(d => { document.querySelector(".k").textContent = d.daily.rows.length; })</script><script src="https://evil.example/x.js"></script>', inputs: ['daily'], span: 12 },
    result: { trust: 'local_static_content', columns: ['html'], rows: [['html view']], rowCount: 1, displayedRowCount: 1, refreshedAt: '2026-10-10T00:00:00.000Z' },
  };
  const data = {
    id: 'widget_data', dashboardId: 'dash_1', position: 1, revision: 1, bindingRevision: 0, kind: 'table', title: 'Daily', subtitle: '',
    preset: '', config: { key: 'daily', hidden: true },
    result: { trust: 'local_verified_data', columns: ['day', 'n'], rows: [['2026-10-01', 3], ['2026-10-02', 5]], rowCount: 2, displayedRowCount: 2, refreshedAt: '2026-10-10T00:00:00.000Z' },
  };

  it('ships the page, its styles and scripts as files, its data, and frames it same-origin', () => {
    const bundle = renderDashboardBundle(dashboard({ widgets: [page, data] as any }), '2026-10-10T01:00:00.000Z', { vendorDir });
    const byPath = new Map(bundle.files.map(file => [file.path, String(file.content)]));
    const view = byPath.get('assets/view-widget_view.html')!;
    expect(view).toBeTruthy();
    expect(view).toContain('<link rel="stylesheet" href="view-widget_view-1.css">');
    expect(view).toContain('<script src="view-widget_view-1.js"></script>');
    expect(view).not.toContain('evil.example');
    expect(view).not.toMatch(/<script>(?!<)/); // no inline script left
    expect(view).toContain("script-src 'self'");
    expect(byPath.get('assets/view-widget_view-1.css')).toBe('.k{color:red}');
    expect(byPath.get('assets/view-widget_view-1.js')).toContain('botboy.onData');
    const dataFile = byPath.get('assets/view-widget_view-data.js')!;
    expect(dataFile).toContain('"daily"');
    expect(dataFile).toContain('{"day":"2026-10-01","n":3}');
    expect(byPath.get('assets/view-runtime.js')).toContain('style.cssText');
    const index = byPath.get('index.html')!;
    expect(index).toContain('<iframe class="html-view-frame" src="assets/view-widget_view.html"');
    expect(index).toContain("frame-src 'self'");
    expect(index).toContain('Data behind this dashboard');
    expect(index).not.toContain('sandbox=');
  });

  it('every view file is in the manifest, so a changed page changes the publication hash', () => {
    const a = renderDashboardBundle(dashboard({ widgets: [page, data] as any }), '2026-10-10T01:00:00.000Z', { vendorDir });
    const changed = { ...page, config: { ...page.config, html: page.config.html.replace('red', 'blue') } };
    const b = renderDashboardBundle(dashboard({ widgets: [changed, data] as any }), '2026-10-10T01:00:00.000Z', { vendorDir });
    expect(a.manifestSha256).not.toBe(b.manifestSha256);
  });
});

/**
 * Plain wording on a shared copy (2026-10-21): config.columnLabels names a
 * table's headers and config.note sits in italics under the widget, as in
 * BotBoy's own page. Both are owner-facing text, escaped like every title.
 */
describe('column labels and notes in a published bundle', () => {
  const table = (config: Record<string, unknown>, id = 'w_table') => ({
    id, dashboardId: 'dash_test', position: 0, revision: 1, bindingRevision: 0, kind: 'table', title: 'Weekly', subtitle: '',
    preset: '', config,
    result: { trust: 'local_verified_data', columns: ['wk', 'dau', 'constructor'], rows: [['2026-W40', 12, 1]], rowCount: 1, displayedRowCount: 1, refreshedAt: '2026-10-10T00:00:00.000Z' },
  });
  const index = (widgets: unknown[]) => String(renderDashboardBundle(dashboard({ widgets } as any), '2026-10-10T01:00:00.000Z', { vendorDir })
    .files.find(file => file.path === 'index.html')!.content);

  it('labels the headers, keeps unlabelled columns, and puts the escaped note between the body and the footer', () => {
    const html = index([table({ columnLabels: { wk: ' Week <b> ', dau: 'Daily users' }, note: ' Daily users: people who\nplayed <one> title. ' })]);
    expect(html).toContain('<th>Week &lt;b&gt;</th><th>Daily users</th><th>constructor</th>');
    expect(html).toContain('</section><p class="note">Daily users: people who<br>played &lt;one&gt; title.</p><footer>');
  });

  it('shows the raw column names and no note when neither is set, or when they are blank', () => {
    for (const config of [{}, { note: '   ', columnLabels: { wk: '  ' } }, { note: 7, columnLabels: ['Week'] }]) {
      const html = index([table(config)]);
      expect(html).toContain('<th>wk</th><th>dau</th><th>constructor</th>');
      expect(html).not.toContain('class="note"');
    }
  });

  it('labels the no-script rows of a chart and notes a hidden data widget under "Data behind this dashboard"', () => {
    const chart = { ...table({ spec: { mark: 'bar' }, columnLabels: { dau: 'Daily users' } }, 'w_chart'), kind: 'visualization', position: 1 };
    const hidden = table({ hidden: true, note: 'Behind the page.' }, 'w_hidden');
    const html = index([chart, { ...hidden, position: 2 }]);
    expect(html).toMatch(/<noscript><div class="table-wrap"><table><thead><tr><th>wk<\/th><th>Daily users<\/th>/);
    const details = html.slice(html.indexOf('<details class="hidden-data">'));
    expect(details).toContain('<p class="note">Behind the page.</p>');
  });

  it('puts an html view\'s note under its frame, as BotBoy\'s page does', () => {
    const view = {
      id: 'w_view', dashboardId: 'dash_test', position: 0, revision: 1, bindingRevision: 0, kind: 'html', title: 'Overview', subtitle: '',
      preset: '', config: { html: '<p>x</p>', inputs: [], note: 'About this page.' },
      result: { trust: 'local_static_content', columns: ['html'], rows: [['html view']], rowCount: 1, displayedRowCount: 1, refreshedAt: '2026-10-10T00:00:00.000Z' },
    };
    expect(index([view])).toContain('loading="eager"></iframe><p class="note">About this page.</p></article>');
  });

  it('a changed note or label changes the publication hash', () => {
    const hash = (config: Record<string, unknown>) => renderDashboardBundle(dashboard({ widgets: [table(config)] } as any), '2026-10-10T01:00:00.000Z', { vendorDir }).manifestSha256;
    const base = hash({ note: 'One.', columnLabels: { wk: 'Week' } });
    expect(hash({ note: 'Two.', columnLabels: { wk: 'Week' } })).not.toBe(base);
    expect(hash({ note: 'One.', columnLabels: { wk: 'Week of' } })).not.toBe(base);
  });
});
