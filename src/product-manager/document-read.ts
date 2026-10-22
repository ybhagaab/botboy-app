/**
 * What read_product_document shows the model (docs/maps/product-manager.md,
 * "Model reads and targeted edits").
 *
 * Owner report 2026-10-21: BotBoy had no way to read a document it had saved,
 * so it opened its own reader in a Chrome scratch tab (ui_inspect returns
 * layout, not text; two of thirteen calls timed out). These reads come from
 * the store, never a browser:
 *   - one version as numbered lines ("12: text"), with its version number,
 *     whether it is the newest and which one is, and the citations its lines
 *     use; a long document comes in parts, never cut silently (nextStartLine);
 *   - without an artifactId, the recent documents matching a title query,
 *     each with its newest artifactId.
 * Every result fits under the 40,000-character tool-result cap.
 */
import type { DocumentCitation, ProductDocumentArtifact, ProductDocumentSummary } from './types.js';

/** Room below the 40,000-character tool-result cap. */
export const DOCUMENT_READ_BUDGET_CHARS = 36_000;
const CITATIONS_BUDGET_CHARS = 6_000;
const LIST_LIMIT = 20;

export interface DocumentReadRange {
  startLine?: number;
  endLine?: number;
}

function documentsUrl(artifactId: string): string {
  return `#/documents/${encodeURIComponent(artifactId)}`;
}

/** Version number (oldest = 1), chain length, and the newest version when this is not it. */
export function documentVersionOf(artifactId: string, chain: readonly ProductDocumentSummary[]): Record<string, unknown> {
  const index = chain.findIndex((member) => member.artifactId === artifactId);
  if (index < 0) return { number: 1, of: 1, newest: true };
  const newest = chain[0];
  return {
    number: chain.length - index,
    of: chain.length,
    newest: index === 0,
    ...(index === 0 ? {} : { newestArtifactId: newest.artifactId, newestSavedAt: newest.createdAt }),
  };
}

function compactCitation(citation: DocumentCitation): Record<string, string> {
  return {
    id: citation.id,
    label: citation.label,
    ...(citation.source ? { source: citation.source } : {}),
    ...(citation.date ? { date: citation.date } : {}),
    ...(citation.url ? { url: citation.url } : {}),
    ...(citation.workItemId ? { workItemId: citation.workItemId } : {}),
  };
}

/** The citations whose [id] marker appears in the shown text, within their own small budget. */
function citationsFor(shown: string, citations: readonly DocumentCitation[]): { list: Array<Record<string, string>>; omitted: number } {
  const used = citations.filter((citation) => shown.includes(`[${citation.id}]`));
  const list: Array<Record<string, string>> = [];
  let size = 2;
  for (const citation of used) {
    const compact = compactCitation(citation);
    const cost = JSON.stringify(compact).length + 1;
    if (size + cost > CITATIONS_BUDGET_CHARS) break;
    list.push(compact);
    size += cost;
  }
  return { list, omitted: used.length - list.length };
}

/** The longest prefix of value whose JSON string form fits in max characters, never ending inside a surrogate pair. */
function fittingPrefix(value: string, max: number): string {
  if (JSON.stringify(value).length <= max) return value;
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (JSON.stringify(value.slice(0, middle)).length <= max) low = middle;
    else high = middle - 1;
  }
  return value.slice(0, low);
}

function readFailure(error: string, nextAction: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ ok: false, error, nextAction, ...extra });
}

/**
 * One version as numbered lines from startLine: as many whole lines as fit,
 * up to endLine. A single line longer than one read (embedded data) is shown
 * cut, and the result says so.
 */
export function productDocumentReadForModel(
  artifact: ProductDocumentArtifact,
  chain: readonly ProductDocumentSummary[],
  range: DocumentReadRange = {},
  budget = DOCUMENT_READ_BUDGET_CHARS,
): string {
  const lines = artifact.content.split('\n');
  const totalLines = lines.length;
  const startLine = Math.max(1, Math.floor(range.startLine ?? 1));
  if (startLine > totalLines) {
    return readFailure(
      `startLine ${startLine} is past the end: this version has ${totalLines} lines.`,
      `Read with a startLine from 1 to ${totalLines}.`,
      { artifactId: artifact.artifactId, totalLines },
    );
  }
  const lastWanted = range.endLine === undefined ? totalLines : Math.min(totalLines, Math.floor(range.endLine));
  if (lastWanted < startLine) {
    return readFailure(`endLine ${range.endLine} is before startLine ${startLine}.`, 'Send an endLine at or after startLine, or omit it.', { artifactId: artifact.artifactId, totalLines });
  }
  const version = documentVersionOf(artifact.artifactId, chain);
  const head = {
    ok: true,
    artifactId: artifact.artifactId,
    title: artifact.title,
    documentsUrl: documentsUrl(artifact.artifactId),
    ...(artifact.projectId ? { projectId: artifact.projectId } : { unassigned: true }),
    profileId: artifact.profileId,
    maturity: artifact.maturity,
    savedAt: artifact.createdAt,
    ...(artifact.revisionOrigin ? { revisionOrigin: artifact.revisionOrigin } : {}),
    ...(artifact.parentArtifactId ? { parentArtifactId: artifact.parentArtifactId } : {}),
    version,
    totalLines,
    totalChars: artifact.content.length,
  };
  const citations = artifact.citations ?? [];
  const editHint = version.newest
    ? 'To change text, copy it exactly from these lines, without the "N: " prefix, into edit_product_document with this artifactId.'
    : `This is not the newest version: edit_product_document needs the newest, ${String(version.newestArtifactId)}.`;
  const wanted = lastWanted - startLine + 1;

  const build = (count: number, cutLine?: { text: string; chars: number }) => {
    const shownLines = cutLine
      ? [`${startLine}: ${cutLine.text}`]
      : lines.slice(startLine - 1, startLine - 1 + count).map((line, offset) => `${startLine + offset}: ${line}`);
    const shownCount = cutLine ? 1 : count;
    const endLine = startLine + shownCount - 1;
    const more = endLine < totalLines;
    const byBudget = cutLine !== undefined || shownCount < wanted;
    const text = shownLines.join('\n');
    const used = citationsFor(text, citations);
    const readNote = !more && startLine === 1
      ? `Lines 1–${totalLines} of ${totalLines}: the whole document.`
      : `Lines ${startLine}–${endLine} of ${totalLines}${byBudget ? ', as many as fit in one read' : ''}.${more ? ` Read on with startLine ${endLine + 1}.` : ' This is the end of the document.'}`;
    return JSON.stringify({
      ...head,
      startLine,
      endLine,
      nextStartLine: more ? endLine + 1 : null,
      readNote,
      ...(cutLine ? { lineCut: { line: startLine, chars: cutLine.chars, shownChars: cutLine.text.length, note: `Line ${startLine} is ${cutLine.chars.toLocaleString('en-US')} characters, longer than one read; only its start is shown. Edit text outside it, or a short exact piece of its start.` } } : {}),
      editHint,
      ...(citations.length ? { citationCount: citations.length } : {}),
      ...(used.list.length ? { citations: used.list } : {}),
      ...(used.omitted ? { citationsOmitted: used.omitted } : {}),
      lines: text,
    });
  };

  let low = 0;
  let high = wanted;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (build(middle).length <= budget) low = middle;
    else high = middle - 1;
  }
  if (low > 0) return build(low);
  // The first wanted line alone does not fit: show its start. The citations
  // its start uses are bounded by their own budget, so reserve that too.
  const line = lines[startLine - 1];
  const overhead = build(1, { text: '', chars: line.length }).length;
  const room = Math.max(1_000, budget - overhead - CITATIONS_BUDGET_CHARS - 64);
  return build(1, { text: fittingPrefix(line, room), chars: line.length });
}

/** Group a page of summaries into chains by parent links inside the page; the head is the newest member. */
function chainsOf(summaries: readonly ProductDocumentSummary[]): ProductDocumentSummary[][] {
  const byId = new Map(summaries.map((summary) => [summary.artifactId, summary]));
  const groups = new Map<string, ProductDocumentSummary[]>();
  for (const summary of summaries) {
    let root = summary;
    const seen = new Set<string>();
    while (root.parentArtifactId && byId.has(root.parentArtifactId) && !seen.has(root.parentArtifactId)) {
      seen.add(root.parentArtifactId);
      root = byId.get(root.parentArtifactId)!;
    }
    const members = groups.get(root.artifactId) ?? [];
    members.push(summary);
    groups.set(root.artifactId, members);
  }
  const newestFirst = (left: ProductDocumentSummary, right: ProductDocumentSummary) => (left.createdAt === right.createdAt
    ? (left.artifactId < right.artifactId ? 1 : left.artifactId > right.artifactId ? -1 : 0)
    : (left.createdAt < right.createdAt ? 1 : -1));
  return [...groups.values()]
    .map((members) => members.sort(newestFirst))
    .sort((left, right) => newestFirst(left[0], right[0]));
}

/** The recent documents whose titles hold every query word, each with its newest artifactId. */
export function productDocumentListForModel(
  summaries: readonly ProductDocumentSummary[],
  versionCount: (artifactId: string) => number,
  options: { query?: string; projectId?: string } = {},
): string {
  const words = (options.query ?? '').toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const chains = chainsOf(summaries).filter((members) => {
    if (!words.length) return true;
    const haystack = members.map((member) => `${member.title} ${member.artifactId}`).join(' ').toLocaleLowerCase();
    return words.every((word) => haystack.includes(word));
  });
  const documents = chains.slice(0, LIST_LIMIT).map((members) => {
    const head = members[0];
    return {
      title: head.title,
      newestArtifactId: head.artifactId,
      savedAt: head.createdAt,
      versions: Math.max(versionCount(head.artifactId), members.length),
      ...(head.projectId ? { projectId: head.projectId } : { unassigned: true }),
      contentChars: head.contentChars,
      documentsUrl: documentsUrl(head.artifactId),
    };
  });
  return JSON.stringify({
    ok: true,
    mode: 'list',
    ...(options.query?.trim() ? { query: options.query.trim() } : {}),
    ...(options.projectId ? { projectId: options.projectId } : {}),
    matched: chains.length,
    documents,
    note: documents.length
      ? `Documents among the ${summaries.length} most recently saved versions${chains.length > documents.length ? `; the newest ${documents.length} are listed` : ''}. Read one with read_product_document and its newestArtifactId.`
      : `No document${words.length ? ` with "${options.query?.trim()}" in its title` : ''} among the ${summaries.length} most recently saved versions. Try other title words, or omit query to list recent documents.`,
  });
}
