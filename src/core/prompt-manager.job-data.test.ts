import { describe, expect, it } from 'vitest';
import { createPromptManager, DATA_ROOM_ESSENTIALS } from './prompt-manager.js';
import type { McpServerSnapshot } from './mcp-types.js';

/**
 * Owner decision 2026-11-10 (job #12): every job turn and job update knows the dashboard and Data Room essentials; a job BotBoy
 * marked as data work at its start carries the detailed rules analytics turns follow. The analytics turn keeps its own workflow.
 */
const AMAZON_TERMS = /\b(mwinit|Midway|Harmony|Datanet|DataCentral|GRASP|SharePoint|OneDrive|a2z|AIM|Toolbox|Amazon|a2-analytics|grasp-m365)\b/;
const RULE_5B = '5b. When the owner asks to set or replace a widget’s data source';
const DETAIL = '## DATA JOB — dashboards, the Data Room and warehouse work';
const ESSENTIALS = '## Dashboards and the Data Room';

function server(id: string, tools: string[]): McpServerSnapshot {
  const now = new Date().toISOString();
  return {
    id, kind: 'managed', displayName: id, enabled: true, configured: true, state: 'running',
    packageVersion: '1.0.0', tools: tools.map(name => ({ name, inputSchema: {}, risk: 'read' as const })),
    restartCount: 0, lastHealthyAt: now, updatedAt: now,
  } as McpServerSnapshot;
}
const sqlOnly = [server('sql-context', ['run_query', 'export_query', 'list_presets', 'describe_table'])];
const pm = createPromptManager();
const count = (text: string, needle: string) => text.split(needle).length - 1;

describe('dashboard and Data Room knowledge in jobs', () => {
  it('gives every job turn the essentials, and only a data job the detailed rules', () => {
    const general = pm.getSystemPrompt('chat', { mcpServers: sqlOnly, jobTurn: true });
    expect(count(general, ESSENTIALS)).toBe(1);
    expect(general).not.toContain(DETAIL);
    // What the chat route sends for a general job.
    expect(pm.getSystemPrompt('chat', { mcpServers: sqlOnly, jobTurn: true, jobDataWork: false })).toBe(general);
    const data = pm.getSystemPrompt('chat', { mcpServers: sqlOnly, jobTurn: true, jobDataWork: true });
    expect(count(data, ESSENTIALS)).toBe(1);
    expect(count(data, DETAIL)).toBe(1);
    expect(count(data, RULE_5B)).toBe(1);
    expect(data).toContain('### HTML VIEWS: design the page yourself (kind=html)');
    expect(data).toContain('### Visualization and data-manipulation grammar');
    // Rule 5 ends with the same lane guidance an analytics turn gets for the same connections.
    for (const mcpServers of [sqlOnly, [] as McpServerSnapshot[]]) {
      const analytics = pm.getSystemPrompt('chat', { mcpServers, conversationMode: 'analytics_dashboard' });
      const lane = analytics.split('Warehouse-backed dashboard design remains the schema-inspection and queued-refresh workflow. ')[1].split('\n')[0];
      expect(lane.length).toBeGreaterThan(40);
      expect(pm.getSystemPrompt('chat', { mcpServers, jobTurn: true, jobDataWork: true })).toContain(lane);
    }
  });

  it('gives the main chat\'s look at a job the same, by the job it decides on', () => {
    expect(pm.getSystemPrompt('chat', { mcpServers: sqlOnly, reviewTurn: true })).toContain(ESSENTIALS);
    expect(pm.getSystemPrompt('chat', { mcpServers: sqlOnly, reviewTurn: true })).not.toContain(DETAIL);
    expect(pm.getSystemPrompt('chat', { mcpServers: sqlOnly, reviewTurn: true, jobDataWork: true })).toContain(DETAIL);
  });

  it('leaves the main chat\'s own turns alone, and never doubles the rules in an analytics turn', () => {
    const main = pm.getSystemPrompt('chat', { mcpServers: sqlOnly, mainChatTurn: true });
    expect(main).not.toContain(ESSENTIALS);
    expect(main).not.toContain(DETAIL);
    const analytics = pm.getSystemPrompt('chat', { mcpServers: sqlOnly, conversationMode: 'analytics_dashboard', jobTurn: true, jobDataWork: true });
    expect(analytics).toContain('## ACTIVE WORKFLOW: SCHEMA-FIRST ANALYTICS AND DASHBOARDS');
    expect(count(analytics, RULE_5B)).toBe(1);
    expect(analytics).not.toContain(DETAIL);
  });

  it('says the Data Room backs dashboards and how a dataset gets newer data', () => {
    expect(DATA_ROOM_ESSENTIALS).toContain('Dashboards are meant to read it.');
    expect(DATA_ROOM_ESSENTIALS).toContain('A Data Room widget reads its dataset\'s newest version at every refresh.');
    expect(DATA_ROOM_ESSENTIALS).toContain('into:{datasetId, mode:"merge_partitions"|"replace", coverage}');
    expect(DATA_ROOM_ESSENTIALS).toContain('is a normal repair, not a stopgap');
  });

  it('names no Amazon internal path in a job\'s prompt while Amazon Employee is off', () => {
    for (const mcpServers of [sqlOnly, [] as McpServerSnapshot[]]) {
      for (const ctx of [{ jobTurn: true }, { jobTurn: true, jobDataWork: true }, { reviewTurn: true, jobDataWork: true }]) {
        const prompt = pm.getSystemPrompt('chat', { mcpServers, ...ctx, amazonEmployee: false });
        expect(AMAZON_TERMS.exec(prompt)?.[0] ?? null).toBeNull();
      }
    }
  });

  it('tells the model a Data Room widget follows its dataset\'s newest version, never that it is pinned', () => {
    const tools = pm.getToolDefinitions('chat', {});
    const configure = tools.find(tool => tool.function.name === 'configure_analytics_widget_source')!;
    expect(configure.function.description).not.toContain('pins the exact current verified version');
    expect(configure.function.description).toContain('every refresh reads that dataset’s newest ready version');
    expect(configure.function.description).toContain('BotBoy keeps the widget’s previous source');
    const read = tools.find(tool => tool.function.name === 'get_analytics_dashboard')!;
    expect(read.function.description).toContain('It starts with sources:');
    const list = tools.find(tool => tool.function.name === 'list_data_room_datasets')!;
    expect(list.function.description).toContain('how to add a version');
  });
});
