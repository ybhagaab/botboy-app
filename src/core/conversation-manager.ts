/**
 * Conversation Manager — stores chat history in SQLite.
 * Replaces kiro-cli's internal session management.
 * Sliding window keeps messages within token budget.
 */

import Database from 'better-sqlite3';
import { v4 as uuid } from 'uuid';
import type { LlmMessage } from './llm-client.js';

export type SessionType = 'chat' | 'background' | 'subagent';

export interface StoredConversationMessage extends LlmMessage {
  id: string;
}

export interface ConversationManager {
  createSession(type: SessionType): string;
  appendUser(sessionId: string, content: string): void;
  appendAssistant(sessionId: string, content: string): void;
  appendToolResult(sessionId: string, toolCallId: string, content: string): void;
  getMessages(sessionId: string, maxTokens?: number): LlmMessage[];
  /** Same bounded history as getMessages, with durable DB ids for summaries. */
  getMessagesWithIds(sessionId: string, maxTokens?: number): StoredConversationMessage[];
  getRecentMessages(sessionId: string, maxPairs?: number): LlmMessage[];
  countUserMessages(sessionId: string): number;
  getSummary(sessionId: string): { summary: string; coversFromMsgId: string; coversToMsgId: string; userMsgCount: number } | null;
  saveSummary(sessionId: string, summary: string, fromMsgId: string, toMsgId: string, userMsgCount: number): void;
  getMessagesSinceId(sessionId: string, sinceId: string): StoredConversationMessage[];
  deleteSession(sessionId: string): void;
  getActiveSessionId(type: SessionType): string | null;
  pruneOldSessions(): void;
}

function estimateTokens(text: string): number {
  return Math.ceil((text || '').length / 4);
}

export function createConversationManager(db: Database.Database): ConversationManager {
  // Create tables if not exist
  db.exec(`
    CREATE TABLE IF NOT EXISTS llm_sessions (
      id TEXT PRIMARY KEY,
      session_type TEXT NOT NULL CHECK(session_type IN ('chat','background','subagent')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_active_at TEXT NOT NULL DEFAULT (datetime('now')),
      total_tokens INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','completed','expired'))
    );
    CREATE TABLE IF NOT EXISTS llm_messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES llm_sessions(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK(role IN ('system','user','assistant','tool')),
      content TEXT,
      tool_calls TEXT,
      tool_call_id TEXT,
      token_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_llm_messages_session ON llm_messages(session_id);
    CREATE TABLE IF NOT EXISTS chat_summaries (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES llm_sessions(id),
      summary TEXT NOT NULL,
      covers_from_msg_id TEXT NOT NULL,
      covers_to_msg_id TEXT NOT NULL,
      user_msg_count INTEGER NOT NULL,
      token_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  const insertSession = db.prepare('INSERT INTO llm_sessions (id, session_type) VALUES (?, ?)');
  const insertMessage = db.prepare('INSERT INTO llm_messages (id, session_id, role, content, tool_calls, tool_call_id, token_count) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const selectMessages = db.prepare('SELECT rowid AS message_position, * FROM llm_messages WHERE session_id = ? ORDER BY rowid ASC');
  const deleteSessionStmt = db.prepare('DELETE FROM llm_sessions WHERE id = ?');
  const deleteMessagesStmt = db.prepare('DELETE FROM llm_messages WHERE session_id = ?');
  const updateLastActive = db.prepare("UPDATE llm_sessions SET last_active_at = datetime('now') WHERE id = ?");
  const selectActiveSession = db.prepare("SELECT id FROM llm_sessions WHERE session_type = ? AND status = 'active' ORDER BY last_active_at DESC LIMIT 1");
  const selectSummary = db.prepare("SELECT summary, covers_from_msg_id, covers_to_msg_id, user_msg_count FROM chat_summaries WHERE session_id = ? ORDER BY rowid DESC LIMIT 1");
  const insertSummary = db.prepare("INSERT INTO chat_summaries (id, session_id, summary, covers_from_msg_id, covers_to_msg_id, user_msg_count, token_count) VALUES (?, ?, ?, ?, ?, ?, ?)");
  const countUserMsgs = db.prepare("SELECT COUNT(*) as cnt FROM llm_messages WHERE session_id = ? AND role = 'user'");
  const selectRecentMessages = db.prepare("SELECT * FROM llm_messages WHERE session_id = ? AND role != 'system' ORDER BY rowid DESC LIMIT ?");
  const selectMessagePosition = db.prepare(
    'SELECT rowid AS message_position FROM llm_messages WHERE session_id = ? AND id = ?',
  );
  const selectMessagesAfterPosition = db.prepare(
    'SELECT * FROM llm_messages WHERE session_id = ? AND rowid > ? ORDER BY rowid ASC',
  );

  function addMessage(sessionId: string, role: string, content: string | null, toolCallId?: string): void {
    const tokens = estimateTokens(content || '');
    insertMessage.run(uuid(), sessionId, role, content, null, toolCallId || null, tokens);
    updateLastActive.run(sessionId);
  }

  function boundedRows(sessionId: string, maxTokens: number): any[] {
    const rows = selectMessages.all(sessionId) as any[];
    if (!rows.length) return [];

    const systemMsg = rows[0].role === 'system' ? rows[0] : null;
    let tokenCount = systemMsg ? systemMsg.token_count : 0;
    const included: any[] = [];
    for (const msg of (systemMsg ? rows.slice(1) : rows).reverse()) {
      if (tokenCount + msg.token_count > maxTokens) break;
      tokenCount += msg.token_count;
      included.push(msg);
    }
    included.reverse();
    return systemMsg ? [systemMsg, ...included] : included;
  }

  function storedMessage(row: any): StoredConversationMessage {
    return {
      id: row.id,
      role: row.role,
      content: row.content,
      toolCallId: row.tool_call_id || undefined,
    };
  }

  return {
    createSession(type: SessionType): string {
      const id = uuid();
      insertSession.run(id, type);
      return id;
    },

    appendUser(sessionId: string, content: string): void {
      addMessage(sessionId, 'user', content);
    },

    appendAssistant(sessionId: string, content: string): void {
      addMessage(sessionId, 'assistant', content);
    },

    appendToolResult(sessionId: string, toolCallId: string, content: string): void {
      addMessage(sessionId, 'tool', content, toolCallId);
    },

    getMessages(sessionId: string, maxTokens = 100000): LlmMessage[] {
      return boundedRows(sessionId, maxTokens).map((row) => {
        const { id: _id, ...message } = storedMessage(row);
        return message;
      });
    },

    getMessagesWithIds(sessionId: string, maxTokens = 100000): StoredConversationMessage[] {
      return boundedRows(sessionId, maxTokens).map(storedMessage);
    },

    getRecentMessages(sessionId: string, maxPairs = 10): LlmMessage[] {
      const rows = (selectRecentMessages.all(sessionId, maxPairs * 2) as any[]).reverse();
      return rows.map(msg => ({
        role: msg.role,
        content: msg.content,
        toolCallId: msg.tool_call_id || undefined,
      }));
    },

    countUserMessages(sessionId: string): number {
      const row = countUserMsgs.get(sessionId) as any;
      return row?.cnt || 0;
    },

    getSummary(sessionId: string) {
      const row = selectSummary.get(sessionId) as any;
      if (!row) return null;
      return { summary: row.summary, coversFromMsgId: row.covers_from_msg_id, coversToMsgId: row.covers_to_msg_id, userMsgCount: row.user_msg_count };
    },

    saveSummary(sessionId: string, summary: string, fromMsgId: string, toMsgId: string, userMsgCount: number): void {
      insertSummary.run(uuid(), sessionId, summary, fromMsgId, toMsgId, userMsgCount, estimateTokens(summary));
    },

    getMessagesSinceId(sessionId: string, sinceId: string): StoredConversationMessage[] {
      const exact = selectMessagePosition.get(sessionId, sinceId) as
        | { message_position: number }
        | undefined;
      if (exact) {
        return (selectMessagesAfterPosition.all(sessionId, exact.message_position) as any[])
          .map(storedMessage);
      }

      // Backward compatibility for summaries written before durable UUID
      // anchors were fixed. Legacy msg-N meant the zero-based position in this
      // session; convert it once at read time rather than treating it as a DB id.
      const legacy = /^msg-(\d+)$/.exec(sinceId);
      if (!legacy) return [];
      const index = Number.parseInt(legacy[1], 10);
      return (selectMessages.all(sessionId) as any[])
        .slice(index + 1)
        .map(storedMessage);
    },

    deleteSession(sessionId: string): void {
      deleteMessagesStmt.run(sessionId);
      deleteSessionStmt.run(sessionId);
    },

    getActiveSessionId(type: SessionType): string | null {
      const row = selectActiveSession.get(type) as any;
      return row?.id ?? null;
    },

    pruneOldSessions(): void {
      // Delete subagent sessions older than 1 hour
      db.prepare("DELETE FROM llm_messages WHERE session_id IN (SELECT id FROM llm_sessions WHERE session_type = 'subagent' AND last_active_at < datetime('now', '-1 hour'))").run();
      db.prepare("DELETE FROM llm_sessions WHERE session_type = 'subagent' AND last_active_at < datetime('now', '-1 hour')").run();
    },
  };
}
