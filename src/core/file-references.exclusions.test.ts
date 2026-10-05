import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';
import request from 'supertest';
import { createStorage, type StorageLayer } from './storage.js';
import { createContentStore, refToColumns } from './content-store.js';
import { createBrainStore, newBrain, type BrainStore } from './brain-store.js';
import { createFailureRecorder } from './failures.js';
import { createBrainUpdater } from './brain-updater.js';
import { SUBSTANTIVE_EVIDENCE_SQL_PREDICATE } from './evidence-gist.js';
import { buildTodayView } from './today.js';
import { listAreasWithProjects } from './project-organizer.js';
import { createNodeManager } from './node-manager.js';
import { createToolExecutor } from './tool-executor.js';
import { createPipelineRouter } from '../api/routers/pipeline.js';
import { createItemsRouter } from '../api/routers/items.js';
import type { RouterDeps } from '../api/routers/deps.js';
import type { PipelineLlm } from './pipeline-llm.js';

/**
 * A file reference is a record of a file BotBoy has not read
 * (file-references.ts). It must never be synthesized into a brief, gisted,
 * counted as evidence, or shown as a Today change, an inbox item, or a
 * project's evidence; it appears on the project's Files tab, in ⌘K, and in
 * search_items with the path chat opens.
 */
describe('file references stay out of evidence surfaces', () => {
  let storage: StorageLayer;
  let dir: string;
  let brains: BrainStore;
  const REFERENCE_MARKER = 'zebrafieldname';

  function db() { return storage.getDb(); }

  beforeEach(() => {
    storage = createStorage(':memory:');
    storage.initialize();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ppt-ref-excl-'));
    brains = createBrainStore(db(), { brainsDir: path.join(dir, 'brains') });
    brains.write(newBrain('proj_mood', 'Mood match research'));
    db().prepare(`
      INSERT INTO work_items (id, type, source, title, summary, raw_text, captured_at, process_state, project_id, batch_id, metadata, content_bytes)
      VALUES ('doc1', 'slack_message', 'slack', 'Mood match sync', 'We agreed to ship the catalog model', 'We agreed to ship the catalog model',
              '2026-10-03T10:00:00Z', 'routed', 'proj_mood', 'batch1', '{"direction":"received","channelName":"mood"}', 4000)
    `).run();
    db().prepare("INSERT INTO work_item_project_events (work_item_id, project_id) VALUES ('doc1', 'proj_mood')").run();
    storeContent('doc1', 'We agreed to ship the catalog model');
    insertReference('ref1', '/Users/o/onlineMCP/mood/metrics.json', { projectId: 'proj_mood', batchId: 'batch1' });
    insertReference('ref2', '/Users/o/onlineMCP/old/metrics.json', { projectId: 'proj_mood', archived: true });
    insertReference('ref3', '/Users/o/onlineMCP/loose/notes.csv', {});
    insertReference('ref4', '/Users/o/onlineMCP/loose/metrics.json', {});
  });

  /** Lossless content, as ingest stores it (the brain reads this, not raw_text). */
  function storeContent(id: string, text: string): void {
    const cols = refToColumns(createContentStore(db(), { contentDir: dir, inlineThresholdBytes: 1024 }).put(id, text));
    db().prepare('UPDATE work_items SET raw_text = ?, content_storage = ?, content_path = ?, content_sha256 = ?, content_bytes = ? WHERE id = ?')
      .run(cols.raw_text, cols.content_storage, cols.content_path, cols.content_sha256, cols.content_bytes, id);
  }

  afterEach(() => {
    storage.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function insertReference(id: string, filePath: string, opts: { projectId?: string; batchId?: string; archived?: boolean }): void {
    // The outline names the project, so only the type keeps it out of synthesis.
    const text = `${filePath}\nJSON data · 2.4 MB\nHeader: Mood match research training metrics.\nTop-level keys: epoch, ${REFERENCE_MARKER}\nBotBoy records this file without reading it.`;
    db().prepare(`
      INSERT INTO work_items (id, type, source, source_app, title, summary, url, file_path, raw_text, parsed_text, metadata,
                              captured_at, process_state, project_id, batch_id, content_bytes)
      VALUES (?, 'file_reference', 'filesystem', 'Local Files', ?, ?, ?, ?, ?, ?, ?, '2026-10-03T11:00:00Z', ?, ?, ?, 2400000)
    `).run(
      id, path.basename(filePath), `JSON data, 2.4 MB. Top-level keys: epoch, ${REFERENCE_MARKER}`, `file://${filePath}`, filePath, text, text,
      JSON.stringify({ filePath, fileRole: 'data', format: 'JSON', size: '2400000', mtime: String(Date.parse('2026-10-03T09:00:00Z')),
        displayPath: path.join('onlineMCP', path.relative('/Users/o/onlineMCP', filePath)), ...(opts.archived ? { archived: 'true' } : {}) }),
      opts.projectId ? 'routed' : 'orphaned', opts.projectId ?? null, opts.batchId ?? null,
    );
    if (opts.projectId) db().prepare('INSERT INTO work_item_project_events (work_item_id, project_id) VALUES (?, ?)').run(id, opts.projectId);
    db().prepare('INSERT INTO work_items_fts (item_id, title, body) VALUES (?, ?, ?)').run(id, path.basename(filePath), text);
    storeContent(id, text);
  }

  it('never reaches brain synthesis, even in a batch with evidence', async () => {
    const prompts: string[] = [];
    const llm: PipelineLlm = {
      isAvailable: () => true,
      complete: async (prompt) => {
        prompts.push(prompt);
        return JSON.stringify({ summary: 'Shipping the catalog model.', statusLine: 'active', tasks: [], blockers: [], people: [], newActivity: ['catalog model agreed'] });
      },
    };
    const updater = createBrainUpdater({
      db: db(), contentStore: createContentStore(db(), { contentDir: dir, inlineThresholdBytes: 1024 }),
      brainStore: brains, failures: createFailureRecorder(db()), llm,
    });
    await updater.runForBatch('batch1');
    expect(prompts.length).toBeGreaterThan(0);
    expect(prompts.join('\n')).toContain('ship the catalog model');
    expect(prompts.join('\n')).not.toContain(REFERENCE_MARKER);
    expect(prompts.join('\n')).not.toContain('metrics.json');

    prompts.length = 0;
    await updater.updateProject('proj_mood', ['ref1', 'ref2']);
    expect(prompts).toHaveLength(0);
  });

  it('is not substantive evidence: never gisted and never a Today change or count', () => {
    const substantive = db().prepare(`SELECT id FROM work_items WHERE ${SUBSTANTIVE_EVIDENCE_SQL_PREDICATE} ORDER BY id`).all() as Array<{ id: string }>;
    expect(substantive.map((row) => row.id)).toEqual(['doc1']);

    const view = buildTodayView(db(), brains, { now: new Date('2026-10-03T12:00:00Z') });
    const card = view.changes.find((change) => change.id === 'change:proj_mood');
    expect(card?.count).toBe(1);
    expect(card?.items.map((line) => line.itemId)).toEqual(['doc1']);
    expect(JSON.stringify(view)).not.toContain(REFERENCE_MARKER);
  });

  it('counts files apart from evidence in project lists and the project page', async () => {
    expect(listAreasWithProjects(db()).flatMap((area) => area.projects).find((p) => p.id === 'proj_mood')?.itemCount).toBe(1);

    const app = express();
    app.use(express.json());
    app.use('/api', createPipelineRouter({ db: db(), brainStore: brains } as unknown as RouterDeps));
    const list = await request(app).get('/api/projects');
    expect(list.body.projects.find((p: { id: string }) => p.id === 'proj_mood')).toMatchObject({ itemCount: 1, fileCount: 2 });

    const detail = await request(app).get('/api/projects/proj_mood');
    expect(detail.body.items.map((item: { id: string }) => item.id)).toEqual(['doc1']);
    expect(detail.body.fileCount).toBe(2);

    const files = await request(app).get('/api/projects/proj_mood/files');
    expect(files.body).toMatchObject({ total: 2, limit: 200, offset: 0 });
    expect(files.body.files.map((file: { filePath: string; deleted: boolean }) => [file.filePath, file.deleted])).toEqual([
      ['/Users/o/onlineMCP/mood/metrics.json', false], // present files first, by path
      ['/Users/o/onlineMCP/old/metrics.json', true],
    ]);
    expect(files.body.files[0]).toMatchObject({
      name: 'metrics.json', role: 'data', format: 'JSON', size: 2400000,
      displayPath: path.join('onlineMCP', 'mood', 'metrics.json'), modifiedAt: '2026-10-03T09:00:00.000Z',
    });

    const health = await request(app).get('/api/pipeline/health');
    expect(health.body.itemsByState).toEqual({ routed: 1 });
    expect(health.body.orphanCount).toBe(0);
    expect(health.body.fileReferences).toEqual({ total: 4, assigned: 2, unassigned: 2 });
  });

  it('stays out of the inbox but is found by ⌘K and search_items with its path', async () => {
    const app = express();
    app.use(express.json());
    app.use('/api', createItemsRouter({ db: db() } as RouterDeps));
    const inbox = await request(app).get('/api/items/unassigned/summary');
    expect(inbox.body).toMatchObject({ count: 0, items: [] });

    const palette = await request(app).get('/api/search').query({ q: REFERENCE_MARKER });
    const hits = palette.body.results.map((result: { item: { id: string; filePath?: string }; node: { id: string } | null }) => [result.item.id, result.item.filePath, result.node?.id ?? null]);
    // Same-named files in different folders are different files; a deleted one is gone.
    expect(hits).toEqual(expect.arrayContaining([
      ['ref1', '/Users/o/onlineMCP/mood/metrics.json', 'proj_mood'],
      ['ref3', '/Users/o/onlineMCP/loose/notes.csv', null],
      ['ref4', '/Users/o/onlineMCP/loose/metrics.json', null],
    ]));
    expect(hits).toHaveLength(3);

    const executor = createToolExecutor(db(), createNodeManager(db()));
    const result = await executor.executeTool({
      id: 't1', type: 'function',
      function: { name: 'search_items', arguments: JSON.stringify({ query: REFERENCE_MARKER }) },
    } as never);
    const rows = JSON.parse(result.content) as Array<{ id: string; type: string; filePath?: string }>;
    expect(rows.map((row) => [row.id, row.type, row.filePath]).sort()).toEqual([
      ['ref1', 'file_reference', '/Users/o/onlineMCP/mood/metrics.json'],
      ['ref3', 'file_reference', '/Users/o/onlineMCP/loose/notes.csv'],
      ['ref4', 'file_reference', '/Users/o/onlineMCP/loose/metrics.json'],
    ]);
  });
});
