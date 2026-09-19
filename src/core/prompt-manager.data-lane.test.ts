import { describe, it, expect } from 'vitest';
import { createPromptManager } from './prompt-manager.js';
import type { McpServerSnapshot } from './mcp-manager.js';

/**
 * Data-lane routing (etl-analytics A1): the chat prompt carries a DATA LANE
 * NOTICE only when the SQL warehouse connection is unavailable AND the
 * Datanet ETL connection exists. sql-context primacy is untouched otherwise.
 */
function server(overrides: Partial<McpServerSnapshot> & { id: string }): McpServerSnapshot {
  const tools = overrides.id === 'sql-context'
    ? ['connection_status', 'run_query']
    : overrides.id === 'a2-analytics'
      ? [
          'datanet_search', 'datanet_create_profile', 'datanet_create_job',
          'datanet_get_latest_run', 'datanet_update_profile_sql',
          'datanet_submit_run', 'datanet_get_job_run_status',
          'datanet_alter_run', 'datanet_get_job_run_error', 'datanet_download_results',
        ]
      : [];
  return {
    kind: 'managed',
    displayName: overrides.id,
    enabled: true,
    configured: true,
    state: 'running',
    packageVersion: '1.0.0',
    tools: tools.map(name => ({ name, inputSchema: {}, risk: 'read' as const })),
    restartCount: 0,
    lastHealthyAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  } as McpServerSnapshot;
}

describe('prompt-manager data-lane notice', () => {
  const pm = createPromptManager();
  const prompt = (servers?: McpServerSnapshot[]) => pm.getSystemPrompt('chat', { mcpServers: servers });

  it('emits one authoritative SQL-ready notice when sql-context is healthy', () => {
    const text = prompt([server({ id: 'sql-context' }), server({ id: 'a2-analytics' })]);
    expect(text).toContain('\n## DATA LANE NOTICE\n');
    expect(text).toContain('SQL warehouse lane is data-ready');
    expect(text).not.toContain('ALWAYS when it is configured and running');
  });

  it('activates when sql-context is absent and the ETL connection is usable', () => {
    const text = prompt([server({ id: 'a2-analytics' })]);
    expect(text).toContain('\n## DATA LANE NOTICE\n');
    expect(text).toContain('ETL_TOOLING_GUIDE.md');
    expect(text).toContain('mcp_etl_run_query');
    expect(text).toContain('not configured');
    expect(text).toContain('submit independent widget queries concurrently across distinct scratch pairs/jobs');
    expect(text).not.toContain('ALWAYS when it is configured and running');
  });

  it('activates when sql-context exists but is not running', () => {
    const text = prompt([server({ id: 'sql-context', state: 'stopped' as McpServerSnapshot['state'] }), server({ id: 'a2-analytics' })]);
    expect(text).toContain('\n## DATA LANE NOTICE\n');
    expect(text).toContain('not running');
  });

  it('emits an explicit fail-closed notice when neither lane is usable', () => {
    const text = prompt([server({ id: 'a2-analytics', configured: false })]);
    expect(text).toContain('\n## DATA LANE NOTICE\n');
    expect(text).toContain('Neither analytics execution lane is data-ready');
    expect(text).not.toContain('ALWAYS when it is configured and running');
  });

  it('stays silent only when the server inventory itself is unavailable', () => {
    expect(prompt(undefined)).not.toContain('\n## DATA LANE NOTICE\n');
    expect(prompt([])).toContain('Neither analytics execution lane is data-ready');
  });

  it('registers the analytics knowledge tools for chat (list + isolated single-file load)', () => {
    const defs = pm.getToolDefinitions('chat');
    const list = defs.find(d => d.function.name === 'mcp_analytics_list_context');
    const load = defs.find(d => d.function.name === 'mcp_analytics_load_context');
    expect(list).toBeDefined();
    expect(load).toBeDefined();
    expect(load!.function.parameters.required).toEqual(['name']);
    expect(load!.function.description).toContain('ONE');
  });

  it('registers mcp_etl_run_query for chat with the reuse-first description', () => {
    const defs = pm.getToolDefinitions('chat');
    const def = defs.find(d => d.function.name === 'mcp_etl_run_query');
    expect(def).toBeDefined();
    expect(def!.function.description).toContain('ETL_TOOLING_GUIDE');
    expect(def!.function.parameters.required).toEqual(['sql', 'ownerRequested']);
  });

  it('registers mcp_etl_generate_presets for chat as a background, manual-refresh, owner-gated tool', () => {
    const defs = pm.getToolDefinitions('chat');
    const def = defs.find(d => d.function.name === 'mcp_etl_generate_presets');
    expect(def).toBeDefined();
    expect(def!.function.parameters.required).toEqual(['ownerRequested']);
    expect(def!.function.description).toContain('BACKGROUND');
    expect(def!.function.description).toContain('manual-only');
    expect(def!.function.description).toContain('regenerate');
  });
});
