/**
 * Shared static-rendering primitives for published dashboard artifacts.
 *
 * Extracted from analytics-publisher.ts (2026-09-08, dashboard-sharing plan
 * §2) so the single-file snapshot and the interactive BUNDLE render widget
 * bodies from ONE implementation — the two artifacts must never disagree
 * about the same stored results.
 *
 * Everything here is pure string rendering over persisted widget results.
 * SQL, presets, credentials, and project identifiers are never rendered.
 */

import type { AnalyticsWidget } from './analytics-types.js';

export function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]!);
}

export function formatValue(value: unknown): string {
  if (value == null) return '<span class="null">null</span>';
  if (typeof value === 'number') return escapeHtml(value.toLocaleString());
  return escapeHtml(value);
}

function columnIndex(widget: AnalyticsWidget, configured: unknown, fallback: number): number {
  const columns = widget.result?.columns || [];
  const found = configured == null ? -1 : columns.indexOf(String(configured));
  return found >= 0 ? found : Math.min(fallback, Math.max(columns.length - 1, 0));
}

export function series(widget: AnalyticsWidget): Array<{ label: string; value: number }> {
  const result = widget.result;
  if (!result) return [];
  const labelIndex = columnIndex(widget, widget.config.labelColumn ?? widget.config.xColumn, 0);
  const valueIndex = columnIndex(widget, widget.config.valueColumn ?? widget.config.yColumn, 1);
  return result.rows.slice(0, 24).map(row => ({
    label: String(row[labelIndex] ?? ''),
    value: Number(row[valueIndex]),
  })).filter(point => Number.isFinite(point.value));
}

export function renderTable(widget: AnalyticsWidget): string {
  const result = widget.result!;
  if (!result.columns.length) return `<pre>${escapeHtml(result.rawPreview || 'No tabular data returned.')}</pre>`;
  return `<div class="table-wrap"><table><thead><tr>${result.columns.map(column => `<th>${escapeHtml(column)}</th>`).join('')}</tr></thead><tbody>${result.rows.map(row => `<tr>${result.columns.map((_, index) => `<td>${formatValue(row[index])}</td>`).join('')}</tr>`).join('')}</tbody></table></div>${result.rowCount > result.rows.length ? `<small>Showing ${result.rows.length.toLocaleString()} of ${result.rowCount.toLocaleString()} rows.</small>` : ''}`;
}

export function renderMetric(widget: AnalyticsWidget): string {
  const result = widget.result!;
  const index = columnIndex(widget, widget.config.valueColumn, 0);
  const value = result.rows[0]?.[index];
  const precision = Math.max(0, Math.min(8, Number(widget.config.precision ?? 0)));
  const formatted = typeof value === 'number'
    ? value.toLocaleString(undefined, { minimumFractionDigits: precision, maximumFractionDigits: precision })
    : String(value ?? '—');
  return `<div class="metric-value"><em>${escapeHtml(widget.config.prefix || '')}</em>${escapeHtml(formatted)}<em>${escapeHtml(widget.config.suffix || '')}</em></div><small>${result.rowCount.toLocaleString()} source row${result.rowCount === 1 ? '' : 's'}</small>`;
}

export function renderBars(widget: AnalyticsWidget): string {
  const points = series(widget);
  if (!points.length) return '<div class="empty">No numeric series available.</div>';
  const max = Math.max(...points.map(point => Math.abs(point.value)), 1);
  return `<div class="bars">${points.map(point => `<div class="bar"><span>${escapeHtml(point.label)}</span><i><b style="width:${Math.max(2, Math.abs(point.value) / max * 100).toFixed(2)}%"></b></i><strong>${escapeHtml(point.value.toLocaleString())}</strong></div>`).join('')}</div>`;
}

export function renderLine(widget: AnalyticsWidget): string {
  const points = series(widget);
  if (points.length < 2) return renderBars(widget);
  const width = 720;
  const height = 210;
  const inset = 14;
  const min = Math.min(...points.map(point => point.value));
  const max = Math.max(...points.map(point => point.value));
  const range = max - min || 1;
  const coordinates = points.map((point, index) => {
    const x = inset + index * (width - inset * 2) / Math.max(points.length - 1, 1);
    const y = height - inset - ((point.value - min) / range) * (height - inset * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  return `<div class="line"><svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img" aria-label="${escapeHtml(widget.title)} line chart"><polyline class="line-shadow" points="${coordinates}"/><polyline class="line-path" points="${coordinates}"/></svg><div><span>${escapeHtml(points[0].label)} · ${escapeHtml(points[0].value.toLocaleString())}</span><span>${escapeHtml(points.at(-1)!.label)} · ${escapeHtml(points.at(-1)!.value.toLocaleString())}</span></div></div>`;
}

export function renderTextBody(widget: AnalyticsWidget): string {
  return `<div class="text">${escapeHtml(widget.result?.rows[0]?.[0] ?? widget.config.text ?? '').replaceAll('\n', '<br>')}</div>`;
}

/**
 * Shared page styles for published artifacts. The single-file snapshot inlines
 * this; the bundle ships it as assets/style.css (Harmony CSP forbids inline).
 */
export const SNAPSHOT_CSS = `:root{color-scheme:dark;--bg:#09090b;--surface:#14141a;--surface2:#1a1a22;--border:rgba(255,255,255,.1);--text:#f4f4f5;--muted:#9797a2;--soft:#c9c9d1;--accent:#9d8cff;--accent-strong:#7c66f0;--blue:#6faef5;--green:#7fd6a4;--yellow:#f3ba63;--red:#f0777d;--border-strong:rgba(255,255,255,.16)}*{box-sizing:border-box}body{margin:0;color:var(--text);background:radial-gradient(circle at 80% -10%,rgba(157,140,255,.13),transparent 36%),var(--bg);font:14px/1.5 Inter,ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}main{width:min(1380px,100%);margin:auto;padding:48px 34px 72px}.snapshot{display:inline-flex;padding:5px 9px;border:1px solid rgba(157,140,255,.3);border-radius:999px;color:var(--accent);background:rgba(157,140,255,.1);font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.08em}h1{max-width:900px;margin:18px 0 8px;font-size:clamp(34px,5vw,64px);line-height:1.04;letter-spacing:-.055em}header>p{max-width:760px;color:var(--muted)}.meta{display:flex;flex-wrap:wrap;gap:9px 20px;margin:22px 0 31px;color:var(--muted);font-size:10px}.grid{display:grid;grid-template-columns:repeat(12,minmax(0,1fr));gap:16px}.widget{grid-column:span 6;overflow:hidden;border:1px solid var(--border);border-radius:18px;background:rgba(20,20,26,.97);box-shadow:0 20px 70px rgba(0,0,0,.16)}.widget.metric{grid-column:span 4;background:radial-gradient(circle at 90% 5%,rgba(157,140,255,.14),transparent 42%),var(--surface)}.widget.table,.widget.visualization{grid-column:span 12}.widget>header{display:flex;justify-content:space-between;gap:16px;padding:18px;border-bottom:1px solid var(--border)}.widget>header span{color:var(--accent);font-size:9px;font-weight:750;text-transform:uppercase;letter-spacing:.09em}.widget h2{margin:5px 0 0;font-size:15px}.widget header p{margin:4px 0 0;color:var(--muted);font-size:10px}.widget>section{min-height:145px;padding:19px}.widget>footer{padding:10px 18px;border-top:1px solid var(--border);color:var(--muted);background:var(--surface2);font-size:9px}.warn{height:fit-content;padding:3px 7px;border-radius:99px;color:#f3ba63;background:rgba(243,186,99,.12);font-size:9px}.error{margin:12px 16px 0;padding:9px;border:1px solid rgba(240,119,125,.25);border-radius:9px;color:var(--red);background:rgba(240,119,125,.08);font-size:9px}.metric-value{margin-top:18px;font-size:clamp(42px,6vw,72px);font-weight:780;line-height:1;letter-spacing:-.06em}.metric-value em{color:var(--accent);font-size:.38em;font-style:normal}.widget small{display:block;margin-top:13px;color:var(--muted);font-size:9px}.table-wrap{overflow:auto;border:1px solid var(--border);border-radius:10px}table{width:100%;border-collapse:collapse;font-size:11px}th,td{padding:9px 11px;border-bottom:1px solid var(--border);text-align:left;white-space:nowrap}th{color:var(--muted);background:var(--surface2);font-size:9px;text-transform:uppercase}tr:last-child td{border:0}.null{color:var(--muted);font-style:italic}.bars{display:grid;gap:10px}.bar{display:grid;grid-template-columns:minmax(70px,1fr) minmax(100px,3fr) auto;align-items:center;gap:10px;font-size:10px}.bar>span{overflow:hidden;color:var(--muted);text-overflow:ellipsis;white-space:nowrap}.bar i{height:8px;overflow:hidden;border-radius:99px;background:var(--surface2)}.bar b{display:block;height:100%;border-radius:inherit;background:linear-gradient(90deg,var(--accent),var(--blue))}.bar strong{min-width:48px;text-align:right}.line svg{width:100%;height:190px}.line-shadow,.line-path{fill:none;vector-effect:non-scaling-stroke}.line-shadow{stroke:rgba(157,140,255,.13);stroke-width:10}.line-path{stroke:var(--accent);stroke-width:2.5}.line>div{display:flex;justify-content:space-between;color:var(--muted);font-size:9px}.text{line-height:1.75}.empty{min-height:100px;display:grid;place-items:center;color:var(--muted);text-align:center}pre{overflow:auto;color:var(--muted);font:10px/1.55 ui-monospace,monospace;white-space:pre-wrap}.page-foot{margin-top:30px;padding-top:18px;border-top:1px solid var(--border);color:var(--muted);font-size:9px}.analytics-vega{min-height:280px;display:grid;align-content:start}.analytics-vega>span{padding:24px 0;color:var(--muted)}.analytics-vega.analytics-vega-error{place-items:center;color:var(--red);font-size:11px}.analytics-vega svg{max-width:100%}@media(max-width:900px){.widget,.widget.metric{grid-column:span 12}}@media(max-width:600px){main{padding:28px 16px 50px}.widget>section{padding:14px}.bar{grid-template-columns:60px 1fr auto}}`;
