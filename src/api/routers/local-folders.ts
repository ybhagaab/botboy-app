/**
 * Local-folder routes — watched-folder CRUD plus the SSE backfill stream and
 * its cancellation endpoint.
 */

import { Router, Request, Response } from 'express';
import type { BackfillProgress } from '../../monitors/filesystem-monitor.js';
import type { ReviewDecision } from '../../monitors/folder-import-scheduler.js';
import {
  addLocalFolder,
  listLocalFolders,
  updateLocalFolder,
  removeLocalFolder,
  getLocalFolder,
} from '../../core/local-folders-config.js';
import { paramStr, type RouterDeps } from './deps.js';
import { requireLocalOwnerUiRequest } from './local-owner.js';

const REVIEW_DECISION_KEYS = ['keep', 'exclude', 'excludeDirs', 'restoreDirs'] as const;

/** Shape-only validation of a big-file review decision body. */
function validateReviewDecision(body: unknown): { ok: true; value: ReviewDecision } | { ok: false; message: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, message: 'Body must be a JSON object with keep, exclude, excludeDirs, or restoreDirs arrays' };
  }
  const record = body as Record<string, unknown>;
  const unknownKeys = Object.keys(record).filter(key => !(REVIEW_DECISION_KEYS as readonly string[]).includes(key));
  if (unknownKeys.length > 0) return { ok: false, message: `Unknown field(s): ${unknownKeys.join(', ')}` };
  const value: ReviewDecision = {};
  for (const key of REVIEW_DECISION_KEYS) {
    const entry = record[key];
    if (entry === undefined) continue;
    if (!Array.isArray(entry) || !entry.every(item => typeof item === 'string')) {
      return { ok: false, message: `${key} must be an array of absolute paths` };
    }
    value[key] = entry as string[];
  }
  return { ok: true, value };
}

export function createLocalFoldersRouter(deps: RouterDeps): Router {
  const router = Router();

  /**
   * In-flight backfill `AbortController`s keyed by `folderId`, shared by the
   * POST (start/stream) and DELETE (cancel) handlers below. Closure-scoped:
   * one map per router instance, which equals one per process in production
   * and keeps parallel test routers isolated from each other.
   */
  const backfillControllers = new Map<number, AbortController>();
  let backfillCounter = 0;

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
    // The first import runs in the background: scan, big-file review, import.
    deps.folderImports?.kick();

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
    // Disabling or reconfiguring stops an active walk; enabling kicks one.
    deps.folderImports?.folderChanged(id);

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
    // Captured items stay; the import ledger and first-import marker go.
    deps.folderImports?.forgetFolder(id);

    res.status(204).end();
  });

  // ── Import status, big-file review, storage card ──

  router.get('/local-folders/imports', (_req: Request, res: Response) => {
    if (!deps.folderImports) {
      return res.status(503).json({ error: 'Folder imports are not available', nextAction: 'Restart BotBoy.' });
    }
    res.json(deps.folderImports.status());
  });

  router.get('/local-folders/storage', async (req: Request, res: Response) => {
    if (!deps.storageUsage) {
      return res.status(503).json({ error: 'Storage measurement is not available', nextAction: 'Restart BotBoy.' });
    }
    res.json(await deps.storageUsage.get({ refresh: req.query.refresh === '1' }));
  });

  router.get('/local-folders/:id/review', (req: Request, res: Response) => {
    const id = Number(paramStr(req.params.id));
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: 'id must be a positive integer' });
    }
    if (!deps.folderImports) {
      return res.status(503).json({ error: 'Folder imports are not available', nextAction: 'Restart BotBoy.' });
    }
    const review = deps.folderImports.review(id);
    if (!review) return res.status(404).json({ error: `No folder with id ${id}` });
    res.json({ review });
  });

  /**
   * Owner big-file decision (C8). Same-origin owner UI only: the choice to
   * read (or never read) a large file is the owner's, never an agent's.
   * Validation is all-or-nothing; the response names every rejected entry.
   */
  router.post('/local-folders/:id/review', async (req: Request, res: Response) => {
    const id = Number(paramStr(req.params.id));
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: 'id must be a positive integer' });
    }
    if (!requireLocalOwnerUiRequest(
      req,
      res,
      'Big-file review decision',
      'Open Connections → Local folders and choose files in the folder’s big-file review.',
    )) return;
    if (!deps.folderImports) {
      return res.status(503).json({ error: 'Folder imports are not available', nextAction: 'Restart BotBoy.' });
    }
    const validated = validateReviewDecision(req.body);
    if (!validated.ok) {
      return res.status(400).json({
        error: validated.message,
        code: 'invalid_decision',
        nextAction: 'Send keep, exclude, excludeDirs, or restoreDirs as arrays of absolute paths from the review list.',
      });
    }
    const result = await deps.folderImports.decide(id, validated.value);
    if (!result.ok) {
      return res.status(result.status).json({
        error: result.error,
        code: result.code,
        invalid: result.invalid,
        nextAction: result.nextAction,
      });
    }
    res.json(result);
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
    // One walk per folder: a running scheduled import already owns it.
    if (deps.folderImports?.isFolderBusy(id)) {
      return res.status(409).json({
        error: 'This folder is already being imported.',
        code: 'import_running',
        nextAction: 'Wait for the import shown in Local folders to finish; interrupted imports resume on their own.',
      });
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
    const unregisterShutdownWork = deps.shutdown?.registerWork({
      id: `backfill:${id}:${++backfillCounter}`,
      kind: 'local_folder_backfill',
      abort: () => {
        if (!controller.signal.aborted) controller.abort(new Error('BotBoy process is shutting down'));
      },
    });

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
      if (!deps.shutdown?.isShuttingDown()) {
        writeEvent('error', { folderId: id, error: err?.message ?? String(err) });
      }
    } finally {
      unregisterShutdownWork?.();
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
