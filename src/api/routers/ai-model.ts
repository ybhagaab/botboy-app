import { Router, type Request, type Response } from 'express';
import { AiModelSettingsError, type AiModelKeyProvider } from '../../core/ai-model-settings.js';
import type { RouterDeps } from './deps.js';
import { requireLocalOwnerRequest, requireLocalOwnerUiRequest } from './local-owner.js';

const OWNER_UI_NEXT_ACTION = 'Open Settings → AI model in the BotBoy window and use its controls.';
// The body stays `{apiKey}` for every provider: no workspace id field (deferred, design D10).
const KEY_PROVIDERS: readonly AiModelKeyProvider[] = ['openai', 'deepseek', 'anthropic'];

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

function jsonBody(req: Request): Record<string, unknown> {
  return req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
}

/** Every answer carries the chat display choice, so the page keeps it across key and role changes. */
function withChat<T extends object>(deps: RouterDeps, status: T): T & { chat?: { showThinking: boolean; updatedAt: string | null } } {
  return deps.chatThinking ? { ...status, chat: deps.chatThinking.status() } : status;
}

/**
 * Settings → AI model. Status is readable by any local caller; keys and model
 * choices can only be changed from the rendered same-origin owner page. No
 * response ever contains a key (status carries only its last four characters).
 */
export function createAiModelRouter(deps: RouterDeps): Router {
  const router = Router();

  router.get('/settings/ai-model', (req: Request, res: Response) => {
    if (!requireLocalOwnerRequest(req, res, 'AI model status')) return;
    if (!deps.aiModelSettings) return res.status(503).json({ error: 'AI model settings are unavailable.' });
    res.set('Cache-Control', 'no-store');
    return res.json(withChat(deps, deps.aiModelSettings.status()));
  });

  // Show model thinking in the chat panel (chat-thinking-display.ts). Applies from the next chat turn.
  router.put('/settings/ai-model/chat', (req: Request, res: Response) => {
    if (!requireLocalOwnerUiRequest(req, res, 'Changing how chat shows model thinking', OWNER_UI_NEXT_ACTION)) return;
    if (!deps.aiModelSettings || !deps.chatThinking) return res.status(503).json({ error: 'AI model settings are unavailable.' });
    const body = jsonBody(req);
    const unexpected = Object.keys(body).filter(key => key !== 'showThinking');
    if (unexpected.length || typeof body.showThinking !== 'boolean') {
      return res.status(400).json({ error: 'Send showThinking as true or false only.', code: 'invalid_request', nextAction: 'Use the Show model thinking switch in Settings → AI model.' });
    }
    res.set('Cache-Control', 'no-store');
    try {
      deps.chatThinking.setShowThinking(body.showThinking);
      return res.json(withChat(deps, deps.aiModelSettings.status()));
    } catch (error) {
      return sendFailure(res, error);
    }
  });

  for (const provider of KEY_PROVIDERS) {
    router.put(`/settings/ai-model/${provider}`, async (req: Request, res: Response) => {
      if (!requireLocalOwnerUiRequest(req, res, 'Saving an AI model key', OWNER_UI_NEXT_ACTION)) return;
      if (!deps.aiModelSettings) return res.status(503).json({ error: 'AI model settings are unavailable.' });
      const body = jsonBody(req);
      const unexpected = Object.keys(body).filter(key => key !== 'apiKey');
      if (unexpected.length) {
        return res.status(400).json({ error: 'Only apiKey may be sent.', code: 'invalid_request', nextAction: 'Paste the key into Settings → AI model and press Save.' });
      }
      res.set('Cache-Control', 'no-store');
      try {
        return res.json(withChat(deps, await deps.aiModelSettings.saveApiKey(provider, body.apiKey)));
      } catch (error) {
        return sendFailure(res, error);
      }
    });

    router.delete(`/settings/ai-model/${provider}`, async (req: Request, res: Response) => {
      if (!requireLocalOwnerUiRequest(req, res, 'Removing an AI model key', OWNER_UI_NEXT_ACTION)) return;
      if (!deps.aiModelSettings) return res.status(503).json({ error: 'AI model settings are unavailable.' });
      res.set('Cache-Control', 'no-store');
      try {
        return res.json(withChat(deps, await deps.aiModelSettings.removeApiKey(provider)));
      } catch (error) {
        return sendFailure(res, error);
      }
    });
  }

  // Which model (and Thinking level) serves organizing or document writing.
  router.put('/settings/ai-model/roles/:role', async (req: Request, res: Response) => {
    if (!requireLocalOwnerUiRequest(req, res, 'Changing a background model', OWNER_UI_NEXT_ACTION)) return;
    if (!deps.aiModelSettings) return res.status(503).json({ error: 'AI model settings are unavailable.' });
    const body = jsonBody(req);
    const unexpected = Object.keys(body).filter(key => key !== 'modelKey' && key !== 'thinking');
    if (unexpected.length || (!('modelKey' in body) && !('thinking' in body))) {
      return res.status(400).json({ error: 'Send modelKey and/or thinking only.', code: 'invalid_request', nextAction: 'Use the model and Thinking controls in Settings → AI model.' });
    }
    res.set('Cache-Control', 'no-store');
    try {
      return res.json(withChat(deps, await deps.aiModelSettings.setRole(String(req.params.role), {
        ...('modelKey' in body ? { modelKey: body.modelKey } : {}),
        ...('thinking' in body ? { thinking: body.thinking } : {}),
      })));
    } catch (error) {
      return sendFailure(res, error);
    }
  });

  return router;
}
