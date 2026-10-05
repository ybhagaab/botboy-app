/**
 * Exact per-item writes to the search index (`work_items_fts`).
 *
 * `item_id` is an UNINDEXED FTS5 column, so `WHERE item_id = ?` visits every
 * indexed row: about 0.3–0.6 s per call on the owner's 40k-row index (live
 * 2026-10-02). Every extraction paid that once, and a 53-row comment dedup
 * sweep held boot for 25.6 s. Storage indexes the item column of the FTS5
 * content table (`idx_work_items_fts_content_item`); these helpers find the
 * rows through it and address them by rowid, which FTS5 serves directly.
 *
 * Semantics match the `item_id = ?` predicate exactly: every row for the item
 * (duplicates included) is affected and no other row is. Without the index the
 * same statements still work, at the old full-scan cost. The index changes no
 * other statement's plan (FTS5 reads its content table by rowid), and older
 * BotBoy builds ignore it, so a rollback needs no migration.
 */

import type Database from 'better-sqlite3';

/** FTS5 keeps each row's columns in `<table>_content(id, c0, c1, …)`; c0 is item_id. */
const ROWIDS_FOR_ITEM = 'SELECT id FROM work_items_fts_content WHERE c0 = ?';

interface FtsStatements {
  remove: Database.Statement;
  retitle: Database.Statement;
}

const statements = new WeakMap<Database.Database, FtsStatements>();

/**
 * The shadow-table layout is FTS5's own, stable since 2015 but not a public
 * contract. If a future SQLite (or a contentless rebuild of the index)
 * changes it, fall back to the plain predicate: slower, never broken.
 */
function contentTableHoldsItemIds(db: Database.Database): boolean {
  try {
    return db.prepare("SELECT 1 FROM pragma_table_info('work_items_fts_content') WHERE name = 'c0'").get() !== undefined;
  } catch {
    return false;
  }
}

function statementsFor(db: Database.Database): FtsStatements {
  let cached = statements.get(db);
  if (!cached) {
    cached = contentTableHoldsItemIds(db)
      ? {
        remove: db.prepare(`DELETE FROM work_items_fts WHERE rowid IN (${ROWIDS_FOR_ITEM})`),
        retitle: db.prepare(`UPDATE work_items_fts SET title = ? WHERE rowid IN (${ROWIDS_FOR_ITEM})`),
      }
      : {
        remove: db.prepare('DELETE FROM work_items_fts WHERE item_id = ?'),
        retitle: db.prepare('UPDATE work_items_fts SET title = ? WHERE item_id = ?'),
      };
    statements.set(db, cached);
  }
  return cached;
}

/** Remove every search-index row for one work item. */
export function deleteWorkItemFts(db: Database.Database, itemId: string): void {
  statementsFor(db).remove.run(itemId);
}

/** Replace the indexed title of every search-index row for one work item. */
export function setWorkItemFtsTitle(db: Database.Database, itemId: string, title: string): void {
  statementsFor(db).retitle.run(title, itemId);
}
