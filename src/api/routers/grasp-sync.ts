/**
 * Outlook mail & calendar sync routes — the Connections management surface
 * for the scheduled GRASP ingestion (src/monitors/grasp-sync.ts).
 *
 * Peers of /slack/config and /local-folders: local JSON routes that read and
 * write the sync's settings-backed configuration and trigger a manual run.
 */

import { Router, Request, Response } from 'express';
import type { RouterDeps } from './deps.js';

export function createGraspSyncRouter(deps: RouterDeps): Router {
  const router = Router();

  router.get('/grasp-sync/status', (_req: Request, res: Response) => {
    const sync = deps.graspSync;
    if (!sync) return res.status(503).json({ error: 'GRASP sync is unavailable' });
    res.json({ status: sync.getStatus() });
  });

  router.put('/grasp-sync/config', (req: Request, res: Response) => {
    const sync = deps.graspSync;
    if (!sync) return res.status(503).json({ error: 'GRASP sync is unavailable' });
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return res.status(400).json({ error: 'Body must be a JSON object' });
    }
    try {
      const status = sync.updateConfig({
        enabled: body.enabled,
        ownerEmail: body.ownerEmail,
        noiseSenders: body.noiseSenders,
      });
      res.json({ status });
    } catch (error: any) {
      res.status(400).json({ error: error?.message ?? String(error) });
    }
  });

  router.post('/grasp-sync/run', async (_req: Request, res: Response) => {
    const sync = deps.graspSync;
    if (!sync) return res.status(503).json({ error: 'GRASP sync is unavailable' });
    try {
      // A full run takes seconds to a minute; this is a local dashboard call,
      // so waiting for the real result beats a fire-and-forget 202.
      const result = await sync.runNow();
      res.json({ result, status: sync.getStatus() });
    } catch (error: any) {
      res.status(500).json({ error: error?.message ?? String(error) });
    }
  });

  return router;
}
