import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createStorage, type StorageLayer } from './storage.js';
import { NOTIFY_REPLY_CHARS, createChatJobStore, formatChatJobBlock, type ChatJobStore } from './chat-jobs.js';

/** The per-job "tell me on WhatsApp" record (docs/maps/job-notify.md): what the owner asked for and what BotBoy already sent. */
describe('chat job notify record', () => {
  let storage: StorageLayer;
  let jobs: ChatJobStore;
  beforeEach(() => {
    storage = createStorage(':memory:');
    storage.initialize();
    jobs = createChatJobStore(storage.getDb());
  });
  afterEach(() => storage.close());

  it('is absent until the owner asks, and arming is idempotent (it keeps what was already sent)', () => {
    const job = jobs.start({ goal: 'Study the home screen' });
    expect(jobs.get(job.id)!.notify).toBeUndefined();
    const armed = jobs.setNotify(job.id, true)!;
    expect(armed.notify).toMatchObject({ channel: 'whatsapp', sent: [] });
    jobs.recordNotifyOutcome(job.id, 'needs:1', 'sent');
    const again = jobs.setNotify(job.id, true)!;
    expect(again.notify!.sent.map(entry => entry.key)).toEqual(['needs:1']);
    expect(again.notify!.armedAt).toBe(armed.notify!.armedAt);
  });

  it('turning it off forgets the request and the kept report', () => {
    const job = jobs.start({ goal: 'g' });
    jobs.setNotify(job.id, true);
    jobs.recordLastReply(job.id, 'A report.');
    jobs.setNotify(job.id, false);
    expect(jobs.get(job.id)).not.toHaveProperty('notify');
    expect(jobs.get(job.id)!.lastReply).toBeUndefined();
  });

  it('only an active job can be armed', () => {
    const job = jobs.start({ goal: 'g' });
    jobs.end(job.id, 'done', 'ok');
    expect(jobs.setNotify(job.id, true)).toBeNull();
    expect(jobs.setNotify('cj_000000000000000000000000', true)).toBeNull();
  });

  it('keeps a report only for a job that asked, with its line breaks, bounded', () => {
    const quiet = jobs.start({ goal: 'quiet' });
    jobs.recordLastReply(quiet.id, 'ignored');
    expect(jobs.get(quiet.id)!.lastReply).toBeUndefined();
    const job = jobs.start({ goal: 'loud' });
    jobs.setNotify(job.id, true);
    jobs.recordLastReply(job.id, 'Line one.\r\n\r\n\r\n\r\nLine two.   \nLine three.');
    expect(jobs.get(job.id)!.lastReply).toBe('Line one.\n\nLine two.\nLine three.');
    jobs.recordLastReply(job.id, 'x'.repeat(NOTIFY_REPLY_CHARS + 500));
    expect(jobs.get(job.id)!.lastReply).toHaveLength(NOTIFY_REPLY_CHARS);
    jobs.recordLastReply(job.id, '   ');
    expect(jobs.get(job.id)!.lastReply).toHaveLength(NOTIFY_REPLY_CHARS);
  });

  it('ending a job drops the progress reports kept before it, so a finish carries only the closing report', () => {
    const job = jobs.start({ goal: 'g' });
    jobs.setNotify(job.id, true);
    jobs.recordLastReply(job.id, 'Halfway there.');
    jobs.end(job.id, 'done', 'complete');
    expect(jobs.get(job.id)!.lastReply).toBeUndefined();
    // The closing words are written after the end and are kept, even though the job is no longer active.
    jobs.recordLastReply(job.id, 'The study is complete.');
    expect(jobs.get(job.id)).toMatchObject({ status: 'done', lastReply: 'The study is complete.' });
    expect(jobs.get(job.id)!.lastReplyAt).toEqual(expect.any(String));
  });

  it('records an in-flight event as unknown, replaces it by its result, and reopens it for a retry', () => {
    const job = jobs.start({ goal: 'g' });
    jobs.setNotify(job.id, true);
    jobs.recordNotifyOutcome(job.id, 'k1', 'unknown');
    expect(jobs.get(job.id)!.notify!.sent).toMatchObject([{ key: 'k1', outcome: 'unknown' }]);
    jobs.recordNotifyOutcome(job.id, 'k1', 'sent');
    expect(jobs.get(job.id)!.notify!.sent).toMatchObject([{ key: 'k1', outcome: 'sent' }]);
    jobs.recordNotifyOutcome(job.id, 'k2', 'unknown');
    jobs.recordNotifyOutcome(job.id, 'k2', { retryAt: '2026-10-19T03:00:00.000Z', attempts: 2 });
    const notify = jobs.get(job.id)!.notify!;
    expect(notify.sent.map(entry => entry.key)).toEqual(['k1']);
    expect(notify.retry).toEqual({ key: 'k2', attempts: 2, notBefore: '2026-10-19T03:00:00.000Z' });
    jobs.recordNotifyOutcome(job.id, 'k2', 'sent');
    expect(jobs.get(job.id)!.notify!.retry).toBeUndefined();
  });

  it('ignores an outcome for a job that never asked, and bounds the sent log', () => {
    const quiet = jobs.start({ goal: 'quiet' });
    jobs.recordNotifyOutcome(quiet.id, 'k', 'sent');
    expect(jobs.get(quiet.id)).not.toHaveProperty('notify');
    const job = jobs.start({ goal: 'busy' });
    jobs.setNotify(job.id, true);
    for (let i = 0; i < 60; i++) jobs.recordNotifyOutcome(job.id, `k${i}`, 'sent');
    const keys = jobs.get(job.id)!.notify!.sent.map(entry => entry.key);
    expect(keys).toHaveLength(40);
    expect(keys.at(-1)).toBe('k59');
  });

  it('notifyCandidates: an armed active job, and armed jobs that ended inside the window; never a job that did not ask', () => {
    const since = new Date(Date.now() - 6 * 3_600_000).toISOString();
    const recent = jobs.start({ goal: 'stopped recently' });
    jobs.setNotify(recent.id, true);
    jobs.end(recent.id, 'stopped', 'stopped by the owner');
    const old = jobs.start({ goal: 'ended long ago' });
    jobs.setNotify(old.id, true);
    jobs.end(old.id, 'done', 'ok');
    storage.getDb().prepare('UPDATE chat_jobs SET ended_at = ? WHERE id = ?').run('2026-01-01T00:00:00.000Z', old.id);
    const quiet = jobs.start({ goal: 'never asked' });
    jobs.end(quiet.id, 'done', 'ok');
    const active = jobs.start({ goal: 'active and armed' });
    jobs.setNotify(active.id, true);
    const ids = jobs.notifyCandidates(since).map(job => job.id);
    expect(ids).toContain(active.id);
    expect(ids).toContain(recent.id);
    expect(ids).not.toContain(old.id);
    expect(ids).not.toContain(quiet.id);
  });

  it('a job replaced by a new one stays a candidate, but owes nothing (the notifier filters it by its end reason)', () => {
    const since = new Date(Date.now() - 6 * 3_600_000).toISOString();
    const first = jobs.start({ goal: 'first' });
    jobs.setNotify(first.id, true);
    jobs.start({ goal: 'the owner asked for something else' });
    expect(jobs.notifyCandidates(since).map(job => job.id)).toContain(first.id);
    expect(jobs.get(first.id)).toMatchObject({ status: 'done', endReason: 'replaced by a new job' });
  });

  it('a malformed stored record reads as "not asked" and never breaks the job read', () => {
    const job = jobs.start({ goal: 'g' });
    const db = storage.getDb();
    for (const bad of ['not json', '{}', '{"channel":"sms","armedAt":"x"}', '[]', 'null', '{"channel":"whatsapp"}']) {
      db.prepare('UPDATE chat_jobs SET notify_json = ? WHERE id = ?').run(bad, job.id);
      expect(jobs.get(job.id)).toMatchObject({ id: job.id, goal: 'g' });
      expect(jobs.get(job.id)!.notify).toBeUndefined();
    }
    db.prepare('UPDATE chat_jobs SET notify_json = ? WHERE id = ?').run(JSON.stringify({
      channel: 'whatsapp', armedAt: 'x', sent: [{ key: 'a', at: 'b', outcome: 'sent' }, { key: 5 }, { key: 'c', at: 'd', outcome: 'weird' }, null], retry: { key: 'r', attempts: -3, notBefore: 'z' },
    }), job.id);
    expect(jobs.get(job.id)!.notify).toEqual({ channel: 'whatsapp', armedAt: 'x', sent: [{ key: 'a', at: 'b', outcome: 'sent' }], retry: { key: 'r', attempts: 0, notBefore: 'z' } });
  });

  it('an older database gains the columns in place and keeps its jobs', () => {
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE chat_jobs (
      id TEXT PRIMARY KEY CHECK(id GLOB 'cj_[a-f0-9]*' AND length(id) = 27), goal TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('active','done','stopped','expired','blocked')), model_key TEXT, thinking TEXT NOT NULL DEFAULT 'off',
      working_set_json TEXT NOT NULL DEFAULT '{}', continuation_count INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL,
      last_activity_at TEXT NOT NULL, ended_at TEXT, end_reason TEXT);
      INSERT INTO chat_jobs (id, goal, status, created_at, last_activity_at) VALUES ('cj_aaaaaaaaaaaaaaaaaaaaaaaa', 'an older job', 'active', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z');`);
    const store = createChatJobStore(db);
    expect(store.get('cj_aaaaaaaaaaaaaaaaaaaaaaaa')).toMatchObject({ goal: 'an older job', status: 'active' });
    expect(store.setNotify('cj_aaaaaaaaaaaaaaaaaaaaaaaa', true)!.notify).toBeDefined();
    db.close();
  });

  it('the job block tells a continuation that BotBoy sends the update, and says nothing when it was not asked', () => {
    const job = jobs.start({ goal: 'Study the home screen' });
    expect(formatChatJobBlock(jobs.get(job.id)!, [], { continuation: true })).not.toContain('WhatsApp updates are ON');
    jobs.setNotify(job.id, true);
    const block = formatChatJobBlock(jobs.get(job.id)!, [], { continuation: true });
    expect(block).toContain('WhatsApp updates are ON for this job');
    expect(block).toContain('never say you could not send it');
  });
});
