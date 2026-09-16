import { afterEach, describe, expect, it } from 'vitest';
import { createStorage, type StorageLayer } from '../core/storage.js';
import { decidePendingEdit, listPendingEdits } from '../core/pending-edits.js';
import {
  createProductDocumentPublicationService,
  publicationRemoteReceipt,
} from './product-document-publications.js';
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
    const productDocuments = {
      getArtifact: (artifactId: string) => artifactId === artifact.artifactId ? artifact : null,
    } as unknown as ProductDocumentService;
    const publications = createProductDocumentPublicationService(storage.getDb(), productDocuments, {
      now: () => new Date('2026-09-16T01:00:00Z'),
      createId: () => 'publication-1',
    });
    return { artifact, publications, db: storage.getDb() };
  }

  it('stages exact artifact lineage and advances only through receipt-backed states', () => {
    const { artifact, publications, db } = fixture();
    const staged = publications.stage({
      artifactId: artifact.artifactId,
      projectId: 'p1',
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
    expect(publications.recordVerified('publication-1').status).toBe('verified');
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

  it('rejects project mismatch, illegal transitions, and mismatched capture identity', () => {
    const { artifact, publications } = fixture();
    expect(() => publications.stage({
      artifactId: artifact.artifactId,
      projectId: 'other-project',
      format: 'docx',
      title: artifact.title,
      targetFolder: '/personal/u_amazon_com/Documents/Published',
    })).toThrow('does not own');

    const staged = publications.stage({
      artifactId: artifact.artifactId,
      projectId: 'p1',
      format: 'docx',
      title: artifact.title,
      targetFolder: '/personal/u_amazon_com/Documents/Published',
    });
    expect(() => publications.recordVerified(staged.publication.publicationId)).toThrow('cannot move');
  });

  it('parses only bounded stable fields from an opaque upload receipt', () => {
    expect(publicationRemoteReceipt(JSON.stringify({
      result: { webUrl: 'https://x/doc', driveItemId: 'item-1', eTag: 'etag-1', ignored: 'x' },
    }))).toEqual({ webUrl: 'https://x/doc', remoteItemId: 'item-1', remoteEtag: 'etag-1' });
    expect(publicationRemoteReceipt('not json')).toEqual({});
  });
});
