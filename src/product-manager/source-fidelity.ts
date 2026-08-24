import crypto from 'crypto';
import path from 'path';
import type {
  ContextResolution,
  DocumentProfile,
  GenerateDocumentRequest,
  GeneratedClaim,
  OmittedSourceUnit,
  SourceCoverageSummary,
  SourceEvidenceIndex,
  SourceEvidencePriority,
  SourceEvidenceType,
  SourceEvidenceUnit,
} from './types.js';

const MAX_SOURCE_UNITS = 400;
const MATERIAL_SIGNAL = /(?:-?\$\s?-?\d|\b-?\d[\d,.]*(?:%|\b)|\b(?:actual|forecast|assumption|proposed|approved|commitment|mission|vision|decision|recommendation|target|goal|owner|owned by|timing|dependency|prerequisite|gate|risk|mitigation|caveat|source|budget|expense|headcount|full[- ]time equivalent|must|required|requirement|shall|should|need(?:s|ed)?)\b)/i;
const REQUIRED_CONTEXT_SIGNAL = /\b(?:decision requested|recommendation|mission|vision|actual|forecast|proposed target|approved target|commitment|highlight|lowlight|learning|owner|owned by|proposed timing|scenario|operating expense|budget|full[- ]time equivalent|decision gate|dependency|prerequisite|requires?|must|target|risk|mitigation|caveat)\b/i;
const ADMINISTRATIVE_SIGNAL = /\b(?:retrieved|sha-?256|fingerprint|test-data handling|evaluation fixture|synthetic test)\b/i;
const META_PROMPT_SIGNAL = /\b(?:create|draft|write|rewrite|revise|rethink|prepare|produce|author|compose|format|return|mention|explain|summarize|imitate|invent(?:ing|ed)?|use only|do not claim|do not add|do not perform)\b/i;
const FACTUAL_PROMPT_SIGNAL = /(?:-?\$\s?-?\d|\b-?\d[\d,.]*(?:%|\b)|\b(?:actual|forecast|approved|proposed target|commitment|currently|existing|legacy|cannot|can't|does not|doesn't|is not|are not|supports?|depends on|blocked by|owned by|owner\s*:|deadline\s*:|target\s*:|risk\s*:|decision\s*:)\b)/i;
const EXPLICIT_OBLIGATION_SIGNAL = /\b(?:must|shall|required|requirement|need(?:s|ed)?\s+to|cannot|may\s+not)\b/i;
const LABEL_BOUNDARY = /\s+(?=(?:Type|Customer problem|Constraint|Intended outcome|Mechanism|Connected goals?|Connected initiative|Assumption|Evidence|Test|Decision gate|Protection|Owner|Proposed timing|Problem|Measures|Dependencies|Principal risk|Mitigation|Source|Caveat):)/g;

function normalizeDashes(value: string): string {
  return value.replace(/[‐‑‒–—―−]/g, '-');
}

export function normalizeEvidenceText(value: string): string {
  return normalizeDashes(value)
    .normalize('NFKC')
    .toLocaleLowerCase('en-US')
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanMarkdown(value: string): string {
  // Strip markdown decoration without corrupting identifiers: `*` and
  // backticks are always decoration, but underscores are only emphasis when
  // they wrap a token (_word_). Intra-word underscores are load-bearing in
  // snake_case identifiers such as af_first_streamed and must survive so
  // claims and drafts can preserve the exact identifier.
  return value
    .replace(/^\s*[-*+]\s+/, '')
    .replace(/[*`]/g, '')
    .replace(/(^|[\s(])_{1,2}([^_\s](?:[^_]*[^_\s])?)_{1,2}(?=[\s).,;:!?]|$)/g, '$1$2')
    .replace(/\s+/g, ' ')
    .trim();
}

const READER_OUTCOME_VERB_PATTERN = '(?:understand|decid(?:e|es|ed|ing)?|approv(?:e|es|ed|ing|al)?|reject(?:s|ed|ing|ion)?|accept(?:s|ed|ing|ance)?|align(?:s|ed|ing|ment)?|review(?:s|ed|ing)?|inspect(?:s|ed|ing|ion)?|verif(?:y|ies|ied|ying|ication)|confirm(?:s|ed|ing|ation)?|execut(?:e|es|ed|ing|ion)|distribut(?:e|es|ed|ing|ion)|act(?:s|ed|ing)?|respond(?:s|ed|ing)?|choos(?:e|es|ing)|learn(?:s|ed|ing)?|evaluat(?:e|es|ed|ing|ion)|compar(?:e|es|ed|ing|ison)|adopt(?:s|ed|ing|ion)?|support(?:s|ed|ing)?|provid(?:e|es|ed|ing)|giv(?:e|es|ing)|recommend(?:s|ed|ing|ation)?|plan(?:s|ned|ning)?|prepar(?:e|es|ed|ing)|use(?:s|d|ing)?)';
const READER_GROUP_TERM_PATTERN = '(?:team|leaders?|executives?|stakeholders?|customers?|partners?|reviewers?|owners?|readers?|users?|council|committee|group|department|board|management|people)';
const RELATION_STOP_WORDS = new Set([
  'a', 'an', 'and', 'as', 'at', 'be', 'by', 'can', 'document', 'draft', 'for', 'from',
  'in', 'is', 'it', 'of', 'on', 'or', 'reader', 'readers', 'should', 'that', 'the', 'this',
  'to', 'will', 'with', 'would',
]);

function relationMatchAffirmative(value: string, start: number, fullMatch: string): boolean {
  const before = value.slice(Math.max(0, start - 240), start);
  const clauseStart = Math.max(before.lastIndexOf('.'), before.lastIndexOf('!'), before.lastIndexOf('?'), before.lastIndexOf(';'), before.lastIndexOf('\n'));
  const clausePrefix = before.slice(clauseStart + 1);
  const contrastScopes = clausePrefix.split(/\b(?:but|however|instead|rather)\b/i);
  const governingPrefix = (contrastScopes[contrastScopes.length - 1] ?? clausePrefix)
    .replace(/\bnot\s+(?:only|just|merely)\b/gi, '');
  if (/\b(?:do|does|did|is|are|was|were|will|would|should|must|can|could|may|might)\s+(?:absolutely\s+|currently\s+|yet\s+)?not\b[^.!?;]{0,120}$/i.test(governingPrefix)) return false;
  if (/\b(?:never|cannot|can't|won't|wouldn't|shouldn't|mustn't|couldn't|without)\b[^.!?;]{0,120}$/i.test(governingPrefix)) return false;
  if (/\bnot\b[^.!?;]{0,60}$/i.test(governingPrefix)) return false;
  const completeRelation = `${governingPrefix} ${fullMatch}`.replace(/\s+/g, ' ');
  if (/\b(?:everyone|anyone|all|any|people|readers?|audience|recipients?)\b[^.!?;]{0,80}\b(?:but|save|except(?:\s+for)?|excluding|other\s+than)\b/i.test(completeRelation)) return false;
  if (/\b(?:decline|declined|refuse|refused|avoid|avoided|oppose|opposed)\b[^.!?;]{0,100}\bto\b/i.test(completeRelation)) return false;
  if (/\b(?:mistake|wrong|inappropriate|undesirable|unwanted|unnecessary)\b[^.!?;]{0,100}\bto\b/i.test(completeRelation)) return false;
  return isAffirmativeRelationAssertion(fullMatch);
}

function relationCaptures(value: string, patterns: RegExp[]): string[] {
  const captures: string[] = [];
  for (const pattern of patterns) {
    for (const match of value.matchAll(pattern)) {
      if (!relationMatchAffirmative(value, match.index ?? 0, match[0])) continue;
      const capture = cleanMarkdown(match[1] ?? '')
        .replace(/^(?:a|an|the)\s+/i, '')
        .replace(/[,:;.!?]+$/g, '')
        .trim();
      if (capture.length >= 2 && capture.length <= 240) captures.push(capture);
    }
  }
  return [...new Map(captures.map((capture) => [normalizeEvidenceText(capture), capture])).values()];
}

function isAffirmativeRelationAssertion(value: string): boolean {
  const normalized = normalizeEvidenceText(value);
  if (!normalized) return false;
  if (/^(?:no|not|never|neither|nor|without|excluding|except(?:\s+for)?|other\s+than|anything\s+but)\b/i.test(normalized)) return false;
  if (/\b(?:do|does|did|is|are|was|were|will|would|should|must|can|could|may|might|need(?:s|ed)?\s+to)\s+(?:absolutely\s+|currently\s+|yet\s+)?not\b/i.test(normalized)) return false;
  if (/\b(?:cannot|can't|isn't|aren't|wasn't|weren't|won't|wouldn't|shouldn't|mustn't|couldn't)\b/i.test(normalized)) return false;
  return true;
}

function isAffirmativeAudienceAssertion(value: string): boolean {
  return isAffirmativeRelationAssertion(value)
    && !/\b(?:not|never|without|excluding|except(?:\s+for)?|other\s+than|anything\s+but)\b/i.test(normalizeEvidenceText(value));
}

/**
 * Extract only text that the owner or draft puts in a positive reader/audience
 * role. A negative relation is a prohibition or clarification signal, never
 * affirmative publication authority.
 */
export function extractAudienceAssertions(value: string): string[] {
  const outcome = READER_OUTCOME_VERB_PATTERN;
  const group = READER_GROUP_TERM_PATTERN;
  const assertions = relationCaptures(value, [
    /\b(?:audience|readers?|recipients?)\s*(?:is|are|:|=)\s*([^.!?;\n]{2,160})/giu,
    new RegExp(`\\b(?:share|sharing|send|sending|present|presenting|circulate|circulating)\\s+(?:this\\s+(?:document|draft|brief)\\s+|it\\s+)?(?:with|to)\\s+(?:the\\s+)?([^.!?;\\n]{2,120}?)(?=\\s+to\\s+${outcome}\\b|\\s+so\\s+that\\b|[,.;!?\\n]|$)`, 'giu'),
    new RegExp(`\\bfor\\s+(?:the\\s+)?([^.!?;\\n]{2,120}?)(?=\\s+to\\s+${outcome}\\b)`, 'giu'),
    new RegExp(`\\bfor\\s+(?:the\\s+)?([^.!?;,\\n]{1,100}\\b${group})\\s*(?=[,.!?;\\n]|$)`, 'giu'),
    new RegExp(`\\b(?:the\\s+)?([^.!?;,\\n]{1,100}\\b${group})\\s+(?=(?:can|will|must|should|needs?\\s+to)\\s+${outcome}\\b)`, 'giu'),
  ]);
  const publicationControlOnly = /^(?:final|publication|publishable|approval|execution|review|sharing|distribution|document|draft|brief)(?:[- ](?:ready|review|approval|publication|execution))*$/i;
  return assertions.filter((assertion) => isAffirmativeAudienceAssertion(assertion)
    && !publicationControlOnly.test(assertion));
}

/** Extract only an explicit, affirmative reader action or outcome assertion. */
export function extractReaderOutcomeAssertions(value: string): string[] {
  const outcome = READER_OUTCOME_VERB_PATTERN;
  return relationCaptures(value, [
    new RegExp(`\\b(?:purpose|reader outcome|intended outcome|desired outcome|requested decision|decision requested)\\s*(?:is|are|:|=)\\s*([^.!?;\\n]{3,240})`, 'giu'),
    new RegExp(`\\bto\\s+(${outcome}\\b[^.!?;\\n]{0,220})`, 'giu'),
    new RegExp(`\\bso\\s+that\\s+(?:the\\s+)?(?:audience|readers?|recipients?|they)\\s+(?:can|will|must|should)\\s+(${outcome}\\b[^.!?;\\n]{0,220})`, 'giu'),
    new RegExp(`\\b(?:readers?|audience|recipients?|${READER_GROUP_TERM_PATTERN})\\s+(?:should|must|can|will|needs?\\s+to)\\s+(${outcome}\\b[^.!?;\\n]{0,220})`, 'giu'),
  ]).filter((assertion) => isAffirmativeRelationAssertion(assertion)
    && new RegExp(`\\b${outcome}\\b`, 'iu').test(assertion));
}

function relationTokens(value: string): string[] {
  return normalizeEvidenceText(value)
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 3 && !RELATION_STOP_WORDS.has(token));
}

function relatedRelationToken(left: string, right: string): boolean {
  if (left === right) return true;
  return left.length >= 5 && right.length >= 5 && left.slice(0, 5) === right.slice(0, 5);
}

/** Match a plan/draft relation only against text already scoped to the same role. */
export function relationValueGrounded(value: string, assertions: string[]): boolean {
  const normalizedValue = normalizeEvidenceText(value);
  const valueTokens = relationTokens(value);
  if (valueTokens.length === 0) return false;
  return assertions.some((assertion) => {
    const normalizedAssertion = normalizeEvidenceText(assertion);
    if (normalizedAssertion.includes(normalizedValue) || normalizedValue.includes(normalizedAssertion)) return true;
    const assertionTokens = relationTokens(assertion);
    const matched = valueTokens.filter((token) => assertionTokens.some((candidate) => relatedRelationToken(token, candidate))).length;
    return valueTokens.length <= 2 ? matched === valueTokens.length : matched >= 2 && matched / valueTokens.length >= 0.5;
  });
}

function isTableSeparator(value: string): boolean {
  const cells = value.split('|').map((cell) => cell.trim()).filter(Boolean);
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function looksLikeTableHeader(value: string): boolean {
  if (!value.includes('|')) return false;
  const cells = value.split('|').map((cell) => cleanMarkdown(cell)).filter(Boolean);
  if (cells.length < 2) return false;
  const richValueCount = cells.filter((cell) => /(?:\$|\d[.,]\d|\d%|\bQ[1-4]\b)/i.test(cell)).length;
  return richValueCount === 0 && cells.every((cell) => cell.length <= 100);
}

function splitLine(value: string): string[] {
  const labelled = value.replace(LABEL_BOUNDARY, '\n');
  return labelled
    .split(/\n|(?<=[.!?])\s+(?=[A-Z0-9`])/)
    .map(cleanMarkdown)
    .filter((entry) => entry.length >= 3);
}

function sourceChunks(content: string): Array<{ section?: string; text: string }> {
  const chunks: Array<{ section?: string; text: string }> = [];
  let section: string | undefined;
  let tableHeader: string | undefined;
  for (const rawLine of content.split(/\r?\n/)) {
    if (/^\s*\[Owner message \d+\]\s*$/i.test(rawLine)) {
      tableHeader = undefined;
      continue;
    }
    const heading = rawLine.match(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/);
    if (heading) {
      section = cleanMarkdown(heading[1]);
      tableHeader = undefined;
      chunks.push({ section, text: section });
      continue;
    }
    const trimmed = rawLine.trim();
    if (!trimmed) {
      tableHeader = undefined;
      continue;
    }
    if (isTableSeparator(trimmed)) continue;
    // A Markdown table has one header row. Once it is captured, every
    // subsequent pipe row is evidence—even when all cells are digit-free
    // identifiers such as event names, scope labels, or yes/no values.
    if (!tableHeader && looksLikeTableHeader(trimmed)) {
      tableHeader = trimmed.split('|').map(cleanMarkdown).filter(Boolean).join(' | ');
      continue;
    }
    let lineText: string;
    if (trimmed.includes('|')) {
      const row = trimmed.split('|').map(cleanMarkdown).filter(Boolean).join(' | ');
      lineText = tableHeader ? `${tableHeader} || ${row}` : row;
    } else {
      tableHeader = undefined;
      lineText = trimmed;
    }
    for (const text of splitLine(lineText)) chunks.push({ ...(section ? { section } : {}), text });
  }
  return chunks;
}

function splitMixedAuthoringClause(text: string): Array<{ text: string; directiveOnly: boolean }> {
  const match = text.match(/^\s*((?:please\s+)?(?:create|draft|write|rewrite|revise|rethink|prepare|produce|author|compose|format|return|summarize)\b[\s\S]{0,220}?\b(?:product[ -]document|business[ -]document|document|draft|one[ -]pager|brief|proposal|explainer|launch[ -]note|memo|plan|roadmap|vision|prd|workbook|email)\b)([\s\S]*)$/i);
  const rawRemainder = match?.[2]?.trim() ?? '';
  if (!match || rawRemainder.length < 2) return [{ text, directiveOnly: false }];

  // Split at the requested artifact, not at an allowlist of factual
  // connectors. This keeps facts after “with”, semicolons, participial “for”
  // phrases, and future owner phrasing as evidence-bearing propositions.
  const remainder = rawRemainder.replace(/^[,;:—-]+\s*/, '').trim();
  if (remainder.length < 2) return [{ text, directiveOnly: false }];
  const presentationOnly = /^(?:(?:in|as|using|with)\s+)?(?:(?:plain\s+)?markdown|plain\s+text|html|email|table|bullets?|headings?|sections?|outline|concise|brief|detailed|formal|informal|narrative|memo\s+format|one[ -]pager|\d+\s*(?:words?|pages?))(?:\s+(?:format|style|tone|structure|length|only))?[.!]?$/i.test(remainder);
  return [
    { text: match[1].trim(), directiveOnly: true },
    { text: remainder, directiveOnly: presentationOnly || isPureAuthoringDirective(remainder) },
  ];
}

function isPureAuthoringDirective(text: string): boolean {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return false;
  const standaloneArtifactRequest = /^(?:please\s+)?(?:create|draft|write|rewrite|revise|rethink|prepare|produce|author|compose|format|return|summarize)\s+(?:me\s+)?(?:a|an|the)?\s*(?:(?:short|brief|detailed|concise|working|exploratory|alignment|final)\s+)*(?:product[ -]document|business[ -]document|document|draft|output|response|one[ -]pager|brief|proposal|explainer|launch[ -]note)(?:\s+for\s+(?:sharing\s+with\s+)?(?:the\s+)?[A-Za-z][A-Za-z0-9 &/'-]{0,100})?[.!]?$/i;
  const presentationInstruction = /^(?:please\s+)?(?:use|format|structure|organize|keep|limit|return|write)\b[\s\S]{0,180}\b(?:format|structure|sections?|headings?|style|tone|length|words?|pages?|markdown|table|bullets?|concise|brief|detailed)\b[.!]?$/i;
  const conversationalAuthorization = /^(?:yes(?:[, ]+please)?|go ahead|proceed|do it|generate it|create it|draft it)[.!]?$/i;
  const profileOrFormatChoice = /^(?:(?:use|choose|select)\s+(?:the\s+)?)?(?:decision memo|operating plan|op1|op2|roadmap|vision|prd|product requirements document|feature workshop|experiment(?: plan| specification)?|user stor(?:y|ies) workbook|email|one[ -]pager|brief)(?:\s+(?:profile|style|format|option|version))?[.!]?$/i;
  if (presentationInstruction.test(normalized)
    || conversationalAuthorization.test(normalized)
    || profileOrFormatChoice.test(normalized)) return true;
  if (/\b(?:about|on|regarding|concerning|describing|explaining|covering|focused\s+on|because|since|given that|customers?|users?|currently|existing|cannot|can't|does not|doesn't|is not|are not|supports?|depends on|blocked by|owned by)\b/i.test(normalized)
    || extractReaderOutcomeAssertions(normalized).length > 0) {
    return false;
  }
  const documentDirective = /\b(?:document|draft|output|response|one[ -]pager|brief)\b[\s\S]{0,80}\b(?:must|should|need(?:s|ed)?\s+to|will|include|use|format|structure|length|style)\b/i.test(normalized);
  return standaloneArtifactRequest.test(normalized)
    || ((META_PROMPT_SIGNAL.test(normalized) || documentDirective) && !FACTUAL_PROMPT_SIGNAL.test(normalized)
      && !/[,:;]\s*[A-Za-z][^,:;]{2,}\b(?:is|are|will|must|cannot|because)\b/i.test(normalized));
}

function uniqueMatches(value: string, pattern: RegExp): string[] {
  const matches = value.match(pattern) ?? [];
  return [...new Map(matches.map((match) => [normalizeEvidenceText(match), match.trim()])).values()];
}

export function extractMaterialAnchors(value: string): string[] {
  const comparable = normalizeDashes(value);
  const anchors = [
    ...uniqueMatches(comparable, /\bQ[1-4](?:\s*-\s*Q[1-4])?\s+\d{4}\b/gi),
    ...uniqueMatches(comparable, /(?:-?\$\s?-?\d[\d,]*(?:\.\d+)?(?:\s*(?:thousand|million|billion|[KMB]))?)/gi),
    ...uniqueMatches(comparable, /\b-?\d[\d,]*(?:\.\d+)?\s*%/g),
    ...uniqueMatches(comparable, /\b\d{4}\s*-\s*\d{2,4}\b/g),
    ...uniqueMatches(comparable, /\b-?\d[\d,]*(?:\.\d+)?\s*(?:minutes?|days?|weeks?|months?|years?|full[- ]time equivalents?|FTEs?|percentage points?|regions?|dispatchers?|work orders?|launches?|engineers?)\b/gi),
    ...uniqueMatches(comparable, /\b-?\d[\d,]*(?:\.\d+)?\b/g),
  ];
  const owner = comparable.match(/\b(?:Owner\s*:|owned by)\s*([^\n.;,]+)/i)?.[1]?.trim();
  if (owner) anchors.push(owner);
  const qualifiers = [
    'not an approved commitment',
    'not a commitment',
    'not approved',
    'is approved',
    'pending approval',
    'proposed target',
    'approved target',
    'decision gate',
    'remain open',
    'remains open',
    'at least',
    'below',
    'above',
    'additional',
    'forecast',
    'assumption',
    'actual',
    'proposed',
    'requires',
    'must not',
    'must',
    'will not',
    'will',
    'committed',
  ];
  const normalized = normalizeEvidenceText(comparable);
  for (const qualifier of qualifiers) {
    if (normalized.includes(qualifier)) anchors.push(qualifier);
  }
  return [...new Map(anchors
    .map((anchor) => anchor.trim())
    .filter(Boolean)
    .map((anchor) => [normalizeEvidenceText(anchor), anchor])).values()];
}

function contextPriority(
  profile: DocumentProfile,
  role: string,
  text: string,
): SourceEvidencePriority {
  const exhaustiveProfile = profile.family === 'operating_plan' || profile.family === 'business_document';
  if (exhaustiveProfile && role === 'overview' && REQUIRED_CONTEXT_SIGNAL.test(text) && !ADMINISTRATIVE_SIGNAL.test(text)) {
    return 'required';
  }
  return 'review';
}

function safeKey(value: string): string {
  const key = value.toLocaleUpperCase('en-US').replace(/[^A-Z0-9]+/g, '-').replace(/^-|-$/g, '');
  return (key || 'VALUE').slice(0, 40);
}

function stableUnitId(prefix: string, ...identity: string[]): string {
  const digest = crypto.createHash('sha256')
    .update(identity.map(normalizeEvidenceText).join('\0'))
    .digest('hex')
    .slice(0, 16)
    .toLocaleUpperCase('en-US');
  return `${prefix}-${digest}`;
}

function inputValues(inputs: Record<string, unknown>): Array<{ key: string; text: string }> {
  const values: Array<{ key: string; text: string }> = [];
  for (const [key, raw] of Object.entries(inputs).sort(([a], [b]) => a.localeCompare(b))) {
    const entries = Array.isArray(raw) ? raw : [raw];
    for (const entry of entries) {
      if (entry === undefined || entry === null || typeof entry === 'boolean') continue;
      const rendered = typeof entry === 'string' ? entry : JSON.stringify(entry);
      if (!rendered || rendered.length > 5_000) continue;
      values.push({ key, text: `${key.replaceAll('_', ' ')}: ${rendered}` });
    }
  }
  return values;
}

function addCandidate(
  candidates: Array<SourceEvidenceUnit & { sequence: number }>,
  seenIds: Set<string>,
  candidate: SourceEvidenceUnit,
  sequence: number,
): void {
  if (seenIds.has(candidate.unitId)) return;
  seenIds.add(candidate.unitId);
  candidates.push({ ...candidate, sequence });
}

export function buildSourceEvidenceIndex(
  context: ContextResolution,
  request: Pick<GenerateDocumentRequest, 'prompt' | 'inputs' | 'email' | 'discoveredEvidence' | 'parentVersion'>,
  profile: DocumentProfile,
): SourceEvidenceIndex {
  const candidates: Array<SourceEvidenceUnit & { sequence: number }> = [];
  const seenIds = new Set<string>();
  let sequence = 0;

  for (const document of context.documents) {
    if (document.role === 'glossary') continue;
    const seenText = new Set<string>();
    for (const chunk of sourceChunks(document.content)) {
      if (!MATERIAL_SIGNAL.test(chunk.text)) continue;
      const normalized = normalizeEvidenceText(`${chunk.section ?? ''}\0${chunk.text}`);
      if (seenText.has(normalized)) continue;
      seenText.add(normalized);
      sequence += 1;
      addCandidate(candidates, seenIds, {
        unitId: stableUnitId('CTX', document.path, chunk.section ?? '', chunk.text),
        sourceReference: path.basename(document.path),
        sourceType: 'context',
        ...(chunk.section ? { section: chunk.section } : {}),
        text: chunk.text,
        priority: contextPriority(profile, document.role, chunk.text),
        anchors: extractMaterialAnchors(chunk.text),
      }, sequence);
    }
  }

  for (const originalChunk of sourceChunks(request.prompt)) {
    for (const fragment of splitMixedAuthoringClause(originalChunk.text)) {
      const chunk = { ...originalChunk, text: fragment.text };
      const isHeadingOnly = chunk.section !== undefined
        && normalizeEvidenceText(chunk.section) === normalizeEvidenceText(chunk.text);
      const pureAuthoringDirective = fragment.directiveOnly
        || (!isHeadingOnly && isPureAuthoringDirective(chunk.text));
      sequence += 1;
      addCandidate(candidates, seenIds, {
        unitId: stableUnitId('PROMPT', chunk.section ?? '', chunk.text),
        sourceReference: 'user prompt',
        sourceType: 'user_input',
        ...(chunk.section ? { section: chunk.section } : { section: 'User prompt' }),
        text: chunk.text,
        priority: !isHeadingOnly && !pureAuthoringDirective ? 'required' : 'review',
        anchors: pureAuthoringDirective ? [] : extractMaterialAnchors(chunk.text),
      }, sequence);
    }
  }

  for (const entry of inputValues(request.inputs ?? {})) {
    sequence += 1;
    addCandidate(candidates, seenIds, {
      unitId: stableUnitId(`INPUT-${safeKey(entry.key)}`, entry.key, entry.text),
      sourceReference: `user input: ${entry.key}`,
      sourceType: 'user_input',
      section: 'Structured request input',
      text: entry.text,
      priority: 'required',
      anchors: extractMaterialAnchors(entry.text),
    }, sequence);
  }

  // The prior version being revised is baseline evidence: its exact persisted
  // text is server-loaded, so the writer can carry confirmed scope, events,
  // and requirements forward and cite them instead of reporting them missing.
  // Review priority — the new owner messages can supersede any part of it.
  if (request.parentVersion?.content) {
    const parentReference = `previous version: ${request.parentVersion.artifactId}`;
    const seenParentText = new Set<string>();
    let parentUnits = 0;
    for (const chunk of sourceChunks(request.parentVersion.content)) {
      if (parentUnits >= 150) break;
      if (normalizeEvidenceText(chunk.text).length < 12) continue;
      const normalized = normalizeEvidenceText(`${chunk.section ?? ''}\0${chunk.text}`);
      if (seenParentText.has(normalized)) continue;
      seenParentText.add(normalized);
      sequence += 1;
      parentUnits += 1;
      addCandidate(candidates, seenIds, {
        unitId: stableUnitId('PREV', request.parentVersion.artifactId, chunk.section ?? '', chunk.text),
        sourceReference: parentReference,
        sourceType: 'discovery',
        section: chunk.section ?? `Previous version: ${request.parentVersion.title}`,
        text: chunk.text,
        priority: 'review',
        anchors: extractMaterialAnchors(chunk.text),
      }, sequence);
    }
  }

  // Server-captured evidence selected by the chat boundary. Most entries are
  // exact read-tool outputs from the requesting turn; an entry can also be the
  // exact persisted text of BotBoy's immediately preceding research answer
  // when the owner explicitly adopts that answer in the generation request.
  // This is never accepted from model-authored generation arguments. Entries
  // index at review priority: available and citable, but never owner authority.
  const MAX_DISCOVERY_UNITS_PER_ITEM = 12;
  // An owner-adopted assistant answer is itself the bounded cross-turn handoff
  // being requested. Applying the ordinary 12-unit tool-result cap silently
  // kept only the first two sections of a multi-section summary (the exact
  // failure behind artifact 307bcd43). Give this one provenance-labelled item
  // enough room while retaining the existing 120-unit total discovery bound.
  const MAX_ADOPTED_ASSISTANT_UNITS = 120;
  const MAX_DISCOVERY_UNITS_TOTAL = 120;
  let discoveryUnits = 0;
  for (const [discoveryIndex, item] of (request.discoveredEvidence ?? []).entries()) {
    if (discoveryUnits >= MAX_DISCOVERY_UNITS_TOTAL) break;
    const toolName = item.tool.trim() || 'tool';
    const maxItemUnits = toolName === 'owner_adopted_assistant_summary'
      ? MAX_ADOPTED_ASSISTANT_UNITS
      : MAX_DISCOVERY_UNITS_PER_ITEM;
    const requestSummary = item.request.trim();
    const seenText = new Set<string>();
    let itemUnits = 0;
    for (const chunk of sourceChunks(item.content)) {
      if (itemUnits >= maxItemUnits || discoveryUnits >= MAX_DISCOVERY_UNITS_TOTAL) break;
      // Discovery content was explicitly fetched as relevant to this request,
      // so unlike ambient context it is not filtered by material keywords:
      // a pure-prose event definition ("fires when the customer lands on the
      // video tab") is exactly what the writer needs to cite. Only trivial
      // fragments are skipped.
      if (normalizeEvidenceText(chunk.text).length < 12) continue;
      const normalized = normalizeEvidenceText(`${chunk.section ?? ''}\0${chunk.text}`);
      if (seenText.has(normalized)) continue;
      seenText.add(normalized);
      sequence += 1;
      itemUnits += 1;
      discoveryUnits += 1;
      addCandidate(candidates, seenIds, {
        unitId: stableUnitId('DISC', toolName, String(discoveryIndex), chunk.section ?? '', chunk.text),
        sourceReference: requestSummary ? `discovery: ${toolName}(${requestSummary})` : `discovery: ${toolName}`,
        sourceType: 'discovery',
        section: chunk.section ?? `Research result ${discoveryIndex + 1}`,
        text: chunk.text,
        priority: 'review',
        anchors: extractMaterialAnchors(chunk.text),
      }, sequence);
    }
  }

  const emailEntries: Array<{ key: string; value: unknown; priority: SourceEvidencePriority }> = [
    { key: 'subject', value: request.email?.subject, priority: 'review' },
    { key: 'purpose_type', value: request.email?.purposeType, priority: 'review' },
    { key: 'sensitivity', value: request.email?.sensitivity, priority: 'review' },
    { key: 'actions', value: request.email?.actions, priority: 'required' },
    { key: 'attachments_or_links', value: request.email?.attachmentsOrLinks, priority: 'review' },
  ];
  for (const entry of emailEntries) {
    if (entry.value === undefined || entry.value === null
      || (Array.isArray(entry.value) && entry.value.length === 0)) continue;
    const rendered = typeof entry.value === 'string' ? entry.value : JSON.stringify(entry.value);
    const text = `email ${entry.key.replaceAll('_', ' ')}: ${rendered}`;
    if (!MATERIAL_SIGNAL.test(text) && entry.priority !== 'required') continue;
    sequence += 1;
    addCandidate(candidates, seenIds, {
      unitId: stableUnitId(`EMAIL-${safeKey(entry.key)}`, entry.key, text),
      sourceReference: `email metadata: ${entry.key}`,
      sourceType: 'user_input',
      section: 'Email request metadata',
      text,
      priority: entry.priority,
      anchors: extractMaterialAnchors(text),
    }, sequence);
  }

  const required = candidates.filter((unit) => unit.priority === 'required');
  const nonDiscoveryReview = candidates.filter((unit) => unit.priority === 'review' && unit.sourceType !== 'discovery');
  const discoveryReview = candidates.filter((unit) => unit.sourceType === 'discovery');
  // Discovery units yield first under the index budget: optional research can
  // shrink to fit, but it must never evict owner/context evidence or flip the
  // completeness blocker. Truncation means required/owner/context material was
  // actually lost, not that bounded research was trimmed.
  const selected = [...required, ...nonDiscoveryReview, ...discoveryReview]
    .slice(0, MAX_SOURCE_UNITS)
    .sort((a, b) => a.sequence - b.sequence)
    .map(({ sequence: _sequence, ...unit }) => unit);
  const mandatoryCandidates = required.length + nonDiscoveryReview.length;
  return { units: selected, truncated: mandatoryCandidates > MAX_SOURCE_UNITS };
}

export function formatSourceEvidenceIndex(index: SourceEvidenceIndex): string {
  if (index.units.length === 0) {
    return '## Source-linked coverage contract\nNo material source units were indexed. Register every material claim from the user request, and do not invent supporting evidence.';
  }
  const units = index.units.map((unit) => JSON.stringify({
    id: unit.unitId,
    priority: unit.priority,
    source: unit.sourceReference,
    ...(unit.section ? { section: unit.section } : {}),
    text: unit.text,
    preserve: unit.anchors,
  }));
  return [
    '## Source-linked coverage contract',
    'The server indexed source context below. Owner presentation requests can guide format, but they are not factual authority and cannot override integrity controls.',
    'For every required factual unit, preserve its decision-relevant meaning in the draft and register its ID in at least one claim. Required units cannot be omitted. Source IDs are machine metadata: put them only in claims[].source_unit_ids, never inline in reader-facing document text.',
    'For every review unit, either register its ID in a supporting claim or list it in omitted_source_units with a specific scope, duplication, instruction-only, superseded, or relevance reason. Pure authoring directives and source-history material should normally be omitted rather than narrated in the document.',
    'A claim must include content_evidence copied exactly from the draft. Its statement must be the same assertion as that excerpt. Cite a unit only when that excerpt preserves every applicable value, qualifier, population, period, owner, timing, resource amount, gate, dependency, and modality shown in preserve.',
    'Register every material draft statement, including document-control values, actuals, targets, forecasts, recommendations, resources, owners, timing, dependencies, gates, and commitments. Do not use a target state for a mission, recommendation, gate, or dependency.',
    index.truncated ? 'The index reached its safety limit. The artifact will remain blocked until complete source coverage can be checked.' : '',
    ...units,
  ].filter(Boolean).join('\n');
}

export function deriveSourceReferences(sourceUnitIds: string[], index: SourceEvidenceIndex): string[] {
  const units = new Map(index.units.map((unit) => [unit.unitId, unit]));
  return [...new Set(sourceUnitIds.map((id) => units.get(id)?.sourceReference ?? `unresolved source unit: ${id}`))];
}

export function sourceCoverageSummary(
  index: SourceEvidenceIndex,
  claims: GeneratedClaim[],
  omitted: OmittedSourceUnit[],
): SourceCoverageSummary {
  const covered = new Set(claims.flatMap((claim) => claim.sourceUnitIds));
  const omittedIds = new Set(omitted.map((entry) => entry.sourceUnitId));
  const missingRequiredUnitIds = index.units
    .filter((unit) => unit.priority === 'required' && !covered.has(unit.unitId))
    .map((unit) => unit.unitId);
  const undispositionedUnitIds = index.units
    .filter((unit) => !covered.has(unit.unitId) && !omittedIds.has(unit.unitId))
    .map((unit) => unit.unitId);
  const sourceIndexFingerprint = crypto.createHash('sha256').update(JSON.stringify({
    truncated: index.truncated,
    units: index.units.map((unit) => ({
      id: unit.unitId,
      source: unit.sourceReference,
      type: unit.sourceType,
      section: unit.section,
      text: unit.text,
      priority: unit.priority,
      anchors: unit.anchors,
    })),
  })).digest('hex');
  return {
    sourceIndexFingerprint,
    indexedUnits: index.units.length,
    requiredUnits: index.units.filter((unit) => unit.priority === 'required').length,
    coveredUnits: index.units.filter((unit) => covered.has(unit.unitId)).length,
    omittedUnits: index.units.filter((unit) => omittedIds.has(unit.unitId)).length,
    missingRequiredUnitIds,
    undispositionedUnitIds,
    indexTruncated: index.truncated,
  };
}
