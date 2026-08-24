import Database from 'better-sqlite3';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { fromIni } from '@aws-sdk/credential-providers';
import type {
  AnalyticsDashboard,
  AnalyticsPublication,
  AnalyticsWidget,
  DashboardPublisherConfig,
  DashboardPublisherService,
  DashboardShareRequest,
  UpdateDashboardPublisherInput,
  AnalyticsDashboardService,
} from './analytics-types.js';

interface StoredPublisherConfig {
  bucket?: string;
  prefix?: string;
  region?: string;
  awsProfile?: string;
  cloudFrontBaseUrl?: string;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function clean(value: unknown, label: string, max: number, required = false): string {
  if (value == null) {
    if (required) throw new Error(`${label} is required`);
    return '';
  }
  if (typeof value !== 'string') throw new Error(`${label} must be a string`);
  const result = value.trim();
  if (required && !result) throw new Error(`${label} is required`);
  if (result.length > max) throw new Error(`${label} exceeds ${max} characters`);
  return result;
}

function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try { return JSON.parse(raw) as T; } catch { return fallback; }
}

function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]!);
}

function formatValue(value: unknown): string {
  if (value == null) return '<span class="null">null</span>';
  if (typeof value === 'number') return escapeHtml(value.toLocaleString());
  return escapeHtml(value);
}

function columnIndex(widget: AnalyticsWidget, configured: unknown, fallback: number): number {
  const columns = widget.result?.columns || [];
  const found = configured == null ? -1 : columns.indexOf(String(configured));
  return found >= 0 ? found : Math.min(fallback, Math.max(columns.length - 1, 0));
}

function series(widget: AnalyticsWidget): Array<{ label: string; value: number }> {
  const result = widget.result;
  if (!result) return [];
  const labelIndex = columnIndex(widget, widget.config.labelColumn ?? widget.config.xColumn, 0);
  const valueIndex = columnIndex(widget, widget.config.valueColumn ?? widget.config.yColumn, 1);
  return result.rows.slice(0, 24).map(row => ({
    label: String(row[labelIndex] ?? ''),
    value: Number(row[valueIndex]),
  })).filter(point => Number.isFinite(point.value));
}

function renderTable(widget: AnalyticsWidget): string {
  const result = widget.result!;
  if (!result.columns.length) return `<pre>${escapeHtml(result.rawPreview || 'No tabular data returned.')}</pre>`;
  return `<div class="table-wrap"><table><thead><tr>${result.columns.map(column => `<th>${escapeHtml(column)}</th>`).join('')}</tr></thead><tbody>${result.rows.map(row => `<tr>${result.columns.map((_, index) => `<td>${formatValue(row[index])}</td>`).join('')}</tr>`).join('')}</tbody></table></div>${result.rowCount > result.rows.length ? `<small>Showing ${result.rows.length.toLocaleString()} of ${result.rowCount.toLocaleString()} rows.</small>` : ''}`;
}

function renderMetric(widget: AnalyticsWidget): string {
  const result = widget.result!;
  const index = columnIndex(widget, widget.config.valueColumn, 0);
  const value = result.rows[0]?.[index];
  const precision = Math.max(0, Math.min(8, Number(widget.config.precision ?? 0)));
  const formatted = typeof value === 'number'
    ? value.toLocaleString(undefined, { minimumFractionDigits: precision, maximumFractionDigits: precision })
    : String(value ?? '—');
  return `<div class="metric-value"><em>${escapeHtml(widget.config.prefix || '')}</em>${escapeHtml(formatted)}<em>${escapeHtml(widget.config.suffix || '')}</em></div><small>${result.rowCount.toLocaleString()} source row${result.rowCount === 1 ? '' : 's'}</small>`;
}

function renderBars(widget: AnalyticsWidget): string {
  const points = series(widget);
  if (!points.length) return '<div class="empty">No numeric series available.</div>';
  const max = Math.max(...points.map(point => Math.abs(point.value)), 1);
  return `<div class="bars">${points.map(point => `<div class="bar"><span>${escapeHtml(point.label)}</span><i><b style="width:${Math.max(2, Math.abs(point.value) / max * 100).toFixed(2)}%"></b></i><strong>${escapeHtml(point.value.toLocaleString())}</strong></div>`).join('')}</div>`;
}

function renderLine(widget: AnalyticsWidget): string {
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

function renderWidget(widget: AnalyticsWidget): string {
  let body = '<div class="empty">No successful result was available when this snapshot was created.</div>';
  if (widget.result) {
    if (widget.kind === 'metric') body = renderMetric(widget);
    if (widget.kind === 'table') body = renderTable(widget);
    if (widget.kind === 'bar') body = renderBars(widget);
    if (widget.kind === 'line') body = renderLine(widget);
    // Published snapshots stay self-contained and script-free. Interactive
    // Vega widgets therefore degrade to their exact persisted rows.
    if (widget.kind === 'visualization') body = renderTable(widget);
    if (widget.kind === 'text') body = `<div class="text">${escapeHtml(widget.result.rows[0]?.[0] ?? widget.config.text ?? '').replaceAll('\n', '<br>')}</div>`;
  }
  return `<article class="widget ${escapeHtml(widget.kind)}"><header><div><span>${escapeHtml(widget.kind)}</span><h2>${escapeHtml(widget.title)}</h2>${widget.subtitle ? `<p>${escapeHtml(widget.subtitle)}</p>` : ''}</div>${widget.lastError ? '<b class="warn">Stale</b>' : ''}</header>${widget.lastError ? `<div class="error">Latest refresh error: ${escapeHtml(widget.lastError)}${widget.result ? ' · showing the previous successful result' : ''}</div>` : ''}<section>${body}</section><footer>${widget.result ? `Updated ${escapeHtml(new Date(widget.result.refreshedAt).toLocaleString())}` : 'Not refreshed'} · external analytical data</footer></article>`;
}

/** A self-contained, script-free snapshot. SQL and connection configuration are intentionally omitted. */
export function renderDashboardSnapshot(dashboard: AnalyticsDashboard, snapshotCreatedAt: string): string {
  const refreshed = dashboard.lastRefreshedAt ? new Date(dashboard.lastRefreshedAt).toLocaleString() : 'Not refreshed';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"><title>${escapeHtml(dashboard.title)}</title><style>
:root{color-scheme:dark;--bg:#09090b;--surface:#14141a;--surface2:#1a1a22;--border:rgba(255,255,255,.1);--text:#f4f4f5;--muted:#9797a2;--accent:#9d8cff;--blue:#6faef5;--red:#f0777d}*{box-sizing:border-box}body{margin:0;color:var(--text);background:radial-gradient(circle at 80% -10%,rgba(157,140,255,.13),transparent 36%),var(--bg);font:14px/1.5 Inter,ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}main{width:min(1380px,100%);margin:auto;padding:48px 34px 72px}.snapshot{display:inline-flex;padding:5px 9px;border:1px solid rgba(157,140,255,.3);border-radius:999px;color:var(--accent);background:rgba(157,140,255,.1);font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.08em}h1{max-width:900px;margin:18px 0 8px;font-size:clamp(34px,5vw,64px);line-height:1.04;letter-spacing:-.055em}header>p{max-width:760px;color:var(--muted)}.meta{display:flex;flex-wrap:wrap;gap:9px 20px;margin:22px 0 31px;color:var(--muted);font-size:10px}.grid{display:grid;grid-template-columns:repeat(12,minmax(0,1fr));gap:16px}.widget{grid-column:span 6;overflow:hidden;border:1px solid var(--border);border-radius:18px;background:rgba(20,20,26,.97);box-shadow:0 20px 70px rgba(0,0,0,.16)}.widget.metric{grid-column:span 4;background:radial-gradient(circle at 90% 5%,rgba(157,140,255,.14),transparent 42%),var(--surface)}.widget.table,.widget.visualization{grid-column:span 12}.widget>header{display:flex;justify-content:space-between;gap:16px;padding:18px;border-bottom:1px solid var(--border)}.widget>header span{color:var(--accent);font-size:9px;font-weight:750;text-transform:uppercase;letter-spacing:.09em}.widget h2{margin:5px 0 0;font-size:15px}.widget header p{margin:4px 0 0;color:var(--muted);font-size:10px}.widget>section{min-height:145px;padding:19px}.widget>footer{padding:10px 18px;border-top:1px solid var(--border);color:var(--muted);background:var(--surface2);font-size:9px}.warn{height:fit-content;padding:3px 7px;border-radius:99px;color:#f3ba63;background:rgba(243,186,99,.12);font-size:9px}.error{margin:12px 16px 0;padding:9px;border:1px solid rgba(240,119,125,.25);border-radius:9px;color:var(--red);background:rgba(240,119,125,.08);font-size:9px}.metric-value{margin-top:18px;font-size:clamp(42px,6vw,72px);font-weight:780;line-height:1;letter-spacing:-.06em}.metric-value em{color:var(--accent);font-size:.38em;font-style:normal}.widget small{display:block;margin-top:13px;color:var(--muted);font-size:9px}.table-wrap{overflow:auto;border:1px solid var(--border);border-radius:10px}table{width:100%;border-collapse:collapse;font-size:11px}th,td{padding:9px 11px;border-bottom:1px solid var(--border);text-align:left;white-space:nowrap}th{color:var(--muted);background:var(--surface2);font-size:9px;text-transform:uppercase}tr:last-child td{border:0}.null{color:var(--muted);font-style:italic}.bars{display:grid;gap:10px}.bar{display:grid;grid-template-columns:minmax(70px,1fr) minmax(100px,3fr) auto;align-items:center;gap:10px;font-size:10px}.bar>span{overflow:hidden;color:var(--muted);text-overflow:ellipsis;white-space:nowrap}.bar i{height:8px;overflow:hidden;border-radius:99px;background:var(--surface2)}.bar b{display:block;height:100%;border-radius:inherit;background:linear-gradient(90deg,var(--accent),var(--blue))}.bar strong{min-width:48px;text-align:right}.line svg{width:100%;height:190px}.line-shadow,.line-path{fill:none;vector-effect:non-scaling-stroke}.line-shadow{stroke:rgba(157,140,255,.13);stroke-width:10}.line-path{stroke:var(--accent);stroke-width:2.5}.line>div{display:flex;justify-content:space-between;color:var(--muted);font-size:9px}.text{line-height:1.75}.empty{min-height:100px;display:grid;place-items:center;color:var(--muted);text-align:center}pre{overflow:auto;color:var(--muted);font:10px/1.55 ui-monospace,monospace;white-space:pre-wrap}.page-foot{margin-top:30px;padding-top:18px;border-top:1px solid var(--border);color:var(--muted);font-size:9px}@media(max-width:900px){.widget,.widget.metric{grid-column:span 12}}@media(max-width:600px){main{padding:28px 16px 50px}.widget>section{padding:14px}.bar{grid-template-columns:60px 1fr auto}}
</style></head><body><main><header><span class="snapshot">Shared snapshot</span><h1>${escapeHtml(dashboard.title)}</h1>${dashboard.description ? `<p>${escapeHtml(dashboard.description)}</p>` : ''}<div class="meta"><span>Data refreshed: ${escapeHtml(refreshed)}</span><span>Snapshot created: ${escapeHtml(new Date(snapshotCreatedAt).toLocaleString())}</span><span>${dashboard.widgets.length.toLocaleString()} widgets</span></div></header><section class="grid">${dashboard.widgets.map(renderWidget).join('')}</section><footer class="page-foot">Published by BotBoy from a local canonical dashboard. This is a fixed copy and does not update automatically. Query text, credentials, connection settings, and project identifiers are not included.</footer></main></body></html>`;
}

function normalizeConfig(input: UpdateDashboardPublisherInput | StoredPublisherConfig, enabled: boolean): StoredPublisherConfig {
  const bucket = clean(input.bucket, 'bucket', 63);
  const prefix = clean(input.prefix || 'botboy-dashboards', 'prefix', 300).replace(/^\/+|\/+$/g, '');
  const region = clean(input.region || 'us-east-1', 'region', 64);
  const awsProfile = clean(input.awsProfile, 'awsProfile', 128);
  const cloudFrontBaseUrl = clean(input.cloudFrontBaseUrl, 'cloudFrontBaseUrl', 500);
  if (bucket && (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket) || /\.\.|^\d+\.\d+\.\d+\.\d+$/.test(bucket))) {
    throw new Error('bucket is not a valid S3 bucket name');
  }
  if (prefix.includes('..')) throw new Error('prefix cannot contain .. path segments');
  if (region && !/^[a-z]{2}(?:-gov)?-[a-z0-9-]+-\d$/.test(region)) throw new Error('region is invalid');
  if (cloudFrontBaseUrl) {
    let url: URL;
    try { url = new URL(cloudFrontBaseUrl); } catch { throw new Error('cloudFrontBaseUrl must be a valid HTTPS URL'); }
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
      throw new Error('cloudFrontBaseUrl must be an HTTPS URL without credentials, query, or fragment');
    }
  }
  if (enabled && (!bucket || !region || !awsProfile || !cloudFrontBaseUrl)) {
    throw new Error('Enabled publishing requires bucket, region, a least-privilege AWS profile, and CloudFront base URL');
  }
  return { bucket, prefix, region, awsProfile, cloudFrontBaseUrl: cloudFrontBaseUrl.replace(/\/+$/, '') };
}

function objectUrl(baseUrl: string, objectKey: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/${objectKey.split('/').map(encodeURIComponent).join('/')}`;
}

function mapPublication(row: any): AnalyticsPublication {
  return {
    id: row.id,
    dashboardId: row.dashboard_id,
    publisherId: row.publisher_id,
    objectKey: row.object_key,
    url: row.url || undefined,
    status: row.status,
    contentSha256: row.content_sha256,
    error: row.error || undefined,
    createdAt: row.created_at,
    publishedAt: row.published_at || undefined,
  };
}

export function createDashboardPublisherService(options: {
  db: Database.Database;
  analyticsService: AnalyticsDashboardService;
}): DashboardPublisherService {
  const db = options.db;
  const analyticsService = options.analyticsService;

  function publisherRow(): any {
    return db.prepare("SELECT * FROM dashboard_publishers WHERE id = 's3-cloudfront'").get();
  }

  function getConfig(): DashboardPublisherConfig {
    const row = publisherRow();
    if (!row) throw new Error('S3/CloudFront publisher is unavailable');
    const stored = normalizeConfig(parseJson<StoredPublisherConfig>(row.config_json, {}), false);
    const configured = Boolean(stored.bucket && stored.region && stored.awsProfile && stored.cloudFrontBaseUrl);
    return {
      id: 's3-cloudfront',
      displayName: row.display_name,
      enabled: row.enabled === 1,
      configured,
      bucket: stored.bucket || '',
      prefix: stored.prefix || 'botboy-dashboards',
      region: stored.region || 'us-east-1',
      awsProfile: stored.awsProfile || '',
      cloudFrontBaseUrl: stored.cloudFrontBaseUrl || '',
      lastError: row.last_error || undefined,
      updatedAt: row.updated_at,
    };
  }

  function updateConfig(input: UpdateDashboardPublisherInput): DashboardPublisherConfig {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Publisher input must be an object');
    if (typeof input.enabled !== 'boolean') throw new Error('enabled must be a boolean');
    const config = normalizeConfig(input, input.enabled);
    db.prepare(`
      UPDATE dashboard_publishers SET enabled = ?, config_json = ?, last_error = NULL,
        updated_at = datetime('now') WHERE id = 's3-cloudfront'
    `).run(input.enabled ? 1 : 0, JSON.stringify(config));
    return getConfig();
  }

  function requireReadyConfig(): DashboardPublisherConfig {
    const config = getConfig();
    if (!config.enabled || !config.configured) throw new Error('Dashboard sharing is not enabled and fully configured');
    return config;
  }

  function configHash(config: DashboardPublisherConfig): string {
    return sha256(JSON.stringify({
      bucket: config.bucket,
      prefix: config.prefix,
      region: config.region,
      awsProfile: config.awsProfile,
      cloudFrontBaseUrl: config.cloudFrontBaseUrl,
    }));
  }

  function createShareRequest(dashboardId: string): DashboardShareRequest {
    const dashboard = analyticsService.getDashboard(clean(dashboardId, 'dashboardId', 128, true));
    if (!dashboard) throw new Error(`Dashboard ${dashboardId} not found`);
    if (dashboard.status === 'refreshing' || dashboard.recentRuns.some(run => run.status === 'queued' || run.status === 'running')) {
      throw new Error('Wait for the current dashboard refresh to finish before sharing a snapshot');
    }
    const config = requireReadyConfig();
    const requestId = `share_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
    const createdAt = new Date().toISOString();
    const expiresAt = new Date(Date.now() + 5 * 60_000).toISOString();
    const html = renderDashboardSnapshot(dashboard, createdAt);
    const contentSha256 = sha256(html);
    const currentConfigHash = configHash(config);
    const confirmationToken = `${randomBytes(32).toString('base64url')}.${requestId}.${contentSha256}.${currentConfigHash}`;
    const objectKey = `${config.prefix || 'botboy-dashboards'}/${dashboard.id}/snapshot-${requestId.slice(6)}.html`;
    db.transaction(() => {
      db.prepare("DELETE FROM dashboard_share_requests WHERE datetime(expires_at) <= datetime('now') OR used_at IS NOT NULL").run();
      db.prepare(`
        INSERT INTO dashboard_share_requests (id, dashboard_id, token_sha256, expires_at, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(requestId, dashboard.id, sha256(confirmationToken), expiresAt, createdAt);
    })();
    return {
      dashboardId: dashboard.id,
      confirmationToken,
      expiresAt,
      destination: `s3://${config.bucket}/${objectKey} via AWS profile ${config.awsProfile}`,
      objectKey,
      contentSha256,
      warning: 'Confirming performs one S3 PutObject in the configured AWS account. The fixed snapshot may become reachable through the configured CloudFront URL. It does not include SQL, credentials, connection settings, or project identifiers.',
    };
  }

  async function publish(dashboardId: string, confirmationToken: string): Promise<{ publication: AnalyticsPublication; url: string }> {
    const token = clean(confirmationToken, 'confirmationToken', 1000, true);
    const tokenParts = token.split('.');
    if (tokenParts.length !== 4) throw new Error('Share confirmation token is invalid');
    const [, requestId, expectedContentHash, expectedConfigHash] = tokenParts;
    const requestRow = db.prepare(`
      SELECT * FROM dashboard_share_requests
      WHERE id = ? AND dashboard_id = ? AND token_sha256 = ? AND used_at IS NULL
        AND datetime(expires_at) > datetime('now')
    `).get(requestId, dashboardId, sha256(token)) as any;
    if (!requestRow) throw new Error('Share confirmation expired, was already used, or does not match this dashboard');

    const config = requireReadyConfig();
    if (configHash(config) !== expectedConfigHash) throw new Error('Publisher settings changed; prepare and confirm a new share request');
    const dashboard = analyticsService.getDashboard(dashboardId);
    if (!dashboard) throw new Error(`Dashboard ${dashboardId} not found`);
    if (dashboard.status === 'refreshing' || dashboard.recentRuns.some(run => run.status === 'queued' || run.status === 'running')) {
      throw new Error('Wait for the current dashboard refresh to finish before sharing a snapshot');
    }
    const html = renderDashboardSnapshot(dashboard, requestRow.created_at);
    const contentSha256 = sha256(html);
    if (contentSha256 !== expectedContentHash) throw new Error('Dashboard content changed; prepare and confirm the updated snapshot');
    if (Buffer.byteLength(html, 'utf8') > 5 * 1024 * 1024) throw new Error('Dashboard snapshot exceeds the 5 MB publishing limit');

    const objectKey = `${config.prefix || 'botboy-dashboards'}/${dashboard.id}/snapshot-${requestId.slice(6)}.html`;
    const url = objectUrl(config.cloudFrontBaseUrl, objectKey);
    const publicationId = `publication_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
    const consumed = db.transaction(() => {
      const result = db.prepare(`
        UPDATE dashboard_share_requests SET used_at = datetime('now')
        WHERE id = ? AND used_at IS NULL AND datetime(expires_at) > datetime('now')
      `).run(requestId);
      if (result.changes !== 1) return false;
      db.prepare(`
        INSERT INTO dashboard_publications
          (id, dashboard_id, publisher_id, object_key, url, status, content_sha256)
        VALUES (?, ?, 's3-cloudfront', ?, ?, 'publishing', ?)
      `).run(publicationId, dashboard.id, objectKey, url, contentSha256);
      return true;
    })();
    if (!consumed) throw new Error('Share confirmation was already consumed');

    try {
      const client = new S3Client({
        region: config.region,
        credentials: fromIni({ profile: config.awsProfile }),
      });
      try {
        // Deliberately the only AWS mutation: no ACL, bucket policy, CloudFront,
        // deletion-protection, or public-access-block changes are attempted.
        await client.send(new PutObjectCommand({
          Bucket: config.bucket,
          Key: objectKey,
          Body: html,
          ContentType: 'text/html; charset=utf-8',
          CacheControl: 'public, max-age=300, immutable',
          ContentDisposition: 'inline',
        }));
      } finally {
        client.destroy();
      }
      db.transaction(() => {
        db.prepare(`
          UPDATE dashboard_publications SET status = 'published', published_at = datetime('now')
          WHERE id = ?
        `).run(publicationId);
        db.prepare("UPDATE dashboard_publishers SET last_error = NULL, updated_at = datetime('now') WHERE id = 's3-cloudfront'").run();
      })();
    } catch (error: any) {
      const message = String(error?.message ?? error).slice(0, 4000);
      db.transaction(() => {
        db.prepare("UPDATE dashboard_publications SET status = 'failed', error = ? WHERE id = ?").run(message, publicationId);
        db.prepare("UPDATE dashboard_publishers SET last_error = ?, updated_at = datetime('now') WHERE id = 's3-cloudfront'").run(message);
      })();
      throw new Error(`Snapshot upload failed: ${message}`);
    }

    const publication = mapPublication(db.prepare('SELECT * FROM dashboard_publications WHERE id = ?').get(publicationId));
    return { publication, url };
  }

  return { getConfig, updateConfig, createShareRequest, publish };
}
