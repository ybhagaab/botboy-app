import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createStorage, StorageLayer } from './storage.js';
import { computeAwaitingReplyThreads } from './today.js';

/**
 * Awaiting-your-reply rule (sharepoint-signals R3): deterministic thread
 * state from stored document_comment evidence. Truth table:
 *   latest received + owner participated earlier        → awaiting
 *   latest received + mention only (no participation)   → awaiting
 *   latest sent (owner had the last word)               → not awaiting
 *   latest received but resolved                        → not awaiting
 *   latest received, no participation, no mention       → not awaiting
 */
describe('computeAwaitingReplyThreads', () => {
  let storage: StorageLayer;
  beforeEach(() => {
    storage = createStorage(':memory:');
    storage.initialize();
  });
  afterEach(() => storage.close());

  function insertComment(id: string, opts: {
    docKey: string; threadRoot: string; author: string; direction: 'sent' | 'received';
    commentedAt: string; capturedAt?: string; mentionedMe?: boolean; resolved?: boolean; projectId?: string; text?: string;
  }) {
    storage.getDb().prepare(`
      INSERT INTO work_items (id, type, source, title, url, captured_at, process_state, project_id, metadata, raw_text)
      VALUES (?, 'document_comment', 'sharepoint', ?, ?, ?, 'routed', ?, ?, ?)
    `).run(
      id,
      `Comment by ${opts.author} on HLD.docx`,
      `https://x/hld#comment=${id}`,
      opts.capturedAt ?? opts.commentedAt,
      opts.projectId ?? null,
      JSON.stringify({
        docKey: opts.docKey,
        docTitle: 'HLD.docx',
        threadRoot: opts.threadRoot,
        commentId: id,
        author: opts.author,
        direction: opts.direction,
        commentedAt: opts.commentedAt,
        mentionedMe: opts.mentionedMe ? 'true' : 'false',
        ...(opts.resolved ? { resolved: 'true' } : {}),
      }),
      opts.text ?? 'Can you confirm the rollout order?',
    );
  }

  it('flags threads whose latest word is someone else\'s — participation or mention', () => {
    // Thread A: owner participated, teammate replied last → awaiting.
    insertComment('a1', { docKey: 'k/hld', threadRoot: 'a1', author: 'Bhagat, AB', direction: 'sent', commentedAt: '2026-08-24T10:00:00Z' });
    insertComment('a2', { docKey: 'k/hld', threadRoot: 'a1', author: 'Ng, Hui Jun', direction: 'received', commentedAt: '2026-08-25T09:00:00Z', text: 'What is the dialup process?' });
    // Thread B: mention-only, owner never participated → awaiting.
    insertComment('b1', { docKey: 'k/hld', threadRoot: 'b1', author: 'Wang, Chen', direction: 'received', commentedAt: '2026-08-25T11:00:00Z', mentionedMe: true });
    // Thread C: owner had the last word → not awaiting.
    insertComment('c1', { docKey: 'k/hld', threadRoot: 'c1', author: 'Ng, Hui Jun', direction: 'received', commentedAt: '2026-08-24T08:00:00Z' });
    insertComment('c2', { docKey: 'k/hld', threadRoot: 'c1', author: 'Bhagat, AB', direction: 'sent', commentedAt: '2026-08-24T09:00:00Z' });
    // Thread D: latest is resolved → not awaiting.
    insertComment('d1', { docKey: 'k/hld', threadRoot: 'd1', author: 'Bhagat, AB', direction: 'sent', commentedAt: '2026-08-23T10:00:00Z' });
    insertComment('d2', { docKey: 'k/hld', threadRoot: 'd1', author: 'Ng, Hui Jun', direction: 'received', commentedAt: '2026-08-23T11:00:00Z', resolved: true });
    // Thread E: foreign chatter, no participation, no mention → not awaiting.
    insertComment('e1', { docKey: 'k/other', threadRoot: 'e1', author: 'Wang, Chen', direction: 'received', commentedAt: '2026-08-25T12:00:00Z' });

    // Thread F (soak find 2026-08-25): the owner's reply carries Word's
    // 1900-01-01 placeholder date but a LATER capture time — the owner had
    // the last word, so the thread must NOT read as awaiting.
    insertComment('f1', { docKey: 'k/hld', threadRoot: 'f1', author: 'Ng, Hui Jun', direction: 'received', commentedAt: '2026-08-24T16:37:00Z' });
    insertComment('f2', { docKey: 'k/hld', threadRoot: 'f1', author: 'Bhagat, AB', direction: 'sent', commentedAt: '1900-01-01T00:00:00.000Z', capturedAt: '2026-08-25T07:00:00Z' });
    // Thread G (soak find 2026-08-25): the teammate's comment was DELETED
    // from the doc — deleted comments are history, never review load.
    insertComment('g1', { docKey: 'k/hld', threadRoot: 'g1', author: 'Bhagat, AB', direction: 'sent', commentedAt: '2026-08-25T08:00:00Z' });
    insertComment('g2', { docKey: 'k/hld', threadRoot: 'g1', author: 'Ng, Hui Jun', direction: 'received', commentedAt: '2026-08-25T09:00:00Z' });
    storage.getDb().prepare("UPDATE work_items SET metadata = json_set(metadata,'$.deletedFromDoc','true') WHERE id='g2'").run();

    const threads = computeAwaitingReplyThreads(storage.getDb());
    expect(threads.map(t => t.id).sort()).toEqual(['comment-thread:a2', 'comment-thread:b1']);
    const a = threads.find(t => t.id === 'comment-thread:a2')!;
    expect(a.author).toBe('Ng, Hui Jun');
    expect(a.docTitle).toBe('HLD.docx');
    expect(a.docKey).toBe('k/hld'); // the UI builds the in-app reader link from it
    expect(a.threadSize).toBe(2);
    expect(a.snippet).toContain('dialup process');
    expect(a.url).toBe('https://x/hld#comment=a2');
    // Newest first.
    expect(threads[0].id).toBe('comment-thread:b1');
  });

  it('carries the project link and respects the limit', () => {
    storage.getDb().prepare("INSERT INTO projects (id, title, one_liner, brain_path, status) VALUES ('p1', 'Catalog HLD review', 'x', '/b', 'active')").run();
    for (let i = 0; i < 12; i++) {
      insertComment(`m${i}`, {
        docKey: `k/doc${i}`, threadRoot: `m${i}`, author: 'Ng, Hui Jun', direction: 'received',
        commentedAt: `2026-08-${String(10 + i).padStart(2, '0')}T10:00:00Z`, mentionedMe: true, projectId: 'p1',
      });
    }
    const threads = computeAwaitingReplyThreads(storage.getDb());
    expect(threads).toHaveLength(8); // capped
    expect(threads[0].commentedAt > threads[7].commentedAt).toBe(true);
    expect(threads[0].projectId).toBe('p1');
    expect(threads[0].projectTitle).toBe('Catalog HLD review');
  });
});
