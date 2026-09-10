import { describe, expect, it, vi } from 'vitest';
import { createAgentOrchestrator } from './agent.js';
import { LlmPayloadTooLargeError } from './llm-client.js';

describe('background agent payload recovery', () => {
  it('resumes the same instruction through normal tools after one image-free recovery call', async () => {
    const screenshot = `data:image/jpeg;base64,${'A'.repeat(4_200)}`;
    const seenRequests: any[] = [];
    let call = 0;
    const llmClient = {
      chatCompletion: vi.fn(async (request: any) => {
        seenRequests.push(structuredClone(request));
        const index = call++;
        if (index === 0) {
          return {
            content: '',
            toolCalls: [{ id: 'shot_1', type: 'function', function: { name: 'browser_screenshot', arguments: '{"tabId":"tab_1"}' } }],
            providerOutput: [],
            usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
            finishReason: 'tool_calls',
          };
        }
        if (index === 1) {
          throw new LlmPayloadTooLargeError(
            { bodyChars: 6_099_000, bodyBytes: 6_100_000, imageCount: 1, imageChars: screenshot.length },
            5_500_000,
          );
        }
        if (index === 2) {
          return {
            content: '',
            toolCalls: [{ id: 'search_1', type: 'function', function: { name: 'search_items', arguments: '{"query":"original task"}' } }],
            providerOutput: [],
            usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
            finishReason: 'tool_calls',
          };
        }
        return {
          content: 'Recovered and completed the original background instruction.',
          toolCalls: null,
          providerOutput: [],
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          finishReason: 'stop',
        };
      }),
    };
    const toolExecutor = {
      executeTool: vi.fn(async (toolCall: any) => toolCall.function.name === 'browser_screenshot'
        ? {
            content: '{"filePath":"/tmp/full-owner.png","tabId":"tab_1"}',
            imageEvidence: [{
              dataUrl: screenshot,
              evidenceKey: 'browser:tab_1',
              source: 'browser_screenshot',
              mimeType: 'image/jpeg',
              bytes: 3_000,
              width: 100,
              height: 100,
            }],
          }
        : { content: '{"matches":["text evidence"]}' }),
    };
    const promptManager = {
      getSystemPrompt: () => 'You are BotBoy.',
      getToolDefinitions: () => [{ type: 'function', function: { name: 'search_items', description: 'search', parameters: {} } }],
    };
    const nodeManager = {
      listNodes: () => [],
      getNode: () => null,
      getNodeItemCount: () => 0,
      getNodeWorkItems: () => [],
    };
    const agent = createAgentOrchestrator(
      {} as any,
      { sendPrompt: vi.fn() } as any,
      nodeManager as any,
      undefined,
      undefined,
      undefined,
      llmClient as any,
      toolExecutor as any,
      promptManager as any,
    );

    const result = await agent.executeAction('Inspect the page and complete the original task.');

    expect(result).toBe('Recovered and completed the original background instruction.');
    expect(llmClient.chatCompletion).toHaveBeenCalledTimes(4);
    expect(toolExecutor.executeTool).toHaveBeenCalledTimes(2);
    expect(seenRequests[1].messages.flatMap((message: any) => message.images ?? [])).toEqual([screenshot]);
    expect(seenRequests[2].messages.flatMap((message: any) => message.images ?? [])).toEqual([]);
    expect(seenRequests[2].payloadConstraint).toEqual({
      requireImageFree: true,
      smallerThanBytes: 6_100_000,
    });
    expect(seenRequests[2].messages.some((message: any) => message.content === 'Inspect the page and complete the original task.')).toBe(true);
    expect(seenRequests[2].messages.some((message: any) => String(message.content).includes('/tmp/full-owner.png'))).toBe(true);
    expect(seenRequests[2].messages.at(-1)?.content).toContain('continue the same owner task');
  });
});
