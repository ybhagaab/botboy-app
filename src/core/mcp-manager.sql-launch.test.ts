import { afterEach, describe, expect, it, vi } from 'vitest';
import { createStorage, type StorageLayer } from './storage.js';
import { createMcpManager } from './mcp-manager.js';
import type { SqlContextPackageResolver } from './sql-context-package.js';

/**
 * The sql-context launch may first install a connector update from npm. The
 * launcher's receipt-bound shutdown gives the MCP stage 10 seconds, and the
 * manager's stop waits for in-progress starts, so a download must be cut off
 * by stop instead of holding shutdown open (which would turn a clean receipt
 * into a forced one).
 */
describe('sql-context launch preparation and shutdown', () => {
  let storage: StorageLayer | null = null;
  afterEach(() => {
    storage?.close();
    storage = null;
  });

  it('stops promptly while a connector update is still installing', async () => {
    storage = createStorage(':memory:');
    storage.initialize();
    const secrets = new Map<string, string>();
    const secretStore = {
      async get(id: string, key: string) { return secrets.get(`${id}:${key}`) ?? null; },
      async set(id: string, key: string, value: string) { secrets.set(`${id}:${key}`, value); },
      async delete(id: string, key: string) { secrets.delete(`${id}:${key}`); },
      async has(id: string, key: string) { return secrets.has(`${id}:${key}`); },
    };
    let seenSignal: AbortSignal | undefined;
    let installing!: () => void;
    const started = new Promise<void>(resolve => { installing = resolve; });
    // Like the real resolver: a slow install that ends when the signal aborts,
    // then falls back to a local copy.
    const sqlContextPackages: SqlContextPackageResolver = {
      resolveLaunch: vi.fn(async ({ signal } = {}) => {
        seenSignal = signal;
        installing();
        await new Promise<void>(resolve => {
          const timer = setTimeout(resolve, 180_000);
          signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
        });
        return { version: '1.5.0', entry: '/nonexistent/sql-context/dist/index.js', source: 'bundled' as const };
      }),
    };
    const manager = createMcpManager({ db: storage.getDb(), secretStore, healthIntervalMs: 3_600_000, sqlContextPackages });
    await manager.start();
    const configuring = manager.updateSqlContextConfig({
      enabled: true, authMethod: 'direct', host: '127.0.0.1', port: 5439,
      database: 'db', username: 'user', sslMode: 'disable', password: 'secret',
    });
    await started;

    const stopStarted = Date.now();
    await manager.stop();
    const stopMs = Date.now() - stopStarted;
    await configuring;

    expect(seenSignal?.aborted).toBe(true);
    expect(stopMs).toBeLessThan(2_000);
    const row = storage.getDb().prepare("SELECT state, pid FROM mcp_servers WHERE id = 'sql-context'").get() as { state: string; pid: number | null };
    expect(row).toEqual({ state: 'stopped', pid: null });
  });
});
