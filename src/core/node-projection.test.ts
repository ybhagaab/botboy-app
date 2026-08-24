import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createStorage, StorageLayer } from './storage.js';
import { syncNodesFromProjects } from './node-projection.js';

describe('syncNodesFromProjects', () => {
  let storage: StorageLayer;

  beforeEach(() => {
    storage = createStorage(':memory:');
    storage.initialize();
  });
  afterEach(() => storage.close());

  function seed() {
    const db = storage.getDb();
    db.prepare("INSERT INTO areas (id, title, description) VALUES ('area_1','Infra','infra work')").run();
    db.prepare("INSERT INTO projects (id, title, one_liner, brain_path, status, area_id) VALUES ('proj_a','Qwen Deploy','deploy','/x', 'active','area_1')").run();
    db.prepare("INSERT INTO projects (id, title, one_liner, brain_path, status, area_id) VALUES ('proj_b','Loose Project','loose','/y','active',NULL)").run();
    // items routed to proj_a
    for (const i of ['w1', 'w2']) {
      db.prepare("INSERT INTO work_items (id,type,source,captured_at,project_id,process_state) VALUES (?,'slack_message','slack','2026-07-08T10:00:00Z','proj_a','routed')").run(i);
    }
    // a legacy archived node must be left untouched
    db.prepare("INSERT INTO nodes (id,title,status) VALUES ('legacy-uuid','Old Node','archived')").run();
  }

  it('mirrors areas→root nodes, projects→child nodes, and links items', () => {
    seed();
    const db = storage.getDb();
    const r = syncNodesFromProjects(db);
    expect(r.areaNodes).toBe(2); // Infra + Unsorted (for proj_b)
    expect(r.projectNodes).toBe(2);
    expect(r.itemLinks).toBe(2);

    // area is a root node
    const infra = db.prepare("SELECT * FROM nodes WHERE id='area_1'").get() as any;
    expect(infra.parent_id).toBeNull();
    // project is a child of its area
    const pa = db.prepare("SELECT * FROM nodes WHERE id='proj_a'").get() as any;
    expect(pa.parent_id).toBe('area_1');
    // loose project under Unsorted
    const pb = db.prepare("SELECT parent_id FROM nodes WHERE id='proj_b'").get() as any;
    expect(pb.parent_id).toBe('node_unsorted');
    // items linked to proj_a node
    const links = db.prepare("SELECT COUNT(*) c FROM node_work_items WHERE node_id='proj_a'").get() as any;
    expect(links.c).toBe(2);
  });

  it('is idempotent and never touches legacy (non-mirror) nodes', () => {
    seed();
    const db = storage.getDb();
    syncNodesFromProjects(db);
    syncNodesFromProjects(db); // second run
    // exactly one set of mirror nodes
    expect((db.prepare("SELECT COUNT(*) c FROM nodes WHERE id LIKE 'area_%' OR id LIKE 'proj_%' OR id='node_unsorted'").get() as any).c).toBe(4);
    // legacy node survives
    expect((db.prepare("SELECT COUNT(*) c FROM nodes WHERE id='legacy-uuid'").get() as any).c).toBe(1);
  });

  it('drops mirror nodes for projects that no longer exist', () => {
    seed();
    const db = storage.getDb();
    syncNodesFromProjects(db);
    db.prepare("DELETE FROM projects WHERE id='proj_b'").run();
    syncNodesFromProjects(db);
    expect((db.prepare("SELECT COUNT(*) c FROM nodes WHERE id='proj_b'").get() as any).c).toBe(0);
  });
});
