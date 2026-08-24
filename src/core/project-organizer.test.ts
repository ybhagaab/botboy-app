import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import { createStorage, StorageLayer } from './storage.js';
import { createBrainStore, newBrain } from './brain-store.js';
import { createFailureRecorder } from './failures.js';
import { createProjectOrganizer, listAreasWithProjects } from './project-organizer.js';
import type { PipelineLlm } from './pipeline-llm.js';

describe('ProjectOrganizer', () => {
  let storage: StorageLayer;
  let dir: string;

  beforeEach(() => {
    storage = createStorage(':memory:');
    storage.initialize();
    dir = mkdtempSync(path.join(os.tmpdir(), 'ppt-org-'));
  });
  afterEach(() => {
    storage.close();
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  });

  function seedProjects(titles: string[]) {
    const brains = createBrainStore(storage.getDb(), { brainsDir: path.join(dir, 'brains') });
    const ids: string[] = [];
    titles.forEach((t, i) => {
      const id = `proj_${i}`;
      brains.write({ ...newBrain(id, t), summary: t + ' summary' }, t);
      ids.push(id);
    });
    return { brains, ids };
  }

  const mockLlm = (obj: unknown): PipelineLlm => ({ isAvailable: () => true, complete: async () => JSON.stringify(obj) });

  it('groups projects into new areas and assigns area_id', async () => {
    const { brains, ids } = seedProjects(['Qwen Deploy', 'vLLM Tuning', 'Q3 Hiring']);
    const org = createProjectOrganizer({
      db: storage.getDb(), brainStore: brains, failures: createFailureRecorder(storage.getDb()),
      llm: mockLlm({ areas: [
        { title: 'LLM Infra', description: 'model serving work', projectIds: [ids[0], ids[1]] },
        { title: 'People Ops', description: 'hiring', projectIds: [ids[2]] },
      ] }),
    });
    const r = await org.organize();
    expect(r.areasCreated).toBe(2);
    expect(r.projectsAssigned).toBe(3);

    const tree = listAreasWithProjects(storage.getDb());
    const infra = tree.find((a) => a.title === 'LLM Infra')!;
    expect(infra.projects.map((p) => p.id).sort()).toEqual([ids[0], ids[1]].sort());
    const people = tree.find((a) => a.title === 'People Ops')!;
    expect(people.projects).toHaveLength(1);
  });

  it('reuses an existing area by id instead of duplicating', async () => {
    const { brains, ids } = seedProjects(['A', 'B', 'C']);
    const db = storage.getDb();
    const failures = createFailureRecorder(db);
    // First pass creates areas.
    await createProjectOrganizer({ db, brainStore: brains, failures, llm: mockLlm({ areas: [{ title: 'Area One', projectIds: ids }] }) }).organize();
    const areaId = db.prepare('SELECT id FROM areas LIMIT 1').get() as any;
    // Second pass reuses that area id (full mode — the assign-only default
    // would rightly skip since every project already has an area).
    const r = await createProjectOrganizer({ db, brainStore: brains, failures, llm: mockLlm({ areas: [{ areaId: areaId.id, title: 'Area One', projectIds: ids }] }) }).organize({ full: true });
    expect(r.areasCreated).toBe(0);
    expect(r.areasUpdated).toBe(1);
    expect((db.prepare('SELECT COUNT(*) c FROM areas').get() as any).c).toBe(1);
  });

  it('defers when the LLM is unavailable (no changes)', async () => {
    const { brains } = seedProjects(['A', 'B', 'C']);
    const r = await createProjectOrganizer({ db: storage.getDb(), brainStore: brains, failures: createFailureRecorder(storage.getDb()), llm: { isAvailable: () => false, complete: async () => '' } }).organize();
    expect(r.status).toBe('deferred');
    expect((storage.getDb().prepare('SELECT COUNT(*) c FROM areas').get() as any).c).toBe(0);
  });

  it('skips when there are too few projects to bother grouping', async () => {
    const { brains } = seedProjects(['only one']);
    const r = await createProjectOrganizer({ db: storage.getDb(), brainStore: brains, failures: createFailureRecorder(storage.getDb()), llm: mockLlm({ areas: [] }) }).organize();
    expect(r.status).toBe('skipped');
  });

  // ── Anti-churn contract (post-mortem 2026-08-04: analytics area shuffle) ──

  /** LLM mock that records whether/what it was asked. */
  function trackingLlm(obj: unknown) {
    const state = { called: false, prompt: '' };
    const llm: PipelineLlm = {
      isAvailable: () => true,
      complete: async (p: string) => { state.called = true; state.prompt = p; return JSON.stringify(obj); },
    };
    return { llm, state };
  }

  it('scheduled (assign-only) pass makes NO LLM call when every project is placed', async () => {
    const { brains, ids } = seedProjects(['A', 'B', 'C']);
    const db = storage.getDb();
    const failures = createFailureRecorder(db);
    await createProjectOrganizer({ db, brainStore: brains, failures, llm: mockLlm({ areas: [{ title: 'One', projectIds: ids }] }) }).organize();

    const { llm, state } = trackingLlm({ areas: [] });
    const r = await createProjectOrganizer({ db, brainStore: brains, failures, llm }).organize();

    expect(r.status).toBe('skipped');
    expect(state.called).toBe(false);
  });

  it('assign-only pass places ONLY unassigned projects and cannot move placed ones', async () => {
    const { brains, ids } = seedProjects(['A', 'B', 'C', 'D']);
    const db = storage.getDb();
    const failures = createFailureRecorder(db);
    // Place A/B/C into an area; D stays unsorted.
    await createProjectOrganizer({ db, brainStore: brains, failures, llm: mockLlm({ areas: [{ title: 'One', projectIds: [ids[0], ids[1], ids[2]] }] }) }).organize();
    const areaOne = (db.prepare("SELECT id FROM areas WHERE title='One'").get() as any).id;

    // The LLM tries to grab ALL FOUR projects into a brand-new area.
    const { llm, state } = trackingLlm({ areas: [{ title: 'Grabby New Area', projectIds: ids }] });
    const r = await createProjectOrganizer({ db, brainStore: brains, failures, llm }).organize();

    // Only the unassigned project was in the prompt and only it moved.
    expect(state.prompt).toContain(ids[3]);
    expect(state.prompt).not.toContain(`- ${ids[0]}`);
    expect(r.projectsAssigned).toBe(1);
    const rows = db.prepare('SELECT id, area_id FROM projects ORDER BY id').all() as any[];
    expect(rows.filter((p) => p.area_id === areaOne).map((p) => p.id)).toEqual([ids[0], ids[1], ids[2]]);
    expect(rows.find((p) => p.id === ids[3])!.area_id).not.toBe(areaOne);
  });

  it('full pass anchors the prompt with current areas and records a pipeline run', async () => {
    const { brains, ids } = seedProjects(['A', 'B', 'C']);
    const db = storage.getDb();
    const failures = createFailureRecorder(db);
    await createProjectOrganizer({ db, brainStore: brains, failures, llm: mockLlm({ areas: [{ title: 'One', projectIds: ids }] }) }).organize();

    const { llm, state } = trackingLlm({ areas: [{ title: 'One', projectIds: ids }] });
    await createProjectOrganizer({ db, brainStore: brains, failures, llm }).organize({ full: true });

    // The full pass receives the CURRENT HIERARCHY (area header + members with
    // growth signals) and the explicit evolution rules.
    expect(state.prompt).toContain('CURRENT HIERARCHY');
    expect(state.prompt).toMatch(/## area_\w+\s+"One"/);
    expect(state.prompt).toContain(`- ${ids[0]}  "A"`);
    expect(state.prompt).toContain('no items yet');
    expect(state.prompt).toContain('STABILITY FIRST');
    expect(state.prompt).toContain('PROMOTE');
    expect(state.prompt).toContain('MERGE');
    const runs = db.prepare("SELECT pass, batch_id, status FROM pipeline_runs WHERE pass='organize' ORDER BY started_at").all() as any[];
    expect(runs.length).toBeGreaterThanOrEqual(2);
    expect(runs[runs.length - 1].batch_id).toBe('full');
    expect(runs.every((r) => r.status === 'completed')).toBe(true);
  });

  it('listAreasWithProjects buckets unassigned projects under Unsorted', async () => {
    const { brains } = seedProjects(['X', 'Y']);
    const tree = listAreasWithProjects(storage.getDb());
    expect(tree).toHaveLength(1);
    expect(tree[0].title).toBe('Unsorted');
    expect(tree[0].projects).toHaveLength(2);
  });
});
