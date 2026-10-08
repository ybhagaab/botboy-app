/**
 * Chat jobs: the owner's request that BotBoy is working on, and the ETL runs
 * it is waiting for (ANALYTICS_AUTONOMY_PLAN.md, owner decisions D1/D2,
 * 2026-10-08).
 *
 * A job is the authority for continuation turns: the owner asked once, and
 * BotBoy keeps taking the job's steps (including after an ETL run finishes
 * when no turn is open) until the job is done, blocked, stopped, or idle for
 * 24 hours. One job is active at a time; the chat has one conversation.
 *
 * The store is plain SQL over the tracker database, so every instance on one
 * database sees the same state. It never decides what a step may do; the
 * mandate gate (job-mandate.ts) does.
 */
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import type Database from 'better-sqlite3';

export type ChatJobStatus = 'active' | 'done' | 'stopped' | 'expired' | 'blocked';
export type ChatJobThinking = 'off' | 'low' | 'high' | 'max';
export type EtlWatchStatus = 'pending' | 'finished' | 'abandoned';

/** A job with no owner or continuation turn for this long expires. */
export const CHAT_JOB_IDLE_MS = 24 * 60 * 60_000;
/** Automatic continuations per job before BotBoy pauses and asks. */
export const CHAT_JOB_MAX_CONTINUATIONS = 25;

const MAX_GOAL_CHARS = 4_000;
const MAX_NOTES = 12;
const MAX_NOTE_CHARS = 300;
const MAX_LIST = 20;

export interface ChatJobWorkingSet {
  nextStep?: string;
  notes: string[];
  files: Array<{ path: string; label?: string; at: string }>;
  datasets: Array<{ datasetId?: string; versionId?: string; jobId?: string; title?: string; at: string }>;
  dashboards: Array<{ dashboardId: string; title?: string; at: string }>;
}

export interface ChatJob {
  id: string;
  goal: string;
  status: ChatJobStatus;
  modelKey?: string;
  thinking: ChatJobThinking;
  workingSet: ChatJobWorkingSet;
  continuationCount: number;
  createdAt: string;
  lastActivityAt: string;
  endedAt?: string;
  endReason?: string;
}

/** What a finished run produced, as the continuation turn reports it. */
export interface EtlRunOutcome {
  remoteStatus: string;
  savedTo?: string;
  rowCount?: number;
  columns?: string[];
  truncated?: boolean;
  resultBytes?: number;
  error?: string;
}

export interface EtlRunWatch {
  runId: string;
  jobId: string;
  purpose?: string;
  source: 'run_query' | 'wait';
  status: EtlWatchStatus;
  remoteStatus?: string;
  submittedAt: string;
  lastPolledAt?: string;
  finishedAt?: string;
  outcome?: EtlRunOutcome;
  consumedAt?: string;
  pollFailures: number;
  /** When the one queue rescue (PRIORITIZE) ran, by runQuery or the watcher. */
  prioritizedAt?: string;
}

export interface ChatJobStore {
  activeJob(): ChatJob | null;
  get(jobId: string): ChatJob | null;
  /** Starts a job; an active one ends as done (replaced). */
  start(input: { goal: string; modelKey?: string; thinking?: ChatJobThinking }): ChatJob;
  /** The active job, or a new one for this goal. */
  ensureActive(input: { goal: string; modelKey?: string; thinking?: ChatJobThinking }): ChatJob;
  /** Records activity; an owner turn also records its model and thinking (D4). */
  touch(jobId: string, input?: { modelKey?: string; thinking?: ChatJobThinking }): void;
  update(jobId: string, input: { goal?: string; nextStep?: string; notes?: string[] }): ChatJob | null;
  end(jobId: string, status: Exclude<ChatJobStatus, 'active'>, reason: string): ChatJob | null;
  incrementContinuations(jobId: string): number;
  /** Expires idle jobs; returns their ids. */
  expireIdle(nowMs?: number): string[];
  recordFile(jobId: string, filePath: string, label?: string): void;
  recordDataset(jobId: string, entry: { datasetId?: string; versionId?: string; jobId?: string; title?: string }): void;
  recordDashboard(jobId: string, entry: { dashboardId: string; title?: string }): void;
  addWatch(input: { runId: string; jobId: string; purpose?: string; source: EtlRunWatch['source'] }): EtlRunWatch;
  watch(runId: string): EtlRunWatch | null;
  watchesForJob(jobId: string): EtlRunWatch[];
  pendingWatches(): EtlRunWatch[];
  markPolled(runId: string, input: { remoteStatus?: string; failed?: boolean }): void;
  finishWatch(runId: string, outcome: EtlRunOutcome): void;
  /** Records the run's one queue rescue; false when it already ran. */
  markPrioritized(runId: string): boolean;
  /** A turn (owner or continuation) has seen this run's outcome. */
  consumeWatch(runId: string): void;
  unconsumedFinished(jobId: string): EtlRunWatch[];
  isJobRun(jobId: string, runId: string): boolean;
  /** Bumped on every change; the chat panel polls it. */
  version(): number;
}

function nowIso(nowMs = Date.now()): string {
  return new Date(nowMs).toISOString();
}

function clip(value: unknown, max: number): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function emptyWorkingSet(): ChatJobWorkingSet {
  return { notes: [], files: [], datasets: [], dashboards: [] };
}

function parseWorkingSet(raw: unknown): ChatJobWorkingSet {
  try {
    const value = JSON.parse(String(raw ?? '{}'));
    return {
      ...(typeof value.nextStep === 'string' && value.nextStep ? { nextStep: value.nextStep } : {}),
      notes: Array.isArray(value.notes) ? value.notes.filter((note: unknown) => typeof note === 'string') : [],
      files: Array.isArray(value.files) ? value.files : [],
      datasets: Array.isArray(value.datasets) ? value.datasets : [],
      dashboards: Array.isArray(value.dashboards) ? value.dashboards : [],
    };
  } catch {
    return emptyWorkingSet();
  }
}

function thinkingOf(value: unknown): ChatJobThinking {
  return value === 'low' || value === 'high' || value === 'max' ? value : 'off';
}

export function createChatJobStore(db: Database.Database): ChatJobStore {
  db.exec(`
    CREATE TABLE IF NOT EXISTS chat_jobs (
      id TEXT PRIMARY KEY CHECK(id GLOB 'cj_[a-f0-9]*' AND length(id) = 27),
      goal TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('active','done','stopped','expired','blocked')),
      model_key TEXT,
      thinking TEXT NOT NULL DEFAULT 'off',
      working_set_json TEXT NOT NULL DEFAULT '{}',
      continuation_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      last_activity_at TEXT NOT NULL,
      ended_at TEXT,
      end_reason TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_chat_jobs_status ON chat_jobs(status, last_activity_at);
    CREATE TABLE IF NOT EXISTS etl_run_watches (
      run_id TEXT PRIMARY KEY CHECK(run_id GLOB '[0-9]*' AND length(run_id) BETWEEN 1 AND 32),
      job_id TEXT NOT NULL REFERENCES chat_jobs(id) ON DELETE CASCADE,
      purpose TEXT,
      source TEXT NOT NULL CHECK(source IN ('run_query','wait')),
      status TEXT NOT NULL CHECK(status IN ('pending','finished','abandoned')),
      remote_status TEXT,
      submitted_at TEXT NOT NULL,
      last_polled_at TEXT,
      finished_at TEXT,
      outcome_json TEXT,
      consumed_at TEXT,
      poll_failures INTEGER NOT NULL DEFAULT 0,
      prioritized_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_etl_run_watches_job ON etl_run_watches(job_id, status);
  `);
  // Stores created by the first build of this table (2026-10-08) lack the column.
  const watchColumns = (db.prepare('PRAGMA table_info(etl_run_watches)').all() as Array<{ name: string }>).map(column => column.name);
  if (!watchColumns.includes('prioritized_at')) db.exec('ALTER TABLE etl_run_watches ADD COLUMN prioritized_at TEXT');

  let changeVersion = 0;
  const changed = () => { changeVersion += 1; };

  const selectActive = db.prepare("SELECT * FROM chat_jobs WHERE status = 'active' ORDER BY last_activity_at DESC LIMIT 1");
  const selectJob = db.prepare('SELECT * FROM chat_jobs WHERE id = ?');
  const insertJob = db.prepare(`INSERT INTO chat_jobs (id, goal, status, model_key, thinking, working_set_json, created_at, last_activity_at)
    VALUES (?, ?, 'active', ?, ?, '{}', ?, ?)`);
  const selectWatch = db.prepare('SELECT * FROM etl_run_watches WHERE run_id = ?');

  function rowToJob(row: any): ChatJob | null {
    if (!row) return null;
    return {
      id: row.id,
      goal: row.goal,
      status: row.status,
      ...(row.model_key ? { modelKey: row.model_key } : {}),
      thinking: thinkingOf(row.thinking),
      workingSet: parseWorkingSet(row.working_set_json),
      continuationCount: Number(row.continuation_count) || 0,
      createdAt: row.created_at,
      lastActivityAt: row.last_activity_at,
      ...(row.ended_at ? { endedAt: row.ended_at } : {}),
      ...(row.end_reason ? { endReason: row.end_reason } : {}),
    };
  }

  function rowToWatch(row: any): EtlRunWatch | null {
    if (!row) return null;
    let outcome: EtlRunOutcome | undefined;
    try { outcome = row.outcome_json ? JSON.parse(row.outcome_json) : undefined; } catch { outcome = undefined; }
    return {
      runId: row.run_id,
      jobId: row.job_id,
      ...(row.purpose ? { purpose: row.purpose } : {}),
      source: row.source,
      status: row.status,
      ...(row.remote_status ? { remoteStatus: row.remote_status } : {}),
      submittedAt: row.submitted_at,
      ...(row.last_polled_at ? { lastPolledAt: row.last_polled_at } : {}),
      ...(row.finished_at ? { finishedAt: row.finished_at } : {}),
      ...(outcome ? { outcome } : {}),
      ...(row.consumed_at ? { consumedAt: row.consumed_at } : {}),
      pollFailures: Number(row.poll_failures) || 0,
      ...(row.prioritized_at ? { prioritizedAt: row.prioritized_at } : {}),
    };
  }

  function abandonWatches(jobId: string): void {
    db.prepare("UPDATE etl_run_watches SET status = 'abandoned' WHERE job_id = ? AND status = 'pending'").run(jobId);
  }

  function endJob(jobId: string, status: Exclude<ChatJobStatus, 'active'>, reason: string): ChatJob | null {
    const ended = db.transaction(() => {
      const result = db.prepare(`UPDATE chat_jobs SET status = ?, ended_at = ?, end_reason = ?
        WHERE id = ? AND status = 'active'`).run(status, nowIso(), clip(reason, 200), jobId);
      if (result.changes) abandonWatches(jobId);
      return result.changes > 0;
    })();
    if (ended) changed();
    return rowToJob(selectJob.get(jobId));
  }

  function mutateWorkingSet(jobId: string, mutate: (set: ChatJobWorkingSet) => void): void {
    const job = rowToJob(selectJob.get(jobId));
    if (!job) return;
    const set = job.workingSet;
    mutate(set);
    db.prepare('UPDATE chat_jobs SET working_set_json = ? WHERE id = ?').run(JSON.stringify(set), jobId);
    changed();
  }

  function start(input: { goal: string; modelKey?: string; thinking?: ChatJobThinking }): ChatJob {
    const goal = String(input.goal ?? '').trim().slice(0, MAX_GOAL_CHARS) || 'Owner request';
    const id = `cj_${randomBytes(12).toString('hex')}`;
    const at = nowIso();
    db.transaction(() => {
      const current = selectActive.get() as any;
      if (current) {
        db.prepare(`UPDATE chat_jobs SET status = 'done', ended_at = ?, end_reason = 'replaced by a new job'
          WHERE id = ?`).run(at, current.id);
        abandonWatches(current.id);
      }
      insertJob.run(id, goal, input.modelKey ?? null, thinkingOf(input.thinking), at, at);
    })();
    changed();
    return rowToJob(selectJob.get(id))!;
  }

  return {
    activeJob: () => rowToJob(selectActive.get()),
    get: (jobId) => rowToJob(selectJob.get(jobId)),
    start,
    ensureActive(input) {
      return rowToJob(selectActive.get()) ?? start(input);
    },
    touch(jobId, input = {}) {
      const sets = ['last_activity_at = ?'];
      const values: unknown[] = [nowIso()];
      if (input.modelKey !== undefined) { sets.push('model_key = ?'); values.push(input.modelKey || null); }
      if (input.thinking !== undefined) { sets.push('thinking = ?'); values.push(thinkingOf(input.thinking)); }
      const result = db.prepare(`UPDATE chat_jobs SET ${sets.join(', ')} WHERE id = ? AND status = 'active'`).run(...values, jobId);
      if (result.changes) changed();
    },
    update(jobId, input) {
      const job = rowToJob(selectJob.get(jobId));
      if (!job || job.status !== 'active') return job;
      const goal = input.goal !== undefined ? String(input.goal).trim().slice(0, MAX_GOAL_CHARS) : undefined;
      if (goal) db.prepare('UPDATE chat_jobs SET goal = ? WHERE id = ?').run(goal, jobId);
      mutateWorkingSet(jobId, (set) => {
        if (input.nextStep !== undefined) {
          const next = clip(input.nextStep, 600);
          if (next) set.nextStep = next; else delete set.nextStep;
        }
        for (const note of input.notes ?? []) {
          const text = clip(note, MAX_NOTE_CHARS);
          if (text && !set.notes.includes(text)) set.notes.push(text);
        }
        if (set.notes.length > MAX_NOTES) set.notes = set.notes.slice(-MAX_NOTES);
      });
      db.prepare('UPDATE chat_jobs SET last_activity_at = ? WHERE id = ?').run(nowIso(), jobId);
      return rowToJob(selectJob.get(jobId));
    },
    end: endJob,
    incrementContinuations(jobId) {
      db.prepare('UPDATE chat_jobs SET continuation_count = continuation_count + 1, last_activity_at = ? WHERE id = ?')
        .run(nowIso(), jobId);
      changed();
      return Number((selectJob.get(jobId) as any)?.continuation_count) || 0;
    },
    expireIdle(nowMs = Date.now()) {
      const cutoff = nowIso(nowMs - CHAT_JOB_IDLE_MS);
      const idle = db.prepare("SELECT id FROM chat_jobs WHERE status = 'active' AND last_activity_at < ?").all(cutoff) as Array<{ id: string }>;
      for (const { id } of idle) endJob(id, 'expired', 'idle for 24 hours');
      return idle.map(row => row.id);
    },
    recordFile(jobId, filePath, label) {
      const clean = clip(filePath, 1_000);
      if (!clean) return;
      mutateWorkingSet(jobId, (set) => {
        set.files = set.files.filter(file => file.path !== clean);
        set.files.push({ path: clean, ...(label ? { label: clip(label, 160) } : {}), at: nowIso() });
        if (set.files.length > MAX_LIST) set.files = set.files.slice(-MAX_LIST);
      });
    },
    recordDataset(jobId, entry) {
      if (!entry.datasetId && !entry.jobId) return;
      mutateWorkingSet(jobId, (set) => {
        set.datasets = set.datasets.filter(dataset => !(
          (entry.datasetId && dataset.datasetId === entry.datasetId)
          || (!entry.datasetId && entry.jobId && dataset.jobId === entry.jobId && !dataset.datasetId)
        ));
        set.datasets.push({
          ...(entry.datasetId ? { datasetId: entry.datasetId } : {}),
          ...(entry.versionId ? { versionId: entry.versionId } : {}),
          ...(entry.jobId ? { jobId: entry.jobId } : {}),
          ...(entry.title ? { title: clip(entry.title, 160) } : {}),
          at: nowIso(),
        });
        if (set.datasets.length > MAX_LIST) set.datasets = set.datasets.slice(-MAX_LIST);
      });
    },
    recordDashboard(jobId, entry) {
      if (!entry.dashboardId) return;
      mutateWorkingSet(jobId, (set) => {
        const previous = set.dashboards.find(dashboard => dashboard.dashboardId === entry.dashboardId);
        set.dashboards = set.dashboards.filter(dashboard => dashboard.dashboardId !== entry.dashboardId);
        const title = entry.title ? clip(entry.title, 160) : previous?.title;
        set.dashboards.push({ dashboardId: entry.dashboardId, ...(title ? { title } : {}), at: nowIso() });
        if (set.dashboards.length > MAX_LIST) set.dashboards = set.dashboards.slice(-MAX_LIST);
      });
    },
    addWatch(input) {
      const runId = String(input.runId ?? '').trim();
      if (!/^\d{1,32}$/.test(runId)) throw new Error('ETL run id must be numeric');
      // A run belongs to the job that first watched it; a later watch only
      // fills a missing purpose. A watch abandoned with an ended job moves to
      // the job that watches it again.
      db.prepare(`INSERT INTO etl_run_watches (run_id, job_id, purpose, source, status, submitted_at)
        VALUES (?, ?, ?, ?, 'pending', ?)
        ON CONFLICT(run_id) DO UPDATE SET
          purpose = COALESCE(etl_run_watches.purpose, excluded.purpose),
          job_id = CASE WHEN etl_run_watches.status = 'abandoned' THEN excluded.job_id ELSE etl_run_watches.job_id END,
          status = CASE WHEN etl_run_watches.status = 'abandoned' THEN 'pending' ELSE etl_run_watches.status END,
          poll_failures = CASE WHEN etl_run_watches.status = 'abandoned' THEN 0 ELSE etl_run_watches.poll_failures END`)
        .run(runId, input.jobId, input.purpose ? clip(input.purpose, 300) : null, input.source, nowIso());
      db.prepare('UPDATE chat_jobs SET last_activity_at = ? WHERE id = ?').run(nowIso(), input.jobId);
      changed();
      return rowToWatch(selectWatch.get(runId))!;
    },
    watch: (runId) => rowToWatch(selectWatch.get(String(runId ?? '').trim())),
    watchesForJob: (jobId) => (db.prepare('SELECT * FROM etl_run_watches WHERE job_id = ? ORDER BY submitted_at, run_id').all(jobId) as any[])
      .map(row => rowToWatch(row)!),
    pendingWatches: () => (db.prepare(`SELECT w.* FROM etl_run_watches w JOIN chat_jobs j ON j.id = w.job_id
      WHERE w.status = 'pending' AND j.status = 'active' ORDER BY w.submitted_at, w.run_id`).all() as any[])
      .map(row => rowToWatch(row)!),
    markPolled(runId, input) {
      db.prepare(`UPDATE etl_run_watches SET last_polled_at = ?,
          remote_status = COALESCE(?, remote_status),
          poll_failures = poll_failures + ?
        WHERE run_id = ? AND status = 'pending'`)
        .run(nowIso(), input.remoteStatus ? clip(input.remoteStatus, 40) : null, input.failed ? 1 : 0, runId);
    },
    finishWatch(runId, outcome) {
      const result = db.prepare(`UPDATE etl_run_watches SET status = 'finished', remote_status = ?, finished_at = ?,
          last_polled_at = ?, outcome_json = ?
        WHERE run_id = ? AND status = 'pending'`)
        .run(clip(outcome.remoteStatus, 40), nowIso(), nowIso(), JSON.stringify({
          ...outcome,
          ...(outcome.error ? { error: clip(outcome.error, 800) } : {}),
          ...(outcome.columns ? { columns: outcome.columns.slice(0, 60).map(column => clip(column, 80)) } : {}),
        }), runId);
      if (result.changes) changed();
    },
    markPrioritized(runId) {
      const result = db.prepare('UPDATE etl_run_watches SET prioritized_at = ? WHERE run_id = ? AND prioritized_at IS NULL').run(nowIso(), runId);
      return result.changes > 0;
    },
    consumeWatch(runId) {
      const result = db.prepare('UPDATE etl_run_watches SET consumed_at = ? WHERE run_id = ? AND consumed_at IS NULL').run(nowIso(), runId);
      if (result.changes) changed();
    },
    unconsumedFinished: (jobId) => (db.prepare(`SELECT * FROM etl_run_watches
      WHERE job_id = ? AND status = 'finished' AND consumed_at IS NULL ORDER BY finished_at, run_id`).all(jobId) as any[])
      .map(row => rowToWatch(row)!),
    isJobRun: (jobId, runId) => Boolean(db.prepare('SELECT 1 FROM etl_run_watches WHERE job_id = ? AND run_id = ?')
      .get(jobId, String(runId ?? '').trim())),
    version: () => changeVersion,
  };
}

function describeOutcome(watch: EtlRunWatch): string {
  const outcome = watch.outcome;
  if (watch.status === 'pending') return `running (${watch.remoteStatus ?? 'submitted'})`;
  if (watch.status === 'abandoned') return 'no longer watched';
  if (!outcome) return 'finished';
  if (outcome.remoteStatus === 'SUCCESS' && outcome.savedTo) {
    const rows = outcome.rowCount !== undefined ? `${outcome.rowCount} rows` : 'rows';
    return `SUCCESS — ${rows}${outcome.columns?.length ? `, ${outcome.columns.length} columns` : ''}, saved to ${outcome.savedTo}`;
  }
  return `${outcome.remoteStatus}${outcome.error ? ` — ${outcome.error}` : ''}`;
}

/** Path relative to the files workspace when it is inside it (what run_command sees). */
export function workspaceRelativePath(filePath: string, filesDir: string): string {
  const relative = path.relative(filesDir, filePath);
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? relative : filePath;
}

/**
 * The job block every owner and continuation turn carries: the owner's goal,
 * what the mandate covers, and the working set. Bounded to about 4K chars.
 */
export function formatChatJobBlock(job: ChatJob, watches: EtlRunWatch[], options: { continuation?: boolean } = {}): string {
  const lines: string[] = [
    '## ACTIVE JOB',
    `The owner asked for this, and BotBoy is working on it: "${clip(job.goal, 1_200)}"`,
    `Started ${job.createdAt}; ${job.continuationCount} automatic continuation(s) so far.`,
    options.continuation
      ? 'This turn is an AUTOMATIC CONTINUATION: no owner message started it. The owner\'s request above is your authority, so set ownerRequested=true for the job\'s steps. Take them (data reads, SQL, scratch ETL queries and their fixes, Data Room imports, BotBoy dashboards, files, checks). Tools that send, post, publish, sync, schedule, or change production return outside_job_mandate here: finish what you can and say what needs the owner\'s go-ahead.'
      : 'The owner\'s request above authorizes every analytics step of this job, in this turn and later ones: a short "check", "continue", or "go ahead" means resume the job, not ask again. Set ownerRequested=true for job steps. If the owner\'s new message asks for something different, it is a new job: call job_update with action "start".',
  ];
  const set = job.workingSet;
  if (set.nextStep) lines.push(`Next step (your note): ${set.nextStep}`);
  if (set.notes.length) lines.push('Decisions and notes:', ...set.notes.map(note => `- ${note}`));
  if (watches.length) {
    lines.push('ETL runs in this job:');
    for (const watch of watches.slice(-12)) {
      lines.push(`- ${watch.runId}${watch.purpose ? ` (${clip(watch.purpose, 120)})` : ''}: ${describeOutcome(watch)}`);
    }
  }
  if (set.files.length) lines.push('Files:', ...set.files.slice(-10).map(file => `- ${file.path}${file.label ? ` — ${file.label}` : ''}`));
  if (set.datasets.length) {
    lines.push('Data Room:', ...set.datasets.slice(-8).map(dataset => `- ${[dataset.title, dataset.datasetId, dataset.versionId, dataset.jobId].filter(Boolean).join(' · ')}`));
  }
  if (set.dashboards.length) {
    lines.push('Dashboards:', ...set.dashboards.slice(-8).map(dashboard => `- ${dashboard.dashboardId}${dashboard.title ? ` — ${dashboard.title}` : ''}`));
  }
  lines.push('Keep the working set current with job_update (next step, decisions). When the deliverable is verified, call job_update with action "done"; when only the owner can unblock it, action "blocked".');
  return lines.join('\n').slice(0, 4_500);
}

function parseJsonObject(text: string): any {
  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' ? value : undefined;
  } catch {
    return undefined;
  }
}

/** The inner payload of an MCP/ETL envelope ({trust, result: "<json>"}), or the value itself. */
function unwrapEnvelope(value: any): any {
  if (value && typeof value.result === 'string') return parseJsonObject(value.result) ?? value;
  return value;
}

/**
 * Records what a finished tool call produced into the job's working set:
 * downloaded files, Data Room datasets/jobs, and dashboards. Defensive: an
 * unrecognized result shape records nothing.
 */
export function recordToolOutcome(store: ChatJobStore, jobId: string, toolName: string, argsJson: string, resultContent: string): void {
  const result = unwrapEnvelope(parseJsonObject(resultContent));
  if (!result) return;
  const args = parseJsonObject(argsJson) ?? {};
  if ((toolName === 'mcp_etl_download_results' || toolName === 'mcp_etl_run_query' || toolName === 'wait_for_etl_run')
    && typeof result.savedTo === 'string') {
    store.recordFile(jobId, result.savedTo, result.runId ? `ETL run ${result.runId}` : undefined);
    return;
  }
  if (toolName === 'create_data_room_dataset' && args.action !== 'inspect_local_file' && args.action !== 'derive_semantic_hashes') {
    const datasetId = typeof result.datasetId === 'string' ? result.datasetId
      : typeof result.dataset?.id === 'string' ? result.dataset.id
        : typeof result.result?.datasetId === 'string' ? result.result.datasetId : undefined;
    const versionId = typeof result.versionId === 'string' ? result.versionId
      : typeof result.version?.id === 'string' ? result.version.id
        : typeof result.result?.versionId === 'string' ? result.result.versionId : undefined;
    const analyticsJobId = typeof result.jobId === 'string' && /^aj_[a-f0-9]{32}$/.test(result.jobId) ? result.jobId : undefined;
    const title = typeof result.dataset?.title === 'string' ? result.dataset.title : undefined;
    if (datasetId || analyticsJobId) store.recordDataset(jobId, { datasetId, versionId, jobId: analyticsJobId, title });
    return;
  }
  if (toolName === 'create_analytics_dashboard' || toolName === 'update_analytics_dashboard' || toolName === 'edit_analytics_dashboard') {
    const dashboard = result.dashboard && typeof result.dashboard === 'object' ? result.dashboard : result;
    const dashboardId = typeof dashboard.id === 'string' && dashboard.id.startsWith('dash_') ? dashboard.id
      : typeof args.dashboardId === 'string' && args.dashboardId.startsWith('dash_') && result.ok !== false ? args.dashboardId : undefined;
    if (dashboardId) store.recordDashboard(jobId, { dashboardId, title: typeof dashboard.title === 'string' ? dashboard.title : undefined });
  }
}
