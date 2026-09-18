import { Router, type Request, type Response } from 'express';
import {
  DocumentExportError,
  exportDocument,
  isDocumentExportFormat,
  isPandocInstalled,
  resolveBrewExecutable,
} from '../../product-manager/document-exporter.js';
import {
  ProductDocumentGenerationError,
  ProductDocumentRequestError,
} from '../../product-manager/document-service.js';
import type {
  ContextResolution,
  GlossaryResolution,
  ProductDocumentArtifact,
  SteBundleReadiness,
} from '../../product-manager/types.js';
import {
  resolveLocalPublicationDestinationDefault,
  resolvePublicationDestinationCandidates,
  unavailablePublicationDestinationDefault,
} from '../../product-manager/publication-destination-default.js';
import {
  buildProductDocumentPublicationViewFromService,
} from '../../product-manager/product-document-publication-view.js';
import type { RouterDeps } from './deps.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseArtifactLimit(value: unknown): number | null {
  if (value === undefined) return 25;
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) return null;
  const limit = Number(value);
  return limit >= 1 && limit <= 100 ? limit : null;
}

function validArtifactId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value);
}

function isLoopback(address: string | undefined): boolean {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

function publicReadiness(readiness: SteBundleReadiness) {
  return {
    ready: readiness.ready,
    available: readiness.available,
    approved: readiness.approved,
    diagnostics: readiness.diagnostics,
    standardId: readiness.bundle?.standardId ?? 'ASD-STE100',
    issue: readiness.bundle?.issue ?? 9,
    issueDate: readiness.bundle?.issueDate ?? '2025-01-15',
    sourceSha256: readiness.bundle?.sourceSha256,
    inventory: readiness.bundle?.inventory,
    humanApproval: readiness.bundle?.humanApproval.status ?? 'missing',
  };
}

function publicContext(resolution: ContextResolution) {
  return {
    status: resolution.status,
    overviewAvailable: resolution.overviewAvailable,
    manifest: resolution.manifest,
    diagnostics: resolution.diagnostics,
    totalCharacters: resolution.totalCharacters,
    documents: resolution.documents.map((document) => ({
      role: document.role,
      path: document.path,
      sha256: document.sha256,
      bytes: document.bytes,
      modifiedAt: document.modifiedAt,
      parseStatus: document.parseStatus,
      excerpt: document.content.slice(0, 1_000),
      excerptTruncated: document.content.length > 1_000,
    })),
  };
}

function publicGlossary(resolution: GlossaryResolution) {
  const withoutStandardDump = resolution.entries.filter((entry) =>
    !entry.provenance.every((source) => source.sourceType === 'ste_dictionary'),
  );
  return {
    entries: withoutStandardDump.slice(0, 500),
    approvedTerms: resolution.approvedTerms
      .filter((entry) => !entry.provenance.every((source) => source.sourceType === 'ste_dictionary'))
      .slice(0, 500),
    candidateTerms: resolution.candidateTerms.slice(0, 500),
    conflicts: resolution.conflicts.slice(0, 200),
    diagnostics: resolution.diagnostics.slice(0, 200),
    counts: {
      entries: withoutStandardDump.length,
      approved: resolution.approvedTerms.length,
      candidates: resolution.candidateTerms.length,
      conflicts: resolution.conflicts.length,
    },
  };
}

function publicArtifact(artifact: ProductDocumentArtifact) {
  return {
    ...artifact,
    glossary: publicGlossary(artifact.glossary),
  };
}

function handleError(res: Response, error: unknown): Response {
  if (error instanceof ProductDocumentRequestError) {
    return res.status(400).json({ error: error.message, issues: error.issues });
  }
  if (error instanceof ProductDocumentGenerationError) {
    return res.status(502).json({ error: error.message, code: error.code });
  }
  if (error instanceof Error && error.message.startsWith('[product-manager] Unknown profile:')) {
    return res.status(400).json({ error: error.message });
  }
  console.error('[product-documents] Request failed:', error instanceof Error ? error.message : String(error));
  return res.status(500).json({ error: 'Product-document request failed.' });
}

export function createProductDocumentsRouter(deps: RouterDeps): Router {
  const router = Router();
  const publicationView = (artifact: ProductDocumentArtifact) => {
    const publications = deps.productDocumentPublications;
    if (!publications) return null;
    const project = artifact.projectId && deps.db
      ? deps.db.prepare('SELECT status FROM projects WHERE id = ?').get(artifact.projectId) as { status: string } | undefined
      : undefined;
    return buildProductDocumentPublicationViewFromService({
      artifactId: artifact.artifactId,
      ...(artifact.projectId ? { projectId: artifact.projectId } : {}),
      projectStatus: artifact.projectId && deps.db ? project?.status ?? 'missing' : null,
    }, publications);
  };

  const publicationDestinationDefault = () => deps.db
    ? resolveLocalPublicationDestinationDefault(deps.db)
    : unavailablePublicationDestinationDefault('Local publication evidence is unavailable.');

  router.get('/product-documents', (req: Request, res: Response) => {
    res.set('Cache-Control', 'no-store');
    const service = deps.productDocumentService;
    if (!service) return res.status(503).json({ error: 'Product-document service is not available.' });
    const limit = parseArtifactLimit(req.query.limit);
    if (limit === null) {
      return res.status(400).json({ error: 'limit must be an integer from 1 through 100.' });
    }
    try {
      const projectId = typeof req.query.projectId === 'string' ? req.query.projectId.trim() : undefined;
      const unassigned = req.query.unassigned === 'true';
      if (projectId === '' || (projectId !== undefined && unassigned)) {
        return res.status(400).json({ error: 'Choose projectId or unassigned=true, not both.' });
      }
      return res.json({
        documents: service.listArtifacts(limit, {
          ...(projectId === undefined ? {} : { projectId }),
          ...(unassigned ? { unassigned: true } : {}),
        }),
      });
    } catch (error) {
      return handleError(res, error);
    }
  });

  router.get('/product-documents/profiles', (_req: Request, res: Response) => {
    const service = deps.productDocumentService;
    if (!service) return res.status(503).json({ error: 'Product-document service is not available.' });
    try {
      return res.json({
        profiles: service.listProfiles(),
        overlays: service.listOverlays(),
        ste: publicReadiness(service.getSteBundleReadiness()),
        controls: { emailDraftOnly: true, emailSendEndpointAvailable: false },
      });
    } catch (error) {
      return handleError(res, error);
    }
  });

  router.get('/product-documents/context-config', (_req: Request, res: Response) => {
    if (!deps.writingConfigStore) return res.status(503).json({ error: 'Writing-context configuration is not available.' });
    try {
      return res.json({ config: deps.writingConfigStore.get() });
    } catch (error) {
      return handleError(res, error);
    }
  });

  router.put('/product-documents/context-config', (req: Request, res: Response) => {
    if (!deps.writingConfigStore) return res.status(503).json({ error: 'Writing-context configuration is not available.' });
    const result = deps.writingConfigStore.set(req.body);
    if (!result.ok) return res.status(400).json({ error: 'Writing-context configuration is invalid.', issues: result.issues });
    return res.json({ config: result.config });
  });

  router.post('/product-documents/context/preview', async (req: Request, res: Response) => {
    const service = deps.productDocumentService;
    if (!service) return res.status(503).json({ error: 'Product-document service is not available.' });
    if (req.body !== undefined && !isRecord(req.body)) return res.status(400).json({ error: 'Body must be a JSON object.' });
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (body.allowAssumptionDraft !== undefined && typeof body.allowAssumptionDraft !== 'boolean') {
      return res.status(400).json({ error: 'allowAssumptionDraft must be boolean.' });
    }
    if (body.contextOverride !== undefined && !isRecord(body.contextOverride)) {
      return res.status(400).json({ error: 'contextOverride must be an object.' });
    }
    try {
      const context = await service.previewContext(
        body.contextOverride as Parameters<typeof service.previewContext>[0],
        body.allowAssumptionDraft as boolean | undefined,
      );
      return res.json({ context: publicContext(context) });
    } catch (error) {
      return handleError(res, error);
    }
  });

  router.post('/product-documents/glossary/preview', async (req: Request, res: Response) => {
    const service = deps.productDocumentService;
    if (!service) return res.status(503).json({ error: 'Product-document service is not available.' });
    if (!isRecord(req.body) || typeof req.body.prompt !== 'string') {
      return res.status(400).json({ error: 'Body requires a prompt string.' });
    }
    try {
      const glossary = await service.previewGlossary({
        prompt: req.body.prompt,
        ...(isRecord(req.body.contextOverride) ? { contextOverride: req.body.contextOverride } : {}),
        ...(typeof req.body.documentText === 'string' ? { documentText: req.body.documentText } : {}),
      });
      return res.json({ glossary: publicGlossary(glossary) });
    } catch (error) {
      return handleError(res, error);
    }
  });

  router.post('/product-documents/validate', async (req: Request, res: Response) => {
    const service = deps.productDocumentService;
    if (!service) return res.status(503).json({ error: 'Product-document service is not available.' });
    if (!isRecord(req.body)) return res.status(400).json({ error: 'Body must be a JSON object.' });
    try {
      const validation = await service.validate(req.body as unknown as Parameters<typeof service.validate>[0]);
      return res.json({ validation });
    } catch (error) {
      return handleError(res, error);
    }
  });

  router.post('/product-documents/generate', async (req: Request, res: Response) => {
    const service = deps.productDocumentService;
    if (!service) return res.status(503).json({ error: 'Product-document service is not available.' });
    if (!isRecord(req.body)) return res.status(400).json({ error: 'Body must be a JSON object.' });
    try {
      // discoveredEvidence carries server-observed tool results and its
      // "discovery:" provenance labels are trusted downstream, and
      // parentArtifactId asserts version lineage, so both are accepted only
      // from internal callers (the chat/agent loops) — never from HTTP bodies.
      const { discoveredEvidence: _rejectedDiscovery, parentArtifactId: _rejectedParent, parentVersion: _rejectedParentVersion, ...publicBody } = req.body as Record<string, unknown>;
      const artifact = await service.generate(publicBody as unknown as Parameters<typeof service.generate>[0]);
      return res.status(artifact.state === 'blocked_for_context' ? 409 : 200).json({ artifact: publicArtifact(artifact) });
    } catch (error) {
      return handleError(res, error);
    }
  });

  router.put('/product-documents/:artifactId/project', (req: Request, res: Response) => {
    const service = deps.productDocumentService;
    if (!service) return res.status(503).json({ error: 'Product-document service is not available.' });
    const artifactId = req.params.artifactId;
    if (!validArtifactId(artifactId)) return res.status(400).json({ error: 'Invalid artifact id.' });
    if (!isRecord(req.body)) return res.status(400).json({ error: 'Body must be a JSON object.' });
    const projectId = typeof req.body.projectId === 'string' ? req.body.projectId.trim() : undefined;
    const unassigned = req.body.unassigned === true || req.body.projectId === null;
    if (projectId === '' || (projectId !== undefined && unassigned)) {
      return res.status(400).json({ error: 'Choose a non-empty projectId or unassigned=true, not both.' });
    }
    if (projectId === undefined && !unassigned) {
      return res.status(400).json({ error: 'Body requires projectId or unassigned=true.' });
    }
    try {
      if (deps.productDocumentPublications?.hasForChain(artifactId)) {
        return res.status(409).json({
          error: 'This document chain has publication history and cannot be refiled. Supersede or resolve its publication records first.',
        });
      }
      const assignment = service.assignArtifactProject(artifactId, projectId);
      return res.json({ assignment });
    } catch (error) {
      return handleError(res, error);
    }
  });

  router.post('/product-documents/:artifactId/revision', async (req: Request, res: Response) => {
    const service = deps.productDocumentService;
    if (!service) return res.status(503).json({ error: 'Product-document service is not available.' });
    const artifactId = req.params.artifactId;
    if (!validArtifactId(artifactId)) return res.status(400).json({ error: 'Invalid artifact id.' });
    if (!isRecord(req.body) || typeof req.body.content !== 'string') {
      return res.status(400).json({ error: 'Body requires a content string.' });
    }
    try {
      const artifact = await service.ownerRevision({
        parentArtifactId: artifactId,
        content: req.body.content,
        ...(typeof req.body.title === 'string' && req.body.title.trim() ? { title: req.body.title } : {}),
      });
      return res.status(201).json({ artifact: publicArtifact(artifact) });
    } catch (error) {
      return handleError(res, error);
    }
  });

  router.post('/product-documents/email/draft', async (req: Request, res: Response) => {
    const service = deps.productDocumentService;
    if (!service) return res.status(503).json({ error: 'Product-document service is not available.' });
    if (!isRecord(req.body)) return res.status(400).json({ error: 'Body must be a JSON object.' });
    if (req.body.profileId !== undefined && req.body.profileId !== 'communication/email.v1') {
      return res.status(400).json({ error: 'The email draft endpoint only supports communication/email.v1.' });
    }
    try {
      const { discoveredEvidence: _rejectedDiscovery, parentArtifactId: _rejectedParent, parentVersion: _rejectedParentVersion, ...publicBody } = req.body as Record<string, unknown>;
      const artifact = await service.generate({
        ...(publicBody as unknown as Parameters<typeof service.generate>[0]),
        profileId: 'communication/email.v1',
      });
      return res.status(artifact.state === 'blocked_for_context' ? 409 : 200).json({ artifact: publicArtifact(artifact) });
    } catch (error) {
      return handleError(res, error);
    }
  });

  router.get('/product-documents/:artifactId/export', async (req: Request, res: Response) => {
    res.set('Cache-Control', 'no-store');
    const service = deps.productDocumentService;
    if (!service) return res.status(503).json({ error: 'Product-document service is not available.' });
    const artifactId = req.params.artifactId;
    if (!validArtifactId(artifactId)) return res.status(400).json({ error: 'artifactId is invalid.' });
    const format = req.query.format ?? 'markdown';
    if (!isDocumentExportFormat(format)) {
      return res.status(400).json({ error: 'format must be markdown, html, docx, or pdf.' });
    }
    try {
      const artifact = service.getArtifact(artifactId);
      if (!artifact) return res.status(404).json({ error: 'Product-document artifact not found.' });
      const exported = await exportDocument({ title: artifact.title, content: artifact.content, format });
      res.set('Content-Type', exported.mediaType);
      res.set('Content-Disposition', `attachment; filename="${exported.filename}"`);
      return res.send(exported.data);
    } catch (error) {
      if (error instanceof DocumentExportError) {
        // 424 Failed Dependency for the actionable case: the UI offers the
        // guided pandoc install instead of a dead-end error line.
        return res
          .status(error.code === 'pandoc_missing' ? 424 : 502)
          .json({ error: error.message, code: error.code });
      }
      return handleError(res, error);
    }
  });

  /**
   * Guided pandoc install (owner request 2026-08-28): the first blocked
   * Word/PDF/HTML download offers a one-click install that runs inside
   * BotBoy's chat terminal dock — streaming output, any interactive prompt
   * typed by the USER into the PTY (never through the model or this API).
   * Safety model, mirroring the MCP setup terminals: the command is FIXED
   * server-side (the browser sends nothing but the click), the endpoint is
   * loopback-only like every terminal control path, and the session runs on
   * the same chat-terminal engine, so the dock UI, SSE stream, stop button,
   * and the auto-open-panel behavior are all inherited.
   */
  router.post('/product-documents/export-tools/install', async (req: Request, res: Response) => {
    const chatTerminal = deps.chatTerminal;
    if (!chatTerminal) return res.status(503).json({ error: 'Terminal sessions are unavailable.' });
    const isLoopback = (address: string | undefined) =>
      address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
    if (!isLoopback(req.socket.remoteAddress) || !isLoopback(req.socket.localAddress)) {
      return res.status(403).json({ error: 'Terminal control is local-only.' });
    }
    if (await isPandocInstalled()) {
      // Already there (installed outside BotBoy, or a stale card) — no
      // session needed; the UI just retries the download.
      return res.json({ alreadyInstalled: true });
    }
    const running = chatTerminal.current();
    if (running && running.status === 'running') {
      return res.status(409).json({
        error: 'Another terminal session is already running in BotBoy — finish it first.',
        code: 'terminal_busy',
      });
    }
    const brew = await resolveBrewExecutable();
    if (!brew) {
      return res.status(409).json({
        error: 'Homebrew is not installed on this Mac. Install it from https://brew.sh, then run: brew install pandoc',
        code: 'homebrew_missing',
      });
    }
    try {
      const session = chatTerminal.open({
        command: `"${brew}" install pandoc`,
        title: 'Install pandoc (document downloads)',
        // Bottle installs take ~a minute; source builds on no-bottle setups
        // can take much longer (same headroom as the chat terminal default).
        timeoutMs: 30 * 60_000,
      });
      return res.status(201).json({ session: { id: session.id, status: session.status, title: session.title } });
    } catch (error) {
      return res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  /**
   * Deterministic artifact-reader publication staging. This creates only the
   * local approval ledger; approval observation and SharePoint writes remain
   * on the existing documents routes.
   */
  router.get('/product-documents/:artifactId/publication-destination-default', async (req: Request, res: Response) => {
    res.set('Cache-Control', 'no-store');
    if (!isLoopback(req.socket.remoteAddress) || !isLoopback(req.socket.localAddress)) {
      return res.status(403).json({ error: 'Publication destination resolution is local-only.' });
    }
    const artifactId = req.params.artifactId;
    if (!validArtifactId(artifactId)) return res.status(400).json({ error: 'artifactId is invalid.' });
    if (!deps.productDocumentService?.getArtifact(artifactId)) {
      return res.status(404).json({ error: 'Product-document artifact not found.' });
    }
    const local = publicationDestinationDefault();
    if (local.status !== 'unresolved') return res.json({ publicationDestinationDefault: local });
    if (!deps.mcpManager) {
      return res.json({ publicationDestinationDefault: unavailablePublicationDestinationDefault('SharePoint connection is unavailable.') });
    }
    try {
      const profile = await deps.mcpManager.getProfile('sharepoint');
      if (!profile?.enabled || profile.state !== 'running' || profile.compatibilityState !== 'compatible') {
        return res.json({ publicationDestinationDefault: unavailablePublicationDestinationDefault(`SharePoint connection is ${profile?.state || 'unavailable'}.`) });
      }
      const result = await deps.mcpManager.callTool('sharepoint', 'sharepoint_list_files', {
        libraryName: 'Documents', top: 50, includeWebUrls: true,
      }, { source: 'api', timeoutMs: 120_000 });
      if (result.isError) {
        return res.json({ publicationDestinationDefault: unavailablePublicationDestinationDefault(result.text.slice(0, 300) || 'SharePoint listing failed.') });
      }
      const payload = JSON.parse(result.text) as { files?: Array<Record<string, unknown>> };
      const resolved = resolvePublicationDestinationCandidates(
        (payload.files ?? []).map(file => file.Path), 'sharepoint_list_files',
      );
      return res.json({ publicationDestinationDefault: resolved });
    } catch (error) {
      return res.json({ publicationDestinationDefault: unavailablePublicationDestinationDefault(error instanceof Error ? error.message : String(error)) });
    }
  });

  router.post('/product-documents/:artifactId/publications', (req: Request, res: Response) => {
    const service = deps.productDocumentService;
    const publications = deps.productDocumentPublications;
    if (!service || !publications) {
      return res.status(503).json({ error: 'Product-document publication service is not available.' });
    }
    if (!isLoopback(req.socket.remoteAddress) || !isLoopback(req.socket.localAddress)) {
      return res.status(403).json({ error: 'Document publication staging is local-only.' });
    }
    const artifactId = req.params.artifactId;
    if (!validArtifactId(artifactId)) return res.status(400).json({ error: 'artifactId is invalid.' });
    if (!isRecord(req.body)) return res.status(400).json({ error: 'Body must be a JSON object.' });
    if (req.body.ownerRequested !== true) {
      return res.status(400).json({ error: 'ownerRequested must be true for the explicit reader publication action.' });
    }
    const action = req.body.action;
    if (action !== 'create' && action !== 'update_existing') {
      return res.status(400).json({ error: 'action must be create or update_existing.' });
    }
    const artifact = service.getArtifact(artifactId);
    if (!artifact) return res.status(404).json({ error: 'Product-document artifact not found.' });
    if (!artifact.projectId) {
      return res.status(409).json({ error: 'Assign this document chain to a project before publishing it.' });
    }

    try {
      const state = publicationView(artifact);
      if (state?.phase === 'blocked_unassigned') {
        return res.status(409).json({ error: state.blockReason ?? 'The owning project cannot start a publication.' });
      }
      let staged;
      if (action === 'update_existing') {
        const basePublicationId = typeof req.body.basePublicationId === 'string'
          ? req.body.basePublicationId.trim()
          : '';
        if (!basePublicationId) return res.status(400).json({ error: 'basePublicationId is required for update_existing.' });
        if (req.body.format !== undefined || req.body.targetFolder !== undefined
          || req.body.serverRelativeUrl !== undefined || req.body.siteUrl !== undefined) {
          return res.status(400).json({ error: 'update_existing inherits format and destination; do not provide overrides.' });
        }
        const base = publications.get(basePublicationId);
        if (!base) return res.status(404).json({ error: 'Base publication not found.' });
        staged = publications.stage({
          artifactId,
          projectId: artifact.projectId,
          action,
          basePublicationId,
          format: base.format,
          title: artifact.title,
          purpose: 'Prepared directly from the generated-document reader.',
        });
      } else {
        const format = req.body.format;
        if (format !== 'md' && format !== 'docx') {
          return res.status(400).json({ error: 'format must be md or docx for a new copy.' });
        }
        const targetFolder = typeof req.body.targetFolder === 'string' ? req.body.targetFolder.trim() : '';
        const serverRelativeUrl = typeof req.body.serverRelativeUrl === 'string' ? req.body.serverRelativeUrl.trim() : '';
        const siteUrl = typeof req.body.siteUrl === 'string' ? req.body.siteUrl.trim() : '';
        if (Boolean(targetFolder) === Boolean(serverRelativeUrl)) {
          return res.status(400).json({ error: 'Provide exactly one of targetFolder or serverRelativeUrl.' });
        }
        staged = publications.stage({
          artifactId,
          projectId: artifact.projectId,
          action,
          format,
          title: artifact.title,
          ...(targetFolder ? { targetFolder } : {}),
          ...(serverRelativeUrl ? { serverRelativeUrl } : {}),
          ...(siteUrl ? { siteUrl } : {}),
          purpose: 'Prepared directly from the generated-document reader.',
        });
      }
      const publicationState = publicationView(artifact);
      return res.status(staged.idempotent ? 200 : 201).json({
        result: {
          publicationId: staged.publication.publicationId,
          pendingEditId: staged.pendingEdit.id,
          status: staged.publication.status,
          action: staged.publication.action,
          basePublicationId: staged.publication.basePublicationId,
          format: staged.publication.format,
          docKey: staged.publication.docKey,
          serverRelativeUrl: staged.publication.serverRelativeUrl,
          idempotent: staged.idempotent,
          replacesPublicationIds: staged.replacesPublicationIds,
        },
        publicationState,
      });
    } catch (error) {
      return res.status(409).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.delete('/product-documents/:artifactId', (req: Request, res: Response) => {
    const service = deps.productDocumentService;
    if (!service) return res.status(503).json({ error: 'Product-document service is not available.' });
    const artifactId = req.params.artifactId;
    if (!validArtifactId(artifactId)) return res.status(400).json({ error: 'artifactId is invalid.' });
    try {
      if (deps.productDocumentPublications?.listByArtifact(artifactId).length) {
        return res.status(409).json({ error: 'Published artifact versions cannot be deleted; their publication receipt must remain auditable.' });
      }
      const removed = service.deleteArtifact(artifactId);
      if (!removed) return res.status(404).json({ error: 'Product-document artifact not found.' });
      return res.status(204).end();
    } catch (error) {
      return handleError(res, error);
    }
  });

  router.get('/product-documents/:artifactId', (req: Request, res: Response) => {
    res.set('Cache-Control', 'no-store');
    const service = deps.productDocumentService;
    if (!service) return res.status(503).json({ error: 'Product-document service is not available.' });
    const artifactId = req.params.artifactId;
    if (!validArtifactId(artifactId)) {
      return res.status(400).json({ error: 'artifactId is invalid.' });
    }
    try {
      const artifact = service.getArtifact(artifactId);
      if (!artifact) return res.status(404).json({ error: 'Product-document artifact not found.' });
      const chainPublications = deps.productDocumentPublications?.listByChain(artifactId) ?? [];
      return res.json({
        artifact: publicArtifact(artifact),
        publications: chainPublications,
        publicationState: publicationView(artifact),
        publicationDestinationDefault: publicationDestinationDefault(),
      });
    } catch (error) {
      return handleError(res, error);
    }
  });

  return router;
}
