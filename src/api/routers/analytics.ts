import { requireLocalOwnerUiRequest } from './local-owner.js';
import { dashboardIssues, viewIssueReports } from '../../core/analytics-dashboard-issues.js';
import { Router, Request, Response } from 'express';
import { hasLiveMidwayCliSession } from '../../core/publish-harmony.js';
import { DashboardPublicationError } from '../../core/analytics-publisher.js';
import { AnalyticsDashboardDataRoomError } from '../../core/analytics-dashboard-data-room.js';
import { paramStr, type RouterDeps } from './deps.js';
import { requireLocalOwnerMutation } from './local-owner.js';
import type { DashboardState } from './dashboard.js';

function analyticsMutationStatus(error: unknown): number {
  if (error instanceof AnalyticsDashboardDataRoomError) {
    if (error.code === 'not_found') return 404;
    if (error.code === 'conflict') return 409;
    return 400;
  }
  const message = error instanceof Error ? error.message : String(error);
  if (/not found/i.test(message)) return 404;
  if (/revision changed|conflicts with active|cannot change while|changed during/i.test(message)) return 409;
  return 400;
}

function analyticsControlMutationStatus(error: unknown): number {
  if (error instanceof AnalyticsDashboardDataRoomError) {
    if (error.code === 'not_found') return 404;
    if (error.code === 'conflict' || error.code === 'waiting_for_data') return 409;
    return 422;
  }
  const message = error instanceof Error ? error.message : String(error);
  if (/not found|no data-room binding/i.test(message)) return 404;
  if (/changed|conflict|cannot change while|active refresh/i.test(message)) return 409;
  return 422;
}

function dashboardPublicationStatus(error: unknown): number {
  if (!(error instanceof DashboardPublicationError)) return 400;
  if (error.code === 'not_found') return 404;
  if (error.code === 'policy_denied') return 403;
  if (error.code === 'publication_not_ready' || error.code === 'publication_snapshot_drift') return 409;
  if (error.code === 'publication_provider_failed') return 502;
  return 400;
}

function dashboardPublicationErrorBody(error: unknown): Record<string, unknown> {
  if (error instanceof DashboardPublicationError) {
    return {
      code: error.code,
      error: error.message,
      nextAction: error.nextAction,
      drift: error.drift,
    };
  }
  return { error: error instanceof Error ? error.message : String(error) };
}

export function createAnalyticsRouter(deps: RouterDeps, dashboardState?: DashboardState): Router {
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
    res.json({ dashboard, issues: dashboardIssues(dashboard, viewIssueReports.get(dashboard.id)) });
  });

  // An html view's own checks (window.botboy.warn + BotBoy's page scan), as the
  // owner's dashboard page last rendered them. Kept in memory only.
  router.put('/analytics/dashboards/:id/widgets/:widgetId/view-issues', (req: Request, res: Response) => {
    if (!deps.analyticsService) return res.status(503).json({ error: 'Analytics dashboards are unavailable' });
    if (!requireLocalOwnerUiRequest(req, res, 'Reporting dashboard view issues', 'Open the dashboard in BotBoy.')) return;
    const dashboard = deps.analyticsService.getDashboard(paramStr(req.params.id));
    const widgetId = paramStr(req.params.widgetId);
    if (!dashboard || !dashboard.widgets.some(widget => widget.id === widgetId && widget.kind === 'html')) {
      return res.status(404).json({ error: 'No such html view on this dashboard' });
    }
    viewIssueReports.set(dashboard.id, widgetId, req.body?.issues);
    return res.json({ issues: dashboardIssues(dashboard, viewIssueReports.get(dashboard.id)) });
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

  router.put('/analytics/dashboards/:id/widgets/:widgetId', (req: Request, res: Response) => {
    if (!deps.analyticsService) return res.status(503).json({ error: 'Analytics dashboards are unavailable' });
    if (!requireLocalOwnerMutation(req, res)) return;
    try {
      const dashboardId = paramStr(req.params.id);
      const widget = deps.analyticsService.updateWidget(
        dashboardId,
        paramStr(req.params.widgetId),
        req.body,
      );
      res.json({ widget, dashboard: deps.analyticsService.getDashboard(dashboardId) });
    } catch (error) {
      res.status(analyticsMutationStatus(error)).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.put('/analytics/dashboards/:id/widgets/:widgetId/binding', (req: Request, res: Response) => {
    if (!deps.analyticsService) return res.status(503).json({ error: 'Analytics dashboards are unavailable' });
    if (!requireLocalOwnerMutation(req, res)) return;
    try {
      const dashboardId = paramStr(req.params.id);
      const result = deps.analyticsService.updateWidgetBinding(
        dashboardId,
        paramStr(req.params.widgetId),
        req.body,
      );
      if (result.run) {
        void deps.analyticsScheduler?.runDueNow().catch(error => {
          console.warn(`[Analytics controls] scheduler wake failed: ${error instanceof Error ? error.message : error}`);
        });
      }
      res.status(result.run ? 202 : 200).json({ ...result, dashboard: deps.analyticsService.getDashboard(dashboardId) });
    } catch (error) {
      res.status(analyticsMutationStatus(error)).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.get('/analytics/dashboards/:id/widgets/:widgetId/controls', (req: Request, res: Response) => {
    if (!deps.analyticsService) return res.status(503).json({ error: 'Analytics dashboards are unavailable' });
    try {
      const controls = deps.analyticsService.getWidgetControls(
        paramStr(req.params.id),
        paramStr(req.params.widgetId),
      );
      res.set('Cache-Control', 'no-store');
      res.json({ controls });
    } catch (error) {
      const status = analyticsControlMutationStatus(error);
      res.status(status).json({
        code: error instanceof AnalyticsDashboardDataRoomError ? error.code : status === 404 ? 'not_found' : 'invalid_input',
        error: error instanceof Error ? error.message : String(error),
        nextAction: status === 409 ? 'Reload the current widget controls and retry once.' : 'Use only the server-returned control definition and current CAS receipt.',
      });
    }
  });

  router.put('/analytics/dashboards/:id/widgets/:widgetId/controls', (req: Request, res: Response) => {
    if (!deps.analyticsService) return res.status(503).json({ error: 'Analytics dashboards are unavailable' });
    if (!requireLocalOwnerMutation(req, res)) return;
    try {
      const dashboardId = paramStr(req.params.id);
      const result = deps.analyticsService.applyWidgetControls(
        dashboardId,
        paramStr(req.params.widgetId),
        req.body,
      );
      if (result.run) {
        void deps.analyticsScheduler?.runDueNow().catch(error => {
          console.warn(`[Analytics controls] scheduler wake failed: ${error instanceof Error ? error.message : error}`);
        });
      }
      res.status(result.run ? 202 : 200).json({ ...result, dashboard: deps.analyticsService.getDashboard(dashboardId) });
    } catch (error) {
      const status = analyticsControlMutationStatus(error);
      res.status(status).json({
        code: error instanceof AnalyticsDashboardDataRoomError ? error.code : status === 404 ? 'not_found' : status === 409 ? 'conflict' : 'invalid_input',
        error: error instanceof Error ? error.message : String(error),
        nextAction: status === 409 ? 'Reload the current widget controls and retry once.' : 'Use only the server-returned control definition and bounded typed values.',
      });
    }
  });

  router.post('/analytics/dashboards/:id/refresh/widgets', (req: Request, res: Response) => {
    if (!deps.analyticsService) return res.status(503).json({ error: 'Analytics dashboards are unavailable' });
    if (!requireLocalOwnerMutation(req, res)) return;
    try {
      const dashboardId = paramStr(req.params.id);
      const run = deps.analyticsService.enqueueSelectiveRefresh(
        dashboardId,
        req.body?.widgetIds,
        'manual',
      );
      res.status(202).json({ run, dashboard: deps.analyticsService.getDashboard(dashboardId) });
    } catch (error) {
      res.status(analyticsMutationStatus(error)).json({ error: error instanceof Error ? error.message : String(error) });
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
    res.set('Cache-Control', 'no-store');
    if (!deps.dashboardPublisher) return res.status(503).json({ error: 'Dashboard publishing is unavailable' });
    if (!requireLocalOwnerMutation(req, res)) return;
    try {
      const shareRequest = deps.dashboardPublisher.createShareRequest(paramStr(req.params.id));
      res.status(201).json({ shareRequest });
    } catch (error) {
      res.status(dashboardPublicationStatus(error)).json(dashboardPublicationErrorBody(error));
    }
  });

  router.post('/analytics/dashboards/:id/publish', async (req: Request, res: Response) => {
    res.set('Cache-Control', 'no-store');
    if (!deps.dashboardPublisher) return res.status(503).json({ error: 'Dashboard publishing is unavailable' });
    if (!requireLocalOwnerMutation(req, res)) return;
    if (req.body?.confirmed !== true) {
      return res.status(400).json({
        code: 'invalid_confirmation',
        error: 'confirmed must be true after the user reviews the exact upload destination and impact',
        nextAction: 'Prepare or review the current snapshot, then explicitly confirm that exact receipt.',
        drift: [],
      });
    }
    try {
      const result = await deps.dashboardPublisher.publish(
        paramStr(req.params.id),
        String(req.body?.confirmationToken ?? ''),
      );
      dashboardState?.bump();
      res.status(201).json(result);
    } catch (error) {
      if (error instanceof DashboardPublicationError && error.code === 'publication_provider_failed') {
        dashboardState?.bump();
      }
      res.status(dashboardPublicationStatus(error)).json(dashboardPublicationErrorBody(error));
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
