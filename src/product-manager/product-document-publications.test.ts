import { afterEach, describe, expect, it } from 'vitest';
import { createStorage, type StorageLayer } from '../core/storage.js';
import { decidePendingEdit, listPendingEdits, markEditSynced } from '../core/pending-edits.js';
import {
  createProductDocumentPublicationService,
  publicationRemoteReceipt,
} from './product-document-publications.js';
import { createProductDocumentStore } from './product-document-store.js';
import type { ProductDocumentArtifact, ProductDocumentService } from './types.js';

describe('product-document publication ledger', () => {
  let storage: StorageLayer | null = null;
  afterEach(() => storage?.close());

  function fixture() {
    storage = createStorage(':memory:');
    storage.initialize();
    storage.getDb().prepare(`
      INSERT INTO projects (id, title, one_liner, brain_path, status)
      VALUES ('p1', 'Catalog', '', '/tmp/brain', 'active')
    `).run();
    const artifact = {
      artifactId: 'artifact-v1',
      persisted: true,
      projectId: 'p1',
      state: 'ready_for_review',
      profileId: 'business_document/adaptive.v1',
      profileVersion: '1',
      overlayVersions: {},
      maturity: 'working',
      title: 'Catalog strategy',
      content: '# Catalog strategy\n\nA complete official document with enough authored content to publish.',
      assumptions: [],
      openQuestions: [],
      claims: [],
      omittedSourceUnits: [],
      sourceCoverage: { totalUnits: 0, coveredUnits: 0, omittedUnits: 0, coveragePercent: 100 },
      context: { status: 'prompt_only', overviewAvailable: false, assumptionsRequired: false, manifest: [], diagnostics: [], totalCharacters: 0 },
      glossary: { entries: [], conflicts: [], selectedFiles: [], diagnostics: [] },
      validation: { status: 'pass', profile: { status: 'pass', findings: [] }, evidence: { status: 'pass', findings: [] }, writing: { status: 'pass', findings: [] }, glossary: { status: 'pass', findings: [] }, ste: { status: 'not_checked', findings: [] }, findings: [], checkedAt: '2026-09-16T00:00:00Z', checkerVersion: 'test', conformanceStatement: 'test' },
      checkerVersion: 'test',
      createdAt: '2026-09-16T00:00:00Z',
      emailSendApprovalRequired: false,
    } as unknown as ProductDocumentArtifact;
    const store = createProductDocumentStore(storage.getDb());
    store.save(artifact);
    const productDocuments = {
      getArtifact: (artifactId: string) => store.get(artifactId),
    } as unknown as ProductDocumentService;
    let publicationNumber = 0;
    const publications = createProductDocumentPublicationService(storage.getDb(), productDocuments, {
      now: () => new Date('2026-09-16T01:00:00Z'),
      createId: () => `publication-${++publicationNumber}`,
    });
    return { artifact, store, publications, db: storage.getDb() };
  }

  it('stages exact artifact lineage and advances only through receipt-backed states', () => {
    const { artifact, publications, db } = fixture();
    const staged = publications.stage({
      artifactId: artifact.artifactId,
      projectId: 'p1',
      action: 'create',
      format: 'md',
      title: artifact.title,
      targetFolder: '/personal/u_amazon_com/Documents/Published',
      purpose: 'Owner requested publication',
    });
    expect(staged.publication).toMatchObject({
      publicationId: 'publication-1',
      artifactId: 'artifact-v1',
      projectId: 'p1',
      status: 'staged',
      serverRelativeUrl: '/personal/u_amazon_com/Documents/Published/Catalog strategy.md',
    });
    expect(listPendingEdits(db, staged.publication.docKey)[0]).toMatchObject({
      id: staged.pendingEdit.id,
      projectId: 'p1',
      status: 'pending',
    });

    const approved = decidePendingEdit(db, staged.pendingEdit.id, 'approved');
    expect(publications.recordDecision(approved.id, 'approved', approved.approvedAt!)).toMatchObject({ status: 'approved' });
    expect(publications.recordExport('publication-1', {
      sha256: 'a'.repeat(64),
      bytes: 123,
      filename: 'Catalog-strategy.md',
    })).toMatchObject({ status: 'exported', exportBytes: 123 });
    expect(publications.recordUploaded('publication-1', {
      webUrl: 'https://amazon-my.sharepoint.com/published/catalog-strategy.md',
      remoteItemId: 'drive-item-7',
      remoteEtag: 'etag-1',
    }).status).toBe('uploaded_unverified');
    expect(publications.recordVerified('publication-1', {
      remoteSha256: 'a'.repeat(64),
      remoteItemId: 'drive-item-7',
    }).status).toBe('verified');
    expect(publications.recordCaptureQueued('publication-1').status).toBe('capture_queued');
    expect(publications.recordCapture(
      'publication-1',
      'work-item-1',
      staged.publication.docKey,
    )).toMatchObject({
      status: 'complete',
      capturedWorkItemId: 'work-item-1',
    });
    expect(publications.listByProject('p1')).toHaveLength(1);
    expect(publications.listByArtifact('artifact-v1')).toHaveLength(1);
  });

  it('stages a later artifact as an exact update of one completed chain location', () => {
    const { artifact, store, publications, db } = fixture();
    const base = publications.stage({
      artifactId: artifact.artifactId,
      projectId: 'p1',
      action: 'create',
      format: 'md',
      title: artifact.title,
      serverRelativeUrl: '/personal/u_amazon_com/Documents/Documents/Catalog-strategy.md',
    });
    const approved = decidePendingEdit(db, base.pendingEdit.id, 'approved');
    publications.recordDecision(approved.id, 'approved', approved.approvedAt!);
    publications.recordExport(base.publication.publicationId, {
      sha256: 'a'.repeat(64), bytes: 123, filename: 'Catalog-strategy.md',
    });
    publications.recordUploaded(base.publication.publicationId, { remoteItemId: '140' });
    publications.recordVerified(base.publication.publicationId, { remoteSha256: 'a'.repeat(64), remoteItemId: '140' });
    publications.recordCaptureQueued(base.publication.publicationId);
    publications.recordCapture(base.publication.publicationId, 'capture-v1', base.publication.docKey);
    markEditSynced(db, base.pendingEdit.id);

    const v2 = {
      ...artifact,
      artifactId: 'artifact-v2',
      parentArtifactId: artifact.artifactId,
      content: '# Catalog strategy\n\nThe complete official V2 content is ready to version in place.',
      createdAt: '2026-09-16T02:00:00Z',
    } as ProductDocumentArtifact;
    store.save(v2);
    const staged = publications.stage({
      artifactId: v2.artifactId,
      projectId: 'p1',
      action: 'update_existing',
      basePublicationId: base.publication.publicationId,
      format: 'md',
      title: v2.title,
    });

    expect(staged.publication).toMatchObject({
      action: 'update_existing',
      basePublicationId: base.publication.publicationId,
      serverRelativeUrl: '/personal/u_amazon_com/Documents/Documents/Catalog-strategy.md',
      docKey: base.publication.docKey,
    });
    expect(staged.pendingEdit.originNote).toMatch(/update existing SharePoint version/);
    expect(() => publications.stage({
      artifactId: v2.artifactId,
      projectId: 'p1',
      action: 'update_existing',
      basePublicationId: base.publication.publicationId,
      format: 'md',
      title: v2.title,
      targetFolder: '/personal/u_amazon_com/Documents',
    })).toThrow(/inherits the exact prior SharePoint target/);
  });

  it('rejects project mismatch, illegal transitions, and mismatched capture identity', () => {
    const { artifact, publications } = fixture();
    expect(() => publications.stage({
      artifactId: artifact.artifactId,
      projectId: 'other-project',
      action: 'create',
      format: 'docx',
      title: artifact.title,
      targetFolder: '/personal/u_amazon_com/Documents/Published',
    })).toThrow('does not own');

    const staged = publications.stage({
      artifactId: artifact.artifactId,
      projectId: 'p1',
      action: 'create',
      format: 'docx',
      title: artifact.title,
      targetFolder: '/personal/u_amazon_com/Documents/Published',
    });
    expect(() => publications.recordVerified(staged.publication.publicationId, { remoteSha256: 'b'.repeat(64) })).toThrow('cannot move');
  });

  it('migrates an existing ledger to retirement fields without losing a superseded receipt', () => {
    storage = createStorage(':memory:');
    storage.initialize();
    const db = storage.getDb();
    db.exec(`
      CREATE TABLE product_document_publications (
        publication_id TEXT PRIMARY KEY, artifact_id TEXT NOT NULL, project_id TEXT NOT NULL,
        publication_action TEXT NOT NULL DEFAULT 'create', base_publication_id TEXT,
        base_remote_sha256 TEXT, repair_note TEXT, format TEXT NOT NULL,
        pending_edit_id TEXT NOT NULL UNIQUE, status TEXT NOT NULL, site_url TEXT,
        server_relative_url TEXT NOT NULL, doc_key TEXT NOT NULL, web_url TEXT,
        remote_item_id TEXT, remote_etag TEXT, export_sha256 TEXT,
        verified_remote_sha256 TEXT, export_bytes INTEGER, export_filename TEXT,
        captured_work_item_id TEXT, last_error TEXT, created_at TEXT NOT NULL,
        approved_at TEXT, exported_at TEXT, uploaded_at TEXT, verified_at TEXT,
        captured_at TEXT, updated_at TEXT NOT NULL
      );
      INSERT INTO product_document_publications (
        publication_id, artifact_id, project_id, publication_action, format, pending_edit_id,
        status, server_relative_url, doc_key, remote_item_id, export_sha256,
        verified_remote_sha256, export_bytes, export_filename, captured_work_item_id,
        created_at, updated_at
      ) VALUES (
        'retired-pub', 'artifact-v2', 'p1', 'create', 'docx', 'pending-old',
        'superseded', '/personal/u/Documents/duplicate.docx', 'u/Documents/duplicate.docx',
        '141', '${'a'.repeat(64)}', '${'a'.repeat(64)}', 123, 'duplicate.docx', 'capture-old',
        '2026-09-16T06:00:00Z', '2026-09-16T14:00:00Z'
      );
    `);
    const service = createProductDocumentPublicationService(db, { getArtifact: () => null } as unknown as ProductDocumentService);
    const columns = (db.prepare('PRAGMA table_info(product_document_publications)').all() as Array<{ name: string }>).map(column => column.name);
    expect(columns).toEqual(expect.arrayContaining(['retired_at', 'retirement_note', 'replacement_publication_id']));
    db.prepare(`
      UPDATE product_document_publications
      SET retired_at = ?, retirement_note = ?, replacement_publication_id = ?
      WHERE publication_id = 'retired-pub'
    `).run('2026-09-16T14:01:26Z', 'Owner approved duplicate retirement.', 'replacement-pub');
    expect(service.get('retired-pub')).toMatchObject({
      status: 'superseded',
      capturedWorkItemId: 'capture-old',
      remoteItemId: '141',
      retiredAt: '2026-09-16T14:01:26Z',
      retirementNote: 'Owner approved duplicate retirement.',
      replacementPublicationId: 'replacement-pub',
    });
    expect((db.prepare('SELECT COUNT(*) AS count FROM product_document_publications').get() as { count: number }).count).toBe(1);
  });

  it('parses only bounded stable fields from an opaque upload receipt', () => {
    expect(publicationRemoteReceipt(JSON.stringify({
      result: { webUrl: 'https://x/doc', driveItemId: 'item-1', eTag: 'etag-1', ignored: 'x' },
    }))).toEqual({ webUrl: 'https://x/doc', remoteItemId: 'item-1', remoteEtag: 'etag-1' });
    expect(publicationRemoteReceipt('not json')).toEqual({});
  });
});
