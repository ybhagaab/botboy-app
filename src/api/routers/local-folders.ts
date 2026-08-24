/**
 * Local-folder routes — watched-folder CRUD plus the SSE backfill stream and
 * its cancellation endpoint.
 */

import { Router, Request, Response } from 'express';
import type { BackfillProgress } from '../../monitors/filesystem-monitor.js';
import {
  addLocalFolder,
  listLocalFolders,
  updateLocalFolder,
  removeLocalFolder,
  getLocalFolder,
} from '../../core/local-folders-config.js';
import { paramStr, type RouterDeps } from './deps.js';

export function createLocalFoldersRouter(deps: RouterDeps): Router {
  const router = Router();

  /**
   * In-flight backfill `AbortController`s keyed by `folderId`, shared by the
   * POST (start/stream) and DELETE (cancel) handlers below. Closure-scoped:
   * one map per router instance, which equals one per process in production
   * and keeps parallel test routers isolated from each other.
   */
  const backfillControllers = new Map<number, AbortController>();

  // ── Local folders config ──

  /**
   * Validate the body shared by POST and PATCH. `requirePath` is true for
   * POST (path is mandatory) and false for PATCH (path is immutable —
   * users delete + re-add to relocate).
   *
   * Returns `{ ok: true, value }` with the cleaned subset on success or
   * `{ ok: false, message }` with a human-readable reason on failure.
   */
  function validateLocalFolderBody(
    body: any,
    requirePath: boolean,
  ):
    | { ok: true; value: any }
    | { ok: false; message: string } {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return { ok: false, message: 'Body must be a JSON object' };
    }
    const out: any = {};
    if (requirePath) {
      if (typeof body.path !== 'string' || body.path.length === 0) {
        return { ok: false, message: 'path must be a non-empty string' };
      }
      out.path = body.path;
    } else if ('path' in body) {
      return { ok: false, message: 'path is immutable; delete and re-add to relocate' };
    }
    if (body.recursive !== undefined) {
      if (typeof body.recursive !== 'boolean') {
        return { ok: false, message: 'recursive must be a boolean' };
      }
      out.recursive = body.recursive;
    }
    if (body.enabled !== undefined) {
      if (typeof body.enabled !== 'boolean') {
        return { ok: false, message: 'enabled must be a boolean' };
      }
      out.enabled = body.enabled;
    }
    if (body.include_globs !== undefined) {
      if (
        !Array.isArray(body.include_globs) ||
        !body.include_globs.every((s: unknown) => typeof s === 'string')
      ) {
        return { ok: false, message: 'include_globs must be a string[]' };
      }
      out.include_globs = body.include_globs;
    }
    if (body.exclude_globs !== undefined) {
      if (
        !Array.isArray(body.exclude_globs) ||
        !body.exclude_globs.every((s: unknown) => typeof s === 'string')
      ) {
        return { ok: false, message: 'exclude_globs must be a string[]' };
      }
      out.exclude_globs = body.exclude_globs;
    }
    return { ok: true, value: out };
  }

  router.get('/local-folders', (_req: Request, res: Response) => {
    const db = deps.db;
    if (!db) return res.status(503).json({ error: 'DB not available' });
    res.json({ folders: listLocalFolders(db) });
  });

  router.post('/local-folders', async (req: Request, res: Response) => {
    const db = deps.db;
    if (!db) return res.status(503).json({ error: 'DB not available' });

    const validated = validateLocalFolderBody(req.body, true);
    if (!validated.ok) {
      return res.status(400).json({ error: validated.message });
    }

    const result = addLocalFolder(db, validated.value);
    if (!result.ok) {
      // not_found / not_dir / outside_home → 400; duplicate → 409.
      const status = result.code === 'duplicate' ? 409 : 400;
      return res.status(status).json({ error: result.message, code: result.code });
    }

    // Hot-reload the watcher set BEFORE responding so the next chokidar
    // event observes the new state (Requirement 4.5 / 8.1).
    try {
      await deps.filesystemMonitor?.setWatchedFolders(listLocalFolders(db));
    } catch (err: any) {
      console.warn('[routes] setWatchedFolders failed after add:', err?.message ?? err);
    }

    res.status(201).json({ folder: result.folder });
  });

  router.patch('/local-folders/:id', async (req: Request, res: Response) => {
    const db = deps.db;
    if (!db) return res.status(503).json({ error: 'DB not available' });

    const id = Number(paramStr(req.params.id));
    if (!Number.isFinite(id) || id <= 0) {
      return res.status(400).json({ error: 'id must be a positive integer' });
    }

    const validated = validateLocalFolderBody(req.body, false);
    if (!validated.ok) {
      return res.status(400).json({ error: validated.message });
    }

    const result = updateLocalFolder(db, id, validated.value);
    if (!result.ok) {
      const status = result.code === 'not_found' ? 404 : 400;
      return res.status(status).json({ error: result.message, code: result.code });
    }

    try {
      await deps.filesystemMonitor?.setWatchedFolders(listLocalFolders(db));
    } catch (err: any) {
      console.warn('[routes] setWatchedFolders failed after patch:', err?.message ?? err);
    }

    res.json({ folder: result.folder });
  });

  router.delete('/local-folders/:id', async (req: Request, res: Response) => {
    const db = deps.db;
    if (!db) return res.status(503).json({ error: 'DB not available' });

    const id = Number(paramStr(req.params.id));
    if (!Number.isFinite(id) || id <= 0) {
      return res.status(400).json({ error: 'id must be a positive integer' });
    }

    const removed = removeLocalFolder(db, id);
    if (!removed) return res.status(404).json({ error: `No folder with id ${id}` });

    try {
      await deps.filesystemMonitor?.setWatchedFolders(listLocalFolders(db));
    } catch (err: any) {
      console.warn('[routes] setWatchedFolders failed after delete:', err?.message ?? err);
    }

    res.status(204).end();
  });

  /**
   * Stream backfill progress as Server-Sent Events. The handler:
   *
   *   1. Validates the folder id and that a `filesystemMonitor` is wired.
   *   2. Allocates a fresh `AbortController` and stores it in
   *      `backfillControllers` keyed by `folderId` so a sibling DELETE can
   *      cancel mid-walk.
   *   3. Writes SSE headers and forwards every `BackfillProgress` event
   *      from the monitor onto the wire as `event: <phase>` + `data: …`.
   *   4. On any terminal phase (`done`/`aborted`/`error`) — and on
   *      synchronous monitor failure — drops the controller and ends the
   *      response.
   *
   * The DELETE endpoint immediately below shares the same map.
   */
  router.post('/local-folders/:id/backfill', async (req: Request, res: Response) => {
    const id = Number(paramStr(req.params.id));
    if (!Number.isFinite(id) || id <= 0) {
      return res.status(400).json({ error: 'id must be a positive integer' });
    }
    if (!deps.filesystemMonitor) {
      return res.status(503).json({ error: 'Filesystem monitor not available' });
    }
    if (!deps.db || !getLocalFolder(deps.db, id)) {
      return res.status(404).json({ error: `No folder with id ${id}` });
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    // If a previous backfill for this folder is still running, abort it
    // before starting a fresh one — the wire only supports one stream per
    // folder, so a duplicate POST should supersede the prior run.
    const existing = backfillControllers.get(id);
    if (existing) existing.abort();

    const controller = new AbortController();
    backfillControllers.set(id, controller);

    const writeEvent = (phase: string, payload: Record<string, unknown>) => {
      try {
        res.write(`event: ${phase}\n`);
        res.write(`data: ${JSON.stringify(payload)}\n\n`);
      } catch {
        // Client disconnected mid-write — abort to stop the walk.
        controller.abort();
      }
    };

    // If the client disconnects (closes the tab, network drop) abort the
    // backfill so we don't keep parsing files for a dead connection.
    req.on('close', () => {
      if (!controller.signal.aborted) controller.abort();
    });

    const onProgress = (p: BackfillProgress) => {
      const { phase, ...rest } = p;
      writeEvent(phase, rest);
    };

    try {
      await deps.filesystemMonitor.backfill(id, {
        onProgress,
        signal: controller.signal,
      });
    } catch (err: any) {
      writeEvent('error', { folderId: id, error: err?.message ?? String(err) });
    } finally {
      backfillControllers.delete(id);
      try { res.end(); } catch {}
    }
  });

  router.delete('/local-folders/:id/backfill', (req: Request, res: Response) => {
    const id = Number(paramStr(req.params.id));
    if (!Number.isFinite(id) || id <= 0) {
      return res.status(400).json({ error: 'id must be a positive integer' });
    }
    const controller = backfillControllers.get(id);
    if (controller) controller.abort();
    // Idempotent: missing controller still 204.
    res.status(204).end();
  });

 return router;
}
