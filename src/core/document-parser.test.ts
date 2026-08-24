import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { createDocumentParser } from './document-parser.js';

describe('DocumentParser', () => {
  let dir: string;
  const parser = createDocumentParser();

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'ppt-docparse-test-'));
  });
  afterEach(() => {
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  });

  it('lists supported formats', () => {
    const fmts = parser.getSupportedFormats();
    expect(fmts).toContain('.pdf');
    expect(fmts).toContain('.docx');
    expect(fmts).toContain('.md');
  });

  it('reads plain-text files in full with no length cap', () => {
    const big = 'A'.repeat(200000); // 200 KB — well past the old 15K cap
    const p = path.join(dir, 'big.txt');
    writeFileSync(p, big, 'utf8');
    const result = parser.parse(p);
    expect(result.success).toBe(true);
    expect(result.text).toBe(big);
    expect(result.text!.length).toBe(200000);
  });

  it('parses markdown and json as text', () => {
    const mdPath = path.join(dir, 'note.md');
    writeFileSync(mdPath, '# Title\n\nbody', 'utf8');
    expect(parser.parse(mdPath).text).toContain('# Title');

    const jsonPath = path.join(dir, 'data.json');
    writeFileSync(jsonPath, '{"a":1}', 'utf8');
    expect(parser.parse(jsonPath).text).toBe('{"a":1}');
  });

  it('returns explicit failure for unsupported format', () => {
    const p = path.join(dir, 'file.xyz');
    writeFileSync(p, 'x', 'utf8');
    const result = parser.parse(p);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Unsupported format/);
  });

  it('returns explicit failure for a missing file', () => {
    const result = parser.parse(path.join(dir, 'nope.pdf'));
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not found/i);
  });

  it('handles a path containing shell metacharacters safely (no injection)', () => {
    // A filename that WOULD be dangerous under shell string interpolation.
    const nasty = path.join(dir, 'a; touch pwned .txt');
    writeFileSync(nasty, 'safe content', 'utf8');
    const result = parser.parse(nasty);
    expect(result.success).toBe(true);
    expect(result.text).toBe('safe content');
    // No file named 'pwned' was created by a shell interpreting the ';'.
    expect(require('fs').existsSync(path.join(process.cwd(), 'pwned'))).toBe(false);
  });
});
