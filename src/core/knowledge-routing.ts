/**
 * Routing: which set, if any, a message or job is about, and the small prompt block built from the answer
 * (knowledge-library.md K7). Pure and deterministic: no model call, no disk, no clock.
 *
 * Practical agent framework, Retrieved Knowledge: ONE matching set per task. The winner is fenced with its file table
 * (names and one-line purposes only, a few hundred tokens); a second set the message also names gets one `also named`
 * line, an unclear case one `may match` line. Files enter the prompt only through an explicit `knowledge_load`. The
 * thresholds are the ones the R6.2a analytics-import selector uses (floor 30, margin 10), so the two selectors agree.
 *
 * Scoring (additive, each part capped): the set's name, or a keyword written in its guide header, found as a phrase in
 * the message 100; each derived keyword (folder words, file stems, title words, manifest tags) found as a phrase 20,
 * up to 60; each two-word run of the description found verbatim 20, up to 40; each distinct shared word 1, up to 10;
 * analytics mode (or a job about SQL, ETL or datasets) adds 30 to analytics sets.
 */
import {
  PREVIEW_BLOCK_MAX_TOKENS,
  buildPreviewBlock,
  buildStandingLine,
  estimateTokens,
  sanitizeSetName,
  type PreviewFile,
  type SetKind,
} from './knowledge-guide.js';

export interface RoutingSet {
  /** Root-relative path, for example `shop-data` or `analytics/forecasting`. */
  id: string;
  /** The display name: the guide's `name`, else the folder name. */
  name: string;
  kind: SetKind;
  description: string;
  /** Keywords the owner wrote in the guide header (front matter): a phrase hit is worth 100. */
  headerKeywords: string[];
  /** Derived keywords: folder words, file stems, title words, manifest tags. A phrase hit is worth 20. */
  keywords: string[];
  files: PreviewFile[];
}

export const MATCH_FLOOR = 30;
export const MATCH_MARGIN = 10;
export const WEAK_FLOOR = 20;
export const STRONG_HIT = 100;
export const ANALYTICS_BOOST = 30;

const STOP_WORDS = new Set((
  'the and for are but not you all any can had her was one our out has have how its let may new now old see two way who '
  + 'did get him his she too use with that this from they what when where which will your about after again been being '
  + 'both could does doing done each few into just more most much only other over same some such than then them these '
  + 'those through under until very were would also here there their should shall must need needs want make made '
  + 'data analysis analytics schema table tables query queries guide reference notes note file files doc docs '
  + 'documentation steering context readme set sets library knowledge botboy use using used please show give tell '
  + 'help work working task tasks'
).split(/\s+/));

const normalize = (value: string): string => String(value ?? '')
  .normalize('NFKC')
  .toLowerCase()
  .replace(/[_\-./\\]+/g, ' ')
  .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
  .replace(/\s+/g, ' ')
  .trim();

const wordsOf = (value: string): string[] => (normalize(value).match(/[\p{L}\p{N}]+/gu) ?? []).filter((word) => word.length >= 3 && !STOP_WORDS.has(word));

/** Distinct keywords for a set from its names, so a set without a header still matches what it is about. */
export function deriveKeywords(input: { id: string; title?: string; fileNames: readonly string[]; extra?: readonly string[] }): string[] {
  const out = new Set<string>();
  const add = (phrase: string) => {
    const clean = normalize(phrase);
    if (clean.length >= 3 && !STOP_WORDS.has(clean)) out.add(clean);
  };
  for (const part of input.id.split('/')) {
    add(part);
    wordsOf(part).forEach(add);
  }
  for (const name of input.fileNames) {
    const stem = name.replace(/^.*\//, '').replace(/\.[^.]+$/, '');
    add(stem);
    wordsOf(stem).forEach(add);
  }
  if (input.title) wordsOf(input.title).forEach(add);
  for (const extra of input.extra ?? []) add(extra);
  return [...out].slice(0, 40);
}

export interface MatchInput {
  message: string;
  /** The active job's goal (a continuation's signal is its goal). */
  jobGoal?: string;
  /** The turn is in analytics mode, or the job's goal names SQL, ETL or dataset work. */
  analyticsMode?: boolean;
  sets: readonly RoutingSet[];
}

export interface MatchResult {
  winner: RoutingSet | null;
  /** Other sets the message also names outright (score 100 or more); at most two. */
  alsoNamed: RoutingSet[];
  /** An unclear case: at most two sets that might be meant. */
  maybe: RoutingSet[];
  scores: Array<{ id: string; score: number }>;
}

function phraseHit(padded: string, phrase: string): boolean {
  const clean = normalize(phrase);
  return clean.length >= 3 && padded.includes(` ${clean} `);
}

export function scoreSet(set: RoutingSet, padded: string, messageWords: ReadonlySet<string>, analyticsMode: boolean): number {
  let score = 0;
  const base = set.id.split('/').pop() ?? set.id;
  const strong = phraseHit(padded, set.name) || phraseHit(padded, base) || set.headerKeywords.some((keyword) => phraseHit(padded, keyword));
  if (strong) score += STRONG_HIT;
  let keywordScore = 0;
  for (const keyword of set.keywords) {
    if (phraseHit(padded, keyword)) keywordScore += WEAK_FLOOR;
    if (keywordScore >= 60) break;
  }
  score += Math.min(keywordScore, 60);
  const descriptionWords = wordsOf(set.description);
  let phraseScore = 0;
  for (let index = 0; index + 1 < descriptionWords.length && phraseScore < 40; index += 1) {
    if (padded.includes(` ${descriptionWords[index]} ${descriptionWords[index + 1]} `)) phraseScore += WEAK_FLOOR;
  }
  score += Math.min(phraseScore, 40);
  const vocabulary = new Set([...descriptionWords, ...wordsOf(set.name), ...set.headerKeywords.flatMap(wordsOf)]);
  let shared = 0;
  for (const word of messageWords) {
    if (vocabulary.has(word)) shared += 1;
    if (shared >= 10) break;
  }
  score += shared;
  if (analyticsMode && set.kind === 'analytics') score += ANALYTICS_BOOST;
  return score;
}

/** Which set a message or job is about. Deterministic: the same input always gives the same answer. */
export function matchSets(input: MatchInput): MatchResult {
  const signal = `${input.message ?? ''} ${input.jobGoal ?? ''}`;
  const padded = ` ${normalize(signal)} `;
  const messageWords = new Set(wordsOf(signal));
  const scored = input.sets
    .map((set) => ({ set, score: scoreSet(set, padded, messageWords, Boolean(input.analyticsMode)) }))
    .sort((left, right) => right.score - left.score || left.set.id.localeCompare(right.set.id));
  const scores = scored.map((entry) => ({ id: entry.set.id, score: entry.score }));
  const top = scored[0];
  const second = scored[1];
  if (!top || top.score < WEAK_FLOOR) return { winner: null, alsoNamed: [], maybe: [], scores };
  const margin = top.score - (second?.score ?? 0);
  if (top.score >= MATCH_FLOOR && margin >= MATCH_MARGIN) {
    const alsoNamed = scored.slice(1).filter((entry) => entry.score >= STRONG_HIT).slice(0, 2).map((entry) => entry.set);
    return { winner: top.set, alsoNamed, maybe: [], scores };
  }
  const maybe = scored.filter((entry) => entry.score >= WEAK_FLOOR).slice(0, 2).map((entry) => entry.set);
  return { winner: null, alsoNamed: [], maybe, scores };
}

export interface KnowledgeBlockInput {
  /** Every set (the standing line names them). */
  sets: readonly RoutingSet[];
  match: MatchResult;
  /** The sandbox deny reports the library root, so the line may say commands cannot change it. */
  protectedByDeny: boolean;
  /** Sets whose files the turn already holds (the analytics briefing loaded them): no block for these. */
  excludeSetIds?: ReadonlySet<string>;
}

export interface KnowledgeBlock {
  /** '' when there are no sets. */
  text: string;
  estimatedTokens: number;
  /** The set whose guide preview is in the block, if any. */
  matchedSetId: string | null;
}

const nameList = (sets: readonly RoutingSet[]) => sets.map((set) => sanitizeSetName(set.name)).filter(Boolean).join(', ');

/**
 * The block the chat prompt carries: the standing line always (when sets exist), plus on a match the winner's fenced file
 * table and the load rule, plus an `also named` or `may match` line. Capped at 700 estimated tokens as a whole.
 */
export function buildKnowledgeBlock(input: KnowledgeBlockInput): KnowledgeBlock {
  const line = buildStandingLine(input.sets.map((set) => set.name), { protectedByDeny: input.protectedByDeny });
  if (!line) return { text: '', estimatedTokens: 0, matchedSetId: null };
  const parts = [line];
  let matchedSetId: string | null = null;
  const winner = input.match.winner;
  if (winner && !input.excludeSetIds?.has(winner.id)) {
    let files = [...winner.files];
    let preview = buildPreviewBlock({ setId: winner.id, kind: winner.kind, description: winner.description, files });
    // The fence is capped by construction; this loop is the second wall on the whole block.
    while (estimateTokens([...parts, preview.text].join('\n')) > PREVIEW_BLOCK_MAX_TOKENS && files.length > 0) {
      files = files.slice(0, Math.max(0, files.length - 4));
      preview = buildPreviewBlock({ setId: winner.id, kind: winner.kind, description: winner.description, files });
    }
    parts.push(preview.text);
    matchedSetId = winner.id;
    const others = input.match.alsoNamed.filter((set) => set.id !== winner.id);
    if (others.length > 0) parts.push(`also named: ${nameList(others)}. knowledge_list shows its files.`);
  } else if (!winner && input.match.maybe.length > 0) {
    parts.push(`may match: ${nameList(input.match.maybe)}. knowledge_list shows their files.`);
  }
  // The fence text was protected where it was built; the names are cut to a safe alphabet. Nothing else is untrusted here.
  const text = parts.join('\n');
  return { text, estimatedTokens: estimateTokens(text), matchedSetId };
}
