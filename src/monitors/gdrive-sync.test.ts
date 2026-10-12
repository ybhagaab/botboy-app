import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createStorage, getSetting, type StorageLayer } from '../core/storage.js';
import { fakeGmailConnection, type FakeGmailAccount } from '../core/gmail-connection.fake.js';
import { createFakeDrive, type FakeDrive } from '../core/gdrive-api.fake.js';
import { GoogleApiError } from '../core/gmail-api.js';
import { GDRIVE_DOC_MIME, GDRIVE_FOLDER_MIME, GDRIVE_SHEET_MIME, GDRIVE_SLIDES_MIME, XLSX_MIME } from '../core/gdrive-api.js';
import { createGdriveSyncs, driveExportPlan, gdriveItemUrl, GDRIVE_BIG_FILE_BYTES } from './gdrive-sync.js';
import type { RawWorkItem } from '../core/types.js';

const NOW = Date.parse('2026-10-20T00:00:00Z');
// Built at runtime so no key-shaped literal sits in the repository.
const KEY_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const FAKE_PRIVATE_KEY = [
  ['-----BEGIN ', 'RSA PRIVATE', ' KEY-----'].join(''),
  ...[3, 5, 7, 11].map(step => Array.from({ length: 64 }, (_, i) => KEY_CHARS[(i * step + step) % KEY_CHARS.length]).join('')),
  ['-----END ', 'RSA PRIVATE', ' KEY-----'].join(''),
].join('\n');

describe('driveExportPlan', () => {
  it('maps Google types and binaries', () => {
    expect(driveExportPlan({ mimeType: GDRIVE_DOC_MIME, name: 'a' })).toEqual({ kind: 'export', mimeType: 'text/markdown', fallbackMimeType: 'text/plain' });
    expect(driveExportPlan({ mimeType: GDRIVE_SHEET_MIME, name: 'a' })).toEqual({ kind: 'export', mimeType: XLSX_MIME, parseAs: '.xlsx' });
    expect(driveExportPlan({ mimeType: GDRIVE_SLIDES_MIME, name: 'a' })).toEqual({ kind: 'export', mimeType: 'text/plain' });
    expect(driveExportPlan({ mimeType: 'application/vnd.google-apps.form', name: 'a' }).kind).toBe('stub');
    expect(driveExportPlan({ mimeType: GDRIVE_FOLDER_MIME, name: 'a' }).kind).toBe('skip');
    expect(driveExportPlan({ mimeType: 'application/pdf', name: 'Plan.PDF' })).toEqual({ kind: 'download', parseAs: '.pdf' });
  });
});

describe('Google Drive capture', () => {
  let storage: StorageLayer;
  let drive: FakeDrive;
  let account: FakeGmailAccount;
  let items: RawWorkItem[];
  let reports: Array<{ source: string; kind?: string; reason?: string }>;
  let tmp: string;
  const parser = {
    parse: (file: string) => ({ success: true, text: `parsed:${path.basename(file)}:${fs.readFileSync(file, 'utf8')}` } as any),
  };

  beforeEach(() => {
    storage = createStorage(':memory:');
    storage.initialize();
    drive = createFakeDrive('jane@gmail.com');
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gdrive-sync-'));
    account = {
      id: 'default', email: 'jane@gmail.com', canReadDrive: true, canPublishDrive: true,
      drive: { enabled: true, sources: { ownedByMe: true, sharedWithMe: false, folderIds: [] } },
      client: {} as any,
    };
    items = [];
    reports = [];
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    storage.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const make = () => createGdriveSyncs({
    db: storage.getDb(),
    connection: fakeGmailConnection([account]),
    emit: item => items.push(item),
    captureHealth: {
      reportSuccess: source => reports.push({ source }),
      reportFailure: (source, failure) => reports.push({ source, kind: failure.kind, reason: failure.reason }),
    },
    parser,
    now: () => NOW,
    tmpDir: tmp,
    driveClientFor: () => drive,
    hasCaptured: (url, revision) => items.some(item => item.url === url && item.metadata.driveRevision === revision),
  });

  it('saves the cursor before listing, captures once, and a restart resumes with zero duplicates', async () => {
    drive.put({ id: 'doc1', name: 'Plan', mimeType: GDRIVE_DOC_MIME, exports: { 'text/markdown': '# Plan\nShip it' } });
    const order: string[] = [];
    const listFiles = drive.listFiles.bind(drive);
    const startToken = drive.getStartPageToken.bind(drive);
    drive.getStartPageToken = async () => { order.push('token'); return startToken(); };
    drive.listFiles = async input => { order.push('list'); return listFiles(input); };
    await make().runNow();
    expect(order[0]).toBe('token');
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ source: 'gdrive', type: 'document_capture', url: gdriveItemUrl('default', 'doc1'), title: 'Plan' });
    expect(items[0].content).toContain('SOURCE: Google Drive');
    expect(items[0].content).toContain('Ship it');
    expect(items[0].metadata).toMatchObject({ source: 'gdrive', accountId: 'default', fileId: 'doc1', mimeType: GDRIVE_DOC_MIME, extractionTier: 'full' });
    expect(getSetting(storage.getDb(), 'gdrive_sync.acct.default.startPageToken')).toBeTruthy();
    // Restart: a new instance with the same settings and store.
    await make().runNow();
    expect(items).toHaveLength(1);
    // An edit is a new head revision: captured once.
    drive.put({ id: 'doc1', name: 'Plan', mimeType: GDRIVE_DOC_MIME, exports: { 'text/markdown': '# Plan\nShip it twice' } });
    await make().runNow();
    await make().runNow();
    expect(items).toHaveLength(2);
    expect(items[1].content).toContain('twice');
    expect(reports.filter(r => r.source === 'gdrive' && !r.kind).length).toBeGreaterThan(0);
  });

  it('falls back to text/plain, parses Sheets as .xlsx and binaries by extension, and stubs other Google types', async () => {
    drive.put({ id: 'doc2', name: 'Notes', mimeType: GDRIVE_DOC_MIME, exports: { 'text/plain': 'plain notes' } });
    drive.put({ id: 'sheet1', name: 'Budget', mimeType: GDRIVE_SHEET_MIME, exports: { [XLSX_MIME]: 'xlsx-bytes' } });
    drive.put({ id: 'slide1', name: 'Deck', mimeType: GDRIVE_SLIDES_MIME, exports: { 'text/plain': 'slide text' } });
    drive.put({ id: 'pdf1', name: 'Spec.pdf', mimeType: 'application/pdf', content: Buffer.from('pdf-bytes') });
    drive.put({ id: 'form1', name: 'Survey', mimeType: 'application/vnd.google-apps.form' });
    await make().runNow();
    const by = (id: string) => items.find(item => item.metadata.fileId === id)!;
    expect(by('doc2').content).toContain('plain notes');
    expect(by('sheet1').content).toContain('parsed:sheet1.xlsx:xlsx-bytes');
    expect(by('slide1').content).toContain('slide text');
    expect(by('pdf1').content).toContain('parsed:pdf1.pdf:pdf-bytes');
    expect(by('form1').metadata.extractionTier).toBe('metadata_only');
    expect(fs.readdirSync(tmp)).toEqual([]);
  });

  it('withholds credential-named files and secret text, never downloads 25 MB files, and records data files as references', async () => {
    drive.put({ id: 'cred1', name: 'credentials.json', mimeType: 'application/json', content: Buffer.from('{"k":"v"}') });
    drive.put({ id: 'env1', name: '.env', mimeType: 'text/plain', content: Buffer.from('A=1') });
    drive.put({ id: 'sec1', name: 'Notes', mimeType: GDRIVE_DOC_MIME, exports: { 'text/markdown': `notes\n${FAKE_PRIVATE_KEY}\nmore` } });
    const big = drive.put({ id: 'big1', name: 'Video.pdf', mimeType: 'application/pdf', content: Buffer.from('x') });
    big.size = String(GDRIVE_BIG_FILE_BYTES);
    drive.put({ id: 'csv1', name: 'rows.csv', mimeType: 'text/csv', content: Buffer.from('a,b\n1,2') });
    await make().runNow();
    const by = (id: string) => items.find(item => item.metadata.fileId === id)!;
    for (const id of ['cred1', 'env1', 'sec1']) {
      expect(by(id).metadata.extractionTier, id).toBe('withheld');
      expect(by(id).content).toMatch(/Content withheld/);
    }
    expect(by('sec1').content).not.toContain(FAKE_PRIVATE_KEY.split('\n')[1]);
    expect(by('cred1').content).not.toContain('"k"');
    expect(by('big1').content).toMatch(/not downloaded/);
    expect(drive.calls.some(call => call.op === 'downloadFile' && call.args[0] === 'big1')).toBe(false);
    expect(drive.calls.some(call => call.op === 'downloadFile' && call.args[0] === 'cred1')).toBe(false);
    expect(by('csv1').type).toBe('file_reference');
    expect(drive.calls.some(call => call.op === 'downloadFile' && call.args[0] === 'csv1')).toBe(false);
  });

  it('a 10 MB export limit becomes an export_too_large stub', async () => {
    drive.put({ id: 'doc3', name: 'Huge', mimeType: GDRIVE_DOC_MIME, exports: { 'text/markdown': 'x' } });
    drive.failNext('exportFile', new GoogleApiError('Drive export failed (HTTP 403 exportSizeLimitExceeded)', 403, 'exportSizeLimitExceeded'));
    await make().runNow();
    expect(items[0].metadata.extractionTier).toBe('export_too_large');
  });

  it('walks chosen folders (folders untimed, files time-filtered) and filters changes by source', async () => {
    account.drive = { enabled: true, sources: { ownedByMe: false, sharedWithMe: false, folderIds: ['folderRoot01'] } };
    drive.put({ id: 'folderRoot01', name: 'Root', mimeType: GDRIVE_FOLDER_MIME });
    const sub = drive.put({ id: 'folderSub001', name: 'Sub', mimeType: GDRIVE_FOLDER_MIME, parents: ['folderRoot01'] });
    sub.modifiedTime = '2020-01-01T00:00:00Z'; // an old folder is still walked
    drive.put({ id: 'inSub', name: 'Deep', mimeType: GDRIVE_DOC_MIME, parents: ['folderSub001'], exports: { 'text/markdown': 'deep' } });
    drive.put({ id: 'outside', name: 'Elsewhere', mimeType: GDRIVE_DOC_MIME, parents: ['root'], exports: { 'text/markdown': 'no' } });
    const old = drive.put({ id: 'oldFile', name: 'Old', mimeType: GDRIVE_DOC_MIME, parents: ['folderRoot01'], exports: { 'text/markdown': 'old' } });
    old.modifiedTime = '2020-01-01T00:00:00Z';
    await make().runNow();
    expect(items.map(item => item.metadata.fileId)).toEqual(['inSub']);
    // Changes: an edit outside the source is ignored; one inside is captured.
    drive.put({ id: 'outside', name: 'Elsewhere', mimeType: GDRIVE_DOC_MIME, parents: ['root'], exports: { 'text/markdown': 'still no' } });
    drive.put({ id: 'oldFile', name: 'Old', mimeType: GDRIVE_DOC_MIME, parents: ['folderRoot01'], exports: { 'text/markdown': 'edited' } });
    await make().runNow();
    expect(items.map(item => item.metadata.fileId)).toEqual(['inSub', 'oldFile']);
  });

  it('identity is provider-strict: a Drive file named like a local or SharePoint capture stays separate', async () => {
    drive.put({ id: 'docX', name: 'Plan.docx', mimeType: GDRIVE_DOC_MIME, exports: { 'text/markdown': 'drive copy' } });
    items.push({ type: 'document_capture', source: 'sharepoint', sourceApp: 'SharePoint', url: 'https://x.sharepoint.com/Plan.docx', title: 'Plan.docx', content: 'sp', metadata: {}, capturedAt: new Date() });
    await make().runNow();
    const drived = items.filter(item => item.source === 'gdrive');
    expect(drived).toHaveLength(1);
    expect(drived[0].url).toBe('gdrive://default/file/docX');
  });

  it('reports health streaks with a named cause', async () => {
    drive.put({ id: 'd', name: 'x', mimeType: GDRIVE_DOC_MIME, exports: { 'text/markdown': 'x' } });
    drive.failNext('getStartPageToken', new GoogleApiError('Gmail token refresh failed (HTTP 400 invalid_grant)', 400, 'invalid_grant'));
    const syncs = make();
    await syncs.runNow();
    expect(reports.at(-1)).toMatchObject({ source: 'gdrive', kind: 'service_auth' });
    expect(reports.at(-1)!.reason).toMatch(/invalid_grant/);
    drive.failNext('getStartPageToken', new GoogleApiError('Drive changes start failed (HTTP 403 accessNotConfigured)', 403, 'accessNotConfigured'));
    await syncs.runNow();
    expect(reports.at(-1)!.reason).toMatch(/accessNotConfigured/);
    drive.failNext('getStartPageToken', new GoogleApiError('x (HTTP 403 userRateLimitExceeded)', 403, 'userRateLimitExceeded'));
    await syncs.runNow();
    expect(reports.at(-1)!.kind).toBe('rate_limited');
    expect(syncs.status()[0].lastError).toMatch(/RateLimit/);
  });

  it('gating: no capture without the Drive scope or with Drive turned off', async () => {
    drive.put({ id: 'd', name: 'x', mimeType: GDRIVE_DOC_MIME, exports: { 'text/markdown': 'x' } });
    account.canReadDrive = false;
    await make().runNow();
    account.canReadDrive = true;
    account.drive = { enabled: false, sources: { ownedByMe: true, sharedWithMe: false, folderIds: [] } };
    await make().runNow();
    expect(items).toEqual([]);
    expect(drive.calls).toEqual([]);
  });

  it('captureFile captures BotBoy\'s own published file even with capture off', async () => {
    account.drive = { enabled: false, sources: { ownedByMe: false, sharedWithMe: false, folderIds: [] } };
    const file = drive.put({ id: 'pub1', name: 'Report.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', content: Buffer.from('docx') });
    const result = await make().captureFile('default', file.id, { publicationId: 'p1' });
    expect(result).toEqual({ url: 'gdrive://default/file/pub1', emitted: true });
    expect(items[0].metadata.publicationId).toBe('p1');
  });
});
