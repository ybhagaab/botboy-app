import { mkdtempSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';
import request from 'supertest';
import { createStorage, type StorageLayer } from '../../core/storage.js';
import { createContentStore, refToColumns } from '../../core/content-store.js';
import { createBrainStore, newBrain } from '../../core/brain-store.js';
import { createDocumentReads } from '../../core/document-reads.js';
import { createPipelineRouter } from './pipeline.js';
import type { RouterDeps } from './deps.js';

/**
 * The project page shows how far the brief has read each long document and
 * lets the owner ask for a full read of one that was sampled or stopped.
 */
describe('long-document reads on the project page', () => {
  let storage: StorageLayer;
  let dir: string;

  beforeEach(() => {
    storage = createStorage(':memory:');
    storage.initialize();
    dir = mkdtempSync(path.join(os.tmpdir(), 'ppt-doc-reads-api-'));
  });
  afterEach(() => {
    storage.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function setup() {
    const db = storage.getDb();
    const contentStore = createContentStore(db, { contentDir: dir, inlineThresholdBytes: 1024 });
    const brainStore = createBrainStore(db, { brainsDir: path.join(dir, 'brains') });
    brainStore.write(newBrain('proj_a', 'Kestrel Launch Plan'));
    const cols = refToColumns(contentStore.put('doc1', 'Kestrel launch plan '.repeat(10_000)));
    db.prepare(`
      INSERT INTO work_items (id, type, source, title, captured_at, process_state, project_id,
        raw_text, content_storage, content_path, content_sha256, content_bytes, metadata)
      VALUES ('doc1', 'document_capture', 'sharepoint', 'Plan.docx', '2026-10-01T00:00:00Z', 'routed', 'proj_a', ?, ?, ?, ?, ?, '{"docKey":"host/Plan.docx"}')
    `).run(cols.raw_text, cols.content_storage, cols.content_path, cols.content_sha256, cols.content_bytes);
    const documentReads = createDocumentReads({ db, contentStore, brainStore, llm: { isAvailable: () => true } });
    documentReads.enqueue('proj_a', { id: 'doc1', type: 'document_capture', source: 'sharepoint', content: 'x'.repeat(300_000), metadata: { docKey: 'host/Plan.docx' } }, 100_000);
    const app = express();
    app.use(express.json());
    app.use('/api', createPipelineRouter({ db, brainStore, documentReads } as unknown as RouterDeps));
    return { app };
  }

  it('lists the read status on the document and starts a full read on request', async () => {
    const { app } = setup();
    const detail = await request(app).get('/api/projects/proj_a');
    expect(detail.body.items[0]).toMatchObject({ id: 'doc1', documentRead: { status: 'sample', mode: 'sample', reason: 'too long to read in full' } });

    const started = await request(app).post('/api/projects/proj_a/documents/doc1/read-in-full').send({});
    expect(started.status).toBe(200);
    expect(started.body.documentRead).toMatchObject({ status: 'reading', mode: 'full', reason: 'owner_requested', partsDone: 0 });

    const health = await request(app).get('/api/pipeline/health');
    expect(health.body.documentReads).toMatchObject({ reading: 1, sample: 0 });
  });

  it('refuses a cross-origin request and a document from another project', async () => {
    const { app } = setup();
    const crossOrigin = await request(app).post('/api/projects/proj_a/documents/doc1/read-in-full')
      .set('Origin', 'https://evil.example').set('Host', 'localhost:7778').send({});
    expect(crossOrigin.status).toBe(403);
    const wrongProject = await request(app).post('/api/projects/proj_b/documents/doc1/read-in-full').send({});
    expect(wrongProject.status).toBe(404);
  });
});
