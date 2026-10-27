import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createDocumentsRouter } from '../api/routers/documents.js';
import { createStorage, type StorageLayer } from '../core/storage.js';
import { createContentStore, type ContentStore } from '../core/content-store.js';
import { getPendingEdit } from '../core/pending-edits.js';
import { GoogleApiError } from '../core/gmail-api.js';
import { createFakeDrive, type FakeDrive } from '../core/gdrive-api.fake.js';
import { GDRIVE_FOLDER_MIME } from '../core/gdrive-api.js';
import { createProductDocumentPublicationService, type ProductDocumentPublicationService } from './product-document-publications.js';
import { createPublicationDestinations } from './publication-destination.js';
import { createSharePointDestination } from './publication-destination-sharepoint.js';
import {
  DRIVE_EFFECT_UNKNOWN,
  GDRIVE_DEFAULT_STORED_AS,
  createGoogleDriveDestination,
  docTokens,
  firstMismatchIndex,
  sourceTokensFromMarkdown,
  tokensSha256,
} from './publication-destination-gdrive.js';
import { resolveDriveDestinationCandidates } from './publication-destination-default.js';
import type { ProductDocumentArtifact, ProductDocumentService } from './types.js';
import type { RouterDeps } from '../api/routers/deps.js';

const V1 = '# Plan\n\nThe first version of the plan that BotBoy publishes to Drive.';
const V2 = '# Plan\n\nThe second version of the plan, published as the next revision.';
const DOCX_BYTES = (text: string) => Buffer.from(`PK-fake-docx:${text}`);

describe('docTokens', () => {
  it('normalizes quotes, dashes, bullets, numbering, and table separators', () => {
    expect(docTokens('“Smart” quotes — and ‘single’ ones')).toEqual(['Smart', 'quotes', 'and', 'single', 'ones']);
    expect(docTokens('| a | b |\n|---|---|\n| 1 | 2 |')).toEqual(['a', 'b', '1', '2']);
    expect(docTokens('• bullet one\n1. first\na) second', { dropLineStartMarkers: true })).toEqual(['bullet', 'one', 'first', 'second']);
    expect(docTokens('Café', {})).toEqual(['Café']);
    expect(sourceTokensFromMarkdown('# Title\n\n- bullet one\n1. first\n[link](https://x.example) “q”')).toEqual(['Title', 'bullet', 'one', 'first', 'link', 'q']);
    // Pictures and diagrams are pictures in the converted Doc, not words (document-media.md).
    expect(sourceTokensFromMarkdown('Before ![Pie chart](/api/files/a.png) after\n```mermaid\nflowchart LR\n  A-->B\n```\nEnd')).toEqual(['Before', 'after', 'End']);
  });
  it('reports the first mismatch and hashes token sequences', () => {
    expect(firstMismatchIndex(['a', 'b', 'c'], ['a', 'x', 'c'])).toBe(1);
    expect(firstMismatchIndex(['a'], ['a'])).toBe(-1);
    expect(tokensSha256(['a', 'b'])).not.toBe(tokensSha256(['ab']));
  });
  it('defaults to exact-byte DOCX until the Google Doc check is proven live', () => {
    expect(GDRIVE_DEFAULT_STORED_AS).toBe('docx');
  });
});

describe('Drive destination plug', () => {
  it('is available only with drive.file; verify compares exact bytes, then md5, then tokens', async () => {
    const drive = createFakeDrive();
    let publish = false;
    const plug = createGoogleDriveDestination({ clientFor: () => drive, canPublish: () => publish, accounts: () => ['default'] });
    expect(plug.available().ok).toBe(false);
    publish = true;
    expect(plug.available().ok).toBe(true);
    const file = drive.put({ id: 'f1xxxxxxxxxx', name: 'a.docx', content: Buffer.from('bytes') });
    const target = { provider: 'gdrive' as const, container: 'default', address: 'botboy/a.docx', storedAs: 'docx' as const };
    expect((await plug.verify(target, file.id, { bytesSha256: file.sha256Checksum! })).ok).toBe(true);
    expect((await plug.verify(target, file.id, { bytesSha256: 'f'.repeat(64) })).ok).toBe(false);
    file.sha256Checksum = undefined;
    expect(await plug.verify(target, file.id, { bytesSha256: 'x', md5: file.md5Checksum })).toMatchObject({ ok: true, kind: 'exact_bytes_md5' });
    const doc = drive.put({ id: 'd1xxxxxxxxxx', name: 'a', mimeType: 'application/vnd.google-apps.document', exports: { 'text/plain': '1. Plan\nThe “first” version' } });
    const docTarget = { ...target, storedAs: 'google_doc' as const };
    const tokens = sourceTokensFromMarkdown('1. Plan\nThe "first" version');
    expect(await plug.verify(docTarget, doc.id, { bytesSha256: 'x', tokensSha256: tokensSha256(tokens) })).toMatchObject({ ok: true, kind: 'normalized_text' });
    expect(await plug.verify(docTarget, doc.id, { bytesSha256: 'x', tokensSha256: tokensSha256(['other']) })).toMatchObject({ ok: false });
  });

  it('SharePoint plug is unavailable while Amazon Employee is off', () => {
    let amazon = false;
    const plug = createSharePointDestination({ amazonEmployee: () => amazon, connectionReady: () => true });
    expect(plug.available().ok).toBe(false);
    amazon = true;
    expect(plug.available().ok).toBe(true);
    const destinations = createPublicationDestinations({ sharepoint: plug, gdrive: createGoogleDriveDestination({ clientFor: () => null, canPublish: () => false, accounts: () => [] }) });
    expect(destinations.available()).toEqual(['sharepoint']);
    amazon = false;
    expect(destinations.available()).toEqual([]);
  });
});

describe('Drive publication: stage → approve → Sync → receipt', () => {
  let storage: StorageLayer;
  let contentStore: ContentStore;
  let contentDir: string;
  let drive: FakeDrive;
  let publications: ProductDocumentPublicationService;
  let app: express.Express;
  let canPublish: boolean;
  let captures: Array<Record<string, string>>;

  beforeEach(() => {
    storage = createStorage(':memory:');
    storage.initialize();
    contentDir = mkdtempSync(path.join(os.tmpdir(), 'ppt-gdrive-publication-'));
    contentStore = createContentStore(storage.getDb(), { contentDir });
    const db = storage.getDb();
    db.prepare("INSERT INTO projects (id, title, one_liner, brain_path, status) VALUES ('p1', 'Plan', '', '/tmp/plan-brain', 'active')").run();
    db.exec(`
      CREATE TABLE product_document_artifacts (artifact_id TEXT PRIMARY KEY, parent_artifact_id TEXT);
      INSERT INTO product_document_artifacts VALUES ('a1', NULL), ('a2', 'a1');
    `);
    const artifacts = new Map<string, ProductDocumentArtifact>([
      ['a1', { artifactId: 'a1', persisted: true, projectId: 'p1', title: 'Plan', content: V1 } as ProductDocumentArtifact],
      ['a2', { artifactId: 'a2', parentArtifactId: 'a1', persisted: true, projectId: 'p1', title: 'Plan', content: V2 } as ProductDocumentArtifact],
    ]);
    const productDocuments = { getArtifact: (id: string) => artifacts.get(id) ?? null } as unknown as ProductDocumentService;
    publications = createProductDocumentPublicationService(db, productDocuments);
    drive = createFakeDrive();
    canPublish = true;
    captures = [];
    const plug = createGoogleDriveDestination({ clientFor: () => drive, canPublish: () => canPublish, accounts: () => ['default'] });
    app = express();
    app.use(express.json());
    app.use('/api', createDocumentsRouter({
      db,
      contentStore,
      productDocumentService: productDocuments,
      productDocumentPublications: publications,
      publicationDestinations: createPublicationDestinations({ gdrive: plug }),
      publicationExporter: async ({ content }) => ({ data: DOCX_BYTES(content), filename: 'Plan.docx' }),
      gdriveSync: {
        captureFile: async (_account: string, fileId: string, meta: Record<string, string>) => {
          captures.push({ fileId, ...meta });
          publications.recordCapture(meta.publicationId, `wi-${fileId}`, meta.docKey);
          return { url: `gdrive://default/file/${fileId}`, emitted: true };
        },
      } as any,
    } as unknown as RouterDeps));
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    storage.close();
    rmSync(contentDir, { recursive: true, force: true });
  });

  const owner = (method: 'post', url: string, body: object = {}) => {
    const req = request(app)[method](url);
    return req.set('Origin', `http://127.0.0.1:${new URL(req.url).port}`).set('Sec-Fetch-Site', 'same-origin').send(body);
  };
  const stage = (artifactId = 'a1', folderId = 'botboy') => publications.stage({
    artifactId, projectId: 'p1', action: 'create', format: 'docx', title: 'Plan',
    destination: { provider: 'gdrive', accountId: 'default', folderId, storedAs: 'docx' },
  });
  const approveAndSync = async (staged: ReturnType<typeof stage>) => {
    expect((await owner('post', `/api/documents/pending-edits/${staged.pendingEdit.id}/approve`)).status).toBe(200);
    return owner('post', '/api/documents/sync', { docKey: staged.publication.docKey });
  };
  const driveDocs = () => [...drive.files.values()].filter(file => file.mimeType !== GDRIVE_FOLDER_MIME);

  it('creates exactly one file with an exact-byte receipt and a capture', async () => {
    const staged = stage();
    expect(staged.publication).toMatchObject({ destinationProvider: 'gdrive', destinationContainer: 'default', destinationStoredAs: 'docx', idempotencyKey: null });
    expect(staged.publication.docKey).toBe('gdrive://default/folder/botboy/Plan.docx');
    const synced = await approveAndSync(staged);
    expect(synced.status).toBe(200);
    expect(synced.body.verifiedOnReadBack).toBe(true);
    const done = publications.get(staged.publication.publicationId)!;
    expect(done.status).toBe('complete');
    expect(done.verificationKind).toBe('exact_bytes_sha256');
    expect(done.exportMd5).toBe(createHash('md5').update(DOCX_BYTES(V1)).digest('hex'));
    expect(driveDocs()).toHaveLength(1);
    expect(driveDocs()[0].appProperties).toEqual({ botboyPublicationId: done.publicationId, botboyIdempotency: done.idempotencyKey });
    expect(captures).toHaveLength(1);
    expect(captures[0]).toMatchObject({ publicationId: done.publicationId, docKey: done.docKey, sourceArtifactId: 'a1' });
  });

  it('persists the idempotency key before any network call and keeps it across retries; SharePoint rows have none', async () => {
    const staged = stage();
    let keyAtFirstCall: string | null | undefined;
    const original = drive.listFiles.bind(drive);
    drive.listFiles = async input => {
      keyAtFirstCall ??= publications.get(staged.publication.publicationId)!.idempotencyKey;
      return original(input);
    };
    drive.failNext('createFile', new GoogleApiError('Drive upload failed (HTTP 400 badRequest)', 400, 'badRequest'));
    expect((await approveAndSync(staged)).status).toBe(502);
    const key = publications.get(staged.publication.publicationId)!.idempotencyKey;
    expect(key).toMatch(/^[0-9a-f-]{36}$/);
    expect(keyAtFirstCall).toBe(key);
    expect(publications.get(staged.publication.publicationId)!.status).toBe('upload_failed');
    // not_written → Sync again: findPriorWrite runs first, then one create.
    const retry = await owner('post', '/api/documents/sync', { docKey: staged.publication.docKey });
    expect(retry.status).toBe(200);
    expect(publications.get(staged.publication.publicationId)!.idempotencyKey).toBe(key);
    expect(driveDocs()).toHaveLength(1);
    const ops = drive.calls.map(call => call.op);
    expect(ops.lastIndexOf('listFiles')).toBeLessThan(ops.lastIndexOf('createFile'));
    // A new row gets its own key.
    storage.getDb().prepare("UPDATE product_document_publications SET status='superseded' WHERE publication_id=?").run(staged.publication.publicationId);
    const sharePointRow = storage.getDb().prepare("SELECT idempotency_key, destination_provider FROM product_document_publications WHERE destination_provider='sharepoint'").all();
    expect(sharePointRow).toEqual([]);
  });

  it('a not_written retry adopts a write that landed instead of creating again', async () => {
    const staged = stage();
    drive.failNext('createFile', new GoogleApiError('Drive upload failed (HTTP 403 forbidden)', 403, 'forbidden'));
    await approveAndSync(staged);
    const key = publications.get(staged.publication.publicationId)!.idempotencyKey!;
    // An earlier attempt's file appears (Google's listing caught up).
    drive.put({ id: 'landed000001', name: 'Plan.docx', parents: ['elsewhere'], content: DOCX_BYTES(V1), appProperties: { botboyPublicationId: staged.publication.publicationId, botboyIdempotency: key } });
    const creates = drive.calls.filter(call => call.op === 'createFile').length;
    const retry = await owner('post', '/api/documents/sync', { docKey: staged.publication.docKey });
    expect(retry.status).toBe(200);
    expect(drive.calls.filter(call => call.op === 'createFile').length).toBe(creates);
    expect(publications.get(staged.publication.publicationId)).toMatchObject({ status: 'complete', remoteItemId: 'landed000001' });
  });

  it('an unknown effect is never resent; Check Drive adopts the one file', async () => {
    const staged = stage();
    drive.failNext('createFile', new GoogleApiError('Drive upload failed (HTTP 503 backendError)', 503, 'backendError'), { afterEffect: true });
    const first = await approveAndSync(staged);
    expect(first.status).toBe(502);
    expect(publications.get(staged.publication.publicationId)!.lastError).toMatch(new RegExp(`^${DRIVE_EFFECT_UNKNOWN}`));
    const creates = drive.calls.filter(call => call.op === 'createFile').length;
    const again = await owner('post', '/api/documents/sync', { docKey: staged.publication.docKey });
    expect(again.status).toBe(502);
    expect(again.body.error).toMatch(/Check Drive/);
    expect(drive.calls.filter(call => call.op === 'createFile').length).toBe(creates);
    expect((await request(app).post(`/api/documents/publications/${staged.publication.publicationId}/check-drive`)).status).toBe(403);
    const checked = await owner('post', `/api/documents/publications/${staged.publication.publicationId}/check-drive`);
    expect(checked.status).toBe(200);
    expect(checked.body.found).toBe(true);
    expect(publications.get(staged.publication.publicationId)!.status).toBe('complete');
    expect(driveDocs()).toHaveLength(1);
  });

  it('a name clash in the folder is a target conflict', async () => {
    const folder = await drive.createFolder({ name: 'Shared', parents: ['root'] });
    drive.put({ id: 'someone00001', name: 'Plan.docx', parents: [folder.id], content: Buffer.from('theirs') });
    const staged = stage('a1', folder.id);
    const synced = await approveAndSync(staged);
    expect(synced.status).toBe(200);
    expect(publications.get(staged.publication.publicationId)!.status).toBe('target_conflict');
    expect(drive.calls.some(call => call.op === 'createFile')).toBe(false);
    expect(getPendingEdit(storage.getDb(), staged.pendingEdit.id)!.status).toBe('conflicted');
  });

  it('a Drive file modified after approval stops the update at target_conflict', async () => {
    const base = stage();
    await approveAndSync(base);
    const baseDone = publications.get(base.publication.publicationId)!;
    expect(baseDone.status).toBe('complete');
    const update = publications.stage({ artifactId: 'a2', projectId: 'p1', action: 'update_existing', basePublicationId: baseDone.publicationId, format: 'docx', title: 'Plan' });
    expect(update.publication).toMatchObject({ destinationProvider: 'gdrive', docKey: `gdrive://default/file/${baseDone.remoteItemId}` });
    expect((await owner('post', `/api/documents/pending-edits/${update.pendingEdit.id}/approve`)).status).toBe(200);
    const file = drive.files.get(baseDone.remoteItemId!)!;
    drive.put({ ...file, content: Buffer.from('edited in Drive') });
    const synced = await owner('post', '/api/documents/sync', { docKey: update.publication.docKey });
    expect(synced.status).toBe(200);
    expect(publications.get(update.publication.publicationId)!.status).toBe('target_conflict');
    expect(drive.calls.some(call => call.op === 'updateMedia')).toBe(false);
  });

  it('an unchanged approved update writes one new revision of the same file', async () => {
    const base = stage();
    await approveAndSync(base);
    const baseDone = publications.get(base.publication.publicationId)!;
    const update = publications.stage({ artifactId: 'a2', projectId: 'p1', action: 'update_existing', basePublicationId: baseDone.publicationId, format: 'docx', title: 'Plan' });
    await owner('post', `/api/documents/pending-edits/${update.pendingEdit.id}/approve`);
    const synced = await owner('post', '/api/documents/sync', { docKey: update.publication.docKey });
    expect(synced.status).toBe(200);
    expect(publications.get(update.publication.publicationId)).toMatchObject({ status: 'complete', remoteItemId: baseDone.remoteItemId });
    expect(driveDocs()).toHaveLength(1);
  });

  it('gating: approve and Sync need the owner UI; no Drive account means no publish', async () => {
    const staged = stage();
    expect((await request(app).post(`/api/documents/pending-edits/${staged.pendingEdit.id}/approve`)).status).toBe(403);
    expect((await owner('post', `/api/documents/pending-edits/${staged.pendingEdit.id}/approve`)).status).toBe(200);
    expect((await request(app).post('/api/documents/sync').send({ docKey: staged.publication.docKey })).status).toBe(403);
    canPublish = false;
    const synced = await owner('post', '/api/documents/sync', { docKey: staged.publication.docKey });
    expect(synced.status).toBe(502);
    expect(drive.calls).toEqual([]);
  });

  it('destination candidates: Drive only for accounts with drive.file; project last-used folder first', async () => {
    expect(resolveDriveDestinationCandidates(storage.getDb(), [{ id: 'default', email: 'a@x.com', canPublishDrive: false }], 'p1')).toEqual([]);
    const staged = stage();
    await approveAndSync(staged);
    const candidates = resolveDriveDestinationCandidates(storage.getDb(), [{ id: 'default', email: 'a@x.com', canPublishDrive: true }], 'p1');
    expect(candidates[0]).toMatchObject({ provider: 'gdrive', source: 'project_last_used', folderId: 'botboy' });
  });
});
