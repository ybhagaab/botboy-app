import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createStorage, type StorageLayer } from './storage.js';
import { createNodeManager } from './node-manager.js';
import { createMcpManager } from './mcp-manager.js';
import type { McpManager } from './mcp-types.js';
import { createToolExecutor } from './tool-executor.js';
import { exportFooterSetConfirmed, withWorkplaceChatTools } from './workplace-chat-tools.js';
import { createExportFooterSettings, type ExportFooterSettings } from '../product-manager/export-footer.js';
import { filterToolsForContinuation } from './job-mandate.js';

/** Settings → Workplace in chat (design §8.4, §10.4, §16 item 6). */
const call = (name: string, args: Record<string, unknown> = {}) => ({
  id: `call-${name}`, type: 'function' as const, function: { name, arguments: JSON.stringify(args) },
});
const ownerTurn = { callerKind: 'interactive' as const, currentUserMessage: 'set my export footer to Internal draft', ownerRequestId: 'req-1' };

describe('withWorkplaceChatTools', () => {
  let storage: StorageLayer;
  let amazon: boolean;
  let footer: ExportFooterSettings;
  const base = { executeTool: vi.fn(async (toolCall: any) => ({ toolCallId: toolCall.id, content: 'base', isError: false })) };
  beforeEach(() => {
    storage = createStorage(':memory:');
    storage.initialize();
    amazon = true;
    footer = createExportFooterSettings({ db: storage.getDb(), amazonEmployee: () => amazon });
    base.executeTool.mockClear();
  });
  afterEach(() => storage.close());
  const executor = () => withWorkplaceChatTools(base as any, { workplace: { amazonEmployee: () => amazon }, exportFooter: footer });

  it('refuses Amazon-only tools while off without calling the base executor', async () => {
    amazon = false;
    for (const name of ['mcp_etl_search', 'sharepoint_add_comment', 'publish_static_artifact_to_harmony', 'read_document']) {
      const result = await executor().executeTool(call(name));
      expect(result.isError).toBe(true);
      expect(JSON.parse(result.content)).toMatchObject({ ok: false, code: 'amazon_employee_off', effect: 'none' });
    }
    expect(base.executeTool).not.toHaveBeenCalled();
  });

  it('refuses a dataset plan with an ETL source while off; a local_file plan delegates', async () => {
    amazon = false;
    const etl = await executor().executeTool(call('create_data_room_dataset', { action: 'create', plan: { sources: [{ kind: 'local_file' }, { kind: 'etl_query' }] } }));
    expect(JSON.parse(etl.content)).toMatchObject({
      code: 'amazon_employee_off', effect: 'none',
      message: 'ETL sources are part of Amazon internal paths, which are off on this install.',
      nextAction: 'Use a local_file, sql_query, Import Inbox, or existing-version source instead.',
    });
    expect(base.executeTool).not.toHaveBeenCalled();
    await executor().executeTool(call('create_data_room_dataset', { action: 'create', plan: { sources: [{ kind: 'local_file' }] } }));
    expect(base.executeTool).toHaveBeenCalledOnce();
  });

  it('delegates everything while on', async () => {
    await executor().executeTool(call('mcp_etl_search'));
    await executor().executeTool(call('create_data_room_dataset', { action: 'create', plan: { sources: [{ kind: 'etl_query' }] } }));
    expect(base.executeTool).toHaveBeenCalledTimes(2);
  });

  it('export_footer get works for any caller', async () => {
    const result = await executor().executeTool(call('export_footer', { action: 'get' }), { callerKind: 'background' });
    expect(JSON.parse(result.content)).toMatchObject({ ok: true, footer: { text: '', source: 'default' }, settingsPath: '#/settings/workplace' });
  });

  it('export_footer set needs the owner’s live turn, a request id, and ownerRequested', async () => {
    const set = (context: any, extra: Record<string, unknown> = {}) => executor().executeTool(
      call('export_footer', { action: 'set', text: 'Internal draft', ownerRequested: true, ...extra }), context,
    );
    for (const context of [
      { ...ownerTurn, callerKind: 'background' },
      { ...ownerTurn, callerKind: 'continuation' },
      { ...ownerTurn, currentUserMessage: '' },
      { ...ownerTurn, ownerRequestId: '' },
    ]) {
      expect(JSON.parse((await set(context)).content)).toMatchObject({ ok: false, code: 'owner_request_required', effect: 'none' });
    }
    expect(JSON.parse((await set(ownerTurn, { ownerRequested: false })).content).code).toBe('owner_request_required');
    expect(JSON.parse((await set(ownerTurn, { text: 'a\nb' })).content)).toMatchObject({ ok: false, code: 'invalid_footer' });
    const ok = await set(ownerTurn);
    expect(JSON.parse(ok.content)).toMatchObject({ ok: true, action: 'set', footer: { text: 'Internal draft', source: 'owner' }, previous: { text: '' }, effect: 'future_exports' });
    expect(footer.effective()).toBe('Internal draft');
    expect(exportFooterSetConfirmed(ok.content)).toBe(true);
  });

  it('exportFooterSetConfirmed counts only a confirmed set', async () => {
    expect(exportFooterSetConfirmed(JSON.stringify({ ok: true, footer: {} }))).toBe(false);
    expect(exportFooterSetConfirmed(JSON.stringify({ ok: false, code: 'owner_request_required' }))).toBe(false);
    expect(exportFooterSetConfirmed('not json')).toBe(false);
  });

  it('is not a job-scope tool, so continuations cannot set it', () => {
    const tools = filterToolsForContinuation([{ type: 'function', function: { name: 'export_footer', description: '', parameters: {} } }] as any);
    expect(tools.map((tool: any) => tool.function.name)).not.toContain('export_footer');
  });
});

describe('tool executor refusals for servers hidden by Amazon Employee', () => {
  let storage: StorageLayer;
  let manager: McpManager;
  let amazon = true;
  const secretStore = { async get() { return null; }, async set() {}, async delete() {}, async has() { return false; } };
  beforeEach(async () => {
    storage = createStorage(':memory:');
    storage.initialize();
    amazon = true;
    manager = createMcpManager({ db: storage.getDb(), secretStore: secretStore as any, healthIntervalMs: 3_600_000, amazonEmployee: () => amazon });
    await manager.start();
    await manager.createCustomServer({ name: 'Aim Tool', command: 'aim', args: ['mcp', 'start-server', 'x'] });
    amazon = false;
  });
  afterEach(async () => {
    await manager.stop();
    storage.close();
  });
  const run = async (name: string, args: Record<string, unknown>) => {
    const executor = createToolExecutor(storage.getDb(), createNodeManager(storage.getDb()), { mcpManager: manager });
    const result = await executor.executeTool(call(name, args), ownerTurn);
    return { ...result, body: JSON.parse(result.content) };
  };

  it('returns one structured body for each MCP tool on a hidden AIM server', async () => {
    const stop = vi.spyOn(manager, 'stopProfile');
    const update = vi.spyOn(manager, 'updateCustomServer');
    for (const [name, args] of [
      ['mcp_call_tool', { serverId: 'custom-aim-tool', toolName: 'x', arguments: {} }],
      ['mcp_profile_action', { profileId: 'custom-aim-tool', action: 'start' }],
      ['mcp_describe_tool', { serverId: 'custom-aim-tool', toolName: 'x' }],
      ['mcp_update_custom_server', { serverId: 'custom-aim-tool', name: 'Aim Tool', command: 'aim', ownerRequested: true }],
      ['mcp_get_custom_server_config', { serverId: 'custom-aim-tool' }],
      ['mcp_add_custom_server', { name: 'Another Aim', command: 'aim', args: [], ownerRequested: true }],
    ] as const) {
      const result = await run(name, args as any);
      expect(result.isError, name).toBe(true);
      expect(result.body, name).toMatchObject({ ok: false, code: 'amazon_employee_off', effect: 'none' });
      expect(result.content, name).not.toContain('"command"');
    }
    expect(stop).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it('mcp_status lists only visible servers', async () => {
    const executor = createToolExecutor(storage.getDb(), createNodeManager(storage.getDb()), { mcpManager: manager });
    const listed = JSON.parse((await executor.executeTool(call('mcp_status'), ownerTurn)).content).map((entry: any) => entry.id);
    expect(listed).toContain('sql-context');
    expect(listed).not.toContain('custom-aim-tool');
    expect(listed).not.toContain('slack');
  });
});
