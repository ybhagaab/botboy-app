import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AnalyticsDataRoomContractError,
  analyticsRequestSha256,
  chooseAnalyticsSource,
  enumerateAnalyticsPartitions,
  evaluateAnalyticsCandidate,
  evaluateResearchFeatureGraduation,
  normalizeAnalyticsRequest,
} from './analytics-data-room-policy.js';
import type {
  AnalyticsDataRoomCandidate,
  AnalyticsRequest,
  AnalyticsResearchFeatureEvidence,
} from './analytics-data-room-types.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(fs.readFileSync(path.join(
  HERE,
  '../../evaluations/analytics-data-room-parity-v1/fixtures/routing-fixture.json',
), 'utf8')) as {
  now: string;
  request: AnalyticsRequest;
  candidate: AnalyticsDataRoomCandidate;
  scenarios: Array<{
    name: string;
    requestPatch?: Record<string, unknown>;
    candidatePatch?: Record<string, unknown>;
    omitCandidate?: boolean;
    lanes: { sqlUsable: boolean; etlUsable: boolean };
    expectedKind: string;
    expectedRejection?: string;
  }>;
};

function deepMerge<T>(base: T, patch: unknown): T {
  if (patch === undefined) return structuredClone(base);
  if (Array.isArray(patch) || patch === null || typeof patch !== 'object') return structuredClone(patch) as T;
  const source = base && typeof base === 'object' && !Array.isArray(base)
    ? base as Record<string, unknown>
    : {};
  const out: Record<string, unknown> = structuredClone(source);
  for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
    out[key] = value && typeof value === 'object' && !Array.isArray(value)
      ? deepMerge(source[key] as Record<string, unknown>, value)
      : structuredClone(value);
  }
  return out as T;
}

const nowMs = Date.parse(fixture.now);
const request = (patch: Record<string, unknown> = {}) => deepMerge(fixture.request, patch);
const candidate = (patch: Record<string, unknown> = {}) => deepMerge(fixture.candidate, patch);

function rejectionCodes(input: AnalyticsRequest, value: AnalyticsDataRoomCandidate): string[] {
  return evaluateAnalyticsCandidate(input, value, nowMs).rejections.map(item => item.code);
}

describe('analytics data-room source policy R0', () => {
  it('runs the frozen adversarial route matrix with one deterministic decision', () => {
    for (const scenario of fixture.scenarios) {
      const selected = chooseAnalyticsSource(
        request(scenario.requestPatch),
        scenario.omitCandidate ? [] : [candidate(scenario.candidatePatch)],
        scenario.lanes,
        nowMs,
      );
      expect(selected.kind, scenario.name).toBe(scenario.expectedKind);
      if (scenario.expectedRejection) {
        expect(selected.candidates.flatMap(item => item.rejections.map(rejection => rejection.code)), scenario.name)
          .toContain(scenario.expectedRejection);
      }
      expect(selected.candidates.filter(item => item.eligible)).toHaveLength(
        scenario.expectedKind === 'ready_materialized' || scenario.expectedKind === 'ready_derived' ? 1 : 0,
      );
    }
  });

  it('chooses local materialized before derivation and both before healthy remote lanes', () => {
    const materialized = candidate({ datasetId: 'ds_z', versionId: 'dsv_z' });
    materialized.contract.datasetId = 'ds_z';
    const derived = candidate({
      datasetId: 'ds_a', versionId: 'dsv_a', capability: 'local_derivation',
      derivationSupported: true, derivableGrains: ['day'],
    });
    derived.contract.datasetId = 'ds_a';
    const decision = chooseAnalyticsSource(request(), [derived, materialized], {
      sqlUsable: true, etlUsable: true,
    }, nowMs);
    expect(decision.kind).toBe('ready_materialized');
    expect(decision.selectedDatasetId).toBe('ds_z');
  });

  it('orders equivalent candidates by stable identity rather than caller order', () => {
    const first = candidate({ datasetId: 'ds_b', versionId: 'dsv_2' });
    first.contract.datasetId = 'ds_b';
    const second = candidate({ datasetId: 'ds_a', versionId: 'dsv_1' });
    second.contract.datasetId = 'ds_a';
    const forward = chooseAnalyticsSource(request(), [first, second], { sqlUsable: false, etlUsable: false }, nowMs);
    const reverse = chooseAnalyticsSource(request(), [second, first], { sqlUsable: false, etlUsable: false }, nowMs);
    expect(forward.selectedDatasetId).toBe('ds_a');
    expect(reverse).toEqual(forward);
  });

  it('rejects semantic near-matches instead of treating an equal-looking dataset as eligible', () => {
    const cases: Array<[string, Record<string, unknown>, string]> = [
      ['contract', { requiredContractSha256: 'a'.repeat(64) }, 'contract_mismatch'],
      ['metric', { metric: { id: 'event_rows' } }, 'metric_mismatch'],
      ['regime', { regime: { id: 'single_event_only' } }, 'regime_mismatch'],
      ['counting key', { countingKey: 'event_id' }, 'counting_key_mismatch'],
      ['grain', { requiredGrain: 'hour' }, 'grain_incompatible'],
      ['dimension', { dimensions: ['device_type'] }, 'dimension_missing'],
      ['filter field', { filters: [{ field: 'marketplace', operator: 'eq', value: 'IN' }] }, 'filter_field_missing'],
    ];
    for (const [name, patch, expected] of cases) {
      expect(rejectionCodes(request(patch), candidate()), name).toContain(expected);
    }
  });

  it('uses complete partitions rather than min/max and permits stale data for explicit historical use', () => {
    expect(enumerateAnalyticsPartitions('2026-09-01', '2026-09-03'))
      .toEqual(['2026-09-01', '2026-09-02', '2026-09-03']);
    const missingMiddle = candidate({
      contract: { coverage: { completePartitions: ['2026-09-01', '2026-09-03'] } },
    });
    expect(rejectionCodes(request({ dateRange: { start: '2026-09-01', end: '2026-09-03' } }), missingMiddle))
      .toContain('coverage_gap');

    const old = candidate({ materializedAt: '2025-01-01T00:00:00.000Z' });
    const historical = chooseAnalyticsSource(
      request({ freshness: { mode: 'historical_as_of' } }),
      [old],
      { sqlUsable: true, etlUsable: true },
      nowMs,
    );
    expect(historical.kind).toBe('ready_materialized');
  });

  it('treats source watermark age as freshness and preserves explicit historical eligibility', () => {
    const oldWatermark = candidate({
      materializedAt: '2026-09-02T23:00:00.000Z',
      contract: { coverage: { watermark: '2026-08-30T23:59:59.000Z' } },
    });
    expect(rejectionCodes(request(), oldWatermark)).toContain('freshness_miss');
    const historical = chooseAnalyticsSource(
      request({ freshness: { mode: 'historical_as_of' } }),
      [oldWatermark],
      { sqlUsable: true, etlUsable: true },
      nowMs,
    );
    expect(historical.kind).toBe('ready_materialized');
  });

  it('distinguishes blocking quality errors from advisory warnings', () => {
    const blocked = evaluateAnalyticsCandidate(request(), candidate({
      quality: [{ assertionId: 'unique_user', assertionVersion: '1', severity: 'error', success: false }],
    }), nowMs);
    expect(blocked.eligible).toBe(false);
    expect(blocked.rejections.map(item => item.code)).toContain('quality_error');

    const warned = evaluateAnalyticsCandidate(request(), candidate({
      quality: [{ assertionId: 'volume_drift', assertionVersion: '1', severity: 'warning', success: false }],
    }), nowMs);
    expect(warned.eligible).toBe(true);
    expect(warned.warnings.map(item => item.assertionId)).toEqual(['volume_drift']);
  });

  it('blocks the answer channel instead of bypassing handling policy through a remote query', () => {
    const restricted = candidate({
      contract: { handling: { allowedUses: ['dashboard'], allowModelContext: false } },
    });
    const decision = chooseAnalyticsSource(request(), [restricted], { sqlUsable: true, etlUsable: true }, nowMs);
    expect(decision.kind).toBe('blocked_policy');
    expect(decision.reason).toBe('handling_policy_denied');
  });

  it('clarifies unresolved semantics before inspecting candidates or data lanes', () => {
    const decision = chooseAnalyticsSource(
      request({ unresolvedSemantics: ['countingKey', 'regime'] }),
      [candidate()],
      { sqlUsable: true, etlUsable: true },
      nowMs,
    );
    expect(decision).toMatchObject({
      kind: 'clarification_required',
      clarificationFields: ['countingKey', 'regime'],
      candidates: [],
    });
  });

  it('normalizes ordering into a stable request hash and rejects malformed dates and values', () => {
    const left = request({
      dimensions: ['region', 'event_date'],
      filters: [
        { field: 'region', operator: 'eq', value: 'IN' },
        { field: 'event_name', operator: 'in', value: ['play_exit', 'play_started'] },
      ],
    });
    const right = request({
      dimensions: ['event_date', 'region'],
      filters: [
        { field: 'event_name', operator: 'in', value: ['play_started', 'play_exit'] },
        { field: 'region', operator: 'eq', value: 'IN' },
      ],
    });
    expect(normalizeAnalyticsRequest(left)).toEqual(normalizeAnalyticsRequest(right));
    expect(analyticsRequestSha256(left)).toBe(analyticsRequestSha256(right));
    expect(() => normalizeAnalyticsRequest(request({ dateRange: { start: '2026-02-30', end: '2026-03-01' } })))
      .toThrow(AnalyticsDataRoomContractError);
    expect(() => normalizeAnalyticsRequest(request({ dateRange: { start: '2026-09-03', end: '2026-09-01' } })))
      .toThrow(/on or before/);
    expect(() => normalizeAnalyticsRequest(request({ filters: [{ field: 'region', operator: 'between', value: ['A'] }] })))
      .toThrow(/exactly two/);
  });

  it('turns malformed candidates into fail-closed receipts instead of crashing routing', () => {
    const malformedCases: Array<[string, Record<string, unknown>]> = [
      ['missing dataset identity', { datasetId: '' }],
      ['missing version identity', { versionId: '' }],
      ['invalid capability', { capability: 'remote_derivation' }],
      ['invalid content SHA', { contentSha256: 'not-a-sha' }],
      ['non-boolean content existence', { contentExists: 'yes' }],
      ['non-boolean integrity state', { integrityVerified: 1 }],
      ['non-array schema', { contract: { schema: null } }],
      ['malformed schema element', { contract: { schema: [null] } }],
      ['non-array dimensions', { contract: { availableDimensions: 5 } }],
      ['malformed coverage partition', { contract: { coverage: { completePartitions: [null] } } }],
      ['malformed quality element', { quality: [null] }],
      ['non-boolean derivation support', { derivationSupported: 'yes' }],
      ['malformed derivable grain', { derivableGrains: [null] }],
    ];

    for (const [name, patch] of malformedCases) {
      const decision = chooseAnalyticsSource(
        request(),
        [candidate(patch)],
        { sqlUsable: true, etlUsable: true },
        nowMs,
      );
      expect(decision.kind, name).toBe('refresh_sql');
      expect(decision.candidates[0].rejections, name).toEqual([
        { code: 'contract_mismatch', detail: 'Candidate contract is malformed or incomplete.' },
      ]);
    }

    const nullCandidate = null as unknown as AnalyticsDataRoomCandidate;
    const topLevelMalformed = chooseAnalyticsSource(
      request(),
      [nullCandidate, nullCandidate],
      { sqlUsable: true, etlUsable: true },
      nowMs,
    );
    expect(topLevelMalformed.kind).toBe('refresh_sql');
    expect(topLevelMalformed.candidates).toHaveLength(2);
    for (const evaluated of topLevelMalformed.candidates) {
      expect(evaluated.rejections).toEqual([
        { code: 'contract_mismatch', detail: 'Candidate contract is malformed or incomplete.' },
      ]);
    }
  });

  it('emits isolated rejection receipts for missing content and unit mismatch', () => {
    const missingContent = evaluateAnalyticsCandidate(
      request(),
      candidate({ contentExists: false }),
      nowMs,
    );
    expect(missingContent.rejections).toEqual([
      { code: 'content_missing', detail: 'Materialized bytes do not exist.' },
    ]);

    const wrongUnit = evaluateAnalyticsCandidate(
      request(),
      candidate({ contract: { unit: 'sessions' } }),
      nowMs,
    );
    expect(wrongUnit.rejections).toEqual([
      { code: 'unit_mismatch', detail: 'Metric unit differs.' },
    ]);
  });

  it('does not let an unrelated restricted candidate block an allowed remote fallback', () => {
    const unrelated = candidate({
      contract: {
        domainKey: 'unrelated-domain',
        handling: { allowedUses: ['dashboard'], allowModelContext: false },
      },
    });
    const decision = chooseAnalyticsSource(request(), [unrelated], { sqlUsable: true, etlUsable: true }, nowMs);
    expect(decision.kind).toBe('refresh_sql');
    expect(decision.candidates[0].rejections.map(item => item.code))
      .toEqual(expect.arrayContaining(['domain_mismatch', 'handling_disallowed']));
  });

  it('keeps researched features usage-gated until every BotBoy evidence condition is true', () => {
    const base: AnalyticsResearchFeatureEvidence = {
      feature: 'semantic_graph',
      namedUserOutcome: true,
      reproducedFailureOrReuse: true,
      simplerContractInsufficient: true,
      deterministicEnforcement: true,
      adversarialBeforeAfterTest: true,
      proportionalRuntimeCost: true,
      reversibleOrMigratable: true,
      rolloutThresholdMet: true,
    };
    expect(evaluateResearchFeatureGraduation(base)).toEqual({
      feature: 'semantic_graph', graduated: true, missingEvidence: [],
    });
    const premature = evaluateResearchFeatureGraduation({
      ...base,
      reproducedFailureOrReuse: false,
      simplerContractInsufficient: false,
      rolloutThresholdMet: false,
    });
    expect(premature.graduated).toBe(false);
    expect(premature.missingEvidence).toEqual([
      'reproducedFailureOrReuse', 'simplerContractInsufficient', 'rolloutThresholdMet',
    ]);
  });
});
