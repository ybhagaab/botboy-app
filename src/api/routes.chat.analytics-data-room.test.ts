import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStorage, setSetting, type StorageLayer } from '../core/storage.js';
import { ANALYTICS_CONTEXT_DIR_KEY } from '../core/analytics-context.js';
import { createNodeManager } from '../core/node-manager.js';
import { createPromptManager } from '../core/prompt-manager.js';
import { createRouter } from './routes.js';

function streamResult(input: { content?: string; toolCalls?: any[]; finishReason?: string }) {
  return {
    content: input.content ?? '',
    reasoning: '',
    toolCalls: input.toolCalls ?? [],
    finishReason: input.finishReason ?? 'stop',
    usage: {},
  };
}

const directQueryArgs = {
  datasets: [{ alias: 'events', datasetId: 'ds_fixture', versionId: 'dsv_000000000000000000000001' }],
  sql: 'SELECT event_date, metric_value FROM events.data ORDER BY event_date',
  limit: 20,
};

describe('streamed chat direct Data Room read path', () => {
  let storage: StorageLayer;
  let contextDirectory: string;

  beforeEach(() => {
    storage = createStorage(':memory:');
    storage.initialize();
    contextDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'analytics-chat-r2-'));
    setSetting(storage.getDb(), ANALYTICS_CONTEXT_DIR_KEY, contextDirectory);
  });

  afterEach(() => {
    storage.close();
    fs.rmSync(contextDirectory, { recursive: true, force: true });
  });

  it('lets the selected chat model list then query ready data with no hidden planner or remote lane', async () => {
    const seenRequests: any[] = [];
    let call = 0;
    const llmClient = {
      getActiveEndpoint: () => 'ecs',
      getContextWindow: () => 262144,
      getDefaultModel: () => 'openai.gpt-5.6-terra',
      chatCompletion: vi.fn(async () => { throw new Error('direct ready-data analysis must not run a selector or planner model'); }),
      chatCompletionStream: vi.fn((input: any) => {
        seenRequests.push(input);
        const index = call++;
        return (async function* () {
          if (index === 0) {
            return streamResult({
              toolCalls: [{
                id: 'catalog-call-1',
                type: 'function',
                function: { name: 'list_data_room_datasets', arguments: JSON.stringify({ query: 'daily events' }) },
              }],
              finishReason: 'tool_calls',
            });
          }
          if (index === 1) {
            return streamResult({
              toolCalls: [{
                id: 'query-call-1',
                type: 'function',
                function: { name: 'query_data_room', arguments: JSON.stringify(directQueryArgs) },
              }],
              finishReason: 'tool_calls',
            });
          }
          yield { type: 'content', text: 'Daily events are 10 for 2026-09-01.' };
          return streamResult({
            content: 'Daily events are 10 for 2026-09-01. Source: verified Data Room version dsv_000000000000000000000001; day grain, region counting key, valid_events regime, no truncation.',
          });
        })();
      }),
    };
    const toolExecutor = {
      executeTool: vi.fn(async (toolCall: any, context: any) => {
        if (toolCall.function.name === 'list_data_room_datasets') {
          return {
            toolCallId: toolCall.id,
            isError: false,
            content: JSON.stringify({
              status: 'ok',
              trust: 'verified_data_room_catalog',
              datasets: [{
                datasetId: 'ds_fixture',
                versionId: 'dsv_000000000000000000000001',
                name: 'Daily Events',
                rowCount: 1,
                schema: [{ name: 'event_date', logicalType: 'date' }, { name: 'metric_value', logicalType: 'number' }],
              }],
            }),
            context,
          };
        }
        expect(toolCall.function.name).toBe('query_data_room');
        return {
          toolCallId: toolCall.id,
          isError: false,
          content: JSON.stringify({
            status: 'ok',
            trust: 'verified_data_room_rows',
            columns: ['event_date', 'metric_value'],
            rows: [['2026-09-01', 10]],
            displayedRowCount: 1,
            truncated: false,
            sources: [{ datasetId: 'ds_fixture', versionId: 'dsv_000000000000000000000001' }],
            receipt: { querySha256: '3'.repeat(64), effects: { datasetWrites: 0, jobWrites: 0, externalCalls: 0 } },
            limitations: [],
          }),
          context,
        };
      }),
    };
    const mcpManager = {
      getServer: vi.fn(async () => { throw new Error('local-only preflight must not inspect SQL'); }),
      callTool: vi.fn(async () => { throw new Error('no MCP data call allowed on a room hit'); }),
      testConnection: vi.fn(async () => { throw new Error('no lane probe allowed on a room hit'); }),
      listProfiles: vi.fn(async () => []),
    };
    const db = storage.getDb();
    const app = express();
    app.use(express.json());
    app.use('/api', createRouter({
      nodeManager: createNodeManager(db),
      db,
      llmClient: llmClient as any,
      toolExecutor: toolExecutor as any,
      promptManager: createPromptManager(),
      mcpManager: mcpManager as any,
      analyticsDataRoom: {
        listDatasets: () => [],
        getDataset: () => null,
        listDatasetVersions: () => null,
        getDatasetVersion: () => null,
      },
      analyticsAnswerService: { answer: vi.fn() } as any,
      chatInterface: {
        getHistory: () => [],
        sendMessage: async () => ({ message: { id: 'fallback', role: 'assistant', content: '' } }),
      } as any,
      conversationManager: {
        getActiveSessionId: () => null,
        createSession: () => 'session-r2',
        appendUser: vi.fn(),
        appendAssistant: vi.fn(),
        countUserMessages: () => 1,
        getSummary: () => null,
        getMessages: () => [],
        getMessagesSinceId: () => [],
        getRecentMessages: () => [{ role: 'user', content: 'How many daily events?' }],
        saveSummary: vi.fn(),
      } as any,
    }));

    const response = await request(app).post('/api/chat/messages').send({
      message: 'How many daily events?',
      modeHint: 'analytics_dashboard',
      requestId: 'request-direct-answer',
      routeScope: {
        kind: 'analytics_dashboard', dashboardId: 'dash_stale', selectedWidgetIds: ['widget_stale'],
      },
      stream: true,
    });

    expect(response.status).toBe(200);
    expect(response.text).toContain('verified Data Room version');
    expect(llmClient.chatCompletion).not.toHaveBeenCalled();
    expect(llmClient.chatCompletionStream).toHaveBeenCalledTimes(3);
    expect(toolExecutor.executeTool).toHaveBeenCalledTimes(2);
    const offeredNames = seenRequests[0].tools.map((tool: any) => tool.function.name);
    expect(offeredNames).toContain('list_data_room_datasets');
    expect(offeredNames).toContain('query_data_room');
    expect(offeredNames).not.toContain('answer_analytics');
    expect(offeredNames).not.toContain('run_analytics_job');
    expect(offeredNames).not.toContain('manage_analytics_job');
    expect(toolExecutor.executeTool.mock.calls[0][1]).toMatchObject({
      currentUserMessage: 'How many daily events?',
      callerKind: 'interactive',
      ownerRequestId: 'request-direct-answer',
      abortSignal: expect.any(AbortSignal),
    });
    expect(toolExecutor.executeTool.mock.calls[0][1]).not.toHaveProperty('authoritativeAnalyticsScope');
    expect(mcpManager.getServer).not.toHaveBeenCalled();
    expect(mcpManager.callTool).not.toHaveBeenCalled();
    expect(mcpManager.testConnection).not.toHaveBeenCalled();
    expect(mcpManager.listProfiles).toHaveBeenCalledTimes(1); // Local inventory snapshot only.
    const persisted = db.prepare("SELECT content FROM chat_messages WHERE role = 'assistant' ORDER BY rowid DESC LIMIT 1").get() as { content: string };
    expect(persisted.content).toContain('day grain');
  });
});


describe('streamed chat exact dashboard task grounding', () => {
  let storage: StorageLayer;
  let contextDirectory: string;

  beforeEach(() => {
    storage = createStorage(':memory:');
    storage.initialize();
    contextDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'analytics-chat-r41-'));
    setSetting(storage.getDb(), ANALYTICS_CONTEXT_DIR_KEY, contextDirectory);
  });

  afterEach(() => {
    storage.close();
    fs.rmSync(contextDirectory, { recursive: true, force: true });
  });

  it('rejects wrong-domain retry prose and emits one exact-scope honest failure', async () => {
    const seenRequests: any[] = [];
    let call = 0;
    const wrongDomain = 'Membership India successful subscriptions from svod_transaction_data_table.';
    const llmClient = {
      getActiveEndpoint: () => 'ecs',
      getContextWindow: () => 262144,
      getDefaultModel: () => 'openai.gpt-5.6-terra',
      chatCompletion: vi.fn(async () => { throw new Error('exact dashboard task must not run a global context selector'); }),
      chatCompletionStream: vi.fn((input: any) => {
        seenRequests.push(input);
        call += 1;
        return (async function* () {
          yield { type: 'content', text: wrongDomain };
          return streamResult({ content: wrongDomain });
        })();
      }),
    };
    const toolExecutor = { executeTool: vi.fn() };
    const dataset = {
      id: 'ds_scope', name: 'Synthetic scoped events', domainKey: 'synthetic-scope',
      head: { versionId: 'dsv_aaaaaaaaaaaaaaaaaaaaaaaa' },
      contract: {
        metric: { id: 'events' }, regime: { id: 'synthetic_only' }, countingKey: 'region',
        unit: 'events', grain: 'day_region', availableDimensions: ['event_date', 'region'],
        timeField: 'event_date', timeZone: 'UTC', coverage: { completePartitions: ['2026-09-01'] },
        contractSha256: '1'.repeat(64), handling: { allowedUses: ['dashboard'] },
      },
      definition: { answer: { metricId: 'events' } },
    };
    const dashboard = {
      id: 'dash_scope', title: 'Synthetic structural dashboard', widgets: [{
        id: 'widget_scope', title: 'Synthetic scoped trend', revision: 1, bindingRevision: 1,
        binding: { datasetId: 'ds_scope' },
      }],
    };
    const mcpManager = {
      getServer: vi.fn(async () => { throw new Error('exact task must not inspect SQL'); }),
      callTool: vi.fn(async () => { throw new Error('exact task must not call MCP'); }),
      listProfiles: vi.fn(async () => []),
    };
    const db = storage.getDb();
    const app = express();
    app.use(express.json());
    app.use('/api', createRouter({
      nodeManager: createNodeManager(db), db,
      llmClient: llmClient as any,
      toolExecutor: toolExecutor as any,
      promptManager: createPromptManager(),
      mcpManager: mcpManager as any,
      analyticsService: { getDashboard: (id: string) => id === 'dash_scope' ? dashboard : null } as any,
      analyticsDataRoom: {
        listDatasets: () => [{ id: 'ds_scope', name: dataset.name, domainKey: dataset.domainKey }],
        getDataset: (id: string) => id === 'ds_scope' ? dataset : null,
        listDatasetVersions: () => null,
        getDatasetVersion: () => null,
      } as any,
      analyticsAnswerService: { answer: vi.fn() } as any,
      chatInterface: {
        getHistory: () => [],
        sendMessage: async () => ({ message: { id: 'fallback', role: 'assistant', content: '' } }),
      } as any,
      conversationManager: {
        getActiveSessionId: () => null,
        createSession: () => 'session-r41',
        appendUser: vi.fn(), appendAssistant: vi.fn(), countUserMessages: () => 1,
        getSummary: () => null, getMessages: () => [], getMessagesSinceId: () => [],
        getRecentMessages: () => [{ role: 'user', content: 'Change widget_scope on dash_scope.' }],
        saveSummary: vi.fn(),
      } as any,
    }));

    const response = await request(app).post('/api/chat/messages').send({
      message: 'Change widget_scope on dash_scope from line to area.',
      mode: 'analytics_dashboard', stream: true,
    });

    expect(response.status).toBe(200);
    expect(response.text).toContain('"reason":"analytics_grounding"');
    expect(llmClient.chatCompletionStream).toHaveBeenCalledTimes(2);
    expect(llmClient.chatCompletion).not.toHaveBeenCalled();
    expect(toolExecutor.executeTool).not.toHaveBeenCalled();
    expect(mcpManager.getServer).not.toHaveBeenCalled();
    expect(mcpManager.callTool).not.toHaveBeenCalled();
    expect(seenRequests[0].messages[0].content).toContain('EXACT EXISTING-DASHBOARD TASK');
    expect(seenRequests[0].messages[0].content).toContain('ds_scope');
    expect(seenRequests[0].messages[0].content).not.toContain('svod_transaction_data_table');
    const persisted = db.prepare("SELECT content FROM chat_messages WHERE role = 'assistant' ORDER BY rowid DESC LIMIT 1").get() as { content: string };
    expect(persisted.content).toContain('dash_scope');
    expect(persisted.content).toContain('widget_scope');
    expect(persisted.content).toContain('Synthetic structural dashboard');
    expect(persisted.content).toContain('Nothing was changed');
    expect(persisted.content).not.toContain('Membership India');
  });

  it('uses canonical route selection and deterministically finalizes one exact edit receipt after one model stream', async () => {
    const editArgs = {
      action: 'presentation', dashboardId: 'dash_scope', widgetIds: ['widget_scope'],
      presentation: { renderer: 'area' }, ownerRequested: true,
    };
    const llmClient = {
      getActiveEndpoint: () => 'ecs', getContextWindow: () => 262144,
      getDefaultModel: () => 'openai.gpt-5.6-terra',
      chatCompletion: vi.fn(async () => { throw new Error('selector must not run'); }),
      chatCompletionStream: vi.fn(() => {
        return (async function* () {
          return streamResult({
            toolCalls: [{ id: 'edit-call-1', type: 'function', function: { name: 'edit_analytics_dashboard', arguments: JSON.stringify(editArgs) } }],
            finishReason: 'tool_calls',
          });
        })();
      }),
    };
    const toolExecutor = { executeTool: vi.fn(async (toolCall: any, context: any) => ({
      toolCallId: toolCall.id, isError: false,
      content: JSON.stringify({
        requestId: context.ownerRequestId,
        status: 'completed', action: 'presentation', mutationApplied: true, dataReady: true,
        dashboard: { id: 'dash_scope', title: 'Synthetic structural dashboard' },
        widget: { id: 'widget_scope', title: 'Synthetic scoped trend', revision: 2, bindingRevision: 1 },
        sourceWidgetIds: ['widget_scope'], resultDisposition: 'preserved',
        responseGuidance: { requiredAnchors: ['dash_scope', 'widget_scope'], claim: 'completed' },
      }),
    })) };
    const dataset: any = {
      id: 'ds_scope', name: 'Synthetic scoped events', domainKey: 'synthetic-scope',
      head: { versionId: 'dsv_aaaaaaaaaaaaaaaaaaaaaaaa' }, definition: { answer: { metricId: 'events' } },
      contract: { metric: { id: 'events' }, regime: { id: 'synthetic_only' }, countingKey: 'region', unit: 'events', grain: 'day_region', availableDimensions: ['event_date', 'region'], timeField: 'event_date', timeZone: 'UTC', coverage: { completePartitions: ['2026-09-01'] }, contractSha256: '1'.repeat(64), handling: { allowedUses: ['dashboard'] } },
    };
    const dashboard: any = { id: 'dash_scope', title: 'Synthetic structural dashboard', widgets: [{ id: 'widget_scope', title: 'Synthetic scoped trend', revision: 1, bindingRevision: 1, binding: { datasetId: 'ds_scope' } }] };
    const mcpManager = { getServer: vi.fn(), callTool: vi.fn(), listProfiles: vi.fn(async () => []) };
    const db = storage.getDb();
    const app = express(); app.use(express.json());
    app.use('/api', createRouter({
      nodeManager: createNodeManager(db), db, llmClient: llmClient as any, toolExecutor: toolExecutor as any,
      promptManager: createPromptManager(), mcpManager: mcpManager as any,
      analyticsService: { getDashboard: (id: string) => id === 'dash_scope' ? dashboard : null } as any,
      analyticsDataRoom: { listDatasets: () => [{ id: 'ds_scope', name: dataset.name, domainKey: dataset.domainKey }], getDataset: (id: string) => id === 'ds_scope' ? dataset : null, listDatasetVersions: () => null, getDatasetVersion: () => null } as any,
      analyticsAnswerService: { answer: vi.fn() } as any,
      chatInterface: { getHistory: () => [], sendMessage: async () => ({ message: { id: 'fallback', role: 'assistant', content: '' } }) } as any,
      conversationManager: { getActiveSessionId: () => null, createSession: () => 'session-r41-positive', appendUser: vi.fn(), appendAssistant: vi.fn(), countUserMessages: () => 1, getSummary: () => null, getMessages: () => [], getMessagesSinceId: () => [], getRecentMessages: () => [], saveSummary: vi.fn() } as any,
    }));
    const response = await request(app).post('/api/chat/messages')
      .set('Host', 'localhost:7778')
      .set('Origin', 'http://localhost:7778')
      .send({
      message: 'Change this widget to an area visualization.',
      modeHint: 'analytics_dashboard',
      requestId: 'request-route-chat-1',
      routeScope: {
        kind: 'analytics_dashboard', dashboardId: 'dash_scope', selectedWidgetIds: ['widget_scope'],
      },
      stream: true,
    });
    expect(response.status).toBe(200);
    expect(response.text).not.toContain('"reason":"analytics_grounding"');
    expect(response.text).toContain('The existing verified result was preserved; no data query or refresh was started.');
    expect(toolExecutor.executeTool).toHaveBeenCalledTimes(1);
    expect(toolExecutor.executeTool.mock.calls[0][0].function.name).toBe('edit_analytics_dashboard');
    expect(toolExecutor.executeTool.mock.calls[0][1]).toMatchObject({
      currentUserMessage: 'Change this widget to an area visualization.',
      callerKind: 'interactive',
      ownerRequestId: 'request-route-chat-1',
      authoritativeAnalyticsScope: {
        dashboardId: 'dash_scope', orderedWidgetIds: ['widget_scope'], source: 'dashboard_widget_selection',
      },
    });
    expect(llmClient.chatCompletionStream).toHaveBeenCalledTimes(1);
    const persisted = db.prepare("SELECT content FROM chat_messages WHERE role = 'assistant' ORDER BY rowid DESC LIMIT 1").get() as { content: string };
    expect(persisted.content).toContain('dash_scope');
    expect(persisted.content).toContain('widget_scope');
    expect(persisted.content).toContain('Synthetic structural dashboard');
    expect(response.text).toContain(JSON.stringify(persisted.content).slice(1, -1));
    expect(mcpManager.getServer).not.toHaveBeenCalled();
    expect(mcpManager.callTool).not.toHaveBeenCalled();
  });
});


describe('streamed chat analytics route-scope admission', () => {
  let storage: StorageLayer;

  beforeEach(() => {
    storage = createStorage(':memory:');
    storage.initialize();
  });

  afterEach(() => storage.close());

  function appWithScope(getDashboard: ReturnType<typeof vi.fn>, sendMessage = vi.fn(async () => ({
    message: { id: 'fallback', role: 'assistant', content: 'General fallback reply.' },
  }))) {
    const db = storage.getDb();
    const app = express();
    app.use(express.json());
    app.use('/api', createRouter({
      nodeManager: createNodeManager(db),
      db,
      analyticsService: { getDashboard } as any,
      chatInterface: { getHistory: () => [], sendMessage } as any,
    }));
    return { app, db, sendMessage };
  }

  it.each([
    ['stale selection', undefined],
    ['wrong-dashboard selection', { id: 'widget_other' }],
  ])('rejects %s before SSE, persistence, model, or tool effects', async (_label, canonicalWidget) => {
    const getDashboard = vi.fn(() => ({
      id: 'dash_scope', title: 'Scoped dashboard', widgets: canonicalWidget ? [canonicalWidget] : [],
    }));
    const { app, db, sendMessage } = appWithScope(getDashboard);
    const response = await request(app).post('/api/chat/messages')
      .set('Host', 'localhost:7778')
      .set('Origin', 'http://localhost:7778')
      .send({
      message: 'Change this widget to an area view.',
      modeHint: 'analytics_dashboard',
      requestId: 'request-invalid-scope',
      routeScope: {
        kind: 'analytics_dashboard', dashboardId: 'dash_scope', selectedWidgetIds: ['widget_stale'],
      },
      stream: true,
    });
    expect(response.status).toBe(409);
    expect(response.body.error).toContain('stale or belongs to another dashboard');
    expect(sendMessage).not.toHaveBeenCalled();
    expect((db.prepare('SELECT COUNT(*) AS count FROM chat_messages').get() as { count: number }).count).toBe(0);
  });

  it('rejects a forged Origin before any effect', async () => {
    const getDashboard = vi.fn(() => ({ id: 'dash_scope', widgets: [{ id: 'widget_scope' }] }));
    const { app, db, sendMessage } = appWithScope(getDashboard);
    const response = await request(app).post('/api/chat/messages')
      .set('Host', 'localhost:7778')
      .set('Origin', 'http://attacker.invalid')
      .send({
        message: 'Change this widget to an area view.', modeHint: 'analytics_dashboard',
        requestId: 'request-forged-origin',
        routeScope: { kind: 'analytics_dashboard', dashboardId: 'dash_scope', selectedWidgetIds: ['widget_scope'] },
        stream: true,
      });
    expect(response.status).toBe(403);
    expect(getDashboard).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
    expect((db.prepare('SELECT COUNT(*) AS count FROM chat_messages').get() as { count: number }).count).toBe(0);
  });

  it('requires same-origin browser attestation whenever route locators are supplied', async () => {
    const getDashboard = vi.fn(() => ({ id: 'dash_scope', widgets: [{ id: 'widget_scope' }] }));
    const { app, db, sendMessage } = appWithScope(getDashboard);
    const response = await request(app).post('/api/chat/messages').send({
      message: 'Change this widget to an area view.', modeHint: 'analytics_dashboard',
      requestId: 'request-missing-origin',
      routeScope: { kind: 'analytics_dashboard', dashboardId: 'dash_scope', selectedWidgetIds: ['widget_scope'] },
      stream: true,
    });
    expect(response.status).toBe(403);
    expect(response.body.error).toContain('same-origin dashboard attestation');
    expect(getDashboard).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
    expect((db.prepare('SELECT COUNT(*) AS count FROM chat_messages').get() as { count: number }).count).toBe(0);
  });

  it('hands a deictic edit with no selection to the model instead of a canned "select a widget" reply', async () => {
    const getDashboard = vi.fn(() => ({ id: 'dash_scope', widgets: [{ id: 'widget_scope' }] }));
    const { app, sendMessage } = appWithScope(getDashboard);
    const response = await request(app).post('/api/chat/messages')
      .set('Host', 'localhost:7778')
      .set('Origin', 'http://localhost:7778')
      .send({
        message: 'Change this widget to an area view.', modeHint: 'analytics_dashboard',
        requestId: 'request-empty-selection',
        routeScope: { kind: 'analytics_dashboard', dashboardId: 'dash_scope', selectedWidgetIds: [] },
        stream: true,
      });
    expect(response.status).toBe(200);
    expect(response.text).not.toContain('Select exactly one widget');
    expect(response.text).toContain('General fallback reply.');
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it('keeps generic task creation general and ignores ambient route scope', async () => {
    const getDashboard = vi.fn(() => { throw new Error('general chat must not canonicalize analytics scope'); });
    const { app, sendMessage } = appWithScope(getDashboard);
    const response = await request(app).post('/api/chat/messages').send({
      message: 'Create a task to review this chart.',
      modeHint: 'analytics_dashboard',
      requestId: 'request-general-route',
      routeScope: { kind: 'analytics_dashboard', dashboardId: 'dash_missing', selectedWidgetIds: ['widget_missing'] },
      stream: true,
    });
    expect(response.status).toBe(200);
    expect(response.text).toContain('General fallback reply.');
    expect(getDashboard).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });
});


describe('streamed chat deterministic analytics edit receipt finalization', () => {
  let storage: StorageLayer;

  beforeEach(() => {
    storage = createStorage(':memory:');
    storage.initialize();
  });

  afterEach(() => storage.close());

  it.each([
    {
      label: 'pending',
      message: 'Change this widget date range from 2026-09-01 through 2026-09-02.',
      args: {
        action: 'date_range', dashboardId: 'dash_scope', widgetIds: ['widget_scope'],
        dateRange: { start: '2026-09-01', end: '2026-09-02' }, ownerRequested: true,
      },
      receipt: {
        status: 'pending', action: 'date_range', mutationApplied: true, dataReady: false,
        dashboard: { id: 'dash_scope', title: 'Synthetic structural dashboard' },
        widget: { id: 'widget_scope', title: 'Synthetic scoped trend', revision: 2, bindingRevision: 2 },
        sourceWidgetIds: ['widget_scope'], resultDisposition: 'refresh_queued',
        run: { id: 'run_pending', status: 'running' },
        responseGuidance: { requiredAnchors: ['dash_scope', 'widget_scope', 'run_pending'], claim: 'still_running' },
      },
      expected: 'Do not resubmit this edit',
    },
    {
      label: 'durable replay',
      message: 'Create a new point chart from this selected widget.',
      args: {
        action: 'add_from_widget', dashboardId: 'dash_scope', widgetIds: ['widget_scope'],
        presentation: { renderer: 'point', title: 'Durable point view' }, ownerRequested: true,
      },
      receipt: {
        status: 'completed', action: 'add_from_widget', mutationApplied: true, dataReady: true,
        dashboard: { id: 'dash_scope', title: 'Synthetic structural dashboard' },
        widget: { id: 'widget_created_f2', title: 'Durable point view', revision: 1, bindingRevision: 1 },
        sourceWidgetIds: ['widget_scope'], createdWidgetId: 'widget_created_f2', resultDisposition: 'refresh_queued',
        run: { id: 'run_created_f2', status: 'completed' },
        receiptId: 'aedit_aaaaaaaaaaaaaaaa', intentVersion: 1,
        intentSha256: '1'.repeat(64), effectSha256: '2'.repeat(64),
        explicitNew: false, idempotentReplay: true, replayReason: 'semantic_intent', effectAppliedThisCall: false,
        responseGuidance: {
          requiredAnchors: ['dash_scope', 'widget_scope', 'widget_created_f2', 'run_created_f2', 'aedit_aaaaaaaaaaaaaaaa'],
          claim: 'completed',
        },
      },
      expected: 'no duplicate effect was created',
    },
    {
      label: 'blocked',
      message: 'Change this widget to an area visualization.',
      args: {
        action: 'presentation', dashboardId: 'dash_scope', widgetIds: ['widget_scope'],
        presentation: { renderer: 'area' }, ownerRequested: true,
      },
      receipt: {
        status: 'blocked', code: 'active_run', action: 'presentation', mutationApplied: false,
        dashboard: { id: 'dash_scope', title: 'Synthetic structural dashboard' },
        sourceWidgetIds: ['widget_scope'], reason: 'An exact selective refresh is active.',
        nextAction: 'Wait for run_active to finish.',
        responseGuidance: { requiredAnchors: ['dash_scope', 'widget_scope'], claim: 'not_completed' },
      },
      expected: 'No dashboard mutation was applied',
    },
  ])('finalizes a trusted $label receipt with no narration stream or grounding retry', async ({ message, args, receipt, expected }) => {
    const llmClient = {
      getActiveEndpoint: () => 'ecs', getContextWindow: () => 262144,
      getDefaultModel: () => 'openai.gpt-5.6-terra',
      chatCompletionStream: vi.fn(() => (async function* () {
        return streamResult({
          toolCalls: [{ id: 'edit-final-call', type: 'function', function: { name: 'edit_analytics_dashboard', arguments: JSON.stringify(args) } }],
          finishReason: 'tool_calls',
        });
      })()),
    };
    const toolExecutor = {
      executeTool: vi.fn(async (toolCall: any, context: any) => ({
        toolCallId: toolCall.id,
        isError: ['blocked', 'failed', 'cancelled'].includes(receipt.status),
        content: JSON.stringify({ requestId: context.ownerRequestId, ...receipt }),
      })),
    };
    const dashboard = {
      id: 'dash_scope', title: 'Synthetic structural dashboard',
      widgets: [{ id: 'widget_scope', title: 'Synthetic scoped trend', revision: 1, bindingRevision: 1 }],
    };
    const db = storage.getDb();
    const app = express();
    app.use(express.json());
    app.use('/api', createRouter({
      nodeManager: createNodeManager(db), db,
      llmClient: llmClient as any,
      toolExecutor: toolExecutor as any,
      promptManager: createPromptManager(),
      analyticsService: { getDashboard: () => dashboard } as any,
      chatInterface: { getHistory: () => [], sendMessage: vi.fn() } as any,
      conversationManager: {
        getActiveSessionId: () => null, createSession: () => 'session-final',
        appendUser: vi.fn(), appendAssistant: vi.fn(), countUserMessages: () => 1,
        getSummary: () => null, getMessages: () => [], getMessagesSinceId: () => [], getRecentMessages: () => [], saveSummary: vi.fn(),
      } as any,
    }));
    const response = await request(app).post('/api/chat/messages')
      .set('Host', 'localhost:7778')
      .set('Origin', 'http://localhost:7778')
      .send({
      message,
      modeHint: 'analytics_dashboard',
      requestId: `request-final-${receipt.status}`,
      routeScope: { kind: 'analytics_dashboard', dashboardId: 'dash_scope', selectedWidgetIds: ['widget_scope'] },
      stream: true,
    });
    expect(response.status).toBe(200);
    expect(response.text).toContain(expected);
    expect(response.text).not.toContain('"reason":"analytics_grounding"');
    expect(llmClient.chatCompletionStream).toHaveBeenCalledTimes(1);
    expect(toolExecutor.executeTool).toHaveBeenCalledTimes(1);
    const persisted = db.prepare("SELECT content FROM chat_messages WHERE role = 'assistant' ORDER BY rowid DESC LIMIT 1").get() as { content: string };
    expect(persisted.content).toContain('dash_scope');
    expect(persisted.content).toContain('widget_scope');
  });
});


describe('streamed chat exact-task data-room isolation', () => {
  let storage: StorageLayer;

  beforeEach(() => {
    storage = createStorage(':memory:');
    storage.initialize();
  });

  afterEach(() => storage.close());

  it('does not retrieve or inject an owner-mentioned unrelated dataset for an unbound selected widget', async () => {
    const seenRequests: any[] = [];
    const llmClient = {
      getActiveEndpoint: () => 'ecs', getContextWindow: () => 262144,
      getDefaultModel: () => 'openai.gpt-5.6-terra',
      chatCompletionStream: vi.fn((input: any) => {
        seenRequests.push(input);
        return (async function* () {
          const content = 'No mutation completed for dash_scope and widget_scope on Synthetic structural dashboard.';
          yield { type: 'content', text: content };
          return streamResult({ content });
        })();
      }),
    };
    const listDatasets = vi.fn(() => [{ id: 'ds_unrelated', name: 'Unrelated business data', domainKey: 'unrelated' }]);
    const getDataset = vi.fn(() => ({
      id: 'ds_unrelated', name: 'Unrelated business data', domainKey: 'unrelated',
      head: { versionId: 'dsv_bbbbbbbbbbbbbbbbbbbbbbbb' }, definition: { answer: {} },
      contract: { metric: { id: 'unrelated_metric' }, regime: { id: 'unrelated' }, countingKey: 'id', unit: 'items', grain: 'day', availableDimensions: ['day'], timeField: 'day', timeZone: 'UTC', coverage: {}, contractSha256: '9'.repeat(64), handling: { allowedUses: ['dashboard'] } },
    }));
    const dashboard = {
      id: 'dash_scope', title: 'Synthetic structural dashboard',
      widgets: [{ id: 'widget_scope', title: 'Synthetic scoped trend', revision: 1, bindingRevision: 0 }],
    };
    const db = storage.getDb();
    const app = express();
    app.use(express.json());
    app.use('/api', createRouter({
      nodeManager: createNodeManager(db), db,
      llmClient: llmClient as any,
      toolExecutor: { executeTool: vi.fn() } as any,
      promptManager: createPromptManager(),
      analyticsService: { getDashboard: () => dashboard } as any,
      analyticsDataRoom: { listDatasets, getDataset, listDatasetVersions: vi.fn(), getDatasetVersion: vi.fn() } as any,
      chatInterface: { getHistory: () => [], sendMessage: vi.fn() } as any,
      conversationManager: {
        getActiveSessionId: () => null, createSession: () => 'session-isolation',
        appendUser: vi.fn(), appendAssistant: vi.fn(), countUserMessages: () => 1,
        getSummary: () => null, getMessages: () => [], getMessagesSinceId: () => [], getRecentMessages: () => [], saveSummary: vi.fn(),
      } as any,
    }));
    const response = await request(app).post('/api/chat/messages')
      .set('Host', 'localhost:7778')
      .set('Origin', 'http://localhost:7778')
      .send({
        message: 'Change this widget to an area visualization; ds_unrelated is unrelated.', modeHint: 'analytics_dashboard',
        requestId: 'request-unbound-isolation',
        routeScope: { kind: 'analytics_dashboard', dashboardId: 'dash_scope', selectedWidgetIds: ['widget_scope'] },
        stream: true,
      });
    expect(response.status).toBe(200);
    expect(llmClient.chatCompletionStream).toHaveBeenCalledTimes(1);
    expect(listDatasets).not.toHaveBeenCalled();
    expect(getDataset).not.toHaveBeenCalled();
    expect(seenRequests[0].messages[0].content).toContain('No canonical data-room dataset is bound');
    expect(seenRequests[0].messages[0].content).not.toContain('ds_unrelated');
    expect(seenRequests[0].messages[0].content).not.toContain('Unrelated business data');
  });
});


describe('streamed chat edit finalization visual disclosure', () => {
  let storage: StorageLayer;

  beforeEach(() => {
    storage = createStorage(':memory:');
    storage.initialize();
  });

  afterEach(() => storage.close());

  it('does not fast-finalize past the unsupported-attachment coverage warning', async () => {
    const editArgs = {
      action: 'presentation', dashboardId: 'dash_scope', widgetIds: ['widget_scope'],
      presentation: { renderer: 'area' }, ownerRequested: true,
    };
    let invocation = 0;
    const llmClient = {
      getActiveEndpoint: () => 'ecs', getContextWindow: () => 262144,
      getDefaultModel: () => 'openai.gpt-5.6-terra',
      chatCompletionStream: vi.fn(() => {
        const current = invocation++;
        return (async function* () {
          if (current === 0) return streamResult({
            toolCalls: [{ id: 'edit-visual-call', type: 'function', function: { name: 'edit_analytics_dashboard', arguments: JSON.stringify(editArgs) } }],
            finishReason: 'tool_calls',
          });
          const content = 'Completed presentation for dash_scope, widget_scope, and Synthetic structural dashboard.';
          yield { type: 'content', text: content };
          return streamResult({ content });
        })();
      }),
    };
    const toolExecutor = { executeTool: vi.fn(async (toolCall: any, context: any) => ({
      toolCallId: toolCall.id, isError: false,
      content: JSON.stringify({
        requestId: context.ownerRequestId, status: 'completed', action: 'presentation', mutationApplied: true, dataReady: true,
        dashboard: { id: 'dash_scope', title: 'Synthetic structural dashboard' },
        widget: { id: 'widget_scope', title: 'Synthetic scoped trend', revision: 2, bindingRevision: 1 },
        sourceWidgetIds: ['widget_scope'], resultDisposition: 'preserved',
        responseGuidance: { requiredAnchors: ['dash_scope', 'widget_scope'], claim: 'completed' },
      }),
    })) };
    const dashboard = { id: 'dash_scope', title: 'Synthetic structural dashboard', widgets: [{ id: 'widget_scope', title: 'Synthetic scoped trend' }] };
    const visualAssets = {
      getByReference: vi.fn(() => null),
      registerBuffer: vi.fn(() => { throw new Error('WebP is unsupported by the local visual reader.'); }),
      formatManifest: vi.fn(() => 'No inspectable visual assets were registered for this turn.'),
    };
    const db = storage.getDb();
    const app = express();
    app.use(express.json({ limit: '2mb' }));
    app.use('/api', createRouter({
      nodeManager: createNodeManager(db), db,
      llmClient: llmClient as any, toolExecutor: toolExecutor as any,
      promptManager: createPromptManager(), visualAssets: visualAssets as any,
      analyticsService: { getDashboard: () => dashboard } as any,
      chatInterface: { getHistory: () => [], sendMessage: vi.fn() } as any,
      conversationManager: {
        getActiveSessionId: () => null, createSession: () => 'session-visual',
        appendUser: vi.fn(), appendAssistant: vi.fn(), countUserMessages: () => 1,
        getSummary: () => null, getMessages: () => [], getMessagesSinceId: () => [], getRecentMessages: () => [], saveSummary: vi.fn(),
      } as any,
    }));
    const uploaded = await request(app).post('/api/chat/attachments').send({ dataUrl: 'data:image/webp;base64,AAECAw==' });
    expect(uploaded.status).toBe(200);
    expect(uploaded.body.visualInspection.status).toBe('unsupported');
    const attachmentId = String(uploaded.body.id);
    try {
      const response = await request(app).post('/api/chat/messages')
        .set('Host', 'localhost:7778')
        .set('Origin', 'http://localhost:7778')
        .send({
          message: 'Change this widget to an area visualization.', modeHint: 'analytics_dashboard',
          requestId: 'request-unsupported-visual', attachments: [attachmentId],
          routeScope: { kind: 'analytics_dashboard', dashboardId: 'dash_scope', selectedWidgetIds: ['widget_scope'] },
          stream: true,
        });
      expect(response.status).toBe(200);
      expect(llmClient.chatCompletionStream).toHaveBeenCalledTimes(2);
      expect(response.text).toContain('format not yet supported by the local visual reader');
      expect(response.text).toContain(attachmentId);
    } finally {
      fs.rmSync(path.join(os.homedir(), '.personal-productivity-tracker', 'chat-attachments', `${attachmentId}.webp`), { force: true });
    }
  });
});