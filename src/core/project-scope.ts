/**
 * Stable project-scope rules shared by routing and brain synthesis.
 *
 * Project titles are the durable scope boundary. Mutable summaries are never
 * used to justify an assignment because an earlier bad synthesis can contain
 * exactly the unrelated terms that caused the contamination.
 */

const SOURCE_CONTAINER_TITLE_PATTERNS: RegExp[] = [
  /^inbox(?:\s|$|[•·-])/i,
  /^slack\s*#/i,
  /^slack\s+dm\s+with\b/i,
  /^slack\s+group\s*:/i,
  /^#\S+/,
  /^cross-functional\s+team\s+dm\b/i,
  /^dm\s+(?:conversation|with)\b/i,
  /\(\s*dm(?:\s*-\s*amazon)?\s*\).*\bslack\b/i,
];

const GENERIC_TITLE_TOKENS = new Set([
  'project', 'program', 'initiative', 'tracking', 'tracker', 'work', 'workstream',
  'effort', 'topic', 'support', 'update', 'updates', 'implementation',
  'development', 'feature', 'team', 'request', 'requests', 'analysis', 'research',
  'review', 'overview', 'plan', 'planning', 'status', 'task', 'tasks',
  // Function words describe title grammar, not project scope. Counting them as
  // anchors makes ordinary prose spuriously match unrelated project titles.
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'in', 'into',
  'is', 'it', 'of', 'on', 'or', 'over', 'the', 'to', 'via', 'was', 'were', 'with',
]);

// Artifact labels may be meaningful in general evidence, but they do not name
// the subject of a document-analysis project. This narrower set is used only
// by the exact filename fallback below; the normal scope rules stay unchanged.
const GENERIC_DOCUMENT_SCOPE_TOKENS = new Set([
  'document', 'documents', 'file', 'files', 'pdf', 'report', 'reports',
]);

interface WeightedToken {
  value: string;
  weight: number;
}

export interface ProjectScopeEvaluation {
  matches: boolean;
  score: number;
  matchedTokens: string[];
  /** A weight-2 anchor matched: technical/compound identifier, not just
   * ordinary title vocabulary. Passive folder-ingest evidence must have one
   * (or an exact filename/phrase anchor) to help found a new project. */
  hasDistinctiveAnchor: boolean;
  /** The full normalized title appeared verbatim in the evidence. */
  hasExactPhraseAnchor: boolean;
  reason: string;
}

function normalizePhrase(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
}

function semanticTokens(value: string): WeightedToken[] {
  const rawTokens = value.match(/[A-Za-z0-9][A-Za-z0-9_-]*/g) ?? [];
  const byValue = new Map<string, WeightedToken>();
  for (const raw of rawTokens) {
    const token = raw.toLowerCase();
    if (token.length < 2 || GENERIC_TITLE_TOKENS.has(token)) continue;
    const isTechnical = /\d/.test(raw)
      || (/^[A-Z][A-Z0-9_-]{2,}$/.test(raw) && /[A-Z]/.test(raw))
      || /[a-z][A-Z]/.test(raw)
      || /[-_]/.test(raw);
    const weight = isTechnical ? 2 : 1;
    const prior = byValue.get(token);
    if (!prior || prior.weight < weight) byValue.set(token, { value: token, weight });
  }
  return [...byValue.values()];
}

function morphologicalStem(value: string): string {
  let stem = value;
  for (let i = 0; i < 2; i++) {
    const suffix = ['ingly', 'edly', 'ing', 'ed', 'ers', 'er', 'es', 's', 'e']
      .find((candidate) => stem.endsWith(candidate) && stem.length - candidate.length >= 4);
    if (!suffix) break;
    stem = stem.slice(0, -suffix.length);
  }
  return stem;
}

function tokensMatch(a: string, b: string): boolean {
  if (a === b) return true;
  const aStem = morphologicalStem(a);
  const bStem = morphologicalStem(b);
  if (aStem.length >= 4 && aStem === bStem) return true;
  const shorter = a.length <= b.length ? a : b;
  const longer = a.length > b.length ? a : b;
  return shorter.length >= 5 && longer.includes(shorter);
}

function matchedTitleTokens(title: string, evidence: string): WeightedToken[] {
  const evidenceTokens = semanticTokens(evidence);
  return semanticTokens(title).filter((titleToken) =>
    evidenceTokens.some((evidenceToken) => tokensMatch(titleToken.value, evidenceToken.value)),
  );
}

/**
 * Subject tokens shared by two project titles, using the same tokenizer,
 * stoplist, and stemming rules as routing. Used by the project-relations
 * engine to detect sibling initiatives ("related but distinct") — never for
 * evidence membership decisions.
 */
export function sharedTitleAnchorTokens(titleA: string, titleB: string): string[] {
  return matchedTitleTokens(titleA, titleB).map((token) => token.value);
}

/**
 * How many of the given titles lexically match this token (stemming applied).
 * Rarity signal: a token shared by 2 titles is distinctive; one shared by 10
 * is family vocabulary and must not link every pair in the family.
 */
export function countTitlesMatchingToken(token: string, titles: string[]): number {
  let count = 0;
  for (const title of titles) {
    if (semanticTokens(title).some((candidate) => tokensMatch(token, candidate.value))) count++;
  }
  return count;
}

/**
 * Evaluate whether evidence has a meaningful lexical anchor to a project title.
 * Two ordinary title terms are required, while one distinctive technical or
 * compound identifier can stand alone. Generic titles fail closed.
 */
export function evaluateProjectEvidenceScope(title: string, evidence: string): ProjectScopeEvaluation {
  const titleTokens = semanticTokens(title);
  if (titleTokens.length === 0) {
    return { matches: false, score: 0, matchedTokens: [], hasDistinctiveAnchor: false, hasExactPhraseAnchor: false, reason: 'title has no enforceable subject tokens' };
  }
  if (!evidence.trim()) {
    return { matches: false, score: 0, matchedTokens: [], hasDistinctiveAnchor: false, hasExactPhraseAnchor: false, reason: 'evidence body is empty' };
  }

  const matched = matchedTitleTokens(title, evidence);
  const score = matched.reduce((sum, token) => sum + token.weight, 0);
  const normalizedTitle = normalizePhrase(title);
  const normalizedEvidence = normalizePhrase(evidence);
  // The exact-phrase shortcut needs a multi-word title: a single ordinary
  // word ("Slack", "Inbox") appearing verbatim proves nothing about scope.
  const exactPhrase = normalizedTitle.length >= 5
    && normalizedTitle.includes(' ')
    && normalizedEvidence.includes(normalizedTitle);
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

function titleScopeCoverage(title: string, evidence: string): number {
  const titleTokens = semanticTokens(title);
  const totalWeight = titleTokens.reduce((sum, token) => sum + token.weight, 0);
  if (totalWeight === 0) return 0;
  const matchedWeight = matchedTitleTokens(title, evidence)
    .reduce((sum, token) => sum + token.weight, 0);
  return matchedWeight / totalWeight;
}

/**
 * A strong primary anchor may legitimately include weaker secondary project
 * vocabulary (for example, "MX" and "PV" in a detailed mobile/WiFi update).
 * Only suppress a competing anchor when the target wins on weighted evidence,
 * number of matched subject terms, and proportion of its title covered.
 */
function scopeClearlyDominates(
  targetTitle: string,
  target: ProjectScopeEvaluation,
  candidateTitle: string,
  candidate: ProjectScopeEvaluation,
  evidence: string,
): boolean {
  if (!target.matches || !candidate.matches) return false;
  return target.score >= candidate.score + 2
    && target.matchedTokens.length >= candidate.matchedTokens.length + 1
    && titleScopeCoverage(targetTitle, evidence) >= titleScopeCoverage(candidateTitle, evidence) + 0.25;
}

/** True when two titles describe the same lexical topic family. */
function titlesShareScope(a: string, b: string): boolean {
  const aTokens = semanticTokens(a);
  const bTokens = semanticTokens(b);
  const shared = aTokens.filter((aToken) =>
    bTokens.some((bToken) => tokensMatch(aToken.value, bToken.value)),
  );
  return shared.length >= 2 || shared.some((token) => token.weight >= 2);
}

/**
 * Detect evidence that independently anchors two unrelated existing scopes.
 * This is the deterministic quarantine for recaptured, already-contaminated
 * summaries: mentioning both topics must not make either assignment valid.
 */
export function evidenceAnchorsMultipleIndependentScopes(
  evidence: string,
  projectTitles: string[],
): { mixed: boolean; titles: string[] } {
  const anchored = [...new Set(projectTitles.map((title) => title.trim()).filter(Boolean))]
    .map((title) => ({ title, scope: evaluateProjectEvidenceScope(title, evidence) }))
    .filter(({ scope }) => scope.matches);
  const undominated = anchored.filter((candidate) => !anchored.some((target) =>
    target.title !== candidate.title
    && scopeClearlyDominates(target.title, target.scope, candidate.title, candidate.scope, evidence),
  ));
  for (let i = 0; i < undominated.length; i++) {
    for (let j = i + 1; j < undominated.length; j++) {
      if (!titlesShareScope(undominated[i].title, undominated[j].title)) {
        return { mixed: true, titles: [undominated[i].title, undominated[j].title] };
      }
    }
  }
  return { mixed: false, titles: undominated.map(({ title }) => title) };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function countTokenOccurrences(evidenceLower: string, token: string): number {
  const matches = evidenceLower.match(new RegExp(`(?:^|[^a-z0-9])${escapeRegExp(token)}(?![a-z0-9])`, 'g'));
  return matches?.length ?? 0;
}

/**
 * Brain-pass quarantine check: does evidence already living in `homeTitle`'s
 * project independently anchor a FOREIGN project scope? Deliberately much
 * more conservative than routing-time checks: in a large portfolio every page
 * shares ordinary words with some title, years appear in report-series
 * titles, and footer boilerplate names social platforms. A foreign scope
 * counts only when (a) the exact title phrase appears in the evidence, (b) it
 * clearly dominates the home anchor on weighted evidence, or (c) a genuinely
 * identifying token anchors it: weight-2, non-numeric, rare across the
 * portfolio (at most two titles), matched by exact token equality, and
 * present in the evidence's first line or at least twice overall — so a
 * single boilerplate mention can never trip it. Same-family titles (shared
 * scope vocabulary with home) are never foreign.
 */
export function evidenceAnchorsForeignScope(
  homeTitle: string,
  evidence: string,
  otherProjectTitles: string[],
): { mixed: boolean; titles: string[]; dominantTitles: string[] } {
  const home = evaluateProjectEvidenceScope(homeTitle, evidence);
  const evidenceLower = evidence.toLowerCase();
  const firstLineLower = evidence.split('\n', 1)[0].toLowerCase();

  // Portfolio frequency: a token appearing across 3+ titles is shared
  // vocabulary (years, product names, "reports"), not an identifier.
  const uniqueTitles = [...new Set(
    [homeTitle, ...otherProjectTitles].map((title) => title.trim()).filter(Boolean),
  )];
  const tokenTitleFrequency = new Map<string, number>();
  for (const title of uniqueTitles) {
    for (const token of new Set(semanticTokens(title).map((entry) => entry.value))) {
      tokenTitleFrequency.set(token, (tokenTitleFrequency.get(token) ?? 0) + 1);
    }
  }

  const identifyingForeignAnchor = (title: string): boolean =>
    semanticTokens(title).some((token) => {
      if (token.weight < 2) return false;
      if (/^\d+$/.test(token.value)) return false;
      if ((tokenTitleFrequency.get(token.value) ?? 0) > 2) return false;
      const occurrences = countTokenOccurrences(evidenceLower, token.value);
      if (occurrences === 0) return false;
      return occurrences >= 2 || countTokenOccurrences(firstLineLower, token.value) > 0;
    });

  const foreign = [...new Set(otherProjectTitles.map((title) => title.trim()).filter(Boolean))]
    .filter((title) => normalizePhrase(title) !== normalizePhrase(homeTitle))
    .filter((title) => !titlesShareScope(homeTitle, title))
    .map((title) => ({
      title,
      scope: evaluateProjectEvidenceScope(title, evidence),
    }))
    .filter(({ scope }) => scope.matches)
    .map((entry) => ({
      ...entry,
      dominates: scopeClearlyDominates(entry.title, entry.scope, homeTitle, home, evidence),
    }))
    .filter(({ title, scope, dominates }) =>
      scope.hasExactPhraseAnchor
      || dominates
      || identifyingForeignAnchor(title));
  return {
    mixed: foreign.length > 0,
    titles: foreign.map((entry) => entry.title),
    // A dominant foreign anchor means the evidence is probably misfiled here;
    // a non-dominant one means genuinely related scopes touching. Callers may
    // synthesize the latter but should suppress the former.
    dominantTitles: foreign.filter((entry) => entry.dominates).map((entry) => entry.title),
  };
}

/** Backward-compatible basic title/evidence check. */
export function projectTitleHasEvidenceAnchor(title: string, evidence: string): boolean {
  return evaluateProjectEvidenceScope(title, evidence).matches;
}

/**
 * A routed, substantive document may use its filename as the only durable
 * subject label (for example, ANCHORHEAD.pdf for "Anchorhead Document
 * Analysis"). Accept that narrow case only when removing artifact words leaves
 * exactly one project subject and the filename stem equals it exactly. This
 * does not weaken the normal body-text or routing scope rules.
 */
export function projectTitleHasExactDocumentFilenameAnchor(title: string, filename: string): boolean {
  const subjectTokens = semanticTokens(title)
    .filter((token) => !GENERIC_DOCUMENT_SCOPE_TOKENS.has(token.value));
  if (subjectTokens.length !== 1) return false;

  const basename = filename.trim().split(/[\\/]/).pop() ?? '';
  const stem = basename.replace(/\.[^.]+$/, '');
  return normalizePhrase(stem) === subjectTokens[0].value;
}

/**
 * Require a target title anchor and reject evidence only when an unrelated
 * active project is a clearly stronger lexical fit. Related/overlapping
 * project variants are left for the router to distinguish. In a large
 * portfolio, weak or comparable secondary vocabulary is expected and must not
 * veto the model-selected primary project; strict mixed-scope checks still
 * apply when creating or reconciling projects.
 */
export function projectTitleHasExclusiveEvidenceAnchor(
  title: string,
  evidence: string,
  activeProjectTitles: string[],
): ProjectScopeEvaluation {
  const target = evaluateProjectEvidenceScope(title, evidence);
  if (!target.matches) return target;

  const unrelated = activeProjectTitles
    .map((candidate) => candidate.trim())
    .filter((candidate) => candidate && normalizePhrase(candidate) !== normalizePhrase(title))
    .filter((candidate) => !titlesShareScope(title, candidate))
    .map((candidate) => ({ candidate, scope: evaluateProjectEvidenceScope(candidate, evidence) }))
    .filter(({ scope }) => scope.matches)
    .filter(({ candidate, scope }) => scopeClearlyDominates(candidate, scope, title, target, evidence));
  if (unrelated.length > 0) {
    return {
      ...target,
      matches: false,
      reason: `evidence is more strongly anchored to independent scope: ${unrelated[0].candidate}`,
    };
  }
  return target;
}

/** True when a title names a communication surface/roster, not a work topic. */
export function isSourceContainerProjectTitle(title: string | null | undefined): boolean {
  const value = title?.trim();
  return Boolean(value && SOURCE_CONTAINER_TITLE_PATTERNS.some((pattern) => pattern.test(value)));
}
