import { Router, type NextFunction, type Request, type Response } from 'express';
import { AnalyticsDataRoomError } from '../../core/analytics-data-room-store.js';
import { paramStr, type RouterDeps } from './deps.js';

const DATASET_ID_RE = /^ds_[a-zA-Z0-9_-]{1,96}$/;
const VERSION_ID_RE = /^dsv_[a-f0-9]{24}$/;

function sameOrigin(req: Request): boolean {
  const origin = req.get('origin');
  if (!origin) return true; // Native app, tests, and local clients omit Origin.
  const host = req.get('host');
  if (!host) return false;
  try {
    return new URL(origin).origin === new URL(`${req.protocol}://${host}`).origin;
  } catch {
    return false;
  }
}

function datasetId(value: string | string[]): string {
  const id = paramStr(value);
  if (!DATASET_ID_RE.test(id)) throw new AnalyticsDataRoomError('invalid_input', 'Dataset ID is malformed.');
  return id;
}

function versionId(value: string | string[]): string {
  const id = paramStr(value);
  if (!VERSION_ID_RE.test(id)) throw new AnalyticsDataRoomError('invalid_input', 'Version ID is malformed.');
  return id;
}

function listLimit(value: unknown): number {
  if (value === undefined) return 25;
  if (typeof value !== 'string' || !/^\d+$/.test(value)) {
    throw new AnalyticsDataRoomError('invalid_input', 'limit must be an integer from 1 to 100.');
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) {
    throw new AnalyticsDataRoomError('invalid_input', 'limit must be an integer from 1 to 100.');
  }
  return parsed;
}

function sendError(res: Response, error: unknown): Response {
  if (error instanceof AnalyticsDataRoomError) {
    const status = error.code === 'not_found'
      ? 404
      : error.code === 'policy_denied'
        ? 403
        : error.code === 'conflict' || error.code === 'integrity_failed'
          ? 409
          : 400;
    return res.status(status).json({ error: error.message, code: error.code });
  }
  console.error('[AnalyticsDataRoom] request failed with an unexpected error');
  return res.status(500).json({ error: 'Analytics data-room request failed.' });
}

export function createAnalyticsDataRoomRouter(deps: RouterDeps): Router {
  const router = Router();

  router.use('/analytics/data-room', (req: Request, res: Response, next: NextFunction) => {
    res.set('Cache-Control', 'no-store');
    if (!sameOrigin(req)) {
      return res.status(403).json({ error: 'Cross-origin analytics data-room request rejected.' });
    }
    return next();
  });

  router.post('/analytics/data-room/query', async (req: Request, res: Response) => {
    const service = deps.analyticsAnswerService;
    if (!service) return res.status(503).json({ error: 'Analytics answer service is unavailable.' });
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    req.once('aborted', abort);
    try {
      const outcome = await service.answer(req.body ?? {}, { signal: controller.signal });
      const status = outcome.status === 'answered'
        ? 200
        : outcome.status === 'pending'
          ? 202
          : outcome.status === 'clarification_required'
            ? 422
            : outcome.status === 'blocked'
              ? outcome.code === 'policy_denied' ? 403
                : outcome.code === 'no_source_definition' || outcome.code === 'not_found' ? 404
                  : 409
              : outcome.code === 'query_timeout' ? 504
                : outcome.code === 'remote_failed' || outcome.code === 'incomplete_source' ? 502
                  : 400;
      return res.status(status).json(outcome);
    } catch (error) {
      return sendError(res, error);
    } finally {
      req.removeListener('aborted', abort);
    }
  });

  router.get('/analytics/data-room/datasets', (req: Request, res: Response) => {
    const service = deps.analyticsDataRoom;
    if (!service) return res.status(503).json({ error: 'Analytics data room is unavailable.' });
    try {
      return res.json(service.listCatalogDatasets({ limit: listLimit(req.query.limit) }));
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.get('/analytics/data-room/datasets/:id/versions', (req: Request, res: Response) => {
    const service = deps.analyticsDataRoom;
    if (!service) return res.status(503).json({ error: 'Analytics data room is unavailable.' });
    try {
      const id = datasetId(req.params.id);
      const versions = service.listCatalogDatasetVersions(id, { limit: listLimit(req.query.limit) });
      return versions
        ? res.json(versions)
        : res.status(404).json({ error: 'Analytics dataset not found.', code: 'not_found' });
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.get('/analytics/data-room/datasets/:id', (req: Request, res: Response) => {
    const service = deps.analyticsDataRoom;
    if (!service) return res.status(503).json({ error: 'Analytics data room is unavailable.' });
    try {
      const dataset = service.getCatalogDataset(datasetId(req.params.id));
      return dataset
        ? res.json(dataset)
        : res.status(404).json({ error: 'Analytics dataset not found.', code: 'not_found' });
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.get('/analytics/data-room/versions/:id', (req: Request, res: Response) => {
    const service = deps.analyticsDataRoom;
    if (!service) return res.status(503).json({ error: 'Analytics data room is unavailable.' });
    try {
      const version = service.getCatalogDatasetVersion(versionId(req.params.id));
      return version
        ? res.json(version)
        : res.status(404).json({ error: 'Analytics dataset version not found.', code: 'not_found' });
    } catch (error) {
      return sendError(res, error);
    }
  });

  return router;
}
