import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createStorage, getSetting, type StorageLayer } from './storage.js';
import { SENTINEL_CLEANUP_KEY, cleanupSentinelPileup } from './chat-notice-cleanup.js';

// The three shapes the old sentinel wrote (copied from the owner's store, 2026-10-29), and rows that look close but stay.
const ALERT = '🔐 Your Amazon session needs re-authentication, which disconnected: Amazon Microsoft 365 through GRASP. Use the terminal card below to run mwinit (PIN + security-key touch). I will restart these connections automatically once you finish.';
const PENDING = '⚠ Midway re-authentication is still pending — the terminal ended with status failed (exit 1) and the session cookie is still not valid. The affected connections stay paused. Ask me to retry when you are ready, or run mwinit from the terminal card and I will pick it up on my next check.';
const MODEL_ALERT = 'Microsoft 365 through GRASP needs re-authentication because your Midway session expired. Please complete the PIN and security-key steps in the terminal card below. Capture is paused losslessly and will catch up automatically after re-authentication.';
const RECOVERY = 'Midway is refreshed. Amazon Microsoft 365 through GRASP is running, compatible, and has 45 tools available.';
const TERMINAL = '🖥 Terminal update: “Refresh Midway authentication” ended with status **failed** (exit code 18). Ask me to check the result if you want it verified.';

describe('cleanupSentinelPileup', () => {
  let storage: StorageLayer;
  let backupDir: string;
  beforeEach(() => {
    storage = createStorage(':memory:');
    storage.initialize();
    backupDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'notice-cleanup-')), 'backups');
  });
  afterEach(() => {
    try { storage.close(); } catch { /* closed by the test */ }
    fs.rmSync(path.dirname(backupDir), { recursive: true, force: true });
  });

  const insert = (id: string, content: string, extra: { role?: string; jobId?: string; notice?: string } = {}) => storage.getDb()
    .prepare('INSERT INTO chat_messages (id, role, content, job_id, notice_json) VALUES (?, ?, ?, ?, ?)')
    .run(id, extra.role ?? 'assistant', content, extra.jobId ?? null, extra.notice ?? null);
  const ids = () => (storage.getDb().prepare('SELECT id FROM chat_messages ORDER BY rowid').all() as Array<{ id: string }>).map(row => row.id);

  it('deletes exactly the piled-up sentinel rows, after writing them to a private backup, once per store', () => {
    insert('agent-1-alert', ALERT);
    insert('agent-2-pending', PENDING);
    insert('agent-3-model', MODEL_ALERT);
    insert('agent-4-recovery', RECOVERY);
    insert('agent-5-terminal', TERMINAL);
    insert('msg-6-reply', 'You can run mwinit from the terminal card below.'); // an ordinary chat reply
    insert('user-7', `Why does the terminal card keep asking for mwinit? ${ALERT}`, { role: 'user' });
    insert('agent-8-job', MODEL_ALERT, { jobId: 'job-1' }); // a job's own thread
    insert('agent-9-notice', 'Midway sign-in needed (GRASP). Run mwinit.', { notice: '{"v":1}' });

    const at = new Date('2026-10-29T04:00:00.000Z');
    const result = cleanupSentinelPileup(storage.getDb(), { backupDir, now: () => at });
    expect(result).toMatchObject({ status: 'done', deleted: 3 });
    expect(ids()).toEqual(['agent-4-recovery', 'agent-5-terminal', 'msg-6-reply', 'user-7', 'agent-8-job', 'agent-9-notice']);
    expect(result.backupPath).toBe(path.join(backupDir, 'chat-sentinel-cleanup-20261029T040000Z.json'));
    const backup = JSON.parse(fs.readFileSync(result.backupPath!, 'utf8'));
    expect(backup.rows.map((row: any) => [row.id, row.content])).toEqual([
      ['agent-1-alert', ALERT], ['agent-2-pending', PENDING], ['agent-3-model', MODEL_ALERT],
    ]);
    expect(fs.statSync(result.backupPath!).mode & 0o777).toBe(0o600);
    expect(fs.statSync(backupDir).mode & 0o777).toBe(0o700);
    expect(getSetting(storage.getDb(), SENTINEL_CLEANUP_KEY)).toEqual({ at: at.toISOString(), deleted: 3, backupPath: result.backupPath });

    insert('agent-10-alert', ALERT); // never again: a later row stays
    expect(cleanupSentinelPileup(storage.getDb(), { backupDir })).toEqual({ status: 'already_done', deleted: 0 });
    expect(ids()).toContain('agent-10-alert');
  });

  it('a store with nothing to remove writes no backup and is marked done', () => {
    insert('agent-1-recovery', RECOVERY);
    expect(cleanupSentinelPileup(storage.getDb(), { backupDir })).toEqual({ status: 'done', deleted: 0 });
    expect(fs.existsSync(backupDir)).toBe(false);
    expect(getSetting(storage.getDb(), SENTINEL_CLEANUP_KEY)).toMatchObject({ deleted: 0 });
  });

  it('never throws: a failure is reported and nothing is marked', () => {
    const db = storage.getDb();
    storage.close();
    expect(cleanupSentinelPileup(db, { backupDir })).toMatchObject({ status: 'failed', deleted: 0 });
  });

  it('a backup that cannot be written leaves every row in place', () => {
    insert('agent-1-alert', ALERT);
    fs.mkdirSync(path.dirname(backupDir), { recursive: true });
    fs.writeFileSync(backupDir, 'not a folder');
    expect(cleanupSentinelPileup(storage.getDb(), { backupDir })).toMatchObject({ status: 'failed' });
    expect(ids()).toEqual(['agent-1-alert']);
    expect(getSetting(storage.getDb(), SENTINEL_CLEANUP_KEY)).toBeNull();
  });
});
