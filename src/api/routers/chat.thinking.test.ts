import { describe, it, expect } from 'vitest';
import { normalizeThinkingLevel } from './chat.js';

/**
 * Chat-panel thinking dropdown (2026-08-27). The wire value rides POST
 * /chat/messages as `thinking`. Absent means 'off' — the exact pre-dropdown
 * behavior — so older clients and scripts keep working; junk is rejected so
 * a typo cannot silently burn max-effort tokens. Server precedence: document-
 * authoring turns think at max regardless of the dropdown (designed floor).
 */
describe('normalizeThinkingLevel', () => {
  it('defaults absent/empty to off (pre-dropdown behavior preserved)', () => {
    expect(normalizeThinkingLevel(undefined)).toBe('off');
    expect(normalizeThinkingLevel(null)).toBe('off');
    expect(normalizeThinkingLevel('')).toBe('off');
  });

  it('passes each dropdown level through', () => {
    for (const level of ['off', 'low', 'high', 'max']) {
      expect(normalizeThinkingLevel(level)).toBe(level);
    }
  });

  it('rejects unknown values as null (router replies 400)', () => {
    for (const junk of ['medium', 'MAX', 1, true, {}, []]) {
      expect(normalizeThinkingLevel(junk)).toBeNull();
    }
  });
});
