import { describe, expect, it, vi } from 'vitest';
import { createAgentOrchestrator } from './agent.js';
import { createChatInterface } from './chat-interface.js';
import { createStorage } from './storage.js';

/**
 * Owner-started agent runs (GMAIL_CHAT_TOOLS_PLAN.md §2): the server marks
 * the tool calls of a run the owner started, so Gmail search/read can accept
 * them, while BotBoy's own unattended runs stay unmarked.
 */

const toolTurn = () => ({
  content: '',
  toolCalls: [{ id: 'g1', type: 'function', function: { name: 'gmail_search', arguments: '{"query":"from:sam"}' } }],
  providerOutput: [],
  usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  finishReason: 'tool_calls',
});
const finalTurn = () => ({ content: 'done', toolCalls: null, providerOutput: [], usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, finishReason: 'stop' });

describe('owner-started agent runs', () => {
  it('marks the tool calls of a run the owner started, and only those', async () => {
    let call = 0;
    const llmClient = { chatCompletion: vi.fn(async () => (call++ % 2 === 0 ? toolTurn() : finalTurn())), close: vi.fn() };
    const contexts: unknown[] = [];
    const agent = createAgentOrchestrator(
      {} as any,
      { sendPrompt: vi.fn() } as any,
      { listNodes: () => [], getNode: () => null, getNodeItemCount: () => 0, getNodeWorkItems: () => [] } as any,
      undefined, undefined, undefined,
      llmClient as any,
      { executeTool: vi.fn(async (_call: unknown, context: unknown) => { contexts.push(context); return { content: '{}' }; }) } as any,
      { getSystemPrompt: () => 'You are BotBoy.', getToolDefinitions: () => [] } as any,
    );

    await expect(agent.executeAction('Rewrite this passage.', undefined, { workload: 'interactive', startedByOwner: true })).resolves.toBe('done');
    await agent.executeAction('Investigate the repeated failure.');
    await agent.executeAction('Accounting only.', undefined, { workload: 'interactive' });

    expect(contexts).toEqual([
      { currentUserMessage: 'Rewrite this passage.', callerKind: 'background', ownerStartedRun: true },
      { currentUserMessage: 'Investigate the repeated failure.', callerKind: 'background' },
      { currentUserMessage: 'Accounting only.', callerKind: 'background' },
    ]);
  });

  it('runs a non-streaming chat message as a task the owner started', async () => {
    const storage = createStorage(':memory:');
    storage.initialize();
    try {
      const agent = { executeAction: vi.fn(async () => 'ok') } as any;
      const chat = createChatInterface(storage.getDb(), agent);
      expect((await chat.sendMessage('Find Sam’s latest email.')).message.content).toBe('ok');
      expect(agent.executeAction).toHaveBeenCalledWith('Find Sam’s latest email.', undefined, { workload: 'interactive', startedByOwner: true });
    } finally {
      storage.close();
    }
  });
});
