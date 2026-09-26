/**
 * Analytics data room R0–R1 contracts.
 *
 * This module contains no storage, network, model, or execution code. It is
 * the stable language shared by source routing, parity checks, the durable
 * catalog/version boundary, future dashboards, and BotBoy's answer composite.
 */

export type AnalyticsDataCell = string | number | boolean | null;
export type AnalyticsDataRoomUse = 'local_answer' | 'dashboard' | 'publication';
export type AnalyticsDataRoomScope = 'dashboard_local' | 'project' | 'workspace';
export type AnalyticsDatasetKind = 'source' | 'derived';
export type AnalyticsLocalCapability = 'materialized_answer' | 'local_derivation';
export type AnalyticsQualitySeverity = 'warning' | 'error';

export type AnalyticsLogicalType =
  | 'string'
  | 'integer'
  | 'number'
  | 'boolean'
  | 'date'
  | 'timestamp';

export interface AnalyticsDateRange {
  /** Inclusive ISO calendar date in the request's business timezone. */
  start: string;
  /** Inclusive ISO calendar date in the request's business timezone. */
  end: string;
}

export type AnalyticsFreshnessRequirement =
  | { mode: 'historical_as_of' }
  | { mode: 'allow_stale' }
  | { mode: 'fresh_by'; maxAgeMs: number };

export interface AnalyticsMetricIdentity {
  id: string;
  version: string;
  definitionSha256: string;
  unit: string;
}

export interface AnalyticsRegimeIdentity {
  id: string;
  version: string;
  definitionSha256: string;
}

export interface AnalyticsFilterValue {
  field: string;
  operator: 'eq' | 'in' | 'gte' | 'lte' | 'between';
  value: AnalyticsDataCell | AnalyticsDataCell[];
}

export interface AnalyticsRequest {
  domainKey: string;
  metric: AnalyticsMetricIdentity;
  dimensions: string[];
  filters: AnalyticsFilterValue[];
  dateRange: AnalyticsDateRange;
  timeZone: string;
  countingKey: string;
  regime: AnalyticsRegimeIdentity;
  requiredGrain: string;
  freshness: AnalyticsFreshnessRequirement;
  use: AnalyticsDataRoomUse;
  /** Optional exact logical dataset/version context; IDs are never inferred from titles. */
  datasetId?: string;
  versionId?: string;
  /** Model-visible row ceiling. The query engine applies an independent byte ceiling. */
  resultLimit?: number;
  /** Fields the planner could not resolve from operating/retrieved knowledge. */
  unresolvedSemantics?: string[];
  /** Optional exact contract expected by a pinned dashboard or caller. */
  requiredContractSha256?: string;
}

export interface AnalyticsFieldContract {
  name: string;
  logicalType: AnalyticsLogicalType;
  physicalType?: string;
  nullable: boolean;
}

export interface AnalyticsQualityAssertionEvaluation {
  assertionId: string;
  assertionVersion: string;
  severity: AnalyticsQualitySeverity;
  success: boolean;
  observed?: AnalyticsDataCell;
  expected?: AnalyticsDataCell | AnalyticsDataCell[];
}

export interface AnalyticsHandlingContract {
  classification: string;
  allowedUses: AnalyticsDataRoomUse[];
  allowModelContext: boolean;
  allowPublication: boolean;
  /** Optional provider-bound gate for rows that may be returned to a model. */
  modelContextPolicy?: {
    allowedProviderLocalities: Array<'device_local' | 'amazon_managed_remote'>;
    endpointSha256?: string;
    disclosurePolicyVersion: string;
  };
}

export interface AnalyticsCoverageContract {
  /** Canonical partition key granularity used by coverage and request-range checks. */
  partitionKind: 'day' | 'month';
  /** Every observed canonical partition in this immutable version, complete or partial. Month keys use YYYY-MM-01. */
  observedPartitions?: string[];
  /** Complete canonical partitions. Min/max alone is never eligibility. */
  completePartitions: string[];
  watermark: string;
}

/**
 * The minimum machine-readable contract adopted for R0. A separate semantic
 * graph, field-ID evolution system, and enterprise policy engine remain
 * usage-gated by ANALYTICS_DATA_ROOM_PLAN.md §3.5.
 */
export interface AnalyticsDatasetContract {
  contractVersion: string;
  contractSha256: string;
  status: 'active' | 'deprecated' | 'retired';
  datasetId: string;
  datasetKind: AnalyticsDatasetKind;
  scope: AnalyticsDataRoomScope;
  domainKey: string;
  schemaSha256: string;
  schema: AnalyticsFieldContract[];
  metric: AnalyticsMetricIdentity;
  regime: AnalyticsRegimeIdentity;
  countingKey: string;
  unit: string;
  grain: string;
  availableDimensions: string[];
  timeField: string;
  timeZone: string;
  coverage: AnalyticsCoverageContract;
  handling: AnalyticsHandlingContract;
  /** R3 executable relational semantics. Source contracts may omit it until used by a derivation. */
  relational?: AnalyticsRelationalContractV1;
}

export interface AnalyticsDataRoomCandidate {
  datasetId: string;
  /** Exact immutable output for materialized candidates. */
  versionId?: string;
  /** Canonical prospective work identity for local derivation candidates. */
  derivationKey?: string;
  capability: AnalyticsLocalCapability;
  contract: AnalyticsDatasetContract;
  contentSha256: string;
  contentExists: boolean;
  integrityVerified: boolean;
  /** False when no definition-owned exact projection recipe can answer locally. */
  querySupported?: boolean;
  /** Lower ranks win among otherwise equivalent immutable candidates. */
  selectionRank?: number;
  materializedAt: string;
  quality: AnalyticsQualityAssertionEvaluation[];
  /** A local source can derive only requests explicitly supported by code. */
  derivationSupported?: boolean;
  /** Explicit output grains supported by that deterministic derivation. */
  derivableGrains?: string[];
}

export type AnalyticsCandidateRejectionCode =
  | 'content_missing'
  | 'integrity_unverified'
  | 'contract_inactive'
  | 'contract_mismatch'
  | 'domain_mismatch'
  | 'metric_mismatch'
  | 'regime_mismatch'
  | 'counting_key_mismatch'
  | 'unit_mismatch'
  | 'grain_incompatible'
  | 'dimension_missing'
  | 'filter_field_missing'
  | 'timezone_mismatch'
  | 'coverage_gap'
  | 'freshness_miss'
  | 'quality_error'
  | 'handling_disallowed'
  | 'query_unsupported'
  | 'derivation_unsupported';

export interface AnalyticsCandidateRejection {
  code: AnalyticsCandidateRejectionCode;
  detail: string;
}

export interface AnalyticsCandidateEligibility {
  eligible: boolean;
  datasetId: string;
  versionId?: string;
  derivationKey?: string;
  capability: AnalyticsLocalCapability;
  rejections: AnalyticsCandidateRejection[];
  warnings: AnalyticsQualityAssertionEvaluation[];
  requestedPartitions: string[];
  missingPartitions: string[];
}

export interface AnalyticsRemoteLaneAvailability {
  sqlUsable: boolean;
  etlUsable: boolean;
}

export type AnalyticsSourceDecisionKind =
  | 'ready_materialized'
  | 'ready_derived'
  | 'refresh_sql'
  | 'refresh_etl'
  | 'clarification_required'
  | 'blocked_policy'
  | 'blocked_no_lane';

export type AnalyticsSourceDecisionReason =
  | 'exact_materialized_candidate'
  | 'eligible_local_derivation'
  | 'local_candidates_ineligible_sql_ready'
  | 'local_candidates_ineligible_etl_ready'
  | 'request_semantics_unresolved'
  | 'handling_policy_denied'
  | 'no_eligible_source';

export interface AnalyticsSourceDecision {
  kind: AnalyticsSourceDecisionKind;
  reason: AnalyticsSourceDecisionReason;
  selectedDatasetId?: string;
  selectedVersionId?: string;
  selectedDerivationKey?: string;
  clarificationFields?: string[];
  candidates: AnalyticsCandidateEligibility[];
}

export interface AnalyticsCanonicalResult {
  columns: string[];
  rows: AnalyticsDataCell[][];
  rowCount: number;
  displayedRowCount: number;
  truncated: boolean;
}

export type AnalyticsAnswerSourceKind =
  | 'sql_context'
  | 'datanet_etl'
  | 'data_room_materialized'
  | 'data_room_derived';

export interface AnalyticsSemanticReceipt {
  requestSha256: string;
  sourceKind: AnalyticsAnswerSourceKind;
  executionKind: 'remote_query' | 'materialized_answer' | 'local_derivation';
  metric: AnalyticsMetricIdentity;
  regime: AnalyticsRegimeIdentity;
  countingKey: string;
  grain: string;
  dimensions: string[];
  unit: string;
  timeZone: string;
  requestedRange: AnalyticsDateRange;
  coveredPartitions: string[];
  watermark: string;
  datasetIds: string[];
  versionIds: string[];
  contractSha256: string;
  definitionSha256: string;
  contentSha256: string;
  materializedAt: string;
  /** R2 execution receipts; optional for frozen R0 parity fixtures. */
  sourceDecision?: Pick<AnalyticsSourceDecision, 'kind' | 'reason'>;
  schemaSha256?: string;
  querySha256?: string;
  queryCompilerVersion?: string;
  integrityVerifiedAt?: string;
  resultLimit?: number;
  resultByteLimit?: number;
  remoteSourceReceipt?: AnalyticsDataRoomSourceReceipt;
  /** R3 exact-input derivation evidence; absent for source and R0–R2 receipts. */
  inputVersionIds?: string[];
  materializationKeySha256?: string;
  transformSha256?: string;
  qualityWarnings: string[];
  limitations: string[];
}

export interface AnalyticsCanonicalAnswer {
  result: AnalyticsCanonicalResult;
  receipt: AnalyticsSemanticReceipt;
}

export type AnalyticsParityMismatchCode =
  | 'request'
  | 'columns'
  | 'rows'
  | 'row_count'
  | 'displayed_row_count'
  | 'truncation'
  | 'metric'
  | 'regime'
  | 'counting_key'
  | 'grain'
  | 'dimensions'
  | 'unit'
  | 'timezone'
  | 'requested_range'
  | 'coverage'
  | 'watermark'
  | 'contract'
  | 'definition'
  | 'quality_warnings'
  | 'limitations';

export interface AnalyticsParityMismatch {
  code: AnalyticsParityMismatchCode;
  left: unknown;
  right: unknown;
}

export interface AnalyticsParityResult {
  equal: boolean;
  leftRowSetSha256: string;
  rightRowSetSha256: string;
  mismatches: AnalyticsParityMismatch[];
}

export type AnalyticsResearchFeature =
  | 'semantic_graph'
  | 'stable_field_ids'
  | 'column_lineage'
  | 'multi_principal_authorization'
  | 'slo_incidents'
  | 'adaptive_anomaly_detection'
  | 'formal_rpo_rto';

export interface AnalyticsResearchFeatureEvidence {
  feature: AnalyticsResearchFeature;
  namedUserOutcome: boolean;
  reproducedFailureOrReuse: boolean;
  simplerContractInsufficient: boolean;
  deterministicEnforcement: boolean;
  adversarialBeforeAfterTest: boolean;
  proportionalRuntimeCost: boolean;
  reversibleOrMigratable: boolean;
  rolloutThresholdMet: boolean;
}

export interface AnalyticsResearchFeatureDecision {
  feature: AnalyticsResearchFeature;
  graduated: boolean;
  missingEvidence: Array<Exclude<keyof AnalyticsResearchFeatureEvidence, 'feature'>>;
}

// R1 durable catalog and immutable-version contracts. These remain data-only;
// filesystem, SQLite, acquisition, and HTTP capabilities live in their owning
// modules rather than leaking into the shared contract language.
export type AnalyticsDatasetLifecycle = 'draft' | 'active' | 'deprecated' | 'retired';
export type AnalyticsDatasetCatalogVisibility = 'internal' | 'job_scoped' | 'catalog';
export type AnalyticsDataRoomSourceKind = 'datanet_etl' | 'sql_context' | 'import';
export type AnalyticsDataRoomSourceFormat = 'tsv' | 'canonical_json';
export type AnalyticsVersionIntegrityStatus = 'verified' | 'quarantined';
export type AnalyticsDatasetRunStatus = 'staging' | 'verifying' | 'completed' | 'failed';

export interface AnalyticsDatasetRetentionPolicy {
  minimumVersions: number;
  automaticExpiry: boolean;
  reacquirable: boolean;
  backupRequired: boolean;
}

export interface AnalyticsMaterializedAnswerRecipeV1 {
  version: 1;
  metricId: string;
  metricValueColumn: string;
  /** Exact dimensions already represented by each immutable sidecar row. */
  rowDimensions: string[];
  filterableFields: string[];
  stableOrder: Array<{ field: string; direction: 'asc' | 'desc' }>;
}

export type AnalyticsControlOperator = AnalyticsFilterValue['operator'];
export type AnalyticsGlobalSortDirection = 'asc' | 'desc';

export interface AnalyticsDatasetControlFieldV1 {
  field: string;
  logicalType: AnalyticsLogicalType;
  nullable: boolean;
  operators: AnalyticsControlOperator[];
}

export interface AnalyticsDatasetControlDefinitionV1 {
  version: 1;
  datasetId: string;
  bindingRevision: number;
  datasetDefinitionRevision: number;
  datasetDefinitionSha256: string;
  contractSha256: string;
  schemaSha256: string;
  answerRecipeSha256: string;
  date: {
    field: string;
    logicalType: 'date' | 'timestamp';
    timeZone: string;
    inclusiveCalendarDays: true;
  };
  filters: AnalyticsDatasetControlFieldV1[];
  sort: {
    fields: Array<{ field: string; logicalType: AnalyticsLogicalType }>;
    directions: ['asc', 'desc'];
    defaultStableOrder: Array<{ field: string; direction: AnalyticsGlobalSortDirection }>;
  };
  limits: {
    maxFilters: 20;
    maxTotalInValues: 100;
    maxStringChars: 512;
    maxResultRows: number;
  };
}

export interface AnalyticsDatasetControlValuesV1 {
  version: 1;
  dateRange: AnalyticsDateRange;
  filters: AnalyticsFilterValue[];
  sort: { field: string; direction: AnalyticsGlobalSortDirection } | null;
}

export interface AnalyticsDashboardViewRequestV1 {
  version: 1;
  request: AnalyticsRequest;
  sort: AnalyticsDatasetControlValuesV1['sort'];
}

export interface AnalyticsDatasetControlState {
  widgetId: string;
  datasetId: string;
  bindingRevision: number;
  controlRevision: number;
  definition: AnalyticsDatasetControlDefinitionV1;
  definitionSha256: string;
  defaultValues: AnalyticsDatasetControlValuesV1;
  defaultValuesSha256: string;
  currentValues: AnalyticsDatasetControlValuesV1;
  currentValuesSha256: string;
  effectiveViewRequest: AnalyticsDashboardViewRequestV1;
  effectiveViewRequestSha256: string;
  projected: boolean;
  createdAt?: string;
  updatedAt?: string;
}

export interface AnalyticsControlCasV1 {
  widgetRevision: number;
  bindingRevision: number;
  controlRevision: number;
  controlValuesSha256: string;
  controlDefinitionSha256: string;
  datasetDefinitionRevision: number;
  datasetDefinitionSha256: string;
  contractSha256: string;
}

export interface AnalyticsControlApplyInput {
  expected: AnalyticsControlCasV1;
  controls: AnalyticsDatasetControlValuesV1;
}

export interface AnalyticsRelationalMeasureV1 {
  field: string;
  unit: string;
  aggregation: 'none' | 'sum' | 'min' | 'max';
  protected: boolean;
}

export interface AnalyticsRelationalContractV1 {
  version: 1;
  grainFields: string[];
  uniqueKeys: string[][];
  measures: AnalyticsRelationalMeasureV1[];
}

export interface AnalyticsDerivedDependencyV1 {
  alias: string;
  datasetId: string;
  versionPolicy: 'pinned' | 'latest_compatible' | 'latest_fresh';
  pinnedVersionId?: string;
  requiredColumns: string[];
  expectedSchemaSha256?: string;
  expectedContractSha256?: string;
}

export interface AnalyticsDatasetDependencyRecord extends AnalyticsDerivedDependencyV1 {
  derivedDatasetId: string;
  definitionRevision: number;
  position: number;
  createdAt: string;
}

export interface AnalyticsDerivedFilterStepV1 {
  id: string;
  type: 'filter';
  input: string;
  predicates: AnalyticsFilterValue[];
}

export interface AnalyticsDerivedJoinStepV1 {
  id: string;
  type: 'join';
  left: string;
  right: string;
  joinType: 'inner' | 'left';
  leftKeys: string[];
  rightKeys: string[];
  cardinality: 'one_to_one' | 'many_to_one' | 'one_to_many';
  rightFields: Array<{ field: string; as: string }>;
  nullKeys: 'error' | 'drop';
  unmatched: 'allow' | 'error';
  maxFanout: number;
}

export type AnalyticsDerivedAggregateOperation =
  | 'sum'
  | 'count_rows'
  | 'count_non_null'
  | 'count_distinct'
  | 'min'
  | 'max';

export interface AnalyticsDerivedAggregateMeasureV1 {
  operation: AnalyticsDerivedAggregateOperation;
  field?: string;
  as: string;
  outputType: 'integer' | 'number';
  unit: string;
}

export interface AnalyticsDerivedAggregateStepV1 {
  id: string;
  type: 'aggregate';
  input: string;
  groupBy: string[];
  measures: AnalyticsDerivedAggregateMeasureV1[];
}

export interface AnalyticsDerivedRatioStepV1 {
  id: string;
  type: 'ratio';
  input: string;
  numerator: string;
  denominator: string;
  as: string;
  scale: 1 | 100;
  zeroDenominator: 'error' | 'null';
  unit: 'ratio' | 'percent';
}

export interface AnalyticsDerivedPivotStepV1 {
  id: string;
  type: 'pivot';
  input: string;
  groupBy: string[];
  pivotField: string;
  values: Array<{ value: AnalyticsDataCell; as: string }>;
  measure: {
    operation: 'sum' | 'count_rows';
    field?: string;
    outputType: 'integer' | 'number';
    unit: string;
  };
  missing: 'zero' | 'null';
  unexpected: 'error';
}

export interface AnalyticsDerivedCohortStepV1 {
  id: string;
  type: 'cohort';
  input: string;
  entityKey: string;
  eventTimeField: string;
  timeZone: string;
  bucket: 'day' | 'week' | 'month';
  cohortField: string;
  periodField: string;
  nulls: 'error' | 'drop';
}

export interface AnalyticsDerivedProjectStepV1 {
  id: string;
  type: 'project';
  input: string;
  fields: Array<{ field: string; as?: string }>;
}

export type AnalyticsDerivedStepV1 =
  | AnalyticsDerivedFilterStepV1
  | AnalyticsDerivedJoinStepV1
  | AnalyticsDerivedAggregateStepV1
  | AnalyticsDerivedRatioStepV1
  | AnalyticsDerivedPivotStepV1
  | AnalyticsDerivedCohortStepV1
  | AnalyticsDerivedProjectStepV1;

export interface AnalyticsDerivedDefinitionV1 {
  version: 1;
  engine: 'botboy_relational_v1';
  dependencies: AnalyticsDerivedDependencyV1[];
  steps: AnalyticsDerivedStepV1[];
  output: string;
}

export interface AnalyticsDatasetDefinitionDocument {
  [key: string]: unknown;
  answer?: AnalyticsMaterializedAnswerRecipeV1;
  derived?: AnalyticsDerivedDefinitionV1;
}

export interface AnalyticsDatasetDefinitionInput {
  id: string;
  name: string;
  description?: string;
  kind: AnalyticsDatasetKind;
  scope: AnalyticsDataRoomScope;
  domainKey: string;
  ownerId: string;
  lifecycle?: AnalyticsDatasetLifecycle;
  /** Catalog/search visibility. Internal job datasets remain exact-ID-only. */
  catalogVisibility?: AnalyticsDatasetCatalogVisibility;
  sourceKind: AnalyticsDataRoomSourceKind;
  sourceFormat: AnalyticsDataRoomSourceFormat;
  definition: AnalyticsDatasetDefinitionDocument;
  contract: AnalyticsDatasetContract;
  retention: AnalyticsDatasetRetentionPolicy;
}

export interface AnalyticsDatasetRevisionInput extends AnalyticsDatasetDefinitionInput {
  expectedDefinitionRevision: number;
}

export interface AnalyticsDatasetDefinitionRecord {
  id: string;
  name: string;
  description: string;
  kind: AnalyticsDatasetKind;
  scope: AnalyticsDataRoomScope;
  domainKey: string;
  ownerId: string;
  lifecycle: AnalyticsDatasetLifecycle;
  catalogVisibility: AnalyticsDatasetCatalogVisibility;
  sourceKind: AnalyticsDataRoomSourceKind;
  sourceFormat: AnalyticsDataRoomSourceFormat;
  definition: AnalyticsDatasetDefinitionDocument;
  definitionRevision: number;
  definitionSha256: string;
  contract: AnalyticsDatasetContract;
  contractSha256: string;
  schemaSha256: string;
  retention: AnalyticsDatasetRetentionPolicy;
  createdAt: string;
  updatedAt: string;
}

export interface AnalyticsDataRoomSourceReceipt {
  sourceKind: AnalyticsDataRoomSourceKind;
  sourceId?: string;
  querySha256?: string;
  producerVersion: string;
  acquiredAt: string;
  submittedAgain?: boolean;
}

export interface AnalyticsStoredFileReceipt {
  fileName: 'source.tsv' | 'source.json' | 'materialized.db';
  sha256: string;
  bytes: number;
}

export interface AnalyticsVersionIntegrityReceipt {
  status: AnalyticsVersionIntegrityStatus;
  verifiedAt?: string;
  reason?: string;
}

export interface AnalyticsDerivedInputPin {
  alias: string;
  datasetId: string;
  versionId: string;
  contentSha256: string;
  schemaSha256: string;
  contractSha256: string;
  definitionSha256: string;
}

export interface AnalyticsDerivationLineageReceipt {
  runId: string;
  compilerVersion: string;
  transformSha256: string;
  inputSetSha256: string;
  materializationKeySha256: string;
  inputs: AnalyticsDerivedInputPin[];
  checks: AnalyticsQualityAssertionEvaluation[];
}

export interface AnalyticsDatasetVersionManifest {
  manifestVersion: 1 | 2;
  datasetId: string;
  versionId: string;
  ordinal: number;
  versionKeySha256: string;
  sourceFormat: AnalyticsDataRoomSourceFormat;
  sourceFile: AnalyticsStoredFileReceipt;
  materializedFile: AnalyticsStoredFileReceipt;
  rowCount: number;
  observedSchema: AnalyticsFieldContract[];
  observedSchemaSha256: string;
  contract: AnalyticsDatasetContract;
  contractSha256: string;
  coverage: AnalyticsCoverageContract;
  definitionSha256: string;
  sourceReceipt: AnalyticsDataRoomSourceReceipt;
  handling: AnalyticsHandlingContract;
  quality: AnalyticsQualityAssertionEvaluation[];
  materializedAt: string;
  reacquirable: boolean;
  createdAt: string;
  /** Present only on immutable manifest v2 derived outputs. */
  derivation?: AnalyticsDerivationLineageReceipt;
}

export interface AnalyticsDatasetHeadRecord {
  datasetId: string;
  versionId: string;
  definitionRevision: number;
  headRevision: number;
  promotedAt: string;
  promotionReceipt: Record<string, unknown>;
}

export interface AnalyticsDatasetVersionSummary {
  id: string;
  datasetId: string;
  ordinal: number;
  versionKeySha256: string;
  sourceFormat: AnalyticsDataRoomSourceFormat;
  sourceSha256: string;
  sourceBytes: number;
  materializedSha256: string;
  materializedBytes: number;
  manifestSha256: string;
  rowCount: number;
  observedSchemaSha256: string;
  contractSha256: string;
  coverage: AnalyticsCoverageContract;
  definitionSha256: string;
  materializedAt: string;
  integrity: AnalyticsVersionIntegrityReceipt;
  reacquirable: boolean;
  createdAt: string;
}

export interface AnalyticsDatasetVersionDetail extends AnalyticsDatasetVersionSummary {
  files: {
    source: AnalyticsStoredFileReceipt;
    materialized: AnalyticsStoredFileReceipt;
  };
  observedSchema: AnalyticsFieldContract[];
  contract: AnalyticsDatasetContract;
  sourceReceipt: AnalyticsDataRoomSourceReceipt;
  handling: AnalyticsHandlingContract;
  quality: AnalyticsQualityAssertionEvaluation[];
  derivation?: AnalyticsDerivationLineageReceipt;
}

export interface AnalyticsDatasetSummary {
  id: string;
  name: string;
  description: string;
  kind: AnalyticsDatasetKind;
  scope: AnalyticsDataRoomScope;
  domainKey: string;
  lifecycle: AnalyticsDatasetLifecycle;
  catalogVisibility: AnalyticsDatasetCatalogVisibility;
  sourceKind: AnalyticsDataRoomSourceKind;
  sourceFormat: AnalyticsDataRoomSourceFormat;
  definitionRevision: number;
  definitionSha256: string;
  contractSha256: string;
  schemaSha256: string;
  retention: AnalyticsDatasetRetentionPolicy;
  head: AnalyticsDatasetHeadRecord | null;
  currentVersion: AnalyticsDatasetVersionSummary | null;
  createdAt: string;
  updatedAt: string;
}

export interface AnalyticsDatasetDetail extends AnalyticsDatasetSummary {
  ownerId: string;
  definition: AnalyticsDatasetDefinitionDocument;
  contract: AnalyticsDatasetContract;
}

export interface AnalyticsDataRoomDatasetSearchHit {
  datasetId: string;
  name: string;
  description: string;
  kind: AnalyticsDatasetKind;
  scope: AnalyticsDataRoomScope;
  domainKey: string;
  lifecycle: AnalyticsDatasetLifecycle;
  updatedAt: string;
  matchField: 'id' | 'name' | 'description' | 'domainKey';
  currentVersion?: {
    id: string;
    ordinal: number;
    materializedAt: string;
    integrityStatus: AnalyticsVersionIntegrityStatus;
  };
}

export interface AnalyticsDataRoomBoundedPage<T> {
  items: T[];
  /** Total matching rows, not only the returned page. */
  count: number;
  limit: number;
  truncated: boolean;
}

export interface AnalyticsDataRoomCatalogHead {
  datasetId: string;
  versionId: string;
  definitionRevision: number;
  headRevision: number;
  promotedAt: string;
}

export interface AnalyticsDataRoomCatalogVersionSummary {
  id: string;
  datasetId: string;
  ordinal: number;
  versionKeySha256: string;
  sourceFormat: AnalyticsDataRoomSourceFormat;
  sourceSha256: string;
  sourceBytes: number;
  materializedSha256: string;
  materializedBytes: number;
  manifestSha256: string;
  rowCount: number;
  observedSchemaSha256: string;
  contractSha256: string;
  definitionSha256: string;
  coverage: AnalyticsCoverageContract;
  materializedAt: string;
  integrityStatus: AnalyticsVersionIntegrityStatus;
  reacquirable: boolean;
  createdAt: string;
}

export type AnalyticsVersionPolicy = 'pinned' | 'latest_compatible' | 'latest_fresh';

/** Complete server-issued input for the existing exact widget binding PUT. */
export interface AnalyticsDataRoomBindingTemplate {
  datasetId: string;
  versionPolicy: 'latest_compatible';
  expectedSchemaSha256: string;
  expectedContractSha256: string;
  requiredColumns: string[];
  presentationLimit: number;
  request: AnalyticsRequest;
}

export interface AnalyticsDataRoomCatalogDatasetSummary {
  id: string;
  name: string;
  description: string;
  kind: AnalyticsDatasetKind;
  scope: AnalyticsDataRoomScope;
  domainKey: string;
  lifecycle: AnalyticsDatasetLifecycle;
  catalogVisibility: AnalyticsDatasetCatalogVisibility;
  sourceKind: AnalyticsDataRoomSourceKind;
  sourceFormat: AnalyticsDataRoomSourceFormat;
  definitionRevision: number;
  definitionSha256: string;
  contractSha256: string;
  schemaSha256: string;
  schema: AnalyticsFieldContract[];
  metric: AnalyticsMetricIdentity;
  regime: AnalyticsRegimeIdentity;
  countingKey: string;
  unit: string;
  grain: string;
  availableDimensions: string[];
  timeField: string;
  timeZone: string;
  coverage: AnalyticsCoverageContract;
  handling: AnalyticsHandlingContract;
  retention: AnalyticsDatasetRetentionPolicy;
  head: AnalyticsDataRoomCatalogHead | null;
  currentVersion: AnalyticsDataRoomCatalogVersionSummary | null;
  bindingTemplate: AnalyticsDataRoomBindingTemplate | null;
  createdAt: string;
  updatedAt: string;
}

export interface AnalyticsDataRoomCatalogProject {
  projectId: string;
  title: string;
  status: string;
  linkedAt: string;
}

export interface AnalyticsDataRoomCatalogDependency {
  datasetId: string;
  name: string;
  kind: AnalyticsDatasetKind;
  alias: string;
  position: number;
  versionPolicy: AnalyticsVersionPolicy;
  pinnedVersionId?: string;
  requiredColumns: string[];
  expectedSchemaSha256?: string;
  expectedContractSha256?: string;
}

export interface AnalyticsDataRoomCatalogDependent {
  datasetId: string;
  name: string;
  kind: AnalyticsDatasetKind;
  definitionRevision: number;
  alias: string;
  position: number;
}

export interface AnalyticsDataRoomCatalogConsumer {
  dashboardId: string;
  dashboardTitle: string;
  widgetId: string;
  widgetTitle: string;
  bindingRevision: number;
  versionPolicy: AnalyticsVersionPolicy;
  pinnedVersionId?: string;
  compatibilityState: string;
  observedHeadRevision: number;
  lastAppliedVersionId?: string;
}

export interface AnalyticsDataRoomCatalogDashboardOwner {
  dashboardId: string;
  dashboardTitle: string;
  claimedAt: string;
}

export interface AnalyticsDataRoomCatalogActivity {
  kind: 'source' | 'derived';
  id: string;
  status: AnalyticsDatasetRunStatus | AnalyticsDerivedRunStatus;
  definitionRevision: number;
  outputVersionId?: string;
  trigger?: 'manual' | 'api' | 'agent' | 'scheduled';
  sourceKind?: AnalyticsDataRoomSourceKind;
  queuedAt: string;
  startedAt?: string;
  completedAt?: string;
}

export interface AnalyticsDataRoomCatalogQuality {
  assertionId: string;
  assertionVersion: string;
  severity: AnalyticsQualitySeverity;
  success: boolean;
}

export interface AnalyticsDataRoomCatalogVersionInput {
  alias: string;
  position: number;
  datasetId: string;
  versionId: string;
  contentSha256: string;
  schemaSha256: string;
  contractSha256: string;
  definitionSha256: string;
}

export interface AnalyticsDataRoomCatalogVersionOutput {
  alias: string;
  position: number;
  datasetId: string;
  datasetName: string;
  versionId: string;
  ordinal: number;
  materializedAt: string;
  contentSha256: string;
  schemaSha256: string;
  contractSha256: string;
  definitionSha256: string;
}

export interface AnalyticsDataRoomCatalogDatasetDetail extends AnalyticsDataRoomCatalogDatasetSummary {
  projects: AnalyticsDataRoomBoundedPage<AnalyticsDataRoomCatalogProject>;
  dependencies: AnalyticsDataRoomBoundedPage<AnalyticsDataRoomCatalogDependency>;
  dependents: AnalyticsDataRoomBoundedPage<AnalyticsDataRoomCatalogDependent>;
  consumers: AnalyticsDataRoomBoundedPage<AnalyticsDataRoomCatalogConsumer>;
  dashboardOwners: AnalyticsDataRoomBoundedPage<AnalyticsDataRoomCatalogDashboardOwner>;
  activity: AnalyticsDataRoomBoundedPage<AnalyticsDataRoomCatalogActivity>;
}

export interface AnalyticsDataRoomCatalogVersionDetail extends AnalyticsDataRoomCatalogVersionSummary {
  observedSchema: AnalyticsFieldContract[];
  quality: AnalyticsDataRoomBoundedPage<AnalyticsDataRoomCatalogQuality>;
  inputs: AnalyticsDataRoomBoundedPage<AnalyticsDataRoomCatalogVersionInput>;
  outputs: AnalyticsDataRoomBoundedPage<AnalyticsDataRoomCatalogVersionOutput>;
}

export interface AnalyticsDataRoomCatalogDatasetList {
  dataRoomVersion: string;
  datasets: AnalyticsDataRoomCatalogDatasetSummary[];
  count: number;
  limit: number;
  truncated: boolean;
}

export interface AnalyticsDataRoomCatalogDatasetEnvelope {
  dataRoomVersion: string;
  dataset: AnalyticsDataRoomCatalogDatasetDetail;
}

export interface AnalyticsDataRoomCatalogVersionList {
  dataRoomVersion: string;
  datasetId: string;
  versions: AnalyticsDataRoomCatalogVersionSummary[];
  count: number;
  limit: number;
  truncated: boolean;
}

export interface AnalyticsDataRoomCatalogVersionEnvelope {
  dataRoomVersion: string;
  version: AnalyticsDataRoomCatalogVersionDetail;
}

export interface AnalyticsDatasetRunRecord {
  id: string;
  datasetId: string;
  trigger: 'manual' | 'api' | 'agent' | 'scheduled';
  requestSha256: string;
  definitionRevision: number;
  definitionSha256: string;
  status: AnalyticsDatasetRunStatus;
  sourceKind: AnalyticsDataRoomSourceKind;
  remoteIdentity?: Record<string, unknown>;
  outputVersionId?: string;
  receipt?: Record<string, unknown>;
  error?: string;
  queuedAt: string;
  startedAt?: string;
  completedAt?: string;
}

export interface AnalyticsVersionIngestContext {
  datasetId: string;
  expectedHeadRevision: number;
  materializedAt: string;
  sourceReceipt: AnalyticsDataRoomSourceReceipt;
  quality: AnalyticsQualityAssertionEvaluation[];
  trigger?: AnalyticsDatasetRunRecord['trigger'];
  requestSha256?: string;
}

export interface AnalyticsTsvIngestRequest extends AnalyticsVersionIngestContext {
  bytes: Uint8Array;
}

export interface AnalyticsSqlRowsIngestRequest extends AnalyticsVersionIngestContext {
  columns: string[];
  rows: AnalyticsDataCell[][];
  rowCount: number;
  displayedRowCount: number;
  truncated: boolean;
}

export interface AnalyticsCompleteImportRowsReceipt {
  parserVersion: string;
  transformVersion: string;
  completeToEof: true;
  inputSha256: string;
  profileSha256: string;
  rowsetSha256: string;
  schemaSha256: string;
}

export interface AnalyticsImportRowsIngestRequest extends AnalyticsVersionIngestContext {
  columns: string[];
  rows: AnalyticsDataCell[][];
  rowCount: number;
  complete: AnalyticsCompleteImportRowsReceipt;
}

export interface AnalyticsVersionPromotionReceipt {
  datasetId: string;
  version: AnalyticsDatasetVersionDetail;
  head: AnalyticsDatasetHeadRecord;
  run: AnalyticsDatasetRunRecord;
  idempotent: boolean;
}

export interface AnalyticsDatasetBackupReceipt {
  backupId: string;
  datasetId: string;
  targetDirectory: string;
  manifestSha256: string;
  versionIds: string[];
  createdAt: string;
  verifiedAt: string;
}

export interface AnalyticsDatasetRestoreReceipt {
  restoreId: string;
  backupId: string;
  datasetId: string;
  versionIds: string[];
  restoredAt: string;
  idempotent: boolean;
}

export interface AnalyticsCatalogCandidateProjection {
  dataset: AnalyticsDatasetDetail;
  version: AnalyticsDatasetVersionDetail;
  recipe: AnalyticsMaterializedAnswerRecipeV1 | null;
  candidate: AnalyticsDataRoomCandidate;
}

export type AnalyticsDerivedRunStatus = 'queued' | 'running' | 'completed' | 'failed';

export interface AnalyticsDerivedRunRecord {
  id: string;
  datasetId: string;
  definitionRevision: number;
  definitionSha256: string;
  expectedHeadRevision: number;
  requestSha256: string;
  transformSha256: string;
  inputSetSha256: string;
  materializationKeySha256: string;
  status: AnalyticsDerivedRunStatus;
  outputVersionId?: string;
  receipt?: Record<string, unknown>;
  error?: string;
  nextAction?: string;
  queuedAt: string;
  startedAt?: string;
  completedAt?: string;
}

export interface AnalyticsDerivationPlan {
  dataset: AnalyticsDatasetDetail;
  definition: AnalyticsDerivedDefinitionV1;
  inputs: AnalyticsDerivedInputPin[];
  transformSha256: string;
  inputSetSha256: string;
  materializationKeySha256: string;
  expectedHeadRevision: number;
  requestSha256: string;
}

export type AnalyticsDerivedMaterializationOutcome =
  | {
      state: 'ready';
      run: AnalyticsDerivedRunRecord;
      version: AnalyticsDatasetVersionDetail;
      joinedExisting: boolean;
    }
  | {
      state: 'pending';
      run: AnalyticsDerivedRunRecord;
      joinedExisting: boolean;
      nextAction: string;
    }
  | {
      state: 'blocked';
      code: AnalyticsDataRoomErrorCode;
      error: string;
      nextAction: string;
    };

export interface AnalyticsDerivedConsumerContext {
  kind: 'answer' | 'dashboard_widget';
  id: string;
}

export interface AnalyticsDerivedMaterializationRequest {
  datasetId: string;
  request: AnalyticsRequest;
  consumer: AnalyticsDerivedConsumerContext;
  /** Optional resolver pin: fail rather than silently switching to a newer input vector. */
  expectedMaterializationKeySha256?: string;
}

export interface AnalyticsCompiledLocalQuery {
  compilerVersion: string;
  versionId: string;
  columns: string[];
  sql: string;
  countSql: string;
  params: AnalyticsDataCell[];
  querySha256: string;
  rowLimit: number;
  byteLimit: number;
  /** Present only for R5 dashboard control/view snapshots. */
  effectiveViewRequestSha256?: string;
  controlDefinitionSha256?: string;
  controlValuesSha256?: string;
}

export interface AnalyticsLocalQueryReceipt {
  querySha256: string;
  compilerVersion: string;
  versionId: string;
  integrityVerifiedAt: string;
  elapsedMs: number;
  rowLimit: number;
  byteLimit: number;
}

export interface AnalyticsLocalQueryResult {
  result: AnalyticsCanonicalResult;
  receipt: AnalyticsLocalQueryReceipt;
}

export interface AnalyticsAnswerRequest {
  request: AnalyticsRequest;
  /** Expected metric column/alias in a remote result; never used as SQL structure locally. */
  metricValueColumn: string;
  /** One lane-neutral, governed read query used only after a verified room miss. */
  warehouseSql: string;
}

export interface AnalyticsAnswerExecutionCounts {
  catalogCandidates: number;
  integrityChecks: number;
  laneProbes: number;
  remoteExecutions: number;
  localQueries: number;
}

export type AnalyticsAnswerOutcome =
  | {
      status: 'answered';
      decision: AnalyticsSourceDecision;
      answer: AnalyticsCanonicalAnswer;
      execution: AnalyticsAnswerExecutionCounts;
    }
  | {
      status: 'clarification_required';
      decision: AnalyticsSourceDecision;
      clarificationFields: string[];
      nextAction: string;
      execution: AnalyticsAnswerExecutionCounts;
    }
  | {
      status: 'pending';
      decision: AnalyticsSourceDecision;
      runId: string;
      remoteStatus: string;
      nextAction: string;
      execution: AnalyticsAnswerExecutionCounts;
    }
  | {
      status: 'blocked' | 'failed';
      decision: AnalyticsSourceDecision;
      code: AnalyticsDataRoomErrorCode;
      error: string;
      nextAction: string;
      execution: AnalyticsAnswerExecutionCounts;
    };

export type AnalyticsDataRoomErrorCode =
  | 'invalid_input'
  | 'not_found'
  | 'conflict'
  | 'definition_changed'
  | 'integrity_failed'
  | 'policy_denied'
  | 'incomplete_source'
  | 'backup_required'
  | 'query_unsupported'
  | 'query_timeout'
  | 'query_cancelled'
  | 'remote_pending'
  | 'no_source_definition'
  | 'remote_failed';
