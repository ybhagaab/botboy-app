/**
 * The taint recorder (knowledge-library.md K14): the default is taint, only the listed tools are trusted, every call is
 * noted (also a failing one), and the trusted list names real tools. Synthetic only.
 */
import { describe, expect, it } from 'vitest';
import { TRUSTED_TOOLS, familyOf, noteToolCall, noteToolCalls, turnIsTainted, untrustedSourcesOf } from './knowledge-taint.js';
import type { ToolExecutionContext } from './tool-executor.js';

const fresh = (): ToolExecutionContext => ({ currentUserMessage: 'save this', callerKind: 'interactive' });

describe('the trusted list', () => {
  // That every name here is a real chat tool is asserted beside the tool definitions (knowledge-write-tools.test.ts).
  it('holds exactly the library, the lessons ledger and BotBoy\'s own bookkeeping', () => {
    expect([...TRUSTED_TOOLS].sort()).toEqual([
      'adopt_lesson', 'close_terminal', 'export_footer', 'job_update', 'knowledge_create_set', 'knowledge_list', 'knowledge_load', 'knowledge_propose',
      'knowledge_write', 'list_lessons', 'mcp_analytics_list_context', 'mcp_analytics_load_context', 'open_terminal', 'propose_lesson',
      'refresh_toolchain', 'retire_lesson', 'write_file',
    ]);
  });
});

describe('noteToolCall', () => {
  it('taints on every tool that is not trusted, including a read the decorators answer on their own', () => {
    for (const name of ['gmail_read', 'gmail_search', 'gdrive_read', 'whatsapp_find_contact', 'sharepoint_update_document', 'read_document', 'web_fetch', 'browser_hands', 'mcp_call_tool', 'mcp_sql_query', 'query_db', 'get_today', 'read_file', 'run_command', 'ui_screenshot', 'search_items', 'a_tool_added_next_year']) {
      const context = fresh();
      noteToolCall(context, name);
      expect(turnIsTainted(context), name).toBe(true);
    }
  });

  it('leaves the turn clean for the trusted tools, and for no context at all', () => {
    const context = fresh();
    for (const name of TRUSTED_TOOLS) noteToolCall(context, name);
    expect(turnIsTainted(context)).toBe(false);
    expect(untrustedSourcesOf(context)).toEqual([]);
    expect(() => noteToolCall(undefined, 'gmail_read')).not.toThrow();
  });

  it('records every call of one assistant message, so a write beside a read in the same message is tainted before it runs', () => {
    const context = fresh();
    noteToolCalls(context, ['knowledge_write', 'gmail_read', 'web_fetch']);
    expect(turnIsTainted(context)).toBe(true);
    expect(untrustedSourcesOf(context)).toEqual(['email', 'web page']);
  });
});

describe('family labels', () => {
  it('map prefixes to the words a card shows', () => {
    expect(familyOf('gmail_search')).toBe('email');
    expect(familyOf('gdrive_read')).toBe('Drive');
    expect(familyOf('whatsapp_send')).toBe('WhatsApp');
    expect(familyOf('read_document')).toBe('documents');
    expect(familyOf('sharepoint_create_document')).toBe('documents');
    expect(familyOf('web_search')).toBe('web page');
    expect(familyOf('get_chat_messages')).toBe('captured items');
    expect(familyOf('mcp_etl_download_results')).toBe('connected tool');
    expect(familyOf('run_command')).toBe('files and commands');
    expect(familyOf('something_new')).toBe('other source');
  });

  it('are listed once and sorted', () => {
    const context = fresh();
    noteToolCalls(context, ['web_fetch', 'gmail_read', 'gmail_search', 'web_search']);
    expect(untrustedSourcesOf(context)).toEqual(['email', 'web page']);
  });
});

describe('a guide target is stricter', () => {
  it('counts a library file loaded this turn as a possible source for a guide edit only', () => {
    const context = fresh();
    context.knowledgeNonGuideLoaded = true;
    expect(turnIsTainted(context)).toBe(false);
    expect(turnIsTainted(context, { guideTarget: true })).toBe(true);
    expect(turnIsTainted(fresh(), { guideTarget: true })).toBe(false);
  });
});

describe('the analytics loader is a library read too', () => {
  it('mcp_analytics_load_context marks the turn for guide edits without tainting a content edit; the list call does not', () => {
    const context: ToolExecutionContext = { currentUserMessage: 'x', callerKind: 'interactive' };
    noteToolCall(context, 'mcp_analytics_list_context');
    expect(context.knowledgeNonGuideLoaded).toBeUndefined();
    noteToolCall(context, 'mcp_analytics_load_context');
    expect(context.knowledgeNonGuideLoaded).toBe(true);
    expect(turnIsTainted(context, { guideTarget: true })).toBe(true);
    expect(turnIsTainted(context, { guideTarget: false })).toBe(false);
    expect(untrustedSourcesOf(context)).toEqual([]);
  });
});
