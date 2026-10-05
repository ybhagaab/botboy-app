import fs from 'fs';
import os from 'os';
import path from 'path';
import { createStorage, getSetting, type StorageLayer } from './storage.js';
import { createContentStore } from './content-store.js';
import type { RawWorkItem } from './types.js';
import {
  FILE_REFERENCE_TYPE,
  REFERENCE_HEAD_BYTES,
  buildFileReference,
  readFileHead,
  createFileReferences,
  isBinaryReferenceFormat,
  leadingComment,
  localFileRoleForPath,
  referencePathIndexHint,
  roleFromHead,
  type FileReferences,
} from './file-references.js';

/**
 * File references (owner decision 2026-10-04): data and code files in
 * watched folders are recorded, not read. One row per path with a
 * deterministic outline from the first 64 KB, updated in place, routed by
 * the documents in its folder.
 */

describe('file roles', () => {
  it('classifies by extension and by known build-file names', () => {
    expect(localFileRoleForPath('/w/run/metrics.json')).toBe('data');
    expect(localFileRoleForPath('/w/run/events.JSONL')).toBe('data');
    expect(localFileRoleForPath('/w/run/table.csv')).toBe('data');
    expect(localFileRoleForPath('/w/run/train.log')).toBe('data');
    expect(localFileRoleForPath('/w/run/weights.safetensors')).toBe('data');
    expect(localFileRoleForPath('/w/src/train.py')).toBe('code');
    expect(localFileRoleForPath('/w/src/app.tsx')).toBe('code');
    expect(localFileRoleForPath('/w/config.yaml')).toBe('code');
    expect(localFileRoleForPath('/w/Makefile')).toBe('code');
    expect(localFileRoleForPath('/w/Config')).toBe('code');
    expect(localFileRoleForPath('/w/CMakeLists.txt')).toBe('code');
    expect(localFileRoleForPath('/w/requirements-dev.txt')).toBe('code');
    expect(localFileRoleForPath('/w/notes.txt')).toBe('document');
    expect(localFileRoleForPath('/w/plan.md')).toBe('document');
    expect(localFileRoleForPath('/w/report.xlsx')).toBe('document');
    expect(localFileRoleForPath('/w/deck.pptx')).toBe('document');
    expect(localFileRoleForPath('/w/README')).toBe('sniff');
  });

  it('decides a name with no extension from its first bytes', () => {
    expect(roleFromHead('/cache/blobs/3f8a9c0d1e2f3a4b5c6d7e8f9a0b1c2d', Buffer.from('anything'))).toBe('data');
    expect(roleFromHead('/w/blob', Buffer.from([0x50, 0x4b, 0x00, 0x03]))).toBe('data');
    expect(roleFromHead('/w/state', Buffer.from('\uFEFF  {"a": 1}'))).toBe('data');
    expect(roleFromHead('/w/deploy', Buffer.from('#!/usr/bin/env bash\necho hi'))).toBe('code');
    expect(roleFromHead('/w/README', Buffer.from('Mood match notes'))).toBe('document');
  });

  it('treats model and columnar formats as binary', () => {
    expect(isBinaryReferenceFormat('/w/a.parquet')).toBe(true);
    expect(isBinaryReferenceFormat('/w/model.pt')).toBe(true);
    expect(isBinaryReferenceFormat('/w/a.json')).toBe(false);
  });

  it('reads at most the requested head of a file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ppt-file-head-'));
    try {
      const file = path.join(dir, 'big.json');
      fs.writeFileSync(file, 'a'.repeat(REFERENCE_HEAD_BYTES * 3));
      expect(readFileHead(file, REFERENCE_HEAD_BYTES)?.length).toBe(REFERENCE_HEAD_BYTES);
      fs.writeFileSync(file, '{}');
      expect(readFileHead(file, REFERENCE_HEAD_BYTES)?.toString()).toBe('{}');
      expect(readFileHead(path.join(dir, 'missing.json'), 10)).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('reference outline', () => {
  const base = { rootPath: '/Users/o/onlineMCP', size: 2048, mtimeMs: Date.parse('2026-10-01T10:00:00Z') };

  it('lists JSON top-level keys and record fields, and hides identifier-like keys', () => {
    const object = buildFileReference({ ...base, filePath: '/Users/o/onlineMCP/run/metrics.json', role: 'data', complete: true,
      head: '{"epoch": 3, "loss": 0.12, "config": {"lr": 0.01, "nested_key": 1}, "best_val": 0.9}' });
    expect(object.outline).toEqual(['epoch', 'loss', 'config', 'best_val']);
    expect(object.summary).toBe('JSON data, 2.0 KB, 1 line. Top-level keys: epoch, loss, config, best_val');
    expect(object.text).toContain(path.join('onlineMCP', 'run', 'metrics.json'));
    expect(object.text).toContain('without reading it');

    const records = buildFileReference({ ...base, filePath: '/Users/o/onlineMCP/a.json', role: 'data', complete: false,
      head: '[\n  {"user_id": 1, "mood": "calm", "score": 0.4},\n  {"user_id": 2' });
    expect(records).toMatchObject({ outlineLabel: 'Record fields', outline: ['user_id', 'mood', 'score'], lines: null });

    const ids = buildFileReference({ ...base, filePath: '/Users/o/onlineMCP/index.json', role: 'data', complete: true,
      head: '{"a3f9c2d1e4b5a6c7d8e9": 1, "b4e0d3c2f5a6b7c8d9e0": 2, "c5f1e4d3a6b7c8d9e0f1": 3}' });
    expect(ids.outline).toEqual(['identifier-like keys']);
  });

  it('reads JSON Lines fields from the first record', () => {
    const ref = buildFileReference({ ...base, filePath: '/Users/o/onlineMCP/events.jsonl', role: 'data', complete: false,
      head: '\n{"ts": "2026-10-01", "event": "click", "item": 4}\n{"ts": "2026-10-02"' });
    expect(ref).toMatchObject({ format: 'JSON Lines', outline: ['ts', 'event', 'item'] });
  });

  it('names CSV columns only when the first row is a header', () => {
    const header = buildFileReference({ ...base, filePath: '/Users/o/onlineMCP/t.csv', role: 'data', complete: false,
      head: 'user_id,"Mood score",created_at\n1,0.4,2026-10-01\n' });
    expect(header.outline).toEqual(['user_id', 'Mood score', 'created_at']);

    const values = buildFileReference({ ...base, filePath: '/Users/o/onlineMCP/raw.csv', role: 'data', complete: false,
      head: '1,0.4,jane@example.com\n2,0.9,joe@example.com\n' });
    expect(values.outline).toEqual(['3 columns, no header row']);
    expect(values.text).not.toContain('jane@example.com');
  });

  it('records a log by name and size only', () => {
    const log = buildFileReference({ ...base, filePath: '/Users/o/onlineMCP/train.log', role: 'data', complete: true,
      head: 'epoch 1 user=jane@example.com loss=0.3\n' });
    expect(log.outline).toEqual([]);
    expect(log.text).not.toContain('jane');
    expect(log.summary).toBe('Log, 2.0 KB, 1 line');
  });

  it('never outlines a binary format, even when bytes are passed', () => {
    const ref = buildFileReference({ ...base, filePath: '/Users/o/onlineMCP/w.parquet', role: 'data', complete: false, head: '{"leak": 1}' });
    expect(ref).toMatchObject({ format: 'Parquet', outline: [], header: null, lines: null });
  });

  it('outlines code: the opening comment and the names it defines', () => {
    const py = buildFileReference({ ...base, filePath: '/Users/o/onlineMCP/src/train.py', role: 'code', complete: true,
      head: '#!/usr/bin/env python3\n"""Train the neural catalog memory model. Uses the mood dataset."""\nimport os\n\nclass Trainer:\n    def step(self):\n        pass\n\ndef main():\n    pass\n' });
    expect(py.header).toBe('Train the neural catalog memory model.');
    expect(py.outline).toEqual(['Trainer', 'main']);
    expect(py.summary).toContain('Python code');

    const ts = buildFileReference({ ...base, filePath: '/Users/o/onlineMCP/src/store.ts', role: 'code', complete: true,
      head: '/**\n * Store for mood match sessions.\n */\nexport interface Session {}\nexport function openStore() {}\nconst local = 1;\n' });
    expect(ts.header).toBe('Store for mood match sessions.');
    expect(ts.outline).toEqual(['Session', 'openStore', 'local']);

    const yaml = buildFileReference({ ...base, filePath: '/Users/o/onlineMCP/config.yaml', role: 'code', complete: true,
      head: 'model:\n  name: x\ntraining:\n  epochs: 3\n' });
    expect(yaml).toMatchObject({ outlineLabel: 'Keys', outline: ['model', 'training'], noun: 'config' });
  });

  it('skips license boilerplate as a header', () => {
    expect(leadingComment('// Copyright 2026 Example Corp. All rights reserved.\nexport const a = 1;')).toBeNull();
    expect(leadingComment('# Fetch the nightly metrics export.\nimport os')).toBe('Fetch the nightly metrics export.');
  });

  it('keeps the summary to one bounded line', () => {
    const keys = Array.from({ length: 40 }, (_, i) => `"field_with_a_long_name_${i}": ${i}`).join(', ');
    const ref = buildFileReference({ ...base, filePath: '/Users/o/onlineMCP/wide.json', role: 'data', complete: false, head: `{${keys}` });
    expect(ref.summary.length).toBeLessThanOrEqual(280);
    expect(ref.summary).not.toContain('\n');
  });
});

describe('reference store and folder routing', () => {
  let storage: StorageLayer;
  let refs: FileReferences;
  let contentDir: string;
  let clock: number;
  const root = '/Users/o/onlineMCP';

  function db() { return storage.getDb(); }

  function project(id: string, status = 'active'): void {
    db().prepare('INSERT INTO projects (id, title, status, brain_path) VALUES (?, ?, ?, ?)').run(id, `Project ${id}`, status, `/tmp/${id}.md`);
  }

  function routedDoc(id: string, filePath: string, projectId: string, extra: { scopeAlert?: string } = {}): void {
    db().prepare(`
      INSERT INTO work_items (id, type, source, title, file_path, captured_at, process_state, project_id, scope_alert)
      VALUES (?, 'document_capture', 'filesystem', ?, ?, '2026-10-01T00:00:00Z', 'routed', ?, ?)
    `).run(id, path.basename(filePath), filePath, projectId, extra.scopeAlert ?? null);
  }

  function item(filePath: string, content: string, metadata: Record<string, string> = {}): RawWorkItem {
    return {
      type: FILE_REFERENCE_TYPE, source: 'filesystem', sourceApp: 'Local Files',
      url: `file://${filePath}`, title: path.basename(filePath), content,
      metadata: { filePath, localFolderId: '1', summary: content.split('\n')[0], size: '10', mtime: '1', ...metadata },
      capturedAt: new Date('2026-10-04T00:00:00Z'),
    };
  }

  function rows(filePath: string) {
    return db().prepare("SELECT id, process_state AS state, project_id AS projectId, metadata, summary FROM work_items WHERE type = 'file_reference' AND file_path = ?").all(filePath) as Array<{ id: string; state: string; projectId: string | null; metadata: string; summary: string }>;
  }

  function search(term: string): string[] {
    return (db().prepare('SELECT item_id FROM work_items_fts WHERE work_items_fts MATCH ?').all(term) as Array<{ item_id: string }>).map((r) => r.item_id);
  }

  beforeEach(() => {
    storage = createStorage(':memory:');
    storage.initialize();
    contentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ppt-file-refs-'));
    db().prepare('INSERT INTO local_folders (id, path, created_at, updated_at) VALUES (1, ?, 0, 0)').run(root);
    clock = Date.parse('2026-10-04T00:00:00Z');
    refs = createFileReferences({ db: db(), contentStore: createContentStore(db(), { contentDir, inlineThresholdBytes: 1024 }), now: () => new Date(clock) });
  });

  afterEach(() => {
    storage.close();
    fs.rmSync(contentDir, { recursive: true, force: true });
  });

  it('keeps one row per path, updates it in place, and keeps search current', () => {
    const file = `${root}/run/metrics.json`;
    refs.upsert(item(file, 'JSON data. Top-level keys: alphakey'));
    refs.upsert(item(file, 'JSON data. Top-level keys: betakey', { size: '20' }));
    const [row] = rows(file);
    expect(rows(file)).toHaveLength(1);
    expect(row).toMatchObject({ state: 'orphaned', projectId: null, summary: 'JSON data. Top-level keys: betakey' });
    expect(JSON.parse(row.metadata)).toMatchObject({ size: '20', filePath: file });
    expect(search('betakey')).toEqual([row.id]);
    expect(search('alphakey')).toEqual([]);
    // No version history, extraction, or synthesis: the row never enters the evidence lifecycle.
    expect((db().prepare('SELECT COUNT(*) AS c FROM work_items').get() as { c: number }).c).toBe(1);
  });

  it('marks a deleted file archived and clears the mark when it returns', () => {
    const file = `${root}/run/metrics.json`;
    refs.upsert(item(file, 'JSON data'));
    refs.upsert(item(file, '', { archived: 'true' }));
    expect(JSON.parse(rows(file)[0].metadata)).toMatchObject({ archived: 'true' });
    refs.upsert(item(file, 'JSON data again'));
    expect(JSON.parse(rows(file)[0].metadata).archived).toBeUndefined();
    // A path never recorded stays unrecorded.
    refs.upsert(item(`${root}/never.json`, '', { archived: 'true' }));
    expect(rows(`${root}/never.json`)).toHaveLength(0);
  });

  it('follows the documents in its own folder and audits the assignment', () => {
    project('p1');
    routedDoc('d1', `${root}/mood/plan.md`, 'p1');
    refs.upsert(item(`${root}/mood/results.json`, 'JSON data'));
    const [row] = rows(`${root}/mood/results.json`);
    expect(row).toMatchObject({ state: 'routed', projectId: 'p1' });
    const decision = db().prepare('SELECT applied_decision AS decision, applied_project_id AS projectId, validation_reason AS reason FROM routing_decisions WHERE item_id = ?').get(row.id);
    expect(decision).toEqual({ decision: 'assign', projectId: 'p1', reason: 'deterministic reference-follows-folder-documents rule' });
  });

  it('leaves a reference unassigned when the nearest documents disagree', () => {
    project('p1');
    project('p2');
    routedDoc('d1', `${root}/shared/a.md`, 'p1');
    routedDoc('d2', `${root}/shared/b.md`, 'p2');
    refs.upsert(item(`${root}/shared/data.csv`, 'CSV data'));
    expect(rows(`${root}/shared/data.csv`)[0]).toMatchObject({ state: 'orphaned', projectId: null });
    expect((db().prepare('SELECT COUNT(*) AS c FROM routing_decisions').get() as { c: number }).c).toBe(0);
  });

  it('walks up to the nearest folder with documents, but never above the watched folder', () => {
    project('p1');
    project('p2');
    routedDoc('d1', `${root}/mood/plan.md`, 'p1');
    routedDoc('d2', `${root}/mood/deep/notes/n.md`, 'p2'); // below the file: does not count
    routedDoc('d3', '/Users/o/top.md', 'p2'); // above the watched folder: does not count
    refs.upsert(item(`${root}/mood/deep/run/weights.pt`, 'PyTorch model'));
    expect(rows(`${root}/mood/deep/run/weights.pt`)[0].projectId).toBe('p1');
    refs.upsert(item(`${root}/other/x.json`, 'JSON data'));
    expect(rows(`${root}/other/x.json`)[0].projectId).toBeNull();
  });

  it('ignores quarantined evidence and projects that are done or archived', () => {
    project('p1');
    project('p2', 'archived');
    routedDoc('d1', `${root}/q/a.md`, 'p1', { scopeAlert: JSON.stringify({ quarantined: true, titles: ['Other'] }) });
    routedDoc('d2', `${root}/q/b.md`, 'p2');
    refs.upsert(item(`${root}/q/x.json`, 'JSON data'));
    expect(rows(`${root}/q/x.json`)[0].projectId).toBeNull();
    project('p3', 'paused');
    routedDoc('d3', `${root}/p/c.md`, 'p3');
    refs.upsert(item(`${root}/p/y.json`, 'JSON data'));
    expect(rows(`${root}/p/y.json`)[0].projectId).toBe('p3');
  });

  it('adopts unassigned references once their folder documents route, and never into a rejected project', () => {
    project('p1');
    refs.upsert(item(`${root}/later/a.json`, 'JSON data'));
    refs.upsert(item(`${root}/later/sub/b.json`, 'JSON data'));
    refs.upsert(item(`${root}/rejected/c.json`, 'JSON data'));
    refs.upsert(item(`${root}/gone/d.json`, 'JSON data'));
    refs.upsert(item(`${root}/gone/d.json`, '', { archived: 'true' }));

    // First run: sweeps every unassigned reference once and sets the watermark.
    expect(refs.adoptOrphans()).toEqual({ checked: 3, adopted: 0 });
    expect(typeof getSetting<number>(db(), 'file_references.adoption_event_id')).toBe('number');

    const rejected = rows(`${root}/rejected/c.json`)[0].id;
    db().prepare('INSERT INTO work_item_rejections (work_item_id, project_id) VALUES (?, ?)').run(rejected, 'p1');
    routedDoc('d1', `${root}/later/plan.md`, 'p1');
    routedDoc('d2', `${root}/rejected/plan.md`, 'p1');
    routedDoc('d3', `${root}/gone/plan.md`, 'p1');
    const result = refs.adoptOrphans();
    expect(result).toEqual({ checked: 3, adopted: 2 });
    expect(rows(`${root}/later/a.json`)[0]).toMatchObject({ state: 'routed', projectId: 'p1' });
    expect(rows(`${root}/later/sub/b.json`)[0].projectId).toBe('p1');
    expect(rows(`${root}/rejected/c.json`)[0].projectId).toBeNull();
    expect(rows(`${root}/gone/d.json`)[0].projectId).toBeNull();

    // Nothing new routed: nothing is checked.
    expect(refs.adoptOrphans()).toEqual({ checked: 0, adopted: 0 });
  });

  it('caches folder answers briefly; expiry and adoption pick up newly routed documents', () => {
    project('p1');
    refs.upsert(item(`${root}/c/a.json`, 'JSON data'));
    routedDoc('d1', `${root}/c/plan.md`, 'p1');
    // Within the cache window the folder still reads as empty...
    refs.upsert(item(`${root}/c/b.json`, 'JSON data'));
    expect(rows(`${root}/c/b.json`)[0].projectId).toBeNull();
    // ...after it, a new reference follows the routed document...
    clock += 31_000;
    refs.upsert(item(`${root}/c/new.json`, 'JSON data'));
    expect(rows(`${root}/c/new.json`)[0].projectId).toBe('p1');
    // ...and adoption, which runs every interpretation tick, catches up the earlier two.
    expect(refs.adoptOrphans()).toEqual({ checked: 2, adopted: 2 });
    expect(rows(`${root}/c/a.json`)[0].projectId).toBe('p1');
    expect(rows(`${root}/c/b.json`)[0].projectId).toBe('p1');
  });

  it('answers each directory level from the partial index of routed local documents', () => {
    // The statement routedProjectsIn prepares, verbatim. INDEXED BY fails to
    // prepare when the partial index cannot serve the query.
    const plan = db().prepare(`EXPLAIN QUERY PLAN
    SELECT DISTINCT w.project_id AS projectId
    FROM work_items w INDEXED BY idx_work_items_routed_local_documents
    JOIN projects p ON p.id = w.project_id
    WHERE w.source = 'filesystem' AND w.type = 'document_capture' AND w.process_state = 'routed'
      AND w.file_path >= ? AND w.file_path < ?
      AND instr(substr(w.file_path, ?), ?) = 0
      AND COALESCE(json_extract(CASE WHEN json_valid(w.scope_alert) THEN w.scope_alert ELSE '{}' END, '$.quarantined'), 0) <> 1
      AND p.status IN ('active', 'paused')
    ORDER BY w.project_id`).all('/a/', '/a0', 4, '/') as Array<{ detail: string }>;
    expect(plan.map((row) => row.detail).join(' | ')).toContain('SEARCH w USING INDEX idx_work_items_routed_local_documents (file_path>? AND file_path<?)');
  });

  it('reads a folder\'s reference signatures from the references\' path index', () => {
    const hint = referencePathIndexHint(db());
    expect(hint).toBe('INDEXED BY idx_work_items_file_reference_path');
    const plan = db().prepare(`EXPLAIN QUERY PLAN SELECT file_path FROM work_items ${hint}
      WHERE type = 'file_reference' AND file_path >= ? AND file_path < ?`).all('/a/', '/a0') as Array<{ detail: string }>;
    expect(plan.map((row) => row.detail).join(' | ')).toContain('idx_work_items_file_reference_path (file_path>? AND file_path<?)');
  });
});
