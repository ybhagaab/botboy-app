/**
 * Chat Interface — routes messages through the Agent Orchestrator.
 */

import Database from 'better-sqlite3';
import { v4 as uuid } from 'uuid';
import type { ChatMessage, ChatResponse } from './types.js';
import type { AgentOrchestrator } from './agent.js';

export interface ChatInterface {
  sendMessage(message: string, nodeId?: string): Promise<ChatResponse>;
  getHistory(limit?: number): ChatMessage[];
}

export function createChatInterface(db: Database.Database, agent: AgentOrchestrator): ChatInterface {
  const insertMsg = db.prepare(
    'INSERT INTO chat_messages (id, role, content, actions_performed) VALUES (?, ?, ?, ?)'
  );
  const selectHistory = db.prepare(
    'SELECT * FROM (SELECT * FROM chat_messages ORDER BY created_at DESC LIMIT ?) ORDER BY created_at ASC'
  );

  function toMessage(row: any): ChatMessage {
    return {
      id: row.id, role: row.role, content: row.content,
      actionsPerformed: row.actions_performed ? JSON.parse(row.actions_performed) : undefined,
      createdAt: new Date(row.created_at),
    };
  }

  return {
    async sendMessage(message: string, nodeId?: string): Promise<ChatResponse> {
      const userMsg: ChatMessage = { id: uuid(), role: 'user', content: message, createdAt: new Date() };
      insertMsg.run(userMsg.id, 'user', message, null);

      // kiro-cli maintains chat history within the ACP session natively
      // No need to inject history — it's all in the 1M context window
      const responseContent = await agent.executeAction(message, nodeId);

      const assistantMsg: ChatMessage = { id: uuid(), role: 'assistant', content: responseContent, createdAt: new Date() };
      insertMsg.run(assistantMsg.id, 'assistant', responseContent, null);

      return { message: assistantMsg };
    },

    getHistory(limit = 100): ChatMessage[] {
      return (selectHistory.all(limit) as any[]).map(toMessage);
    },
  };
}
