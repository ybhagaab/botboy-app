/**
 * Node routes — hierarchical node CRUD, node↔item links, item promotion, and
 * subtree/children queries. Mirrors of pipeline projects appear here as
 * `proj_*` nodes (see node-projection.ts).
 *
 * NOTE: /nodes/roots must stay registered before /nodes/:id.
 */

import { Router, Request, Response } from 'express';
import { paramStr, type RouterDeps } from './deps.js';

export function createNodesRouter(deps: RouterDeps): Router {
  const router = Router();
  const nm = deps.nodeManager;

  // ── Nodes (continued) ──

  router.get('/nodes', (_req: Request, res: Response) => {
    const nodes = nm.listNodes('active').map(n => ({
      ...n, itemCount: nm.getNodeItemCount(n.id),
    }));
    res.json(nodes);
  });

  router.get('/nodes/archived', (_req: Request, res: Response) => {
    const nodes = nm.listNodes('archived').map(n => ({
      ...n, itemCount: nm.getNodeItemCount(n.id),
    }));
    res.json(nodes);
  });

  // Phase 3: roots must be before :id to avoid matching "roots" as an id
  router.get('/nodes/roots', (_req: Request, res: Response) => {
    const roots = nm.getRootNodes();
    res.json(roots.map(n => ({
      ...n,
      itemCount: nm.getNodeItemCount(n.id),
      childCount: nm.getChildren(n.id).length,
    })));
  });

  router.get('/nodes/:id', (req: Request, res: Response) => {
    const node = nm.getNode(paramStr(req.params.id));
    if (!node) return res.status(404).json({ error: 'Node not found' });
    const items = nm.getNodeWorkItems(node.id);

    // Attach the project "brain" (rich catch-up briefing) when this node mirrors
    // a project. Area/root nodes have no brain — the UI falls back gracefully.
    let brain = null;
    const bs = deps.brainStore;
    if (bs && node.id.startsWith('proj_')) {
      try { brain = bs.read(node.id); } catch { brain = null; }
    }

    res.json({ ...node, items, itemCount: items.length, brain });
  });

  // Knowledge view: returns items with full content for a node
  router.get('/nodes/:id/knowledge', (req: Request, res: Response) => {
    const node = nm.getNode(paramStr(req.params.id));
    if (!node) return res.status(404).json({ error: 'Node not found' });
    const db = deps.db;
    if (!db) return res.status(503).json({ error: 'DB not available' });
    const items = db.prepare(`
      SELECT wi.id, wi.type, wi.source, wi.source_app, wi.title, wi.summary, wi.url,
             wi.parsed_text, wi.metadata, wi.captured_at
      FROM work_items wi
      JOIN node_work_items nwi ON wi.id = nwi.work_item_id
      WHERE nwi.node_id = ?
      ORDER BY wi.captured_at DESC
    `).all(paramStr(req.params.id)) as any[];

    const knowledge = items.map((i: any) => ({
      id: i.id,
      type: i.type,
      source: i.source,
      sourceApp: i.source_app,
      title: i.title,
      summary: i.summary,
      url: i.url,
      content: i.parsed_text || i.summary || null,
      metadata: i.metadata ? JSON.parse(i.metadata) : {},
      capturedAt: i.captured_at,
    }));

    // Build a node-level digest: collect all non-empty summaries
    const contentItems = knowledge.filter((k: any) => k.content);
    const digest = contentItems.slice(0, 20).map((k: any) => {
      const text = k.content.length > 300 ? k.content.slice(0, 300) + '...' : k.content;
      return { id: k.id, title: k.title, text, url: k.url, capturedAt: k.capturedAt };
    });

    res.json({
      node: { id: node.id, title: node.title, description: node.description },
      totalItems: items.length,
      itemsWithContent: contentItems.length,
      digest,
      items: knowledge,
    });
  });

  router.post('/nodes', (req: Request, res: Response) => {
    const { title, description, parentId } = req.body;
    if (!title) return res.status(400).json({ error: 'title is required' });
    try {
      const node = parentId
        ? nm.createChildNode(parentId, title, description)
        : nm.createNode(title, description);
      res.status(201).json(node);
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  router.patch('/nodes/:id', (req: Request, res: Response) => {
    try {
      const { parentId, ...updates } = req.body;
      if (parentId !== undefined) {
        nm.moveNode(paramStr(req.params.id), parentId);
      }
      const node = nm.updateNode(paramStr(req.params.id), updates);
      res.json(node);
    } catch (err: any) { res.status(400).json({ error: err.message }); }
  });

  router.post('/nodes/:id/archive', (req: Request, res: Response) => {
    nm.archiveNode(paramStr(req.params.id));
    res.json({ success: true });
  });

  router.post('/nodes/:id/reactivate', (req: Request, res: Response) => {
    nm.reactivateNode(paramStr(req.params.id));
    res.json({ success: true });
  });

  router.delete('/nodes/:id', (req: Request, res: Response) => {
    nm.deleteNode(paramStr(req.params.id));
    res.json({ success: true });
  });

  // ── Node Work Items ──

  router.post('/nodes/:id/items', (req: Request, res: Response) => {
    const { workItemId } = req.body;
    if (!workItemId) return res.status(400).json({ error: 'workItemId is required' });
    nm.addWorkItemToNode(workItemId, paramStr(req.params.id));
    res.json({ success: true });
  });

  router.delete('/nodes/:id/items/:itemId', (req: Request, res: Response) => {
    nm.removeWorkItemFromNode(paramStr(req.params.itemId), paramStr(req.params.id));
    res.json({ success: true });
  });
  // ── Promote item to sub-node ──
  router.post('/nodes/:id/promote-item', async (req: Request, res: Response) => {
    const db = deps.db;
    if (!db) return res.status(503).json({ error: 'DB not available' });
    const parentId = paramStr(req.params.id);
    const { workItemId } = req.body;
    if (!workItemId) return res.status(400).json({ error: 'workItemId required' });
    const item = db.prepare('SELECT * FROM work_items WHERE id = ?').get(workItemId) as any;
    if (!item) return res.status(404).json({ error: 'Item not found' });
    try {
      const title = (item.title || '').replace(/ - Google Chrome$/i, '').replace(/ - Amazon - Slack.*$/i, '').slice(0, 80) || 'Untitled';
      const node = nm.createChildNode(parentId, title, item.summary || item.parsed_text?.slice(0, 300) || '');
      nm.addWorkItemToNode(workItemId, node.id);
      const keywords = title.split(/[\s\-—:,./]+/).filter((w: string) => w.length > 3 && !/^(the|and|for|with|from|this|that|http|https|www|com)$/i.test(w)).slice(0, 5);
      const related: string[] = [];
      if (keywords.length > 0) {
        const conditions = keywords.map(() => '(wi.title LIKE ? OR wi.summary LIKE ? OR wi.parsed_text LIKE ?)').join(' OR ');
        const params: string[] = [];
        keywords.forEach((k: string) => { const p = `%${k}%`; params.push(p, p, p); });
        params.push(workItemId);
        const rows = db.prepare(`SELECT DISTINCT wi.id, wi.title, wi.summary FROM work_items wi WHERE (${conditions}) AND wi.id != ? LIMIT 100`).all(...params, ) as any[];
        rows.slice(0, 20).forEach((r: any) => { try { nm.addWorkItemToNode(r.id, node.id); related.push(r.id); } catch {} });
      }
      const assignedItems = nm.getNodeWorkItems(node.id);
      const contentPreviews = assignedItems.filter((i: any) => i.summary || i.parsedText).slice(0, 10).map((i: any) => (i.summary || i.parsedText || '').slice(0, 200));
      const enrichedDesc = contentPreviews.length > 1
        ? `${item.summary || title}. Contains ${assignedItems.length} related items covering: ${contentPreviews.slice(0, 3).join('; ').slice(0, 500)}.`
        : (item.summary || item.parsed_text?.slice(0, 500) || title);
      db.prepare('UPDATE nodes SET description = ? WHERE id = ?').run(enrichedDesc, node.id);
      res.json({ success: true, node: { ...node, description: enrichedDesc }, relatedCount: related.length, totalItems: assignedItems.length });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  // ── Phase 3: Hierarchy endpoints ──

  router.get('/nodes/:id/children', (req: Request, res: Response) => {
    try {
      const db = deps.db;
      const children = nm.getChildren(paramStr(req.params.id));
      const enriched = children.map(c => {
        const base = { ...c, itemCount: nm.getNodeItemCount(c.id) };
        if (!db) return { ...base, activity: null };
        const row = db.prepare(`
          SELECT
            COUNT(*) as total,
            SUM(CASE WHEN wi.captured_at > datetime('now','-1 day') THEN 1 ELSE 0 END) as h24,
            SUM(CASE WHEN wi.captured_at > datetime('now','-7 days') THEN 1 ELSE 0 END) as d7,
            COUNT(DISTINCT date(wi.captured_at)) as active_days,
            MAX(wi.captured_at) as last_at
          FROM node_work_items nwi JOIN work_items wi ON nwi.work_item_id=wi.id
          WHERE nwi.node_id=?
        `).get(c.id) as any;
        return { ...base, activity: row ? { total: row.total, items24h: row.h24, items7d: row.d7, activeDays7d: row.active_days, lastActivity: row.last_at } : null };
      });
      res.json(enriched);
    } catch (err: any) { res.status(404).json({ error: err.message }); }
  });

  router.get('/nodes/:id/tree', (req: Request, res: Response) => {
    try {
      const tree = nm.getSubtree(paramStr(req.params.id));
      res.json(tree);
    } catch (err: any) { res.status(404).json({ error: err.message }); }
  });

 return router;
}
