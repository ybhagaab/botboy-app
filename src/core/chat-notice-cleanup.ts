/**
 * One-time cleanup of the Midway sentinel's piled-up chat rows (MIDWAY_NOTICES_PLAN.md §5, owner approval 2026-10-29).
 *
 * Before the notices, the sentinel re-alerted every 30 minutes while a connection kept failing and added a "still pending" note
 * after each mwinit window: on the owner's store 754 such rows (one night alone: 28 alerts and 28 notes). This removes exactly
 * those rows once per store: the deterministic alert ("🔐 Your Amazon session needs re-authentication …"), the "Midway
 * re-authentication is still pending" notes, and the model-written alerts (the sentinel's instruction always pointed to "the
 * terminal card below", and only the sentinel and BotBoy's own agent post rows with an `agent-` id). Recovery messages,
 * dashboard diagnoses and terminal endings stay; the panel draws them as compact notices.
 *
 * Every removed row is written first to a 0600 JSON backup under `<data dir>/backups/`. Never throws.
 */
import type Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import { getSetting, setSetting } from './storage.js';

export const SENTINEL_CLEANUP_KEY = 'chat_notices.sentinel_cleanup.v1';

/** The rows the old sentinel wrote: agent ids, main chat, no notice record, and one of its three shapes. */
const CANDIDATES_SQL = `SELECT id, role, content, created_at FROM chat_messages
  WHERE id LIKE 'agent-%' AND role = 'assistant' AND job_id IS NULL AND notice_json IS NULL AND (
    content LIKE '🔐 Your Amazon session needs re-authentication%'
    OR content LIKE '%Midway re-authentication is still pending%'
    OR (content LIKE '%terminal card%' AND (content LIKE '%idway%' OR content LIKE '%mwinit%'))
  )
  ORDER BY created_at, rowid`;

export interface SentinelCleanupResult {
  status: 'done' | 'already_done' | 'failed';
  deleted: number;
  backupPath?: string;
  error?: string;
}

export function cleanupSentinelPileup(db: Database.Database, options: { backupDir: string; now?: () => Date }): SentinelCleanupResult {
  try {
    if (getSetting(db, SENTINEL_CLEANUP_KEY)) return { status: 'already_done', deleted: 0 };
    const rows = db.prepare(CANDIDATES_SQL).all() as Array<{ id: string; role: string; content: string; created_at: string }>;
    const at = (options.now ?? (() => new Date()))();
    let backupPath: string | undefined;
    if (rows.length) {
      fs.mkdirSync(options.backupDir, { recursive: true, mode: 0o700 });
      const stamp = at.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
      backupPath = path.join(options.backupDir, `chat-sentinel-cleanup-${stamp}.json`);
      fs.writeFileSync(backupPath, JSON.stringify({ reason: 'Midway sentinel pile-up cleanup (MIDWAY_NOTICES_PLAN.md)', rows }, null, 1), { mode: 0o600 });
      const remove = db.prepare('DELETE FROM chat_messages WHERE id = ?');
      db.transaction(() => { for (const row of rows) remove.run(row.id); })();
    }
    setSetting(db, SENTINEL_CLEANUP_KEY, { at: at.toISOString(), deleted: rows.length, ...(backupPath ? { backupPath } : {}) });
    return { status: 'done', deleted: rows.length, ...(backupPath ? { backupPath } : {}) };
  } catch (error: any) {
    return { status: 'failed', deleted: 0, error: String(error?.message ?? error).slice(0, 300) };
  }
}
