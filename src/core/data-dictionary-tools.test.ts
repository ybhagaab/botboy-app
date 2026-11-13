import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMcpRouter } from '../api/routers/mcp.js';
import { createStorage, setSetting, type StorageLayer } from './storage.js';
import { ANALYTICS_CONTEXT_DIR_KEY, DATA_DICTIONARY_MARKER } from './analytics-context.js';
import { createNodeManager } from './node-manager.js';
import { createPromptManager } from './prompt-manager.js';
import { createToolExecutor } from './tool-executor.js';
import type { McpServerSnapshot } from './mcp-manager.js';

/**
 * How chat and jobs reach the data dictionary (owner decision 2026-11-10): the ETL rules send a which-table question there
 * first, and mcp_analytics_load_context reads it by table or by word.
 */
function server(id: string, state: McpServerSnapshot['state']): McpServerSnapshot {
  const tools = id === 'a2-analytics'
    ? ['datanet_search', 'datanet_create_profile', 'datanet_create_job', 'datanet_get_latest_run', 'datanet_update_profile_sql',
      'datanet_submit_run', 'datanet_get_job_run_status', 'datanet_alter_run', 'datanet_get_job_run_error', 'datanet_download_results']
    : ['connection_status', 'run_query'];
  return {
    id, kind: 'managed', displayName: id, enabled: true, configured: true, state, packageVersion: '1.0.0',
    tools: tools.map(name => ({ name, inputSchema: {}, risk: 'read' as const })), restartCount: 0,
    lastHealthyAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  } as McpServerSnapshot;
}

describe('data dictionary in chat', () => {
  let storage: StorageLayer;
  let dir: string;
  beforeEach(() => {
    storage = createStorage(':memory:');
    storage.initialize();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dictionary-tools-'));
    setSetting(storage.getDb(), ANALYTICS_CONTEXT_DIR_KEY, dir);
  });
  afterEach(() => {
    storage.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('the ETL rules look in the dictionary before any catalog query, and say how to look up a table it lacks', () => {
    const prompt = createPromptManager().getSystemPrompt('chat', { mcpServers: [server('sql-context', 'degraded'), server('a2-analytics', 'running')] });
    expect(prompt).toContain('- Tables and columns: data-dictionary.md lists every table the team\'s profiles read');
    expect(prompt).toContain('SELECT * FROM t WHERE 1=0 returns every column name');
    expect(prompt).toContain('information_schema, pg_ tables and functions like current_database() cannot be exported through ETL');
    const tool = createPromptManager().getToolDefinitions('chat').find(definition => definition.function.name === 'mcp_analytics_load_context')!;
    expect(Object.keys((tool.function.parameters as any).properties)).toEqual(['name', 'find', 'tables']);
  });

  it('mcp_analytics_load_context reads the dictionary by word or by table, and its index by default', async () => {
    fs.writeFileSync(path.join(dir, 'data-dictionary.md'), [
      '# Data dictionary — G', DATA_DICTIONARY_MARKER, '', '## Index', '', '| Table | What it\'s for | ID columns | Columns | Profiles |', '|---|---|---|---|---|',
      '| `public.events` | Events. | `uuid` | 2 | 1 |', '', '## public.events', '', "**What it's for:** Events.", '',
      '| Column | Type | Profiles | Meaning |', '|---|---|---|---|', '| `uuid` | character varying | 1 | Device ID |', '| `ct_id` | character varying | 0 | CleverTap ID |', '',
    ].join('\n'));
    const exec = createToolExecutor(storage.getDb(), createNodeManager(storage.getDb()));
    const load = async (args: Record<string, unknown>) =>
      (await exec.executeTool({ id: 'c1', type: 'function', function: { name: 'mcp_analytics_load_context', arguments: JSON.stringify(args) } })).content;
    const index = await load({ name: 'data-dictionary.md' });
    expect(index).toContain('[Index only: this file holds 1 table entries.');
    expect(index).not.toContain('| `ct_id` |');
    const found = await load({ name: 'data-dictionary.md', find: 'clevertap' });
    expect(found).toContain('## public.events\n**What it\'s for:** Events.');
    expect(found).toContain('| `ct_id` | character varying | 0 | CleverTap ID |');
    expect(found).not.toContain('| `uuid` |');
    const table = await load({ name: 'data-dictionary.md', tables: ['events'] });
    expect(table).toContain('| `uuid` | character varying | 1 | Device ID |');
  });

  it('the chat tool and the Build data dictionary button start a dictionary-only run', async () => {
    const starts: Array<Record<string, unknown>> = [];
    const etlOnboarding = {
      start: (options: Record<string, unknown> = {}) => { starts.push(options); return { state: 'running' as const }; },
      getStatus: () => ({ state: 'idle' as const }),
    };
    const exec = createToolExecutor(storage.getDb(), createNodeManager(storage.getDb()), { etlOnboarding });
    const generate = (args: Record<string, unknown>) => exec.executeTool({
      id: 'g1', type: 'function', function: { name: 'mcp_etl_generate_presets', arguments: JSON.stringify({ ownerRequested: true, ...args }) },
    });
    await generate({ dictionary: true });
    await generate({});

    const app = express();
    app.use(express.json());
    app.use('/api', createMcpRouter({ nodeManager: {} as any, db: storage.getDb(), etlOnboarding } as any));
    const server = http.createServer(app);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const post = (body: Record<string, unknown>) => request(base).post('/api/mcp/analytics-context/generate')
        .set('Origin', base).set('Sec-Fetch-Site', 'same-origin').send(body);
      expect((await post({ dictionary: true })).status).toBe(200);
      expect((await post({ regenerate: true })).status).toBe(200);
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
    expect(starts).toEqual([
      { regenerate: false, dictionary: true },
      { regenerate: false },
      { regenerate: false, dictionary: true },
      { regenerate: true },
    ]);
  });
});
