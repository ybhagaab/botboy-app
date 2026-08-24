import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createStorage, type StorageLayer } from './storage.js';
import { createNodeManager, type NodeManager } from './node-manager.js';
import { createToolExecutor, type ToolExecutor } from './tool-executor.js';

/**
 * Node-placement guardrails (post-mortem 2026-08-04):
 * the chat model fabricated a nodeId ("proj_" welded onto an area id suffix)
 * and the old `catch {}` in create_item reported the assignment as done.
 *
 * Contract under test:
 *   - nodeIds must exist — fabricated ids are rejected with an instructive
 *     error, and the tool result says the item was NOT assigned
 *   - container nodes (areas / parents with children) are refused for items
 *   - valid leaf placements succeed and are reported with the real node title
 *   - omitting nodeId is legal and reported as "librarian will file it"
 */

function call(executor: ToolExecutor, name: string, args: Record<string, unknown>) {
  return executor.executeTool({
    id: 't1',
    type: 'function',
    function: { name, arguments: JSON.stringify(args) },
  } as any);
}

describe('item placement guardrails', () => {
  let storage: StorageLayer;
  let db: Database.Database;
  let nm: NodeManager;
  let executor: ToolExecutor;
  let areaId: string;
  let projectId: string;

  beforeEach(() => {
    storage = createStorage(':memory:');
    storage.initialize();
    db = storage.getDb();
    nm = createNodeManager(db);
    executor = createToolExecutor(db, nm);
    // area (container, has a child) → project (leaf where items belong)
    const area = nm.createNode('Analytics Area', 'container');
    const project = nm.createChildNode(area.id, 'AV-GCCP Financial Metrics Analysis', 'weblab project');
    areaId = area.id;
    projectId = project.id;
  });

  afterEach(() => {
    storage.close();
  });

  it('create_item with a fabricated nodeId creates the item but reports NOT assigned', async () => {
    const result = await call(executor, 'create_item', {
      title: 'weblab follow-up',
      content: 'x',
      nodeId: 'proj_doesnotexist',
    });
    const parsed = JSON.parse(result.content);
    expect(parsed.node).toBeNull();
    expect(parsed.placement).toContain('NOT assigned');
    expect(parsed.placement).toContain('does not exist');
    // Item exists but has zero node links — no silent fake success.
    const links = db.prepare('SELECT COUNT(*) c FROM node_work_items WHERE work_item_id = ?').get(parsed.id) as any;
    expect(links.c).toBe(0);
  });

  it('create_item refuses container (area) nodes and says so', async () => {
    const result = await call(executor, 'create_item', {
      title: 'weblab follow-up 2',
      content: 'x',
      nodeId: areaId,
    });
    const parsed = JSON.parse(result.content);
    expect(parsed.node).toBeNull();
    expect(parsed.placement).toContain('container');
    const links = db.prepare('SELECT COUNT(*) c FROM node_work_items WHERE work_item_id = ?').get(parsed.id) as any;
    expect(links.c).toBe(0);
  });

  it('create_item with a valid project node assigns and reports the real node', async () => {
    const result = await call(executor, 'create_item', {
      title: 'weblab follow-up 3',
      content: 'x',
      nodeId: projectId,
    });
    const parsed = JSON.parse(result.content);
    expect(parsed.node).toEqual({ id: projectId, title: 'AV-GCCP Financial Metrics Analysis' });
    const links = db.prepare('SELECT node_id FROM node_work_items WHERE work_item_id = ?').all(parsed.id) as any[];
    expect(links.map((l) => l.node_id)).toEqual([projectId]);
  });

  it('create_item without nodeId reports the librarian will file it', async () => {
    const result = await call(executor, 'create_item', { title: 'unfiled note', content: 'x' });
    const parsed = JSON.parse(result.content);
    expect(parsed.node).toBeNull();
    expect(parsed.placement).toContain('librarian');
  });

  it('assign_item rejects fabricated and container ids, accepts the project', async () => {
    const created = JSON.parse((await call(executor, 'create_item', { title: 'n', content: 'x' })).content);

    const bogus = await call(executor, 'assign_item', { itemId: created.id, nodeId: 'proj_nope' });
    expect(bogus.content).toContain('does not exist');

    const container = await call(executor, 'assign_item', { itemId: created.id, nodeId: areaId });
    expect(container.content).toContain('container');

    const ok = await call(executor, 'assign_item', { itemId: created.id, nodeId: projectId });
    expect(ok.content).toContain('OK');
    expect(ok.content).toContain('AV-GCCP');
  });

  it('update_item reports NOT assigned for invalid ids instead of silently dropping', async () => {
    const created = JSON.parse((await call(executor, 'create_item', { title: 'm', content: 'x' })).content);
    const result = await call(executor, 'update_item', { itemId: created.id, nodeId: 'proj_fake' });
    const parsed = JSON.parse(result.content);
    expect(parsed.placement).toContain('NOT assigned');
    expect(parsed.currentNodes).toEqual([]);
  });
});
