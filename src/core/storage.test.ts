import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createStorage, StorageLayer, getSetting, setSetting, migrateLosslessCapture } from './storage.js';

describe('StorageLayer', () => {
  let storage: StorageLayer;

  beforeEach(() => {
    storage = createStorage(':memory:');
    storage.initialize();
  });

  afterEach(() => {
    storage.close();
  });

  it('creates all tables', () => {
    const db = storage.getDb();
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
    ).all() as { name: string }[];
    const names = tables.map(t => t.name);

    expect(names).toContain('nodes');
    expect(names).toContain('work_items');
    expect(names).toContain('node_work_items');
    expect(names).toContain('chat_messages');
    expect(names).toContain('classification_rules');
    expect(names).toContain('embedding_config');
    expect(names).toContain('slack_api_config');
    expect(names).toContain('activity_log');
    expect(names).toContain('dedup_cache');
  });

  it('uses WAL journal mode (file-based db)', () => {
    const tmpPath = '/tmp/ppt-test-wal.db';
    const s = createStorage(tmpPath);
    s.initialize();
    const result = s.getDb().pragma('journal_mode') as { journal_mode: string }[];
    expect(result[0].journal_mode).toBe('wal');
    s.close();
    try { require('fs').unlinkSync(tmpPath); } catch {}
    try { require('fs').unlinkSync(tmpPath + '-wal'); } catch {}
    try { require('fs').unlinkSync(tmpPath + '-shm'); } catch {}
  });

  it('enforces foreign keys', () => {
    const db = storage.getDb();
    const result = db.pragma('foreign_keys') as { foreign_keys: number }[];
    expect(result[0].foreign_keys).toBe(1);
  });

  it('can insert and read a node', () => {
    const db = storage.getDb();
    db.prepare(
      "INSERT INTO nodes (id, title, status) VALUES (?, ?, ?)"
    ).run('n1', 'Test Node', 'active');

    const row = db.prepare("SELECT * FROM nodes WHERE id = ?").get('n1') as any;
    expect(row.title).toBe('Test Node');
    expect(row.status).toBe('active');
  });

  it('can insert and read a work item', () => {
    const db = storage.getDb();
    db.prepare(
      "INSERT INTO work_items (id, type, source, captured_at) VALUES (?, ?, ?, ?)"
    ).run('w1', 'website_visit', 'browser', '2026-03-20T10:00:00Z');

    const row = db.prepare("SELECT * FROM work_items WHERE id = ?").get('w1') as any;
    expect(row.type).toBe('website_visit');
    expect(row.source).toBe('browser');
  });

  it('enforces node_work_items foreign key on delete cascade', () => {
    const db = storage.getDb();
    db.prepare("INSERT INTO nodes (id, title) VALUES (?, ?)").run('n1', 'Node');
    db.prepare(
      "INSERT INTO work_items (id, type, source, captured_at) VALUES (?, ?, ?, ?)"
    ).run('w1', 'website_visit', 'browser', '2026-03-20T10:00:00Z');
    db.prepare(
      "INSERT INTO node_work_items (node_id, work_item_id) VALUES (?, ?)"
    ).run('n1', 'w1');

    // Delete node — association should cascade
    db.prepare("DELETE FROM nodes WHERE id = ?").run('n1');
    const assoc = db.prepare("SELECT * FROM node_work_items WHERE node_id = ?").all('n1');
    expect(assoc).toHaveLength(0);

    // Work item should still exist
    const wi = db.prepare("SELECT * FROM work_items WHERE id = ?").get('w1');
    expect(wi).toBeDefined();
  });

  it('queues writes when db is not initialized', () => {
    const uninit = createStorage(':memory:');
    let called = false;
    uninit.queueWrite(() => { called = true; });
    expect(called).toBe(false);

    uninit.initialize();
    // flushQueue is called during initialize
    expect(called).toBe(true);
    uninit.close();
  });

  it('persists data across close and reopen (non-memory)', () => {
    // Use a temp file for this test
    const tmpPath = '/tmp/ppt-test-persist.db';
    const s1 = createStorage(tmpPath);
    s1.initialize();
    s1.getDb().prepare("INSERT INTO nodes (id, title) VALUES (?, ?)").run('n1', 'Persist');
    s1.close();

    const s2 = createStorage(tmpPath);
    s2.initialize();
    const row = s2.getDb().prepare("SELECT * FROM nodes WHERE id = ?").get('n1') as any;
    expect(row.title).toBe('Persist');
    s2.close();

    // Cleanup
    try { require('fs').unlinkSync(tmpPath); } catch {}
    try { require('fs').unlinkSync(tmpPath + '-wal'); } catch {}
    try { require('fs').unlinkSync(tmpPath + '-shm'); } catch {}
  });
});

describe('lossless-capture-brain-pipeline migration', () => {
  let storage: StorageLayer;

  beforeEach(() => {
    storage = createStorage(':memory:');
    storage.initialize();
  });

  afterEach(() => {
    storage.close();
  });

  it('adds all lossless content + processing-state columns to work_items', () => {
    const db = storage.getDb();
    const cols = new Set(
      (db.prepare('PRAGMA table_info(work_items)').all() as { name: string }[]).map(c => c.name),
    );
    for (const c of [
      'raw_text', 'content_storage', 'content_path', 'content_sha256', 'content_bytes',
      'original_path', 'process_state', 'project_id', 'batch_id', 'extraction_kind',
      'ocr_confidence', 'incomplete',
    ]) {
      expect(cols.has(c), `missing column ${c}`).toBe(true);
    }
  });

  it('creates the new tables and the FTS virtual table', () => {
    const db = storage.getDb();
    const names = (db.prepare(
      "SELECT name FROM sqlite_master WHERE type IN ('table') ORDER BY name",
    ).all() as { name: string }[]).map(t => t.name);
    expect(names).toContain('projects');
    expect(names).toContain('item_ocr_lines');
    expect(names).toContain('failures');
    expect(names).toContain('pipeline_runs');
    expect(names).toContain('work_items_fts');
  });

  it('defaults process_state to "captured" and incomplete to 0 on insert', () => {
    const db = storage.getDb();
    db.prepare(
      'INSERT INTO work_items (id, type, source, captured_at) VALUES (?, ?, ?, ?)',
    ).run('w1', 'website_visit', 'browser', '2026-07-08T10:00:00Z');
    const row = db.prepare('SELECT process_state, incomplete, content_storage FROM work_items WHERE id = ?').get('w1') as any;
    expect(row.process_state).toBe('captured');
    expect(row.incomplete).toBe(0);
    expect(row.content_storage).toBe('inline');
  });

  it('is idempotent and non-destructive when re-run', () => {
    const db = storage.getDb();
    // Insert a row, then re-run the migration; the row must survive and new
    // columns must still be present.
    db.prepare(
      'INSERT INTO work_items (id, type, source, captured_at, raw_text) VALUES (?, ?, ?, ?, ?)',
    ).run('w1', 'website_visit', 'browser', '2026-07-08T10:00:00Z', 'hello');

    expect(() => migrateLosslessCapture(db)).not.toThrow();
    expect(() => migrateLosslessCapture(db)).not.toThrow();

    const row = db.prepare('SELECT id, raw_text FROM work_items WHERE id = ?').get('w1') as any;
    expect(row.id).toBe('w1');
    expect(row.raw_text).toBe('hello');
  });

  it('supports full-text search over the FTS table', () => {
    const db = storage.getDb();
    db.prepare(
      'INSERT INTO work_items_fts (item_id, title, body) VALUES (?, ?, ?)',
    ).run('w1', 'Livestream hotfix', 'The stream/start endpoint returns 500 on ap-south');
    // Plain token match.
    const hit = db.prepare(
      "SELECT item_id FROM work_items_fts WHERE work_items_fts MATCH 'endpoint'",
    ).get() as any;
    expect(hit?.item_id).toBe('w1');
    // Quoted phrase match (FTS5 treats '-' as syntax, so punctuation-bearing
    // terms must be quoted — the search layer will do this).
    const phraseHit = db.prepare(
      `SELECT item_id FROM work_items_fts WHERE work_items_fts MATCH '"ap-south"'`,
    ).get() as any;
    expect(phraseHit?.item_id).toBe('w1');
  });

  it('enforces the failures.step check constraint', () => {
    const db = storage.getDb();
    expect(() =>
      db.prepare('INSERT INTO failures (step, message) VALUES (?, ?)').run('bogus', 'x'),
    ).toThrow();
    expect(() =>
      db.prepare('INSERT INTO failures (item_id, step, message) VALUES (?, ?, ?)').run('w1', 'ocr', 'no text'),
    ).not.toThrow();
  });
});

describe('app_settings helpers (getSetting / setSetting)', () => {
  let storage: StorageLayer;

  beforeEach(() => {
    storage = createStorage(':memory:');
    storage.initialize();
  });

  afterEach(() => {
    storage.close();
  });

  it('getSetting returns null when the key is missing', () => {
    const db = storage.getDb();
    expect(getSetting(db, 'does.not.exist')).toBeNull();
  });

  it('setSetting then getSetting round-trips a JSON-serializable value', () => {
    const db = storage.getDb();
    const value = { ids: ['C1', 'C2'] };

    setSetting(db, 'slack.channel_config', value);

    const result = getSetting<{ ids: string[] }>(db, 'slack.channel_config');
    expect(result).toEqual(value);
  });

  it('setSetting upserts: a second write overwrites the value and bumps updated_at', async () => {
    const db = storage.getDb();
    const key = 'slack.channel_config';

    setSetting(db, key, { ids: ['C1'] });

    const firstRow = db
      .prepare('SELECT value, updated_at FROM app_settings WHERE key = ?')
      .get(key) as { value: string; updated_at: number };
    expect(JSON.parse(firstRow.value)).toEqual({ ids: ['C1'] });

    // Wait long enough that Date.now() ticks forward at least 1ms.
    await new Promise(resolve => setTimeout(resolve, 5));

    setSetting(db, key, { ids: ['C1', 'C2', 'C3'] });

    const secondRow = db
      .prepare('SELECT value, updated_at FROM app_settings WHERE key = ?')
      .get(key) as { value: string; updated_at: number };

    expect(JSON.parse(secondRow.value)).toEqual({ ids: ['C1', 'C2', 'C3'] });
    expect(secondRow.updated_at).toBeGreaterThan(firstRow.updated_at);

    // Still exactly one row for this key (upsert, not insert).
    const count = db
      .prepare('SELECT COUNT(*) as c FROM app_settings WHERE key = ?')
      .get(key) as { c: number };
    expect(count.c).toBe(1);
  });

  it('getSetting returns null when the stored value column is malformed JSON', () => {
    const db = storage.getDb();
    const key = 'broken.entry';

    // Insert a raw, non-JSON value directly to simulate corruption.
    db.prepare(
      'INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)'
    ).run(key, 'this is not json{', Date.now());

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = getSetting(db, key);

    expect(result).toBeNull();
    expect(warnSpy).toHaveBeenCalled();

    warnSpy.mockRestore();
  });
});
