/**
 * Subagent Delegator — delegates heavy tasks to kiro-cli subagents.
 * URL fetching, document parsing, and batch classification.
 */

import type { AcpClient } from './acp-client.js';
import type { WorkItem, Node, BatchClassifyResult } from './types.js';

export interface SubagentDelegator {
  fetchUrlContent(url: string): Promise<string>;
  parseDocument(filePath: string): Promise<string>;
  batchClassify(items: WorkItem[], nodes: Node[]): Promise<BatchClassifyResult[]>;
}

export function createSubagentDelegator(acpClient: AcpClient): SubagentDelegator {
  async function delegateWithTimeout(prompt: string, timeoutMs = 60000): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const result = await acpClient.sendPrompt(prompt);
      return result.content;
    } finally {
      clearTimeout(timer);
    }
  }

  function validateResult(result: string, context: string): string {
    if (!result || result.trim().length === 0) {
      throw new Error(`Subagent returned empty result for: ${context}`);
    }
    return result.trim();
  }

  return {
    async fetchUrlContent(url: string): Promise<string> {
      const prompt = `Read the content of this URL and return a clean text summary (2-4 paragraphs): ${url}`;
      const result = await delegateWithTimeout(prompt);
      return validateResult(result, `URL fetch: ${url}`);
    },

    async parseDocument(filePath: string): Promise<string> {
      const prompt = `Read and summarize this document file: ${filePath}`;
      const result = await delegateWithTimeout(prompt);
      return validateResult(result, `Document parse: ${filePath}`);
    },

    async batchClassify(items: WorkItem[], nodes: Node[]): Promise<BatchClassifyResult[]> {
      const nodeList = nodes.map(n => `- "${n.title}" [id:${n.id}]`).join('\n');
      const itemList = items.map(i => `- [${i.type}] ${i.title || '?'} [id:${i.id}]`).join('\n');
      const prompt = `Classify these items into nodes. Return JSON array: [{"itemId":"...","summary":"...","nodeIds":["..."],"reasoning":"..."}]\n\nNodes:\n${nodeList}\n\nItems:\n${itemList}`;
      const result = await delegateWithTimeout(prompt, 120000);
      const match = result.match(/\[[\s\S]*\]/);
      if (!match) return [];
      return JSON.parse(match[0]) as BatchClassifyResult[];
    },
  };
}
