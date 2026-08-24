import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  PRODUCT_DOCUMENT_FAMILIES,
  type DocumentAuthoringPlan,
  type DocumentMaturity,
  type DocumentProfile,
  type DocumentRubric,
  type DocumentRubricSet,
  type OverlayType,
  type ProductDocumentFamily,
  type ProfileRegistry,
  type ProfileSection,
  type ProfileSectionRequirement,
  type SourceAuthority,
  type SourceManifestEntry,
  type SteEnforcementMode,
  type WritingOverlay,
} from './types.js';

const SEMVER = /^\d+\.\d+\.\d+$/;
const PROFILE_SECTION_REQUIREMENTS = new Set<ProfileSectionRequirement>(['mandatory', 'conditional', 'prohibited']);
const SOURCE_AUTHORITIES = new Set<SourceAuthority>(['source_reference', 'amazon_tier_a', 'amazon_tier_b', 'official_standard']);
const OVERLAY_TYPES = new Set<OverlayType>(['writing', 'language', 'module']);
const FAMILY_SET = new Set<ProductDocumentFamily>(PRODUCT_DOCUMENT_FAMILIES);
const REQUIRED_CORE_PROFILE_VERSIONS = new Map<string, string>([
  ['op_roadmap_vision.v1', '1.0.0'],
  ['business_document/business_decision.v1', '1.0.0'],
  ['business_document/adaptive.v1', '1.0.0'],
  ['business_document/feature_workshop.v1', '1.0.0'],
  ['prd/feature_experiment.v1', '1.0.0'],
  ['prd/new_product_mvp.v1', '1.0.0'],
  ['prd/phase_iteration.v1', '1.0.0'],
  ['user_stories_workbook.v1', '1.0.0'],
  ['communication/email.v1', '1.0.0'],
]);

function fail(asset: string, field: string, message: string): never {
  throw new Error(`[product-manager] Invalid ${asset} at ${field}: ${message}`);
}

function record(value: unknown, asset: string, field = '$'): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(asset, field, 'expected an object');
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, asset: string, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    fail(asset, field, 'expected a non-empty string');
  }
  return value.trim();
}

function numberValue(value: unknown, asset: string, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    fail(asset, field, 'expected a finite number');
  }
  return value;
}

function stringArray(value: unknown, asset: string, field: string, allowEmpty = true): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string' || entry.trim().length === 0)) {
    fail(asset, field, 'expected an array of non-empty strings');
  }
  if (!allowEmpty && value.length === 0) fail(asset, field, 'must contain at least one value');
  return value.map((entry) => entry.trim());
}

function sourceManifest(value: unknown, asset: string, field: string): SourceManifestEntry[] {
  if (!Array.isArray(value) || value.length === 0) fail(asset, field, 'must contain at least one source');
  return value.map((item, index) => {
    const row = record(item, asset, `${field}[${index}]`);
    const authority = text(row.authority, asset, `${field}[${index}].authority`) as SourceAuthority;
    if (!SOURCE_AUTHORITIES.has(authority)) fail(asset, `${field}[${index}].authority`, `unsupported authority ${authority}`);
    const parsed: SourceManifestEntry = {
      source_id: text(row.source_id, asset, `${field}[${index}].source_id`),
      authority,
    };
    if (row.fingerprint !== undefined) parsed.fingerprint = text(row.fingerprint, asset, `${field}[${index}].fingerprint`);
    if (row.reference !== undefined) parsed.reference = text(row.reference, asset, `${field}[${index}].reference`);
    return parsed;
  });
}

function parseSection(value: unknown, asset: string, index: number): ProfileSection {
  const row = record(value, asset, `ordered_sections[${index}]`);
  const requirement = text(row.requirement, asset, `ordered_sections[${index}].requirement`) as ProfileSectionRequirement;
  if (!PROFILE_SECTION_REQUIREMENTS.has(requirement)) {
    fail(asset, `ordered_sections[${index}].requirement`, `unsupported value ${requirement}`);
  }
  return {
    section_id: text(row.section_id, asset, `ordered_sections[${index}].section_id`),
    title: text(row.title, asset, `ordered_sections[${index}].title`),
    requirement,
    purpose: text(row.purpose, asset, `ordered_sections[${index}].purpose`),
  };
}

function parseProfile(value: unknown, asset: string): DocumentProfile {
  const row = record(value, asset);
  if (row.schema_version !== 'document-profile.v1') fail(asset, 'schema_version', 'expected document-profile.v1');
  const family = text(row.family, asset, 'family') as ProductDocumentFamily;
  if (!FAMILY_SET.has(family)) fail(asset, 'family', `unsupported family ${family}`);
  const version = text(row.version, asset, 'version');
  if (!SEMVER.test(version)) fail(asset, 'version', 'expected semantic version x.y.z');
  if (!Array.isArray(row.ordered_sections) || row.ordered_sections.length === 0) {
    fail(asset, 'ordered_sections', 'must contain at least one section');
  }
  const sections = row.ordered_sections.map((section, index) => parseSection(section, asset, index));
  const sectionIds = new Set<string>();
  for (const section of sections) {
    if (sectionIds.has(section.section_id)) fail(asset, 'ordered_sections', `duplicate section_id ${section.section_id}`);
    sectionIds.add(section.section_id);
  }
  return {
    schema_version: 'document-profile.v1',
    profile_id: text(row.profile_id, asset, 'profile_id'),
    version,
    family,
    variant: text(row.variant, asset, 'variant'),
    purpose: text(row.purpose, asset, 'purpose'),
    audience: stringArray(row.audience, asset, 'audience', false),
    required_inputs: stringArray(row.required_inputs, asset, 'required_inputs'),
    ordered_sections: sections,
    narrative_rules: stringArray(row.narrative_rules, asset, 'narrative_rules', false),
    evidence_rules: stringArray(row.evidence_rules, asset, 'evidence_rules', false),
    terminology_rules: stringArray(row.terminology_rules, asset, 'terminology_rules', false),
    formatting_rules: stringArray(row.formatting_rules, asset, 'formatting_rules', false),
    overlays: stringArray(row.overlays, asset, 'overlays', false),
    conditional_modules: stringArray(row.conditional_modules, asset, 'conditional_modules'),
    hard_fail_rules: stringArray(row.hard_fail_rules, asset, 'hard_fail_rules', false),
    rubric_id: text(row.rubric_id, asset, 'rubric_id'),
    source_manifest: sourceManifest(row.source_manifest, asset, 'source_manifest'),
  };
}

function parseOverlay(value: unknown, asset: string): WritingOverlay {
  const row = record(value, asset);
  if (row.schema_version !== 'writing-overlay.v1') fail(asset, 'schema_version', 'expected writing-overlay.v1');
  const overlayType = text(row.overlay_type, asset, 'overlay_type') as OverlayType;
  if (!OVERLAY_TYPES.has(overlayType)) fail(asset, 'overlay_type', `unsupported type ${overlayType}`);
  const version = text(row.version, asset, 'version');
  if (!SEMVER.test(version)) fail(asset, 'version', 'expected semantic version x.y.z');
  return {
    schema_version: 'writing-overlay.v1',
    overlay_id: text(row.overlay_id, asset, 'overlay_id'),
    version,
    overlay_type: overlayType,
    purpose: text(row.purpose, asset, 'purpose'),
    rules: stringArray(row.rules, asset, 'rules', false),
    hard_fail_rules: stringArray(row.hard_fail_rules, asset, 'hard_fail_rules', false),
    source_manifest: sourceManifest(row.source_manifest, asset, 'source_manifest'),
  };
}

function parseRubricSet(value: unknown, asset: string): DocumentRubricSet {
  const row = record(value, asset);
  if (row.schema_version !== 'document-rubric-set.v1') fail(asset, 'schema_version', 'expected document-rubric-set.v1');
  const version = text(row.version, asset, 'version');
  if (!SEMVER.test(version)) fail(asset, 'version', 'expected semantic version x.y.z');
  const policy = record(row.publication_policy, asset, 'publication_policy');
  if (!Array.isArray(row.rubrics) || row.rubrics.length === 0) fail(asset, 'rubrics', 'must contain at least one rubric');
  const rubrics: DocumentRubric[] = row.rubrics.map((rubricValue, rubricIndex) => {
    const rubric = record(rubricValue, asset, `rubrics[${rubricIndex}]`);
    if (!Array.isArray(rubric.categories) || rubric.categories.length === 0) {
      fail(asset, `rubrics[${rubricIndex}].categories`, 'must contain categories');
    }
    const categories = rubric.categories.map((categoryValue, categoryIndex) => {
      const category = record(categoryValue, asset, `rubrics[${rubricIndex}].categories[${categoryIndex}]`);
      return {
        category_id: text(category.category_id, asset, `rubrics[${rubricIndex}].categories[${categoryIndex}].category_id`),
        title: text(category.title, asset, `rubrics[${rubricIndex}].categories[${categoryIndex}].title`),
        weight: numberValue(category.weight, asset, `rubrics[${rubricIndex}].categories[${categoryIndex}].weight`),
      };
    });
    const weightTotal = numberValue(rubric.weight_total, asset, `rubrics[${rubricIndex}].weight_total`);
    const calculated = categories.reduce((sum, category) => sum + category.weight, 0);
    if (weightTotal !== 100 || calculated !== 100) {
      fail(asset, `rubrics[${rubricIndex}]`, `weights must total 100 (declared ${weightTotal}, calculated ${calculated})`);
    }
    return {
      rubric_id: text(rubric.rubric_id, asset, `rubrics[${rubricIndex}].rubric_id`),
      weight_total: weightTotal,
      categories,
    };
  });
  return {
    schema_version: 'document-rubric-set.v1',
    rubric_set_id: text(row.rubric_set_id, asset, 'rubric_set_id'),
    version,
    publication_policy: {
      minimum_total_score: numberValue(policy.minimum_total_score, asset, 'publication_policy.minimum_total_score'),
      minimum_category_percent: numberValue(policy.minimum_category_percent, asset, 'publication_policy.minimum_category_percent'),
      hard_failures_allowed: numberValue(policy.hard_failures_allowed, asset, 'publication_policy.hard_failures_allowed'),
    },
    rubrics,
  };
}

function loadJsonDirectory(directory: string): Array<{ asset: string; value: unknown }> {
  if (!fs.existsSync(directory) || !fs.statSync(directory).isDirectory()) {
    throw new Error(`[product-manager] Runtime config directory is missing: ${directory}`);
  }
  return fs.readdirSync(directory)
    .filter((name) => name.endsWith('.json'))
    .sort((a, b) => a.localeCompare(b))
    .map((name) => {
      const assetPath = path.join(directory, name);
      try {
        return { asset: assetPath, value: JSON.parse(fs.readFileSync(assetPath, 'utf8')) as unknown };
      } catch (error) {
        throw new Error(`[product-manager] Cannot parse runtime asset ${assetPath}: ${(error as Error).message}`);
      }
    });
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function listRules(title: string, rules: string[]): string {
  return `## ${title}\n${rules.map((rule, index) => `${index + 1}. ${rule}`).join('\n')}`;
}

export function createProfileRegistry(options: { configDir?: string } = {}): ProfileRegistry {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const configDir = options.configDir ?? path.join(moduleDir, 'config');
  const profiles = new Map<string, DocumentProfile>();
  const overlays = new Map<string, WritingOverlay>();
  const rubrics = new Map<string, DocumentRubric>();

  for (const { asset, value } of loadJsonDirectory(path.join(configDir, 'profiles'))) {
    const profile = deepFreeze(parseProfile(value, asset));
    if (profiles.has(profile.profile_id)) fail(asset, 'profile_id', `duplicate ID ${profile.profile_id}`);
    profiles.set(profile.profile_id, profile);
  }
  for (const { asset, value } of loadJsonDirectory(path.join(configDir, 'overlays'))) {
    const overlay = deepFreeze(parseOverlay(value, asset));
    if (overlays.has(overlay.overlay_id) || profiles.has(overlay.overlay_id)) {
      fail(asset, 'overlay_id', `duplicate ID ${overlay.overlay_id}`);
    }
    overlays.set(overlay.overlay_id, overlay);
  }
  for (const { asset, value } of loadJsonDirectory(path.join(configDir, 'rubrics'))) {
    const set = parseRubricSet(value, asset);
    for (const rubric of set.rubrics) {
      if (rubrics.has(rubric.rubric_id)) fail(asset, 'rubrics', `duplicate rubric ID ${rubric.rubric_id}`);
      rubrics.set(rubric.rubric_id, deepFreeze(rubric));
    }
  }

  if (profiles.size === 0) throw new Error('[product-manager] At least one output profile is required.');
  const missingCoreProfiles: string[] = [];
  const incompatibleCoreProfiles: string[] = [];
  for (const [profileId, version] of REQUIRED_CORE_PROFILE_VERSIONS) {
    const profile = profiles.get(profileId);
    if (!profile) missingCoreProfiles.push(profileId);
    else if (profile.version !== version) incompatibleCoreProfiles.push(`${profileId} (expected ${version}, found ${profile.version})`);
  }
  if (missingCoreProfiles.length > 0 || incompatibleCoreProfiles.length > 0) {
    throw new Error([
      '[product-manager] Canonical profile catalog is incomplete or incompatible.',
      missingCoreProfiles.length ? `Missing: ${missingCoreProfiles.join(', ')}.` : '',
      incompatibleCoreProfiles.length ? `Version mismatch: ${incompatibleCoreProfiles.join(', ')}.` : '',
    ].filter(Boolean).join(' '));
  }
  for (const profile of profiles.values()) {
    for (const overlayId of profile.overlays) {
      if (!overlays.has(overlayId)) throw new Error(`[product-manager] Profile ${profile.profile_id} references missing overlay ${overlayId}`);
    }
    for (const moduleId of profile.conditional_modules.filter((id) => id.endsWith('.v1'))) {
      if (!overlays.has(moduleId)) throw new Error(`[product-manager] Profile ${profile.profile_id} references missing module ${moduleId}`);
    }
    if (!rubrics.has(profile.rubric_id)) throw new Error(`[product-manager] Profile ${profile.profile_id} references missing rubric ${profile.rubric_id}`);
  }

  function getProfile(profileId: string): DocumentProfile {
    const profile = profiles.get(profileId);
    if (!profile) throw new Error(`[product-manager] Unknown profile: ${profileId}`);
    return profile;
  }

  function getOverlay(overlayId: string): WritingOverlay {
    const overlay = overlays.get(overlayId);
    if (!overlay) throw new Error(`[product-manager] Unknown overlay: ${overlayId}`);
    return overlay;
  }

  function getRubric(rubricId: string): DocumentRubric {
    const rubric = rubrics.get(rubricId);
    if (!rubric) throw new Error(`[product-manager] Unknown rubric: ${rubricId}`);
    return rubric;
  }

  return {
    listProfiles: () => [...profiles.values()]
      .sort((a, b) => a.profile_id.localeCompare(b.profile_id))
      .map((profile) => ({
        profileId: profile.profile_id,
        version: profile.version,
        family: profile.family,
        variant: profile.variant,
        purpose: profile.purpose,
        requiredInputs: [...profile.required_inputs],
      })),
    listOverlays: () => [...overlays.values()]
      .sort((a, b) => a.overlay_id.localeCompare(b.overlay_id))
      .map((overlay) => ({
        overlayId: overlay.overlay_id,
        version: overlay.version,
        type: overlay.overlay_type,
        purpose: overlay.purpose,
      })),
    getProfile,
    getOverlay,
    getRubric,
    buildWritingInstructions(
      profileId: string,
      steMode: SteEnforcementMode,
      maturity: DocumentMaturity = 'publication',
      authoringPlan?: DocumentAuthoringPlan,
    ): string {
      const profile = getProfile(profileId);
      const selectedOverlays = profile.overlays.map(getOverlay);
      const selectedModules = profile.conditional_modules
        .filter((id) => id.endsWith('.v1') && overlays.has(id))
        .map(getOverlay);
      const sectionContract = profile.ordered_sections.map((section, index) =>
        `${index + 1}. [${section.requirement}] ${section.title}: ${section.purpose}`,
      ).join('\n');
      const modeInstruction: Record<SteEnforcementMode, string> = {
        off: 'STE checking is off. Do not claim that this artifact was checked for ASD-STE100.',
        advisory: 'Use the configured STE guidance where it preserves meaning. Unknown technical terms and checker findings remain advisories.',
        enforced_sections: 'Apply strict STE checks only to configured requirements, procedures, acceptance criteria, and safety instructions. Do not claim whole-document conformance.',
        enforced_full: 'Write all applicable prose for strict local Issue 9 checking. Use MUST/MUST NOT for obligations and CAN for permission or possibility. Never use SHALL, SHOULD, or modal MAY. Full status still requires an approved local bundle and human review.',
      };
      const maturityInstruction: Record<DocumentMaturity, string> = {
        exploratory: 'Create a useful early-stage exploration. Frame the problem, audience need, viable directions, assumptions, and important unknowns. Evidence and decisions can be incomplete, but every gap must remain honest and no missing value can be invented.',
        working: 'Create a coherent working draft from the information that exists now. Prefer useful prose over a template skeleton. Mark unresolved decisions and evidence gaps concisely; proposed measures are valid without invented baselines or targets.',
        alignment: 'Create a concise alignment draft for stakeholder discussion. Optimize the structure and detail for the inferred audience, make the intended takeaway or choice clear, and surface only the gaps that materially affect alignment.',
        publication: 'Create a publication candidate. Treat mandatory profile inputs and sections as strict completeness requirements. Missing evidence, authority, ownership, controls, or decision-critical content must remain visible blockers and must never be fabricated.',
      };
      const completenessInstruction = maturity === 'publication'
        ? 'The required-input list and mandatory section contract are publication requirements. Include every mandatory section with substantive content; never satisfy the contract with repeated placeholders.'
        : 'The required-input list and ordered sections are quality and readiness guidance, not a universal template. Select, combine, rename, or omit sections to fit the audience and purpose. Do not emit empty headings, repeated “Not provided” controls, or template commentary. Record only consequential gaps as assumptions or open questions.';
      const planInstruction = authoringPlan
        ? [
            '## Model-inferred authoring plan',
            'Use this bounded plan as presentation guidance only. It is not evidence and cannot authorize or supply a fact, owner, date, metric, target, approval, requirement, or commitment. If it conflicts with authoritative source material, preserve the source and adjust the presentation.',
            `<authoring_plan_json>${JSON.stringify(authoringPlan)}</authoring_plan_json>`,
          ].join('\n')
        : '## Model-inferred authoring plan\nNo explicit plan was supplied. Infer a fit-for-purpose audience, format, length, outline, and evidence treatment from the request and available sources without inventing facts.';
      return [
        `# Selected product document profile\nID: ${profile.profile_id}\nVersion: ${profile.version}\nFamily: ${profile.family}\nPurpose: ${profile.purpose}`,
        `## Document maturity\n${maturity}\n${maturityInstruction[maturity]}\n${completenessInstruction}`,
        planInstruction,
        `## Readiness inputs\n${profile.required_inputs.length > 0 ? profile.required_inputs.map((input) => `- ${input}`).join('\n') : '- No universal input list. Infer only presentation choices; source all substantive claims from authoritative request/context evidence.'}`,
        `## Profile section guidance\n${sectionContract}`,
        listRules('Narrative rules', profile.narrative_rules),
        listRules('Evidence rules', profile.evidence_rules),
        listRules('Terminology rules', profile.terminology_rules),
        listRules('Formatting rules', profile.formatting_rules),
        ...selectedOverlays.map((overlay) => listRules(`${overlay.overlay_id} rules`, overlay.rules)),
        ...selectedModules.map((module) => listRules(`${module.overlay_id} conditional module`, module.rules)),
        `## STE enforcement mode\n${modeInstruction[steMode]}`,
        `## Publication blockers\n${[...profile.hard_fail_rules, ...selectedOverlays.flatMap((overlay) => overlay.hard_fail_rules)]
          .map((rule) => `- ${rule}`).join('\n')}`,
      ].join('\n\n');
    },
  };
}
