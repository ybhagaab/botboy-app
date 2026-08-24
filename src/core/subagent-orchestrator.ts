/**
 * Subagent Orchestrator — delegates specialized tasks to focused subagents.
 * Classification, enrichment, organization, UI adaptation, deduplication.
 * JSON retry logic. Subagent_runs tracking.
 */

import Database from 'better-sqlite3';
import { v4 as uuid } from 'uuid';
import type { AcpClient } from './acp-client.js';
import type { NodeManager } from './node-manager.js';
import type { TieredContextManager } from './context-sync.js';
import type {
  WorkItem, Node, ClassificationDecision, EnrichmentResult,
  HierarchyProposal, UIAdaptationContext, UIChangeResult,
  DeduplicationResult, DuplicateGroup,
} from './types.js';

const MIN_ITEMS_FOR_HIERARCHY = 8;

export interface SubagentOrchestrator {
  classifyItems(items: WorkItem[], nodes: Node[]): Promise<ClassificationDecision[]>;
  enrichItems(items: WorkItem[]): Promise<EnrichmentResult[]>;
  organizeNode(nodeId: string): Promise<HierarchyProposal>;
  adaptUI(context: UIAdaptationContext): Promise<UIChangeResult>;
  deduplicateItems(items: WorkItem[]): Promise<DeduplicationResult>;
}

export function createSubagentOrchestrator(
  db: Database.Database,
  acpClient: AcpClient,
  nodeManager: NodeManager,
  _contextManager: TieredContextManager,
): SubagentOrchestrator {

  function logSubagentRun(bgRunId: string | null, type: string, status: string, inputSummary: string, outputSummary: string, durationMs: number): void {
    try {
      db.prepare(`INSERT INTO subagent_runs (id, background_run_id, subagent_type, status, input_summary, output_summary, duration_ms, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))`)
        .run(uuid(), bgRunId, type, status, inputSummary.slice(0, 500), outputSummary.slice(0, 500), durationMs);
    } catch { /* logging should not break processing */ }
  }

  function parseJsonFromResponse(content: string): any {
    // Try to extract JSON object or array
    const objMatch = content.match(/\{[\s\S]*\}/);
    if (objMatch) return JSON.parse(objMatch[0]);
    const arrMatch = content.match(/\[[\s\S]*\]/);
    if (arrMatch) return JSON.parse(arrMatch[0]);
    throw new Error('No JSON found in response');
  }

  async function sendWithRetry(prompt: string, retryPrompt?: string): Promise<any> {
    try {
      const resp = await acpClient.sendPrompt(prompt);
      return parseJsonFromResponse(resp.content);
    } catch {
      if (retryPrompt) {
        const resp2 = await acpClient.sendPrompt(retryPrompt);
        return parseJsonFromResponse(resp2.content);
      }
      throw new Error('Invalid JSON from subagent after retry');
    }
  }

  return {
    async classifyItems(items: WorkItem[], nodes: Node[]): Promise<ClassificationDecision[]> {
      if (!acpClient.isAvailable() || items.length === 0) return [];
      const start = Date.now();

      const nodeList = nodes.map(n => `- "${n.title}" [id:${n.id}]`).join('\n');
      const itemList = items.map(i =>
        `- [${i.type}] ${i.title || '?'}: ${(i.summary || '').slice(0, 150)} [id:${i.id}]`
      ).join('\n');

      const prompt = `Classify these work items into the most relevant nodes. Return ONLY valid JSON array.

Nodes:
${nodeList}

Items:
${itemList}

Return JSON: [{"itemId":"...","summary":"2-4 sentence summary","assignments":[{"nodeId":"...","confidence":0.8,"reason":"..."}],"newNodeSuggestion":null,"reasoning":"..."}]`;

      const strictPrompt = `Return ONLY a valid JSON array, no markdown, no explanation. Classify items into nodes.
Nodes: ${nodeList}
Items: ${itemList}
Format: [{"itemId":"id","summary":"text","assignments":[{"nodeId":"id","confidence":0.8,"reason":"text"}],"newNodeSuggestion":null,"reasoning":"text"}]`;

      try {
        const parsed = await sendWithRetry(prompt, strictPrompt);
        const results: ClassificationDecision[] = (Array.isArray(parsed) ? parsed : []).map((d: any) => ({
          itemId: d.itemId,
          summary: d.summary || '',
          assignments: (d.assignments || []).map((a: any) => ({
            nodeId: a.nodeId, confidence: a.confidence || 0.5, reason: a.reason || '',
          })),
          newNodeSuggestion: d.newNodeSuggestion || undefined,
          reasoning: d.reasoning || '',
          method: 'llm' as const,
        }));
        logSubagentRun(null, 'classification', 'completed', `${items.length} items`, `${results.length} decisions`, Date.now() - start);
        return results;
      } catch (e: any) {
        logSubagentRun(null, 'classification', 'failed', `${items.length} items`, e.message, Date.now() - start);
        return [];
      }
    },

    async enrichItems(items: WorkItem[]): Promise<EnrichmentResult[]> {
      if (!acpClient.isAvailable()) return [];
      const results: EnrichmentResult[] = [];
      const start = Date.now();

      for (const item of items) {
        if (!item.url || (item.parsedText && item.parsedText.length >= 100)) continue;
        try {
          const prompt = `Read the content of this URL and return a clean text summary (2-4 paragraphs): ${item.url}`;
          const resp = await acpClient.sendPrompt(prompt);
          const content = resp.content.trim();
          if (content) {
            results.push({
              itemId: item.id,
              parsedText: content,
              summary: content.slice(0, 500),
              contentType: 'webpage',
            });
          }
        } catch { /* skip failed enrichments */ }
      }

      logSubagentRun(null, 'enrichment', 'completed', `${items.length} items`, `${results.length} enriched`, Date.now() - start);
      return results;
    },

    async organizeNode(nodeId: string): Promise<HierarchyProposal> {
      const node = nodeManager.getNode(nodeId);
      if (!node) return { parentNodeId: nodeId, proposedChildren: [], itemMoves: [], parentDescription: '' };

      const items = nodeManager.getNodeWorkItems(nodeId);
      const currentChildren = nodeManager.getChildren(nodeId);

      // Guard: only organize nodes with enough items and no existing children
      if (items.length < MIN_ITEMS_FOR_HIERARCHY || currentChildren.length > 0) {
        return { parentNodeId: nodeId, proposedChildren: [], itemMoves: [], parentDescription: node.description || '' };
      }

      if (!acpClient.isAvailable()) {
        return { parentNodeId: nodeId, proposedChildren: [], itemMoves: [], parentDescription: node.description || '' };
      }

      const start = Date.now();
      const itemSummaries = items.map(i =>
        `- [${i.type}] ${i.title || '?'}: ${(i.summary || '').slice(0, 150)} [id:${i.id}]`
      ).join('\n');

      const prompt = `Analyze these ${items.length} items in node "${node.title}" and propose sub-groupings.

Items:
${itemSummaries}

Rules:
- Only create child nodes if there are clear thematic clusters (3+ items per cluster)
- Each child node needs a descriptive title and 1-2 sentence description
- Items that don't fit any cluster stay in the parent
- Return JSON: {"children":[{"title":"...","description":"...","itemIds":["..."]}],"parentDescription":"updated parent description"}`;

      const strictPrompt = `Return ONLY valid JSON. Analyze items in "${node.title}" for sub-groupings (3+ items per group).
Items: ${itemSummaries}
Format: {"children":[{"title":"text","description":"text","itemIds":["id1","id2","id3"]}],"parentDescription":"text"}`;

      try {
        const parsed = await sendWithRetry(prompt, strictPrompt);
        const validItemIds = new Set(items.map(i => i.id));
        const proposedChildren = (parsed.children || [])
          .filter((c: any) => c.itemIds && c.itemIds.length >= 3 && c.itemIds.every((id: string) => validItemIds.has(id)))
          .map((c: any) => ({ title: c.title, description: c.description || '', itemIds: c.itemIds }));

        const itemMoves = proposedChildren.flatMap((c: any) =>
          c.itemIds.map((itemId: string) => ({ workItemId: itemId, fromNodeId: nodeId, toNodeId: '' }))
        );

        const result: HierarchyProposal = {
          parentNodeId: nodeId,
          proposedChildren,
          itemMoves,
          parentDescription: parsed.parentDescription || node.description || '',
        };

        logSubagentRun(null, 'organization', 'completed', `node ${node.title} (${items.length} items)`, `${proposedChildren.length} children proposed`, Date.now() - start);
        return result;
      } catch (e: any) {
        logSubagentRun(null, 'organization', 'failed', `node ${node.title}`, e.message, Date.now() - start);
        return { parentNodeId: nodeId, proposedChildren: [], itemMoves: [], parentDescription: node.description || '' };
      }
    },

    async adaptUI(context: UIAdaptationContext): Promise<UIChangeResult> {
      if (!acpClient.isAvailable()) {
        return { appJsPatches: [], indexHtmlPatches: [], newComponents: [], applied: false };
      }
      const start = Date.now();

      const prompt = `Update the dashboard UI to display hierarchical nodes as a tree. Current app.js and index.html are provided.
Change reason: ${context.changeReason}
Node tree depth: ${JSON.stringify(context.nodeTree.node.title)}

Return JSON: {"appJsPatches":["patch1"],"indexHtmlPatches":["patch1"],"newComponents":[],"applied":true}`;

      try {
        const parsed = await sendWithRetry(prompt);
        logSubagentRun(null, 'ui_adaptation', 'completed', context.changeReason, 'patches generated', Date.now() - start);
        return {
          appJsPatches: parsed.appJsPatches || [],
          indexHtmlPatches: parsed.indexHtmlPatches || [],
          newComponents: parsed.newComponents || [],
          applied: parsed.applied ?? false,
        };
      } catch (e: any) {
        logSubagentRun(null, 'ui_adaptation', 'failed', context.changeReason, e.message, Date.now() - start);
        return { appJsPatches: [], indexHtmlPatches: [], newComponents: [], applied: false };
      }
    },

    async deduplicateItems(items: WorkItem[]): Promise<DeduplicationResult> {
      if (!acpClient.isAvailable() || items.length === 0) {
        return { duplicatesFound: [], noiseItems: [], mergeActions: [] };
      }
      const start = Date.now();

      const itemList = items.slice(0, 30).map(i =>
        `- ${i.title || '?'} | URL: ${i.url || 'none'} | Hash: ${i.contentHash || 'none'} [id:${i.id}]`
      ).join('\n');

      const prompt = `Identify duplicate and noise items. Return JSON only.

Items:
${itemList}

Return: {"duplicates":[{"canonical":"keepId","duplicates":["removeId1"],"reason":"same_url|same_content_hash|similar_title|agent_detected","confidence":0.9}],"noiseItems":["id1"],"mergeActions":[{"keepId":"id","removeIds":["id1"]}]}`;

      try {
        const parsed = await sendWithRetry(prompt);
        const result: DeduplicationResult = {
          duplicatesFound: (parsed.duplicates || []).map((d: any) => ({
            canonical: d.canonical,
            duplicates: d.duplicates || [],
            reason: d.reason || 'agent_detected',
            confidence: d.confidence || 0.7,
          })),
          noiseItems: parsed.noiseItems || [],
          mergeActions: parsed.mergeActions || [],
        };
        logSubagentRun(null, 'deduplication', 'completed', `${items.length} items`, `${result.duplicatesFound.length} groups`, Date.now() - start);
        return result;
      } catch (e: any) {
        logSubagentRun(null, 'deduplication', 'failed', `${items.length} items`, e.message, Date.now() - start);
        return { duplicatesFound: [], noiseItems: [], mergeActions: [] };
      }
    },
  };
}
