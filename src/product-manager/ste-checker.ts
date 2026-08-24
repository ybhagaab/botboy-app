import type {
  DocumentFinding,
  FindingSeverity,
  GlossaryEntry,
  SteCheckRequest,
  SteCheckResult,
  SteChecker,
  SteDictionaryEntry,
  SteSegmentClass,
  TextLocation,
} from './types.js';

export const STE_CHECKER_VERSION = 'botboy-ste-checker.v1.0.0';

interface TextSegment {
  text: string;
  startOffset: number;
  endOffset: number;
  segmentClass: SteSegmentClass;
  protected: boolean;
}

interface InlineRange {
  start: number;
  end: number;
  segmentClass: SteSegmentClass;
}

const DEFAULT_ENFORCED_SECTIONS = new Set<SteSegmentClass>([
  'procedural_instruction',
  'safety_instruction',
  'requirement',
  'acceptance_criterion',
]);
const PROTECTED_CLASSES = new Set<SteSegmentClass>([
  'code',
  'identifier',
  'citation',
  'quoted_source',
  'proper_name',
  'unit_or_measure',
]);
const INSTRUCTION_CLASSES = new Set<SteSegmentClass>([
  'procedural_instruction',
  'safety_instruction',
  'requirement',
  'acceptance_criterion',
]);

function normalize(value: string): string {
  return value.normalize('NFKC').trim().toLocaleLowerCase('en-US').replace(/\s+/g, ' ');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function linesWithOffsets(content: string): Array<{ text: string; start: number; end: number }> {
  const lines: Array<{ text: string; start: number; end: number }> = [];
  let start = 0;
  while (start <= content.length) {
    const newline = content.indexOf('\n', start);
    const end = newline === -1 ? content.length : newline;
    lines.push({ text: content.slice(start, end), start, end });
    if (newline === -1) break;
    start = newline + 1;
  }
  return lines;
}

function addInlineMatches(ranges: InlineRange[], text: string, regex: RegExp, segmentClass: SteSegmentClass): void {
  regex.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    ranges.push({ start: match.index, end: match.index + match[0].length, segmentClass });
    if (match[0].length === 0) regex.lastIndex += 1;
  }
}

function inlineProtectedRanges(text: string): InlineRange[] {
  const ranges: InlineRange[] = [];
  addInlineMatches(ranges, text, /`[^`\n]+`/g, 'code');
  addInlineMatches(ranges, text, /https?:\/\/[^\s)>]+/gi, 'citation');
  addInlineMatches(ranges, text, /\[[^\]\n]+\]\([^)\n]+\)/g, 'citation');
  addInlineMatches(ranges, text, /\[(?:\d+(?:\s*[-,]\s*\d+)*)\]/g, 'citation');
  addInlineMatches(ranges, text, /(?:“[^”\n]+”|"[^"\n]+")/g, 'quoted_source');
  addInlineMatches(ranges, text, /\b(?:[A-Z][A-Z0-9]*_[A-Z0-9_]+|[a-z][a-z0-9]*(?:[A-Z][a-z0-9]+)+)\b/g, 'identifier');
  addInlineMatches(ranges, text, /\b\d+(?:\.\d+)?\s?(?:%|ms|s|min|h|g|kg|mm|cm|m|km|MB|GB|TB|°C|°F)\b/g, 'unit_or_measure');
  ranges.sort((left, right) => left.start - right.start || right.end - left.end);
  const merged: InlineRange[] = [];
  for (const range of ranges) {
    const previous = merged.at(-1);
    if (previous && range.start < previous.end) {
      if (range.end > previous.end) previous.end = range.end;
      continue;
    }
    merged.push({ ...range });
  }
  return merged;
}

function splitInline(text: string, absoluteStart: number, baseClass: SteSegmentClass): TextSegment[] {
  const ranges = inlineProtectedRanges(text);
  if (ranges.length === 0) {
    return text.trim().length === 0 ? [] : [{
      text,
      startOffset: absoluteStart,
      endOffset: absoluteStart + text.length,
      segmentClass: baseClass,
      protected: PROTECTED_CLASSES.has(baseClass),
    }];
  }
  const segments: TextSegment[] = [];
  let cursor = 0;
  for (const range of ranges) {
    if (range.start > cursor) {
      const unprotected = text.slice(cursor, range.start);
      if (unprotected.trim()) segments.push({
        text: unprotected,
        startOffset: absoluteStart + cursor,
        endOffset: absoluteStart + range.start,
        segmentClass: baseClass,
        protected: PROTECTED_CLASSES.has(baseClass),
      });
    }
    segments.push({
      text: text.slice(range.start, range.end),
      startOffset: absoluteStart + range.start,
      endOffset: absoluteStart + range.end,
      segmentClass: range.segmentClass,
      protected: true,
    });
    cursor = range.end;
  }
  if (cursor < text.length && text.slice(cursor).trim()) segments.push({
    text: text.slice(cursor),
    startOffset: absoluteStart + cursor,
    endOffset: absoluteStart + text.length,
    segmentClass: baseClass,
    protected: PROTECTED_CLASSES.has(baseClass),
  });
  return segments;
}

function classifyLine(line: string, section: string): SteSegmentClass {
  const trimmed = line.trim();
  if (/^(?:WARNING|CAUTION|DANGER)\b[:\s-]*/i.test(trimmed) || /safety|warning|caution|danger/.test(section)) {
    return 'safety_instruction';
  }
  if (/acceptance|test scenario/.test(section) || /^(?:AC[-_ ]?\d+|Given\b|When\b.+\bThen\b)/i.test(trimmed)) {
    return 'acceptance_criterion';
  }
  if (/requirements?/.test(section) || /\b(?:REQ[-_ ]?\d+|MUST(?:\s+NOT)?)\b/i.test(trimmed)) return 'requirement';
  if (/procedure|instruction|steps?/.test(section) || /^\s*(?:[-*+] |\d+[.)]\s+)/.test(line)) return 'procedural_instruction';
  if (/^(?:\*\*)?[^:]{1,60}:(?:\*\*)?\s*$/.test(trimmed)) return 'label';
  return 'descriptive_prose';
}

function tableSegments(line: string, lineStart: number): TextSegment[] {
  const segments: TextSegment[] = [];
  let cellStart = 0;
  for (let index = 0; index <= line.length; index += 1) {
    if (index !== line.length && line[index] !== '|') continue;
    const raw = line.slice(cellStart, index);
    const leading = raw.match(/^\s*/)?.[0].length ?? 0;
    const trailing = raw.match(/\s*$/)?.[0].length ?? 0;
    const end = Math.max(leading, raw.length - trailing);
    const text = raw.slice(leading, end);
    if (text && !/^:?-{3,}:?$/.test(text)) {
      segments.push(...splitInline(text, lineStart + cellStart + leading, 'table_cell'));
    }
    cellStart = index + 1;
  }
  return segments;
}

function segmentMarkdown(content: string): TextSegment[] {
  const segments: TextSegment[] = [];
  let inFence = false;
  let fenceMarker = '';
  let section = '';
  for (const line of linesWithOffsets(content)) {
    const fence = line.text.match(/^\s*(```+|~~~+)/);
    if (fence) {
      if (!inFence) {
        inFence = true;
        fenceMarker = fence[1][0];
      } else if (fence[1][0] === fenceMarker) {
        inFence = false;
        fenceMarker = '';
      }
      segments.push({ text: line.text, startOffset: line.start, endOffset: line.end, segmentClass: 'code', protected: true });
      continue;
    }
    if (inFence || /^ {4}\S/.test(line.text)) {
      segments.push({ text: line.text, startOffset: line.start, endOffset: line.end, segmentClass: 'code', protected: true });
      continue;
    }
    if (!line.text.trim()) continue;
    const heading = line.text.match(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/);
    if (heading) {
      section = normalize(heading[1]);
      const headingStart = line.text.indexOf(heading[1]);
      segments.push(...splitInline(heading[1], line.start + headingStart, 'heading'));
      continue;
    }
    if (/^\s*>/.test(line.text)) {
      segments.push({ text: line.text, startOffset: line.start, endOffset: line.end, segmentClass: 'quoted_source', protected: true });
      continue;
    }
    if (line.text.includes('|') && /^\s*\|?.+\|.+\|?\s*$/.test(line.text)) {
      segments.push(...tableSegments(line.text, line.start));
      continue;
    }
    const segmentClass = classifyLine(line.text, section);
    segments.push(...splitInline(line.text, line.start, segmentClass));
  }
  return segments;
}

function lineStarts(content: string): number[] {
  const starts = [0];
  for (let index = 0; index < content.length; index += 1) if (content[index] === '\n') starts.push(index + 1);
  return starts;
}

function offsetPosition(starts: number[], offset: number): { line: number; column: number } {
  let low = 0;
  let high = starts.length - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (starts[middle] <= offset) low = middle + 1;
    else high = middle - 1;
  }
  const lineIndex = Math.max(0, high);
  return { line: lineIndex + 1, column: offset - starts[lineIndex] + 1 };
}

function locationFor(starts: number[], startOffset: number, endOffset: number): TextLocation {
  const start = offsetPosition(starts, startOffset);
  const end = offsetPosition(starts, Math.max(startOffset, endOffset));
  return {
    line: start.line,
    column: start.column,
    endLine: end.line,
    endColumn: end.column,
    startOffset,
    endOffset,
  };
}

function sentenceRanges(text: string): Array<{ text: string; start: number; end: number }> {
  const ranges: Array<{ text: string; start: number; end: number }> = [];
  const regex = /[^.!?]+(?:[.!?]+|$)/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    const leading = match[0].match(/^\s*/)?.[0].length ?? 0;
    const value = match[0].slice(leading).trimEnd();
    if (value) ranges.push({ text: value, start: match.index + leading, end: match.index + leading + value.length });
    if (match[0].length === 0) regex.lastIndex += 1;
  }
  return ranges;
}

function words(text: string): RegExpMatchArray[] {
  return [...text.matchAll(/\b[A-Za-z]+(?:-[A-Za-z]+)*(?:'[A-Za-z]+)?\b/g)];
}

function glossaryRanges(content: string, entries: GlossaryEntry[]): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  for (const entry of entries) {
    if (!['approved', 'exception', 'ste_approved'].includes(entry.approvalState)) continue;
    for (const value of [entry.term, ...entry.approvedForms]) {
      if (!value.trim()) continue;
      const regex = new RegExp(`\\b${escapeRegExp(value).replace(/\\ /g, '\\s+')}\\b`, 'gi');
      let match: RegExpExecArray | null;
      while ((match = regex.exec(content)) !== null) ranges.push({ start: match.index, end: match.index + match[0].length });
    }
  }
  return ranges;
}

function isCovered(offset: number, ranges: Array<{ start: number; end: number }>): boolean {
  return ranges.some((range) => offset >= range.start && offset < range.end);
}

function dictionaryMaps(entries: SteDictionaryEntry[]): {
  approved: Set<string>;
  nonApproved: Map<string, SteDictionaryEntry[]>;
  multiWord: Map<string, SteDictionaryEntry[]>;
} {
  const approved = new Set<string>();
  const nonApproved = new Map<string, SteDictionaryEntry[]>();
  const multiWord = new Map<string, SteDictionaryEntry[]>();
  for (const entry of entries) {
    const keys = [entry.term, ...(entry.forms ?? [])].map(normalize).filter(Boolean);
    for (const key of keys) {
      if (entry.approved) approved.add(key);
      else {
        const baseKey = key.replace(/\s+\([^)]*\)$/, '');
        const target = baseKey.includes(' ') ? multiWord : nonApproved;
        const list = target.get(baseKey) ?? [];
        list.push(entry);
        target.set(baseKey, list);
      }
    }
  }
  return { approved, nonApproved, multiWord };
}

function conformanceStatement(request: SteCheckRequest, resultStatus: SteCheckResult['status']): string {
  const readiness = request.bundleReadiness;
  if (request.mode === 'off') return 'ASD-STE100 checking was not requested. No conformance status is reported.';
  if (request.mode === 'enforced_full' && !readiness?.ready) {
    return 'Full Issue 9 checking was blocked because an approved local bundle is unavailable. No conformance claim is made.';
  }
  const bundleState = readiness?.ready ? 'approved' : readiness?.available ? 'pending or invalid' : 'unavailable';
  if (request.mode === 'advisory') {
    return `Advisory deterministic language checks completed. Local Issue 9 bundle: ${bundleState}. No full conformance claim is made.`;
  }
  if (request.mode === 'enforced_sections') {
    return `Configured section checks completed with status ${resultStatus}. Local Issue 9 bundle: ${bundleState}. No whole-document conformance claim is made.`;
  }
  return `Checked against the configured ASD-STE100 Issue 9 bundle with full enforcement. Human bundle review: approved. Result: ${resultStatus}. This is an internal check, not ASD certification or approval.`;
}

export function createSteChecker(): SteChecker {
  return {
    check(request): SteCheckResult {
      if (request.mode === 'off') {
        return {
          status: 'not_checked',
          findings: [],
          checkerVersion: STE_CHECKER_VERSION,
          conformanceStatement: conformanceStatement(request, 'not_checked'),
          protectedSegmentCount: 0,
          checkedSegmentCount: 0,
        };
      }

      const segments = segmentMarkdown(request.content);
      const starts = lineStarts(request.content);
      const findings: DocumentFinding[] = [];
      const seen = new Set<string>();
      const enforcedClasses = new Set(request.enforcedSegmentClasses ?? [...DEFAULT_ENFORCED_SECTIONS]);
      const approvedGlossaryRanges = glossaryRanges(request.content, request.glossary?.entries ?? []);

      const severityFor = (segmentClass: SteSegmentClass, dictionaryFinding = false): FindingSeverity => {
        if (request.mode === 'advisory') return 'warning';
        if (request.mode === 'enforced_full') return 'error';
        if (enforcedClasses.has(segmentClass) && (!dictionaryFinding || request.bundleReadiness?.ready)) return 'error';
        return 'warning';
      };
      const addFinding = (
        code: string,
        message: string,
        segmentClass: SteSegmentClass,
        startOffset: number,
        endOffset: number,
        options: { ruleReference?: string; suggestion?: string; heuristic?: boolean; severity?: FindingSeverity; metadata?: Record<string, unknown> } = {},
      ) => {
        const key = `${code}:${startOffset}:${endOffset}`;
        if (seen.has(key)) return;
        seen.add(key);
        findings.push({
          code,
          category: 'ste',
          severity: options.severity ?? severityFor(segmentClass),
          message,
          location: locationFor(starts, startOffset, endOffset),
          segmentClass,
          ...(options.ruleReference ? { ruleReference: options.ruleReference } : {}),
          ...(options.suggestion ? { suggestion: options.suggestion.slice(0, 240) } : {}),
          ...(options.heuristic === undefined ? {} : { heuristic: options.heuristic }),
          ...(options.metadata ? { metadata: options.metadata } : {}),
        });
      };

      if (request.mode === 'enforced_full' && !request.bundleReadiness?.ready) {
        addFinding(
          'STE_BUNDLE_NOT_READY',
          'Full enforcement requires a structurally valid, expected-fingerprint, explicitly human-approved local Issue 9 bundle.',
          'label',
          0,
          0,
          { severity: 'block', suggestion: 'Extract the local bundle, verify it against the PDF, and run the explicit approval workflow.' },
        );
      } else if (!request.bundleReadiness?.ready) {
        const state = request.bundleReadiness?.available ? 'not approved or invalid' : 'not available';
        addFinding(
          'STE_BUNDLE_LIMITED',
          `The local Issue 9 bundle is ${state}; deterministic built-in checks run, but dictionary coverage is not an approved full check.`,
          'label',
          0,
          0,
          { severity: 'info' },
        );
      }

      const modality = /\b(shall|should)\b|\bmay\s+(?:not\s+)?[A-Za-z]+/gi;
      const contractions = /\b(?:ain't|aren't|can't|couldn't|didn't|doesn't|don't|hadn't|hasn't|haven't|he's|here's|how's|i'm|isn't|it's|mustn't|shan't|she's|shouldn't|that's|there's|they're|they've|wasn't|we're|we've|weren't|what's|where's|who's|won't|wouldn't|you're|you've)\b/gi;
      const presentPerfect = /\b(?:have|has)\s+(?:not\s+)?(?:been|done|seen|gone|made|built|written|given|taken|found|had|[A-Za-z]+(?:ed|en))\b/gi;

      for (const segment of segments) {
        if (segment.protected || segment.segmentClass === 'heading' || segment.segmentClass === 'label') continue;
        let match: RegExpExecArray | null;
        modality.lastIndex = 0;
        while ((match = modality.exec(segment.text)) !== null) {
          const token = match[0];
          addFinding(
            'STE_MODALITY',
            `Disallowed or ambiguous modality: ${token}.`,
            segment.segmentClass,
            segment.startOffset + match.index,
            segment.startOffset + match.index + token.length,
            { suggestion: /^may\b/i.test(token) ? 'Use CAN when the meaning is permission or possibility.' : 'Use MUST/MUST NOT for an obligation or prohibition; otherwise state the intended meaning directly.' },
          );
        }
        contractions.lastIndex = 0;
        while ((match = contractions.exec(segment.text)) !== null) {
          addFinding(
            'STE_CONTRACTION',
            `Do not use the contraction “${match[0]}” in checked prose.`,
            segment.segmentClass,
            segment.startOffset + match.index,
            segment.startOffset + match.index + match[0].length,
            { ruleReference: '4.2', suggestion: 'Write the words in full.' },
          );
        }
        for (let index = segment.text.indexOf(';'); index >= 0; index = segment.text.indexOf(';', index + 1)) {
          addFinding(
            'STE_SEMICOLON',
            'Do not use a semicolon in checked prose.',
            segment.segmentClass,
            segment.startOffset + index,
            segment.startOffset + index + 1,
            { ruleReference: '8.1', suggestion: 'Use a period, comma, or list construction without changing the meaning.' },
          );
        }
        presentPerfect.lastIndex = 0;
        while ((match = presentPerfect.exec(segment.text)) !== null) {
          addFinding(
            'STE_PRESENT_PERFECT_HEURISTIC',
            `Possible present-perfect construction: “${match[0]}”.`,
            segment.segmentClass,
            segment.startOffset + match.index,
            segment.startOffset + match.index + match[0].length,
            { suggestion: 'Use simple past or simple present if it preserves the evidence state and time meaning.', heuristic: true },
          );
        }

        const maximum = INSTRUCTION_CLASSES.has(segment.segmentClass)
          ? 20
          : segment.segmentClass === 'descriptive_prose' ? 25 : undefined;
        if (maximum !== undefined) {
          for (const sentence of sentenceRanges(segment.text)) {
            const count = words(sentence.text).length;
            if (count > maximum) {
              addFinding(
                INSTRUCTION_CLASSES.has(segment.segmentClass) ? 'STE_PROCEDURAL_SENTENCE_LENGTH' : 'STE_DESCRIPTIVE_SENTENCE_LENGTH',
                `This ${segment.segmentClass.replace(/_/g, ' ')} sentence has ${count} words; the configured limit is ${maximum}.`,
                segment.segmentClass,
                segment.startOffset + sentence.start,
                segment.startOffset + sentence.end,
                { ruleReference: INSTRUCTION_CLASSES.has(segment.segmentClass) ? '5.1' : '6.3', suggestion: 'Split the sentence without changing facts, modality, conditions, or commitments.' },
              );
            }
          }
        }

        if (INSTRUCTION_CLASSES.has(segment.segmentClass)) {
          for (const sentence of sentenceRanges(segment.text)) {
            const cleaned = sentence.text.replace(/^\s*(?:[-*+] |\d+[.)]\s+)/, '').trim();
            const condition = /\b(?:if|when|unless|after|before)\b/i.exec(cleaned);
            if (condition && condition.index > 0) {
              addFinding(
                'STE_CONDITION_ORDER_HEURISTIC',
                'A condition appears after the command; checked instructions put the condition first.',
                segment.segmentClass,
                segment.startOffset + sentence.start + condition.index,
                segment.startOffset + sentence.start + condition.index + condition[0].length,
                { ruleReference: '5.4', suggestion: 'Move the condition before the command without changing its scope.', heuristic: true },
              );
            }
            if (['procedural_instruction', 'safety_instruction'].includes(segment.segmentClass)) {
              const afterCondition = cleaned.replace(/^(?:if|when|unless|after|before)\b[^,]*,\s*/i, '');
              if (!/\bMUST(?:\s+NOT)?\b/.test(afterCondition)
                && /^(?:the|a|an|this|that|these|those|you|we|they|it|there)\b/i.test(afterCondition)) {
                addFinding(
                  'STE_IMPERATIVE_HEURISTIC',
                  'This instruction does not appear to start with an imperative command.',
                  segment.segmentClass,
                  segment.startOffset + sentence.start,
                  segment.startOffset + sentence.end,
                  { ruleReference: '5.3', suggestion: 'Start with one direct command verb after any initial condition.', heuristic: true },
                );
              }
            }
          }
        }
      }

      const paragraphRegex = /(?:^|\n\s*\n)([^\n](?:[\s\S]*?))(?=\n\s*\n|$)/g;
      let paragraphMatch: RegExpExecArray | null;
      while ((paragraphMatch = paragraphRegex.exec(request.content)) !== null) {
        const paragraph = paragraphMatch[1];
        const paragraphStart = paragraphMatch.index + paragraphMatch[0].indexOf(paragraph);
        const paragraphEnd = paragraphStart + paragraph.length;
        const applicable = segments.filter((segment) => !segment.protected
          && segment.segmentClass === 'descriptive_prose'
          && segment.startOffset >= paragraphStart
          && segment.endOffset <= paragraphEnd);
        if (applicable.length === 0) continue;
        const nonDescriptive = segments.some((segment) => !segment.protected
          && segment.segmentClass !== 'descriptive_prose'
          && segment.startOffset >= paragraphStart
          && segment.endOffset <= paragraphEnd);
        if (nonDescriptive) continue;
        const sentenceCount = sentenceRanges(applicable.map((segment) => segment.text).join(' ')).length;
        if (sentenceCount > 6) {
          addFinding(
            'STE_PARAGRAPH_SENTENCE_COUNT',
            `This descriptive paragraph has ${sentenceCount} sentences; the configured limit is six.`,
            'descriptive_prose',
            paragraphStart,
            paragraphEnd,
            { ruleReference: '6.6', suggestion: 'Split the paragraph by topic without changing the argument.' },
          );
        }
      }

      for (const glossaryEntry of request.glossary?.entries ?? []) {
        for (const synonym of glossaryEntry.prohibitedSynonyms) {
          if (!synonym.trim()) continue;
          const regex = new RegExp(`\\b${escapeRegExp(synonym).replace(/\\ /g, '\\s+')}\\b`, 'gi');
          let match: RegExpExecArray | null;
          while ((match = regex.exec(request.content)) !== null) {
            const segment = segments.find((candidate) => !candidate.protected && match!.index >= candidate.startOffset && match!.index < candidate.endOffset);
            if (!segment) continue;
            addFinding(
              'STE_TERMINOLOGY_CONSISTENCY',
              `Use the approved term “${glossaryEntry.term}” instead of prohibited synonym “${match[0]}”.`,
              segment.segmentClass,
              match.index,
              match.index + match[0].length,
              { suggestion: `Use ${glossaryEntry.term} if it preserves the intended meaning.` },
            );
          }
        }
      }

      const dictionary = request.bundleReadiness?.bundle?.dictionary ?? [];
      if (dictionary.length > 0) {
        const maps = dictionaryMaps(dictionary);
        for (const segment of segments) {
          if (segment.protected) continue;
          for (const word of words(segment.text)) {
            const absoluteOffset = segment.startOffset + (word.index ?? 0);
            if (isCovered(absoluteOffset, approvedGlossaryRanges)) continue;
            const key = normalize(word[0]);
            if (maps.approved.has(key)) continue;
            const entries = maps.nonApproved.get(key);
            if (!entries || entries.length === 0) continue;
            const suggestions = [...new Set(entries.flatMap((entry) => entry.alternatives ?? []))]
              .filter((value) => value && value !== '[recast sentence]')
              .slice(0, 3);
            addFinding(
              'STE_DICTIONARY_NON_APPROVED',
              `The dictionary bundle marks “${word[0]}” as non-approved for at least one listed use.`,
              segment.segmentClass,
              absoluteOffset,
              absoluteOffset + word[0].length,
              {
                ruleReference: entries.find((entry) => entry.ruleReference)?.ruleReference,
                suggestion: suggestions.length > 0 ? `Review the meaning and consider: ${suggestions.join(', ')}.` : 'Recast the sentence with an approved word while preserving meaning.',
                heuristic: entries.some((entry) => maps.approved.has(entry.normalizedTerm)),
                severity: severityFor(segment.segmentClass, true),
                metadata: { token: word[0], listedPartsOfSpeech: [...new Set(entries.flatMap((entry) => entry.partOfSpeech ?? []))] },
              },
            );
          }
          for (const [phrase, entries] of maps.multiWord) {
            const regex = new RegExp(`\\b${escapeRegExp(phrase).replace(/\\ /g, '\\s+')}\\b`, 'gi');
            let match: RegExpExecArray | null;
            while ((match = regex.exec(segment.text)) !== null) {
              const absoluteOffset = segment.startOffset + match.index;
              if (isCovered(absoluteOffset, approvedGlossaryRanges)) continue;
              const suggestions = [...new Set(entries.flatMap((entry) => entry.alternatives ?? []))]
                .filter((value) => value && value !== '[recast sentence]')
                .slice(0, 3);
              addFinding(
                'STE_DICTIONARY_NON_APPROVED',
                `The dictionary bundle marks “${match[0]}” as non-approved for at least one listed use.`,
                segment.segmentClass,
                absoluteOffset,
                absoluteOffset + match[0].length,
                {
                  suggestion: suggestions.length > 0 ? `Review the meaning and consider: ${suggestions.join(', ')}.` : 'Recast the sentence with approved vocabulary while preserving meaning.',
                  severity: severityFor(segment.segmentClass, true),
                  metadata: { token: match[0] },
                },
              );
            }
          }
        }
      }

      for (const candidate of request.glossary?.candidateTerms ?? []) {
        const regex = new RegExp(`\\b${escapeRegExp(candidate.term).replace(/\\ /g, '\\s+')}\\b`, 'g');
        let match: RegExpExecArray | null;
        while ((match = regex.exec(request.content)) !== null) {
          const segment = segments.find((item) => !item.protected && match!.index >= item.startOffset && match!.index < item.endOffset);
          if (!segment) continue;
          addFinding(
            'STE_TECHNICAL_TERM_UNAPPROVED',
            `Technical-term candidate “${candidate.term}” is not approved for enforced use.`,
            segment.segmentClass,
            match.index,
            match.index + match[0].length,
            { suggestion: 'Approve the term in the product glossary or use approved terminology.', severity: severityFor(segment.segmentClass, true) },
          );
        }
      }

      findings.sort((left, right) => (left.location?.startOffset ?? -1) - (right.location?.startOffset ?? -1)
        || left.code.localeCompare(right.code));
      const blocked = findings.some((finding) => finding.severity === 'block' || finding.severity === 'error');
      const status: SteCheckResult['status'] = blocked ? 'blocked' : findings.length > 0 ? 'pass_with_advisories' : 'pass';
      return {
        status,
        findings,
        checkerVersion: STE_CHECKER_VERSION,
        conformanceStatement: conformanceStatement(request, status),
        protectedSegmentCount: segments.filter((segment) => segment.protected).length,
        checkedSegmentCount: segments.filter((segment) => !segment.protected).length,
      };
    },
  };
}
