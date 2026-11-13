/**
 * Chat Interface — routes messages through the Agent Orchestrator.
 */

import Database from 'better-sqlite3';
import { randomUUID as uuid } from 'node:crypto';
import type { ChatMessage, ChatResponse } from './types.js';
import type { AgentOrchestrator } from './agent.js';
import { parseChatNotice } from './chat-notices.js';

export interface ChatInterface {
  sendMessage(message: string, nodeId?: string): Promise<ChatResponse>;
  /** The main chat's transcript (rows that belong to no job's thread). */
  getHistory(limit?: number): ChatMessage[];
  /** One job's thread (PARALLEL_JOBS_PLAN.md PJ1). */
  getJobHistory(jobId: string, limit?: number): ChatMessage[];
}

export function createChatInterface(db: Database.Database, agent: AgentOrchestrator): ChatInterface {
  const insertMsg = db.prepare(
    'INSERT INTO chat_messages (id, role, content, actions_performed) VALUES (?, ?, ?, ?)'
  );
  // rowid breaks ties: rows written in the same second keep the order they were written in.
  const selectHistory = db.prepare(
    'SELECT * FROM (SELECT rowid AS position, * FROM chat_messages WHERE job_id IS NULL ORDER BY created_at DESC, rowid DESC LIMIT ?) ORDER BY created_at ASC, position ASC'
  );
  const selectJobHistory = db.prepare(
    'SELECT * FROM (SELECT rowid AS position, * FROM chat_messages WHERE job_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?) ORDER BY created_at ASC, position ASC'
  );

  // Image attachments (2026-09-05): attachments_json holds an id array; the
  // UI renders thumbnails from the GET route. Parse failures degrade to a
  // text-only message rather than breaking the whole history payload.
  function toAttachments(json: string | null): { id: string; url: string }[] | undefined {
    if (!json) return undefined;
    try {
      const ids = JSON.parse(json);
      if (!Array.isArray(ids) || ids.length === 0) return undefined;
      return ids.map((id: unknown) => ({ id: String(id), url: `/api/chat/attachments/${String(id)}` }));
    } catch {
      return undefined;
    }
  }

  function toMessage(row: any): ChatMessage {
    const notice = parseChatNotice(row.notice_json ?? null);
    return {
      id: row.id, role: row.role, content: row.content,
      actionsPerformed: row.actions_performed ? JSON.parse(row.actions_performed) : undefined,
      attachments: toAttachments(row.attachments_json ?? null),
      ...(row.job_id ? { jobId: String(row.job_id) } : {}),
      ...(row.ref_job_id ? { refJobId: String(row.ref_job_id) } : {}),
      ...(notice ? { notice } : {}),
      createdAt: storedTime(row.created_at),
    };
  }
  /**
   * created_at is SQLite's datetime('now'): UTC without a zone ("2026-10-29 04:26:20"), which `new Date` reads as local time
   * (8 hours early on a +08 Mac). Notices show their time, so it must be the real one.
   */
  function storedTime(value: unknown): Date {
    const text = String(value ?? '');
    return /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(text) ? new Date(`${text.replace(' ', 'T')}Z`) : new Date(text);
  }

  return {
    async sendMessage(message: string, nodeId?: string): Promise<ChatResponse> {
      const userMsg: ChatMessage = { id: uuid(), role: 'user', content: message, createdAt: new Date() };
      insertMsg.run(userMsg.id, 'user', message, null);

      // kiro-cli maintains chat history within the ACP session natively
      // No need to inject history — it's all in the 1M context window
      // The owner's own chat message (non-streaming path): an owner-started run.
      const responseContent = await agent.executeAction(message, nodeId, { workload: 'interactive', startedByOwner: true });

      const assistantMsg: ChatMessage = { id: uuid(), role: 'assistant', content: responseContent, createdAt: new Date() };
      insertMsg.run(assistantMsg.id, 'assistant', responseContent, null);

      return { message: assistantMsg };
    },

    getHistory(limit = 100): ChatMessage[] {
      return (selectHistory.all(limit) as any[]).map(toMessage);
    },

    getJobHistory(jobId: string, limit = 200): ChatMessage[] {
      return (selectJobHistory.all(jobId, limit) as any[]).map(toMessage);
    },
  };
}
