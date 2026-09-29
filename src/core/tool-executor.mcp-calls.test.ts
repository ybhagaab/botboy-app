import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createStorage, type StorageLayer } from './storage.js';
import { createNodeManager } from './node-manager.js';
import { createToolExecutor, sqlToolTimeoutMs, type ToolExecutionContext } from './tool-executor.js';

/**
 * Direct MCP calls from chat: the model uses the connector's own tools
 * (export_query, fetch_rows, ...) as any MCP client would. BotBoy adds no
 * hard time cap, forwards cancellation, and notes files the call produced in
 * the files workspace so they can be imported into the Data Room.
 */
describe('direct MCP calls from chat', () => {
  let storage: StorageLayer;
  let home: string;
  const previousHome = process.env.HOME;
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-calls-'));
    process.env.HOME = home;
    storage = createStorage(':memory:');
    storage.initialize();
  });
  afterEach(() => {
    vi.useRealTimers();
    storage.close();
    process.env.HOME = previousHome;
    fs.rmSync(home, { recursive: true, force: true });
  });

  const executorWith = (callTool: (...args: any[]) => Promise<unknown>) =>
    createToolExecutor(storage.getDb(), createNodeManager(storage.getDb()), { mcpManager: { callTool } as any });
  const run = (
    executor: ReturnType<typeof createToolExecutor>,
    name: string,
    args: Record<string, unknown>,
    context?: ToolExecutionContext,
  ) => executor.executeTool({ id: `${name}-1`, type: 'function', function: { name, arguments: JSON.stringify(args) } }, context);

  /** A connector export written where sql-context 1.5 writes it (SQL_EXPORT_DIR in the files workspace). */
  function exportFile(name: string, content: string): string {
    const folder = path.join(home, '.personal-productivity-tracker', 'files', 'sql-exports', `${process.pid}-1`, 'exports');
    fs.mkdirSync(folder, { recursive: true });
    const file = path.join(folder, name);
    fs.writeFileSync(file, content);
    fs.writeFileSync(`${file}.schema.json`, '{}');
    return file;
  }
  const receipt = (file: string, format: 'csv' | 'jsonl') => ({
    serverId: 'sql-context', toolName: 'export_query', isError: false, durationMs: 5,
    text: `${JSON.stringify({ exportId: 'e_abcdefghijklmnop', state: 'done', path: file, schemaPath: `${file}.schema.json`, format, rowCount: 2 })}\n\n[Resource: ${path.basename(file)}] ${pathToFileURL(file).href}`,
  });

  it('notes an export written into the files workspace with its exact Data Room import source', async () => {
    const file = exportFile('orders-20260929-101500-abcd.csv', 'day,orders\n2026-09-01,12\n2026-09-02,\n');
    const callTool = vi.fn(async () => receipt(file, 'csv'));
    const abort = new AbortController();

    const result = await run(executorWith(callTool), 'mcp_call_tool', {
      serverId: 'sql-context', toolName: 'export_query', arguments: { sql: 'SELECT day, orders FROM daily', format: 'csv' },
    }, { abortSignal: abort.signal });

    const relative = `sql-exports/${process.pid}-1/exports/orders-20260929-101500-abcd.csv`;
    const output = JSON.parse(result.content);
    expect(output.botboyFiles).toEqual({
      files: [{ path: relative, url: `/api/files/${relative}`, dataRoomSource: { kind: 'local_file', path: relative } }],
      next: expect.stringMatching(/create_data_room_dataset: inspect_local_file.*local_file source.*run_command.*url.*clear/),
    });
    expect(callTool).toHaveBeenCalledWith('sql-context', 'export_query', expect.any(Object),
      expect.objectContaining({ source: 'agent', timeoutMs: sqlToolTimeoutMs('export_query'), signal: abort.signal }));
  });

  it('marks a JSONL export as analysis-only and ignores files outside the workspace', async () => {
    const jsonl = exportFile('events-20260929-101500-abcd.jsonl', '["2026-09-01",12]\n');
    const noted = JSON.parse((await run(executorWith(vi.fn(async () => receipt(jsonl, 'jsonl'))), 'mcp_call_tool', {
      serverId: 'sql-context', toolName: 'export_query', arguments: { sql: 'SELECT 1', format: 'jsonl' },
    })).content);
    expect(noted.botboyFiles.files[0]).not.toHaveProperty('dataRoomSource');
    expect(noted.botboyFiles.next).toMatch(/analysis only/);

    const outside = path.join(home, 'elsewhere.csv');
    fs.writeFileSync(outside, 'a\n1\n');
    const plain = JSON.parse((await run(executorWith(vi.fn(async () => receipt(outside, 'csv'))), 'mcp_call_tool', {
      serverId: 'sql-context', toolName: 'export_query', arguments: { sql: 'SELECT 1' },
    })).content);
    expect(plain).not.toHaveProperty('botboyFiles');
  });

  // REGRESSION: every mcp_* tool ran under a flat 95s executor budget, so a
  // warehouse query came back as "Tool timeout (95s)" while it kept running.
  // Now only the connector's idle window (restarted by progress) applies.
  it('lets a warehouse query run for hours without an executor cap', async () => {
    vi.useFakeTimers();
    const hours = 3 * 60 * 60_000;
    const callTool = vi.fn(() => new Promise(resolve => {
      setTimeout(() => resolve({ serverId: 'sql-context', toolName: 'run_query', isError: false, durationMs: hours, text: 'total\n-----\n7\n\n1 rows returned. (1ms)' }), hours);
    }));
    const pending = run(executorWith(callTool), 'mcp_sql_query', { sql: 'SELECT count(*) AS total FROM big' });
    await vi.advanceTimersByTimeAsync(hours + 1);
    const result = await pending;
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.content).result).toContain('1 rows returned.');
  });

  it('cancels the connector call when the chat turn is stopped', async () => {
    const callTool = vi.fn((_server: string, _tool: string, _args: unknown, options: { signal?: AbortSignal }) => new Promise((_resolve, reject) => {
      options.signal?.addEventListener('abort', () => reject(new Error('This operation was aborted')), { once: true });
    }));
    const stop = new AbortController();
    const pending = run(executorWith(callTool), 'mcp_sql_query', { sql: 'SELECT pg_sleep(3600)' }, { abortSignal: stop.signal });
    stop.abort();
    const result = await pending;
    expect(result.content).toMatch(/aborted/);
    expect(callTool.mock.calls[0][3].signal).toBe(stop.signal);
  });
});
