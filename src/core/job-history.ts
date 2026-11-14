/**
 * The job history page's rows (docs/maps/job-history.md). Owner job (2026-11-14): "a page where job history can be found …
 * keep them forever, can have output, but add these details aesthetically & in a low cognitive load manner".
 *
 * One row per job the owner saw (ChatJobStore.history), each with: what he asked, how it ended, a short summary of what it
 * found, and the things it made, each verified to still exist and openable with one click. Read-only: nothing here writes.
 *
 * Outputs come from two places, both checked against BotBoy's own stores before they are shown:
 *   - the job's working set, recorded from its tool results as they happened (recordToolOutcome): files, datasets,
 *     dashboards, documents and Google Drive files;
 *   - the BotBoy links and ids in the job's own words (its thread, its report, its end reason), so jobs from before outputs
 *     were recorded still show what they made. A thing named only in words counts as made by the job only when it was
 *     created after the job started: anything older is something the job read or referred to.
 */
import type Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { CHAT_JOB_FOLDED_REASON, type ChatJob, type ChatJobHistoryStatus, type ChatJobStore } from './chat-jobs.js';

export type JobOutputKind = 'document' | 'dashboard' | 'dataset' | 'file' | 'drive';

export interface JobOutput {
  kind: JobOutputKind;
  /**
   * `made`: something to open and use (a document, dashboard, dataset, Drive file, or a file the job wrote). `data`: a raw
   * query result the job pulled on the way (files/etl-results, files/sql-exports); the page folds these into one line.
   */
  group: 'made' | 'data';
  title: string;
  /** What it is, in a word or two ("Document", "Dashboard · updated", "Table (CSV)", "Google Doc"). */
  detail: string;
  /** Where it opens: a BotBoy route (`#/…`), a BotBoy file (`/api/files/…`) or Google's https link. Absent: nothing to open. */
  href?: string;
  /** Opens outside BotBoy (a new tab). */
  external?: boolean;
}

export type JobHistoryState = 'running' | 'needs_you' | 'done' | 'stopped' | 'expired';

export interface JobHistoryRow {
  id: string;
  /** #N; null for jobs from before numbers. */
  number: number | null;
  title: string;
  /** The owner's own words. */
  goal: string;
  state: JobHistoryState;
  startedAt: string;
  endedAt: string | null;
  /** How the job ended when it did not simply finish ("You stopped it"); null otherwise. */
  ending: string | null;
  /** What the job found or did, in its own closing words (Markdown); null when nothing was kept. */
  summary: string | null;
  /** Made outputs first, then data files, newest first within each; at most OUTPUTS_SHOWN made and DATA_SHOWN data. */
  outputs: JobOutput[];
  /** Outputs beyond the ones shown, per group. */
  moreOutputs: { made: number; data: number };
  model: string | null;
  /** The job has its own thread to open (jobs since 2026-10-29). */
  hasThread: boolean;
}

export interface JobHistoryPage {
  jobs: JobHistoryRow[];
  next?: string;
  counts: { all: number; done: number; stopped: number };
}

export interface JobHistory {
  page(input?: { query?: string; status?: ChatJobHistoryStatus; before?: string; limit?: number }): JobHistoryPage;
}

const OUTPUTS_SHOWN = 8;
const DATA_SHOWN = 12;
/** Folders of the files workspace that hold raw query results, not deliverables. */
const DATA_FOLDERS = new Set(['etl-results', 'sql-exports']);
const SUMMARY_CHARS = 2_400;
/** A thing named in the job's words made by the job: created at most this long before the job's start (clock skew). */
const MADE_SLACK_MS = 2 * 60_000;
/** End reasons that say how a job ended, not what it found (chat-jobs.ts end paths). */
const ENDINGS: Record<string, { state?: JobHistoryState; text: string }> = {
  'stopped by the owner': { text: 'You stopped it' },
  'replaced by a new job': { state: 'stopped', text: 'Replaced by a newer job' },
  'idle for 24 hours': { text: 'Ended after a day with nothing to do' },
  [CHAT_JOB_FOLDED_REASON]: { text: 'Answered in the main chat' },
};

const DOC_LINK_RE = /#\/documents\/([A-Za-z0-9_%.-]{6,200})/g;
const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g;
const DASHBOARD_RE = /\bdash_[a-f0-9]{8,40}\b/g;
const DATASET_RE = /\bds_[A-Za-z0-9_]{6,80}\b/g;
const FILE_LINK_RE = /\/api\/files\/([^\s)"'<>\]]{1,400})/g;
/** Chat card markers ([[job-card:…]], [[lesson:…]], …) are drawn by the chat panel; in a summary they are noise. */
const MARKER_RE = /\[\[[a-z][a-z-]{1,30}:[^\]\n]{1,200}\]\]/g;
/** The first line of an automatic turn says why it ran ("↻ Continued automatically: …"); the work starts after it. */
const NOTE_LINE_RE = /^(?:↻|↪|▶)[^\n]*\n+/;

/** SQLite's `datetime('now')` (UTC, no zone) or ISO text, as milliseconds; NaN when unreadable. */
export function storedTimeMs(value: unknown): number {
  const text = String(value ?? '').trim();
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?$/.test(text)) return Date.parse(`${text.replace(' ', 'T')}Z`);
  return Date.parse(text);
}

/** A job's words as the summary shows them: no card markers, no automatic-turn note line, bounded. */
export function summaryText(raw: unknown): string | null {
  const text = String(raw ?? '').replace(/\r\n?/g, '\n').replace(MARKER_RE, '').replace(NOTE_LINE_RE, '').replace(/\n{3,}/g, '\n\n').trim();
  if (!text) return null;
  if (text.length <= SUMMARY_CHARS) return text;
  const cut = text.slice(0, SUMMARY_CHARS);
  const paragraph = cut.lastIndexOf('\n\n');
  return `${(paragraph > SUMMARY_CHARS / 2 ? cut.slice(0, paragraph) : cut).trimEnd()}\n\n…`;
}

const FILE_KINDS: Array<[RegExp, string]> = [
  [/\.(csv|tsv|tab)$/i, 'Table'],
  [/\.html?$/i, 'Web page'],
  [/\.xlsx?$/i, 'Spreadsheet'],
  [/\.md$/i, 'Markdown'],
  [/\.docx?$/i, 'Word document'],
  [/\.pdf$/i, 'PDF'],
  [/\.(png|jpe?g|gif|webp|svg)$/i, 'Picture'],
  [/\.json$/i, 'Data file'],
  [/\.(txt|log)$/i, 'Text file'],
];
function fileDetail(name: string): string {
  return FILE_KINDS.find(([pattern]) => pattern.test(name))?.[1] ?? 'File';
}

const DRIVE_KINDS: Record<string, string> = {
  doc: 'Google Doc', sheet: 'Google Sheet', slides: 'Google Slides', deck: 'Google Slides', form: 'Google Form',
  folder: 'Drive folder', pdf: 'PDF in Drive', image: 'Picture in Drive',
};

function decodePathPart(value: string): string {
  try { return decodeURIComponent(value); } catch { return value; }
}

export function createJobHistory(deps: {
  db: Database.Database;
  jobs: ChatJobStore;
  /** The files workspace BotBoy serves at /api/files (~/.personal-productivity-tracker/files). */
  filesDir: string;
  /** Live phase of an active job (chat.ts › jobPhaseOf): `needs_owner` and `stuck` read as needing the owner. */
  phaseOf?: (job: ChatJob) => string | null;
  modelTitle?: (modelKey?: string) => string | undefined;
}): JobHistory {
  const { db } = deps;
  const threadRows = db.prepare(`SELECT content FROM chat_messages WHERE job_id = ? AND role = 'assistant' ORDER BY created_at DESC, rowid DESC LIMIT 40`);
  // Main-chat rows about the job: its report posted there, and older cards. Decision notes ("↻ Job update", "↪ …") are not its words.
  const mainRows = db.prepare(`SELECT content FROM chat_messages WHERE ref_job_id = ? AND role = 'assistant' ORDER BY created_at DESC, rowid DESC LIMIT 20`);
  const hasThreadRow = db.prepare('SELECT 1 FROM chat_messages WHERE job_id = ? LIMIT 1');
  // Documents, dashboards and datasets live in tables their own services create: until one exists, it has no rows to show.
  const lookup = (sql: string) => {
    let statement: Database.Statement | null = null;
    return { get(id: string): unknown {
      if (!statement) {
        try { statement = db.prepare(sql); } catch { return undefined; }
      }
      try { return statement.get(id); } catch { return undefined; }
    } };
  };
  const documentRow = lookup('SELECT artifact_id, title, parent_artifact_id, created_at FROM product_document_artifacts WHERE artifact_id = ?');
  const dashboardRow = lookup('SELECT id, title, created_at FROM analytics_dashboards WHERE id = ?');
  const datasetRow = lookup('SELECT id, name, created_at FROM analytics_datasets WHERE id = ?');
  let filesRoot: string | null | undefined;
  const filesRootReal = (): string | null => {
    if (filesRoot === undefined) {
      try { filesRoot = fs.realpathSync.native(deps.filesDir); } catch { filesRoot = null; }
    }
    return filesRoot;
  };

  /** A file inside the files workspace that still exists, as its /api/files link; anything else is not shown. */
  function workspaceFile(candidate: string): { name: string; href: string; createdMs: number; data: boolean } | null {
    const root = filesRootReal();
    if (!root) return null;
    const absolute = path.isAbsolute(candidate) ? candidate : path.join(deps.filesDir, candidate);
    let real: string;
    try { real = fs.realpathSync.native(absolute); } catch { return null; }
    const relative = path.relative(root, real);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return null;
    let stat: fs.Stats;
    try { stat = fs.statSync(real); } catch { return null; }
    if (!stat.isFile()) return null;
    return {
      name: path.basename(real),
      href: `/api/files/${relative.split(path.sep).map(encodeURIComponent).join('/')}`,
      createdMs: stat.birthtimeMs || stat.mtimeMs,
      data: DATA_FOLDERS.has(relative.split(path.sep)[0] ?? ''),
    };
  }

  /** The job's own words, newest first: its thread's replies, and the main chat's rows about it. */
  function messagesOf(job: ChatJob): { own: string[]; main: string[] } {
    return {
      own: (threadRows.all(job.id) as Array<{ content: string | null }>).map(row => row.content ?? ''),
      main: (mainRows.all(job.id) as Array<{ content: string | null }>).map(row => row.content ?? ''),
    };
  }

  function summaryOf(job: ChatJob, messages: { own: string[]; main: string[] }): string | null {
    if (job.report) return summaryText(job.report);
    const own = messages.own.map(summaryText).find(Boolean);
    if (own) return own;
    const main = messages.main.filter(text => !/^(?:↻ Job update|↪)/.test(text.trimStart())).map(summaryText).find(Boolean);
    if (main) return main;
    const reason = job.endReason?.trim();
    return reason && !ENDINGS[reason] ? summaryText(reason) : null;
  }

  function outputsOf(job: ChatJob, messages: { own: string[]; main: string[] }): { shown: JobOutput[]; more: { made: number; data: number } } {
    const startMs = storedTimeMs(job.createdAt);
    const madeHere = (createdAt: unknown) => {
      const created = storedTimeMs(createdAt);
      return Number.isFinite(created) && Number.isFinite(startMs) && created >= startMs - MADE_SLACK_MS;
    };
    const set = job.workingSet;
    const words = [job.report ?? '', job.endReason ?? '', ...messages.own, ...messages.main].join('\n');
    // Newest first: what the job recorded last is what it ended with.
    const outputs: Array<JobOutput & { key: string; at: number }> = [];
    const add = (output: Omit<JobOutput, 'group'> & { group?: JobOutput['group'] }, key: string, at: unknown) => {
      if (outputs.some(entry => entry.key === key)) return;
      outputs.push({ group: 'made', ...output, key, at: storedTimeMs(at) || 0 });
    };

    // Documents: recorded versions and every id the job's words name; an older version of another one shown is left out.
    const documentIds = new Map<string, { recorded: boolean; at: unknown }>();
    for (const doc of set.documents) documentIds.set(doc.artifactId, { recorded: true, at: doc.at });
    for (const match of words.matchAll(DOC_LINK_RE)) {
      const id = decodePathPart(match[1]);
      if (!documentIds.has(id)) documentIds.set(id, { recorded: false, at: null });
    }
    for (const match of words.matchAll(UUID_RE)) if (!documentIds.has(match[0])) documentIds.set(match[0], { recorded: false, at: null });
    const documents = new Map<string, { title: string; parent: string | null; createdAt: unknown; recorded: boolean; at: unknown }>();
    for (const [id, source] of documentIds) {
      const row = documentRow.get(id) as any;
      if (!row) continue;
      if (!source.recorded && !madeHere(row.created_at)) continue;
      documents.set(id, { title: row.title || 'Untitled document', parent: row.parent_artifact_id ?? null, createdAt: row.created_at, recorded: source.recorded, at: source.at ?? row.created_at });
    }
    const ancestors = new Set<string>();
    for (const [, doc] of documents) {
      let parent = doc.parent;
      for (let step = 0; parent && step < 40; step += 1) {
        ancestors.add(parent);
        parent = ((documentRow.get(parent) as any)?.parent_artifact_id as string | null) ?? null;
      }
    }
    for (const [id, doc] of documents) {
      if (ancestors.has(id)) continue;
      add({ kind: 'document', title: doc.title, detail: madeHere(doc.createdAt) ? 'Document' : 'Document · updated', href: `#/documents/${encodeURIComponent(id)}` }, `document:${id}`, doc.at);
    }

    // Dashboards: recorded ones (made or updated) and ones the words name that the job made.
    const dashboardIds = new Map<string, unknown>();
    for (const dashboard of set.dashboards) dashboardIds.set(dashboard.dashboardId, dashboard.at);
    for (const match of words.matchAll(DASHBOARD_RE)) if (!dashboardIds.has(match[0])) dashboardIds.set(match[0], null);
    for (const [id, recordedAt] of dashboardIds) {
      const row = dashboardRow.get(id) as any;
      if (!row) continue;
      const made = madeHere(row.created_at);
      if (recordedAt === null && !made) continue;
      add({ kind: 'dashboard', title: row.title || 'Dashboard', detail: made ? 'Dashboard' : 'Dashboard · updated', href: `#/dashboards/${encodeURIComponent(id)}` }, `dashboard:${id}`, recordedAt ?? row.created_at);
    }

    // Data Room datasets, the same way.
    const datasetIds = new Map<string, unknown>();
    for (const dataset of set.datasets) if (dataset.datasetId) datasetIds.set(dataset.datasetId, dataset.at);
    for (const match of words.matchAll(DATASET_RE)) if (!datasetIds.has(match[0])) datasetIds.set(match[0], null);
    for (const [id, recordedAt] of datasetIds) {
      const row = datasetRow.get(id) as any;
      if (!row) continue;
      const made = madeHere(row.created_at);
      if (recordedAt === null && !made) continue;
      add({ kind: 'dataset', title: row.name || 'Dataset', detail: made ? 'Dataset' : 'Dataset · updated', href: `#/data-room/${encodeURIComponent(id)}` }, `dataset:${id}`, recordedAt ?? row.created_at);
    }

    // Files in the files workspace: recorded ones, and /api/files links in the words to files created after the job started.
    for (const file of set.files) {
      const found = workspaceFile(file.path);
      if (found) add({ kind: 'file', group: found.data ? 'data' : 'made', title: found.name, detail: fileDetail(found.name), href: found.href }, `file:${found.href}`, file.at);
    }
    for (const match of words.matchAll(FILE_LINK_RE)) {
      const relative = match[1].split('/').map(decodePathPart).join('/');
      const found = workspaceFile(relative);
      if (!found || !(Number.isFinite(startMs) && found.createdMs >= startMs - MADE_SLACK_MS)) continue;
      add({ kind: 'file', group: found.data ? 'data' : 'made', title: found.name, detail: fileDetail(found.name), href: found.href }, `file:${found.href}`, found.createdMs);
    }

    // Google Drive files the job made (recorded only: a Drive link in words may be a file it read).
    for (const file of set.drive) {
      add({
        kind: 'drive',
        title: file.name || 'Drive file',
        detail: DRIVE_KINDS[file.kind ?? ''] ?? 'Drive file',
        ...(file.url ? { href: file.url, external: true } : {}),
      }, `drive:${file.fileId}`, file.at);
    }

    outputs.sort((a, b) => b.at - a.at);
    const made = outputs.filter(output => output.group === 'made');
    const data = outputs.filter(output => output.group === 'data');
    const plain = ({ key: _key, at: _at, ...output }: JobOutput & { key: string; at: number }): JobOutput => output;
    return {
      shown: [...made.slice(0, OUTPUTS_SHOWN), ...data.slice(0, DATA_SHOWN)].map(plain),
      more: { made: Math.max(0, made.length - OUTPUTS_SHOWN), data: Math.max(0, data.length - DATA_SHOWN) },
    };
  }

  function stateOf(job: ChatJob): { state: JobHistoryState; ending: string | null } {
    if (job.status === 'active') {
      const phase = deps.phaseOf?.(job) ?? null;
      return { state: phase === 'needs_owner' || phase === 'stuck' ? 'needs_you' : 'running', ending: null };
    }
    const known = job.endReason ? ENDINGS[job.endReason.trim()] : undefined;
    if (job.status === 'done') return known?.state ? { state: known.state, ending: known.text } : { state: 'done', ending: null };
    if (job.status === 'expired') return { state: 'expired', ending: known?.text ?? 'Ended after a day with nothing to do' };
    return { state: 'stopped', ending: known?.text ?? 'You stopped it' };
  }

  function row(job: ChatJob): JobHistoryRow {
    const { state, ending } = stateOf(job);
    const messages = messagesOf(job);
    const outputs = outputsOf(job, messages);
    return {
      id: job.id,
      number: job.seq > 0 ? job.seq : null,
      title: job.title,
      goal: job.goal,
      state,
      startedAt: job.createdAt,
      endedAt: job.endedAt ?? null,
      ending,
      summary: summaryOf(job, messages),
      outputs: outputs.shown,
      moreOutputs: outputs.more,
      model: deps.modelTitle?.(job.modelKey) ?? null,
      hasThread: Boolean(hasThreadRow.get(job.id)),
    };
  }

  return {
    page(input = {}) {
      const page = deps.jobs.history(input);
      return { jobs: page.jobs.map(row), ...(page.next ? { next: page.next } : {}), counts: page.counts };
    },
  };
}
