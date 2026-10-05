import { mkdtempSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import { createStorage, getSetting, type StorageLayer } from './storage.js';
import { createContentStore, refToColumns } from './content-store.js';
import { createBrainStore, newBrain } from './brain-store.js';
import type { BrainUpdateResult } from './brain-updater.js';
import {
  EXCLUSIVITY_VETO_REASON_PREFIX,
  OWNER_RESTORED_BATCH_ID,
  PLACEMENT_REPAIR_BATCH_ID,
  PLACEMENT_REPAIR_KEY,
  createPlacementRepair,
  type PlacementRepairReceipt,
} from './placement-repair.js';

describe('placement repair (owner decision 2026-10-05)', () => {
  let storage: StorageLayer;
  let dir: string;

  beforeEach(() => {
    storage = createStorage(':memory:');
    storage.initialize();
    dir = mkdtempSync(path.join(os.tmpdir(), 'ppt-placement-repair-'));
  });
  afterEach(() => {
    storage.close();
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  });

  const db = () => storage.getDb();
  const contentStore = () => createContentStore(db(), { contentDir: dir, inlineThresholdBytes: 1024 });
  const brainStore = () => createBrainStore(db(), { brainsDir: path.join(dir, 'brains') });

  function project(id: string, title: string): void {
    brainStore().write(newBrain(id, title), title);
  }

  let minute = 0;
  function item(id: string, title: string, content: string, opts: {
    state?: string; projectId?: string; type?: string; scopeAlert?: string;
  } = {}): void {
    const cols = refToColumns(contentStore().put(id, content));
    const capturedAt = new Date(Date.UTC(2026, 8, 1, 9, minute++)).toISOString();
    db().prepare(`
      INSERT INTO work_items
        (id, type, source, title, captured_at, process_state, project_id, scope_alert,
         raw_text, content_storage, content_path, content_sha256, content_bytes, metadata)
      VALUES (?, ?, 'filesystem', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}')
    `).run(
      id, opts.type ?? 'document_capture', title, capturedAt, opts.state ?? 'orphaned',
      opts.projectId ?? null, opts.scopeAlert ?? null,
      cols.raw_text, cols.content_storage, cols.content_path, cols.content_sha256, cols.content_bytes,
    );
  }

  function decide(itemId: string, requestedProjectId: string, opts: {
    modelDecision?: string; appliedDecision?: string; reason?: string;
  } = {}): void {
    db().prepare(`
      INSERT INTO routing_decisions
        (run_id, batch_id, item_id, model_decision, requested_project_id, applied_decision, validation_reason)
      VALUES ('run', 'batch', ?, ?, ?, ?, ?)
    `).run(
      itemId, opts.modelDecision ?? 'assign', requestedProjectId, opts.appliedDecision ?? 'orphan',
      opts.reason ?? `${EXCLUSIVITY_VETO_REASON_PREFIX} MX Player Content Cards & Banner Widgets`,
    );
  }

  /** An item the retired veto orphaned although the model chose Argonaut. */
  function vetoed(id: string, opts: { projectId?: string; title?: string; content?: string } = {}): void {
    item(id, opts.title ?? `${id}-AppsFlyer-and-CleverTap-Event-Contract.docx`, opts.content ?? [
      'AppsFlyer and CleverTap event contract for MX playback telemetry.',
      'Player exit events carry content metadata and validated playback metrics.',
    ].join('\n'));
    decide(id, opts.projectId ?? 'proj_argonaut');
  }

  function repair(available: () => boolean = () => true) {
    return createPlacementRepair({
      db: db(), contentStore: contentStore(), brainStore: brainStore(),
      llm: { isAvailable: available }, yieldToLoop: async () => {},
    });
  }

  function reader(onUpdate: (projectId: string, itemIds: string[]) => void = () => {}) {
    const calls: Array<{ projectId: string; itemIds: string[] }> = [];
    return {
      calls,
      async updateProject(projectId: string, itemIds: string[]): Promise<BrainUpdateResult> {
        calls.push({ projectId, itemIds });
        onUpdate(projectId, itemIds);
        return { projectId, status: 'updated' };
      },
    };
  }

  const row = (id: string) => db().prepare('SELECT process_state AS state, project_id AS projectId, scope_alert AS scopeAlert FROM work_items WHERE id = ?').get(id) as any;
  const receipt = () => getSetting<PlacementRepairReceipt>(db(), PLACEMENT_REPAIR_KEY);

  beforeEach(() => {
    minute = 0;
    project('proj_argonaut', 'Argonaut MX Client Metrics Instrumentation');
    project('proj_cards', 'MX Player Content Cards & Banner Widgets');
  });

  it('returns a vetoed orphan to the project the model chose, with an audit row and a receipt', async () => {
    vetoed('contract');

    expect(await repair().tick(reader())).toEqual({ ran: true, step: 'placed', placed: 1, released: 0, ownerRestored: 0, projects: 1 });

    expect(row('contract')).toMatchObject({ state: 'routed', projectId: 'proj_argonaut' });
    const audit = db().prepare('SELECT * FROM routing_decisions WHERE item_id = ? ORDER BY id DESC LIMIT 1').get('contract') as any;
    expect(audit).toMatchObject({
      batch_id: PLACEMENT_REPAIR_BATCH_ID,
      model_decision: 'assign',
      requested_project_id: 'proj_argonaut',
      applied_decision: 'assign',
      applied_project_id: 'proj_argonaut',
      validation_reason: 'restored model placement (exclusivity veto retired 2026-10-05): matched title scope via mx, metrics',
    });
    expect(receipt()).toMatchObject({ placed: 1, released: 0, skipped: {}, pending: [{ projectId: 'proj_argonaut', itemIds: ['contract'] }] });
    expect((db().prepare("SELECT COUNT(*) AS n FROM work_item_project_events WHERE work_item_id = 'contract' AND project_id = 'proj_argonaut'").get() as any).n).toBe(1);
  });

  it('leaves a vetoed orphan alone when the current rule would not place it', async () => {
    project('proj_archived', 'Argonaut Metrics Archive');
    db().prepare("UPDATE projects SET status = 'archived' WHERE id = 'proj_archived'").run();
    project('proj_container', 'Slack #argonaut-metrics');
    vetoed('inactive', { projectId: 'proj_archived' });
    vetoed('missing', { projectId: 'proj_gone' });
    vetoed('container', { projectId: 'proj_container' });
    vetoed('rejected');
    db().prepare("INSERT INTO work_item_rejections (work_item_id, project_id) VALUES ('rejected', 'proj_argonaut')").run();
    vetoed('unanchored', { title: 'Banner widget notes', content: 'Content cards and banner widgets for the home page carousel.' });
    vetoed('owner-placed');
    db().prepare("UPDATE work_items SET process_state = 'routed', project_id = 'proj_cards' WHERE id = 'owner-placed'").run();
    vetoed('reference');
    db().prepare("UPDATE work_items SET type = 'file_reference' WHERE id = 'reference'").run();
    // A later decision supersedes the veto: not a candidate at all.
    vetoed('superseded');
    decide('superseded', 'proj_argonaut', { modelDecision: 'orphan', reason: 'no existing project fits' });
    // The same reason on a new-project proposal stays a refusal.
    item('proposal', 'Argonaut metrics proposal', 'MX client metrics plan');
    decide('proposal', 'proj_argonaut', { modelDecision: 'new' });

    expect(await repair().tick(reader())).toEqual({ ran: false });

    for (const id of ['inactive', 'missing', 'container', 'rejected', 'unanchored', 'superseded', 'proposal']) {
      expect(row(id)).toMatchObject({ state: 'orphaned', projectId: null });
    }
    expect(row('owner-placed')).toMatchObject({ state: 'routed', projectId: 'proj_cards' });
    expect(receipt()).toMatchObject({
      placed: 0,
      released: 0,
      pending: [],
      skipped: {
        project_inactive: 1, project_missing: 1, source_container: 1, owner_rejected: 1,
        no_scope_anchor: 1, already_placed: 1, file_reference: 1,
      },
    });
    expect(receipt()!.synthesizedAt).toBeTruthy();
    expect(repair().isDone()).toBe(true);
  });

  it('re-checks at commit, so owner actions taken while it evaluated win', async () => {
    project('proj_weblab', 'Weblab Optimization Tech Approach Review');
    vetoed('rejected-meanwhile');
    vetoed('placed-meanwhile');
    vetoed('archived-meanwhile', { projectId: 'proj_weblab', title: 'Weblab optimization approach.docx', content: 'Weblab optimization tech approach review notes' });
    vetoed('kept');
    let yields = 0;
    const run = createPlacementRepair({
      db: db(), contentStore: contentStore(), brainStore: brainStore(), llm: { isAvailable: () => true },
      // The owner acts after the last candidate passed evaluation.
      yieldToLoop: async () => {
        if (++yields < 4) return;
        db().prepare("INSERT INTO work_item_rejections (work_item_id, project_id) VALUES ('rejected-meanwhile', 'proj_argonaut')").run();
        db().prepare("UPDATE work_items SET process_state = 'routed', project_id = 'proj_cards' WHERE id = 'placed-meanwhile'").run();
        db().prepare("UPDATE projects SET status = 'archived' WHERE id = 'proj_weblab'").run();
      },
    });

    expect(await run.tick(reader())).toMatchObject({ step: 'placed', placed: 1 });

    expect(row('kept')).toMatchObject({ state: 'routed', projectId: 'proj_argonaut' });
    expect(row('rejected-meanwhile')).toMatchObject({ state: 'orphaned', projectId: null });
    expect(row('placed-meanwhile')).toMatchObject({ state: 'routed', projectId: 'proj_cards' });
    expect(row('archived-meanwhile')).toMatchObject({ state: 'orphaned', projectId: null });
    expect(receipt()).toMatchObject({
      skipped: { owner_rejected: 1, already_placed: 1, project_inactive: 1 },
      pending: [{ projectId: 'proj_argonaut', itemIds: ['kept'] }],
    });
  });

  it('releases a quarantined placed item: the alert stays, advisory, and its synthesis is owed', async () => {
    const alert = { titles: ['MX Player Content Cards & Banner Widgets'], dominantTitles: ['MX Player Content Cards & Banner Widgets'], quarantined: true, pass: 'brain' };
    item('held', 'Event contract', 'MX client metrics', { state: 'routed', projectId: 'proj_argonaut', scopeAlert: JSON.stringify(alert) });
    item('advisory', 'Notes', 'MX client metrics', { state: 'routed', projectId: 'proj_argonaut', scopeAlert: JSON.stringify({ ...alert, quarantined: false }) });

    expect(await repair().tick(reader())).toEqual({ ran: true, step: 'placed', placed: 0, released: 1, ownerRestored: 0, projects: 1 });

    expect(JSON.parse(row('held').scopeAlert)).toMatchObject({ ...alert, quarantined: false, releasedAt: expect.any(String) });
    expect(JSON.parse(row('advisory').scopeAlert)).toEqual({ ...alert, quarantined: false });
    expect(receipt()!.pending).toEqual([{ projectId: 'proj_argonaut', itemIds: ['held'] }]);
  });

  it('owes the brain update of the placement an owner request restored before the repair existed', async () => {
    vetoed('contract');
    db().prepare("UPDATE work_items SET process_state = 'routed', project_id = 'proj_argonaut' WHERE id = 'contract'").run();
    db().prepare(`
      INSERT INTO routing_decisions (run_id, batch_id, item_id, model_decision, requested_project_id, applied_decision, applied_project_id, validation_reason)
      VALUES ('owner-request-2026-10-05', ?, 'contract', 'not_called', 'proj_argonaut', 'assign', 'proj_argonaut', 'owner-requested re-placement')
    `).run(OWNER_RESTORED_BATCH_ID);
    // Moved by the owner since: not owed to the old project.
    vetoed('moved');
    db().prepare("UPDATE work_items SET process_state = 'routed', project_id = 'proj_cards' WHERE id = 'moved'").run();
    db().prepare(`
      INSERT INTO routing_decisions (run_id, batch_id, item_id, model_decision, requested_project_id, applied_decision, applied_project_id, validation_reason)
      VALUES ('owner-request-2026-10-05', ?, 'moved', 'not_called', 'proj_argonaut', 'assign', 'proj_argonaut', 'owner-requested re-placement')
    `).run(OWNER_RESTORED_BATCH_ID);

    expect(await repair().tick(reader())).toEqual({ ran: true, step: 'placed', placed: 0, released: 0, ownerRestored: 1, projects: 1 });
    expect(receipt()).toMatchObject({ ownerRestored: 1, pending: [{ projectId: 'proj_argonaut', itemIds: ['contract'] }] });
    const brain = reader();
    expect(await repair().tick(brain)).toMatchObject({ step: 'synthesized', itemIds: ['contract'] });
  });

  it('updates one project brain per tick in chunks of twelve, skips items that left, then is done', async () => {
    project('proj_weblab', 'Weblab Optimization Tech Approach Review');
    const ids = Array.from({ length: 14 }, (_, index) => `a${String(index).padStart(2, '0')}`);
    for (const id of ids) vetoed(id);
    vetoed('w1', { projectId: 'proj_weblab', title: 'Weblab optimization approach.docx', content: 'Weblab optimization tech approach review notes' });
    const brain = reader();
    const run = repair();

    expect(await run.tick(brain)).toMatchObject({ step: 'placed', placed: 15, projects: 2 });
    db().prepare("UPDATE work_items SET project_id = 'proj_cards' WHERE id = 'a13'").run();

    expect(await run.tick(brain)).toEqual({ ran: true, step: 'synthesized', projectId: 'proj_argonaut', itemIds: ids.slice(0, 13), remainingProjects: 1 });
    expect(brain.calls).toEqual([
      { projectId: 'proj_argonaut', itemIds: ids.slice(0, 12) },
      { projectId: 'proj_argonaut', itemIds: ids.slice(12, 13) },
    ]);
    expect(run.isDone()).toBe(false);

    expect(await run.tick(brain)).toMatchObject({ step: 'synthesized', projectId: 'proj_weblab', itemIds: ['w1'], remainingProjects: 0 });
    expect(await run.tick(brain)).toEqual({ ran: false });
    expect(brain.calls).toHaveLength(3);
    expect(run.isDone()).toBe(true);
    expect(receipt()).toMatchObject({ pending: [], synthesis: { updated: 3 }, synthesizedAt: expect.any(String) });
  });

  it('gives a chunk one more try after a model failure, after the rest of the queue', async () => {
    project('proj_weblab', 'Weblab Optimization Tech Approach Review');
    vetoed('contract');
    vetoed('w1', { projectId: 'proj_weblab', title: 'Weblab optimization approach.docx', content: 'Weblab optimization tech approach review notes' });
    vetoed('w2', { projectId: 'proj_weblab', title: 'Weblab SDK follow-up.docx', content: 'Weblab optimization tech approach review follow-up' });
    const calls: string[] = [];
    const failures = new Map([['proj_argonaut', 1], ['proj_weblab', 2]]);
    const flaky = {
      async updateProject(projectId: string, itemIds: string[]): Promise<BrainUpdateResult> {
        calls.push(`${projectId}:${itemIds.join(',')}`);
        const left = failures.get(projectId) ?? 0;
        if (left > 0) {
          failures.set(projectId, left - 1);
          return { projectId, status: 'skipped', skipReason: 'model_failure' };
        }
        return { projectId, status: 'updated' };
      },
    };
    const run = repair();

    await run.tick(flaky);
    for (let tick = 0; tick < 4; tick++) await run.tick(flaky);
    expect(await run.tick(flaky)).toEqual({ ran: false });

    // Argonaut recovers on its retry; Weblab fails twice and is not tried a third time.
    expect(calls).toEqual([
      'proj_argonaut:contract',
      'proj_weblab:w1,w2',
      'proj_argonaut:contract',
      'proj_weblab:w1,w2',
    ]);
    expect(run.isDone()).toBe(true);
    expect(receipt()!.synthesis).toEqual({ 'skipped:model_failure': 3, updated: 1 });
  });

  it('places while the model is down, and waits for it before updating brains', async () => {
    let available = false;
    vetoed('contract');
    const brain = reader();
    const run = repair(() => available);

    expect(await run.tick(brain)).toMatchObject({ step: 'placed', placed: 1 });
    expect(await run.tick(brain)).toEqual({ ran: false });
    expect(brain.calls).toEqual([]);

    available = true;
    expect(await run.tick(brain)).toMatchObject({ step: 'synthesized', itemIds: ['contract'] });
  });

  it('resumes owed brain updates after a restart and never repeats a chunk', async () => {
    const ids = Array.from({ length: 13 }, (_, index) => `a${String(index).padStart(2, '0')}`);
    for (const id of ids) vetoed(id);
    const failing = reader(() => { throw new Error('process stopped mid-update'); });

    expect(await repair().tick(failing)).toMatchObject({ step: 'placed', placed: 13 });
    await expect(repair().tick(failing)).rejects.toThrow('process stopped mid-update');
    expect(receipt()!.pending).toEqual([{ projectId: 'proj_argonaut', itemIds: ids.slice(12) }]);

    const brain = reader();
    expect(await repair().tick(brain)).toMatchObject({ step: 'synthesized', itemIds: ids.slice(12) });
    expect(brain.calls).toEqual([{ projectId: 'proj_argonaut', itemIds: ids.slice(12) }]);
    expect(repair().isDone()).toBe(true);
  });

  it('runs once per store', async () => {
    vetoed('first');
    const brain = reader();
    await repair().tick(brain);
    await repair().tick(brain);
    expect(repair().isDone()).toBe(true);

    vetoed('later');
    expect(await repair().tick(brain)).toEqual({ ran: false });
    expect(row('later')).toMatchObject({ state: 'orphaned', projectId: null });
  });
});
