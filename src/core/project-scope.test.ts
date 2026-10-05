import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  evaluateProjectEvidenceScope,
  evidenceAnchorsForeignScope,
  projectScopeDefinitionsForTests,
  type ProjectScopeEvaluation,
} from './project-scope.js';

/**
 * The scope rules evaluate many project titles against one evidence string.
 * They now index the evidence once instead of re-tokenizing it per title (a
 * 2.4M-character file over ~150 titles froze the main thread for ~25 s). These
 * properties pin the indexed answers to the brute-force definition: compare
 * every title token with every evidence token through `tokensMatch`, and test
 * the exact phrase against the fully normalized evidence.
 */
const { semanticTokens, tokensMatch, normalizePhrase } = projectScopeDefinitionsForTests;

function bruteForceEvaluate(title: string, evidence: string): ProjectScopeEvaluation {
  const titleTokens = semanticTokens(title);
  if (titleTokens.length === 0) {
    return { matches: false, score: 0, matchedTokens: [], hasDistinctiveAnchor: false, hasExactPhraseAnchor: false, reason: 'title has no enforceable subject tokens' };
  }
  if (!evidence.trim()) {
    return { matches: false, score: 0, matchedTokens: [], hasDistinctiveAnchor: false, hasExactPhraseAnchor: false, reason: 'evidence body is empty' };
  }
  const evidenceTokens = semanticTokens(evidence);
  const matched = titleTokens.filter((token) => evidenceTokens.some((candidate) => tokensMatch(token.value, candidate.value)));
  const score = matched.reduce((sum, token) => sum + token.weight, 0);
  const normalizedTitle = normalizePhrase(title);
  const exactPhrase = normalizedTitle.length >= 5
    && normalizedTitle.includes(' ')
    && normalizePhrase(evidence).includes(normalizedTitle);
  const hasDistinctiveAnchor = matched.some((token) => token.weight >= 2);
  const matches = exactPhrase || matched.length >= 2 || hasDistinctiveAnchor;
  return {
    matches,
    score,
    matchedTokens: matched.map((token) => token.value),
    hasDistinctiveAnchor,
    hasExactPhraseAnchor: exactPhrase,
    reason: matches
      ? `matched title scope via ${matched.map((token) => token.value).join(', ') || 'exact title phrase'}`
      : `insufficient title evidence (${matched.map((token) => token.value).join(', ') || 'no subject tokens matched'})`,
  };
}

// Words chosen to exercise every match rule: exact, shared stems
// (route/routed/routing), containment both ways (room ⊂ dataroom ⊂
// datarooms), generic stop words, technical weight (digits, CamelCase,
// ALLCAPS, _ and -), short tokens, and case mappings that change the
// normalized phrase (Kelvin sign → k, dotted İ → i + U+0307).
const WORDS = [
  'route', 'routed', 'routing', 'router', 'routes', 'data', 'room', 'rooms', 'dataroom', 'datarooms',
  'insight', 'insights', 'catalog', 'catalogs', 'inference', 'vllm', 'VLLM', 'moonshot', 'gpt-5', 'sql_context',
  'R4', 'WiFi', 'AWS', 'mx', 'pv', 'ab', 'abcde', 'abcdef', 'bcdef', 'the', 'and', 'project', 'review', 'of', 'a',
  'pea\u212Ach', 'Peak', '\u0130nsight', 'caf\u00e9', 'na\u00efve', 'x1', '2026', 'k',
];
const SEPARATORS = [' ', ' ', ' ', '\n', '-', '_', '.', ', ', ' \u2014 ', '\u00a0', '"', '/', '__', '  '];

const wordArb = fc.constantFrom(...WORDS);
const separatorArb = fc.constantFrom(...SEPARATORS);
const textArb = (maxWords: number) => fc
  .array(fc.tuple(wordArb, separatorArb), { minLength: 0, maxLength: maxWords })
  .map((parts) => parts.map(([word, separator]) => `${word}${separator}`).join(''));
const titleArb = fc.array(wordArb, { minLength: 1, maxLength: 4 }).map((words) => words.join(' '));

describe('project scope evidence index', () => {
  it('matches the brute-force definition for short evidence', () => {
    fc.assert(
      fc.property(titleArb, textArb(40), (title, evidence) => {
        expect(evaluateProjectEvidenceScope(title, evidence)).toEqual(bruteForceEvaluate(title, evidence));
      }),
      { numRuns: 1_500 },
    );
  });

  it('matches the brute-force definition for reused large-evidence indexes', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(titleArb, { minLength: 1, maxLength: 6 }), textArb(60), textArb(30), async (titles, head, tail) => {
        // Over the reuse threshold; filler words add tokens but the property
        // still holds for whatever the evidence contains.
        const evidence = `${head}${' route the data'.repeat(400)}${tail}`;
        for (const title of titles) {
          expect(evaluateProjectEvidenceScope(title, evidence)).toEqual(bruteForceEvaluate(title, evidence));
        }
        // A different evidence string in the same synchronous section and
        // after a microtask must never be answered from the earlier index.
        const other = `${tail} insights${' x1'.repeat(1_500)}`;
        expect(evaluateProjectEvidenceScope(titles[0], other)).toEqual(bruteForceEvaluate(titles[0], other));
        await Promise.resolve();
        expect(evaluateProjectEvidenceScope(titles[0], evidence)).toEqual(bruteForceEvaluate(titles[0], evidence));
      }),
      { numRuns: 150 },
    );
  });

  it('keeps the phrase rule exact across separators and case mappings', () => {
    // "data room" is a suffix/prefix phrase inside "bigdata roomy".
    expect(evaluateProjectEvidenceScope('Data Room', 'notes on bigdata roomy plans').hasExactPhraseAnchor).toBe(true);
    // The Kelvin sign lowercases to "k": "pea\u212Ach plan" normalizes to "peakch plan".
    expect(evaluateProjectEvidenceScope('peakch plan', 'the pea\u212Ach plan').hasExactPhraseAnchor).toBe(true);
    // Separator runs collapse to one space; letters never bridge words.
    expect(evaluateProjectEvidenceScope('vllm config', 'vllm \u2014 config').hasExactPhraseAnchor).toBe(true);
    expect(evaluateProjectEvidenceScope('vllm config', 'vllmconfig').hasExactPhraseAnchor).toBe(false);
    expect(evaluateProjectEvidenceScope('Data Room', '   \n\t ').reason).toBe('evidence body is empty');
  });

  it('checks a large file against a full portfolio without blocking the main thread', () => {
    // Shaped like the training-progress JSON that froze BotBoy for ~25 s per
    // update: millions of characters, tens of thousands of distinct tokens.
    const rows: string[] = [];
    let length = 0;
    for (let step = 0; length < 2_400_000; step++) {
      const row = `{"step": ${step}, "loss_${step % 997}": 0.${(step * 7919) % 1_000_003}, "phase": "warmup-${step % 31}"},\n`;
      rows.push(row);
      length += row.length;
    }
    const evidence = `training-progress.json\n[${rows.join('')}]`;
    const titles = Array.from({ length: 150 }, (_, index) => `Portfolio Initiative ${index} Mobile Catalog Insights v${index % 9}`);
    const started = Date.now();
    evidenceAnchorsForeignScope('Mood Match Neural Memory Training', evidence, titles);
    expect(Date.now() - started).toBeLessThan(5_000);
  }, 30_000);
});
