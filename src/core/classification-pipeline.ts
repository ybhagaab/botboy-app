/**
 * Hybrid Classification Pipeline — embeddings for fast scoring, LLM for decisions.
 * Routes items based on confidence: >0.6 embedding-only, 0.2-0.6 hybrid, <0.2 LLM-only.
 */

import type { AcpClient } from './acp-client.js';
import type { Classifier } from './classifier.js';
import type { TieredContextManager } from './context-sync.js';
import type { WorkItem, Node, ClassificationDecision, NodeAssignment } from './types.js';

export interface ClassificationPipeline {
  classifyItem(item: WorkItem, nodes: Node[]): Promise<ClassificationDecision>;
  classifyBatch(items: WorkItem[], nodes: Node[]): Promise<ClassificationDecision[]>;
}

export function createClassificationPipeline(
  embeddingClassifier: Classifier,
  acpClient: AcpClient,
  contextManager: TieredContextManager,
): ClassificationPipeline {
  let ollamaAvailable = true;

  async function classifyViaLlm(item: WorkItem, nodes: Node[]): Promise<ClassificationDecision> {
    const nodeList = nodes.map(n => `- "${n.title}" [id:${n.id}]`).join('\n');
    const prompt = `Classify this work item into the most relevant node(s). Return JSON only.

Item: [${item.type}] ${item.title || '(untitled)'}
URL: ${item.url || 'none'}
Content: ${(item.summary || item.title || '').slice(0, 500)}

Nodes:
${nodeList}

Return: {"summary":"2-4 sentence summary","assignments":[{"nodeId":"...","confidence":0.8,"reason":"..."}],"newNodeSuggestion":"title if no node fits, or null","reasoning":"why"}`;

    const resp = await acpClient.sendPrompt(prompt);
    const match = resp.content.match(/\{[\s\S]*\}/);
    if (!match) {
      return {
        itemId: item.id, summary: item.title || '', assignments: [],
        reasoning: 'LLM response unparseable', method: 'llm',
      };
    }
    const parsed = JSON.parse(match[0]);
    return {
      itemId: item.id,
      summary: parsed.summary || item.title || '',
      assignments: (parsed.assignments || []).map((a: any) => ({
        nodeId: a.nodeId, confidence: a.confidence || 0.5, reason: a.reason || '',
      })),
      newNodeSuggestion: parsed.newNodeSuggestion || undefined,
      reasoning: parsed.reasoning || '',
      method: 'llm',
    };
  }

  return {
    async classifyItem(item: WorkItem, nodes: Node[]): Promise<ClassificationDecision> {
      // Step 1: Try embedding similarity
      if (ollamaAvailable && nodes.length > 0) {
        try {
          const embResult = await embeddingClassifier.classify(item);
          const high = embResult.assignments.filter(a => a.confidence > 0.6);
          const ambiguous = embResult.assignments.filter(a => a.confidence >= 0.2 && a.confidence <= 0.6);

          if (high.length > 0 && ambiguous.length === 0) {
            return {
              itemId: item.id,
              summary: item.summary || item.title || '',
              assignments: high.map(a => ({ nodeId: a.nodeId, confidence: a.confidence, reason: 'embedding similarity' })),
              reasoning: `Embedding confidence > 0.6 for ${high.length} node(s)`,
              method: 'embedding',
            };
          }

          if (ambiguous.length > 0 && acpClient.isAvailable()) {
            const llmResult = await classifyViaLlm(item, nodes);
            return { ...llmResult, method: 'hybrid' };
          }
        } catch {
          ollamaAvailable = false;
        }
      }

      // Step 2: LLM-only fallback
      if (acpClient.isAvailable()) {
        return classifyViaLlm(item, nodes);
      }

      // Step 3: No classification available
      return {
        itemId: item.id, summary: item.title || '', assignments: [],
        reasoning: 'No classifier available', method: 'llm',
      };
    },

    async classifyBatch(items: WorkItem[], nodes: Node[]): Promise<ClassificationDecision[]> {
      const results: ClassificationDecision[] = [];
      for (const item of items) {
        results.push(await this.classifyItem(item, nodes));
      }
      return results;
    },
  };
}
