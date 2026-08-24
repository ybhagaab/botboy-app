/**
 * Tiered Context Manager — L0/L1/L2 context files for the agent.
 * Inspired by OpenViking's filesystem paradigm.
 * L0: One-line summaries (NODES.md, INBOX.md) — always synced
 * L1: Per-node overviews (NODE-{id}.md) — synced on change
 * L2: Full item details (ITEM-{id}.md) — generated on demand
 */

import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import type { NodeManager } from './node-manager.js';

export interface TieredContextManager {
  syncAll(): void;
  syncNodes(): void;
  syncInbox(): void;
  generateNodeDetail(nodeId: string): void;
  generateItemDetail(itemId: string): void;
  getContextDir(): string;
  startAutoSync(intervalMs?: number): void;
  stopAutoSync(): void;
}

export function createTieredContextManager(
  db: Database.Database,
  nodeManager: NodeManager,
  contextDir: string,
): TieredContextManager {
  let timer: ReturnType<typeof setInterval> | null = null;

  function ensureDir(dir: string): void {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }

  function syncNodes(): void {
    ensureDir(contextDir);
    ensureDir(path.join(contextDir, 'nodes'));
    const active = nodeManager.listNodes('active');

    let content = `# Nodes (${active.length} active)\n\n`;
    for (const n of active) {
      const count = nodeManager.getNodeItemCount(n.id);
      content += `- ${n.title} (${count} items) [id:${n.id}]\n`;
    }
    fs.writeFileSync(path.join(contextDir, 'NODES.md'), content);

    // Generate L1 for each active node
    for (const n of active) {
      generateNodeDetail(n.id);
    }

    // Clean stale L1 files
    const activeIds = new Set(active.map(n => n.id));
    const nodesDir = path.join(contextDir, 'nodes');
    if (fs.existsSync(nodesDir)) {
      for (const f of fs.readdirSync(nodesDir)) {
        const match = f.match(/^NODE-(.+)\.md$/);
        if (match && !activeIds.has(match[1])) {
          fs.unlinkSync(path.join(nodesDir, f));
        }
      }
    }
  }

  function syncInbox(): void {
    ensureDir(contextDir);
    const rows = db.prepare(`
      SELECT id, type, title FROM work_items
      WHERE id NOT IN (SELECT work_item_id FROM node_work_items)
      ORDER BY captured_at DESC LIMIT 50
    `).all() as any[];

    const total = (db.prepare(`
      SELECT COUNT(*) as c FROM work_items
      WHERE id NOT IN (SELECT work_item_id FROM node_work_items)
    `).get() as any).c;

    let content = `# Inbox (${total} items)\n\n`;
    for (const r of rows) {
      content += `- [${r.type}] ${r.title || '(untitled)'} [id:${r.id}]\n`;
    }
    if (total > 50) content += `\n... and ${total - 50} more\n`;
    fs.writeFileSync(path.join(contextDir, 'INBOX.md'), content);
  }

  function generateNodeDetail(nodeId: string): void {
    ensureDir(path.join(contextDir, 'nodes'));
    const node = nodeManager.getNode(nodeId);
    if (!node) return;

    const items = nodeManager.getNodeWorkItems(nodeId);
    const count = items.length;
    const recent = items.slice(0, 10);

    let content = `# ${node.title}\n`;
    if (node.description) content += `\n${node.description}\n`;
    content += `\nItems: ${count}\n`;
    content += `Status: ${node.status}\n`;
    content += `\n## Recent Items\n\n`;
    for (const i of recent) {
      content += `- [${i.type}] ${i.title || '(untitled)'}: ${(i.summary || '').slice(0, 120)}\n`;
    }
    fs.writeFileSync(path.join(contextDir, 'nodes', `NODE-${nodeId}.md`), content);
  }

  function generateItemDetail(itemId: string): void {
    ensureDir(path.join(contextDir, 'items'));
    const row = db.prepare('SELECT * FROM work_items WHERE id = ?').get(itemId) as any;
    if (!row) return;

    let content = `# ${row.title || '(untitled)'}\n\n`;
    content += `Type: ${row.type}\n`;
    content += `Source: ${row.source}/${row.source_app || '?'}\n`;
    if (row.url) content += `URL: ${row.url}\n`;
    content += `Captured: ${row.captured_at}\n`;
    if (row.summary) content += `\n## Summary\n\n${row.summary}\n`;
    if (row.parsed_text) content += `\n## Full Content\n\n${row.parsed_text}\n`;
    if (row.metadata) {
      try {
        const meta = JSON.parse(row.metadata);
        if (Object.keys(meta).length > 0) {
          content += `\n## Metadata\n\n${JSON.stringify(meta, null, 2)}\n`;
        }
      } catch {}
    }
    fs.writeFileSync(path.join(contextDir, 'items', `ITEM-${itemId}.md`), content);
  }

  function syncAll(): void {
    syncNodes();
    syncInbox();
  }

  return {
    syncAll,
    syncNodes,
    syncInbox,
    generateNodeDetail,
    generateItemDetail,
    getContextDir: () => contextDir,
    startAutoSync(intervalMs = 30000): void {
      syncAll();
      timer = setInterval(syncAll, intervalMs);
    },
    stopAutoSync(): void {
      if (timer) { clearInterval(timer); timer = null; }
    },
  };
}

// Backward-compatible alias
export const createContextSync = createTieredContextManager;
