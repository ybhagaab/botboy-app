import { describe, expect, it } from 'vitest';
import { createPromptManager } from './prompt-manager.js';

/**
 * Owner rule 2026-10-23: a DeepSeek chat said Gmail was disconnected because earlier messages had said so; asked to
 * actually check, the same turn's tool call worked. Before telling the owner a tool or connection is down, the model
 * calls it now and reports what that call returns.
 */
describe('failure claims are checked like success claims', () => {
  it('sits in Action Integrity, next to the rule for past-tense claims', () => {
    const prompt = createPromptManager().getSystemPrompt('chat');
    const integrity = prompt.slice(prompt.indexOf('## CRITICAL: Action Integrity'));
    const section = integrity.slice(0, integrity.indexOf('\n## ', 5));
    expect(section).toContain('- Never call a tool or connection failed, disconnected or unavailable from earlier messages or memory: call it now and report what it returns, with the exact error.');
    expect(section.indexOf('- Before claiming any past-tense action')).toBeLessThan(section.indexOf('- Never call a tool or connection failed'));
  });
});
