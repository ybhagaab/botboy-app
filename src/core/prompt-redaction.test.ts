import { describe, expect, it } from 'vitest';
import { redactSensitiveText } from './prompt-redaction.js';

describe('redactSensitiveText', () => {
  it('redacts query credentials and JWT-shaped tokens in every prompt lane', () => {
    expect(redactSensitiveText(
      'https://example.test/cb?code=secret-code&state=secret-state token=secret-token eyJabc.def_ghi.jkl-123',
    )).toBe(
      'https://example.test/cb?code=[REDACTED]&state=[REDACTED] token=[REDACTED] [REDACTED_TOKEN]',
    );
  });
});
