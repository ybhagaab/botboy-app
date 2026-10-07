import { describe, expect, it } from 'vitest';
import { createPromptManager } from './prompt-manager.js';
import type { McpProfileSnapshot } from './mcp-types.js';

/**
 * Operating knowledge for adding MCP servers from chat
 * (MCP_REMOTE_TRANSPORTS_PLAN.md MR1 §4): the tools mirror the common config
 * shape, the guidance is one find → add → card → setup → test loop, and the
 * inventory names each server's card and where remote calls go.
 */

function customProfile(patch: Partial<McpProfileSnapshot>): McpProfileSnapshot {
  return {
    id: 'custom-docs', kind: 'custom', displayName: 'Docs', enabled: false, configured: false, state: 'stopped',
    tools: [], restartCount: 0, lastError: null, lastStartedAt: null, lastHealthyAt: null, updatedAt: '',
    installationState: 'installed', compatibilityState: 'unchecked', requiredTools: [], missingTools: [], needsReview: false,
    custom: { transport: 'http', endpointHost: 'docs.example.com', about: {}, missingValues: [] },
    ...patch,
  } as McpProfileSnapshot;
}

describe('MCP server setup tools and guidance', () => {
  const pm = createPromptManager();
  const tools = pm.getToolDefinitions('chat');
  const schema = (name: string) => tools.find(tool => tool.function.name === name)!.function.parameters as any;

  it('gives chat a registry lookup and add/update tools in the common config shape', () => {
    expect(tools.map(tool => tool.function.name)).toEqual(expect.arrayContaining(['mcp_find_server', 'mcp_add_custom_server', 'mcp_update_custom_server', 'mcp_get_custom_server_config']));
    expect(schema('mcp_find_server').required).toEqual(['query']);
    const fields = ['name', 'command', 'args', 'env', 'url', 'type', 'headers', 'secret', 'required', 'about'];
    expect(Object.keys(schema('mcp_add_custom_server').properties)).toEqual([...fields, 'ownerRequested']);
    expect(schema('mcp_add_custom_server').required).toEqual(['name', 'ownerRequested']);
    expect(Object.keys(schema('mcp_update_custom_server').properties)).toEqual(['serverId', ...fields, 'ownerRequested']);
    expect(schema('mcp_update_custom_server').required).toEqual(['serverId', 'ownerRequested']);
    const add = tools.find(tool => tool.function.name === 'mcp_add_custom_server')!.function.description;
    expect(add).toMatch(/Never write a secret value/);
    expect(add).toMatch(/you cannot press it/);
  });

  it('teaches one setup loop and drops the old connection-page-only path', () => {
    const system = pm.getSystemPrompt('chat');
    expect(system).toContain('ADDING AN MCP SERVER');
    expect(system).toContain('mcp_find_server');
    expect(system).toContain('[[mcp-server:<id>]]');
    expect(system).toContain('never into chat or send_terminal_input');
    expect(system).not.toContain('reviewUrl');
    expect(system).not.toContain('direct the owner to the Edit page');
  });

  it('names the card, the waiting values, and the remote host in the live inventory', () => {
    const system = pm.getSystemPrompt('chat', {
      mcpServers: [
        customProfile({ needsReview: true, custom: { transport: 'http', endpointHost: 'docs.example.com', about: {}, missingValues: ['header Authorization'] } }),
        customProfile({ id: 'custom-keyed', displayName: 'Keyed', custom: { transport: 'auto', endpointHost: 'keyed.example.com', about: {}, missingValues: ['API_KEY'] } }),
        customProfile({ id: 'custom-local', displayName: 'Local', custom: { transport: 'stdio', about: {}, missingValues: [] } }),
      ],
    });
    expect(system).toContain('### Docs — id: custom-docs — remote at docs.example.com — NEEDS OWNER REVIEW — you cannot start it; the owner types header Authorization and presses Start on its card [[mcp-server:custom-docs]]');
    expect(system).toContain('### Keyed — id: custom-keyed — remote at keyed.example.com — WAITING FOR THE OWNER — they type API_KEY on its card [[mcp-server:custom-keyed]], then press Start');
    expect(system).toContain('### Local — id: custom-local — STOPPED — mcp_profile_action start runs it when the owner wants to use it');
  });
});
