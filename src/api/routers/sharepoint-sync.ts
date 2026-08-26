/**
 * SharePoint document sync routes — the Connections management surface for
 * the scheduled SharePoint ingestion (src/monitors/sharepoint-sync.ts).
 *
 * Peer of /grasp-sync: local JSON routes over the sync's settings-backed
 * configuration, plus two picker proxies (site search, library listing) that
 * call the managed MCP with skipIfBusy so a long-running document download
 * surfaces as a 409 "busy" instead of a hung dashboard request.
 * Loopback-only like every management route (bound at the server level).
 */

import { Router, Request, Response } from 'express';
import type { RouterDeps } from './deps.js';

const PROFILE_ID = 'sharepoint';

export function createSharePointSyncRouter(deps: RouterDeps): Router {
  const router = Router();

  router.get('/sharepoint-sync/status', (_req: Request, res: Response) => {
    const sync = deps.sharePointSync;
    if (!sync) return res.status(503).json({ error: 'SharePoint sync is unavailable' });
    res.json({ status: sync.getStatus() });
  });

  router.put('/sharepoint-sync/config', (req: Request, res: Response) => {
    const sync = deps.sharePointSync;
    if (!sync) return res.status(503).json({ error: 'SharePoint sync is unavailable' });
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return res.status(400).json({ error: 'Body must be a JSON object' });
    }
    try {
      const status = sync.updateConfig({ enabled: body.enabled, sources: body.sources });
      res.json({ status });
    } catch (error: any) {
      res.status(400).json({ error: error?.message ?? String(error) });
    }
  });

  router.post('/sharepoint-sync/run', async (_req: Request, res: Response) => {
    const sync = deps.sharePointSync;
    if (!sync) return res.status(503).json({ error: 'SharePoint sync is unavailable' });
    try {
      // Discovery lists and enqueues only (downloads happen on the drain
      // tick), so waiting for the real result is fast and beats a 202.
      const result = await sync.runNow();
      res.json({ result, status: sync.getStatus() });
    } catch (error: any) {
      res.status(500).json({ error: error?.message ?? String(error) });
    }
  });

  router.post('/sharepoint-sync/drain', async (_req: Request, res: Response) => {
    const sync = deps.sharePointSync;
    if (!sync) return res.status(503).json({ error: 'SharePoint sync is unavailable' });
    try {
      const processed = await sync.drainNow();
      res.json({ processed, status: sync.getStatus() });
    } catch (error: any) {
      res.status(500).json({ error: error?.message ?? String(error) });
    }
  });

  router.post('/sharepoint-sync/confirm-surge', (req: Request, res: Response) => {
    const sync = deps.sharePointSync;
    if (!sync) return res.status(503).json({ error: 'SharePoint sync is unavailable' });
    const sourceId = String(req.body?.sourceId ?? '').trim();
    if (!sourceId) return res.status(400).json({ error: 'sourceId is required' });
    try {
      res.json({ status: sync.confirmSurge(sourceId) });
    } catch (error: any) {
      res.status(400).json({ error: error?.message ?? String(error) });
    }
  });

  router.post('/sharepoint-sync/purge', (_req: Request, res: Response) => {
    const sync = deps.sharePointSync;
    if (!sync) return res.status(503).json({ error: 'SharePoint sync is unavailable' });
    try {
      res.json({ result: sync.purge(), status: sync.getStatus() });
    } catch (error: any) {
      res.status(500).json({ error: error?.message ?? String(error) });
    }
  });

  /** Picker proxy: site search for the library adder. */
  router.get('/sharepoint/sites', async (req: Request, res: Response) => {
    const mcp = deps.mcpManager;
    if (!mcp) return res.status(503).json({ error: 'MCP runtime is unavailable' });
    const query = String(req.query.query ?? '').trim();
    try {
      const result = await mcp.callTool(PROFILE_ID, 'sharepoint_list_sites', {
        ...(query ? { query } : {}), top: 25,
      }, { source: 'dashboard', timeoutMs: 30_000, skipIfBusy: true });
      if (result.isError) return res.status(502).json({ error: result.text.slice(0, 300) });
      res.json({ sites: JSON.parse(result.text) });
    } catch (error: any) {
      const message = error?.message ?? String(error);
      if (/busy/i.test(message)) return res.status(409).json({ busy: true, error: 'SharePoint connection is busy syncing — try again in a moment' });
      res.status(502).json({ error: message.slice(0, 300) });
    }
  });

  /** Picker proxy: libraries for a chosen site. */
  router.get('/sharepoint/libraries', async (req: Request, res: Response) => {
    const mcp = deps.mcpManager;
    if (!mcp) return res.status(503).json({ error: 'MCP runtime is unavailable' });
    const siteUrl = String(req.query.siteUrl ?? '').trim();
    let host = '';
    try { host = new URL(siteUrl).hostname; } catch { /* rejected below */ }
    if (!siteUrl.startsWith('https://') || !host.endsWith('.sharepoint.com')) {
      return res.status(400).json({ error: 'siteUrl must be an https *.sharepoint.com URL' });
    }
    try {
      const result = await mcp.callTool(PROFILE_ID, 'sharepoint_list_libraries', {
        siteUrl, personal: false,
      }, { source: 'dashboard', timeoutMs: 30_000, skipIfBusy: true });
      if (result.isError) return res.status(502).json({ error: result.text.slice(0, 300) });
      res.json({ libraries: JSON.parse(result.text) });
    } catch (error: any) {
      const message = error?.message ?? String(error);
      if (/busy/i.test(message)) return res.status(409).json({ busy: true, error: 'SharePoint connection is busy syncing — try again in a moment' });
      res.status(502).json({ error: message.slice(0, 300) });
    }
  });

  return router;
}
