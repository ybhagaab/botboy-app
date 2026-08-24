import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createStorage, StorageLayer } from './storage.js';
import { createNodeManager, NodeManager } from './node-manager.js';

describe('NodeManager', () => {
  let storage: StorageLayer;
  let nm: NodeManager;

  beforeEach(() => {
    storage = createStorage(':memory:');
    storage.initialize();
    nm = createNodeManager(storage.getDb());
  });

  afterEach(() => storage.close());

  // Helper: insert a work item directly
  function insertWorkItem(id: string, type = 'website_visit', source = 'browser') {
    storage.getDb().prepare(
      "INSERT INTO work_items (id, type, source, title, captured_at) VALUES (?, ?, ?, ?, datetime('now'))"
    ).run(id, type, source, `Item ${id}`);
  }

  it('creates a node with title and description', () => {
    const node = nm.createNode('Feature A', 'Working on feature A');
    expect(node.title).toBe('Feature A');
    expect(node.description).toBe('Working on feature A');
    expect(node.status).toBe('active');
    expect(node.id).toBeTruthy();
  });

  it('lists active and archived nodes separately', () => {
    const n1 = nm.createNode('Active');
    const n2 = nm.createNode('To Archive');
    nm.archiveNode(n2.id);

    expect(nm.listNodes('active')).toHaveLength(1);
    expect(nm.listNodes('archived')).toHaveLength(1);
    expect(nm.listNodes()).toHaveLength(2);
  });

  it('archive-reactivate round trip preserves associations', () => {
    const node = nm.createNode('Round Trip');
    insertWorkItem('w1');
    insertWorkItem('w2');
    nm.addWorkItemToNode('w1', node.id);
    nm.addWorkItemToNode('w2', node.id);

    nm.archiveNode(node.id);
    expect(nm.getNode(node.id)!.status).toBe('archived');
    expect(nm.getNodeWorkItems(node.id)).toHaveLength(2);

    nm.reactivateNode(node.id);
    expect(nm.getNode(node.id)!.status).toBe('active');
    expect(nm.getNodeWorkItems(node.id)).toHaveLength(2);
  });

  it('deleting a node removes associations but keeps work items', () => {
    const node = nm.createNode('Delete Me');
    insertWorkItem('w1');
    nm.addWorkItemToNode('w1', node.id);

    nm.deleteNode(node.id);
    expect(nm.getNode(node.id)).toBeNull();

    // Work item still exists
    const row = storage.getDb().prepare('SELECT * FROM work_items WHERE id = ?').get('w1');
    expect(row).toBeDefined();
  });

  it('removing a work item from a node preserves the work item', () => {
    const node = nm.createNode('Node');
    insertWorkItem('w1');
    nm.addWorkItemToNode('w1', node.id);
    nm.removeWorkItemFromNode('w1', node.id);

    expect(nm.getNodeWorkItems(node.id)).toHaveLength(0);
    const row = storage.getDb().prepare('SELECT * FROM work_items WHERE id = ?').get('w1');
    expect(row).toBeDefined();
  });

  it('supports shared work items across nodes without duplication', () => {
    const n1 = nm.createNode('Node A');
    const n2 = nm.createNode('Node B');
    insertWorkItem('w1');
    nm.addWorkItemToNode('w1', n1.id);
    nm.addWorkItemToNode('w1', n2.id);

    // One work item record, two associations
    const wiCount = storage.getDb().prepare('SELECT COUNT(*) as c FROM work_items WHERE id = ?').get('w1') as any;
    expect(wiCount.c).toBe(1);

    const assocCount = storage.getDb().prepare('SELECT COUNT(*) as c FROM node_work_items WHERE work_item_id = ?').get('w1') as any;
    expect(assocCount.c).toBe(2);

    // Both nodes returned for the work item
    const nodes = nm.getWorkItemNodes('w1');
    expect(nodes).toHaveLength(2);
  });

  it('returns correct item counts per node', () => {
    const node = nm.createNode('Counted');
    insertWorkItem('w1');
    insertWorkItem('w2');
    insertWorkItem('w3');
    nm.addWorkItemToNode('w1', node.id);
    nm.addWorkItemToNode('w2', node.id);

    expect(nm.getNodeItemCount(node.id)).toBe(2);
  });

  it('returns work items in chronological order', () => {
    const db = storage.getDb();
    const node = nm.createNode('Ordered');
    db.prepare("INSERT INTO work_items (id, type, source, captured_at) VALUES (?, ?, ?, ?)").run('w1', 'website_visit', 'browser', '2026-03-20T10:00:00Z');
    db.prepare("INSERT INTO work_items (id, type, source, captured_at) VALUES (?, ?, ?, ?)").run('w2', 'website_visit', 'browser', '2026-03-20T08:00:00Z');
    db.prepare("INSERT INTO work_items (id, type, source, captured_at) VALUES (?, ?, ?, ?)").run('w3', 'website_visit', 'browser', '2026-03-20T12:00:00Z');
    nm.addWorkItemToNode('w1', node.id);
    nm.addWorkItemToNode('w2', node.id);
    nm.addWorkItemToNode('w3', node.id);

    const items = nm.getNodeWorkItems(node.id);
    expect(items[0].id).toBe('w2'); // 08:00
    expect(items[1].id).toBe('w1'); // 10:00
    expect(items[2].id).toBe('w3'); // 12:00
  });

  it('creates a manual work item', () => {
    const wi = nm.createManualWorkItem({ title: 'Manual Note', description: 'Some desc', url: 'https://example.com' });
    expect(wi.title).toBe('Manual Note');
    expect(wi.source).toBe('manual');
    expect(wi.url).toBe('https://example.com');
  });

  it('detects node connections via shared work items', () => {
    const n1 = nm.createNode('A');
    const n2 = nm.createNode('B');
    insertWorkItem('w1');
    insertWorkItem('w2');
    nm.addWorkItemToNode('w1', n1.id);
    nm.addWorkItemToNode('w1', n2.id);
    nm.addWorkItemToNode('w2', n1.id);
    nm.addWorkItemToNode('w2', n2.id);

    const connections = nm.getNodeConnections();
    expect(connections).toHaveLength(1);
    expect(connections[0].sharedWorkItemIds).toHaveLength(2);
  });

  it('lists unassigned work items', () => {
    insertWorkItem('w1');
    insertWorkItem('w2');
    const node = nm.createNode('Assigned');
    nm.addWorkItemToNode('w1', node.id);

    const unassigned = nm.getUnassignedWorkItems();
    expect(unassigned).toHaveLength(1);
    expect(unassigned[0].id).toBe('w2');
  });

  it('updates a node title and description', () => {
    const node = nm.createNode('Old Title', 'Old Desc');
    const updated = nm.updateNode(node.id, { title: 'New Title', description: 'New Desc' });
    expect(updated.title).toBe('New Title');
    expect(updated.description).toBe('New Desc');
  });
});
