/**
 * The staging store of the Knowledge library's write path (knowledge-library.md K17): ONE table, `knowledge_changes`, for
 * every proposal and every direct apply, so one lifecycle drives the card, the History link, the "I've updated it"
 * integrity gate and (P3) the evidence for tuning proposals. A direct apply is a row born `applied`.
 *
 *   revising  → applied | staged           the coach loop (the chat model is fixing what the check found)
 *   staged    → applied | dismissed | stale | expired
 *   held                                   the guide check could not run; Retry check, or Dismiss
 *   stale                                  the base file or the rules changed since staging; Re-draft, or Dismiss
 *
 * Expiry is lazy (14 days, on read; no timer). A `revising` row with no activity for 10 minutes (`updated_at`, which every
 * write moves; never `created_at`, or a card reopened after an hour would be swept back at once) is swept to `staged` (the
 * turn ended mid-loop: Stop, abort or a crash lose nothing). At most 50 changes wait; the oldest expires. Applied rows drop their plan
 * and check payloads (the History entry keeps what happened) and only the newest 500, or 90 days, are kept.
 */
import type Database from 'better-sqlite3';
import { newId } from './knowledge-fs.js';
import type { CheckItem } from './knowledge-check.js';

export type ChangeStatus = 'revising' | 'staged' | 'held' | 'stale' | 'applied' | 'dismissed' | 'expired';
export type ChangeOrigin = 'owner_request' | 'botboy_proposal';
export type WriteMode = 'create' | 'append' | 'edit' | 'replace' | 'import' | 'move' | 'archive';
export type ProposalTrigger = 'verified_fact' | 'owner_correction' | 'new_column' | 'workaround' | 'other';

/** One file effect of a change, in root-relative POSIX paths. */
export interface PlannedFile {
  path: string;
  /** SHA-256 of the file at staging; null when it did not exist. Re-verified at apply. */
  before: string | null;
  /** The text to write; null removes the file. */
  after: string | null;
}

export interface ChangePlan {
  mode: WriteMode | 'create_set';
  set: string;
  file: string | null;
  /** All file effects, the content file(s) first and the refreshed guide(s) after. */
  files: PlannedFile[];
  /** An import's source, pinned at staging and re-verified at apply. */
  importSource?: { path: string; sha256: string };
  /** The sources of a created set's imported files, pinned the same way. */
  importSources?: Array<{ path: string; sha256: string }>;
  /** The whole-guide text of a created set, for the card. */
  summary: string;
  /** The guides whose rules the change was prepared under (root-relative path and rules digest); every one is re-verified at apply. */
  rulesGuides?: Array<{ path: string; digest: string }>;
}

export interface KnowledgeChange {
  id: string;
  setName: string;
  kind: 'write' | 'create_set';
  mode: string;
  file: string | null;
  plan: ChangePlan | null;
  baseSha256: string | null;
  rulesSha256: string;
  diffText: string;
  why: string;
  trigger: ProposalTrigger | null;
  origin: ChangeOrigin;
  /** Families of untrusted sources the turn touched ("email", "web page"), computed by the server, never model words. */
  sources: string[];
  round: number;
  attempt: number;
  candidateSha256: string;
  items: CheckItem[];
  /** The must_fix and should_fix items still open when the loop ended. */
  unresolved: CheckItem[];
  /** should_fix and note items that rode an applied change. */
  notes: CheckItem[];
  check: { coverage?: string; summary?: string; reason?: string; message?: string; nextAction?: string };
  status: ChangeStatus;
  statusReason: string | null;
  historyId: string | null;
  suspicious: boolean;
  overrode: string[];
  createdAt: string;
  decidedAt: string | null;
  expiresAt: string;
}

export const CHANGE_EXPIRY_MS = 14 * 24 * 60 * 60 * 1000;
export const REVISING_SWEEP_MS = 10 * 60 * 1000;
export const MAX_WAITING_CHANGES = 50;
export const KEEP_FINISHED_ROWS = 500;
export const KEEP_FINISHED_MS = 90 * 24 * 60 * 60 * 1000;
/** A change id as an argument or a path segment: the WHOLE string (an id with anything around it is not an id). */
export const CHANGE_ID_RE = /^kc_[a-f0-9]{12}$/;
/** The card marker in a message or reply (`[[knowledge:kc_…]]`); global, for scanning text only, never for validating an argument. */
export const CHANGE_MARKER_RE = /\[\[knowledge:(kc_[a-f0-9]{12})\]\]/g;
const WAITING: readonly ChangeStatus[] = ['staged', 'held', 'stale'];

export interface NewChange {
  setName: string;
  kind: 'write' | 'create_set';
  mode: string;
  file: string | null;
  plan: ChangePlan | null;
  baseSha256: string | null;
  rulesSha256: string;
  diffText: string;
  why: string;
  trigger: ProposalTrigger | null;
  origin: ChangeOrigin;
  sources: string[];
  candidateSha256: string;
  status: ChangeStatus;
  round?: number;
  attempt?: number;
  items?: CheckItem[];
  unresolved?: CheckItem[];
  notes?: CheckItem[];
  check?: KnowledgeChange['check'];
  statusReason?: string | null;
  historyId?: string | null;
  suspicious?: boolean;
  overrode?: string[];
}

export type ChangePatch = Partial<Omit<KnowledgeChange, 'id' | 'createdAt'>>;

export interface KnowledgeChangeStore {
  insert(input: NewChange): KnowledgeChange;
  get(id: string): KnowledgeChange | null;
  update(id: string, patch: ChangePatch): KnowledgeChange | null;
  /** Newest first. Sweeps and expires lazily first. */
  list(options?: { statuses?: readonly ChangeStatus[]; limit?: number }): KnowledgeChange[];
  /** Waiting changes by status, for the page badge. */
  counts(): { waiting: number; staged: number; held: number; stale: number };
  /** Move `revising` rows older than 10 minutes to `staged` and expire what is past its date. Returns what moved. */
  sweep(): { staged: number; expired: number };
  /** Move one `revising` change to `staged` (the turn ended mid-loop). */
  stageRevising(ids: Iterable<string>, reason: string): number;
}

const parseJson = <T>(value: unknown, fallback: T): T => {
  try { return value ? (JSON.parse(String(value)) as T) : fallback; } catch { return fallback; }
};

export function createKnowledgeChangeStore(db: Database.Database, options: { now?: () => number; onChange?: () => void } = {}): KnowledgeChangeStore {
  const now = options.now ?? (() => Date.now());
  // Told after every write that can change what a pending list shows, so the Settings page refetches on its existing version poll.
  const changed = (): void => { try { options.onChange?.(); } catch { /* a listener never fails a change */ } };
  db.exec(`
    CREATE TABLE IF NOT EXISTS knowledge_changes (
      id TEXT PRIMARY KEY CHECK(id GLOB 'kc_[a-f0-9]*' AND length(id) = 15),
      set_name TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('write','create_set')),
      mode TEXT NOT NULL,
      file TEXT,
      plan_json TEXT NOT NULL DEFAULT '{}',
      base_sha256 TEXT,
      rules_sha256 TEXT NOT NULL DEFAULT '',
      diff_text TEXT NOT NULL DEFAULT '',
      why TEXT NOT NULL DEFAULT '',
      trigger_kind TEXT,
      origin TEXT NOT NULL CHECK(origin IN ('owner_request','botboy_proposal')),
      sources_json TEXT NOT NULL DEFAULT '[]',
      round INTEGER NOT NULL DEFAULT 1,
      attempt INTEGER NOT NULL DEFAULT 1,
      candidate_sha256 TEXT NOT NULL DEFAULT '',
      items_json TEXT NOT NULL DEFAULT '[]',
      unresolved_json TEXT NOT NULL DEFAULT '[]',
      notes_json TEXT NOT NULL DEFAULT '[]',
      check_json TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL CHECK(status IN ('revising','staged','held','stale','applied','dismissed','expired')),
      status_reason TEXT,
      history_id TEXT,
      suspicious INTEGER NOT NULL DEFAULT 0,
      overrode_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      updated_at TEXT,
      decided_at TEXT,
      expires_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_knowledge_changes_status ON knowledge_changes(status, created_at);
  `);
  // A developer database may already hold the table from before `updated_at`; a null reads as `created_at`.
  if (!(db.prepare('PRAGMA table_info(knowledge_changes)').all() as Array<{ name: string }>).some((column) => column.name === 'updated_at')) {
    db.exec('ALTER TABLE knowledge_changes ADD COLUMN updated_at TEXT');
  }
  const iso = (ms: number) => new Date(ms).toISOString();

  function map(row: Record<string, unknown> | undefined): KnowledgeChange | null {
    if (!row) return null;
    const plan = parseJson<ChangePlan | Record<string, never>>(row.plan_json, {});
    return {
      id: String(row.id), setName: String(row.set_name), kind: row.kind as KnowledgeChange['kind'], mode: String(row.mode), file: (row.file as string | null) ?? null,
      plan: 'files' in plan ? (plan as ChangePlan) : null,
      baseSha256: (row.base_sha256 as string | null) ?? null, rulesSha256: String(row.rules_sha256 ?? ''),
      diffText: String(row.diff_text ?? ''), why: String(row.why ?? ''), trigger: (row.trigger_kind as ProposalTrigger | null) ?? null,
      origin: row.origin as ChangeOrigin, sources: parseJson<string[]>(row.sources_json, []),
      round: Number(row.round ?? 1), attempt: Number(row.attempt ?? 1), candidateSha256: String(row.candidate_sha256 ?? ''),
      items: parseJson<CheckItem[]>(row.items_json, []), unresolved: parseJson<CheckItem[]>(row.unresolved_json, []), notes: parseJson<CheckItem[]>(row.notes_json, []),
      check: parseJson<KnowledgeChange['check']>(row.check_json, {}),
      status: row.status as ChangeStatus, statusReason: (row.status_reason as string | null) ?? null, historyId: (row.history_id as string | null) ?? null,
      suspicious: Number(row.suspicious ?? 0) === 1, overrode: parseJson<string[]>(row.overrode_json, []),
      createdAt: String(row.created_at), decidedAt: (row.decided_at as string | null) ?? null, expiresAt: String(row.expires_at),
    };
  }

  const getRaw = (id: string) => db.prepare('SELECT * FROM knowledge_changes WHERE id = ?').get(id) as Record<string, unknown> | undefined;

  function sweep(): { staged: number; expired: number } {
    const stamp = iso(now());
    const cutoff = iso(now() - REVISING_SWEEP_MS);
    const staged = db.prepare(`UPDATE knowledge_changes SET status = 'staged', updated_at = ?, status_reason = 'The turn ended before the fixes were resubmitted.' WHERE status = 'revising' AND COALESCE(updated_at, created_at) < ?`).run(stamp, cutoff).changes;
    const expired = db.prepare(`UPDATE knowledge_changes SET status = 'expired', status_reason = 'Not decided within 14 days.', decided_at = ?, plan_json = '{}' WHERE status IN ('staged','held','stale','revising') AND expires_at < ?`).run(stamp, stamp).changes;
    // Waiting changes past the cap: the oldest expire.
    const waiting = db.prepare(`SELECT id FROM knowledge_changes WHERE status IN ('staged','held','stale') ORDER BY created_at DESC, rowid DESC`).all() as Array<{ id: string }>;
    let capped = 0;
    for (const row of waiting.slice(MAX_WAITING_CHANGES)) {
      db.prepare(`UPDATE knowledge_changes SET status = 'expired', status_reason = 'More than 50 changes were waiting; the oldest expired.', decided_at = ?, plan_json = '{}' WHERE id = ?`).run(stamp, row.id);
      capped += 1;
    }
    // Finished rows: the newest 500 or the last 90 days.
    const oldCutoff = iso(now() - KEEP_FINISHED_MS);
    db.prepare(`DELETE FROM knowledge_changes WHERE status IN ('applied','dismissed','expired') AND COALESCE(decided_at, created_at) < ?`).run(oldCutoff);
    const finished = db.prepare(`SELECT id FROM knowledge_changes WHERE status IN ('applied','dismissed','expired') ORDER BY COALESCE(decided_at, created_at) DESC, rowid DESC`).all() as Array<{ id: string }>;
    for (const row of finished.slice(KEEP_FINISHED_ROWS)) db.prepare('DELETE FROM knowledge_changes WHERE id = ?').run(row.id);
    if (staged + expired + capped > 0) changed();
    return { staged, expired: expired + capped };
  }

  function insert(input: NewChange): KnowledgeChange {
    const id = newId('kc');
    const created = now();
    db.prepare(`INSERT INTO knowledge_changes (id, set_name, kind, mode, file, plan_json, base_sha256, rules_sha256, diff_text, why, trigger_kind, origin, sources_json,
      round, attempt, candidate_sha256, items_json, unresolved_json, notes_json, check_json, status, status_reason, history_id, suspicious, overrode_json, created_at, updated_at, decided_at, expires_at)
      VALUES (@id, @set_name, @kind, @mode, @file, @plan_json, @base_sha256, @rules_sha256, @diff_text, @why, @trigger_kind, @origin, @sources_json,
      @round, @attempt, @candidate_sha256, @items_json, @unresolved_json, @notes_json, @check_json, @status, @status_reason, @history_id, @suspicious, @overrode_json, @created_at, @updated_at, @decided_at, @expires_at)`).run({
      id, set_name: input.setName, kind: input.kind, mode: input.mode, file: input.file,
      plan_json: input.status === 'applied' ? '{}' : JSON.stringify(input.plan ?? {}),
      base_sha256: input.baseSha256, rules_sha256: input.rulesSha256, diff_text: input.diffText.slice(0, 200_000), why: input.why.slice(0, 600),
      trigger_kind: input.trigger, origin: input.origin, sources_json: JSON.stringify(input.sources.slice(0, 8)),
      round: input.round ?? 1, attempt: input.attempt ?? 1, candidate_sha256: input.candidateSha256,
      items_json: JSON.stringify(input.items ?? []), unresolved_json: JSON.stringify(input.unresolved ?? []), notes_json: JSON.stringify(input.notes ?? []),
      check_json: input.status === 'applied' ? JSON.stringify({ coverage: input.check?.coverage }) : JSON.stringify(input.check ?? {}),
      status: input.status, status_reason: input.statusReason ?? null, history_id: input.historyId ?? null,
      suspicious: input.suspicious ? 1 : 0, overrode_json: JSON.stringify(input.overrode ?? []),
      created_at: iso(created), updated_at: iso(created), decided_at: input.status === 'applied' ? iso(created) : null, expires_at: iso(created + CHANGE_EXPIRY_MS),
    });
    changed();
    return map(getRaw(id)) as KnowledgeChange;
  }

  function update(id: string, patch: ChangePatch): KnowledgeChange | null {
    const current = map(getRaw(id));
    if (!current) return null;
    const next = { ...current, ...patch };
    const applied = next.status === 'applied';
    db.prepare(`UPDATE knowledge_changes SET set_name=@set_name, mode=@mode, file=@file, plan_json=@plan_json, base_sha256=@base_sha256, rules_sha256=@rules_sha256, diff_text=@diff_text,
      why=@why, trigger_kind=@trigger_kind, origin=@origin, sources_json=@sources_json, round=@round, attempt=@attempt, candidate_sha256=@candidate_sha256, items_json=@items_json,
      unresolved_json=@unresolved_json, notes_json=@notes_json, check_json=@check_json, status=@status, status_reason=@status_reason, history_id=@history_id, suspicious=@suspicious,
      overrode_json=@overrode_json, updated_at=@updated_at, decided_at=@decided_at WHERE id=@id`).run({
      id, set_name: next.setName, mode: next.mode, file: next.file,
      // An applied or finished change drops its plan and check payloads; the History entry keeps what happened.
      plan_json: applied || next.status === 'dismissed' || next.status === 'expired' ? '{}' : JSON.stringify(next.plan ?? {}),
      base_sha256: next.baseSha256, rules_sha256: next.rulesSha256, diff_text: next.diffText.slice(0, 200_000), why: next.why, trigger_kind: next.trigger, origin: next.origin,
      sources_json: JSON.stringify(next.sources.slice(0, 8)), round: next.round, attempt: next.attempt, candidate_sha256: next.candidateSha256,
      items_json: JSON.stringify(applied ? [] : next.items), unresolved_json: JSON.stringify(applied ? [] : next.unresolved), notes_json: JSON.stringify(next.notes),
      check_json: applied ? JSON.stringify({ coverage: next.check.coverage }) : JSON.stringify(next.check),
      status: next.status, status_reason: next.statusReason, history_id: next.historyId, suspicious: next.suspicious ? 1 : 0, overrode_json: JSON.stringify(next.overrode),
      updated_at: iso(now()),
      decided_at: ['applied', 'dismissed', 'expired'].includes(next.status) ? (next.decidedAt ?? iso(now())) : next.decidedAt,
    });
    changed();
    return map(getRaw(id));
  }

  return {
    insert,
    get(id) {
      if (!CHANGE_ID_RE.test(String(id ?? ''))) return null;
      sweep();
      return map(getRaw(id));
    },
    update,
    list(listOptions = {}) {
      sweep();
      const limit = Math.max(1, Math.min(200, listOptions.limit ?? 50));
      const statuses = listOptions.statuses ?? WAITING;
      const rows = db.prepare(`SELECT * FROM knowledge_changes WHERE status IN (${statuses.map(() => '?').join(',')}) ORDER BY created_at DESC, rowid DESC LIMIT ?`).all(...statuses, limit) as Array<Record<string, unknown>>;
      return rows.map((row) => map(row) as KnowledgeChange);
    },
    counts() {
      sweep();
      const rows = db.prepare(`SELECT status, COUNT(*) AS n FROM knowledge_changes WHERE status IN ('staged','held','stale') GROUP BY status`).all() as Array<{ status: ChangeStatus; n: number }>;
      const by = Object.fromEntries(rows.map((row) => [row.status, row.n])) as Record<string, number>;
      return { waiting: (by.staged ?? 0) + (by.held ?? 0) + (by.stale ?? 0), staged: by.staged ?? 0, held: by.held ?? 0, stale: by.stale ?? 0 };
    },
    sweep,
    stageRevising(ids, reason) {
      let moved = 0;
      for (const id of ids) {
        moved += db.prepare(`UPDATE knowledge_changes SET status = 'staged', status_reason = ?, updated_at = ? WHERE id = ? AND status = 'revising'`).run(reason.slice(0, 300), iso(now()), id).changes;
      }
      if (moved > 0) changed();
      return moved;
    },
  };
}
