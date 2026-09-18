import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createProductDocumentsRouter } from './product-documents.js';
import { createStorage, type StorageLayer } from '../../core/storage.js';
import { decidePendingEdit, markEditConflicted, markEditSynced } from '../../core/pending-edits.js';
import { createProductDocumentPublicationService, type ProductDocumentPublicationService } from '../../product-manager/product-document-publications.js';
import type { ProductDocumentArtifact, ProductDocumentService } from '../../product-manager/types.js';

const V1 = '# Strategy\n\nThe complete first immutable artifact has enough content to publish safely.';
const V2 = '# Strategy\n\nThe complete second immutable artifact becomes the next SharePoint version.';
const EMPTY_GLOSSARY = {
  entries: [], approvedTerms: [], candidateTerms: [], conflicts: [], diagnostics: [], selectedFiles: [],
};

describe('generated-document direct publication API', () => {
  let storage: StorageLayer;
  let artifacts: Map<string, ProductDocumentArtifact>;
  let productDocuments: ProductDocumentService;
  let publications: ProductDocumentPublicationService;

  beforeEach(() => {
    storage = createStorage(':memory:');
    storage.initialize();
    storage.getDb().prepare(`
      INSERT INTO projects (id, title, one_liner, brain_path, status)
      VALUES ('p1', 'Catalog', '', '/tmp/catalog', 'active'),
             ('p-archived', 'Archived', '', '/tmp/archived', 'archived')
    `).run();
    storage.getDb().exec(`
      CREATE TABLE product_document_artifacts (
        artifact_id TEXT PRIMARY KEY,
        parent_artifact_id TEXT
      );
      INSERT INTO product_document_artifacts VALUES ('artifact-v1', NULL);
      INSERT INTO product_document_artifacts VALUES ('artifact-v2', 'artifact-v1');
      INSERT INTO product_document_artifacts VALUES ('artifact-unassigned', NULL);
      INSERT INTO product_document_artifacts VALUES ('artifact-archived', NULL);
    `);
    artifacts = new Map([
      ['artifact-v1', { artifactId: 'artifact-v1', persisted: true, projectId: 'p1', title: 'Strategy', content: V1, glossary: EMPTY_GLOSSARY } as unknown as ProductDocumentArtifact],
      ['artifact-v2', { artifactId: 'artifact-v2', parentArtifactId: 'artifact-v1', persisted: true, projectId: 'p1', title: 'Strategy', content: V2, glossary: EMPTY_GLOSSARY } as unknown as ProductDocumentArtifact],
      ['artifact-unassigned', { artifactId: 'artifact-unassigned', persisted: true, title: 'Unassigned', content: V1, glossary: EMPTY_GLOSSARY } as unknown as ProductDocumentArtifact],
      ['artifact-archived', { artifactId: 'artifact-archived', persisted: true, projectId: 'p-archived', title: 'Archived', content: V1, glossary: EMPTY_GLOSSARY } as unknown as ProductDocumentArtifact],
    ]);
    productDocuments = {
      getArtifact: id => artifacts.get(id) ?? null,
      listArtifacts: () => [],
    } as unknown as ProductDocumentService;
    let id = 0;
    publications = createProductDocumentPublicationService(storage.getDb(), productDocuments, {
      createId: () => `publication-${++id}`,
      now: () => new Date('2026-09-17T10:00:00Z'),
    });
  });

  afterEach(() => storage.close());

  function app() {
    const value = express();
    value.use(express.json());
    value.use('/api', createProductDocumentsRouter({
      nodeManager: {} as never,
      db: storage.getDb(),
      productDocumentService: productDocuments,
      productDocumentPublications: publications,
    }));
    return value;
  }

  function completeBase() {
    const staged = publications.stage({
      artifactId: 'artifact-v1', projectId: 'p1', action: 'create', format: 'docx',
      title: 'Strategy', serverRelativeUrl: '/personal/u_amazon_com/Documents/Strategy.docx',
    });
    const approved = decidePendingEdit(storage.getDb(), staged.pendingEdit.id, 'approved');
    publications.recordDecision(approved.id, 'approved', approved.approvedAt!);
    publications.recordExport(staged.publication.publicationId, { sha256: 'a'.repeat(64), bytes: 100, filename: 'Strategy.docx' });
    publications.recordUploaded(staged.publication.publicationId, { remoteItemId: '140' });
    publications.recordVerified(staged.publication.publicationId, { remoteSha256: 'a'.repeat(64), remoteItemId: '140' });
    publications.recordCaptureQueued(staged.publication.publicationId);
    publications.recordCapture(staged.publication.publicationId, 'capture-v1', staged.publication.docKey);
    markEditSynced(storage.getDb(), staged.pendingEdit.id);
    return staged.publication;
  }

  it('projects create configuration and blocks unassigned artifacts', async () => {
    const empty = await request(app()).get('/api/product-documents/artifact-v2').expect(200);
    expect(empty.body.publicationState).toMatchObject({
      phase: 'create_configuration_required',
      selectedArtifactId: 'artifact-v2',
      attempt: null,
      completedLocations: [],
    });

    const unassigned = await request(app()).get('/api/product-documents/artifact-unassigned').expect(200);
    expect(unassigned.body.publicationState.phase).toBe('blocked_unassigned');
    await request(app()).post('/api/product-documents/artifact-unassigned/publications').send({
      ownerRequested: true,
      action: 'create',
      format: 'docx',
      targetFolder: '/personal/u_amazon_com/Documents',
    }).expect(409);

    const archived = await request(app()).get('/api/product-documents/artifact-archived').expect(200);
    expect(archived.body.publicationState).toMatchObject({
      phase: 'blocked_unassigned', projectStatus: 'archived', blockReason: expect.stringContaining('archived'),
    });
    await request(app()).post('/api/product-documents/artifact-archived/publications').send({
      ownerRequested: true,
      action: 'create',
      format: 'docx',
      targetFolder: '/personal/u_amazon_com/Documents',
    }).expect(409);
  });

  it('stages a new copy directly and returns the same receipt idempotently', async () => {
    await request(app()).post('/api/product-documents/artifact-v2/publications').send({
      action: 'create', format: 'docx', targetFolder: '/personal/u_amazon_com/Documents',
    }).expect(400);

    const first = await request(app()).post('/api/product-documents/artifact-v2/publications').send({
      ownerRequested: true,
      action: 'create',
      format: 'docx',
      targetFolder: '/personal/u_amazon_com/Documents',
    }).expect(201);
    expect(first.body.result).toMatchObject({
      publicationId: 'publication-1',
      status: 'staged',
      action: 'create',
      format: 'docx',
      idempotent: false,
      serverRelativeUrl: '/personal/u_amazon_com/Documents/Strategy.docx',
    });
    expect(first.body.publicationState).toMatchObject({ phase: 'pending', attempt: { pendingStatus: 'pending' } });

    const repeated = await request(app()).post('/api/product-documents/artifact-v2/publications').send({
      ownerRequested: true,
      action: 'create',
      format: 'docx',
      targetFolder: '/personal/u_amazon_com/Documents',
    }).expect(200);
    expect(repeated.body.result).toMatchObject({ publicationId: 'publication-1', idempotent: true });
  });

  it('derives an exact update destination/format and exposes pending then approved state', async () => {
    const base = completeBase();
    const ready = await request(app()).get('/api/product-documents/artifact-v2').expect(200);
    expect(ready.body.publicationState).toMatchObject({
      phase: 'update_ready',
      updateBases: [{ publicationId: base.publicationId, format: 'docx', containsSelectedArtifact: false }],
    });

    await request(app()).post('/api/product-documents/artifact-v2/publications').send({
      ownerRequested: true,
      action: 'update_existing',
      basePublicationId: base.publicationId,
      format: 'md',
    }).expect(400);

    const staged = await request(app()).post('/api/product-documents/artifact-v2/publications').send({
      ownerRequested: true,
      action: 'update_existing',
      basePublicationId: base.publicationId,
    }).expect(201);
    expect(staged.body.result).toMatchObject({
      action: 'update_existing',
      basePublicationId: base.publicationId,
      format: 'docx',
      serverRelativeUrl: base.serverRelativeUrl,
    });
    expect(staged.body.publicationState.phase).toBe('pending');

    const editId = staged.body.result.pendingEditId as string;
    const approvedEdit = decidePendingEdit(storage.getDb(), editId, 'approved');
    publications.recordDecision(approvedEdit.id, 'approved', approvedEdit.approvedAt!, {
      sha256: 'b'.repeat(64), itemId: '140', observedAt: '2026-09-17T10:01:00Z',
    });
    const approved = await request(app()).get('/api/product-documents/artifact-v2').expect(200);
    expect(approved.body.publicationState).toMatchObject({
      phase: 'approved',
      attempt: {
        action: 'update_existing',
        pendingStatus: 'approved',
        expectedRemoteItemId: '140',
        expectedRemoteSha256: 'b'.repeat(64),
      },
    });
  });

  it('projects current complete, zero-write conflict, and ambiguous failures honestly', async () => {
    const base = completeBase();
    const staged = publications.stage({
      artifactId: 'artifact-v2', projectId: 'p1', action: 'update_existing',
      basePublicationId: base.publicationId, format: 'docx', title: 'Strategy',
    });
    const approved = decidePendingEdit(storage.getDb(), staged.pendingEdit.id, 'approved');
    publications.recordDecision(approved.id, 'approved', approved.approvedAt!, {
      sha256: 'b'.repeat(64), itemId: '140', observedAt: '2026-09-17T10:01:00Z',
    });
    publications.recordFailure(staged.publication.publicationId, 'target_conflict', 'Changed after approval.');
    markEditConflicted(storage.getDb(), staged.pendingEdit.id, 'Changed after approval.');
    const conflict = await request(app()).get('/api/product-documents/artifact-v2').expect(200);
    expect(conflict.body.publicationState).toMatchObject({
      phase: 'conflicted',
      attempt: { effectCertainty: 'none', conflictReason: 'Changed after approval.' },
    });
  });
});
