import { Router, type Request, type Response } from 'express';
import { isValidIanaTimeZone } from '../../core/llm-usage.js';
import type { RouterDeps } from './deps.js';

function serverTimeZone(): string {
  const candidate = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  return isValidIanaTimeZone(candidate) ? candidate : 'UTC';
}

export function createLlmUsageRouter(deps: RouterDeps): Router {
  const router = Router();

  router.get('/llm-usage/daily', (req: Request, res: Response) => {
    if (!deps.llmUsageService) {
      return res.status(503).json({ error: 'LLM usage tracking is unavailable' });
    }

    const rawDays = req.query.days === undefined ? '30' : String(req.query.days);
    if (!/^\d{1,3}$/.test(rawDays)) {
      return res.status(400).json({ error: 'days must be an integer from 1 to 365' });
    }
    const days = Number(rawDays);
    if (!Number.isInteger(days) || days < 1 || days > 365) {
      return res.status(400).json({ error: 'days must be an integer from 1 to 365' });
    }

    const requestedTimeZone = req.query.timeZone === undefined
      ? serverTimeZone()
      : String(req.query.timeZone).trim();
    if (!isValidIanaTimeZone(requestedTimeZone)) {
      return res.status(400).json({ error: 'timeZone must be a valid IANA time zone' });
    }

    try {
      return res.json(deps.llmUsageService.dailyUsage({ days, timeZone: requestedTimeZone }));
    } catch (error) {
      console.warn(`[LLM Usage] daily aggregation failed (${error instanceof Error ? error.name : 'Error'})`);
      return res.status(500).json({ error: 'Could not aggregate local LLM usage' });
    }
  });

  return router;
}
