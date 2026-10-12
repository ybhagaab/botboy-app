/**
 * Google Drive publication destination (A7, D3; design §6.3–6.5).
 *
 * Guarantees, same as SharePoint's: owner-UI approval, explicit final Sync,
 * exact-effect receipts, no duplicate write on retry, and an unknown effect is
 * never resent.
 *   - Every file BotBoy creates carries `appProperties.botboyPublicationId`
 *     and `appProperties.botboyIdempotency` (the row's key, persisted before
 *     any network call). Before every create, `findPriorWrite` looks for that
 *     key and adopts an earlier landed write instead of creating again.
 *   - A name clash in the folder with a file that is not this row's is a
 *     target conflict; a file carrying this row's key is adopted.
 *   - `docx` is checked by exact bytes (Drive's sha256Checksum, else md5).
 *     `google_doc` (converted) has no stable bytes, so its text is checked as
 *     a token sequence (`docTokens`), and the receipt says "text verified".
 *   - Drive v3 has no If-Match: a change between observe and write is the same
 *     window the SharePoint path has (documented, not solved).
 */

import { createHash } from 'crypto';
import { GoogleApiError } from '../core/gmail-api.js';
import {
  DOCX_MIME,
  GDRIVE_DOC_MIME,
  GDRIVE_FOLDER_MIME,
  classifyWriteFailure,
  escapeDriveQueryLiteral,
  type DriveClient,
  type DriveFile,
} from '../core/gdrive-api.js';
import {
  PublicationTargetConflict,
  type ObservedRemote,
  type PublicationDestinationProvider,
  type PublicationTarget,
  type WriteOutcome,
} from './publication-destination.js';

/**
 * Exact bytes are the default until a live check proves converted Docs pass
 * `docTokens` (spike S2b); Google Doc stays an opt-in labelled
 * "Google Doc (text checked loosely)".
 */
export const GDRIVE_DEFAULT_STORED_AS: 'docx' | 'google_doc' = 'docx';
/** My Drive › BotBoy, created on first sync. */
export const GDRIVE_BOTBOY_FOLDER = 'botboy';
export const DRIVE_EFFECT_UNKNOWN = 'Drive effect unknown';

const QUOTES: Array<[RegExp, string]> = [
  [/[\u2018\u2019\u201A\u201B\u2032]/g, "'"],
  [/[\u201C\u201D\u201E\u201F\u2033]/g, '"'],
  [/[\u2010-\u2015\u2212]/g, '-'],
];
const DOC_LIST_MARKER = /^(?:\d{1,3}|[a-z]|[ivxlc]{1,6})$/;

/**
 * Normalized word tokens of a text: NFC, typographic quotes and dashes to
 * ASCII, every run that is not a letter or digit becomes a break, case kept.
 * `dropLineStartMarkers` (the converted Doc side only) drops list numbers
 * Docs generates at line starts ("1.", "a)", "iv.").
 */
export function docTokens(text: string, options: { dropLineStartMarkers?: boolean } = {}): string[] {
  let value = String(text ?? '').normalize('NFC');
  for (const [pattern, ascii] of QUOTES) value = value.replace(pattern, ascii);
  const out: string[] = [];
  for (const line of value.split(/\r?\n/)) {
    const tokens = line.replace(/[^\p{L}\p{N}]+/gu, ' ').split(/\s+/).filter(Boolean);
    if (options.dropLineStartMarkers && tokens.length > 1 && DOC_LIST_MARKER.test(tokens[0]) && /^\s*[\p{L}\p{N}]{1,6}[.)]/u.test(line)) tokens.shift();
    out.push(...tokens);
  }
  return out;
}

/** The artifact's body as the DOCX exporter renders it, minus markdown syntax and list markers. */
export function sourceTokensFromMarkdown(markdown: string): string[] {
  const body = String(markdown ?? '')
    .split(/\r?\n/)
    .map(line => line
      .replace(/^\s{0,3}#{1,6}\s+/, '')
      .replace(/^\s*(?:[-*+]|\d{1,3}[.)])\s+/, '')
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1'))
    .join('\n');
  return docTokens(body);
}

export function tokensSha256(tokens: readonly string[]): string {
  return createHash('sha256').update(tokens.join('\u0001')).digest('hex');
}

export function firstMismatchIndex(left: readonly string[], right: readonly string[]): number {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index++) if (left[index] !== right[index]) return index;
  return left.length === right.length ? -1 : length;
}

/** `<folderId>/<filename>` (create) or `file/<fileId>/<filename>` (update). */
function parseAddress(address: string): { kind: 'create'; folderId: string; filename: string } | { kind: 'update'; fileId: string; filename: string } {
  const parts = address.split('/');
  if (parts[0] === 'file' && parts.length >= 3) return { kind: 'update', fileId: parts[1], filename: parts.slice(2).join('/') };
  if (parts.length >= 2) return { kind: 'create', folderId: parts[0], filename: parts.slice(1).join('/') };
  throw new Error('The Drive target address is invalid.');
}

export function createGoogleDriveDestination(deps: {
  clientFor: (accountId: string) => DriveClient | null;
  canPublish: (accountId: string) => boolean;
  accounts: () => string[];
}): PublicationDestinationProvider {
  const drive = (accountId: string | null): DriveClient => {
    const client = accountId && deps.canPublish(accountId) ? deps.clientFor(accountId) : null;
    if (!client) throw new Error('Connect Google Drive on this Google account (Connections → Gmail) to publish there.');
    return client;
  };

  async function botboyFolder(client: DriveClient, create: boolean): Promise<string | null> {
    const found = await client.listFiles({ q: `appProperties has { key='botboyFolder' and value='1' } and mimeType = '${GDRIVE_FOLDER_MIME}' and trashed=false`, pageSize: 5 });
    if (found.files[0]) return found.files[0].id;
    if (!create) return null;
    const folder = await client.createFolder({ name: 'BotBoy', appProperties: { botboyFolder: '1' } });
    return folder.id;
  }

  const snapshotOf = (file: DriveFile, verification: ObservedRemote['verification']): ObservedRemote => ({
    // The ledger binds a 64-hex value: Drive's own sha256, else a hash of the revision identity.
    sha256: /^[a-f0-9]{64}$/i.test(file.sha256Checksum ?? '')
      ? file.sha256Checksum!.toLowerCase()
      : createHash('sha256').update(`md5:${file.md5Checksum ?? ''}|rev:${file.headRevisionId ?? ''}|modified:${file.modifiedTime ?? ''}`).digest('hex'),
    itemId: file.id,
    ...(file.headRevisionId ? { version: file.headRevisionId } : {}),
    ...(file.modifiedTime ? { modified: file.modifiedTime } : {}),
    ...(file.size !== undefined && Number.isFinite(Number(file.size)) ? { size: Number(file.size) } : {}),
    ...(file.webViewLink ? { webUrl: file.webViewLink } : {}),
    observedAt: new Date().toISOString(),
    verification,
  });

  const provider: PublicationDestinationProvider = {
    id: 'gdrive',
    available() {
      return deps.accounts().some(id => deps.canPublish(id))
        ? { ok: true }
        : { ok: false, reason: 'Connect Google Drive on a Google account (Connections → Gmail) to publish there.' };
    },
    validateStageTarget(input) {
      const value = (input ?? {}) as { accountId?: unknown; folderId?: unknown; storedAs?: unknown; filename?: unknown };
      const accountId = typeof value.accountId === 'string' ? value.accountId : '';
      const folderId = typeof value.folderId === 'string' ? value.folderId : GDRIVE_BOTBOY_FOLDER;
      const storedAs = value.storedAs === 'google_doc' || value.storedAs === 'docx' ? value.storedAs : GDRIVE_DEFAULT_STORED_AS;
      if (!deps.canPublish(accountId)) throw new Error('Choose a Google account with Google Drive connected.');
      if (folderId !== GDRIVE_BOTBOY_FOLDER && !/^[A-Za-z0-9_-]{10,128}$/.test(folderId)) throw new Error('The Drive folder id is invalid.');
      const filename = typeof value.filename === 'string' && value.filename.trim() ? value.filename.trim() : 'document.docx';
      return { provider: 'gdrive', container: accountId, address: `${folderId}/${filename}`, storedAs };
    },
    async observe(target, options = {}) {
      const client = drive(target.container);
      const address = parseAddress(target.address);
      if (address.kind === 'update') {
        let file: DriveFile;
        try {
          file = await client.getFile(address.fileId);
        } catch (error) {
          if (error instanceof GoogleApiError && (error.status === 403 || error.status === 404)) {
            throw new PublicationTargetConflict('BotBoy can only update Drive files it published, and this one is not reachable.');
          }
          throw error;
        }
        if (file.trashed) throw new PublicationTargetConflict('The Drive file is in the trash; publish a new copy instead.');
        if (options.expectedItemId && file.id !== options.expectedItemId) throw new PublicationTargetConflict('A different Drive file now holds this publication target.');
        if (!file.appProperties?.botboyPublicationId) throw new PublicationTargetConflict('BotBoy can only update Drive files it published.');
        return snapshotOf(file, target.storedAs === 'google_doc' ? 'normalized_text' : 'exact_bytes');
      }
      const folderId = address.folderId === GDRIVE_BOTBOY_FOLDER ? await botboyFolder(client, false) : address.folderId;
      if (!folderId) return 'absent';
      const names = [address.filename, ...(target.storedAs === 'google_doc' ? [address.filename.replace(/\.docx$/i, '')] : [])];
      for (const name of names) {
        const listed = await client.listFiles({ q: `'${escapeDriveQueryLiteral(folderId)}' in parents and name='${escapeDriveQueryLiteral(name)}' and trashed=false`, pageSize: 10 });
        for (const file of listed.files) {
          if (options.idempotencyKey && file.appProperties?.botboyIdempotency === options.idempotencyKey) {
            return snapshotOf(file, target.storedAs === 'google_doc' ? 'normalized_text' : 'exact_bytes');
          }
          throw new PublicationTargetConflict(`A file named ${name} already exists in that Drive folder; choose another folder or name.`);
        }
      }
      return 'absent';
    },
    async write(input): Promise<WriteOutcome> {
      const client = drive(input.target.container);
      const address = parseAddress(input.target.address);
      try {
        if (address.kind === 'update') {
          const file = await client.updateMedia(address.fileId, { media: input.bytes, mediaMimeType: DOCX_MIME });
          return { kind: 'written', remoteItemId: file.id, ...(file.webViewLink ? { webUrl: file.webViewLink } : {}) };
        }
        if (!input.idempotencyKey) return { kind: 'not_written', reason: 'A Drive publication needs its idempotency key before writing.' };
        const folderId = address.folderId === GDRIVE_BOTBOY_FOLDER ? await botboyFolder(client, true) : address.folderId;
        const converted = input.target.storedAs === 'google_doc';
        const file = await client.createFile({
          name: converted ? address.filename.replace(/\.docx$/i, '') : address.filename,
          parents: [folderId!],
          ...(converted ? { mimeType: GDRIVE_DOC_MIME } : {}),
          appProperties: { botboyPublicationId: input.publicationId, botboyIdempotency: input.idempotencyKey },
          media: input.bytes,
          mediaMimeType: DOCX_MIME,
        });
        return { kind: 'written', remoteItemId: file.id, ...(file.webViewLink ? { webUrl: file.webViewLink } : {}) };
      } catch (error) {
        if (address.kind === 'update' && error instanceof GoogleApiError && (error.status === 403 || error.status === 404)) {
          throw new PublicationTargetConflict('BotBoy can only update Drive files it published.');
        }
        const reason = error instanceof Error ? error.message : String(error);
        return classifyWriteFailure(error) === 'not_written' ? { kind: 'not_written', reason } : { kind: 'unknown', reason };
      }
    },
    async findPriorWrite(target, idempotencyKey) {
      const client = drive(target.container);
      const listed = await client.listFiles({
        q: `appProperties has { key='botboyIdempotency' and value='${escapeDriveQueryLiteral(idempotencyKey)}' } and trashed=false`,
        pageSize: 5,
      });
      const file = listed.files[0];
      return file ? { remoteItemId: file.id, ...(file.webViewLink ? { webUrl: file.webViewLink } : {}) } : null;
    },
    async verify(target, remoteItemId, expected) {
      const client = drive(target.container);
      const file = await client.getFile(remoteItemId);
      const webUrl = file.webViewLink;
      if (target.storedAs === 'google_doc') {
        const text = (await client.exportFile(remoteItemId, 'text/plain')).toString('utf8');
        const remote = docTokens(text, { dropLineStartMarkers: true });
        const ok = Boolean(expected.tokensSha256) && tokensSha256(remote) === expected.tokensSha256;
        return ok
          ? { ok: true, kind: 'normalized_text', webUrl }
          : {
            ok: false,
            kind: 'normalized_text',
            reason: 'The Google Doc text did not match the exported document text',
            webUrl,
            detail: { sourceTokens: expected.tokenCount ?? null, docTokens: remote.length },
          };
      }
      if (file.sha256Checksum) {
        const ok = file.sha256Checksum.toLowerCase() === expected.bytesSha256.toLowerCase();
        return { ok, kind: 'exact_bytes_sha256', webUrl, ...(ok ? {} : { reason: 'Drive file bytes did not match the canonical export' }) };
      }
      if (file.md5Checksum && expected.md5) {
        const ok = file.md5Checksum.toLowerCase() === expected.md5.toLowerCase();
        return { ok, kind: 'exact_bytes_md5', webUrl, ...(ok ? {} : { reason: 'Drive file bytes did not match the canonical export' }) };
      }
      return { ok: false, kind: 'exact_bytes', reason: 'Drive returned no checksum to verify the file against', webUrl };
    },
    captureUrl(target: PublicationTarget, remoteItemId: string) {
      return `gdrive://${target.container}/file/${remoteItemId}`;
    },
  };
  return provider;
}
