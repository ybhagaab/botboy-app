/**
 * Settings → Knowledge routes (knowledge-library.md K12).
 *
 * Reads answer the local owner only (`requireLocalOwnerRequest`: loopback socket, no foreign Origin) and are never
 * cached. Anything that changes state needs the rendered same-origin owner interface (`requireLocalOwnerUiRequest`), like
 * every other owner control here: a native client cannot create the folder. No listener, bind, port, CORS or auth
 * behavior changes in this file.
 *
 *   GET  /knowledge/status           location, state, sets, categories, analytics move state
 *   GET  /knowledge/set?path=<id>    one set's files; `path` is a set id resolved against the discovery table (404 if none)
 *   POST /knowledge/root             create the folder ({path, confirmExisting?}); the owner's click is the only activation
 *   POST /knowledge/rescan           forget caches, repair lesson projections, read the sets again
 *   POST /knowledge/root/change      Change location: validate, copy the library across and verify, then switch
 *   GET  /knowledge/migration        where the analytics knowledge lives and what a move found before
 *   POST /knowledge/migration/preview  the dry run of moving it into the library (writes nothing)
 *   POST /knowledge/migration/apply  copy, verify, switch ({confirm: planSha256, acknowledgeReclassified?})
 *   POST /knowledge/migration/revert copy back and switch back (never deletes)
 *
 * The write path (P2; changes are the cards in chat and the pending list on the page):
 *   GET  /knowledge/changes          waiting changes (staged, held, stale) with counts; ?status=applied|dismissed|expired for the rest
 *   GET  /knowledge/changes/:id      one change: its diff, open guide-check items, sources and what the owner may do next
 *   POST /knowledge/changes/:id/apply     apply the STORED candidate ({anyway?, confirmFlagged?}; there is no content field)
 *   POST /knowledge/changes/:id/dismiss   close a waiting change without writing
 *   POST /knowledge/changes/:id/recheck   run the guide check again on a held or waiting change (the one route that calls a model)
 *   POST /knowledge/changes/:id/undo      undo this change, only while its History entry is the latest one
 *   POST /knowledge/undo             undo the latest undoable change, bound to the History entry the owner clicked ({entryId}; 409 not_latest when another change landed since the page was drawn)
 *   GET  /knowledge/history          the History entries, the latest undoable one, the git mirror's status
 *   GET  /knowledge/history/:id      one entry with the diff of every file it touched
 */
import { Router, type Request, type Response } from 'express';
import type { RouterDeps } from './deps.js';
import { requireLocalOwnerRequest, requireLocalOwnerUiRequest } from './local-owner.js';
import type { ActivationResult } from '../../core/knowledge-root.js';
import { CHANGE_ID_RE, type ChangeStatus, type KnowledgeChange } from '../../core/knowledge-changes.js';

const READ_LABEL = 'Knowledge library';
const WRITE_LABEL = 'Knowledge library change';
const WRITE_NEXT_ACTION = 'Use the controls in Settings → Knowledge.';
const MAX_PATH_CHARS = 1_024;

function readGuard(req: Request, res: Response): boolean {
  if (!requireLocalOwnerRequest(req, res, READ_LABEL)) return false;
  res.set('Cache-Control', 'no-store');
  return true;
}

function writeGuard(req: Request, res: Response): boolean {
  if (!requireLocalOwnerUiRequest(req, res, WRITE_LABEL, WRITE_NEXT_ACTION)) return false;
  res.set('Cache-Control', 'no-store');
  return true;
}

function plainBody(req: Request, res: Response): Record<string, unknown> | null {
  const body = req.body;
  if (body === undefined || body === null) return {};
  if (typeof body !== 'object' || Array.isArray(body)) {
    res.status(400).json({ error: 'The request body must be a JSON object.', code: 'invalid_body', nextAction: 'Send a JSON object.' });
    return null;
  }
  return body as Record<string, unknown>;
}

const STATUS_FOR_FAILURE: Record<string, number> = {
  invalid_path: 400,
  too_shallow: 400,
  not_allowed_location: 400,
  overlaps_private_state: 400,
  overlaps_program: 400,
  not_a_folder: 400,
  confirm_existing: 409,
  root_pinned_by_environment: 409,
  change_location_required: 409,
  not_activated: 409,
  already_migrated: 409,
  not_migrated: 409,
  blocked: 409,
  conflict: 409,
  plan_changed: 409,
  acknowledgement_required: 409,
  onboarding_running: 409,
  source_changed: 409,
  same_root: 409,
  nested_roots: 400,
  not_enough_space: 507,
  verify_failed: 500,
  permission_denied: 403,
  root_unavailable: 503,
  boundary_not_registered: 503,
  exclusion_not_registered: 503,
  io_error: 500,
};

export function failureBody(failure: { code: string; message: string; nextAction: string; existing?: unknown }): Record<string, unknown> {
  return { error: failure.message, code: failure.code, nextAction: failure.nextAction, ...(failure.existing ? { existing: failure.existing } : {}) };
}

export function createKnowledgeRouter(deps: RouterDeps): Router {
  const router = Router();
  const library = () => deps.knowledgeLibrary;
  const unavailable = (res: Response) => res.status(503).json({ error: 'The Knowledge library is unavailable.', code: 'library_unavailable', nextAction: 'Restart BotBoy.' });

  router.get('/knowledge/status', async (req: Request, res: Response) => {
    if (!readGuard(req, res)) return;
    const service = library();
    if (!service) return unavailable(res);
    try {
      res.json(await service.status());
    } catch (error: any) {
      res.status(500).json({ error: String(error?.message ?? error).slice(0, 300), code: 'internal_error', nextAction: 'Try Rescan; tell the owner if it repeats.' });
    }
  });

  router.get('/knowledge/set', async (req: Request, res: Response) => {
    if (!readGuard(req, res)) return;
    const service = library();
    if (!service) return unavailable(res);
    const raw = req.query.path;
    if (typeof raw !== 'string' || !raw.trim() || raw.length > MAX_PATH_CHARS || raw.includes('\0')) {
      return res.status(400).json({ error: 'path must be a set id.', code: 'invalid_path', nextAction: 'Pick a set from the table.' });
    }
    const detail = await service.getSet(raw);
    if ('code' in detail) {
      const status = detail.code === 'set_not_found' ? 404 : detail.code === 'not_activated' ? 409 : 503;
      return res.status(status).json({ error: detail.message, code: detail.code, nextAction: detail.nextAction, ...(detail.details ?? {}) });
    }
    res.json(detail);
  });

  router.post('/knowledge/root', async (req: Request, res: Response) => {
    if (!writeGuard(req, res)) return;
    const service = library();
    if (!service) return unavailable(res);
    const body = plainBody(req, res);
    if (!body) return;
    const rawPath = body.path;
    if (typeof rawPath !== 'string' || !rawPath.trim() || rawPath.length > MAX_PATH_CHARS || rawPath.includes('\0')) {
      return res.status(400).json({ error: 'path must be a folder path of at most 1,024 characters.', code: 'invalid_path', nextAction: 'Type a path such as ~/Documents/BotBoy Knowledge.' });
    }
    const status = await service.status();
    if (status.pinnedByEnvironment) {
      return res.status(409).json({ error: 'The location is set by BOTBOY_KNOWLEDGE_ROOT and cannot be changed here.', code: 'root_pinned_by_environment', nextAction: 'Unset BOTBOY_KNOWLEDGE_ROOT to choose a location in Settings.' });
    }
    let result: ActivationResult;
    try {
      result = await service.activate(rawPath, { confirmExisting: body.confirmExisting === true });
    } catch (error: any) {
      return res.status(500).json({ error: String(error?.message ?? error).slice(0, 300), code: 'internal_error', nextAction: 'Try again; tell the owner if it repeats.' });
    }
    if (!result.ok) return res.status(STATUS_FOR_FAILURE[result.code] ?? 500).json(failureBody(result));
    res.json({ ok: true, root: result.root, created: result.created, seededGuide: result.seededGuide, analyticsDir: result.analyticsDir, status: await service.status() });
  });

  router.post('/knowledge/rescan', async (req: Request, res: Response) => {
    if (!writeGuard(req, res)) return;
    const service = library();
    if (!service) return unavailable(res);
    try {
      res.json(await service.rescan());
    } catch (error: any) {
      res.status(500).json({ error: String(error?.message ?? error).slice(0, 300), code: 'internal_error', nextAction: 'Try again; tell the owner if it repeats.' });
    }
  });

  // ── Moving the analytics knowledge, and changing the location ──

  router.get('/knowledge/migration', async (req: Request, res: Response) => {
    if (!readGuard(req, res)) return;
    const service = library();
    if (!service) return unavailable(res);
    const status = await service.status();
    res.json({ analyticsDir: status.analyticsDir, migration: status.migration, legacy: status.legacyAnalytics, activated: status.activated, syncNote: status.syncNote });
  });

  router.post('/knowledge/migration/preview', async (req: Request, res: Response) => {
    if (!writeGuard(req, res)) return;
    const migration = deps.knowledgeMigration;
    if (!migration) return unavailable(res);
    try {
      res.json(await migration.plan());
    } catch (error: any) {
      res.status(500).json({ error: String(error?.message ?? error).slice(0, 300), code: 'internal_error', nextAction: 'Try again; tell the owner if it repeats.' });
    }
  });

  router.post('/knowledge/migration/apply', async (req: Request, res: Response) => {
    if (!writeGuard(req, res)) return;
    const migration = deps.knowledgeMigration;
    if (!migration) return unavailable(res);
    const body = plainBody(req, res);
    if (!body) return;
    const confirm = body.confirm;
    if (typeof confirm !== 'string' || !/^[a-f0-9]{64}$/.test(confirm)) {
      return res.status(400).json({ error: 'confirm must be the plan SHA-256 from the preview.', code: 'invalid_confirm', nextAction: 'Preview the move, then confirm that plan.' });
    }
    try {
      const result = await migration.apply({ confirm, acknowledgeReclassified: body.acknowledgeReclassified === true });
      if (!result.ok) return res.status(STATUS_FOR_FAILURE[result.code] ?? 500).json({ ...failureBody(result), ...(result.details ?? {}) });
      res.json(result);
    } catch (error: any) {
      res.status(500).json({ error: String(error?.message ?? error).slice(0, 300), code: 'internal_error', nextAction: 'Nothing was switched. Preview and try again.' });
    }
  });

  router.post('/knowledge/migration/revert', async (req: Request, res: Response) => {
    if (!writeGuard(req, res)) return;
    const migration = deps.knowledgeMigration;
    if (!migration) return unavailable(res);
    try {
      const result = await migration.revert();
      if (!result.ok) return res.status(STATUS_FOR_FAILURE[result.code] ?? 500).json({ ...failureBody(result), ...(result.details ?? {}) });
      res.json(result);
    } catch (error: any) {
      res.status(500).json({ error: String(error?.message ?? error).slice(0, 300), code: 'internal_error', nextAction: 'Try again; tell the owner if it repeats.' });
    }
  });

  router.post('/knowledge/root/change', async (req: Request, res: Response) => {
    if (!writeGuard(req, res)) return;
    const migration = deps.knowledgeMigration;
    if (!migration) return unavailable(res);
    const body = plainBody(req, res);
    if (!body) return;
    const rawPath = body.path;
    if (typeof rawPath !== 'string' || !rawPath.trim() || rawPath.length > MAX_PATH_CHARS || rawPath.includes('\0')) {
      return res.status(400).json({ error: 'path must be a folder path of at most 1,024 characters.', code: 'invalid_path', nextAction: 'Type a path such as ~/Documents/BotBoy Knowledge.' });
    }
    const leaveBehind = Array.isArray(body.leaveBehind) ? body.leaveBehind.filter((name): name is string => typeof name === 'string' && name.length > 0 && name.length <= 120).slice(0, 50) : [];
    try {
      const result = await migration.changeLocation({ path: rawPath, confirmExisting: body.confirmExisting === true, leaveBehind });
      if (!result.ok) return res.status(STATUS_FOR_FAILURE[result.code] ?? 500).json({ ...failureBody(result), ...('details' in result ? result.details ?? {} : {}) });
      res.json({ ...result, status: await library()?.status() });
    } catch (error: any) {
      res.status(500).json({ error: String(error?.message ?? error).slice(0, 300), code: 'internal_error', nextAction: 'Nothing was switched. Try again.' });
    }
  });


  // ── The write path: cards, pending changes and History ──

  const HISTORY_ID_RE = /^h_[a-f0-9]{12}$/;
  const LISTABLE: readonly ChangeStatus[] = ['staged', 'held', 'stale', 'applied', 'dismissed', 'expired'];
  const WAITING_STATUSES: readonly ChangeStatus[] = ['staged', 'held', 'stale'];
  const writePath = (res: Response) => {
    const { knowledgeWriter: writer, knowledgeChanges: changes, knowledgeHistory: history } = deps;
    if (!writer || !changes || !history) { unavailable(res); return null; }
    return { writer, changes, history };
  };
  const badId = (res: Response) => res.status(400).json({ error: 'That is not a change id.', code: 'invalid_id', nextAction: 'Use the id of a card from this page.' });
  const internal = (res: Response, error: any, next = 'Try again; tell the owner if it repeats.') => res.status(500).json({ error: String(error?.message ?? error).slice(0, 300), code: 'internal_error', nextAction: next });

  /** What a card or the pending list needs. The stored plan (the exact texts to write) never leaves the server. */
  function changeView(change: KnowledgeChange): Record<string, unknown> {
    const musts = change.unresolved.filter((item) => item.tier === 'must_fix');
    const effect = (file: { before: string | null; after: string | null }) => (file.before === null ? 'created' : file.after === null ? 'removed' : 'changed');
    return {
      id: change.id, set: change.setName, kind: change.kind, mode: change.mode, file: change.file, status: change.status, statusReason: change.statusReason,
      origin: change.origin, sources: change.sources, why: change.why, trigger: change.trigger, round: change.round, attempt: change.attempt, suspicious: change.suspicious,
      unresolved: change.unresolved, notes: change.notes, check: change.check, overrode: change.overrode,
      files: (change.plan?.files ?? []).map((file) => ({ path: file.path, effect: effect(file) })),
      diff: change.diffText, historyId: change.historyId, createdAt: change.createdAt, decidedAt: change.decidedAt, expiresAt: change.expiresAt,
      // What the buttons do: Apply anyway when a breach is open, a second click for text from an untrusted source or flagged as instructions.
      needsAnyway: musts.length > 0, needsConfirm: change.sources.length > 0 || change.suspicious,
      actions: change.status === 'staged' ? ['apply', 'dismiss', 'recheck'] : change.status === 'held' ? ['recheck', 'dismiss'] : change.status === 'stale' ? ['dismiss'] : [],
    };
  }

  router.get('/knowledge/changes', (req: Request, res: Response) => {
    if (!readGuard(req, res)) return;
    const parts = writePath(res);
    if (!parts) return;
    const wanted = typeof req.query.status === 'string' ? req.query.status : undefined;
    if (wanted !== undefined && !LISTABLE.includes(wanted as ChangeStatus)) {
      return res.status(400).json({ error: 'status must be staged, held, stale, applied, dismissed or expired.', code: 'invalid_status', nextAction: 'Leave status out for the waiting changes.' });
    }
    try {
      const changes = parts.changes.list({ statuses: wanted ? [wanted as ChangeStatus] : WAITING_STATUSES, limit: 50 });
      res.json({ counts: parts.changes.counts(), changes: changes.map(changeView) });
    } catch (error: any) {
      internal(res, error);
    }
  });

  router.get('/knowledge/changes/:id', (req: Request, res: Response) => {
    if (!readGuard(req, res)) return;
    const parts = writePath(res);
    if (!parts) return;
    const id = String(req.params.id ?? '');
    if (!CHANGE_ID_RE.test(id)) return badId(res);
    const change = parts.changes.get(id);
    if (!change) return res.status(404).json({ error: 'That change is unknown or has expired.', code: 'change_not_found', nextAction: 'Ask BotBoy to prepare it again.' });
    res.json(changeView(change));
  });

  /** The answer for a failed owner action: the stored change in its present state, so the card can repaint without a second request. */
  const refused = (res: Response, result: { code: string; message: string; nextAction: string; status?: number; change?: KnowledgeChange }) =>
    res.status(result.status ?? 409).json({ error: result.message, code: result.code, nextAction: result.nextAction, ...(result.change ? { change: changeView(result.change) } : {}) });

  router.post('/knowledge/changes/:id/apply', async (req: Request, res: Response) => {
    if (!writeGuard(req, res)) return;
    const parts = writePath(res);
    if (!parts) return;
    const id = String(req.params.id ?? '');
    if (!CHANGE_ID_RE.test(id)) return badId(res);
    const body = plainBody(req, res);
    if (!body) return;
    try {
      // The body carries two booleans and nothing else: the candidate is the stored one, never text from a click.
      const result = await parts.writer.apply(id, { anyway: body.anyway === true, confirmFlagged: body.confirmFlagged === true });
      if (!result.ok) return refused(res, result);
      res.json({ ok: true, change: changeView(result.change), historyId: result.historyId, summary: result.summary });
    } catch (error: any) {
      internal(res, error, 'Nothing is known to have changed; open History to see.');
    }
  });

  router.post('/knowledge/changes/:id/dismiss', (req: Request, res: Response) => {
    if (!writeGuard(req, res)) return;
    const parts = writePath(res);
    if (!parts) return;
    const id = String(req.params.id ?? '');
    if (!CHANGE_ID_RE.test(id)) return badId(res);
    try {
      const change = parts.writer.dismiss(id);
      if (!change) return res.status(404).json({ error: 'That change is unknown or has expired.', code: 'change_not_found', nextAction: 'Nothing to do.' });
      res.json({ ok: true, change: changeView(change) });
    } catch (error: any) {
      internal(res, error);
    }
  });

  router.post('/knowledge/changes/:id/recheck', async (req: Request, res: Response) => {
    if (!writeGuard(req, res)) return;
    const parts = writePath(res);
    if (!parts) return;
    const id = String(req.params.id ?? '');
    if (!CHANGE_ID_RE.test(id)) return badId(res);
    // The check is a model call: it stops when the owner closes the page.
    const abort = new AbortController();
    res.once('close', () => { if (!res.writableEnded) abort.abort(); });
    try {
      const result = await parts.writer.recheck(id, { signal: abort.signal });
      if (!result.ok) return refused(res, result);
      res.json({ ok: true, change: changeView(result.change) });
    } catch (error: any) {
      internal(res, error);
    }
  });

  /** Undo the latest undoable change, but only the one the owner was shown: a card's change id or a History entry id. */
  const undoLatest = async (res: Response, expected: { changeId?: string; entryId?: string } = {}) => {
    const parts = writePath(res);
    if (!parts) return;
    try {
      const latest = parts.history.latestUndoable();
      // With nothing to undo the writer answers nothing_to_undo; otherwise the clicked entry must still be the latest one (P2 review R26).
      const stale = (expected.changeId && latest?.changeId !== expected.changeId) || (expected.entryId && latest && latest.id !== expected.entryId);
      if (stale) {
        return res.status(409).json({ error: 'Another change came after this one, so it can no longer be undone from here.', code: 'not_latest', nextAction: 'Open History: only the latest change can be undone.' });
      }
      const result = await parts.writer.undo();
      if (!result.ok) return res.status(result.code === 'nothing_to_undo' ? 404 : result.code === 'root_unavailable' ? 503 : 409).json({ error: result.message, code: result.code, nextAction: result.nextAction, ...(result.paths ? { paths: result.paths } : {}) });
      res.json({ ok: true, entry: result.entry, undone: result.undone });
    } catch (error: any) {
      internal(res, error, 'Open History to see what is there.');
    }
  };

  router.post('/knowledge/changes/:id/undo', async (req: Request, res: Response) => {
    if (!writeGuard(req, res)) return;
    const id = String(req.params.id ?? '');
    if (!CHANGE_ID_RE.test(id)) return badId(res);
    await undoLatest(res, { changeId: id });
  });

  router.post('/knowledge/undo', async (req: Request, res: Response) => {
    if (!writeGuard(req, res)) return;
    const body = plainBody(req, res);
    if (!body) return;
    const entryId = typeof body.entryId === 'string' ? body.entryId : '';
    if (!HISTORY_ID_RE.test(entryId)) return res.status(400).json({ error: 'Say which History entry to undo.', code: 'invalid_id', nextAction: 'Use the Undo button on the latest entry in History.' });
    await undoLatest(res, { entryId });
  });

  router.get('/knowledge/history', async (req: Request, res: Response) => {
    if (!readGuard(req, res)) return;
    const parts = writePath(res);
    if (!parts) return;
    try {
      // Edits made outside BotBoy are found now (debounced; the first call records the folder as it stands).
      await parts.history.reconcile();
      const offset = Math.max(0, Math.min(10_000, Number.parseInt(String(req.query.offset ?? '0'), 10) || 0));
      res.json({
        entries: parts.history.list({ limit: 50, offset }),
        latestUndoableId: parts.history.latestUndoable()?.id ?? null,
        git: parts.history.gitStatus(),
        note: 'History stays on this Mac, outside the Knowledge folder. The newest 200 changes keep their older copies; the log keeps every line.',
      });
    } catch (error: any) {
      internal(res, error);
    }
  });

  router.get('/knowledge/history/:id', async (req: Request, res: Response) => {
    if (!readGuard(req, res)) return;
    const parts = writePath(res);
    if (!parts) return;
    const id = String(req.params.id ?? '');
    if (!HISTORY_ID_RE.test(id)) return res.status(400).json({ error: 'That is not a History entry id.', code: 'invalid_id', nextAction: 'Pick an entry from the list.' });
    try {
      const entry = parts.history.get(id);
      if (!entry) return res.status(404).json({ error: 'That History entry is unknown.', code: 'entry_not_found', nextAction: 'Reload History.' });
      res.json({ entry, files: await parts.history.diff(id, { maxLines: 200 }) ?? [], undoable: parts.history.latestUndoable()?.id === id });
    } catch (error: any) {
      internal(res, error);
    }
  });

  return router;
}
