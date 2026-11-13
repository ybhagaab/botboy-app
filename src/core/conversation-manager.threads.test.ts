import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createStorage, type StorageLayer } from './storage.js';
import { createConversationManager, type ConversationManager } from './conversation-manager.js';
import { createChatInterface } from './chat-interface.js';

/**
 * Job threads (PARALLEL_JOBS_PLAN.md PJ1): each job has its own model session and transcript, and the main chat never reads
 * one. Two turns in different threads never write the same conversation.
 */
describe('job threads in the conversation store', () => {
  let storage: StorageLayer;
  let conversations: ConversationManager;
  beforeEach(() => {
    storage = createStorage(':memory:');
    storage.initialize();
    conversations = createConversationManager(storage.getDb());
  });
  afterEach(() => storage.close());

  it('a job\'s thread is its own session: created once, never the main chat, and the main lookup never returns it', () => {
    const main = conversations.createSession('chat');
    const thread = conversations.threadSessionId('cj_aaaaaaaaaaaaaaaaaaaaaaaa');
    expect(thread).not.toBe(main);
    expect(conversations.threadSessionId('cj_aaaaaaaaaaaaaaaaaaaaaaaa')).toBe(thread);
    expect(conversations.threadSessionId('cj_bbbbbbbbbbbbbbbbbbbbbbbb')).not.toBe(thread);
    // The thread was used last, yet the main chat is still the main chat.
    conversations.appendUser(thread, 'job message');
    expect(conversations.getActiveSessionId('chat')).toBe(main);
    expect(conversations.getRecentMessages(main)).toEqual([]);
    expect(conversations.getRecentMessages(thread).map(message => message.content)).toEqual(['job message']);
  });

  it('copies the main chat messages since a time into a thread, in order and bounded', () => {
    const db = storage.getDb();
    const main = conversations.createSession('chat');
    conversations.appendUser(main, 'old question');
    db.prepare("UPDATE llm_messages SET created_at = '2026-10-01 09:00:00'").run();
    conversations.appendUser(main, 'Study offline usage');
    conversations.appendAssistant(main, 'On it.');
    conversations.appendUser(main, 'and the other thing');
    const thread = conversations.threadSessionId('cj_cccccccccccccccccccccccc');
    expect(conversations.copyMessagesSince(main, thread, '2026-10-28T00:00:00.000Z', 2)).toBe(2);
    expect(conversations.getRecentMessages(thread).map(message => message.content)).toEqual(['On it.', 'and the other thing']);
    // The main chat keeps every message.
    expect(conversations.getRecentMessages(main)).toHaveLength(4);
  });
});

describe('job threads in the transcript', () => {
  let storage: StorageLayer;
  beforeEach(() => {
    storage = createStorage(':memory:');
    storage.initialize();
  });
  afterEach(() => storage.close());

  it('the main chat history shows only its own rows, and a job\'s history only its thread, in the order they were written', () => {
    const db = storage.getDb();
    const insert = db.prepare("INSERT INTO chat_messages (id, role, content, job_id, ref_job_id, created_at) VALUES (?, ?, ?, ?, ?, '2026-10-28 10:00:00')");
    insert.run('a', 'user', 'main question', null, null);
    insert.run('b', 'user', 'job message', 'cj_x', null);
    insert.run('c', 'assistant', 'job reply', 'cj_x', null);
    insert.run('d', 'assistant', '[[job:cj_x:done]]', null, 'cj_x');
    insert.run('e', 'assistant', 'other job', 'cj_y', null);
    const chat = createChatInterface(db, {} as any);
    expect(chat.getHistory().map(message => message.content)).toEqual(['main question', '[[job:cj_x:done]]']);
    expect(chat.getHistory()[1]).toMatchObject({ refJobId: 'cj_x' });
    expect(chat.getJobHistory('cj_x').map(message => message.content)).toEqual(['job message', 'job reply']);
    expect(chat.getJobHistory('cj_x')[0]).toMatchObject({ jobId: 'cj_x' });
    expect(chat.getJobHistory('cj_none')).toEqual([]);
  });
});
