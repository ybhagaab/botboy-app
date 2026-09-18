import { describe, expect, it } from 'vitest';
import type { PendingEdit, PendingEditStatus } from '../core/pending-edits.js';
import {
  buildProductDocumentPublicationView,
} from './product-document-publication-view.js';
import type {
  ProductDocumentPublication,
  ProductDocumentPublicationStatus,
} from './product-document-publications.js';

function publication(overrides: Partial<ProductDocumentPublication> = {}): ProductDocumentPublication {
  return {
    publicationId: 'pub-1', artifactId: 'artifact-v1', projectId: 'p1', action: 'create', basePublicationId: null,
    intentKey: 'intent', expectedRemoteSha256: null, expectedRemoteItemId: null, expectedRemoteEtag: null,
    expectedRemoteVersion: null, expectedRemoteModified: null, expectedRemoteSize: null, remoteObservedAt: null,
    supersededAt: null, supersessionReason: null, baseRemoteSha256: null, repairNote: null, retiredAt: null,
    retirementNote: null, replacementPublicationId: null, format: 'docx', pendingEditId: 'edit-1', status: 'staged',
    siteUrl: null, serverRelativeUrl: '/personal/u/Documents/Strategy.docx', docKey: 'host/personal/u/Documents/Strategy.docx',
    webUrl: null, remoteItemId: null, remoteEtag: null, exportSha256: null, verifiedRemoteSha256: null,
    exportBytes: null, exportFilename: null, capturedWorkItemId: null, lastError: null,
    createdAt: '2026-09-17T10:00:00Z', approvedAt: null, exportedAt: null, uploadedAt: null,
    verifiedAt: null, capturedAt: null, updatedAt: '2026-09-17T10:00:00Z',
    ...overrides,
  };
}

function pending(status: PendingEditStatus, overrides: Partial<PendingEdit> = {}): PendingEdit {
  return {
    id: 'edit-1', docKey: 'host/personal/u/Documents/Strategy.docx',
    serverRelativeUrl: '/personal/u/Documents/Strategy.docx', siteUrl: null, kind: 'botboy',
    operation: 'createDocument', findText: null, replaceWith: null, paragraphs: null, createContent: '# body',
    projectId: 'p1', status, conflictReason: null, originNote: null, createdAt: '2026-09-17T10:00:00Z',
    approvedAt: null, syncedAt: null, ...overrides,
  };
}

const artifact = { artifactId: 'artifact-v2', projectId: 'p1' };

function view(publications: ProductDocumentPublication[], edit: PendingEdit | null = null) {
  return buildProductDocumentPublicationView(artifact, publications, id => edit?.id === id ? edit : null);
}

describe('product-document publication projection', () => {
  it('projects unassigned, inactive, no-location, one-base, and multiple-base choices', () => {
    expect(buildProductDocumentPublicationView({ artifactId: 'x' }, [], () => null).phase).toBe('blocked_unassigned');
    expect(buildProductDocumentPublicationView({ artifactId: 'x', projectId: 'p1', projectStatus: 'archived' }, [], () => null))
      .toMatchObject({ phase: 'blocked_unassigned', blockReason: expect.stringContaining('archived') });
    expect(view([]).phase).toBe('create_configuration_required');

    const base1 = publication({ publicationId: 'base-1', artifactId: 'artifact-v1', status: 'complete', capturedWorkItemId: 'capture-1', capturedAt: '2026-09-17T09:00:00Z' });
    expect(view([base1])).toMatchObject({ phase: 'update_ready', currentLocationCount: 0, updateBases: [{ publicationId: 'base-1' }] });

    const base2 = publication({
      publicationId: 'base-2', artifactId: 'artifact-v0', status: 'complete', capturedWorkItemId: 'capture-2',
      docKey: 'host/personal/u/Documents/Other.docx', serverRelativeUrl: '/personal/u/Documents/Other.docx',
      createdAt: '2026-09-17T08:00:00Z', updatedAt: '2026-09-17T08:00:00Z',
    });
    expect(view([base1, base2])).toMatchObject({ phase: 'update_base_selection_required', updateBases: [{}, {}] });
  });

  it('deduplicates physical locations by docKey and recognizes current completion', () => {
    const olderReceipt = publication({
      publicationId: 'old-at-location', artifactId: 'artifact-v1', status: 'complete', capturedWorkItemId: 'capture-old',
      updatedAt: '2026-09-17T08:00:00Z',
    });
    const currentReceipt = publication({
      publicationId: 'current-at-location', artifactId: 'artifact-v2', status: 'complete', capturedWorkItemId: 'capture-current',
      capturedAt: '2026-09-17T11:00:00Z', updatedAt: '2026-09-17T11:00:00Z',
    });
    const projected = view([olderReceipt, currentReceipt]);
    expect(projected).toMatchObject({ phase: 'complete', currentLocationCount: 1, updateBases: [] });
    expect(projected.completedLocations).toEqual([expect.objectContaining({
      publicationId: 'current-at-location', containsSelectedArtifact: true,
    })]);
  });

  it.each([
    ['staged', 'pending', 'pending', 'none'],
    ['approved', 'approved', 'approved', 'none'],
    ['exported', 'approved', 'in_flight', 'none'],
    ['uploaded_unverified', 'approved', 'in_flight', 'possible_remote_effect'],
    ['verification_failed', 'conflicted', 'failed', 'possible_remote_effect'],
    ['capture_failed', 'synced', 'failed', 'verified_remote_effect'],
    ['identity_mismatch', 'synced', 'failed', 'verified_remote_effect'],
    ['target_conflict', 'conflicted', 'conflicted', 'none'],
  ] as Array<[ProductDocumentPublicationStatus, PendingEditStatus, string, string]>) (
    'maps %s / %s to %s with %s certainty',
    (publicationStatus, pendingStatus, phase, certainty) => {
      const attempt = publication({ artifactId: 'artifact-v2', status: publicationStatus });
      const projected = view([attempt], pending(pendingStatus));
      expect(projected).toMatchObject({
        phase,
        attempt: { publicationStatus, pendingStatus, effectCertainty: certainty },
      });
    },
  );

  it('never hides approved, in-flight, or ambiguous chain attempts behind a newer local stage', () => {
    const currentStage = publication({
      publicationId: 'current-stage', artifactId: 'artifact-v2', pendingEditId: 'stage-edit', status: 'staged',
      updatedAt: '2026-09-17T12:00:00Z',
    });
    const approvedOlder = publication({
      publicationId: 'approved-older', artifactId: 'artifact-v1', pendingEditId: 'approved-edit', status: 'approved',
      docKey: 'host/personal/u/Documents/Approved.docx', serverRelativeUrl: '/personal/u/Documents/Approved.docx',
      updatedAt: '2026-09-17T11:00:00Z',
    });
    const uploadedOlder = publication({
      publicationId: 'uploaded-older', artifactId: 'artifact-v1', pendingEditId: 'uploaded-edit', status: 'uploaded_unverified',
      docKey: 'host/personal/u/Documents/Uploaded.docx', serverRelativeUrl: '/personal/u/Documents/Uploaded.docx',
      updatedAt: '2026-09-17T10:00:00Z',
    });
    const pendingById = new Map([
      ['stage-edit', pending('pending', { id: 'stage-edit' })],
      ['approved-edit', pending('approved', { id: 'approved-edit' })],
      ['uploaded-edit', pending('approved', { id: 'uploaded-edit' })],
    ]);
    const projected = buildProductDocumentPublicationView(
      artifact,
      [currentStage, approvedOlder, uploadedOlder],
      id => pendingById.get(id) ?? null,
    );
    expect(projected).toMatchObject({
      phase: 'in_flight',
      attempt: { publicationId: 'uploaded-older', effectCertainty: 'possible_remote_effect' },
      blockers: [
        { publicationId: 'uploaded-older' },
        { publicationId: 'approved-older' },
        { publicationId: 'current-stage' },
      ],
    });
  });

  it('ignores safe older staged attempts so a newer source can supersede them through stage()', () => {
    const oldStage = publication({ artifactId: 'artifact-v1', status: 'staged' });
    const base = publication({
      publicationId: 'base', artifactId: 'artifact-v0', status: 'complete', capturedWorkItemId: 'capture',
      pendingEditId: 'base-edit', updatedAt: '2026-09-17T09:00:00Z',
    });
    const projected = view([oldStage, base], pending('pending'));
    expect(projected.phase).toBe('update_ready');
    expect(projected.attempt).toBeNull();
  });
});
