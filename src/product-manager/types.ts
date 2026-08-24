import type Database from 'better-sqlite3';
import type { DocumentParser } from '../core/document-parser.js';
import type { LlmClient } from '../core/llm-client.js';
import type { PromptManager } from '../core/prompt-manager.js';

export const PRODUCT_DOCUMENT_FAMILIES = [
  'operating_plan',
  'business_document',
  'prd',
  'prd_artifact',
  'communication',
] as const;

export type ProductDocumentFamily = (typeof PRODUCT_DOCUMENT_FAMILIES)[number];
export type ProfileSectionRequirement = 'mandatory' | 'conditional' | 'prohibited';
export type SourceAuthority = 'source_reference' | 'amazon_tier_a' | 'amazon_tier_b' | 'official_standard';
export type OverlayType = 'writing' | 'language' | 'module';
export type SteEnforcementMode = 'off' | 'advisory' | 'enforced_sections' | 'enforced_full';
export const DOCUMENT_MATURITIES = ['exploratory', 'working', 'alignment', 'publication'] as const;
export type DocumentMaturity = (typeof DOCUMENT_MATURITIES)[number];
export type DocumentPlanLength = 'brief' | 'standard' | 'detailed';
export type DocumentEvidenceReadiness = 'minimal' | 'partial' | 'sufficient';
export type ArtifactState = 'blocked_for_context' | 'blocked_validation' | 'draft_review' | 'ready_for_review';
export type ValidationStatus = 'pass' | 'pass_with_advisories' | 'blocked' | 'not_checked';
export type FindingSeverity = 'info' | 'warning' | 'error' | 'block';

/**
 * Model-inferred writing guidance. This metadata can shape presentation, but it
 * is never evidence or authority for facts, owners, dates, approvals, or
 * commitments.
 */
export interface DocumentAuthoringPlan {
  audience: string[];
  purpose: string;
  format: string;
  style: string;
  length: DocumentPlanLength;
  outline: string[];
  evidenceReadiness: DocumentEvidenceReadiness;
  evidenceGaps: string[];
  selectionRationale?: string;
}

export interface SourceManifestEntry {
  source_id: string;
  authority: SourceAuthority;
  fingerprint?: string;
  reference?: string;
}

export interface ProfileSection {
  section_id: string;
  title: string;
  requirement: ProfileSectionRequirement;
  purpose: string;
}

export interface DocumentProfile {
  schema_version: 'document-profile.v1';
  profile_id: string;
  version: string;
  family: ProductDocumentFamily;
  variant: string;
  purpose: string;
  audience: string[];
  required_inputs: string[];
  ordered_sections: ProfileSection[];
  narrative_rules: string[];
  evidence_rules: string[];
  terminology_rules: string[];
  formatting_rules: string[];
  overlays: string[];
  conditional_modules: string[];
  hard_fail_rules: string[];
  rubric_id: string;
  source_manifest: SourceManifestEntry[];
}

export interface WritingOverlay {
  schema_version: 'writing-overlay.v1';
  overlay_id: string;
  version: string;
  overlay_type: OverlayType;
  purpose: string;
  rules: string[];
  hard_fail_rules: string[];
  source_manifest: SourceManifestEntry[];
}

export interface RubricCategory {
  category_id: string;
  title: string;
  weight: number;
}

export interface DocumentRubric {
  rubric_id: string;
  weight_total: number;
  categories: RubricCategory[];
}

export interface DocumentRubricSet {
  schema_version: 'document-rubric-set.v1';
  rubric_set_id: string;
  version: string;
  publication_policy: {
    minimum_total_score: number;
    minimum_category_percent: number;
    hard_failures_allowed: number;
  };
  rubrics: DocumentRubric[];
}

export interface ProductProfileSummary {
  profileId: string;
  version: string;
  family: ProductDocumentFamily;
  variant: string;
  purpose: string;
  requiredInputs: string[];
}

export interface ProfileRegistry {
  listProfiles(): ProductProfileSummary[];
  listOverlays(): Array<{ overlayId: string; version: string; type: OverlayType; purpose: string }>;
  getProfile(profileId: string): DocumentProfile;
  getOverlay(overlayId: string): WritingOverlay;
  getRubric(rubricId: string): DocumentRubric;
  buildWritingInstructions(
    profileId: string,
    steMode: SteEnforcementMode,
    maturity?: DocumentMaturity,
    authoringPlan?: DocumentAuthoringPlan,
  ): string;
}

export interface ContextDirectory {
  path: string;
  recursive: boolean;
  enabled: boolean;
  includeGlobs: string[];
  excludeGlobs: string[];
}

export interface WritingContextLimits {
  maxFiles: number;
  maxFileBytes: number;
  maxTotalCharacters: number;
}

export interface WritingContextConfig {
  schemaVersion: 'writing-context.v1';
  overviewFile?: string;
  productDocDirectories: ContextDirectory[];
  technicalDocDirectories: ContextDirectory[];
  domainDocDirectories: ContextDirectory[];
  glossaryFiles: string[];
  limits: WritingContextLimits;
}

export type WritingContextConfigOverride = Partial<Omit<WritingContextConfig, 'schemaVersion'>>;

export interface ConfigValidationIssue {
  field: string;
  message: string;
}

export type WritingConfigResult =
  | { ok: true; config: WritingContextConfig }
  | { ok: false; issues: ConfigValidationIssue[] };

export interface WritingConfigStore {
  get(): WritingContextConfig;
  validate(input: unknown): WritingConfigResult;
  set(input: unknown): WritingConfigResult;
  resolveOverride(override?: WritingContextConfigOverride): WritingConfigResult;
}

export interface WritingConfigStoreDependencies {
  db: Database.Database;
  homeDir?: string;
}

export type ContextRole = 'overview' | 'product' | 'technical' | 'domain' | 'glossary';
export type ContextParseStatus = 'read' | 'parsed' | 'skipped' | 'error';
export type ContextResolutionStatus = 'ready' | 'prompt_only' | 'blocked_for_context' | 'assumption_draft';

export interface ContextManifestEntry {
  role: ContextRole;
  path: string;
  sha256?: string;
  bytes?: number;
  modifiedAt?: string;
  parseStatus: ContextParseStatus;
  diagnostic?: string;
}

export interface ResolvedContextDocument {
  role: ContextRole;
  path: string;
  content: string;
  sha256: string;
  bytes: number;
  modifiedAt: string;
  parseStatus: 'read' | 'parsed';
}

export interface ContextResolution {
  status: ContextResolutionStatus;
  overviewAvailable: boolean;
  documents: ResolvedContextDocument[];
  manifest: ContextManifestEntry[];
  diagnostics: string[];
  totalCharacters: number;
}

export interface ContextResolver {
  resolve(config: WritingContextConfig, options?: { allowAssumptionDraft?: boolean }): Promise<ContextResolution>;
  formatForPrompt(resolution: ContextResolution): string;
}

export interface ContextResolverDependencies {
  documentParser: DocumentParser;
  homeDir?: string;
}

export type GlossaryTermType = 'technical_noun' | 'technical_verb';
export type GlossaryApprovalState =
  | 'unapproved'
  | 'candidate_context'
  | 'candidate_prompt'
  | 'candidate_document'
  | 'approved'
  | 'exception'
  | 'ste_approved';

export interface GlossaryProvenance {
  sourceType: 'explicit_glossary' | 'overview' | 'product_context' | 'technical_context' | 'domain_context' | 'prompt' | 'document' | 'ste_dictionary';
  source: string;
}

export interface GlossaryEntry {
  term: string;
  normalizedTerm: string;
  termType: GlossaryTermType;
  approvedDefinition?: string;
  approvedForms: string[];
  partOfSpeech?: string;
  subjectField?: string;
  allowedContexts: string[];
  prohibitedSynonyms: string[];
  owner?: string;
  approvalState: GlossaryApprovalState;
  version?: string;
  reviewDate?: string;
  provenance: GlossaryProvenance[];
}

export interface GlossaryConflict {
  term: string;
  kept: GlossaryEntry;
  rejected: GlossaryEntry;
  reason: string;
}

export interface GlossaryResolution {
  entries: GlossaryEntry[];
  approvedTerms: GlossaryEntry[];
  candidateTerms: GlossaryEntry[];
  conflicts: GlossaryConflict[];
  diagnostics: string[];
}

export interface GlossaryResolutionRequest {
  prompt: string;
  context: ContextResolution;
  documentText?: string;
  steEntries?: GlossaryEntry[];
}

export interface GlossaryResolver {
  resolve(request: GlossaryResolutionRequest): GlossaryResolution;
  formatForPrompt(resolution: GlossaryResolution): string;
}

export type SteSegmentClass =
  | 'heading'
  | 'descriptive_prose'
  | 'procedural_instruction'
  | 'safety_instruction'
  | 'requirement'
  | 'acceptance_criterion'
  | 'table_cell'
  | 'label'
  | 'code'
  | 'identifier'
  | 'citation'
  | 'quoted_source'
  | 'proper_name'
  | 'unit_or_measure';

export interface SteDictionaryEntry {
  entryId?: string;
  term: string;
  normalizedTerm: string;
  approved: boolean;
  approvedMeanings?: string[];
  partOfSpeech?: string[];
  forms?: string[];
  alternatives?: string[];
  ruleReference?: string;
  page?: number;
}

export interface SteRuleIndexEntry {
  ruleId: string;
  section: string;
  page?: number;
  title?: string;
  applicability?: SteSegmentClass[];
}

export interface SteStandardBundle {
  schemaVersion: 'asd-ste100-bundle.v1';
  standardId: 'ASD-STE100';
  issue: 9;
  issueDate: '2025-01-15';
  sourceSha256: string;
  sourceLocation?: string;
  extractedAt: string;
  extractorVersion: string;
  inventory: {
    rules: number;
    generalRecommendations: number;
    approvedWords: number;
    nonApprovedEntries: number;
    extractedDictionaryRecords?: number;
    extractedApprovedRecords?: number;
    extractedNonApprovedRecords?: number;
  };
  rules: SteRuleIndexEntry[];
  dictionary: SteDictionaryEntry[];
  diagnostics: string[];
  humanApproval: {
    status: 'pending' | 'approved' | 'rejected';
    reviewer?: string;
    reviewedAt?: string;
    note?: string;
  };
}

export interface SteBundleReadiness {
  ready: boolean;
  available: boolean;
  approved: boolean;
  path: string;
  bundle?: SteStandardBundle;
  diagnostics: string[];
}

export interface SteBundleLoader {
  load(): SteBundleReadiness;
}

export interface SteBundleLoaderOptions {
  bundlePath?: string;
  homeDir?: string;
  expectedSourceSha256?: string;
}

export interface SteCheckRequest {
  content: string;
  mode: SteEnforcementMode;
  glossary?: GlossaryResolution;
  bundleReadiness?: SteBundleReadiness;
  enforcedSegmentClasses?: SteSegmentClass[];
}

export interface SteCheckResult extends ValidationGroupResult {
  checkerVersion: string;
  conformanceStatement: string;
  protectedSegmentCount: number;
  checkedSegmentCount: number;
}

export interface SteChecker {
  check(request: SteCheckRequest): SteCheckResult;
}

export interface TextLocation {
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
  startOffset: number;
  endOffset: number;
}

export type SourceEvidencePriority = 'required' | 'review';
export type SourceEvidenceType = 'context' | 'user_input' | 'discovery';

/**
 * One server-captured research result from the current chat turn(s): the
 * exact content a read tool returned while the model investigated the
 * owner's request. Captured by the server-side tool loop — never authored by
 * the model — and indexed as citable review-priority evidence so a draft can
 * ground itself in what was actually found.
 */
export interface DiscoveredEvidenceItem {
  /** Tool that produced the content, e.g. query_db, read_file, run_command. */
  tool: string;
  /** Bounded rendering of the tool arguments, for provenance display. */
  request: string;
  /** Exact bounded tool result content as returned by the server. */
  content: string;
}

export interface SourceEvidenceUnit {
  unitId: string;
  sourceReference: string;
  sourceType: SourceEvidenceType;
  section?: string;
  text: string;
  priority: SourceEvidencePriority;
  anchors: string[];
}

export interface SourceEvidenceIndex {
  units: SourceEvidenceUnit[];
  truncated: boolean;
}

export interface OmittedSourceUnit {
  sourceUnitId: string;
  reason: string;
}

export interface SourceCoverageSummary {
  sourceIndexFingerprint: string;
  indexedUnits: number;
  requiredUnits: number;
  coveredUnits: number;
  omittedUnits: number;
  missingRequiredUnitIds: string[];
  undispositionedUnitIds: string[];
  indexTruncated: boolean;
}

export interface DocumentFinding {
  code: string;
  category: 'profile' | 'evidence' | 'writing' | 'glossary' | 'ste' | 'context' | 'email';
  severity: FindingSeverity;
  message: string;
  location?: TextLocation;
  segmentClass?: SteSegmentClass;
  ruleReference?: string;
  suggestion?: string;
  heuristic?: boolean;
  metadata?: Record<string, unknown>;
}

export interface ValidationGroupResult {
  status: ValidationStatus;
  findings: DocumentFinding[];
}

export interface DocumentValidationResult {
  status: ValidationStatus;
  profile: ValidationGroupResult;
  evidence: ValidationGroupResult;
  writing: ValidationGroupResult;
  glossary: ValidationGroupResult;
  ste: ValidationGroupResult;
  findings: DocumentFinding[];
  checkedAt: string;
  checkerVersion: string;
  conformanceStatement: string;
}

export interface DocumentValidator {
  validate(request: ValidateDocumentRequest): DocumentValidationResult;
}

export interface DocumentValidatorDependencies {
  registry: ProfileRegistry;
  steChecker: SteChecker;
  steBundleLoader: SteBundleLoader;
}

export interface EmailDraftMetadata {
  purposeType?: 'action_required' | 'decision_required' | 'information_only' | 'input_requested' | 'meeting_follow_up';
  sender?: string;
  toRecipients?: string[];
  ccRecipients?: string[];
  bccRecipients?: string[];
  sensitivity?: string;
  subject?: string;
  actions?: Array<{ action: string; owner?: string; deadline?: string }>;
  attachmentsOrLinks?: Array<{ label: string; value: string; reason?: string }>;
}

export type GeneratedClaimKind =
  | 'fact'
  | 'metric'
  | 'target'
  | 'mission'
  | 'vision'
  | 'recommendation'
  | 'decision'
  | 'decision_gate'
  | 'dependency'
  | 'requirement'
  | 'resource'
  | 'owner'
  | 'timing'
  | 'risk'
  | 'assumption'
  | 'other';

export type GeneratedClaimState =
  | 'actual'
  | 'proposed'
  | 'approved'
  | 'proposed_target'
  | 'approved_target'
  | 'forecast'
  | 'assumption'
  | 'commitment'
  | 'stated';

export interface GeneratedClaim {
  statement: string;
  kind: GeneratedClaimKind;
  state: GeneratedClaimState;
  sourceReferences: string[];
  sourceUnitIds: string[];
  contentEvidence: string;
  caveat?: string;
}

export interface ValidateDocumentRequest {
  profileId: string;
  content: string;
  steMode: SteEnforcementMode;
  maturity?: DocumentMaturity;
  inputs?: Record<string, unknown>;
  glossary?: GlossaryResolution;
  email?: EmailDraftMetadata;
  title?: string;
  assumptions?: string[];
  openQuestions?: string[];
  claims?: GeneratedClaim[];
  sourceEvidence?: SourceEvidenceIndex;
  omittedSourceUnits?: OmittedSourceUnit[];
}

export interface GenerateDocumentRequest {
  profileId: string;
  prompt: string;
  steMode?: SteEnforcementMode;
  maturity?: DocumentMaturity;
  authoringPlan?: DocumentAuthoringPlan;
  inputs?: Record<string, unknown>;
  contextOverride?: WritingContextConfigOverride;
  allowAssumptionDraft?: boolean;
  email?: EmailDraftMetadata;
  /**
   * Server-captured read-tool results from the requesting chat turn(s).
   * Supplied only by trusted server code (the chat/agent tool loops); the
   * public HTTP generate route strips it, and the guarded chat adapter
   * forwards only content the server itself observed.
   */
  discoveredEvidence?: DiscoveredEvidenceItem[];
  /**
   * Immutable version chain: the prior artifact this generation revises.
   * Supplied only by trusted server code (the pending-window regeneration
   * flow); stripped from public HTTP request bodies.
   */
  parentArtifactId?: string;
  /**
   * The prior version's actual text, loaded by the service itself from the
   * store when parentArtifactId resolves. Indexed as citable baseline
   * evidence so a revision preserves the document it revises instead of
   * shrinking to whatever the newest owner message mentions. Never accepted
   * from callers; the service overwrites it.
   */
  parentVersion?: { artifactId: string; title: string; content: string };
}

export interface ProductDocumentArtifact {
  artifactId: string;
  persisted: boolean;
  state: ArtifactState;
  profileId: string;
  profileVersion: string;
  overlayVersions: Record<string, string>;
  maturity: DocumentMaturity;
  authoringPlan?: DocumentAuthoringPlan;
  title: string;
  content: string;
  assumptions: string[];
  openQuestions: string[];
  claims: GeneratedClaim[];
  omittedSourceUnits: OmittedSourceUnit[];
  sourceCoverage: SourceCoverageSummary;
  context: Omit<ContextResolution, 'documents'>;
  glossary: GlossaryResolution;
  validation: DocumentValidationResult;
  model?: string;
  checkerVersion: string;
  createdAt: string;
  emailSendApprovalRequired: boolean;
  /** Evidence citations bound to inline [cN] markers in the content. */
  citations?: DocumentCitation[];
  /** Post-save conformance review for chat-authored documents (advisory). */
  conformanceReview?: DocumentConformanceReview;
  /** Immutable version chain: the artifact this one revises, when known. */
  parentArtifactId?: string;
  /** How this version came to exist. Absent means generated (pre-linkage artifacts). */
  revisionOrigin?: 'generated' | 'owner_edit' | 'chat_authored';
}

export interface ProductDocumentSummary {
  artifactId: string;
  state: ArtifactState;
  profileId: string;
  profileVersion: string;
  title: string;
  model?: string;
  checkerVersion: string;
  contentChars: number;
  validationStatus: ValidationStatus;
  createdAt: string;
  parentArtifactId?: string;
  revisionOrigin?: 'generated' | 'owner_edit' | 'chat_authored';
}

export interface DocumentConformanceFinding {
  /** What the finding is about: structure, section_contract, style, narrative, completeness, other. */
  aspect: string;
  severity: 'note' | 'deviation';
  message: string;
}

/**
 * Result of the post-save conformance review: a max-reasoning model pass that
 * re-reads the profile's writing guide against the authored document and
 * audits adherence. Advisory by design — it can apply one bounded correction
 * but never blocks, rejects, or loops a save.
 */
export interface DocumentConformanceReview {
  status: 'conformant' | 'corrected' | 'deviations_noted' | 'unavailable';
  findings: DocumentConformanceFinding[];
  summary?: string;
  /** True when the reviewer's corrected document replaced the authored content. */
  correctionApplied: boolean;
  checkedAt: string;
  model?: string;
}

export interface DocumentWritingGuide {
  profileId: string;
  family: ProductDocumentFamily;
  purpose: string;
  /** Complete authoring guidance: section contract, maturity instruction, style/narrative overlays. */
  guide: string;
  /** All available profiles so the caller can pick the right type in one round trip. */
  profiles: ProductProfileSummary[];
}

/**
 * One evidence citation authored with the document. The document body carries
 * inline markers like [c1]; the UI renders them as annotation chips with this
 * metadata, keeping provenance OUT of the prose register.
 */
export interface DocumentCitation {
  /** Marker id used inline in the markdown, e.g. "c1". */
  id: string;
  /** Short human label, e.g. "PVD IN AVOD email thread — Pradip Thakker reply". */
  label: string;
  /** Source kind: email, slack, file, web, db, chat, other. Free-form, bounded. */
  source?: string;
  /** ISO date of the underlying evidence, when known. */
  date?: string;
  /** Short verbatim quote from the evidence supporting the cited statement. */
  quote?: string;
  /** Captured work-item ID in BotBoy, when the evidence is a captured item. */
  workItemId?: string;
  /** External URL when the evidence is a web page. */
  url?: string;
}

export interface SaveAuthoredDocumentRequest {
  /** Document title; required for new documents, defaults to the parent title on revisions. */
  title?: string;
  /** Complete authored Markdown content. */
  content: string;
  /** Lifecycle maturity; defaults to working (or the parent's maturity on revisions). */
  maturity?: DocumentMaturity;
  /** Profile whose advisory validation guidance applies; defaults to business_document/adaptive.v1. */
  profileId?: string;
  /** Language-check mode for advisory validation; defaults to advisory. Findings never block a save. */
  steMode?: SteEnforcementMode;
  /** Evidence citations matching inline [cN] markers in the content. */
  citations?: DocumentCitation[];
  /** Optional immutable version chain: the artifact this save revises. */
  parentArtifactId?: string;
}

export interface OwnerRevisionRequest {
  /** Artifact being revised; must exist in the store. */
  parentArtifactId: string;
  /** Complete owner-authored Markdown replacing the parent content. */
  content: string;
  /** Optional replacement title; defaults to the parent title. */
  title?: string;
}

export interface ProductDocumentStore {
  save(artifact: ProductDocumentArtifact): void;
  list(limit: number): ProductDocumentSummary[];
  get(artifactId: string): ProductDocumentArtifact | null;
  /**
   * Permanently delete one artifact. Children of the deleted version are
   * re-linked to its parent so the chain stays connected. Returns false when
   * the artifact does not exist.
   */
  remove(artifactId: string): boolean;
}

export interface ProductDocumentService {
  listProfiles(): ProductProfileSummary[];
  listOverlays(): Array<{ overlayId: string; version: string; type: OverlayType; purpose: string }>;
  listArtifacts(limit: number): ProductDocumentSummary[];
  getArtifact(artifactId: string): ProductDocumentArtifact | null;
  /** Permanently delete one artifact version; false when it does not exist. */
  deleteArtifact(artifactId: string): boolean;
  getSteBundleReadiness(): SteBundleReadiness;
  previewContext(override?: WritingContextConfigOverride, allowAssumptionDraft?: boolean): Promise<ContextResolution>;
  previewGlossary(request: { prompt: string; contextOverride?: WritingContextConfigOverride; documentText?: string }): Promise<GlossaryResolution>;
  validate(request: ValidateDocumentRequest): Promise<DocumentValidationResult>;
  generate(request: GenerateDocumentRequest): Promise<ProductDocumentArtifact>;
  /**
   * Persist a complete owner-authored revision of an existing artifact as a
   * new immutable version. The owner is the authority for their own words:
   * no model call runs, validation is informational, and the result is always
   * a usable draft_review artifact linked to its parent.
   */
  ownerRevision(request: OwnerRevisionRequest): Promise<ProductDocumentArtifact>;
  /**
   * Persist complete chat-authored Markdown as an immutable versioned
   * artifact. The authoring model is the writer: no second model call, no
   * authoring-plan/claims/owner-input gates. Validation runs advisory-only —
   * findings are recorded on the artifact but never block the save.
   */
  saveAuthoredDocument(request: SaveAuthoredDocumentRequest): Promise<ProductDocumentArtifact>;
  /**
   * Read-only authoring guidance for one document type: the same per-profile
   * structure/style/narrative instructions the retired two-pass writer
   * received, now fetchable by the chat model BEFORE it writes.
   */
  getWritingGuide(profileId?: string, maturity?: DocumentMaturity): DocumentWritingGuide;
}

export interface ProductDocumentServiceDependencies {
  llmClient: LlmClient;
  promptManager: PromptManager;
  registry: ProfileRegistry;
  configStore: WritingConfigStore;
  contextResolver: ContextResolver;
  glossaryResolver: GlossaryResolver;
  validator: DocumentValidator;
  steBundleLoader: SteBundleLoader;
  store?: ProductDocumentStore;
  now?: () => Date;
  createArtifactId?: () => string;
}
