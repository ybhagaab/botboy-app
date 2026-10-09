/**
 * Deleting one Gmail account's captured mail (owner's choice when
 * disconnecting it; GMAIL_API_INTEGRATION_PLAN.md §13). Disconnecting keeps
 * the mail by default; this runs only when the owner ticks "Also delete".
 *
 * The rows are the account's capture URL form (`gmail://mail/<id>` for the
 * `default` account, `gmail://<account>/mail/<id>` for the others), so another
 * account's mail is never touched. References are released the same way
 * raw-capture-repair.ts releases a deleted capture: search index, node links,
 * todos, cross links, OCR lines, failures, routing decisions, document reads;
 * rejections, discards, and project events cascade with the row. Project
 * briefs already written from this mail keep their text (they are summaries,
 * not copies).
 */
import type Database from 'better-sqlite3';
import { deleteWorkItemFts } from './work-items-fts.js';

/** The URL prefix of one account's rows. */
export function gmailAccountUrlPattern(accountId: string): string {
  return accountId === 'default' ? 'gmail://mail/%' : `gmail://${accountId}/mail/%`;
}

export function deleteGmailAccountMail(db: Database.Database, accountId: string): number {
  if (!/^(?:default|ga_[a-f0-9]{10})$/.test(accountId)) throw new Error('Unknown Gmail account id.');
  const ids = (db.prepare(`SELECT id FROM work_items
    WHERE source = 'gmail' AND type IN ('email_read', 'email_sent') AND url LIKE ?`).all(gmailAccountUrlPattern(accountId)) as Array<{ id: string }>)
    .map(row => row.id);
  if (!ids.length) return 0;
  const unlink = {
    nodeLinks: db.prepare('DELETE FROM node_work_items WHERE work_item_id = ?'),
    todos: db.prepare('UPDATE agent_todos SET work_item_id = NULL WHERE work_item_id = ?'),
    crossLinks: db.prepare('UPDATE project_cross_links SET evidence_item_id = NULL WHERE evidence_item_id = ?'),
    ocr: db.prepare('DELETE FROM item_ocr_lines WHERE item_id = ?'),
    failures: db.prepare('DELETE FROM failures WHERE item_id = ?'),
    routing: db.prepare('DELETE FROM routing_decisions WHERE item_id = ?'),
    reads: db.prepare('DELETE FROM brain_document_reads WHERE item_id = ?'),
    item: db.prepare("DELETE FROM work_items WHERE id = ? AND source = 'gmail'"),
  };
  let deleted = 0;
  db.transaction(() => {
    for (const id of ids) {
      deleteWorkItemFts(db, id);
      unlink.nodeLinks.run(id);
      unlink.todos.run(id);
      unlink.crossLinks.run(id);
      unlink.ocr.run(id);
      unlink.failures.run(id);
      unlink.routing.run(id);
      unlink.reads.run(id);
      deleted += unlink.item.run(id).changes;
    }
  })();
  return deleted;
}
