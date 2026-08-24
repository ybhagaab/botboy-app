import Database from 'better-sqlite3';
import type { WorkItem, ClassificationResult } from './types.js';
import type { EmbeddingProvider } from './embedding-provider.js';
import { cosineSimilarity } from './embedding-provider.js';

export interface Classifier {
  classify(item: WorkItem): Promise<ClassificationResult>;
  reclassifyUnassigned(nodeId: string): Promise<WorkItem[]>;
  updateNodeEmbedding(nodeId: string): Promise<void>;
}

export interface ClassifierConfig {
  confidenceThreshold: number;
}

const DEFAULT_CONFIG: ClassifierConfig = {
  confidenceThreshold: 0.6,
};

export function createClassifier(
  db: Database.Database,
  embedder: EmbeddingProvider,
  config?: Partial<ClassifierConfig>,
): Classifier {
  const cfg = { ...DEFAULT_CONFIG, ...config };

  // ── Embedding cache (in-memory, keyed by node ID) ──
  const nodeEmbeddings = new Map<string, number[]>();

  function getWorkItemText(item: WorkItem): string {
    // Prefix with source so embeddings can distinguish capture origin
    const sourceLabel = item.source === 'browser' ? '[Browser capture]'
      : item.source === 'slack' ? '[Slack message]'
      : item.source === 'clipboard' ? '[Clipboard capture]'
      : item.source === 'app' ? '[App activity]'
      : `[${item.source}]`;
    const parts = [sourceLabel, item.title, item.summary, item.url, item.parsedText, item.visualContext]
      .filter(Boolean);
    return parts.join(' ').trim() || item.type;
  }

  function getNodeContext(nodeId: string): string {
    const node = db.prepare('SELECT title, description FROM nodes WHERE id = ?').get(nodeId) as any;
    if (!node) return '';

    const items = db.prepare(`
      SELECT wi.title, wi.summary FROM work_items wi
      JOIN node_work_items nwi ON wi.id = nwi.work_item_id
      WHERE nwi.node_id = ?
      LIMIT 20
    `).all(nodeId) as any[];

    const parts = [node.title, node.description];
    for (const wi of items) {
      if (wi.title) parts.push(wi.title);
      if (wi.summary) parts.push(wi.summary);
    }
    return parts.filter(Boolean).join(' ').trim();
  }

  async function getOrBuildNodeEmbedding(nodeId: string): Promise<number[]> {
    if (nodeEmbeddings.has(nodeId)) return nodeEmbeddings.get(nodeId)!;
    const context = getNodeContext(nodeId);
    if (!context) return [];
    const embedding = await embedder.embed(context);
    nodeEmbeddings.set(nodeId, embedding);
    return embedding;
  }

  function getActiveNodeIds(): string[] {
    const rows = db.prepare("SELECT id FROM nodes WHERE status = 'active'").all() as { id: string }[];
    return rows.map(r => r.id);
  }

  return {
    async classify(item: WorkItem): Promise<ClassificationResult> {
      const text = getWorkItemText(item);
      if (!text) return { assignments: [], unassigned: true };

      const itemEmbedding = await embedder.embed(text);
      const nodeIds = getActiveNodeIds();
      const assignments: { nodeId: string; confidence: number }[] = [];

      for (const nodeId of nodeIds) {
        const nodeEmb = await getOrBuildNodeEmbedding(nodeId);
        if (nodeEmb.length === 0) continue;
        const similarity = cosineSimilarity(itemEmbedding, nodeEmb);
        if (similarity >= cfg.confidenceThreshold) {
          assignments.push({ nodeId, confidence: similarity });
        }
      }

      // Sort by confidence descending, limit to top 3
      assignments.sort((a, b) => b.confidence - a.confidence);
      const topAssignments = assignments.slice(0, 3);

      return {
        assignments: topAssignments,
        unassigned: topAssignments.length === 0,
      };
    },

    async reclassifyUnassigned(nodeId: string): Promise<WorkItem[]> {
      const unassigned = db.prepare(`
        SELECT wi.* FROM work_items wi
        WHERE wi.id NOT IN (SELECT work_item_id FROM node_work_items)
      `).all() as any[];

      const nodeEmb = await getOrBuildNodeEmbedding(nodeId);
      if (nodeEmb.length === 0) return [];

      const matched: WorkItem[] = [];
      for (const row of unassigned) {
        const text = [row.title, row.summary, row.url, row.parsed_text, row.visual_context]
          .filter(Boolean).join(' ').trim();
        if (!text) continue;

        const itemEmb = await embedder.embed(text);
        const similarity = cosineSimilarity(itemEmb, nodeEmb);
        if (similarity >= cfg.confidenceThreshold) {
          db.prepare(
            `INSERT OR IGNORE INTO node_work_items (node_id, work_item_id, assigned_by) VALUES (?, ?, 'classifier')`
          ).run(nodeId, row.id);
          matched.push({
            id: row.id, type: row.type, source: row.source,
            sourceApp: row.source_app, title: row.title, summary: row.summary,
            url: row.url, filePath: row.file_path, contentHash: row.content_hash,
            screenshotPath: row.screenshot_path, visualContext: row.visual_context,
            metadata: row.metadata ? JSON.parse(row.metadata) : {},
            parsedText: row.parsed_text, capturedAt: new Date(row.captured_at),
            createdAt: new Date(row.created_at),
          });
        }
      }
      return matched;
    },

    async updateNodeEmbedding(nodeId: string): Promise<void> {
      nodeEmbeddings.delete(nodeId);
      await getOrBuildNodeEmbedding(nodeId);
    },
  };
}
