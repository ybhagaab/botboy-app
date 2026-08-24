/**
 * Agent routes — inbox processing triggers/status and the manual
 * background-processor runs (legacy plane; 503 unless PPT_LEGACY=1).
 */

import { Router, Request, Response } from 'express';
import { paramStr, type RouterDeps } from './deps.js';

export function createAgentRouter(deps: RouterDeps): Router {
  const router = Router();
  const { agent, backgroundProcessor: bgProc } = deps;

  // ── Agent Processing ──

  router.post('/agent/process', async (_req: Request, res: Response) => {
    if (!agent) return res.status(503).json({ error: 'Agent not available' });
    // Return immediately, process in background
    const runId = Date.now().toString(36);
    res.json({ runId, status: 'started' });
    agent.processInboxItems().catch(err => console.error('Processing failed:', err));
  });

  router.get('/agent/status', (_req: Request, res: Response) => {
    if (!agent) return res.json({ active: false, progress: { done: 0, total: 0 } });
    res.json(agent.getProcessingStatus());
  });

  router.post('/agent/process/:id', async (req: Request, res: Response) => {
    if (!agent) return res.status(503).json({ error: 'Agent not available' });
    try {
      const result = await agent.processItem(paramStr(req.params.id));
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });
  // ── Phase 3: Background processing endpoints ──

  router.get('/agent/background/status', (_req: Request, res: Response) => {
    if (!bgProc) return res.json({ running: false, lastResult: null });
    res.json({
      running: bgProc.isRunning(),
      lastResult: bgProc.getLastRunResult(),
    });
  });

  router.post('/agent/background/run', async (_req: Request, res: Response) => {
    if (!bgProc) return res.status(503).json({ error: 'Background processor not available' });
    try {
      const result = await bgProc.forceRun();
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

 return router;
}
