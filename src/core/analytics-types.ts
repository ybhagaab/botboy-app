export type AnalyticsWidgetKind = 'metric' | 'table' | 'bar' | 'line' | 'text' | 'visualization';
export type AnalyticsDashboardStatus = 'draft' | 'ready' | 'refreshing' | 'degraded' | 'archived';
export type AnalyticsRefreshTrigger = 'manual' | 'scheduled' | 'agent';

export interface AnalyticsWidgetInput {
  kind: AnalyticsWidgetKind;
  title: string;
  subtitle?: string;
  sql?: string;
  preset?: string;
  config?: Record<string, unknown>;
}

export interface CreateAnalyticsDashboardInput {
  title: string;
  description?: string;
  theme?: string;
  projectIds?: string[];
  widgets: AnalyticsWidgetInput[];
}

export interface UpdateAnalyticsDashboardInput {
  title?: string;
  description?: string;
  theme?: string;
  status?: AnalyticsDashboardStatus;
  projectIds?: string[];
  widgets?: AnalyticsWidgetInput[];
}

export interface AnalyticsWidgetResult {
  trust: 'external_untrusted_data' | 'local_static_content';
  columns: string[];
  rows: Array<Array<string | number | boolean | null>>;
  rowCount: number;
  displayedRowCount: number;
  executionTimeMs?: number;
  rawPreview?: string;
  refreshedAt: string;
  /** Which data lane produced this result (etl-analytics A4). Absent on pre-A4 results = sql-mcp. */
  lane?: 'sql-mcp' | 'etl';
}

export interface AnalyticsWidget {
  id: string;
  dashboardId: string;
  position: number;
  kind: AnalyticsWidgetKind;
  title: string;
  subtitle: string;
  sql?: string;
  preset?: string;
  config: Record<string, unknown>;
  result?: AnalyticsWidgetResult;
  lastError?: string;
  lastRefreshedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface AnalyticsSchedule {
  id: string;
  dashboardId: string;
  enabled: boolean;
  scheduleKind: 'daily';
  localTime: string;
  timezone: string;
  nextRunAt: string;
  lastRunAt?: string;
  consecutiveFailures: number;
  lastError?: string;
}

export interface UpdateAnalyticsScheduleInput {
  enabled: boolean;
  localTime: string;
  timezone: string;
}

export interface AnalyticsPublication {
  id: string;
  dashboardId: string;
  publisherId: string;
  objectKey: string;
  url?: string;
  status: 'publishing' | 'published' | 'failed';
  contentSha256: string;
  error?: string;
  createdAt: string;
  publishedAt?: string;
}

export type AnalyticsRunStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface AnalyticsRun {
  id: string;
  dashboardId: string;
  trigger: AnalyticsRefreshTrigger;
  status: AnalyticsRunStatus;
  widgetCount: number;
  widgetsCompleted: number;
  widgetsSucceeded: number;
  currentWidgetId?: string;
  /** Owner asked to stop; the worker honors it between widgets. */
  cancelRequested: boolean;
  /** Widget ids currently executing (populated for running runs; the pool runs up to 6). */
  runningWidgetIds?: string[];
  queuedAt: string;
  startedAt?: string;
  heartbeatAt?: string;
  leaseExpiresAt?: string;
  error?: string;
  completedAt?: string;
}

export interface AnalyticsDashboardSummary {
  id: string;
  title: string;
  description: string;
  theme: string;
  status: AnalyticsDashboardStatus;
  widgetCount: number;
  projectCount: number;
  lastError?: string;
  lastRefreshedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface AnalyticsDashboard extends AnalyticsDashboardSummary {
  projectIds: string[];
  widgets: AnalyticsWidget[];
  schedule?: AnalyticsSchedule;
  latestPublication?: AnalyticsPublication;
  recentRuns: AnalyticsRun[];
}

/** Sharing providers (DASHBOARD_SHARING_PLAN §3). 'sftp' is announced but not wired yet. */
export type PublisherProviderId = 'harmony' | 's3-cloudfront' | 'sftp';

export interface S3PublisherSettings {
  bucket: string;
  prefix: string;
  region: string;
  awsProfile: string;
  cloudFrontBaseUrl: string;
}

export interface HarmonyPublisherSettings {
  /** Team-owned software-app bindle (amzn1.bindle.resource.*) — first deploy binds it permanently. */
  bindleId: string;
  /** Harmony stage to deploy to (prod runs under a PTY; beta/gamma are non-interactive). */
  stage: 'beta' | 'gamma' | 'prod';
  /** Viewer audience, converged on every publish: everyone at Amazon, or only the publisher. */
  visibility: 'everyone' | 'private';
}

/** Settings + derived display fields for the settings card. */
export interface HarmonyPublisherView extends HarmonyPublisherSettings {
  /** Derived (`<alias>-botboy-dashboard`) — never a user choice. */
  appName: string;
}

export interface DashboardPublisherProviderSummary {
  id: PublisherProviderId;
  displayName: string;
  enabled: boolean;
  configured: boolean;
  /** 'sftp' ships as a visible-but-disabled card in phase 1. */
  available: boolean;
  lastError?: string;
  updatedAt: string;
}

export interface DashboardPublisherConfig {
  /** The single active provider (enabled + configured), if any. */
  id: PublisherProviderId | null;
  displayName: string;
  enabled: boolean;
  configured: boolean;
  providers: DashboardPublisherProviderSummary[];
  /** Provider settings for the settings page forms. */
  s3: S3PublisherSettings;
  harmony: HarmonyPublisherView;
  lastError?: string;
  updatedAt: string;
}

export interface UpdateDashboardPublisherInput {
  /** Which provider this update targets. Omitted = legacy S3 shape (back-compat). */
  provider?: PublisherProviderId;
  enabled: boolean;
  // s3 fields (legacy flat shape kept for the existing form/API consumers)
  bucket?: string;
  prefix?: string;
  region?: string;
  awsProfile?: string;
  cloudFrontBaseUrl?: string;
  // harmony fields (appName/appDir are DERIVED — not accepted as input)
  bindleId?: string;
  stage?: string;
  visibility?: string;
}

export interface DashboardShareRequest {
  dashboardId: string;
  confirmationToken: string;
  expiresAt: string;
  destination: string;
  objectKey: string;
  contentSha256: string;
  warning: string;
}

export interface DashboardPublishResult {
  publication: AnalyticsPublication;
  url: string;
}

export interface HarmonySetupProbe {
  cliPresent: boolean;
  cliVersion?: string;
  bindleConfigured: boolean;
  /** CLI deploys need a live ~/.midway jar — independent of browser Midway. */
  midwayLive: boolean;
  ready: boolean;
  nextAction: 'install-cli' | 'configure-bindle' | 'ready';
  detail: string;
}

export interface HarmonyProvisioningPlan {
  alias: string;
  teamName: string;
  bindleName: string;
  appName: string;
  summary: string;
}

export interface HarmonyProvisionOutcome {
  teamId: string;
  bindleId: string;
  teamName: string;
  bindleName: string;
  createdTeam: boolean;
  createdBindle: boolean;
  detail: string;
  /** Config after the bindle ID was merged into the Harmony provider row. */
  publisher: DashboardPublisherConfig;
}

export interface DashboardPublisherService {
  getConfig(): DashboardPublisherConfig;
  updateConfig(input: UpdateDashboardPublisherInput): DashboardPublisherConfig;
  createShareRequest(dashboardId: string): DashboardShareRequest;
  publish(dashboardId: string, confirmationToken: string): Promise<DashboardPublishResult>;
  /** Harmony setup stepper: where is the owner in install-cli → bindle → ready? */
  probeHarmonySetup(): Promise<HarmonySetupProbe>;
  /** One-click `toolbox install harmonycli` (the 99% first-run path). */
  installHarmonyCli(): Promise<{ ok: boolean; detail: string; probe: HarmonySetupProbe }>;
  /** What automated provisioning WOULD create (the confirm card content). */
  planHarmonyProvisioning(): HarmonyProvisioningPlan;
  /** Create team + bindle (idempotent) and store the bindle ID in the Harmony config. */
  provisionHarmonyIdentity(): Promise<HarmonyProvisionOutcome>;
}

export interface AnalyticsDashboardService {
  listDashboards(): AnalyticsDashboardSummary[];
  getDashboard(id: string): AnalyticsDashboard | null;
  createDashboard(input: CreateAnalyticsDashboardInput, refreshTrigger?: AnalyticsRefreshTrigger): AnalyticsDashboard;
  updateDashboard(id: string, input: UpdateAnalyticsDashboardInput): AnalyticsDashboard;
  deleteDashboard(id: string): void;
  setSchedule(id: string, input: UpdateAnalyticsScheduleInput): AnalyticsSchedule;
  enqueueRefresh(id: string, trigger?: AnalyticsRefreshTrigger): AnalyticsRun;
  getRun(id: string): AnalyticsRun | null;
  /**
   * Stop the dashboard's active refresh. A queued run cancels immediately;
   * a running run is flagged and the worker stops after the widget query
   * already in flight (an MCP SQL call cannot be aborted mid-call).
   */
  cancelActiveRun(dashboardId: string): { result: 'cancelled' | 'stopping' | 'none'; run: AnalyticsRun | null };
  recoverInterruptedRuns(): number;
  processQueuedRuns(limit?: number): Promise<number>;
}
