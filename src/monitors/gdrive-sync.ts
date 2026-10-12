/**
 * Google Drive capture (NON_AMAZON_PATHS_PLAN.md A6; design §6.2): the files
 * the owner chose reach projects like mail and Slack do.
 *
 * One sync per Gmail account whose grant includes drive.readonly and whose
 * Drive settings are enabled. Read-only: no Drive file is ever changed.
 *
 * Cursor model (exactly once, restart-safe):
 *   - First run: `changes.getStartPageToken` is saved FIRST, then a bounded
 *     listing of the chosen sources fills a persisted backlog. Edits made
 *     while the listing runs arrive through the changes feed afterwards.
 *   - Every run after that reads `changes.list` from the saved token; changed
 *     files in a chosen source join the backlog, and the backlog is saved
 *     before the token advances.
 *   - A run decides at most 50 backlog files. A decided file leaves the
 *     backlog; a failure stops the run and keeps the file for next time.
 *   - Revision dedup: `(gdrive://<account>/file/<id>, revision)` is checked
 *     before any download, so a re-listed file is never fetched twice.
 *
 * Content rules reused, not re-implemented: credential-named files and text
 * holding a secret format are withheld (sensitive-files.ts), files of 25 MB or
 * more are never downloaded, data/code files become file references without
 * content, and parsed text that is still raw file bytes is refused
 * (raw-file-text.ts). Binaries and Sheets (exported as .xlsx) are parsed by
 * the same DocumentParser extension dispatch the extractor uses.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import type Database from 'better-sqlite3';
import type { RawWorkItem } from '../core/types.js';
import { getSetting, setSetting } from '../core/storage.js';
import type { CaptureHealth } from '../core/capture-health.js';
import type { DocumentParser } from '../core/document-parser.js';
import { GoogleApiError } from '../core/gmail-api.js';
import type { GmailAccountConnection, GmailConnection } from '../core/gmail-connection.js';
import type { StoredDriveSettings } from '../core/gmail-credentials.js';
import {
  GDRIVE_DOC_MIME,
  GDRIVE_EXPORT_LIMIT_BYTES,
  GDRIVE_FOLDER_MIME,
  GDRIVE_SHEET_MIME,
  GDRIVE_SLIDES_MIME,
  XLSX_MIME,
  createDriveClient,
  driveFailureForHealth,
  escapeDriveQueryLiteral,
  type DriveClient,
  type DriveFile,
} from '../core/gdrive-api.js';
import { describeSecretKinds, detectSecrets, sensitiveLocalPathReason } from '../core/sensitive-files.js';
import { isRawFileText } from '../core/raw-file-text.js';
import { isReferenceRole, localFileRoleForPath } from '../core/file-references.js';

/** Same owner rule as local folders (D7): 25 MB or more is never downloaded. */
export const GDRIVE_BIG_FILE_BYTES = 25 * 1024 * 1024;
const FILE_WINDOW_DAYS = 30;
const MAX_FOLDER_DEPTH = 10;
const MAX_FOLDERS_PER_ACCOUNT = 5_000;
const RUN_BUDGET = 50;
const RUN_INTERVAL_MS = 60_000;
const MAX_BACKOFF_MS = 10 * 60_000;
const PARENT_HOPS = 10;
const BINARY_DOCUMENT_EXTS = new Set(['.pdf', '.docx', '.doc', '.xlsx', '.xls', '.pptx', '.ppt', '.rtf', '.odt']);

export function gdriveItemUrl(accountId: string, fileId: string): string {
  return `gdrive://${accountId}/file/${fileId}`;
}

/** The revision a capture is keyed by: Drive's head revision, else the content hash, else the edit time. */
export function driveRevisionOf(file: DriveFile): string {
  return file.headRevisionId || file.md5Checksum || file.modifiedTime || 'unknown';
}

function keysFor(accountId: string) {
  const prefix = `gdrive_sync.acct.${accountId}`;
  return {
    startPageToken: `${prefix}.startPageToken`,
    backlog: `${prefix}.backlog`,
    lastRunAt: `${prefix}.lastRunAt`,
    listedSources: `${prefix}.listedSources`,
    lastRun: `${prefix}.lastRun`,
  };
}

export type DriveExportPlan =
  | { kind: 'export'; mimeType: string; fallbackMimeType?: string; parseAs?: string }
  | { kind: 'download'; parseAs: string }
  | { kind: 'stub'; reason: string }
  | { kind: 'skip' };

/** How one Drive file becomes text (design §6.2 export table). */
export function driveExportPlan(file: Pick<DriveFile, 'mimeType' | 'name'>): DriveExportPlan {
  switch (file.mimeType) {
    case GDRIVE_FOLDER_MIME: return { kind: 'skip' };
    case GDRIVE_DOC_MIME: return { kind: 'export', mimeType: 'text/markdown', fallbackMimeType: 'text/plain' };
    case GDRIVE_SHEET_MIME: return { kind: 'export', mimeType: XLSX_MIME, parseAs: '.xlsx' };
    case GDRIVE_SLIDES_MIME: return { kind: 'export', mimeType: 'text/plain' };
    default:
      if (file.mimeType.startsWith('application/vnd.google-apps.')) return { kind: 'stub', reason: 'google_type_without_text' };
      return { kind: 'download', parseAs: path.extname(file.name || '').toLowerCase() || '.bin' };
  }
}

export interface GdriveAccountStatus {
  accountId: string;
  email: string | null;
  canReadDrive: boolean;
  enabled: boolean;
  sources: StoredDriveSettings['sources'] | null;
  backlog: number;
  lastRunAt: string | null;
  lastError: string | null;
  captured: number;
  notes: string[];
}

export interface GdriveSyncs {
  start(): void;
  stop(): void;
  runNow(accountId?: string): Promise<GdriveAccountStatus[]>;
  status(): GdriveAccountStatus[];
  /** Captures one file regardless of chosen sources (BotBoy's own published file). */
  captureFile(accountId: string, fileId: string, extraMetadata?: Record<string, string>): Promise<{ url: string; emitted: boolean }>;
  /** A Drive client for one account (the publication destination and chat tools share it). */
  clientFor(accountId: string): DriveClient | null;
  /** One file's text through the capture rules (export table, withholding, size limits); nothing is stored. */
  readFile(accountId: string, fileId: string): Promise<{ file: DriveFile; content: string; tier: string; withheld: boolean }>;
}

export function createGdriveSyncs(deps: {
  db: Database.Database;
  connection: GmailConnection;
  emit: (item: RawWorkItem) => void;
  /** Awaited store for BotBoy's own published file (its capture is the publication's completion). */
  emitAndWait?: (item: RawWorkItem) => Promise<void>;
  captureHealth?: Pick<CaptureHealth, 'reportSuccess' | 'reportFailure'>;
  parser?: Pick<DocumentParser, 'parse' | 'parseAsync'>;
  now?: () => number;
  tmpDir?: string;
  /** Tests inject a fake Drive per account. */
  driveClientFor?: (account: GmailAccountConnection) => DriveClient;
  /** Whether a capture of this url+revision exists (default: work_items metadata). */
  hasCaptured?: (url: string, revision: string) => boolean;
  intervalMs?: number;
}): GdriveSyncs {
  const { db } = deps;
  const now = deps.now ?? Date.now;
  const tmpRoot = deps.tmpDir ?? path.join(os.homedir(), '.personal-productivity-tracker', 'tmp', 'gdrive');
  const clientFor = (account: GmailAccountConnection): DriveClient => deps.driveClientFor?.(account) ?? createDriveClient({
    accessToken: () => account.accessToken(),
    invalidateAccessToken: () => account.invalidateAccessToken(),
  });
  const capturedStmt = db.prepare("SELECT 1 FROM work_items WHERE url = ? AND json_extract(CASE WHEN json_valid(metadata) THEN metadata ELSE '{}' END, '$.driveRevision') = ? LIMIT 1");
  const hasCaptured = deps.hasCaptured ?? ((url: string, revision: string) => Boolean(capturedStmt.get(url, revision)));
  const runtime = new Map<string, { lastError: string | null; captured: number; notes: string[]; backoffMs: number; nextRunAt: number }>();
  const rt = (id: string) => {
    let entry = runtime.get(id);
    if (!entry) { entry = { lastError: null, captured: 0, notes: [], backoffMs: 0, nextRunAt: 0 }; runtime.set(id, entry); }
    return entry;
  };
  let timer: ReturnType<typeof setInterval> | null = null;
  let running: Promise<unknown> | null = null;

  const eligible = (account: GmailAccountConnection) => account.isConnected() && account.canReadDrive() && account.drive()?.enabled === true;

  function readBacklog(accountId: string): string[] {
    const value = getSetting<string[]>(db, keysFor(accountId).backlog);
    return Array.isArray(value) ? value.filter(id => typeof id === 'string') : [];
  }
  function writeBacklog(accountId: string, ids: string[]): void {
    setSetting(db, keysFor(accountId).backlog, [...new Set(ids)]);
  }
  const sourcesSignature = (sources: StoredDriveSettings['sources']) => JSON.stringify([sources.ownedByMe, sources.sharedWithMe, [...sources.folderIds].sort()]);

  async function listAll(drive: DriveClient, q: string, fields?: string): Promise<DriveFile[]> {
    const out: DriveFile[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < 200; page++) {
      const result = await drive.listFiles({ q, pageToken, pageSize: 1000, ...(fields ? { fields } : {}) });
      out.push(...result.files);
      pageToken = result.nextPageToken;
      if (!pageToken) break;
    }
    return out;
  }

  /** First listing of the chosen sources (bounded). Folders are always traversed; only files are time-filtered. */
  async function initialListing(drive: DriveClient, accountId: string, sources: StoredDriveSettings['sources']): Promise<string[]> {
    const since = new Date(now() - FILE_WINDOW_DAYS * 86_400_000).toISOString();
    const notFolder = `mimeType != '${GDRIVE_FOLDER_MIME}'`;
    const ids: string[] = [];
    if (sources.ownedByMe) {
      for (const file of await listAll(drive, `'me' in owners and trashed=false and ${notFolder} and modifiedTime > '${since}'`, 'id')) ids.push(file.id);
    }
    if (sources.sharedWithMe) {
      for (const file of await listAll(drive, `sharedWithMe=true and trashed=false and ${notFolder} and modifiedTime > '${since}'`, 'id')) ids.push(file.id);
    }
    let visited = 0;
    let truncated = false;
    for (const root of sources.folderIds) {
      let level = [root];
      for (let depth = 0; depth <= MAX_FOLDER_DEPTH && level.length; depth++) {
        const next: string[] = [];
        for (const folderId of level) {
          if (visited >= MAX_FOLDERS_PER_ACCOUNT) { truncated = true; break; }
          visited++;
          const literal = escapeDriveQueryLiteral(folderId);
          for (const file of await listAll(drive, `'${literal}' in parents and ${notFolder} and trashed=false and modifiedTime > '${since}'`, 'id')) ids.push(file.id);
          if (depth < MAX_FOLDER_DEPTH) {
            for (const child of await listAll(drive, `'${literal}' in parents and mimeType = '${GDRIVE_FOLDER_MIME}' and trashed=false`, 'id')) next.push(child.id);
          }
        }
        level = next;
      }
    }
    if (truncated) rt(accountId).notes = ['listing_truncated: more than 5,000 folders; deeper folders were not listed'];
    return ids;
  }

  /** Is this file in one of the chosen sources? Folder membership walks parents (≤10 hops, cached per run). */
  async function inSources(drive: DriveClient, file: DriveFile, sources: StoredDriveSettings['sources'], ownerEmail: string | null, parentCache: Map<string, string[]>): Promise<boolean> {
    if (file.mimeType === GDRIVE_FOLDER_MIME || file.trashed) return false;
    const ownedByMe = file.ownedByMe === true
      || Boolean(ownerEmail && file.owners?.some(owner => owner.emailAddress?.toLowerCase() === ownerEmail));
    if (sources.ownedByMe && ownedByMe) return true;
    if (sources.sharedWithMe && !ownedByMe && file.sharedWithMeTime) return true;
    if (!sources.folderIds.length) return false;
    const wanted = new Set(sources.folderIds);
    let frontier = file.parents ?? [];
    for (let hop = 0; hop < PARENT_HOPS && frontier.length; hop++) {
      if (frontier.some(id => wanted.has(id))) return true;
      const next: string[] = [];
      for (const id of frontier) {
        let parents = parentCache.get(id);
        if (!parents) {
          try { parents = (await drive.getFile(id, 'id,parents')).parents ?? []; } catch { parents = []; }
          parentCache.set(id, parents);
        }
        next.push(...parents);
      }
      frontier = next;
    }
    return false;
  }

  function stubContent(file: DriveFile, line: string): string {
    return `SOURCE: Google Drive\nFile: ${file.name}\nType: ${file.mimeType}\n${line}`;
  }

  async function parseTemp(fileId: string, ext: string, bytes: Buffer): Promise<string | null> {
    if (!deps.parser) return null;
    fs.mkdirSync(tmpRoot, { recursive: true, mode: 0o700 });
    const safeExt = /^\.[a-z0-9]{1,8}$/.test(ext) ? ext : '.bin';
    const temp = path.join(tmpRoot, `${fileId.replace(/[^A-Za-z0-9_-]/g, '')}${safeExt}`);
    fs.writeFileSync(temp, bytes, { mode: 0o600 });
    try {
      const parsed = deps.parser.parseAsync ? await deps.parser.parseAsync(temp) : deps.parser.parse(temp);
      if (!parsed.success) return null;
      const text = parsed.text ?? '';
      if (BINARY_DOCUMENT_EXTS.has(safeExt) && isRawFileText(text)) return null;
      return text;
    } finally {
      try { fs.rmSync(temp, { force: true }); } catch { /* best effort */ }
    }
  }

  /** Text for a file plus the tier, or a stub line. Never throws for content problems; API failures propagate. */
  async function contentOf(drive: DriveClient, file: DriveFile): Promise<{ content: string; tier: string; type: RawWorkItem['type']; hold?: string }> {
    const size = Number(file.size ?? 0);
    // A Drive name has no folder; `.env` alone has no extension to Node, so it is named here.
    const sensitive = sensitiveLocalPathReason(file.name || '', Number.isFinite(size) ? size : undefined)
      ?? (/^\.env(?:\..*)?$/i.test(file.name || '') ? `Named like an environment file (${file.name})` : null);
    if (sensitive) {
      return { content: stubContent(file, `Content withheld: ${sensitive}. BotBoy keeps this file's text out of storage and never sends it to an AI model.`), tier: 'withheld', type: 'document_capture', hold: sensitive };
    }
    const plan = driveExportPlan(file);
    if (plan.kind === 'skip') return { content: '', tier: 'skip', type: 'document_capture' };
    if (plan.kind === 'stub') return { content: stubContent(file, 'This Google file type has no text BotBoy can read. Open it in Drive to view.'), tier: 'metadata_only', type: 'document_capture' };
    if (plan.kind === 'download') {
      const role = localFileRoleForPath(file.name || '');
      if (isReferenceRole(role)) {
        return { content: stubContent(file, `Data or code file (${role}); BotBoy records where it is and does not read it.`), tier: 'reference', type: 'file_reference' };
      }
      if (size >= GDRIVE_BIG_FILE_BYTES) {
        return { content: stubContent(file, `Large file (${Math.round(size / 1024 / 1024)} MB): not downloaded. Open it in Drive to view.`), tier: 'metadata_only', type: 'document_capture' };
      }
    }
    let text: string | null;
    try {
      if (plan.kind === 'export') {
        let bytes: Buffer;
        try {
          bytes = await drive.exportFile(file.id, plan.mimeType);
        } catch (error) {
          if (plan.fallbackMimeType && error instanceof GoogleApiError && error.status === 400) bytes = await drive.exportFile(file.id, plan.fallbackMimeType);
          else throw error;
        }
        if (bytes.length > GDRIVE_EXPORT_LIMIT_BYTES) throw new GoogleApiError('export too large', 403, 'exportSizeLimitExceeded');
        text = plan.parseAs ? await parseTemp(file.id, plan.parseAs, bytes) : bytes.toString('utf8');
      } else {
        text = await parseTemp(file.id, plan.parseAs, await drive.downloadFile(file.id));
      }
    } catch (error) {
      if (error instanceof GoogleApiError && /exportSizeLimitExceeded/i.test(error.code)) {
        return { content: stubContent(file, 'Too large for Google to export as text (export_too_large). Open it in Drive to view.'), tier: 'export_too_large', type: 'document_capture' };
      }
      throw error;
    }
    if (text == null) return { content: stubContent(file, 'BotBoy could not read text from this file.'), tier: 'metadata_only', type: 'document_capture' };
    const secrets = detectSecrets(text);
    if (secrets.length) {
      const reason = describeSecretKinds(secrets);
      return { content: stubContent(file, `Content withheld: ${reason}. BotBoy keeps this file's text out of storage and never sends it to an AI model.`), tier: 'withheld', type: 'document_capture', hold: reason };
    }
    return { content: `SOURCE: Google Drive\nFile: ${file.name}\n\n${text}`, tier: 'full', type: 'document_capture' };
  }

  async function captureOne(account: GmailAccountConnection, drive: DriveClient, file: DriveFile, extra: Record<string, string> = {}, awaited = false): Promise<boolean> {
    const url = gdriveItemUrl(account.id, file.id);
    const revision = driveRevisionOf(file);
    // BotBoy's own published file is always stored once more: its capture carries the publication lineage.
    if (!awaited && hasCaptured(url, revision)) return false;
    const body = await contentOf(drive, file);
    if (body.tier === 'skip') return false;
    const metadata: Record<string, string> = {
      source: 'gdrive',
      accountId: account.id,
      fileId: file.id,
      mimeType: file.mimeType,
      driveRevision: revision,
      extractionTier: body.tier,
      ...extra,
    };
    if (file.headRevisionId) metadata.headRevisionId = file.headRevisionId;
    if (file.webViewLink) metadata.webViewLink = file.webViewLink;
    if (file.modifiedTime) metadata.modifiedTime = file.modifiedTime;
    if (file.owners?.length) metadata.owners = file.owners.map(owner => owner.emailAddress ?? owner.displayName ?? '').filter(Boolean).join(', ');
    if (body.hold) metadata.sensitiveHold = body.hold;
    // A reference is one row per path, updated in place (file-references.ts); its path is the Drive identity.
    if (body.type === 'file_reference') metadata.filePath = url;
    const item: RawWorkItem = {
      type: body.type,
      source: 'gdrive',
      sourceApp: 'Google Drive',
      url,
      title: file.name,
      content: body.content,
      metadata,
      capturedAt: new Date(now()),
    };
    if (awaited && deps.emitAndWait) await deps.emitAndWait(item);
    else deps.emit(item);
    return true;
  }

  async function runAccount(account: GmailAccountConnection): Promise<void> {
    const state = rt(account.id);
    const settings = account.drive();
    if (!eligible(account) || !settings) return;
    if (state.nextRunAt > now()) return;
    const keys = keysFor(account.id);
    const drive = clientFor(account);
    try {
      let token = getSetting<string>(db, keys.startPageToken);
      const signature = sourcesSignature(settings.sources);
      if (!token) {
        // Cursor first: edits during the listing come through the feed later.
        token = await drive.getStartPageToken();
        setSetting(db, keys.startPageToken, token);
      }
      if (getSetting<string>(db, keys.listedSources) !== signature) {
        const ids = await initialListing(drive, account.id, settings.sources);
        writeBacklog(account.id, [...readBacklog(account.id), ...ids]);
        setSetting(db, keys.listedSources, signature);
      }
      // Changes feed: changed files in a chosen source join the backlog, saved before the token moves.
      const parentCache = new Map<string, string[]>();
      const ownerEmail = account.accountEmail();
      for (let page = 0; page < 50; page++) {
        const result = await drive.listChanges(token!);
        const add: string[] = [];
        for (const change of result.changes) {
          if (change.removed || !change.file || change.file.trashed) continue; // capture is append-only evidence
          if (await inSources(drive, change.file, settings.sources, ownerEmail, parentCache)) add.push(change.fileId);
        }
        if (add.length) writeBacklog(account.id, [...readBacklog(account.id), ...add]);
        token = result.nextPageToken ?? result.newStartPageToken ?? token;
        setSetting(db, keys.startPageToken, token);
        if (!result.nextPageToken) break;
      }
      // Drain.
      const backlog = readBacklog(account.id);
      let decided = 0;
      while (backlog.length && decided < RUN_BUDGET) {
        const fileId = backlog[0];
        let file: DriveFile | null = null;
        try {
          file = await drive.getFile(fileId);
        } catch (error) {
          if (error instanceof GoogleApiError && error.status === 404) file = null; // gone or not visible: decided
          else throw error;
        }
        if (file && !file.trashed && await captureOne(account, drive, file)) state.captured++;
        backlog.shift();
        writeBacklog(account.id, backlog);
        decided++;
      }
      setSetting(db, keys.lastRunAt, new Date(now()).toISOString());
      state.lastError = null;
      state.backoffMs = 0;
      state.nextRunAt = 0;
      deps.captureHealth?.reportSuccess('gdrive');
    } catch (error) {
      const failure = driveFailureForHealth(error);
      state.lastError = failure.reason;
      if (failure.kind === 'rate_limited') {
        state.backoffMs = Math.min(MAX_BACKOFF_MS, state.backoffMs ? state.backoffMs * 2 : 60_000);
        state.nextRunAt = now() + state.backoffMs;
      }
      deps.captureHealth?.reportFailure('gdrive', failure);
      console.warn(`[GoogleDrive] ${account.id} run failed: ${failure.reason.slice(0, 160)}`);
    }
  }

  function accountsList(): GmailAccountConnection[] {
    return deps.connection.accounts().map(summary => deps.connection.slot(summary.id));
  }

  function status(): GdriveAccountStatus[] {
    return accountsList().map(account => {
      const state = rt(account.id);
      const drive = account.drive();
      return {
        accountId: account.id,
        email: account.accountEmail(),
        canReadDrive: account.canReadDrive(),
        enabled: drive?.enabled === true,
        sources: drive?.sources ?? null,
        backlog: readBacklog(account.id).length,
        lastRunAt: getSetting<string>(db, keysFor(account.id).lastRunAt) ?? null,
        lastError: state.lastError,
        captured: state.captured,
        notes: state.notes,
      };
    });
  }

  async function runAll(accountId?: string): Promise<GdriveAccountStatus[]> {
    if (running) await running.catch(() => undefined);
    const work = (async () => {
      for (const account of accountsList()) {
        if (accountId && account.id !== accountId) continue;
        if (accountId) rt(account.id).nextRunAt = 0;
        await runAccount(account);
      }
    })();
    running = work;
    try { await work; } finally { if (running === work) running = null; }
    return status();
  }

  return {
    start() {
      if (timer) return;
      timer = setInterval(() => { void runAll().catch(() => undefined); }, deps.intervalMs ?? RUN_INTERVAL_MS);
      timer.unref?.();
      void runAll().catch(() => undefined);
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
    runNow: runAll,
    status,
    async captureFile(accountId, fileId, extraMetadata) {
      const account = deps.connection.slot(accountId);
      const url = gdriveItemUrl(accountId, fileId);
      if (!account.isConnected()) throw new Error('That Google account is not connected.');
      const drive = clientFor(account);
      const file = await drive.getFile(fileId);
      return { url, emitted: await captureOne(account, drive, file, extraMetadata, true) };
    },
    clientFor(accountId) {
      const account = deps.connection.slot(accountId);
      return account.isConnected() ? clientFor(account) : null;
    },
    async readFile(accountId, fileId) {
      const account = deps.connection.slot(accountId);
      if (!account.isConnected() || !account.canReadDrive()) throw new Error('Google Drive is not connected on that account.');
      const drive = clientFor(account);
      const file = await drive.getFile(fileId);
      const body = await contentOf(drive, file);
      return { file, content: body.content, tier: body.tier, withheld: body.tier === 'withheld' };
    },
  };
}
