import type {
  AnalyticsDatasetContract,
  AnalyticsDatasetRetentionPolicy,
  AnalyticsDatasetVersionDetail,
  AnalyticsDerivedStepV1,
  AnalyticsFieldContract,
  AnalyticsMaterializedAnswerRecipeV1,
  AnalyticsQualityAssertionEvaluation,
  AnalyticsRelationalContractV1,
  AnalyticsRequest,
} from './analytics-data-room-types.js';

export const ANALYTICS_JOB_SCHEMA_VERSION = 1 as const;
export const ANALYTICS_JOB_PLANNER_VERSION = 'analytics-job-planner-v1';
export const ANALYTICS_JOB_FRAGMENT_VERSION = 'analytics-job-fragment-v1';
export const ANALYTICS_JOB_RECEIPT_VERSION = 'analytics-job-receipt-v1';

export type AnalyticsJobStatus =
  | 'planning'
  | 'running'
  | 'needs_input'
  | 'needs_approval'
  | 'waiting_external'
  | 'blocked'
  | 'delivering'
  | 'complete'
  | 'cancel_requested'
  | 'cancelled'
  | 'failed';

export type AnalyticsJobNodeKind =
  | 'source_resolution'
  | 'transform_fragment'
  | 'result_publication'
  | 'answer_delivery'
  | 'retain_delivery';

export type AnalyticsJobNodeState =
  | 'planned'
  | 'ready'
  | 'running'
  | 'needs_input'
  | 'needs_approval'
  | 'waiting_external'
  | 'succeeded'
  | 'blocked'
  | 'failed'
  | 'cancelled';

export type AnalyticsJobAttemptStatus =
  | 'running'
  | 'waiting_external'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'interrupted';

export type AnalyticsJobRetryClass = 'none' | 'transient' | 'owner_action' | 'definition_change';
export type AnalyticsJobResultVisibility = 'job_scoped' | 'catalog';
export type AnalyticsJobConsumer =
  | { kind: 'answer' }
  | { kind: 'retain_dataset'; name: string };

export interface AnalyticsJobOwnerRequest {
  ownerId: string;
  requestId: string;
  message: string;
  scope?: {
    dashboardId?: string;
    selectedWidgetIds?: string[];
    projectIds?: string[];
  };
}

export interface AnalyticsJobExistingInputV1 {
  alias: string;
  datasetId: string;
  versionId: string;
  requiredColumns: string[];
  expectedSchemaSha256: string;
  expectedContractSha256: string;
}

export interface AnalyticsDatasetPreparationTargetV1 {
  datasetId?: string;
  expectedHeadRevision?: number;
  name: string;
  description: string;
  domainKey: string;
  schema: AnalyticsFieldContract[];
  metric: { id: string; version: string; unit: string; definition: string };
  regime: { id: string; version: string; definition: string };
  countingKey: string;
  grain: string;
  availableDimensions: string[];
  timeField: string;
  timeZone: string;
  coverage: AnalyticsDatasetContract['coverage'];
  answer: AnalyticsMaterializedAnswerRecipeV1;
  relational?: AnalyticsRelationalContractV1;
  classification?: string;
  allowPublication?: boolean;
  retention?: AnalyticsDatasetRetentionPolicy;
  quality?: AnalyticsQualityAssertionEvaluation[];
}

export type AnalyticsDatasetPreparationSourceV1 =
  | ({ kind: 'existing_version' } & AnalyticsJobExistingInputV1)
  | {
      kind: 'sql_query';
      alias: string;
      sql: string;
      target: AnalyticsDatasetPreparationTargetV1;
    }
  | {
      kind: 'etl_query';
      alias: string;
      sql: string;
      datasetDate?: string;
      target: AnalyticsDatasetPreparationTargetV1;
    }
  | {
      kind: 'botboy_csv';
      alias: string;
      filename: string;
      sha256: string;
      bytes: number;
      nullToken: string;
      target: AnalyticsDatasetPreparationTargetV1;
    }
  | {
      kind: 'import_inbox';
      alias: string;
      importId: string;
      requiredColumns: string[];
    };

export interface AnalyticsDatasetPreparationPlanV1 {
  version: 1;
  mode: 'dataset_preparation';
  request: AnalyticsRequest;
  sources: AnalyticsDatasetPreparationSourceV1[];
  fragments: AnalyticsJobFragmentV1[];
  terminal: { kind: 'source'; alias: string } | { kind: 'fragment'; fragmentId: string };
}

export type AnalyticsJobFragmentContractV1 = Omit<
  AnalyticsDatasetContract,
  'contractSha256' | 'schemaSha256' | 'datasetId' | 'datasetKind' | 'scope' | 'status' | 'coverage' | 'handling'
>;

export interface AnalyticsJobFragmentV1 {
  version: 1;
  id: string;
  name: string;
  description: string;
  dependencies: Array<{
    alias: string;
    sourceRef: string;
    requiredColumns: string[];
  }>;
  steps: AnalyticsDerivedStepV1[];
  output: string;
  contract: AnalyticsJobFragmentContractV1;
  answer: AnalyticsMaterializedAnswerRecipeV1;
}

export interface AnalyticsJobPlanV1 {
  version: 1;
  request: AnalyticsRequest;
  consumers: AnalyticsJobConsumer[];
  inputs: AnalyticsJobExistingInputV1[];
  fragments: AnalyticsJobFragmentV1[];
  terminal: { kind: 'input'; alias: string } | { kind: 'fragment'; fragmentId: string };
}

export interface AnalyticsJobIntentV1 {
  version: 1;
  goal: string;
  ownerMessageSha256: string;
  /** Empty while planning; admitted consumers are stored in the validated plan and result receipts. */
  consumers: AnalyticsJobConsumer[];
}

export interface AnalyticsDatasetPreparationIntentV1 {
  version: 2;
  mode: 'dataset_preparation';
  goal: string;
  ownerMessageSha256: string;
  plan: AnalyticsDatasetPreparationPlanV1;
}

export type AnalyticsJobIntent = AnalyticsJobIntentV1 | AnalyticsDatasetPreparationIntentV1;

export interface AnalyticsJobRecord {
  id: string;
  ownerId: string;
  ownerRequestId: string;
  ownerMessageSha256: string;
  intent: AnalyticsJobIntent;
  intentSha256: string;
  status: AnalyticsJobStatus;
  stateRevision: number;
  planRevision: number;
  planSha256?: string;
  questionCount: number;
  questionReceipt?: Record<string, unknown>;
  resultId?: string;
  completionReceipt?: AnalyticsJobCompletionReceipt;
  errorCode?: string;
  errorMessage?: string;
  nextAction?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  cancelRequestedAt?: string;
}

export interface AnalyticsJobNodeRecord {
  id: string;
  jobId: string;
  planRevision: number;
  kind: AnalyticsJobNodeKind;
  adapterVersion: string;
  state: AnalyticsJobNodeState;
  stateRevision: number;
  logicalRequestSha256: string;
  spec: Record<string, unknown>;
  inputIdentity?: Record<string, unknown>;
  inputContractSha256?: string;
  currentAttemptId?: string;
  leaseOwner?: string;
  leaseExpiresAt?: string;
  heartbeatAt?: string;
  outputDatasetId?: string;
  outputVersionId?: string;
  outputResultId?: string;
  errorCode?: string;
  errorMessage?: string;
  retryClass?: AnalyticsJobRetryClass;
  nextAction?: string;
  createdAt: string;
  updatedAt: string;
  terminalAt?: string;
}

export interface AnalyticsJobEdgeRecord {
  jobId: string;
  planRevision: number;
  fromNodeId: string;
  toNodeId: string;
  inputPosition: number;
  inputName: string;
  createdAt: string;
}

export interface AnalyticsJobAttemptRecord {
  id: string;
  jobId: string;
  nodeId: string;
  attemptOrdinal: number;
  status: AnalyticsJobAttemptStatus;
  invocationRef?: Record<string, unknown>;
  checkpoint?: Record<string, unknown>;
  checkpointedAt?: string;
  receipt?: Record<string, unknown>;
  retryClass?: AnalyticsJobRetryClass;
  errorCode?: string;
  errorMessage?: string;
  nextAction?: string;
  startedAt: string;
  completedAt?: string;
}

export interface AnalyticsJobResultManifestV1 {
  version: 1;
  jobId: string;
  finalPlanSha256: string;
  primary: {
    datasetId: string;
    versionId: string;
    materializedSha256: string;
    observedSchemaSha256: string;
    contractSha256: string;
    definitionSha256: string;
    rowCount: number;
  };
  leafVersions: Array<{
    alias: string;
    datasetId: string;
    versionId: string;
    materializedSha256: string;
    observedSchemaSha256: string;
    contractSha256: string;
    definitionSha256: string;
  }>;
  fragmentVersions: Array<{
    fragmentId: string;
    datasetId: string;
    versionId: string;
    materializationKeySha256: string;
    transformSha256: string;
    inputVersionIds: string[];
  }>;
  request: AnalyticsRequest;
  contract: AnalyticsDatasetContract;
  coverage: AnalyticsDatasetContract['coverage'];
  handling: AnalyticsDatasetContract['handling'];
}

export interface AnalyticsJobResultRecord {
  id: string;
  jobId: string;
  finalPlanSha256: string;
  primaryVersionId: string;
  manifest: AnalyticsJobResultManifestV1;
  manifestSha256: string;
  visibility: AnalyticsJobResultVisibility;
  retention: AnalyticsDatasetRetentionPolicy;
  receipt: Record<string, unknown>;
  receiptSha256: string;
  createdAt: string;
}

export interface AnalyticsJobCompletionReceipt {
  receiptVersion: typeof ANALYTICS_JOB_RECEIPT_VERSION;
  jobId: string;
  ownerRequestId: string;
  intentSha256: string;
  planSha256: string;
  resultId: string;
  resultManifestSha256: string;
  resultReceiptSha256: string;
  primaryDatasetId: string;
  primaryVersionId: string;
  sourceVersionIds: string[];
  fragmentVersionIds: string[];
  consumers: AnalyticsJobConsumer[];
  completedConsumers: AnalyticsJobConsumer[];
  joinedExisting: boolean;
  recoveredAfterRestart: boolean;
  completedAt: string;
  receiptSha256?: string;
}

export interface AnalyticsJobObservation {
  job: AnalyticsJobRecord;
  nodes: AnalyticsJobNodeRecord[];
  edges: AnalyticsJobEdgeRecord[];
  attempts: AnalyticsJobAttemptRecord[];
  result?: AnalyticsJobResultRecord;
}

export type AnalyticsJobToolStatus =
  | 'completed'
  | 'in_progress'
  | 'waiting_external'
  | 'needs_approval'
  | 'needs_input'
  | 'blocked'
  | 'cancel_requested'
  | 'cancelled'
  | 'failed';

export interface AnalyticsJobToolReceipt {
  trust: 'verified_analytics_job_receipt';
  status: AnalyticsJobToolStatus;
  action: 'run' | 'prepare' | 'observe' | 'resume' | 'respond' | 'cancel';
  jobId: string;
  ownerRequestId: string;
  /** Current tool-turn request identity; differs from ownerRequestId for later management turns. */
  actionRequestId?: string;
  jobRevision: number;
  intentSha256: string;
  receiptSha256: string;
  resultId?: string;
  result?: AnalyticsJobResultManifestV1;
  answer?: {
    result: { columns: string[]; rows: unknown[][]; rowCount: number; displayedRowCount: number; truncated: boolean };
    receipt: Record<string, unknown>;
  };
  progress: {
    totalNodes: number;
    succeededNodes: number;
    activeNodes: number;
    blockedNodes: number;
    completedConsumers: string[];
  };
  question?: Record<string, unknown>;
  error?: { code: string; message: string; nextAction: string };
  responseGuidance: {
    claim: 'completed' | 'not_complete' | 'needs_input' | 'needs_approval' | 'cancelled' | 'failed';
    requiredAnchors: string[];
    nextAction: string;
  };
}

export interface AnalyticsJobClaim {
  job: AnalyticsJobRecord;
  node: AnalyticsJobNodeRecord;
  attempt: AnalyticsJobAttemptRecord;
}

export interface AnalyticsJobPlannedNodeInput {
  key: string;
  kind: AnalyticsJobNodeKind;
  adapterVersion: string;
  spec: Record<string, unknown>;
  inputIdentity?: Record<string, unknown>;
  inputContractSha256?: string;
}

export interface AnalyticsJobPlannedEdgeInput {
  fromKey: string;
  toKey: string;
  inputPosition: number;
  inputName: string;
}

export interface AnalyticsJobStore {
  createOrJoin(input: {
    ownerId: string;
    ownerRequestId: string;
    ownerMessageSha256: string;
    intent: AnalyticsJobIntent;
  }): { job: AnalyticsJobRecord; joinedExisting: boolean };
  commitPlan(input: {
    jobId: string;
    expectedStateRevision: number;
    nodes: AnalyticsJobPlannedNodeInput[];
    edges: AnalyticsJobPlannedEdgeInput[];
  }): AnalyticsJobRecord;
  observe(jobId: string): AnalyticsJobObservation;
  getJob(jobId: string): AnalyticsJobRecord | null;
  getNode(nodeId: string): AnalyticsJobNodeRecord | null;
  getResult(resultId: string): AnalyticsJobResultRecord | null;
  claimNextReady(): AnalyticsJobClaim | null;
  checkpoint(input: { attemptId: string; checkpoint: Record<string, unknown> }): AnalyticsJobAttemptRecord;
  requeueNode(input: {
    nodeId: string;
    attemptId: string;
    checkpoint?: Record<string, unknown>;
    nextAction: string;
  }): AnalyticsJobNodeRecord;
  waitNode(input: {
    nodeId: string;
    attemptId: string;
    state: 'waiting_external' | 'needs_approval';
    checkpoint: Record<string, unknown>;
    nextAction: string;
  }): AnalyticsJobNodeRecord;
  resumeWaitingNode(input: { nodeId: string; nextAction: string }): AnalyticsJobNodeRecord;
  succeedNode(input: {
    nodeId: string;
    attemptId: string;
    receipt: Record<string, unknown>;
    outputDatasetId?: string;
    outputVersionId?: string;
    outputResultId?: string;
  }): AnalyticsJobNodeRecord;
  blockPlanning(input: {
    jobId: string;
    terminal?: 'blocked' | 'failed';
    code: string;
    message: string;
    nextAction: string;
  }): AnalyticsJobRecord;
  blockNode(input: {
    nodeId: string;
    attemptId?: string;
    terminal?: 'blocked' | 'failed';
    code: string;
    message: string;
    retryClass: AnalyticsJobRetryClass;
    nextAction: string;
  }): AnalyticsJobNodeRecord;
  insertResult(input: {
    jobId: string;
    finalPlanSha256: string;
    primaryVersion: AnalyticsDatasetVersionDetail;
    manifest: AnalyticsJobResultManifestV1;
    visibility: AnalyticsJobResultVisibility;
    retention: AnalyticsDatasetRetentionPolicy;
    receipt: Record<string, unknown>;
  }): AnalyticsJobResultRecord;
  setResultVisibility(resultId: string, expected: AnalyticsJobResultVisibility, next: AnalyticsJobResultVisibility): AnalyticsJobResultRecord;
  completeJob(input: {
    jobId: string;
    expectedStateRevision: number;
    resultId: string;
    receipt: AnalyticsJobCompletionReceipt;
  }): AnalyticsJobRecord;
  requestCancel(jobId: string): AnalyticsJobRecord;
  finishCancelled(jobId: string): AnalyticsJobRecord;
  resumeBlocked(jobId: string): AnalyticsJobRecord;
  setNeedsInput(input: { jobId: string; question: Record<string, unknown>; nextAction: string }): AnalyticsJobRecord;
  recordResponse(input: { jobId: string; response: string }): AnalyticsJobRecord;
  recoverInterrupted(): number;
  activeWork(): Array<{ id: string; kind: 'analytics_job' | 'analytics_job_node'; disposition: 'startup_recovery' }>;
}
