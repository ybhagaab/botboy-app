import { describe, expect, it, vi } from 'vitest';
import { createAgentOrchestrator } from './agent.js';
import { createLlmClientSwitch, type LlmRuntimeIdentity } from './llm-client-switch.js';

const identity = (providerId: string): LlmRuntimeIdentity => ({
  providerId,
  endpoint: `https://${providerId}.example/v1`,
  model: 'gpt-5.6-terra',
  apiMode: 'responses',
  maxContextTokens: 1_000_000,
  source: providerId === 'openai' ? 'settings' : 'environment',
});

function modelClient(reply: () => any) {
  return { chatCompletion: vi.fn(async () => reply()), close: vi.fn() } as any;
}

const toolTurn = () => ({
  content: '',
  toolCalls: [{ id: 'dash_1', type: 'function', function: { name: 'get_analytics_dashboard', arguments: '{"dashboardId":"dash_1"}' } }],
  providerOutput: [{ type: 'reasoning', encrypted_content: 'bound-to-first-provider' }],
  usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  finishReason: 'tool_calls',
});

const finalTurn = () => ({
  content: 'done',
  toolCalls: null,
  providerOutput: [],
  usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  finishReason: 'stop',
});

function agentWith(llmClient: any, executeTool: (...args: any[]) => Promise<any>) {
  const nodeManager = { listNodes: () => [], getNode: () => null, getNodeItemCount: () => 0, getNodeWorkItems: () => [] };
  const promptManager = { getSystemPrompt: () => 'You are BotBoy.', getToolDefinitions: () => [] };
  return createAgentOrchestrator(
    {} as any,
    { sendPrompt: vi.fn() } as any,
    nodeManager as any,
    undefined,
    undefined,
    undefined,
    llmClient,
    { executeTool: vi.fn(executeTool) } as any,
    promptManager as any,
  );
}

describe('background agent loop across a Settings → AI model switch', () => {
  it('stops before sending tool results gathered after a provider change to the pinned provider', async () => {
    const first = modelClient(toolTurn);
    const second = modelClient(finalTurn);
    const llmSwitch = createLlmClientSwitch(first, identity('gateway'));
    const agent = agentWith(llmSwitch, async () => {
      // The owner saves an OpenAI key while this tool runs.
      llmSwitch.activate(second, identity('openai'));
      return { content: '{"rows":[["2026-09",5]]}' };
    });

    const result = await agent.executeAction('Summarize the dashboard.');

    expect(result).toMatch(/^Error: .*AI model was changed/);
    expect(first.chatCompletion).toHaveBeenCalledTimes(1);
    expect(second.chatCompletion).not.toHaveBeenCalled();
  });

  it('completes normally when the provider stays the same', async () => {
    let call = 0;
    const only = modelClient(() => (call++ === 0 ? toolTurn() : finalTurn()));
    const agent = agentWith(createLlmClientSwitch(only, identity('gateway')), async () => ({ content: '{}' }));

    await expect(agent.executeAction('Summarize the dashboard.')).resolves.toBe('done');
    expect(only.chatCompletion).toHaveBeenCalledTimes(2);
  });
});
