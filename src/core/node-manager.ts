import Database from 'better-sqlite3';
import { v4 as uuid } from 'uuid';
import type { Node, WorkItem, NodeConnection, ManualWorkItemInput, NodeTree, NodeWithChildren } from './types.js';

const MAX_DEPTH = 4;

export interface NodeManager {
  createNode(title: string, description?: string): Node;
  getNode(nodeId: string): Node | null;
  listNodes(status?: 'active' | 'archived'): Node[];
  updateNode(nodeId: string, updates: { title?: string; description?: string }): Node;
  archiveNode(nodeId: string): void;
  reactivateNode(nodeId: string): void;
  deleteNode(nodeId: string): void;
  addWorkItemToNode(workItemId: string, nodeId: string, assignedBy?: 'classifier' | 'manual'): void;
  removeWorkItemFromNode(workItemId: string, nodeId: string): void;
  getNodeWorkItems(nodeId: string): WorkItem[];
  getNodeItemCount(nodeId: string): number;
  getWorkItemNodes(workItemId: string): Node[];
  createManualWorkItem(data: ManualWorkItemInput): WorkItem;
  getNodeConnections(): NodeConnection[];
  getUnassignedWorkItems(): WorkItem[];
  // Phase 3 hierarchy methods
  createChildNode(parentId: string, title: string, description?: string): Node;
  getChildren(nodeId: string): Node[];
  getSubtree(nodeId: string): NodeTree;
  getRootNodes(): Node[];
  getNodeDepth(nodeId: string): number;
  getAncestors(nodeId: string): Node[];
  moveNode(nodeId: string, newParentId: string | null): void;
  moveItemToChild(workItemId: string, fromNodeId: string, toNodeId: string): void;
}

// Backward-compatible alias
export type HierarchicalNodeManager = NodeManager;

export function createNodeManager(db: Database.Database): NodeManager {
  // Prepared statements
  const insertNode = db.prepare(
    `INSERT INTO nodes (id, title, description, status, parent_id, depth) VALUES (?, ?, ?, 'active', NULL, 0)`
  );
  const insertNodeWithParent = db.prepare(
    `INSERT INTO nodes (id, title, description, status, parent_id, depth) VALUES (?, ?, ?, 'active', ?, ?)`
  );
  const selectNode = db.prepare(`SELECT * FROM nodes WHERE id = ?`);
  const selectNodesByStatus = db.prepare(`SELECT * FROM nodes WHERE status = ? ORDER BY updated_at DESC`);
  const selectAllNodes = db.prepare(`SELECT * FROM nodes ORDER BY updated_at DESC`);
  const updateNodeStmt = db.prepare(`UPDATE nodes SET title = ?, description = ?, updated_at = datetime('now') WHERE id = ?`);
  const updateStatus = db.prepare(`UPDATE nodes SET status = ?, updated_at = datetime('now') WHERE id = ?`);
  const deleteNodeStmt = db.prepare(`DELETE FROM nodes WHERE id = ?`);

  // Hierarchy queries
  const selectChildren = db.prepare(`SELECT * FROM nodes WHERE parent_id = ? AND status = 'active' ORDER BY created_at ASC`);
  const selectAllChildren = db.prepare(`SELECT * FROM nodes WHERE parent_id = ? ORDER BY created_at ASC`);
  const selectRootNodes = db.prepare(`SELECT * FROM nodes WHERE parent_id IS NULL AND status = 'active' ORDER BY updated_at DESC`);
  const updateParentAndDepth = db.prepare(`UPDATE nodes SET parent_id = ?, depth = ?, updated_at = datetime('now') WHERE id = ?`);

  const insertAssoc = db.prepare(
    `INSERT OR IGNORE INTO node_work_items (node_id, work_item_id, assigned_by) VALUES (?, ?, ?)`
  );
  const deleteAssoc = db.prepare(
    `DELETE FROM node_work_items WHERE node_id = ? AND work_item_id = ?`
  );
  const selectNodeItems = db.prepare(
    `SELECT wi.* FROM work_items wi
     JOIN node_work_items nwi ON wi.id = nwi.work_item_id
     WHERE nwi.node_id = ?
     ORDER BY wi.captured_at ASC`
  );
  const countNodeItems = db.prepare(
    `SELECT COUNT(*) as count FROM node_work_items WHERE node_id = ?`
  );
  const selectItemNodes = db.prepare(
    `SELECT n.* FROM nodes n
     JOIN node_work_items nwi ON n.id = nwi.node_id
     WHERE nwi.work_item_id = ?`
  );
  const insertWorkItem = db.prepare(
    `INSERT INTO work_items (id, type, source, title, summary, url, file_path, metadata, captured_at)
     VALUES (?, 'generic_browser', 'manual', ?, ?, ?, ?, '{}', datetime('now'))`
  );
  const selectUnassigned = db.prepare(
    `SELECT wi.* FROM work_items wi
     WHERE wi.id NOT IN (SELECT work_item_id FROM node_work_items)
     ORDER BY wi.captured_at DESC`
  );

  function toNode(row: any): Node {
    return {
      id: row.id,
      title: row.title,
      description: row.description ?? undefined,
      parentId: row.parent_id ?? null,
      depth: row.depth ?? 0,
      status: row.status,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
    };
  }

  function toWorkItem(row: any): WorkItem {
    return {
      id: row.id,
      type: row.type,
      source: row.source,
      sourceApp: row.source_app ?? undefined,
      title: row.title ?? undefined,
      summary: row.summary ?? undefined,
      url: row.url ?? undefined,
      filePath: row.file_path ?? undefined,
      contentHash: row.content_hash ?? undefined,
      screenshotPath: row.screenshot_path ?? undefined,
      visualContext: row.visual_context ?? undefined,
      metadata: row.metadata ? (() => { try { return JSON.parse(row.metadata); } catch { return {}; } })() : {},
      parsedText: row.parsed_text ?? undefined,
      capturedAt: new Date(row.captured_at),
      createdAt: new Date(row.created_at),
    };
  }

  function cascadeArchive(nodeId: string): void {
    const children = (selectAllChildren.all(nodeId) as any[]);
    for (const child of children) {
      updateStatus.run('archived', child.id);
      cascadeArchive(child.id);
    }
  }

  function recalculateDescendantDepths(parentId: string, parentDepth: number): void {
    const children = (selectAllChildren.all(parentId) as any[]);
    for (const child of children) {
      const childDepth = parentDepth + 1;
      updateParentAndDepth.run(child.parent_id, childDepth, child.id);
      recalculateDescendantDepths(child.id, childDepth);
    }
  }

  return {
    createNode(title: string, description?: string): Node {
      const id = uuid();
      insertNode.run(id, title, description ?? null);
      return toNode(selectNode.get(id));
    },

    getNode(nodeId: string): Node | null {
      const row = selectNode.get(nodeId);
      return row ? toNode(row) : null;
    },

    listNodes(status?: 'active' | 'archived'): Node[] {
      const rows = status ? selectNodesByStatus.all(status) : selectAllNodes.all();
      return (rows as any[]).map(toNode);
    },

    updateNode(nodeId: string, updates: { title?: string; description?: string }): Node {
      const existing = selectNode.get(nodeId) as any;
      if (!existing) throw new Error(`Node ${nodeId} not found`);
      updateNodeStmt.run(
        updates.title ?? existing.title,
        updates.description ?? existing.description,
        nodeId
      );
      return toNode(selectNode.get(nodeId));
    },

    archiveNode(nodeId: string): void {
      updateStatus.run('archived', nodeId);
      cascadeArchive(nodeId);
    },

    reactivateNode(nodeId: string): void {
      updateStatus.run('active', nodeId);
    },

    deleteNode(nodeId: string): void {
      const node = selectNode.get(nodeId) as any;
      if (!node) return;
      // Re-parent children to deleted node's parent (or make them root)
      const children = (selectAllChildren.all(nodeId) as any[]);
      const newParentId = node.parent_id ?? null;
      const newDepth = node.parent_id ? ((selectNode.get(node.parent_id) as any)?.depth ?? 0) + 1 : 0;
      for (const child of children) {
        updateParentAndDepth.run(newParentId, newParentId ? newDepth : 0, child.id);
        recalculateDescendantDepths(child.id, newParentId ? newDepth : 0);
      }
      deleteNodeStmt.run(nodeId);
    },

    addWorkItemToNode(workItemId: string, nodeId: string, assignedBy: 'classifier' | 'manual' = 'manual'): void {
      insertAssoc.run(nodeId, workItemId, assignedBy);
    },

    removeWorkItemFromNode(workItemId: string, nodeId: string): void {
      deleteAssoc.run(nodeId, workItemId);
    },

    getNodeWorkItems(nodeId: string): WorkItem[] {
      return (selectNodeItems.all(nodeId) as any[]).map(toWorkItem);
    },

    getNodeItemCount(nodeId: string): number {
      return (countNodeItems.get(nodeId) as any).count;
    },

    getWorkItemNodes(workItemId: string): Node[] {
      return (selectItemNodes.all(workItemId) as any[]).map(toNode);
    },

    createManualWorkItem(data: ManualWorkItemInput): WorkItem {
      const id = uuid();
      insertWorkItem.run(id, data.title, data.description ?? null, data.url ?? null, data.filePath ?? null);
      const row = db.prepare('SELECT * FROM work_items WHERE id = ?').get(id);
      return toWorkItem(row);
    },

    getNodeConnections(): NodeConnection[] {
      const rows = db.prepare(`
        SELECT a.node_id as nodeA, b.node_id as nodeB, a.work_item_id
        FROM node_work_items a
        JOIN node_work_items b ON a.work_item_id = b.work_item_id AND a.node_id < b.node_id
        ORDER BY a.node_id, b.node_id
      `).all() as any[];

      const map = new Map<string, string[]>();
      for (const r of rows) {
        const key = `${r.nodeA}:${r.nodeB}`;
        if (!map.has(key)) map.set(key, []);
        map.get(key)!.push(r.work_item_id);
      }

      return Array.from(map.entries()).map(([key, items]) => {
        const [nodeIdA, nodeIdB] = key.split(':');
        return { nodeIdA, nodeIdB, sharedWorkItemIds: items };
      });
    },

    getUnassignedWorkItems(): WorkItem[] {
      return (selectUnassigned.all() as any[]).map(toWorkItem);
    },

    // ── Phase 3: Hierarchy methods ──

    createChildNode(parentId: string, title: string, description?: string): Node {
      const parent = selectNode.get(parentId) as any;
      if (!parent) throw new Error(`Parent node ${parentId} not found`);
      if (parent.status === 'archived') throw new Error('Cannot create child of archived node');
      const parentDepth = parent.depth ?? 0;
      if (parentDepth >= MAX_DEPTH) throw new Error(`Max depth ${MAX_DEPTH} exceeded`);

      const id = uuid();
      const childDepth = parentDepth + 1;
      insertNodeWithParent.run(id, title, description ?? null, parentId, childDepth);
      return toNode(selectNode.get(id));
    },

    getChildren(nodeId: string): Node[] {
      return (selectChildren.all(nodeId) as any[]).map(toNode);
    },

    getSubtree(nodeId: string): NodeTree {
      const node = this.getNode(nodeId);
      if (!node) throw new Error(`Node ${nodeId} not found`);
      const children = this.getChildren(nodeId);
      const items = this.getNodeWorkItems(nodeId);
      const childTrees = children.map(c => this.getSubtree(c.id));
      const totalItemCount = items.length + childTrees.reduce((sum, ct) => sum + ct.totalItemCount, 0);
      return { node, children: childTrees, items, totalItemCount };
    },

    getRootNodes(): Node[] {
      return (selectRootNodes.all() as any[]).map(toNode);
    },

    getNodeDepth(nodeId: string): number {
      const row = selectNode.get(nodeId) as any;
      if (!row) throw new Error(`Node ${nodeId} not found`);
      return row.depth ?? 0;
    },

    getAncestors(nodeId: string): Node[] {
      const ancestors: Node[] = [];
      let current = selectNode.get(nodeId) as any;
      while (current?.parent_id) {
        const parent = selectNode.get(current.parent_id) as any;
        if (!parent) break;
        ancestors.push(toNode(parent));
        current = parent;
      }
      return ancestors;
    },

    moveNode(nodeId: string, newParentId: string | null): void {
      const node = selectNode.get(nodeId) as any;
      if (!node) throw new Error(`Node ${nodeId} not found`);

      let newDepth = 0;
      if (newParentId !== null) {
        // Cycle detection: walk up from newParentId
        let current: string | null = newParentId;
        while (current !== null) {
          if (current === nodeId) throw new Error('Cannot reparent: would create cycle');
          const p = selectNode.get(current) as any;
          current = p?.parent_id ?? null;
        }
        const newParent = selectNode.get(newParentId) as any;
        if (!newParent) throw new Error(`Target parent ${newParentId} not found`);
        newDepth = (newParent.depth ?? 0) + 1;
        if (newDepth > MAX_DEPTH) throw new Error(`Max depth ${MAX_DEPTH} exceeded`);
      }

      updateParentAndDepth.run(newParentId, newDepth, nodeId);
      recalculateDescendantDepths(nodeId, newDepth);
    },

    moveItemToChild(workItemId: string, fromNodeId: string, toNodeId: string): void {
      db.transaction(() => {
        deleteAssoc.run(fromNodeId, workItemId);
        insertAssoc.run(toNodeId, workItemId, 'classifier');
      })();
    },
  };
}
