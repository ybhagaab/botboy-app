/**
 * The per-call environment every Google tool handler gets (google-workspace.md):
 * the call and its arguments, the owner's accounts, each account's Drive and
 * Workspace clients, and the local-file policy. Account choice lives here:
 *   - search: every account with Drive (or the one named);
 *   - a file id: the named account, else each account until one finds it;
 *   - something new (create, upload): the named account, else the only one.
 */

import type { ToolCall } from './llm-client.js';
import type { ToolExecutionContext, ToolResult } from './tool-executor.js';
import { gmailAccountName, type GmailAccountSummary, type GmailConnection } from './gmail-connection.js';
import type { DriveFile, FullDriveClient } from './gdrive-api.js';
import { GDRIVE_FILE_FIELDS } from './gdrive-api.js';
import type { GoogleWorkspaceClients } from './google-workspace-api.js';
import type { LocalFilePolicy } from './gdrive-local-files.js';
import { DRIVE_ID_PATTERN, fileIdFrom, googleErrorFailure, invalid, type GoogleFailure } from './google-tool-support.js';

export interface CaptureRead {
  file: DriveFile;
  content: string;
  tier: string;
  withheld: boolean;
}

export interface GoogleToolEnv {
  call: ToolCall;
  args: Record<string, unknown>;
  context: ToolExecutionContext | undefined;
  now: () => number;
  connection: GmailConnection;
  driveFor(accountId: string): FullDriveClient | null;
  workspaceFor(accountId: string): GoogleWorkspaceClients | null;
  /** The capture pipeline's text for a file (export table, withholding, size limits). */
  readCaptureText(accountId: string, fileId: string): Promise<CaptureRead>;
  local: LocalFilePolicy;
  /** Receipts of creates already made in this request, by create key (the in-turn duplicate guard). */
  created: Map<string, unknown>;
  /**
   * Markdown that has pictures or diagrams, as a Word file for Drive to convert into a Doc
   * (product-manager/document-exporter.ts › markdownToWordForGoogle); null keeps Markdown import.
   */
  wordFromMarkdown?(markdown: string): Promise<{ data: Buffer; media: { pictures: number; diagrams: number; embedded: number; problems: Array<{ line: number; kind: string; message: string }> } } | null>;
}

export type Need = 'read' | 'edit' | 'calendar';

function usable(account: GmailAccountSummary, need: Need): boolean {
  if (account.needsReconnect) return false;
  if (need === 'read') return account.canReadDrive;
  if (need === 'edit') return account.canEditDrive;
  return account.canUseCalendar;
}

function needText(need: Need): string {
  return need === 'calendar' ? 'Google Calendar' : need === 'edit' ? 'full Google Drive access' : 'Google Drive';
}

/** Why no account can do this, with the next action. */
function noAccountFailure(accounts: GmailAccountSummary[], need: Need): GoogleFailure {
  if (!accounts.length) {
    return { code: 'drive_not_connected', message: 'No Google account is connected.', effect: 'none', nextAction: 'Tell the owner to connect Gmail and then Google Drive on Connections → Gmail.' };
  }
  const reconnect = accounts.filter(account => account.needsReconnect);
  if (reconnect.length === accounts.length) {
    return { code: 'reconnect_required', message: `Google ended BotBoy’s access to ${reconnect.map(gmailAccountName).join(', ')}.`, effect: 'none', nextAction: 'Tell the owner to press Reconnect on Connections → Gmail.' };
  }
  if (need === 'edit' && accounts.some(account => account.canReadDrive && !account.needsReconnect)) {
    return {
      code: 'drive_edit_not_allowed',
      message: 'BotBoy’s Google access can read Drive but not create, change, move or share files yet (it was connected before full Drive access existed).',
      effect: 'none',
      nextAction: 'Tell the owner to press Connect Google Drive on Connections → Gmail and leave the Drive and Calendar boxes ticked, then ask again.',
    };
  }
  if (need === 'calendar') {
    return {
      code: 'calendar_not_connected',
      message: 'Google Calendar is not connected.',
      effect: 'none',
      nextAction: 'Tell the owner to press Connect Google Drive on Connections → Gmail and tick the Calendar box (it comes with Drive access).',
    };
  }
  return { code: 'drive_not_connected', message: `${needText(need)} is not connected.`, effect: 'none', nextAction: 'Tell the owner to choose Connect Google Drive on Connections → Gmail.' };
}

/** The accounts this call may use: the one named in `account`, else all usable ones. */
export function accountsFor(env: GoogleToolEnv, need: Need): { ids: string[] } | { failure: GoogleFailure } {
  const accounts = env.connection.accounts();
  const ready = accounts.filter(account => usable(account, need));
  const wanted = typeof env.args.account === 'string' ? env.args.account.trim().toLowerCase() : '';
  if (!ready.length) return { failure: noAccountFailure(accounts, need) };
  if (!wanted) return { ids: ready.map(account => account.id) };
  const match = ready.find(account => account.id === wanted || account.email === wanted || (account.label && account.label.toLowerCase() === wanted));
  if (!match) {
    const known = accounts.find(account => account.id === wanted || account.email === wanted || (account.label && account.label.toLowerCase() === wanted));
    if (known) return { failure: noAccountFailure([known], need) };
    return { failure: invalid(`"${wanted.slice(0, 80)}" is not a connected Google account with ${needText(need)}.`, [{ path: 'account', message: `one of: ${ready.map(gmailAccountName).join(', ')}` }]) };
  }
  return { ids: [match.id] };
}

/** One account for something new: the named one, else the only one. */
export function singleAccountFor(env: GoogleToolEnv, need: Need): { id: string } | { failure: GoogleFailure } {
  const picked = accountsFor(env, need);
  if ('failure' in picked) return picked;
  if (picked.ids.length > 1) {
    const names = env.connection.accounts().filter(account => picked.ids.includes(account.id)).map(gmailAccountName);
    return { failure: invalid('Several Google accounts are connected; say which one.', [{ path: 'account', message: `one of: ${names.join(', ')}` }], 'Call again with account set to the address or label the owner means (ask them if unclear).') };
  }
  return { id: picked.ids[0] };
}

export function accountEmail(env: GoogleToolEnv, accountId: string): string {
  return env.connection.accounts().find(account => account.id === accountId)?.email ?? accountId;
}

/** A file found in one account, with that account's Drive client. */
export interface LocatedFile {
  accountId: string;
  drive: FullDriveClient;
  file: DriveFile;
}

/** The file behind an id or link: tries each allowed account until one finds it. */
export async function locateFile(env: GoogleToolEnv, raw: unknown, need: Need, field = 'fileId'): Promise<LocatedFile | { failure: GoogleFailure }> {
  const fileId = fileIdFrom(raw);
  if (!DRIVE_ID_PATTERN.test(fileId)) return { failure: invalid(`${field} must be a Drive file id (or a Google link to the file).`, [{ path: field, message: 'an id from gdrive_search, or the id in a docs.google.com / drive.google.com link' }], 'Find the file with gdrive_search, then call again with its fileId.') };
  const picked = accountsFor(env, need);
  if ('failure' in picked) return picked;
  let lastFailure: GoogleFailure | null = null;
  for (const accountId of picked.ids) {
    const drive = env.driveFor(accountId);
    if (!drive) continue;
    try {
      const file = await drive.getFile(fileId, `${GDRIVE_FILE_FIELDS},description,starred,capabilities(canEdit,canComment,canShare,canTrash,canRename,canMoveItemWithinDrive),exportLinks`);
      return { accountId, drive, file };
    } catch (error) {
      lastFailure = googleErrorFailure(error, false, 'That file');
      if (lastFailure.code !== 'not_found' && lastFailure.code !== 'no_permission') return { failure: lastFailure };
    }
  }
  return { failure: lastFailure ?? { code: 'not_found', message: 'Google found no file with that id in the connected accounts.', effect: 'none', nextAction: 'Find it with gdrive_search; if the owner pasted a link, use the id in it.' } };
}

export function failedResult(env: GoogleToolEnv, failure: GoogleFailure): ToolResult {
  return {
    toolCallId: env.call.id,
    content: JSON.stringify({ ok: false, tool: env.call.function.name, status: 'failed', code: failure.code, message: failure.message, effect: failure.effect, ...(failure.issues?.length ? { issues: failure.issues } : {}), nextAction: failure.nextAction, ...(failure.detail ?? {}) }, null, 1),
    isError: true,
  };
}
