import { describe, expect, it } from 'vitest';
import { createPromptManager } from './prompt-manager.js';

/**
 * OpenAI and DeepSeek accept at most 128 tools in one request (DeepSeek: "up to 128" functions; OpenAI's function
 * calling limit is the same), so a chat turn with every optional tool family switched on must stay within it. The
 * Google family is six tools for this reason (google-workspace.md, 2026-10-23); a new family consolidates the same way.
 */
const PROVIDER_TOOL_LIMIT = 128;

describe('the chat tool list fits every provider', () => {
  it('stays at or under 128 tools with every optional family offered', () => {
    const tools = createPromptManager().getToolDefinitions('chat', {
      amazonEmployee: true,
      driveConnected: true,
      driveEditable: true,
      calendarConnected: true,
      knowledgeAvailable: true,
      knowledgeWriteAvailable: true,
      uiThemeAvailable: true,
      jobNotifyAvailable: true,
    } as any);
    const names = tools.map(tool => tool.function.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names.length).toBeLessThanOrEqual(PROVIDER_TOOL_LIMIT);
  });
});
