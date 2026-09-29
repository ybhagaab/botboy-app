import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createStorage, type StorageLayer } from './storage.js';
import { createAnalyticsDashboardService } from './analytics-dashboard.js';
import type { AnalyticsDashboardService } from './analytics-types.js';
import type { McpManager } from './mcp-manager.js';

/**
 * SQL widget queries have no total time limit (owner 2026-09-29): the
 * connector call is bounded by an idle window that progress restarts. The
 * scheduler's recovery requeues any run whose lease has lapsed, so the run
 * must keep renewing its lease while a query is in flight; otherwise a long
 * query would be started a second time.
 */
describe('dashboard run lease during a long widget query', () => {
  let storage: StorageLayer;
  let service: AnalyticsDashboardService;
  let calls = 0;
  let release: () => void = () => {};
  let inFlight: Promise<void>;
  let markInFlight: () => void = () => {};

  function fakeMcp(): McpManager {
    const sqlServer = {
      id: 'sql-context', kind: 'managed', displayName: 'sql-context', enabled: true,
      configured: true, state: 'running', packageVersion: '1', restartCount: 0,
      lastHealthyAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      tools: ['connection_status', 'run_query'].map(name => ({ name, inputSchema: {}, risk: 'read' })),
    } as any;
    const gate = new Promise<void>(resolve => { release = resolve; });
    return {
      listServers: async () => [sqlServer],
      getServer: async (id: string) => id === 'sql-context' ? sqlServer : null,
      testConnection: async () => ({ isError: false, text: 'Connected\n', serverId: 'sql-context', toolName: 'connection_status', durationMs: 1 }),
      callTool: async () => {
        calls += 1;
        markInFlight();
        await gate;
        return { isError: false, text: 'value\n-----\n42\n\n1 rows returned. (3ms)' };
      },
    } as unknown as McpManager;
  }

  beforeEach(() => {
    vi.useFakeTimers({ now: new Date('2026-09-29T04:00:00.000Z') });
    storage = createStorage(':memory:');
    storage.initialize();
    calls = 0;
    inFlight = new Promise<void>(resolve => { markInFlight = resolve; });
    // Smallest idle window, so the lease (window + 60 s) lapses in 90 s.
    service = createAnalyticsDashboardService({ db: storage.getDb(), mcpManager: fakeMcp(), queryTimeoutMs: 30_000 });
  });
  afterEach(() => {
    vi.useRealTimers();
    storage.close();
  });

  it('renews the lease so recovery never requeues a run whose query is still running', async () => {
    const dashboard = service.createDashboard({
      title: 'Slow warehouse', widgets: [{ kind: 'metric', title: 'Total', sql: 'SELECT 42 AS value' }],
    } as any);
    const run = service.enqueueRefresh(dashboard.id, 'manual');
    const processing = service.processQueuedRuns(1);
    await inFlight;

    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(service.recoverInterruptedRuns()).toBe(0);
    expect(service.getRun(run.id)?.status).toBe('running');

    release();
    await vi.advanceTimersByTimeAsync(1);
    await processing;
    expect(service.getRun(run.id)?.status).toBe('completed');
    expect(calls).toBe(1);
  });
});
