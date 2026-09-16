import type Database from 'better-sqlite3';
import type {
  ProductDocumentArtifact,
  ProductDocumentListOptions,
  ProductDocumentProjectAssignment,
  ProductDocumentStore,
  ProductDocumentSummary,
} from './types.js';

export const PRODUCT_DOCUMENT_ARTIFACT_SCHEMA_VERSION = 'product-document-artifact.v1';
export const MAX_PRODUCT_DOCUMENT_ARTIFACT_BYTES = 1024 * 1024;
export const MAX_PRODUCT_DOCUMENT_CONTENT_BYTES = 512 * 1024;

interface ArtifactRow {
  artifact_id: string;
  schema_version: string;
  artifact_json: string;
  project_id: string | null;
}

interface SummaryRow {
  artifact_id: string;
  project_id: string | null;
  state: ProductDocumentSummary['state'];
  profile_id: string;
  profile_version: string;
  title: string;
  model: string | null;
  checker_version: string;
  content_chars: number;
  validation_status: ProductDocumentSummary['validationStatus'];
  created_at: string;
  parent_artifact_id: string | null;
  revision_origin: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function serializeArtifact(artifact: ProductDocumentArtifact): string {
  const contentBytes = Buffer.byteLength(artifact.content, 'utf8');
  if (contentBytes > MAX_PRODUCT_DOCUMENT_CONTENT_BYTES) {
    throw new RangeError('Product-document content exceeds the 512 KiB persistence limit.');
  }

  const serialized = JSON.stringify({
    ...artifact,
    schemaVersion: PRODUCT_DOCUMENT_ARTIFACT_SCHEMA_VERSION,
  });
  if (Buffer.byteLength(serialized, 'utf8') > MAX_PRODUCT_DOCUMENT_ARTIFACT_BYTES) {
    throw new RangeError('Product-document artifact exceeds the 1 MiB persistence limit.');
  }
  return serialized;
}

/** The relational column is authoritative so a chain relink is atomic and old
 * artifact JSON remains migration-safe. New/relinked rows also keep JSON in
 * sync for portable artifact completeness. */
function deserializeArtifact(row: ArtifactRow): ProductDocumentArtifact {
  if (row.schema_version !== PRODUCT_DOCUMENT_ARTIFACT_SCHEMA_VERSION) {
    throw new Error('Unsupported persisted product-document artifact schema version.');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(row.artifact_json);
  } catch {
    throw new Error('Persisted product-document artifact JSON is invalid.');
  }
  if (!isRecord(parsed)
    || parsed.schemaVersion !== PRODUCT_DOCUMENT_ARTIFACT_SCHEMA_VERSION
    || parsed.artifactId !== row.artifact_id) {
    throw new Error('Persisted product-document artifact does not match its storage metadata.');
  }

  const { schemaVersion: _schemaVersion, projectId: _jsonProjectId, ...artifact } = parsed;
  return {
    ...artifact,
    ...(row.project_id === null ? {} : { projectId: row.project_id }),
    persisted: true,
  } as unknown as ProductDocumentArtifact;
}

function summaryFromRow(row: SummaryRow): ProductDocumentSummary {
  return {
    artifactId: row.artifact_id,
    ...(row.project_id === null ? {} : { projectId: row.project_id }),
    state: row.state,
    profileId: row.profile_id,
    profileVersion: row.profile_version,
    title: row.title,
    ...(row.model === null ? {} : { model: row.model }),
    checkerVersion: row.checker_version,
    contentChars: row.content_chars,
    validationStatus: row.validation_status,
    createdAt: row.created_at,
    ...(row.parent_artifact_id === null ? {} : { parentArtifactId: row.parent_artifact_id }),
    ...(row.revision_origin === 'generated'
      || row.revision_origin === 'owner_edit'
      || row.revision_origin === 'chat_authored'
      ? { revisionOrigin: row.revision_origin }
      : {}),
  };
}

function validateListOptions(options: ProductDocumentListOptions | undefined): void {
  if (!options) return;
  if (options.projectId !== undefined && (!options.projectId.trim() || options.projectId.length > 200)) {
    throw new RangeError('projectId must be a non-empty string of at most 200 characters.');
  }
  if (options.projectId !== undefined && options.unassigned === true) {
    throw new RangeError('projectId and unassigned cannot both be selected.');
  }
}

export function createProductDocumentStore(db: Database.Database): ProductDocumentStore {
  db.exec(`
    CREATE TABLE IF NOT EXISTS product_document_artifacts (
      artifact_id TEXT PRIMARY KEY,
      schema_version TEXT NOT NULL CHECK(schema_version = 'product-document-artifact.v1'),
      project_id TEXT,
      state TEXT NOT NULL CHECK(state IN ('blocked_for_context','blocked_validation','draft_review','ready_for_review')),
      profile_id TEXT NOT NULL,
      profile_version TEXT NOT NULL,
      title TEXT NOT NULL,
      model TEXT,
      checker_version TEXT NOT NULL,
      content_chars INTEGER NOT NULL CHECK(content_chars >= 0),
      validation_status TEXT NOT NULL CHECK(validation_status IN ('pass','pass_with_advisories','blocked','not_checked')),
      created_at TEXT NOT NULL,
      artifact_json TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_product_document_artifacts_created
      ON product_document_artifacts(created_at DESC, artifact_id DESC);
  `);
  // Additive migrations. Existing rows remain explicitly Unassigned; there is
  // no reliable deterministic project key in legacy artifacts.
  const existingColumns = new Set(
    (db.prepare('PRAGMA table_info(product_document_artifacts)').all() as Array<{ name: string }>)
      .map((column) => column.name),
  );
  if (!existingColumns.has('parent_artifact_id')) {
    db.exec('ALTER TABLE product_document_artifacts ADD COLUMN parent_artifact_id TEXT');
  }
  if (!existingColumns.has('revision_origin')) {
    db.exec('ALTER TABLE product_document_artifacts ADD COLUMN revision_origin TEXT');
  }
  if (!existingColumns.has('project_id')) {
    db.exec('ALTER TABLE product_document_artifacts ADD COLUMN project_id TEXT');
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_product_document_artifacts_project_created
      ON product_document_artifacts(project_id, created_at DESC, artifact_id DESC);
  `);

  const insertArtifact = db.prepare(`
    INSERT INTO product_document_artifacts
      (artifact_id, schema_version, project_id, state, profile_id, profile_version, title,
       model, checker_version, content_chars, validation_status, created_at, artifact_json,
       parent_artifact_id, revision_origin)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const summaryColumns = `artifact_id, project_id, state, profile_id, profile_version, title, model,
      checker_version, content_chars, validation_status, created_at,
      parent_artifact_id, revision_origin`;
  const listArtifacts = db.prepare(`
    SELECT ${summaryColumns}
    FROM product_document_artifacts
    ORDER BY created_at DESC, artifact_id DESC
    LIMIT ?
  `);
  const listProjectArtifacts = db.prepare(`
    SELECT ${summaryColumns}
    FROM product_document_artifacts
    WHERE project_id = ?
    ORDER BY created_at DESC, artifact_id DESC
    LIMIT ?
  `);
  const listUnassignedArtifacts = db.prepare(`
    SELECT ${summaryColumns}
    FROM product_document_artifacts
    WHERE project_id IS NULL
    ORDER BY created_at DESC, artifact_id DESC
    LIMIT ?
  `);
  const getArtifact = db.prepare(`
    SELECT artifact_id, schema_version, artifact_json, project_id
    FROM product_document_artifacts
    WHERE artifact_id = ?
  `);
  const getParentId = db.prepare(`
    SELECT parent_artifact_id FROM product_document_artifacts WHERE artifact_id = ?
  `);
  const getChildren = db.prepare(`
    SELECT artifact_id FROM product_document_artifacts WHERE parent_artifact_id = ?
    ORDER BY created_at, artifact_id
  `);
  const updateArtifactProject = db.prepare(`
    UPDATE product_document_artifacts
    SET project_id = ?, artifact_json = ?
    WHERE artifact_id = ?
  `);
  const relinkChildren = db.prepare(`
    UPDATE product_document_artifacts SET parent_artifact_id = ? WHERE parent_artifact_id = ?
  `);
  const deleteArtifact = db.prepare(`
    DELETE FROM product_document_artifacts WHERE artifact_id = ?
  `);

  // Deletion re-links children to the removed row's parent inside one
  // transaction so version chains never dangle on a missing artifact.
  const removeTransaction = db.transaction((artifactId: string): boolean => {
    const row = getParentId.get(artifactId) as { parent_artifact_id: string | null } | undefined;
    if (!row) return false;
    relinkChildren.run(row.parent_artifact_id, artifactId);
    deleteArtifact.run(artifactId);
    return true;
  });

  /** Traverse both directions because a selected version may sit anywhere in
   * the chain. Corrupt cycles terminate through `visited`; a hard bound keeps
   * malformed databases from turning one owner action into unbounded work. */
  const assignProjectTransaction = db.transaction((
    artifactId: string,
    projectId: string | undefined,
  ): ProductDocumentProjectAssignment => {
    if (!getArtifact.get(artifactId)) throw new Error('Product-document artifact not found.');
    const queue = [artifactId];
    const visited = new Set<string>();
    while (queue.length > 0) {
      const current = queue.shift()!;
      if (visited.has(current)) continue;
      if (visited.size >= 10_000) throw new Error('Product-document version chain exceeds the safe relink bound.');
      const row = getArtifact.get(current) as ArtifactRow | undefined;
      if (!row) continue;
      visited.add(current);
      const parent = getParentId.get(current) as { parent_artifact_id: string | null } | undefined;
      if (parent?.parent_artifact_id && !visited.has(parent.parent_artifact_id)) queue.push(parent.parent_artifact_id);
      const children = getChildren.all(current) as Array<{ artifact_id: string }>;
      for (const child of children) if (!visited.has(child.artifact_id)) queue.push(child.artifact_id);
    }

    const artifactIds = [...visited].sort();
    for (const id of artifactIds) {
      const row = getArtifact.get(id) as ArtifactRow;
      const artifact = deserializeArtifact(row);
      const updated = { ...artifact } as ProductDocumentArtifact;
      if (projectId === undefined) delete updated.projectId;
      else updated.projectId = projectId;
      updateArtifactProject.run(projectId ?? null, serializeArtifact(updated), id);
    }
    return {
      artifactIds,
      updated: artifactIds.length,
      ...(projectId === undefined ? {} : { projectId }),
    };
  });

  return {
    save(artifact) {
      const serialized = serializeArtifact(artifact);
      insertArtifact.run(
        artifact.artifactId,
        PRODUCT_DOCUMENT_ARTIFACT_SCHEMA_VERSION,
        artifact.projectId ?? null,
        artifact.state,
        artifact.profileId,
        artifact.profileVersion,
        artifact.title,
        artifact.model ?? null,
        artifact.checkerVersion,
        artifact.content.length,
        artifact.validation.status,
        artifact.createdAt,
        serialized,
        artifact.parentArtifactId ?? null,
        artifact.revisionOrigin ?? null,
      );
    },

    list(limit, options) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
        throw new RangeError('Product-document list limit must be an integer from 1 through 100.');
      }
      validateListOptions(options);
      const rows = options?.projectId !== undefined
        ? listProjectArtifacts.all(options.projectId, limit)
        : options?.unassigned === true
          ? listUnassignedArtifacts.all(limit)
          : listArtifacts.all(limit);
      return (rows as SummaryRow[]).map(summaryFromRow);
    },

    get(artifactId) {
      const row = getArtifact.get(artifactId) as ArtifactRow | undefined;
      return row ? deserializeArtifact(row) : null;
    },

    assignProject(artifactId, projectId) {
      return assignProjectTransaction(artifactId, projectId);
    },

    remove(artifactId) {
      return removeTransaction(artifactId);
    },
  };
}
