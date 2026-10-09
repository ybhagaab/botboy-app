import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createStorage, type StorageLayer } from './storage.js';
import { createChatJobStore, type ChatJobStore } from './chat-jobs.js';
import { filterToolsForContinuation, isJobScopeTool, JOB_SCOPE_TOOLS, withJobMandate } from './job-mandate.js';
import type { ToolExecutionContext } from './tool-executor.js';

/**
 * The job mandate (ANALYTICS_AUTONOMY_PLAN.md D1): a continuation turn takes
 * the job's data steps with no owner present; it never sends, publishes,
 * syncs, schedules, changes production, or drives the owner's surfaces.
 */
describe('job mandate gate', () => {
  let storage: StorageLayer;
  let jobs: ChatJobStore;
  let jobId: string;
  const inner = { executeTool: vi.fn(async (call: any) => ({ toolCallId: call.id, content: `ran ${call.function.name} ${call.function.arguments}` })) };
  beforeEach(() => {
    storage = createStorage(':memory:');
    storage.initialize();
    jobs = createChatJobStore(storage.getDb());
    jobId = jobs.start({ goal: 'Weekly players dashboard' }).id;
    inner.executeTool.mockClear();
  });
  afterEach(() => storage.close());

  const call = (name: string, args: Record<string, unknown> = {}) => ({ id: `${name}-1`, type: 'function' as const, function: { name, arguments: JSON.stringify(args) } });
  const continuation = (): ToolExecutionContext => ({ callerKind: 'continuation', jobMandate: { jobId, goal: 'Weekly players dashboard' }, currentUserMessage: 'Weekly players dashboard' });
  const gate = () => withJobMandate(inner as any, { jobs });

  it('passes owner and background turns through unchanged', async () => {
    const owner = await gate().executeTool(call('gmail_send', { ownerRequested: true }), { callerKind: 'interactive', currentUserMessage: 'email Jane' });
    expect(owner.content).toContain('ran gmail_send');
    const background = await gate().executeTool(call('publish_static_artifact_to_harmony'), { callerKind: 'background' });
    expect(background.content).toContain('ran publish_static_artifact_to_harmony');
  });

  it('admits the job steps of a live job', async () => {
    for (const name of ['mcp_etl_run_query', 'wait_for_etl_run', 'create_data_room_dataset', 'create_analytics_dashboard', 'run_command', 'query_data_room', 'job_update']) {
      const result = await gate().executeTool(call(name), continuation());
      expect(result.content, name).toContain(`ran ${name}`);
    }
  });

  it('refuses effects outside the job, and every step once the job ended', async () => {
    for (const name of ['gmail_send', 'gmail_draft', 'publish_static_artifact_to_harmony', 'sharepoint_edit_docx_body', 'mcp_etl_submit_run', 'mcp_etl_update_profile_sql', 'mcp_etl_force_deps', 'open_terminal', 'browser_hands', 'mcp_profile_action', 'manage_project', 'configure_analytics_schedule', 'some_future_tool']) {
      const result = await gate().executeTool(call(name), continuation());
      expect(JSON.parse(result.content), name).toMatchObject({ status: 'blocked', code: 'outside_job_mandate' });
      expect(result.isError).toBe(true);
    }
    expect(inner.executeTool).not.toHaveBeenCalled();
    jobs.end(jobId, 'stopped', 'owner');
    const ended = await gate().executeTool(call('query_data_room'), continuation());
    expect(JSON.parse(ended.content)).toMatchObject({ code: 'job_not_active' });
    const noJob = await gate().executeTool(call('query_data_room'), { callerKind: 'continuation' });
    expect(JSON.parse(noJob.content)).toMatchObject({ code: 'job_not_active' });
  });

  it('runs mcp_call_tool read-tier only, whatever the model claims', async () => {
    await gate().executeTool(call('mcp_call_tool', { serverId: 'slack', toolName: 'post_message', ownerRequested: true }), continuation());
    const forwarded = JSON.parse(inner.executeTool.mock.calls[0][0].function.arguments);
    expect(forwarded).toMatchObject({ serverId: 'slack', toolName: 'post_message', ownerRequested: false });
  });

  it('alters only the job\'s own runs, and only to prioritize, restart, or kill them', async () => {
    jobs.addWatch({ runId: '901', jobId, source: 'run_query' });
    expect((await gate().executeTool(call('mcp_etl_alter_run', { runId: '901', action: 'prioritize', ownerRequested: true }), continuation())).content).toContain('ran mcp_etl_alter_run');
    const foreign = await gate().executeTool(call('mcp_etl_alter_run', { runId: '902', action: 'kill', ownerRequested: true }), continuation());
    expect(JSON.parse(foreign.content)).toMatchObject({ code: 'outside_job_mandate' });
    const badAction = await gate().executeTool(call('mcp_etl_alter_run', { runId: '901', action: 'force', ownerRequested: true }), continuation());
    expect(JSON.parse(badAction.content)).toMatchObject({ code: 'outside_job_mandate' });
  });

  // Source seam: the Gmail and document wrappers answer their tools before the
  // base executor, so the mandate gate must wrap them all.
  it('is the outermost wrapper of the chat executor (index.ts)', () => {
    const index = readFileSync(path.join(process.cwd(), 'src/index.ts'), 'utf8');
    expect(index).toMatch(/const toolExecutor = withJobMandate\(\s*withWhatsAppChatTools\(withGmailChatTools\(\s*withProductDocumentChatTools\(\s*baseToolExecutor,/);
  });

  it('offers a continuation only the job-scope tools', () => {
    const tools = ['query_db', 'gmail_send', 'mcp_etl_run_query', 'open_terminal'].map(name => ({ type: 'function', function: { name } }));
    expect(filterToolsForContinuation(tools).map(tool => tool.function.name)).toEqual(['query_db', 'mcp_etl_run_query']);
    for (const name of JOB_SCOPE_TOOLS) {
      expect(name).not.toMatch(/^(gmail_|sharepoint_|publish_|open_terminal|send_terminal|browser_hands|manage_|mcp_profile_action|mcp_add_custom|mcp_update_custom)/);
    }
    expect(isJobScopeTool('mcp_etl_submit_run')).toBe(false);
  });
});
