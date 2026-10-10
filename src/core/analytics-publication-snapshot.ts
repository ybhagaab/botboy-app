import { analyticsSha256, stableAnalyticsJson } from './analytics-data-room-policy.js';
import type {
  AnalyticsDashboard,
  AnalyticsWidget,
  DashboardPublicationDataRoomIdentityV1,
  DashboardPublicationDataRoomQueryIdentityV1,
  DashboardPublicationSnapshotV1,
} from './analytics-types.js';

export interface DashboardPublicationSnapshotBuild {
  snapshot: DashboardPublicationSnapshotV1;
  manifestJson: string;
  manifestSha256: string;
}

function widgetPresentation(widget: AnalyticsWidget): Record<string, unknown> {
  return {
    widgetId: widget.id,
    position: widget.position,
    revision: widget.revision,
    bindingGeneration: widget.bindingRevision,
    kind: widget.kind,
    title: widget.title,
    subtitle: widget.subtitle,
    config: widget.config,
  };
}

function widgetResult(widget: AnalyticsWidget): Record<string, unknown> | null {
  if (!widget.result) return null;
  return {
    trust: widget.result.trust,
    columns: widget.result.columns,
    rows: widget.result.rows,
    rowCount: widget.result.rowCount,
    displayedRowCount: widget.result.displayedRowCount,
    rawPreview: widget.result.rawPreview ?? null,
    refreshedAt: widget.result.refreshedAt,
    lane: widget.result.lane ?? null,
    source: widget.result.source ?? null,
    lastError: widget.lastError ?? null,
  };
}

export function buildDashboardPublicationSnapshot(
  dashboard: AnalyticsDashboard,
  snapshotCreatedAt: string,
  validateDataRoomWidget?: (
    widgetId: string,
    result: NonNullable<AnalyticsWidget['result']>,
  ) => DashboardPublicationDataRoomIdentityV1,
  validateDataRoomQueryWidget?: (
    widget: AnalyticsWidget,
    result: NonNullable<AnalyticsWidget['result']>,
  ) => DashboardPublicationDataRoomQueryIdentityV1,
): DashboardPublicationSnapshotBuild {
  const widgets = [...dashboard.widgets]
    .sort((left, right) => left.position - right.position || left.id.localeCompare(right.id))
    .map(widget => {
      const result = widgetResult(widget);
      let dataRoom: DashboardPublicationDataRoomIdentityV1 | undefined;
      let dataRoomQuery: DashboardPublicationDataRoomQueryIdentityV1 | undefined;
      if (widget.result?.source?.provider === 'data-room-query') {
        // An independent Data Room source publishes only when its result is
        // exactly the configured source on the dataset's current head.
        if (!validateDataRoomQueryWidget) {
          throw new Error(`Independent Data Room widget ${widget.id} has no publication verifier in this build.`);
        }
        dataRoomQuery = validateDataRoomQueryWidget(widget, widget.result);
      }
      if (widget.binding) {
        if (!widget.result || !validateDataRoomWidget) {
          throw new Error(`Bound widget ${widget.id} has no strict publication verifier or current result.`);
        }
        dataRoom = validateDataRoomWidget(widget.id, widget.result);
      }
      return {
        widgetId: widget.id,
        position: widget.position,
        widgetRevision: widget.revision,
        bindingGeneration: widget.bindingRevision,
        presentationSha256: analyticsSha256(widgetPresentation(widget)),
        ...(result ? { resultSha256: analyticsSha256(result) } : {}),
        ...(dataRoom ? { dataRoom } : {}),
        ...(dataRoomQuery ? { dataRoomQuery } : {}),
      };
    });
  const snapshot: DashboardPublicationSnapshotV1 = {
    version: 1,
    dashboardId: dashboard.id,
    snapshotCreatedAt,
    presentationSha256: analyticsSha256({
      dashboardId: dashboard.id,
      title: dashboard.title,
      description: dashboard.description,
      theme: dashboard.theme,
      widgets: widgets.map(widget => ({ widgetId: widget.widgetId, presentationSha256: widget.presentationSha256 })),
    }),
    resultSha256: analyticsSha256(widgets.map(widget => ({
      widgetId: widget.widgetId,
      resultSha256: widget.resultSha256 ?? null,
    }))),
    widgets,
  };
  const manifestJson = stableAnalyticsJson(snapshot);
  return { snapshot, manifestJson, manifestSha256: analyticsSha256(snapshot) };
}
