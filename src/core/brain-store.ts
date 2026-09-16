/**
 * Brain Store — read/write/parse project "brain" Markdown documents and keep
 * the SQLite `projects` index in sync (lossless-capture-brain-pipeline spec,
 * Requirement 7).
 *
 * A brain is a human-editable Markdown file with YAML front-matter plus a fixed
 * set of sections. It holds the *interpreted* state of a project: summary,
 * status, actionable tasks, blockers, people, and an append-only activity log.
 *
 * Serialization is deterministic so `parse(serialize(b))` round-trips
 * (Correctness Property P10). The parser is intentionally simple (no external
 * YAML/markdown dependency) and tolerant of hand edits.
 */

import { createHash, randomUUID } from 'crypto';
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  renameSync,
} from 'fs';
import path from 'path';
import os from 'os';
import type Database from 'better-sqlite3';

// ── Types ────────────────────────────────────────────────────────────────

export type ProjectStatus = 'active' | 'paused' | 'done' | 'archived';
export type TaskState = 'todo' | 'doing' | 'blocked' | 'done';

export interface BrainTask {
  state: TaskState;
  text: string;
  /** ISO day (YYYY-MM-DD) of the evidence that established the task. Older
   * brains predate task dating; their tasks stay undated until re-evidenced. */
  date?: string;
}

export interface Brain {
  id: string;
  title: string;
  status: ProjectStatus;
  people: string[];
  updated: string; // ISO timestamp
  summary: string;
  statusLine: string;
  tasks: BrainTask[];
  blockers: string[];
  activityLog: string[]; // append-only, newest last
}

export interface ProjectRow {
  id: string;
  title: string;
  status: ProjectStatus;
  one_liner: string | null;
  brain_path: string;
  brain_sha256: string | null;
  created_at: string;
  updated_at: string;
  /** Immutable routing anchor: the title at creation. Null only before the
   * scope-integrity migration ran; treat the current title as the anchor then. */
  founding_scope?: string | null;
}

/** The stable anchor routing must validate against — founding scope when
 * recorded, otherwise the current title. Mutable summaries never qualify. */
export function projectScopeAnchor(project: Pick<ProjectRow, 'title' | 'founding_scope'>): string {
  const founding = project.founding_scope?.trim();
  return founding && founding.length > 0 ? founding : project.title;
}

export interface BrainWriteOptions {
  /** Durable revision classification for incident recovery/audit. */
  reason?: string;
  /** Compare-and-swap guard. `null` requires no current file. */
  expectedSha256?: string | null;
}

export class BrainWriteConflictError extends Error {
  constructor(
    public readonly projectId: string,
    public readonly expectedSha256: string | null,
    public readonly actualSha256: string | null,
  ) {
    super(`brain ${projectId} changed before publish (expected ${expectedSha256 ?? 'none'}, found ${actualSha256 ?? 'none'})`);
    this.name = 'BrainWriteConflictError';
  }
}

export interface BrainStore {
  brainPathFor(projectId: string): string;
  serialize(brain: Brain): string;
  parse(markdown: string): Brain;
  read(projectId: string): Brain | null;
  /** Write brain to disk (atomic), snapshotting the exact prior Markdown. */
  write(brain: Brain, oneLiner?: string, options?: BrainWriteOptions): void;
  /** True if the on-disk brain differs from the recorded brain_sha256 (R7.5). */
  hasManualEdit(projectId: string): boolean;
  listProjects(status?: ProjectStatus): ProjectRow[];
  getProject(projectId: string): ProjectRow | null;
  sha256(markdown: string): string;
}

export interface BrainStoreConfig {
  brainsDir?: string;
}

const DEFAULT_BRAINS_DIR = path.join(os.homedir(), '.personal-productivity-tracker', 'brains');

const TASK_STATES: TaskState[] = ['todo', 'doing', 'blocked', 'done'];

function sha256Hex(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

// ── Factory ────────────────────────────────────────────────────────────────

export function createBrainStore(db: Database.Database, config?: BrainStoreConfig): BrainStore {
  const brainsDir = config?.brainsDir ?? DEFAULT_BRAINS_DIR;

  const store: BrainStore = {
    sha256: sha256Hex,

    brainPathFor(projectId: string): string {
      return path.join(brainsDir, `${projectId}.md`);
    },

    serialize(brain: Brain): string {
      const fm = [
        '---',
        `id: ${brain.id}`,
        `title: ${brain.title}`,
        `status: ${brain.status}`,
        `people: [${brain.people.join(', ')}]`,
        `updated: ${brain.updated}`,
        '---',
      ].join('\n');

      const tasks = brain.tasks
        .map((t) => `- [${t.state === 'done' ? 'x' : ' '}] (${t.state})${t.date ? ` [${t.date}]` : ''} ${t.text}`)
        .join('\n');
      const blockers = brain.blockers.map((b) => `- ${b}`).join('\n');
      const people = brain.people.map((p) => `- ${p}`).join('\n');
      const log = brain.activityLog.map((l) => `- ${l}`).join('\n');

      return [
        fm,
        '',
        '## Summary',
        brain.summary,
        '',
        '## Status',
        brain.statusLine,
        '',
        '## Open Tasks',
        tasks,
        '',
        '## Blockers',
        blockers,
        '',
        '## People',
        people,
        '',
        '## Activity Log',
        log,
        '',
      ].join('\n');
    },

    parse(markdown: string): Brain {
      const lines = markdown.split('\n');

      // ── front-matter ──
      const fm: Record<string, string> = {};
      let i = 0;
      if (lines[0]?.trim() === '---') {
        i = 1;
        while (i < lines.length && lines[i].trim() !== '---') {
          const m = lines[i].match(/^([a-zA-Z_]+):\s*(.*)$/);
          if (m) fm[m[1]] = m[2].trim();
          i++;
        }
        i++; // skip closing ---
      }

      const parsePeople = (raw: string | undefined): string[] => {
        if (!raw) return [];
        const inner = raw.replace(/^\[/, '').replace(/\]$/, '').trim();
        if (!inner) return [];
        return inner.split(',').map((s) => s.trim()).filter(Boolean);
      };

      // ── sections ──
      const sections: Record<string, string[]> = {};
      let current = '';
      for (; i < lines.length; i++) {
        const line = lines[i];
        const h = line.match(/^##\s+(.+)$/);
        if (h) {
          current = h[1].trim();
          sections[current] = [];
        } else if (current) {
          sections[current].push(line);
        }
      }

      const sectionText = (name: string): string =>
        (sections[name] ?? []).join('\n').trim();

      const sectionBullets = (name: string): string[] =>
        (sections[name] ?? [])
          .map((l) => l.match(/^-\s+(.*)$/)?.[1])
          .filter((v): v is string => v != null && v.trim().length > 0)
          .map((v) => v.trim());

      // Tasks: "- [ ] (state) text", optionally dated: "- [ ] (state) [2026-08-20] text"
      const tasks: BrainTask[] = (sections['Open Tasks'] ?? [])
        .map((l) => {
          const m = l.match(/^-\s*\[[ xX]\]\s*\(([a-z]+)\)\s*(?:\[(\d{4}-\d{2}-\d{2})\]\s*)?(.*)$/);
          if (!m) return null;
          const state = (TASK_STATES.includes(m[1] as TaskState) ? m[1] : 'todo') as TaskState;
          const task: BrainTask = { state, text: m[3].trim() };
          if (m[2]) task.date = m[2];
          return task;
        })
        .filter((v): v is BrainTask => v != null);

      const status = (fm.status as ProjectStatus) || 'active';

      return {
        id: fm.id ?? '',
        title: fm.title ?? '',
        status,
        people: parsePeople(fm.people),
        updated: fm.updated ?? '',
        summary: sectionText('Summary'),
        statusLine: sectionText('Status'),
        tasks,
        blockers: sectionBullets('Blockers'),
        activityLog: sectionBullets('Activity Log'),
      };
    },

    read(projectId: string): Brain | null {
      const p = this.brainPathFor(projectId);
      if (!existsSync(p)) return null;
      return this.parse(readFileSync(p, 'utf8'));
    },

    write(brain: Brain, oneLiner?: string, options?: BrainWriteOptions): void {
      const p = this.brainPathFor(brain.id);
      mkdirSync(path.dirname(p), { recursive: true });
      const markdown = this.serialize(brain);
      const nextSha = sha256Hex(markdown);
      const priorMarkdown = existsSync(p) ? readFileSync(p, 'utf8') : null;
      const priorSha = priorMarkdown === null ? null : sha256Hex(priorMarkdown);

      if (options && Object.prototype.hasOwnProperty.call(options, 'expectedSha256')
        && priorSha !== options.expectedSha256) {
        throw new BrainWriteConflictError(brain.id, options.expectedSha256 ?? null, priorSha);
      }

      // Snapshot BEFORE replacement. If the process dies after this insert but
      // before rename, the extra revision merely duplicates the current brain;
      // if it dies after rename, the prior state is already durable.
      if (priorMarkdown !== null && priorSha !== nextSha) {
        db.prepare(`
          INSERT INTO brain_revisions (id, project_id, brain_sha256, markdown, reason)
          VALUES (?, ?, ?, ?, ?)
        `).run(
          randomUUID(),
          brain.id,
          priorSha,
          priorMarkdown,
          options?.reason?.trim() || 'brain_write',
        );
      }

      // Atomic file replacement.
      const tmp = path.join(path.dirname(p), `.${brain.id}.md.tmp-${process.pid}-${Date.now()}`);
      writeFileSync(tmp, markdown, 'utf8');
      renameSync(tmp, p);

      const now = new Date().toISOString();
      // founding_scope is written once at creation and deliberately left out
      // of the conflict-update set: later brain rewrites must not move the
      // routing anchor. COALESCE backfills legacy rows that predate the column.
      db.prepare(
        `INSERT INTO projects (id, title, status, one_liner, brain_path, brain_sha256, founding_scope, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           title = excluded.title,
           status = excluded.status,
           one_liner = excluded.one_liner,
           brain_path = excluded.brain_path,
           brain_sha256 = excluded.brain_sha256,
           founding_scope = COALESCE(NULLIF(trim(projects.founding_scope), ''), excluded.founding_scope),
           updated_at = excluded.updated_at`,
      ).run(
        brain.id,
        brain.title,
        brain.status,
        oneLiner ?? brain.summary.slice(0, 200),
        p,
        nextSha,
        brain.title,
        now,
        now,
      );
    },

    hasManualEdit(projectId: string): boolean {
      const row = this.getProject(projectId);
      if (!row) return false;
      const p = this.brainPathFor(projectId);
      if (!existsSync(p)) return false;
      const onDisk = sha256Hex(readFileSync(p, 'utf8'));
      return row.brain_sha256 != null && onDisk !== row.brain_sha256;
    },

    listProjects(status?: ProjectStatus): ProjectRow[] {
      if (status) {
        return db.prepare('SELECT * FROM projects WHERE status = ? ORDER BY updated_at DESC').all(status) as ProjectRow[];
      }
      return db.prepare('SELECT * FROM projects ORDER BY updated_at DESC').all() as ProjectRow[];
    },

    getProject(projectId: string): ProjectRow | null {
      return (db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId) as ProjectRow) ?? null;
    },
  };

  return store;
}

/** Build an empty brain scaffold for a new project. */
export function newBrain(id: string, title: string): Brain {
  return {
    id,
    title,
    status: 'active',
    people: [],
    updated: new Date().toISOString(),
    summary: '',
    statusLine: 'active',
    tasks: [],
    blockers: [],
    activityLog: [],
  };
}
