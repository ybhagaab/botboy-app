/**
 * Pipeline routes — lossless-capture-brain-pipeline health, triggers, and the
 * projects/areas read model it produces.
 */

import { Router, Request, Response } from 'express';
import { listAreasWithProjects } from '../../core/project-organizer.js';
import { setBrainTaskState, removeBrainTask } from '../../core/brain-tasks.js';
import { getChannelConfig } from '../../core/slack-config.js';
import { createChannelTierResolver } from '../../core/engagement.js';
import { demoteAmbientProjects } from '../../core/ambient-demotion.js';
import {
  applyTodayItemAction,
  buildTodayView,
  completeTodayTask,
  findTodayActionTarget,
  isValidTodayItemId,
  recordTodayVisit,
  type TodayItemAction,
} from '../../core/today.js';
import { paramStr, type RouterDeps } from './deps.js';

const TODAY_ACTIONS = new Set<TodayItemAction>(['pin', 'unpin', 'snooze', 'dismiss', 'restore']);

function validSince(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) return '';
  return new Date(value).toISOString();
}

function validRowId(value: unknown): number | undefined | null {
  if (value === undefined) return undefined;
  const parsed = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

type TodaySinceLabel = 'last_visit' | 'past_24_hours';

function validSinceLabel(value: unknown): TodaySinceLabel | undefined | null {
  if (value === undefined) return undefined;
  return value === 'last_visit' || value === 'past_24_hours' ? value : null;
}

interface TodaySessionOptions {
  since?: string;
  sinceRowId?: number;
  sinceLabel?: TodaySinceLabel;
}

function parseTodaySession(source: { since?: unknown; sinceRowId?: unknown; sinceLabel?: unknown }): {
  provided: boolean;
  options: TodaySessionOptions;
  error?: string;
} {
  const provided = source.since !== undefined || source.sinceRowId !== undefined || source.sinceLabel !== undefined;
  const since = validSince(source.since);
  const sinceRowId = validRowId(source.sinceRowId);
  const sinceLabel = validSinceLabel(source.sinceLabel);
  if (since === '' || sinceRowId === null || sinceLabel === null) {
    return { provided, options: {}, error: 'Today session cursor is invalid' };
  }
  if (provided && (since === undefined || sinceRowId === undefined || sinceLabel === undefined)) {
    return { provided, options: {}, error: 'since, sinceRowId, and sinceLabel must be provided together' };
  }
  return {
    provided,
    options: provided ? { since, sinceRowId, sinceLabel } : {},
  };
}

function isSameOriginMutation(req: Request): boolean {
  const origin = req.get('origin');
  if (!origin) return true; // Native app, tests, and local CLI clients omit Origin.
  const host = req.get('host');
  if (!host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

export function createPipelineRouter(deps: RouterDeps): Router {
  const router = Router();

  // ── Today: ranked attention model + persistent user controls ──
  router.get('/today', (req: Request, res: Response) => {
    const db = deps.db;
    const brainStore = deps.brainStore;
    if (!db || !brainStore) return res.status(503).json({ error: 'Today view not available' });
    const session = parseTodaySession(req.query);
    if (session.error) return res.status(400).json({ error: session.error });
    try {
      res.json(buildTodayView(db, brainStore, session.options));
    } catch (err: any) {
      res.status(500).json({ error: `Could not build Today view: ${err?.message ?? String(err)}` });
    }
  });

  // Opening Today snapshots the current maximum immutable project-event rowid,
  // then advances the stored visit cursor to that exact boundary. New evidence
  // and later project assignments both append events, even when source capture
  // timestamps are historical.
  router.post('/today/visit', (req: Request, res: Response) => {
    const db = deps.db;
    const brainStore = deps.brainStore;
    if (!db || !brainStore) return res.status(503).json({ error: 'Today view not available' });
    if (!isSameOriginMutation(req)) return res.status(403).json({ error: 'Cross-origin Today mutation rejected' });
    try {
      const view = buildTodayView(db, brainStore);
      recordTodayVisit(db, view);
      res.json(view);
    } catch (err: any) {
      res.status(500).json({ error: `Could not open Today view: ${err?.message ?? String(err)}` });
    }
  });

  router.patch('/today/items/:itemId', (req: Request, res: Response) => {
    const db = deps.db;
    const brainStore = deps.brainStore;
    if (!db || !brainStore) return res.status(503).json({ error: 'Today preferences not available' });
    if (!isSameOriginMutation(req)) return res.status(403).json({ error: 'Cross-origin Today mutation rejected' });
    const itemId = paramStr(req.params.itemId);
    const action = req.body?.action as TodayItemAction | 'mark_done' | undefined;
    const session = parseTodaySession(req.body ?? {});
    const expectedVersion = validRowId(req.body?.expectedVersion);
    if (!isValidTodayItemId(itemId) || !action
      || (action !== 'mark_done' && !TODAY_ACTIONS.has(action))) {
      return res.status(400).json({ error: 'Expected a current Today item and action: pin, unpin, snooze, dismiss, restore, or mark_done' });
    }
    if (session.error || !session.provided) {
      return res.status(400).json({ error: session.error ?? 'A complete Today session cursor is required' });
    }
    if (expectedVersion === null) return res.status(400).json({ error: 'expectedVersion must be a non-negative integer' });
    try {
      const view = buildTodayView(db, brainStore, session.options);
      const target = findTodayActionTarget(view, itemId);
      if (!target) return res.status(404).json({ error: 'Today item is no longer current' });
      if (action === 'mark_done') {
        if (target.kind !== 'task') return res.status(400).json({ error: 'Only brain tasks can be marked done' });
        const completed = completeTodayTask(db, brainStore, itemId);
        if (!completed) return res.status(404).json({ error: 'This task is no longer open in the project brain' });
        return res.json({ itemId, completed });
      }
      if (target.kind === 'change') {
        if (expectedVersion === undefined) {
          return res.status(400).json({ error: 'expectedVersion is required for change controls' });
        }
        if (target.version !== expectedVersion) {
          return res.status(409).json({
            error: 'This change has newer evidence. Refresh Today before updating it.',
            currentVersion: target.version,
          });
        }
      }
      const state = applyTodayItemAction(db, itemId, action, {
        snoozedUntil: req.body?.snoozedUntil,
        target,
        sessionSince: session.options.since,
      });
      res.json({ itemId, state });
    } catch (err: any) {
      res.status(400).json({ error: err?.message ?? String(err) });
    }
  });

  // ── Pipeline health & observability (lossless-capture-brain-pipeline R9.4) ──
  router.get('/pipeline/health', (_req: Request, res: Response) => {
    const db = deps.db;
    if (!db) return res.status(503).json({ error: 'DB not available' });
    const health = deps.failures?.health() ?? { totalFailures: 0, failuresByStep: {}, retryableFailures: 0, incompleteItems: 0 };
    const stateRows = db
      .prepare('SELECT process_state AS s, COUNT(*) AS c FROM work_items GROUP BY process_state')
      .all() as { s: string; c: number }[];
    const byState: Record<string, number> = {};
    for (const r of stateRows) byState[r.s] = r.c;
    const orphanCount = byState['orphaned'] ?? 0;
    const projectCount = (db.prepare('SELECT COUNT(*) AS c FROM projects').get() as { c: number }).c;
    const lastRuns = db
      .prepare('SELECT id, pass, batch_id, items_in, items_out, status, started_at, completed_at FROM pipeline_runs ORDER BY started_at DESC LIMIT 20')
      .all();
    res.json({
      ...health,
      itemsByState: byState,
      orphanCount,
      projectCount,
      lastRuns,
    });
  });

  // ── Pipeline triggers (on-demand, for periodic scripts / cron) ──
  router.post('/pipeline/process', async (_req: Request, res: Response) => {
    const orch = deps.pipelineOrchestrator;
    if (!orch) return res.status(503).json({ error: 'pipeline not available' });
    try {
      const result = await orch.processAll();
      res.json({ ok: true, ...result });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err?.message ?? String(err) });
    }
  });

  router.post('/pipeline/reconcile', async (_req: Request, res: Response) => {
    const orch = deps.pipelineOrchestrator;
    if (!orch) return res.status(503).json({ error: 'pipeline not available' });
    try {
      await orch.tickReconcile();
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err?.message ?? String(err) });
    }
  });

  // Manual organize = deliberate → full anchored rebalance by default.
  // Body { "full": false } restricts it to unassigned projects only (same as
  // the scheduled tick).
  router.post('/pipeline/organize', async (req: Request, res: Response) => {
    const orch = deps.pipelineOrchestrator;
    if (!orch) return res.status(503).json({ error: 'pipeline not available' });
    try {
      await orch.tickOrganize({ full: req.body?.full !== false });
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err?.message ?? String(err) });
    }
  });

  // ── Ambient channels: engagement tiers, digests, cross-links ──
  router.get('/channels/digests', (_req: Request, res: Response) => {
    const db = deps.db;
    if (!db) return res.status(503).json({ error: 'channel digests not available' });
    try {
      const resolveTier = createChannelTierResolver(db);
      const digestByChannel = new Map(
        (db.prepare('SELECT * FROM channel_digests').all() as {
          channel_id: string; channel_name: string; digest: string; topics: string;
          message_count: number; window_start: string | null; window_end: string | null; updated_at: string;
        }[]).map((row) => [row.channel_id, row]),
      );
      const infoStmt = db.prepare(`
        SELECT json_extract(metadata, '$.channelName') AS name,
               json_extract(metadata, '$.channelType') AS type,
               captured_at AS lastMessageAt
        FROM work_items
        WHERE source = 'slack' AND type = 'slack_message'
          AND json_extract(metadata, '$.channelId') = ?
        ORDER BY captured_at DESC LIMIT 1
      `);
      const countStmt = db.prepare(`
        SELECT COUNT(*) AS count FROM work_items
        WHERE source = 'slack' AND type = 'slack_message'
          AND json_extract(metadata, '$.channelId') = ?
      `);
      // DMs and group DMs are captured automatically (no subscription), so
      // list every conversation we have actually captured alongside the
      // explicitly watched channels.
      const capturedDmIds = (db.prepare(`
        SELECT DISTINCT json_extract(metadata, '$.channelId') AS id FROM work_items
        WHERE source = 'slack' AND type = 'slack_message'
          AND json_extract(metadata, '$.channelType') IN ('dm', 'group_dm')
          AND json_extract(metadata, '$.channelId') IS NOT NULL
      `).all() as { id: string }[]).map((row) => row.id);
      const channelIds = [...new Set([...getChannelConfig(db), ...capturedDmIds])];
      const channels = channelIds.map((channelId) => {
        const info = infoStmt.get(channelId) as { name: string | null; type: string | null; lastMessageAt: string | null } | undefined;
        const digest = digestByChannel.get(channelId);
        let topics: unknown[] = [];
        try { topics = JSON.parse(digest?.topics ?? '[]'); } catch { /* corrupt row degrades to empty */ }
        const channelType = info?.type || 'channel';
        return {
          channelId,
          channelName: info?.name || digest?.channel_name || channelId,
          channelType,
          tier: resolveTier(channelId, channelType),
          messageCount: (countStmt.get(channelId) as { count: number }).count,
          lastMessageAt: info?.lastMessageAt ?? null,
          digest: digest ? {
            text: digest.digest,
            topics,
            messageCount: digest.message_count,
            windowStart: digest.window_start,
            windowEnd: digest.window_end,
            updatedAt: digest.updated_at,
          } : null,
        };
      });
      res.json({ channels });
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? String(err) });
    }
  });

  router.post('/channels/digests/run', async (req: Request, res: Response) => {
    const digester = deps.channelDigester;
    if (!digester) return res.status(503).json({ error: 'channel digester not available' });
    if (!isSameOriginMutation(req)) return res.status(403).json({ error: 'Cross-origin digest run rejected' });
    try {
      const channelIds = Array.isArray(req.body?.channelIds)
        ? req.body.channelIds.filter((id: unknown): id is string => typeof id === 'string')
        : undefined;
      res.json(await digester.run(channelIds ? { channelIds } : undefined));
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? String(err) });
    }
  });

  router.get('/projects/:id/cross-links', (req: Request, res: Response) => {
    const db = deps.db;
    if (!db) return res.status(503).json({ error: 'cross-links not available' });
    try {
      const rows = db.prepare(`
        SELECT channel_id AS channelId, channel_name AS channelName, topic,
               evidence_item_id AS evidenceItemId, reason, created_at AS createdAt
        FROM project_cross_links WHERE project_id = ?
        ORDER BY created_at DESC LIMIT 50
      `).all(paramStr(req.params.id));
      res.json({ crossLinks: rows });
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? String(err) });
    }
  });

  // Retroactive cleanup: archive projects born entirely from ambient channel
  // messages and release their evidence to the digest pool. Dry-run by
  // default; body {"apply": true} performs the (reversible) demotion.
  router.post('/pipeline/demote-ambient', (req: Request, res: Response) => {
    const db = deps.db;
    const brainStore = deps.brainStore;
    if (!db || !brainStore) return res.status(503).json({ error: 'demotion not available' });
    if (!isSameOriginMutation(req)) return res.status(403).json({ error: 'Cross-origin demotion rejected' });
    try {
      res.json(demoteAmbientProjects(db, brainStore, { apply: req.body?.apply === true }));
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? String(err) });
    }
  });

  // Regenerate project brains (catch-up briefings) from all their items.
  // Body: { projectId?: string, chunkSize?: number, minItems?: number }.
  // With projectId → rebuild one; without → rebuild all populated projects.
  router.post('/pipeline/rebuild-brains', async (req: Request, res: Response) => {
    const orch = deps.pipelineOrchestrator;
    if (!orch) return res.status(503).json({ error: 'pipeline not available' });
    try {
      const { projectId, chunkSize, minItems } = req.body ?? {};
      if (projectId) {
        const r = await orch.rebuildBrain(String(projectId), { chunkSize });
        return res.json({ ok: true, ...r });
      }
      const r = await orch.rebuildAllBrains({ chunkSize, minItems });
      res.json({ ok: true, ...r });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err?.message ?? String(err) });
    }
  });

  // Areas → Projects (two-level hierarchy)
  router.get('/areas', (_req: Request, res: Response) => {
    const db = deps.db;
    if (!db) return res.status(503).json({ error: 'db not available' });
    const areas = listAreasWithProjects(db);
    res.json({ areas, count: areas.length });
  });

  // ── Projects & brains (lossless-capture-brain-pipeline) ──
  router.get('/projects', (_req: Request, res: Response) => {
    const db = deps.db;
    const bs = deps.brainStore;
    if (!db || !bs) return res.status(503).json({ error: 'projects not available' });
    const projects = bs.listProjects().map((p) => {
      const itemCount = (db.prepare('SELECT COUNT(*) AS c FROM work_items WHERE project_id = ?').get(p.id) as { c: number }).c;
      const scopeAlertCount = (db.prepare('SELECT COUNT(*) AS c FROM work_items WHERE project_id = ? AND scope_alert IS NOT NULL').get(p.id) as { c: number }).c;
      return {
        id: p.id, title: p.title, status: p.status,
        oneLiner: p.one_liner, updatedAt: p.updated_at, itemCount, scopeAlertCount,
      };
    });
    res.json({ projects, count: projects.length });
  });

  // Project-page task actions (owner feature 2026-08-27): Done/Reopen and
  // Discard buttons on task rows. Same matching rule as the chat tools
  // (brain-tasks.ts) — exact normalized text or unique substring; ambiguity
  // and misses return the actionable error message as a 4xx.
  router.post('/projects/:id/tasks/state', (req: Request, res: Response) => {
    const bs = deps.brainStore;
    if (!bs) return res.status(503).json({ error: 'projects not available' });
    const outcome = setBrainTaskState(
      bs,
      paramStr(req.params.id),
      String(req.body?.text ?? '').trim(),
      String(req.body?.state ?? '').trim(),
    );
    if (!outcome.ok) {
      return res.status(/not found/i.test(outcome.message) ? 404 : 400).json({ error: outcome.message });
    }
    res.json({ ok: true, message: outcome.message });
  });

  router.post('/projects/:id/tasks/remove', (req: Request, res: Response) => {
    const bs = deps.brainStore;
    if (!bs) return res.status(503).json({ error: 'projects not available' });
    const outcome = removeBrainTask(bs, paramStr(req.params.id), String(req.body?.text ?? '').trim());
    if (!outcome.ok) {
      return res.status(/not found/i.test(outcome.message) ? 404 : 400).json({ error: outcome.message });
    }
    res.json({ ok: true, message: outcome.message });
  });

  router.get('/projects/:id', (req: Request, res: Response) => {
    const db = deps.db;
    const bs = deps.brainStore;
    if (!db || !bs) return res.status(503).json({ error: 'projects not available' });
    const id = paramStr(req.params.id);
    const brain = bs.read(id);
    if (!brain) return res.status(404).json({ error: 'project not found' });
    const items = db
      .prepare(`
        SELECT id, title, type, source, source_app AS sourceApp, summary, url,
               file_path AS filePath, metadata, captured_at, captured_at AS capturedAt,
               scope_alert AS scopeAlert
        FROM work_items
        WHERE project_id = ?
        ORDER BY captured_at DESC
        LIMIT 100
      `)
      .all(id) as Array<Record<string, unknown>>;
    for (const item of items) {
      // Mixed-scope quarantine flag written by the brain pass; parsed for the UI.
      try { item.scopeAlert = item.scopeAlert ? JSON.parse(String(item.scopeAlert)) : null; } catch { item.scopeAlert = null; }
    }
    const project = bs.getProject(id);
    const rejectedItems = db
      .prepare(`
        SELECT w.id, w.title, w.type, w.source, w.summary, w.url,
               w.captured_at AS capturedAt, r.rejected_at AS rejectedAt
        FROM work_item_rejections r
        JOIN work_items w ON w.id = r.work_item_id
        WHERE r.project_id = ?
        ORDER BY r.rejected_at DESC
        LIMIT 100
      `)
      .all(id);
    const scopeAlertCount = items.filter((item) => item.scopeAlert).length;
    // Deterministic sibling links (annotation only, owner-dismissible).
    let relatedProjects: unknown[] = [];
    try { relatedProjects = deps.projectRelations?.listForProject(id) ?? []; } catch { /* optional */ }
    res.json({
      brain,
      items,
      rejectedItems,
      foundingScope: project?.founding_scope ?? null,
      scopeAlertCount,
      relatedProjects,
    });
  });

  // ── Related projects: owner veto on a detected sibling link ──
  // Dismissal survives recomputes for as long as the pair keeps being
  // detected; restore undoes it. Symmetric — either side may be passed first.
  router.post('/projects/:projectId/relations/:otherId/dismiss', (req: Request, res: Response) => {
    const engine = deps.projectRelations;
    if (!engine) return res.status(503).json({ error: 'related projects not available' });
    if (!isSameOriginMutation(req)) return res.status(403).json({ error: 'Cross-origin relation mutation rejected' });
    const changed = engine.dismiss(paramStr(req.params.projectId), paramStr(req.params.otherId));
    if (!changed) return res.status(404).json({ error: 'relation not found' });
    res.json({ ok: true });
  });

  router.post('/projects/:projectId/relations/:otherId/restore', (req: Request, res: Response) => {
    const engine = deps.projectRelations;
    if (!engine) return res.status(503).json({ error: 'related projects not available' });
    if (!isSameOriginMutation(req)) return res.status(403).json({ error: 'Cross-origin relation mutation rejected' });
    const changed = engine.restore(paramStr(req.params.projectId), paramStr(req.params.otherId));
    if (!changed) return res.status(404).json({ error: 'relation not found' });
    res.json({ ok: true });
  });

  // ── Owner evidence curation: reject / restore ──
  // Rejection detaches the item (never deletes it), records a permanent
  // routing exclusion for this project, and returns it to the orphan pool.
  router.post('/projects/:projectId/evidence/:itemId/reject', (req: Request, res: Response) => {
    const db = deps.db;
    if (!db) return res.status(503).json({ error: 'evidence curation not available' });
    if (!isSameOriginMutation(req)) return res.status(403).json({ error: 'Cross-origin evidence mutation rejected' });
    const projectId = paramStr(req.params.projectId);
    const itemId = paramStr(req.params.itemId);
    try {
      const item = db.prepare('SELECT project_id AS projectId FROM work_items WHERE id = ?').get(itemId) as
        | { projectId: string | null } | undefined;
      if (!item) return res.status(404).json({ error: 'evidence item not found' });
      if (item.projectId !== projectId) return res.status(409).json({ error: 'item no longer belongs to this project' });
      db.transaction(() => {
        db.prepare('INSERT OR IGNORE INTO work_item_rejections (work_item_id, project_id) VALUES (?, ?)')
          .run(itemId, projectId);
        db.prepare("UPDATE work_items SET project_id = NULL, process_state = 'orphaned', batch_id = NULL WHERE id = ?")
          .run(itemId);
      })();
      res.json({ ok: true, itemId, projectId });
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? String(err) });
    }
  });

  // ── Owner global discard: never show this item anywhere ──
  router.post('/items/:itemId/discard', (req: Request, res: Response) => {
    const db = deps.db;
    if (!db) return res.status(503).json({ error: 'evidence curation not available' });
    if (!isSameOriginMutation(req)) return res.status(403).json({ error: 'Cross-origin evidence mutation rejected' });
    const itemId = paramStr(req.params.itemId);
    try {
      const item = db.prepare('SELECT process_state AS state, project_id AS projectId FROM work_items WHERE id = ?')
        .get(itemId) as { state: string; projectId: string | null } | undefined;
      if (!item) return res.status(404).json({ error: 'evidence item not found' });
      if (db.prepare('SELECT 1 FROM work_item_discards WHERE work_item_id = ?').get(itemId)) {
        return res.json({ ok: true, itemId, alreadyDiscarded: true });
      }
      if (item.state === 'noise') {
        return res.status(409).json({ error: 'item is already classified as noise' });
      }
      db.transaction(() => {
        db.prepare('INSERT INTO work_item_discards (work_item_id, previous_state, previous_project_id) VALUES (?, ?, ?)')
          .run(itemId, item.state, item.projectId);
        db.prepare("UPDATE work_items SET project_id = NULL, process_state = 'noise', batch_id = NULL WHERE id = ?")
          .run(itemId);
      })();
      res.json({ ok: true, itemId });
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? String(err) });
    }
  });

  router.post('/items/:itemId/restore-discard', (req: Request, res: Response) => {
    const db = deps.db;
    if (!db) return res.status(503).json({ error: 'evidence curation not available' });
    if (!isSameOriginMutation(req)) return res.status(403).json({ error: 'Cross-origin evidence mutation rejected' });
    const itemId = paramStr(req.params.itemId);
    try {
      const discard = db.prepare(
        'SELECT previous_state AS state, previous_project_id AS projectId FROM work_item_discards WHERE work_item_id = ?',
      ).get(itemId) as { state: string; projectId: string | null } | undefined;
      if (!discard) return res.status(404).json({ error: 'no discard recorded for this item' });
      db.transaction(() => {
        db.prepare('DELETE FROM work_item_discards WHERE work_item_id = ?').run(itemId);
        db.prepare('UPDATE work_items SET project_id = ?, process_state = ? WHERE id = ?')
          .run(discard.projectId, discard.state, itemId);
      })();
      res.json({ ok: true, itemId, restoredState: discard.state, restoredProjectId: discard.projectId });
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? String(err) });
    }
  });

  router.get('/items/discarded', (req: Request, res: Response) => {
    const db = deps.db;
    if (!db) return res.status(503).json({ error: 'evidence curation not available' });
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
    try {
      const items = db.prepare(`
        SELECT w.id, w.title, w.type, w.source, w.summary,
               w.captured_at AS capturedAt, d.discarded_at AS discardedAt,
               d.previous_project_id AS previousProjectId
        FROM work_item_discards d
        JOIN work_items w ON w.id = d.work_item_id
        ORDER BY d.discarded_at DESC LIMIT ?
      `).all(limit);
      res.json({ items });
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? String(err) });
    }
  });

  router.post('/projects/:projectId/evidence/:itemId/restore', (req: Request, res: Response) => {
    const db = deps.db;
    if (!db) return res.status(503).json({ error: 'evidence curation not available' });
    if (!isSameOriginMutation(req)) return res.status(403).json({ error: 'Cross-origin evidence mutation rejected' });
    const projectId = paramStr(req.params.projectId);
    const itemId = paramStr(req.params.itemId);
    try {
      const rejection = db.prepare('SELECT 1 FROM work_item_rejections WHERE work_item_id = ? AND project_id = ?')
        .get(itemId, projectId);
      if (!rejection) return res.status(404).json({ error: 'no rejection recorded for this item and project' });
      const item = db.prepare('SELECT project_id AS projectId FROM work_items WHERE id = ?').get(itemId) as
        | { projectId: string | null } | undefined;
      if (!item) return res.status(404).json({ error: 'evidence item not found' });
      if (item.projectId && item.projectId !== projectId) {
        return res.status(409).json({ error: 'item has since been routed to another project' });
      }
      db.transaction(() => {
        db.prepare('DELETE FROM work_item_rejections WHERE work_item_id = ? AND project_id = ?')
          .run(itemId, projectId);
        db.prepare("UPDATE work_items SET project_id = ?, process_state = 'routed' WHERE id = ?")
          .run(projectId, itemId);
      })();
      res.json({ ok: true, itemId, projectId });
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? String(err) });
    }
  });

 return router;
}
