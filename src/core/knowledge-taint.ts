/**
 * Which turns have read something UNTRUSTED (knowledge-library.md K14; brief 4.4 "Anything derived from untrusted content
 * NEVER applies automatically"). A direct apply of a library change needs a turn in which nothing untrusted was read; every
 * other change becomes an approval card labelled with where the text may have come from.
 *
 * Recorded in chat.ts ABOVE the whole decorator chain, before each dispatch and over every call of one assistant message
 * (decorators answer their own tools without forwarding, so a recorder inside the chain would miss a Gmail read), also for
 * a call that then fails: the DEFAULT is taint, and only the tools listed here are trusted. Taint is per turn; a later owner
 * turn that says "save that" about text an earlier turn summarized is the owner's explicit request about content they saw,
 * and the result carries the diff and an Undo.
 */
import type { ToolExecutionContext } from './tool-executor.js';

/** Tools that read nothing untrusted (the library itself, the lessons ledger, BotBoy's own bookkeeping). */
export const TRUSTED_TOOLS: ReadonlySet<string> = new Set([
  'knowledge_list', 'knowledge_load', 'knowledge_propose', 'knowledge_write', 'knowledge_create_set',
  'mcp_analytics_list_context', 'mcp_analytics_load_context',
  'list_lessons', 'propose_lesson', 'adopt_lesson', 'retire_lesson',
  'job_update', 'write_file', 'export_footer', 'refresh_toolchain', 'open_terminal', 'close_terminal',
]);

/** Family labels, in the order a prefix is tried. The label is what the card shows ("Derived from: email, web page"). */
const FAMILIES: ReadonlyArray<{ label: string; test: RegExp }> = [
  { label: 'email', test: /^(?:gmail_|grasp_)/ },
  { label: 'Drive', test: /^gdrive_/ },
  { label: 'Calendar', test: /^gcalendar$/ },
  { label: 'WhatsApp', test: /^whatsapp_/ },
  { label: 'documents', test: /^(?:sharepoint_|list_documents$|read_document$|read_spreadsheet$|get_document_writing_guide$|save_product_document$|read_product_document$|edit_product_document$|export_product_document$|publish_product_document_)/ },
  { label: 'web page', test: /^(?:web_|browser_|ui_|inspect_visual_assets$)/ },
  { label: 'captured items', test: /^(?:get_today$|list_projects$|get_project_brain$|get_channels$|list_nodes$|get_node_items$|search_items$|get_chat_messages$|query_db$|enrich_item$|create_item$|update_item$|send_chat_message$|rebuild_brain$|reject_evidence$|discard_item$|set_task_state$|add_task$)/ },
  { label: 'connected tool', test: /^(?:mcp_|save_mcp_analysis$|query_data_room$|list_data_room_datasets$|create_data_room_dataset$|configure_analytics_widget_source$|wait_for_etl_run$)/ },
  { label: 'files and commands', test: /^(?:read_file$|edit_file$|run_command$|read_terminal$|wait_for_terminal$|send_terminal_input$)/ },
];

/** The family label of an untrusted tool call. */
export function familyOf(toolName: string): string {
  const name = String(toolName ?? '');
  for (const family of FAMILIES) if (family.test.test(name)) return family.label;
  return 'other source';
}

/** Record one dispatched call. Call it for every tool call, before it runs; trusted tools add nothing. */
export function noteToolCall(context: ToolExecutionContext | undefined, toolName: string): void {
  if (!context) return;
  // The analytics loader hands over library files too: like knowledge_load, it makes the turn a possible source for a GUIDE edit.
  if (toolName === 'mcp_analytics_load_context') context.knowledgeNonGuideLoaded = true;
  if (TRUSTED_TOOLS.has(toolName)) return;
  (context.untrustedFamilies ??= new Set<string>()).add(familyOf(toolName));
}

/** Record every call of one assistant message before the first one runs. */
export function noteToolCalls(context: ToolExecutionContext | undefined, toolNames: Iterable<string>): void {
  for (const name of toolNames) noteToolCall(context, name);
}

/**
 * Record the sources the server stored with a change the owner reopened. The card's text came from those sources, and this turn
 * now holds it, so the turn is tainted by them: every change made in it becomes a card labelled with them (P2 review R20).
 * The labels are the server's own family names; they are cut to a safe length all the same.
 */
export function noteUntrustedSources(context: ToolExecutionContext | undefined, sources: Iterable<string>): void {
  if (!context) return;
  for (const source of sources) {
    const label = String(source ?? '').replace(/\s+/g, ' ').trim().slice(0, 40);
    if (label) (context.untrustedFamilies ??= new Set<string>()).add(label);
  }
}

/** The families this turn touched, sorted, for the card label. */
export function untrustedSourcesOf(context: ToolExecutionContext | undefined): string[] {
  return [...(context?.untrustedFamilies ?? [])].sort();
}

export function turnIsTainted(context: ToolExecutionContext | undefined, options: { guideTarget?: boolean } = {}): boolean {
  if ((context?.untrustedFamilies?.size ?? 0) > 0) return true;
  // A guide steers every later write, so for a guide target even a library file the turn loaded counts as a possible source.
  return Boolean(options.guideTarget && context?.knowledgeNonGuideLoaded);
}
