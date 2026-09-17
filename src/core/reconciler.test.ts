import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import { createStorage, StorageLayer } from './storage.js';
import { createContentStore, refToColumns } from './content-store.js';
import { createBrainStore, newBrain } from './brain-store.js';
import { createBatcher } from './batcher.js';
import { createFailureRecorder } from './failures.js';
import { createReconciler } from './reconciler.js';
import type { PipelineLlm } from './pipeline-llm.js';

describe('Reconciler', () => {
  let storage: StorageLayer;
  let dir: string;

  beforeEach(() => {
    storage = createStorage(':memory:');
    storage.initialize();
    dir = mkdtempSync(path.join(os.tmpdir(), 'ppt-rec-'));
  });
  afterEach(() => {
    storage.close();
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  });

  function insertOrphan(id: string, title: string, content: string, source = 'browser') {
    const db = storage.getDb();
    const cs = createContentStore(db, { contentDir: dir, inlineThresholdBytes: 1024 });
    const ref = cs.put(id, content);
    const cols = refToColumns(ref);
    db.prepare(
      `INSERT INTO work_items (id, type, source, title, captured_at, process_state, raw_text, content_storage, content_path, content_sha256, content_bytes)
       VALUES (?, 'website_visit', ?, ?, '2026-07-08T10:00:00Z', 'orphaned', ?, ?, ?, ?, ?)`,
    ).run(id, source, title, cols.raw_text, cols.content_storage, cols.content_path, cols.content_sha256, cols.content_bytes);
  }

  function insertSlackOrphan(input: {
    id: string;
    content: string;
    timestamp: string;
    threadTs?: string;
    channelId?: string;
    direction?: 'sent' | 'received';
  }): void {
    const db = storage.getDb();
    const cs = createContentStore(db, { contentDir: dir, inlineThresholdBytes: 1024 });
    const ref = cs.put(input.id, input.content);
    const cols = refToColumns(ref);
    const metadata = JSON.stringify({
      channelId: input.channelId ?? 'C_THREAD',
      channelName: 'thread-routing-test',
      channelType: 'private_channel',
      timestamp: input.timestamp,
      threadTs: input.threadTs ?? '',
      direction: input.direction ?? 'received',
      engaged: 'true',
      mentionedMe: 'true',
      userId: input.direction === 'sent' ? 'U_OWNER' : 'U_PARTNER',
    });
    db.prepare(`
      INSERT INTO work_items
        (id,type,source,title,captured_at,process_state,raw_text,
         content_storage,content_path,content_sha256,content_bytes,metadata)
      VALUES (?, 'slack_message','slack','Slack #thread-routing-test',?,
              'orphaned',?,?,?,?,?,?)
    `).run(
      input.id,
      new Date(Number.parseFloat(input.timestamp) * 1000).toISOString(),
      cols.raw_text,
      cols.content_storage,
      cols.content_path,
      cols.content_sha256,
      cols.content_bytes,
      metadata,
    );
  }

  function build(llm: PipelineLlm) {
    const db = storage.getDb();
    const brains = createBrainStore(db, { brainsDir: path.join(dir, 'brains') });
    const reconciler = createReconciler({
      db,
      batcher: createBatcher(db, {}),
      contentStore: createContentStore(db, { contentDir: dir, inlineThresholdBytes: 1024 }),
      brainStore: brains,
      failures: createFailureRecorder(db),
      llm,
    });
    return { brains, reconciler };
  }

  const mockLlm = (obj: unknown): PipelineLlm => ({ isAvailable: () => true, complete: async () => JSON.stringify(obj) });

  it('rescues an exact 1+17 orphan Slack thread into one existing project without collapsing rows', async () => {
    const rootTs = '1789528187.778509';
    const replyIds = Array.from({ length: 17 }, (_, index) => `reply-${String(index + 1).padStart(2, '0')}`);
    let prompt = '';
    const { brains, reconciler } = build({
      isAvailable: () => true,
      complete: async (value) => {
        prompt = value;
        if (!value.includes('SLACK THREAD RECONCILIATION')) throw new Error('thread rows must not bypass into generic reconciliation');
        return JSON.stringify({
          decision: 'assign',
          projectId: 'proj_catalog',
          supportedThroughItemId: replyIds[replyIds.length - 1],
          reason: 'The bounded conversation concerns catalog unification and migration compatibility.',
        });
      },
    });
    brains.write(newBrain('proj_catalog', 'MX_PV_Catalog_Unification_Workshop'));
    brains.write(newBrain('proj_review', 'Unified PV-AMXP Product & Tech Review'));
    insertSlackOrphan({
      id: 'root', timestamp: rootTs,
      content: 'Support for all MX features will remain until the PV system can take over.',
    });
    for (const [index, id] of replyIds.entries()) {
      const content = index === 0
        ? 'The MX PV catalog unification migration keeps compatibility during the transition.'
        : index % 3 === 0
          ? 'Shuriken routes the new client path to Android API while the old path continues.'
          : index % 3 === 1
            ? 'Terraform downloads compatibility remains part of this catalog migration discussion.'
            : 'The client and backend phases stay within the MX PV catalog unification rollout.';
      insertSlackOrphan({
        id,
        content,
        timestamp: `${1789528188 + index}.000001`,
        threadTs: rootTs,
        direction: index % 4 === 0 ? 'sent' : 'received',
      });
    }

    const result = await reconciler.run();
    expect(result.itemsAdopted).toBe(18);
    expect(result.adoptedItems).toHaveLength(18);
    expect(result.projectsCreated).toBe(0);
    expect(prompt).toContain('<thread_message index="1" role="root" id="root"');
    expect(prompt).toContain('<thread_message index="18" role="reply" id="reply-17"');

    const db = storage.getDb();
    const rows = db.prepare("SELECT id,process_state,project_id,batch_id FROM work_items WHERE id='root' OR id LIKE 'reply-%'").all() as any[];
    expect(rows).toHaveLength(18);
    expect(rows.every((row) => row.process_state === 'routed' && row.project_id === 'proj_catalog')).toBe(true);
    expect(rows.every((row) => row.batch_id === null)).toBe(true);
    expect((db.prepare("SELECT COUNT(*) AS n FROM routing_decisions WHERE applied_project_id='proj_catalog'").get() as any).n).toBe(18);
    expect((db.prepare("SELECT COUNT(*) AS n FROM work_item_project_events WHERE project_id='proj_catalog'").get() as any).n).toBe(18);
    const rootReason = (db.prepare("SELECT validation_reason AS reason FROM routing_decisions WHERE item_id='root' ORDER BY id DESC LIMIT 1").get() as any).reason;
    expect(rootReason).toContain('reconciled Slack thread scope (proj_catalog)');
    expect(brains.listProjects()).toHaveLength(2);
  });

  it('routes only the contiguous model-supported prefix and leaves later scope drift orphaned', async () => {
    const rootTs = '200.000001';
    const { brains, reconciler } = build({
      isAvailable: () => true,
      complete: async (prompt) => {
        if (!prompt.includes('SLACK THREAD RECONCILIATION')) throw new Error('generic bypass');
        return JSON.stringify({
          decision: 'assign', projectId: 'proj_catalog', supportedThroughItemId: 'reply-2',
        });
      },
    });
    brains.write(newBrain('proj_catalog', 'Catalog Unification Migration'));
    brains.write(newBrain('proj_checkout', 'Checkout Reliability Launch'));
    insertSlackOrphan({ id: 'root', timestamp: rootTs, content: 'Catalog migration compatibility question.' });
    insertSlackOrphan({ id: 'reply-1', timestamp: '201.000001', threadTs: rootTs, content: 'Catalog unification migration keeps the old client path.' });
    insertSlackOrphan({ id: 'reply-2', timestamp: '202.000001', threadTs: rootTs, content: 'Catalog migration rollout remains compatible.' });
    insertSlackOrphan({ id: 'reply-3', timestamp: '203.000001', threadTs: rootTs, content: 'Checkout Reliability Launch incident is now the separate topic.' });

    const result = await reconciler.run();
    expect(result.itemsAdopted).toBe(3);
    const db = storage.getDb();
    expect(db.prepare("SELECT process_state,project_id FROM work_items WHERE id='reply-2'").get()).toMatchObject({ process_state: 'routed', project_id: 'proj_catalog' });
    expect(db.prepare("SELECT process_state,project_id FROM work_items WHERE id='reply-3'").get()).toMatchObject({ process_state: 'orphaned', project_id: null });
    const outside = db.prepare("SELECT validation_reason AS reason FROM routing_decisions WHERE item_id='reply-3' ORDER BY id DESC LIMIT 1").get() as any;
    expect(outside.reason).toContain('outside supported contiguous thread prefix');
  });

  it('fails closed when the selected prefix contains a dominant independent project scope', async () => {
    const rootTs = '300.000001';
    let calls = 0;
    const { brains, reconciler } = build({
      isAvailable: () => true,
      complete: async () => {
        calls++;
        return JSON.stringify({ decision: 'assign', projectId: 'proj_a', supportedThroughItemId: 'reply' });
      },
    });
    brains.write(newBrain('proj_a', 'Catalog Unification Migration'));
    brains.write(newBrain('proj_b', 'Checkout Reliability Launch'));
    insertSlackOrphan({ id: 'root', timestamp: rootTs, content: 'Catalog Unification Migration plan.' });
    insertSlackOrphan({ id: 'reply', timestamp: '301.000001', threadTs: rootTs, content: 'Checkout Reliability Launch is now the separate incident.' });

    const result = await reconciler.run();
    expect(calls).toBe(1);
    expect(result.itemsAdopted).toBe(0);
    const rows = storage.getDb().prepare("SELECT process_state FROM work_items WHERE id IN ('root','reply')").all() as any[];
    expect(rows.every((row) => row.process_state === 'orphaned')).toBe(true);
    const reason = storage.getDb().prepare("SELECT validation_reason AS reason FROM routing_decisions WHERE item_id='root' ORDER BY id DESC LIMIT 1").get() as any;
    expect(reason.reason).toContain('foreign scope');
  });

  it('does not call the model for malformed or over-cap thread snapshots', async () => {
    let calls = 0;
    const { reconciler } = build({
      isAvailable: () => true,
      complete: async () => {
        calls++;
        return '{}';
      },
    });
    insertSlackOrphan({ id: 'bad-root', timestamp: '500.000001', content: 'Malformed thread root.' });
    insertSlackOrphan({ id: 'bad-reply', timestamp: '499.000001', threadTs: '500.000001', content: 'Reply points forward.' });

    const rootTs = '600.000001';
    insertSlackOrphan({ id: 'large-root', timestamp: rootTs, content: 'Large thread root.' });
    for (let index = 0; index < 20; index++) {
      insertSlackOrphan({
        id: `large-${index}`,
        timestamp: `${601 + index}.000001`,
        threadTs: rootTs,
        content: `Large thread reply ${index}`,
      });
    }

    const result = await reconciler.run();
    expect(calls).toBe(0);
    expect(result.itemsAdopted).toBe(0);
    expect((storage.getDb().prepare("SELECT COUNT(*) AS n FROM work_items WHERE process_state='orphaned'").get() as any).n).toBe(23);
  });

  it('creates a new project from related orphans and routes them (R8.2)', async () => {
    // Passive evidence founds a project only via a distinctive anchor; here
    // each item carries the exact proposed title phrase.
    insertOrphan('a', 'invoice March', 'Client Invoicing — client invoice #1');
    insertOrphan('b', 'invoice April', 'Client Invoicing — client invoice #2');
    insertOrphan('c', 'unrelated', 'random note');

    const { brains, reconciler } = build(
      mockLlm({ newProjects: [{ title: 'Client Invoicing', itemIds: ['a', 'b'] }] }),
    );
    const res = await reconciler.run();
    expect(res.projectsCreated).toBe(1);
    expect(res.itemsAdopted).toBe(2);

    const projects = brains.listProjects();
    expect(projects[0].title).toBe('Client Invoicing');

    const db = storage.getDb();
    expect((db.prepare('SELECT process_state FROM work_items WHERE id = ?').get('a') as any).process_state).toBe('routed');
    expect((db.prepare('SELECT process_state FROM work_items WHERE id = ?').get('b') as any).process_state).toBe('routed');
    // Unrelated orphan stays orphaned (R8.5).
    expect((db.prepare('SELECT process_state FROM work_items WHERE id = ?').get('c') as any).process_state).toBe('orphaned');
  });

  it('keeps passive orphans orphaned when they share only ordinary words with a proposed umbrella title (folder-dump regression, 2026-07-08)', async () => {
    // Two unrelated files from one Downloads ingest: each matches two ordinary
    // tokens of the vague umbrella title, but neither carries a distinctive
    // identifier, the exact title phrase, or a filename-stem anchor. Arrival
    // together must not found a project.
    insertOrphan('a', 'product review notes', 'content ingestion platform review for the product plan');
    insertOrphan('b', 'genre screenshots', 'micro drama platform research screenshots');
    const { reconciler } = build(
      mockLlm({ newProjects: [{ title: 'Content Platform Research', itemIds: ['a', 'b'] }] }),
    );
    const res = await reconciler.run();
    expect(res.projectsCreated).toBe(0);
    expect(res.itemsAdopted).toBe(0);
    const db = storage.getDb();
    expect((db.prepare('SELECT process_state FROM work_items WHERE id = ?').get('a') as any).process_state).toBe('orphaned');
    expect((db.prepare('SELECT process_state FROM work_items WHERE id = ?').get('b') as any).process_state).toBe('orphaned');
    const reasons = db.prepare('SELECT validation_reason AS r FROM routing_decisions').all() as { r: string }[];
    expect(reasons.some((row) => row.r.includes('distinctive anchor'))).toBe(true);
  });

  it('P9: defers when the LLM is unavailable, changing nothing', async () => {
    insertOrphan('a', 'x', 'y');
    const { reconciler } = build({ isAvailable: () => false, complete: async () => '' });
    const res = await reconciler.run();
    expect(res.status).toBe('deferred');
    expect((storage.getDb().prepare('SELECT process_state FROM work_items WHERE id = ?').get('a') as any).process_state).toBe('orphaned');
  });

  it('ignores proposed itemIds that are not actually orphans', async () => {
    insertOrphan('a', 'content migration plan', 'content migration plan', 'manual');
    const { reconciler } = build(
      mockLlm({ newProjects: [{ title: 'Content Migration', itemIds: ['a', 'does-not-exist'] }] }),
    );
    const res = await reconciler.run();
    expect(res.itemsAdopted).toBe(1); // only the real orphan
  });

  it('counts advisory merges/splits without applying them', async () => {
    insertOrphan('a', 'x', 'y');
    const { brains, reconciler } = build(
      mockLlm({ newProjects: [], merges: [{ projectIds: ['p1', 'p2'] }], splits: [{ projectId: 'p3' }] }),
    );
    const res = await reconciler.run();
    expect(res.advisoryMerges).toBe(1);
    expect(res.advisorySplits).toBe(1);
    expect(res.projectsCreated).toBe(0);
    // orphan remains
    expect((storage.getDb().prepare('SELECT process_state FROM work_items WHERE id = ?').get('a') as any).process_state).toBe('orphaned');
  });
});
