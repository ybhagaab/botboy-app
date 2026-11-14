import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { createStorage, type StorageLayer } from './storage.js';
import {
  CHAT_JOB_FOLDED_REASON,
  createChatJobStore,
  formatChatJobBlock,
  recordToolOutcome,
  type ChatJob,
  type ChatJobStore,
} from './chat-jobs.js';
import { createJobHistory, storedTimeMs, summaryText } from './job-history.js';

/**
 * The Jobs page (docs/maps/job-history.md): every job the owner saw, kept for good, each with what he asked, what it found and
 * what it made. Outputs are shown only when BotBoy's own stores still hold them, and something named only in a job's words
 * counts as made by it only when it was created after the job started.
 */
let storage: StorageLayer;
let db: Database.Database;
let jobs: ChatJobStore;
let filesDir: string;

beforeEach(() => {
  storage = createStorage(':memory:');
  storage.initialize();
  db = storage.getDb();
  jobs = createChatJobStore(db);
  // The services that own these tables create them; only the columns the history reads matter here.
  db.pragma('foreign_keys = OFF');
  db.exec(`
    DROP TABLE IF EXISTS product_document_artifacts; DROP TABLE IF EXISTS analytics_dashboards; DROP TABLE IF EXISTS analytics_datasets;
    CREATE TABLE product_document_artifacts (artifact_id TEXT PRIMARY KEY, title TEXT, parent_artifact_id TEXT, created_at TEXT);
    CREATE TABLE analytics_dashboards (id TEXT PRIMARY KEY, title TEXT, created_at TEXT);
    CREATE TABLE analytics_datasets (id TEXT PRIMARY KEY, name TEXT, created_at TEXT);
  `);
  filesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'botboy-job-history-'));
});
afterEach(() => {
  storage?.close();
  if (filesDir) fs.rmSync(filesDir, { recursive: true, force: true });
});
const addDashboard = (id: string, title: string, createdAt: string) =>
  db.prepare('INSERT INTO analytics_dashboards (id, title, created_at) VALUES (?, ?, ?)').run(id, title, createdAt);
const addDataset = (id: string, name: string, createdAt: string) =>
  db.prepare('INSERT INTO analytics_datasets (id, name, created_at) VALUES (?, ?, ?)').run(id, name, createdAt);

const HOUR = 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();
const sqliteTime = (ms: number) => iso(ms).replace('T', ' ').replace(/\.\d+Z$/, '');

/** A job started at `startedMs`, optionally ended (status, reason). */
function makeJob(goal: string, options: { startedMs?: number; end?: [Exclude<ChatJob['status'], 'active'>, string]; provisional?: boolean; title?: string } = {}): ChatJob {
  const job = jobs.start({ goal, ...(options.title ? { title: options.title } : {}), ...(options.provisional ? { provisional: true } : {}) });
  db.prepare('UPDATE chat_jobs SET created_at = ? WHERE id = ?').run(iso(options.startedMs ?? Date.now() - HOUR), job.id);
  if (options.end) jobs.end(job.id, options.end[0], options.end[1]);
  return jobs.get(job.id)!;
}
let messageCounter = 0;
function message(jobId: string, content: string, options: { ref?: boolean; role?: string; atMs?: number } = {}) {
  messageCounter += 1;
  db.prepare('INSERT INTO chat_messages (id, role, content, job_id, ref_job_id, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
    `m${messageCounter}`, options.role ?? 'assistant', content, options.ref ? null : jobId, options.ref ? jobId : null,
    sqliteTime(options.atMs ?? Date.now() - messageCounter * 1000),
  );
}
const history = (phaseOf?: (job: ChatJob) => string | null) => createJobHistory({ db, jobs, filesDir, ...(phaseOf ? { phaseOf } : {}) });
const rowOf = (jobId: string, phaseOf?: (job: ChatJob) => string | null) => history(phaseOf).page({ limit: 100 }).jobs.find(row => row.id === jobId)!;
function writeFile(relative: string, text = 'x') {
  const target = path.join(filesDir, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, text);
  return target;
}

describe('job history: which jobs, in what order, kept for good', () => {
  it('lists every job the owner saw, newest first, and leaves out only provisional jobs and ones that folded away', () => {
    const now = Date.now();
    const old = makeJob('An old job from before numbers', { startedMs: now - 72 * HOUR, end: ['done', 'Verified the old answer.'] });
    db.prepare('UPDATE chat_jobs SET seq = NULL WHERE id = ?').run(old.id);
    const done = makeJob('Write the roadmap', { startedMs: now - 3 * HOUR, end: ['done', 'Saved the roadmap.'] });
    const running = makeJob('Pull the September numbers', { startedMs: now - HOUR });
    makeJob('A provisional ETL run', { startedMs: now - 2 * HOUR, provisional: true });
    makeJob('A folded ETL run', { startedMs: now - 2.5 * HOUR, provisional: true, end: ['done', CHAT_JOB_FOLDED_REASON] });
    const page = history().page();
    expect(page.jobs.map(row => row.id)).toEqual([running.id, done.id, old.id]);
    expect(page.jobs.map(row => row.number)).toEqual([running.seq, done.seq, null]);
    expect(page.counts).toEqual({ all: 3, done: 2, stopped: 0 });
    expect(page.next).toBeUndefined();
  });

  it('pages older jobs with a cursor, with no job twice and none skipped, even when two started in the same millisecond', () => {
    const now = Date.now();
    const made = [0, 1, 2, 3, 4].map(index => makeJob(`Job ${index}`, { startedMs: now - (index < 2 ? 1 : index) * HOUR }));
    const seen: string[] = [];
    let page = history().page({ limit: 2 });
    seen.push(...page.jobs.map(row => row.id));
    while (page.next) {
      page = history().page({ limit: 2, before: page.next });
      seen.push(...page.jobs.map(row => row.id));
    }
    expect(new Set(seen).size).toBe(5);
    expect(seen.sort()).toEqual(made.map(job => job.id).sort());
    // A cursor that is not one of ours reads as the first page.
    expect(history().page({ limit: 2, before: "x' OR 1=1 --" }).jobs).toHaveLength(2);
  });

  it('finds jobs by title, the owner\'s words, the report and the end reason, with % and _ taken literally', () => {
    const roadmap = makeJob('Plan next year', { title: 'Annual roadmap' });
    const words = makeJob('Find the table that holds uuid');
    const report = makeJob('Check the dashboards', { end: ['done', 'Done.'] });
    jobs.recordReport(report.id, 'Both dashboards load; the Prime one is fresh.');
    const reason = makeJob('Compare weeks', { end: ['done', 'Verified a 12% rise in week 3.'] });
    const find = (query: string) => history().page({ query }).jobs.map(row => row.id);
    expect(find('roadmap')).toEqual([roadmap.id]);
    expect(find('UUID')).toEqual([words.id]);
    expect(find('prime one')).toEqual([report.id]);
    expect(find('12%')).toEqual([reason.id]);
    expect(find('%')).toEqual([reason.id]);
    expect(find('_')).toEqual([]);
    expect(history().page({ query: 'nothing like this' }).counts).toEqual({ all: 0, done: 0, stopped: 0 });
  });

  it('filters finished jobs and ones that ended without finishing (stopped or expired), with counts for the words', () => {
    const done = makeJob('A', { end: ['done', 'Verified.'] });
    const stopped = makeJob('B', { end: ['stopped', 'stopped by the owner'] });
    const expired = makeJob('C', { end: ['expired', 'idle for 24 hours'] });
    makeJob('D');
    expect(history().page({ status: 'done' }).jobs.map(row => row.id)).toEqual([done.id]);
    expect(history().page({ status: 'stopped' }).jobs.map(row => row.id).sort()).toEqual([stopped.id, expired.id].sort());
    expect(history().page({ status: 'stopped' }).counts).toEqual({ all: 4, done: 1, stopped: 2 });
  });

  it('keeps jobs for good: no code deletes a job row', () => {
    const root = path.join(__dirname, '..');
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.ts$/.test(entry.name) && !/\.test\.ts$/.test(entry.name) && /DELETE\s+FROM\s+chat_jobs\b/i.test(fs.readFileSync(full, 'utf8'))) offenders.push(full);
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  });
});

describe('job history: what a job recorded as it went', () => {
  it('records files the job wrote or edited without calling it data work; an ETL download still is data work', () => {
    const job = makeJob('Draw a picture for the team page');
    const written = writeFile('funnel/page.html');
    recordToolOutcome(jobs, job.id, 'write_file', '{}', JSON.stringify({ path: written, url: '/api/files/funnel/page.html' }));
    recordToolOutcome(jobs, job.id, 'write_file', '{}', JSON.stringify({ path: written, url: '/api/files/funnel/page.html', chunkNumber: 2 }));
    recordToolOutcome(jobs, job.id, 'edit_file', '{}', JSON.stringify({ path: written }));
    expect(jobs.get(job.id)!.workingSet.files.map(file => file.path)).toEqual([written]);
    expect(jobs.get(job.id)!.dataWork).toBe(false);
    recordToolOutcome(jobs, job.id, 'mcp_etl_download_results', '{}', JSON.stringify({ savedTo: writeFile('etl-results/run.tsv'), runId: '77' }));
    expect(jobs.get(job.id)!.dataWork).toBe(true);
  });

  it('keeps one entry per document: an edit\'s new version replaces its parent, and an unsaved document records nothing', () => {
    const job = makeJob('Write the PRD');
    recordToolOutcome(jobs, job.id, 'save_product_document', '{}', JSON.stringify({ persisted: true, artifactId: 'v1', title: 'PRD' }));
    recordToolOutcome(jobs, job.id, 'edit_product_document', '{}', JSON.stringify({ persisted: true, artifactId: 'v2', parentArtifactId: 'v1', title: 'PRD (final)' }));
    recordToolOutcome(jobs, job.id, 'save_product_document', '{}', JSON.stringify({ persisted: false, artifactId: 'v9' }));
    expect(jobs.get(job.id)!.workingSet.documents.map(doc => [doc.artifactId, doc.title])).toEqual([['v2', 'PRD (final)']]);
  });

  it('records Drive files the job made, keeps only Google\'s own links, and ignores renames and trash', () => {
    const job = makeJob('Make the deck');
    recordToolOutcome(jobs, job.id, 'gdrive_files', '{}', JSON.stringify({ ok: true, status: 'created', fileId: 'f1', name: 'Deck', kind: 'slides', webViewLink: 'https://docs.google.com/presentation/d/f1/edit' }));
    recordToolOutcome(jobs, job.id, 'gdrive_files', '{}', JSON.stringify({ ok: true, status: 'uploaded', fileId: 'f2', name: 'data.csv', kind: 'file', webViewLink: 'javascript:alert(1)' }));
    recordToolOutcome(jobs, job.id, 'gdrive_files', '{}', JSON.stringify({ ok: true, status: 'trashed', fileId: 'f3' }));
    recordToolOutcome(jobs, job.id, 'gdrive_files', '{}', JSON.stringify({ ok: true, status: 'renamed', fileId: 'f4' }));
    const drive = jobs.get(job.id)!.workingSet.drive;
    expect(drive.map(file => [file.fileId, file.url ?? null])).toEqual([['f1', 'https://docs.google.com/presentation/d/f1/edit'], ['f2', null]]);
    const block = formatChatJobBlock(jobs.get(job.id)!, []);
    expect(block).toContain('Google Drive files:\n- f1 — Deck');
  });

  it('tells the job\'s later turns which documents it has, so they edit the same one', () => {
    const job = makeJob('Write the PRD');
    jobs.recordDocument(job.id, { artifactId: 'doc-1', title: 'Notification PRD' });
    expect(formatChatJobBlock(jobs.get(job.id)!, [])).toContain('Documents (newest version of each; edit with edit_product_document):\n- doc-1 — Notification PRD');
  });
});

describe('job history: the row a job reads as', () => {
  it('summarizes from the report, then its own last reply, then the main chat\'s rows about it, then a verified end reason', () => {
    const reported = makeJob('A', { end: ['done', 'Verified.'] });
    jobs.recordReport(reported.id, 'The **report** [[job-card:cj_x]]');
    message(reported.id, 'An older reply');
    expect(rowOf(reported.id).summary).toBe('The **report**');

    const replied = makeJob('B', { end: ['done', 'Verified B.'] });
    message(replied.id, 'First reply', { atMs: Date.now() - 5000 });
    message(replied.id, '↻ Continued automatically: the time came.\n\nThe newest reply', { atMs: Date.now() - 1000 });
    expect(rowOf(replied.id).summary).toBe('The newest reply');

    const mainOnly = makeJob('C', { end: ['done', 'Verified C.'] });
    message(mainOnly.id, '↻ Job update: #3 has a question.', { ref: true, atMs: Date.now() - 1000 });
    message(mainOnly.id, 'Its closing words in the main chat', { ref: true, atMs: Date.now() - 5000 });
    expect(rowOf(mainOnly.id).summary).toBe('Its closing words in the main chat');

    const reasonOnly = makeJob('D', { end: ['done', 'Verified six aliases and saved the email.'] });
    expect(rowOf(reasonOnly.id).summary).toBe('Verified six aliases and saved the email.');
    const stopped = makeJob('E', { end: ['stopped', 'stopped by the owner'] });
    expect(rowOf(stopped.id)).toMatchObject({ summary: null, state: 'stopped', ending: 'You stopped it' });
  });

  it('reads how a job ended in plain words, and an active job that waits for the owner as needing him', () => {
    const replaced = makeJob('A', { end: ['done', 'replaced by a new job'] });
    const expired = makeJob('B', { end: ['expired', 'idle for 24 hours'] });
    const asking = makeJob('C');
    const working = makeJob('D');
    const phaseOf = (job: ChatJob) => (job.id === asking.id ? 'needs_owner' : 'working');
    expect(rowOf(replaced.id)).toMatchObject({ state: 'stopped', ending: 'Replaced by a newer job' });
    expect(rowOf(expired.id)).toMatchObject({ state: 'expired', ending: 'Ended after a day with nothing to do' });
    expect(rowOf(asking.id, phaseOf).state).toBe('needs_you');
    expect(rowOf(working.id, phaseOf).state).toBe('running');
  });

  it('shows the newest version of each document it made, and leaves out documents it only referred to', () => {
    const start = Date.now() - 2 * HOUR;
    const job = makeJob('Write the PRD', { startedMs: start, end: ['done', 'Saved 33333333-3333-4333-8333-333333333333.'] });
    const insert = db.prepare('INSERT INTO product_document_artifacts (artifact_id, title, parent_artifact_id, created_at) VALUES (?, ?, ?, ?)');
    insert.run('doc-v1', 'PRD', null, iso(start + 60_000));
    insert.run('doc-v2', 'PRD v2', 'doc-v1', iso(start + 120_000));
    insert.run('older-doc', 'Last year\'s PRD', null, iso(start - 24 * HOUR));
    insert.run('33333333-3333-4333-8333-333333333333', 'Launch email', null, iso(start + 30_000));
    jobs.recordDocument(job.id, { artifactId: 'doc-v1', title: 'PRD' });
    message(job.id, 'Saved [the PRD](#/documents/doc-v2) from [last year\'s](#/documents/older-doc) and a [missing one](#/documents/gone-doc).');
    const outputs = rowOf(job.id).outputs;
    expect(outputs.map(output => [output.title, output.detail, output.href])).toEqual(expect.arrayContaining([
      ['PRD v2', 'Document', '#/documents/doc-v2'],
      ['Launch email', 'Document', '#/documents/33333333-3333-4333-8333-333333333333'],
    ]));
    expect(outputs.map(output => output.title)).not.toContain('PRD');
    expect(outputs.map(output => output.title)).not.toContain('Last year\'s PRD');
    expect(outputs).toHaveLength(2);
  });

  it('marks a recorded dashboard or dataset that existed before the job as updated, and drops ones only named that it did not make', () => {
    const start = Date.now() - 2 * HOUR;
    const job = makeJob('Fix the dashboards', { startedMs: start });
    addDashboard('dash_aaaaaaaaaaaaaaaa', 'Prime', sqliteTime(start - 48 * HOUR));
    addDashboard('dash_bbbbbbbbbbbbbbbb', 'Downloads', sqliteTime(start + 600_000));
    addDashboard('dash_cccccccccccccccc', 'Someone else\'s', sqliteTime(start - 48 * HOUR));
    addDataset('ds_prep_abcdef123456', 'Weekly streams', iso(start + 300_000));
    jobs.recordDashboard(job.id, { dashboardId: 'dash_aaaaaaaaaaaaaaaa' });
    message(job.id, 'Built dash_bbbbbbbbbbbbbbbb from ds_prep_abcdef123456; compared with dash_cccccccccccccccc and dash_dddddddddddddddd.');
    const outputs = rowOf(job.id).outputs.map(output => [output.kind, output.title, output.detail, output.href]);
    expect(outputs).toEqual(expect.arrayContaining([
      ['dashboard', 'Prime', 'Dashboard · updated', '#/dashboards/dash_aaaaaaaaaaaaaaaa'],
      ['dashboard', 'Downloads', 'Dashboard', '#/dashboards/dash_bbbbbbbbbbbbbbbb'],
      ['dataset', 'Weekly streams', 'Dataset', '#/data-room/ds_prep_abcdef123456'],
    ]));
    expect(outputs).toHaveLength(3);
  });

  it('opens files only from the files workspace, folds raw query results apart, and never shows a missing or outside file', () => {
    const start = Date.now() - HOUR;
    const job = makeJob('Make the worksheet', { startedMs: start });
    const sheet = writeFile('roadmap 2027/worksheet.csv');
    const result = writeFile('etl-results/adhoc_1.tsv');
    const outside = path.join(os.tmpdir(), `botboy-outside-${process.pid}.csv`);
    fs.writeFileSync(outside, 'x');
    try {
      jobs.recordFile(job.id, sheet, undefined, { dataWork: false });
      jobs.recordFile(job.id, result);
      jobs.recordFile(job.id, outside);
      jobs.recordFile(job.id, path.join(filesDir, 'deleted.csv'));
      writeFile('linked/page.html');
      message(job.id, 'See [the page](/api/files/linked/page.html) and [nothing](/api/files/../../etc/passwd).');
      const row = rowOf(job.id);
      expect(row.outputs.map(output => [output.group, output.title, output.detail, output.href])).toEqual(expect.arrayContaining([
        ['made', 'worksheet.csv', 'Table', '/api/files/roadmap%202027/worksheet.csv'],
        ['made', 'page.html', 'Web page', '/api/files/linked/page.html'],
        ['data', 'adhoc_1.tsv', 'Table', '/api/files/etl-results/adhoc_1.tsv'],
      ]));
      expect(row.outputs).toHaveLength(3);
      // A made output always comes before the data files.
      expect(row.outputs.map(output => output.group)).toEqual(['made', 'made', 'data']);
    } finally {
      fs.rmSync(outside, { force: true });
    }
  });

  it('does not count a file the job only linked to when the file is older than the job', () => {
    writeFile('linked/old.html');
    const job = makeJob('Look at the old page', { startedMs: Date.now() + HOUR });
    message(job.id, 'Opened [the old page](/api/files/linked/old.html).');
    expect(rowOf(job.id).outputs).toEqual([]);
  });

  it('opens Drive files in a new tab, and caps what it shows with a count of the rest', () => {
    const job = makeJob('Make many things');
    jobs.recordDriveFile(job.id, { fileId: 'f1', name: 'Deck', kind: 'slides', url: 'https://docs.google.com/presentation/d/f1' });
    for (let index = 0; index < 10; index += 1) jobs.recordFile(job.id, writeFile(`made/${index}.md`), undefined, { dataWork: false });
    const row = rowOf(job.id);
    expect(row.outputs.filter(output => output.group === 'made')).toHaveLength(8);
    expect(row.moreOutputs).toEqual({ made: 3, data: 0 });
    const allDrive = createJobHistory({ db, jobs, filesDir: path.join(filesDir, 'nowhere') }).page().jobs[0].outputs;
    expect(allDrive).toEqual([{ kind: 'drive', group: 'made', title: 'Deck', detail: 'Google Slides', href: 'https://docs.google.com/presentation/d/f1', external: true }]);
  });

  it('works before the document and analytics tables exist (their services create them)', () => {
    db.exec('DROP TABLE product_document_artifacts; DROP TABLE analytics_dashboards; DROP TABLE analytics_datasets;');
    const job = makeJob('Anything', { end: ['done', 'Saved 33333333-3333-4333-8333-333333333333 and dash_aaaaaaaaaaaaaaaa.'] });
    expect(rowOf(job.id)).toMatchObject({ outputs: [], summary: 'Saved 33333333-3333-4333-8333-333333333333 and dash_aaaaaaaaaaaaaaaa.' });
  });
});

describe('job history: words and times', () => {
  it('reads SQLite\'s zone-less UTC times and ISO times alike', () => {
    expect(storedTimeMs('2026-09-03 14:24:05')).toBe(Date.parse('2026-09-03T14:24:05Z'));
    expect(storedTimeMs('2026-09-03T14:24:05.000Z')).toBe(Date.parse('2026-09-03T14:24:05Z'));
    expect(Number.isNaN(storedTimeMs('soon'))).toBe(true);
  });

  it('cuts a long summary at a paragraph and says so, and drops card markers and the automatic-turn note', () => {
    const long = `${'First paragraph. '.repeat(100)}\n\n${'Second paragraph. '.repeat(100)}`;
    const cut = summaryText(long)!;
    expect(cut.length).toBeLessThan(long.length);
    expect(cut.endsWith('\n\n…')).toBe(true);
    expect(summaryText('▶ Started from your request.\n\nSaved it. [[lesson:ls_1]]')).toBe('Saved it.');
    expect(summaryText('   ')).toBeNull();
  });
});
