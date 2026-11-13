/**
 * Conversation Manager — stores chat history in SQLite.
 * Replaces kiro-cli's internal session management.
 * Sliding window keeps messages within token budget.
 */

import Database from 'better-sqlite3';
import { randomUUID as uuid } from 'node:crypto';
import type { LlmMessage } from './llm-client.js';
import { selectHistoryWindow, type HistoryWindow, type HistoryWindowOptions } from './chat-history-window.js';

export type SessionType = 'chat' | 'background' | 'subagent';

/** Newest rows read for one history window: enough for the 50K budget and the owner's older messages behind a long job. */
const HISTORY_SCAN_ROWS = 1_000;

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
  /**
   * The history one chat turn sends word for word, oldest first (chat-history-window.ts › selectHistoryWindow): the newest messages
   * up to a token budget, and the owner's own last messages however many automatic turns ran in between.
   */
  getHistoryWindow(sessionId: string, options: HistoryWindowOptions): { messages: LlmMessage[]; window: Omit<HistoryWindow, 'rows'> };
  countUserMessages(sessionId: string): number;
  getSummary(sessionId: string): { summary: string; coversFromMsgId: string; coversToMsgId: string; userMsgCount: number } | null;
  saveSummary(sessionId: string, summary: string, fromMsgId: string, toMsgId: string, userMsgCount: number): void;
  getMessagesSinceId(sessionId: string, sinceId: string): StoredConversationMessage[];
  deleteSession(sessionId: string): void;
  /** The newest active session of this type that is not a job's thread (the main chat for 'chat'). */
  getActiveSessionId(type: SessionType): string | null;
  /**
   * A job's own thread (PARALLEL_JOBS_PLAN.md PJ1): the chat session bound to this job, created on first use. The main chat
   * lookup never returns it, and it never returns the main chat.
   */
  threadSessionId(jobId: string): string;
  /**
   * Copies messages of `fromSessionId` written at or after `sinceIso` (the newest `limit`, in order) to the end of
   * `toSessionId`. Used once, to give a job that started before threads existed its own history. Returns how many it copied.
   */
  copyMessagesSince(fromSessionId: string, toSessionId: string, sinceIso: string, limit: number): number;
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

  // A job's thread is a chat session tagged with its job (2026-10-28, PARALLEL_JOBS_PLAN.md); untagged chat sessions are the main chat.
  const sessionColumns = new Set((db.prepare('PRAGMA table_info(llm_sessions)').all() as Array<{ name: string }>).map(column => column.name));
  if (!sessionColumns.has('thread_job_id')) db.exec('ALTER TABLE llm_sessions ADD COLUMN thread_job_id TEXT');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_llm_sessions_thread_job ON llm_sessions(thread_job_id) WHERE thread_job_id IS NOT NULL');

  const insertSession = db.prepare('INSERT INTO llm_sessions (id, session_type) VALUES (?, ?)');
  const insertThreadSession = db.prepare("INSERT INTO llm_sessions (id, session_type, thread_job_id) VALUES (?, 'chat', ?)");
  const selectThreadSession = db.prepare('SELECT id FROM llm_sessions WHERE thread_job_id = ?');
  const insertMessage = db.prepare('INSERT INTO llm_messages (id, session_id, role, content, tool_calls, tool_call_id, token_count) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const selectMessages = db.prepare('SELECT rowid AS message_position, * FROM llm_messages WHERE session_id = ? ORDER BY rowid ASC');
  const deleteSessionStmt = db.prepare('DELETE FROM llm_sessions WHERE id = ?');
  const deleteMessagesStmt = db.prepare('DELETE FROM llm_messages WHERE session_id = ?');
  const updateLastActive = db.prepare("UPDATE llm_sessions SET last_active_at = datetime('now') WHERE id = ?");
  const selectActiveSession = db.prepare("SELECT id FROM llm_sessions WHERE session_type = ? AND status = 'active' AND thread_job_id IS NULL ORDER BY last_active_at DESC LIMIT 1");
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

    getHistoryWindow(sessionId: string, options: HistoryWindowOptions) {
      // The same rows as getRecentMessages (every role but system), newest first, with their stored token estimate.
      const newestFirst = (selectRecentMessages.all(sessionId, HISTORY_SCAN_ROWS) as any[]).map(row => ({
        id: String(row.id),
        role: String(row.role),
        content: row.content ?? null,
        tokens: Number(row.token_count) || 0,
        ...(row.tool_call_id ? { toolCallId: String(row.tool_call_id) } : {}),
      }));
      const { rows, ...window } = selectHistoryWindow(newestFirst, options);
      return {
        messages: rows.map(row => ({ role: row.role as LlmMessage['role'], content: row.content as string, toolCallId: row.toolCallId })),
        window,
      };
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

    threadSessionId(jobId: string): string {
      const existing = selectThreadSession.get(jobId) as { id: string } | undefined;
      if (existing) return existing.id;
      const id = uuid();
      // The unique index makes a second creation for the same job fail; the loser reads the winner's id.
      try { insertThreadSession.run(id, jobId); } catch { return (selectThreadSession.get(jobId) as { id: string }).id; }
      return id;
    },

    copyMessagesSince(fromSessionId: string, toSessionId: string, sinceIso: string, limit: number): number {
      // created_at is SQLite's datetime('now') (UTC, "YYYY-MM-DD HH:MM:SS"); compare in that form.
      const since = sinceIso.replace('T', ' ').replace(/\.\d+Z?$|Z$/, '');
      const rows = (db.prepare(`SELECT * FROM (SELECT rowid AS position, * FROM llm_messages WHERE session_id = ? AND created_at >= ? AND role != 'system'
        ORDER BY rowid DESC LIMIT ?) ORDER BY position ASC`).all(fromSessionId, since, Math.max(0, limit)) as any[]);
      const copy = db.transaction(() => {
        for (const row of rows) insertMessage.run(uuid(), toSessionId, row.role, row.content, row.tool_calls, row.tool_call_id, row.token_count);
      });
      copy();
      if (rows.length) updateLastActive.run(toSessionId);
      return rows.length;
    },

    pruneOldSessions(): void {
      // Delete subagent sessions older than 1 hour
      db.prepare("DELETE FROM llm_messages WHERE session_id IN (SELECT id FROM llm_sessions WHERE session_type = 'subagent' AND last_active_at < datetime('now', '-1 hour'))").run();
      db.prepare("DELETE FROM llm_sessions WHERE session_type = 'subagent' AND last_active_at < datetime('now', '-1 hour')").run();
    },
  };
}
