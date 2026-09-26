import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createItemsRouter } from './items.js';
import { createStorage, type StorageLayer } from '../../core/storage.js';
import type { RouterDeps } from './deps.js';

/**
 * Command-palette search dedup (owner report 2026-08-27): one SharePoint
 * document showed once PER REVISION/COMMENT (every synced revision and
 * comment is its own work_items row sharing a docKey) and the node join
 * fanned single items into a row per node. Results now collapse to one
 * entry per docKey (newest row wins, collapsed count reported, docKey
 * carried so the UI routes to the staged reader) and one entry per item.
 */
describe('GET /api/search', () => {
  let storage: StorageLayer;

  beforeEach(() => { storage = createStorage(':memory:'); storage.initialize(); });
  afterEach(() => storage.close());

  function app(extra: Partial<RouterDeps> = {}) {
    const a = express();
    a.use(express.json());
    a.use('/api', createItemsRouter({ db: storage.getDb(), ...extra } as RouterDeps));
    return a;
  }

  const DOC_KEY = 'amazon.sharepoint.com/sites/t/Shared Documents/HLD.docx';

  function insertDocRow(id: string, type: 'document_capture' | 'document_comment', capturedAt: string, rev = '') {
    storage.getDb().prepare(`
      INSERT INTO work_items (id, type, source, title, url, captured_at, process_state, metadata, raw_text)
      VALUES (?, ?, 'sharepoint', 'HLD.docx unification design', ?, ?, 'routed', ?, 'catalog unification body text')
    `).run(id, type, `https://x/hld${rev}`, capturedAt, JSON.stringify({ docKey: DOC_KEY }));
  }

  it('collapses revisions and comments of one document into a single result carrying docKey', async () => {
    insertDocRow('c1', 'document_capture', '2026-08-20T10:00:00Z');
    insertDocRow('c2', 'document_capture', '2026-08-24T10:00:00Z', '#rev=c2');
    insertDocRow('c3', 'document_capture', '2026-08-26T10:00:00Z', '#rev=c3');
    insertDocRow('m1', 'document_comment', '2026-08-25T10:00:00Z', '#comment=m1');
    const res = await request(app()).get('/api/search').query({ q: 'unification' });
    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(1);
    const hit = res.body.results[0];
    expect(hit.item.docKey).toBe(DOC_KEY);
    expect(hit.item.id).toBe('c3'); // newest row wins
    expect(hit.item.collapsedCount).toBe(3);
  });

  it('excludes retired publication captures and comments from active search', async () => {
    const db = storage.getDb();
    const retired = JSON.stringify({ docKey: DOC_KEY, publicationRetired: 'true' });
    db.prepare(`
      INSERT INTO work_items (id, type, source, title, url, captured_at, process_state, metadata, raw_text)
      VALUES ('retired-cap', 'document_capture', 'sharepoint', 'retired unification publication', 'https://x/retired', '2026-09-16T10:00:00Z', 'routed', ?, 'retired body')
    `).run(retired);
    db.prepare(`
      INSERT INTO work_items (id, type, source, title, url, captured_at, process_state, metadata, raw_text)
      VALUES ('retired-comment', 'document_comment', 'sharepoint', 'retired unification comment', 'https://x/retired#comment=1', '2026-09-16T10:01:00Z', 'routed', ?, 'retired note')
    `).run(JSON.stringify({ docKey: DOC_KEY, publicationRetired: 'true', deletedFromDoc: 'true' }));
    const res = await request(app()).get('/api/search').query({ q: 'retired unification' });
    expect(res.status).toBe(200);
    expect(res.body.results).toEqual([]);
  });

  it('collapses node-join fan-out to one row per item and leaves non-doc items untouched', async () => {
    const db = storage.getDb();
    db.prepare(`
      INSERT INTO work_items (id, type, source, title, url, captured_at, process_state, raw_text)
      VALUES ('s1', 'slack_message', 'slack', 'unification thread', 'https://slack/x', '2026-08-25T10:00:00Z', 'routed', 'body')
    `).run();
    db.prepare("INSERT INTO nodes (id, title) VALUES ('n1', 'Node One')").run();
    db.prepare("INSERT INTO nodes (id, title) VALUES ('n2', 'Node Two')").run();
    db.prepare("INSERT INTO node_work_items (node_id, work_item_id) VALUES ('n1', 's1')").run();
    db.prepare("INSERT INTO node_work_items (node_id, work_item_id) VALUES ('n2', 's1')").run();
    const res = await request(app()).get('/api/search').query({ q: 'unification' });
    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(1);
    expect(res.body.results[0].item.id).toBe('s1');
    expect(res.body.results[0].item.docKey).toBeUndefined();
    expect(res.body.results[0].item.url).toBe('https://slack/x');
  });
  it('reserves bounded result slots for both authored documents and evidence', async () => {
    const db = storage.getDb();
    for (let index = 0; index < 5; index++) {
      db.prepare(`
        INSERT INTO work_items (id, type, source, title, captured_at, process_state, raw_text)
        VALUES (?, 'slack_message', 'slack', ?, ?, 'routed', 'catalog evidence')
      `).run(`e${index}`, `catalog evidence ${index}`, `2026-09-1${index}T00:00:00Z`);
    }
    const service = {
      listArtifacts: () => Array.from({ length: 5 }, (_, index) => ({
        artifactId: `a${index}`, title: `catalog authored ${index}`,
        profileId: 'business_document/adaptive.v1', createdAt: `2026-09-1${index}T01:00:00Z`,
        state: 'ready_for_review',
      })),
    };
    const res = await request(app({ productDocumentService: service as never }))
      .get('/api/search').query({ q: 'catalog', limit: 4 });
    expect(res.body.results).toHaveLength(4);
    expect(res.body.results.some((result: any) => result.item.artifactId)).toBe(true);
    expect(res.body.results.some((result: any) => result.item.source === 'slack')).toBe(true);
  });

  it('composes one typed authored-chain hit without inserting synthetic evidence', async () => {
    storage.getDb().prepare(`
      INSERT INTO projects (id, title, one_liner, brain_path, status)
      VALUES ('p1', 'Catalog unification', '', '/tmp/brain', 'active')
    `).run();
    const service = {
      listArtifacts: () => [
        {
          artifactId: 'artifact-v2', projectId: 'p1', parentArtifactId: 'artifact-v1',
          title: 'Unified document catalog', profileId: 'business_document/adaptive.v1',
          createdAt: '2026-09-16T02:00:00Z', state: 'ready_for_review',
        },
        {
          artifactId: 'artifact-v1', projectId: 'p1',
          title: 'Unified document catalog', profileId: 'business_document/adaptive.v1',
          createdAt: '2026-09-16T01:00:00Z', state: 'draft_review',
        },
      ],
    };
    const res = await request(app({ productDocumentService: service as never }))
      .get('/api/search').query({ q: 'catalog' });
    const authored = res.body.results.filter((result: any) => result.item.artifactId);
    expect(authored).toHaveLength(1);
    expect(authored[0]).toMatchObject({
      item: {
        artifactId: 'artifact-v2',
        type: 'product_document_artifact',
        projectId: 'p1',
      },
      node: { id: 'p1', title: 'Catalog unification' },
    });
    expect((storage.getDb().prepare("SELECT COUNT(*) AS count FROM work_items WHERE source = 'botboy'").get() as { count: number }).count).toBe(0);
  });

  it('treats malformed legacy metadata as empty JSON instead of aborting search', async () => {
    const db = storage.getDb();
    db.prepare(`
      INSERT INTO work_items (id, type, source, title, captured_at, process_state, metadata, raw_text)
      VALUES ('bad-meta', 'slack_message', 'slack', 'malformed catalog metadata',
        '2026-09-21T00:00:00Z', 'routed', '{not-json', 'catalog body')
    `).run();
    const response = await request(app()).get('/api/search').query({ q: 'malformed catalog' });
    expect(response.status).toBe(200);
    expect(response.body.results).toHaveLength(1);
    expect(response.body.results[0].item).toMatchObject({ id: 'bad-meta', source: 'slack' });
  });

  it('merges exact typed datasets, authored chains, and evidence without writes or version hits', async () => {
    const db = storage.getDb();
    db.prepare(`
      INSERT INTO work_items (id, type, source, title, captured_at, process_state, raw_text)
      VALUES ('search-evidence', 'slack_message', 'slack', 'catalog shared title evidence',
        '2026-09-21T00:00:00Z', 'routed', 'catalog')
    `).run();
    const searchDatasets = vi.fn((query: string, limit = 25) => {
      if (query.startsWith('dsv_')) return [];
      const hits = [
        {
          datasetId: 'ds_search_exact', name: 'Catalog shared title', description: 'Exact logical dataset',
          kind: 'source', scope: 'workspace', domainKey: 'search', lifecycle: 'active',
          updatedAt: '2026-09-21T02:00:00Z', matchField: query === 'ds_search_exact' ? 'id' : 'name',
          currentVersion: { id: `dsv_${'a'.repeat(24)}`, ordinal: 2, materializedAt: '2026-09-21T02:00:00Z', integrityStatus: 'verified' },
        },
        {
          datasetId: 'ds_search_same_title', name: 'Catalog shared title', description: 'Second logical dataset',
          kind: 'derived', scope: 'workspace', domainKey: 'search', lifecycle: 'active',
          updatedAt: '2026-09-21T01:00:00Z', matchField: 'name',
        },
      ];
      return (query === 'ds_search_exact' ? hits : query.includes('catalog') ? hits : []).slice(0, limit);
    });
    const analyticsDataRoom = { searchDatasets } as never;
    const productDocumentService = {
      listArtifacts: () => [{
        artifactId: 'artifact-search', title: 'Catalog authored document',
        profileId: 'business_document/adaptive.v1', createdAt: '2026-09-21T01:00:00Z',
        state: 'ready_for_review',
      }],
    } as never;
    const beforeChanges = db.totalChanges;
    const beforeItems = (db.prepare('SELECT COUNT(*) AS count FROM work_items').get() as { count: number }).count;

    const exact = await request(app({ analyticsDataRoom })).get('/api/search').query({ q: 'ds_search_exact', limit: 5 });
    expect(exact.body.results[0]).toMatchObject({
      item: {
        id: 'ds_search_exact', datasetId: 'ds_search_exact', type: 'analytics_dataset',
        source: 'analytics', sourceApp: 'BotBoy', currentVersion: { ordinal: 2 },
      },
      node: null,
      matchField: 'id',
    });

    const merged = await request(app({ analyticsDataRoom, productDocumentService }))
      .get('/api/search').query({ q: 'catalog', limit: 6 });
    expect(merged.status).toBe(200);
    expect(merged.body.totalResults).toBe(4);
    expect(merged.body.results.slice(0, 2).map((result: any) => result.item.datasetId))
      .toEqual(['ds_search_exact', 'ds_search_same_title']);
    expect(merged.body.results.some((result: any) => result.item.artifactId === 'artifact-search')).toBe(true);
    expect(merged.body.results.some((result: any) => result.item.id === 'search-evidence')).toBe(true);
    expect(new Set(merged.body.results.filter((result: any) => result.item.datasetId)
      .map((result: any) => result.item.datasetId)).size).toBe(2);

    const versionOnly = await request(app({ analyticsDataRoom })).get('/api/search')
      .query({ q: `dsv_${'a'.repeat(24)}`, limit: 5 });
    expect(versionOnly.body.results).toEqual([]);
    expect(searchDatasets).toHaveBeenCalled();
    expect(db.totalChanges).toBe(beforeChanges);
    expect((db.prepare('SELECT COUNT(*) AS count FROM work_items').get() as { count: number }).count).toBe(beforeItems);
  });
});

/**
 * Second live pass (same report): the palette still showed five look-alike
 * rows — repeat browser visits titled with the doc name — and a comment row
 * being newest had retitled the document entry ("Comment by …" as the
 * Documents-group representative).
 */
describe('GET /api/search — representatives and look-alikes', () => {
  let storage: StorageLayer;

  beforeEach(() => { storage = createStorage(':memory:'); storage.initialize(); });
  afterEach(() => storage.close());

  function app() {
    const a = express();
    a.use(express.json());
    a.use('/api', createItemsRouter({ db: storage.getDb() } as RouterDeps));
    return a;
  }

  it('a newer comment never retitles the document entry — the newest CAPTURE reps the group', async () => {
    const db = storage.getDb();
    const meta = JSON.stringify({ docKey: 'k/HLD.docx' });
    db.prepare(`
      INSERT INTO work_items (id, type, source, title, url, captured_at, process_state, metadata, raw_text)
      VALUES ('cap1', 'document_capture', 'sharepoint', 'HLD unification design', 'https://x/hld', '2026-08-24T10:00:00Z', 'routed', ?, 'body')
    `).run(meta);
    db.prepare(`
      INSERT INTO work_items (id, type, source, title, url, captured_at, process_state, metadata, raw_text)
      VALUES ('com1', 'document_comment', 'sharepoint', 'Comment by AB on HLD unification design', 'https://x/hld#comment=1', '2026-08-26T10:00:00Z', 'routed', ?, 'note')
    `).run(meta);
    const res = await request(app()).get('/api/search').query({ q: 'unification' });
    expect(res.body.results).toHaveLength(1);
    expect(res.body.results[0].item.id).toBe('cap1');
    expect(res.body.results[0].item.title).toBe('HLD unification design');
    expect(res.body.results[0].item.collapsedCount).toBe(1);
  });

  it('repeat ambient captures with identical source+type+title collapse to the newest', async () => {
    const db = storage.getDb();
    for (let i = 0; i < 4; i++) {
      db.prepare(`
        INSERT INTO work_items (id, type, source, title, url, captured_at, process_state, raw_text)
        VALUES (?, 'browser_visit', 'browser', 'HLD unification design - SharePoint', ?, ?, 'routed', 'page text')
      `).run(`v${i}`, `https://sp/doc?visit=${i}`, `2026-08-2${i + 2}T10:00:00Z`);
    }
    db.prepare(`
      INSERT INTO work_items (id, type, source, title, url, captured_at, process_state, raw_text)
      VALUES ('other', 'browser_visit', 'browser', 'Different unification page', 'https://sp/other', '2026-08-26T09:00:00Z', 'routed', 'text')
    `).run();
    const res = await request(app()).get('/api/search').query({ q: 'unification' });
    expect(res.body.results).toHaveLength(2);
    const collapsed = res.body.results.find((x: any) => x.item.id === 'v3');
    expect(collapsed).toBeTruthy();
    expect(collapsed.item.collapsedCount).toBe(3);
  });
});
