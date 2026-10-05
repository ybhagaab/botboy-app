import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createStorage, type StorageLayer } from './storage.js';
import { deleteWorkItemFts, setWorkItemFtsTitle } from './work-items-fts.js';

/**
 * Per-item search-index writes go through an index on the FTS5 content
 * table instead of scanning every row (live 2026-10-02: 0.3–0.6 s per call,
 * a 25.6 s boot stall for a 53-row sweep). The contract: same rows affected
 * as `WHERE item_id = ?`, found through the index.
 */
describe('work-items-fts', () => {
  let storage: StorageLayer;

  beforeEach(() => {
    storage = createStorage(':memory:');
    storage.initialize();
    const insert = storage.getDb().prepare('INSERT INTO work_items_fts (item_id, title, body) VALUES (?, ?, ?)');
    insert.run('a', 'Alpha plan', 'alphaterm first copy');
    insert.run('a', 'Alpha plan', 'alphaterm duplicate copy'); // a duplicate row for the same item
    insert.run('b', 'Beta plan', 'betaterm body');
  });

  afterEach(() => storage.close());

  const rowsFor = (itemId: string) =>
    (storage.getDb().prepare('SELECT COUNT(*) AS c FROM work_items_fts WHERE item_id = ?').get(itemId) as { c: number }).c;
  const matches = (term: string) =>
    (storage.getDb().prepare('SELECT item_id FROM work_items_fts WHERE work_items_fts MATCH ?').all(term) as Array<{ item_id: string }>)
      .map(row => row.item_id);

  it('storage indexes the item column of the FTS5 content table', () => {
    const index = storage.getDb().prepare(
      "SELECT tbl_name FROM sqlite_master WHERE type = 'index' AND name = 'idx_work_items_fts_content_item'",
    ).get() as { tbl_name: string } | undefined;
    expect(index?.tbl_name).toBe('work_items_fts_content');
  });

  it('deleteWorkItemFts removes every row for the item, duplicates included, and nothing else', () => {
    deleteWorkItemFts(storage.getDb(), 'a');
    expect(rowsFor('a')).toBe(0);
    expect(rowsFor('b')).toBe(1);
    expect(matches('alphaterm')).toEqual([]);
    expect(matches('betaterm')).toEqual(['b']);
    deleteWorkItemFts(storage.getDb(), 'missing'); // no rows: no error, no change
    expect(rowsFor('b')).toBe(1);
    storage.getDb().exec("INSERT INTO work_items_fts(work_items_fts) VALUES('integrity-check')");
  });

  it('setWorkItemFtsTitle retitles every row for the item and keeps the body searchable', () => {
    setWorkItemFtsTitle(storage.getDb(), 'a', 'Renamed zetaterm');
    expect(matches('zetaterm')).toEqual(['a', 'a']);
    expect(matches('alphaterm')).toEqual(['a', 'a']);
    expect(matches('betaterm')).toEqual(['b']);
    storage.getDb().exec("INSERT INTO work_items_fts(work_items_fts) VALUES('integrity-check')");
  });

  it('finds rows through the index instead of scanning the search index', () => {
    const plan = (storage.getDb().prepare(
      'EXPLAIN QUERY PLAN DELETE FROM work_items_fts WHERE rowid IN (SELECT id FROM work_items_fts_content WHERE c0 = ?)',
    ).all('a') as Array<{ detail: string }>).map(row => row.detail).join(' | ');
    expect(plan).toContain('idx_work_items_fts_content_item');
  });

  it('leaves FTS5’s own reads, search, and maintenance commands on their existing plans', () => {
    const db = storage.getDb();
    const plan = (sql: string, ...args: unknown[]) =>
      (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args) as Array<{ detail: string }>).map(row => row.detail).join(' | ');
    // The statement shapes FTS5 runs against its content table: by rowid, and a full ordered scan.
    expect(plan('SELECT T.id, T.c0, T.c1, T.c2 FROM work_items_fts_content T WHERE T.id = ?', 1)).toMatch(/INTEGER PRIMARY KEY/);
    expect(plan('SELECT T.id, T.c0, T.c1, T.c2 FROM work_items_fts_content T ORDER BY T.id ASC')).not.toContain('idx_work_items_fts_content_item');
    // BotBoy's evidence search is MATCH-driven.
    expect(plan('SELECT item_id FROM work_items_fts WHERE work_items_fts MATCH ?', 'alphaterm')).not.toContain('idx_work_items_fts_content_item');
    db.exec("INSERT INTO work_items_fts(work_items_fts) VALUES('rebuild')");
    db.exec("INSERT INTO work_items_fts(work_items_fts) VALUES('optimize')");
    db.exec("INSERT INTO work_items_fts(work_items_fts) VALUES('integrity-check')");
    expect(db.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });
    expect(matches('alphaterm')).toEqual(['a', 'a']);
  });

  it('falls back to the item_id predicate when the FTS5 content table is not laid out as expected', () => {
    // Stand-in for a future SQLite (or contentless rebuild) without
    // `work_items_fts_content.c0`: a plain table answers the same statements.
    const db = new Database(':memory:');
    db.exec('CREATE TABLE work_items_fts (item_id TEXT, title TEXT, body TEXT)');
    db.prepare('INSERT INTO work_items_fts VALUES (?, ?, ?)').run('a', 'Alpha', 'one');
    db.prepare('INSERT INTO work_items_fts VALUES (?, ?, ?)').run('b', 'Beta', 'two');
    setWorkItemFtsTitle(db, 'b', 'Beta renamed');
    deleteWorkItemFts(db, 'a');
    expect(db.prepare('SELECT item_id, title FROM work_items_fts').all()).toEqual([{ item_id: 'b', title: 'Beta renamed' }]);
    db.close();
  });

  it('stays correct without the index (the old scan cost, same rows)', () => {
    storage.getDb().exec('DROP INDEX idx_work_items_fts_content_item');
    const db = storage.getDb();
    deleteWorkItemFts(db, 'b');
    expect(rowsFor('b')).toBe(0);
    expect(rowsFor('a')).toBe(2);
  });
});
