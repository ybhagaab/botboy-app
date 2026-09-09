import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { Brain, BrainStore, ProjectRow, TaskState } from './brain-store.js';
import { getSetting, setSetting } from './storage.js';
import { createChannelTierResolver } from './engagement.js';
import { createOwnerMatcher, type OwnerMatcher } from './owner-identity.js';
import { SUBSTANTIVE_EVIDENCE_SQL_PREDICATE, describeEvidence, derivedGist, excerptGist, gistSourceText, type GistKind } from './evidence-gist.js';

/** Evidence lines rendered per changed-project card; the rest is "+N more". */
const CHANGE_LINES_PER_PROJECT = 3;

const SETTINGS_KEY = 'today.attention.v1';
const CURSOR_KIND = 'work_item_project_event_rowid' as const;
const DEFAULT_CHANGE_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Attention / waiting are ranked PROJECT rows (owner ruling 2026-09-09:
 * one project = one slot). The focus-board rail includes EVERY eligible
 * project and the selected detail includes EVERY current commitment. */
const CHANGE_LIMIT = 8;
const RECENT_LIMIT = 6;
const MAX_SNOOZE_MS = 366 * 24 * 60 * 60 * 1000;

type TodayItemKind = 'task' | 'blocker' | 'project' | 'change';
export type TodayItemAction = 'pin' | 'unpin' | 'snooze' | 'dismiss' | 'restore';
export type TodayProjectSection = 'attention' | 'waiting';
export type TodayProjectAction = Extract<TodayItemAction, 'snooze' | 'dismiss'>;

interface TodayChangeSnapshot {
  kind: 'change';
  projectId: string;
  projectTitle: string;
  title: string;
  summary: string;
  reason: string;
  source: string;
  type: string;
  capturedAt: string;
  version: number;
  count: number;
}

export interface TodayItemPreference {
  pinned?: boolean;
  snoozedUntil?: string;
  dismissedAt?: string;
  suppressedThroughRowId?: number;
  snapshot?: TodayChangeSnapshot;
  snapshotPresentedSince?: string;
  updatedAt: string;
}

interface TodayPreferences {
  version: 1;
  cursorKind: typeof CURSOR_KIND;
  lastVisitedAt?: string;
  lastVisitedRowId?: number;
  items: Record<string, TodayItemPreference>;
}

export interface TodayAttentionItem {
  id: string;
  kind: Exclude<TodayItemKind, 'change'>;
  projectId: string;
  projectTitle: string;
  title: string;
  reason: string;
  state?: TaskState | 'blocked';
  staleDays?: number;
  updatedAt: string;
  freshEvidenceCount: number;
  freshEvidenceAt?: string;
  freshEvidenceVersion?: number;
  pinned: boolean;
  snoozedUntil?: string;
  dismissedAt?: string;
  score: number;
}

/**
 * A ranked project focus entry with every current task / blocker nested under
 * it. `hiddenCount` remains in the response for compatibility and is always 0;
 * the bounded list-detail board, not truncation, owns density. The project
 * control is separate so section-level snooze/dismiss never removes its pin.
 */
export interface TodayAttentionGroup {
  projectId: string;
  projectTitle: string;
  projectControlId: string;
  /** 1-based rank of the card within its section. */
  rank: number;
  /** Project pinned by the owner (kind 'project' candidate) — leads the section. */
  projectPinned: boolean;
  /** Any shown line is pinned, or the project is. */
  pinned: boolean;
  score: number;
  items: TodayAttentionItem[];
  hiddenCount: number;
  counts: { open: number; doing: number; blocked: number; blockers: number; decisions: number; total: number };
  freshEvidenceCount: number;
  staleDays?: number;
  /** Focus line for a pinned project that has no lines of its own. */
  focus?: string;
}

/**
 * One evidence line on a changed-project card (TODAY_CHANGES_PLAN.md §8):
 * `gist` is the sentence ("Parag Ahire asks Ravi to review…"), `meta` the
 * quieter kind · addressing · identifier line. `gistKind` tells the UI how
 * honest to be about the text: 'model' gets the sparkle glyph, 'verbatim' and
 * 'excerpt' are the source's own words, 'derived' is deterministic metadata.
 */
export interface TodayChangeEvidence {
  itemId: string;
  gist: string;
  gistKind: GistKind;
  meta: string;
  kindLabel: string;
  icon: string;
  actor: string;
  actorIsOwner: boolean;
  source: string;
  type: string;
  capturedAt: string;
  version: number;
  url?: string;
}

export interface TodayChangeItem {
  id: string;
  kind: 'change';
  projectId: string;
  projectTitle: string;
  projectControlId: string;
  /** Headline = the newest evidence line's gist (also the snapshot title). */
  title: string;
  /** Headline meta line (also the snapshot summary). */
  summary: string;
  reason: string;
  source: string;
  type: string;
  capturedAt: string;
  version: number;
  count: number;
  /** Newest first, at most CHANGE_LINES_PER_PROJECT. */
  items: TodayChangeEvidence[];
  /** Evidence rows beyond `items` — rendered as "+N more in this project". */
  hiddenCount: number;
  pinned: boolean;
  snoozedUntil?: string;
  dismissedAt?: string;
}

export interface TodayRecentProject {
  id: string;
  title: string;
  oneLiner: string;
  updatedAt: string;
  itemCount: number;
  controlId: string;
  pinned: boolean;
}

export interface TodayDeferredItem {
  id: string;
  kind: TodayItemKind;
  projectId: string;
  projectTitle: string;
  title: string;
  reason: string;
  deferredReason: string;
  pinned: boolean;
  snoozedUntil?: string;
  dismissedAt?: string;
  preferenceUpdatedAt: string;
  capturedAt?: string;
  version?: number;
  summary?: string;
  source?: string;
  type?: string;
  count?: number;
}

export interface TodayView {
  generatedAt: string;
  since: string;
  sinceLabel: 'last_visit' | 'past_24_hours';
  cursor: {
    sinceRowId: number;
    throughRowId: number;
  };
  summary: {
    activeProjects: number;
    attentionCount: number;
    explicitActionCount: number;
    pinnedProjectCount: number;
    attentionShown: number;
    /** Distinct projects behind attentionCount / attentionShown. */
    attentionProjects: number;
    attentionProjectsShown: number;
    waitingCount: number;
    waitingShown: number;
    waitingProjects: number;
    waitingProjectsShown: number;
    changeCount: number;
    changesShown: number;
    deferredCount: number;
    deferredShown: number;
    pinnedCount: number;
    awaitingReplyCount: number;
  };
  attention: TodayAttentionItem[];
  waiting: TodayAttentionItem[];
  /** Grouped forms of `attention` / `waiting` (same items, same order, per project). */
  attentionGroups: TodayAttentionGroup[];
  waitingGroups: TodayAttentionGroup[];
  /** Document comment threads whose latest word is someone else's (signals R3). */
  awaitingReply: TodayAwaitingReplyItem[];
  changes: TodayChangeItem[];
  recent: TodayRecentProject[];
  deferred: TodayDeferredItem[];
  capabilities: {
    ownership: false;
    dueDates: false;
    evidenceCitations: false;
  };
}

export interface TodayAwaitingReplyItem {
  /** `comment-thread:<latest work_item id>` — display identity only (no
   * pin/snooze plumbing v1; the id grammar in isValidTodayItemId is untouched). */
  id: string;
  /** Corpus key — the UI builds the in-app reader link (#/doc/<b64url>) from it. */
  docKey: string;
  docTitle: string;
  author: string;
  snippet: string;
  commentedAt: string;
  /** The latest comment's SharePoint url (reader deep-link once the workbench lands). */
  url: string;
  projectId?: string;
  projectTitle?: string;
  threadSize: number;
}

/**
 * Deterministic awaiting-your-reply rule (sharepoint-signals R3): group
 * document_comment evidence by (docKey, threadRoot); a thread awaits the
 * owner when its LATEST comment is someone else's (`direction='received'`),
 * is not resolved, and the owner is IN the thread — they commented earlier
 * OR any comment @-mentions them (2026-09-01: a mid-thread mention followed
 * by another reply must not bury the summons). Threads clear themselves:
 * the owner's posted reply arrives as a `sent` comment on the next fetch.
 */
export function computeAwaitingReplyThreads(db: Database.Database, limit = 8): TodayAwaitingReplyItem[] {
  const rows = db.prepare(`
    SELECT w.id, w.title, w.url, w.captured_at AS capturedAt, w.project_id AS projectId,
           p.title AS projectTitle, w.metadata
    FROM work_items w LEFT JOIN projects p ON p.id = w.project_id
    WHERE w.source = 'sharepoint' AND w.type = 'document_comment'
  `).all() as Array<{ id: string; title: string | null; url: string | null; capturedAt: string; projectId: string | null; projectTitle: string | null; metadata: string | null }>;
  if (rows.length === 0) return [];

  interface CommentRow {
    id: string; url: string; capturedAt: string; projectId: string | null; projectTitle: string | null;
    docKey: string; docTitle: string; threadRoot: string; author: string; text: string;
    commentedAt: string; direction: string; mentionedMe: string; resolved: string;
  }
  const threads = new Map<string, CommentRow[]>();
  for (const row of rows) {
    let metadata: Record<string, unknown> = {};
    try { metadata = JSON.parse(row.metadata ?? '{}'); } catch { continue; }
    const docKey = String(metadata.docKey ?? '');
    if (!docKey) continue;
    // Comments deleted from the document are history, not review load.
    if (metadata.deletedFromDoc === 'true') continue;
    const comment: CommentRow = {
      id: row.id,
      url: row.url ?? '',
      capturedAt: row.capturedAt,
      projectId: row.projectId,
      projectTitle: row.projectTitle,
      docKey,
      docTitle: String(metadata.docTitle ?? row.title ?? 'document'),
      threadRoot: String(metadata.threadRoot ?? metadata.commentId ?? row.id),
      author: String(metadata.author ?? 'unknown'),
      text: '',
      commentedAt: String(metadata.commentedAt ?? row.capturedAt),
      direction: String(metadata.direction ?? 'received'),
      mentionedMe: String(metadata.mentionedMe ?? 'false'),
      resolved: String(metadata.resolved ?? 'false'),
    };
    const key = `${docKey}\u0000${comment.threadRoot}`;
    const list = threads.get(key);
    if (list) list.push(comment); else threads.set(key, [comment]);
  }

  // Snippets only for the winners — read raw title? Comment text lives in the
  // content store; the row TITLE carries author+doc. Use the item's summary
  // fallback: not available here — snippet comes from the title-less raw_text
  // column when inline. Keep it cheap: fetch raw_text for the latest ids only.
  const awaiting: TodayAwaitingReplyItem[] = [];
  const snippetStmt = db.prepare('SELECT COALESCE(raw_text, summary, title, \'\') AS text FROM work_items WHERE id = ?');
  // Word stamps 1900-01-01 on comments without a real date (observed on the
  // owner's own replies) — ordering by that would bury the true latest
  // comment and mark an already-answered thread as awaiting. Pre-epoch or
  // unparseable stamps fall back to capture time.
  const effectiveTime = (c: CommentRow): string => {
    const parsed = Date.parse(c.commentedAt);
    return Number.isFinite(parsed) && parsed >= 0 ? c.commentedAt : c.capturedAt;
  };
  for (const list of threads.values()) {
    list.sort((a, b) => effectiveTime(a).localeCompare(effectiveTime(b)));
    const latest = list[list.length - 1];
    if (latest.direction !== 'received') continue;
    // Resolution is THREAD-scoped in Word, and the done flag can land on the
    // root comment only — the latest reply may never carry it. A thread with
    // ANY resolved member is settled (owner report 2026-08-26: resolved a
    // thread online, the row survived because only the root was stamped).
    if (list.some(c => c.resolved === 'true')) continue;
    const ownerInThread = list.some(c => c.direction === 'sent' || c.mentionedMe === 'true');
    if (!ownerInThread) continue;
    const snippetRow = snippetStmt.get(latest.id) as { text: string } | undefined;
    const snippet = (snippetRow?.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 140);
    awaiting.push({
      id: `comment-thread:${latest.id}`,
      docKey: latest.docKey,
      docTitle: latest.docTitle,
      author: latest.author,
      snippet,
      commentedAt: effectiveTime(latest),
      url: latest.url,
      projectId: latest.projectId ?? undefined,
      projectTitle: latest.projectTitle ?? undefined,
      threadSize: list.length,
    });
  }
  awaiting.sort((a, b) => b.commentedAt.localeCompare(a.commentedAt));
  return awaiting.slice(0, limit);
}

export interface TodayActionTarget {
  id: string;
  kind: TodayItemKind;
  projectId: string;
  projectTitle: string;
  title: string;
  reason: string;
  capturedAt?: string;
  version?: number;
  summary?: string;
  source?: string;
  type?: string;
  count?: number;
}

interface EvidenceRow {
  rowId: number;
  id: string;
  projectId: string;
  title: string | null;
  summary: string | null;
  type: string;
  source: string;
  capturedAt: string;
  url: string | null;
  metadata: string | null;
  gist: string | null;
  gistKind: string | null;
}

interface ProjectContext {
  row: ProjectRow;
  brain: Brain;
  itemCount: number;
  freshEvidence: EvidenceRow[];
  /** Days since the project's last substantive evidence; null when unknown. */
  staleDays: number | null;
  /**
   * False when every evidence item is passive telemetry: the brain's tasks
   * and blockers were necessarily synthesized without action-capable
   * evidence, so they must not rank as the owner's commitments on Today.
   */
  trustedActions: boolean;
}

const STALE_AFTER_DAYS = 14;
const STALE_SCORE_PENALTY = 30;

function staleReason(staleDays: number | null): string | null {
  if (staleDays == null || staleDays < STALE_AFTER_DAYS) return null;
  return `no new evidence in ${staleDays} days — may be resolved or stale`;
}

interface BuildTodayOptions {
  now?: Date;
  since?: string;
  sinceRowId?: number;
  sinceLabel?: 'last_visit' | 'past_24_hours';
}

function validIso(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : undefined;
}

function validRowId(value: unknown): number | undefined {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function normalizeSnapshot(value: unknown): TodayChangeSnapshot | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const candidate = value as Partial<TodayChangeSnapshot>;
  const capturedAt = validIso(candidate.capturedAt);
  const version = validRowId(candidate.version);
  if (candidate.kind !== 'change' || !capturedAt || version === undefined) return undefined;
  if (![candidate.projectId, candidate.projectTitle, candidate.title, candidate.reason].every(part => typeof part === 'string')) return undefined;
  const count = validRowId(candidate.count);
  return {
    kind: 'change',
    projectId: candidate.projectId as string,
    projectTitle: candidate.projectTitle as string,
    title: candidate.title as string,
    summary: typeof candidate.summary === 'string' ? candidate.summary : '',
    reason: candidate.reason as string,
    source: typeof candidate.source === 'string' ? candidate.source : 'saved change',
    type: typeof candidate.type === 'string' ? candidate.type : 'evidence',
    capturedAt,
    version,
    count: Math.max(1, count ?? 1),
  };
}

function normalizePreferences(raw: unknown): TodayPreferences {
  const source = raw && typeof raw === 'object' ? raw as Partial<TodayPreferences> : {};
  const usesEventCursor = source.cursorKind === CURSOR_KIND;
  const items: Record<string, TodayItemPreference> = {};
  if (source.items && typeof source.items === 'object') {
    for (const [id, value] of Object.entries(source.items)) {
      if (!value || typeof value !== 'object' || id.length > 220) continue;
      const candidate = value as Partial<TodayItemPreference>;
      const updatedAt = validIso(candidate.updatedAt);
      if (!updatedAt) continue;
      const preference: TodayItemPreference = { updatedAt };
      if (candidate.pinned === true) preference.pinned = true;
      const canReuseDeferral = !id.startsWith('change:') || usesEventCursor;
      const snoozedUntil = canReuseDeferral ? validIso(candidate.snoozedUntil) : undefined;
      const dismissedAt = canReuseDeferral ? validIso(candidate.dismissedAt) : undefined;
      const suppressedThroughRowId = usesEventCursor ? validRowId(candidate.suppressedThroughRowId) : undefined;
      const snapshot = usesEventCursor ? normalizeSnapshot(candidate.snapshot) : undefined;
      const snapshotPresentedSince = usesEventCursor ? validIso(candidate.snapshotPresentedSince) : undefined;
      if (snoozedUntil) preference.snoozedUntil = snoozedUntil;
      if (dismissedAt) preference.dismissedAt = dismissedAt;
      if (suppressedThroughRowId !== undefined) preference.suppressedThroughRowId = suppressedThroughRowId;
      if (snapshot) preference.snapshot = snapshot;
      if (snapshotPresentedSince) preference.snapshotPresentedSince = snapshotPresentedSince;
      items[id] = preference;
    }
  }
  return {
    version: 1,
    cursorKind: CURSOR_KIND,
    lastVisitedAt: validIso(source.lastVisitedAt),
    lastVisitedRowId: usesEventCursor ? validRowId(source.lastVisitedRowId) : undefined,
    items,
  };
}

function readPreferences(db: Database.Database): TodayPreferences {
  return normalizePreferences(getSetting<unknown>(db, SETTINGS_KEY));
}

function persistPreferences(db: Database.Database, preferences: TodayPreferences): void {
  setSetting(db, SETTINGS_KEY, preferences);
}

function normalizeText(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

function stableItemId(kind: Exclude<TodayItemKind, 'change'>, projectId: string, text?: string): string {
  if (kind === 'project') return `project:${projectId}`;
  // Brain tasks do not yet persist IDs. Hashing normalized text keeps state
  // stable across task-state changes; a substantive rewrite intentionally
  // becomes a new item instead of carrying old user state onto new wording.
  const digest = createHash('sha256')
    .update(`${kind}\0${projectId}\0${normalizeText(text ?? '')}`, 'utf8')
    .digest('hex')
    .slice(0, 18);
  return `${kind}:${projectId}:${digest}`;
}

function preferenceFor(preferences: TodayPreferences, id: string): TodayItemPreference | undefined {
  return preferences.items[id];
}

function isSuppressed(
  preference: TodayItemPreference | undefined,
  nowMs: number,
  changeVersion?: number,
): boolean {
  if (!preference) return false;
  const snoozed = Boolean(preference.snoozedUntil && Date.parse(preference.snoozedUntil) > nowMs);
  if (!snoozed && !preference.dismissedAt) return false;
  if (changeVersion === undefined) return true;
  if (preference.suppressedThroughRowId === undefined) return true;
  return changeVersion <= preference.suppressedThroughRowId;
}

function isDecisionOrResponse(text: string): boolean {
  return /\b(decide|decision|approve|approval|confirm|respond|response|reply|review|follow[ -]?up)\b/i.test(text);
}

function projectFocusTitle(context: ProjectContext): string {
  const status = context.brain.statusLine.trim();
  if (status && !/^(active|no (?:substantive content|explicit next action))/i.test(status)) return status;
  return context.row.one_liner?.trim() || context.row.title;
}

function candidateFromTask(
  context: ProjectContext,
  task: { state: TaskState; text: string },
  preferences: TodayPreferences,
): TodayAttentionItem {
  const id = stableItemId('task', context.row.id, task.text);
  const preference = preferenceFor(preferences, id);
  const decisionOrResponse = isDecisionOrResponse(task.text);
  const freshEvidenceCount = context.freshEvidence.length;
  const reasonParts = [
    preference?.pinned
      ? 'Pinned by you'
      : task.state === 'doing'
        ? 'Explicit task already in progress'
        : task.state === 'blocked'
          ? 'Explicit task marked blocked'
          : 'Explicit open task in the project brain',
  ];
  if (decisionOrResponse) reasonParts.push('decision or response wording');
  if (freshEvidenceCount) reasonParts.push(`${freshEvidenceCount} new substantive evidence ${freshEvidenceCount === 1 ? 'item' : 'items'} in this project`);
  const stale = staleReason(context.staleDays);
  if (stale) reasonParts.push(stale);
  const baseScore = task.state === 'doing' ? 90 : task.state === 'blocked' ? 76 : 82;
  return {
    id,
    kind: 'task',
    projectId: context.row.id,
    projectTitle: context.row.title,
    title: task.text,
    reason: reasonParts.join(' · '),
    state: task.state,
    staleDays: stale ? context.staleDays ?? undefined : undefined,
    updatedAt: context.brain.updated || context.row.updated_at,
    freshEvidenceCount,
    freshEvidenceAt: context.freshEvidence[0]?.capturedAt,
    freshEvidenceVersion: context.freshEvidence[0]?.rowId,
    pinned: preference?.pinned === true,
    snoozedUntil: preference?.snoozedUntil,
    dismissedAt: preference?.dismissedAt,
    score: baseScore + (decisionOrResponse ? 12 : 0) - (stale ? STALE_SCORE_PENALTY : 0) + (preference?.pinned ? 1000 : 0),
  };
}

function candidateFromBlocker(
  context: ProjectContext,
  blocker: string,
  preferences: TodayPreferences,
): TodayAttentionItem {
  const id = stableItemId('blocker', context.row.id, blocker);
  const preference = preferenceFor(preferences, id);
  const freshEvidenceCount = context.freshEvidence.length;
  const stale = staleReason(context.staleDays);
  const reasonParts = [
    preference?.pinned ? 'Pinned by you · recorded project blocker' : 'Recorded project blocker',
  ];
  if (freshEvidenceCount) reasonParts.push(`${freshEvidenceCount} new substantive evidence ${freshEvidenceCount === 1 ? 'item' : 'items'} in this project`);
  if (stale) reasonParts.push(stale);
  return {
    id,
    kind: 'blocker',
    projectId: context.row.id,
    projectTitle: context.row.title,
    title: blocker,
    reason: reasonParts.join(' · '),
    state: 'blocked',
    staleDays: stale ? context.staleDays ?? undefined : undefined,
    updatedAt: context.brain.updated || context.row.updated_at,
    freshEvidenceCount,
    freshEvidenceAt: context.freshEvidence[0]?.capturedAt,
    freshEvidenceVersion: context.freshEvidence[0]?.rowId,
    pinned: preference?.pinned === true,
    snoozedUntil: preference?.snoozedUntil,
    dismissedAt: preference?.dismissedAt,
    score: 72 - (stale ? STALE_SCORE_PENALTY : 0) + (preference?.pinned ? 1000 : 0),
  };
}

function candidateFromProject(context: ProjectContext, preferences: TodayPreferences): TodayAttentionItem {
  const id = stableItemId('project', context.row.id);
  const preference = preferenceFor(preferences, id);
  return {
    id,
    kind: 'project',
    projectId: context.row.id,
    projectTitle: context.row.title,
    title: projectFocusTitle(context),
    reason: 'Project pinned by you',
    updatedAt: context.brain.updated || context.row.updated_at,
    freshEvidenceCount: context.freshEvidence.length,
    freshEvidenceAt: context.freshEvidence[0]?.capturedAt,
    freshEvidenceVersion: context.freshEvidence[0]?.rowId,
    pinned: preference?.pinned === true,
    snoozedUntil: preference?.snoozedUntil,
    dismissedAt: preference?.dismissedAt,
    score: preference?.pinned ? 1100 : 0,
  };
}

function compareAttention(a: TodayAttentionItem, b: TodayAttentionItem): number {
  if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
  if (a.score !== b.score) return b.score - a.score;
  const evidenceOrder = (b.freshEvidenceVersion ?? 0) - (a.freshEvidenceVersion ?? 0);
  if (evidenceOrder !== 0) return evidenceOrder;
  const projectOrder = a.projectTitle.localeCompare(b.projectTitle);
  return projectOrder || a.title.localeCompare(b.title);
}

/**
 * Rank per PROJECT, not per task (owner ruling 2026-09-09): a project with
 * several open commitments takes one rail row and every current line appears
 * in its independently scrolling detail pane. Pinned projects/lines lead;
 * then the project's best line score; freshest evidence; then title.
 */
function groupByProject(
  items: TodayAttentionItem[],
  contextByProject: Map<string, ProjectContext>,
): { groups: TodayAttentionGroup[]; shown: TodayAttentionItem[] } {
  const sorted = [...new Map(items.map(item => [item.id, item])).values()].sort(compareAttention);
  const byProject = new Map<string, TodayAttentionItem[]>();
  for (const item of sorted) {
    const rows = byProject.get(item.projectId) ?? [];
    rows.push(item);
    byProject.set(item.projectId, rows);
  }
  const groups: TodayAttentionGroup[] = [];
  for (const [projectId, rows] of byProject) {
    const projectItem = rows.find(item => item.kind === 'project');
    const lines = rows.filter(item => item.kind !== 'project');
    const context = contextByProject.get(projectId);
    const shownLines = lines;
    const best = rows[0];
    groups.push({
      projectId,
      projectTitle: best.projectTitle,
      projectControlId: stableItemId('project', projectId),
      rank: 0,
      projectPinned: projectItem?.pinned === true,
      pinned: projectItem?.pinned === true || shownLines.some(item => item.pinned),
      score: best.score,
      items: shownLines,
      hiddenCount: 0,
      counts: {
        open: lines.filter(item => item.kind === 'task' && item.state === 'todo').length,
        doing: lines.filter(item => item.kind === 'task' && item.state === 'doing').length,
        blocked: lines.filter(item => item.kind === 'task' && item.state === 'blocked').length,
        blockers: lines.filter(item => item.kind === 'blocker').length,
        decisions: lines.filter(item => isDecisionOrResponse(item.title)).length,
        total: lines.length,
      },
      freshEvidenceCount: best.freshEvidenceCount,
      staleDays: best.staleDays,
      focus: lines.length === 0 && context ? projectFocusTitle(context) : undefined,
    });
  }
  groups.sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    if (a.score !== b.score) return b.score - a.score;
    const evidenceOrder = (b.items[0]?.freshEvidenceVersion ?? 0) - (a.items[0]?.freshEvidenceVersion ?? 0);
    if (evidenceOrder !== 0) return evidenceOrder;
    return a.projectTitle.localeCompare(b.projectTitle);
  });
  // The focus-board rail is the collection navigator: return EVERY ranked
  // project and let that pane own scrolling. The former 8-project cap belonged
  // to the vertical-card layout and made lower-ranked projects unreachable.
  groups.forEach((group, index) => { group.rank = index + 1; });
  return { groups, shown: groups.flatMap(group => group.items) };
}

function deferredReason(preference: TodayItemPreference): string {
  if (preference.snoozedUntil && !preference.dismissedAt) return `Snoozed until ${preference.snoozedUntil}`;
  return preference.dismissedAt ? 'Dismissed' : 'Set aside';
}

function deferredFromAttention(item: TodayAttentionItem, preference: TodayItemPreference): TodayDeferredItem {
  return {
    id: item.id,
    kind: item.kind,
    projectId: item.projectId,
    projectTitle: item.projectTitle,
    title: item.title,
    reason: item.reason,
    deferredReason: deferredReason(preference),
    pinned: item.pinned,
    snoozedUntil: preference.snoozedUntil,
    dismissedAt: preference.dismissedAt,
    preferenceUpdatedAt: preference.updatedAt,
  };
}

function deferredFromChange(item: TodayChangeItem, preference: TodayItemPreference): TodayDeferredItem {
  return {
    id: item.id,
    kind: 'change',
    projectId: item.projectId,
    projectTitle: item.projectTitle,
    title: item.title,
    reason: item.reason,
    deferredReason: deferredReason(preference),
    pinned: false,
    snoozedUntil: preference.snoozedUntil,
    dismissedAt: preference.dismissedAt,
    preferenceUpdatedAt: preference.updatedAt,
    capturedAt: item.capturedAt,
    version: item.version,
    summary: item.summary,
    source: item.source,
    type: item.type,
    count: item.count,
  };
}

function deferredFromSnapshot(preference: TodayItemPreference): TodayDeferredItem | null {
  const snapshot = preference.snapshot;
  if (!snapshot) return null;
  return {
    id: `change:${snapshot.projectId}`,
    kind: 'change',
    projectId: snapshot.projectId,
    projectTitle: snapshot.projectTitle,
    title: snapshot.title,
    reason: snapshot.reason,
    deferredReason: deferredReason(preference),
    pinned: false,
    snoozedUntil: preference.snoozedUntil,
    dismissedAt: preference.dismissedAt,
    preferenceUpdatedAt: preference.updatedAt,
    capturedAt: snapshot.capturedAt,
    version: snapshot.version,
    summary: snapshot.summary,
    source: snapshot.source,
    type: snapshot.type,
    count: snapshot.count,
  };
}

function changeFromSnapshot(
  snapshot: TodayChangeSnapshot,
  preference: TodayItemPreference,
  context: ProjectContext,
  preferences: TodayPreferences,
): TodayChangeItem {
  const projectControlId = stableItemId('project', snapshot.projectId);
  return {
    id: `change:${snapshot.projectId}`,
    kind: 'change',
    projectId: snapshot.projectId,
    projectTitle: context.row.title,
    projectControlId,
    title: snapshot.title,
    summary: snapshot.summary,
    reason: snapshot.reason,
    source: snapshot.source,
    type: snapshot.type,
    capturedAt: snapshot.capturedAt,
    version: snapshot.version,
    count: snapshot.count,
    // A restored card renders its headline as the single line; the rest of
    // the rows are behind the cursor by now (snapshot = presented state).
    items: [{
      itemId: '',
      gist: snapshot.title,
      gistKind: 'excerpt',
      meta: snapshot.summary,
      kindLabel: '',
      icon: 'activity',
      actor: '',
      actorIsOwner: false,
      source: snapshot.source,
      type: snapshot.type,
      capturedAt: snapshot.capturedAt,
      version: snapshot.version,
    }],
    hiddenCount: Math.max(0, snapshot.count - 1),
    pinned: preferenceFor(preferences, projectControlId)?.pinned === true,
    snoozedUntil: preference.snoozedUntil,
    dismissedAt: preference.dismissedAt,
  };
}

function itemCounts(db: Database.Database): Map<string, number> {
  const rows = db.prepare(
    'SELECT project_id AS projectId, COUNT(*) AS count FROM work_items WHERE project_id IS NOT NULL GROUP BY project_id',
  ).all() as { projectId: string; count: number }[];
  return new Map(rows.map(row => [row.projectId, row.count]));
}

/**
 * Projects whose brain tasks are backed by at least one action-capable
 * signal: a manual/agent item, an engaged Slack message (sent, mention,
 * thread, DM), or any message from a currently engaged channel. Projects
 * with evidence but none of these are telemetry-only; zero-evidence projects
 * are trusted (nothing was synthesized from telemetry).
 */
function trustedActionProjects(db: Database.Database): (projectId: string, itemCount: number) => boolean {
  const rows = db.prepare(`
    SELECT project_id AS projectId,
      SUM(CASE WHEN source IN ('manual', 'agent') THEN 1 ELSE 0 END) AS trusted,
      SUM(CASE WHEN source = 'slack' AND type = 'slack_message' AND (
        json_extract(metadata, '$.direction') = 'sent'
        OR json_extract(metadata, '$.engaged') = 'true'
        OR json_extract(metadata, '$.mentionedMe') = 'true'
        OR json_extract(metadata, '$.threadEngaged') = 'true'
        OR json_extract(metadata, '$.channelType') IN ('dm', 'group_dm')
      ) THEN 1 ELSE 0 END) AS engagedSlack,
      SUM(CASE WHEN source = 'sharepoint' AND type = 'document_comment' AND (
        json_extract(metadata, '$.direction') = 'sent'
        OR json_extract(metadata, '$.mentionedMe') = 'true'
      ) THEN 1 ELSE 0 END) AS engagedComments
    FROM work_items WHERE project_id IS NOT NULL GROUP BY project_id
  `).all() as { projectId: string; trusted: number; engagedSlack: number; engagedComments: number }[];
  const strong = new Map(rows.map(row => [row.projectId, row.trusted > 0 || row.engagedSlack > 0 || row.engagedComments > 0]));

  // Received channel messages without flags still count when their channel is
  // currently engaged (the owner is active there).
  const resolveTier = createChannelTierResolver(db);
  const channelRows = db.prepare(`
    SELECT DISTINCT project_id AS projectId,
           json_extract(metadata, '$.channelId') AS channelId,
           json_extract(metadata, '$.channelType') AS channelType
    FROM work_items
    WHERE project_id IS NOT NULL AND source = 'slack' AND type = 'slack_message'
      AND json_extract(metadata, '$.channelId') IS NOT NULL
  `).all() as { projectId: string; channelId: string; channelType: string | null }[];
  for (const row of channelRows) {
    if (strong.get(row.projectId)) continue;
    if (resolveTier(row.channelId, row.channelType ?? undefined) === 'engaged') strong.set(row.projectId, true);
  }
  return (projectId, itemCount) => itemCount === 0 || (strong.get(projectId) ?? false);
}

/** Last substantive (non app-activity, non-noise) evidence per project. */
function lastEvidenceAt(db: Database.Database): Map<string, string> {
  const rows = db.prepare(`
    SELECT project_id AS projectId, MAX(captured_at) AS lastAt
    FROM work_items
    WHERE project_id IS NOT NULL
      AND type <> 'app_activity'
      AND COALESCE(process_state, '') <> 'noise'
    GROUP BY project_id
  `).all() as { projectId: string; lastAt: string | null }[];
  return new Map(rows.filter(row => row.lastAt).map(row => [row.projectId, row.lastAt as string]));
}

function latestEvidenceEventRowId(db: Database.Database): number {
  const row = db.prepare('SELECT COALESCE(MAX(id), 0) AS rowId FROM work_item_project_events').get() as { rowId: number };
  return validRowId(row.rowId) ?? 0;
}

/**
 * One rendered evidence line. The persisted gist wins; rows the sweeper has
 * not reached yet (or pre-migration rows) get the deterministic excerpt over
 * the stored preview so a card never shows a raw header dump or blank line.
 */
function changeEvidenceLine(row: EvidenceRow, owner: OwnerMatcher): TodayChangeEvidence {
  const evidence = {
    id: row.id,
    type: row.type,
    source: row.source,
    title: row.title,
    summary: row.summary,
    url: row.url,
    metadata: row.metadata,
    capturedAt: row.capturedAt,
  };
  const description = describeEvidence(evidence, owner);
  const persisted = row.gist?.trim();
  // Deterministic provenance must be visible on the very first render; the
  // async gister persists the same sentence shortly afterward.
  const fallback = persisted ? null : derivedGist(evidence, description) ?? excerptGist(
    evidence,
    description,
    previewBody(row),
  );
  return {
    itemId: row.id,
    gist: persisted || fallback!.gist,
    gistKind: (persisted ? (row.gistKind as GistKind | null) ?? 'model' : fallback!.kind),
    meta: description.meta,
    kindLabel: description.kindLabel,
    icon: description.icon,
    actor: description.actor,
    actorIsOwner: description.actorIsOwner,
    source: row.source,
    type: row.type,
    capturedAt: row.capturedAt,
    version: row.rowId,
    url: description.url,
  };
}

/** The stored 500-char preview, cleaned the same way the gister cleans full
 * content (mail headers/greeting/quoted thread, Slack mrkdwn, comment context). */
function previewBody(row: EvidenceRow): string {
  return gistSourceText(
    { id: row.id, type: row.type, source: row.source, title: row.title, summary: row.summary, url: row.url, metadata: row.metadata },
    row.summary ?? '',
  );
}

function freshEvidenceRows(
  db: Database.Database,
  sinceRowId: number,
  throughRowId: number,
  since: string,
  through: string,
  firstVisitWindow: boolean,
): EvidenceRow[] {
  return db.prepare(`
    SELECT project_event.id AS rowId,
           work_items.id,
           project_event.project_id AS projectId,
           work_items.title,
           work_items.summary,
           work_items.type,
           work_items.source,
           work_items.captured_at AS capturedAt,
           work_items.url,
           work_items.metadata,
           work_items.gist,
           work_items.gist_kind AS gistKind
    FROM work_item_project_events AS project_event
    JOIN work_items ON work_items.id = project_event.work_item_id
    WHERE project_event.id > ?
      AND project_event.id <= ?
      AND project_event.project_id IS NOT NULL
      AND project_event.id = (
        SELECT MAX(latest_event.id)
        FROM work_item_project_events AS latest_event
        WHERE latest_event.work_item_id = project_event.work_item_id
          AND latest_event.id <= ?
      )
      AND (
        ? = 0
        OR (
          julianday(work_items.captured_at) > julianday(?)
          AND julianday(work_items.captured_at) <= julianday(?)
        )
      )
      AND ${SUBSTANTIVE_EVIDENCE_SQL_PREDICATE}
    ORDER BY project_event.id DESC
  `).all(
    sinceRowId,
    throughRowId,
    throughRowId,
    firstVisitWindow ? 1 : 0,
    since,
    through,
  ) as EvidenceRow[];
}

export function buildTodayView(
  db: Database.Database,
  brainStore: BrainStore,
  options: BuildTodayOptions = {},
): TodayView {
  const now = options.now ?? new Date();
  const nowMs = now.getTime();
  const generatedAt = now.toISOString();
  const preferences = readPreferences(db);
  const throughRowId = latestEvidenceEventRowId(db);
  const requestedSince = validIso(options.since);
  const requestedSinceRowId = validRowId(options.sinceRowId);
  const hasRequestedCursor = requestedSinceRowId !== undefined;
  const hasStoredCursor = !hasRequestedCursor && preferences.lastVisitedRowId !== undefined;
  const sinceRowId = requestedSinceRowId ?? preferences.lastVisitedRowId ?? 0;
  const since = requestedSince
    ?? (hasRequestedCursor || hasStoredCursor ? preferences.lastVisitedAt : undefined)
    ?? new Date(nowMs - DEFAULT_CHANGE_WINDOW_MS).toISOString();
  const sinceLabel = options.sinceLabel ?? (hasRequestedCursor || hasStoredCursor ? 'last_visit' : 'past_24_hours');
  const evidence = freshEvidenceRows(
    db,
    sinceRowId,
    throughRowId,
    since,
    generatedAt,
    sinceLabel === 'past_24_hours',
  );
  const evidenceByProject = new Map<string, EvidenceRow[]>();
  for (const row of evidence) {
    const rows = evidenceByProject.get(row.projectId) ?? [];
    rows.push(row);
    evidenceByProject.set(row.projectId, rows);
  }

  const counts = itemCounts(db);
  const lastEvidence = lastEvidenceAt(db);
  const hasTrustedActions = trustedActionProjects(db);
  const contexts: ProjectContext[] = [];
  for (const row of brainStore.listProjects('active')) {
    const brain = brainStore.read(row.id);
    if (!brain) continue;
    const lastAt = lastEvidence.get(row.id);
    const lastMs = lastAt ? Date.parse(lastAt) : NaN;
    const itemCount = counts.get(row.id) ?? 0;
    contexts.push({
      row,
      brain,
      itemCount,
      freshEvidence: evidenceByProject.get(row.id) ?? [],
      staleDays: Number.isFinite(lastMs) ? Math.max(0, Math.floor((nowMs - lastMs) / 86400000)) : null,
      trustedActions: hasTrustedActions(row.id, itemCount),
    });
  }
  const contextByProject = new Map(contexts.map(context => [context.row.id, context]));

  const actionable = new Map<string, TodayAttentionItem>();
  const blockedOrWaiting = new Map<string, TodayAttentionItem>();
  const allAttentionCandidates = new Map<string, TodayAttentionItem>();
  for (const context of contexts) {
    const projectCandidate = candidateFromProject(context, preferences);
    allAttentionCandidates.set(projectCandidate.id, projectCandidate);
    if (projectCandidate.pinned) actionable.set(projectCandidate.id, projectCandidate);

    // Telemetry-only projects keep their pinnable project card, but their
    // synthesized tasks/blockers never rank as the owner's commitments.
    if (!context.trustedActions) continue;

    const taskTexts = new Set<string>();
    for (const task of context.brain.tasks) {
      const normalized = normalizeText(task.text);
      if (task.state === 'done' || !normalized || taskTexts.has(normalized)) continue;
      taskTexts.add(normalized);
      const candidate = candidateFromTask(context, task, preferences);
      allAttentionCandidates.set(candidate.id, candidate);
      if (task.state === 'blocked') blockedOrWaiting.set(candidate.id, candidate);
      else actionable.set(candidate.id, candidate);
    }
    const blockerTexts = new Set<string>();
    for (const blockerValue of context.brain.blockers) {
      const blocker = blockerValue.trim();
      const normalized = normalizeText(blocker);
      if (!normalized || taskTexts.has(normalized) || blockerTexts.has(normalized)) continue;
      blockerTexts.add(normalized);
      const candidate = candidateFromBlocker(context, blocker, preferences);
      allAttentionCandidates.set(candidate.id, candidate);
      blockedOrWaiting.set(candidate.id, candidate);
    }
  }

  const deferredById = new Map<string, TodayDeferredItem>();
  const visibleActionable = [...actionable.values()].filter(item => {
    const preference = preferenceFor(preferences, item.id);
    if (!isSuppressed(preference, nowMs)) return true;
    if (preference) deferredById.set(item.id, deferredFromAttention(item, preference));
    return false;
  });
  const visibleWaiting = [...blockedOrWaiting.values()].filter(item => {
    const preference = preferenceFor(preferences, item.id);
    if (!isSuppressed(preference, nowMs)) return true;
    if (preference) deferredById.set(item.id, deferredFromAttention(item, preference));
    return false;
  });

  const changes: TodayChangeItem[] = [];
  const currentChangeIds = new Set<string>();
  const owner = createOwnerMatcher(db);
  for (const [projectId, rows] of evidenceByProject) {
    const context = contextByProject.get(projectId);
    if (!context || rows.length === 0) continue;
    const latest = rows[0];
    const id = `change:${projectId}`;
    currentChangeIds.add(id);
    const preference = preferenceFor(preferences, id);
    const items = rows.slice(0, CHANGE_LINES_PER_PROJECT).map(row => changeEvidenceLine(row, owner));
    const headline = items[0];
    const change: TodayChangeItem = {
      id,
      kind: 'change',
      projectId,
      projectTitle: context.row.title,
      projectControlId: stableItemId('project', projectId),
      title: headline.gist,
      summary: headline.meta,
      reason: `${rows.length} substantive evidence ${rows.length === 1 ? 'item' : 'items'} since ${sinceLabel === 'last_visit' ? 'your last visit' : 'the past 24 hours'}`,
      source: latest.source,
      type: latest.type,
      capturedAt: latest.capturedAt,
      version: latest.rowId,
      count: rows.length,
      items,
      hiddenCount: Math.max(0, rows.length - items.length),
      pinned: preferenceFor(preferences, stableItemId('project', projectId))?.pinned === true,
      snoozedUntil: preference?.snoozedUntil,
      dismissedAt: preference?.dismissedAt,
    };
    if (isSuppressed(preference, nowMs, latest.rowId)) {
      if (preference) deferredById.set(id, deferredFromChange(change, preference));
    } else {
      changes.push(change);
    }
  }

  for (const candidate of allAttentionCandidates.values()) {
    const preference = preferenceFor(preferences, candidate.id);
    if (!preference || deferredById.has(candidate.id) || !isSuppressed(preference, nowMs)) continue;
    deferredById.set(candidate.id, deferredFromAttention(candidate, preference));
  }
  for (const [id, preference] of Object.entries(preferences.items)) {
    if (!id.startsWith('change:') || currentChangeIds.has(id) || deferredById.has(id)) continue;
    const snapshot = preference.snapshot;
    if (!snapshot) continue;
    const context = contextByProject.get(snapshot.projectId);
    if (!context) continue;
    if (isSuppressed(preference, nowMs, snapshot.version)) {
      const deferred = deferredFromSnapshot(preference);
      if (deferred) deferredById.set(id, deferred);
      continue;
    }
    if (!preference.snapshotPresentedSince || preference.snapshotPresentedSince === since) {
      changes.push(changeFromSnapshot(snapshot, preference, context, preferences));
    }
  }
  changes.sort((a, b) => b.version - a.version);

  const deferred = [...deferredById.values()]
    .sort((a, b) => Date.parse(b.preferenceUpdatedAt) - Date.parse(a.preferenceUpdatedAt));
  const recent: TodayRecentProject[] = contexts
    .slice(0, RECENT_LIMIT)
    .map(context => {
      const controlId = stableItemId('project', context.row.id);
      return {
        id: context.row.id,
        title: context.row.title,
        oneLiner: context.row.one_liner?.trim() || context.brain.statusLine.trim() || 'Project brain available',
        updatedAt: context.row.updated_at,
        itemCount: context.itemCount,
        controlId,
        pinned: preferenceFor(preferences, controlId)?.pinned === true,
      };
    });

  const attentionGrouped = groupByProject(visibleActionable, contextByProject);
  const waitingGrouped = groupByProject(visibleWaiting, contextByProject);
  const attention = attentionGrouped.shown;
  const waiting = waitingGrouped.shown;
  const distinctProjects = (items: TodayAttentionItem[]): number => new Set(items.map(item => item.projectId)).size;
  const visibleChanges = changes.slice(0, CHANGE_LIMIT);
  const awaitingReply = computeAwaitingReplyThreads(db);
  const pinnedIds = new Set(
    [...allAttentionCandidates.values()].filter(item => item.pinned).map(item => item.id),
  );
  return {
    generatedAt,
    since,
    sinceLabel,
    cursor: { sinceRowId, throughRowId },
    summary: {
      activeProjects: contexts.length,
      attentionCount: visibleActionable.length,
      explicitActionCount: visibleActionable.filter(item => item.kind === 'task').length,
      pinnedProjectCount: visibleActionable.filter(item => item.kind === 'project').length,
      attentionShown: attention.length,
      attentionProjects: distinctProjects(visibleActionable),
      attentionProjectsShown: attentionGrouped.groups.length,
      waitingCount: visibleWaiting.length,
      waitingShown: waiting.length,
      waitingProjects: distinctProjects(visibleWaiting),
      waitingProjectsShown: waitingGrouped.groups.length,
      changeCount: changes.length,
      changesShown: visibleChanges.length,
      deferredCount: deferred.length,
      deferredShown: deferred.length,
      pinnedCount: pinnedIds.size,
      awaitingReplyCount: awaitingReply.length,
    },
    attention,
    waiting,
    attentionGroups: attentionGrouped.groups,
    waitingGroups: waitingGrouped.groups,
    awaitingReply,
    changes: visibleChanges,
    recent,
    deferred,
    capabilities: {
      ownership: false,
      dueDates: false,
      evidenceCitations: false,
    },
  };
}

export function findTodayActionTarget(view: TodayView, itemId: string): TodayActionTarget | null {
  const attention = [...view.attention, ...view.waiting, ...view.deferred].find(item => item.id === itemId);
  if (attention) {
    return {
      id: attention.id,
      kind: attention.kind,
      projectId: attention.projectId,
      projectTitle: attention.projectTitle,
      title: attention.title,
      reason: attention.reason,
      capturedAt: 'capturedAt' in attention ? attention.capturedAt : undefined,
      version: 'version' in attention ? attention.version : undefined,
      summary: 'summary' in attention ? attention.summary : undefined,
      source: 'source' in attention ? attention.source : undefined,
      type: 'type' in attention ? attention.type : undefined,
      count: 'count' in attention ? attention.count : undefined,
    };
  }
  const change = view.changes.find(item => item.id === itemId);
  if (change) {
    return {
      id: change.id,
      kind: 'change',
      projectId: change.projectId,
      projectTitle: change.projectTitle,
      title: change.title,
      reason: change.reason,
      capturedAt: change.capturedAt,
      version: change.version,
      summary: change.summary,
      source: change.source,
      type: change.type,
      count: change.count,
    };
  }
  const project = view.recent.find(item => item.controlId === itemId)
    ?? view.changes.find(item => item.projectControlId === itemId)
    ?? [...view.attentionGroups, ...view.waitingGroups].find(group => group.projectControlId === itemId);
  if (project) {
    const recentProject = 'controlId' in project;
    const projectId = recentProject ? project.id : project.projectId;
    const projectTitle = recentProject ? project.title : project.projectTitle;
    return {
      id: itemId,
      kind: 'project',
      projectId,
      projectTitle,
      title: projectTitle,
      reason: 'Project pin control',
    };
  }
  return null;
}

function snapshotFromTarget(target: TodayActionTarget): TodayChangeSnapshot {
  const capturedAt = validIso(target.capturedAt);
  const version = validRowId(target.version);
  const count = validRowId(target.count);
  if (target.kind !== 'change' || !capturedAt || version === undefined) {
    throw new Error('A current change version is required');
  }
  return {
    kind: 'change',
    projectId: target.projectId,
    projectTitle: target.projectTitle,
    title: target.title,
    summary: target.summary ?? '',
    reason: target.reason,
    source: target.source ?? 'saved change',
    type: target.type ?? 'evidence',
    capturedAt,
    version,
    count: Math.max(1, count ?? 1),
  };
}

interface TodayItemActionOptions {
  snoozedUntil?: string;
  target?: TodayActionTarget;
  sessionSince?: string;
}

function mutateTodayItemPreference(
  preferences: TodayPreferences,
  itemId: string,
  action: TodayItemAction,
  options: TodayItemActionOptions,
  now: Date,
): TodayItemPreference | null {
  const existing = preferences.items[itemId] ?? { updatedAt: now.toISOString() };
  const next: TodayItemPreference = { ...existing, updatedAt: now.toISOString() };
  if (action === 'pin') {
    next.pinned = true;
    delete next.snoozedUntil;
    delete next.dismissedAt;
    delete next.suppressedThroughRowId;
    delete next.snapshot;
    delete next.snapshotPresentedSince;
  } else if (action === 'unpin') {
    delete next.pinned;
  } else if (action === 'snooze') {
    const snoozedUntil = validIso(options.snoozedUntil);
    if (!snoozedUntil) throw new Error('A valid snoozedUntil timestamp is required');
    const duration = Date.parse(snoozedUntil) - now.getTime();
    if (duration <= 0 || duration > MAX_SNOOZE_MS) throw new Error('snoozedUntil must be in the future and within one year');
    next.snoozedUntil = snoozedUntil;
    delete next.dismissedAt;
    delete next.snapshotPresentedSince;
  } else if (action === 'dismiss') {
    next.dismissedAt = now.toISOString();
    delete next.snoozedUntil;
    delete next.snapshotPresentedSince;
  } else if (action === 'restore') {
    delete next.snoozedUntil;
    delete next.dismissedAt;
    delete next.suppressedThroughRowId;
    if (options.target?.kind === 'change') {
      next.snapshot = snapshotFromTarget(options.target);
      const sessionSince = validIso(options.sessionSince);
      if (sessionSince) next.snapshotPresentedSince = sessionSince;
      else delete next.snapshotPresentedSince;
    } else {
      delete next.snapshot;
      delete next.snapshotPresentedSince;
    }
  }

  if ((action === 'snooze' || action === 'dismiss') && options.target?.kind === 'change') {
    const snapshot = snapshotFromTarget(options.target);
    next.suppressedThroughRowId = snapshot.version;
    next.snapshot = snapshot;
  }

  if (!next.pinned && !next.snoozedUntil && !next.dismissedAt && !next.snapshot) {
    delete preferences.items[itemId];
    return null;
  }
  preferences.items[itemId] = next;
  return next;
}

export function applyTodayItemAction(
  db: Database.Database,
  itemId: string,
  action: TodayItemAction,
  options: TodayItemActionOptions = {},
  now = new Date(),
): TodayItemPreference | null {
  const apply = db.transaction(() => {
    const preferences = readPreferences(db);
    const state = mutateTodayItemPreference(preferences, itemId, action, options, now);
    persistPreferences(db, preferences);
    return state;
  });
  return apply();
}

/**
 * Composite section action: one fixed Today view supplies one group's complete
 * current item list. Every per-item preference is updated with the same rules
 * and timestamp, then the single settings blob is persisted atomically. The
 * project control itself is deliberately excluded so its pin survives.
 */
export function applyTodayProjectAction(
  db: Database.Database,
  group: TodayAttentionGroup,
  action: TodayProjectAction,
  options: Pick<TodayItemActionOptions, 'snoozedUntil'> = {},
  now = new Date(),
): { itemIds: string[]; states: Record<string, TodayItemPreference | null> } {
  const itemIds = [...new Set(group.items.map(item => item.id))];
  if (itemIds.length === 0) throw new Error('This project has no current items in this section');
  const apply = db.transaction(() => {
    const preferences = readPreferences(db);
    const states: Record<string, TodayItemPreference | null> = {};
    for (const itemId of itemIds) {
      states[itemId] = mutateTodayItemPreference(preferences, itemId, action, options, now);
    }
    persistPreferences(db, preferences);
    return { itemIds, states };
  });
  return apply();
}

/**
 * Composite Set aside recovery: targets come from one authoritative fixed
 * Today view, then every current deferred item for that project is restored in
 * one transaction and one settings-blob write. Change targets retain their
 * saved snapshot for this exact session; project controls are never accepted,
 * so project pins remain independent.
 */
export function applyTodayDeferredProjectRestore(
  db: Database.Database,
  targets: TodayActionTarget[],
  sessionSince: string,
  now = new Date(),
): { itemIds: string[]; states: Record<string, TodayItemPreference | null> } {
  const normalizedSince = validIso(sessionSince);
  if (!normalizedSince) throw new Error('A valid Today session is required to restore this project');
  const uniqueTargets = [...new Map(targets.map(target => [target.id, target])).values()];
  if (uniqueTargets.length === 0) throw new Error('This project has no current deferred items');
  if (uniqueTargets.some(target => target.kind === 'project')) {
    throw new Error('Project pin controls cannot be restored from Set aside');
  }
  if (new Set(uniqueTargets.map(target => target.projectId)).size !== 1) {
    throw new Error('Deferred project restore targets must belong to one project');
  }

  const apply = db.transaction(() => {
    const preferences = readPreferences(db);
    const states: Record<string, TodayItemPreference | null> = {};
    for (const target of uniqueTargets) {
      states[target.id] = mutateTodayItemPreference(preferences, target.id, 'restore', {
        target,
        sessionSince: normalizedSince,
      }, now);
    }
    persistPreferences(db, preferences);
    return { itemIds: uniqueTargets.map(target => target.id), states };
  });
  return apply();
}

export function recordTodayVisit(db: Database.Database, view: TodayView): string {
  const parsed = validIso(view.generatedAt);
  const parsedSince = validIso(view.since);
  const parsedRowId = validRowId(view.cursor.throughRowId);
  if (!parsed || !parsedSince) throw new Error('A valid visit window is required');
  if (parsedRowId === undefined) throw new Error('A valid visit row cursor is required');
  const preferences = readPreferences(db);
  const visibleChanges = new Map(view.changes.map(change => [change.id, change]));
  for (const [id, preference] of Object.entries(preferences.items)) {
    const snapshot = preference.snapshot;
    if (!snapshot) continue;
    const visible = visibleChanges.get(id);
    if (visible && visible.version > snapshot.version) {
      delete preference.snoozedUntil;
      delete preference.dismissedAt;
      delete preference.suppressedThroughRowId;
      delete preference.snapshot;
      delete preference.snapshotPresentedSince;
    } else if (!isSuppressed(preference, Date.parse(parsed), snapshot.version)) {
      if (visible?.version === snapshot.version) {
        preference.snapshotPresentedSince = parsedSince;
      } else if (preference.snapshotPresentedSince && preference.snapshotPresentedSince !== parsedSince) {
        delete preference.suppressedThroughRowId;
        delete preference.snapshot;
        delete preference.snapshotPresentedSince;
      }
    }
    if (preference.snoozedUntil && Date.parse(preference.snoozedUntil) <= Date.parse(parsed)) {
      delete preference.snoozedUntil;
    }
    if (!preference.pinned && !preference.snoozedUntil && !preference.dismissedAt && !preference.snapshot) {
      delete preferences.items[id];
    }
  }
  preferences.lastVisitedAt = parsed;
  preferences.lastVisitedRowId = parsedRowId;
  persistPreferences(db, preferences);
  return parsed;
}

export function isValidTodayItemId(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 220) return false;
  return /^(project|change):[A-Za-z0-9._-]{1,128}$/.test(value)
    || /^(task|blocker):[A-Za-z0-9._-]{1,128}:[a-f0-9]{18}$/.test(value);
}

/**
 * Mark a brain task done directly from Today. This is an explicit owner
 * action, so it edits the project brain itself (read-modify-write of the
 * current on-disk state, so concurrent manual edits are preserved). Returns
 * the completed task text, or null when the task no longer exists.
 */
export function completeTodayTask(
  db: Database.Database,
  brainStore: BrainStore,
  itemId: string,
): { projectId: string; taskText: string } | null {
  const match = /^task:([A-Za-z0-9._-]{1,128}):[a-f0-9]{18}$/.exec(itemId);
  if (!match) return null;
  const projectId = match[1];
  const brain = brainStore.read(projectId);
  if (!brain) return null;
  const task = brain.tasks.find(candidate =>
    candidate.state !== 'done' && stableItemId('task', projectId, candidate.text) === itemId);
  if (!task) return null;
  task.state = 'done';
  brainStore.write(
    { ...brain, updated: new Date().toISOString() },
    brainStore.getProject(projectId)?.one_liner ?? undefined,
  );
  // Completed work no longer needs deferral state; an explicit pin survives.
  applyTodayItemAction(db, itemId, 'restore');
  return { projectId, taskText: task.text };
}
