import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { analyticsSha256, stableAnalyticsJson } from './analytics-data-room-policy.js';
import type {
  AnalyticsJobAttemptRecord,
  AnalyticsJobClaim,
  AnalyticsJobCompletionReceipt,
  AnalyticsJobEdgeRecord,
  AnalyticsJobIntent,
  AnalyticsJobNodeKind,
  AnalyticsJobNodeRecord,
  AnalyticsJobNodeState,
  AnalyticsJobObservation,
  AnalyticsJobPlannedEdgeInput,
  AnalyticsJobPlannedNodeInput,
  AnalyticsJobRecord,
  AnalyticsJobResultManifestV1,
  AnalyticsJobResultRecord,
  AnalyticsJobRetryClass,
  AnalyticsJobStatus,
  AnalyticsJobStore,
} from './analytics-job-types.js';

const JOB_ID_RE = /^aj_[a-f0-9]{32}$/;
const NODE_ID_RE = /^ajn_[a-f0-9]{32}$/;
const ATTEMPT_ID_RE = /^aja_[a-f0-9]{32}$/;
const RESULT_ID_RE = /^ar_[a-f0-9]{24}$/;
const SHA256_RE = /^[a-f0-9]{64}$/;
const NODE_LEASE_MS = 10 * 60_000;
const MAX_PLAN_NODES = 10_000;
const MAX_PLAN_EDGES = 50_000;

export type AnalyticsJobErrorCode =
  | 'invalid_input'
  | 'not_found'
  | 'conflict'
  | 'integrity_failed'
  | 'policy_denied'
  | 'unsupported'
  | 'cancelled';

export class AnalyticsJobError extends Error {
  readonly code: AnalyticsJobErrorCode;

  constructor(code: AnalyticsJobErrorCode, message: string) {
    super(message);
    this.name = 'AnalyticsJobError';
    this.code = code;
  }
}

interface JobRow {
  id: string;
  owner_id: string;
  owner_request_id: string;
  owner_message_sha256: string;
  intent_json: string;
  intent_sha256: string;
  status: AnalyticsJobStatus;
  state_revision: number;
  plan_revision: number;
  plan_sha256: string | null;
  question_count: number;
  question_receipt_json: string | null;
  question_receipt_sha256: string | null;
  result_id: string | null;
  completion_receipt_json: string | null;
  completion_receipt_sha256: string | null;
  error_code: string | null;
  error_message: string | null;
  next_action: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  cancel_requested_at: string | null;
}

interface NodeRow {
  id: string;
  job_id: string;
  plan_revision: number;
  kind: AnalyticsJobNodeKind;
  adapter_version: string;
  state: AnalyticsJobNodeState;
  state_revision: number;
  logical_request_sha256: string;
  spec_json: string;
  spec_sha256: string;
  input_identity_json: string | null;
  input_identity_sha256: string | null;
  input_contract_sha256: string | null;
  current_attempt_id: string | null;
  lease_owner: string | null;
  lease_expires_at: string | null;
  heartbeat_at: string | null;
  output_dataset_id: string | null;
  output_version_id: string | null;
  output_result_id: string | null;
  error_code: string | null;
  error_message: string | null;
  retry_class: AnalyticsJobRetryClass | null;
  next_action: string | null;
  created_at: string;
  updated_at: string;
  terminal_at: string | null;
}

interface EdgeRow {
  job_id: string;
  plan_revision: number;
  from_node_id: string;
  to_node_id: string;
  input_position: number;
  input_name: string;
  created_at: string;
}

interface AttemptRow {
  id: string;
  job_id: string;
  node_id: string;
  attempt_ordinal: number;
  status: AnalyticsJobAttemptRecord['status'];
  invocation_ref_json: string | null;
  invocation_ref_sha256: string | null;
  checkpoint_json: string | null;
  checkpoint_sha256: string | null;
  checkpointed_at: string | null;
  receipt_json: string | null;
  receipt_sha256: string | null;
  retry_class: AnalyticsJobRetryClass | null;
  error_code: string | null;
  error_message: string | null;
  next_action: string | null;
  started_at: string;
  completed_at: string | null;
}

interface ResultRow {
  id: string;
  job_id: string;
  final_plan_sha256: string;
  primary_version_id: string;
  manifest_json: string;
  manifest_sha256: string;
  visibility: AnalyticsJobResultRecord['visibility'];
  retention_json: string;
  retention_sha256: string;
  receipt_json: string;
  receipt_sha256: string;
  created_at: string;
}

function fail(code: AnalyticsJobErrorCode, message: string): never {
  throw new AnalyticsJobError(code, message);
}

function cleanText(value: unknown, field: string, maximum = 4000): string {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) {
    fail('invalid_input', `${field} is required.`);
  }
  const output = value.trim();
  if (output.length > maximum) fail('invalid_input', `${field} exceeds ${maximum} characters.`);
  return output;
}

function assertSha(value: unknown, field: string): string {
  if (typeof value !== 'string' || !SHA256_RE.test(value)) fail('invalid_input', `${field} is malformed.`);
  return value;
}

function canonical(value: unknown): { json: string; sha256: string } {
  const json = stableAnalyticsJson(value);
  return { json, sha256: analyticsSha256(value) };
}

function strictCanonical<T>(raw: string, expectedSha256: string, field: string): T {
  let value: T;
  try {
    value = JSON.parse(raw) as T;
  } catch {
    return fail('integrity_failed', `${field} contains malformed JSON.`);
  }
  let encoded: string;
  try {
    encoded = stableAnalyticsJson(value);
  } catch {
    return fail('integrity_failed', `${field} cannot be canonically encoded.`);
  }
  if (encoded !== raw || analyticsSha256(value) !== expectedSha256) {
    fail('integrity_failed', `${field} differs from its canonical SHA receipt.`);
  }
  return value;
}

function assertJobId(value: string): string {
  if (!JOB_ID_RE.test(value)) fail('invalid_input', 'Analytics job ID is malformed.');
  return value;
}

function assertNodeId(value: string): string {
  if (!NODE_ID_RE.test(value)) fail('invalid_input', 'Analytics job node ID is malformed.');
  return value;
}

function assertAttemptId(value: string): string {
  if (!ATTEMPT_ID_RE.test(value)) fail('invalid_input', 'Analytics job attempt ID is malformed.');
  return value;
}

function assertResultId(value: string): string {
  if (!RESULT_ID_RE.test(value)) fail('invalid_input', 'Analytics result ID is malformed.');
  return value;
}

function isTerminalJob(status: AnalyticsJobStatus): boolean {
  return status === 'complete' || status === 'cancelled' || status === 'failed';
}

function safeMessage(value: unknown, fallback: string): string {
  const output = value instanceof Error ? value.message : String(value ?? fallback);
  return output.trim().slice(0, 1000) || fallback;
}

export function createAnalyticsJobStore(input: {
  db: Database.Database;
  now?: () => Date;
  createId?: () => string;
  workerId?: string;
}): AnalyticsJobStore {
  const db = input.db;
  const now = input.now ?? (() => new Date());
  const createId = input.createId ?? (() => randomUUID().replace(/-/g, ''));
  const workerId = input.workerId ?? `analytics-job:${process.pid}:${createId().slice(0, 12)}`;

  function timestamp(): string {
    return now().toISOString();
  }

  function newId(prefix: 'aj' | 'aja'): string {
    const value = `${prefix}_${createId().slice(0, 32).toLowerCase()}`;
    if (prefix === 'aj' ? !JOB_ID_RE.test(value) : !ATTEMPT_ID_RE.test(value)) {
      fail('integrity_failed', `Generated ${prefix} identity is malformed.`);
    }
    return value;
  }

  function getJobRow(jobId: string): JobRow | null {
    return (db.prepare('SELECT * FROM analytics_jobs WHERE id = ?').get(assertJobId(jobId)) as JobRow | undefined) ?? null;
  }

  function getNodeRow(nodeId: string): NodeRow | null {
    return (db.prepare('SELECT * FROM analytics_job_nodes WHERE id = ?').get(assertNodeId(nodeId)) as NodeRow | undefined) ?? null;
  }

  function getAttemptRow(attemptId: string): AttemptRow | null {
    return (db.prepare('SELECT * FROM analytics_job_node_attempts WHERE id = ?')
      .get(assertAttemptId(attemptId)) as AttemptRow | undefined) ?? null;
  }

  function getResultRow(resultId: string): ResultRow | null {
    return (db.prepare('SELECT * FROM analytics_job_results WHERE id = ?')
      .get(assertResultId(resultId)) as ResultRow | undefined) ?? null;
  }

  function jobRecord(row: JobRow): AnalyticsJobRecord {
    const intent = strictCanonical<AnalyticsJobIntent>(row.intent_json, row.intent_sha256, `job ${row.id} intent`);
    const questionReceipt = row.question_receipt_json && row.question_receipt_sha256
      ? strictCanonical<Record<string, unknown>>(row.question_receipt_json, row.question_receipt_sha256, `job ${row.id} question`)
      : undefined;
    const completionReceipt = row.completion_receipt_json && row.completion_receipt_sha256
      ? strictCanonical<AnalyticsJobCompletionReceipt>(row.completion_receipt_json, row.completion_receipt_sha256, `job ${row.id} completion`)
      : undefined;
    return {
      id: row.id,
      ownerId: row.owner_id,
      ownerRequestId: row.owner_request_id,
      ownerMessageSha256: row.owner_message_sha256,
      intent,
      intentSha256: row.intent_sha256,
      status: row.status,
      stateRevision: Number(row.state_revision),
      planRevision: Number(row.plan_revision),
      ...(row.plan_sha256 ? { planSha256: row.plan_sha256 } : {}),
      questionCount: Number(row.question_count),
      ...(questionReceipt ? { questionReceipt } : {}),
      ...(row.result_id ? { resultId: row.result_id } : {}),
      ...(completionReceipt ? { completionReceipt } : {}),
      ...(row.error_code ? { errorCode: row.error_code } : {}),
      ...(row.error_message ? { errorMessage: row.error_message } : {}),
      ...(row.next_action ? { nextAction: row.next_action } : {}),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      ...(row.completed_at ? { completedAt: row.completed_at } : {}),
      ...(row.cancel_requested_at ? { cancelRequestedAt: row.cancel_requested_at } : {}),
    };
  }

  function nodeRecord(row: NodeRow): AnalyticsJobNodeRecord {
    const spec = strictCanonical<Record<string, unknown>>(row.spec_json, row.spec_sha256, `node ${row.id} spec`);
    const inputIdentity = row.input_identity_json && row.input_identity_sha256
      ? strictCanonical<Record<string, unknown>>(row.input_identity_json, row.input_identity_sha256, `node ${row.id} input identity`)
      : undefined;
    return {
      id: row.id,
      jobId: row.job_id,
      planRevision: Number(row.plan_revision),
      kind: row.kind,
      adapterVersion: row.adapter_version,
      state: row.state,
      stateRevision: Number(row.state_revision),
      logicalRequestSha256: row.logical_request_sha256,
      spec,
      ...(inputIdentity ? { inputIdentity } : {}),
      ...(row.input_contract_sha256 ? { inputContractSha256: row.input_contract_sha256 } : {}),
      ...(row.current_attempt_id ? { currentAttemptId: row.current_attempt_id } : {}),
      ...(row.lease_owner ? { leaseOwner: row.lease_owner } : {}),
      ...(row.lease_expires_at ? { leaseExpiresAt: row.lease_expires_at } : {}),
      ...(row.heartbeat_at ? { heartbeatAt: row.heartbeat_at } : {}),
      ...(row.output_dataset_id ? { outputDatasetId: row.output_dataset_id } : {}),
      ...(row.output_version_id ? { outputVersionId: row.output_version_id } : {}),
      ...(row.output_result_id ? { outputResultId: row.output_result_id } : {}),
      ...(row.error_code ? { errorCode: row.error_code } : {}),
      ...(row.error_message ? { errorMessage: row.error_message } : {}),
      ...(row.retry_class ? { retryClass: row.retry_class } : {}),
      ...(row.next_action ? { nextAction: row.next_action } : {}),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      ...(row.terminal_at ? { terminalAt: row.terminal_at } : {}),
    };
  }

  function attemptRecord(row: AttemptRow): AnalyticsJobAttemptRecord {
    const invocationRef = row.invocation_ref_json && row.invocation_ref_sha256
      ? strictCanonical<Record<string, unknown>>(row.invocation_ref_json, row.invocation_ref_sha256, `attempt ${row.id} invocation`)
      : undefined;
    const checkpoint = row.checkpoint_json && row.checkpoint_sha256
      ? strictCanonical<Record<string, unknown>>(row.checkpoint_json, row.checkpoint_sha256, `attempt ${row.id} checkpoint`)
      : undefined;
    const receipt = row.receipt_json && row.receipt_sha256
      ? strictCanonical<Record<string, unknown>>(row.receipt_json, row.receipt_sha256, `attempt ${row.id} receipt`)
      : undefined;
    return {
      id: row.id,
      jobId: row.job_id,
      nodeId: row.node_id,
      attemptOrdinal: Number(row.attempt_ordinal),
      status: row.status,
      ...(invocationRef ? { invocationRef } : {}),
      ...(checkpoint ? { checkpoint } : {}),
      ...(row.checkpointed_at ? { checkpointedAt: row.checkpointed_at } : {}),
      ...(receipt ? { receipt } : {}),
      ...(row.retry_class ? { retryClass: row.retry_class } : {}),
      ...(row.error_code ? { errorCode: row.error_code } : {}),
      ...(row.error_message ? { errorMessage: row.error_message } : {}),
      ...(row.next_action ? { nextAction: row.next_action } : {}),
      startedAt: row.started_at,
      ...(row.completed_at ? { completedAt: row.completed_at } : {}),
    };
  }

  function resultRecord(row: ResultRow): AnalyticsJobResultRecord {
    return {
      id: row.id,
      jobId: row.job_id,
      finalPlanSha256: row.final_plan_sha256,
      primaryVersionId: row.primary_version_id,
      manifest: strictCanonical<AnalyticsJobResultManifestV1>(row.manifest_json, row.manifest_sha256, `result ${row.id} manifest`),
      manifestSha256: row.manifest_sha256,
      visibility: row.visibility,
      retention: strictCanonical(row.retention_json, row.retention_sha256, `result ${row.id} retention`),
      receipt: strictCanonical(row.receipt_json, row.receipt_sha256, `result ${row.id} receipt`),
      receiptSha256: row.receipt_sha256,
      createdAt: row.created_at,
    };
  }

  function getJob(jobId: string): AnalyticsJobRecord | null {
    const row = getJobRow(jobId);
    return row ? jobRecord(row) : null;
  }

  function getNode(nodeId: string): AnalyticsJobNodeRecord | null {
    const row = getNodeRow(nodeId);
    return row ? nodeRecord(row) : null;
  }

  function getResult(resultId: string): AnalyticsJobResultRecord | null {
    const row = getResultRow(resultId);
    return row ? resultRecord(row) : null;
  }

  function createOrJoin(value: {
    ownerId: string;
    ownerRequestId: string;
    ownerMessageSha256: string;
    intent: AnalyticsJobIntent;
  }): { job: AnalyticsJobRecord; joinedExisting: boolean } {
    const ownerId = cleanText(value.ownerId, 'ownerId', 240);
    const ownerRequestId = cleanText(value.ownerRequestId, 'ownerRequestId', 128);
    if (ownerRequestId.length < 8) fail('invalid_input', 'ownerRequestId must contain at least 8 characters.');
    const ownerMessageSha256 = assertSha(value.ownerMessageSha256, 'ownerMessageSha256');
    const supportedIntent = value.intent
      && (value.intent.version === 1
        || (value.intent.version === 2 && value.intent.mode === 'dataset_preparation'));
    if (!supportedIntent || value.intent.ownerMessageSha256 !== ownerMessageSha256) {
      fail('invalid_input', 'Analytics job intent is malformed or differs from the owner message receipt.');
    }
    const intent = canonical(value.intent);
    const existing = db.prepare(`
      SELECT * FROM analytics_jobs WHERE owner_id = ? AND owner_request_id = ?
    `).get(ownerId, ownerRequestId) as JobRow | undefined;
    if (existing) {
      if (existing.owner_message_sha256 !== ownerMessageSha256
        || existing.intent_sha256 !== intent.sha256
        || existing.intent_json !== intent.json) {
        // Nothing was written: the caller may report the existing job as a
        // known no-effect outcome instead of an unknown effect.
        throw Object.assign(
          new AnalyticsJobError('conflict', 'Owner request ID is already bound to a different analytics job intent.'),
          { ownerRequestConflict: true, existingJobId: existing.id },
        );
      }
      return { job: jobRecord(existing), joinedExisting: true };
    }
    const id = newId('aj');
    const at = timestamp();
    try {
      db.prepare(`
        INSERT INTO analytics_jobs
          (id, owner_id, owner_request_id, owner_message_sha256, intent_json,
           intent_sha256, status, state_revision, plan_revision, question_count,
           created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 'planning', 1, 0, 0, ?, ?)
      `).run(id, ownerId, ownerRequestId, ownerMessageSha256, intent.json, intent.sha256, at, at);
    } catch (error) {
      const raced = db.prepare(`
        SELECT * FROM analytics_jobs WHERE owner_id = ? AND owner_request_id = ?
      `).get(ownerId, ownerRequestId) as JobRow | undefined;
      if (!raced || raced.owner_message_sha256 !== ownerMessageSha256
        || raced.intent_sha256 !== intent.sha256 || raced.intent_json !== intent.json) throw error;
      return { job: jobRecord(raced), joinedExisting: true };
    }
    return { job: getJob(id)!, joinedExisting: false };
  }

  function validatePlan(
    job: JobRow,
    nodes: AnalyticsJobPlannedNodeInput[],
    edges: AnalyticsJobPlannedEdgeInput[],
  ): {
    planRevision: number;
    planSha256: string;
    nodes: Array<AnalyticsJobPlannedNodeInput & { id: string; logicalRequestSha256: string; specJson: string; specSha256: string; inputJson: string | null; inputSha256: string | null }>;
    edges: Array<AnalyticsJobPlannedEdgeInput & { fromNodeId: string; toNodeId: string }>;
  } {
    if (!Array.isArray(nodes) || nodes.length === 0 || nodes.length > MAX_PLAN_NODES) {
      fail('invalid_input', `Analytics plan must contain 1 to ${MAX_PLAN_NODES} nodes.`);
    }
    if (!Array.isArray(edges) || edges.length > MAX_PLAN_EDGES) {
      fail('invalid_input', `Analytics plan may contain at most ${MAX_PLAN_EDGES} edges.`);
    }
    const planRevision = job.plan_revision + 1;
    const byKey = new Map<string, AnalyticsJobPlannedNodeInput>();
    for (const node of nodes) {
      const key = cleanText(node.key, 'node.key', 240);
      if (byKey.has(key)) fail('invalid_input', `Analytics plan repeats node key ${key}.`);
      if (!['source_resolution', 'transform_fragment', 'result_publication', 'answer_delivery', 'retain_delivery'].includes(node.kind)) {
        fail('invalid_input', `Analytics node ${key} has an unsupported kind.`);
      }
      cleanText(node.adapterVersion, `node ${key} adapterVersion`, 128);
      byKey.set(key, node);
    }
    const preparedNodes = [...byKey.entries()].map(([key, node]) => {
      const spec = canonical({ ...node.spec, nodeKey: key });
      const inputIdentity = node.inputIdentity ? canonical(node.inputIdentity) : null;
      if (node.inputContractSha256) assertSha(node.inputContractSha256, `node ${key} inputContractSha256`);
      const logicalRequestSha256 = analyticsSha256({
        key,
        kind: node.kind,
        adapterVersion: node.adapterVersion,
        specSha256: spec.sha256,
        inputIdentitySha256: inputIdentity?.sha256 ?? null,
        inputContractSha256: node.inputContractSha256 ?? null,
      });
      return {
        ...node,
        key,
        id: `ajn_${analyticsSha256({ jobId: job.id, planRevision, logicalRequestSha256 }).slice(0, 32)}`,
        logicalRequestSha256,
        specJson: spec.json,
        specSha256: spec.sha256,
        inputJson: inputIdentity?.json ?? null,
        inputSha256: inputIdentity?.sha256 ?? null,
      };
    }).sort((left, right) => left.key.localeCompare(right.key));
    const idByKey = new Map(preparedNodes.map(node => [node.key, node.id]));
    const normalizedEdges = edges.map(edge => {
      const fromKey = cleanText(edge.fromKey, 'edge.fromKey', 240);
      const toKey = cleanText(edge.toKey, 'edge.toKey', 240);
      const fromNodeId = idByKey.get(fromKey);
      const toNodeId = idByKey.get(toKey);
      if (!fromNodeId || !toNodeId || fromNodeId === toNodeId) fail('invalid_input', 'Analytics plan edge references an invalid node.');
      if (!Number.isInteger(edge.inputPosition) || edge.inputPosition < 0) fail('invalid_input', 'Analytics plan edge position is invalid.');
      return {
        fromKey,
        toKey,
        fromNodeId,
        toNodeId,
        inputPosition: edge.inputPosition,
        inputName: cleanText(edge.inputName, 'edge.inputName', 160),
      };
    }).sort((left, right) => left.toKey.localeCompare(right.toKey)
      || left.inputPosition - right.inputPosition || left.fromKey.localeCompare(right.fromKey));
    const edgeKeys = new Set<string>();
    const positions = new Set<string>();
    const graph = new Map<string, string[]>();
    for (const edge of normalizedEdges) {
      const identity = `${edge.fromKey}\0${edge.toKey}`;
      const position = `${edge.toKey}\0${edge.inputPosition}`;
      if (edgeKeys.has(identity) || positions.has(position)) fail('invalid_input', 'Analytics plan repeats an edge or input position.');
      edgeKeys.add(identity);
      positions.add(position);
      graph.set(edge.fromKey, [...(graph.get(edge.fromKey) ?? []), edge.toKey]);
    }
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const visit = (key: string): void => {
      if (visiting.has(key)) fail('invalid_input', `Analytics plan contains a cycle at ${key}.`);
      if (visited.has(key)) return;
      visiting.add(key);
      for (const next of graph.get(key) ?? []) visit(next);
      visiting.delete(key);
      visited.add(key);
    };
    for (const key of byKey.keys()) visit(key);
    const planSha256 = analyticsSha256({
      version: 1,
      nodes: preparedNodes.map(node => ({
        id: node.id,
        key: node.key,
        kind: node.kind,
        adapterVersion: node.adapterVersion,
        logicalRequestSha256: node.logicalRequestSha256,
        specSha256: node.specSha256,
        inputIdentitySha256: node.inputSha256,
        inputContractSha256: node.inputContractSha256 ?? null,
      })),
      edges: normalizedEdges.map(edge => ({
        fromNodeId: edge.fromNodeId,
        toNodeId: edge.toNodeId,
        inputPosition: edge.inputPosition,
        inputName: edge.inputName,
      })),
    });
    return { planRevision, planSha256, nodes: preparedNodes, edges: normalizedEdges };
  }

  function commitPlan(value: {
    jobId: string;
    expectedStateRevision: number;
    nodes: AnalyticsJobPlannedNodeInput[];
    edges: AnalyticsJobPlannedEdgeInput[];
  }): AnalyticsJobRecord {
    const job = getJobRow(value.jobId);
    if (!job) fail('not_found', `Analytics job ${value.jobId} was not found.`);
    if (isTerminalJob(job.status) || job.status === 'cancel_requested') fail('conflict', 'Terminal or cancelling analytics job cannot accept a plan.');
    if (job.state_revision !== value.expectedStateRevision) fail('conflict', 'Analytics job changed before plan commit.');
    const plan = validatePlan(job, value.nodes, value.edges);
    const existingPlan = job.plan_revision > 0 ? job.plan_sha256 : null;
    if (existingPlan === plan.planSha256) return jobRecord(job);
    const incoming = new Set(plan.edges.map(edge => edge.toNodeId));
    const at = timestamp();
    db.transaction(() => {
      const current = getJobRow(job.id);
      if (!current || current.state_revision !== value.expectedStateRevision || current.plan_revision !== job.plan_revision) {
        fail('conflict', 'Analytics job changed during plan commit.');
      }
      const nodeInsert = db.prepare(`
        INSERT INTO analytics_job_nodes
          (id, job_id, plan_revision, kind, adapter_version, state, state_revision,
           logical_request_sha256, spec_json, spec_sha256, input_identity_json,
           input_identity_sha256, input_contract_sha256, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const node of plan.nodes) {
        nodeInsert.run(
          node.id, job.id, plan.planRevision, node.kind, node.adapterVersion,
          incoming.has(node.id) ? 'planned' : 'ready', node.logicalRequestSha256,
          node.specJson, node.specSha256, node.inputJson, node.inputSha256,
          node.inputContractSha256 ?? null, at, at,
        );
      }
      const edgeInsert = db.prepare(`
        INSERT INTO analytics_job_edges
          (job_id, plan_revision, from_node_id, to_node_id, input_position, input_name, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      for (const edge of plan.edges) {
        edgeInsert.run(job.id, plan.planRevision, edge.fromNodeId, edge.toNodeId, edge.inputPosition, edge.inputName, at);
      }
      const changed = db.prepare(`
        UPDATE analytics_jobs
        SET status='running', state_revision=state_revision+1, plan_revision=?, plan_sha256=?,
            question_receipt_json=NULL, question_receipt_sha256=NULL,
            error_code=NULL, error_message=NULL, next_action=NULL, updated_at=?
        WHERE id=? AND state_revision=? AND plan_revision=?
      `).run(plan.planRevision, plan.planSha256, at, job.id, value.expectedStateRevision, job.plan_revision);
      if (changed.changes !== 1) fail('conflict', 'Analytics job changed during plan commit.');
    })();
    return getJob(job.id)!;
  }

  function edgeRecord(row: EdgeRow): AnalyticsJobEdgeRecord {
    return {
      jobId: row.job_id,
      planRevision: Number(row.plan_revision),
      fromNodeId: row.from_node_id,
      toNodeId: row.to_node_id,
      inputPosition: Number(row.input_position),
      inputName: row.input_name,
      createdAt: row.created_at,
    };
  }

  function observe(jobId: string): AnalyticsJobObservation {
    const job = getJob(assertJobId(jobId));
    if (!job) fail('not_found', `Analytics job ${jobId} was not found.`);
    const nodes = (db.prepare(`
      SELECT * FROM analytics_job_nodes WHERE job_id=? ORDER BY plan_revision, created_at, id
    `).all(job.id) as NodeRow[]).map(nodeRecord);
    const edges = (db.prepare(`
      SELECT * FROM analytics_job_edges WHERE job_id=? ORDER BY plan_revision, to_node_id, input_position, from_node_id
    `).all(job.id) as EdgeRow[]).map(edgeRecord);
    const attempts = (db.prepare(`
      SELECT * FROM analytics_job_node_attempts WHERE job_id=? ORDER BY started_at, id
    `).all(job.id) as AttemptRow[]).map(attemptRecord);
    return { job, nodes, edges, attempts, ...(job.resultId ? { result: getResult(job.resultId) ?? undefined } : {}) };
  }

  function claimNextReady(): AnalyticsJobClaim | null {
    let claimed: AnalyticsJobClaim | null = null;
    db.transaction(() => {
      const row = db.prepare(`
        SELECT node.* FROM analytics_job_nodes node
        JOIN analytics_jobs job ON job.id=node.job_id AND job.plan_revision=node.plan_revision
        WHERE node.state='ready' AND job.status IN ('running','delivering')
        ORDER BY job.updated_at, node.updated_at, node.id LIMIT 1
      `).get() as NodeRow | undefined;
      if (!row) return;
      const ordinal = Number((db.prepare(`
        SELECT COALESCE(MAX(attempt_ordinal), 0) + 1 AS ordinal
        FROM analytics_job_node_attempts WHERE node_id=?
      `).get(row.id) as { ordinal: number }).ordinal);
      const attemptId = newId('aja');
      const at = timestamp();
      const leaseExpiresAt = new Date(now().getTime() + NODE_LEASE_MS).toISOString();
      db.prepare(`
        INSERT INTO analytics_job_node_attempts
          (id, job_id, node_id, attempt_ordinal, status, started_at)
        VALUES (?, ?, ?, ?, 'running', ?)
      `).run(attemptId, row.job_id, row.id, ordinal, at);
      const changed = db.prepare(`
        UPDATE analytics_job_nodes
        SET state='running', state_revision=state_revision+1, current_attempt_id=?,
            lease_owner=?, lease_expires_at=?, heartbeat_at=?, updated_at=?
        WHERE id=? AND state='ready' AND state_revision=?
      `).run(attemptId, workerId, leaseExpiresAt, at, at, row.id, row.state_revision);
      if (changed.changes !== 1) fail('conflict', 'Analytics node changed during claim.');
      db.prepare(`UPDATE analytics_jobs SET state_revision=state_revision+1, updated_at=? WHERE id=?`)
        .run(at, row.job_id);
      claimed = {
        job: getJob(row.job_id)!,
        node: getNode(row.id)!,
        attempt: attemptRecord(getAttemptRow(attemptId)!),
      };
    })();
    return claimed;
  }

  function checkpoint(value: { attemptId: string; checkpoint: Record<string, unknown> }): AnalyticsJobAttemptRecord {
    const attempt = getAttemptRow(value.attemptId);
    if (!attempt) fail('not_found', `Analytics attempt ${value.attemptId} was not found.`);
    if (attempt.status !== 'running' && attempt.status !== 'waiting_external') fail('conflict', 'Terminal analytics attempt cannot be checkpointed.');
    const encoded = canonical(value.checkpoint);
    const at = timestamp();
    const changed = db.prepare(`
      UPDATE analytics_job_node_attempts
      SET checkpoint_json=?, checkpoint_sha256=?, checkpointed_at=?
      WHERE id=? AND status IN ('running','waiting_external')
    `).run(encoded.json, encoded.sha256, at, attempt.id);
    if (changed.changes !== 1) fail('conflict', 'Analytics attempt changed during checkpoint.');
    db.prepare(`
      UPDATE analytics_job_nodes SET heartbeat_at=?, lease_expires_at=?, updated_at=?
      WHERE id=? AND current_attempt_id=? AND state='running'
    `).run(at, new Date(now().getTime() + NODE_LEASE_MS).toISOString(), at, attempt.node_id, attempt.id);
    return attemptRecord(getAttemptRow(attempt.id)!);
  }

  function releaseDependents(jobId: string, planRevision: number, at: string): void {
    db.prepare(`
      UPDATE analytics_job_nodes AS candidate
      SET state='ready', state_revision=state_revision+1, updated_at=?
      WHERE candidate.job_id=? AND candidate.plan_revision=? AND candidate.state='planned'
        AND EXISTS (
          SELECT 1 FROM analytics_job_edges edge
          WHERE edge.job_id=candidate.job_id AND edge.plan_revision=candidate.plan_revision
            AND edge.to_node_id=candidate.id
        )
        AND NOT EXISTS (
          SELECT 1 FROM analytics_job_edges edge
          JOIN analytics_job_nodes predecessor ON predecessor.id=edge.from_node_id
          WHERE edge.job_id=candidate.job_id AND edge.plan_revision=candidate.plan_revision
            AND edge.to_node_id=candidate.id AND predecessor.state<>'succeeded'
        )
    `).run(at, jobId, planRevision);
  }

  function requeueNode(value: {
    nodeId: string;
    attemptId: string;
    checkpoint?: Record<string, unknown>;
    nextAction: string;
  }): AnalyticsJobNodeRecord {
    const node = getNodeRow(value.nodeId);
    const attempt = getAttemptRow(value.attemptId);
    if (!node || !attempt || attempt.node_id !== node.id || attempt.job_id !== node.job_id
      || node.state !== 'running' || node.current_attempt_id !== attempt.id || attempt.status !== 'running') {
      fail('conflict', 'Analytics node attempt is not active for requeue.');
    }
    const checkpoint = value.checkpoint ? canonical(value.checkpoint) : null;
    const nextAction = cleanText(value.nextAction, 'next action', 1000);
    const at = timestamp();
    db.transaction(() => {
      const attemptChanged = db.prepare(`
        UPDATE analytics_job_node_attempts
        SET status='interrupted', checkpoint_json=?, checkpoint_sha256=?, checkpointed_at=?,
            retry_class='transient', next_action=?, completed_at=?
        WHERE id=? AND status='running'
      `).run(checkpoint?.json ?? null, checkpoint?.sha256 ?? null, checkpoint ? at : null, nextAction, at, attempt.id);
      if (attemptChanged.changes !== 1) fail('conflict', 'Analytics attempt changed before requeue.');
      const nodeChanged = db.prepare(`
        UPDATE analytics_job_nodes
        SET state='ready', state_revision=state_revision+1, current_attempt_id=NULL,
            lease_owner=NULL, lease_expires_at=NULL, heartbeat_at=?, retry_class='transient',
            next_action=?, updated_at=?
        WHERE id=? AND state='running' AND current_attempt_id=?
      `).run(at, nextAction, at, node.id, attempt.id);
      if (nodeChanged.changes !== 1) fail('conflict', 'Analytics node changed before requeue.');
      db.prepare(`UPDATE analytics_jobs SET state_revision=state_revision+1, updated_at=? WHERE id=?`)
        .run(at, node.job_id);
    })();
    return getNode(node.id)!;
  }

  function waitNode(value: {
    nodeId: string;
    attemptId: string;
    state: 'waiting_external' | 'needs_approval';
    checkpoint: Record<string, unknown>;
    nextAction: string;
  }): AnalyticsJobNodeRecord {
    const node = getNodeRow(value.nodeId);
    const attempt = getAttemptRow(value.attemptId);
    if (!node || !attempt || attempt.node_id !== node.id || attempt.job_id !== node.job_id
      || node.state !== 'running' || node.current_attempt_id !== attempt.id || attempt.status !== 'running') {
      fail('conflict', 'Analytics node attempt is not active for waiting.');
    }
    const checkpoint = canonical(value.checkpoint);
    const nextAction = cleanText(value.nextAction, 'next action', 1000);
    const retryClass: AnalyticsJobRetryClass = value.state === 'needs_approval' ? 'owner_action' : 'transient';
    const at = timestamp();
    db.transaction(() => {
      const attemptChanged = db.prepare(`
        UPDATE analytics_job_node_attempts
        SET status='waiting_external', checkpoint_json=?, checkpoint_sha256=?, checkpointed_at=?,
            retry_class=?, next_action=?
        WHERE id=? AND status='running'
      `).run(checkpoint.json, checkpoint.sha256, at, retryClass, nextAction, attempt.id);
      if (attemptChanged.changes !== 1) fail('conflict', 'Analytics attempt changed before waiting state.');
      const nodeChanged = db.prepare(`
        UPDATE analytics_job_nodes
        SET state=?, state_revision=state_revision+1, lease_owner=NULL,
            lease_expires_at=NULL, heartbeat_at=?, retry_class=?,
            next_action=?, updated_at=?
        WHERE id=? AND state='running' AND current_attempt_id=?
      `).run(value.state, at, retryClass, nextAction, at, node.id, attempt.id);
      if (nodeChanged.changes !== 1) fail('conflict', 'Analytics node changed before waiting state.');
      const jobChanged = db.prepare(`
        UPDATE analytics_jobs
        SET status=?, state_revision=state_revision+1, next_action=?, updated_at=?
        WHERE id=? AND status IN ('running','delivering')
      `).run(value.state, nextAction, at, node.job_id);
      if (jobChanged.changes !== 1) fail('conflict', 'Analytics job changed before waiting state.');
    })();
    return getNode(node.id)!;
  }

  function resumeWaitingNode(value: { nodeId: string; nextAction: string }): AnalyticsJobNodeRecord {
    const node = getNodeRow(value.nodeId);
    if (!node || (node.state !== 'waiting_external' && node.state !== 'needs_approval') || !node.current_attempt_id) {
      fail('conflict', 'Analytics node is not waiting for an external continuation.');
    }
    const attempt = getAttemptRow(node.current_attempt_id);
    if (!attempt || attempt.node_id !== node.id || attempt.status !== 'waiting_external') {
      fail('conflict', 'Analytics waiting attempt is missing or terminal.');
    }
    const nextAction = cleanText(value.nextAction, 'next action', 1000);
    const at = timestamp();
    db.transaction(() => {
      const attemptChanged = db.prepare(`
        UPDATE analytics_job_node_attempts
        SET status='interrupted', retry_class='transient', next_action=?, completed_at=?
        WHERE id=? AND status='waiting_external'
      `).run(nextAction, at, attempt.id);
      if (attemptChanged.changes !== 1) fail('conflict', 'Analytics waiting attempt changed before resume.');
      const nodeChanged = db.prepare(`
        UPDATE analytics_job_nodes
        SET state='ready', state_revision=state_revision+1, current_attempt_id=NULL,
            lease_owner=NULL, lease_expires_at=NULL, heartbeat_at=?, retry_class='transient',
            next_action=?, updated_at=?
        WHERE id=? AND state IN ('waiting_external','needs_approval') AND current_attempt_id=?
      `).run(at, nextAction, at, node.id, attempt.id);
      if (nodeChanged.changes !== 1) fail('conflict', 'Analytics waiting node changed before resume.');
      db.prepare(`
        UPDATE analytics_jobs
        SET status='running', state_revision=state_revision+1, error_code=NULL,
            error_message=NULL, next_action=?, updated_at=?
        WHERE id=? AND status IN ('waiting_external','needs_approval')
      `).run(nextAction, at, node.job_id);
    })();
    return getNode(node.id)!;
  }

  function succeedNode(value: {
    nodeId: string;
    attemptId: string;
    receipt: Record<string, unknown>;
    outputDatasetId?: string;
    outputVersionId?: string;
    outputResultId?: string;
  }): AnalyticsJobNodeRecord {
    const node = getNodeRow(value.nodeId);
    const attempt = getAttemptRow(value.attemptId);
    if (!node || !attempt || attempt.node_id !== node.id || attempt.job_id !== node.job_id) {
      fail('not_found', 'Analytics node attempt was not found.');
    }
    if (node.state !== 'running' || node.current_attempt_id !== attempt.id || attempt.status !== 'running') {
      fail('conflict', 'Analytics node attempt is not active.');
    }
    if (value.outputVersionId) {
      const version = db.prepare('SELECT dataset_id FROM analytics_dataset_versions WHERE id=?')
        .get(value.outputVersionId) as { dataset_id: string } | undefined;
      if (!version || (value.outputDatasetId && version.dataset_id !== value.outputDatasetId)) {
        fail('integrity_failed', 'Analytics node output version does not match its dataset.');
      }
    }
    if (value.outputResultId) {
      const result = getResultRow(value.outputResultId);
      if (!result || result.job_id !== node.job_id) fail('integrity_failed', 'Analytics node output result differs from its job.');
    }
    const receipt = canonical(value.receipt);
    const at = timestamp();
    db.transaction(() => {
      const attemptChanged = db.prepare(`
        UPDATE analytics_job_node_attempts
        SET status='succeeded', receipt_json=?, receipt_sha256=?, retry_class='none', completed_at=?
        WHERE id=? AND status='running'
      `).run(receipt.json, receipt.sha256, at, attempt.id);
      if (attemptChanged.changes !== 1) fail('conflict', 'Analytics attempt changed before success.');
      const nodeChanged = db.prepare(`
        UPDATE analytics_job_nodes
        SET state='succeeded', state_revision=state_revision+1, current_attempt_id=NULL,
            lease_owner=NULL, lease_expires_at=NULL, heartbeat_at=?, output_dataset_id=?,
            output_version_id=?, output_result_id=?, error_code=NULL, error_message=NULL,
            retry_class='none', next_action=NULL, updated_at=?, terminal_at=?
        WHERE id=? AND state='running' AND current_attempt_id=?
      `).run(
        at, value.outputDatasetId ?? null, value.outputVersionId ?? null,
        value.outputResultId ?? null, at, at, node.id, attempt.id,
      );
      if (nodeChanged.changes !== 1) fail('conflict', 'Analytics node changed before success.');
      releaseDependents(node.job_id, node.plan_revision, at);
      db.prepare(`UPDATE analytics_jobs SET state_revision=state_revision+1, updated_at=? WHERE id=?`)
        .run(at, node.job_id);
    })();
    return getNode(node.id)!;
  }

  function blockPlanning(value: {
    jobId: string;
    terminal?: 'blocked' | 'failed';
    code: string;
    message: string;
    nextAction: string;
  }): AnalyticsJobRecord {
    const job = getJobRow(value.jobId);
    if (!job) fail('not_found', `Analytics job ${value.jobId} was not found.`);
    if (isTerminalJob(job.status)) return jobRecord(job);
    const status = value.terminal ?? 'blocked';
    const code = cleanText(value.code, 'error code', 160);
    const message = safeMessage(value.message, 'Analytics job planning failed.');
    const nextAction = cleanText(value.nextAction, 'next action', 1000);
    const at = timestamp();
    const changed = db.prepare(`
      UPDATE analytics_jobs
      SET status=?, state_revision=state_revision+1, error_code=?, error_message=?,
          next_action=?, updated_at=?, completed_at=CASE WHEN ?='failed' THEN ? ELSE completed_at END
      WHERE id=? AND status NOT IN ('complete','cancelled','failed')
    `).run(status, code, message, nextAction, at, status, at, job.id);
    if (changed.changes !== 1) fail('conflict', 'Analytics job changed before planning failure was recorded.');
    return getJob(job.id)!;
  }

  function blockNode(value: {
    nodeId: string;
    attemptId?: string;
    terminal?: 'blocked' | 'failed';
    code: string;
    message: string;
    retryClass: AnalyticsJobRetryClass;
    nextAction: string;
  }): AnalyticsJobNodeRecord {
    const node = getNodeRow(value.nodeId);
    if (!node) fail('not_found', `Analytics node ${value.nodeId} was not found.`);
    const state = value.terminal ?? 'blocked';
    const message = safeMessage(value.message, 'Analytics node failed.');
    const code = cleanText(value.code, 'error code', 160);
    const nextAction = cleanText(value.nextAction, 'next action', 1000);
    const at = timestamp();
    db.transaction(() => {
      if (value.attemptId) {
        const attempt = getAttemptRow(value.attemptId);
        if (!attempt || attempt.node_id !== node.id || attempt.status !== 'running') {
          fail('conflict', 'Analytics node attempt changed before failure.');
        }
        db.prepare(`
          UPDATE analytics_job_node_attempts
          SET status='failed', retry_class=?, error_code=?, error_message=?, next_action=?, completed_at=?
          WHERE id=? AND status='running'
        `).run(value.retryClass, code, message, nextAction, at, attempt.id);
      }
      const changed = db.prepare(`
        UPDATE analytics_job_nodes
        SET state=?, state_revision=state_revision+1, current_attempt_id=NULL,
            lease_owner=NULL, lease_expires_at=NULL, heartbeat_at=?, error_code=?,
            error_message=?, retry_class=?, next_action=?, updated_at=?, terminal_at=?
        WHERE id=? AND state NOT IN ('succeeded','cancelled')
      `).run(state, at, code, message, value.retryClass, nextAction, at, at, node.id);
      if (changed.changes !== 1) fail('conflict', 'Analytics node changed before failure.');
      db.prepare(`
        UPDATE analytics_jobs
        SET status=?, state_revision=state_revision+1, error_code=?, error_message=?,
            next_action=?, updated_at=?, completed_at=CASE WHEN ?='failed' THEN ? ELSE completed_at END
        WHERE id=? AND status NOT IN ('complete','cancelled','failed')
      `).run(state, code, message, nextAction, at, state, at, node.job_id);
    })();
    return getNode(node.id)!;
  }

  function insertResult(value: Parameters<AnalyticsJobStore['insertResult']>[0]): AnalyticsJobResultRecord {
    const job = getJobRow(value.jobId);
    if (!job || !job.plan_sha256 || job.plan_sha256 !== value.finalPlanSha256) {
      fail('conflict', 'Analytics result plan differs from the current job plan.');
    }
    if (value.primaryVersion.id !== value.manifest.primary.versionId
      || value.primaryVersion.datasetId !== value.manifest.primary.datasetId
      || value.primaryVersion.materializedSha256 !== value.manifest.primary.materializedSha256
      || value.primaryVersion.observedSchemaSha256 !== value.manifest.primary.observedSchemaSha256
      || value.primaryVersion.contractSha256 !== value.manifest.primary.contractSha256
      || value.primaryVersion.definitionSha256 !== value.manifest.primary.definitionSha256
      || value.primaryVersion.rowCount !== value.manifest.primary.rowCount
      || value.manifest.jobId !== job.id
      || value.manifest.finalPlanSha256 !== job.plan_sha256) {
      fail('integrity_failed', 'Analytics result manifest differs from the verified primary version.');
    }
    const manifest = canonical(value.manifest);
    const retention = canonical(value.retention);
    const receipt = canonical(value.receipt);
    const id = `ar_${analyticsSha256({ jobId: job.id, finalPlanSha256: job.plan_sha256, manifestSha256: manifest.sha256 }).slice(0, 24)}`;
    const existing = db.prepare(`
      SELECT * FROM analytics_job_results WHERE job_id=? AND final_plan_sha256=?
    `).get(job.id, job.plan_sha256) as ResultRow | undefined;
    if (existing) {
      const visibilityCompatible = existing.visibility === value.visibility
        || (existing.visibility === 'catalog' && value.visibility === 'job_scoped');
      if (existing.id !== id || existing.manifest_json !== manifest.json
        || existing.manifest_sha256 !== manifest.sha256 || !visibilityCompatible
        || existing.retention_json !== retention.json || existing.receipt_json !== receipt.json) {
        fail('conflict', 'Analytics job result already exists with different immutable content.');
      }
      return resultRecord(existing);
    }
    const at = timestamp();
    db.prepare(`
      INSERT INTO analytics_job_results
        (id, job_id, final_plan_sha256, primary_version_id, manifest_json,
         manifest_sha256, visibility, retention_json, retention_sha256,
         receipt_json, receipt_sha256, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, job.id, job.plan_sha256, value.primaryVersion.id, manifest.json,
      manifest.sha256, value.visibility, retention.json, retention.sha256,
      receipt.json, receipt.sha256, at,
    );
    return getResult(id)!;
  }

  function setResultVisibility(
    resultId: string,
    expected: AnalyticsJobResultRecord['visibility'],
    next: AnalyticsJobResultRecord['visibility'],
  ): AnalyticsJobResultRecord {
    const result = getResultRow(resultId);
    if (!result) fail('not_found', `Analytics result ${resultId} was not found.`);
    if (result.visibility === next) return resultRecord(result);
    if (result.visibility !== expected || expected !== 'job_scoped' || next !== 'catalog') {
      fail('policy_denied', `Analytics result visibility cannot move from ${result.visibility} to ${next}.`);
    }
    const changed = db.prepare(`
      UPDATE analytics_job_results SET visibility='catalog'
      WHERE id=? AND visibility='job_scoped'
    `).run(result.id);
    if (changed.changes !== 1) fail('conflict', 'Analytics result visibility changed during promotion.');
    return getResult(result.id)!;
  }

  function completeJob(value: {
    jobId: string;
    expectedStateRevision: number;
    resultId: string;
    receipt: AnalyticsJobCompletionReceipt;
  }): AnalyticsJobRecord {
    const job = getJobRow(value.jobId);
    const result = getResultRow(value.resultId);
    if (!job || !result || result.job_id !== job.id) fail('not_found', 'Analytics job result was not found.');
    if (job.state_revision !== value.expectedStateRevision) fail('conflict', 'Analytics job changed before completion.');
    const incomplete = db.prepare(`
      SELECT id FROM analytics_job_nodes
      WHERE job_id=? AND plan_revision=? AND state<>'succeeded' LIMIT 1
    `).get(job.id, job.plan_revision);
    if (incomplete) fail('conflict', 'Analytics job cannot complete while a current-plan node is incomplete.');
    const { receiptSha256: _provided, ...payload } = value.receipt;
    const receiptSha256 = analyticsSha256(payload);
    const receipt = canonical({ ...payload, receiptSha256 });
    const at = timestamp();
    const changed = db.prepare(`
      UPDATE analytics_jobs
      SET status='complete', state_revision=state_revision+1, result_id=?,
          completion_receipt_json=?, completion_receipt_sha256=?, error_code=NULL,
          error_message=NULL, next_action=NULL, updated_at=?, completed_at=?
      WHERE id=? AND state_revision=? AND status IN ('running','delivering')
    `).run(result.id, receipt.json, receipt.sha256, at, at, job.id, value.expectedStateRevision);
    if (changed.changes !== 1) fail('conflict', 'Analytics job changed before completion.');
    return getJob(job.id)!;
  }

  function requestCancel(jobId: string): AnalyticsJobRecord {
    const job = getJobRow(jobId);
    if (!job) fail('not_found', `Analytics job ${jobId} was not found.`);
    if (job.status === 'cancelled' || job.status === 'complete' || job.status === 'failed') return jobRecord(job);
    const at = timestamp();
    db.transaction(() => {
      db.prepare(`
        UPDATE analytics_jobs
        SET status='cancel_requested', state_revision=state_revision+1,
            cancel_requested_at=?, updated_at=?, next_action=?
        WHERE id=? AND status NOT IN ('complete','cancelled','failed')
      `).run(at, at, 'Wait for active local work to stop; immutable completed work is retained.', job.id);
      db.prepare(`
        UPDATE analytics_job_nodes
        SET state='cancelled', state_revision=state_revision+1, retry_class='none',
            error_code='cancelled', error_message='Cancelled before execution.',
            next_action='Start a new owner-requested analytics job if this result is still needed.',
            updated_at=?, terminal_at=?
        WHERE job_id=? AND plan_revision=? AND state IN ('planned','ready','needs_input','needs_approval')
      `).run(at, at, job.id, job.plan_revision);
    })();
    const active = db.prepare(`
      SELECT 1 FROM analytics_job_nodes WHERE job_id=? AND plan_revision=? AND state='running' LIMIT 1
    `).get(job.id, job.plan_revision);
    return active ? getJob(job.id)! : finishCancelled(job.id);
  }

  function finishCancelled(jobId: string): AnalyticsJobRecord {
    const job = getJobRow(jobId);
    if (!job) fail('not_found', `Analytics job ${jobId} was not found.`);
    if (job.status === 'cancelled') return jobRecord(job);
    if (job.status !== 'cancel_requested') fail('conflict', 'Analytics job has no cancellation request.');
    const at = timestamp();
    db.transaction(() => {
      db.prepare(`
        UPDATE analytics_job_node_attempts
        SET status='cancelled', retry_class='none', error_code='cancelled',
            error_message='Cancelled by the owner.', next_action='Start a new analytics job if needed.', completed_at=?
        WHERE job_id=? AND status IN ('running','waiting_external')
      `).run(at, job.id);
      db.prepare(`
        UPDATE analytics_job_nodes
        SET state='cancelled', state_revision=state_revision+1, current_attempt_id=NULL,
            lease_owner=NULL, lease_expires_at=NULL, heartbeat_at=?, retry_class='none',
            error_code='cancelled', error_message='Cancelled by the owner.',
            next_action='Start a new analytics job if needed.', updated_at=?, terminal_at=?
        WHERE job_id=? AND plan_revision=? AND state<>'succeeded'
      `).run(at, at, at, job.id, job.plan_revision);
      db.prepare(`
        UPDATE analytics_jobs
        SET status='cancelled', state_revision=state_revision+1, updated_at=?, completed_at=?,
            error_code='cancelled', error_message='Cancelled by the owner.',
            next_action='Start a new analytics job if needed.'
        WHERE id=? AND status='cancel_requested'
      `).run(at, at, job.id);
    })();
    return getJob(job.id)!;
  }

  function resumeBlocked(jobId: string): AnalyticsJobRecord {
    const job = getJobRow(jobId);
    if (!job) fail('not_found', `Analytics job ${jobId} was not found.`);
    if (job.status !== 'blocked') fail('conflict', 'Only a blocked analytics job may be resumed explicitly.');
    const at = timestamp();
    if (job.plan_revision === 0 && job.error_code === 'conflict') {
      const changed = db.prepare(`
        UPDATE analytics_jobs
        SET status='planning', state_revision=state_revision+1, error_code=NULL,
            error_message=NULL, next_action=NULL, updated_at=?, completed_at=NULL
        WHERE id=? AND status='blocked' AND plan_revision=0 AND error_code='conflict'
      `).run(at, job.id);
      if (changed.changes !== 1) fail('conflict', 'Analytics planning state changed before resume.');
      return getJob(job.id)!;
    }
    db.transaction(() => {
      const resumed = db.prepare(`
        UPDATE analytics_job_nodes
        SET state='ready', state_revision=state_revision+1, error_code=NULL,
            error_message=NULL, retry_class=NULL, next_action=NULL, terminal_at=NULL, updated_at=?
        WHERE job_id=? AND plan_revision=? AND state='blocked' AND retry_class='transient'
      `).run(at, job.id, job.plan_revision);
      if (resumed.changes === 0) fail('conflict', 'Blocked analytics job has no transient resumable node.');
      db.prepare(`
        UPDATE analytics_jobs
        SET status='running', state_revision=state_revision+1, error_code=NULL,
            error_message=NULL, next_action=NULL, updated_at=?, completed_at=NULL
        WHERE id=? AND status='blocked'
      `).run(at, job.id);
    })();
    return getJob(job.id)!;
  }

  function setNeedsInput(value: { jobId: string; question: Record<string, unknown>; nextAction: string }): AnalyticsJobRecord {
    const job = getJobRow(value.jobId);
    if (!job) fail('not_found', `Analytics job ${value.jobId} was not found.`);
    if (job.question_count >= 1 || isTerminalJob(job.status)) fail('conflict', 'Analytics job cannot ask another question.');
    const question = canonical(value.question);
    const nextAction = cleanText(value.nextAction, 'next action', 1000);
    const at = timestamp();
    const changed = db.prepare(`
      UPDATE analytics_jobs
      SET status='needs_input', state_revision=state_revision+1, question_count=1,
          question_receipt_json=?, question_receipt_sha256=?, next_action=?, updated_at=?
      WHERE id=? AND question_count=0 AND status NOT IN ('complete','cancelled','failed')
    `).run(question.json, question.sha256, nextAction, at, job.id);
    if (changed.changes !== 1) fail('conflict', 'Analytics job changed before its question was recorded.');
    return getJob(job.id)!;
  }

  function recordResponse(value: { jobId: string; response: string }): AnalyticsJobRecord {
    const job = getJobRow(value.jobId);
    if (!job || job.status !== 'needs_input' || !job.question_receipt_json || !job.question_receipt_sha256) {
      fail('conflict', 'Analytics job has no open question.');
    }
    const response = cleanText(value.response, 'response', 4000);
    const question = strictCanonical<Record<string, unknown>>(
      job.question_receipt_json,
      job.question_receipt_sha256,
      `job ${job.id} question`,
    );
    const answered = canonical({ ...question, response });
    const at = timestamp();
    const changed = db.prepare(`
      UPDATE analytics_jobs
      SET status='planning', state_revision=state_revision+1,
          question_receipt_json=?, question_receipt_sha256=?, next_action=NULL, updated_at=?
      WHERE id=? AND status='needs_input' AND state_revision=?
    `).run(answered.json, answered.sha256, at, job.id, job.state_revision);
    if (changed.changes !== 1) fail('conflict', 'Analytics job changed before its response was recorded.');
    return getJob(job.id)!;
  }

  function recoverInterrupted(): number {
    const at = timestamp();
    let recovered = 0;
    db.transaction(() => {
      const attempts = db.prepare(`
        UPDATE analytics_job_node_attempts
        SET status='interrupted', retry_class='transient',
            error_code='startup_recovery', error_message='Process stopped during local analytics work.',
            next_action='Resume the exact node from its durable inputs.', completed_at=?
        WHERE status IN ('running','waiting_external')
      `).run(at);
      recovered += attempts.changes;
      const nodes = db.prepare(`
        UPDATE analytics_job_nodes
        SET state=CASE
              WHEN job_id IN (SELECT id FROM analytics_jobs WHERE status='cancel_requested') THEN 'cancelled'
              ELSE 'ready'
            END,
            state_revision=state_revision+1, current_attempt_id=NULL, lease_owner=NULL,
            lease_expires_at=NULL, heartbeat_at=?, retry_class=CASE
              WHEN job_id IN (SELECT id FROM analytics_jobs WHERE status='cancel_requested') THEN 'none'
              ELSE 'transient'
            END,
            error_code=CASE
              WHEN job_id IN (SELECT id FROM analytics_jobs WHERE status='cancel_requested') THEN 'cancelled'
              ELSE NULL
            END,
            error_message=CASE
              WHEN job_id IN (SELECT id FROM analytics_jobs WHERE status='cancel_requested') THEN 'Cancelled during restart recovery.'
              ELSE NULL
            END,
            next_action=CASE
              WHEN job_id IN (SELECT id FROM analytics_jobs WHERE status='cancel_requested') THEN 'Start a new analytics job if needed.'
              ELSE NULL
            END,
            updated_at=?, terminal_at=CASE
              WHEN job_id IN (SELECT id FROM analytics_jobs WHERE status='cancel_requested') THEN ?
              ELSE NULL
            END
        WHERE state IN ('running','waiting_external','needs_approval')
      `).run(at, at, at);
      recovered += nodes.changes;
      db.prepare(`
        UPDATE analytics_jobs
        SET status='cancelled', state_revision=state_revision+1, completed_at=?, updated_at=?,
            error_code='cancelled', error_message='Cancelled during restart recovery.',
            next_action='Start a new analytics job if needed.'
        WHERE status='cancel_requested'
      `).run(at, at);
      db.prepare(`
        UPDATE analytics_jobs
        SET status='running', state_revision=state_revision+1, updated_at=?,
            error_code=NULL, error_message=NULL, next_action=NULL
        WHERE status IN ('running','delivering','waiting_external','needs_approval') AND EXISTS (
          SELECT 1 FROM analytics_job_nodes node
          WHERE node.job_id=analytics_jobs.id AND node.plan_revision=analytics_jobs.plan_revision
            AND node.state='ready'
        )
      `).run(at);
    })();
    return recovered;
  }

  function activeWork(): Array<{ id: string; kind: 'analytics_job' | 'analytics_job_node'; disposition: 'startup_recovery' }> {
    return (db.prepare(`
      SELECT id, 'analytics_job' AS kind, 'startup_recovery' AS disposition
      FROM analytics_jobs
      WHERE status IN ('planning','running','delivering','waiting_external','needs_approval','cancel_requested')
      UNION ALL
      SELECT id, 'analytics_job_node', 'startup_recovery'
      FROM analytics_job_nodes
      WHERE state IN ('ready','running','waiting_external')
      ORDER BY kind, id
    `).all() as Array<{ id: string; kind: 'analytics_job' | 'analytics_job_node'; disposition: 'startup_recovery' }>);
  }

  return {
    createOrJoin,
    commitPlan,
    observe,
    getJob,
    getNode,
    getResult,
    claimNextReady,
    checkpoint,
    requeueNode,
    waitNode,
    resumeWaitingNode,
    succeedNode,
    blockPlanning,
    blockNode,
    insertResult,
    setResultVisibility,
    completeJob,
    requestCancel,
    finishCancelled,
    resumeBlocked,
    setNeedsInput,
    recordResponse,
    recoverInterrupted,
    activeWork,
  };
}
