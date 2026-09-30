import { Router, type Request, type Response } from 'express';
import { AiModelSettingsError } from '../../core/ai-model-settings.js';
import type { RouterDeps } from './deps.js';
import { requireLocalOwnerRequest, requireLocalOwnerUiRequest } from './local-owner.js';

const OWNER_UI_NEXT_ACTION = 'Open Settings → AI model in the BotBoy window and use its controls.';

function sendFailure(res: Response, error: unknown): void {
  if (error instanceof AiModelSettingsError) {
    res.status(error.httpStatus).json({ error: error.message, code: error.code, nextAction: error.nextAction });
    return;
  }
  // Never echo unexpected error text: it could carry provider or key material.
  console.error(`[AI model] Settings request failed: ${error instanceof Error ? error.name : 'Error'}`);
  res.status(500).json({
    error: 'BotBoy could not update the AI model.',
    code: 'internal_error',
    nextAction: 'Try again. If it keeps failing, run ./start.sh --doctor and check /tmp/ppt.log.',
  });
}

/**
 * Settings → AI model. Status is readable by any local caller; the key can
 * only be set or removed from the rendered same-origin owner page. No
 * response ever contains the key (status carries only its last four
 * characters).
 */
export function createAiModelRouter(deps: RouterDeps): Router {
  const router = Router();

  router.get('/settings/ai-model', (req: Request, res: Response) => {
    if (!requireLocalOwnerRequest(req, res, 'AI model status')) return;
    if (!deps.aiModelSettings) return res.status(503).json({ error: 'AI model settings are unavailable.' });
    res.set('Cache-Control', 'no-store');
    return res.json(deps.aiModelSettings.status());
  });

  router.put('/settings/ai-model/openai', async (req: Request, res: Response) => {
    if (!requireLocalOwnerUiRequest(req, res, 'Saving an AI model key', OWNER_UI_NEXT_ACTION)) return;
    if (!deps.aiModelSettings) return res.status(503).json({ error: 'AI model settings are unavailable.' });
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
    const unexpected = Object.keys(body).filter(key => key !== 'apiKey');
    if (unexpected.length) {
      return res.status(400).json({ error: 'Only apiKey may be sent.', code: 'invalid_request', nextAction: 'Paste the key into Settings → AI model and press Save.' });
    }
    res.set('Cache-Control', 'no-store');
    try {
      return res.json(await deps.aiModelSettings.saveOpenAiKey(body.apiKey));
    } catch (error) {
      return sendFailure(res, error);
    }
  });

  router.delete('/settings/ai-model/openai', async (req: Request, res: Response) => {
    if (!requireLocalOwnerUiRequest(req, res, 'Removing the AI model key', OWNER_UI_NEXT_ACTION)) return;
    if (!deps.aiModelSettings) return res.status(503).json({ error: 'AI model settings are unavailable.' });
    res.set('Cache-Control', 'no-store');
    try {
      return res.json(await deps.aiModelSettings.removeOpenAiKey());
    } catch (error) {
      return sendFailure(res, error);
    }
  });

  return router;
}
