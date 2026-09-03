import { describe, it, expect } from 'vitest';
import { createPromptManager } from './prompt-manager.js';
import type { McpServerSnapshot } from './mcp-manager.js';

/**
 * Data-lane routing (etl-analytics A1): the chat prompt carries a DATA LANE
 * NOTICE only when the SQL warehouse connection is unavailable AND the
 * Datanet ETL connection exists. sql-context primacy is untouched otherwise.
 */
function server(overrides: Partial<McpServerSnapshot> & { id: string }): McpServerSnapshot {
  return {
    kind: 'managed',
    displayName: overrides.id,
    enabled: true,
    configured: true,
    state: 'running',
    packageVersion: '1.0.0',
    tools: [],
    restartCount: 0,
    updatedAt: new Date().toISOString(),
    ...overrides,
  } as McpServerSnapshot;
}

describe('prompt-manager data-lane notice', () => {
  const pm = createPromptManager();
  const prompt = (servers?: McpServerSnapshot[]) => pm.getSystemPrompt('chat', { mcpServers: servers });

  it('stays silent when sql-context is running — SQL primacy unchanged', () => {
    const text = prompt([server({ id: 'sql-context' }), server({ id: 'a2-analytics' })]);
    expect(text).not.toContain('DATA LANE NOTICE');
  });

  it('activates when sql-context is absent and the ETL connection is usable', () => {
    const text = prompt([server({ id: 'a2-analytics' })]);
    expect(text).toContain('DATA LANE NOTICE');
    expect(text).toContain('ETL_TOOLING_GUIDE.md');
    expect(text).toContain('mcp_etl_run_query');
    expect(text).toContain('not configured');
  });

  it('activates when sql-context exists but is not running', () => {
    const text = prompt([server({ id: 'sql-context', state: 'stopped' as McpServerSnapshot['state'] }), server({ id: 'a2-analytics' })]);
    expect(text).toContain('DATA LANE NOTICE');
    expect(text).toContain('not running');
  });

  it('stays silent when the ETL connection is not usable either — no lane to advertise', () => {
    const text = prompt([server({ id: 'a2-analytics', configured: false })]);
    expect(text).not.toContain('DATA LANE NOTICE');
  });

  it('stays silent without a server inventory (no false routing on missing data)', () => {
    expect(prompt(undefined)).not.toContain('DATA LANE NOTICE');
    expect(prompt([])).not.toContain('DATA LANE NOTICE');
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
