/**
 * Background Processor — sends ONE prompt to the agent per tick.
 * The agent handles all orchestration (classify, enrich, organize, describe)
 * internally using subagents. This avoids multiple ACP calls that kill the session.
 */

import Database from 'better-sqlite3';
import { v4 as uuid } from 'uuid';
import type { AcpClient } from './acp-client.js';
import type { NodeManager } from './node-manager.js';
import type { TieredContextManager } from './context-sync.js';
import type { ItemDeduplicator } from './item-deduplicator.js';
import type { NodeDescriptionGenerator } from './description-generator.js';
import type { BackgroundRunResult, WorkItem } from './types.js';

// Re-export for routes.ts
export type { SubagentOrchestrator } from './subagent-orchestrator.js';

export interface BackgroundProcessor {
  start(intervalMs?: number): void;
  stop(): void;
  isRunning(): boolean;
  getLastRunResult(): BackgroundRunResult | null;
  forceRun(): Promise<BackgroundRunResult>;
}

export function createBackgroundProcessor(deps: {
  db: Database.Database;
  acpClient: AcpClient;
  nodeManager: NodeManager;
  contextManager: TieredContextManager;
  deduplicator: ItemDeduplicator;
  descriptionGenerator: NodeDescriptionGenerator;
  orchestrator?: any;
  batchSize?: number;
}): BackgroundProcessor {
  const { db, acpClient, nodeManager, contextManager, deduplicator } = deps;
  const batchSize = deps.batchSize ?? 15;

  let timer: ReturnType<typeof setInterval> | null = null;
  let isProcessing = false;
  let lastResult: BackgroundRunResult | null = null;

  function emptyResult(): BackgroundRunResult {
    return { timestamp: new Date(), itemsFound: 0, itemsProcessed: 0, nodesCreated: 0, hierarchyChanges: 0, dedupActions: 0, errors: [], durationMs: 0 };
  }

  async function tick(trigger: 'timer' | 'manual' = 'timer'): Promise<BackgroundRunResult> {
    if (isProcessing) return lastResult ?? emptyResult();
    isProcessing = true;
    const startTime = Date.now();
    const runId = uuid();
    const errors: string[] = [];

    try {
      db.prepare("INSERT INTO background_runs (id, trigger, status) VALUES (?, ?, 'running')").run(runId, trigger);
    } catch {}

    try {
      // Step 1: Find unprocessed items
      const items = (db.prepare(`
        SELECT * FROM work_items
        WHERE id NOT IN (SELECT work_item_id FROM node_work_items)
        ORDER BY captured_at DESC LIMIT ?
      `).all(batchSize) as any[]);

      if (items.length === 0) {
        const r = emptyResult();
        try { db.prepare("UPDATE background_runs SET status='completed', items_found=0, completed_at=datetime('now') WHERE id=?").run(runId); } catch {}
        lastResult = r;
        return r;
      }

      // Step 2: Run heuristic dedup first (no ACP needed)
      let dedupActions = 0;
      try {
        const allUnassigned = items.map((r: any) => ({
          id: r.id, type: r.type, source: r.source, sourceApp: r.source_app,
          title: r.title, summary: r.summary, url: r.url, filePath: r.file_path,
          contentHash: r.content_hash, metadata: r.metadata ? JSON.parse(r.metadata) : {},
          capturedAt: new Date(r.captured_at), createdAt: new Date(r.created_at),
        })) as WorkItem[];

        const dupeGroups = deduplicator.findDuplicates(allUnassigned);
        const noiseIds = deduplicator.findNoiseItems(allUnassigned);
        for (const g of dupeGroups) { deduplicator.mergeItems(g.canonical, g.duplicates); dedupActions++; }
        if (noiseIds.length > 0) { deduplicator.removeNoiseItems(noiseIds); dedupActions += noiseIds.length; }
      } catch (e: any) { errors.push(`dedup: ${e.message}`); }

      // Step 2.5: Enrich URL items — DISABLED (opens tabs in debug Chrome, disruptive)
      // TODO: Re-enable when we have a headless enrichment approach

      // Step 3: Classify items via direct LLM call (no process spawning)
      let nodesCreated = 0;
      let itemsProcessed = 0;

      try {
        contextManager.syncAll();

        const remainingItems = (db.prepare(`
          SELECT id, type, title, url, summary FROM work_items
          WHERE id NOT IN (SELECT work_item_id FROM node_work_items)
          ORDER BY captured_at DESC LIMIT ?
        `).all(batchSize) as any[]);

        if (remainingItems.length > 0 && acpClient.isAvailable()) {
          const nodes = nodeManager.listNodes('active');
          // Keep prompt compact for 4K context models — truncate node list and item details
          const nodeList = nodes.slice(0, 20).map(n => `"${n.title}" [${n.id}]`).join(', ');
          const itemList = remainingItems.slice(0, 10).map((i: any) =>
            `{"id":"${i.id}","type":"${i.type}","title":"${(i.title || '').slice(0, 40).replace(/"/g, '')}"}`
          ).join(',');

          const prompt = `Classify items into nodes. Return ONLY JSON array.
Nodes: ${nodeList}
Items: [${itemList}]
Return: [{"itemId":"...","nodeId":"...","summary":"1 sentence"}]`;

          try {
            const resp = await acpClient.sendPrompt(prompt);
            // Parse JSON from response — handle markdown code blocks
            let jsonText = resp.content;
            // Strip markdown code fences if present
            jsonText = jsonText.replace(/```json\s*/gi, '').replace(/```\s*/g, '');
            const jsonMatch = jsonText.match(/\[[\s\S]*\]/);
            if (jsonMatch) {
              const decisions = JSON.parse(jsonMatch[0]) as any[];
              for (const d of decisions) {
                if (d.itemId && d.nodeId) {
                  try {
                    nodeManager.addWorkItemToNode(d.itemId, d.nodeId, 'classifier');
                    if (d.summary) db.prepare('UPDATE work_items SET summary = ? WHERE id = ?').run(d.summary, d.itemId);
                    itemsProcessed++;
                  } catch {}
                }
                if (d.newNode) {
                  try {
                    const newNode = nodeManager.createNode(d.newNode);
                    if (d.itemId) nodeManager.addWorkItemToNode(d.itemId, newNode.id, 'classifier');
                    nodesCreated++;
                  } catch {}
                }
              }
            }
          } catch (e: any) {
            errors.push(`classify: ${e.message?.slice(0, 100)}`);
          }
        }
      } catch (e: any) { errors.push(`bg: ${e.message}`); }

      // Step 4: Sync context
      try { contextManager.syncAll(); } catch {}

      // Step 5: Auto-generate node descriptions via direct LLM call
      try {
        const nodesNeedingDesc = db.prepare(`
          SELECT id, title FROM nodes
          WHERE status = 'active' AND (description IS NULL OR description = '' OR length(description) < 20)
          LIMIT 5
        `).all() as any[];

        if (nodesNeedingDesc.length > 0 && acpClient.isAvailable()) {
          for (const n of nodesNeedingDesc) {
            try {
              const items = nodeManager.getNodeWorkItems(n.id).slice(0, 5);
              const itemSummaries = items.map(i => `- ${(i.title || '').slice(0, 50)}`).join('\n');
              const prompt = `Write a 2-sentence description for node "${n.title}". Items:\n${itemSummaries}\nReturn ONLY the description.`;
              const resp = await acpClient.sendPrompt(prompt);
              const desc = resp.content.trim().replace(/^["']|["']$/g, '');
              if (desc.length > 10) {
                nodeManager.updateNode(n.id, { description: desc });
              }
            } catch {}
          }
        }
      } catch (e: any) { errors.push(`desc-step: ${e.message}`); }

      const result: BackgroundRunResult = {
        timestamp: new Date(), itemsFound: items.length, itemsProcessed,
        nodesCreated, hierarchyChanges: 0, dedupActions, errors,
        durationMs: Date.now() - startTime,
      };

      try {
        db.prepare("UPDATE background_runs SET status='completed', items_found=?, items_processed=?, nodes_created=?, dedup_actions=?, errors=?, completed_at=datetime('now') WHERE id=?")
          .run(result.itemsFound, result.itemsProcessed, result.nodesCreated, result.dedupActions, errors.join('; '), runId);
      } catch {}

      lastResult = result;
      return result;
    } catch (e: any) {
      lastResult = { ...emptyResult(), errors: [e.message], durationMs: Date.now() - startTime };
      try { db.prepare("UPDATE background_runs SET status='failed', errors=?, completed_at=datetime('now') WHERE id=?").run(e.message, runId); } catch {}
      return lastResult;
    } finally {
      isProcessing = false;
    }
  }

  return {
    start(intervalMs = 45000): void {
      if (timer) return;
      timer = setInterval(() => { tick('timer').catch(() => {}); }, intervalMs);
    },
    stop(): void { if (timer) { clearInterval(timer); timer = null; } },
    isRunning(): boolean { return timer !== null; },
    getLastRunResult(): BackgroundRunResult | null { return lastResult; },
    async forceRun(): Promise<BackgroundRunResult> { return tick('manual'); },
  };
}
