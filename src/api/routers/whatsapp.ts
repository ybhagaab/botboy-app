/**
 * Connections → WhatsApp (docs/maps/whatsapp-chat.md): status, open the
 * WhatsApp Web window, turn BotBoy-on-WhatsApp on or off, and choose the
 * BotBoy chat. Writes come only from the same-origin owner page.
 */
import { Router, type Request, type Response } from 'express';
import type { RouterDeps } from './deps.js';
import { requireLocalOwnerRequest, requireLocalOwnerUiRequest } from './local-owner.js';
import { phoneDigits } from '../../core/whatsapp-send.js';

const OWNER_UI_NEXT_ACTION = 'Use Connections → WhatsApp in the BotBoy window.';

export function createWhatsAppRouter(deps: RouterDeps): Router {
  const router = Router();
  const unavailable = (res: Response) => res.status(503).json({ error: 'WhatsApp is unavailable in this BotBoy build.', code: 'unavailable' });

  router.get('/whatsapp/status', async (req: Request, res: Response) => {
    if (!requireLocalOwnerRequest(req, res, 'WhatsApp status')) return;
    if (!deps.whatsApp) return unavailable(res);
    res.set('Cache-Control', 'no-store');
    return res.json({ status: await deps.whatsApp.status() });
  });

  router.post('/whatsapp/open', async (req: Request, res: Response) => {
    if (!requireLocalOwnerUiRequest(req, res, 'Opening WhatsApp Web', OWNER_UI_NEXT_ACTION)) return;
    if (!deps.whatsApp) return unavailable(res);
    const opened = await deps.whatsApp.openWindow();
    if (!opened) return res.status(409).json({ error: 'BotBoy’s Chrome is not running.', code: 'chrome_not_running', nextAction: 'Restart BotBoy with ./start.sh, then try again.' });
    return res.json({ status: await deps.whatsApp.status() });
  });

  router.put('/whatsapp/config', async (req: Request, res: Response) => {
    if (!requireLocalOwnerUiRequest(req, res, 'Changing WhatsApp settings', OWNER_UI_NEXT_ACTION)) return;
    if (!deps.whatsApp) return unavailable(res);
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body as Record<string, unknown> : {};
    const unexpected = Object.keys(body).filter(key => key !== 'enabled' && key !== 'chat');
    if (unexpected.length) return res.status(400).json({ error: 'Only enabled and chat may be sent.', code: 'invalid_request' });
    if (body.enabled !== undefined && typeof body.enabled !== 'boolean') return res.status(400).json({ error: 'enabled must be true or false.', code: 'invalid_request' });
    let chatNumber: string | null | undefined;
    if (body.chat !== undefined) {
      if (body.chat === null || body.chat === '' || body.chat === 'me') chatNumber = null;
      else if (typeof body.chat === 'string' && phoneDigits(body.chat)) chatNumber = phoneDigits(body.chat);
      else return res.status(400).json({ error: 'chat must be a phone number with country code, or "me" for your own chat.', code: 'invalid_chat', field: 'chat' });
      // Your own number is your own chat.
      const me = (await deps.whatsApp.status()).me;
      if (chatNumber && me && chatNumber === me.number) chatNumber = null;
    }
    deps.whatsApp.update({
      ...(typeof body.enabled === 'boolean' ? { enabled: body.enabled } : {}),
      ...(chatNumber !== undefined ? { chatNumber } : {}),
    });
    if (body.enabled === true) await deps.whatsApp.openWindow().catch(() => false);
    return res.json({ status: await deps.whatsApp.status() });
  });

  return router;
}
