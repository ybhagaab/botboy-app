/**
 * Gmail connection + sync routes (Connections → Gmail). Status is readable by
 * any local caller; every change (OAuth client, connect, disconnect, config,
 * manual run) requires the rendered same-origin owner page. No response ever
 * carries the client secret or a token.
 *
 * The OAuth callback is Google's top-level redirect back to BotBoy: it has no
 * Origin and is cross-site by nature, so it is accepted on loopback only and
 * proves itself with the single-use `state` minted by POST /connect
 * (gmail-connection.ts). It answers with a plain page that says whether the
 * sign-in worked and, if not, what to do (go back to Connections → Gmail with
 * the link on the page and press the button again); a success also sends the
 * browser on to the Gmail page.
 *
 * The chat draft card (gmail-compose.ts) reads one BotBoy draft locally and
 * sends or discards it only from the same-origin owner page, naming the exact
 * message id it showed.
 */

import { Router, type Request, type Response } from 'express';
import type { RouterDeps } from './deps.js';
import { requireLocalOwnerRequest, requireLocalOwnerUiRequest } from './local-owner.js';
import { GmailCredentialInputError } from '../../core/gmail-credentials.js';
import { GmailAuthError, SIGN_IN_REPLAY_MESSAGE, type GmailSignInAction, type GmailSignInResult } from '../../core/gmail-connection.js';
import { GmailComposeError, type GmailComposeErrorCode } from '../../core/gmail-compose.js';
import { GmailImportError } from '../../monitors/gmail-sync.js';
import { deleteGmailAccountMail } from '../../core/gmail-account-mail.js';
import { isGmailAccountId } from '../../core/gmail-credentials.js';

/** An optional account id from a request body; null = missing, false = malformed. */
function accountIdOf(value: unknown): string | null | false {
  if (value === undefined || value === null || value === '') return null;
  return isGmailAccountId(value) ? value : false;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]!));
}

/** The page Google's redirect lands on: what happened, what to do, and the way back. */
function signInPage(page: { title: string; detail: string; todo?: string; ok: boolean; backUrl: string }): string {
  const script = page.ok
    ? `<script>setTimeout(function(){location.replace(${JSON.stringify(page.backUrl).replace(/</g, '\\u003c')})},2500)</script>`
    : '';
  return '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>' + escapeHtml(page.title) + '</title>'
    + '<meta name="viewport" content="width=device-width, initial-scale=1">'
    + '<style>body{font:15px -apple-system,system-ui,sans-serif;max-width:560px;margin:15vh auto;padding:0 20px;color:#1d1d1f}a{color:#0a66c2}h1{font-size:22px}.todo{font-weight:600}</style>'
    + `</head><body><main><h1 role="${page.ok ? 'status' : 'alert'}">${escapeHtml(page.title)}</h1><p>${escapeHtml(page.detail)}</p>`
    + (page.todo ? `<p class="todo">${escapeHtml(page.todo)}</p>` : '')
    + `<p><a href="${escapeHtml(page.backUrl)}">Back to Connections → Gmail</a></p></main>${script}</body></html>`;
}

/**
 * The sentence that tells the owner what to press next (a failure page always
 * carries one). Connect sends BotBoy's own window to Google and Google returns
 * that same window here, so this page IS the BotBoy window: the way back is the
 * link below it, never "close the tab" (that would close BotBoy).
 */
function signInTodo(action: GmailSignInAction | undefined): string {
  const back = 'Use the link below to go back to Connections → Gmail, then';
  if (action === 'drive_connect') return `${back} press Connect Google Drive again.`;
  if (action === 'gmail_connect') return `${back} press Connect Gmail (or Reconnect) again.`;
  return `${back} start the sign-in again.`;
}

/** The page and status code for one callback outcome. */
function signInOutcomePage(result: GmailSignInResult, backUrl: string): { status: number; html: string } {
  const attempt = result.attempt;
  if (result.replay || !attempt) {
    return { status: 400, html: signInPage({ title: 'This sign-in link was already used', detail: SIGN_IN_REPLAY_MESSAGE, ok: false, backUrl }) };
  }
  if (attempt.ok) {
    return { status: 200, html: signInPage({ title: attempt.action === 'drive_connect' ? 'Google Drive connected' : 'Gmail connected', detail: attempt.message, ok: true, backUrl }) };
  }
  if (result.connected) {
    // Gmail is connected; the Drive consent left a box unticked.
    return { status: 200, html: signInPage({ title: 'Google connected, but Drive was not allowed', detail: attempt.message, todo: signInTodo(attempt.action), ok: false, backUrl }) };
  }
  const title = attempt.kind === 'cancelled' ? 'Sign-in cancelled'
    : attempt.action === 'drive_connect' ? 'Google Drive was not connected'
      : attempt.action === 'gmail_connect' ? 'Gmail was not connected'
        : 'Sign-in did not finish';
  const status = attempt.kind === 'network' || attempt.kind === 'timeout' || attempt.kind === 'google_error' ? 502 : 400;
  return { status, html: signInPage({ title, detail: attempt.message, todo: signInTodo(attempt.action), ok: false, backUrl }) };
}

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
    const body = jsonBody(req);
    const unexpected = Object.keys(body).filter(key => key !== 'accountId' && key !== 'addAccount');
    const accountId = accountIdOf(body.accountId);
    if (unexpected.length || accountId === false || (body.addAccount !== undefined && typeof body.addAccount !== 'boolean')) {
      return res.status(400).json({ error: 'Only accountId (a connected account) or addAccount (true) may be sent.', code: 'invalid_request' });
    }
    try {
      return res.json(deps.gmailConnection.beginConnect({
        ...(accountId ? { accountId } : {}),
        ...(body.addAccount === true ? { addAccount: true } : {}),
      }));
    } catch (error) {
      if (error instanceof GmailAuthError) return res.status(409).json({ error: error.message, code: error.code });
      return res.status(500).json({ error: 'BotBoy could not start the Google sign-in.', code: 'internal_error' });
    }
  });

  router.get(GMAIL_OAUTH_CALLBACK_PATH, async (req: Request, res: Response) => {
    if (!requireLocalOwnerRequest(req, res, 'Gmail sign-in')) return;
    if (!deps.gmailConnection) return unavailable(res);
    const query = req.query as Record<string, unknown>;
    const backUrl = `${deps.dashboardOrigin ?? ''}/#/connections/gmail-sync`;
    res.set('Cache-Control', 'no-store');
    res.set('Referrer-Policy', 'no-referrer');
    let result: GmailSignInResult;
    try {
      result = await deps.gmailConnection.completeSignIn({ code: query.code, state: query.state, error: query.error });
    } catch (error) {
      console.error(`[Gmail] Sign-in callback failed: ${error instanceof Error ? error.name : 'Error'}`);
      return res.status(500).send(signInPage({
        title: 'Sign-in could not be finished',
        detail: 'BotBoy could not finish the Google sign-in.',
        todo: signInTodo(undefined),
        ok: false,
        backUrl,
      }));
    }
    // First sync right away; the page shows progress on its next refresh.
    if (result.connected && result.accountId) void deps.gmailSync?.runNow(result.accountId).catch(() => undefined);
    const page = signInOutcomePage(result, backUrl);
    return res.status(page.status).send(page.html);
  });

  // Dismiss one sign-in notice (the result of a Connect attempt) before its 15 minutes end.
  router.post('/gmail-sync/sign-in/dismiss', (req: Request, res: Response) => {
    if (!requireLocalOwnerUiRequest(req, res, 'Dismissing a Gmail sign-in notice', OWNER_UI_NEXT_ACTION)) return;
    if (!deps.gmailSync || !deps.gmailConnection) return unavailable(res);
    res.set('Cache-Control', 'no-store');
    const body = jsonBody(req);
    const unexpected = Object.keys(body).filter(key => key !== 'accountId' && key !== 'action');
    const accountId = accountIdOf(body.accountId);
    const action = body.action;
    if (unexpected.length || accountId === false || (action !== 'gmail_connect' && action !== 'drive_connect' && action !== 'unknown')) {
      return res.status(400).json({ error: 'Only action (gmail_connect, drive_connect, or unknown) and accountId (a connected account) may be sent.', code: 'invalid_request' });
    }
    deps.gmailConnection.dismissSignIn(accountId, action);
    return res.json({ status: deps.gmailSync.getStatus() });
  });

  router.post('/gmail-sync/disconnect', async (req: Request, res: Response) => {
    if (!requireLocalOwnerUiRequest(req, res, 'Disconnecting Gmail', OWNER_UI_NEXT_ACTION)) return;
    if (!deps.gmailSync || !deps.gmailConnection) return unavailable(res);
    res.set('Cache-Control', 'no-store');
    const body = jsonBody(req);
    const unexpected = Object.keys(body).filter(key => key !== 'accountId' && key !== 'deleteMail');
    const accountId = accountIdOf(body.accountId);
    if (unexpected.length || accountId === false || (body.deleteMail !== undefined && typeof body.deleteMail !== 'boolean')) {
      return res.status(400).json({ error: 'Only accountId and deleteMail (true or false) may be sent.', code: 'invalid_request' });
    }
    const target = accountId ?? deps.gmailConnection.accounts()[0]?.id ?? null;
    if (accountId && !deps.gmailConnection.accounts().some(account => account.id === accountId)) {
      return res.status(404).json({ error: 'That Gmail account is not connected.', code: 'not_connected' });
    }
    await deps.gmailConnection.disconnect(target ?? undefined);
    // Captured mail stays unless the owner asked to delete it too.
    const deletedMail = target && body.deleteMail === true && deps.db ? deleteGmailAccountMail(deps.db, target) : 0;
    if (deletedMail) console.log(`[Gmail] Deleted ${deletedMail} captured messages of account ${target} at the owner's request`);
    return res.json({ status: deps.gmailSync.getStatus(), deletedMail });
  });

  router.put('/gmail-sync/accounts/:accountId/label', (req: Request, res: Response) => {
    if (!requireLocalOwnerUiRequest(req, res, 'Naming a Gmail account', OWNER_UI_NEXT_ACTION)) return;
    if (!deps.gmailSync || !deps.gmailConnection) return unavailable(res);
    res.set('Cache-Control', 'no-store');
    const accountId = accountIdOf(req.params.accountId);
    const body = jsonBody(req);
    const unexpected = Object.keys(body).filter(key => key !== 'label');
    if (!accountId || unexpected.length || typeof body.label !== 'string') {
      return res.status(400).json({ error: 'Send only label (text) for a connected account.', code: 'invalid_request' });
    }
    try {
      deps.gmailConnection.setLabel(accountId, body.label);
      return res.json({ status: deps.gmailSync.getStatus() });
    } catch (error) {
      if (error instanceof GmailAuthError) return res.status(404).json({ error: error.message, code: error.code });
      return res.status(500).json({ error: 'BotBoy could not save the label.', code: 'internal_error' });
    }
  });

  // Connect Google Drive: an incremental grant on top of this account's Gmail scopes.
  router.post('/gmail-sync/accounts/:accountId/drive/connect', (req: Request, res: Response) => {
    if (!requireLocalOwnerUiRequest(req, res, 'Connecting Google Drive', OWNER_UI_NEXT_ACTION)) return;
    if (!deps.gmailConnection) return unavailable(res);
    res.set('Cache-Control', 'no-store');
    const accountId = accountIdOf(req.params.accountId);
    if (!accountId) return res.status(400).json({ error: 'Name a connected account.', code: 'invalid_request' });
    try {
      return res.json(deps.gmailConnection.beginConnect({ accountId, purpose: 'drive' }));
    } catch (error) {
      if (error instanceof GmailAuthError) return res.status(409).json({ error: error.message, code: error.code });
      return res.status(500).json({ error: 'BotBoy could not start the Google sign-in.', code: 'internal_error' });
    }
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
    const accountId = accountIdOf(jsonBody(req).accountId);
    if (accountId === false) return res.status(400).json({ error: 'accountId must name a connected account.', code: 'invalid_request' });
    let result;
    try {
      result = await deps.gmailSync.runNow(accountId ?? undefined);
    } catch (error) {
      if (error instanceof GmailImportError) return res.status(404).json({ error: error.message, code: error.code });
      throw error;
    }
    return res.json({ result, status: deps.gmailSync.getStatus() });
  });

  // ── Older-mail import (GMAIL_API_INTEGRATION_PLAN.md §12) ──
  // Owner-started from the Gmail page; the sync lists the window on its next
  // run and works through it in the background, so these answer at once.

  router.post('/gmail-sync/import', (req: Request, res: Response) => {
    if (!requireLocalOwnerUiRequest(req, res, 'Importing older Gmail mail', OWNER_UI_NEXT_ACTION)) return;
    if (!deps.gmailSync) return unavailable(res);
    const body = jsonBody(req);
    const unexpected = Object.keys(body).filter(key => key !== 'months' && key !== 'accountId');
    const accountId = accountIdOf(body.accountId);
    if (unexpected.length || accountId === false) return res.status(400).json({ error: 'Only months and accountId may be sent.', code: 'invalid_request' });
    res.set('Cache-Control', 'no-store');
    try {
      return res.json({ status: deps.gmailSync.requestImport({ months: body.months, ...(accountId ? { accountId } : {}) }) });
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
    const accountId = accountIdOf(typeof req.query.accountId === 'string' ? req.query.accountId : undefined);
    if (accountId === false) return res.status(400).json({ error: 'accountId must name a connected account.', code: 'invalid_request' });
    try {
      return res.json({ status: deps.gmailSync.stopImport(accountId ? { accountId } : {}) });
    } catch (error) {
      if (error instanceof GmailImportError) return res.status(409).json({ error: error.message, code: error.code });
      throw error;
    }
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
