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
const CONFIG_ALLOWLIST = ['spec', 'prefix', 'suffix', 'precision', 'text', 'labelColumn', 'valueColumn', 'xColumn', 'yColumn', 'key', 'hidden', 'inputs', 'span'] as const;

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

  // HTML view frames report their height; errors show under the frame.
  window.addEventListener('message', function (event) {
    var message = event.data;
    if (!message || message.botboyHtmlView !== 1) return;
    var frames = document.querySelectorAll('iframe.html-view-frame');
    Array.prototype.forEach.call(frames, function (frame) {
      if (frame.contentWindow !== event.source) return;
      if (message.type === 'height' && isFinite(message.height)) frame.style.height = Math.min(8000, Math.max(120, message.height + 4)) + 'px';
      if (message.type === 'error') {
        var note = frame.parentNode.querySelector('.html-view-error');
        if (!note) { note = document.createElement('div'); note.className = 'error html-view-error'; frame.parentNode.appendChild(note); }
        note.textContent = 'This view hit a script error: ' + String(message.message || '');
      }
    });
  });

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', hydrate);
  else hydrate();
})();
`;

// ── HTML views (kind=html) in a published bundle ──
// Harmony serves the bundle under `script-src 'self'; style-src 'self'
// 'nonce-…'` (header read live 2026-10-10). A view therefore ships as its own
// same-origin page, assets/view-<id>.html, framed by index.html:
//   - its inline <style>/<script> blocks become files beside it;
//   - its data (the same rows BotBoy hands it locally) is a data file;
//   - view-runtime.js provides window.botboy and copies style="" attributes
//     into the CSSOM (CSP blocks attribute styles, not CSSOM writes).
// Not sandboxed: a sandboxed (opaque-origin) frame would not carry the
// viewer's Harmony sign-in, so its own page and assets would not load.

const VIEW_RUNTIME_JS = `(function () {
  'use strict';
  var payload = window.BOTBOY_VIEW_DATA || { datasets: {}, theme: { mode: 'dark', colors: {} } };
  var listeners = [];
  function report(error) {
    try { parent.postMessage({ botboyHtmlView: 1, type: 'error', message: String(error && error.message || error).slice(0, 300) }, '*'); } catch (e) {}
  }
  window.addEventListener('error', function (event) { report(event.error || event.message); });
  window.addEventListener('unhandledrejection', function (event) { report(event.reason); });
  var api = {
    data: payload.datasets,
    theme: payload.theme,
    ready: Promise.resolve(payload.datasets),
    // Warnings show inside BotBoy; a shared copy accepts the calls quietly.
    warn: function () {},
    clearWarnings: function () {},
    onData: function (fn) {
      listeners.push(fn);
      Promise.resolve().then(function () { try { fn(api.data, api.theme); } catch (error) { report(error); } });
    },
  };
  window.botboy = api;
  var colors = payload.theme && payload.theme.colors || {};
  var root = document.documentElement;
  Object.keys(colors).forEach(function (name) { root.style.setProperty('--bb-' + name.replace(/([A-Z0-9])/g, '-$1').toLowerCase(), colors[name]); });
  root.dataset.theme = payload.theme && payload.theme.mode || 'dark';
  // style="" from markup or innerHTML: apply through the CSSOM.
  var applied = new WeakMap();
  function adopt(element) {
    var text = element.getAttribute('style');
    if (text == null || applied.get(element) === text) return;
    element.style.cssText = text;
    applied.set(element, element.getAttribute('style'));
  }
  function sweep(node) {
    if (!node || node.nodeType !== 1) return;
    if (node.hasAttribute('style')) adopt(node);
    var nested = node.querySelectorAll('[style]');
    for (var i = 0; i < nested.length; i++) adopt(nested[i]);
  }
  new MutationObserver(function (records) {
    records.forEach(function (record) {
      if (record.type === 'attributes') adopt(record.target);
      else Array.prototype.forEach.call(record.addedNodes, sweep);
    });
  }).observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ['style'] });
  function size() {
    var height = Math.ceil(Math.max(root.scrollHeight, document.body ? document.body.scrollHeight : 0));
    try { parent.postMessage({ botboyHtmlView: 1, type: 'height', height: height }, '*'); } catch (e) {}
  }
  document.addEventListener('DOMContentLoaded', function () { sweep(document.body); size(); });
  window.addEventListener('load', size);
  if (window.ResizeObserver) new ResizeObserver(size).observe(root);
})();
`;

const VIEW_BASE_CSS = `:root{--bb-bg:#09090b;--bb-surface:#14141a;--bb-surface-2:#1a1a22;--bb-text:#f4f4f5;--bb-soft:#c9c9d1;--bb-muted:#9797a2;--bb-accent:#9d8cff;--bb-border:rgba(255,255,255,.1);--bb-good:#7fd6a4;--bb-warn:#f3ba63;--bb-bad:#f0777d;--bb-blue:#6faef5;color-scheme:dark}
html,body{margin:0;background:transparent;color:var(--bb-text);font-family:Inter,ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;font-size:14px;line-height:1.45}
`;

/** The rows an html view reads, keyed like the live UI (config.key, else a title slug). */
function viewDatasets(dashboard: AnalyticsDashboard, inputs: unknown): Record<string, unknown> {
  const wanted = Array.isArray(inputs) && inputs.length ? new Set(inputs.map(String)) : null;
  const out: Record<string, unknown> = {};
  for (const widget of dashboard.widgets) {
    if (widget.kind === 'html' || widget.kind === 'text') continue;
    const key = typeof widget.config?.key === 'string' && widget.config.key
      ? widget.config.key
      : String(widget.title || widget.id).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 48);
    if (wanted && !wanted.has(key)) continue;
    const columns = (widget.result?.columns ?? []).map(String);
    const rows = widget.result?.rows ?? [];
    const source = widget.config?.dataSource as Record<string, unknown> | undefined;
    out[key] = {
      title: widget.title,
      subtitle: widget.subtitle ?? '',
      columns,
      rows: rows.map(row => Object.fromEntries(columns.map((column, index) => [column, (row as unknown[])?.[index] ?? null]))),
      rowCount: Number(widget.result?.rowCount ?? rows.length),
      shownRows: rows.length,
      refreshedAt: widget.result?.refreshedAt ?? null,
      error: widget.lastError ? 'The last refresh failed; these are the previous rows.' : null,
      source: source
        ? { kind: source.kind, datasetId: source.datasetId ?? null, versionId: (widget.result?.source as Record<string, unknown> | undefined)?.versionId ?? null }
        : widget.sql ? { kind: 'warehouse_sql' } : null,
    };
  }
  return out;
}

/** One html view as same-origin files: page, extracted styles/scripts, data. */
function renderHtmlViewFiles(dashboard: AnalyticsDashboard, widget: AnalyticsWidget): BundleFile[] {
  const base = `view-${widget.id}`;
  const files: BundleFile[] = [];
  let styleCount = 0;
  let scriptCount = 0;
  let body = String(widget.config?.html ?? '');
  body = body.replace(/<style\b[^>]*>([\s\S]*?)<\/style>/gi, (_whole, css: string) => {
    styleCount += 1;
    const name = `${base}-${styleCount}.css`;
    files.push({ path: `assets/${name}`, content: css });
    return `<link rel="stylesheet" href="${name}">`;
  });
  body = body.replace(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi, (whole, attrs: string, code: string) => {
    if (/\bsrc\s*=/i.test(attrs)) return ''; // only BotBoy's own runtime scripts load
    const type = attrs.match(/\btype\s*=\s*(["'])(.*?)\1/i)?.[2]?.toLowerCase() ?? '';
    if (type && !['text/javascript', 'application/javascript', 'module'].includes(type)) return whole;
    scriptCount += 1;
    const name = `${base}-${scriptCount}.js`;
    files.push({ path: `assets/${name}`, content: code });
    return `<script${type === 'module' ? ' type="module"' : ''} src="${name}"></script>`;
  });
  // The shared snapshot is dark (snapshot-render.ts › SNAPSHOT_CSS); views match it.
  const data = { datasets: viewDatasets(dashboard, widget.config?.inputs), theme: { mode: 'dark', colors: {} } };
  const json = JSON.stringify(data).replace(/</g, '\\u003c').replace(/-->/g, '--\\u003e');
  files.push({ path: `assets/${base}-data.js`, content: `window.BOTBOY_VIEW_DATA = ${json};\n` });
  const page = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self'; style-src 'self'; img-src data: blob:; font-src data:; connect-src 'none'; base-uri 'none'; form-action 'none'"><title>${escapeHtml(widget.title)}</title><link rel="stylesheet" href="view-base.css"><script src="${base}-data.js"></script><script src="view-runtime.js"></script><script src="vega.min.js"></script><script src="vega-lite.min.js"></script><script src="vega-embed.min.js"></script><script src="vega-interpreter.js"></script></head><body>${body}</body></html>`;
  files.push({ path: `assets/${base}.html`, content: page });
  return files;
}

function renderWidgetShell(widget: AnalyticsWidget): string {
  let body = '<div class="empty">No successful result was available when this snapshot was created.</div>';
  if (widget.result) {
    if (widget.kind === 'metric') body = renderMetric(widget);
    if (widget.kind === 'table') body = renderTable(widget);
    if (widget.kind === 'bar') body = renderBars(widget);
    if (widget.kind === 'line') body = renderLine(widget);
    if (widget.kind === 'text') body = renderTextBody(widget);
    // A model-designed page: its own same-origin file, framed here.
    if (widget.kind === 'html') {
      return `<article class="widget html-view"><iframe class="html-view-frame" src="assets/view-${escapeHtml(widget.id)}.html" title="${escapeHtml(widget.title)}" loading="eager"></iframe></article>`;
    }
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
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self'; style-src 'self'; img-src data:; frame-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"><title>${escapeHtml(dashboard.title)}</title><link rel="stylesheet" href="assets/style.css"></head><body><main><header><span class="snapshot">Shared dashboard</span><h1>${escapeHtml(dashboard.title)}</h1>${dashboard.description ? `<p>${escapeHtml(dashboard.description)}</p>` : ''}<div class="meta"><span>Data refreshed: ${escapeHtml(refreshed)}</span><span>Published: ${escapeHtml(new Date(snapshotCreatedAt).toLocaleString())}</span><span>${dashboard.widgets.filter(widget => widget.config?.hidden !== true).length.toLocaleString()} widgets</span></div></header><section class="grid">${dashboard.widgets.filter(widget => widget.config?.hidden !== true).map(renderWidgetShell).join('')}</section>${dashboard.widgets.some(widget => widget.config?.hidden === true) ? `<details class="hidden-data"><summary>Data behind this dashboard</summary><section class="grid">${dashboard.widgets.filter(widget => widget.config?.hidden === true).map(renderWidgetShell).join('')}</section></details>` : ''}<footer class="page-foot">Published by BotBoy from a local canonical dashboard. This copy updates only when republished. Query text, credentials, connection settings, and project identifiers are not included.</footer></main><script src="assets/vega.min.js"></script><script src="assets/vega-lite.min.js"></script><script src="assets/vega-embed.min.js"></script><script src="assets/vega-interpreter.js"></script><script src="assets/data.js"></script><script src="assets/render.js"></script></body></html>`;
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
  const views = dashboard.widgets.filter(widget => widget.kind === 'html');
  if (views.length) {
    files.push({ path: 'assets/view-runtime.js', content: VIEW_RUNTIME_JS }, { path: 'assets/view-base.css', content: VIEW_BASE_CSS });
    for (const view of views) files.push(...renderHtmlViewFiles(dashboard, view));
  }
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
