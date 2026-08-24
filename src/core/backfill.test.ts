import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import { createStorage, StorageLayer } from './storage.js';
import { createContentStore } from './content-store.js';
import { createBrainStore } from './brain-store.js';
import { createFailureRecorder } from './failures.js';
import { createBackfiller } from './backfill.js';

describe('Backfill', () => {
  let storage: StorageLayer;
  let dir: string;

  beforeEach(() => {
    storage = createStorage(':memory:');
    storage.initialize();
    dir = mkdtempSync(path.join(os.tmpdir(), 'ppt-bf-'));
  });
  afterEach(() => {
    storage.close();
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  });

  function build() {
    const db = storage.getDb();
    return createBackfiller({
      db,
      contentStore: createContentStore(db, { contentDir: dir, inlineThresholdBytes: 1024 }),
      brainStore: createBrainStore(db, { brainsDir: path.join(dir, 'brains') }),
      failures: createFailureRecorder(db),
    });
  }

  // Insert a legacy row the way the OLD pipeline did (no content_* columns set).
  function legacy(id: string, opts: { parsed?: string; summary?: string; source?: string } = {}) {
    storage.getDb().prepare(
      `INSERT INTO work_items (id, type, source, captured_at, parsed_text, summary)
       VALUES (?, 'website_visit', ?, '2026-06-01T10:00:00Z', ?, ?)`,
    ).run(id, opts.source ?? 'browser', opts.parsed ?? null, opts.summary ?? null);
  }

  it('migrates legacy content into the ContentStore and preserves the row', () => {
    legacy('a', { parsed: 'full parsed text', summary: 'preview' });
    const bf = build();
    const res = bf.backfillContent();
    expect(res.migrated).toBe(1);

    const row = storage.getDb().prepare('SELECT * FROM work_items WHERE id = ?').get('a') as any;
    expect(row.content_sha256).toBeTruthy();
    expect(row.content_bytes).toBe(Buffer.byteLength('full parsed text'));
    expect(row.raw_text).toBe('full parsed text');
    expect(row.process_state).toBe('extracted');
  });

  it('is idempotent: a second run migrates nothing new', () => {
    legacy('a', { parsed: 'x' });
    const bf = build();
    expect(bf.backfillContent().migrated).toBe(1);
    expect(bf.backfillContent().migrated).toBe(0);
  });

  it('flags likely-truncated legacy content (at the old cap) as incomplete', () => {
    legacy('big', { parsed: 'Z'.repeat(15000), source: 'browser' }); // no source file
    const bf = build();
    const res = bf.backfillContent();
    expect(res.flaggedPartial).toBe(1);
    const row = storage.getDb().prepare('SELECT incomplete FROM work_items WHERE id = ?').get('big') as any;
    expect(row.incomplete).toBe(1);
    const fail = storage.getDb().prepare("SELECT * FROM failures WHERE step = 'migration'").get() as any;
    expect(fail.message).toContain('legacy_partial');
  });

  it('does not flag short legacy content', () => {
    legacy('small', { parsed: 'short' });
    const bf = build();
    expect(bf.backfillContent().flaggedPartial).toBe(0);
  });

  it('seeds projects from active nodes and routes their assigned items', () => {
    const db = storage.getDb();
    db.prepare("INSERT INTO nodes (id, title, description, status) VALUES ('n1', 'Livestream', 'prod work', 'active')").run();
    db.prepare("INSERT INTO nodes (id, title, status) VALUES ('n2', 'Archived thing', 'archived')").run();
    legacy('a', { parsed: 'text' });
    db.prepare("INSERT INTO node_work_items (node_id, work_item_id) VALUES ('n1', 'a')").run();

    const bf = build();
    bf.backfillContent();
    const res = bf.seedProjectsFromNodes();
    expect(res.seeded).toBe(1); // only the active node
    expect(res.routed).toBe(1);

    const proj = db.prepare("SELECT * FROM projects WHERE id = 'proj_node_n1'").get() as any;
    expect(proj.title).toBe('Livestream');
    const item = db.prepare('SELECT project_id, process_state FROM work_items WHERE id = ?').get('a') as any;
    expect(item.project_id).toBe('proj_node_n1');
    expect(item.process_state).toBe('routed');
  });

  it('full run reports aggregate stats and is safe to re-run', () => {
    const db = storage.getDb();
    db.prepare("INSERT INTO nodes (id, title, status) VALUES ('n1', 'Node', 'active')").run();
    legacy('a', { parsed: 'text' });
    const bf = build();
    const first = bf.run();
    expect(first.itemsMigrated).toBe(1);
    expect(first.projectsSeeded).toBe(1);
    const second = bf.run();
    expect(second.itemsMigrated).toBe(0);
    expect(second.projectsSeeded).toBe(0);
  });
});
