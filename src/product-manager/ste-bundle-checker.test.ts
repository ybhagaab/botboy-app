import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { EXPECTED_STE_ISSUE9_SHA256, loadSteBundle } from './ste-bundle.js';
import { createSteChecker } from './ste-checker.js';
import type { GlossaryResolution, SteBundleReadiness, SteStandardBundle } from './types.js';

const cleanup: string[] = [];
afterEach(() => {
  while (cleanup.length > 0) fs.rmSync(cleanup.pop()!, { recursive: true, force: true });
});

function ruleIds(): string[] {
  const counts = [14, 2, 7, 5, 5, 6, 3, 7, 4];
  const ids = counts.flatMap((count, sectionIndex) => Array.from({ length: count }, (_, index) => `${sectionIndex + 1}.${index + 1}`));
  return [...ids, ...Array.from({ length: 8 }, (_, index) => `GR-${index + 1}`)];
}

function fixtureBundle(status: 'pending' | 'approved' = 'pending'): SteStandardBundle {
  return {
    schemaVersion: 'asd-ste100-bundle.v1',
    standardId: 'ASD-STE100',
    issue: 9,
    issueDate: '2025-01-15',
    sourceSha256: EXPECTED_STE_ISSUE9_SHA256,
    extractedAt: '2026-08-08T12:00:00.000Z',
    extractorVersion: 'test-extractor.v1',
    inventory: {
      rules: 53,
      generalRecommendations: 8,
      approvedWords: 875,
      nonApprovedEntries: 1274,
      extractedDictionaryRecords: 2,
      extractedApprovedRecords: 1,
      extractedNonApprovedRecords: 1,
    },
    rules: ruleIds().map((ruleId) => ({
      ruleId,
      section: ruleId.startsWith('GR-') ? 'general recommendations' : `section ${ruleId.split('.')[0]}`,
      page: 45,
    })),
    dictionary: [
      {
        entryId: 'use|v|test',
        term: 'USE',
        normalizedTerm: 'use',
        approved: true,
        partOfSpeech: ['v'],
        forms: ['USES', 'USED'],
        page: 200,
      },
      {
        entryId: 'utilize|v|test',
        term: 'utilize',
        normalizedTerm: 'utilize',
        approved: false,
        partOfSpeech: ['v'],
        alternatives: ['USE'],
        page: 400,
      },
    ],
    diagnostics: ['[review] Original test fixture.'],
    humanApproval: status === 'approved'
      ? { status, reviewer: 'Test reviewer', reviewedAt: '2026-08-08T13:00:00.000Z' }
      : { status },
  };
}

function writeBundle(bundle: SteStandardBundle): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'botboy-ste-bundle-'));
  cleanup.push(directory);
  const filePath = path.join(directory, 'bundle.json');
  fs.writeFileSync(filePath, JSON.stringify(bundle));
  return filePath;
}

function readiness(status: 'pending' | 'approved'): SteBundleReadiness {
  const bundle = fixtureBundle(status);
  return {
    ready: status === 'approved',
    available: true,
    approved: status === 'approved',
    path: '/local/test/bundle.json',
    bundle,
    diagnostics: [],
  };
}

const emptyGlossary: GlossaryResolution = {
  entries: [],
  approvedTerms: [],
  candidateTerms: [],
  conflicts: [],
  diagnostics: [],
};

describe('local Issue 9 bundle readiness', () => {
  it('distinguishes missing, pending, and explicitly approved bundles', () => {
    const missingDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'botboy-ste-missing-'));
    cleanup.push(missingDirectory);
    const missing = loadSteBundle({ bundlePath: path.join(missingDirectory, 'missing.json') });
    expect(missing).toMatchObject({ available: false, approved: false, ready: false });

    const pending = loadSteBundle({ bundlePath: writeBundle(fixtureBundle('pending')) });
    expect(pending).toMatchObject({ available: true, approved: false, ready: false });
    expect(pending.diagnostics.join(' ')).toContain('pending');

    const approved = loadSteBundle({ bundlePath: writeBundle(fixtureBundle('approved')) });
    expect(approved).toMatchObject({ available: true, approved: true, ready: true });
    expect(approved.bundle?.rules).toHaveLength(61);
  });
});

describe('deterministic STE checker', () => {
  it('reports stable locations for built-in checks and protects quotations and code', () => {
    const content = [
      '# Procedure',
      '1. The technician has installed the cover when the blue lamp is off; it shouldn\'t move. It should remain stable.',
      '> The quoted source says it shouldn\'t move.',
      '`const guidance = "should";`',
    ].join('\n');
    const result = createSteChecker().check({
      content,
      mode: 'advisory',
      glossary: emptyGlossary,
      bundleReadiness: { ready: false, available: false, approved: false, path: '/missing', diagnostics: [] },
    });
    const codes = result.findings.map((finding) => finding.code);
    expect(codes).toEqual(expect.arrayContaining([
      'STE_PRESENT_PERFECT_HEURISTIC',
      'STE_CONDITION_ORDER_HEURISTIC',
      'STE_IMPERATIVE_HEURISTIC',
      'STE_SEMICOLON',
      'STE_CONTRACTION',
      'STE_MODALITY',
    ]));
    expect(result.findings.filter((finding) => finding.code === 'STE_CONTRACTION')).toHaveLength(1);
    expect(result.findings.find((finding) => finding.code === 'STE_PRESENT_PERFECT_HEURISTIC')?.location).toMatchObject({ line: 2, column: 19 });
    expect(result.protectedSegmentCount).toBeGreaterThanOrEqual(2);
    expect(result.status).toBe('pass_with_advisories');
  });

  it('enforces sentence and paragraph limits with original examples', () => {
    const longSentence = 'The service records each request and stores every response so operators can compare daily results across all active regions before the scheduled review meeting begins for the final audit.';
    const sevenSentences = 'One signal is active. A second signal is active. A third signal is active. A fourth signal is active. A fifth signal is active. A sixth signal is active. A seventh signal is active.';
    const result = createSteChecker().check({
      content: `${longSentence}\n\n${sevenSentences}`,
      mode: 'advisory',
      bundleReadiness: { ready: false, available: false, approved: false, path: '/missing', diagnostics: [] },
    });
    expect(result.findings.map((finding) => finding.code)).toEqual(expect.arrayContaining([
      'STE_DESCRIPTIVE_SENTENCE_LENGTH',
      'STE_PARAGRAPH_SENTENCE_COUNT',
    ]));
  });

  it('uses an approved bundle for dictionary findings and fails full mode closed otherwise', () => {
    const checked = createSteChecker().check({
      content: 'The operator MUST utilize the local control.',
      mode: 'enforced_full',
      glossary: emptyGlossary,
      bundleReadiness: readiness('approved'),
    });
    expect(checked.status).toBe('blocked');
    expect(checked.findings.find((finding) => finding.code === 'STE_DICTIONARY_NON_APPROVED')).toMatchObject({
      severity: 'error',
      suggestion: expect.stringContaining('USE'),
    });
    expect(checked.conformanceStatement).toContain('not ASD certification or approval');

    const pending = createSteChecker().check({
      content: 'Use the local control.',
      mode: 'enforced_full',
      glossary: emptyGlossary,
      bundleReadiness: readiness('pending'),
    });
    expect(pending.status).toBe('blocked');
    expect(pending.findings.find((finding) => finding.code === 'STE_BUNDLE_NOT_READY')?.severity).toBe('block');
  });

  it('does not run checks in off mode', () => {
    const result = createSteChecker().check({ content: 'It should not matter;', mode: 'off' });
    expect(result).toMatchObject({ status: 'not_checked', findings: [], checkedSegmentCount: 0 });
  });
});
