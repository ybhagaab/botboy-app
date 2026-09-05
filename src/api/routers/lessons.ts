/**
 * Lessons ledger routes — the button-based approval flow (owner ask
 * 2026-09-05: raw lesson ids are not owner-facing; approval is a click).
 *
 * Chat surfaces a proposal as a CARD (app.js expands `[[lesson:<id>]]`
 * markers); the card's Adopt/Dismiss buttons land here. These are OWNER
 * actions from the local UI — the click is the approval, same trust model
 * as the document workbench's Approve/Sync buttons. Adoption renders the
 * lesson into the knowledge dir (lessons-ledger.ts owns the projection).
 */

import { Router, Request, Response } from 'express';
import { paramStr, type RouterDeps } from './deps.js';
import { listLessons, getLesson, adoptLesson, retireLesson, type LessonStatus } from '../../core/lessons-ledger.js';

export function createLessonsRouter(deps: RouterDeps): Router {
  const router = Router();

  router.get('/lessons', (req: Request, res: Response) => {
    if (!deps.db) return res.status(503).json({ error: 'DB not available' });
    const status = String(req.query.status ?? '');
    const scope = String(req.query.scope ?? '');
    const lessons = listLessons(deps.db, {
      ...(['proposed', 'adopted', 'retired'].includes(status) ? { status: status as LessonStatus } : {}),
      ...(scope ? { scope } : {}),
    });
    res.json({ lessons });
  });

  router.get('/lessons/:id', (req: Request, res: Response) => {
    if (!deps.db) return res.status(503).json({ error: 'DB not available' });
    const lesson = getLesson(deps.db, paramStr(req.params.id));
    if (!lesson) return res.status(404).json({ error: 'Lesson not found' });
    res.json({ lesson });
  });

  router.post('/lessons/:id/adopt', (req: Request, res: Response) => {
    if (!deps.db) return res.status(503).json({ error: 'DB not available' });
    try {
      const lesson = adoptLesson(deps.db, paramStr(req.params.id));
      res.json({ lesson });
    } catch (error: any) {
      res.status(404).json({ error: String(error?.message ?? error) });
    }
  });

  router.post('/lessons/:id/retire', (req: Request, res: Response) => {
    if (!deps.db) return res.status(503).json({ error: 'DB not available' });
    try {
      const lesson = retireLesson(deps.db, paramStr(req.params.id));
      res.json({ lesson });
    } catch (error: any) {
      res.status(404).json({ error: String(error?.message ?? error) });
    }
  });

  return router;
}
