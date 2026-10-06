/**
 * Gmail connection + sync routes (Connections → Gmail). Status is readable by
 * any local caller; every change (OAuth client, connect, disconnect, config,
 * manual run) requires the rendered same-origin owner page. No response ever
 * carries the client secret or a token.
 *
 * The OAuth callback is Google's top-level redirect back to BotBoy: it has no
 * Origin and is cross-site by nature, so it is accepted on loopback only and
 * proves itself with the single-use `state` minted by POST /connect
 * (gmail-connection.ts). It always redirects to the Gmail page, which shows
 * the outcome.
 *
 * The chat draft card (gmail-compose.ts) reads one BotBoy draft locally and
 * sends or discards it only from the same-origin owner page, naming the exact
 * message id it showed.
 */

import { Router, type Request, type Response } from 'express';
import type { RouterDeps } from './deps.js';
import { requireLocalOwnerRequest, requireLocalOwnerUiRequest } from './local-owner.js';
import { GmailCredentialInputError } from '../../core/gmail-credentials.js';
import { GmailAuthError } from '../../core/gmail-connection.js';
import { GmailComposeError, type GmailComposeErrorCode } from '../../core/gmail-compose.js';
import { GmailImportError } from '../../monitors/gmail-sync.js';

const OWNER_UI_NEXT_ACTION = 'Open Connections → Gmail in the BotBoy window and use its controls.';
const DRAFT_CARD_NEXT_ACTION = 'Use the Send or Discard button on the draft card in the BotBoy chat.';
export const GMAIL_OAUTH_CALLBACK_PATH = '/gmail-sync/oauth/callback';
const GMAIL_ID = /^[A-Za-z0-9_-]{1,128}$/;

const COMPOSE_STATUS: Record<GmailComposeErrorCode, number> = {
  not_connected: 409,
  reconnect_required: 409,
  compose_not_granted: 409,
  invalid_arguments: 400,
  // Card routes never take files; listed for completeness of the code map.
  attachment_not_allowed: 422,
  not_found: 404,
  unknown_draft: 404,
  other_account: 409,
  draft_not_open: 409,
  draft_changed: 409,
  rate_limited: 429,
  google_error: 502,
  send_unknown_effect: 504,
  draft_unknown_effect: 504,
  send_in_progress: 409,
  send_cap_reached: 429,
};

/**
 * A same-origin page GET carries no Origin, so a DNS-rebinding page would pass
 * the loopback check; its Host header still names the attacker's hostname.
 * The draft view returns mail text, so it answers only for a loopback Host.
 */
function loopbackHost(req: Request): boolean {
  const host = req.get('host') ?? '';
  return /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/i.test(host);
}

/** A compose failure as the card reads it: message, code, effect, and (after draft_changed) the new version. */
function composeError(res: Response, error: unknown) {
  if (error instanceof GmailComposeError) {
    const view = error.detail?.view;
    return res.status(COMPOSE_STATUS[error.code] ?? 500).json({
      error: error.message,
      code: error.code,
      effect: error.effect,
      nextAction: error.nextAction,
      ...(view ? { draft: view } : {}),
    });
  }
  console.error(`[Gmail] Draft card action failed: ${error instanceof Error ? error.name : 'Error'}`);
  return res.status(500).json({ error: 'BotBoy could not finish that Gmail action.', code: 'internal_error', effect: 'unknown' });
}

function jsonBody(req: Request): Record<string, unknown> {
  return req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
}

function unavailable(res: Response) {
  return res.status(503).json({ error: 'Gmail sync is unavailable.' });
}

export function createGmailSyncRouter(deps: RouterDeps): Router {
  const router = Router();

  router.get('/gmail-sync/status', (req: Request, res: Response) => {
    if (!requireLocalOwnerRequest(req, res, 'Gmail status')) return;
    if (!deps.gmailSync) return unavailable(res);
    res.set('Cache-Control', 'no-store');
    return res.json({ status: deps.gmailSync.getStatus() });
  });

  router.put('/gmail-sync/client', (req: Request, res: Response) => {
    if (!requireLocalOwnerUiRequest(req, res, 'Saving the Gmail OAuth client', OWNER_UI_NEXT_ACTION)) return;
    if (!deps.gmailSync || !deps.gmailConnection) return unavailable(res);
    const body = jsonBody(req);
    const unexpected = Object.keys(body).filter(key => key !== 'clientId' && key !== 'clientSecret');
    if (unexpected.length) return res.status(400).json({ error: 'Only clientId and clientSecret may be sent.', code: 'invalid_request' });
    res.set('Cache-Control', 'no-store');
    try {
      deps.gmailConnection.saveClient({ clientId: body.clientId, clientSecret: body.clientSecret });
      return res.json({ status: deps.gmailSync.getStatus() });
    } catch (error) {
      if (error instanceof GmailCredentialInputError) {
        return res.status(400).json({ error: error.message, code: 'invalid_client', field: error.field });
      }
      console.error(`[Gmail] Saving the OAuth client failed: ${error instanceof Error ? error.name : 'Error'}`);
      return res.status(500).json({ error: 'BotBoy could not save the OAuth client.', code: 'internal_error' });
    }
  });

  router.delete('/gmail-sync/client', async (req: Request, res: Response) => {
    if (!requireLocalOwnerUiRequest(req, res, 'Removing the Gmail OAuth client', OWNER_UI_NEXT_ACTION)) return;
    if (!deps.gmailSync || !deps.gmailConnection) return unavailable(res);
    res.set('Cache-Control', 'no-store');
    await deps.gmailConnection.removeClient();
    return res.json({ status: deps.gmailSync.getStatus() });
  });

  router.post('/gmail-sync/connect', (req: Request, res: Response) => {
    if (!requireLocalOwnerUiRequest(req, res, 'Connecting Gmail', OWNER_UI_NEXT_ACTION)) return;
    if (!deps.gmailConnection) return unavailable(res);
    res.set('Cache-Control', 'no-store');
    try {
      return res.json(deps.gmailConnection.beginConnect());
    } catch (error) {
      if (error instanceof GmailAuthError) return res.status(409).json({ error: error.message, code: error.code });
      return res.status(500).json({ error: 'BotBoy could not start the Google sign-in.', code: 'internal_error' });
    }
  });

  router.get(GMAIL_OAUTH_CALLBACK_PATH, async (req: Request, res: Response) => {
    if (!requireLocalOwnerRequest(req, res, 'Gmail sign-in')) return;
    if (!deps.gmailConnection) return unavailable(res);
    const query = req.query as Record<string, unknown>;
    const outcome = await deps.gmailConnection.completeConnect({ code: query.code, state: query.state, error: query.error });
    // First sync right away; the page shows progress on its next refresh.
    if (outcome.ok) void deps.gmailSync?.runNow().catch(() => undefined);
    res.set('Cache-Control', 'no-store');
    res.set('Referrer-Policy', 'no-referrer');
    return res.redirect(302, `${deps.dashboardOrigin ?? ''}/#/connections/gmail-sync`);
  });

  router.post('/gmail-sync/disconnect', async (req: Request, res: Response) => {
    if (!requireLocalOwnerUiRequest(req, res, 'Disconnecting Gmail', OWNER_UI_NEXT_ACTION)) return;
    if (!deps.gmailSync || !deps.gmailConnection) return unavailable(res);
    res.set('Cache-Control', 'no-store');
    await deps.gmailConnection.disconnect();
    return res.json({ status: deps.gmailSync.getStatus() });
  });

  router.put('/gmail-sync/config', (req: Request, res: Response) => {
    if (!requireLocalOwnerUiRequest(req, res, 'Changing Gmail sync settings', OWNER_UI_NEXT_ACTION)) return;
    if (!deps.gmailSync) return unavailable(res);
    const body = jsonBody(req);
    try {
      return res.json({ status: deps.gmailSync.updateConfig({ enabled: body.enabled as boolean | undefined, noiseSenders: body.noiseSenders as string[] | undefined }) });
    } catch (error) {
      return res.status(400).json({ error: error instanceof Error ? error.message : 'Invalid settings' });
    }
  });

  router.post('/gmail-sync/run', async (req: Request, res: Response) => {
    if (!requireLocalOwnerUiRequest(req, res, 'Running Gmail sync', OWNER_UI_NEXT_ACTION)) return;
    if (!deps.gmailSync) return unavailable(res);
    // A run takes seconds; waiting for the real result beats a 202.
    const result = await deps.gmailSync.runNow();
    return res.json({ result, status: deps.gmailSync.getStatus() });
  });

  // ── Older-mail import (GMAIL_API_INTEGRATION_PLAN.md §12) ──
  // Owner-started from the Gmail page; the sync lists the window on its next
  // run and works through it in the background, so these answer at once.

  router.post('/gmail-sync/import', (req: Request, res: Response) => {
    if (!requireLocalOwnerUiRequest(req, res, 'Importing older Gmail mail', OWNER_UI_NEXT_ACTION)) return;
    if (!deps.gmailSync) return unavailable(res);
    const body = jsonBody(req);
    const unexpected = Object.keys(body).filter(key => key !== 'months');
    if (unexpected.length) return res.status(400).json({ error: 'Only months may be sent.', code: 'invalid_request' });
    res.set('Cache-Control', 'no-store');
    try {
      return res.json({ status: deps.gmailSync.requestImport({ months: body.months }) });
    } catch (error) {
      if (error instanceof GmailImportError) {
        return res.status(error.code === 'invalid_window' ? 400 : 409).json({ error: error.message, code: error.code });
      }
      console.error(`[Gmail] Starting the import failed: ${error instanceof Error ? error.name : 'Error'}`);
      return res.status(500).json({ error: 'BotBoy could not start the import.', code: 'internal_error' });
    }
  });

  router.delete('/gmail-sync/import', (req: Request, res: Response) => {
    if (!requireLocalOwnerUiRequest(req, res, 'Stopping the Gmail import', OWNER_UI_NEXT_ACTION)) return;
    if (!deps.gmailSync) return unavailable(res);
    res.set('Cache-Control', 'no-store');
    return res.json({ status: deps.gmailSync.stopImport() });
  });

  // ── Chat draft cards (GMAIL_CHAT_TOOLS_PLAN.md §7) ──
  // Only drafts BotBoy created (the compose ledger) are visible here. Viewing
  // is a local read; Send and Discard are owner clicks on the rendered card,
  // so they need the same-origin owner page and name the exact version shown.

  router.get('/gmail-sync/drafts/:draftId', async (req: Request, res: Response) => {
    if (!requireLocalOwnerRequest(req, res, 'Gmail draft')) return;
    if (!loopbackHost(req)) return res.status(403).json({ error: 'Gmail draft is served only to this Mac’s BotBoy address.', code: 'owner_action_required' });
    if (!deps.gmailCompose) return unavailable(res);
    res.set('Cache-Control', 'no-store');
    const draftId = String(req.params.draftId ?? '');
    if (!GMAIL_ID.test(draftId)) return res.status(400).json({ error: 'That is not a Gmail draft id.', code: 'invalid_request' });
    try {
      return res.json({ draft: await deps.gmailCompose.viewDraft(draftId) });
    } catch (error) {
      return composeError(res, error);
    }
  });

  for (const action of ['send', 'discard'] as const) {
    router.post(`/gmail-sync/drafts/:draftId/${action}`, async (req: Request, res: Response) => {
      if (!requireLocalOwnerUiRequest(req, res, action === 'send' ? 'Sending a Gmail draft' : 'Discarding a Gmail draft', DRAFT_CARD_NEXT_ACTION)) return;
      if (!deps.gmailCompose) return unavailable(res);
      res.set('Cache-Control', 'no-store');
      const draftId = String(req.params.draftId ?? '');
      const body = jsonBody(req);
      const messageId = typeof body.messageId === 'string' ? body.messageId : '';
      if (!GMAIL_ID.test(draftId) || !GMAIL_ID.test(messageId)) {
        return res.status(400).json({ error: 'The draft id and the message id of the version shown are required.', code: 'invalid_request', effect: 'none' });
      }
      try {
        if (action === 'send') {
          const receipt = await deps.gmailCompose.sendDraftFromCard(draftId, messageId);
          // The send happened: a failed re-read must not turn into "Not sent".
          const draft = await deps.gmailCompose.viewDraft(draftId).catch(() => ({
            state: 'sent' as const, draftId, account: receipt.account, messageId: null, threadId: receipt.threadId,
            to: receipt.to, cc: receipt.cc, bcc: receipt.bcc, subject: receipt.subject, body: '', bodyTruncated: false,
            // Never throw here: this view exists so a sent email is not reported as a failure.
            attachments: (Array.isArray(receipt.attachments) ? receipt.attachments : [])
              .map(({ name, mimeType, sizeBytes }) => ({ name, mimeType, sizeBytes })),
            updatedAt: receipt.sentAt, sentMessageId: receipt.messageId, sentAt: receipt.sentAt, gmailUrl: receipt.gmailUrl,
          }));
          return res.json({ receipt, draft });
        }
        return res.json({ draft: await deps.gmailCompose.discardDraft(draftId, messageId) });
      } catch (error) {
        return composeError(res, error);
      }
    });
  }

  return router;
}
