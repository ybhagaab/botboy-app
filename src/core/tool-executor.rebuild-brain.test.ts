import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createStorage, type StorageLayer } from './storage.js';
import { createNodeManager } from './node-manager.js';
import { createToolExecutor, type ToolExecutor } from './tool-executor.js';
import { createPromptManager } from './prompt-manager.js';

function call(executor: ToolExecutor, args: Record<string, unknown>) {
  return executor.executeTool({
    id: 'rebuild-call',
    type: 'function',
    function: { name: 'rebuild_brain', arguments: JSON.stringify(args) },
  } as any);
}

describe('rebuild_brain owner-attestation boundary', () => {
  let storage: StorageLayer;
  let executor: ToolExecutor;
  const fetchMock = vi.fn().mockResolvedValue({ ok: true });

  beforeEach(() => {
    storage = createStorage(':memory:');
    storage.initialize();
    executor = createToolExecutor(storage.getDb(), createNodeManager(storage.getDb()));
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    storage.close();
  });

  it('refuses an inferred or automatic rebuild without ownerRequested=true', async () => {
    const result = await call(executor, { projectId: 'proj_critical' });
    expect(result.content).toContain('ownerRequested must be true');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('starts only the exact owner-authorized project rebuild', async () => {
    const result = await call(executor, { projectId: 'proj_critical', ownerRequested: true });
    expect(result.content).toContain('owner-authorized rebuild started');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain('/pipeline/rebuild-brains');
    expect(JSON.parse(String(init.body))).toEqual({ projectId: 'proj_critical', ownerRequested: true });
  });

  it('publishes ownerRequested as a required tool-schema attestation', () => {
    const definition = createPromptManager().getToolDefinitions('chat')
      .find((tool) => tool.function.name === 'rebuild_brain');
    expect(definition?.function.parameters.required).toEqual(['projectId', 'ownerRequested']);
    expect(definition?.function.description).toContain('evidence curation alone is not authorization');
  });
});
