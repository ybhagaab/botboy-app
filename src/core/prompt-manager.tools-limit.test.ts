import { describe, expect, it } from 'vitest';
import { createPromptManager } from './prompt-manager.js';

/**
 * OpenAI and DeepSeek accept at most 128 tools in one request (DeepSeek: "up to 128" functions; OpenAI's function
 * calling limit is the same), so a chat turn with every optional tool family switched on must stay within it. The
 * Google family is six tools for this reason (google-workspace.md, 2026-10-23); a new family consolidates the same way.
 */
const PROVIDER_TOOL_LIMIT = 128;

describe('the chat tool list fits every provider', () => {
  const everyFamily = {
    amazonEmployee: true,
    driveConnected: true,
    driveEditable: true,
    calendarConnected: true,
    knowledgeAvailable: true,
    knowledgeWriteAvailable: true,
    uiThemeAvailable: true,
    jobNotifyAvailable: true,
  };
  // A job's turns get delete_working_file, the main chat gets jobs (PARALLEL_JOBS_PLAN.md §11): never both in one turn.
  for (const [label, turn, offered, withheld] of [
    ['a job\'s turn', { jobTurn: true }, 'delete_working_file', 'jobs'],
    ['a main-chat turn', { mainChatTurn: true }, 'jobs', 'delete_working_file'],
  ] as const) {
    it(`stays at or under 128 tools with every optional family offered, in ${label}`, () => {
      const tools = createPromptManager().getToolDefinitions('chat', { ...everyFamily, ...turn } as any);
      const names = tools.map(tool => tool.function.name);
      expect(new Set(names).size).toBe(names.length);
      expect(names.length).toBeLessThanOrEqual(PROVIDER_TOOL_LIMIT);
      expect(names).toContain(offered);
      expect(names).not.toContain(withheld);
    });
  }

  it('a turn that is both never gets both tools', () => {
    const names = createPromptManager().getToolDefinitions('chat', { ...everyFamily, jobTurn: true, mainChatTurn: true } as any)
      .map(tool => tool.function.name);
    expect(names).toContain('delete_working_file');
    expect(names).not.toContain('jobs');
  });
});
