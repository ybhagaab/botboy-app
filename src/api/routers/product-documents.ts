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

  router.get('/product-documents', (req: Request, res: Response) => {
    res.set('Cache-Control', 'no-store');
    const service = deps.productDocumentService;
    if (!service) return res.status(503).json({ error: 'Product-document service is not available.' });
    const limit = parseArtifactLimit(req.query.limit);
    if (limit === null) {
      return res.status(400).json({ error: 'limit must be an integer from 1 through 100.' });
    }
    try {
      return res.json({ documents: service.listArtifacts(limit) });
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

  router.delete('/product-documents/:artifactId', (req: Request, res: Response) => {
    const service = deps.productDocumentService;
    if (!service) return res.status(503).json({ error: 'Product-document service is not available.' });
    const artifactId = req.params.artifactId;
    if (!validArtifactId(artifactId)) return res.status(400).json({ error: 'artifactId is invalid.' });
    try {
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
      return res.json({ artifact: publicArtifact(artifact) });
    } catch (error) {
      return handleError(res, error);
    }
  });

  return router;
}
