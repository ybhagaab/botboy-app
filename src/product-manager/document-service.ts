import { randomUUID } from 'crypto';
import { DOCUMENT_MATURITIES } from './types.js';
import type {
  ConfigValidationIssue,
  ContextResolution,
  DocumentAuthoringPlan,
  DocumentCitation,
  DocumentConformanceFinding,
  DocumentConformanceReview,
  DocumentFinding,
  DocumentMaturity,
  DocumentValidationResult,
  GenerateDocumentRequest,
  GeneratedClaim,
  GeneratedClaimKind,
  GlossaryResolution,
  OmittedSourceUnit,
  ProductDocumentArtifact,
  ProductDocumentService,
  ProductDocumentServiceDependencies,
  SourceEvidenceIndex,
  SteEnforcementMode,
  WritingContextConfigOverride,
} from './types.js';
import {
  buildSourceEvidenceIndex,
  deriveSourceReferences,
  extractAudienceAssertions,
  extractReaderOutcomeAssertions,
  formatSourceEvidenceIndex,
  normalizeEvidenceText,
  relationValueGrounded,
  sourceCoverageSummary,
} from './source-fidelity.js';
import { STE_CHECKER_VERSION } from './ste-checker.js';

const STE_MODES = new Set<SteEnforcementMode>(['off', 'advisory', 'enforced_sections', 'enforced_full']);
const DOCUMENT_MATURITY_SET = new Set<DocumentMaturity>(DOCUMENT_MATURITIES);
const PLAN_LENGTHS = new Set<DocumentAuthoringPlan['length']>(['brief', 'standard', 'detailed']);
const PLAN_EVIDENCE_READINESS = new Set<DocumentAuthoringPlan['evidenceReadiness']>(['minimal', 'partial', 'sufficient']);
const CLAIM_STATES = new Set<GeneratedClaim['state']>([
  'actual',
  'proposed',
  'approved',
  'proposed_target',
  'approved_target',
  'forecast',
  'assumption',
  'commitment',
  'stated',
]);
const CLAIM_KINDS = new Set<GeneratedClaimKind>([
  'fact',
  'metric',
  'target',
  'mission',
  'vision',
  'recommendation',
  'decision',
  'decision_gate',
  'dependency',
  'requirement',
  'resource',
  'owner',
  'timing',
  'risk',
  'assumption',
  'other',
]);
const MAX_GENERATION_TOKENS = 16_384;
const ADAPTIVE_PROFILE_ID = 'business_document/adaptive.v1';

interface ProfileFitRule {
  pattern: RegExp;
  description: string;
  accepts(profileId: string, family: string): boolean;
}

const PROFILE_FIT_RULES: ProfileFitRule[] = [
  {
    pattern: /\b(?:write|draft|create|prepare|compose)\s+(?:an?\s+)?(?:action\s+|decision\s+|information\s+|input[- ]request\s+|follow[- ]up\s+)?(?:email|e-mail)\b|\b(?:email|e-mail)\s+(?:draft|message)\b/i,
    description: 'email draft',
    accepts: (profileId) => profileId === 'communication/email.v1',
  },
  {
    pattern: /\buser[ -]stor(?:y|ies)\s+(?:workbook|spreadsheet)\b|\b(?:workbook|spreadsheet)\s+(?:of|for|with)\s+user[ -]stor(?:y|ies)\b/i,
    description: 'user-story workbook',
    accepts: (profileId) => profileId === 'user_stories_workbook.v1',
  },
  {
    pattern: /\b(?:feature[ -]workshop|feature[ -]strategy)\b/i,
    description: 'feature workshop or strategy',
    accepts: (profileId) => profileId === 'business_document/feature_workshop.v1',
  },
  {
    pattern: /\b(?:feature[ -]experiment|experiment[ -](?:plan|brief|document|spec(?:ification)?))\b|\bA\/?B\s+(?:test(?:ing)?|experiment(?:ation)?)\b|\b(?:write|draft|create|prepare|produce|author|compose)\s+(?:an?\s+)?(?:feature\s+)?experiment\b/i,
    description: 'feature or experiment specification',
    accepts: (profileId) => profileId === 'prd/feature_experiment.v1',
  },
  {
    pattern: /\b(?:new[ -]product|MVP)\s+(?:PRD|product[ -]requirements?|plan|spec(?:ification)?)\b|\bPRD\s+for\s+(?:a\s+)?(?:new[ -]product|MVP)\b/i,
    description: 'new-product or MVP specification',
    accepts: (profileId) => profileId === 'prd/new_product_mvp.v1',
  },
  {
    pattern: /\b(?:phase|iteration)\s+(?:PRD|plan|spec(?:ification)?)\b|\bPRD\s+for\s+(?:a\s+)?(?:phase|iteration)\b/i,
    description: 'phase or iteration specification',
    accepts: (profileId) => profileId === 'prd/phase_iteration.v1',
  },
  {
    pattern: /\b(?:decision[ -]memo|business[ -]decision)\b/i,
    description: 'decision memo',
    accepts: (profileId) => profileId === 'business_document/business_decision.v1',
  },
  {
    pattern: /\b(?:operating[ -]plan|OP1|OP2|roadmap[ -](?:document|narrative|plan)|vision[ -](?:narrative|document|plan))\b|\b(?:write|draft|create|prepare|produce|author|compose)\s+(?:an?\s+)?(?:operating[ -]plan|roadmap|vision)\b/i,
    description: 'operating plan, roadmap, or vision narrative',
    accepts: (profileId) => profileId === 'op_roadmap_vision.v1',
  },
  {
    pattern: /\b(?:PRD|product[ -]requirements?(?:[ -]document)?)\b/i,
    description: 'product requirements document',
    accepts: (_profileId, family) => family === 'prd',
  },
];

function profileFitRule(value: string): ProfileFitRule | undefined {
  return PROFILE_FIT_RULES
    .map((rule) => ({ rule, index: rule.pattern.exec(value)?.index ?? Number.POSITIVE_INFINITY }))
    .filter((entry) => Number.isFinite(entry.index))
    .sort((left, right) => left.index - right.index)[0]?.rule;
}

function validateProfileCompatibility(
  profileId: string,
  family: string,
  prompt: string,
  maturity: DocumentMaturity,
  authoringPlan: DocumentAuthoringPlan | undefined,
  /**
   * Owner-approved plan statements inherited from the parent version of a
   * revision. Applied ONLY to the audience/outcome assertion evidence — the
   * profile-fit rules still read the owner's current request alone, so a
   * parent plan can never re-route the profile choice.
   */
  inheritedPlanEvidence?: string,
): void {
  const requestRule = profileFitRule(prompt);
  if (requestRule && !requestRule.accepts(profileId, family)) {
    throw new ProductDocumentRequestError(
      `The owner explicitly requested a ${requestRule.description}; profile ${profileId} is not compatible with that specialized contract.`,
    );
  }
  const formatRule = authoringPlan ? profileFitRule(authoringPlan.format) : undefined;
  if (formatRule && !formatRule.accepts(profileId, family)) {
    throw new ProductDocumentRequestError(
      `authoringPlan.format identifies a ${formatRule.description}, which is incompatible with profile ${profileId}.`,
    );
  }
  if (profileId !== ADAPTIVE_PROFILE_ID || maturity !== 'publication') return;
  if (!authoringPlan) {
    throw new ProductDocumentRequestError('Adaptive publication requires a bounded authoringPlan with a source-supported audience and reader outcome.');
  }
  const assertionEvidence = inheritedPlanEvidence ? `${prompt}\n${inheritedPlanEvidence}` : prompt;
  const audienceAssertions = extractAudienceAssertions(assertionEvidence);
  const supportedAudience = authoringPlan.audience.some((audience) =>
    relationValueGrounded(audience, audienceAssertions));
  if (!supportedAudience) {
    throw new ProductDocumentRequestError('Adaptive publication requires at least one intended audience explicitly asserted in a reader/audience role by the owner request. Topic overlap is not audience authority.');
  }
  const outcomeAssertions = extractReaderOutcomeAssertions(assertionEvidence);
  if (!relationValueGrounded(authoringPlan.purpose, outcomeAssertions)) {
    throw new ProductDocumentRequestError('Adaptive publication requires an explicit, source-supported reader action or outcome; publication and sharing labels are not reader outcomes.');
  }
}

export class ProductDocumentRequestError extends Error {
  constructor(message: string, public readonly issues: ConfigValidationIssue[] = []) {
    super(message);
    this.name = 'ProductDocumentRequestError';
  }
}

export class ProductDocumentGenerationError extends Error {
  constructor(message: string, public readonly code: 'provider_unavailable' | 'provider_failure' | 'malformed_output') {
    super(message);
    this.name = 'ProductDocumentGenerationError';
  }
}

interface ParsedGeneration {
  title: string;
  content: string;
  assumptions: string[];
  openQuestions: string[];
  claims: GeneratedClaim[];
  omittedSourceUnits: OmittedSourceUnit[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function boundedString(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maximum;
}

function stringArray(
  value: unknown,
  maximumItems: number,
  maximumLength: number,
  requireNonEmpty = false,
): string[] | undefined {
  if (!Array.isArray(value) || value.length > maximumItems || (requireNonEmpty && value.length === 0)
    || value.some((entry) => typeof entry !== 'string' || entry.length > maximumLength || (requireNonEmpty && entry.trim().length === 0))) {
    return undefined;
  }
  return value as string[];
}

function boundedPlanList(
  value: unknown,
  field: string,
  maximumItems: number,
  maximumLength: number,
  allowEmpty = false,
): string[] {
  if (!Array.isArray(value) || value.length > maximumItems || (!allowEmpty && value.length === 0)
    || value.some((entry) => typeof entry !== 'string' || entry.trim().length === 0 || entry.length > maximumLength)) {
    throw new ProductDocumentRequestError(`authoringPlan.${field} must be ${allowEmpty ? 'a' : 'a non-empty'} bounded string array.`);
  }
  return value.map((entry) => (entry as string).trim());
}

function normalizeAuthoringPlan(value: unknown): DocumentAuthoringPlan | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new ProductDocumentRequestError('authoringPlan must be a JSON object.');
  if (!boundedString(value.purpose, 2_000)
    || !boundedString(value.format, 200)
    || !boundedString(value.style, 500)
    || typeof value.length !== 'string'
    || !PLAN_LENGTHS.has(value.length as DocumentAuthoringPlan['length'])
    || typeof value.evidenceReadiness !== 'string'
    || !PLAN_EVIDENCE_READINESS.has(value.evidenceReadiness as DocumentAuthoringPlan['evidenceReadiness'])) {
    throw new ProductDocumentRequestError('authoringPlan requires bounded purpose, format, style, length, and evidenceReadiness fields.');
  }
  if (value.selectionRationale !== undefined
    && (typeof value.selectionRationale !== 'string'
      || value.selectionRationale.trim().length === 0
      || value.selectionRationale.length > 2_000)) {
    throw new ProductDocumentRequestError('authoringPlan.selectionRationale must be a non-empty string of at most 2,000 characters.');
  }
  return {
    audience: boundedPlanList(value.audience, 'audience', 20, 500),
    purpose: value.purpose.trim(),
    format: value.format.trim(),
    style: value.style.trim(),
    length: value.length as DocumentAuthoringPlan['length'],
    outline: boundedPlanList(value.outline, 'outline', 30, 500),
    evidenceReadiness: value.evidenceReadiness as DocumentAuthoringPlan['evidenceReadiness'],
    evidenceGaps: boundedPlanList(value.evidenceGaps, 'evidenceGaps', 30, 1_000, true),
    ...(value.selectionRationale === undefined ? {} : { selectionRationale: value.selectionRationale.trim() }),
  };
}

function stripInternalSourceMarkers(value: string): string {
  // Source-unit IDs are machine traceability metadata. They belong in the
  // claims ledger, never in reader-facing Markdown or artifact prose.
  return value
    .replace(/[ \t]*\[(?:CTX|PROMPT|PREV|DISC|INPUT|EMAIL)[A-Z0-9_-]*\]/gi, '')
    .replace(/[ \t]+\n/g, '\n')
    .trim();
}

function parseGeneration(content: string, sourceEvidence: SourceEvidenceIndex): ParsedGeneration {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new ProductDocumentGenerationError('The model did not return valid JSON.', 'malformed_output');
  }
  if (!isRecord(parsed)) throw new ProductDocumentGenerationError('The model response must be a JSON object.', 'malformed_output');
  if (!boundedString(parsed.title, 500) || !boundedString(parsed.content, 1_000_000)) {
    throw new ProductDocumentGenerationError('The model response requires non-empty bounded title and content fields.', 'malformed_output');
  }
  const assumptions = stringArray(parsed.assumptions, 100, 2_000);
  const openQuestions = stringArray(parsed.open_questions, 100, 2_000);
  if (!assumptions || !openQuestions || !Array.isArray(parsed.claims) || parsed.claims.length > 500
    || !Array.isArray(parsed.omitted_source_units) || parsed.omitted_source_units.length > 500) {
    throw new ProductDocumentGenerationError('The model response requires assumptions, open_questions, claims, and omitted_source_units arrays.', 'malformed_output');
  }
  const claims: GeneratedClaim[] = parsed.claims.map((claim, index) => {
    if (!isRecord(claim)
      || !boundedString(claim.statement, 5_000)
      || typeof claim.claim_type !== 'string'
      || !CLAIM_KINDS.has(claim.claim_type as GeneratedClaimKind)
      || typeof claim.state !== 'string'
      || !CLAIM_STATES.has(claim.state as GeneratedClaim['state'])
      || !boundedString(claim.content_evidence, 10_000)) {
      throw new ProductDocumentGenerationError(`Claim ${index + 1} is malformed.`, 'malformed_output');
    }
    const sourceUnitIds = stringArray(claim.source_unit_ids, 100, 200, true);
    if (!sourceUnitIds) throw new ProductDocumentGenerationError(`Claim ${index + 1} requires a non-empty source_unit_ids array.`, 'malformed_output');
    if (claim.caveat !== undefined && claim.caveat !== null
      && (typeof claim.caveat !== 'string' || claim.caveat.length > 5_000)) {
      throw new ProductDocumentGenerationError(`Claim ${index + 1} has an invalid caveat.`, 'malformed_output');
    }
    return {
      statement: stripInternalSourceMarkers(claim.statement),
      kind: claim.claim_type as GeneratedClaimKind,
      state: claim.state as GeneratedClaim['state'],
      sourceReferences: deriveSourceReferences(sourceUnitIds, sourceEvidence),
      sourceUnitIds,
      contentEvidence: stripInternalSourceMarkers(claim.content_evidence),
      ...(claim.caveat === undefined || claim.caveat === null
        ? {}
        : { caveat: stripInternalSourceMarkers(claim.caveat as string) }),
    };
  });
  const omittedSourceUnits: OmittedSourceUnit[] = parsed.omitted_source_units.map((entry, index) => {
    if (!isRecord(entry)
      || !boundedString(entry.source_unit_id, 200)
      || !boundedString(entry.reason, 2_000)) {
      throw new ProductDocumentGenerationError(`Omitted source unit ${index + 1} is malformed.`, 'malformed_output');
    }
    return { sourceUnitId: entry.source_unit_id.trim(), reason: entry.reason.trim() };
  });
  return {
    title: stripInternalSourceMarkers(parsed.title),
    content: stripInternalSourceMarkers(parsed.content),
    assumptions: assumptions.map(stripInternalSourceMarkers).filter(Boolean),
    openQuestions: openQuestions.map(stripInternalSourceMarkers).filter(Boolean),
    claims,
    omittedSourceUnits,
  };
}

function modelShape(generated: ParsedGeneration): Record<string, unknown> {
  return {
    title: generated.title,
    content: generated.content,
    assumptions: generated.assumptions,
    open_questions: generated.openQuestions,
    claims: generated.claims.map((claim) => ({
      statement: claim.statement,
      claim_type: claim.kind,
      state: claim.state,
      source_unit_ids: claim.sourceUnitIds,
      content_evidence: claim.contentEvidence,
      ...(claim.caveat === undefined ? {} : { caveat: claim.caveat }),
    })),
    omitted_source_units: generated.omittedSourceUnits.map((entry) => ({
      source_unit_id: entry.sourceUnitId,
      reason: entry.reason,
    })),
  };
}

function contextManifestOnly(context: ContextResolution): Omit<ContextResolution, 'documents'> {
  return {
    status: context.status,
    overviewAvailable: context.overviewAvailable,
    manifest: context.manifest,
    diagnostics: context.diagnostics,
    totalCharacters: context.totalCharacters,
  };
}

function blockedContextValidation(context: ContextResolution, now: Date): DocumentValidationResult {
  const blockedFinding: DocumentFinding = {
    code: 'CTX_OVERVIEW_REQUIRED',
    category: 'context',
    severity: 'block',
    message: 'The configured authoritative overview could not be loaded, and an assumption-labelled draft was not authorized.',
    suggestion: 'Repair the overview configuration or explicitly allow an assumption-labelled draft.',
    metadata: { diagnostics: context.diagnostics.slice(0, 20) },
  };
  return {
    status: 'blocked',
    profile: { status: 'not_checked', findings: [] },
    evidence: { status: 'not_checked', findings: [] },
    writing: { status: 'not_checked', findings: [] },
    glossary: { status: 'not_checked', findings: [] },
    ste: { status: 'not_checked', findings: [] },
    findings: [blockedFinding],
    checkedAt: now.toISOString(),
    checkerVersion: STE_CHECKER_VERSION,
    conformanceStatement: 'Generation stopped before language checking because required context was unavailable. No conformance claim is made.',
  };
}

function validateRequest(request: GenerateDocumentRequest): {
  steMode: SteEnforcementMode;
  maturity: DocumentMaturity;
  authoringPlan?: DocumentAuthoringPlan;
} {
  if (!isRecord(request)) throw new ProductDocumentRequestError('Generation request must be an object.');
  if (!boundedString(request.profileId, 200)) throw new ProductDocumentRequestError('profileId must be a non-empty bounded string.');
  if (!boundedString(request.prompt, 100_000)) throw new ProductDocumentRequestError('prompt must be a non-empty string of at most 100,000 characters.');
  const steMode = request.steMode ?? 'advisory';
  if (!STE_MODES.has(steMode)) throw new ProductDocumentRequestError('steMode is invalid.');
  const maturity = request.maturity ?? 'publication';
  if (!DOCUMENT_MATURITY_SET.has(maturity)) throw new ProductDocumentRequestError('maturity must be exploratory, working, alignment, or publication.');
  if (request.inputs !== undefined && !isRecord(request.inputs)) throw new ProductDocumentRequestError('inputs must be a JSON object.');
  if (request.contextOverride !== undefined && !isRecord(request.contextOverride)) throw new ProductDocumentRequestError('contextOverride must be a JSON object.');
  if (request.discoveredEvidence !== undefined && (!Array.isArray(request.discoveredEvidence)
    || request.discoveredEvidence.length > 40
    || request.discoveredEvidence.some((item) => !isRecord(item)
      || !boundedString(item.tool, 100)
      || typeof item.request !== 'string' || item.request.length > 2_000
      || !boundedString(item.content, 60_000)))) {
    throw new ProductDocumentRequestError('discoveredEvidence must be a bounded array of server-captured tool results.');
  }
  if (request.parentArtifactId !== undefined && !boundedString(request.parentArtifactId, 200)) {
    throw new ProductDocumentRequestError('parentArtifactId must be a non-empty bounded string.');
  }
  const authoringPlan = normalizeAuthoringPlan(request.authoringPlan);
  return { steMode, maturity, ...(authoringPlan === undefined ? {} : { authoringPlan }) };
}

function overlayVersions(dependencies: ProductDocumentServiceDependencies, profileId: string): Record<string, string> {
  const profile = dependencies.registry.getProfile(profileId);
  const versions: Record<string, string> = {};
  for (const overlayId of [...profile.overlays, ...profile.conditional_modules.filter((id) => id.endsWith('.v1'))]) {
    try {
      const overlay = dependencies.registry.getOverlay(overlayId);
      versions[overlay.overlay_id] = overlay.version;
    } catch {
      // Non-versioned conditional modules are activation labels, not registry assets.
    }
  }
  return versions;
}

function compileUserMessage(request: GenerateDocumentRequest): string {
  return [
    'Create one draft from this request. Do not perform actions outside drafting and validation.',
    request.parentVersion
      ? `This request revises an existing document ("${request.parentVersion.title}"). Its full prior text is indexed as "previous version" source units. Produce a COMPLETE improved document: preserve the prior version's confirmed scope, events, requirements, exclusions, and decisions while registering supporting units only in the claims ledger, apply the owner's new instructions on top, and never report content that exists in the previous version as missing. Only drop prior material the owner's new messages supersede or remove.`
      : '',
    `<user_request_json>${JSON.stringify({
      prompt: request.prompt,
      maturity: request.maturity ?? 'working',
      authoring_plan: request.authoringPlan ?? null,
      inputs: request.inputs ?? {},
      email: request.email ?? null,
    })}</user_request_json>`,
    'Return only one JSON object with this exact shape:',
    JSON.stringify({
      title: 'string',
      content: 'Markdown string using the selected profile headings',
      assumptions: ['string'],
      open_questions: ['string'],
      claims: [{
        statement: 'exact material assertion copied from content_evidence',
        claim_type: 'fact|metric|target|mission|vision|recommendation|decision|decision_gate|dependency|requirement|resource|owner|timing|risk|assumption|other',
        state: 'actual|proposed|approved|proposed_target|approved_target|forecast|assumption|commitment|stated',
        source_unit_ids: ['ID from the source-linked coverage contract'],
        content_evidence: 'exact excerpt copied from content',
        caveat: 'optional string',
      }],
      omitted_source_units: [{
        source_unit_id: 'review-priority ID intentionally not used',
        reason: 'specific scope, duplication, or relevance reason',
      }],
    }, null, 2),
    'Use an empty array when a list has no entries. Do not omit required fields. Required source units cannot appear in omitted_source_units. One claim may cite multiple source units when one exact content excerpt preserves every material anchor from all of them. For an optional claim caveat, use a string when needed; otherwise omit caveat or use null.',
    'Traceability is artifact metadata, not document prose. Put source-unit IDs only in claims[].source_unit_ids or omitted_source_units[].source_unit_id. Never print internal IDs such as DISC-, PROMPT-, PREV-, CTX-, INPUT-, or EMAIL- markers in the title, Markdown content, assumptions, open questions, claim statements, content_evidence, headings, tables, footnotes, or appendices.',
    'Research organization is not document structure. Write the current reader-facing outcome directly. Do not narrate searches, source files, prior drafts, artifact generation, validation, evidence reconciliation, or “older document versus newer document” history unless the owner explicitly asks for a decision-history or source-comparison artifact. Resolve superseded or irrelevant evidence through omitted_source_units instead of adding process/history sections to the document.',
    'Reserve open_questions for decisions only the document owner can make and whose answer is required before the requested draft can be useful: scope, priorities, audience, business constraints, approvals, and conflicting owner statements. At exploratory, working, or alignment maturity, do not use open_questions as a publication-readiness checklist: absent baselines, targets, stakeholder rosters, approval metadata, dates, and rollout thresholds belong in assumptions, proposed measures, delegated follow-up, or the document narrative unless the owner explicitly asked this artifact to decide them. Implementation-level determinations — exact schemas, interface contracts, payload field names, lookup implementations, retry policies, rate limits, service-level objectives, and operational thresholds — are the implementing team\'s responsibility during technical design. Do not return them to the owner as open questions; record them inside the document as explicitly delegated design responsibilities, preserving any constraints the owner has already stated.',
    'Use state stated for mission and vision; proposed or approved for recommendations and gates; proposed_target or approved_target only for targets; commitment only for an explicitly authorized obligation.',
    'Do not add a title qualifier, document version, approval, date, owner, classification, status, or other control value that the evidence does not provide. Omit unsupported controls or identify a consequential gap in open_questions. Never create a repeated “Not provided” scaffold.',
    'Treat every material table cell as evidence-bearing. Preserve complete material inventories—including event catalogs, requirements matrices, interface details, scope and exclusion lists, decisions, dependencies, risks, metrics, and acceptance criteria—at their useful row-level granularity. Render a reader-facing table when the source is tabular or a table is the clearest complete representation. Do not replace supplied rows with a high-level summary merely to be concise. Copy each material row or cell into content_evidence and cite the source units that support it; tables, frontmatter, titles, assumptions, and open questions cannot bypass source fidelity.',
    'Do not claim that an email or other action was sent. For non-email artifacts, do not mention send capability, send status, or boilerplate about actions not being performed.',
  ].join('\n\n');
}

function repairableFindings(validation: DocumentValidationResult): DocumentFinding[] {
  return validation.findings.filter((entry) =>
    (entry.severity === 'error' || entry.severity === 'block')
    && (entry.category === 'evidence'
      || entry.code === 'PROFILE_REQUIRED_SECTION_MISSING'
      || entry.code === 'WRITING_META_INSTRUCTION_LEAKAGE'
      || entry.code === 'WRITING_PLACEHOLDER_HEAVY'));
}

function repairDefectKeys(validation: DocumentValidationResult, generated: ParsedGeneration): Set<string> {
  const keys = new Set<string>();
  for (const entry of repairableFindings(validation)) {
    const ids = new Set<string>();
    const single = entry.metadata?.sourceUnitId;
    if (typeof single === 'string') ids.add(single);
    const multiple = entry.metadata?.sourceUnitIds;
    if (Array.isArray(multiple)) {
      for (const value of multiple) if (typeof value === 'string') ids.add(value);
    }
    const claimIndex = entry.metadata?.claimIndex;
    if (typeof claimIndex === 'number') {
      for (const id of generated.claims[claimIndex]?.sourceUnitIds ?? []) ids.add(id);
    }
    const anchors = entry.metadata?.anchors ?? entry.metadata?.unsupportedAnchors;
    if (ids.size > 0) {
      for (const id of ids) keys.add(`${entry.code}:source:${id}`);
    } else if (Array.isArray(anchors) && anchors.length > 0) {
      for (const anchor of anchors) if (typeof anchor === 'string') keys.add(`${entry.code}:anchor:${anchor}`);
    } else {
      const sectionId = entry.metadata?.sectionId;
      keys.add(`${entry.code}:${typeof sectionId === 'string' ? sectionId : 'document'}`);
    }
  }
  return keys;
}

function validCoveredSourceUnitIds(
  generated: ParsedGeneration,
  validation: DocumentValidationResult,
  sourceEvidence: SourceEvidenceIndex,
): Set<string> {
  const knownIds = new Set(sourceEvidence.units.map((unit) => unit.unitId));
  const invalidIds = new Set<string>();
  for (const entry of repairableFindings(validation)) {
    const single = entry.metadata?.sourceUnitId;
    if (typeof single === 'string') invalidIds.add(single);
    const multiple = entry.metadata?.sourceUnitIds;
    if (Array.isArray(multiple)) {
      for (const value of multiple) if (typeof value === 'string') invalidIds.add(value);
    }
    const claimIndex = entry.metadata?.claimIndex;
    if (typeof claimIndex === 'number') {
      for (const id of generated.claims[claimIndex]?.sourceUnitIds ?? []) invalidIds.add(id);
    }
  }
  return new Set(generated.claims
    .flatMap((claim) => claim.sourceUnitIds)
    .filter((id) => knownIds.has(id) && !invalidIds.has(id)));
}

function stableFindingValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableFindingValue);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, stableFindingValue(entry)]));
  }
  return value;
}

function findingIdentity(entry: DocumentFinding): string {
  return JSON.stringify(stableFindingValue({
    code: entry.code,
    category: entry.category,
    severity: entry.severity,
    message: entry.message,
    metadata: entry.metadata ?? null,
  }));
}

function coveredAnchorKeys(generated: ParsedGeneration, sourceEvidence: SourceEvidenceIndex): Set<string> {
  const unitMap = new Map(sourceEvidence.units.map((unit) => [unit.unitId, unit]));
  const keys = new Set<string>();
  for (const claim of generated.claims) {
    if (!normalizeEvidenceText(generated.content).includes(normalizeEvidenceText(claim.contentEvidence))) continue;
    for (const sourceUnitId of claim.sourceUnitIds) {
      const unit = unitMap.get(sourceUnitId);
      if (!unit) continue;
      for (const anchor of unit.anchors) {
        if (normalizeEvidenceText(claim.contentEvidence).includes(normalizeEvidenceText(anchor))) {
          keys.add(`${sourceUnitId}\0${normalizeEvidenceText(anchor)}`);
        }
      }
    }
  }
  return keys;
}

function protectedClaimKeys(generated: ParsedGeneration, validation: DocumentValidationResult): Set<string> {
  const invalidClaimIndexes = new Set<number>();
  const invalidSourceUnitIds = new Set<string>();
  for (const entry of repairableFindings(validation)) {
    const claimIndex = entry.metadata?.claimIndex;
    if (typeof claimIndex === 'number') invalidClaimIndexes.add(claimIndex);
    const sourceUnitId = entry.metadata?.sourceUnitId;
    if (typeof sourceUnitId === 'string') invalidSourceUnitIds.add(sourceUnitId);
    const sourceUnitIds = entry.metadata?.sourceUnitIds;
    if (Array.isArray(sourceUnitIds)) {
      for (const value of sourceUnitIds) if (typeof value === 'string') invalidSourceUnitIds.add(value);
    }
  }
  return new Set(generated.claims.flatMap((claim, index) => {
    if (invalidClaimIndexes.has(index) || claim.sourceUnitIds.some((id) => invalidSourceUnitIds.has(id))) return [];
    return [JSON.stringify({
      statement: normalizeEvidenceText(claim.statement),
      kind: claim.kind,
      state: claim.state,
      sourceUnitIds: [...claim.sourceUnitIds].sort(),
      contentEvidence: normalizeEvidenceText(claim.contentEvidence),
      caveat: normalizeEvidenceText(claim.caveat ?? ''),
    })];
  }));
}

function markdownHeadings(content: string): Set<string> {
  return new Set(content.split(/\r?\n/)
    .map((line) => line.match(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/)?.[1])
    .filter((value): value is string => value !== undefined)
    .map(normalizeEvidenceText));
}

function isStrictRepairImprovement(
  original: ParsedGeneration,
  originalValidation: DocumentValidationResult,
  candidate: ParsedGeneration,
  candidateValidation: DocumentValidationResult,
  sourceEvidence: SourceEvidenceIndex,
): boolean {
  const originalDefects = repairDefectKeys(originalValidation, original);
  const candidateDefects = repairDefectKeys(candidateValidation, candidate);
  if (candidateDefects.size >= originalDefects.size) return false;
  for (const defect of candidateDefects) if (!originalDefects.has(defect)) return false;

  const originalFindingIds = new Set(originalValidation.findings.map(findingIdentity));
  if (candidateValidation.findings.some((entry) => !originalFindingIds.has(findingIdentity(entry)))) return false;

  const repairableArtifactFields = new Set(repairableFindings(originalValidation)
    .map((entry) => entry.metadata?.artifactField)
    .filter((value): value is string => typeof value === 'string'));
  if (candidate.title !== original.title && !repairableArtifactFields.has('title')) return false;
  if (JSON.stringify(candidate.assumptions) !== JSON.stringify(original.assumptions)
    && !repairableArtifactFields.has('assumptions')) return false;
  if (JSON.stringify(candidate.openQuestions) !== JSON.stringify(original.openQuestions)
    && !repairableArtifactFields.has('openQuestions')) return false;

  const candidateHeadings = markdownHeadings(candidate.content);
  for (const heading of markdownHeadings(original.content)) if (!candidateHeadings.has(heading)) return false;

  const originalValidUnits = validCoveredSourceUnitIds(original, originalValidation, sourceEvidence);
  const candidateValidUnits = validCoveredSourceUnitIds(candidate, candidateValidation, sourceEvidence);
  for (const unitId of originalValidUnits) if (!candidateValidUnits.has(unitId)) return false;

  const candidateAnchors = coveredAnchorKeys(candidate, sourceEvidence);
  for (const anchor of coveredAnchorKeys(original, sourceEvidence)) if (!candidateAnchors.has(anchor)) return false;

  const candidateClaims = new Set(candidate.claims.map((claim) => JSON.stringify({
    statement: normalizeEvidenceText(claim.statement),
    kind: claim.kind,
    state: claim.state,
    sourceUnitIds: [...claim.sourceUnitIds].sort(),
    contentEvidence: normalizeEvidenceText(claim.contentEvidence),
    caveat: normalizeEvidenceText(claim.caveat ?? ''),
  })));
  for (const protectedClaim of protectedClaimKeys(original, originalValidation)) {
    if (!candidateClaims.has(protectedClaim)) return false;
  }
  return true;
}

function relevantRepairUnits(findings: DocumentFinding[], sourceEvidence: SourceEvidenceIndex) {
  const ids = new Set<string>();
  for (const entry of findings) {
    const single = entry.metadata?.sourceUnitId;
    if (typeof single === 'string') ids.add(single);
    const multiple = entry.metadata?.sourceUnitIds;
    if (Array.isArray(multiple)) {
      for (const value of multiple) if (typeof value === 'string') ids.add(value);
    }
  }
  return sourceEvidence.units.filter((unit) => ids.has(unit.unitId)).slice(0, 100);
}

function compileRepairMessage(
  request: GenerateDocumentRequest,
  generated: ParsedGeneration,
  findings: DocumentFinding[],
  sourceEvidence: SourceEvidenceIndex,
): string {
  return [
    'Repair the draft once. Make only the changes needed to resolve the deterministic findings. Preserve every already supported fact, qualifier, section, and exact decision state. Do not perform a broad rewrite.',
    `<deterministic_findings_json>${JSON.stringify(findings.slice(0, 100).map((entry) => ({
      code: entry.code,
      message: entry.message,
      suggestion: entry.suggestion,
      metadata: entry.metadata,
    })))}</deterministic_findings_json>`,
    `<source_units_requiring_repair_json>${JSON.stringify(relevantRepairUnits(findings, sourceEvidence))}</source_units_requiring_repair_json>`,
    `<draft_to_repair_json>${JSON.stringify(modelShape(generated))}</draft_to_repair_json>`,
    compileUserMessage(request),
    'Return the complete corrected JSON object. The server will keep the original draft unless this candidate removes defects without introducing any finding, changing protected artifact fields, dropping a heading, or losing a previously valid claim, source unit, or source anchor.',
  ].join('\n\n');
}

export function createProductDocumentService(dependencies: ProductDocumentServiceDependencies): ProductDocumentService {
  const now = dependencies.now ?? (() => new Date());
  const createArtifactId = dependencies.createArtifactId ?? (() => randomUUID());
  const saveArtifact = (artifact: Omit<ProductDocumentArtifact, 'persisted'>): ProductDocumentArtifact => {
    if (!dependencies.store) return { ...artifact, persisted: false };
    const persistedArtifact: ProductDocumentArtifact = { ...artifact, persisted: true };
    dependencies.store.save(persistedArtifact);
    return persistedArtifact;
  };

  /**
   * The complete authoring guide for one profile: registry instructions plus
   * the attribution rule. One source of truth for the chat writer
   * (getWritingGuide) and the conformance reviewer, so both hold the same
   * contract. Added 2026-08-20 after the PVD memo narrated provenance in
   * body prose ("the thread says…"): the guide's evidence rules demanded
   * traceability but gave the writer no citation channel, so attribution
   * leaked into the document register.
   */
  const authoringGuideFor = (profileId: string, steMode: SteEnforcementMode, maturity: DocumentMaturity): string => [
    dependencies.registry.buildWritingInstructions(profileId, steMode, maturity),
    [
      '## Attribution and citations',
      '1. Keep body prose in document register: state facts directly. Never narrate provenance in the body ("the thread says", "the email describes", "per the captured analysis").',
      '2. Attribute evidence with inline citation markers such as [c1] or [c2] placed immediately after the supported statement, and supply the matching citations metadata (id, label, source, date, short quote, work-item ID or URL) with the save. The reader interface renders each marker as an evidence annotation.',
      '3. Express uncertainty as labeled assumptions or interpretations in document register. Keep metric caveats, but write them as statements about the metric, not as narration about where the metric was found.',
    ].join('\n'),
  ].join('\n\n');

  const resolveContext = async (override?: WritingContextConfigOverride, allowAssumptionDraft?: boolean) => {
    const config = override === undefined
      ? { ok: true as const, config: dependencies.configStore.get() }
      : dependencies.configStore.resolveOverride(override);
    if (!config.ok) throw new ProductDocumentRequestError('Writing-context configuration is invalid.', config.issues);
    return dependencies.contextResolver.resolve(config.config, { allowAssumptionDraft });
  };

  return {
    listProfiles: () => dependencies.registry.listProfiles(),
    listOverlays: () => dependencies.registry.listOverlays(),
    listArtifacts: (limit) => dependencies.store?.list(limit) ?? [],
    getArtifact: (artifactId) => dependencies.store?.get(artifactId) ?? null,
    deleteArtifact: (artifactId) => dependencies.store?.remove(artifactId) ?? false,
    getSteBundleReadiness: () => dependencies.steBundleLoader.load(),

    previewContext: (override, allowAssumptionDraft) => resolveContext(override, allowAssumptionDraft),

    async previewGlossary(request) {
      if (!isRecord(request) || typeof request.prompt !== 'string') {
        throw new ProductDocumentRequestError('Glossary preview requires a prompt string.');
      }
      const context = await resolveContext(request.contextOverride, true);
      return dependencies.glossaryResolver.resolve({
        prompt: request.prompt,
        context,
        documentText: request.documentText,
      });
    },

    async validate(request) {
      if (!isRecord(request) || !boundedString(request.profileId, 200) || typeof request.content !== 'string'
        || typeof request.steMode !== 'string' || !STE_MODES.has(request.steMode as SteEnforcementMode)) {
        throw new ProductDocumentRequestError('Validation requires profileId, content, and a valid steMode.');
      }
      if (request.maturity !== undefined && (typeof request.maturity !== 'string'
        || !DOCUMENT_MATURITY_SET.has(request.maturity as DocumentMaturity))) {
        throw new ProductDocumentRequestError('maturity must be exploratory, working, alignment, or publication.');
      }
      if (request.claims !== undefined || request.omittedSourceUnits !== undefined || request.sourceEvidence !== undefined) {
        throw new ProductDocumentRequestError('Source-fidelity ledgers are server-owned and can only be validated during generation.');
      }
      dependencies.registry.getProfile(request.profileId);
      return dependencies.validator.validate(request);
    },

    async generate(request) {
      const { steMode, maturity, authoringPlan } = validateRequest(request);
      // A revision must SEE the version it revises. The service loads the
      // parent's actual text from the store itself (caller-supplied
      // parentVersion is discarded), so the prior document's confirmed scope
      // becomes citable baseline evidence instead of an invisible reference.
      const parentArtifact = request.parentArtifactId
        ? dependencies.store?.get(request.parentArtifactId) ?? null
        : null;
      const parentVersion = parentArtifact && parentArtifact.content.trim()
        ? { artifactId: parentArtifact.artifactId, title: parentArtifact.title, content: parentArtifact.content }
        : undefined;
      const effectiveRequest: GenerateDocumentRequest = {
        ...request,
        ...(parentVersion === undefined ? { parentVersion: undefined } : { parentVersion }),
        maturity,
        ...(authoringPlan === undefined ? {} : { authoringPlan }),
      };
      const profile = dependencies.registry.getProfile(request.profileId);
      // A revision inherits the parent version's owner-approved plan as owner
      // evidence for the publication gates. The parent's audience and purpose
      // were validated against explicit owner assertions when that version was
      // generated, so a revision request does not have to restate them
      // (post-mortem 2026-08-18: a revision was rejected for a missing reader
      // outcome that its parent already carried). New owner statements in the
      // current request still take precedence — they are checked first.
      const inheritedPlanEvidence = parentArtifact?.authoringPlan
        ? `Intended audience: ${parentArtifact.authoringPlan.audience.join(', ')}. Reader outcome: ${parentArtifact.authoringPlan.purpose}.`
        : undefined;
      validateProfileCompatibility(profile.profile_id, profile.family, request.prompt, maturity, authoringPlan, inheritedPlanEvidence);
      const context = await resolveContext(
        request.contextOverride,
        request.allowAssumptionDraft === true || maturity !== 'publication',
      );
      const initialGlossary = dependencies.glossaryResolver.resolve({
        prompt: request.prompt,
        context,
      });
      const createdAt = now();
      if (context.status === 'blocked_for_context') {
        const emptyEvidence: SourceEvidenceIndex = { units: [], truncated: false };
        return saveArtifact({
          artifactId: createArtifactId(),
          state: 'blocked_for_context',
          profileId: profile.profile_id,
          profileVersion: profile.version,
          overlayVersions: overlayVersions(dependencies, profile.profile_id),
          maturity,
          ...(authoringPlan === undefined ? {} : { authoringPlan }),
          title: 'Generation blocked: required overview unavailable',
          content: '',
          assumptions: [],
          openQuestions: ['Repair the configured overview or explicitly allow an assumption-labelled draft.'],
          claims: [],
          omittedSourceUnits: [],
          sourceCoverage: sourceCoverageSummary(emptyEvidence, [], []),
          context: contextManifestOnly(context),
          glossary: initialGlossary,
          validation: blockedContextValidation(context, createdAt),
          checkerVersion: STE_CHECKER_VERSION,
          createdAt: createdAt.toISOString(),
          emailSendApprovalRequired: profile.family === 'communication',
          ...(request.parentArtifactId === undefined ? {} : { parentArtifactId: request.parentArtifactId }),
          revisionOrigin: 'generated',
        });
      }
      if (!dependencies.llmClient.isAvailable()) {
        throw new ProductDocumentGenerationError('The configured language-model provider is unavailable.', 'provider_unavailable');
      }

      const sourceEvidence = buildSourceEvidenceIndex(context, effectiveRequest, profile);
      const customInstructions = [
        dependencies.registry.buildWritingInstructions(profile.profile_id, steMode, maturity, authoringPlan),
        dependencies.contextResolver.formatForPrompt(context),
        formatSourceEvidenceIndex(sourceEvidence),
        dependencies.glossaryResolver.formatForPrompt(initialGlossary),
        'Use the profile and authoring plan as high-standard writing guidance rather than a reason to produce empty scaffolding or a compressed executive summary. Adapt structure to the audience, purpose, maturity, and available evidence. Preserve every fact, evidence state, owner, date, target, requirement, resource, dependency, gate, qualifier, commitment, event, interface detail, scope/exclusion, decision, risk, metric, acceptance criterion, and material table row. Keep detailed inventories at useful reader-facing granularity; concision removes repetition, not product substance. Never invent missing evidence or metadata. Never turn an open dependency, proposal, question, forecast, or recommendation into a stronger requirement or approval prerequisite. Label assumptions and open questions. Write at the owner\'s altitude: a requirements or alignment document delegates engineering design details (schemas, interface contracts, field names, retry/rate/operational policies, lookups) to the implementing team as named responsibilities instead of demanding them from the owner. Email output is draft-only and cannot be sent by this service.',
      ].join('\n\n');
      const systemPrompt = dependencies.promptManager.getSystemPrompt('product_manager', { customInstructions });
      const maxCompletionTokens = Math.max(
        1_024,
        Math.min(MAX_GENERATION_TOKENS, dependencies.llmClient.getMaxCompletionTokens?.() ?? 8_192),
      );
      const complete = async (userContent: string, repair = false) => {
        const estimatedInputTokens = Math.ceil((systemPrompt.length + userContent.length) / 4);
        const inputBudget = dependencies.llmClient.getContextBudgetTokens?.();
        if (inputBudget !== undefined && estimatedInputTokens > inputBudget) {
          throw new ProductDocumentGenerationError(
            `The source-linked document prompt needs approximately ${estimatedInputTokens} input tokens, above the active provider budget of ${inputBudget}.`,
            'provider_failure',
          );
        }
        return dependencies.llmClient.chatCompletion({
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userContent },
          ],
          temperature: repair ? 0.1 : 0.2,
          maxTokens: maxCompletionTokens,
          responseFormat: { type: 'json_object' },
          think: false,
        });
      };

      let response;
      try {
        response = await complete(compileUserMessage(effectiveRequest));
      } catch (error) {
        if (error instanceof ProductDocumentGenerationError) throw error;
        throw new ProductDocumentGenerationError('The language-model provider failed to generate a draft.', 'provider_failure');
      }
      let generated: ParsedGeneration;
      try {
        if (response.finishReason === 'length') {
          throw new ProductDocumentGenerationError('The model response reached its completion limit before a complete structured draft was returned.', 'malformed_output');
        }
        generated = parseGeneration(response.content, sourceEvidence);
      } catch (error) {
        if (!(error instanceof ProductDocumentGenerationError) || error.code !== 'malformed_output') throw error;

        // Structured-output failures are occasionally transient even with JSON
        // response mode. Retry the whole draft once from canonical evidence;
        // never repair or persist a partial response.
        let retriedResponse;
        try {
          retriedResponse = await complete([
            compileUserMessage(effectiveRequest),
            '',
            'STRUCTURED-OUTPUT RETRY:',
            `The previous attempt was rejected: ${error.message}`,
            'Regenerate the complete document as one valid JSON object. Do not wrap it in Markdown fences.',
            'Return exactly these top-level fields: title, content, assumptions, open_questions, claims, omitted_source_units.',
            'Every claim must include statement, claim_type, state, content_evidence, and a non-empty source_unit_ids array.',
            'Every omitted source unit must include source_unit_id and reason. Keep the document concise enough to finish within the completion limit.',
          ].join('\n'), true);
        } catch (retryError) {
          if (retryError instanceof ProductDocumentGenerationError) throw retryError;
          throw new ProductDocumentGenerationError('The language-model provider failed during structured-output retry.', 'provider_failure');
        }
        if (retriedResponse.finishReason === 'length') {
          throw new ProductDocumentGenerationError('The model response reached its completion limit during structured-output retry.', 'malformed_output');
        }
        generated = parseGeneration(retriedResponse.content, sourceEvidence);
      }
      const validationInputs = {
        ...(request.inputs ?? {}),
        ...(context.overviewAvailable ? { authoritative_overview: true } : {}),
      };
      const validateDraft = (draft: ParsedGeneration, mode: SteEnforcementMode, glossary?: GlossaryResolution) =>
        dependencies.validator.validate({
          profileId: profile.profile_id,
          title: draft.title,
          content: draft.content,
          assumptions: draft.assumptions,
          openQuestions: draft.openQuestions,
          steMode: mode,
          maturity,
          inputs: validationInputs,
          ...(glossary ? { glossary } : {}),
          email: effectiveRequest.email,
          claims: draft.claims,
          sourceEvidence,
          omittedSourceUnits: draft.omittedSourceUnits,
        });

      const initialValidation = validateDraft(generated, 'off');
      const initialRepairFindings = repairableFindings(initialValidation);
      if (initialRepairFindings.length > 0) {
        try {
          const repairedResponse = await complete(
            compileRepairMessage(effectiveRequest, generated, initialRepairFindings, sourceEvidence),
            true,
          );
          if (repairedResponse.finishReason !== 'length') {
            const candidate = parseGeneration(repairedResponse.content, sourceEvidence);
            const candidateValidation = validateDraft(candidate, 'off');
            if (isStrictRepairImprovement(
              generated,
              initialValidation,
              candidate,
              candidateValidation,
              sourceEvidence,
            )) generated = candidate;
          }
        } catch {
          // A bounded repair is best-effort. Keep the complete first draft and its deterministic findings.
        }
      }

      const finalGlossary = dependencies.glossaryResolver.resolve({
        prompt: request.prompt,
        context,
        documentText: generated.content,
      });
      const validation = validateDraft(generated, steMode, finalGlossary);
      // `ready_for_review` means a human can review the artifact; it is not an
      // approval or publication claim. Advisory findings and discussion items
      // remain visible in metadata/UI but cannot hold an otherwise usable
      // non-publication document in a generation loop. Publication candidates
      // still require owner decisions to be resolved before readiness.
      const state = validation.status === 'blocked'
        ? 'blocked_validation'
        : maturity === 'publication' && generated.openQuestions.length > 0
          ? 'draft_review'
          : 'ready_for_review';
      return saveArtifact({
        artifactId: createArtifactId(),
        state,
        profileId: profile.profile_id,
        profileVersion: profile.version,
        overlayVersions: overlayVersions(dependencies, profile.profile_id),
        maturity,
        ...(authoringPlan === undefined ? {} : { authoringPlan }),
        title: generated.title,
        content: generated.content,
        assumptions: generated.assumptions,
        openQuestions: generated.openQuestions,
        claims: generated.claims,
        omittedSourceUnits: generated.omittedSourceUnits,
        sourceCoverage: sourceCoverageSummary(sourceEvidence, generated.claims, generated.omittedSourceUnits),
        context: contextManifestOnly(context),
        glossary: finalGlossary,
        validation,
        model: dependencies.llmClient.getActiveModel?.(),
        checkerVersion: validation.checkerVersion,
        createdAt: createdAt.toISOString(),
        emailSendApprovalRequired: profile.family === 'communication',
        ...(request.parentArtifactId === undefined ? {} : { parentArtifactId: request.parentArtifactId }),
        revisionOrigin: 'generated',
      });
    },

    async ownerRevision(request) {
      if (!isRecord(request)) throw new ProductDocumentRequestError('Owner revision request must be an object.');
      if (!boundedString(request.parentArtifactId, 200)) {
        throw new ProductDocumentRequestError('parentArtifactId must be a non-empty bounded string.');
      }
      if (typeof request.content !== 'string' || !request.content.trim() || request.content.length > 400_000) {
        throw new ProductDocumentRequestError('content must be a non-empty string of at most 400,000 characters.');
      }
      if (request.title !== undefined && !boundedString(request.title, 300)) {
        throw new ProductDocumentRequestError('title must be a non-empty bounded string when provided.');
      }
      const parent = dependencies.store?.get(request.parentArtifactId) ?? null;
      if (!parent) throw new ProductDocumentRequestError('The artifact being revised does not exist.');

      // The owner is the authority for their own words: no model call, no
      // evidence ledger, no blocking. Validation runs informationally so the
      // receipt and Documents view can still surface profile advisories.
      const maturity = parent.maturity ?? 'working';
      const title = request.title?.trim() || parent.title;
      let validation: DocumentValidationResult;
      try {
        validation = dependencies.validator.validate({
          profileId: parent.profileId,
          title,
          content: request.content,
          steMode: 'off',
          maturity,
        });
      } catch {
        validation = {
          status: 'not_checked',
          profile: { status: 'not_checked', findings: [] },
          evidence: { status: 'not_checked', findings: [] },
          writing: { status: 'not_checked', findings: [] },
          glossary: { status: 'not_checked', findings: [] },
          ste: { status: 'not_checked', findings: [] },
          findings: [],
          checkedAt: now().toISOString(),
          checkerVersion: STE_CHECKER_VERSION,
          conformanceStatement: 'Owner revision persisted without validation; no conformance claim is made.',
        };
      }
      const createdAt = now();
      return saveArtifact({
        artifactId: createArtifactId(),
        // Owner-authored content is always a usable draft: validation findings
        // are informational for the owner's own document, never a gate.
        state: 'draft_review',
        profileId: parent.profileId,
        profileVersion: parent.profileVersion,
        overlayVersions: parent.overlayVersions,
        maturity,
        ...(parent.authoringPlan === undefined ? {} : { authoringPlan: parent.authoringPlan }),
        title,
        content: request.content,
        assumptions: [],
        openQuestions: [],
        claims: [],
        omittedSourceUnits: [],
        sourceCoverage: sourceCoverageSummary({ units: [], truncated: false }, [], []),
        context: parent.context,
        glossary: parent.glossary,
        validation,
        checkerVersion: validation.checkerVersion,
        createdAt: createdAt.toISOString(),
        emailSendApprovalRequired: parent.emailSendApprovalRequired,
        parentArtifactId: parent.artifactId,
        revisionOrigin: 'owner_edit',
      });
    },

    getWritingGuide(profileId, maturity) {
      const profile = dependencies.registry.getProfile(profileId?.trim() || 'business_document/adaptive.v1');
      return {
        profileId: profile.profile_id,
        family: profile.family,
        purpose: profile.purpose,
        // STE stays advisory in the guide; strict modes remain an explicit
        // owner request at save time.
        guide: authoringGuideFor(profile.profile_id, 'advisory', maturity ?? 'working'),
        profiles: dependencies.registry.listProfiles(),
      };
    },

    async saveAuthoredDocument(request) {
      // Direct persistence for chat-authored documents. The authoring model
      // already wrote the complete content; this path exists precisely
      // because the gated generate() flow proved brittle in practice
      // (2026-08-20: repeated authoringPlan rejections looped the owner
      // through confirmation questions without ever producing a document).
      // Validation still runs so the Documents view can show advisory
      // findings, but nothing here blocks the save.
      if (!isRecord(request)) throw new ProductDocumentRequestError('Save request must be an object.');
      if (typeof request.content !== 'string' || !request.content.trim() || request.content.length > 400_000) {
        throw new ProductDocumentRequestError('content must be a non-empty string of at most 400,000 characters.');
      }
      if (request.title !== undefined && !boundedString(request.title, 300)) {
        throw new ProductDocumentRequestError('title must be a non-empty string of at most 300 characters when provided.');
      }
      if (request.maturity !== undefined && !DOCUMENT_MATURITY_SET.has(request.maturity)) {
        throw new ProductDocumentRequestError('maturity must be exploratory, working, alignment, or publication.');
      }
      if (request.steMode !== undefined && !STE_MODES.has(request.steMode)) {
        throw new ProductDocumentRequestError('steMode must be off, advisory, enforced_sections, or enforced_full.');
      }
      const parent = request.parentArtifactId
        ? dependencies.store?.get(request.parentArtifactId) ?? null
        : null;
      if (request.parentArtifactId && !parent) {
        throw new ProductDocumentRequestError('The artifact being revised does not exist. Omit parentArtifactId for a new document or use an artifactId from the Documents list.');
      }
      // Citations: bounded normalization, never a gate. Malformed entries are
      // dropped rather than rejected — a missing annotation must not lose a
      // document.
      const citations: DocumentCitation[] = Array.isArray(request.citations)
        ? request.citations
          .filter((entry): entry is DocumentCitation => isRecord(entry)
            && typeof entry.id === 'string' && /^[A-Za-z0-9_-]{1,20}$/.test(entry.id)
            && typeof entry.label === 'string' && entry.label.trim().length > 0)
          .slice(0, 50)
          .map((entry) => ({
            id: entry.id,
            label: entry.label.trim().slice(0, 300),
            ...(typeof entry.source === 'string' && entry.source.trim() ? { source: entry.source.trim().slice(0, 40) } : {}),
            ...(typeof entry.date === 'string' && entry.date.trim() ? { date: entry.date.trim().slice(0, 40) } : {}),
            ...(typeof entry.quote === 'string' && entry.quote.trim() ? { quote: entry.quote.trim().slice(0, 500) } : {}),
            ...(typeof entry.workItemId === 'string' && entry.workItemId.trim() ? { workItemId: entry.workItemId.trim().slice(0, 100) } : {}),
            ...(typeof entry.url === 'string' && /^https?:\/\//i.test(entry.url.trim()) ? { url: entry.url.trim().slice(0, 500) } : {}),
          }))
        : [];
      const profileId = (typeof request.profileId === 'string' && request.profileId.trim())
        || parent?.profileId
        || 'business_document/adaptive.v1';
      const profile = dependencies.registry.getProfile(profileId);
      const maturity = request.maturity ?? parent?.maturity ?? 'working';
      const title = request.title?.trim() || parent?.title || '';
      if (!title) throw new ProductDocumentRequestError('title is required for a new document.');
      const steMode = request.steMode ?? 'advisory';
      const createdAt = now();

      // ── Post-authoring conformance review (owner request 2026-08-20) ──
      // One maximum-reasoning model pass re-sends the profile's complete
      // writing guide (section contract, narrative/style overlays, maturity
      // guidance) together with the authored document and audits adherence.
      // The reviewer may return one corrected complete document; it is applied
      // only when it passes the safety guards below. Advisory by design:
      // review failure or deviations NEVER block, reject, or loop the save.
      let finalContent = request.content;
      let conformanceReview: DocumentConformanceReview = {
        status: 'unavailable',
        findings: [],
        correctionApplied: false,
        checkedAt: createdAt.toISOString(),
      };
      if (dependencies.llmClient.isAvailable() && request.content.length <= 120_000) {
        try {
          const guide = authoringGuideFor(profile.profile_id, steMode, maturity);
          // A full corrected document must fit the completion budget with the
          // findings JSON around it; beyond this size, review findings-only.
          const correctionEligible = request.content.length <= 40_000;
          const reviewBudget = Math.max(
            2_048,
            Math.min(MAX_GENERATION_TOKENS, dependencies.llmClient.getMaxCompletionTokens?.() ?? 8_192),
          );
          const response = await dependencies.llmClient.chatCompletion({
            messages: [
              {
                role: 'system',
                content: 'You are BotBoy\'s document conformance reviewer. You audit a finished document against its writing guide with maximum care. You never invent facts, never add content the author did not supply, and never remove substantive detail (inventories, tables, requirements, decisions, metrics). Output only the requested JSON object.',
              },
              {
                role: 'user',
                content: [
                  '## Writing guide for this document type',
                  guide,
                  '',
                  '## Authored document under review',
                  `Title: ${title}`,
                  '<document_markdown>',
                  request.content,
                  '</document_markdown>',
                  '',
                  '## Review task',
                  'Audit the document against the writing guide: ordered section contract, structure, narrative and writing style, tone, and maturity-appropriate completeness.',
                  'Attribution register: provenance narration in body prose ("the thread says", "the email indicates", "per the captured analysis") is a style deviation; inline citation markers such as [c1] with citation metadata are the correct form. Citation markers in the text are expected and are not errors.',
                  `Apply the guide's "Publication blockers" list only when the document maturity is publication. This document's maturity is ${maturity}${maturity === 'publication' ? '' : ', so report blocker-list items as notes, not deviations'}.`,
                  'Return exactly one JSON object with these fields:',
                  '- conformant: boolean — true when the document follows the guide with at most cosmetic differences.',
                  '- summary: one or two sentences on overall adherence.',
                  '- findings: array of {aspect, severity, message}. aspect is one of structure|section_contract|style|narrative|completeness|other; severity is "note" or "deviation". Report real deviations only; an intentionally adapted section order that serves the audience is a note, not a deviation.',
                  correctionEligible
                    ? '- correctedContent: OPTIONAL. Only when deviations exist AND you can fix them without losing ANY substantive content: the complete corrected Markdown document. Preserve every fact, table row, requirement, decision, and detail exactly; correct only structure, headings, ordering, phrasing, and style. Omit this field when the document is conformant or a safe complete correction is not possible.'
                    : '- Do NOT return correctedContent for this document; report findings only.',
                ].join('\n'),
              },
            ],
            temperature: 0.1,
            maxTokens: reviewBudget,
            responseFormat: { type: 'json_object' },
            think: true,
            reasoningEffort: 'max',
          });
          const raw = response.content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
          const start = raw.indexOf('{');
          const end = raw.lastIndexOf('}');
          if (start < 0 || end <= start) throw new Error('Reviewer returned no JSON object.');
          const parsed = JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
          const findings: DocumentConformanceFinding[] = Array.isArray(parsed.findings)
            ? parsed.findings
              .filter((entry): entry is Record<string, unknown> => isRecord(entry) && typeof entry.message === 'string')
              .slice(0, 30)
              .map((entry) => ({
                aspect: typeof entry.aspect === 'string' ? entry.aspect.slice(0, 40) : 'other',
                severity: entry.severity === 'deviation' ? 'deviation' : 'note',
                message: (entry.message as string).slice(0, 1_000),
              }))
            : [];
          const summary = typeof parsed.summary === 'string' ? parsed.summary.slice(0, 1_000) : undefined;
          // Correction safety guards: complete string, meaningfully different,
          // and within honest size bounds of the original — a "correction"
          // that halves the document lost substance and is refused.
          const corrected = correctionEligible
            && response.finishReason !== 'length'
            && typeof parsed.correctedContent === 'string'
            && parsed.correctedContent.trim().length >= Math.floor(request.content.length * 0.7)
            && parsed.correctedContent.length <= Math.ceil(request.content.length * 1.5)
            && parsed.correctedContent.trim() !== request.content.trim()
            ? parsed.correctedContent
            : undefined;
          if (corrected) finalContent = corrected;
          conformanceReview = {
            status: corrected
              ? 'corrected'
              : parsed.conformant === true || findings.every((finding) => finding.severity !== 'deviation')
                ? 'conformant'
                : 'deviations_noted',
            findings,
            ...(summary ? { summary } : {}),
            correctionApplied: corrected !== undefined,
            checkedAt: now().toISOString(),
            model: dependencies.llmClient.getActiveModel?.(),
          };
        } catch (error) {
          conformanceReview = {
            status: 'unavailable',
            findings: [{
              aspect: 'other',
              severity: 'note',
              message: `Conformance review did not run: ${error instanceof Error ? error.message.slice(0, 300) : 'unknown error'}. The document was saved as authored.`,
            }],
            correctionApplied: false,
            checkedAt: now().toISOString(),
          };
        }
      }

      // Context manifest + glossary keep the artifact record shape consistent
      // with generated versions. A revision inherits the parent's; a fresh
      // save resolves the live writing context (deterministic, no model call).
      let contextManifest: ProductDocumentArtifact['context'];
      let glossary: ProductDocumentArtifact['glossary'];
      try {
        const resolution = await resolveContext(undefined, true);
        contextManifest = contextManifestOnly(resolution);
        glossary = dependencies.glossaryResolver.resolve({
          prompt: title,
          context: resolution,
          documentText: finalContent,
        });
      } catch (error) {
        if (!parent) throw error;
        contextManifest = parent.context;
        glossary = parent.glossary;
      }

      // Deterministic validation runs on the FINAL text (post-correction).
      let validation: DocumentValidationResult;
      try {
        validation = dependencies.validator.validate({
          profileId: profile.profile_id,
          title,
          content: finalContent,
          steMode,
          maturity,
        });
      } catch {
        validation = {
          status: 'not_checked',
          profile: { status: 'not_checked', findings: [] },
          evidence: { status: 'not_checked', findings: [] },
          writing: { status: 'not_checked', findings: [] },
          glossary: { status: 'not_checked', findings: [] },
          ste: { status: 'not_checked', findings: [] },
          findings: [],
          checkedAt: createdAt.toISOString(),
          checkerVersion: STE_CHECKER_VERSION,
          conformanceStatement: 'Chat-authored document persisted without validation; no conformance claim is made.',
        };
      }
      return saveArtifact({
        artifactId: createArtifactId(),
        // Advisory-only by design: findings inform review, never gate it.
        state: 'ready_for_review',
        profileId: profile.profile_id,
        profileVersion: profile.version,
        overlayVersions: overlayVersions(dependencies, profile.profile_id),
        maturity,
        title,
        content: finalContent,
        assumptions: [],
        openQuestions: [],
        claims: [],
        omittedSourceUnits: [],
        sourceCoverage: sourceCoverageSummary({ units: [], truncated: false }, [], []),
        context: contextManifest,
        glossary,
        validation,
        model: dependencies.llmClient.getActiveModel?.(),
        checkerVersion: validation.checkerVersion,
        createdAt: createdAt.toISOString(),
        emailSendApprovalRequired: profile.family === 'communication',
        ...(citations.length > 0 ? { citations } : {}),
        conformanceReview,
        ...(parent ? { parentArtifactId: parent.artifactId } : {}),
        revisionOrigin: 'chat_authored',
      });
    },
  };
}
