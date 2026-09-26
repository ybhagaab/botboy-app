/**
 * Comparison-only normalization for natural analytics references.
 *
 * Returned catalog text always keeps its original spelling. This key exists
 * only so punctuation, Unicode dash variants, compatibility forms, case, and
 * whitespace cannot make an otherwise exact natural reference miss.
 */
export function normalizeAnalyticsSearchText(value: unknown): string {
  return String(value ?? '')
    .normalize('NFKC')
    .toLocaleLowerCase('en-US')
    .replace(/[\p{P}\p{S}]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

export function analyticsSearchIncludes(haystack: unknown, needle: string): boolean {
  const normalizedHaystack = normalizeAnalyticsSearchText(haystack);
  const normalizedNeedle = normalizeAnalyticsSearchText(needle);
  if (!normalizedNeedle) return false;
  if (normalizedHaystack.includes(normalizedNeedle)) return true;

  // Natural references often omit connective words that remain in a title,
  // for example "Engagement Retention" for "Engagement and Retention".
  // Preserve query-token order and require every token rather than using an
  // unordered bag of words, which keeps matching useful without making a
  // generic word select unrelated datasets.
  const haystackTokens = normalizedHaystack.split(' ');
  const needleTokens = normalizedNeedle.split(' ');
  let haystackIndex = 0;
  for (const token of needleTokens) {
    const nextIndex = haystackTokens.indexOf(token, haystackIndex);
    if (nextIndex < 0) return false;
    haystackIndex = nextIndex + 1;
  }
  return true;
}
