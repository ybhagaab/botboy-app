/**
 * Work-item routes — search, unassigned inbox, manual item creation, CDP
 * content enrichment, node connections, and screenshots.
 */

import { Router, Request, Response } from 'express';
import { paramStr, type RouterDeps } from './deps.js';

export function createItemsRouter(deps: RouterDeps): Router {
  const router = Router();
  const nm = deps.nodeManager;
  const ss = deps.screenshotStore;

  // ── Search ──

  router.get('/search', (req: Request, res: Response) => {
    const db = deps.db;
    if (!db) return res.status(503).json({ error: 'DB not available' });
    const q = String(req.query.q || '').trim();
    if (!q) return res.json({ query: '', totalResults: 0, results: [] });
    const limit = Math.min(parseInt(String(req.query.limit)) || 50, 200);
    const pattern = `%${q}%`;

    const rows = db.prepare(`
      SELECT wi.id, wi.type, wi.source, wi.source_app, wi.title, wi.summary,
             wi.url, wi.parsed_text, wi.captured_at,
             n.id as node_id, n.title as node_title
      FROM work_items wi
      LEFT JOIN node_work_items nwi ON wi.id = nwi.work_item_id
      LEFT JOIN nodes n ON nwi.node_id = n.id
      WHERE wi.title LIKE ? OR wi.summary LIKE ? OR wi.parsed_text LIKE ?
      ORDER BY wi.captured_at DESC
      LIMIT ?
    `).all(pattern, pattern, pattern, limit) as any[];

    const results = rows.map((r: any) => {
      // Determine which field matched and extract snippet
      const lq = q.toLowerCase();
      let matchField = 'title';
      let source = r.title || '';
      if (r.summary && r.summary.toLowerCase().includes(lq)) { matchField = 'summary'; source = r.summary; }
      else if (r.parsed_text && r.parsed_text.toLowerCase().includes(lq)) { matchField = 'parsed_text'; source = r.parsed_text; }

      const idx = source.toLowerCase().indexOf(lq);
      const start = Math.max(0, idx - 60);
      const end = Math.min(source.length, idx + q.length + 60);
      const snippet = (start > 0 ? '...' : '') + source.slice(start, end) + (end < source.length ? '...' : '');

      return {
        item: { id: r.id, type: r.type, source: r.source, sourceApp: r.source_app, title: r.title, summary: r.summary, url: r.url, capturedAt: r.captured_at },
        node: r.node_id ? { id: r.node_id, title: r.node_title } : null,
        matchField,
        snippet,
      };
    });

    res.json({ query: q, totalResults: results.length, results });
  });
  // ── Work Items ──

  // Bounded, counted inbox read model for the dashboard. The legacy
  // /items/unassigned route below remains unchanged for existing clients.
  router.get('/items/unassigned/summary', (req: Request, res: Response) => {
    const db = deps.db;
    if (!db) return res.status(503).json({ error: 'DB not available' });
    const limit = Math.max(1, Math.min(parseInt(String(req.query.limit)) || 40, 100));
    const offset = Math.max(0, parseInt(String(req.query.offset)) || 0);
    const count = (db.prepare(`
      SELECT COUNT(*) AS c
      FROM work_items
      WHERE project_id IS NULL AND process_state <> 'noise'
    `).get() as { c: number }).c;
    const items = db.prepare(`
      SELECT id, type, source, source_app AS sourceApp, title, summary, url,
             COALESCE(
               file_path,
               original_path,
               CASE WHEN url LIKE 'file://%' THEN substr(url, 8) END
             ) AS filePath,
             captured_at AS capturedAt
      FROM work_items
      WHERE project_id IS NULL AND process_state <> 'noise'
      ORDER BY captured_at DESC
      LIMIT ? OFFSET ?
    `).all(limit, offset);
    res.json({ count, limit, offset, items });
  });

  router.get('/items/unassigned', (_req: Request, res: Response) => {
    res.json(nm.getUnassignedWorkItems());
  });

  router.post('/items', (req: Request, res: Response) => {
    const { title, description, url, filePath } = req.body;
    if (!title) return res.status(400).json({ error: 'title is required' });
    const item = nm.createManualWorkItem({ title, description, url, filePath });
    res.status(201).json(item);
  });

  // ── Content enrichment: fetch page content via debug Chrome CDP ──

  router.post('/items/:id/enrich', async (req: Request, res: Response) => {
    const db = deps.db;
    if (!db) return res.status(503).json({ error: 'DB not available' });
    const item = db.prepare('SELECT * FROM work_items WHERE id = ?').get(paramStr(req.params.id)) as any;
    if (!item) return res.status(404).json({ error: 'Item not found' });
    if (!item.url) return res.status(400).json({ error: 'Item has no URL' });

    try {
      // Open URL in debug Chrome and extract content via CDP
      const http = await import('http');
      const cdpGet = (path: string, method = 'GET'): Promise<any> => new Promise((resolve, reject) => {
        const req = http.request(`http://127.0.0.1:9222${path}`, { method }, (resp) => {
          let data = '';
          resp.on('data', (c: Buffer) => data += c);
          resp.on('end', () => { try { resolve(JSON.parse(data)); } catch { reject(new Error(data.slice(0, 200))); } });
        });
        req.on('error', reject);
        req.end();
      });

      const encoded = encodeURIComponent(item.url);
      const newTab = await cdpGet(`/json/new?${encoded}`, 'PUT');
      await new Promise(r => setTimeout(r, 8000)); // Wait 8s for SPA pages to render

      // Get page content via CDP WebSocket
      const WebSocket = (await import('ws')).default;
      const ws = new WebSocket(newTab.webSocketDebuggerUrl);

      const extractContent = (): Promise<string> => new Promise((resolve, reject) => {
        const timeout = setTimeout(() => { ws.close(); reject(new Error('CDP timeout')); }, 15000);
        ws.on('open', () => {
          ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: 'document.body.innerText.substring(0, 10000)' } }));
        });
        ws.on('message', (data: any) => {
          const msg = JSON.parse(data.toString());
          if (msg.id === 1) { clearTimeout(timeout); resolve(msg.result?.result?.value || ''); }
        });
        ws.on('error', (e: any) => { clearTimeout(timeout); reject(e); });
      });

      let content = await extractContent();

      // If content is too short, page might still be loading — wait and retry
      if (content.length < 200 || content.includes('Loading')) {
        ws.close();
        await new Promise(r => setTimeout(r, 6000));
        const ws2 = new WebSocket(newTab.webSocketDebuggerUrl);
        content = await new Promise<string>((resolve, reject) => {
          const timeout = setTimeout(() => { ws2.close(); reject(new Error('CDP retry timeout')); }, 15000);
          ws2.on('open', () => {
            ws2.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: 'document.body.innerText.substring(0, 10000)' } }));
          });
          ws2.on('message', (data: any) => {
            const msg = JSON.parse(data.toString());
            if (msg.id === 1) { clearTimeout(timeout); ws2.close(); resolve(msg.result?.result?.value || ''); }
          });
          ws2.on('error', (e: any) => { clearTimeout(timeout); reject(e); });
        });
      } else {
        ws.close();
      }

      // Close the tab
      await cdpGet(`/json/close/${newTab.id}`).catch(() => {});

      // Update the item
      if (content && content.length > 50) {
        db.prepare('UPDATE work_items SET parsed_text = ? WHERE id = ?').run(content.slice(0, 15000), item.id);
        // Generate a basic summary from first few lines
        const lines = content.split('\n').filter((l: string) => l.trim().length > 10).slice(0, 5);
        const summary = lines.join(' ').slice(0, 300);
        if (summary) db.prepare('UPDATE work_items SET summary = ? WHERE id = ?').run(summary, item.id);
      }

      res.json({ success: true, contentLength: content.length, preview: content.slice(0, 200) });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Connections ──

  router.get('/connections', (_req: Request, res: Response) => {
    res.json(nm.getNodeConnections());
  });

  // ── Screenshots ──

  router.get('/items/:id/screenshot', (req: Request, res: Response) => {
    if (!ss) return res.status(404).json({ error: 'Screenshot store not configured' });
    const data = ss.get(paramStr(req.params.id));
    if (!data) return res.status(404).json({ error: 'Screenshot not found' });
    res.type('png').send(data);
  });

 return router;
}
