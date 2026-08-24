import fs from 'fs';
import os from 'os';
import path from 'path';
import type {
  SteBundleLoader,
  SteBundleLoaderOptions,
  SteBundleReadiness,
  SteDictionaryEntry,
  SteRuleIndexEntry,
  SteSegmentClass,
  SteStandardBundle,
} from './types.js';

export const EXPECTED_STE_ISSUE9_SHA256 = '40d66f0cea84d1fff67f36d560c04eab4034c6bcf64014d43bd6d4c19795f3f0';
export const EXPECTED_STE_ISSUE9_INVENTORY = Object.freeze({
  rules: 53,
  generalRecommendations: 8,
  approvedWords: 875,
  nonApprovedEntries: 1_274,
});

const MAX_BUNDLE_BYTES = 64 * 1024 * 1024;
const MAX_DICTIONARY_RECORDS = 5_000;
const SEGMENT_CLASSES = new Set<SteSegmentClass>([
  'heading',
  'descriptive_prose',
  'procedural_instruction',
  'safety_instruction',
  'requirement',
  'acceptance_criterion',
  'table_cell',
  'label',
  'code',
  'identifier',
  'citation',
  'quoted_source',
  'proper_name',
  'unit_or_measure',
]);

function expectedRuleIds(): Set<string> {
  const sectionCounts = [14, 2, 7, 5, 5, 6, 3, 7, 4];
  const ids = new Set<string>();
  sectionCounts.forEach((count, sectionIndex) => {
    for (let rule = 1; rule <= count; rule += 1) ids.add(`${sectionIndex + 1}.${rule}`);
  });
  return ids;
}

const EXPECTED_RULE_IDS = expectedRuleIds();
const EXPECTED_RECOMMENDATION_IDS = new Set(Array.from({ length: 8 }, (_, index) => `GR-${index + 1}`));

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isBoundedString(value: unknown, maximum = 500): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum;
}

function isInteger(value: unknown, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): value is number {
  return Number.isInteger(value) && Number(value) >= minimum && Number(value) <= maximum;
}

function readStringArray(
  value: unknown,
  field: string,
  diagnostics: string[],
  maximumItems: number,
  maximumLength: number,
): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > maximumItems || value.some((item) => !isBoundedString(item, maximumLength))) {
    diagnostics.push(`${field} must be an array of at most ${maximumItems} bounded strings.`);
    return undefined;
  }
  return value as string[];
}

function parseRule(value: unknown, index: number, diagnostics: string[]): SteRuleIndexEntry | undefined {
  const field = `rules[${index}]`;
  if (!isRecord(value)) {
    diagnostics.push(`${field} must be an object.`);
    return undefined;
  }
  if (!isBoundedString(value.ruleId, 12) || !/^(?:[1-9]\.[0-9]{1,2}|GR-[1-8])$/.test(value.ruleId)) {
    diagnostics.push(`${field}.ruleId is invalid.`);
    return undefined;
  }
  if (!isBoundedString(value.section, 80)) {
    diagnostics.push(`${field}.section is invalid.`);
    return undefined;
  }
  if (value.page !== undefined && !isInteger(value.page, 1, 434)) {
    diagnostics.push(`${field}.page must be a physical page from 1 through 434.`);
    return undefined;
  }
  if (value.title !== undefined && !isBoundedString(value.title, 300)) {
    diagnostics.push(`${field}.title is invalid.`);
    return undefined;
  }
  let applicability: SteSegmentClass[] | undefined;
  if (value.applicability !== undefined) {
    if (!Array.isArray(value.applicability) || value.applicability.length > SEGMENT_CLASSES.size
      || value.applicability.some((item) => typeof item !== 'string' || !SEGMENT_CLASSES.has(item as SteSegmentClass))) {
      diagnostics.push(`${field}.applicability contains an invalid segment class.`);
      return undefined;
    }
    applicability = value.applicability as SteSegmentClass[];
  }
  return {
    ruleId: value.ruleId,
    section: value.section,
    ...(value.page === undefined ? {} : { page: value.page }),
    ...(value.title === undefined ? {} : { title: value.title }),
    ...(applicability === undefined ? {} : { applicability }),
  };
}

function parseDictionaryEntry(value: unknown, index: number, diagnostics: string[]): SteDictionaryEntry | undefined {
  const field = `dictionary[${index}]`;
  if (!isRecord(value)) {
    diagnostics.push(`${field} must be an object.`);
    return undefined;
  }
  if (!isBoundedString(value.term, 160) || !isBoundedString(value.normalizedTerm, 160)) {
    diagnostics.push(`${field} must contain a bounded term and normalizedTerm.`);
    return undefined;
  }
  if (value.normalizedTerm !== value.term.normalize('NFKC').trim().toLocaleLowerCase('en-US').replace(/\s+/g, ' ')) {
    diagnostics.push(`${field}.normalizedTerm does not match its term.`);
    return undefined;
  }
  if (typeof value.approved !== 'boolean') {
    diagnostics.push(`${field}.approved must be boolean.`);
    return undefined;
  }
  if (value.entryId !== undefined && !isBoundedString(value.entryId, 220)) {
    diagnostics.push(`${field}.entryId is invalid.`);
    return undefined;
  }
  const approvedMeanings = readStringArray(value.approvedMeanings, `${field}.approvedMeanings`, diagnostics, 20, 1_000);
  const partOfSpeech = readStringArray(value.partOfSpeech, `${field}.partOfSpeech`, diagnostics, 8, 40);
  const forms = readStringArray(value.forms, `${field}.forms`, diagnostics, 30, 160);
  const alternatives = readStringArray(value.alternatives, `${field}.alternatives`, diagnostics, 30, 240);
  if ((value.approvedMeanings !== undefined && approvedMeanings === undefined)
    || (value.partOfSpeech !== undefined && partOfSpeech === undefined)
    || (value.forms !== undefined && forms === undefined)
    || (value.alternatives !== undefined && alternatives === undefined)) return undefined;
  if (value.ruleReference !== undefined && !isBoundedString(value.ruleReference, 40)) {
    diagnostics.push(`${field}.ruleReference is invalid.`);
    return undefined;
  }
  if (value.page !== undefined && !isInteger(value.page, 1, 434)) {
    diagnostics.push(`${field}.page must be a physical page from 1 through 434.`);
    return undefined;
  }
  return {
    ...(value.entryId === undefined ? {} : { entryId: value.entryId }),
    term: value.term,
    normalizedTerm: value.normalizedTerm,
    approved: value.approved,
    ...(approvedMeanings === undefined ? {} : { approvedMeanings }),
    ...(partOfSpeech === undefined ? {} : { partOfSpeech }),
    ...(forms === undefined ? {} : { forms }),
    ...(alternatives === undefined ? {} : { alternatives }),
    ...(value.ruleReference === undefined ? {} : { ruleReference: value.ruleReference }),
    ...(value.page === undefined ? {} : { page: value.page }),
  };
}

function parseBundle(value: unknown): { bundle?: SteStandardBundle; diagnostics: string[] } {
  const diagnostics: string[] = [];
  if (!isRecord(value)) return { diagnostics: ['Bundle root must be an object.'] };
  if (value.schemaVersion !== 'asd-ste100-bundle.v1') diagnostics.push('Unsupported STE bundle schemaVersion.');
  if (value.standardId !== 'ASD-STE100') diagnostics.push('Unexpected STE standardId.');
  if (value.issue !== 9) diagnostics.push('Unexpected STE issue; Issue 9 is required.');
  if (value.issueDate !== '2025-01-15') diagnostics.push('Unexpected STE Issue 9 date.');
  if (!isBoundedString(value.sourceSha256, 64) || !/^[a-f0-9]{64}$/.test(value.sourceSha256)) {
    diagnostics.push('sourceSha256 must be a lowercase SHA-256 value.');
  }
  if (value.sourceLocation !== undefined && !isBoundedString(value.sourceLocation, 2_000)) {
    diagnostics.push('sourceLocation is invalid.');
  }
  if (!isBoundedString(value.extractedAt, 80) || Number.isNaN(Date.parse(value.extractedAt))) {
    diagnostics.push('extractedAt must be an ISO timestamp.');
  }
  if (!isBoundedString(value.extractorVersion, 80)) diagnostics.push('extractorVersion is invalid.');

  const inventory = value.inventory;
  if (!isRecord(inventory)) {
    diagnostics.push('inventory must be an object.');
  } else {
    for (const [field, expected] of Object.entries(EXPECTED_STE_ISSUE9_INVENTORY)) {
      if (inventory[field] !== expected) diagnostics.push(`inventory.${field} must equal the Issue 9 declared count ${expected}.`);
    }
    for (const field of ['extractedDictionaryRecords', 'extractedApprovedRecords', 'extractedNonApprovedRecords']) {
      if (inventory[field] !== undefined && !isInteger(inventory[field], 0, MAX_DICTIONARY_RECORDS)) {
        diagnostics.push(`inventory.${field} is invalid.`);
      }
    }
  }

  const rules: SteRuleIndexEntry[] = [];
  if (!Array.isArray(value.rules) || value.rules.length > 100) {
    diagnostics.push('rules must be an array of at most 100 records.');
  } else {
    value.rules.forEach((rule, index) => {
      const parsed = parseRule(rule, index, diagnostics);
      if (parsed) rules.push(parsed);
    });
  }
  const ruleIds = new Set(rules.map((rule) => rule.ruleId));
  if (ruleIds.size !== rules.length) diagnostics.push('Rule IDs must be unique.');
  const missingRules = [...EXPECTED_RULE_IDS].filter((ruleId) => !ruleIds.has(ruleId));
  const missingRecommendations = [...EXPECTED_RECOMMENDATION_IDS].filter((ruleId) => !ruleIds.has(ruleId));
  if (missingRules.length > 0) diagnostics.push(`Rule index is missing ${missingRules.length} required rule reference(s).`);
  if (missingRecommendations.length > 0) diagnostics.push(`Rule index is missing ${missingRecommendations.length} general recommendation reference(s).`);
  if (rules.filter((rule) => EXPECTED_RULE_IDS.has(rule.ruleId)).length !== EXPECTED_STE_ISSUE9_INVENTORY.rules) {
    diagnostics.push('Rule index does not contain exactly 53 writing-rule references.');
  }
  if (rules.filter((rule) => EXPECTED_RECOMMENDATION_IDS.has(rule.ruleId)).length !== EXPECTED_STE_ISSUE9_INVENTORY.generalRecommendations) {
    diagnostics.push('Rule index does not contain exactly eight general-recommendation references.');
  }

  const dictionary: SteDictionaryEntry[] = [];
  if (!Array.isArray(value.dictionary) || value.dictionary.length > MAX_DICTIONARY_RECORDS) {
    diagnostics.push(`dictionary must be an array of at most ${MAX_DICTIONARY_RECORDS} records.`);
  } else {
    value.dictionary.forEach((entry, index) => {
      const parsed = parseDictionaryEntry(entry, index, diagnostics);
      if (parsed) dictionary.push(parsed);
    });
  }
  if (dictionary.length === 0) diagnostics.push('dictionary must contain extracted records.');
  const entryIds = dictionary.map((entry) => entry.entryId).filter((entryId): entryId is string => Boolean(entryId));
  if (new Set(entryIds).size !== entryIds.length) diagnostics.push('Dictionary entry IDs must be unique when present.');
  if (isRecord(inventory)) {
    const approvedRecords = dictionary.filter((entry) => entry.approved).length;
    const nonApprovedRecords = dictionary.length - approvedRecords;
    if (inventory.extractedDictionaryRecords !== undefined && inventory.extractedDictionaryRecords !== dictionary.length) {
      diagnostics.push('Extracted dictionary record count does not match dictionary length.');
    }
    if (inventory.extractedApprovedRecords !== undefined && inventory.extractedApprovedRecords !== approvedRecords) {
      diagnostics.push('Extracted approved-record count does not match dictionary content.');
    }
    if (inventory.extractedNonApprovedRecords !== undefined && inventory.extractedNonApprovedRecords !== nonApprovedRecords) {
      diagnostics.push('Extracted non-approved-record count does not match dictionary content.');
    }
  }

  const extractionDiagnostics = Array.isArray(value.diagnostics)
    && value.diagnostics.length <= 200
    && value.diagnostics.every((item) => isBoundedString(item, 1_000))
    ? value.diagnostics as string[]
    : undefined;
  if (!extractionDiagnostics) diagnostics.push('diagnostics must be a bounded string array.');
  if (extractionDiagnostics?.some((item) => item.toLowerCase().startsWith('[error]'))) {
    diagnostics.push('The extraction bundle contains unresolved structural errors.');
  }

  const approval = value.humanApproval;
  if (!isRecord(approval) || !['pending', 'approved', 'rejected'].includes(String(approval.status))) {
    diagnostics.push('humanApproval.status must be pending, approved, or rejected.');
  } else if (approval.status === 'approved') {
    if (!isBoundedString(approval.reviewer, 200)) diagnostics.push('Approved bundles require a reviewer.');
    if (!isBoundedString(approval.reviewedAt, 80) || Number.isNaN(Date.parse(approval.reviewedAt))) {
      diagnostics.push('Approved bundles require a valid reviewedAt timestamp.');
    }
  }

  if (diagnostics.length > 0 || !isRecord(inventory) || !isRecord(approval) || !extractionDiagnostics) {
    return { diagnostics };
  }
  return {
    bundle: {
      schemaVersion: 'asd-ste100-bundle.v1',
      standardId: 'ASD-STE100',
      issue: 9,
      issueDate: '2025-01-15',
      sourceSha256: value.sourceSha256 as string,
      ...(value.sourceLocation === undefined ? {} : { sourceLocation: value.sourceLocation as string }),
      extractedAt: value.extractedAt as string,
      extractorVersion: value.extractorVersion as string,
      inventory: {
        rules: inventory.rules as number,
        generalRecommendations: inventory.generalRecommendations as number,
        approvedWords: inventory.approvedWords as number,
        nonApprovedEntries: inventory.nonApprovedEntries as number,
        ...(inventory.extractedDictionaryRecords === undefined ? {} : { extractedDictionaryRecords: inventory.extractedDictionaryRecords as number }),
        ...(inventory.extractedApprovedRecords === undefined ? {} : { extractedApprovedRecords: inventory.extractedApprovedRecords as number }),
        ...(inventory.extractedNonApprovedRecords === undefined ? {} : { extractedNonApprovedRecords: inventory.extractedNonApprovedRecords as number }),
      },
      rules,
      dictionary,
      diagnostics: extractionDiagnostics,
      humanApproval: {
        status: approval.status as 'pending' | 'approved' | 'rejected',
        ...(approval.reviewer === undefined ? {} : { reviewer: approval.reviewer as string }),
        ...(approval.reviewedAt === undefined ? {} : { reviewedAt: approval.reviewedAt as string }),
        ...(approval.note === undefined ? {} : { note: String(approval.note).slice(0, 1_000) }),
      },
    },
    diagnostics: [],
  };
}

function expandBundlePath(bundlePath: string | undefined, homeDir: string): string {
  const configured = bundlePath ?? process.env.BOTBOY_STE_BUNDLE_PATH
    ?? path.join(homeDir, '.personal-productivity-tracker', 'ste', 'asd-ste100-issue9.bundle.json');
  if (configured === '~') return homeDir;
  if (configured.startsWith('~/')) return path.join(homeDir, configured.slice(2));
  return path.resolve(configured);
}

export function loadSteBundle(options: SteBundleLoaderOptions = {}): SteBundleReadiness {
  const homeDir = options.homeDir ?? os.homedir();
  const bundlePath = expandBundlePath(options.bundlePath, homeDir);
  const expectedHash = options.expectedSourceSha256 ?? EXPECTED_STE_ISSUE9_SHA256;
  if (!fs.existsSync(bundlePath)) {
    return {
      ready: false,
      available: false,
      approved: false,
      path: bundlePath,
      diagnostics: ['Local ASD-STE100 Issue 9 bundle is not available. Run the extraction workflow, then complete explicit human review.'],
    };
  }
  try {
    const stats = fs.statSync(bundlePath);
    if (!stats.isFile()) {
      return { ready: false, available: true, approved: false, path: bundlePath, diagnostics: ['Configured STE bundle path is not a file.'] };
    }
    if (stats.size > MAX_BUNDLE_BYTES) {
      return { ready: false, available: true, approved: false, path: bundlePath, diagnostics: ['Configured STE bundle exceeds the safe size limit.'] };
    }
    const parsed = parseBundle(JSON.parse(fs.readFileSync(bundlePath, 'utf8')) as unknown);
    if (!parsed.bundle) {
      return { ready: false, available: true, approved: false, path: bundlePath, diagnostics: parsed.diagnostics };
    }
    if (parsed.bundle.sourceSha256 !== expectedHash) {
      return {
        ready: false,
        available: true,
        approved: false,
        path: bundlePath,
        bundle: parsed.bundle,
        diagnostics: ['Bundle source fingerprint does not match the configured official Issue 9 source fingerprint.'],
      };
    }
    const approved = parsed.bundle.humanApproval.status === 'approved';
    return {
      ready: approved,
      available: true,
      approved,
      path: bundlePath,
      bundle: parsed.bundle,
      diagnostics: approved
        ? ['Local Issue 9 bundle passed schema, fingerprint, inventory, and approval metadata checks.']
        : [`Local Issue 9 bundle is structurally valid, but human approval is ${parsed.bundle.humanApproval.status}.`],
    };
  } catch (error) {
    return {
      ready: false,
      available: true,
      approved: false,
      path: bundlePath,
      diagnostics: [`Unable to load the local STE bundle: ${error instanceof Error ? error.message : String(error)}`],
    };
  }
}

export function createSteBundleLoader(options: SteBundleLoaderOptions = {}): SteBundleLoader {
  return { load: () => loadSteBundle(options) };
}
