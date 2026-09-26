import { describe, expect, it } from 'vitest';
import { buildDashboardPublicationSnapshot } from './analytics-publication-snapshot.js';
import type {
  AnalyticsDashboard,
  AnalyticsWidget,
  DashboardPublicationDataRoomIdentityV1,
} from './analytics-types.js';

const SHA = {
  binding: '1'.repeat(64),
  controlDefinition: '2'.repeat(64),
  controlValues: '3'.repeat(64),
  view: '4'.repeat(64),
  request: '5'.repeat(64),
  query: '6'.repeat(64),
  content: '7'.repeat(64),
  schema: '8'.repeat(64),
  contract: '9'.repeat(64),
  definition: 'a'.repeat(64),
  semantic: 'b'.repeat(64),
};

function dataRoomIdentity(): DashboardPublicationDataRoomIdentityV1 {
  return {
    datasetId: 'ds_fixture',
    datasetDefinitionRevision: 3,
    bindingRevision: 2,
    bindingSha256: SHA.binding,
    versionPolicy: 'latest_compatible',
    lastAppliedVersionId: 'dsv_fixture_2',
    head: { versionId: 'dsv_fixture_2', headRevision: 2, definitionRevision: 3 },
    control: {
      revision: 4,
      projected: false,
      definitionSha256: SHA.controlDefinition,
      valuesSha256: SHA.controlValues,
      effectiveViewRequestSha256: SHA.view,
    },
    versionId: 'dsv_fixture_2',
    requestSha256: SHA.request,
    querySha256: SHA.query,
    compilerVersion: 'sqlite-dashboard-view-v1',
    contentSha256: SHA.content,
    schemaSha256: SHA.schema,
    contractSha256: SHA.contract,
    definitionSha256: SHA.definition,
    semanticReceiptSha256: SHA.semantic,
  };
}

function widget(id: string, position: number, rowValue: string): AnalyticsWidget {
  return {
    id,
    dashboardId: 'dash_fixture',
    position,
    revision: 2,
    bindingRevision: 2,
    kind: 'table',
    title: `Widget ${id}`,
    subtitle: 'secret-config-value',
    config: { privateDisplayValue: 'secret-config-value' },
    binding: { datasetId: 'ds_fixture' } as AnalyticsWidget['binding'],
    result: {
      trust: 'local_verified_data',
      columns: ['label'],
      rows: [[rowValue]],
      rowCount: 1,
      displayedRowCount: 1,
      truncated: false,
      refreshedAt: '2026-09-21T12:00:00.000Z',
    },
    createdAt: '2026-09-21T11:00:00.000Z',
    updatedAt: '2026-09-21T12:00:00.000Z',
  } as AnalyticsWidget;
}

function dashboard(widgets: AnalyticsWidget[]): AnalyticsDashboard {
  return {
    id: 'dash_fixture',
    title: 'Fixture dashboard',
    description: 'private-dashboard-description',
    theme: 'system',
    status: 'ready',
    widgets,
    recentRuns: [],
    projects: [],
    createdAt: '2026-09-21T11:00:00.000Z',
    updatedAt: '2026-09-21T12:00:00.000Z',
  } as AnalyticsDashboard;
}

const validate = () => dataRoomIdentity();
const CREATED_AT = '2026-09-21T12:30:00.000Z';

describe('dashboard publication snapshot', () => {
  it('is deterministic, orders widgets canonically, and persists only hash identities', () => {
    const first = buildDashboardPublicationSnapshot(
      dashboard([widget('widget_b', 2, 'sensitive-row-b'), widget('widget_a', 1, 'sensitive-row-a')]),
      CREATED_AT,
      validate,
    );
    const second = buildDashboardPublicationSnapshot(
      dashboard([widget('widget_a', 1, 'sensitive-row-a'), widget('widget_b', 2, 'sensitive-row-b')]),
      CREATED_AT,
      validate,
    );

    expect(second).toEqual(first);
    expect(first.snapshot.widgets.map(value => value.widgetId)).toEqual(['widget_a', 'widget_b']);
    expect(first.manifestSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(first.manifestJson).not.toContain('sensitive-row');
    expect(first.manifestJson).not.toContain('secret-config-value');
    expect(first.manifestJson).not.toContain('private-dashboard-description');
    expect(first.manifestJson).not.toContain('rows');
    expect(first.manifestJson).not.toContain('config');
    expect(first.snapshot.widgets[0].dataRoom).toEqual(dataRoomIdentity());
  });

  it('changes the result identity for row drift and presentation identity for config drift', () => {
    const base = buildDashboardPublicationSnapshot(dashboard([widget('widget_a', 1, 'row-a')]), CREATED_AT, validate);
    const rowDrift = buildDashboardPublicationSnapshot(dashboard([widget('widget_a', 1, 'row-b')]), CREATED_AT, validate);
    const changedWidget = widget('widget_a', 1, 'row-a');
    changedWidget.config = { privateDisplayValue: 'changed-display' };
    const presentationDrift = buildDashboardPublicationSnapshot(dashboard([changedWidget]), CREATED_AT, validate);

    expect(rowDrift.snapshot.resultSha256).not.toBe(base.snapshot.resultSha256);
    expect(rowDrift.snapshot.presentationSha256).toBe(base.snapshot.presentationSha256);
    expect(presentationDrift.snapshot.presentationSha256).not.toBe(base.snapshot.presentationSha256);
    expect(presentationDrift.snapshot.resultSha256).toBe(base.snapshot.resultSha256);
  });

  it('fails closed when a bound widget lacks a strict verifier or current result', () => {
    const bound = widget('widget_a', 1, 'row-a');
    expect(() => buildDashboardPublicationSnapshot(dashboard([bound]), CREATED_AT)).toThrow(/strict publication verifier/i);
    delete bound.result;
    expect(() => buildDashboardPublicationSnapshot(dashboard([bound]), CREATED_AT, validate)).toThrow(/current result/i);
  });
});
