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

/**
 * One evidence string's scope vocabulary, built once and reused for every
 * title checked against it. The previous form re-tokenized and re-normalized
 * the whole evidence for every title and compared each title token with every
 * evidence token. A portfolio check (≈150 titles) over a 2.4M-character file
 * blocked the main thread for ~25 s, and 10–17M-character evidence for minutes
 * (owner-live 2026-10-01). Lookups here answer exactly what
 * `evidenceTokens.some(e => tokensMatch(t, e))` answered.
 */
interface EvidenceScopeIndex {
  blank: boolean;
  /** Distinct lowercase evidence tokens, filtered exactly like `semanticTokens`. */
  tokens: Set<string>;
  /** `morphologicalStem` of every token whose stem can match (length >= 4). */
  stems: Set<string>;
  /** Per title-token answers, so each distinct token is resolved once. */
  matches: Map<string, boolean>;
  /** Per normalized-title exact-phrase answers (one evidence scan each). */
  phrases: Map<string, boolean>;
  evidence: string;
  joinedTokens: string | null;
  lower: string | null;
}

const TOKEN_PATTERN = /[A-Za-z0-9][A-Za-z0-9_-]*/g;
// Evidence tokens never contain this character, so a substring hit in the
// joined list always lies inside one token.
const TOKEN_DELIMITER = '\u0001';

function buildEvidenceScopeIndex(evidence: string): EvidenceScopeIndex {
  const tokens = new Set<string>();
  const pattern = new RegExp(TOKEN_PATTERN.source, 'g');
  for (let match = pattern.exec(evidence); match !== null; match = pattern.exec(evidence)) {
    const token = match[0].toLowerCase();
    if (token.length < 2 || GENERIC_TITLE_TOKENS.has(token)) continue;
    tokens.add(token);
  }
  const stems = new Set<string>();
  for (const token of tokens) {
    const stem = morphologicalStem(token);
    if (stem.length >= 4) stems.add(stem);
  }
  return {
    blank: !/\S/.test(evidence),
    tokens,
    stems,
    matches: new Map(),
    phrases: new Map(),
    evidence,
    joinedTokens: null,
    lower: null,
  };
}

// Index reuse is bounded to one synchronous section: the entry is dropped at
// the next microtask checkpoint, so a large evidence string is never retained
// after the routing/brain pass that examined it. Short evidence is cheap to
// index and is never cached.
const INDEX_REUSE_MIN_CHARS = 4_096;
let reusableIndex: { evidence: string; index: EvidenceScopeIndex } | null = null;

function evidenceScopeIndex(evidence: string): EvidenceScopeIndex {
  if (evidence.length < INDEX_REUSE_MIN_CHARS) return buildEvidenceScopeIndex(evidence);
  if (reusableIndex && reusableIndex.evidence === evidence) return reusableIndex.index;
  const entry = { evidence, index: buildEvidenceScopeIndex(evidence) };
  reusableIndex = entry;
  queueMicrotask(() => {
    if (reusableIndex === entry) reusableIndex = null;
  });
  return entry.index;
}

function joinedEvidenceTokens(index: EvidenceScopeIndex): string {
  if (index.joinedTokens === null) {
    index.joinedTokens = `${TOKEN_DELIMITER}${[...index.tokens].join(TOKEN_DELIMITER)}${TOKEN_DELIMITER}`;
  }
  return index.joinedTokens;
}

function lowerEvidence(index: EvidenceScopeIndex): string {
  if (index.lower === null) index.lower = index.evidence.toLowerCase();
  return index.lower;
}

const phrasePatterns = new Map<string, RegExp>();

/**
 * Exactly `normalizePhrase(evidence).includes(normalizedPhrase)`, without
 * materializing the normalized evidence (1.4 s for 24M characters). The
 * normalized form is the `[a-z0-9]+` runs of the lowercased text joined by
 * single spaces, so the phrase occurs there exactly when its first word ends a
 * run, its inner words are whole runs, and its last word starts a run, with
 * only separator characters between them.
 */
function evidenceContainsNormalizedPhrase(index: EvidenceScopeIndex, normalizedPhrase: string): boolean {
  const known = index.phrases.get(normalizedPhrase);
  if (known !== undefined) return known;
  let pattern = phrasePatterns.get(normalizedPhrase);
  if (!pattern) {
    // Words of a normalized phrase are [a-z0-9]+, so they need no escaping.
    pattern = new RegExp(normalizedPhrase.split(' ').join('[^a-z0-9]+'));
    if (phrasePatterns.size >= 2_000) phrasePatterns.clear();
    phrasePatterns.set(normalizedPhrase, pattern);
  }
  const result = pattern.test(lowerEvidence(index));
  index.phrases.set(normalizedPhrase, result);
  return result;
}

/** True when some evidence token `b` satisfies `tokensMatch(titleToken, b)`. */
function evidenceHasMatchingToken(index: EvidenceScopeIndex, titleToken: string): boolean {
  const known = index.matches.get(titleToken);
  if (known !== undefined) return known;
  const result = resolveMatchingToken(index, titleToken);
  index.matches.set(titleToken, result);
  return result;
}

function resolveMatchingToken(index: EvidenceScopeIndex, a: string): boolean {
  // a === b
  if (index.tokens.has(a)) return true;
  // equal stems of length >= 4
  const aStem = morphologicalStem(a);
  if (aStem.length >= 4 && index.stems.has(aStem)) return true;
  // `a` is the shorter (or equal) token and some longer token contains it
  if (a.length >= 5 && joinedEvidenceTokens(index).includes(a)) return true;
  // a strictly shorter evidence token of length >= 5 lies inside `a`
  for (let length = 5; length < a.length; length++) {
    for (let start = 0; start + length <= a.length; start++) {
      if (index.tokens.has(a.slice(start, start + length))) return true;
    }
  }
  return false;
}

function matchedTitleTokensIn(title: string, index: EvidenceScopeIndex): WeightedToken[] {
  return semanticTokens(title).filter((titleToken) => evidenceHasMatchingToken(index, titleToken.value));
}

function matchedTitleTokens(title: string, evidence: string): WeightedToken[] {
  return matchedTitleTokensIn(title, evidenceScopeIndex(evidence));
}

/**
 * The token and phrase definitions the evidence index must agree with. Tests
 * compare indexed evaluation against a brute-force evaluation built from these.
 */
export const projectScopeDefinitionsForTests = Object.freeze({ semanticTokens, tokensMatch, normalizePhrase });

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
  return evaluateProjectEvidenceScopeIn(title, evidenceScopeIndex(evidence));
}

function evaluateProjectEvidenceScopeIn(title: string, index: EvidenceScopeIndex): ProjectScopeEvaluation {
  const titleTokens = semanticTokens(title);
  if (titleTokens.length === 0) {
    return { matches: false, score: 0, matchedTokens: [], hasDistinctiveAnchor: false, hasExactPhraseAnchor: false, reason: 'title has no enforceable subject tokens' };
  }
  if (index.blank) {
    return { matches: false, score: 0, matchedTokens: [], hasDistinctiveAnchor: false, hasExactPhraseAnchor: false, reason: 'evidence body is empty' };
  }

  const matched = titleTokens.filter((titleToken) => evidenceHasMatchingToken(index, titleToken.value));
  const score = matched.reduce((sum, token) => sum + token.weight, 0);
  const normalizedTitle = normalizePhrase(title);
  // The exact-phrase shortcut needs a multi-word title: a single ordinary
  // word ("Slack", "Inbox") appearing verbatim proves nothing about scope.
  const exactPhrase = normalizedTitle.length >= 5
    && normalizedTitle.includes(' ')
    && evidenceContainsNormalizedPhrase(index, normalizedTitle);
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

function titleScopeCoverage(title: string, index: EvidenceScopeIndex): number {
  const titleTokens = semanticTokens(title);
  const totalWeight = titleTokens.reduce((sum, token) => sum + token.weight, 0);
  if (totalWeight === 0) return 0;
  const matchedWeight = matchedTitleTokensIn(title, index)
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
  index: EvidenceScopeIndex,
): boolean {
  if (!target.matches || !candidate.matches) return false;
  return target.score >= candidate.score + 2
    && target.matchedTokens.length >= candidate.matchedTokens.length + 1
    && titleScopeCoverage(targetTitle, index) >= titleScopeCoverage(candidateTitle, index) + 0.25;
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
  const index = evidenceScopeIndex(evidence);
  const anchored = [...new Set(projectTitles.map((title) => title.trim()).filter(Boolean))]
    .map((title) => ({ title, scope: evaluateProjectEvidenceScopeIn(title, index) }))
    .filter(({ scope }) => scope.matches);
  const undominated = anchored.filter((candidate) => !anchored.some((target) =>
    target.title !== candidate.title
    && scopeClearlyDominates(target.title, target.scope, candidate.title, candidate.scope, index),
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
  const index = evidenceScopeIndex(evidence);
  const home = evaluateProjectEvidenceScopeIn(homeTitle, index);
  const evidenceLower = lowerEvidence(index);
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
      scope: evaluateProjectEvidenceScopeIn(title, index),
    }))
    .filter(({ scope }) => scope.matches)
    .map((entry) => ({
      ...entry,
      dominates: scopeClearlyDominates(entry.title, entry.scope, homeTitle, home, index),
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
  const index = evidenceScopeIndex(evidence);
  const target = evaluateProjectEvidenceScopeIn(title, index);
  if (!target.matches) return target;

  const unrelated = activeProjectTitles
    .map((candidate) => candidate.trim())
    .filter((candidate) => candidate && normalizePhrase(candidate) !== normalizePhrase(title))
    .filter((candidate) => !titlesShareScope(title, candidate))
    .map((candidate) => ({ candidate, scope: evaluateProjectEvidenceScopeIn(candidate, index) }))
    .filter(({ scope }) => scope.matches)
    .filter(({ candidate, scope }) => scopeClearlyDominates(candidate, scope, title, target, index));
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
