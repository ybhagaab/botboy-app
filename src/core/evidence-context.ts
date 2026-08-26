import type { PipelineLlm } from './pipeline-llm.js';

/**
 * Conservative token density measured from BotBoy's JSON-heavy prompts. The
 * older chars/4 prose heuristic under-counted real provider tokens by 22–30%.
 */
const PROMPT_CHARS_PER_TOKEN = 2.7;
const DEFAULT_INPUT_BUDGET_TOKENS = 16_000;
const MAX_RELEVANCE_TERMS = 12;
const EXCERPT_MARKER_RESERVE_CHARS = 320;
const PER_ITEM_WRAPPER_RESERVE_CHARS = 160;

const TERM_STOP_WORDS = new Set([
  'about', 'after', 'again', 'also', 'and', 'are', 'before', 'botboy', 'but',
  'document', 'file', 'for', 'from', 'have', 'into', 'project', 'report',
  'that', 'the', 'their', 'this', 'was', 'were', 'with', 'work', 'your',
]);

export interface EvidenceContextItem {
  id: string;
  content: string;
  source?: string;
  type?: string;
  /** Text whose distinctive terms should guide interior excerpt selection. */
  relevanceText?: string;
}

export interface EvidenceExcerpt {
  id: string;
  text: string;
  originalChars: number;
  /** Source characters represented, excluding omission markers. */
  includedChars: number;
  truncated: boolean;
}

export interface EvidenceContextPlan {
  excerpts: Map<string, EvidenceExcerpt>;
  contextBudgetTokens: number;
  promptBudgetChars: number;
  evidenceBudgetChars: number;
  originalChars: number;
  includedChars: number;
  truncatedItems: number;
}

export interface EvidenceContextOptions {
  /** Non-evidence prompt characters: instructions, catalog, current brain, etc. */
  fixedPromptChars: number;
  minCharsPerItem: number;
  maxCharsPerItem: number;
  /** Explicit per-item limits used by tests or specialized callers. */
  perItemMaxChars?: number;
}

export class EvidenceContextBudgetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EvidenceContextBudgetError';
  }
}

/** Effective pipeline input budget. Test doubles that do not expose the new
 * method keep a conservative fallback rather than assuming a Kimi-sized model. */
export function pipelineContextBudgetTokens(llm: PipelineLlm): number {
  const configured = llm.getContextBudgetTokens?.();
  return Number.isFinite(configured) && configured! > 0
    ? Math.floor(configured!)
    : DEFAULT_INPUT_BUDGET_TOKENS;
}

/** Character ceiling corresponding to the configured input-token budget, with
 * an additional estimator/serialization margin. */
export function pipelineInputBudgetChars(llm: PipelineLlm): number {
  const contextBudgetTokens = pipelineContextBudgetTokens(llm);
  const safetyTokens = Math.min(4_096, Math.max(1_024, Math.floor(contextBudgetTokens * 0.05)));
  return Math.max(0, Math.floor((contextBudgetTokens - safetyTokens) * PROMPT_CHARS_PER_TOKEN));
}

/** Final mechanical guard after redaction and serialization. */
export function assertPipelinePromptWithinBudget(
  llm: PipelineLlm,
  prompt: string,
  pass: string,
): void {
  const maxChars = pipelineInputBudgetChars(llm);
  if (prompt.length > maxChars) {
    throw new EvidenceContextBudgetError(
      `${pass} prompt is ${prompt.length.toLocaleString('en-US')} chars; `
      + `safe input ceiling is ${maxChars.toLocaleString('en-US')} chars`,
    );
  }
}

function relevanceTerms(value: string | undefined): string[] {
  if (!value) return [];
  const terms = value.toLowerCase().match(/[a-z0-9][a-z0-9._-]{2,}/g) ?? [];
  return [...new Set(terms)]
    .filter((term) => !TERM_STOP_WORDS.has(term))
    .sort((a, b) => b.length - a.length)
    .slice(0, MAX_RELEVANCE_TERMS);
}

function sourceWeight(item: EvidenceContextItem): number {
  const source = (item.source ?? '').toLowerCase();
  const type = (item.type ?? '').toLowerCase();
  if (source === 'manual' || type.includes('email')) return 3;
  if (source === 'filesystem' || source === 'sharepoint' || type.includes('document') || type.includes('file')) return 3;
  if (source === 'browser' || type.includes('website')) return 2.5;
  if (source === 'clipboard') return 1.5;
  if (source === 'slack') return 1;
  if (source === 'app') return 0.5;
  return 2;
}

interface SourceRange {
  start: number;
  end: number;
}

function mergeRanges(ranges: SourceRange[]): SourceRange[] {
  const sorted = ranges
    .filter((range) => range.end > range.start)
    .sort((a, b) => a.start - b.start);
  const merged: SourceRange[] = [];
  for (const range of sorted) {
    const previous = merged[merged.length - 1];
    if (previous && range.start <= previous.end) previous.end = Math.max(previous.end, range.end);
    else merged.push({ ...range });
  }
  return merged;
}

/** Pick up to three interior regions whose blocks contain the most distinctive
 * title/project terms. Unused slots are filled with stratified 25/50/75%
 * samples so generic titles cannot reduce a long document to one midpoint
 * window. This is lexical and deterministic: the model never decides which
 * source text becomes visible to itself. */
function interiorCenters(content: string, terms: string[]): number[] {
  const blockCount = Math.min(24, Math.max(6, Math.ceil(content.length / 20_000)));
  const blockSize = Math.ceil(content.length / blockCount);
  const scored: Array<{ center: number; score: number }> = [];

  if (terms.length > 0) {
    for (let index = 1; index < blockCount - 1; index++) {
      const start = index * blockSize;
      const block = content.slice(start, Math.min(content.length, start + blockSize)).toLowerCase();
      let score = 0;
      let weightedPosition = 0;
      for (const term of terms) {
        let from = 0;
        let occurrences = 0;
        const termWeight = Math.min(term.length, 20);
        while (occurrences < 20) {
          const found = block.indexOf(term, from);
          if (found < 0) break;
          occurrences++;
          score += termWeight;
          weightedPosition += (start + found + Math.floor(term.length / 2)) * termWeight;
          from = found + term.length;
        }
      }
      if (score > 0) scored.push({ center: Math.floor(weightedPosition / score), score });
    }
  }

  const selected: number[] = [];
  const minimumSeparation = Math.max(1, Math.floor(content.length / 12));
  for (const entry of scored.sort((a, b) => b.score - a.score || a.center - b.center)) {
    if (selected.every((center) => Math.abs(center - entry.center) >= minimumSeparation)) {
      selected.push(entry.center);
    }
    if (selected.length === 3) break;
  }
  for (const fraction of [0.25, 0.5, 0.75]) {
    if (selected.length === 3) break;
    const center = Math.floor(content.length * fraction);
    if (selected.every((existing) => Math.abs(existing - center) >= minimumSeparation)) {
      selected.push(center);
    }
  }
  return selected.sort((a, b) => a - b);
}

function balancedExcerpt(
  content: string,
  maxChars: number,
  relevanceText?: string,
): { text: string; includedChars: number } {
  if (content.length <= maxChars) return { text: content, includedChars: content.length };
  if (maxChars <= EXCERPT_MARKER_RESERVE_CHARS + 256) {
    return { text: content.slice(0, Math.max(0, maxChars)), includedChars: Math.max(0, maxChars) };
  }

  const usableChars = maxChars - EXCERPT_MARKER_RESERVE_CHARS;
  const headChars = Math.floor(usableChars * 0.3);
  const tailChars = Math.floor(usableChars * 0.2);
  const interiorChars = usableChars - headChars - tailChars;
  const centers = interiorCenters(content, relevanceTerms(relevanceText));
  const interiorWindowChars = Math.max(1, Math.floor(interiorChars / centers.length));
  const ranges: SourceRange[] = [
    { start: 0, end: headChars },
    ...centers.map((center) => ({
      start: Math.max(0, center - Math.floor(interiorWindowChars / 2)),
      end: Math.min(content.length, center + Math.ceil(interiorWindowChars / 2)),
    })),
    { start: Math.max(0, content.length - tailChars), end: content.length },
  ];
  const merged = mergeRanges(ranges);
  let includedChars = 0;
  const parts: string[] = [];
  for (let index = 0; index < merged.length; index++) {
    const range = merged[index];
    if (index > 0) {
      const omitted = range.start - merged[index - 1].end;
      parts.push(`\n\n[... ${omitted.toLocaleString('en-US')} source characters omitted ...]\n\n`);
    }
    const part = content.slice(range.start, range.end);
    parts.push(part);
    includedChars += part.length;
  }
  const text = parts.join('');
  // Marker reserve is deliberately conservative, but retain a final mechanical
  // ceiling in case a locale or very large offset produces a longer marker.
  return text.length <= maxChars
    ? { text, includedChars }
    : { text: text.slice(0, maxChars), includedChars: Math.min(includedChars, maxChars) };
}

function distributeFairly(targets: number[], budget: number): number[] {
  const allocations = targets.map(() => 0);
  let remaining = budget;
  let active = targets.map((_, index) => index).filter((index) => targets[index] > 0);
  while (remaining > 0 && active.length > 0) {
    const share = Math.max(1, Math.floor(remaining / active.length));
    let granted = 0;
    for (const index of active) {
      if (remaining <= 0) break;
      const amount = Math.min(share, targets[index] - allocations[index], remaining);
      allocations[index] += amount;
      remaining -= amount;
      granted += amount;
    }
    if (granted === 0) break;
    active = active.filter((index) => allocations[index] < targets[index]);
  }
  return allocations;
}

function distributeWeighted(
  allocations: number[],
  targets: number[],
  items: EvidenceContextItem[],
  budget: number,
): void {
  let remaining = budget - allocations.reduce((sum, value) => sum + value, 0);
  while (remaining > 0) {
    const active = targets.map((_, index) => index).filter((index) => allocations[index] < targets[index]);
    if (active.length === 0) break;
    const totalWeight = active.reduce((sum, index) => sum + sourceWeight(items[index]), 0);
    const roundBudget = remaining;
    let granted = 0;
    for (const index of active) {
      if (remaining <= 0) break;
      const weightedShare = Math.max(1, Math.floor(roundBudget * sourceWeight(items[index]) / totalWeight));
      const amount = Math.min(weightedShare, targets[index] - allocations[index], remaining);
      allocations[index] += amount;
      remaining -= amount;
      granted += amount;
    }
    if (granted === 0) break;
  }
}

/**
 * Allocate one bounded evidence pool across a whole model call. Short items are
 * preserved in full first; remaining space is weighted toward substantive
 * documents, email, and web evidence. Long items use deterministic balanced
 * excerpts instead of prefix-only truncation.
 */
export function planEvidenceContext(
  llm: PipelineLlm,
  items: EvidenceContextItem[],
  options: EvidenceContextOptions,
): EvidenceContextPlan {
  const contextBudgetTokens = pipelineContextBudgetTokens(llm);
  const promptBudgetChars = pipelineInputBudgetChars(llm);
  const evidenceBudgetChars = Math.max(
    0,
    promptBudgetChars - Math.max(0, options.fixedPromptChars) - items.length * PER_ITEM_WRAPPER_RESERVE_CHARS,
  );
  const maxPerItem = Math.max(
    0,
    options.perItemMaxChars === undefined
      ? options.maxCharsPerItem
      : Math.min(options.maxCharsPerItem, options.perItemMaxChars),
  );
  const targets = items.map((item) => Math.min(item.content.length, maxPerItem));
  const minimumVisibilityChars = targets.reduce(
    (sum, target) => sum + Math.min(target, 256),
    0,
  );
  if (evidenceBudgetChars < minimumVisibilityChars) {
    throw new EvidenceContextBudgetError(
      `fixed prompt context leaves ${evidenceBudgetChars.toLocaleString('en-US')} evidence chars; `
      + `${minimumVisibilityChars.toLocaleString('en-US')} are required to represent every non-empty item`,
    );
  }
  const minimumTargets = targets.map((target) => Math.min(target, options.minCharsPerItem));
  const minimumTotal = minimumTargets.reduce((sum, value) => sum + value, 0);
  const allocations = minimumTotal <= evidenceBudgetChars
    ? [...minimumTargets]
    : distributeFairly(minimumTargets, evidenceBudgetChars);
  if (minimumTotal <= evidenceBudgetChars) {
    distributeWeighted(allocations, targets, items, evidenceBudgetChars);
  }

  const excerpts = new Map<string, EvidenceExcerpt>();
  let originalChars = 0;
  let includedChars = 0;
  let truncatedItems = 0;
  for (let index = 0; index < items.length; index++) {
    const item = items[index];
    const allocation = allocations[index] ?? 0;
    const excerpt = balancedExcerpt(item.content, allocation, item.relevanceText);
    const truncated = excerpt.includedChars < item.content.length;
    excerpts.set(item.id, {
      id: item.id,
      text: excerpt.text,
      originalChars: item.content.length,
      includedChars: excerpt.includedChars,
      truncated,
    });
    originalChars += item.content.length;
    includedChars += excerpt.includedChars;
    if (truncated) truncatedItems++;
  }

  return {
    excerpts,
    contextBudgetTokens,
    promptBudgetChars,
    evidenceBudgetChars,
    originalChars,
    includedChars,
    truncatedItems,
  };
}

export function evidenceExcerptLabel(excerpt: EvidenceExcerpt): string {
  return excerpt.truncated
    ? `balanced excerpt: ${excerpt.includedChars.toLocaleString('en-US')} of ${excerpt.originalChars.toLocaleString('en-US')} source chars; omitted spans are marked`
    : `complete: ${excerpt.originalChars.toLocaleString('en-US')} source chars`;
}
