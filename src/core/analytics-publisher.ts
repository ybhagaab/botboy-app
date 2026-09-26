import Database from 'better-sqlite3';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import {
  escapeHtml,
  renderBars,
  renderLine,
  renderMetric,
  renderTable,
  renderTextBody,
  SNAPSHOT_CSS,
} from './snapshot-render.js';
import { renderDashboardBundle, type DashboardBundle } from './publish-bundle.js';
import { buildDashboardPublicationSnapshot } from './analytics-publication-snapshot.js';
import type { AnalyticsDashboardDataRoomBridge } from './analytics-dashboard-data-room.js';
import { buildStaticArtifactBundle } from './publish-static-artifact.js';
import {
  harmonyAppName,
  harmonyDashboardUrl,
  harmonyStaticArtifactUrl,
  installHarmonyCli as installHarmonyCliBinary,
  probeHarmony,
  publishStaticArtifactToHarmony,
  publishToHarmony,
  renderHarmonyDashboardListing,
  synchronizeStaticArtifactMirror,
  type PublishedEntry,
} from './publish-harmony.js';
import { provisioningPlan, type HarmonyArtifactVerificationReceipt, type HarmonyViewerAccessReceipt } from './harmony-provision.js';
import { fromIni } from '@aws-sdk/credential-providers';
import type {
  AnalyticsDashboard,
  AnalyticsPublication,
  AnalyticsWidget,
  DashboardPublicationDrift,
  DashboardPublicationDriftScope,
  DashboardPublicationReceiptV1,
  DashboardPublicationSnapshotV1,
  DashboardPublisherConfig,
  DashboardPublisherProviderSummary,
  DashboardPublisherService,
  DashboardShareRequest,
  HarmonyPublisherSettings,
  PublisherProviderId,
  StaticArtifactPublishInput,
  StaticArtifactPublishPhase,
  StaticArtifactPublishResult,
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

function sha256(value: string | Buffer): string {
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

function mapStaticArtifactPublication(row: any): StaticArtifactPublishResult {
  const phase = row.phase as StaticArtifactPublishPhase;
  const canonicalMirrorSynchronized = row.mirror_synchronized !== 0;
  const published = phase === 'published' && canonicalMirrorSynchronized;
  return {
    ok: published,
    outcome: published ? 'complete' : 'partial',
    provider: 'harmony',
    published,
    dryRun: false,
    attemptId: row.id,
    phase,
    deployed: row.deployed === 1,
    contentVerified: row.content_verified === 1,
    visibilityConverged: row.visibility_converged === 1,
    canonicalMirrorSynchronized,
    appName: row.app_name,
    stage: row.stage,
    visibility: row.visibility,
    slug: row.slug,
    sourcePath: row.source_path,
    url: row.url,
    manifestSha256: row.manifest_sha256,
    totalBytes: row.total_bytes,
    files: parseJson(row.manifest_json, []),
    transformations: parseJson(row.transformations_json, {
      inlineStylesExternalized: 0,
      inlineScriptsExternalized: 0,
      localAssetsIncluded: 0,
    }),
    ...(row.resource_id ? { resourceId: row.resource_id } : {}),
    ...(row.error ? { error: row.error } : {}),
    ...(!published && row.deployed === 1 ? {
      nextAction: canonicalMirrorSynchronized
        ? `Retry publish_static_artifact_to_harmony with resumeAttemptId="${row.id}"; it resumes access/content verification without redeploying. Browser fallback is allowed when the receipt names a Bindles URL.`
        : `Retry publish_static_artifact_to_harmony with resumeAttemptId="${row.id}"; the canonical Harmony mirror is unsynchronized, so BotBoy must redeploy and promote the exact artifact before verification can complete.`,
    } : {}),
    createdAt: row.created_at,
    ...(row.deployed_at ? { deployedAt: row.deployed_at } : {}),
    ...(row.published_at ? { publishedAt: row.published_at } : {}),
  };
}

function mapPublication(row: any): AnalyticsPublication {
  const snapshot = row.manifest_json
    ? parseJson<DashboardPublicationSnapshotV1 | null>(row.manifest_json, null)
    : null;
  const receipt = snapshot && row.manifest_sha256 && row.config_sha256 ? {
    snapshot,
    snapshotManifestSha256: row.manifest_sha256,
    artifactContentSha256: row.content_sha256,
    publisherConfigSha256: row.config_sha256,
  } satisfies DashboardPublicationReceiptV1 : undefined;
  return {
    id: row.id,
    dashboardId: row.dashboard_id,
    publisherId: row.publisher_id,
    objectKey: row.object_key,
    ...(row.share_request_id ? { shareRequestId: row.share_request_id } : {}),
    url: row.url || undefined,
    status: row.status,
    contentSha256: row.content_sha256,
    deployed: row.deployed === 1,
    contentVerified: row.content_verified === 1,
    visibilityConverged: row.visibility_converged === 1,
    ...(receipt ? { receipt } : {}),
    error: row.error || undefined,
    createdAt: row.created_at,
    publishedAt: row.published_at || undefined,
  };
}

export type DashboardPublicationErrorCode =
  | 'invalid_confirmation'
  | 'not_found'
  | 'publication_not_ready'
  | 'policy_denied'
  | 'publication_snapshot_drift'
  | 'publication_provider_failed';

export class DashboardPublicationError extends Error {
  constructor(
    readonly code: DashboardPublicationErrorCode,
    message: string,
    readonly nextAction: string,
    readonly drift: DashboardPublicationDrift[] = [],
  ) {
    super(message);
    this.name = 'DashboardPublicationError';
  }
}

export type DashboardPublishArtifact =
  | { provider: 'harmony'; bundle: DashboardBundle; listingHtml: string }
  | { provider: 's3-cloudfront'; html: string };

export interface DashboardPublishEffectReceipt {
  deployed: true;
  contentVerified: true;
  visibilityConverged: true;
}

export interface DashboardPublishAdapterInput {
  provider: 'harmony' | 's3-cloudfront';
  dashboardId: string;
  objectKey: string;
  url: string;
  artifact: DashboardPublishArtifact;
  harmony: HarmonyPublisherSettings;
  s3: {
    bucket?: string;
    region?: string;
    awsProfile?: string;
  };
}

export type DashboardPublishAdapter = (input: DashboardPublishAdapterInput) => Promise<DashboardPublishEffectReceipt>;

export interface DashboardS3Client {
  send(command: PutObjectCommand | GetObjectCommand): Promise<any>;
  destroy(): void;
}

export interface HarmonyHooks {
  /** Idempotent team+bindle creation over the CDP owner-Chrome transport. */
  provision: () => Promise<{ teamId: string; bindleId: string; teamName: string; bindleName: string; createdTeam: boolean; createdBindle: boolean; detail: string }>;
  /** Converge and verify Can-view-app rows to the configured visibility. */
  ensureViewerAccess: (context: { appName: string; settings: HarmonyPublisherSettings }) => Promise<HarmonyViewerAccessReceipt>;
  /** Fetch and hash the deployed static files through authenticated debug Chrome. */
  verifyStaticArtifact: (context: { url: string; files: Array<{ relativePath: string; bytes: number; sha256: string }> }) => Promise<HarmonyArtifactVerificationReceipt>;
}

export function createDashboardPublisherService(options: {
  db: Database.Database;
  analyticsService: AnalyticsDashboardService;
  /** Strict current binding/head/control/result publication verifier. */
  dataRoom?: AnalyticsDashboardDataRoomBridge;
  /** Vega runtime dir for bundle artifacts (default: the served dist/ui/vendor). Tests inject fixtures. */
  vendorDir?: string;
  /** Runtime wiring (index.ts). Absent in unit tests → provisioning/converge unavailable, deploys still work. */
  harmonyHooks?: HarmonyHooks;
  /** Test injection for static-artifact source containment. */
  staticFilesRoot?: string;
  /** Test injection for the complete external dashboard effect. */
  dashboardPublishAdapter?: DashboardPublishAdapter;
  /** Narrow test seam for production Harmony composition (deploy → served-file verify). */
  harmonyDashboardPublishAdapter?: typeof publishToHarmony;
  /** Narrow test seam for production S3 PutObject → GetObject verification. */
  s3ClientFactory?: (config: { region?: string; awsProfile?: string }) => DashboardS3Client;
  /** Test injection for verifyExisting canonical-mirror synchronization. */
  staticMirrorAdapter?: typeof synchronizeStaticArtifactMirror;
  /** Test injection for the external static-artifact deploy phase. */
  staticPublishAdapter?: typeof publishStaticArtifactToHarmony;
}): DashboardPublisherService {
  const db = options.db;
  const analyticsService = options.analyticsService;
  const dataRoom = options.dataRoom;
  const dashboardPublishAdapter = options.dashboardPublishAdapter;
  const harmonyDashboardPublishAdapter = options.harmonyDashboardPublishAdapter ?? publishToHarmony;
  const s3ClientFactory = options.s3ClientFactory ?? ((config: { region?: string; awsProfile?: string }) => new S3Client({
    region: config.region,
    credentials: fromIni({ profile: config.awsProfile }),
  }) as DashboardS3Client);
  const vendorDir = options.vendorDir;
  const harmonyHooks = options.harmonyHooks;
  const staticFilesRoot = options.staticFilesRoot;
  const staticMirrorAdapter = options.staticMirrorAdapter ?? synchronizeStaticArtifactMirror;
  const staticPublishAdapter = options.staticPublishAdapter ?? publishStaticArtifactToHarmony;

  // One Harmony app is one mutable external capability. Serialize dashboard
  // and static-artifact operations in-process so shared staging/tar paths can
  // never overlap. Validation and token consumption happen only after owning
  // this slot.
  let providerMutationTail: Promise<void> = Promise.resolve();
  async function withProviderMutation<T>(work: () => Promise<T>): Promise<T> {
    const previous = providerMutationTail;
    let release!: () => void;
    providerMutationTail = new Promise<void>(resolve => { release = resolve; });
    await previous;
    try {
      return await work();
    } finally {
      release();
    }
  }

  // A prior process may have stopped after consuming a token. Never leave a
  // permanent "publishing" lock or claim the remote effect is absent.
  db.prepare(`
    UPDATE dashboard_publications
    SET status = 'failed',
      error = COALESCE(error, '[PUBLICATION_STATE_UNKNOWN] The prior process stopped before provider completion was recorded; inspect the remote destination before retrying.'),
      updated_at = datetime('now')
    WHERE status = 'publishing'
  `).run();

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

  function publicationError(
    code: DashboardPublicationErrorCode,
    message: string,
    nextAction: string,
    drift: DashboardPublicationDrift[] = [],
  ): never {
    throw new DashboardPublicationError(code, message, nextAction, drift);
  }

  function strictSnapshot(dashboard: AnalyticsDashboard, createdAt: string) {
    try {
      return buildDashboardPublicationSnapshot(
        dashboard,
        createdAt,
        dataRoom ? (widgetId, result) => dataRoom.validatePublicationResult(widgetId, result) : undefined,
      );
    } catch (error: any) {
      const policyDenied = error?.code === 'policy_denied';
      return publicationError(
        policyDenied ? 'policy_denied' : 'publication_not_ready',
        policyDenied
          ? `Dashboard data is not approved for publication: ${error?.message ?? String(error)}`
          : `Dashboard is not ready for an exact publication snapshot: ${error?.message ?? String(error)}`,
        policyDenied
          ? 'Update the dataset handling policy through its governed definition process before preparing another snapshot.'
          : 'Refresh or rebind the affected widget, verify its current result, then prepare a new snapshot.',
      );
    }
  }

  function harmonyPublishedEntries(dashboard: AnalyticsDashboard, publishedAt: string): PublishedEntry[] {
    const rows = db.prepare(`
      SELECT dashboard_id, MAX(published_at) AS published_at
      FROM dashboard_publications
      WHERE publisher_id = 'harmony' AND status = 'published'
      GROUP BY dashboard_id
    `).all() as Array<{ dashboard_id: string; published_at: string }>;
    const entries = new Map<string, PublishedEntry>();
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
      publishedAt,
    });
    return [...entries.values()];
  }

  function buildArtifact(config: ReadyConfig, dashboard: AnalyticsDashboard, createdAt: string): {
    artifact: DashboardPublishArtifact;
    contentSha256: string;
  } {
    if (config.provider === 'harmony') {
      const bundle = renderDashboardBundle(dashboard, createdAt, { vendorDir });
      const listingHtml = renderHarmonyDashboardListing(harmonyPublishedEntries(dashboard, createdAt));
      const contentSha256 = sha256(JSON.stringify({
        version: 1,
        dashboardBundleManifestSha256: bundle.manifestSha256,
        listingHtmlSha256: sha256(listingHtml),
        rootStyleSha256: sha256(SNAPSHOT_CSS),
      }));
      return { artifact: { provider: 'harmony', bundle, listingHtml }, contentSha256 };
    }
    const html = renderDashboardSnapshot(dashboard, createdAt);
    if (Buffer.byteLength(html, 'utf8') > 5 * 1024 * 1024) {
      publicationError('publication_not_ready', 'Dashboard snapshot exceeds the 5 MB publishing limit.', 'Reduce the displayed result size, then prepare a new snapshot.');
    }
    return { artifact: { provider: 's3-cloudfront', html }, contentSha256: sha256(html) };
  }

  function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  }

  function isInteger(value: unknown, minimum = 0): value is number {
    return Number.isInteger(value) && Number(value) >= minimum;
  }

  function isSha256(value: unknown): value is string {
    return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
  }

  function isOptionalString(value: unknown): value is string | undefined {
    return value === undefined || (typeof value === 'string' && value.length > 0);
  }

  function isDataRoomPublicationIdentity(value: unknown): value is DashboardPublicationReceiptV1['snapshot']['widgets'][number]['dataRoom'] {
    if (!isRecord(value) || !isRecord(value.head) || !isRecord(value.control)) return false;
    return typeof value.datasetId === 'string' && value.datasetId.length > 0
      && isInteger(value.datasetDefinitionRevision, 1)
      && isInteger(value.bindingRevision, 1)
      && isSha256(value.bindingSha256)
      && ['pinned', 'latest_compatible', 'latest_fresh'].includes(String(value.versionPolicy))
      && isOptionalString(value.pinnedVersionId)
      && typeof value.lastAppliedVersionId === 'string' && value.lastAppliedVersionId.length > 0
      && isOptionalString(value.head.versionId)
      && isInteger(value.head.headRevision)
      && (value.head.definitionRevision === undefined || isInteger(value.head.definitionRevision, 1))
      && isInteger(value.control.revision)
      && typeof value.control.projected === 'boolean'
      && isSha256(value.control.definitionSha256)
      && isSha256(value.control.valuesSha256)
      && isSha256(value.control.effectiveViewRequestSha256)
      && typeof value.versionId === 'string' && value.versionId.length > 0
      && isSha256(value.requestSha256)
      && isSha256(value.querySha256)
      && typeof value.compilerVersion === 'string' && value.compilerVersion.length > 0
      && isSha256(value.contentSha256)
      && isSha256(value.schemaSha256)
      && isSha256(value.contractSha256)
      && isSha256(value.definitionSha256)
      && isSha256(value.semanticReceiptSha256);
  }

  function parsePreparedSnapshot(raw: string): DashboardPublicationSnapshotV1 | null {
    const value = parseJson<unknown>(raw, null);
    if (!isRecord(value) || value.version !== 1
      || typeof value.dashboardId !== 'string' || !value.dashboardId
      || typeof value.snapshotCreatedAt !== 'string' || !Number.isFinite(Date.parse(value.snapshotCreatedAt))
      || !isSha256(value.presentationSha256) || !isSha256(value.resultSha256)
      || !Array.isArray(value.widgets) || value.widgets.length > 24) return null;
    const widgetIds = new Set<string>();
    for (const widget of value.widgets) {
      if (!isRecord(widget)
        || typeof widget.widgetId !== 'string' || !widget.widgetId || widgetIds.has(widget.widgetId)
        || !isInteger(widget.position) || !isInteger(widget.widgetRevision, 1)
        || !isInteger(widget.bindingGeneration)
        || !isSha256(widget.presentationSha256)
        || (widget.resultSha256 !== undefined && !isSha256(widget.resultSha256))
        || (widget.dataRoom !== undefined && !isDataRoomPublicationIdentity(widget.dataRoom))) return null;
      widgetIds.add(widget.widgetId);
    }
    return value as unknown as DashboardPublicationSnapshotV1;
  }

  function snapshotDrift(
    prepared: DashboardPublicationSnapshotV1,
    current: DashboardPublicationSnapshotV1,
  ): DashboardPublicationDrift[] {
    const drift: DashboardPublicationDrift[] = [];
    const add = (scope: DashboardPublicationDriftScope, widgetId?: string) => {
      if (!drift.some(item => item.scope === scope && item.widgetId === widgetId)) {
        drift.push({ scope, ...(widgetId ? { widgetId } : {}) });
      }
    };
    if (prepared.dashboardId !== current.dashboardId
      || prepared.snapshotCreatedAt !== current.snapshotCreatedAt
      || prepared.presentationSha256 !== current.presentationSha256) add('dashboard');
    if (prepared.resultSha256 !== current.resultSha256) add('result');

    const currentById = new Map(current.widgets.map(widget => [widget.widgetId, widget]));
    const preparedIds = new Set(prepared.widgets.map(widget => widget.widgetId));
    for (const widget of prepared.widgets) {
      const next = currentById.get(widget.widgetId);
      if (!next) {
        add('widget', widget.widgetId);
        continue;
      }
      if (next.position !== widget.position || next.widgetRevision !== widget.widgetRevision
        || next.bindingGeneration !== widget.bindingGeneration
        || next.presentationSha256 !== widget.presentationSha256) add('widget', widget.widgetId);
      if (next.resultSha256 !== widget.resultSha256) add('result', widget.widgetId);
      const left = widget.dataRoom;
      const right = next.dataRoom;
      if (!left && !right) continue;
      if (!left || !right) {
        add('binding', widget.widgetId);
        continue;
      }
      if (left.datasetId !== right.datasetId
        || left.datasetDefinitionRevision !== right.datasetDefinitionRevision
        || left.bindingRevision !== right.bindingRevision
        || left.bindingSha256 !== right.bindingSha256
        || left.versionPolicy !== right.versionPolicy
        || left.pinnedVersionId !== right.pinnedVersionId
        || left.lastAppliedVersionId !== right.lastAppliedVersionId) add('binding', widget.widgetId);
      if (left.head.versionId !== right.head.versionId
        || left.head.headRevision !== right.head.headRevision
        || left.head.definitionRevision !== right.head.definitionRevision) add('dataset_head', widget.widgetId);
      if (left.control.revision !== right.control.revision
        || left.control.projected !== right.control.projected
        || left.control.definitionSha256 !== right.control.definitionSha256
        || left.control.valuesSha256 !== right.control.valuesSha256
        || left.control.effectiveViewRequestSha256 !== right.control.effectiveViewRequestSha256) add('control', widget.widgetId);
      if (left.versionId !== right.versionId || left.requestSha256 !== right.requestSha256
        || left.querySha256 !== right.querySha256 || left.compilerVersion !== right.compilerVersion
        || left.contentSha256 !== right.contentSha256 || left.schemaSha256 !== right.schemaSha256
        || left.contractSha256 !== right.contractSha256 || left.definitionSha256 !== right.definitionSha256) {
        add('dataset_version', widget.widgetId);
      }
      if (left.semanticReceiptSha256 !== right.semanticReceiptSha256) add('semantic_receipt', widget.widgetId);
    }
    for (const widget of current.widgets) {
      if (!preparedIds.has(widget.widgetId)) add('widget', widget.widgetId);
    }
    if (prepared.widgets.length !== current.widgets.length) add('dashboard');
    return drift;
  }

  function createShareRequest(dashboardId: string): DashboardShareRequest {
    const dashboard = analyticsService.getDashboard(clean(dashboardId, 'dashboardId', 128, true));
    if (!dashboard) publicationError('not_found', `Dashboard ${dashboardId} not found`, 'Open an existing dashboard and prepare its snapshot again.');
    if (dashboard.status === 'refreshing' || dashboard.recentRuns.some(run => run.status === 'queued' || run.status === 'running')) {
      publicationError('publication_not_ready', 'Wait for the current dashboard refresh to finish before sharing a snapshot.', 'Wait for the exact run to finish, then prepare a new snapshot.');
    }
    const config = requireReadyConfig();
    const requestId = `share_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
    const createdAt = new Date().toISOString();
    const expiresAt = new Date(Date.now() + 5 * 60_000).toISOString();
    const snapshot = strictSnapshot(dashboard, createdAt);
    const built = buildArtifact(config, dashboard, createdAt);
    const currentConfigHash = configHash(config);
    const receipt: DashboardPublicationReceiptV1 = {
      snapshot: snapshot.snapshot,
      snapshotManifestSha256: snapshot.manifestSha256,
      artifactContentSha256: built.contentSha256,
      publisherConfigSha256: currentConfigHash,
    };
    const confirmationToken = `${randomBytes(32).toString('base64url')}.${requestId}.${built.contentSha256}.${currentConfigHash}`;
    const objectKey = config.provider === 'harmony'
      ? `d/${dashboard.id}/`
      : `${config.s3.prefix || 'botboy-dashboards'}/${dashboard.id}/snapshot-${requestId.slice(6)}.html`;
    db.transaction(() => {
      db.prepare("DELETE FROM dashboard_share_requests WHERE datetime(expires_at) <= datetime('now') AND used_at IS NULL").run();
      db.prepare(`
        INSERT INTO dashboard_share_requests
          (id, dashboard_id, token_sha256, content_sha256, config_sha256,
           manifest_sha256, manifest_json, expires_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        requestId, dashboard.id, sha256(confirmationToken), built.contentSha256,
        currentConfigHash, snapshot.manifestSha256, snapshot.manifestJson,
        expiresAt, createdAt,
      );
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
      contentSha256: built.contentSha256,
      receipt,
      warning,
    };
  }

  async function publishUnlocked(dashboardId: string, confirmationToken: string): Promise<{ publication: AnalyticsPublication; url: string }> {
    const token = clean(confirmationToken, 'confirmationToken', 1000, true);
    const tokenParts = token.split('.');
    if (tokenParts.length !== 4) publicationError('invalid_confirmation', 'Share confirmation token is invalid.', 'Prepare a new snapshot and confirm only its exact token.');
    const [, requestId, expectedContentHash, expectedConfigHash] = tokenParts;
    const requestRow = db.prepare(`
      SELECT * FROM dashboard_share_requests
      WHERE id = ? AND dashboard_id = ? AND token_sha256 = ? AND used_at IS NULL
        AND datetime(expires_at) > datetime('now')
    `).get(requestId, dashboardId, sha256(token)) as any;
    if (!requestRow) publicationError('invalid_confirmation', 'Share confirmation expired, was already used, or does not match this dashboard.', 'Prepare a new snapshot and review it before confirming.');
    if (!requestRow.manifest_json || !requestRow.manifest_sha256
      || !requestRow.content_sha256 || !requestRow.config_sha256) {
      publicationError('publication_snapshot_drift', 'This confirmation predates exact publication provenance.', 'Prepare a new snapshot and review its exact receipt before confirming.', [{ scope: 'artifact' }]);
    }

    const config = requireReadyConfig();
    const currentConfigHash = configHash(config);
    if (currentConfigHash !== expectedConfigHash || currentConfigHash !== requestRow.config_sha256) {
      publicationError('publication_snapshot_drift', 'Publisher settings changed after this snapshot was prepared.', 'Prepare a new snapshot and review its destination before confirming.', [{ scope: 'publisher_config' }]);
    }
    const dashboard = analyticsService.getDashboard(dashboardId);
    if (!dashboard) publicationError('not_found', `Dashboard ${dashboardId} not found`, 'Open an existing dashboard and prepare a new snapshot.');
    if (dashboard.status === 'refreshing' || dashboard.recentRuns.some(run => run.status === 'queued' || run.status === 'running')) {
      publicationError('publication_not_ready', 'Wait for the current dashboard refresh to finish before sharing a snapshot.', 'Wait for the exact run to finish, then prepare a new snapshot.');
    }
    const preparedSnapshot = parsePreparedSnapshot(requestRow.manifest_json);
    if (!preparedSnapshot) publicationError('publication_snapshot_drift', 'Prepared publication provenance is malformed.', 'Prepare a new snapshot and review its exact receipt before confirming.', [{ scope: 'artifact' }]);
    const currentSnapshot = strictSnapshot(dashboard, requestRow.created_at);
    const built = buildArtifact(config, dashboard, requestRow.created_at);
    const drift = snapshotDrift(preparedSnapshot, currentSnapshot.snapshot);
    if (currentSnapshot.manifestSha256 !== requestRow.manifest_sha256
      || currentSnapshot.manifestJson !== requestRow.manifest_json) {
      if (!drift.length) drift.push({ scope: 'dashboard' });
    }
    if (built.contentSha256 !== expectedContentHash || built.contentSha256 !== requestRow.content_sha256) {
      drift.push({ scope: 'artifact' });
    }
    if (drift.length) publicationError(
      'publication_snapshot_drift',
      'The prepared snapshot no longer matches the current dashboard.',
      'Prepare a new snapshot and review its exact receipt before confirming.',
      [...new Map(drift.map(item => [`${item.scope}:${item.widgetId ?? ''}`, item])).values()],
    );

    const isHarmony = config.provider === 'harmony';
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
          (id, dashboard_id, publisher_id, object_key, url, status,
           content_sha256, config_sha256, manifest_sha256, manifest_json, share_request_id)
        VALUES (?, ?, ?, ?, ?, 'publishing', ?, ?, ?, ?, ?)
      `).run(
        publicationId, dashboard.id, providerId, objectKey, url,
        requestRow.content_sha256, requestRow.config_sha256,
        requestRow.manifest_sha256, requestRow.manifest_json, requestId,
      );
      return true;
    })();
    if (!consumed) publicationError('invalid_confirmation', 'Share confirmation was already consumed.', 'Prepare a new snapshot before publishing again.');

    try {
      if (dashboardPublishAdapter) {
        const effect = await dashboardPublishAdapter({
          provider: providerId,
          dashboardId: dashboard.id,
          objectKey,
          url,
          artifact: built.artifact,
          harmony: config.harmony,
          s3: {
            bucket: config.s3.bucket,
            region: config.s3.region,
            awsProfile: config.s3.awsProfile,
          },
        });
        db.prepare(`
          UPDATE dashboard_publications
          SET deployed = ?, content_verified = ?, visibility_converged = ?, updated_at = datetime('now')
          WHERE id = ?
        `).run(
          effect?.deployed === true ? 1 : 0,
          effect?.contentVerified === true ? 1 : 0,
          effect?.visibilityConverged === true ? 1 : 0,
          publicationId,
        );
        if (effect?.deployed !== true || effect.contentVerified !== true || effect.visibilityConverged !== true) {
          throw new Error('Dashboard publisher adapter returned without a complete deployed/content/audience verification receipt.');
        }
      } else if (built.artifact.provider === 'harmony') {
        const deployed = await harmonyDashboardPublishAdapter({
          settings: config.harmony,
          dashboardId: dashboard.id,
          bundle: built.artifact.bundle,
          listingHtml: built.artifact.listingHtml,
          // Owner ruling: audience convergence is PART of the deploy step.
          ensureViewerAccess: harmonyHooks?.ensureViewerAccess,
        });
        db.prepare(`
          UPDATE dashboard_publications
          SET deployed = 1, visibility_converged = ?, updated_at = datetime('now')
          WHERE id = ?
        `).run(deployed.visibilityConverged ? 1 : 0, publicationId);
        if (!deployed.visibilityConverged || !harmonyHooks?.verifyStaticArtifact) {
          throw new Error('Harmony deploy completed, but audience/content verification is unavailable.');
        }
        const verifyFiles = built.artifact.bundle.files.map(file => {
          const content = typeof file.content === 'string' ? Buffer.from(file.content, 'utf8') : file.content;
          return { relativePath: `${objectKey}${file.path}`, bytes: content.length, sha256: sha256(content) };
        });
        const listing = Buffer.from(built.artifact.listingHtml, 'utf8');
        const rootStyle = Buffer.from(SNAPSHOT_CSS, 'utf8');
        verifyFiles.push(
          { relativePath: 'index.html', bytes: listing.length, sha256: sha256(listing) },
          { relativePath: 'assets/style.css', bytes: rootStyle.length, sha256: sha256(rootStyle) },
        );
        const verification = await harmonyHooks.verifyStaticArtifact({
          url: new URL('/', url).toString(),
          files: verifyFiles,
        });
        if (!verification.verified) throw new Error('Harmony served-file verification did not certify every publication file.');
        db.prepare(`
          UPDATE dashboard_publications SET content_verified = 1, updated_at = datetime('now') WHERE id = ?
        `).run(publicationId);
      } else {
        const client = s3ClientFactory({ region: config.s3.region, awsProfile: config.s3.awsProfile });
        try {
          // Deliberately the only AWS mutation: no ACL, bucket policy, CloudFront,
          // deletion-protection, or public-access-block changes are attempted.
          await client.send(new PutObjectCommand({
            Bucket: config.s3.bucket,
            Key: objectKey,
            Body: built.artifact.html,
            ContentType: 'text/html; charset=utf-8',
            CacheControl: 'public, max-age=300, immutable',
            ContentDisposition: 'inline',
          }));
          db.prepare(`
            UPDATE dashboard_publications
            SET deployed = 1, visibility_converged = 1, updated_at = datetime('now') WHERE id = ?
          `).run(publicationId);
          const downloaded = await client.send(new GetObjectCommand({ Bucket: config.s3.bucket, Key: objectKey }));
          if (!downloaded.Body) throw new Error('S3 object verification returned no body.');
          const verifiedBytes = Buffer.from(await downloaded.Body.transformToByteArray());
          if (sha256(verifiedBytes) !== built.contentSha256) {
            throw new Error('S3 object bytes differ from the confirmed publication artifact.');
          }
          db.prepare(`
            UPDATE dashboard_publications SET content_verified = 1, updated_at = datetime('now') WHERE id = ?
          `).run(publicationId);
        } finally {
          client.destroy();
        }
      }
      db.transaction(() => {
        const completed = db.prepare(`
          UPDATE dashboard_publications
          SET status = 'published', published_at = datetime('now'), updated_at = datetime('now')
          WHERE id = ? AND deployed = 1 AND content_verified = 1 AND visibility_converged = 1
        `).run(publicationId);
        if (completed.changes !== 1) throw new Error('Publication effect did not reach a fully verified state.');
        db.prepare("UPDATE dashboard_publishers SET last_error = NULL, updated_at = datetime('now') WHERE id = ?").run(providerId);
      })();
    } catch (error: any) {
      const message = String(error?.message ?? error).slice(0, 4000);
      const deployed = error?.deployed === true ? 1 : 0;
      const visibilityConverged = error?.visibilityConverged === true ? 1 : 0;
      db.transaction(() => {
        db.prepare(`
          UPDATE dashboard_publications
          SET status = 'failed', error = ?, deployed = MAX(deployed, ?),
            visibility_converged = MAX(visibility_converged, ?), updated_at = datetime('now')
          WHERE id = ?
        `).run(message, deployed, visibilityConverged, publicationId);
        db.prepare("UPDATE dashboard_publishers SET last_error = ?, updated_at = datetime('now') WHERE id = ?").run(message, providerId);
      })();
      const effect = db.prepare('SELECT deployed, content_verified, visibility_converged FROM dashboard_publications WHERE id = ?')
        .get(publicationId) as { deployed: number; content_verified: number; visibility_converged: number };
      const remoteEffectPossible = effect.deployed === 1;
      throw new DashboardPublicationError(
        'publication_provider_failed',
        remoteEffectPossible
          ? `Publication completion could not be verified after provider deployment: ${message}`
          : `Publication provider failed before a deploy receipt was recorded: ${message}`,
        remoteEffectPossible
          ? 'The confirmation was consumed and a partial/unknown remote effect was recorded. Inspect the destination and provider settings before preparing a replacement snapshot.'
          : 'The confirmation was consumed and the failed exact receipt was recorded. Resolve the provider issue, then prepare and confirm a new snapshot.',
      );
    }

    const publication = mapPublication(db.prepare('SELECT * FROM dashboard_publications WHERE id = ?').get(publicationId));
    return { publication, url };
  }

  async function publish(dashboardId: string, confirmationToken: string): Promise<{ publication: AnalyticsPublication; url: string }> {
    return withProviderMutation(() => publishUnlocked(dashboardId, confirmationToken));
  }

  function listStaticArtifactAttempts(limit = 10): StaticArtifactPublishResult[] {
    const bounded = Math.min(50, Math.max(1, Math.floor(Number(limit) || 10)));
    return (db.prepare(`
      SELECT * FROM static_artifact_publications
      ORDER BY datetime(created_at) DESC, rowid DESC LIMIT ?
    `).all(bounded) as any[]).map(mapStaticArtifactPublication);
  }

  async function publishStaticArtifactUnlocked(input: StaticArtifactPublishInput): Promise<StaticArtifactPublishResult> {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new Error('Static artifact publish input must be an object');
    }
    const config = requireReadyConfig();
    if (config.provider !== 'harmony') {
      throw new Error('Static artifact publishing currently requires Amazon Harmony to be the active Dashboard sharing provider');
    }
    const requestedVisibility = input.visibility == null
      ? config.harmony.visibility
      : String(input.visibility);
    if (requestedVisibility !== 'everyone' && requestedVisibility !== 'private') {
      throw new Error('visibility must be everyone or private when provided');
    }
    if (requestedVisibility !== config.harmony.visibility) {
      throw new Error(`Requested visibility ${requestedVisibility} does not match the configured app-wide Harmony visibility ${config.harmony.visibility}. Change it in Settings → Dashboard sharing first; this tool never changes the audience of existing shares.`);
    }
    const bundle = buildStaticArtifactBundle({
      filePath: clean(input.filePath, 'filePath', 2000, true),
      ...(input.slug ? { slug: clean(input.slug, 'slug', 100, true) } : {}),
      ...(Array.isArray(input.assetPaths) ? { assetPaths: input.assetPaths.map(value => clean(value, 'assetPaths entry', 1000, true)) } : {}),
      ...(staticFilesRoot ? { filesRoot: staticFilesRoot } : {}),
    });
    const appName = harmonyAppName();
    const url = harmonyStaticArtifactUrl(config.harmony, bundle.slug, appName);
    const dryRun: StaticArtifactPublishResult = {
      ok: true,
      outcome: 'dry_run',
      provider: 'harmony',
      published: false,
      dryRun: true,
      phase: 'prepared',
      deployed: false,
      contentVerified: false,
      visibilityConverged: false,
      canonicalMirrorSynchronized: true,
      appName,
      stage: config.harmony.stage,
      visibility: config.harmony.visibility,
      slug: bundle.slug,
      sourcePath: bundle.sourcePath,
      url,
      manifestSha256: bundle.manifestSha256,
      totalBytes: bundle.totalBytes,
      files: bundle.manifest,
      transformations: bundle.transformations,
    };
    if (input.dryRun === true) return dryRun;
    if (input.ownerRequested !== true) {
      throw new Error('ownerRequested must be true for a real Harmony publish and may only reflect an explicit request in the current conversation');
    }
    if (!harmonyHooks) {
      throw new Error('Harmony viewer-access/content verification is unavailable in this build; nothing was published');
    }

    let row: any = null;
    if (input.resumeAttemptId) {
      row = db.prepare('SELECT * FROM static_artifact_publications WHERE id = ?').get(clean(input.resumeAttemptId, 'resumeAttemptId', 128, true));
      if (!row) throw new Error(`Static publish attempt ${input.resumeAttemptId} not found`);
      if (
        row.source_path !== bundle.sourcePath ||
        row.manifest_sha256 !== bundle.manifestSha256 || row.slug !== bundle.slug ||
        row.app_name !== appName || row.stage !== config.harmony.stage || row.visibility !== config.harmony.visibility
      ) {
        throw new Error('resumeAttemptId does not match the current artifact bytes or Harmony configuration; start a new publish without resumeAttemptId');
      }
    } else {
      row = db.prepare(`
        SELECT * FROM static_artifact_publications
        WHERE source_path = ? AND slug = ? AND manifest_sha256 = ? AND app_name = ? AND stage = ? AND visibility = ?
          AND (deployed = 1 OR phase = 'published')
        ORDER BY datetime(created_at) DESC, rowid DESC LIMIT 1
      `).get(bundle.sourcePath, bundle.slug, bundle.manifestSha256, appName, config.harmony.stage, config.harmony.visibility);
    }
    if (row?.phase === 'published' && row.content_verified === 1
      && row.visibility_converged === 1 && row.mirror_synchronized === 1) {
      return mapStaticArtifactPublication(row);
    }

    const attemptId = row?.id ?? `static_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
    if (!row) {
      db.prepare(`
        INSERT INTO static_artifact_publications (
          id, source_path, slug, manifest_sha256, manifest_json, total_bytes,
          transformations_json, app_name, stage, visibility, url, phase
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'prepared')
      `).run(
        attemptId, bundle.sourcePath, bundle.slug, bundle.manifestSha256,
        JSON.stringify(bundle.manifest), bundle.totalBytes, JSON.stringify(bundle.transformations),
        appName, config.harmony.stage, config.harmony.visibility, url,
      );
      row = db.prepare('SELECT * FROM static_artifact_publications WHERE id = ?').get(attemptId);
    }

    const adoptingExisting = input.verifyExisting === true && row.deployed !== 1;
    if (adoptingExisting) {
      // Verify the claimed remote route before adding it to the canonical
      // mirror. Until both remote checks pass, a later whole-app deploy must
      // not be able to carry this unverified candidate.
      db.prepare(`
        UPDATE static_artifact_publications
        SET phase = 'deployed', deployed = 1, mirror_synchronized = 0,
          deployed_at = ?, error = NULL, updated_at = datetime('now')
        WHERE id = ?
      `).run(new Date().toISOString(), attemptId);
      row = db.prepare('SELECT * FROM static_artifact_publications WHERE id = ?').get(attemptId);
    }

    if (!adoptingExisting && (row.deployed !== 1 || row.mirror_synchronized !== 1)) {
      db.prepare(`
        UPDATE static_artifact_publications
        SET phase = 'deploying', error = NULL,
          content_verified = CASE WHEN mirror_synchronized = 0 THEN 0 ELSE content_verified END,
          visibility_converged = CASE WHEN mirror_synchronized = 0 THEN 0 ELSE visibility_converged END,
          updated_at = datetime('now')
        WHERE id = ?
      `).run(attemptId);
      try {
        const deployed = await staticPublishAdapter({ settings: config.harmony, bundle });
        db.prepare(`
          UPDATE static_artifact_publications
          SET phase = 'deployed', deployed = 1, mirror_synchronized = 1,
            deployed_at = ?, error = NULL, updated_at = datetime('now')
          WHERE id = ?
        `).run(deployed.deploy.deployedAt, attemptId);
      } catch (error: any) {
        const message = String(error?.message ?? error).slice(0, 4000);
        const newlyDeployed = error?.deployed === true;
        const hasRemoteEffect = row.deployed === 1 || newlyDeployed;
        const mirrorSynchronized = error?.canonicalMirrorSynchronized === false
          ? 0
          : newlyDeployed
            ? 1
            : row.mirror_synchronized === 1 ? 1 : 0;
        db.transaction(() => {
          db.prepare(`
            UPDATE static_artifact_publications
            SET phase = ?, deployed = MAX(deployed, ?), mirror_synchronized = ?,
              deployed_at = COALESCE(deployed_at, ?), error = ?, updated_at = datetime('now') WHERE id = ?
          `).run(
            hasRemoteEffect ? 'failed_after_deploy' : 'failed_pre_deploy',
            newlyDeployed ? 1 : 0,
            mirrorSynchronized,
            newlyDeployed ? (error?.deploy?.deployedAt ?? new Date().toISOString()) : null,
            message,
            attemptId,
          );
          db.prepare("UPDATE dashboard_publishers SET last_error = ?, updated_at = datetime('now') WHERE id = 'harmony'").run(message);
        })();
        if (hasRemoteEffect) {
          return mapStaticArtifactPublication(db.prepare('SELECT * FROM static_artifact_publications WHERE id = ?').get(attemptId));
        }
        throw new Error(`Static artifact deploy failed before a successful deploy receipt: ${message}`);
      }
    }

    row = db.prepare('SELECT * FROM static_artifact_publications WHERE id = ?').get(attemptId);
    if (row.visibility_converged !== 1) {
      db.prepare("UPDATE static_artifact_publications SET phase = 'converging', error = NULL, updated_at = datetime('now') WHERE id = ?").run(attemptId);
      try {
        const access = await harmonyHooks.ensureViewerAccess({ appName, settings: config.harmony });
        db.prepare(`
          UPDATE static_artifact_publications
          SET visibility_converged = 1, resource_id = ?, phase = 'verifying_content', error = NULL, updated_at = datetime('now')
          WHERE id = ?
        `).run(access.resourceId, attemptId);
      } catch (error: any) {
        const message = String(error?.message ?? error).slice(0, 4000);
        db.transaction(() => {
          db.prepare("UPDATE static_artifact_publications SET phase = 'failed_after_deploy', error = ?, updated_at = datetime('now') WHERE id = ?").run(message, attemptId);
          db.prepare("UPDATE dashboard_publishers SET last_error = ?, updated_at = datetime('now') WHERE id = 'harmony'").run(message);
        })();
        return mapStaticArtifactPublication(db.prepare('SELECT * FROM static_artifact_publications WHERE id = ?').get(attemptId));
      }
    }

    row = db.prepare('SELECT * FROM static_artifact_publications WHERE id = ?').get(attemptId);
    if (row.content_verified !== 1) {
      db.prepare("UPDATE static_artifact_publications SET phase = 'verifying_content', error = NULL, updated_at = datetime('now') WHERE id = ?").run(attemptId);
      try {
        await harmonyHooks.verifyStaticArtifact({
          url,
          files: bundle.manifest.map(file => ({ relativePath: file.relativePath, bytes: file.bytes, sha256: file.sha256 })),
        });
        db.prepare("UPDATE static_artifact_publications SET content_verified = 1, error = NULL, updated_at = datetime('now') WHERE id = ?").run(attemptId);
      } catch (error: any) {
        const message = String(error?.message ?? error).slice(0, 4000);
        db.transaction(() => {
          db.prepare("UPDATE static_artifact_publications SET phase = 'failed_after_deploy', error = ?, updated_at = datetime('now') WHERE id = ?").run(message, attemptId);
          db.prepare("UPDATE dashboard_publishers SET last_error = ?, updated_at = datetime('now') WHERE id = 'harmony'").run(message);
        })();
        return mapStaticArtifactPublication(db.prepare('SELECT * FROM static_artifact_publications WHERE id = ?').get(attemptId));
      }
    }

    row = db.prepare('SELECT * FROM static_artifact_publications WHERE id = ?').get(attemptId);
    if (row.mirror_synchronized !== 1) {
      try {
        staticMirrorAdapter({ settings: config.harmony, bundle });
        db.prepare(`
          UPDATE static_artifact_publications
          SET mirror_synchronized = 1, error = NULL, updated_at = datetime('now') WHERE id = ?
        `).run(attemptId);
      } catch (error: any) {
        const message = String(error?.message ?? error).slice(0, 4000);
        db.transaction(() => {
          db.prepare(`
            UPDATE static_artifact_publications
            SET phase = 'failed_after_deploy', mirror_synchronized = 0,
              error = ?, updated_at = datetime('now') WHERE id = ?
          `).run(message, attemptId);
          db.prepare("UPDATE dashboard_publishers SET last_error = ?, updated_at = datetime('now') WHERE id = 'harmony'").run(message);
        })();
        return mapStaticArtifactPublication(db.prepare('SELECT * FROM static_artifact_publications WHERE id = ?').get(attemptId));
      }
    }

    const publishedAt = new Date().toISOString();
    db.transaction(() => {
      const completed = db.prepare(`
        UPDATE static_artifact_publications
        SET phase = 'published', content_verified = 1, visibility_converged = 1,
          error = NULL, published_at = ?, updated_at = datetime('now')
        WHERE id = ? AND deployed = 1 AND mirror_synchronized = 1
          AND content_verified = 1 AND visibility_converged = 1
      `).run(publishedAt, attemptId);
      if (completed.changes !== 1) throw new Error('Static artifact cannot be certified until its canonical mirror and remote effect receipts all agree.');
      db.prepare("UPDATE dashboard_publishers SET last_error = NULL, updated_at = datetime('now') WHERE id = 'harmony'").run();
    })();
    return mapStaticArtifactPublication(db.prepare('SELECT * FROM static_artifact_publications WHERE id = ?').get(attemptId));
  }

  async function publishStaticArtifact(input: StaticArtifactPublishInput): Promise<StaticArtifactPublishResult> {
    if (input?.dryRun === true) return publishStaticArtifactUnlocked(input);
    return withProviderMutation(() => publishStaticArtifactUnlocked(input));
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

  return {
    getConfig,
    updateConfig,
    createShareRequest,
    publish,
    publishStaticArtifact,
    listStaticArtifactAttempts,
    probeHarmonySetup,
    installHarmonyCli,
    planHarmonyProvisioning,
    provisionHarmonyIdentity,
  };
}
