/**
 * The three briefing constants the Knowledge library shares (knowledge-library.md K7, K8). They were module-private;
 * the library exports them so its token arithmetic cannot drift from the briefing's capacity gate. The values do not
 * change, and this test fails if anyone changes one without meaning to change both sides.
 */
import { describe, expect, it } from 'vitest';
import { ESTIMATED_CHARS_PER_TOKEN, KNOWLEDGE_COMPLETE_MAX_CHARS, RUNTIME_RESERVE_TOKENS } from './analytics-chat-context.js';
import { estimateTokens } from './knowledge-guide.js';

describe('briefing constants shared with the Knowledge library', () => {
  it('keeps the values the briefing has always used', () => {
    expect(ESTIMATED_CHARS_PER_TOKEN).toBe(2.7);
    expect(RUNTIME_RESERVE_TOKENS).toBe(48_000);
    expect(KNOWLEDGE_COMPLETE_MAX_CHARS).toBe(2_000_000);
  });
  it('the library estimator is the briefing estimator', () => {
    expect(estimateTokens('a'.repeat(2_700))).toBe(1_000);
    expect(estimateTokens('a'.repeat(2_701))).toBe(Math.ceil(2_701 / ESTIMATED_CHARS_PER_TOKEN));
  });
});
