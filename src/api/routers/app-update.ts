import { Router, Request, Response } from 'express';
import type { RouterDeps } from './deps.js';
import { requireLocalOwnerUiRequest } from './local-owner.js';
import { readRestartSignInRisk } from '../../core/restart-sign-in.js';

/**
 * In-app update: read the cached status, re-check on demand, and launch the
 * detached `./start.sh --update` (owner UI only; it restarts BotBoy). An update restarts BotBoy, so when Amazon's device
 * check has lapsed the first press asks first (`sign_in_lapsed`, restart-sign-in.ts) and `confirmed: true` goes on.
 */
export function createAppUpdateRouter(deps: RouterDeps): Router {
  const router = Router();
  router.get('/app-update/status', (_req: Request, res: Response) => {
    if (!deps.appUpdater) return res.json({ supported: false, available: false });
    res.json(deps.appUpdater.status());
  });
  router.post('/app-update/check', async (req: Request, res: Response) => {
    if (!requireLocalOwnerUiRequest(req, res, 'Update check', 'Use the Update button in BotBoy.')) return;
    if (!deps.appUpdater) return res.json({ supported: false, available: false });
    res.json(await deps.appUpdater.check());
  });
  router.post('/app-update/start', async (req: Request, res: Response) => {
    if (!requireLocalOwnerUiRequest(req, res, 'Update', 'Use the Update button in BotBoy.')) return;
    if (!deps.appUpdater) return res.status(409).json({ code: 'update_not_supported', error: 'Updates are not available in this install.' });
    if (req.body?.confirmed !== true) {
      const risk = (deps.restartSignInRisk ?? readRestartSignInRisk)();
      if (risk.atRisk) return res.status(409).json({ ok: false, code: 'sign_in_lapsed', error: risk.message, confirm: 'Update anyway?' });
    }
    await deps.appUpdater.check();
    const result = deps.appUpdater.startUpdate();
    if (!result.ok) return res.status(409).json(result);
    res.json({ ok: true, logPath: result.logPath, message: 'Updating. BotBoy will close and restart on its own in a minute or two.' });
  });
  return router;
}
