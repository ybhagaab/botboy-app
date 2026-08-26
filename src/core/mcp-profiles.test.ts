import { describe, it, expect } from 'vitest';
import {
  getBuiltInMcpProfile,
  isBuiltInMcpProfileId,
  listBuiltInMcpProfiles,
  getTerminalCommandDefinition,
  SHAREPOINT_MCP_PROFILE_ID,
  SHAREPOINT_MCP_REQUIRED_TOOLS,
} from './mcp-profiles.js';
import { classifyMcpTool } from './mcp-policy.js';

describe('Built-in MCP profile registry', () => {
  it('registers exactly the four built-in profiles', () => {
    expect(listBuiltInMcpProfiles().map(p => p.id).sort())
      .toEqual(['grasp-m365', 'sharepoint', 'slack', 'sql-context']);
  });

  it('recognizes sharepoint as a built-in id (custom-id collision guard depends on this)', () => {
    expect(isBuiltInMcpProfileId('sharepoint')).toBe(true);
    expect(isBuiltInMcpProfileId('sharepoint-2')).toBe(false);
  });
});

describe('SharePoint profile (sharepoint-docs-brain R1)', () => {
  const profile = getBuiltInMcpProfile(SHAREPOINT_MCP_PROFILE_ID)!;

  it('launches the fixed executable with no arguments (closed configuration)', () => {
    expect(profile.launch).toEqual({
      type: 'local-executable',
      executableName: 'amazon-sharepoint-mcp',
      args: [],
    });
  });

  it('declares the R1.2 required tools — and every one classifies as a free read', () => {
    expect([...profile.requiredTools].sort()).toEqual([
      'sharepoint_list_files',
      'sharepoint_list_libraries',
      'sharepoint_list_shared_with_me',
      'sharepoint_list_sites',
      'sharepoint_read_file',
      'sharepoint_resolve_url',
      'sharepoint_search',
    ]);
    // Registry/policy coherence: a required tool that classified as write
    // would make the sync unbuildable again (the §8.5 build blocker).
    for (const tool of SHAREPOINT_MCP_REQUIRED_TOOLS) {
      expect(classifyMcpTool('sharepoint', tool), tool).toBe('read');
    }
  });

  it('redacts errors and discards stderr (R1.3)', () => {
    expect(profile.policy.redactErrors).toBe(true);
    expect(profile.policy.discardStderr).toBe(true);
    expect(profile.policy.allowGenericToolCalls).toBe(true);
  });

  it('exposes the three setup terminal commands in dependency order', () => {
    expect(profile.terminalCommands.map(c => c.id)).toEqual(['update-toolbox', 'install', 'midway']);
    expect(getTerminalCommandDefinition(profile, 'install')?.argv)
      .toEqual(['aim', 'mcp', 'install', 'amazon-sharepoint-mcp']);
    expect(getTerminalCommandDefinition(profile, 'midway')?.argv).toEqual(['mwinit']);
  });

  it('has no setup actions (auth is Midway; nothing to initialize)', () => {
    expect(profile.setupActions).toEqual([]);
  });
});
