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
  return READ_NAME_PATTERN.test(toolName) ? 'read' : 'write';
}

export function validateMcpToolCall(
  serverKind: string,
  toolName: string,
  args: Record<string, unknown>,
  options: { ownerApproved?: boolean } = {},
): Record<string, unknown> {
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
