import { describe, it, expect } from 'vitest';
import { classifyMcpTool, validateMcpToolCall } from './mcp-policy.js';

/**
 * SharePoint tool policy (sharepoint-docs-brain R2).
 *
 * The generic READ_NAME_PATTERN never matches `sharepoint_*` names, so the
 * curated sets are load-bearing: without them the background sync's read
 * calls are rejected (plan §8.5 build blocker) and destructive tools would
 * be one explicit owner request away from running (§8.4).
 */

const READ_TOOLS = [
  'sharepoint_list_sites',
  'sharepoint_list_libraries',
  'sharepoint_list_files',
  'sharepoint_list_shared_with_me',
  'sharepoint_read_file',
  'sharepoint_read_loop',
  'sharepoint_search',
  'sharepoint_resolve_url',
  'sharepoint_read_docx_comments',
  'sharepoint_list_item_comments',
];

const BLOCKED_TOOLS = [
  'sharepoint_delete_file',
  'sharepoint_delete_list',
  'sharepoint_delete_item',
  'sharepoint_delete_field',
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
  'sharepoint_set_homepage',
  'sharepoint_rename_page',
  // Phase-3 writes stay blocked until their guided flows ship.
  'sharepoint_write_file',
  'sharepoint_reply_docx_comment',
  'sharepoint_add_docx_comment',
];

describe('SharePoint tool classification', () => {
  it('classifies every curated read tool as read', () => {
    for (const tool of READ_TOOLS) {
      expect(classifyMcpTool('sharepoint', tool), tool).toBe('read');
    }
  });

  it('classifies non-curated read-only surface (Lists/pages reads) as write — explicit owner request required', () => {
    for (const tool of ['sharepoint_list_lists', 'sharepoint_list_fields', 'sharepoint_list_items', 'sharepoint_list_views', 'sharepoint_list_pages', 'sharepoint_read_page']) {
      expect(classifyMcpTool('sharepoint', tool), tool).toBe('write');
    }
  });

  it('REGRESSION: unknown sharepoint_* names never classify as silent free reads', () => {
    expect(classifyMcpTool('sharepoint', 'sharepoint_get_everything_v2')).toBe('write');
    expect(classifyMcpTool('sharepoint', 'sharepoint_list_new_surface')).toBe('write');
  });

  it('read tools pass validateMcpToolCall without ownerApproved', () => {
    for (const tool of READ_TOOLS) {
      expect(() => validateMcpToolCall('sharepoint', tool, {})).not.toThrow();
    }
  });

  it('write-classified tools require ownerApproved', () => {
    expect(() => validateMcpToolCall('sharepoint', 'sharepoint_list_lists', {}))
      .toThrow(/explicit owner request/);
    expect(() => validateMcpToolCall('sharepoint', 'sharepoint_list_lists', {}, { ownerApproved: true }))
      .not.toThrow();
  });
});

describe('SharePoint blocked tier (unconditional)', () => {
  it('rejects every blocked tool even with ownerApproved=true', () => {
    for (const tool of BLOCKED_TOOLS) {
      expect(() => validateMcpToolCall('sharepoint', tool, {}, { ownerApproved: true }), tool)
        .toThrow(/blocked/);
      expect(() => validateMcpToolCall('sharepoint', tool, {}), tool)
        .toThrow(/blocked/);
    }
  });

  it('rejection message contains "blocked" so mcp-manager audits status=blocked', () => {
    try {
      validateMcpToolCall('sharepoint', 'sharepoint_delete_file', {}, { ownerApproved: true });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as Error).message).toMatch(/blocked/i);
    }
  });

  it('the blocked tier is sharepoint-scoped — other kinds keep name-pattern behavior', () => {
    // A hypothetical same-named tool on a custom server follows generic rules.
    expect(() => validateMcpToolCall('custom', 'sharepoint_delete_file', {}, { ownerApproved: true }))
      .not.toThrow();
  });
});

describe('SharePoint guided-flow waiver (sharepoint-writes R1)', () => {
  const GUIDED = ['sharepoint_write_file', 'sharepoint_reply_docx_comment', 'sharepoint_add_docx_comment'];

  it('waives the block ONLY for the three guided tools with guidedFlow AND ownerApproved', () => {
    for (const tool of GUIDED) {
      expect(() => validateMcpToolCall('sharepoint', tool, {}, { guidedFlow: true, ownerApproved: true }), tool)
        .not.toThrow();
    }
  });

  it('guidedFlow without ownerApproved still rejects', () => {
    for (const tool of GUIDED) {
      expect(() => validateMcpToolCall('sharepoint', tool, {}, { guidedFlow: true }), tool)
        .toThrow(/blocked/);
    }
  });

  it('ownerApproved without guidedFlow still rejects (raw chat calls stay blocked)', () => {
    for (const tool of GUIDED) {
      expect(() => validateMcpToolCall('sharepoint', tool, {}, { ownerApproved: true }), tool)
        .toThrow(/blocked/);
    }
  });

  it('the waiver never extends to other blocked tools', () => {
    for (const tool of ['sharepoint_delete_file', 'sharepoint_create_folder', 'sharepoint_add_item_comment', 'sharepoint_set_homepage']) {
      expect(() => validateMcpToolCall('sharepoint', tool, {}, { guidedFlow: true, ownerApproved: true }), tool)
        .toThrow(/blocked/);
    }
  });
});

describe('Existing kinds unchanged (regressions)', () => {
  it('grasp reads stay read; grasp writes stay write', () => {
    expect(classifyMcpTool('grasp-m365', 'get_emails')).toBe('read');
    expect(classifyMcpTool('grasp-m365', 'send_email')).toBe('write');
  });
  it('slack reads stay read', () => {
    expect(classifyMcpTool('slack', 'search')).toBe('read');
    expect(classifyMcpTool('slack', 'post_message')).toBe('write');
  });
  it('sql-context stays curated', () => {
    expect(classifyMcpTool('sql-context', 'run_query')).toBe('read');
    expect(classifyMcpTool('sql-context', 'drop_table')).toBe('write');
  });
});
