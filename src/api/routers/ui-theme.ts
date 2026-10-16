import { Router, type Request, type Response } from 'express';
import type { RouterDeps } from './deps.js';
import { requireLocalOwnerRequest, requireLocalOwnerUiRequest } from './local-owner.js';
import type { ThemeOp } from '../../core/ui-theme.js';

const CARD_NEXT_ACTION = 'Use the Preview, Keep and Discard buttons on the theme card in the BotBoy chat panel.';
const SETTINGS_NEXT_ACTION = 'Open Settings → Appearance in the BotBoy window and use its controls.';

function jsonBody(req: Request): Record<string, unknown> | null {
  return req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : null;
}
function idParam(req: Request): string {
  const value = req.params.id;
  return Array.isArray(value) ? value[0] ?? '' : value ?? '';
}

/**
 * Settings → Appearance and the chat theme card (docs/maps/ui-themes.md). Reads are open to any local caller (the page reads the
 * theme before it paints); every change comes only from the rendered same-origin owner page. A change is never made by the chat
 * model: its tool only stages a proposal, and these routes are the owner's Keep, Apply, Rename and Delete.
 */
export function createUiThemeRouter(deps: RouterDeps) {
  const router = Router();

  function send<T>(res: Response, result: ThemeOp<T>, shape: (value: T) => unknown): Response {
    if (result.ok) return res.json(shape(result.value));
    return res.status(result.status).json({ code: result.code, error: result.message, nextAction: result.nextAction });
  }

  router.get('/ui-theme', (req: Request, res: Response) => {
    if (!requireLocalOwnerRequest(req, res, 'Theme status')) return;
    if (!deps.uiThemes) return res.status(503).json({ error: 'Themes are unavailable.' });
    res.set('Cache-Control', 'no-store');
    return res.json(deps.uiThemes.view());
  });

  router.get('/ui-theme/proposals/:id', (req: Request, res: Response) => {
    if (!requireLocalOwnerRequest(req, res, 'Theme proposal')) return;
    if (!deps.uiThemes) return res.status(503).json({ error: 'Themes are unavailable.' });
    res.set('Cache-Control', 'no-store');
    const proposal = deps.uiThemes.proposal(idParam(req));
    if (!proposal) {
      return res.status(404).json({ code: 'proposal_not_found', error: 'This theme proposal is no longer available (proposals last a week).', nextAction: 'Ask BotBoy to make the theme again.' });
    }
    return res.json(proposal);
  });

  router.post('/ui-theme/proposals/:id/keep', (req: Request, res: Response) => {
    if (!requireLocalOwnerUiRequest(req, res, 'Keeping a theme', CARD_NEXT_ACTION)) return;
    if (!deps.uiThemes) return res.status(503).json({ error: 'Themes are unavailable.' });
    res.set('Cache-Control', 'no-store');
    const result = deps.uiThemes.keep(idParam(req));
    return send(res, result, (value) => ({ ...value, view: deps.uiThemes!.view() }));
  });

  router.post('/ui-theme/proposals/:id/discard', (req: Request, res: Response) => {
    if (!requireLocalOwnerUiRequest(req, res, 'Discarding a theme', CARD_NEXT_ACTION)) return;
    if (!deps.uiThemes) return res.status(503).json({ error: 'Themes are unavailable.' });
    res.set('Cache-Control', 'no-store');
    return send(res, deps.uiThemes.discard(idParam(req)), (value) => value);
  });

  router.put('/ui-theme/active', (req: Request, res: Response) => {
    if (!requireLocalOwnerUiRequest(req, res, 'Choosing a theme', SETTINGS_NEXT_ACTION)) return;
    if (!deps.uiThemes) return res.status(503).json({ error: 'Themes are unavailable.' });
    const body = jsonBody(req);
    if (!body || Object.keys(body).length !== 1 || typeof body.id !== 'string') {
      return res.status(400).json({ code: 'invalid_request', error: 'Send the theme id only.', nextAction: SETTINGS_NEXT_ACTION });
    }
    res.set('Cache-Control', 'no-store');
    return send(res, deps.uiThemes.setActive(body.id), (value) => value);
  });

  router.patch('/ui-theme/themes/:id', (req: Request, res: Response) => {
    if (!requireLocalOwnerUiRequest(req, res, 'Renaming a theme', SETTINGS_NEXT_ACTION)) return;
    if (!deps.uiThemes) return res.status(503).json({ error: 'Themes are unavailable.' });
    const body = jsonBody(req);
    if (!body || Object.keys(body).length !== 1 || typeof body.name !== 'string') {
      return res.status(400).json({ code: 'invalid_request', error: 'Send the new name only.', nextAction: SETTINGS_NEXT_ACTION });
    }
    res.set('Cache-Control', 'no-store');
    return send(res, deps.uiThemes.rename(idParam(req), body.name), (value) => ({ theme: value, view: deps.uiThemes!.view() }));
  });

  router.delete('/ui-theme/themes/:id', (req: Request, res: Response) => {
    if (!requireLocalOwnerUiRequest(req, res, 'Deleting a theme', SETTINGS_NEXT_ACTION)) return;
    if (!deps.uiThemes) return res.status(503).json({ error: 'Themes are unavailable.' });
    res.set('Cache-Control', 'no-store');
    return send(res, deps.uiThemes.remove(idParam(req)), (value) => value);
  });

  router.post('/ui-theme/reset', (req: Request, res: Response) => {
    if (!requireLocalOwnerUiRequest(req, res, 'Resetting the theme', SETTINGS_NEXT_ACTION)) return;
    if (!deps.uiThemes) return res.status(503).json({ error: 'Themes are unavailable.' });
    res.set('Cache-Control', 'no-store');
    return res.json(deps.uiThemes.reset());
  });

  return router;
}
