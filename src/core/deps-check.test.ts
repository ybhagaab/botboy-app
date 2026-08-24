import { describe, it, expect } from 'vitest';
import { checkDependencies, visionHelperPath } from './deps-check.js';
import { existsSync } from 'fs';

describe('deps-check', () => {
  it('returns a structured report with a decision and detail per dep', () => {
    const report = checkDependencies();
    expect(Array.isArray(report.deps)).toBe(true);
    expect(report.deps.length).toBeGreaterThan(0);
    for (const d of report.deps) {
      expect(typeof d.name).toBe('string');
      expect(typeof d.ok).toBe('boolean');
      expect(typeof d.detail).toBe('string');
      expect(d.detail.length).toBeGreaterThan(0); // actionable, never empty
    }
  });

  it('surfaces an actionable message when something is missing (never silent)', () => {
    const report = checkDependencies();
    if (!report.ok) {
      expect(report.message).toContain('missing');
    } else {
      expect(report.message).toBe('');
    }
  });

  it('reports OCR availability consistent with the built helper binary', () => {
    const report = checkDependencies();
    const ocr = report.deps.find((d) => d.name.startsWith('ocr'))!;
    const builtOnMac = process.platform === 'darwin' && existsSync(visionHelperPath());
    expect(ocr.ok).toBe(builtOnMac);
  });
});
