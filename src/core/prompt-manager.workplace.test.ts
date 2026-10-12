import { describe, it, expect } from 'vitest';
import {
  createPromptManager,
  createDataRoomDatasetToolDefinition,
  OFF_TOOL_DESCRIPTION_OVERRIDES,
  chatToolDefinitionNames,
} from './prompt-manager.js';
import { createDataRoomDatasetParametersSchema } from './analytics-job-tool-schema.js';
import { OFF_PROMPT_EDITS } from './prompt-workplace-edits.js';
import { AMAZON_ONLY_CHAT_TOOLS, isAmazonOnlyChatTool } from './workplace.js';
import { analyticsBriefingUnavailableText, createAnalyticsSchemaBriefingLoader } from './analytics-chat-context.js';
import type { McpServerSnapshot } from './mcp-types.js';

/**
 * Settings → Workplace chat gating (design §8, §16 item 5). While Amazon
 * Employee is off, no Amazon-only tool is offered and neither the prompt nor
 * the offered tool JSON names an Amazon internal path. ON (true/undefined)
 * is unchanged.
 */
const AMAZON_TERMS = /\b(mwinit|Midway|Harmony|Datanet|DataCentral|GRASP|SharePoint|OneDrive|a2z|AIM|Toolbox|Amazon|a2-analytics|grasp-m365)\b/;
const TOOL_TERMS = new RegExp(`${AMAZON_TERMS.source}|\\baim\\b|\\bBindle\\b`);

function server(id: string, tools: string[]): McpServerSnapshot {
  return {
    id, kind: 'managed', displayName: id, enabled: true, configured: true, state: 'running',
    packageVersion: '1.0.0', tools: tools.map(name => ({ name, inputSchema: {}, risk: 'read' as const })),
    restartCount: 0, lastHealthyAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  } as McpServerSnapshot;
}

const sqlOnly = [server('sql-context', ['connection_status', 'run_query'])];
const nodes = [{ id: 'n1', title: 'Alpha', type: 'project', parentId: null, status: 'active' }] as any;

function firstMatch(text: string, re: RegExp): string | null {
  const match = re.exec(text);
  return match ? text.slice(Math.max(0, match.index - 80), match.index + 80) : null;
}

describe('prompt-manager workplace gating', () => {
  const pm = createPromptManager();

  it('offers no Amazon-only tool while off, and export_footer in both modes', () => {
    const off = pm.getToolDefinitions('chat', { amazonEmployee: false }).map(def => def.function.name);
    expect(off.filter(name => AMAZON_ONLY_CHAT_TOOLS.has(name))).toEqual([]);
    expect(off.some(isAmazonOnlyChatTool)).toBe(false);
    expect(off).toContain('export_footer');
    expect(pm.getToolDefinitions('chat').map(def => def.function.name)).toContain('export_footer');
    expect(pm.getToolDefinitions('chat', { amazonEmployee: true }).map(def => def.function.name)).toContain('publish_static_artifact_to_harmony');
  });

  it('applies the OFF overrides without mutating the shared definitions', () => {
    const before = JSON.stringify(pm.getToolDefinitions('chat'));
    const off = pm.getToolDefinitions('chat', { amazonEmployee: false });
    const profile = off.find(def => def.function.name === 'mcp_profile_action')!;
    expect(profile.function.description).toContain('Authentication steps (installers, CLI logins) CANNOT run');
    expect(JSON.stringify(pm.getToolDefinitions('chat'))).toBe(before);
  });

  it('every override `from` occurs exactly once in its ON field (drift guard)', () => {
    const on = pm.getToolDefinitions('chat');
    for (const entry of OFF_TOOL_DESCRIPTION_OVERRIDES) {
      const def = on.find(candidate => candidate.function.name === entry.tool);
      expect(def, entry.tool).toBeDefined();
      const value = entry.field.split('.').reduce((node: any, key) => node?.[key], def!.function as any);
      expect(typeof value, `${entry.tool}.${entry.field}`).toBe('string');
      expect((value as string).split(entry.from).length - 1, `${entry.tool}.${entry.field}`).toBe(1);
    }
  });

  it('ON (true) and undefined produce identical prompts and tools', () => {
    for (const mode of [undefined, 'analytics_dashboard'] as const) {
      const ctx = { nodes, mcpServers: sqlOnly, conversationMode: mode };
      expect(pm.getSystemPrompt('chat', { ...ctx, amazonEmployee: true })).toBe(pm.getSystemPrompt('chat', ctx));
      expect(JSON.stringify(pm.getToolDefinitions('chat', { ...ctx, amazonEmployee: true })))
        .toBe(JSON.stringify(pm.getToolDefinitions('chat', ctx)));
    }
  });

  it('OFF general and analytics prompts name no Amazon internal path', () => {
    for (const mcpServers of [sqlOnly, [] as McpServerSnapshot[], [server('sql-context', [])]]) {
      for (const conversationMode of [undefined, 'analytics_dashboard'] as const) {
        const prompt = pm.getSystemPrompt('chat', { nodes, mcpServers, conversationMode, amazonEmployee: false });
        expect(firstMatch(prompt, AMAZON_TERMS)).toBeNull();
      }
    }
  });

  it('OFF tool JSON names no Amazon internal path (no allowlist)', () => {
    const json = JSON.stringify(pm.getToolDefinitions('chat', { amazonEmployee: false }));
    expect(firstMatch(json, TOOL_TERMS)).toBeNull();
  });

  it('builds create_data_room_dataset without ETL while off; ON stays byte-identical', () => {
    const offDef = pm.getToolDefinitions('chat', { amazonEmployee: false }).find(def => def.function.name === 'create_data_room_dataset')!;
    const json = JSON.stringify(offDef);
    expect(json).not.toContain('"etl_query"');
    expect(json).not.toContain('ETL SOURCE FORM');
    const sources = (offDef.function.parameters as any).properties.plan.properties.sources.items.oneOf;
    expect(sources.map((member: any) => member.properties.kind.enum[0])).toEqual(['existing_version', 'import_inbox', 'local_file', 'sql_query']);
    const onDef = pm.getToolDefinitions('chat').find(def => def.function.name === 'create_data_room_dataset')!;
    expect(JSON.stringify(createDataRoomDatasetToolDefinition())).toBe(JSON.stringify(onDef));
    expect(JSON.stringify(createDataRoomDatasetParametersSchema())).toBe(JSON.stringify(createDataRoomDatasetParametersSchema({ includeEtl: true })));
  });

  it('OFF data-lane notices carry no ETL text', () => {
    const ready = pm.getSystemPrompt('chat', { mcpServers: sqlOnly, amazonEmployee: false });
    expect(ready).toContain('The SQL warehouse lane is data-ready');
    expect(ready).not.toContain('Datanet');
    const none = pm.getSystemPrompt('chat', { mcpServers: [], amazonEmployee: false });
    expect(none).toContain('The SQL warehouse lane is not data-ready for this turn.');
    expect(none).toContain('State that the SQL connection on Connections needs attention and stop.');
  });

  it('OFF analytics prompt with the real briefing fallback texts names no Amazon internal path', async () => {
    const loader = createAnalyticsSchemaBriefingLoader(undefined, {});
    const offLoaded = await loader.load('x', { amazonEmployee: false });
    const onLoaded = await loader.load('x', {});
    for (const text of [offLoaded.text, analyticsBriefingUnavailableText(false)]) {
      const prompt = pm.getSystemPrompt('chat', {
        mcpServers: sqlOnly, conversationMode: 'analytics_dashboard', analyticsSchemaBriefing: text, amazonEmployee: false,
      });
      expect(firstMatch(prompt, AMAZON_TERMS)).toBeNull();
    }
    expect(analyticsBriefingUnavailableText(true)).toContain('a2-analytics connection card');
    expect(onLoaded.text).toContain('a2-analytics connection card');
  });

  it('every OFF prompt edit `from` occurs in an ON prompt (drift guard)', () => {
    const etl = [server('sql-context', []), server('a2-analytics', ['datanet_search'])];
    const on = [
      pm.getSystemPrompt('chat', { nodes, mcpServers: sqlOnly }),
      pm.getSystemPrompt('chat', { nodes, mcpServers: [], conversationMode: 'analytics_dashboard' }),
      pm.getSystemPrompt('chat', { nodes, mcpServers: etl, conversationMode: 'analytics_dashboard' }),
      pm.getSystemPrompt('chat', { nodes, mcpServers: sqlOnly, conversationMode: 'analytics_dashboard', analyticsTaskGrounding: 'scope' }),
    ].join('\n');
    for (const edit of OFF_PROMPT_EDITS) expect(on.includes(edit.from), edit.from.slice(0, 80)).toBe(true);
  });

  it('every TOOL_DEFS mcp_etl_* / sharepoint_* key is in the explicit Amazon-only set', () => {
    const prefixed = chatToolDefinitionNames().filter(name => name.startsWith('mcp_etl_') || name.startsWith('sharepoint_'));
    expect(prefixed.length).toBeGreaterThan(0);
    expect(prefixed.filter(name => !AMAZON_ONLY_CHAT_TOOLS.has(name))).toEqual([]);
  });
});
