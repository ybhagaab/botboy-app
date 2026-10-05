import fs from 'fs';
import os from 'os';
import path from 'path';
import { createStorage, getSetting, setSetting, type StorageLayer } from './storage.js';
import { createContentStore, refToColumns, type ContentStore } from './content-store.js';
import { createLocalFolderImportLedger } from './local-folder-imports.js';
import { createFileReferences } from './file-references.js';
import {
  FILE_REFERENCE_MIGRATION_KEY,
  createFileReferenceMigration,
  type FileReferenceMigration,
} from './file-reference-migration.js';

/**
 * One-time conversion of stored data/code versions into references (owner
 * decision 2026-10-04: same rules on every store as on the owner's): newest
 * version converted in place, older ones deleted with their links, search
 * rows, and content files; missing files lose every version; credentials are
 * left as is; work in bounded, resumable steps.
 */
describe('file reference migration', () => {
  let storage: StorageLayer;
  let root: string;
  let contentDir: string;
  let store: ContentStore;
  let yields: number;

  function db() { return storage.getDb(); }

  function migration(extra: Partial<Parameters<typeof createFileReferenceMigration>[0]> = {}): FileReferenceMigration {
    return createFileReferenceMigration({
      db: db(), contentDir, yieldToLoop: async () => { yields++; }, now: () => new Date('2026-10-04T12:00:00Z'), ...extra,
    });
  }

  function write(rel: string, text: string): string {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, text, 'utf-8');
    return full;
  }

  function project(id: string): void {
    db().prepare('INSERT INTO projects (id, title, brain_path) VALUES (?, ?, ?)').run(id, `Project ${id}`, `/tmp/${id}.md`);
  }

  /** One stored version, as the pre-reference capture path stored it. */
  function version(id: string, filePath: string, opts: {
    capturedAt: string; text?: string; state?: string; projectId?: string | null; batchId?: string;
    legacyPath?: boolean; metadata?: Record<string, unknown>; originalPath?: string;
  }): void {
    const text = opts.text ?? `stored text of ${path.basename(filePath)} ${id}`;
    const cols = refToColumns(store.put(id, text));
    db().prepare(`
      INSERT INTO work_items (id, type, source, source_app, title, url, file_path, raw_text, content_storage, content_path,
        content_sha256, content_bytes, parsed_text, metadata, captured_at, process_state, project_id, batch_id, original_path)
      VALUES (?, 'document_capture', 'filesystem', 'Local Files', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, path.basename(filePath), `file://${filePath}`, opts.legacyPath ? null : filePath,
      cols.raw_text, cols.content_storage, cols.content_path, cols.content_sha256, cols.content_bytes, text,
      JSON.stringify({ filePath, localFolderId: '1', localFolderName: 'work', captureMode: 'live', ...(opts.metadata ?? {}) }),
      opts.capturedAt, opts.state ?? 'routed', opts.projectId === undefined ? 'p1' : opts.projectId, opts.batchId ?? null, opts.originalPath ?? null,
    );
    db().prepare('INSERT INTO work_items_fts (item_id, title, body) VALUES (?, ?, ?)').run(id, path.basename(filePath), text);
  }

  function rowsFor(filePath: string) {
    return db().prepare(`
      SELECT id, type, process_state AS state, project_id AS projectId, file_path AS filePath, summary, content_storage AS storage, metadata
      FROM work_items WHERE COALESCE(file_path, json_extract(metadata, '$.filePath')) = ? ORDER BY captured_at DESC
    `).all(filePath) as Array<{ id: string; type: string; state: string; projectId: string | null; filePath: string | null; summary: string; storage: string; metadata: string }>;
  }

  function search(term: string): string[] {
    return (db().prepare('SELECT item_id FROM work_items_fts WHERE work_items_fts MATCH ?').all(term) as Array<{ item_id: string }>).map((r) => r.item_id).sort();
  }

  function count(sql: string, ...args: unknown[]): number {
    return (db().prepare(sql).get(...args) as { c: number }).c;
  }

  beforeEach(() => {
    storage = createStorage(':memory:');
    storage.initialize();
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ppt-ref-migration-root-'));
    contentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ppt-ref-migration-content-'));
    store = createContentStore(db(), { contentDir, inlineThresholdBytes: 16 });
    db().prepare('INSERT INTO local_folders (id, path, created_at, updated_at) VALUES (1, ?, 0, 0)').run(root);
    project('p1');
    project('p2');
    yields = 0;
  });

  afterEach(() => {
    storage.close();
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(contentDir, { recursive: true, force: true });
  });

  it('turns the newest version of each data and code file into its reference and deletes the older ones', async () => {
    const metrics = write('mood/metrics.json', '{"epoch": 3, "loss": 0.12}');
    const script = write('src/train.py', '"""Train the catalog model."""\ndef main():\n    pass\n');
    const plan = write('mood/plan.md', '# Plan');
    version('m1', metrics, { capturedAt: '2026-09-01T00:00:00Z', text: 'zebraoldtext first' });
    version('m2', metrics, { capturedAt: '2026-09-02T00:00:00Z', text: 'zebraoldtext second', legacyPath: true });
    version('m3', metrics, { capturedAt: '2026-09-03T00:00:00Z', state: 'orphaned', projectId: null });
    version('s1', script, { capturedAt: '2026-07-08T00:00:00Z', legacyPath: true, state: 'extract_failed', projectId: null });
    version('d1', plan, { capturedAt: '2026-09-01T00:00:00Z', text: 'the plan document stays' });
    // Links an older version holds.
    db().prepare("INSERT INTO nodes (id, title) VALUES ('n1', 'Node')").run();
    db().prepare("INSERT INTO node_work_items (node_id, work_item_id) VALUES ('n1', 'm1'), ('n1', 'm3')").run();
    db().prepare("INSERT INTO agent_todos (id, work_item_id, action) VALUES ('t1', 'm1', 'review')").run();
    db().prepare("INSERT INTO project_cross_links (project_id, channel_id, channel_name, topic, evidence_item_id, reason) VALUES ('p1', 'C1', 'mood', 'metrics', 'm2', 'shared')").run();
    db().prepare("INSERT INTO failures (item_id, step, message) VALUES ('m1', 'parse', 'old'), ('s1', 'parse', 'unreadable')").run();
    db().prepare("INSERT INTO routing_decisions (run_id, batch_id, item_id, applied_decision, validation_reason) VALUES ('r', 'b', 'm1', 'assign', 'model')").run();
    const oldBlob = db().prepare("SELECT content_path AS p FROM work_items WHERE id = 'm1'").get() as { p: string };
    const auxBlob = path.join(path.dirname(oldBlob.p), 'm1-html-0001.txt');
    fs.writeFileSync(auxBlob, 'aux');
    setSetting(db(), 'file_references.adoption_event_id', 99);

    const result = await migration().run();

    expect(result).toMatchObject({ done: true, converted: 2, merged: 0, missingFiles: 0, deletedVersions: 2, leftSensitive: 0, deferred: 0 });
    const [reference] = rowsFor(metrics);
    expect(rowsFor(metrics)).toHaveLength(1);
    // The newest version keeps its id; the newest ROUTED version's project carries over.
    expect(reference).toMatchObject({ id: 'm3', type: 'file_reference', state: 'routed', projectId: 'p1', filePath: metrics, storage: 'inline' });
    expect(reference.summary).toContain('Top-level keys: epoch, loss');
    expect(JSON.parse(reference.metadata)).toMatchObject({
      filePath: metrics, fileRole: 'data', format: 'JSON', localFolderId: '1', localFolderName: 'work',
      convertedFromDocument: { versions: 3 },
    });
    expect(JSON.parse(reference.metadata).summary).toBeUndefined();
    // A legacy row with the path only in metadata is converted too, and gains the column.
    expect(rowsFor(script)).toEqual([expect.objectContaining({ id: 's1', type: 'file_reference', state: 'orphaned', filePath: script })]);
    expect(JSON.parse(rowsFor(script)[0].metadata)).toMatchObject({ fileRole: 'code', format: 'Python', header: 'Train the catalog model.' });
    // Documents are untouched.
    expect(rowsFor(plan)).toEqual([expect.objectContaining({ id: 'd1', type: 'document_capture' })]);
    expect(search('plan')).toContain('d1');

    // Search holds the outline, not the stored text.
    expect(search('zebraoldtext')).toEqual([]);
    expect(search('epoch')).toEqual(['m3']);
    // Links of deleted versions are gone or handed to the reference.
    expect(count("SELECT COUNT(*) AS c FROM node_work_items")).toBe(0);
    expect(db().prepare("SELECT work_item_id AS id FROM agent_todos WHERE id = 't1'").get()).toEqual({ id: 'm3' });
    expect(db().prepare('SELECT evidence_item_id AS id FROM project_cross_links').get()).toEqual({ id: 'm3' });
    expect(count('SELECT COUNT(*) AS c FROM failures')).toBe(0);
    expect(count("SELECT COUNT(*) AS c FROM routing_decisions WHERE item_id = 'm1'")).toBe(0);
    // Content files of every converted or deleted version are removed.
    expect(fs.existsSync(oldBlob.p)).toBe(false);
    expect(fs.existsSync(auxBlob)).toBe(false);
    expect(result.filesRemoved).toBeGreaterThanOrEqual(4);
    // The next adoption run sweeps every unassigned reference again; the marker holds the receipt.
    expect(getSetting(db(), 'file_references.adoption_event_id')).toBeNull();
    expect(getSetting(db(), FILE_REFERENCE_MIGRATION_KEY)).toMatchObject({ converted: 2, deletedVersions: 2 });
    expect(db().pragma('foreign_key_check')).toEqual([]);
  });

  it('deletes every stored version of a file that no longer exists', async () => {
    const gone = path.join(root, 'old/results.csv');
    version('g1', gone, { capturedAt: '2026-09-01T00:00:00Z' });
    version('g2', gone, { capturedAt: '2026-09-02T00:00:00Z', legacyPath: true });
    db().prepare("INSERT INTO agent_todos (id, work_item_id, action) VALUES ('t1', 'g2', 'review')").run();
    const result = await migration().run();
    expect(result).toMatchObject({ done: true, converted: 0, missingFiles: 1, deletedVersions: 2 });
    expect(rowsFor(gone)).toEqual([]);
    expect(db().prepare("SELECT work_item_id AS id FROM agent_todos WHERE id = 't1'").get()).toEqual({ id: null });
  });

  it('leaves possible credentials as is: credential-shaped paths, withheld versions, and secrets in the first 64 KB', async () => {
    const secretName = write('downloads/client_secret_123.apps.googleusercontent.com.json', '{"installed": {}}');
    const withheld = write('config/settings.json', '{"region": "us-east-1"}');
    // Built from split parts at run time: no token-shaped literal in the repo.
    const token = ['gh', 'p_', 'Zq7Lm2Xc9Vb4Nt6Rw1Ky8Hs3Jd5Fg0Pa1QeT'].join('');
    const leaked = write('config/deploy.yaml', `github_token: ${token}\n`);
    version('c1', secretName, { capturedAt: '2026-09-01T00:00:00Z' });
    version('w1', withheld, { capturedAt: '2026-09-01T00:00:00Z', state: 'noise', metadata: { sensitiveHold: 'Contains what looks like a GitHub token' } });
    version('w2', withheld, { capturedAt: '2026-09-02T00:00:00Z' });
    version('l1', leaked, { capturedAt: '2026-09-01T00:00:00Z' });
    const result = await migration().run();
    expect(result).toMatchObject({ done: true, converted: 0, deletedVersions: 0, leftSensitive: 3 });
    for (const file of [secretName, withheld, leaked]) expect(rowsFor(file).every((row) => row.type === 'document_capture')).toBe(true);
    expect(count("SELECT COUNT(*) AS c FROM work_items WHERE type = 'document_capture'")).toBe(4);
  });

  it('merges stored versions into an existing reference and fills its project, never with a rejected one', async () => {
    const a = write('later/a.json', '{"a": 1}');
    const b = write('later/b.json', '{"b": 1}');
    const refs = createFileReferences({ db: db(), contentStore: store });
    const reference = (filePath: string) => ({
      type: 'file_reference' as const, source: 'filesystem', sourceApp: 'Local Files', url: `file://${filePath}`,
      title: path.basename(filePath), content: 'JSON data', metadata: { filePath, localFolderId: '1', size: '8', mtime: '1' },
      capturedAt: new Date('2026-10-04T00:00:00Z'),
    });
    refs.upsert(reference(a));
    refs.upsert(reference(b));
    const refB = rowsFor(b)[0].id;
    db().prepare("INSERT INTO work_item_rejections (work_item_id, project_id) VALUES (?, 'p1')").run(refB);
    version('a1', a, { capturedAt: '2026-09-01T00:00:00Z', projectId: 'p2' });
    version('b1', b, { capturedAt: '2026-09-01T00:00:00Z', projectId: 'p1' });
    version('b2', b, { capturedAt: '2026-08-01T00:00:00Z', projectId: 'p2', state: 'routed' });
    db().prepare("INSERT INTO work_item_rejections (work_item_id, project_id) VALUES ('a1', 'p1')").run();

    const result = await migration().run();
    expect(result).toMatchObject({ done: true, converted: 0, merged: 2, deletedVersions: 3 });
    expect(rowsFor(a)).toEqual([expect.objectContaining({ type: 'file_reference', state: 'routed', projectId: 'p2' })]);
    // b's newest version was routed to p1, which the owner rejected for this file; the next routed one is p2.
    expect(rowsFor(b)).toEqual([expect.objectContaining({ id: refB, state: 'routed', projectId: 'p2' })]);
    // Rejections move onto the surviving reference.
    expect(count('SELECT COUNT(*) AS c FROM work_item_rejections WHERE work_item_id = ? AND project_id = ?', rowsFor(a)[0].id, 'p1')).toBe(1);
    const audit = db().prepare('SELECT validation_reason AS reason FROM routing_decisions WHERE item_id = ?').get(refB) as { reason: string };
    expect(audit.reason).toContain('carried from the stored document version');
  });

  it('keeps a discarded newest version discarded, and skips projects the owner rejected or deleted', async () => {
    const kept = write('k/kept.csv', 'user_id,score\n1,2\n');
    const binned = write('k/binned.csv', 'user_id,score\n1,2\n');
    version('k1', kept, { capturedAt: '2026-09-01T00:00:00Z', projectId: 'p_deleted' });
    version('k2', kept, { capturedAt: '2026-09-02T00:00:00Z', projectId: 'p1' });
    db().prepare("INSERT INTO work_item_rejections (work_item_id, project_id) VALUES ('k1', 'p1')").run();
    version('x1', binned, { capturedAt: '2026-09-01T00:00:00Z', state: 'noise', projectId: null });
    db().prepare("INSERT INTO work_item_discards (work_item_id, previous_state, previous_project_id) VALUES ('x1', 'routed', 'p1')").run();
    await migration().run();
    expect(rowsFor(kept)).toEqual([expect.objectContaining({ id: 'k2', type: 'file_reference', state: 'orphaned', projectId: null })]);
    expect(count("SELECT COUNT(*) AS c FROM work_item_rejections WHERE work_item_id = 'k2' AND project_id = 'p1'")).toBe(1);
    expect(rowsFor(binned)).toEqual([expect.objectContaining({ id: 'x1', type: 'file_reference', state: 'noise', projectId: null })]);
  });

  it('defers a file whose versions wait for extraction or sit in a librarian wave, and finishes later', async () => {
    const file = write('q/queue.jsonl', '{"id": 1}\n');
    version('q1', file, { capturedAt: '2026-09-01T00:00:00Z', state: 'captured', projectId: null });
    const first = await migration().run();
    expect(first).toMatchObject({ done: false, deferred: 1, converted: 0 });
    expect(getSetting(db(), FILE_REFERENCE_MIGRATION_KEY)).toBeNull();
    db().prepare("UPDATE work_items SET process_state = 'extracted', batch_id = 'wave-1' WHERE id = 'q1'").run();
    expect(await migration().run()).toMatchObject({ done: false, deferred: 1 });
    db().prepare("UPDATE work_items SET process_state = 'orphaned' WHERE id = 'q1'").run();
    expect(await migration().run()).toMatchObject({ done: true, converted: 1, deferred: 0 });
    expect(rowsFor(file)[0]).toMatchObject({ type: 'file_reference' });
  });

  it('deletes many large versions in bounded transactions with yields, and resumes after an abort', async () => {
    const file = write('runs/training-progress.json', '{"schema": 1, "runs": []}');
    for (let i = 0; i < 30; i++) version(`v${String(i).padStart(2, '0')}`, file, { capturedAt: `2026-09-01T00:${String(i).padStart(2, '0')}:00Z` });
    db().prepare("UPDATE work_items SET content_bytes = 3000000 WHERE type = 'document_capture'").run();
    const controller = new AbortController();
    const interrupted = migration({
      chunkBytes: 5_000_000,
      yieldToLoop: async () => { yields++; if (yields === 3) controller.abort(); },
    });
    const partial = await interrupted.run({ signal: controller.signal });
    expect(partial).toMatchObject({ done: false, aborted: true, converted: 1 });
    expect(partial.deletedVersions).toBe(4); // two chunks of two before the abort
    const left = rowsFor(file);
    expect(left.filter((row) => row.type === 'file_reference')).toHaveLength(1);
    expect(left.filter((row) => row.type === 'document_capture').every((row) => row.state === 'noise')).toBe(true);
    expect(left).toHaveLength(26);

    yields = 0;
    const resumed = await migration({ chunkBytes: 5_000_000 }).run();
    expect(resumed).toMatchObject({ done: true, converted: 0, merged: 1, deletedVersions: 25 });
    expect(yields).toBe(1 + 13); // the path, then 13 chunks of at most two
    expect(rowsFor(file)).toEqual([expect.objectContaining({ id: 'v29', type: 'file_reference' })]);
  });

  it('drops ledger holds that no longer apply to data and code files', async () => {
    const ledger = createLocalFolderImportLedger(db());
    const record = (rel: string, outcome: Parameters<typeof ledger.record>[0]['outcome']) =>
      ledger.record({ folderId: 1, path: path.join(root, rel), size: 1, mtimeMs: 1, outcome });
    record('big/huge.jsonl', 'too_large');
    record('big/table.csv', 'needs_review');
    record('dash/progress.json', 'owner_paused');
    record('big/deck.pdf', 'too_large');
    record('big/excluded.json', 'excluded');
    const result = await migration().run();
    expect(result.ledgerRowsDropped).toBe(3);
    expect(ledger.list(1).map((row) => [path.basename(row.path), row.outcome]).sort()).toEqual([
      ['deck.pdf', 'too_large'],
      ['excluded.json', 'excluded'],
    ]);
  });

  it('never removes a file outside the content store, even when a row points at one', async () => {
    const file = write('data/points.json', '{"x": 1}');
    const outside = write('elsewhere/blob.txt', 'not BotBoy content');
    version('o1', file, { capturedAt: '2026-09-01T00:00:00Z', originalPath: file });
    version('o2', file, { capturedAt: '2026-09-02T00:00:00Z' });
    db().prepare("UPDATE work_items SET content_storage = 'file', content_path = ? WHERE id = 'o1'").run(outside);
    await migration().run();
    expect(fs.existsSync(file)).toBe(true);
    expect(fs.existsSync(outside)).toBe(true);
    expect(rowsFor(file)).toEqual([expect.objectContaining({ id: 'o2', type: 'file_reference' })]);
  });

  it('runs once: a done store is never scanned again', async () => {
    write('a/a.json', '{}');
    expect(await migration().run()).toMatchObject({ done: true });
    const later = path.join(root, 'a/late.json');
    write('a/late.json', '{}');
    version('late1', later, { capturedAt: '2026-10-05T00:00:00Z' });
    const m = migration();
    expect(m.isDone()).toBe(true);
    expect(await m.run()).toMatchObject({ done: true, converted: 0 });
    expect(rowsFor(later)[0].type).toBe('document_capture');
  });
});
