import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import {
  analyticsHandlingAllowsModelContext,
  analyticsRequestSha256,
  analyticsSha256,
  chooseAnalyticsSource,
  enumerateAnalyticsPartitions,
  normalizeAnalyticsRequest,
  stableAnalyticsJson,
  type AnalyticsModelContextRuntime,
} from './analytics-data-room-policy.js';
import {
  AnalyticsDataRoomError,
  type AnalyticsDataRoomStore,
} from './analytics-data-room-store.js';
import type { AnalyticsLocalQueryEngine } from './analytics-data-room-query.js';
import type { AnalyticsDerivationService } from './analytics-data-room-derivation.js';
import { parseSqlMcpResult, etlResultToWidgetResult } from './analytics-dashboard.js';
import {
  dashboardLaneAvailability,
  sqlDashboardLaneCandidate,
} from './analytics-runners.js';
import { validateReadOnlySql } from './mcp-policy.js';
import type { McpManager } from './mcp-types.js';
import type { QueryRunResult, QueryRunner } from './etl-adhoc.js';
import type {
  AnalyticsAnswerExecutionCounts,
  AnalyticsAnswerOutcome,
  AnalyticsAnswerRequest,
  AnalyticsCanonicalAnswer,
  AnalyticsCanonicalResult,
  AnalyticsCatalogCandidateProjection,
  AnalyticsDataCell,
  AnalyticsDataRoomCandidate,
  AnalyticsDataRoomErrorCode,
  AnalyticsDataRoomSourceReceipt,
  AnalyticsDerivationPlan,
  AnalyticsRemoteLaneAvailability,
  AnalyticsRequest,
  AnalyticsSourceDecision,
} from './analytics-data-room-types.js';

export interface AnalyticsRemoteCompleteOutcome {
  state: 'complete';
  sourceKind: 'sql_context' | 'datanet_etl';
  result: AnalyticsCanonicalResult;
  sourceReceipt: AnalyticsDataRoomSourceReceipt;
  artifact?:
    | { kind: 'sql_rows' }
    | {
        kind: 'etl_tsv';
        savedTo: string;
        resultBytes: number;
        resultSha256: string;
      };
}

export type AnalyticsRemoteOutcome =
  | AnalyticsRemoteCompleteOutcome
  | {
      state: 'pending';
      sourceKind: 'datanet_etl';
      runId: string;
      remoteStatus: string;
      sourceReceipt: AnalyticsDataRoomSourceReceipt;
      nextAction: string;
    }
  | {
      state: 'failed';
      sourceKind: 'sql_context' | 'datanet_etl';
      code: 'remote_failed' | 'incomplete_source';
      error: string;
      nextAction: string;
      /** True when Datanet may have accepted a submit but no exact run ID was returned. */
      submissionUnknown?: boolean;
    };

export interface AnalyticsAnswerRemoteRuntime {
  availability(): Promise<AnalyticsRemoteLaneAvailability>;
  execute(input: {
    decision: 'refresh_sql' | 'refresh_etl';
    sql: string;
    request: AnalyticsRequest;
    onEtlSubmitted: (runId: string) => Promise<void> | void;
  }): Promise<AnalyticsRemoteOutcome>;
  readEtlRun(runId: string): Promise<AnalyticsRemoteOutcome>;
}

export interface AnalyticsAnswerService {
  answer(input: AnalyticsAnswerRequest, options?: { signal?: AbortSignal }): Promise<AnalyticsAnswerOutcome>;
}

interface AttemptRow {
  id: string;
  request_sha256: string;
  query_sha256: string;
  metric_value_column: string | null;
  dataset_id: string | null;
  source_decision: 'refresh_sql' | 'refresh_etl';
  source_kind: 'sql_context' | 'datanet_etl';
  status: 'running' | 'waiting_remote' | 'completed' | 'failed';
  remote_run_id: string | null;
  remote_status: string | null;
  result_json: string | null;
  receipt_json: string | null;
  error: string | null;
  next_action: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

function baseExecution(): AnalyticsAnswerExecutionCounts {
  return { catalogCandidates: 0, integrityChecks: 0, laneProbes: 0, remoteExecutions: 0, localQueries: 0 };
}

function cleanMetricColumn(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 160 || value.includes('\0')) {
    throw new AnalyticsDataRoomError('invalid_input', 'metricValueColumn is required and must be a bounded field name.');
  }
  return value.trim();
}

function isActiveAttemptConstraint(error: unknown): boolean {
  const value = error as { code?: unknown; message?: unknown } | null;
  const code = String(value?.code ?? '');
  const message = String(value?.message ?? '');
  return code.startsWith('SQLITE_CONSTRAINT')
    && message.includes('UNIQUE constraint failed: analytics_answer_attempts.request_sha256');
}

function sourceDecisionOnly(decision: AnalyticsSourceDecision): Pick<AnalyticsSourceDecision, 'kind' | 'reason'> {
  return { kind: decision.kind, reason: decision.reason };
}

function localAnswer(
  request: AnalyticsRequest,
  projection: AnalyticsCatalogCandidateProjection,
  decision: AnalyticsSourceDecision,
  query: Awaited<ReturnType<AnalyticsLocalQueryEngine['execute']>>,
  executionKind: 'materialized_answer' | 'local_derivation' = 'materialized_answer',
): AnalyticsCanonicalAnswer {
  const warnings = projection.version.quality
    .filter(item => !item.success && item.severity === 'warning')
    .map(item => item.assertionId)
    .sort();
  const limitations = query.result.truncated
    ? [`Result displays ${query.result.displayedRowCount} of ${query.result.rowCount} rows within fixed row/byte limits.`]
    : [];
  return {
    result: query.result,
    receipt: {
      requestSha256: analyticsRequestSha256(request),
      sourceKind: projection.version.derivation ? 'data_room_derived' : 'data_room_materialized',
      executionKind,
      metric: request.metric,
      regime: request.regime,
      countingKey: request.countingKey,
      grain: request.requiredGrain,
      dimensions: request.dimensions,
      unit: request.metric.unit,
      timeZone: request.timeZone,
      requestedRange: request.dateRange,
      coveredPartitions: projection.version.coverage.completePartitions,
      watermark: projection.version.coverage.watermark,
      datasetIds: [projection.dataset.id],
      versionIds: [projection.version.id],
      contractSha256: projection.version.contractSha256,
      definitionSha256: projection.version.definitionSha256,
      contentSha256: projection.version.materializedSha256,
      materializedAt: projection.version.materializedAt,
      sourceDecision: sourceDecisionOnly(decision),
      schemaSha256: projection.version.observedSchemaSha256,
      querySha256: query.receipt.querySha256,
      queryCompilerVersion: query.receipt.compilerVersion,
      integrityVerifiedAt: query.receipt.integrityVerifiedAt,
      resultLimit: query.receipt.rowLimit,
      resultByteLimit: query.receipt.byteLimit,
      ...(projection.version.derivation ? {
        inputVersionIds: projection.version.derivation.inputs.map(input => input.versionId),
        materializationKeySha256: projection.version.derivation.materializationKeySha256,
        transformSha256: projection.version.derivation.transformSha256,
      } : {}),
      qualityWarnings: warnings,
      limitations,
    },
  };
}

function remoteAnswer(
  request: AnalyticsRequest,
  metricValueColumn: string,
  decision: AnalyticsSourceDecision,
  outcome: AnalyticsRemoteCompleteOutcome,
  datasetId?: string,
  contractSha256?: string,
): AnalyticsCanonicalAnswer {
  const expectedColumns = [...request.dimensions, metricValueColumn];
  if (stableAnalyticsJson(outcome.result.columns) !== stableAnalyticsJson(expectedColumns)) {
    throw new AnalyticsDataRoomError(
      'remote_failed',
      `Remote result columns must be exactly ${expectedColumns.join(', ')} in that order.`,
    );
  }
  const dimensionCount = request.dimensions.length;
  const seen = new Set<string>();
  for (const [index, row] of outcome.result.rows.entries()) {
    if (!Array.isArray(row) || row.length !== expectedColumns.length) {
      throw new AnalyticsDataRoomError('remote_failed', `Remote result row ${index} has the wrong width.`);
    }
    const metricValue = row[dimensionCount];
    if (typeof metricValue !== 'number' || !Number.isFinite(metricValue)) {
      throw new AnalyticsDataRoomError('remote_failed', `Remote metric value at row ${index} is not numeric.`);
    }
    const identity = stableAnalyticsJson(row.slice(0, dimensionCount));
    if (seen.has(identity)) {
      throw new AnalyticsDataRoomError('remote_failed', 'Remote result contains duplicate rows at the requested dimension grain.');
    }
    seen.add(identity);
  }
  const limitations = [
    'Remote result coverage and source watermark were not independently materialized in this answer; verify the governed warehouse query before reuse.',
    ...(outcome.result.truncated
      ? [`Remote result displays ${outcome.result.displayedRowCount} of ${outcome.result.rowCount} rows.`]
      : []),
  ];
  const runtimeContractSha = contractSha256 ?? analyticsSha256({
    metric: request.metric,
    regime: request.regime,
    countingKey: request.countingKey,
    grain: request.requiredGrain,
    dimensions: request.dimensions,
    timeZone: request.timeZone,
  });
  return {
    result: outcome.result,
    receipt: {
      requestSha256: analyticsRequestSha256(request),
      sourceKind: outcome.sourceKind,
      executionKind: 'remote_query',
      metric: request.metric,
      regime: request.regime,
      countingKey: request.countingKey,
      grain: request.requiredGrain,
      dimensions: request.dimensions,
      unit: request.metric.unit,
      timeZone: request.timeZone,
      requestedRange: request.dateRange,
      coveredPartitions: [],
      watermark: 'unknown',
      datasetIds: datasetId ? [datasetId] : [],
      versionIds: [],
      contractSha256: runtimeContractSha,
      definitionSha256: outcome.sourceReceipt.querySha256 ?? analyticsSha256({ source: outcome.sourceKind }),
      contentSha256: analyticsSha256(outcome.result),
      materializedAt: outcome.sourceReceipt.acquiredAt,
      sourceDecision: sourceDecisionOnly(decision),
      remoteSourceReceipt: outcome.sourceReceipt,
      resultLimit: request.resultLimit ?? 200,
      resultByteLimit: 40_000,
      qualityWarnings: [],
      limitations,
    },
  };
}

function boundRemoteResult(result: AnalyticsCanonicalResult, rowLimit: number): AnalyticsCanonicalResult {
  if (!Array.isArray(result.columns) || !Array.isArray(result.rows)
    || !Number.isInteger(result.rowCount) || result.rowCount < 0
    || !Number.isInteger(result.displayedRowCount) || result.displayedRowCount < 0
    || result.displayedRowCount !== result.rows.length
    || result.displayedRowCount > result.rowCount
    || result.truncated !== (result.displayedRowCount < result.rowCount)) {
    throw new AnalyticsDataRoomError('remote_failed', 'Remote executor returned inconsistent result bounds.');
  }
  const rows: AnalyticsDataCell[][] = [];
  let bytes = 2;
  for (const row of result.rows.slice(0, rowLimit)) {
    const next = Buffer.byteLength(stableAnalyticsJson(row), 'utf8') + (rows.length ? 1 : 0);
    if (bytes + next > 40_000) break;
    rows.push(row);
    bytes += next;
  }
  return {
    columns: result.columns,
    rows,
    rowCount: result.rowCount,
    displayedRowCount: rows.length,
    truncated: rows.length < result.rowCount,
  };
}

function etlOutcome(
  outcome: QueryRunResult,
  now: () => Date,
  querySha256?: string,
): AnalyticsRemoteOutcome {
  if (outcome.ok) {
    const result = etlResultToWidgetResult(outcome);
    const acquiredAt = now().toISOString();
    const sourceReceipt: AnalyticsDataRoomSourceReceipt = {
      sourceKind: 'datanet_etl',
      ...(outcome.runId ? { sourceId: outcome.runId } : {}),
      ...(querySha256 ? { querySha256 } : {}),
      producerVersion: 'a2-analytics-query-runner-v1',
      acquiredAt,
      submittedAgain: false,
    };
    return {
      state: 'complete',
      sourceKind: 'datanet_etl',
      result: {
        columns: result.columns,
        rows: result.rows,
        rowCount: result.rowCount,
        displayedRowCount: result.displayedRowCount,
        truncated: result.displayedRowCount < result.rowCount,
      },
      sourceReceipt,
      ...(outcome.savedTo && outcome.resultBytes !== undefined && outcome.resultSha256
        ? { artifact: { kind: 'etl_tsv' as const, savedTo: outcome.savedTo, resultBytes: outcome.resultBytes, resultSha256: outcome.resultSha256 } }
        : {}),
    };
  }
  if (outcome.code === 'alive_handoff' && /^\d+$/.test(String(outcome.runId ?? ''))) {
    return {
      state: 'pending',
      sourceKind: 'datanet_etl',
      runId: String(outcome.runId),
      remoteStatus: String(outcome.remoteStatus || 'RUNNING'),
      sourceReceipt: {
        sourceKind: 'datanet_etl',
        sourceId: String(outcome.runId),
        ...(querySha256 ? { querySha256 } : {}),
        producerVersion: 'a2-analytics-query-runner-v1',
        acquiredAt: now().toISOString(),
        submittedAgain: false,
      },
      nextAction: outcome.nextAction || `Continue Datanet run ${outcome.runId} by status/download only; do not resubmit.`,
    };
  }
  return {
    state: 'failed',
    sourceKind: 'datanet_etl',
    code: outcome.code === 'download_failed' ? 'incomplete_source' : 'remote_failed',
    error: outcome.error || 'Datanet ETL query failed.',
    nextAction: outcome.nextAction || 'Fix the reported issue before a new owner-requested answer attempt.',
    ...(outcome.code === 'submission_unknown' ? { submissionUnknown: true } : {}),
  };
}

export function createManagedAnalyticsAnswerRuntime(input: {
  mcpManager: McpManager;
  etlRunner: QueryRunner;
  now?: () => Date;
  sqlTimeoutMs?: number;
}): AnalyticsAnswerRemoteRuntime {
  const now = input.now ?? (() => new Date());
  const sqlTimeoutMs = Math.max(30_000, Math.min(10 * 60_000, Math.floor(input.sqlTimeoutMs ?? 5 * 60_000)));

  async function availability(): Promise<AnalyticsRemoteLaneAvailability> {
    let profiles = await input.mcpManager.listProfiles();
    const sql = profiles.find(profile => profile.id === 'sql-context');
    let liveSqlReady = false;
    if (sqlDashboardLaneCandidate(sql)) {
      try {
        const probe = await input.mcpManager.testConnection('sql-context');
        if (!probe.isError && /^Connected(?:\n|$)/.test(probe.text)) {
          profiles = await input.mcpManager.listProfiles();
          liveSqlReady = sqlDashboardLaneCandidate(profiles.find(profile => profile.id === 'sql-context'));
        }
      } catch {
        liveSqlReady = false;
      }
    }
    const snapshot = dashboardLaneAvailability(profiles, true, now().getTime());
    return { sqlUsable: liveSqlReady && snapshot.sqlUsable, etlUsable: snapshot.etlUsable };
  }

  async function execute(value: {
    decision: 'refresh_sql' | 'refresh_etl';
    sql: string;
    request: AnalyticsRequest;
    onEtlSubmitted: (runId: string) => Promise<void> | void;
  }): Promise<AnalyticsRemoteOutcome> {
    const sql = validateReadOnlySql(value.sql);
    if (value.decision === 'refresh_etl') {
      const outcome = await input.etlRunner.runQuery({
        sql,
        datasetDate: value.request.dateRange.end,
        onSubmitted: value.onEtlSubmitted,
      });
      return etlOutcome(outcome, now, analyticsSha256(sql));
    }
    const call = await input.mcpManager.callTool(
      'sql-context',
      'run_query',
      { sql },
      { source: 'agent', timeoutMs: sqlTimeoutMs },
    );
    if (call.isError) {
      return {
        state: 'failed',
        sourceKind: 'sql_context',
        code: 'remote_failed',
        error: call.text.trim() || 'SQL connector returned no error detail.',
        nextAction: 'Check the SQL connection and query; do not switch lanes after this attempted execution.',
      };
    }
    const parsed = parseSqlMcpResult(call.text, now().toISOString());
    if (parsed.columns.length === 0) {
      return {
        state: 'failed',
        sourceKind: 'sql_context',
        code: 'incomplete_source',
        error: 'SQL connector returned no parseable tabular result.',
        nextAction: 'Use a bounded SELECT with explicit aliases, or a complete ETL artifact.',
      };
    }
    const result: AnalyticsCanonicalResult = {
      columns: parsed.columns,
      rows: parsed.rows,
      rowCount: parsed.rowCount,
      displayedRowCount: parsed.displayedRowCount,
      truncated: parsed.displayedRowCount < parsed.rowCount,
    };
    return {
      state: 'complete',
      sourceKind: 'sql_context',
      result,
      sourceReceipt: {
        sourceKind: 'sql_context',
        querySha256: analyticsSha256(sql),
        producerVersion: 'sql-context-mcp-v1',
        acquiredAt: now().toISOString(),
      },
      artifact: { kind: 'sql_rows' },
    };
  }

  async function readEtlRun(runId: string): Promise<AnalyticsRemoteOutcome> {
    if (!input.etlRunner.readRun) {
      return {
        state: 'pending',
        sourceKind: 'datanet_etl',
        runId,
        remoteStatus: 'UNKNOWN',
        sourceReceipt: {
          sourceKind: 'datanet_etl', sourceId: runId,
          producerVersion: 'a2-analytics-query-runner-v1', acquiredAt: now().toISOString(), submittedAgain: false,
        },
        nextAction: `The runtime cannot read existing Datanet run ${runId} yet; do not resubmit it.`,
      };
    }
    return etlOutcome(await input.etlRunner.readRun({ runId }), now);
  }

  return { availability, execute, readEtlRun };
}

export function createAnalyticsAnswerService(input: {
  db: Database.Database;
  store: AnalyticsDataRoomStore;
  localQuery: AnalyticsLocalQueryEngine;
  derivation?: AnalyticsDerivationService;
  remote: AnalyticsAnswerRemoteRuntime;
  modelContextRuntime?: AnalyticsModelContextRuntime;
  now?: () => Date;
  createId?: () => string;
}): AnalyticsAnswerService {
  const now = input.now ?? (() => new Date());
  const createId = input.createId ?? (() => randomUUID().replace(/-/g, ''));

  function timestamp(): string {
    return now().toISOString();
  }

  function handlingForRuntime(handling: AnalyticsDataRoomCandidate['contract']['handling']) {
    return analyticsHandlingAllowsModelContext(handling, input.modelContextRuntime)
      ? handling
      : { ...handling, allowModelContext: false };
  }

  function projections(request: AnalyticsRequest, execution: AnalyticsAnswerExecutionCounts): AnalyticsCatalogCandidateProjection[] {
    const datasets = input.store.findDatasetsForRequest(request);
    const output: AnalyticsCatalogCandidateProjection[] = [];
    let rank = 0;
    for (const dataset of datasets) {
      const head = input.store.getHead(dataset.id);
      const hideDirtyDerivedHead = dataset.kind === 'derived'
        && input.store.isDerivedDatasetDirty(dataset.id)
        && request.freshness.mode !== 'historical_as_of';
      const versionIds: string[] = [];
      const preverified = new Set<string>();
      if (request.versionId) {
        versionIds.push(request.versionId);
      } else if (head && !hideDirtyDerivedHead) {
        versionIds.push(head.versionId);
        const headVersion = input.store.getDatasetVersion(head.versionId);
        let verifiedHeadAllowsHistoricalLookup = false;
        if (request.freshness.mode === 'historical_as_of' && headVersion?.integrity.status === 'verified') {
          try {
            execution.integrityChecks++;
            input.store.verifyVersion(headVersion.id);
            preverified.add(headVersion.id);
            verifiedHeadAllowsHistoricalLookup = true;
          } catch (error) {
            if (error instanceof AnalyticsDataRoomError && error.code === 'conflict') throw error;
            if (!(error instanceof AnalyticsDataRoomError) || error.code !== 'integrity_failed') throw error;
          }
        }
        if (verifiedHeadAllowsHistoricalLookup) {
          for (const version of input.store.listDatasetVersions(dataset.id) ?? []) {
            if (!versionIds.includes(version.id)) versionIds.push(version.id);
          }
        }
      }
      for (const versionId of versionIds) {
        const version = input.store.getDatasetVersion(versionId);
        if (!version || version.datasetId !== dataset.id) continue;
        let integrityVerified = version.integrity.status === 'verified';
        let contentExists = true;
        if (integrityVerified && !preverified.has(version.id)) {
          try {
            execution.integrityChecks++;
            input.store.verifyVersion(version.id);
          } catch (error) {
            if (error instanceof AnalyticsDataRoomError && error.code === 'conflict') throw error;
            if (!(error instanceof AnalyticsDataRoomError) || error.code !== 'integrity_failed') throw error;
            integrityVerified = false;
            contentExists = !/missing/i.test(error.message);
          }
        }
        const support = integrityVerified
          ? input.localQuery.supports({ dataset, version, request })
          : { supported: false as const, reason: 'Version integrity is not verified.' };
        const candidate: AnalyticsDataRoomCandidate = {
          datasetId: dataset.id,
          versionId: version.id,
          capability: 'materialized_answer',
          contract: { ...version.contract, handling: handlingForRuntime(version.contract.handling) },
          contentSha256: version.materializedSha256,
          contentExists,
          integrityVerified,
          querySupported: support.supported,
          selectionRank: rank++,
          materializedAt: version.materializedAt,
          quality: version.quality,
        };
        output.push({ dataset, version, recipe: support.supported ? support.recipe : null, candidate });
      }
    }
    execution.catalogCandidates = output.length;
    return output;
  }

  function derivationPlans(request: AnalyticsRequest, startRank: number): {
    candidates: AnalyticsDataRoomCandidate[];
    plans: Map<string, AnalyticsDerivationPlan>;
    exactError?: AnalyticsDataRoomError;
  } {
    if (!input.derivation || request.versionId) return { candidates: [], plans: new Map() };
    const candidates: AnalyticsDataRoomCandidate[] = [];
    const plans = new Map<string, AnalyticsDerivationPlan>();
    let exactError: AnalyticsDataRoomError | undefined;
    let rank = startRank;
    for (const dataset of input.store.findDatasetsForRequest(request)) {
      if (dataset.kind !== 'derived') continue;
      try {
        const plan = input.derivation.resolvePlan({
          datasetId: dataset.id,
          request,
          consumer: { kind: 'answer', id: analyticsRequestSha256(request) },
        });
        const versions = plan.inputs.map(pin => input.store.getDatasetVersion(pin.versionId)!);
        const materializedAt = versions.map(version => version.materializedAt).sort()[0] ?? timestamp();
        const quality = versions.flatMap(version => version.quality);
        const candidate: AnalyticsDataRoomCandidate = {
          datasetId: dataset.id,
          derivationKey: plan.materializationKeySha256,
          capability: 'local_derivation',
          contract: { ...dataset.contract, handling: handlingForRuntime(dataset.contract.handling) },
          contentSha256: plan.inputSetSha256,
          contentExists: true,
          integrityVerified: true,
          selectionRank: rank++,
          materializedAt,
          quality,
          derivationSupported: true,
          derivableGrains: [dataset.contract.grain],
        };
        candidates.push(candidate);
        plans.set(plan.materializationKeySha256, plan);
      } catch (error) {
        if (request.datasetId === dataset.id && error instanceof AnalyticsDataRoomError) exactError = error;
      }
    }
    return { candidates, plans, ...(exactError ? { exactError } : {}) };
  }

  function recoverInterruptedAttempts(): void {
    const at = timestamp();
    const cutoff = new Date(now().getTime() - 10 * 60_000).toISOString();
    input.db.prepare(`
      UPDATE analytics_answer_attempts
      SET status = 'failed', error = ?, next_action = ?, updated_at = ?, completed_at = ?
      WHERE status = 'running' AND source_kind = 'sql_context' AND updated_at <= ?
    `).run(
      'The prior read-only SQL attempt ended before returning a receipt.',
      'Retry the same answer request; read-only SQL is safe to repeat.',
      at,
      at,
      cutoff,
    );
    input.db.prepare(`
      UPDATE analytics_answer_attempts
      SET status = 'waiting_remote', remote_status = 'SUBMISSION_UNKNOWN', error = ?,
          next_action = ?, updated_at = ?, completed_at = NULL
      WHERE status = 'running' AND source_kind = 'datanet_etl' AND updated_at <= ?
    `).run(
      'BotBoy stopped after ETL execution began; local state cannot prove whether Datanet accepted a run.',
      'Do not resubmit. Inspect Datanet around this attempt timestamp and reconcile an exact run ID before continuing.',
      at,
      cutoff,
    );
  }

  function getAttempt(attemptId: string): AttemptRow | null {
    return (input.db.prepare('SELECT * FROM analytics_answer_attempts WHERE id = ?')
      .get(attemptId) as AttemptRow | undefined) ?? null;
  }

  function activeAttempt(requestSha256: string): AttemptRow | null {
    return (input.db.prepare(`
      SELECT * FROM analytics_answer_attempts
      WHERE request_sha256 = ? AND status IN ('running','waiting_remote')
      ORDER BY created_at ASC, id ASC LIMIT 1
    `).get(requestSha256) as AttemptRow | undefined) ?? null;
  }

  function attemptDecision(attempt: AttemptRow, localDecision: AnalyticsSourceDecision): AnalyticsSourceDecision {
    return {
      kind: attempt.source_decision,
      reason: attempt.source_decision === 'refresh_sql'
        ? 'local_candidates_ineligible_sql_ready'
        : 'local_candidates_ineligible_etl_ready',
      ...(attempt.dataset_id ? { selectedDatasetId: attempt.dataset_id } : {}),
      candidates: localDecision.candidates,
    };
  }

  function beginAttempt(
    requestSha256: string,
    querySha256: string,
    metricValueColumn: string,
    decision: 'refresh_sql' | 'refresh_etl',
    datasetId?: string,
  ): AttemptRow {
    const at = timestamp();
    const id = `answer_${createId().slice(0, 24)}`;
    input.db.prepare(`
      INSERT INTO analytics_answer_attempts
        (id, request_sha256, query_sha256, metric_value_column, dataset_id, source_decision,
         source_kind, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'running', ?, ?)
    `).run(
      id, requestSha256, querySha256, metricValueColumn, datasetId ?? null, decision,
      decision === 'refresh_sql' ? 'sql_context' : 'datanet_etl', at, at,
    );
    return getAttempt(id)!;
  }

  function checkpointEtl(attemptId: string, runId: string): void {
    const at = timestamp();
    const updated = input.db.prepare(`
      UPDATE analytics_answer_attempts
      SET status = 'waiting_remote', remote_run_id = ?, remote_status = 'SUBMITTED', updated_at = ?
      WHERE id = ? AND source_kind = 'datanet_etl' AND status IN ('running','waiting_remote')
    `).run(runId, at, attemptId);
    if (updated.changes !== 1) throw new AnalyticsDataRoomError('conflict', 'Answer attempt changed before ETL identity checkpoint.');
  }

  function holdEtlAttempt(
    attemptId: string,
    remoteStatus: 'SUBMISSION_UNKNOWN' | 'SUBMISSION_CONTEXT_UNKNOWN' | 'RECEIPT_CONFLICT',
    error: string,
    nextAction: string,
    runId?: string,
  ): void {
    const at = timestamp();
    const updated = input.db.prepare(`
      UPDATE analytics_answer_attempts
      SET status = 'waiting_remote', remote_run_id = COALESCE(remote_run_id, ?), remote_status = ?,
          error = ?, next_action = ?, updated_at = ?, completed_at = NULL
      WHERE id = ? AND source_kind = 'datanet_etl' AND status IN ('running','waiting_remote')
    `).run(runId ?? null, remoteStatus, error.slice(0, 2000), nextAction.slice(0, 2000), at, attemptId);
    if (updated.changes !== 1) throw new AnalyticsDataRoomError('conflict', 'ETL answer attempt changed before fail-closed hold.');
  }

  function finishAttempt(attemptId: string, outcome: AnalyticsRemoteOutcome, answer?: AnalyticsCanonicalAnswer): void {
    const at = timestamp();
    if (outcome.state === 'pending') {
      const updated = input.db.prepare(`
        UPDATE analytics_answer_attempts
        SET status = 'waiting_remote', remote_run_id = ?, remote_status = ?,
            next_action = ?, updated_at = ?
        WHERE id = ? AND status IN ('running','waiting_remote')
      `).run(outcome.runId, outcome.remoteStatus, outcome.nextAction, at, attemptId);
      if (updated.changes !== 1) throw new AnalyticsDataRoomError('conflict', 'Answer attempt changed before pending receipt was recorded.');
      return;
    }
    if (outcome.state === 'failed') {
      const updated = input.db.prepare(`
        UPDATE analytics_answer_attempts
        SET status = 'failed', error = ?, next_action = ?, updated_at = ?, completed_at = ?
        WHERE id = ? AND status IN ('running','waiting_remote')
      `).run(outcome.error.slice(0, 2000), outcome.nextAction.slice(0, 2000), at, at, attemptId);
      if (updated.changes !== 1) throw new AnalyticsDataRoomError('conflict', 'Answer attempt changed before failure receipt was recorded.');
      return;
    }
    const updated = input.db.prepare(`
      UPDATE analytics_answer_attempts
      SET status = 'completed', remote_status = 'SUCCESS', result_json = ?, receipt_json = ?,
          updated_at = ?, completed_at = ?
      WHERE id = ? AND status IN ('running','waiting_remote')
    `).run(stableAnalyticsJson(outcome.result), answer ? stableAnalyticsJson(answer.receipt) : null, at, at, attemptId);
    if (updated.changes !== 1) throw new AnalyticsDataRoomError('conflict', 'Answer attempt changed before completion receipt was recorded.');
  }

  function blocked(
    status: 'blocked' | 'failed',
    decision: AnalyticsSourceDecision,
    code: AnalyticsDataRoomErrorCode,
    error: string,
    nextAction: string,
    execution: AnalyticsAnswerExecutionCounts,
  ): AnalyticsAnswerOutcome {
    return { status, decision, code, error, nextAction, execution } as AnalyticsAnswerOutcome;
  }

  async function handleRemote(
    request: AnalyticsRequest,
    decision: AnalyticsSourceDecision,
    execution: AnalyticsAnswerExecutionCounts,
    remoteOutcome: AnalyticsRemoteOutcome,
    attemptId: string,
  ): Promise<AnalyticsAnswerOutcome> {
    const attempt = getAttempt(attemptId);
    if (!attempt) {
      return blocked('failed', decision, 'conflict', 'The analytics answer attempt disappeared before its receipt was recorded.', 'Retry only after inspecting the attempt journal.', execution);
    }
    if (remoteOutcome.state === 'failed' && remoteOutcome.submissionUnknown && attempt.source_kind === 'datanet_etl') {
      const error = 'Datanet may have accepted the run, but no exact run ID was returned.';
      const nextAction = 'Do not resubmit. Inspect Datanet around this attempt timestamp and reconcile an exact run ID first.';
      holdEtlAttempt(attempt.id, 'SUBMISSION_UNKNOWN', error, nextAction);
      return blocked('blocked', decision, 'conflict', error, nextAction, execution);
    }
    if (remoteOutcome.state !== 'failed') {
      const reportedQuerySha256 = remoteOutcome.sourceReceipt.querySha256;
      if (reportedQuerySha256 && reportedQuerySha256 !== attempt.query_sha256) {
        const error = 'Remote receipt query identity does not match the frozen analytics answer attempt.';
        const nextAction = 'Do not resubmit; inspect the exact attempt and remote run receipts.';
        if (attempt.source_kind === 'datanet_etl') {
          const runId = remoteOutcome.state === 'pending'
            ? remoteOutcome.runId
            : remoteOutcome.sourceReceipt.sourceId;
          holdEtlAttempt(attempt.id, 'RECEIPT_CONFLICT', error, nextAction, runId);
        } else {
          finishAttempt(attempt.id, {
            state: 'failed', sourceKind: attempt.source_kind, code: 'remote_failed', error, nextAction,
          });
        }
        return blocked('blocked', decision, 'conflict', error, nextAction, execution);
      }
      const reportedRunId = remoteOutcome.state === 'pending'
        ? remoteOutcome.runId
        : remoteOutcome.sourceReceipt.sourceId;
      if (attempt.remote_run_id && reportedRunId && reportedRunId !== attempt.remote_run_id) {
        const error = `Remote run ${reportedRunId} does not match checkpointed run ${attempt.remote_run_id}.`;
        const nextAction = `Do not resubmit; continue only checkpointed run ${attempt.remote_run_id}.`;
        holdEtlAttempt(attempt.id, 'RECEIPT_CONFLICT', error, nextAction);
        return blocked('blocked', decision, 'conflict', error, nextAction, execution);
      }
      remoteOutcome = {
        ...remoteOutcome,
        sourceReceipt: {
          ...remoteOutcome.sourceReceipt,
          querySha256: attempt.query_sha256,
        },
      };
    }
    if (remoteOutcome.state === 'pending') {
      finishAttempt(attempt.id, remoteOutcome);
      return {
        status: 'pending',
        decision,
        runId: remoteOutcome.runId,
        remoteStatus: remoteOutcome.remoteStatus,
        nextAction: remoteOutcome.nextAction,
        execution,
      };
    }
    if (remoteOutcome.state === 'failed') {
      finishAttempt(attempt.id, remoteOutcome);
      return blocked('failed', decision, remoteOutcome.code, remoteOutcome.error, remoteOutcome.nextAction, execution);
    }
    if (!attempt.metric_value_column) {
      const error = 'The persisted ETL attempt predates the metric-alias checkpoint and cannot be validated safely.';
      const nextAction = 'Do not resubmit. Reconcile or retire this legacy attempt after inspecting its exact remote run.';
      if (attempt.source_kind === 'datanet_etl') {
        holdEtlAttempt(attempt.id, 'SUBMISSION_CONTEXT_UNKNOWN', error, nextAction, remoteOutcome.sourceReceipt.sourceId);
      } else {
        finishAttempt(attempt.id, {
          state: 'failed', sourceKind: attempt.source_kind, code: 'remote_failed', error, nextAction,
        });
      }
      return blocked('blocked', decision, 'conflict', error, nextAction, execution);
    }
    remoteOutcome = {
      ...remoteOutcome,
      result: boundRemoteResult(remoteOutcome.result, request.resultLimit ?? 200),
    };
    try {
      const answer = remoteAnswer(
        request,
        cleanMetricColumn(attempt.metric_value_column),
        decision,
        remoteOutcome,
        request.datasetId,
        request.requiredContractSha256,
      );
      finishAttempt(attempt.id, remoteOutcome, answer);
      return { status: 'answered', decision, answer, execution };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const failure: AnalyticsRemoteOutcome = {
        state: 'failed', sourceKind: remoteOutcome.sourceKind, code: 'remote_failed',
        error: message, nextAction: 'Correct the governed fallback query or result aliases before retrying.',
      };
      finishAttempt(attempt.id, failure);
      return blocked('failed', decision, 'remote_failed', message, failure.nextAction, execution);
    }
  }

  async function answer(requestInput: AnalyticsAnswerRequest, options: { signal?: AbortSignal } = {}): Promise<AnalyticsAnswerOutcome> {
    const execution = baseExecution();
    let request: AnalyticsRequest;
    try {
      request = normalizeAnalyticsRequest({ ...requestInput.request, use: 'local_answer' });
    } catch (error) {
      const decision: AnalyticsSourceDecision = { kind: 'clarification_required', reason: 'request_semantics_unresolved', candidates: [] };
      return blocked('failed', decision, 'invalid_input', error instanceof Error ? error.message : String(error), 'Provide a complete typed analytics request.', execution);
    }
    if (request.unresolvedSemantics?.length) {
      const decision = chooseAnalyticsSource(
        request,
        [],
        { sqlUsable: false, etlUsable: false },
        now().getTime(),
      );
      return {
        status: 'clarification_required',
        decision,
        clarificationFields: decision.clarificationFields ?? [],
        nextAction: 'Resolve the listed business semantics and call answer_analytics once with the complete request.',
        execution,
      };
    }
    const candidates = projections(request, execution);
    if (request.datasetId && input.store.findDatasetsForRequest(request).length === 0) {
      const decision: AnalyticsSourceDecision = { kind: 'blocked_no_lane', reason: 'no_eligible_source', candidates: [] };
      return blocked('blocked', decision, 'no_source_definition', `Dataset ${request.datasetId} was not found or is inactive.`, 'Use an exact active dataset ID or remove the pin.', execution);
    }
    if (request.versionId && !candidates.some(candidate => candidate.version.id === request.versionId)) {
      const decision: AnalyticsSourceDecision = { kind: 'blocked_no_lane', reason: 'no_eligible_source', candidates: candidates.map(item => ({
        eligible: false,
        datasetId: item.dataset.id,
        versionId: item.version.id,
        capability: 'materialized_answer',
        rejections: [{ code: 'contract_mismatch', detail: 'Exact requested version was not found for this dataset.' }],
        warnings: [], requestedPartitions: [], missingPartitions: [],
      })) };
      return blocked('blocked', decision, 'not_found', `Version ${request.versionId} was not found for the selected dataset.`, 'Use an exact catalog version ID.', execution);
    }
    const derivations = derivationPlans(request, candidates.length);
    const sourceCandidates = [
      ...candidates.map(item => item.candidate),
      ...derivations.candidates,
    ];
    execution.catalogCandidates = sourceCandidates.length;
    const localDecision = chooseAnalyticsSource(request, sourceCandidates, { sqlUsable: false, etlUsable: false }, now().getTime());
    if (localDecision.kind === 'clarification_required') {
      return {
        status: 'clarification_required',
        decision: localDecision,
        clarificationFields: localDecision.clarificationFields ?? [],
        nextAction: 'Resolve the listed business semantics and call answer_analytics once with the complete request.',
        execution,
      };
    }
    if (localDecision.kind === 'blocked_policy') {
      return blocked('blocked', localDecision, 'policy_denied', 'The requested answer channel is disallowed by the dataset handling contract.', 'Use an allowed owner surface; do not bypass the policy with a remote copy.', execution);
    }
    if (request.versionId && localDecision.kind !== 'ready_materialized') {
      const rejectionCodes = localDecision.candidates.flatMap(candidate => candidate.rejections.map(rejection => rejection.code));
      const code = rejectionCodes.includes('integrity_unverified') || rejectionCodes.includes('content_missing')
        ? 'integrity_failed'
        : 'query_unsupported';
      return blocked(
        'blocked',
        localDecision,
        code,
        `Exact version ${request.versionId} cannot satisfy this request.`,
        'Inspect that version eligibility receipt; exact version pins never fall through to a remote substitute.',
        execution,
      );
    }
    if (localDecision.kind === 'ready_materialized') {
      const projection = candidates.find(item => item.version.id === localDecision.selectedVersionId);
      if (!projection) return blocked('failed', localDecision, 'integrity_failed', 'Selected local version disappeared before query.', 'Retry once; if it repeats, inspect the catalog integrity receipt.', execution);
      try {
        execution.integrityChecks++;
        execution.localQueries++;
        const query = await input.localQuery.execute({ dataset: projection.dataset, version: projection.version, request, signal: options.signal });
        return { status: 'answered', decision: localDecision, answer: localAnswer(request, projection, localDecision, query), execution };
      } catch (error) {
        const code = error instanceof AnalyticsDataRoomError ? error.code : 'integrity_failed';
        const message = error instanceof Error ? error.message : String(error);
        return blocked('failed', localDecision, code, message, 'Retry transient local I/O once; restore or reacquire deterministic corruption.', execution);
      }
    }

    if (localDecision.kind === 'ready_derived') {
      const derivationKey = localDecision.selectedDerivationKey;
      const plan = derivationKey ? derivations.plans.get(derivationKey) : undefined;
      if (!input.derivation || !plan || !derivationKey) {
        return blocked('failed', localDecision, 'integrity_failed', 'Selected local derivation plan disappeared before execution.', 'Retry once without changing the request; inspect dependency integrity if it repeats.', execution);
      }
      const materialized = await input.derivation.materialize({
        datasetId: plan.dataset.id,
        request,
        consumer: { kind: 'answer', id: analyticsRequestSha256(request) },
        expectedMaterializationKeySha256: derivationKey,
      });
      if (materialized.state === 'blocked') {
        return blocked('failed', localDecision, materialized.code, materialized.error, materialized.nextAction, execution);
      }
      if (materialized.state === 'pending') {
        return {
          status: 'pending',
          decision: localDecision,
          runId: materialized.run.id,
          remoteStatus: materialized.run.status.toUpperCase(),
          nextAction: materialized.nextAction,
          execution,
        };
      }
      const dataset = input.store.getDataset(materialized.version.datasetId);
      if (!dataset || materialized.version.derivation?.materializationKeySha256 !== derivationKey) {
        return blocked('failed', localDecision, 'integrity_failed', 'Derived output does not match the selected exact materialization.', 'Inspect the derived run and immutable lineage receipt.', execution);
      }
      const support = input.localQuery.supports({ dataset, version: materialized.version, request });
      if (!support.supported) {
        return blocked('failed', localDecision, 'query_unsupported', support.reason, 'Revise the derived output recipe; do not fall through to a remote source.', execution);
      }
      try {
        execution.integrityChecks++;
        execution.localQueries++;
        const query = await input.localQuery.execute({ dataset, version: materialized.version, request, signal: options.signal });
        const projection: AnalyticsCatalogCandidateProjection = {
          dataset,
          version: materialized.version,
          recipe: support.recipe,
          candidate: derivations.candidates.find(candidate => candidate.derivationKey === derivationKey)!,
        };
        return {
          status: 'answered',
          decision: localDecision,
          answer: localAnswer(request, projection, localDecision, query, 'local_derivation'),
          execution,
        };
      } catch (error) {
        const code = error instanceof AnalyticsDataRoomError ? error.code : 'integrity_failed';
        return blocked('failed', localDecision, code, error instanceof Error ? error.message : String(error), 'Inspect the exact derived version; do not switch to SQL/ETL after local execution.', execution);
      }
    }
    if (derivations.exactError) {
      return blocked(
        'blocked',
        localDecision,
        derivations.exactError.code,
        derivations.exactError.message,
        'Fix the exact derived dependency or handling contract; remote acquisition is not a bypass.',
        execution,
      );
    }

    const requestSha256 = analyticsRequestSha256(request);
    recoverInterruptedAttempts();
    const active = activeAttempt(requestSha256);
    if (active) {
      const decision = attemptDecision(active, localDecision);
      if (active.source_kind !== 'datanet_etl' || active.status !== 'waiting_remote') {
        return blocked(
          'blocked',
          decision,
          'conflict',
          'An analytics answer attempt for this normalized request is already active.',
          'Wait for that attempt; changing fallback SQL does not authorize another remote execution.',
          execution,
        );
      }
      if (!active.metric_value_column) {
        return blocked(
          'blocked',
          decision,
          'conflict',
          active.error || 'The active ETL attempt lacks frozen metric-alias context.',
          active.next_action || 'Do not resubmit; reconcile or retire the exact attempt after inspecting Datanet.',
          execution,
        );
      }
      if (!active.remote_run_id || !/^\d+$/.test(active.remote_run_id)) {
        return blocked(
          'blocked',
          decision,
          'conflict',
          active.error || 'The ETL submission outcome is unknown and no exact run ID is checkpointed.',
          active.next_action || 'Do not resubmit; inspect Datanet and reconcile an exact run ID first.',
          execution,
        );
      }
      execution.remoteExecutions++;
      const outcome = await input.remote.readEtlRun(active.remote_run_id);
      return handleRemote(request, decision, execution, outcome, active.id);
    }

    let sql: string;
    let metricValueColumn: string;
    try {
      sql = validateReadOnlySql(requestInput.warehouseSql);
      metricValueColumn = cleanMetricColumn(requestInput.metricValueColumn);
    } catch (error) {
      return blocked('blocked', localDecision, 'no_source_definition', error instanceof Error ? error.message : String(error), 'Provide one bounded governed read-only fallback query with exact output aliases.', execution);
    }
    const querySha256 = analyticsSha256(sql);
    execution.laneProbes++;
    const lanes = await input.remote.availability();
    const decision = chooseAnalyticsSource(request, sourceCandidates, lanes, now().getTime());
    if (decision.kind !== 'refresh_sql' && decision.kind !== 'refresh_etl') {
      return blocked(
        'blocked',
        decision,
        decision.kind === 'blocked_policy' ? 'policy_denied' : 'remote_failed',
        decision.kind === 'blocked_no_lane'
          ? 'No verified local answer or live remote data lane is available.'
          : 'The analytics request cannot execute in its current state.',
        decision.kind === 'blocked_no_lane'
          ? 'Check the SQL or Datanet ETL Connections card, then retry without changing semantics.'
          : 'Resolve the reported candidate rejection before retrying.',
        execution,
      );
    }
    let attempt: AttemptRow;
    try {
      attempt = beginAttempt(requestSha256, querySha256, metricValueColumn, decision.kind, candidates[0]?.dataset.id);
    } catch (error) {
      if (!isActiveAttemptConstraint(error)) throw error;
      return blocked('blocked', decision, 'conflict', 'An analytics answer attempt for this normalized request is already active.', 'Wait for that attempt; do not submit another remote query.', execution);
    }
    execution.remoteExecutions++;
    const outcome = await input.remote.execute({
      decision: decision.kind,
      sql,
      request,
      onEtlSubmitted: runId => checkpointEtl(attempt.id, runId),
    });
    return handleRemote(request, decision, execution, outcome, attempt.id);
  }

  return { answer };
}
