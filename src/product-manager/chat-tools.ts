import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ToolCall } from '../core/llm-client.js';
import type { ToolExecutionContext, ToolExecutor, ToolResult } from '../core/tool-executor.js';
import { changedLineText } from '../core/exact-text-edits.js';
import { DocumentExportError, exportDocument, isDocumentExportFormat } from './document-exporter.js';
import { checkDocumentMedia, findDocumentMedia, type DocumentMediaCheck } from './document-media.js';
import { ProductDocumentEditError } from './document-service.js';
import { documentVersionOf, productDocumentListForModel, productDocumentReadForModel } from './document-read.js';
import { DOCUMENT_MATURITIES } from './types.js';
import type { ProductDocumentPublicationService } from './product-document-publications.js';
import type {
  DocumentMaturity,
  EditAuthoredDocumentRequest,
  EditAuthoredDocumentResult,
  ProductDocumentArtifact,
  ProductDocumentService,
  ProductDocumentSummary,
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

async function materializeCanonicalExport(
  artifactId: string,
  filename: string,
  data: Buffer,
): Promise<{ filePath: string; relativePath: string; downloadUrl: string }> {
  const filesRoot = path.resolve(path.join(os.homedir(), '.personal-productivity-tracker', 'files'));
  const safeArtifactId = artifactId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 120) || 'artifact';
  const relativePath = path.join('document-exports', safeArtifactId, filename);
  const filePath = path.resolve(filesRoot, relativePath);
  if (!filePath.startsWith(`${filesRoot}${path.sep}`)) {
    throw new Error('Resolved export path escaped the BotBoy files directory.');
  }

  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${randomUUID()}.tmp`);
  try {
    await fs.writeFile(temporaryPath, data, { flag: 'wx' });
    await fs.rename(temporaryPath, filePath);
  } finally {
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
  }

  const urlPath = relativePath.split(path.sep).map(segment => encodeURIComponent(segment)).join('/');
  return { filePath, relativePath, downloadUrl: `/api/files/${urlPath}` };
}

/** Pictures and diagrams in a saved version (docs/maps/document-media.md): what shows, and what to fix. */
function mediaReceipt(check: DocumentMediaCheck | null): Record<string, unknown> {
  if (!check) return {};
  return {
    media: {
      pictures: check.pictures,
      diagrams: check.diagrams,
      picturesShown: check.shown,
      ...(check.problems.length ? { problems: check.problems.slice(0, 10).map(problem => ({ ...problem, message: brief(problem.message, 400) })) } : {}),
      ...(check.diagramsChecked ? {} : { diagramsNotChecked: 'Google Chrome is not on this Mac, so diagrams were not drawn to check them (and exports keep them as code).' }),
      note: 'Pictures and diagrams show in the reader and are embedded in Word, HTML and PDF exports, so a published copy keeps them.',
    },
  };
}

/** Compact receipt: everything the chat model needs to report honestly, nothing more. */
function saveReceipt(artifact: ProductDocumentArtifact, media: DocumentMediaCheck | null = null) {
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
    ...(artifact.projectId ? { projectId: artifact.projectId, unassigned: false } : { unassigned: true }),
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
    ...mediaReceipt(media),
    documentsUrl: artifact.persisted ? `#/documents/${encodeURIComponent(artifact.artifactId)}` : null,
    apiUrl: artifact.persisted ? `/api/product-documents/${encodeURIComponent(artifact.artifactId)}` : null,
    next: artifact.persisted
      ? `The document is saved. ${media?.problems.length ? 'Fix the pictures or diagrams under media.problems with edit_product_document first. ' : ''}Link the owner to #/documents/${encodeURIComponent(artifact.artifactId)} and mention notable advisory findings honestly.`
      : 'No durable product-document store is configured, so the document was NOT saved. Say so plainly.',
  };
}

/** The id in an artifactId argument, also when the model pastes the reader link (#/documents/<id>). */
function artifactIdArgument(value: unknown): string {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  const link = /(?:^|#|\/)documents\/([^/?#\s]+)\/?$/.exec(trimmed);
  if (!link) return trimmed;
  try {
    return decodeURIComponent(link[1]);
  } catch {
    return link[1];
  }
}

function lineArgument(value: unknown): number | undefined | null {
  if (value === undefined || value === null) return undefined;
  return Number.isInteger(value) && (value as number) >= 1 ? value as number : null;
}

/** What the chat model needs after a targeted edit: what changed and where, and the honest check state. */
function editReceipt(edited: EditAuthoredDocumentResult, chain: readonly ProductDocumentSummary[], media: DocumentMediaCheck | null = null) {
  const { artifact } = edited;
  const findingCounts = artifact.validation.findings.reduce<Record<string, number>>((counts, finding) => {
    counts[finding.severity] = (counts[finding.severity] ?? 0) + 1;
    return counts;
  }, {});
  const version = documentVersionOf(artifact.artifactId, chain);
  const link = `#/documents/${encodeURIComponent(artifact.artifactId)}`;
  return {
    ok: artifact.persisted,
    persisted: artifact.persisted,
    artifactId: artifact.artifactId,
    parentArtifactId: edited.parent.artifactId,
    title: brief(artifact.title),
    ...(artifact.title !== edited.parent.title ? { previousTitle: brief(edited.parent.title) } : {}),
    ...(artifact.projectId ? { projectId: artifact.projectId } : { unassigned: true }),
    version: { number: version.number, of: version.of },
    editsApplied: edited.changes.length,
    changes: edited.changes.map((change) => ({
      edit: change.index,
      line: change.line,
      lineText: changedLineText(artifact.content, change),
    })),
    totalLines: artifact.content.split('\n').length,
    contentChars: artifact.content.length,
    charsChanged: artifact.content.length - edited.parent.contentChars,
    ...(artifact.citations?.length ? { citationCount: artifact.citations.length } : {}),
    ...(edited.citationsAdded.length ? { citationsAdded: edited.citationsAdded } : {}),
    ...(edited.citationsReplaced.length ? { citationsReplaced: edited.citationsReplaced } : {}),
    ...(edited.citationsDropped.length ? { citationsDropped: edited.citationsDropped, citationsDroppedNote: 'The edits removed the last marker of these citations, so they left the document with it.' } : {}),
    ...(edited.markersWithoutCitation.length ? {
      markersWithoutCitation: edited.markersWithoutCitation,
      markersNote: 'These new markers have no citation, so the reader shows them as plain text. Add citations with these ids in another edit, or remove the markers.',
    } : {}),
    validationStatus: artifact.validation.status,
    findingCounts,
    advisoryFindings: artifact.validation.findings.slice(0, 5).map((finding) => ({
      code: finding.code,
      severity: finding.severity,
      message: brief(finding.message),
    })),
    conformance: 'Not run: a targeted edit gets the quick advisory checks only. Full rewrites saved with save_product_document get the review.',
    ...mediaReceipt(media),
    documentsUrl: artifact.persisted ? link : null,
    next: artifact.persisted
      ? `Saved as version ${version.number} of ${version.of}. ${media?.problems.length ? 'Fix the pictures or diagrams under media.problems in another edit. ' : ''}Link the owner to ${link} and say in a sentence what changed. To check a change, read_product_document with startLine and endLine around its line.`
      : 'No durable product-document store is configured, so the edit was NOT saved. Say so plainly.',
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
  publications?: ProductDocumentPublicationService,
  options: { footerText?: () => string } = {},
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

      if (call.function.name === 'publish_product_document_to_sharepoint') {
        const args = parseArguments(call);
        if (!args) return errorResult(call, 'Tool arguments must be one JSON object.');
        if (!publications) return errorResult(call, 'Product-document publication service is unavailable.');
        if (args.ownerRequested !== true) {
          return errorResult(call, 'ownerRequested must be true — stage publication only when the owner asked to share this document.');
        }
        const artifactId = typeof args.artifactId === 'string' ? args.artifactId.trim() : '';
        const projectId = typeof args.projectId === 'string' ? args.projectId.trim() : '';
        const format = args.format === 'md' || args.format === 'docx' ? args.format : null;
        const action = args.action === 'create' || args.action === 'update_existing' ? args.action : null;
        const basePublicationId = typeof args.basePublicationId === 'string' ? args.basePublicationId.trim() : '';
        const title = typeof args.title === 'string' ? args.title.trim() : '';
        if (!artifactId || !projectId || !format || !action) {
          return errorResult(call, 'artifactId, projectId, action (create or update_existing), and format (md or docx) are required.');
        }
        try {
          const staged = publications.stage({
            artifactId,
            projectId,
            action,
            ...(basePublicationId ? { basePublicationId } : {}),
            format,
            title,
            ...(typeof args.serverRelativeUrl === 'string' && args.serverRelativeUrl.trim()
              ? { serverRelativeUrl: args.serverRelativeUrl.trim() }
              : {}),
            ...(typeof args.targetFolder === 'string' && args.targetFolder.trim()
              ? { targetFolder: args.targetFolder.trim() }
              : {}),
            ...(typeof args.siteUrl === 'string' && args.siteUrl.trim()
              ? { siteUrl: args.siteUrl.trim() }
              : {}),
            ...(typeof args.purpose === 'string' && args.purpose.trim()
              ? { purpose: args.purpose.trim().slice(0, 200) }
              : {}),
            ...(args.destination && typeof args.destination === 'object' && (args.destination as any).provider === 'gdrive'
              ? {
                destination: {
                  provider: 'gdrive' as const,
                  accountId: typeof (args.destination as any).account === 'string' ? (args.destination as any).account.trim() : 'default',
                  folderId: typeof (args.destination as any).folderId === 'string' && (args.destination as any).folderId.trim() ? (args.destination as any).folderId.trim() : 'botboy',
                  storedAs: (args.destination as any).storedAs === 'google_doc' ? 'google_doc' as const : 'docx' as const,
                },
              }
              : {}),
          });
          return result(call, {
            ok: true,
            status: staged.publication.status,
            idempotent: staged.idempotent,
            replacesPublicationIds: staged.replacesPublicationIds,
            publicationId: staged.publication.publicationId,
            pendingEditId: staged.pendingEdit.id,
            artifactId,
            projectId,
            action,
            ...(staged.publication.basePublicationId ? { basePublicationId: staged.publication.basePublicationId } : {}),
            format,
            docKey: staged.publication.docKey,
            destination: staged.publication.serverRelativeUrl,
            approveAt: `#/projects/${encodeURIComponent(projectId)}`,
            next: staged.idempotent
              ? `No duplicate was created. Reuse publication ${staged.publication.publicationId}, currently ${staged.publication.status} with owner action ${staged.pendingEdit.status}; claim later effects only from their receipts.`
              : `Publication is staged only as ${action}${staged.replacesPublicationIds.length ? ` and superseded ${staged.replacesPublicationIds.length} obsolete safe attempt${staged.replacesPublicationIds.length === 1 ? '' : 's'}` : ''}. The owner must approve the exact action and path in the project Documents tab; claim upload, verification, versioning, and capture only from later receipts.`,
          });
        } catch (error) {
          return errorResult(call, error instanceof Error ? error.message : 'Could not stage the publication.');
        }
      }

      if (call.function.name === 'export_product_document') {
        const args = parseArguments(call);
        if (!args) return errorResult(call, 'Tool arguments must be one JSON object.');
        if (args.ownerRequested !== true) {
          return errorResult(call, 'ownerRequested must be true — export a document only when the owner asked for a file in this conversation.');
        }
        const artifactId = typeof args.artifactId === 'string' ? args.artifactId.trim() : '';
        if (!artifactId) return errorResult(call, 'artifactId is required: use the ID returned by save_product_document or the Documents page.');
        if (!isDocumentExportFormat(args.format)) {
          return errorResult(call, 'format must be markdown, html, docx, or pdf.');
        }
        const artifact = service.getArtifact(artifactId);
        if (!artifact) {
          return errorResult(call, `Official product-document artifact '${artifactId}' was not found. Do not recreate it from chat memory; resolve the correct artifact ID first.`);
        }

        try {
          const exported = await exportDocument({
            title: artifact.title,
            content: artifact.content,
            format: args.format,
            footerText: options.footerText?.() ?? '',
          });
          const materialized = await materializeCanonicalExport(
            artifact.artifactId,
            exported.filename,
            exported.data,
          );
          return result(call, {
            ok: true,
            exported: true,
            canonicalExport: true,
            source: 'official_product_document',
            artifactId: artifact.artifactId,
            ...(artifact.projectId ? { projectId: artifact.projectId } : { unassigned: true }),
            title: brief(artifact.title),
            format: args.format,
            filename: exported.filename,
            mediaType: exported.mediaType,
            bytes: exported.data.length,
            sha256: createHash('sha256').update(exported.data).digest('hex'),
            ...(exported.media ? {
              media: {
                pictures: exported.media.pictures,
                diagrams: exported.media.diagrams,
                embedded: exported.media.embedded,
                ...(exported.media.problems.length ? { problems: exported.media.problems.slice(0, 10).map(problem => ({ ...problem, message: brief(problem.message, 400) })) } : {}),
              },
            } : {}),
            ...(args.format === 'markdown' && findDocumentMedia(artifact.content).length
              ? { mediaNote: 'A Markdown export keeps picture lines and diagram blocks as text; docx, html and pdf embed them.' }
              : {}),
            ...materialized,
            documentsUrl: `#/documents/${encodeURIComponent(artifact.artifactId)}`,
            next: 'Use filePath verbatim for any upload or attachment tool. This receipt proves only that the canonical file was exported locally; claim a delivery only after the destination tool returns its own successful receipt.',
          });
        } catch (error) {
          return errorResult(
            call,
            error instanceof Error ? error.message : 'Exporting the official document failed.',
            error instanceof DocumentExportError
              ? { exported: false, code: error.code, artifactId, format: args.format }
              : { exported: false, artifactId, format: args.format },
          );
        }
      }

      if (call.function.name === 'read_product_document') {
        const args = parseArguments(call);
        if (!args) return result(call, { ok: false, error: 'Tool arguments must be one JSON object.' }, true);
        const startLine = lineArgument(args.startLine);
        const endLine = lineArgument(args.endLine);
        if (startLine === null || endLine === null) {
          return result(call, { ok: false, error: 'startLine and endLine must be whole numbers, 1 or more.', nextAction: 'Omit them to read from the start.' }, true);
        }
        const artifactId = artifactIdArgument(args.artifactId);
        if (!artifactId) {
          const query = typeof args.query === 'string' ? args.query.trim().slice(0, 200) : '';
          const projectId = typeof args.projectId === 'string' && args.projectId.trim() ? args.projectId.trim().slice(0, 200) : undefined;
          try {
            const summaries = service.listArtifacts(100, projectId ? { projectId } : undefined);
            return result(call, productDocumentListForModel(summaries, (id) => service.getVersionChain(id).length, { query, ...(projectId ? { projectId } : {}) }));
          } catch (error) {
            return result(call, { ok: false, error: error instanceof Error ? error.message : 'Listing documents failed.' }, true);
          }
        }
        const artifact = service.getArtifact(artifactId);
        if (!artifact) {
          return result(call, {
            ok: false,
            code: 'not_found',
            error: `Document version ${artifactId} was not found.`,
            nextAction: 'Call read_product_document without artifactId, with words from the title as query, to find the document and its newest artifactId.',
          }, true);
        }
        return result(call, productDocumentReadForModel(artifact, service.getVersionChain(artifact.artifactId), {
          ...(startLine === undefined ? {} : { startLine }),
          ...(endLine === undefined ? {} : { endLine }),
        }));
      }

      if (call.function.name === 'edit_product_document') {
        const args = parseArguments(call);
        if (!args) return errorResult(call, 'Tool arguments must be one JSON object.');
        if (args.ownerRequested !== true) {
          return errorResult(call, 'ownerRequested must be true — edit a document only when the owner asked for this change in this conversation.');
        }
        try {
          const edited = service.editAuthoredDocument({
            artifactId: artifactIdArgument(args.artifactId),
            edits: args.edits as EditAuthoredDocumentRequest['edits'],
            ...(args.title !== undefined ? { title: args.title as string } : {}),
            ...(args.citations !== undefined ? { citations: args.citations as EditAuthoredDocumentRequest['citations'] } : {}),
          });
          const media = await checkDocumentMedia(edited.artifact.content).catch(() => null);
          return result(call, editReceipt(edited, service.getVersionChain(edited.artifact.artifactId), media));
        } catch (error) {
          if (error instanceof ProductDocumentEditError) {
            return errorResult(call, error.message, { code: error.code, nextAction: error.nextAction, ...error.details });
          }
          return errorResult(call, error instanceof Error ? error.message : 'Editing the document failed.', {
            nextAction: 'Nothing was saved. Read the document again with read_product_document before trying once more.',
          });
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
      if (args.projectId !== undefined && (typeof args.projectId !== 'string' || !args.projectId.trim())) {
        return errorResult(call, 'projectId must be a non-empty exact project ID when provided.');
      }
      if (args.unassigned !== undefined && typeof args.unassigned !== 'boolean') {
        return errorResult(call, 'unassigned must be boolean when provided.');
      }
      if (args.parentArtifactId === undefined) {
        const hasProject = typeof args.projectId === 'string' && Boolean(args.projectId.trim());
        if (hasProject === (args.unassigned === true)) {
          return errorResult(call, 'A new document requires exactly one filing choice: projectId or unassigned=true.');
        }
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
          ...(args.projectId !== undefined ? { projectId: (args.projectId as string).trim() } : {}),
          ...(args.unassigned === true ? { unassigned: true } : {}),
          ...(args.parentArtifactId !== undefined ? { parentArtifactId: (args.parentArtifactId as string).trim() } : {}),
          ...(args.citations !== undefined ? { citations: args.citations as SaveAuthoredDocumentRequest['citations'] } : {}),
        });
        const media = await checkDocumentMedia(artifact.content).catch(() => null);
        return result(call, saveReceipt(artifact, media));
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
