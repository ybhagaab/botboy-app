/**
 * Node Description Generator — generates 2-4 sentence descriptions via ACP.
 * Tracks item counts for regeneration threshold logic.
 */

import type { AcpClient } from './acp-client.js';
import type { NodeManager } from './node-manager.js';

export interface NodeDescriptionGenerator {
  generateDescription(nodeId: string): Promise<string>;
  generateBatchDescriptions(nodeIds: string[]): Promise<Map<string, string>>;
  shouldRegenerate(nodeId: string): boolean;
}

export function createDescriptionGenerator(
  acpClient: AcpClient,
  nodeManager: NodeManager,
): NodeDescriptionGenerator {
  // Track last known item count and child count per node for regeneration logic
  const lastItemCounts = new Map<string, number>();
  const lastChildCounts = new Map<string, number>();

  function parseDescription(response: string): string {
    // Strip markdown fences or quotes if present
    let desc = response.trim();
    desc = desc.replace(/^```[\s\S]*?```$/gm, '').trim();
    desc = desc.replace(/^["']|["']$/g, '').trim();
    // Limit to ~4 sentences
    const sentences = desc.split(/(?<=[.!?])\s+/).slice(0, 4);
    return sentences.join(' ').trim() || desc.slice(0, 500);
  }

  return {
    async generateDescription(nodeId: string): Promise<string> {
      const node = nodeManager.getNode(nodeId);
      if (!node) throw new Error(`Node ${nodeId} not found`);

      const items = nodeManager.getNodeWorkItems(nodeId);
      const children = nodeManager.getChildren(nodeId);
      const itemSummaries = items.slice(0, 8).map(i =>
        `- ${(i.title || '(untitled)').slice(0, 60)}`
      ).join('\n');

      const childInfo = children.length > 0
        ? `\nSub-nodes: ${children.map(c => c.title).join(', ')}`
        : '';

      const prompt = `Write a 2-sentence description for this node. What it covers and key themes.

"${node.title}" (${items.length} items)
${itemSummaries || '(no items)'}${childInfo}

Return ONLY the description.`;

      if (!acpClient.isAvailable()) {
        return `${node.title} — contains ${items.length} tracked items.`;
      }

      const resp = await acpClient.sendPrompt(prompt);
      const desc = parseDescription(resp.content);

      // Update tracking
      lastItemCounts.set(nodeId, items.length);
      lastChildCounts.set(nodeId, children.length);

      // Store via nodeManager
      nodeManager.updateNode(nodeId, { description: desc });
      return desc;
    },

    async generateBatchDescriptions(nodeIds: string[]): Promise<Map<string, string>> {
      const results = new Map<string, string>();
      if (nodeIds.length === 0) return results;

      if (!acpClient.isAvailable()) {
        for (const id of nodeIds) {
          const node = nodeManager.getNode(id);
          const count = nodeManager.getNodeItemCount(id);
          const desc = `${node?.title ?? 'Node'} — contains ${count} tracked items.`;
          results.set(id, desc);
          nodeManager.updateNode(id, { description: desc });
        }
        return results;
      }

      // Build batch prompt
      const nodeInfos = nodeIds.map(id => {
        const node = nodeManager.getNode(id);
        if (!node) return null;
        const items = nodeManager.getNodeWorkItems(id);
        const itemList = items.slice(0, 4).map(i => `${(i.title || '?').slice(0, 40)}`).join(', ');
        return { id, title: node.title, itemCount: items.length, itemList };
      }).filter(Boolean) as { id: string; title: string; itemCount: number; itemList: string }[];

      const prompt = `Write 2-sentence descriptions for each node. Return JSON: {"descriptions":{"nodeId":"desc",...}}

${nodeInfos.map(n => `- "${n.title}" [${n.id}] (${n.itemCount} items: ${n.itemList})`).join('\n')}`;

      try {
        const resp = await acpClient.sendPrompt(prompt);
        const match = resp.content.match(/\{[\s\S]*\}/);
        if (match) {
          const parsed = JSON.parse(match[0]);
          const descs = parsed.descriptions || parsed;
          for (const [id, desc] of Object.entries(descs)) {
            if (typeof desc === 'string' && nodeIds.includes(id)) {
              results.set(id, desc);
              nodeManager.updateNode(id, { description: desc });
              const items = nodeManager.getNodeWorkItems(id);
              lastItemCounts.set(id, items.length);
              lastChildCounts.set(id, nodeManager.getChildren(id).length);
            }
          }
        }
      } catch {
        // Fallback: generate individually
        for (const id of nodeIds) {
          if (!results.has(id)) {
            try {
              const desc = await this.generateDescription(id);
              results.set(id, desc);
            } catch { /* skip */ }
          }
        }
      }

      return results;
    },

    shouldRegenerate(nodeId: string): boolean {
      const node = nodeManager.getNode(nodeId);
      if (!node) return false;
      if (!node.description) return true;

      const currentItemCount = nodeManager.getNodeItemCount(nodeId);
      const lastCount = lastItemCounts.get(nodeId);

      // If we have no record, assume it needs regeneration
      if (lastCount === undefined) {
        lastItemCounts.set(nodeId, currentItemCount);
        return false; // First check — don't regenerate immediately
      }

      // Item count changed by >20%
      if (lastCount > 0 && Math.abs(currentItemCount - lastCount) / lastCount > 0.2) {
        return true;
      }
      // Went from 0 to having items
      if (lastCount === 0 && currentItemCount > 0) return true;

      // New children created
      const currentChildCount = nodeManager.getChildren(nodeId).length;
      const lastChildren = lastChildCounts.get(nodeId) ?? 0;
      if (currentChildCount > lastChildren) return true;

      return false;
    },
  };
}
