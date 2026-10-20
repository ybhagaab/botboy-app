import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { createConversationManager, type ConversationManager } from './conversation-manager.js';
import { chatHistoryWindowOptions } from './chat-history-window.js';
import { CONTINUATION_TRIGGER_HEADER, isContinuationTrigger } from './chat-continuations.js';

/** The history window read from the real session tables (chat-history-window.ts, docs/maps/chat-agent.md "Chat history window"). */
describe('conversation manager history window', () => {
  const databases: Database.Database[] = [];
  afterEach(() => { for (const db of databases.splice(0)) db.close(); });
  function manager(): ConversationManager {
    const db = new Database(':memory:');
    databases.push(db);
    return createConversationManager(db);
  }
  const forModel = (window: number) => chatHistoryWindowOptions(window, row => isContinuationTrigger(row.content));

  it('with no budget it is the old 20-message read, plus the question its oldest reply answered', () => {
    const cm = manager();
    const sid = cm.createSession('chat');
    for (let i = 0; i < 30; i += 1) { cm.appendUser(sid, `question ${i}`); cm.appendAssistant(sid, `answer ${i}`); }
    cm.appendUser(sid, 'now');
    const old = cm.getRecentMessages(sid, 10);
    const { messages, window } = cm.getHistoryWindow(sid, forModel(0));
    expect(old).toHaveLength(20);
    expect(old[0]).toMatchObject({ role: 'assistant', content: 'answer 20' });
    expect(messages.slice(1)).toEqual(old);
    expect(messages[0]).toEqual({ role: 'user', content: 'question 20', toolCallId: undefined });
    expect(window).toMatchObject({ contiguousRows: 21, pinnedRows: 0, omittedBetween: false });
  });

  it('on a 1M-token model sends a whole two-month chat that fits in 50K, oldest first, from its own session only', () => {
    const cm = manager();
    const sid = cm.createSession('chat');
    const other = cm.createSession('chat');
    cm.appendUser(other, 'someone else\'s session');
    for (let i = 0; i < 60; i += 1) { cm.appendUser(sid, `question ${i}`); cm.appendAssistant(sid, `answer ${i} `.padEnd(400, '.')); }
    const { messages, window } = cm.getHistoryWindow(sid, forModel(1_000_000));
    expect(messages).toHaveLength(120);
    expect(messages[0].content).toBe('question 0');
    expect(messages.at(-1)!.content).toMatch(/^answer 59/);
    expect(messages.some(message => message.content === 'someone else\'s session')).toBe(false);
    // The stored estimate is what is counted: 4 characters a token, rounded up. Each question (10 or 11 characters) is 3 tokens,
    // each 400-character answer 100.
    expect(window.tokens).toBe(60 * (3 + 100));
  });

  it('keeps the owner\'s last 15 messages behind a long automatic job, and never a trigger as one of them', () => {
    const cm = manager();
    const sid = cm.createSession('chat');
    for (let i = 0; i < 30; i += 1) { cm.appendUser(sid, `owner message ${i}`); cm.appendAssistant(sid, `reply ${i}`); }
    // 100 automatic turns with long reports: far more than the 50K budget.
    for (let i = 0; i < 100; i += 1) {
      cm.appendUser(sid, `${CONTINUATION_TRIGGER_HEADER}\nWhy this turn started: the job's next step.`);
      cm.appendAssistant(sid, `report ${i} `.padEnd(4_000, '.'));
    }
    cm.appendUser(sid, 'the newest instruction');
    const { messages, window } = cm.getHistoryWindow(sid, forModel(1_000_000));
    const texts = messages.map(message => message.content);
    for (let i = 16; i < 30; i += 1) expect(texts, `owner message ${i}`).toContain(`owner message ${i}`);
    expect(texts).not.toContain('owner message 15');
    expect(texts.at(-1)).toBe('the newest instruction');
    expect(window).toMatchObject({ ownerMessages: 15, pinnedRows: 28, omittedBetween: true });
    expect(window.tokens).toBeLessThanOrEqual(50_000 + 2_000 + 12_500);
    // The kept older messages come first, in order, each with its reply.
    expect(texts.slice(0, 4)).toEqual(['owner message 16', 'reply 16', 'owner message 17', 'reply 17']);
  });
});
