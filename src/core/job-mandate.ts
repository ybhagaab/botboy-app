/**
 * The job mandate gate (ANALYTICS_AUTONOMY_PLAN.md, owner decision D1,
 * 2026-10-08): what a continuation turn may do with no owner in the loop.
 *
 * A continuation turn (callerKind 'continuation') works on the job the owner
 * asked for. It may take the job's steps: reads, warehouse SQL, scratch ETL
 * queries and their fixes, Data Room imports, BotBoy dashboards, files, shell,
 * and visual checks. It may not send, post, publish, sync, schedule, change
 * production pipelines, open terminals, drive the browser, change
 * connections, or edit the workspace; those need the owner's explicit ask in
 * a live chat turn. The allowlist is closed: a tool not named here is refused,
 * so a new effect tool is never admitted by accident.
 *
 * This wrapper must be the OUTERMOST executor (index.ts): the Gmail and
 * product-document wrappers answer their tools before the base executor, and
 * several base handlers call MCP writes with a server-set ownerApproved.
 * Owner turns pass through unchanged.
 */
import type { ChatJobStore } from './chat-jobs.js';
import type { ToolCall } from './llm-client.js';
import type { ToolExecutionContext, ToolExecutor, ToolResult } from './tool-executor.js';

/** Tools a continuation turn may call. Everything else is outside the job mandate. */
export const JOB_SCOPE_TOOLS: ReadonlySet<string> = new Set([
  // Workspace and evidence reads
  'get_today', 'list_projects', 'get_project_brain', 'get_channels', 'list_nodes', 'get_node_items',
  'search_items', 'query_db', 'get_chat_messages', 'list_documents', 'read_document', 'read_spreadsheet',
  'list_lessons', 'propose_lesson', 'web_search', 'web_fetch',
  // Data Room and BotBoy dashboards (local, reversible)
  'list_data_room_datasets', 'query_data_room', 'create_data_room_dataset', 'configure_analytics_widget_source',
  'edit_analytics_dashboard', 'list_analytics_dashboards', 'get_analytics_dashboard', 'create_analytics_dashboard',
  'update_analytics_dashboard', 'refresh_analytics_dashboard', 'get_dashboard_sharing_status',
  // Warehouse SQL (read-only by policy) and analytics knowledge
  'mcp_sql_list_presets', 'mcp_sql_get_schema_context', 'mcp_sql_list_schemas', 'mcp_sql_list_tables',
  'mcp_sql_describe_table', 'mcp_sql_sample_data', 'mcp_sql_query', 'mcp_analytics_list_context',
  'mcp_analytics_load_context',
  // MCP reads (mcp_call_tool runs read-tier only here)
  'mcp_status', 'mcp_describe_tool', 'mcp_get_custom_server_config', 'mcp_call_tool',
  // Datanet ETL: reads, scratch queries, and the job's own runs
  'mcp_etl_job_run', 'mcp_etl_latest_run', 'mcp_etl_runs_for_job', 'mcp_etl_job', 'mcp_etl_profile_sql',
  'mcp_etl_search', 'mcp_etl_diagnose_run', 'mcp_etl_download_results', 'mcp_etl_run_query',
  'wait_for_etl_run', 'mcp_etl_alter_run',
  // Files, shell (Seatbelt-sandboxed), visual checks
  'write_file', 'read_file', 'run_command', 'ui_inspect', 'ui_console_errors', 'ui_screenshot',
  'browser_screenshot', 'inspect_visual_assets',
  // The job itself
  'job_update',
]);

/** Run actions a continuation may take, and only on runs this job watches. */
const OWN_RUN_ACTIONS = new Set(['prioritize', 'restart', 'kill']);

export function isJobScopeTool(name: string): boolean {
  return JOB_SCOPE_TOOLS.has(name);
}

/** The tool list a continuation turn is offered. */
export function filterToolsForContinuation<T extends { function: { name: string } }>(tools: T[]): T[] {
  return tools.filter(tool => JOB_SCOPE_TOOLS.has(tool.function.name));
}

function refusal(call: ToolCall, code: string, error: string, nextAction: string): ToolResult {
  return {
    toolCallId: call.id,
    content: JSON.stringify({ status: 'blocked', code, error, nextAction }),
    isError: true,
  };
}

function parseArgs(call: ToolCall): Record<string, any> {
  try {
    const value = JSON.parse(call.function.arguments || '{}');
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

export function withJobMandate(executor: ToolExecutor, options: { jobs?: ChatJobStore }): ToolExecutor {
  return {
    async executeTool(call: ToolCall, context: ToolExecutionContext = {}): Promise<ToolResult> {
      if (context.callerKind !== 'continuation') return executor.executeTool(call, context);
      const name = call.function.name;
      const jobId = context.jobMandate?.jobId;
      const job = jobId ? options.jobs?.get(jobId) : null;
      if (!job || job.status !== 'active') {
        return refusal(call, 'job_not_active', 'This continuation has no active job, so it cannot take job steps.',
          'Stop and report what is done; the owner can continue in chat.');
      }
      if (!JOB_SCOPE_TOOLS.has(name)) {
        return refusal(call, 'outside_job_mandate',
          `${name} sends, publishes, syncs, schedules, changes production, or acts outside BotBoy's data work, so it needs the owner's explicit ask in chat.`,
          'Finish what the job allows, then say in your reply what you would do next and that it needs the owner\'s go-ahead.');
      }
      if (name === 'mcp_call_tool') {
        // Read-tier only: the MCP policy blocks every write-tier tool when the
        // call is not owner-approved.
        const args = parseArgs(call);
        return executor.executeTool({
          ...call,
          function: { ...call.function, arguments: JSON.stringify({ ...args, ownerRequested: false }) },
        }, context);
      }
      if (name === 'mcp_etl_alter_run') {
        const args = parseArgs(call);
        const runId = String(args.runId ?? '').trim();
        const action = String(args.action ?? '').trim().toLowerCase();
        if (!OWN_RUN_ACTIONS.has(action) || !options.jobs?.isJobRun(job.id, runId)) {
          return refusal(call, 'outside_job_mandate',
            `Run ${runId || '(none)'} is not one of this job's own ETL runs, so changing it needs the owner's explicit ask in chat.`,
            'Act only on runs this job submitted (see the ACTIVE JOB block); report anything else to the owner.');
        }
      }
      return executor.executeTool(call, context);
    },
  };
}
