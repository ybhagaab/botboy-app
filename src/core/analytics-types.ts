import type {
  AnalyticsControlApplyInput,
  AnalyticsDatasetControlState,
  AnalyticsDateRange,
  AnalyticsRequest,
  AnalyticsSemanticReceipt,
} from './analytics-data-room-types.js';

export type AnalyticsWidgetKind = 'metric' | 'table' | 'bar' | 'line' | 'text' | 'visualization' | 'html';
export type AnalyticsDashboardStatus = 'draft' | 'ready' | 'refreshing' | 'degraded' | 'waiting_for_data' | 'archived';
export type AnalyticsRefreshTrigger = 'manual' | 'scheduled' | 'agent';

export interface AnalyticsWidgetInput {
  kind: AnalyticsWidgetKind;
  title: string;
  subtitle?: string;
  sql?: string;
  preset?: string;
  /**
   * Optional data source for dashboard create/update. data_room_query reads
   * one ready Data Room dataset locally (resolved to its current verified
   * version); warehouse_sql is equivalent to top-level sql/preset.
   */
  source?: AnalyticsWidgetSourceInput;
  config?: Record<string, unknown>;
}

export type AnalyticsWidgetSourceInput =
  | { kind: 'warehouse_sql'; sql: string; preset?: string }
  | {
      kind: 'data_room_query';
      datasetId: string;
      sql: string;
      params?: Array<string | number | boolean | null>;
      limit?: number;
    };

export type AnalyticsWidgetSourceV1 =
  | { version: 1; kind: 'warehouse_sql' }
  | {
      version: 1;
      kind: 'data_room_query';
      datasetId: string;
      versionId: string;
      sql: string;
      params: Array<string | number | boolean | null>;
      limit: number;
    };

export interface ConfigureAnalyticsWidgetSourceInput {
  expectedWidgetRevision: number;
  source: AnalyticsWidgetSourceInput;
}

export interface AnalyticsWidgetSourceMutationResult {
  widget: AnalyticsWidget;
  run: AnalyticsRun;
  sourceConfigSha256: string;
}

export type AnalyticsWidgetBindingVersionPolicy = 'pinned' | 'latest_compatible' | 'latest_fresh';
export type AnalyticsWidgetBindingCompatibility = 'compatible' | 'waiting' | 'incompatible';

/** Owner-authored, deterministic local-view contract. The request is normalized
 * with use=dashboard and exact dataset/version identity by the binding service. */
export interface AnalyticsWidgetDataRoomBindingInput {
  datasetId: string;
  versionPolicy: AnalyticsWidgetBindingVersionPolicy;
  pinnedVersionId?: string;
  expectedSchemaSha256: string;
  expectedContractSha256?: string;
  requiredColumns: string[];
  request: AnalyticsRequest;
  presentationLimit: number;
}

export interface AnalyticsWidgetDataRoomBinding {
  widgetId: string;
  datasetId: string;
  revision: number;
  versionPolicy: AnalyticsWidgetBindingVersionPolicy;
  pinnedVersionId?: string;
  expectedSchemaSha256: string;
  expectedContractSha256?: string;
  requiredColumns: string[];
  request: AnalyticsRequest;
  requestSha256: string;
  presentationLimit: number;
  compatibility: AnalyticsWidgetBindingCompatibility;
  compatibilityError?: string;
  observedHeadRevision: number;
  lastQueuedVersionId?: string;
  lastAppliedVersionId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface UpdateAnalyticsWidgetInput {
  expectedRevision: number;
  widget: AnalyticsWidgetInput;
}

export interface UpdateAnalyticsWidgetBindingInput {
  /** Zero creates the first binding; a positive exact revision updates/removes it. */
  expectedRevision: number;
  binding: AnalyticsWidgetDataRoomBindingInput | null;
}

export interface AnalyticsWidgetBindingMutationResult {
  outcome: 'queued' | 'cleared';
  widget: AnalyticsWidget;
  /** Monotonic generation, including removals; use this for the next CAS. */
  bindingRevision: number;
  run?: AnalyticsRun;
}

export interface AnalyticsWidgetControlMutationResult {
  outcome: 'queued' | 'no_op';
  widget: AnalyticsWidget;
  controls: AnalyticsDatasetControlState;
  run?: AnalyticsRun;
}

export type AnalyticsWidgetEditAction =
  | 'presentation'
  | 'date_range'
  | 'add_from_widget'
  | 'combine_compatible_widgets';

export type AnalyticsWidgetEditRenderer = 'line' | 'bar' | 'area' | 'point';

/** Model-visible presentation intent. SQL, bindings, semantic hashes, and
 * revisions are deliberately server-owned. */
export interface AnalyticsWidgetEditPresentation {
  renderer?: AnalyticsWidgetEditRenderer;
  title?: string;
  subtitle?: string;
  layout?: 'vconcat' | 'hconcat';
}

export interface AnalyticsWidgetEditInput {
  action: AnalyticsWidgetEditAction;
  dashboardId: string;
  /** One exact source/target for presentation/date/add; exactly two for combine. */
  widgetIds: string[];
  presentation?: AnalyticsWidgetEditPresentation;
  dateRange?: AnalyticsDateRange;
}

export interface AnalyticsWidgetEditOwnerScope {
  /**
   * Provenance of the edit target: IDs the owner typed, the owner's visible
   * widget selection, or targets the chat model resolved from the owner's
   * natural-language request. The server validates every target identically.
   */
  source: 'dashboard_widget_selection' | 'owner_exact_ids' | 'model_resolved';
  dashboardId: string;
  orderedWidgetIds: string[];
}

export interface AnalyticsWidgetEditRequestIdentity {
  ownerRequestId: string;
  ownerMessage: string;
  ownerScope: AnalyticsWidgetEditOwnerScope;
  /** Owner asked for another copy even if identical (the edit tool's createNew argument). */
  explicitNew: boolean;
}

export type AnalyticsWidgetEditReplayReason = 'same_request' | 'semantic_intent';

export type AnalyticsWidgetEditErrorCode =
  | 'invalid_input'
  | 'data_room_unavailable'
  | 'not_found'
  | 'archived'
  | 'active_run'
  | 'binding_required'
  | 'binding_not_compatible'
  | 'result_provenance_mismatch'
  | 'max_widgets'
  | 'derived_data_required'
  | 'request_identity_conflict'
  | 'replay_target_invalid'
  | 'conflict';

export interface AnalyticsWidgetEditMutationResult {
  action: AnalyticsWidgetEditAction;
  dashboardId: string;
  sourceWidgetIds: string[];
  widget: AnalyticsWidget;
  createdWidgetId?: string;
  resultDisposition: 'preserved' | 'refresh_queued';
  run?: AnalyticsRun;
  /** Durable add/combine identity. Absent for presentation/date edits. */
  receiptId?: string;
  intentVersion?: 1;
  intentSha256?: string;
  effectSha256?: string;
  explicitNew?: boolean;
  idempotentReplay?: boolean;
  replayReason?: AnalyticsWidgetEditReplayReason;
  effectAppliedThisCall?: boolean;
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
  trust: 'external_untrusted_data' | 'local_static_content' | 'local_verified_data';
  columns: string[];
  rows: Array<Array<string | number | boolean | null>>;
  rowCount: number;
  displayedRowCount: number;
  executionTimeMs?: number;
  rawPreview?: string;
  refreshedAt: string;
  /** Which remote lane produced a legacy result. Absent for local/static results. */
  lane?: 'sql-mcp' | 'etl';
  /** Exact source receipt. The data-room branch never contains private paths. */
  source?:
    | {
        provider: 'datanet';
        runId: string;
        remoteStatus: 'SUCCESS';
        resultSha256?: string;
        resultBytes?: number;
        reconciled?: boolean;
      }
    | {
        provider: 'data-room-query';
        datasetId: string;
        versionId: string;
        widgetRevision: number;
        sourceConfigSha256: string;
        querySha256: string;
        compilerVersion: string;
        contentSha256: string;
        schemaSha256: string;
        contractSha256: string;
        definitionSha256: string;
        integrityVerifiedAt: string;
      }
    | {
        provider: 'data-room';
        datasetId: string;
        versionId: string;
        bindingRevision: number;
        widgetRevision: number;
        querySha256: string;
        compilerVersion: string;
        contentSha256: string;
        schemaSha256: string;
        contractSha256: string;
        definitionSha256: string;
        requestSha256?: string;
        controlRevision?: number;
        controlDefinitionSha256?: string;
        controlValuesSha256?: string;
        effectiveViewRequestSha256?: string;
        semanticReceipt: AnalyticsSemanticReceipt;
      };
}

export interface AnalyticsWidget {
  id: string;
  dashboardId: string;
  /** Optimistic mutation token; unrelated widget edits never change it. */
  revision: number;
  /** Monotonic binding generation; advances even when the binding is removed. */
  bindingRevision: number;
  position: number;
  kind: AnalyticsWidgetKind;
  title: string;
  subtitle: string;
  sql?: string;
  preset?: string;
  config: Record<string, unknown>;
  binding?: AnalyticsWidgetDataRoomBinding;
  controls?: AnalyticsDatasetControlState;
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

export interface DashboardPublicationDataRoomIdentityV1 {
  datasetId: string;
  datasetDefinitionRevision: number;
  bindingRevision: number;
  bindingSha256: string;
  versionPolicy: AnalyticsWidgetDataRoomBinding['versionPolicy'];
  pinnedVersionId?: string;
  lastAppliedVersionId: string;
  head: {
    versionId?: string;
    headRevision: number;
    definitionRevision?: number;
  };
  control: {
    revision: number;
    projected: boolean;
    definitionSha256: string;
    valuesSha256: string;
    effectiveViewRequestSha256: string;
  };
  versionId: string;
  requestSha256: string;
  querySha256: string;
  compilerVersion: string;
  contentSha256: string;
  schemaSha256: string;
  contractSha256: string;
  definitionSha256: string;
  semanticReceiptSha256: string;
}

/**
 * An independent Data Room widget (config.dataSource kind data_room_query) at
 * publication: its result came from exactly this configured source, the
 * dataset's current head, and a version that verifies for publication now.
 */
export interface DashboardPublicationDataRoomQueryIdentityV1 {
  datasetId: string;
  versionId: string;
  headRevision: number;
  sourceConfigSha256: string;
  querySha256: string;
  compilerVersion: string;
  contentSha256: string;
  schemaSha256: string;
  contractSha256: string;
  definitionSha256: string;
}
export interface DashboardPublicationWidgetSnapshotV1 {
  widgetId: string;
  position: number;
  widgetRevision: number;
  bindingGeneration: number;
  presentationSha256: string;
  resultSha256?: string;
  dataRoom?: DashboardPublicationDataRoomIdentityV1;
  dataRoomQuery?: DashboardPublicationDataRoomQueryIdentityV1;
}

export interface DashboardPublicationSnapshotV1 {
  version: 1;
  dashboardId: string;
  snapshotCreatedAt: string;
  presentationSha256: string;
  resultSha256: string;
  widgets: DashboardPublicationWidgetSnapshotV1[];
}

export interface DashboardPublicationReceiptV1 {
  snapshot: DashboardPublicationSnapshotV1;
  snapshotManifestSha256: string;
  artifactContentSha256: string;
  publisherConfigSha256: string;
}

export type DashboardPublicationDriftScope =
  | 'publisher_config'
  | 'dashboard'
  | 'widget'
  | 'binding'
  | 'control'
  | 'dataset_head'
  | 'dataset_version'
  | 'result'
  | 'semantic_receipt'
  | 'artifact';

export interface DashboardPublicationDrift {
  scope: DashboardPublicationDriftScope;
  widgetId?: string;
}

export interface AnalyticsPublication {
  id: string;
  dashboardId: string;
  publisherId: string;
  objectKey: string;
  shareRequestId?: string;
  url?: string;
  status: 'publishing' | 'published' | 'failed';
  contentSha256: string;
  deployed: boolean;
  contentVerified: boolean;
  visibilityConverged: boolean;
  receipt?: DashboardPublicationReceiptV1;
  error?: string;
  createdAt: string;
  publishedAt?: string;
}

export type AnalyticsRunStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
export type AnalyticsLateEtlState = 'pending' | 'checking' | 'applied' | 'superseded' | 'cancelled' | 'definition_changed' | 'remote_failed';

export interface AnalyticsLateEtlResult {
  runId: string;
  widgetId: string;
  externalRunId: string;
  state: AnalyticsLateEtlState;
  remoteStatus?: string;
  nextCheckAt: string;
  resultPath?: string;
  resultBytes?: number;
  resultSha256?: string;
  rowCount?: number;
  receipt?: Record<string, unknown>;
  error?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export interface AnalyticsRun {
  id: string;
  dashboardId: string;
  trigger: AnalyticsRefreshTrigger;
  status: AnalyticsRunStatus;
  refreshScope: 'full' | 'selective';
  widgetCount: number;
  widgetsCompleted: number;
  widgetsSucceeded: number;
  currentWidgetId?: string;
  /** Primary lane selected by the current/last worker claim. */
  lane?: 'sql-mcp' | 'etl';
  /** Owner asked to stop; the worker honors it between widgets. */
  cancelRequested: boolean;
  /** Widget ids currently executing. SQL is globally bounded; an ETL phase may run every remaining widget concurrently over distinct scratch pairs. */
  runningWidgetIds?: string[];
  queuedAt: string;
  startedAt?: string;
  heartbeatAt?: string;
  leaseExpiresAt?: string;
  error?: string;
  completedAt?: string;
  /** Already-submitted ETL runs whose outputs may arrive after the foreground budget. */
  lateEtlResults?: AnalyticsLateEtlResult[];
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
  latestSuccessfulPublication?: AnalyticsPublication;
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
  receipt: DashboardPublicationReceiptV1;
  warning: string;
}

export interface DashboardPublishResult {
  publication: AnalyticsPublication;
  url: string;
}

export interface StaticArtifactPublishInput {
  filePath: string;
  slug?: string;
  /** Additional files relative to the HTML file's directory. */
  assetPaths?: string[];
  /** Optional assertion; when omitted the configured app-wide visibility is used. */
  visibility?: 'everyone' | 'private';
  /** Validate/transform/hash only; never invokes Harmony. */
  dryRun?: boolean;
  /** Required true for a real external publish. */
  ownerRequested?: boolean;
  /** Resume one persisted post-deploy attempt without redeploying. */
  resumeAttemptId?: string;
  /** Adopt and verify a known already-deployed route without running Harmony deploy. */
  verifyExisting?: boolean;
}

export type StaticArtifactPublishPhase =
  | 'prepared'
  | 'deploying'
  | 'deployed'
  | 'converging'
  | 'verifying_content'
  | 'published'
  | 'failed_pre_deploy'
  | 'failed_after_deploy';

export interface StaticArtifactPublishResult {
  ok: boolean;
  outcome: 'dry_run' | 'complete' | 'partial';
  provider: 'harmony';
  published: boolean;
  dryRun: boolean;
  attemptId?: string;
  phase: StaticArtifactPublishPhase;
  deployed: boolean;
  contentVerified: boolean;
  visibilityConverged: boolean;
  canonicalMirrorSynchronized: boolean;
  appName: string;
  stage: HarmonyPublisherSettings['stage'];
  visibility: HarmonyPublisherSettings['visibility'];
  slug: string;
  sourcePath: string;
  url: string;
  manifestSha256: string;
  totalBytes: number;
  files: Array<{ relativePath: string; bytes: number; sha256: string; generated: boolean }>;
  transformations: {
    inlineStylesExternalized: number;
    inlineScriptsExternalized: number;
    localAssetsIncluded: number;
  };
  resourceId?: string;
  error?: string;
  nextAction?: string;
  createdAt?: string;
  deployedAt?: string;
  publishedAt?: string;
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
  /** Publish an existing BotBoy-files HTML artifact through the configured Harmony app. */
  publishStaticArtifact(input: StaticArtifactPublishInput): Promise<StaticArtifactPublishResult>;
  /** Recent persisted static publish attempts, newest first. */
  listStaticArtifactAttempts(limit?: number): StaticArtifactPublishResult[];
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
  /** Replace exactly one widget under optimistic revision control; its ID and siblings remain stable. */
  updateWidget(dashboardId: string, widgetId: string, input: UpdateAnalyticsWidgetInput): AnalyticsWidget;
  /** Configure one widget's independent lightweight source and queue only that widget. */
  configureWidgetSource(
    dashboardId: string,
    widgetId: string,
    input: ConfigureAnalyticsWidgetSourceInput,
  ): AnalyticsWidgetSourceMutationResult;
  /** Create/update/remove one exact data-room binding and queue only that widget when resolvable. */
  updateWidgetBinding(
    dashboardId: string,
    widgetId: string,
    input: UpdateAnalyticsWidgetBindingInput,
  ): AnalyticsWidgetBindingMutationResult;
  /** Read the exact persisted controls, or a revision-zero projection for a legacy binding. */
  getWidgetControls(dashboardId: string, widgetId: string): AnalyticsDatasetControlState;
  /** Apply one server-validated control state and queue at most one local selected run. */
  applyWidgetControls(
    dashboardId: string,
    widgetId: string,
    input: AnalyticsControlApplyInput,
  ): AnalyticsWidgetControlMutationResult;
  /** One deterministic exact data-room edit. Query-bound actions atomically
   * append/rebind and queue one selective snapshot; presentation preserves data. */
  editDataRoomWidget(
    input: AnalyticsWidgetEditInput,
    identity?: AnalyticsWidgetEditRequestIdentity,
  ): AnalyticsWidgetEditMutationResult;
  deleteDashboard(id: string): void;
  setSchedule(id: string, input: UpdateAnalyticsScheduleInput): AnalyticsSchedule;
  enqueueRefresh(id: string, trigger?: AnalyticsRefreshTrigger): AnalyticsRun;
  enqueueSelectiveRefresh(
    dashboardId: string,
    widgetIds: string[],
    trigger?: AnalyticsRefreshTrigger,
  ): AnalyticsRun;
  /** Poll hook: queue at most `limit` dashboards whose compatible bound head changed. */
  enqueueChangedBindings(limit?: number): number;
  getRun(id: string): AnalyticsRun | null;
  /**
   * Stop the dashboard's active refresh. A queued run cancels immediately;
   * a running run is flagged and the worker stops after the widget query
   * already in flight (an MCP SQL call cannot be aborted mid-call).
   */
  cancelActiveRun(dashboardId: string): { result: 'cancelled' | 'stopping' | 'none'; run: AnalyticsRun | null };
  recoverInterruptedRuns(): number;
  processQueuedRuns(limit?: number): Promise<number>;
  /** Poll/download only already-submitted ETL handoffs and guardedly project verified late outputs. */
  processLateEtlResults(limit?: number): Promise<number>;
}
