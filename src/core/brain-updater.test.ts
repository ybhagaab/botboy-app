import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'fs';
import os from 'os';
import path from 'path';
import { createStorage, StorageLayer } from './storage.js';
import { createContentStore, refToColumns } from './content-store.js';
import { createBrainStore, newBrain, Brain } from './brain-store.js';
import { createFailureRecorder } from './failures.js';
import { createBrainUpdater } from './brain-updater.js';
import type { PipelineLlm } from './pipeline-llm.js';

describe('BrainUpdater', () => {
  let storage: StorageLayer;
  let dir: string;
  let brainsDir: string;

  beforeEach(() => {
    storage = createStorage(':memory:');
    storage.initialize();
    dir = mkdtempSync(path.join(os.tmpdir(), 'ppt-bu-'));
    brainsDir = path.join(dir, 'brains');
  });
  afterEach(() => {
    storage.close();
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  });

  function insertRouted(id: string, title: string, content: string, projectId: string, batchId: string) {
    const db = storage.getDb();
    const cs = createContentStore(db, { contentDir: dir, inlineThresholdBytes: 1024 });
    const ref = cs.put(id, content);
    const cols = refToColumns(ref);
    db.prepare(
      `INSERT INTO work_items (id, type, source, title, captured_at, process_state, project_id, batch_id, raw_text, content_storage, content_path, content_sha256, content_bytes, metadata)
       VALUES (?, 'slack_message', 'slack', ?, '2026-07-08T10:00:00Z', 'routed', ?, ?, ?, ?, ?, ?, ?, '{"direction":"sent","channelType":"dm"}')`,
    ).run(id, title, projectId, batchId, cols.raw_text, cols.content_storage, cols.content_path, cols.content_sha256, cols.content_bytes);
  }

  function build(llm: PipelineLlm) {
    const db = storage.getDb();
    const brains = createBrainStore(db, { brainsDir });
    const updater = createBrainUpdater({
      db,
      contentStore: createContentStore(db, { contentDir: dir, inlineThresholdBytes: 1024 }),
      brainStore: brains,
      failures: createFailureRecorder(db),
      llm,
    });
    return { brains, updater };
  }

  const mockLlm = (obj: unknown): PipelineLlm => ({
    isAvailable: () => true,
    complete: async () => JSON.stringify(obj),
  });

  it('P7: appends new activity, never dropping prior log history', async () => {
    const { brains, updater } = build(
      mockLlm({
        summary: 'updated summary',
        statusLine: '🔴 blocked',
        tasks: [{
          state: 'doing',
          text: 'fix it',
          evidenceItemId: 'i1',
          evidenceQuote: 'I will fix it',
          actionBasis: 'explicit_commitment',
          confidence: 0.95,
        }],
        blockers: ['prod 500'],
        people: ['anmol'],
        newActivity: ['09:20 new event B', '09:25 new event C'],
      }),
    );
    // Seed a brain that already has one activity line.
    const seed: Brain = { ...newBrain('proj_x', 'Incident Remediation'), activityLog: ['09:00 old event A'] };
    brains.write(seed);

    insertRouted('i1', 'msg', 'Incident remediation: I will fix it', 'proj_x', 'batch1');
    const res = await updater.runForBatch('batch1');
    expect(res[0].status).toBe('updated');

    const after = brains.read('proj_x')!;
    expect(after.activityLog).toContain('09:00 old event A'); // preserved verbatim
    // New lines carry the evidence capture day (chronology, 2026-08-21).
    expect(after.activityLog).toContain('2026-07-08 — 09:20 new event B');
    expect(after.activityLog).toContain('2026-07-08 — 09:25 new event C');
    expect(after.summary).toBe('updated summary');
    expect(after.tasks[0].text).toBe('fix it');
    expect(after.tasks[0].date).toBe('2026-07-08'); // dated by citing evidence
  });

  it('P8: does not overwrite a hand-edited brain; writes a .conflict sidecar', async () => {
    const { brains, updater } = build(mockLlm({ summary: 'auto update', newActivity: ['x'] }));
    brains.write(newBrain('proj_y', 'Content Review'));

    // Simulate the user editing the brain file directly (checksum now differs).
    const brainPath = brains.brainPathFor('proj_y');
    writeFileSync(brainPath, '---\nid: proj_y\ntitle: Content Review\nstatus: active\npeople: []\nupdated: x\n---\n## Summary\nMY MANUAL EDIT\n', 'utf8');

    insertRouted('i1', 'msg', 'content review', 'proj_y', 'batch2');
    const res = await updater.runForBatch('batch2');
    expect(res[0].status).toBe('conflict');

    // The user's file is untouched; the proposed update is in the sidecar.
    const onDisk = brains.read('proj_y')!;
    expect(onDisk.summary).toBe('MY MANUAL EDIT');
    expect(existsSync(brainPath + '.conflict')).toBe(true);
  });

  it('flags evidence with an identifying foreign-scope anchor; ordinary word overlap stays clean (scope integrity, 2026-08-21)', async () => {
    const { brains, updater } = build(mockLlm({ summary: 'updated summary', newActivity: [] }));
    brains.write(newBrain('proj_home', 'Incident Remediation'));
    brains.write(newBrain('proj_far', 'PV-AMXP Unification Review'));

    // The foreign project's identifying compound token appears in the item
    // TITLE (like a misfiled document's filename) — flag and quarantine.
    insertRouted('bad', 'PV-AMXP plan notes', 'Incident remediation notes also covering the PV-AMXP unification plan', 'proj_home', 'batchQ');
    // Shares only ordinary words ("review") with the foreign title — clean.
    insertRouted('ok', 'msg', 'Incident remediation review update', 'proj_home', 'batchQ');
    // One passing mid-content mention of the foreign identifier is
    // boilerplate-grade evidence and must NOT trip the quarantine.
    insertRouted('passing', 'msg', 'Incident remediation status: unrelated thread once mentioned PV-AMXP in passing', 'proj_home', 'batchQ');

    const res = await updater.runForBatch('batchQ');
    expect(res[0].status).toBe('updated');

    const db = storage.getDb();
    const bad = db.prepare('SELECT scope_alert FROM work_items WHERE id = ?').get('bad') as any;
    const ok = db.prepare('SELECT scope_alert FROM work_items WHERE id = ?').get('ok') as any;
    const passing = db.prepare('SELECT scope_alert FROM work_items WHERE id = ?').get('passing') as any;
    expect(bad.scope_alert).toBeTruthy();
    const alert = JSON.parse(bad.scope_alert);
    expect(alert.titles).toContain('PV-AMXP Unification Review');
    // The foreign anchor does not dominate the item's own home anchor, so it
    // is advisory: flagged for the owner but still synthesized.
    expect(alert.quarantined).toBe(false);
    expect(ok.scope_alert).toBeNull();
    expect(passing.scope_alert).toBeNull();
  });

  it('records a failure and skips on unparseable LLM output', async () => {
    const { brains, updater } = build({ isAvailable: () => true, complete: async () => 'not json at all' });
    brains.write(newBrain('proj_z', 'Content Parsing'));
    insertRouted('i1', 'msg', 'content parsing', 'proj_z', 'batch3');
    const res = await updater.runForBatch('batch3');
    expect(res[0].status).toBe('skipped');
    const fail = storage.getDb().prepare("SELECT * FROM failures WHERE step = 'brain'").get() as any;
    expect(fail).toBeTruthy();
  });
});
