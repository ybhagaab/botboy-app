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

export interface DashboardPublisherConfig {
  id: 's3-cloudfront';
  displayName: string;
  enabled: boolean;
  configured: boolean;
  bucket: string;
  prefix: string;
  region: string;
  awsProfile: string;
  cloudFrontBaseUrl: string;
  lastError?: string;
  updatedAt: string;
}

export interface UpdateDashboardPublisherInput {
  enabled: boolean;
  bucket: string;
  prefix?: string;
  region: string;
  awsProfile: string;
  cloudFrontBaseUrl: string;
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

export interface DashboardPublisherService {
  getConfig(): DashboardPublisherConfig;
  updateConfig(input: UpdateDashboardPublisherInput): DashboardPublisherConfig;
  createShareRequest(dashboardId: string): DashboardShareRequest;
  publish(dashboardId: string, confirmationToken: string): Promise<DashboardPublishResult>;
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
