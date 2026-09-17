import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { createPendingEdit, decidePendingEdit, ensurePendingEditsTable, getPendingEdit, markEditSynced, type PendingEdit } from '../core/pending-edits.js';
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

export type ProductDocumentPublicationAction = 'create' | 'update_existing';

export interface PublicationRemoteSnapshot {
  sha256: string;
  itemId: string;
  etag?: string;
  version?: string;
  modified?: string;
  size?: number;
  webUrl?: string;
  observedAt: string;
}

export interface StageProductDocumentPublicationResult {
  publication: ProductDocumentPublication;
  pendingEdit: PendingEdit;
  idempotent: boolean;
  replacesPublicationIds: string[];
}

export interface ProductDocumentPublication {
  publicationId: string;
  artifactId: string;
  projectId: string;
  action: ProductDocumentPublicationAction;
  basePublicationId: string | null;
  intentKey: string | null;
  expectedRemoteSha256: string | null;
  expectedRemoteItemId: string | null;
  expectedRemoteEtag: string | null;
  expectedRemoteVersion: string | null;
  expectedRemoteModified: string | null;
  expectedRemoteSize: number | null;
  remoteObservedAt: string | null;
  supersededAt: string | null;
  supersessionReason: string | null;
  baseRemoteSha256: string | null;
  repairNote: string | null;
  retiredAt: string | null;
  retirementNote: string | null;
  replacementPublicationId: string | null;
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
  verifiedRemoteSha256: string | null;
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
  action: ProductDocumentPublicationAction;
  basePublicationId?: string;
  format: 'md' | 'docx';
  title: string;
  serverRelativeUrl?: string;
  targetFolder?: string;
  siteUrl?: string;
  purpose?: string;
}

export interface RecordLegacyPublicationRepairInput {
  artifactId: string;
  projectId: string;
  format: 'md' | 'docx';
  siteUrl?: string;
  serverRelativeUrl: string;
  docKey: string;
  baseRemoteSha256: string;
  exportSha256: string;
  exportBytes: number;
  exportFilename: string;
  remoteItemId: string;
  webUrl?: string;
  repairNote: string;
}

export interface ProductDocumentPublicationService {
  stage(input: StageProductDocumentPublicationInput): StageProductDocumentPublicationResult;
  recordLegacyRepair(input: RecordLegacyPublicationRepairInput, at?: string): { publication: ProductDocumentPublication; pendingEdit: PendingEdit };
  get(publicationId: string): ProductDocumentPublication | null;
  findByPendingEdit(pendingEditId: string): ProductDocumentPublication | null;
  listByProject(projectId: string): ProductDocumentPublication[];
  listByArtifact(artifactId: string): ProductDocumentPublication[];
  listByChain(artifactId: string): ProductDocumentPublication[];
  hasForChain(artifactId: string): boolean;
  recordDecision(pendingEditId: string, decision: 'approved' | 'rejected', at?: string, snapshot?: PublicationRemoteSnapshot): ProductDocumentPublication | null;
  recordExport(publicationId: string, receipt: { sha256: string; bytes: number; filename: string }, at?: string): ProductDocumentPublication;
  recordUploaded(publicationId: string, receipt?: { webUrl?: string; remoteItemId?: string; remoteEtag?: string }, at?: string): ProductDocumentPublication;
  recordVerified(publicationId: string, receipt: { remoteSha256: string; remoteItemId?: string; webUrl?: string }, at?: string): ProductDocumentPublication;
  recordCaptureQueued(publicationId: string, at?: string): ProductDocumentPublication;
  recordCapture(publicationId: string, workItemId: string, docKey: string, at?: string): ProductDocumentPublication;
  recordFailure(publicationId: string, status: Extract<ProductDocumentPublicationStatus,
    'target_conflict' | 'upload_failed' | 'verification_failed' | 'capture_failed' | 'identity_mismatch'>, error: string, at?: string): ProductDocumentPublication;
}

interface PublicationRow {
  publication_id: string;
  artifact_id: string;
  project_id: string;
  publication_action: ProductDocumentPublicationAction;
  base_publication_id: string | null;
  intent_key: string | null;
  expected_remote_sha256: string | null;
  expected_remote_item_id: string | null;
  expected_remote_etag: string | null;
  expected_remote_version: string | null;
  expected_remote_modified: string | null;
  expected_remote_size: number | null;
  remote_observed_at: string | null;
  superseded_at: string | null;
  supersession_reason: string | null;
  base_remote_sha256: string | null;
  repair_note: string | null;
  retired_at: string | null;
  retirement_note: string | null;
  replacement_publication_id: string | null;
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
  verified_remote_sha256: string | null;
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
  superseded: ['staged', 'target_conflict'],
};

function rowToPublication(row: PublicationRow): ProductDocumentPublication {
  return {
    publicationId: row.publication_id,
    artifactId: row.artifact_id,
    projectId: row.project_id,
    action: row.publication_action ?? 'create',
    basePublicationId: row.base_publication_id ?? null,
    intentKey: row.intent_key ?? null,
    expectedRemoteSha256: row.expected_remote_sha256 ?? null,
    expectedRemoteItemId: row.expected_remote_item_id ?? null,
    expectedRemoteEtag: row.expected_remote_etag ?? null,
    expectedRemoteVersion: row.expected_remote_version ?? null,
    expectedRemoteModified: row.expected_remote_modified ?? null,
    expectedRemoteSize: row.expected_remote_size ?? null,
    remoteObservedAt: row.remote_observed_at ?? null,
    supersededAt: row.superseded_at ?? null,
    supersessionReason: row.supersession_reason ?? null,
    baseRemoteSha256: row.base_remote_sha256 ?? null,
    repairNote: row.repair_note ?? null,
    retiredAt: row.retired_at ?? null,
    retirementNote: row.retirement_note ?? null,
    replacementPublicationId: row.replacement_publication_id ?? null,
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
    verifiedRemoteSha256: row.verified_remote_sha256 ?? null,
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
  const normalized = typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
  return normalized ? normalized.slice(0, maximum) : null;
}

export function productDocumentPublicationIntentKey(input: {
  artifactId: string;
  projectId: string;
  action: ProductDocumentPublicationAction;
  basePublicationId?: string | null;
  format: 'md' | 'docx';
  docKey: string;
}): string {
  return createHash('sha256').update(JSON.stringify([
    input.artifactId,
    input.projectId,
    input.action,
    input.basePublicationId ?? '',
    input.format,
    input.docKey,
  ])).digest('hex');
}

function publicationTargetSlotKey(input: {
  projectId: string;
  action: ProductDocumentPublicationAction;
  basePublicationId?: string | null;
  format: 'md' | 'docx';
  docKey: string;
}): string {
  return JSON.stringify([
    input.projectId,
    input.action,
    input.basePublicationId ?? '',
    input.format,
    input.docKey,
  ]);
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
  const remoteItemId = boundedOptional(nested.driveItemId ?? nested.itemId ?? nested.uniqueId ?? nested.UniqueId ?? nested.Id, 300);
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
      publication_action TEXT NOT NULL DEFAULT 'create' CHECK(publication_action IN ('create','update_existing')),
      base_publication_id TEXT,
      intent_key TEXT,
      expected_remote_sha256 TEXT,
      expected_remote_item_id TEXT,
      expected_remote_etag TEXT,
      expected_remote_version TEXT,
      expected_remote_modified TEXT,
      expected_remote_size INTEGER,
      remote_observed_at TEXT,
      superseded_at TEXT,
      supersession_reason TEXT,
      base_remote_sha256 TEXT,
      repair_note TEXT,
      retired_at TEXT,
      retirement_note TEXT,
      replacement_publication_id TEXT,
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
      verified_remote_sha256 TEXT,
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
  const publicationColumns = new Set(
    (db.prepare('PRAGMA table_info(product_document_publications)').all() as Array<{ name: string }>).map(column => column.name),
  );
  if (!publicationColumns.has('publication_action')) {
    db.exec("ALTER TABLE product_document_publications ADD COLUMN publication_action TEXT NOT NULL DEFAULT 'create' CHECK(publication_action IN ('create','update_existing'))");
  }
  if (!publicationColumns.has('base_publication_id')) {
    db.exec('ALTER TABLE product_document_publications ADD COLUMN base_publication_id TEXT');
  }
  const additivePublicationColumns: Array<[string, string]> = [
    ['intent_key', 'intent_key TEXT'],
    ['expected_remote_sha256', 'expected_remote_sha256 TEXT'],
    ['expected_remote_item_id', 'expected_remote_item_id TEXT'],
    ['expected_remote_etag', 'expected_remote_etag TEXT'],
    ['expected_remote_version', 'expected_remote_version TEXT'],
    ['expected_remote_modified', 'expected_remote_modified TEXT'],
    ['expected_remote_size', 'expected_remote_size INTEGER'],
    ['remote_observed_at', 'remote_observed_at TEXT'],
    ['superseded_at', 'superseded_at TEXT'],
    ['supersession_reason', 'supersession_reason TEXT'],
  ];
  for (const [name, ddl] of additivePublicationColumns) {
    if (!publicationColumns.has(name)) {
      db.exec(`ALTER TABLE product_document_publications ADD COLUMN ${ddl}`);
      publicationColumns.add(name);
    }
  }
  if (!publicationColumns.has('base_remote_sha256')) {
    db.exec('ALTER TABLE product_document_publications ADD COLUMN base_remote_sha256 TEXT');
  }
  if (!publicationColumns.has('repair_note')) {
    db.exec('ALTER TABLE product_document_publications ADD COLUMN repair_note TEXT');
  }
  if (!publicationColumns.has('retired_at')) {
    db.exec('ALTER TABLE product_document_publications ADD COLUMN retired_at TEXT');
  }
  if (!publicationColumns.has('retirement_note')) {
    db.exec('ALTER TABLE product_document_publications ADD COLUMN retirement_note TEXT');
  }
  if (!publicationColumns.has('replacement_publication_id')) {
    db.exec('ALTER TABLE product_document_publications ADD COLUMN replacement_publication_id TEXT');
  }
  if (!publicationColumns.has('verified_remote_sha256')) {
    db.exec('ALTER TABLE product_document_publications ADD COLUMN verified_remote_sha256 TEXT');
  }
  const legacyIntentRows = db.prepare(`
    SELECT publication_id,artifact_id,project_id,publication_action,base_publication_id,format,doc_key
    FROM product_document_publications WHERE intent_key IS NULL OR trim(intent_key)=''
  `).all() as Array<{
    publication_id: string; artifact_id: string; project_id: string;
    publication_action: ProductDocumentPublicationAction; base_publication_id: string | null;
    format: 'md' | 'docx'; doc_key: string;
  }>;
  const backfillIntent = db.prepare('UPDATE product_document_publications SET intent_key=? WHERE publication_id=?');
  for (const row of legacyIntentRows) {
    backfillIntent.run(productDocumentPublicationIntentKey({
      artifactId: row.artifact_id,
      projectId: row.project_id,
      action: row.publication_action ?? 'create',
      basePublicationId: row.base_publication_id,
      format: row.format,
      docKey: row.doc_key,
    }), row.publication_id);
  }

  const selectById = db.prepare('SELECT * FROM product_document_publications WHERE publication_id = ?');
  const selectByPending = db.prepare('SELECT * FROM product_document_publications WHERE pending_edit_id = ?');
  const listProject = db.prepare('SELECT * FROM product_document_publications WHERE project_id = ? ORDER BY created_at DESC, publication_id DESC');
  const listArtifact = db.prepare('SELECT * FROM product_document_publications WHERE artifact_id = ? ORDER BY created_at DESC, publication_id DESC');
  const artifactTableExists = Boolean(db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='product_document_artifacts'",
  ).get());
  const listChainPublications = artifactTableExists
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
      SELECT * FROM product_document_publications
      WHERE artifact_id IN (SELECT artifact_id FROM chain)
      ORDER BY created_at DESC, publication_id DESC
    `)
    : db.prepare('SELECT * FROM product_document_publications WHERE artifact_id = ? ORDER BY created_at DESC, publication_id DESC');
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
      (publication_id, artifact_id, project_id, publication_action, base_publication_id, intent_key, format,
       pending_edit_id, status, site_url, server_relative_url, doc_key, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'staged', ?, ?, ?, ?, ?)
  `);
  const insertLegacyRepair = db.prepare(`
    INSERT INTO product_document_publications
      (publication_id, artifact_id, project_id, publication_action, base_publication_id,
       base_remote_sha256, repair_note, format, pending_edit_id, status, site_url,
       server_relative_url, doc_key, web_url, remote_item_id, export_sha256,
       verified_remote_sha256, export_bytes, export_filename, captured_work_item_id,
       created_at, approved_at, exported_at, uploaded_at, verified_at, captured_at, updated_at)
    VALUES (?, ?, ?, 'update_existing', NULL, ?, ?, ?, ?, 'verified', ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL,
            ?, ?, ?, ?, ?, NULL, ?)
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
      verifiedRemoteSha256: 'verified_remote_sha256',
      exportBytes: 'export_bytes',
      exportFilename: 'export_filename',
      webUrl: 'web_url',
      remoteItemId: 'remote_item_id',
      remoteEtag: 'remote_etag',
      capturedWorkItemId: 'captured_work_item_id',
      expectedRemoteSha256: 'expected_remote_sha256',
      expectedRemoteItemId: 'expected_remote_item_id',
      expectedRemoteEtag: 'expected_remote_etag',
      expectedRemoteVersion: 'expected_remote_version',
      expectedRemoteModified: 'expected_remote_modified',
      expectedRemoteSize: 'expected_remote_size',
      remoteObservedAt: 'remote_observed_at',
      supersededAt: 'superseded_at',
      supersessionReason: 'supersession_reason',
      replacementPublicationId: 'replacement_publication_id',
      lastError: 'last_error',
      docKey: 'doc_key',
    };
    const entries = Object.entries(patch).filter(([key]) => columnByKey[key]);
    const assignments = ['status = ?', 'updated_at = ?', ...entries.map(([key]) => `${columnByKey[key]} = ?`)];
    const values = [status, at, ...entries.map(([, value]) => value), publicationId, current.status];
    const result = db.prepare(`UPDATE product_document_publications SET ${assignments.join(', ')} WHERE publication_id = ? AND status = ?`).run(...values);
    if (result.changes !== 1) throw new Error(`Publication ${publicationId} changed while moving from ${current.status} to ${status}.`);
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
      if (input.action !== 'create' && input.action !== 'update_existing') {
        throw new Error('Publication action must be create or update_existing.');
      }
      const chainPublications = (listChainPublications.all(artifact.artifactId) as PublicationRow[]).map(rowToPublication);
      let basePublication: ProductDocumentPublication | null = null;
      let siteUrl = input.siteUrl?.trim() || '';
      let serverRelativeUrl = input.serverRelativeUrl?.trim() || '';
      if (input.action === 'update_existing') {
        if (input.serverRelativeUrl?.trim() || input.targetFolder?.trim() || input.siteUrl?.trim()) {
          throw new Error('update_existing inherits the exact prior SharePoint target; do not provide destination fields.');
        }
        if (!input.basePublicationId?.trim()) {
          const eligible = chainPublications
            .filter(candidate => candidate.status === 'complete' && candidate.capturedWorkItemId)
            .map(candidate => `${candidate.publicationId} (${candidate.serverRelativeUrl})`);
          throw new Error(eligible.length
            ? `basePublicationId is required for update_existing. Eligible completed locations: ${eligible.join(', ')}`
            : 'This artifact chain has no completed SharePoint publication to update. Publish a new copy instead.');
        }
        basePublication = get(input.basePublicationId.trim());
        if (!basePublication) throw new Error(`Base publication '${input.basePublicationId.trim()}' was not found.`);
        if (!chainPublications.some(candidate => candidate.publicationId === basePublication!.publicationId)) {
          throw new Error('The selected base publication does not belong to this artifact chain.');
        }
        if (basePublication.projectId !== artifact.projectId) {
          throw new Error('The selected base publication belongs to a different project.');
        }
        if (basePublication.status !== 'complete' || !basePublication.capturedWorkItemId || !basePublication.exportSha256) {
          throw new Error('Only a completed, captured publication with an exact export receipt can be updated.');
        }
        if (basePublication.artifactId === artifact.artifactId) {
          throw new Error('This exact artifact version is already published at the selected location.');
        }
        const latestAtTarget = chainPublications.find(candidate =>
          candidate.docKey === basePublication!.docKey && candidate.status === 'complete');
        if (latestAtTarget?.publicationId !== basePublication.publicationId) {
          throw new Error(`A newer completed publication already owns this target; use basePublicationId '${latestAtTarget?.publicationId}'.`);
        }
        if (input.format !== basePublication.format) {
          throw new Error(`Updating this location must preserve its ${basePublication.format} format.`);
        }
        siteUrl = basePublication.siteUrl ?? '';
        serverRelativeUrl = basePublication.serverRelativeUrl;
      } else {
        if (input.basePublicationId?.trim()) throw new Error('basePublicationId is only valid for update_existing.');
        const title = input.title.trim() || artifact.title;
        if (!serverRelativeUrl) {
          const folder = input.targetFolder?.trim().replace(/\/+$/, '') || '';
          if (!folder) throw new Error('Provide targetFolder or a complete serverRelativeUrl for a new publication.');
          serverRelativeUrl = `${folder}/${safeFileTitle(title)}.${input.format}`;
        }
      }
      if (!serverRelativeUrl.toLowerCase().endsWith(`.${input.format}`)) {
        throw new Error(`The target path must end in .${input.format}.`);
      }
      const mapped = mapSharePointWriteTarget(serverRelativeUrl, siteUrl || undefined);
      if (typeof mapped === 'string') throw new Error(mapped.replace(/^Error:\s*/i, ''));
      const docKey = docKeyForPath(db, serverRelativeUrl, siteUrl || undefined);
      if (basePublication && docKey !== basePublication.docKey) {
        throw new Error('The inherited SharePoint target no longer resolves to the base publication identity.');
      }
      const intentKey = productDocumentPublicationIntentKey({
        artifactId: artifact.artifactId,
        projectId: artifact.projectId,
        action: input.action,
        basePublicationId: basePublication?.publicationId ?? null,
        format: input.format,
        docKey,
      });
      const slotKey = publicationTargetSlotKey({
        projectId: artifact.projectId,
        action: input.action,
        basePublicationId: basePublication?.publicationId ?? null,
        format: input.format,
        docKey,
      });
      const sameIntent = chainPublications.find(candidate =>
        (candidate.intentKey ?? productDocumentPublicationIntentKey({
          artifactId: candidate.artifactId,
          projectId: candidate.projectId,
          action: candidate.action,
          basePublicationId: candidate.basePublicationId,
          format: candidate.format,
          docKey: candidate.docKey,
        })) === intentKey
        && candidate.status !== 'rejected'
        && candidate.status !== 'superseded');
      if (sameIntent && sameIntent.status !== 'target_conflict') {
        const pendingEdit = getPendingEdit(db, sameIntent.pendingEditId);
        if (pendingEdit) {
          return { publication: sameIntent, pendingEdit, idempotent: true, replacesPublicationIds: [] };
        }
      }

      const ancestorIds = new Set<string>();
      let cursor = artifact.parentArtifactId ? productDocuments.getArtifact(artifact.parentArtifactId) : null;
      for (let depth = 0; cursor && depth < 1_000; depth++) {
        if (ancestorIds.has(cursor.artifactId)) throw new Error('Artifact chain contains a cycle.');
        ancestorIds.add(cursor.artifactId);
        cursor = cursor.parentArtifactId ? productDocuments.getArtifact(cursor.parentArtifactId) : null;
      }
      const atSlot = chainPublications.filter(candidate =>
        candidate.publicationId !== basePublication?.publicationId
        && publicationTargetSlotKey({
          projectId: candidate.projectId,
          action: candidate.action,
          basePublicationId: candidate.basePublicationId,
          format: candidate.format,
          docKey: candidate.docKey,
        }) === slotKey
        && candidate.status !== 'rejected'
        && candidate.status !== 'superseded');
      const supersedable = atSlot.filter(candidate =>
        (candidate.artifactId === artifact.artifactId || ancestorIds.has(candidate.artifactId))
        && (candidate.status === 'staged' || candidate.status === 'target_conflict'));
      const blocking = atSlot.find(candidate => !supersedable.some(entry => entry.publicationId === candidate.publicationId));
      if (blocking) {
        throw new Error(`Publication ${blocking.publicationId} is ${blocking.status} for this SharePoint target; it cannot be replaced automatically.`);
      }

      const publicationId = createId();
      const createdAt = now().toISOString();
      return db.transaction(() => {
        const replacementReason = `Superseded by publication ${publicationId} for newer/current artifact ${artifact.artifactId}.`;
        for (const prior of supersedable) {
          const priorEdit = getPendingEdit(db, prior.pendingEditId);
          if (priorEdit?.status === 'pending' || priorEdit?.status === 'conflicted') {
            decidePendingEdit(db, prior.pendingEditId, 'rejected', createdAt);
          }
          transition(prior.publicationId, 'superseded', {
            supersededAt: createdAt,
            supersessionReason: replacementReason,
            replacementPublicationId: publicationId,
            lastError: null,
          }, createdAt);
        }
        const actionLabel = input.action === 'update_existing'
          ? `update existing SharePoint version from publication ${basePublication!.publicationId}`
          : 'create new SharePoint copy';
        const pendingEdit = createPendingEdit(db, {
          docKey,
          serverRelativeUrl,
          ...(siteUrl ? { siteUrl } : {}),
          kind: 'botboy',
          operation: 'createDocument',
          createContent: artifact.content,
          projectId: artifact.projectId,
          allowExistingTarget: input.action === 'update_existing',
          originNote: `official artifact ${artifact.artifactId} · ${actionLabel}${input.purpose ? ` · ${input.purpose}` : ''}`.slice(0, 300),
        }, createdAt);
        insert.run(
          publicationId,
          artifact.artifactId,
          artifact.projectId,
          input.action,
          basePublication?.publicationId ?? null,
          intentKey,
          input.format,
          pendingEdit.id,
          siteUrl || null,
          serverRelativeUrl,
          docKey,
          createdAt,
          createdAt,
        );
        return {
          publication: get(publicationId)!,
          pendingEdit,
          idempotent: false,
          replacesPublicationIds: supersedable.map(publication => publication.publicationId),
        };
      })();
    },

    recordLegacyRepair(input, at = now().toISOString()) {
      const artifact = productDocuments.getArtifact(input.artifactId);
      if (!artifact) throw new Error(`Official product-document artifact '${input.artifactId}' was not found.`);
      if (!artifact.projectId || artifact.projectId !== input.projectId) {
        throw new Error('The repair project must exactly own the artifact chain.');
      }
      if (input.format !== 'md' && input.format !== 'docx') throw new Error('Repair format must be md or docx.');
      if (!input.serverRelativeUrl.toLowerCase().endsWith(`.${input.format}`)) {
        throw new Error(`The repair target must end in .${input.format}.`);
      }
      const mapped = mapSharePointWriteTarget(input.serverRelativeUrl, input.siteUrl);
      if (typeof mapped === 'string') throw new Error(mapped.replace(/^Error:\s*/i, ''));
      const resolvedDocKey = docKeyForPath(db, input.serverRelativeUrl, input.siteUrl);
      if (resolvedDocKey !== input.docKey) throw new Error('Repair docKey does not match the exact target path.');
      if (!/^[a-f0-9]{64}$/i.test(input.baseRemoteSha256)
        || !/^[a-f0-9]{64}$/i.test(input.exportSha256)) {
        throw new Error('Repair SHA-256 receipts are invalid.');
      }
      if (!input.remoteItemId.trim()) throw new Error('Repair requires the stable SharePoint item ID.');
      if (!Number.isInteger(input.exportBytes) || input.exportBytes < 0) throw new Error('Repair export byte count is invalid.');
      if (!input.repairNote.trim()) throw new Error('Repair note is required.');
      const existingComplete = listArtifact.all(input.artifactId) as PublicationRow[];
      if (existingComplete.some(row => row.status === 'complete' && row.doc_key === input.docKey)) {
        throw new Error('This exact artifact is already linked as complete at the repair target.');
      }
      const publicationId = createId();
      return db.transaction(() => {
        const pending = createPendingEdit(db, {
          docKey: input.docKey,
          serverRelativeUrl: input.serverRelativeUrl,
          ...(input.siteUrl ? { siteUrl: input.siteUrl } : {}),
          kind: 'botboy',
          operation: 'createDocument',
          createContent: artifact.content,
          projectId: artifact.projectId,
          allowExistingTarget: true,
          originNote: `owner-approved legacy publication repair · ${input.repairNote}`.slice(0, 300),
        }, at);
        decidePendingEdit(db, pending.id, 'approved', at);
        markEditSynced(db, pending.id, at);
        insertLegacyRepair.run(
          publicationId,
          artifact.artifactId,
          artifact.projectId,
          input.baseRemoteSha256.toLowerCase(),
          input.repairNote.slice(0, 1_000),
          input.format,
          pending.id,
          input.siteUrl?.trim() || null,
          input.serverRelativeUrl,
          input.docKey,
          input.webUrl?.slice(0, 1_000) || null,
          input.remoteItemId.slice(0, 300),
          input.exportSha256.toLowerCase(),
          input.exportSha256.toLowerCase(),
          input.exportBytes,
          input.exportFilename.slice(0, 300),
          at,
          at,
          at,
          at,
          at,
          at,
        );
        return { publication: get(publicationId)!, pendingEdit: getPendingEdit(db, pending.id)! };
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
    listByChain(artifactId) {
      return (listChainPublications.all(artifactId) as PublicationRow[]).map(rowToPublication);
    },
    hasForChain(artifactId) {
      return Boolean(hasChainPublication.get(artifactId));
    },
    recordDecision(pendingEditId, decision, at = now().toISOString(), snapshot) {
      const row = selectByPending.get(pendingEditId) as PublicationRow | undefined;
      const current = row ? rowToPublication(row) : null;
      if (!current) return null;
      const normalizedSnapshot = snapshot ? {
        sha256: String(snapshot.sha256 ?? '').trim().toLowerCase(),
        itemId: boundedOptional(snapshot.itemId, 300),
        etag: boundedOptional(snapshot.etag, 300),
        version: boundedOptional(snapshot.version, 300),
        modified: boundedOptional(snapshot.modified, 100),
        size: typeof snapshot.size === 'number' && Number.isSafeInteger(snapshot.size) && snapshot.size >= 0
          ? snapshot.size
          : null,
        observedAt: boundedOptional(snapshot.observedAt, 100),
      } : null;
      if (decision === 'approved' && current.action === 'update_existing') {
        if (!normalizedSnapshot
          || !/^[a-f0-9]{64}$/.test(normalizedSnapshot.sha256)
          || !normalizedSnapshot.itemId
          || !normalizedSnapshot.observedAt) {
          throw new Error('Update approval requires one coherent current-remote snapshot.');
        }
      }
      return transition(
        current.publicationId,
        decision,
        decision === 'approved'
          ? {
              approvedAt: at,
              lastError: null,
              ...(normalizedSnapshot ? {
                expectedRemoteSha256: normalizedSnapshot.sha256,
                expectedRemoteItemId: normalizedSnapshot.itemId,
                expectedRemoteEtag: normalizedSnapshot.etag,
                expectedRemoteVersion: normalizedSnapshot.version,
                expectedRemoteModified: normalizedSnapshot.modified,
                expectedRemoteSize: normalizedSnapshot.size,
                remoteObservedAt: normalizedSnapshot.observedAt,
              } : {}),
            }
          : { lastError: null },
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
    recordVerified(publicationId, receipt, at = now().toISOString()) {
      if (!/^[a-f0-9]{64}$/i.test(receipt.remoteSha256)) {
        throw new Error('Verified remote SHA-256 receipt is invalid.');
      }
      return transition(publicationId, 'verified', {
        verifiedAt: at,
        verifiedRemoteSha256: receipt.remoteSha256.toLowerCase(),
        remoteItemId: receipt.remoteItemId?.slice(0, 300) ?? get(publicationId)?.remoteItemId ?? null,
        webUrl: receipt.webUrl?.slice(0, 1_000) ?? get(publicationId)?.webUrl ?? null,
        lastError: null,
      }, at);
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
      if (!current.exportSha256 || current.verifiedRemoteSha256 !== current.exportSha256) {
        return transition(publicationId, 'identity_mismatch', {
          lastError: 'Verified remote SHA-256 did not match the canonical artifact export receipt.',
        }, at);
      }
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
