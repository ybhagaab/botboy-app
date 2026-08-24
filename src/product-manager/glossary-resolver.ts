import path from 'path';
import type {
  ContextRole,
  GlossaryApprovalState,
  GlossaryConflict,
  GlossaryEntry,
  GlossaryProvenance,
  GlossaryResolution,
  GlossaryResolutionRequest,
  GlossaryResolver,
  GlossaryTermType,
  ResolvedContextDocument,
} from './types.js';

const COMMON_CAPITALIZED = new Set([
  'a', 'an', 'and', 'as', 'at', 'background', 'business', 'customer', 'document', 'for', 'from',
  'in', 'introduction', 'notes', 'of', 'on', 'or', 'overview', 'purpose', 'requirements', 'scope',
  'section', 'summary', 'the', 'this', 'to', 'with', 'when', 'where', 'why',
]);

const STATE_PRIORITY: Record<GlossaryApprovalState, number> = {
  approved: 700,
  exception: 680,
  unapproved: 620,
  candidate_context: 400,
  candidate_prompt: 300,
  candidate_document: 200,
  ste_approved: 100,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalized(term: string): string {
  return term.trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-US');
}

function uniqueStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0).map((entry) => entry.trim()))];
}

function provenanceForRole(role: ContextRole, source: string): GlossaryProvenance {
  const sourceType: GlossaryProvenance['sourceType'] = role === 'overview'
    ? 'overview'
    : role === 'product'
      ? 'product_context'
      : role === 'technical'
        ? 'technical_context'
        : role === 'domain'
          ? 'domain_context'
          : 'explicit_glossary';
  return { sourceType, source };
}

function extractCandidates(text: string): string[] {
  const terms = new Set<string>();
  const add = (term: string) => {
    const cleaned = term.trim().replace(/\s+/g, ' ').replace(/[.,:;!?()[\]{}]+$/g, '');
    if (cleaned.length < 2 || cleaned.length > 100) return;
    if (COMMON_CAPITALIZED.has(normalized(cleaned))) return;
    terms.add(cleaned);
  };

  for (const match of text.matchAll(/\b[A-Z][A-Z0-9]{1,}(?:-[A-Z0-9]+)*\b/g)) add(match[0]);
  for (const match of text.matchAll(/\b(?:[a-z]+[A-Z][A-Za-z0-9]*|[A-Z][a-z]+(?:[A-Z][A-Za-z0-9]*)+)\b/g)) add(match[0]);

  const phraseCounts = new Map<string, { display: string; count: number }>();
  for (const match of text.matchAll(/\b[A-Z][A-Za-z0-9-]+(?:\s+[A-Z][A-Za-z0-9-]+){1,3}\b/g)) {
    const display = match[0].trim();
    const key = normalized(display);
    if (display.split(/\s+/).every((word) => COMMON_CAPITALIZED.has(normalized(word)))) continue;
    const current = phraseCounts.get(key) ?? { display, count: 0 };
    current.count += 1;
    phraseCounts.set(key, current);
  }
  for (const entry of phraseCounts.values()) {
    // A product name can occur only once in a one-off prompt. Keep it as a
    // request-scoped candidate rather than dropping it; candidates never gain
    // permanent approval automatically.
    add(entry.display);
  }

  for (const match of text.matchAll(/(?:called|known as|term|named)\s+["'`]?([A-Z][A-Za-z0-9-]*(?:\s+[A-Z][A-Za-z0-9-]*){0,3})["'`]?/g)) {
    add(match[1]);
  }
  return [...terms].sort((a, b) => a.localeCompare(b));
}

function candidateEntry(
  term: string,
  state: 'candidate_context' | 'candidate_prompt' | 'candidate_document',
  provenance: GlossaryProvenance,
): GlossaryEntry {
  return {
    term,
    normalizedTerm: normalized(term),
    termType: 'technical_noun',
    approvedForms: [term],
    allowedContexts: [],
    prohibitedSynonyms: [],
    approvalState: state,
    provenance: [provenance],
  };
}

function parseExplicitGlossary(document: ResolvedContextDocument, diagnostics: string[]): GlossaryEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(document.content) as unknown;
  } catch {
    diagnostics.push(`${document.path}: explicit glossary must be valid JSON`);
    return [];
  }
  if (!isRecord(parsed) || parsed.schema_version !== 'product-glossary.v1' || !Array.isArray(parsed.terms)) {
    diagnostics.push(`${document.path}: expected product-glossary.v1 with a terms array`);
    return [];
  }
  const entries: GlossaryEntry[] = [];
  for (let index = 0; index < parsed.terms.length; index += 1) {
    const value = parsed.terms[index];
    if (!isRecord(value) || typeof value.term !== 'string' || value.term.trim().length === 0) {
      diagnostics.push(`${document.path}: terms[${index}] has no valid term`);
      continue;
    }
    const termType: GlossaryTermType = value.term_type === 'technical_verb' ? 'technical_verb' : 'technical_noun';
    const rawState = typeof value.approval_state === 'string' ? value.approval_state : 'unapproved';
    const approvalState: GlossaryApprovalState = rawState === 'approved'
      ? 'approved'
      : rawState === 'exception'
        ? 'exception'
        : 'unapproved';
    entries.push({
      term: value.term.trim(),
      normalizedTerm: normalized(value.term),
      termType,
      ...(typeof value.approved_definition === 'string' ? { approvedDefinition: value.approved_definition.trim() } : {}),
      approvedForms: uniqueStrings(value.approved_forms).length > 0 ? uniqueStrings(value.approved_forms) : [value.term.trim()],
      ...(typeof value.part_of_speech === 'string' ? { partOfSpeech: value.part_of_speech } : {}),
      ...(typeof value.subject_field === 'string' ? { subjectField: value.subject_field } : {}),
      allowedContexts: uniqueStrings(value.allowed_contexts),
      prohibitedSynonyms: uniqueStrings(value.prohibited_synonyms),
      ...(typeof value.owner === 'string' ? { owner: value.owner } : {}),
      approvalState,
      ...(typeof value.version === 'string' ? { version: value.version } : {}),
      ...(typeof value.review_date === 'string' ? { reviewDate: value.review_date } : {}),
      provenance: [{ sourceType: 'explicit_glossary', source: document.path }],
    });
  }
  return entries;
}

function hasMaterialConflict(left: GlossaryEntry, right: GlossaryEntry): boolean {
  return left.termType !== right.termType
    || (left.approvedDefinition !== undefined && right.approvedDefinition !== undefined && left.approvedDefinition !== right.approvedDefinition)
    || left.approvalState !== right.approvalState;
}

export function createGlossaryResolver(): GlossaryResolver {
  return {
    resolve(request: GlossaryResolutionRequest): GlossaryResolution {
      const byTerm = new Map<string, GlossaryEntry>();
      const conflicts: GlossaryConflict[] = [];
      const diagnostics: string[] = [];

      const add = (incoming: GlossaryEntry) => {
        const key = incoming.normalizedTerm || normalized(incoming.term);
        const existing = byTerm.get(key);
        if (!existing) {
          byTerm.set(key, { ...incoming, normalizedTerm: key, provenance: [...incoming.provenance] });
          return;
        }
        const incomingPriority = STATE_PRIORITY[incoming.approvalState];
        const existingPriority = STATE_PRIORITY[existing.approvalState];
        const incomingWins = incomingPriority > existingPriority;
        const kept = incomingWins ? incoming : existing;
        const rejected = incomingWins ? existing : incoming;
        if (hasMaterialConflict(existing, incoming)) {
          conflicts.push({
            term: kept.term,
            kept,
            rejected,
            reason: incomingWins
              ? `higher-precedence ${incoming.approvalState} entry replaced ${existing.approvalState}`
              : `existing ${existing.approvalState} entry has equal or higher precedence`,
          });
        }
        byTerm.set(key, {
          ...kept,
          normalizedTerm: key,
          provenance: [...kept.provenance, ...rejected.provenance.filter((candidate) =>
            !kept.provenance.some((source) => source.sourceType === candidate.sourceType && source.source === candidate.source),
          )],
        });
      };

      for (const entry of request.steEntries ?? []) add(entry);

      const glossaryDocuments = request.context.documents.filter((document) => document.role === 'glossary');
      for (const document of glossaryDocuments) {
        for (const entry of parseExplicitGlossary(document, diagnostics)) add(entry);
      }

      for (const document of request.context.documents.filter((candidate) => candidate.role !== 'glossary')) {
        for (const term of extractCandidates(document.content)) {
          add(candidateEntry(term, 'candidate_context', provenanceForRole(document.role, document.path)));
        }
      }

      for (const term of extractCandidates(request.prompt)) {
        add(candidateEntry(term, 'candidate_prompt', { sourceType: 'prompt', source: 'current request' }));
      }
      if (request.documentText) {
        for (const term of extractCandidates(request.documentText)) {
          add(candidateEntry(term, 'candidate_document', { sourceType: 'document', source: 'current artifact' }));
        }
      }

      const entries = [...byTerm.values()].sort((a, b) => a.normalizedTerm.localeCompare(b.normalizedTerm));
      const approvedTerms = entries.filter((entry) => ['approved', 'exception', 'ste_approved'].includes(entry.approvalState));
      const candidateTerms = entries.filter((entry) => entry.approvalState.startsWith('candidate_') || entry.approvalState === 'unapproved');
      return { entries, approvedTerms, candidateTerms, conflicts, diagnostics };
    },

    formatForPrompt(resolution: GlossaryResolution): string {
      const approved = resolution.approvedTerms.slice(0, 300).map((entry) => {
        const definition = entry.approvedDefinition ? ` — ${entry.approvedDefinition}` : '';
        return `- ${entry.term} [${entry.termType}, ${entry.approvalState}]${definition}`;
      });
      const candidates = resolution.candidateTerms.slice(0, 200).map((entry) =>
        `- ${entry.term} [${entry.approvalState}; not permanently approved]`,
      );
      return [
        '## Approved terminology',
        approved.length > 0 ? approved.join('\n') : '- No product-specific terms are approved for this request.',
        '## Request-local terminology candidates',
        candidates.length > 0 ? candidates.join('\n') : '- No product-specific candidates were derived.',
        'Candidates can be used only as visibly request-local terminology in advisory drafts. Do not represent them as permanently approved glossary terms.',
      ].join('\n');
    },
  };
}

export { extractCandidates as extractGlossaryCandidates };
