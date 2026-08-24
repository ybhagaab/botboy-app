import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createStorage, StorageLayer } from '../core/storage.js';
import { createSlackMcpClient } from './slack-mcp-client.js';
import { classifyMcpTool, validateMcpToolCall } from '../core/mcp-policy.js';

describe('slack MCP transport client', () => {
  let storage: StorageLayer;

  beforeEach(() => {
    storage = createStorage(':memory:');
    storage.initialize();
  });
  afterEach(() => storage.close());

  function managerReturning(byTool: Record<string, unknown>, state = 'running') {
    const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
    return {
      calls,
      manager: {
        async callTool(serverId: string, tool: string, args: Record<string, unknown>) {
          calls.push({ tool, args });
          if (!(tool in byTool)) throw new Error(`unexpected tool ${tool}`);
          return { serverId, toolName: tool, text: JSON.stringify(byTool[tool]), isError: false, durationMs: 1 };
        },
        async getServer() {
          return { state } as any;
        },
      } as any,
    };
  }

  it('unwraps batch envelopes into WebClient-compatible shapes', async () => {
    const { manager } = managerReturning({
      batch_get_conversation_history: [
        { channelId: 'C1', result: { ok: true, messages: [{ ts: '1.0', text: 'hello' }], response_metadata: { next_cursor: 'abc' } } },
      ],
      batch_get_thread_replies: [
        { channelId: 'C1', threadTs: '1.0', result: { ok: true, messages: [{ ts: '1.0' }, { ts: '2.0' }, { ts: '0.5' }] } },
      ],
      batch_get_user_info: [
        { user: 'U1', result: { id: 'U1', real_name: 'Ada Lovelace', email: 'ada@amazon.com', tz: 'Europe/London' } },
      ],
      batch_get_channel_info: [
        { channelId: 'C1', result: { id: 'C1', name: 'eng', is_private: true } },
      ],
    });
    const client = createSlackMcpClient({ db: storage.getDb(), mcpManager: manager });

    const history = await client.history('C1', { oldest: '0.5', limit: 10 });
    expect(history.messages).toHaveLength(1);
    expect(history.response_metadata?.next_cursor).toBe('abc');

    const replies = await client.replies('C1', '1.0');
    expect(replies.messages).toHaveLength(3);

    const user = await client.userInfo('U1');
    expect(user?.real_name).toBe('Ada Lovelace');
    expect(user?.email).toBe('ada@amazon.com');

    const channel = await client.channelInfo('C1');
    expect(channel?.name).toBe('eng');
    expect(await client.isAvailable()).toBe(true);
  });

  it('resolves and durably caches the owner Slack user ID from their own messages', async () => {
    const { manager, calls } = managerReturning({
      search: { messages: { matches: [{ user: 'W_SELF', ts: '9.0' }] } },
    });
    const client = createSlackMcpClient({ db: storage.getDb(), mcpManager: manager, selfAlias: 'ybhagaab' });
    expect(await client.getSelfUserId()).toBe('W_SELF');
    expect(calls[0].args.query).toBe('from:@ybhagaab');
    // Second call served from the durable cache — no further tool calls.
    expect(await client.getSelfUserId()).toBe('W_SELF');
    expect(calls).toHaveLength(1);
  });

  it('normalizes flat, sectioned, and kind-keyed list_channels payloads', async () => {
    const { manager } = managerReturning({
      list_channels: {
        ok: true,
        sections: [{ name: 'Channels', channels: [{ id: 'C1', is_archived: false }] }],
        ims: [{ id: 'D1', is_im: true }],
        mpims: [{ id: 'G1', is_mpim: true }],
      },
    });
    const client = createSlackMcpClient({ db: storage.getDb(), mcpManager: manager });
    const result = await client.listConversations(['public_and_private', 'dm', 'group_dm'], { limit: 5 });
    expect(result.channels.map((c: any) => c.id).sort()).toEqual(['C1', 'D1', 'G1']);
  });

  it('reports unavailable when the managed server is not running', async () => {
    const { manager } = managerReturning({}, 'stopped');
    const client = createSlackMcpClient({ db: storage.getDb(), mcpManager: manager });
    expect(await client.isAvailable()).toBe(false);
  });
});

describe('slack MCP tool policy', () => {
  it('classifies capture and lookup tools as reads that run freely', () => {
    for (const tool of [
      'search', 'batch_get_conversation_history', 'batch_get_thread_replies',
      'batch_get_user_info', 'batch_get_channel_info', 'get_channel_sections',
      'list_channels', 'download_file_content',
    ]) {
      expect(classifyMcpTool('slack', tool)).toBe('read');
      expect(() => validateMcpToolCall('slack', tool, {})).not.toThrow();
    }
  });

  it('classifies mutating tools as writes that need an explicit owner request', () => {
    for (const tool of ['post_message', 'upload_file', 'create_channel', 'add_channel_members', 'batch_set_last_read', 'self_dm']) {
      expect(classifyMcpTool('slack', tool)).toBe('write');
      expect(() => validateMcpToolCall('slack', tool, {})).toThrow(/explicit owner request/);
      expect(() => validateMcpToolCall('slack', tool, {}, { ownerApproved: true })).not.toThrow();
    }
  });
});
