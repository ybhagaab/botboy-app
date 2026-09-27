import { describe, expect, it } from 'vitest';
import { createPromptManager } from './prompt-manager.js';

describe('direct Data Room chat prompt and tool contract', () => {
  it('publishes catalog and query tools while hiding planner-mediated answer tools', () => {
    const manager = createPromptManager();
    const tools = manager.getToolDefinitions('chat');
    const byName = (name: string) => tools.filter(tool => tool.function.name === name);

    expect(byName('list_data_room_datasets')).toHaveLength(1);
    expect(byName('query_data_room')).toHaveLength(1);
    expect(byName('create_data_room_dataset')).toHaveLength(1);
    expect(byName('configure_analytics_widget_source')).toHaveLength(1);
    expect(byName('answer_analytics')).toHaveLength(0);
    expect(byName('run_analytics_job')).toHaveLength(0);
    expect(byName('manage_analytics_job')).toHaveLength(0);

    const listSchema = byName('list_data_room_datasets')[0].function.parameters as any;
    expect(listSchema.additionalProperties).toBe(false);
    expect(listSchema.required).toEqual([]);
    expect(Object.keys(listSchema.properties)).toEqual(['query']);
    expect(byName('list_data_room_datasets')[0].function.description).toContain('complete index');

    const createSchema = byName('create_data_room_dataset')[0].function.parameters as any;
    expect(createSchema.additionalProperties).toBe(false);
    expect(createSchema.required).toEqual(['action']);
    expect(createSchema.properties.action.enum).toEqual(['inspect_local_file', 'derive_semantic_hashes', 'create', 'status']);
    expect(createSchema.properties.file.required).toEqual(['path']);
    const planSources = createSchema.properties.plan.properties.sources.items.oneOf as any[];
    const kinds = planSources.map(source => source.properties.kind.enum[0]);
    expect(kinds).toEqual(['existing_version', 'import_inbox', 'local_file', 'sql_query', 'etl_query']);
    const localFile = planSources.find(source => source.properties.kind.enum[0] === 'local_file');
    expect(localFile.required).toEqual(['kind', 'alias', 'path']);
    expect(Object.keys(localFile.properties)).toEqual(['kind', 'alias', 'path', 'format', 'sheet', 'headerRow', 'nullToken', 'target', 'into']);
    expect(localFile.properties.into.properties.mode.enum).toEqual(['merge_partitions', 'replace']);
    const etl = planSources.find(source => source.properties.kind.enum[0] === 'etl_query');
    expect(etl.properties.runId).toBeUndefined();
    expect(etl.description).toContain('use local_file with the downloaded .tsv path');
    expect(JSON.stringify(createSchema)).not.toContain('botboy_csv');

    const sourceSchema = byName('configure_analytics_widget_source')[0].function.parameters as any;
    expect(sourceSchema.additionalProperties).toBe(false);
    expect(sourceSchema.required).toEqual(['dashboardId', 'widgetId', 'expectedWidgetRevision', 'source', 'ownerRequested']);
    expect(sourceSchema.properties.source.properties.kind.enum).toEqual(['warehouse_sql', 'data_room_query']);

    const querySchema = byName('query_data_room')[0].function.parameters as any;
    expect(querySchema.additionalProperties).toBe(false);
    expect(querySchema.required).toEqual(['datasets', 'sql']);
    expect(querySchema.properties.datasets.maxItems).toBe(8);
    expect(querySchema.properties.limit.maximum).toBe(200);
    expect(querySchema.properties.datasets.items.required).toEqual(['alias', 'datasetId']);

    const orchestratorTools = manager.getToolDefinitions('orchestrator');
    expect(orchestratorTools.some(tool => ['list_data_room_datasets', 'query_data_room', 'create_data_room_dataset', 'configure_analytics_widget_source'].includes(tool.function.name))).toBe(false);
  });

  it('makes the selected chat model the direct analysis path while preserving dashboard boundaries', () => {
    const manager = createPromptManager();
    const prompt = manager.getSystemPrompt('chat', {
      conversationMode: 'analytics_dashboard',
      analyticsSchemaBriefing: 'OTT schema context',
      analyticsDataRoomBriefing: '{"datasetId":"ds_ott","metric":{"id":"streamers"}}',
      mcpServers: [],
    });
    expect(prompt).toContain('YOU—the selected chat model—own the analysis');
    expect(prompt).toContain('Call list_data_room_datasets');
    expect(prompt).toContain('Then call query_data_room');
    expect(prompt).toContain('“Analyze this,” “read it,” or “tell me what the data says”');
    expect(prompt).toContain('use create_data_room_dataset');
    expect(prompt).toContain('derive_semantic_hashes');
    expect(prompt).toContain('To import ANY local file');
    expect(prompt).toContain('inspect_local_file');
    expect(prompt).not.toContain('botboy_csv');
    expect(prompt).toContain('up to four create attempts total');
    expect(prompt).toContain('existing durable AnalyticsJobService lifecycle');
    expect(prompt).toContain('Never use the old answer planner, choice workflow');
    expect(prompt).not.toContain('call answer_analytics ONCE');
    expect(prompt).not.toContain('No request-matching local data-room semantic card');
    expect(prompt).toContain('"datasetId":"ds_ott"');
    expect(prompt).toContain('Dashboard design/creation remains the separate');
  });
});

describe('edit_analytics_dashboard prompt and tool contract', () => {
  it('publishes one narrow owner-attested structural composite only to chat', () => {
    const manager = createPromptManager();
    const tools = manager.getToolDefinitions('chat');
    const edits = tools.filter(tool => tool.function.name === 'edit_analytics_dashboard');
    expect(edits).toHaveLength(1);
    const schema = edits[0].function.parameters as any;
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(['action', 'dashboardId', 'widgetIds', 'ownerRequested']);
    expect(schema.properties.action.enum).toEqual([
      'presentation', 'date_range', 'add_from_widget', 'combine_compatible_widgets',
    ]);
    for (const forbidden of ['sql', 'datasetId', 'versionId', 'binding', 'request', 'revision', 'lane']) {
      expect(schema.properties).not.toHaveProperty(forbidden);
    }
    expect(manager.getToolDefinitions('orchestrator').some(tool => tool.function.name === 'edit_analytics_dashboard')).toBe(false);
  });

  it('makes exact task scope override lane/source dances', () => {
    const prompt = createPromptManager().getSystemPrompt('chat', {
      conversationMode: 'analytics_dashboard',
      analyticsSchemaBriefing: 'Unrelated Membership schema',
      analyticsDataRoomBriefing: '{"datasetId":"ds_exact","metricId":"events"}',
      analyticsTaskGrounding: 'Required exact response anchors: dash_exact, widget_exact',
      mcpServers: [],
    });
    expect(prompt).toContain('call edit_analytics_dashboard ONCE');
    expect(prompt).toContain('Do not inspect, test, start, or call SQL/ETL lanes');
    expect(prompt).toContain('Required exact response anchors: dash_exact, widget_exact');
    expect(prompt).toContain('combine_compatible_widgets');
    expect(prompt).toContain('derived_data_required');
  });
});
