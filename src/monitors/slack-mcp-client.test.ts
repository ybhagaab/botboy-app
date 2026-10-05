import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createStorage, StorageLayer } from '../core/storage.js';
import { createSlackMcpClient, SlackCallError, slackErrorKind } from './slack-mcp-client.js';
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

  // 2026-10-02: a Midway expiry reached BotBoy as `{ channelId, error }` inside
  // a successful batch result and was logged as "history unavailable" for
  // 276 conversations, with the cause discarded.
  it('keeps the per-item batch error and classifies it, without the Midway URL', async () => {
    const midway = 'Request to IDP URL https://midway-auth.amazon.com/SSO/redirect?client_id=a&state=b did not redirect. Status code: 401. You may need to authenticate by running mwinit.';
    const { manager } = managerReturning({
      batch_get_conversation_history: [{ channelId: 'C1', error: midway }],
      batch_get_thread_replies: [{ threadTs: '1.0', result: { ok: false, error: 'ratelimited' } }],
    });
    const client = createSlackMcpClient({ db: storage.getDb(), mcpManager: manager });

    const historyError = await client.history('C1', {}).catch((error: unknown) => error);
    expect(historyError).toBeInstanceOf(SlackCallError);
    expect((historyError as SlackCallError).kind).toBe('midway_auth');
    expect((historyError as Error).message).toContain('mwinit');
    expect((historyError as Error).message).not.toContain('state=b');

    const repliesError = await client.replies('C1', '1.0').catch((error: unknown) => error);
    expect((repliesError as SlackCallError).kind).toBe('rate_limited');
  });

  it('treats conversation-specific errors and error-only results as failures of that conversation', async () => {
    const { manager } = managerReturning({
      batch_get_conversation_history: [{ channelId: 'C9', result: { ok: false, error: 'channel_not_found' } }],
    });
    const client = createSlackMcpClient({ db: storage.getDb(), mcpManager: manager });
    const error = await client.history('C9', {}).catch((caught: unknown) => caught);
    expect(slackErrorKind(error)).toBe('conversation_access');

    // An unparseable-timestamp reply carries only `error`: not an empty success.
    const { manager: second } = managerReturning({
      batch_get_conversation_history: [{ channelId: 'C2', result: { channelId: 'C2', oldest: 'x', error: 'invalid oldest' } }],
    });
    const other = createSlackMcpClient({ db: storage.getDb(), mcpManager: second });
    await expect(other.history('C2', {})).rejects.toBeInstanceOf(SlackCallError);
  });

  it('classifies tool errors and unreadable payloads', async () => {
    const calls = {
      async callTool(_server: string, tool: string) {
        if (tool === 'list_channels') return { text: 'bad response: {"ok":false,"error":"invalid_auth"}', isError: true };
        return { text: '=== notice ===\n[not json', isError: false };
      },
      async getServer() { return { state: 'running' } as any; },
    } as any;
    const client = createSlackMcpClient({ db: storage.getDb(), mcpManager: calls });
    const listError = await client.listConversations(['dm']).catch((error: unknown) => error);
    expect(slackErrorKind(listError)).toBe('service_auth');
    const searchError = await client.search('anything').catch((error: unknown) => error);
    expect(slackErrorKind(searchError)).toBe('unexpected_response');
  });

  it('accepts a lone batch entry whose key is named differently', async () => {
    const { manager } = managerReturning({
      batch_get_user_info: [{ userId: 'U1', result: { real_name: 'Ada' } }],
    });
    const client = createSlackMcpClient({ db: storage.getDb(), mcpManager: manager });
    expect((await client.userInfo('U1'))?.real_name).toBe('Ada');
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
