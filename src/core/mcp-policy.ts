import type { McpToolRisk } from './mcp-types.js';

const SQL_CONTEXT_READ_TOOLS = new Set([
  'run_query',
  'list_schemas',
  'list_tables',
  'describe_table',
  'get_sample_data',
  'connection_status',
  'get_schema_context',
  'list_presets',
]);

const FORBIDDEN_SQL_TOKENS = new Set([
  'INSERT', 'UPDATE', 'DELETE', 'MERGE', 'UPSERT', 'REPLACE',
  'DROP', 'ALTER', 'CREATE', 'TRUNCATE', 'RENAME',
  'GRANT', 'REVOKE', 'CALL', 'COPY', 'UNLOAD',
  'VACUUM', 'ANALYZE', 'REFRESH', 'LOCK',
  'SET', 'RESET', 'BEGIN', 'START', 'COMMIT', 'ROLLBACK', 'SAVEPOINT', 'RELEASE',
  'EXECUTE', 'PREPARE', 'DEALLOCATE', 'DISCARD', 'LISTEN', 'NOTIFY', 'DO',
]);

const FORBIDDEN_SQL_FUNCTIONS = new Set([
  'NEXTVAL', 'SETVAL', 'PG_TERMINATE_BACKEND', 'PG_CANCEL_BACKEND',
  'LO_IMPORT', 'LO_EXPORT', 'DBLINK_EXEC',
]);

/**
 * Extract words and statement separators outside SQL strings/comments.
 * Dollar-quoted bodies are rejected entirely: they are useful for functions,
 * but unnecessary for BotBoy's analytical reads and make safe inspection
 * ambiguous without a full PostgreSQL parser.
 */
function lexSql(sql: string): { tokens: string[]; semicolons: number[] } {
  const tokens: string[] = [];
  const semicolons: number[] = [];
  let token = '';
  let mode: 'normal' | 'single' | 'double' | 'line-comment' | 'block-comment' = 'normal';

  const flush = () => {
    if (token) tokens.push(token.toUpperCase());
    token = '';
  };

  for (let i = 0; i < sql.length; i++) {
    const char = sql[i];
    const next = sql[i + 1];

    if (mode === 'line-comment') {
      if (char === '\n') mode = 'normal';
      continue;
    }
    if (mode === 'block-comment') {
      if (char === '*' && next === '/') { mode = 'normal'; i++; }
      continue;
    }
    if (mode === 'single') {
      if (char === "'" && next === "'") { i++; continue; }
      if (char === "'") mode = 'normal';
      continue;
    }
    if (mode === 'double') {
      if (char === '"' && next === '"') { i++; continue; }
      if (char === '"') mode = 'normal';
      continue;
    }

    if (char === '-' && next === '-') { flush(); mode = 'line-comment'; i++; continue; }
    if (char === '/' && next === '*') { flush(); mode = 'block-comment'; i++; continue; }
    if (char === "'") { flush(); mode = 'single'; continue; }
    if (char === '"') { flush(); mode = 'double'; continue; }
    if (char === '$') throw new Error('Dollar-quoted SQL is not allowed in read-only MCP queries');
    if (char === ';') { flush(); semicolons.push(i); continue; }
    if (/[a-zA-Z0-9_]/.test(char)) token += char;
    else flush();
  }
  flush();
  if (mode === 'single' || mode === 'double' || mode === 'block-comment') {
    throw new Error('SQL contains an unterminated string, identifier, or comment');
  }
  return { tokens, semicolons };
}

export function validateReadOnlySql(sqlValue: unknown): string {
  if (typeof sqlValue !== 'string') throw new Error('sql must be a string');
  const sql = sqlValue.trim();
  if (!sql) throw new Error('sql is required');
  if (sql.length > 20_000) throw new Error('SQL exceeds BotBoy read-only limit of 20,000 characters');
  if (sql.includes('\0')) throw new Error('SQL contains a null byte');

  const { tokens, semicolons } = lexSql(sql);
  const first = tokens[0];
  if (!first || !['SELECT', 'WITH', 'EXPLAIN', 'SHOW'].includes(first)) {
    throw new Error('Only read-only SELECT, WITH, EXPLAIN, or SHOW statements are allowed');
  }

  const trailingSemicolon = sql.endsWith(';') ? 1 : 0;
  if (semicolons.length > trailingSemicolon) {
    throw new Error('Multiple SQL statements are not allowed');
  }
  for (const token of tokens) {
    if (FORBIDDEN_SQL_TOKENS.has(token)) throw new Error(`SQL token ${token} is blocked by the read-only policy`);
    if (FORBIDDEN_SQL_FUNCTIONS.has(token)) throw new Error(`SQL function ${token} is blocked by the read-only policy`);
  }
  for (let i = 0; i < tokens.length - 1; i++) {
    if (tokens[i] === 'SELECT' && tokens[i + 1] === 'INTO') {
      throw new Error('SELECT INTO is not allowed');
    }
    if (tokens[i] === 'FOR' && ['UPDATE', 'SHARE'].includes(tokens[i + 1])) {
      throw new Error(`FOR ${tokens[i + 1]} is not allowed`);
    }
  }
  return sql;
}

/**
 * GRASP read operations, curated from the server's published tool set.
 * Everything outside this set (and the generic read patterns) mutates
 * Microsoft 365 state and therefore requires an explicit owner request.
 */
const GRASP_READ_TOOLS = new Set([
  'get_profile',
  'get_emails',
  'get_email_details',
  'get_attachment_content',
  'search_emails',
  'list_mail_folders',
  'get_calendar_events',
  'get_event_details',
  'get_calendar_availability',
  'find_meeting_times',
  'list_calendars',
  'get_drive_item',
  'get_file_metadata',
  'list_available_drives',
  'list_drive_files',
  'list_file_versions',
  'list_library_files',
  'list_sharepoint_sites',
  'list_sharepoint_site_libraries',
  'search_drive_content',
  'search_sharepoint_content',
  'read_file_content',
  'download_sharepoint_file',
  'list_notebooks',
  'list_notebook_sections',
  'list_section_pages',
  'read_onenote_page',
  'read_workbook_range',
]);

/**
 * Slack read operations from the AI Community Slack MCP. The batch_* names
 * fall outside the generic read pattern, so they are named explicitly.
 * Everything else on that server (posting, uploads, channel management,
 * drafts, read-state changes) mutates Slack and follows the standard rule:
 * callable, but only on an explicit owner request.
 */
const SLACK_READ_TOOLS = new Set([
  'search',
  'batch_get_conversation_history',
  'batch_get_thread_replies',
  'batch_get_user_info',
  'batch_get_channel_info',
  'get_channel_sections',
  'list_channels',
  'download_file_content',
  'list_drafts',
  'lists_items_list',
  'lists_items_info',
]);

/**
 * SharePoint MCP read operations (server v1.18+). CRITICAL: every tool on
 * that server is prefixed `sharepoint_`, so the generic READ_NAME_PATTERN
 * below never matches — without this set ALL SharePoint tools would classify
 * as write and the background document sync would be blocked on its first
 * listing call (plan §8.5 build blocker, validated 2026-08-24).
 */
const SHAREPOINT_READ_TOOLS = new Set([
  'sharepoint_list_sites',
  'sharepoint_list_libraries',
  'sharepoint_list_files',
  'sharepoint_list_shared_with_me',
  'sharepoint_read_file',
  'sharepoint_read_loop',
  'sharepoint_search',
  'sharepoint_resolve_url',
  // Phase-2 comment reads — read-classified from day one (harmless reads).
  'sharepoint_read_docx_comments',
  'sharepoint_list_item_comments',
]);

/**
 * SharePoint tools that are never callable in any phase of the integration
 * plan — destructive operations, structure mutations, site administration —
 * plus the three phase-3 write tools, blocked until their guided approval
 * flows ship (stale-thread and freshness guards live in those flows, so a
 * raw call would bypass them). Enforcement is unconditional: ownerApproved
 * does NOT override this set. The delivered policy had only read/write
 * tiers; this set adds the "never" tier the plan's §8.4 requires.
 */
const SHAREPOINT_BLOCKED_TOOLS = new Set([
  // Destructive
  'sharepoint_delete_file',
  'sharepoint_delete_list',
  'sharepoint_delete_item',
  'sharepoint_delete_field',
  // Structure mutations
  'sharepoint_create_folder',
  'sharepoint_rename_folder',
  'sharepoint_create_list',
  'sharepoint_create_field',
  'sharepoint_update_field',
  'sharepoint_create_item',
  'sharepoint_update_item',
  'sharepoint_set_view_fields',
  'sharepoint_remove_view_field',
  'sharepoint_add_item_comment',
  // Site administration
  'sharepoint_set_homepage',
  'sharepoint_rename_page',
  // Phase-3 writes — callable ONLY through the guided flows (reply / add
  // comment / incorporate edits), which carry the freshness + stale-thread
  // guards. Raw calls (chat mcp_call_tool) stay blocked; see
  // SHAREPOINT_GUIDED_WRITE_TOOLS and the guidedFlow option below.
  'sharepoint_write_file',
  'sharepoint_reply_docx_comment',
  'sharepoint_add_docx_comment',
]);

/**
 * The only blocked tools the guided flows may invoke (phase 3, spec R1.2).
 * The waiver requires ALL of: options.guidedFlow (set exclusively by
 * BotBoy's own purpose-built tool handlers — the model-facing mcp_call_tool
 * never forwards it), membership here, and ownerApproved. Everything else
 * in SHAREPOINT_BLOCKED_TOOLS rejects unconditionally.
 */
const SHAREPOINT_GUIDED_WRITE_TOOLS = new Set([
  'sharepoint_write_file',
  'sharepoint_reply_docx_comment',
  'sharepoint_add_docx_comment',
]);

/**
 * a2-analytics (Datanet ETL) read operations — curated, no name-pattern
 * fallback, same discipline as SharePoint: an unknown tool added by a future
 * server release classifies as write, never as a silent free read.
 */
const A2_ANALYTICS_READ_TOOLS = new Set([
  'datanet_get_job_run',
  'datanet_get_job_run_status',
  'datanet_get_job_run_error',
  'datanet_get_latest_run',
  'datanet_get_runs_for_job',
  'datanet_list_runs_by_date',
  'datanet_list_active_runs',
  'datanet_get_successful_runs_count',
  'datanet_get_job',
  'datanet_get_profile',
  'datanet_get_profile_sql',
  'datanet_detect_profile_type',
  'datanet_diagnose_run',
  'datanet_get_execution_timing',
  'datanet_get_run_events',
  'datanet_list_run_logs',
  'datanet_get_run_log_content',
  'datanet_search',
  'datanet_resolve_metrics_profile',
  'datanet_resolve_metrics_jobs',
  // Fetches a completed run's OUTPUT to a local file — read-only against
  // Datanet (nothing mutates), and the reason this integration exists.
  'datanet_download_results',
  // Cradle read surface (Spark ETL on DataCentral) — same platform family.
  'cradle_get_profile',
  'cradle_get_job',
  'cradle_get_run',
  'cradle_list_jobs',
  'cradle_list_runs',
  'cradle_search_profiles',
  'cradle_search_runs',
  // Server self-diagnostics.
  'server_health',
  'config_check',
]);

/**
 * a2-analytics tools that are never callable from BotBoy, in any flow.
 * Three families:
 *  - redshift_query: SQL PRIMACY — warehouse SQL belongs to the sql-context
 *    profile exclusively (owner decision 2026-08-27). Routing guidance says
 *    it; this set enforces it structurally.
 *  - batch_*: bulk pipeline mutations — a batch call collapses N approvals
 *    into one opaque action.
 *  - config mutations of the shared ~/.a2data setup.
 * ownerApproved does NOT override this set.
 *
 * datanet_force_deps was in this set until 2026-08-27: after the first live
 * incident (mis-windowed ad-hoc run, data verifiably loaded, owner sent
 * clicking through DataCentral for a provably safe force) the owner moved it
 * to the ordinary attested-write tier — callable, marked use-with-caution,
 * gated on explicit owner confirmation like every other single-run write.
 * Deliberately NO server-side evidence verification (owner decision: the
 * confirmation conversation is the gate).
 */
const A2_ANALYTICS_BLOCKED_TOOLS = new Set([
  'redshift_query',
  'datanet_batch_submit',
  'datanet_batch_restart',
  'datanet_batch_force',
  'datanet_unschedule_job',
  'cradle_batch_backfill',
  'cradle_cancel_wfd_runs',
  'config_discover',
]);

/** Name patterns that indicate a read-only operation on any MCP server. */
const READ_NAME_PATTERN = /^(get|list|search|read|describe|query|fetch|show|status|check|find|count|view|inspect|preview|lookup|resolve|download)([_\-.]|$)/i;

/**
 * Every discovered tool is callable. Reads run freely; anything classified
 * as write runs only with an explicit owner approval for the current call.
 */
export function classifyMcpTool(serverKind: string, toolName: string): McpToolRisk {
  if (serverKind === 'sql-context') {
    return SQL_CONTEXT_READ_TOOLS.has(toolName) ? 'read' : 'write';
  }
  if (serverKind === 'grasp-m365') {
    if (GRASP_READ_TOOLS.has(toolName)) return 'read';
    return READ_NAME_PATTERN.test(toolName) ? 'read' : 'write';
  }
  if (serverKind === 'slack') {
    if (SLACK_READ_TOOLS.has(toolName)) return 'read';
    return READ_NAME_PATTERN.test(toolName) ? 'read' : 'write';
  }
  if (serverKind === 'sharepoint') {
    // Deliberately NO name-pattern fallback: an unknown sharepoint_* tool
    // (added by a future server version) classifies as write, never as a
    // silent free read. Remaining read-only tools outside the curated set
    // (Lists/pages reads, "later review" in the plan) are therefore callable
    // only with an explicit owner request.
    return SHAREPOINT_READ_TOOLS.has(toolName) ? 'read' : 'write';
  }
  if (serverKind === 'a2-analytics') {
    // Same no-fallback discipline as SharePoint: the server exposes 90
    // tools including production pipeline mutations, so only the curated
    // set reads freely; everything else needs an explicit owner request
    // (and the blocked set above never runs at all).
    return A2_ANALYTICS_READ_TOOLS.has(toolName) ? 'read' : 'write';
  }
  return READ_NAME_PATTERN.test(toolName) ? 'read' : 'write';
}

export function validateMcpToolCall(
  serverKind: string,
  toolName: string,
  args: Record<string, unknown>,
  options: { ownerApproved?: boolean; guidedFlow?: boolean } = {},
): Record<string, unknown> {
  // The "never" tier: unconditional for raw calls, regardless of
  // ownerApproved. The word "blocked" in the message is load-bearing —
  // mcp-manager's error classifier records these calls with audit status
  // 'blocked'. Sole waiver (phase 3): BotBoy's own guided write flows,
  // which re-verify live server state before writing.
  if (serverKind === 'sharepoint' && SHAREPOINT_BLOCKED_TOOLS.has(toolName)) {
    const guidedWaiver = options.guidedFlow === true
      && SHAREPOINT_GUIDED_WRITE_TOOLS.has(toolName)
      && options.ownerApproved === true;
    if (!guidedWaiver) {
      throw new Error(
        `MCP tool '${toolName}' is blocked for the SharePoint profile (destructive, structural, or reserved for its guided flow) — an owner request cannot override this; guided writes go through the sharepoint_reply_comment / sharepoint_add_comment / sharepoint_update_document tools`,
      );
    }
  }
  if (serverKind === 'a2-analytics' && A2_ANALYTICS_BLOCKED_TOOLS.has(toolName)) {
    // No waiver exists for this set. redshift_query carries its own message
    // so the model is redirected instead of retrying.
    throw new Error(toolName === 'redshift_query'
      ? "MCP tool 'redshift_query' is blocked on the ETL profile — warehouse SQL always runs through the dedicated SQL connection (mcp_sql_query); this cannot be overridden"
      : `MCP tool '${toolName}' is blocked for the ETL profile (bulk or irreversible pipeline mutation) — an owner request cannot override this; act on individual runs instead`,
    );
  }
  const risk = classifyMcpTool(serverKind, toolName);
  if (risk !== 'read' && options.ownerApproved !== true) {
    throw new Error(
      `MCP tool '${toolName}' changes external data and was blocked: it requires an explicit owner request (ownerRequested=true) in the current conversation`,
    );
  }
  if (serverKind === 'sql-context' && toolName === 'run_query') {
    return { ...args, sql: validateReadOnlySql(args.sql) };
  }
  return args;
}
