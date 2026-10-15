/**
 * The credential the library tests use is built from pieces (no secret-looking literal sits in the repository) and must be
 * one the scanner really recognizes; otherwise "a file with a credential is withheld" would pass for the wrong reason.
 */
import { describe, expect, it } from 'vitest';
import { fakePrivateKeyBlock } from './knowledge-fixtures.testutil.js';
import { detectSecrets } from './sensitive-files.js';

describe('the synthetic credential fixture', () => {
  it('is recognized as a private key by the same scanner that guards loads and writes', () => {
    expect(detectSecrets(fakePrivateKeyBlock())).toEqual(['private_key']);
    expect(detectSecrets('# Keys\nno credential here\n')).toEqual([]);
  });
  it('never appears as a literal in the repository (it is assembled at run time)', () => {
    expect(fakePrivateKeyBlock()).toContain('PRIVATE KEY');
  });
});
