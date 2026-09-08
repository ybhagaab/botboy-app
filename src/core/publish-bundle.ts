/**
 * Interactive dashboard bundle — the sharing artifact (DASHBOARD_SHARING_PLAN §2).
 *
 * One directory per dashboard, hostable on any static provider:
 *
 *   index.html        document-flow page, NO inline script, NO inline style
 *   assets/style.css  shared snapshot styles (snapshot-render.ts)
 *   assets/data.js    window.BOTBOY_DASHBOARD = {…persisted widget results}
 *   assets/render.js  hydrates Vega charts from data.js (static, hand-written)
 *   assets/vega*.js   vendored Vega runtime (same files the app UI ships)
 *
 * Why external files: Harmony's CSP blocks inline JavaScript. The page also
 * carries its own strict CSP meta (script/style from 'self' only), so the
 * artifact is exactly as safe on S3/SFTP as it is on Harmony.
 *
 * Trust boundary (same as the single-file snapshot): persisted RESULTS only.
 * SQL, presets, credentials, connection settings, and project identifiers
 * are never included. Widget config passes through a hard allowlist.
 *
 * Vega widgets get REAL interactive charts (the PDF probe's table
 * degradation is what got that route rejected). No-JS viewers see the exact
 * persisted rows via a <noscript> table fallback.
 */

import fs from 'fs';
import path from 'path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'url';
import type { AnalyticsDashboard, AnalyticsWidget } from './analytics-types.js';
import {
  escapeHtml,
  renderBars,
  renderLine,
  renderMetric,
  renderTable,
  renderTextBody,
  SNAPSHOT_CSS,
} from './snapshot-render.js';

export interface BundleFile {
  /** Relative path inside the bundle, always forward-slash. */
  path: string;
  content: string | Buffer;
}

export interface DashboardBundle {
  files: BundleFile[];
  /** sha256 over the sorted (path, contentSha) manifest — the publish token binds this. */
  manifestSha256: string;
}

const VENDOR_FILES = ['vega.min.js', 'vega-lite.min.js', 'vega-embed.min.js', 'vega-interpreter.js'] as const;

/** Widget config keys that may travel into the artifact. Everything else is dropped. */
const CONFIG_ALLOWLIST = ['spec', 'prefix', 'suffix', 'precision', 'text', 'labelColumn', 'valueColumn', 'xColumn', 'yColumn'] as const;

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Default vendor dir: dist/core/publish-bundle.js → dist/ui/vendor (the served runtime copy). */
function defaultVendorDir(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'ui', 'vendor');
}

function sanitizedConfig(widget: AnalyticsWidget): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of CONFIG_ALLOWLIST) {
    if (widget.config?.[key] !== undefined) out[key] = widget.config[key];
  }
  return out;
}

function dataPayload(dashboard: AnalyticsDashboard, snapshotCreatedAt: string): string {
  const payload = {
    title: dashboard.title,
    description: dashboard.description ?? '',
    lastRefreshedAt: dashboard.lastRefreshedAt ?? null,
    snapshotCreatedAt,
    widgets: dashboard.widgets.map(widget => ({
      id: widget.id,
      kind: widget.kind,
      title: widget.title,
      subtitle: widget.subtitle ?? '',
      config: sanitizedConfig(widget),
      lastError: widget.lastError ? true : undefined, // boolean only — error text may quote SQL
      result: widget.result
        ? {
            columns: widget.result.columns,
            rows: widget.result.rows,
            rowCount: widget.result.rowCount,
            refreshedAt: widget.result.refreshedAt,
          }
        : null,
    })),
  };
  // </script> and HTML-comment sequences must not terminate the script block.
  const json = JSON.stringify(payload).replace(/</g, '\\u003c').replace(/-->/g, '--\\u003e');
  return `window.BOTBOY_DASHBOARD = ${json};\n`;
}

/**
 * Static hydration script. Mirrors the app's live Vega path
 * (dashboard.js › hydrateAnalyticsVisualizations + analyticsVegaConfig +
 * materializeAnalyticsContainerWidths — chart-fix invariants included):
 * data.values from persisted rows, app palette theme, container widths
 * materialized from the real card width, svg renderer with tooltips.
 */
const RENDER_JS = `(function () {
  'use strict';
  var data = window.BOTBOY_DASHBOARD;
  if (!data || !Array.isArray(data.widgets)) return;

  function rowsToObjects(result) {
    var columns = (result && result.columns || []).map(String);
    return (result && result.rows || []).map(function (row) {
      var out = {};
      columns.forEach(function (column, index) { out[column] = row && row[index] !== undefined ? row[index] : null; });
      return out;
    });
  }

  function cssVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  function themeConfig(authored) {
    var font = 'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    var base = {
      background: 'transparent',
      font: font,
      view: { stroke: 'transparent' },
      range: {
        category: [cssVar('--accent'), cssVar('--blue'), cssVar('--green'), cssVar('--yellow'), cssVar('--red'), cssVar('--accent-strong'), cssVar('--soft')].filter(Boolean),
        heatmap: { scheme: 'purples' },
      },
      axis: { labelColor: cssVar('--muted'), titleColor: cssVar('--soft'), domainColor: cssVar('--border-strong'), gridColor: cssVar('--border'), tickColor: cssVar('--border-strong'), labelFont: font, titleFont: font, labelFontSize: 11, titleFontSize: 11, titleFontWeight: 600, gridDash: [2, 3] },
      legend: { labelColor: cssVar('--muted'), titleColor: cssVar('--soft'), labelFont: font, titleFont: font, labelFontSize: 11, titleFontSize: 11 },
      title: { color: cssVar('--text'), subtitleColor: cssVar('--muted'), font: font, fontSize: 13, fontWeight: 650 },
      line: { strokeWidth: 2.5 },
      bar: { cornerRadiusEnd: 3 },
      point: { filled: true, size: 55 },
    };
    var out = {};
    Object.keys(base).forEach(function (key) { out[key] = base[key]; });
    if (authored && typeof authored === 'object' && !Array.isArray(authored)) {
      Object.keys(authored).forEach(function (key) {
        var section = authored[key];
        if (section && typeof section === 'object' && !Array.isArray(section) && base[key] && typeof base[key] === 'object') {
          var merged = {};
          Object.keys(base[key]).forEach(function (k) { merged[k] = base[key][k]; });
          Object.keys(section).forEach(function (k) { merged[k] = section[k]; });
          out[key] = merged;
        } else {
          out[key] = section;
        }
      });
    }
    return out;
  }

  function materializeWidths(value, plotWidth) {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) { value.forEach(function (entry) { materializeWidths(entry, plotWidth); }); return; }
    Object.keys(value).forEach(function (key) {
      if (key === 'width' && value[key] === 'container') value[key] = plotWidth;
      else materializeWidths(value[key], plotWidth);
    });
  }

  function hydrate() {
    var widgets = {};
    data.widgets.forEach(function (widget) { widgets[widget.id] = widget; });
    var containers = document.querySelectorAll('[data-analytics-visualization]');
    Array.prototype.forEach.call(containers, function (container) {
      var widget = widgets[container.getAttribute('data-analytics-visualization')];
      if (!widget || !widget.result || !widget.config || !widget.config.spec) return;
      try {
        if (typeof window.vegaEmbed !== 'function') throw new Error('Vega runtime failed to load');
        var spec = JSON.parse(JSON.stringify(widget.config.spec));
        spec.data = { values: rowsToObjects(widget.result) };
        spec.config = themeConfig(spec.config);
        if ((spec.mark || spec.layer) && spec.width == null) spec.width = 'container';
        if ((spec.mark || spec.layer) && spec.height == null) spec.height = 320;
        var hasView = spec.mark || spec.layer || spec.concat || spec.vconcat || spec.hconcat || spec.repeat || spec.facet;
        var measured = Math.floor(container.getBoundingClientRect().width || (container.parentElement ? container.parentElement.getBoundingClientRect().width : 0) || 0);
        var plotWidth = Math.max(640, measured - 96);
        materializeWidths(spec, plotWidth);
        if (hasView) spec.autosize = { type: 'pad', contains: 'padding', resize: false };
        while (container.firstChild) container.removeChild(container.firstChild);
        // ast + expressionInterpreter: Vega's default expression compiler
        // uses eval, which Harmony's CSP (and our own strict meta CSP)
        // blocks — live-fire verbatim error 2026-09-09. The interpreter
        // walks the AST instead; no eval anywhere.
        window.vegaEmbed(container, spec, { actions: false, renderer: 'svg', tooltip: true, ast: true, expr: window.vega && window.vega.expressionInterpreter }).catch(function (error) {
          container.classList.add('analytics-vega-error');
          container.textContent = 'Visualization could not render: ' + (error && error.message ? error.message : error);
        });
      } catch (error) {
        container.classList.add('analytics-vega-error');
        container.textContent = 'Visualization could not render: ' + (error && error.message ? error.message : error);
      }
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', hydrate);
  else hydrate();
})();
`;

function renderWidgetShell(widget: AnalyticsWidget): string {
  let body = '<div class="empty">No successful result was available when this snapshot was created.</div>';
  if (widget.result) {
    if (widget.kind === 'metric') body = renderMetric(widget);
    if (widget.kind === 'table') body = renderTable(widget);
    if (widget.kind === 'bar') body = renderBars(widget);
    if (widget.kind === 'line') body = renderLine(widget);
    if (widget.kind === 'text') body = renderTextBody(widget);
    if (widget.kind === 'visualization') {
      // Interactive chart hydrated by assets/render.js; the exact persisted
      // rows remain readable without JavaScript.
      body = `<div class="analytics-vega" data-analytics-visualization="${escapeHtml(widget.id)}" role="img" aria-label="${escapeHtml(widget.title)}"><span>Loading interactive chart…</span></div><noscript>${renderTable(widget)}</noscript>`;
    }
  }
  return `<article class="widget ${escapeHtml(widget.kind)}"><header><div><span>${escapeHtml(widget.kind)}</span><h2>${escapeHtml(widget.title)}</h2>${widget.subtitle ? `<p>${escapeHtml(widget.subtitle)}</p>` : ''}</div>${widget.lastError ? '<b class="warn">Stale</b>' : ''}</header><section>${body}</section><footer>${widget.result ? `Updated ${escapeHtml(new Date(widget.result.refreshedAt).toLocaleString())}` : 'Not refreshed'} · external analytical data</footer></article>`;
}

function renderIndexHtml(dashboard: AnalyticsDashboard, snapshotCreatedAt: string): string {
  const refreshed = dashboard.lastRefreshedAt ? new Date(dashboard.lastRefreshedAt).toLocaleString() : 'Not refreshed';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self'; style-src 'self'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"><title>${escapeHtml(dashboard.title)}</title><link rel="stylesheet" href="assets/style.css"></head><body><main><header><span class="snapshot">Shared dashboard</span><h1>${escapeHtml(dashboard.title)}</h1>${dashboard.description ? `<p>${escapeHtml(dashboard.description)}</p>` : ''}<div class="meta"><span>Data refreshed: ${escapeHtml(refreshed)}</span><span>Published: ${escapeHtml(new Date(snapshotCreatedAt).toLocaleString())}</span><span>${dashboard.widgets.length.toLocaleString()} widgets</span></div></header><section class="grid">${dashboard.widgets.map(renderWidgetShell).join('')}</section><footer class="page-foot">Published by BotBoy from a local canonical dashboard. This copy updates only when republished. Query text, credentials, connection settings, and project identifiers are not included.</footer></main><script src="assets/vega.min.js"></script><script src="assets/vega-lite.min.js"></script><script src="assets/vega-embed.min.js"></script><script src="assets/vega-interpreter.js"></script><script src="assets/data.js"></script><script src="assets/render.js"></script></body></html>`;
}

/**
 * Build the complete bundle in memory. Vendored Vega files are read from the
 * served UI runtime (dist/ui/vendor) unless a vendorDir is injected (tests).
 * Throws when the Vega runtime is missing — a bundle without charts must
 * never publish silently.
 */
export function renderDashboardBundle(
  dashboard: AnalyticsDashboard,
  snapshotCreatedAt: string,
  options?: { vendorDir?: string },
): DashboardBundle {
  const vendorDir = options?.vendorDir ?? defaultVendorDir();
  const files: BundleFile[] = [
    { path: 'index.html', content: renderIndexHtml(dashboard, snapshotCreatedAt) },
    { path: 'assets/style.css', content: SNAPSHOT_CSS },
    { path: 'assets/data.js', content: dataPayload(dashboard, snapshotCreatedAt) },
    { path: 'assets/render.js', content: RENDER_JS },
  ];
  for (const name of VENDOR_FILES) {
    const filePath = path.join(vendorDir, name);
    if (!fs.existsSync(filePath)) {
      throw new Error(`Vega runtime file missing: ${filePath} — rebuild UI assets before publishing`);
    }
    files.push({ path: `assets/${name}`, content: fs.readFileSync(filePath) });
  }
  const manifest = files
    .map(file => ({ path: file.path, sha: sha256(typeof file.content === 'string' ? Buffer.from(file.content, 'utf8') : file.content) }))
    .sort((a, b) => a.path.localeCompare(b.path));
  return { files, manifestSha256: sha256(JSON.stringify(manifest)) };
}

/** Write a bundle into a directory (used by provider adapters' staging step). */
export function writeBundle(bundle: DashboardBundle, targetDir: string): void {
  for (const file of bundle.files) {
    const filePath = path.join(targetDir, ...file.path.split('/'));
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, file.content);
  }
}
