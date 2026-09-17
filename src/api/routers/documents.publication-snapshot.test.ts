import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDocumentsRouter } from './documents.js';
import { createStorage, type StorageLayer } from '../../core/storage.js';
import { createContentStore, type ContentStore } from '../../core/content-store.js';
import {
  createPendingEdit,
  decidePendingEdit,
  getPendingEdit,
  markEditConflicted,
  markEditSynced,
} from '../../core/pending-edits.js';
import {
  createProductDocumentPublicationService,
  sha256Buffer,
  type ProductDocumentPublicationService,
} from '../../product-manager/product-document-publications.js';
import type { ProductDocumentArtifact, ProductDocumentService } from '../../product-manager/types.js';
import type { RouterDeps } from './deps.js';

const TARGET = '/personal/u_amazon_com/Documents/Documents/catalog-strategy.md';
const UNICODE_TARGET = '/personal/u_amazon_com/Documents/MX PMT × PVAA AI Automation — Discussion Strawman.docx';
const ENCODED_UNICODE_NAME = 'MX PMT %C3%97 PVAA AI Automation %E2%80%94 Discussion Strawman.docx';
const ENCODED_UNICODE_TARGET = '/personal/u_amazon_com/Documents/MX PMT %C3%97 PVAA AI Automation %E2%80%94 Discussion Strawman.docx';
const V1 = '# Catalog strategy\n\nThe completed V1 artifact is the historical publication base.';
const V2 = '# Catalog strategy\n\nThe exact V2 artifact becomes the next version of the same item.';

describe('publication approval remote snapshot', () => {
  let storage: StorageLayer;
  let contentStore: ContentStore;
  let contentDir: string;

  beforeEach(() => {
    storage = createStorage(':memory:');
    storage.initialize();
    contentDir = mkdtempSync(path.join(os.tmpdir(), 'ppt-publication-snapshot-'));
    contentStore = createContentStore(storage.getDb(), { contentDir });
  });

  afterEach(() => {
    storage.close();
    rmSync(contentDir, { recursive: true, force: true });
  });

  function appWith(extra: Partial<RouterDeps>) {
    const app = express();
    app.use(express.json());
    app.use('/api', createDocumentsRouter({ db: storage.getDb(), contentStore, ...extra } as RouterDeps));
    return app;
  }

  function setupUpdate(options: { target?: string; format?: 'md' | 'docx'; baseRemoteItemId?: string | null } = {}): {
    productDocuments: ProductDocumentService;
    publications: ProductDocumentPublicationService;
    staged: ReturnType<ProductDocumentPublicationService['stage']>;
    target: string;
  } {
    const target = options.target ?? TARGET;
    const format = options.format ?? 'md';
    const baseRemoteItemId = options.baseRemoteItemId === undefined ? '140' : options.baseRemoteItemId;
    storage.getDb().prepare(`
      INSERT INTO projects (id, title, one_liner, brain_path, status)
      VALUES ('p1', 'Catalog', '', '/tmp/catalog-brain', 'active')
    `).run();
    storage.getDb().exec(`
      CREATE TABLE product_document_artifacts (
        artifact_id TEXT PRIMARY KEY,
        parent_artifact_id TEXT
      );
      INSERT INTO product_document_artifacts (artifact_id, parent_artifact_id) VALUES ('artifact-v1', NULL);
      INSERT INTO product_document_artifacts (artifact_id, parent_artifact_id) VALUES ('artifact-v2', 'artifact-v1');
    `);
    const artifacts = new Map<string, ProductDocumentArtifact>([
      ['artifact-v1', {
        artifactId: 'artifact-v1', persisted: true, projectId: 'p1', title: 'Catalog strategy', content: V1,
      } as ProductDocumentArtifact],
      ['artifact-v2', {
        artifactId: 'artifact-v2', parentArtifactId: 'artifact-v1', persisted: true,
        projectId: 'p1', title: 'Catalog strategy', content: V2,
      } as ProductDocumentArtifact],
    ]);
    const productDocuments = {
      getArtifact: (artifactId: string) => artifacts.get(artifactId) ?? null,
      listArtifacts: () => [],
    } as unknown as ProductDocumentService;
    let publicationNumber = 0;
    const publications = createProductDocumentPublicationService(storage.getDb(), productDocuments, {
      createId: () => `publication-snapshot-${++publicationNumber}`,
      now: () => new Date('2026-09-16T01:00:00Z'),
    });
    const base = publications.stage({
      artifactId: 'artifact-v1', projectId: 'p1', action: 'create', format,
      title: 'Catalog strategy', serverRelativeUrl: target,
    });
    const baseApproved = decidePendingEdit(storage.getDb(), base.pendingEdit.id, 'approved');
    publications.recordDecision(baseApproved.id, 'approved', baseApproved.approvedAt!);
    publications.recordExport(base.publication.publicationId, {
      sha256: sha256Buffer(Buffer.from(V1)), bytes: Buffer.byteLength(V1), filename: path.basename(target),
    });
    publications.recordUploaded(base.publication.publicationId, baseRemoteItemId ? { remoteItemId: baseRemoteItemId } : {});
    publications.recordVerified(base.publication.publicationId, {
      remoteSha256: sha256Buffer(Buffer.from(V1)), ...(baseRemoteItemId ? { remoteItemId: baseRemoteItemId } : {}),
    });
    publications.recordCaptureQueued(base.publication.publicationId);
    publications.recordCapture(base.publication.publicationId, 'capture-v1', base.publication.docKey);
    markEditSynced(storage.getDb(), base.pendingEdit.id);

    const staged = publications.stage({
      artifactId: 'artifact-v2', projectId: 'p1', action: 'update_existing',
      basePublicationId: base.publication.publicationId, format, title: 'Catalog strategy',
    });
    return { productDocuments, publications, staged, target };
  }

  function listedIdentity(input: {
    itemId: string;
    remote: Buffer;
    etag: string;
    version: string;
    modified: string;
    name?: string;
    target?: string;
  }) {
    const target = input.target ?? TARGET;
    return JSON.stringify({
      files: [{
        Id: input.itemId,
        Name: input.name ?? path.basename(target),
        Path: target,
        IsFolder: false,
        Size: input.remote.length,
        Modified: input.modified,
        eTag: input.etag,
        VersionLabel: input.version,
        WebUrl: 'https://x/Documents/Documents/catalog-strategy.md?web=1',
      }],
    });
  }

  it('decodes MCP v2 Unicode list fields and establishes a missing base item ID before approval', async () => {
    const { productDocuments, publications, staged } = setupUpdate({
      target: UNICODE_TARGET,
      format: 'docx',
      baseRemoteItemId: null,
    });
    const remote = Buffer.from('current remote docx bytes after owner editing');
    const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
    const mcpManager = {
      callTool: async (_server: string, tool: string, args: Record<string, unknown>) => {
        calls.push({ tool, args });
        if (tool === 'sharepoint_list_files') {
          return {
            text: listedIdentity({
              itemId: '140', remote, etag: 'etag-unicode', version: '7.0',
              modified: '2026-09-17T08:00:00Z',
              name: ENCODED_UNICODE_NAME,
              target: ENCODED_UNICODE_TARGET,
            }),
            isError: false,
          };
        }
        if (tool === 'sharepoint_read_file') {
          writeFileSync(String(args.savePath), remote);
          return { text: '{}', isError: false };
        }
        if (tool === 'sharepoint_write_file') throw new Error('approval must not write');
        throw new Error(`unexpected tool ${tool}`);
      },
    };
    const app = appWith({
      mcpManager: mcpManager as never,
      productDocumentService: productDocuments,
      productDocumentPublications: publications,
    });

    const approved = await request(app)
      .post(`/api/documents/pending-edits/${staged.pendingEdit.id}/approve`)
      .send({})
      .expect(200);

    expect(calls.map(call => call.tool)).toEqual([
      'sharepoint_list_files',
      'sharepoint_read_file',
      'sharepoint_list_files',
    ]);
    for (const call of calls.filter(entry => entry.tool === 'sharepoint_list_files')) {
      expect(call.args).toMatchObject({ libraryName: 'Documents', top: 100, includeWebUrls: true });
      expect(call.args).not.toHaveProperty('folderPath');
      expect(call.args).not.toHaveProperty('personal');
      expect(call.args).not.toHaveProperty('siteUrl');
    }
    expect(approved.body.remoteSnapshot).toMatchObject({
      sha256: sha256Buffer(remote),
      itemId: '140',
      etag: 'etag-unicode',
      version: '7.0',
    });
    expect(publications.get(staged.publication.publicationId)).toMatchObject({
      status: 'approved',
      expectedRemoteItemId: '140',
      expectedRemoteSha256: sha256Buffer(remote),
    });
  });

  it('fails closed on malformed, duplicate, missing, or base-mismatched list identity', async () => {
    const { productDocuments, publications, staged } = setupUpdate();
    let listPayload: unknown = {};
    let reads = 0;
    const mcpManager = {
      callTool: async (_server: string, tool: string, args: Record<string, unknown>) => {
        if (tool === 'sharepoint_list_files') return { text: JSON.stringify(listPayload), isError: false };
        if (tool === 'sharepoint_read_file') {
          reads++;
          writeFileSync(String(args.savePath), Buffer.from('must not be read'));
          return { text: '{}', isError: false };
        }
        throw new Error(`unexpected tool ${tool}`);
      },
    };
    const app = appWith({
      mcpManager: mcpManager as never,
      productDocumentService: productDocuments,
      productDocumentPublications: publications,
    });
    const approve = () => request(app)
      .post(`/api/documents/pending-edits/${staged.pendingEdit.id}/approve`)
      .send({});
    const exact = { Name: 'catalog-strategy.md', Path: TARGET, IsFolder: false, Size: 10, Modified: '2026-09-17T08:00:00Z' };

    listPayload = { files: [{ ...exact, Name: 'catalog-strategy%ZZ.md', Id: 140 }] };
    expect((await approve()).body.error).toMatch(/could not be resolved to one item/);

    listPayload = { files: [{ ...exact, Id: 140 }, { ...exact, Id: 141 }] };
    expect((await approve()).body.error).toMatch(/More than one SharePoint item matched/);

    listPayload = { files: [{ ...exact, Id: '' }] };
    expect((await approve()).body.error).toMatch(/no stable item ID/);

    listPayload = { files: [{ ...exact, Id: 141 }] };
    expect((await approve()).body.error).toMatch(/different SharePoint item now occupies/);

    expect(reads).toBe(0);
    expect(publications.get(staged.publication.publicationId)).toMatchObject({
      status: 'staged',
      expectedRemoteItemId: null,
    });
    expect(getPendingEdit(storage.getDb(), staged.pendingEdit.id)?.status).toBe('pending');
  });

  it('allows intentional remote edits before approval, then publishes and verifies the exact artifact', async () => {
    const { productDocuments, publications, staged } = setupUpdate();
    const state = {
      itemId: '140',
      remote: Buffer.from('# Catalog strategy\n\nThe owner manually edited the live document after V1.'),
      etag: 'etag-owner-edit',
      version: '2.0',
      modified: '2026-09-16T02:00:00Z',
    };
    const approvedRemoteSha = sha256Buffer(state.remote);
    const writes: Array<Record<string, unknown>> = [];
    const mcpManager = {
      callTool: async (_server: string, tool: string, args: Record<string, unknown>) => {
        if (tool === 'sharepoint_list_files') return { text: listedIdentity(state), isError: false };
        if (tool === 'sharepoint_read_file') {
          writeFileSync(String(args.savePath), state.remote);
          return { text: '{}', isError: false };
        }
        if (tool === 'sharepoint_write_file') {
          writes.push(args);
          state.remote = Buffer.from(String(args.content ?? ''));
          state.etag = 'etag-botboy-v2';
          state.version = '3.0';
          state.modified = '2026-09-16T03:00:00Z';
          return { text: JSON.stringify({ Id: 140, eTag: state.etag }), isError: false };
        }
        throw new Error(`unexpected tool ${tool}`);
      },
    };
    const sharePointSync = {
      enqueueByPath: () => ({ queued: true, docKey: staged.publication.docKey }),
      drainNow: async () => {
        publications.recordCapture(staged.publication.publicationId, 'capture-v2', staged.publication.docKey);
        return 1;
      },
    };
    const app = appWith({
      mcpManager: mcpManager as never,
      sharePointSync: sharePointSync as never,
      productDocumentService: productDocuments,
      productDocumentPublications: publications,
    });

    const approved = await request(app)
      .post(`/api/documents/pending-edits/${staged.pendingEdit.id}/approve`)
      .send({})
      .expect(200);
    expect(approved.body.remoteSnapshot).toMatchObject({
      sha256: approvedRemoteSha,
      itemId: '140',
      etag: 'etag-owner-edit',
      version: '2.0',
      modified: '2026-09-16T02:00:00Z',
    });
    expect(approvedRemoteSha).not.toBe(sha256Buffer(Buffer.from(V1)));

    const synced = await request(app)
      .post('/api/documents/sync')
      .send({ docKey: staged.publication.docKey })
      .expect(200);

    expect(synced.body).toMatchObject({ uploaded: true, alreadyCurrent: false, verifiedOnReadBack: true });
    expect(writes).toHaveLength(1);
    expect(state.remote.toString('utf8')).toBe(V2);
    expect(publications.get(staged.publication.publicationId)).toMatchObject({
      status: 'complete',
      expectedRemoteSha256: approvedRemoteSha,
      expectedRemoteItemId: '140',
      expectedRemoteEtag: 'etag-owner-edit',
      expectedRemoteVersion: '2.0',
      remoteItemId: '140',
      verifiedRemoteSha256: sha256Buffer(Buffer.from(V2)),
      capturedWorkItemId: 'capture-v2',
    });
  });

  it('blocks post-approval drift before write and records one actionable target conflict', async () => {
    const { productDocuments, publications, staged } = setupUpdate();
    const state = {
      itemId: '140',
      remote: Buffer.from('owner-approved remote bytes'),
      etag: 'etag-approved',
      version: '2.0',
      modified: '2026-09-16T02:00:00Z',
    };
    let writes = 0;
    const mcpManager = {
      callTool: async (_server: string, tool: string, args: Record<string, unknown>) => {
        if (tool === 'sharepoint_list_files') return { text: listedIdentity(state), isError: false };
        if (tool === 'sharepoint_read_file') {
          writeFileSync(String(args.savePath), state.remote);
          return { text: '{}', isError: false };
        }
        if (tool === 'sharepoint_write_file') {
          writes++;
          return { text: '{}', isError: false };
        }
        throw new Error(`unexpected tool ${tool}`);
      },
    };
    const app = appWith({
      mcpManager: mcpManager as never,
      productDocumentService: productDocuments,
      productDocumentPublications: publications,
    });

    await request(app)
      .post(`/api/documents/pending-edits/${staged.pendingEdit.id}/approve`)
      .send({})
      .expect(200);
    state.remote = Buffer.from('a teammate changed these bytes after owner approval');
    state.etag = 'etag-newer';
    state.version = '3.0';
    state.modified = '2026-09-16T02:10:00Z';

    const synced = await request(app)
      .post('/api/documents/sync')
      .send({ docKey: staged.publication.docKey })
      .expect(200);

    expect(synced.body).toMatchObject({ uploaded: false, alreadyCurrent: false, verifiedOnReadBack: false });
    expect(synced.body.results[0]).toMatchObject({ applied: false });
    expect(synced.body.results[0].reason).toBe(
      'The SharePoint file changed after owner approval; update stopped without overwriting that newer remote version.',
    );
    expect(writes).toBe(0);
    expect(publications.get(staged.publication.publicationId)).toMatchObject({
      status: 'target_conflict',
      lastError: synced.body.results[0].reason,
    });
    expect(getPendingEdit(storage.getDb(), staged.pendingEdit.id)).toMatchObject({
      status: 'conflicted',
      conflictReason: synced.body.results[0].reason,
    });
  });

  it('does not record approval when item identity changes during the approval observation', async () => {
    const { productDocuments, publications, staged } = setupUpdate();
    const remote = Buffer.from('remote bytes during a racing approval');
    let listCalls = 0;
    let writes = 0;
    const mcpManager = {
      callTool: async (_server: string, tool: string, args: Record<string, unknown>) => {
        if (tool === 'sharepoint_list_files') {
          listCalls++;
          return {
            text: listedIdentity({
              itemId: listCalls === 1 ? '140' : '141',
              remote,
              etag: listCalls === 1 ? 'etag-before' : 'etag-after',
              version: listCalls === 1 ? '2.0' : '3.0',
              modified: listCalls === 1 ? '2026-09-16T02:00:00Z' : '2026-09-16T02:01:00Z',
            }),
            isError: false,
          };
        }
        if (tool === 'sharepoint_read_file') {
          writeFileSync(String(args.savePath), remote);
          return { text: '{}', isError: false };
        }
        if (tool === 'sharepoint_write_file') {
          writes++;
          return { text: '{}', isError: false };
        }
        throw new Error(`unexpected tool ${tool}`);
      },
    };
    const app = appWith({
      mcpManager: mcpManager as never,
      productDocumentService: productDocuments,
      productDocumentPublications: publications,
    });

    const approval = await request(app)
      .post(`/api/documents/pending-edits/${staged.pendingEdit.id}/approve`)
      .send({})
      .expect(400);

    expect(approval.body.error).toMatch(/different SharePoint item now occupies/);
    expect(listCalls).toBe(2);
    expect(writes).toBe(0);
    expect(publications.get(staged.publication.publicationId)).toMatchObject({
      status: 'staged',
      expectedRemoteSha256: null,
      remoteObservedAt: null,
    });
    expect(getPendingEdit(storage.getDb(), staged.pendingEdit.id)?.status).toBe('pending');
  });

  it('projects only the newest actionable card for legacy duplicate conflict rows', async () => {
    const { productDocuments, publications, staged } = setupUpdate();
    const approved = decidePendingEdit(storage.getDb(), staged.pendingEdit.id, 'approved');
    publications.recordDecision(approved.id, 'approved', approved.approvedAt!, {
      sha256: 'a'.repeat(64),
      itemId: '140',
      observedAt: '2026-09-16T02:00:00Z',
    });
    publications.recordFailure(staged.publication.publicationId, 'target_conflict', 'First conflict.');
    markEditConflicted(storage.getDb(), staged.pendingEdit.id, 'First conflict.');

    const duplicateEdit = createPendingEdit(storage.getDb(), {
      docKey: staged.publication.docKey,
      serverRelativeUrl: staged.publication.serverRelativeUrl,
      kind: 'botboy',
      operation: 'createDocument',
      createContent: V2,
      projectId: 'p1',
      allowExistingTarget: true,
      originNote: 'legacy duplicate conflict',
    }, '2026-09-16T03:00:00Z');
    decidePendingEdit(storage.getDb(), duplicateEdit.id, 'approved', '2026-09-16T03:01:00Z');
    markEditConflicted(storage.getDb(), duplicateEdit.id, 'Second conflict.');
    storage.getDb().prepare(`
      INSERT INTO product_document_publications (
        publication_id, artifact_id, project_id, publication_action, base_publication_id,
        intent_key, format, pending_edit_id, status, site_url, server_relative_url,
        doc_key, last_error, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'target_conflict', ?, ?, ?, ?, ?, ?)
    `).run(
      'publication-legacy-duplicate',
      staged.publication.artifactId,
      staged.publication.projectId,
      staged.publication.action,
      staged.publication.basePublicationId,
      staged.publication.intentKey,
      staged.publication.format,
      duplicateEdit.id,
      staged.publication.siteUrl,
      staged.publication.serverRelativeUrl,
      staged.publication.docKey,
      'Second conflict.',
      '2026-09-16T03:00:00Z',
      '2026-09-16T03:01:00Z',
    );
    const app = appWith({
      productDocumentService: productDocuments,
      productDocumentPublications: publications,
    });

    const response = await request(app).get('/api/projects/p1/documents').expect(200);

    expect(response.body.stagedCreations).toHaveLength(1);
    expect(response.body.stagedCreations[0]).toMatchObject({
      id: duplicateEdit.id,
      publicationId: 'publication-legacy-duplicate',
      publicationStatus: 'target_conflict',
      publicationIntentKey: staged.publication.intentKey,
      status: 'conflicted',
      conflictReason: 'Second conflict.',
    });
    expect(response.body.publications).toEqual(expect.arrayContaining([
      expect.objectContaining({ publicationId: staged.publication.publicationId, status: 'target_conflict' }),
      expect.objectContaining({ publicationId: 'publication-legacy-duplicate', status: 'target_conflict' }),
    ]));
  });
});

describe('publication update UI contract', () => {
  it('renders update-aware approval, sync, snapshot, and conflict-dismissal actions', () => {
    const source = readFileSync(new URL('../../ui/dashboard.js', import.meta.url), 'utf8');
    expect(source).toContain('Approved remote snapshot');
    expect(source).toContain('data-update="${isUpdate');
    expect(source).toContain('data-conflict="true">Dismiss conflict</button>');
    expect(source).toContain('Update approved against the current SharePoint version');
    expect(source).toContain('SharePoint version ${result.alreadyCurrent ? \'was already current\' : \'updated\'}');
  });
});
