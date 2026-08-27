/**
 * Edit-mode save decomposition (doc editor E2, DOC_EDITOR_UX_PLAN.md).
 *
 * Diff the ORIGINAL extracted markdown against the owner's DRAFT and emit
 * independent pending-edit payloads — one per contiguous change run — so the
 * approval lane reviews each change on its own and a single conflicted run
 * never blocks the rest.
 *
 * Grammar (mirrors document-parser emission): blocks are blank-line
 * separated; every non-table line maps 1:1 to a docx paragraph; list groups
 * are single blocks with one line per item; tables are single blocks and are
 * NOT editable (v1) — runs touching them are reported `unsupported`, never
 * silently staged.
 *
 * Classification:
 *   - single plain line ↔ single plain line (no inline markers in the new
 *     text, old text ≥20 chars) → `replaceText` (fine-grained lane review);
 *   - everything else → `replaceParagraphRange` (anchors = docx-text of the
 *     removed lines; empty replacement = deletion; insertions anchor on a
 *     neighbor block and re-include it);
 *   - trailing plain additions → `appendParagraphs`.
 *
 * Short-anchor auto-extension (second-pass rule): a run whose total anchor
 * text is <12 chars (a lone edited heading) is extended into a FREE,
 * non-table neighbor block for apply-time robustness. Extension is
 * best-effort — when no neighbor qualifies the short anchor stands, and
 * apply-time exactly-once matching remains the guard.
 */

import { markdownBlocksOf, markdownLineToDocxText, blockToAnchorParagraphs, type MarkdownBlock } from './markdown-anchor.js';

export interface DecomposedEdit {
  operation: 'replaceText' | 'replaceParagraphRange' | 'appendParagraphs';
  findText?: string;
  replaceWith?: string;
  paragraphs?: string[];
}

export interface UnsupportedRun {
  reason: string;
  text: string;
}

export interface DecomposeResult {
  edits: DecomposedEdit[];
  unsupported: UnsupportedRun[];
}

const squash = (value: string) => value.replace(/\s+/g, ' ').trim();
const INLINE_MARKER_RE = /\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`|\[[^\]]*\]\([^)]*\)/;

interface ChangeRun {
  aStart: number;
  aEnd: number; // exclusive
  bStart: number;
  bEnd: number; // exclusive
}

/** Classic LCS DP over squashed block texts → aligned common pairs. */
function commonBlockPairs(a: MarkdownBlock[], b: MarkdownBlock[]): Array<{ ai: number; bi: number }> {
  const n = a.length;
  const m = b.length;
  const eq = (i: number, j: number) => squash(a[i].text) === squash(b[j].text);
  // dp[i][j] = LCS length of a[i..] vs b[j..]
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = eq(i, j) ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const pairs: Array<{ ai: number; bi: number }> = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (eq(i, j)) { pairs.push({ ai: i, bi: j }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
    else j++;
  }
  return pairs;
}

function changeRuns(a: MarkdownBlock[], b: MarkdownBlock[]): ChangeRun[] {
  const pairs = commonBlockPairs(a, b);
  const runs: ChangeRun[] = [];
  let prevA = 0;
  let prevB = 0;
  for (const pair of [...pairs, { ai: a.length, bi: b.length }]) {
    if (pair.ai > prevA || pair.bi > prevB) {
      runs.push({ aStart: prevA, aEnd: pair.ai, bStart: prevB, bEnd: pair.bi });
    }
    prevA = pair.ai + 1;
    prevB = pair.bi + 1;
  }
  return runs;
}

export function decomposeEditedMarkdown(original: string, draft: string): DecomposeResult {
  const a = markdownBlocksOf(original);
  const b = markdownBlocksOf(draft);
  const edits: DecomposedEdit[] = [];
  const unsupported: UnsupportedRun[] = [];
  const claimed = new Set<number>(); // original-block indexes consumed by anchors/extensions

  // A change run that mixes table and non-table blocks (a table edit right
  // next to a text edit collapses into ONE LCS run — no common block between
  // them) must not swallow the text edit: segment both sides at table
  // boundaries and process aligned text segments normally. Misaligned
  // segmentation falls back to unsupported-as-a-whole.
  interface Segment { table: boolean; blocks: MarkdownBlock[]; aStart: number }
  const segmentAtTables = (blocks: MarkdownBlock[], startIdx: number): Segment[] => {
    const segs: Segment[] = [];
    for (let i = 0; i < blocks.length; i++) {
      const isTable = blocks[i].kind === 'table';
      const prev = segs[segs.length - 1];
      if (prev && prev.table === isTable) prev.blocks.push(blocks[i]);
      else segs.push({ table: isTable, blocks: [blocks[i]], aStart: startIdx + i });
    }
    return segs;
  };

  const runs = changeRuns(a, b);
  const workQueue: ChangeRun[] = [];
  for (const run of runs) {
    const removed = a.slice(run.aStart, run.aEnd);
    const added = b.slice(run.bStart, run.bEnd);
    const touchesTable = removed.some(x => x.kind === 'table') || added.some(x => x.kind === 'table');
    if (!touchesTable) { workQueue.push(run); continue; }

    const rSegs = segmentAtTables(removed, run.aStart);
    const aSegs = segmentAtTables(added, run.bStart);
    const aligned = rSegs.length === aSegs.length && rSegs.every((seg, i) => seg.table === aSegs[i].table);
    if (!aligned) {
      for (let i = run.aStart; i < run.aEnd; i++) claimed.add(i);
      unsupported.push({ reason: "this change involves a table and couldn't be split out — not staged", text: (removed.length ? removed : added).map(x => x.text).join('\n\n').slice(0, 400) });
      continue;
    }
    for (let i = 0; i < rSegs.length; i++) {
      if (rSegs[i].table) {
        for (let k = rSegs[i].aStart; k < rSegs[i].aStart + rSegs[i].blocks.length; k++) claimed.add(k);
        const changedTable = rSegs[i].blocks.map(x => squash(x.text)).join('\u0000') !== aSegs[i].blocks.map(x => squash(x.text)).join('\u0000');
        if (changedTable) {
          unsupported.push({ reason: "tables can't be edited yet — this change was not staged", text: rSegs[i].blocks.map(x => x.text).join('\n\n').slice(0, 400) });
        }
      } else {
        workQueue.push({ aStart: rSegs[i].aStart, aEnd: rSegs[i].aStart + rSegs[i].blocks.length, bStart: aSegs[i].aStart, bEnd: aSegs[i].aStart + aSegs[i].blocks.length });
      }
    }
  }

  for (const run of workQueue) {
    const removed = a.slice(run.aStart, run.aEnd);
    const added = b.slice(run.bStart, run.bEnd);
    for (let i = run.aStart; i < run.aEnd; i++) claimed.add(i);

    // Trailing pure addition → append (plain text only; styled additions
    // re-anchor on the last block so markdownToDocxParagraphs styles them).
    if (removed.length === 0 && run.aStart >= a.length) {
      const allPlain = added.every(block => block.kind === 'plain' && !INLINE_MARKER_RE.test(block.text) && !/^\s{0,3}#{1,6}\s/.test(block.lines[0] ?? ''));
      const lastAnchorable = a.length > 0 && a[a.length - 1].kind !== 'table' && !claimed.has(a.length - 1);
      if (allPlain || !lastAnchorable) {
        edits.push({
          operation: 'appendParagraphs',
          paragraphs: added.map(block => markdownLineToDocxText(block.lines.map(l => l.trim()).join(' '))).filter(Boolean),
        });
      } else {
        const anchorBlock = a[a.length - 1];
        claimed.add(a.length - 1);
        edits.push({
          operation: 'replaceParagraphRange',
          paragraphs: blockToAnchorParagraphs(anchorBlock) ?? [],
          replaceWith: `${anchorBlock.text}\n\n${added.map(x => x.text).join('\n\n')}`,
        });
      }
      continue;
    }

    // Mid-document pure insertion → anchor on a neighbor, re-included.
    if (removed.length === 0) {
      const leftIdx = run.aStart - 1;
      const rightIdx = run.aStart; // first common block after the insertion point
      const usable = (idx: number) => idx >= 0 && idx < a.length && a[idx].kind !== 'table' && !claimed.has(idx);
      const side = usable(leftIdx) ? 'left' : usable(rightIdx) ? 'right' : null;
      if (!side) {
        unsupported.push({ reason: "couldn't anchor this insertion (next to a table) — not staged", text: added.map(x => x.text).join('\n\n').slice(0, 400) });
        continue;
      }
      const idx = side === 'left' ? leftIdx : rightIdx;
      claimed.add(idx);
      const anchorBlock = a[idx];
      const addedMd = added.map(x => x.text).join('\n\n');
      edits.push({
        operation: 'replaceParagraphRange',
        paragraphs: blockToAnchorParagraphs(anchorBlock) ?? [],
        replaceWith: side === 'left' ? `${anchorBlock.text}\n\n${addedMd}` : `${addedMd}\n\n${anchorBlock.text}`,
      });
      continue;
    }

    // Fine-grained sentence tweak → replaceText.
    if (
      removed.length === 1 && added.length === 1
      && removed[0].kind === 'plain' && added[0].kind === 'plain'
      && removed[0].lines.length === 1 && added[0].lines.length === 1
      && !INLINE_MARKER_RE.test(added[0].text)
      && !/^\s{0,3}#{1,6}\s/.test(removed[0].lines[0]) && !/^\s{0,3}#{1,6}\s/.test(added[0].lines[0])
    ) {
      const findText = markdownLineToDocxText(removed[0].lines[0]);
      const replaceWith = markdownLineToDocxText(added[0].lines[0]);
      if (findText.length >= 20 && replaceWith) {
        edits.push({ operation: 'replaceText', findText, replaceWith });
        continue;
      }
    }

    // General range replace / delete.
    const anchorLists = removed.map(blockToAnchorParagraphs);
    if (anchorLists.some(list => list === null)) {
      unsupported.push({ reason: "this change couldn't be anchored — not staged", text: removed.map(x => x.text).join('\n\n').slice(0, 400) });
      continue;
    }
    let anchors = anchorLists.flatMap(list => list ?? []);
    let replacement = added.map(x => x.text).join('\n\n');
    let aStart = run.aStart;

    // Short-anchor auto-extension (best effort).
    if (anchors.join(' ').length < 12) {
      const leftIdx = aStart - 1;
      const rightIdx = run.aEnd;
      const usable = (idx: number) => idx >= 0 && idx < a.length && a[idx].kind !== 'table' && !claimed.has(idx);
      if (usable(leftIdx)) {
        claimed.add(leftIdx);
        anchors = [...(blockToAnchorParagraphs(a[leftIdx]) ?? []), ...anchors];
        replacement = replacement ? `${a[leftIdx].text}\n\n${replacement}` : a[leftIdx].text;
        aStart = leftIdx;
      } else if (usable(rightIdx)) {
        claimed.add(rightIdx);
        anchors = [...anchors, ...(blockToAnchorParagraphs(a[rightIdx]) ?? [])];
        replacement = replacement ? `${replacement}\n\n${a[rightIdx].text}` : a[rightIdx].text;
      }
    }

    edits.push({ operation: 'replaceParagraphRange', paragraphs: anchors, replaceWith: replacement });
  }

  return { edits, unsupported };
}
