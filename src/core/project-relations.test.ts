import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createStorage, StorageLayer } from './storage.js';
import { createProjectRelationsEngine, ProjectRelationsEngine } from './project-relations.js';

/**
 * Related-projects engine: deterministic sibling links between DISTINCT
 * projects whose scopes touch. Regression origin: two WebLab projects split
 * one story — meeting evidence enriched one while the owner watched the other
 * go stale, with no surface anywhere saying the sibling existed.
 */
describe('project relations engine', () => {
  let storage: StorageLayer;
  let engine: ProjectRelationsEngine;

  beforeEach(() => {
    storage = createStorage(':memory:');
    storage.initialize();
    engine = createProjectRelationsEngine(storage.getDb());
  });
  afterEach(() => storage.close());

  function addProject(id: string, title: string, foundingScope: string | null = null, status = 'active'): void {
    storage.getDb().prepare(
      'INSERT INTO projects (id, title, one_liner, status, founding_scope, brain_path) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(id, title, title.slice(0, 60), status, foundingScope, `/tmp/${id}.md`);
  }

  function addItemWithAlert(id: string, projectId: string, alert: { titles: string[]; quarantined: boolean }): void {
    storage.getDb().prepare(`
      INSERT INTO work_items (id, type, source, title, parsed_text, project_id, scope_alert, captured_at)
      VALUES (?, 'note', 'manual', ?, 'body', ?, ?, datetime('now'))
    `).run(id, `item ${id}`, projectId, JSON.stringify({
      titles: alert.titles,
      dominantTitles: alert.quarantined ? alert.titles : [],
      quarantined: alert.quarantined,
      detectedAt: new Date().toISOString(),
      pass: 'brain',
    }));
  }

  it('links two projects when advisory mixed-scope evidence references both', () => {
    addProject('proj_a', 'WebLab Measurement & APT Enablement');
    addProject('proj_b', 'Weblab Optimization Tech Approach Review');
    addItemWithAlert('it1', 'proj_a', { titles: ['Weblab Optimization Tech Approach Review'], quarantined: false });

    const result = engine.recompute();
    expect(result.pairs).toBe(1);

    const fromA = engine.listForProject('proj_a');
    expect(fromA).toHaveLength(1);
    expect(fromA[0].id).toBe('proj_b');
    expect(fromA[0].reasons.join(' ')).toContain('reference');
    // Symmetric: the sibling sees it too.
    expect(engine.listForProject('proj_b')[0]?.id).toBe('proj_a');
  });

  it('links titles sharing a rare distinctive token, but not broad family vocabulary', () => {
    addProject('proj_a', 'WebLab Measurement & APT Enablement');
    addProject('proj_b', 'Weblab Optimization Tech Approach Review');
    // A "fatafat" family of five: family word alone must not link every pair.
    for (let i = 1; i <= 5; i++) addProject(`proj_f${i}`, `Fatafat Surface ${i} Delivery`);

    engine.recompute();

    const webLab = engine.listForProject('proj_a');
    expect(webLab.map((r) => r.id)).toEqual(['proj_b']);
    expect(webLab[0].reasons.join(' ')).toContain('weblab');
    expect(engine.listForProject('proj_f1')).toHaveLength(0);
  });

  it('a shared ambient channel alone stays below the relation threshold', () => {
    addProject('proj_a', 'Screening Room Audience Simulation');
    addProject('proj_b', 'Argonaut DRM Re-Ingestion');
    const insert = storage.getDb().prepare(`
      INSERT INTO project_cross_links (project_id, channel_id, channel_name, topic, reason)
      VALUES (?, 'C123', 'sg-pms', ?, 'anchor')
    `);
    insert.run('proj_a', 'topic one');
    insert.run('proj_b', 'topic two');

    const result = engine.recompute();
    expect(result.pairs).toBe(0);
  });

  it('resolves alert titles against founding scope when the display title has drifted', () => {
    addProject('proj_a', 'Measurement Program (Renamed)', null);
    addProject('proj_b', 'Drifted New Title', 'Original Sibling Scope Name');
    addItemWithAlert('it1', 'proj_a', { titles: ['Original Sibling Scope Name'], quarantined: false });

    engine.recompute();
    expect(engine.listForProject('proj_a')[0]?.id).toBe('proj_b');
  });

  it('owner dismissal survives recomputes and hides the pair from both sides', () => {
    addProject('proj_a', 'WebLab Measurement & APT Enablement');
    addProject('proj_b', 'Weblab Optimization Tech Approach Review');
    addItemWithAlert('it1', 'proj_a', { titles: ['Weblab Optimization Tech Approach Review'], quarantined: false });

    engine.recompute();
    expect(engine.dismiss('proj_b', 'proj_a')).toBe(true); // either side may dismiss
    expect(engine.listForProject('proj_a')).toHaveLength(0);
    expect(engine.listForProject('proj_b')).toHaveLength(0);

    engine.recompute(); // detection unchanged — veto must persist
    expect(engine.listForProject('proj_a')).toHaveLength(0);

    expect(engine.restore('proj_a', 'proj_b')).toBe(true);
    expect(engine.listForProject('proj_a')).toHaveLength(1);
  });

  it('removes pairs that are no longer detected', () => {
    addProject('proj_a', 'Alpha Ingestion Redesign');
    addProject('proj_b', 'Beta Playback Recovery');
    addItemWithAlert('it1', 'proj_a', { titles: ['Beta Playback Recovery'], quarantined: false });

    expect(engine.recompute().pairs).toBe(1);
    storage.getDb().prepare('UPDATE work_items SET scope_alert = NULL WHERE id = ?').run('it1');
    const second = engine.recompute();
    expect(second.pairs).toBe(0);
    expect(second.removed).toBe(1);
    expect(engine.listForProject('proj_a')).toHaveLength(0);
  });

  it('quarantined-only alerts hint too weakly to link a pair by themselves', () => {
    addProject('proj_a', 'Alpha Ingestion Redesign');
    addProject('proj_b', 'Beta Playback Recovery');
    addItemWithAlert('it1', 'proj_a', { titles: ['Beta Playback Recovery'], quarantined: true });

    expect(engine.recompute().pairs).toBe(0);
  });
});
