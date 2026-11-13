/**
 * The job mandate gate (ANALYTICS_AUTONOMY_PLAN.md, owner decision D1,
 * 2026-10-08): what a continuation turn may do with no owner in the loop.
 *
 * A continuation turn (callerKind 'continuation') works on the job the owner
 * asked for. It may take the job's steps: reads, warehouse SQL, scratch ETL
 * queries and their fixes, Data Room imports, BotBoy dashboards, BotBoy
 * documents (read, edit, save), files, shell, visual checks, and the browser
 * on BotBoy's own tabs. It may not send, post, publish, sync, schedule, change
 * production pipelines, open terminals, change connections, or edit the
 * workspace; those need the owner's explicit ask in a live chat turn. The
 * allowlist is closed: a tool not named here is refused, so a new effect tool
 * is never admitted by accident.
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
  // BotBoy documents (owner requests 2026-10-22): a job that researches and then writes reads, edits and saves the
  // documents it works on, a new one or a full rewrite included. A save never overwrites: a rewrite is the next version.
  'read_product_document', 'edit_product_document', 'save_product_document',
  // Google Drive, Docs, Sheets, Slides, Forms and Calendar (owner request 2026-10-23, "same permissions for jobs" as the
  // document tools): a job finds, reads, creates, edits, uploads, downloads and organizes files and changes its own
  // calendar events. The handlers refuse what reaches other people (a published form, an event with guests, a reply to
  // an invitation) with outside_job_mandate, and gdrive_share (sharing and comments) is never here.
  'gdrive_search', 'gdrive_read', 'gdrive_edit', 'gdrive_files', 'gcalendar',
  'list_lessons', 'propose_lesson', 'web_search', 'web_fetch',
  // Data Room and BotBoy dashboards (local, reversible)
  'list_data_room_datasets', 'query_data_room', 'create_data_room_dataset', 'configure_analytics_widget_source',
  'edit_analytics_dashboard', 'list_analytics_dashboards', 'get_analytics_dashboard', 'create_analytics_dashboard',
  'update_analytics_dashboard', 'refresh_analytics_dashboard', 'get_dashboard_sharing_status',
  // Warehouse SQL (read-only by policy) and analytics knowledge
  'mcp_sql_list_presets', 'mcp_sql_get_schema_context', 'mcp_sql_list_schemas', 'mcp_sql_list_tables',
  'mcp_sql_describe_table', 'mcp_sql_sample_data', 'mcp_sql_query', 'mcp_analytics_list_context',
  'mcp_analytics_load_context',
  // Stopping the job's own queries (owner request 2026-11-12, docs/maps/query-control.md): a continuation's cancel_query lists
  // and stops only the SQL queries and ETL runs this job started; ownerRequested never widens it in a job's own turns.
  'cancel_query',
  // The Knowledge library: reads, and the stage-only proposal (like propose_lesson it only stages an approval card; nothing
  // in this list can change the library). knowledge_write and knowledge_create_set must never be added here: a
  // continuation can propose, never write (amendment P2-6; job-mandate.test.ts pins the exact difference).
  'knowledge_list', 'knowledge_load', 'knowledge_propose',
  // MCP reads (mcp_call_tool runs read-tier only here)
  'mcp_status', 'mcp_describe_tool', 'mcp_get_custom_server_config', 'mcp_call_tool',
  // Datanet ETL: reads, scratch queries, and the job's own runs
  'mcp_etl_job_run', 'mcp_etl_latest_run', 'mcp_etl_runs_for_job', 'mcp_etl_job', 'mcp_etl_profile_sql',
  'mcp_etl_search', 'mcp_etl_diagnose_run', 'mcp_etl_download_results', 'mcp_etl_run_query',
  'wait_for_etl_run', 'mcp_etl_alter_run',
  // Waiting without spending turns (docs/maps/job-waits.md): an export, a Data Room job, a file, the terminal, a connection, a time.
  'wait_for',
  // Files, shell (Seatbelt-sandboxed), visual checks, and the browser: browser_hands opens, reads, clicks, types and
  // fills on the external tabs BotBoy opened itself (owner request 2026-10-22: jobs need it to finish their work).
  'write_file', 'read_file', 'edit_file', 'run_command', 'ui_inspect', 'ui_console_errors', 'ui_screenshot',
  'browser_hands', 'browser_screenshot', 'inspect_visual_assets',
  // Disk (owner approval 2026-10-29): a job deletes only its own working files, and only after BotBoy has checked that the
  // gzip copy holds the same bytes (job-working-files.ts). Deleting commands in run_command are refused below.
  'delete_working_file',
  // The job itself
  'job_update',
]);

/**
 * Shell commands that delete files. In an automatic job turn a file is deleted only through delete_working_file (the file is
 * the job's own, its gzip copy holds the same bytes). The Seatbelt sandbox stays the hard boundary; this keeps an unattended
 * turn from deleting by habit (owner approval 2026-10-29).
 */
const DELETING_COMMAND = /(?:^|[\s;&|(`$/])(?:rm|unlink|rmdir|shred|trash|srm)(?:\s|$)|\bfind\b[^;&|]*\s-delete\b|\bshutil\.rmtree\b|\bos\.(?:remove|unlink|rmdir|removedirs)\b|\.(?:unlink|rmdir|rm)(?:Sync)?\s*\(|\bfs\.(?:rm|rmSync|unlink|unlinkSync|rmdir|rmdirSync)\b|\bsend2trash\b/;
export function isDeletingCommand(command: string): boolean {
  return DELETING_COMMAND.test(String(command ?? ''));
}

/**
 * Tools the main chat's own look at a job update may call (callerKind 'review', PARALLEL_JOBS_PLAN.md §12 Identity; owner
 * decision 2026-11-09: the main chat "uses its own intelligence & is able to use all tools to pull context details"). Every
 * read the main chat has, and `jobs` to act on the job (continue, message, ask the owner). Nothing that changes anything else:
 * no writes, no shell, no runs, no browser clicks, no sending; the job does its own work. Closed like JOB_SCOPE_TOOLS.
 */
export const REVIEW_TOOLS: ReadonlySet<string> = new Set([
  // Workspace, evidence and documents. Google Drive reads are not here: their own gate admits only the owner's live turn or a
  // job's turn, so they would always refuse; the job reads them itself when the main chat asks it to.
  'get_today', 'list_projects', 'get_project_brain', 'get_channels', 'list_nodes', 'get_node_items',
  'search_items', 'query_db', 'get_chat_messages', 'list_documents', 'read_document', 'read_spreadsheet', 'read_product_document',
  'list_lessons', 'web_search', 'web_fetch',
  // Dashboards and the Data Room: reads only. The Data Room reads admit a job update for an active job (owner decision 2026-11-10:
  // jobs are the main chat's extension, and the main chat leads them with the same view of the data).
  'list_analytics_dashboards', 'get_analytics_dashboard', 'get_dashboard_sharing_status',
  'list_data_room_datasets', 'query_data_room',
  // Warehouse SQL (read-only by policy) and analytics knowledge
  'mcp_sql_list_presets', 'mcp_sql_get_schema_context', 'mcp_sql_list_schemas', 'mcp_sql_list_tables',
  'mcp_sql_describe_table', 'mcp_sql_sample_data', 'mcp_sql_query', 'mcp_analytics_list_context', 'mcp_analytics_load_context',
  'knowledge_list', 'knowledge_load',
  // Connectors: status and reads (mcp_call_tool runs read-tier only here)
  'mcp_status', 'mcp_describe_tool', 'mcp_get_custom_server_config', 'mcp_call_tool',
  // Datanet ETL: reads of runs and jobs, never a submit, download or change
  'mcp_etl_job_run', 'mcp_etl_latest_run', 'mcp_etl_runs_for_job', 'mcp_etl_job', 'mcp_etl_profile_sql',
  'mcp_etl_search', 'mcp_etl_diagnose_run',
  // Files and BotBoy's own screen, read-only
  'read_file', 'ui_inspect', 'ui_console_errors', 'ui_screenshot', 'inspect_visual_assets',
  // The owner's jobs: read them, keep one going, message it, ask the owner
  'jobs',
]);

/** The tool list an update turn in the main chat is offered. */
export function filterToolsForReview<T extends { function: { name: string } }>(tools: T[]): T[] {
  return tools.filter(tool => REVIEW_TOOLS.has(tool.function.name));
}

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
      // The main chat's own look at a job update: reads and `jobs` only (§12 Identity).
      if (context.callerKind === 'review') {
        const name = call.function.name;
        if (!REVIEW_TOOLS.has(name)) {
          return refusal(call, 'outside_job_update',
            `${name} is not a job update's tool: a job update reads and decides about the job, the job does its own work, and sending, publishing and sharing stay the owner's.`,
            'Tell the job what to do with jobs message, or leave it for the owner and say in one line what it needs.');
        }
        if (name === 'mcp_call_tool') {
          const args = parseArgs(call);
          return executor.executeTool({ ...call, function: { ...call.function, arguments: JSON.stringify({ ...args, ownerRequested: false }) } }, context);
        }
        return executor.executeTool(call, context);
      }
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
      if (name === 'run_command' && isDeletingCommand(String(parseArgs(call).command ?? ''))) {
        return refusal(call, 'outside_job_mandate',
          'Deleting files in an automatic job turn goes through delete_working_file, which checks that the file is this job\'s own and that its gzip copy holds the same bytes.',
          'Compress the file (gzip -k <file>), then call delete_working_file {"path":"<file>","keptCopy":"<file>.gz"}; leave any other file for the owner.');
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
