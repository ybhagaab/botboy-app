import { Router, type Request, type Response } from 'express';
import type { RouterDeps } from './deps.js';
import { requireLocalOwnerRequest, requireLocalOwnerUiRequest } from './local-owner.js';
import { ExportFooterError } from '../../product-manager/export-footer.js';

const OWNER_UI_NEXT_ACTION = 'Open Settings → Workplace in the BotBoy window and use its toggle.';
const FOOTER_UI_NEXT_ACTION = 'Open Settings → Workplace in the BotBoy window and use its footer field.';

function jsonBody(req: Request): Record<string, unknown> | null {
  return req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : null;
}

/**
 * 409 for Amazon-internal routes while Amazon Employee is off. Returns true
 * when the caller may proceed (ON, or no workplace wired — today's behavior).
 */
export function requireAmazonEmployee(deps: Pick<RouterDeps, 'workplace'>, res: Response): boolean {
  if (!deps.workplace || deps.workplace.amazonEmployee()) return true;
  res.status(409).json({
    error: "This is part of BotBoy's Amazon internal paths, which are off.",
    code: 'amazon_employee_off',
    nextAction: 'Turn on Amazon Employee in Settings → Workplace.',
  });
  return false;
}

/**
 * Settings → Workplace. Status is readable by any local caller; the toggle
 * and the export footer change only from the rendered same-origin owner
 * page. No secret is ever returned.
 */
export function createWorkplaceRouter(deps: RouterDeps): Router {
  const router = Router();

  async function statusPayload() {
    const workplace = deps.workplace!;
    let hiddenConnections: Array<{ id: string; displayName: string; setUp: boolean }> = [];
    if (deps.mcpManager && !workplace.amazonEmployee()) {
      try {
        const all = await deps.mcpManager.listProfiles({ includeHidden: true });
        hiddenConnections = all
          .filter(profile => deps.mcpManager!.isHiddenByWorkplace(profile.id))
          .map(profile => ({
            id: profile.id,
            displayName: profile.displayName,
            setUp: Boolean(profile.enabled || profile.lastStartedAt || profile.lastHealthyAt),
          }));
      } catch {
        hiddenConnections = [];
      }
    }
    return {
      ...workplace.status(),
      hiddenConnections,
      ...(deps.exportFooter ? { exportFooter: deps.exportFooter.status() } : {}),
      appliesWithoutRestart: true,
    };
  }

  router.get('/settings/workplace', async (req: Request, res: Response) => {
    if (!requireLocalOwnerRequest(req, res, 'Workplace status')) return;
    if (!deps.workplace) return res.status(503).json({ error: 'Workplace settings are unavailable.' });
    res.set('Cache-Control', 'no-store');
    return res.json(await statusPayload());
  });

  router.put('/settings/workplace', async (req: Request, res: Response) => {
    if (!requireLocalOwnerUiRequest(req, res, 'Changing Amazon Employee', OWNER_UI_NEXT_ACTION)) return;
    if (!deps.workplace) return res.status(503).json({ error: 'Workplace settings are unavailable.' });
    const body = jsonBody(req);
    const keys = body ? Object.keys(body) : [];
    if (!body || keys.length !== 1 || keys[0] !== 'amazonEmployee' || typeof body.amazonEmployee !== 'boolean') {
      return res.status(400).json({
        code: 'invalid_request',
        error: 'Send amazonEmployee (true or false) only.',
        nextAction: 'Use the Amazon Employee toggle in Settings → Workplace.',
      });
    }
    res.set('Cache-Control', 'no-store');
    try {
      await deps.workplace.setAmazonEmployee(body.amazonEmployee);
      return res.json(await statusPayload());
    } catch (error) {
      console.error(`[Workplace] update failed: ${error instanceof Error ? error.name : 'Error'}`);
      return res.status(500).json({ code: 'internal_error', error: 'BotBoy could not save the setting.', nextAction: 'Try again.' });
    }
  });

  router.put('/settings/workplace/export-footer', (req: Request, res: Response) => {
    if (!requireLocalOwnerUiRequest(req, res, 'Changing the export footer', FOOTER_UI_NEXT_ACTION)) return;
    if (!deps.exportFooter) return res.status(503).json({ error: 'Export footer settings are unavailable.' });
    const body = jsonBody(req);
    const keys = body ? Object.keys(body) : [];
    res.set('Cache-Control', 'no-store');
    try {
      if (!body || keys.length !== 1 || keys[0] !== 'text') {
        throw new ExportFooterError('invalid_footer', 'Send text only.');
      }
      return res.json({ exportFooter: deps.exportFooter.set(body.text, 'settings') });
    } catch (error) {
      if (error instanceof ExportFooterError) {
        return res.status(400).json({ code: error.code, error: error.message, nextAction: error.nextAction });
      }
      console.error(`[Workplace] footer update failed: ${error instanceof Error ? error.name : 'Error'}`);
      return res.status(500).json({ code: 'internal_error', error: 'BotBoy could not save the footer.', nextAction: 'Try again.' });
    }
  });

  return router;
}
