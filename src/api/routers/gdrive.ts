/**
 * Google Drive capture settings (NON_AMAZON_PATHS_PLAN.md A6).
 *
 *   GET  /gdrive/status                     per-account Drive state (no secrets)
 *   PUT  /gdrive/accounts/:id/sources       owner picks Files I own / Shared with me / folders
 *   POST /gdrive/accounts/:id/run           capture now
 *
 * Changes need the same-origin owner UI. Folder entries accept a Drive folder
 * id or its https://drive.google.com/drive/folders/<id> address.
 */

import { Router, type Request, type Response } from 'express';
import type { RouterDeps } from './deps.js';
import { requireLocalOwnerRequest, requireLocalOwnerUiRequest } from './local-owner.js';
import { MAX_DRIVE_FOLDERS, isDriveFolderId, isGmailAccountId } from '../../core/gmail-credentials.js';
import { GmailAuthError } from '../../core/gmail-connection.js';

const NEXT = 'Open Connections → Gmail and use the Google Drive controls on the account.';

/** A folder id from a bare id or a Drive folder URL; null when neither. */
export function driveFolderIdOf(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (isDriveFolderId(text)) return text;
  try {
    const url = new URL(text);
    if (url.protocol !== 'https:' || url.hostname !== 'drive.google.com') return null;
    const match = url.pathname.match(/\/folders\/([A-Za-z0-9_-]{10,128})(?:\/|$)/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

export function createGdriveRouter(deps: RouterDeps): Router {
  const router = Router();

  router.get('/gdrive/status', (req: Request, res: Response) => {
    if (!requireLocalOwnerRequest(req, res, 'Google Drive status')) return;
    if (!deps.gdriveSync) return res.status(503).json({ error: 'Google Drive is unavailable.' });
    res.set('Cache-Control', 'no-store');
    res.json({ accounts: deps.gdriveSync.status() });
  });

  router.put('/gdrive/accounts/:accountId/sources', (req: Request, res: Response) => {
    if (!requireLocalOwnerUiRequest(req, res, 'Choosing Google Drive sources', NEXT)) return;
    if (!deps.gdriveSync || !deps.gmailConnection) return res.status(503).json({ error: 'Google Drive is unavailable.' });
    const accountId = req.params.accountId;
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
    const allowed = new Set(['enabled', 'ownedByMe', 'sharedWithMe', 'folders']);
    const unexpected = Object.keys(body).filter(key => !allowed.has(key));
    const bool = (value: unknown) => value === undefined || typeof value === 'boolean';
    if (!isGmailAccountId(accountId) || unexpected.length || !bool(body.enabled) || !bool(body.ownedByMe) || !bool(body.sharedWithMe)
      || (body.folders !== undefined && (!Array.isArray(body.folders) || body.folders.length > MAX_DRIVE_FOLDERS))) {
      return res.status(400).json({ error: `Send enabled, ownedByMe, sharedWithMe (true or false) and up to ${MAX_DRIVE_FOLDERS} folders.`, code: 'invalid_request' });
    }
    const folderIds: string[] = [];
    for (const entry of body.folders ?? []) {
      const id = driveFolderIdOf(entry);
      if (!id) return res.status(400).json({ error: 'Each folder must be a Drive folder id or its drive.google.com/drive/folders/… address.', code: 'invalid_folder' });
      if (!folderIds.includes(id)) folderIds.push(id);
    }
    const account = deps.gmailConnection.slot(accountId);
    if (!account.isConnected()) return res.status(404).json({ error: 'That Google account is not connected.', code: 'not_connected' });
    if (!account.canReadDrive()) {
      return res.status(409).json({ error: 'Connect Google Drive on this account first.', code: 'drive_not_granted', nextAction: NEXT });
    }
    const previous = account.drive();
    try {
      deps.gmailConnection.setDriveSettings(accountId, {
        enabled: body.enabled ?? previous?.enabled ?? true,
        sources: {
          ownedByMe: body.ownedByMe ?? previous?.sources.ownedByMe ?? false,
          sharedWithMe: body.sharedWithMe ?? previous?.sources.sharedWithMe ?? false,
          folderIds: body.folders !== undefined ? folderIds : previous?.sources.folderIds ?? [],
        },
      });
    } catch (error) {
      if (error instanceof GmailAuthError) return res.status(404).json({ error: error.message, code: error.code });
      return res.status(500).json({ error: 'BotBoy could not save the Drive sources.', code: 'internal_error' });
    }
    void deps.gdriveSync.runNow(accountId).catch(() => undefined);
    res.json({ accounts: deps.gdriveSync.status() });
  });

  router.post('/gdrive/accounts/:accountId/run', async (req: Request, res: Response) => {
    if (!requireLocalOwnerUiRequest(req, res, 'Running Google Drive capture', NEXT)) return;
    if (!deps.gdriveSync) return res.status(503).json({ error: 'Google Drive is unavailable.' });
    if (!isGmailAccountId(req.params.accountId)) return res.status(400).json({ error: 'Name a connected account.', code: 'invalid_request' });
    res.json({ accounts: await deps.gdriveSync.runNow(req.params.accountId) });
  });

  return router;
}
