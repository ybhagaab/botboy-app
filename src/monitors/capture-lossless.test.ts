/**
 * Regression guard for lossless capture (lossless-capture-brain-pipeline R1).
 *
 * The clipboard/browser/slack monitors are closure-based and poll live system
 * resources, so they are awkward to exercise behaviorally in a unit test. These
 * tests instead assert — at the source level — that the specific truncation
 * caps we removed do not reappear. Each captured field's full content must
 * reach the event bus; short forms are derived previews only.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const read = (f: string) => readFileSync(path.join(dir, f), 'utf8');

describe('lossless capture — monitors do not re-introduce content caps', () => {
  it('clipboard monitor does not cap clipboard content at 100KB', () => {
    const src = read('clipboard-monitor.ts');
    expect(src).not.toContain('102400');
    // The emitted content must be the full text, not a slice.
    expect(src).toMatch(/const content = text;/);
  });

  it('slack monitor does not cap message content at 5000 chars', () => {
    const src = read('slack-monitor.ts');
    expect(src).not.toMatch(/content\.slice\(0,\s*5000\)/);
    // Emitted as the full `content` (property shorthand), not a slice.
    expect(src).toMatch(/^\s*content,\s*$/m);
  });

  it('browser monitor does not cap extracted page content with substring(0, N>=1000)', () => {
    const src = read('browser-monitor.ts');
    // No large character caps remain (per-row list previews of 200 are allowed).
    for (const cap of ['15000', '10000', '4500', '3000', '2000']) {
      expect(src.includes(`substring(0, ${cap})`), `found substring cap ${cap}`).toBe(false);
    }
  });
});
