import { Router, type Request, type Response } from 'express';
import type { RouterDeps } from './deps.js';
import { requireLocalOwnerUiRequest } from './local-owner.js';

/**
 * Browser capture: pacing status and the owner's pause switch.
 *
 * GET is readable by any local caller (the Connections card and the top-bar
 * chip read it on load and when `/dashboard/version` reports a new
 * `browserCaptureVersion`). PUT /pause changes only from the rendered
 * same-origin owner page. Pausing is the owner's choice, not a failure, so
 * it is deliberately not part of capture-health.
 */
export function createBrowserCaptureRouter(deps: RouterDeps): Router {
  const router = Router();

  function payload() {
    const { state, monitor } = deps.browserCapture!;
    const pause = state.pause();
    return { ...monitor.status(), paused: pause.paused, changedAt: pause.changedAt, version: state.version() };
  }

  router.get('/browser-capture', (_req: Request, res: Response) => {
    if (!deps.browserCapture) return res.status(503).json({ error: 'Browser capture is not available' });
    res.json(payload());
  });

  router.put('/browser-capture/pause', (req: Request, res: Response) => {
    if (!requireLocalOwnerUiRequest(req, res, 'Browser capture pause', 'Use the Pause button on Connections → Browser capture.')) return;
    if (!deps.browserCapture) return res.status(503).json({ error: 'Browser capture is not available' });
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body as Record<string, unknown> : null;
    if (!body || typeof body.paused !== 'boolean') {
      return res.status(400).json({ error: 'Send { "paused": true } or { "paused": false }.' });
    }
    const { state, monitor } = deps.browserCapture;
    state.setPaused(body.paused);
    // Resuming polls now and returns pacing to the configured interval.
    if (!body.paused) monitor.wake();
    res.json(payload());
  });

  return router;
}
