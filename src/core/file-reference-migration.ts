/**
 * One-time conversion of stored data and code file versions into file
 * references (owner decision 2026-10-04: "for teammates, delete as well;
 * keep it clean & standard").
 *
 * Stores built before the reference rules hold every captured version of a
 * local data or code file as a `document_capture` row with its full text.
 * This applies, on every store, the rules the owner's store was cleaned with
 * the same day:
 *
 * - The newest version of a file that still exists becomes its reference in
 *   place (same id, project history, and discard), built from the file's
 *   first 64 KB like a live capture (`file-references.ts`). It keeps the
 *   newest routed project the owner did not reject; otherwise it waits for
 *   the folder rule. Older versions are deleted.
 * - A file that already has a reference keeps it; its stored versions are
 *   deleted (their project fills an unassigned reference).
 * - A file that no longer exists loses every stored version.
 * - A credential-shaped path, a version withheld as sensitive, or a secret in
 *   the file's first 64 KB leaves the path untouched.
 * - Folder-ledger holds that no longer apply to data and code files (too
 *   large, waiting for review, paused) are dropped.
 *
 * Execution: the folder-import scheduler runs it after final-ready, before
 * any folder walk. Each path is one small transaction; deleting stored
 * versions also deletes their search rows, which costs time in proportion to
 * their text, so deletions run in byte-bounded chunks with a yield between
 * them. Replayed on the owner's pre-cleanup store (2,359 versions, 2.8 GB):
 * 23 s in 2,316 transactions, p99 0.1 s; one 24 MB stored version still held
 * the thread 1.7 s, which is the floor for a single row. Every step is
 * idempotent, so an aborted run resumes on the next pass.
 * A path whose versions wait for extraction or sit in a librarian wave is
 * deferred. The marker (a receipt with the counts) is set only after a pass
 * that leaves nothing behind.
 */

import { readdirSync, statSync, unlinkSync, type Stats } from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import type Database from 'better-sqlite3';
import { getSetting, setSetting } from './storage.js';
import { deleteWorkItemFts } from './work-items-fts.js';
import { recordRoutingDecision } from './pipeline-audit.js';
import { detectSecrets, sensitiveLocalPathReason } from './sensitive-files.js';
import { NOOP_MAIN_THREAD_WATCHDOG, type MainThreadWatchdog } from './main-thread-watchdog.js';
import {
  ROLE_SNIFF_BYTES,
  buildFileReference,
  isReferenceRole,
  localFileRoleForPath,
  readFileHead,
  readReferenceHead,
  referenceMetadataFields,
  requestFullAdoptionSweep,
  roleFromHead,
  type LocalFileRole,
} from './file-references.js';

export const FILE_REFERENCE_MIGRATION_KEY = 'file_references.migration.v1';

/**
 * Text bytes whose search rows one deletion transaction removes before
 * yielding. FTS5 tokenizes a stored body to delete it: on the owner's store a
 * 2.4 MB JSON version took about 0.6 s, so a chunk past 1 MB holds one row.
 */
const DEFAULT_CHUNK_BYTES = 1024 * 1024;
const DEFAULT_CHUNK_ROWS = 50;
const WATCHDOG_LABEL = 'file-reference-migration';
const CARRY_REASON = 'carried from the stored document version (file-reference migration)';

export interface FileReferenceMigrationResult {
  /** True when the marker is set: nothing is left to convert. */
  done: boolean;
  aborted?: boolean;
  /** Newest versions turned into references in place. */
  converted: number;
  /** Paths that already had a reference; their versions were deleted. */
  merged: number;
  /** Paths whose file no longer exists; all versions deleted. */
  missingFiles: number;
  deletedVersions: number;
  /** Paths left untouched as possible credentials. */
  leftSensitive: number;
  /** Paths waiting for extraction or a librarian wave; retried on a later pass. */
  deferred: number;
  filesRemoved: number;
  bytesRemoved: number;
  ledgerRowsDropped: number;
}

export interface FileReferenceMigration {
  isDone(): boolean;
  run(opts?: { signal?: AbortSignal }): Promise<FileReferenceMigrationResult>;
}

interface VersionRow {
  rowid: number;
  id: string;
  state: string;
  projectId: string | null;
  batchId: string | null;
  metadata: string | null;
  capturedAt: string;
  contentStorage: string | null;
  contentPath: string | null;
  bytes: number | null;
  originalPath: string | null;
}

interface ReferenceRow { id: string; projectId: string | null; state: string }

interface FirstStep {
  kind: 'converted' | 'merged' | 'missing' | 'sensitive' | 'deferred' | 'gone';
  /** The row older versions hand their links to (null: nothing survives). */
  keptId: string | null;
  /** Versions to delete in chunks, already tombstoned. */
  deleteQueue: Array<{ id: string; bytes: number }>;
  /** Content files of the kept row's old text, removed after commit. */
  files: string[];
}

function emptyResult(): FileReferenceMigrationResult {
  return {
    done: false, converted: 0, merged: 0, missingFiles: 0, deletedVersions: 0, leftSensitive: 0,
    deferred: 0, filesRemoved: 0, bytesRemoved: 0, ledgerRowsDropped: 0,
  };
}

function parseMetadata(raw: string | null): Record<string, unknown> {
  try { return raw ? JSON.parse(raw) as Record<string, unknown> : {}; } catch { return {}; }
}

/** A version the extractor or a librarian wave may still write to. */
function inFlight(row: VersionRow): boolean {
  return row.state === 'captured' || (row.state === 'extracted' && row.batchId != null);
}

function newestFirst(a: VersionRow, b: VersionRow): number {
  if (a.capturedAt !== b.capturedAt) return a.capturedAt < b.capturedAt ? 1 : -1;
  return b.rowid - a.rowid;
}

export function createFileReferenceMigration(deps: {
  db: Database.Database;
  /** Content store directory. Only files inside it are ever removed. */
  contentDir: string;
  watchdog?: MainThreadWatchdog;
  yieldToLoop?: () => Promise<void>;
  chunkBytes?: number;
  chunkRows?: number;
  now?: () => Date;
}): FileReferenceMigration {
  const { db } = deps;
  const contentRoot = path.resolve(deps.contentDir) + path.sep;
  const watchdog = deps.watchdog ?? NOOP_MAIN_THREAD_WATCHDOG;
  const yieldToLoop = deps.yieldToLoop ?? (() => new Promise<void>((resolve) => setImmediate(resolve)));
  const chunkBytes = Math.max(1, deps.chunkBytes ?? DEFAULT_CHUNK_BYTES);
  const chunkRows = Math.max(1, deps.chunkRows ?? DEFAULT_CHUNK_ROWS);
  const now = deps.now ?? (() => new Date());

  const candidatesStmt = db.prepare(`
    SELECT id, path FROM (
      SELECT id, COALESCE(file_path, CASE WHEN json_valid(metadata) THEN json_extract(metadata, '$.filePath') END) AS path
      FROM work_items
      WHERE source = 'filesystem' AND type = 'document_capture'
    ) WHERE path IS NOT NULL AND path <> ''
  `);
  const versionStmt = db.prepare(`
    SELECT rowid AS rowid, id, process_state AS state, project_id AS projectId, batch_id AS batchId, metadata,
           captured_at AS capturedAt, content_storage AS contentStorage, content_path AS contentPath,
           content_bytes AS bytes, original_path AS originalPath
    FROM work_items WHERE id = ? AND source = 'filesystem' AND type = 'document_capture'
  `);
  const referenceStmt = db.prepare(`
    SELECT id, project_id AS projectId, process_state AS state
    FROM work_items WHERE type = 'file_reference' AND file_path = ?
  `);
  const projectExists = db.prepare('SELECT 1 FROM projects WHERE id = ?');
  const rejectionsOf = db.prepare('SELECT project_id AS projectId FROM work_item_rejections WHERE work_item_id = ?');
  const discarded = db.prepare('SELECT 1 FROM work_item_discards WHERE work_item_id = ?');
  const folders = db.prepare('SELECT id, path FROM local_folders');
  const copyRejections = db.prepare(`
    INSERT OR IGNORE INTO work_item_rejections (work_item_id, project_id, rejected_at)
    SELECT ?, project_id, rejected_at FROM work_item_rejections WHERE work_item_id = ?
  `);
  // Older versions leave every lane at once: noise is terminal, so no wave,
  // gist, or Today query picks them up while they wait for deletion.
  const tombstone = db.prepare(`
    UPDATE work_items SET process_state = 'noise', batch_id = NULL
    WHERE id = ? AND source = 'filesystem' AND type = 'document_capture'
  `);
  const convertStmt = db.prepare(`
    UPDATE work_items SET type = 'file_reference', source_app = 'Local Files', file_path = ?, title = ?, summary = ?, url = ?,
      raw_text = ?, content_storage = 'inline', content_path = NULL, content_sha256 = ?, content_bytes = ?,
      parsed_text = ?, metadata = ?, process_state = ?, project_id = ?, batch_id = NULL,
      gist = NULL, gist_kind = NULL, gist_at = NULL, scope_alert = NULL, incomplete = 0,
      content_hash = NULL, original_path = NULL, extraction_kind = NULL, ocr_confidence = NULL
    WHERE id = ? AND source = 'filesystem' AND type = 'document_capture'
  `);
  const adoptStmt = db.prepare(`
    UPDATE work_items SET project_id = ?, process_state = 'routed', batch_id = NULL
    WHERE id = ? AND type = 'file_reference' AND process_state = 'orphaned' AND project_id IS NULL
  `);
  const ftsInsert = db.prepare('INSERT INTO work_items_fts (item_id, title, body) VALUES (?, ?, ?)');
  const unlink = {
    nodeLinks: db.prepare('DELETE FROM node_work_items WHERE work_item_id = ?'),
    todos: db.prepare('UPDATE agent_todos SET work_item_id = ? WHERE work_item_id = ?'),
    crossLinks: db.prepare('UPDATE project_cross_links SET evidence_item_id = ? WHERE evidence_item_id = ?'),
    ocr: db.prepare('DELETE FROM item_ocr_lines WHERE item_id = ?'),
    failures: db.prepare('DELETE FROM failures WHERE item_id = ?'),
    routing: db.prepare('DELETE FROM routing_decisions WHERE item_id = ?'),
    item: db.prepare("DELETE FROM work_items WHERE id = ? AND source = 'filesystem' AND type = 'document_capture'"),
  };

  function isDone(): boolean {
    return getSetting<unknown>(db, FILE_REFERENCE_MIGRATION_KEY) != null;
  }

  function roleFor(filePath: string): LocalFileRole {
    const byPath = localFileRoleForPath(filePath);
    if (byPath !== 'sniff') return byPath;
    return roleFromHead(filePath, readFileHead(filePath, ROLE_SNIFF_BYTES) ?? Buffer.alloc(0));
  }

  function insideContentDir(filePath: string): boolean {
    return path.resolve(filePath).startsWith(contentRoot);
  }

  /** Content files a row owns: its text blob, any aux blobs, a stored original. Only inside the store. */
  function storedFilesOf(row: VersionRow): string[] {
    const files: string[] = [];
    if (row.contentStorage === 'file' && row.contentPath) files.push(row.contentPath);
    if (row.originalPath) files.push(row.originalPath);
    const shard = path.join(contentRoot, row.id.slice(0, 2) || '00', row.id.slice(2, 4) || '00');
    try {
      for (const name of readdirSync(shard)) {
        if (name.startsWith(`${row.id}-`)) files.push(path.join(shard, name));
      }
    } catch { /* no shard directory */ }
    return [...new Set(files)].filter(insideContentDir);
  }

  function removeFiles(files: string[], result: FileReferenceMigrationResult): void {
    for (const file of files) {
      if (!insideContentDir(file)) continue;
      let size = 0;
      try { size = statSync(file).size; } catch { continue; }
      try {
        unlinkSync(file);
        result.filesRemoved++;
        result.bytesRemoved += size;
      } catch { /* left for a later cleanup */ }
    }
  }

  function folderRootFor(metadata: Record<string, unknown>, filePath: string, roots: Array<{ id: number; path: string }>): { id: number; path: string } | null {
    const byId = roots.find((folder) => folder.id === Number(metadata.localFolderId));
    if (byId) return byId;
    return roots
      .filter((folder) => filePath.startsWith(folder.path.endsWith(path.sep) ? folder.path : folder.path + path.sep))
      .sort((a, b) => b.path.length - a.path.length)[0] ?? null;
  }

  /** The newest routed version's project, when the project still exists and the owner did not reject it. */
  function carriedProject(versions: VersionRow[], rejected: Set<string>): string | null {
    for (const version of versions) {
      if (version.state !== 'routed' || !version.projectId) continue;
      if (rejected.has(version.projectId) || !projectExists.get(version.projectId)) continue;
      return version.projectId;
    }
    return null;
  }

  function rejectedProjects(ids: string[]): Set<string> {
    const rejected = new Set<string>();
    for (const id of ids) for (const row of rejectionsOf.all(id) as Array<{ projectId: string }>) rejected.add(row.projectId);
    return rejected;
  }

  function auditCarry(itemId: string, projectId: string): void {
    recordRoutingDecision(db, {
      runId: 'file-references',
      batchId: 'file-references:migration',
      itemId,
      modelDecision: 'not_called',
      appliedDecision: 'assign',
      appliedProjectId: projectId,
      validationReason: CARRY_REASON,
    });
  }

  /** Decide one path and apply everything but the deletions. Runs inside a transaction. */
  function firstStep(filePath: string, ids: string[], role: 'data' | 'code', roots: Array<{ id: number; path: string }>): FirstStep {
    const none: FirstStep = { kind: 'gone', keptId: null, deleteQueue: [], files: [] };
    const versions = ids
      .map((id) => versionStmt.get(id) as VersionRow | undefined)
      .filter((row): row is VersionRow => Boolean(row))
      .sort(newestFirst);
    if (versions.length === 0) return none;
    if (versions.some(inFlight)) return { ...none, kind: 'deferred' };

    let stat: Stats | null = null;
    try { const found = statSync(filePath); if (found.isFile()) stat = found; } catch { /* gone */ }
    if (sensitiveLocalPathReason(filePath, stat?.size ?? 0)
      || versions.some((version) => parseMetadata(version.metadata).sensitiveHold)) {
      return { ...none, kind: 'sensitive' };
    }

    const queue = (rows: VersionRow[], keptId: string | null) => rows.map((row) => {
      tombstone.run(row.id);
      if (keptId) copyRejections.run(keptId, row.id);
      return { id: row.id, bytes: Number(row.bytes) || 0 };
    });

    const existing = referenceStmt.get(filePath) as ReferenceRow | undefined;
    if (existing) {
      const rejected = rejectedProjects([existing.id, ...versions.map((version) => version.id)]);
      const deleteQueue = queue(versions, existing.id);
      if (existing.projectId == null && existing.state === 'orphaned' && !discarded.get(existing.id)) {
        const projectId = carriedProject(versions, rejected);
        if (projectId && adoptStmt.run(projectId, existing.id).changes > 0) auditCarry(existing.id, projectId);
      }
      return { kind: 'merged', keptId: existing.id, deleteQueue, files: [] };
    }

    if (!stat) return { kind: 'missing', keptId: null, deleteQueue: queue(versions, null), files: [] };

    const { head, complete } = readReferenceHead(filePath, stat.size);
    if (head && detectSecrets(head).length > 0) return { ...none, kind: 'sensitive' };

    const [kept, ...older] = versions;
    const keptMeta = parseMetadata(kept.metadata);
    const folder = folderRootFor(keptMeta, filePath, roots);
    const reference = buildFileReference({
      filePath, rootPath: folder?.path ?? null, role, head, complete, size: stat.size, mtimeMs: stat.mtimeMs,
    });
    const isDiscarded = Boolean(discarded.get(kept.id));
    const rejected = rejectedProjects(versions.map((version) => version.id));
    const projectId = isDiscarded ? null : carriedProject(versions, rejected);
    const { summary: _summary, ...fields } = referenceMetadataFields(
      { filePath, role, size: stat.size, mtimeMs: stat.mtimeMs }, reference,
    );
    const at = now().toISOString();
    const metadata = {
      ...(keptMeta.localFolderId != null ? { localFolderId: String(keptMeta.localFolderId) } : folder ? { localFolderId: String(folder.id) } : {}),
      ...(typeof keptMeta.localFolderName === 'string' ? { localFolderName: keptMeta.localFolderName } : {}),
      ...(typeof keptMeta.captureMode === 'string' ? { captureMode: keptMeta.captureMode } : {}),
      ...fields,
      observedAt: at,
      convertedFromDocument: { versions: versions.length, at },
    };
    const files = storedFilesOf(kept);
    const deleteQueue = queue(older, kept.id);
    const text = reference.text;
    const changes = convertStmt.run(
      filePath, path.basename(filePath), reference.summary, `file://${filePath}`,
      text, createHash('sha256').update(text, 'utf8').digest('hex'), Buffer.byteLength(text, 'utf8'),
      text, JSON.stringify(metadata), isDiscarded ? 'noise' : projectId ? 'routed' : 'orphaned', projectId,
      kept.id,
    ).changes;
    if (changes !== 1) throw new Error(`file reference migration: ${kept.id} changed during conversion`);
    unlink.nodeLinks.run(kept.id);
    unlink.ocr.run(kept.id);
    unlink.failures.run(kept.id);
    deleteWorkItemFts(db, kept.id);
    ftsInsert.run(kept.id, path.basename(filePath), text);
    if (projectId && projectId !== kept.projectId) auditCarry(kept.id, projectId);
    return { kind: 'converted', keptId: kept.id, deleteQueue, files };
  }

  /** Delete tombstoned versions. Runs inside a transaction; returns their content files. */
  function deleteVersions(ids: string[], keptId: string | null): { deleted: number; files: string[] } {
    let deleted = 0;
    const files: string[] = [];
    for (const id of ids) {
      const row = versionStmt.get(id) as VersionRow | undefined;
      if (!row) continue;
      files.push(...storedFilesOf(row));
      deleteWorkItemFts(db, id);
      unlink.nodeLinks.run(id);
      unlink.todos.run(keptId, id);
      unlink.crossLinks.run(keptId, id);
      unlink.ocr.run(id);
      unlink.failures.run(id);
      unlink.routing.run(id);
      deleted += unlink.item.run(id).changes;
    }
    return { deleted, files };
  }

  function dropObsoleteLedgerRows(): number {
    const rows = db.prepare(`
      SELECT folder_id AS folderId, path, outcome FROM local_folder_imports
      WHERE outcome IN ('too_large', 'needs_review', 'owner_paused')
    `).all() as Array<{ folderId: number; path: string; outcome: string }>;
    const drop = db.prepare('DELETE FROM local_folder_imports WHERE folder_id = ? AND path = ? AND outcome = ?');
    let dropped = 0;
    db.transaction(() => {
      for (const row of rows) {
        if (isReferenceRole(roleFor(row.path))) dropped += drop.run(row.folderId, row.path, row.outcome).changes;
      }
    })();
    return dropped;
  }

  /** References are never node items, OCR'd, or extraction failures. */
  function tidyReferences(): void {
    db.transaction(() => {
      db.prepare("DELETE FROM node_work_items WHERE work_item_id IN (SELECT id FROM work_items WHERE type = 'file_reference')").run();
      db.prepare("DELETE FROM item_ocr_lines WHERE item_id IN (SELECT id FROM work_items WHERE type = 'file_reference')").run();
      db.prepare("DELETE FROM failures WHERE item_id IN (SELECT id FROM work_items WHERE type = 'file_reference')").run();
    })();
  }

  return {
    isDone,

    async run(opts = {}) {
      const result = emptyResult();
      if (isDone()) return { ...result, done: true };
      const signal = opts.signal;

      const byPath = new Map<string, string[]>();
      for (const row of candidatesStmt.all() as Array<{ id: string; path: string }>) {
        if (!byPath.has(row.path)) byPath.set(row.path, []);
        byPath.get(row.path)!.push(row.id);
      }
      const roots = (folders.all() as Array<{ id: number; path: string }>).map((folder) => ({ id: folder.id, path: path.resolve(folder.path) }));

      for (const [filePath, ids] of byPath) {
        const role = roleFor(filePath);
        if (!isReferenceRole(role)) continue;
        if (signal?.aborted) return { ...result, aborted: true };

        const step = watchdog.measure(WATCHDOG_LABEL, () => db.transaction(() => firstStep(filePath, ids, role, roots))());
        removeFiles(step.files, result);
        if (step.kind === 'converted') result.converted++;
        else if (step.kind === 'merged') result.merged++;
        else if (step.kind === 'missing') result.missingFiles++;
        else if (step.kind === 'sensitive') result.leftSensitive++;
        else if (step.kind === 'deferred') result.deferred++;
        await yieldToLoop();

        let next = 0;
        while (next < step.deleteQueue.length) {
          if (signal?.aborted) return { ...result, aborted: true };
          const chunk: string[] = [];
          let bytes = 0;
          while (next < step.deleteQueue.length && chunk.length < chunkRows && (chunk.length === 0 || bytes < chunkBytes)) {
            const entry = step.deleteQueue[next++];
            chunk.push(entry.id);
            bytes += entry.bytes;
          }
          const removed = watchdog.measure(WATCHDOG_LABEL, () => db.transaction(() => deleteVersions(chunk, step.keptId))());
          result.deletedVersions += removed.deleted;
          removeFiles(removed.files, result);
          await yieldToLoop();
        }
      }

      result.ledgerRowsDropped = dropObsoleteLedgerRows();
      tidyReferences();
      // Bulk-added references are unassigned until the folder rule sees them;
      // the event watermark would never revisit them.
      if (result.converted > 0 || result.merged > 0) requestFullAdoptionSweep(db);

      console.log(
        `[file-references] stored data/code conversion ${result.deferred > 0 ? 'continues later' : 'done'}: `
        + `${result.converted} became references, ${result.merged} merged into existing ones, `
        + `${result.deletedVersions} stored versions deleted (${result.missingFiles} files gone), `
        + `${result.filesRemoved} content files removed (${(result.bytesRemoved / 1048576).toFixed(1)} MB), `
        + `${result.ledgerRowsDropped} folder holds dropped`
        + `${result.leftSensitive ? `, ${result.leftSensitive} possible credentials left as is` : ''}`
        + `${result.deferred ? `, ${result.deferred} waiting for extraction or routing` : ''}`,
      );
      if (result.deferred > 0) return result;
      const { done: _done, aborted: _aborted, ...counts } = result;
      setSetting(db, FILE_REFERENCE_MIGRATION_KEY, { doneAt: now().toISOString(), ...counts });
      return { ...result, done: true };
    },
  };
}
