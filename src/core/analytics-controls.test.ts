import { describe, expect, it } from 'vitest';
import { analyticsSha256 } from './analytics-data-room-policy.js';
import {
  AnalyticsControlError,
  buildAnalyticsControlState,
  deriveAnalyticsControlDefinition,
  normalizeAnalyticsControlValues,
} from './analytics-controls.js';
import type {
  AnalyticsDatasetDetail,
  AnalyticsDatasetVersionDetail,
} from './analytics-data-room-types.js';
import type { AnalyticsWidgetDataRoomBinding } from './analytics-types.js';

const H = {
  definition: '1'.repeat(64),
  contract: '2'.repeat(64),
  schema: '3'.repeat(64),
  content: '4'.repeat(64),
};

function fixture() {
  const contract: any = {
    contractVersion: '1', contractSha256: H.contract, status: 'active',
    datasetId: 'ds_controls', datasetKind: 'source', scope: 'workspace', domainKey: 'synthetic',
    schemaSha256: H.schema,
    schema: [
      { name: 'event_date', logicalType: 'date', nullable: false },
      { name: 'scenario', logicalType: 'string', nullable: true },
      { name: 'value', logicalType: 'integer', nullable: false },
    ],
    metric: { id: 'events', version: '1', definitionSha256: '5'.repeat(64), unit: 'events' },
    regime: { id: 'synthetic', version: '1', definitionSha256: '6'.repeat(64) },
    countingKey: 'scenario', unit: 'events', grain: 'day_scenario',
    availableDimensions: ['event_date', 'scenario'], timeField: 'event_date', timeZone: 'UTC',
    coverage: { partitionKind: 'day', completePartitions: ['2026-09-20', '2026-09-21'], watermark: '2026-09-21T23:59:59.000Z' },
    handling: { classification: 'synthetic', allowedUses: ['dashboard'], allowModelContext: false, allowPublication: false },
  };
  const answer = {
    version: 1 as const,
    metricId: 'events', metricValueColumn: 'value',
    rowDimensions: ['event_date', 'scenario'],
    filterableFields: ['event_date', 'scenario', 'value'],
    stableOrder: [{ field: 'event_date', direction: 'asc' as const }, { field: 'scenario', direction: 'asc' as const }],
  };
  const dataset = {
    id: 'ds_controls', name: 'Synthetic controls', description: '', kind: 'source', scope: 'workspace',
    domainKey: 'synthetic', lifecycle: 'active', sourceKind: 'import', sourceFormat: 'canonical_json',
    definitionRevision: 2, definitionSha256: H.definition, contractSha256: H.contract, schemaSha256: H.schema,
    retention: { minimumVersions: 1, automaticExpiry: false, reacquirable: true, backupRequired: false },
    head: null, currentVersion: null, createdAt: '2026-09-21T00:00:00.000Z', updatedAt: '2026-09-21T00:00:00.000Z',
    ownerId: 'synthetic', definition: { answer }, contract,
  } as AnalyticsDatasetDetail;
  const version = {
    id: 'dsv_aaaaaaaaaaaaaaaaaaaaaaaa', datasetId: dataset.id, ordinal: 1, versionKeySha256: '7'.repeat(64),
    sourceFormat: 'canonical_json', sourceSha256: '8'.repeat(64), sourceBytes: 10,
    materializedSha256: H.content, materializedBytes: 10, manifestSha256: '9'.repeat(64), rowCount: 6,
    observedSchemaSha256: H.schema, contractSha256: H.contract, coverage: contract.coverage,
    definitionSha256: H.definition, materializedAt: '2026-09-21T00:00:00.000Z',
    integrity: { status: 'verified', verifiedAt: '2026-09-21T00:00:00.000Z' }, reacquirable: true,
    createdAt: '2026-09-21T00:00:00.000Z', files: {
      source: { fileName: 'source.json', sha256: '8'.repeat(64), bytes: 10 },
      materialized: { fileName: 'materialized.db', sha256: H.content, bytes: 10 },
    }, observedSchema: contract.schema, contract,
    sourceReceipt: { sourceKind: 'import', producerVersion: 'test', acquiredAt: '2026-09-21T00:00:00.000Z' },
    handling: contract.handling, quality: [],
  } as AnalyticsDatasetVersionDetail;
  const request: any = {
    domainKey: 'synthetic', metric: contract.metric, dimensions: ['event_date', 'scenario'], filters: [],
    dateRange: { start: '2026-09-20', end: '2026-09-21' }, timeZone: 'UTC', countingKey: 'scenario',
    regime: contract.regime, requiredGrain: 'day_scenario', freshness: { mode: 'allow_stale' },
    use: 'dashboard', datasetId: dataset.id, versionId: version.id, resultLimit: 2,
    requiredContractSha256: H.contract,
  };
  const binding: AnalyticsWidgetDataRoomBinding = {
    widgetId: 'widget_controls', datasetId: dataset.id, revision: 3, versionPolicy: 'pinned',
    pinnedVersionId: version.id, expectedSchemaSha256: H.schema, expectedContractSha256: H.contract,
    requiredColumns: ['event_date', 'scenario', 'value'], request,
    requestSha256: analyticsSha256(request), presentationLimit: 2, compatibility: 'compatible',
    observedHeadRevision: 1, lastQueuedVersionId: version.id, lastAppliedVersionId: version.id,
    createdAt: '2026-09-21T00:00:00.000Z', updatedAt: '2026-09-21T00:00:00.000Z',
  };
  return { dataset, version, binding };
}

function expectControlError(operation: () => unknown, fragment: string) {
  expect(operation).toThrowError(AnalyticsControlError);
  expect(operation).toThrowError(fragment);
}

describe('typed analytics controls', () => {
  it('derives date, filter, sort, operator, and fixed-limit authority from the exact recipe/schema', () => {
    const { dataset, version, binding } = fixture();
    const definition = deriveAnalyticsControlDefinition({ dataset, version, binding });
    expect(definition.date).toEqual({ field: 'event_date', logicalType: 'date', timeZone: 'UTC', inclusiveCalendarDays: true });
    expect(definition.filters).toEqual([
      { field: 'scenario', logicalType: 'string', nullable: true, operators: ['eq', 'in'] },
      { field: 'value', logicalType: 'integer', nullable: false, operators: ['eq', 'in', 'gte', 'lte', 'between'] },
    ]);
    expect(definition.sort.fields.map(field => field.field)).toEqual(['event_date', 'scenario', 'value']);
    expect(definition.limits).toEqual({ maxFilters: 20, maxTotalInValues: 100, maxStringChars: 512, maxResultRows: 2 });
  });

  it('canonicalizes filter and IN ordering while preserving one exact global sort', () => {
    const { dataset, version, binding } = fixture();
    const definition = deriveAnalyticsControlDefinition({ dataset, version, binding });
    const first = normalizeAnalyticsControlValues({
      version: 1,
      dateRange: { end: '2026-09-21', start: '2026-09-20' },
      filters: [
        { field: 'value', operator: 'gte', value: 2 },
        { field: 'scenario', operator: 'in', value: ['beta', null, 'alpha', 'beta'] },
      ],
      sort: { direction: 'desc', field: 'value' },
    }, definition);
    const second = normalizeAnalyticsControlValues({
      version: 1,
      dateRange: { start: '2026-09-20', end: '2026-09-21' },
      filters: [
        { field: 'scenario', operator: 'in', value: ['alpha', 'beta', null] },
        { field: 'value', operator: 'gte', value: 2 },
      ],
      sort: { field: 'value', direction: 'desc' },
    }, definition);
    expect(first).toEqual(second);
    expect(analyticsSha256(first)).toBe(analyticsSha256(second));
  });

  it('builds exact default/current/effective request identities and changes only the view hash for sort', () => {
    const { dataset, version, binding } = fixture();
    const base = buildAnalyticsControlState({
      widgetId: binding.widgetId, dataset, version, binding, controlRevision: 0, projected: true,
    });
    const sorted = buildAnalyticsControlState({
      widgetId: binding.widgetId, dataset, version, binding, controlRevision: 1, projected: false,
      values: { ...base.currentValues, sort: { field: 'value', direction: 'desc' } },
    });
    expect(base.currentValues).toEqual(base.defaultValues);
    expect(base.effectiveViewRequest.request).toEqual(sorted.effectiveViewRequest.request);
    expect(base.currentValuesSha256).not.toBe(sorted.currentValuesSha256);
    expect(base.effectiveViewRequestSha256).not.toBe(sorted.effectiveViewRequestSha256);
    expect(sorted.effectiveViewRequest.sort).toEqual({ field: 'value', direction: 'desc' });
  });

  it('fails closed on hostile fields, operators, values, sort, ranges, limits, and unknown keys', () => {
    const { dataset, version, binding } = fixture();
    const definition = deriveAnalyticsControlDefinition({ dataset, version, binding });
    const valid = { version: 1, dateRange: binding.request.dateRange, filters: [], sort: null };
    expectControlError(() => normalizeAnalyticsControlValues({ ...valid, sql: 'DROP TABLE data' }, definition), 'unsupported fields');
    expectControlError(() => normalizeAnalyticsControlValues({ ...valid, sort: { field: 'value DESC; DROP', direction: 'asc' } }, definition), 'one allowed field');
    expectControlError(() => normalizeAnalyticsControlValues({ ...valid, filters: [{ field: 'scenario', operator: 'gte', value: 'alpha' }] }, definition), 'not allowed');
    expectControlError(() => normalizeAnalyticsControlValues({ ...valid, filters: [{ field: 'value', operator: 'between', value: [2] }] }, definition), 'exactly two');
    expectControlError(() => normalizeAnalyticsControlValues({ ...valid, filters: [{ field: 'value', operator: 'between', value: [3, 2] }] }, definition), 'not ordered');
    expectControlError(() => normalizeAnalyticsControlValues({ ...valid, filters: [{ field: 'value', operator: 'eq', value: Number.NaN }] }, definition), 'safe integer');
    expectControlError(() => normalizeAnalyticsControlValues({ ...valid, filters: [{ field: 'scenario', operator: 'eq', value: 'x'.repeat(513) }] }, definition), 'bounded string');
    expectControlError(() => normalizeAnalyticsControlValues({ ...valid, dateRange: { start: '2026-09-22', end: '2026-09-21' } }, definition), 'must not be after');
    expectControlError(() => normalizeAnalyticsControlValues({ ...valid, filters: Array.from({ length: 21 }, () => ({ field: 'value', operator: 'gte', value: 1 })) }, definition), 'at most 20');
    expectControlError(() => normalizeAnalyticsControlValues({ ...valid, filters: [{ field: 'scenario', operator: 'in', value: Array.from({ length: 101 }, (_, index) => `v${index}`) }] }, definition), 'at most 100');
  });
});
