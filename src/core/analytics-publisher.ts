import Database from 'better-sqlite3';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import {
  escapeHtml,
  renderBars,
  renderLine,
  renderMetric,
  renderTable,
  renderTextBody,
  SNAPSHOT_CSS,
} from './snapshot-render.js';
import { renderDashboardBundle } from './publish-bundle.js';
import {
  harmonyAppName,
  harmonyDashboardUrl,
  installHarmonyCli as installHarmonyCliBinary,
  probeHarmony,
  publishToHarmony,
} from './publish-harmony.js';
import { provisioningPlan } from './harmony-provision.js';
import { fromIni } from '@aws-sdk/credential-providers';
import type {
  AnalyticsDashboard,
  AnalyticsPublication,
  AnalyticsWidget,
  DashboardPublisherConfig,
  DashboardPublisherProviderSummary,
  DashboardPublisherService,
  DashboardShareRequest,
  HarmonyPublisherSettings,
  PublisherProviderId,
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
    if (widget.kind === 'text') body = renderTextBody(widget);
  }
  return `<article class="widget ${escapeHtml(widget.kind)}"><header><div><span>${escapeHtml(widget.kind)}</span><h2>${escapeHtml(widget.title)}</h2>${widget.subtitle ? `<p>${escapeHtml(widget.subtitle)}</p>` : ''}</div>${widget.lastError ? '<b class="warn">Stale</b>' : ''}</header>${widget.lastError ? `<div class="error">Latest refresh error: ${escapeHtml(widget.lastError)}${widget.result ? ' · showing the previous successful result' : ''}</div>` : ''}<section>${body}</section><footer>${widget.result ? `Updated ${escapeHtml(new Date(widget.result.refreshedAt).toLocaleString())}` : 'Not refreshed'} · external analytical data</footer></article>`;
}

/** A self-contained, script-free snapshot. SQL and connection configuration are intentionally omitted. */
export function renderDashboardSnapshot(dashboard: AnalyticsDashboard, snapshotCreatedAt: string): string {
  const refreshed = dashboard.lastRefreshedAt ? new Date(dashboard.lastRefreshedAt).toLocaleString() : 'Not refreshed';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"><title>${escapeHtml(dashboard.title)}</title><style>${SNAPSHOT_CSS}</style></head><body><main><header><span class="snapshot">Shared snapshot</span><h1>${escapeHtml(dashboard.title)}</h1>${dashboard.description ? `<p>${escapeHtml(dashboard.description)}</p>` : ''}<div class="meta"><span>Data refreshed: ${escapeHtml(refreshed)}</span><span>Snapshot created: ${escapeHtml(new Date(snapshotCreatedAt).toLocaleString())}</span><span>${dashboard.widgets.length.toLocaleString()} widgets</span></div></header><section class="grid">${dashboard.widgets.map(renderWidget).join('')}</section><footer class="page-foot">Published by BotBoy from a local canonical dashboard. This is a fixed copy and does not update automatically. Query text, credentials, connection settings, and project identifiers are not included.</footer></main></body></html>`;
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

/** Harmony provider settings validation (plan §5 rework): the ONLY user
 * inputs are the team bindle ID, the stage, and the visibility toggle.
 * App name and directory are derived — never accepted here (old stored
 * appName/appDir keys are silently dropped). */
function normalizeHarmonyConfig(input: Record<string, unknown>, enabled: boolean): HarmonyPublisherSettings {
  const bindleId = clean((input.bindleId as string) ?? '', 'bindleId', 128);
  const stageRaw = String(input.stage ?? 'beta');
  const visibilityRaw = String(input.visibility ?? 'everyone');
  if (bindleId && !/^amzn1\.bindle\.resource\.[a-z0-9]{10,64}$/i.test(bindleId)) {
    throw new Error('bindleId must look like amzn1.bindle.resource.… (copy it from bindles.amazon.com, or run the automated setup)');
  }
  if (!['beta', 'gamma', 'prod'].includes(stageRaw)) throw new Error('stage must be beta, gamma, or prod');
  if (!['everyone', 'private'].includes(visibilityRaw)) throw new Error('visibility must be everyone or private');
  if (enabled && !bindleId) {
    throw new Error('Enabled Harmony publishing requires a team bindle ID — run the automated setup or paste one');
  }
  return {
    bindleId,
    stage: stageRaw as HarmonyPublisherSettings['stage'],
    visibility: visibilityRaw as HarmonyPublisherSettings['visibility'],
  };
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

export interface HarmonyHooks {
  /** Idempotent team+bindle creation over the CDP owner-Chrome transport. */
  provision: () => Promise<{ teamId: string; bindleId: string; teamName: string; bindleName: string; createdTeam: boolean; createdBindle: boolean; detail: string }>;
  /** Converge Can-view-app rows to the configured visibility (runs inside every publish). */
  ensureViewerAccess: (context: { appName: string; settings: HarmonyPublisherSettings }) => Promise<void>;
}

export function createDashboardPublisherService(options: {
  db: Database.Database;
  analyticsService: AnalyticsDashboardService;
  /** Vega runtime dir for bundle artifacts (default: the served dist/ui/vendor). Tests inject fixtures. */
  vendorDir?: string;
  /** Runtime wiring (index.ts). Absent in unit tests → provisioning/converge unavailable, deploys still work. */
  harmonyHooks?: HarmonyHooks;
}): DashboardPublisherService {
  const db = options.db;
  const analyticsService = options.analyticsService;
  const vendorDir = options.vendorDir;
  const harmonyHooks = options.harmonyHooks;

  function providerRow(id: PublisherProviderId): any {
    return db.prepare('SELECT * FROM dashboard_publishers WHERE id = ?').get(id);
  }

  function storedS3(): StoredPublisherConfig {
    const row = providerRow('s3-cloudfront');
    return normalizeConfig(parseJson<StoredPublisherConfig>(row?.config_json ?? '{}', {}), false);
  }

  function storedHarmony(): HarmonyPublisherSettings {
    const row = providerRow('harmony');
    return normalizeHarmonyConfig(parseJson<Partial<HarmonyPublisherSettings>>(row?.config_json ?? '{}', {}), false);
  }

  function s3Configured(stored: StoredPublisherConfig): boolean {
    return Boolean(stored.bucket && stored.region && stored.awsProfile && stored.cloudFrontBaseUrl);
  }
  function harmonyConfigured(stored: HarmonyPublisherSettings): boolean {
    return Boolean(stored.bindleId && stored.stage);
  }

  /** The single active provider: enabled AND configured. Storage enforces one enabled row. */
  function activeProvider(): 'harmony' | 's3-cloudfront' | null {
    const harmonyRow = providerRow('harmony');
    if (harmonyRow?.enabled === 1 && harmonyConfigured(storedHarmony())) return 'harmony';
    const s3Row = providerRow('s3-cloudfront');
    if (s3Row?.enabled === 1 && s3Configured(storedS3())) return 's3-cloudfront';
    return null;
  }

  function getConfig(): DashboardPublisherConfig {
    const rows: Record<string, any> = {
      harmony: providerRow('harmony'),
      's3-cloudfront': providerRow('s3-cloudfront'),
      sftp: providerRow('sftp'),
    };
    if (!rows['s3-cloudfront'] && !rows.harmony) throw new Error('Dashboard publisher storage is unavailable');
    const s3 = storedS3();
    const harmony = storedHarmony();
    const active = activeProvider();
    const providers: DashboardPublisherProviderSummary[] = [
      {
        id: 'harmony',
        displayName: rows.harmony?.display_name ?? 'Amazon Harmony',
        enabled: rows.harmony?.enabled === 1,
        configured: harmonyConfigured(harmony),
        available: true,
        lastError: rows.harmony?.last_error || undefined,
        updatedAt: rows.harmony?.updated_at ?? '',
      },
      {
        id: 's3-cloudfront',
        displayName: rows['s3-cloudfront']?.display_name ?? 'Amazon S3 + CloudFront',
        enabled: rows['s3-cloudfront']?.enabled === 1,
        configured: s3Configured(s3),
        available: true,
        lastError: rows['s3-cloudfront']?.last_error || undefined,
        updatedAt: rows['s3-cloudfront']?.updated_at ?? '',
      },
      {
        id: 'sftp',
        displayName: rows.sftp?.display_name ?? 'SFTP / static host',
        enabled: false,
        configured: false,
        available: false, // announced in the UI, wired in phase 3
        updatedAt: rows.sftp?.updated_at ?? '',
      },
    ];
    const activeRow = active ? rows[active] : null;
    return {
      id: active,
      displayName: activeRow?.display_name ?? 'Dashboard sharing',
      enabled: Boolean(active),
      configured: Boolean(active),
      providers,
      s3: { bucket: s3.bucket || '', prefix: s3.prefix || 'botboy-dashboards', region: s3.region || 'us-east-1', awsProfile: s3.awsProfile || '', cloudFrontBaseUrl: s3.cloudFrontBaseUrl || '' },
      harmony: { appName: harmonyAppName(), bindleId: harmony.bindleId || '', stage: harmony.stage || 'beta', visibility: harmony.visibility || 'everyone' },
      lastError: activeRow?.last_error || undefined,
      updatedAt: activeRow?.updated_at ?? rows['s3-cloudfront']?.updated_at ?? '',
    };
  }

  function updateConfig(input: UpdateDashboardPublisherInput): DashboardPublisherConfig {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Publisher input must be an object');
    if (typeof input.enabled !== 'boolean') throw new Error('enabled must be a boolean');
    const provider = (input.provider ?? 's3-cloudfront') as PublisherProviderId;
    if (provider === 'sftp') throw new Error('SFTP publishing is coming later — it cannot be configured yet');
    if (provider !== 'harmony' && provider !== 's3-cloudfront') throw new Error(`Unknown provider: ${String(provider)}`);
    const configJson = provider === 'harmony'
      ? JSON.stringify(normalizeHarmonyConfig(input as unknown as Record<string, unknown>, input.enabled))
      : JSON.stringify(normalizeConfig(input as any, input.enabled));
    db.transaction(() => {
      db.prepare(`
        UPDATE dashboard_publishers SET enabled = ?, config_json = ?, last_error = NULL,
          updated_at = datetime('now') WHERE id = ?
      `).run(input.enabled ? 1 : 0, configJson, provider);
      if (input.enabled) {
        // Exactly one active provider: enabling one disables the others.
        db.prepare("UPDATE dashboard_publishers SET enabled = 0, updated_at = datetime('now') WHERE id != ?").run(provider);
      }
    })();
    return getConfig();
  }

  interface ReadyConfig {
    provider: 'harmony' | 's3-cloudfront';
    s3: StoredPublisherConfig;
    harmony: HarmonyPublisherSettings;
  }

  function requireReadyConfig(): ReadyConfig {
    const provider = activeProvider();
    if (!provider) throw new Error('Dashboard sharing is not enabled and fully configured (pick a provider in Settings → Dashboard sharing)');
    return { provider, s3: storedS3(), harmony: storedHarmony() };
  }

  /** Binds the token to the provider AND its settings — switching either invalidates pending confirmations. */
  function configHash(config: ReadyConfig): string {
    return sha256(JSON.stringify(
      config.provider === 'harmony'
        ? { provider: 'harmony', appName: harmonyAppName(), bindleId: config.harmony.bindleId, stage: config.harmony.stage, visibility: config.harmony.visibility }
        : { provider: 's3-cloudfront', bucket: config.s3.bucket, prefix: config.s3.prefix, region: config.s3.region, awsProfile: config.s3.awsProfile, cloudFrontBaseUrl: config.s3.cloudFrontBaseUrl },
    ));
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
    // Content identity per provider: single-file html sha for S3 (legacy
    // artifact), bundle manifest sha for Harmony (interactive artifact).
    const contentSha256 = config.provider === 'harmony'
      ? renderDashboardBundle(dashboard, createdAt, { vendorDir }).manifestSha256
      : sha256(renderDashboardSnapshot(dashboard, createdAt));
    const currentConfigHash = configHash(config);
    const confirmationToken = `${randomBytes(32).toString('base64url')}.${requestId}.${contentSha256}.${currentConfigHash}`;
    const objectKey = config.provider === 'harmony'
      ? `d/${dashboard.id}/`
      : `${config.s3.prefix || 'botboy-dashboards'}/${dashboard.id}/snapshot-${requestId.slice(6)}.html`;
    db.transaction(() => {
      db.prepare("DELETE FROM dashboard_share_requests WHERE datetime(expires_at) <= datetime('now') OR used_at IS NOT NULL").run();
      db.prepare(`
        INSERT INTO dashboard_share_requests (id, dashboard_id, token_sha256, expires_at, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(requestId, dashboard.id, sha256(confirmationToken), expiresAt, createdAt);
    })();
    const destination = config.provider === 'harmony'
      ? `Harmony app "${harmonyAppName()}" (${config.harmony.stage}) → ${harmonyDashboardUrl(config.harmony, dashboard.id)}`
      : `s3://${config.s3.bucket}/${objectKey} via AWS profile ${config.s3.awsProfile}`;
    const warning = config.provider === 'harmony'
      ? (config.harmony.visibility === 'private'
        ? 'Confirming runs `harmony app deploy` for your app with visibility set to ONLY YOU (applied on every publish). Caveat: the classic console.harmony.a2z.com path bypasses viewer restrictions until the app\u2019s subdomain redirect is enabled. SQL, credentials, connection settings, and project identifiers are not included.'
        : 'Confirming runs `harmony app deploy` for your app. The interactive snapshot becomes viewable by ANY Midway-authenticated Amazon employee (visibility toggle: Everyone). Do not publish Critical or Restricted data. SQL, credentials, connection settings, and project identifiers are not included.')
      : 'Confirming performs one S3 PutObject in the configured AWS account. The fixed snapshot may become reachable through the configured CloudFront URL. It does not include SQL, credentials, connection settings, or project identifiers.';
    return {
      dashboardId: dashboard.id,
      confirmationToken,
      expiresAt,
      destination,
      objectKey,
      contentSha256,
      warning,
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

    // Re-render and verify content identity against the token (provider-specific artifact).
    const isHarmony = config.provider === 'harmony';
    const html = isHarmony ? '' : renderDashboardSnapshot(dashboard, requestRow.created_at);
    const bundle = isHarmony ? renderDashboardBundle(dashboard, requestRow.created_at, { vendorDir }) : null;
    const contentSha256 = isHarmony ? bundle!.manifestSha256 : sha256(html);
    if (contentSha256 !== expectedContentHash) throw new Error('Dashboard content changed; prepare and confirm the updated snapshot');
    if (!isHarmony && Buffer.byteLength(html, 'utf8') > 5 * 1024 * 1024) throw new Error('Dashboard snapshot exceeds the 5 MB publishing limit');

    const objectKey = isHarmony
      ? `d/${dashboard.id}/`
      : `${config.s3.prefix || 'botboy-dashboards'}/${dashboard.id}/snapshot-${requestId.slice(6)}.html`;
    const url = isHarmony
      ? harmonyDashboardUrl(config.harmony, dashboard.id)
      : objectUrl(config.s3.cloudFrontBaseUrl ?? '', objectKey);
    const providerId = isHarmony ? 'harmony' : 's3-cloudfront';
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
        VALUES (?, ?, ?, ?, ?, 'publishing', ?)
      `).run(publicationId, dashboard.id, providerId, objectKey, url, contentSha256);
      return true;
    })();
    if (!consumed) throw new Error('Share confirmation was already consumed');

    try {
      if (isHarmony) {
        // Listing page covers every dashboard with a live publication on this
        // provider, plus the one being published now.
        const rows = db.prepare(`
          SELECT dashboard_id, MAX(published_at) AS published_at
          FROM dashboard_publications
          WHERE publisher_id = 'harmony' AND status = 'published'
          GROUP BY dashboard_id
        `).all() as Array<{ dashboard_id: string; published_at: string }>;
        const entries = new Map<string, { dashboardId: string; title: string; description: string; publishedAt: string }>();
        for (const row of rows) {
          const existing = analyticsService.getDashboard(row.dashboard_id);
          if (existing) {
            entries.set(row.dashboard_id, {
              dashboardId: row.dashboard_id,
              title: existing.title,
              description: existing.description ?? '',
              publishedAt: row.published_at,
            });
          }
        }
        entries.set(dashboard.id, {
          dashboardId: dashboard.id,
          title: dashboard.title,
          description: dashboard.description ?? '',
          publishedAt: new Date().toISOString(),
        });
        await publishToHarmony({
          settings: config.harmony,
          dashboard,
          snapshotCreatedAt: requestRow.created_at,
          publishedEntries: [...entries.values()],
          vendorDir,
          // Owner ruling: audience convergence is PART of the deploy step.
          ensureViewerAccess: harmonyHooks?.ensureViewerAccess,
        });
      } else {
        const client = new S3Client({
          region: config.s3.region,
          credentials: fromIni({ profile: config.s3.awsProfile }),
        });
        try {
          // Deliberately the only AWS mutation: no ACL, bucket policy, CloudFront,
          // deletion-protection, or public-access-block changes are attempted.
          await client.send(new PutObjectCommand({
            Bucket: config.s3.bucket,
            Key: objectKey,
            Body: html,
            ContentType: 'text/html; charset=utf-8',
            CacheControl: 'public, max-age=300, immutable',
            ContentDisposition: 'inline',
          }));
        } finally {
          client.destroy();
        }
      }
      db.transaction(() => {
        db.prepare(`
          UPDATE dashboard_publications SET status = 'published', published_at = datetime('now')
          WHERE id = ?
        `).run(publicationId);
        db.prepare("UPDATE dashboard_publishers SET last_error = NULL, updated_at = datetime('now') WHERE id = ?").run(providerId);
      })();
    } catch (error: any) {
      const message = String(error?.message ?? error).slice(0, 4000);
      db.transaction(() => {
        db.prepare("UPDATE dashboard_publications SET status = 'failed', error = ? WHERE id = ?").run(message, publicationId);
        db.prepare("UPDATE dashboard_publishers SET last_error = ?, updated_at = datetime('now') WHERE id = ?").run(message, providerId);
      })();
      throw new Error(`Snapshot publish failed: ${message}`);
    }

    const publication = mapPublication(db.prepare('SELECT * FROM dashboard_publications WHERE id = ?').get(publicationId));
    return { publication, url };
  }

  async function probeHarmonySetup() {
    return probeHarmony(storedHarmony());
  }

  async function installHarmonyCli() {
    const result = await installHarmonyCliBinary();
    return { ...result, probe: await probeHarmonySetup() };
  }

  function planHarmonyProvisioning() {
    return provisioningPlan();
  }

  async function provisionHarmonyIdentity() {
    if (!harmonyHooks) throw new Error('Automated Harmony provisioning is unavailable in this build — paste a team bindle ID instead');
    let result: Awaited<ReturnType<HarmonyHooks['provision']>>;
    try {
      result = await harmonyHooks.provision();
    } catch (error: any) {
      // Persist onto the card — a transient toast is not an error surface (live-fire lesson 2026-09-09).
      const message = String(error?.message ?? error).slice(0, 4000);
      db.prepare("UPDATE dashboard_publishers SET last_error = ?, updated_at = datetime('now') WHERE id = 'harmony'").run(message);
      throw error;
    }
    // Merge the bindle ID into the stored Harmony row WITHOUT flipping the
    // enabled state or touching stage/visibility.
    const row = providerRow('harmony');
    const stored = storedHarmony();
    updateConfig({
      provider: 'harmony',
      enabled: row?.enabled === 1,
      bindleId: result.bindleId,
      stage: stored.stage,
      visibility: stored.visibility,
    });
    return { ...result, publisher: getConfig() };
  }

  return { getConfig, updateConfig, createShareRequest, publish, probeHarmonySetup, installHarmonyCli, planHarmonyProvisioning, provisionHarmonyIdentity };
}
