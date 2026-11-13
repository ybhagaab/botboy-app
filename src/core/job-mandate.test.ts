import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createStorage, type StorageLayer } from './storage.js';
import { createChatJobStore, type ChatJobStore } from './chat-jobs.js';
import { filterToolsForContinuation, filterToolsForReview, isJobScopeTool, JOB_SCOPE_TOOLS, REVIEW_TOOLS, withJobMandate } from './job-mandate.js';
import type { ToolExecutionContext } from './tool-executor.js';

/**
 * The job mandate (ANALYTICS_AUTONOMY_PLAN.md D1): a continuation turn takes
 * the job's steps with no owner present (data work, BotBoy documents, and the
 * browser on BotBoy's own tabs since 2026-10-22); it never sends, publishes,
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
    for (const name of ['mcp_etl_run_query', 'wait_for_etl_run', 'create_data_room_dataset', 'create_analytics_dashboard', 'run_command', 'query_data_room', 'read_product_document', 'edit_product_document', 'save_product_document', 'browser_hands', 'job_update']) {
      const result = await gate().executeTool(call(name), continuation());
      expect(result.content, name).toContain(`ran ${name}`);
    }
  });

  it('refuses effects outside the job, and every step once the job ended', async () => {
    for (const name of ['gmail_send', 'gmail_draft', 'publish_static_artifact_to_harmony', 'sharepoint_edit_docx_body', 'mcp_etl_submit_run', 'mcp_etl_update_profile_sql', 'mcp_etl_force_deps', 'open_terminal', 'mcp_profile_action', 'manage_project', 'configure_analytics_schedule', 'export_product_document', 'some_future_tool']) {
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
  // base executor, so the mandate gate must wrap them all. The Knowledge library
  // wrapper sits directly inside the workplace one, so the mandate filters first.
  it('is the outermost wrapper of the chat executor (index.ts)', () => {
    const index = readFileSync(path.join(process.cwd(), 'src/index.ts'), 'utf8');
    // withUiThemeChatTools (docs/maps/ui-themes.md) and withJobNotifyChatTools (docs/maps/job-notify.md) sit between the workplace and
    // Knowledge wrappers: inside the mandate too, so a continuation never reaches either tool.
    expect(index).toMatch(/const toolExecutor = withJobMandate\(\s*withWorkplaceChatTools\(withUiThemeChatTools\(withJobNotifyChatTools\(withKnowledgeChatTools\(withWhatsAppChatTools\(withGdriveChatTools\(withGmailChatTools\(\s*withProductDocumentChatTools\(\s*baseToolExecutor,/);
  });

  // WhatsApp updates for a job are BotBoy's own doing (job-notifier.ts): neither the setter (job_notify) nor any WhatsApp tool may ever
  // be a job-scope tool, or a job could message the owner, or turn its own updates on or off, with no owner in the loop.
  it('never admits job_notify or any whatsapp tool to a continuation', () => {
    for (const name of ['job_notify', 'whatsapp_send', 'whatsapp_find_contact']) {
      expect(JOB_SCOPE_TOOLS.has(name), name).toBe(false);
    }
    expect([...JOB_SCOPE_TOOLS].filter(name => name.startsWith('whatsapp_') || name.startsWith('job_') && name !== 'job_update')).toEqual([]);
    const offered = filterToolsForContinuation(['job_update', 'job_notify', 'whatsapp_send'].map(name => ({ function: { name } })));
    expect(offered.map(tool => tool.function.name)).toEqual(['job_update']);
  });

  // The main chat's jobs tool reads and steers every job (PARALLEL_JOBS_PLAN.md §11): a job's automatic turns never get it, so one
  // job never reads or steers another (PJ1 isolation).
  it('never admits the main chat\'s jobs tool to a continuation', async () => {
    expect(JOB_SCOPE_TOOLS.has('jobs')).toBe(false);
    expect(filterToolsForContinuation([{ function: { name: 'jobs' } }, { function: { name: 'job_update' } }]).map(tool => tool.function.name)).toEqual(['job_update']);
    const result = await gate().executeTool(call('jobs'), continuation());
    expect(result.content).not.toContain('ran jobs');
  });

  // The main chat's own look at a job update (PARALLEL_JOBS_PLAN.md §12, owner decision 2026-11-09): every read it needs and
  // `jobs`; nothing that changes anything else (the job does its own work; sending, publishing and sharing stay the owner's).
  it('lets a job update read and use jobs, and refuses every write, run, shell, browser click or send', async () => {
    const review = (): ToolExecutionContext => ({ callerKind: 'review', reviewJobId: jobId, currentUserMessage: 'Weekly players dashboard' });
    // The Data Room reads too (owner decision 2026-11-10: the main chat leads a job with the same view of its data).
    const reads = ['jobs', 'get_analytics_dashboard', 'query_db', 'read_file', 'mcp_etl_job_run', 'mcp_sql_query', 'knowledge_load',
      'list_data_room_datasets', 'query_data_room'];
    for (const name of reads) expect((await gate().executeTool(call(name), review())).content, name).toContain(`ran ${name}`);
    for (const name of ['run_command', 'write_file', 'edit_file', 'mcp_etl_run_query', 'mcp_etl_alter_run', 'wait_for_etl_run', 'refresh_analytics_dashboard',
      'create_data_room_dataset', 'configure_analytics_widget_source', 'browser_hands', 'gmail_send', 'whatsapp_send', 'job_update', 'job_notify',
      'knowledge_propose', 'save_product_document',
      // Reads whose own gates admit only the owner's turn or a job's: the job reads them when the main chat asks it to.
      'gdrive_read', 'gdrive_search', 'some_future_tool']) {
      const result = await gate().executeTool(call(name), review());
      expect(JSON.parse(result.content), name).toMatchObject({ status: 'blocked', code: 'outside_job_update' });
      expect(result.isError).toBe(true);
    }
    expect(inner.executeTool).toHaveBeenCalledTimes(reads.length);
    // mcp_call_tool runs read-tier only, whatever the model claims.
    inner.executeTool.mockClear();
    await gate().executeTool(call('mcp_call_tool', { serverId: 'slack', toolName: 'post_message', ownerRequested: true }), review());
    expect(JSON.parse(inner.executeTool.mock.calls[0][0].function.arguments)).toMatchObject({ toolName: 'post_message', ownerRequested: false });
  });

  it('keeps the job update list closed: reads and jobs only, every name a tool the chat offers', async () => {
    expect(REVIEW_TOOLS.has('jobs')).toBe(true);
    for (const name of REVIEW_TOOLS) {
      expect(name).not.toMatch(/^(gmail_|gdrive_(share|edit|files)|gcalendar|sharepoint_|publish_|open_terminal|send_terminal|manage_|mcp_profile_action|mcp_add_custom|mcp_update_custom|ui_theme_|whatsapp_|job_|knowledge_(write|create_set|propose)|write_file|edit_|save_|create_|update_|configure_|refresh_|delete_|run_command|browser_hands|mcp_etl_(run_query|alter_run|submit_run|download_results)|wait_for_etl_run)/);
    }
    // Every name is a real chat tool: a typo would silently take a read away from the main chat's look.
    const { createPromptManager } = await import('./prompt-manager.js');
    const offered = new Set(createPromptManager().getToolDefinitions('chat', { mainChatTurn: true, knowledgeAvailable: true, driveConnected: true } as any)
      .map(tool => tool.function.name));
    expect([...REVIEW_TOOLS].filter(name => !offered.has(name))).toEqual([]);
    const tools = ['jobs', 'query_db', 'run_command', 'job_update'].map(name => ({ type: 'function', function: { name } }));
    expect(filterToolsForReview(tools).map(tool => tool.function.name)).toEqual(['jobs', 'query_db']);
  });

  // Owner requests 2026-10-22: a job reads, edits and saves BotBoy documents (a full save included) and clicks and types in
  // the browser in its automatic turns. Sending, publishing and the terminal stay owner turns.
  it('admits document reads, edits and full saves, and browser hands, in a job', () => {
    for (const name of ['read_product_document', 'edit_product_document', 'save_product_document', 'edit_file', 'browser_hands', 'browser_screenshot']) {
      expect(isJobScopeTool(name), name).toBe(true);
    }
    const offered = filterToolsForContinuation(['read_product_document', 'edit_product_document', 'save_product_document', 'export_product_document', 'browser_hands', 'open_terminal']
      .map(name => ({ function: { name } })));
    expect(offered.map(tool => tool.function.name)).toEqual(['read_product_document', 'edit_product_document', 'save_product_document', 'browser_hands']);
  });

  // Stopping queries (docs/maps/query-control.md): a job stops the SQL queries and ETL runs it started; the handler keeps a
  // continuation to the job's own and ignores ownerRequested there. A job update (the main chat's look) never stops anything.
  it('lets a continuation stop its own queries, and never a job update', () => {
    expect(isJobScopeTool('cancel_query')).toBe(true);
    expect(REVIEW_TOOLS.has('cancel_query')).toBe(false);
  });

  it('offers a continuation only the job-scope tools', () => {
    const tools = ['query_db', 'gmail_send', 'mcp_etl_run_query', 'open_terminal'].map(name => ({ type: 'function', function: { name } }));
    expect(filterToolsForContinuation(tools).map(tool => tool.function.name)).toEqual(['query_db', 'mcp_etl_run_query']);
    for (const name of JOB_SCOPE_TOOLS) {
      expect(name).not.toMatch(/^(gmail_|gdrive_share|sharepoint_|publish_|open_terminal|send_terminal|manage_|mcp_profile_action|mcp_add_custom|mcp_update_custom|ui_theme_|whatsapp_)/);
    }
    expect(isJobScopeTool('mcp_etl_submit_run')).toBe(false);
  });

  // Google (owner request 2026-10-23, "same permissions for jobs" as the document tools): a job reads, creates, edits,
  // uploads, downloads and organizes files and changes its own events; sharing and comments are never a job's.
  it('lets a continuation use Drive and Calendar like the document tools, and never share or comment', () => {
    expect([...JOB_SCOPE_TOOLS].filter(name => name.startsWith('gdrive_') || name.startsWith('gcalendar')).sort())
      .toEqual(['gcalendar', 'gdrive_edit', 'gdrive_files', 'gdrive_read', 'gdrive_search']);
    expect(isJobScopeTool('gdrive_share')).toBe(false);
  });

  // The Knowledge library (knowledge-library.md K9, K18): a continuation may read the library and PROPOSE a change (a card);
  // Disk (owner approval 2026-10-29): an automatic turn deletes a file only through delete_working_file (the job's own file, its
  // gzip copy checked byte for byte); deleting shell commands are refused, everything else in run_command passes.
  it('admits delete_working_file and refuses deleting commands in run_command', async () => {
    expect(JOB_SCOPE_TOOLS.has('delete_working_file')).toBe(true);
    expect((await gate().executeTool(call('delete_working_file', { path: 'a.tsv', keptCopy: 'a.tsv.gz' }), continuation())).content).toContain('ran delete_working_file');
    for (const command of [
      'rm etl-results/adhoc_1.tsv', 'gzip -k a.tsv && rm a.tsv', 'cd etl-results; rm -f a.tsv', '(rm a)', '/bin/rm a', 'ls | xargs rm',
      'find . -name "*.tsv" -delete', "python3 -c \"import os; os.remove('a.tsv')\"", "python3 -c 'import shutil; shutil.rmtree(\"d\")'",
      "python3 -c 'from pathlib import Path; Path(\"a\").unlink()'", 'node -e "require(\'fs\').unlinkSync(\'a\')"', 'unlink a', 'git rm a.tsv', 'trash a',
    ]) {
      const result = await gate().executeTool(call('run_command', { command }), continuation());
      expect(JSON.parse(result.content), command).toMatchObject({ status: 'blocked', code: 'outside_job_mandate' });
      expect(JSON.parse(result.content).nextAction).toContain('delete_working_file');
    }
    for (const command of ['gzip -k etl-results/adhoc_1.tsv', 'python3 transform.py', 'duckdb -c "select count(*) from read_csv(\'a.tsv\')"', 'df -h .', 'echo perm', 'grep -rn uuid a.tsv', 'ls -la etl-results']) {
      expect((await gate().executeTool(call('run_command', { command }), continuation())).content, command).toContain('ran run_command');
    }
    // An owner turn is unchanged: the owner is there.
    const owner = await gate().executeTool(call('run_command', { command: 'rm a.tsv' }), { callerKind: 'interactive', currentUserMessage: 'delete a.tsv' });
    expect(owner.content).toContain('ran run_command');
  });

  // it can never write or create a set.
  it('lets a continuation read the library and propose, and never write or create a set', () => {
    expect([...JOB_SCOPE_TOOLS].filter(name => name.startsWith('knowledge_')).sort()).toEqual(['knowledge_list', 'knowledge_load', 'knowledge_propose']);
    const offered = ['knowledge_list', 'knowledge_load', 'knowledge_propose', 'knowledge_write', 'knowledge_create_set'].map(name => ({ type: 'function', function: { name } }));
    expect(filterToolsForContinuation(offered).map(tool => tool.function.name)).toEqual(['knowledge_list', 'knowledge_load', 'knowledge_propose']);
    expect(isJobScopeTool('knowledge_write')).toBe(false);
    expect(isJobScopeTool('knowledge_create_set')).toBe(false);
  });
});

// The prompt says the same as the mandate (owner requests 2026-10-22): an automatic turn uses the tools it is offered and
// leaves only what they refuse for the owner, instead of stopping at "data work".
describe('the automatic-turn guidance', () => {
  it('follows the offered tools, not a data-work-only rule', async () => {
    const { createPromptManager } = await import('./prompt-manager.js');
    const prompt = createPromptManager().getSystemPrompt('chat');
    expect(prompt).toContain('- A turn marked AUTOMATIC CONTINUATION has no owner message: continue the job from where it stands with the tools it offers, and leave what they refuse (outside_job_mandate) for the owner\'s go-ahead.');
    expect(prompt).not.toContain('outside the job\'s data work');
  });
});
