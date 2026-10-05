import { Router, Request, Response } from 'express';
import type { RouterDeps } from './deps.js';

/**
 * Read-only capture health: each source's last outcome and the warnings an
 * owner should see. Read on load and whenever `/dashboard/version` reports a
 * new `captureHealthVersion`.
 */
export function createCaptureHealthRouter(deps: RouterDeps): Router {
  const router = Router();

  router.get('/capture-health', (_req: Request, res: Response) => {
    if (!deps.captureHealth) return res.status(503).json({ error: 'Capture health is not available' });
    res.json({
      version: deps.captureHealth.version(),
      sources: deps.captureHealth.sources(),
      issues: deps.captureHealth.issues(),
    });
  });

  return router;
}
