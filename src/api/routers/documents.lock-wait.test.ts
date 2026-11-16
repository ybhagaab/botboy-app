import express from 'express';
import request from 'supertest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDocumentsRouter } from './documents.js';
import { createStorage, type StorageLayer } from '../../core/storage.js';
import { createContentStore, type ContentStore } from '../../core/content-store.js';
import { decidePendingEdit, markEditSynced } from '../../core/pending-edits.js';
import { createLockWaitStore } from '../../core/sharepoint-lock-waits.js';
import {
  createProductDocumentPublicationService,
  sha256Buffer,
  type ProductDocumentPublicationService,
} from '../../product-manager/product-document-publications.js';
import { buildProductDocumentPublicationViewFromService } from '../../product-manager/product-document-publication-view.js';
import type { ProductDocumentArtifact, ProductDocumentService } from '../../product-manager/types.js';
import type { RouterDeps } from './deps.js';

/**
 * A publication whose SharePoint file someone has open (owner report 2026-11-16: the Notification Permission WebLab PRD update
 * was refused 11 times while reviewers had it open; the card said "Publication phase recorded" and, once the in-memory retry ran
 * out, offered nothing). The wait is durable and visible, ends with a receipt and a chat notice, and never leaves a dead end.
 */
const TARGET = '/personal/u_amazon_com/Documents/Notification Permission WebLab PRD.md';
const V1 = '# Notification permission WebLab\n\nThe first published version of the PRD for the request on Android 13+.';
const V2 = '# Notification permission WebLab\n\nThe reviewed second version of the PRD, ready to replace the first one.';
const LOCKED_TEXT = 'Error: File is locked (likely open in browser or Office). Close the file and try again.';

describe('waiting for a SharePoint file that someone has open', () => {
  let storage: StorageLayer;
  let contentStore: ContentStore;
  let contentDir: string;
  let servers: Server[];
  const env = { ...process.env };

  beforeEach(() => {
    storage = createStorage(':memory:');
    storage.initialize();
    contentDir = mkdtempSync(path.join(os.tmpdir(), 'ppt-lock-wait-'));
    contentStore = createContentStore(storage.getDb(), { contentDir });
    servers = [];
    process.env.PPT_LOCK_RETRY_INTERVAL_MS = '25';
  });
  afterEach(async () => {
    process.env = { ...env };
    await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))));
    await new Promise(resolve => setTimeout(resolve, 60)); // let a last tick settle before the database closes
    storage.close();
    rmSync(contentDir, { recursive: true, force: true });
  });

  /** An approved update of the published V1 to V2, and a SharePoint that refuses writes while `state.locked`. */
  function setup() {
    const db = storage.getDb();
    db.prepare("INSERT INTO projects (id, title, one_liner, brain_path, status) VALUES ('p1', 'Notifications', '', '/tmp/brain', 'active')").run();
    db.exec(`
      CREATE TABLE product_document_artifacts (artifact_id TEXT PRIMARY KEY, parent_artifact_id TEXT);
      INSERT INTO product_document_artifacts VALUES ('artifact-v1', NULL), ('artifact-v2', 'artifact-v1');
    `);
    const artifacts = new Map<string, ProductDocumentArtifact>([
      ['artifact-v1', { artifactId: 'artifact-v1', persisted: true, projectId: 'p1', title: 'Notification Permission WebLab PRD', content: V1 } as ProductDocumentArtifact],
      ['artifact-v2', { artifactId: 'artifact-v2', parentArtifactId: 'artifact-v1', persisted: true, projectId: 'p1', title: 'Notification Permission WebLab PRD', content: V2 } as ProductDocumentArtifact],
    ]);
    const productDocuments = { getArtifact: (id: string) => artifacts.get(id) ?? null, listArtifacts: () => [] } as unknown as ProductDocumentService;
    let n = 0;
    const publications = createProductDocumentPublicationService(db, productDocuments, { createId: () => `publication-${++n}` });
    const base = publications.stage({ artifactId: 'artifact-v1', projectId: 'p1', action: 'create', format: 'md', title: 'Notification Permission WebLab PRD', serverRelativeUrl: TARGET });
    const baseApproved = decidePendingEdit(db, base.pendingEdit.id, 'approved');
    publications.recordDecision(baseApproved.id, 'approved', baseApproved.approvedAt!);
    publications.recordExport(base.publication.publicationId, { sha256: sha256Buffer(Buffer.from(V1)), bytes: Buffer.byteLength(V1), filename: path.basename(TARGET) });
    publications.recordUploaded(base.publication.publicationId, { remoteItemId: '140' });
    publications.recordVerified(base.publication.publicationId, { remoteSha256: sha256Buffer(Buffer.from(V1)), remoteItemId: '140' });
    publications.recordCaptureQueued(base.publication.publicationId);
    publications.recordCapture(base.publication.publicationId, 'capture-v1', base.publication.docKey);
    markEditSynced(db, base.pendingEdit.id);
    const staged = publications.stage({ artifactId: 'artifact-v2', projectId: 'p1', action: 'update_existing', basePublicationId: base.publication.publicationId, format: 'md', title: 'Notification Permission WebLab PRD' });

    const state = { locked: true, remote: Buffer.from(V1), etag: 'etag-v1', version: '1.0', modified: '2026-11-16T09:00:00Z', writes: 0, refused: 0 };
    const listed = () => JSON.stringify({ files: [{ Id: '140', Name: path.basename(TARGET), Path: TARGET, IsFolder: false, Size: state.remote.length, Modified: state.modified, eTag: state.etag, VersionLabel: state.version, WebUrl: 'https://x/prd.md?web=1' }] });
    const mcpManager = {
      callTool: async (_server: string, tool: string, args: Record<string, unknown>) => {
        if (tool === 'sharepoint_list_files') return { text: listed(), isError: false };
        if (tool === 'sharepoint_read_file') {
          writeFileSync(String(args.savePath), state.remote);
          return { text: '{}', isError: false };
        }
        if (tool === 'sharepoint_write_file') {
          if (state.locked) {
            state.refused += 1;
            return { text: LOCKED_TEXT, isError: true };
          }
          state.writes += 1;
          state.remote = Buffer.from(String(args.content ?? ''));
          state.etag = `etag-v${state.writes + 1}`;
          state.version = `${state.writes + 1}.0`;
          state.modified = '2026-11-16T11:40:00Z';
          return { text: JSON.stringify({ Id: 140, eTag: state.etag }), isError: false };
        }
        throw new Error(`unexpected tool ${tool}`);
      },
    };
    const sharePointSync = {
      enqueueByPath: () => ({ queued: true, docKey: staged.publication.docKey }),
      drainNow: async () => {
        const current = publications.get(staged.publication.publicationId);
        if (current?.status === 'capture_queued' || current?.status === 'verified') publications.recordCapture(staged.publication.publicationId, 'capture-v2', staged.publication.docKey);
        return 1;
      },
    };
    const deps = { db, contentStore, mcpManager, sharePointSync, productDocumentService: productDocuments, productDocumentPublications: publications } as unknown as RouterDeps;
    const app = express();
    app.use(express.json());
    app.use('/api', createDocumentsRouter(deps));
    const view = () => buildProductDocumentPublicationViewFromService({ artifactId: 'artifact-v2', projectId: 'p1', projectStatus: 'active' }, publications, { lockWaitFor: docKey => createLockWaitStore(db).get(docKey) });
    const notices = () => (db.prepare("SELECT notice_json FROM chat_messages WHERE notice_json IS NOT NULL ORDER BY created_at, rowid").all() as Array<{ notice_json: string }>).map(row => JSON.parse(row.notice_json));
    return { db, app, deps, publications, staged, state, view, notices, docKey: staged.publication.docKey, publicationId: staged.publication.publicationId };
  }

  async function ownerApp(app: express.Express) {
    const server = await new Promise<Server>(resolve => { const live = app.listen(0, '127.0.0.1', () => resolve(live)); });
    servers.push(server);
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return (url: string, body: object) => request(server).post(url).set('Origin', origin).set('Sec-Fetch-Site', 'same-origin').send(body);
  }

  async function until(check: () => boolean, ms = 3000) {
    const deadline = Date.now() + ms;
    while (!check() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    expect(check()).toBe(true);
  }

  async function approveAndSync(t: ReturnType<typeof setup>) {
    process.env.PPT_LOCK_RETRY_INTERVAL_MS = '600000'; // no background try until the test asks for one
    await request(t.app).post(`/api/documents/pending-edits/${t.staged.pendingEdit.id}/approve`).send({}).expect(200);
    return request(t.app).post('/api/documents/sync').send({ docKey: t.docKey });
  }

  it('a refused write shows as waiting for the file with its tries, and lands by itself once the file is closed', async () => {
    const t = setup();
    const refused = await approveAndSync(t);
    expect(refused.status).toBe(202);
    expect(refused.body).toMatchObject({ retrying: true, wait: { tries: 1 } });
    expect(refused.body.note).toContain('Nothing was written.');
    expect(t.publications.get(t.publicationId)?.status).toBe('exported');
    const waiting = t.view();
    expect(waiting.phase).toBe('waiting_for_file');
    expect(waiting.attempt).toMatchObject({ publicationStatus: 'exported', effectCertainty: 'none', lockWait: { docKey: t.docKey, tries: 1 } });
    const retry = await request(t.app).get(`/api/documents/sync-retry?docKey=${encodeURIComponent(t.docKey)}`);
    expect(retry.body).toMatchObject({ retrying: true, tries: 1, writing: false });

    // The reviewers close the file; the next background try lands it.
    t.state.locked = false;
    t.db.prepare('UPDATE sharepoint_lock_waits SET next_try_at = ?').run(new Date(Date.now() - 1000).toISOString());
    process.env.PPT_LOCK_RETRY_INTERVAL_MS = '25';
    process.env.PPT_LOCK_RESUME_DELAY_MS = '0';
    // A second router on the same database is a restart: it finds the wait and resumes it.
    const restarted = express();
    restarted.use(express.json());
    restarted.use('/api', createDocumentsRouter(t.deps));
    await until(() => t.publications.get(t.publicationId)?.status === 'complete');
    expect(t.state.writes).toBe(1);
    expect(t.state.remote.toString('utf8')).toBe(V2);
    expect(createLockWaitStore(t.db).get(t.docKey)).toBeNull();
    expect(t.view().phase).toBe('complete');
    expect(t.notices()).toEqual([expect.objectContaining({
      topic: 'sharepoint-write', state: 'resolved', severity: 'success', title: 'Published to SharePoint',
      labels: ['Notification Permission…'], action: { kind: 'open_route', label: 'Open document', route: '#/documents/artifact-v2' },
    })]);
  });

  it('when the file stays open to the end, the card says nothing was written and offers the write again, which then lands', async () => {
    const t = setup();
    await approveAndSync(t);
    process.env.PPT_LOCK_RETRY_INTERVAL_MS = '25';
    process.env.PPT_LOCK_WAIT_LIMIT_MS = '120';
    t.db.prepare('UPDATE sharepoint_lock_waits SET next_try_at = ?').run(new Date(Date.now() - 1000).toISOString());
    process.env.PPT_LOCK_RESUME_DELAY_MS = '0';
    const restarted = express();
    restarted.use(express.json());
    restarted.use('/api', createDocumentsRouter(t.deps));
    await until(() => t.publications.get(t.publicationId)?.status === 'upload_failed');
    const gaveUp = t.publications.get(t.publicationId)!;
    expect(gaveUp.lastError).toMatch(/^Not written: the file stayed open in Word or a browser for 24 hours, so SharePoint refused every write \(\d+ tries since \d\d:\d\d\)\. Nothing changed in SharePoint\.$/);
    expect(t.state.writes).toBe(0);
    const view = t.view();
    expect(view).toMatchObject({ phase: 'failed', attempt: { publicationStatus: 'upload_failed', pendingStatus: 'approved', effectCertainty: 'none' } });
    expect(view.attempt?.lockWait).toBeUndefined();
    expect(t.notices()).toEqual([expect.objectContaining({ state: 'open', severity: 'warning', title: 'SharePoint file stayed open', next: 'Nothing was written. Open the document and press Update when the file is closed.' })]);

    // Later the file is closed; the owner presses Update again and it lands on the same pinned export.
    t.state.locked = false;
    const synced = await request(t.app).post('/api/documents/sync').send({ docKey: t.docKey });
    expect(synced.status).toBe(200);
    expect(synced.body).toMatchObject({ uploaded: true, verifiedOnReadBack: true });
    expect(t.publications.get(t.publicationId)).toMatchObject({ status: 'complete', lastError: null, verifiedRemoteSha256: sha256Buffer(Buffer.from(V2)) });
  });

  it('the owner stops waiting from the card (his page only): nothing is written, no notice, and the write stays ready', async () => {
    const t = setup();
    await approveAndSync(t);
    await request(t.app).post('/api/documents/sync-retry/stop').send({ docKey: t.docKey }).expect(403);
    expect(createLockWaitStore(t.db).get(t.docKey)).not.toBeNull();
    const post = await ownerApp(t.app);
    const stopped = await post('/api/documents/sync-retry/stop', { docKey: t.docKey });
    expect(stopped.status).toBe(200);
    expect(stopped.body).toMatchObject({ stopped: true, wait: { tries: 1 } });
    expect(t.publications.get(t.publicationId)?.lastError).toMatch(/^Not written: you stopped waiting for the file to be closed \(1 try since \d\d:\d\d\)\. Nothing changed in SharePoint\.$/);
    expect(t.view()).toMatchObject({ phase: 'failed', attempt: { effectCertainty: 'none', pendingStatus: 'approved' } });
    expect(t.notices()).toEqual([]);
    expect((await post('/api/documents/sync-retry/stop', { docKey: t.docKey })).body).toMatchObject({ stopped: false });
    // Pressed again while the file is still open, it waits again from the start.
    const again = await request(t.app).post('/api/documents/sync').send({ docKey: t.docKey });
    expect(again.status).toBe(202);
    expect(t.publications.get(t.publicationId)?.status).toBe('exported');
    expect(t.view().phase).toBe('waiting_for_file');
  });
});
