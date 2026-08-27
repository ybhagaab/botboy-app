/**
 * Agent Orchestrator — the brain that processes inbox items.
 * Triages via L0, enriches via L2/subagents, classifies via hybrid pipeline.
 */

import Database from 'better-sqlite3';
import { v4 as uuid } from 'uuid';
import type { AcpClient } from './acp-client.js';
import type { LlmClient, ToolCall } from './llm-client.js';
import type { ToolExecutor } from './tool-executor.js';
import { type PromptManager } from './prompt-manager.js';
import type { NodeManager } from './node-manager.js';
import type { McpManager } from './mcp-types.js';
import type { TieredContextManager } from './context-sync.js';
import type { ClassificationPipeline } from './classification-pipeline.js';
import type { SubagentDelegator } from './subagent-delegator.js';
import type { WorkItem, ProcessingResult, ProcessingStatus, ProcessOptions } from './types.js';

export interface AgentOrchestrator {
  processInboxItems(options?: ProcessOptions): Promise<ProcessingResult>;
  processItem(itemId: string): Promise<ProcessingResult>;
  executeAction(instruction: string, nodeId?: string): Promise<string>;
  getProcessingStatus(): ProcessingStatus;
}

export function createAgentOrchestrator(
  db: Database.Database,
  acpClient: AcpClient,
  nodeManager: NodeManager,
  // Legacy classification plane (retired July 2026). When absent, the chat
  // tool loop (executeAction) still works; inbox classification is disabled.
  contextManager?: TieredContextManager,
  pipeline?: ClassificationPipeline,
  delegator?: SubagentDelegator,
  llmClient?: LlmClient,
  toolExecutor?: ToolExecutor,
  promptManager?: PromptManager,
  mcpManager?: McpManager,
): AgentOrchestrator {
  let status: ProcessingStatus = { active: false, progress: { done: 0, total: 0 } };

  function toWorkItem(r: any): WorkItem {
    return {
      id: r.id, type: r.type, source: r.source, sourceApp: r.source_app,
      title: r.title, summary: r.summary, url: r.url, filePath: r.file_path,
      contentHash: r.content_hash, screenshotPath: r.screenshot_path,
      visualContext: r.visual_context,
      metadata: r.metadata ? JSON.parse(r.metadata) : {},
      parsedText: r.parsed_text,
      capturedAt: new Date(r.captured_at), createdAt: new Date(r.created_at),
    };
  }

  function getUnprocessed(limit: number): WorkItem[] {
    return (db.prepare(`
      SELECT * FROM work_items
      WHERE id NOT IN (SELECT work_item_id FROM node_work_items)
      ORDER BY captured_at DESC LIMIT ?
    `).all(limit) as any[]).map(toWorkItem);
  }

  return {
    async processInboxItems(options?: ProcessOptions): Promise<ProcessingResult> {
      const opts = { batchSize: 15, useSubagents: true, ...options };
      const result: ProcessingResult = { processed: 0, assigned: 0, newNodes: [], errors: [], duration: 0 };
      const start = Date.now();

      if (!pipeline) {
        result.errors.push('Legacy classification plane is disabled (items are routed by the lossless pipeline; start with PPT_LEGACY=1 to re-enable)');
        return result;
      }

      contextManager?.syncAll();
      const items = getUnprocessed(opts.batchSize);
      if (!items.length) return result;

      status = { active: true, progress: { done: 0, total: items.length }, startedAt: new Date() };

      const runId = uuid();
      db.prepare('INSERT INTO processing_runs (id, total_items) VALUES (?, ?)').run(runId, items.length);

      const activeNodes = nodeManager.listNodes('active');

      for (const item of items) {
        status.currentItem = item.title || item.id;
        try {
          // Enrich sparse items
          if (item.url && (!item.summary || item.summary.length < 50) && delegator && opts.useSubagents) {
            try {
              const content = await delegator.fetchUrlContent(item.url);
              db.prepare('UPDATE work_items SET parsed_text = ? WHERE id = ?').run(content, item.id);
              item.parsedText = content;
            } catch { /* continue with available content */ }
          }

          const decision = await pipeline.classifyItem(item, activeNodes);

          db.prepare('UPDATE work_items SET summary = ? WHERE id = ?').run(decision.summary, item.id);

          for (const a of decision.assignments) {
            nodeManager.addWorkItemToNode(item.id, a.nodeId, 'classifier');
            result.assigned++;
          }

          if (decision.newNodeSuggestion) {
            const newNode = nodeManager.createNode(decision.newNodeSuggestion);
            nodeManager.addWorkItemToNode(item.id, newNode.id, 'classifier');
            result.newNodes.push(newNode.id);
            activeNodes.push(newNode);
          }

          result.processed++;
        } catch (e: any) {
          result.errors.push(`${item.id}: ${e.message}`);
        }
        status.progress.done++;
      }

      result.duration = Date.now() - start;
      db.prepare("UPDATE processing_runs SET status = 'completed', processed_items = ?, assigned_items = ?, completed_at = datetime('now') WHERE id = ?")
        .run(result.processed, result.assigned, runId);

      contextManager?.syncAll();
      status = { active: false, progress: { done: items.length, total: items.length } };
      return result;
    },

    async processItem(itemId: string): Promise<ProcessingResult> {
      if (!pipeline) {
        return { processed: 0, assigned: 0, newNodes: [], errors: ['Legacy classification plane is disabled (start with PPT_LEGACY=1 to re-enable)'], duration: 0 };
      }
      const row = db.prepare('SELECT * FROM work_items WHERE id = ?').get(itemId) as any;
      if (!row) return { processed: 0, assigned: 0, newNodes: [], errors: ['Not found'], duration: 0 };
      const item = toWorkItem(row);
      const nodes = nodeManager.listNodes('active');
      const result: ProcessingResult = { processed: 0, assigned: 0, newNodes: [], errors: [], duration: 0 };
      const start = Date.now();
      try {
        const decision = await pipeline.classifyItem(item, nodes);
        db.prepare('UPDATE work_items SET summary = ? WHERE id = ?').run(decision.summary, item.id);
        for (const a of decision.assignments) {
          nodeManager.addWorkItemToNode(item.id, a.nodeId, 'classifier');
          result.assigned++;
        }
        result.processed = 1;
      } catch (e: any) {
        result.errors.push(e.message);
      }
      result.duration = Date.now() - start;
      return result;
    },

    async executeAction(instruction: string, nodeId?: string): Promise<string> {
      const nodes = nodeManager.listNodes('active');
      // Same live MCP inventory as the SSE chat route: the agent knows every
      // callable server and tool up front, no discovery round-trip needed.
      const mcpServers = mcpManager
        ? await mcpManager.listProfiles().catch((error: any) => {
            console.warn(`[Agent] MCP inventory load failed: ${error?.message ?? error}`);
            return undefined;
          })
        : undefined;
      const promptContext = { nodes, mcpServers };
      const systemPrompt = promptManager
        ? promptManager.getSystemPrompt('chat', promptContext)
        : `You are BotBoy, an autonomous productivity assistant managing a personal knowledge tracker.
YOUR DATA ACCESS: SQLite DB at ~/.personal-productivity-tracker/tracker.db, REST API at http://localhost:7778/api, source code at src/ui/.
Active nodes (${nodes.length}):
${nodes.slice(0, 20).map(n => '"' + n.title + '" (' + nodeManager.getNodeItemCount(n.id) + ' items)').join(', ')}
Be concise, helpful, proactive. You have full authority.`;

      let userMsg = instruction;
      if (nodeId) {
        const n = nodeManager.getNode(nodeId);
        if (n) {
          const items = nodeManager.getNodeWorkItems(nodeId).slice(0, 10);
          userMsg += '\n[Context: Node "' + n.title + '", items: ' + items.map(i => i.title).join(', ') + ']';
        }
      }
      try {
        // If we have LlmClient + ToolExecutor, use the tool execution loop
        if (llmClient && toolExecutor && promptManager) {
          const tools = promptManager.getToolDefinitions('chat', promptContext);
          const messages: any[] = [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userMsg },
          ];

          // Max reasoning for document-writing iterations, armed by the
          // model's own get_document_writing_guide call (mirrors the SSE
          // chat route). Normal turns think only on the first call.
          let documentAuthoringThink = false;
          // 15 (was 8, raised 2026-08-28 alongside the chat-loop uncap).
          // Background executions stay CAPPED by design: this path runs
          // unattended (background jobs, reader assist, sentinel composing)
          // with nobody watching and no Stop button — bounded autonomy here,
          // unbounded work only in interactive chat where the owner presides.
          for (let i = 0; i < 15; i++) {
            const resp = await llmClient.chatCompletion({
              messages,
              tools,
              think: i === 0 || documentAuthoringThink,
              ...(documentAuthoringThink ? { reasoningEffort: 'max' as const } : {}),
            });

            if (!resp.toolCalls?.length) {
              return resp.content || '';
            }

            // Execute tool calls
            messages.push({
              role: 'assistant',
              content: resp.content,
              toolCalls: resp.toolCalls,
              providerOutput: resp.providerOutput,
            });
            for (const tc of resp.toolCalls) {
              const result = await toolExecutor.executeTool(tc, {
                currentUserMessage: instruction,
              });
              if (tc.function.name === 'get_document_writing_guide') documentAuthoringThink = true;
              messages.push({ role: 'tool', content: result.content, toolCallId: tc.id });
            }
          }
          return messages.filter(m => m.role === 'assistant' && m.content).pop()?.content || '';
        }
        // Fallback: simple prompt (no tools)
        const resp = await acpClient.sendPrompt(systemPrompt + '\n\nUser: ' + userMsg);
        return resp.content;
      } catch (e: any) {
        return 'Error: ' + e.message;
      }
    },

    getProcessingStatus: () => ({ ...status }),
  };
}

// Backward-compatible alias
export const createAgent = createAgentOrchestrator;
