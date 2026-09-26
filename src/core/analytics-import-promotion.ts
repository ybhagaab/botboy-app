import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import type { AnalyticsDataRoomService } from './analytics-data-room-service.js';
import { analyticsDatasetContractSha256 } from './analytics-data-room-store.js';
import { analyticsSha256, stableAnalyticsJson } from './analytics-data-room-policy.js';
import type { AnalyticsDatasetDefinitionInput, AnalyticsVersionPromotionReceipt } from './analytics-data-room-types.js';
import type { AnalyticsImportCandidateReader } from './analytics-import-inbox.js';
import { AnalyticsImportInboxError } from './analytics-import-inbox.js';
import { loadAnalyticsContext, resolveAnalyticsContextDir } from './analytics-context.js';
import {
  ANALYTICS_IMPORT_TRANSFORM_VERSION,
  type AnalyticsImportPreparedRows,
  type AnalyticsImportProposalRecord,
  type AnalyticsImportSemanticProposalService,
  type AnalyticsImportSemanticReview,
} from './analytics-import-semantic-proposal.js';

const SHA256_RE = /^[a-f0-9]{64}$/;
const APPROVAL_ID_RE = /^dria_[a-f0-9]{24}$/;
const PROMOTION_ID_RE = /^drim_[a-f0-9]{24}$/;
const OWNER_REQUEST_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{7,127}$/;

interface ApprovalRow {
  id: string;
  proposal_id: string;
  owner_request_id: string;
  request_identity_sha256: string;
  approval_sha256: string;
  proposal_revision: number;
  proposal_sha256: string;
  transform_version: string | null;
  candidate_revision: number;
  source_sha256: string;
  parse_sha256: string;
  profile_sha256: string;
  rowset_sha256: string;
  schema_sha256: string;
  context_bundle_sha256: string;
  response_sha256: string;
  contract_sha256: string;
  expected_definition_revision: number;
  expected_head_revision: number;
  approved_at: string;
}

interface PromotionRow {
  id: string;
  approval_id: string;
  state_revision: number;
  status: 'approved' | 'promoting' | 'complete' | 'conflict';
  intent_sha256: string;
  dataset_id: string;
  definition_revision: number | null;
  version_id: string | null;
  head_revision_before: number;
  head_revision_after: number | null;
  source_run_id: string | null;
  receipt_json: string | null;
  error_code: string | null;
  error_message: string | null;
  next_action: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

interface StoredContextReceipt {
  preset: string;
  source: string;
  business?: string;
  characters: number;
  sourceSha256: string;
  renderedSha256: string;
}

export interface AnalyticsImportPromotionService {
  start(): void;
  stop(): void;
  drain(): Promise<void>;
  acceptAndImport(input: {
    importId: string;
    proposalId: string;
    expectedStateRevision: number;
    proposalSha256: string;
    ownerRequestId: string;
    signal?: AbortSignal;
  }): Promise<AnalyticsImportSemanticReview>;
  retry(input: {
    importId: string;
    proposalId: string;
    expectedStateRevision: number;
    signal?: AbortSignal;
  }): Promise<AnalyticsImportSemanticReview>;
}

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function parseJson<T>(value: string | null, label: string): T {
  if (value === null) throw new AnalyticsImportInboxError('integrity_failed', `Stored ${label} is missing.`);
  try { return JSON.parse(value) as T; } catch { throw new AnalyticsImportInboxError('integrity_failed', `Stored ${label} is invalid.`); }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new AnalyticsImportInboxError('aborted', 'Import promotion was interrupted.', 'Reload the review to see durable promotion truth.');
}

function safePersistedError(error: unknown): { code: string; message: string } {
  const raw = error instanceof Error ? error.message : String(error);
  console.warn(`[AnalyticsImportPromotion] ${raw.slice(0, 1_000)}`);
  const scrubbed = raw
    .replace(/\/(?:Users|home)\/[^\s'"`]+/g, '[private path]')
    .replace(/[A-Za-z]:\\[^\s'"`]+/g, '[private path]');
  return {
    code: error instanceof AnalyticsImportInboxError ? error.code : 'conflict',
    message: error instanceof AnalyticsImportInboxError ? scrubbed.slice(0, 1_000) : 'Import promotion could not be reconciled safely.',
  };
}

function exactDefinitionEqual(existing: ReturnType<AnalyticsDataRoomService['getDataset']>, proposed: AnalyticsDatasetDefinitionInput): boolean {
  if (!existing) return false;
  return stableAnalyticsJson({
    id: existing.id,
    name: existing.name,
    description: existing.description,
    kind: existing.kind,
    scope: existing.scope,
    domainKey: existing.domainKey,
    ownerId: existing.ownerId,
    lifecycle: existing.lifecycle,
    sourceKind: existing.sourceKind,
    sourceFormat: existing.sourceFormat,
    definition: existing.definition,
    contract: existing.contract,
    retention: existing.retention,
  }) === stableAnalyticsJson({ ...proposed, lifecycle: proposed.lifecycle ?? 'draft', description: proposed.description ?? '' });
}

export function createAnalyticsImportPromotionService(input: {
  db: Database.Database;
  candidateReader: AnalyticsImportCandidateReader;
  proposalService: AnalyticsImportSemanticProposalService;
  dataRoom: AnalyticsDataRoomService;
  now?: () => Date;
  createId?: () => string;
}): AnalyticsImportPromotionService {
  const db = input.db;
  const now = input.now ?? (() => new Date());
  const createId = input.createId ?? (() => randomUUID().replace(/-/g, '').slice(0, 24));
  const active = new Map<string, Promise<AnalyticsImportSemanticReview>>();
  let shutdownController = new AbortController();
  let stopping = false;

  const timestamp = (): string => now().toISOString();
  const operationSignal = (signal?: AbortSignal): AbortSignal => signal
    ? AbortSignal.any([signal, shutdownController.signal])
    : shutdownController.signal;
  const approvalByProposal = (proposalId: string): ApprovalRow | undefined => db.prepare(
    'SELECT * FROM analytics_import_proposal_approvals WHERE proposal_id = ?',
  ).get(proposalId) as ApprovalRow | undefined;
  const approvalByRequest = (requestId: string): ApprovalRow | undefined => db.prepare(
    'SELECT * FROM analytics_import_proposal_approvals WHERE owner_request_id = ?',
  ).get(requestId) as ApprovalRow | undefined;
  const promotionByApproval = (approvalId: string): PromotionRow | undefined => db.prepare(
    'SELECT * FROM analytics_import_promotions WHERE approval_id = ?',
  ).get(approvalId) as PromotionRow | undefined;
  const promotionById = (id: string): PromotionRow | undefined => db.prepare(
    'SELECT * FROM analytics_import_promotions WHERE id = ?',
  ).get(id) as PromotionRow | undefined;

  function bumpRoomRevision(at: string): void {
    const result = db.prepare(`UPDATE analytics_data_room_state SET revision=revision+1, updated_at=? WHERE singleton=1`).run(at);
    if (result.changes !== 1) throw new AnalyticsImportInboxError('integrity_failed', 'Data Room revision state is unavailable.');
  }

  function verifiedProposal(proposalId: string): { row: AnalyticsImportProposalRecord; definition: AnalyticsDatasetDefinitionInput } {
    const row = input.proposalService.readProposalRecord(proposalId);
    if (!row) throw new AnalyticsImportInboxError('not_found', 'Semantic proposal was not found.');
    if (!row.proposal_json || !row.proposal_sha256 || sha256(row.proposal_json) !== row.proposal_sha256
      || !row.definition_json || !row.contract_json || !row.contract_sha256 || !row.transform_version
      || !row.parse_sha256 || !row.profile_sha256 || !row.context_bundle_sha256 || !row.response_sha256) {
      throw new AnalyticsImportInboxError('integrity_failed', 'Semantic proposal receipt is incomplete.');
    }
    const definition = parseJson<AnalyticsDatasetDefinitionInput>(row.definition_json, 'proposal definition');
    const contract = parseJson<AnalyticsDatasetDefinitionInput['contract']>(row.contract_json, 'proposal contract');
    const proposal = parseJson<Record<string, any>>(row.proposal_json, 'proposal content');
    const answer = definition.definition.answer as Record<string, unknown> | undefined;
    if (stableAnalyticsJson(definition.contract) !== stableAnalyticsJson(contract)
      || analyticsDatasetContractSha256(contract) !== row.contract_sha256
      || contract.contractSha256 !== row.contract_sha256
      || definition.id !== proposal.datasetId || definition.name !== proposal.name
      || definition.description !== proposal.description || definition.domainKey !== proposal.domainKey
      || contract.metric.id !== proposal.metric?.id || contract.metric.unit !== proposal.metric?.unit
      || contract.regime.id !== proposal.regime?.id || contract.grain !== proposal.grain
      || contract.countingKey !== proposal.countingKey || contract.timeField !== proposal.timeField
      || contract.timeZone !== proposal.timeZone || contract.handling.classification !== proposal.classification
      || proposal.transformVersion !== row.transform_version
      || definition.definition.adapter !== 'xlsx_import'
      || definition.definition.adapterVersion !== row.transform_version
      || stableAnalyticsJson(contract.handling) !== stableAnalyticsJson({ classification: proposal.classification, ...proposal.handling })
      || stableAnalyticsJson(definition.retention) !== stableAnalyticsJson(proposal.retention)
      || stableAnalyticsJson(answer?.rowDimensions) !== stableAnalyticsJson(proposal.dimensions)) {
      throw new AnalyticsImportInboxError('integrity_failed', 'Semantic proposal definition/contract failed verification.');
    }
    return { row, definition };
  }

  function verifyContext(row: AnalyticsImportProposalRecord): void {
    const receipts = parseJson<StoredContextReceipt[]>(row.context_receipts_json, 'proposal context receipts');
    if (!Array.isArray(receipts) || !receipts.length || receipts.some(receipt => !SHA256_RE.test(receipt.sourceSha256) || !SHA256_RE.test(receipt.renderedSha256))) {
      throw new AnalyticsImportInboxError('integrity_failed', 'Semantic proposal context receipt is malformed.');
    }
    const root = resolveAnalyticsContextDir(db);
    for (const receipt of receipts) {
      const absolute = path.resolve(root, receipt.preset);
      if (absolute !== root && !absolute.startsWith(`${root}${path.sep}`)) throw new AnalyticsImportInboxError('integrity_failed', 'Analytics context path escaped its configured root.');
      const stat = fs.lstatSync(absolute);
      if (!stat.isFile() || stat.isSymbolicLink() || sha256(fs.readFileSync(absolute)) !== receipt.sourceSha256) {
        throw new AnalyticsImportInboxError('conflict', `Analytics context ${receipt.preset} changed after review preparation.`, 'Prepare a new semantic review.');
      }
      const loaded = loadAnalyticsContext(db, receipt.preset, 2_000_000);
      if (!loaded.ok || loaded.truncated || sha256(loaded.content) !== receipt.renderedSha256) {
        throw new AnalyticsImportInboxError('conflict', `Analytics context ${receipt.preset} no longer matches its review receipt.`, 'Prepare a new semantic review.');
      }
    }
  }

  function approvalDigestPayload(
    row: AnalyticsImportProposalRecord,
    prepared: AnalyticsImportPreparedRows,
    value: {
      approvalId: string;
      ownerRequestId: string;
      requestIdentitySha256: string;
      expectedDefinitionRevision: number;
      expectedHeadRevision: number;
      approvedAt: string;
    },
    options: { includeTransformVersion?: boolean } = {},
  ): Record<string, unknown> {
    return {
      approvalId: value.approvalId,
      ownerRequestId: value.ownerRequestId,
      requestIdentitySha256: value.requestIdentitySha256,
      proposalId: row.id,
      proposalRevision: row.proposal_revision,
      proposalSha256: row.proposal_sha256,
      candidateRevision: row.candidate_revision,
      sourceSha256: row.source_sha256,
      parserVersion: row.parser_version,
      ...(options.includeTransformVersion === false ? {} : { transformVersion: row.transform_version }),
      headerPolicyVersion: row.header_policy_version,
      datePolicyVersion: row.date_policy_version,
      formulaPolicyVersion: row.formula_policy_version,
      errorPolicyVersion: row.error_policy_version,
      rowCount: row.row_count,
      nonEmptyRowCount: row.non_empty_row_count,
      columnCount: row.column_count,
      cellCount: row.cell_count,
      dateSystem: row.date_system,
      formulaCellCount: row.formula_cell_count,
      formulaWithoutCachedValueCount: row.formula_without_cached_value_count,
      errorCellCount: row.error_cell_count,
      mergedRangeCount: row.merged_range_count,
      parseSha256: row.parse_sha256,
      profileSha256: row.profile_sha256,
      rowsetSha256: prepared.rowsetSha256,
      schemaSha256: prepared.schemaSha256,
      contextSelectionSha256: row.context_selection_sha256,
      contextReceiptsSha256: sha256(row.context_receipts_json ?? ''),
      contextBundleSha256: row.context_bundle_sha256,
      promptVersion: row.prompt_version,
      promptSha256: row.prompt_sha256,
      provider: row.provider,
      model: row.model,
      apiMode: row.api_mode,
      providerEndpointSha256: row.provider_endpoint_sha256,
      providerLocality: row.provider_locality,
      modelTemperature: row.model_temperature,
      disclosurePolicyVersion: row.disclosure_policy_version,
      responseSha256: row.response_sha256,
      validatorVersion: row.validator_version,
      definitionSha256: sha256(row.definition_json ?? ''),
      contractSha256: row.contract_sha256,
      expectedDefinitionRevision: value.expectedDefinitionRevision,
      expectedHeadRevision: value.expectedHeadRevision,
      approvedAt: value.approvedAt,
    };
  }

  function createApproval(value: {
    importId: string;
    proposalId: string;
    expectedStateRevision: number;
    proposalSha256: string;
    ownerRequestId: string;
  }): { approval: ApprovalRow; promotion: PromotionRow } {
    if (!OWNER_REQUEST_ID_RE.test(value.ownerRequestId)) throw new AnalyticsImportInboxError('invalid_input', 'ownerRequestId is malformed.');
    const verified = verifiedProposal(value.proposalId);
    const row = verified.row;
    if (row.candidate_id !== value.importId) throw new AnalyticsImportInboxError('invalid_input', 'Proposal does not belong to this import candidate.');
    if (row.proposal_sha256 !== value.proposalSha256) throw new AnalyticsImportInboxError('conflict', 'Proposal content changed since this review was loaded.', 'Reload the import review.');
    const requestIdentitySha256 = analyticsSha256({
      importId: value.importId,
      proposalId: value.proposalId,
      proposalSha256: value.proposalSha256,
      expectedStateRevision: value.expectedStateRevision,
    });
    const existingRequest = approvalByRequest(value.ownerRequestId);
    if (existingRequest) {
      if (existingRequest.request_identity_sha256 !== requestIdentitySha256) throw new AnalyticsImportInboxError('conflict', 'ownerRequestId was already used for a different import approval.');
      const promotion = promotionByApproval(existingRequest.id);
      if (!promotion) throw new AnalyticsImportInboxError('integrity_failed', 'Approved import has no promotion intent.');
      return { approval: existingRequest, promotion };
    }
    if (row.transform_version !== ANALYTICS_IMPORT_TRANSFORM_VERSION) {
      throw new AnalyticsImportInboxError('conflict', 'Proposal transform recipe is no longer current.', 'Reload the import review.');
    }
    if (row.state_revision !== value.expectedStateRevision || row.status !== 'review_ready') {
      const existingApproval = approvalByProposal(row.id);
      const promotion = existingApproval ? promotionByApproval(existingApproval.id) : undefined;
      if (existingApproval && promotion) return { approval: existingApproval, promotion };
      throw new AnalyticsImportInboxError('conflict', 'Proposal is no longer ready for approval.', 'Reload the import review.');
    }
    const prepared = input.proposalService.readPreparedRows(row);
    const currentDataset = input.dataRoom.getDataset(verified.definition.id);
    const expectedDefinitionRevision = currentDataset?.definitionRevision ?? 0;
    const expectedHeadRevision = currentDataset?.head?.headRevision ?? 0;
    input.candidateReader.readVerifiedCandidate({ importId: row.candidate_id, expectedRevision: row.candidate_revision });
    verifyContext(row);
    const approvalId = `dria_${createId()}`;
    const promotionId = `drim_${createId()}`;
    if (!APPROVAL_ID_RE.test(approvalId) || !PROMOTION_ID_RE.test(promotionId)) throw new AnalyticsImportInboxError('integrity_failed', 'Import approval identity generation failed.');
    const approvedAt = timestamp();
    const approvalPayload = approvalDigestPayload(row, prepared, {
      approvalId,
      ownerRequestId: value.ownerRequestId,
      requestIdentitySha256,
      expectedDefinitionRevision,
      expectedHeadRevision,
      approvedAt,
    });
    const approvalSha256 = analyticsSha256(approvalPayload);
    const intentSha256 = analyticsSha256({ approvalSha256, datasetId: verified.definition.id, expectedDefinitionRevision, expectedHeadRevision });
    db.transaction(() => {
      const changed = db.prepare(`UPDATE analytics_import_semantic_proposals
        SET status='approved', state_revision=state_revision+1, updated_at=?
        WHERE id=? AND state_revision=? AND status='review_ready' AND transform_version=?`)
        .run(approvedAt, row.id, row.state_revision, ANALYTICS_IMPORT_TRANSFORM_VERSION);
      if (changed.changes !== 1) throw new AnalyticsImportInboxError('conflict', 'Proposal changed before approval was recorded.');
      db.prepare(`INSERT INTO analytics_import_proposal_approvals (
        id, proposal_id, owner_request_id, request_identity_sha256, approval_sha256,
        proposal_revision, proposal_sha256, transform_version, candidate_revision, source_sha256,
        parse_sha256, profile_sha256, rowset_sha256, schema_sha256, context_bundle_sha256,
        response_sha256, contract_sha256, expected_definition_revision, expected_head_revision, approved_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(
          approvalId, row.id, value.ownerRequestId, requestIdentitySha256, approvalSha256,
          row.proposal_revision, row.proposal_sha256, row.transform_version, row.candidate_revision, row.source_sha256,
          row.parse_sha256, row.profile_sha256, prepared.rowsetSha256, prepared.schemaSha256,
          row.context_bundle_sha256, row.response_sha256, row.contract_sha256,
          expectedDefinitionRevision, expectedHeadRevision, approvedAt,
        );
      db.prepare(`INSERT INTO analytics_import_promotions (
        id, approval_id, state_revision, status, intent_sha256, dataset_id,
        head_revision_before, created_at, updated_at
      ) VALUES (?, ?, 1, 'approved', ?, ?, ?, ?, ?)`)
        .run(promotionId, approvalId, intentSha256, verified.definition.id, expectedHeadRevision, approvedAt, approvedAt);
      bumpRoomRevision(approvedAt);
    })();
    return { approval: approvalByProposal(row.id)!, promotion: promotionById(promotionId)! };
  }

  function setConflict(proposal: AnalyticsImportProposalRecord, promotion: PromotionRow, error: unknown): void {
    const safe = safePersistedError(error);
    const at = timestamp();
    db.transaction(() => {
      db.prepare(`UPDATE analytics_import_promotions SET status='conflict', state_revision=state_revision+1,
        error_code=?, error_message=?, next_action='Reload the review, verify the changed input, then retry the exact promotion.',
        updated_at=? WHERE id=? AND state_revision=? AND status IN ('approved','promoting')`)
        .run(safe.code, safe.message, at, promotion.id, promotion.state_revision);
      db.prepare(`UPDATE analytics_import_semantic_proposals SET status='conflict', state_revision=state_revision+1,
        error_code=?, error_message=?, next_action='Reload the review, verify the changed input, then retry the exact promotion.',
        updated_at=? WHERE id=? AND status IN ('approved','promoting')`)
        .run(safe.code, safe.message, at, proposal.id);
      bumpRoomRevision(at);
    })();
  }

  function recordPromotionComplete(value: {
    proposal: AnalyticsImportProposalRecord;
    promotion: PromotionRow;
    approval: ApprovalRow;
    prepared: AnalyticsImportPreparedRows;
    definitionRevision: number;
    versionId: string;
    headRevision: number;
    sourceRunId: string;
    idempotent: boolean;
  }): AnalyticsImportSemanticReview {
    const completedAt = timestamp();
    const summary = {
      promotionId: value.promotion.id,
      intentSha256: value.promotion.intent_sha256,
      approvalId: value.approval.id,
      approvalSha256: value.approval.approval_sha256,
      proposalId: value.proposal.id,
      proposalSha256: value.approval.proposal_sha256,
      transformVersion: value.approval.transform_version,
      datasetId: value.promotion.dataset_id,
      definitionRevision: value.definitionRevision,
      versionId: value.versionId,
      headRevisionBefore: value.approval.expected_head_revision,
      headRevisionAfter: value.headRevision,
      sourceRunId: value.sourceRunId,
      inputSha256: value.prepared.inputSha256,
      parseSha256: value.prepared.parseSha256,
      profileSha256: value.prepared.profileSha256,
      rowsetSha256: value.prepared.rowsetSha256,
      schemaSha256: value.prepared.schemaSha256,
      contextBundleSha256: value.approval.context_bundle_sha256,
      responseSha256: value.approval.response_sha256,
      contractSha256: value.approval.contract_sha256,
      idempotent: value.idempotent,
      completedAt,
    };
    db.transaction(() => {
      const current = promotionById(value.promotion.id)!;
      if (current.status === 'complete') return;
      const changed = db.prepare(`UPDATE analytics_import_promotions SET status='complete', state_revision=state_revision+1,
        definition_revision=?, version_id=?, head_revision_after=?, source_run_id=?, receipt_json=?,
        error_code=NULL, error_message=NULL, next_action=NULL, completed_at=?, updated_at=?
        WHERE id=? AND state_revision=? AND status IN ('approved','promoting')`)
        .run(value.definitionRevision, value.versionId, value.headRevision, value.sourceRunId,
          stableAnalyticsJson(summary), completedAt, completedAt, current.id, current.state_revision);
      const proposalChanged = db.prepare(`UPDATE analytics_import_semantic_proposals SET status='complete', state_revision=state_revision+1,
        error_code=NULL, error_message=NULL, next_action=NULL, completed_at=?, updated_at=?
        WHERE id=? AND status IN ('approved','promoting')`).run(completedAt, completedAt, value.proposal.id);
      if (changed.changes !== 1 || proposalChanged.changes !== 1) throw new AnalyticsImportInboxError('conflict', 'Promotion effect is verified but its local completion receipt changed.');
      bumpRoomRevision(completedAt);
    })();
    return input.proposalService.getReview(value.proposal.candidate_id)!;
  }

  function reconcileCompletedEffect(
    proposal: AnalyticsImportProposalRecord,
    promotion: PromotionRow,
    approval: ApprovalRow,
    prepared: AnalyticsImportPreparedRows,
    definition: AnalyticsDatasetDefinitionInput,
  ): AnalyticsImportSemanticReview | null {
    const run = db.prepare(`
      SELECT id, output_version_id FROM analytics_dataset_runs
      WHERE dataset_id=? AND source_kind='import' AND status='completed'
        AND json_extract(remote_identity_json, '$.sourceId')=?
      ORDER BY completed_at DESC, id LIMIT 1
    `).get(definition.id, promotion.id) as { id: string; output_version_id: string | null } | undefined;
    if (!run?.output_version_id) return null;
    const dataset = input.dataRoom.getDataset(definition.id);
    const version = input.dataRoom.getDatasetVersion(run.output_version_id);
    const producerVersionMatches = version?.sourceReceipt.producerVersion === approval.transform_version
      || (prepared.transformVersion === undefined
        && version?.sourceReceipt.producerVersion === prepared.parserVersion);
    if (!dataset || !version || !exactDefinitionEqual(dataset, definition)
      || version.sourceReceipt.sourceId !== promotion.id
      || version.sourceReceipt.sourceKind !== 'import'
      || !producerVersionMatches
      || version.rowCount !== prepared.rowCount
      || version.contractSha256 !== approval.contract_sha256
      || version.contract.schemaSha256 !== prepared.schemaSha256
      || dataset.head?.versionId !== version.id) {
      throw new AnalyticsImportInboxError('conflict', 'A prior import effect exists but does not match the approved promotion intent.', 'Review the target dataset before retrying.');
    }
    return recordPromotionComplete({
      proposal,
      promotion,
      approval,
      prepared,
      definitionRevision: dataset.definitionRevision,
      versionId: version.id,
      headRevision: dataset.head.headRevision,
      sourceRunId: run.id,
      idempotent: true,
    });
  }

  function runPromotion(promotionId: string, signal?: AbortSignal): Promise<AnalyticsImportSemanticReview> {
    const existing = active.get(promotionId);
    if (existing) return existing;
    const work = (async () => {
      throwIfAborted(signal);
      const promotion = promotionById(promotionId);
      if (!promotion) throw new AnalyticsImportInboxError('not_found', 'Import promotion was not found.');
      const approval = db.prepare('SELECT * FROM analytics_import_proposal_approvals WHERE id = ?').get(promotion.approval_id) as ApprovalRow | undefined;
      if (!approval) throw new AnalyticsImportInboxError('integrity_failed', 'Import promotion approval is missing.');
      const approvalTransformVersion = approval.transform_version;
      if (!approvalTransformVersion) throw new AnalyticsImportInboxError('integrity_failed', 'Import promotion approval has no durable transform identity.');
      const verified = verifiedProposal(approval.proposal_id);
      const proposal = verified.row;
      if (promotion.status === 'complete' || promotion.status === 'conflict') return input.proposalService.getReview(proposal.candidate_id)!;
      if (promotion.status !== 'approved' && promotion.status !== 'promoting') {
        throw new AnalyticsImportInboxError('conflict', 'Import promotion is not in an executable state.');
      }
      if (stopping) throw new AnalyticsImportInboxError('aborted', 'BotBoy is shutting down; approved import remains recoverable.');
      const prepared = input.proposalService.readPreparedRows(proposal);
      const approvalPayload = {
        approvalId: approval.id,
        ownerRequestId: approval.owner_request_id,
        requestIdentitySha256: approval.request_identity_sha256,
        expectedDefinitionRevision: approval.expected_definition_revision,
        expectedHeadRevision: approval.expected_head_revision,
        approvedAt: approval.approved_at,
      };
      const approvalDigest = analyticsSha256(approvalDigestPayload(proposal, prepared, approvalPayload));
      const legacyApprovalDigest = analyticsSha256(approvalDigestPayload(
        proposal,
        prepared,
        approvalPayload,
        { includeTransformVersion: false },
      ));
      const legacyApprovalDigestIsValid = prepared.transformVersion === undefined
        && legacyApprovalDigest === approval.approval_sha256;
      const expectedIntentSha256 = analyticsSha256({
        approvalSha256: approval.approval_sha256,
        datasetId: verified.definition.id,
        expectedDefinitionRevision: approval.expected_definition_revision,
        expectedHeadRevision: approval.expected_head_revision,
      });
      if ((approvalDigest !== approval.approval_sha256 && !legacyApprovalDigestIsValid)
        || expectedIntentSha256 !== promotion.intent_sha256) {
        throw new AnalyticsImportInboxError('integrity_failed', 'Import approval or promotion intent failed verification.');
      }
      if (approval.transform_version !== proposal.transform_version
        || prepared.rowsetSha256 !== approval.rowset_sha256 || prepared.schemaSha256 !== approval.schema_sha256
        || proposal.proposal_sha256 !== approval.proposal_sha256 || proposal.contract_sha256 !== approval.contract_sha256
        || proposal.parse_sha256 !== approval.parse_sha256 || proposal.profile_sha256 !== approval.profile_sha256
        || proposal.context_bundle_sha256 !== approval.context_bundle_sha256 || proposal.response_sha256 !== approval.response_sha256) {
        throw new AnalyticsImportInboxError('conflict', 'Approved import receipts changed before promotion.', 'Prepare a new review.');
      }
      const reconciled = reconcileCompletedEffect(proposal, promotion, approval, prepared, verified.definition);
      if (reconciled) return reconciled;
      await input.proposalService.reverifyProposalInputs(proposal, signal);
      const startedAt = timestamp();
      const latestPromotion = promotionById(promotion.id)!;
      if (latestPromotion.status === 'approved') {
        db.transaction(() => {
          const p = db.prepare(`UPDATE analytics_import_promotions SET status='promoting', state_revision=state_revision+1,
            error_code=NULL, error_message=NULL, next_action=NULL, updated_at=? WHERE id=? AND state_revision=? AND status='approved'`)
            .run(startedAt, latestPromotion.id, latestPromotion.state_revision);
          const q = db.prepare(`UPDATE analytics_import_semantic_proposals SET status='promoting', state_revision=state_revision+1,
            error_code=NULL, error_message=NULL, next_action=NULL, updated_at=? WHERE id=? AND status='approved'`)
            .run(startedAt, proposal.id);
          if (p.changes !== 1 || q.changes !== 1) throw new AnalyticsImportInboxError('conflict', 'Import promotion state changed before execution.');
          bumpRoomRevision(startedAt);
        })();
      }
      throwIfAborted(signal);
      const currentDataset = input.dataRoom.getDataset(verified.definition.id);
      if (currentDataset) {
        const expectedRevisionMatches = approval.expected_definition_revision === 0
          ? currentDataset.definitionRevision === 1 && currentDataset.head === null
          : currentDataset.definitionRevision === approval.expected_definition_revision;
        if (!expectedRevisionMatches || !exactDefinitionEqual(currentDataset, verified.definition)) {
          throw new AnalyticsImportInboxError('conflict', 'Target dataset definition changed after approval.', 'Prepare a new semantic review against the current dataset.');
        }
      } else {
        if (approval.expected_definition_revision !== 0 || approval.expected_head_revision !== 0) {
          throw new AnalyticsImportInboxError('conflict', 'Approved target dataset disappeared before promotion.');
        }
        input.dataRoom.registerDataset(verified.definition);
      }
      const head = input.dataRoom.getDataset(verified.definition.id)?.head;
      if ((head?.headRevision ?? 0) !== approval.expected_head_revision) {
        const completed = promotionById(promotion.id);
        if (completed?.version_id && head?.versionId === completed.version_id) return input.proposalService.getReview(proposal.candidate_id)!;
        throw new AnalyticsImportInboxError('conflict', 'Target dataset head changed after approval.', 'Prepare a new semantic review against the current head.');
      }
      throwIfAborted(signal);
      const receipt: AnalyticsVersionPromotionReceipt = input.dataRoom.ingestImportRows({
        datasetId: verified.definition.id,
        expectedHeadRevision: approval.expected_head_revision,
        materializedAt: approval.approved_at,
        sourceReceipt: {
          sourceKind: 'import',
          sourceId: promotion.id,
          producerVersion: approvalTransformVersion,
          acquiredAt: approval.approved_at,
          submittedAgain: false,
        },
        quality: [
          { assertionId: 'complete_to_eof', assertionVersion: '1', severity: 'error', success: true, observed: true, expected: true },
          { assertionId: 'row_count_positive', assertionVersion: '1', severity: 'error', success: prepared.rowCount > 0, observed: prepared.rowCount, expected: 1 },
          { assertionId: 'approved_semantic_contract', assertionVersion: '1', severity: 'error', success: true, observed: approval.contract_sha256, expected: approval.contract_sha256 },
        ],
        requestSha256: promotion.intent_sha256,
        trigger: 'api',
        columns: prepared.columns,
        rows: prepared.rows,
        rowCount: prepared.rowCount,
        complete: {
          parserVersion: prepared.parserVersion,
          transformVersion: approvalTransformVersion,
          completeToEof: true,
          inputSha256: prepared.inputSha256,
          profileSha256: prepared.profileSha256,
          rowsetSha256: prepared.rowsetSha256,
          schemaSha256: prepared.schemaSha256,
        },
      });
      return recordPromotionComplete({
        proposal,
        promotion: promotionById(promotion.id)!,
        approval,
        prepared,
        definitionRevision: receipt.head.definitionRevision,
        versionId: receipt.version.id,
        headRevision: receipt.head.headRevision,
        sourceRunId: receipt.run.id,
        idempotent: receipt.idempotent,
      });
    })().catch(error => {
      const promotion = promotionById(promotionId);
      if (promotion) {
        const approval = db.prepare('SELECT * FROM analytics_import_proposal_approvals WHERE id = ?').get(promotion.approval_id) as ApprovalRow | undefined;
        const proposal = approval ? input.proposalService.readProposalRecord(approval.proposal_id) : null;
        if (proposal && promotion.status !== 'complete' && !(error instanceof AnalyticsImportInboxError && error.code === 'aborted' && stopping)) {
          setConflict(proposal, promotionById(promotionId)!, error);
          if (error instanceof AnalyticsImportInboxError && error.code === 'conflict'
            && /candidate|workbook profile|analytics context/i.test(error.message)) {
            const conflicted = input.proposalService.readProposalRecord(proposal.id);
            if (conflicted) return input.proposalService.refreshAfterDrift(conflicted, error.message);
          }
        }
        if (proposal) return input.proposalService.getReview(proposal.candidate_id)!;
      }
      throw error;
    }).finally(() => active.delete(promotionId));
    active.set(promotionId, work);
    return work;
  }

  async function acceptAndImport(value: {
    importId: string;
    proposalId: string;
    expectedStateRevision: number;
    proposalSha256: string;
    ownerRequestId: string;
    signal?: AbortSignal;
  }): Promise<AnalyticsImportSemanticReview> {
    const signal = operationSignal(value.signal);
    throwIfAborted(signal);
    const existingApproval = approvalByRequest(value.ownerRequestId);
    if (!existingApproval) {
      const verified = verifiedProposal(value.proposalId);
      if (verified.row.candidate_id !== value.importId || verified.row.state_revision !== value.expectedStateRevision
        || verified.row.proposal_sha256 !== value.proposalSha256 || verified.row.status !== 'review_ready'
        || verified.row.transform_version !== ANALYTICS_IMPORT_TRANSFORM_VERSION) {
        throw new AnalyticsImportInboxError('conflict', 'Proposal is no longer the exact review awaiting approval.', 'Reload the import review.');
      }
      try {
        await input.proposalService.reverifyProposalInputs(verified.row, signal);
      } catch (error) {
        if (error instanceof AnalyticsImportInboxError && error.code === 'conflict') {
          return input.proposalService.refreshAfterDrift(verified.row, error.message);
        }
        throw error;
      }
    }
    const { promotion } = createApproval(value);
    return runPromotion(promotion.id, signal);
  }

  async function retry(value: {
    importId: string;
    proposalId: string;
    expectedStateRevision: number;
    signal?: AbortSignal;
  }): Promise<AnalyticsImportSemanticReview> {
    const signal = operationSignal(value.signal);
    throwIfAborted(signal);
    const proposal = input.proposalService.readProposalRecord(value.proposalId);
    if (!proposal || proposal.candidate_id !== value.importId) throw new AnalyticsImportInboxError('not_found', 'Import proposal was not found.');
    if (proposal.state_revision !== value.expectedStateRevision || proposal.status !== 'conflict') {
      throw new AnalyticsImportInboxError('conflict', 'Import promotion is not retryable from this review.', 'Reload the import review.');
    }
    const approval = approvalByProposal(proposal.id);
    const promotion = approval ? promotionByApproval(approval.id) : undefined;
    if (!approval || !promotion) throw new AnalyticsImportInboxError('integrity_failed', 'Conflicted import has no durable approval/promotion receipt.');
    const at = timestamp();
    db.transaction(() => {
      const p = db.prepare(`UPDATE analytics_import_promotions SET status='approved', state_revision=state_revision+1,
        error_code=NULL, error_message=NULL, next_action=NULL, updated_at=? WHERE id=? AND state_revision=? AND status='conflict'`)
        .run(at, promotion.id, promotion.state_revision);
      const q = db.prepare(`UPDATE analytics_import_semantic_proposals SET status='approved', state_revision=state_revision+1,
        error_code=NULL, error_message=NULL, next_action=NULL, updated_at=? WHERE id=? AND state_revision=? AND status='conflict'`)
        .run(at, proposal.id, proposal.state_revision);
      if (p.changes !== 1 || q.changes !== 1) throw new AnalyticsImportInboxError('conflict', 'Import promotion changed before retry.');
      bumpRoomRevision(at);
    })();
    return runPromotion(promotion.id, signal);
  }

  function start(): void {
    stopping = false;
    if (shutdownController.signal.aborted) shutdownController = new AbortController();
    const rows = db.prepare(`SELECT id FROM analytics_import_promotions WHERE status IN ('approved','promoting') ORDER BY updated_at, id`).all() as Array<{ id: string }>;
    for (const row of rows) queueMicrotask(() => { void runPromotion(row.id, shutdownController.signal); });
  }

  function stop(): void {
    stopping = true;
    shutdownController.abort(new Error('BotBoy is shutting down.'));
  }

  async function drain(): Promise<void> {
    await Promise.allSettled([...active.values()]);
  }

  return { start, stop, drain, acceptAndImport, retry };
}
