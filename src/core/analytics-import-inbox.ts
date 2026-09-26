import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import type { DocumentParser, SheetReadResult } from './document-parser.js';
import { readAnalyticsDataRoomVersion } from './analytics-data-room-version.js';

const execFileAsync = promisify(execFile);

export const ANALYTICS_IMPORT_MAX_BYTES = 64 * 1024 * 1024;
export const ANALYTICS_IMPORT_PREVIEW_MAX_ROWS = 200;
export const ANALYTICS_IMPORT_PREVIEW_MAX_CHARS = 20_000;
export const ANALYTICS_IMPORT_MEDIA_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

const DEFAULT_IMPORT_ROOT = path.join(os.homedir(), '.personal-productivity-tracker', 'data-room', 'imports');
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const IMPORT_ID_RE = /^dri_[a-f0-9]{24}$/;
const REQUEST_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{7,127}$/;
const MAX_FILENAME_LENGTH = 180;
const MAX_ZIP_MEMBERS = 4_096;
const MAX_ZIP_MEMBER_NAME = 512;
const MAX_INVENTORY_BYTES = 128 * 1024;
const MAX_PREVIEW_JSON_BYTES = 256 * 1024;

export type AnalyticsImportInboxErrorCode =
  | 'invalid_input'
  | 'unsupported_type'
  | 'too_large'
  | 'conflict'
  | 'not_found'
  | 'integrity_failed'
  | 'aborted'
  | 'unavailable';

export class AnalyticsImportInboxError extends Error {
  constructor(
    readonly code: AnalyticsImportInboxErrorCode,
    message: string,
    readonly nextAction?: string,
  ) {
    super(message);
    this.name = 'AnalyticsImportInboxError';
  }
}

export type AnalyticsImportStatus = 'receiving' | 'uploaded' | 'inspecting' | 'ready' | 'failed';

export interface AnalyticsImportPreview {
  sheetName: string;
  rows: string[][];
  rowsShown: number;
  rowsTotal: number | null;
  charsShown: number;
  truncation: {
    rowsCut: boolean;
    charsCut: boolean;
    sharedStringsBudgetHit: boolean;
  };
  formulaCellsInPreview: number;
  complete: false;
  limitations: string[];
}

export interface AnalyticsImportSummary {
  id: string;
  revision: number;
  status: AnalyticsImportStatus;
  sourceKind: 'upload';
  originalName: string;
  mediaType: typeof ANALYTICS_IMPORT_MEDIA_TYPE;
  sourceBytes?: number;
  sourceSha256?: string;
  sheetCount: number;
  selectedSheet?: string;
  error?: { code: string; message: string; nextAction?: string };
  createdAt: string;
  updatedAt: string;
  uploadedAt?: string;
  inspectedAt?: string;
}

export interface AnalyticsImportDetail extends AnalyticsImportSummary {
  sheets: string[];
  preview?: AnalyticsImportPreview;
}

export interface AnalyticsImportSourceAvailability {
  upload: {
    status: 'enabled';
    formats: ['.xlsx'];
    maxBytes: number;
  };
  captured: {
    status: 'unavailable';
    observedWorkbookCount: number;
    reason: string;
    nextAction: string;
  };
  email: {
    status: 'unavailable';
    reportedAttachmentMessages: number;
    reason: string;
    nextAction: string;
  };
}

export interface AnalyticsImportListEnvelope {
  imports: AnalyticsImportSummary[];
  count: number;
  truncated: boolean;
  sources: AnalyticsImportSourceAvailability;
  dataRoomVersion: string;
}

export interface AnalyticsImportDetailEnvelope {
  importItem: AnalyticsImportDetail;
  dataRoomVersion: string;
  replayed?: boolean;
}

export interface AnalyticsImportInbox {
  readonly rootDir: string;
  list(input?: { limit?: number }): AnalyticsImportListEnvelope;
  get(importId: string): AnalyticsImportDetailEnvelope | null;
  uploadXlsx(input: {
    originalName: string;
    mediaType: string;
    requestId: string;
    chunks: AsyncIterable<Uint8Array>;
    signal?: AbortSignal;
  }): Promise<AnalyticsImportDetailEnvelope>;
  inspectSheet(input: {
    importId: string;
    expectedRevision: number;
    sheetName: string;
    signal?: AbortSignal;
  }): Promise<AnalyticsImportDetailEnvelope>;
  recoverInterrupted(): number;
}

/** Internal-only exact candidate receipt. Never serialize sourcePath or sourceRelPath. */
export interface AnalyticsImportCandidateSnapshot {
  id: string;
  revision: number;
  originalName: string;
  selectedSheet: string;
  sourcePath: string;
  sourceRelPath: string;
  sourceSha256: string;
  sourceBytes: number;
  sheetInventory: string[];
  sheetInventorySha256: string;
}

export interface AnalyticsImportCandidateReader {
  readVerifiedCandidate(input: { importId: string; expectedRevision?: number }): AnalyticsImportCandidateSnapshot;
}

interface ImportRow {
  id: string;
  owner_request_id: string;
  request_identity_sha256: string;
  revision: number;
  status: AnalyticsImportStatus;
  source_kind: 'upload';
  original_name: string;
  media_type: typeof ANALYTICS_IMPORT_MEDIA_TYPE;
  source_rel_path: string;
  source_sha256: string | null;
  source_bytes: number | null;
  sheet_inventory_json: string | null;
  sheet_inventory_sha256: string | null;
  selected_sheet: string | null;
  preview_json: string | null;
  preview_sha256: string | null;
  error_code: string | null;
  error_message: string | null;
  next_action: string | null;
  created_at: string;
  updated_at: string;
  uploaded_at: string | null;
  inspected_at: string | null;
}

function fail(code: AnalyticsImportInboxErrorCode, message: string, nextAction?: string): never {
  throw new AnalyticsImportInboxError(code, message, nextAction);
}

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(value);
}

function parseJson<T>(value: string | null, label: string): T | null {
  if (value === null) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    fail('integrity_failed', `Stored ${label} is not valid JSON.`, 'Restart BotBoy and inspect this import again.');
  }
}

function assertPrivateDirectory(directory: string): void {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    fail('integrity_failed', 'Import storage is not a private directory.', 'Move the conflicting path aside, then restart BotBoy.');
  }
  if ((stat.mode & 0o077) !== 0) {
    fail('integrity_failed', 'Import directory permissions are not owner-only.', 'Restore owner-only permissions, then retry.');
  }
}

function ensurePrivateDirectory(directory: string): void {
  fs.mkdirSync(directory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    fail('integrity_failed', 'Import storage is not a private directory.', 'Move the conflicting path aside, then restart BotBoy.');
  }
  fs.chmodSync(directory, PRIVATE_DIRECTORY_MODE);
  assertPrivateDirectory(directory);
}

function syncDirectory(directory: string): void {
  let descriptor: number | null = null;
  try {
    descriptor = fs.openSync(directory, 'r');
    fs.fsyncSync(descriptor);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'EINVAL' && code !== 'ENOTSUP') throw error;
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
  }
}

function hashFile(filePath: string): { sha256: string; bytes: number } {
  const descriptor = fs.openSync(filePath, 'r');
  const digest = createHash('sha256');
  const chunk = Buffer.allocUnsafe(1024 * 1024);
  let bytes = 0;
  try {
    while (true) {
      const count = fs.readSync(descriptor, chunk, 0, chunk.length, null);
      if (!count) break;
      digest.update(chunk.subarray(0, count));
      bytes += count;
    }
  } finally {
    fs.closeSync(descriptor);
  }
  return { sha256: digest.digest('hex'), bytes };
}

function verifyPrivateFile(filePath: string, expectedSha256: string, expectedBytes: number): void {
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    fail('integrity_failed', 'The staged workbook is no longer a regular file.', 'Upload the workbook again with a new request.');
  }
  if ((stat.mode & 0o077) !== 0) {
    fail('integrity_failed', 'The staged workbook permissions are not owner-only.', 'Restore owner-only permissions before retrying inspection.');
  }
  const actual = hashFile(filePath);
  if (actual.bytes !== expectedBytes || actual.sha256 !== expectedSha256) {
    fail('integrity_failed', 'The staged workbook no longer matches its immutable receipt.', 'Upload the workbook again with a new request.');
  }
}

function removeBestEffort(target: string): void {
  try {
    fs.rmSync(target, { recursive: true, force: true });
  } catch {
    // The durable failed row remains owner-visible with a retry action.
  }
}

function abortError(): AnalyticsImportInboxError {
  return new AnalyticsImportInboxError(
    'aborted',
    'Workbook intake was interrupted before completion.',
    'Choose the workbook and upload it again.',
  );
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

function normalizeError(error: unknown): AnalyticsImportInboxError {
  if (error instanceof AnalyticsImportInboxError) return error;
  if ((error as { name?: string })?.name === 'AbortError') return abortError();
  return new AnalyticsImportInboxError(
    'invalid_input',
    'The workbook could not be inspected as a valid .xlsx file.',
    'Open and resave it as .xlsx, then upload it with a new request.',
  );
}

function safeFilename(value: string): string {
  const name = String(value ?? '');
  if (!name || name.length > MAX_FILENAME_LENGTH || name !== name.trim()
    || /[\0-\x1f\x7f/\\]/.test(name) || path.basename(name) !== name) {
    fail('invalid_input', 'filename must be a plain local filename from 1 to 180 characters.');
  }
  if (path.extname(name).toLowerCase() !== '.xlsx') {
    fail('unsupported_type', 'Only .xlsx workbooks are supported in this Import Inbox.', 'Save the file as .xlsx before uploading it.');
  }
  return name;
}

function requestId(value: string): string {
  const id = String(value ?? '');
  if (!REQUEST_ID_RE.test(id)) {
    fail('invalid_input', 'requestId must be 8–128 safe characters.');
  }
  return id;
}

function mediaType(value: string): typeof ANALYTICS_IMPORT_MEDIA_TYPE {
  const normalized = String(value ?? '').split(';', 1)[0].trim().toLowerCase();
  if (normalized !== ANALYTICS_IMPORT_MEDIA_TYPE) {
    fail('unsupported_type', 'The upload Content-Type must identify an .xlsx workbook.', 'Choose an .xlsx file and retry.');
  }
  return ANALYTICS_IMPORT_MEDIA_TYPE;
}

function importId(value: string): string {
  const id = String(value ?? '');
  if (!IMPORT_ID_RE.test(id)) fail('invalid_input', 'Import ID is malformed.');
  return id;
}

function limitValue(value: number | undefined): number {
  const limit = value ?? 25;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    fail('invalid_input', 'limit must be an integer from 1 to 100.');
  }
  return limit;
}

function expectedRevision(value: number): number {
  if (!Number.isInteger(value) || value < 1) fail('invalid_input', 'expectedRevision must be a positive integer.');
  return value;
}

function safeSheetName(value: string): string {
  const sheet = String(value ?? '');
  if (!sheet || sheet.length > 128 || /[\0-\x1f\x7f]/.test(sheet)) {
    fail('invalid_input', 'sheetName must identify one inventoried worksheet.');
  }
  return sheet;
}

function candidateRelativePath(id: string): string {
  return `${id}/source.xlsx`;
}

function relativePath(rootDir: string, target: string): string {
  const relative = path.relative(rootDir, target);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    fail('integrity_failed', 'Import storage path escapes the private root.');
  }
  return relative;
}

function resolveRelative(rootDir: string, stored: string): string {
  if (!stored || path.isAbsolute(stored)) fail('integrity_failed', 'Stored import path is not relative.');
  const resolved = path.resolve(rootDir, stored);
  const relative = path.relative(rootDir, resolved);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    fail('integrity_failed', 'Stored import path escapes the private root.');
  }
  return resolved;
}

async function listAndValidateZipMembers(filePath: string, signal?: AbortSignal): Promise<string[]> {
  throwIfAborted(signal);
  const signature = Buffer.alloc(4);
  const descriptor = fs.openSync(filePath, 'r');
  try {
    const count = fs.readSync(descriptor, signature, 0, signature.length, 0);
    if (count !== 4 || !signature.equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) {
      fail('invalid_input', 'The upload is not an .xlsx ZIP container.', 'Open and resave it as .xlsx, then retry.');
    }
  } finally {
    fs.closeSync(descriptor);
  }

  let stdout: string;
  try {
    const result = await execFileAsync('unzip', ['-Z1', filePath], {
      encoding: 'utf8',
      timeout: 30_000,
      maxBuffer: 2 * 1024 * 1024,
      signal,
    });
    stdout = String(result.stdout);
  } catch (error) {
    if (signal?.aborted || (error as { name?: string })?.name === 'AbortError') throw abortError();
    fail('invalid_input', 'The upload is not a readable .xlsx container.', 'Open and resave it as .xlsx, then retry.');
  }

  const members = stdout.split('\n').map(value => value.trim()).filter(Boolean);
  if (!members.length || members.length > MAX_ZIP_MEMBERS) {
    fail('invalid_input', 'The workbook ZIP member inventory is empty or exceeds the safe inspection limit.');
  }
  const seen = new Set<string>();
  for (const member of members) {
    const pieces = member.split('/');
    if (member.length > MAX_ZIP_MEMBER_NAME || member.startsWith('/') || member.includes('\\')
      || member.includes('\0') || pieces.some(piece => piece === '..') || seen.has(member)) {
      fail('invalid_input', 'The workbook contains an unsafe or duplicate ZIP member name.');
    }
    seen.add(member);
  }
  for (const required of ['[Content_Types].xml', 'xl/workbook.xml', 'xl/_rels/workbook.xml.rels']) {
    if (!seen.has(required)) fail('invalid_input', 'The upload is missing a required .xlsx workbook part.');
  }
  return members;
}

async function writeChunk(handle: fs.promises.FileHandle, bytes: Uint8Array): Promise<void> {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  let offset = 0;
  while (offset < buffer.length) {
    const result = await handle.write(buffer, offset, buffer.length - offset, null);
    if (result.bytesWritten <= 0) throw new Error('Workbook write made no progress.');
    offset += result.bytesWritten;
  }
}

export function createAnalyticsImportInbox(input: {
  db: Database.Database;
  documentParser: DocumentParser;
  rootDir?: string;
  now?: () => Date;
  createId?: () => string;
  /** Test/contained-server seam; production always uses the 64 MiB default. */
  maxUploadBytes?: number;
}): AnalyticsImportInbox & AnalyticsImportCandidateReader {
  const db = input.db;
  const documentParser = input.documentParser;
  const rootDir = path.resolve(input.rootDir ?? DEFAULT_IMPORT_ROOT);
  const now = input.now ?? (() => new Date());
  const createId = input.createId ?? (() => randomUUID().replace(/-/g, '').slice(0, 24));
  const maxUploadBytes = input.maxUploadBytes ?? ANALYTICS_IMPORT_MAX_BYTES;
  if (!Number.isSafeInteger(maxUploadBytes) || maxUploadBytes < 1 || maxUploadBytes > ANALYTICS_IMPORT_MAX_BYTES) {
    fail('invalid_input', 'Import upload limit is invalid.');
  }
  ensurePrivateDirectory(rootDir);

  function timestamp(): string {
    return now().toISOString();
  }

  function bumpRoomRevision(at: string): void {
    const result = db.prepare(`
      UPDATE analytics_data_room_state
      SET revision = revision + 1, updated_at = ?
      WHERE singleton = 1
    `).run(at);
    if (result.changes !== 1) fail('integrity_failed', 'Data Room revision state is unavailable.');
  }

  function rowById(id: string): ImportRow | undefined {
    return db.prepare('SELECT * FROM analytics_import_inbox_items WHERE id = ?').get(id) as ImportRow | undefined;
  }

  function rowByRequestId(id: string): ImportRow | undefined {
    return db.prepare('SELECT * FROM analytics_import_inbox_items WHERE owner_request_id = ?').get(id) as ImportRow | undefined;
  }

  function inventoryOf(row: ImportRow): string[] {
    const inventory = parseJson<string[]>(row.sheet_inventory_json, `import ${row.id} sheet inventory`) ?? [];
    if (!Array.isArray(inventory) || inventory.some(name => typeof name !== 'string')
      || (row.sheet_inventory_sha256 && sha256(canonicalJson(inventory)) !== row.sheet_inventory_sha256)) {
      fail('integrity_failed', 'Stored workbook inventory failed verification.');
    }
    return inventory;
  }

  function previewOf(row: ImportRow): AnalyticsImportPreview | undefined {
    const preview = parseJson<AnalyticsImportPreview>(row.preview_json, `import ${row.id} preview`) ?? undefined;
    if (preview && (!row.preview_sha256 || sha256(canonicalJson(preview)) !== row.preview_sha256)) {
      fail('integrity_failed', 'Stored workbook preview failed verification.');
    }
    return preview;
  }

  function summary(row: ImportRow): AnalyticsImportSummary {
    const sheets = inventoryOf(row);
    return {
      id: row.id,
      revision: Number(row.revision),
      status: row.status,
      sourceKind: row.source_kind,
      originalName: row.original_name,
      mediaType: row.media_type,
      ...(row.source_bytes !== null ? { sourceBytes: Number(row.source_bytes) } : {}),
      ...(row.source_sha256 ? { sourceSha256: row.source_sha256 } : {}),
      sheetCount: sheets.length,
      ...(row.selected_sheet ? { selectedSheet: row.selected_sheet } : {}),
      ...(row.error_code && row.error_message ? {
        error: {
          code: row.error_code,
          message: row.error_message,
          ...(row.next_action ? { nextAction: row.next_action } : {}),
        },
      } : {}),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      ...(row.uploaded_at ? { uploadedAt: row.uploaded_at } : {}),
      ...(row.inspected_at ? { inspectedAt: row.inspected_at } : {}),
    };
  }

  function detail(row: ImportRow): AnalyticsImportDetail {
    const sheets = inventoryOf(row);
    const preview = previewOf(row);
    return { ...summary(row), sheets, ...(preview ? { preview } : {}) };
  }

  function countWhere(sql: string): number {
    try {
      const row = db.prepare(sql).get() as { count: number } | undefined;
      return Number(row?.count ?? 0);
    } catch {
      return 0;
    }
  }

  function sources(): AnalyticsImportSourceAvailability {
    const observedWorkbookCount = countWhere(`
      SELECT COUNT(*) AS count FROM work_items
      WHERE source IN ('filesystem','sharepoint')
        AND (
          LOWER(COALESCE(json_extract(metadata, '$.fileType'), '')) IN ('xlsx','.xlsx')
          OR LOWER(COALESCE(url, '')) LIKE '%.xlsx'
        )
    `);
    const reportedAttachmentMessages = countWhere(`
      SELECT COUNT(*) AS count FROM work_items
      WHERE source = 'grasp'
        AND LOWER(COALESCE(json_extract(metadata, '$.hasAttachments'), '')) = 'true'
    `);
    return {
      upload: { status: 'enabled', formats: ['.xlsx'], maxBytes: maxUploadBytes },
      captured: {
        status: 'unavailable',
        observedWorkbookCount,
        reason: 'Captured paths are mutable and their stored content hash covers extracted text, not original workbook bytes.',
        nextAction: 'R6.3 will snapshot one exact captured or SharePoint workbook before intake.',
      },
      email: {
        status: 'unavailable',
        reportedAttachmentMessages,
        reason: 'Mail capture reports coarse attachment presence but not authoritative attachment identity, type, size, or bytes.',
        nextAction: 'R6.4 will inventory and download one exact attachment before intake.',
      },
    };
  }

  function envelopeForRow(row: ImportRow): AnalyticsImportDetailEnvelope {
    return { importItem: detail(row), dataRoomVersion: readAnalyticsDataRoomVersion(db) };
  }

  function list(inputValue: { limit?: number } = {}): AnalyticsImportListEnvelope {
    const limit = limitValue(inputValue.limit);
    return db.transaction(() => {
      const count = Number((db.prepare('SELECT COUNT(*) AS count FROM analytics_import_inbox_items').get() as { count: number }).count);
      const rows = db.prepare(`
        SELECT * FROM analytics_import_inbox_items
        ORDER BY updated_at DESC, id DESC
        LIMIT ?
      `).all(limit) as ImportRow[];
      return {
        imports: rows.map(summary),
        count,
        truncated: count > rows.length,
        sources: sources(),
        dataRoomVersion: readAnalyticsDataRoomVersion(db),
      };
    })();
  }

  function get(idValue: string): AnalyticsImportDetailEnvelope | null {
    const id = importId(idValue);
    return db.transaction(() => {
      const row = rowById(id);
      return row ? envelopeForRow(row) : null;
    })();
  }

  function markUploadFailed(id: string, error: AnalyticsImportInboxError): void {
    const at = timestamp();
    db.transaction(() => {
      const result = db.prepare(`
        UPDATE analytics_import_inbox_items
        SET status = 'failed', revision = revision + 1,
            error_code = ?, error_message = ?, next_action = ?, updated_at = ?
        WHERE id = ? AND status = 'receiving'
      `).run(error.code, error.message, error.nextAction ?? null, at, id);
      if (result.changes === 1) bumpRoomRevision(at);
    })();
  }

  async function uploadXlsx(upload: {
    originalName: string;
    mediaType: string;
    requestId: string;
    chunks: AsyncIterable<Uint8Array>;
    signal?: AbortSignal;
  }): Promise<AnalyticsImportDetailEnvelope> {
    const name = safeFilename(upload.originalName);
    const mime = mediaType(upload.mediaType);
    const ownerRequestId = requestId(upload.requestId);
    const requestIdentitySha256 = sha256(canonicalJson({ name, mime }));
    throwIfAborted(upload.signal);

    const existing = rowByRequestId(ownerRequestId);
    if (existing) {
      if (existing.request_identity_sha256 !== requestIdentitySha256) {
        fail('conflict', 'requestId was already used for a different workbook request.', 'Choose the file again to create a new upload request.');
      }
      if (existing.status === 'receiving') {
        fail('conflict', 'This workbook request is already receiving bytes.', 'Wait for the current upload to settle before retrying.');
      }
      return { ...db.transaction(() => envelopeForRow(existing))(), replayed: true };
    }

    const id = `dri_${createId()}`;
    if (!IMPORT_ID_RE.test(id)) fail('integrity_failed', 'Import ID generator returned an invalid identity.');
    const candidateDirectory = path.join(rootDir, id);
    const stagingDirectory = path.join(candidateDirectory, 'staging');
    ensurePrivateDirectory(candidateDirectory);
    ensurePrivateDirectory(stagingDirectory);
    const finalPath = path.join(candidateDirectory, 'source.xlsx');
    const storedRelativePath = relativePath(rootDir, finalPath);
    if (storedRelativePath !== candidateRelativePath(id)) fail('integrity_failed', 'Import storage identity is inconsistent.');
    const temporaryPath = path.join(stagingDirectory, `${randomUUID()}.part`);
    const createdAt = timestamp();

    try {
      db.transaction(() => {
        db.prepare(`
          INSERT INTO analytics_import_inbox_items (
            id, owner_request_id, request_identity_sha256, revision, status, source_kind,
            original_name, media_type, source_rel_path, created_at, updated_at
          ) VALUES (?, ?, ?, 1, 'receiving', 'upload', ?, ?, ?, ?, ?)
        `).run(id, ownerRequestId, requestIdentitySha256, name, mime, storedRelativePath, createdAt, createdAt);
        bumpRoomRevision(createdAt);
      })();
    } catch (error) {
      removeBestEffort(candidateDirectory);
      if (rowByRequestId(ownerRequestId)) {
        fail('conflict', 'requestId was accepted by another upload.', 'Wait for that upload to settle before retrying.');
      }
      throw error;
    }

    let handle: fs.promises.FileHandle | null = null;
    let finalized = false;
    try {
      handle = await fs.promises.open(temporaryPath, 'wx', PRIVATE_FILE_MODE);
      const digest = createHash('sha256');
      let bytes = 0;
      for await (const chunk of upload.chunks) {
        throwIfAborted(upload.signal);
        const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        if (!value.length) continue;
        bytes += value.length;
        if (bytes > maxUploadBytes) {
          fail('too_large', `Workbook exceeds the ${Math.ceil(maxUploadBytes / 1024 / 1024)} MiB Import Inbox limit.`, 'Choose a smaller .xlsx workbook.');
        }
        digest.update(value);
        await writeChunk(handle, value);
      }
      throwIfAborted(upload.signal);
      if (!bytes) fail('invalid_input', 'Workbook upload body is empty.', 'Choose an .xlsx workbook and retry.');
      await handle.sync();
      await handle.close();
      handle = null;
      fs.chmodSync(temporaryPath, PRIVATE_FILE_MODE);
      const sourceSha256 = digest.digest('hex');
      await listAndValidateZipMembers(temporaryPath, upload.signal);
      if (!documentParser.parseXlsxSheet) {
        fail('unavailable', 'Workbook inspection is unavailable.', 'Restart BotBoy after rebuilding the application.');
      }
      const inventoryResult = await documentParser.parseXlsxSheet(temporaryPath, {
        signal: upload.signal,
        requireCompleteRelationships: true,
      });
      const inventory = inventoryResult.sheets.map(sheet => sheet.name);
      if (!inventory.length || new Set(inventory.map(name => name.toLowerCase())).size !== inventory.length) {
        fail('invalid_input', 'Workbook must contain uniquely named readable worksheets.');
      }
      const inventoryJson = canonicalJson(inventory);
      if (Buffer.byteLength(inventoryJson) > MAX_INVENTORY_BYTES) {
        fail('invalid_input', 'Workbook sheet inventory exceeds the safe inspection limit.');
      }
      throwIfAborted(upload.signal);
      if (fs.existsSync(finalPath)) fail('integrity_failed', 'Import identity already owns workbook bytes.');
      fs.renameSync(temporaryPath, finalPath);
      fs.chmodSync(finalPath, PRIVATE_FILE_MODE);
      syncDirectory(candidateDirectory);
      verifyPrivateFile(finalPath, sourceSha256, bytes);
      finalized = true;

      const uploadedAt = timestamp();
      db.transaction(() => {
        const result = db.prepare(`
          UPDATE analytics_import_inbox_items
          SET status = 'uploaded', revision = revision + 1,
              source_sha256 = ?, source_bytes = ?,
              sheet_inventory_json = ?, sheet_inventory_sha256 = ?,
              error_code = NULL, error_message = NULL, next_action = NULL,
              uploaded_at = ?, updated_at = ?
          WHERE id = ? AND status = 'receiving' AND revision = 1
        `).run(sourceSha256, bytes, inventoryJson, sha256(inventoryJson), uploadedAt, uploadedAt, id);
        if (result.changes !== 1) fail('conflict', 'Import state changed before upload completion.');
        bumpRoomRevision(uploadedAt);
      })();
      // The durable row now owns the finalized bytes. Projection failures must
      // never remove a committed source and leave an uploaded receipt broken.
      finalized = false;
      const row = rowById(id);
      if (!row) fail('integrity_failed', 'Uploaded import disappeared from its ledger.');
      return envelopeForRow(row);
    } catch (error) {
      const normalized = normalizeError(error);
      try { await handle?.close(); } catch {}
      handle = null;
      removeBestEffort(temporaryPath);
      if (finalized) removeBestEffort(finalPath);
      markUploadFailed(id, normalized);
      throw normalized;
    } finally {
      try { await handle?.close(); } catch {}
      removeBestEffort(temporaryPath);
    }
  }

  function sameInventory(expected: string[], actual: SheetReadResult['sheets']): boolean {
    return canonicalJson(expected) === canonicalJson(actual.map(sheet => sheet.name));
  }

  function boundedPreviewRows(rows: string[][]): {
    rows: string[][];
    charsShown: number;
    rowsCut: boolean;
    charsCut: boolean;
  } {
    const bounded: string[][] = [];
    let charsShown = 0;
    let rowsCut = false;
    let charsCut = false;
    let stop = false;
    for (let rowIndex = 0; rowIndex < rows.length && !stop; rowIndex++) {
      if (bounded.length >= ANALYTICS_IMPORT_PREVIEW_MAX_ROWS) {
        rowsCut = true;
        break;
      }
      const sourceRow = rows[rowIndex];
      const outputRow: string[] = [];
      for (let columnIndex = 0; columnIndex < sourceRow.length; columnIndex++) {
        const value = sourceRow[columnIndex];
        const remaining = ANALYTICS_IMPORT_PREVIEW_MAX_CHARS - charsShown;
        if (remaining <= 1) {
          charsCut = true;
          stop = true;
          break;
        }
        if (value.length + 1 > remaining) {
          let clipped = value.slice(0, remaining - 1);
          const finalCodeUnit = clipped.charCodeAt(clipped.length - 1);
          if (finalCodeUnit >= 0xd800 && finalCodeUnit <= 0xdbff) clipped = clipped.slice(0, -1);
          if (clipped.length) {
            outputRow.push(clipped);
            charsShown += clipped.length + 1;
          }
          charsCut = true;
          stop = true;
          break;
        }
        outputRow.push(value);
        charsShown += value.length + 1;
        if (charsShown >= ANALYTICS_IMPORT_PREVIEW_MAX_CHARS
          && (columnIndex + 1 < sourceRow.length || rowIndex + 1 < rows.length)) {
          charsCut = true;
          stop = true;
          break;
        }
      }
      if (outputRow.length) bounded.push(outputRow);
    }
    if (!stop && bounded.length < rows.length) rowsCut = true;
    return { rows: bounded, charsShown, rowsCut, charsCut };
  }

  async function inspectSheet(inspect: {
    importId: string;
    expectedRevision: number;
    sheetName: string;
    signal?: AbortSignal;
  }): Promise<AnalyticsImportDetailEnvelope> {
    const id = importId(inspect.importId);
    const revision = expectedRevision(inspect.expectedRevision);
    const sheetName = safeSheetName(inspect.sheetName);
    throwIfAborted(inspect.signal);
    if (!documentParser.parseXlsxSheet) {
      fail('unavailable', 'Workbook inspection is unavailable.', 'Restart BotBoy after rebuilding the application.');
    }

    const started = db.transaction(() => {
      const row = rowById(id);
      if (!row) fail('not_found', 'Import candidate was not found.');
      if (row.revision !== revision) {
        fail('conflict', 'Import candidate changed since this page was loaded.', 'Reload the candidate and choose the sheet again.');
      }
      if (!row.source_sha256 || row.source_bytes === null || !row.sheet_inventory_json) {
        fail('conflict', 'Import candidate has no verified workbook bytes.', 'Upload the workbook again with a new request.');
      }
      if (row.status === 'receiving' || row.status === 'inspecting') {
        fail('conflict', 'Import candidate is already busy.', 'Wait for the current operation to settle.');
      }
      const inventory = inventoryOf(row);
      const exactSheet = inventory.find(name => name === sheetName);
      if (!exactSheet) fail('invalid_input', 'sheetName is not in this workbook inventory.', 'Reload the candidate and select an available sheet.');
      const at = timestamp();
      const result = db.prepare(`
        UPDATE analytics_import_inbox_items
        SET status = 'inspecting', revision = revision + 1,
            selected_sheet = NULL, preview_json = NULL, preview_sha256 = NULL, inspected_at = NULL,
            error_code = NULL, error_message = NULL, next_action = NULL, updated_at = ?
        WHERE id = ? AND revision = ? AND status IN ('uploaded','ready','failed')
      `).run(at, id, revision);
      if (result.changes !== 1) fail('conflict', 'Import candidate changed before inspection started.');
      bumpRoomRevision(at);
      return { row, inventory, operationRevision: revision + 1 };
    })();

    try {
      const sourcePath = resolveRelative(rootDir, started.row.source_rel_path);
      verifyPrivateFile(sourcePath, started.row.source_sha256!, Number(started.row.source_bytes));
      const result = await documentParser.parseXlsxSheet(sourcePath, {
        sheet: sheetName,
        maxRows: ANALYTICS_IMPORT_PREVIEW_MAX_ROWS,
        maxChars: ANALYTICS_IMPORT_PREVIEW_MAX_CHARS,
        signal: inspect.signal,
        requireCompleteRelationships: true,
      });
      throwIfAborted(inspect.signal);
      if (!sameInventory(started.inventory, result.sheets) || !result.sheet || result.sheet.name !== sheetName) {
        fail('integrity_failed', 'Workbook inventory changed during inspection.', 'Upload the workbook again with a new request.');
      }
      const bounded = boundedPreviewRows(result.sheet.rows);
      const preview: AnalyticsImportPreview = {
        sheetName: result.sheet.name,
        rows: bounded.rows,
        rowsShown: bounded.rows.length,
        rowsTotal: result.sheet.rowsTotal,
        charsShown: bounded.charsShown,
        truncation: {
          rowsCut: result.sheet.truncation.rowsCut || bounded.rowsCut,
          charsCut: result.sheet.truncation.charsCut || bounded.charsCut,
          sharedStringsBudgetHit: result.sheet.truncation.sharedStringsBudgetHit,
        },
        formulaCellsInPreview: result.sheet.formulaCells,
        complete: false,
        limitations: [
          'Preview is bounded to 200 non-empty rows and 20,000 characters.',
          'Cells are display strings; sparse coordinates, empty rows, and trailing empty cells are not preserved.',
          'Formula cells use cached workbook values and are not recalculated.',
          'Date conversion uses the parser’s current 1900-date-system behavior.',
          'This preview is not a complete typed dataset and cannot power a dashboard.',
        ],
      };
      const previewJson = canonicalJson(preview);
      if (Buffer.byteLength(previewJson) > MAX_PREVIEW_JSON_BYTES) {
        fail('too_large', 'Bounded workbook preview exceeds the safe response limit.', 'Choose a smaller sheet for preview.');
      }
      const completedAt = timestamp();
      db.transaction(() => {
        const update = db.prepare(`
          UPDATE analytics_import_inbox_items
          SET status = 'ready', revision = revision + 1,
              selected_sheet = ?, preview_json = ?, preview_sha256 = ?,
              error_code = NULL, error_message = NULL, next_action = NULL,
              inspected_at = ?, updated_at = ?
          WHERE id = ? AND status = 'inspecting' AND revision = ?
        `).run(sheetName, previewJson, sha256(previewJson), completedAt, completedAt, id, started.operationRevision);
        if (update.changes !== 1) fail('conflict', 'Import candidate changed before inspection completed.');
        bumpRoomRevision(completedAt);
      })();
      const row = rowById(id);
      if (!row) fail('integrity_failed', 'Inspected import disappeared from its ledger.');
      return envelopeForRow(row);
    } catch (error) {
      const normalized = normalizeError(error);
      const failedAt = timestamp();
      db.transaction(() => {
        const update = db.prepare(`
          UPDATE analytics_import_inbox_items
          SET status = 'failed', revision = revision + 1,
              error_code = ?, error_message = ?, next_action = ?, updated_at = ?
          WHERE id = ? AND status = 'inspecting' AND revision = ?
        `).run(normalized.code, normalized.message, normalized.nextAction ?? null, failedAt, id, started.operationRevision);
        if (update.changes === 1) bumpRoomRevision(failedAt);
      })();
      throw normalized;
    }
  }

  function readVerifiedCandidate(inputValue: { importId: string; expectedRevision?: number }): AnalyticsImportCandidateSnapshot {
    const id = importId(inputValue.importId);
    return db.transaction(() => {
      const row = rowById(id);
      if (!row) fail('not_found', 'Import candidate was not found.');
      if (inputValue.expectedRevision !== undefined) {
        const revision = expectedRevision(inputValue.expectedRevision);
        if (row.revision !== revision) {
          fail('conflict', 'Import candidate changed since semantic processing started.', 'Reload the candidate and prepare a new review.');
        }
      }
      if (row.status !== 'ready' || !row.selected_sheet || !row.source_sha256 || row.source_bytes === null
        || !row.sheet_inventory_sha256 || !row.sheet_inventory_json) {
        fail('conflict', 'Import candidate is not ready for complete semantic processing.', 'Select and inspect one worksheet first.');
      }
      const sheetInventory = inventoryOf(row);
      if (!sheetInventory.includes(row.selected_sheet)) {
        fail('integrity_failed', 'Selected worksheet is absent from the verified inventory.', 'Inspect the workbook again.');
      }
      const sourcePath = resolveRelative(rootDir, row.source_rel_path);
      verifyPrivateFile(sourcePath, row.source_sha256, Number(row.source_bytes));
      return {
        id: row.id,
        revision: Number(row.revision),
        originalName: row.original_name,
        selectedSheet: row.selected_sheet,
        sourcePath,
        sourceRelPath: row.source_rel_path,
        sourceSha256: row.source_sha256,
        sourceBytes: Number(row.source_bytes),
        sheetInventory,
        sheetInventorySha256: row.sheet_inventory_sha256,
      };
    })();
  }

  function recoverInterrupted(): number {
    let rows: ImportRow[];
    try {
      rows = db.prepare(`
        SELECT * FROM analytics_import_inbox_items
        WHERE status IN ('receiving','inspecting')
        ORDER BY id
      `).all() as ImportRow[];
    } catch {
      return 0;
    }
    if (!rows.length) return 0;
    const recoveries = rows.map(row => {
      try {
        const sourcePath = resolveRelative(rootDir, row.source_rel_path);
        const candidateDirectory = path.dirname(sourcePath);
        if (row.status === 'receiving') {
          // A crash may land after rename but before the uploaded transaction.
          // With no committed hash receipt those bytes are unowned, so remove
          // the whole generated candidate directory rather than preserve an
          // unverifiable source.xlsx orphan.
          removeBestEffort(candidateDirectory);
          return {
            row,
            status: 'failed' as const,
            errorCode: 'aborted',
            message: 'BotBoy restarted before workbook upload completed.',
            nextAction: 'Choose the workbook and upload it again with a new request.',
          };
        }
        removeBestEffort(path.join(candidateDirectory, 'staging'));
        if (!row.source_sha256 || row.source_bytes === null) {
          fail('integrity_failed', 'Interrupted inspection has no immutable source receipt.');
        }
        verifyPrivateFile(sourcePath, row.source_sha256, Number(row.source_bytes));
        return {
          row,
          status: 'uploaded' as const,
          errorCode: 'aborted',
          message: 'BotBoy restarted before workbook inspection completed; source bytes were reverified.',
          nextAction: 'Select the sheet and inspect it again.',
        };
      } catch {
        return {
          row,
          status: 'failed' as const,
          errorCode: 'integrity_failed',
          message: 'Interrupted workbook state could not be verified after restart.',
          nextAction: 'Upload the workbook again with a new request.',
        };
      }
    });
    const at = timestamp();
    let recovered = 0;
    db.transaction(() => {
      for (const recovery of recoveries) {
        const result = db.prepare(`
          UPDATE analytics_import_inbox_items
          SET status = ?, revision = revision + 1,
              selected_sheet = NULL, preview_json = NULL, preview_sha256 = NULL, inspected_at = NULL,
              error_code = ?, error_message = ?, next_action = ?, updated_at = ?
          WHERE id = ? AND revision = ? AND status = ?
        `).run(
          recovery.status,
          recovery.errorCode,
          recovery.message,
          recovery.nextAction,
          at,
          recovery.row.id,
          recovery.row.revision,
          recovery.row.status,
        );
        recovered += result.changes;
      }
      if (recovered) bumpRoomRevision(at);
    })();
    return recovered;
  }

  const service: AnalyticsImportInbox & AnalyticsImportCandidateReader = {
    rootDir,
    list,
    get,
    uploadXlsx,
    inspectSheet,
    readVerifiedCandidate,
    recoverInterrupted,
  };
  service.recoverInterrupted();
  return service;
}
