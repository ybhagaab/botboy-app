import { Router, Request, Response } from 'express';
import { hasLiveMidwayCliSession } from '../../core/publish-harmony.js';
import { paramStr, type RouterDeps } from './deps.js';

export function createAnalyticsRouter(deps: RouterDeps): Router {
  const router = Router();

  router.get('/analytics/publisher', (_req: Request, res: Response) => {
    if (!deps.dashboardPublisher) return res.status(503).json({ error: 'Dashboard publishing is unavailable' });
    try {
      res.json({ publisher: deps.dashboardPublisher.getConfig() });
    } catch (error: any) {
      res.status(500).json({ error: error?.message ?? String(error) });
    }
  });

  router.put('/analytics/publisher', (req: Request, res: Response) => {
    if (!deps.dashboardPublisher) return res.status(503).json({ error: 'Dashboard publishing is unavailable' });
    try {
      res.json({ publisher: deps.dashboardPublisher.updateConfig(req.body) });
    } catch (error: any) {
      res.status(400).json({ error: error?.message ?? String(error) });
    }
  });

  // Harmony setup stepper: which step is the owner on? (CLI missing is the expected first state.)
  router.get('/analytics/publisher/harmony/probe', async (_req: Request, res: Response) => {
    if (!deps.dashboardPublisher) return res.status(503).json({ error: 'Dashboard publishing is unavailable' });
    try {
      res.json({ probe: await deps.dashboardPublisher.probeHarmonySetup() });
    } catch (error: any) {
      res.status(500).json({ error: error?.message ?? String(error) });
    }
  });

  // One-click CLI install (`toolbox install harmonycli`). Long-running; the UI shows progress.
  router.post('/analytics/publisher/harmony/install-cli', async (_req: Request, res: Response) => {
    if (!deps.dashboardPublisher) return res.status(503).json({ error: 'Dashboard publishing is unavailable' });
    try {
      const result = await deps.dashboardPublisher.installHarmonyCli();
      res.status(result.ok ? 200 : 502).json(result);
    } catch (error: any) {
      res.status(500).json({ error: error?.message ?? String(error) });
    }
  });

  // One-click `mwinit -o` in the chat terminal dock (CLI Midway ≠ browser
  // Midway — live-fire 2026-09-09). Safety model mirrors the pandoc/MCP
  // terminals: command FIXED server-side, loopback-only, user types PIN +
  // touches the security key in the PTY — never through the model or API.
  router.post('/analytics/publisher/harmony/mwinit', (req: Request, res: Response) => {
    const chatTerminal = deps.chatTerminal;
    if (!chatTerminal) return res.status(503).json({ error: 'Terminal sessions are unavailable.' });
    const isLoopback = (address: string | undefined) =>
      address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
    if (!isLoopback(req.socket.remoteAddress) || !isLoopback(req.socket.localAddress)) {
      return res.status(403).json({ error: 'Terminal control is local-only.' });
    }
    if (hasLiveMidwayCliSession()) return res.json({ alreadyLive: true });
    const running = chatTerminal.current();
    if (running && running.status === 'running') {
      return res.status(409).json({ error: 'Another terminal session is already running in BotBoy — finish it first.', code: 'terminal_busy' });
    }
    try {
      const session = chatTerminal.open({
        command: 'mwinit -o',
        title: 'Midway sign-in (Harmony publishing)',
        timeoutMs: 5 * 60_000,
      });
      return res.status(201).json({ session: { id: session.id, status: session.status, title: session.title } });
    } catch (error) {
      return res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  // What automated provisioning WOULD create — content of the confirm card.
  router.get('/analytics/publisher/harmony/provision-plan', (_req: Request, res: Response) => {
    if (!deps.dashboardPublisher) return res.status(503).json({ error: 'Dashboard publishing is unavailable' });
    try {
      res.json({ plan: deps.dashboardPublisher.planHarmonyProvisioning() });
    } catch (error: any) {
      res.status(500).json({ error: error?.message ?? String(error) });
    }
  });

  // Create team + bindle (idempotent; writes to shared Amazon systems) — explicit confirm required.
  router.post('/analytics/publisher/harmony/provision', async (req: Request, res: Response) => {
    if (!deps.dashboardPublisher) return res.status(503).json({ error: 'Dashboard publishing is unavailable' });
    if (req.body?.confirmed !== true) {
      return res.status(400).json({ error: 'confirmed must be true after the user reviews exactly what will be created' });
    }
    try {
      res.status(201).json(await deps.dashboardPublisher.provisionHarmonyIdentity());
    } catch (error: any) {
      res.status(502).json({ error: error?.message ?? String(error) });
    }
  });

  router.get('/analytics/dashboards', (_req: Request, res: Response) => {
    if (!deps.analyticsService) return res.status(503).json({ error: 'Analytics dashboards are unavailable' });
    res.json({ dashboards: deps.analyticsService.listDashboards() });
  });

  router.get('/analytics/runs/:runId', (req: Request, res: Response) => {
    if (!deps.analyticsService) return res.status(503).json({ error: 'Analytics dashboards are unavailable' });
    const run = deps.analyticsService.getRun(paramStr(req.params.runId));
    if (!run) return res.status(404).json({ error: 'Analytics run not found' });
    res.json({ run });
  });

  router.post('/analytics/dashboards', (req: Request, res: Response) => {
    if (!deps.analyticsService) return res.status(503).json({ error: 'Analytics dashboards are unavailable' });
    try {
      const wantsRefresh = req.body?.refresh === true;
      const dashboard = deps.analyticsService.createDashboard(
        req.body,
        wantsRefresh ? 'manual' : undefined,
      );
      if (wantsRefresh) {
        const refresh = dashboard.recentRuns.find(run => run.status === 'queued' || run.status === 'running');
        return res.status(201).json({ dashboard, refresh });
      }
      res.status(201).json({ dashboard });
    } catch (error: any) {
      res.status(400).json({ error: error?.message ?? String(error) });
    }
  });

  router.get('/analytics/dashboards/:id', (req: Request, res: Response) => {
    if (!deps.analyticsService) return res.status(503).json({ error: 'Analytics dashboards are unavailable' });
    const dashboard = deps.analyticsService.getDashboard(paramStr(req.params.id));
    if (!dashboard) return res.status(404).json({ error: 'Dashboard not found' });
    res.json({ dashboard });
  });

  router.patch('/analytics/dashboards/:id', (req: Request, res: Response) => {
    if (!deps.analyticsService) return res.status(503).json({ error: 'Analytics dashboards are unavailable' });
    try {
      const dashboard = deps.analyticsService.updateDashboard(paramStr(req.params.id), req.body);
      res.json({ dashboard });
    } catch (error: any) {
      const message = error?.message ?? String(error);
      const status = /not found/i.test(message) ? 404 : /cannot change while refresh/i.test(message) ? 409 : 400;
      res.status(status).json({ error: message });
    }
  });

  router.delete('/analytics/dashboards/:id', (req: Request, res: Response) => {
    if (!deps.analyticsService) return res.status(503).json({ error: 'Analytics dashboards are unavailable' });
    try {
      deps.analyticsService.deleteDashboard(paramStr(req.params.id));
      res.status(204).end();
    } catch (error: any) {
      const message = error?.message ?? String(error);
      const status = /not found/i.test(message) ? 404 : /cannot be deleted while/i.test(message) ? 409 : 400;
      res.status(status).json({ error: message });
    }
  });

  router.post('/analytics/dashboards/:id/share-request', (req: Request, res: Response) => {
    if (!deps.dashboardPublisher) return res.status(503).json({ error: 'Dashboard publishing is unavailable' });
    try {
      const shareRequest = deps.dashboardPublisher.createShareRequest(paramStr(req.params.id));
      res.status(201).json({ shareRequest });
    } catch (error: any) {
      const status = /not found/i.test(error?.message ?? '') ? 404 : 400;
      res.status(status).json({ error: error?.message ?? String(error) });
    }
  });

  router.post('/analytics/dashboards/:id/publish', async (req: Request, res: Response) => {
    if (!deps.dashboardPublisher) return res.status(503).json({ error: 'Dashboard publishing is unavailable' });
    if (req.body?.confirmed !== true) {
      return res.status(400).json({ error: 'confirmed must be true after the user reviews the exact upload destination and impact' });
    }
    try {
      const result = await deps.dashboardPublisher.publish(
        paramStr(req.params.id),
        String(req.body?.confirmationToken ?? ''),
      );
      res.status(201).json(result);
    } catch (error: any) {
      const message = error?.message ?? String(error);
      const status = /not found/i.test(message) ? 404 : /upload failed/i.test(message) ? 502 : 400;
      res.status(status).json({ error: message });
    }
  });

  router.put('/analytics/dashboards/:id/schedule', (req: Request, res: Response) => {
    if (!deps.analyticsService) return res.status(503).json({ error: 'Analytics dashboards are unavailable' });
    try {
      const id = paramStr(req.params.id);
      const schedule = deps.analyticsService.setSchedule(id, req.body);
      res.json({ schedule, dashboard: deps.analyticsService.getDashboard(id) });
    } catch (error: any) {
      const status = /not found/i.test(error?.message ?? '') ? 404 : 400;
      res.status(status).json({ error: error?.message ?? String(error) });
    }
  });

  router.post('/analytics/dashboards/:id/refresh', (req: Request, res: Response) => {
    if (!deps.analyticsService) return res.status(503).json({ error: 'Analytics dashboards are unavailable' });
    try {
      const id = paramStr(req.params.id);
      const run = deps.analyticsService.enqueueRefresh(id, 'manual');
      res.status(202).json({
        run,
        dashboard: deps.analyticsService.getDashboard(id),
      });
    } catch (error: any) {
      const message = error?.message ?? String(error);
      const status = /not found/i.test(message) ? 404 : /archived/i.test(message) ? 409 : 400;
      res.status(status).json({ error: message });
    }
  });

  // Stop an active refresh. Queued runs cancel immediately ('cancelled');
  // running runs are flagged and stop after the in-flight widget query
  // ('stopping') — a warehouse query cannot be aborted mid-call.
  router.post('/analytics/dashboards/:id/refresh/cancel', (req: Request, res: Response) => {
    if (!deps.analyticsService) return res.status(503).json({ error: 'Analytics dashboards are unavailable' });
    try {
      const id = paramStr(req.params.id);
      if (!deps.analyticsService.getDashboard(id)) return res.status(404).json({ error: `Dashboard ${id} not found` });
      const outcome = deps.analyticsService.cancelActiveRun(id);
      res.json({
        ...outcome,
        dashboard: deps.analyticsService.getDashboard(id),
      });
    } catch (error: any) {
      res.status(400).json({ error: error?.message ?? String(error) });
    }
  });

  return router;
}
