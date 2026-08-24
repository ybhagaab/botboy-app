import { createHash, randomUUID } from 'crypto';
import type Database from 'better-sqlite3';
import type { PipelineLlm } from './pipeline-llm.js';

export type AuditedPipelinePass = 'librarian' | 'brain' | 'reconcile' | 'organize' | 'digest';

export interface ModelAuditContext {
  runId?: string;
  pass: AuditedPipelinePass;
  batchId?: string;
  projectId?: string;
  promptVersion: string;
}

export interface RoutingDecisionAudit {
  runId: string;
  invocationId?: string;
  batchId: string;
  itemId: string;
  modelDecision?: string;
  requestedProjectId?: string;
  requestedTitle?: string;
  modelReason?: string;
  appliedDecision: string;
  appliedProjectId?: string;
  validationReason: string;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function warnAuditFailure(operation: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.warn(`[pipeline-audit] ${operation} failed: ${message}`);
}

/**
 * Record model identity and a prompt hash before a request. Prompt/response
 * plaintext stays in the evidence and brain stores rather than being copied to
 * a second long-lived secret-bearing table. Audit is best-effort and must never
 * alter routing or synthesis behavior.
 */
export function startModelAudit(
  db: Database.Database,
  llm: PipelineLlm,
  context: ModelAuditContext,
  prompt: string,
): string | undefined {
  const id = randomUUID();
  try {
    const metadata = llm.auditMetadata?.() ?? {};
    db.prepare(
      `INSERT INTO pipeline_llm_audit
         (id, run_id, pass, batch_id, project_id, prompt_version,
          provider, model, active_endpoint, temperature, prompt_sha256, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'running')`,
    ).run(
      id,
      context.runId ?? null,
      context.pass,
      context.batchId ?? null,
      context.projectId ?? null,
      context.promptVersion,
      metadata.provider ?? null,
      metadata.model ?? null,
      metadata.activeEndpoint ?? null,
      metadata.temperature ?? null,
      sha256(prompt),
    );
    return id;
  } catch (error) {
    warnAuditFailure('start', error);
    return undefined;
  }
}

export function completeModelAudit(
  db: Database.Database,
  llm: PipelineLlm,
  invocationId: string | undefined,
  response: string,
  outcome = 'completed',
): void {
  if (!invocationId) return;
  try {
    const metadata = llm.auditMetadata?.() ?? {};
    db.prepare(
      `UPDATE pipeline_llm_audit
       SET response_sha256=?, status=?, provider=COALESCE(?, provider),
           model=COALESCE(?, model), active_endpoint=COALESCE(?, active_endpoint),
           completed_at=datetime('now')
       WHERE id=?`,
    ).run(
      sha256(response),
      outcome,
      metadata.provider ?? null,
      metadata.model ?? null,
      metadata.activeEndpoint ?? null,
      invocationId,
    );
  } catch (error) {
    warnAuditFailure('complete', error);
  }
}

export function failModelAudit(
  db: Database.Database,
  llm: PipelineLlm,
  invocationId: string | undefined,
  error: unknown,
): void {
  if (!invocationId) return;
  try {
    const metadata = llm.auditMetadata?.() ?? {};
    db.prepare(
      `UPDATE pipeline_llm_audit
       SET status='failed', error=?, provider=COALESCE(?, provider),
           model=COALESCE(?, model), active_endpoint=COALESCE(?, active_endpoint),
           completed_at=datetime('now')
       WHERE id=?`,
    ).run(
      String(error instanceof Error ? error.message : error).slice(0, 2000),
      metadata.provider ?? null,
      metadata.model ?? null,
      metadata.activeEndpoint ?? null,
      invocationId,
    );
  } catch (auditError) {
    warnAuditFailure('fail', auditError);
  }
}

/** Durable per-item provenance for model proposals and deterministic gates. */
export function recordRoutingDecision(db: Database.Database, audit: RoutingDecisionAudit): void {
  try {
    db.prepare(
      `INSERT INTO routing_decisions
         (run_id, invocation_id, batch_id, item_id, model_decision,
          requested_project_id, requested_title, model_reason, applied_decision,
          applied_project_id, validation_reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      audit.runId,
      audit.invocationId ?? null,
      audit.batchId,
      audit.itemId,
      audit.modelDecision ?? null,
      audit.requestedProjectId ?? null,
      audit.requestedTitle ?? null,
      audit.modelReason ?? null,
      audit.appliedDecision,
      audit.appliedProjectId ?? null,
      audit.validationReason,
    );
  } catch (error) {
    warnAuditFailure('routing decision', error);
  }
}
