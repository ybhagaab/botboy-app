import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { createPendingEdit, ensurePendingEditsTable, type PendingEdit } from '../core/pending-edits.js';
import { docKeyForPath } from '../core/document-corpus.js';
import { mapSharePointWriteTarget } from '../core/docx-body-editor.js';
import type { ProductDocumentService } from './types.js';

export type ProductDocumentPublicationStatus =
  | 'staged'
  | 'approved'
  | 'exported'
  | 'uploaded_unverified'
  | 'verified'
  | 'capture_queued'
  | 'complete'
  | 'rejected'
  | 'target_conflict'
  | 'upload_failed'
  | 'verification_failed'
  | 'capture_failed'
  | 'identity_mismatch'
  | 'superseded';

export interface ProductDocumentPublication {
  publicationId: string;
  artifactId: string;
  projectId: string;
  format: 'md' | 'docx';
  pendingEditId: string;
  status: ProductDocumentPublicationStatus;
  siteUrl: string | null;
  serverRelativeUrl: string;
  docKey: string;
  webUrl: string | null;
  remoteItemId: string | null;
  remoteEtag: string | null;
  exportSha256: string | null;
  exportBytes: number | null;
  exportFilename: string | null;
  capturedWorkItemId: string | null;
  lastError: string | null;
  createdAt: string;
  approvedAt: string | null;
  exportedAt: string | null;
  uploadedAt: string | null;
  verifiedAt: string | null;
  capturedAt: string | null;
  updatedAt: string;
}

export interface StageProductDocumentPublicationInput {
  artifactId: string;
  projectId: string;
  format: 'md' | 'docx';
  title: string;
  serverRelativeUrl?: string;
  targetFolder?: string;
  siteUrl?: string;
  purpose?: string;
}

export interface ProductDocumentPublicationService {
  stage(input: StageProductDocumentPublicationInput): { publication: ProductDocumentPublication; pendingEdit: PendingEdit };
  get(publicationId: string): ProductDocumentPublication | null;
  findByPendingEdit(pendingEditId: string): ProductDocumentPublication | null;
  listByProject(projectId: string): ProductDocumentPublication[];
  listByArtifact(artifactId: string): ProductDocumentPublication[];
  hasForChain(artifactId: string): boolean;
  recordDecision(pendingEditId: string, decision: 'approved' | 'rejected', at?: string): ProductDocumentPublication | null;
  recordExport(publicationId: string, receipt: { sha256: string; bytes: number; filename: string }, at?: string): ProductDocumentPublication;
  recordUploaded(publicationId: string, receipt?: { webUrl?: string; remoteItemId?: string; remoteEtag?: string }, at?: string): ProductDocumentPublication;
  recordVerified(publicationId: string, at?: string): ProductDocumentPublication;
  recordCaptureQueued(publicationId: string, at?: string): ProductDocumentPublication;
  recordCapture(publicationId: string, workItemId: string, docKey: string, at?: string): ProductDocumentPublication;
  recordFailure(publicationId: string, status: Extract<ProductDocumentPublicationStatus,
    'target_conflict' | 'upload_failed' | 'verification_failed' | 'capture_failed' | 'identity_mismatch'>, error: string, at?: string): ProductDocumentPublication;
}

interface PublicationRow {
  publication_id: string;
  artifact_id: string;
  project_id: string;
  format: 'md' | 'docx';
  pending_edit_id: string;
  status: ProductDocumentPublicationStatus;
  site_url: string | null;
  server_relative_url: string;
  doc_key: string;
  web_url: string | null;
  remote_item_id: string | null;
  remote_etag: string | null;
  export_sha256: string | null;
  export_bytes: number | null;
  export_filename: string | null;
  captured_work_item_id: string | null;
  last_error: string | null;
  created_at: string;
  approved_at: string | null;
  exported_at: string | null;
  uploaded_at: string | null;
  verified_at: string | null;
  captured_at: string | null;
  updated_at: string;
}

const ACTIVE_STATUSES = new Set<ProductDocumentPublicationStatus>([
  'staged', 'approved', 'exported', 'uploaded_unverified', 'verified', 'capture_queued',
]);

const STATUS_PREDECESSORS: Record<ProductDocumentPublicationStatus, ProductDocumentPublicationStatus[]> = {
  staged: [],
  approved: ['staged'],
  exported: ['approved'],
  uploaded_unverified: ['exported'],
  verified: ['uploaded_unverified'],
  capture_queued: ['verified'],
  complete: ['capture_queued', 'verified'],
  rejected: ['staged', 'target_conflict', 'upload_failed', 'verification_failed', 'capture_failed', 'identity_mismatch'],
  target_conflict: ['approved'],
  upload_failed: ['approved', 'exported'],
  verification_failed: ['uploaded_unverified'],
  capture_failed: ['verified', 'capture_queued'],
  identity_mismatch: ['uploaded_unverified', 'verified', 'capture_queued'],
  superseded: ['staged', 'approved', 'exported', 'uploaded_unverified', 'verified', 'capture_queued'],
};

function rowToPublication(row: PublicationRow): ProductDocumentPublication {
  return {
    publicationId: row.publication_id,
    artifactId: row.artifact_id,
    projectId: row.project_id,
    format: row.format,
    pendingEditId: row.pending_edit_id,
    status: row.status,
    siteUrl: row.site_url,
    serverRelativeUrl: row.server_relative_url,
    docKey: row.doc_key,
    webUrl: row.web_url,
    remoteItemId: row.remote_item_id,
    remoteEtag: row.remote_etag,
    exportSha256: row.export_sha256,
    exportBytes: row.export_bytes,
    exportFilename: row.export_filename,
    capturedWorkItemId: row.captured_work_item_id,
    lastError: row.last_error,
    createdAt: row.created_at,
    approvedAt: row.approved_at,
    exportedAt: row.exported_at,
    uploadedAt: row.uploaded_at,
    verifiedAt: row.verified_at,
    capturedAt: row.captured_at,
    updatedAt: row.updated_at,
  };
}

function safeFileTitle(value: string): string {
  return value.replace(/[\\/:*?"<>|#%]/g, '').replace(/\s+/g, ' ').trim();
}

function boundedOptional(value: unknown, maximum: number): string | null {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, maximum) : null;
}

/** Parse only stable/verification fields from an opaque MCP result. Unknown
 * response shapes stay null rather than becoming identity claims. */
export function publicationRemoteReceipt(text: string): { webUrl?: string; remoteItemId?: string; remoteEtag?: string } {
  let value: unknown;
  try { value = JSON.parse(text); } catch { return {}; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const record = value as Record<string, unknown>;
  const nested = record.result && typeof record.result === 'object' && !Array.isArray(record.result)
    ? record.result as Record<string, unknown>
    : record;
  const webUrl = boundedOptional(nested.webUrl ?? nested.WebUrl, 1_000);
  const remoteItemId = boundedOptional(nested.driveItemId ?? nested.itemId ?? nested.uniqueId ?? nested.UniqueId, 300);
  const remoteEtag = boundedOptional(nested.eTag ?? nested.etag ?? nested.ETag, 300);
  return {
    ...(webUrl ? { webUrl } : {}),
    ...(remoteItemId ? { remoteItemId } : {}),
    ...(remoteEtag ? { remoteEtag } : {}),
  };
}

export function createProductDocumentPublicationService(
  db: Database.Database,
  productDocuments: ProductDocumentService,
  options: { now?: () => Date; createId?: () => string } = {},
): ProductDocumentPublicationService {
  const now = options.now ?? (() => new Date());
  const createId = options.createId ?? (() => randomUUID());
  ensurePendingEditsTable(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS product_document_publications (
      publication_id TEXT PRIMARY KEY,
      artifact_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      format TEXT NOT NULL CHECK(format IN ('md','docx')),
      pending_edit_id TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL CHECK(status IN (
        'staged','approved','exported','uploaded_unverified','verified','capture_queued','complete',
        'rejected','target_conflict','upload_failed','verification_failed','capture_failed','identity_mismatch','superseded'
      )),
      site_url TEXT,
      server_relative_url TEXT NOT NULL,
      doc_key TEXT NOT NULL,
      web_url TEXT,
      remote_item_id TEXT,
      remote_etag TEXT,
      export_sha256 TEXT,
      export_bytes INTEGER,
      export_filename TEXT,
      captured_work_item_id TEXT,
      last_error TEXT,
      created_at TEXT NOT NULL,
      approved_at TEXT,
      exported_at TEXT,
      uploaded_at TEXT,
      verified_at TEXT,
      captured_at TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_product_document_publications_project
      ON product_document_publications(project_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_product_document_publications_artifact
      ON product_document_publications(artifact_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_product_document_publications_doc_key
      ON product_document_publications(doc_key, created_at DESC);
  `);

  const selectById = db.prepare('SELECT * FROM product_document_publications WHERE publication_id = ?');
  const selectByPending = db.prepare('SELECT * FROM product_document_publications WHERE pending_edit_id = ?');
  const listProject = db.prepare('SELECT * FROM product_document_publications WHERE project_id = ? ORDER BY created_at DESC, publication_id DESC');
  const listArtifact = db.prepare('SELECT * FROM product_document_publications WHERE artifact_id = ? ORDER BY created_at DESC, publication_id DESC');
  const artifactTableExists = Boolean(db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='product_document_artifacts'",
  ).get());
  const hasChainPublication = artifactTableExists
    ? db.prepare(`
      WITH RECURSIVE chain(artifact_id) AS (
        SELECT artifact_id FROM product_document_artifacts WHERE artifact_id = ?
        UNION
        SELECT p.parent_artifact_id
        FROM product_document_artifacts p
        JOIN chain c ON p.artifact_id = c.artifact_id
        WHERE p.parent_artifact_id IS NOT NULL
        UNION
        SELECT child.artifact_id
        FROM product_document_artifacts child
        JOIN chain c ON child.parent_artifact_id = c.artifact_id
      )
      SELECT 1 AS found
      FROM product_document_publications
      WHERE artifact_id IN (SELECT artifact_id FROM chain)
        AND status <> 'superseded'
      LIMIT 1
    `)
    : db.prepare(`
      SELECT 1 AS found FROM product_document_publications
      WHERE artifact_id = ? AND status <> 'superseded' LIMIT 1
    `);
  const insert = db.prepare(`
    INSERT INTO product_document_publications
      (publication_id, artifact_id, project_id, format, pending_edit_id, status, site_url,
       server_relative_url, doc_key, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'staged', ?, ?, ?, ?, ?)
  `);

  const get = (publicationId: string): ProductDocumentPublication | null => {
    const row = selectById.get(publicationId) as PublicationRow | undefined;
    return row ? rowToPublication(row) : null;
  };

  const transition = (
    publicationId: string,
    status: ProductDocumentPublicationStatus,
    patch: Record<string, string | number | null> = {},
    at = now().toISOString(),
  ): ProductDocumentPublication => {
    const current = get(publicationId);
    if (!current) throw new Error(`Unknown product-document publication '${publicationId}'.`);
    if (!STATUS_PREDECESSORS[status].includes(current.status)) {
      throw new Error(`Publication ${publicationId} cannot move from ${current.status} to ${status}.`);
    }
    const columnByKey: Record<string, string> = {
      approvedAt: 'approved_at',
      exportedAt: 'exported_at',
      uploadedAt: 'uploaded_at',
      verifiedAt: 'verified_at',
      capturedAt: 'captured_at',
      exportSha256: 'export_sha256',
      exportBytes: 'export_bytes',
      exportFilename: 'export_filename',
      webUrl: 'web_url',
      remoteItemId: 'remote_item_id',
      remoteEtag: 'remote_etag',
      capturedWorkItemId: 'captured_work_item_id',
      lastError: 'last_error',
      docKey: 'doc_key',
    };
    const entries = Object.entries(patch).filter(([key]) => columnByKey[key]);
    const assignments = ['status = ?', 'updated_at = ?', ...entries.map(([key]) => `${columnByKey[key]} = ?`)];
    const values = [status, at, ...entries.map(([, value]) => value), publicationId];
    db.prepare(`UPDATE product_document_publications SET ${assignments.join(', ')} WHERE publication_id = ?`).run(...values);
    return get(publicationId)!;
  };

  return {
    stage(input) {
      const artifact = productDocuments.getArtifact(input.artifactId);
      if (!artifact) throw new Error(`Official product-document artifact '${input.artifactId}' was not found.`);
      if (!artifact.projectId) throw new Error('Assign the authored document to a project before publishing it.');
      const project = db.prepare('SELECT title, status FROM projects WHERE id = ?').get(artifact.projectId) as
        | { title: string; status: string }
        | undefined;
      if (!project) throw new Error(`Owning project '${artifact.projectId}' no longer exists.`);
      if (project.status !== 'active' && project.status !== 'paused') {
        throw new Error(`Owning project '${project.title}' is ${project.status}; move the chain to an active or paused project before publishing.`);
      }
      if (artifact.projectId !== input.projectId) {
        throw new Error('The requested project does not own this artifact chain. Relink the chain explicitly before publishing.');
      }
      if (input.format !== 'md' && input.format !== 'docx') throw new Error('Publication format must be md or docx.');
      const title = input.title.trim() || artifact.title;
      let serverRelativeUrl = input.serverRelativeUrl?.trim() || '';
      if (!serverRelativeUrl) {
        const folder = input.targetFolder?.trim().replace(/\/+$/, '') || '';
        if (!folder) throw new Error('Provide targetFolder or a complete serverRelativeUrl.');
        serverRelativeUrl = `${folder}/${safeFileTitle(title)}.${input.format}`;
      }
      if (!serverRelativeUrl.toLowerCase().endsWith(`.${input.format}`)) {
        throw new Error(`The target path must end in .${input.format}.`);
      }
      const mapped = mapSharePointWriteTarget(serverRelativeUrl, input.siteUrl);
      if (typeof mapped === 'string') throw new Error(mapped.replace(/^Error:\s*/i, ''));
      const docKey = docKeyForPath(db, serverRelativeUrl, input.siteUrl);
      const publicationId = createId();
      const createdAt = now().toISOString();
      return db.transaction(() => {
        const pendingEdit = createPendingEdit(db, {
          docKey,
          serverRelativeUrl,
          ...(input.siteUrl ? { siteUrl: input.siteUrl } : {}),
          kind: 'botboy',
          operation: 'createDocument',
          createContent: artifact.content,
          projectId: artifact.projectId,
          originNote: `official artifact ${artifact.artifactId}${input.purpose ? ` · ${input.purpose}` : ''}`.slice(0, 300),
        }, createdAt);
        insert.run(
          publicationId,
          artifact.artifactId,
          artifact.projectId,
          input.format,
          pendingEdit.id,
          input.siteUrl?.trim() || null,
          serverRelativeUrl,
          docKey,
          createdAt,
          createdAt,
        );
        return { publication: get(publicationId)!, pendingEdit };
      })();
    },

    get,
    findByPendingEdit(pendingEditId) {
      const row = selectByPending.get(pendingEditId) as PublicationRow | undefined;
      return row ? rowToPublication(row) : null;
    },
    listByProject(projectId) {
      return (listProject.all(projectId) as PublicationRow[]).map(rowToPublication);
    },
    listByArtifact(artifactId) {
      return (listArtifact.all(artifactId) as PublicationRow[]).map(rowToPublication);
    },
    hasForChain(artifactId) {
      return Boolean(hasChainPublication.get(artifactId));
    },
    recordDecision(pendingEditId, decision, at = now().toISOString()) {
      const row = selectByPending.get(pendingEditId) as PublicationRow | undefined;
      const current = row ? rowToPublication(row) : null;
      if (!current) return null;
      return transition(
        current.publicationId,
        decision,
        decision === 'approved' ? { approvedAt: at, lastError: null } : { lastError: null },
        at,
      );
    },
    recordExport(publicationId, receipt, at = now().toISOString()) {
      if (!/^[a-f0-9]{64}$/i.test(receipt.sha256) || !Number.isInteger(receipt.bytes) || receipt.bytes < 0) {
        throw new Error('Canonical export receipt is invalid.');
      }
      const current = get(publicationId);
      if (current?.status === 'exported'
        && current.exportSha256 === receipt.sha256.toLowerCase()
        && current.exportBytes === receipt.bytes
        && current.exportFilename === receipt.filename.slice(0, 300)) return current;
      return transition(publicationId, 'exported', {
        exportSha256: receipt.sha256.toLowerCase(),
        exportBytes: receipt.bytes,
        exportFilename: receipt.filename.slice(0, 300),
        exportedAt: at,
        lastError: null,
      }, at);
    },
    recordUploaded(publicationId, receipt = {}, at = now().toISOString()) {
      return transition(publicationId, 'uploaded_unverified', {
        uploadedAt: at,
        webUrl: receipt.webUrl?.slice(0, 1_000) ?? null,
        remoteItemId: receipt.remoteItemId?.slice(0, 300) ?? null,
        remoteEtag: receipt.remoteEtag?.slice(0, 300) ?? null,
        lastError: null,
      }, at);
    },
    recordVerified(publicationId, at = now().toISOString()) {
      return transition(publicationId, 'verified', { verifiedAt: at, lastError: null }, at);
    },
    recordCaptureQueued(publicationId, at = now().toISOString()) {
      const current = get(publicationId);
      if (current?.status === 'capture_queued') return current;
      return transition(publicationId, 'capture_queued', { lastError: null }, at);
    },
    recordCapture(publicationId, workItemId, docKey, at = now().toISOString()) {
      const current = get(publicationId);
      if (!current) throw new Error(`Unknown product-document publication '${publicationId}'.`);
      if (current.status === 'complete'
        && current.capturedWorkItemId === workItemId
        && current.docKey === docKey) return current;
      if (current.docKey !== docKey) {
        return transition(publicationId, 'identity_mismatch', {
          lastError: `Captured docKey '${docKey}' did not match publication target '${current.docKey}'.`,
        }, at);
      }
      return transition(publicationId, 'complete', {
        capturedWorkItemId: workItemId,
        capturedAt: at,
        lastError: null,
      }, at);
    },
    recordFailure(publicationId, status, error, at = now().toISOString()) {
      return transition(publicationId, status, { lastError: error.slice(0, 1_000) }, at);
    },
  };
}

export function sha256Buffer(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

export function isActivePublicationStatus(status: ProductDocumentPublicationStatus): boolean {
  return ACTIVE_STATUSES.has(status);
}
