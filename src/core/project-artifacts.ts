import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export type ProjectArtifactAssignmentSource = 'explicit_context' | 'owner';

export interface ProjectArtifactRegistration {
  id: string;
  canonicalPath: string;
  relativePath: string;
  projectId: string | null;
  version: number;
  assignment: 'assigned' | 'retained' | 'unassigned' | 'conflict';
  assignmentRequired: boolean;
}

export interface ProjectArtifactAttemptView {
  attemptId: string;
  slotKey: string;
  slug: string;
  phase: string;
  url: string;
  manifestSha256: string;
  deployed: boolean;
  contentVerified: boolean;
  visibilityConverged: boolean;
  error: string | null;
  createdAt: string;
  publishedAt: string | null;
}

export interface ProjectArtifactView {
  id: string;
  projectId: string | null;
  version: number;
  assignmentSource: ProjectArtifactAssignmentSource | null;
  relativePath: string;
  fileName: string;
  local: { exists: boolean; url: string; bytes: number | null; modifiedAt: string | null; sha256: string | null };
  screenshot: { assetId: string; versionId: string; originalUrl: string; width: number; height: number; createdAt: string } | null;
  latestAttempt: ProjectArtifactAttemptView | null;
  latestSuccessful: ProjectArtifactAttemptView | null;
  attempts: ProjectArtifactAttemptView[];
  updatedAt: string;
}

export interface ProjectArtifactService {
  discoverExisting(): number;
  registerFile(filePath: string, projectIds?: string[], source?: ProjectArtifactAssignmentSource): ProjectArtifactRegistration | null;
  linkVisualByUrl(url: string, visualVersionId: string): boolean;
  listForProject(projectId: string): ProjectArtifactView[];
  listUnassigned(): ProjectArtifactView[];
  assign(artifactId: string, projectId: string | null, expectedVersion: number): ProjectArtifactView;
  countForProject(projectId: string): number;
}

interface ArtifactRow {
  id: string;
  canonical_path: string;
  relative_path: string;
  project_id: string | null;
  assignment_source: ProjectArtifactAssignmentSource | null;
  assigned_at: string | null;
  current_sha256: string | null;
  current_bytes: number | null;
  current_modified_at: string | null;
  latest_visual_asset_version_id: string | null;
  version: number;
  created_at: string;
  updated_at: string;
}

function sha256File(filePath: string): string {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function artifactId(canonicalPath: string): string {
  return `html_${createHash('sha256').update(canonicalPath).digest('hex').slice(0, 24)}`;
}

function encodeFileUrl(relativePath: string): string {
  return `/api/files/${relativePath.split(path.sep).map(encodeURIComponent).join('/')}`;
}

function attemptFromRow(row: any): ProjectArtifactAttemptView {
  return {
    attemptId: row.id,
    slotKey: `${row.app_name}:${row.stage}:${row.slug}`,
    slug: row.slug,
    phase: row.phase,
    url: row.url,
    manifestSha256: row.manifest_sha256,
    deployed: row.deployed === 1,
    contentVerified: row.content_verified === 1,
    visibilityConverged: row.visibility_converged === 1,
    error: row.error ?? null,
    createdAt: row.created_at,
    publishedAt: row.published_at ?? null,
  };
}

export function createProjectArtifactService(options: {
  db: Database.Database;
  filesRoot?: string;
  appOrigin?: string;
}): ProjectArtifactService {
  const db = options.db;
  const appOrigin = new URL(options.appOrigin ?? `http://localhost:${process.env.PPT_PORT || 7778}`).origin;
  const requestedRoot = options.filesRoot ?? path.join(os.homedir(), '.personal-productivity-tracker', 'files');
  fs.mkdirSync(requestedRoot, { recursive: true });
  const filesRoot = fs.realpathSync(requestedRoot);

  const rowByPath = db.prepare('SELECT * FROM project_artifacts WHERE canonical_path = ?');
  const rowById = db.prepare('SELECT * FROM project_artifacts WHERE id = ?');

  function containedHtml(filePath: string): { canonicalPath: string; relativePath: string } | null {
    const resolved = path.resolve(filePath);
    let canonicalPath = resolved;
    try { canonicalPath = fs.realpathSync(resolved); } catch { /* publication may outlive the local file */ }
    const relativePath = path.relative(filesRoot, canonicalPath);
    if (!relativePath || relativePath.startsWith('..') || path.isAbsolute(relativePath)) return null;
    if (!/\.html?$/i.test(relativePath)) return null;
    return { canonicalPath, relativePath };
  }

  function validProjects(projectIds: string[] = []): string[] {
    const unique = [...new Set(projectIds.map(value => String(value || '').trim()).filter(Boolean))];
    const select = db.prepare("SELECT id FROM projects WHERE id = ? AND status IN ('active','paused')");
    return unique.filter(id => Boolean(select.get(id)));
  }

  function localFacts(canonicalPath: string): { sha256: string | null; bytes: number | null; modifiedAt: string | null } {
    try {
      const stat = fs.statSync(canonicalPath);
      if (!stat.isFile()) return { sha256: null, bytes: null, modifiedAt: null };
      return { sha256: sha256File(canonicalPath), bytes: stat.size, modifiedAt: stat.mtime.toISOString() };
    } catch {
      return { sha256: null, bytes: null, modifiedAt: null };
    }
  }

  function registerFile(filePath: string, projectIds: string[] = [], source: ProjectArtifactAssignmentSource = 'explicit_context'): ProjectArtifactRegistration | null {
    const identity = containedHtml(filePath);
    if (!identity) return null;
    const projects = validProjects(projectIds);
    const requestedProject = projects.length === 1 ? projects[0] : null;
    const existing = rowByPath.get(identity.canonicalPath) as ArtifactRow | undefined;
    let regularFile = false;
    try { regularFile = fs.statSync(identity.canonicalPath).isFile(); } catch { regularFile = false; }
    if (!existing && !regularFile) {
      const publication = db.prepare('SELECT 1 FROM static_artifact_publications WHERE source_path = ? LIMIT 1').get(identity.canonicalPath);
      if (!publication) return null;
    }
    const facts = localFacts(identity.canonicalPath);
    const now = new Date().toISOString();
    if (!existing) {
      const id = artifactId(identity.canonicalPath);
      db.prepare(`
        INSERT INTO project_artifacts (
          id, canonical_path, relative_path, project_id, assignment_source, assigned_at,
          current_sha256, current_bytes, current_modified_at, version, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
      `).run(
        id, identity.canonicalPath, identity.relativePath, requestedProject,
        requestedProject ? source : null, requestedProject ? now : null,
        facts.sha256, facts.bytes, facts.modifiedAt, now, now,
      );
      return {
        id, canonicalPath: identity.canonicalPath, relativePath: identity.relativePath,
        projectId: requestedProject, version: 1,
        assignment: requestedProject ? 'assigned' : 'unassigned',
        assignmentRequired: !requestedProject,
      };
    }
    let assignment: ProjectArtifactRegistration['assignment'] = existing.project_id ? 'retained' : 'unassigned';
    let projectId = existing.project_id;
    let version = existing.version;
    if (!existing.project_id && requestedProject) {
      projectId = requestedProject;
      assignment = 'assigned';
      version += 1;
    } else if (existing.project_id && requestedProject && existing.project_id !== requestedProject) {
      assignment = 'conflict';
    }
    db.prepare(`
      UPDATE project_artifacts
      SET relative_path=?, project_id=?, assignment_source=?, assigned_at=?,
          current_sha256=?, current_bytes=?, current_modified_at=?, version=?, updated_at=?
      WHERE id=?
    `).run(
      identity.relativePath, projectId,
      assignment === 'assigned' ? source : existing.assignment_source,
      assignment === 'assigned' ? now : existing.assigned_at,
      facts.sha256, facts.bytes, facts.modifiedAt, version, now, existing.id,
    );
    return {
      id: existing.id, canonicalPath: identity.canonicalPath, relativePath: identity.relativePath,
      projectId, version, assignment,
      assignmentRequired: !projectId || assignment === 'conflict',
    };
  }

  function discoverExisting(): number {
    let count = 0;
    const walk = (directory: string, depth: number) => {
      if (depth > 8 || count >= 2_000) return;
      let entries: fs.Dirent[] = [];
      try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue;
        const full = path.join(directory, entry.name);
        if (entry.isDirectory()) walk(full, depth + 1);
        else if (entry.isFile() && /\.html?$/i.test(entry.name)) {
          if (registerFile(full)) count += 1;
        }
      }
    };
    walk(filesRoot, 0);
    const publicationPaths = db.prepare('SELECT DISTINCT source_path AS sourcePath FROM static_artifact_publications').all() as Array<{ sourcePath: string }>;
    for (const row of publicationPaths) if (registerFile(row.sourcePath)) count += 1;
    return count;
  }

  function projectView(row: ArtifactRow): ProjectArtifactView {
    const facts = localFacts(row.canonical_path);
    if (facts.sha256 !== row.current_sha256 || facts.bytes !== row.current_bytes || facts.modifiedAt !== row.current_modified_at) {
      db.prepare(`UPDATE project_artifacts SET current_sha256=?, current_bytes=?, current_modified_at=?, updated_at=datetime('now') WHERE id=?`)
        .run(facts.sha256, facts.bytes, facts.modifiedAt, row.id);
    }
    const attempts = (db.prepare(`
      SELECT * FROM static_artifact_publications WHERE source_path = ?
      ORDER BY datetime(created_at) DESC, rowid DESC
    `).all(row.canonical_path) as any[]).map(attemptFromRow);
    const latestSuccessful = attempts.find(attempt => attempt.phase === 'published' && attempt.contentVerified && attempt.visibilityConverged) ?? null;
    let screenshot: ProjectArtifactView['screenshot'] = null;
    if (row.latest_visual_asset_version_id) {
      const visual = db.prepare(`
        SELECT v.id AS versionId, v.asset_id AS assetId, v.width, v.height, v.created_at AS createdAt
        FROM visual_asset_versions v WHERE v.id = ?
      `).get(row.latest_visual_asset_version_id) as any;
      if (visual) screenshot = {
        assetId: visual.assetId,
        versionId: visual.versionId,
        originalUrl: `/api/visual-assets/${encodeURIComponent(visual.assetId)}/original?versionId=${encodeURIComponent(visual.versionId)}`,
        width: visual.width,
        height: visual.height,
        createdAt: visual.createdAt,
      };
    }
    const newest = [row.updated_at, facts.modifiedAt, attempts[0]?.createdAt, screenshot?.createdAt]
      .filter(Boolean).sort().at(-1) ?? row.updated_at;
    return {
      id: row.id,
      projectId: row.project_id,
      version: row.version,
      assignmentSource: row.assignment_source,
      relativePath: row.relative_path,
      fileName: path.basename(row.relative_path),
      local: {
        exists: Boolean(facts.sha256),
        url: encodeFileUrl(row.relative_path),
        bytes: facts.bytes,
        modifiedAt: facts.modifiedAt,
        sha256: facts.sha256,
      },
      screenshot,
      latestAttempt: attempts[0] ?? null,
      latestSuccessful,
      attempts,
      updatedAt: newest,
    };
  }

  function listRows(where: string, value?: string): ProjectArtifactView[] {
    const rows = (value === undefined
      ? db.prepare(`SELECT * FROM project_artifacts WHERE ${where} ORDER BY datetime(updated_at) DESC, rowid DESC`).all()
      : db.prepare(`SELECT * FROM project_artifacts WHERE ${where} ORDER BY datetime(updated_at) DESC, rowid DESC`).all(value)) as ArtifactRow[];
    return rows.map(projectView).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  function assign(id: string, projectId: string | null, expectedVersion: number): ProjectArtifactView {
    if (projectId && !validProjects([projectId]).length) throw new Error('The target project is missing, archived, or unavailable.');
    const now = new Date().toISOString();
    const result = db.prepare(`
      UPDATE project_artifacts
      SET project_id=?, assignment_source='owner', assigned_at=?, version=version+1, updated_at=?
      WHERE id=? AND version=?
    `).run(projectId, projectId ? now : null, now, id, expectedVersion);
    if (result.changes !== 1) throw new Error('The artifact assignment changed; refresh and try again.');
    return projectView(rowById.get(id) as ArtifactRow);
  }

  function linkVisualByUrl(url: string, visualVersionId: string): boolean {
    const candidates = new Set<string>();
    let localUrl = url;
    try {
      const parsed = new URL(url);
      if (parsed.origin === appOrigin) localUrl = parsed.pathname;
    } catch { /* relative URL */ }
    if (localUrl.startsWith('/api/files/')) {
      try {
        const relative = localUrl.slice('/api/files/'.length).split('/').map(decodeURIComponent).join(path.sep);
        const identity = containedHtml(path.join(filesRoot, relative));
        if (identity) candidates.add(identity.canonicalPath);
      } catch { /* malformed URL */ }
    }
    const publications = db.prepare('SELECT DISTINCT source_path AS sourcePath FROM static_artifact_publications WHERE url = ?').all(url) as Array<{ sourcePath: string }>;
    for (const publication of publications) candidates.add(publication.sourcePath);
    if (candidates.size !== 1) return false;
    const canonicalPath = [...candidates][0];
    const artifact = registerFile(canonicalPath);
    if (!artifact) return false;
    const visual = db.prepare('SELECT id FROM visual_asset_versions WHERE id = ?').get(visualVersionId);
    if (!visual) return false;
    db.prepare(`UPDATE project_artifacts SET latest_visual_asset_version_id=?, updated_at=datetime('now') WHERE id=?`)
      .run(visualVersionId, artifact.id);
    return true;
  }

  return {
    discoverExisting,
    registerFile,
    linkVisualByUrl,
    listForProject: projectId => listRows('project_id = ?', projectId),
    listUnassigned: () => listRows('project_id IS NULL'),
    assign,
    countForProject: projectId => Number((db.prepare('SELECT COUNT(*) AS count FROM project_artifacts WHERE project_id = ?').get(projectId) as { count: number }).count),
  };
}
