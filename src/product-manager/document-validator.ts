import type {
  DocumentFinding,
  DocumentMaturity,
  DocumentProfile,
  DocumentValidationResult,
  DocumentValidator,
  DocumentValidatorDependencies,
  EmailDraftMetadata,
  FindingSeverity,
  GeneratedClaim,
  GlossaryResolution,
  SourceEvidenceUnit,
  ValidationGroupResult,
  ValidationStatus,
  ValidateDocumentRequest,
} from './types.js';
import {
  extractAudienceAssertions,
  extractMaterialAnchors,
  extractReaderOutcomeAssertions,
  normalizeEvidenceText,
  relationValueGrounded,
  sourceCoverageSummary,
} from './source-fidelity.js';

function hasValue(value: unknown): boolean {
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return value !== undefined && value !== null && value !== false;
}

function normalizedHeading(value: string): string {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase('en-US')
    .replace(/[*_`#.:/()…-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function headings(content: string): string[] {
  const values: string[] = [];
  for (const line of content.split(/\r?\n/)) {
    const markdown = line.match(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/);
    const bold = line.match(/^\s*\*\*(.+?)\*\*\s*$/);
    const value = markdown?.[1] ?? bold?.[1];
    if (value) values.push(normalizedHeading(value));
  }
  return values;
}

function sectionPresent(sectionTitle: string, availableHeadings: string[]): boolean {
  const expected = normalizedHeading(sectionTitle);
  if (availableHeadings.some((heading) => heading === expected || heading.includes(expected) || expected.includes(heading))) return true;
  const significant = expected.split(' ').filter((token) => token.length > 3 && !['with', 'from', 'that', 'when'].includes(token));
  return significant.length >= 2 && availableHeadings.some((heading) => {
    const matched = significant.filter((token) => heading.includes(token)).length;
    return matched >= Math.min(3, significant.length) && matched / significant.length >= 0.6;
  });
}

function groupStatus(findings: DocumentFinding[], off = false): ValidationStatus {
  if (off) return 'not_checked';
  if (findings.some((finding) => finding.severity === 'block' || finding.severity === 'error')) return 'blocked';
  if (findings.length > 0) return 'pass_with_advisories';
  return 'pass';
}

function group(findings: DocumentFinding[], off = false): ValidationGroupResult {
  return { status: groupStatus(findings, off), findings };
}

function finding(
  code: string,
  category: DocumentFinding['category'],
  severity: FindingSeverity,
  message: string,
  suggestion?: string,
  metadata?: Record<string, unknown>,
): DocumentFinding {
  return {
    code,
    category,
    severity,
    message,
    ...(suggestion ? { suggestion } : {}),
    ...(metadata ? { metadata } : {}),
  };
}

function requiredInputPresent(
  inputName: string,
  inputs: Record<string, unknown>,
  email: EmailDraftMetadata | undefined,
): boolean {
  if (Object.prototype.hasOwnProperty.call(inputs, inputName)) {
    const value = inputs[inputName];
    return Array.isArray(value) || hasValue(value);
  }
  const mapping: Record<string, keyof EmailDraftMetadata> = {
    purpose_type: 'purposeType',
    sender: 'sender',
    to_recipients: 'toRecipients',
    cc_recipients: 'ccRecipients',
    sensitivity_or_classification: 'sensitivity',
    subject_or_topic: 'subject',
    actions: 'actions',
    attachments_or_links: 'attachmentsOrLinks',
  };
  const key = mapping[inputName];
  if (key && email && Object.prototype.hasOwnProperty.call(email, key)) {
    const value = email[key];
    return Array.isArray(value) || hasValue(value);
  }
  if (inputName === 'deadline_when_applicable'
    && !['action_required', 'decision_required', 'input_requested'].includes(email?.purposeType ?? '')) return true;
  return false;
}

function completenessSeverity(maturity: DocumentMaturity | undefined): FindingSeverity {
  return (maturity ?? 'publication') === 'publication' ? 'block' : 'warning';
}

function validateRequiredInputs(profile: DocumentProfile, request: ValidateDocumentRequest): DocumentFinding[] {
  const inputs = request.inputs ?? {};
  const severity = completenessSeverity(request.maturity);
  return profile.required_inputs.flatMap((inputName) => {
    if (requiredInputPresent(inputName, inputs, request.email)) return [];
    return [finding(
      'PROFILE_REQUIRED_INPUT_MISSING',
      'profile',
      severity,
      `Profile readiness input “${inputName}” is missing for ${request.maturity ?? 'publication'} maturity.`,
      severity === 'block'
        ? 'Supply the input or choose a non-publication maturity that can represent the gap honestly.'
        : 'Add the input when it becomes available; do not invent it or fill the draft with placeholders.',
      { input: inputName, maturity: request.maturity ?? 'publication' },
    )];
  });
}

function validateSections(profile: DocumentProfile, request: ValidateDocumentRequest): DocumentFinding[] {
  if (profile.family === 'communication' || profile.family === 'prd_artifact') return [];
  const available = headings(request.content);
  const severity = completenessSeverity(request.maturity);
  return profile.ordered_sections
    .filter((section) => section.requirement === 'mandatory' && !sectionPresent(section.title, available))
    .map((section) => finding(
      'PROFILE_REQUIRED_SECTION_MISSING',
      'profile',
      severity,
      `Profile section “${section.title}” was not found for ${request.maturity ?? 'publication'} maturity.`,
      severity === 'block'
        ? `Add a substantive section headed “${section.title}” or use the exact profile heading while preserving the document's meaning.`
        : 'Use the section only when it improves this draft; missing profile sections remain publication-readiness advisories.',
      { sectionId: section.section_id, maturity: request.maturity ?? 'publication' },
    ));
}

const ADAPTIVE_SUBSTANCE_STOP_WORDS = new Set([
  'about', 'after', 'also', 'and', 'are', 'because', 'been', 'before', 'being', 'brief',
  'can', 'clear', 'context', 'document', 'draft', 'for', 'from', 'have', 'information',
  'into', 'its', 'key', 'more', 'must', 'overview', 'provides', 'summary', 'that', 'the',
  'their', 'there', 'these', 'this', 'through', 'was', 'were', 'will', 'with', 'would',
]);

function adaptiveMaterialWords(value: string): string[] {
  return normalizeEvidenceText(value).split(/[^a-z0-9]+/)
    .filter((word) => word.length >= 3 && !ADAPTIVE_SUBSTANCE_STOP_WORDS.has(word));
}

function adaptiveTokensRelated(left: string, right: string): boolean {
  return left === right || (left.length >= 5 && right.length >= 5 && left.slice(0, 5) === right.slice(0, 5));
}

function adaptiveActorAssertions(value: string): string[] {
  const actors = [...extractAudienceAssertions(value)];
  const groupPattern = /\b(?:the\s+)?([A-Za-z][A-Za-z0-9&'/-]*(?:\s+[A-Za-z][A-Za-z0-9&'/-]*){0,2}\s+(?:team|leaders?|executives?|stakeholders?|customers?|partners?|reviewers?|owners?|readers?|users?|council|committee|group|department|board|management))\b/gi;
  for (const match of value.matchAll(groupPattern)) {
    const actor = (match[1] ?? '')
      .replace(/^(?:(?:reader|audience|outcome|purpose)\s+)+/i, '')
      .trim();
    if (actor) actors.push(actor);
  }
  return [...new Map(actors.map((actor) => [normalizeEvidenceText(actor), actor])).values()];
}

function adaptiveClaimSupport(
  claim: GeneratedClaim,
  unitMap: Map<string, SourceEvidenceUnit>,
): { materialWords: string[]; supportedWords: string[]; unsupportedPropositions: string[] } {
  const citedUnits = claim.sourceUnitIds
    .map((sourceUnitId) => unitMap.get(sourceUnitId))
    .filter((unit): unit is SourceEvidenceUnit => unit !== undefined);
  const sourceWords = citedUnits.flatMap((unit) => adaptiveMaterialWords(unit.text));
  const sourceActors = citedUnits.flatMap((unit) => adaptiveActorAssertions(unit.text));
  const sourceAudiences = citedUnits.flatMap((unit) => extractAudienceAssertions(unit.text));
  const sourceOutcomes = citedUnits.flatMap((unit) => extractReaderOutcomeAssertions(unit.text));
  const materialWords = adaptiveMaterialWords(claim.contentEvidence);
  const supportedWords = materialWords.filter((word) =>
    sourceWords.some((sourceWord) => adaptiveTokensRelated(word, sourceWord)));
  const propositions = claim.contentEvidence
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .split(/\n|(?<=[.!?;])\s+|\s+[—–]\s+/)
    .map((proposition) => proposition.replace(/[*_`|#]/g, ' ').replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  const unsupportedPropositions = propositions.filter((proposition) => {
    const unsupportedActor = adaptiveActorAssertions(proposition)
      .some((actor) => !relationValueGrounded(actor, sourceActors));
    const unsupportedAudience = extractAudienceAssertions(proposition)
      .some((audience) => !relationValueGrounded(audience, sourceAudiences));
    const unsupportedOutcome = extractReaderOutcomeAssertions(proposition)
      .some((outcome) => !relationValueGrounded(outcome, sourceOutcomes));
    if (unsupportedActor || unsupportedAudience || unsupportedOutcome) return true;
    const words = adaptiveMaterialWords(proposition);
    if (words.length === 0) return false;
    // Publication claims fail closed on every material lexical relation. The
    // stop-word set permits grammar and presentation glue; every remaining
    // actor, entity, action, object, and qualifier must occur (or share a
    // stable morphological stem) in the cited source excerpt.
    return words.some((word) =>
      !sourceWords.some((sourceWord) => adaptiveTokensRelated(word, sourceWord)));
  });
  return { materialWords, supportedWords, unsupportedPropositions };
}

function validateAdaptivePublication(profile: DocumentProfile, request: ValidateDocumentRequest): DocumentFinding[] {
  if (profile.profile_id !== 'business_document/adaptive.v1' || request.maturity !== 'publication') return [];
  const plain = request.content
    .replace(/^\s{0,3}#{1,6}\s+.*$/gm, '')
    .replace(/[*_`|#]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const words = plain.split(/\s+/).filter(Boolean);
  const wordCount = words.length;
  const materialWords = adaptiveMaterialWords(plain);
  const frequencies = materialWords.reduce<Map<string, number>>((counts, word) => {
    counts.set(word, (counts.get(word) ?? 0) + 1);
    return counts;
  }, new Map());
  const uniqueWordCount = frequencies.size;
  const dominantWordCount = Math.max(0, ...frequencies.values());
  const lexicalDiversity = uniqueWordCount / Math.max(1, materialWords.length);
  const dominantWordRatio = dominantWordCount / Math.max(1, materialWords.length);

  const unitMap = new Map((request.sourceEvidence?.units ?? []).map((unit) => [unit.unitId, unit]));
  const normalizedContent = normalizeEvidenceText(request.content);
  const linkedClaims = (request.claims ?? []).filter((claim) =>
    claim.contentEvidence.trim().length > 0
    && normalizedContent.includes(normalizeEvidenceText(claim.contentEvidence))
    && claim.sourceUnitIds.some((sourceUnitId) => unitMap.has(sourceUnitId)));
  const relationLinked = (extractor: (value: string) => string[]) => linkedClaims.some((claim) => {
    const draftAssertions = extractor(claim.contentEvidence);
    const sourceAssertions = claim.sourceUnitIds
      .map((sourceUnitId) => unitMap.get(sourceUnitId))
      .filter((unit): unit is SourceEvidenceUnit => unit !== undefined)
      .flatMap((unit) => extractor(unit.text));
    return draftAssertions.some((assertion) => relationValueGrounded(assertion, sourceAssertions));
  });
  const hasAudience = relationLinked(extractAudienceAssertions);
  const hasReaderOutcome = relationLinked(extractReaderOutcomeAssertions);
  const support = linkedClaims.map((claim) => adaptiveClaimSupport(claim, unitMap));
  const linkedMaterialWords = support.flatMap((entry) => entry.materialWords);
  const linkedUniqueWordCount = new Set(linkedMaterialWords).size;
  const sourceSupportedWords = support.flatMap((entry) => entry.supportedWords);
  const sourceSupportedUniqueWordCount = new Set(sourceSupportedWords).size;
  const sourceSupportRatio = sourceSupportedWords.length / Math.max(1, linkedMaterialWords.length);
  const unsupportedPropositions = support.flatMap((entry) => entry.unsupportedPropositions);
  const hasSubstance = wordCount >= 40
    && uniqueWordCount >= 18
    && lexicalDiversity >= 0.35
    && dominantWordRatio <= 0.2
    && linkedMaterialWords.length >= 12
    && linkedUniqueWordCount >= 8
    && sourceSupportedWords.length >= 12
    && sourceSupportedUniqueWordCount >= 8
    && sourceSupportRatio >= 0.4
    && unsupportedPropositions.length === 0;

  const findings: DocumentFinding[] = [];
  if (!hasAudience) {
    findings.push(finding(
      'PROFILE_ADAPTIVE_PUBLICATION_AUDIENCE_MISSING',
      'profile',
      'block',
      'Adaptive publication output does not express a source-linked concrete reader or audience relationship.',
      'Use an audience explicitly and affirmatively asserted by the owner, then register the reader-facing excerpt against that source unit; a topic, negative relation, or “Audience” label alone is insufficient.',
    ));
  }
  if (!hasReaderOutcome) {
    findings.push(finding(
      'PROFILE_ADAPTIVE_PUBLICATION_OUTCOME_MISSING',
      'profile',
      'block',
      'Adaptive publication output does not express a source-linked action or outcome for the reader.',
      'State an affirmative source-supported action or outcome for the source-identified reader and cite the supporting source unit; a prohibited action cannot authorize its positive form.',
    ));
  }
  if (!hasSubstance) {
    findings.push(finding(
      'PROFILE_ADAPTIVE_PUBLICATION_SUBSTANCE_MISSING',
      'profile',
      'block',
      `Adaptive publication output lacks proposition-level source-supported substance (${wordCount} words; ${uniqueWordCount} unique material words; ${sourceSupportedWords.length}/${linkedMaterialWords.length} linked words supported; ${unsupportedPropositions.length} unsupported propositions).`,
      'Provide a complete, varied reader-facing narrative whose material propositions overlap their cited owner/context excerpts. A known source ID, repeated filler, or lexical variety without semantic support cannot establish publication readiness.',
      {
        wordCount,
        uniqueWordCount,
        lexicalDiversity,
        dominantWordRatio,
        linkedMaterialWordCount: linkedMaterialWords.length,
        linkedUniqueWordCount,
        sourceSupportedWordCount: sourceSupportedWords.length,
        sourceSupportedUniqueWordCount,
        sourceSupportRatio,
        unsupportedPropositionCount: unsupportedPropositions.length,
        unsupportedPropositionSamples: unsupportedPropositions.slice(0, 5),
      },
    ));
  }
  return findings;
}

function validateWorkbook(content: string): DocumentFinding[] {
  const findings: DocumentFinding[] = [];
  const expected = ['No.', 'Workstream', 'Feature', 'As a...', 'I want...', 'So that...', 'Priority', 'Acceptance Criteria', 'Notes'];
  const tableLine = content.split(/\r?\n/).find((line) => line.includes('|'));
  const columns = tableLine?.split('|').map((cell) => cell.trim()).filter(Boolean) ?? [];
  if (columns.length < 8 || expected.slice(0, 8).some((column, index) => normalizedHeading(columns[index] ?? '') !== normalizedHeading(column))) {
    findings.push(finding(
      'WORKBOOK_SCHEMA_INVALID',
      'profile',
      'block',
      'The user-story workbook does not contain the required A:H columns in the exact order.',
      `Use: ${expected.join(' | ')}.`,
    ));
    return findings;
  }
  const rows = content.split(/\r?\n/)
    .filter((line) => line.includes('|'))
    .map((line) => line.split('|').map((cell) => cell.trim()).filter((_, index, all) => !(index === 0 && all[index] === '')))
    .filter((cells) => cells.length >= 8 && !cells.every((cell) => /^:?-{3,}:?$/.test(cell)));
  const dataRows = rows.slice(1);
  const ids = new Set<string>();
  for (const row of dataRows) {
    const id = row[0]?.trim();
    if (!/^[1-9]\d*$/.test(id ?? '') || ids.has(id)) {
      findings.push(finding('WORKBOOK_ID_INVALID', 'profile', 'block', `Workbook row has a missing, duplicate, or invalid durable ID: “${id ?? ''}”.`));
    } else ids.add(id);
    if (!['P0', 'P1', 'P2', 'Decide'].includes(row[6] ?? '')) {
      findings.push(finding('WORKBOOK_PRIORITY_INVALID', 'profile', 'block', `Workbook row ${id || '?'} has an invalid Priority value.`));
    }
    if (!row[7]?.trim()) findings.push(finding('WORKBOOK_ACCEPTANCE_MISSING', 'profile', 'block', `Workbook row ${id || '?'} has no Acceptance Criteria.`));
  }
  return findings;
}

function validateAmazonWriting(profile: DocumentProfile, content: string): DocumentFinding[] {
  const findings: DocumentFinding[] = [];
  const prose = content.replace(/^\s*#{1,6}\s+.*$/gm, '').trim();
  const opening = prose.slice(0, 800);
  if (profile.family !== 'prd_artifact' && !/\b(?:purpose|recommend|decision|request|ask|proposal|plan|update|must|can)\b/i.test(opening)) {
    findings.push(finding(
      'WRITING_OPENING_NOT_DIRECT',
      'writing',
      'warning',
      'The opening does not clearly state a purpose, recommendation, decision, request, plan, or update.',
      'Put the decision, takeaway, recommendation, or ask near the start.',
      { heuristic: true },
    ));
  }
  const leakedInstruction = content.match(/\[Owner message \d+\]|<\/?(?:user_request_json|authoring_plan_json)>|source-linked coverage contract|return only one JSON object|create one draft from this request|do not perform actions outside drafting and validation|the server indexed material source units|\[(?:CTX|PROMPT|PREV|DISC|INPUT|EMAIL)[A-Z0-9_-]*\]/i);
  if (leakedInstruction) {
    findings.push(finding(
      'WRITING_META_INSTRUCTION_LEAKAGE',
      'writing',
      'block',
      `The draft exposes authoring or server-control text: “${leakedInstruction[0]}”.`,
      'Remove routing labels, prompt instructions, evidence-ledger commentary, and other drafting-process text from the reader-facing document.',
    ));
  }
  const placeholders = content.match(/(?:\b(?:TBD|TODO|FIXME|Not provided|Not specified|To be determined)\b|XX+)/gi) ?? [];
  if (placeholders.length >= 3) {
    findings.push(finding(
      'WRITING_PLACEHOLDER_HEAVY',
      'writing',
      'block',
      `The draft contains ${placeholders.length} unresolved placeholder values and is not usable reader-facing prose.`,
      'Remove empty scaffold fields. Omit irrelevant controls and move only consequential missing information into concise assumptions or open questions.',
      { count: placeholders.length, examples: placeholders.slice(0, 10) },
    ));
  } else if (placeholders.length > 0) {
    findings.push(finding(
      'WRITING_UNRESOLVED_PLACEHOLDER',
      'writing',
      'warning',
      'The draft contains an unresolved placeholder.',
      'Resolve it, omit the empty field, or move the consequential gap to an explicit assumptions/open-questions register.',
      { count: placeholders.length },
    ));
  }
  if (/\b(?:obviously|clearly|very|extremely|best-in-class|world-class)\b/i.test(content)) {
    findings.push(finding(
      'WRITING_SUBJECTIVE_LANGUAGE',
      'writing',
      'warning',
      'The draft contains subjective or intensifying language that may not help the decision.',
      'Replace it with evidence, a bounded comparison, or a precise description.',
      { heuristic: true },
    ));
  }
  return findings;
}

function contentWithoutStructuralNumbers(content: string): string {
  return content.split(/\r?\n/)
    .filter((line) => !/^\s{0,3}#{1,6}\s+/.test(line) && !/^\s*\|?\s*:?-{3,}/.test(line))
    .map((line) => line.replace(/^\s*\d+[.)]\s+/, ''))
    .join('\n');
}

function normalizedIncludes(value: string, expected: string): boolean {
  return normalizeEvidenceText(value).includes(normalizeEvidenceText(expected));
}

const SEMANTIC_STOP_WORDS = new Set([
  'about', 'after', 'also', 'another', 'because', 'before', 'being', 'between', 'could', 'does',
  'each', 'every', 'from', 'have', 'into', 'more', 'most', 'only', 'other', 'should', 'than',
  'that', 'their', 'there', 'these', 'this', 'through', 'under', 'until', 'when', 'where',
  'which', 'while', 'with', 'would', 'your', 'source', 'input', 'value', 'option', 'record',
]);
const NEUTRAL_TITLE_WORDS = new Set([
  'brief', 'business', 'document', 'draft', 'email', 'operating', 'plan', 'planning', 'proposal',
  'report', 'review', 'roadmap', 'strategy', 'update', 'vision', 'project', 'program',
]);

function scopedIdentityTokens(value: string): Set<string> {
  const identities = new Set<string>();
  const pattern = /\b(?:team|project|scenario|option|group|track|plan|variant|model|workstream|initiative|product|program)\s+([A-Za-z0-9][A-Za-z0-9_-]*)\b/gi;
  for (const match of value.matchAll(pattern)) identities.add(`entity:${normalizeEvidenceText(match[1])}`);
  return identities;
}

function semanticTokens(value: string): Set<string> {
  const tokens = new Set(normalizeEvidenceText(value)
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 3 && !SEMANTIC_STOP_WORDS.has(token)));
  for (const identity of scopedIdentityTokens(value)) tokens.add(identity);
  return tokens;
}

function qualitativeValueSupported(
  value: string,
  units: SourceEvidenceUnit[],
  neutralWords: Set<string> = new Set(),
): boolean {
  if (units.some((unit) => normalizedIncludes(unit.text, value))) return true;
  const valueTokens = new Set([...semanticTokens(value)].filter((token) => !neutralWords.has(token)));
  if (valueTokens.size === 0) return true;
  const identities = scopedIdentityTokens(value);
  return units.some((unit) => {
    const sourceTokens = semanticTokens(unit.text);
    const sourceIdentities = scopedIdentityTokens(unit.text);
    if ([...identities].some((identity) => !sourceIdentities.has(identity))) return false;
    let overlap = 0;
    for (const token of valueTokens) if (sourceTokens.has(token)) overlap += 1;
    return valueTokens.size <= 2
      ? overlap === valueTokens.size
      : overlap >= 2 && overlap / valueTokens.size >= 0.5;
  });
}

function unsupportedIdentityTokens(value: string, units: SourceEvidenceUnit[]): string[] {
  const supported = new Set(units.flatMap((unit) => [...scopedIdentityTokens(unit.text)]));
  return [...scopedIdentityTokens(value)].filter((identity) => !supported.has(identity));
}

const REJECTED_STATE_SIGNAL = /\b(?:rejected|denied|declined|cancelled|canceled|withdrawn|revoked|superseded|abandoned|deferred)\b/i;
const WEAK_APPROVAL_SIGNAL = /\b(?:not\s+(?:approved|authorized|accepted|ratified)|pending\s+(?:approval|authorization|decision)|proposed|recommended|under\s+review|draft)\b/i;
const WEAK_COMMITMENT_SIGNAL = /\b(?:not\s+(?:an?\s+)?commitment|non[- ]binding|forecast|assumption|proposed|pending|open|draft)\b/i;
const WEAK_ACTUAL_SIGNAL = /\b(?:forecast|assumption|proposed|estimated|projected|target)\b/i;

function positiveStateText(value: string): string {
  return normalizeEvidenceText(value)
    .replace(/\b(?:not|never)\s+(?:approved|authorized|accepted|ratified|committed)\b/g, '')
    .replace(/\bnot\s+(?:an?\s+)?commitment\b/g, '')
    .replace(/\bpending\s+(?:approval|authorization|decision)\b/g, '');
}

function stateContradictsText(state: GeneratedClaim['state'], value: string): boolean {
  const normalized = normalizeEvidenceText(value);
  const positive = positiveStateText(value);
  if (state === 'approved' || state === 'approved_target') {
    return REJECTED_STATE_SIGNAL.test(normalized)
      || (WEAK_APPROVAL_SIGNAL.test(normalized) && !/\b(?:approved|authorized|accepted|ratified)\b/.test(positive));
  }
  if (state === 'commitment') {
    return REJECTED_STATE_SIGNAL.test(normalized)
      || (WEAK_COMMITMENT_SIGNAL.test(normalized)
        && !/\b(?:committed|commitment|must|required|shall|will)\b/.test(positive));
  }
  if (state === 'actual') {
    return WEAK_ACTUAL_SIGNAL.test(normalized)
      && !/\b(?:actual|observed|measured|reported|completed|delivered)\b/.test(positive);
  }
  if (state === 'proposed' || state === 'proposed_target') {
    return REJECTED_STATE_SIGNAL.test(normalized);
  }
  return false;
}

function claimStateFindings(claim: GeneratedClaim, index: number): DocumentFinding[] {
  const findings: DocumentFinding[] = [];
  const ordinal = index + 1;
  const state = claim.state;
  const text = normalizeEvidenceText(`${claim.statement} ${claim.contentEvidence} ${claim.caveat ?? ''}`);
  if ((claim.kind === 'mission' || claim.kind === 'vision') && state !== 'stated') {
    findings.push(finding(
      'EVIDENCE_CLAIM_STATE_INVALID',
      'evidence',
      'error',
      `Claim ${ordinal} is a ${claim.kind} and must use the stated evidence state, not ${state}.`,
      'Use claim_type for semantic purpose and reserve commitment for an explicitly authorized obligation.',
      { claimIndex: index, claimKind: claim.kind, state },
    ));
  }
  if (claim.kind === 'target' && state !== 'proposed_target' && state !== 'approved_target') {
    findings.push(finding(
      'EVIDENCE_CLAIM_STATE_INVALID',
      'evidence',
      'error',
      `Claim ${ordinal} is a target but uses state ${state}.`,
      'Use proposed_target or approved_target according to the source.',
      { claimIndex: index, claimKind: claim.kind, state },
    ));
  }
  if (['recommendation', 'decision_gate', 'dependency'].includes(claim.kind)
    && ['proposed_target', 'approved_target'].includes(state)) {
    findings.push(finding(
      'EVIDENCE_CLAIM_STATE_INVALID',
      'evidence',
      'error',
      `Claim ${ordinal} is a ${claim.kind} but is typed as a target.`,
      'Use proposed, approved, actual, or stated to preserve the source semantics.',
      { claimIndex: index, claimKind: claim.kind, state },
    ));
  }
  if (stateContradictsText(state, text)) {
    findings.push(finding(
      'EVIDENCE_CLAIM_STATE_CONTRADICTION',
      'evidence',
      'error',
      `Claim ${ordinal} is typed as ${state}, but its exact assertion expresses a weaker, rejected, cancelled, superseded, or otherwise incompatible state.`,
      'Use the state expressed by the exact assertion. Approval, actual, target, and commitment states cannot override contrary wording.',
      { claimIndex: index, claimKind: claim.kind, state },
    ));
  }
  if (/\bmission\s+(?:is|:)\b/.test(text) && claim.kind !== 'mission') {
    findings.push(finding(
      'EVIDENCE_CLAIM_KIND_INVALID',
      'evidence',
      'error',
      `Claim ${ordinal} states a mission but uses claim type ${claim.kind}.`,
      'Use claim_type mission with state stated.',
      { claimIndex: index, claimKind: claim.kind },
    ));
  }
  return findings;
}

const MODALITY_STOP_WORDS = new Set([
  'about', 'after', 'again', 'against', 'before', 'being', 'could', 'every', 'from', 'have',
  'into', 'more', 'only', 'other', 'should', 'their', 'there', 'these', 'this', 'through', 'under',
  'until', 'when', 'where', 'which', 'while', 'with', 'would',
]);
const MODALITY_RELATION_WORDS = new Set([
  'approval', 'approve', 'approved', 'authorization', 'authorized', 'commitment', 'committed',
  'dependencies', 'dependency', 'forecast', 'guaranteed', 'pending', 'prerequisite', 'proposed',
  'question', 'required', 'requirement', 'requires', 'review', 'shall', 'until',
]);

function significantTokens(value: string): Set<string> {
  return new Set(normalizeEvidenceText(value)
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 4 && !MODALITY_STOP_WORDS.has(token)));
}

function modalityScopeTokens(value: string): Set<string> {
  const tokens = new Set([...significantTokens(value)].filter((token) => !MODALITY_RELATION_WORDS.has(token)));
  for (const identity of scopedIdentityTokens(value)) tokens.add(identity);
  return tokens;
}

function overlapScore(left: Set<string>, right: Set<string>): { count: number; ratio: number } {
  let count = 0;
  for (const token of left) if (right.has(token)) count += 1;
  return { count, ratio: count / Math.max(1, Math.min(left.size, right.size)) };
}

function validateModalityPreservation(
  content: string,
  units: SourceEvidenceUnit[],
  claims: GeneratedClaim[],
): DocumentFinding[] {
  const findings: DocumentFinding[] = [];
  const strongGenerated = /\b(?:must|required|requires|prerequisite|guaranteed|committed|is approved|will\b|cannot\b.{0,40}\buntil|before\b.{0,60}\bapprov)/i;
  const strongSource = /\b(?:must|required|requires|prerequisite|guaranteed|committed|is approved|will\b|only if|only after|blocks?|cannot\b.{0,40}\buntil|approve or reject|decision requested|approval\b.{0,30}\bneeded)/i;
  const softSource = /\b(?:open|dependency|dependencies|proposed|pending|question|assumption|forecast|not approved|not a commitment)/i;
  const unitMap = new Map(units.map((unit) => [unit.unitId, unit]));
  const reportedDraftText = new Set<string>();

  for (const [claimIndex, claim] of claims.entries()) {
    if (!strongGenerated.test(`${claim.statement} ${claim.contentEvidence}`)) continue;
    reportedDraftText.add(normalizeEvidenceText(claim.contentEvidence));
    const citedUnits = claim.sourceUnitIds
      .map((id) => unitMap.get(id))
      .filter((unit): unit is SourceEvidenceUnit => unit !== undefined);
    for (const softUnit of citedUnits.filter((unit) => softSource.test(unit.text) && !strongSource.test(unit.text))) {
      findings.push(finding(
        'EVIDENCE_MODALITY_STRENGTHENED',
        'evidence',
        'error',
        `Claim ${claimIndex + 1} strengthens cited source unit ${softUnit.unitId} from an open, proposed, or uncertain state.`,
        'Restore every cited source relationship and scope independently. A stronger source for another entity cannot authorize this unit.',
        { claimIndex, sourceUnitId: softUnit.unitId, sourceText: softUnit.text, draftText: claim.contentEvidence },
      ));
    }
  }

  const allSentences = content
    .replace(/^\s{0,3}#{1,6}\s+.*$/gm, '')
    .split(/\n|(?<=[.!?])\s+(?=[A-Z0-9])/)
    .map((sentence) => sentence.replace(/[*`]/g, '').trim())
    .filter((sentence) => sentence.length > 0 && strongGenerated.test(sentence));
  if (allSentences.length > 500) {
    findings.push(finding(
      'EVIDENCE_MODALITY_CHECK_INCOMPLETE',
      'evidence',
      'error',
      `Modality checking stopped because ${allSentences.length} strong-modality sentences exceed the 500-sentence safety bound.`,
      'Split the artifact or use a bounded multi-pass validation before review.',
    ));
  }
  for (const sentence of allSentences.slice(0, 500)) {
    const normalizedSentence = normalizeEvidenceText(sentence);
    if (reportedDraftText.has(normalizedSentence)
      || claims.some((claim) => normalizedIncludes(claim.contentEvidence, sentence))) continue;
    const sentenceTokens = significantTokens(sentence);
    const sentenceScope = modalityScopeTokens(sentence);
    const matches = units.map((unit) => ({
      unit,
      unitScope: modalityScopeTokens(unit.text),
      ...overlapScore(sentenceTokens, significantTokens(unit.text)),
      scope: overlapScore(sentenceScope, modalityScopeTokens(unit.text)),
    }));
    const bestSoft = matches
      .filter((match) => softSource.test(match.unit.text)
        && (match.scope.count >= 2 || match.count >= 3)
        && (match.scope.ratio >= 0.4 || match.ratio >= 0.45))
      .sort((a, b) => b.scope.count - a.scope.count
        || b.scope.ratio - a.scope.ratio
        || b.count - a.count
        || b.ratio - a.ratio)[0];
    if (!bestSoft) continue;
    const sharedSoftScope = [...bestSoft.unitScope].filter((token) => sentenceScope.has(token));
    const supportedSameScope = matches.some((match) => {
      if (!strongSource.test(match.unit.text)) return false;
      if (match.scope.count < Math.min(2, Math.max(1, sharedSoftScope.length))) return false;
      return sharedSoftScope.every((token) => match.unitScope.has(token));
    });
    if (supportedSameScope) continue;
    findings.push(finding(
      'EVIDENCE_MODALITY_STRENGTHENED',
      'evidence',
      'error',
      `Unregistered draft language appears to strengthen source unit ${bestSoft.unit.unitId} from an open, proposed, or uncertain state.`,
      'Register the statement and preserve the matched entity, relationship, and scope. Authority about another entity cannot strengthen this source.',
      { sourceUnitId: bestSoft.unit.unitId, sourceText: bestSoft.unit.text, draftText: sentence },
    ));
  }
  return findings;
}

function validateSourceEvidence(profile: DocumentProfile, request: ValidateDocumentRequest): DocumentFinding[] {
  if (!request.sourceEvidence && request.claims === undefined && request.omittedSourceUnits === undefined) return [];
  const findings: DocumentFinding[] = [];
  const index = request.sourceEvidence;
  const claims = Array.isArray(request.claims) ? request.claims : [];
  const omitted = Array.isArray(request.omittedSourceUnits) ? request.omittedSourceUnits : [];
  if (!index) {
    return [finding(
      'EVIDENCE_INDEX_MISSING',
      'evidence',
      'error',
      'Claims or source omissions were supplied without the server-built source-evidence index.',
      'Validate generated claims with the same immutable source index used during generation.',
    )];
  }
  const unitMap = new Map(index.units.map((unit) => [unit.unitId, unit]));
  const normalizedContent = normalizeEvidenceText(request.content);
  const claimsByUnit = new Map<string, GeneratedClaim[]>();

  for (const [claimIndex, claim] of claims.entries()) {
    findings.push(...claimStateFindings(claim, claimIndex));
    if (!claim.sourceUnitIds.length) {
      findings.push(finding(
        'EVIDENCE_CLAIM_SOURCE_MISSING',
        'evidence',
        'error',
        `Claim ${claimIndex + 1} has no source-unit IDs.`,
        'Cite one or more indexed source units; otherwise remove or explicitly label the unsupported statement.',
        { claimIndex },
      ));
      continue;
    }
    if (!claim.contentEvidence.trim() || !normalizedContent.includes(normalizeEvidenceText(claim.contentEvidence))) {
      findings.push(finding(
        'EVIDENCE_CLAIM_NOT_IN_CONTENT',
        'evidence',
        'error',
        `Claim ${claimIndex + 1} does not provide an exact whitespace-normalized excerpt from the draft.`,
        'Copy content_evidence directly from the generated Markdown so the claim registry proves where the statement appears.',
        { claimIndex, contentEvidence: claim.contentEvidence },
      ));
    }
    if (!normalizedIncludes(claim.contentEvidence, claim.statement)) {
      findings.push(finding(
        'EVIDENCE_CLAIM_STATEMENT_MISMATCH',
        'evidence',
        'error',
        `Claim ${claimIndex + 1} is not an exact assertion contained in its content_evidence excerpt.`,
        'Copy the claim statement from the exact draft excerpt. Do not let the registry assert a stronger or contradictory meaning.',
        { claimIndex, statement: claim.statement, contentEvidence: claim.contentEvidence },
      ));
    }
    const citedUnits: SourceEvidenceUnit[] = [];
    for (const sourceUnitId of claim.sourceUnitIds) {
      const unit = unitMap.get(sourceUnitId);
      if (!unit) {
        findings.push(finding(
          'EVIDENCE_SOURCE_UNIT_UNKNOWN',
          'evidence',
          'error',
          `Claim ${claimIndex + 1} cites unknown source unit ${sourceUnitId}.`,
          'Use only IDs from the immutable source-evidence index.',
          { claimIndex, sourceUnitId },
        ));
        continue;
      }
      citedUnits.push(unit);
      const existing = claimsByUnit.get(sourceUnitId) ?? [];
      existing.push(claim);
      claimsByUnit.set(sourceUnitId, existing);
    }
    // Anchor support is a falsity gate, so it cannot be skipped by citing
    // unresolvable IDs: a claim whose citations all fail to resolve has NO
    // supporting source text, and any material anchors it carries are
    // unsupported by definition. Without this, a hallucinated source-unit ID
    // would demote to bookkeeping at non-publication maturity and let an
    // invented value through.
    const supportingText = citedUnits.map((unit) => unit.text).join(' ');
    const claimAnchors = extractMaterialAnchors(`${claim.statement} ${claim.contentEvidence}`);
    if (citedUnits.length > 0 || claimAnchors.length > 0) {
      const unsupportedAnchors = claimAnchors
        .filter((anchor) => !normalizedIncludes(supportingText, anchor));
      if (unsupportedAnchors.length > 0) {
        findings.push(finding(
          'EVIDENCE_CLAIM_ANCHOR_UNSUPPORTED',
          'evidence',
          'error',
          citedUnits.length > 0
            ? `Claim ${claimIndex + 1} contains value or qualifier anchors that its cited source units do not support.`
            : `Claim ${claimIndex + 1} carries value or qualifier anchors but none of its cited source units resolve, so nothing supports them.`,
          'Remove the unsupported strengthening or cite the exact source unit that supports every value and qualifier.',
          { claimIndex, sourceUnitIds: claim.sourceUnitIds, unsupportedAnchors: unsupportedAnchors.slice(0, 30) },
        ));
      }
      for (const unit of citedUnits) {
        if (!stateContradictsText(claim.state, unit.text)) continue;
        findings.push(finding(
          'EVIDENCE_CLAIM_STATE_UNSUPPORTED',
          'evidence',
          'error',
          `Claim ${claimIndex + 1} uses state ${claim.state}, but cited source unit ${unit.unitId} expresses an incompatible state.`,
          'Use the weaker source-supported state or split the assertion. Every cited source must preserve its own decision state and scope.',
          { claimIndex, state: claim.state, sourceUnitId: unit.unitId, sourceText: unit.text },
        ));
      }
    }
  }

  const coveredIds = new Set(claims.flatMap((claim) => claim.sourceUnitIds));
  const omittedIds = new Set<string>();
  for (const [omissionIndex, omission] of omitted.entries()) {
    const unit = unitMap.get(omission.sourceUnitId);
    if (!unit) {
      findings.push(finding(
        'EVIDENCE_OMISSION_SOURCE_UNKNOWN',
        'evidence',
        'error',
        `Omission ${omissionIndex + 1} cites unknown source unit ${omission.sourceUnitId}.`,
        'Use only IDs from the immutable source-evidence index.',
        { omissionIndex, sourceUnitId: omission.sourceUnitId },
      ));
      continue;
    }
    if (!omission.reason.trim()) {
      findings.push(finding(
        'EVIDENCE_OMISSION_REASON_MISSING',
        'evidence',
        'error',
        `Omission ${omissionIndex + 1} has no reviewable reason.`,
        'State the scope, duplication, or relevance reason for omitting the review unit.',
        { omissionIndex, sourceUnitId: omission.sourceUnitId },
      ));
    }
    if (coveredIds.has(omission.sourceUnitId)) {
      findings.push(finding(
        'EVIDENCE_DISPOSITION_CONFLICT',
        'evidence',
        'error',
        `Source unit ${omission.sourceUnitId} is both claimed and marked omitted.`,
        'Choose one disposition and keep the claim registry internally consistent.',
        { sourceUnitId: omission.sourceUnitId },
      ));
    }
    if (unit.priority === 'required') {
      findings.push(finding(
        'EVIDENCE_REQUIRED_UNIT_OMITTED',
        'evidence',
        'error',
        `Required source unit ${omission.sourceUnitId} cannot be omitted.`,
        'Represent its decision-relevant meaning in the draft and cite it from an exact content excerpt.',
        { sourceUnitId: omission.sourceUnitId, sourceText: unit.text, reason: omission.reason },
      ));
    }
    omittedIds.add(omission.sourceUnitId);
  }

  for (const unit of index.units) {
    const unitClaims = claimsByUnit.get(unit.unitId) ?? [];
    if (unitClaims.length > 0 && unit.anchors.length > 0) {
      const hasCompleteAnchorCoverage = unitClaims.some((claim) =>
        unit.anchors.every((anchor) => normalizedIncludes(claim.contentEvidence, anchor)));
      if (!hasCompleteAnchorCoverage) {
        findings.push(finding(
          'EVIDENCE_SOURCE_UNIT_PARTIAL',
          'evidence',
          'error',
          `No claim excerpt preserves every material anchor from source unit ${unit.unitId}.`,
          'Add or correct one claim excerpt so it retains every applicable value, qualifier, owner, timing, resource, and modality anchor.',
          { sourceUnitId: unit.unitId, sourceText: unit.text, requiredAnchors: unit.anchors },
        ));
      }
    }
    if (unit.priority === 'required'
      && unit.sourceType === 'user_input'
      && unit.sourceReference.startsWith('user input:')
      && unit.anchors.length === 0) {
      const separator = unit.text.indexOf(':');
      const authoritativeValue = (separator >= 0 ? unit.text.slice(separator + 1) : unit.text).trim();
      const hasExactValue = authoritativeValue.length > 0 && unitClaims.some((claim) =>
        normalizedIncludes(claim.contentEvidence, authoritativeValue));
      if (!hasExactValue) {
        findings.push(finding(
          'EVIDENCE_REQUIRED_INPUT_VALUE_MISSING',
          'evidence',
          'error',
          `Required structured input ${unit.sourceReference} is cited without preserving its authoritative qualitative value.`,
          'Copy the supplied value into an exact draft excerpt; a source-unit ID alone does not prove representation.',
          { sourceUnitId: unit.unitId, sourceText: unit.text, authoritativeValue },
        ));
      }
    }
  }

  const coverage = sourceCoverageSummary(index, claims, omitted);
  if (coverage.missingRequiredUnitIds.length > 0) {
    findings.push(finding(
      'EVIDENCE_REQUIRED_SOURCE_COVERAGE_MISSING',
      'evidence',
      'error',
      `${coverage.missingRequiredUnitIds.length} required source unit(s) are absent from the claim-to-content ledger.`,
      'Add the missing decision-relevant facts to the draft and cite their source-unit IDs from exact content excerpts.',
      { sourceUnitIds: coverage.missingRequiredUnitIds.slice(0, 100) },
    ));
  }
  const reviewUndispositioned = coverage.undispositionedUnitIds.filter((id) => unitMap.get(id)?.priority === 'review');
  if (reviewUndispositioned.length > 0) {
    findings.push(finding(
      'EVIDENCE_REVIEW_SOURCE_UNDISPOSITIONED',
      'evidence',
      'warning',
      `${reviewUndispositioned.length} review source unit(s) are neither claimed nor explicitly omitted.`,
      'Cover each material review unit or record a specific scope, duplication, or relevance reason.',
      { sourceUnitIds: reviewUndispositioned.slice(0, 100) },
    ));
  }
  if (index.truncated) {
    findings.push(finding(
      'EVIDENCE_SOURCE_INDEX_TRUNCATED',
      'evidence',
      'error',
      'The material source-unit index reached its safety limit.',
      'Use bounded multi-pass indexing before review; a known-incomplete evidence ledger cannot authorize a review-ready artifact.',
    ));
  }

  const registeredEvidence = claims.map((claim) => claim.contentEvidence).join('\n');
  const unregisteredAnchors = extractMaterialAnchors(contentWithoutStructuralNumbers(request.content))
    .filter((anchor) => /[\d$]/.test(anchor) && !normalizedIncludes(registeredEvidence, anchor));
  if (unregisteredAnchors.length > 0) {
    const severity: FindingSeverity = ['operating_plan', 'business_document', 'prd'].includes(profile.family) ? 'error' : 'warning';
    findings.push(finding(
      'EVIDENCE_DRAFT_ANCHOR_UNREGISTERED',
      'evidence',
      severity,
      `${new Set(unregisteredAnchors.map(normalizeEvidenceText)).size} numeric, date, or resource anchor(s) in the draft are absent from exact claim excerpts.`,
      'Register every material externally verifiable value. Remove unsupported metadata rather than inventing a source.',
      { anchors: [...new Set(unregisteredAnchors)].slice(0, 50), artifactField: 'content' },
    ));
  }

  const sourceSupports = (value: string) => index.units.some((unit) => normalizedIncludes(unit.text, value));
  const title = request.title?.trim();
  if (title) {
    const unsupportedTitleAnchors = extractMaterialAnchors(title).filter((anchor) => !sourceSupports(anchor));
    const qualitativeTitleSupported = qualitativeValueSupported(title, index.units, NEUTRAL_TITLE_WORDS);
    if (unsupportedTitleAnchors.length > 0 || !qualitativeTitleSupported) {
      findings.push(finding(
        'EVIDENCE_ARTIFACT_TITLE_UNSUPPORTED',
        'evidence',
        'error',
        'The generated artifact title introduces qualitative identity, state, value, date, version, or qualifier metadata that no source unit supports.',
        'Use a neutral title or preserve only title metadata supplied by an authoritative source.',
        {
          artifactField: 'title',
          title,
          unsupportedAnchors: unsupportedTitleAnchors,
          qualitativeTitleSupported,
        },
      ));
    }
  }
  for (const [artifactField, values] of [
    ['assumptions', request.assumptions ?? []],
    ['openQuestions', request.openQuestions ?? []],
  ] as const) {
    for (const [entryIndex, value] of values.entries()) {
      const unsupportedAnchors = extractMaterialAnchors(value).filter((anchor) => !sourceSupports(anchor));
      const unsupportedIdentities = unsupportedIdentityTokens(value, index.units);
      const qualitativeAssumptionUnsupported = artifactField === 'assumptions'
        && !qualitativeValueSupported(value, index.units);
      if (unsupportedAnchors.length === 0
        && unsupportedIdentities.length === 0
        && !qualitativeAssumptionUnsupported) continue;
      findings.push(finding(
        'EVIDENCE_ARTIFACT_FIELD_UNSUPPORTED',
        'evidence',
        'error',
        `The generated ${artifactField} entry ${entryIndex + 1} introduces unsupported qualitative identity, state, value, or qualifier content.`,
        'Keep artifact metadata source-bound; do not introduce new assertions or entities in assumptions or open questions.',
        {
          artifactField,
          entryIndex,
          unsupportedAnchors,
          unsupportedIdentities,
          qualitativeAssumptionUnsupported,
        },
      ));
    }
  }

  const controlDefinitions: Record<string, { labels: string[]; inputKeys: string[] }> = {
    version: { labels: ['version', 'document version', 'revision'], inputKeys: ['version', 'document_version', 'revision'] },
    'document date': { labels: ['document date', 'date', 'as of', 'effective date', 'review date', 'last updated'], inputKeys: ['document_date', 'date', 'as_of', 'effective_date', 'review_date', 'last_updated'] },
    'approval status': { labels: ['approval status'], inputKeys: ['approval_status'] },
    classification: { labels: ['classification', 'confidentiality', 'sensitivity'], inputKeys: ['classification', 'confidentiality', 'sensitivity_or_classification'] },
    'document owner': { labels: ['document owner', 'owner', 'author', 'prepared by'], inputKeys: ['document_owner', 'owner', 'author'] },
    'lifecycle status': { labels: ['lifecycle status', 'document status', 'status'], inputKeys: ['lifecycle_status', 'document_status', 'status'] },
    'approved by': { labels: ['approved by', 'approver'], inputKeys: ['approved_by', 'approver'] },
    'reviewed by': { labels: ['reviewed by', 'reviewer'], inputKeys: ['reviewed_by', 'reviewer'] },
    'plan mode': { labels: ['plan mode'], inputKeys: ['plan_mode'] },
    'planning horizon': { labels: ['planning horizon'], inputKeys: ['planning_horizon'] },
  };
  const normalizeControlLabel = (value: string) => normalizeEvidenceText(value).replace(/[_-]+/g, ' ');
  const controlByLabel = new Map<string, string>();
  for (const [canonical, definition] of Object.entries(controlDefinitions)) {
    for (const label of definition.labels) controlByLabel.set(normalizeControlLabel(label), canonical);
  }
  const unknownControlValue = /^(?:not provided|not specified|unknown|none|unassigned|no approval recorded|not applicable|n\/a)$/i;
  const controlEntries: Array<{ field: string; canonical: string; value: string; artifactField: 'content' | 'title' }> = [];
  const addControlEntry = (field: string, value: string, artifactField: 'content' | 'title' = 'content') => {
    const canonical = controlByLabel.get(normalizeControlLabel(field));
    const cleanedValue = value.replace(/\*+$/g, '').trim().replace(/[.;]+$/g, '').trim();
    if (canonical && cleanedValue) controlEntries.push({ field, canonical, value: cleanedValue, artifactField });
  };
  const contentLines = request.content.split(/\r?\n/);
  for (const line of contentLines) {
    const plainLine = line.replace(/^\s*[-*+]\s*/, '').replace(/[*`]/g, '').trim();
    const labelled = plainLine.match(/^([^:|=—]{2,50})\s*(?::|=|—)\s*(.+?)\s*$/);
    if (labelled) addControlEntry(labelled[1], labelled[2]);
    if (line.includes('|')) {
      const cells = line.split('|').map((cell) => cell.replace(/[*`]/g, '').trim()).filter(Boolean);
      if (cells.length >= 2) addControlEntry(cells[0], cells[1]);
    }
  }
  const firstHeading = contentLines.find((line) => /^\s{0,3}#\s+/.test(line));
  for (const [heading, artifactField] of [
    [firstHeading?.replace(/^\s{0,3}#\s+/, ''), 'content'],
    [title, 'title'],
  ] as const) {
    if (!heading) continue;
    const headingVersion = heading.match(/\b(?:version|ver\.?|v)\s*[: -]?\s*(\d+(?:\.\d+)+(?:[- ]?[A-Za-z0-9]+)?)/i);
    if (headingVersion) addControlEntry('Version', headingVersion[1], artifactField);
    if (/\bapproved\b/i.test(heading)) addControlEntry('Approval status', 'Approved', artifactField);
    if (/\bfinal\b/i.test(heading)) addControlEntry('Lifecycle status', 'Final', artifactField);
    const classification = heading.match(/\b(confidential|restricted|classified)\b/i);
    if (classification) addControlEntry('Classification', classification[1], artifactField);
  }

  const checkedControls = new Set<string>();
  for (const entry of controlEntries) {
    const value = entry.value;
    const identity = `${entry.canonical}\0${normalizeEvidenceText(value)}\0${entry.artifactField}`;
    if (checkedControls.has(identity) || unknownControlValue.test(value)) continue;
    checkedControls.add(identity);
    const definition = controlDefinitions[entry.canonical];
    const inputSupportsValue = definition.inputKeys.some((key) => {
      const input = request.inputs?.[key];
      const rendered = typeof input === 'string' ? input : input === undefined ? '' : JSON.stringify(input);
      return rendered.length > 0 && normalizedIncludes(rendered, value);
    });
    const sourceSupportsValue = index.units.some((unit) =>
      definition.labels.some((label) => normalizeControlLabel(unit.text).includes(normalizeControlLabel(label)))
      && normalizedIncludes(unit.text, value));
    if (inputSupportsValue || sourceSupportsValue) continue;
    findings.push(finding(
      'EVIDENCE_DOCUMENT_CONTROL_UNSUPPORTED',
      'evidence',
      'error',
      `Document-control field “${entry.field}” has unsupported value “${value}”.`,
      'Use an authoritative input value or write “Not provided”; do not invent document metadata.',
      { field: entry.field, canonicalField: entry.canonical, value, artifactField: entry.artifactField },
    ));
  }

  for (let lineIndex = 0; lineIndex < contentLines.length - 1; lineIndex += 1) {
    if (!contentLines[lineIndex].includes('|')
      || !/^\s*\|?\s*:?-{3,}/.test(contentLines[lineIndex + 1])) continue;
    for (let rowIndex = lineIndex + 2; rowIndex < contentLines.length && contentLines[rowIndex].includes('|'); rowIndex += 1) {
      const cells = contentLines[rowIndex].split('|')
        .map((cell) => cell.replace(/[*`]/g, '').trim())
        .filter(Boolean);
      if (cells.length < 2 || controlByLabel.has(normalizeControlLabel(cells[0]))) continue;
      const materialCells = cells.filter((cell) => !/^\d+[.)]?$/.test(cell) && cell.length >= 2);
      const claimsForCell = (cell: string) => claims.filter((claim) => normalizedIncludes(claim.contentEvidence, cell));
      const uncoveredCells = materialCells.filter((cell) => claimsForCell(cell).length === 0);
      const unsupportedCells = materialCells.filter((cell) => {
        const registeredClaims = claimsForCell(cell);
        if (registeredClaims.length === 0) return false;
        return !registeredClaims.some((claim) => {
          const citedUnits = claim.sourceUnitIds
            .map((sourceUnitId) => unitMap.get(sourceUnitId))
            .filter((unit): unit is SourceEvidenceUnit => unit !== undefined);
          return qualitativeValueSupported(cell, citedUnits);
        });
      });
      if (uncoveredCells.length > 0) {
        findings.push(finding(
          'EVIDENCE_TABLE_ROW_UNREGISTERED',
          'evidence',
          'error',
          `Material table row ${rowIndex + 1} contains qualitative or quantitative values absent from exact claim excerpts.`,
          'Register every material table value with an exact excerpt and source-unit IDs; tables cannot bypass source validation.',
          { artifactField: 'content', line: rowIndex + 1, uncoveredCells: uncoveredCells.slice(0, 20) },
        ));
      }
      if (unsupportedCells.length > 0) {
        findings.push(finding(
          'EVIDENCE_TABLE_VALUE_UNSUPPORTED',
          'evidence',
          'error',
          `Material table row ${rowIndex + 1} cites sources that do not support one or more qualitative or quantitative values.`,
          'Cite source units that support each exact table value and its entity, state, scope, and relationship.',
          { artifactField: 'content', line: rowIndex + 1, unsupportedCells: unsupportedCells.slice(0, 20) },
        ));
      }
    }
  }

  findings.push(...validateModalityPreservation(request.content, index.units, claims));
  return findings;
}

function validateGlossary(glossary: GlossaryResolution | undefined, strict: boolean): DocumentFinding[] {
  if (!glossary) return [];
  const findings = glossary.conflicts.map((conflict) => finding(
    'GLOSSARY_CONFLICT',
    'glossary',
    strict ? 'error' : 'warning',
    `Glossary entries conflict for “${conflict.term}”: ${conflict.reason}.`,
    'Resolve the term definition and approval source before publication.',
  ));
  if (glossary.candidateTerms.length > 0) {
    findings.push(finding(
      'GLOSSARY_CANDIDATES_PENDING',
      'glossary',
      strict ? 'error' : 'warning',
      `${glossary.candidateTerms.length} request-scoped technical term candidate(s) are not permanently approved.`,
      strict ? 'Approve required technical terms or record an approved exception.' : 'Review candidates before publication.',
      { terms: glossary.candidateTerms.slice(0, 50).map((entry) => entry.term) },
    ));
  }
  for (const diagnostic of glossary.diagnostics) {
    findings.push(finding('GLOSSARY_DIAGNOSTIC', 'glossary', 'warning', diagnostic));
  }
  return findings;
}

function firstTwoSentences(content: string): string {
  const matches = content.replace(/^\s*#{1,6}\s+.*$/gm, '').match(/[^.!?]+[.!?]+/g);
  return (matches?.slice(0, 2).join(' ') ?? content.slice(0, 800)).trim();
}

function validateEmail(request: ValidateDocumentRequest): DocumentFinding[] {
  const findings: DocumentFinding[] = [];
  const email = request.email;
  const inputs = request.inputs ?? {};
  if (!email) return [finding('EMAIL_METADATA_MISSING', 'email', 'block', 'Email validation requires recipient, purpose, subject, sensitivity, and action metadata.')];
  if (!email.toRecipients?.length) findings.push(finding('EMAIL_TO_MISSING', 'email', 'block', 'At least one To recipient is required.'));
  if (email.bccRecipients?.length && inputs.bccApproved !== true) {
    findings.push(finding('EMAIL_BCC_APPROVAL_REQUIRED', 'email', 'block', 'Blind-copy recipients require explicit user approval.', 'Set bccApproved only after the user reviews the exact BCC recipients.'));
  }
  const opening = firstTwoSentences(request.content);
  if (['action_required', 'decision_required', 'input_requested'].includes(email.purposeType ?? '')
    && !/\b(?:please|request|ask|approve|confirm|decide|decision|input|recommend|reply|respond|must|can you)\b/i.test(opening)) {
    findings.push(finding('EMAIL_ASK_OR_ANSWER_MISSING', 'email', 'block', 'The action, decision, or input request is not clear in the first two sentences.'));
  }
  if (email.purposeType === 'action_required' && !email.actions?.length) {
    findings.push(finding('EMAIL_ACTIONS_MISSING', 'email', 'block', 'An action-required email needs at least one explicit action.'));
  }
  for (const [index, action] of (email.actions ?? []).entries()) {
    if (!action.owner?.trim()) findings.push(finding('EMAIL_ACTION_OWNER_MISSING', 'email', 'block', `Email action ${index + 1} has no owner.`));
    if (!action.deadline?.trim()) findings.push(finding('EMAIL_ACTION_DEADLINE_MISSING', 'email', 'block', `Email action ${index + 1} has no deadline.`));
  }
  const expectedResponders = Array.isArray(inputs.expectedResponders) ? inputs.expectedResponders.filter((value): value is string => typeof value === 'string') : [];
  const cc = new Set((email.ccRecipients ?? []).map((value) => value.toLocaleLowerCase('en-US')));
  const misplaced = expectedResponders.filter((value) => cc.has(value.toLocaleLowerCase('en-US')));
  if (misplaced.length > 0) findings.push(finding('EMAIL_RECIPIENT_SEMANTICS', 'email', 'block', 'One or more expected responders appear only in CC.', 'Move expected actors/deciders to To or update the stated expectation.', { recipients: misplaced }));
  if (/\b(?:attorney-client privileged|legally privileged|strictly confidential)\b/i.test(`${email.subject ?? ''}\n${request.content}`)
    && inputs.classificationVerified !== true) {
    findings.push(finding('EMAIL_UNSUPPORTED_CLASSIFICATION', 'email', 'block', 'The draft makes an unverified confidentiality or privilege claim.'));
  }
  if (/\b(?:URGENT|ASAP|IMMEDIATELY)\b/i.test(`${email.subject ?? ''}\n${request.content}`)
    && !hasValue(inputs.urgencyJustification)) {
    findings.push(finding('EMAIL_FALSE_URGENCY_RISK', 'email', 'block', 'Urgent language has no documented consequence or justification.'));
  }
  if (email.sensitivity && !/^(?:public|internal|none|normal)$/i.test(email.sensitivity)
    && inputs.sensitiveDataReviewed !== true) {
    findings.push(finding('EMAIL_SENSITIVE_DATA_REVIEW', 'email', 'block', 'The sensitivity/classification requires an explicit data and channel review.'));
  }
  if (inputs.send === true || inputs.sendEmail === true) {
    findings.push(finding('EMAIL_SEND_NOT_SUPPORTED', 'email', 'block', 'This feature drafts and validates email only; it has no send capability.'));
  }
  findings.push(finding(
    'EMAIL_SEND_APPROVAL_REQUIRED',
    'email',
    'info',
    'Sending requires separate explicit user approval of final recipients, subject, body, classification, links, attachments, dates, owners, and commitments.',
  ));
  return findings;
}

export function createDocumentValidator(dependencies: DocumentValidatorDependencies): DocumentValidator {
  return {
    validate(request): DocumentValidationResult {
      const profile = dependencies.registry.getProfile(request.profileId);
      const profileFindings = [
        ...validateRequiredInputs(profile, request),
        ...validateSections(profile, request),
        ...validateAdaptivePublication(profile, request),
        ...(profile.family === 'prd_artifact' ? validateWorkbook(request.content) : []),
      ];
      const evidenceFieldsPresent = [
        request.sourceEvidence !== undefined,
        request.claims !== undefined,
        request.omittedSourceUnits !== undefined,
      ];
      const evidenceAttempted = evidenceFieldsPresent.some(Boolean);
      const evidenceComplete = evidenceFieldsPresent.every(Boolean);
      const evidenceFindings = !evidenceAttempted
        ? []
        : evidenceComplete
          ? validateSourceEvidence(profile, request)
          : [finding(
              'EVIDENCE_LEDGER_INCOMPLETE',
              'evidence',
              'error',
              'Source-fidelity validation requires the server-owned source index, claims, and omission ledger together.',
              'Run validation through document generation; do not construct or omit individual ledger components.',
            )];
      const writingFindings = validateAmazonWriting(profile, request.content);
      const emailFindings = profile.family === 'communication' ? validateEmail(request) : [];
      profileFindings.push(...emailFindings);
      const strictGlossary = request.steMode === 'enforced_full' || request.steMode === 'enforced_sections';
      const glossaryFindings = validateGlossary(request.glossary, strictGlossary);
      const steResult = dependencies.steChecker.check({
        content: request.content,
        mode: request.steMode,
        glossary: request.glossary,
        bundleReadiness: dependencies.steBundleLoader.load(),
      });
      // Owner decision (2026-08-13): source traceability is advice, never a
      // gate. Every evidence-category finding — coverage, dispositions,
      // excerpt/anchor support, state/modality consistency, control metadata,
      // table registration — demotes to a warning at EVERY maturity. The
      // findings still reach the receipt and the Documents view so the owner
      // sees exactly which statements lack traced support, but the document
      // itself is theirs to approve. Blocking remains only for mechanically
      // unusable output (meta-instruction leakage, placeholder scaffolding in
      // the writing group) and, at publication maturity, profile completeness
      // and enforced-STE requirements.
      for (const entry of evidenceFindings) {
        if (entry.severity === 'error' || entry.severity === 'block') {
          entry.severity = 'warning';
        }
      }
      const profileGroup = group(profileFindings);
      const evidenceGroup = group(evidenceFindings, !evidenceAttempted);
      const writingGroup = group(writingFindings);
      const glossaryGroup = group(glossaryFindings);
      const steGroup: ValidationGroupResult = { status: steResult.status, findings: steResult.findings };
      const findings = [...profileFindings, ...evidenceFindings, ...writingFindings, ...glossaryFindings, ...steResult.findings];
      const status: ValidationStatus = findings.some((entry) => entry.severity === 'block' || entry.severity === 'error')
        ? 'blocked'
        : findings.length > 0 ? 'pass_with_advisories' : 'pass';
      return {
        status,
        profile: profileGroup,
        evidence: evidenceGroup,
        writing: writingGroup,
        glossary: glossaryGroup,
        ste: steGroup,
        findings,
        checkedAt: new Date().toISOString(),
        checkerVersion: steResult.checkerVersion,
        conformanceStatement: steResult.conformanceStatement,
      };
    },
  };
}
