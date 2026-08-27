import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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

  function app() {
    const a = express();
    a.use(express.json());
    a.use('/api', createItemsRouter({ db: storage.getDb() } as RouterDeps));
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
