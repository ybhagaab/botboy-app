import { randomUUID } from 'node:crypto';
import { Router, type NextFunction, type Request, type Response } from 'express';
import {
  ANALYTICS_IMPORT_MAX_BYTES,
  AnalyticsImportInboxError,
  type AnalyticsImportDetailEnvelope,
} from '../../core/analytics-import-inbox.js';
import { paramStr, type RouterDeps } from './deps.js';
import { requireLocalOwnerRequest, requireLocalOwnerUiRequest } from './local-owner.js';

function queryString(value: unknown, name: string): string {
  if (typeof value !== 'string') {
    throw new AnalyticsImportInboxError('invalid_input', `${name} must be provided once as text.`);
  }
  return value;
}

function listLimit(value: unknown): number {
  if (value === undefined) return 25;
  if (typeof value !== 'string' || !/^\d+$/.test(value)) {
    throw new AnalyticsImportInboxError('invalid_input', 'limit must be an integer from 1 to 100.');
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) {
    throw new AnalyticsImportInboxError('invalid_input', 'limit must be an integer from 1 to 100.');
  }
  return parsed;
}

function sendError(res: Response, error: unknown): Response {
  if (error instanceof AnalyticsImportInboxError) {
    const status = error.code === 'not_found'
      ? 404
      : error.code === 'conflict' || error.code === 'integrity_failed'
        ? 409
        : error.code === 'too_large'
          ? 413
          : error.code === 'unsupported_type'
            ? 415
            : error.code === 'unavailable'
              ? 503
              : error.code === 'aborted'
                ? 409
                : 400;
    return res.status(status).json({
      error: error.message,
      code: error.code,
      ...(error.nextAction ? { nextAction: error.nextAction } : {}),
    });
  }
  console.error('[AnalyticsImportInbox] request failed with an unexpected error');
  return res.status(500).json({
    error: 'Data Room import request failed.',
    code: 'unavailable',
    nextAction: 'Retry after BotBoy is ready.',
  });
}

function operationController(
  req: Request,
  res: Response,
  deps: RouterDeps,
  id: string,
  kind: string,
): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const abort = (): void => {
    if (!controller.signal.aborted) controller.abort(new Error('Data Room import request was interrupted.'));
  };
  const close = (): void => {
    if (!res.writableEnded) abort();
  };
  let unregister: (() => void) | undefined;
  try {
    unregister = deps.shutdown?.registerWork({ id, kind, abort });
  } catch {
    throw new AnalyticsImportInboxError(
      'unavailable',
      'Data Room import work could not be registered.',
      'Retry after the current operation or process shutdown settles.',
    );
  }
  req.once('aborted', abort);
  res.once('close', close);
  return {
    signal: controller.signal,
    cleanup: () => {
      req.removeListener('aborted', abort);
      res.removeListener('close', close);
      unregister?.();
    },
  };
}

export function createAnalyticsImportInboxRouter(deps: RouterDeps): Router {
  const router = Router();

  const withReview = (result: AnalyticsImportDetailEnvelope): AnalyticsImportDetailEnvelope & {
    importItem: AnalyticsImportDetailEnvelope['importItem'] & { semanticReview?: unknown; semanticDisclosure?: unknown };
  } => {
    const semanticReview = deps.analyticsImportSemantic?.getReview(result.importItem.id) ?? undefined;
    const semanticDisclosure = deps.analyticsImportSemantic?.getDisclosure();
    return {
      ...result,
      importItem: {
        ...result.importItem,
        ...(semanticReview ? { semanticReview } : {}),
        ...(semanticDisclosure ? { semanticDisclosure } : {}),
      },
    };
  };

  const requireOwnerBody = (req: Request, res: Response, operation: string): boolean => {
    if (req.body?.ownerRequested === true) return true;
    res.status(400).json({ error: `ownerRequested must be true for ${operation}.`, code: 'invalid_input' });
    return false;
  };

  router.use('/analytics/data-room/imports', (req: Request, res: Response, next: NextFunction) => {
    res.set('Cache-Control', 'no-store');
    if (!requireLocalOwnerRequest(req, res, 'Data Room import request')) return;
    return next();
  });

  router.get('/analytics/data-room/imports', (req: Request, res: Response) => {
    const service = deps.analyticsImportInbox;
    if (!service) return res.status(503).json({ error: 'Data Room Import Inbox is unavailable.' });
    try {
      return res.json(service.list({ limit: listLimit(req.query.limit) }));
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.post('/analytics/data-room/imports/upload', async (req: Request, res: Response) => {
    const service = deps.analyticsImportInbox;
    if (!service) return res.status(503).json({ error: 'Data Room Import Inbox is unavailable.' });
    if (deps.shutdown?.isShuttingDown()) {
      return res.status(503).json({
        error: 'BotBoy is shutting down; workbook intake did not start.',
        code: 'unavailable',
        nextAction: 'Retry after BotBoy restarts.',
      });
    }
    if (req.get('x-botboy-owner-requested') !== 'true') {
      return res.status(400).json({
        error: 'X-BotBoy-Owner-Requested must be true for workbook intake.',
        code: 'invalid_input',
      });
    }
    const declaredLength = req.get('content-length');
    if (declaredLength !== undefined) {
      if (!/^\d+$/.test(declaredLength)) {
        return res.status(400).json({ error: 'Content-Length is malformed.', code: 'invalid_input' });
      }
      if (Number(declaredLength) > ANALYTICS_IMPORT_MAX_BYTES) {
        return res.status(413).json({
          error: 'Workbook exceeds the 64 MiB Import Inbox limit.',
          code: 'too_large',
          nextAction: 'Choose a smaller .xlsx workbook.',
        });
      }
    }

    let filename: string;
    let ownerRequestId: string;
    try {
      filename = queryString(req.query.filename, 'filename');
      ownerRequestId = queryString(req.query.requestId, 'requestId');
    } catch (error) {
      return sendError(res, error);
    }
    let operation: ReturnType<typeof operationController> | undefined;
    try {
      operation = operationController(
        req,
        res,
        deps,
        `data-room-import-upload:${ownerRequestId.slice(0, 96)}:${randomUUID()}`,
        'data_room_import_upload',
      );
      const result = await service.uploadXlsx({
        originalName: filename,
        mediaType: req.get('content-type') ?? '',
        requestId: ownerRequestId,
        chunks: req,
        signal: operation.signal,
      });
      if (result.replayed) req.resume();
      return res.status(result.replayed ? 200 : 201).json(result);
    } catch (error) {
      if (res.headersSent || res.destroyed) return res;
      return sendError(res, error);
    } finally {
      operation?.cleanup();
    }
  });

  router.post('/analytics/data-room/imports/:id/inspect', async (req: Request, res: Response) => {
    const service = deps.analyticsImportInbox;
    if (!service) return res.status(503).json({ error: 'Data Room Import Inbox is unavailable.' });
    if (deps.shutdown?.isShuttingDown()) {
      return res.status(503).json({
        error: 'BotBoy is shutting down; workbook inspection did not start.',
        code: 'unavailable',
        nextAction: 'Retry after BotBoy restarts.',
      });
    }
    if (req.body?.ownerRequested !== true) {
      return res.status(400).json({ error: 'ownerRequested must be true for workbook inspection.', code: 'invalid_input' });
    }
    const id = paramStr(req.params.id);
    let operation: ReturnType<typeof operationController> | undefined;
    try {
      operation = operationController(
        req,
        res,
        deps,
        `data-room-import-inspect:${id.slice(0, 96)}:${randomUUID()}`,
        'data_room_import_inspection',
      );
      const result = await service.inspectSheet({
        importId: id,
        expectedRevision: req.body?.expectedRevision,
        sheetName: req.body?.sheetName,
        signal: operation.signal,
      });
      deps.analyticsImportSemantic?.ensureProposal({
        importId: id,
        expectedCandidateRevision: result.importItem.revision,
      });
      return res.json(withReview(result));
    } catch (error) {
      if (res.headersSent || res.destroyed) return res;
      return sendError(res, error);
    } finally {
      operation?.cleanup();
    }
  });

  router.post('/analytics/data-room/imports/:id/proposal/retry', (req: Request, res: Response) => {
    const semantic = deps.analyticsImportSemantic;
    if (!semantic) return res.status(503).json({ error: 'Data Room semantic import is unavailable.', code: 'unavailable' });
    if (!requireOwnerBody(req, res, 'semantic proposal retry')) return;
    try {
      const id = paramStr(req.params.id);
      semantic.retry({
        importId: id,
        proposalId: req.body?.proposalId,
        proposalSha256: req.body?.proposalSha256,
        expectedStateRevision: req.body?.expectedStateRevision,
      });
      const result = deps.analyticsImportInbox?.get(id);
      return result ? res.json(withReview(result)) : res.status(404).json({ error: 'Import candidate not found.', code: 'not_found' });
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.post('/analytics/data-room/imports/:id/proposal/respond', (req: Request, res: Response) => {
    const semantic = deps.analyticsImportSemantic;
    if (!semantic) return res.status(503).json({ error: 'Data Room semantic import is unavailable.', code: 'unavailable' });
    if (!requireOwnerBody(req, res, 'semantic conflict response')) return;
    try {
      const id = paramStr(req.params.id);
      semantic.respond({
        importId: id,
        proposalId: req.body?.proposalId,
        proposalSha256: req.body?.proposalSha256,
        expectedStateRevision: req.body?.expectedStateRevision,
        answers: req.body?.answers,
      });
      const result = deps.analyticsImportInbox?.get(id);
      return result ? res.json(withReview(result)) : res.status(404).json({ error: 'Import candidate not found.', code: 'not_found' });
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.post('/analytics/data-room/imports/:id/proposal/dismiss', (req: Request, res: Response) => {
    const semantic = deps.analyticsImportSemantic;
    if (!semantic) return res.status(503).json({ error: 'Data Room semantic import is unavailable.', code: 'unavailable' });
    if (!requireOwnerBody(req, res, 'semantic proposal dismissal')) return;
    try {
      const id = paramStr(req.params.id);
      semantic.dismiss({
        importId: id,
        proposalId: req.body?.proposalId,
        proposalSha256: req.body?.proposalSha256,
        expectedStateRevision: req.body?.expectedStateRevision,
      });
      const result = deps.analyticsImportInbox?.get(id);
      return result ? res.json(withReview(result)) : res.status(404).json({ error: 'Import candidate not found.', code: 'not_found' });
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.post('/analytics/data-room/imports/:id/proposal/accept', async (req: Request, res: Response) => {
    const promotion = deps.analyticsImportPromotion;
    if (!promotion) return res.status(503).json({ error: 'Data Room import promotion is unavailable.', code: 'unavailable' });
    if (!requireLocalOwnerUiRequest(req, res, 'Data Room import acceptance')) return;
    if (!requireOwnerBody(req, res, 'import acceptance')) return;
    if (deps.shutdown?.isShuttingDown()) return res.status(503).json({ error: 'BotBoy is shutting down; import approval did not start.', code: 'unavailable' });
    const id = paramStr(req.params.id);
    let operation: ReturnType<typeof operationController> | undefined;
    try {
      operation = operationController(req, res, deps, `data-room-import-accept:${id}:${randomUUID()}`, 'data_room_import_promotion');
      await promotion.acceptAndImport({
        importId: id,
        proposalId: req.body?.proposalId,
        expectedStateRevision: req.body?.expectedStateRevision,
        proposalSha256: req.body?.proposalSha256,
        ownerRequestId: req.body?.ownerRequestId,
        signal: operation.signal,
      });
      const result = deps.analyticsImportInbox?.get(id);
      return result ? res.json(withReview(result)) : res.status(404).json({ error: 'Import candidate not found.', code: 'not_found' });
    } catch (error) {
      if (res.headersSent || res.destroyed) return res;
      return sendError(res, error);
    } finally {
      operation?.cleanup();
    }
  });

  router.post('/analytics/data-room/imports/:id/promotion/retry', async (req: Request, res: Response) => {
    const promotion = deps.analyticsImportPromotion;
    if (!promotion) return res.status(503).json({ error: 'Data Room import promotion is unavailable.', code: 'unavailable' });
    if (!requireLocalOwnerUiRequest(req, res, 'Data Room import promotion retry')) return;
    if (!requireOwnerBody(req, res, 'import promotion retry')) return;
    const id = paramStr(req.params.id);
    let operation: ReturnType<typeof operationController> | undefined;
    try {
      operation = operationController(req, res, deps, `data-room-import-promotion-retry:${id}:${randomUUID()}`, 'data_room_import_promotion');
      await promotion.retry({
        importId: id,
        proposalId: req.body?.proposalId,
        expectedStateRevision: req.body?.expectedStateRevision,
        signal: operation.signal,
      });
      const result = deps.analyticsImportInbox?.get(id);
      return result ? res.json(withReview(result)) : res.status(404).json({ error: 'Import candidate not found.', code: 'not_found' });
    } catch (error) {
      if (res.headersSent || res.destroyed) return res;
      return sendError(res, error);
    } finally {
      operation?.cleanup();
    }
  });

  router.get('/analytics/data-room/imports/:id', (req: Request, res: Response) => {
    const service = deps.analyticsImportInbox;
    if (!service) return res.status(503).json({ error: 'Data Room Import Inbox is unavailable.' });
    try {
      const result = service.get(paramStr(req.params.id));
      return result
        ? res.json(withReview(result))
        : res.status(404).json({ error: 'Import candidate not found.', code: 'not_found' });
    } catch (error) {
      return sendError(res, error);
    }
  });

  return router;
}
