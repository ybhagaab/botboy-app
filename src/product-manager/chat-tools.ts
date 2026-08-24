import type { ToolCall } from '../core/llm-client.js';
import type { ToolExecutionContext, ToolExecutor, ToolResult } from '../core/tool-executor.js';
import { DOCUMENT_MATURITIES } from './types.js';
import type {
  DocumentMaturity,
  ProductDocumentArtifact,
  ProductDocumentService,
  SaveAuthoredDocumentRequest,
  SteEnforcementMode,
} from './types.js';

const STE_MODES = new Set<SteEnforcementMode>([
  'off',
  'advisory',
  'enforced_sections',
  'enforced_full',
]);
const DOCUMENT_MATURITY_SET = new Set<DocumentMaturity>(DOCUMENT_MATURITIES);
const MAX_TOOL_RESULT_CHARS = 40_000;
const MAX_RECEIPT_TEXT_CHARS = 500;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function brief(value: string, maximum = MAX_RECEIPT_TEXT_CHARS): string {
  return value.length <= maximum ? value : `${value.slice(0, maximum)}…`;
}

function result(call: ToolCall, content: unknown, isError = false): ToolResult {
  const serialized = typeof content === 'string' ? content : JSON.stringify(content, null, 2);
  return {
    toolCallId: call.id,
    content: serialized.length <= MAX_TOOL_RESULT_CHARS
      ? serialized
      : `${serialized.slice(0, MAX_TOOL_RESULT_CHARS)}…`,
    isError,
  };
}

function errorResult(call: ToolCall, message: string, details?: Record<string, unknown>): ToolResult {
  return result(call, { ok: false, persisted: false, error: message, ...details }, true);
}

function parseArguments(call: ToolCall): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(call.function.arguments || '{}') as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Compact receipt: everything the chat model needs to report honestly, nothing more. */
function saveReceipt(artifact: ProductDocumentArtifact) {
  const findingCounts = artifact.validation.findings.reduce<Record<string, number>>((counts, finding) => {
    counts[finding.severity] = (counts[finding.severity] ?? 0) + 1;
    return counts;
  }, {});
  const advisoryFindings = artifact.validation.findings
    .slice(0, 10)
    .map((finding) => ({
      code: finding.code,
      severity: finding.severity,
      message: brief(finding.message),
      ...(finding.location ? { location: finding.location } : {}),
    }));
  const review = artifact.conformanceReview;
  return {
    ok: artifact.persisted,
    persisted: artifact.persisted,
    artifactId: artifact.artifactId,
    title: brief(artifact.title),
    state: artifact.state,
    maturity: artifact.maturity,
    profileId: artifact.profileId,
    contentChars: artifact.content.length,
    validationStatus: artifact.validation.status,
    findingCounts,
    advisoryFindings,
    ...(artifact.citations?.length ? { citationCount: artifact.citations.length } : {}),
    ...(review ? {
      conformance: {
        status: review.status,
        correctionApplied: review.correctionApplied,
        ...(review.summary ? { summary: brief(review.summary) } : {}),
        findings: review.findings.slice(0, 8).map((finding) => ({
          aspect: finding.aspect,
          severity: finding.severity,
          message: brief(finding.message),
        })),
      },
    } : {}),
    ...(artifact.parentArtifactId ? { parentArtifactId: artifact.parentArtifactId } : {}),
    documentsUrl: artifact.persisted ? `#/documents/${encodeURIComponent(artifact.artifactId)}` : null,
    apiUrl: artifact.persisted ? `/api/product-documents/${encodeURIComponent(artifact.artifactId)}` : null,
    next: artifact.persisted
      ? `The document is saved. Link the owner to #/documents/${encodeURIComponent(artifact.artifactId)} and mention notable advisory findings honestly.`
      : 'No durable product-document store is configured, so the document was NOT saved. Say so plainly.',
  };
}

/**
 * Add the native `save_product_document` operation to the normal chat
 * executor.
 *
 * The chat model authors the complete Markdown itself and this tool persists
 * it through ProductDocumentService.saveAuthoredDocument as an immutable
 * versioned artifact. Validation (profile structure + STE language checks)
 * runs advisory-only: findings land on the artifact record and in the receipt
 * but never block the save. This replaced the gated generate_product_document
 * orchestration, which looped owners through confirmation questions without
 * delivering documents (post-mortem 2026-08-20).
 */
export function withProductDocumentChatTools(
  base: ToolExecutor,
  service: ProductDocumentService,
): ToolExecutor {
  return {
    async executeTool(call: ToolCall, context?: ToolExecutionContext): Promise<ToolResult> {
      if (call.function.name === 'get_document_writing_guide') {
        const args = parseArguments(call) ?? {};
        try {
          const guide = service.getWritingGuide(
            typeof args.profileId === 'string' ? args.profileId : undefined,
            typeof args.maturity === 'string' && DOCUMENT_MATURITY_SET.has(args.maturity as DocumentMaturity)
              ? args.maturity as DocumentMaturity
              : undefined,
          );
          return result(call, { ok: true, ...guide });
        } catch (error) {
          return errorResult(call, error instanceof Error ? error.message : 'Loading the writing guide failed.');
        }
      }

      if (call.function.name !== 'save_product_document') {
        return base.executeTool(call, context);
      }

      const args = parseArguments(call);
      if (!args) return errorResult(call, 'Tool arguments must be one JSON object.');
      if (args.ownerRequested !== true) {
        return errorResult(call, 'ownerRequested must be true — save a document only when the owner asked for one in this conversation.');
      }
      if (typeof args.title !== 'string' || !args.title.trim()) {
        return errorResult(call, 'title is required: a short human-readable document title.');
      }
      if (typeof args.content !== 'string' || !args.content.trim()) {
        return errorResult(call, 'content is required: the complete Markdown document you authored. Write the full document, then save it.');
      }
      if (args.maturity !== undefined && (typeof args.maturity !== 'string'
        || !DOCUMENT_MATURITY_SET.has(args.maturity as DocumentMaturity))) {
        return errorResult(call, 'maturity must be exploratory, working, alignment, or publication.');
      }
      if (args.steMode !== undefined && (typeof args.steMode !== 'string' || !STE_MODES.has(args.steMode as SteEnforcementMode))) {
        return errorResult(call, 'steMode must be off, advisory, enforced_sections, or enforced_full.');
      }
      if (args.profileId !== undefined && (typeof args.profileId !== 'string' || !args.profileId.trim())) {
        return errorResult(call, 'profileId must be a non-empty string when provided (default: business_document/adaptive.v1).');
      }
      if (args.parentArtifactId !== undefined && (typeof args.parentArtifactId !== 'string' || !args.parentArtifactId.trim())) {
        return errorResult(call, 'parentArtifactId must be a non-empty artifact ID when provided.');
      }
      if (args.citations !== undefined && !Array.isArray(args.citations)) {
        return errorResult(call, 'citations must be an array of {id, label, source?, date?, quote?, workItemId?, url?} matching inline [cN] markers.');
      }

      try {
        const artifact = await service.saveAuthoredDocument({
          title: args.title.trim(),
          content: args.content,
          ...(args.maturity !== undefined ? { maturity: args.maturity as DocumentMaturity } : {}),
          ...(args.steMode !== undefined ? { steMode: args.steMode as SteEnforcementMode } : {}),
          ...(args.profileId !== undefined ? { profileId: (args.profileId as string).trim() } : {}),
          ...(args.parentArtifactId !== undefined ? { parentArtifactId: (args.parentArtifactId as string).trim() } : {}),
          ...(args.citations !== undefined ? { citations: args.citations as SaveAuthoredDocumentRequest['citations'] } : {}),
        });
        return result(call, saveReceipt(artifact));
      } catch (error) {
        const details = error as { issues?: unknown };
        return errorResult(
          call,
          error instanceof Error ? error.message : 'Saving the document failed.',
          Array.isArray(details?.issues) ? { issues: details.issues.slice(0, 50) } : undefined,
        );
      }
    },
  };
}
