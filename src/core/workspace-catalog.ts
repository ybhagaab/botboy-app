import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { newBrain, type BrainStore, type ProjectStatus } from './brain-store.js';
import { syncNodesFromProjects, type ProjectionResult } from './node-projection.js';

export type WorkspaceActor = 'agent' | 'ui' | 'system';
export type AreaStatus = 'active' | 'archived';
export type AreaProjectAction = 'archive' | 'unassign' | 'move';

export interface WorkspaceCommandContext {
  actor: WorkspaceActor;
  commandId?: string;
}

export interface AreaRecord {
  id: string;
  title: string;
  description: string;
  status: AreaStatus;
  ownerManaged: boolean;
  version: number;
  archivedAt?: string;
  createdAt: string;
  updatedAt: string;
  projectCount: number;
}

export interface ProjectRecord {
  id: string;
  title: string;
  status: ProjectStatus;
  oneLiner: string;
  areaId?: string;
  placementLocked: boolean;
  version: number;
  archivedAt?: string;
  brainPath: string;
  itemCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceCatalogService {
  listAreas(includeArchived?: boolean): AreaRecord[];
  getArea(id: string): AreaRecord | null;
  createArea(input: { title: unknown; description?: unknown }, context: WorkspaceCommandContext): AreaRecord;
  updateArea(id: string, input: { title?: unknown; description?: unknown; expectedVersion?: unknown }, context: WorkspaceCommandContext): AreaRecord;
  archiveArea(id: string, input: AreaTransitionInput, context: WorkspaceCommandContext): AreaRecord;
  restoreArea(id: string, input: { expectedVersion?: unknown }, context: WorkspaceCommandContext): AreaRecord;
  deleteArea(id: string, input: AreaTransitionInput & { confirmTitle?: unknown }, context: WorkspaceCommandContext): { id: string; deleted: true; projection: ProjectionResult };
  listProjects(includeArchived?: boolean): ProjectRecord[];
  getProject(id: string): ProjectRecord | null;
  createProject(input: CreateProjectInput, context: WorkspaceCommandContext): ProjectRecord;
  updateProject(id: string, input: UpdateProjectInput, context: WorkspaceCommandContext): ProjectRecord;
  moveProject(id: string, input: { areaId: unknown; expectedVersion?: unknown }, context: WorkspaceCommandContext): ProjectRecord;
  archiveProject(id: string, input: { expectedVersion?: unknown }, context: WorkspaceCommandContext): ProjectRecord;
  restoreProject(id: string, input: { expectedVersion?: unknown }, context: WorkspaceCommandContext): ProjectRecord;
  deleteProject(id: string, input: { confirmTitle?: unknown; detachEvidence?: unknown; expectedVersion?: unknown }, context: WorkspaceCommandContext): { id: string; deleted: true; detachedEvidence: number; brainPreservedAt: string; projection: ProjectionResult };
}

interface AreaTransitionInput {
  projectAction?: unknown;
  targetAreaId?: unknown;
  expectedVersion?: unknown;
}

interface CreateProjectInput {
  title: unknown;
  areaId?: unknown;
  oneLiner?: unknown;
  summary?: unknown;
  statusLine?: unknown;
  status?: unknown;
}

interface UpdateProjectInput {
  title?: unknown;
  areaId?: unknown;
  oneLiner?: unknown;
  summary?: unknown;
  statusLine?: unknown;
  status?: unknown;
  placementLocked?: unknown;
  expectedVersion?: unknown;
}

const PROJECT_STATUSES = new Set<ProjectStatus>(['active', 'paused', 'done', 'archived']);

function cleanText(value: unknown, label: string, max: number, required = false): string {
  if (value == null) {
    if (required) throw new Error(`${label} is required`);
    return '';
  }
  if (typeof value !== 'string') throw new Error(`${label} must be a string`);
  const text = value.trim();
  if (required && !text) throw new Error(`${label} is required`);
  if (text.length > max) throw new Error(`${label} must be at most ${max} characters`);
  if (/\p{C}/u.test(text.replace(/\n|\r|\t/g, ''))) throw new Error(`${label} contains unsupported control characters`);
  return text;
}

function cleanTitle(value: unknown, label = 'title'): string {
  const title = cleanText(value, label, 200, true);
  if (/[\r\n]/.test(title)) throw new Error(`${label} must be one line`);
  if (title.includes(': ')) throw new Error(`${label} cannot contain YAML-style ": " because project brains use front matter`);
  return title;
}

function expectedVersion(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error('expectedVersion must be a positive integer');
  return parsed;
}

function projectStatus(value: unknown, fallback: ProjectStatus): ProjectStatus {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !PROJECT_STATUSES.has(value as ProjectStatus)) {
    throw new Error('status must be active, paused, done, or archived');
  }
  return value as ProjectStatus;
}

function json(value: unknown): string | null {
  return value === undefined ? null : JSON.stringify(value);
}

export function createWorkspaceCatalogService(options: {
  db: Database.Database;
  brainStore: BrainStore;
}): WorkspaceCatalogService {
  const { db, brainStore } = options;

  function areaRow(id: string): any | undefined {
    return db.prepare(`
      SELECT a.*,
        (SELECT COUNT(*) FROM projects p WHERE p.area_id = a.id) AS project_count
      FROM areas a WHERE a.id = ?
    `).get(id) as any;
  }

  function projectRow(id: string): any | undefined {
    return db.prepare(`
      SELECT p.*,
        (SELECT COUNT(*) FROM work_items w WHERE w.project_id = p.id) AS item_count
      FROM projects p WHERE p.id = ?
    `).get(id) as any;
  }

  function mapArea(row: any): AreaRecord {
    return {
      id: row.id,
      title: row.title,
      description: row.description || '',
      status: row.status === 'archived' ? 'archived' : 'active',
      ownerManaged: row.owner_managed === 1,
      version: Number(row.version || 1),
      archivedAt: row.archived_at || undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      projectCount: Number(row.project_count || 0),
    };
  }

  function mapProject(row: any): ProjectRecord {
    return {
      id: row.id,
      title: row.title,
      status: row.status,
      oneLiner: row.one_liner || '',
      areaId: row.area_id || undefined,
      placementLocked: row.placement_locked === 1,
      version: Number(row.version || 1),
      archivedAt: row.archived_at || undefined,
      brainPath: row.brain_path,
      itemCount: Number(row.item_count || 0),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  function assertVersion(row: any, supplied: unknown): void {
    const wanted = expectedVersion(supplied);
    const current = Number(row.version || 1);
    if (wanted !== undefined && wanted !== current) {
      throw new Error(`Version conflict: expected ${wanted}, current version is ${current}`);
    }
  }

  function assertUniqueTitle(table: 'areas' | 'projects', title: string, exceptId?: string): void {
    const row = db.prepare(`
      SELECT id FROM ${table}
      WHERE lower(trim(title)) = lower(trim(?)) AND (? IS NULL OR id <> ?)
      LIMIT 1
    `).get(title, exceptId ?? null, exceptId ?? null) as { id: string } | undefined;
    if (row) throw new Error(`${table === 'areas' ? 'Area' : 'Project'} title already exists (${row.id})`);
  }

  function event(
    entityType: 'area' | 'project',
    entityId: string,
    action: string,
    context: WorkspaceCommandContext,
    before: unknown,
    after: unknown,
  ): void {
    const actor = context.actor || 'agent';
    db.prepare(`
      INSERT INTO workspace_entity_events
        (id, entity_type, entity_id, action, actor, command_id, before_json, after_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      `event_${randomUUID().replace(/-/g, '').slice(0, 16)}`,
      entityType,
      entityId,
      action,
      actor,
      context.commandId || null,
      json(before),
      json(after),
    );
  }

  function project(): ProjectionResult {
    return syncNodesFromProjects(db);
  }

  function requireArea(id: unknown, options: { active?: boolean } = {}): any {
    const value = cleanText(id, 'areaId', 128, true);
    const row = areaRow(value);
    if (!row) throw new Error(`Area ${value} not found`);
    if (options.active && row.status === 'archived') throw new Error(`Area ${value} is archived`);
    return row;
  }

  function requireProject(id: unknown): any {
    const value = cleanText(id, 'projectId', 128, true);
    const row = projectRow(value);
    if (!row) throw new Error(`Project ${value} not found`);
    return row;
  }

  function ensureBrainWritable(id: string): void {
    if (brainStore.hasManualEdit(id)) {
      throw new Error(`Project ${id} brain has manual edits. Reconcile them before changing canonical project fields.`);
    }
  }

  function changeAreaProjects(
    areaId: string,
    rawAction: unknown,
    rawTargetAreaId: unknown,
    context: WorkspaceCommandContext,
  ): void {
    const projects = db.prepare('SELECT id FROM projects WHERE area_id = ? ORDER BY id').all(areaId) as { id: string }[];
    if (!projects.length) return;
    const action = typeof rawAction === 'string' ? rawAction as AreaProjectAction : undefined;
    if (!action || !['archive', 'unassign', 'move'].includes(action)) {
      throw new Error(`Area contains ${projects.length} project(s). Specify projectAction: archive, unassign, or move.`);
    }
    let targetAreaId: string | null = null;
    if (action === 'move') {
      const target = requireArea(rawTargetAreaId, { active: true });
      if (target.id === areaId) throw new Error('targetAreaId must be different from the source area');
      targetAreaId = target.id;
    }
    for (const { id } of projects) {
      const beforeRow = requireProject(id);
      const before = mapProject(beforeRow);
      if (action === 'archive') {
        ensureBrainWritable(id);
        const brain = brainStore.read(id) ?? newBrain(id, beforeRow.title);
        brainStore.write({
          ...brain,
          status: 'archived',
          updated: new Date().toISOString(),
          activityLog: [...brain.activityLog, `${new Date().toISOString().slice(0, 10)} — Archived with area ${areaId}.`],
        }, beforeRow.one_liner || undefined);
        db.prepare(`
          UPDATE projects SET archived_at = COALESCE(archived_at, datetime('now')),
            placement_locked = 1, version = version + 1 WHERE id = ?
        `).run(id);
      } else {
        db.prepare(`
          UPDATE projects SET area_id = ?, placement_locked = 1,
            version = version + 1, updated_at = datetime('now') WHERE id = ?
        `).run(targetAreaId, id);
      }
      event('project', id, `area_${action}`, context, before, mapProject(requireProject(id)));
    }
  }

  function listAreas(includeArchived = false): AreaRecord[] {
    const where = includeArchived ? '' : "WHERE COALESCE(a.status, 'active') != 'archived'";
    return (db.prepare(`
      SELECT a.*,
        (SELECT COUNT(*) FROM projects p WHERE p.area_id = a.id) AS project_count
      FROM areas a ${where}
      ORDER BY datetime(a.updated_at) DESC, a.title
    `).all() as any[]).map(mapArea);
  }

  function getArea(id: string): AreaRecord | null {
    const row = areaRow(id);
    return row ? mapArea(row) : null;
  }

  function createArea(input: { title: unknown; description?: unknown }, context: WorkspaceCommandContext): AreaRecord {
    const title = cleanTitle(input.title);
    const description = cleanText(input.description, 'description', 4000);
    assertUniqueTitle('areas', title);
    const id = `area_${randomUUID().replace(/-/g, '').slice(0, 8)}`;
    db.transaction(() => {
      db.prepare(`
        INSERT INTO areas
          (id, title, description, status, owner_managed, version, created_at, updated_at)
        VALUES (?, ?, ?, 'active', 1, 1, datetime('now'), datetime('now'))
      `).run(id, title, description || null);
      event('area', id, 'create', context, null, mapArea(areaRow(id)));
    })();
    project();
    return mapArea(areaRow(id));
  }

  function updateArea(
    id: string,
    input: { title?: unknown; description?: unknown; expectedVersion?: unknown },
    context: WorkspaceCommandContext,
  ): AreaRecord {
    const row = requireArea(id);
    assertVersion(row, input.expectedVersion);
    const title = input.title === undefined ? row.title : cleanTitle(input.title);
    const description = input.description === undefined ? row.description || '' : cleanText(input.description, 'description', 4000);
    if (title === row.title && description === (row.description || '') && row.owner_managed === 1) {
      throw new Error('No area changes were provided');
    }
    assertUniqueTitle('areas', title, id);
    const before = mapArea(row);
    db.transaction(() => {
      db.prepare(`
        UPDATE areas SET title = ?, description = ?, owner_managed = 1,
          version = version + 1, updated_at = datetime('now') WHERE id = ?
      `).run(title, description || null, id);
      event('area', id, 'update', context, before, mapArea(areaRow(id)));
    })();
    project();
    return mapArea(areaRow(id));
  }

  function archiveArea(id: string, input: AreaTransitionInput, context: WorkspaceCommandContext): AreaRecord {
    const row = requireArea(id);
    assertVersion(row, input.expectedVersion);
    if (row.status === 'archived') return mapArea(row);
    const before = mapArea(row);
    db.transaction(() => {
      changeAreaProjects(id, input.projectAction, input.targetAreaId, context);
      db.prepare(`
        UPDATE areas SET status = 'archived', archived_at = datetime('now'),
          owner_managed = 1, version = version + 1, updated_at = datetime('now') WHERE id = ?
      `).run(id);
      event('area', id, 'archive', context, before, mapArea(areaRow(id)));
    })();
    project();
    return mapArea(areaRow(id));
  }

  function restoreArea(id: string, input: { expectedVersion?: unknown }, context: WorkspaceCommandContext): AreaRecord {
    const row = requireArea(id);
    assertVersion(row, input.expectedVersion);
    if (row.status !== 'archived') return mapArea(row);
    const before = mapArea(row);
    db.transaction(() => {
      db.prepare(`
        UPDATE areas SET status = 'active', archived_at = NULL, owner_managed = 1,
          version = version + 1, updated_at = datetime('now') WHERE id = ?
      `).run(id);
      event('area', id, 'restore', context, before, mapArea(areaRow(id)));
    })();
    project();
    return mapArea(areaRow(id));
  }

  function deleteArea(
    id: string,
    input: AreaTransitionInput & { confirmTitle?: unknown },
    context: WorkspaceCommandContext,
  ): { id: string; deleted: true; projection: ProjectionResult } {
    const row = requireArea(id);
    assertVersion(row, input.expectedVersion);
    const confirmation = cleanText(input.confirmTitle, 'confirmTitle', 200, true);
    if (confirmation !== row.title) throw new Error('confirmTitle must exactly match the current area title');
    const before = mapArea(row);
    db.transaction(() => {
      changeAreaProjects(id, input.projectAction, input.targetAreaId, context);
      // projectAction=archive intentionally preserves membership while an area
      // is merely archived. A physical area delete must not leave dangling
      // project.area_id values, so detach any archived members before removal.
      db.prepare('UPDATE projects SET area_id = NULL WHERE area_id = ?').run(id);
      db.prepare("DELETE FROM page_layouts WHERE scope_type = 'area' AND scope_id = ?").run(id);
      const deleted = db.prepare('DELETE FROM areas WHERE id = ?').run(id);
      if (deleted.changes !== 1) throw new Error(`Area ${id} changed before deletion`);
      event('area', id, 'delete', context, before, null);
    })();
    return { id, deleted: true, projection: project() };
  }

  function listProjects(includeArchived = false): ProjectRecord[] {
    const where = includeArchived ? '' : "WHERE p.status != 'archived'";
    return (db.prepare(`
      SELECT p.*,
        (SELECT COUNT(*) FROM work_items w WHERE w.project_id = p.id) AS item_count
      FROM projects p ${where}
      ORDER BY datetime(p.updated_at) DESC, p.title
    `).all() as any[]).map(mapProject);
  }

  function getProject(id: string): ProjectRecord | null {
    const row = projectRow(id);
    return row ? mapProject(row) : null;
  }

  function createProject(input: CreateProjectInput, context: WorkspaceCommandContext): ProjectRecord {
    const title = cleanTitle(input.title);
    const area = input.areaId == null || input.areaId === '' ? null : requireArea(input.areaId, { active: true });
    const oneLiner = cleanText(input.oneLiner, 'oneLiner', 500);
    const summary = cleanText(input.summary, 'summary', 20_000);
    const statusLine = cleanText(input.statusLine, 'statusLine', 1000);
    const status = projectStatus(input.status, 'active');
    assertUniqueTitle('projects', title);
    const id = `proj_${randomUUID().replace(/-/g, '').slice(0, 8)}`;
    const brain = newBrain(id, title);
    brain.status = status;
    brain.summary = summary || oneLiner;
    brain.statusLine = statusLine || (status === 'active' ? 'Active' : status.charAt(0).toUpperCase() + status.slice(1));
    brain.activityLog = [`${new Date().toISOString().slice(0, 10)} — Created by ${context.actor}.`];
    db.transaction(() => {
      brainStore.write(brain, oneLiner || undefined);
      db.prepare(`
        UPDATE projects SET area_id = ?, placement_locked = 1,
          archived_at = CASE WHEN status = 'archived' THEN datetime('now') ELSE NULL END,
          version = 1 WHERE id = ?
      `).run(area?.id || null, id);
      event('project', id, 'create', context, null, mapProject(projectRow(id)));
    })();
    project();
    return mapProject(projectRow(id));
  }

  function updateProject(id: string, input: UpdateProjectInput, context: WorkspaceCommandContext): ProjectRecord {
    const row = requireProject(id);
    assertVersion(row, input.expectedVersion);
    ensureBrainWritable(id);
    const hasArea = Object.prototype.hasOwnProperty.call(input, 'areaId');
    const area = hasArea && input.areaId !== null && input.areaId !== ''
      ? requireArea(input.areaId, { active: true })
      : null;
    const nextAreaId = hasArea ? area?.id || null : row.area_id || null;
    const title = input.title === undefined ? row.title : cleanTitle(input.title);
    const oneLiner = input.oneLiner === undefined ? row.one_liner || '' : cleanText(input.oneLiner, 'oneLiner', 500);
    const status = projectStatus(input.status, row.status);
    const brain = brainStore.read(id) ?? newBrain(id, row.title);
    const summary = input.summary === undefined ? brain.summary : cleanText(input.summary, 'summary', 20_000);
    const statusLine = input.statusLine === undefined ? brain.statusLine : cleanText(input.statusLine, 'statusLine', 1000);
    if (title !== row.title) assertUniqueTitle('projects', title, id);
    const placementLocked = input.placementLocked === undefined
      ? (hasArea ? true : row.placement_locked === 1)
      : input.placementLocked === true;
    const before = mapProject(row);
    const changed = title !== row.title
      || oneLiner !== (row.one_liner || '')
      || status !== row.status
      || summary !== brain.summary
      || statusLine !== brain.statusLine
      || nextAreaId !== (row.area_id || null)
      || placementLocked !== (row.placement_locked === 1);
    if (!changed) throw new Error('No project changes were provided');
    const activity = `${new Date().toISOString().slice(0, 10)} — Project updated by ${context.actor}.`;
    db.transaction(() => {
      brainStore.write({
        ...brain,
        title,
        status,
        summary,
        statusLine,
        updated: new Date().toISOString(),
        activityLog: [...brain.activityLog, activity],
      }, oneLiner || undefined);
      db.prepare(`
        UPDATE projects SET area_id = ?, placement_locked = ?,
          archived_at = CASE WHEN status = 'archived' THEN COALESCE(archived_at, datetime('now')) ELSE NULL END,
          version = version + 1 WHERE id = ?
      `).run(nextAreaId, placementLocked ? 1 : 0, id);
      event('project', id, 'update', context, before, mapProject(projectRow(id)));
    })();
    project();
    return mapProject(projectRow(id));
  }

  function moveProject(
    id: string,
    input: { areaId: unknown; expectedVersion?: unknown },
    context: WorkspaceCommandContext,
  ): ProjectRecord {
    return updateProject(id, {
      areaId: input.areaId,
      placementLocked: true,
      expectedVersion: input.expectedVersion,
    }, context);
  }

  function archiveProject(id: string, input: { expectedVersion?: unknown }, context: WorkspaceCommandContext): ProjectRecord {
    const current = requireProject(id);
    if (current.status === 'archived') return mapProject(current);
    return updateProject(id, { status: 'archived', expectedVersion: input.expectedVersion }, context);
  }

  function restoreProject(id: string, input: { expectedVersion?: unknown }, context: WorkspaceCommandContext): ProjectRecord {
    const current = requireProject(id);
    if (current.status !== 'archived') return mapProject(current);
    return updateProject(id, { status: 'active', expectedVersion: input.expectedVersion }, context);
  }

  function deleteProject(
    id: string,
    input: { confirmTitle?: unknown; detachEvidence?: unknown; expectedVersion?: unknown },
    context: WorkspaceCommandContext,
  ): { id: string; deleted: true; detachedEvidence: number; brainPreservedAt: string; projection: ProjectionResult } {
    const row = requireProject(id);
    assertVersion(row, input.expectedVersion);
    const confirmation = cleanText(input.confirmTitle, 'confirmTitle', 200, true);
    if (confirmation !== row.title) throw new Error('confirmTitle must exactly match the current project title');
    const itemCount = Number(row.item_count || 0);
    if (itemCount > 0 && input.detachEvidence !== true) {
      throw new Error(`Project has ${itemCount} evidence item(s). Set detachEvidence=true to return them to the orphan pool.`);
    }
    const before = mapProject(row);
    const brainPath = row.brain_path;
    let detachedEvidence = 0;
    db.transaction(() => {
      if (itemCount > 0) {
        detachedEvidence = db.prepare(`
          UPDATE work_items SET project_id = NULL,
            process_state = CASE WHEN process_state = 'noise' THEN 'noise' ELSE 'orphaned' END,
            batch_id = NULL WHERE project_id = ?
        `).run(id).changes;
      }
      db.prepare("DELETE FROM page_layouts WHERE scope_type = 'project' AND scope_id = ?").run(id);
      db.prepare('DELETE FROM analytics_dashboard_projects WHERE project_id = ?').run(id);
      try { db.prepare('DELETE FROM project_cross_links WHERE project_id = ?').run(id); } catch { /* optional migration */ }
      const deleted = db.prepare('DELETE FROM projects WHERE id = ?').run(id);
      if (deleted.changes !== 1) throw new Error(`Project ${id} changed before deletion`);
      event('project', id, 'delete', context, before, { detachedEvidence, brainPreservedAt: brainPath });
    })();
    return {
      id,
      deleted: true,
      detachedEvidence,
      brainPreservedAt: brainPath,
      projection: project(),
    };
  }

  return {
    listAreas,
    getArea,
    createArea,
    updateArea,
    archiveArea,
    restoreArea,
    deleteArea,
    listProjects,
    getProject,
    createProject,
    updateProject,
    moveProject,
    archiveProject,
    restoreProject,
    deleteProject,
  };
}
